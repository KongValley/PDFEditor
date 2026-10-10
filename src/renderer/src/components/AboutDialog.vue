<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RuntimeInfo } from '@shared/types'
import { machineProfile } from '../store/document'
import { ui } from '../store/ui'

interface NoticeEntry {
  name: string
  version: string
  license: string | null
  homepage: string | null
  text: string | null
}

const runtimeInfo = ref<RuntimeInfo | null>(null)
const entries = ref<NoticeEntry[]>([])
const loadError = ref('')
const actionError = ref('')

const version = computed(() => runtimeInfo.value?.version ?? '')

/** 当前生效的日志等级(来自主进程,变更后回写本地,便于重开对话框显示一致) */
const logLevel = computed<'debug' | 'info' | 'off'>(() => {
  const level = runtimeInfo.value?.logLevel
  return level === 'debug' || level === 'off' ? level : 'info'
})

async function onLogLevelChange(event: Event): Promise<void> {
  const level = (event.target as HTMLSelectElement).value
  await window.pdfAPI.invoke('log:setLevel', level)
  if (runtimeInfo.value) runtimeInfo.value.logLevel = level as RuntimeInfo['logLevel']
}

async function openLogDir(): Promise<void> {
  actionError.value = ''
  const result = (await window.pdfAPI.invoke('app:openLogDir')) as { ok: boolean }
  if (!result.ok) actionError.value = '日志目录不存在或无法打开(还没有产生日志)'
}

/** 环境自检:内网 IT 遇到"字体不对 / 打不开 / 很卡"时的第一手材料(只读,不采集任何用户数据) */
const envRows = computed<Array<[string, string]>>(() => {
  const info = runtimeInfo.value
  if (!info) return []
  const show = (value: string | number | null | undefined): string => {
    const text = value === null || value === undefined ? '' : String(value)
    return text.trim() === '' ? '—' : text
  }
  return [
    ['操作系统', show(info.osRelease)],
    ['架构', show(info.osArch === info.arch ? info.arch : `${info.arch} / ${info.osArch}`)],
    ['运行时', `Electron ${show(info.electron)} · Chromium ${show(info.chrome)}`],
    [
      '内存',
      `${show(machineProfile.totalMemMB)} MB${machineProfile.lowMem ? ' · 省内存档' : ''}`
    ],
    ['渲染模式', info.gpuDisabled ? '软件渲染(未启用 GPU 加速)' : '硬件加速已开启'],
    [
      '中文字体',
      info.cjkFontFile ? (info.cjkFontFile.split(/[\\/]/).pop() as string) : '未找到 —— 文字批注/图章将无法保存'
    ],
    ['用户数据目录', info.userDataWritable ? '可写' : '不可写'],
    ['运行日志', info.logDir || '未启用']
  ]
})

watch(
  () => ui.aboutOpen,
  async (open) => {
    if (!open) return
    if (!runtimeInfo.value) {
      runtimeInfo.value = (await window.pdfAPI.invoke('app:runtimeInfo')) as RuntimeInfo
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
      <div class="env-check">
        <div class="env-title">环境自检</div>
        <div v-for="row in envRows" :key="row[0]" class="env-row">
          <span class="env-label">{{ row[0] }}</span>
          <span class="env-value">{{ row[1] }}</span>
        </div>
      </div>
      <div class="log-row">
        <span class="log-label">运行日志等级</span>
        <select :value="logLevel" title="运行日志等级" @change="onLogLevelChange">
          <option value="info">信息(默认)</option>
          <option value="debug">调试(详细)</option>
          <option value="off">关闭</option>
        </select>
        <button :disabled="!runtimeInfo" @click="openLogDir">打开日志文件夹</button>
        <span v-if="actionError" class="error">{{ actionError }}</span>
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

.env-check {
  padding: 8px 10px;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  background: #1a1d25;
  font-size: 12px;
}

.env-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.env-row {
  display: flex;
  gap: 10px;
  line-height: 1.7;
}

.env-label {
  width: 90px;
  flex: none;
  color: var(--toolbar-fg-dim);
}

.env-value {
  word-break: break-all;
}

.error {
  color: var(--danger);
}

.log-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.log-label {
  color: var(--toolbar-fg-dim);
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
