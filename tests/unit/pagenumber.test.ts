import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it, beforeEach, vi } from 'vitest'

/**
 * 页码/水印页面操作(applyPageOp 的 pagenumber/watermark case)端到端:
 * 走真实字体路径(createAnnotContext 的 ensure-glyph guard + withCjkFont 的缺字体异常),
 * 与冒烟同一套实现。加密/撤销栈不在本探针范围。
 * 注:docops 依赖 electron(nativeImage),vitest 有 tests/stubs/electron.ts 别名;真实 nativeImage
 * 不会被触达(本探针不插入图片)。
 */
const loadModule = (): Promise<typeof import('../../src/main/lib/docops')> =>
  import('../../src/main/lib/docops')

const loadPdfio = (): Promise<typeof import('../../src/main/lib/pdfio')> => import('../../src/main/lib/pdfio')

/** 与 ipc.ts 的 guard 同义:异常转 { ok:false, error } —— 缺字体时 MissingCjkFontError 就是走它变成可读错误 */
async function runOp<T extends { ok: boolean; error?: string }>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as T
  }
}

async function seedPdf(path: string, pages = 3): Promise<void> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.getPage(0).drawText('first', { x: 50, y: 700, size: 12, font })
  doc.getPage(2).drawText('third', { x: 50, y: 700, size: 12, font })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path, await doc.save())
}

describe('页码/水印页面操作', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('中文页码写入全部页并可读回;撤销栈恢复原状', async () => {
    const { mkdirSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
    const dir = 'tmp/pn-probe'
    mkdirSync(dir, { recursive: true })
    const path = `${dir}/seed.pdf`
    rmSync(path, { force: true })
    await seedPdf(path)

    const pdfio = await loadPdfio()
    const opened = await pdfio.openDocument(path)
    expect(opened.ok).toBe(true)
    const docId = opened.docId!
    const before = (await pdfio.getDocEntry(docId)!).buffer.length

    const docops = await loadModule()
    const pn = await runOp(() =>
      docops.applyPageOp(docId, {
        kind: 'pagenumber',
        pages: [],
        format: '第 1 页 / 共 N 页',
        start: 1,
        position: 'bottom-center',
        fontSize: 12,
        margin: 24
      })
    )
    if (process.env['PDF_EDITOR_SMOKE_CJK_FONT'] === 'none') {
      // 缺中文字体必须显式失败(可读原因),不得静默丢页码
      expect(pn.ok).toBe(false)
      expect(pn.error).toContain('缺少可嵌入的中文字体')
      pdfio.releaseDocument(docId)
      return
    }
    expect(pn.ok).toBe(true)
    const entry = pdfio.getDocEntry(docId)!
    expect(entry.buffer.length).toBeGreaterThan(before + 1000) // 嵌了中文字体子集

    const undo = docops.undoPageOp(docId)
    expect(undo.ok).toBe(true)
    expect(pdfio.getDocEntry(docId)!.buffer.length).toBe(before)

    pdfio.releaseDocument(docId)
  })

  it('纯 ASCII 页码不请求中文字体(产物只增几百字节)', async () => {
    const { mkdirSync, rmSync } = await import('node:fs')
    const dir = 'tmp/pn-probe'
    mkdirSync(dir, { recursive: true })
    const path = `${dir}/seed2.pdf`
    rmSync(path, { force: true })
    await seedPdf(path)

    const pdfio = await loadPdfio()
    const opened = await pdfio.openDocument(path)
    const docId = opened.docId!
    const before = (await pdfio.getDocEntry(docId)!).buffer.length

    const docops = await loadModule()
    const pn = await docops.applyPageOp(docId, {
      kind: 'pagenumber',
      pages: [],
      format: '1 / N',
      start: 1,
      position: 'bottom-right',
      fontSize: 12,
      margin: 24
    })
    expect(pn.ok).toBe(true)
    const grown = pdfio.getDocEntry(docId)!.buffer.length - before
    expect(grown).toBeLessThan(2000) // Helvetica 走 StandardFonts,不嵌 9.75MB 中文字体

    pdfio.releaseDocument(docId)
  })

  it('中文水印写入指定页;空文本被拒绝', async () => {
    const { mkdirSync, rmSync } = await import('node:fs')
    const dir = 'tmp/pn-probe'
    mkdirSync(dir, { recursive: true })
    const path = `${dir}/seed3.pdf`
    rmSync(path, { force: true })
    await seedPdf(path)

    const pdfio = await loadPdfio()
    const opened = await pdfio.openDocument(path)
    const docId = opened.docId!
    const before = (await pdfio.getDocEntry(docId)!).buffer.length

    const docops = await loadModule()
    const empty = await docops.applyPageOp(docId, {
      kind: 'watermark',
      pages: [],
      text: '   ',
      fontSize: 48,
      opacity: 0.15,
      rotation: 45,
      tile: false,
      color: '#e03131'
    })
    expect(empty.ok).toBe(false)
    expect(empty.error).toContain('水印文本不能为空')

    const wm = await runOp(() =>
      docops.applyPageOp(docId, {
        kind: 'watermark',
        pages: [0, 2],
        text: '机密',
        fontSize: 48,
        opacity: 0.15,
        rotation: 45,
        tile: false,
        color: '#e03131'
      })
    )
    if (process.env['PDF_EDITOR_SMOKE_CJK_FONT'] === 'none') {
      // 缺中文字体必须显式失败(可读原因),不得静默丢水印
      expect(wm.ok).toBe(false)
      expect(wm.error).toContain('缺少可嵌入的中文字体')
      pdfio.releaseDocument(docId)
      return
    }
    expect(wm.ok).toBe(true)
    expect(pdfio.getDocEntry(docId)!.buffer.length).toBeGreaterThan(before + 1000)

    pdfio.releaseDocument(docId)
  })

  it('铺满水印的落点数按页面尺寸成网格', async () => {
    const { watermarkPlacements } = await import('../../src/shared/pagehead')
    const single = watermarkPlacements({ width: 595, height: 842 }, { width: 100, height: 20 }, false)
    expect(single).toHaveLength(1)
    expect(single[0]).toEqual({ x: 595 / 2, y: 842 / 2 })
    const tiled = watermarkPlacements({ width: 595, height: 842 }, { width: 100, height: 20 }, true)
    expect(tiled.length).toBeGreaterThan(4)
    for (const spot of tiled) {
      expect(spot.x).toBeGreaterThan(0)
      expect(spot.x).toBeLessThan(595)
      expect(spot.y).toBeGreaterThan(0)
      expect(spot.y).toBeLessThan(842)
    }
  })
})
