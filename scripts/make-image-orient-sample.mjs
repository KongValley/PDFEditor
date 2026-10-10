// 生成"纯图片扫描件方向不一致"冒烟夹具(samples/sample-image-orient.pdf,6 页):
//   p1–p3 图像页、内容正立 → 多数派基准,同时是"行墨迹剖面共识"的参考
//   p4    图像页、内容整体转 180°(模拟进纸倒置)→ 没有文字层,只能靠全篇剖面的共识判出来
//   p5    横向图像页、内容相对页面正立(宽内容)→ 候选页,但**不应被转**(OCR 读不出合成图案时退回墨迹投影)
//   p6    纵向页面框、内容整体转 90°(横躺)→ 页面框已是基准向,靠像素判据认出来并转正(连带翻转页面框)
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

/** 画一页"扫描件":每 7 行短一行(模拟段落末行),使行墨迹剖面天然上下不对称。
 *  rotate90:先在"转过来的"版面(842×595)上排版,再整体顺时针转进纵向页面框 —— 纵向框 + 横躺内容 */
function drawScanPage(page, { flip = false, rotate90 = false } = {}) {
  const W = page.getWidth()
  const H = page.getHeight()
  const vw = rotate90 ? H : W
  const vh = rotate90 ? W : H
  const margin = Math.min(MARGIN, Math.round(vw * 0.1))
  const bars = []
  let row = 0
  for (let y = vh - Math.min(LINE_H * 10, vh * 0.08); y - LINE_H > vh * 0.06; y -= PITCH) {
    const width = vw - 2 * margin - (row % 7 === 6 ? Math.floor(vw * 0.32) : 0)
    bars.push({ x: margin, y, w: width })
    row++
  }
  for (const bar of bars) {
    // 横躺页:版面坐标 (x,y) → 页面坐标 (y, H-(x+w))(上式在 vw=H、vh=W 时恰好化简成这样)
    const rect = rotate90
      ? { x: bar.y, y: H - (bar.x + bar.w), width: LINE_H, height: bar.w }
      : {
          x: flip ? vw - margin - bar.w : margin,
          y: flip ? vh - bar.y - LINE_H : bar.y,
          width: bar.w,
          height: LINE_H
        }
    page.drawRectangle({ ...rect, color: rgb(0.15, 0.15, 0.15) })
  }
}

const doc = await PDFDocument.create()
for (let i = 0; i < 3; i++) drawScanPage(doc.addPage(PAGE))
drawScanPage(doc.addPage(PAGE), { flip: true }) // p4:内容倒置
drawScanPage(doc.addPage([842, 595])) // p5:真正横向的内容(不应被转)
drawScanPage(doc.addPage(PAGE), { rotate90: true }) // p6:纵向框、内容横躺

mkdirSync(join(root, 'samples'), { recursive: true })
writeFileSync(target, await doc.save({ useObjectStreams: false }))
console.log(`[image-orient-sample] 已生成 ${target}`)
