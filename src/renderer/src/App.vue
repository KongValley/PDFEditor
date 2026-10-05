<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Toolbar from './components/Toolbar.vue'
import SearchBar from './components/SearchBar.vue'
import ThumbnailsPanel from './components/ThumbnailsPanel.vue'
import RightPanel from './components/RightPanel.vue'
import PasswordDialog from './components/PasswordDialog.vue'
import MergeDialog from './components/MergeDialog.vue'
import SplitDialog from './components/SplitDialog.vue'
import PagesRangeDialog from './components/PagesRangeDialog.vue'
import PdfViewer from './viewer/PdfViewer.vue'
import { docState } from './store/document'
import { showToast, ui } from './store/ui'
import { confirmDiscardChanges, openPath } from './lib/actions'
import { useGlobalKeymap } from './lib/keymap'

useGlobalKeymap()

const dragging = ref(false)
let dragDepth = 0

/** 仅外部文件拖入时接管拖放(内部缩略图排序的 drag 不带 Files) */
function isFileDrag(event: DragEvent): boolean {
  return !!event.dataTransfer && event.dataTransfer.types.includes('Files')
}

function onDragEnter(event: DragEvent): void {
  if (!isFileDrag(event)) return
  event.preventDefault()
  dragDepth++
  dragging.value = true
}

function onDragOver(event: DragEvent): void {
  if (!isFileDrag(event)) return
  event.preventDefault()
}

function onDragLeave(): void {
  dragDepth = Math.max(dragDepth - 1, 0)
  if (dragDepth === 0) dragging.value = false
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  dragDepth = 0
  dragging.value = false
  const files = event.dataTransfer?.files
  if (!files || files.length === 0) return
  const path = window.pdfAPI.getPathForFile(files[0])
  if (!path || !/\.pdf$/i.test(path)) {
    showToast('仅支持 PDF 文件', 'error')
    return
  }
  if (!confirmDiscardChanges()) return
  if (files.length > 1) showToast(`其余 ${files.length - 1} 个文件已忽略(一次只能打开一个)`)
  void openPath(path)
}

const fileName = computed(() => docState.filePath?.split(/[\\/]/).pop() ?? '')

// 脏标记同步主进程(关窗确认用)
watch(
  () => docState.dirty,
  (value) => {
    void window.pdfAPI.invoke('app:setDirty', value)
  },
  { immediate: true }
)
</script>

<template>
  <div class="app-shell" @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <Toolbar />
    <SearchBar />

    <div class="main-row">
      <ThumbnailsPanel v-if="docState.pdfDoc" />
      <PdfViewer v-if="docState.pdfDoc" />
      <RightPanel v-if="docState.pdfDoc" />
      <div v-else class="empty-area">
        <div class="empty-hint">{{ docState.loading ? '加载中…' : '打开或拖入 PDF 文件' }}</div>
        <div v-if="docState.loadError" class="empty-error">{{ docState.loadError }}</div>
      </div>
    </div>

    <footer class="status-bar">
      <span class="status-file" :title="docState.filePath ?? ''">{{ fileName || '未打开文件' }}</span>
      <span v-if="docState.pdfDoc">第 {{ docState.currentPage }} / {{ docState.pageCount }} 页</span>
      <span v-if="docState.pdfDoc">缩放 {{ Math.round(docState.scale * 100) }}%</span>
      <span v-if="docState.dirty" class="status-dirty">未保存</span>
      <span v-if="docState.encrypted" class="status-warn">加密文档</span>
    </footer>

    <div v-if="dragging" class="drop-mask">松开以打开 PDF</div>
    <PasswordDialog />
    <MergeDialog />
    <PagesRangeDialog />
    <SplitDialog />
    <div v-if="ui.toast" class="toast" :class="ui.toast.kind">{{ ui.toast.text }}</div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.main-row {
  flex: 1;
  display: flex;
  min-height: 0;
}

.empty-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--viewer-bg);
}

.empty-hint {
  color: #cfd4de;
  font-size: 15px;
}

.empty-error {
  color: #ffb4b4;
  font-size: 13px;
  max-width: 60%;
  text-align: center;
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 26px;
  padding: 0 12px;
  background: var(--toolbar-bg);
  border-top: 1px solid var(--panel-border);
  color: var(--toolbar-fg-dim);
  font-size: 12px;
  flex: none;
}

.status-file {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-warn {
  color: #f0c36d;
}

.status-dirty {
  color: #f0c36d;
}

.drop-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(30, 34, 43, 0.65);
  border: 3px dashed var(--accent);
  color: #fff;
  font-size: 20px;
  pointer-events: none;
  z-index: 100;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 48px;
  transform: translateX(-50%);
  max-width: 70%;
  padding: 8px 16px;
  border-radius: 6px;
  background: #2f3542;
  color: #e6e9f0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  z-index: 200;
}

.toast.error {
  background: #7a2f2f;
}
</style>
