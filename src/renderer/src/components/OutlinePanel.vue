<script setup lang="ts">
import { nextTick, reactive, ref } from 'vue'
import type { OutlineNode } from '@shared/types'
import { docState } from '../store/document'
import { scrollToPage } from '../store/viewer'
import { applyOutlineEdit } from '../lib/actions'
import { ui } from '../store/ui'

const collapsed = reactive(new Set<string>())

/** 行内编辑状态(Electron 不支持 window.prompt,新增/重命名都走输入框) */
const editingPath = ref<number[] | null>(null)
const editingValue = ref('')
const addingParent = ref<number[] | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

function toggle(node: OutlineNode, path: string): void {
  if (collapsed.has(path)) collapsed.delete(path)
  else collapsed.add(path)
}

/**
 * 聚焦行内输入框。inputEl 出现在 v-for 内部:同名 ref 会被 Vue 收集成数组,
 * 直接 inputEl.value?.focus() 会抛 "focus is not a function"(实测)并静默失去焦点。
 */
function focusEditInput(): void {
  const raw = inputEl.value as unknown as HTMLInputElement | HTMLInputElement[] | null
  const target = Array.isArray(raw) ? raw[0] : raw
  target?.focus()
  target?.select()
}

function goTo(node: OutlineNode): void {
  if (node.page === null) return
  scrollToPage(node.page + 1)
}

const busy = () => ui.busy !== null

async function startRename(node: OutlineNode): Promise<void> {
  editingPath.value = node.path
  editingValue.value = node.title
  await nextTick()
  focusEditInput()
}

function startAddChild(parent: OutlineNode): void {
  addingParent.value = parent.path
  editingValue.value = `第 ${docState.currentPage} 页`
  void nextTick().then(() => focusEditInput())
}

function startAddTop(): void {
  addingParent.value = []
  editingValue.value = `第 ${docState.currentPage} 页`
  void nextTick().then(() => focusEditInput())
}

function cancelEditing(): void {
  editingPath.value = null
  addingParent.value = null
}

async function commitRename(): Promise<void> {
  const path = editingPath.value
  const title = editingValue.value.trim()
  editingPath.value = null
  if (!path || title === '') return
  await applyOutlineEdit({ kind: 'rename', path, title })
}

async function commitAdd(): Promise<void> {
  const parentPath = addingParent.value
  const title = editingValue.value.trim()
  addingParent.value = null
  if (!parentPath || title === '') return
  await applyOutlineEdit({ kind: 'add', parentPath, page: docState.currentPage - 1, title })
}

async function removeNode(node: OutlineNode): Promise<void> {
  if (!window.confirm(`删除书签「${node.title}」?其子书签会一并移除。`)) return
  await applyOutlineEdit({ kind: 'remove', path: node.path })
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelEditing()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (editingPath.value !== null) void commitRename()
    else void commitAdd()
  }
}
</script>

<template>
  <div class="outline">
    <div class="outline-toolbar">
      <button class="add-top" title="为当前页添加书签" :disabled="busy()" @click="startAddTop">+ 书签</button>
    </div>
    <div v-if="docState.outline.length === 0 && addingParent === null" class="empty">本文档无大纲</div>
    <template v-if="addingParent !== null && addingParent.length === 0">
      <div class="node-row">
        <span class="toggle placeholder"></span>
        <input
          ref="inputEl"
          v-model="editingValue"
          class="edit-input"
          @keydown="onInputKeydown"
          @blur="commitAdd"
        />
      </div>
    </template>
    <template v-for="(node, index) in docState.outline" :key="index">
      <div class="node-row">
        <button
          v-if="node.children.length > 0"
          class="toggle"
          @click="toggle(node, String(index))"
        >
          {{ collapsed.has(String(index)) ? '▸' : '▾' }}
        </button>
        <span v-else class="toggle placeholder"></span>
        <template v-if="editingPath !== null && editingPath.join() === node.path.join()">
          <input
            ref="inputEl"
            v-model="editingValue"
            class="edit-input"
            @keydown="onInputKeydown"
            @blur="commitRename"
          />
        </template>
        <template v-else>
          <span
            class="title"
            :class="{ disabled: node.page === null }"
            :title="node.page === null ? '目标页面无法解析' : `跳转到第 ${node.page + 1} 页`"
            @click="goTo(node)"
          >
            {{ node.title }}
          </span>
          <span class="row-actions">
            <button class="mini" title="添加子书签(指向当前页)" :disabled="busy()" @click.stop="startAddChild(node)">+</button>
            <button class="mini" title="重命名" :disabled="busy()" @click.stop="startRename(node)">改</button>
            <button class="mini" title="删除(含子书签)" :disabled="busy()" @click.stop="removeNode(node)">删</button>
          </span>
        </template>
      </div>
      <div v-if="addingParent !== null && addingParent.join() === node.path.join()" class="node-row child">
        <span class="toggle placeholder"></span>
        <input
          ref="inputEl"
          v-model="editingValue"
          class="edit-input"
          @keydown="onInputKeydown"
          @blur="commitAdd"
        />
      </div>
      <template v-if="node.children.length > 0 && !collapsed.has(String(index))">
        <template v-for="(child, childIndex) in node.children" :key="`${index}-${childIndex}`">
          <div class="node-row child">
            <span class="toggle placeholder"></span>
            <template v-if="editingPath !== null && editingPath.join() === child.path.join()">
              <input
                ref="inputEl"
                v-model="editingValue"
                class="edit-input"
                @keydown="onInputKeydown"
                @blur="commitRename"
              />
            </template>
            <template v-else>
              <span
                class="title"
                :class="{ disabled: child.page === null }"
                :title="child.page === null ? '目标页面无法解析' : `跳转到第 ${child.page + 1} 页`"
                @click="goTo(child)"
              >
                {{ child.title }}
              </span>
              <span class="row-actions">
                <button class="mini" title="添加子书签(指向当前页)" :disabled="busy()" @click.stop="startAddChild(child)">+</button>
                <button class="mini" title="重命名" :disabled="busy()" @click.stop="startRename(child)">改</button>
                <button class="mini" title="删除(含子书签)" :disabled="busy()" @click.stop="removeNode(child)">删</button>
              </span>
            </template>
          </div>
          <div v-if="addingParent !== null && addingParent.join() === child.path.join()" class="node-row child">
            <span class="toggle placeholder"></span>
            <input
              ref="inputEl"
              v-model="editingValue"
              class="edit-input"
              @keydown="onInputKeydown"
              @blur="commitAdd"
            />
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

.outline-toolbar {
  display: flex;
  padding-bottom: 4px;
}

.add-top {
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid var(--panel-border);
  background: var(--panel-bg);
  color: var(--toolbar-fg);
  cursor: pointer;
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

.node-row.child {
  padding-left: 20px;
}

.node-row:hover {
  background: var(--toolbar-hover);
}

.row-actions {
  display: none;
  gap: 2px;
  flex: none;
}

.node-row:hover .row-actions {
  display: inline-flex;
}

.mini {
  padding: 0 4px;
  font-size: 11px;
  border: 1px solid var(--panel-border);
  background: var(--panel-bg);
  color: var(--toolbar-fg-dim);
  cursor: pointer;
}

.mini:hover {
  color: var(--toolbar-fg);
}

.edit-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--toolbar-fg);
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
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
