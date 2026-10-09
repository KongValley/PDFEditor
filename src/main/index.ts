import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { join, normalize } from 'node:path'
import { isRendererDirty, registerIpc, setRendererDirty } from './ipc'
import { cleanupPrintJobs } from './lib/print'
import { installSmokeDialogs, isSmokeMode, runSmoke } from './smoke'

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
      sandbox: false
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
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadURL('app://./index.html')
  }
}

app.whenReady().then(() => {
  registerAppProtocol()
  registerIpc(() => mainWindow)
  createWindow()
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
