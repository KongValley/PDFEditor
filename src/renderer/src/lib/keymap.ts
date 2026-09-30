import { onBeforeUnmount, onMounted } from 'vue'
import { docState } from '../store/document'
import { ui } from '../store/ui'
import { removeSelected, redo, undo } from '../store/annotations'
import { fitWidth, scrollToPage, zoomBy } from '../store/viewer'
import { exportCurrentPageImage, openFileDialog, saveDocument } from './actions'

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

export function useGlobalKeymap(): void {
  function onKeyDown(event: KeyboardEvent): void {
    const ctrl = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()

    if (ctrl && key === 'o') {
      event.preventDefault()
      void openFileDialog()
      return
    }
    if (ctrl && key === 's') {
      event.preventDefault()
      void saveDocument()
      return
    }
    if (ctrl && key === 'e') {
      event.preventDefault()
      void exportCurrentPageImage()
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
    if (ctrl && key === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
      return
    }
    if (ctrl && key === 'y') {
      event.preventDefault()
      redo()
      return
    }
    if (event.key === 'F11') {
      event.preventDefault()
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen()
      return
    }
    if (isTypingTarget(event.target)) return

    if ((event.key === 'Delete' || event.key === 'Backspace') && ui.selectedAnnotationId) {
      event.preventDefault()
      removeSelected()
      return
    }

    if (event.key === 'Escape') {
      ui.searchOpen = false
      ui.tool = 'select'
      return
    }
    if (!docState.pdfDoc) return
    if (event.key === 'PageDown') {
      event.preventDefault()
      scrollToPage(docState.currentPage + 1)
    } else if (event.key === 'PageUp') {
      event.preventDefault()
      scrollToPage(docState.currentPage - 1)
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeyDown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
}
