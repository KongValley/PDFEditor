import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectDocumentKind, detectOdfKind } from '../../src/main/lib/documentkind'
import { decodeBmpToPng } from '../../src/main/lib/ofd/bmp'
import { parseXml } from '../../src/main/lib/ofd/model'
import { writeZipStored } from '../../src/main/lib/ofd/zip'
import { buildOdfHtml } from '../../src/main/lib/odf/html'
import { readOdfPackage, type OdfPackage } from '../../src/main/lib/odf/package'

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" office:version="1.2"'

function stylesXml(body: string): string {
  return `<office:document-styles ${NS}><office:styles>${body}</office:styles>
    <office:automatic-styles>
      <style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout>
    </office:automatic-styles>
    <office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>
  </office:document-styles>`
}

function contentXml(kind: 'text' | 'spreadsheet' | 'presentation', body: string, auto = ''): string {
  return `<office:document-content ${NS}><office:automatic-styles>${auto}</office:automatic-styles>
    <office:body><office:${kind}>${body}</office:${kind}></office:body></office:document-content>`
}

function makePackage(kind: 'text' | 'spreadsheet' | 'presentation', body: string, auto = '', files = new Map()): OdfPackage {
  return {
    kind,
    content: parseXml(contentXml(kind, body, auto)),
    styles: parseXml(
      stylesXml(
        '<style:default-style style:family="paragraph"><style:text-properties fo:font-size="12pt" style:font-name="SimSun"/></style:default-style>' +
          '<style:font-face style:name="SimSun" svg:font-family="SimSun"/>'
      )
    ),
    files,
    flat: false
  }
}

describe('ODF 格式判定', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'odf-detect-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('ZIP:有 content.xml + mimetype 即识别为 ODF,并按 mimetype 区分子类型', async () => {
    const path = join(dir, 'a.odt')
    await writeZipStored(path, [
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
      { name: 'content.xml', data: contentXml('text', '<text:p>x</text:p>') },
      { name: 'META-INF/manifest.xml', data: '<manifest/>' }
    ])
    const bytes = new Uint8Array(readFileSync(path))
    expect(detectDocumentKind(bytes)).toBe('odf')
    expect(detectOdfKind(bytes)).toBe('text')
  })

  it('扁平 XML:office:document 带 office:mimetype 时识别为 ODF', () => {
    const flat =
      `<?xml version="1.0"?><office:document ${NS} office:mimetype="application/vnd.oasis.opendocument.spreadsheet">` +
      '<office:body><office:spreadsheet/></office:body></office:document>'
    const bytes = new Uint8Array(Buffer.from(flat, 'utf8'))
    expect(detectDocumentKind(bytes)).toBe('odf')
    expect(detectOdfKind(bytes)).toBe('spreadsheet')
  })

  it('普通 ZIP(docx 结构)仍判为 other', async () => {
    const path = join(dir, 'a.docx')
    await writeZipStored(path, [{ name: 'word/document.xml', data: '<w:document/>' }])
    expect(detectDocumentKind(new Uint8Array(readFileSync(path)))).toBe('other')
  })
})

describe('ODT → HTML', () => {
  it('段落/字符样式/列表/表格/分页都进入 HTML', () => {
    const auto =
      '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard">' +
      '<style:paragraph-properties fo:text-align="center" fo:break-before="page"/></style:style>' +
      '<style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#ff0000"/></style:style>' +
      '<style:style style:name="C1" style:family="table-column"><style:table-column-properties style:column-width="4cm"/></style:style>' +
      '<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/></text:list-style>'
    const body =
      '<text:h text:outline-level="1">一级标题</text:h>' +
      '<text:p text:style-name="P1">居中<text:span text:style-name="Bold">粗体</text:span>普通<text:s text:c="2"/>空格</text:p>' +
      '<text:list text:style-name="L1"><text:list-item><text:p>第一项</text:p></text:list-item>' +
      '<text:list-item><text:p>第二项</text:p>' +
      '<text:list><text:list-item><text:p>嵌套项</text:p></text:list-item></text:list></text:list-item></text:list>' +
      '<table:table table:name="T1"><table:table-column table:style-name="C1"/>' +
      '<table:table-row><table:table-cell><text:p>甲</text:p></table:table-cell>' +
      '<table:table-cell table:number-columns-spanned="2"><text:p>合并</text:p></table:table-cell></table:table-row></table:table>'
    const pkg = makePackage('text', body, auto)
    const result = buildOdfHtml(pkg)
    expect(result.pageWidthMm).toBeCloseTo(210, 1)
    expect(result.html).toContain('一级标题')
    expect(result.html).toContain('font-weight:bold')
    expect(result.html).toContain('color:#ff0000')
    expect(result.html).toContain('text-align:center')
    expect(result.html).toContain('class="break"')
    expect(result.html).toContain('li-marker')
    expect(result.html).toContain('1.')
    // 顶层列表缩进 18pt,嵌套一层 36pt(不能每层加两次)
    expect(result.html).toContain('margin-left:18pt')
    expect(result.html).toContain('margin-left:36pt')
    expect(result.html).toContain('colspan="2"')
    expect(result.html).toContain('合并')
    expect(result.html).toContain('&nbsp;&nbsp;')
  })

  it('字符样式可显式关闭粗体/斜体/下划线', () => {
    const auto =
      '<style:style style:name="BoldP" style:family="paragraph"><style:text-properties fo:font-weight="bold" fo:font-style="italic" style:text-underline-style="solid"/></style:style>' +
      '<style:style style:name="HNormal" style:family="paragraph"><style:text-properties fo:font-weight="normal"/></style:style>' +
      '<style:style style:name="NormalChar" style:family="text"><style:text-properties fo:font-weight="normal" fo:font-style="normal" style:text-underline-style="none"/></style:style>'
    const body =
      '<text:p text:style-name="BoldP">粗<text:span text:style-name="NormalChar">正常</text:span></text:p>' +
      '<text:h text:outline-level="1" text:style-name="HNormal">标题</text:h>'
    const result = buildOdfHtml(makePackage('text', body, auto))
    // 父级段落是粗体/斜体/下划线,span 必须显式覆盖为 normal;下划线只画在叶子 run 上
    expect(result.html).toContain('font-weight:normal')
    expect(result.html).toContain('font-style:normal')
    expect(result.html).toContain('text-decoration:underline')
    const normalSpan = /<span style="([^"]*)">正常<\/span>/.exec(result.html)
    expect(normalSpan).not.toBeNull()
    expect(normalSpan?.[1] ?? '').not.toContain('text-decoration')
  })

  it('numbered-paragraph 按 list-id/level 自动编号', () => {
    const auto =
      '<text:list-style style:name="LN">' +
      '<text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/>' +
      '<text:list-level-style-number text:level="2" style:num-format="a" style:num-suffix=")"/>' +
      '</text:list-style>'
    const body =
      '<text:numbered-paragraph text:list-id="NP" text:style-name="LN" text:level="1"><text:p>第一条</text:p></text:numbered-paragraph>' +
      '<text:numbered-paragraph text:list-id="NP" text:style-name="LN" text:level="1"><text:p>第二条</text:p></text:numbered-paragraph>' +
      '<text:numbered-paragraph text:list-id="NP" text:style-name="LN" text:level="2"><text:p>子条</text:p></text:numbered-paragraph>' +
      '<text:numbered-paragraph text:list-id="NP" text:style-name="LN" text:level="1" text:start-value="5"><text:p>重置条</text:p></text:numbered-paragraph>'
    const result = buildOdfHtml(makePackage('text', body, auto))
    expect(result.html).toContain('>1.<')
    expect(result.html).toContain('>2.<')
    expect(result.html).toContain('>a)<')
    expect(result.html).toContain('>5.<')
    expect(result.html).toContain('重置条')
  })

  it('链接默认带下划线,字符样式显式 none 可关闭', () => {
    const auto =
      '<style:style style:name="NoUnderline" style:family="text"><style:text-properties style:text-underline-style="none"/></style:style>'
    const body =
      '<text:p><text:a xlink:href="https://example.com">链接<text:span text:style-name="NoUnderline">无下划线</text:span></text:a></text:p>'
    const result = buildOdfHtml(makePackage('text', body, auto))
    expect(result.html).toContain('text-decoration:underline')
    const normalSpan = /<span style="([^"]*)">无下划线<\/span>/.exec(result.html)
    expect(normalSpan).not.toBeNull()
    expect(normalSpan?.[1] ?? '').not.toContain('text-decoration')
  })

  it('表格单元格样式里的文字与段落属性生效', () => {
    const auto =
      '<style:style style:name="CellFmt" style:family="table-cell">' +
      '<style:table-cell-properties fo:background-color="#eeeeee"/>' +
      '<style:paragraph-properties fo:text-align="center"/>' +
      '<style:text-properties fo:font-weight="bold" fo:color="#ff0000"/>' +
      '</style:style>' +
      '<style:style style:name="ColFmt" style:family="table-column"><style:table-column-properties style:column-width="4cm"/></style:style>'
    const body =
      '<table:table><table:table-column table:style-name="ColFmt"/>' +
      '<table:table-row><table:table-cell table:style-name="CellFmt"><text:p>单元格格式</text:p></table:table-cell></table:table-row></table:table>'
    const result = buildOdfHtml(makePackage('text', body, auto))
    expect(result.html).toContain('text-align:center')
    expect(result.html).toContain('font-weight:bold')
    expect(result.html).toContain('color:#ff0000')
    expect(result.html).toContain('background-color:#eeeeee')
  })

  it('列表头与无列表样式的默认项目符号', () => {
    const body =
      '<text:list><text:list-header><text:p>列表头文字</text:p></text:list-header>' +
      '<text:list-item><text:p>列表项文字</text:p></text:list-item></text:list>'
    const result = buildOdfHtml(makePackage('text', body))
    expect(result.html).toContain('列表头文字')
    expect(result.html.indexOf('列表头文字')).toBeLessThan(result.html.indexOf('列表项文字'))
    // 没有 text:style-name 时按默认项目符号处理
    expect(result.html).toContain('•')
  })

  it('段落内 text:soft-page-break 拆成两段并分页', () => {
    const body = '<text:p>分页前<text:soft-page-break/>分页后</text:p>'
    const result = buildOdfHtml(makePackage('text', body))
    expect(result.html).toContain('分页前')
    expect(result.html).toContain('分页后')
    expect(result.html.indexOf('分页前')).toBeLessThan(result.html.indexOf('分页后'))
    expect(result.html).toContain('class="break"')
    expect(result.html).toContain('break-before:page')
  })

  it('draw:frame 内的 table:table 会输出为表格', () => {
    const body =
      '<draw:frame text:anchor-type="paragraph" svg:width="8cm" svg:height="3cm">' +
      '<table:table><table:table-row><table:table-cell><text:p>框架内表格</text:p></table:table-cell></table:table-row></table:table>' +
      '</draw:frame>' +
      '<text:p><draw:frame text:anchor-type="as-char" svg:width="6cm" svg:height="2cm">' +
      '<table:table><table:table-row><table:table-cell><text:p>行内框架表格</text:p></table:table-cell></table:table-row></table:table>' +
      '</draw:frame></text:p>'
    const result = buildOdfHtml(makePackage('text', body))
    expect(result.html).toContain('框架内表格')
    expect(result.html).toContain('行内框架表格')
    expect(result.html).toContain('<table class="odt-table"')
  })
})

describe('ODS → HTML', () => {
  it('合并单元格/列宽/重复空列不撑爆 HTML', () => {
    const auto =
      '<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="3cm"/></style:style>' +
      '<style:style style:name="ce1" style:family="table-cell"><style:table-cell-properties fo:background-color="#eeeeee" fo:border="0.5pt solid #000000"/></style:style>'
    const body =
      '<table:table table:name="Sheet1">' +
      '<table:table-column table:style-name="co1" table:number-columns-repeated="3"/>' +
      '<table:table-column table:number-columns-repeated="16384"/>' +
      '<table:table-row><table:table-cell office:value-type="string"><text:p>名称</text:p></table:table-cell>' +
      '<table:table-cell table:number-columns-spanned="2" office:value-type="string"><text:p>合并表头</text:p></table:table-cell>' +
      '<table:table-cell table:number-columns-repeated="16381"/></table:table-row>' +
      '<table:table-row><table:table-cell table:style-name="ce1"><text:p>甲</text:p></table:table-cell>' +
      '<table:table-cell office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell>' +
      '<table:table-cell office:value-type="float" office:value="3.14"/></table:table-row>' +
      '</table:table>'
    const pkg = makePackage('spreadsheet', body, auto)
    const result = buildOdfHtml(pkg)
    expect(result.html).toContain('名称')
    expect(result.html).toContain('colspan="2"')
    expect(result.html).toContain('background-color:#eeeeee')
    expect(result.html).toContain('3.14')
    // 16384 个重复空列不能真的输出 16384 个 <td>
    expect((result.html.match(/<td/g) ?? []).length).toBeLessThan(30)
  })

  it('宽表按内容宽度缩放,避免横向溢出页面', () => {
    const auto =
      '<style:style style:name="coWide" style:family="table-column"><style:table-column-properties style:column-width="5cm"/></style:style>'
    const cols = '<table:table-column table:style-name="coWide" table:number-columns-repeated="10"/>'
    const cells = Array.from({ length: 10 }, (_, i) => `<table:table-cell><text:p>${i + 1}</text:p></table:table-cell>`).join('')
    const body = `<table:table table:name="Wide">${cols}<table:table-row>${cells}</table:table-row></table:table>`
    const pkg = makePackage('spreadsheet', body, auto)
    const result = buildOdfHtml(pkg)
    expect(result.zoom).toBeLessThan(1)
    expect(result.zoom).toBeGreaterThan(0.2)
    expect(result.html).toMatch(/zoom:0\.\d+/)
    expect(result.warnings.some((warning) => warning.includes('工作表较宽'))).toBe(true)
  })

  it('纵向合并后,后续行不再输出被覆盖列的 <td>', () => {
    const body =
      '<table:table table:name="Sheet1">' +
      '<table:table-column table:number-columns-repeated="2"/>' +
      '<table:table-row><table:table-cell table:number-rows-spanned="2"><text:p>A</text:p></table:table-cell>' +
      '<table:table-cell><text:p>B</text:p></table:table-cell></table:table-row>' +
      '<table:table-row><table:covered-table-cell/><table:table-cell><text:p>C</text:p></table:table-cell></table:table-row>' +
      '</table:table>'
    const pkg = makePackage('spreadsheet', body)
    const result = buildOdfHtml(pkg)
    expect(result.html).toContain('rowspan="2"')
    // 第二行只应有一个 td(C);若把被覆盖的列也画出来会变成两个
    const trs = result.html.match(/<tr[\s\S]*?<\/tr>/g) ?? []
    expect(trs).toHaveLength(2)
    expect((trs[1].match(/<td/g) ?? []).length).toBe(1)
    expect(trs[1]).toContain('C')
  })

  it('单元格样式的段落对齐会应用到单元格文字', () => {
    const auto =
      '<style:style style:name="ceCenter" style:family="table-cell">' +
      '<style:paragraph-properties fo:text-align="center"/>' +
      '<style:text-properties fo:font-size="14pt"/>' +
      '</style:style>' +
      '<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:margin-top="3pt"/></style:style>'
    const body =
      '<table:table table:name="Sheet1"><table:table-row>' +
      '<table:table-cell table:style-name="ceCenter"><text:p text:style-name="P1">居中单元格</text:p></table:table-cell>' +
      '</table:table-row></table:table>'
    const result = buildOdfHtml(makePackage('spreadsheet', body, auto))
    expect(result.html).toContain('居中单元格')
    expect(result.html).toContain('text-align:center')
  })
})

describe('ODF 内嵌字体', () => {
  it('font-face-uri 指向包内字体时生成 @font-face(data URL)', () => {
    const content = parseXml(
      `<office:document-content ${NS}>` +
        '<office:font-face-decls><style:font-face style:name="F1" svg:font-family="Test Embedded">' +
        '<svg:font-face-src><svg:font-face-uri xlink:href="Fonts/test.ttf"/></svg:font-face-src>' +
        '</style:font-face></office:font-face-decls>' +
        '<office:body><office:text><text:p>内嵌字体文字</text:p></office:text></office:body></office:document-content>'
    )
    const files = new Map<string, Uint8Array>([
      ['Fonts/test.ttf', new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])]
    ])
    const pkg: OdfPackage = { kind: 'text', content, styles: null, files, flat: false }
    const result = buildOdfHtml(pkg)
    expect(result.html).toContain("@font-face{font-family:'Test Embedded'")
    expect(result.html).toContain('data:font/ttf;base64,')
    expect(result.warnings.some((warning) => warning.includes('内嵌字体文件缺失'))).toBe(false)
  })

  it('字体文件缺失时告警但不影响正文', () => {
    const content = parseXml(
      `<office:document-content ${NS}>` +
        '<office:font-face-decls><style:font-face style:name="F1" svg:font-family="Missing Font">' +
        '<svg:font-face-src><svg:font-face-uri xlink:href="Fonts/missing.ttf"/></svg:font-face-src>' +
        '</style:font-face></office:font-face-decls>' +
        '<office:body><office:text><text:p>仍要显示的文字</text:p></office:text></office:body></office:document-content>'
    )
    const pkg: OdfPackage = { kind: 'text', content, styles: null, files: new Map(), flat: false }
    const result = buildOdfHtml(pkg)
    expect(result.html).toContain('仍要显示的文字')
    expect(result.warnings.some((warning) => warning.includes('内嵌字体文件缺失'))).toBe(true)
  })

  it('content.xml 的同名 font-face 不覆盖 styles.xml 里的字体文件', () => {
    const content = parseXml(
      `<office:document-content ${NS}>` +
        '<office:font-face-decls><style:font-face style:name="F1" svg:font-family="Merged Font"/>' +
        '</office:font-face-decls>' +
        '<office:body><office:text><text:p>合并字体</text:p></office:text></office:body></office:document-content>'
    )
    const styles = parseXml(
      `<office:document-styles ${NS}>` +
        '<office:font-face-decls><style:font-face style:name="F1" svg:font-family="Merged Font">' +
        '<svg:font-face-src><svg:font-face-uri xlink:href="Fonts/test.ttf"/></svg:font-face-src>' +
        '</style:font-face></office:font-face-decls>' +
        '</office:document-styles>'
    )
    const files = new Map<string, Uint8Array>([
      ['Fonts/test.ttf', new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])]
    ])
    const pkg: OdfPackage = { kind: 'text', content, styles, files, flat: false }
    const result = buildOdfHtml(pkg)
    expect(result.html).toContain("@font-face{font-family:'Merged Font'")
  })
})

describe('ODP → HTML', () => {
  it('幻灯片按绝对坐标输出文本与内嵌图片', () => {
    const auto =
      '<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="#ffffff"/></style:style>' +
      '<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#ffcc00" draw:stroke="none"/></style:style>'
    const body =
      '<draw:page draw:name="Slide1" draw:style-name="dp1" draw:master-page-name="Default">' +
      '<draw:frame svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="3cm" presentation:class="title"><draw:text-box><text:p>演示标题</text:p></draw:text-box></draw:frame>' +
      '<draw:custom-shape draw:style-name="gr1" svg:x="2cm" svg:y="8cm" svg:width="5cm" svg:height="3cm"><draw:text-box><text:p>形状文字</text:p></draw:text-box></draw:custom-shape>' +
      '<draw:frame svg:x="15cm" svg:y="8cm" svg:width="2cm" svg:height="2cm"><draw:image><office:binary-data>iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==</office:binary-data></draw:image></draw:frame>' +
      '</draw:page>'
    const pkg = makePackage('presentation', body, auto)
    const result = buildOdfHtml(pkg)
    expect(result.html).toContain('演示标题')
    expect(result.html).toContain('形状文字')
    expect(result.html).toContain('background-color:#ffcc00')
    expect(result.html).toContain('left:56.693pt')
    // 1x1 PNG 的 base64 应转成 data URL
    expect(result.html).toContain('data:image/png;base64,')
  })

  it('形状文字样式的段落对齐与字号生效', () => {
    const auto =
      '<style:style style:name="PCenter" style:family="paragraph">' +
      '<style:paragraph-properties fo:text-align="center"/>' +
      '<style:text-properties fo:font-size="20pt"/>' +
      '</style:style>'
    const body =
      '<draw:page draw:name="Slide1" draw:master-page-name="Default">' +
      '<draw:frame draw:text-style-name="PCenter" svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="3cm" presentation:class="title">' +
      '<draw:text-box><text:p>居中标题</text:p></draw:text-box></draw:frame></draw:page>'
    const result = buildOdfHtml(makePackage('presentation', body, auto))
    expect(result.html).toContain('居中标题')
    expect(result.html).toContain('text-align:center')
    expect(result.html).toContain('font-size:20pt')
  })

  it('draw:frame 内的 table:table 会输出为表格', () => {
    const body =
      '<draw:page draw:name="Slide1" draw:master-page-name="Default">' +
      '<draw:frame svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="4cm">' +
      '<table:table><table:table-row><table:table-cell><text:p>幻灯片表格</text:p></table:table-cell></table:table-row></table:table>' +
      '</draw:frame></draw:page>'
    const result = buildOdfHtml(makePackage('presentation', body))
    expect(result.html).toContain('幻灯片表格')
    expect(result.html).toContain('<table class="odt-table"')
  })

  it('母版页的 circle/caption/measure 也会渲染', () => {
    const styles = parseXml(
      `<office:document-styles ${NS}><office:styles/><office:automatic-styles>` +
        '<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm"/></style:page-layout>' +
        '</office:automatic-styles><office:master-styles>' +
        '<style:master-page style:name="Default" style:page-layout-name="pm1">' +
        '<draw:circle svg:x="1cm" svg:y="1cm" svg:width="2cm" svg:height="2cm"/>' +
        '</style:master-page></office:master-styles></office:document-styles>'
    )
    const body =
      '<draw:page draw:name="Slide1" draw:master-page-name="Default">' +
      '<draw:frame svg:x="2cm" svg:y="2cm" svg:width="4cm" svg:height="2cm"><draw:text-box><text:p>内容</text:p></draw:text-box></draw:frame>' +
      '</draw:page>'
    const pkg = makePackage('presentation', body)
    pkg.styles = styles
    const result = buildOdfHtml(pkg)
    expect(result.html).toContain('border-radius:50%')
  })
})

describe('BMP → PNG', () => {
  function bmp24(width: number, height: number, pixels: Array<[number, number, number]>): Buffer {
    const rowSize = Math.ceil((width * 3) / 4) * 4
    const data = Buffer.alloc(rowSize * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = pixels[(height - 1 - y) * width + x]
        const at = y * rowSize + x * 3
        data[at] = b
        data[at + 1] = g
        data[at + 2] = r
      }
    }
    const header = Buffer.alloc(54)
    header.write('BM', 0, 'ascii')
    header.writeUInt32LE(54 + data.length, 2)
    header.writeUInt32LE(54, 10)
    header.writeUInt32LE(40, 14)
    header.writeInt32LE(width, 18)
    header.writeInt32LE(height, 22)
    header.writeUInt16LE(1, 26)
    header.writeUInt16LE(24, 28)
    header.writeUInt32LE(0, 30)
    return Buffer.concat([header, data])
  }

  it('24 位自底向上 BMP 解成合法 PNG', async () => {
    const decoded = decodeBmpToPng(
      bmp24(2, 2, [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 255]
      ])
    )
    expect(decoded?.width).toBe(2)
    expect(decoded?.height).toBe(2)
    expect(Array.from((decoded?.png ?? Buffer.alloc(0)).subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ])
    // 用 pdf-lib 校验 PNG 结构可被消费
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    await doc.embedPng(decoded?.png as Buffer)
    expect(doc.getPageCount()).toBe(0)
  })

  it('非 BMP / RLE BMP 返回 null', () => {
    expect(decodeBmpToPng(new Uint8Array([1, 2, 3]))).toBeNull()
    const rle = bmp24(1, 1, [[0, 0, 0]])
    rle.writeUInt32LE(1, 30)
    expect(decodeBmpToPng(rle)).toBeNull()
  })
})

// 防止 readOdfPackage 的 ZIP 分支回归:完整包往返
describe('ODF 包读取', () => {
  it('ZIP 包解析出 content/styles 与子类型', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'odf-read-'))
    const path = join(dir, 'a.odt')
    await writeZipStored(path, [
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
      { name: 'content.xml', data: contentXml('text', '<text:p>包内文字</text:p>') },
      { name: 'styles.xml', data: stylesXml('') }
    ])
    const result = readOdfPackage(new Uint8Array(readFileSync(path)))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.pkg.kind).toBe('text')
      expect(result.pkg.flat).toBe(false)
    }
    rmSync(dir, { recursive: true, force: true })
  })
})
