import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crc32, looksLikeZip, readZipEntries, writeZipStored, zipEntryNames } from '../../src/main/lib/ofd/zip'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ofd-zip-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 手工造一个 deflate(方法 8)单条目 ZIP:真实 OFD 绝大多数条目是压缩的 */
function makeDeflateZip(name: string, payload: Buffer): Buffer {
  const deflated = deflateRawSync(payload)
  const nameBytes = Buffer.from(name, 'utf8')
  const crc = crc32(payload)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(deflated.length, 18)
  local.writeUInt32LE(payload.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(deflated.length, 20)
  central.writeUInt32LE(payload.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt32LE(0, 42)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(46 + nameBytes.length, 12)
  eocd.writeUInt32LE(30 + nameBytes.length + deflated.length, 16)
  return Buffer.concat([local, nameBytes, deflated, central, nameBytes, eocd])
}

describe('crc32', () => {
  it('与 ZIP / PNG 标准测试向量一致', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
    expect(crc32(Buffer.from('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339)
  })
})

describe('writeZipStored / readZipEntries', () => {
  it('往返读写 STORE 条目(嵌套目录名 + 磁盘文件)', async () => {
    const image = join(dir, 'image_0.png')
    writeFileSync(image, Buffer.from([1, 2, 3, 4, 5]))
    const target = join(dir, 'out.ofd')
    await writeZipStored(target, [
      { name: 'OFD.xml', data: '<ofd:OFD/>' },
      { name: 'Doc_0/Pages/Page_0/Content.xml', data: '<ofd:Page/>' },
      { name: 'Doc_0/Res/image_0.png', filePath: image }
    ])

    const bytes = new Uint8Array(readFileSync(target))
    expect(looksLikeZip(bytes)).toBe(true)
    expect(zipEntryNames(bytes)).toEqual(['OFD.xml', 'Doc_0/Pages/Page_0/Content.xml', 'Doc_0/Res/image_0.png'])

    const entries = readZipEntries(bytes)
    const decoder = new TextDecoder()
    expect(decoder.decode(entries.get('OFD.xml'))).toBe('<ofd:OFD/>')
    expect(decoder.decode(entries.get('Doc_0/Pages/Page_0/Content.xml'))).toBe('<ofd:Page/>')
    expect(Array.from(entries.get('Doc_0/Res/image_0.png') as Uint8Array)).toEqual([1, 2, 3, 4, 5])
  })

  it('读取 deflate 压缩的条目', () => {
    const payload = Buffer.from('内容需要压缩后仍能还原'.repeat(20), 'utf8')
    const bytes = new Uint8Array(makeDeflateZip('Doc_0/Document.xml', payload))
    const entries = readZipEntries(bytes)
    expect(new TextDecoder().decode(entries.get('Doc_0/Document.xml'))).toBe(payload.toString('utf8'))
  })

  it('目录项不进结果', async () => {
    const target = join(dir, 'dirs.ofd')
    await writeZipStored(target, [
      { name: 'Doc_0/', data: '' },
      { name: 'OFD.xml', data: 'x' }
    ])
    const entries = readZipEntries(new Uint8Array(readFileSync(target)))
    expect([...entries.keys()]).toEqual(['OFD.xml'])
  })
})

describe('错误路径', () => {
  it('非 ZIP 字节报错', () => {
    expect(looksLikeZip(new Uint8Array([1, 2, 3, 4]))).toBe(false)
    expect(() => readZipEntries(new Uint8Array([1, 2, 3, 4]))).toThrow('不是有效的 ZIP 文件')
  })

  it('截断的 ZIP 找不到 EOCD', async () => {
    const target = join(dir, 'trunc.ofd')
    await writeZipStored(target, [{ name: 'OFD.xml', data: 'x'.repeat(64) }])
    const full = readFileSync(target)
    expect(() => readZipEntries(new Uint8Array(full.subarray(0, full.length - 10)))).toThrow('找不到中央目录结尾记录')
  })

  it('zip64 标记直接拒绝,不静默读错数据', async () => {
    const target = join(dir, 'zip64.ofd')
    await writeZipStored(target, [{ name: 'OFD.xml', data: 'x' }])
    const bytes = new Uint8Array(readFileSync(target))
    // EOCD 无注释时固定在末尾 22 字节:+8 是本盘条目数、+10 是总条目数,改成 0xFFFF 即 zip64 标记
    const eocd = bytes.length - 22
    bytes[eocd + 8] = 0xff
    bytes[eocd + 9] = 0xff
    bytes[eocd + 10] = 0xff
    bytes[eocd + 11] = 0xff
    expect(() => readZipEntries(bytes)).toThrow('zip64 不受支持')
  })

  it('条目声明长度越界时报错', async () => {
    const target = join(dir, 'bad.ofd')
    await writeZipStored(target, [{ name: 'OFD.xml', data: 'x'.repeat(32) }])
    const full = readFileSync(target)
    // 截掉数据尾部但保留中央目录:中央目录里的 compSize 会指向文件外
    const bytes = new Uint8Array(Buffer.concat([full.subarray(0, 40), full.subarray(full.length - 68)]))
    expect(() => readZipEntries(bytes)).toThrow(/越界|损坏|EOCD|找不到/)
  })
})
