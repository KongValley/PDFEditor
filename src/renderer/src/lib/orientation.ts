/**
 * 页面朝向判定:扫描件里零星几页方向与其它页不一致(进纸歪斜、进纸倒置)时,
 * 算出该转哪几页、转多少度。
 *
 * 两级判定:
 *  1) 页面方向 —— docState.pageBoxes 已按 /Rotate 交换过宽高,直接比宽高即可,无需渲染;
 *     多数页的方向就是基准方向。
 *  2) 内容朝向 —— 「方向与基准不同」的候选页,避免误伤真正的横向页(宽表格、图纸):
 *     有文字层看文字基线角度(能精确算出 90 还是 270),没有文字层先问 OCR(见 ocr.ts),
 *     再退回墨迹剖面。
 *     「方向与基准相同」的页:文字层角度给出 180(上下颠倒)或 90/270(内容相对页面横躺,
 *     转正后页面框随之翻转);没有文字层的图像页退回全篇剖面共识判 180,判出横躺则走同一段
 *     方向解析(OCR → 剖面共识 → 默认 +90,见 invertedPages / sidewaysDirection)。
 */
import { docState, getPage } from '../store/document'
import { getPageViewport, pdfjs } from './pdfjs'
import { consensusProfile, invertedPages, sidewaysDirection, type RowProfile } from './inkprofile'
import { detectOrientationByOcr, releaseOcrWorker } from './ocr'
import { logEvent } from './log'

export type PageOrientation = 'portrait' | 'landscape' | 'square'

export interface OrientationPlanItem {
  /** 1-based 页码 */
  page: number
  from: PageOrientation
  to: PageOrientation
  /** 0 = 本次不动 */
  delta: 90 | 180 | 270 | 0
  reason: 'text-sideways' | 'text-inverted' | 'page-only' | 'content-unknown' | 'ocr'
}

/** 近方形(长宽差 ≤2%)视为 square:不参与基准判定,也不作为候选页 */
const SQUARE_RATIO = 0.02

export function orientationOf(w: number, h: number): PageOrientation {
  const longest = Math.max(Math.abs(w), Math.abs(h))
  if (longest === 0) return 'square'
  if (Math.abs(w - h) <= longest * SQUARE_RATIO) return 'square'
  return w > h ? 'landscape' : 'portrait'
}

/** 基准方向 = 非 square 页的多数派;平票返回 null(调用方提示"无法判定",不做任何修改) */
export function pickBaseOrientation(orientations: PageOrientation[]): PageOrientation | null {
  let portrait = 0
  let landscape = 0
  for (const o of orientations) {
    if (o === 'portrait') portrait++
    else if (o === 'landscape') landscape++
  }
  if (portrait === landscape) return null
  return portrait > landscape ? 'portrait' : 'landscape'
}

const REASON_TEXT: Record<OrientationPlanItem['reason'], string> = {
  'text-sideways': '内容横躺',
  'text-inverted': '内容倒置',
  'page-only': '页面方向不同,内容与页面一致',
  'content-unknown': '无法判定内容方向',
  ocr: '按 OCR 识别的内容方向'
}

export function reasonText(reason: OrientationPlanItem['reason']): string {
  return REASON_TEXT[reason]
}

/* ------------------------- 内容朝向判定 ------------------------- */

/** 文字基线角度归一到 {0,90,180,270};容差 ±5°,不是整 90°(斜排/艺术字)返回 null */
function normalizeAngle(deg: number): 0 | 90 | 180 | 270 | null {
  const wrapped = ((Math.round(deg / 90) * 90) % 360 + 360) % 360
  const diff = Math.abs(((wrapped - deg + 540) % 360) - 180)
  if (diff > 5) return null
  return wrapped as 0 | 90 | 180 | 270
}

/**
 * 文字层角度 → 内容相对**显示方向**的姿态。
 * pdf.js 的 items[].transform 是未旋转的 PDF 用户空间,叠加 page.rotate 才是显示方向。
 */
async function contentAngleFromText(pageNumber: number): Promise<0 | 90 | 180 | 270 | null> {
  const page = await getPage(pageNumber)
  const content = await page.getTextContent()
  const tally = new Map<number, number>()
  for (const raw of content.items) {
    if (!('str' in raw) || !raw.str.trim()) continue
    const [a, b] = [raw.transform[0], raw.transform[1]]
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    const angle = normalizeAngle((Math.atan2(b, a) * 180) / Math.PI)
    if (angle === null) continue // 非正交文字不投票
    tally.set(angle, (tally.get(angle) ?? 0) + 1)
  }
  let best: 0 | 90 | 180 | 270 | null = null
  let bestCount = 0
  let total = 0
  for (const [angle, count] of tally) {
    total += count
    if (count > bestCount) {
      best = angle as 0 | 90 | 180 | 270
      bestCount = count
    }
  }
  // 至少两个条目才够定向(旋转后的文字常被切成很少的条目);
  // 票数占比过低说明方向混排(图表 + 正文),按不可用处理
  if (best === null || bestCount < 2 || bestCount / total < 0.6) return null
  return normalizeAngle(best + page.rotate)
}

/** 一页以小尺寸光栅化后的行/列墨迹量:方向判定用到的指标都从这一次取像里出 */
interface InkMap {
  rows: Float64Array
  cols: Float64Array
}

async function rasterizeInk(pageNumber: number): Promise<InkMap | null> {
  const page = await getPage(pageNumber)
  const { viewport } = getPageViewport(page, 1, docState.rotationView)
  const scale = Math.min(160 / Math.max(viewport.width, 1), 160 / Math.max(viewport.height, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width * scale))
  canvas.height = Math.max(1, Math.floor(viewport.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  try {
    await page.render({
      canvasContext: ctx,
      viewport: getPageViewport(page, scale, docState.rotationView).viewport,
      annotationMode: pdfjs.AnnotationMode.DISABLE
    }).promise
  } catch {
    return null
  }
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  } catch {
    return null
  }
  const rows = new Float64Array(canvas.height)
  const cols = new Float64Array(canvas.width)
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4
      // 亮度越低越可能是墨迹
      const dark = 255 - (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)
      if (dark < 40) continue
      rows[y] += dark
      cols[x] += dark
    }
  }
  return { rows, cols }
}

function variance(values: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i] ?? 0
  const mean = sum / values.length
  let acc = 0
  for (let i = 0; i < values.length; i++) {
    const diff = (values[i] ?? 0) - mean
    acc += diff * diff
  }
  return acc / values.length
}

/** 墨迹投影:正立文字在行方向上起伏明显(score>2),横躺则列方向起伏更明显(score<0.5) */
function uprightFromPixels(ink: InkMap): boolean | null {
  const rowVar = variance(ink.rows)
  const colVar = variance(ink.cols)
  if (rowVar === 0 && colVar === 0) return null // 纯白页,没有可比内容
  const score = rowVar / Math.max(colVar, 1e-6)
  if (score > 2) return true
  if (score < 0.5) return false
  return null
}

async function contentUprightFromPixels(pageNumber: number): Promise<boolean | null> {
  const ink = await rasterizeInk(pageNumber)
  return ink ? uprightFromPixels(ink) : null
}

/** 某一页的内容相对当前显示方向:正立 / 横躺 / 倒置 / 无法判定 */
export type ContentPosture = 'upright' | 'sideways' | 'inverted' | 'unknown'

export async function detectContentPosture(pageNumber: number): Promise<ContentPosture> {
  const angle = await contentAngleFromText(pageNumber).catch(() => null)
  if (angle !== null) {
    if (angle === 0) return 'upright'
    if (angle === 180) return 'inverted'
    return 'sideways'
  }
  const upright = await contentUprightFromPixels(pageNumber).catch(() => null)
  if (upright === true) return 'upright'
  if (upright === false) return 'sideways'
  return 'unknown'
}

/* --------------------------- 计划生成 --------------------------- */

export interface OrientationPlanResult {
  base: PageOrientation | null
  /** base 为 null 时的说明(非空则 items 必为空) */
  baseError: string
  items: OrientationPlanItem[]
}

/** 文字层角度 → 让内容在显示方向上正立所需的旋转(90 是顺时针) */
function deltaFromAngle(angle: 0 | 90 | 180 | 270): OrientationPlanItem['delta'] {
  if (angle === 0) return 0
  if (angle === 180) return 180
  // 文字基线转了 angle,回转 angle 才正立:90° 的内容要顺时针 270°,270° 的反之
  return angle === 90 ? 270 : 90
}

/** OCR 方向的置信度下限:低于它一律当没识别出来(误判会白转一整页) */
const OCR_MIN_CONFIDENCE = 10

/** 让 OCR 判一页的方向:没识别出来或置信不足(又不是"不用转")时返回 null */
async function ocrDelta(page: number): Promise<OrientationPlanItem['delta'] | null> {
  const result = await detectOrientationByOcr(page).catch((err: unknown) => {
    logEvent('warn', 'ocr', '识别失败', { page, error: err instanceof Error ? err.message : String(err) })
    return null
  })
  if (!result) return null
  if (result.delta !== 0 && result.confidence < OCR_MIN_CONFIDENCE) return null
  return result.delta
}

/** 扫描整份文档,给出"该转哪几页、转多少度"的计划(不修改任何内容) */
export async function planPageOrientation(): Promise<OrientationPlanResult> {
  const started = Date.now()
  const orientations = docState.pageBoxes.map((box) => orientationOf(box.w, box.h))
  const base = pickBaseOrientation(orientations)
  if (base === null) {
    return { base: null, baseError: '横向页与纵向页数量相同,无法判定基准方向', items: [] }
  }
  const items: OrientationPlanItem[] = []
  /** 基准方向的反向:内容横躺的页转 90/270 后页面框必然翻转 */
  const flipped: PageOrientation = base === 'portrait' ? 'landscape' : 'portrait'
  /** 没有文字层的候选页:第一遍只取像,**方向留给第二遍的 OCR**(OCR 不行才退回墨迹剖面) */
  const inkCandidates: Array<{
    page: number
    from: PageOrientation
    upright: boolean | null
    columns: Float64Array | null
  }> = []
  /** 没有文字层的基准页:第二遍用全篇剖面共识判上下颠倒,并判内容是否相对页面横躺 */
  const inkBasePages: number[] = []
  for (let index = 0; index < orientations.length; index++) {
    const page = index + 1
    const from = orientations[index]
    if (from === 'square') continue
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const angle = await contentAngleFromText(page).catch(() => null)
    if (from === base) {
      // 页面框已经对了:内容上下颠倒(180)或横躺(90/270)都需要处理(后者的页面框会随之翻转)
      if (angle === 180) {
        items.push({ page, from, to: base, delta: 180, reason: 'text-inverted' })
      } else if (angle === 90 || angle === 270) {
        items.push({
          page,
          from,
          to: flipped,
          delta: deltaFromAngle(angle),
          reason: 'text-sideways'
        })
      } else if (angle === null) {
        inkBasePages.push(page)
      }
      continue
    }
    // 页面框与基准不同:内容真的横躺才转,内容本来就正立(宽表格)则不动
    if (angle !== null) {
      const reason = angle === 0 ? 'page-only' : angle === 180 ? 'text-inverted' : 'text-sideways'
      items.push({ page, from, to: base, delta: deltaFromAngle(angle), reason })
      continue
    }
    const ink = await rasterizeInk(page)
    inkCandidates.push({
      page,
      from,
      upright: ink ? uprightFromPixels(ink) : null,
      columns: ink ? ink.cols : null
    })
  }

  if (inkCandidates.length > 0 || inkBasePages.length > 0) {
    try {
      // 基准页的行墨迹剖面共识:既是"内容被上下颠倒"的参照,也是 OCR 不可用时的方向退路
      // (同一份文档的多数页版式一致;版式千差万别或页面太少时相关度上不去,自然判不出、不乱转)
      // ponytail: 逐页小图取像 ≈ 每页一次 160px 渲染;版式混杂时共识失效 → 由 OCR 兜底
      const profiles: RowProfile[] = []
      /** 基准页的取像结果:同一张图既出剖面共识,也判内容是否相对页面横躺 */
      const baseInk = new Map<number, InkMap>()
      const basePending = new Set(inkBasePages)
      for (let index = 0; index < orientations.length; index++) {
        if (orientations[index] !== base) continue
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const ink = await rasterizeInk(index + 1)
        if (!ink) continue
        profiles.push({ page: index + 1, rows: ink.rows })
        if (basePending.has(index + 1)) baseInk.set(index + 1, ink)
      }
      const reference = consensusProfile(profiles)
      if (reference) {
        for (const page of invertedPages(profiles)) {
          items.push({ page, from: base, to: base, delta: 180, reason: 'text-inverted' })
        }
      }
      for (const page of inkBasePages) {
        const ink = baseInk.get(page)
        const upright = ink ? uprightFromPixels(ink) : null
        if (upright === false) {
          // 页面框是基准向、内容却横躺:转 90/270 会连带翻转页面框。
          // OCR 只在"也判横躺"时才可用 —— 合成图案/无正文页常返回 0°,那是"没读出来"而不是"正立"
          const fromOcr = await ocrDelta(page)
          const delta =
            fromOcr === 90 || fromOcr === 270 ? fromOcr : ink ? sidewaysDirection(profiles, ink.cols) || 90 : 90
          items.push({ page, from: base, to: flipped, delta, reason: 'text-sideways' })
          continue
        }
        // 内容相对页面正立(或判不出):有剖面共识时倒置已由 invertedPages 产出,不再多问;
        // 没有共识才逐页问 OCR —— 接受 90/270,横躺页与倒置页同样要处理
        if (reference) continue
        const delta = await ocrDelta(page)
        if (delta === null || delta === 0) continue
        items.push({
          page,
          from: base,
          to: delta === 180 ? base : flipped,
          delta,
          reason: 'ocr'
        })
      }
      for (const candidate of inkCandidates) {
        const delta = await ocrDelta(candidate.page)
        if (delta !== null) {
          items.push({
            page: candidate.page,
            from: candidate.from,
            to: base,
            delta,
            reason: delta === 0 ? 'page-only' : 'ocr'
          })
          continue
        }
        // OCR 不可用:退回墨迹投影(判竖直→不动;判横躺→剖面共识给方向,再不行按默认 +90)
        const columns = candidate.upright === false ? candidate.columns : null
        const direction = columns && reference ? sidewaysDirection(profiles, columns) : 0
        items.push({
          page: candidate.page,
          from: candidate.from,
          to: base,
          delta: columns ? direction || 90 : 0,
          reason: columns ? 'text-sideways' : candidate.upright === true ? 'page-only' : 'content-unknown'
        })
      }
    } finally {
      // 识别用完就把 worker 还回去(它带着几十 MB wasm 堆,不该常驻整个会话)
      await releaseOcrWorker()
    }
  }
  items.sort((a, b) => a.page - b.page)
  logEvent('info', 'orient', '分析完成', {
    pages: orientations.length,
    candidates: items.length,
    applied: items.filter((item) => item.delta !== 0).length,
    ms: Date.now() - started
  })
  return { base, baseError: '', items }
}