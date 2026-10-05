<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { docState } from '../store/document'
import { zoomAt, zoomBy } from '../store/viewer'

const ZOOM_PRESETS = [25, 50, 75, 100, 125, 150, 200, 300]

const boxEl = ref<HTMLElement | null>(null)
const menuOpen = ref(false)
const zoomPercent = computed(() => Math.round(docState.scale * 100))

function onFocus(event: FocusEvent): void {
  ;(event.target as HTMLInputElement).select()
}

/** 输入 25–400 后回车/失焦生效;非法或 ≤0 回显当前值(zoomAt 自带 clamp) */
function onCommit(event: Event): void {
  const el = event.target as HTMLInputElement
  const value = Number(el.value.replace('%', '').trim())
  if (Number.isFinite(value) && value > 0) zoomAt(value / 100)
  el.value = `${Math.round(docState.scale * 100)}%`
}

function pickPreset(preset: number): void {
  menuOpen.value = false
  zoomAt(preset / 100)
}

/** 点菜单外部关闭(捕获阶段,菜单元素都在 boxEl 内) */
function onOutsidePointer(event: PointerEvent): void {
  if (!boxEl.value?.contains(event.target as Node)) menuOpen.value = false
}

watch(menuOpen, (open) => {
  if (open) window.addEventListener('pointerdown', onOutsidePointer, true)
  else window.removeEventListener('pointerdown', onOutsidePointer, true)
})

onBeforeUnmount(() => window.removeEventListener('pointerdown', onOutsidePointer, true))
</script>

<template>
  <span ref="boxEl" class="zoom-box" @keydown.esc.stop="menuOpen = false">
    <button title="缩小 (Ctrl+-)" @click="zoomBy(1 / 1.1)">−</button>
    <input
      class="zoom-input"
      type="text"
      :value="zoomPercent + '%'"
      title="缩放比例:输入 25–400 后回车"
      @focus="onFocus"
      @keydown.enter="onCommit"
      @blur="onCommit"
    />
    <button
      class="zoom-menu-btn"
      title="常用缩放比例"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      @click="menuOpen = !menuOpen"
    >
      ▾
    </button>
    <button title="放大 (Ctrl+=)" @click="zoomBy(1.1)">+</button>
    <div v-if="menuOpen" class="zoom-menu" role="menu">
      <button
        v-for="preset in ZOOM_PRESETS"
        :key="preset"
        role="menuitem"
        :class="{ active: preset === zoomPercent }"
        @click="pickPreset(preset)"
      >
        {{ preset }}%
      </button>
    </div>
  </span>
</template>

<style scoped>
.zoom-box {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.zoom-input {
  width: 56px;
  padding: 2px 4px;
  text-align: center;
  font-size: 12px;
}

.zoom-menu-btn {
  padding: 2px 4px;
  font-size: 12px;
}

.zoom-menu {
  position: absolute;
  bottom: calc(100% + 6px); /* 状态栏在窗口底部,菜单必须向上弹 */
  right: 0; /* 右对齐输入框组右缘,窄窗口不越界 */
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 88px;
  padding: 4px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  z-index: 50; /* 高于主视图(≤6),低于拖放遮罩(100)/对话框(300) */
}

.zoom-menu button {
  padding: 3px 8px;
  font-size: 12px;
  text-align: left;
  border-radius: 4px;
}
</style>
