import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { totalmem } from 'node:os'
import { join, normalize } from 'node:path'
import { isRendererDirty, registerIpc, setRendererDirty } from './ipc'
import { cleanupPrintJobs } from './lib/print'
import { initLogger, logEvent } from './lib/logger'
import {
  armSmokeWatchdog,
  disarmSmokeWatchdog,
  installSmokeDialogs,
  isSmokeMode,
  runSmoke,
  writeSmokeReport
} from './smoke'

// 内网 32 位老机器优先稳定:默认禁用硬件加速(老显卡驱动黑屏/崩溃)。
// 有独立显卡的新机器可用 PDF_EDITOR_HWACCEL=1 打开 —— 软件光栅之外最大的吞吐杠杆。
// ipc.ts 的「环境自检」要显示渲染模式,但 index.ts 已 import ipc.ts,反向 import 会成环,
// 故那边自行读同一个环境变量(两处判定表达式必须保持一致)。
export const gpuDisabled = process.env['PDF_EDITOR_HWACCEL'] !== '1'
if (gpuDisabled) app.disableHardwareAcceleration()
// 冒烟专用:设了 PDF_EDITOR_SMOKE_DIALOG_DIR 才把原生对话框换成确定性应答
installSmokeDialogs()
// 32 位进程地址空间有限(2GB),堆上限收紧到 512MB 避免地址空间耗尽;64 位放宽到 1GB
app.commandLine.appendSwitch(
  'js-flags',
  process.arch === 'ia32' ? '--max-old-space-size=512' : '--max-old-space-size=1024'
)

// 双击启动(无终端)时 stdout/stderr 可能已断开,任何 console 写入都会抛 EPIPE 并弹出
// "A JavaScript error occurred in the main process";挂 error 监听把写失败降级为忽略
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {
    /* 忽略 EPIPE 等写入错误 */
  })
}

// 未捕获异常只记录、不退出:内网用户没有控制台,进程静默消失比崩溃更难查
// (日志目录在 whenReady 里确定,此前的异常会被丢弃而不是写到工作目录)
process.on('uncaughtException', (err) => {
  logEvent('error', 'app', '未捕获异常', { error: String(err?.message ?? err) })
})
process.on('unhandledRejection', (reason) => {
  logEvent('error', 'app', '未处理的 Promise 拒绝', { error: String(reason) })
})

// 生产环境经 app:// 提供渲染资源(Electron 22 无 protocol.handle,使用 registerFileProtocol)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }
])

function registerAppProtocol(): void {
  const rendererRoot = normalize(join(app.getAppPath(), 'out/renderer'))
  protocol.registerFileProtocol('app', (request, callback) => {
    const url = new URL(request.url)
    const filePath = normalize(join(rendererRoot, decodeURIComponent(url.pathname)))
    // 路径穿越防护:越界时返回不存在的路径(Chromium 按 404 处理)
    const safePath = filePath.startsWith(rendererRoot) ? filePath : join(rendererRoot, '__forbidden__')
    callback({ path: safePath })
  })
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'PDF 编辑器',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e222b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 冒烟:窗口不在前台时 rAF 会被节流 → 首屏永不绘制(表现为 layers=0 的白屏)
      ...(isSmokeMode() ? { backgroundThrottling: false } : {})
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 未保存改动时拦截关窗(冒烟模式跳过,避免阻塞 app.quit)
  mainWindow.on('close', (event) => {
    const win = mainWindow
    if (isSmokeMode() || !win || !isRendererDirty()) return
    event.preventDefault()
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: '未保存的更改',
        message: '当前文档有未保存的更改',
        detail: '直接关闭将丢失这些更改。',
        buttons: ['取消', '不保存并关闭'],
        defaultId: 0,
        cancelId: 0
      })
      .then(({ response }) => {
        if (response === 1) {
          setRendererDirty(false)
          win.destroy()
        }
      })
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 渲染进程日志转发到主进程 stdout(仅开发/冒烟:正式运行时 stdout 可能不可用)
  if (isSmokeMode() || process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.webContents.on('console-message' as never, (...args: unknown[]) => {
      const second = args[1]
      if (second && typeof second === 'object' && 'message' in (second as object)) {
        const d = second as { level?: unknown; message?: unknown; lineNumber?: unknown }
        console.log(`[renderer] ${String(d.level)} ${String(d.message)}`)
      } else {
        console.log(`[renderer] ${String(args[1])} ${String(args[2])}`)
      }
    })
  }

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] 进程崩溃:', details.reason)
    logEvent('error', 'app', '渲染进程退出', { error: details.reason })
    // 冒烟:渲染进程没了就再也等不到脚本结果,立刻落盘失败原因并退出(而不是等外部强杀)
    if (isSmokeMode() && details.reason !== 'clean-exit') {
      writeSmokeReport({ ok: false, error: `渲染进程崩溃:${details.reason}` })
      app.exit(1)
    }
  })

  // 渲染层加载完成 = 冒烟看门狗解除(窗口创建/加载失败由看门狗与 did-fail-load 兜底)
  if (isSmokeMode()) {
    mainWindow.webContents.once('did-finish-load', () => disarmSmokeWatchdog())
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadURL('app://./index.html')
  }
}

app.whenReady().then(() => {
  // 日志放在 ready 之后定目录:`--user-data-dir` 覆盖在 ready 时才反映到 getPath('userData'),
  // 提前初始化会把日志写到默认目录(冒烟用临时目录时就对不上了)
  initLogger({
    dir: process.env['PDF_EDITOR_LOG_DIR'] ?? join(app.getPath('userData'), 'logs'),
    level: process.env['PDF_EDITOR_LOG']
  })
  logEvent('info', 'app', '启动', {
    version: app.getVersion(),
    arch: process.arch,
    electron: process.versions.electron ?? '',
    lowMem: totalmem() <= 4 * 1024 * 1024 * 1024
  })
  // 冒烟:窗口还没建好就先武装看门狗,建不出来时 30s 内落盘失败原因并退出
  if (isSmokeMode()) armSmokeWatchdog()
  try {
    registerAppProtocol()
    registerIpc(() => mainWindow)
    createWindow()
  } catch (err) {
    logEvent('error', 'app', '启动失败', { error: err instanceof Error ? err.message : String(err) })
    if (isSmokeMode()) {
      writeSmokeReport({ ok: false, error: `主进程启动失败:${err instanceof Error ? err.message : String(err)}` })
      app.exit(1)
    }
    throw err
  }
  if (isSmokeMode() && mainWindow) {
    void runSmoke(mainWindow)
    return
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  cleanupPrintJobs()
})
