import { markRaw, reactive } from 'vue'
import { loadPdfDocument, type PDFDocumentProxy, type PDFPageProxy } from '../lib/pdfjs'
import { loadOutline } from '../lib/outline'
import { discoverFormFields } from '../lib/forms'
import type { Annotation, FormFieldInfo, FormValue, OpenResult, OutlineNode, SidecarData } from '@shared/types'

export interface PageBox {
  w: number
  h: number
}

/** 阅读视图模式:连续阅读 / 单页阅览 / 双页阅览 */
export type ViewMode = 'continuous' | 'single' | 'two'

interface DocState {
  docId: string | null
  filePath: string | null
  pdfDoc: PDFDocumentProxy | null
  loading: boolean
  loadError: string | null
  pageCount: number
  pageBoxes: PageBox[]
  currentPage: number
  scale: number
  rotationView: number
  /** 阅读视图模式(跨文档保留,与 scale 同策略) */
  viewMode: ViewMode
  encrypted: boolean
  sidecar: SidecarData | null
  /** 表单字段值(字段全名 → 值) */
  formValues: Record<string, FormValue>
  /** 文档内 AcroForm 字段(用于表单覆盖层) */
  formFields: FormFieldInfo[]
  /** 文档大纲(书签) */
  outline: OutlineNode[]
  /** 是否有未保存的更改(注释/表单/页面操作) */
  dirty: boolean
  /** 打开时从 PDF /Annots 提取的本应用批注(sidecar 兜底前的首选来源) */
  pdfAnnotations: Annotation[]
}

export const docState = reactive<DocState>({
  docId: null,
  filePath: null,
  pdfDoc: null,
  loading: false,
  loadError: null,
  pageCount: 0,
  pageBoxes: [],
  currentPage: 1,
  scale: 1,
  rotationView: 0,
  viewMode: 'continuous',
  encrypted: false,
  sidecar: null,
  formValues: {},
  formFields: [],
  outline: [],
  dirty: false,
  pdfAnnotations: []
})

/** 编辑版本号:保存期间注释变化 → 不清脏标记(替代无条件清 0) */
let editVersionCounter = 0

/** 标记未保存更改(唯一入口;同时推进编辑版本号) */
export function markDirty(): void {
  docState.dirty = true
  editVersionCounter++
}

export function editVersion(): number {
  return editVersionCounter
}

let pageCache = new Map<number, PDFPageProxy>()

/** 页缓存上限:32 位/低内存机器上避免 PageProxy 无限累积 */
const PAGE_CACHE_LIMIT = 12

const viewerPinned = new Set<number>()
const thumbPinned = new Set<number>()

/** 视口(主视图)当前可见页,回收时跳过 */
export function pinViewerPages(pages: Iterable<number>): void {
  viewerPinned.clear()
  for (const page of pages) viewerPinned.add(page)
}

/** 缩略图栏当前可见页,回收时跳过 */
export function pinThumbPages(pages: Iterable<number>): void {
  thumbPinned.clear()
  for (const page of pages) thumbPinned.add(page)
}

/** 清空两处可见页 pin(换文档/页面重建时调用,避免旧文档页号豁免新文档回收) */
export function clearViewerPins(): void {
  viewerPinned.clear()
  thumbPinned.clear()
}

function evictPages(): void {
  if (pageCache.size <= PAGE_CACHE_LIMIT) return
  const keepFrom = docState.currentPage - 2
  const keepTo = docState.currentPage + 2
  // 只回收不可见页:可见页(主视图 ±2 与缩略图可见项)一旦被回收,渲染会被打断且不会自动重渲染
  for (const [pageNumber, page] of pageCache) {
    if (pageCache.size <= PAGE_CACHE_LIMIT) return
    if (pageNumber >= keepFrom && pageNumber <= keepTo) continue
    if (viewerPinned.has(pageNumber) || thumbPinned.has(pageNumber)) continue
    page.cleanup()
    pageCache.delete(pageNumber)
  }
}

export async function getPage(pageNumber: number): Promise<PDFPageProxy> {
  const cached = pageCache.get(pageNumber)
  if (cached) return cached
  const doc = docState.pdfDoc
  if (!doc) throw new Error('文档未打开')
  const page = await doc.getPage(pageNumber)
  pageCache.set(pageNumber, page)
  evictPages()
  return page
}

export function hasDocument(): boolean {
  return docState.pdfDoc !== null
}

/** 当前缓存的 PageProxy 数量(低内存策略验证用) */
export function cachedPageCount(): number {
  return pageCache.size
}

/** 累计释放的文档数(验证 openByPath 每次切换都 cleanup 旧文档) */
let cleanupCount = 0

/** 测试 API 只读出口:把计数器包成函数,拿到调用时的当前值 */
export function docCleanupCount(): number {
  return cleanupCount
}

/** 可见页 pin 规模(低内存策略验证用) */
export function pinnedPageCounts(): { viewer: number; thumbs: number } {
  return { viewer: viewerPinned.size, thumbs: thumbPinned.size }
}

/** 每页显示尺寸(CSS px,含视图旋转与缩放) */
export function pageDisplaySize(index: number): { w: number; h: number } {
  const box = docState.pageBoxes[index]
  if (!box) return { w: 0, h: 0 }
  const rotated = docState.rotationView % 180 !== 0
  const w = rotated ? box.h : box.w
  const h = rotated ? box.w : box.h
  return { w: Math.round(w * docState.scale), h: Math.round(h * docState.scale) }
}

async function fillPageBoxes(pdfDoc: PDFDocumentProxy): Promise<PageBox[]> {
  const boxes: PageBox[] = new Array(pdfDoc.numPages)
  const total = pdfDoc.numPages
  for (let start = 1; start <= total; start += 32) {
    const numbers: number[] = []
    for (let n = start; n < Math.min(start + 32, total + 1); n++) numbers.push(n)
    await Promise.all(
      numbers.map(async (n) => {
        const page = await pdfDoc.getPage(n)
        const view = page.view
        const width = view[2] - view[0]
        const height = view[3] - view[1]
        const rotate = (((page.rotate % 360) + 360) % 360)
        const swapped = rotate === 90 || rotate === 270
        boxes[n - 1] = swapped ? { w: height, h: width } : { w: width, h: height }
        // 只取尺寸,不驻留 PageProxy(低内存:渲染时再按需 getPage)
        page.cleanup()
      })
    )
  }
  return boxes
}

export interface OpenOptions {
  onPassword?: (updatePassword: (password: string | Error) => void, reason: number) => void
}

export async function openByPath(path: string, options: OpenOptions = {}): Promise<boolean> {
  docState.loading = true
  docState.loadError = null
  try {
    const result = (await window.pdfAPI.invoke('doc:open', path)) as OpenResult
    if (!result.ok || !result.buffer || !result.docId || !result.pageCount) {
      docState.loadError = result.errorMessage ?? '打开文件失败'
      return false
    }

    let pdfDoc: PDFDocumentProxy
    try {
      pdfDoc = await loadPdfDocument(result.buffer, { onPassword: options.onPassword })
    } catch (err) {
      // 加载失败/用户取消:释放主进程条目,避免打开失败占满缓存把已打开的文档挤掉
      docState.loadError = err instanceof Error ? err.message : String(err)
      void window.pdfAPI.invoke('doc:release', result.docId)
      return false
    }

    pageCache = new Map()
    docState.docId = result.docId
    docState.filePath = result.path ?? path
    // 释放上一份文档的 worker 资源(与 reloadDocument 一致),避免反复打开后 worker 侧内存单调增长
    if (docState.pdfDoc) {
      docState.pdfDoc.cleanup()
      cleanupCount++
    }
    docState.pdfDoc = markRaw(pdfDoc)
    // 旧文档的可见/pin 页号残留会让新文档的同号页被豁免回收,换文档时一并清空
    clearViewerPins()
    docState.pageCount = pdfDoc.numPages
    docState.currentPage = 1
    docState.rotationView = 0
    docState.encrypted = result.encrypted ?? false
    docState.sidecar = result.sidecar ?? null
    docState.formValues = result.sidecar?.formValues ? { ...result.sidecar.formValues } : {}
    docState.loadError = null

    const boxes = await fillPageBoxes(pdfDoc)
    docState.pageBoxes = boxes

    // 表单字段:sidecar 值优先,其次用文档中的现有值作为初始值
    docState.formFields = await discoverFormFields(pdfDoc)
    const values: Record<string, FormValue> = {}
    for (const field of docState.formFields) {
      if (field.value !== undefined) values[field.fullName] = field.value
    }
    docState.formValues = { ...values, ...(result.sidecar?.formValues ?? {}) }
    docState.dirty = false
    docState.pdfAnnotations = result.annotations ?? []

    docState.outline = await loadOutline(pdfDoc)
    return true
  } catch (err) {
    docState.loadError = err instanceof Error ? err.message : String(err)
    return false
  } finally {
    docState.loading = false
  }
}

/** 页面操作后:以新 buffer 重开 pdf.js 文档(保持缩放与视图旋转) */
export async function reloadDocument(buffer: ArrayBuffer): Promise<void> {
  // 页面重建后旧 pin 页号失效:不清理会让新文档同号页被豁免回收
  clearViewerPins()
  const pdfDoc = await loadPdfDocument(buffer)
  const previous = docState.pdfDoc
  pageCache = new Map()
  docState.pdfDoc = markRaw(pdfDoc)
  docState.pageCount = pdfDoc.numPages
  docState.pageBoxes = await fillPageBoxes(pdfDoc)
  // 页面/合并操作会改变表单控件集合:重新发现,否则合并进来的字段不显示也无法填写
  docState.formFields = await discoverFormFields(pdfDoc)
  docState.currentPage = Math.min(Math.max(docState.currentPage, 1), pdfDoc.numPages)
  if (previous) void previous.cleanup()
}

export function closeDocument(): void {
  const doc = docState.pdfDoc
  if (doc) void doc.cleanup()
  pageCache = new Map()
  docState.docId = null
  docState.filePath = null
  docState.pdfDoc = null
  docState.pageCount = 0
  docState.pageBoxes = []
  docState.currentPage = 1
  docState.rotationView = 0
  docState.encrypted = false
  docState.sidecar = null
  docState.formValues = {}
  docState.formFields = []
  docState.outline = []
  docState.loadError = null
  docState.dirty = false
  docState.pdfAnnotations = []
}
