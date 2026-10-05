<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PageCanvas from './PageCanvas.vue'
import { docState, pageDisplaySize, pinViewerPages } from '../store/document'
import { PAGE_GAP, attachContainer, computeCurrentPage, fitWidth, zoomAt } from '../store/viewer'
import { isTypingTarget } from '../lib/keymap'

const containerEl = ref<HTMLElement | null>(null)
const visiblePages = reactive(new Set<number>())
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
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  zoomAt(docState.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientY)
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
  const top = root.scrollTop
  const bottom = top + root.clientHeight
  let acc = 0
  for (let i = 0; i < docState.pageCount; i++) {
    const height = pageDisplaySize(i).h + PAGE_GAP
    if (acc + height >= top - 200 && acc <= bottom + 200) visiblePages.add(i + 1)
    acc += height
  }
  pinViewerPages(visiblePages)
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
    resizeObserver = new ResizeObserver(() => {
      visiblePages.clear()
      pinViewerPages(visiblePages)
      setupObserver()
      seedVisiblePages()
    })
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
</script>

<template>
  <div
    ref="containerEl"
    class="viewer"
    :style="{ cursor: panning ? 'grabbing' : spaceHeld ? 'grab' : '' }"
    @scroll="handleScroll"
    @auxclick.prevent
  >
    <div v-if="docState.pageCount > 0" class="viewer-content">
      <PageCanvas
        v-for="n in docState.pageCount"
        :key="`${docState.docId}-${n}`"
        :page-number="n"
        :visible="visiblePages.has(n)"
      />
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
</style>
