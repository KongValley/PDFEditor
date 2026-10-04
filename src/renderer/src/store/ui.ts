import { reactive } from 'vue'
import type { StampKey } from '@shared/types'

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

interface UiState {
  tool: Tool
  stampKey: StampKey
  searchOpen: boolean
  searchQuery: string
  sideTab: 'annotations' | 'outline'
  toast: ToastMessage | null
  selectedAnnotationId: string | null
}

export const ui = reactive<UiState>({
  tool: 'select',
  stampKey: 'approved',
  searchOpen: false,
  searchQuery: '',
  sideTab: 'annotations',
  toast: null,
  selectedAnnotationId: null
})

let toastTimer: number | undefined

export function showToast(text: string, kind: 'info' | 'error' = 'info'): void {
  ui.toast = { text, kind }
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    ui.toast = null
  }, 3600)
}

export function setTool(tool: Tool): void {
  ui.tool = tool
  if (tool !== 'select') ui.selectedAnnotationId = null
}

/* --------------------------- 密码输入 --------------------------- */

interface PasswordState {
  open: boolean
  message: string
}

export const passwordState = reactive<PasswordState>({ open: false, message: '' })

let passwordResolve: ((value: string | null) => void) | null = null

export function requestPassword(message: string): Promise<string | null> {
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

export type PagesAction = 'extract' | 'delete' | 'split' | 'export'
export type ExportFormat = 'pdf' | 'png'
export type ExportMode = 'each' | 'long'

/** 对话框确认时携带的选项(export 分流用;其余 action 只有 input) */
export interface PagesRangeRequest {
  input: string
  format?: ExportFormat
  mode?: ExportMode
  direction?: 'h' | 'v'
}

export const pagesDialogState = reactive({ open: false, action: 'extract' as PagesAction })

let pagesResolve: ((value: PagesRangeRequest | null) => void) | null = null

export function requestPagesRange(action: PagesAction): Promise<PagesRangeRequest | null> {
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
