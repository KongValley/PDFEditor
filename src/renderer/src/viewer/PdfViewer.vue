<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PageCanvas from './PageCanvas.vue'
import { docReady, docState, pageDisplaySize, pinViewerPages } from '../store/document'
import {
  PAGE_GAP,
  applyPendingFit,
  attachContainer,
  computeCurrentPage,
  fitWidth,
  floorIndex,
  pageTopsOf,
  prefetchDepth,
  prefetchEpoch,
  resetFirstPaint,
  rebuildLayoutCache,
  requestInitialFit,
  rowCount,
  rowHeight,
  rowPages,
  rowTopsOf,
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
/** seedVisiblePages 的布局未就绪重试计数(避免持续重排时无限 rAF) */
let seedRetries = 0

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
    zoomAt(docState.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientY, 'wheel')
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
  // 预读余量:按实测渲染耗时决定提前铺几页(见 viewer.ts prefetchDepth)。
  // 连续/单页模式下余量取整页高 ⇒ 当前页上下各多渲染 1–2 页,滚动时直接复用已有位图;
  // 双页模式一屏 2 页,再铺 2 行会一次拉进 6 页把 worker 排满,所以维持原有的小余量。
  const depth = prefetchDepth()
  const buffer = docState.viewMode === 'two' ? 60 : Math.max(200, depth * rowHeight(Math.floor((docState.currentPage - 1) / 2)))
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
    // 双页模式一屏就是 2 页,200px 缓冲会把 6 页拉进可见集合 → 渲染队列堆积;
    // 60px 只保留一点预读余量,模式切换时 refreshVisiblePages → setupObserver 会重建。
    { root, rootMargin: `${buffer}px 0px` }
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
  // 布局未就绪(页高为 0)时几何播种会漏标页 → 该页 data-visible=0 → PageCanvas 走 clearPage
  // → 白页。与 setupObserver 同策略:下一帧重试,最多 5 次(避免持续重排时无限 rAF 循环)。
  const sample = root.querySelector<HTMLElement>('[data-page]')
  if (sample && sample.getBoundingClientRect().height === 0) {
    if (seedRetries < 5) {
      seedRetries++
      requestAnimationFrame(() => seedVisiblePages())
    }
    return
  }
  seedRetries = 0
  if (docState.viewMode === 'single') {
    visiblePages.add(docState.currentPage)
    pinViewerPages(visiblePages)
    return
  }
  rebuildLayoutCache()
  const tops = docState.viewMode === 'two' ? rowTopsOf() : pageTopsOf()
  const top = root.scrollTop - 200
  const bottom = root.scrollTop + root.clientHeight + 200
  const stride = docState.viewMode === 'two' ? 2 : 1
  for (let s = floorIndex(tops, top); s < tops.length; s++) {
    if (tops[s] > bottom) break
    for (let i = 0; i < stride; i++) {
      const index = s * stride + i
      if (index < docState.pageCount) visiblePages.add(index + 1)
    }
  }
  pinViewerPages(visiblePages)
}

/** 清空可见页集后重建观察器并播种(尺寸/模式/文档变化后调用) */
function refreshVisiblePages(): void {
  visiblePages.clear()
  pinViewerPages(visiblePages)
  seedRetries = 0
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
  // 首次布局完成/窗口尺寸变化时重新播种可见页。
  // 这里刻意不用 refreshVisiblePages:清空可见页集会让每个 PageCanvas 走 clearPage(),
  // 拖窗口大边时每个 resize 帧都全量重新光栅化(页面白闪 + 队列排不空)。
  // 保留集合,让 IntersectionObserver 在 resize 后自行重算 isIntersecting 校正。
  const root = containerEl.value
  if (root && typeof ResizeObserver !== 'undefined') {
    // 尺寸变化时除播种外,还要补做挂载时可能因宽度为 0 而失败的初始适应宽度
    resizeObserver = new ResizeObserver(() => {
      seedVisiblePages()
      applyPendingFit()
    })
    resizeObserver.observe(root)
  }
  // 组件只在几何就绪(docReady)后才挂载,所以 docId / pageBoxes 的 watcher 在挂载时
  // 已经"错过"了文档打开那一刻,不会替我们做默认缩放 —— 这里补上,否则新文档会以
  // 100% 而不是"适应宽度"打开(大纲跳转 / 页码定位的坐标也随之偏移)。
  // requestInitialFit 会在宽度就绪后由上面的 ResizeObserver 补做。
  if (docReady.value) {
    requestInitialFit()
    void nextTick(() => seedVisiblePages())
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
  async ([docId, pageCount], [prevDocId, prevPageCount]) => {
    resetFirstPaint()
    visiblePages.clear()
    pinViewerPages(visiblePages)
    // 仅当文档身份或页数变化(真换文档 / 增删页)才归零:
    // 页面移动等"原地重建"不再把视图甩回顶部(这是"闪几下"的直接来源)
    const identityChanged = docId !== prevDocId || pageCount !== prevPageCount
    await nextTick()
    if (identityChanged) {
      if (containerEl.value) containerEl.value.scrollTop = 0
      setupObserver()
      if (docState.docId && docState.pageBoxes.length === docState.pageCount) fitWidth()
      await nextTick()
    } else {
      setupObserver()
    }
    // 两种分支都重新播种可见页(内部会重建几何缓存)
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

// 实测渲染耗时变了 ⇒ 预读页数可能变(见 viewer.ts):重建观察器让余量跟上机器当前状态
watch(prefetchEpoch, async () => {
  await nextTick()
  refreshVisiblePages()
})

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
