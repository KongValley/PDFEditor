import { BrowserWindow } from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface PrintPayload {
  jobName: string
  dataUrls: string[]
  sizesMm: Array<{ w: number; h: number }>
  /** 冒烟用:只生成打印 HTML 并返回,不打开打印对话框 */
  dryRun?: boolean
}

export type PrintResult = { ok: boolean; canceled?: boolean; error?: string; pageCount?: number; html?: string }

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 逐页 PNG → 打印 HTML → 系统打印对话框(隐藏窗口;每页一张,纵向铺满纸张宽度) */
export async function printImages(payload: PrintPayload): Promise<PrintResult> {
  const images = Array.isArray(payload.dataUrls) ? payload.dataUrls : []
  if (images.length === 0) return { ok: false, error: '没有可打印的页面' }
  const dir = await mkdtemp(join(tmpdir(), 'pdf-editor-print-'))
  try {
    const files: string[] = []
    for (const [i, dataUrl] of images.entries()) {
      const file = join(dir, `page-${i + 1}.png`)
      await writeFile(file, Buffer.from(String(dataUrl).split(',')[1] ?? '', 'base64'))
      files.push(file)
    }
    const first = payload.sizesMm?.[0]
    const size = first && first.w > 0 && first.h > 0 ? `${first.w.toFixed(1)}mm ${first.h.toFixed(1)}mm` : 'auto'
    const html = [
      '<!DOCTYPE html><html><head><meta charset="utf-8">',
      `<title>${escapeHtml(payload.jobName)}</title>`,
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
    const htmlPath = join(dir, 'print.html')
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
    await rm(dir, { recursive: true, force: true })
  }
}
