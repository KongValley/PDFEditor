import type { OutlineNode } from '@shared/types'
import type { PDFDocumentProxy } from './pdfjs'

interface RawOutlineItem {
  title?: string
  dest?: unknown
  items?: RawOutlineItem[]
}

async function resolveDestPage(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    let target: unknown = dest
    if (typeof dest === 'string') target = await doc.getDestination(dest)
    if (!Array.isArray(target) || target.length === 0) return null
    const ref = target[0]
    if (ref && typeof ref === 'object') {
      const index = await doc.getPageIndex(ref as never)
      return typeof index === 'number' ? index : null
    }
    if (typeof ref === 'number') return ref
    return null
  } catch {
    return null
  }
}

async function resolveItems(doc: PDFDocumentProxy, items: RawOutlineItem[]): Promise<OutlineNode[]> {
  const nodes: OutlineNode[] = []
  for (const item of items) {
    const page = await resolveDestPage(doc, item.dest)
    const children = item.items && item.items.length > 0 ? await resolveItems(doc, item.items) : []
    nodes.push({ title: item.title && item.title.trim() !== '' ? item.title : '(无标题)', page, children })
  }
  return nodes
}

/** 解析文档大纲;dest 解析失败的条目 page 为 null(界面上禁用点击) */
export async function loadOutline(doc: PDFDocumentProxy): Promise<OutlineNode[]> {
  try {
    const raw = (await doc.getOutline()) as RawOutlineItem[] | null
    if (!raw || raw.length === 0) return []
    return await resolveItems(doc, raw)
  } catch (err) {
    console.warn('大纲解析失败:', err)
    return []
  }
}
