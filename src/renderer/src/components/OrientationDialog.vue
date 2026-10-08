<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { applyOrientationFix } from '../lib/actions'
import { reasonText, type OrientationPlanItem } from '../lib/orientation'
import { cancelOrientationPlan, orientationDialogState } from '../store/ui'

const dialogEl = ref<HTMLElement | null>(null)
const firstCheckbox = ref<HTMLInputElement | null>(null)

const ORIENTATION_TEXT = { portrait: '纵向', landscape: '横向', square: '方形' } as const
const DELTA_OPTIONS = [
  { value: 0, label: '不转' },
  { value: 90, label: '顺时针 90°' },
  { value: 180, label: '180°' },
  { value: 270, label: '逆时针 90°' }
] as const

/** 勾选与旋转角是用户可编辑的副本:直接改 store 里的计划会让"应用"无从判断改了什么 */
const rows = ref<Array<{ item: OrientationPlanItem; selected: boolean }>>([])

watch(
  () => orientationDialogState.open,
  async (open) => {
    if (!open) return
    rows.value = orientationDialogState.items.map((item) => ({ item, selected: item.delta !== 0 }))
    await nextTick()
    firstCheckbox.value?.focus()
  }
)

const willRotate = computed(() => rows.value.filter((row) => row.selected && row.item.delta !== 0).length)

function selectAll(): void {
  for (const row of rows.value) row.selected = true
}

function selectNone(): void {
  for (const row of rows.value) row.selected = false
}

function apply(): void {
  void applyOrientationFix(rows.value.filter((row) => row.selected).map((row) => row.item))
}
</script>

<template>
  <div v-if="orientationDialogState.open" class="mask">
    <div ref="dialogEl" class="dialog" @keydown.esc="cancelOrientationPlan">
      <div class="title">统一页面方向</div>

      <div v-if="orientationDialogState.scanning" class="message">正在分析页面方向…</div>

      <div v-else-if="orientationDialogState.baseError" class="message error">{{ orientationDialogState.baseError }}</div>

      <template v-else>
        <div class="message">
          以{{ ORIENTATION_TEXT[orientationDialogState.base] }}页为基准,以下 {{ rows.length }} 页方向不同。
          已自动判断内容是否真的横躺,可逐页调整后再应用。
        </div>
        <div class="list">
          <label v-for="(row, index) in rows" :key="row.item.page" class="row">
            <input
              :ref="index === 0 ? (firstCheckbox as any) : undefined"
              v-model="row.selected"
              type="checkbox"
              class="check"
            />
            <span class="page-no">第 {{ row.item.page }} 页</span>
            <span class="from">{{ ORIENTATION_TEXT[row.item.from] }}</span>
            <span class="reason">{{ reasonText(row.item.reason) }}</span>
            <select v-model.number="row.item.delta" class="delta">
              <option v-for="option in DELTA_OPTIONS" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>
        <div class="message">将调整 {{ willRotate }} 页;改动可用 Ctrl+Z 撤销。</div>
      </template>

      <div class="actions">
        <template v-if="!orientationDialogState.scanning && !orientationDialogState.baseError && rows.length > 0">
          <button class="hint-btn" @click="selectAll">全选</button>
          <button class="hint-btn" @click="selectNone">全部不转</button>
        </template>
        <span class="spacer"></span>
        <button @click="cancelOrientationPlan">关闭</button>
        <button
          v-if="!orientationDialogState.scanning && !orientationDialogState.baseError"
          class="primary"
          :disabled="willRotate === 0"
          @click="apply"
        >
          应用
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
  width: 560px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow: auto;
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

.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 50vh;
  overflow: auto;
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  padding: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.check {
  flex: none;
}

.page-no {
  width: 64px;
  flex: none;
}

.from {
  width: 40px;
  flex: none;
  color: var(--toolbar-fg-dim);
}

.reason {
  flex: 1;
  color: var(--toolbar-fg-dim);
}

.delta {
  width: 130px;
  flex: none;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spacer {
  flex: 1;
}

.hint-btn {
  background: transparent;
  border: none;
  color: var(--toolbar-fg-dim);
  cursor: pointer;
}

button.primary {
  background: var(--accent);
}
</style>