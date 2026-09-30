// 生成带书签大纲的测试 PDF(手写 PDF 结构,含中文标题与嵌套层级)
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function pdfText(text) {
  return `<${Buffer.from('\ufeff' + text, 'utf16le').swap16().toString('hex').toUpperCase()}>`
}

const chunks = []
let offset = 0
const offsets = [0]
function push(text) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text, 'latin1')
  chunks.push(buf)
  offset += buf.length
}
function object(num, body) {
  offsets[num] = offset
  push(`${num} 0 obj\n${body}\nendobj\n`)
}

push('%PDF-1.4\n')
object(1, '<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /PageMode /UseOutlines >>')
object(2, '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>')

for (let i = 0; i < 3; i++) {
  const pageNum = 3 + i
  const contentNum = 11 + i
  object(
    pageNum,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents ${contentNum} 0 R /Resources << /Font << /F1 10 0 R >> >> >>`
  )
}

object(6, '<< /Type /Outlines /First 7 0 R /Last 8 0 R /Count 3 >>')
object(
  7,
  `<< /Title ${pdfText('第 1 章 概览')} /Parent 6 0 R /Next 8 0 R /First 9 0 R /Last 9 0 R /Count 1 /Dest [3 0 R /Fit] >>`
)
object(8, `<< /Title ${pdfText('第 2 章 细节')} /Parent 6 0 R /Prev 7 0 R /Dest [5 0 R /Fit] >>`)
object(9, `<< /Title ${pdfText('1.1 小节')} /Parent 7 0 R /Dest [4 0 R /Fit] >>`)
object(10, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

for (let i = 0; i < 3; i++) {
  const contentNum = 11 + i
  const text = `BT /F1 20 Tf 40 200 Td (Outline Test Page ${i + 1}) Tj ET`
  offsets[contentNum] = offset
  push(`${contentNum} 0 obj\n<< /Length ${text.length} >>\nstream\n${text}\nendstream\nendobj\n`)
}

const xrefOffset = offset
let xref = 'xref\n0 14\n0000000000 65535 f \n'
for (let i = 1; i <= 13; i++) xref += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`
push(xref)
push(`trailer\n<< /Size 14 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'sample-outline.pdf')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, Buffer.concat(chunks))
console.log('已生成大纲样本:', outPath)
