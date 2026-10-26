/**
 * PDF → 图片页 OFD 的导出作业管理(照 print.ts 的 mkdtemp/Map/清理模式)。
 *
 * 为什么按页落盘而不是在内存里攒完再写:低配机上「整份文档的位图 + 整包 ZIP」会同时驻留,
 * 逐页写临时目录后由 writeOfdFromImages 流式打包,峰值只占一页位图。
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OfdTextRun } from '@shared/types'
import { writeOfdFromImages, type OfdImagePage } from './ofd/frompdf'

interface OfdExportJob {
  dir: string
  targetPath: string
  pages: Array<OfdImagePage | null>
}

const jobs = new Map<string, OfdExportJob>()

const MAX_PAGES = 10000
const MAX_SIDE_MM = 2000
const MAX_PAGE_BYTES = 64 * 1024 * 1024
const MAX_TEXT_RUNS = 20000
const MAX_RUN_CHARS = 2000

/** 建任务:创建临时目录并登记页槽(页数由第一次 exportPage 的 index 决定不了,故先只建目录) */
export async function prepareOfdExport(targetPath: string): Promise<string> {
  const jobId = randomUUID()
  jobs.set(jobId, { dir: await mkdtemp(join(tmpdir(), 'pdf-editor-ofd-')), targetPath, pages: [] })
  return jobId
}

/** 逐页落盘:bytes = 该页 PNG 原始字节,widthMm/heightMm 由渲染层按画布像素反推 */
export async function addOfdExportPage(
  jobId: string,
  index: number,
  widthMm: number,
  heightMm: number,
  png: Uint8Array,
  texts?: OfdTextRun[]
): Promise<{ ok: boolean; error?: string }> {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: '导出任务已过期' }
  const invalid =
    !Number.isInteger(index) ||
    index < 0 ||
    index >= MAX_PAGES ||
    !Number.isFinite(widthMm) ||
    !Number.isFinite(heightMm) ||
    widthMm <= 0 ||
    heightMm <= 0 ||
    widthMm > MAX_SIDE_MM ||
    heightMm > MAX_SIDE_MM ||
    png.byteLength > MAX_PAGE_BYTES
  if (invalid) return { ok: false, error: 'OFD 导出参数无效' }
  const filePath = join(job.dir, `page-${index}.png`)
  await writeFile(filePath, png)
  job.pages[index] = { filePath, widthMm, heightMm, texts: sanitizeTextRuns(texts) }
  return { ok: true }
}

/** 文本层是不可信输入(渲染层传来):逐字段校验,坏数据丢弃而不是让整页导出失败 */
function sanitizeTextRuns(texts: OfdTextRun[] | undefined): OfdTextRun[] {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const runs: OfdTextRun[] = []
  for (const run of texts.slice(0, MAX_TEXT_RUNS)) {
    if (!run || typeof run.text !== 'string') continue
    const text = run.text
    if (text.length === 0 || text.length > MAX_RUN_CHARS) continue
    const { xMm, baselineMm, sizeMm, widthMm, ascent } = run
    if (![xMm, baselineMm, sizeMm, widthMm, ascent].every((value) => Number.isFinite(value))) continue
    if (sizeMm <= 0 || sizeMm > 1000 || widthMm < 0 || widthMm > 20000) continue
    if (Math.abs(xMm) > 20000 || Math.abs(baselineMm) > 20000) continue
    const family = typeof run.family === 'string' && run.family ? run.family.slice(0, 200) : 'sans-serif'
    runs.push({ text, xMm, baselineMm, sizeMm, widthMm, family, ascent: ascent > 0 && ascent <= 1.2 ? ascent : 0.8 })
  }
  return runs
}

/** 打包成 OFD 并清理临时目录(失败也清理,避免临时文件堆积) */
export async function commitOfdExport(
  jobId: string
): Promise<{ ok: true; savedPath: string; pages: number } | { ok: false; error: string }> {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: '导出任务已过期' }
  try {
    const pages = job.pages.filter((page): page is OfdImagePage => !!page)
    if (pages.length === 0) return { ok: false, error: '没有可导出的页面' }
    if (pages.length !== job.pages.length) return { ok: false, error: 'OFD 导出页码不连续' }
    await writeOfdFromImages(job.targetPath, pages, { creator: 'PDF 编辑器' })
    return { ok: true, savedPath: job.targetPath, pages: pages.length }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    jobs.delete(jobId)
    await rm(job.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function abortOfdExport(jobId: string): Promise<void> {
  const job = jobs.get(jobId)
  if (!job) return
  jobs.delete(jobId)
  await rm(job.dir, { recursive: true, force: true }).catch(() => undefined)
}

/** 退出时清理未完成任务(渲染层崩溃/中途退出) */
export async function cleanupOfdExportJobs(): Promise<void> {
  for (const [jobId, job] of jobs) {
    jobs.delete(jobId)
    await rm(job.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
