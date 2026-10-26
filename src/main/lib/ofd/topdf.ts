/**
 * OFD → PDF(矢量文字 + 图片 + 路径)。
 *
 * 目标:让 OFD 文档进入应用现有能力(批注/页面操作/搜索/打印/导出),因此产物必须是真 PDF,
 * 而不是把页面画成位图 —— 文字保留为可检索、可批注的真实文本。
 *
 * 坐标约定(规范 8.1.3/8.1.4):OFD 页面空间与对象空间都是毫米、原点左上、Y 向下;
 * PDF 用户空间是 pt、原点左下、Y 向上。所有换算都集中在 toPdfX/toPdfY 两处。
 *
 * 已知不保真(均在 warnings 里说明,不静默丢内容):
 *  - 文字描边(TextObject Stroke)、裁剪区(Clips)、渐变/底纹/图案、颜色空间与调色板;
 *  - Even-Odd 填充规则(pdf-lib 只支持非零绕数);
 *  - 未内嵌且本机缺失的字体 → 用替代字体或跳过不可编码字符;
 *  - BMP/TIFF/JBIG2 图片资源(只嵌 PNG/JPEG)。
 */
import { readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts, degrees, rgb, type Color, type PDFFont, type PDFImage, type PDFPage, type PDFPageDrawTextOptions } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { findCjkFontFile, savePdf } from '../pdflibwrite'
import {
  parseOfdPackage,
  type OfdBox,
  type OfdColor,
  type OfdFontRes,
  type OfdImageObject,
  type OfdMatrix,
  type OfdObject,
  type OfdPackage,
  type OfdPage,
  type OfdPathObject,
  type OfdTemplateRef,
  type OfdTextObject
} from './model'
import { readZipEntries } from './zip'

/** 毫米 → pt(1mm = 72/25.4pt) */
const MM_TO_PT = 72 / 25.4
/** TextCode 的占位符:文字不可提取时用它占位,直接绘制会得到满页「¤」 */
const PLACEHOLDER_RE = /\u00A4/g

export interface OfdConvertOptions {
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export type OfdConvertResult =
  | { ok: true; bytes: Uint8Array; pages: number; warnings: string[] }
  | { ok: false; error: string; warnings: string[] }

/**
 * 把整个 OFD 解包到内存再转换:峰值 ≈ 包体 + 嵌入后的 PDF(图片会二次驻留)。
 * 发票/公文这类几 MB 的 OFD 毫无压力;几百 MB 的扫描件型 OFD 会吃紧 ——
 * 真要支持时改为按条目流式读取(读一个图片条目→立刻 embed→释放),而不是先建整张 Map。
 */
export async function convertOfdToPdf(buffer: Uint8Array, options: OfdConvertOptions = {}): Promise<OfdConvertResult> {
  const warnings: string[] = []
  let pkg: OfdPackage
  let zip: Map<string, Uint8Array>
  try {
    zip = readZipEntries(buffer)
    pkg = parseOfdPackage(zip, warnings)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message.startsWith('无法解析 OFD') ? message : `无法解析 OFD:${message}`, warnings }
  }

  try {
    const bytes = await render(pkg, zip, warnings, options)
    return { ok: true, bytes, pages: pkg.pages.length, warnings }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'canceled') return { ok: false, error: 'canceled', warnings }
    return { ok: false, error: `OFD 转换失败:${message}`, warnings }
  }
}

/** 拉丁字体名的识别顺序在 CJK 之前:否则「Charset 缺省=unicode」会把 Courier New 也送去 CJK 字体 */
const LATIN_MONO_RE = /courier|mono|consol|menlo|monaco/i
const LATIN_SERIF_RE = /times|serif|georgia|garamond|book\b/i
const CJK_NAME_RE = /simsun|simhei|kaiti|fangsong|yahei|song|hei|kai|ming|宋|黑|楷|仿|雅黑|中易/i

function isCjkFont(res: OfdFontRes | undefined): boolean {
  if (!res) return false
  const name = `${res.fontName} ${res.familyName}`
  if (LATIN_MONO_RE.test(name) || LATIN_SERIF_RE.test(name)) return false
  return CJK_NAME_RE.test(name) || /[\u3400-\u9fff]/.test(name) || /^(prc|big5)$/i.test(res.charset)
}

function pickStandardFont(res: OfdFontRes | undefined): StandardFonts {
  const name = `${res?.fontName ?? ''} ${res?.familyName ?? ''}`
  if (LATIN_MONO_RE.test(name)) return StandardFonts.Courier
  if (LATIN_SERIF_RE.test(name)) return StandardFonts.TimesRoman
  return StandardFonts.Helvetica
}

/** 图片字节头判定(不复用 images.ts:mimeOf —— 那个模块顶层 import electron) */
function imageKind(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  return null
}

function toRgb(color: OfdColor): Color {
  return rgb(color.r, color.g, color.b)
}

/** 路径/SVG 里的数字:定点 3 位,避免 1e-7 这类指数写法被路径解析器拒收 */
function fmt(n: number): string {
  const rounded = Math.round(n * 1000) / 1000
  return Number.isFinite(rounded) ? String(rounded) : '0'
}

/** 对象空间点 → 页面空间(mm):先过 CTM,再按 Boundary 平移 */
function mapPoint(ctm: OfdMatrix | null, x: number, y: number): [number, number] {
  if (!ctm) return [x, y]
  return [ctm.a * x + ctm.c * y + ctm.e, ctm.b * x + ctm.d * y + ctm.f]
}

async function render(
  pkg: OfdPackage,
  zip: Map<string, Uint8Array>,
  warnings: string[],
  options: OfdConvertOptions
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)

  const fontCache = new Map<string, PDFFont | null>()
  const standardCache = new Map<StandardFonts, PDFFont>()
  let cjkFont: PDFFont | null = null
  let cjkTried = false
  let skippedChars = 0
  let placeholders = 0
  let warnedDash = false
  let warnedRule = false
  let warnedDelta = false
  let warnedTextStroke = false
  let warnedFill = false
  let emptyAnnots = 0

  const standardFont = async (name: StandardFonts): Promise<PDFFont> => {
    const cached = standardCache.get(name)
    if (cached) return cached
    const font = await doc.embedFont(name)
    standardCache.set(name, font)
    return font
  }

  /** 中文字体只嵌一次:整包共用同一份(OFD 里常见「宋体/黑体」多 ID 指向同一族) */
  const loadCjkFont = async (): Promise<PDFFont | null> => {
    if (cjkTried) return cjkFont
    cjkTried = true
    const path = findCjkFontFile()
    if (!path) return null
    try {
      cjkFont = await doc.embedFont(readFileSync(path), { subset: true })
      // 一个字形都不用会让 fontkit 的 CFF 子集编码在 nextTick 抛错(见 pdflibwrite.ts:198-204)
      await cjkFont.encodeText(' ')
    } catch (err) {
      warnings.push(`中文字体嵌入失败:${(err as Error).message}`)
      cjkFont = null
    }
    return cjkFont
  }

  const fontFor = async (fontId: string): Promise<PDFFont | null> => {
    const cached = fontCache.get(fontId)
    if (cached !== undefined) return cached
    const res = pkg.fonts.get(fontId)
    let font: PDFFont | null = null
    if (res?.fontFile) {
      const bytes = zip.get(res.fontFile)
      if (bytes) {
        try {
          font = await doc.embedFont(bytes, { subset: true })
          await font.encodeText(' ')
        } catch (err) {
          warnings.push(`内嵌字体嵌入失败(${res.fontName || fontId}):${(err as Error).message}`)
          font = null
        }
      } else {
        warnings.push(`内嵌字体文件缺失(${res.fontFile}),已用替代字体`)
      }
    }
    if (!font) {
      font = isCjkFont(res) ? await loadCjkFont() : await standardFont(pickStandardFont(res))
    }
    fontCache.set(fontId, font)
    return font
  }

  const imageCache = new Map<string, PDFImage | null>()

  const drawText = (page: PDFPage, text: string, textOptions: PDFPageDrawTextOptions): void => {
    try {
      page.drawText(text, textOptions)
      return
    } catch {
      // 标准字体编码不了的字形:过滤到 WinAnsi 可编码范围后重试,仍失败则跳过并计数
    }
    const filtered = text.replace(/[^\x20-\x7e\u00a0-\u00ff]/g, '')
    skippedChars += text.length - filtered.length
    if (!filtered) return
    try {
      page.drawText(filtered, textOptions)
    } catch {
      skippedChars += filtered.length
    }
  }

  const drawTextObject = async (page: PDFPage, pageH: number, object: OfdTextObject): Promise<void> => {
    if (object.stroke && !warnedTextStroke) {
      warnedTextStroke = true
      warnings.push('文字描边未实现(已按无描边绘制)')
    }
    const font = await fontFor(object.fontId)
    if (!font) {
      skippedChars += object.codes.reduce((sum, code) => sum + code.text.replace(PLACEHOLDER_RE, '').length, 0)
      return
    }
    const sizePt = object.size * MM_TO_PT
    const color = object.fillColor ?? { r: 0, g: 0, b: 0, alpha: 1 }
    const baseX = object.boundary.x
    const baseY = object.boundary.y
    const rotate = degrees(-object.charDirection)

    for (const code of object.codes) {
      if (code.deltaInvalid && !warnedDelta) {
        warnedDelta = true
        warnings.push('字间距数据无法解析,已按字体自然步进排布')
      }
      const text = code.text.replace(PLACEHOLDER_RE, '')
      placeholders += code.text.length - text.length
      if (!text) continue
      const startX = code.x ?? 0
      const startY = code.y ?? 0
      const simple = object.readDirection === 0 && object.charDirection === 0 && !code.deltaX && !code.deltaY
      if (simple) {
        const [px, py] = mapPoint(object.ctm, startX, startY)
        drawText(page, text, {
          x: (baseX + px) * MM_TO_PT,
          y: pageH - (baseY + py) * MM_TO_PT,
          size: sizePt,
          font,
          color: toRgb(color),
          opacity: color.alpha * object.opacity
        })
        continue
      }
      // 逐字型定位:DeltaX/DeltaY 是「后一字型相对前一字型」的偏移(规范表 46);
      // 缺失时用字体自然步进。阅读方向决定推进轴,字符方向决定每个字型自身的旋转。
      const glyphs = [...text]
      let cursorX = startX
      let cursorY = startY
      const vertical = object.readDirection % 180 !== 0
      for (let i = 0; i < glyphs.length; i++) {
        const [px, py] = mapPoint(object.ctm, cursorX, cursorY)
        drawText(page, glyphs[i], {
          x: (baseX + px) * MM_TO_PT,
          y: pageH - (baseY + py) * MM_TO_PT,
          size: sizePt,
          font,
          color: toRgb(color),
          opacity: color.alpha * object.opacity,
          rotate
        })
        const deltaX = code.deltaX?.[i]
        const deltaY = code.deltaY?.[i]
        const natural = font.widthOfTextAtSize(glyphs[i], sizePt) / MM_TO_PT
        const advance = (vertical ? (deltaY ?? natural) : (deltaX ?? natural)) * object.hScale
        if (vertical) {
          cursorY += object.readDirection === 90 ? advance : -advance
          cursorX += deltaX !== undefined ? deltaX * object.hScale : 0
        } else {
          cursorX += object.readDirection === 0 ? advance : -advance
          cursorY += deltaY !== undefined ? deltaY * object.hScale : 0
        }
      }
    }
  }

  const drawPathObject = (page: PDFPage, pageH: number, object: OfdPathObject): void => {
    if (object.rule === 'Even-Odd' && !warnedRule) {
      warnedRule = true
      warnings.push('填充规则 Even-Odd 已按非零绕数处理')
    }
    // 渐变/底纹/图案填充在模型里拿不到颜色(只有 CT_Color 的 Value),这类图形会整块消失:
    // 必须告警,否则用户看到的是「某些线条/色块不见了」而没有任何解释
    if (object.fill && !object.fillColor && !object.stroke && !warnedFill) {
      warnedFill = true
      warnings.push('渐变/图案填充不支持,部分图形未绘制')
    }
    // 路径坐标保持 OFD 页面空间(y 向下、mm→pt),由 pdf-lib 内部的 scale(1,-1) 完成翻转,
    // 因此这里传 x=0 / y=pageH 且绝不传 scale 选项。
    const parts: string[] = []
    let cursor: [number, number] = [0, 0]
    for (const command of object.commands) {
      const args = command.args
      switch (command.op) {
        case 'M': {
          cursor = [args[0], args[1]]
          const [px, py] = mapPoint(object.ctm, cursor[0], cursor[1])
          parts.push(`M ${fmt((object.boundary.x + px) * MM_TO_PT)} ${fmt((object.boundary.y + py) * MM_TO_PT)}`)
          break
        }
        case 'L': {
          cursor = [args[0], args[1]]
          const [px, py] = mapPoint(object.ctm, cursor[0], cursor[1])
          parts.push(`L ${fmt((object.boundary.x + px) * MM_TO_PT)} ${fmt((object.boundary.y + py) * MM_TO_PT)}`)
          break
        }
        case 'Q': {
          // 二次 → 三次贝塞尔(精确等价),避免依赖路径解析器对 Q 的支持差异
          const [x1, y1, x2, y2] = args
          const [p0x, p0y] = mapPoint(object.ctm, cursor[0], cursor[1])
          const [c1x, c1y] = mapPoint(object.ctm, cursor[0] + (2 / 3) * (x1 - cursor[0]), cursor[1] + (2 / 3) * (y1 - cursor[1]))
          const [c2x, c2y] = mapPoint(object.ctm, x2 + (2 / 3) * (x1 - x2), y2 + (2 / 3) * (y1 - y2))
          const [p1x, p1y] = mapPoint(object.ctm, x2, y2)
          cursor = [x2, y2]
          parts.push(
            `C ${fmt((object.boundary.x + c1x) * MM_TO_PT)} ${fmt((object.boundary.y + c1y) * MM_TO_PT)}` +
              ` ${fmt((object.boundary.x + c2x) * MM_TO_PT)} ${fmt((object.boundary.y + c2y) * MM_TO_PT)}` +
              ` ${fmt((object.boundary.x + p1x) * MM_TO_PT)} ${fmt((object.boundary.y + p1y) * MM_TO_PT)}`
          )
          break
        }
        case 'B': {
          const [x1, y1, x2, y2, x3, y3] = args
          const [c1x, c1y] = mapPoint(object.ctm, x1, y1)
          const [c2x, c2y] = mapPoint(object.ctm, x2, y2)
          const [p1x, p1y] = mapPoint(object.ctm, x3, y3)
          cursor = [x3, y3]
          parts.push(
            `C ${fmt((object.boundary.x + c1x) * MM_TO_PT)} ${fmt((object.boundary.y + c1y) * MM_TO_PT)}` +
              ` ${fmt((object.boundary.x + c2x) * MM_TO_PT)} ${fmt((object.boundary.y + c2y) * MM_TO_PT)}` +
              ` ${fmt((object.boundary.x + p1x) * MM_TO_PT)} ${fmt((object.boundary.y + p1y) * MM_TO_PT)}`
          )
          break
        }
        case 'A': {
          const [rx, ry, angle, large, sweep, x, y] = args
          const [px, py] = mapPoint(object.ctm, x, y)
          cursor = [x, y]
          parts.push(
            `A ${fmt(rx * MM_TO_PT)} ${fmt(ry * MM_TO_PT)} ${fmt(angle)} ${large ? 1 : 0} ${sweep ? 1 : 0}` +
              ` ${fmt((object.boundary.x + px) * MM_TO_PT)} ${fmt((object.boundary.y + py) * MM_TO_PT)}`
          )
          break
        }
        case 'C':
          parts.push('Z')
          break
      }
    }
    if (parts.length === 0) return
    const lineWidthPt = object.lineWidth * MM_TO_PT
    page.drawSvgPath(parts.join(' '), {
      x: 0,
      y: pageH,
      ...(object.fill && object.fillColor ? { color: toRgb(object.fillColor), opacity: object.fillColor.alpha * object.opacity } : {}),
      ...(object.stroke && lineWidthPt > 0
        ? {
            borderColor: toRgb(object.strokeColor),
            borderWidth: lineWidthPt,
            borderOpacity: object.strokeColor.alpha * object.opacity,
            ...(object.dashPattern.length > 0
              ? { borderDashArray: object.dashPattern.map((n) => n * MM_TO_PT), borderDashPhase: object.dashOffset * MM_TO_PT }
              : {})
          }
        : {})
    })
  }

  const drawImageObject = async (page: PDFPage, pageH: number, object: OfdImageObject): Promise<void> => {
    const res = pkg.images.get(object.resourceId)
    if (!res) {
      warnings.push(`图片资源缺失(ResourceID=${object.resourceId})`)
      return
    }
    if (!imageCache.has(object.resourceId)) {
      const bytes = zip.get(res.path)
      const kind = bytes ? imageKind(bytes) : null
      if (!bytes) {
        warnings.push(`图片文件缺失(${res.path})`)
        imageCache.set(object.resourceId, null)
      } else if (kind === 'png') {
        imageCache.set(object.resourceId, await doc.embedPng(bytes))
      } else if (kind === 'jpeg') {
        imageCache.set(object.resourceId, await doc.embedJpg(bytes))
      } else {
        warnings.push(`不支持的图片格式:${res.format || '未知'}(${res.path})`)
        imageCache.set(object.resourceId, null)
      }
    }
    const image = imageCache.get(object.resourceId)
    if (!image) return
    // Boundary 已是页面空间外接矩形(规范 10.1),按它铺满;CTM 对图像只是等价缩放,忽略
    page.drawImage(image, {
      x: object.boundary.x * MM_TO_PT,
      y: pageH - (object.boundary.y + object.boundary.h) * MM_TO_PT,
      width: object.boundary.w * MM_TO_PT,
      height: object.boundary.h * MM_TO_PT,
      opacity: object.opacity
    })
  }

  /** 逐对象容错:单个图元画不出来(畸形路径、缺资源、pdf-lib 拒绝)不能让整篇转换失败 */
  const drawObjects = async (page: PDFPage, pageH: number, objects: OfdObject[]): Promise<void> => {
    for (const object of objects) {
      try {
        if (object.kind === 'text') await drawTextObject(page, pageH, object)
        else if (object.kind === 'path') drawPathObject(page, pageH, object)
        else await drawImageObject(page, pageH, object)
      } catch (err) {
        warnings.push(`图元绘制失败,已跳过(${object.kind} ${object.id}):${(err as Error).message}`)
      }
    }
  }

  const drawPage = async (page: PDFPage, content: OfdPage): Promise<void> => {
    const pageH = content.box.h * MM_TO_PT
    const templates = content.templates
      .map((ref) => ({ ref, page: pkg.templatePages.get(ref.id) }))
      .filter((item): item is { ref: OfdTemplateRef; page: OfdPage } => !!item.page)
    for (const item of templates.filter((t) => t.ref.zOrder === 'Background')) {
      for (const layer of item.page.layers) await drawObjects(page, pageH, layer.objects)
    }
    for (const layer of content.layers) await drawObjects(page, pageH, layer.objects)
    for (const item of templates.filter((t) => t.ref.zOrder === 'Foreground')) {
      for (const layer of item.page.layers) await drawObjects(page, pageH, layer.objects)
    }
    // 注释(签章/水印等)在页面内容之后绘制,与阅读器一致
    for (const annot of content.annots) {
      if (!annot.visible) continue
      if (annot.emptyAppearance) {
        emptyAnnots++
        continue
      }
      await drawObjects(page, pageH, annot.objects)
    }
  }

  const total = pkg.pages.length
  for (let index = 0; index < total; index++) {
    if (options.signal?.aborted) throw new Error('canceled')
    const content = pkg.pages[index]
    const page = doc.addPage([content.box.w * MM_TO_PT, content.box.h * MM_TO_PT])
    await drawPage(page, content)
    options.onProgress?.(index + 1, total)
  }

  if (skippedChars > 0) warnings.push(`缺少中文字体,已跳过 ${skippedChars} 个字符`)
  if (placeholders > 0) warnings.push(`已跳过 ${placeholders} 个占位字符(源文件未提供文字内容)`)
  if (emptyAnnots > 0) {
    warnings.push(`有 ${emptyAnnots} 个签章/注释只含签名引用、没有可绘制的呈现内容,已跳过(签章验签不在本应用范围内)`)
  }
  return savePdf(doc)
}

/** 供单测/诊断:暴露坐标换算常量,避免测试里重复写 2.8346… */
export const MM_PER_PT = 25.4 / 72

/** 供外部复用:OFD 物理盒 → PDF 页尺寸(pt) */
export function pageSizePt(box: OfdBox): [number, number] {
  return [box.w * MM_TO_PT, box.h * MM_TO_PT]
}
