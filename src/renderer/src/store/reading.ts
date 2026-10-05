import { reactive, watch } from 'vue'
import { docState } from './document'
import { showToast } from './ui'
import { scrollToPage } from './viewer'

/** 历史条数上限与"页码稳定"去抖(快速滚动/翻页合并为一条) */
const MAX_ENTRIES = 100
const SETTLE_MS = 700

export const readingState = reactive({ canBack: false, canForward: false })

let stack: number[] = []
let index = -1
let settleTimer: number | undefined
/** 冒烟覆盖:null = 按运行环境(生产恢复,冒烟不恢复) */
let restoreOverride: boolean | null = null
let smokeCache: boolean | null = null

/** 冒烟用:强制开启/关闭「打开时恢复上次阅读位置」 */
export function setRestoreLastPage(enabled: boolean): void {
  restoreOverride = enabled
}

function syncFlags(): void {
  readingState.canBack = index > 0
  readingState.canForward = index >= 0 && index < stack.length - 1
}

function pushEntry(page: number): void {
  if (index >= 0 && stack[index] === page) return
  stack = stack.slice(0, index + 1)
  stack.push(page)
  if (stack.length > MAX_ENTRIES) stack = stack.slice(stack.length - MAX_ENTRIES)
  index = stack.length - 1
  syncFlags()
}

/** 页码稳定 SETTLE_MS 后:记历史 + 落盘阅读位置(捕获调度时的路径/页码,换文档后写入仍指向旧文档) */
function scheduleSettle(): void {
  if (!docState.pdfDoc) return
  const path = docState.filePath
  const page = docState.currentPage
  clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => {
    if (docState.pdfDoc && docState.currentPage === page && docState.filePath === path) pushEntry(page)
    if (path && page > 0) void window.pdfAPI.invoke('app:recentSet', { path, page })
  }, SETTLE_MS)
}

export function goBack(): void {
  if (index <= 0) return
  index--
  scrollToPage(stack[index])
  syncFlags()
}

export function goForward(): void {
  if (index < 0 || index >= stack.length - 1) return
  index++
  scrollToPage(stack[index])
  syncFlags()
}

export function useReading(): void {
  watch(
    () => docState.docId,
    () => {
      stack = []
      index = -1
      syncFlags()
      scheduleSettle()
    }
  )
  watch(
    () => docState.currentPage,
    () => scheduleSettle()
  )
}

async function restoreEnabled(): Promise<boolean> {
  if (restoreOverride !== null) return restoreOverride
  if (smokeCache === null) {
    const info = (await window.pdfAPI.invoke('app:runtimeInfo')) as { smoke?: boolean }
    smokeCache = info?.smoke === true
  }
  return !smokeCache
}

/** 打开文档后恢复上次阅读位置(>1 页才跳转;冒烟默认关闭,用 setRestoreLastPage(true) 打开) */
export async function maybeRestoreLastPage(filePath: string): Promise<void> {
  try {
    if (!(await restoreEnabled())) return
    const result = (await window.pdfAPI.invoke('app:recentGet', filePath)) as { page?: number | null }
    const page = typeof result?.page === 'number' ? result.page : 0
    if (page <= 1 || docState.pageCount === 0) return
    const target = Math.min(page, docState.pageCount)
    scrollToPage(target)
    showToast(`已回到上次阅读位置(第 ${target} 页)`)
  } catch {
    // 恢复失败不影响打开流程
  }
}
