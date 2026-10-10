import { app, dialog, type BrowserWindow, type OpenDialogReturnValue, type SaveDialogReturnValue } from 'electron'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { uniqueFilePath } from './lib/pdfio'

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

/** 把结果 JSON 写到 PDF_EDITOR_SMOKE_OUT;没设该变量时只打 stderr(宁可不落盘,不静默丢结果) */
export function writeSmokeReport(payload: Record<string, unknown>): void {
  const outPath = process.env['PDF_EDITOR_SMOKE_OUT'] ?? ''
  const text = JSON.stringify(payload, null, 2)
  if (!outPath) {
    console.error(`[smoke] ${text}`)
    return
  }
  try {
    writeFileSync(outPath, text)
  } catch (err) {
    console.error('[smoke] 结果写入失败:', err)
  }
}

let smokeWatchdog: NodeJS.Timeout | undefined

/**
 * 窗口就绪前武装看门狗:窗口建不出来/渲染进程起不来时必须快速失败并落盘。
 * 没有它,外部 runner 只能等到进程级超时(600s+)才强杀,既看不出原因也不生成结果文件。
 */
export function armSmokeWatchdog(ms = 30000): void {
  disarmSmokeWatchdog()
  smokeWatchdog = setTimeout(() => {
    writeSmokeReport({ ok: false, error: '窗口未能创建/渲染进程未就绪' })
    app.exit(1)
  }, ms)
}

/** 渲染层加载完成即解除;重复调用安全 */
export function disarmSmokeWatchdog(): void {
  clearTimeout(smokeWatchdog)
  smokeWatchdog = undefined
}

/**
 * 原生对话框替身(仅当 PDF_EDITOR_SMOKE_DIALOG_DIR 指向目录时安装)。
 * 没有它,「提取页面」「另存为」「打开」这类必须弹原生框的流程在自动化里走不通。
 * 未设该环境变量的步骤不受影响(它们不触发原生框)。
 * 保存:取对话框建议的文件名放进替身目录并去重;打开:返回该目录下第一个 PDF,没有则当作取消。
 */
export function installSmokeDialogs(): void {
  const dir = process.env['PDF_EDITOR_SMOKE_DIALOG_DIR']
  if (!isSmokeMode() || !dir) return
  mkdirSync(dir, { recursive: true })

  const save = async (...args: unknown[]): Promise<SaveDialogReturnValue> => {
    const options = args.find((a) => a && typeof a === 'object' && 'defaultPath' in (a as object)) as
      | { defaultPath?: string }
      | undefined
    return { canceled: false, filePath: uniqueFilePath(dir, basename(options?.defaultPath ?? 'out.pdf')) }
  }
  const open = async (): Promise<OpenDialogReturnValue> => {
    const pdfs = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.pdf'))
    return pdfs.length > 0 ? { canceled: false, filePaths: [join(dir, pdfs[0])] } : { canceled: true, filePaths: [] }
  }

  const target = dialog as unknown as Record<string, unknown>
  target['showSaveDialog'] = save
  target['showOpenDialog'] = open
}

export async function runSmoke(win: BrowserWindow): Promise<void> {
  const scriptPath = process.env['PDF_EDITOR_SMOKE_SCRIPT'] ?? ''
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
    writeSmokeReport(payload)
    console.log('[smoke] ' + JSON.stringify(payload))
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
    // 渲染层没起来时 executeJavaScript 会永远挂着(外部 runner 只能等进程级超时强杀):
    // 加载失败立即落盘并退出,未完成加载则等 did-finish-load(看门狗仍在计时,兜底不会一直等)
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      // -3 = ERR_ABORTED(退出/导航被打断):不是加载失败,否则会把已经写好的结果覆盖成失败
      if (code === -3) return
      writeSmokeReport({ ok: false, error: `渲染层加载失败 ${code} ${desc}` })
      app.exit(1)
    })
    if (win.webContents.isLoading()) {
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
    }
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
