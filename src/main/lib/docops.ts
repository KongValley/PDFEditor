import { readFile, writeFile } from 'node:fs/promises'
import { PDFDocument, degrees } from 'pdf-lib'
import { getDocEntry, setDocBuffer, toArrayBuffer } from './pdfio'
import type { PageOp, PageOpResult } from '@shared/types'

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
      const delta = op.delta
      for (const index of op.pages) {
        if (index < 0 || index >= oldCount) continue
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
    case 'append': {
      for (const path of op.paths) {
        const bytes = await readFile(path)
        const other = await PDFDocument.load(bytes)
        const copied = await doc.copyPages(other, other.getPageIndices())
        for (const page of copied) doc.addPage(page)
      }
      break
    }
    case 'export': {
      if (op.pages.length === 0) return { ok: false, error: '未指定要导出的页面' }
      const out = await PDFDocument.create()
      const indices = op.pages.filter((i) => i >= 0 && i < oldCount)
      const copied = await out.copyPages(doc, indices)
      for (const page of copied) out.addPage(page)
      await writeFile(op.targetPath, await out.save({ useObjectStreams: false }))
      return { ok: true, savedPath: op.targetPath }
    }
  }

  const bytes = await doc.save({ useObjectStreams: false })
  const buffer = Buffer.from(bytes)
  setDocBuffer(docId, buffer, doc.getPageCount())
  return {
    ok: true,
    buffer: toArrayBuffer(buffer),
    pageCount: doc.getPageCount(),
    pageMap
  }
}
