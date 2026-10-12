import { reactive, watch } from 'vue'
import { docState } from './document'
import { showToast } from './ui'
import { scrollToPage } from './viewer'

/** 历史条数上限与"页码稳定"去抖(快速滚动/翻页合并为一条) */
const MAX_ENTRIES = 100
const SETTLE_MS = 700

export const readingState = reactive({ canBack: false, canForward: false })

/** 冒烟断言用:历史入栈计数(不参与运行逻辑,与 releasedDocIds 同例) */
export const readingWatch = { pushes: 0 }

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
  readingWatch.pushes++
  syncFlags()
}

/**
 * 打开流程进行中:此时的 `currentPage` 是暂定值(总是从 1 起),不是用户真正读到的地方。
 *
 * 必须挡住的竞态:docId 与 currentPage 都会在 `openByPath` 内、页面几何读取(大文档数秒)
 * **之前**被赋值 → docId / currentPage 两个 watcher 立刻起 700ms 的 settle 定时器 →
 * 到点后把「第 1 页」写进 recent.json;而 `maybeRestoreLastPage` 要等整个打开流程结束
 * 才去读,读到的已经是 1 → **阅读位置恢复对任何打开耗时 >700ms 的文档静默失效**,
 * 且记录被永久覆写成 1,不可逆。
 */
let opening = false

/** 打开流程开始(sidecar 恢复 + 阅读位置恢复之前) */
export function beginOpen(): void {
  opening = true
}

/** 打开流程全部结束:此时 currentPage 才是真实位置,才允许落盘 */
export function endOpen(): void {
  opening = false
  scheduleSettle()
}

/** 页码稳定 SETTLE_MS 后:记历史 + 落盘阅读位置(捕获调度时的路径/页码,换文档后写入仍指向旧文档) */
function scheduleSettle(): void {
  if (opening) return
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

/**
 * 清空前进/后退历史(关闭文档时用)。
 * 换文档时由 docId 的 watcher 顺带清理,但「关闭文档」目前零调用点,
 * 将来接上调用方时需要一条显式的复位入口 —— 否则关掉再打开同一份文档,
 * `goBack` 会把上一份文档的页码带过来。
 */
export function resetReadingHistory(): void {
  clearTimeout(settleTimer)
  stack = []
  index = -1
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
