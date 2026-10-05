// 步骤 9 冒烟:文字/便签编辑、属性面板、拖动与缩放、Escape、测量标签
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
const fire = (target, type, x, y) => {
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }))
}

// 工具栏布局:两行且无横向滚动条
const toolbarEl = document.querySelector('.toolbar')
check('工具栏为两行', document.querySelectorAll('.toolbar-row').length === 2, document.querySelectorAll('.toolbar-row').length)
check(
  '工具栏无横向滚动',
  toolbarEl.scrollWidth <= toolbarEl.clientWidth,
  { scrollWidth: toolbarEl.scrollWidth, clientWidth: toolbarEl.clientWidth }
)

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)

const wrap = document.querySelector('[data-page="1"]')
const svg = wrap.querySelector('.ann-layer')
const box = svg.getBoundingClientRect()

// 1) 交互放置文字注释(点击放置 → 自动打开编辑框)
t.ui.tool = 'text'
fire(svg, 'pointerdown', box.left + 120, box.top + 260)
fire(window, 'pointerup', box.left + 120, box.top + 260)
// 同步断言:注释在 pointerup 处理函数内同步写入 store,不受后续渲染/焦点竞态影响
check(
  '文字注释已创建',
  t.annotState.items.length === 1 && t.annotState.items[0].kind === 'text',
  { kinds: t.annotState.items.map((a) => a.kind), tool: t.ui.tool }
)
await sleep(250)
const editor = document.querySelector('.ann-editor textarea')
if (!editor) {
  check('编辑框自动打开', false, {
    items: t.annotState.items.map((a) => ({ kind: a.kind, text: a.text })),
    activeElement: document.activeElement?.tagName ?? '?',
    shapes: document.querySelectorAll('.ann-layer > g.shape').length,
    layers: document.querySelectorAll('.ann-layer').length,
    selected: t.ui.selectedAnnotationIds[0] ?? null
  })
}
editor.value = '双击编辑内容'
editor.dispatchEvent(new Event('input', { bubbles: true }))
editor.dispatchEvent(new Event('blur', { bubbles: true }))
await sleep(200)
check('编辑内容已保存', t.annotState.items[0].text === '双击编辑内容', t.annotState.items[0].text)
check('编辑框已关闭', !document.querySelector('.ann-editor'), null)

// 2) 双击重新编辑便签类
const textAnn = t.annotState.items[0]
t.ui.tool = 'select'
await sleep(100)
const shape = wrap.querySelector(`.ann-layer > g.shape`)
shape.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
await sleep(200)
check('双击打开编辑框', !!document.querySelector('.ann-editor textarea'), null)
const editor2 = document.querySelector('.ann-editor textarea')
editor2.value = '修改后的文字'
editor2.dispatchEvent(new Event('input', { bubbles: true }))
await sleep(80)
editor2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
await sleep(250)
const afterEsc = { text: t.annotState.items[0].text, editorOpen: !!document.querySelector('.ann-editor') }
if (afterEsc.text !== '修改后的文字') {
  document.querySelector('.ann-editor textarea')?.dispatchEvent(new Event('blur', { bubbles: true }))
  await sleep(250)
}
check('修改已提交', t.annotState.items[0].text === '修改后的文字', {
  afterEsc,
  afterBlur: t.annotState.items[0].text,
  ann: JSON.parse(JSON.stringify(t.annotState.items[0]))
})

// 3) 属性面板改色
t.ui.selectedAnnotationIds = [textAnn.id]
await sleep(200)
const swatches = document.querySelectorAll('.props .swatch')
check('色板渲染', swatches.length >= 8, swatches.length)
swatches[3].dispatchEvent(new MouseEvent('click', { bubbles: true }))
await sleep(150)
check('颜色已更新', t.annotState.items[0].color.toLowerCase() === '#1971c2', t.annotState.items[0].color)

// 4) 拖动移动
const beforeMove = { ...t.annotState.items[0].bbox }
const shapeEl = wrap.querySelector('.ann-layer > g.shape')
const shapeRect = shapeEl.getBoundingClientRect()
fire(shapeEl, 'pointerdown', shapeRect.left + 10, shapeRect.top + 10)
fire(window, 'pointermove', shapeRect.left + 60, shapeRect.top + 40)
fire(window, 'pointerup', shapeRect.left + 60, shapeRect.top + 40)
await sleep(200)
const afterMove = t.annotState.items[0].bbox
check('拖动改变了位置', Math.abs(afterMove.x - beforeMove.x) > 5 || Math.abs(afterMove.y - beforeMove.y) > 5, {
  before: beforeMove,
  after: afterMove
})
check('拖动未改变尺寸', Math.abs(afterMove.w - beforeMove.w) < 0.01 && Math.abs(afterMove.h - beforeMove.h) < 0.01, afterMove)

// 5) 把手缩放(右下角)
const handles = wrap.querySelectorAll('.ann-layer .handle')
check('把手数量 8', handles.length === 8, handles.length)
const seHandle = handles[4]
const handleRect = seHandle.getBoundingClientRect()
const beforeResize = { ...t.annotState.items[0].bbox }
fire(seHandle, 'pointerdown', handleRect.left + 4, handleRect.top + 4)
fire(window, 'pointermove', handleRect.left + 44, handleRect.top + 24)
fire(window, 'pointerup', handleRect.left + 44, handleRect.top + 24)
await sleep(200)
const afterResize = t.annotState.items[0].bbox
check('缩放改变了尺寸', afterResize.w > beforeResize.w + 5 && afterResize.h > beforeResize.h + 5, {
  before: beforeResize,
  after: afterResize
})

// 6) Escape 退出工具 + 撤销恢复
t.ui.tool = 'rect'
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await sleep(100)
check('Escape 回到选择工具', t.ui.tool === 'select', t.ui.tool)
t.undo()
await sleep(150)
check('撤销缩放', Math.abs(t.annotState.items[0].bbox.w - beforeResize.w) < 0.01, t.annotState.items[0].bbox)

// 7) 测量注释标签
t.addAnnotation(
  t.withIdentity({
    kind: 'measure',
    page: 0,
    bbox: { x: 100, y: 300, w: 72, h: 0 },
    color: '#1971c2',
    opacity: 1,
    thickness: 1.5,
    from: { x: 100, y: 300 },
    to: { x: 172, y: 300 },
    unit: 'mm'
  })
)
await sleep(250)
const labels = [...wrap.querySelectorAll('.ann-layer text.measure-label')].map((el) => el.textContent.trim())
check('测量标签渲染', labels.some((l) => l === '25.4 mm'), labels)

return { labels, finalColor: t.annotState.items[0].color }
