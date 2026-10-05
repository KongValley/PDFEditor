import { reactive } from 'vue'
import type { SearchMatch } from '../lib/textsearch'
import { clearSearchIndex } from '../lib/textsearch'
import { docState, getPage } from './document'
import { getPageViewport } from '../lib/pdfjs'
import { pdfRectToScreen } from '../lib/geo'
import { scrollToPagePosition } from './viewer'

interface SearchState {
  query: string
  results: SearchMatch[]
  current: number
  searching: boolean
  /** 达到搜索上限(200 条)被截断 */
  truncated: boolean
}

export const searchState = reactive<SearchState>({
  query: '',
  results: [],
  current: -1,
  searching: false,
  truncated: false
})

/** 页面操作/文档重载后失效搜索索引与结果(页面内容已变化,旧命中不可用) */
export function invalidateSearch(): void {
  clearSearchIndex()
  searchState.results = []
  searchState.current = -1
  searchState.truncated = false
}

/** 跳到第 index 条命中(取模循环):滚动到命中行位置(视口纵向 30% 处) */
export async function searchGoTo(index: number): Promise<void> {
  const total = searchState.results.length
  if (total === 0) return
  searchState.current = ((index % total) + total) % total
  const match = searchState.results[searchState.current]
  const rect = match.rects[0]
  if (!rect) return
  try {
    const page = await getPage(match.page + 1)
    const { viewport } = getPageViewport(page, docState.scale, docState.rotationView)
    const screen = pdfRectToScreen(viewport, rect)
    scrollToPagePosition(match.page + 1, screen.y)
  } catch {
    // 页面已变化/索引失效:静默忽略,不打断用户操作
  }
}

/** 相对步进(±1),供 F3/搜索栏按钮共用 */
export function searchStep(delta: number): void {
  void searchGoTo(searchState.current + delta)
}
