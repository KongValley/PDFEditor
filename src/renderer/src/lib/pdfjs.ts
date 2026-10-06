import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url'
import { DocRangeTransport } from './range-transport'

export { pdfjs }
export type { PDFDocumentProxy, PDFPageProxy, PageViewport }

// worker 与资源 URL:dev 走 Vite dev server,生产走 app:// 协议(见 main/index.ts)
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// 资源基准 URL 取文档目录(绝对地址,避免 worker 内部相对解析到 assets/ 下)
const assetBase = new URL('./', window.location.href).href

export interface LoadDocumentOptions {
  /** 需要密码时回调:传入密码字符串完成解锁,传入 Error 取消加载 */
  onPassword?: (updatePassword: (password: string | Error) => void, reason: number) => void
}

export async function loadPdfDocument(
  data: ArrayBuffer,
  options: LoadDocumentOptions = {}
): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    data,
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`
  })
  // pdf.js 的密码回调挂在 loadingTask 上(v3/v6 一致)
  if (options.onPassword) task.onPassword = options.onPassword
  return task.promise
}

export interface RangeLoadOptions extends LoadDocumentOptions {
  /** 文件总字节数(交给 pdf.js 作为 rangeTransport.length) */
  length: number
  requestRange: (begin: number, end: number) => Promise<Uint8Array>
}

/** 大文件按需分段加载:不传 data,由 DocRangeTransport 驱动(避免整份字节走 IPC) */
export async function loadPdfDocumentByRange(options: RangeLoadOptions): Promise<PDFDocumentProxy> {
  let fatal: Error | null = null
  let task: PDFDocumentLoadingTask
  const transport = new DocRangeTransport(options.length, options.requestRange, (err) => {
    fatal = err
    void task.destroy()
  })
  task = pdfjs.getDocument({
    range: transport,
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`
  })
  // pdf.js 的密码回调挂在 loadingTask 上(v3/v6 一致)
  if (options.onPassword) task.onPassword = options.onPassword
  try {
    return await task.promise
  } catch (err) {
    // 分段读取失败时 pdf.js 抛的是 AbortException:以真实原因上报
    throw fatal ?? err
  }
}

export interface PageViewportInfo {
  /** CSS 尺寸下的视口(用于坐标换算与覆盖层) */
  viewport: PageViewport
  /** 页面自身旋转(0/90/180/270) */
  pageRotation: number
}

export function getPageViewport(
  page: PDFPageProxy,
  scale: number,
  viewRotation: number
): PageViewportInfo {
  const pageRotation = page.rotate
  const viewport = page.getViewport({ scale, rotation: (pageRotation + viewRotation) % 360 })
  return { viewport, pageRotation }
}
