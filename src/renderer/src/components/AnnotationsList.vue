<script setup lang="ts">
import { computed } from 'vue'
import type { Annotation } from '@shared/types'
import { annotState, removeAnnotation, selectAnnotation } from '../store/annotations'
import { docState } from '../store/document'
import { scrollToPage } from '../store/viewer'
import { ui } from '../store/ui'
import { KIND_LABEL, annotationSummary } from '../lib/annots'

const pageItems = computed(() => annotState.items.filter((a) => a.page === docState.currentPage - 1))

function locate(ann: Annotation): void {
  selectAnnotation(ann.id)
  if (ann.page !== docState.currentPage - 1) scrollToPage(ann.page + 1)
}
</script>

<template>
  <div class="ann-list">
    <div v-if="pageItems.length === 0" class="empty">本页暂无注释</div>
    <div
      v-for="ann in pageItems"
      :key="ann.id"
      class="ann-item"
      :class="{ selected: ann.id === ui.selectedAnnotationId }"
      @click="locate(ann)"
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
