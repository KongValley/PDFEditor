<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { docState } from '../store/document'
import { searchGoTo, searchState, searchStep } from '../store/search'
import { clearSearchIndex, searchDocument } from '../lib/textsearch'
import { ui } from '../store/ui'

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
    if (seq !== searchSeq) return
    searchState.results = matches
    searchState.truncated = truncated
    if (matches.length > 0) void searchGoTo(0)
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
