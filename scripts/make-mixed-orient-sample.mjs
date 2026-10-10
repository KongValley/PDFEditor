// 生成"方向不一致"冒烟夹具(samples/sample-mixed-orient.pdf,6 页):
//   p1–p3 纵向 + 内容正立      → 多数派基准
//   p4 横向页面框 + 内容整体转 90°(模拟扫描仪进纸歪斜)→ 应被判为横躺并建议转 270°(逆时针 90°)
//   p5 纵向页面框 + 内容转 180°(倒置)              → 应被判为倒置并建议转 180°
//   p6 横向页面框 + 内容相对页面正立(一张宽表格)   → **不应被误伤**(真正横向页)
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'samples', 'sample-mixed-orient.pdf')

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)

function drawLines(page, lines, rotate) {
  // 每行一次 drawText:pdf.js 的 getTextContent 按绘制调用产出条目,
  // 一整块 \n 文本只会得到一个条目,文字朝向判定拿不到足够票数
  lines.forEach((line, i) => {
    page.drawText(line, {
      x: 60,
      y: 780 - i * 26,
      size: 12,
      font,
      rotate: degrees(rotate)
    })
  })
}

const upright = Array.from({ length: 10 }, (_, i) => `upright line ${i + 1} lorem ipsum dolor sit amet consectetur`)

// p1–p3:纵向正立
for (let i = 0; i < 3; i++) {
  const page = doc.addPage([595, 842])
  drawLines(page, upright, 0)
}

// p4:横向页面框 + 内容转 90°(横躺)
{
  const page = doc.addPage([842, 595])
  drawLines(page, upright, 90)
}

// p5:纵向页面框 + 内容转 180°(倒置)
{
  const page = doc.addPage([595, 842])
  drawLines(page, upright, 180)
}

// p6:横向页面框 + 内容相对页面正立(宽表格,不应被误伤)
{
  const page = doc.addPage([842, 595])
  for (let row = 0; row < 12; row++) {
    page.drawText(`wide table row ${row + 1}`, { x: 50, y: 520 - row * 26, size: 11, font })
  }
}

mkdirSync(join(root, 'samples'), { recursive: true })
writeFileSync(target, await doc.save({ useObjectStreams: false }))
console.log(`[mixed-orient-sample] 已生成 ${target}`)