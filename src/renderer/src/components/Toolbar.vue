<script setup lang="ts">
import { computed } from 'vue'
import { docReady } from '../store/document'
import { setTool, ui, type Tool } from '../store/ui'
import { canRedo, canUndo, removeSelected, redo, undo } from '../store/annotations'
import { rotateView } from '../store/viewer'
import { exportCurrentPageImage, openFileDialog, openImageToPdfDialog, printPagesDialog, saveDocument, saveDocumentAs } from '../lib/actions'
import { STAMPS, STAMP_KEYS } from '../lib/annots'

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

const hasDoc = computed(() => docReady.value)
/** 长操作(保存/拆分/合并/打印/导出)执行中:入口置灰,防止重复启动 */
const busy = computed(() => ui.busy !== null)
</script>

<template>
  <header class="toolbar">
    <div class="toolbar-row">
      <span class="app-title">PDF 编辑器</span>
      <button title="打开 PDF (Ctrl+O)" @click="openFileDialog">打开</button>
      <button title="把 PNG/JPEG 图片合并为一份 PDF" @click="openImageToPdfDialog()">图片转 PDF</button>
      <button :disabled="!hasDoc || busy" title="保存 PDF (Ctrl+S)" @click="saveDocument">保存</button>
      <button :disabled="!hasDoc || busy" title="另存为 (Ctrl+Shift+S)" @click="saveDocumentAs">另存为</button>
      <button :disabled="!hasDoc || busy" title="导出当前页为 PNG (Ctrl+E)" @click="exportCurrentPageImage">导出图片</button>
      <button :disabled="!hasDoc || busy" title="打印 (Ctrl+P)" @click="printPagesDialog">打印</button>

      <span class="divider"></span>

      <button :disabled="!canUndo" title="撤销 (Ctrl+Z)" @click="undo">撤销</button>
      <button :disabled="!canRedo" title="重做 (Ctrl+Y)" @click="redo">重做</button>
      <button :disabled="ui.selectedAnnotationIds.length === 0" title="删除选中 (Delete)" @click="removeSelected">删除</button>

      <span class="divider"></span>

      <button :disabled="!hasDoc" title="视图左旋 90°" @click="rotateView(-90)">左旋</button>
      <button :disabled="!hasDoc" title="视图右旋 90°" @click="rotateView(90)">右旋</button>
      <button :disabled="!hasDoc" :class="{ active: ui.searchOpen }" title="搜索 (Ctrl+F)" @click="ui.searchOpen = !ui.searchOpen">
        搜索
      </button>
      <button title="关于 / 开源许可" @click="ui.aboutOpen = true">关于</button>
      <button
        :class="{ active: ui.showThumbnails }"
        title="显示/隐藏缩略图栏 (Ctrl+B)"
        @click="ui.showThumbnails = !ui.showThumbnails"
      >
        缩略图
      </button>
      <button
        :class="{ active: ui.showRightPanel }"
        title="显示/隐藏右侧面板 (Ctrl+Shift+B)"
        @click="ui.showRightPanel = !ui.showRightPanel"
      >
        侧栏
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

.stamp-select {
  padding: 3px 4px;
}

button {
  white-space: nowrap;
}
</style>
