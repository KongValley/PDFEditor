// 生成低内存冒烟用的大文档(tmp/50pages.pdf:50 页,内容取自 samples/sample-zh.pdf)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'samples', 'sample-zh.pdf')
if (!existsSync(source)) {
  console.error('缺少 samples/sample-zh.pdf,请先运行 npm run samples 的前置步骤')
  process.exit(1)
}

const src = await PDFDocument.load(readFileSync(source))
const out = await PDFDocument.create()
for (let i = 0; i < 16; i++) {
  const pages = await out.copyPages(src, [0, 1, 2])
  for (const page of pages) out.addPage(page)
}
const tail = await out.copyPages(src, [0, 1])
for (const page of tail) out.addPage(page)

mkdirSync(join(root, 'tmp'), { recursive: true })
const target = join(root, 'tmp', '50pages.pdf')
writeFileSync(target, await out.save({ useObjectStreams: false }))
console.log(`[big-sample] 已生成 ${target}(50 页)`)
