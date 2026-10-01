import { computed, reactive } from 'vue'
import type { Annotation } from '@shared/types'
import { annotationBounds } from '@shared/types'
import { ui } from './ui'

type Command =
  | { type: 'add'; ann: Annotation }
  | { type: 'remove'; ann: Annotation }
  | { type: 'update'; before: Annotation; after: Annotation }
  | { type: 'batch'; commands: Command[] }

const MAX_HISTORY = 100

interface AnnotationsState {
  items: Annotation[]
  /** imgId → dataUrl(用于渲染;不进 sidecar) */
  imageUrls: Record<string, string>
}

export const annotState = reactive<AnnotationsState>({
  items: [],
  imageUrls: {}
})

const undoStack = reactive<Command[]>([])
const redoStack = reactive<Command[]>([])

export const canUndo = computed(() => undoStack.length > 0)
export const canRedo = computed(() => redoStack.length > 0)

function removeById(id: string): void {
  const index = annotState.items.findIndex((a) => a.id === id)
  if (index >= 0) annotState.items.splice(index, 1)
}

function replace(ann: Annotation): void {
  const index = annotState.items.findIndex((a) => a.id === ann.id)
  if (index >= 0) annotState.items[index] = ann
  else annotState.items.push(ann)
}

function applyForward(cmd: Command): void {
  switch (cmd.type) {
    case 'add':
      annotState.items.push(cmd.ann)
      break
    case 'remove':
      removeById(cmd.ann.id)
      break
    case 'update':
      replace(cmd.after)
      break
    case 'batch':
      for (const child of cmd.commands) applyForward(child)
      break
  }
}

function applyInverse(cmd: Command): void {
  switch (cmd.type) {
    case 'add':
      removeById(cmd.ann.id)
      break
    case 'remove':
      annotState.items.push(cmd.ann)
      break
    case 'update':
      replace(cmd.before)
      break
    case 'batch':
      for (let i = cmd.commands.length - 1; i >= 0; i--) applyInverse(cmd.commands[i])
      break
  }
}

function pushHistory(cmd: Command): void {
  undoStack.push(cmd)
  if (undoStack.length > MAX_HISTORY) undoStack.shift()
  redoStack.length = 0
}

function pushCommand(cmd: Command): void {
  applyForward(cmd)
  pushHistory(cmd)
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
  const ann = annotState.items.find((a) => a.id === id)
  if (!ann) return
  pushCommand({ type: 'remove', ann: { ...ann } })
  if (ui.selectedAnnotationId === id) ui.selectedAnnotationId = null
  pruneImageUrls()
}

export function removeSelected(): void {
  const id = ui.selectedAnnotationId
  if (id) removeAnnotation(id)
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

/** 将实时修改提交为一条历史命令 */
export function commitAnnotation(before: Annotation): void {
  const after = annotState.items.find((a) => a.id === before.id)
  if (!after) return
  if (JSON.stringify(after) === JSON.stringify(before)) return
  pushHistory({ type: 'update', before, after: { ...after } })
}

export function undo(): void {
  const cmd = undoStack.pop()
  if (!cmd) return
  applyInverse(cmd)
  redoStack.push(cmd)
  pruneImageUrls()
}

export function redo(): void {
  const cmd = redoStack.pop()
  if (!cmd) return
  applyForward(cmd)
  undoStack.push(cmd)
  pruneImageUrls()
}

export function annotationsForPage(pageNumber: number): Annotation[] {
  return annotState.items.filter((a) => a.page === pageNumber)
}

export function selectedAnnotation(): Annotation | null {
  return annotState.items.find((a) => a.id === ui.selectedAnnotationId) ?? null
}

export function selectAnnotation(id: string | null): void {
  ui.selectedAnnotationId = id
}

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

/** 打开文档 / 恢复 sidecar 时重置(清空历史) */
export function resetAnnotations(items: Annotation[] = []): void {
  annotState.items = items.map((ann) => ({ ...ann }))
  undoStack.length = 0
  redoStack.length = 0
  ui.selectedAnnotationId = null
  pruneImageUrls()
}

/** 保存用:序列化快照 */
export function exportAnnotations(): Annotation[] {
  return JSON.parse(JSON.stringify(annotState.items)) as Annotation[]
}

/** 页面操作后按 pageMap 迁移注释(pageMap[oldIndex] = newIndex | -1) */
export function applyPageMap(pageMap: number[]): void {
  const moved: Annotation[] = []
  for (const ann of annotState.items) {
    const next = pageMap[ann.page]
    if (next === undefined || next < 0) continue
    moved.push({ ...ann, page: next })
  }
  annotState.items = moved
  undoStack.length = 0
  redoStack.length = 0
  ui.selectedAnnotationId = null
}
