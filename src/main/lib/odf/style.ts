/**
 * ODF 样式解析:把 style:style / style:default-style / 页面布局 / 列表样式
 * 解析成「按名称可查、带父样式继承」的普通对象。
 *
 * ODF 的样式是「族 + 名称 + 父样式」的链,属性分散在 style:text-properties、
 * style:paragraph-properties、style:table-cell-properties 等子元素里;自动样式
 * 常在 content.xml 里,命名样式在 styles.xml 里。这里把两者合并后按需解析,
 * 调用方只需要 `styles.text(name)` 这样的读取。
 */
import { child, children, elementChildren, localNameOf } from '../ofd/model'
import { odfAttr } from './xml'

// ---------------------------------------------------------------------------
// 单位、颜色、边框
// ---------------------------------------------------------------------------

const UNIT_TO_PT: Record<string, number> = {
  pt: 1,
  pc: 12,
  in: 72,
  cm: 72 / 2.54,
  mm: 72 / 25.4,
  px: 72 / 96,
  em: 12,
  rem: 12
}

/**
 * ODF 长度 → pt。支持 pt/pc/in/cm/mm/px 与百分比(百分比需要 fontSizePt 作基准)。
 * 无法识别返回 null(调用方保持默认值,不把 0 当成有效值)。
 */
export function parseLengthPt(value: string | null | undefined, fontSizePt?: number): number | null {
  if (!value) return null
  const text = value.trim().toLowerCase()
  if (text === '' || text === 'auto' || text === 'none') return null
  const percent = /^(-?[\d.]+)%$/.exec(text)
  if (percent) {
    if (fontSizePt === undefined || !Number.isFinite(fontSizePt)) return null
    const pct = Number(percent[1])
    return Number.isFinite(pct) ? (fontSizePt * pct) / 100 : null
  }
  const match = /^(-?(?:\d+\.?\d*|\.\d+))\s*([a-z]*)$/.exec(text)
  if (!match) return null
  const number = Number(match[1])
  const unit = match[2] || 'pt'
  if ((unit === 'em' || unit === 'rem') && fontSizePt !== undefined && fontSizePt > 0) {
    return Number.isFinite(number) ? number * fontSizePt : null
  }
  const factor = UNIT_TO_PT[unit]
  if (!Number.isFinite(number) || factor === undefined) return null
  return number * factor
}

/** ODF 颜色 → #rrggbb;transparent/空/非法返回 null */
const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  navy: '#000080',
  olive: '#808000',
  purple: '#800080',
  teal: '#008080',
  aqua: '#00ffff',
  fuchsia: '#ff00ff',
  lime: '#00ff00'
}

export function parseColor(value: string | null | undefined): string | null {
  if (!value) return null
  const text = value.trim()
  if (text === '' || /^transparent$/i.test(text)) return null
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase()
  }
  // #rrggbbaa(带 alpha):打印背景时忽略 alpha,保留 RGB
  if (/^#[0-9a-f]{8}$/i.test(text)) return text.slice(0, 7).toLowerCase()
  return NAMED_COLORS[text.toLowerCase()] ?? null
}

const BORDER_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'])

/** `0.0007in solid #000000` → `0.05pt solid #000000`;none 原样 */
export function parseBorder(value: string | null | undefined): string | null {
  if (!value) return null
  const text = value.trim()
  if (/^none$/i.test(text)) return 'none'
  let width: number | null = null
  let style = 'solid'
  let color = '#000000'
  for (const token of text.split(/\s+/)) {
    const length = parseLengthPt(token)
    if (length !== null) {
      width = length
      continue
    }
    const lower = token.toLowerCase()
    if (lower === 'thin') width = 1
    else if (lower === 'medium') width = 3
    else if (lower === 'thick') width = 5
    else if (BORDER_STYLES.has(lower)) style = lower
    else {
      const parsed = parseColor(token)
      if (parsed) color = parsed
    }
  }
  const widthPt = Math.max(width ?? 1, 0.1)
  return `${round(widthPt)}pt ${style} ${color}`
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 百分比 0..1;`50%` → 0.5,`128`(无百分号)按 0..255 处理 */
export function parseOpacity(value: string | null | undefined): number | null {
  if (!value) return null
  const text = value.trim()
  const percent = /^(-?[\d.]+)%$/.exec(text)
  if (percent) {
    const pct = Number(percent[1])
    return Number.isFinite(pct) ? Math.min(1, Math.max(0, pct / 100)) : null
  }
  const number = Number(text)
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number > 1 ? number / 255 : number)) : null
}

/** 字体名列表 → CSS 值(逐项加引号并补通用族,避免中文名/多词名被拆开) */
export function cssFontFamily(families: string[] | undefined, generic?: string): string | null {
  const cleaned: string[] = []
  for (const raw of families ?? []) {
    const name = sanitizeFontName(raw)
    if (name && !cleaned.includes(name)) cleaned.push(name)
  }
  const fallback = genericFor(cleaned, generic)
  if (cleaned.length === 0) return fallback
  // 用单引号:整段 CSS 会放进双引号包裹的 style="…" 属性里
  return `${cleaned.map((name) => `'${name}'`).join(', ')}, ${fallback}`
}

function sanitizeFontName(value: string): string {
  return value
    .replace(/["'\\;{}\r\n\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 120)
}

function genericFor(families: string[], generic?: string): string {
  const declared = (generic ?? '').toLowerCase()
  if (declared === 'roman') return 'serif'
  if (declared === 'swiss') return 'sans-serif'
  if (declared === 'modern') return 'monospace'
  if (declared === 'script') return 'cursive'
  if (declared === 'decorative' || declared === 'fantasy') return 'fantasy'
  if (declared === 'system') return 'system-ui'
  const joined = families.join(' ').toLowerCase()
  if (/courier|mono|consol|menlo|monaco/.test(joined)) return 'monospace'
  if (/times|serif|georgia|garamond|song|宋|仿宋|楷/.test(joined)) return 'serif'
  if (/arial|helvetica|sans|yahei|雅黑|hei|黑体|等线/.test(joined)) return 'sans-serif'
  return 'serif'
}

// ---------------------------------------------------------------------------
// 属性类型
// ---------------------------------------------------------------------------

export interface TextStyleProps {
  fontFamily?: string
  fontGeneric?: string
  /** 原始值:`12pt` / `120%` / `1.2cm` */
  fontSize?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  background?: string
  superscript?: boolean
  subscript?: boolean
  letterSpacing?: string
}

export interface ResolvedTextStyle {
  familyCss?: string
  sizePt: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  background?: string
  verticalAlign?: 'super' | 'sub'
  letterSpacingPt?: number
}

export interface ParaStyleProps {
  textAlign?: string
  marginLeft?: number
  marginRight?: number
  textIndent?: number
  marginTop?: number
  marginBottom?: number
  padding?: number
  lineHeight?: string
  breakBefore?: boolean
  breakAfter?: boolean
  background?: string
}

export interface CellStyleProps {
  background?: string
  borderTop?: string
  borderRight?: string
  borderBottom?: string
  borderLeft?: string
  padding?: number
  paddingTop?: number
  paddingBottom?: number
  paddingLeft?: number
  paddingRight?: number
  verticalAlign?: string
  noWrap?: boolean
}

export interface ColumnStyleProps {
  width?: number
}

export interface RowStyleProps {
  height?: number
  minHeight?: number
}

export interface TableStyleProps {
  width?: number
  align?: string
  borderModel?: string
  breakBefore?: boolean
  breakAfter?: boolean
}

export interface GraphicStyleProps {
  fill?: string
  fillColor?: string
  fillImage?: string
  opacity?: number
  stroke?: string
  strokeColor?: string
  strokeWidth?: number
  strokeDash?: string
  textVerticalAlign?: string
  padding?: number
  autoGrowHeight?: boolean
}

export interface DrawingPageStyleProps {
  fill?: string
  fillColor?: string
  fillImage?: string
  opacity?: number
  backgroundSize?: string
}

export interface PageLayout {
  widthMm: number
  heightMm: number
  marginTopMm: number
  marginBottomMm: number
  marginLeftMm: number
  marginRightMm: number
}

export interface ListLevelStyle {
  kind: 'bullet' | 'number' | 'none'
  bulletChar?: string
  numFormat?: string
  numPrefix?: string
  numSuffix?: string
  start?: number
}

export interface ListStyleDef {
  levels: Map<number, ListLevelStyle>
}

export interface StyleProps {
  text: TextStyleProps
  para: ParaStyleProps
  cell: CellStyleProps
  column: ColumnStyleProps
  row: RowStyleProps
  table: TableStyleProps
  graphic: GraphicStyleProps
  drawingPage: DrawingPageStyleProps
}

export interface StyleNode {
  name: string
  family: string
  parent: string | null
  props: StyleProps
}

const PT_TO_MM = 25.4 / 72

// ---------------------------------------------------------------------------
// 属性读取
// ---------------------------------------------------------------------------

function readTextProps(el: Element): TextStyleProps {
  const props: TextStyleProps = {}
  const family = odfAttr(el, 'font-family')
  if (family) props.fontFamily = family
  const generic = odfAttr(el, 'font-family-generic')
  if (generic) props.fontGeneric = generic
  const fontName = odfAttr(el, 'font-name')
  if (fontName) props.fontFamily = fontName
  const size = odfAttr(el, 'font-size')
  if (size) props.fontSize = size
  const weight = odfAttr(el, 'font-weight')
  if (weight) {
    const lower = weight.toLowerCase()
    const numeric = Number(weight)
    props.bold = lower === 'bold' || lower === 'bolder' || (Number.isFinite(numeric) && numeric >= 600)
  }
  const style = odfAttr(el, 'font-style')
  if (style) props.italic = style === 'italic' || style === 'oblique'
  const underline = odfAttr(el, 'text-underline-style')
  if (underline) props.underline = underline !== 'none'
  const strike = odfAttr(el, 'text-line-through-style')
  if (strike) props.strike = strike !== 'none'
  const color = odfAttr(el, 'color')
  if (color) props.color = parseColor(color) ?? undefined
  const background = odfAttr(el, 'background-color')
  if (background) props.background = parseColor(background) ?? undefined
  const position = odfAttr(el, 'text-position')
  if (position) {
    if (position.startsWith('super')) props.superscript = true
    else if (position.startsWith('sub')) props.subscript = true
  }
  const letterSpacing = odfAttr(el, 'letter-spacing')
  if (letterSpacing) props.letterSpacing = letterSpacing
  return props
}

function readParaProps(el: Element): ParaStyleProps {
  const props: ParaStyleProps = {}
  const align = odfAttr(el, 'text-align')
  if (align) props.textAlign = align
  const marginLeft = parseLengthPt(odfAttr(el, 'margin-left'))
  if (marginLeft !== null) props.marginLeft = marginLeft
  const marginRight = parseLengthPt(odfAttr(el, 'margin-right'))
  if (marginRight !== null) props.marginRight = marginRight
  const indent = parseLengthPt(odfAttr(el, 'text-indent'))
  if (indent !== null) props.textIndent = indent
  const marginTop = parseLengthPt(odfAttr(el, 'margin-top'))
  if (marginTop !== null) props.marginTop = marginTop
  const marginBottom = parseLengthPt(odfAttr(el, 'margin-bottom'))
  if (marginBottom !== null) props.marginBottom = marginBottom
  const padding = parseLengthPt(odfAttr(el, 'padding'))
  if (padding !== null) props.padding = padding
  const lineHeight = odfAttr(el, 'line-height')
  if (lineHeight) props.lineHeight = lineHeight
  const breakBefore = odfAttr(el, 'break-before')
  if (breakBefore === 'page') props.breakBefore = true
  const breakAfter = odfAttr(el, 'break-after')
  if (breakAfter === 'page') props.breakAfter = true
  const background = odfAttr(el, 'background-color')
  if (background) props.background = parseColor(background) ?? undefined
  return props
}

function readCellProps(el: Element): CellStyleProps {
  const props: CellStyleProps = {}
  const background = odfAttr(el, 'background-color')
  if (background) props.background = parseColor(background) ?? undefined
  const border = parseBorder(odfAttr(el, 'border'))
  if (border) {
    props.borderTop = border
    props.borderRight = border
    props.borderBottom = border
    props.borderLeft = border
  }
  for (const [name, key] of [
    ['border-top', 'borderTop'],
    ['border-right', 'borderRight'],
    ['border-bottom', 'borderBottom'],
    ['border-left', 'borderLeft']
  ] as const) {
    const parsed = parseBorder(odfAttr(el, name))
    if (parsed) props[key] = parsed
  }
  const padding = parseLengthPt(odfAttr(el, 'padding'))
  if (padding !== null) props.padding = padding
  for (const [name, key] of [
    ['padding-top', 'paddingTop'],
    ['padding-bottom', 'paddingBottom'],
    ['padding-left', 'paddingLeft'],
    ['padding-right', 'paddingRight']
  ] as const) {
    const parsed = parseLengthPt(odfAttr(el, name))
    if (parsed !== null) props[key] = parsed
  }
  const vertical = odfAttr(el, 'vertical-align')
  if (vertical) props.verticalAlign = vertical
  const wrap = odfAttr(el, 'wrap-option')
  if (wrap === 'no-wrap') props.noWrap = true
  return props
}

function readColumnProps(el: Element): ColumnStyleProps {
  const props: ColumnStyleProps = {}
  const width = parseLengthPt(odfAttr(el, 'column-width'))
  if (width !== null && width > 0) props.width = width
  return props
}

function readRowProps(el: Element): RowStyleProps {
  const props: RowStyleProps = {}
  const height = parseLengthPt(odfAttr(el, 'row-height'))
  if (height !== null && height >= 0) props.height = height
  const minHeight = parseLengthPt(odfAttr(el, 'min-row-height'))
  if (minHeight !== null && minHeight >= 0) props.minHeight = minHeight
  return props
}

function readTableProps(el: Element): TableStyleProps {
  const props: TableStyleProps = {}
  const width = parseLengthPt(odfAttr(el, 'width'))
  if (width !== null && width > 0) props.width = width
  const align = odfAttr(el, 'align')
  if (align) props.align = align
  const borderModel = odfAttr(el, 'border-model')
  if (borderModel) props.borderModel = borderModel
  if (odfAttr(el, 'break-before') === 'page') props.breakBefore = true
  if (odfAttr(el, 'break-after') === 'page') props.breakAfter = true
  return props
}

function fillImageOf(el: Element): string | undefined {
  const direct = odfAttr(el, 'fill-image')
  if (direct) return direct
  const image = child(el, 'fill-image')
  return image ? odfAttr(image, 'href') ?? undefined : undefined
}

function readGraphicProps(el: Element): GraphicStyleProps {
  const props: GraphicStyleProps = {}
  const fill = odfAttr(el, 'fill')
  if (fill) props.fill = fill
  const fillColor = parseColor(odfAttr(el, 'fill-color'))
  if (fillColor) props.fillColor = fillColor
  const fillImage = fillImageOf(el)
  if (fillImage) props.fillImage = fillImage
  const opacity = parseOpacity(odfAttr(el, 'opacity'))
  if (opacity !== null) props.opacity = opacity
  const stroke = odfAttr(el, 'stroke')
  if (stroke) props.stroke = stroke
  const strokeColor = parseColor(odfAttr(el, 'stroke-color'))
  if (strokeColor) props.strokeColor = strokeColor
  const strokeWidth = parseLengthPt(odfAttr(el, 'stroke-width'))
  if (strokeWidth !== null) props.strokeWidth = strokeWidth
  const strokeDash = odfAttr(el, 'stroke-dash')
  if (strokeDash) props.strokeDash = strokeDash
  const vertical = odfAttr(el, 'textarea-vertical-align')
  if (vertical) props.textVerticalAlign = vertical
  const padding = parseLengthPt(odfAttr(el, 'padding'))
  if (padding !== null) props.padding = padding
  const grow = odfAttr(el, 'auto-grow-height')
  if (grow) props.autoGrowHeight = grow === 'true'
  return props
}

function readDrawingPageProps(el: Element): DrawingPageStyleProps {
  const props: DrawingPageStyleProps = {}
  const fill = odfAttr(el, 'fill')
  if (fill) props.fill = fill
  const fillColor = parseColor(odfAttr(el, 'fill-color'))
  if (fillColor) props.fillColor = fillColor
  const fillImage = fillImageOf(el)
  if (fillImage) props.fillImage = fillImage
  const opacity = parseOpacity(odfAttr(el, 'opacity'))
  if (opacity !== null) props.opacity = opacity
  const backgroundSize = odfAttr(el, 'background-size')
  if (backgroundSize) props.backgroundSize = backgroundSize
  return props
}

function emptyProps(): StyleProps {
  return {
    text: {},
    para: {},
    cell: {},
    column: {},
    row: {},
    table: {},
    graphic: {},
    drawingPage: {}
  }
}

const PROP_READERS: Record<string, (el: Element) => Partial<StyleProps>> = {
  'text-properties': (el) => ({ text: readTextProps(el) }),
  'paragraph-properties': (el) => ({ para: readParaProps(el) }),
  'table-properties': (el) => ({ table: readTableProps(el) }),
  'table-column-properties': (el) => ({ column: readColumnProps(el) }),
  'table-row-properties': (el) => ({ row: readRowProps(el) }),
  'table-cell-properties': (el) => ({ cell: readCellProps(el) }),
  'graphic-properties': (el) => ({ graphic: readGraphicProps(el) }),
  'drawing-page-properties': (el) => ({ drawingPage: readDrawingPageProps(el) })
}

function readStyleNode(el: Element, family: string): StyleNode {
  const props = emptyProps()
  for (const propertyEl of elementChildren(el)) {
    const reader = PROP_READERS[localNameOf(propertyEl)]
    if (!reader) continue
    const group = reader(propertyEl)
    for (const key of Object.keys(group) as Array<keyof StyleProps>) {
      Object.assign(props[key], group[key])
    }
  }
  return {
    name: odfAttr(el, 'name') ?? '',
    family,
    parent: odfAttr(el, 'parent-style-name'),
    props
  }
}

function mergeStyle(base: StyleNode | null, own: StyleNode): StyleNode {
  if (!base) return own
  const props = emptyProps()
  for (const key of Object.keys(props) as Array<keyof StyleProps>) {
    Object.assign(props[key], base.props[key], own.props[key])
  }
  return { ...own, props }
}

// ---------------------------------------------------------------------------
// 样式表
// ---------------------------------------------------------------------------

export interface OdfFontFace {
  /** style:name,供 style:font-name 引用 */
  name: string
  /** svg:font-family(可能带引号,也可能是一组字族) */
  family?: string
  generic?: string
  /** 内嵌字体在包内的路径;未内嵌为 undefined */
  file?: string
}

export class OdfStyles {
  private nodes = new Map<string, StyleNode>()
  private defaults = new Map<string, StyleNode>()
  private fontFaces = new Map<string, OdfFontFace>()
  private listStyles = new Map<string, ListStyleDef>()
  private pageLayouts = new Map<string, PageLayout>()
  private masterPages = new Map<string, { pageLayout: string | null; el: Element | null }>()

  constructor(documents: Array<Document | null>) {
    for (const doc of documents) {
      if (doc) this.scan(doc)
    }
  }

  private scan(doc: Document): void {
    const root = doc.documentElement
    // font-face-decls 可能在 content.xml 与 styles.xml 各有一份
    for (const decls of children(root, 'font-face-decls')) {
      for (const face of children(decls, 'font-face')) {
        const name = odfAttr(face, 'name')
        if (!name) continue
        const faceSrc = child(face, 'font-face-src')
        const uri = faceSrc ? child(faceSrc, 'font-face-uri') : null
        // content.xml 与 styles.xml 可能各声明一份同名 font-face(通常文件只在其中一份),
        // 后扫描的不能把已拿到的 FontFile 覆盖掉
        const previous = this.fontFaces.get(name)
        this.fontFaces.set(name, {
          name,
          family: odfAttr(face, 'font-family') ?? previous?.family,
          generic: odfAttr(face, 'font-family-generic') ?? previous?.generic,
          file: (uri ? odfAttr(uri, 'href') ?? undefined : undefined) ?? previous?.file
        })
      }
    }
    for (const container of children(root, 'automatic-styles')) this.scanStyleElements(container)
    for (const container of children(root, 'styles')) this.scanStyleElements(container)

    for (const layout of children(root, 'page-layout')) {
      const name = odfAttr(layout, 'name')
      if (name) this.pageLayouts.set(name, readPageLayout(layout))
    }
    for (const container of children(root, 'automatic-styles')) {
      for (const layout of children(container, 'page-layout')) {
        const name = odfAttr(layout, 'name')
        if (name) this.pageLayouts.set(name, readPageLayout(layout))
      }
    }
    for (const master of children(root, 'master-styles')) {
      for (const page of children(master, 'master-page')) {
        const name = odfAttr(page, 'name')
        if (name) this.masterPages.set(name, { pageLayout: odfAttr(page, 'page-layout-name'), el: page })
      }
    }
  }

  private scanStyleElements(container: Element): void {
    for (const el of children(container, 'style')) {
      const family = odfAttr(el, 'family')
      const name = odfAttr(el, 'name')
      if (!family || !name) continue
      this.nodes.set(`${family}:${name}`, readStyleNode(el, family))
    }
    for (const el of children(container, 'default-style')) {
      const family = odfAttr(el, 'family')
      if (!family) continue
      this.defaults.set(family, { ...readStyleNode(el, family), name: `__default_${family}` })
    }
    for (const el of children(container, 'list-style')) {
      const name = odfAttr(el, 'name')
      if (!name) continue
      this.listStyles.set(name, readListStyle(el))
    }
  }

  /** 按族 + 名称解析(带父样式与默认样式);不存在返回 null */
  resolve(name: string | null | undefined, family: string): StyleNode | null {
    if (!name) return null
    const own = this.nodes.get(`${family}:${name}`) ?? this.nodes.get(`${name}`)
    if (!own) return null
    const base = this.resolveBase(own, new Set([`${family}:${name}`]))
    return mergeStyle(base, own)
  }

  private resolveBase(node: StyleNode, seen: Set<string>): StyleNode | null {
    if (!node.parent) return this.defaults.get(node.family) ?? null
    const key = `${node.family}:${node.parent}`
    if (seen.has(key)) return this.defaults.get(node.family) ?? null
    seen.add(key)
    const parent = this.nodes.get(key) ?? this.nodes.get(node.parent)
    if (!parent) return this.defaults.get(node.family) ?? null
    return mergeStyle(this.resolveBase(parent, seen), parent)
  }

  defaultStyle(family: string): StyleNode | null {
    return this.defaults.get(family) ?? null
  }

  fontFace(name: string): OdfFontFace | null {
    return this.fontFaces.get(name) ?? null
  }

  /** 全部字体声明(内嵌字体生成 @font-face 用) */
  allFontFaces(): OdfFontFace[] {
    return [...this.fontFaces.values()]
  }

  listStyle(name: string | null | undefined): ListStyleDef | null {
    return name ? this.listStyles.get(name) ?? null : null
  }

  pageLayout(name: string | null | undefined): PageLayout | null {
    return name ? this.pageLayouts.get(name) ?? null : null
  }

  masterPage(name: string | null | undefined): { pageLayout: string | null; el: Element | null } | null {
    return name ? this.masterPages.get(name) ?? null : null
  }

  firstMasterPage(): { name: string; pageLayout: string | null; el: Element | null } | null {
    const first = this.masterPages.entries().next()
    if (first.done) return null
    const [name, value] = first.value
    return { name, ...value }
  }

  /** 文档默认文本样式(默认段落样式;没有则 A4/12pt 的通用默认) */
  defaultText(): { props: TextStyleProps; para: ParaStyleProps } {
    const node = this.defaults.get('paragraph') ?? this.defaults.get('text') ?? null
    return node ? { props: node.props.text, para: node.props.para } : { props: {}, para: {} }
  }
}

function readPageLayout(el: Element): PageLayout {
  const props = child(el, 'page-layout-properties')
  const width = parseLengthPt(props ? odfAttr(props, 'page-width') : null)
  const height = parseLengthPt(props ? odfAttr(props, 'page-height') : null)
  let widthMm = ((width !== null && width > 0 ? width : (210 * 72) / 25.4) * PT_TO_MM)
  let heightMm = ((height !== null && height > 0 ? height : (297 * 72) / 25.4) * PT_TO_MM)
  const orientation = props ? odfAttr(props, 'print-orientation') : null
  if (orientation === 'landscape' && widthMm < heightMm) [widthMm, heightMm] = [heightMm, widthMm]
  if (orientation === 'portrait' && widthMm > heightMm) [widthMm, heightMm] = [heightMm, widthMm]
  const allMargins = props ? parseLengthPt(odfAttr(props, 'margin')) : null
  const margin = (name: string, fallbackMm: number): number => {
    const value = props ? parseLengthPt(odfAttr(props, name)) : null
    if (value !== null) return value * PT_TO_MM
    return allMargins !== null ? allMargins * PT_TO_MM : fallbackMm
  }
  return {
    widthMm,
    heightMm,
    marginTopMm: margin('margin-top', 20),
    marginBottomMm: margin('margin-bottom', 20),
    marginLeftMm: margin('margin-left', 20),
    marginRightMm: margin('margin-right', 20)
  }
}

/** 常见 Symbol 字体私有区圆点(U+F0B7 等)在浏览器里没有字形,换成通用项目符号 */
function normalizeBullet(value: string): string {
  const text = value.trim()
  if (text === '') return '•'
  const code = text.codePointAt(0) ?? 0
  if (code >= 0xf000 && code <= 0xf0ff) return '•'
  return text
}

function readListStyle(el: Element): ListStyleDef {
  const levels = new Map<number, ListLevelStyle>()
  for (const levelEl of elementChildren(el)) {
    const name = localNameOf(levelEl)
    if (name !== 'list-level-style-bullet' && name !== 'list-level-style-number' && name !== 'list-level-style-image') {
      continue
    }
    const level = Number(odfAttr(levelEl, 'level') ?? '1')
    if (!Number.isFinite(level) || level < 1 || level > 10) continue
    if (name === 'list-level-style-bullet') {
      levels.set(level, {
        kind: 'bullet',
        bulletChar: normalizeBullet(odfAttr(levelEl, 'bullet-char') ?? '•')
      })
    } else if (name === 'list-level-style-number') {
      const start = Number(odfAttr(levelEl, 'start-value') ?? '1')
      levels.set(level, {
        kind: 'number',
        numFormat: odfAttr(levelEl, 'num-format') ?? '1',
        numPrefix: odfAttr(levelEl, 'num-prefix') ?? '',
        numSuffix: odfAttr(levelEl, 'num-suffix') ?? '',
        start: Number.isFinite(start) ? Math.trunc(start) : 1
      })
    } else {
      levels.set(level, { kind: 'none' })
    }
  }
  return { levels }
}

/** 解析文本属性 + 继承父样式,得到可直接写 CSS 的最终值 */
export function resolveTextStyle(
  props: TextStyleProps | null | undefined,
  parent: ResolvedTextStyle,
  styles?: OdfStyles
): ResolvedTextStyle {
  const out: ResolvedTextStyle = { ...parent }
  if (!props) return out

  let family = props.fontFamily
  let generic = props.fontGeneric
  if (family && styles) {
    const face = styles.fontFace(family)
    if (face) {
      family = face.family ?? family
      generic = generic ?? face.generic
    }
  }
  if (family) {
    const families = family
      .split(',')
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    const css = cssFontFamily(families, generic)
    if (css) out.familyCss = css
  }
  if (props.fontSize) {
    const size = parseLengthPt(props.fontSize, parent.sizePt)
    if (size !== null && size > 0) out.sizePt = size
  }
  if (props.bold !== undefined) out.bold = props.bold
  if (props.italic !== undefined) out.italic = props.italic
  if (props.underline !== undefined) out.underline = props.underline
  if (props.strike !== undefined) out.strike = props.strike
  if (props.color !== undefined) out.color = props.color
  if (props.background !== undefined) out.background = props.background
  if (props.superscript) out.verticalAlign = 'super'
  else if (props.subscript) out.verticalAlign = 'sub'
  if (props.letterSpacing) {
    const spacing = parseLengthPt(props.letterSpacing, out.sizePt)
    if (spacing !== null) out.letterSpacingPt = spacing
  }
  return out
}

/**
 * 文本样式 → 内联 CSS 片段(只输出已定义项)。
 * includeDecorations=false 用于段落/span 容器:text-decoration 会向子元素传播,
 * 子级的 none 无法撤销父级下划线;下划线/删除线因此只画在叶子文本 run 上。
 */
export function textStyleCss(style: ResolvedTextStyle, includeDecorations = true): string {
  const parts: string[] = []
  if (style.familyCss) parts.push(`font-family:${style.familyCss}`)
  parts.push(`font-size:${round(style.sizePt)}pt`)
  if (style.bold === true) parts.push('font-weight:bold')
  else if (style.bold === false) parts.push('font-weight:normal')
  if (style.italic === true) parts.push('font-style:italic')
  else if (style.italic === false) parts.push('font-style:normal')
  if (includeDecorations) {
    const decorations: string[] = []
    if (style.underline) decorations.push('underline')
    if (style.strike) decorations.push('line-through')
    if (decorations.length > 0) parts.push(`text-decoration:${decorations.join(' ')}`)
  }
  if (style.color) parts.push(`color:${style.color}`)
  if (style.background) parts.push(`background-color:${style.background}`)
  if (style.verticalAlign) parts.push(`vertical-align:${style.verticalAlign};font-size:70%`)
  if (style.letterSpacingPt !== undefined) parts.push(`letter-spacing:${round(style.letterSpacingPt)}pt`)
  return parts.join(';')
}

/** 段落样式 → 内联 CSS(不含文本属性;文本属性由 resolveTextStyle 处理) */
export function paraStyleCss(props: ParaStyleProps | null | undefined): string {
  if (!props) return ''
  const parts: string[] = []
  if (props.textAlign) {
    const align = props.textAlign.toLowerCase()
    const css = align === 'start' ? 'left' : align === 'end' ? 'right' : align === 'justify' ? 'justify' : align
    if (['left', 'center', 'right', 'justify'].includes(css)) parts.push(`text-align:${css}`)
  }
  if (props.marginLeft !== undefined) parts.push(`margin-left:${round(props.marginLeft)}pt`)
  if (props.marginRight !== undefined) parts.push(`margin-right:${round(props.marginRight)}pt`)
  if (props.textIndent !== undefined) parts.push(`text-indent:${round(props.textIndent)}pt`)
  if (props.marginTop !== undefined) parts.push(`margin-top:${round(props.marginTop)}pt`)
  if (props.marginBottom !== undefined) parts.push(`margin-bottom:${round(props.marginBottom)}pt`)
  if (props.padding !== undefined) parts.push(`padding:${round(props.padding)}pt`)
  if (props.lineHeight) {
    const text = props.lineHeight.trim()
    const pct = /^([\d.]+)%$/.exec(text)
    if (pct) parts.push(`line-height:${Number(pct[1]) / 100}`)
    else {
      const length = parseLengthPt(text)
      if (length !== null) parts.push(`line-height:${round(length)}pt`)
    }
  }
  if (props.background) parts.push(`background-color:${props.background}`)
  if (props.breakBefore) parts.push('break-before:page')
  if (props.breakAfter) parts.push('break-after:page')
  return parts.join(';')
}

export function cellStyleCss(props: CellStyleProps | null | undefined): string {
  if (!props) return ''
  const parts: string[] = []
  if (props.background) parts.push(`background-color:${props.background}`)
  if (props.borderTop) parts.push(`border-top:${props.borderTop}`)
  if (props.borderRight) parts.push(`border-right:${props.borderRight}`)
  if (props.borderBottom) parts.push(`border-bottom:${props.borderBottom}`)
  if (props.borderLeft) parts.push(`border-left:${props.borderLeft}`)
  if (props.padding !== undefined) parts.push(`padding:${round(props.padding)}pt`)
  if (props.paddingTop !== undefined) parts.push(`padding-top:${round(props.paddingTop)}pt`)
  if (props.paddingBottom !== undefined) parts.push(`padding-bottom:${round(props.paddingBottom)}pt`)
  if (props.paddingLeft !== undefined) parts.push(`padding-left:${round(props.paddingLeft)}pt`)
  if (props.paddingRight !== undefined) parts.push(`padding-right:${round(props.paddingRight)}pt`)
  if (props.verticalAlign) {
    const align = props.verticalAlign === 'middle' ? 'middle' : props.verticalAlign === 'bottom' ? 'bottom' : 'top'
    parts.push(`vertical-align:${align}`)
  }
  if (props.noWrap) parts.push('white-space:nowrap')
  return parts.join(';')
}

export function graphicStyleCss(props: GraphicStyleProps | null | undefined): string {
  if (!props) return ''
  const parts: string[] = []
  if (props.fill === 'solid' && props.fillColor) parts.push(`background-color:${props.fillColor}`)
  if (props.opacity !== undefined) parts.push(`opacity:${round(props.opacity)}`)
  if (props.stroke === 'solid' || props.stroke === 'dash') {
    const width = Math.max(props.strokeWidth ?? 0.75, 0.1)
    const style = props.stroke === 'dash' ? 'dashed' : 'solid'
    parts.push(`border:${round(width)}pt ${style} ${props.strokeColor ?? '#000000'}`)
  }
  if (props.padding !== undefined) parts.push(`padding:${round(props.padding)}pt`)
  return parts.join(';')
}

export { PT_TO_MM }
