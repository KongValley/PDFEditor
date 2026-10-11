import { existsSync } from 'node:fs'
import { PDFDocument, StandardFonts, type PDFForm, type PDFPage } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Annotation, FormValue } from '../../src/shared/types'

/** CFF(OTF)中文字体才会复现子集崩溃;未配置或指向 TTF 时跳过(见 .github/workflows/ci.yml 的字体步骤) */
const cffPath = process.env['PDF_EDITOR_CJK_FONT'] ?? ''
const hasCffFont = /\.otf$/i.test(cffPath) && existsSync(cffPath)

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

  it('不写文字的批注为 false(便签/空文本注释/标签为空的图章/纯图形)', async () => {
    // 便签只画图标矩形,空文本注释一个字形都画不出:以前把它们算作"需要中文字体",
    // 会让只想存一个便签的文档嵌入 CJK 字体却零字形,触发 fontkit 的 CFF 子集编码崩溃
    const mod = await loadModule()
    expect(mod.needsCjkFont([rect('a')])).toBe(false)
    expect(mod.needsCjkFont([{ ...base, id: 'n', kind: 'note', page: 0, bbox: { x: 0, y: 0, w: 1, h: 1 }, text: '备注' }])).toBe(false)
    expect(mod.needsCjkFont([textAnn('t', '')])).toBe(false)
    expect(mod.needsCjkFont([textAnn('t', '   ')])).toBe(false)
    expect(
      mod.needsCjkFont([
        { ...base, id: 's', kind: 'stamp', page: 0, bbox: { x: 0, y: 0, w: 1, h: 1 }, stampKey: 'approved', label: '  ', fontSize: 14, rotate: 0 }
      ])
    ).toBe(false)
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

  it('表单值落不到任何字段上时不请求中文字体(零字形嵌入会崩 CFF 字体)', async () => {
    const mod = await loadModule()
    // 文档没有表单字段:applyFormValues 会直接跳过,字体一个字形都用不上
    const { bytes, warnings } = await mod.writeAnnotations(await samplePdf(), {
      annotations: [],
      formValues: { 不存在的字段: '中文值' },
      resolveImage: async () => undefined
    })
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(warnings.some((w) => w.includes('未找到可嵌入的中文字体'))).toBe(false)
  })

  it('表单值能落到字段上时仍会请求中文字体', async () => {
    const mod = await loadModule()
    const doc = await PDFDocument.create()
    doc.addPage([200, 100])
    doc.getForm().createTextField('姓名')
    const { warnings } = await mod.writeAnnotations(Buffer.from(await doc.save()), {
      annotations: [],
      formValues: { 姓名: '张三' },
      resolveImage: async () => undefined
    })
    expect(warnings.some((w) => w.includes('未找到可嵌入的中文字体'))).toBe(true)
  })
})

describe('willWriteFormValue:只算真会用中文字体画字的字段', () => {
  const withFormField = async (setup: (form: PDFForm, page: PDFPage) => void): Promise<Buffer> => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([300, 300])
    setup(doc.getForm(), page)
    return Buffer.from(await doc.save())
  }
  it('文本域非空字符串 → true;空字符串 → false', async () => {
    const mod = await loadModule()
    const pdf = await withFormField((form) => {
      form.createTextField('name')
    })
    const doc = await PDFDocument.load(pdf)
    expect(mod.willWriteFormValue(doc, { name: '中文值' })).toBe(true)
    expect(mod.willWriteFormValue(doc, { name: '' })).toBe(false)
  })

  it('单选组(选中值是字符串)不请求字体:外观忽略 font 只画矢量,零字形会崩 CFF 字体', async () => {
    const mod = await loadModule()
    const pdf = await withFormField((form, page) => {
      const group = form.createRadioGroup('color')
      group.addOptionToPage('On', page, { x: 20, y: 20, width: 20, height: 20 })
      group.select('On')
    })
    expect(mod.willWriteFormValue(await PDFDocument.load(pdf), { color: 'On' })).toBe(false)
  })

  it('复选框布尔值不请求字体', async () => {
    const mod = await loadModule()
    const pdf = await withFormField((form, page) => {
      form.createCheckBox('agree').addToPage(page, { x: 20, y: 60, width: 18, height: 18 })
    })
    expect(mod.willWriteFormValue(await PDFDocument.load(pdf), { agree: true })).toBe(false)
  })

  it('下拉的选中字符串会请求字体(外观用传入字体画字)', async () => {
    const mod = await loadModule()
    const pdf = await withFormField((form, page) => {
      const dropdown = form.createDropdown('city')
      dropdown.addOptions(['北京'])
      dropdown.addToPage(page, { x: 20, y: 100, width: 120, height: 18 })
    })
    expect(mod.willWriteFormValue(await PDFDocument.load(pdf), { city: '北京' })).toBe(true)
  })

  it('字段不存在或没有任何表单值 → false', async () => {
    const mod = await loadModule()
    const pdf = await withFormField(() => {})
    expect(mod.willWriteFormValue(await PDFDocument.load(pdf), { nope: 'x' })).toBe(false)
    expect(mod.willWriteFormValue(await PDFDocument.load(await samplePdf()), {})).toBe(false)
  })

  it('层级名后缀多字段歧义 → false;唯一后缀 → true', async () => {
    const mod = await loadModule()
    const ambiguous = await withFormField((form) => {
      form.createTextField('a.tel')
      form.createTextField('b.tel')
    })
    expect(mod.willWriteFormValue(await PDFDocument.load(ambiguous), { tel: '123' })).toBe(false)
    const unique = await withFormField((form) => {
      form.createTextField('x.tel')
    })
    expect(mod.willWriteFormValue(await PDFDocument.load(unique), { tel: '123' })).toBe(true)
  })
})

describe('单选组写入不请求中文字体(PDF_EDITOR_SMOKE_CJK_FONT=none)', () => {
  beforeEach(() => {
    process.env['PDF_EDITOR_SMOKE_CJK_FONT'] = 'none'
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env['PDF_EDITOR_SMOKE_CJK_FONT']
    vi.resetModules()
  })

  it('只填单选组时不请求字体(修复前会因字符串值请求,零字形必崩 CFF 字体)', async () => {
    const mod = await loadModule()
    const doc = await PDFDocument.create()
    doc.addPage([300, 300])
    const group = doc.getForm().createRadioGroup('color')
    group.addOptionToPage('On', doc.getPages()[0], { x: 20, y: 20, width: 20, height: 20 })
    group.select('On')
    const { bytes, warnings } = await mod.writeAnnotations(Buffer.from(await doc.save()), {
      annotations: [],
      formValues: { color: 'On' } as Record<string, FormValue>,
      resolveImage: async () => undefined
    })
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(warnings.some((w) => w.includes('未找到可嵌入的中文字体'))).toBe(false)
  })
})

describe.runIf(hasCffFont)('CFF 字体零字形也要能保存', () => {
  it(
    '嵌入 CFF 中文字体后一个字形都不画,保存仍有回音',
    async () => {
      const mod = await loadModule()
      const doc = await PDFDocument.load(await samplePdf())
      await mod.createAnnotContext(doc, async () => undefined, [], { skipCjkFont: false })
      const save = doc.save({ useObjectStreams: false })
      const outcome = await new Promise<Uint8Array | Error>((resolve) => {
        save.then((bytes) => resolve(bytes), (err) => resolve(err))
      })
      expect(outcome).not.toBeInstanceOf(Error)
      expect((outcome as Uint8Array).byteLength).toBeGreaterThan(0)
    },
    20_000
  )
})

describe('savePdf 保存超时兜底', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('正常保存:resolve 出文档字节', async () => {
    const mod = await loadModule()
    const doc = await PDFDocument.create()
    doc.addPage([100, 100])
    const bytes = await mod.savePdf(doc)
    expect(bytes.byteLength).toBeGreaterThan(0)
  })

  it('保存流程没有结束时,时限到达转成可读错误而不是永远挂起', async () => {
    vi.useFakeTimers()
    const mod = await loadModule()
    const doc = await PDFDocument.create()
    // 假 save:既不 resolve 也不 reject,复现字体子集异常逃进 nextTick 后的形态
    const save = new Promise<Uint8Array>(() => {})
    vi.spyOn(doc, 'save').mockReturnValue(save)
    const pending = mod.savePdf(doc)
    vi.advanceTimersByTimeAsync(mod.PDF_SAVE_TIMEOUT_MS)
    await expect(pending).rejects.toThrow(/PDF 保存超时/)
  })
})
