// 生成 samples/sample-odt.odt、sample-ods.ods、sample-odp.odp(手写最小 ODF 包)。
// 与 make-ofd-sample.mjs 一样是纯 ESM 脚本:ZIP(STORE)/CRC32/PNG 的小实现只服务夹具生成,
// 不参与运行时。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = `${root}/samples`
mkdirSync(outDir, { recursive: true })

// ---- CRC32 / PNG / ZIP(STORE) ----

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

function makePng(r, g, b, size = 48) {
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

function writeZip(target, entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const payload = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data
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
    cd.writeUInt16LE(0, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(payload.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += 30 + name.length + payload.length
  }
  const cdOffset = offset
  const cdSize = central.reduce((sum, chunk) => sum + chunk.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  writeFileSync(target, Buffer.concat([...locals, ...central, eocd]))
}

// ---- 命名空间 ----

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'office:version="1.2"'

const MIME = {
  text: 'application/vnd.oasis.opendocument.text',
  spreadsheet: 'application/vnd.oasis.opendocument.spreadsheet',
  presentation: 'application/vnd.oasis.opendocument.presentation'
}

function manifest(mime, media) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest ${NS}>` +
    `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/>` +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
    media
      .map((name) => `<manifest:file-entry manifest:full-path="Pictures/${name}" manifest:media-type="image/png"/>`)
      .join('') +
    '</manifest:manifest>'
  )
}

function writeOdf(name, mime, contentXml, stylesXml, pictures = {}) {
  const entries = [
    { name: 'mimetype', data: mime },
    { name: 'content.xml', data: contentXml },
    { name: 'styles.xml', data: stylesXml },
    { name: 'META-INF/manifest.xml', data: manifest(mime, Object.keys(pictures)) }
  ]
  for (const [file, bytes] of Object.entries(pictures)) entries.push({ name: `Pictures/${file}`, data: bytes })
  writeZip(`${outDir}/${name}`, entries)
}

// ---- 文字文档 ----

const odtContent =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS}>` +
  '<office:font-face-decls><style:font-face style:name="SimSun" svg:font-family="SimSun"/></office:font-face-decls>' +
  '<office:automatic-styles>' +
  '<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>' +
  '<style:style style:name="P2" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style>' +
  '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#c00000"/></style:style>' +
  '<style:style style:name="Tbl" style:family="table"><style:table-properties style:width="16cm" table:align="center"/></style:style>' +
  '<style:style style:name="Col1" style:family="table-column"><style:table-column-properties style:column-width="4cm"/></style:style>' +
  '<style:style style:name="Col2" style:family="table-column"><style:table-column-properties style:column-width="6cm"/></style:style>' +
  '<style:style style:name="Cell1" style:family="table-cell"><style:table-cell-properties fo:background-color="#f2f2f2" fo:border="0.5pt solid #808080" fo:padding="0.1cm"/></style:style>' +
  '<text:list-style style:name="L1">' +
  '<text:list-level-style-bullet text:level="1" text:bullet-char="•"/>' +
  '<text:list-level-style-number text:level="2" style:num-format="1" style:num-suffix=")"/>' +
  '</text:list-style>' +
  '</office:automatic-styles>' +
  '<office:body><office:text>' +
  '<text:h text:outline-level="1" text:style-name="Heading1">ODF 导入冒烟</text:h>' +
  '<text:p>这是从 <text:span text:style-name="T1">ODT</text:span> 转换来的第一段文字,包含中文与 Latin ABC 12345。<text:s text:c="2"/>两个空格。</text:p>' +
  '<text:p text:style-name="P1">居中的第二段</text:p>' +
  '<text:list text:style-name="L1">' +
  '<text:list-item><text:p>列表第一项</text:p></text:list-item>' +
  '<text:list-item><text:p>列表第二项</text:p>' +
  '<text:list><text:list-item><text:p>嵌套编号项</text:p></text:list-item></text:list>' +
  '</text:list-item>' +
  '</text:list>' +
  '<table:table table:name="Table1" table:style-name="Tbl">' +
  '<table:table-column table:style-name="Col1"/><table:table-column table:style-name="Col2"/>' +
  '<table:table-row><table:table-cell table:style-name="Cell1"><text:p>项目</text:p></table:table-cell>' +
  '<table:table-cell table:style-name="Cell1"><text:p>说明</text:p></table:table-cell></table:table-row>' +
  '<table:table-row><table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="1" table:style-name="Cell1"><text:p>合并单元格</text:p></table:table-cell>' +
  '<table:covered-table-cell/></table:table-row>' +
  '</table:table>' +
  '<text:p><draw:frame text:anchor-type="as-char" svg:width="2.5cm" svg:height="2.5cm"><draw:image xlink:href="Pictures/logo.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame> 图片后面的文字</text:p>' +
  '<text:p text:style-name="P2"><text:span text:style-name="T1">ODT-PAGE-2</text:span> 第二页文字</text:p>' +
  '</office:text></office:body></office:document-content>'

const odtStyles =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NS}>` +
  '<office:font-face-decls><style:font-face style:name="SimSun" svg:font-family="SimSun"/></office:font-face-decls>' +
  '<office:styles>' +
  '<style:default-style style:family="paragraph"><style:text-properties style:font-name="SimSun" fo:font-size="12pt"/></style:default-style>' +
  '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>' +
  '<style:style style:name="Heading1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-top="0.2in" fo:margin-bottom="0.1in"/><style:text-properties fo:font-size="18pt" fo:font-weight="bold"/></style:style>' +
  '<style:style style:name="Footer" style:family="paragraph"><style:text-properties fo:font-size="8pt"/></style:style>' +
  '</office:styles>' +
  '<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout></office:automatic-styles>' +
  '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1">' +
  '<style:footer><text:p text:style-name="Footer">ODF 冒烟页脚</text:p></style:footer>' +
  '</style:master-page></office:master-styles></office:document-styles>'

writeOdf('sample-odt.odt', MIME.text, odtContent, odtStyles, { 'logo.png': makePng(220, 60, 60) })

// ---- 表格文档 ----

const odsContent =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS}>` +
  '<office:automatic-styles>' +
  '<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="4cm"/></style:style>' +
  '<style:style style:name="co2" style:family="table-column"><style:table-column-properties style:column-width="3cm"/></style:style>' +
  '<style:style style:name="ceHead" style:family="table-cell"><style:table-cell-properties fo:background-color="#dbe5f1" fo:border="0.5pt solid #000000" fo:padding="0.08cm"/><style:text-properties fo:font-weight="bold"/></style:style>' +
  '<style:style style:name="ceBody" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm"/></style:style>' +
  '</office:automatic-styles>' +
  '<office:body><office:spreadsheet>' +
  '<table:table table:name="Sheet1">' +
  '<table:table-column table:style-name="co1"/><table:table-column table:style-name="co2"/>' +
  '<table:table-column table:style-name="co2"/><table:table-column table:number-columns-repeated="1021"/>' +
  '<table:table-header-rows><table:table-row>' +
  '<table:table-cell table:style-name="ceHead"><text:p>名称</text:p></table:table-cell>' +
  '<table:table-cell table:style-name="ceHead"><text:p>数量</text:p></table:table-cell>' +
  '<table:table-cell table:style-name="ceHead"><text:p>备注</text:p></table:table-cell>' +
  '<table:table-cell table:number-columns-repeated="1021"/>' +
  '</table:table-row></table:table-header-rows>' +
  '<table:table-row><table:table-cell table:style-name="ceBody"><text:p>苹果</text:p></table:table-cell>' +
  '<table:table-cell table:style-name="ceBody" office:value-type="float" office:value="12"><text:p>12</text:p></table:table-cell>' +
  '<table:table-cell table:style-name="ceBody"><text:p>合计 36 元</text:p></table:table-cell>' +
  '<table:table-cell table:number-columns-repeated="1021"/></table:table-row>' +
  '<table:table-row><table:table-cell table:style-name="ceBody"><text:p>香蕉</text:p></table:table-cell>' +
  '<table:table-cell table:style-name="ceBody" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell>' +
  '<table:table-cell table:style-name="ceBody" office:value-type="float" office:value="3.14"/>' +
  '<table:table-cell table:number-columns-repeated="1021"/></table:table-row>' +
  '<table:table-row><table:table-cell table:style-name="ceBody" table:number-columns-spanned="3"><text:p>合并的统计行</text:p></table:table-cell>' +
  '<table:table-cell table:number-columns-repeated="1021"/></table:table-row>' +
  '</table:table>' +
  '<table:table table:name="Sheet2">' +
  '<table:table-column table:style-name="co1"/><table:table-column table:number-columns-repeated="1023"/>' +
  '<table:table-row><table:table-cell table:style-name="ceBody"><text:p>第二张表 ODS-SHEET-2</text:p></table:table-cell>' +
  '<table:table-cell table:number-columns-repeated="1023"/></table:table-row>' +
  '</table:table>' +
  '</office:spreadsheet></office:body></office:document-content>'

const odsStyles =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NS}>` +
  '<office:styles><style:default-style style:family="paragraph"><style:text-properties fo:font-size="10pt"/></style:default-style></office:styles>' +
  '<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout></office:automatic-styles>' +
  '<office:master-styles><style:master-page style:name="Default" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>'

writeOdf('sample-ods.ods', MIME.spreadsheet, odsContent, odsStyles)

// ---- 演示文档 ----

const odpContent =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS}>` +
  '<office:automatic-styles>' +
  '<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="#ffffff"/></style:style>' +
  '<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#ffd966" draw:stroke="solid" svg:stroke-color="#7f6000" svg:stroke-width="0.05cm" draw:textarea-vertical-align="middle"/></style:style>' +
  '</office:automatic-styles>' +
  '<office:body><office:presentation>' +
  '<draw:page draw:name="Slide1" draw:style-name="dp1" draw:master-page-name="Default">' +
  '<draw:frame presentation:class="title" svg:x="2cm" svg:y="1.5cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>ODP 演示标题</text:p></draw:text-box></draw:frame>' +
  '<draw:frame svg:x="2cm" svg:y="5cm" svg:width="14cm" svg:height="4cm"><draw:text-box>' +
  '<text:p>第一页正文:中文与 English 混排。</text:p><text:p>第二行文字。</text:p>' +
  '</draw:text-box></draw:frame>' +
  '<draw:custom-shape draw:style-name="gr1" svg:x="2cm" svg:y="11cm" svg:width="8cm" svg:height="3cm"><draw:text-box><text:p>黄色形状</text:p></draw:text-box></draw:custom-shape>' +
  '<draw:frame svg:x="20cm" svg:y="10cm" svg:width="5cm" svg:height="5cm"><draw:image xlink:href="Pictures/logo.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>' +
  '</draw:page>' +
  '<draw:page draw:name="Slide2" draw:style-name="dp1" draw:master-page-name="Default">' +
  '<draw:frame presentation:class="title" svg:x="2cm" svg:y="1.5cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>第二页 ODP-SLIDE-2</text:p></draw:text-box></draw:frame>' +
  '</draw:page>' +
  '</office:presentation></office:body></office:document-content>'

const odpStyles =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NS}>` +
  '<office:styles><style:default-style style:family="paragraph"><style:text-properties fo:font-size="18pt"/></style:default-style></office:styles>' +
  '<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm" style:print-orientation="landscape" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm"/></style:page-layout></office:automatic-styles>' +
  '<office:master-styles><style:master-page style:name="Default" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>'

writeOdf('sample-odp.odp', MIME.presentation, odpContent, odpStyles, { 'logo.png': makePng(60, 120, 220) })

console.log('已生成 samples/sample-odt.odt、sample-ods.ods、sample-odp.odp')
