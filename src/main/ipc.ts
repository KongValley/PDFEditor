import { app, dialog, ipcMain, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDocument, getDocEntry, sidecarPathFor } from './lib/pdfio'
import { applyPageOp } from './lib/docops'
import { getImageBuffer, importImage, readImageBuffer, type ImageImport } from './lib/images'
import { getFormFields } from './lib/forms'
import { writeAnnotations } from './lib/pdflibwrite'
import type {
  Annotation,
  ChooseFileResult,
  FormValue,
  PageOp,
  PageOpResult,
  SaveResult,
  SidecarData
} from '@shared/types'

function resolveRendererAsset(url: string): string {
  if (url.startsWith('file://')) return fileURLToPath(url)
  const rendererRoot = join(app.getAppPath(), 'out/renderer')
  return join(rendererRoot, url.replace(/^\.?\//, ''))
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('app:chooseFile', async (_e, multi: boolean): Promise<ChooseFileResult> => {
    const options: OpenDialogOptions = {
      title: '打开 PDF 文件',
      filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile']
    }
    const win = getWindow()
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return { canceled: result.canceled, paths: result.filePaths }
  })

  ipcMain.handle('doc:open', async (_e, filePath: string) => openDocument(filePath))

  ipcMain.handle('pageops:apply', async (_e, payload: { docId: string; op: PageOp }) => {
    return applyPageOp(payload.docId, payload.op)
  })

  ipcMain.handle(
    'pageops:export',
    async (_e, payload: { docId: string; pages: number[]; defaultName: string }): Promise<PageOpResult> => {
      const win = getWindow()
      const options = {
        title: '拆分导出所选页面',
        defaultPath: payload.defaultName,
        filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
      }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' }
      return applyPageOp(payload.docId, {
        kind: 'export',
        pages: payload.pages,
        targetPath: result.filePath
      })
    }
  )

  ipcMain.handle(
    'save:saveAs',
    async (
      _e,
      payload: {
        docId: string
        defaultPath: string
        annotations: Annotation[]
        formValues: Record<string, FormValue>
        /** 直接写入指定路径(跳过保存对话框) */
        targetPath?: string
        /** 是否同时写 sidecar(默认 true) */
        writeSidecar?: boolean
      }
    ): Promise<SaveResult> => {
      const entry = getDocEntry(payload.docId)
      if (!entry) return { ok: false, error: '文档未打开' }

      let targetPath = payload.targetPath ?? ''
      if (!targetPath) {
        const win = getWindow()
        const options = {
          title: '保存 PDF',
          defaultPath: payload.defaultPath,
          filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
        }
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return { ok: false, canceled: true }
        targetPath = result.filePath
      }

      const sidecar: SidecarData = {
        version: 1,
        annotations: payload.annotations,
        formValues: payload.formValues
      }
      const writeSidecar = payload.writeSidecar !== false

      // 加密文档:无法解密重写,只保存 sidecar
      if (entry.encrypted) {
        if (writeSidecar) await writeFile(sidecarPathFor(targetPath), JSON.stringify(sidecar, null, 2), 'utf8')
        return { ok: true, mode: 'sidecar', savedPath: targetPath }
      }

      const { bytes, warnings } = await writeAnnotations(entry.buffer, {
        annotations: payload.annotations,
        formValues: payload.formValues,
        resolveImage: async (imgId, refPath) => getImageBuffer(imgId) ?? (await readImageBuffer(refPath))
      })
      await writeFile(targetPath, bytes)
      if (writeSidecar) await writeFile(sidecarPathFor(targetPath), JSON.stringify(sidecar, null, 2), 'utf8')
      return { ok: true, mode: 'pdf', savedPath: targetPath, warnings }
    }
  )

  ipcMain.handle('form:getFields', async (_e, docId: string) => {
    return getFormFields(docId)
  })

  ipcMain.handle('app:readWorkerScript', async (_e, url: string): Promise<string> => {
    const path = resolveRendererAsset(url)
    return readFile(path, 'utf8')
  })

  ipcMain.handle('img:choose', async (): Promise<ImageImport | { canceled: true }> => {
    const win = getWindow()
    const options: OpenDialogOptions = {
      title: '选择图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }],
      properties: ['openFile']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return importImage(result.filePaths[0])
  })

  ipcMain.handle('img:getByPath', async (_e, refPath: string): Promise<ImageImport> => {
    return importImage(refPath)
  })

  ipcMain.handle(
    'app:saveImage',
    async (_e, payload: { defaultName: string; dataUrl: string }): Promise<SaveResult> => {
      const win = getWindow()
      const options = {
        title: '导出图片',
        defaultPath: payload.defaultName,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      const base64 = payload.dataUrl.split(',')[1] ?? ''
      await writeFile(result.filePath, Buffer.from(base64, 'base64'))
      return { ok: true, savedPath: result.filePath }
    }
  )
}
