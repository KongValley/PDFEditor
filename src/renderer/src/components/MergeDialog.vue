<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { mergeDialogState, submitMergeWork, type MergeRow } from '../store/ui'
import { pickPdfFileEntries } from '../lib/actions'

const nameInput = ref<HTMLInputElement | null>(null)

watch(
  () => mergeDialogState.open,
  async (open) => {
    if (!open) return
    await nextTick()
    nameInput.value?.focus()
  }
)

function startInt(row: MergeRow): number {
  return /^\d+$/.test(row.start.trim()) ? Number(row.start) : Number.NaN
}

function endInt(row: MergeRow): number {
  return /^\d+$/.test(row.end.trim()) ? Number(row.end) : Number.NaN
}

function startBad(row: MergeRow): boolean {
  const value = startInt(row)
  return Number.isNaN(value) || value < 1 || value > row.pageCount
}

function endBad(row: MergeRow): boolean {
  if (startBad(row)) return true
  const value = endInt(row)
  return Number.isNaN(value) || value < 1 || value > row.pageCount || value < startInt(row)
}

const outputNameBad = computed(() => {
  const name = mergeDialogState.outputName.trim()
  return name === '' || /[\\/:*?"<>|]/.test(name)
})

const totalPages = computed(() => {
  let total = 0
  for (const row of mergeDialogState.rows) {
    if (!startBad(row) && !endBad(row)) total += endInt(row) - startInt(row) + 1
  }
  return total
})

const selectedCount = computed(() => mergeDialogState.rows.filter((row) => row.selected).length)

const allValid = computed(() => mergeDialogState.rows.every((row) => !startBad(row) && !endBad(row)))

const canMerge = computed(() => mergeDialogState.rows.length >= 2 && allValid.value && !outputNameBad.value)

async function addFiles(): Promise<void> {
  const entries = await pickPdfFileEntries(mergeDialogState.rows.map((row) => row.path))
  for (const entry of entries) {
    mergeDialogState.rows.push({
      kind: 'file',
      path: entry.path,
      name: entry.name,
      pageCount: entry.pageCount,
      start: '1',
      end: String(entry.pageCount),
      selected: false
    })
  }
}

function clearSelected(): void {
  mergeDialogState.rows = mergeDialogState.rows.filter((row) => row.kind === 'current' || !row.selected)
}

function moveRow(index: number, delta: number): void {
  const rows = mergeDialogState.rows
  const target = index + delta
  if (index <= 0 || target <= 0 || target >= rows.length) return
  const row = rows[index]
  rows[index] = rows[target]
  rows[target] = row
}

function removeRow(index: number): void {
  if (mergeDialogState.rows[index]?.kind !== 'file') return
  mergeDialogState.rows.splice(index, 1)
}

async function onDirChange(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  if (select.value === '__choose__') {
    const result = (await window.pdfAPI.invoke('app:chooseDir')) as { canceled: boolean; dir: string }
    if (!result.canceled && result.dir) {
      mergeDialogState.outputDir = result.dir
    } else {
      select.value = mergeDialogState.outputDir ?? ''
    }
    return
  }
  mergeDialogState.outputDir = select.value === '' ? null : select.value
}

function confirm(): void {
  if (!canMerge.value) return
  submitMergeWork({
    files: mergeDialogState.rows
      .filter((row) => row.kind === 'file')
      .map((row) => {
        const pages: number[] = []
        for (let p = startInt(row); p <= endInt(row); p++) pages.push(p - 1)
        return { path: row.path, pages }
      }),
    outputName: mergeDialogState.outputName.trim(),
    outputDir: mergeDialogState.outputDir,
    autoOpen: mergeDialogState.autoOpen
  })
}

function cancel(): void {
  submitMergeWork(null)
}
</script>

<template>
  <div v-if="mergeDialogState.open" class="mask">
    <div class="dialog" @keydown.esc="cancel">
      <div class="title">合并页面</div>
      <div class="head grid-row">
        <span></span>
        <span>名称</span>
        <span>页数</span>
        <span>输出范围</span>
        <span>操作</span>
      </div>
      <div class="list">
        <div v-for="(row, i) in mergeDialogState.rows" :key="i" class="row-wrap">
          <div class="grid-row">
            <input v-model="row.selected" type="checkbox" :disabled="row.kind === 'current'" />
            <span class="file-name" :title="row.path">{{ row.name }}</span>
            <span>{{ row.pageCount }}</span>
            <div class="range">
              <input
                v-model="row.start"
                class="num"
                :class="{ invalid: startBad(row) }"
                inputmode="numeric"
                :disabled="row.kind === 'current'"
              />
              <span>-</span>
              <input
                v-model="row.end"
                class="num"
                :class="{ invalid: endBad(row) }"
                inputmode="numeric"
                :disabled="row.kind === 'current'"
              />
            </div>
            <div v-if="row.kind === 'file'" class="ops">
              <button title="上移" :disabled="i <= 1" @click="moveRow(i, -1)">↑</button>
              <button title="下移" :disabled="i >= mergeDialogState.rows.length - 1" @click="moveRow(i, 1)">
                ↓
              </button>
              <button title="删除该文件" @click="removeRow(i)">×</button>
            </div>
            <div v-else></div>
          </div>
        </div>
      </div>
      <div class="list-foot">
        <button @click="addFiles">+ 添加文件</button>
        <button :disabled="selectedCount === 0" @click="clearSelected">
          清除选中({{ selectedCount }}/{{ mergeDialogState.rows.length }})
        </button>
      </div>
      <div class="set-row">
        <span class="label">输出目录</span>
        <select :value="mergeDialogState.outputDir ?? ''" @change="onDirChange">
          <option value="">PDF相同目录</option>
          <option v-if="mergeDialogState.outputDir !== null" :value="mergeDialogState.outputDir">
            {{ mergeDialogState.outputDir }}
          </option>
          <option value="__choose__">选择目录…</option>
        </select>
      </div>
      <div class="set-row">
        <span class="label">输出名称</span>
        <input ref="nameInput" v-model="mergeDialogState.outputName" class="name-input" :class="{ invalid: outputNameBad }" />
        <span class="suffix">.pdf</span>
      </div>
      <label class="set-check">
        <input v-model="mergeDialogState.autoOpen" type="checkbox" />
        转换完成自动打开文件目录
      </label>
      <div class="actions">
        <span class="total">共 {{ totalPages }} 页</span>
        <button @click="cancel">取消</button>
        <button class="primary" :disabled="!canMerge" @click="confirm">开始合并</button>
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
  width: 560px;
  max-width: calc(100vw - 32px);
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

.grid-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) 56px 160px 96px;
  gap: 6px;
  align-items: center;
}

.head {
  color: var(--toolbar-fg-dim);
  font-size: 12px;
}

.list {
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.range {
  display: flex;
  align-items: center;
  gap: 4px;
}

.num {
  width: 100%;
  min-width: 0;
  text-align: center;
}

.invalid {
  border-color: #e06c6c;
}

.ops {
  display: flex;
  gap: 4px;
}

.ops button {
  padding: 2px 6px;
}

.list-foot {
  display: flex;
  gap: 8px;
}

.set-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.set-row .label {
  width: 64px;
  flex: none;
  color: var(--toolbar-fg-dim);
}

.set-row select,
.name-input {
  flex: 1;
  min-width: 0;
}

.suffix {
  color: var(--toolbar-fg-dim);
}

.set-check {
  display: flex;
  align-items: center;
  gap: 6px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

.actions .total {
  margin-right: auto;
  color: var(--toolbar-fg-dim);
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
