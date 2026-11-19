<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { ensureFontsLoaded, fontCss, fontState } from '../store/fonts'

const props = defineProps<{
  /** 选中的字族名;'' = 默认字体 */
  modelValue: string
  title?: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

onMounted(ensureFontsLoaded)

const options = computed(() => fontState.fonts)

/** 字体列表还没加载完 / 该字体已卸载:把当前值单列出来,避免下拉框显示空白 */
const missingCurrent = computed(
  () => props.modelValue !== '' && !options.value.some((font) => font.family === props.modelValue)
)

function onChange(event: Event): void {
  emit('update:modelValue', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <select
    class="font-select"
    :value="props.modelValue"
    :disabled="props.disabled"
    :title="props.title ?? (props.modelValue === '' ? '默认字体' : '注释字体')"
    @change="onChange"
  >
    <option value="">默认字体</option>
    <option v-if="fontState.loading && options.length === 0" disabled value="__loading">正在读取系统字体…</option>
    <option v-else-if="fontState.error && options.length === 0" disabled value="__error">系统字体读取失败</option>
    <option v-if="missingCurrent" :value="props.modelValue">
      {{ props.modelValue }}
    </option>
    <option
      v-for="font in options"
      :key="font.family"
      :value="font.family"
      :title="font.family"
      :style="{ fontFamily: fontCss(font.family) }"
    >
      {{ font.label === font.family ? font.family : `${font.label} · ${font.family}` }}
    </option>
  </select>
</template>

<style scoped>
.font-select {
  flex: 1;
  min-width: 0;
  max-width: 100%;
}
</style>
