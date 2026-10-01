import { app, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * 无头冒烟测试工具(仅当 PDF_EDITOR_SMOKE=1 时启用)。
 * 环境变量:
 *   PDF_EDITOR_SMOKE=1            启用
 *   PDF_EDITOR_SMOKE_SCRIPT=path  在渲染进程求值的 JS 文件(顶层允许 await,返回值即结果)
 *   PDF_EDITOR_SMOKE_OUT=path     结果 JSON 输出路径
 *   PDF_EDITOR_SMOKE_SHOT=path    窗口截图 PNG 输出路径(可选)
 *   PDF_EDITOR_SMOKE_TIMEOUT=ms   脚本超时(默认 60000)
 *   PDF_EDITOR_SMOKE_SETTLE=ms    截图前等待渲染稳定(默认 800)
 */
export function isSmokeMode(): boolean {
  return process.env['PDF_EDITOR_SMOKE'] === '1'
}

export async function runSmoke(win: BrowserWindow): Promise<void> {
  const scriptPath = process.env['PDF_EDITOR_SMOKE_SCRIPT'] ?? ''
  const outPath = process.env['PDF_EDITOR_SMOKE_OUT'] ?? ''
  const shotPath = process.env['PDF_EDITOR_SMOKE_SHOT'] ?? ''
  const timeoutMs = Number(process.env['PDF_EDITOR_SMOKE_TIMEOUT'] ?? 60000)
  const settleMs = Number(process.env['PDF_EDITOR_SMOKE_SETTLE'] ?? 800)

  const captureShot = async (): Promise<void> => {
    if (!shotPath) return
    try {
      const image = await win.webContents.capturePage()
      writeFileSync(shotPath, image.toPNG())
    } catch (err) {
      console.error('[smoke] 截图失败:', err)
    }
  }

  const report = (payload: Record<string, unknown>): void => {
    const text = JSON.stringify(payload, null, 2)
    if (outPath) writeFileSync(outPath, text)
    console.log('[smoke] ' + text)
  }

  try {
    if (!scriptPath) throw new Error('缺少 PDF_EDITOR_SMOKE_SCRIPT')
    const code = readFileSync(scriptPath, 'utf8')

    // Electron 22 的 Node 16 无 Promise.withResolvers,使用执行器形式
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`冒烟脚本超时(${timeoutMs}ms)`)), timeoutMs)
    })
    const run = win.webContents.executeJavaScript(`(async () => {\n${code}\n})()`, true)
    const result = await Promise.race([run, timeout])
    clearTimeout(timer)

    await new Promise((resolve) => setTimeout(resolve, settleMs))
    await captureShot()
    report({ ok: true, result })
  } catch (err) {
    await captureShot()
    report({ ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    app.quit()
  }
}
