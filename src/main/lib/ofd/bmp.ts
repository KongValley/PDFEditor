/**
 * BMP → PNG(OFD 里个别扫描件/印章用 BMP;pdf-lib 只认 PNG/JPEG)。
 *
 * 只实现常见子集:BI_RGB / BI_BITFIELDS,1/4/8 位调色板,16/24/32 位真彩,
 * 自底向上与自顶向下两种行序。RLE 压缩(RLE4/RLE8)与 OS/2 头不支持,
 * 返回 null 由调用方降级并告警 —— 不能静默画错图。
 */
import { deflateSync } from 'node:zlib'
import { crc32 } from './zip'

export interface DecodedBmp {
  png: Buffer
  width: number
  height: number
}

const MAX_PIXELS = 40_000_000

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

function maskChannel(value: number, mask: number): number {
  if (!mask) return 0
  let shift = 0
  let m = mask >>> 0
  while ((m & 1) === 0 && shift < 32) {
    m >>>= 1
    shift++
  }
  const max = m
  return max === 0 ? 0 : Math.round((((value & mask) >>> shift) * 255) / max)
}

/** 解码 BMP;不支持的变体返回 null */
export function decodeBmpToPng(bytes: Uint8Array): DecodedBmp | null {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 54) return null
  const dataOffset = buf.readUInt32LE(10)
  const headerSize = buf.readUInt32LE(14)
  if (headerSize < 40 || 14 + headerSize > buf.length) return null

  const width = buf.readInt32LE(18)
  const rawHeight = buf.readInt32LE(22)
  const topDown = rawHeight < 0
  const height = Math.abs(rawHeight)
  const planes = buf.readUInt16LE(26)
  const bpp = buf.readUInt16LE(28)
  const compression = buf.readUInt32LE(30)
  if (planes !== 1 || width <= 0 || height <= 0) return null
  if (width > 20000 || height > 20000 || width * height > MAX_PIXELS) return null
  // 0=BI_RGB,3=BI_BITFIELDS,6=BI_ALPHABITFIELDS;RLE(1/2)/JPEG(4)/PNG(5) 不支持
  if (compression !== 0 && compression !== 3 && compression !== 6) return null
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) return null

  const rowSize = Math.floor((bpp * width + 31) / 32) * 4
  if (rowSize <= 0 || dataOffset + rowSize * height > buf.length) return null

  // 调色板(1/4/8 位)
  let palette: Array<[number, number, number]> | null = null
  if (bpp <= 8) {
    const colorsUsed = buf.readUInt32LE(46) || 1 << bpp
    const count = Math.min(colorsUsed, 1 << bpp, 256)
    const paletteStart = 14 + headerSize
    if (paletteStart + count * 4 > buf.length) return null
    palette = []
    for (let i = 0; i < count; i++) {
      const at = paletteStart + i * 4
      palette.push([buf[at + 2], buf[at + 1], buf[at]])
    }
  }

  // 位域掩码
  let rMask = 0
  let gMask = 0
  let bMask = 0
  let aMask = 0
  if (bpp === 16 || bpp === 32) {
    if (compression === 3 || compression === 6) {
      const maskStart = headerSize >= 52 ? 14 + 40 : 14 + headerSize
      if (maskStart + 12 > buf.length) return null
      rMask = buf.readUInt32LE(maskStart)
      gMask = buf.readUInt32LE(maskStart + 4)
      bMask = buf.readUInt32LE(maskStart + 8)
      if (compression === 6) {
        if (maskStart + 16 > buf.length) return null
        aMask = buf.readUInt32LE(maskStart + 12)
      }
    } else if (bpp === 16) {
      rMask = 0x7c00
      gMask = 0x03e0
      bMask = 0x001f
    } else {
      rMask = 0x00ff0000
      gMask = 0x0000ff
      bMask = 0x000000ff
    }
  }

  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sourceRow = topDown ? y : height - 1 - y
    const rowStart = dataOffset + sourceRow * rowSize
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 255
      if (bpp === 24) {
        const at = rowStart + x * 3
        b = buf[at]
        g = buf[at + 1]
        r = buf[at + 2]
      } else if (bpp === 32) {
        const at = rowStart + x * 4
        const value = buf.readUInt32LE(at)
        r = maskChannel(value, rMask)
        g = maskChannel(value, gMask)
        b = maskChannel(value, bMask)
        if (aMask) a = maskChannel(value, aMask)
      } else if (bpp === 16) {
        const at = rowStart + x * 2
        const value = buf.readUInt16LE(at)
        r = maskChannel(value, rMask)
        g = maskChannel(value, gMask)
        b = maskChannel(value, bMask)
        if (aMask) a = maskChannel(value, aMask)
      } else {
        const index = paletteIndex(buf, rowStart, x, bpp)
        const entry = palette?.[index]
        if (entry) {
          r = entry[0]
          g = entry[1]
          b = entry[2]
        }
      }
      const at = (y * width + x) * 4
      rgba[at] = r
      rgba[at + 1] = g
      rgba[at + 2] = b
      rgba[at + 3] = a
    }
  }

  // 32 位 BI_RGB 没有 alpha 通道(第 4 字节规范说「不使用」,生成器常写 0):
  // 只有 BI_BITFIELDS 显式给了 alpha 掩码才保留透明
  if (bpp === 32 && aMask === 0) {
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const rowAt = y * (1 + width * 4)
    raw[rowAt] = 0
    rgba.copy(raw, rowAt + 1, y * width * 4, (y + 1) * width * 4)
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
  return { png, width, height }
}

function paletteIndex(buf: Buffer, rowStart: number, x: number, bpp: number): number {
  if (bpp === 8) return buf[rowStart + x]
  if (bpp === 4) {
    const byte = buf[rowStart + (x >> 1)]
    return x % 2 === 0 ? byte >> 4 : byte & 0x0f
  }
  const byte = buf[rowStart + (x >> 3)]
  return (byte >> (7 - (x % 8))) & 1
}
