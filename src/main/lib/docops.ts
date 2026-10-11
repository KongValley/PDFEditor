import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { stemOf } from '@shared/paths'
import { PDFDocument, degrees, rgb } from 'pdf-lib'
import { getDocEntry, pruneBufferStack, pushBufferSnapshot, setDocBuffer, toArrayBuffer, uniqueFilePath } from './pdfio'
import { getImageBuffer, readImageBuffer } from './images'
import {
  createAnnotContext,
  hexToRgb,
  mergeAcroForm,
  needsCjkFont,
  replaceOwnAnnotations,
  savePdf,
  stripAllAnnotations,
  withCjkFont
} from './pdflibwrite'
import { formatPageNumber, pageNumberNeedsCjk, watermarkPlacements } from '@shared/pagehead'
import type { Annotation, PageOp, PageOpResult, SplitTask, SplitTaskResult } from '@shared/types'

function identityMap(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i)
}

export async function applyPageOp(docId: string, op: PageOp): Promise<PageOpResult> {
  const entry = getDocEntry(docId)
  if (!entry) return { ok: false, error: '文档未打开' }
  if (entry.encrypted) return { ok: false, error: '加密文档不支持页面操作' }

  const doc = await PDFDocument.load(entry.buffer)
  const oldCount = doc.getPageCount()
  let pageMap = identityMap(oldCount)

  switch (op.kind) {
    case 'delete': {
      const targets = op.pages.filter((i) => i >= 0 && i < oldCount).sort((a, b) => a - b)
      if (targets.length === 0) return { ok: false, error: '未指定要删除的页面' }
      if (targets.length >= oldCount) return { ok: false, error: '不能删除全部页面' }
      const removed = new Set(targets)
      let next = 0
      pageMap = []
      for (let i = 0; i < oldCount; i++) pageMap[i] = removed.has(i) ? -1 : next++
      for (let i = targets.length - 1; i >= 0; i--) doc.removePage(targets[i])
      break
    }
    case 'rotate': {
      for (const index of op.pages) {
        if (index < 0 || index >= oldCount) continue
        const delta = op.deltas?.[index] ?? op.delta
        if (delta % 360 === 0) continue // 无实际旋转:不产生无效写入
        const page = doc.getPage(index)
        const current = page.getRotation().angle
        page.setRotation(degrees((((current + delta) % 360) + 360) % 360))
      }
      break
    }
    case 'insertBlank': {
      const insertAt = Math.min(Math.max(op.afterIndex + 1, 0), oldCount)
      const refIndex = Math.min(Math.max(insertAt - 1, 0), oldCount - 1)
      const refPage = oldCount > 0 ? doc.getPage(refIndex) : null
      const size = refPage ? refPage.getSize() : { width: 595.28, height: 841.89 }
      doc.insertPage(insertAt, [size.width, size.height])
      pageMap = []
      for (let i = 0; i < oldCount; i++) pageMap[i] = i < insertAt ? i : i + 1
      break
    }
    case 'move': {
      const from = Math.min(Math.max(op.from, 0), oldCount - 1)
      const to = Math.min(Math.max(op.to, 0), oldCount - 1)
      if (from === to) return { ok: false, error: '目标位置与当前位置相同' }
      const page = doc.getPage(from)
      doc.removePage(from)
      doc.insertPage(to, page)
      const order = Array.from({ length: oldCount }, (_, i) => i)
      const [moved] = order.splice(from, 1)
      order.splice(to, 0, moved)
      pageMap = []
      order.forEach((oldIdx, newIdx) => {
        pageMap[oldIdx] = newIdx
      })
      break
    }
    case 'append': {
      for (const file of op.files) {
        const bytes = await readFile(file.path)
        const other = await PDFDocument.load(bytes)
        const indices = (file.pages ?? other.getPageIndices()).filter(
          (i) => i >= 0 && i < other.getPageCount()
        )
        if (indices.length === 0) continue
        const copied = await doc.copyPages(other, indices)
        for (const page of copied) doc.addPage(page)
        // 被并文件的表单字段定义也要带过来,否则 Widget 成为孤儿
        mergeAcroForm(doc, other)
      }
      break
    }
    case 'pagenumber': {
      const targets = op.pages.length > 0 ? op.pages.filter((i) => i >= 0 && i < oldCount) : Array.from({ length: oldCount }, (_, i) => i)
      if (targets.length === 0) return { ok: false, error: '页码范围全部越界' }
      const warnings: string[] = []
      const { ctx } = await createAnnotContext(doc, async () => undefined, warnings, {
        skipCjkFont: !pageNumberNeedsCjk(op.format)
      })
      for (const warningsEntry of warnings) console.warn('[pagenumber]', warningsEntry)
      targets.forEach((index, k) => {
        const page = doc.getPage(index)
        const text = formatPageNumber(op.format, op.start + k, oldCount)
        const size = page.getSize()
        // widthOfTextAtSize 同样先做编码(WinAnsi 遇中文会抛),必须与 drawText 一起包进守卫
        withCjkFont(() => {
          const width = ctx.font.widthOfTextAtSize(text, op.fontSize)
          const x =
            op.position === 'bottom-center' || op.position === 'top-center'
              ? (size.width - width) / 2
              : size.width - op.margin - width
          const y = op.position === 'bottom-center' || op.position === 'bottom-right' ? op.margin : size.height - op.margin - op.fontSize
          page.drawText(text, { x, y, size: op.fontSize, font: ctx.font })
        })
      })
      break
    }
    case 'watermark': {
      if (op.text.trim() === '') return { ok: false, error: '水印文本不能为空' }
      const targets = op.pages.length > 0 ? op.pages.filter((i) => i >= 0 && i < oldCount) : Array.from({ length: oldCount }, (_, i) => i)
      if (targets.length === 0) return { ok: false, error: '水印范围全部越界' }
      const warnings: string[] = []
      const needCjk = /[^\x00-\x7F]/.test(op.text)
      const { ctx } = await createAnnotContext(doc, async () => undefined, warnings, { skipCjkFont: !needCjk })
      for (const warningsEntry of warnings) console.warn('[watermark]', warningsEntry)
      const { r, g, b } = hexToRgb(op.color)
      for (const index of targets) {
        const page = doc.getPage(index)
        const size = page.getSize()
        withCjkFont(() => {
          const textWidth = ctx.font.widthOfTextAtSize(op.text, op.fontSize)
          const placements = watermarkPlacements(size, { width: textWidth, height: op.fontSize * 1.2 }, op.tile)
          for (const spot of placements) {
            page.drawText(op.text, {
              x: spot.x,
              y: spot.y,
              size: op.fontSize,
              font: ctx.font,
              color: rgb(r, g, b),
              opacity: op.opacity,
              rotate: degrees(op.rotation)
            })
          }
        })
      }
      break
    }
    case 'export': {
      if (op.pages.length === 0) return { ok: false, error: '未指定要导出的页面' }
      const indices = op.pages.filter((i) => i >= 0 && i < oldCount)
      if (indices.length === 0) return { ok: false, error: '导出页码范围全部越界' }
      const out = await PDFDocument.create()
      const copied = await out.copyPages(doc, indices)
      for (const page of copied) out.addPage(page)
      const warnings: string[] = []
      if (op.includeAnnotations === false) {
        stripAllAnnotations(out)
      } else {
        // 不勾「包含注释」时 Widget 已随 /Annots 剥离,无需重建 AcroForm
        mergeAcroForm(out, doc)
        if (op.annotations && op.annotations.length > 0) {
          const { ctx } = await createAnnotContext(
            out,
            async (imgId, refPath) => getImageBuffer(imgId) ?? (await readImageBuffer(refPath)),
            warnings,
            { skipCjkFont: !needsCjkFont(op.annotations) }
          )
          // 页码映射到输出页序:未导出的页上注释自然丢弃
          await replaceOwnAnnotations(
            out,
            op.annotations,
            (page) => {
              const index = indices.indexOf(page)
              return index >= 0 ? index : null
            },
            ctx
          )
          for (const warning of warnings) console.warn('[export]', warning)
        }
      }
      await mkdir(dirname(op.targetPath), { recursive: true })
      await writeFile(op.targetPath, await savePdf(out))
      return { ok: true, savedPath: op.targetPath }
    }
  }

  const snapshotted = pushBufferSnapshot(entry)
  const bytes = await savePdf(doc)
  const buffer = Buffer.from(bytes)
  setDocBuffer(docId, buffer, doc.getPageCount())
  return {
    ok: true,
    buffer: toArrayBuffer(buffer),
    pageCount: doc.getPageCount(),
    pageMap,
    snapshotted
  }
}

/** 撤销最近一次页面操作(主进程快照栈);渲染层同步恢复注释/路径快照 */
export function undoPageOp(docId: string): PageOpResult {
  const entry = getDocEntry(docId)
  if (!entry) return { ok: false, error: '文档未打开' }
  const prev = entry.undoBuffers.pop()
  if (!prev) return { ok: false, error: '没有可撤销的页面操作' }
  entry.redoBuffers.push({ buffer: entry.buffer, pageCount: entry.pageCount })
  pruneBufferStack(entry.redoBuffers)
  setDocBuffer(docId, prev.buffer, prev.pageCount)
  return { ok: true, buffer: toArrayBuffer(prev.buffer), pageCount: prev.pageCount }
}

/** 重做页面操作 */
export function redoPageOp(docId: string): PageOpResult {
  const entry = getDocEntry(docId)
  if (!entry) return { ok: false, error: '文档未打开' }
  const next = entry.redoBuffers.pop()
  if (!next) return { ok: false, error: '没有可重做的页面操作' }
  entry.undoBuffers.push({ buffer: entry.buffer, pageCount: entry.pageCount })
  pruneBufferStack(entry.undoBuffers)
  setDocBuffer(docId, next.buffer, next.pageCount)
  return { ok: true, buffer: toArrayBuffer(next.buffer), pageCount: next.pageCount }
}

/**
 * 批量拆分:每任务独立处理,失败不中断其它任务。
 * hooks 用于进度上报与中途取消;进度按"已处理文件数 + 已输出文件数"统计 ——
 * 不预先解析一遍来算 chunk 总数,那样每个文件会被读盘 + 解析两次。
 */
export async function splitPdfTasks(
  tasks: SplitTask[],
  outputDir: string | null,
  options: { includeAnnotations?: boolean; annotations?: Annotation[] } = {},
  hooks: {
    onProgress?: (info: { processed: number; total: number; outputs: number }) => void
    isCancelled?: () => boolean
  } = {}
): Promise<SplitTaskResult[]> {
  const results: SplitTaskResult[] = []
  let processed = 0
  let outputs = 0
  let cancelled = false
  for (const task of tasks) {
    if (cancelled) break
    const entry = task.docId ? getDocEntry(task.docId) : undefined
    let bytes: Buffer
    try {
      bytes = entry?.buffer ?? (await readFile(task.path))
    } catch (err) {
      results.push({ path: task.path, ok: false, error: `无法读取文件:${(err as Error).message}` })
      processed++
      continue
    }
    let src: PDFDocument
    try {
      src = await PDFDocument.load(bytes)
    } catch {
      results.push({ path: task.path, ok: false, error: '无法解析 PDF(加密或损坏)' })
      processed++
      continue
    }
    const count = src.getPageCount()
    let chunks: number[][]
    if (task.mode === 'maxPages') {
      const start = Math.min(Math.max(task.start, 1), Math.max(count, 1))
      const end = Math.min(Math.max(task.end, start), count)
      const pages: number[] = []
      for (let p = start; p <= end; p++) pages.push(p - 1)
      const size = Math.max(1, Math.floor(task.pagesPerFile))
      chunks = []
      for (let i = 0; i < pages.length; i += size) chunks.push(pages.slice(i, i + size))
    } else {
      chunks = task.ranges
        .map((range) => range.filter((p) => p >= 0 && p < count))
        .filter((range) => range.length > 0)
    }
    if (chunks.length === 0) {
      results.push({ path: task.path, ok: false, error: '未指定要拆分的页面' })
      processed++
      continue
    }
    try {
      const destDir = outputDir ?? dirname(task.path)
      await mkdir(destDir, { recursive: true })
      const stem = stemOf(task.path) || 'document'
      const written: string[] = []
      for (const [i, chunk] of chunks.entries()) {
        if (hooks.isCancelled?.()) {
          cancelled = true
          break
        }
        const out = await PDFDocument.create()
        const copied = await out.copyPages(src, chunk)
        for (const page of copied) out.addPage(page)
        const warnings: string[] = []
        if (options.includeAnnotations === false) {
          stripAllAnnotations(out)
        } else {
          mergeAcroForm(out, src)
        }
        if (options.includeAnnotations !== false && options.annotations && options.annotations.length > 0 && task.docId) {
          // 当前文档:按模型重建自产批注(页号映射到该 chunk);其它文件保留 copyPages 携带的批注
          const { ctx } = await createAnnotContext(
            out,
            async (imgId, refPath) => getImageBuffer(imgId) ?? (await readImageBuffer(refPath)),
            warnings,
            { skipCjkFont: !needsCjkFont(options.annotations) }
          )
          await replaceOwnAnnotations(
            out,
            options.annotations,
            (page) => {
              const index = chunk.indexOf(page)
              return index >= 0 ? index : null
            },
            ctx
          )
          for (const warning of warnings) console.warn('[split]', warning)
        }
        const target = uniqueFilePath(destDir, `${stem}-${i + 1}.pdf`)
        await writeFile(target, await savePdf(out))
        written.push(target)
        outputs++
        hooks.onProgress?.({ processed: processed + 1, total: tasks.length, outputs })
      }
      if (written.length > 0) results.push({ path: task.path, ok: true, outputs: written })
    } catch (err) {
      results.push({ path: task.path, ok: false, error: `拆分失败:${(err as Error).message}` })
    }
    processed++
    if (cancelled) break
  }
  if (cancelled) console.warn('[split] 用户中途停止:已输出', outputs, '个文件')
  return results
}
