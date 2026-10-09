// 生成测试用 PDF 样本(中文文本 / 表单 / 旋转页)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'samples')
mkdirSync(outDir, { recursive: true })

// PDF_EDITOR_CJK_FONT 可指定字体文件(CI 的 windows runner 没有 SimHei,那里会下载一份思源黑体)
const CJK_FONT_PATH = process.env['PDF_EDITOR_CJK_FONT'] || 'C:/Windows/Fonts/simhei.ttf'
const cjkBytes = readFileSync(CJK_FONT_PATH)

async function makeChineseDoc() {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const cjk = await doc.embedFont(cjkBytes, { subset: true })
  const latin = await doc.embedFont(StandardFonts.Helvetica)

  const page1 = doc.addPage([595.28, 841.89])
  page1.drawText('PDF 编辑器测试文档', { x: 60, y: 770, size: 24, font: cjk, color: rgb(0.1, 0.1, 0.15) })
  page1.drawText('第一页:中文渲染与文本选择', { x: 60, y: 730, size: 14, font: cjk, color: rgb(0.2, 0.2, 0.25) })
  page1.drawText('Hello World, this is a PDF sample for the editor.', {
    x: 60,
    y: 700,
    size: 12,
    font: latin,
    color: rgb(0.2, 0.2, 0.25)
  })
  page1.drawText('这是一段中文正文,用于验证搜索、高亮与文本层。', {
    x: 60,
    y: 670,
    size: 12,
    font: cjk,
    color: rgb(0.2, 0.2, 0.25)
  })
  page1.drawText('编辑器支持高亮、涂鸦、箭头、便签与图章。', {
    x: 60,
    y: 648,
    size: 12,
    font: cjk,
    color: rgb(0.2, 0.2, 0.25)
  })

  const page2 = doc.addPage([595.28, 841.89])
  page2.drawText('第二页:用于页面管理测试', { x: 60, y: 770, size: 20, font: cjk, color: rgb(0.1, 0.1, 0.15) })
  for (let i = 0; i < 6; i++) {
    page2.drawText(`第 ${i + 1} 行示例文本,包含中文与 English words。`, {
      x: 60,
      y: 700 - i * 26,
      size: 12,
      font: cjk,
      color: rgb(0.25, 0.25, 0.3)
    })
  }

  const page3 = doc.addPage([595.28, 841.89])
  page3.drawText('第三页:尾部页', { x: 60, y: 770, size: 20, font: cjk, color: rgb(0.1, 0.1, 0.15) })
  page3.drawText('本页用于验证删除与拆分。', { x: 60, y: 730, size: 12, font: cjk, color: rgb(0.25, 0.25, 0.3) })

  writeFileSync(join(outDir, 'sample-zh.pdf'), await doc.save())
}

async function makeFormDoc() {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const cjk = await doc.embedFont(cjkBytes, { subset: true })
  const latin = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595.28, 841.89])
  page.drawText('表单测试', { x: 60, y: 770, size: 20, font: cjk, color: rgb(0.1, 0.1, 0.15) })
  page.drawText('Name:', { x: 60, y: 720, size: 12, font: latin, color: rgb(0.2, 0.2, 0.25) })
  page.drawText('Agree:', { x: 60, y: 680, size: 12, font: latin, color: rgb(0.2, 0.2, 0.25) })

  const form = doc.getForm()
  const name = form.createTextField('name')
  name.setText('')
  name.addToPage(page, { x: 110, y: 712, width: 220, height: 22, borderWidth: 1, borderColor: rgb(0.4, 0.4, 0.5) })
  const agree = form.createCheckBox('agree')
  agree.addToPage(page, { x: 110, y: 674, width: 18, height: 18, borderWidth: 1, borderColor: rgb(0.4, 0.4, 0.5) })

  writeFileSync(join(outDir, 'sample-form.pdf'), await doc.save())
}

async function makeRotatedDoc() {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const cjk = await doc.embedFont(cjkBytes, { subset: true })
  const page1 = doc.addPage([595.28, 841.89])
  page1.drawText('第一页:正常方向', { x: 60, y: 770, size: 20, font: cjk, color: rgb(0.1, 0.1, 0.15) })
  const page2 = doc.addPage([595.28, 841.89])
  page2.setRotation(degrees(90))
  page2.drawText('第二页:已旋转 90 度', { x: 60, y: 770, size: 20, font: cjk, color: rgb(0.1, 0.1, 0.15) })
  page2.drawText('ROTATED PAGE CONTENT', { x: 60, y: 730, size: 14, font: cjk, color: rgb(0.3, 0.3, 0.35) })
  writeFileSync(join(outDir, 'sample-rotated.pdf'), await doc.save())
}

await makeChineseDoc()
await makeFormDoc()
await makeRotatedDoc()
console.log('样本已生成到 samples/')
