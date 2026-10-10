/**
 * 渲染层日志转发:落盘只有主进程一个去处(见 src/main/lib/logger.ts),这里只做节流 + 转发。
 * 同 scope+message 在 1s 内只发一次 —— 帧级调用点(渲染看门狗)不能把 IPC 打满。
 * 隐私:data 只允许 logger.ts 白名单里的键(文件名只到 basename),不得带文档内容/完整路径。
 */
import type { LogLevel } from '@shared/types'

export type { LogLevel }

const THROTTLE_MS = 1000
const lastSent = new Map<string, number>()

export function logEvent(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
  const key = `${scope}|${message}`
  const now = Date.now()
  if (now - (lastSent.get(key) ?? 0) < THROTTLE_MS) return
  lastSent.set(key, now)
  void window.pdfAPI.invoke('log:write', { level, scope, message, data }).catch(() => undefined)
}

/** 未捕获错误也进日志:内网现场只能靠这份文件回溯(浏览器控制台用户看不到) */
export function installLogErrorHooks(): void {
  window.addEventListener('error', (event) => {
    logEvent('error', 'renderer', '未捕获错误', { error: String(event.message || event.error) })
  })
  window.addEventListener('unhandledrejection', (event) => {
    logEvent('error', 'renderer', '未处理的 Promise 拒绝', { error: String(event.reason) })
  })
}
