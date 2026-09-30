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
