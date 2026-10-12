<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
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
// shallowRef + 整集替换,而不是 reactive(Set):后者会让模板里每一次 has() 都挂响应式依赖,
// 页数多时一次可见性变化要在重算里为成千上万次 has() 记账(离线实测:add(1) → has() 1000 次)
const visiblePages = shallowRef<Set<number>>(new Set())

/** 唯一变更入口:复制后修改再整体替换(模板经 unwrap 读取,替换即触发一次重渲染),并同步 pin */
function updateVisiblePages(mutate: (next: Set<number>) => void): void {
  const next = new Set(visiblePages.value)
  mutate(next)
  visiblePages.value = next
  pinViewerPages(next)
}
/** 双页模式的行:[[1,2],[3,4],…],最后一行可为单页 */
const spreadRows = computed(() =>
  Array.from({ length: rowCount() }, (_, row) => rowPages(row).map((index) => index + 1))
)
let observer: IntersectionObserver | null = null
let resizeObserver: ResizeObserver | null = null
let rafPending = false
/** seedVisiblePages 的布局未就绪重试计数(避免持续重排时无限 rAF) */
let seedRetries = 0
/** setupObserver 的布局未就绪重试计数 —— 同样必须有上限,否则单页模式下会常驻自旋 */
let observerRetries = 0

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

/**
 * 挑一个「真正可见」的元素做布局就绪探测。
 *
 * 不能用 `querySelector('[data-page]')`:它永远返回**第一个**匹配元素(第 1 页),
 * 而单页模式下非当前页是 `v-show` 的 `display:none`(不是 v-if 卸载)→ 第 1 页高度恒为 0,
 * 于是就绪判定永远不成立。
 */
function firstVisiblePageEl(root: HTMLElement): HTMLElement | null {
  const all = root.querySelectorAll<HTMLElement>('[data-page]')
  for (const el of all) {
    if (el.getBoundingClientRect().height > 0) return el
  }
  return null
}

function setupObserver(): void {
  observer?.disconnect()
  const root = containerEl.value
  if (!root) return
  // 首次布局尚未生效时页面高度为 0,会被整批判为可见;等下一帧再建观察器。
  // 重试必须有上限:没有上限时,单页模式下第 1 页永远不可见 → 每帧无条件重排一个 rAF,
  // 形成 60fps 常驻自旋(老机器上 CPU 占用明显),且新 observer 永远建不起来、预读缓冲彻底失效。
  if (!firstVisiblePageEl(root)) {
    if (observerRetries < 5) {
      observerRetries++
      requestAnimationFrame(() => setupObserver())
    }
    return
  }
  observerRetries = 0
  // 预读余量:按实测渲染耗时决定提前铺几页(见 viewer.ts prefetchDepth)。
  // 连续/单页模式下余量取整页高 ⇒ 当前页上下各多渲染 1–2 页,滚动时直接复用已有位图;
  // 双页模式一屏 2 页,再铺 2 行会一次拉进 6 页把 worker 排满,所以维持原有的小余量。
  const depth = prefetchDepth()
  const buffer = docState.viewMode === 'two' ? 60 : Math.max(200, depth * rowHeight(Math.floor((docState.currentPage - 1) / 2)))
  observer = new IntersectionObserver(
    (entries) => {
      updateVisiblePages((next) => {
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.page)
          if (!pageNumber) continue
          if (entry.isIntersecting) next.add(pageNumber)
          else next.delete(pageNumber)
        }
      })
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
  if (!firstVisiblePageEl(root)) {
    if (seedRetries < 5) {
      seedRetries++
      requestAnimationFrame(() => seedVisiblePages())
    }
    return
  }
  seedRetries = 0
  if (docState.viewMode === 'single') {
    updateVisiblePages((next) => next.add(docState.currentPage))
    return
  }
  rebuildLayoutCache()
  const tops = docState.viewMode === 'two' ? rowTopsOf() : pageTopsOf()
  const top = root.scrollTop - 200
  const bottom = root.scrollTop + root.clientHeight + 200
  const stride = docState.viewMode === 'two' ? 2 : 1
  updateVisiblePages((next) => {
    for (let s = floorIndex(tops, top); s < tops.length; s++) {
      if (tops[s] > bottom) break
      for (let i = 0; i < stride; i++) {
        const index = s * stride + i
        if (index < docState.pageCount) next.add(index + 1)
      }
    }
  })
}

/** 清空可见页集后重建观察器并播种(尺寸/模式/文档变化后调用) */
function refreshVisiblePages(): void {
  updateVisiblePages((next) => next.clear())
  seedRetries = 0
  observerRetries = 0
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
    updateVisiblePages((next) => next.clear())
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
    updateVisiblePages((next) => {
      next.clear()
      next.add(docState.currentPage)
    })
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
