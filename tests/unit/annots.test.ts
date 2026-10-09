import { afterEach, describe, expect, it } from 'vitest'
import {
  KIND_LABEL,
  PALETTE,
  STAMPS,
  STAMP_KEYS,
  TOOL_DEFAULTS,
  newId,
  textPatch,
  withIdentity
} from '../../src/renderer/src/lib/annots'
import type { Annotation } from '../../src/shared/types'

const realCrypto = globalThis.crypto

afterEach(() => {
  Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true, writable: true })
})

describe('newId', () => {
  it('正常环境返回 UUID', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('crypto 缺失(非 secure context)时回退到时间戳+随机后缀,且唯一', () => {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true })
    const first = newId()
    const second = newId()
    expect(first).toMatch(/^a-\d+-[0-9a-z]+$/)
    expect(second).toMatch(/^a-\d+-[0-9a-z]+$/)
    expect(first).not.toBe(second)
  })
})

describe('withIdentity', () => {
  it('补上 id 与 createdAt,其余字段原样', () => {
    const ann = withIdentity({
      kind: 'rect',
      page: 2,
      bbox: { x: 1, y: 2, w: 3, h: 4 },
      color: '#e03131',
      opacity: 0.5,
      thickness: 2
    })
    expect(ann.page).toBe(2)
    expect(ann.createdAt).toBeGreaterThan(0)
    expect(ann.id.length).toBeGreaterThan(0)
  })
})

describe('textPatch', () => {
  const textAnn = {
    kind: 'text',
    page: 0,
    id: 't',
    createdAt: 0,
    bbox: { x: 0, y: 0, w: 100, h: 10 },
    text: '旧文本',
    fontSize: 14,
    rotate: 0,
    color: '#000000',
    opacity: 1
  } satisfies Annotation

  it('文字注释按行数抬升高度', () => {
    const patch = textPatch(textAnn, '一行\n两行\n三行')
    expect(patch.bbox?.h).toBeGreaterThanOrEqual(14 * 1.2 * 3 + 6)
  })

  it('原高度已够时不再返回 bbox(交给布局层自己算)', () => {
    const tall = { ...textAnn, bbox: { x: 0, y: 0, w: 100, h: 40 } } as Annotation
    expect(textPatch(tall, '短').bbox).toBeUndefined()
  })

  it('便签不返回 bbox,只带文本', () => {
    const note: Annotation = { ...textAnn, kind: 'note' }
    const patch = textPatch(note, '新内容')
    expect(patch.bbox).toBeUndefined()
    expect('text' in patch ? patch.text : null).toBe('新内容')
  })
})

describe('常量完整性', () => {
  it('图章预设与键集合一致,label 非空、color 为 #rrggbb', () => {
    expect(Object.keys(STAMPS).sort()).toEqual([...STAMP_KEYS].sort())
    for (const key of STAMP_KEYS) {
      expect(STAMPS[key].label.length).toBeGreaterThan(0)
      expect(STAMPS[key].color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('色板 8 色且无重复', () => {
    expect(PALETTE).toHaveLength(8)
    expect(new Set(PALETTE).size).toBe(8)
  })

  it('每种注释类型都有中文名与默认样式', () => {
    // 工具栏 11 个工具 = 选择 + 10 种可落库的注释类型
    const kinds = ['highlight', 'rect', 'ellipse', 'ink', 'arrow', 'measure', 'text', 'note', 'image', 'stamp']
    expect(Object.keys(KIND_LABEL).sort()).toEqual([...kinds].sort())
    for (const kind of kinds) {
      expect(KIND_LABEL[kind as keyof typeof KIND_LABEL].length).toBeGreaterThan(0)
      const style = TOOL_DEFAULTS[kind]
      expect(style, kind).toBeDefined()
      expect(style.color).toMatch(/^#[0-9a-f]{6}$/i)
      expect(style.opacity).toBeGreaterThan(0)
      expect(style.opacity).toBeLessThanOrEqual(1)
      expect(style.thickness).toBeGreaterThan(0)
    }
  })
})