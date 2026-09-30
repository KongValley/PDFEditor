<script setup lang="ts">
import { computed } from 'vue'
import type { PageViewport } from 'pdfjs-dist'
import type { FormFieldInfo } from '@shared/types'
import { docState } from '../store/document'
import { pdfRectToScreen } from '../lib/geo'

const props = defineProps<{ pageNumber: number; viewport: PageViewport }>()

const fields = computed(() => docState.formFields.filter((f) => f.page === props.pageNumber - 1))

function boxOf(field: FormFieldInfo): { x: number; y: number; w: number; h: number } {
  return pdfRectToScreen(props.viewport, field.rect)
}

function textValue(field: FormFieldInfo): string {
  const value = docState.formValues[field.fullName]
  return typeof value === 'string' ? value : ''
}

function checkedValue(field: FormFieldInfo): boolean {
  const value = docState.formValues[field.fullName]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value === (field.options?.[0] ?? '')
  return false
}

function onText(field: FormFieldInfo, event: Event): void {
  docState.formValues[field.fullName] = (event.target as HTMLInputElement).value
}

function onCheck(field: FormFieldInfo, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  if (field.type === 'radio') {
    if (checked) docState.formValues[field.fullName] = field.options?.[0] ?? 'On'
    return
  }
  docState.formValues[field.fullName] = checked
}

function onSelect(field: FormFieldInfo, event: Event): void {
  docState.formValues[field.fullName] = (event.target as HTMLSelectElement).value
}
</script>

<template>
  <div class="form-layer">
    <template v-for="field in fields" :key="field.fullName + field.rect.y">
      <input
        v-if="field.type === 'text'"
        class="form-control"
        type="text"
        :style="{
          left: boxOf(field).x + 'px',
          top: boxOf(field).y + 'px',
          width: boxOf(field).w + 'px',
          height: boxOf(field).h + 'px'
        }"
        :value="textValue(field)"
        :title="field.fullName"
        @input="onText(field, $event)"
      />
      <input
        v-else-if="field.type === 'checkbox' || field.type === 'radio'"
        class="form-control check"
        :type="field.type === 'radio' ? 'radio' : 'checkbox'"
        :name="field.fullName"
        :style="{
          left: boxOf(field).x + 'px',
          top: boxOf(field).y + 'px',
          width: boxOf(field).w + 'px',
          height: boxOf(field).h + 'px'
        }"
        :checked="checkedValue(field)"
        :title="field.fullName"
        @change="onCheck(field, $event)"
      />
      <select
        v-else-if="field.type === 'choice'"
        class="form-control"
        :style="{
          left: boxOf(field).x + 'px',
          top: boxOf(field).y + 'px',
          width: boxOf(field).w + 'px',
          height: boxOf(field).h + 'px'
        }"
        :title="field.fullName"
        @change="onSelect(field, $event)"
      >
        <option value="">(未选择)</option>
        <option v-for="option in field.options ?? []" :key="option" :value="option" :selected="textValue(field) === option">
          {{ option }}
        </option>
      </select>
    </template>
  </div>
</template>

<style scoped>
.form-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
}

.form-control {
  position: absolute;
  pointer-events: auto;
  margin: 0;
  padding: 1px 3px;
  font-size: 12px;
  color: #10131a;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(74, 143, 231, 0.75);
  border-radius: 2px;
}

.form-control.check {
  padding: 0;
  accent-color: #4a8fe7;
}
</style>
