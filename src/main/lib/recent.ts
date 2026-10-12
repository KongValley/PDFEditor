import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWrite } from './pdfio'

interface RecentEntry {
  page: number
  at: number
}

interface RecentData {
  files: Record<string, RecentEntry>
}

const MAX_FILES = 80

function storePath(): string {
  return join(app.getPath('userData'), 'recent.json')
}

/** 读库;`retryOnEmpty` 用于「读到空/损坏时重试」的场景(见 readStoreFresh) */
async function readStoreOnce(): Promise<{ data: RecentData; empty: boolean }> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as RecentData
    if (parsed && typeof parsed.files === 'object' && parsed.files) return { data: parsed, empty: false }
    return { data: { files: {} }, empty: true }
  } catch {
    // 首次运行/文件损坏:按空库处理
    return { data: { files: {} }, empty: true }
  }
}

/**
 * 读库并在「读到的不是合法 JSON」时短暂重试一次。
 *
 * 写侧现在走 atomicWrite(tmp → rename),理论上不会再出现半截文件;
 * 但 rename 之前的旧版本、或别处(用户手工/备份工具)写坏了文件时仍可能读到空/损坏内容。
 * 写侧用 chain 串行化,**读侧没有** —— 读到空就直接返回空库,表现为「最近文件列表凭空消失」。
 * 重试一次即可覆盖极窄的竞态窗口,代价可忽略。
 */
async function readStoreFresh(): Promise<RecentData> {
  const first = await readStoreOnce()
  if (!first.empty) return first.data
  // 只有当文件确实存在时才值得重试(首次运行没有文件,重试无意义)
  try {
    await readFile(storePath())
  } catch {
    return first.data
  }
  await new Promise((resolve) => setTimeout(resolve, 30))
  const second = await readStoreOnce()
  return second.empty ? first.data : second.data
}

/** 写队列:读-改-写串行化,避免并发写互相覆盖 */
let chain: Promise<void> = Promise.resolve()

export function setRecentPage(filePath: string, page: number): Promise<void> {
  chain = chain
    .then(async () => {
      const data = await readStoreFresh()
      data.files[filePath] = { page, at: Date.now() }
      const entries = Object.entries(data.files).sort((a, b) => b[1].at - a[1].at)
      const kept: RecentData = { files: {} }
      for (const [path, entry] of entries.slice(0, MAX_FILES)) kept.files[path] = entry
      const target = storePath()
      await mkdir(dirname(target), { recursive: true })
      // 原子写:直接 writeFile 以 'w' 打开会先截断,此时读到半截 JSON 的读侧
      // 会把最近文件整条判为损坏 → 列表凭空消失。tmp → rename 保证读到的永远是完整文件。
      await atomicWrite(target, JSON.stringify(kept))
    })
    .catch((err) => {
      console.warn('[recent] 写入失败:', err)
    })
  return chain
}

export async function getRecentPage(filePath: string): Promise<number | null> {
  const entry = (await readStoreFresh()).files[filePath]
  return entry && Number.isFinite(entry.page) && entry.page > 0 ? entry.page : null
}

/** 最近打开的文件(按时间倒序;供空状态展示) */
export async function listRecentFiles(
  limit = 10
): Promise<Array<{ path: string; page: number; at: number }>> {
  const files = (await readStoreFresh()).files
  return Object.entries(files)
    .map(([path, entry]) => ({ path, page: entry.page, at: entry.at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
}
