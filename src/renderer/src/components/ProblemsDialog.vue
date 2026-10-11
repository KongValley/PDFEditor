<script setup lang="ts">
import { clearProblems, ui } from '../store/ui'

const timeOf = (at: number): string => {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function onRetry(id: string): Promise<void> {
  const entry = ui.problems.find((p) => p.id === id)
  if (!entry?.retry) return
  ui.problemsOpen = false
  await entry.retry()
}

function onCopy(entry: { title: string; detail?: string }): void {
  const text = entry.detail ? `${entry.title}\n${entry.detail}` : entry.title
  void navigator.clipboard?.writeText(text)
}
</script>

<template>
  <div v-if="ui.problemsOpen" class="dialog problems-dialog" role="dialog" aria-label="问题详情">
    <div class="dialog-title">问题详情({{ ui.problems.length }} 条)</div>
    <div v-if="ui.problems.length === 0" class="empty">暂无记录</div>
    <div class="problem-list">
      <div v-for="entry in ui.problems" :key="entry.id" class="problem-row">
        <div class="problem-head">
          <span class="time">{{ timeOf(entry.at) }}</span>
          <span class="title">{{ entry.title }}</span>
        </div>
        <pre v-if="entry.detail" class="detail">{{ entry.detail }}</pre>
        <div class="problem-actions">
          <button v-if="entry.retry" class="retry" @click="onRetry(entry.id)">重试</button>
          <button class="copy" @click="onCopy(entry)">复制</button>
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="primary" @click="ui.problemsOpen = false">关闭</button>
      <button @click="clearProblems">清空</button>
    </div>
  </div>
</template>

<style scoped>
.problems-dialog {
  max-width: 560px;
  width: 90vw;
}

.problem-list {
  max-height: 50vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0;
}

.problem-row {
  border: 1px solid var(--panel-border);
  padding: 6px 8px;
}

.problem-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.time {
  color: var(--toolbar-fg-dim);
  font-size: 12px;
}

.title {
  color: var(--toolbar-fg);
  font-size: 13px;
  word-break: break-all;
}

.detail {
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  color: var(--toolbar-fg-dim);
  max-height: 120px;
  overflow: auto;
}

.problem-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.problem-actions button {
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid var(--panel-border);
  background: var(--panel-bg);
  color: var(--toolbar-fg);
  cursor: pointer;
}

.empty {
  color: var(--toolbar-fg-dim);
  padding: 12px;
  text-align: center;
}
</style>
