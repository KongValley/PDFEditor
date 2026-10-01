import { contextBridge, ipcRenderer } from 'electron'
import type { PdfAPI } from '@shared/api'

const api: PdfAPI = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, callback) => {
    const listener = (_event: unknown, ...args: unknown[]): void => callback(...args)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  // Electron 22 上 File.path 可用(webUtils 需 Electron 32+)
  getPathForFile: (file) => file.path
}

contextBridge.exposeInMainWorld('pdfAPI', api)
