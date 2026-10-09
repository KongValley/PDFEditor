import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  pruneBufferStack,
  pushBufferSnapshot,
  readSidecar,
  sidecarPathFor,
  uniqueFilePath,
  type DocEntry
} from '../../src/main/lib/pdfio'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdfio-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('uniqueFilePath', () => {
  it('目录中没有同名文件时保持原名', () => {
    expect(uniqueFilePath(dir, 'a.pdf')).toBe(join(dir, 'a.pdf'))
  })

  it('已存在时依次追加 -1、-2', () => {
    writeFileSync(join(dir, 'a.pdf'), '')
    expect(uniqueFilePath(dir, 'a.pdf')).toBe(join(dir, 'a-1.pdf'))
    writeFileSync(join(dir, 'a-1.pdf'), '')
    expect(uniqueFilePath(dir, 'a.pdf')).toBe(join(dir, 'a-2.pdf'))
  })

  it('无扩展名文件同样去重', () => {
    writeFileSync(join(dir, 'README'), '')
    expect(uniqueFilePath(dir, 'README')).toBe(join(dir, 'README-1'))
  })

  it('点开头的文件名视为无扩展名', () => {
    writeFileSync(join(dir, '.gitignore'), '')
    expect(uniqueFilePath(dir, '.gitignore')).toBe(join(dir, '.gitignore-1'))
  })
})

describe('sidecarPathFor / readSidecar', () => {
  it('sidecar 路径为原名 + anno.json', () => {
    expect(sidecarPathFor(join(dir, 'report.pdf'))).toBe(join(dir, 'report.pdfanno.json'))
  })

  it('文件不存在返回 null', () => {
    expect(readSidecar(join(dir, 'none.pdf'))).toBeNull()
  })

  it('内容损坏返回 null 而不抛错', () => {
    writeFileSync(join(dir, 'bad.pdfanno.json'), '{not json')
    expect(readSidecar(join(dir, 'bad.pdf'))).toBeNull()
  })

  it('annotations 类型异常时丢弃它但保留 formValues', () => {
    writeFileSync(join(dir, 'x.pdfanno.json'), JSON.stringify({ version: 1, annotations: 'oops', formValues: { a: '1' } }))
    const data = readSidecar(join(dir, 'x.pdf'))
    expect(data?.annotations).toEqual([])
    expect(data?.formValues).toEqual({ a: '1' })
  })

  it('正常文件原样解析', () => {
    writeFileSync(
      join(dir, 'ok.pdfanno.json'),
      JSON.stringify({ version: 2, annotations: [{ id: 'a' }], formValues: { f: 'v' } })
    )
    const data = readSidecar(join(dir, 'ok.pdf'))
    expect(data?.version).toBe(2)
    expect(data?.annotations).toHaveLength(1)
    expect(data?.formValues).toEqual({ f: 'v' })
  })
})

describe('pruneBufferStack', () => {
  const snap = (bytes: number): { buffer: Buffer; pageCount: number } => ({
    buffer: Buffer.alloc(bytes, 1),
    pageCount: 10
  })

  it('超过 5 条时从头丢弃到 5 条', () => {
    const stack = Array.from({ length: 8 }, (_, i) => snap(1024))
    pruneBufferStack(stack)
    expect(stack).toHaveLength(5)
    // 丢的是最旧(最前面)那条:内容仍是最后入栈的
    expect(stack[4].buffer[0]).toBe(1)
  })

  it('总量超 64MB 时丢到只剩 1 条', () => {
    const stack = [snap(40 * 1024 * 1024), snap(40 * 1024 * 1024)]
    pruneBufferStack(stack)
    expect(stack).toHaveLength(1)
  })

  it('至少保留 1 条', () => {
    const stack = [snap(200 * 1024 * 1024)]
    pruneBufferStack(stack)
    expect(stack).toHaveLength(1)
  })
})

describe('pushBufferSnapshot', () => {
  const entry = (byteLength: number): DocEntry => ({
    path: join(dir, 'a.pdf'),
    buffer: Buffer.alloc(byteLength, 1),
    pageCount: 3,
    undoBuffers: [],
    redoBuffers: [{ buffer: Buffer.alloc(8, 2), pageCount: 1 }],
    encrypted: false
  })

  it('超大文档(>128MB)不记快照', () => {
    const e = entry(129 * 1024 * 1024)
    expect(pushBufferSnapshot(e)).toBe(false)
    expect(e.undoBuffers).toHaveLength(0)
  })

  it('正常文档记快照并清空 redo 栈', () => {
    const e = entry(1024)
    expect(pushBufferSnapshot(e)).toBe(true)
    expect(e.undoBuffers).toHaveLength(1)
    expect(e.redoBuffers).toHaveLength(0)
  })
})