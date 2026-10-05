<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PageCanvas from './PageCanvas.vue'
import { docState, pageDisplaySize, pinViewerPages } from '../store/document'
import {
  PAGE_GAP,
  attachContainer,
  computeCurrentPage,
  fitWidth,
  rowCount,
  rowHeight,
  rowPages,
  scrollToPage,
  zoomAt
} from '../store/viewer'
import { isTypingTarget } from '../lib/keymap'

const containerEl = ref<HTMLElement | null>(null)
const visiblePages = reactive(new Set<number>())
/** 双页模式的行:[[1,2],[3,4],…],最后一行可为单页 */
const spreadRows = computed(() =>
  Array.from({ length: rowCount() }, (_, row) => rowPages(row).map((index) => index + 1))
)
let observer: IntersectionObserver | null = null
let resizeObserver: ResizeObserver | null = null
let rafPending = false

/* --------------------------- 空格/中键拖拽平移 --------------------------- */

const spaceHeld = ref(false)
const panning = ref(false)
let panState: { x: number; y: number; left: number; top: number } | null = null
let pointerDownListener: HTMLElement | null = null

function onSpaceDown(event: KeyboardEvent): void {
  if (event.key !== ' ' || event.repeat || isTypingTarget(event.target)) return
  event.preventDefault()
  spaceHeld.value = true
}

function onSpaceUp(event: KeyboardEvent): void {
  if (event.key !== ' ') return
  spaceHeld.value = false
}

function onPanPointerDown(event: PointerEvent): void {
  const el = containerEl.value
  if (!el) return
  const middle = event.button === 1
  const spaceDrag = event.button === 0 && spaceHeld.value
  if (!middle && !spaceDrag) return
  event.preventDefault()
  event.stopPropagation()
  panState = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop }
  panning.value = true
  window.addEventListener('pointermove', onPanPointerMove)
  window.addEventListener('pointerup', onPanPointerUp)
}

function onPanPointerMove(event: PointerEvent): void {
  const el = containerEl.value
  if (!el || !panState) return
  el.scrollLeft = panState.left - (event.clientX - panState.x)
  el.scrollTop = panState.top - (event.clientY - panState.y)
}

function onPanPointerUp(): void {
  panState = null
  panning.value = false
  window.removeEventListener('pointermove', onPanPointerMove)
  window.removeEventListener('pointerup', onPanPointerUp)
}

function handleScroll(): void {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    const page = computeCurrentPage()
    if (page !== docState.currentPage) docState.currentPage = page
  })
}

function handleWheel(event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    zoomAt(docState.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientY)
    return
  }
  if (docState.viewMode !== 'single' || event.deltaY === 0) return
  const el = containerEl.value
  if (!el) return
  const delta = event.deltaY
  // 页内还有滚动空间时保持原生滚动,到边缘才翻页
  if (el.scrollHeight - el.clientHeight > 1) {
    if (delta < 0 && el.scrollTop > 0) return
    if (delta > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return
  }
  const target = docState.currentPage + (delta > 0 ? 1 : -1)
  if (target < 1 || target > docState.pageCount) return
  event.preventDefault()
  scrollToPage(target)
}

function setupObserver(): void {
  observer?.disconnect()
  const root = containerEl.value
  if (!root) return
  const sample = root.querySelector<HTMLElement>('[data-page]')
  // 首次布局尚未生效时页面高度为 0,会被整批判为可见;等下一帧再建观察器
  if (sample && sample.getBoundingClientRect().height === 0) {
    requestAnimationFrame(() => setupObserver())
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pageNumber = Number((entry.target as HTMLElement).dataset.page)
        if (!pageNumber) continue
        if (entry.isIntersecting) visiblePages.add(pageNumber)
        else visiblePages.delete(pageNumber)
      }
      pinViewerPages(visiblePages)
    },
    { root, rootMargin: '200px 0px' }
  )
  for (const el of root.querySelectorAll<HTMLElement>('[data-page]')) observer.observe(el)
}

/**
 * 按滚动几何直接标记可见页(±200px 缓冲)。
 * IntersectionObserver 首次投递可能延迟甚至丢失(窗口被遮挡时 rAF 节流),不能作为
 * 唯一的渲染触发源;此处补一次确定性播种,IO 后续条目仍会校正集合。
 */
function seedVisiblePages(): void {
  const root = containerEl.value
  if (!root || docState.pageBoxes.length !== docState.pageCount || docState.pageCount === 0) return
  if (docState.viewMode === 'single') {
    visiblePages.add(docState.currentPage)
    pinViewerPages(visiblePages)
    return
  }
  const top = root.scrollTop
  const bottom = top + root.clientHeight
  if (docState.viewMode === 'two') {
    let acc = 0
    for (let row = 0; row < rowCount(); row++) {
      const height = rowHeight(row) + PAGE_GAP
      if (acc + height >= top - 200 && acc <= bottom + 200) {
        for (const index of rowPages(row)) visiblePages.add(index + 1)
      }
      acc += height
    }
  } else {
    let acc = 0
    for (let i = 0; i < docState.pageCount; i++) {
      const height = pageDisplaySize(i).h + PAGE_GAP
      if (acc + height >= top - 200 && acc <= bottom + 200) visiblePages.add(i + 1)
      acc += height
    }
  }
  pinViewerPages(visiblePages)
}

/** 清空可见页集后重建观察器并播种(尺寸/模式/文档变化后调用) */
function refreshVisiblePages(): void {
  visiblePages.clear()
  pinViewerPages(visiblePages)
  setupObserver()
  seedVisiblePages()
}

onMounted(() => {
  attachContainer(containerEl.value)
  setupObserver()
  containerEl.value?.addEventListener('wheel', handleWheel, { passive: false })
  pointerDownListener = containerEl.value
  pointerDownListener?.addEventListener('pointerdown', onPanPointerDown, true)
  window.addEventListener('keydown', onSpaceDown)
  window.addEventListener('keyup', onSpaceUp)
  // 首次布局完成/窗口尺寸变化时重建观察器:否则初始 0 高度会让所有页被判为可见
  const root = containerEl.value
  if (root && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(refreshVisiblePages)
    resizeObserver.observe(root)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  resizeObserver?.disconnect()
  containerEl.value?.removeEventListener('wheel', handleWheel)
  pointerDownListener?.removeEventListener('pointerdown', onPanPointerDown, true)
  pointerDownListener = null
  window.removeEventListener('keydown', onSpaceDown)
  window.removeEventListener('keyup', onSpaceUp)
  window.removeEventListener('pointermove', onPanPointerMove)
  window.removeEventListener('pointerup', onPanPointerUp)
  attachContainer(null)
})

watch(
  () => [docState.docId, docState.pageBoxes.length] as const,
  async () => {
    visiblePages.clear()
    await nextTick()
    // 换文档时滚动位置必须归零:旧文档的 scrollTop 会让新文档首页落在视口外,首页永不渲染
    if (containerEl.value) containerEl.value.scrollTop = 0
    setupObserver()
    if (docState.docId && docState.pageBoxes.length === docState.pageCount) fitWidth()
    await nextTick()
    seedVisiblePages()
  }
)

// 视图模式切换:双页分支会重建页面 DOM 节点,必须重新观测并播种
watch(
  () => docState.viewMode,
  async () => {
    await nextTick()
    refreshVisiblePages()
  }
)

// 单页模式翻页:可见页集只含当前页(确定性,不依赖 IntersectionObserver 首次投递)
watch(
  () => docState.currentPage,
  () => {
    if (docState.viewMode !== 'single') return
    visiblePages.clear()
    visiblePages.add(docState.currentPage)
    pinViewerPages(visiblePages)
  }
)
</script>

<template>
  <div
    ref="containerEl"
    class="viewer"
    :style="{ cursor: panning ? 'grabbing' : spaceHeld ? 'grab' : '' }"
    @scroll="handleScroll"
    @auxclick.prevent
  >
    <div v-if="docState.pageCount > 0" class="viewer-content" :class="'mode-' + docState.viewMode">
      <template v-if="docState.viewMode === 'two'">
        <div v-for="(pages, row) in spreadRows" :key="`${docState.docId}-row-${row}`" class="spread-row">
          <PageCanvas
            v-for="n in pages"
            :key="`${docState.docId}-${n}`"
            :page-number="n"
            :visible="visiblePages.has(n)"
          />
        </div>
      </template>
      <template v-else>
        <PageCanvas
          v-for="n in docState.pageCount"
          v-show="docState.viewMode !== 'single' || n === docState.currentPage"
          :key="`${docState.docId}-${n}`"
          :page-number="n"
          :visible="visiblePages.has(n)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  position: relative;
  flex: 1;
  overflow: auto;
  background: var(--viewer-bg);
}

.viewer-content {
  display: flex;
  flex-direction: column;
  padding: 24px 24px 48px;
  min-height: 100%;
}

.spread-row {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  width: max-content; /* 放不下时 margin auto 归零,左缘可滚动,不会居中溢出不可达 */
  margin: 0 auto 16px;
}

.spread-row :deep(.page-wrap) {
  margin: 0; /* 覆盖 PageCanvas 的 margin: 0 auto 16px;行距由行 margin 提供 */
}

.viewer-content.mode-single {
  padding-bottom: 24px; /* 与顶部 24 对称:fitPage 恰好装下时无 24px 死滚动区 */
}

.viewer-content.mode-single :deep(.page-wrap) {
  margin-top: auto; /* 装得下时垂直居中;超出时 auto=0 顶对齐、可滚动 */
  margin-bottom: auto;
}
</style>
