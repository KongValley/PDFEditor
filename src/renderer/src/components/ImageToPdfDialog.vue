<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { convertImagesToPdf, pickImageFiles } from '../lib/actions'
import { cancelImagePdf, imagePdfDialogState } from '../store/ui'

const dialogEl = ref<HTMLElement | null>(null)

const canStart = computed(
  () => imagePdfDialogState.items.length > 0 && !imagePdfDialogState.running && !imagePdfDialogState.result
)
const percent = computed(() =>
  imagePdfDialogState.total > 0
    ? Math.min(100, Math.round((imagePdfDialogState.done / imagePdfDialogState.total) * 100))
    : 0
)

watch(
  () => imagePdfDialogState.open,
  async (open) => {
    if (!open) return
    await nextTick()
    dialogEl.value?.querySelector<HTMLElement>('button')?.focus()
  }
)

/** 「+ 添加图片」:主进程多选对话框;新选的追加到列表末尾 */
async function addImages(): Promise<void> {
  const picked = await pickImageFiles()
  if (picked.length === 0) return
  imagePdfDialogState.items = [...imagePdfDialogState.items, ...picked]
}

function removeAt(index: number): void {
  imagePdfDialogState.items = imagePdfDialogState.items.filter((_, i) => i !== index)
}

function start(): void {
  void convertImagesToPdf(imagePdfDialogState.items)
}
</script>

<template>
  <div v-if="imagePdfDialogState.open" class="mask">
    <div ref="dialogEl" class="dialog" @keydown.esc="cancelImagePdf">
      <div class="title">图片转 PDF</div>

      <!-- 转换中:进度条 -->
      <template v-if="imagePdfDialogState.running">
        <div class="running-text">
          已转换 {{ imagePdfDialogState.done }} / {{ imagePdfDialogState.total }}
          <span v-if="imagePdfDialogState.current" class="current">{{ imagePdfDialogState.current }}</span>
        </div>
        <div class="running-bar">
          <div class="running-fill" :style="{ width: `${percent}%` }"></div>
        </div>
      </template>

      <!-- 完成:结果摘要 -->
      <template v-else-if="imagePdfDialogState.result">
        <div v-if="imagePdfDialogState.result.ok" class="message">
          已生成 {{ imagePdfDialogState.result.pages }} 页 PDF
          <span v-if="imagePdfDialogState.result.savedPath" class="path">{{ imagePdfDialogState.result.savedPath }}</span>
        </div>
        <div v-else class="message error">{{ imagePdfDialogState.result.error ?? '转换失败' }}</div>
        <div v-if="imagePdfDialogState.result.failed" class="message error">
          有 {{ imagePdfDialogState.result.failed }} 张图片未能转换(见控制台)
        </div>
      </template>

      <!-- 待开始:文件列表 + 页尺寸 -->
      <template v-else>
        <div class="message">把 PNG / JPEG 图片合并成一份 PDF,每张图一页。</div>
        <div class="list">
          <div v-if="imagePdfDialogState.items.length === 0" class="empty">尚未添加图片</div>
          <div v-for="(item, index) in imagePdfDialogState.items" :key="item.path" class="row">
            <span class="name" :title="item.path">{{ item.name }}</span>
            <span class="size">{{ item.width }}×{{ item.height }}</span>
            <button class="remove" :disabled="imagePdfDialogState.running" title="移除该图片" @click="removeAt(index)">
              ×
            </button>
          </div>
        </div>
        <div class="set-row">
          <span class="label">页面尺寸</span>
          <select v-model="imagePdfDialogState.pageMode" class="mode">
            <option value="image">按图像尺寸(无留白,按 96 DPI 换算)</option>
            <option value="a4">A4(方向随图像,四周留白)</option>
          </select>
        </div>
      </template>

      <div class="actions">
        <button v-if="!imagePdfDialogState.running && !imagePdfDialogState.result" @click="addImages">+ 添加图片</button>
        <span class="spacer"></span>
        <button v-if="!imagePdfDialogState.running && !imagePdfDialogState.result" @click="cancelImagePdf">
          取消
        </button>
        <button
          v-if="imagePdfDialogState.result"
          class="primary"
          @click="cancelImagePdf"
        >
          完成
        </button>
        <button v-else-if="!imagePdfDialogState.running" class="primary" :disabled="!canStart" @click="start">
          {{ imagePdfDialogState.running ? '转换中…' : '开始转换' }}
        </button>
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
  background: rgba(0, 0, 0, 0.45);
  z-index: 40;
}

.dialog {
  width: 520px;
  max-width: calc(100vw - 32px);
  padding: 16px;
  border-radius: 6px;
  background: var(--panel-bg);
  color: var(--fg);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.title {
  font-weight: 600;
}

.message {
  color: var(--toolbar-fg-dim);
  font-size: 13px;
}

.message.error {
  color: #ffb4b4;
}

.message .path {
  display: block;
  margin-top: 4px;
  color: var(--toolbar-fg-dim);
  font-size: 12px;
  word-break: break-all;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 40vh;
  overflow: auto;
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  padding: 6px;
}

.list .empty {
  color: var(--toolbar-fg-dim);
  font-size: 12px;
  padding: 8px;
  text-align: center;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.size {
  flex: none;
  color: var(--toolbar-fg-dim);
  font-size: 12px;
}

.remove {
  flex: none;
  padding: 0 6px;
  border: 1px solid var(--panel-border);
  border-radius: 3px;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}

.set-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.label {
  flex: none;
  color: var(--toolbar-fg-dim);
}

.mode {
  flex: 1;
}

.running-text {
  margin: 8px 0;
  font-size: 13px;
}

.running-text .current {
  margin-left: 8px;
  color: var(--toolbar-fg-dim);
  font-size: 12px;
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
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spacer {
  flex: 1;
}

button.primary {
  background: var(--accent);
}
</style>