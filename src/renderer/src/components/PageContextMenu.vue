<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ui } from '../store/ui'
import { deletePages, exportPageImage, extractPages, insertBlankPage, rotatePages } from '../lib/actions'

const menuEl = ref<HTMLElement | null>(null)

function close(): void {
  ui.pageMenu.open = false
}

/** 取当前菜单页(1-based)并关闭菜单,再执行动作 */
function act(fn: (page: number) => void): void {
  const page = ui.pageMenu.page
  close()
  fn(page)
}

/** 点菜单外部关闭(捕获阶段;菜单本身在 menuEl 内) */
function onOutsidePointer(event: PointerEvent): void {
  if (!menuEl.value?.contains(event.target as Node)) close()
}

function onScroll(): void {
  close()
}

onMounted(() => {
  window.addEventListener('pointerdown', onOutsidePointer, true)
  // 滚动事件不冒泡,但捕获阶段会到达 window:任何容器滚动都关闭菜单
  window.addEventListener('scroll', onScroll, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onOutsidePointer, true)
  window.removeEventListener('scroll', onScroll, true)
})
</script>

<template>
  <div
    v-if="ui.pageMenu.open"
    ref="menuEl"
    class="page-menu"
    role="menu"
    :style="{ left: ui.pageMenu.x + 'px', top: ui.pageMenu.y + 'px' }"
    @keydown.esc.stop="close"
  >
    <div class="page-menu-title">第 {{ ui.pageMenu.page }} 页</div>
    <button role="menuitem" @click="act((p) => void rotatePages([p - 1], -90))">左旋 90°</button>
    <button role="menuitem" @click="act((p) => void rotatePages([p - 1], 90))">右旋 90°</button>
    <button role="menuitem" @click="act((p) => void insertBlankPage(p - 1))">在当前页之后插入空白页</button>
    <button role="menuitem" @click="act((p) => void deletePages([p - 1]))">删除该页</button>
    <button role="menuitem" @click="act((p) => void extractPages([p - 1], true))">提取该页为新 PDF</button>
    <button role="menuitem" @click="act((p) => void exportPageImage(p))">导出该页为 PNG</button>
  </div>
</template>

<style scoped>
.page-menu {
  position: fixed;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 168px;
  padding: 4px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  z-index: 60; /* 高于主视图(≤6),低于拖放遮罩(100)/对话框(300) */
}

.page-menu-title {
  padding: 3px 8px;
  font-size: 12px;
  color: var(--toolbar-fg-dim);
  border-bottom: 1px solid var(--panel-border);
  margin-bottom: 2px;
}

.page-menu button {
  padding: 4px 8px;
  font-size: 12px;
  text-align: left;
  border-radius: 4px;
}
</style>
