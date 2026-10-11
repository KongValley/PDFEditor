import { describe, expect, it } from 'vitest'
import { mimeOf } from '../../src/main/lib/images'

describe('mimeOf:按文件头判 PNG/JPEG', () => {
  it('PNG 魔数', () => {
    expect(mimeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('image/png')
  })

  it('JPEG 魔数', () => {
    expect(mimeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe('image/jpeg')
  })

  it('长度不足时不得越界读', () => {
    expect(mimeOf(Buffer.from([0x89, 0x50]))).toBeNull()
    expect(mimeOf(Buffer.from([0xff, 0xd8]))).toBeNull()
    expect(mimeOf(Buffer.alloc(0))).toBeNull()
  })

  it('头部错位/其它格式返回 null(不信任扩展名)', () => {
    expect(mimeOf(Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]))).toBeNull()
    expect(mimeOf(Buffer.from('GIF89a'.split('').map((c) => c.charCodeAt(0))))).toBeNull()
  })
})
