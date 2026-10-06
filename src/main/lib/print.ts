import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type PrintResult = { ok: boolean; canceled?: boolean; error?: string; pageCount?: number; html?: string }

interface PrintJob {
  dir: string
  jobName: string
  sizesMm: Array<{ w: number; h: number }>
  files: Array<string | null>
}

const jobs = new Map<string, PrintJob>()

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 建任务:创建临时目录,登记 N 个页槽 */
export async function preparePrintJob(payload: {
  jobName: string
  pageCount: number
  sizesMm: Array<{ w: number; h: number }>
}): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const pageCount = Math.floor(Number(payload?.pageCount))
  if (!Number.isFinite(pageCount) || pageCount <= 0) return { ok: false, error: '没有可打印的页面' }
  const dir = await mkdtemp(join(tmpdir(), 'pdf-editor-print-'))
  const jobId = randomUUID()
  jobs.set(jobId, {
    dir,
    jobName: payload.jobName || 'PDF 打印',
    sizesMm: Array.isArray(payload.sizesMm) ? payload.sizesMm : [],
    files: new Array(pageCount).fill(null)
  })
  return { ok: true, jobId }
}

/** 逐页落盘(渲染层每页渲染完立即调用,内存峰值只占一页;bytes = PNG 原始字节) */
export async function addPrintPage(payload: {
  jobId: string
  index: number
  bytes: Uint8Array
}): Promise<{ ok: boolean; error?: string }> {
  const job = jobs.get(payload?.jobId)
  if (!job) return { ok: false, error: '打印任务已过期' }
  const index = Math.floor(Number(payload.index))
  if (!Number.isFinite(index) || index < 0 || index >= job.files.length) return { ok: false, error: '打印页码越界' }
  const file = join(job.dir, `page-${index + 1}.png`)
  await writeFile(file, payload.bytes)
  job.files[index] = file
  return { ok: true }
}

/** 放弃任务并清理临时目录 */
export async function abortPrintJob(jobId: string): Promise<{ ok: boolean }> {
  const job = jobs.get(jobId)
  if (!job) return { ok: true }
  jobs.delete(jobId)
  await rm(job.dir, { recursive: true, force: true })
  return { ok: true }
}

/** 提交任务:组装打印 HTML → 隐藏窗口弹系统打印对话框(dryRun 只返回 HTML) */
export async function commitPrintJob(payload: { jobId: string; dryRun?: boolean }): Promise<PrintResult> {
  const job = jobs.get(payload?.jobId)
  if (!job) return { ok: false, error: '打印任务已过期' }
  try {
    if (job.files.some((file) => !file)) return { ok: false, error: '打印页面不完整' }
    const files = job.files as string[]
    const first = job.sizesMm[0]
    const size = first && first.w > 0 && first.h > 0 ? `${first.w.toFixed(1)}mm ${first.h.toFixed(1)}mm` : 'auto'
    const html = [
      '<!DOCTYPE html><html><head><meta charset="utf-8">',
      `<title>${escapeHtml(job.jobName)}</title>`,
      '<style>',
      `@page { size: ${size}; margin: 0; }`,
      'html, body { margin: 0; padding: 0; }',
      'img { display: block; width: 100%; page-break-after: always; }',
      'img:last-child { page-break-after: auto; }',
      '</style></head><body>',
      files.map((file) => `<img src="${pathToFileURL(file).href}">`).join(''),
      '</body></html>'
    ].join('')
    if (payload.dryRun) return { ok: true, pageCount: files.length, html }
    const htmlPath = join(job.dir, 'print.html')
    await writeFile(htmlPath, html, 'utf8')
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true } })
    try {
      await win.loadFile(htmlPath)
      // 图片解码完成前打印会出空白页
      await win.webContents.executeJavaScript(
        'Promise.all([...document.images].map((img) => img.complete ? 1 : new Promise((r) => { img.onload = r; img.onerror = r })))'
      )
      const result = await new Promise<{ success: boolean; reason: string }>((resolve) => {
        // 作业名由打印 HTML 的 <title> 提供(Electron 22 的 print 选项无 jobName)
        win.webContents.print({ silent: false, printBackground: true }, (success, failureReason) =>
          resolve({ success, reason: failureReason ?? '' })
        )
      })
      if (result.success) return { ok: true }
      if (/cancel/i.test(result.reason)) return { ok: false, canceled: true }
      return { ok: false, error: result.reason || '打印失败' }
    } finally {
      win.destroy()
    }
  } finally {
    jobs.delete(payload.jobId)
    await rm(job.dir, { recursive: true, force: true })
  }
}

/** 退出时清理所有未完成任务(渲染层崩溃/中途退出) */
export function cleanupPrintJobs(): void {
  for (const [jobId, job] of jobs) {
    jobs.delete(jobId)
    void rm(job.dir, { recursive: true, force: true })
  }
}
