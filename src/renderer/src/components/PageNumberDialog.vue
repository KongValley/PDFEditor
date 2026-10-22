<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { PageNumberFormat } from '@shared/types'
import { formatPageNumber } from '@shared/pagehead'
import { parsePageRange } from '@shared/text'
import { docState } from '../store/document'
import { addPageNumbers } from '../lib/actions'
import { ui } from '../store/ui'

const value = ref('')
const format = ref<PageNumberFormat>('第 1 页 / 共 N 页')
const start = ref(1)
const position = ref<'bottom-center' | 'bottom-right' | 'top-center' | 'top-right'>('bottom-center')
const fontSize = ref(12)
const margin = ref(24)
const error = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

watch(
  () =>ui.pageNumberDialog.open,
  async (open) => {
    if (!open) return
    value.value = ui.pageNumberDialog.preset
    format.value = '第 1 页 / 共 N 页'
    start.value = 1
    position.value = 'bottom-center'
    fontSize.value = 12
    margin.value = 24
    error.value = ''
    await nextTick()
    inputEl.value?.focus()
  }
)

const parsed = computed(() => (value.value.trim() ? parsePageRange(value.value, docState.pageCount) : null))
const invalid = computed(() => value.value.trim().length > 0 && parsed.value === null)
const sample = computed(() =>
  formatPageNumber(format.value, start.value, Math.max(docState.pageCount, 1))
)

async function confirm(): Promise<void> {
  if (invalid.value || ui.pageNumberDialog.running) return
  error.value = ''
  ui.pageNumberDialog.running = true
  const pages = parsed.value ?? []
  const ok = await addPageNumbers({
    pages,
    format: format.value,
    start: start.value,
    position: position.value,
    fontSize: fontSize.value,
    margin: margin.value
  })
  ui.pageNumberDialog.running = false
  if (ok) {
    ui.pageNumberDialog.open = false
  } else {
    error.value = '添加失败,请重试'
  }
}

function cancel(): void {
  if (ui.pageNumberDialog.running) return
  ui.pageNumberDialog.open = false
}
</script>

<template>
  <div v-if="ui.pageNumberDialog.open" class="mask">
    <div class="dialog" @keydown.esc.stop="cancel">
      <div class="title">添加页码</div>
      <div class="message">共 {{ docState.pageCount }} 页,留空 = 全部页</div>
      <input
        ref="inputEl"
        v-model="value"
        :class="{ invalid }"
        :disabled="ui.pageNumberDialog.running"
        placeholder="如 1-3,5,7-9,留空 = 全部页"
        @keydown.enter.prevent="confirm"
      />
      <div v-if="invalid" class="range-error">页码范围无效</div>
      <div v-if="error" class="range-error">{{ error }}</div>
      <div class="row">
        <span class="label">格式</span>
        <select v-model="format" :disabled="ui.pageNumberDialog.running">
          <option value="1">1</option>
          <option value="1 / N">1 / N</option>
          <option value="第 1 页">第 1 页</option>
          <option value="第 1 页 / 共 N 页">第 1 页 / 共 N 页</option>
        </select>
      </div>
      <div class="row">
        <span class="label">起始页码</span>
        <input v-model.number="start" type="number" min="1" :disabled="ui.pageNumberDialog.running" />
      </div>
      <div class="row">
        <span class="label">位置</span>
        <select v-model="position" :disabled="ui.pageNumberDialog.running">
          <option value="bottom-center">页脚居中</option>
          <option value="bottom-right">页脚右侧</option>
          <option value="top-center">页眉居中</option>
          <option value="top-right">页眉右侧</option>
        </select>
      </div>
      <div class="row">
        <span class="label">字号</span>
        <input v-model.number="fontSize" type="number" min="6" max="72" :disabled="ui.pageNumberDialog.running" />
      </div>
      <div class="row">
        <span class="label">边距</span>
        <input v-model.number="margin" type="number" min="0" max="200" :disabled="ui.pageNumberDialog.running" />
      </div>
      <div class="sample">样例:{{ sample }}</div>
      <div class="actions">
        <button :disabled="ui.pageNumberDialog.running" @click="cancel">取消</button>
        <button class="primary" :disabled="invalid || ui.pageNumberDialog.running" @click="confirm">
          {{ ui.pageNumberDialog.running ? '处理中…' : '确定' }}
        </button>
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

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row .label {
  width: 64px;
  flex: none;
  color: var(--toolbar-fg-dim);
}

.row select {
  flex: 1;
}

.row input {
  flex: 1;
}

.sample {
  color: var(--toolbar-fg-dim);
  font-size: 12px;
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
