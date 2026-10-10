<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Toolbar from './components/Toolbar.vue'
import SearchBar from './components/SearchBar.vue'
import ThumbnailsPanel from './components/ThumbnailsPanel.vue'
import RightPanel from './components/RightPanel.vue'
import PasswordDialog from './components/PasswordDialog.vue'
import MergeDialog from './components/MergeDialog.vue'
import SplitDialog from './components/SplitDialog.vue'
import AboutDialog from './components/AboutDialog.vue'
import PagesRangeDialog from './components/PagesRangeDialog.vue'
import OrientationDialog from './components/OrientationDialog.vue'
import ImageToPdfDialog from './components/ImageToPdfDialog.vue'
import PageContextMenu from './components/PageContextMenu.vue'
import ZoomControl from './components/ZoomControl.vue'
import PdfViewer from './viewer/PdfViewer.vue'
import { cancelOpen, docReady, docState } from './store/document'
import { showToast, ui } from './store/ui'
import { fitPage, fitWidth, scrollToPage, setViewMode, stepPage, zoomAt } from './store/viewer'
import { goBack, goForward, readingState, useReading } from './store/reading'
import {
  confirmDiscardChanges,
  openFileDialog,
  openImageToPdfDialog,
  openPath,
  rotatePages
} from './lib/actions'
import { useGlobalKeymap } from './lib/keymap'

useGlobalKeymap()
useReading()

function onPageCommit(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value >= 1) scrollToPage(Math.floor(value))
  ;(event.target as HTMLInputElement).value = ''
}

/** 状态栏旋转当前页(与快捷键 [ / ] 同源) */
function rotateCurrent(delta: number): void {
  void rotatePages([docState.currentPage - 1], delta)
}

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
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length === 0) return
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.path ?? ''))
  const images = files.filter((f) => /\.(png|jpe?g)$/i.test(f.path ?? ''))
  // 混着拖时以 PDF 为准(与旧行为一致);只有图片时才走转换流程
  if (pdfs.length > 0) {
    const path = window.pdfAPI.getPathForFile(pdfs[0])
    if (!path) return
    if (!confirmDiscardChanges()) return
    if (pdfs.length > 1) showToast(`其余 ${pdfs.length - 1} 个文件已忽略(一次只能打开一个)`)
    void openPath(path)
    return
  }
  if (images.length > 0) {
    void openImageToPdfDialog(images.map((f) => window.pdfAPI.getPathForFile(f)).filter(Boolean))
    return
  }
  showToast('仅支持 PDF 或 PNG/JPEG 图片', 'error')
}

const fileName = computed(() => docState.filePath?.split(/[\\/]/).pop() ?? '')

/* ---------- 窗口标题:文件名 + 未保存标记(任务栏可区分多份文档) ---------- */
function syncTitle(): void {
  const name = fileName.value
  void window.pdfAPI.invoke('app:setTitle', name ? `${name}${docState.dirty ? ' *' : ''} — PDF 编辑器` : 'PDF 编辑器')
}

watch(() => [docState.filePath, docState.dirty] as const, syncTitle, { immediate: true })

/* ---------- 空状态的最近文件(recent.json 本来就在写,只是从没被读过) ---------- */
interface RecentItem {
  path: string
  page: number
}
const recentFiles = ref<RecentItem[]>([])

function baseNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

async function loadRecentFiles(): Promise<void> {
  try {
    const list = (await window.pdfAPI.invoke('app:recentList')) as RecentItem[]
    recentFiles.value = Array.isArray(list) ? list : []
  } catch {
    recentFiles.value = []
  }
}

function openRecent(item: RecentItem): void {
  if (!confirmDiscardChanges()) return
  void openPath(item.path)
}

watch(docReady, (ready) => {
  if (!ready) void loadRecentFiles()
}, { immediate: true })

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
      <ThumbnailsPanel v-if="docReady && ui.showThumbnails" />
      <PdfViewer v-if="docReady" />
      <RightPanel v-if="docReady && ui.showRightPanel" />
      <div v-if="!docReady" class="empty-area">
        <div class="empty-hint">{{ docState.loading ? (docState.loadProgress ?? '加载中…') : '打开或拖入 PDF 文件' }}</div>
        <div v-if="docState.loadError" class="empty-error">{{ docState.loadError }}</div>
        <button v-if="docState.loading" class="empty-open" @click="cancelOpen">取消</button>
        <button v-if="!docState.loading && !docState.loadError" class="empty-open" @click="openFileDialog">打开文件</button>
        <button
          v-if="!docState.loading && !docState.loadError"
          class="empty-open"
          title="把 PNG/JPEG 图片合并为一份 PDF"
          @click="openImageToPdfDialog()"
        >
          图片转 PDF
        </button>
        <div v-if="!docState.loading && !docState.loadError && recentFiles.length > 0" class="recent-list">
          <div class="recent-title">最近打开</div>
          <button v-for="item in recentFiles" :key="item.path" class="recent-item" :title="item.path" @click="openRecent(item)">
            <span class="recent-name">{{ baseNameOf(item.path) }}</span>
            <span v-if="item.page > 0" class="recent-page">第 {{ item.page }} 页</span>
          </button>
        </div>
      </div>
    </div>

    <footer class="status-bar">
      <span class="status-file" :title="docState.filePath ?? ''">{{ fileName || '未打开文件' }}</span>

      <template v-if="docReady">
        <button :disabled="!readingState.canBack" title="后退 (Alt+←)" @click="goBack">后退</button>
        <button :disabled="!readingState.canForward" title="前进 (Alt+→)" @click="goForward">前进</button>

        <span class="status-divider"></span>

        <button title="上一页" @click="stepPage(-1)">上一页</button>
        <input
          class="page-input"
          type="text"
          :placeholder="String(docState.currentPage)"
          @keydown.enter="onPageCommit"
          @blur="onPageCommit"
        />
        <span class="page-total">/ {{ docState.pageCount }}</span>
        <button title="下一页" @click="stepPage(1)">下一页</button>

        <button title="左旋当前页 ([)" @click="rotateCurrent(-90)">⟲</button>
        <button title="右旋当前页 (])" @click="rotateCurrent(90)">⟳</button>

        <span class="status-divider"></span>

        <button
          :class="{ active: docState.viewMode === 'continuous' }"
          title="连续阅读"
          @click="setViewMode('continuous')"
        >
          连续
        </button>
        <button :class="{ active: docState.viewMode === 'single' }" title="单页阅览" @click="setViewMode('single')">
          单页
        </button>
        <button :class="{ active: docState.viewMode === 'two' }" title="双页阅览" @click="setViewMode('two')">
          双页
        </button>

        <span class="status-divider"></span>

        <ZoomControl />
        <button title="实际大小 (1:1)" @click="zoomAt(1)">实际大小</button>
        <button title="适合页面" @click="fitPage">适合页面</button>
        <button title="适合宽度 (Ctrl+0)" @click="fitWidth">适合宽度</button>
      </template>

      <span v-if="ui.busy" class="status-busy">{{ ui.busy }}</span>
      <span v-if="docState.dirty" class="status-dirty">未保存</span>
      <span v-if="docState.encrypted" class="status-warn">加密文档</span>
    </footer>

    <div v-if="dragging" class="drop-mask">松开以打开 PDF</div>
    <PasswordDialog />
    <MergeDialog />
    <PagesRangeDialog />
    <OrientationDialog />
    <ImageToPdfDialog />
    <SplitDialog />
    <AboutDialog />
    <PageContextMenu />
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

/* 最近文件区在大屏上按左对齐成列表,避免长路径把布局撑开 */
.recent-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: min(560px, 70%);
  margin-top: 8px;
  max-height: 40%;
  overflow: auto;
}

.recent-title {
  color: var(--muted);
  font-size: 12px;
  padding: 0 8px 4px;
}

.recent-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--fg);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.recent-item:hover {
  background: var(--surface);
}

.recent-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-page {
  color: var(--muted);
  font-size: 12px;
  flex: none;
}

.empty-open {
  margin-top: 4px;
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
  gap: 8px;
  min-height: 30px;
  padding: 2px 12px;
  background: var(--toolbar-bg);
  border-top: 1px solid var(--panel-border);
  color: var(--toolbar-fg-dim);
  font-size: 12px;
  flex: none;
  flex-wrap: wrap; /* 窄窗口下控件换行,不裁切 */
}

.status-bar button {
  padding: 2px 6px;
  font-size: 12px;
  white-space: nowrap;
}

.status-divider {
  width: 1px;
  height: 16px;
  background: var(--panel-border);
  flex: none;
}

.status-bar .page-input {
  width: 44px;
  padding: 2px 4px;
  text-align: center;
  font-size: 12px;
}

.page-total {
  color: var(--toolbar-fg-dim);
  white-space: nowrap;
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

.status-busy {
  color: #8fd0ff;
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
