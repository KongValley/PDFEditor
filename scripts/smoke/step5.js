// 步骤 5 冒烟:注释保存到 PDF、sidecar 往返、/Rotate 页 WYSIWYG 往返(像素校验)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
const fire = (target, type, x, y) => {
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }))
}

const out = {}

/* ---------- A. 中文文档:交互标注 + 保存 + 往返恢复 ---------- */

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)

const wrap = document.querySelector('[data-page="1"]')
const svg = wrap.querySelector('.ann-layer')
const pageBox = svg.getBoundingClientRect()

// 高亮(拖拽框选)
t.ui.tool = 'highlight'
fire(svg, 'pointerdown', pageBox.left + 60, pageBox.top + 100)
fire(wrap, 'pointermove', pageBox.left + 300, pageBox.top + 150)
fire(wrap, 'pointerup', pageBox.left + 300, pageBox.top + 150)
await sleep(150)
check('高亮已创建', t.annotState.items.some((a) => a.kind === 'highlight'), t.annotState.items.length)

// 程序化补齐:中文文字 + 图章 + 涂鸦 + 箭头
t.addAnnotation(
  t.withIdentity({
    kind: 'text',
    page: 0,
    bbox: { x: 80, y: 420, w: 240, h: 60 },
    color: '#212529',
    opacity: 1,
    text: '你好世界 Hello 中文测试',
    fontSize: 18,
    rotate: 0
  })
)
t.addAnnotation(
  t.withIdentity({
    kind: 'stamp',
    page: 0,
    bbox: { x: 330, y: 300, w: 150, h: 48 },
    color: '#2f9e44',
    opacity: 0.95,
    stampKey: 'approved',
    label: '已批准',
    fontSize: 16,
    rotate: 0
  })
)
t.addAnnotation(
  t.withIdentity({
    kind: 'ink',
    page: 0,
    bbox: { x: 100, y: 250, w: 120, h: 60 },
    color: '#e03131',
    opacity: 1,
    thickness: 3,
    points: [
      { x: 100, y: 250 },
      { x: 150, y: 300 },
      { x: 220, y: 260 }
    ]
  })
)
t.addAnnotation(
  t.withIdentity({
    kind: 'arrow',
    page: 0,
    bbox: { x: 300, y: 220, w: 120, h: 80 },
    color: '#1971c2',
    opacity: 1,
    thickness: 2,
    from: { x: 300, y: 220 },
    to: { x: 420, y: 300 }
  })
)
await sleep(200)
const beforeSave = t.annotState.items.length
check('保存前注释数', beforeSave === 5, beforeSave)

const save1 = await window.pdfAPI.invoke('save:saveAs', {
  docId: t.docState.docId,
  defaultPath: 'saved-zh.pdf',
  targetPath: `${__smokeRoot}/tmp/saved-zh.pdf`,
  annotations: t.exportAnnotations(),
  formValues: {}
})
check('保存成功', save1.ok === true && save1.mode === 'pdf', save1)
out.save1 = { mode: save1.mode, warnings: save1.warnings }

// 重开保存后的文件:sidecar 应恢复全部注释
await t.openPath(`${__smokeRoot}/tmp/saved-zh.pdf`)
await sleep(1500)
check('重开后注释恢复', t.annotState.items.length === 5, t.annotState.items.length)
out.restoredKinds = t.annotState.items.map((a) => a.kind)

/* ---------- B. /Rotate 90 页:视觉位置往返(像素校验) ---------- */

await t.openPath(`${__smokeRoot}/samples/sample-rotated.pdf`)
await sleep(1200)
t.ui.tool = 'select'
t.scrollToPage(2)
await sleep(900)

const wrap2 = document.querySelector('[data-page="2"]')
check('第 2 页存在', !!wrap2, null)
const svg2 = wrap2.querySelector('.ann-layer')
const rect2 = svg2.getBoundingClientRect()

// 在视觉左上区域画高亮
const fromX = rect2.left + 80
const fromY = rect2.top + 60
const toX = rect2.left + 220
const toY = rect2.top + 110
t.ui.tool = 'highlight'
fire(svg2, 'pointerdown', fromX, fromY)
fire(wrap2, 'pointermove', toX, toY)
fire(wrap2, 'pointerup', toX, toY)
await sleep(200)
const rotatedAnn = t.annotState.items.find((a) => a.kind === 'highlight' && a.page === 1)
check('旋转页高亮已创建', !!rotatedAnn, t.annotState.items.map((a) => `${a.kind}@${a.page}`))
out.rotatedBbox = { ...rotatedAnn.bbox }
out.screenRect = { x: fromX - rect2.left, y: fromY - rect2.top, w: toX - fromX, h: toY - fromY }

const save2 = await window.pdfAPI.invoke('save:saveAs', {
  docId: t.docState.docId,
  defaultPath: 'saved-rotated.pdf',
  targetPath: `${__smokeRoot}/tmp/saved-rotated.pdf`,
  annotations: t.exportAnnotations(),
  formValues: {},
  writeSidecar: false
})
check('旋转页保存成功', save2.ok === true, save2)
await sleep(300)

// 重开保存后的文件(无 sidecar → 只显示 PDF 内已烘焙的内容)
await t.openPath(`${__smokeRoot}/tmp/saved-rotated.pdf`)
await sleep(1200)
check('无 sidecar 时不恢复注释', t.annotState.items.length === 0, t.annotState.items.length)
t.scrollToPage(2)
await sleep(1200)

const wrap2b = document.querySelector('[data-page="2"]')
const canvas2 = wrap2b.querySelector('.page-canvas')
const ctx = canvas2.getContext('2d')
const dpr = canvas2.width / parseFloat(canvas2.style.width)
const sampleX = Math.round((out.screenRect.x + out.screenRect.w / 2) * dpr)
const sampleY = Math.round((out.screenRect.y + out.screenRect.h / 2) * dpr)
const pixel = ctx.getImageData(sampleX, sampleY, 1, 1).data
out.pixel = [pixel[0], pixel[1], pixel[2]]
const yellowish = pixel[0] > 200 && pixel[1] > 180 && pixel[2] < 200
check('保存后的高亮位于原视觉位置(像素校验)', yellowish, out.pixel)

// 对照:页面右下角区域不应是高亮色
const farPixel = ctx.getImageData(Math.round(canvas2.width * 0.8), Math.round(canvas2.height * 0.85), 1, 1).data
out.farPixel = [farPixel[0], farPixel[1], farPixel[2]]
check('无关区域未被高亮', !(farPixel[0] > 200 && farPixel[1] > 180 && farPixel[2] < 200), out.farPixel)

return out
