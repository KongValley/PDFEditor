import { computed, markRaw, reactive } from 'vue'
import { destroyPdfDocument, loadPdfDocument, loadPdfDocumentByRange, type PDFDocumentProxy, type PDFPageProxy } from '../lib/pdfjs'
import { loadOutline } from '../lib/outline'
import { discoverFormFields } from '../lib/forms'
import type {
  Annotation,
  FormFieldInfo,
  FormValue,
  OpenResult,
  OutlineNode,
  RangeReadResult,
  RuntimeInfo,
  SidecarData
} from '@shared/types'

export interface PageBox {
  w: number
  h: number
}

/** 打开方式与分段读取统计(冒烟断言用;不参与运行逻辑) */
export const rangeStreamStats: { mode: 'range' | 'buffer'; reads: number; bytes: number; fileSize: number } = {
  mode: 'buffer',
  reads: 0,
  bytes: 0,
  fileSize: 0
}

/** 阅读视图模式:连续阅读 / 单页阅览 / 双页阅览 */
export type ViewMode = 'continuous' | 'single' | 'two'

/** 机器画像(来自 app:runtimeInfo);首次打开文档前就绪,供各处同步读取 */
export const machineProfile = reactive({
  ready: false,
  arch: 'x64',
  lowMem: false,
  totalMemMB: 0
})

/** 读取机器画像并缓存(幂等):失败时按省内存档处理,老机器不会退回激进默认值 */
export async function loadMachineProfile(): Promise<void> {
  if (machineProfile.ready) return
  try {
    const info = (await window.pdfAPI.invoke('app:runtimeInfo')) as Partial<RuntimeInfo>
    machineProfile.arch = info.arch ?? 'x64'
    machineProfile.totalMemMB = info.totalMemMB ?? 0
    machineProfile.lowMem = info.lowMem ?? false
  } catch {
    machineProfile.lowMem = true
  }
  machineProfile.ready = true
}

interface DocState {
  docId: string | null
  filePath: string | null
  pdfDoc: PDFDocumentProxy | null
  loading: boolean
  /** 打开阶段的细粒度进度(大文档读取页面尺寸时才有内容) */
  loadProgress: string | null
  loadError: string | null
  pageCount: number
  pageBoxes: PageBox[]
  /** pageBoxes 内容变更计数(旋转/增删/移动/重开):位图重绘的触发信号 */
  geometryVersion: number
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
  loadProgress: null,
  loadError: null,
  pageCount: 0,
  pageBoxes: [],
  geometryVersion: 0,
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

/**
 * 文档几何是否就绪:pdfDoc 就位 ≠ 可用 —— pageBoxes 要等 fillPageBoxes 跑完才有值,
 * 此前 pageDisplaySize 全返回 {0,0},挂载 viewer 只会得到一片空白(打开 400 页文档时数秒)。
 */
export const docReady = computed(() => docState.pdfDoc !== null && docState.pageBoxes.length === docState.pageCount)

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
export function pinnedPageCounts(): { viewer: number; thumbs: number; maxPage: number } {
  // maxPage:换文档后若残留上一份文档的 pin 页号,会超出新文档的页数(冒烟据此判「无跨文档残留」)
  const maxPage = Math.max(0, ...viewerPinned, ...thumbPinned)
  return { viewer: viewerPinned.size, thumbs: thumbPinned.size, maxPage }
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

async function fillPageBoxes(
  pdfDoc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void
): Promise<PageBox[]> {
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
        // 只取尺寸,不驻留 PageProxy(低内存:渲染时再按需 getPage)。
        // 必须是逐页 cleanup:它只清本页本地状态、页面在渲染时自动放弃;
        // 换成 doc.cleanup() 会在任何一页正在渲染时抛 "Page N is currently rendering."
        // (pdf.js 3.11 startCleanup 的实现如此),打开/换页当场失败
        page.cleanup()
      })
    )
    onProgress?.(Math.min(start - 1 + 32, total), total)
  }
  return boxes
}

export interface OpenOptions {
  onPassword?: (updatePassword: (password: string | Error) => void, reason: number) => void
}

/** 已释放的主进程 docId(冒烟断言用;不参与运行逻辑) */
export const releasedDocIds: string[] = []

/** 释放主进程持有的整份字节(换文档/关闭文档时调用,否则要等 MAX_DOCS=3 的 LRU 逐出) */
function releaseDocEntry(docId: string): void {
  releasedDocIds.push(docId)
  if (releasedDocIds.length > 50) releasedDocIds.shift()
  void window.pdfAPI.invoke('doc:release', docId)
}

export async function openByPath(path: string, options: OpenOptions = {}): Promise<boolean> {
  docState.loading = true
  docState.loadError = null
  // 大文件在内网共享盘上读取要几秒到几十秒:订阅主进程的分块进度,并在标题区提供「取消」
  const offProgress = window.pdfAPI.on('doc:openProgress', (raw) => {
    const info = raw as { read?: number; total?: number }
    const total = info?.total ?? 0
    if (total > 0) docState.loadProgress = `正在读取文件 ${Math.round(((info?.read ?? 0) / total) * 100)}%`
  })
  try {
    const result = (await window.pdfAPI.invoke('doc:open', path)) as OpenResult
    if (result.error === 'canceled') return false
    if (!result.ok || !result.docId || !result.pageCount || (!result.buffer && result.stream !== 'range')) {
      docState.loadError = result.errorMessage ?? '打开文件失败'
      return false
    }

    let pdfDoc: PDFDocumentProxy
    try {
      if (result.stream === 'range' && result.fileSize) {
        const docId = result.docId
        rangeStreamStats.mode = 'range'
        rangeStreamStats.reads = 0
        rangeStreamStats.bytes = 0
        rangeStreamStats.fileSize = result.fileSize
        pdfDoc = await loadPdfDocumentByRange({
          length: result.fileSize,
          requestRange: async (begin, end) => {
            const res = (await window.pdfAPI.invoke('doc:readRange', { docId, begin, end })) as RangeReadResult
            if (!res.ok || !res.bytes) throw new Error(res.error ?? '分段读取失败')
            rangeStreamStats.reads++
            rangeStreamStats.bytes += res.bytes.byteLength
            return res.bytes
          },
          onPassword: options.onPassword
        })
      } else {
        rangeStreamStats.mode = 'buffer'
        rangeStreamStats.reads = 0
        rangeStreamStats.bytes = 0
        rangeStreamStats.fileSize = result.fileSize ?? 0
        pdfDoc = await loadPdfDocument(result.buffer as ArrayBuffer, { onPassword: options.onPassword })
      }
    } catch (err) {
      // 加载失败/用户取消:释放主进程条目,避免打开失败占满缓存把已打开的文档挤掉
      docState.loadError = err instanceof Error ? err.message : String(err)
      void window.pdfAPI.invoke('doc:release', result.docId)
      return false
    }

    pageCache = new Map()
    const prevDocId = docState.docId
    // 换文档:立即释放上一份在主进程的整份字节,不等 MAX_DOCS=3 的 LRU 逐出
    // (逐个打开大文件时,否则主进程会同时驻留 3 份)
    if (prevDocId && prevDocId !== result.docId) releaseDocEntry(prevDocId)
    docState.docId = result.docId
    docState.filePath = result.path ?? path
    // 释放上一份文档的 worker 资源(与 reloadDocument 一致),避免反复打开后 worker 侧内存单调增长
    if (docState.pdfDoc) {
      void destroyPdfDocument(docState.pdfDoc)
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

    const boxes = await fillPageBoxes(pdfDoc, (done, total) => {
      docState.loadProgress = `正在读取页面信息 ${done}/${total}`
    })
    docState.pageBoxes = boxes
    docState.geometryVersion++

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
    offProgress()
    docState.loading = false
    docState.loadProgress = null
  }
}

/** 「取消」按钮:中断主进程的整份读取(共享盘上几十 MB 的文件要等几十秒) */
export function cancelOpen(): void {
  void window.pdfAPI.invoke('doc:cancelOpen')
}

/** 页面操作后:以新 buffer 重开 pdf.js 文档(保持缩放与视图旋转)。
 * 增量模式:
 *  - `rotatedPages`:该页尺寸宽高互换(rotate 专用)
 *  - `pageMap`:按旧页序 → 新页序重排 pageBoxes(move 用;长度不符或有空洞自动回退全量)
 * 两者都不给(或结果不完整)时回退全量 fillPageBoxes + discoverFormFields。 */
export async function reloadDocument(
  buffer: ArrayBuffer,
  incremental?: { rotatedPages?: number[]; pageMap?: number[] }
): Promise<void> {
  // 页面重建后旧 pin 页号失效:不清理会让新文档同号页被豁免回收
  clearViewerPins()
  const pdfDoc = await loadPdfDocument(buffer)
  const previous = docState.pdfDoc
  pageCache = new Map()
  docState.pdfDoc = markRaw(pdfDoc)
  docState.pageCount = pdfDoc.numPages

  const boxes = docState.pageBoxes
  let nextBoxes: PageBox[] | null = null
  if (incremental?.pageMap && incremental.pageMap.length === boxes.length) {
    const reordered: PageBox[] = new Array(pdfDoc.numPages)
    incremental.pageMap.forEach((newIndex, oldIndex) => {
      if (newIndex >= 0 && newIndex < pdfDoc.numPages) reordered[newIndex] = boxes[oldIndex]
    })
    // 任一空位即视为映射不完整,回退全量。
    // 注意不能用 Array.prototype.every:它跳过稀疏数组的空洞,会把 insertBlank 留下的
    // 空缺误判为"全部已填充"。
    let complete = true
    for (let i = 0; i < reordered.length; i++) {
      if (reordered[i] === undefined) {
        complete = false
        break
      }
    }
    nextBoxes = complete ? reordered : null
  } else if (incremental?.rotatedPages && incremental.rotatedPages.length > 0) {
    const rotated = new Set(incremental.rotatedPages)
    nextBoxes = boxes.map((box, i) => (rotated.has(i) ? { w: box.h, h: box.w } : box))
  }

  if (nextBoxes && nextBoxes.length === pdfDoc.numPages) {
    docState.pageBoxes = nextBoxes
    docState.geometryVersion++
    // 增量分支不重建 pdf.js 文档内容,但页面重排后表单控件的页号必须跟着迁移,
    // 否则 FormOverlay 会把字段画到错误的页上(rotate 分支页序不变,不需要迁)
    const map = incremental?.pageMap ?? []
    docState.formFields = docState.formFields
      .map((field) => ({ ...field, page: map[field.page] ?? -1 }))
      .filter((field) => field.page >= 0)
  } else {
    docState.pageBoxes = await fillPageBoxes(pdfDoc)
    docState.geometryVersion++
    // 页面/合并操作会改变表单控件集合:重新发现,否则合并进来的字段不显示也无法填写
    docState.formFields = await discoverFormFields(pdfDoc)
  }
  docState.currentPage = Math.min(Math.max(docState.currentPage, 1), pdfDoc.numPages)
  if (previous) void destroyPdfDocument(previous)
}

export function closeDocument(): void {
  const doc = docState.pdfDoc
  if (doc) void destroyPdfDocument(doc)
  if (docState.docId) releaseDocEntry(docState.docId)
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
