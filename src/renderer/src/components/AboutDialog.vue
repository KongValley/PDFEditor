<script setup lang="ts">
import { ref, watch } from 'vue'
import { ui } from '../store/ui'

interface NoticeEntry {
  name: string
  version: string
  license: string | null
  homepage: string | null
  text: string | null
}

const version = ref('')
const entries = ref<NoticeEntry[]>([])
const loadError = ref('')

watch(
  () => ui.aboutOpen,
  async (open) => {
    if (!open) return
    if (!version.value) {
      const info = (await window.pdfAPI.invoke('app:runtimeInfo')) as { version?: string }
      version.value = info?.version ?? ''
    }
    if (entries.value.length > 0 || loadError.value) return
    try {
      const response = await fetch('third-party-notices.json')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as { entries?: NoticeEntry[] }
      entries.value = data.entries ?? []
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : String(err)
    }
  }
)
</script>

<template>
  <div v-if="ui.aboutOpen" class="mask" @click.self="ui.aboutOpen = false">
    <div class="dialog">
      <div class="title">关于 / 开源许可</div>
      <div class="message">
        PDF 编辑器{{ version ? ` v${version}` : '' }} · 基于 Electron / Chromium(MIT / BSD);其完整声明见安装目录的
        LICENSE.electron.txt 与 LICENSES.chromium.html。
      </div>
      <div v-if="loadError" class="error">许可清单加载失败:{{ loadError }}</div>
      <div v-else-if="entries.length === 0" class="message">加载中…</div>
      <div v-else class="list">
        <details v-for="item in entries" :key="`${item.name}@${item.version}`">
          <summary>{{ item.name }}{{ item.version ? ` ${item.version}` : '' }} — {{ item.license ?? '未标注' }}</summary>
          <pre v-if="item.text">{{ item.text }}</pre>
          <div v-else class="message">未随附许可文本{{ item.homepage ? `,见 ${item.homepage}` : '' }}</div>
        </details>
      </div>
      <div class="actions">
        <button class="primary" @click="ui.aboutOpen = false">关闭</button>
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
  width: 640px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 80px);
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

.error {
  color: var(--danger);
}

.list {
  overflow: auto;
  min-height: 160px;
}

details {
  border-bottom: 1px solid var(--panel-border);
  padding: 4px 0;
}

summary {
  cursor: pointer;
}

pre {
  max-height: 220px;
  overflow: auto;
  margin: 6px 0 2px;
  padding: 8px;
  background: #1a1d25;
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  font-size: 11px;
  white-space: pre-wrap;
}

.actions {
  display: flex;
  justify-content: flex-end;
}

button.primary {
  background: var(--accent);
  color: #fff;
}
</style>
