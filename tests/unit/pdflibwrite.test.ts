import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Annotation } from '../../src/shared/types'

/**
 * 本文件在「缺中文字体」用例里必须动态 import:该模块在首次加载时缓存字体字节,
 * 而钩子由环境变量在导入之后才生效 —— vi.resetModules() + 动态 import 才能拿到
 * 读得到新环境变量的模块实例(静态 import 拿到的是同一个已缓存实例)。
 */
const loadModule = (): Promise<typeof import('../../src/main/lib/pdflibwrite')> =>
  import('../../src/main/lib/pdflibwrite')

const base = { id: '', createdAt: 0, opacity: 1, color: '#212529' }

const rect = (id: string, page = 0): Annotation => ({
  ...base,
  id,
  kind: 'rect',
  page,
  bbox: { x: 50, y: 700, w: 100, h: 60 },
  thickness: 2
})

const textAnn = (id: string, content: string): Annotation => ({
  ...base,
  id,
  kind: 'text',
  page: 0,
  bbox: { x: 50, y: 600, w: 200, h: 40 },
  text: content,
  fontSize: 14,
  rotate: 0
})

async function samplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (const title of ['第一页', '第二页']) {
    const page = doc.addPage([595, 842])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText(title.length > 0 ? 'Sample' : title, { x: 40, y: 780, size: 12, font })
  }
  return Buffer.from(await doc.save())
}

describe('needsCjkFont', () => {
  it('会写出文字的批注为 true', async () => {
    const mod = await loadModule()
    expect(mod.needsCjkFont([rect('a'), textAnn('b', '中文')])).toBe(true)
    expect(mod.needsCjkFont([{ ...base, id: 's', kind: 'stamp', page: 0, bbox: { x: 0, y: 0, w: 1, h: 1 }, stampKey: 'approved', label: '已批准', fontSize: 14, rotate: 0 }])).toBe(true)
    expect(
      mod.needsCjkFont([
        { ...base, id: 'm', kind: 'measure', page: 0, bbox: { x: 0, y: 0, w: 1, h: 1 }, from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, unit: 'mm', thickness: 1 }
      ])
    ).toBe(true)
  })

  it('不写文字的批注为 false(便签/空文本注释/纯图形)', async () => {
    // 便签只画图标矩形,空文本注释一个字形都画不出:以前把它们算作"需要中文字体",
    // 会让只想存一个便签的文档嵌入 CJK 字体却零字形,触发 fontkit 的 CFF 子集编码崩溃
    const mod = await loadModule()
    expect(mod.needsCjkFont([rect('a')])).toBe(false)
    expect(mod.needsCjkFont([{ ...base, id: 'n', kind: 'note', page: 0, bbox: { x: 0, y: 0, w: 1, h: 1 }, text: '备注' }])).toBe(false)
    expect(mod.needsCjkFont([textAnn('t', '')])).toBe(false)
    expect(mod.needsCjkFont([textAnn('t', '   ')])).toBe(false)
  })
})

// 内容用纯 ASCII:CI 的 windows-latest runner 没有 SimHei,中文会走缺字体分支
describe('批注写入往返', () => {
  const resolveImage = async (): Promise<Buffer | undefined> => undefined

  it('写入后能原样读回 kind/page/id', async () => {
    const mod = await loadModule()
    const input = [rect('r1'), rect('r2', 1), textAnn('t1', 'annotation text')]
    const { bytes } = await mod.writeAnnotations(await samplePdf(), {
      annotations: input,
      formValues: {},
      resolveImage
    })
    const read = mod.extractEditorAnnotations(await PDFDocument.load(bytes))
    expect(read.map((a) => `${a.id}@${a.page}:${a.kind}`).sort()).toEqual(input.map((a) => `${a.id}@${a.page}:${a.kind}`).sort())
  })

  it('空文本注释:保存不失败,注释仍能读回(无 /AP)', async () => {
    // 空文本画不出任何内容,临时页没有 Contents —— 以前 pdf-lib 会在 save() 里抛
    // "Can't embed page with missing Contents",让整次保存失败
    const mod = await loadModule()
    const { bytes, warnings } = await mod.writeAnnotations(await samplePdf(), {
      annotations: [textAnn('t1', '')],
      formValues: {},
      resolveImage
    })
    expect(warnings).toEqual([])
    const read = mod.extractEditorAnnotations(await PDFDocument.load(bytes))
    expect(read.map((a) => a.id)).toEqual(['t1'])
  })

  it('同一份输入重复写入:输出稳定(条数与体积)', async () => {
    const mod = await loadModule()
    // 注意:应用每次保存都从「打开时的原始 buffer」重建(entry.buffer 保存后不更新),
    // 因此这里比的是同一输入的两次输出,而不是链式保存(链式会把上一次的嵌入字体也带进去)
    const input = await samplePdf()
    const first = await mod.writeAnnotations(input, {
      annotations: [rect('r1'), textAnn('t1', 'annotation text')],
      formValues: {},
      resolveImage
    })
    const second = await mod.writeAnnotations(input, {
      annotations: [rect('r1'), textAnn('t1', 'annotation text')],
      formValues: {},
      resolveImage
    })
    expect(mod.extractEditorAnnotations(await PDFDocument.load(second.bytes))).toHaveLength(2)
    expect(Math.abs(second.bytes.byteLength - first.bytes.byteLength) / first.bytes.byteLength).toBeLessThan(0.05)
  })

  it('删掉一条再保存:消失的是那一条', async () => {
    const mod = await loadModule()
    const first = await mod.writeAnnotations(await samplePdf(), {
      annotations: [rect('r1'), rect('r2')],
      formValues: {},
      resolveImage
    })
    const second = await mod.writeAnnotations(first.bytes, {
      annotations: [rect('r1')],
      formValues: {},
      resolveImage
    })
    const read = mod.extractEditorAnnotations(await PDFDocument.load(second.bytes))
    expect(read.map((a) => a.id)).toEqual(['r1'])
  })

  it('stripAllAnnotations 后页面不再带 /Annots', async () => {
    const mod = await loadModule()
    const { bytes } = await mod.writeAnnotations(await samplePdf(), {
      annotations: [rect('r1')],
      formValues: {},
      resolveImage
    })
    const doc = await PDFDocument.load(bytes)
    mod.stripAllAnnotations(doc)
    const saved = await doc.save()
    for (const page of (await PDFDocument.load(saved)).getPages()) {
      expect(page.node.Annots()).toBeUndefined()
    }
  })
})

describe('缺中文字体(PDF_EDITOR_SMOKE_CJK_FONT=none)', () => {
  beforeEach(() => {
    process.env['PDF_EDITOR_SMOKE_CJK_FONT'] = 'none'
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env['PDF_EDITOR_SMOKE_CJK_FONT']
    vi.resetModules()
  })

  it('找不到任何字体候选', async () => {
    const mod = await loadModule()
    expect(mod.findCjkFontFile()).toBeNull()
  })

  it('写中文时以可读原因拒绝,而不是 pdf-lib 的编码异常', async () => {
    const mod = await loadModule()
    await expect(
      mod.writeAnnotations(await samplePdf(), {
        annotations: [textAnn('t1', '中文批注')],
        formValues: {},
        resolveImage: async () => undefined
      })
    ).rejects.toThrow(/缺少可嵌入的中文字体/)
  })

  it('纯 ASCII 文字批注不受牵连', async () => {
    const mod = await loadModule()
    const { bytes, warnings } = await mod.writeAnnotations(await samplePdf(), {
      annotations: [textAnn('t1', 'ASCII only')],
      formValues: {},
      resolveImage: async () => undefined
    })
    expect(bytes.byteLength).toBeGreaterThan(0)
    // 图形/ASCII 批注能写成功,但缺字体的事实仍以 warning 形式告知
    expect(warnings.some((w) => w.includes('未找到可嵌入的中文字体'))).toBe(true)
    expect(mod.extractEditorAnnotations(await PDFDocument.load(bytes))).toHaveLength(1)
  })
})