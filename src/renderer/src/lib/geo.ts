import type { Point, Rect } from '@shared/types'
import type { PageViewport } from './pdfjs'

export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * PDF 用户空间矩形 → 屏幕(CSS px)矩形。
 * pdf.js v6 移除了 convertToViewportRectangle,改用两对角点转换;
 * 90/270 度旋转下轴对齐矩形仍映射为轴对齐矩形,取外接框即可。
 */
export function pdfRectToScreen(vp: PageViewport, rect: Rect): ScreenRect {
  const [x1, y1] = vp.convertToViewportPoint(rect.x, rect.y)
  const [x2, y2] = vp.convertToViewportPoint(rect.x + rect.w, rect.y + rect.h)
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

export function pdfPointToScreen(vp: PageViewport, point: Point): { x: number; y: number } {
  const [x, y] = vp.convertToViewportPoint(point.x, point.y)
  return { x, y }
}

export function screenPointToPdf(vp: PageViewport, x: number, y: number): Point {
  const [px, py] = vp.convertToPdfPoint(x, y)
  return { x: px, y: py }
}

/** 由两点构造归一化矩形(PDF 用户空间) */
export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

/** Douglas-Peucker 折线简化 */
export function simplifyPoints(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points.slice()
  let maxDistance = 0
  let index = 0
  const first = points[0]
  const last = points[points.length - 1]
  const dx = last.x - first.x
  const dy = last.y - first.y
  const segmentLength = Math.hypot(dx, dy)
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]
    const distance =
      segmentLength === 0
        ? Math.hypot(p.x - first.x, p.y - first.y)
        : Math.abs(dy * p.x - dx * p.y + last.x * first.y - last.y * first.x) / segmentLength
    if (distance > maxDistance) {
      maxDistance = distance
      index = i
    }
  }
  if (maxDistance <= tolerance) return [first, last]
  const left = simplifyPoints(points.slice(0, index + 1), tolerance)
  const right = simplifyPoints(points.slice(index), tolerance)
  return left.slice(0, -1).concat(right)
}
