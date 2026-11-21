/**
 * ODF → PDF 入口:解析包 → 生成 HTML → 隐藏窗口 printToPDF。
 *
 * 产物是真 PDF(文字可检索、可批注、可继续走页面操作/打印/导出),与 OFD 导入保持
 * 同一套「转换后进入现有编辑流程」的语义。
 */
import { PDFDocument } from 'pdf-lib'
import type { OdfConvertResult } from '../../../shared/types'
import { buildOdfHtml } from './html'
import { readOdfPackage, readOdfTitle } from './package'
import { htmlToPdf } from './printpdf'

export interface OdfConvertOptions {
  /** 转换进度(0/1 → 1/1;printToPDF 不报页进度,只用来把界面从「读取」切到「转换」) */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export async function convertOdfToPdf(buffer: Uint8Array, options: OdfConvertOptions = {}): Promise<OdfConvertResult> {
  const warnings: string[] = []
  let parsed: ReturnType<typeof readOdfPackage>
  try {
    parsed = readOdfPackage(buffer)
  } catch (err) {
    return { ok: false, error: `无法解析 ODF:${(err as Error).message}`, warnings }
  }
  if (!parsed.ok) return { ok: false, error: parsed.error, warnings }

  const title = readOdfTitle(parsed.pkg)
  let html: ReturnType<typeof buildOdfHtml>
  try {
    html = buildOdfHtml(parsed.pkg, { title })
  } catch (err) {
    return { ok: false, error: `ODF 转换失败:${(err as Error).message}`, warnings }
  }
  warnings.push(...html.warnings)

  options.onProgress?.(0, 1)
  const printed = await htmlToPdf(html.html, {
    jobName: title || 'ODF 文档',
    signal: options.signal,
    pageWidthMm: html.pageWidthMm,
    pageHeightMm: html.pageHeightMm
  })
  if (!printed.ok) {
    if (printed.canceled) return { ok: false, error: 'canceled', warnings }
    return { ok: false, error: `ODF 转换失败:${printed.error}`, warnings }
  }
  options.onProgress?.(1, 1)

  // 页数交给 pdf-lib 读:后续打开流程本来就会再解析一次,这里只为了返回准确的页数
  let pages = 0
  try {
    pages = (await PDFDocument.load(printed.bytes, { ignoreEncryption: true })).getPageCount()
  } catch {
    pages = 0
  }
  if (pages === 0) {
    return { ok: false, error: 'ODF 转换失败:生成的 PDF 没有页面', warnings }
  }
  return { ok: true, bytes: printed.bytes, pages, warnings }
}
