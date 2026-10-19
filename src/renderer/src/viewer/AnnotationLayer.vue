<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { PageViewport } from 'pdfjs-dist'
import type { Annotation, ImageInfo, Point } from '@shared/types'
import AnnotationShape from './AnnotationShape.vue'
import { pdfPointToScreen, pdfRectToScreen, rectFromPoints, screenPointToPdf, simplifyPoints } from '../lib/geo'
import {
  addAnnotation,
  annotState,
  commitAnnotation,
  commitAnnotations,
  pageAnnotations,
  patchAnnotation,
  removeAnnotation,
  selectAnnotation,
  toggleAnnotationSelection
} from '../store/annotations'
import { registerEditorCommit, setTool, showToast, ui } from '../store/ui'
import { STAMPS, TOOL_DEFAULTS, textPatch, withIdentity } from '../lib/annots'

const props = defineProps<{
  pageNumber: number
  viewport: PageViewport
  size: { w: number; h: number }
}>()

const svgEl = ref<SVGSVGElement | null>(null)
const editingId = ref<string | null>(null)
const editorText = ref('')

const DRAW_TOOLS = ['rect', 'ellipse', 'ink', 'arrow', 'measure', 'text', 'note', 'stamp', 'image']

const items = computed(() => pageAnnotations(props.pageNumber - 1))
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
  /** 起始屏幕坐标(旋转视图下缩放手柄按屏幕位移换算) */
  startClient: { x: number; y: number }
  /** 参与本次拖动的注释(多选批量移动;resize 只有自身) */
  movers: Annotation[]
  pointerId: number
  /** move 模式的累计位移(PDF 点):拖动期间只更新它 + CSS 平移,松手才写回模型,
   *  否则每帧全量重算 ink 点集并重建 SVG points 字符串,长笔画拖动必然掉帧 */
  offset: { dx: number; dy: number }
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
  // 右键/中键既不绘制也不清选:右键要留给页面上下文菜单,且 text/note/stamp/image
  // 不受 3px 阈值保护,右键会直接落一条批注
  if (event.button !== 0) return
  // 注:select 工具的空白点击清选在 PageCanvas 的 page-wrap 上处理——
  // 该模式下本 svg 为 pointer-events:none,收不到空白点击
  if (!interactive.value || !props.viewport) return
  event.preventDefault()
  const local = localPoint(event)
  draw.value = { tool: ui.tool, startScreen: local, currentScreen: local, inkScreen: [local] }
  // 与移动/缩放路径对齐:捕获指针 + 监听 pointercancel。
  // 只靠 window 监听覆盖不到「拖到窗口外松开」和「触摸手势被系统接管」,
  // 那两种情况 draw.value 会永不清空,预览橡皮筋停在半空覆盖页面。
  try {
    svgEl.value?.setPointerCapture(event.pointerId)
  } catch {
    // 合成事件/指针已失效:由 window 监听兜底
  }
  window.addEventListener('pointermove', onLayerPointerMove)
  window.addEventListener('pointerup', onLayerPointerUp)
  window.addEventListener('pointercancel', onLayerPointerUp)
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
  window.removeEventListener('pointercancel', onLayerPointerUp)
  draw.value = null
  // 指针捕获是本次按下建立的:无论正常抬起还是 pointercancel,都在这里交还
  try {
    if (event.pointerId !== undefined) svgEl.value?.releasePointerCapture(event.pointerId)
  } catch {
    // 指针已释放:忽略
  }
  if (!state || !props.viewport) return
  // pointercancel 表示手势被系统接管(滚动手势/系统返回),不生成批注
  if (event.type === 'pointercancel') return
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
    // 旋转页面/旋转视图下 PDF 轴与屏幕轴互换:必须按屏幕矩形反算,否则文本框实际横躺
    const bbox = screenToPdfRect(state.startScreen.x, state.startScreen.y, width, height)
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
    const bbox = screenToPdfRect(state.startScreen.x - width / 2, state.startScreen.y - height / 2, width, height)
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
  if (event.button !== 0) return
  if (ui.tool !== 'select' || !props.viewport) return
  event.stopPropagation()
  event.preventDefault()
  if (event.shiftKey) {
    toggleAnnotationSelection(ann.id)
    return
  }
  if (!ui.selectedAnnotationIds.includes(ann.id)) selectAnnotation(ann.id)
  if (ann.locked) return
  // 多选里被锁定的成员不参与移动;全部锁定则不进入拖动
  const movers = ui.selectedAnnotationIds
    .map((id) => annotState.items.find((a) => a.id === id))
    .filter((a): a is Annotation => !!a && !a.locked)
    .map((a) => JSON.parse(JSON.stringify(a)) as Annotation)
  if (movers.length === 0) return
  const startPdf = toPdf(localPoint(event))
  if (!startPdf) return
  drag.value = {
    mode: 'move',
    handle: '',
    before: JSON.parse(JSON.stringify(ann)) as Annotation,
    startPdf,
    startClient: { x: event.clientX, y: event.clientY },
    movers,
    pointerId: event.pointerId,
    offset: { dx: 0, dy: 0 }
  }
  try {
    svgEl.value?.setPointerCapture(event.pointerId)
  } catch {
    // 合成事件/无活动指针时 capture 会抛错;拖拽仍由 window 监听兜底
  }
  ui.dragging = true
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragEnd)
}

function onHandlePointerDown(ann: Annotation, handle: string, event: PointerEvent): void {
  if (event.button !== 0) return
  if (!props.viewport || ann.locked) return
  event.stopPropagation()
  event.preventDefault()
  const startPdf = toPdf(localPoint(event))
  if (!startPdf) return
  const before = JSON.parse(JSON.stringify(ann)) as Annotation
  drag.value = {
    mode: 'resize',
    handle,
    before,
    startPdf,
    startClient: { x: event.clientX, y: event.clientY },
    movers: [before],
    pointerId: event.pointerId,
    offset: { dx: 0, dy: 0 }
  }
  try {
    svgEl.value?.setPointerCapture(event.pointerId)
  } catch {
    // 同上:忽略 capture 失败
  }
  ui.dragging = true
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragEnd)
}
/** 拖动期间的 CSS 平移:PDF 位移按当前 viewport 换算成屏幕像素(含旋转变换) */
function dragTransform(offset: { dx: number; dy: number }): string {
  const vp = props.viewport
  if (!vp) return ''
  const zero = pdfPointToScreen(vp, { x: 0, y: 0 })
  const shifted = pdfPointToScreen(vp, { x: offset.dx, y: offset.dy })
  return `translate(${shifted.x - zero.x}px, ${shifted.y - zero.y}px)`
}

/** 位移一个注释(按类型走几何点或 bbox) */
function shiftAnnotation(before: Annotation, dx: number, dy: number): Partial<Annotation> {
  if (before.kind === 'ink') {
    return { points: before.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
  }
  if (before.kind === 'arrow' || before.kind === 'measure') {
    return {
      from: { x: before.from.x + dx, y: before.from.y + dy },
      to: { x: before.to.x + dx, y: before.to.y + dy }
    }
  }
  return { bbox: { ...before.bbox, x: before.bbox.x + dx, y: before.bbox.y + dy } }
}

/** 最近一次 pointermove(rAF 攒批:reactive 写会触发各层 filter 全量重算,每帧最多提交一次) */
let pendingDragEvent: PointerEvent | null = null
let dragFrame = 0

function onDragMove(event: PointerEvent): void {
  pendingDragEvent = event
  if (dragFrame !== 0) return
  dragFrame = requestAnimationFrame(() => {
    dragFrame = 0
    const ev = pendingDragEvent
    pendingDragEvent = null
    if (ev) applyDragMove(ev)
  })
}

function applyDragMove(event: PointerEvent): void {
  const state = drag.value
  const vp = props.viewport
  if (!state || !vp) return
  const current = toPdf(localPoint(event))
  if (!current) return
  const dx = current.x - state.startPdf.x
  const dy = current.y - state.startPdf.y
  const before = state.before

  if (state.mode === 'move') {
    // 只更新累计位移:AnnotationShape 用它做 CSS 平移,模型与 points 字符串到松手才重算
    state.offset = { dx, dy }
    return
  }

  if (before.kind === 'arrow' || before.kind === 'measure') {
    if (state.handle === 'from') patchAnnotation(before.id, { from: { x: before.from.x + dx, y: before.from.y + dy } })
    else patchAnnotation(before.id, { to: { x: before.to.x + dx, y: before.to.y + dy } })
    return
  }

  // 矩形族:按屏幕位移缩放(屏幕 y 向下;n/s 与 PDF 空间的增量方向相反)
  const sdx = event.clientX - state.startClient.x
  const sdy = event.clientY - state.startClient.y
  const screen = pdfRectToScreen(vp, before.bbox)
  let { x, y, w, h } = screen
  if (state.handle.includes('w')) {
    x += sdx
    w -= sdx
  }
  if (state.handle.includes('e')) w += sdx
  if (state.handle.includes('n')) {
    y += sdy
    h -= sdy
  }
  if (state.handle.includes('s')) h += sdy
  w = Math.max(w, 8)
  h = Math.max(h, 8)
  patchAnnotation(before.id, { bbox: screenToPdfRect(x, y, w, h) })
}

function onDragEnd(): void {
  const state = drag.value
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragEnd)
  // 冲刷最后一帧:快速单击/程序化移动时 rAF 可能还没跑,丢了就少一段位移
  if (dragFrame !== 0) {
    cancelAnimationFrame(dragFrame)
    dragFrame = 0
  }
  if (pendingDragEvent) {
    const ev = pendingDragEvent
    pendingDragEvent = null
    applyDragMove(ev)
  }
  // 冲刷后的遗留帧不再跑(commitCommands 以最终模型为准)
  pendingDragEvent = null
  drag.value = null
  ui.dragging = false
  if (!state) return
  try {
    svgEl.value?.releasePointerCapture(state.pointerId)
  } catch {
    // 指针已释放(如 pointercancel 后):忽略
  }
  // move 模式拖动期间没写模型:这里一次性落值(平移才进模型/历史/导出)
  if (state.mode === 'move' && (state.offset.dx !== 0 || state.offset.dy !== 0)) {
    for (const mover of state.movers) {
      patchAnnotation(mover.id, shiftAnnotation(mover, state.offset.dx, state.offset.dy))
    }
  }
  commitAnnotations(state.movers)
}

/* ------------------------------ 编辑 ------------------------------ */

function openEditor(id: string): void {
  const ann = annotState.items.find((a) => a.id === id)
  if (!ann || (ann.kind !== 'text' && ann.kind !== 'note')) return
  editingId.value = id
  editorText.value = ann.text
  registerEditorCommit(commitEditor)
}

function onAnnDoubleClick(ann: Annotation): void {
  if (ui.tool !== 'select' || ann.locked) return
  if (ann.kind === 'text' || ann.kind === 'note') openEditor(ann.id)
}

function commitEditor(): void {
  const id = editingId.value
  editingId.value = null
  registerEditorCommit(null)
  if (!id) return
  const ann = annotState.items.find((a) => a.id === id)
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
  patchAnnotation(id, textPatch(ann, text))
  commitAnnotation(ann)
}

/** 编辑器对应的注释仍存在时才渲染编辑框(注释可能被列表/撤销删除) */
const editingAlive = computed(() => !!editingId.value && annotState.items.some((a) => a.id === editingId.value))

watch(editingAlive, (alive) => {
  if (!alive) editingId.value = null
})

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

/** 恰好单选时返回该注释(用于属性/把手);多选或未选 → null */
const selected = computed(() => {
  const ids = ui.selectedAnnotationIds
  if (ids.length !== 1) return null
  const id = ids[0]
  return annotState.items.find((a) => a.id === id && a.page === props.pageNumber - 1) ?? null
})

const selectionBox = computed(() => {
  const ann = selected.value
  const vp = props.viewport
  if (!ann || !vp || ann.page !== props.pageNumber - 1) return null
  return pdfRectToScreen(vp, ann.bbox)
})

/** 本页全部选中项的虚线框(多选可视化) */
const selectedBoxes = computed(() => {
  const vp = props.viewport
  if (!vp) return []
  const ids = ui.selectedAnnotationIds
  return items.value
    .filter((ann) => ids.includes(ann.id))
    .map((ann) => ({ id: ann.id, box: pdfRectToScreen(vp, ann.bbox) }))
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
  // 卸载前若正在拖拽:必须走一遍与 onDragEnd 相同的收尾(冲刷最后一帧 + 落 move 位移),
  // 否则最后一帧位移会被静默丢弃;更关键的是 ui.dragging 永远停在 true,
  // keymap 的 Ctrl+S / Ctrl+Z 会从此全部失灵(用户按了没反应,以为已保存)。
  // 该路径可达:clearPage() 把 viewport 置 null → AnnotationLayer 被 v-if 卸载。
  if (drag.value) {
    const state = drag.value
    try {
      svgEl.value?.releasePointerCapture(state.pointerId)
    } catch {
      // 指针已释放:忽略
    }
    if (state.mode === 'move' && (state.offset.dx !== 0 || state.offset.dy !== 0)) {
      for (const mover of state.movers) {
        patchAnnotation(mover.id, shiftAnnotation(mover, state.offset.dx, state.offset.dy))
      }
    }
    commitAnnotations(state.movers)
    drag.value = null
    ui.dragging = false
  }
  ui.dragging = false
  if (dragFrame !== 0) cancelAnimationFrame(dragFrame)
  pendingDragEvent = null
  // 绘制态收尾:清掉可能停在半空的橡皮筋(否则预览会留到下一次绘制才被覆盖)
  draw.value = null
  window.removeEventListener('pointermove', onLayerPointerMove)
  window.removeEventListener('pointerup', onLayerPointerUp)
  window.removeEventListener('pointercancel', onLayerPointerUp)
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragEnd)
  registerEditorCommit(null)
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
      :translate="drag?.mode === 'move' && drag.movers.some((m) => m.id === ann.id) ? dragTransform(drag.offset) : undefined"
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

    <template v-if="ui.tool === 'select'">
      <rect
        v-for="item in selectedBoxes"
        :key="item.id"
        :x="item.box.x - 2"
        :y="item.box.y - 2"
        :width="item.box.w + 4"
        :height="item.box.h + 4"
        fill="none"
        stroke="#4a8fe7"
        stroke-width="1"
        stroke-dasharray="4 3"
        class="selection-frame"
      />
      <template v-if="selected && !selected.locked && selected.kind !== 'ink' && selected.kind !== 'arrow' && selected.kind !== 'measure'">
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
      <template v-else-if="selected && !selected.locked">
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

  <div v-if="editingId && editingAlive" class="ann-editor" :style="editorStyle" @pointerdown.stop>
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
  /* .ann-layer 在 select 模式是 pointer-events:none,该属性可继承;
     手柄没有自身覆盖时不可点(冒烟用 dispatchEvent 直发元素,所以没暴露) */
  pointer-events: all;
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
