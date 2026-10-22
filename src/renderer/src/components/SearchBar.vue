<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { docState } from '../store/document'
import { searchGoTo, searchState, searchStep } from '../store/search'
import { clearSearchIndex, searchDocument } from '../lib/textsearch'
import { showToast, ui } from '../store/ui'

const inputEl = ref<HTMLInputElement | null>(null)
let debounceTimer: number | undefined

const counter = computed(() => {
  if (!searchState.query.trim()) return ''
  if (searchState.searching) return '搜索中…'
  if (searchState.results.length === 0) return '无结果'
  return `${searchState.current + 1} / ${searchState.results.length}${searchState.truncated ? '+' : ''}`
})

const counterTitle = computed(() => (searchState.truncated ? '已达 200 条上限,可能还有更多' : ''))

let searchSeq = 0

async function runSearch(): Promise<void> {
  const query = searchState.query.trim()
  const seq = ++searchSeq
  // seq 只防「更新的查询词」,**不防换文档**:大文档搜索要好几秒(每 16 页让出一次主线程),
  // 期间用 Ctrl+O / 拖放打开另一份文件,在飞的 searchDocument 返回后 seq 未变,
  // 会把旧文档(乃至两份文档混合)的命中写进新文档的 searchState ——
  // 表现为高亮框画在无关文字上、跳转跳到不含关键词的页。
  const docId = docState.docId
  searchState.results = []
  searchState.current = -1
  searchState.truncated = false
  if (!query) {
    searchState.searching = false
    return
  }
  searchState.searching = true
  try {
    const { matches, truncated } = await searchDocument(query)
    // 关闭搜索栏/换文档/换查询词后,在飞结果一律丢弃
    if (seq !== searchSeq || docId !== docState.docId || !ui.searchOpen) return
    searchState.results = matches
    searchState.truncated = truncated
    if (matches.length > 0) void searchGoTo(0)
  } catch (err) {
    if (seq === searchSeq && ui.searchOpen) {
      searchState.searching = false
      showToast(`搜索失败:${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  } finally {
    if (seq === searchSeq) searchState.searching = false
  }
}

function onInput(): void {
  clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => void runSearch(), 300)
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    if (searchState.results.length === 0) void runSearch()
    else searchStep(event.shiftKey ? -1 : 1)
  } else if (event.key === 'Escape') {
    close()
  }
}

function close(): void {
  searchSeq++
  searchState.searching = false
  ui.searchOpen = false
}

watch(
  () => ui.searchOpen,
  async (open) => {
    if (open) {
      await nextTick()
      inputEl.value?.focus()
      inputEl.value?.select()
    } else {
      searchSeq++
      searchState.searching = false
      searchState.results = []
      searchState.current = -1
      searchState.truncated = false
      searchState.query = ''
    }
  }
)

watch(
  () => docState.docId,
  () => {
    clearSearchIndex()
    searchState.results = []
    searchState.current = -1
    searchState.truncated = false
    searchState.query = ''
  }
)
</script>

<template>
  <div v-if="ui.searchOpen" class="search-bar">
    <input
      ref="inputEl"
      v-model="searchState.query"
      class="search-input"
      type="text"
      placeholder="搜索文本,回车跳转"
      @input="onInput"
      @keydown="onKeyDown"
    />
    <span class="counter" :title="counterTitle">{{ counter }}</span>
    <button :disabled="searchState.results.length === 0" title="上一个 (Shift+F3)" @click="searchStep(-1)">
      上一个
    </button>
    <button :disabled="searchState.results.length === 0" title="下一个 (F3)" @click="searchStep(1)">
      下一个
    </button>
    <button @click="close">关闭</button>
  </div>
</template>

<style scoped>
.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--panel-border);
  flex: none;
}

.search-input {
  width: 260px;
}

.counter {
  min-width: 72px;
  color: var(--toolbar-fg-dim);
}
</style>
