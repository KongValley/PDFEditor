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

/** 可嵌入的中文字体(仅 TTF;TTC 集合无法被 pdf-lib 直接嵌入) */
const CJK_FONT_CANDIDATES = ['C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simkai.ttf']

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

/**
 * 读取中文字体字节(约 10MB)。
 * 不做模块级缓存:低内存机器上常驻 10MB 不划算,保存是低频操作,按需读盘即可。
 */
function loadCjkFontBytes(): Buffer | null {
  for (const path of CJK_FONT_CANDIDATES) {
    try {
      if (!existsSync(path)) continue
      return readFileSync(path)
    } catch {
      // 继续尝试下一个候选字体
    }
  }
  return null
}

async function embedCjkFont(doc: PDFDocument, warnings: string[]): Promise<PDFFont | null> {
  const bytes = loadCjkFontBytes()
  if (!bytes) {
    warnings.push('未找到中文字体(simhei.ttf),文字注释中的中文可能无法正确显示')
    return null
  }
  try {
    return await doc.embedFont(bytes, { subset: true })
  } catch (err) {
    warnings.push(`中文字体嵌入失败:${(err as Error).message}`)
    return null
  }
}

/** 准备批注外观绘制上下文:嵌入中文字体(失败退 Helvetica) */
export async function createAnnotContext(
  doc: PDFDocument,
  resolveImage: WriteOptions['resolveImage'],
  warnings: string[]
): Promise<{ ctx: AnnotWriteContext; cjkFont: PDFFont | null }> {
  doc.registerFontkit(fontkit)
  const cjkFont = await embedCjkFont(doc, warnings)
  const font = cjkFont ?? (await doc.embedFont(StandardFonts.Helvetica))
  return { ctx: { font, resolveImage, warnings }, cjkFont }
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
}

function drawStamp(page: PDFPage, ann: Annotation & { kind: 'stamp' }, font: PDFFont): void {
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
  dict.set(PDFName.of('NM'), PDFString.of(ann.id))
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
      dict.set(PDFName.of('Contents'), PDFString.of(ann.text || ''))
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
  for (const page of doc.getPages()) {
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

  const pages = doc.getPages()
  for (const ann of annotations) {
    const index = mapPage(ann.page)
    if (index === null) continue
    const page = pages[index]
    if (!page) {
      ctx.warnings.push(`注释所在页不存在(第 ${ann.page + 1} 页)`)
      continue
    }
    try {
      const apRef = await buildAppearance(doc, ann, ctx)
      const dict = buildAnnotDict(doc, ann, ctx, apRef)
      let annots = page.node.Annots()
      if (!annots) {
        annots = PDFArray.withContext(doc.context)
        page.node.set(PDFName.of('Annots'), annots)
      }
      annots.push(doc.context.register(dict))
    } catch (err) {
      ctx.warnings.push(`注释写入失败(${ann.kind}):${(err as Error).message}`)
    }
  }
}

/** 剥离全部批注(含表单 Widget/外来批注):导出「纯净页面」用 */
export function stripAllAnnotations(doc: PDFDocument): void {
  for (const page of doc.getPages()) page.node.delete(PDFName.of('Annots'))
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
  const { ctx, cjkFont } = await createAnnotContext(doc, options.resolveImage, warnings)
  await replaceOwnAnnotations(doc, options.annotations, (page) => page, ctx)
  applyFormValues(doc, options.formValues, cjkFont, warnings)

  const bytes = await doc.save({ useObjectStreams: false })
  return { bytes: Buffer.from(bytes), warnings }
}
