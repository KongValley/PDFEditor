/** preload 暴露给渲染进程的 API 契约 */
export interface PdfAPI {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void
  /** 拖放文件取磁盘路径(Electron 32+ 需经 webUtils) */
  getPathForFile: (file: File) => string
}
