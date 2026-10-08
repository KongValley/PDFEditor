/**
 * 页面朝向判定:扫描件里零星几页方向与其它页不一致(进纸歪斜)时,算出该转哪几页、转多少度。
 *
 * 两级判定:
 *  1) 页面方向 —— docState.pageBoxes 已按 /Rotate 交换过宽高,直接比宽高即可,无需渲染;
 *     多数页的方向就是基准方向。
 *  2) 内容朝向 —— 只对"方向与基准不同"的候选页做,避免误伤真正的横向页(宽表格、图纸):
 *     有文字层看文字基线角度(能精确算出 90 还是 270),纯图片扫描件退回墨迹投影。
 */
import { docState, getPage } from '../store/document'
import { getPageViewport, pdfjs } from './pdfjs'

export type PageOrientation = 'portrait' | 'landscape' | 'square'

export interface OrientationPlanItem {
  /** 1-based 页码 */
  page: number
  from: PageOrientation
  to: PageOrientation
  /** 0 = 本次不动 */
  delta: 90 | 180 | 270 | 0
  reason: 'text-sideways' | 'text-inverted' | 'page-only' | 'content-unknown'
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
  'content-unknown': '无法判定内容方向'
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

/** 墨迹投影:正立文字在行方向上起伏明显(score>2),横躺则列方向起伏更明显(score<0.5) */
async function contentUprightFromPixels(pageNumber: number): Promise<boolean | null> {
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
  const variance = (values: Float64Array): number => {
    let sum = 0
    for (const v of values) sum += v
    const mean = sum / values.length
    let acc = 0
    for (const v of values) acc += (v - mean) * (v - mean)
    return acc / values.length
  }
  const rowVar = variance(rows)
  const colVar = variance(cols)
  if (rowVar === 0 && colVar === 0) return null // 纯白页,没有可比内容
  const score = rowVar / Math.max(colVar, 1e-6)
  if (score > 2) return true
  if (score < 0.5) return false
  return null
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

/** 扫描整份文档,给出"该转哪几页、转多少度"的计划(不修改任何内容) */
export async function planPageOrientation(): Promise<OrientationPlanResult> {
  const orientations = docState.pageBoxes.map((box) => orientationOf(box.w, box.h))
  const base = pickBaseOrientation(orientations)
  if (base === null) {
    return { base: null, baseError: '横向页与纵向页数量相同,无法判定基准方向', items: [] }
  }
  const items: OrientationPlanItem[] = []
  for (let index = 0; index < orientations.length; index++) {
    const from = orientations[index]
    if (from === base || from === 'square') continue
    // 只分析候选页:整份文档都"方向不同"时也不会无谓地渲染全篇
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const posture = await detectContentPosture(index + 1)
    let delta: OrientationPlanItem['delta'] = 0
    let reason: OrientationPlanItem['reason'] = 'content-unknown'
    if (posture === 'sideways') {
      // 图片页分不出 90 / 270:默认 +90(使其显示方向与基准一致),预览里可逐页改
      delta = 90
      reason = 'text-sideways'
    } else if (posture === 'inverted') {
      delta = 180
      reason = 'text-inverted'
    } else if (posture === 'upright') {
      delta = 0
      reason = 'page-only'
    }
    items.push({ page: index + 1, from, to: base, delta, reason })
  }
  return { base, baseError: '', items }
}