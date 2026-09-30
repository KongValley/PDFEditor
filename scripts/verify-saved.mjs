// 校验保存产物:指定文本可提取(证明字体嵌入与真实文本写入)、页数、sidecar 是否写出
// 用法:node scripts/verify-saved.mjs <pdf> [期望文本...] [--no-sidecar] [--pages=N]
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const target = args[0] ?? join(root, 'tmp', 'saved-zh.pdf')
const expectSidecar = !args.includes('--no-sidecar')
const pagesArg = args.find((a) => a.startsWith('--pages='))
const expectedPages = pagesArg ? Number(pagesArg.split('=')[1]) : null
const requiredTexts = args.slice(1).filter((a) => !a.startsWith('--'))

if (!existsSync(target)) {
  console.error(`缺少文件:${target}`)
  process.exit(1)
}

const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(target)) }).promise
const texts = []
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i)
  const content = await page.getTextContent()
  texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''))
}
const all = texts.join('\n')

const checks = []
if (expectedPages !== null) checks.push([`页数为 ${expectedPages}`, doc.numPages === expectedPages, doc.numPages])
for (const text of requiredTexts) {
  checks.push([`文本可提取:「${text}」`, all.includes(text), null])
}
if (expectSidecar) {
  checks.push([`sidecar 已写出`, existsSync(`${target}anno.json`), `${target}anno.json`])
}

let failed = 0
for (const [name, ok, extra] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra === null ? '' : ` (${JSON.stringify(extra)})`}`)
  if (!ok) failed++
}
if (checks.length === 0) console.log('无断言可执行(未指定期望文本)')

await doc.cleanup()
process.exit(failed === 0 ? 0 : 1)
