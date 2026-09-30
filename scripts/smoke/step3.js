// 步骤 3 冒烟:注释创建(交互 + 程序化)、撤销重做、渲染、属性面板
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

function fire(target, type, x, y) {
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }))
}

await t.openPath('F:/DeepSeek工作区/pdf编辑器/samples/sample-zh.pdf')
await sleep(1500)

const wrap = document.querySelector('[data-page="1"]')
const svg = wrap.querySelector('.ann-layer')
check('annotation layer mounted', !!svg, null)
const box = svg.getBoundingClientRect()

// 1) 交互绘制矩形
t.ui.tool = 'rect'
fire(svg, 'pointerdown', box.left + 80, box.top + 120)
fire(window, 'pointermove', box.left + 280, box.top + 220)
fire(window, 'pointerup', box.left + 280, box.top + 220)
await sleep(120)
check('rect created by drag', t.annotState.items.length === 1 && t.annotState.items[0].kind === 'rect', t.annotState.items.length)
check('tool reset to select', t.ui.tool === 'select', t.ui.tool)

// 2) 文本划选 → 高亮
const span = document.querySelector('.textLayer span')
const range = document.createRange()
range.selectNodeContents(span)
const selection = window.getSelection()
selection.removeAllRanges()
selection.addRange(range)
t.ui.tool = 'highlight'
fire(wrap, 'pointerdown', box.left + 100, box.top + 200)
fire(wrap, 'pointerup', box.left + 110, box.top + 205)
await sleep(150)
check('highlight from text selection', t.annotState.items.some((a) => a.kind === 'highlight'), t.annotState.items.map((a) => a.kind))

// 3) 程序化补齐其余类型
const style = t.toolDefaults
t.addAnnotation(
  t.withIdentity({
    kind: 'ink',
    page: 0,
    bbox: { x: 100, y: 500, w: 100, h: 60 },
    color: '#e03131',
    opacity: 1,
    thickness: 2,
    points: [
      { x: 100, y: 500 },
      { x: 150, y: 550 },
      { x: 200, y: 510 }
    ]
  })
)
t.addAnnotation(
  t.withIdentity({
    kind: 'arrow',
    page: 0,
    bbox: { x: 300, y: 500, w: 120, h: 80 },
    color: '#1971c2',
    opacity: 1,
    thickness: 2,
    from: { x: 300, y: 500 },
    to: { x: 420, y: 580 }
  })
)
t.addAnnotation(
  t.withIdentity({
    kind: 'text',
    page: 0,
    bbox: { x: 100, y: 380, w: 220, h: 40 },
    color: '#212529',
    opacity: 1,
    text: '你好世界 Hello',
    fontSize: 16,
    rotate: 0
  })
)
t.addAnnotation(
  t.withIdentity({
    kind: 'stamp',
    page: 0,
    bbox: { x: 320, y: 300, w: 140, h: 44 },
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
    kind: 'note',
    page: 0,
    bbox: { x: 480, y: 700, w: 26, h: 26 },
    color: '#f7c948',
    opacity: 1,
    text: '这是一条便签内容'
  })
)
await sleep(300)

const kinds = t.annotState.items.map((a) => a.kind)
check('all kinds added', kinds.length === 7, kinds)

// 4) 渲染检查
const shapes = wrap.querySelectorAll('.ann-layer > g.shape').length
check('shapes rendered', shapes === 7, shapes)
const textNodes = wrap.querySelectorAll('.ann-layer text.text-ann').length
check('text annotation rendered', textNodes >= 1, textNodes)
const stampNodes = wrap.querySelectorAll('.ann-layer text.stamp-label').length
check('stamp rendered', stampNodes === 1, stampNodes)

// 5) 选中 + 属性面板
t.ui.tool = 'select'
t.ui.selectedAnnotationId = t.annotState.items.find((a) => a.kind === 'rect').id
await sleep(150)
check('props panel visible', !!document.querySelector('.props'), null)
check('selection handles', wrap.querySelectorAll('.ann-layer .handle').length === 8, wrap.querySelectorAll('.ann-layer .handle').length)

// 6) 撤销/重做
const before = t.annotState.items.length
t.undo()
await sleep(60)
check('undo removes one', t.annotState.items.length === before - 1, t.annotState.items.length)
t.redo()
await sleep(60)
check('redo restores', t.annotState.items.length === before, t.annotState.items.length)

// 7) 快捷键删除选中
t.ui.selectedAnnotationId = t.annotState.items[t.annotState.items.length - 1].id
const beforeDelete = t.annotState.items.length
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
await sleep(80)
check('delete key removes selection', t.annotState.items.length === beforeDelete - 1, t.annotState.items.length)

// 8) Ctrl+Z 恢复
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
await sleep(80)
check('ctrl+z restores', t.annotState.items.length === beforeDelete, t.annotState.items.length)

t.ui.selectedAnnotationId = null
await sleep(200)

return {
  kinds,
  shapes,
  textNodes,
  stampNodes,
  total: t.annotState.items.length
}
