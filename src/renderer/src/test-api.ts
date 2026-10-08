/**
 * 渲染进程测试 API(冒烟验证用)。挂载到 window.__pdfEditorTest。
 * 供 PDF_EDITOR_SMOKE 模式下主进程 executeJavaScript 调用。
 */
import {
  openPath,
  deletePages,
  dropTargetIndex,
  exportPages,
  extractPages,
  exportPagesAsImages,
  insertBlankPage,
  mergePdfs,
  movePage,
  applyOrientationFix,
  normalizePageOrientation,
  renderPrintPageDataUrl,
  resolvePrintScale,
  rotatePages,
  runBusy,
  saveDocument,
  saveDocumentAs,
  splitPdfs
} from './lib/actions'
import { parsePageRange, splitPageSegments } from '@shared/text'
import { detectContentPosture, orientationOf, pickBaseOrientation } from './lib/orientation'
import {
  docState,
  cachedPageCount,
  machineProfile,
  pinnedPageCounts,
  docCleanupCount,
  rangeStreamStats,
  releasedDocIds
} from './store/document'
import { invalidateSearch, searchState } from './store/search'
import { mergeDialogState, orientationDialogState, splitDialogState, ui } from './store/ui'
import { searchDocument } from './lib/textsearch'
import {
  addAnnotation,
  annotState,
  bringToFront,
  copySelection,
  duplicateSelection,
  exportAnnotations,
  moveDown,
  moveUp,
  pasteClipboard,
  redo,
  sendToBack,
  undo,
  updateAnnotation
} from './store/annotations'
import { renderGate, renderWatchdog, scrollToPage, zoomBy } from './store/viewer'
import { goBack, goForward, readingState, setRestoreLastPage } from './store/reading'
import { TOOL_DEFAULTS, withIdentity } from './lib/annots'
import { pdfjs } from './lib/pdfjs'
import { paintAnnotations } from './lib/canvasannot'

declare global {
  interface Window {
    __pdfEditorTest?: Record<string, unknown>
  }
}

/** 打开文档并等待当前页渲染完成(注释层挂载即代表该页已渲染;恢复阅读位置后首页可能不在视口) */
async function openPathReady(path: string): Promise<void> {
  const t0 = Date.now()
  await openPath(path)
  const currentLayer = () => document.querySelector(`[data-page="${docState.currentPage}"] .ann-layer`)
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (currentLayer()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const viewer = document.querySelector('.viewer')
  const visibleFlags = [...document.querySelectorAll<HTMLElement>('.page-wrap')]
    .map((el) => el.dataset.visible)
    .join(',')
  console.log(
    `[t] ready-timeout ${Date.now() - t0}ms path=${path.split(/[\\/]/).pop()} pages=${document.querySelectorAll('.page-wrap').length} layers=${document.querySelectorAll('.ann-layer').length} currentLayer=${!!currentLayer()} scrollTop=${viewer?.scrollTop ?? -1} visible=${visibleFlags} currentPage=${docState.currentPage} pageCount=${docState.pageCount}`
  )
  // 静默返回会让后续步骤在"还没渲染出来的空白页"上断言,报出与真实原因无关的失败
  throw new Error(`openPathReady:当前页未在 20s 内渲染(${path.split(/[\\/]/).pop()})`)
}

export function installTestApi(): void {
  window.__pdfEditorTest = {
    ready: true,
    appMounted: true,
    openPath: openPathReady,
    docState,
    ui,
    mergeDialogState,
    orientationDialogState,
    orientationOf,
    pickBaseOrientation,
    detectContentPosture,
    normalizePageOrientation,
    applyOrientationFix,
    splitDialogState,
    searchState,
    annotState,
    addAnnotation,
    withIdentity,
    toolDefaults: TOOL_DEFAULTS,
    exportAnnotations,
    undo,
    redo,
    deletePages,
    rotatePages,
    insertBlankPage,
    movePage,
    mergePdfs,
    splitPdfs,
    exportPages,
    extractPages,
    exportPagesAsImages,
    renderPrintPageDataUrl,
    resolvePrintScale,
    dropTargetIndex,
    saveDocument,
    saveDocumentAs,
    copySelection,
    pasteClipboard,
    duplicateSelection,
    bringToFront,
    sendToBack,
    moveUp,
    moveDown,
    updateAnnotation,
    parsePageRange,
    splitPageSegments,
    scrollToPage,
    renderWatchdog,
    renderGate,
    zoomBy,
    runBusy,
    goBack,
    goForward,
    readingState,
    setRestoreLastPage,
    cachedPageCount,
    pinnedPageCounts,
    machineProfile,
    cleanupCount: docCleanupCount,
    releasedDocIds,
    rangeStreamStats,
    invalidateSearch,
    search: (query: string, limit?: number) => searchDocument(query, limit),
    // 冒烟用:以 pdf.js 原生批注绘制(annotationMode ENABLE)做「其它阅读器可见」的独立验证
    pdfjs,
    /** 离屏渲染某页(annotationMode DISABLE,与 PNG 导出同路径)并叠加注释画笔 */
    renderPageWithAnnotations: async (
      path: string,
      pageNumber: number,
      includeAnnotations: boolean
    ): Promise<{ dataUrl: string; width: number; height: number; viewport: { width: number; height: number } }> => {
      const opened = (await window.pdfAPI.invoke('doc:open', path)) as {
        buffer?: ArrayBuffer
        annotations?: unknown[]
      }
      if (!opened.buffer) throw new Error('打开失败')
      const doc = await pdfjs.getDocument({ data: opened.buffer }).promise
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 2 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 2d 不可用')
      await page.render({ canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise
      if (includeAnnotations) {
        paintAnnotations(ctx, viewport, pageNumber - 1, annotState.items, annotState.imageUrls)
      }
      const dataUrl = canvas.toDataURL('image/png')
      await doc.cleanup()
      return {
        dataUrl,
        width: canvas.width,
        height: canvas.height,
        viewport: { width: viewport.width, height: viewport.height }
      }
    },
    /** 冒烟用:让 pdf.js 以原生批注绘制渲染(即标准阅读器所见) */
    renderWithNativeAnnotations: async (
      path: string,
      pageNumber: number
    ): Promise<{ dataUrl: string; width: number; height: number; subtypes: string[] }> => {
      const opened = (await window.pdfAPI.invoke('doc:open', path)) as { buffer?: ArrayBuffer }
      if (!opened.buffer) throw new Error('打开失败')
      const doc = await pdfjs.getDocument({ data: opened.buffer }).promise
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 2 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 2d 不可用')
      await page.render({ canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise
      const annots = (await page.getAnnotations({ intent: 'display' })) as Array<{ subtype?: string }>
      const dataUrl = canvas.toDataURL('image/png')
      await doc.cleanup()
      return {
        dataUrl,
        width: canvas.width,
        height: canvas.height,
        subtypes: annots.map((a) => a.subtype ?? '')
      }
    }
  }
}