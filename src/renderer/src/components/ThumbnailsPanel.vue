<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PageThumb from './PageThumb.vue'
import { docState, pinThumbPages } from '../store/document'
import { scrollToPage } from '../store/viewer'
import {
  deletePages,
  dropTargetIndex,
  extractPages,
  exportPagesAsImages,
  insertBlankPage,
  mergePdfs,
  movePage,
  normalizePageOrientation,
  rotatePages,
  splitPdfs
} from '../lib/actions'
import { requestPagesRange, showToast, ui, type PagesAction } from '../store/ui'
import { parsePageRange } from '@shared/text'

const THUMB_WIDTH = 84

/** 长操作(保存/拆分/合并/导出)执行中:页面操作入口置灰,防止并发两批任务 */
const busy = computed(() => ui.busy !== null)

const containerEl = ref<HTMLElement | null>(null)
const visibleThumbs = reactive(new Set<number>())
const selected = ref<Set<number>>(new Set())
let observer: IntersectionObserver | null = null
let resizeObserver: ResizeObserver | null = null

const items = computed(() =>
  docState.pageBoxes.map((box, index) => {
    const rotated = docState.rotationView % 180 !== 0
    const w = rotated ? box.h : box.w
    const h = rotated ? box.w : box.h
    const scale = THUMB_WIDTH / Math.max(w, 1)
    return { page: index + 1, w: Math.round(w * scale), h: Math.round(h * scale) }
  })
)

const selectedList = computed(() => [...selected.value].sort((a, b) => a - b))
const rotateTargets = computed(() => (selectedList.value.length > 0 ? selectedList.value : [docState.currentPage]))

function toggleSelect(page: number): void {
  const next = new Set(selected.value)
  if (next.has(page)) next.delete(page)
  else next.add(page)
  selected.value = next
}

/** 右键缩略图:打开页面菜单(位置为视口坐标) */
function openThumbMenu(page: number, event: MouseEvent): void {
  ui.pageMenu = { open: true, page, x: event.clientX, y: event.clientY }
}

function clearSelection(): void {
  selected.value = new Set()
}

function setupObserver(): void {
  observer?.disconnect()
  const root = containerEl.value
  if (!root) return
  const sample = root.querySelector<HTMLElement>('[data-thumb]')
  // 首次布局尚未生效时缩略图高度为 0,会被整批判为可见;等下一帧再建观察器
  if (sample && sample.getBoundingClientRect().height === 0) {
    requestAnimationFrame(() => setupObserver())
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pageNumber = Number((entry.target as HTMLElement).dataset.thumb)
        if (!pageNumber) continue
        if (entry.isIntersecting) visibleThumbs.add(pageNumber)
        else visibleThumbs.delete(pageNumber)
      }
      pinThumbPages(visibleThumbs)
    },
    { root, rootMargin: '150px 0px' }
  )
  for (const el of root.querySelectorAll<HTMLElement>('[data-thumb]')) observer.observe(el)
}

async function onRangeAction(action: PagesAction): Promise<void> {
  const result = await requestPagesRange(action)
  if (!result) return
  const pages = parsePageRange(result.input, docState.pageCount)
  if (!pages || pages.length === 0) {
    showToast('页码范围无效', 'error')
    return
  }
  switch (action) {
    case 'delete':
      await deletePages(pages)
      clearSelection()
      break
    case 'extract':
      await extractPages(pages, result.includeAnnotations)
      break
    case 'export':
      if (result.format === 'png') {
        await exportPagesAsImages(pages, result.mode ?? 'each', result.direction, result.includeAnnotations)
      } else {
        await extractPages(pages, result.includeAnnotations)
      }
      break
  }
}

async function onRotate(delta: number): Promise<void> {
  await rotatePages(rotateTargets.value.map((page) => page - 1), delta)
}

async function onInsertBlank(): Promise<void> {
  await insertBlankPage(docState.currentPage - 1)
}

async function onMerge(): Promise<void> {
  await mergePdfs()
}

async function onSplit(): Promise<void> {
  await splitPdfs()
}

/* --------------------------- 拖拽排序 --------------------------- */

let dragPage: number | null = null
/** 拖动中的源页号(1-based);null = 未在拖动 */
const draggingPage = ref<number | null>(null)
/** 落点提示:{ page, after } | null */
const dropHint = ref<{ page: number; after: boolean } | null>(null)

/** 拖动到列表上/下边缘时的自动滚动(rAF 循环,一次只有一个) */
let autoScrollRaf = 0
/** 最新指针 Y(视口坐标);rAF 循环每帧读取 */
let autoScrollY = 0
/** 每帧最大滚动步长(px);按指针到边缘的距离线性缩放 */
const AUTO_SCROLL_MAX_STEP = 14
/** 触发自动滚动的边缘感应带宽度(px) */
const AUTO_SCROLL_EDGE = 40

function stopAutoScroll(): void {
  if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf)
  autoScrollRaf = 0
}

function autoScrollStep(): void {
  const root = containerEl.value
  autoScrollRaf = 0
  if (!root) return
  const rect = root.getBoundingClientRect()
  const above = rect.top + AUTO_SCROLL_EDGE - autoScrollY // >0:进入上边缘带
  const below = autoScrollY - (rect.bottom - AUTO_SCROLL_EDGE) // >0:进入下边缘带
  if (above <= 0 && below <= 0) return
  const ratio = Math.min(Math.max(above, below) / AUTO_SCROLL_EDGE, 1)
  root.scrollTop += Math.ceil(ratio * AUTO_SCROLL_MAX_STEP) * (above > 0 ? -1 : 1)
  autoScrollRaf = requestAnimationFrame(autoScrollStep)
}

/** 落点是否在目标项下半区(dragover 与 drop 共用,避免判定分叉) */
function isAfterMidpoint(el: HTMLElement, clientY: number): boolean {
  const rect = el.getBoundingClientRect()
  return clientY - rect.top > rect.height / 2
}

function onThumbDragStart(page: number, event: DragEvent): void {
  dragPage = page
  draggingPage.value = page
  event.dataTransfer?.setData('text/plain', String(page))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onThumbDragEnd(): void {
  dragPage = null
  draggingPage.value = null
  dropHint.value = null
  stopAutoScroll()
}

function onThumbDragOver(target: number, event: DragEvent): void {
  if (dragPage === null) return
  const el = event.currentTarget as HTMLElement
  dropHint.value = dragPage === target ? null : { page: target, after: isAfterMidpoint(el, event.clientY) }
  autoScrollY = event.clientY
  if (!autoScrollRaf) autoScrollRaf = requestAnimationFrame(autoScrollStep)
}

async function onThumbDrop(target: number, event: DragEvent): Promise<void> {
  if (dragPage === null) return
  const el = event.currentTarget as HTMLElement
  const after = isAfterMidpoint(el, event.clientY)
  const from = dragPage - 1
  const to = dropTargetIndex(dragPage, target, after)
  dragPage = null
  draggingPage.value = null
  dropHint.value = null
  stopAutoScroll()
  if (to === null) return
  await movePage(from, to)
  scrollToPage(to + 1)
}

/* --------------------------- 主视图滚动 → 侧栏跟随 --------------------------- */

watch(
  () => docState.currentPage,
  async (page) => {
    const root = containerEl.value
    if (!root || !docState.pdfDoc) return
    await nextTick()
    const el = root.querySelector<HTMLElement>(`[data-thumb="${page}"]`)
    if (!el) return
    const delta = el.getBoundingClientRect().top - root.getBoundingClientRect().top
    const target = root.scrollTop + delta - root.clientHeight / 2 + el.clientHeight / 2
    if (Math.abs(root.scrollTop - target) > 2) root.scrollTop = Math.max(0, target)
  }
)

onMounted(() => {
  setupObserver()
  const root = containerEl.value
  if (root && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      visibleThumbs.clear()
      pinThumbPages(visibleThumbs)
      setupObserver()
    })
    resizeObserver.observe(root)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  resizeObserver?.disconnect()
  stopAutoScroll()
})

watch(
  () => [docState.docId, docState.pageBoxes.length] as const,
  async () => {
    visibleThumbs.clear()
    selected.value = new Set()
    await nextTick()
    setupObserver()
  }
)
</script>

<template>
  <aside class="thumbs">
    <div class="pages-toolbar">
      <button :disabled="busy" title="按页码范围删除页面" @click="onRangeAction('delete')">删除</button>
      <button :disabled="busy" title="按页码范围提取为新 PDF" @click="onRangeAction('extract')">提取</button>
      <button :disabled="busy" title="批量拆分 PDF 页面" @click="onSplit">拆分</button>
      <button :disabled="busy" title="按范围导出(PDF / PNG多图 / 长图)" @click="onRangeAction('export')">导出</button>
      <button title="左旋 90°(选中页或当前页)" @click="onRotate(-90)">左旋</button>
      <button title="右旋 90°(选中页或当前页)" @click="onRotate(90)">右旋</button>
      <button :disabled="busy" title="按内容方向统一整份文档的页面朝向(扫描件零星几页方向不一致时用)" @click="normalizePageOrientation">
        统一方向
      </button>
      <button title="在当前页之后插入空白页" @click="onInsertBlank">空白页</button>
      <button :disabled="busy" title="合并其他 PDF(可指定页码,另存为新文件)" @click="onMerge">合并</button>
    </div>
    <div ref="containerEl" class="thumbs-scroll">
      <div class="thumbs-inner">
        <div
          v-for="item in items"
          :key="`${docState.docId}-${item.page}`"
          class="thumb"
          :class="{
            current: item.page === docState.currentPage,
            selected: selected.has(item.page),
            dragging: draggingPage === item.page,
            'drop-before': dropHint?.page === item.page && dropHint.after === false,
            'drop-after': dropHint?.page === item.page && dropHint.after === true
          }"
          :data-thumb="item.page"
          draggable="true"
          @click="scrollToPage(item.page)"
          @dragstart="onThumbDragStart(item.page, $event)"
          @dragend="onThumbDragEnd"
          @dragover.prevent="onThumbDragOver(item.page, $event)"
          @drop.prevent="onThumbDrop(item.page, $event)"
          @contextmenu.prevent="openThumbMenu(item.page, $event)"
        >
          <div class="thumb-box" :style="{ width: item.w + 'px', height: item.h + 'px' }">
            <PageThumb
              :page-number="item.page"
              :thumb-width="THUMB_WIDTH"
              :visible="visibleThumbs.has(item.page)"
            />
            <input
              class="thumb-check"
              type="checkbox"
              :checked="selected.has(item.page)"
              title="选中该页"
              @click.stop
              @change="toggleSelect(item.page)"
            />
          </div>
          <span class="thumb-label">{{ item.page }}</span>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.thumbs {
  width: 156px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg);
  border-right: 1px solid var(--panel-border);
  min-height: 0;
}

.pages-toolbar {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  padding: 6px;
  border-bottom: 1px solid var(--panel-border);
  flex: none;
}

.pages-toolbar button {
  padding: 3px 2px;
  font-size: 12px;
  border: 1px solid var(--panel-border);
}

.thumbs-scroll {
  flex: 1;
  overflow-y: auto;
}

.thumbs-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
}

.thumb {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  border: 1px solid transparent;
}

.thumb:hover {
  background: var(--toolbar-hover);
}

.thumb.current {
  border-color: var(--accent);
  background: var(--toolbar-hover);
}

.thumb.selected {
  border-color: #f0c36d;
  background: var(--toolbar-hover);
}

/* 拖动中的源项:变淡以表明"正在搬运" */
.thumb.dragging {
  opacity: 0.4;
}

/* 插入位置指示线:用 inset box-shadow 而非 border,避免改变盒尺寸导致布局抖动 */
.thumb.drop-before {
  box-shadow: inset 0 2px 0 0 var(--accent);
}

.thumb.drop-after {
  box-shadow: inset 0 -2px 0 0 var(--accent);
}

.thumb-box {
  position: relative;
  overflow: hidden;
  background: #fff;
  /* 离屏缩略图跳过子树布局/绘制;尺寸由内联 width/height 显式给出 */
  content-visibility: auto;
}

.thumb-check {
  position: absolute;
  left: 2px;
  top: 2px;
  margin: 0;
  cursor: pointer;
}

.thumb-label {
  font-size: 11px;
  color: var(--toolbar-fg-dim);
}
</style>
