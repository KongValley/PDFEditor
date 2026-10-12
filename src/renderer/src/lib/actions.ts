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
import { logEvent } from './log'
import {
  currentOpenToken,
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
  pageAnnotations,
  pushPageHistory,
  resetAnnotations,
  setImageUrl
} from '../store/annotations'
import {
  commitOpenEditor,
  pushProblem,
  requestMergeWork,
  requestPagesRange,
  requestPassword,
  requestSplitWork,
  runBusy,
  showToast,
  splitDialogState,
  ui,
  type MergeRequest,
  type PdfFileEntry,
  type PrintQuality
} from '../store/ui'
import type { PageNumberFormat } from '@shared/types'
import { baseNameOf, stemOf } from '@shared/paths'
import { loadOutline } from './outline'
import { parsePageRange } from '@shared/text'
import { planPageOrientation, type OrientationPlanItem } from './orientation'
import { cancelOrientationPlan, requestOrientationPlan, submitOrientationPlan } from '../store/ui'
import { imagePdfDialogState, requestImagePdf, type ImagePdfItem } from '../store/ui'
import { invalidateSearch } from '../store/search'
import { maybeRestoreLastPage } from '../store/reading'
import { orientationFlipped, refitAfterOrientationChange, scrollToPage } from '../store/viewer'
import { getPageViewport, pdfjs } from './pdfjs'
import { paintAnnotations } from './canvasannot'
// 图片导出/打印的渲染管线已拆到 pagexport(见 D4);这里再导出维持既有 import 面
export { exportPagesAsImages, printPages, renderPrintPageDataUrl, resolvePrintScale } from './pagexport'
import { printPages } from './pagexport'

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
  // 入口闸门:打开流程在大文档上要数秒(共享盘更久),期间再来一次打开会让两个
  // openByPath 并发写 docState(最坏是把 A 的批注写进 B 的文件)。这里直接挡掉第二次。
  if (docState.loading) {
    showToast('文档正在加载,请稍候', 'info')
    return
  }
  // 身份令牌必须在 openByPath **返回之后**取:openByPath 内部会 ++openSeq,
  // 调用前取到的旧令牌与返回值必然不等,会把下面的恢复步骤全部误判为"已被取代"。
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
  // 从此刻起若又来了新打开请求,下面的 restoreSidecar/maybeRestoreLastPage
  // 都在 await 之后写全局状态,必须确认「我还是当前文档」再往下走。
  const token = currentOpenToken()
  await restoreSidecar()
  if (token !== currentOpenToken()) return
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
 * 长操作统一闸门已移至 store/ui.ts(pagexport 也用它;放 actions 会形成模块循环)。
 * 这里再导出维持既有 import 面(keymap/test-api 等从 actions 引它)。
 */
export { runBusy } from '../store/ui'

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
    // 身份校验:runBusy 只挡同类长操作,不挡「打开文件」;保存大文档期间 Ctrl+O
    // 会让新文档就位。此时若继续把 filePath/dirty 写到全局,新文档会顶着旧文档的
    // 路径,随后一次 Ctrl+S 就覆盖错文件。
    if (docId !== docState.docId) {
      showToast('保存已完成,但期间切换了文档,未更新当前文件的保存路径', 'info')
      return
    }
    if (result.canceled) return
    if (!result.ok) {
      showToast(result.error ?? '保存失败', 'error')
      pushProblem({ title: result.error ?? '保存失败', retry: () => saveTo(targetPath) })
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
      // 离线打包后没有控制台:明细进「问题」面板,可复制
      pushProblem({
        title: `保存完成,有 ${result.warnings.length} 条提示`,
        detail: result.warnings.join('\n')
      })
      showToast(`保存完成,有 ${result.warnings.length} 条提示`)
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
    paintAnnotations(ctx, viewport, pageNumber - 1, pageAnnotations(pageNumber - 1), annotState.imageUrls)
    const dataUrl = canvas.toDataURL('image/png')
    const stem = fileStem()
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
    // identity 映射:页数不变,走增量分支并 geometryVersion++,位图重画但免一次全量几何重建
    pageMap:
      op.kind === 'move' || op.kind === 'pagenumber' || op.kind === 'watermark' ? result.pageMap : undefined
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

/** 添加页码:一次页面操作 → 一次撤销 */
export function addPageNumbers(options: {
  pages: number[]
  format: PageNumberFormat
  start: number
  position: 'bottom-center' | 'bottom-right' | 'top-center' | 'top-right'
  fontSize: number
  margin: number
}): Promise<boolean> {
  return runPageOp({ kind: 'pagenumber', ...options })
}

/** 添加水印:一次页面操作 → 一次撤销 */
export function addWatermark(options: {
  pages: number[]
  text: string
  fontSize: number
  opacity: number
  rotation: number
  tile: boolean
  color: string
}): Promise<boolean> {
  return runPageOp({ kind: 'watermark', ...options })
}

/** 书签编辑(新建/重命名/删除):走 outline:apply,与页面操作共用撤销栈 */
export async function applyOutlineEdit(edit: {
  kind: 'add' | 'rename' | 'remove'
  [key: string]: unknown
}): Promise<boolean> {
  const docId = docState.docId
  if (!docId) return false
  const result = (await window.pdfAPI.invoke('outline:apply', { docId, edit })) as PageOpResult
  if (!result.ok || !result.buffer) {
    if (result.error !== 'canceled') showToast(result.error ?? '书签编辑失败', 'error')
    return false
  }
  await reloadDocument(result.buffer, { pageMap: result.pageMap })
  // reloadDocument 后 docState.pdfDoc 是 markRaw 过的新文档;经中间变量取非空实例
  const nextDoc = docState.pdfDoc as (typeof docState.pdfDoc & object) | null
  docState.outline = nextDoc ? await loadOutline(nextDoc as never) : []
  markDirty()
  return true
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
  else if (result.error !== 'canceled') {
    showToast(result.error ?? '导出失败', 'error')
    pushProblem({ title: result.error ?? '导出失败', retry: () => exportPages(pages, targetPath, includeAnnotations) })
  }
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
  else if (result.error !== 'canceled') {
    showToast(result.error ?? '提取失败', 'error')
    pushProblem({ title: result.error ?? '提取失败', retry: () => extractPages(pages, includeAnnotations) })
  }
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
  return stemOf(docState.filePath ?? '') || 'document'
}

function baseName(p: string): string {
  return baseNameOf(p)
}

function dirOf(p: string): string {
  const index = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return index >= 0 ? p.slice(0, index) : ''
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
