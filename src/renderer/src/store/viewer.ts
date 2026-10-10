import { nextTick, ref } from 'vue'
import { docState, machineProfile, pageDisplaySize, type ViewMode } from './document'

export const PAGE_GAP = 16
export const VIEWER_PADDING = 24

/** 双页模式每行页数:1-2 / 3-4 / 5-6…(无封面偏移) */
const TWO_UP = 2

let container: HTMLElement | null = null
let fitMode: 'none' | 'width' | 'page' = 'none'

/** 渲染看门狗:worker 偶发停摆时 render().promise 永不 settle(代码审查报告存疑 #4);冒烟可调 */
export const renderWatchdog = { timeoutMs: 8000, timeouts: 0, renders: 0, stallNext: false }

/**
 * 并发渲染上限:双页模式一次可见 6 页(连续模式仅 1 页),若全部并发提交,
 * 排在后面的页会在同一个 pdf.js worker 队列里等过看门狗预算(8s)→ 超时 → 白页。
 * 状态必须放在模块作用域:<script setup> 顶层的 let 是每个组件实例各一份,无法跨页共享。
 *
 * 队列带优先级(当前页 > 其它页 > 缩略图):缩略图之前完全不占槽,十几张扫描缩略图
 * 会把 pdf.js worker 占满,可见页排在后面 → 渲染看门狗连续超时(实测 >16s 才出图)。
 */
export const renderGate = {
  max: 2,
  /** 正在渲染的页数(跨 PageCanvas 实例共享) */
  active: 0,
  /** 等槽的唤醒函数队列(按优先级分桶) */
  waiters: { current: [] as Array<() => void>, page: [] as Array<() => void>, thumb: [] as Array<() => void> }
}

export type RenderPriority = 'current' | 'page' | 'thumb'

const PRIORITY_ORDER: RenderPriority[] = ['current', 'page', 'thumb']

/** 按机器画像定并发:省内存机(≤4GB)只允许 1 个大位图同时光栅化 */
export function applyRenderGateBudget(): void {
  renderGate.max = machineProfile.lowMem ? 1 : 2
}

/** 取得一个渲染槽(超限则按优先级排队等待) */
export async function acquireRenderSlot(priority: RenderPriority = 'page'): Promise<void> {
  if (renderGate.active < renderGate.max) {
    renderGate.active++
    return
  }
  await new Promise<void>((resolve) => renderGate.waiters[priority].push(resolve))
  renderGate.active++
}

/** 释放渲染槽并唤醒优先级最高的等待者 */
export function releaseRenderSlot(): void {
  renderGate.active--
  for (const priority of PRIORITY_ORDER) {
    const next = renderGate.waiters[priority].shift()
    if (next) {
      next()
      return
    }
  }
}

/**
 * 页面光栅化的实测耗时(最近 8 次)。
 * 渲染快慢是这台机器最直接的性能指标:它决定预读铺几页,而不是靠一次性探测的机器画像。
 */
/** 缩略图完成渲染的次数(与页面渲染分开计:首屏不该被缩略图拖慢) */
export const thumbWatch = { renders: 0 }

export const renderStats = {
  durations: [] as number[],
  avg(): number {
    if (this.durations.length === 0) return 0
    return this.durations.reduce((a, b) => a + b, 0) / this.durations.length
  },
  record(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return
    this.durations.push(ms)
    if (this.durations.length > 8) this.durations.shift()
  }
}

/**
 * 预读页数:把当前页上下各提前铺几页,滚动时直接显示已有位图。
 *  - 省内存机(≤4GB)不预读:位图内存优先;
 *  - 实测渲染很快(<400ms)铺 2 页,否则 1 页 —— 慢机器铺 2 页只会把 worker 排满,
 *    反而不如少铺一页让当前页先画出来。
 */
export function prefetchDepth(): number {
  if (machineProfile.lowMem) return 0
  const avg = renderStats.avg()
  return avg > 0 && avg < 400 ? 2 : 1
}

/** 预读余量变化时自增:PdfViewer 用它重建观察器(depth 从实测中得出,会中途变) */
export const prefetchEpoch = ref(0)
let lastDepth = prefetchDepth()

/** 每次页面渲染完成后调用:耗时均值变化可能改变预读页数 */
export function notifyRenderDone(ms: number): void {
  renderStats.record(ms)
  const depth = prefetchDepth()
  if (depth !== lastDepth) {
    lastDepth = depth
    prefetchEpoch.value++
  }
}

/**
 * 首屏页是否已画出来。打开文档时缩略图不抢跑:扫描件的缩略图同样要解码整页 JPEG,
 * 十几张一起上会把 worker 占满,首屏页要等 1–2 秒(实测开文件 2.5s vs 关缩略图 1.1s)。
 * 兜底 8 秒:打开卡死(或没有可见页)时不能让缩略图一直空着,但也不能早于大文档的正常打开时间。
 */
export const firstPaintDone = ref(false)
let firstPaintTimer = 0

export function resetFirstPaint(): void {
  firstPaintDone.value = false
  if (firstPaintTimer) window.clearTimeout(firstPaintTimer)
  firstPaintTimer = window.setTimeout(() => (firstPaintDone.value = true), 8000)
}

export function markFirstPaint(): void {
  if (firstPaintTimer) {
    window.clearTimeout(firstPaintTimer)
    firstPaintTimer = 0
  }
  firstPaintDone.value = true
}

export function attachContainer(el: HTMLElement | null): void {
  container = el
}

/** 缩放来源标记:Ctrl+滚轮置位,PageCanvas 据此对连续 scale 变更做 120ms 渲染去抖 */
export const zoomWheelAt = { active: false }

export function rowCount(): number {
  return Math.ceil(docState.pageCount / TWO_UP)
}

/** 行内 0 基页索引 */
export function rowPages(row: number): number[] {
  const pages: number[] = []
  for (let i = 0; i < TWO_UP; i++) {
    const index = row * TWO_UP + i
    if (index < docState.pageCount) pages.push(index)
  }
  return pages
}

/** 行高 = 行内最高页的显示高度(与 DOM 行高一致,页面高度已 Math.round) */
export function rowHeight(row: number): number {
  let height = 0
  for (const index of rowPages(row)) height = Math.max(height, pageDisplaySize(index).h)
  return height
}

/* ---------------- 前缀和几何(pageBoxes/scale/rotationView/viewMode 变化时重建) ---------------- */

/** rows[row] = [顶部 y, 行高];pages[i] = [顶部 y, 页高](含 PAGE_GAP,与 DOM 累加一致) */
let rowTops: number[] = []
let rowHeights: number[] = []
let pageTops: number[] = []

/** 重建前缀和(渲染层在 docState.pageBoxes/scale/rotationView/viewMode 变化后调用) */
export function rebuildLayoutCache(): void {
  const two = docState.viewMode === 'two'
  if (two) {
    rowTops = []
    rowHeights = []
    let top = 0
    for (let row = 0; row < rowCount(); row++) {
      const height = rowHeight(row)
      rowTops.push(top)
      rowHeights.push(height)
      top += height + PAGE_GAP
    }
    pageTops = []
  } else {
    rowTops = []
    rowHeights = []
    pageTops = []
    let top = 0
    for (let i = 0; i < docState.pageCount; i++) {
      pageTops.push(top)
      top += pageDisplaySize(i).h + PAGE_GAP
    }
  }
}

/** 缓存签名:pageBoxes 长度+页数×缩放×视图旋转×模式;变化或换文档即失效 */
let cacheSignature = ''

function currentSignature(): string {
  return `${docState.docId ?? ''}|${docState.pageBoxes.length}|${docState.scale}|${docState.rotationView}|${docState.viewMode}`
}

/** 数组失效兜底:签名不符(文档/页数/缩放/旋转/模式变化)时重建一次 */
function ensureLayoutCache(): void {
  if (cacheSignature !== currentSignature()) {
    cacheSignature = currentSignature()
    rebuildLayoutCache()
  }
}

export function contentHeight(): number {
  ensureLayoutCache()
  if (docState.viewMode === 'two') {
    const rows = rowTops.length
    if (rows === 0) return 0
    return rowTops[rows - 1] + rowHeights[rows - 1] + PAGE_GAP
  }
  if (pageTops.length === 0) return 0
  const last = docState.pageCount - 1
  return pageTops[last] + pageDisplaySize(last).h + PAGE_GAP
}

export function pageOffsetTop(index: number): number {
  ensureLayoutCache()
  if (docState.viewMode === 'two') return rowTops[Math.floor(index / TWO_UP)] ?? 0
  return pageTops[index] ?? 0
}

/** 二分:第一个 顶部 y > probe 的条目前一个 */
export function floorIndex(tops: number[], probe: number): number {
  let lo = 0
  let hi = tops.length - 1
  if (hi < 0 || probe < tops[0]) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (tops[mid] <= probe) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 前缀和只读出口(PdfViewer 几何播种用);未重建时按需重建 */
export function rowTopsOf(): number[] {
  ensureLayoutCache()
  return rowTops
}

export function pageTopsOf(): number[] {
  ensureLayoutCache()
  return pageTops
}

export function scrollToPage(pageNumber: number): void {
  if (!container || docState.pageCount === 0) return
  const index = Math.min(Math.max(pageNumber, 1), docState.pageCount) - 1
  docState.currentPage = index + 1
  if (docState.viewMode === 'single') {
    container.scrollTop = 0
    return
  }
  container.scrollTop = pageOffsetTop(index)
}

/** 定位到某页内偏移(搜索命中):单页模式先切页,再滚到页内 offsetY 处 */
export function scrollToPagePosition(pageNumber: number, offsetY: number): void {
  if (!container || docState.pageCount === 0) return
  const index = Math.min(Math.max(pageNumber, 1), docState.pageCount) - 1
  if (docState.viewMode === 'single') {
    scrollToPage(pageNumber)
    // 切页后新页高度要等 DOM 更新,立即设 scrollTop 会被旧页高度 clamp
    void nextTick(() => {
      if (container) container.scrollTop = Math.max(0, offsetY - container.clientHeight * 0.3)
    })
    return
  }
  container.scrollTop = Math.max(0, pageOffsetTop(index) + offsetY - container.clientHeight * 0.3)
}

/** 依据滚动位置反算当前页(以视口 35% 处为准) */
export function computeCurrentPage(): number {
  if (!container || docState.pageCount === 0) return 1
  if (docState.viewMode === 'single') return docState.currentPage
  ensureLayoutCache()
  const probe = container.scrollTop + container.clientHeight * 0.35
  if (docState.viewMode === 'two') {
    if (rowTops.length === 0) return 1
    return rowPages(floorIndex(rowTops, probe))[0] + 1
  }
  if (pageTops.length === 0) return 1
  return floorIndex(pageTops, probe) + 1
}

export function zoomAt(newScale: number, clientY?: number, source?: 'wheel'): void {
  zoomWheelAt.active = source === 'wheel'
  // 上限 4 倍:再放大单页位图会超过 30MB(低内存机器上不可接受)
  const clamped = Math.min(Math.max(newScale, 0.25), 4)
  fitMode = 'none'
  if (!container || clamped === docState.scale) {
    docState.scale = clamped
    return
  }
  const rect = container.getBoundingClientRect()
  const anchorY = clientY === undefined ? container.clientHeight / 2 : clientY - rect.top
  const oldHeight = contentHeight()
  const ratio = oldHeight > 0 ? (container.scrollTop + anchorY) / oldHeight : 0
  // 不在此处 rebuildLayoutCache():此刻 scale 仍是旧值,重建出来的还是旧几何;
  // 改 scale 后 nextTick 的 contentHeight() 会按新签名重建一次即可
  docState.scale = clamped
  void nextTick(() => {
    if (!container) return
    container.scrollTop = ratio * contentHeight() - anchorY
  })
}

export function zoomBy(factor: number): void {
  zoomAt(docState.scale * factor)
}

function unscaledPageSize(index: number): { w: number; h: number } {
  const box = docState.pageBoxes[index]
  if (!box) return { w: 0, h: 0 }
  const rotated = docState.rotationView % 180 !== 0
  return { w: rotated ? box.h : box.w, h: rotated ? box.w : box.h }
}

export function fitWidth(): void {
  if (!container || docState.pageCount === 0) return
  const index = Math.min(Math.max(docState.currentPage, 1), docState.pageCount) - 1
  const pages = docState.viewMode === 'two' ? rowPages(Math.floor(index / TWO_UP)) : [index]
  const widths = pages.map((i) => unscaledPageSize(i).w)
  if (widths.some((w) => w <= 0)) return
  const avail = container.clientWidth - VIEWER_PADDING * 2
  if (avail <= 0) return
  const totalW = widths.reduce((sum, w) => sum + w, 0)
  const gap = (widths.length - 1) * PAGE_GAP
  fitMode = 'width'
  docState.scale = Math.min(Math.max((avail - gap) / totalW, 0.25), 4)
}

export function fitPage(): void {
  if (!container || docState.pageCount === 0) return
  const index = Math.min(Math.max(docState.currentPage, 1), docState.pageCount) - 1
  const pages = docState.viewMode === 'two' ? rowPages(Math.floor(index / TWO_UP)) : [index]
  const sizes = pages.map((i) => unscaledPageSize(i))
  if (sizes.some((size) => size.w <= 0 || size.h <= 0)) return
  const availW = container.clientWidth - VIEWER_PADDING * 2
  const availH = container.clientHeight - VIEWER_PADDING * 2
  if (availW <= 0 || availH <= 0) return
  const totalW = sizes.reduce((sum, size) => sum + size.w, 0) + (sizes.length - 1) * PAGE_GAP
  const maxH = Math.max(...sizes.map((size) => size.h))
  fitMode = 'page'
  docState.scale = Math.min(Math.max(Math.min(availW / totalW, availH / maxH), 0.25), 4)
}

export function setViewMode(mode: ViewMode): void {
  if (docState.viewMode === mode) return
  docState.viewMode = mode
  void nextTick(() => {
    if (!container) return
    if (fitMode === 'width') fitWidth()
    else if (fitMode === 'page') fitPage()
    scrollToPage(docState.currentPage) // 单页=回到页首;双页/连续=对齐到所在行/页
  })
}

/**
 * 页面显示方向是否发生竖↔横翻转。
 * 以「高 ≥ 宽 = 竖」判定:方形/近方形页两侧都算竖,旋转后不翻转 → 不触发重新适应。
 * 任一尺寸缺失(页号越界/几何未就绪)时返回 false,不打扰正在进行的渲染。
 */
export function orientationFlipped(before: { w: number; h: number }, after: { w: number; h: number }): boolean {
  if (before.w <= 0 || before.h <= 0 || after.w <= 0 || after.h <= 0) return false
  return before.h >= before.w !== (after.h >= after.w)
}

/**
 * 方向翻转后重新适应:已在「适合宽度/适合页面」就重放同一模式;
 * 手动缩放(fitMode='none')按「适合页面」处理 —— 翻转后整页可见才便于观看。
 * 钳制沿用 fitPage/fitWidth 内部的 0.25–4,不另设上限。
 */
export function refitAfterOrientationChange(): void {
  if (fitMode === 'width') fitWidth()
  else fitPage()
}

/**
 * 容器首次布局完成(width>0)后补做一次适应宽度。
 * 挂载时机早于布局时 fitWidth 会因 avail<=0 直接返回,导致新文档停在 100%;
 * 用 needFitOnResize 标记避免覆盖用户的手动缩放。
 */
let needFitOnResize = false

export function requestInitialFit(): void {
  needFitOnResize = true
  applyPendingFit()
}

/** 视口尺寸变化时调用:仅在"还没成功做过初始适应"且用户未手动缩放时重算 */
export function applyPendingFit(): void {
  if (!needFitOnResize || !container) return
  if (fitMode !== 'none' && fitMode !== 'width') return
  if (container.clientWidth <= 0) return
  needFitOnResize = false
  fitWidth()
}

/** 上一页/下一页:双页模式按整行步进(scrollToPage 自带 clamp) */
export function stepPage(dir: 1 | -1): void {
  scrollToPage(docState.currentPage + dir * (docState.viewMode === 'two' ? 2 : 1))
}

export function rotateView(delta: number): void {
  const before = pageDisplaySize(docState.currentPage - 1)
  docState.rotationView = (((docState.rotationView + delta) % 360) + 360) % 360
  rebuildLayoutCache()
  void nextTick(() => {
    if (orientationFlipped(before, pageDisplaySize(docState.currentPage - 1))) {
      refitAfterOrientationChange()
      return
    }
    if (fitMode === 'width') fitWidth()
    else if (fitMode === 'page') fitPage()
  })
}
