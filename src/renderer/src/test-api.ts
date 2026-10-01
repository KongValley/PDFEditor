/**
 * 渲染进程测试 API(冒烟验证用)。挂载到 window.__pdfEditorTest。
 * 供 PDF_EDITOR_SMOKE 模式下主进程 executeJavaScript 调用。
 */
import { openPath, deletePages, exportPages, insertBlankPage, mergePdfs, rotatePages } from './lib/actions'
import { docState, cachedPageCount, pinnedPageCounts, docCleanupCount } from './store/document'
import { searchState } from './store/search'
import { ui } from './store/ui'
import { searchDocument } from './lib/textsearch'
import { addAnnotation, annotState, exportAnnotations, redo, undo } from './store/annotations'
import { scrollToPage } from './store/viewer'
import { TOOL_DEFAULTS, withIdentity } from './lib/annots'

declare global {
  interface Window {
    __pdfEditorTest?: Record<string, unknown>
  }
}

/** 打开文档并等待首页渲染完成(注释层挂载即代表首个页面已渲染) */
async function openPathReady(path: string): Promise<void> {
  await openPath(path)
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (document.querySelector('[data-page="1"] .ann-layer')) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export function installTestApi(): void {
  window.__pdfEditorTest = {
    ready: true,
    appMounted: true,
    openPath: openPathReady,
    docState,
    ui,
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
    mergePdfs,
    exportPages,
    scrollToPage,
    cachedPageCount,
    pinnedPageCounts,
    cleanupCount: docCleanupCount,
    search: (query: string) => searchDocument(query)
  }
}