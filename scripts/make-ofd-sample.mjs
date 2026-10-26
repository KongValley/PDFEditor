// 生成 samples/sample-ofd.ofd(手写最小 OFD 包:两页 + 中文/ASCII 文字 + 矩形框 + 图片 + 背景模板)
//
// 为什么手写而不复用 src/main/lib/ofd/*:脚本是纯 ESM,不能 import TS 源码;
// 这里的 ZIP(STORE)写入与 CRC32 是刻意的小重复(与 src/main/lib/ofd/zip.ts 同算法),
// 只服务于夹具生成,不参与运行时。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const NS = 'http://www.ofdspec.org/2016'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = `${root}/samples/sample-ofd.ofd`

// ---- CRC32 / PNG / ZIP(与 src/main/lib/ofd/zip.ts 同算法)----

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

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/** size×size 纯色 PNG(64×64 红=正文图片,蓝=签章图片) */
function makePng(r, g, b) {
  const size = 64
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const at = y * (size * 4 + 1) + 1 + x * 4
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
      raw[at + 3] = 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** 全 STORE 写 ZIP(OFD 容器) */
function writeZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const payload = entry.data
    const crc = crc32(payload)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(payload.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, payload)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(payload.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += 30 + name.length + payload.length
  }
  const centralSize = central.reduce((sum, buf) => sum + buf.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...central, eocd])
}

const xml = (body) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`, 'utf8')

// ---- 包内容 ----

const entries = [
  {
    name: 'OFD.xml',
    data: xml(
      `<ofd:OFD xmlns:ofd="${NS}" DocType="OFD" Version="1.0"><ofd:DocBody><ofd:DocInfo>` +
        `<ofd:DocID>sample-ofd-0001</ofd:DocID><ofd:Title>OFD 样例</ofd:Title>` +
        `</ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`
    )
  },
  {
    name: 'Doc_0/Document.xml',
    data: xml(
      `<ofd:Document xmlns:ofd="${NS}"><ofd:CommonData><ofd:MaxUnitID>40</ofd:MaxUnitID>` +
        `<ofd:TemplatePage ID="9" BaseLoc="Tpls/Tpl_0/Content.xml"/>` +
        `<ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea>` +
        `<ofd:PublicRes>PublicRes.xml</ofd:PublicRes>` +
        `<ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes></ofd:CommonData>` +
        `<ofd:Pages>` +
        `<ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/>` +
        `<ofd:Page ID="2" BaseLoc="Pages/Page_1/Content.xml"/>` +
        `</ofd:Pages>` +
        `<ofd:Annotations>Annots/Annotations.xml</ofd:Annotations>` +
        `</ofd:Document>`
    )
  },
  {
    name: 'Doc_0/Annots/Annotations.xml',
    data: xml(
      `<ofd:Annotations xmlns:ofd="${NS}">` +
        `<ofd:Page PageID="1"><ofd:FileLoc>Page_0/Annotation.xml</ofd:FileLoc></ofd:Page>` +
        `</ofd:Annotations>`
    )
  },
  {
    name: 'Doc_0/Annots/Page_0/Annotation.xml',
    data: xml(
      `<ofd:PageAnnot xmlns:ofd="${NS}">` +
        // 签章:呈现内容是一张图片(子对象坐标相对 Appearance 的 Boundary)
        `<ofd:Annot ID="7000" Type="Stamp" Subtype="SignatureInFile">` +
        `<ofd:Appearance Boundary="150 240 30 30">` +
        `<ofd:ImageObject ID="90" Boundary="0 0 30 30" ResourceID="3"/></ofd:Appearance></ofd:Annot>` +
        // 只有签名引用、没有呈现内容:转换时应给出「签章只含签名引用」告警
        `<ofd:Annot ID="7001" Type="Stamp" Subtype="SignatureInFile">` +
        `<ofd:Appearance Boundary="20 240 30 30"/></ofd:Annot>` +
        `</ofd:PageAnnot>`
    )
  },
  {
    name: 'Doc_0/PublicRes.xml',
    data: xml(
      `<ofd:Res xmlns:ofd="${NS}" BaseLoc="Res"><ofd:Fonts>` +
        `<ofd:Font ID="1" FontName="黑体" FamilyName="SimHei" Charset="unicode"/>` +
        `</ofd:Fonts></ofd:Res>`
    )
  },
  {
    name: 'Doc_0/DocumentRes.xml',
    data: xml(
      `<ofd:Res xmlns:ofd="${NS}" BaseLoc="Res"><ofd:MultiMedias>` +
        `<ofd:MultiMedia ID="2" Type="Image" Format="PNG"><ofd:MediaFile>image_0.png</ofd:MediaFile></ofd:MultiMedia>` +
        `<ofd:MultiMedia ID="3" Type="Image" Format="PNG"><ofd:MediaFile>image_1.png</ofd:MediaFile></ofd:MultiMedia>` +
        `</ofd:MultiMedias></ofd:Res>`
    )
  },
  {
    name: 'Doc_0/Pages/Page_0/Content.xml',
    data: xml(
      `<ofd:Page xmlns:ofd="${NS}">` +
        `<ofd:Area><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:Area>` +
        `<ofd:Template ID="9" ZOrder="Background"/>` +
        `<ofd:Content><ofd:Layer ID="1">` +
        `<ofd:TextObject ID="11" Font="1" Size="5.6444" Boundary="20 30 150 12">` +
        `<ofd:FillColor Value="0 0 0"/>` +
        `<ofd:TextCode X="0" Y="10">OFD-测试文本 2026</ofd:TextCode></ofd:TextObject>` +
        `<ofd:PathObject ID="12" Boundary="20 50 170 40" Fill="false" Stroke="true" LineWidth="0.5">` +
        `<ofd:StrokeColor Value="0 0 0"/>` +
        `<ofd:AbbreviatedData>M 0 0 L 170 0 L 170 40 L 0 40 C</ofd:AbbreviatedData></ofd:PathObject>` +
        `<ofd:ImageObject ID="13" Boundary="150 200 30 30" ResourceID="2"/>` +
        // CTM 缩放(真实转换器常见:文字坐标用 pt 再乘 ~0.3528 变成 mm):
        // TextCode X=200/Y=100 → 页面 70.56mm/35.28mm → PDF 200pt / 页高-100pt
        `<ofd:TextObject ID="14" Font="1" Size="5.6444" Boundary="0 0 200 120" CTM="0.3527778 0 0 0.3527778 0 0">` +
        `<ofd:TextCode X="200" Y="100">CTM-TEXT</ofd:TextCode></ofd:TextObject>` +
        `</ofd:Layer></ofd:Content></ofd:Page>`
    )
  },
  {
    name: 'Doc_0/Pages/Page_1/Content.xml',
    data: xml(
      `<ofd:Page xmlns:ofd="${NS}">` +
        `<ofd:Area><ofd:PhysicalBox>0 0 148 210</ofd:PhysicalBox></ofd:Area>` +
        `<ofd:Content><ofd:Layer ID="2">` +
        `<ofd:TextObject ID="21" Font="1" Size="5.6444" Boundary="20 30 100 12">` +
        `<ofd:TextCode X="0" Y="10">第二页</ofd:TextCode></ofd:TextObject>` +
        `</ofd:Layer></ofd:Content></ofd:Page>`
    )
  },
  {
    name: 'Doc_0/Tpls/Tpl_0/Content.xml',
    data: xml(
      `<ofd:Page xmlns:ofd="${NS}">` +
        `<ofd:Area><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:Area>` +
        `<ofd:Content><ofd:Layer ID="5">` +
        `<ofd:PathObject ID="5" Boundary="0 0 210 40" Fill="true" Stroke="false">` +
        `<ofd:FillColor Value="230 230 230"/>` +
        `<ofd:AbbreviatedData>M 0 0 L 210 0 L 210 40 L 0 40 C</ofd:AbbreviatedData>` +
        `</ofd:PathObject></ofd:Layer></ofd:Content></ofd:Page>`
    )
  },
  { name: 'Doc_0/Res/image_0.png', data: makePng(0xe0, 0x3a, 0x3a) },
  { name: 'Doc_0/Res/image_1.png', data: makePng(0x2f, 0x6f, 0xd0) }
]

mkdirSync(dirname(target), { recursive: true })
const bytes = writeZip(entries)
writeFileSync(target, bytes)
console.log(`[make-ofd-sample] 已生成 ${target}(${bytes.length} 字节,${entries.length} 个条目)`)
