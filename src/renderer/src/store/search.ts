import { reactive } from 'vue'
import type { SearchMatch } from '../lib/textsearch'

interface SearchState {
  query: string
  results: SearchMatch[]
  current: number
  searching: boolean
}

export const searchState = reactive<SearchState>({
  query: '',
  results: [],
  current: -1,
  searching: false
})
