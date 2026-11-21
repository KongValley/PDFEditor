/**
 * ODF → HTML(交给隐藏窗口的 Chromium 排版并打印成 PDF)。
 *
 * 为什么不自己用 pdf-lib 排:ODF 是「可重排」文档,段落折行、表格分页、列表缩进、
 * 粗斜体/上下标这些正是浏览器最擅长的;Chromium 打印还会把字体子集嵌进 PDF,
 * 中文不依赖目标机器装了什么字体。这里只负责把 ODF 的语义翻译成语义化 HTML。
 *
 * 支持范围:
 *  - 文字(.odt):段落/标题/字符样式/对齐与缩进/列表/表格/图片/分页;
 *  - 表格(.ods):工作表、合并单元格、列宽行高、边框底色、跨页表头;
 *  - 演示(.odp):幻灯片、绝对定位文本框/图片/基本形状、页面背景。
 * 不支持的项(页眉页脚、脚注定位、嵌入对象、复杂几何/渐变)在 warnings 里明说。
 */
import { child, children, elementChildren, localNameOf, numList, textOf } from '../ofd/model'
import { odfAttr } from './xml'
import { odfBodyRoot, packageFile, type OdfPackage } from './package'
import {
  OdfStyles,
  cellStyleCss,
  cssFontFamily,
  graphicStyleCss,
  paraStyleCss,
  parseColor,
  parseLengthPt,
  parseOpacity,
  resolveTextStyle,
  textStyleCss,
  type CellStyleProps,
  type GraphicStyleProps,
  type ListLevelStyle,
  type ListStyleDef,
  type PageLayout,
  type ParaStyleProps,
  type ResolvedTextStyle
} from './style'

export interface OdfHtmlOptions {
  /** 标题(写进 <title>,只影响打印任务名) */
  title?: string
  /** 工作表最多渲染多少行(防御畸形/超大文件) */
  maxSheetRows?: number
  /** 工作表最多渲染多少列 */
  maxSheetCols?: number
}

export interface OdfHtmlResult {
  html: string
  pageWidthMm: number
  pageHeightMm: number
  /** 表格页横向缩放(用 CSS zoom 实现;文字页恒为 1) */
  zoom: number
  warnings: string[]
}

interface RenderContext {
  pkg: OdfPackage
  styles: OdfStyles
  warnings: string[]
  defaultText: ResolvedTextStyle
  contentWidthPt: number
  contentHeightPt: number
  imageCache: Map<string, string | null>
  imageBytes: number
  footnotes: Array<{ label: string; html: string }>
  /** text:numbered-paragraph 的编号状态:list-id → 各层级计数器 */
  numberedParagraphs: Map<string, number[]>
  maxSheetRows: number
  maxSheetCols: number
  truncatedRows: boolean
  truncatedCols: boolean
  warnedObject: boolean
  warnedGeometry: boolean
  warnedFill: boolean
  warnedHeader: boolean
}

const MM_TO_PT = 72 / 25.4
const DEFAULT_FONT = cssFontFamily(['Times New Roman', 'SimSun'], 'serif') as string
/** 图片总字节上限:base64 会让 HTML 膨胀 1/3,不可信 ODF 不能无上限地往内存里塞 */
const MAX_IMAGE_BYTES = 96 * 1024 * 1024
/** 内嵌字体总字节上限(字体本身不压缩,base64 后约 1.33 倍) */
const MAX_FONT_BYTES = 48 * 1024 * 1024
const DEFAULT_COLUMN_WIDTH_PT = 64

function escapeHtml(text: string): string {
  // 控制字符会让 HTML 解析器丢内容/截断文档,先清掉(保留 \t\n\r)
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function mm(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

function inlineCss(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => !!part).join(';')
}

/** 文本节点:折叠 XML 美化产生的换行/缩进;ODF 的连续空格由 text:s 表达 */
function normalizedText(data: string): string {
  return data.replace(/\s+/g, ' ')
}

/**
 * 下划线/删除线只包在叶子文本 run 上:text-decoration 会向子元素传播,
 * 若放在 p/span 容器上,子级字符样式显式 none 无法撤销父级下划线。
 */
function decoratedHtml(html: string, style: ResolvedTextStyle): string {
  if (!html) return ''
  const decorations: string[] = []
  if (style.underline) decorations.push('underline')
  if (style.strike) decorations.push('line-through')
  if (decorations.length === 0) return html
  return `<span style="text-decoration:${decorations.join(' ')}">${html}</span>`
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function buildOdfHtml(pkg: OdfPackage, options: OdfHtmlOptions = {}): OdfHtmlResult {
  const warnings: string[] = []
  const styles = new OdfStyles([pkg.styles, pkg.content])
  const defaultTextStyle: ResolvedTextStyle = {
    familyCss: DEFAULT_FONT,
    sizePt: 12,
    color: '#000000'
  }
  const defaultProps = styles.defaultText()
  const defaultText = resolveTextStyle(defaultProps.props, defaultTextStyle, styles)

  const bodyRoot = odfBodyRoot(pkg)
  if (!bodyRoot) throw new Error('ODF 文档缺少 office:body 内容')

  const master = styles.firstMasterPage()
  const layout = styles.pageLayout(master?.pageLayout ?? null) ?? defaultPageLayout()
  const contentWidthPt = Math.max(72, (layout.widthMm - layout.marginLeftMm - layout.marginRightMm) * MM_TO_PT)
  const contentHeightPt = Math.max(72, (layout.heightMm - layout.marginTopMm - layout.marginBottomMm) * MM_TO_PT)

  const ctx: RenderContext = {
    pkg,
    styles,
    warnings,
    defaultText,
    contentWidthPt,
    contentHeightPt,
    imageCache: new Map(),
    imageBytes: 0,
    footnotes: [],
    numberedParagraphs: new Map(),
    maxSheetRows: Math.max(100, options.maxSheetRows ?? 20000),
    maxSheetCols: Math.max(8, options.maxSheetCols ?? 512),
    truncatedRows: false,
    truncatedCols: false,
    warnedObject: false,
    warnedGeometry: false,
    warnedFill: false,
    warnedHeader: false
  }

  let body = ''
  let slideLayout: PageLayout | null = null
  let zoom = 1
  if (pkg.kind === 'text') {
    body = renderOdt(rootChild(bodyRoot, 'text') ?? bodyRoot, ctx, 0)
  } else if (pkg.kind === 'spreadsheet') {
    warnHeaderFooter(ctx)
    const result = renderSheets(rootChild(bodyRoot, 'spreadsheet') ?? bodyRoot, ctx)
    body = result.html
    zoom = result.zoom
  } else {
    const presentation = rootChild(bodyRoot, 'presentation') ?? bodyRoot
    // ODF 演示的默认页面是 28×21cm 横向;文档没有母版页时不能用 A4 兜底
    slideLayout =
      findSlideLayout(presentation, ctx) ?? {
        widthMm: 280,
        heightMm: 210,
        marginTopMm: 0,
        marginBottomMm: 0,
        marginLeftMm: 0,
        marginRightMm: 0
      }
    body = renderSlides(presentation, ctx, slideLayout)
  }

  if (body.trim() === '') body = '<p>&nbsp;</p>'

  if (ctx.footnotes.length > 0) {
    body +=
      '<div class="footnotes">' +
      ctx.footnotes
        .map((note) => `<div class="footnote"><span class="fn-label">${escapeHtml(note.label)}</span>${note.html}</div>`)
        .join('') +
      '</div>'
    ctx.warnings.push('脚注已统一排在文末(浏览器打印无法逐页放置页脚)')
  }
  if (ctx.truncatedRows) ctx.warnings.push(`工作表行数超过上限,已截断到 ${ctx.maxSheetRows} 行`)
  if (ctx.truncatedCols) ctx.warnings.push(`工作表列数超过上限,已截断到 ${ctx.maxSheetCols} 列`)

  const pageWidthMm = slideLayout?.widthMm ?? layout.widthMm
  const pageHeightMm = slideLayout?.heightMm ?? layout.heightMm
  const pageMargin = pkg.kind === 'presentation' ? { top: 0, right: 0, bottom: 0, left: 0 } : {
    top: layout.marginTopMm,
    right: layout.marginRightMm,
    bottom: layout.marginBottomMm,
    left: layout.marginLeftMm
  }
  const title = escapeHtml(options.title ?? '')
  const fontCss = embeddedFontCss(ctx)
  const html = [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    // 隐藏窗口只渲染本地内容:禁止一切外部资源(图片/字体全部是 data:)—— 防不可信 ODF 联网/读文件
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; font-src data:; style-src \'unsafe-inline\'">',
    `<title>${title}</title>`,
    '<style>',
    fontCss,
    baseCss(pageWidthMm, pageHeightMm, pageMargin, defaultText, pkg.kind),
    '</style></head><body class="odf-', pkg.kind, '">',
    body,
    '</body></html>'
  ].join('')

  return {
    html,
    pageWidthMm,
    pageHeightMm,
    zoom,
    warnings: [...new Set(ctx.warnings)]
  }
}

function defaultPageLayout(): PageLayout {
  return {
    widthMm: 210,
    heightMm: 297,
    marginTopMm: 20,
    marginBottomMm: 20,
    marginLeftMm: 20,
    marginRightMm: 20
  }
}

function rootChild(root: Element, name: string): Element | null {
  return children(root, name)[0] ?? (localNameOf(root) === name ? root : null)
}

/**
 * 基础 CSS。页面尺寸/页边距由 @page 决定(printToPDF 的 preferCSSPageSize 会采用),
 * 表格页的缩放用 zoom 作用在 .sheets 上,保证「先缩放、再分页」。
 */
function baseCss(
  widthMm: number,
  heightMm: number,
  margin: { top: number; right: number; bottom: number; left: number },
  defaultText: ResolvedTextStyle,
  kind: OdfPackage['kind']
): string {
  const fontFamily = defaultText.familyCss ?? DEFAULT_FONT
  return [
    `@page { size: ${mm(widthMm)}mm ${mm(heightMm)}mm; margin: ${mm(margin.top)}mm ${mm(margin.right)}mm ${mm(margin.bottom)}mm ${mm(margin.left)}mm; }`,
    'html, body { margin: 0; padding: 0; }',
    `body { font-family: ${fontFamily}; font-size: ${round(defaultText.sizePt)}pt; color: ${defaultText.color ?? '#000000'}; line-height: 1.25; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`,
    'p { margin: 0; }',
    'h1, h2, h3, h4, h5, h6 { margin: 0; font-weight: bold; break-after: avoid; }',
    'a { color: inherit; }',
    'img { max-width: 100%; }',
    'ruby rt { font-size: 50%; }',
    '.tab { display: inline-block; width: 0.5in; }',
    '.break { break-before: page; }',
    '.li { display: flex; align-items: flex-start; }',
    '.li-marker { flex: 0 0 auto; text-align: right; padding-right: 6pt; white-space: nowrap; }',
    '.li-body { flex: 1 1 auto; min-width: 0; }',
    '.img-block { margin: 4pt 0; }',
    '.table-block { margin: 4pt 0; }',
    '.textbox { box-sizing: border-box; }',
    '.inline-textbox { display: inline-block; vertical-align: middle; box-sizing: border-box; }',
    '.inline-textbox p { margin: 0; }',
    '.odt-table { border-collapse: collapse; table-layout: fixed; }',
    '.odt-table tr { break-inside: avoid; }',
    '.odt-table td { vertical-align: top; padding: 1.5pt; }',
    '.footnotes { margin-top: 14pt; border-top: 0.5pt solid #888; padding-top: 6pt; font-size: 9pt; }',
    '.footnote { margin: 2pt 0; }',
    '.fn-label { margin-right: 4pt; }',
    kind === 'spreadsheet'
      ? '.sheets { transform-origin: 0 0; } .sheet + .sheet { break-before: page; } .sheet table { border-collapse: collapse; table-layout: fixed; } .sheet td { overflow: hidden; } .sheet tr { break-inside: avoid; } .sheet td p { margin: 0; }'
      : '',
    kind === 'presentation'
      ? '.slide { position: relative; overflow: hidden; break-inside: avoid; } .slide + .slide { break-before: page; } .shape { position: absolute; box-sizing: border-box; } .shape img { width: 100%; height: 100%; object-fit: contain; } .shape-text { display: flex; flex-direction: column; }'
      : ''
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------------------------------------------------------------------------
// 文字文档(.odt)
// ---------------------------------------------------------------------------

function renderOdt(root: Element, ctx: RenderContext, depth: number): string {
  if (depth === 0) warnHeaderFooter(ctx)
  return renderOdtBlocks(root, ctx, 0)
}

function warnHeaderFooter(ctx: RenderContext): void {
  if (ctx.warnedHeader) return
  const master = ctx.styles.firstMasterPage()
  if (!master?.el) return
  if (child(master.el, 'header') || child(master.el, 'footer')) {
    ctx.warnedHeader = true
    ctx.warnings.push('页眉/页脚未导出(浏览器打印不支持页边距区内容)')
  }
}

interface ListState {
  styleName: string | null
  def: ListStyleDef | null
  counters: number[]
  /** 当前层级的左缩进(pt);嵌套列表在此基础上 +18pt */
  indentPt: number
  depth: number
}

function renderOdtBlocks(
  container: Element,
  ctx: RenderContext,
  depth: number,
  list?: ListState,
  base?: ResolvedTextStyle,
  para?: ParaStyleProps
): string {
  if (depth > 100) {
    ctx.warnings.push('文档嵌套层级过深,已跳过部分内容')
    return ''
  }
  const out: string[] = []
  for (const el of elementChildren(container)) {
    switch (localNameOf(el)) {
      case 'p':
        out.push(renderParagraph(el, ctx, 'p', base, para))
        break
      case 'h':
        out.push(renderParagraph(el, ctx, 'h', base, para))
        break
      case 'list':
        out.push(
          list
            ? renderList(
                el,
                ctx,
                list.depth + 1,
                list.indentPt,
                { name: list.styleName, def: list.def },
                list.counters,
                base,
                para
              )
            : renderList(el, ctx, 1, 0, null, [], base, para)
        )
        break
      case 'numbered-paragraph':
        out.push(renderNumberedParagraph(el, ctx, base, para))
        break
      case 'table':
        // 表格单元格有各自的样式,不能把外层单元格/文本框的段落属性带进单元格
        out.push(renderOdtTable(el, ctx, depth, base))
        break
      case 'section':
        if (odfAttr(el, 'display') !== 'none') out.push(renderOdtBlocks(el, ctx, depth, list, base, para))
        break
      case 'soft-page-break':
        out.push('<div class="break"></div>')
        break
      case 'frame':
        out.push(renderFrameBlock(el, ctx, depth))
        break
      case 'a':
        // draw:a 包住图片/文本框(块级超链接)
        out.push(renderOdtBlocks(el, ctx, depth, list, base, para))
        break
      case 'index-body':
        out.push(renderOdtBlocks(el, ctx, depth, list, base, para))
        break
      case 'table-of-content':
      case 'illustration-index':
      case 'table-index':
      case 'object-index':
      case 'user-index':
      case 'alphabetical-index': {
        const body = child(el, 'index-body')
        if (body) out.push(renderOdtBlocks(body, ctx, depth, list, base, para))
        break
      }
      case 'tracked-changes':
      case 'variable-decls':
      case 'sequence-decls':
      case 'user-field-decls':
      case 'annotation':
      case 'hidden-paragraph':
      case 'index-title':
        break
      default:
        // 未知块级元素:有块级子节点就继续,避免整段内容消失
        if (children(el, 'p').length > 0 || children(el, 'table').length > 0) {
          out.push(renderOdtBlocks(el, ctx, depth, list, base, para))
        }
        break
    }
  }
  return out.join('')
}

function headingDefaults(level: number): { text: { fontSize: string; bold: boolean }; para: ParaStyleProps } {
  const size = Math.max(10, 20 - level * 2)
  const top = Math.max(3, 12 - level)
  return {
    text: { fontSize: `${size}pt`, bold: true },
    para: { marginTop: top, marginBottom: Math.max(2, 6 - level) }
  }
}

function splitSoftPageBreaks(el: Element): Node[][] {
  const segments: Node[][] = [[]]
  for (let node = el.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && localNameOf(node as unknown as Element) === 'soft-page-break') {
      segments.push([])
      continue
    }
    segments[segments.length - 1].push(node)
  }
  return segments
}

function renderParagraph(
  el: Element,
  ctx: RenderContext,
  tag: 'p' | 'h',
  baseOverride?: ResolvedTextStyle,
  paraOverride?: ParaStyleProps
): string {
  const level = tag === 'h' ? clampInt(odfAttr(el, 'outline-level'), 1, 1, 6) : 0
  const style = ctx.styles.resolve(odfAttr(el, 'style-name'), 'paragraph')
  const defaults = tag === 'h' ? headingDefaults(level) : null
  // 外层单元格/文本框的段落属性作为基底:段落自己有同名属性时以段落样式为准,
  // 没有才继承;普通段落无外层覆盖时退回文档默认段落样式
  const basePara =
    paraOverride ??
    (tag === 'p' && !style ? ctx.styles.defaultStyle('paragraph')?.props.para : null)
  const textProps = { ...(defaults?.text ?? {}), ...(style?.props.text ?? {}) }
  const paraProps = { ...(defaults?.para ?? {}), ...(basePara ?? {}), ...(style?.props.para ?? {}) }
  const base = resolveTextStyle(textProps, baseOverride ?? ctx.defaultText, ctx.styles)
  const htmlTag = tag === 'h' ? `h${level}` : 'p'
  const renderSegment = (nodes: Node[], extraBreak: boolean, isLast: boolean): string => {
    const inline = renderInlineNodes(nodes, base, ctx)
    const segmentPara: ParaStyleProps = {
      ...paraProps,
      ...(extraBreak ? { breakBefore: true } : {}),
      // 段后分页只属于整段最后一个分片,否则每片都会另起一页
      ...(isLast ? {} : { breakAfter: false })
    }
    const css = inlineCss([paraStyleCss(segmentPara), textStyleCss(base, false)])
    const cls = segmentPara.breakBefore ? ' class="break"' : ''
    const content = inline.trim() ? inline : decoratedHtml('&nbsp;', base)
    return `<${htmlTag}${cls} style="${css}">${content}</${htmlTag}>`
  }
  const segments = splitSoftPageBreaks(el)
  if (segments.length <= 1) return renderSegment(segments[0] ?? [], false, true)
  const html: string[] = []
  segments.forEach((nodes, index) => {
    // 段落以软分页开头时省略第一个空段,避免分页前多一个空段落
    if (index === 0 && nodes.length === 0) return
    html.push(renderSegment(nodes, index > 0, index === segments.length - 1))
  })
  return html.join('')
}

// ---------------------------------------------------------------------------
// 行内内容
// ---------------------------------------------------------------------------

function renderInlineNode(node: Node, base: ResolvedTextStyle, ctx: RenderContext, depth: number): string {
  if (node.nodeType === 3) {
    return decoratedHtml(escapeHtml(normalizedText(node.nodeValue ?? '')), base)
  }
  if (node.nodeType !== 1) return ''
  return renderInlineElement(node as unknown as Element, base, ctx, depth)
}

function renderInlineChildren(
  el: Element,
  base: ResolvedTextStyle,
  ctx: RenderContext,
  depth = 0
): string {
  if (depth > 100) return ''
  const out: string[] = []
  for (let node = el.firstChild; node; node = node.nextSibling) {
    out.push(renderInlineNode(node, base, ctx, depth))
  }
  return out.join('')
}

function renderInlineNodes(
  nodes: Node[],
  base: ResolvedTextStyle,
  ctx: RenderContext,
  depth = 0
): string {
  if (depth > 100) return ''
  return nodes.map((node) => renderInlineNode(node, base, ctx, depth)).join('')
}

function renderInlineElement(
  el: Element,
  base: ResolvedTextStyle,
  ctx: RenderContext,
  depth = 0
): string {
  if (depth > 100) return ''
  switch (localNameOf(el)) {
    case 'span': {
      const style = ctx.styles.resolve(odfAttr(el, 'style-name'), 'text')
      const merged = resolveTextStyle(style?.props.text, base, ctx.styles)
      return `<span style="${textStyleCss(merged, false)}">${renderInlineChildren(el, merged, ctx, depth + 1)}</span>`
    }
    case 's': {
      const count = clampInt(odfAttr(el, 'c'), 1, 1, 200)
      return decoratedHtml('&nbsp;'.repeat(count), base)
    }
    case 'tab':
      return decoratedHtml('<span class="tab"></span>', base)
    case 'line-break':
      return '<br>'
    case 'a': {
      const href = odfAttr(el, 'href') ?? odfAttr(el, 'xlink:href')
      const style = ctx.styles.resolve(odfAttr(el, 'style-name'), 'text')
      const merged = resolveTextStyle(style?.props.text, base, ctx.styles)
      // 链接默认带下划线(等价旧 CSS),但叶子 run 仍可被字符样式显式 none 覆盖
      const linkStyle = merged.underline === undefined ? { ...merged, underline: true } : merged
      const inner = renderInlineChildren(el, linkStyle, ctx, depth + 1)
      if (href && /^(https?:|mailto:)/i.test(href)) {
        return `<a href="${escapeHtml(href)}" style="${textStyleCss(linkStyle, false)}">${inner}</a>`
      }
      return inner
    }
    case 'note':
      return renderNote(el, base, ctx)
    case 'ruby': {
      const rubyBase = child(el, 'ruby-base')
      const rubyText = child(el, 'ruby-text')
      const baseHtml = rubyBase ? renderInlineChildren(rubyBase, base, ctx, depth + 1) : ''
      const textHtml = rubyText ? renderInlineChildren(rubyText, base, ctx, depth + 1) : ''
      return `<ruby>${baseHtml}<rt>${textHtml}</rt></ruby>`
    }
    case 'frame':
      return renderFrameInline(el, ctx, depth)
    case 'bookmark':
    case 'bookmark-start':
    case 'bookmark-end':
    case 'reference-mark':
    case 'reference-mark-start':
    case 'reference-mark-end':
    case 'meta':
    case 'meta-field':
    case 'measure':
    case 'change':
    case 'change-start':
    case 'change-end':
      return renderInlineChildren(el, base, ctx, depth + 1)
    case 'field':
    case 'input':
    case 'placeholder':
    case 'sheet-name':
      return decoratedHtml(escapeHtml(textOf(el)), base)
    case 'annotation':
    case 'hidden-text':
      return ''
    case 'soft-page-break':
      return ''
    default:
      return renderInlineChildren(el, base, ctx, depth + 1)
  }
}

function renderNote(el: Element, base: ResolvedTextStyle, ctx: RenderContext): string {
  const citationEl = child(el, 'note-citation')
  const bodyEl = child(el, 'note-body')
  if (!bodyEl) return ''
  const index = ctx.footnotes.length + 1
  const label = citationEl ? textOf(citationEl) : String(index)
  const footnoteBase = resolveTextStyle({ fontSize: '9pt' }, base, ctx.styles)
  const html = renderOdtBlocks(bodyEl, ctx, 1, undefined, footnoteBase)
  ctx.footnotes.push({ label, html })
  return `<sup class="fn">[${escapeHtml(label)}]</sup>`
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

function renderList(
  el: Element,
  ctx: RenderContext,
  depth: number,
  baseIndentPt: number,
  inherited: { name: string | null; def: ListStyleDef | null } | null,
  counters: number[] = [],
  base?: ResolvedTextStyle,
  para?: ParaStyleProps
): string {
  const styleName = odfAttr(el, 'style-name') ?? inherited?.name ?? null
  const def = ctx.styles.listStyle(styleName) ?? inherited?.def ?? null
  const levelStyle = def?.levels.get(depth) ?? def?.levels.get(1) ?? null
  // 顶层列表默认缩进 18pt;嵌套列表由调用方把父级缩进 +18pt 传进来
  const indent = baseIndentPt + 18
  const out: string[] = []
  const header = child(el, 'list-header')
  if (header) {
    const body = renderOdtBlocks(
      header,
      ctx,
      depth,
      { styleName, def, counters, indentPt: indent, depth },
      base,
      para
    )
    if (body.trim() !== '') {
      out.push(
        `<div class="li" style="margin-left:${round(indent)}pt">` +
          '<span class="li-marker" style="min-width:12pt"></span>' +
          `<div class="li-body">${body}</div></div>`
      )
    }
  }
  let itemIndex = 0
  for (const item of children(el, 'list-item')) {
    itemIndex++
    const start = odfAttr(item, 'start-value')
    if (start !== null) counters[depth] = Math.max(1, Number(start) || 1)
    else counters[depth] = (counters[depth] ?? (levelStyle?.start ?? 1) - 1) + 1
    // 进入更深层时重置子级计数,避免上一项残留
    for (let level = depth + 1; level < counters.length; level++) counters[level] = 0
    const marker = levelMarker(levelStyle, counters[depth], itemIndex)
    const markerWidth = Math.max(12, marker.length * 8)
    const body = renderOdtBlocks(item, ctx, depth, {
      styleName,
      def,
      counters,
      indentPt: indent,
      depth
    }, base, para)
    out.push(
      `<div class="li" style="margin-left:${round(indent)}pt">` +
        `<span class="li-marker" style="min-width:${round(markerWidth)}pt">${escapeHtml(marker)}</span>` +
        `<div class="li-body">${body}</div></div>`
    )
  }
  return out.join('')
}

function renderNumberedParagraph(
  el: Element,
  ctx: RenderContext,
  base?: ResolvedTextStyle,
  para?: ParaStyleProps
): string {
  const body = child(el, 'p') ?? child(el, 'h')
  if (!body) return ''
  const listId = odfAttr(el, 'list-id') ?? '__numbered_default'
  const level = clampInt(odfAttr(el, 'level'), 1, 1, 10)
  const def = ctx.styles.listStyle(odfAttr(el, 'style-name'))
  const levelStyle = def?.levels.get(level) ?? def?.levels.get(1) ?? null
  const counters = ctx.numberedParagraphs.get(listId) ?? []
  const rawStart = odfAttr(el, 'start-value')
  const start = rawStart === null ? null : Number(rawStart)
  if (start !== null && Number.isFinite(start)) {
    counters[level] = Math.max(0, Math.trunc(start))
  } else if (counters[level] === undefined) {
    counters[level] = levelStyle?.start ?? 1
  } else if (odfAttr(el, 'continue-numbering') === 'false') {
    counters[level] = levelStyle?.start ?? 1
  } else {
    counters[level] = (counters[level] ?? 0) + 1
  }
  for (let deeper = level + 1; deeper < counters.length; deeper++) counters[deeper] = 0
  ctx.numberedParagraphs.set(listId, counters)

  const numberEl = child(el, 'number')
  let marker = numberEl ? textOf(numberEl) : ''
  if (marker === '') {
    marker = levelStyle ? levelMarker(levelStyle, counters[level], counters[level]) : `${counters[level]}.`
    if (marker === '' && levelStyle?.kind !== 'none') marker = `${counters[level]}.`
  }
  const indent = level * 18
  const markerWidth = Math.max(12, marker.length * 8)
  const tag: 'p' | 'h' = localNameOf(body) === 'h' ? 'h' : 'p'
  const html = renderParagraph(body, ctx, tag, base, para)
  return (
    `<div class="li" style="margin-left:${round(indent)}pt">` +
    `<span class="li-marker" style="min-width:${round(markerWidth)}pt">${escapeHtml(marker)}</span>` +
    `<div class="li-body">${html}</div></div>`
  )
}

function levelMarker(level: ListLevelStyle | null, counter: number, itemIndex: number): string {
  // text:list/@text:style-name 可省略:没有样式时按默认项目符号渲染,而不是空标记
  if (!level) return '•'
  if (level.kind === 'none') return ''
  if (level.kind === 'bullet') return level.bulletChar ?? '•'
  const value = formatListNumber(counter || itemIndex, level.numFormat ?? '1')
  return `${level.numPrefix ?? ''}${value}${level.numSuffix ?? ''}`
}

function formatListNumber(value: number, format: string): string {
  const n = Math.max(0, Math.trunc(value))
  switch (format) {
    case '01':
      return String(n).padStart(2, '0')
    case 'a':
      return String.fromCharCode(97 + ((n - 1) % 26))
    case 'A':
      return String.fromCharCode(65 + ((n - 1) % 26))
    case 'i':
      return roman(n).toLowerCase()
    case 'I':
      return roman(n)
    default:
      return String(n)
  }
}

function roman(value: number): string {
  const table: Array<[number, string]> = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I']
  ]
  let n = Math.max(0, Math.trunc(value))
  let out = ''
  for (const [unit, glyph] of table) {
    while (n >= unit) {
      out += glyph
      n -= unit
    }
  }
  return out || '0'
}

// ---------------------------------------------------------------------------
// 图片 / 文本框
// ---------------------------------------------------------------------------

const MIME_BY_MAGIC: Array<{ mime: string; test: (bytes: Uint8Array) => boolean }> = [
  { mime: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { mime: 'image/bmp', test: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
  {
    mime: 'image/webp',
    test: (b) =>
      b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45
  },
  { mime: 'image/tiff', test: (b) => b.length > 4 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) }
]

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml'
}

const FONT_FORMAT_BY_EXT: Record<string, { mime: string; format: string }> = {
  ttf: { mime: 'font/ttf', format: 'truetype' },
  otf: { mime: 'font/otf', format: 'opentype' },
  woff: { mime: 'font/woff', format: 'woff' },
  woff2: { mime: 'font/woff2', format: 'woff2' }
}

function firstFamily(value: string | undefined): string {
  if (!value) return ''
  return (
    value
      .split(',')[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
      .replace(/["'\\;{}\r\n\u0000-\u001f]/g, '')
      .trim() ?? ''
  )
}

function fontExt(bytes: Uint8Array, href: string): string | null {
  const byPath = /\.([a-z0-9]+)$/i.exec(href)?.[1]?.toLowerCase()
  if (byPath && FONT_FORMAT_BY_EXT[byPath]) return byPath
  if (bytes.length < 4) return null
  if (bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f) return 'otf'
  if (bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x46) return 'woff'
  if (bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32) return 'woff2'
  if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return 'ttf'
  if (bytes[0] === 0x74 && bytes[1] === 0x72 && bytes[2] === 0x75 && bytes[3] === 0x65) return 'ttf'
  return null
}

/**
 * ODF 可以内嵌字体(公文常用方正小标宋之类):转成 @font-face + data URL,
 * 这样 Chromium 排版时用的是文档自带字形,不依赖目标机器是否装了该字体。
 */
function embeddedFontCss(ctx: RenderContext): string {
  const rules: string[] = []
  const families = new Set<string>()
  let total = 0
  for (const face of ctx.styles.allFontFaces()) {
    if (!face.file) continue
    const family = firstFamily(face.family ?? face.name)
    if (!family || families.has(family)) continue
    const bytes = packageFile(ctx.pkg, face.file)
    if (!bytes || bytes.length === 0) {
      ctx.warnings.push(`内嵌字体文件缺失:${face.file}`)
      continue
    }
    if (bytes.length >= 4 && bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66) {
      ctx.warnings.push(`内嵌集合字体(.ttc)暂不支持,已回退系统字体:${family}`)
      continue
    }
    const ext = fontExt(bytes, face.file)
    const format = ext ? FONT_FORMAT_BY_EXT[ext] : null
    if (!format) {
      ctx.warnings.push(`不支持的内嵌字体格式:${face.file}`)
      continue
    }
    if (total + bytes.length > MAX_FONT_BYTES) {
      ctx.warnings.push('内嵌字体总大小超过上限,后续字体未嵌入')
      break
    }
    total += bytes.length
    families.add(family)
    rules.push(
      `@font-face{font-family:'${family}';src:url("data:${format.mime};base64,${Buffer.from(bytes).toString('base64')}") format('${format.format}');font-weight:normal;font-style:normal;}`
    )
  }
  return rules.join('\n')
}

function mimeOf(bytes: Uint8Array, href: string): string | null {
  for (const item of MIME_BY_MAGIC) {
    if (item.test(bytes)) return item.mime
  }
  // SVG 是文本;允许 XML 声明/注释/空白开头
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 512)).trimStart()
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml'
  const ext = /\.([a-z0-9]+)$/i.exec(href)?.[1]?.toLowerCase()
  return ext ? MIME_BY_EXT[ext] ?? null : null
}

function imageUrl(bytes: Uint8Array | null, href: string, ctx: RenderContext, cacheKey: string): string | null {
  const cached = ctx.imageCache.get(cacheKey)
  if (cached !== undefined) return cached
  if (!bytes || bytes.length === 0) {
    ctx.warnings.push(`图片缺失:${href || '(内嵌数据为空)'}`)
    ctx.imageCache.set(cacheKey, null)
    return null
  }
  if (ctx.imageBytes + bytes.length > MAX_IMAGE_BYTES) {
    ctx.warnings.push('图片总大小超过上限,后续图片未导出')
    ctx.imageCache.set(cacheKey, null)
    return null
  }
  const mime = mimeOf(bytes, href)
  if (!mime) {
    ctx.warnings.push(`不支持的图片格式:${href}`)
    ctx.imageCache.set(cacheKey, null)
    return null
  }
  if (mime === 'image/tiff') {
    // Chromium 不把 TIFF 作为 <img> 解码,直接跳过并说明,避免变成空白
    ctx.warnings.push(`TIFF 图片暂不支持,已跳过:${href}`)
    ctx.imageCache.set(cacheKey, null)
    return null
  }
  ctx.imageBytes += bytes.length
  const url = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
  ctx.imageCache.set(cacheKey, url)
  return url
}

function imageDataUrl(el: Element, ctx: RenderContext): string | null {
  const href = odfAttr(el, 'href') ?? odfAttr(el, 'xlink:href') ?? ''
  const cacheKey = href || `#inline-${ctx.imageCache.size}`
  const cached = ctx.imageCache.get(cacheKey)
  if (cached !== undefined) return cached

  let bytes: Uint8Array | null = null
  const binary = child(el, 'binary-data')
  if (binary) {
    const encoded = (binary.textContent ?? '').replace(/\s+/g, '')
    if (encoded) {
      try {
        bytes = new Uint8Array(Buffer.from(encoded, 'base64'))
      } catch {
        bytes = null
      }
    }
  } else if (href) {
    bytes = packageFile(ctx.pkg, href)
  }
  return imageUrl(bytes, href, ctx, cacheKey)
}

/** 背景图等只有 href、没有 draw:image 元素的场景 */
function imageUrlByHref(href: string, ctx: RenderContext): string | null {
  return imageUrl(packageFile(ctx.pkg, href), href, ctx, href)
}

function frameSize(el: Element, ctx: RenderContext): { width: number; height: number } {
  let width = parseLengthPt(odfAttr(el, 'width'), ctx.contentWidthPt) ?? 0
  let height = parseLengthPt(odfAttr(el, 'height'), ctx.contentHeightPt) ?? 0
  if (width <= 0) width = parseLengthPt(odfAttr(el, 'rel-width'), ctx.contentWidthPt) ?? 0
  if (height <= 0) height = parseLengthPt(odfAttr(el, 'rel-height'), ctx.contentHeightPt) ?? 0
  if (width <= 0) width = Math.min(ctx.contentWidthPt, 120)
  if (height <= 0) height = width * 0.75
  if (width > ctx.contentWidthPt) {
    height = (height * ctx.contentWidthPt) / width
    width = ctx.contentWidthPt
  }
  if (height > ctx.contentHeightPt) {
    width = (width * ctx.contentHeightPt) / height
    height = ctx.contentHeightPt
  }
  return { width, height }
}

function renderTextBoxInline(
  textBox: Element,
  ctx: RenderContext,
  depth = 0,
  base?: ResolvedTextStyle,
  para?: ParaStyleProps
): string {
  const lines: string[] = []
  for (const p of children(textBox, 'p')) {
    const style = ctx.styles.resolve(odfAttr(p, 'style-name'), 'paragraph')
    const text = resolveTextStyle(style?.props.text, base ?? ctx.defaultText, ctx.styles)
    const paraProps = { ...(para ?? {}), ...(style?.props.para ?? {}) }
    const css = inlineCss([paraStyleCss(paraProps), 'display:block', textStyleCss(text, false)])
    lines.push(`<span style="${css}">${renderInlineChildren(p, text, ctx, depth + 1) || '&nbsp;'}</span>`)
  }
  if (lines.length === 0) {
    const text = textOf(textBox)
    if (text) lines.push(`<span style="display:block">${escapeHtml(text)}</span>`)
  }
  return lines.join('')
}

function renderFrameInline(el: Element, ctx: RenderContext, depth = 0): string {
  if (odfAttr(el, 'visibility') === 'hidden') return ''
  if (odfAttr(el, 'anchor-type') === 'page') {
    ctx.warnings.push('页面锚定的图片/表格/文本框按行内位置近似放置')
  }
  const image = child(el, 'image')
  if (image) {
    const src = imageDataUrl(image, ctx)
    if (src) {
      const { width, height } = frameSize(el, ctx)
      return `<img src="${src}" style="width:${round(width)}pt;height:${round(height)}pt;vertical-align:middle" alt="">`
    }
  }
  const style = ctx.styles.resolve(odfAttr(el, 'style-name'), 'graphic')
  const frameCss = graphicStyleCss(style?.props.graphic)
  const frameBase = resolveTextStyle(style?.props.text, ctx.defaultText, ctx.styles)
  const table = child(el, 'table')
  if (table) {
    const { width } = frameSize(el, ctx)
    return (
      `<span class="inline-textbox" style="width:${round(width)}pt;${frameCss}">` +
      `${renderOdtTable(table, ctx, depth, frameBase, width)}</span>`
    )
  }
  // 行内文本框(as-char/char 锚定)不能丢:内容用 display:block 的 span 逐段排,避免
  // <span> 里塞 <p> 被 HTML 解析器拆开
  const textBox = child(el, 'text-box')
  if (!textBox) return ''
  const { width, height } = frameSize(el, ctx)
  return (
    `<span class="inline-textbox" style="width:${round(width)}pt;min-height:${round(height)}pt;${frameCss}">` +
    `${renderTextBoxInline(textBox, ctx, depth + 1, frameBase, style?.props.para)}</span>`
  )
}

function renderFrameBlock(el: Element, ctx: RenderContext, depth = 0): string {
  if (odfAttr(el, 'visibility') === 'hidden') return ''
  const anchor = odfAttr(el, 'anchor-type') ?? 'paragraph'
  const frameStyle = ctx.styles.resolve(odfAttr(el, 'style-name'), 'graphic')
  const frameCss = graphicStyleCss(frameStyle?.props.graphic)
  const frameBase = resolveTextStyle(frameStyle?.props.text, ctx.defaultText, ctx.styles)
  const framePara = frameStyle?.props.para
  if ((frameStyle?.props.graphic.fill === 'gradient' || frameStyle?.props.graphic.fill === 'bitmap') && !ctx.warnedFill) {
    ctx.warnedFill = true
    ctx.warnings.push('渐变/图片填充未实现,部分形状背景可能缺失')
  }
  const image = child(el, 'image')
  if (image) {
    const src = imageDataUrl(image, ctx)
    if (src) {
      const { width, height } = frameSize(el, ctx)
      if (anchor === 'page' || anchor === 'paragraph') {
        ctx.warnings.push('页面/段落锚定的图片按行内位置近似放置')
      }
      return `<div class="img-block"${frameCss ? ` style="${frameCss}"` : ''}><img src="${src}" style="width:${round(width)}pt;height:${round(height)}pt" alt=""></div>`
    }
  }
  const object = child(el, 'object') ?? child(el, 'object-ole')
  if (object && !ctx.warnedObject) {
    ctx.warnedObject = true
    ctx.warnings.push('嵌入对象(OLE/图表)未导出')
    return ''
  }
  const media = child(el, 'plugin') ?? child(el, 'video') ?? child(el, 'audio') ?? child(el, 'applet') ?? child(el, 'floating-frame')
  if (media && !ctx.warnedObject) {
    ctx.warnedObject = true
    ctx.warnings.push('多媒体/嵌入框架未导出')
    return ''
  }
  const table = child(el, 'table')
  if (table) {
    const { width } = frameSize(el, ctx)
    return `<div class="table-block">${renderOdtTable(table, ctx, depth, frameBase, width)}</div>`
  }
  const textBox = child(el, 'text-box')
  if (textBox) {
    const { width, height } = frameSize(el, ctx)
    return `<div class="textbox" style="width:${round(width)}pt;min-height:${round(height)}pt;${frameCss}">${renderOdtBlocks(textBox, ctx, depth + 1, undefined, frameBase, framePara)}</div>`
  }
  return ''
}

// ---------------------------------------------------------------------------
// 文字文档表格
// ---------------------------------------------------------------------------

interface OdtCell {
  col: number
  html: string
  colspan: number
  rowspan: number
  props: CellStyleProps
}

interface OdtRow {
  cells: OdtCell[]
  height?: number
  header?: boolean
}

function tableChildRows(el: Element): Element[] {
  const out: Element[] = []
  for (const childEl of elementChildren(el)) {
    const name = localNameOf(childEl)
    if (name === 'table-row') out.push(childEl)
    else if (name === 'table-header-rows' || name === 'table-rows' || name === 'table-row-group') {
      out.push(...tableChildRows(childEl))
    }
  }
  return out
}

/** 工作表行 + 是否属于 table:table-header-rows(表头行要在每页重复) */
function sheetRows(el: Element): Array<{ el: Element; header: boolean }> {
  const out: Array<{ el: Element; header: boolean }> = []
  for (const childEl of elementChildren(el)) {
    const name = localNameOf(childEl)
    if (name === 'table-row') out.push({ el: childEl, header: false })
    else if (name === 'table-header-rows') {
      for (const rowEl of tableChildRows(childEl)) out.push({ el: rowEl, header: true })
    } else if (name === 'table-rows' || name === 'table-row-group') {
      out.push(...sheetRows(childEl))
    }
  }
  return out
}

/** 纵向合并(HTML rowspan)会让后续行在这些列上不能再输出 <td>,否则整行错位 */
function rowspanCoverage(rows: Array<{ cells: Array<{ col: number; colspan: number; rowspan: number }> }>): Set<number>[] {
  const covered = rows.map(() => new Set<number>())
  // 畸形文件可以用大量 100×100 合并单元格把标记循环放大到上亿次;预算用完就停止标记
  let budget = 2_000_000
  for (let r = 0; r < rows.length; r++) {
    for (const cell of rows[r].cells) {
      if (cell.rowspan <= 1) continue
      const last = Math.min(rows.length, r + cell.rowspan)
      const steps = (last - r - 1) * cell.colspan
      if (steps <= 0) continue
      if (steps > budget) return covered
      budget -= steps
      for (let rr = r + 1; rr < last; rr++) {
        for (let col = cell.col; col < cell.col + cell.colspan; col++) covered[rr].add(col)
      }
    }
  }
  return covered
}

function renderOdtTable(
  el: Element,
  ctx: RenderContext,
  depth: number,
  base?: ResolvedTextStyle,
  availableWidthPt?: number
): string {
  const availableWidth =
    availableWidthPt !== undefined && availableWidthPt > 0 ? availableWidthPt : ctx.contentWidthPt
  if (odfAttr(el, 'visibility') === 'collapse') return ''
  const tableStyle = ctx.styles.resolve(odfAttr(el, 'style-name'), 'table')
  const columnEls = children(el, 'table-column')
  const widths: number[] = []
  for (const colEl of columnEls) {
    const repeat = clampInt(odfAttr(colEl, 'number-columns-repeated'), 1, 1, 64)
    if (odfAttr(colEl, 'visibility') === 'collapse') {
      for (let i = 0; i < repeat; i++) widths.push(0)
      continue
    }
    const style = ctx.styles.resolve(odfAttr(colEl, 'style-name'), 'table-column')
    const width = style?.props.column.width ?? DEFAULT_COLUMN_WIDTH_PT
    for (let i = 0; i < repeat; i++) widths.push(width)
  }

  const rowEls = sheetRows(el)
  const rows: OdtRow[] = []
  let contentCols = 0
  for (const row of rowEls) {
    if (rows.length >= 20000) {
      ctx.warnings.push('表格行数过多,已截断到 20000 行')
      break
    }
    const rowEl = row.el
    if (odfAttr(rowEl, 'visibility') === 'collapse') continue
    const rowStyle = ctx.styles.resolve(odfAttr(rowEl, 'style-name'), 'table-row')
    const cellEls = elementChildren(rowEl)
    const cells: OdtCell[] = []
    let columns = 0
    for (const cellEl of cellEls) {
      const name = localNameOf(cellEl)
      if (name !== 'table-cell' && name !== 'covered-table-cell') continue
      if (name === 'covered-table-cell') {
        // 被上方 rowspan 覆盖的格子也要占列,否则后面的单元格会整体左移
        columns += clampInt(odfAttr(cellEl, 'number-columns-repeated'), 1, 1, 100)
        continue
      }
      const colspan = clampInt(odfAttr(cellEl, 'number-columns-spanned'), 1, 1, 100)
      const rowspan = clampInt(odfAttr(cellEl, 'number-rows-spanned'), 1, 1, 100)
      const repeat = clampInt(odfAttr(cellEl, 'number-columns-repeated'), 1, 1, 16)
      const style = ctx.styles.resolve(odfAttr(cellEl, 'style-name'), 'table-cell')
      const cellBase = resolveTextStyle(style?.props.text, base ?? ctx.defaultText, ctx.styles)
      const html = renderOdtBlocks(cellEl, ctx, depth + 1, undefined, cellBase, style?.props.para) || '&nbsp;'
      for (let i = 0; i < repeat; i++) {
        cells.push({
          col: columns,
          html,
          colspan,
          rowspan,
          props: style?.props.cell ?? {}
        })
        columns += colspan
      }
    }
    if (cells.length === 0) continue
    contentCols = Math.max(contentCols, columns)
    const repeat = clampInt(odfAttr(rowEl, 'number-rows-repeated'), 1, 1, 1000)
    if (repeat > 200) ctx.warnings.push('表格重复行过多,已限制为最多 1000 行')
    for (let i = 0; i < repeat && rows.length < 20000; i++) {
      rows.push({ cells, height: rowStyle?.props.row.height ?? rowStyle?.props.row.minHeight, header: row.header })
    }
  }
  if (rows.length === 0) return ''

  if (contentCols > 512) ctx.warnings.push('表格列数过多,已截断到 512 列')
  const maxCols = Math.min(Math.max(contentCols, 1), 512)
  while (widths.length < maxCols) widths.push(DEFAULT_COLUMN_WIDTH_PT)
  widths.length = maxCols
  let total = widths.reduce((sum, width) => sum + width, 0)
  if (total > availableWidth && total > 0) {
    const factor = availableWidth / total
    if (factor < 0.5) ctx.warnings.push('表格宽于页面,已按比例压缩(列宽可能偏窄)')
    for (let i = 0; i < widths.length; i++) widths[i] *= factor
    total = availableWidth
  }
  const align = tableStyle?.props.table.align
  const margin = align === 'center' ? 'margin-left:auto;margin-right:auto' : align === 'right' ? 'margin-left:auto' : ''
  const pageBreak = `${tableStyle?.props.table.breakBefore ? 'break-before:page;' : ''}${
    tableStyle?.props.table.breakAfter ? 'break-after:page;' : ''
  }`
  const colgroup = widths.map((width) => `<col style="width:${round(width)}pt">`).join('')
  const covered = rowspanCoverage(rows)
  const rendered = rows.map((row, index) => {
    const heightCss = row.height ? ` style="height:${round(row.height)}pt"` : ''
    const cellsHtml = row.cells
      .filter((cell) => !covered[index].has(cell.col))
      .map((cell) => {
        const rowspan = Math.min(cell.rowspan, rows.length - index)
        const span = `${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}`
        const css = inlineCss([cellStyleCss(cell.props)])
        return `<td${span}${css ? ` style="${css}"` : ''}>${cell.html}</td>`
      })
      .join('')
    return { header: !!row.header, html: `<tr${heightCss}>${cellsHtml}</tr>` }
  })
  const headerHtml = rendered.filter((row) => row.header).map((row) => row.html).join('')
  const bodyHtml = rendered.filter((row) => !row.header).map((row) => row.html).join('')
  return (
    `<table class="odt-table" style="width:${round(total)}pt;border-collapse:collapse;table-layout:fixed;${margin}${pageBreak}"><colgroup>${colgroup}</colgroup>` +
    (headerHtml ? `<thead>${headerHtml}</thead>` : '') +
    `<tbody>${bodyHtml}</tbody></table>`
  )
}

// ---------------------------------------------------------------------------
// 表格文档(.ods)
// ---------------------------------------------------------------------------

interface SheetCell {
  col: number
  cellEl: Element
  colspan: number
  rowspan: number
}

function cellHasValue(cellEl: Element): boolean {
  if (children(cellEl, 'p').some((p) => textOf(p) !== '')) return true
  // 单元格里可能只有列表/图片/嵌套表格,没有段落
  if (elementChildren(cellEl).some((el) => ['list', 'frame', 'table'].includes(localNameOf(el)) && textOf(el) !== '')) {
    return true
  }
  if (elementChildren(cellEl).some((el) => localNameOf(el) === 'frame')) return true
  return (
    odfAttr(cellEl, 'value') !== null ||
    odfAttr(cellEl, 'string-value') !== null ||
    odfAttr(cellEl, 'date-value') !== null ||
    odfAttr(cellEl, 'time-value') !== null ||
    odfAttr(cellEl, 'boolean-value') !== null
  )
}

function renderSheets(root: Element, ctx: RenderContext): { html: string; zoom: number } {
  const sheets = children(root, 'table')
  const parts: string[] = []
  let maxWidth = 0
  for (const sheet of sheets) {
    if (odfAttr(sheet, 'visibility') === 'collapse' || odfAttr(sheet, 'print') === 'false') continue
    const sheetData = readSheet(sheet, ctx)
    if (!sheetData) continue
    maxWidth = Math.max(maxWidth, sheetData.width)
    // 工作表之间强制分页:每张表从新页开始
    parts.push(
      `<div class="sheet"${parts.length > 0 ? ' style="break-before:page"' : ''}>` +
        `<table style="width:${round(sheetData.width)}pt">${sheetData.colgroup}${sheetData.rows}</table></div>`
    )
  }
  if (parts.length === 0) {
    ctx.warnings.push('表格文档没有可显示的内容')
    return { html: '<div class="sheet">&nbsp;</div>', zoom: 1 }
  }
  const zoom = maxWidth > ctx.contentWidthPt && maxWidth > 0 ? Math.max(0.2, ctx.contentWidthPt / maxWidth) : 1
  if (zoom < 0.5) ctx.warnings.push(`工作表较宽,已按 ${Math.round(zoom * 100)}% 缩放以适配页面`)
  return { html: `<div class="sheets" style="zoom:${round(zoom)}">${parts.join('')}</div>`, zoom }
}

function sheetColumnWidths(sheetEl: Element, maxCols: number, ctx: RenderContext): number[] {
  const widths: number[] = []
  for (const colEl of children(sheetEl, 'table-column')) {
    if (widths.length >= maxCols) break
    const repeat = clampInt(odfAttr(colEl, 'number-columns-repeated'), 1, 1, 1024)
    const hidden = odfAttr(colEl, 'visibility') === 'collapse'
    const style = ctx.styles.resolve(odfAttr(colEl, 'style-name'), 'table-column')
    const width = hidden ? 0 : style?.props.column.width ?? DEFAULT_COLUMN_WIDTH_PT
    for (let i = 0; i < repeat && widths.length < maxCols; i++) widths.push(width)
  }
  while (widths.length < maxCols) widths.push(DEFAULT_COLUMN_WIDTH_PT)
  return widths
}

function sheetCellText(
  cellEl: Element,
  ctx: RenderContext,
  base: ResolvedTextStyle,
  para?: ParaStyleProps
): string {
  // 单元格里可能有段落、列表、图片甚至嵌套表格;统一走块级渲染,
  // 段落外边距由 `.sheet td p { margin: 0 }` 抹掉
  const blocks = renderOdtBlocks(cellEl, ctx, 1, undefined, base, para)
  // 空段落会渲染成 &nbsp;,不能因此挡住公式缓存值;有真实文字/图片才用块级结果
  const visible = blocks
    .replace(/<img[\s\S]*?>/g, 'IMG')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, '')
    .trim()
  if (visible !== '' || blocks.includes('<img') || blocks.includes('<table')) return blocks
  // 没有段落:用缓存值兜底(公式单元格常见)
  const value =
    odfAttr(cellEl, 'value') ??
    odfAttr(cellEl, 'string-value') ??
    odfAttr(cellEl, 'date-value') ??
    odfAttr(cellEl, 'time-value') ??
    odfAttr(cellEl, 'boolean-value') ??
    ''
  return value
    ? `<p style="${inlineCss([paraStyleCss(para), textStyleCss(base, false)])}">${decoratedHtml(escapeHtml(value), base)}</p>`
    : ''
}

function readSheet(sheetEl: Element, ctx: RenderContext): { width: number; colgroup: string; rows: string } | null {
  if (
    !ctx.warnedObject &&
    elementChildren(sheetEl).some((el) => ['frame', 'object', 'object-ole'].includes(localNameOf(el)))
  ) {
    ctx.warnedObject = true
    ctx.warnings.push('工作表中的图表/嵌入对象未导出(单元格文字与数据不受影响)')
  }
  interface RawRow {
    cells: SheetCell[]
    height?: number
    header?: boolean
  }
  const rawRows: RawRow[] = []
  let rowIndex = 0
  let maxCol = 0
  let sawContent = false

  const addRow = (rowEl: Element, repeat: number, header: boolean): void => {
    const rowStyle = ctx.styles.resolve(odfAttr(rowEl, 'style-name'), 'table-row')
    const cells: SheetCell[] = []
    let col = 0
    let hasContent = false
    for (const cellEl of elementChildren(rowEl)) {
      const name = localNameOf(cellEl)
      if (name !== 'table-cell' && name !== 'covered-table-cell') continue
      const repeatCell = clampInt(odfAttr(cellEl, 'number-columns-repeated'), 1, 1, 1024)
      if (name === 'covered-table-cell' || odfAttr(cellEl, 'visibility') === 'collapse') {
        col += repeatCell
        continue
      }
      const colspan = clampInt(odfAttr(cellEl, 'number-columns-spanned'), 1, 1, 100)
      const rowspan = clampInt(odfAttr(cellEl, 'number-rows-spanned'), 1, 1, 100)
      const hasText = cellHasValue(cellEl)
      const cellStyle = ctx.styles.resolve(odfAttr(cellEl, 'style-name'), 'table-cell')?.props.cell
      const hasVisual = !!(
        cellStyle &&
        (cellStyle.background ||
          cellStyle.borderTop ||
          cellStyle.borderRight ||
          cellStyle.borderBottom ||
          cellStyle.borderLeft)
      )
      // 空白且无边框/底色的重复单元格不建 DOM(Calc 常在行尾写 number-columns-repeated=1021)
      const repeatKeep = hasText ? Math.min(repeatCell, 8) : hasVisual ? 1 : 0
      for (let i = 0; i < repeatKeep; i++) {
        cells.push({ col: col + i * colspan, cellEl, colspan, rowspan })
      }
      if (hasText || hasVisual) {
        hasContent = true
        maxCol = Math.max(maxCol, col + repeatCell * colspan)
      }
      col += repeatCell * colspan
      if (col > ctx.maxSheetCols) {
        if (hasText || hasVisual) ctx.truncatedCols = true
        col = ctx.maxSheetCols
        break
      }
    }
    if (hasContent) sawContent = true
    // 顶部空白行直接跳过;内容之后的空白行保留一组,用于视觉间隔
    const keep = hasContent ? Math.min(repeat, 4) : sawContent ? Math.min(repeat, 1) : 0
    for (let i = 0; i < keep; i++) {
      if (rowIndex >= ctx.maxSheetRows) {
        ctx.truncatedRows = true
        return
      }
      rawRows.push({ cells, height: rowStyle?.props.row.height ?? rowStyle?.props.row.minHeight, header })
      rowIndex++
    }
  }

  for (const row of sheetRows(sheetEl)) {
    if (rowIndex >= ctx.maxSheetRows) {
      ctx.truncatedRows = true
      break
    }
    if (odfAttr(row.el, 'visibility') === 'collapse') continue
    addRow(row.el, clampInt(odfAttr(row.el, 'number-rows-repeated'), 1, 1, 100000), row.header)
  }
  // 去掉末尾空行;maxCol 按实际占用列重算,避免把尾部空列也铺出来
  while (rawRows.length > 0 && rawRows[rawRows.length - 1].cells.length === 0) {
    rawRows.pop()
  }
  if (rawRows.length === 0) return null
  let lastCol = 1
  for (const row of rawRows) {
    for (const cell of row.cells) lastCol = Math.max(lastCol, cell.col + cell.colspan)
  }
  maxCol = Math.min(Math.max(lastCol, maxCol, 1), ctx.maxSheetCols)

  const widths = sheetColumnWidths(sheetEl, maxCol, ctx)
  const base = resolveTextStyle(ctx.styles.defaultText().props, ctx.defaultText, ctx.styles)
  const htmlRows: Array<{ html: string; header: boolean }> = []
  const covered = rowspanCoverage(rawRows)
  rawRows.forEach((row, r) => {
    const byCol = new Map<number, string>()
    for (const item of row.cells) {
      if (byCol.has(item.col) || covered[r].has(item.col)) continue
      const style = ctx.styles.resolve(odfAttr(item.cellEl, 'style-name'), 'table-cell')
      const cellBase = resolveTextStyle(style?.props.text, base, ctx.styles)
      const html = sheetCellText(item.cellEl, ctx, cellBase, style?.props.para)
      const cellProps = style?.props.cell
      const padding =
        cellProps?.padding !== undefined ||
        cellProps?.paddingTop !== undefined ||
        cellProps?.paddingBottom !== undefined ||
        cellProps?.paddingLeft !== undefined ||
        cellProps?.paddingRight !== undefined
          ? ''
          : 'padding:1.5pt'
      const css = inlineCss([cellStyleCss(cellProps), padding])
      const rowspan = Math.min(item.rowspan, rawRows.length - r)
      const span = `${item.colspan > 1 ? ` colspan="${item.colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}`
      byCol.set(item.col, `<td${span} style="${css}">${html || '&nbsp;'}</td>`)
    }
    let cellsHtml = ''
    for (let col = 0; col < maxCol; col++) {
      if (covered[r].has(col)) continue
      cellsHtml += byCol.get(col) ?? '<td style="padding:1.5pt"></td>'
    }
    const heightCss = row.height ? ` style="height:${round(row.height)}pt"` : ''
    htmlRows.push({ html: `<tr${heightCss}>${cellsHtml}</tr>`, header: !!row.header })
  })
  const colgroup = `<colgroup>${widths.map((width) => `<col style="width:${round(width)}pt">`).join('')}</colgroup>`
  const headerRows = htmlRows.filter((row) => row.header).map((row) => row.html)
  const bodyRows = htmlRows.filter((row) => !row.header).map((row) => row.html)
  const rows =
    (headerRows.length > 0 ? `<thead>${headerRows.join('')}</thead>` : '') + `<tbody>${bodyRows.join('')}</tbody>`
  return { width: widths.reduce((sum, width) => sum + width, 0), colgroup, rows }
}

// ---------------------------------------------------------------------------
// 演示文档(.odp)
// ---------------------------------------------------------------------------

function findSlideLayout(presentation: Element, ctx: RenderContext): PageLayout | null {
  const firstSlide = children(presentation, 'page')[0]
  if (!firstSlide) return null
  const masterName = odfAttr(firstSlide, 'master-page-name')
  const master = ctx.styles.masterPage(masterName) ?? ctx.styles.firstMasterPage()
  return ctx.styles.pageLayout(master?.pageLayout ?? null)
}

const PRESENTATION_SHAPE_NAMES = new Set([
  'frame',
  'custom-shape',
  'rect',
  'ellipse',
  'circle',
  'line',
  'connector',
  'polyline',
  'polygon',
  'path',
  'g',
  'caption',
  'measure'
])

function isPresentationShape(name: string): boolean {
  return PRESENTATION_SHAPE_NAMES.has(name)
}

function renderSlides(presentation: Element, ctx: RenderContext, layout: PageLayout): string {
  const slides = children(presentation, 'page')
  const out: string[] = []
  slides.forEach((slide, index) => {
    // presentation:visibility="hidden" 的幻灯片默认不打印
    if (odfAttr(slide, 'visibility') === 'hidden') return
    const masterName = odfAttr(slide, 'master-page-name')
    const master = ctx.styles.masterPage(masterName) ?? ctx.styles.firstMasterPage()
    // 背景:slide 自己的 drawing-page 样式优先;没有时用母版页的 draw:style-name
    const masterStyleName = master?.el ? odfAttr(master.el, 'style-name') : null
    const pageStyle =
      ctx.styles.resolve(odfAttr(slide, 'style-name'), 'drawing-page') ??
      ctx.styles.resolve(masterStyleName, 'drawing-page')
    const background = pageStyle?.props.drawingPage.fillColor
    const backgroundImage = pageStyle?.props.drawingPage.fillImage
    if (
      (pageStyle?.props.drawingPage.fill === 'gradient' || pageStyle?.props.drawingPage.fill === 'hatch') &&
      !ctx.warnedFill
    ) {
      ctx.warnedFill = true
      ctx.warnings.push('渐变/图案背景未实现,幻灯片背景可能缺失')
    }
    let bg = background ? `background-color:${background};` : ''
    if (backgroundImage) {
      const src = imageUrlByHref(backgroundImage, ctx)
      if (src) {
        bg += `background-image:url(${src});background-size:${pageStyle?.props.drawingPage.backgroundSize === 'full' ? 'cover' : 'contain'};background-repeat:no-repeat;background-position:center;`
      }
    }
    const parts: string[] = []
    if (master?.el) {
      for (const shape of elementChildren(master.el)) {
        if (isPresentationShape(localNameOf(shape))) parts.push(renderShape(shape, ctx))
      }
    }
    for (const shape of elementChildren(slide)) {
      const name = localNameOf(shape)
      if (name === 'notes') continue
      if (isPresentationShape(name)) parts.push(renderShape(shape, ctx))
    }
    out.push(
      // 高度略小于页面:等于页面高度时 Chromium 的打印分页会把 slide 之后多顶出一张空白页。
      // 缺的 0.8mm 用同色 box-shadow 补到页底,避免色块背景底部出现白边。
      `<div class="slide" data-slide="${index + 1}" style="width:${mm(layout.widthMm)}mm;height:${mm(layout.heightMm - 0.8)}mm;` +
        (background ? `box-shadow:0 0.8mm 0 0 ${background};` : '') +
        `${bg}">${parts.join('')}</div>`
    )
  })
  if (out.length === 0) {
    ctx.warnings.push('演示文稿没有可见幻灯片,已输出一张空白页')
    return `<div class="slide" style="width:${mm(layout.widthMm)}mm;height:${mm(layout.heightMm - 0.8)}mm"></div>`
  }
  return out.join('')
}

function shapeBox(el: Element): { x: number; y: number; w: number; h: number } {
  return {
    x: parseLengthPt(odfAttr(el, 'x')) ?? 0,
    y: parseLengthPt(odfAttr(el, 'y')) ?? 0,
    w: parseLengthPt(odfAttr(el, 'width')) ?? 0,
    h: parseLengthPt(odfAttr(el, 'height')) ?? 0
  }
}

function shapeTransform(el: Element): string {
  const raw = odfAttr(el, 'transform')
  if (!raw) return ''
  const parts: string[] = []
  const re = /(translate|rotate|scale|matrix|skewX|skewY)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw))) {
    const op = match[1]
    const args = match[2]
      .trim()
      .split(/[\s,]+/)
      .map((token) => (token.endsWith('cm') || token.endsWith('mm') || token.endsWith('pt') || token.endsWith('in') ? (parseLengthPt(token) ?? 0) : Number(token)))
      .filter((n) => Number.isFinite(n))
    if (args.length === 0) continue
    const unit = op === 'translate' ? 'pt' : op === 'rotate' || op === 'skewX' || op === 'skewY' ? 'deg' : ''
    parts.push(`${op}(${args.map((n) => `${round(n)}${unit}`).join(',')})`)
  }
  return parts.length > 0 ? `transform:${parts.join(' ')};transform-origin:0 0;` : ''
}

function shapeStyle(el: Element, ctx: RenderContext): { style: GraphicStyleProps; css: string } {
  const style = ctx.styles.resolve(odfAttr(el, 'style-name'), 'graphic')
  return { style: style?.props.graphic ?? {}, css: graphicStyleCss(style?.props.graphic) }
}

function textBoxHtml(
  el: Element,
  ctx: RenderContext,
  baseSize?: number,
  bold = false,
  styleName?: string | null
): string {
  const textBox = child(el, 'text-box') ?? el
  const shape = ctx.styles.resolve(styleName, 'paragraph')
  const shapeText = shape?.props.text ?? {}
  const base = baseSize
    ? resolveTextStyle(
        { fontSize: `${baseSize}pt`, ...(bold ? { bold: true } : {}), ...shapeText },
        ctx.defaultText,
        ctx.styles
      )
    : ctx.defaultText
  return renderOdtBlocks(textBox, ctx, 1, undefined, base, shape?.props.para)
}

function renderShape(el: Element, ctx: RenderContext, depth = 0): string {
  if (depth > 100) return ''
  if (odfAttr(el, 'visibility') === 'hidden') return ''
  const name = localNameOf(el)
  const box = shapeBox(el)
  const position = `left:${round(box.x)}pt;top:${round(box.y)}pt;`
  const size = `${box.w > 0 ? `width:${round(box.w)}pt;` : ''}${box.h > 0 ? `height:${round(box.h)}pt;` : ''}`
  const transform = shapeTransform(el)
  const { style: graphic, css: baseShapeCss } = shapeStyle(el, ctx)
  let fillCss = ''
  if (graphic.fill === 'bitmap' && graphic.fillImage) {
    const src = imageUrlByHref(graphic.fillImage, ctx)
    if (src) fillCss = `background-image:url(${src});background-size:cover;background-position:center;`
  }
  const needsFillWarning =
    graphic.fill === 'gradient' || graphic.fill === 'hatch' || (graphic.fill === 'bitmap' && fillCss === '')
  if (needsFillWarning && !ctx.warnedFill) {
    ctx.warnedFill = true
    ctx.warnings.push('渐变/图案/图片填充未实现,部分形状背景可能缺失')
  }
  const css = `${baseShapeCss}${fillCss}`

  if (name === 'frame') {
    const image = child(el, 'image')
    if (image) {
      const src = imageDataUrl(image, ctx)
      if (src) return `<div class="shape" style="${position}${size}${transform}${css}"><img src="${src}" alt=""></div>`
    }
    const object = child(el, 'object') ?? child(el, 'object-ole')
    if (object) {
      if (!ctx.warnedObject) {
        ctx.warnedObject = true
        ctx.warnings.push('演示文稿里的嵌入对象(OLE/图表)未导出')
      }
      return ''
    }
    const media = child(el, 'plugin') ?? child(el, 'video') ?? child(el, 'audio') ?? child(el, 'applet') ?? child(el, 'floating-frame')
    if (media) {
      if (!ctx.warnedObject) {
        ctx.warnedObject = true
        ctx.warnings.push('演示文稿里的音视频/嵌入框架未导出')
      }
      return ''
    }
    const table = child(el, 'table')
    if (table) {
      return `<div class="shape" style="${position}${size}${transform}${css}">${renderOdtTable(table, ctx, 0, undefined, box.w > 0 ? box.w : undefined)}</div>`
    }
    const textBox = child(el, 'text-box')
    if (textBox) {
      const vertical = graphic.textVerticalAlign === 'middle' ? 'center' : graphic.textVerticalAlign === 'bottom' ? 'flex-end' : 'flex-start'
      const titleClass = odfAttr(el, 'class') ?? ''
      const title = /title/i.test(titleClass) && !/subtitle/i.test(titleClass)
      const baseSize = title ? 28 : /subtitle/i.test(titleClass) ? 20 : 18
      // 形状默认留一点内边距,否则文字会贴着边框(文档显式给 fo:padding 时以文档为准)
      const pad = graphic.padding === undefined ? 'padding:2.5pt;' : ''
      return `<div class="shape" style="${position}${size}${transform}${pad}${css}"><div class="shape-text" style="height:100%;justify-content:${vertical}">${textBoxHtml(el, ctx, baseSize, title, odfAttr(el, 'text-style-name'))}</div></div>`
    }
    return ''
  }

  if (name === 'custom-shape' || name === 'rect' || name === 'ellipse' || name === 'circle') {
    const enhanced = child(el, 'enhanced-geometry')
    if (name === 'custom-shape' && enhanced && !ctx.warnedGeometry) {
      ctx.warnedGeometry = true
      ctx.warnings.push('自定义形状的复杂几何按矩形近似渲染')
    }
    const geometry = odfAttr(el, 'geometry') ?? (enhanced ? odfAttr(enhanced, 'type') : null) ?? ''
    const corner = parseLengthPt(odfAttr(el, 'corner-radius'))
    const radius =
      name === 'ellipse' || name === 'circle' || /ellipse|circle/i.test(geometry)
        ? 'border-radius:50%;'
        : /round/i.test(geometry) || (corner !== null && corner > 0)
          ? `border-radius:${round(corner !== null && corner > 0 ? corner : 8)}pt;`
          : ''
    const textBox = child(el, 'text-box')
    const vertical = graphic.textVerticalAlign === 'middle' ? 'center' : graphic.textVerticalAlign === 'bottom' ? 'flex-end' : 'flex-start'
    const shapeTextStyle = ctx.styles.resolve(odfAttr(el, 'text-style-name'), 'paragraph')
    const shapeBase = resolveTextStyle(
      { fontSize: '18pt', ...(shapeTextStyle?.props.text ?? {}) },
      ctx.defaultText,
      ctx.styles
    )
    const textHtml = textBox
      ? textBoxHtml(el, ctx, 18, false, odfAttr(el, 'text-style-name'))
      : children(el, 'p').length > 0
        ? renderOdtBlocks(el, ctx, 1, undefined, shapeBase, shapeTextStyle?.props.para)
        : ''
    const content = textHtml
      ? `<div class="shape-text" style="height:100%;justify-content:${vertical}">${textHtml}</div>`
      : ''
    const pad = graphic.padding === undefined ? 'padding:2.5pt;' : ''
    return `<div class="shape" style="${position}${size}${transform}${radius}${pad}${css}">${content}</div>`
  }

  if (name === 'line' || name === 'connector' || name === 'polyline' || name === 'polygon' || name === 'path') {
    const strokeWidth = graphic.stroke === 'none' ? 0 : graphic.strokeWidth ?? 0.75
    const strokeAttrs =
      strokeWidth > 0
        ? `stroke="${graphic.strokeColor ?? '#000000'}" stroke-width="${round(strokeWidth)}"`
        : 'stroke="none"'
    let inner = ''
    let viewW = Math.max(box.w, 1)
    let viewH = Math.max(box.h, 1)
    if (name === 'line' || name === 'connector') {
      const x1 = parseLengthPt(odfAttr(el, 'x1')) ?? 0
      const y1 = parseLengthPt(odfAttr(el, 'y1')) ?? 0
      const x2 = parseLengthPt(odfAttr(el, 'x2')) ?? box.w
      const y2 = parseLengthPt(odfAttr(el, 'y2')) ?? box.h
      viewW = Math.max(viewW, x1, x2, 1)
      viewH = Math.max(viewH, y1, y2, 1)
      inner = `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" ${strokeAttrs} fill="none"/>`
    } else if (name === 'polyline' || name === 'polygon') {
      const points = (odfAttr(el, 'points') ?? '')
        .trim()
        .split(/\s+/)
        .map((pair) => pair.replace(',', ' '))
        .join(' ')
      inner = `<${name} points="${escapeHtml(points)}" ${strokeAttrs} fill="${graphic.fillColor ?? 'none'}"/>`
    } else {
      const d = (odfAttr(el, 'd') ?? odfAttr(el, 'path') ?? '').replace(/[^MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]/g, '')
      inner = `<path d="${escapeHtml(d)}" ${strokeAttrs} fill="${graphic.fillColor ?? 'none'}"/>`
    }
    let viewBox = `0 0 ${round(viewW)} ${round(viewH)}`
    if (name !== 'line' && name !== 'connector') {
      // 多边形/路径通常用 svg:viewBox 声明自己的坐标空间(LibreOffice 常见 21600×21600)
      const vb = numList(odfAttr(el, 'viewBox'))
      if (vb.length >= 4 && vb[2] > 0 && vb[3] > 0) {
        viewBox = `${round(vb[0])} ${round(vb[1])} ${round(vb[2])} ${round(vb[3])}`
        if (box.w <= 0) {
          viewW = 120
          viewH = (viewW * vb[3]) / vb[2]
        }
      }
    }
    const svgSize = `width:${round(viewW)}pt;height:${round(viewH)}pt;`
    return `<svg class="shape" style="${position}${svgSize}${transform}overflow:visible" viewBox="${viewBox}" preserveAspectRatio="none">${inner}</svg>`
  }

  if (name === 'g') {
    const childrenHtml = elementChildren(el).map((childEl) => renderShape(childEl, ctx, depth + 1)).join('')
    return `<div class="shape" style="${position}${transform}width:${round(Math.max(box.w, 0))}pt;height:${round(Math.max(box.h, 0))}pt;overflow:visible">${childrenHtml}</div>`
  }

  if (name === 'caption' || name === 'measure') {
    const textBox = child(el, 'text-box')
    if (!textBox) return ''
    return `<div class="shape" style="${position}${size}${transform}${css}"><div class="shape-text" style="height:100%">${textBoxHtml(el, ctx, 14)}</div></div>`
  }
  return ''
}

/** 供单测/诊断:把 ODF 颜色解析暴露出去(与 style.ts 同源) */
export { parseColor, parseOpacity }
