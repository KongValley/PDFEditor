import { app, dialog, ipcMain, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDocument, getDocEntry, sidecarPathFor } from './lib/pdfio'
import { applyPageOp } from './lib/docops'
import { getImageBuffer, importImage, readImageBuffer, type ImageImport } from './lib/images'
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

/** 各 IPC handler 的返回结构均含 ok/error,失败时统一返回该形状 */
type OkResult = { ok: boolean; error?: string }

/** 统一兜底:pdf-lib/文件系统异常不应让 IPC 静默 reject(用户会看到"点了没反应") */
async function guard<T extends OkResult>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run()
  } catch (err) {
    console.error('[ipc] 处理失败:', err)
    // 失败结果结构上对所有 OkResult 子类型都成立(ok/error 均为其字段),此处断言安全
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as T
  }
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
    return guard(() => applyPageOp(payload.docId, payload.op))
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
      return guard(() =>
        applyPageOp(payload.docId, {
          kind: 'export',
          pages: payload.pages,
          targetPath: result.filePath ?? ''
        })
      )
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
      return guard<SaveResult>(async () => {
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
      })
    }
  )

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

  ipcMain.handle(
    'app:saveImages',
    async (_e, payload: { names: string[]; dataUrls: string[] }): Promise<SaveResult> => {
      const win = getWindow()
      const options: OpenDialogOptions = {
        title: '选择图片保存目录',
        properties: ['openDirectory', 'createDirectory']
      }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
      const dir = result.filePaths[0]
      return guard<SaveResult>(async () => {
        for (const [i, name] of payload.names.entries()) {
          // 重名不覆盖:stem 后依次追加 -1/-2…
          const dot = name.lastIndexOf('.')
          const stem = dot < 0 ? name : name.slice(0, dot)
          const ext = dot < 0 ? '' : name.slice(dot)
          let target = join(dir, name)
          let n = 1
          while (existsSync(target)) target = join(dir, `${stem}-${n++}${ext}`)
          const base64 = (payload.dataUrls[i] ?? '').split(',')[1] ?? ''
          await writeFile(target, Buffer.from(base64, 'base64'))
        }
        return { ok: true, savedPath: dir }
      })
    }
  )
}
