<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { docState } from '../store/document'
import { parsePageRange } from '@shared/text'
import {
  pagesDialogState,
  submitPagesRange,
  type ExportFormat,
  type ExportMode,
  type PagesAction,
  type PrintQuality
} from '../store/ui'

const TITLES: Record<PagesAction, string> = {
  extract: '提取页面',
  delete: '删除页面',
  export: '导出页面',
  print: '打印页面'
}

const value = ref('')
const format = ref<ExportFormat>('pdf')
const mode = ref<ExportMode>('each')
const direction = ref<'h' | 'v'>('v')
const includeAnnotations = ref(true)
const printQuality = ref<PrintQuality>('standard')
const inputEl = ref<HTMLInputElement | null>(null)

const isExport = computed(() => pagesDialogState.action === 'export')
const isPrint = computed(() => pagesDialogState.action === 'print')
const showIncludeAnnotations = computed(() => pagesDialogState.action !== 'delete')

watch(
  () => pagesDialogState.open,
  async (open) => {
    if (!open) return
    value.value = ''
    format.value = 'pdf'
    mode.value = 'each'
    direction.value = 'v'
    includeAnnotations.value = true
    printQuality.value = 'standard'
    await nextTick()
    inputEl.value?.focus()
  }
)

/** 实时解析:无效时红框 + 禁用「确定」,不再等关窗后由调用方报错 */
const parsed = computed(() => (value.value.trim() ? parsePageRange(value.value, docState.pageCount) : null))
const invalid = computed(() => value.value.trim().length > 0 && parsed.value === null)

function confirm(): void {
  if (!parsed.value) return
  submitPagesRange({
    input: value.value,
    format: format.value,
    mode: mode.value,
    direction: direction.value,
    includeAnnotations: includeAnnotations.value,
    printQuality: printQuality.value
  })
}

function cancel(): void {
  submitPagesRange(null)
}
</script>

<template>
  <div v-if="pagesDialogState.open" class="mask">
    <div class="dialog" @keydown.enter="confirm" @keydown.esc="cancel">
      <div class="title">{{ TITLES[pagesDialogState.action] }}</div>
      <div class="message">共 {{ docState.pageCount }} 页,输入页码范围</div>
      <input
        ref="inputEl"
        v-model="value"
        :class="{ invalid }"
        placeholder="如 1-3,5,7-9"
      />
      <div v-if="invalid" class="range-error">页码范围无效</div>
      <div v-else-if="parsed" class="range-hint">将处理 {{ parsed.length }} 页</div>
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
      <div v-if="isPrint" class="row">
        <span class="label">清晰度</span>
        <select v-model="printQuality">
          <option value="standard">标准(约 150 dpi)</option>
          <option value="high">高清(约 300 dpi)</option>
        </select>
      </div>
      <label v-if="showIncludeAnnotations" class="check-row">
        <input v-model="includeAnnotations" type="checkbox" />
        包含注释
      </label>
      <div class="actions">
        <button @click="cancel">取消</button>
        <button class="primary" :disabled="!parsed" @click="confirm">确定</button>
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

/* 实时校验:与拆分/合并对话框同一套红框语义 */
input.invalid {
  border-color: #e5534b;
}

.range-error {
  color: #ffb4b4;
  font-size: 12px;
}

.range-hint {
  color: var(--toolbar-fg-dim);
  font-size: 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--toolbar-fg-dim);
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
