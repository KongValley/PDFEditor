<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { splitDialogState, submitSplitWork, type SplitRow } from '../store/ui'
import { cancelSplit, pickPdfFileEntries } from '../lib/actions'
import { parsePageRange, splitPageSegments } from '@shared/text'
import type { SplitTask } from '@shared/types'

const dialogEl = ref<HTMLElement | null>(null)

watch(
  () => splitDialogState.open,
  async (open) => {
    if (!open) return
    await nextTick()
    dialogEl.value?.querySelector<HTMLInputElement>('.row-wrap input:not([type="checkbox"])')?.focus()
  }
)

function startInt(row: SplitRow): number {
  return /^\d+$/.test(row.start.trim()) ? Number(row.start) : Number.NaN
}

function endInt(row: SplitRow): number {
  return /^\d+$/.test(row.end.trim()) ? Number(row.end) : Number.NaN
}

function startBad(row: SplitRow): boolean {
  const value = startInt(row)
  return Number.isNaN(value) || value < 1 || value > row.pageCount
}

function endBad(row: SplitRow): boolean {
  if (startBad(row)) return true
  const value = endInt(row)
  return Number.isNaN(value) || value < 1 || value > row.pageCount || value < startInt(row)
}

function pagesBad(row: SplitRow): boolean {
  const value = /^\d+$/.test(row.pagesPerFile.trim()) ? Number(row.pagesPerFile) : Number.NaN
  return Number.isNaN(value) || value < 1
}

function rangesBad(row: SplitRow): boolean {
  return parsePageRange(row.ranges, row.pageCount) === null
}

function rowValid(row: SplitRow): boolean {
  if (row.mode === 'ranges') return !rangesBad(row)
  return !startBad(row) && !endBad(row) && !pagesBad(row)
}

const allValid = computed(() => splitDialogState.rows.length > 0 && splitDialogState.rows.every(rowValid))
const selectedCount = computed(() => splitDialogState.rows.filter((row) => row.selected).length)

async function addFiles(): Promise<void> {
  const entries = await pickPdfFileEntries(splitDialogState.rows.map((row) => row.path))
  for (const entry of entries) {
    splitDialogState.rows.push({
      kind: 'file',
      path: entry.path,
      name: entry.name,
      pageCount: entry.pageCount,
      mode: 'maxPages',
      start: '1',
      end: String(entry.pageCount),
      pagesPerFile: '1',
      ranges: `1-${entry.pageCount}`,
      selected: false
    })
  }
}

function clearSelected(): void {
  splitDialogState.rows = splitDialogState.rows.filter((row) => !row.selected)
}

function removeRow(index: number): void {
  splitDialogState.rows.splice(index, 1)
}

async function onDirChange(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  if (select.value === '__choose__') {
    const result = (await window.pdfAPI.invoke('app:chooseDir')) as { canceled: boolean; dir: string }
    if (!result.canceled && result.dir) {
      splitDialogState.outputDir = result.dir
    } else {
      select.value = splitDialogState.outputDir ?? ''
    }
    return
  }
  splitDialogState.outputDir = select.value === '' ? null : select.value
}

function confirm(): void {
  if (!allValid.value) return
  const tasks: SplitTask[] = splitDialogState.rows.map((row): SplitTask => {
    if (row.mode === 'ranges') {
      return {
        mode: 'ranges',
        path: row.path,
        docId: row.docId,
        ranges: splitPageSegments(parsePageRange(row.ranges, row.pageCount) ?? [])
      }
    }
    return {
      mode: 'maxPages',
      path: row.path,
      docId: row.docId,
      start: startInt(row),
      end: endInt(row),
      pagesPerFile: Number(row.pagesPerFile)
    }
  })
  submitSplitWork({
    tasks,
    outputDir: splitDialogState.outputDir,
    autoOpen: splitDialogState.autoOpen,
    includeAnnotations: splitDialogState.includeAnnotations
  })
}

function cancel(): void {
  submitSplitWork(null)
}

/** 「停止」:主进程在下一个文件边界停下,已写出的文件保留 */
function stopSplit(): void {
  void cancelSplit()
}
</script>

<template>
  <!-- 拆分执行中:对话框已关闭,这里单独显示进度与「停止」 -->
  <div v-if="splitDialogState.running" class="mask">
    <div class="dialog running">
      <div class="title">正在拆分</div>
      <div class="running-text">
        文件 {{ splitDialogState.progress?.processed ?? 0 }} / {{ splitDialogState.progress?.total ?? 0 }},已输出
        {{ splitDialogState.progress?.outputs ?? 0 }} 个文件
      </div>
      <div class="running-bar">
        <div
          class="running-fill"
          :style="{
            width: `${
              splitDialogState.progress?.total
                ? Math.min(100, ((splitDialogState.progress?.processed ?? 0) / splitDialogState.progress.total) * 100)
                : 0
            }%`
          }"
        ></div>
      </div>
      <div class="actions">
        <button @click="stopSplit">停止</button>
      </div>
    </div>
  </div>

  <div v-if="splitDialogState.open" class="mask">
    <div ref="dialogEl" class="dialog" @keydown.esc="cancel">
      <div class="title">拆分页面</div>
      <div class="head grid-row">
        <span></span>
        <span>名称</span>
        <span>页数</span>
        <span>输出范围</span>
        <span>操作</span>
      </div>
      <div class="list">
        <div v-for="(row, i) in splitDialogState.rows" :key="i" class="row-wrap">
          <div class="grid-row">
            <input v-model="row.selected" type="checkbox" />
            <span class="file-name" :title="row.path">{{ row.name }}</span>
            <span>{{ row.pageCount }}</span>
            <div class="range">
              <template v-if="row.mode === 'maxPages'">
                <input v-model="row.start" class="num" :class="{ invalid: startBad(row) }" inputmode="numeric" />
                <span>-</span>
                <input v-model="row.end" class="num" :class="{ invalid: endBad(row) }" inputmode="numeric" />
              </template>
              <input
                v-else
                v-model="row.ranges"
                class="ranges-input"
                :class="{ invalid: rangesBad(row) }"
                placeholder="如 1-3,5-7"
              />
            </div>
            <div class="ops">
              <button title="删除该文件" @click="removeRow(i)">×</button>
            </div>
          </div>
          <div class="row-mode">
            <span class="label">拆分方式</span>
            <select v-model="row.mode">
              <option value="maxPages">最大页数</option>
              <option value="ranges">页码范围</option>
            </select>
            <template v-if="row.mode === 'maxPages'">
              <span class="label">每个文档包含页数</span>
              <input v-model="row.pagesPerFile" class="num per-file" :class="{ invalid: pagesBad(row) }" inputmode="numeric" />
            </template>
          </div>
        </div>
      </div>
      <div class="list-foot">
        <button @click="addFiles">+ 添加文件</button>
        <button :disabled="selectedCount === 0" @click="clearSelected">
          清除选中({{ selectedCount }}/{{ splitDialogState.rows.length }})
        </button>
      </div>
      <div class="set-row">
        <span class="label">输出目录</span>
        <select :value="splitDialogState.outputDir ?? ''" @change="onDirChange">
          <option value="">PDF相同目录</option>
          <option v-if="splitDialogState.outputDir !== null" :value="splitDialogState.outputDir">
            {{ splitDialogState.outputDir }}
          </option>
          <option value="__choose__">选择目录…</option>
        </select>
      </div>
      <label class="set-check">
        <input v-model="splitDialogState.includeAnnotations" type="checkbox" />
        包含注释
      </label>
      <label class="set-check">
        <input v-model="splitDialogState.autoOpen" type="checkbox" />
        转换完成自动打开文件目录
      </label>
      <div class="actions">
        <span class="hint">支持批量文档拆分,请选择拆分方式后开始拆分</span>
        <button @click="cancel">取消</button>
        <button class="primary" :disabled="!allValid" @click="confirm">开始拆分</button>
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

/* 运行中的拆分遮罩:进度条 + 停止 */
.dialog.running {
  width: 380px;
}

.running-text {
  margin: 12px 0 8px;
  font-size: 13px;
  color: var(--toolbar-fg-dim);
}

.running-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--panel-border);
  overflow: hidden;
}

.running-fill {
  height: 100%;
  background: #4c8dff;
  transition: none;
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

.row-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
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

.per-file {
  width: 64px;
}

.ranges-input {
  flex: 1;
  min-width: 0;
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

.row-mode {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 30px;
  font-size: 12px;
  color: var(--toolbar-fg-dim);
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

.set-row select {
  flex: 1;
  min-width: 0;
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

.actions .hint {
  margin-right: auto;
  font-size: 12px;
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
