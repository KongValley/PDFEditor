import type { ChooseFileResult, ImageInfo, PageOp, PageOpResult, SaveResult } from '@shared/types'
import { docState, getPage, openByPath, reloadDocument } from '../store/document'
import { annotState, applyPageMap, exportAnnotations, resetAnnotations, setImageUrl } from '../store/annotations'
import { requestPassword, showToast } from '../store/ui'
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

export async function mergePdfs(paths?: string[]): Promise<void> {
  let files = paths ?? []
  if (files.length === 0) {
    const result = (await window.pdfAPI.invoke('app:chooseFile', true)) as ChooseFileResult
    if (result.canceled || result.paths.length === 0) return
    files = result.paths
  }
  if (await runPageOp({ kind: 'append', paths: files })) {
    showToast(`已合并 ${files.length} 个文件`)
  }
}

export async function exportPages(pages: number[], targetPath?: string): Promise<void> {
  const docId = docState.docId
  if (!docId || pages.length === 0) return
  const stem = docState.filePath?.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? 'document'
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
    defaultName: `${stem}-导出.pdf`
  })) as PageOpResult
  if (result.ok) showToast(`已导出:${result.savedPath ?? ''}`)
  else if (result.error !== 'canceled') showToast(result.error ?? '导出失败', 'error')
}
