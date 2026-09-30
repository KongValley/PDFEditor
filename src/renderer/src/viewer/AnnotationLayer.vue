<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { PageViewport } from 'pdfjs-dist'
import type { Annotation, ImageInfo, Point } from '@shared/types'
import AnnotationShape from './AnnotationShape.vue'
import { pdfPointToScreen, pdfRectToScreen, rectFromPoints, screenPointToPdf, simplifyPoints } from '../lib/geo'
import {
  addAnnotation,
  annotState,
  commitAnnotation,
  patchAnnotation,
  removeAnnotation,
  selectAnnotation
} from '../store/annotations'
import { setTool, showToast, ui } from '../store/ui'
import { STAMPS, TOOL_DEFAULTS, withIdentity } from '../lib/annots'

const props = defineProps<{
  pageNumber: number
  viewport: PageViewport
  size: { w: number; h: number }
}>()

const svgEl = ref<SVGSVGElement | null>(null)
const editingId = ref<string | null>(null)
const editorText = ref('')

const DRAW_TOOLS = ['rect', 'ellipse', 'ink', 'arrow', 'measure', 'text', 'note', 'stamp', 'image']

const items = computed(() => annotState.items.filter((a) => a.page === props.pageNumber - 1))
const interactive = computed(() => DRAW_TOOLS.includes(ui.tool))

interface DrawState {
  tool: string
  startScreen: { x: number; y: number }
  currentScreen: { x: number; y: number }
  inkScreen: Array<{ x: number; y: number }>
}

const draw = ref<DrawState | null>(null)

interface DragState {
  mode: 'move' | 'resize'
  handle: string
  before: Annotation
  startPdf: Point
}

const drag = ref<DragState | null>(null)

function localPoint(event: PointerEvent): { x: number; y: number } {
  const rect = svgEl.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function toPdf(point: { x: number; y: number }): Point | null {
  const vp = props.viewport
  return vp ? screenPointToPdf(vp, point.x, point.y) : null
}

function screenToPdfRect(x: number, y: number, w: number, h: number) {
  const vp = props.viewport
  if (!vp) return { x: 0, y: 0, w: 0, h: 0 }
  return rectFromPoints(screenPointToPdf(vp, x, y), screenPointToPdf(vp, x + w, y + h))
}

const defaultStyle = computed(() => TOOL_DEFAULTS[ui.tool] ?? TOOL_DEFAULTS.rect)

/* ------------------------------ 绘制 ------------------------------ */

function onLayerPointerDown(event: PointerEvent): void {
  if (!interactive.value || !props.viewport) return
  event.preventDefault()
  const local = localPoint(event)
  draw.value = { tool: ui.tool, startScreen: local, currentScreen: local, inkScreen: [local] }
  window.addEventListener('pointermove', onLayerPointerMove)
  window.addEventListener('pointerup', onLayerPointerUp)
}

function onLayerPointerMove(event: PointerEvent): void {
  const state = draw.value
  if (!state) return
  const local = localPoint(event)
  state.currentScreen = local
  if (state.tool === 'ink') {
    const last = state.inkScreen[state.inkScreen.length - 1]
    if (Math.hypot(local.x - last.x, local.y - last.y) > 2) state.inkScreen.push(local)
  }
}

async function onLayerPointerUp(event: PointerEvent): Promise<void> {
  const state = draw.value
  window.removeEventListener('pointermove', onLayerPointerMove)
  window.removeEventListener('pointerup', onLayerPointerUp)
  draw.value = null
  if (!state || !props.viewport) return
  const local = localPoint(event)
  const startPdf = toPdf(state.startScreen)
  const endPdf = toPdf(local)
  if (!startPdf || !endPdf) return

  const style = defaultStyle.value
  const moved = Math.hypot(local.x - state.startScreen.x, local.y - state.startScreen.y)
  const scale = props.viewport.scale

  if (state.tool === 'ink') {
    const pdfPoints = state.inkScreen.map((p) => toPdf(p)).filter((p): p is Point => p !== null)
    const simplified = simplifyPoints(pdfPoints, 1.5 / scale)
    if (simplified.length < 2) return
    addAnnotation(
      withIdentity({
        kind: 'ink',
        page: props.pageNumber - 1,
        bbox: rectFromPoints(simplified[0], simplified[0]),
        color: style.color,
        opacity: style.opacity,
        thickness: style.thickness,
        points: simplified
      })
    )
    setTool('select')
    return
  }

  if (moved < 3 && !['text', 'note', 'stamp', 'image'].includes(state.tool)) return

  if (state.tool === 'rect' || state.tool === 'ellipse') {
    addAnnotation(
      withIdentity({
        kind: state.tool,
        page: props.pageNumber - 1,
        bbox: rectFromPoints(startPdf, endPdf),
        color: style.color,
        opacity: style.opacity,
        thickness: style.thickness
      })
    )
    setTool('select')
    return
  }

  if (state.tool === 'arrow' || state.tool === 'measure') {
    const common = {
      page: props.pageNumber - 1,
      bbox: rectFromPoints(startPdf, endPdf),
      color: style.color,
      opacity: style.opacity,
      thickness: style.thickness,
      from: startPdf,
      to: endPdf
    }
    addAnnotation(
      withIdentity(
        state.tool === 'measure' ? { kind: 'measure', unit: 'mm', ...common } : { kind: 'arrow', ...common }
      )
    )
    setTool('select')
    return
  }

  if (state.tool === 'text' || state.tool === 'note') {
    const isText = state.tool === 'text'
    const width = isText ? 220 : 26
    const height = isText ? 40 : 26
    const bbox = { x: startPdf.x, y: startPdf.y - height, w: width, h: height }
    const common = {
      page: props.pageNumber - 1,
      bbox,
      color: style.color,
      opacity: style.opacity,
      text: ''
    }
    const ann = withIdentity(
      isText
        ? { kind: 'text', fontSize: style.fontSize, rotate: displayRotation(), ...common }
        : { kind: 'note', ...common }
    )
    addAnnotation(ann)
    setTool('select')
    selectAnnotation(ann.id)
    openEditor(ann.id)
    return
  }

  if (state.tool === 'stamp') {
    const preset = STAMPS[ui.stampKey]
    const width = 140
    const height = 44
    const bbox = { x: startPdf.x - width / 2, y: startPdf.y - height / 2, w: width, h: height }
    addAnnotation(
      withIdentity({
        kind: 'stamp',
        page: props.pageNumber - 1,
        bbox,
        color: preset.color,
        opacity: style.opacity,
        stampKey: ui.stampKey,
        label: preset.label,
        fontSize: style.fontSize,
        rotate: displayRotation()
      })
    )
    setTool('select')
    return
  }

  if (state.tool === 'image') {
    const result = (await window.pdfAPI.invoke('img:choose')) as ImageInfo | { error: string } | { canceled: true }
    if ('canceled' in result) return
    if ('error' in result) {
      showToast(result.error, 'error')
      return
    }
    annotState.imageUrls[result.imgId] = result.dataUrl
    const width = Math.min(result.width, 400)
    const height = (result.height / result.width) * width
    addAnnotation(
      withIdentity({
        kind: 'image',
        page: props.pageNumber - 1,
        bbox: { x: startPdf.x, y: startPdf.y - height, w: width, h: height },
        color: '#212529',
        opacity: 1,
        imgId: result.imgId,
        refPath: result.refPath
      })
    )
    setTool('select')
  }
}

function displayRotation(): number {
  return props.viewport ? props.viewport.rotation % 360 : 0
}

/* --------------------------- 选中/拖动/缩放 --------------------------- */

function onAnnPointerDown(ann: Annotation, event: PointerEvent): void {
  if (ui.tool !== 'select' || !props.viewport) return
  event.stopPropagation()
  event.preventDefault()
  selectAnnotation(ann.id)
  const startPdf = toPdf(localPoint(event))
  if (!startPdf) return
  drag.value = { mode: 'move', handle: '', before: JSON.parse(JSON.stringify(ann)) as Annotation, startPdf }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
}

function onHandlePointerDown(ann: Annotation, handle: string, event: PointerEvent): void {
  if (!props.viewport) return
  event.stopPropagation()
  event.preventDefault()
  const startPdf = toPdf(localPoint(event))
  if (!startPdf) return
  drag.value = { mode: 'resize', handle, before: JSON.parse(JSON.stringify(ann)) as Annotation, startPdf }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
}

function onDragMove(event: PointerEvent): void {
  const state = drag.value
  const vp = props.viewport
  if (!state || !vp) return
  const current = toPdf(localPoint(event))
  if (!current) return
  const dx = current.x - state.startPdf.x
  const dy = current.y - state.startPdf.y
  const before = state.before

  if (state.mode === 'move') {
    if (before.kind === 'ink') {
      patchAnnotation(before.id, { points: before.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) })
    } else if (before.kind === 'arrow' || before.kind === 'measure') {
      patchAnnotation(before.id, {
        from: { x: before.from.x + dx, y: before.from.y + dy },
        to: { x: before.to.x + dx, y: before.to.y + dy }
      })
    } else {
      patchAnnotation(before.id, { bbox: { ...before.bbox, x: before.bbox.x + dx, y: before.bbox.y + dy } })
    }
    return
  }

  if (before.kind === 'arrow' || before.kind === 'measure') {
    if (state.handle === 'from') patchAnnotation(before.id, { from: { x: before.from.x + dx, y: before.from.y + dy } })
    else patchAnnotation(before.id, { to: { x: before.to.x + dx, y: before.to.y + dy } })
    return
  }

  // 矩形族:在屏幕空间做把手位移,再换算回 PDF 空间(旋转无关)
  const screen = pdfRectToScreen(vp, before.bbox)
  let { x, y, w, h } = screen
  if (state.handle.includes('w')) {
    x += dx * vp.scale
    w -= dx * vp.scale
  }
  if (state.handle.includes('e')) w += dx * vp.scale
  if (state.handle.includes('n')) {
    y -= dy * vp.scale
    h += dy * vp.scale
  }
  if (state.handle.includes('s')) h -= dy * vp.scale
  w = Math.max(w, 8)
  h = Math.max(h, 8)
  patchAnnotation(before.id, { bbox: screenToPdfRect(x, y, w, h) })
}

function onDragEnd(): void {
  const state = drag.value
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  drag.value = null
  if (state) commitAnnotation(state.before)
}

/* ------------------------------ 编辑 ------------------------------ */

function openEditor(id: string): void {
  const ann = annotState.items.find((a) => a.id === id)
  if (!ann || (ann.kind !== 'text' && ann.kind !== 'note')) return
  editingId.value = id
  editorText.value = ann.text
}

function onAnnDoubleClick(ann: Annotation): void {
  if (ui.tool !== 'select') return
  if (ann.kind === 'text' || ann.kind === 'note') openEditor(ann.id)
}

function commitEditor(): void {
  const id = editingId.value
  if (!id) return
  const ann = annotState.items.find((a) => a.id === id)
  editingId.value = null
  if (!ann) return
  const text = editorText.value
  if (text.trim() === '') removeAnnotation(id)
  else updateText(id, text)
}

function updateText(id: string, text: string): void {
  const ann = annotState.items.find((a) => a.id === id)
  if (!ann || (ann.kind !== 'text' && ann.kind !== 'note')) return
  if (ann.text === text) return
  // 文本变化影响换行高度:按内容重估高度(渲染层会按宽度自动换行)
  updateAnnotationText(id, text)
}

function updateAnnotationText(id: string, text: string): void {
  const ann = annotState.items.find((a) => a.id === id)
  if (!ann || (ann.kind !== 'text' && ann.kind !== 'note')) return
  const patch: Partial<Annotation> = { text }
  if (ann.kind === 'text') {
    const lineCount = Math.max(text.split('\n').length, 1)
    const needed = ann.fontSize * 1.2 * lineCount + 6
    if (needed > ann.bbox.h) patch.bbox = { ...ann.bbox, h: needed }
  }
  patchAnnotation(id, patch)
  commitAnnotation(ann)
}

const editorStyle = computed(() => {
  const id = editingId.value
  const vp = props.viewport
  if (!id || !vp) return {}
  const ann = annotState.items.find((a) => a.id === id)
  if (!ann) return {}
  const screen = pdfRectToScreen(vp, ann.bbox)
  return {
    left: `${screen.x}px`,
    top: `${screen.y}px`,
    width: `${Math.max(screen.w, 160)}px`,
    minHeight: `${Math.max(screen.h, 60)}px`
  }
})

/* ------------------------------ 预览/选中 ------------------------------ */

const previewRect = computed(() => {
  const state = draw.value
  if (!state || !props.viewport || !['rect', 'ellipse'].includes(state.tool)) return null
  const x = Math.min(state.startScreen.x, state.currentScreen.x)
  const y = Math.min(state.startScreen.y, state.currentScreen.y)
  return { x, y, w: Math.abs(state.currentScreen.x - state.startScreen.x), h: Math.abs(state.currentScreen.y - state.startScreen.y) }
})

const previewInk = computed(() => {
  const state = draw.value
  if (!state || state.tool !== 'ink') return ''
  return state.inkScreen.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
})

const previewLine = computed(() => {
  const state = draw.value
  if (!state || !['arrow', 'measure'].includes(state.tool)) return null
  return { from: state.startScreen, to: state.currentScreen }
})

const selected = computed(() => annotState.items.find((a) => a.id === ui.selectedAnnotationId) ?? null)

const selectionBox = computed(() => {
  const ann = selected.value
  const vp = props.viewport
  if (!ann || !vp || ann.page !== props.pageNumber - 1) return null
  return pdfRectToScreen(vp, ann.bbox)
})

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

function handlePoint(handle: string): { x: number; y: number } {
  const box = selectionBox.value
  if (!box) return { x: 0, y: 0 }
  const x = handle.includes('w') ? box.x : handle.includes('e') ? box.x + box.w : box.x + box.w / 2
  const y = handle.includes('n') ? box.y : handle.includes('s') ? box.y + box.h : box.y + box.h / 2
  return { x, y }
}

const endpointHandles = computed(() => {
  const ann = selected.value
  const vp = props.viewport
  if (!ann || !vp || ann.page !== props.pageNumber - 1) return []
  if (ann.kind === 'arrow' || ann.kind === 'measure') {
    return [
      { handle: 'from', ...pdfPointToScreen(vp, ann.from) },
      { handle: 'to', ...pdfPointToScreen(vp, ann.to) }
    ]
  }
  return []
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onLayerPointerMove)
  window.removeEventListener('pointerup', onLayerPointerUp)
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
})
</script>

<template>
  <svg
    ref="svgEl"
    class="ann-layer"
    :width="size.w"
    :height="size.h"
    :style="{ pointerEvents: interactive ? 'auto' : 'none', cursor: interactive ? 'crosshair' : 'default' }"
    @pointerdown="onLayerPointerDown"
  >
    <AnnotationShape
      v-for="ann in items"
      :key="ann.id"
      :ann="ann"
      :viewport="viewport"
      :style="{ pointerEvents: ui.tool === 'select' ? 'auto' : 'none', cursor: ui.tool === 'select' ? 'move' : 'default' }"
      @pointerdown="onAnnPointerDown(ann, $event)"
      @dblclick="onAnnDoubleClick(ann)"
    />

    <template v-if="previewRect">
      <rect
        :x="previewRect.x"
        :y="previewRect.y"
        :width="previewRect.w"
        :height="previewRect.h"
        fill="none"
        :stroke="defaultStyle.color"
        :stroke-width="defaultStyle.thickness * (viewport ? viewport.scale : 1)"
        stroke-dasharray="4 3"
      />
    </template>
    <polyline v-if="previewInk" :points="previewInk" fill="none" :stroke="defaultStyle.color" :stroke-width="defaultStyle.thickness" stroke-linecap="round" />
    <line
      v-if="previewLine"
      :x1="previewLine.from.x"
      :y1="previewLine.from.y"
      :x2="previewLine.to.x"
      :y2="previewLine.to.y"
      :stroke="defaultStyle.color"
      stroke-dasharray="4 3"
    />

    <template v-if="selectionBox && ui.tool === 'select'">
      <rect
        :x="selectionBox.x - 2"
        :y="selectionBox.y - 2"
        :width="selectionBox.w + 4"
        :height="selectionBox.h + 4"
        fill="none"
        stroke="#4a8fe7"
        stroke-width="1"
        stroke-dasharray="4 3"
        class="selection-frame"
      />
      <template v-if="selected && selected.kind !== 'ink' && selected.kind !== 'arrow' && selected.kind !== 'measure'">
        <rect
          v-for="handle in HANDLES"
          :key="handle"
          :x="handlePoint(handle).x - 4"
          :y="handlePoint(handle).y - 4"
          width="8"
          height="8"
          fill="#fff"
          stroke="#4a8fe7"
          stroke-width="1"
          class="handle"
          @pointerdown="onHandlePointerDown(selected, handle, $event)"
        />
      </template>
      <template v-else-if="selected">
        <circle
          v-for="handle in endpointHandles"
          :key="handle.handle"
          :cx="handle.x"
          :cy="handle.y"
          r="5"
          fill="#fff"
          stroke="#4a8fe7"
          stroke-width="1.5"
          class="handle"
          @pointerdown="onHandlePointerDown(selected, handle.handle, $event)"
        />
      </template>
    </template>
  </svg>

  <div v-if="editingId" class="ann-editor" :style="editorStyle" @pointerdown.stop>
    <textarea
      v-model="editorText"
      class="ann-editor-input"
      :placeholder="selected && selected.kind === 'note' ? '便签内容' : '输入文字'"
      autofocus
      @keydown.ctrl.enter.prevent="commitEditor"
      @keydown.esc.prevent="commitEditor"
      @blur="commitEditor"
    ></textarea>
  </div>
</template>

<style scoped>
.ann-layer {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 4;
  overflow: visible;
}

.selection-frame {
  pointer-events: none;
}

.handle {
  cursor: pointer;
}

.ann-editor {
  position: absolute;
  z-index: 6;
  background: #fffbe6;
  border: 1px solid #d9c46a;
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  padding: 4px;
}

.ann-editor-input {
  width: 100%;
  min-height: 48px;
  resize: both;
  background: transparent;
  border: none;
  color: #212529;
  font-size: 13px;
  font-family: SimHei, 'Microsoft YaHei', sans-serif;
  outline: none;
}
</style>
