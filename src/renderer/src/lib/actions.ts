import type {
  Annotation,
  AppendFileSpec,
  ChooseFileResult,
  ImageAnnotation,
  ImageInfo,
  OfdExportResult,
  OfdTextRun,
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
import { imagePdfDialogState, ofdExportDialogState, requestImagePdf, requestOfdExport, type ImagePdfItem, type OfdDpi } from '../store/ui'
import { invalidateSearch } from '../store/search'
import { beginOpen, endOpen, maybeRestoreLastPage } from '../store/reading'
import { orientationFlipped, refitAfterOrientationChange, scrollToPage } from '../store/viewer'
import { getPageViewport, pdfjs } from './pdfjs'
import { paintAnnotations } from './canvasannot'
// 图片导出/打印的渲染管线已拆到 pagexport(见 D4);这里再导出维持既有 import 面
export { exportPagesAsImages, printPages, renderPrintPageDataUrl, resolvePrintScale } from './pagexport'
import { printPages, renderPageToCanvas, resolveOfdScale } from './pagexport'

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
  // openByPath 第一行会 ++openSeq:结束后若仍是「我这次」(seq 恰好多 1)才允许复位 opening 闸门。
  // 被后续打开取代时旧请求不得把新请求的闸门提前打开(否则新文档的暂定第 1 页会被当成真实阅读位置落盘)。
  const seqBefore = currentOpenToken()
  beginOpen()
  try {
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
    // OFD 源提示放在最后:恢复阅读位置也会 toast 一条,而「保存必须另存为 .pdf」更该被看见
    if (docState.sourceKind === 'ofd') {
      showToast('已把 OFD 转换为 PDF(保存时请另存为 .pdf)')
      if (docState.ofdWarnings.length > 0) {
        pushProblem({ title: 'OFD 转换提示', detail: docState.ofdWarnings.join('\n') })
        showToast(`OFD 转换完成,有 ${docState.ofdWarnings.length} 条提示`)
      }
    }
  } finally {
    if (currentOpenToken() === seqBefore + 1) endOpen()
  }
}

/** 有未保存更改时确认放弃(false = 用户取消) */
export function confirmDiscardChanges(): boolean {
  return !docState.dirty || window.confirm('当前文档有未保存的更改,确定放弃吗?')
}

/** 保存:直写当前路径(无路径时回退保存对话框);OFD 源文档永不原地写回,一律走另存为 */
export async function saveDocument(): Promise<void> {
  await saveTo(docState.sourceKind === 'ofd' ? undefined : (docState.filePath ?? undefined))
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
      // OFD 源:默认名换成同名 .pdf,绝不把 .ofd 交给保存对话框(否则会覆盖源文件)
      defaultPath: docState.sourceKind === 'ofd' ? `${fileStem()}.pdf` : (docState.filePath ?? 'document.pdf'),
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
      // 重试闭包冻结文档身份:失败后切到别的文档再点「重试」,不能把新文档内容写进旧路径
      const owner = docId
      pushProblem({
        title: result.error ?? '保存失败',
        retry: () => (docState.docId === owner ? saveTo(targetPath) : Promise.resolve())
      })
      return
    }
    if (result.savedPath) docState.filePath = result.savedPath
    // 已落盘为 .pdf:此后就是普通 PDF 文档,再按 Ctrl+S 直接就地保存
    if (result.savedPath) docState.sourceKind = 'pdf'
    // 保存期间又有编辑 → 保持脏标记(否则编辑被静默标记为已保存)
    // savedPath 缺失(加密文档另存为:只写了新路径旁的孤立 sidecar,当前文档并未落盘)→ 不能清脏
    if (result.savedPath && editVersion() === version) docState.dirty = false
    if (result.mode === 'sidecar' && result.savedPath) {
      showToast('加密文档:注释与表单值仅保存到 sidecar 文件(.pdfanno.json)')
    } else if (result.mode !== 'sidecar') {
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
    const ok = await applyPageOp({ kind: 'rotate', pages, delta: 90, deltas })
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

/** 导出 OFD:打开对话框(页码范围 / 清晰度 / 是否含批注由对话框收集) */
export function openOfdExportDialog(): void {
  requestOfdExport()
}

/** 字体族名只作资源声明(文本不可见):取家族列表首项并限长 */
function normalizeFamily(family: string): string {
  const first = family.split(',')[0]?.replace(/["']/g, '').trim() ?? ''
  return first ? first.slice(0, 120) : 'sans-serif'
}

/**
 * 一页的文字段:只保留「输出方向为水平」的文字,旋转/斜切段跳过(位图里仍在),换算成毫米。
 *
 * 必须把 item.transform 过一遍 scale=1 的 viewport 变换:位图是按 viewport(含页面 /Rotate)渲染的,
 * 直接用 PDF 用户空间坐标会让带 /Rotate 的页面文字层整体转 90°/180°,选择框与图上文字对不上。
 *
 * 返回 null 表示渲染层取不到文字(调用方按「该页只有位图」继续,不让导出失败)。
 */
async function textRunsOf(pageNumber: number): Promise<{ runs: OfdTextRun[]; skipped: number } | null> {
  try {
    const page = await getPage(pageNumber)
    const viewport = getPageViewport(page, 1, 0).viewport
    const content = await page.getTextContent()
    const runs: OfdTextRun[] = []
    let skipped = 0
    for (const raw of content.items) {
      const item = raw as { str?: string; transform?: number[]; width?: number; fontName?: string }
      const text = typeof item.str === 'string' ? item.str : ''
      if (!text.trim()) continue
      if (!Array.isArray(item.transform) || item.transform.length < 6) continue
      // viewport 坐标系:原点左上、y 向下,scale=1 时单位即 pt(与位图同向)
      const t = pdfjs.Util.transform(viewport.transform, item.transform)
      const scaleX = Math.hypot(t[0], t[1])
      const scaleY = Math.hypot(t[2], t[3])
      if (scaleX <= 0 || scaleY <= 0) continue
      // 水平 = 字型的 x 轴没有 y 分量、y 轴没有 x 分量、且向右推进。
      // 注意 t[3] 在 viewport(y 向下)下本来就是负数(坐标系翻转,不是倒置),不能要求它为正。
      const horizontal = Math.abs(t[1]) < 1e-3 * scaleX && Math.abs(t[2]) < 1e-3 * scaleY && t[0] > 0
      if (!horizontal) {
        skipped++
        continue
      }
      const sizeMm = (scaleY * 25.4) / 72
      const style = item.fontName ? content.styles?.[item.fontName] : undefined
      const ascent = typeof style?.ascent === 'number' && Number.isFinite(style.ascent) ? style.ascent : 0.8
      runs.push({
        text,
        xMm: (t[4] * 25.4) / 72,
        baselineMm: (t[5] * 25.4) / 72,
        sizeMm,
        widthMm: Math.max(((item.width ?? 0) * 25.4) / 72, sizeMm * 0.1),
        // 含中文的段用中文字体族名:换行字体时中文字符才不会被替代字体丢掉(文本不可见,只影响可提取性)
        family: /[\u3400-\u9fff]/.test(text) ? 'SimSun' : normalizeFamily(style?.fontFamily ?? 'sans-serif'),
        ascent: Math.min(1.2, Math.max(0.5, ascent))
      })
    }
    return { runs, skipped }
  } catch (err) {
    logEvent('warn', 'ofd', '文本层提取失败,该页只有位图', { page: pageNumber, error: (err as Error).message })
    return null
  }
}

/**
 * 执行 OFD 导出:逐页渲染成 PNG 交主进程,并按需叠加不可见文本层,最后打包成 .ofd。
 * 每页渲染完立即经 IPC 传字节(结构化克隆,不走 base64),内存峰值只占一页位图。
 */
export async function exportOfd(options: {
  pages: number[]
  dpi: OfdDpi
  includeAnnotations: boolean
  /** 叠加不可见文本层(可检索/可选中);缺省 true */
  textLayer?: boolean
}): Promise<void> {
  const docId = docState.docId
  if (!docState.pdfDoc || !docId || options.pages.length === 0) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  commitOpenEditor()
  const scale = resolveOfdScale(options.dpi)
  const total = options.pages.length
  await runBusy('正在导出 OFD…', async () => {
    ofdExportDialogState.done = 0
    ofdExportDialogState.total = total
    let jobId = ''
    try {
      const prepared = (await window.pdfAPI.invoke('ofd:exportPrepare', {
        defaultName: `${fileStem()}-导出.ofd`
      })) as OfdExportResult
      if (prepared.canceled) return
      if (!prepared.ok || !prepared.jobId) {
        showToast(prepared.error ?? '导出 OFD 失败', 'error')
        return
      }
      jobId = prepared.jobId
      const withText = options.textLayer !== false
      let skippedPages = 0
      let skippedRuns = 0
      for (let i = 0; i < total; i++) {
        ofdExportDialogState.progress = `正在渲染第 ${i + 1}/${total} 页`
        // rotation=0:产物跟随文档自身的 /Rotate,不把临时视图旋转烘进 OFD(否则文字层无法对应)
        const canvas = await renderPageToCanvas(options.pages[i] + 1, options.includeAnnotations, scale, 0)
        if (!canvas) throw new Error(`第 ${options.pages[i] + 1} 页渲染失败`)
        const png = await new Promise<Uint8Array>((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (!blob) {
              reject(new Error('画布导出失败'))
              return
            }
            void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
          }, 'image/png')
        })
        const extracted = withText ? await textRunsOf(options.pages[i] + 1) : { runs: [], skipped: 0 }
        if (extracted === null) skippedPages++
        else skippedRuns += extracted.skipped
        // 毫米尺寸由画布像素反推:与页面 /Rotate 保持一致,不依赖 pageBoxes
        const page = (await window.pdfAPI.invoke('ofd:exportPage', {
          jobId,
          index: i,
          widthMm: (canvas.width / scale / 72) * 25.4,
          heightMm: (canvas.height / scale / 72) * 25.4,
          png,
          texts: extracted?.runs.length ? extracted.runs : undefined
        })) as { ok: boolean; error?: string }
        if (!page.ok) throw new Error(page.error ?? '页面写入失败')
        ofdExportDialogState.done = i + 1
      }
      const committed = (await window.pdfAPI.invoke('ofd:exportCommit', { jobId })) as OfdExportResult
      jobId = ''
      if (!committed.ok) {
        showToast(committed.error ?? '导出 OFD 失败', 'error')
        return
      }
      showToast(`已导出 OFD:${committed.savedPath ?? ''}`)
      if (skippedPages > 0 || skippedRuns > 0) {
        const parts: string[] = []
        if (skippedRuns > 0) parts.push(`${skippedRuns} 段旋转/斜排文字未生成文本层`)
        if (skippedPages > 0) parts.push(`${skippedPages} 页文字提取失败`)
        pushProblem({
          title: '部分内容未生成文本层',
          detail: `${parts.join(';')}。位图完整,查看/打印不受影响;这些内容不可检索。`
        })
        showToast(`导出完成:${parts.join(',')}`)
      }
    } catch (err) {
      if (jobId) void window.pdfAPI.invoke('ofd:exportAbort', { jobId })
      const message = err instanceof Error ? err.message : String(err)
      showToast(`导出 OFD 失败:${message}`, 'error')
      // 重试闭包冻结文档身份:失败后切到别的文档再点「重试」不能把新文档写进旧产物
      const owner = docId
      pushProblem({
        title: '导出 OFD 失败',
        detail: message,
        retry: () => (docState.docId === owner ? exportOfd(options) : Promise.resolve())
      })
    }
  })
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
  } catch (err) {
    // 主进程已把「数量超限/未选择」转成 {ok:false,error} 正常返回(见 ipc 的 validateImageCount),
    // 走到这里说明是真正的意外。不能让它变成未处理 rejection ——
    // 对话框会直接退回待开始列表且零提示,用户表现为「点了没反应」。
    showToast(`图片转 PDF 失败:${err instanceof Error ? err.message : String(err)}`, 'error')
  } finally {
    off()
    imagePdfDialogState.running = false
  }
}

export async function openFileDialog(): Promise<void> {
  const result = (await window.pdfAPI.invoke('app:chooseFile', { multi: false, allowOfd: true })) as ChooseFileResult
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

const PAGE_OP_NAMES: Record<PageOp['kind'], string> = {
  delete: '删除页面',
  rotate: '旋转页面',
  insertBlank: '插入空白页',
  move: '移动页面',
  append: '合并文档',
  export: '导出页面',
  pagenumber: '添加页码',
  watermark: '添加水印'
}

const PAGE_OP_BUSY: Record<PageOp['kind'], string> = {
  delete: '正在删除页面…',
  rotate: '正在旋转页面…',
  insertBlank: '正在插入空白页…',
  move: '正在移动页面…',
  append: '正在合并文档…',
  export: '正在导出页面…',
  pagenumber: '正在添加页码…',
  watermark: '正在添加水印…'
}

async function applyPageOp(op: PageOp, options: { recordHistory?: boolean } = {}): Promise<boolean> {
  lastPageOpUndoable = false
  const docId = docState.docId
  if (!docId) return false
  if (docState.loading) {
    showToast('文档正在加载,请稍候', 'info')
    return false
  }
  const recordHistory = options.recordHistory !== false && op.kind !== 'export'
  const annotationsBefore = recordHistory ? exportAnnotations() : []
  const filePathBefore = docState.filePath
  const result = (await window.pdfAPI.invoke('pageops:apply', { docId, op })) as PageOpResult
  // runBusy 只挡同类长操作,不挡「打开文件」;结果落回任何全局状态之前必须确认还是同一份文档
  if (docId !== docState.docId) {
    showToast('页面操作已完成,但期间切换了文档,结果未应用', 'info')
    return false
  }
  if (!result.ok || !result.buffer) {
    const message = result.error ?? '页面操作失败'
    if (result.error !== 'canceled') {
      showToast(message, 'error')
      pushProblem({ title: `${PAGE_OP_NAMES[op.kind]}失败`, detail: message })
    }
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
        docId,
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

/** 统一忙碌闸门:页面操作期间状态栏显示进度,工具栏/缩略图/快捷键入口全部置灰 */
async function runPageOp(op: PageOp, options: { recordHistory?: boolean } = {}): Promise<boolean> {
  const result = await runBusy(PAGE_OP_BUSY[op.kind], () => applyPageOp(op, options))
  return result === true
}

export async function deletePages(pages: number[]): Promise<boolean> {
  if (pages.length === 0) return false
  // 撤销能力取决于主进程快照(>128MB 的文档根本不记快照),执行前无法确定,
  // 因此确认框不承诺可撤销;执行后按实际能力提示
  const confirmed = window.confirm(`确定删除选中的 ${pages.length} 页吗?`)
  if (!confirmed) return false
  const ok = await runPageOp({ kind: 'delete', pages })
  if (ok && lastPageOpUndoable) {
    showToast(`已删除 ${pages.length} 页,可用 Ctrl+Z 撤销`)
  }
  return ok
}

export async function rotatePages(pages: number[], delta: number): Promise<void> {
  if (pages.length === 0) return
  await runPageOp({ kind: 'rotate', pages, delta })
}

export async function insertBlankPage(afterIndex: number): Promise<void> {
  if (await runPageOp({ kind: 'insertBlank', afterIndex })) showToast('已插入空白页')
}

/** 添加页码:一次页面操作 → 一次撤销 */
export async function addPageNumbers(options: {
  pages: number[]
  format: PageNumberFormat
  start: number
  position: 'bottom-center' | 'bottom-right' | 'top-center' | 'top-right'
  fontSize: number
  margin: number
}): Promise<boolean> {
  const ok = await runPageOp({ kind: 'pagenumber', ...options })
  if (ok) {
    showToast(
      lastPageOpUndoable ? '已添加页码,可用 Ctrl+Z 撤销' : '已添加页码(文档较大,该操作不可撤销)'
    )
  }
  return ok
}

/** 添加水印:一次页面操作 → 一次撤销 */
export async function addWatermark(options: {
  pages: number[]
  text: string
  fontSize: number
  opacity: number
  rotation: number
  tile: boolean
  color: string
}): Promise<boolean> {
  const ok = await runPageOp({ kind: 'watermark', ...options })
  if (ok) {
    showToast(
      lastPageOpUndoable ? '已添加水印,可用 Ctrl+Z 撤销' : '已添加水印(文档较大,该操作不可撤销)'
    )
  }
  return ok
}

/** 书签编辑(新建/重命名/删除):走 outline:apply,与页面操作共用撤销栈 */
export async function applyOutlineEdit(
  edit: {
    kind: 'add' | 'rename' | 'remove'
    [key: string]: unknown
  },
  options: { recordHistory?: boolean } = {}
): Promise<boolean> {
  const docId = docState.docId
  if (!docId) return false
  if (docState.loading) {
    showToast('文档正在加载,请稍候', 'info')
    return false
  }
  const annotationsBefore = exportAnnotations()
  const filePathBefore = docState.filePath
  // edit 常来自 docState.outline(深层响应式代理)或 ref 包裹的数组:
  // Electron 的结构化克隆无法克隆 Proxy,直接传会抛 "An object could not be cloned"
  // 并被调用方的 void 吞成静默失败 —— 先做一次 JSON 往返拿纯值
  const plainEdit = JSON.parse(JSON.stringify(edit)) as typeof edit
  let result: PageOpResult
  try {
    result = (await window.pdfAPI.invoke('outline:apply', { docId, edit: plainEdit })) as PageOpResult
  } catch (err) {
    showToast(`书签编辑失败:${err instanceof Error ? err.message : String(err)}`, 'error')
    return false
  }
  if (docId !== docState.docId) {
    showToast('书签编辑已完成,但期间切换了文档,结果未应用', 'info')
    return false
  }
  if (!result.ok || !result.buffer) {
    if (result.error !== 'canceled') showToast(result.error ?? '书签编辑失败', 'error')
    return false
  }
  await reloadDocument(result.buffer, { pageMap: result.pageMap })
  // reloadDocument 后 docState.pdfDoc 是 markRaw 过的新文档;经中间变量取非空实例
  const nextDoc = docState.pdfDoc as (typeof docState.pdfDoc & object) | null
  docState.outline = nextDoc ? await loadOutline(nextDoc as never) : []
  markDirty()
  // 主进程每次都压了快照(除非超大文档),渲染层不配对压条目就会让两侧栈错位:
  // 下一次 Ctrl+Z 消费别的页面操作条目、弹出的却是本次书签快照
  if (options.recordHistory !== false) {
    if (result.snapshotted === true) {
      pushPageHistory({
        docId,
        annotations: annotationsBefore,
        filePath: filePathBefore,
        pageMap: result.pageMap ?? [],
        redo: () => applyOutlineEdit(plainEdit, { recordHistory: false })
      })
    } else {
      showToast('文档较大,该操作不可撤销')
    }
  }
  return true
}

/** 移动页:from/to 均 0-based,to = 移动后的最终下标 */
export async function movePage(fromIndex: number, toIndex: number): Promise<void> {
  if (fromIndex === toIndex) return
  await runPageOp({ kind: 'move', from: fromIndex, to: toIndex })
}

/** 对话框「+ 添加文件」:选 PDF、去重、读页数;返回可加入列表的条目 */
export async function pickPdfFileEntries(existingPaths: string[]): Promise<PdfFileEntry[]> {
  // 合并/拆分只接受 PDF:OFD 需先导入转 PDF,不在这里隐式转换
  const result = (await window.pdfAPI.invoke('app:chooseFile', { multi: true })) as ChooseFileResult
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
  if (docId !== docState.docId) {
    showToast('合并输出已中止:文档已切换', 'info')
    return null
  }
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
  // 保存期间切了文档:输出文件已落盘但绝不能把它设成新文档的保存路径,否则下一次 Ctrl+S 覆盖它
  if (docId !== docState.docId) {
    showToast('合并输出已写入,但期间切换了文档,未更新当前文件路径', 'info')
    return savedPath
  }
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
    if (!(await applyPageOp({ kind: 'append', files }, { recordHistory: false }))) return
    // 首次保存成功前 redo 不可用(保存失败时条目仅用于撤销)
    let savedPath: string | null = null
    // 主进程快照与本条目严格配对:先入栈(保存失败也保留,撤销可用)
    pushPageHistory({
      docId,
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
    const owner = docId
    pushProblem({
      title: result.error ?? '导出失败',
      retry: () => (docState.docId === owner ? exportPages(pages, targetPath, includeAnnotations) : Promise.resolve())
    })
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
    const owner = docId
    pushProblem({
      title: result.error ?? '提取失败',
      retry: () => (docState.docId === owner ? extractPages(pages, includeAnnotations) : Promise.resolve())
    })
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
