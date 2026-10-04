<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { docState } from '../store/document'
import {
  pagesDialogState,
  submitPagesRange,
  type ExportFormat,
  type ExportMode,
  type PagesAction
} from '../store/ui'

const TITLES: Record<PagesAction, string> = {
  extract: '提取页面',
  delete: '删除页面',
  export: '导出页面'
}

const value = ref('')
const format = ref<ExportFormat>('pdf')
const mode = ref<ExportMode>('each')
const direction = ref<'h' | 'v'>('v')
const inputEl = ref<HTMLInputElement | null>(null)

const isExport = computed(() => pagesDialogState.action === 'export')

watch(
  () => pagesDialogState.open,
  async (open) => {
    if (!open) return
    value.value = ''
    format.value = 'pdf'
    mode.value = 'each'
    direction.value = 'v'
    await nextTick()
    inputEl.value?.focus()
  }
)

function confirm(): void {
  submitPagesRange({
    input: value.value,
    format: format.value,
    mode: mode.value,
    direction: direction.value
  })
}

function cancel(): void {
  submitPagesRange(null)
}
</script>

<template>
  <div v-if="pagesDialogState.open" class="mask">
    <div class="dialog">
      <div class="title">{{ TITLES[pagesDialogState.action] }}</div>
      <div class="message">共 {{ docState.pageCount }} 页,输入页码范围</div>
      <input
        ref="inputEl"
        v-model="value"
        placeholder="如 1-3,5,7-9"
        @keydown.enter="confirm"
        @keydown.esc="cancel"
      />
      <template v-if="isExport">
        <div class="row">
          <span class="label">格式</span>
          <select v-model="format">
            <option value="pdf">PDF 文档</option>
            <option value="png">PNG 图片</option>
          </select>
        </div>
        <template v-if="format === 'png'">
          <div class="row">
            <span class="label">方式</span>
            <select v-model="mode">
              <option value="each">逐页多图</option>
              <option value="long">拼接长图</option>
            </select>
          </div>
          <div v-if="mode === 'long'" class="row">
            <span class="label">方向</span>
            <select v-model="direction">
              <option value="v">纵向(上下)</option>
              <option value="h">横向(左右)</option>
            </select>
          </div>
        </template>
      </template>
      <div class="actions">
        <button @click="cancel">取消</button>
        <button class="primary" @click="confirm">确定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 23, 30, 0.6);
  z-index: 300;
}

.dialog {
  width: 320px;
  padding: 16px;
  border-radius: 8px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.title {
  font-weight: 600;
}

.message {
  color: var(--toolbar-fg-dim);
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.label {
  width: 32px;
  color: var(--toolbar-fg-dim);
}

select {
  flex: 1;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

button.primary {
  background: var(--accent);
  color: #fff;
}
</style>
