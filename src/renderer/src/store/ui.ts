import { reactive } from 'vue'
import type { AppendFileSpec, SplitTask, StampKey } from '@shared/types'
// 仅类型引用(store → lib 无运行时依赖,避免循环)
import type { OrientationPlanItem, OrientationPlanResult, PageOrientation } from '../lib/orientation'

export type Tool =
  | 'select'
  | 'highlight'
  | 'rect'
  | 'ellipse'
  | 'ink'
  | 'arrow'
  | 'measure'
  | 'text'
  | 'note'
  | 'image'
  | 'stamp'

export interface ToastMessage {
  text: string
  kind: 'info' | 'error'
}

/** 页面右键菜单状态(主视图与缩略图共用) */
export interface PageMenuState {
  open: boolean
  /** 1-based 页号 */
  page: number
  /** 视口坐标(clientX/clientY) */
  x: number
  y: number
}

interface UiState {
  tool: Tool
  stampKey: StampKey
  searchOpen: boolean
  aboutOpen: boolean
  sideTab: 'annotations' | 'outline'
  toast: ToastMessage | null
  /** 正在执行的长操作标签(如「拆分中 3/400」);非 null 时相关入口禁用 */
  busy: string | null
  /** 批注拖拽进行中(move 未提交):快捷键与保存入口据此早退,避免漏掉最后一帧位移 */
  dragging: boolean
  selectedAnnotationIds: string[]
  /** 缩略图栏显示状态(Ctrl+B 切换) */
  showThumbnails: boolean
  /** 右侧面板显示状态(Ctrl+Shift+B 切换) */
  showRightPanel: boolean
  pageMenu: PageMenuState
  problems: ProblemEntry[]
  problemsOpen: boolean
  pageNumberDialog: { open: boolean; preset: string; running: boolean }
  watermarkDialog: { open: boolean; preset: string; running: boolean }
}

/** 供「问题」面板展示的失败/警告记录(离线打包后没有控制台,这里就是唯一的明细入口) */
export interface ProblemEntry {
  id: string
  at: number
  title: string
  detail?: string
  retry?: () => Promise<void>
}

/** 记录一条问题;超上限丢弃最旧(保留最近 20 条) */
export function pushProblem(entry: Omit<ProblemEntry, 'id' | 'at'>): void {
  ui.problems.push({
    id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    at: Date.now(),
    ...entry
  })
  while (ui.problems.length > 20) ui.problems.shift()
}

export function clearProblems(): void {
  ui.problems = []
}

export const ui = reactive<UiState>({
  tool: 'select',
  stampKey: 'approved',
  searchOpen: false,
  aboutOpen: false,
  sideTab: 'annotations',
  toast: null,
  busy: null,
  dragging: false,
  selectedAnnotationIds: [],
  showThumbnails: true,
  showRightPanel: true,
  pageMenu: { open: false, page: 1, x: 0, y: 0 },
  problems: [],
  problemsOpen: false,
  pageNumberDialog: { open: false, preset: '', running: false },
  watermarkDialog: { open: false, preset: '', running: false }
})

let toastTimer: number | undefined

export function showToast(text: string, kind: 'info' | 'error' = 'info'): void {
  ui.toast = { text, kind }
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    ui.toast = null
  }, 3600)
}

/**
 * 长操作统一闸门:标签期间任何同类操作直接拒绝(返回 null),避免两批任务并发写同一目标。
 * 返回 null 表示“因已有操作在跑而未执行”。
 * 放在这里(而非 actions.ts)的原因:actions 与 pagexport 互相引用,闸门若在 actions,
 * pagexport 只能反向 import actions 形成循环,ESM 下初始化顺序会漏挂函数。
 */
export async function runBusy<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (ui.busy) {
    showToast('上一操作尚未完成,请稍候', 'error')
    return null
  }
  ui.busy = label
  try {
    return await fn()
  } finally {
    ui.busy = null
  }
}

export function setTool(tool: Tool): void {
  ui.tool = tool
  if (tool !== 'select') ui.selectedAnnotationIds = []
}

/* --------------------------- 画布编辑器提交钩子 --------------------------- */

let editorCommit: (() => void) | null = null

/** AnnotationLayer 打开文字/便签编辑器时注册;保存前调用以保证最后一次编辑已入模型 */
export function registerEditorCommit(fn: (() => void) | null): void {
  editorCommit = fn
}

export function commitOpenEditor(): void {
  editorCommit?.()
}

/* --------------------------- 密码输入 --------------------------- */

interface PasswordState {
  open: boolean
  message: string
}

export const passwordState = reactive<PasswordState>({ open: false, message: '' })

let passwordResolve: ((value: string | null) => void) | null = null

export function requestPassword(message: string): Promise<string | null> {
  // 单槽 resolver:旧请求被新请求覆盖前先按「取消」结算,避免上一个 Promise 永不 settle
  passwordResolve?.(null)
  passwordResolve = null
  passwordState.open = true
  passwordState.message = message
  return new Promise((resolve) => {
    passwordResolve = resolve
  })
}

export function submitPassword(value: string | null): void {
  passwordState.open = false
  passwordResolve?.(value)
  passwordResolve = null
}

/* --------------------------- 页面范围对话框 --------------------------- */

export type PagesAction = 'extract' | 'delete' | 'export' | 'print'
export type ExportFormat = 'pdf' | 'png'
export type ExportMode = 'each' | 'long'
/** 打印清晰度:标准 2×(≈144dpi)/ 高清 300dpi */
export type PrintQuality = 'standard' | 'high'

/** 对话框确认时携带的选项(export 分流用;其余 action 只有 input) */
export interface PagesRangeRequest {
  input: string
  format?: ExportFormat
  mode?: ExportMode
  direction?: 'h' | 'v'
  /** 提取/导出 PDF/PNG 时是否包含注释(默认勾选) */
  includeAnnotations?: boolean
  /** 打印清晰度(print 专用,默认 standard) */
  printQuality?: PrintQuality
}

export const pagesDialogState = reactive({ open: false, action: 'extract' as PagesAction })

let pagesResolve: ((value: PagesRangeRequest | null) => void) | null = null

export function requestPagesRange(action: PagesAction): Promise<PagesRangeRequest | null> {
  pagesResolve?.(null)
  pagesResolve = null
  pagesDialogState.action = action
  pagesDialogState.open = true
  return new Promise((resolve) => {
    pagesResolve = resolve
  })
}

export function submitPagesRange(value: PagesRangeRequest | null): void {
  pagesDialogState.open = false
  pagesResolve?.(value)
  pagesResolve = null
}

/* --------------------------- 合并对话框 --------------------------- */

export interface PdfFileEntry {
  path: string
  name: string
  pageCount: number
}

export interface MergeRow {
  kind: 'current' | 'file'
  path: string
  name: string
  pageCount: number
  start: string
  end: string
  selected: boolean
}

export interface MergeRequest {
  files: AppendFileSpec[]
  outputName: string
  outputDir: string | null
  autoOpen: boolean
}

export const mergeDialogState = reactive({
  open: false,
  rows: [] as MergeRow[],
  outputName: '',
  outputDir: null as string | null,
  autoOpen: false
})

let mergeResolve: ((value: MergeRequest | null) => void) | null = null

export function requestMergeWork(seed: {
  path: string
  name: string
  pageCount: number
  defaultName: string
}): Promise<MergeRequest | null> {
  mergeResolve?.(null)
  mergeResolve = null
  mergeDialogState.rows = [
    {
      kind: 'current',
      path: seed.path,
      name: seed.name,
      pageCount: seed.pageCount,
      start: '1',
      end: String(seed.pageCount),
      selected: false
    }
  ]
  mergeDialogState.outputName = seed.defaultName
  mergeDialogState.outputDir = null
  mergeDialogState.autoOpen = false
  mergeDialogState.open = true
  return new Promise((resolve) => {
    mergeResolve = resolve
  })
}

export function submitMergeWork(value: MergeRequest | null): void {
  mergeDialogState.open = false
  mergeResolve?.(value)
  mergeResolve = null
}

/* ---------------------- 页面方向统一对话框 ---------------------- */

export const orientationDialogState = reactive({
  open: false,
  /** 分析中(对话框已开,内容为"正在分析…") */
  scanning: false,
  /** 基准方向(多数页) */
  base: 'portrait' as PageOrientation,
  items: [] as OrientationPlanItem[],
  /** 无法判定基准方向时的说明;非空时对话框只显示该提示与关闭按钮 */
  baseError: ''
})

export function requestOrientationPlan(): void {
  orientationDialogState.open = true
  orientationDialogState.scanning = true
  orientationDialogState.items = []
  orientationDialogState.baseError = ''
}

export function submitOrientationPlan(
  result: Pick<OrientationPlanResult, 'base' | 'items' | 'baseError'>
): void {
  orientationDialogState.scanning = false
  orientationDialogState.base = result.base ?? 'portrait'
  orientationDialogState.items = result.items
  orientationDialogState.baseError = result.baseError
}

export function cancelOrientationPlan(): void {
  orientationDialogState.open = false
  orientationDialogState.scanning = false
  orientationDialogState.items = []
  orientationDialogState.baseError = ''
}

/* ---------------------- 图片转 PDF 对话框 ---------------------- */

/** 页面尺寸模式;与主进程 imagetopdf.ts 的 ImagePageMode 同一字面量(跨进程目录不可直接导入类型) */
export type ImagePageMode = 'image' | 'a4'

export interface ImagePdfItem {
  path: string
  name: string
  width: number
  height: number
}

export const imagePdfDialogState = reactive({
  open: false,
  /** 转换中(此时进度条显示,所有按钮禁用) */
  running: false,
  pageMode: 'image' as ImagePageMode,
  items: [] as ImagePdfItem[],
  done: 0,
  total: 0,
  /** 正在处理的文件名(进度条副标题) */
  current: '',
  result: null as { ok: boolean; savedPath?: string; pages?: number; error?: string; failed?: number } | null
})

export function requestImagePdf(items: ImagePdfItem[] = []): void {
  imagePdfDialogState.open = true
  imagePdfDialogState.running = false
  imagePdfDialogState.items = items
  imagePdfDialogState.done = 0
  imagePdfDialogState.total = 0
  imagePdfDialogState.current = ''
  imagePdfDialogState.result = null
}

export function cancelImagePdf(): void {
  imagePdfDialogState.open = false
  imagePdfDialogState.running = false
  imagePdfDialogState.items = []
  imagePdfDialogState.current = ''
  imagePdfDialogState.result = null
}

/* --------------------------- 拆分对话框 --------------------------- */

export type SplitMode = 'maxPages' | 'ranges'

export interface SplitRow {
  kind: 'current' | 'file'
  docId?: string
  path: string
  name: string
  pageCount: number
  mode: SplitMode
  start: string
  end: string
  pagesPerFile: string
  ranges: string
  selected: boolean
}

export interface SplitRequest {
  tasks: SplitTask[]
  outputDir: string | null
  autoOpen: boolean
  /** 拆分输出是否包含注释(默认勾选) */
  includeAnnotations: boolean
}

export const splitDialogState = reactive({
  open: false,
  rows: [] as SplitRow[],
  outputDir: null as string | null,
  autoOpen: false,
  includeAnnotations: true,
  /** 拆分执行中(对话框已关闭,由独立的运行遮罩展示进度与「停止」) */
  running: false,
  /** 主进程拆分任务 id(取消用) */
  jobId: null as string | null,
  progress: null as { processed: number; total: number; outputs: number } | null
})

let splitResolve: ((value: SplitRequest | null) => void) | null = null

export function requestSplitWork(seed: {
  docId: string
  path: string
  name: string
  pageCount: number
}): Promise<SplitRequest | null> {
  splitResolve?.(null)
  splitResolve = null
  splitDialogState.rows = [
    {
      kind: 'current',
      docId: seed.docId,
      path: seed.path,
      name: seed.name,
      pageCount: seed.pageCount,
      mode: 'maxPages',
      start: '1',
      end: String(seed.pageCount),
      pagesPerFile: '1',
      ranges: `1-${seed.pageCount}`,
      selected: true
    }
  ]
  splitDialogState.outputDir = null
  splitDialogState.autoOpen = false
  splitDialogState.includeAnnotations = true
  splitDialogState.running = false
  splitDialogState.jobId = null
  splitDialogState.progress = null
  splitDialogState.open = true
  return new Promise((resolve) => {
    splitResolve = resolve
  })
}

export function submitSplitWork(value: SplitRequest | null): void {
  splitDialogState.open = false
  splitResolve?.(value)
  splitResolve = null
}
