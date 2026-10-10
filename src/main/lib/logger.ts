/**
 * 本机运行日志:使用记录 + 排障(内网环境用户看不到控制台,只能靠这份文件回溯)。
 * 一行一条,格式固定便于 grep:
 *   2026-10-10T10:00:00.123Z INFO [open] 打开文件 {"file":"Scan.pdf","pages":14}
 *
 * 隐私红线(必须遵守,写在代码里而不是注释里):
 *  - 不记录文档内容、批注文字、表单值、密码;
 *  - 不记录完整路径:data.file 一律只取 basename,其余键走白名单,未列入的键直接丢弃。
 *
 * 纯 Node 实现(不 import electron),便于单测直接跑;日志目录由调用方注入。
 */
import { appendFileSync, existsSync, mkdirSync, rmSync, renameSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { LogLevel } from '@shared/types'

export interface LoggerOptions {
  dir: string
  /** 环境变量原文也可直接传:只认 debug/info/warn/error/off,其余(含拼错)按 info */
  level?: string
  /** 单个文件字节上限,默认 1MB */
  maxBytes?: number
  /** 保留份数(含当前),默认 3 */
  keep?: number
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** data 键白名单:只有这些键会被写进日志(未列入的键静默丢弃) */
const ALLOWED_KEYS: Record<string, true> = {
  op: true,
  file: true,
  sizeMB: true,
  pages: true,
  mode: true,
  encrypted: true,
  ms: true,
  ok: true,
  error: true,
  count: true,
  failed: true,
  delta: true,
  confidence: true,
  candidates: true,
  applied: true,
  depth: true,
  avgMs: true,
  attempt: true,
  version: true,
  arch: true,
  electron: true,
  lowMem: true
}

let logDir = ''
let currentLevel: LogLevel | 'off' = 'info'
let maxBytes = 1024 * 1024
let keepCount = 3
/** 写入失败(磁盘满/权限)后本会话不再尝试,只报一次错 */
let ioFailed = false

/** 只认四个合法值(off 额外允许),其余按 info:拼错的环境变量不该让日志静默消失 */
function parseLevel(value: string | undefined): LogLevel | 'off' {
  return value === 'debug' || value === 'warn' || value === 'error' || value === 'off' ? value : 'info'
}

/** 指向日志目录并定级;目录建不出来时降级为不写(不让日志拖垮应用启动) */
export function initLogger(options: LoggerOptions): void {
  logDir = options.dir
  currentLevel = parseLevel(options.level)
  maxBytes = options.maxBytes ?? 1024 * 1024
  keepCount = options.keep ?? 3
  ioFailed = false
  try {
    mkdirSync(logDir, { recursive: true })
  } catch (err) {
    ioFailed = true
    console.error('[logger] 日志目录不可用,本次会话不写日志:', err)
  }
}

export function setLogLevel(level?: string): void {
  currentLevel = parseLevel(level)
}

export function getLogLevel(): LogLevel | 'off' {
  return currentLevel
}

export function getLogDir(): string {
  return logDir
}

function filePathFor(date: string, index: number): string {
  return index === 0 ? join(logDir, `app-${date}.log`) : join(logDir, `app-${date}.${index}.log`)
}

/** 超过上限就把当前文件后移一位,腾出新的当前文件;最旧的直接删掉 */
function rotateIfNeeded(path: string, date: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < maxBytes) return
  } catch {
    return
  }
  rmSync(filePathFor(date, keepCount - 1), { force: true })
  for (let index = keepCount - 2; index >= 0; index--) {
    const from = filePathFor(date, index)
    if (!existsSync(from)) continue
    try {
      renameSync(from, filePathFor(date, index + 1))
    } catch {
      return
    }
  }
}

/**
 * error 是唯一的自由文本字段:系统错误(ENOENT/EACCES)会把完整路径塞进消息里,这里统一摘掉。
 * 只对 error 生效;file 走 basename,其余键都是白名单内的枚举/数值。
 */
function stripPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s"',;)]*/g, '<path>')
    .replace(/\\\\[^\s"',;)]+/g, '<path>')
    .replace(/(^|\s)(?:\/[\w.-]+){2,}/g, '$1<path>')
}

/** 只保留白名单键;file 一律降为 basename,error 摘掉路径,避免把内网共享盘路径写进日志 */
function sanitize(data?: Record<string, unknown>): Record<string, unknown> | null {
  if (!data) return null
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_KEYS[key] || value === undefined || value === null) continue
    if (key === 'file' && typeof value === 'string') {
      clean[key] = basename(value)
      continue
    }
    clean[key] = key === 'error' ? stripPaths(String(value)) : value
  }
  return Object.keys(clean).length > 0 ? clean : null
}

/** 写一条日志(低于当前等级的直接丢弃;level 为 off 时完全不写盘) */
export function logEvent(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
  if (!logDir || ioFailed || currentLevel === 'off') return
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return
  const payload = sanitize(data)
  const date = new Date().toISOString().slice(0, 10)
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}${
    payload ? ` ${JSON.stringify(payload)}` : ''
  }\n`
  const path = filePathFor(date, 0)
  try {
    rotateIfNeeded(path, date)
    appendFileSync(path, line, 'utf8')
  } catch (err) {
    ioFailed = true
    console.error('[logger] 日志写入失败,本次会话不再写日志:', err)
  }
}
