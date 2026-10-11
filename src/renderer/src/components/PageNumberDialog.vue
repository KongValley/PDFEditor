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
const inputEl = ref<HTMLInputElement | null>(null)

watch(
  () =>ui.pageNumberDialog.open,
  async (open) => {
    if (!open) return
    value.value = ''
    format.value = '第 1 页 / 共 N 页'
    start.value = 1
    position.value = 'bottom-center'
    fontSize.value = 12
    margin.value = 24
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
  if (!parsed.value) return
  ui.pageNumberDialog.open = false
  const pages = value.value.trim() ? parsed.value.map((p) => p - 1) : []
  await addPageNumbers({
    pages,
    format: format.value,
    start: start.value,
    position: position.value,
    fontSize: fontSize.value,
    margin: margin.value
  })
}

function cancel(): void {
  ui.pageNumberDialog.open = false
}
</script>

<template>
  <div v-if="ui.pageNumberDialog.open" class="mask">
    <div class="dialog" @keydown.enter="confirm" @keydown.esc="cancel">
      <div class="title">添加页码</div>
      <div class="message">共 {{ docState.pageCount }} 页,留空 = 全部页</div>
      <input
        ref="inputEl"
        v-model="value"
        :class="{ invalid }"
        placeholder="如 1-3,5,7-9,留空 = 全部页"
      />
      <div v-if="invalid" class="range-error">页码范围无效</div>
      <div class="row">
        <span class="label">格式</span>
        <select v-model="format">
          <option value="1">1</option>
          <option value="1 / N">1 / N</option>
          <option value="第 1 页">第 1 页</option>
          <option value="第 1 页 / 共 N 页">第 1 页 / 共 N 页</option>
        </select>
      </div>
      <div class="row">
        <span class="label">起始页码</span>
        <input v-model.number="start" type="number" min="1" />
      </div>
      <div class="row">
        <span class="label">位置</span>
        <select v-model="position">
          <option value="bottom-center">页脚居中</option>
          <option value="bottom-right">页脚右侧</option>
          <option value="top-center">页眉居中</option>
          <option value="top-right">页眉右侧</option>
        </select>
      </div>
      <div class="row">
        <span class="label">字号</span>
        <input v-model.number="fontSize" type="number" min="6" max="72" />
      </div>
      <div class="row">
        <span class="label">边距</span>
        <input v-model.number="margin" type="number" min="0" max="200" />
      </div>
      <div class="sample">样例:{{ sample }}</div>
      <div class="actions">
        <button @click="cancel">取消</button>
        <button class="primary" :disabled="invalid" @click="confirm">确定</button>
      </div>
    </div>
  </div>
</template>
