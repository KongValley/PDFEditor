<script setup lang="ts">
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from 'vue'
import { mergeDialogState, submitMergeSpecs } from '../store/ui'
import { parsePageRange } from '@shared/text'

const inputs = ref<string[]>([])
const inputEls = ref<(HTMLInputElement | null)[]>([])

watch(
  () => mergeDialogState.open,
  async (open) => {
    if (!open) return
    inputs.value = mergeDialogState.files.map(() => '')
    inputEls.value = []
    await nextTick()
    inputEls.value[0]?.focus()
  }
)

const rows = computed(() =>
  mergeDialogState.files.map((entry, i) => {
    const text = (inputs.value[i] ?? '').trim()
    const pages = text === '' ? null : parsePageRange(text, entry.pageCount)
    return { ok: text === '' || pages !== null, pages }
  })
)

const allValid = computed(() => rows.value.every((row) => row.ok))

function setInputRef(el: Element | ComponentPublicInstance | null, index: number): void {
  inputEls.value[index] = el as HTMLInputElement | null
}

function confirm(): void {
  if (!allValid.value) return
  submitMergeSpecs(
    mergeDialogState.files.map((file, i) => ({ path: file.path, pages: rows.value[i].pages }))
  )
}

function cancel(): void {
  submitMergeSpecs(null)
}
</script>

<template>
  <div v-if="mergeDialogState.open" class="mask">
    <div class="dialog">
      <div class="title">合并页面</div>
      <div class="message">依次追加到当前文档末尾;留空 = 全部页</div>
      <div class="file-list">
        <div v-for="(file, i) in mergeDialogState.files" :key="i" class="file-row">
          <div class="file-info">
            <span class="file-name" :title="file.path">{{ file.name }}</span>
            <span class="file-pages">共 {{ file.pageCount }} 页</span>
          </div>
          <input
            :ref="(el) => setInputRef(el, i)"
            v-model="inputs[i]"
            placeholder="如 1-3,5"
            @keydown.enter="confirm"
            @keydown.esc="cancel"
          />
          <div v-if="!rows[i].ok" class="row-error">页码范围无效</div>
        </div>
      </div>
      <div class="actions">
        <button @click="cancel">取消</button>
        <button class="primary" :disabled="!allValid" @click="confirm">确定</button>
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

.file-list {
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.file-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.file-info {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-pages {
  flex: none;
  font-size: 12px;
  color: var(--toolbar-fg-dim);
}

.row-error {
  font-size: 12px;
  color: #ffb4b4;
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

button.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
