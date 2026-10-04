/** 文本换行与度量(渲染层与保存层共用,度量函数由调用方注入) */

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
