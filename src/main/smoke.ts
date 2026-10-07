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

  /**
   * 进程级度量(仅冒烟):每个 Electron 进程的工作集内存 + CPU 占用。
   * CPU 用运行期间的峰值(settle 后采样必然接近 0,无法反映负载)。
   */
  const cpuPeak = new Map<string, number>()
  const sampler = setInterval(() => {
    for (const m of app.getAppMetrics()) {
      const pct = m.cpu?.percentCPUUsage ?? 0
      if (pct > (cpuPeak.get(m.type) ?? 0)) cpuPeak.set(m.type, pct)
    }
  }, 100)

  const collectMetrics = (): Record<string, unknown> => ({
    processes: app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      rssMB: Math.round(((m.memory?.workingSetSize ?? 0) / 1024) * 10) / 10,
      cpuPeakPercent: Math.round((cpuPeak.get(m.type) ?? 0) * 10) / 10
    })),
    mainCpu: process.getCPUUsage()
  })

  try {
    if (!scriptPath) throw new Error('缺少 PDF_EDITOR_SMOKE_SCRIPT')
    const code = readFileSync(scriptPath, 'utf8')

    // Electron 22 的 Node 16 无 Promise.withResolvers,使用执行器形式
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`冒烟脚本超时(${timeoutMs}ms)`)), timeoutMs)
    })
    // 仓库根目录由主进程注入(渲染进程拿不到 process.env),供脚本内拼接 fixtures 路径
    const rootEnv = `const __smokeRoot = ${JSON.stringify(process.env['PDF_EDITOR_SMOKE_ROOT'] ?? '')};\n`
    const run = win.webContents.executeJavaScript(`(async () => {\n${rootEnv}\n${code}\n})()`, true)
    const result = await Promise.race([run, timeout])
    clearTimeout(timer)

    await new Promise((resolve) => setTimeout(resolve, settleMs))
    await captureShot()
    report({ ok: true, result, metrics: collectMetrics() })
  } catch (err) {
    await captureShot()
    report({ ok: false, error: err instanceof Error ? err.message : String(err), metrics: collectMetrics() })
  } finally {
    clearInterval(sampler)
    app.quit()
  }
}
