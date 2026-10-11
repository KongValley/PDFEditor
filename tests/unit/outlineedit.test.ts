import { PDFDocument, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { applyOutlineEdit } from '../../src/main/lib/outlineedit'

/**
 * 书签编辑的低层字典手术验证(纯 pdf-lib,不碰 electron):
 * 手工搭 /Outlines 树 → add/rename/remove → 重新 load 后沿链断言标题、顺序、/Count。
 */

const FIRST = PDFName.of('First')
const LAST = PDFName.of('Last')
const NEXT = PDFName.of('Next')
const PREV = PDFName.of('Prev')
const PARENT = PDFName.of('Parent')
const COUNT = PDFName.of('Count')
const TITLE = PDFName.of('Title')
const OUTLINES = PDFName.of('Outlines')

/** 造 3 页文档 + 两级大纲:top1(带 child1)、top2 */
async function docWithOutline() {
  const doc = await PDFDocument.create()
  for (let i = 0; i < 3; i++) doc.addPage([595, 842])
  const child1 = PDFDict.withContext(doc.context)
  child1.set(TITLE, PDFHexString.fromText('子书签'))
  // /Dest 由 outlineedit 写入;夹具只搭结构,不写 dest
  const child1Ref = doc.context.register(child1)
  // Parent 指向 top1(在 top1 注册后设置)
  const top1 = PDFDict.withContext(doc.context)
  top1.set(TITLE, PDFHexString.fromText('第一个'))
  top1.set(COUNT, PDFNumber.of(2))
  const top1Ref = doc.context.register(top1)
  child1.set(PARENT, top1Ref)
  top1.set(FIRST, child1Ref)
  top1.set(LAST, child1Ref)
  const top2 = PDFDict.withContext(doc.context)
  top2.set(TITLE, PDFHexString.fromText('第二个'))
  const top2Ref = doc.context.register(top2)
  const outlines = PDFDict.withContext(doc.context)
  outlines.set(PDFName.of('Type'), OUTLINES)
  outlines.set(COUNT, PDFNumber.of(2))
  outlines.set(FIRST, top1Ref)
  outlines.set(LAST, top2Ref)
  const outlinesRef = doc.context.register(outlines)
  doc.catalog.set(OUTLINES, outlinesRef)
  top1.set(PARENT, outlinesRef)
  top2.set(PARENT, outlinesRef)
  top1.set(NEXT, top2Ref)
  top2.set(PREV, top1Ref)
  return { doc, outlines }
}


/** 沿 /First→/Next 取顶层第 n 个节点字典(容器),供子链断言用 */
function siblingDict(doc: PDFDocument, outlines: PDFDict, index: number): PDFDict | undefined {
  const refOfValue = (dict: PDFDict, key: PDFName): PDFRef | undefined => {
    const raw = dict.get(key)
    return raw instanceof PDFRef ? raw : undefined
  }
  let ref = refOfValue(outlines, FIRST)
  for (let i = 0; i < index && ref; i++) {
    const node = doc.context.lookup(ref)
    ref = node instanceof PDFDict ? refOfValue(node, NEXT) : undefined
  }
  if (!ref) return undefined
  const target = doc.context.lookup(ref)
  return target instanceof PDFDict ? target : undefined
}
/** 沿 /First→/Next 读出 (标题, /Count, 首子 ref) 列表;lookupMaybe 匹配解引用后的对象,
 * 取 ref 本体必须 get + instanceof(与 outlineedit 实现同一约定) */
function readSiblings(doc: PDFDocument, holder: PDFDict): Array<{ title: string; count: number | null; first: PDFRef | null }> {
  const out: Array<{ title: string; count: number | null; first: PDFRef | null }> = []
  const refOfValue = (dict: PDFDict, key: PDFName): PDFRef | undefined => {
    const raw = dict.get(key)
    return raw instanceof PDFRef ? raw : undefined
  }
  let ref = refOfValue(holder, FIRST)
  while (ref) {
    const node = doc.context.lookup(ref)
    if (!(node instanceof PDFDict)) break
    const title = node.lookupMaybe(TITLE, PDFHexString)?.decodeText() ?? ''
    const count = node.lookupMaybe(COUNT, PDFNumber)?.asNumber() ?? null
    const first = refOfValue(node, FIRST) ?? null
    out.push({ title, count, first })
    ref = refOfValue(node, NEXT)
  }
  return out
}

describe('outlineedit:/Outlines 低层手术', () => {
  it('rename 覆写指定条目标题', async () => {
    const { doc, outlines } = await docWithOutline()
    applyOutlineEdit(doc, { kind: 'rename', path: [1], title: '改过的' })
    const tops = readSiblings(doc, outlines)
    expect(tops.map((t) => t.title)).toEqual(['第一个', '改过的'])
  })

  it('add 顶层书签:挂到链尾,/Count+1', async () => {
    const { doc, outlines } = await docWithOutline()
    applyOutlineEdit(doc, { kind: 'add', parentPath: [], page: 2, title: '新的顶层' })
    const tops = readSiblings(doc, outlines)
    expect(tops.map((t) => t.title)).toEqual(['第一个', '第二个', '新的顶层'])
    expect(outlines.lookupMaybe(COUNT, PDFNumber)?.asNumber()).toBe(3)
    expect((outlines.get(LAST) instanceof PDFRef)).toBeTruthy()
  })

  it('add 子书签:挂到指定父节点链尾,父 /Count+1', async () => {
    const { doc, outlines } = await docWithOutline()
    applyOutlineEdit(doc, { kind: 'add', parentPath: [0], page: 1, title: '第二个子书签' })
    const tops = readSiblings(doc, outlines)
    expect(tops[0]?.count).toBe(3)
    // 子链挂在 top1 的 /First;readSiblings 必须从容器(top1)读,传叶子会永远为空
    const top1 = siblingDict(doc, outlines, 0)
    const children = top1 ? readSiblings(doc, top1) : []
    expect(children.map((c) => c.title)).toEqual(['子书签', '第二个子书签'])
    expect(outlines.lookupMaybe(COUNT, PDFNumber)?.asNumber()).toBe(3)
  })

  it('remove 顶层:兄弟链重连、根 /Count-1、被删子树不可达', async () => {
    const { doc, outlines } = await docWithOutline()
    applyOutlineEdit(doc, { kind: 'remove', path: [0] })
    const tops = readSiblings(doc, outlines)
    expect(tops.map((t) => t.title)).toEqual(['第二个'])
    expect(outlines.lookupMaybe(COUNT, PDFNumber)?.asNumber()).toBe(1)
    expect((outlines.get(FIRST) instanceof PDFRef)).toBeTruthy()
  })

  it('remove 子书签:父 /Count-1', async () => {
    const { doc, outlines } = await docWithOutline()
    applyOutlineEdit(doc, { kind: 'remove', path: [0, 0] })
    const top1 = siblingDict(doc, outlines, 0)
    const children = top1 ? readSiblings(doc, top1) : []
    expect(children).toHaveLength(0)
    expect(top1?.lookupMaybe(COUNT, PDFNumber)?.asNumber()).toBe(1)
    // 删的是子级条目,顶层计数(根直接子节点数)不变,仍是 2
    expect(outlines.lookupMaybe(COUNT, PDFNumber)?.asNumber()).toBe(2)
  })

  it('无大纲文档 add:自动建 /Outlines 并挂 catalog', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([595, 842])
    applyOutlineEdit(doc, { kind: 'add', parentPath: [], page: 0, title: '第一条' })
    const outlinesRef = doc.catalog.get(OUTLINES)
    expect(outlinesRef).toBeInstanceOf(PDFRef)
    const outlines = doc.context.lookup(outlinesRef as PDFRef)
    expect(outlines).toBeInstanceOf(PDFDict)
    expect(readSiblings(doc, outlines as PDFDict).map((t) => t.title)).toEqual(['第一条'])
  })

  it('路径越界/空标题抛可读中文错误', async () => {
    const { doc } = await docWithOutline()
    expect(() => applyOutlineEdit(doc, { kind: 'rename', path: [9], title: 'x' })).toThrow('书签已变化')
    expect(() => applyOutlineEdit(doc, { kind: 'rename', path: [0], title: '   ' })).toThrow('书签标题不能为空')
    expect(() => applyOutlineEdit(doc, { kind: 'add', parentPath: [], page: 99, title: 'x' })).toThrow('目标页不存在')
  })
})
