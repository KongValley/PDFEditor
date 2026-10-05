import { nextTick } from 'vue'
import { docState, pageDisplaySize, type ViewMode } from './document'

export const PAGE_GAP = 16
export const VIEWER_PADDING = 24

/** 双页模式每行页数:1-2 / 3-4 / 5-6…(无封面偏移) */
const TWO_UP = 2

let container: HTMLElement | null = null
let fitMode: 'none' | 'width' | 'page' = 'none'

/** 渲染看门狗:worker 偶发停摆时 render().promise 永不 settle(代码审查报告存疑 #4);冒烟可调 */
export const renderWatchdog = { timeoutMs: 8000, timeouts: 0, renders: 0, stallNext: false }

export function attachContainer(el: HTMLElement | null): void {
  container = el
}

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

export function contentHeight(): number {
  let total = 0
  if (docState.viewMode === 'two') {
    for (let row = 0; row < rowCount(); row++) total += rowHeight(row) + PAGE_GAP
  } else {
    for (let i = 0; i < docState.pageCount; i++) {
      total += pageDisplaySize(i).h + PAGE_GAP
    }
  }
  return Math.max(total, 0)
}

export function pageOffsetTop(index: number): number {
  let top = 0
  if (docState.viewMode === 'two') {
    const row = Math.floor(index / TWO_UP)
    for (let r = 0; r < row; r++) top += rowHeight(r) + PAGE_GAP
    return top
  }
  for (let i = 0; i < index; i++) top += pageDisplaySize(i).h + PAGE_GAP
  return top
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
  const probe = container.scrollTop + container.clientHeight * 0.35
  let acc = 0
  if (docState.viewMode === 'two') {
    for (let row = 0; row < rowCount(); row++) {
      acc += rowHeight(row) + PAGE_GAP
      if (probe < acc) return rowPages(row)[0] + 1
    }
    return rowPages(rowCount() - 1)[0] + 1
  }
  for (let i = 0; i < docState.pageCount; i++) {
    acc += pageDisplaySize(i).h + PAGE_GAP
    if (probe < acc) return i + 1
  }
  return docState.pageCount
}

export function zoomAt(newScale: number, clientY?: number): void {
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

/** 上一页/下一页:双页模式按整行步进(scrollToPage 自带 clamp) */
export function stepPage(dir: 1 | -1): void {
  scrollToPage(docState.currentPage + dir * (docState.viewMode === 'two' ? 2 : 1))
}

export function rotateView(delta: number): void {
  docState.rotationView = (((docState.rotationView + delta) % 360) + 360) % 360
  void nextTick(() => {
    if (fitMode === 'width') fitWidth()
    else if (fitMode === 'page') fitPage()
  })
}
