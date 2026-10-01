<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PDFPageProxy, PageViewport, RenderTask, TextLayerRenderTask } from 'pdfjs-dist'
import type { Rect } from '@shared/types'
import { docState, getPage, pageDisplaySize } from '../store/document'
import { searchState } from '../store/search'
import { addAnnotation, addAnnotations } from '../store/annotations'
import { ui } from '../store/ui'
import { getPageViewport, pdfjs } from '../lib/pdfjs'
import { pdfRectToScreen, rectFromPoints, screenPointToPdf, type ScreenRect } from '../lib/geo'
import { TOOL_DEFAULTS, withIdentity } from '../lib/annots'
import AnnotationLayer from './AnnotationLayer.vue'
import FormOverlay from './FormOverlay.vue'

const props = defineProps<{ pageNumber: number; visible: boolean }>()

const wrapEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const textLayerEl = ref<HTMLDivElement | null>(null)
const rendered = ref(false)
const viewport = ref<PageViewport | null>(null)

let renderTask: RenderTask | null = null
let textLayer: TextLayerRenderTask | null = null
let seq = 0

const size = computed(() => pageDisplaySize(props.pageNumber - 1))

/** 搜索命中高亮(仅本页,换算到屏幕坐标) */
const searchRects = computed<ScreenRect[]>(() => {
  const vp = viewport.value
  if (!vp || !rendered.value) return []
  const rects: ScreenRect[] = []
  for (const match of searchState.results) {
    if (match.page !== props.pageNumber - 1) continue
    for (const rect of match.rects) rects.push(pdfRectToScreen(vp, rect))
  }
  return rects
})

async function renderTextLayer(page: PDFPageProxy, vp: PageViewport): Promise<void> {
  const el = textLayerEl.value
  if (!el) return
  textLayer?.cancel()
  el.replaceChildren()
  // pdf.js v3 文本层按 --scale-factor 计算字号(必须与 viewport.scale 一致)
  el.style.setProperty('--scale-factor', String(vp.scale))
  // pdf.js v3 无 TextLayer 类,使用 renderTextLayer(返回带 promise/cancel 的任务)
  const task = pdfjs.renderTextLayer({
    textContentSource: page.streamTextContent(),
    container: el,
    viewport: vp
  })
  textLayer = task
  try {
    await task.promise
  } catch (err) {
    console.warn('文本层渲染失败:', err)
  }
}

async function renderPage(): Promise<void> {
  const canvas = canvasEl.value
  if (!canvas || !props.visible) return
  const mySeq = ++seq
  const page = await getPage(props.pageNumber)
  if (mySeq !== seq) return

  const info = getPageViewport(page, docState.scale, docState.rotationView)
  const vp = info.viewport
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = 1 // 低内存优先:统一按 1 倍位图渲染(内网机多为普通 DPI 屏)
  canvas.width = Math.floor(vp.width * dpr)
  canvas.height = Math.floor(vp.height * dpr)
  canvas.style.width = `${vp.width}px`
  canvas.style.height = `${vp.height}px`

  renderTask?.cancel()
  renderTask = page.render({
    canvasContext: ctx,
    viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
  })
  try {
    await renderTask.promise
  } catch (err) {
    if ((err as Error)?.name !== 'RenderingCancelledException') console.warn('页面渲染失败:', err)
    return
  }
  if (mySeq !== seq) return
  viewport.value = vp
  rendered.value = true
  await renderTextLayer(page, vp)
}

function clearPage(): void {
  seq++
  renderTask?.cancel()
  renderTask = null
  textLayer?.cancel()
  textLayer = null
  textLayerEl.value?.replaceChildren()
  const canvas = canvasEl.value
  if (canvas) {
    canvas.width = 0
    canvas.height = 0
    canvas.style.width = `${size.value.w}px`
    canvas.style.height = `${size.value.h}px`
  }
  viewport.value = null
  rendered.value = false
}

/* ---------------------------- 高亮工具 ---------------------------- */

const highlightStart = ref<{ x: number; y: number } | null>(null)

function mergeLineRects(rects: Rect[]): Rect[] {
  const lines = new Map<number, Rect[]>()
  for (const rect of rects) {
    const key = Math.round(rect.y / 2) * 2
    const list = lines.get(key)
    if (list) list.push(rect)
    else lines.set(key, [rect])
  }
  const merged: Rect[] = []
  for (const list of lines.values()) {
    list.sort((a, b) => a.x - b.x)
    let current = { ...list[0] }
    for (let i = 1; i < list.length; i++) {
      const rect = list[i]
      if (rect.x <= current.x + current.w + 2) {
        const right = Math.max(current.x + current.w, rect.x + rect.w)
        current.h = Math.max(current.h, rect.h)
        current.w = right - current.x
      } else {
        merged.push(current)
        current = { ...rect }
      }
    }
    merged.push(current)
  }
  return merged
}

function selectionRectsToPdf(selection: Selection, vp: PageViewport): Rect[] {
  const wrap = wrapEl.value
  if (!wrap) return []
  const wrapRect = wrap.getBoundingClientRect()
  const rects: Rect[] = []
  for (const clientRect of Array.from(selection.getRangeAt(0).getClientRects())) {
    if (clientRect.width < 1 || clientRect.height < 1) continue
    if (clientRect.right < wrapRect.left || clientRect.left > wrapRect.right) continue
    if (clientRect.bottom < wrapRect.top || clientRect.top > wrapRect.bottom) continue
    const a = screenPointToPdf(vp, clientRect.left - wrapRect.left, clientRect.top - wrapRect.top)
    const b = screenPointToPdf(vp, clientRect.right - wrapRect.left, clientRect.bottom - wrapRect.top)
    rects.push(rectFromPoints(a, b))
  }
  return mergeLineRects(rects)
}

function onPagePointerDown(event: PointerEvent): void {
  if (ui.tool !== 'highlight' || !viewport.value) return
  highlightStart.value = { x: event.clientX, y: event.clientY }
}

function onPagePointerUp(event: PointerEvent): void {
  const start = highlightStart.value
  highlightStart.value = null
  const vp = viewport.value
  const wrap = wrapEl.value
  if (ui.tool !== 'highlight' || !start || !vp || !wrap) return
  const style = TOOL_DEFAULTS.highlight

  const selection = window.getSelection()
  if (selection && !selection.isCollapsed && selection.rangeCount > 0 && textLayerEl.value?.contains(selection.anchorNode)) {
    const rects = selectionRectsToPdf(selection, vp)
    selection.removeAllRanges()
    if (rects.length > 0) {
      addAnnotations(
        rects.map((bbox) =>
          withIdentity({
            kind: 'highlight',
            page: props.pageNumber - 1,
            bbox,
            color: style.color,
            opacity: style.opacity
          })
        )
      )
      return
    }
  }

  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return
  const wrapRect = wrap.getBoundingClientRect()
  const a = screenPointToPdf(vp, start.x - wrapRect.left, start.y - wrapRect.top)
  const b = screenPointToPdf(vp, event.clientX - wrapRect.left, event.clientY - wrapRect.top)
  addAnnotation(
    withIdentity({
      kind: 'highlight',
      page: props.pageNumber - 1,
      bbox: rectFromPoints(a, b),
      color: style.color,
      opacity: style.opacity
    })
  )
}

watch(
  [() => props.visible, () => docState.scale, () => docState.rotationView, () => props.pageNumber],
  () => {
    if (props.visible) void renderPage()
    else clearPage()
  },
  { immediate: true }
)

onMounted(() => {
  if (!props.visible) clearPage()
})

onBeforeUnmount(() => {
  clearPage()
})

defineExpose({ rendered, viewport })
</script>

<template>
  <div
    ref="wrapEl"
    class="page-wrap"
    :data-page="pageNumber"
    :data-visible="visible ? '1' : '0'"
    :style="{ width: size.w + 'px', height: size.h + 'px' }"
    @pointerdown="onPagePointerDown"
    @pointerup="onPagePointerUp"
  >
    <canvas ref="canvasEl" class="page-canvas"></canvas>
    <div ref="textLayerEl" class="textLayer"></div>
    <svg class="search-layer" :width="size.w" :height="size.h">
      <rect
        v-for="(rect, index) in searchRects"
        :key="index"
        :x="rect.x"
        :y="rect.y"
        :width="rect.w"
        :height="rect.h"
        fill="rgba(255, 196, 0, 0.45)"
      />
    </svg>
    <FormOverlay v-if="viewport && docState.formFields.length > 0" :page-number="pageNumber" :viewport="viewport" />
    <AnnotationLayer
      v-if="viewport"
      :page-number="pageNumber"
      :viewport="viewport"
      :size="size"
    />
  </div>
</template>

<style scoped>
.page-wrap {
  position: relative;
  margin: 0 auto 16px;
  background: #fff;
  box-shadow: var(--page-shadow);
  flex: none;
}

.page-canvas {
  display: block;
  position: absolute;
  inset: 0;
}

.textLayer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  line-height: 1;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: transparent;
  z-index: 2;
}

.textLayer :deep(span) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}

.textLayer :deep(::selection) {
  background: rgba(74, 143, 231, 0.35);
}

.search-layer {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  z-index: 3;
}
</style>
