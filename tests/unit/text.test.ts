import { describe, expect, it } from 'vitest'
import { fitFontSize, formatPageRange, isCjk, parsePageRange, pointsToMm, splitPageSegments, textBlockFrame, textLocalToPdf, wrapText } from '../../src/shared/text'

/** 定宽度量:每字符 10pt,便于按字符数推导断行结果 */
const measure = (s: string): number => s.length * 10

describe('isCjk', () => {
  it('识别中日韩字符与中文标点', () => {
    expect(isCjk('中')).toBe(true)
    expect(isCjk('。')).toBe(true)
    expect(isCjk('한')).toBe(true)
  })

  it('拉丁字母与数字不算', () => {
    expect(isCjk('a')).toBe(false)
    expect(isCjk('1')).toBe(false)
    expect(isCjk(' ')).toBe(false)
  })
})

describe('wrapText', () => {
  it('中文逐字断行(每行放得下 2 字)', () => {
    expect(wrapText('一二三四五', 25, measure)).toEqual(['一二', '三四', '五'])
  })

  it('拉丁串在最后一个空格处断行,首行不留半个单词', () => {
    const lines = wrapText('hello world foo', 60, measure)
    expect(lines[0]).toBe('hello')
    expect(lines.join(' ')).toBe('hello world foo')
  })

  it('宽度不足时返回原文本,不丢换行结构', () => {
    expect(wrapText('abc\ndef', 0, measure)).toEqual(['abc\ndef'])
  })

  it('保留空段(连续换行产生空行)', () => {
    expect(wrapText('a\n\nb', 1000, measure)).toEqual(['a', '', 'b'])
  })
})

describe('fitFontSize', () => {
  it('结果同时满足宽度与高度上限', () => {
    const size = fitFontSize('已批准', { w: 120, h: 60 }, (s, n) => s.length * n)
    expect(size).toBeLessThanOrEqual(60 * 0.62)
    expect('已批准'.length * size).toBeLessThanOrEqual(120 - 8)
  })

  it('盒子过小时回落到下限 4', () => {
    expect(fitFontSize('很长的标签文字', { w: 1, h: 1 }, (s, n) => s.length * n)).toBe(4)
  })
})

describe('pointsToMm', () => {
  it('72pt = 1 英寸 = 25.4mm', () => {
    expect(pointsToMm(72)).toBe(25.4)
  })

  it('保留一位小数', () => {
    expect(pointsToMm(1)).toBe(0.4)
  })
})

describe('parsePageRange', () => {
  it('区间与单页混排,转 0-based 升序', () => {
    expect(parsePageRange('1-3,5', 10)).toEqual([0, 1, 2, 4])
  })

  it('中文逗号/空格/~ /— /全角连字符都当分隔与连字符', () => {
    expect(parsePageRange('1，2 3', 10)).toEqual([0, 1, 2])
    expect(parsePageRange('1~2', 10)).toEqual([0, 1])
    expect(parsePageRange('1—2', 10)).toEqual([0, 1])
    expect(parsePageRange('1-2', 10)).toEqual([0, 1])
  })

  it('重复页去重且保持升序', () => {
    expect(parsePageRange('3,1,3', 10)).toEqual([0, 2])
  })

  it('空/非数字/越界/倒序一律 null', () => {
    expect(parsePageRange('', 10)).toBeNull()
    expect(parsePageRange('   ', 10)).toBeNull()
    expect(parsePageRange('abc', 10)).toBeNull()
    expect(parsePageRange('0', 10)).toBeNull()
    expect(parsePageRange('4-2', 10)).toBeNull()
    expect(parsePageRange('11', 10)).toBeNull()
  })
})

describe('splitPageSegments', () => {
  it('连续页并成一段,断档另起一段', () => {
    expect(splitPageSegments([0, 1, 2, 4, 5])).toEqual([
      [0, 1, 2],
      [4, 5]
    ])
  })

  it('空输入返回空数组', () => {
    expect(splitPageSegments([])).toEqual([])
  })

  it('非升序输入不重排,只按相邻关系分段', () => {
    expect(splitPageSegments([2, 3, 1])).toEqual([
      [2, 3],
      [1]
    ])
  })
})

describe('textBlockFrame / textLocalToPdf', () => {
  // 旋转页上的 220×40 文本块:PDF 轴上是 40×220
  const rect = { x: 100, y: 200, w: 40, h: 220 }

  it('0° 与旧实现等价:原点在左上,行沿 -y 叠放', () => {
    expect(textBlockFrame(rect, 0)).toEqual({
      origin: { x: 100, y: 420 },
      u: { x: 1, y: 0 },
      v: { x: 0, y: -1 },
      run: 40,
      stack: 220
    })
    expect(textLocalToPdf(rect, 0, 0, 12)).toEqual({ x: 100, y: 408 })
  })

  it('90°:run 沿 +y,叠放沿 +x', () => {
    const frame = textBlockFrame(rect, 90)
    expect(frame.origin).toEqual({ x: 100, y: 200 })
    expect([frame.run, frame.stack]).toEqual([220, 40])
    expect(textLocalToPdf(rect, 90, 0, 12)).toEqual({ x: 112, y: 200 })
  })

  it('180°:run 沿 -x,叠放沿 +y', () => {
    expect(textBlockFrame(rect, 180).origin).toEqual({ x: 140, y: 200 })
    expect(textLocalToPdf(rect, 180, 0, 12)).toEqual({ x: 140, y: 212 })
  })

  it('270°:run 沿 -y,叠放沿 -x', () => {
    expect(textBlockFrame(rect, 270).origin).toEqual({ x: 140, y: 420 })
    expect(textLocalToPdf(rect, 270, 0, 12)).toEqual({ x: 128, y: 420 })
  })

  it('负角/非整象限角归一化', () => {
    expect(textBlockFrame(rect, -90).run).toBe(220)
    expect(textBlockFrame(rect, 95).run).toBe(220)
  })
})

describe('formatPageRange', () => {
  it('连续段并成区间,断档用逗号', () => {
    expect(formatPageRange([0, 1, 2, 4])).toBe('1-3,5')
  })

  it('空输入返回空串', () => {
    expect(formatPageRange([])).toBe('')
  })
})