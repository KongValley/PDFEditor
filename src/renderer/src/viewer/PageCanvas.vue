<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PDFPageProxy, PageViewport, RenderTask, TextLayerRenderTask } from 'pdfjs-dist'
import type { Rect } from '@shared/types'
import { docState, getPage, pageDisplaySize } from '../store/document'
import { searchState } from '../store/search'
import { addAnnotation, addAnnotations, selectAnnotation } from '../store/annotations'
import { ui } from '../store/ui'
import { acquireRenderSlot, releaseRenderSlot, renderWatchdog, zoomWheelAt } from '../store/viewer'
import { getPageViewport, pdfjs } from '../lib/pdfjs'
import { pdfRectToScreen, rectFromPoints, screenPointToPdf, type ScreenRect } from '../lib/geo'
import { TOOL_DEFAULTS, withIdentity } from '../lib/annots'
import AnnotationLayer from './AnnotationLayer.vue'
import FormOverlay from './FormOverlay.vue'

const props = defineProps<{ pageNumber: number; visible: boolean }>()

/** 离屏页不画投影:软件光栅下每帧混合 N 个模糊投影是滚动卡顿的主因 */
const shadowClass = computed(() => ({ 'page-noshadow': !props.visible }))

/** 右键该页:打开页面菜单(位置为视口坐标) */
function openPageMenu(event: MouseEvent): void {
  ui.pageMenu = { open: true, page: props.pageNumber, x: event.clientX, y: event.clientY }
}

const wrapEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const textLayerEl = ref<HTMLDivElement | null>(null)
const rendered = ref(false)
const viewport = ref<PageViewport | null>(null)

let renderTask: RenderTask | null = null
let textLayer: TextLayerRenderTask | null = null
let seq = 0

/** 缩放去抖计时器(标志位在 store/viewer.ts 的 zoomWheelAt) */
let scaleTimer = 0

/** 渲染超时后的最大重试次数(不含首次);慢机/大位图下排队时间会超过看门狗预算 */
const RENDER_MAX_RETRY = 3
/** 重试前的退避基数(ms):第 n 次重试等待 n * 该值,给 worker 队列排空的时间 */
const RENDER_RETRY_BACKOFF_MS = 400

const size = computed(() => pageDisplaySize(props.pageNumber - 1))

/** 搜索命中高亮(仅本页,换算到屏幕坐标;区分当前命中) */
const searchRects = computed<Array<{ rect: ScreenRect; current: boolean }>>(() => {
  const vp = viewport.value
  if (!vp || !rendered.value) return []
  const items: Array<{ rect: ScreenRect; current: boolean }> = []
  for (let index = 0; index < searchState.results.length; index++) {
    const match = searchState.results[index]
    if (match.page !== props.pageNumber - 1) continue
    for (const rect of match.rects) {
      items.push({ rect: pdfRectToScreen(vp, rect), current: index === searchState.current })
    }
  }
  return items
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

/** 超时竞速:worker 停摆时 promise 永不 settle,到点返回 'timeout'(计时器随结果清理) */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 超时后的重试:先退避再重来,给已拥塞的 worker 队列排空的时间。
 *
 * 关键:超时会取消渲染任务,pdf.js 此时已经把画布改成目标尺寸但还没画内容 —— 留下一块
 * "有尺寸但全白"的画布。所以只要该页仍然可见就必须保证最终画出内容:被更新的渲染
 * 取代(seq 变化)时,只有当那一轮已经把内容画出来才交给它,否则自己补一次。
 * 连续 RENDER_MAX_RETRY 次仍超时才放弃,并把画布归零(不留白页)。
 */
async function retryAfterTimeout(attempt: number, mySeq: number): Promise<void> {
  if (!props.visible) return
  // 已有更新的渲染接管,且它画出了内容 → 本轮无需再画
  if (mySeq !== seq && rendered.value) return
  if (attempt >= RENDER_MAX_RETRY) {
    console.warn(`[render] 第 ${props.pageNumber} 页连续 ${RENDER_MAX_RETRY + 1} 次超时,标记为未渲染`)
    const canvas = canvasEl.value
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
    return
  }
  await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * RENDER_RETRY_BACKOFF_MS))
  if (!props.visible) return
  return renderPage(attempt + 1)
}

async function renderPage(attempt = 0): Promise<void> {
  const canvas = canvasEl.value
  if (!canvas || !props.visible) return
  const mySeq = ++seq
  const page = await settleWithin(getPage(props.pageNumber), renderWatchdog.timeoutMs)
  if (page === 'timeout') {
    renderWatchdog.timeouts++
    console.warn(`[render] 第 ${props.pageNumber} 页 getPage 超时(${renderWatchdog.timeoutMs}ms)`)
    return retryAfterTimeout(attempt, mySeq)
  }
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

  await acquireRenderSlot()
  let timedOut = false
  try {
    // 排队期间可能已滚出视口或被新的渲染请求取代:直接释放槽,不做无用渲染
    if (!props.visible || mySeq !== seq) return

    renderTask?.cancel()
    renderTask = page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      // 批注由本应用 SVG 覆盖层绘制:pdf.js 默认会把 /Annots 画进位图 → 同屏两遍
      annotationMode: pdfjs.AnnotationMode.DISABLE
    })
    const stalled = renderWatchdog.stallNext
    if (stalled) renderWatchdog.stallNext = false
    if (stalled) void renderTask.promise.catch(() => {}) // 冒烟模拟停摆:真实结果忽略,避免未处理拒绝
    let outcome: 'ok' | 'timeout'
    try {
      const result = await settleWithin(
        stalled ? new Promise<never>(() => {}) : renderTask.promise,
        renderWatchdog.timeoutMs
      )
      outcome = result === 'timeout' ? 'timeout' : 'ok'
    } catch (err) {
      if ((err as Error)?.name !== 'RenderingCancelledException') console.warn('页面渲染失败:', err)
      return
    }
    if (outcome === 'timeout') {
      renderWatchdog.timeouts++
      console.warn(`[render] 第 ${props.pageNumber} 页渲染超时(${renderWatchdog.timeoutMs}ms),取消并重试`)
      renderTask.cancel()
      // 只置标记,不在这里 return:return 会连同 finally 一起结束函数,走不到下面的重试。
      // 重试必须等渲染槽归还之后再排队,否则会带着旧槽再申请一个 —— 多页同时超时会互相等死。
      timedOut = true
    } else {
      if (mySeq !== seq) return
      viewport.value = vp
      rendered.value = true
      renderWatchdog.renders++
      // 文本层与光栅化共用同一个 pdf.js worker:在渲染槽内 await 会让下一页的位图排在
      // 文本抽取之后(表现为"页面出现顺序错乱")。文本层不占槽,clearPage() 会 cancel 它。
      void renderTextLayer(page, vp)
    }
  } finally {
    releaseRenderSlot()
  }
  if (timedOut) return retryAfterTimeout(attempt, mySeq)
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
  if (ui.tool === 'select') {
    // 空白处点击清空注释选中(注释自身的 pointerdown 已 stopPropagation)
    if (!event.shiftKey) selectAnnotation(null)
    return
  }
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
    if (!props.visible) {
      clearPage()
      return
    }
    if (scaleTimer !== 0) {
      clearTimeout(scaleTimer)
      scaleTimer = 0
    }
    // Ctrl+滚轮逐事件改 scale:连续触发会反复 cancel/重启渲染,该来源去抖 120ms;
    // 可见性/旋转/换页/一次性缩放(菜单、按钮)仍立即渲染。
    if (zoomWheelAt.active) {
      scaleTimer = window.setTimeout(() => {
        scaleTimer = 0
        zoomWheelAt.active = false
        void renderPage()
      }, 120)
      return
    }
    void renderPage()
  },
  { immediate: true }
)

onMounted(() => {
  if (!props.visible) clearPage()
})

onBeforeUnmount(() => {
  if (scaleTimer !== 0) clearTimeout(scaleTimer)
  clearPage()
})

defineExpose({ rendered, viewport })
</script>

<template>
  <div
    ref="wrapEl"
    class="page-wrap"
    :class="shadowClass"
    :data-page="pageNumber"
    :data-visible="visible ? '1' : '0'"
    :style="{ width: size.w + 'px', height: size.h + 'px' }"
    @pointerdown="onPagePointerDown"
    @pointerup="onPagePointerUp"
    @contextmenu.prevent="openPageMenu"
  >
    <canvas ref="canvasEl" class="page-canvas"></canvas>
    <div ref="textLayerEl" class="textLayer"></div>
    <svg class="search-layer" :width="size.w" :height="size.h">
      <rect
        v-for="(item, index) in searchRects"
        :key="index"
        :x="item.rect.x"
        :y="item.rect.y"
        :width="item.rect.w"
        :height="item.rect.h"
        :fill="item.current ? 'rgba(255, 120, 0, 0.5)' : 'rgba(255, 196, 0, 0.45)'"
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
  /* 离屏页跳过子树布局/绘制;尺寸由内联 width/height 显式给出,滚动几何不受影响 */
  content-visibility: auto;
}

/* 离屏页不绘制投影:content-visibility 只跳过子树,元素自身的白底 + 阴影仍会被混合 */
.page-wrap.page-noshadow {
  box-shadow: none;
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
