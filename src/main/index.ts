import { app, BrowserWindow, protocol, shell } from 'electron'
import { join, normalize } from 'node:path'
import { registerIpc } from './ipc'
import { isSmokeMode, runSmoke } from './smoke'

// 内网 32 位老机器优先稳定:禁用硬件加速(避免老显卡驱动导致的黑屏/崩溃)
app.disableHardwareAcceleration()
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
