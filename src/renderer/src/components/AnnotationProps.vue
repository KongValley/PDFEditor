<script setup lang="ts">
import { computed } from 'vue'
import type { Annotation } from '@shared/types'
import {
  annotationsZOrder,
  commitAnnotations,
  patchAnnotation,
  removeAnnotation,
  selectAnnotation,
  selectedAnnotation,
  bringToFront,
  moveDown,
  moveUp,
  sendToBack,
  updateAnnotation
} from '../store/annotations'
import { KIND_LABEL, PALETTE, STAMPS, textPatch } from '../lib/annots'

const ann = computed(() => selectedAnnotation())

/** 层级按钮可用性(按同页邻居判定) */
const zorder = computed(() => {
  const current = ann.value
  return current
    ? annotationsZOrder(current.id)
    : { canUp: false, canDown: false, canFront: false, canBack: false }
})

const thickness = computed(() => {
  const a = ann.value
  if (!a) return 0
  return a.kind === 'rect' || a.kind === 'ellipse' || a.kind === 'ink' || a.kind === 'arrow' || a.kind === 'measure'
    ? a.thickness
    : 0
})

const fontSize = computed(() => {
  const a = ann.value
  if (!a) return 0
  return a.kind === 'text' || a.kind === 'stamp' ? a.fontSize : 0
})

const text = computed(() => {
  const a = ann.value
  if (!a) return ''
  return a.kind === 'text' || a.kind === 'note' ? a.text : ''
})

function patch(partial: Partial<Annotation>): void {
  const current = ann.value
  if (!current) return
  updateAnnotation(current.id, partial)
}

/** 连续输入(滑块/文本框)实时改模型但不写历史,change 时合并为一条命令 */
let liveBefore: Annotation | null = null

function patchLive(partial: Partial<Annotation>): void {
  const current = ann.value
  if (!current) return
  if (!liveBefore) liveBefore = JSON.parse(JSON.stringify(current)) as Annotation
  patchAnnotation(current.id, partial)
}

function commitLive(): void {
  if (!liveBefore) return
  const before = liveBefore
  liveBefore = null
  commitAnnotations([before])
}

function onOpacity(event: Event): void {
  patchLive({ opacity: Number((event.target as HTMLInputElement).value) })
}

function onThickness(event: Event): void {
  patchLive({ thickness: Number((event.target as HTMLInputElement).value) } as Partial<Annotation>)
}

function onFontSize(event: Event): void {
  patchLive({ fontSize: Number((event.target as HTMLInputElement).value) } as Partial<Annotation>)
}

function onText(event: Event): void {
  const current = ann.value
  if (!current) return
  patchLive(textPatch(current, (event.target as HTMLTextAreaElement).value))
}
</script>

<template>
  <div v-if="ann" class="props">
    <div class="row title">
      <span>{{ KIND_LABEL[ann.kind] }}</span>
      <button class="close" title="取消选中" @click="selectAnnotation(null)">×</button>
    </div>

    <div class="row">
      <span class="label">颜色</span>
      <div class="swatches">
        <button
          v-for="color in PALETTE"
          :key="color"
          class="swatch"
          :class="{ active: color.toLowerCase() === ann.color.toLowerCase() }"
          :style="{ background: color }"
          @click="patch({ color })"
        ></button>
      </div>
    </div>

    <div class="row">
      <span class="label">透明度</span>
      <input type="range" min="0.1" max="1" step="0.05" :value="ann.opacity" @input="onOpacity" @change="commitLive" />
      <span class="value">{{ Math.round(ann.opacity * 100) }}%</span>
    </div>

    <div v-if="thickness > 0" class="row">
      <span class="label">线宽</span>
      <input type="range" min="0.5" max="12" step="0.5" :value="thickness" @input="onThickness" @change="commitLive" />
      <span class="value">{{ thickness }}</span>
    </div>

    <div v-if="fontSize > 0" class="row">
      <span class="label">字号</span>
      <input type="range" min="8" max="72" step="1" :value="fontSize" @input="onFontSize" @change="commitLive" />
      <span class="value">{{ fontSize }}</span>
    </div>

    <div v-if="text || ann.kind === 'text' || ann.kind === 'note'" class="row column">
      <span class="label">内容</span>
      <textarea :value="text" rows="4" @input="onText" @change="commitLive"></textarea>
    </div>

    <div v-if="ann.kind === 'stamp'" class="row">
      <span class="label">图章</span>
      <span class="value wide">{{ STAMPS[ann.stampKey].label }}</span>
    </div>

    <div class="row">
      <span class="label">层级</span>
      <button :disabled="!zorder.canBack" title="移到最底层" @click="sendToBack(ann.id)">置底</button>
      <button :disabled="!zorder.canDown" title="下移一层" @click="moveDown(ann.id)">下移</button>
      <button :disabled="!zorder.canUp" title="上移一层" @click="moveUp(ann.id)">上移</button>
      <button :disabled="!zorder.canFront" title="移到最顶层" @click="bringToFront(ann.id)">置顶</button>
    </div>

    <div class="row">
      <span class="label">锁定</span>
      <button :class="{ active: ann.locked }" @click="patch({ locked: !ann.locked })">
        {{ ann.locked ? '解锁' : '锁定' }}
      </button>
      <span class="value">{{ ann.locked ? '画布上不可拖动' : '可自由拖动' }}</span>
    </div>

    <div class="row">
      <button class="danger" @click="removeAnnotation(ann.id)">删除注释</button>
    </div>
  </div>
</template>

<style scoped>
.props {
  border-bottom: 1px solid var(--panel-border);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row.column {
  flex-direction: column;
  align-items: stretch;
}

.title {
  justify-content: space-between;
  font-weight: 600;
}

.label {
  flex: none;
  width: 48px;
  color: var(--toolbar-fg-dim);
}

.value {
  flex: none;
  min-width: 34px;
  text-align: right;
  color: var(--toolbar-fg-dim);
}

.value.wide {
  text-align: left;
}

.swatches {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.swatch {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  border: 1px solid rgba(0, 0, 0, 0.4);
  padding: 0;
}

.swatch.active {
  outline: 2px solid var(--accent);
}

input[type='range'] {
  flex: 1;
}

textarea {
  width: 100%;
  resize: vertical;
}

button.danger {
  color: #ffb4b4;
  border: 1px solid #7a2f2f;
}
</style>
