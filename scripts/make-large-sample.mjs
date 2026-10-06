// 生成大文件冒烟夹具(tmp/large.pdf:400 页 + 30 个 1MB 不可压缩附件 ≈ 30MB)
// 附件用随机字节,避免被 PDF 压缩掉 —— 目的是让「按需分段读取」的收益可观测
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'tmp', 'large.pdf')

// 文本必须用 WinAnsi 可编码的字符(StandardFonts.Helvetica 无法编码中文)
const PAGE_COUNT = 400
const LINE_COUNT = 30
const ATTACHMENT_COUNT = 30
const ATTACHMENT_BYTES = 1 << 20

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)

function addPages(from, to) {
  for (let i = from; i < to; i++) {
    const page = doc.addPage([595, 842])
    for (let line = 0; line < LINE_COUNT; line++) {
      page.drawText(`page ${i + 1} line ${line + 1} lorem ipsum dolor sit amet consectetur adipiscing`, {
        x: 30,
        y: 800 - line * 22,
        size: 9,
        font
      })
    }
  }
}

// 附件插在两组页面之间:后半段的页对象会落在文件尾部,
// 渲染远端页必须再取一段(否则整个 fixture 的页对象都挤在文件头部,读不到「按需」)
addPages(0, PAGE_COUNT / 2)
for (let i = 0; i < ATTACHMENT_COUNT; i++) {
  await doc.attach(randomBytes(ATTACHMENT_BYTES), `blob-${i}.bin`, { mimeType: 'application/octet-stream' })
}
addPages(PAGE_COUNT / 2, PAGE_COUNT)

mkdirSync(join(root, 'tmp'), { recursive: true })
writeFileSync(target, await doc.save({ useObjectStreams: false }))
console.log(`[large-sample] 已生成 ${target}(${PAGE_COUNT} 页 / ${ATTACHMENT_COUNT} MB 附件)`)
