/**
 * 渲染进程测试 API(冒烟验证用)。挂载到 window.__pdfEditorTest。
 * 供 PDF_EDITOR_SMOKE 模式下主进程 executeJavaScript 调用。
 */
import { openPath, deletePages, exportPages, insertBlankPage, mergePdfs, rotatePages } from './lib/actions'
import { docState } from './store/document'
import { searchState } from './store/search'
import { ui } from './store/ui'
import { searchDocument } from './lib/textsearch'
import { addAnnotation, annotState, exportAnnotations, redo, undo } from './store/annotations'
import { TOOL_DEFAULTS, withIdentity } from './lib/annots'

declare global {
  interface Window {
    __pdfEditorTest?: Record<string, unknown>
  }
}

export function installTestApi(): void {
  window.__pdfEditorTest = {
    ready: true,
    appMounted: true,
    openPath,
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
    search: (query: string) => searchDocument(query)
  }
}