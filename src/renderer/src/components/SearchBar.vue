<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { docState } from '../store/document'
import { searchState } from '../store/search'
import { scrollToPage } from '../store/viewer'
import { clearSearchIndex, searchDocument } from '../lib/textsearch'
import { ui } from '../store/ui'

const inputEl = ref<HTMLInputElement | null>(null)
let debounceTimer: number | undefined

const counter = computed(() => {
  if (!searchState.query.trim()) return ''
  if (searchState.searching) return '搜索中…'
  if (searchState.results.length === 0) return '无结果'
  return `${searchState.current + 1} / ${searchState.results.length}`
})

async function runSearch(): Promise<void> {
  const query = searchState.query.trim()
  searchState.results = []
  searchState.current = -1
  if (!query) return
  searchState.searching = true
  try {
    const results = await searchDocument(query)
    searchState.results = results
    if (results.length > 0) goTo(0)
  } finally {
    searchState.searching = false
  }
}

function goTo(index: number): void {
  const total = searchState.results.length
  if (total === 0) return
  searchState.current = ((index % total) + total) % total
  const match = searchState.results[searchState.current]
  scrollToPage(match.page + 1)
}

function onInput(): void {
  clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => void runSearch(), 300)
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    if (searchState.results.length === 0) void runSearch()
    else goTo(searchState.current + (event.shiftKey ? -1 : 1))
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
    <span class="counter">{{ counter }}</span>
    <button :disabled="searchState.results.length === 0" title="上一个" @click="goTo(searchState.current - 1)">
      上一个
    </button>
    <button :disabled="searchState.results.length === 0" title="下一个" @click="goTo(searchState.current + 1)">
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
