// 生成"纯图片扫描件方向不一致"冒烟夹具(samples/sample-image-orient.pdf,5 页):
//   p1–p3 图像页、内容正立 → 多数派基准,同时是"行墨迹剖面共识"的参考
//   p4    图像页、内容整体转 180°(模拟进纸倒置)→ 没有文字层,只能靠全篇剖面的共识判出来
//   p5    横向图像页、内容相对页面正立(宽内容)→ 候选页,但**不应被转**(OCR 读不出合成图案时退回墨迹投影)
//
// 页面内容是脚本里画的矩形条(不是文字、也不嵌字体):方向判定只用到行墨迹结构,
// 而"没有 /Font 资源"正是纯图片扫描件在判定路径上的关键特征。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, rgb } from 'pdf-lib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'samples', 'sample-image-orient.pdf')

const PAGE = [595, 842]
const MARGIN = 60
const LINE_H = 7
const PITCH = 18

/** 画一页"扫描件":每 7 行短一行(模拟段落末行),使行墨迹剖面天然上下不对称 */
function drawScanPage(page, flip) {
  const [W, H] = [page.getWidth(), page.getHeight()]
  const margin = Math.min(MARGIN, Math.round(W * 0.1))
  let row = 0
  for (let y = H - Math.min(LINE_H * 10, H * 0.08); y - LINE_H > H * 0.06; y -= PITCH) {
    const width = W - 2 * margin - (row % 7 === 6 ? Math.floor(W * 0.32) : 0)
    page.drawRectangle({
      x: flip ? W - margin - width : margin,
      y: flip ? H - y - LINE_H : y,
      width,
      height: LINE_H,
      color: rgb(0.15, 0.15, 0.15)
    })
    row++
  }
}

const doc = await PDFDocument.create()
for (let i = 0; i < 3; i++) drawScanPage(doc.addPage(PAGE), false)
drawScanPage(doc.addPage(PAGE), true) // p4:内容倒置
drawScanPage(doc.addPage([842, 595]), false) // p5:真正横向的内容(不应被转)

mkdirSync(join(root, 'samples'), { recursive: true })
writeFileSync(target, await doc.save({ useObjectStreams: false }))
console.log(`[image-orient-sample] 已生成 ${target}`)
