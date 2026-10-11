import { describe, expect, it, vi } from 'vitest'

/**
 * orientationOf/pickBaseOrientation 是纯计算,但模块顶层 import 链(document/viewer)
 * 在加载期读 window.location(pdfjs 资源基址)与 machineProfile(reactive),需先打桩。
 */
vi.stubGlobal('window', {
  addEventListener: () => {},
  removeEventListener: () => {},
  confirm: () => true,
  location: { href: 'app://./index.html' }
})

const { orientationOf, pickBaseOrientation } = await import('../../src/renderer/src/lib/orientation')

describe('orientationOf:宽高比判定', () => {
  it('纵向/横向/方形', () => {
    expect(orientationOf(595, 842)).toBe('portrait')
    expect(orientationOf(842, 595)).toBe('landscape')
    expect(orientationOf(600, 600)).toBe('square')
  })

  it('近方形(2% 内)判为 square', () => {
    expect(orientationOf(600, 610)).toBe('square')
    expect(orientationOf(610, 600)).toBe('square')
  })

  it('0 尺寸不抛错(返回 square)', () => {
    expect(orientationOf(0, 0)).toBe('square')
  })
})

describe('pickBaseOrientation:多数派与平票', () => {
  it('多数派胜出', () => {
    expect(pickBaseOrientation(['portrait', 'portrait', 'landscape'])).toBe('portrait')
    expect(pickBaseOrientation(['landscape', 'landscape', 'landscape'])).toBe('landscape')
  })

  it('平票返回 null(无法判定基准)', () => {
    expect(pickBaseOrientation(['portrait', 'landscape'])).toBeNull()
  })

  it('square 不参与基准', () => {
    expect(pickBaseOrientation(['square', 'landscape', 'landscape'])).toBe('landscape')
    expect(pickBaseOrientation(['square', 'square'])).toBeNull()
  })

  it('空列表返回 null', () => {
    expect(pickBaseOrientation([])).toBeNull()
  })
})
