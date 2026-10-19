/** 文本换行与度量(渲染层与保存层共用,度量函数由调用方注入) */
import type { Point, Rect } from './types'

const CJK_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\uac00-\ud7af]/

export function isCjk(char: string): boolean {
  return CJK_RE.test(char)
}

/**
 * 按可用宽度断行:中文等 CJK 逐字断行,拉丁文优先在空格处断行。
 * @param measure 返回字符串在目标字体/字号下的宽度
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = []
  if (maxWidth <= 0) return [text]
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const char of paragraph) {
      if (line !== '' && measure(line + char) > maxWidth) {
        const spaceAt = isCjk(char) ? -1 : line.lastIndexOf(' ')
        if (spaceAt > 0) {
          lines.push(line.slice(0, spaceAt))
          line = line.slice(spaceAt + 1) + char
        } else {
          lines.push(line)
          line = char
        }
      } else {
        line += char
      }
    }
    lines.push(line)
  }
  return lines
}

export interface TextBlockFrame {
  origin: Point
  u: Point
  v: Point
  run: number
  stack: number
}

/**
 * 文本块局部坐标系:run = 文字行进方向的长度,stack = 行叠放方向的长度;rotate 为顺时针显示角。
 * origin 是块的「屏幕左上角」在 PDF 用户空间中的坐标,局部 +x 沿 run,局部 +y 沿 stack。
 */
export function textBlockFrame(rect: Rect, rotate: number): TextBlockFrame {
  const r = ((Math.round(rotate / 90) * 90) % 360 + 360) % 360
  const left = rect.x
  const bottom = rect.y
  const right = rect.x + rect.w
  const top = rect.y + rect.h
  switch (r) {
    case 90:
      return { origin: { x: left, y: bottom }, u: { x: 0, y: 1 }, v: { x: 1, y: 0 }, run: rect.h, stack: rect.w }
    case 180:
      return { origin: { x: right, y: bottom }, u: { x: -1, y: 0 }, v: { x: 0, y: 1 }, run: rect.w, stack: rect.h }
    case 270:
      return { origin: { x: right, y: top }, u: { x: 0, y: -1 }, v: { x: -1, y: 0 }, run: rect.h, stack: rect.w }
    default:
      return { origin: { x: left, y: top }, u: { x: 1, y: 0 }, v: { x: 0, y: -1 }, run: rect.w, stack: rect.h }
  }
}

/** 块内局部坐标(原点在块左上角,localY 向下)→ PDF 用户空间 */
export function textLocalToPdf(rect: Rect, rotate: number, localX: number, localY: number): Point {
  const f = textBlockFrame(rect, rotate)
  return {
    x: f.origin.x + f.u.x * localX + f.v.x * localY,
    y: f.origin.y + f.u.y * localX + f.v.y * localY
  }
}

/** 二分求最大可容纳字号(用于文字图章) */
export function fitFontSize(
  label: string,
  box: { w: number; h: number },
  measure: (s: string, size: number) => number
): number {
  const maxWidth = Math.max(box.w - 8, 4)
  const maxHeight = Math.max(box.h * 0.62, 4)
  let low = 4
  let high = Math.max(maxHeight, 4)
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2
    if (measure(label, mid) <= maxWidth && mid <= maxHeight) low = mid
    else high = mid
  }
  return low
}

/** pt → mm(保留一位小数) */
export function pointsToMm(points: number): number {
  return Math.round((points * 25.4) / 72 * 10) / 10
}

/**
 * 解析页码范围(1-based,含端点)为升序去重的 0-based 页索引数组。
 * 支持 `1-3,5,7-9`;逗号/中文逗号/空白分隔;`-`/`~`/`—` 作连字符。
 * 输入为空、token 非数字、页号越界或区间倒序时返回 null。
 */
export function parsePageRange(input: string, totalPages: number): number[] | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const pages = new Set<number>()
  for (const token of trimmed.split(/[,\uff0c\s]+/)) {
    if (token === '') continue
    const part = token.replace(/[~\u2014\uff0d]/g, '-')
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) return null
    const from = Number(m[1])
    const to = m[2] === undefined ? from : Number(m[2])
    if (from < 1 || to < from || to > totalPages) return null
    for (let p = from; p <= to; p++) pages.add(p - 1)
  }
  return pages.size === 0 ? null : [...pages].sort((a, b) => a - b)
}

/** 升序页索引按连续段切分:[[0,1,2],[4,5]] */
export function splitPageSegments(pages: number[]): number[][] {
  const segments: number[][] = []
  for (const page of pages) {
    const last = segments[segments.length - 1]
    if (last && last[last.length - 1] === page - 1) last.push(page)
    else segments.push([page])
  }
  return segments
}

/** 0-based 页索引 → "1-3,5"(升序、连续段用连字符;供对话框范围预填) */
export function formatPageRange(pages: number[]): string {
  return splitPageSegments(pages)
    .map((seg) => (seg.length === 1 ? String(seg[0] + 1) : `${seg[0] + 1}-${seg[seg.length - 1] + 1}`))
    .join(',')
}
