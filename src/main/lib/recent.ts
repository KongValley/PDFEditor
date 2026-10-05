import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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

async function readStore(): Promise<RecentData> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as RecentData
    return parsed && typeof parsed.files === 'object' && parsed.files ? parsed : { files: {} }
  } catch {
    // 首次运行/文件损坏:按空库处理
    return { files: {} }
  }
}

/** 写队列:读-改-写串行化,避免并发写互相覆盖 */
let chain: Promise<void> = Promise.resolve()

export function setRecentPage(filePath: string, page: number): Promise<void> {
  chain = chain
    .then(async () => {
      const data = await readStore()
      data.files[filePath] = { page, at: Date.now() }
      const entries = Object.entries(data.files).sort((a, b) => b[1].at - a[1].at)
      const kept: RecentData = { files: {} }
      for (const [path, entry] of entries.slice(0, MAX_FILES)) kept.files[path] = entry
      const target = storePath()
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, JSON.stringify(kept), 'utf8')
    })
    .catch((err) => {
      console.warn('[recent] 写入失败:', err)
    })
  return chain
}

export async function getRecentPage(filePath: string): Promise<number | null> {
  const entry = (await readStore()).files[filePath]
  return entry && Number.isFinite(entry.page) && entry.page > 0 ? entry.page : null
}
