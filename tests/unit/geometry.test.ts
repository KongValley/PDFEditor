import { describe, expect, it } from 'vitest'
import { annotationBounds, pointsBounds, type Annotation, type Point } from '../../src/shared/types'
import { pdfPointToScreen, pdfRectToScreen, rectFromPoints, screenPointToPdf, simplifyPoints } from '../../src/renderer/src/lib/geo'
import type { PageViewport } from 'pdfjs-dist'

/** 手写假 viewport:PDF 原点在左下 → 屏幕原点在左上,只做缩放与翻转 */
function fakeViewport(scale: number, height: number): PageViewport {
  return {
    scale,
    convertToViewportPoint: (x: number, y: number): [number, number] => [x * scale, (height - y) * scale],
    convertToPdfPoint: (x: number, y: number): [number, number] => [x / scale, height - y / scale]
  } as unknown as PageViewport
}

describe('pointsBounds', () => {
  it('空点集返回零矩形', () => {
    expect(pointsBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('单点宽高为 0', () => {
    expect(pointsBounds([{ x: 5, y: 7 }])).toEqual({ x: 5, y: 7, w: 0, h: 0 })
  })

  it('多点取外接框(与输入顺序无关)', () => {
    expect(pointsBounds([{ x: 10, y: 20 }, { x: 2, y: 30 }])).toEqual({ x: 2, y: 20, w: 8, h: 10 })
  })
})

describe('annotationBounds', () => {
  const base = { id: 'a', createdAt: 0, opacity: 1, color: '#000000' }

  it('rect/text 直接用 bbox', () => {
    const ann = { ...base, kind: 'rect', bbox: { x: 1, y: 2, w: 3, h: 4 }, thickness: 1 } as Annotation
    expect(annotationBounds(ann)).toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })

  it('ink 用 points 求外接框', () => {
    const ann = {
      ...base,
      kind: 'ink',
      points: [
        { x: 0, y: 0 },
        { x: 30, y: 12 }
      ],
      thickness: 1
    } as Annotation
    expect(annotationBounds(ann)).toEqual({ x: 0, y: 0, w: 30, h: 12 })
  })

  it('arrow 取 from/to 两端', () => {
    const ann = { ...base, kind: 'arrow', from: { x: 4, y: 9 }, to: { x: 1, y: 2 }, thickness: 1 } as Annotation
    expect(annotationBounds(ann)).toEqual({ x: 1, y: 2, w: 3, h: 7 })
  })
})

describe('rectFromPoints', () => {
  it('两点顺序无关,宽高非负', () => {
    const a: Point = { x: 30, y: 40 }
    const b: Point = { x: 10, y: 20 }
    expect(rectFromPoints(a, b)).toEqual({ x: 10, y: 20, w: 20, h: 20 })
    expect(rectFromPoints(b, a)).toEqual({ x: 10, y: 20, w: 20, h: 20 })
  })
})

describe('坐标换算(假 viewport)', () => {
  const vp = fakeViewport(2, 600)

  it('PDF 原点映射到屏幕左下角', () => {
    expect(pdfPointToScreen(vp, { x: 0, y: 0 })).toEqual({ x: 0, y: 1200 })
  })

  it('屏幕 ↔ PDF 往返一致', () => {
    const pdf: Point = { x: 123.5, y: 456.25 }
    const screen = pdfPointToScreen(vp, pdf)
    const back = screenPointToPdf(vp, screen.x, screen.y)
    expect(back.x).toBeCloseTo(pdf.x, 9)
    expect(back.y).toBeCloseTo(pdf.y, 9)
  })

  it('矩形取两点差的外接框(不因方向产生负宽高)', () => {
    const rect = pdfRectToScreen(vp, { x: 100, y: 100, w: 50, h: 20 })
    expect(rect.w).toBe(100)
    expect(rect.h).toBe(40)
    const flipped = pdfRectToScreen(vp, { x: 150, y: 120, w: 50, h: 20 })
    expect(flipped.w).toBe(100)
    expect(flipped.h).toBe(40)
  })
})

describe('simplifyPoints', () => {
  it('点数不足 3 时返回副本(不共享引用)', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 1 }
    ]
    const out = simplifyPoints(points, 5)
    expect(out).toEqual(points)
    expect(out).not.toBe(points)
  })

  it('共线且偏差小于容差时只保留首尾', () => {
    const out = simplifyPoints(
      [
        { x: 0, y: 0 },
        { x: 5, y: 0.5 },
        { x: 10, y: 0 }
      ],
      2
    )
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 }
    ])
  })

  it('偏差超过容差时保留中间点', () => {
    const out = simplifyPoints(
      [
        { x: 0, y: 0 },
        { x: 5, y: 20 },
        { x: 10, y: 0 }
      ],
      2
    )
    expect(out).toHaveLength(3)
  })

  it('首尾重合的退化线段不会除零', () => {
    const out = simplifyPoints(
      [
        { x: 1, y: 1 },
        { x: 1, y: 5 },
        { x: 1, y: 1 }
      ],
      0.5
    )
    expect(out.length).toBeGreaterThanOrEqual(2)
  })
})