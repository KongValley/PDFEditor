import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, inflateRawSync, inflateSync } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeOfdFromImages } from '../../src/main/lib/ofd/frompdf'
import { parseOfdPackage } from '../../src/main/lib/ofd/model'
import { convertOfdToPdf } from '../../src/main/lib/ofd/topdf'
import { crc32, readZipEntries, writeZipStored, type ZipWriteEntry } from '../../src/main/lib/ofd/zip'

const NS = 'http://www.ofdspec.org/2016'
const MM_TO_PT = 72 / 25.4

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ofd-convert-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 真实可解码的 PNG(1×1 红色):png 头必须过 pdf-lib 的 embedPng 校验 */
function makePng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBytes = Buffer.from(type, 'ascii')
    const body = Buffer.concat([typeBytes, data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  // IDAT 必须是 zlib 包装(deflateSync),不是 ZIP 用的裸 deflate
  const idat = deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00]))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function contentFixture(): ZipWriteEntry[] {
  const png = makePng()
  return [
    {
      name: 'OFD.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:OFD xmlns:ofd="${NS}" DocType="OFD" Version="1.0">` +
        `<ofd:DocBody><ofd:DocInfo><ofd:DocID>x</ofd:DocID></ofd:DocInfo>` +
        `<ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`
    },
    {
      name: 'Doc_0/Document.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:Document xmlns:ofd="${NS}"><ofd:CommonData>` +
        `<ofd:MaxUnitID>30</ofd:MaxUnitID>` +
        `<ofd:TemplatePage ID="9" BaseLoc="Tpls/Tpl_0/Content.xml"/>` +
        `<ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea>` +
        `<ofd:PublicRes>PublicRes.xml</ofd:PublicRes><ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes>` +
        `</ofd:CommonData><ofd:Pages><ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/></ofd:Pages>` +
        `<ofd:Annotations>Annots/Annotations.xml</ofd:Annotations></ofd:Document>`
    },
    {
      name: 'Doc_0/PublicRes.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:Res xmlns:ofd="${NS}" BaseLoc="Res"><ofd:Fonts>` +
        `<ofd:Font ID="1" FontName="黑体" FamilyName="SimHei" Charset="unicode"/>` +
        `<ofd:Font ID="2" FontName="Courier New"/>` +
        `</ofd:Fonts></ofd:Res>`
    },
    {
      name: 'Doc_0/DocumentRes.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:Res xmlns:ofd="${NS}" BaseLoc="Res"><ofd:MultiMedias>` +
        `<ofd:MultiMedia ID="2" Type="Image" Format="PNG"><ofd:MediaFile>image_0.png</ofd:MediaFile></ofd:MultiMedia>` +
        `<ofd:MultiMedia ID="3" Type="Image" Format="BMP"><ofd:MediaFile>image_1.bmp</ofd:MediaFile></ofd:MultiMedia>` +
        `</ofd:MultiMedias></ofd:Res>`
    },
    {
      name: 'Doc_0/Pages/Page_0/Content.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:Page xmlns:ofd="${NS}">` +
        `<ofd:Area><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:Area>` +
        `<ofd:Template ID="9" ZOrder="Background"/>` +
        `<ofd:Content><ofd:Layer ID="1">` +
        `<ofd:TextObject ID="11" Font="2" Size="5.6444" Boundary="20 30 100 12">` +
        `<ofd:TextCode X="0" Y="10">ASCII-TEXT</ofd:TextCode></ofd:TextObject>` +
        `<ofd:TextObject ID="12" Font="1" Size="5.6444" Boundary="20 50 100 12" Stroke="true">` +
        `<ofd:TextCode X="0" Y="10">中文文本</ofd:TextCode></ofd:TextObject>` +
        `<ofd:PathObject ID="13" Boundary="20 80 170 40" Fill="false" Stroke="true" LineWidth="0.5">` +
        `<ofd:StrokeColor Value="0 0 0"/>` +
        `<ofd:AbbreviatedData>M 0 0 L 170 0 L 170 40 L 0 40 C</ofd:AbbreviatedData></ofd:PathObject>` +
        // 渐变填充:只有 FillColor 元素没有 Value → 绘制侧拿不到颜色,必须告警而不是静默丢图
        `<ofd:PathObject ID="16" Boundary="20 130 60 20" Fill="true" Stroke="false">` +
        `<ofd:FillColor><ofd:AxialShd StartPoint="0 0" EndPoint="60 0"/></ofd:FillColor>` +
        `<ofd:AbbreviatedData>M 0 0 L 60 0 L 60 20 L 0 20 C</ofd:AbbreviatedData></ofd:PathObject>` +
        `<ofd:ImageObject ID="14" Boundary="150 200 30 30" ResourceID="2"/>` +
        `<ofd:ImageObject ID="15" Boundary="10 200 30 30" ResourceID="3"/>` +
        // CTM 缩放(真实转换器常见:路径/文字坐标用 pt,再乘 ~0.3528 变成 mm)
        `<ofd:TextObject ID="17" Font="2" Size="5.6444" Boundary="0 0 200 120" CTM="0.3527778 0 0 0.3527778 0 0">` +
        `<ofd:TextCode X="200" Y="100">CTM</ofd:TextCode></ofd:TextObject>` +
        `</ofd:Layer></ofd:Content></ofd:Page>`
    },
    {
      name: 'Doc_0/Annots/Annotations.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:Annotations xmlns:ofd="${NS}">` +
        `<ofd:Page PageID="1"><ofd:FileLoc>Page_0/Annotation.xml</ofd:FileLoc></ofd:Page>` +
        `</ofd:Annotations>`
    },
    {
      name: 'Doc_0/Annots/Page_0/Annotation.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><ofd:PageAnnot xmlns:ofd="${NS}">` +
        // 签章:Appearance 里带一张图片(子对象坐标相对 Appearance 的 Boundary)
        `<ofd:Annot ID="7000" Type="Stamp" Subtype="SignatureInFile">` +
        `<ofd:Appearance Boundary="150 200 30 30">` +
        `<ofd:ImageObject ID="90" Boundary="0 0 30 30" ResourceID="2"/></ofd:Appearance></ofd:Annot>` +
        // 只有签名引用、没有呈现内容的签章:必须告警而不是静默丢
        `<ofd:Annot ID="7001" Type="Stamp" Subtype="SignatureInFile">` +
        `<ofd:Appearance Boundary="10 10 20 20"/></ofd:Annot>` +
        // 不可见注释:不绘制
        `<ofd:Annot ID="7002" Type="Watermark" Visible="false">` +
        `<ofd:Appearance Boundary="0 0 10 10"><ofd:PathObject ID="91" Boundary="0 0 10 10" Fill="true">` +
        `<ofd:FillColor Value="0 0 0"/>` +
        `<ofd:AbbreviatedData>M 0 0 L 10 0 L 10 10 L 0 10 C</ofd:AbbreviatedData>` +
        `</ofd:PathObject></ofd:Appearance></ofd:Annot>` +
        `</ofd:PageAnnot>`
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
    { name: 'Doc_0/Res/image_0.png', data: png },
    { name: 'Doc_0/Res/image_1.bmp', data: Buffer.from([0x42, 0x4d, 1, 2, 3]) }
  ]
}

async function writeFixture(entries: ZipWriteEntry[]): Promise<string> {
  const target = join(dir, 'fixture.ofd')
  await writeZipStored(target, entries)
  return target
}

/** 已保存 PDF 的原始字节按 latin1 读:字典等未压缩部分可直接查字符串 */
function pdfText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1')
}

/**
 * 内容流是 FlateDecode 的(pdf-lib 的 PDFContentStream 继承自 flate 流),
 * 因此逐个 stream/endstream 段 inflateRaw 后再查算符。
 */
function contentText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes)
  const parts: string[] = []
  let at = 0
  for (;;) {
    const marker = buf.indexOf('stream', at)
    if (marker < 0) break
    // 'endstream' 里也含 'stream':前一个字符是 d 就跳过
    if (buf[marker - 1] === 0x64) {
      at = marker + 6
      continue
    }
    let dataStart = marker + 6
    if (buf[dataStart] === 0x0d) dataStart++
    if (buf[dataStart] === 0x0a) dataStart++
    const end = buf.indexOf('endstream', dataStart)
    if (end < 0) break
    const raw = buf.subarray(dataStart, end)
    try {
      // PDF 的 FlateDecode 是 zlib 包装(RFC1950);个别流可能是裸 deflate
      parts.push(inflateSync(raw).toString('latin1'))
    } catch {
      try {
        parts.push(inflateRawSync(raw).toString('latin1'))
      } catch {
        // 非 flate 流(或图片二进制)跳过
      }
    }
    at = end + 9
  }
  return parts.join('\n')
}

describe('writeOfdFromImages', () => {
  it('生成结构完整的 OFD,且能被自己的解析器读回', async () => {
    const png = join(dir, 'page-0.png')
    writeFileSync(png, makePng())
    const target = join(dir, 'out.ofd')
    await writeOfdFromImages(
      target,
      [
        { filePath: png, widthMm: 210, heightMm: 297 },
        { filePath: png, widthMm: 148, heightMm: 210 }
      ],
      { title: '测试文档', creator: 'PDF 编辑器' }
    )

    const entries = readZipEntries(new Uint8Array(readFileSync(target)))
    // CT_DocInfo 是 xs:sequence:Creator 必须排在 CreationDate 之后
    const metaXml = new TextDecoder().decode(entries.get('OFD.xml'))
    expect(metaXml.indexOf('<ofd:CreationDate>')).toBeLessThan(metaXml.indexOf('<ofd:Creator>'))
    expect([...entries.keys()].sort()).toEqual(
      [
        'OFD.xml',
        'Doc_0/Document.xml',
        'Doc_0/DocumentRes.xml',
        'Doc_0/Pages/Page_0/Content.xml',
        'Doc_0/Pages/Page_1/Content.xml',
        'Doc_0/Res/image_0.png',
        'Doc_0/Res/image_1.png'
      ].sort()
    )
    // MediaFile 必须能在包内解析到(相对 Res 的 BaseLoc)
    const pkg = parseOfdPackage(entries)
    expect(pkg.pages).toHaveLength(2)
    expect(pkg.pages[0].box).toEqual({ x: 0, y: 0, w: 210, h: 297 })
    expect(pkg.pages[1].box).toEqual({ x: 0, y: 0, w: 148, h: 210 })
    expect(pkg.images.get('2000')?.path).toBe('Doc_0/Res/image_0.png')
    expect(pkg.pages[0].layers[0].objects[0].kind).toBe('image')
  })

  it('文本层:不可见 TextObject + 字体资源 + DeltaX,可被自己读回', async () => {
    const png = join(dir, 'page-0.png')
    writeFileSync(png, makePng())
    const target = join(dir, 'text-layer.ofd')
    const run = (text: string, baselineMm: number, widthMm: number) => ({
      text,
      xMm: 20,
      baselineMm,
      sizeMm: 5.6444,
      widthMm,
      family: 'SimSun',
      ascent: 0.8
    })
    await writeOfdFromImages(target, [
      {
        filePath: png,
        widthMm: 210,
        heightMm: 297,
        texts: [run('Hello & <world>', 30, 60), run('X', 40, 4)]
      }
    ])

    const entries = readZipEntries(new Uint8Array(readFileSync(target)))
    const decoder = new TextDecoder()
    const pageXml = decoder.decode(entries.get('Doc_0/Pages/Page_0/Content.xml'))
    const resXml = decoder.decode(entries.get('Doc_0/DocumentRes.xml'))

    // 字体资源只声明不内嵌(文字不可见,无需字形);按规范表格顺序写 Fonts → MultiMedias
    expect(resXml).toContain('<ofd:Fonts>')
    expect(resXml.indexOf('<ofd:Fonts>')).toBeLessThan(resXml.indexOf('<ofd:MultiMedias>'))
    expect(resXml).toContain('FontName="SimSun"')
    expect(resXml).not.toContain('<ofd:FontFile>')
    // 不可见:对象与 FillColor 都要 Alpha=0
    expect(pageXml).toContain('Alpha="0"')
    expect(pageXml).toContain('<ofd:FillColor Value="0 0 0" Alpha="0"/>')
    // 文字必须 XML 转义,否则包直接损坏
    expect(pageXml).toContain('Hello &amp; &lt;world&gt;')
    // DeltaX 条目数 = 字符数 - 1;单字符段不写 DeltaX
    const deltas = pageXml.match(/DeltaX="([^"]*)"/g) ?? []
    expect(deltas).toHaveLength(1)
    expect((deltas[0] ?? '').replace(/^DeltaX="|"$/g, '').split(' ')).toHaveLength([...'Hello & <world>'].length - 1)

    // 自己读回:文字、字号、位置都在
    const pkg = parseOfdPackage(entries)
    const texts = pkg.pages[0].layers[0].objects.filter((object) => object.kind === 'text')
    expect(texts).toHaveLength(2)
    const first = texts[0]
    if (first.kind !== 'text') throw new Error('期望文字对象')
    expect(first.codes[0].text).toBe('Hello & <world>')
    expect(first.size).toBeCloseTo(5.6444, 4)
    expect(first.boundary.x).toBeCloseTo(20, 4)
    // 基线 = Boundary 顶 + ascent*size = 30mm
    expect(first.boundary.y + (first.codes[0].y ?? 0)).toBeCloseTo(30, 4)

    // 转成 PDF 后文字仍在(可检索的前提)
    const converted = await convertOfdToPdf(new Uint8Array(readFileSync(target)))
    if (!converted.ok) throw new Error(converted.error)
    expect(contentText(converted.bytes)).toContain('Tj')
  })

  it('没有页面时直接报错,不产出空包', async () => {
    await expect(writeOfdFromImages(join(dir, 'empty.ofd'), [])).rejects.toThrow('没有可导出的页面')
  })

  it('导出 → 重新导入闭环:页数与页尺寸保持一致', async () => {
    const png = join(dir, 'page-0.png')
    writeFileSync(png, makePng())
    const target = join(dir, 'roundtrip.ofd')
    await writeOfdFromImages(target, [
      { filePath: png, widthMm: 210, heightMm: 297 },
      { filePath: png, widthMm: 148, heightMm: 210 }
    ])

    const converted = await convertOfdToPdf(new Uint8Array(readFileSync(target)))
    if (!converted.ok) throw new Error(converted.error)
    expect(converted.pages).toBe(2)
    const pdf = await PDFDocument.load(converted.bytes)
    expect(pdf.getPageCount()).toBe(2)
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(210 * MM_TO_PT, 2)
    expect(pdf.getPage(0).getHeight()).toBeCloseTo(297 * MM_TO_PT, 2)
    expect(pdf.getPage(1).getWidth()).toBeCloseTo(148 * MM_TO_PT, 2)
  })
})

describe('convertOfdToPdf', () => {
  it('文字/路径/图片/模板都落到 PDF 内容流', async () => {
    const target = await writeFixture(contentFixture())
    const result = await convertOfdToPdf(new Uint8Array(readFileSync(target)))
    if (!result.ok) throw new Error(result.error)
    expect(result.pages).toBe(1)

    const text = pdfText(result.bytes)
    const content = contentText(result.bytes)
    // 文字(ASCII 走标准字体,与是否装了中文字体无关)
    expect(content).toContain('Tj')
    // 图片:PNG 作为 Image XObject 嵌入,并用 Do 绘制
    expect(text).toContain('/Subtype /Image')
    expect(content).toContain('Do')
    // 路径:矩形右边界 = Boundary.x(20mm) + 局部 x(170mm) = 190mm → 538.583pt
    expect(content).toContain('538.583')
    // 模板页的填充矩形也被绘制(宽 210mm)
    expect(content).toContain('595.276')
    // 填充与描边分别落到 f / S:模板是 Fill=true 无描边,矩形框是 Stroke=true 不填充
    expect(content).toContain('h\nf')
    expect(content).toContain('h\nS')
    // 不支持的 BMP 只告警不中断
    expect(result.warnings.some((warning) => warning.includes('不支持的图片格式'))).toBe(true)
    // 文字描边与渐变填充都不实现:必须如实告警,不能静默丢内容
    expect(result.warnings.some((warning) => warning.includes('文字描边'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('渐变/图案填充不支持'))).toBe(true)
    // 只有签名引用、没有呈现内容的签章:告警而不是静默丢
    expect(result.warnings.some((warning) => warning.includes('签章/注释只含签名引用'))).toBe(true)
    // CTM 缩放:TextCode X=200/Y=100 经 CTM(×0.3527778)后应落在 200pt / 741.89pt
    // (pdf-lib 会写成 200.00000000000003 这类浮点结果,故只校验数值前缀)
    expect(content).toMatch(/1 0 0 1 200[\d.]* 741\.\d+/)
    // 签章 Appearance 里的图片被绘制:两个 Do(页面图片 + 签章图片,同一资源只嵌入一次)
    expect(content.match(/\bDo\b/g)?.length).toBe(2)
  })

  it('注释(Appearance)按 Appearance 的 Boundary 平移后绘制,不可见注释不画', async () => {
    const target = await writeFixture(contentFixture())
    const pkg = parseOfdPackage(readZipEntries(new Uint8Array(readFileSync(target))))
    const annots = pkg.pages[0].annots
    expect(annots.map((annot) => annot.type)).toEqual(['Stamp', 'Stamp', 'Watermark'])
    expect(annots[0].emptyAppearance).toBe(false)
    expect(annots[0].objects).toHaveLength(1)
    // 子对象 Boundary 相对 Appearance:0,0 + (150,200) = 页面坐标
    expect(annots[0].objects[0].boundary).toEqual({ x: 150, y: 200, w: 30, h: 30 })
    expect(annots[1].emptyAppearance).toBe(true)
    expect(annots[2].visible).toBe(false)
  })

  it('缺中文字体时仍能转换,并如实告警跳过的字符数', async () => {
    const previous = process.env['PDF_EDITOR_SMOKE_CJK_FONT']
    process.env['PDF_EDITOR_SMOKE_CJK_FONT'] = 'none'
    try {
      const target = await writeFixture(contentFixture())
      const result = await convertOfdToPdf(new Uint8Array(readFileSync(target)))
      if (!result.ok) throw new Error(result.error)
      expect(result.pages).toBe(1)
      expect(result.warnings.some((warning) => warning.includes('缺少中文字体'))).toBe(true)
      // ASCII 文本仍被绘制
      expect(contentText(result.bytes)).toContain('Tj')
    } finally {
      if (previous === undefined) delete process.env['PDF_EDITOR_SMOKE_CJK_FONT']
      else process.env['PDF_EDITOR_SMOKE_CJK_FONT'] = previous
    }
  })

  it('不是 OFD 时给出中文错误而不是抛异常', async () => {
    const result = await convertOfdToPdf(new Uint8Array([1, 2, 3, 4]))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('不应成功')
    expect(result.error).toContain('OFD')
  })
})
