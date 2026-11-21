/**
 * HTML → PDF:在隐藏窗口里让 Chromium 排版并用 printToPDF 出 PDF。
 *
 * 为什么不在主进程手写分页:ODF 是可重排文档,段落折行、表格跨页、列表缩进交给
 * Blink 比自写排版引擎可靠得多;Chromium 还会把用到的字体子集嵌进 PDF,中文不依赖
 * 目标机器装了哪些字体。
 *
 * 安全:HTML 只由本模块生成(文本全部转义、图片一律 data:),并加 CSP 禁止外部资源;
 * 窗口 sandbox + 无 nodeIntegration,加载完即销毁。
 */
import { BrowserWindow } from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface HtmlToPdfOptions {
  /** 打印任务名(只用于窗口标题) */
  jobName?: string
  signal?: AbortSignal
  /** 页面尺寸(mm),仅作为 CSS @page 不可用时的兜底 */
  pageWidthMm?: number
  pageHeightMm?: number
}

export type HtmlToPdfResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string; canceled?: boolean }

const READY_TIMEOUT_MS = 20000
/** printToPDF 本身的兜底超时:畸形 HTML 让 Blink 打印卡死时,打开流程不能永远转圈 */
const PRINT_TIMEOUT_MS = 120000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 等字体与图片就绪。图片全是 data URL,正常几十毫秒;这里仍加超时:
 * 畸形 SVG/超大图片解码卡住时,宁可带着缺图继续,也不能让「打开文件」永远转圈。
 */
async function waitForAssets(win: BrowserWindow): Promise<void> {
  const script = `(async () => {
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready } catch (e) {}
    const images = Array.from(document.images || [])
    await Promise.all(images.map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true })
      img.addEventListener('error', resolve, { once: true })
      setTimeout(resolve, 8000)
    })))
    return true
  })()`
  await Promise.race([win.webContents.executeJavaScript(script), delay(READY_TIMEOUT_MS)])
}

export async function htmlToPdf(html: string, options: HtmlToPdfOptions = {}): Promise<HtmlToPdfResult> {
  let dir = ''
  let win: BrowserWindow | null = null
  let printTimer: ReturnType<typeof setTimeout> | null = null
  let aborted = false
  const onAbort = (): void => {
    aborted = true
    if (win && !win.isDestroyed()) win.destroy()
  }
  try {
    dir = await mkdtemp(join(tmpdir(), 'pdf-editor-odf-'))
    const htmlPath = join(dir, 'document.html')
    await writeFile(htmlPath, html, 'utf8')

    win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      title: options.jobName ?? 'ODF',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    if (options.signal?.aborted) return { ok: false, error: '已取消', canceled: true }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    await win.loadFile(htmlPath)
    if (aborted) return { ok: false, error: '已取消', canceled: true }
    await waitForAssets(win)
    if (aborted) return { ok: false, error: '已取消', canceled: true }

    const pageSize =
      options.pageWidthMm && options.pageHeightMm
        ? { width: options.pageWidthMm / 25.4, height: options.pageHeightMm / 25.4 }
        : undefined
    let timeout: ReturnType<typeof setTimeout> | null = null
    const pdf = await Promise.race([
      win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        ...(pageSize ? { pageSize } : {})
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('生成 PDF 超时')), PRINT_TIMEOUT_MS)
        printTimer = timeout
      })
    ])
    if (timeout) clearTimeout(timeout)
    if (aborted) return { ok: false, error: '已取消', canceled: true }
    return { ok: true, bytes: new Uint8Array(pdf) }
  } catch (err) {
    if (aborted || /destroyed|Object has been destroyed/i.test((err as Error)?.message ?? '')) {
      return { ok: false, error: '已取消', canceled: true }
    }
    return { ok: false, error: (err as Error).message || '打印 HTML 失败' }
  } finally {
    if (printTimer) clearTimeout(printTimer)
    options.signal?.removeEventListener('abort', onAbort)
    if (win && !win.isDestroyed()) win.destroy()
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
