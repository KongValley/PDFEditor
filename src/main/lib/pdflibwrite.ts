import { existsSync, readFileSync } from 'node:fs'
import {
  BlendMode,
  LineCapStyle,
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFOptionList,
  PDFRadioGroup,
  PDFString,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
  type PDFField,
  type PDFFont,
  type PDFImage,
  type PDFObject,
  type PDFPage,
  type PDFRef
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { Annotation, FormValue, Rect } from '@shared/types'
import { fitFontSize, pointsToMm, wrapText } from '@shared/text'

/**
 * 可嵌入的中文字体。**只列 TTF**:pdf-lib 无法直接嵌入 TTC 集合(Win8+ 的微软雅黑是 msyh.ttc)。
 * Win7 的雅黑是单文件 msyh.ttf,Win10 必然带 simhei.ttf,因此不必为 TTC 引入解包复杂度。
 */
const CJK_FONT_CANDIDATES = [
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simkai.ttf',
  'C:/Windows/Fonts/msyh.ttf'
]

/** 自产批注的外观流外扩(避免描边/量子化在边缘被裁掉) */
const ANNOT_PAD = 3

export interface WriteResult {
  bytes: Buffer
  warnings: string[]
}

export interface WriteOptions {
  annotations: Annotation[]
  formValues: Record<string, FormValue>
  resolveImage: (imgId: string, refPath: string) => Promise<Buffer | undefined>
}

/** 批注外观绘制上下文(字体 + 图片解析 + 警告收集) */
export interface AnnotWriteContext {
  font: PDFFont
  resolveImage: (imgId: string, refPath: string) => Promise<Buffer | undefined>
  warnings: string[]
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '')
  const int = Number.parseInt(value.length === 3 ? value.replace(/./g, (c) => c + c) : value, 16)
  return {
    r: ((int >> 16) & 255) / 255,
    g: ((int >> 8) & 255) / 255,
    b: (int & 255) / 255
  }
}

/** 探测本机第一个存在的中文字体(环境自检用;只判存在,不读盘) */
export function findCjkFontFile(): string | null {
  // 冒烟/单测钩子:置 'none' 强制走「缺中文字体」路径(此前只能靠手工改名系统字体复现)
  if (process.env['PDF_EDITOR_SMOKE_CJK_FONT'] === 'none') return null
  // 显式指定字体:无 SimHei 的机器(CI runner、精简系统)用它指到任意 TTF/OTF
  const override = process.env['PDF_EDITOR_CJK_FONT']
  if (override) {
    try {
      if (existsSync(override)) return override
    } catch {
      // 路径不可访问:继续走候选列表
    }
  }
  for (const path of CJK_FONT_CANDIDATES) {
    try {
      if (existsSync(path)) return path
    } catch {
      // 无权限访问字体目录:跳过,继续下一个候选
    }
  }
  return null
}

/**
 * 读取中文字体字节(约 10MB)。
 * 字节做模块级缓存:批量拆分/连续保存/逐块导出时,重复读盘(每次 10MB)成本
 * 远高于常驻 10MB(进程退出即释放)。
 */
let cachedFontBytes: Buffer | null = null

function loadCjkFontBytes(): Buffer | null {
  if (cachedFontBytes) return cachedFontBytes
  const path = findCjkFontFile()
  if (!path) return null
  try {
    cachedFontBytes = readFileSync(path)
  } catch {
    // 读不到就当没有字体:退回 Helvetica,写中文时由 drawTextSafe 给出可读提示
  }
  return cachedFontBytes
}

/**
 * 该批注集是否需要中文字体:**只有真会写出文字的批注才需要**(图形类、便签不需要)。
 * 便签只画图标矩形(文字进 /Contents,不经过字体);文本注释为空时也一个字形都画不出来。
 * 为什么必须排除它们:嵌入了 CJK 字体却一个字形都没用到时,fontkit 的 CFF 子集编码会抛
 * RangeError("value" argument is out of bounds) —— 而且它抛在字体编码的异步回调里,
 * 逃出保存的 promise 链(guard 捕不到),表现为「保存永远没有回音」
 * (实测半个字符都没画的便签保存 + Noto Sans SC / Source Han Sans OTF 必现)。
 */
export function needsCjkFont(annotations: Annotation[]): boolean {
  for (const ann of annotations) {
    // 图章与测量总会写出标签文字
    if (ann.kind === 'stamp' || ann.kind === 'measure') return true
    if (ann.kind === 'text' && ann.text.trim() !== '') return true
  }
  return false
}

async function embedCjkFont(doc: PDFDocument, warnings: string[]): Promise<PDFFont | null> {
  const bytes = loadCjkFontBytes()
  if (!bytes) {
    warnings.push('未找到可嵌入的中文字体(已尝试 SimHei/楷体/雅黑),含中文的文字注释与图章将无法保存')
    return null
  }
  try {
    return await doc.embedFont(bytes, { subset: true })
  } catch (err) {
    warnings.push(`中文字体嵌入失败:${(err as Error).message}`)
    return null
  }
}

/** 准备批注外观绘制上下文:嵌入中文字体(失败退 Helvetica);skipCjkFont=true 时只嵌 Helvetica(图形批注够用) */
export async function createAnnotContext(
  doc: PDFDocument,
  resolveImage: WriteOptions['resolveImage'],
  warnings: string[],
  options: { skipCjkFont?: boolean } = {}
): Promise<{ ctx: AnnotWriteContext; cjkFont: PDFFont | null }> {
  doc.registerFontkit(fontkit)
  const cjkFont = options.skipCjkFont ? null : await embedCjkFont(doc, warnings)
  const font = cjkFont ?? (await doc.embedFont(StandardFonts.Helvetica))
  return { ctx: { font, resolveImage, warnings }, cjkFont }
}

/**
 * 缺可嵌入中文字体。与"这条批注画不出来"的一般失败区别对待:继续保存会把用户的中文
 * 批注/图章**静默丢掉**(只在控制台留一条 warning),必须让整次保存失败并给出可读原因。
 */
class MissingCjkFontError extends Error {}

/**
 * 缺中文字体时退回的是 StandardFonts.Helvetica(WinAnsi 编码),遇到中文会抛
 * "WinAnsi cannot encode ..."。抛出点不止 page.drawText:pdf-lib 的 widthOfTextAtSize
 * (换行测量、fitFontSize)同样先做编码,所以守卫包住整段绘制。
 * 非编码异常原样抛出,不掩盖其他问题;纯 ASCII 内容不触发,行为与从前一致。
 */
function withCjkFont<T>(draw: () => T): T {
  try {
    return draw()
  } catch (err) {
    const message = (err as Error).message
    if (!/cannot encode/i.test(message)) throw err
    throw new MissingCjkFontError(
      `系统缺少可嵌入的中文字体(SimHei/黑体),无法写入中文内容;请安装该字体后重试(原始错误:${message})`
    )
  }
}

function drawTextBlock(
  page: PDFPage,
  bbox: Rect,
  text: string,
  fontSize: number,
  font: PDFFont,
  color: { r: number; g: number; b: number },
  opacity: number,
  rotate: number
): void {
  withCjkFont(() => {
    const lines = wrapText(text, Math.max(bbox.w, 8), (s) => font.widthOfTextAtSize(s, fontSize))
    const lineHeight = fontSize * 1.2
    lines.forEach((line, index) => {
      if (line === '') return
      page.drawText(line, {
        x: bbox.x,
        y: bbox.y + bbox.h - fontSize - index * lineHeight,
        size: fontSize,
        font,
        color: rgb(color.r, color.g, color.b),
        opacity,
        rotate: degrees(rotate)
      })
    })
  })
}

function drawStamp(page: PDFPage, ann: Annotation & { kind: 'stamp' }, font: PDFFont): void {
  withCjkFont(() => {
    const color = hexToRgb(ann.color)
    const box = ann.bbox
    page.drawRectangle({
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      borderColor: rgb(color.r, color.g, color.b),
      borderWidth: 2,
      borderOpacity: ann.opacity,
      color: rgb(color.r, color.g, color.b),
      opacity: 0.08,
      rotate: degrees(0)
    })
    const fontSize = fitFontSize(ann.label, box, (s, size) => font.widthOfTextAtSize(s, size))
    const width = font.widthOfTextAtSize(ann.label, fontSize)
    page.drawText(ann.label, {
      x: box.x + (box.w - width) / 2,
      y: box.y + box.h / 2 - fontSize * 0.35,
      size: fontSize,
      font,
      color: rgb(color.r, color.g, color.b),
      opacity: ann.opacity,
      rotate: degrees(ann.rotate)
    })
  })
}

/** 绘制原语:把一条注释画到给定页面上(真实批注路径里画到 scratch 页再嵌入外观流) */
async function drawAnnotation(
  doc: PDFDocument,
  page: PDFPage,
  ann: Annotation,
  ctx: AnnotWriteContext
): Promise<void> {
  const color = hexToRgb(ann.color)
  const box = ann.bbox
  const paint = rgb(color.r, color.g, color.b)

  switch (ann.kind) {
    case 'highlight':
      page.drawRectangle({
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        color: paint,
        opacity: ann.opacity,
        blendMode: BlendMode.Multiply
      })
      return
    case 'rect':
      page.drawRectangle({
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        borderColor: paint,
        borderWidth: ann.thickness,
        borderOpacity: ann.opacity
      })
      return
    case 'ellipse':
      page.drawEllipse({
        x: box.x + box.w / 2,
        y: box.y + box.h / 2,
        xScale: box.w / 2,
        yScale: box.h / 2,
        borderColor: paint,
        borderWidth: ann.thickness,
        borderOpacity: ann.opacity
      })
      return
    case 'ink': {
      for (let i = 1; i < ann.points.length; i++) {
        page.drawLine({
          start: ann.points[i - 1],
          end: ann.points[i],
          thickness: ann.thickness,
          color: paint,
          opacity: ann.opacity,
          lineCap: LineCapStyle.Round
        })
      }
      return
    }
    case 'arrow': {
      page.drawLine({
        start: ann.from,
        end: ann.to,
        thickness: ann.thickness,
        color: paint,
        opacity: ann.opacity,
        lineCap: LineCapStyle.Round
      })
      const dx = ann.to.x - ann.from.x
      const dy = ann.to.y - ann.from.y
      const length = Math.hypot(dx, dy) || 1
      const wing = Math.max(4, length * 0.14)
      const angle = Math.atan2(dy, dx)
      const spread = 0.45
      for (const sign of [1, -1]) {
        page.drawLine({
          start: ann.to,
          end: {
            x: ann.to.x - wing * Math.cos(angle - sign * spread),
            y: ann.to.y - wing * Math.sin(angle - sign * spread)
          },
          thickness: ann.thickness,
          color: paint,
          opacity: ann.opacity,
          lineCap: LineCapStyle.Round
        })
      }
      return
    }
    case 'measure': {
      page.drawLine({
        start: ann.from,
        end: ann.to,
        thickness: ann.thickness,
        color: paint,
        opacity: ann.opacity
      })
      const lengthPt = Math.hypot(ann.to.x - ann.from.x, ann.to.y - ann.from.y)
      const label = `${pointsToMm(lengthPt).toFixed(1)} mm`
      page.drawText(label, {
        x: (ann.from.x + ann.to.x) / 2,
        y: (ann.from.y + ann.to.y) / 2 + 4,
        size: 10,
        font: ctx.font,
        color: paint,
        opacity: ann.opacity
      })
      return
    }
    case 'text':
      drawTextBlock(page, box, ann.text, ann.fontSize, ctx.font, color, ann.opacity, ann.rotate)
      return
    case 'note': {
      page.drawRectangle({
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        color: paint,
        opacity: ann.opacity,
        borderColor: rgb(0.54, 0.43, 0.1),
        borderWidth: 1
      })
      return
    }
    case 'image': {
      const buffer = await ctx.resolveImage(ann.imgId, ann.refPath)
      if (!buffer) {
        ctx.warnings.push(`图片注释丢失(找不到文件:${ann.refPath})`)
        return
      }
      let image: PDFImage
      if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) image = await doc.embedPng(buffer)
      else if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) image = await doc.embedJpg(buffer)
      else {
        ctx.warnings.push(`不支持的图片格式:${ann.refPath}`)
        return
      }
      page.drawImage(image, {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        opacity: ann.opacity
      })
      return
    }
    case 'stamp':
      drawStamp(page, ann, ctx.font)
      return
  }
}

/* ------------------------------ 真实批注对象 ------------------------------ */

/** 平移一条注释(全部 kind:矩形族改 bbox;ink 改 points;arrow/measure 改 from/to) */
function shiftForScratch(ann: Annotation, dx: number, dy: number): Annotation {
  const bbox = { x: ann.bbox.x + dx, y: ann.bbox.y + dy, w: ann.bbox.w, h: ann.bbox.h }
  switch (ann.kind) {
    case 'ink':
      return { ...ann, bbox, points: ann.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
    case 'arrow':
    case 'measure':
      return {
        ...ann,
        bbox,
        from: { x: ann.from.x + dx, y: ann.from.y + dy },
        to: { x: ann.to.x + dx, y: ann.to.y + dy }
      }
    default:
      return { ...ann, bbox }
  }
}

/**
 * 该注释画得出外观吗?空文本注释一个字形都画不出来 —— 临时页没有 Contents,
 * pdf-lib 的 embedPage 会抛 "Can't embed page with missing Contents"(在 save() 里),
 * 让整次保存失败。这类注释不写 /AP 即可(本来也没有可显示的内容)。
 */
function hasDrawableAppearance(ann: Annotation): boolean {
  return ann.kind !== 'text' || ann.text.trim() !== ''
}

/** 把注释画到临时页并嵌入为 Form XObject 作为 /AP /N;返回其引用 */
async function buildAppearance(
  doc: PDFDocument,
  ann: Annotation,
  ctx: AnnotWriteContext
): Promise<PDFRef | null> {
  const w = Math.max(ann.bbox.w, 1) + ANNOT_PAD * 2
  const h = Math.max(ann.bbox.h, 1) + ANNOT_PAD * 2
  const scratch = doc.addPage([w, h])
  await drawAnnotation(doc, scratch, shiftForScratch(ann, ANNOT_PAD - ann.bbox.x, ANNOT_PAD - ann.bbox.y), ctx)
  // embedPage 拷贝内容/资源为独立对象,scratch 页删除后引用仍有效(pdf-lib 保存时清理残留)
  const embedded = await doc.embedPage(scratch, { left: 0, bottom: 0, right: w, top: h })
  doc.removePage(doc.getPageCount() - 1)
  return embedded.ref
}

/** 构造批注字典(公共字段 + 按 kind 追加) */
function buildAnnotDict(doc: PDFDocument, ann: Annotation, ctx: AnnotWriteContext, apRef: PDFRef | null): PDFDict {
  const { r, g, b } = hexToRgb(ann.color)
  const x1 = ann.bbox.x - ANNOT_PAD
  const y1 = ann.bbox.y - ANNOT_PAD
  const x2 = ann.bbox.x + ann.bbox.w + ANNOT_PAD
  const y2 = ann.bbox.y + ann.bbox.h + ANNOT_PAD

  const dict = PDFDict.withContext(doc.context)
  dict.set(PDFName.of('Type'), PDFName.of('Annot'))
  dict.set(PDFName.of('F'), PDFNumber.of(4))
  dict.set(PDFName.of('Rect'), doc.context.obj([x1, y1, x2, y2]))
  dict.set(PDFName.of('NM'), PDFHexString.fromText(ann.id))
  dict.set(PDFName.of('PdEditorData'), PDFHexString.of(Buffer.from(JSON.stringify(ann), 'utf8').toString('hex')))
  dict.set(PDFName.of('CA'), PDFNumber.of(ann.opacity))
  dict.set(PDFName.of('C'), doc.context.obj([r, g, b]))
  if (apRef) dict.set(PDFName.of('AP'), doc.context.obj({ N: apRef }))

  const setBorderWidth = (width: number): void => {
    dict.set(PDFName.of('BS'), doc.context.obj({ W: width }))
  }

  switch (ann.kind) {
    case 'highlight':
      dict.set(PDFName.of('Subtype'), PDFName.of('Highlight'))
      dict.set(PDFName.of('QuadPoints'), doc.context.obj([x1, y2, x2, y2, x1, y1, x2, y1]))
      break
    case 'rect':
      dict.set(PDFName.of('Subtype'), PDFName.of('Square'))
      setBorderWidth(ann.thickness)
      break
    case 'ellipse':
      dict.set(PDFName.of('Subtype'), PDFName.of('Circle'))
      setBorderWidth(ann.thickness)
      break
    case 'ink': {
      dict.set(PDFName.of('Subtype'), PDFName.of('Ink'))
      const flat: number[] = []
      for (const point of ann.points) flat.push(point.x, point.y)
      dict.set(PDFName.of('InkList'), doc.context.obj([flat]))
      setBorderWidth(ann.thickness)
      break
    }
    case 'arrow':
      dict.set(PDFName.of('Subtype'), PDFName.of('Line'))
      dict.set(PDFName.of('L'), doc.context.obj([ann.from.x, ann.from.y, ann.to.x, ann.to.y]))
      dict.set(PDFName.of('LE'), doc.context.obj(['None', 'ClosedArrow']))
      setBorderWidth(ann.thickness)
      break
    case 'measure':
      dict.set(PDFName.of('Subtype'), PDFName.of('Line'))
      dict.set(PDFName.of('L'), doc.context.obj([ann.from.x, ann.from.y, ann.to.x, ann.to.y]))
      dict.set(PDFName.of('LE'), doc.context.obj(['None', 'None']))
      setBorderWidth(ann.thickness)
      break
    case 'text':
      dict.set(PDFName.of('Subtype'), PDFName.of('FreeText'))
      dict.set(PDFName.of('DA'), PDFString.of('/Helv 12 Tf 0 g'))
      dict.set(PDFName.of('DR'), doc.context.obj({ Font: { Helv: ctx.font.ref } }))
      dict.set(PDFName.of('Q'), PDFNumber.of(0))
      break
    case 'note':
      dict.set(PDFName.of('Subtype'), PDFName.of('Text'))
      dict.set(PDFName.of('Name'), PDFName.of('Note'))
      // 用户文本必须用 PDFHexString(UTF-16BE+BOM)写入:PDFString.of 不转义,
      // 中文码位低位含 ')' / '\' 时会截断字符串,导致整个批注对象无法解析
      dict.set(PDFName.of('Contents'), PDFHexString.fromText(ann.text || ''))
      break
    case 'stamp':
      dict.set(PDFName.of('Subtype'), PDFName.of('Stamp'))
      dict.set(PDFName.of('Name'), PDFName.of('Approved'))
      break
    case 'image':
      dict.set(PDFName.of('Subtype'), PDFName.of('Stamp'))
      break
  }
  return dict
}

/**
 * 重建本应用写入的批注:先剥离每页全部带 /PdEditorData 的条目(外来批注/表单 Widget/链接保留),
 * 再按 mapPage 映射全量重建 → 保存任意次不重复、删除即消失。
 */
export async function replaceOwnAnnotations(
  doc: PDFDocument,
  annotations: Annotation[],
  mapPage: (page: number) => number | null,
  ctx: AnnotWriteContext
): Promise<void> {
  const pages = doc.getPages()
  for (const page of pages) {
    const annots = page.node.Annots()
    if (!annots) continue
    const keep: PDFObject[] = []
    for (const item of annots.asArray()) {
      const dict = doc.context.lookup(item)
      if (dict instanceof PDFDict && dict.get(PDFName.of('PdEditorData'))) continue
      keep.push(item)
    }
    if (keep.length === 0) {
      page.node.delete(PDFName.of('Annots'))
    } else if (keep.length !== annots.size()) {
      const next = PDFArray.withContext(doc.context)
      for (const item of keep) next.push(item)
      page.node.set(PDFName.of('Annots'), next)
    }
  }

  for (const ann of annotations) {
    const index = mapPage(ann.page)
    if (index === null) continue
    const page = pages[index]
    if (!page) {
      ctx.warnings.push(`注释所在页不存在(第 ${ann.page + 1} 页)`)
      continue
    }
    try {
      const apRef = hasDrawableAppearance(ann) ? await buildAppearance(doc, ann, ctx) : null
      const dict = buildAnnotDict(doc, ann, ctx, apRef)
      let annots = page.node.Annots()
      if (!annots) {
        annots = PDFArray.withContext(doc.context)
        page.node.set(PDFName.of('Annots'), annots)
      }
      annots.push(doc.context.register(dict))
    } catch (err) {
      // 缺中文字体:整次失败(否则用户的中文批注被静默丢弃),由上层给出可读提示
      if (err instanceof MissingCjkFontError) throw err
      ctx.warnings.push(`注释写入失败(${ann.kind}):${(err as Error).message}`)
    }
  }
}

/** 剥离全部批注(含表单 Widget/外来批注):导出「纯净页面」用 */
export function stripAllAnnotations(doc: PDFDocument): void {
  for (const page of doc.getPages()) page.node.delete(PDFName.of('Annots'))
}

/**
 * 收集页面上的表单字段引用:从每个 Widget 沿 /Parent 上溯到顶层字段字典。
 * Widget 本身可能是字段(无 /Parent),也可能挂在 /Kids 之下。
 */
function collectAcroFormFieldRefs(doc: PDFDocument): PDFRef[] {
  const refs: PDFRef[] = []
  const seen = new Set<string>()
  const asDict = (object: PDFObject | undefined): PDFDict | undefined => {
    const resolved = object ? doc.context.lookup(object) : undefined
    return resolved instanceof PDFDict ? resolved : undefined
  }
  const parentKey = PDFName.of('Parent')
  for (const page of doc.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    for (const item of annots.asArray()) {
      const widget = asDict(item)
      if (!widget || widget.get(PDFName.of('Subtype'))?.toString() !== '/Widget') continue
      let field = widget
      for (let depth = 0; depth < 32; depth++) {
        const parent = asDict(field.get(parentKey))
        if (!parent) break
        field = parent
      }
      if (!field.has(PDFName.of('FT')) && !field.has(PDFName.of('Kids'))) continue
      const ref = doc.context.getObjectRef(field)
      if (!ref) continue
      const key = ref.toString()
      if (seen.has(key)) continue
      seen.add(key)
      refs.push(ref)
    }
  }
  return refs
}

/**
 * 重建 /AcroForm:copyPages 只复制页面对象,字段定义挂在文档级 AcroForm 上会一起丢失,
 * 导致提取/导出/拆分/合并产物里的控件成为孤儿(可显示但无法写回)。
 * 已有的字段保留并追加新字段;目标文档没有 AcroForm 时,用源文档的非 /Fields 条目
 * (/DA、/DR 等)经 PDFObjectCopier 复制后新建。
 * 注:跨页字段只复制到被复制页的子项时,/Kids 可能仍引用未复制页的 Widget(孤立对象,不影响填写)。
 */
export function mergeAcroForm(target: PDFDocument, source: PDFDocument | null): void {
  const fieldRefs = collectAcroFormFieldRefs(target)
  if (fieldRefs.length === 0) return
  const existingObj = target.catalog.get(PDFName.of('AcroForm'))
  const existing = existingObj ? target.context.lookup(existingObj) : undefined
  if (existing instanceof PDFDict) {
    const fieldsObj = existing.get(PDFName.of('Fields'))
    const fields = fieldsObj ? target.context.lookup(fieldsObj) : undefined
    if (fields instanceof PDFArray) {
      const known = new Set(fields.asArray().map((ref) => ref.toString()))
      for (const ref of fieldRefs) if (!known.has(ref.toString())) fields.push(ref)
      return
    }
    existing.set(PDFName.of('Fields'), target.context.obj(fieldRefs))
    return
  }

  const sourceFormObj = source?.catalog.get(PDFName.of('AcroForm'))
  const sourceForm = sourceFormObj && source ? source.context.lookup(sourceFormObj) : undefined
  const fresh = PDFDict.withContext(target.context)
  if (sourceForm instanceof PDFDict && source) {
    const copier = PDFObjectCopier.for(source.context, target.context)
    for (const key of sourceForm.keys()) {
      if (key.asString() === '/Fields') continue
      const value = sourceForm.get(key)
      if (value) fresh.set(key, copier.copy(value))
    }
  }
  fresh.set(PDFName.of('Fields'), target.context.obj(fieldRefs))
  target.catalog.set(PDFName.of('AcroForm'), target.context.register(fresh))
}

/** 从 PDF 提取本应用写入的批注(按 /PdEditorData 解析;page 以所在页覆盖) */
export function extractEditorAnnotations(doc: PDFDocument): Annotation[] {
  const out: Annotation[] = []
  const pages = doc.getPages()
  for (let index = 0; index < pages.length; index++) {
    const annots = pages[index].node.Annots()
    if (!annots) continue
    for (const item of annots.asArray()) {
      const dict = doc.context.lookup(item)
      if (!(dict instanceof PDFDict)) continue
      const dataObj = dict.get(PDFName.of('PdEditorData'))
      if (!dataObj) continue
      const raw = doc.context.lookup(dataObj)
      if (!(raw instanceof PDFHexString)) continue
      try {
        const parsed = JSON.parse(Buffer.from(raw.asString(), 'hex').toString('utf8')) as Annotation
        if (typeof parsed.id !== 'string' || typeof parsed.kind !== 'string') continue
        parsed.page = index
        out.push(parsed)
      } catch {
        // 单条解析失败跳过,不影响其它批注
      }
    }
  }
  return out
}

/* ------------------------------ 表单 ------------------------------ */

function setFieldValue(field: PDFField, value: FormValue, warnings: string[]): void {
  if (field instanceof PDFTextField) field.setText(String(value))
  else if (field instanceof PDFCheckBox) {
    if (value === true || value === 'true') field.check()
    else field.uncheck()
  } else if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) {
    if (typeof value !== 'string') {
      warnings.push(`表单字段值类型不符:${field.getName()}`)
      return
    }
    field.select(value)
  }
}

function applyFormValues(
  doc: PDFDocument,
  values: Record<string, FormValue>,
  cjkFont: PDFFont | null,
  warnings: string[]
): void {
  const entries = Object.entries(values)
  if (entries.length === 0) return
  let form
  try {
    form = doc.getForm()
  } catch (err) {
    warnings.push(`表单读取失败:${(err as Error).message}`)
    return
  }
  const fields = form.getFields()
  if (fields.length === 0) return

  for (const [name, value] of entries) {
    let field = fields.find((f) => f.getName() === name)
    if (!field) {
      // 层级字段名兜底:后缀唯一匹配
      const matches = fields.filter((f) => f.getName().endsWith(`.${name}`))
      if (matches.length === 1) field = matches[0]
    }
    if (!field) {
      warnings.push(`表单字段未找到:${name}`)
      continue
    }
    try {
      setFieldValue(field, value, warnings)
    } catch (err) {
      warnings.push(`表单字段写入失败(${name}):${(err as Error).message}`)
    }
  }

  try {
    form.updateFieldAppearances(cjkFont ?? undefined)
  } catch (err) {
    warnings.push(`表单外观更新失败:${(err as Error).message}`)
  }
}

/** 将注释(真实批注对象)与表单值写入 PDF 副本,返回新的文件字节 */
export async function writeAnnotations(buffer: Buffer, options: WriteOptions): Promise<WriteResult> {
  const warnings: string[] = []
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true })
  // 图形批注 + 无表单值时跳过 9.75MB 中文字体的读盘/解析/子集嵌入
  const skipCjk = !needsCjkFont(options.annotations) && Object.keys(options.formValues).length === 0
  const { ctx, cjkFont } = await createAnnotContext(doc, options.resolveImage, warnings, { skipCjkFont: skipCjk })
  await replaceOwnAnnotations(doc, options.annotations, (page) => page, ctx)
  applyFormValues(doc, options.formValues, cjkFont, warnings)

  const bytes = await doc.save({ useObjectStreams: false })
  return { bytes: Buffer.from(bytes), warnings }
}
