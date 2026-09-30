<script setup lang="ts">
import { computed } from 'vue'
import AnnotationsList from './AnnotationsList.vue'
import AnnotationProps from './AnnotationProps.vue'
import OutlinePanel from './OutlinePanel.vue'
import { annotState } from '../store/annotations'
import { ui } from '../store/ui'

const annotationCount = computed(() => annotState.items.length)
</script>

<template>
  <aside class="right-panel">
    <div class="tabs">
      <button :class="{ active: ui.sideTab === 'annotations' }" @click="ui.sideTab = 'annotations'">
        注释 ({{ annotationCount }})
      </button>
      <button :class="{ active: ui.sideTab === 'outline' }" @click="ui.sideTab = 'outline'">大纲</button>
    </div>
    <AnnotationProps v-if="ui.sideTab === 'annotations'" />
    <AnnotationsList v-if="ui.sideTab === 'annotations'" />
    <OutlinePanel v-else />
  </aside>
</template>

<style scoped>
.right-panel {
  width: 264px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg);
  border-left: 1px solid var(--panel-border);
  min-height: 0;
}

.tabs {
  display: flex;
  flex: none;
  border-bottom: 1px solid var(--panel-border);
}

.tabs button {
  flex: 1;
  border-radius: 0;
  padding: 8px 4px;
}

.outline-slot {
  overflow-y: auto;
  flex: 1;
}

.empty {
  color: var(--toolbar-fg-dim);
  padding: 16px;
  text-align: center;
}
</style>
