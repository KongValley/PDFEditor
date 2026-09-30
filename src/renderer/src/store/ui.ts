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
