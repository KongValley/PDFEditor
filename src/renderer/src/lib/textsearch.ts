import type { Rect } from '@shared/types'
import { docState, getPage } from '../store/document'

export interface SearchMatch {
  page: number
  rects: Rect[]
  snippet: string
}

interface TextItemRef {
  start: number
  end: number
  transform: number[]
  width: number
  height: number
}

interface PageTextIndex {
  text: string
  items: TextItemRef[]
}

const indexCache = new Map<number, PageTextIndex>()

export function clearSearchIndex(): void {
  indexCache.clear()
}

async function getPageIndex(pageNumber: number): Promise<PageTextIndex> {
  const cached = indexCache.get(pageNumber)
  if (cached) return cached
  const page = await getPage(pageNumber)
  const content = await page.getTextContent()
  let text = ''
  const items: TextItemRef[] = []
  for (const item of content.items) {
    if (!('str' in item)) continue
    const start = text.length
    text += item.str
    items.push({
      start,
      end: text.length,
      transform: item.transform as number[],
      width: item.width,
      height: item.height
    })
  }
  const index: PageTextIndex = { text, items }
  indexCache.set(pageNumber, index)
  return index
}

/** 依据字符区间计算高亮矩形(按行合并,item.width 为用户空间宽度) */
function matchRects(index: PageTextIndex, start: number, end: number): Rect[] {
  const byLine = new Map<number, Rect>()
  for (const item of index.items) {
    if (item.end <= start || item.start >= end) continue
    const [, , c, d, e, f] = item.transform
    const height = Math.hypot(c, d) || item.height || 12
    const itemLength = Math.max(item.end - item.start, 1)
    const from = Math.max(start, item.start) - item.start
    const to = Math.min(end, item.end) - item.start
    const perChar = item.width / itemLength
    const rect: Rect = {
      x: e + from * perChar,
      y: f - height * 0.22,
      w: Math.max((to - from) * perChar, 1),
      h: height
    }
    const key = Math.round(f)
    const prev = byLine.get(key)
    if (prev) {
      const minX = Math.min(prev.x, rect.x)
      const maxX = Math.max(prev.x + prev.w, rect.x + rect.w)
      const minY = Math.min(prev.y, rect.y)
      const maxY = Math.max(prev.y + prev.h, rect.y + rect.h)
      prev.x = minX
      prev.y = minY
      prev.w = maxX - minX
      prev.h = maxY - minY
    } else {
      byLine.set(key, rect)
    }
  }
  return [...byLine.values()]
}

export async function searchDocument(query: string, limit = 200): Promise<SearchMatch[]> {
  const results: SearchMatch[] = []
  const needle = query.toLowerCase()
  if (!needle.trim()) return results
  for (let pageNumber = 1; pageNumber <= docState.pageCount; pageNumber++) {
    // 每 16 页让出主线程,避免大文档搜索时界面卡死
    if (pageNumber % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    const index = await getPageIndex(pageNumber)
    const haystack = index.text.toLowerCase()
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at < 0) break
      results.push({
        page: pageNumber - 1,
        rects: matchRects(index, at, at + needle.length),
        snippet: index.text.slice(Math.max(0, at - 10), at + needle.length + 14).trim()
      })
      if (results.length >= limit) return results
      from = at + 1
    }
  }
  return results
}
