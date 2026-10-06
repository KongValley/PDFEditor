import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import type { Annotation, OpenResult, SidecarData } from '@shared/types'
import { extractEditorAnnotations } from './pdflibwrite'

export interface DocEntry {
  path: string
  buffer: Buffer
  encrypted: boolean
  pageCount: number
  /** 页面操作快照栈(撤销/重做);与渲染层 page 历史条目 LIFO 对齐 */
  undoBuffers: Array<{ buffer: Buffer; pageCount: number }>
  redoBuffers: Array<{ buffer: Buffer; pageCount: number }>
  /** 渲染层正以 range 方式读取:evictDocs 跳过(否则分段读取会读到错误内容) */
  pinned?: boolean
}

const docs = new Map<string, DocEntry>()

/** 主进程文档缓存上限(低内存机器:避免多开文档累积整份 buffer) */
const MAX_DOCS = 3

/** ≥ 该值且非加密时,渲染层改用按需分段读取(避免整份字节走 IPC);小文件走原路以免无谓分块 */
export const RANGE_MIN_FILE_SIZE = 8 * 1024 * 1024

function evictDocs(): void {
  while (docs.size > MAX_DOCS) {
    let victim: string | undefined
    for (const [id, entry] of docs) {
      if (!entry.pinned) {
        victim = id
        break
      }
    }
    if (victim === undefined) return
    docs.delete(victim)
  }
}

export function getDocEntry(docId: string): DocEntry | undefined {
  return docs.get(docId)
}

/** 释放文档缓存条目(渲染层加载失败/取消时的兜底,避免打开失败占满缓存淘汰旧文档) */
export function releaseDocument(docId: string): void {
  docs.delete(docId)
}

export function setDocBuffer(docId: string, buffer: Buffer, pageCount: number): void {
  const entry = docs.get(docId)
  if (!entry) return
  entry.buffer = buffer
  entry.pageCount = pageCount
}

/** sidecar 路径:report.pdf → report.pdfanno.json */
export function sidecarPathFor(pdfPath: string): string {
  return `${pdfPath}anno.json`
}

export function readSidecar(pdfPath: string): SidecarData | null {
  const path = sidecarPathFor(pdfPath)
  if (!existsSync(path)) return null
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const data = raw as Partial<SidecarData>
    if (data.annotations !== undefined && !Array.isArray(data.annotations)) {
      // annotations 类型异常不应连 formValues 一起丢弃
      console.warn('[sidecar] annotations 字段类型异常,按空处理:', path)
    }
    return {
      version: data.version ?? 1,
      annotations: Array.isArray(data.annotations) ? data.annotations : [],
      formValues: data.formValues && typeof data.formValues === 'object' ? data.formValues : {}
    }
  } catch (err) {
    console.warn('[sidecar] 解析失败:', err)
    return null
  }
}

export function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

/** 同名文件自动改名:目标已存在时依次尝试 <stem>-1<ext>、<stem>-2<ext>…(与导出多图逻辑一致) */
export function uniqueFilePath(dir: string, fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const stem = dot <= 0 ? fileName : fileName.slice(0, dot)
  const ext = dot <= 0 ? '' : fileName.slice(dot)
  let target = join(dir, fileName)
  let n = 1
  while (existsSync(target)) target = join(dir, `${stem}-${n++}${ext}`)
  return target
}

const SNAPSHOT_MAX_COUNT = 5
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024
const SNAPSHOT_SKIP_ABOVE = 128 * 1024 * 1024

/** 限制快照栈:条数 ≤5 且总量 ≤64MB(至少保 1 条) */
export function pruneBufferStack(stack: Array<{ buffer: Buffer; pageCount: number }>): void {
  const total = (): number => stack.reduce((sum, item) => sum + item.buffer.byteLength, 0)
  while ((stack.length > SNAPSHOT_MAX_COUNT || total() > SNAPSHOT_MAX_BYTES) && stack.length > 1) {
    stack.shift()
  }
}

/** 页面操作前记录当前 buffer 快照;超大文档(>128MB)不记快照,返回是否已记录 */
export function pushBufferSnapshot(entry: DocEntry): boolean {
  if (entry.buffer.byteLength > SNAPSHOT_SKIP_ABOVE) return false
  entry.undoBuffers.push({ buffer: entry.buffer, pageCount: entry.pageCount })
  entry.redoBuffers.length = 0
  pruneBufferStack(entry.undoBuffers)
  return true
}

/** 读取任意 PDF 的页数(不进入文档缓存);加密或损坏返回 error */
export async function readPdfPageCount(
  filePath: string
): Promise<{ pageCount: number } | { error: string }> {
  let buffer: Buffer
  try {
    buffer = await readFile(filePath)
  } catch (err) {
    return { error: `无法读取文件:${(err as Error).message}` }
  }
  try {
    const parsed = await PDFDocument.load(buffer, { ignoreEncryption: true })
    if (parsed.isEncrypted) return { error: '加密文档不支持合并' }
    return { pageCount: parsed.getPageCount() }
  } catch {
    return { error: '无法解析 PDF' }
  }
}

export async function openDocument(filePath: string): Promise<OpenResult> {
  let buffer: Buffer
  try {
    buffer = await readFile(filePath)
  } catch (err) {
    return { ok: false, error: 'unknown', errorMessage: `无法读取文件:${(err as Error).message}` }
  }

  let encrypted = false
  let pageCount = 0
  let annotations: Annotation[] = []
  try {
    // 用 ignoreEncryption 加载并读取 isEncrypted:pdf-lib 的 EncryptedPDFError 在
    // CJS/ES5 构建下 instanceof 判定不可靠(Error.call 返回新对象导致原型丢失)
    const parsed = await PDFDocument.load(buffer, { ignoreEncryption: true })
    encrypted = parsed.isEncrypted
    pageCount = parsed.getPageCount()
    // 加密文档不提取(无法可靠解析批注结构,沿用 sidecar 注释)
    if (!encrypted) annotations = extractEditorAnnotations(parsed)
  } catch (err) {
    return { ok: false, error: 'corrupt', errorMessage: `无法解析 PDF:${(err as Error).message}` }
  }

  const useRange = !encrypted && buffer.byteLength >= RANGE_MIN_FILE_SIZE
  // 只有当前文档可能被 range 读取:新开文档时解除其它文档的 pin,否则淘汰会失效
  for (const other of docs.values()) other.pinned = false
  const docId = randomUUID()
  docs.set(docId, {
    path: filePath,
    buffer,
    encrypted,
    pageCount,
    undoBuffers: [],
    redoBuffers: [],
    pinned: useRange
  })
  evictDocs()
  return {
    ok: true,
    docId,
    path: filePath,
    buffer: useRange ? undefined : toArrayBuffer(buffer),
    fileSize: buffer.byteLength,
    stream: useRange ? 'range' : 'buffer',
    pageCount,
    encrypted,
    annotations,
    sidecar: readSidecar(filePath)
  }
}

/** 读取当前文档的字节区间(渲染层 range 流式加载用);未知 docId 返回错误 */
export function readDocRange(
  docId: string,
  begin: number,
  end: number
): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  const entry = docs.get(docId)
  if (!entry) return { ok: false, error: '文档已关闭' }
  const total = entry.buffer.byteLength
  const from = Math.max(0, Math.min(Math.floor(begin), total))
  const to = Math.max(from, Math.min(Math.floor(end), total))
  // 复制而非视图:避免 Buffer 池化内存随 IPC 外泄
  return { ok: true, bytes: new Uint8Array(entry.buffer.subarray(from, to)) }
}
