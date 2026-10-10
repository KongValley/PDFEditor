import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getLogDir, initLogger, logEvent, setLogLevel } from '../../src/main/lib/logger'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'logger-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 每行一条、可被 grep 的稳定格式 */
const LINE_RE = /^\S+ (DEBUG|INFO|WARN|ERROR) \[[a-z-]+\] .+$/

const logs = (): string[] => readdirSync(dir).filter((name) => name.endsWith('.log'))
const readAll = (): string => logs().map((name) => readFileSync(join(dir, name), 'utf8')).join('')

describe('logger', () => {
  it('写入一行一条、格式稳定', () => {
    initLogger({ dir, level: 'info' })
    logEvent('info', 'open', '打开文件', { file: 'Scan.pdf', pages: 14 })
    const lines = readFileSync(join(dir, `app-${new Date().toISOString().slice(0, 10)}.log`), 'utf8')
      .trim()
      .split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(LINE_RE)
    expect(lines[0]).toContain('INFO [open] 打开文件')
    expect(getLogDir()).toBe(dir)
  })

  it('低于当前等级的事件丢弃,debug 级放开', () => {
    initLogger({ dir, level: 'info' })
    logEvent('debug', 'pagecounts', '不该出现')
    expect(readAll()).toBe('')
    setLogLevel('debug')
    logEvent('debug', 'pagecounts', '计数', { count: 3, ms: 12 })
    expect(readAll()).toContain('DEBUG [pagecounts] 计数')
  })

  it('超过上限滚动到 .1.log,保留份数受 keep 限制', () => {
    initLogger({ dir, level: 'info', maxBytes: 300, keep: 3 })
    for (let i = 0; i < 200; i++) logEvent('info', 'open', `第 ${i} 行`, { file: 'a.pdf', ms: i })
    expect(logs().some((name) => /^app-.*\.1\.log$/.test(name))).toBe(true)
    expect(logs()).toHaveLength(3)
  })

  it('keep: 2 时最旧一份被删除', () => {
    initLogger({ dir, level: 'info', maxBytes: 300, keep: 2 })
    for (let i = 0; i < 200; i++) logEvent('info', 'open', `第 ${i} 行`, { file: 'a.pdf', ms: i })
    expect(logs()).toHaveLength(2)
    expect(logs().some((name) => /^app-.*\.2\.log$/.test(name))).toBe(false)
  })

  it("level: 'off' 时完全不写盘", () => {
    initLogger({ dir, level: 'off' })
    logEvent('error', 'open', '打开失败', { file: 'a.pdf', error: 'boom' })
    setLogLevel('off')
    logEvent('info', 'open', '打开文件')
    expect(logs()).toHaveLength(0)
  })

  it('data 只留白名单键,file 降为 basename,error 摘掉路径(隐私红线)', () => {
    initLogger({ dir, level: 'info' })
    logEvent('info', 'open', '打开文件', {
      file: 'Z:\\内网共享\\机密目录\\Scan.pdf',
      sizeMB: 12,
      text: '文档正文片段不应出现'
    })
    logEvent('error', 'open', '打开失败', {
      file: 'Z:\\内网共享\\机密目录\\Scan.pdf',
      error: "无法读取文件:ENOENT: no such file or directory, open 'Z:\\内网共享\\机密目录\\Scan.pdf'"
    })
    const text = readAll()
    expect(text).toContain('"file":"Scan.pdf"')
    expect(text).not.toContain('内网共享')
    expect(text).not.toContain('文档正文片段')
    expect(text).toContain('"sizeMB":12')
    expect(text).toContain('ENOENT')
  })
})
