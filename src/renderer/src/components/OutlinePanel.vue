<script setup lang="ts">
import { reactive } from 'vue'
import type { OutlineNode } from '@shared/types'
import { docState } from '../store/document'
import { scrollToPage } from '../store/viewer'

const collapsed = reactive(new Set<string>())

function toggle(node: OutlineNode, path: string): void {
  if (collapsed.has(path)) collapsed.delete(path)
  else collapsed.add(path)
}

function goTo(node: OutlineNode): void {
  if (node.page === null) return
  scrollToPage(node.page + 1)
}
</script>

<template>
  <div class="outline">
    <div v-if="docState.outline.length === 0" class="empty">本文档无大纲</div>
    <template v-else>
      <template v-for="(node, index) in docState.outline" :key="index">
        <div class="node-row" :style="{ paddingLeft: '8px' }">
          <button
            v-if="node.children.length > 0"
            class="toggle"
            @click="toggle(node, String(index))"
          >
            {{ collapsed.has(String(index)) ? '▸' : '▾' }}
          </button>
          <span v-else class="toggle placeholder"></span>
          <span
            class="title"
            :class="{ disabled: node.page === null }"
            :title="node.page === null ? '目标页面无法解析' : `跳转到第 ${node.page + 1} 页`"
            @click="goTo(node)"
          >
            {{ node.title }}
          </span>
        </div>
        <template v-if="node.children.length > 0 && !collapsed.has(String(index))">
          <div
            v-for="(child, childIndex) in node.children"
            :key="`${index}-${childIndex}`"
            class="node-row"
            :style="{ paddingLeft: '24px' }"
          >
            <span class="toggle placeholder"></span>
            <span
              class="title"
              :class="{ disabled: child.page === null }"
              :title="child.page === null ? '目标页面无法解析' : `跳转到第 ${child.page + 1} 页`"
              @click="goTo(child)"
            >
              {{ child.title }}
            </span>
          </div>
        </template>
      </template>
    </template>
  </div>
</template>

<style scoped>
.outline {
  padding: 6px;
  overflow-y: auto;
}

.empty {
  color: var(--toolbar-fg-dim);
  padding: 16px;
  text-align: center;
}

.node-row {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 4px;
  border-radius: 4px;
}

.node-row:hover {
  background: var(--toolbar-hover);
}

.toggle {
  width: 16px;
  padding: 0;
  color: var(--toolbar-fg-dim);
  flex: none;
}

.toggle.placeholder {
  display: inline-block;
}

.title {
  flex: 1;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title.disabled {
  color: var(--toolbar-fg-dim);
  cursor: default;
}
</style>
