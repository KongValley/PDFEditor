import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRecentPage, listRecentFiles, setRecentPage } from '../../src/main/lib/recent'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recent-test-'))
  process.env['VITEST_USER_DATA'] = dir
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  delete process.env['VITEST_USER_DATA']
})

const storeFile = (): string => join(dir, 'recent.json')

describe('setRecentPage / listRecentFiles', () => {
  it('同一路径重复打开只留一条,页码取最新', async () => {
    await setRecentPage(join(dir, 'a.pdf'), 3)
    await setRecentPage(join(dir, 'a.pdf'), 7)
    const files = await listRecentFiles()
    expect(files).toHaveLength(1)
    expect(files[0].page).toBe(7)
    const raw = JSON.parse(readFileSync(storeFile(), 'utf8')) as { files: Record<string, unknown> }
    expect(Object.keys(raw.files)).toHaveLength(1)
  })

  it('多文件按时间倒序,默认最多 10 条', async () => {
    // 排序键 at 来自 Date.now()(毫秒分辨率):真实时钟下连续写会撞同一毫秒,排序结果不确定。
    // 这里只假 Date(不用假 setTimeout —— fs 写入走 microtask),每次写入后把系统时间往前拨 1s,
    // 于是时间戳严格递增,断言确定且不花真实时间。
    vi.useFakeTimers({ toFake: ['Date'] })
    let now = Date.UTC(2026, 0, 1)
    vi.setSystemTime(now)
    for (let i = 1; i <= 12; i++) {
      await setRecentPage(join(dir, `f${i}.pdf`), i)
      now += 1000
      vi.setSystemTime(now)
    }
    const files = await listRecentFiles()
    expect(files).toHaveLength(10)
    expect(files[0].path).toBe(join(dir, 'f12.pdf'))
    const times = files.map((f) => f.at)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('limit 参数生效', async () => {
    for (let i = 1; i <= 5; i++) await setRecentPage(join(dir, `f${i}.pdf`), i)
    expect(await listRecentFiles(3)).toHaveLength(3)
  })
})

describe('getRecentPage', () => {
  it('未记录过的文件返回 null', async () => {
    expect(await getRecentPage(join(dir, 'unknown.pdf'))).toBeNull()
  })

  it('页码非法(<=0)按未记录处理', async () => {
    await setRecentPage(join(dir, 'a.pdf'), 0)
    expect(await getRecentPage(join(dir, 'a.pdf'))).toBeNull()
  })

  it('正常页码原样返回', async () => {
    await setRecentPage(join(dir, 'a.pdf'), 12)
    expect(await getRecentPage(join(dir, 'a.pdf'))).toBe(12)
  })
})

describe('损坏存储降级', () => {
  it('recent.json 内容损坏时按空库处理而不是抛错', async () => {
    writeFileSync(storeFile(), '{ broken')
    expect(await listRecentFiles()).toEqual([])
  })

  it('结构不对(files 缺失)同样按空库处理', async () => {
    writeFileSync(storeFile(), JSON.stringify({ version: 1 }))
    expect(await listRecentFiles()).toEqual([])
  })
})