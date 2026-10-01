<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PageThumb from './PageThumb.vue'
import { docState, pinThumbPages } from '../store/document'
import { scrollToPage } from '../store/viewer'
import { deletePages, exportPages, insertBlankPage, mergePdfs, rotatePages } from '../lib/actions'

const THUMB_WIDTH = 84

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
const selectedIndexes = computed(() => selectedList.value.map((page) => page - 1))

function toggleSelect(page: number): void {
  const next = new Set(selected.value)
  if (next.has(page)) next.delete(page)
  else next.add(page)
  selected.value = next
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

async function onDelete(): Promise<void> {
  const pages = selectedIndexes.value
  if (pages.length === 0) return
  await deletePages(pages)
  clearSelection()
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

async function onExport(): Promise<void> {
  const pages = selectedIndexes.value.length > 0 ? selectedIndexes.value : [docState.currentPage - 1]
  await exportPages(pages)
}

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
      <button :disabled="selected.size === 0" title="删除选中页" @click="onDelete">删除</button>
      <button title="左旋 90°(选中页或当前页)" @click="onRotate(-90)">左旋</button>
      <button title="右旋 90°(选中页或当前页)" @click="onRotate(90)">右旋</button>
      <button title="在当前页之后插入空白页" @click="onInsertBlank">空白页</button>
      <button title="合并其他 PDF 到末尾" @click="onMerge">合并</button>
      <button :disabled="selected.size === 0" title="导出选中页为新 PDF" @click="onExport">拆分</button>
    </div>
    <div ref="containerEl" class="thumbs-scroll">
      <div class="thumbs-inner">
        <div
          v-for="item in items"
          :key="`${docState.docId}-${item.page}`"
          class="thumb"
          :class="{ current: item.page === docState.currentPage, selected: selected.has(item.page) }"
          :data-thumb="item.page"
          @click="scrollToPage(item.page)"
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
  grid-template-columns: 1fr 1fr;
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

.thumb-box {
  position: relative;
  overflow: hidden;
  background: #fff;
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
