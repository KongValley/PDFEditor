import { existsSync, readFileSync } from 'node:fs'
import {
  BlendMode,
  LineCapStyle,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
  type PDFField,
  type PDFFont,
  type PDFImage,
  type PDFPage
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { Annotation, FormValue, Rect } from '@shared/types'
import { fitFontSize, pointsToMm, wrapText } from '@shared/text'

/** 可嵌入的中文字体(仅 TTF;TTC 集合无法被 pdf-lib 直接嵌入) */
const CJK_FONT_CANDIDATES = ['C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simkai.ttf']

export interface WriteResult {
  bytes: Buffer
  warnings: string[]
}

export interface WriteOptions {
  annotations: Annotation[]
  formValues: Record<string, FormValue>
  resolveImage: (imgId: string, refPath: string) => Promise<Buffer | undefined>
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

async function drawAnnotation(
  doc: PDFDocument,
  page: PDFPage,
  ann: Annotation,
  ctx: { font: PDFFont; resolveImage: WriteOptions['resolveImage']; warnings: string[] }
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

function setFieldValue(field: PDFField, value: FormValue): void {
  if (field instanceof PDFTextField) field.setText(String(value))
  else if (field instanceof PDFCheckBox) {
    if (value === true || value === 'true') field.check()
    else field.uncheck()
  } else if (field instanceof PDFRadioGroup) field.select(String(value))
  else if (field instanceof PDFDropdown) field.select(String(value))
  else if (field instanceof PDFOptionList) field.select(String(value))
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
      setFieldValue(field, value)
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

/** 将注释与表单值写入 PDF 副本,返回新的文件字节 */
export async function writeAnnotations(buffer: Buffer, options: WriteOptions): Promise<WriteResult> {
  const warnings: string[] = []
  const doc = await PDFDocument.load(buffer)
  doc.registerFontkit(fontkit)

  const cjkFont = await embedCjkFont(doc, warnings)
  const font = cjkFont ?? (await doc.embedFont(StandardFonts.Helvetica))

  const pages = doc.getPages()
  for (const ann of options.annotations) {
    const page = pages[ann.page]
    if (!page) {
      warnings.push(`注释所在页不存在(第 ${ann.page + 1} 页)`)
      continue
    }
    try {
      await drawAnnotation(doc, page, ann, { font, resolveImage: options.resolveImage, warnings })
    } catch (err) {
      warnings.push(`注释写入失败(${ann.kind}):${(err as Error).message}`)
    }
  }

  applyFormValues(doc, options.formValues, cjkFont, warnings)

  const bytes = await doc.save({ useObjectStreams: false })
  return { bytes: Buffer.from(bytes), warnings }
}
