<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { parsePageRange } from '@shared/text'
import { docState, machineProfile } from '../store/document'
import { cancelOfdExport, ofdExportDialogState, type OfdDpi } from '../store/ui'
import { exportOfd } from '../lib/actions'

const value = ref('')
const dpi = ref<OfdDpi>(144)
const includeAnnotations = ref(true)
const textLayer = ref(true)
const inputEl = ref<HTMLInputElement | null>(null)

watch(
  () => ofdExportDialogState.open,
  async (open) => {
    if (!open) return
    value.value = `1-${docState.pageCount}`
    dpi.value = 144
    includeAnnotations.value = true
    textLayer.value = true
    await nextTick()
    inputEl.value?.focus()
  }
)

/** 实时解析:无效时红框 + 禁用「导出」 */
const parsed = computed(() => (value.value.trim() ? parsePageRange(value.value, docState.pageCount) : null))
const invalid = computed(() => value.value.trim().length > 0 && parsed.value === null)
const canExport = computed(() => !!parsed.value && !ofdExportDialogState.running)
const percent = computed(() =>
  ofdExportDialogState.total > 0
    ? Math.min(100, Math.round((ofdExportDialogState.done / ofdExportDialogState.total) * 100))
    : 0
)

async function confirm(): Promise<void> {
  if (!parsed.value) return
  ofdExportDialogState.running = true
  try {
    await exportOfd({
      pages: parsed.value,
      dpi: dpi.value,
      includeAnnotations: includeAnnotations.value,
      textLayer: textLayer.value
    })
  } finally {
    cancelOfdExport()
  }
}

function cancel(): void {
  if (ofdExportDialogState.running) return
  cancelOfdExport()
}
</script>

<template>
  <div v-if="ofdExportDialogState.open" class="mask">
    <div class="dialog" @keydown.esc.stop="cancel">
      <div class="title">导出 OFD</div>
      <div class="message">共 {{ docState.pageCount }} 页,输入页码范围</div>
      <input
        ref="inputEl"
        v-model="value"
        :class="{ invalid }"
        :disabled="ofdExportDialogState.running"
        placeholder="如 1-3,5,7-9"
        @keydown.enter.prevent="confirm"
      />
      <div v-if="invalid" class="range-error">页码范围无效</div>
      <div v-else-if="parsed" class="range-hint">将导出 {{ parsed.length }} 页</div>
      <div class="row">
        <span class="label">分辨率</span>
        <select v-model.number="dpi" :disabled="ofdExportDialogState.running">
          <option :value="144">144 dpi(约 2 倍)</option>
          <option :value="300">300 dpi(高清){{ machineProfile.lowMem ? '(本机将降到 144 dpi)' : '' }}</option>
        </select>
      </div>
      <label class="check-row">
        <input v-model="includeAnnotations" type="checkbox" :disabled="ofdExportDialogState.running" />
        包含批注
      </label>
      <label class="check-row">
        <input v-model="textLayer" type="checkbox" :disabled="ofdExportDialogState.running" />
        可检索文本层(不可见)
      </label>
      <div v-if="ofdExportDialogState.running" class="progress">
        {{ ofdExportDialogState.progress }}<span v-if="percent > 0">({{ percent }}%)</span>
      </div>
      <div class="hint">
        产物为图片页 OFD + 不可见文本层:版面与 PDF 一致,文字可检索/可选中;旋转文字不生成文本层
      </div>
      <div class="actions">
        <button :disabled="ofdExportDialogState.running" @click="cancel">取消</button>
        <button class="primary" :disabled="!canExport" @click="confirm">导出</button>
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
  width: 340px;
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

.message,
.hint {
  color: var(--toolbar-fg-dim);
}

.hint {
  font-size: 12px;
}

/* 实时校验:与拆分/合并对话框同一套红框语义 */
input.invalid {
  border-color: #e5534b;
}

.range-error {
  color: #ffb4b4;
  font-size: 12px;
}

.range-hint,
.progress {
  color: var(--toolbar-fg-dim);
  font-size: 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--toolbar-fg-dim);
}

.label {
  width: 48px;
  color: var(--toolbar-fg-dim);
}

select {
  flex: 1;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

button.primary {
  background: var(--accent);
  color: #fff;
}
</style>
