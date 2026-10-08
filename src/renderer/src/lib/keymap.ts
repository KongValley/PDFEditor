import { onBeforeUnmount, onMounted } from 'vue'
import { docState } from '../store/document'
import { pagesDialogState, setTool, submitPagesRange, ui } from '../store/ui'
import { copySelection, duplicateSelection, pasteClipboard, removeSelected, redo, undo } from '../store/annotations'
import { searchStep } from '../store/search'
import { fitWidth, scrollToPage, setViewMode, stepPage, zoomBy } from '../store/viewer'
import { goBack, goForward } from '../store/reading'
import {
  deletePages,
  exportCurrentPageImage,
  insertBlankPage,
  openFileDialog,
  printPagesDialog,
  rotatePages,
  saveDocument,
  saveDocumentAs
} from './actions'

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

export function useGlobalKeymap(): void {
  function onKeyDown(event: KeyboardEvent): void {
    const ctrl = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()

    // 仅"不打断录入"的文档级快捷键在文本框内也生效
    if (ctrl && key === 'o') {
      event.preventDefault()
      void openFileDialog()
      return
    }
    if (ctrl && key === 's') {
      event.preventDefault()
      void (event.shiftKey ? saveDocumentAs() : saveDocument())
      return
    }
    if (event.key === 'F11') {
      event.preventDefault()
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen()
      return
    }

    // 输入框/下拉框聚焦时交还原生行为:注释正文、表单字段、搜索框里打字时,
    // Ctrl+E/P/F/1/2/3 等会弹模态或重排视图,把半句输入打断;Ctrl+C/V 若不 return
    // 还会与原生复制粘贴同时生效(既粘文本又粘批注)。
    if (isTypingTarget(event.target)) return

    if (ctrl && key === 'e') {
      event.preventDefault()
      void exportCurrentPageImage()
      return
    }
    if (ctrl && key === 'p') {
      event.preventDefault()
      void printPagesDialog()
      return
    }
    if (ctrl && key === 'f') {
      event.preventDefault()
      ui.searchOpen = true
      return
    }
    if (ctrl && (event.key === '=' || event.key === '+')) {
      event.preventDefault()
      zoomBy(1.1)
      return
    }
    if (ctrl && event.key === '-') {
      event.preventDefault()
      zoomBy(1 / 1.1)
      return
    }
    if (ctrl && event.key === '0') {
      event.preventDefault()
      fitWidth()
      return
    }
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault()
      goBack()
      return
    }
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault()
      goForward()
      return
    }
    if (event.key === 'F3') {
      event.preventDefault()
      searchStep(event.shiftKey ? -1 : 1)
      return
    }

    // 阅读视图切换(在输入框守卫之后:打字时按 Ctrl+1/2/3 不应重排视图)
    if (ctrl && (event.key === '1' || event.key === '2' || event.key === '3')) {
      event.preventDefault()
      setViewMode(event.key === '1' ? 'continuous' : event.key === '2' ? 'single' : 'two')
      return
    }
    // 面板显示/隐藏
    if (ctrl && key === 'b') {
      event.preventDefault()
      if (event.shiftKey) ui.showRightPanel = !ui.showRightPanel
      else ui.showThumbnails = !ui.showThumbnails
      return
    }

    // 编辑类快捷键:文本框/下拉框聚焦时的让位守卫已上移到 Ctrl+S / F11 之后
    if (ctrl && key === 'z') {
      event.preventDefault()
      void (event.shiftKey ? redo() : undo())
      return
    }
    if (ctrl && key === 'y') {
      event.preventDefault()
      void redo()
      return
    }

    // 页面旋转:当前页(裸 [ / ],与输入框守卫同级,避免输入方括号时误转)
    if (!ctrl && !event.altKey && (event.key === '[' || event.key === ']')) {
      event.preventDefault()
      void rotatePages([docState.currentPage - 1], event.key === '[' ? -90 : 90)
      return
    }
    // 页面操作
    if (ctrl && event.shiftKey && key === 'n') {
      event.preventDefault()
      void insertBlankPage(docState.currentPage - 1)
      return
    }
    if (ctrl && event.shiftKey && event.key === 'Delete') {
      event.preventDefault()
      void deletePages([docState.currentPage - 1])
      return
    }

    if (ctrl && key === 'c' && ui.selectedAnnotationIds.length > 0) {
      copySelection()
      return
    }
    if (ctrl && key === 'v' && pasteClipboard() > 0) {
      return
    }
    if (ctrl && key === 'd' && ui.selectedAnnotationIds.length > 0) {
      event.preventDefault()
      duplicateSelection()
      return
    }

    if ((event.key === 'Delete' || event.key === 'Backspace') && ui.selectedAnnotationIds.length > 0) {
      event.preventDefault()
      removeSelected()
      return
    }

    if (event.key === 'Escape') {
      // 页码范围对话框:焦点落在「格式/清晰度」下拉框上时,input 上的 Esc 收不到,在这里兜底
      if (pagesDialogState.open) {
        submitPagesRange(null)
        return
      }
      ui.searchOpen = false
      ui.aboutOpen = false
      setTool('select')
      return
    }
    if (!docState.pdfDoc) return
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      stepPage(1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      stepPage(-1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      scrollToPage(1)
    } else if (event.key === 'End') {
      event.preventDefault()
      scrollToPage(docState.pageCount)
    } else if (event.key === 'PageDown') {
      event.preventDefault()
      stepPage(1)
    } else if (event.key === 'PageUp') {
      event.preventDefault()
      stepPage(-1)
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeyDown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
}
