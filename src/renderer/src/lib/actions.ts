import type {
  Annotation,
  AppendFileSpec,
  ChooseFileResult,
  ImageAnnotation,
  ImageInfo,
  PageOp,
  PageOpResult,
  SaveResult,
  SplitTaskResult
} from '@shared/types'
import {
  docState,
  editVersion,
  getPage,
  machineProfile,
  markDirty,
  openByPath,
  pageDisplaySize,
  reloadDocument
} from '../store/document'
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
  splitDialogState,
  ui,
  type MergeRequest,
  type PdfFileEntry,
  type PrintQuality
} from '../store/ui'
import { parsePageRange } from '@shared/text'
import { planPageOrientation, type OrientationPlanItem } from './orientation'
import { cancelOrientationPlan, requestOrientationPlan, submitOrientationPlan } from '../store/ui'
import { imagePdfDialogState, requestImagePdf, type ImagePdfItem } from '../store/ui'
import { invalidateSearch } from '../store/search'
import { maybeRestoreLastPage } from '../store/reading'
import { orientationFlipped, refitAfterOrientationChange, scrollToPage } from '../store/viewer'
import { getPageViewport, pdfjs } from './pdfjs'
import { paintAnnotations } from './canvasannot'

/** 从 PDF /Annots 提取(优先)或 sidecar(旧文件兜底)恢复注释与图片缓存 */
async function restoreSidecar(): Promise<void> {
  const sidecarAnnotations = docState.sidecar?.annotations ?? []
  const source = docState.pdfAnnotations.length > 0 ? docState.pdfAnnotations : sidecarAnnotations
  resetAnnotations(source)
  // 逐张串行读盘在多图文档上会让窗口卡住数秒:并发取回后再统一登记,错误仍逐条提示
  const images = source.filter(
    (ann): ann is ImageAnnotation => ann.kind === 'image' && !annotState.imageUrls[ann.imgId]
  )
  const loaded = await Promise.all(
    images.map(async (ann) => ({
      ann,
      info: (await window.pdfAPI.invoke('img:getByPath', ann.refPath)) as ImageInfo | { error: string }
    }))
  )
  for (const { ann, info } of loaded) {
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

/**
 * 长操作统一闸门:标签期间任何同类操作直接拒绝(返回 null),避免两批任务并发写同一目标。
 * 返回 null 表示"因已有操作在跑而未执行"。
 */
export async function runBusy<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (ui.busy) {
    showToast('上一操作尚未完成,请稍候', 'error')
    return null
  }
  ui.busy = label
  try {
    return await fn()
  } finally {
    ui.busy = null
  }
}

/** 写入 PDF(明文)或仅 sidecar(加密文档),并同步 sidecar 编辑态 */
async function saveTo(targetPath: string | undefined): Promise<void> {
  const docId = docState.docId
  if (!docId) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  await runBusy('正在保存…', async () => {
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
  })
}

/**
 * 统一页面方向:扫描件里零星几页方向与其它页不一致时,扫描全文 → 弹预览 → 逐页确认后应用。
 * 与缩略图多选无关,作用于整份文档。
 */
export async function normalizePageOrientation(): Promise<void> {
  if (!docState.pdfDoc) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  if (docState.pageCount < 2) {
    showToast('至少需要 2 页才能判断方向基准', 'error')
    return
  }
  await runBusy('正在分析页面方向…', async () => {
    requestOrientationPlan()
    try {
      submitOrientationPlan(await planPageOrientation())
    } catch (err) {
      cancelOrientationPlan()
      showToast(`分析页面方向失败:${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  })
}

/** 应用预览对话框里确认的旋转(一次页面操作 → 一次撤销) */
export async function applyOrientationFix(items: OrientationPlanItem[]): Promise<void> {
  const deltas: Record<number, number> = {}
  for (const item of items) {
    if (item.delta) deltas[item.page - 1] = item.delta
  }
  const pages = Object.keys(deltas).map(Number)
  if (pages.length === 0) {
    showToast('没有需要调整的页面', 'error')
    return
  }
  await runBusy('正在统一页面方向…', async () => {
    const ok = await runPageOp({ kind: 'rotate', pages, delta: 90, deltas })
    cancelOrientationPlan()
    if (!ok) return
    showToast(
      lastPageOpUndoable
        ? `已统一 ${pages.length} 页方向,可用 Ctrl+Z 撤销`
        : `已统一 ${pages.length} 页方向(文档较大,该操作不可撤销)`
    )
  })
}

/** 图片转 PDF:打开对话框;seed 为拖入窗口的图片路径(已按选择顺序) */
export async function openImageToPdfDialog(seed: string[] = []): Promise<void> {
  const items: ImagePdfItem[] = []
  for (const path of seed) {
    const info = (await window.pdfAPI.invoke('img:getByPath', path)) as ImageInfo | { error: string }
    if ('error' in info) {
      showToast(`无法读取图片:${info.error}`, 'error')
      continue
    }
    items.push({ path, name: baseName(path), width: info.width, height: info.height })
  }
  requestImagePdf(items)
}

/** 对话框「+ 添加图片」:系统多选框,返回按选择顺序的图片信息 */
export async function pickImageFiles(): Promise<ImagePdfItem[]> {
  const result = (await window.pdfAPI.invoke('img:chooseMany')) as
    | { canceled: true }
    | { canceled: false; files: string[] }
  if (result.canceled) return []
  const items: ImagePdfItem[] = []
  for (const path of result.files) {
    const info = (await window.pdfAPI.invoke('img:getByPath', path)) as ImageInfo | { error: string }
    if ('error' in info) {
      showToast(`${baseName(path)}:${info.error}`, 'error')
      continue
    }
    items.push({ path, name: baseName(path), width: info.width, height: info.height })
  }
  return items
}

/** 执行转换:进度事件更新对话框,成功后自动打开结果 */
export async function convertImagesToPdf(items: ImagePdfItem[]): Promise<void> {
  if (items.length === 0) {
    showToast('请先添加图片', 'error')
    return
  }
  imagePdfDialogState.running = true
  imagePdfDialogState.done = 0
  imagePdfDialogState.total = items.length
  imagePdfDialogState.current = ''
  imagePdfDialogState.result = null
  const jobId = `img2pdf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  // 先订阅再进 runBusy:订阅句柄在闭包里赋值会被 TS 的控制流分析收窄成 never
  const off = window.pdfAPI.on('img:toPdfProgress', (raw) => {
    const info = raw as { jobId?: string; done?: number; total?: number; name?: string }
    if (info?.jobId !== jobId) return
    imagePdfDialogState.done = info.done ?? 0
    imagePdfDialogState.total = info.total ?? items.length
    imagePdfDialogState.current = info.name ?? ''
  })
  try {
    await runBusy('正在生成 PDF…', async () => {
      const result = (await window.pdfAPI.invoke('img:toPdf', {
        jobId,
        paths: items.map((item) => item.path),
        pageMode: imagePdfDialogState.pageMode
      })) as {
        ok: boolean
        canceled?: boolean
        savedPath?: string
        pages?: number
        error?: string
        errors?: Array<{ path: string; error: string }>
      }
      imagePdfDialogState.result = {
        ok: result.ok,
        savedPath: result.savedPath,
        pages: result.pages,
        error: result.error,
        failed: result.errors?.length ?? 0
      }
      if (!result.ok) {
        if (!result.canceled) showToast(result.error ?? '图片转 PDF 失败', 'error')
        return
      }
      // 当前文档有未保存改动时不覆盖现场:只提示保存路径
      if (!confirmDiscardChanges()) {
        showToast(`已生成 PDF,未打开:${result.savedPath ?? ''}`)
        return
      }
      await openPath(result.savedPath as string)
      showToast(`已生成 PDF(${result.pages} 页):${result.savedPath ?? ''}`)
    })
  } finally {
    off()
    imagePdfDialogState.running = false
  }
}

export async function openFileDialog(): Promise<void> {
  const result = (await window.pdfAPI.invoke('app:chooseFile', false)) as ChooseFileResult
  if (result.canceled || result.paths.length === 0) return
  if (!confirmDiscardChanges()) return
  await openPath(result.paths[0])
}

export async function exportPageImage(pageNumber: number): Promise<void> {
  if (!docState.pdfDoc) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  // 未提交的画布编辑器内容先并入模型,否则导出缺少最后一次编辑
  commitOpenEditor()
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

export async function exportCurrentPageImage(): Promise<void> {
  return exportPageImage(docState.currentPage)
}

/* ------------------------------ 页面操作 ------------------------------ */

/** 最近一次页面操作是否记了历史(主进程是否留了快照);供删除后的提示判断 */
let lastPageOpUndoable = false

async function runPageOp(op: PageOp, options: { recordHistory?: boolean } = {}): Promise<boolean> {
  lastPageOpUndoable = false
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
  // 旋转前的当前页显示尺寸:旋转后据此判断方向有没有翻转(见下方 refit)
  const sizeBefore = pageDisplaySize(docState.currentPage - 1)
  // move:页集合与表单控件集合都不变、仅顺序变化 → 用 pageMap 重排 pageBoxes,免全量 N 次 getPage。
  // rotate:只重算被旋转页尺寸。
  // delete/insertBlank 会增删页与表单控件,必须走全量重建(否则被删页的字段会残留);
  // 不给它们 pageMap 即强制回退全量。
  await reloadDocument(result.buffer, {
    // 只有 90/270 会交换显示宽高;180° 旋转后尺寸不变,一并传入会让增量几何错换宽高
    rotatedPages:
      op.kind === 'rotate' ? op.pages.filter((index) => (op.deltas?.[index] ?? op.delta) % 180 === 90) : undefined,
    pageMap: op.kind === 'move' ? result.pageMap : undefined
  })
  // 重建后按当前页重新对齐滚动:换文档分支会归零,这里恢复(三种视图模式均由 scrollToPage 处理)
  // 当前页方向翻转(竖↔横)时先重新适应再滚动:页面宽度换了,沿用旧缩放会横向溢出看不全
  if (op.kind === 'rotate' && orientationFlipped(sizeBefore, pageDisplaySize(docState.currentPage - 1))) {
    refitAfterOrientationChange()
  }
  scrollToPage(docState.currentPage)
  invalidateSearch()
  markDirty()
  if (recordHistory) {
    // 主进程未记快照(超大文档)→ 不记历史,避免撤销栈与快照栈错位
    if (result.snapshotted === true) {
      lastPageOpUndoable = true
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
  // 撤销能力取决于主进程快照(>128MB 的文档根本不记快照),执行前无法确定,
  // 因此确认框不承诺可撤销;执行后按实际能力提示
  const confirmed = window.confirm(`确定删除选中的 ${pages.length} 页吗?`)
  if (!confirmed) return
  if (await runPageOp({ kind: 'delete', pages }) && lastPageOpUndoable) {
    showToast(`已删除 ${pages.length} 页,可用 Ctrl+Z 撤销`)
  }
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

  // 合并本体(不含对话框)受 busy 闸门保护:对话框打开期间不占用,避免挡住用户再开一个
  await runBusy('正在合并…', async () => {
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
  })
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
  // 拆分本体受 busy 闸门保护;对话框期间不占用,避免挡住用户再开一个拆分对话框
  await runBusy('正在准备拆分…', async () => {
    commitOpenEditor()
    const jobId = `split-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    splitDialogState.running = true
    splitDialogState.jobId = jobId
    splitDialogState.progress = { processed: 0, total: request.tasks.length, outputs: 0 }
    // 主进程每写完一个文件推一次进度;「停止」按钮通过 pdf:splitCancel 置位
    const off = window.pdfAPI.on('pdf:splitProgress', (raw) => {
      const info = raw as { jobId?: string; processed?: number; total?: number; outputs?: number }
      if (info?.jobId !== jobId) return
      splitDialogState.progress = { processed: info.processed ?? 0, total: info.total ?? 0, outputs: info.outputs ?? 0 }
      ui.busy = `拆分中 文件 ${info.processed ?? 0}/${info.total ?? 0},已输出 ${info.outputs ?? 0} 个`
    })
    let results: SplitTaskResult[]
    try {
      results = (await window.pdfAPI.invoke('pdf:splitTasks', {
        jobId,
        tasks: request.tasks,
        outputDir: request.outputDir,
        includeAnnotations: request.includeAnnotations,
        annotations: request.includeAnnotations ? exportAnnotations() : undefined
      })) as SplitTaskResult[]
    } finally {
      off()
      splitDialogState.running = false
      splitDialogState.jobId = null
      splitDialogState.progress = null
    }
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
  })
}

/** 拆分对话框的「停止」按钮:置位后主进程在下一个文件边界停下(已写出的文件保留) */
export async function cancelSplit(): Promise<void> {
  const jobId = splitDialogState.jobId
  if (!jobId) return
  await window.pdfAPI.invoke('pdf:splitCancel', { jobId })
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

/** Chrome/Chromium canvas 单边硬限(实测 65535;超出后 getContext('2d') 返回 null) */
const MAX_CANVAS_SIDE = 65535

/** 长图拼接的位图内存上限(字节):省内存机 96MB,其余 256MB */
function longImageByteBudget(): number {
  return machineProfile.lowMem ? 96 * 1048576 : 256 * 1048576
}

/** 长图能放下的 scale(2 起逐档减半,下限 0.25);0 表示连下限都放不下,应提示缩小范围 */
function fitLongImageScale(pageW: number, pageH: number, count: number, vertical: boolean): number {
  for (let scale = 2; scale >= 0.25; scale /= 2) {
    const span = (vertical ? pageH : pageW) * scale * count
    const other = (vertical ? pageW : pageH) * scale
    if (span <= MAX_CANVAS_SIDE && other <= MAX_CANVAS_SIDE && span * other * 4 <= longImageByteBudget()) {
      return scale
    }
  }
  return 0
}

/** 渲染单页到离屏 canvas(默认 scale=2;批注不画入位图,由调用方按勾选用画笔叠加) */
async function renderPageToCanvas(
  pageNumber: number,
  includeAnnotations: boolean,
  scale = 2
): Promise<HTMLCanvasElement | null> {
  const page = await getPage(pageNumber)
  const { viewport } = getPageViewport(page, scale, docState.rotationView)
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
  await runBusy(mode === 'long' ? '正在拼接长图…' : `正在导出 ${pages.length} 张图片…`, async () => {
    try {
    if (mode === 'long') {
      const vertical = direction !== 'h'
      // 先按首页尺寸与页数算出放得下的 scale:超上限时自动降 scale,而不是渲染完再静默失败
      const firstPage = await getPage(pages[0] + 1)
      const baseVp = getPageViewport(firstPage, 1, docState.rotationView).viewport
      const scale = fitLongImageScale(baseVp.width, baseVp.height, pages.length, vertical)
      if (scale === 0) {
        showToast(`长图超出 ${MAX_CANVAS_SIDE} 像素上限,请缩小页码范围`, 'error')
        return
      }
      if (scale < 2) {
        showToast(`页数较多,长图已自动降到 ${Math.round(scale * 100)}% 分辨率以适配内存`)
      }
      const canvases: HTMLCanvasElement[] = []
      for (const index of pages) {
        const canvas = await renderPageToCanvas(index + 1, includeAnnotations, scale)
        if (canvas) canvases.push(canvas)
      }
      if (canvases.length === 0) return
      const width = vertical ? Math.max(...canvases.map((c) => c.width)) : canvases.reduce((sum, c) => sum + c.width, 0)
      const height = vertical ? canvases.reduce((sum, c) => sum + c.height, 0) : Math.max(...canvases.map((c) => c.height))
      const out = document.createElement('canvas')
      out.width = width
      out.height = height
      const ctx = out.getContext('2d')
      if (!ctx) {
        showToast('画布分配失败,请缩小页码范围', 'error')
        return
      }
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
    // 逐页多图:每页 base64 约为位图的 1.33 倍,且全部累积在 dataUrls[] 里再过 IPC
    const probePage = await getPage(pages[0] + 1)
    const probeVp = getPageViewport(probePage, 2, docState.rotationView).viewport
    const perPageBytes = Math.floor(probeVp.width * probeVp.height * 4 * 1.33)
    if (pages.length * perPageBytes > longImageByteBudget() * 2) {
      showToast('页数较多,批量导出可能耗尽内存,请分批导出', 'error')
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
  })
}

/** 打印 scale:高清 ≈300dpi 单页位图 33MB,叠加 print.ts 隐藏窗口的解码峰值;
 *  省内存机自动降回标准档。纯函数便于冒烟直接断言,不必触发系统打印对话框。 */
export function resolvePrintScale(quality: PrintQuality): number {
  return quality === 'high' && !machineProfile.lowMem ? 300 / 72 : 2
}

/** 打印单页 PNG 字节:标准 2×(≈144dpi)、高清 300dpi(Uint8Array 走结构化克隆,免 base64×1.33) */
export async function renderPrintPageDataUrl(
  pageNumber: number,
  includeAnnotations: boolean,
  quality: PrintQuality
): Promise<Uint8Array | null> {
  const scale = resolvePrintScale(quality)
  const canvas = await renderPageToCanvas(pageNumber, includeAnnotations, scale)
  if (!canvas) return null
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

/** 打印:逐页渲染并即传主进程(峰值只占一页),最后提交给系统打印对话框 */
export async function printPages(
  pages: number[],
  includeAnnotations = true,
  quality: PrintQuality = 'standard'
): Promise<void> {
  if (!docState.pdfDoc || pages.length === 0) return
  commitOpenEditor()
  if (quality === 'high' && machineProfile.lowMem) {
    showToast('本机内存较小,高清打印已自动改为标准清晰度')
  }
  await runBusy('正在准备打印…', () => printPagesInner(pages, includeAnnotations, quality))
}

/** 打印本体(由 printPages 经 busy 闸门调用) */
async function printPagesInner(
  pages: number[],
  includeAnnotations: boolean,
  quality: PrintQuality
): Promise<void> {
  let jobId: string | null = null
  try {
    const sizesMm = pages.map((index) => {
      const box = docState.pageBoxes[index]
      if (!box) return { w: 210, h: 297 } // 缺页尺寸信息时按 A4 输出,不中断打印
      const rotated = docState.rotationView % 180 !== 0
      const w = rotated ? box.h : box.w
      const h = rotated ? box.w : box.h
      return { w: (w * 25.4) / 72, h: (h * 25.4) / 72 }
    })
    const prepared = (await window.pdfAPI.invoke('app:printPrepare', {
      jobName: `${fileStem()}-打印`,
      pageCount: pages.length,
      sizesMm
    })) as { ok: boolean; jobId?: string; error?: string }
    if (!prepared.ok || !prepared.jobId) {
      showToast(prepared.error ?? '打印失败', 'error')
      return
    }
    jobId = prepared.jobId
    for (const [i, index] of pages.entries()) {
      showToast(`正在渲染打印页面 ${i + 1} / ${pages.length}…`)
      const bytes = await renderPrintPageDataUrl(index + 1, includeAnnotations, quality)
      if (!bytes) throw new Error(`第 ${index + 1} 页渲染失败`)
      const added = (await window.pdfAPI.invoke('app:printAddPage', {
        jobId,
        index: i,
        bytes
      })) as { ok: boolean; error?: string }
      if (!added.ok) throw new Error(added.error ?? '打印页面写入失败')
    }
    const result = (await window.pdfAPI.invoke('app:printCommit', { jobId })) as {
      ok: boolean
      canceled?: boolean
      error?: string
    }
    jobId = null
    if (result.ok) showToast('已提交打印')
    else if (!result.canceled) showToast(result.error ?? '打印失败', 'error')
  } catch (err) {
    showToast(`打印失败:${err instanceof Error ? err.message : String(err)}`, 'error')
  } finally {
    if (jobId) void window.pdfAPI.invoke('app:printAbort', { jobId })
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
  await printPages(pages, request.includeAnnotations ?? true, request.printQuality ?? 'standard')
}
