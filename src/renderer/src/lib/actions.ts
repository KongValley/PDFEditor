import type {
  AppendFileSpec,
  ChooseFileResult,
  ImageInfo,
  PageOp,
  PageOpResult,
  SaveResult
} from '@shared/types'
import { docState, getPage, openByPath, reloadDocument } from '../store/document'
import { annotState, applyPageMap, exportAnnotations, resetAnnotations, setImageUrl } from '../store/annotations'
import { requestMergeSpecs, requestPassword, showToast, type MergeFileEntry } from '../store/ui'
import { getPageViewport } from './pdfjs'

/** 从 sidecar 恢复注释与图片缓存 */
async function restoreSidecar(): Promise<void> {
  const sidecar = docState.sidecar
  if (!sidecar) {
    resetAnnotations([])
    return
  }
  resetAnnotations(sidecar.annotations)
  for (const ann of sidecar.annotations) {
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
    resetAnnotations([])
    if (docState.loadError && !docState.loadError.includes('用户取消')) {
      showToast(docState.loadError, 'error')
    }
    return
  }
  await restoreSidecar()
}

/** 保存:写入 PDF(明文)或仅 sidecar(加密文档),并同步 sidecar 编辑态 */
export async function saveDocument(): Promise<void> {
  const docId = docState.docId
  if (!docId) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  const result = (await window.pdfAPI.invoke('save:saveAs', {
    docId,
    defaultPath: docState.filePath ?? 'document.pdf',
    annotations: exportAnnotations(),
    formValues: { ...docState.formValues }
  })) as SaveResult
  if (result.canceled) return
  if (!result.ok) {
    showToast(result.error ?? '保存失败', 'error')
    return
  }
  if (result.savedPath) docState.filePath = result.savedPath
  if (result.mode === 'sidecar') {
    showToast('加密文档:注释与表单值仅保存到 sidecar 文件(.pdfanno.json)')
  } else {
    showToast(`已保存:${result.savedPath ?? ''}`)
  }
  if (result.warnings && result.warnings.length > 0) {
    for (const warning of result.warnings) console.warn('[save]', warning)
    showToast(`保存完成,有 ${result.warnings.length} 条提示(详见控制台)`)
  }
}

export async function openFileDialog(): Promise<void> {
  const result = (await window.pdfAPI.invoke('app:chooseFile', false)) as ChooseFileResult
  if (result.canceled || result.paths.length === 0) return
  await openPath(result.paths[0])
}

export async function exportCurrentPageImage(): Promise<void> {
  if (!docState.pdfDoc) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  const pageNumber = docState.currentPage
  try {
    const page = await getPage(pageNumber)
    const { viewport } = getPageViewport(page, 2, docState.rotationView)
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    await page.render({ canvasContext: ctx, viewport }).promise
    const dataUrl = canvas.toDataURL('image/png')
    const stem = docState.filePath?.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? 'document'
    const result = (await window.pdfAPI.invoke('app:saveImage', {
      defaultName: `${stem}-第${pageNumber}页.png`,
      dataUrl
    })) as SaveResult
    if (result.ok) showToast(`已导出图片:${result.savedPath ?? ''}`)
    else if (!result.canceled) showToast(result.error ?? '导出图片失败', 'error')
  } catch (err) {
    showToast(`导出图片失败:${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

/* ------------------------------ 页面操作 ------------------------------ */

async function runPageOp(op: PageOp): Promise<boolean> {
  const docId = docState.docId
  if (!docId) return false
  const result = (await window.pdfAPI.invoke('pageops:apply', { docId, op })) as PageOpResult
  if (!result.ok || !result.buffer) {
    if (result.error !== 'canceled') showToast(result.error ?? '页面操作失败', 'error')
    return false
  }
  if (result.pageMap) applyPageMap(result.pageMap)
  await reloadDocument(result.buffer)
  return true
}

export async function deletePages(pages: number[]): Promise<void> {
  if (pages.length === 0) return
  const confirmed = window.confirm(`确定删除选中的 ${pages.length} 页吗?删除后不可撤销。`)
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

export async function mergePdfs(
  paths?: string[],
  specs?: AppendFileSpec[],
  targetPath?: string
): Promise<void> {
  const docId = docState.docId
  if (!docId) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  let files = paths ?? []
  if (files.length === 0) {
    const result = (await window.pdfAPI.invoke('app:chooseFile', true)) as ChooseFileResult
    if (result.canceled || result.paths.length === 0) return
    files = result.paths
  }

  let mergeSpecs = specs ?? null
  if (!mergeSpecs) {
    const counts = (await window.pdfAPI.invoke('pdf:pageCounts', files)) as Array<{
      path: string
      pageCount?: number
      error?: string
    }>
    const readable: MergeFileEntry[] = []
    for (const count of counts) {
      if (typeof count.pageCount !== 'number') continue
      readable.push({
        path: count.path,
        name: count.path.split(/[\\/]/).pop() ?? count.path,
        pageCount: count.pageCount
      })
    }
    if (readable.length === 0) {
      showToast('没有可合并的文件', 'error')
      return
    }
    const skipped = counts.length - readable.length
    if (skipped > 0) showToast(`已跳过 ${skipped} 个无法读取的文件`, 'error')
    mergeSpecs = await requestMergeSpecs(readable)
    if (!mergeSpecs) return
  }

  if (!(await runPageOp({ kind: 'append', files: mergeSpecs }))) return

  const result = (await window.pdfAPI.invoke('save:saveAs', {
    docId,
    defaultPath: mergeOutputDefaultPath(),
    targetPath,
    annotations: exportAnnotations(),
    formValues: { ...docState.formValues }
  })) as SaveResult
  if (result.canceled) {
    showToast('合并已在编辑器中生效,未另存(可手动保存)')
    return
  }
  if (!result.ok) {
    showToast(result.error ?? '输出失败', 'error')
    return
  }
  if (result.savedPath) docState.filePath = result.savedPath
  showToast(`已合并 ${mergeSpecs.length} 个文件并输出:${result.savedPath ?? ''}`)
}

/** 合并输出默认路径:当前文档同目录下的 <文件名>-合并.pdf */
function mergeOutputDefaultPath(): string {
  const filePath = docState.filePath
  if (!filePath) return '合并结果.pdf'
  const sepIndex = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  const dir = sepIndex >= 0 ? filePath.slice(0, sepIndex + 1) : ''
  return `${dir}${fileStem()}-合并.pdf`
}

export async function exportPages(pages: number[], targetPath?: string): Promise<void> {
  const docId = docState.docId
  if (!docId || pages.length === 0) return
  if (targetPath) {
    const op = (await window.pdfAPI.invoke('pageops:apply', {
      docId,
      op: { kind: 'export', pages, targetPath }
    })) as PageOpResult
    if (op.ok) showToast(`已导出:${op.savedPath ?? ''}`)
    else showToast(op.error ?? '导出失败', 'error')
    return
  }
  const result = (await window.pdfAPI.invoke('pageops:export', {
    docId,
    pages,
    defaultName: `${fileStem()}-导出.pdf`
  })) as PageOpResult
  if (result.ok) showToast(`已导出:${result.savedPath ?? ''}`)
  else if (result.error !== 'canceled') showToast(result.error ?? '导出失败', 'error')
}

/** 提取:范围页复制为新 PDF(保存对话框),原文档不变 */
export async function extractPages(pages: number[]): Promise<void> {
  const docId = docState.docId
  if (!docId || pages.length === 0) return
  const result = (await window.pdfAPI.invoke('pageops:export', {
    docId,
    pages,
    defaultName: `${fileStem()}-提取.pdf`
  })) as PageOpResult
  if (result.ok) showToast(`已提取 ${pages.length} 页:${result.savedPath ?? ''}`)
  else if (result.error !== 'canceled') showToast(result.error ?? '提取失败', 'error')
}

/** 拆分:每段各存为一个 PDF(每段一次保存对话框) */
export async function splitPages(segments: number[][]): Promise<void> {
  if (segments.length === 0) return
  let done = 0
  for (const pages of segments) {
    const result = (await window.pdfAPI.invoke('pageops:export', {
      docId: docState.docId,
      pages,
      defaultName: `${fileStem()}-拆-${pages.length}页.pdf`
    })) as PageOpResult
    if (!result.ok) {
      if (result.error !== 'canceled') showToast(result.error ?? '拆分失败', 'error')
      break
    }
    done++
  }
  if (done > 0) showToast(`已拆分为 ${done} 个文件`)
}

function fileStem(): string {
  return docState.filePath?.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? 'document'
}

/** 渲染单页到离屏 canvas(scale=2,与 exportCurrentPageImage 一致) */
async function renderPageToCanvas(pageNumber: number): Promise<HTMLCanvasElement | null> {
  const page = await getPage(pageNumber)
  const { viewport } = getPageViewport(page, 2, docState.rotationView)
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas
}

/** 导出页面为图片:逐页多图(用户选目录)或拼接长图(单张 PNG) */
export async function exportPagesAsImages(
  pages: number[],
  mode: 'each' | 'long',
  direction?: 'h' | 'v'
): Promise<void> {
  if (!docState.pdfDoc || pages.length === 0) {
    showToast('请先打开 PDF 文件', 'error')
    return
  }
  try {
    if (mode === 'long') {
      const canvases: HTMLCanvasElement[] = []
      for (const index of pages) {
        const canvas = await renderPageToCanvas(index + 1)
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
        dataUrl: out.toDataURL('image/png')
      })) as SaveResult
      if (result.ok) showToast(`已导出长图:${result.savedPath ?? ''}`)
      else if (!result.canceled) showToast(result.error ?? '导出长图失败', 'error')
      return
    }
    const dataUrls: string[] = []
    const names: string[] = []
    for (const index of pages) {
      const canvas = await renderPageToCanvas(index + 1)
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
