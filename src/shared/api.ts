/** preload 暴露给渲染进程的 API 契约 */
export interface PdfAPI {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void
  /** 拖放文件取磁盘路径(Electron 22 上 File.path 可用) */
  getPathForFile: (file: File) => string
}

declare global {
  interface File {
    /** Electron 22(<32)专有属性:拖放文件的磁盘路径 */
    path: string
  }
}
