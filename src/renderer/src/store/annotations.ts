import { computed, reactive } from 'vue'
import type { Annotation, ImageAnnotation, ImageInfo, PageOpResult } from '@shared/types'
import { annotationBounds } from '@shared/types'
import { docState, markDirty, reloadDocument } from './document'
import { invalidateSearch } from './search'
import { showToast, ui } from './ui'

type Command =
  | { type: 'add'; ann: Annotation }
  | { type: 'remove'; ann: Annotation; index: number }
  | { type: 'update'; before: Annotation; after: Annotation }
  | { type: 'reorder'; id: string; from: number; to: number }
  | { type: 'batch'; commands: Command[] }

/** 页面操作条目:撤销/重做走主进程 buffer 快照栈,此处保存注释等渲染层现场 */
interface PageEntry {
  type: 'page'
  annotations: Annotation[]
  filePath: string | null
  pageMap: number[]
  /** 重做执行器;返回 false 表示失败(条目保留在 redoStack) */
  redo: () => Promise<boolean>
}

type HistoryEntry = Command | PageEntry

const MAX_HISTORY = 100
const MAX_PAGE_ENTRIES = 5
const PASTE_OFFSET = 12

interface AnnotationsState {
  items: Annotation[]
  /** imgId → dataUrl(用于渲染;不进 sidecar) */
  imageUrls: Record<string, string>
}

export const annotState = reactive<AnnotationsState>({
  items: [],
  imageUrls: {}
})

const undoStack = reactive<HistoryEntry[]>([])
const redoStack = reactive<HistoryEntry[]>([])

export const canUndo = computed(() => undoStack.length > 0)
export const canRedo = computed(() => redoStack.length > 0)

/** 注释剪贴板(复制/粘贴/再制,Ctrl+C/V/D) */
let clipboard: Annotation[] = []

function removeById(id: string): void {
  const index = annotState.items.findIndex((a) => a.id === id)
  if (index >= 0) annotState.items.splice(index, 1)
}

function replace(ann: Annotation): void {
  const index = annotState.items.findIndex((a) => a.id === ann.id)
  if (index >= 0) annotState.items[index] = ann
  else annotState.items.push(ann)
}

function moveItem(from: number, to: number): void {
  if (from < 0 || from >= annotState.items.length) return
  const clamped = Math.min(Math.max(to, 0), annotState.items.length - 1)
  if (clamped === from) return
  const [item] = annotState.items.splice(from, 1)
  annotState.items.splice(clamped, 0, item)
}

function applyForward(entry: Command): void {
  switch (entry.type) {
    case 'add':
      annotState.items.push(entry.ann)
      break
    case 'remove':
      removeById(entry.ann.id)
      break
    case 'update':
      replace(entry.after)
      break
    case 'reorder': {
      // 按 id 重放:栈中命令的 from/to 可能因页面迁移/层序变化而过期
      const index = annotState.items.findIndex((a) => a.id === entry.id)
      if (index >= 0) moveItem(index, entry.to)
      break
    }
    case 'batch':
      for (const child of entry.commands) applyForward(child)
      break
  }
}

function applyInverse(entry: Command): void {
  switch (entry.type) {
    case 'add':
      removeById(entry.ann.id)
      break
    case 'remove':
      // 按删除时的原位置插回(保持层级顺序)
      annotState.items.splice(Math.min(entry.index, annotState.items.length), 0, entry.ann)
      break
    case 'update':
      replace(entry.before)
      break
    case 'reorder': {
      const index = annotState.items.findIndex((a) => a.id === entry.id)
      if (index >= 0) moveItem(index, entry.from)
      break
    }
    case 'batch':
      for (let i = entry.commands.length - 1; i >= 0; i--) applyInverse(entry.commands[i])
      break
  }
}

/** 限制撤销栈:总条数 ≤100;page 条目单独 ≤5(与主进程快照栈同序淘汰最早) */
function capUndoStack(): void {
  while (undoStack.length > MAX_HISTORY) undoStack.shift()
  let pageCount = undoStack.reduce((sum, entry) => sum + (entry.type === 'page' ? 1 : 0), 0)
  while (pageCount > MAX_PAGE_ENTRIES) {
    const index = undoStack.findIndex((entry) => entry.type === 'page')
    if (index < 0) break
    undoStack.splice(index, 1)
    pageCount--
  }
}

function pushHistory(entry: HistoryEntry): void {
  undoStack.push(entry)
  capUndoStack()
  redoStack.length = 0
}

function pushCommand(cmd: Command): void {
  applyForward(cmd)
  pushHistory(cmd)
  markDirty()
}

function normalize(ann: Annotation): Annotation {
  if (ann.kind === 'ink' || ann.kind === 'arrow' || ann.kind === 'measure') {
    return { ...ann, bbox: annotationBounds(ann) }
  }
  return ann
}

export function addAnnotation(ann: Annotation): void {
  pushCommand({ type: 'add', ann: normalize(ann) })
}

export function addAnnotations(anns: Annotation[]): void {
  if (anns.length === 0) return
  pushCommand({
    type: 'batch',
    commands: anns.map((ann) => ({ type: 'add', ann: normalize(ann) }) as Command)
  })
}

export function removeAnnotation(id: string): void {
  const index = annotState.items.findIndex((a) => a.id === id)
  if (index < 0) return
  const ann = annotState.items[index]
  pushCommand({ type: 'remove', ann: { ...ann }, index })
  ui.selectedAnnotationIds = ui.selectedAnnotationIds.filter((value) => value !== id)
  pruneImageUrls()
}

/** 批量删除全部选中(单条 batch,撤销一次恢复) */
export function removeSelected(): void {
  const ids = new Set(ui.selectedAnnotationIds)
  if (ids.size === 0) return
  const commands: Command[] = []
  annotState.items.forEach((ann, index) => {
    if (ids.has(ann.id)) commands.push({ type: 'remove', ann: { ...ann }, index })
  })
  if (commands.length === 0) return
  pushCommand({ type: 'batch', commands })
  ui.selectedAnnotationIds = []
  pruneImageUrls()
}

export function updateAnnotation(id: string, patch: Partial<Annotation>): void {
  const before = annotState.items.find((a) => a.id === id)
  if (!before) return
  const after = normalize({ ...before, ...patch } as Annotation)
  pushCommand({ type: 'update', before: { ...before }, after })
}

/** 拖拽/缩放过程中的实时修改(不写历史) */
export function patchAnnotation(id: string, patch: Partial<Annotation>): void {
  const index = annotState.items.findIndex((a) => a.id === id)
  if (index < 0) return
  annotState.items[index] = normalize({ ...annotState.items[index], ...patch } as Annotation)
}

/** 将实时修改提交为一条历史命令(多条合并为 batch) */
export function commitAnnotations(befores: Annotation[]): void {
  const commands: Command[] = []
  for (const before of befores) {
    const after = annotState.items.find((a) => a.id === before.id)
    if (!after) continue
    if (JSON.stringify(after) === JSON.stringify(before)) continue
    commands.push({ type: 'update', before, after: { ...after } })
  }
  if (commands.length === 0) return
  pushHistory(commands.length === 1 ? commands[0] : { type: 'batch', commands })
  markDirty()
}

export function commitAnnotation(before: Annotation): void {
  commitAnnotations([before])
}

export async function undo(): Promise<void> {
  const entry = undoStack.pop()
  if (!entry) return
  if (entry.type !== 'page') {
    applyInverse(entry)
    redoStack.push(entry)
    markDirty()
    pruneImageUrls()
    return
  }
  await undoSinglePage(entry)
}

export async function redo(): Promise<void> {
  const entry = redoStack.pop()
  if (!entry) return
  if (entry.type !== 'page') {
    applyForward(entry)
    undoStack.push(entry)
    capUndoStack()
    markDirty()
    pruneImageUrls()
    return
  }
  await redoSinglePage(entry)
}

/**
 * 撤销页面操作:主进程换回 buffer,渲染层恢复注释/路径快照,并逆映射历史命令页号。
 * 回压条目仅限「主进程快照尚未被消费」的失败;快照已消费后(IPC 成功)的失败只提示不回压,
 * 否则两端栈会错位 —— 下一次 Ctrl+Z 会多回退一步。
 */
async function undoSinglePage(entry: PageEntry): Promise<void> {
  const docId = docState.docId
  if (!docId) {
    showToast('该页面操作已超出可撤销范围', 'error')
    return
  }
  let result: PageOpResult
  try {
    result = (await window.pdfAPI.invoke('pageops:undo', docId)) as PageOpResult
  } catch (err) {
    undoStack.push(entry)
    showToast(`撤销失败:${err instanceof Error ? err.message : String(err)}`, 'error')
    return
  }
  if (!result.ok || !result.buffer) {
    if (result.error === '没有可撤销的页面操作') {
      showToast('该页面操作已超出可撤销范围', 'error')
      return
    }
    undoStack.push(entry)
    showToast(`撤销失败:${result.error ?? '撤销失败'}`, 'error')
    return
  }

  // 以下主进程快照已消费:任何失败都不再回压,保持两侧栈配对
  try {
    await reloadDocument(result.buffer)
    invalidateSearch()
    restoreItems(entry.annotations)
    await ensureImageUrls()
    docState.filePath = entry.filePath
    remapStacks(invertMap(entry.pageMap))
    markDirty()
    redoStack.push(entry)
  } catch (err) {
    showToast(`撤销已完成但界面刷新失败,请重开文档:${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

async function redoSinglePage(entry: PageEntry): Promise<void> {
  const ok = await entry.redo().catch(() => false)
  if (!ok) {
    redoStack.push(entry)
    showToast('重做失败', 'error')
    return
  }
  undoStack.push(entry)
  capUndoStack()
}

/** 恢复注释现场(保留历史栈,区别于 resetAnnotations) */
function restoreItems(items: Annotation[]): void {
  annotState.items = items.map((ann) => ({ ...ann }))
  pruneImageUrls()
  const alive = new Set(annotState.items.map((ann) => ann.id))
  ui.selectedAnnotationIds = ui.selectedAnnotationIds.filter((id) => alive.has(id))
}

/** 页面撤销后补回缺失的图片 dataUrl(并发取回,避免逐张串行阻塞界面) */
async function ensureImageUrls(): Promise<void> {
  const missing = annotState.items.filter(
    (ann): ann is ImageAnnotation => ann.kind === 'image' && !annotState.imageUrls[ann.imgId]
  )
  const loaded = await Promise.all(
    missing.map(async (ann) => ({
      ann,
      info: (await window.pdfAPI.invoke('img:getByPath', ann.refPath)) as ImageInfo | { error: string }
    }))
  )
  for (const { ann, info } of loaded) {
    if (!('error' in info)) annotState.imageUrls[ann.imgId] = info.dataUrl
  }
}

/** pageMap 的逆映射(newIndex → oldIndex);被删除页无映射 */
function invertMap(pageMap: number[]): number[] {
  const inverted: number[] = []
  pageMap.forEach((next, old) => {
    if (next >= 0) inverted[next] = old
  })
  return inverted
}

function remapCommand(cmd: Command, map: number[]): Command | null {
  const mapPage = (ann: Annotation): Annotation | null => {
    const next = map[ann.page]
    if (next === undefined || next < 0) return null
    return { ...ann, page: next }
  }
  switch (cmd.type) {
    case 'add': {
      const ann = mapPage(cmd.ann)
      return ann ? { type: 'add', ann } : null
    }
    case 'remove': {
      const ann = mapPage(cmd.ann)
      return ann ? { type: 'remove', ann, index: cmd.index } : null
    }
    case 'update': {
      const before = mapPage(cmd.before)
      const after = mapPage(cmd.after)
      if (!before || !after) return null
      return { type: 'update', before, after }
    }
    case 'reorder':
      // 注释仍存在则保留(应用时按 id 重放);被页面迁移丢弃则一并作废
      return annotState.items.some((a) => a.id === cmd.id) ? cmd : null
    case 'batch': {
      const children: Command[] = []
      for (const child of cmd.commands) {
        const mapped = remapCommand(child, map)
        if (mapped) children.push(mapped)
      }
      return children.length > 0 ? { type: 'batch', commands: children } : null
    }
  }
}

/** 页面变化后映射两侧历史栈的命令页号(目标页消失的命令丢弃);page 条目快照不动 */
function remapStacks(map: number[]): void {
  const remap = (stack: HistoryEntry[]): void => {
    const next: HistoryEntry[] = []
    for (const entry of stack) {
      if (entry.type === 'page') {
        next.push(entry)
        continue
      }
      const mapped = remapCommand(entry, map)
      if (mapped) next.push(mapped)
    }
    stack.splice(0, stack.length, ...next)
  }
  remap(undoStack)
  remap(redoStack)
}

/* ------------------------------ 选择 ------------------------------ */

export function annotationsForPage(pageNumber: number): Annotation[] {
  return annotState.items.filter((a) => a.page === pageNumber)
}

export function primarySelectionId(): string | null {
  const ids = ui.selectedAnnotationIds
  return ids.length > 0 ? ids[ids.length - 1] : null
}

export function selectedAnnotation(): Annotation | null {
  const id = primarySelectionId()
  if (!id) return null
  return annotState.items.find((a) => a.id === id) ?? null
}

export function selectAnnotation(id: string | null): void {
  ui.selectedAnnotationIds = id ? [id] : []
}

export function toggleAnnotationSelection(id: string): void {
  const current = ui.selectedAnnotationIds
  ui.selectedAnnotationIds = current.includes(id)
    ? current.filter((value) => value !== id)
    : [...current, id]
}

/* --------------------------- 复制/粘贴/再制 --------------------------- */

function shiftClone(ann: Annotation, dx: number, dy: number): Annotation {
  const base = JSON.parse(JSON.stringify(ann)) as Annotation
  let moved: Annotation = {
    ...base,
    bbox: { ...base.bbox, x: base.bbox.x + dx, y: base.bbox.y + dy }
  }
  if (base.kind === 'ink') {
    moved = { ...base, points: base.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } as Annotation
  } else if (base.kind === 'arrow' || base.kind === 'measure') {
    moved = {
      ...base,
      from: { x: base.from.x + dx, y: base.from.y + dy },
      to: { x: base.to.x + dx, y: base.to.y + dy }
    } as Annotation
  }
  return { ...moved, id: crypto.randomUUID(), createdAt: Date.now() }
}

export function copySelection(): number {
  if (ui.selectedAnnotationIds.length === 0) return 0
  const picked = annotState.items.filter((a) => ui.selectedAnnotationIds.includes(a.id))
  if (picked.length === 0) return 0
  clipboard = JSON.parse(JSON.stringify(picked)) as Annotation[]
  return clipboard.length
}

/** 粘贴到当前页,+12pt 偏移;返回粘贴条数(空剪贴板返回 0) */
export function pasteClipboard(): number {
  if (clipboard.length === 0) return 0
  const page = Math.max(docState.currentPage - 1, 0)
  const pasted = clipboard.map((ann) => ({ ...shiftClone(ann, PASTE_OFFSET, PASTE_OFFSET), page }))
  pushCommand({
    type: 'batch',
    commands: pasted.map((ann) => ({ type: 'add', ann: normalize(ann) }) as Command)
  })
  ui.selectedAnnotationIds = pasted.map((ann) => ann.id)
  if (pasted.some((ann) => ann.kind === 'image')) void ensureImageUrls()
  return pasted.length
}

/** 再制选中项(同页 +12pt 副本) */
export function duplicateSelection(): void {
  if (ui.selectedAnnotationIds.length === 0) return
  const picked = annotState.items.filter((a) => ui.selectedAnnotationIds.includes(a.id))
  if (picked.length === 0) return
  const copies = picked.map((ann) => shiftClone(ann, PASTE_OFFSET, PASTE_OFFSET))
  pushCommand({
    type: 'batch',
    commands: copies.map((ann) => ({ type: 'add', ann: normalize(ann) }) as Command)
  })
  ui.selectedAnnotationIds = copies.map((ann) => ann.id)
  if (copies.some((ann) => ann.kind === 'image')) void ensureImageUrls()
}

/* ------------------------------ 层级 ------------------------------ */

/** 同页邻居(层级仅在本页内相邻可见,跨页 index 比较会跳过其它页的注释) */
function samePageNeighbors(id: string): { index: number; indices: number[] } | null {
  const index = annotState.items.findIndex((a) => a.id === id)
  if (index < 0) return null
  const page = annotState.items[index].page
  const indices = annotState.items.map((a, i) => ({ a, i })).filter((x) => x.a.page === page).map((x) => x.i)
  return { index, indices }
}

/** 层级按钮可用性(按同页邻居判定) */
export function annotationsZOrder(id: string): {
  canUp: boolean
  canDown: boolean
  canFront: boolean
  canBack: boolean
} {
  const found = samePageNeighbors(id)
  if (!found) return { canUp: false, canDown: false, canFront: false, canBack: false }
  const { index, indices } = found
  return {
    canUp: indices.some((i) => i > index),
    canDown: indices.some((i) => i < index),
    canFront: indices[indices.length - 1] !== index,
    canBack: indices[0] !== index
  }
}

function reorder(id: string, target: 'front' | 'back' | 'up' | 'down'): void {
  const found = samePageNeighbors(id)
  if (!found) return
  const { index, indices } = found
  let to = -1
  if (target === 'up') {
    to = indices.find((i) => i > index) ?? -1
  } else if (target === 'down') {
    const below = indices.filter((i) => i < index)
    to = below.length > 0 ? below[below.length - 1] : -1
  } else if (target === 'front') {
    to = indices[indices.length - 1]
  } else {
    to = indices[0]
  }
  if (to < 0 || to === index) return
  pushCommand({ type: 'reorder', id, from: index, to })
}

export function bringToFront(id: string): void {
  reorder(id, 'front')
}

export function sendToBack(id: string): void {
  reorder(id, 'back')
}

export function moveUp(id: string): void {
  reorder(id, 'up')
}

export function moveDown(id: string): void {
  reorder(id, 'down')
}

/* --------------------------- 图片/重置/序列化 --------------------------- */

export function setImageUrl(imgId: string, dataUrl: string): void {
  annotState.imageUrls[imgId] = dataUrl
}

/** 清理不再被任何注释引用的图片 dataUrl(低内存:大图 base64 可达数 MB) */
function pruneImageUrls(): void {
  const used = new Set<string>()
  for (const ann of annotState.items) {
    if (ann.kind === 'image') used.add(ann.imgId)
  }
  for (const imgId of Object.keys(annotState.imageUrls)) {
    if (!used.has(imgId)) delete annotState.imageUrls[imgId]
  }
}

/** 打开文档 / 恢复 sidecar 时重置(清空历史与剪贴板) */
export function resetAnnotations(items: Annotation[] = []): void {
  annotState.items = items.map((ann) => ({ ...ann }))
  undoStack.length = 0
  redoStack.length = 0
  clipboard = []
  ui.selectedAnnotationIds = []
  pruneImageUrls()
}

/** 合并等页面操作后导入新出现的批注(不写历史、不置脏;调用方负责其余状态) */
export function importAnnotations(anns: Annotation[]): void {
  let added = false
  for (const ann of anns) {
    const existing = annotState.items.find((a) => a.id === ann.id)
    if (existing) {
      // 同 id 同页 = 同一份注释被重复导入(如合并自己保存过的副本),跳过;
      // 同 id 不同页 = 副本页上的实例(提取/另存后再合并回来),重新发号保留,避免保存时被剥离
      if (existing.page === ann.page) continue
      annotState.items.push({ ...ann, id: crypto.randomUUID() })
      added = true
      continue
    }
    annotState.items.push({ ...ann })
    added = true
  }
  if (added) void ensureImageUrls()
}

/** 保存用:序列化快照 */
export function exportAnnotations(): Annotation[] {
  return JSON.parse(JSON.stringify(annotState.items)) as Annotation[]
}

/** 页面操作入统一历史:撤销走主进程 buffer 快照,此处存渲染层现场与重做执行器 */
export function pushPageHistory(entry: {
  annotations: Annotation[]
  filePath: string | null
  pageMap: number[]
  redo: () => Promise<boolean>
}): void {
  pushHistory({ type: 'page', ...entry })
}

/** 页面操作后按 pageMap 迁移注释与历史命令页号(pageMap[oldIndex] = newIndex | -1) */
export function applyPageMap(pageMap: number[]): void {
  const moved: Annotation[] = []
  for (const ann of annotState.items) {
    const next = pageMap[ann.page]
    if (next === undefined || next < 0) {
      console.warn('[annot] 丢弃越界注释', ann.id, ann.page)
      continue
    }
    moved.push({ ...ann, page: next })
  }
  annotState.items = moved
  remapStacks(pageMap)
  const alive = new Set(annotState.items.map((ann) => ann.id))
  ui.selectedAnnotationIds = ui.selectedAnnotationIds.filter((id) => alive.has(id))
}
