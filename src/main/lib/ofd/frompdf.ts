/**
 * PDF → OFD:每页一张 PNG(ImageObject 铺满页面)+ 叠加 Alpha=0 的文本层(TextObject)。
 *
 * 为什么用「位图 + 不可见文本」而不是矢量可见文字:位图保证版面 100% 保真(表格线、印章、
 * 图片都在里面),文本层只负责可检索/可选中,因此不需要内嵌字体(不可见故只需声明字体名)。
 * 若改成矢量可见文字,就必须再解析 pdf.js 操作符列表(图形状态/路径/图片),版面反而会残破。
 *
 * 已知偏差:文本层不导出旋转/斜切文字(位图仍在);不实现 Alpha 的阅读器会看到文字重影。
 */
import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import type { OfdTextRun } from '@shared/types'
import { writeZipStored, type ZipWriteEntry } from './zip'

export interface OfdImagePage {
  /** 页图 PNG 的磁盘路径 */
  filePath: string
  widthMm: number
  heightMm: number
  /** 不可见文本层(可检索/可选中);缺省表示该页只有位图 */
  texts?: OfdTextRun[]
}

export interface OfdWriteMeta {
  title?: string
  creator?: string
}

const OFD_NS = 'http://www.ofdspec.org/2016'

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch])
}

/** 毫米数值:定点 4 位去尾零(OFD 惯例,避免科学计数法) */
function mm(n: number): string {
  const rounded = Math.round(n * 10000) / 10000
  return Number.isFinite(rounded) ? String(rounded) : '0'
}

/**
 * 一段文字 → 不可见 TextObject。
 * 定位:TextCode 的 X/Y 是「外接矩形内、对象空间」的基线起点;DeltaX 是后一字型相对前一字型的偏移,
 * 这里按整段宽度均分(够用于选择/检索,且保证整段不越界),所以必须让 DeltaX 条目数 = 字符数-1。
 * 不可见靠 FillColor/对象 Alpha=0(规范 8.3.2 + CT_GraphicUnit;ofd-tools 等阅读器按此渲染为透明)。
 */
function textObjectXml(run: OfdTextRun, id: number, fontId: number): string {
  const size = run.sizeMm
  const ascent = run.ascent > 0 && run.ascent <= 1.2 ? run.ascent : 0.8
  const glyphs = [...run.text]
  const width = Math.max(run.widthMm, size * 0.1)
  const height = size * 1.2
  const top = run.baselineMm - ascent * size
  const perGlyph = (width / glyphs.length).toFixed(4)
  const delta = glyphs.length > 1 ? `DeltaX="${Array.from({ length: glyphs.length - 1 }, () => perGlyph).join(' ')}" ` : ''
  return (
    `<ofd:TextObject ID="${id}" Font="${fontId}" Size="${size.toFixed(4)}" ` +
    `Boundary="${mm(run.xMm)} ${mm(top)} ${mm(width)} ${mm(height)}" Alpha="0">` +
    `<ofd:FillColor Value="0 0 0" Alpha="0"/>` +
    `<ofd:TextCode X="0" Y="${(ascent * size).toFixed(4)}" ${delta}>${escapeXml(glyphs.join(''))}</ofd:TextCode>` +
    `</ofd:TextObject>`
  )
}

/**
 * 生成 OFD 包(全 STORE)。先写同目录临时文件再 rename:中途失败不留下半截产物。
 * ID 分配:Page=i+1、ImageObject=1000+i、MultiMedia=2000+i,MaxUnitID=2000+页数。
 */
export async function writeOfdFromImages(
  targetPath: string,
  pages: OfdImagePage[],
  meta: OfdWriteMeta = {}
): Promise<void> {
  if (pages.length === 0) throw new Error('没有可导出的页面')
  const creator = meta.creator ?? 'PDF 编辑器'
  const title = meta.title ?? ''
  // 文本层要用到的字体族(同一族只声明一份资源;不可见,故不内嵌 FontFile)
  const families: string[] = []
  for (const page of pages) {
    for (const run of page.texts ?? []) {
      if (!families.includes(run.family)) families.push(run.family)
    }
  }
  const fontIdOf = (family: string): number => 9000 + families.indexOf(family)
  const runCount = pages.reduce((sum, page) => sum + (page.texts?.length ?? 0), 0)
  // MaxUnitID 必须覆盖实际用到的最大标识(Page=1..n、Image=1000+i、MultiMedia=2000+i、Font=9000+i、Text=4000+k)
  const maxUnitId = Math.max(2000 + pages.length, 9000 + families.length, 4000 + runCount) + 1
  const first = pages[0]
  const docId = randomUUID().replace(/-/g, '')
  const creationDate = new Date().toISOString().slice(0, 10)

  const entries: ZipWriteEntry[] = [
    {
      name: 'OFD.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<ofd:OFD xmlns:ofd="${OFD_NS}" DocType="OFD" Version="1.0">` +
        `<ofd:DocBody><ofd:DocInfo>` +
        `<ofd:DocID>${docId}</ofd:DocID>` +
        `<ofd:Title>${escapeXml(title)}</ofd:Title>` +
        // XSD 的 CT_DocInfo 是 xs:sequence:DocID, Title, …, CreationDate, ModDate, …, Creator, CreatorVersion
        // 顺序错了会被 schema 校验的阅读器/归档系统拒收或丢元数据
        `<ofd:CreationDate>${creationDate}</ofd:CreationDate>` +
        `<ofd:Creator>${escapeXml(creator)}</ofd:Creator>` +
        `</ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>` +
        `</ofd:DocBody></ofd:OFD>\n`
    },
    {
      name: 'Doc_0/Document.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<ofd:Document xmlns:ofd="${OFD_NS}"><ofd:CommonData>` +
        `<ofd:MaxUnitID>${maxUnitId}</ofd:MaxUnitID>` +
        `<ofd:PageArea><ofd:PhysicalBox>0 0 ${mm(first.widthMm)} ${mm(first.heightMm)}</ofd:PhysicalBox></ofd:PageArea>` +
        `<ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes>` +
        `</ofd:CommonData><ofd:Pages>` +
        pages.map((_, index) => `<ofd:Page ID="${index + 1}" BaseLoc="Pages/Page_${index}/Content.xml"/>`).join('') +
        `</ofd:Pages></ofd:Document>\n`
    },
    {
      name: 'Doc_0/DocumentRes.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        // Res 的模型组是 xs:choice(顺序与重复次数都自由),这里按规范表格的顺序写 Fonts → MultiMedias,
        // 与常见生成器一致即可
        `<ofd:Res xmlns:ofd="${OFD_NS}" BaseLoc="Res">` +
        (families.length > 0
          ? `<ofd:Fonts>` +
            families
              .map(
                (family, index) =>
                  `<ofd:Font ID="${fontIdOf(family)}" FontName="${escapeXml(family)}" FamilyName="${escapeXml(family)}" Charset="unicode"/>`
              )
              .join('') +
            `</ofd:Fonts>`
          : '') +
        `<ofd:MultiMedias>` +
        pages
          .map(
            (_, index) =>
              `<ofd:MultiMedia ID="${2000 + index}" Type="Image" Format="PNG">` +
              `<ofd:MediaFile>image_${index}.png</ofd:MediaFile></ofd:MultiMedia>`
          )
          .join('') +
        `</ofd:MultiMedias></ofd:Res>\n`
    }
  ]

  let textSeq = 0
  pages.forEach((page, index) => {
    entries.push({
      name: `Doc_0/Pages/Page_${index}/Content.xml`,
      data:
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<ofd:Page xmlns:ofd="${OFD_NS}">` +
        `<ofd:Area><ofd:PhysicalBox>0 0 ${mm(page.widthMm)} ${mm(page.heightMm)}</ofd:PhysicalBox></ofd:Area>` +
        `<ofd:Content><ofd:Layer Type="Body">` +
        `<ofd:ImageObject ID="${1000 + index}" Boundary="0 0 ${mm(page.widthMm)} ${mm(page.heightMm)}" ResourceID="${2000 + index}"/>` +
        (page.texts ?? []).map((run) => textObjectXml(run, 4000 + textSeq++, fontIdOf(run.family))).join('') +
        `</ofd:Layer></ofd:Content></ofd:Page>\n`
    })
    entries.push({ name: `Doc_0/Res/image_${index}.png`, filePath: page.filePath })
  })

  const tmpPath = `${targetPath}.tmp-${Date.now()}`
  try {
    await writeZipStored(tmpPath, entries)
    await rename(tmpPath, targetPath)
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw err
  }
}
