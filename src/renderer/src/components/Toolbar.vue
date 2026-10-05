<script setup lang="ts">
import { computed } from 'vue'
import { docState } from '../store/document'
import { setTool, ui, type Tool } from '../store/ui'
import { canRedo, canUndo, removeSelected, redo, undo } from '../store/annotations'
import { fitPage, fitWidth, rotateView, scrollToPage, zoomAt, zoomBy } from '../store/viewer'
import { exportCurrentPageImage, openFileDialog, saveDocument, saveDocumentAs } from '../lib/actions'
import { STAMPS, STAMP_KEYS } from '../lib/annots'

const ZOOM_PRESETS = [25, 50, 75, 100, 125, 150, 200, 300]

const TOOLS: Array<{ tool: Tool; label: string; title: string }> = [
  { tool: 'select', label: '选择', title: '选择 / 移动注释' },
  { tool: 'highlight', label: '高亮', title: '高亮:划选文本或拖拽框选' },
  { tool: 'rect', label: '矩形', title: '矩形框' },
  { tool: 'ellipse', label: '椭圆', title: '椭圆框' },
  { tool: 'ink', label: '画笔', title: '自由绘制' },
  { tool: 'arrow', label: '箭头', title: '箭头' },
  { tool: 'measure', label: '测量', title: '距离测量(mm)' },
  { tool: 'text', label: '文字', title: '插入文字' },
  { tool: 'note', label: '便签', title: '便签' },
  { tool: 'stamp', label: '图章', title: '插入图章' },
  { tool: 'image', label: '图片', title: '插入图片(PNG/JPEG)' }
]

const zoomPercent = computed(() => Math.round(docState.scale * 100))
const hasDoc = computed(() => docState.pdfDoc !== null)

function onZoomPreset(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value)
  ;(event.target as HTMLSelectElement).value = ''
  if (value > 0) zoomAt(value / 100)
}

function onPageCommit(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value >= 1) scrollToPage(Math.floor(value))
  ;(event.target as HTMLInputElement).value = ''
}
</script>

<template>
  <header class="toolbar">
    <div class="toolbar-row">
      <span class="app-title">PDF 编辑器</span>
      <button title="打开 PDF (Ctrl+O)" @click="openFileDialog">打开</button>
      <button :disabled="!hasDoc" title="保存 PDF (Ctrl+S)" @click="saveDocument">保存</button>
      <button :disabled="!hasDoc" title="另存为 (Ctrl+Shift+S)" @click="saveDocumentAs">另存为</button>
      <button :disabled="!hasDoc" title="导出当前页为 PNG (Ctrl+E)" @click="exportCurrentPageImage">导出图片</button>

      <span class="divider"></span>

      <button :disabled="!canUndo" title="撤销 (Ctrl+Z)" @click="undo">撤销</button>
      <button :disabled="!canRedo" title="重做 (Ctrl+Y)" @click="redo">重做</button>
      <button :disabled="ui.selectedAnnotationIds.length === 0" title="删除选中 (Delete)" @click="removeSelected">删除</button>

      <span class="divider"></span>

      <button :disabled="!hasDoc" title="上一页" @click="scrollToPage(docState.currentPage - 1)">上一页</button>
      <input
        class="page-input"
        type="text"
        :placeholder="String(docState.currentPage)"
        :disabled="!hasDoc"
        @keydown.enter="onPageCommit"
        @blur="onPageCommit"
      />
      <span class="page-total">/ {{ docState.pageCount || '-' }}</span>
      <button :disabled="!hasDoc" title="下一页" @click="scrollToPage(docState.currentPage + 1)">下一页</button>

      <span class="divider"></span>

      <button :disabled="!hasDoc" title="缩小 (Ctrl+-)" @click="zoomBy(1 / 1.1)">−</button>
      <span class="zoom-value">{{ hasDoc ? zoomPercent + '%' : '-' }}</span>
      <button :disabled="!hasDoc" title="放大 (Ctrl+=)" @click="zoomBy(1.1)">+</button>
      <select class="zoom-preset" :disabled="!hasDoc" @change="onZoomPreset">
        <option value="">预设</option>
        <option v-for="preset in ZOOM_PRESETS" :key="preset" :value="preset">{{ preset }}%</option>
      </select>
      <button :disabled="!hasDoc" title="适应宽度 (Ctrl+0)" @click="fitWidth">适应宽度</button>
      <button :disabled="!hasDoc" title="适应页面" @click="fitPage">适应页面</button>

      <span class="divider"></span>

      <button :disabled="!hasDoc" title="视图左旋 90°" @click="rotateView(-90)">左旋</button>
      <button :disabled="!hasDoc" title="视图右旋 90°" @click="rotateView(90)">右旋</button>
      <button :disabled="!hasDoc" :class="{ active: ui.searchOpen }" title="搜索 (Ctrl+F)" @click="ui.searchOpen = !ui.searchOpen">
        搜索
      </button>
    </div>

    <div class="toolbar-row">
      <button
        v-for="item in TOOLS"
        :key="item.tool"
        :disabled="!hasDoc"
        :class="{ active: ui.tool === item.tool }"
        :title="item.title"
        @click="setTool(item.tool)"
      >
        {{ item.label }}
      </button>
      <select v-if="ui.tool === 'stamp'" v-model="ui.stampKey" class="stamp-select" title="选择图章">
        <option v-for="key in STAMP_KEYS" :key="key" :value="key">{{ STAMPS[key].label }}</option>
      </select>
    </div>
  </header>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 12px;
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--panel-border);
  flex: none;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  flex-wrap: wrap;
}

.app-title {
  font-weight: 600;
  margin-right: 6px;
  white-space: nowrap;
}

.divider {
  width: 1px;
  height: 20px;
  background: var(--panel-border);
  margin: 0 4px;
  flex: none;
}

.page-input {
  width: 48px;
  text-align: center;
}

.page-total {
  color: var(--toolbar-fg-dim);
  white-space: nowrap;
}

.zoom-value {
  min-width: 48px;
  text-align: center;
  color: var(--toolbar-fg-dim);
}

.zoom-preset,
.stamp-select {
  padding: 3px 4px;
}

button {
  white-space: nowrap;
}
</style>
