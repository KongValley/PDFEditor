import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('pdfAPI', api)
