// 步骤 8 端到端冒烟:全类型注释 + 图片 + 保存 + 往返恢复 + 烘焙内容像素校验
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
const fire = (target, type, x, y) => {
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }))
}

const root = 'F:/DeepSeek工作区/pdf编辑器'
await t.openPath(`${root}/samples/sample-zh.pdf`)
await sleep(1500)

// 1) 交互:高亮拖拽
const wrap = document.querySelector('[data-page="1"]')
const svg = wrap.querySelector('.ann-layer')
const box = svg.getBoundingClientRect()
t.ui.tool = 'highlight'
fire(svg, 'pointerdown', box.left + 60, box.top + 90)
fire(wrap, 'pointermove', box.left + 300, box.top + 130)
fire(wrap, 'pointerup', box.left + 300, box.top + 130)
await sleep(150)
check('高亮已创建', t.annotState.items.length === 1, t.annotState.items.length)

// 2) 程序化补齐其余类型(含图片)
const info = await window.pdfAPI.invoke('img:getByPath', `${root}/resources/icon.png`)
check('图片导入成功', !!info.imgId, info.error ?? null)
t.annotState.imageUrls[info.imgId] = info.dataUrl

const page = 0
t.addAnnotation(t.withIdentity({ kind: 'rect', page, bbox: { x: 60, y: 700, w: 160, h: 60 }, color: '#e03131', opacity: 1, thickness: 2 }))
t.addAnnotation(t.withIdentity({ kind: 'ellipse', page, bbox: { x: 250, y: 700, w: 140, h: 60 }, color: '#7048e8', opacity: 1, thickness: 2 }))
t.addAnnotation(
  t.withIdentity({
    kind: 'ink',
    page,
    bbox: { x: 60, y: 600, w: 120, h: 60 },
    color: '#e03131',
    opacity: 1,
    thickness: 3,
    points: [{ x: 60, y: 600 }, { x: 110, y: 660 }, { x: 180, y: 610 }]
  })
)
t.addAnnotation(
  t.withIdentity({
    kind: 'arrow',
    page,
    bbox: { x: 250, y: 600, w: 140, h: 60 },
    color: '#1971c2',
    opacity: 1,
    thickness: 2,
    from: { x: 250, y: 600 },
    to: { x: 390, y: 660 }
  })
)
t.addAnnotation(
  t.withIdentity({
    kind: 'measure',
    page,
    bbox: { x: 60, y: 500, w: 200, h: 0 },
    color: '#1971c2',
    opacity: 1,
    thickness: 1.5,
    from: { x: 60, y: 500 },
    to: { x: 260, y: 500 },
    unit: 'mm'
  })
)
t.addAnnotation(
  t.withIdentity({
    kind: 'text',
    page,
    bbox: { x: 60, y: 420, w: 240, h: 60 },
    color: '#212529',
    opacity: 1,
    text: '端到端测试 Hello',
    fontSize: 16,
    rotate: 0
  })
)
t.addAnnotation(
  t.withIdentity({
    kind: 'note',
    page,
    bbox: { x: 480, y: 740, w: 26, h: 26 },
    color: '#f7c948',
    opacity: 1,
    text: '便签:检查保存后的效果'
  })
)
t.addAnnotation(
  t.withIdentity({
    kind: 'stamp',
    page,
    bbox: { x: 320, y: 300, w: 150, h: 48 },
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
    kind: 'image',
    page,
    bbox: { x: 420, y: 480, w: 120, h: 120 },
    color: '#212529',
    opacity: 1,
    imgId: info.imgId,
    refPath: info.refPath
  })
)
await sleep(300)
check('共 10 条注释', t.annotState.items.length === 10, t.annotState.items.map((a) => a.kind))
check('渲染 10 个图形', wrap.querySelectorAll('.ann-layer > g.shape').length === 10, wrap.querySelectorAll('.ann-layer > g.shape').length)

// 3) 保存(带 sidecar)并重开校验恢复
const save = await window.pdfAPI.invoke('save:saveAs', {
  docId: t.docState.docId,
  defaultPath: 'e2e.pdf',
  targetPath: `${root}/tmp/e2e.pdf`,
  annotations: t.exportAnnotations(),
  formValues: {},
  writeSidecar: true
})
check('保存成功', save.ok === true && save.mode === 'pdf', save)
check('无保存告警', !save.warnings || save.warnings.length === 0, save.warnings)

await t.openPath(`${root}/tmp/e2e.pdf`)
await sleep(1500)
check('sidecar 恢复 10 条注释', t.annotState.items.length === 10, t.annotState.items.length)
const imageRestored = t.annotState.items.find((a) => a.kind === 'image')
check('图片注释 dataUrl 已恢复', !!t.annotState.imageUrls[imageRestored.imgId], null)

// 4) 再保存一份不含 sidecar 的副本,用于校验烘焙进 PDF 的内容
const save2 = await window.pdfAPI.invoke('save:saveAs', {
  docId: t.docState.docId,
  defaultPath: 'e2e-baked.pdf',
  targetPath: `${root}/tmp/e2e-baked.pdf`,
  annotations: t.exportAnnotations(),
  formValues: {},
  writeSidecar: false
})
check('二次保存成功', save2.ok === true, save2)

await t.openPath(`${root}/tmp/e2e-baked.pdf`)
await sleep(1500)
check('无 sidecar 时注释为空', t.annotState.items.length === 0, t.annotState.items.length)

// 5) 像素校验:便签(黄色)、图片(非白)、文字(非白)
const wrapB = document.querySelector('[data-page="1"]')
const canvas = wrapB.querySelector('.page-canvas')
const ctx = canvas.getContext('2d')
const dpr = canvas.width / parseFloat(canvas.style.width)
const vp = { scale: t.docState.scale }
const toCanvas = (pdfX, pdfYTop) => ({ x: Math.round(pdfX * vp.scale * dpr), y: Math.round(pdfYTop * vp.scale * dpr) })

// 便签位于 PDF (480,740)-(506,766):屏幕 y = (841-766)=75 → 中心 (493, 88)
const notePx = ctx.getImageData(...Object.values(toCanvas(493, 88)).slice(0, 2), 1, 1).data
const isYellow = notePx[0] > 200 && notePx[1] > 170 && notePx[2] < 160
check('便签烘焙位置正确(黄色)', isYellow, [notePx[0], notePx[1], notePx[2]])

// 图片位于 PDF (420,480)-(540,600);图标圆角外沿透明,取左侧深蓝底区域(px 100,250 → PDF 443,300)
const imgPx = ctx.getImageData(...Object.values(toCanvas(443, 300)).slice(0, 2), 1, 1).data
const isDark = imgPx[0] < 120 && imgPx[1] < 120 && imgPx[2] < 160
check('图片已烘焙(图标底色)', isDark, [imgPx[0], imgPx[1], imgPx[2]])

// 文字位于 PDF (60,420)-(300,480):首行基线距页顶 377 → 扫描该行区域找墨迹像素
const textOrigin = toCanvas(60, 360)
const textRegion = ctx.getImageData(textOrigin.x, textOrigin.y, Math.round(60 * vp.scale * dpr), Math.round(20 * vp.scale * dpr)).data
let darkPixels = 0
for (let i = 0; i < textRegion.length; i += 4) {
  if (textRegion[i] < 180 && textRegion[i + 1] < 180) darkPixels++
}
check('文字已烘焙', darkPixels > 10, darkPixels)

return {
  kinds: t.annotState.items.length,
  notePixel: [notePx[0], notePx[1], notePx[2]],
  imagePixel: [imgPx[0], imgPx[1], imgPx[2]],
  darkPixels
}
