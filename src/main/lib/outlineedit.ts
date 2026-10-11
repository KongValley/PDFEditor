/**
 * 书签(大纲)编辑:pdf-lib 没有大纲 API,这里直接对 /Outlines 低层字典做手术。
 * 只做三件事:新增(挂在指定父节点末尾)、重命名、删除;撤销/重做走页面操作同一套
 * buffer 快照栈(调用方 outline:apply 在写盘前 pushBufferSnapshot)。
 * 维护约定:父节点 /Count 记「1 + 子树全部后代节点数」;/Outlines 的 /Count 记
 * 顶层直接子节点数(pdf.js 据此判断大纲是否为空)。
 *
 * pdf-lib 语义提醒:lookupMaybe(key, X) 匹配的是**解引用后**的对象;取 ref 本体必须
 * `dict.get(key)` 再 `instanceof PDFRef` 判断,写 ref 值也必须 set 进 PDFRef 实例。
 */
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef } from 'pdf-lib'

export type OutlineEdit =
  | { kind: 'add'; parentPath: number[]; page: number; title: string }
  | { kind: 'rename'; path: number[]; title: string }
  | { kind: 'remove'; path: number[] }

const FIRST = PDFName.of('First')
const LAST = PDFName.of('Last')
const NEXT = PDFName.of('Next')
const PREV = PDFName.of('Prev')
const PARENT = PDFName.of('Parent')
const COUNT = PDFName.of('Count')
const TITLE = PDFName.of('Title')
const TYPE = PDFName.of('Type')
const OUTLINES = PDFName.of('Outlines')

/** 取 dict 里存的 ref 本体(不解引用);不是 ref 时返回 undefined */
function refOfValue(dict: PDFDict, key: PDFName): PDFRef | undefined {
  const raw = dict.get(key)
  return raw instanceof PDFRef ? raw : undefined
}

function asDict(doc: PDFDocument, value: unknown): PDFDict | undefined {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value
  return resolved instanceof PDFDict ? resolved : undefined
}

/** 沿 /First→/Next 链按索引取第 n 个兄弟节点 */
function siblingAt(doc: PDFDocument, startRef: PDFRef, index: number): PDFDict | undefined {
  let current = asDict(doc, startRef)
  for (let i = 0; i < index && current; i++) {
    const nextRef = refOfValue(current, NEXT)
    if (!nextRef) return undefined
    current = asDict(doc, nextRef)
  }
  return current
}

/** 按索引路径定位节点;越界/结构异常返回 undefined(调用方转中文错误) */
function nodeAtPath(doc: PDFDocument, outlines: PDFDict, path: number[]): { node: PDFDict; parent: PDFDict | undefined } | undefined {
  let parent: PDFDict | undefined
  let childrenRef: PDFRef | undefined = refOfValue(outlines, FIRST)
  let node: PDFDict | undefined
  for (const index of path) {
    if (!childrenRef) return undefined
    const child = siblingAt(doc, childrenRef, index)
    if (!child) return undefined
    parent = node
    node = child
    childrenRef = refOfValue(node, FIRST)
  }
  return node ? { node, parent } : undefined
}

/** 统计节点自身 + 全部后代数(沿 /First→/Next 递归) */
function subtreeSize(doc: PDFDocument, node: PDFDict): number {
  let total = 1
  let childRef = refOfValue(node, FIRST)
  while (childRef) {
    const child = asDict(doc, childRef)
    if (!child) break
    total += subtreeSize(doc, child)
    childRef = refOfValue(child, NEXT)
  }
  return total
}

function ensureOutlines(doc: PDFDocument): { outlines: PDFDict; ref: PDFRef } {
  const existingRef = refOfValue(doc.catalog, OUTLINES)
  if (existingRef) {
    const existing = asDict(doc, existingRef)
    if (existing) return { outlines: existing, ref: existingRef }
  }
  const fresh = PDFDict.withContext(doc.context)
  fresh.set(TYPE, OUTLINES)
  const ref = doc.context.register(fresh)
  doc.catalog.set(OUTLINES, ref)
  return { outlines: fresh, ref }
}

function countOf(dict: PDFDict): number {
  const raw = dict.get(COUNT)
  return raw instanceof PDFNumber ? raw.asNumber() : 0
}

export function applyOutlineEdit(doc: PDFDocument, edit: OutlineEdit): void {
  const { outlines } = ensureOutlines(doc)

  if (edit.kind === 'add') {
    if (edit.title.trim() === '') throw new Error('书签标题不能为空')
    if (edit.page < 0 || edit.page >= doc.getPageCount()) throw new Error('书签目标页不存在')
    // 定位父节点(空 parentPath = 顶层)
    let parent: PDFDict | undefined
    let parentRef: PDFRef | undefined
    if (edit.parentPath.length > 0) {
      const found = nodeAtPath(doc, outlines, edit.parentPath)
      if (!found) throw new Error('书签已变化,请重试')
      parent = found.node
      const parentSelfRef = doc.context.getObjectRef(parent)
      parentRef = parentSelfRef instanceof PDFRef ? parentSelfRef : undefined
    }
    const node = PDFDict.withContext(doc.context)
    node.set(TYPE, PDFName.of('Item'))
    node.set(TITLE, PDFHexString.fromText(edit.title))
    node.set(PDFName.of('Dest'), doc.context.obj([doc.getPage(edit.page).ref, PDFName.of('Fit')]))
    if (parentRef) node.set(PARENT, parentRef)
    const nodeRef = doc.context.register(node)
    // 挂到父(或 /Outlines)的子链末尾
    const holder = parent ?? outlines
    const lastRef = refOfValue(holder, LAST)
    if (lastRef) {
      const last = asDict(doc, lastRef)
      if (last) {
        last.set(NEXT, nodeRef)
        node.set(PREV, lastRef)
      }
    } else {
      holder.set(FIRST, nodeRef)
    }
    holder.set(LAST, nodeRef)
    if (parent) parent.set(COUNT, PDFNumber.of(countOf(parent) + 1))
    outlines.set(COUNT, PDFNumber.of(countOf(outlines) + 1))
    return
  }

  const found = nodeAtPath(doc, outlines, edit.path)
  if (!found) throw new Error('书签已变化,请重试')
  const { node, parent } = found
  const nodeSelfRef = doc.context.getObjectRef(node)
  const nodeRef = nodeSelfRef instanceof PDFRef ? nodeSelfRef : undefined

  if (edit.kind === 'rename') {
    if (edit.title.trim() === '') throw new Error('书签标题不能为空')
    node.set(TITLE, PDFHexString.fromText(edit.title))
    return
  }

  // remove:从兄弟链摘除并修正父/根的 First/Last
  const holder = parent ?? outlines
  const prevRef = refOfValue(node, PREV)
  const nextRef = refOfValue(node, NEXT)
  if (prevRef) {
    const prev = asDict(doc, prevRef)
    if (prev) {
      if (nextRef) prev.set(NEXT, nextRef)
      else prev.delete(NEXT)
    }
  } else if (nextRef) {
    holder.set(FIRST, nextRef)
  } else {
    holder.delete(FIRST)
  }
  if (nextRef) {
    const next = asDict(doc, nextRef)
    if (next) {
      if (prevRef) next.set(PREV, prevRef)
      else next.delete(PREV)
    }
  }
  const holderLastRef = refOfValue(holder, LAST)
  if (holderLastRef && nodeRef && holderLastRef.toString() === nodeRef.toString()) {
    if (prevRef) holder.set(LAST, prevRef)
    else holder.delete(LAST)
  }
  const removed = subtreeSize(doc, node)
  if (parent) parent.set(COUNT, PDFNumber.of(Math.max(0, countOf(parent) - removed)))
  // /Outlines 的 /Count 记「顶层直接子节点数」:只有删顶层条目时才 -1;删子级不动它
  if (!parent) outlines.set(COUNT, PDFNumber.of(Math.max(0, countOf(outlines) - 1)))
}
