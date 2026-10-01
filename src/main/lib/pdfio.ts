import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import type { OpenResult, SidecarData } from '@shared/types'

export interface DocEntry {
  path: string
  buffer: Buffer
  encrypted: boolean
  pageCount: number
}

const docs = new Map<string, DocEntry>()

/** 主进程文档缓存上限(低内存机器:避免多开文档累积整份 buffer) */
const MAX_DOCS = 3

function evictDocs(): void {
  while (docs.size > MAX_DOCS) {
    const oldest = docs.keys().next().value
    if (oldest === undefined) break
    docs.delete(oldest)
  }
}

export function getDocEntry(docId: string): DocEntry | undefined {
  return docs.get(docId)
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
    if (!Array.isArray(data.annotations)) return null
    return { version: data.version ?? 1, annotations: data.annotations, formValues: data.formValues ?? {} }
  } catch (err) {
    console.warn('[sidecar] 解析失败:', err)
    return null
  }
}

export function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
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
  try {
    // 用 ignoreEncryption 加载并读取 isEncrypted:pdf-lib 的 EncryptedPDFError 在
    // CJS/ES5 构建下 instanceof 判定不可靠(Error.call 返回新对象导致原型丢失)
    const parsed = await PDFDocument.load(buffer, { ignoreEncryption: true })
    encrypted = parsed.isEncrypted
    pageCount = parsed.getPageCount()
  } catch (err) {
    return { ok: false, error: 'corrupt', errorMessage: `无法解析 PDF:${(err as Error).message}` }
  }

  const docId = randomUUID()
  docs.set(docId, { path: filePath, buffer, encrypted, pageCount })
  evictDocs()
  return {
    ok: true,
    docId,
    path: filePath,
    buffer: toArrayBuffer(buffer),
    pageCount,
    encrypted,
    sidecar: readSidecar(filePath)
  }
}
