import type {
  Annotation,
  AppendFileSpec,
  ChooseFileResult,
  ImageInfo,
  PageOp,
  PageOpResult,
  SaveResult,
  SplitTaskResult
} from '@shared/types'
import { docState, editVersion, getPage, markDirty, openByPath, reloadDocument } from '../store/document'
import {
  annotState,
  applyPageMap,
  exportAnnotations,
  importAnnotations,
  pushPageHistory,
  resetAnnotations,
  setImageUrl
} from '../store/annotations'
import {
  commitOpenEditor,
  requestMergeWork,
  requestPagesRange,
  requestPassword,
  requestSplitWork,
  showToast,
  type MergeRequest,
  type PdfFileEntry
} from '../store/ui'
import { parsePageRange } from '@shared/text'
import { invalidateSearch } from '../store/search'
import { maybeRestoreLastPage } from '../store/reading'
import { getPageViewport, pdfjs } from './pdfjs'
import { paintAnnotations } from './canvasannot'

/** 从 PDF /Annots 提取(优先)或 sidecar(旧文件兜底)恢复注释与图片缓存 */
async function restoreSidecar(): Promise<void> {
  const sidecarAnnotations = docState.sidecar?.annotations ?? []
  const source = docState.pdfAnnotations.length > 0 ? docState.pdfAnnotations : sidecarAnnotations
  resetAnnotations(source)
  for (const ann of source) {
    if (ann.kind !== 'image' || annotState.imageUrls[ann.imgId]) continue
    const info = (await window.pdfAPI.invoke('img:getByPath', ann.refPath)) as ImageInfo | { error: string }
    if ('error' in info) {
      showToast(`图片注释恢复失败:${info.error}`, 'error')
      continue
    }
    setImageUrl(ann.imgId, info.dataUrl)
  }
}

/** 打开文件(含密码流程:pdf.js 需要密码时弹框输入) */
export async function openPath(path: string): Promise<void> {
  const ok = await openByPath(path, {
    onPassword: (updatePassword, reason) => {
      const message = reason === 2 ? '密码错误,请重新输入' : '此 PDF 已加密,请输入密码'
      void requestPassword(message).then((password) => {
        updatePassword(password === null ? new Error('用户取消') : password)
      })
    }
  })
  if (!ok) {
    // 打开失败保留现场:旧文档与注释不动,仅提示错误
    if (docState.loadError && !docState.loadError.includes('用户取消')) {
      showToast(docState.loadError, 'error')
    }
    return
  }
  await restoreSidecar()
  await maybeRestoreLastPage(docState.filePath ?? path)
}

/** 有未保存更改时确认放弃(false = 用户取消) */
export function confirmDiscardChanges(): boolean {
  return !docState.dirty || window.confirm('当前文档有未保存的更改,确定放弃吗?')
}

/** 保存:直写当前路径(无路径时回退保存对话框) */
export async function saveDocument(): Promise<void> {
  await saveTo(docState.filePath ?? undefined)
}

/** 另存为:总是弹保存对话框 */
export async function saveDocumentAs(): Promise<void> {
  await saveTo(undefined)
}

/** 保存重入守卫:连按 Ctrl+S / 合并输出期间再次保存不应并发写盘 */
let saveInFlight = false

/** 写入 PDF(明文)或仅 sidecar(加密文档),并同步 sidecar 编辑态 */
async function saveTo(targetPath: string | undefined): Promise<void> {
  const docId = docState.docId
  if (!docId) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  if (saveInFlight) return
  saveInFlight = true
  try {
    // 未提交的画布编辑器内容先并入模型,避免保存漏掉最后一次编辑
    commitOpenEditor()
    const version = editVersion()
    const result = (await window.pdfAPI.invoke('save:saveAs', {
      docId,
      defaultPath: docState.filePath ?? 'document.pdf',
      targetPath,
      annotations: exportAnnotations(),
      formValues: { ...docState.formValues }
    })) as SaveResult
    if (result.canceled) return
    if (!result.ok) {
      showToast(result.error ?? '保存失败', 'error')
      return
    }
    if (result.savedPath) docState.filePath = result.savedPath
    // 保存期间又有编辑 → 保持脏标记(否则编辑被静默标记为已保存)
    if (editVersion() === version) docState.dirty = false
    if (result.mode === 'sidecar') {
      showToast('加密文档:注释与表单值仅保存到 sidecar 文件(.pdfanno.json)')
    } else {
      showToast(`已保存:${result.savedPath ?? ''}`)
    }
    if (result.warnings && result.warnings.length > 0) {
      for (const warning of result.warnings) console.warn('[save]', warning)
      showToast(`保存完成,有 ${result.warnings.length} 条提示(详见控制台)`)
    }
  } finally {
    saveInFlight = false
  }
}

export async function openFileDialog(): Promise<void> {
  const result = (await window.pdfAPI.invoke('app:chooseFile', false)) as ChooseFileResult
  if (result.canceled || result.paths.length === 0) return
  if (!confirmDiscardChanges()) return
  await openPath(result.paths[0])
}

export async function exportCurrentPageImage(): Promise<void> {
  if (!docState.pdfDoc) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  // 未提交的画布编辑器内容先并入模型,否则导出缺少最后一次编辑
  commitOpenEditor()
  const pageNumber = docState.currentPage
  try {
    const page = await getPage(pageNumber)
    const { viewport } = getPageViewport(page, 2, docState.rotationView)
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    await page.render({
      canvasContext: ctx,
      viewport,
      annotationMode: pdfjs.AnnotationMode.DISABLE
    }).promise
    // 与导出对话框「包含注释」默认勾选一致:快速导出也叠加当前模型注释
    paintAnnotations(ctx, viewport, pageNumber - 1, annotState.items, annotState.imageUrls)
    const dataUrl = canvas.toDataURL('image/png')
    const stem = docState.filePath?.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? 'document'
    const result = (await window.pdfAPI.invoke('app:saveImage', {
      defaultName: `${stem}-第${pageNumber}页.png`,
      dir: docState.filePath ? dirOf(docState.filePath) : undefined,
      dataUrl
    })) as SaveResult
    if (result.ok) showToast(`已导出图片:${result.savedPath ?? ''}`)
    else if (!result.canceled) showToast(result.error ?? '导出图片失败', 'error')
  } catch (err) {
    showToast(`导出图片失败:${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

/* ------------------------------ 页面操作 ------------------------------ */

async function runPageOp(op: PageOp, options: { recordHistory?: boolean } = {}): Promise<boolean> {
  const docId = docState.docId
  if (!docId) return false
  const recordHistory = options.recordHistory !== false && op.kind !== 'export'
  const annotationsBefore = recordHistory ? exportAnnotations() : []
  const filePathBefore = docState.filePath
  const result = (await window.pdfAPI.invoke('pageops:apply', { docId, op })) as PageOpResult
  if (!result.ok || !result.buffer) {
    if (result.error !== 'canceled') showToast(result.error ?? '页面操作失败', 'error')
    return false
  }
  if (result.pageMap) applyPageMap(result.pageMap)
  await reloadDocument(result.buffer)
  invalidateSearch()
  markDirty()
  if (recordHistory) {
    // 主进程未记快照(超大文档)→ 不记历史,避免撤销栈与快照栈错位
    if (result.snapshotted === true) {
      pushPageHistory({
        annotations: annotationsBefore,
        filePath: filePathBefore,
        pageMap: result.pageMap ?? [],
        redo: () => runPageOp(op, { recordHistory: false })
      })
    } else {
      showToast('文档较大,该操作不可撤销')
    }
  }
  return true
}

export async function deletePages(pages: number[]): Promise<void> {
  if (pages.length === 0) return
  const confirmed = window.confirm(`确定删除选中的 ${pages.length} 页吗?可用 Ctrl+Z 撤销。`)
  if (!confirmed) return
  if (await runPageOp({ kind: 'delete', pages })) showToast(`已删除 ${pages.length} 页`)
}

export async function rotatePages(pages: number[], delta: number): Promise<void> {
  if (pages.length === 0) return
  await runPageOp({ kind: 'rotate', pages, delta })
}

export async function insertBlankPage(afterIndex: number): Promise<void> {
  if (await runPageOp({ kind: 'insertBlank', afterIndex })) showToast('已插入空白页')
}

/** 移动页:from/to 均 0-based,to = 移动后的最终下标 */
export async function movePage(fromIndex: number, toIndex: number): Promise<void> {
  if (fromIndex === toIndex) return
  await runPageOp({ kind: 'move', from: fromIndex, to: toIndex })
}

/** 对话框「+ 添加文件」:选 PDF、去重、读页数;返回可加入列表的条目 */
export async function pickPdfFileEntries(existingPaths: string[]): Promise<PdfFileEntry[]> {
  const result = (await window.pdfAPI.invoke('app:chooseFile', true)) as ChooseFileResult
  if (result.canceled || result.paths.length === 0) return []
  const fresh = result.paths.filter((path) => !existingPaths.includes(path))
  if (fresh.length === 0) return []
  const counts = (await window.pdfAPI.invoke('pdf:pageCounts', fresh)) as Array<{
    path: string
    pageCount?: number
    error?: string
  }>
  const entries: PdfFileEntry[] = []
  let skipped = 0
  for (const count of counts) {
    if (typeof count.pageCount === 'number') {
      entries.push({ path: count.path, name: baseName(count.path), pageCount: count.pageCount })
    } else {
      skipped++
    }
  }
  if (skipped > 0) showToast(`已跳过 ${skipped} 个无法读取或加密的文件`, 'error')
  return entries
}

/** 合并后从主进程 buffer 提取被并文件携带的自产批注并导入模型(D4;无历史命令) */
async function importMergedAnnotations(): Promise<void> {
  const docId = docState.docId
  if (!docId) return
  const result = (await window.pdfAPI.invoke('doc:getAnnotations', docId)) as { annotations: Annotation[] }
  importAnnotations(result.annotations)
}

/** 把当前内存 buffer 写入指定路径;成功返回落盘路径,失败返回 null(已 toast) */
async function writeMergedOutput(docId: string, targetPath: string): Promise<string | null> {
  const version = editVersion()
  const result = (await window.pdfAPI.invoke('save:saveAs', {
    docId,
    defaultPath: targetPath,
    targetPath,
    annotations: exportAnnotations(),
    formValues: { ...docState.formValues }
  })) as SaveResult
  if (!result.ok) {
    showToast(result.error ?? '输出失败', 'error')
    return null
  }
  const savedPath = result.savedPath ?? targetPath
  docState.filePath = savedPath
  if (editVersion() === version) docState.dirty = false
  return savedPath
}

export async function mergePdfs(specs?: AppendFileSpec[], targetPath?: string): Promise<void> {
  const docId = docState.docId
  const filePath = docState.filePath
  if (!docId || !filePath) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  let files = specs ?? null
  let request: MergeRequest | null = null
  if (!files) {
    request = await requestMergeWork({
      path: filePath,
      name: baseName(filePath),
      pageCount: docState.pageCount,
      defaultName: `${fileStem()}-合并`
    })
    if (!request) return
    files = request.files
  }

  commitOpenEditor()
  const annotationsBefore = exportAnnotations()
  const filePathBefore = filePath
  if (!(await runPageOp({ kind: 'append', files }, { recordHistory: false }))) return
  // 首次保存成功前 redo 不可用(保存失败时条目仅用于撤销)
  let savedPath: string | null = null
  // 主进程快照与本条目严格配对:先入栈(保存失败也保留,撤销可用)
  pushPageHistory({
    annotations: annotationsBefore,
    filePath: filePathBefore,
    pageMap: [],
    redo: async () => {
      if (!savedPath) return false
      if (!(await runPageOp({ kind: 'append', files }, { recordHistory: false }))) return false
      await importMergedAnnotations()
      return (await writeMergedOutput(docId, savedPath)) !== null
    }
  })
  await importMergedAnnotations()

  let target = targetPath
  if (!target) {
    const unique = (await window.pdfAPI.invoke('app:uniquePath', {
      dir: request?.outputDir ?? dirOf(filePath),
      name: `${request?.outputName.trim() || `${fileStem()}-合并`}.pdf`
    })) as { path: string }
    target = unique.path
  }
  const written = await writeMergedOutput(docId, target)
  if (written === null) return
  savedPath = written
  showToast(`已合并 ${files.length} 个文件并输出:${savedPath}`)
  if (request?.autoOpen) {
    const opened = (await window.pdfAPI.invoke('app:openFolder', savedPath)) as { ok: boolean }
    if (!opened.ok) showToast('打开输出目录失败', 'error')
  }
}

/** 拖拽排序目标下标(0-based);target/dragPage 为 1-based 页码;返回 null = 无需移动 */
export function dropTargetIndex(dragPage: number, target: number, after: boolean): number | null {
  if (dragPage === target) return null
  const from = dragPage - 1
  const tAfter = target - 1 - (dragPage < target ? 1 : 0)
  const to = after ? tAfter + 1 : tAfter
  return to === from ? null : to
}

export async function exportPages(
  pages: number[],
  targetPath?: string,
  includeAnnotations = true
): Promise<void> {
  const docId = docState.docId
  if (!docId || pages.length === 0) return
  commitOpenEditor()
  const annotations = includeAnnotations ? exportAnnotations() : undefined
  if (targetPath) {
    const op = (await window.pdfAPI.invoke('pageops:apply', {
      docId,
      op: { kind: 'export', pages, targetPath, includeAnnotations, annotations }
    })) as PageOpResult
    if (op.ok) showToast(`已导出:${op.savedPath ?? ''}`)
    else showToast(op.error ?? '导出失败', 'error')
    return
  }
  const result = (await window.pdfAPI.invoke('pageops:export', {
    docId,
    pages,
    defaultName: `${fileStem()}-导出.pdf`,
    includeAnnotations,
    annotations
  })) as PageOpResult
  if (result.ok) showToast(`已导出:${result.savedPath ?? ''}`)
  else if (result.error !== 'canceled') showToast(result.error ?? '导出失败', 'error')
}

/** 提取:范围页复制为新 PDF(保存对话框),原文档不变 */
export async function extractPages(pages: number[], includeAnnotations = true): Promise<void> {
  const docId = docState.docId
  if (!docId || pages.length === 0) return
  commitOpenEditor()
  const result = (await window.pdfAPI.invoke('pageops:export', {
    docId,
    pages,
    defaultName: `${fileStem()}-提取.pdf`,
    includeAnnotations,
    annotations: includeAnnotations ? exportAnnotations() : undefined
  })) as PageOpResult
  if (result.ok) showToast(`已提取 ${pages.length} 页:${result.savedPath ?? ''}`)
  else if (result.error !== 'canceled') showToast(result.error ?? '提取失败', 'error')
}

/** 批量拆分:对话框收集任务,一次性输出到目录 */
export async function splitPdfs(): Promise<void> {
  const docId = docState.docId
  const filePath = docState.filePath
  if (!docId || !filePath) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  const request = await requestSplitWork({
    docId,
    path: filePath,
    name: baseName(filePath),
    pageCount: docState.pageCount
  })
  if (!request) return
  commitOpenEditor()
  const results = (await window.pdfAPI.invoke('pdf:splitTasks', {
    tasks: request.tasks,
    outputDir: request.outputDir,
    includeAnnotations: request.includeAnnotations,
    annotations: request.includeAnnotations ? exportAnnotations() : undefined
  })) as SplitTaskResult[]
  const okResults = results.filter((result) => result.ok)
  const failCount = results.length - okResults.length
  const fileCount = okResults.reduce((sum, result) => sum + (result.outputs?.length ?? 0), 0)
  if (failCount > 0) {
    const firstFail = results.find((result) => !result.ok)
    console.warn('[split] 失败任务:', results.filter((result) => !result.ok))
    showToast(
      `拆分完成:成功 ${okResults.length} 个,失败 ${failCount} 个(如 ${baseName(firstFail?.path ?? '')}:${firstFail?.error ?? '未知错误'})`,
      'error'
    )
  } else {
    showToast(`拆分完成:输出 ${fileCount} 个文件`)
  }
  const firstOutput = okResults[0]?.outputs?.[0]
  if (request.autoOpen && firstOutput) {
    const opened = (await window.pdfAPI.invoke('app:openFolder', firstOutput)) as { ok: boolean }
    if (!opened.ok) showToast('打开输出目录失败', 'error')
  }
}

function fileStem(): string {
  return docState.filePath?.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? 'document'
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function dirOf(p: string): string {
  const index = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return index >= 0 ? p.slice(0, index) : ''
}

/** 渲染单页到离屏 canvas(scale=2;批注不画入位图,由调用方按勾选用画笔叠加) */
async function renderPageToCanvas(
  pageNumber: number,
  includeAnnotations: boolean
): Promise<HTMLCanvasElement | null> {
  const page = await getPage(pageNumber)
  const { viewport } = getPageViewport(page, 2, docState.rotationView)
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  await page.render({
    canvasContext: ctx,
    viewport,
    annotationMode: pdfjs.AnnotationMode.DISABLE
  }).promise
  if (includeAnnotations) {
    paintAnnotations(ctx, viewport, pageNumber - 1, annotState.items, annotState.imageUrls)
  }
  return canvas
}

/** 导出页面为图片:逐页多图(用户选目录)或拼接长图(单张 PNG) */
export async function exportPagesAsImages(
  pages: number[],
  mode: 'each' | 'long',
  direction?: 'h' | 'v',
  includeAnnotations = true
): Promise<void> {
  if (!docState.pdfDoc || pages.length === 0) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  commitOpenEditor()
  try {
    if (mode === 'long') {
      const canvases: HTMLCanvasElement[] = []
      for (const index of pages) {
        const canvas = await renderPageToCanvas(index + 1, includeAnnotations)
        if (canvas) canvases.push(canvas)
      }
      if (canvases.length === 0) return
      const vertical = direction !== 'h'
      const width = vertical ? Math.max(...canvases.map((c) => c.width)) : canvases.reduce((sum, c) => sum + c.width, 0)
      const height = vertical ? canvases.reduce((sum, c) => sum + c.height, 0) : Math.max(...canvases.map((c) => c.height))
      const out = document.createElement('canvas')
      out.width = width
      out.height = height
      const ctx = out.getContext('2d')
      if (!ctx) return
      let offset = 0
      for (const c of canvases) {
        ctx.drawImage(c, vertical ? (width - c.width) / 2 : offset, vertical ? offset : (height - c.height) / 2)
        offset += vertical ? c.height : c.width
      }
      const result = (await window.pdfAPI.invoke('app:saveImage', {
        defaultName: `${fileStem()}-长图.png`,
        dir: docState.filePath ? dirOf(docState.filePath) : undefined,
        dataUrl: out.toDataURL('image/png')
      })) as SaveResult
      if (result.ok) showToast(`已导出长图:${result.savedPath ?? ''}`)
      else if (!result.canceled) showToast(result.error ?? '导出长图失败', 'error')
      return
    }
    const dataUrls: string[] = []
    const names: string[] = []
    for (const index of pages) {
      const canvas = await renderPageToCanvas(index + 1, includeAnnotations)
      if (!canvas) continue
      dataUrls.push(canvas.toDataURL('image/png'))
      names.push(`${fileStem()}-第${index + 1}页.png`)
    }
    if (dataUrls.length === 0) return
    const result = (await window.pdfAPI.invoke('app:saveImages', { names, dataUrls })) as SaveResult
    if (result.ok) showToast(`已导出 ${dataUrls.length} 张图片:${result.savedPath ?? ''}`)
    else if (!result.canceled) showToast(result.error ?? '导出图片失败', 'error')
  } catch (err) {
    showToast(`导出图片失败:${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

/** 打印:离屏渲染所选页(含注释)后交主进程走系统打印对话框 */
export async function printPages(pages: number[], includeAnnotations = true): Promise<void> {
  if (!docState.pdfDoc || pages.length === 0) return
  commitOpenEditor()
  try {
    const dataUrls: string[] = []
    const sizesMm: Array<{ w: number; h: number }> = []
    for (const index of pages) {
      const canvas = await renderPageToCanvas(index + 1, includeAnnotations)
      if (!canvas) continue
      dataUrls.push(canvas.toDataURL('image/png'))
      const box = docState.pageBoxes[index]
      if (!box) continue
      const rotated = docState.rotationView % 180 !== 0
      const w = rotated ? box.h : box.w
      const h = rotated ? box.w : box.h
      sizesMm.push({ w: (w * 25.4) / 72, h: (h * 25.4) / 72 })
    }
    if (dataUrls.length === 0) return
    const result = (await window.pdfAPI.invoke('app:printPages', {
      jobName: `${fileStem()}-打印`,
      dataUrls,
      sizesMm
    })) as { ok: boolean; canceled?: boolean; error?: string }
    if (result.ok) showToast('已提交打印')
    else if (!result.canceled) showToast(result.error ?? '打印失败', 'error')
  } catch (err) {
    showToast(`打印失败:${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

/** 工具栏「打印」按钮:先收页码范围,再调 printPages */
export async function printPagesDialog(): Promise<void> {
  if (!docState.pdfDoc) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  const request = await requestPagesRange('print')
  if (!request) return
  const pages = parsePageRange(request.input, docState.pageCount)
  if (!pages || pages.length === 0) {
    showToast('页码范围无效', 'error')
    return
  }
  await printPages(pages, request.includeAnnotations ?? true)
}
