<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Annotation } from '@shared/types'
import { annotState, pageAnnotations, removeAnnotation, selectAnnotation, toggleAnnotationSelection } from '../store/annotations'
import { docState } from '../store/document'
import { scrollToPage } from '../store/viewer'
import { ui } from '../store/ui'
import { KIND_LABEL, annotationSummary } from '../lib/annots'

const pageScope = ref<'current' | 'all'>('current')
const kindFilter = ref<'all' | Annotation['kind']>('all')

const KINDS = Object.keys(KIND_LABEL) as Annotation['kind'][]

const pageItems = computed(() => {
  const base =
    pageScope.value === 'current'
      ? pageAnnotations(docState.currentPage - 1)
      : annotState.items
  const list = kindFilter.value === 'all' ? base : base.filter((a) => a.kind === kindFilter.value)
  return pageScope.value === 'all' ? [...list].sort((a, b) => a.page - b.page) : list
})

function locate(ann: Annotation): void {
  selectAnnotation(ann.id)
  if (ann.page !== docState.currentPage - 1) scrollToPage(ann.page + 1)
}

/** 区间选择锚点:Shift+点击从锚到当前条整段选中 */
let anchorId: string | null = null

function onItemClick(ann: Annotation, event: MouseEvent): void {
  if (event.shiftKey) {
    if (anchorId !== null) {
      const from = pageItems.value.findIndex((a) => a.id === anchorId)
      const to = pageItems.value.findIndex((a) => a.id === ann.id)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        for (const item of pageItems.value.slice(lo, hi + 1)) {
          if (!ui.selectedAnnotationIds.includes(item.id)) toggleAnnotationSelection(item.id)
        }
        return
      }
    }
    toggleAnnotationSelection(ann.id)
    anchorId = ann.id
    return
  }
  locate(ann)
}

function selectAllAnnotations(): void {
  for (const ann of pageItems.value) {
    if (!ui.selectedAnnotationIds.includes(ann.id)) toggleAnnotationSelection(ann.id)
  }
}

function clearAnnotationSelection(): void {
  for (const id of [...ui.selectedAnnotationIds]) toggleAnnotationSelection(id)
  anchorId = null
}
</script>

<template>
  <div class="ann-list">
    <div class="filters">
      <select v-model="pageScope" title="页范围">
        <option value="current">当前页</option>
        <option value="all">全部页</option>
      </select>
      <select v-model="kindFilter" title="注释类型">
        <option value="all">全部类型</option>
        <option v-for="kind in KINDS" :key="kind" :value="kind">{{ KIND_LABEL[kind] }}</option>
      </select>
      <button class="sel-btn" title="选中列表中全部注释" @click="selectAllAnnotations">全选</button>
      <button class="sel-btn" title="清空注释选择" @click="clearAnnotationSelection">清空</button>
    </div>
    <div v-if="pageItems.length === 0" class="empty">
      {{ pageScope === 'current' ? '本页暂无注释' : '暂无注释' }}
    </div>
    <div
      v-for="ann in pageItems"
      :key="ann.id"
      class="ann-item"
      :class="{ selected: ui.selectedAnnotationIds.includes(ann.id) }"
      @click="onItemClick(ann, $event)"
    >
      <span class="kind">{{ KIND_LABEL[ann.kind] }}</span>
      <span class="summary">{{ annotationSummary(ann) }}</span>
      <span class="page-tag">P{{ ann.page + 1 }}</span>
      <button class="del" title="删除" @click.stop="removeAnnotation(ann.id)">×</button>
    </div>
    <div class="total">共 {{ annotState.items.length }} 条注释</div>
  </div>
</template>

<style scoped>
.ann-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  overflow-y: auto;
}

.filters {
  display: flex;
  gap: 6px;
  padding-bottom: 4px;
}

.filters select {
  flex: 1;
  min-width: 0;
}

.filters .sel-btn {
  flex: none;
  padding: 2px 6px;
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

.ann-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid transparent;
}

.ann-item:hover {
  background: var(--toolbar-hover);
}

.ann-item.selected {
  border-color: var(--accent);
  background: var(--toolbar-hover);
}

.kind {
  flex: none;
  color: var(--accent);
}

.summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--toolbar-fg);
}

.page-tag {
  flex: none;
  color: var(--toolbar-fg-dim);
  font-size: 11px;
}

.del {
  flex: none;
  padding: 0 4px;
  color: var(--toolbar-fg-dim);
}

.del:hover {
  color: var(--danger);
}

.total {
  padding: 8px;
  color: var(--toolbar-fg-dim);
  font-size: 11px;
  text-align: right;
}
</style>
