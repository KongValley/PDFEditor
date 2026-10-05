import { nextTick } from 'vue'
import { docState, pageDisplaySize } from './document'

export const PAGE_GAP = 16
export const VIEWER_PADDING = 24

let container: HTMLElement | null = null
let fitMode: 'none' | 'width' | 'page' = 'none'

export function attachContainer(el: HTMLElement | null): void {
  container = el
}

export function viewerContainer(): HTMLElement | null {
  return container
}

export function contentHeight(): number {
  let total = 0
  for (let i = 0; i < docState.pageCount; i++) {
    total += pageDisplaySize(i).h + PAGE_GAP
  }
  return Math.max(total, 0)
}

export function pageOffsetTop(index: number): number {
  let top = 0
  for (let i = 0; i < index; i++) top += pageDisplaySize(i).h + PAGE_GAP
  return top
}

export function scrollToPage(pageNumber: number): void {
  if (!container || docState.pageCount === 0) return
  const index = Math.min(Math.max(pageNumber, 1), docState.pageCount) - 1
  container.scrollTop = pageOffsetTop(index)
  docState.currentPage = index + 1
}

/** 依据滚动位置反算当前页(以视口 35% 处为准) */
export function computeCurrentPage(): number {
  if (!container || docState.pageCount === 0) return 1
  const probe = container.scrollTop + container.clientHeight * 0.35
  let acc = 0
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
  const { w } = unscaledPageSize(index)
  const avail = container.clientWidth - VIEWER_PADDING * 2
  if (w <= 0 || avail <= 0) return
  fitMode = 'width'
  docState.scale = Math.min(Math.max(avail / w, 0.25), 4)
}

export function fitPage(): void {
  if (!container || docState.pageCount === 0) return
  const index = Math.min(Math.max(docState.currentPage, 1), docState.pageCount) - 1
  const { w, h } = unscaledPageSize(index)
  const availW = container.clientWidth - VIEWER_PADDING * 2
  const availH = container.clientHeight - VIEWER_PADDING * 2
  if (w <= 0 || h <= 0) return
  fitMode = 'page'
  docState.scale = Math.min(Math.max(Math.min(availW / w, availH / h), 0.25), 4)
}

export function rotateView(delta: number): void {
  docState.rotationView = (((docState.rotationView + delta) % 360) + 360) % 360
  void nextTick(() => {
    if (fitMode === 'width') fitWidth()
    else if (fitMode === 'page') fitPage()
  })
}