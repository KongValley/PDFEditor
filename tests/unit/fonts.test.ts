import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument } from 'pdf-lib'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Annotation } from '../../src/shared/types'

function buildNameTable(
  entries: Array<{ platform: number; encoding: number; language: number; nameId: number; text: string }>
): Buffer {
  const encoded = entries.map((entry) => {
    if (entry.platform === 3) {
      const bytes = Buffer.from(entry.text, 'utf16le')
      bytes.swap16()
      return bytes
    }
    return Buffer.from(entry.text, 'latin1')
  })
  const headerSize = 6 + entries.length * 12
  const out = Buffer.alloc(headerSize + encoded.reduce((sum, bytes) => sum + bytes.length, 0))
  out.writeUInt16BE(0, 0)
  out.writeUInt16BE(entries.length, 2)
  out.writeUInt16BE(headerSize, 4)
  let stringOffset = 0
  entries.forEach((entry, index) => {
    const recordAt = 6 + index * 12
    out.writeUInt16BE(entry.platform, recordAt)
    out.writeUInt16BE(entry.encoding, recordAt + 2)
    out.writeUInt16BE(entry.language, recordAt + 4)
    out.writeUInt16BE(entry.nameId, recordAt + 6)
    out.writeUInt16BE(encoded[index].length, recordAt + 8)
    out.writeUInt16BE(stringOffset, recordAt + 10)
    encoded[index].copy(out, headerSize + stringOffset)
    stringOffset += encoded[index].length
  })
  return out
}

/** 最小 TTC:1 面、head + name 两张表 */
function buildTtc(): Buffer {
  const head = Buffer.alloc(54)
  head.writeUInt32BE(0x00010000, 0)
  head.writeUInt32BE(0x00010000, 4)
  const name = buildNameTable([
    { platform: 3, encoding: 1, language: 0x0409, nameId: 1, text: 'TestFace' },
    { platform: 3, encoding: 1, language: 0x0804, nameId: 1, text: '测试字体' },
    { platform: 3, encoding: 1, language: 0x0409, nameId: 6, text: 'TestFace-Regular' }
  ])
  const numTables = 2
  const faceOffset = 16
  const headOffset = faceOffset + 12 + numTables * 16
  const nameOffset = headOffset + 56
  const out = Buffer.alloc(nameOffset + name.length)
  out.write('ttcf', 0, 'ascii')
  out.writeUInt32BE(0x00010000, 4)
  out.writeUInt32BE(1, 8)
  out.writeUInt32BE(faceOffset, 12)

  out.writeUInt32BE(0x00010000, faceOffset)
  out.writeUInt16BE(numTables, faceOffset + 4)
  out.writeUInt16BE(0, faceOffset + 6)
  out.writeUInt16BE(0, faceOffset + 8)
  out.writeUInt16BE(0, faceOffset + 10)

  const writeRecord = (index: number, tag: string, offset: number, length: number): void => {
    const recordAt = faceOffset + 12 + index * 16
    out.write(tag, recordAt, 4, 'ascii')
    out.writeUInt32BE(0, recordAt + 4)
    out.writeUInt32BE(offset, recordAt + 8)
    out.writeUInt32BE(length, recordAt + 12)
  }
  writeRecord(0, 'head', headOffset, head.length)
  writeRecord(1, 'name', nameOffset, name.length)
  head.copy(out, headOffset)
  name.copy(out, nameOffset)
  return out
}

/** 本机可用的真实字体(CI 上由 PDF_EDITOR_CJK_FONT 指向下载的思源黑体) */
function sampleFontFile(): string | null {
  const candidates = [
    process.env['PDF_EDITOR_CJK_FONT'],
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/simkai.ttf',
    'C:/Windows/Fonts/segoeui.ttf'
  ]
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null
}

/** 自定义字体用例尽量避开内置默认字体(simhei),让「按注释字体嵌入」这条路径真的被执行 */
function customSampleFontFile(): string | null {
  const candidates = [
    // 优先 TTC:完整走一遍「集合抽单面 → pdf-lib 嵌入」
    'C:/Windows/Fonts/simsun.ttc',
    'C:/Windows/Fonts/simkai.ttf',
    process.env['PDF_EDITOR_CJK_FONT'],
    'C:/Windows/Fonts/simhei.ttf'
  ]
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null
}

describe('字体 name 表解析', () => {
  it('解析英文族名、中文本地化名与 PostScript 名', async () => {
    const { parseNameTable } = await import('../../src/main/lib/fonts')
    const records = parseNameTable(
      buildNameTable([
        { platform: 3, encoding: 1, language: 0x0409, nameId: 1, text: 'TestFace' },
        { platform: 3, encoding: 1, language: 0x0804, nameId: 1, text: '测试字体' },
        { platform: 3, encoding: 1, language: 0x0409, nameId: 6, text: 'TestFace-Regular' }
      ])
    )
    expect(records.find((record) => record.nameID === 1 && record.languageID === 0x0409)?.text).toBe('TestFace')
    expect(records.find((record) => record.nameID === 1 && record.languageID === 0x0804)?.text).toBe('测试字体')
    expect(records.find((record) => record.nameID === 6)?.text).toBe('TestFace-Regular')
  })
})

describe('TTC 字体抽取', () => {
  it('抽出独立 sfnt,保留表数据并重算校验和', async () => {
    const { extractFaceFromCollection } = await import('../../src/main/lib/fonts')
    const ttc = buildTtc()
    const face = extractFaceFromCollection(ttc, 0)
    expect(face.readUInt32BE(0)).toBe(0x00010000)
    expect(face.readUInt16BE(4)).toBe(2)
    expect(face.toString('ascii', 12, 16)).toBe('head')
    expect(face.toString('ascii', 28, 32)).toBe('name')

    let sum = 0
    for (let i = 0; i < face.length; i += 4) sum = (sum + face.readUInt32BE(i)) >>> 0
    expect(sum).toBe(0xb1b0afba)
  })

  it('非集合字体原样返回,非法索引报错', async () => {
    const { extractFaceFromCollection } = await import('../../src/main/lib/fonts')
    const sfnt = Buffer.alloc(16)
    expect(extractFaceFromCollection(sfnt, 0)).toBe(sfnt)
    expect(() => extractFaceFromCollection(buildTtc(), 3)).toThrow()
  })

  it('真实 TTC(微软雅黑,若本机存在)可被 fontkit 重新解析', async () => {
    const path = 'C:/Windows/Fonts/msyh.ttc'
    if (!existsSync(path)) return
    const { extractFaceFromCollection } = await import('../../src/main/lib/fonts')
    const face = extractFaceFromCollection(await readFile(path), 0)
    expect(face.readUInt32BE(0)).not.toBe(0x74746366)
    const parsed = fontkit.create(face)
    expect(parsed.familyName).toBeTruthy()
  })
})

describe('系统字体枚举与读取', () => {
  let tempDir: string | null = null
  const fontFile = sampleFontFile()

  beforeAll(async () => {
    if (!fontFile) return
    tempDir = await mkdtemp(join(tmpdir(), 'pdf-editor-fonts-'))
    await copyFile(fontFile, join(tempDir, `sample${extname(fontFile)}`))
    process.env['PDF_EDITOR_EXTRA_FONT_DIRS'] = tempDir
  })

  afterEach(async () => {
    const { resetSystemFontCache } = await import('../../src/main/lib/fonts')
    resetSystemFontCache()
  })

  afterAll(async () => {
    delete process.env['PDF_EDITOR_EXTRA_FONT_DIRS']
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    const { resetSystemFontCache } = await import('../../src/main/lib/fonts')
    resetSystemFontCache()
  })

  it('枚举字体并可按本地化名/英文名查找', async () => {
    if (!fontFile || !tempDir) return
    const { findSystemFont, listSystemFonts, parseFontFile } = await import('../../src/main/lib/fonts')
    const faces = await parseFontFile(fontFile)
    expect(faces.length).toBeGreaterThan(0)
    expect(faces[0].family).not.toBe('')

    const fonts = await listSystemFonts()
    expect(fonts.some((font) => font.family === faces[0].family)).toBe(true)

    const byFamily = await findSystemFont(faces[0].family)
    expect(byFamily?.family).toBe(faces[0].family)
    const byLabel = await findSystemFont(faces[0].label)
    expect(byLabel?.family).toBe(faces[0].family)

    if (byFamily) {
      const { readSystemFontBytes } = await import('../../src/main/lib/fonts')
      const bytes = await readSystemFontBytes(byFamily)
      expect(bytes.length).toBeGreaterThan(0)
      // 读出来的一定是单面 sfnt,而不是 TTC 容器
      expect(bytes.readUInt32BE(0)).not.toBe(0x74746366)
    }
  })
})

describe('按注释字体写入 PDF', () => {
  const fontFile = customSampleFontFile()

  afterEach(async () => {
    delete process.env['PDF_EDITOR_EXTRA_FONT_DIRS']
    const { resetSystemFontCache } = await import('../../src/main/lib/fonts')
    resetSystemFontCache()
  })

  it('嵌入所选系统字体并保留 fontFamily 元数据', async () => {
    if (!fontFile) return
    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-editor-font-embed-'))
    await copyFile(fontFile, join(tempDir, `sample${extname(fontFile)}`))
    process.env['PDF_EDITOR_EXTRA_FONT_DIRS'] = tempDir

    try {
      const { parseFontFile, resetSystemFontCache } = await import('../../src/main/lib/fonts')
      resetSystemFontCache()
      const faces = await parseFontFile(join(tempDir, `sample${extname(fontFile)}`))
      const family = faces[0].family

      const annotation: Annotation = {
        id: 'font-text',
        kind: 'text',
        page: 0,
        bbox: { x: 50, y: 600, w: 240, h: 60 },
        color: '#212529',
        opacity: 1,
        createdAt: 0,
        text: '自定义字体 ABC 123',
        fontSize: 16,
        rotate: 0,
        fontFamily: family
      }
      const doc = await PDFDocument.create()
      doc.addPage([595, 842])
      const source = Buffer.from(await doc.save())

      const { extractEditorAnnotations, writeAnnotations } = await import('../../src/main/lib/pdflibwrite')
      const result = await writeAnnotations(source, {
        annotations: [annotation],
        formValues: {},
        resolveImage: async () => undefined
      })
      expect(result.warnings.some((warning) => warning.includes(`未找到字体「${family}」`))).toBe(false)
      expect(result.warnings.some((warning) => warning.includes('嵌入失败'))).toBe(false)

      const read = extractEditorAnnotations(await PDFDocument.load(result.bytes))
      expect(read).toHaveLength(1)
      expect(read[0].kind).toBe('text')
      expect((read[0] as Annotation & { fontFamily?: string }).fontFamily).toBe(family)
      // 字体子集嵌入后产物应明显大于空白页
      expect(result.bytes.length).toBeGreaterThan(source.length + 1000)
      // PostScript 名会以 BaseFont 形式写进 PDF:确认用的确实是所选字体(而不是默认字体)
      if (faces[0].postscriptName) {
        expect(result.bytes.toString('latin1')).toContain(faces[0].postscriptName.slice(0, 8))
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('字体不存在时回退默认字体并给出警告,注释内容不丢', async () => {
    const annotation: Annotation = {
      id: 'missing-font-text',
      kind: 'text',
      page: 0,
      bbox: { x: 50, y: 600, w: 240, h: 60 },
      color: '#212529',
      opacity: 1,
      createdAt: 0,
      text: 'Fallback ABC',
      fontSize: 16,
      rotate: 0,
      fontFamily: 'Definitely-Not-Installed-Font-XYZ'
    }
    const doc = await PDFDocument.create()
    doc.addPage([595, 842])
    const { extractEditorAnnotations, writeAnnotations } = await import('../../src/main/lib/pdflibwrite')
    const result = await writeAnnotations(Buffer.from(await doc.save()), {
      annotations: [annotation],
      formValues: {},
      resolveImage: async () => undefined
    })
    expect(
      result.warnings.some((warning) => warning.includes('未找到字体「Definitely-Not-Installed-Font-XYZ」'))
    ).toBe(true)
    const read = extractEditorAnnotations(await PDFDocument.load(result.bytes))
    expect(read).toHaveLength(1)
    expect(read[0].kind).toBe('text')
    expect((read[0] as Annotation & { fontFamily?: string }).fontFamily).toBe('Definitely-Not-Installed-Font-XYZ')
  })
})
