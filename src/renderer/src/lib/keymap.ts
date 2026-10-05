import { onBeforeUnmount, onMounted } from 'vue'
import { docState } from '../store/document'
import { setTool, ui } from '../store/ui'
import { copySelection, duplicateSelection, pasteClipboard, removeSelected, redo, undo } from '../store/annotations'
import { searchStep } from '../store/search'
import { fitWidth, scrollToPage, stepPage, zoomBy } from '../store/viewer'
import { goBack, goForward } from '../store/reading'
import { exportCurrentPageImage, openFileDialog, printPagesDialog, saveDocument, saveDocumentAs } from './actions'

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

export function useGlobalKeymap(): void {
  function onKeyDown(event: KeyboardEvent): void {
    const ctrl = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()

    // 文档级快捷键(文本框内也生效):打开/保存/导出/搜索/缩放/全屏/搜索步进
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
    if (event.key === 'F11') {
      event.preventDefault()
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen()
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

    // 编辑类快捷键:输入框/下拉框聚焦时交还原生行为(Ctrl+Z 撤销文本、方向键切换选项)
    if (isTypingTarget(event.target)) return

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
