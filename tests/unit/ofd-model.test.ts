import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  colorOf,
  detectDocumentKind,
  parseAbbreviatedData,
  parseOfdPackage,
  resolveLoc,
  unescapeTextCode
} from '../../src/main/lib/ofd/model'
import { readZipEntries, writeZipStored, type ZipWriteEntry } from '../../src/main/lib/ofd/zip'

const NS = 'http://www.ofdspec.org/2016'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ofd-model-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 最小但结构完整的 OFD:两页(第 2 页用「目录形式」BaseLoc)、公共资源字体、绘制参数、图片、模板页、页面块 */
function fixtureEntries(): ZipWriteEntry[] {
  return [
    {
      name: 'OFD.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:OFD xmlns:ofd="${NS}" DocType="OFD" Version="1.0">` +
        `<ofd:DocBody><ofd:DocInfo><ofd:DocID>abc</ofd:DocID></ofd:DocInfo>` +
        `<ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`
    },
    {
      name: 'Doc_0/Document.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:Document xmlns:ofd="${NS}"><ofd:CommonData>` +
        `<ofd:MaxUnitID>99</ofd:MaxUnitID>` +
        `<ofd:TemplatePage ID="9" BaseLoc="Tpls/Tpl_0/Content.xml"/>` +
        `<ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea>` +
        `<ofd:PublicRes>PublicRes.xml</ofd:PublicRes>` +
        `<ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes>` +
        `</ofd:CommonData><ofd:Pages>` +
        `<ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/>` +
        `<ofd:Page ID="2" BaseLoc="Pages/Page_1"/>` +
        `</ofd:Pages></ofd:Document>`
    },
    {
      name: 'Doc_0/PublicRes.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:Res xmlns:ofd="${NS}" BaseLoc="Res">` +
        `<ofd:DrawParams>` +
        `<ofd:DrawParam ID="3" LineWidth="0.25"><ofd:StrokeColor Value="156 82 35"/></ofd:DrawParam>` +
        `</ofd:DrawParams>` +
        `<ofd:Fonts>` +
        `<ofd:Font ID="1" FontName="黑体" FamilyName="SimHei" Charset="unicode"/>` +
        `<ofd:Font ID="2" FontName="Courier New"/>` +
        `<ofd:Font ID="3" FontName="内嵌宋体"><ofd:FontFile>font_0.ttf</ofd:FontFile></ofd:Font>` +
        `</ofd:Fonts></ofd:Res>`
    },
    {
      name: 'Doc_0/DocumentRes.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:Res xmlns:ofd="${NS}" BaseLoc="Res"><ofd:MultiMedias>` +
        `<ofd:MultiMedia ID="2" Type="Image" Format="PNG"><ofd:MediaFile>image_0.png</ofd:MediaFile></ofd:MultiMedia>` +
        `<ofd:MultiMedia ID="7" Type="Video" Format="MP4"><ofd:MediaFile>movie_0.mp4</ofd:MediaFile></ofd:MultiMedia>` +
        `</ofd:MultiMedias></ofd:Res>`
    },
    {
      name: 'Doc_0/Pages/Page_0/Content.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:Page xmlns:ofd="${NS}">` +
        `<ofd:Area><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:Area>` +
        `<ofd:Template ID="9" ZOrder="Background"/>` +
        `<ofd:Content><ofd:Layer ID="1" DrawParam="3">` +
        // 文档顺序刻意是「图 → 文 → 路径 → 页面块内文字」:顺序错会让背景图盖住文字
        `<ofd:ImageObject ID="13" Boundary="150 200 30 30" ResourceID="2"/>` +
        `<ofd:TextObject ID="11" Font="1" Size="5.6444" Boundary="20 30 150 12">` +
        `<ofd:FillColor Value="0 0 0"/>` +
        `<ofd:TextCode X="0" Y="10" DeltaX="5.6444 5.6444">OFD-测试文本\\00202026</ofd:TextCode>` +
        `</ofd:TextObject>` +
        `<ofd:PathObject ID="12" Boundary="20 50 170 40" Fill="false" Stroke="true">` +
        `<ofd:AbbreviatedData>M 0 0 L 170 0 L 170 40 L 0 40 C</ofd:AbbreviatedData>` +
        `</ofd:PathObject>` +
        `<ofd:PageBlock ID="20"><ofd:TextObject ID="14" Font="2" Size="3.5278" Boundary="20 100 60 8">` +
        `<ofd:TextCode X="0" Y="6">BLOCK</ofd:TextCode></ofd:TextObject></ofd:PageBlock>` +
        `</ofd:Layer></ofd:Content></ofd:Page>`
    },
    {
      name: 'Doc_0/Pages/Page_1/Content.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:Page xmlns:ofd="${NS}">` +
        `<ofd:Area><ofd:PhysicalBox>0 0 148 210</ofd:PhysicalBox></ofd:Area>` +
        `<ofd:Content><ofd:Layer ID="2"><ofd:TextObject ID="21" Font="1" Size="3.5278" Boundary="10 10 100 8">` +
        `<ofd:TextCode X="0" Y="6">第二页</ofd:TextCode></ofd:TextObject></ofd:Layer></ofd:Content></ofd:Page>`
    },
    {
      name: 'Doc_0/Tpls/Tpl_0/Content.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:Page xmlns:ofd="${NS}">` +
        `<ofd:Area><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:Area>` +
        `<ofd:Content><ofd:Layer ID="5"><ofd:PathObject ID="5" Boundary="0 0 210 40" Fill="true" Stroke="false">` +
        `<ofd:FillColor Value="230 230 230"/>` +
        `<ofd:AbbreviatedData>M 0 0 L 210 0 L 210 40 L 0 40 C</ofd:AbbreviatedData>` +
        `</ofd:PathObject></ofd:Layer></ofd:Content></ofd:Page>`
    },
    { name: 'Doc_0/Res/image_0.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
    { name: 'Doc_0/Res/font_0.ttf', data: new Uint8Array([0, 1, 0, 0]) }
  ]
}

async function writeFixture(entries: ZipWriteEntry[] = fixtureEntries()): Promise<string> {
  const target = join(dir, 'sample.ofd')
  await writeZipStored(target, entries)
  return target
}

async function parseFixture(entries?: ZipWriteEntry[]): Promise<ReturnType<typeof parseOfdPackage>> {
  return parseOfdPackage(readZipEntries(new Uint8Array(readFileSync(await writeFixture(entries)))))
}

describe('parseAbbreviatedData', () => {
  it('解析真实发票里的线段路径', () => {
    const commands = parseAbbreviatedData('M 0 297.64 L 595.28 297.64 L 595.28 0 L 0 0 C')
    expect(commands.map((c) => c.op)).toEqual(['M', 'L', 'L', 'L', 'C'])
    expect(commands[0].args).toEqual([0, 297.64])
    expect(commands[4].args).toEqual([])
  })

  it('S 归一化为 M', () => {
    expect(parseAbbreviatedData('S 1 2 L 3 4').map((c) => c.op)).toEqual(['M', 'L'])
  })

  it('Q / B / A 的操作数个数正确', () => {
    expect(parseAbbreviatedData('Q 1 2 3 4')[0].args).toHaveLength(4)
    expect(parseAbbreviatedData('B 1 2 3 4 5 6')[0].args).toHaveLength(6)
    expect(parseAbbreviatedData('A 1 2 0 1 1 3 4')[0].args).toHaveLength(7)
  })

  it('空串得到空命令表', () => {
    expect(parseAbbreviatedData('   ')).toEqual([])
  })

  it('非法 token 与缺操作数都报错', () => {
    expect(() => parseAbbreviatedData('M 1 2 X 3')).toThrow('路径数据无效:X')
    expect(() => parseAbbreviatedData('L 1')).toThrow('路径数据无效')
  })
})

describe('文本与颜色解析', () => {
  it('解码 \\XXXX 转义', () => {
    expect(unescapeTextCode('A\\0020B')).toBe('A B')
    expect(unescapeTextCode('无转义')).toBe('无转义')
  })

  it('颜色支持灰 / RGB / CMYK 与 Alpha', () => {
    expect(colorOf('0 0 0', 255)).toEqual({ r: 0, g: 0, b: 0, alpha: 1 })
    expect(colorOf('128', 255)).toEqual({ r: 128 / 255, g: 128 / 255, b: 128 / 255, alpha: 1 })
    expect(colorOf('255 0 0', 128)?.alpha).toBeCloseTo(128 / 255, 6)
    const cmyk = colorOf('0 255 255 0', 255)
    expect(cmyk?.r).toBeCloseTo(1, 6)
    expect(cmyk?.g).toBeCloseTo(0, 6)
    expect(colorOf(null, 255)).toBeNull()
    expect(colorOf('1 2', 255)).toBeNull()
  })
})

describe('resolveLoc', () => {
  it('绝对路径从包根解析,相对路径带 . 与 .. 归一化', () => {
    expect(resolveLoc('Doc_0', '/Pages/P1/Content.xml')).toBe('Pages/P1/Content.xml')
    expect(resolveLoc('Doc_0', 'Pages/Page_0/Content.xml')).toBe('Doc_0/Pages/Page_0/Content.xml')
    expect(resolveLoc('Doc_0/Pages', '../Res/image_0.png')).toBe('Doc_0/Res/image_0.png')
    expect(resolveLoc('Doc_0/Res', './image_0.png')).toBe('Doc_0/Res/image_0.png')
  })
})

describe('detectDocumentKind', () => {
  it('识别 OFD / 其它 ZIP / 非 ZIP', async () => {
    const ofd = new Uint8Array(readFileSync(await writeFixture()))
    expect(detectDocumentKind(ofd)).toBe('ofd')
    const notOfd = join(dir, 'plain.zip')
    await writeZipStored(notOfd, [{ name: 'readme.txt', data: 'x' }])
    expect(detectDocumentKind(new Uint8Array(readFileSync(notOfd)))).toBe('other')
    expect(detectDocumentKind(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('pdf')
    expect(detectDocumentKind(new Uint8Array([1, 2, 3, 4, 5]))).toBe('pdf')
  })
})

describe('parseOfdPackage', () => {
  it('解析页、资源、模板与绘制参数', async () => {
    const pkg = await parseFixture()
    expect(pkg.pages).toHaveLength(2)
    expect(pkg.box).toEqual({ x: 0, y: 0, w: 210, h: 297 })
    // 第 2 页用「目录形式」BaseLoc:必须回退到 <BaseLoc>/Content.xml
    expect(pkg.pages[1].box).toEqual({ x: 0, y: 0, w: 148, h: 210 })
    expect(pkg.pages[1].id).toBe('2')

    expect(pkg.fonts.get('1')?.fontName).toBe('黑体')
    expect(pkg.fonts.get('1')?.fontFile).toBeNull()
    // FontFile 相对 Res 文件的 BaseLoc(Res)解析
    expect(pkg.fonts.get('3')?.fontFile).toBe('Doc_0/Res/font_0.ttf')
    // 非 Image 类型的多媒体不进图片资源表
    expect([...pkg.images.keys()]).toEqual(['2'])
    expect(pkg.images.get('2')?.path).toBe('Doc_0/Res/image_0.png')

    expect(pkg.templates.get('9')).toBe('Doc_0/Tpls/Tpl_0/Content.xml')
    expect(pkg.templatePages.get('9')?.layers[0].objects).toHaveLength(1)
    expect(pkg.pages[0].templates).toEqual([{ id: '9', zOrder: 'Background' }])
  })

  it('图元对象按文档顺序收集,页面块原地展开', async () => {
    const pkg = await parseFixture()
    const objects = pkg.pages[0].layers[0].objects
    expect(objects.map((o) => o.kind)).toEqual(['image', 'text', 'path', 'text'])
    expect(objects.map((o) => o.id)).toEqual(['13', '11', '12', '14'])
  })

  it('文字对象保留定位/字号/颜色,并解码转义', async () => {
    const text = (await parseFixture()).pages[0].layers[0].objects[1]
    if (text.kind !== 'text') throw new Error('期望文字对象')
    expect(text.fontId).toBe('1')
    expect(text.size).toBeCloseTo(5.6444, 6)
    expect(text.boundary).toEqual({ x: 20, y: 30, w: 150, h: 12 })
    expect(text.fillColor).toEqual({ r: 0, g: 0, b: 0, alpha: 1 })
    expect(text.codes[0].text).toBe('OFD-测试文本 2026')
    expect(text.codes[0].x).toBe(0)
    expect(text.codes[0].y).toBe(10)
    expect(text.codes[0].deltaX).toEqual([5.6444, 5.6444])
  })

  it('路径对象继承图层 DrawParam 的线宽与勾边色', async () => {
    const path = (await parseFixture()).pages[0].layers[0].objects[2]
    if (path.kind !== 'path') throw new Error('期望图形对象')
    expect(path.fill).toBe(false)
    expect(path.stroke).toBe(true)
    expect(path.lineWidth).toBeCloseTo(0.25, 6)
    expect(path.strokeColor.r).toBeCloseTo(156 / 255, 6)
    expect(path.commands.map((c) => c.op)).toEqual(['M', 'L', 'L', 'L', 'C'])
  })

  it('DeltaX 支持游程写法 g <次数> <值>(真实生成器普遍使用)', async () => {
    const entries = fixtureEntries()
    const content = entries.find((entry) => entry.name === 'Doc_0/Pages/Page_0/Content.xml')
    if (!content || typeof content.data !== 'string') throw new Error('夹具结构变化')
    content.data = content.data.replace('DeltaX="5.6444 5.6444"', 'DeltaX="g 2 5.6444 1.5 g 3 2.5"')
    const text = (await parseFixture(entries)).pages[0].layers[0].objects[1]
    if (text.kind !== 'text') throw new Error('期望文字对象')
    // g 2 5.6444 → 两次 5.6444;1.5 → 单值;g 3 2.5 → 三次 2.5
    expect(text.codes[0].deltaX).toEqual([5.6444, 5.6444, 1.5, 2.5, 2.5, 2.5])
    expect(text.codes[0].deltaInvalid).toBeUndefined()
  })

  it('DeltaX 含无法识别的 token 时整段作废(退回自然步进),不静默错位', async () => {
    const entries = fixtureEntries()
    const content = entries.find((entry) => entry.name === 'Doc_0/Pages/Page_0/Content.xml')
    if (!content || typeof content.data !== 'string') throw new Error('夹具结构变化')
    content.data = content.data.replace('DeltaX="5.6444 5.6444"', 'DeltaX="q 2 5.6444"')
    const text = (await parseFixture(entries)).pages[0].layers[0].objects[1]
    if (text.kind !== 'text') throw new Error('期望文字对象')
    expect(text.codes[0].deltaX).toBeUndefined()
    expect(text.codes[0].deltaInvalid).toBe(true)
  })
})

describe('结构缺陷', () => {
  it('缺 OFD.xml / DocRoot / Pages 分别给出中文原因', async () => {
    await expect(parseFixture([{ name: 'readme.txt', data: 'x' }])).rejects.toThrow('包内缺少 OFD.xml')

    const noRoot = fixtureEntries().filter((entry) => entry.name !== 'OFD.xml')
    noRoot.push({ name: 'OFD.xml', data: `<ofd:OFD xmlns:ofd="${NS}"><ofd:DocBody/></ofd:OFD>` })
    await expect(parseFixture(noRoot)).rejects.toThrow('缺少 DocBody/DocRoot')

    const noPages = fixtureEntries().map((entry) =>
      entry.name === 'Doc_0/Document.xml'
        ? {
            ...entry,
            data: (entry.data as string).replace(/<ofd:Pages>[\s\S]*<\/ofd:Pages>/, '')
          }
        : entry
    )
    await expect(parseFixture(noPages)).rejects.toThrow('缺少 Pages')
  })

  it('DocRoot 指向的文件不在包内时报错', async () => {
    const entries = fixtureEntries().map((entry) =>
      entry.name === 'OFD.xml'
        ? { ...entry, data: (entry.data as string).replace('Doc_0/Document.xml', 'Doc_0/Missing.xml') }
        : entry
    )
    await expect(parseFixture(entries)).rejects.toThrow('包内缺少 Doc_0/Missing.xml')
  })
})
