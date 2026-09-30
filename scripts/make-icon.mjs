// 生成 resources/icon.png(512×512 占位图标,纯 Node 手写 PNG 编码)
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const W = 512
const H = 512
const px = Buffer.alloc(W * H * 4)

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 4
  px[i] = r
  px[i + 1] = g
  px[i + 2] = b
  px[i + 3] = a
}

function roundRect(x0, y0, w, h, radius, r, g, b) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.min(x - x0, x0 + w - 1 - x)
      const dy = Math.min(y - y0, y0 + h - 1 - y)
      if (dx < radius && dy < radius) {
        const d = Math.hypot(radius - dx, radius - dy)
        if (d > radius) continue
      }
      set(x, y, r, g, b)
    }
  }
}

// 背景:深蓝圆角方块
roundRect(0, 0, W, H, 96, 0x2b, 0x33, 0x44)
// 页面:白色
roundRect(112, 72, 288, 368, 16, 0xf2, 0xf5, 0xfa)
// 页眉色带
roundRect(112, 72, 288, 64, 16, 0x4a, 0x8f, 0xe7)
for (let y = 120; y < 136; y++) for (let x = 112; x < 400; x++) set(x, y, 0x4a, 0x8f, 0xe7)
// 文本行
const lineColor = [0x8b, 0x93, 0xa5]
for (let i = 0; i < 5; i++) {
  const y = 176 + i * 44
  const w = i === 4 ? 160 : 224
  for (let yy = y; yy < y + 18; yy++) for (let x = 152; x < 152 + w; x++) set(x, yy, ...lineColor)
}
// 红色印章圆
for (let y = 300; y < 420; y++) {
  for (let x = 200; x < 320; x++) {
    const d = Math.hypot(x - 260, y - 360)
    if (d < 54 && d > 40) set(x, y, 0xe0, 0x5c, 0x5c)
  }
}

// PNG 编码
const raw = Buffer.alloc(H * (W * 4 + 1))
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
}

const crcTable = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c
}
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = fileURLToPath(new URL('../resources/icon.png', import.meta.url))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log('已生成 resources/icon.png', png.length, 'bytes')
