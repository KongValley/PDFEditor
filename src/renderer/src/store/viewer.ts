import { nextTick } from 'vue'
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
 */
export const renderGate = {
  max: 2,
  /** 正在渲染的页数(跨 PageCanvas 实例共享) */
  active: 0,
  /** 等槽的唤醒函数队列 */
  waiters: [] as Array<() => void>
}

/** 按机器画像定并发:省内存机(≤4GB)只允许 1 个大位图同时光栅化 */
export function applyRenderGateBudget(): void {
  renderGate.max = machineProfile.lowMem ? 1 : 2
}

/** 取得一个渲染槽(超限则排队等待) */
export async function acquireRenderSlot(): Promise<void> {
  if (renderGate.active < renderGate.max) {
    renderGate.active++
    return
  }
  await new Promise<void>((resolve) => renderGate.waiters.push(resolve))
  renderGate.active++
}

/** 释放渲染槽并唤醒下一个等待者 */
export function releaseRenderSlot(): void {
  renderGate.active--
  const next = renderGate.waiters.shift()
  if (next) next()
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
  docState.rotationView = (((docState.rotationView + delta) % 360) + 360) % 360
  rebuildLayoutCache()
  void nextTick(() => {
    if (fitMode === 'width') fitWidth()
    else if (fitMode === 'page') fitPage()
  })
}
