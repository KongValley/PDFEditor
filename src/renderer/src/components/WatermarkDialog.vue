<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { parsePageRange } from '@shared/text'
import { docState } from '../store/document'
import { addWatermark } from '../lib/actions'
import { ui } from '../store/ui'

const value = ref('')
const text = ref('机密')
const fontSize = ref(48)
const opacity = ref(0.15)
const rotation = ref(45)
const tile = ref(false)
const color = ref('#e03131')
const inputEl = ref<HTMLInputElement | null>(null)

watch(
  () => ui.watermarkDialog.open,
  async (open) => {
    if (!open) return
    value.value = ui.watermarkDialog.preset
    text.value = '机密'
    fontSize.value = 48
    opacity.value = 0.15
    rotation.value = 45
    tile.value = false
    color.value = '#e03131'
    await nextTick()
    inputEl.value?.focus()
  }
)

const parsed = computed(() => (value.value.trim() ? parsePageRange(value.value, docState.pageCount) : null))
const invalid = computed(() => value.value.trim().length > 0 && parsed.value === null)

async function confirm(): Promise<void> {
  if (invalid.value) return
  ui.watermarkDialog.open = false
  const pages = parsed.value ?? []
  await addWatermark({
    pages,
    text: text.value,
    fontSize: fontSize.value,
    opacity: opacity.value,
    rotation: rotation.value,
    tile: tile.value,
    color: color.value
  })
}

function cancel(): void {
  ui.watermarkDialog.open = false
}
</script>

<template>
  <div v-if="ui.watermarkDialog.open" class="mask">
    <div class="dialog" @keydown.enter="confirm" @keydown.esc="cancel">
      <div class="title">添加水印</div>
      <div class="message">共 {{ docState.pageCount }} 页,留空 = 全部页</div>
      <input
        ref="inputEl"
        v-model="value"
        :class="{ invalid }"
        placeholder="如 1-3,5,7-9,留空 = 全部页"
      />
      <div v-if="invalid" class="range-error">页码范围无效</div>
      <div class="row">
        <span class="label">文本</span>
        <input v-model="text" />
      </div>
      <div class="row">
        <span class="label">字号</span>
        <input v-model.number="fontSize" type="number" min="6" max="200" />
      </div>
      <div class="row">
        <span class="label">不透明度</span>
        <input v-model.number="opacity" type="number" min="0.02" max="1" step="0.05" />
      </div>
      <div class="row">
        <span class="label">角度</span>
        <input v-model.number="rotation" type="number" min="-180" max="180" />
      </div>
      <div class="row">
        <span class="label">颜色</span>
        <input v-model="color" type="color" />
      </div>
      <label class="check-row">
        <input v-model="tile" type="checkbox" />
        铺满页面
      </label>
      <div class="actions">
        <button @click="cancel">取消</button>
        <button class="primary" :disabled="invalid || text.trim() === ''" @click="confirm">确定</button>
      </div>
    </div>
  </div>
</template>
