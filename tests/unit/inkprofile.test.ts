import { describe, expect, it } from 'vitest'
import {
  consensusProfile,
  correlation,
  inkShare,
  invertedPages,
  normalizeProfile,
  sidewaysDirection,
  type RowProfile
} from '../../src/renderer/src/lib/inkprofile'

/** 一页"文字行"的行墨迹:每 pitch 行一条 height 高的墨带,值 100 */
function textRows(lines: number, pitch = 18, height = 7, total = 160): Float64Array {
  const rows = new Float64Array(total)
  for (let line = 0; line < lines; line++) {
    const start = 20 + line * pitch
    for (let y = start; y < Math.min(start + height, total); y++) rows[y] = 100
  }
  return rows
}

const mirrored = (rows: Float64Array): Float64Array => Float64Array.from(rows).reverse()

describe('inkShare', () => {
  it('空白页接近 0', () => {
    expect(inkShare(new Float64Array(160))).toBe(0)
  })

  it('单点墨迹也远低于有效页(均值/峰值)', () => {
    const rows = new Float64Array(160)
    rows[80] = 100
    expect(inkShare(rows)).toBeCloseTo(1 / 160, 6)
  })
})

describe('normalizeProfile', () => {
  it('固定长度且均值为 0、标准差为 1', () => {
    const z = normalizeProfile(textRows(6), 64)
    expect(z).toHaveLength(64)
    const mean = z.reduce((a, b) => a + b, 0) / z.length
    const std = Math.sqrt(z.reduce((a, b) => a + (b - mean) ** 2, 0) / z.length)
    expect(Math.abs(mean)).toBeLessThan(1e-9)
    expect(std).toBeCloseTo(1, 6)
  })

  it('全等剖面不成比例(标准差兜底为 1,不产生 NaN)', () => {
    const z = normalizeProfile(new Float64Array(100).fill(50), 32)
    expect(z.every((v) => v === 0)).toBe(true)
  })
})

describe('correlation', () => {
  it('同向为 1,反向(取负)为 -1,常量剖面为 0', () => {
    const a = normalizeProfile(textRows(6), 128)
    expect(correlation(a, a)).toBeCloseTo(1, 6)
    expect(correlation(a, a.map((v) => -v))).toBeCloseTo(-1, 6)
    expect(correlation(a, new Array(a.length).fill(0))).toBe(0)
  })

  it('镜像剖面与参考的相关明显变差(判倒置的依据)', () => {
    const a = normalizeProfile(textRows(6), 128)
    const reference = normalizeProfile(textRows(6, 18, 7), 128)
    const asIs = correlation(a, reference)
    const reversed = correlation([...a].reverse(), reference)
    expect(asIs).toBeCloseTo(1, 6)
    expect(reversed).toBeLessThan(asIs - 0.5)
  })
})

describe('consensusProfile', () => {
  it('可比页不足时不给结论(两页之间谈不上共识)', () => {
    expect(consensusProfile([{ page: 1, rows: textRows(6) }, { page: 2, rows: textRows(6) }])).toBeNull()
  })

  it('空白页不参与共识', () => {
    const profiles: RowProfile[] = [
      { page: 1, rows: textRows(6) },
      { page: 2, rows: textRows(6) },
      { page: 3, rows: new Float64Array(160) }
    ]
    expect(consensusProfile(profiles)).toBeNull() // 只剩 2 页可比
  })

  it('共识剖面与多数页一致', () => {
    const reference = consensusProfile([
      { page: 1, rows: textRows(6) },
      { page: 2, rows: textRows(6) },
      { page: 3, rows: textRows(6) }
    ])
    expect(reference).not.toBeNull()
    expect(correlation(normalizeProfile(textRows(6)), reference!)).toBeGreaterThan(0.9)
  })
})

describe('invertedPages', () => {
  const upright = (page: number) => ({ page, rows: textRows(6) })

  it('找出镜像的那一页', () => {
    const flagged = invertedPages([upright(1), upright(2), upright(3), { page: 4, rows: mirrored(textRows(6)) }])
    expect(flagged).toEqual([4])
  })

  it('少数派被倒置也不影响结论(最多只能被"共识"埋掉)', () => {
    const flagged = invertedPages([
      upright(1),
      upright(2),
      upright(3),
      upright(4),
      { page: 5, rows: mirrored(textRows(6)) }
    ])
    expect(flagged).toEqual([5])
  })

  it('版式各不相同(相关度上不去)时一律不报,宁可漏判', () => {
    const flagged = invertedPages([
      { page: 1, rows: textRows(3, 24, 5) },
      { page: 2, rows: textRows(10, 12, 3) },
      { page: 3, rows: textRows(5, 30, 11) }
    ])
    expect(flagged).toEqual([])
  })

  it('空白页不会被报(没有可比内容)', () => {
    const flagged = invertedPages([
      upright(1),
      upright(2),
      upright(3),
      { page: 4, rows: new Float64Array(160) }
    ])
    expect(flagged).toEqual([])
  })
})

describe('sidewaysDirection', () => {
  // 横躺页的列剖面:整页顺时针转 90° 后它就是新的行剖面
  const reference = [
    { page: 1, rows: textRows(6) },
    { page: 2, rows: textRows(6) },
    { page: 3, rows: textRows(6) }
  ]

  it('列剖面贴合共识 → 顺时针 90°', () => {
    expect(sidewaysDirection(reference, textRows(6))).toBe(90)
  })

  it('反向列剖面贴合共识 → 270°', () => {
    expect(sidewaysDirection(reference, mirrored(textRows(6)))).toBe(270)
  })

  it('无法比较(没有共识或剖面无起伏)时返回 0,交给默认方向', () => {
    expect(sidewaysDirection([], textRows(6))).toBe(0)
    expect(sidewaysDirection(reference, new Float64Array(160).fill(100))).toBe(0)
  })
})
