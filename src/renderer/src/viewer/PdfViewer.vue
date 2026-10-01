<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PageCanvas from './PageCanvas.vue'
import { docState, pinViewerPages } from '../store/document'
import { attachContainer, computeCurrentPage, fitWidth, zoomAt } from '../store/viewer'

const containerEl = ref<HTMLElement | null>(null)
const visiblePages = reactive(new Set<number>())
let observer: IntersectionObserver | null = null
let resizeObserver: ResizeObserver | null = null
let rafPending = false

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

onMounted(() => {
  attachContainer(containerEl.value)
  setupObserver()
  containerEl.value?.addEventListener('wheel', handleWheel, { passive: false })
  // 首次布局完成/窗口尺寸变化时重建观察器:否则初始 0 高度会让所有页被判为可见
  const root = containerEl.value
  if (root && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      visiblePages.clear()
      pinViewerPages(visiblePages)
      setupObserver()
    })
    resizeObserver.observe(root)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  resizeObserver?.disconnect()
  containerEl.value?.removeEventListener('wheel', handleWheel)
  attachContainer(null)
})

watch(
  () => [docState.docId, docState.pageBoxes.length] as const,
  async () => {
    visiblePages.clear()
    await nextTick()
    setupObserver()
    if (docState.docId && docState.pageBoxes.length === docState.pageCount) fitWidth()
  }
)
</script>

<template>
  <div ref="containerEl" class="viewer" @scroll="handleScroll">
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
