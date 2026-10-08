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

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
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
// img:getByPath 只回传图片信息、不占主进程缓存(渲染层用批注自己的 imgId),故 imgId 为空串;
// 这里给批注一个自造 id,等价于"从 PDF 恢复出来的图片批注"这条真实路径。
const info = await window.pdfAPI.invoke('img:getByPath', `${__smokeRoot}/resources/icon.png`)
check('图片读取成功', !info.error && !!info.dataUrl, info.error ?? null)
check('img:getByPath 不再写入缓存(imgId 为空串)', info.imgId === '', info.imgId)
const imageId = `smoke-img-${Date.now()}`
t.annotState.imageUrls[imageId] = info.dataUrl

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
    imgId: imageId,
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
  targetPath: `${__smokeRoot}/tmp/e2e.pdf`,
  annotations: t.exportAnnotations(),
  formValues: {},
  writeSidecar: true
})
check('保存成功', save.ok === true && save.mode === 'pdf', save)
check('无保存告警', !save.warnings || save.warnings.length === 0, save.warnings)

await t.openPath(`${__smokeRoot}/tmp/e2e.pdf`)
await sleep(1500)
check('sidecar 恢复 10 条注释', t.annotState.items.length === 10, t.annotState.items.length)
const imageRestored = t.annotState.items.find((a) => a.kind === 'image')
check('图片注释 dataUrl 已恢复', !!t.annotState.imageUrls[imageRestored.imgId], null)

// 4) 再保存一份不含 sidecar 的副本:批注以真实 PDF 批注对象(/Annots)存储
const save2 = await window.pdfAPI.invoke('save:saveAs', {
  docId: t.docState.docId,
  defaultPath: 'e2e-baked.pdf',
  targetPath: `${__smokeRoot}/tmp/e2e-baked.pdf`,
  annotations: t.exportAnnotations(),
  formValues: {},
  writeSidecar: false
})
check('二次保存成功', save2.ok === true, save2)

await t.openPath(`${__smokeRoot}/tmp/e2e-baked.pdf`)
await sleep(1500)
check('无 sidecar 时从 PDF 恢复 10 条注释', t.annotState.items.length === 10, t.annotState.items.length)

// 覆盖层渲染校验:真实批注对象路径下屏幕由 SVG 覆盖层绘制(页面画布不含批注)
const noteAnn = t.annotState.items.find((a) => a.kind === 'note')
check('便签注释已恢复', !!noteAnn, null)

const overlayDeadline = Date.now() + 10000
let noteEl = null
while (Date.now() < overlayDeadline) {
  noteEl = document.querySelector(`[data-page="1"] .ann-layer rect[fill="${noteAnn.color}"]`)
  if (noteEl) break
  await sleep(150)
}
check('便签渲染在注释覆盖层', !!noteEl, null)

// 便签位于 PDF (480,740)-(506,766):屏幕中心 (493*scale, 88.9*scale)
const scale = t.docState.scale
const wrapRect = document.querySelector('[data-page="1"]').getBoundingClientRect()
const noteRect = noteEl.getBoundingClientRect()
const noteCx = (noteRect.left + noteRect.right) / 2 - wrapRect.left
const noteCy = (noteRect.top + noteRect.bottom) / 2 - wrapRect.top
check(
  '便签渲染位置与保存前一致(±6px)',
  Math.abs(noteCx - 493 * scale) < 6 && Math.abs(noteCy - 88.9 * scale) < 6,
  { noteCx, noteCy, scale }
)

// 图片与文字同样回到覆盖层
const imgEl = document.querySelector('[data-page="1"] .ann-layer image')
check('图片注释渲染在覆盖层', !!imgEl && (imgEl.getAttribute('href') ?? '').startsWith('data:image/png'), null)
const textEls = [...document.querySelectorAll('[data-page="1"] .ann-layer text.text-ann')]
check('文字注释渲染在覆盖层', textEls.some((el) => (el.textContent ?? '').includes('端到端测试')), textEls.map((el) => el.textContent))

return {
  kinds: t.annotState.items.length,
  noteCenter: [Math.round(noteCx), Math.round(noteCy)],
  scale,
  textEls: textEls.length
}
