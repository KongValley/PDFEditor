import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { extname, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { isSmokeMode, runSmoke } from './smoke'

// 生产环境经 app:// 提供渲染资源(支持 fetch / worker / 正确的 MIME)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }
])

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.bcmap': 'application/octet-stream'
}

function mimeFor(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function registerAppProtocol(): void {
  const rendererRoot = normalize(join(app.getAppPath(), 'out/renderer'))
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    const filePath = normalize(join(rendererRoot, decodeURIComponent(url.pathname)))
    if (!filePath.startsWith(rendererRoot)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const res = await net.fetch(pathToFileURL(filePath).toString())
      if (!res.ok) return new Response('Not Found', { status: 404 })
      return new Response(res.body, {
        status: res.status,
        headers: { 'Content-Type': mimeFor(filePath) }
      })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
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

  // 渲染进程日志转发到主进程 stdout,便于冒烟验证
  mainWindow.webContents.on('console-message' as never, (...args: unknown[]) => {
    const second = args[1]
    if (second && typeof second === 'object' && 'message' in (second as object)) {
      const d = second as { level?: unknown; message?: unknown; lineNumber?: unknown }
      console.log(`[renderer] ${String(d.level)} ${String(d.message)}`)
    } else {
      console.log(`[renderer] ${String(args[1])} ${String(args[2])}`)
    }
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] 进程崩溃:', details.reason)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadURL('app://bundle/index.html')
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
