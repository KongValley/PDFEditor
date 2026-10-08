import { app, dialog, ipcMain, shell, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { totalmem } from 'node:os'
import { PDFDocument } from 'pdf-lib'
import {
  openDocument,
  getDocEntry,
  readDocRange,
  readPdfPageCount,
  releaseDocument,
  sidecarPathFor,
  uniqueFilePath
} from './lib/pdfio'
import { applyPageOp, redoPageOp, splitPdfTasks, undoPageOp } from './lib/docops'
import { getImageBuffer, importImage, readImageBuffer, readImageInfo, type ImageImport } from './lib/images'
import { abortPrintJob, addPrintPage, commitPrintJob, preparePrintJob } from './lib/print'
import { getRecentPage, listRecentFiles, setRecentPage } from './lib/recent'
import { isSmokeMode } from './smoke'
import { extractEditorAnnotations, writeAnnotations } from './lib/pdflibwrite'
import type {
  Annotation,
  ChooseFileResult,
  FormValue,
  PageOp,
  PageOpResult,
  RangeReadResult,
  RuntimeInfo,
  SaveResult,
  SidecarData,
  SplitTask,
  SplitTaskResult
} from '@shared/types'

/** 正在跑的拆分任务(供 pdf:splitCancel 置位;任务结束即删除) */
const splitJobs = new Map<string, { cancelled: boolean }>()

function resolveRendererAsset(url: string): string {
  if (url.startsWith('file://')) return fileURLToPath(url)
  const rendererRoot = join(app.getAppPath(), 'out/renderer')
  return join(rendererRoot, url.replace(/^\.?\//, ''))
}

/** 各 IPC handler 的返回结构均含 ok/error,失败时统一返回该形状 */
type OkResult = { ok: boolean; error?: string }

/** 渲染层脏标记(关窗确认用);由渲染层通过 app:setDirty 推送 */
let rendererDirty = false
export function setRendererDirty(value: boolean): void {
  rendererDirty = value
}
export function isRendererDirty(): boolean {
  return rendererDirty
}

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

  ipcMain.handle(
    'doc:readRange',
    (_e, payload: { docId: string; begin: number; end: number }): Promise<RangeReadResult> =>
      guard(() => readDocRange(String(payload?.docId), Number(payload?.begin), Number(payload?.end)))
  )

  ipcMain.handle('doc:release', (_e, docId: string): { ok: boolean } => {
    releaseDocument(docId)
    return { ok: true }
  })

  // 页面操作(合并等)后从主进程 buffer 提取新出现的自产批注(pdf.js 不暴露自定义键)
  ipcMain.handle('doc:getAnnotations', async (_e, docId: string): Promise<{ annotations: Annotation[] }> => {
    const entry = getDocEntry(docId)
    if (!entry || entry.encrypted) return { annotations: [] }
    try {
      const doc = await PDFDocument.load(entry.buffer, { ignoreEncryption: true })
      return { annotations: extractEditorAnnotations(doc) }
    } catch (err) {
      console.warn('[doc:getAnnotations] 解析失败:', err)
      return { annotations: [] }
    }
  })

  ipcMain.handle(
    'pdf:pageCounts',
    async (_e, paths: string[]): Promise<Array<{ path: string; pageCount?: number; error?: string }>> => {
      return Promise.all(paths.map(async (path) => ({ path, ...(await readPdfPageCount(path)) })))
    }
  )

  ipcMain.handle(
    'pdf:splitTasks',
    async (
      _e,
      payload: {
        jobId?: string
        tasks: SplitTask[]
        outputDir: string | null
        includeAnnotations?: boolean
        annotations?: Annotation[]
      }
    ): Promise<SplitTaskResult[]> => {
      const win = getWindow()
      const jobId = payload.jobId ?? ''
      const job = { cancelled: false }
      splitJobs.set(jobId, job)
      try {
        return await splitPdfTasks(
          payload.tasks,
          payload.outputDir,
          {
            includeAnnotations: payload.includeAnnotations,
            annotations: payload.annotations
          },
          {
            onProgress: (info) => win?.webContents.send('pdf:splitProgress', { jobId, ...info }),
            isCancelled: () => job.cancelled
          }
        )
      } finally {
        splitJobs.delete(jobId)
      }
    }
  )

  ipcMain.handle('pdf:splitCancel', (_e, payload: { jobId: string }): { ok: boolean } => {
    const job = splitJobs.get(payload?.jobId ?? '')
    if (!job) return { ok: false }
    job.cancelled = true
    return { ok: true }
  })

  ipcMain.handle('app:chooseDir', async (): Promise<{ canceled: boolean; dir: string }> => {
    const win = getWindow()
    const options: OpenDialogOptions = {
      title: '选择输出目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, dir: '' }
    return { canceled: false, dir: result.filePaths[0] }
  })

  ipcMain.handle('app:openFolder', async (_e, filePath: string): Promise<{ ok: boolean }> => {
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      console.warn('[openFolder] 目录不存在:', dir)
      return { ok: false }
    }
    const error = await shell.openPath(dir)
    if (error) console.warn('[openFolder]', error)
    return { ok: !error }
  })

  ipcMain.handle(
    'app:uniquePath',
    async (_e, payload: { dir: string; name: string }): Promise<{ path: string }> => ({
      path: uniqueFilePath(payload.dir, payload.name)
    })
  )

  ipcMain.handle('pageops:apply', async (_e, payload: { docId: string; op: PageOp }) => {
    return guard(() => applyPageOp(payload.docId, payload.op))
  })

  ipcMain.handle('pageops:undo', async (_e, docId: string): Promise<PageOpResult> => {
    return guard(() => undoPageOp(docId))
  })

  ipcMain.handle('pageops:redo', async (_e, docId: string): Promise<PageOpResult> => {
    return guard(() => redoPageOp(docId))
  })

  ipcMain.handle('app:setDirty', (_e, dirty: boolean): { ok: boolean } => {
    setRendererDirty(dirty)
    return { ok: true }
  })

  ipcMain.handle(
    'pageops:export',
    async (
      _e,
      payload: {
        docId: string
        pages: number[]
        defaultName: string
        includeAnnotations?: boolean
        annotations?: Annotation[]
      }
    ): Promise<PageOpResult> => {
      const win = getWindow()
      const entry = getDocEntry(payload.docId)
      const options = {
        title: '拆分导出所选页面',
        defaultPath: entry ? uniqueFilePath(dirname(entry.path), payload.defaultName) : payload.defaultName,
        filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
      }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' }
      return guard(() =>
        applyPageOp(payload.docId, {
          kind: 'export',
          pages: payload.pages,
          targetPath: result.filePath ?? '',
          includeAnnotations: payload.includeAnnotations,
          annotations: payload.annotations
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

        await mkdir(dirname(targetPath), { recursive: true })

        // D1:明文文档注释只存 PDF /Annots,sidecar 仅保留表单值;加密文档仍走 sidecar 注释
        const sidecar: SidecarData = {
          version: 1,
          annotations: entry.encrypted ? payload.annotations : [],
          formValues: payload.formValues
        }
        const writeSidecar = payload.writeSidecar !== false
        const sidecarPath = sidecarPathFor(targetPath)
        const tmpPath = `${targetPath}.tmp-${Date.now()}`
        const tmpSidecar = `${sidecarPath}.tmp-${Date.now()}`
        const cleanupTmp = async (): Promise<void> => {
          await rm(tmpPath, { force: true }).catch(() => undefined)
          await rm(tmpSidecar, { force: true }).catch(() => undefined)
        }

        try {
          // 先写临时文件再原子替换:任一步失败时原文件保持完好
          if (entry.encrypted) {
            if (writeSidecar) {
              await writeFile(tmpSidecar, JSON.stringify(sidecar, null, 2), 'utf8')
              await rename(tmpSidecar, sidecarPath)
            }
            entry.path = targetPath
            return { ok: true, mode: 'sidecar', savedPath: targetPath }
          }

          const { bytes, warnings } = await writeAnnotations(entry.buffer, {
            annotations: payload.annotations,
            formValues: payload.formValues,
            resolveImage: async (imgId, refPath) => getImageBuffer(imgId) ?? (await readImageBuffer(refPath))
          })
          await writeFile(tmpPath, bytes)
          if (writeSidecar) await writeFile(tmpSidecar, JSON.stringify(sidecar, null, 2), 'utf8')
          await rename(tmpPath, targetPath)
          if (writeSidecar) {
            // PDF 已落盘:sidecar 失败降级为提示,不再谎报整体失败
            try {
              await rename(tmpSidecar, sidecarPath)
            } catch (err) {
              warnings.push(`sidecar 写入失败(PDF 已保存):${(err as Error).message}`)
              await rm(tmpSidecar, { force: true }).catch(() => undefined)
            }
          }
          entry.path = targetPath
          return { ok: true, mode: 'pdf', savedPath: targetPath, warnings }
        } catch (err) {
          await cleanupTmp()
          throw err
        }
      })
    }
  )

  ipcMain.handle('app:readWorkerScript', async (_e, url: string): Promise<string> => {
    const path = resolveRendererAsset(url)
    return readFile(path, 'utf8')
  })

  ipcMain.handle('app:printPrepare', (_e, payload: Parameters<typeof preparePrintJob>[0]) =>
    guard(() => preparePrintJob(payload))
  )

  ipcMain.handle('app:printAddPage', (_e, payload: Parameters<typeof addPrintPage>[0]) =>
    guard(() => addPrintPage(payload))
  )

  ipcMain.handle('app:printCommit', (_e, payload: { jobId: string; dryRun?: boolean }) =>
    guard(() => commitPrintJob(payload))
  )

  ipcMain.handle('app:printAbort', (_e, jobId: string) => guard(() => abortPrintJob(String(jobId))))

  ipcMain.handle(
    'app:runtimeInfo',
    (): RuntimeInfo => ({
      smoke: isSmokeMode(),
      version: app.getVersion(),
      arch: process.arch,
      totalMemMB: Math.round(totalmem() / 1048576),
      // 物理内存 ≤ 4GB 的机器走"省内存"档,避免与开发机同参数
      lowMem: totalmem() <= 4 * 1024 * 1024 * 1024
    })
  )

  ipcMain.handle('app:recentGet', (_e, filePath: string) =>
    guard(async () => ({ ok: true, page: await getRecentPage(String(filePath)) }))
  )

  ipcMain.handle('app:recentList', async (): Promise<Array<{ path: string; page: number; at: number }>> => {
    return listRecentFiles()
  })

  ipcMain.handle('app:setTitle', (_e, title: string): { ok: boolean } => {
    getWindow()?.setTitle(String(title ?? ''))
    return { ok: true }
  })

  ipcMain.handle('app:recentSet', async (_e, payload: { path: string; page: number }) => {
    if (!payload?.path || !(payload.page > 0)) return { ok: false, error: '无效的阅读位置' }
    await setRecentPage(payload.path, Math.round(payload.page))
    return { ok: true }
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
    return readImageInfo(refPath)
  })

  ipcMain.handle(
    'app:saveImage',
    async (_e, payload: { defaultName: string; dataUrl: string; dir?: string }): Promise<SaveResult> => {
      const base64 = payload.dataUrl.split(',')[1] ?? ''
      // 冒烟:保存对话框会挂起渲染层的 executeJavaScript,直接落盘到项目 tmp 供断言
      if (isSmokeMode()) {
        const dir = join(app.getAppPath(), 'tmp')
        await mkdir(dir, { recursive: true })
        const target = join(dir, payload.defaultName)
        await writeFile(target, Buffer.from(base64, 'base64'))
        return { ok: true, savedPath: target }
      }
      const win = getWindow()
      const options = {
        title: '导出图片',
        defaultPath: payload.dir ? uniqueFilePath(payload.dir, payload.defaultName) : payload.defaultName,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
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
