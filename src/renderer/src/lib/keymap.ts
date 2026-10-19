import { onBeforeUnmount, onMounted } from 'vue'
import { docState } from '../store/document'
import {
  cancelImagePdf,
  cancelOrientationPlan,
  imagePdfDialogState,
  mergeDialogState,
  orientationDialogState,
  pagesDialogState,
  passwordState,
  setTool,
  splitDialogState,
  submitPagesRange,
  ui
} from '../store/ui'
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
      // 拖拽未提交时保存会漏掉最后一帧位移(move 模式松手才写模型)
      if (ui.dragging) return
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

    // 模态守卫:对话框打开时,除上面的「不打断录入」快捷键外,其余文档级快捷键一律让位。
    // 遮罩挡住了鼠标却挡不住键盘 —— 少了这道闸,用户在「图片转 PDF」对话框里按
    // `[`/`]`/Delete/方向键,会在看不见的背景上删除注释、旋转页面、切换视图模式。
    // 该对话框聚焦的是 <button>(其余对话框都聚焦 <input>,被 isTypingTarget 命中),
    // 正好从上面的缝隙漏过来,故在此统一兜住全部模态。
    if (
      event.key !== 'Escape' &&
      (pagesDialogState.open ||
        orientationDialogState.open ||
        imagePdfDialogState.open ||
        mergeDialogState.open ||
        splitDialogState.open ||
        passwordState.open ||
        ui.watermarkDialog.open ||
        ui.pageNumberDialog.open ||
        ui.aboutOpen ||
        ui.problemsOpen)
    ) {
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
      if (ui.dragging) return
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
      if (ui.busy !== null) return
      event.preventDefault()
      void rotatePages([docState.currentPage - 1], event.key === '[' ? -90 : 90)
      return
    }
    // 页面操作
    if (ctrl && event.shiftKey && key === 'n') {
      if (ui.busy !== null) return
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
      if (orientationDialogState.open) {
        cancelOrientationPlan()
        return
      }
      // 图片转 PDF 转换中不响应 Esc:避免留下半开的进度界面
      if (imagePdfDialogState.open && !imagePdfDialogState.running) {
        cancelImagePdf()
        return
      }
      // 页面右键菜单:菜单本身不可聚焦,它的 @keydown.esc 收不到键盘事件,
      // 只有点外部/滚动能关。Esc 收不到这里就一直挂着,而且下面的 setTool('select')
      // 还会把当前工具悄悄改掉 —— 用户想撤销的只是「关菜单」。
      if (ui.pageMenu.open) {
        ui.pageMenu.open = false
        return
      }
      // 水印/页码对话框的遮罩挡鼠标不挡键盘:焦点离开输入框后 Esc 收不到,
      // 只有这里全局兜底(与上面的模态守卫配合:Escape 已被放行到此分支)
      if (ui.watermarkDialog.open) {
        ui.watermarkDialog.open = false
        return
      }
      if (ui.pageNumberDialog.open) {
        ui.pageNumberDialog.open = false
        return
      }
      if (ui.problemsOpen) {
        ui.problemsOpen = false
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
