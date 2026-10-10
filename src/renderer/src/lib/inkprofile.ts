/**
 * 页面「行墨迹剖面」的纯计算:把一页的墨迹分布变成可比较的数值。
 * 取像(光栅化)留在 orientation.ts,这里只做数学,便于单测。
 */

/** 剖面重采样后的固定长度:同一方向的页面像素行数也会差几行,逐行比较前必须先对齐 */
export const PROFILE_BINS = 128

export interface RowProfile {
  /** 1-based 页码 */
  page: number
  /** 逐行墨迹量(越暗越大) */
  rows: ArrayLike<number>
}

export interface InversionOptions {
  /** 低于此墨迹占比(均值/峰值)视为空白页,不参与比较 */
  minInk?: number
  /** 翻转后的相关必须领先这么多才判倒置;误判会白转一整页,宁可漏判 */
  margin?: number
  /** 翻转后的相关至少要有这么高(噪声级相关不足为凭) */
  minCorrelation?: number
  /** 至少几页可比才给结论:两页之间谈不上"共识" */
  minSamples?: number
}

const DEFAULTS = { minInk: 0.02, margin: 0.1, minCorrelation: 0.05, minSamples: 3 }

/** 墨迹占比 = 行均值/行峰值;只有零星噪点的空白页接近 0 */
export function inkShare(rows: ArrayLike<number>): number {
  let max = 0
  let sum = 0
  for (let i = 0; i < rows.length; i++) {
    const value = rows[i] ?? 0
    if (value > max) max = value
    sum += value
  }
  return max > 0 ? sum / rows.length / max : 0
}

/** 重采样到 bins 段(段内取均值)再 z 归一化(去均值、除标准差),使不同页面的剖面可比 */
export function normalizeProfile(rows: ArrayLike<number>, bins = PROFILE_BINS): number[] {
  const length = rows.length
  const out: number[] = []
  for (let i = 0; i < bins; i++) {
    const from = Math.floor((i * length) / bins)
    const to = Math.max(from + 1, Math.floor(((i + 1) * length) / bins))
    let sum = 0
    for (let j = from; j < to && j < length; j++) sum += rows[j] ?? 0
    out.push(sum / (to - from))
  }
  let sum = 0
  for (const value of out) sum += value
  const mean = sum / out.length
  let acc = 0
  for (const value of out) acc += (value - mean) * (value - mean)
  const std = Math.sqrt(acc / out.length) || 1
  return out.map((value) => (value - mean) / std)
}

/** 皮尔逊相关系数;任一侧没有起伏时返回 0(无从比较) */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < n; i++) {
    meanA += a[i]!
    meanB += b[i]!
  }
  meanA /= n
  meanB /= n
  let dot = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]! - meanA
    const y = b[i]! - meanB
    dot += x * y
    varA += x * x
    varB += y * y
  }
  const denominator = Math.sqrt(varA * varB)
  return denominator > 0 ? dot / denominator : 0
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * 全部可比页面的共识剖面(逐行取中位数);可比页不足 minSamples 时返回 null。
 * 同一份文档的多数页版式一致,共识剖面就是"这些页正立时该有的样子"。
 */
export function consensusProfile(profiles: RowProfile[], options: InversionOptions = {}): number[] | null {
  const { minInk, minSamples } = { ...DEFAULTS, ...options }
  const usable = profiles.filter((profile) => inkShare(profile.rows) >= minInk)
  if (usable.length < minSamples) return null
  const normalized = usable.map((profile) => normalizeProfile(profile.rows))
  return normalized[0]!.map((_, index) => median(normalized.map((z) => z[index]!)))
}

/**
 * 哪几页的行墨迹剖面与全篇共识「上下镜像」——内容被倒置(180°)的页。
 *
 * 没有文字层时单页看不出上下(剖面在 180° 前后完全镜像),但同一份文档的多数页版式一致,
 * 于是拿每页剖面与共识剖面比:按当前方向、按上下翻转各算一次相关,
 * 翻转必须明显更贴合才判倒置,差异不够大一律当作「无法判定」。
 * 漏判只是维持原样,误判会白转一整页 —— 阈值据此从严。
 */
export function invertedPages(profiles: RowProfile[], options: InversionOptions = {}): number[] {
  const reference = consensusProfile(profiles, options)
  if (!reference) return []
  const { minInk, margin, minCorrelation } = { ...DEFAULTS, ...options }
  const flagged: number[] = []
  for (const profile of profiles) {
    if (inkShare(profile.rows) < minInk) continue
    const z = normalizeProfile(profile.rows)
    const asIs = correlation(z, reference)
    const mirrored = correlation([...z].reverse(), reference)
    if (mirrored - asIs >= margin && mirrored > minCorrelation) flagged.push(profile.page)
  }
  return flagged
}

/**
 * 横躺页该顺时针转 90° 还是转 270°(逆时针 90°):整页顺时针转 90° 后,
 * 新的行剖面正是原来的列剖面 —— 列剖面直接贴合共识说明转 90° 就对了,
 * 反向的列剖面更贴合则说明要转 270°。返回 0 表示证据不足(调用方保持默认方向)。
 */
export function sidewaysDirection(
  profiles: RowProfile[],
  columns: ArrayLike<number>,
  options: InversionOptions = {}
): 90 | 270 | 0 {
  const reference = consensusProfile(profiles, options)
  if (!reference) return 0
  const { margin, minCorrelation } = { ...DEFAULTS, ...options }
  const z = normalizeProfile(columns)
  const clockwise = correlation(z, reference)
  const counterClockwise = correlation([...z].reverse(), reference)
  if (clockwise - counterClockwise >= margin && clockwise > minCorrelation) return 90
  if (counterClockwise - clockwise >= margin && counterClockwise > minCorrelation) return 270
  return 0
}
