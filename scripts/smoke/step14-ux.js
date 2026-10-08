// 步骤 14 冒烟:保存直存/脏标记、页面操作撤销重做、移动页、剪贴板/多选/层级/锁定、搜索打磨、翻页键、侧栏同步、setTool
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

window.confirm = () => true
const stamp = Date.now()

async function makeCopy(sourceFile, pages, dirName) {
  const res = await window.pdfAPI.invoke('pdf:splitTasks', {
    tasks: [{ mode: 'ranges', path: `${__smokeRoot}/samples/${sourceFile}`, ranges: [pages] }],
    outputDir: `${__smokeRoot}/tmp/${dirName}`
  })
  check(`${sourceFile} 副本生成`, res[0].ok === true, res[0])
  return res[0].outputs[0]
}

/* ---------- 1. 保存直存 + 脏标记 ---------- */

const copyA = await makeCopy('sample-zh.pdf', [0, 1, 2], `ux-copy-${stamp}`)
await t.openPath(copyA)
await sleep(1400)
check('打开后未标记脏', t.docState.dirty === false, t.docState.dirty)

t.addAnnotation(
  t.withIdentity({
    kind: 'highlight',
    page: 0,
    bbox: { x: 50, y: 50, w: 100, h: 20 },
    color: '#ffe066',
    opacity: 0.4
  })
)
await sleep(200)
check('注释后标记脏', t.docState.dirty === true, t.docState.dirty)
check('状态栏显示未保存', !!document.querySelector('.status-dirty'))

await t.saveDocument()
await sleep(700)
check('保存后清脏', t.docState.dirty === false, t.docState.dirty)
check('保存后状态栏清除', !document.querySelector('.status-dirty'))
check('路径未变(直存)', (t.docState.filePath ?? '').endsWith(copyA.split(/[\\/]/).pop() ?? ''), t.docState.filePath)

await t.openPath(copyA)
await sleep(1500)
check('重开副本注释 1 条', t.annotState.items.length === 1, t.annotState.items.length)

/* ---------- 2. 页面操作撤销/重做 ---------- */

const copyB = await makeCopy('sample-zh.pdf', [0, 1, 2], `ux-copy2-${stamp}`)
await t.openPath(copyB)
await sleep(1400)
check('副本 3 页', t.docState.pageCount === 3, t.docState.pageCount)

await t.deletePages([0])
await sleep(1000)
check('删除后 2 页', t.docState.pageCount === 2, t.docState.pageCount)

await t.undo()
await sleep(1600)
check('撤销页面删除 → 3 页', t.docState.pageCount === 3, t.docState.pageCount)

await t.redo()
await sleep(1600)
check('重做页面删除 → 2 页', t.docState.pageCount === 2, t.docState.pageCount)

await t.undo()
await sleep(1600)
check('再次撤销 → 3 页', t.docState.pageCount === 3, t.docState.pageCount)

/* ---------- 3. 移动页 + 撤销 ---------- */

const rotCopy = await makeCopy('sample-rotated.pdf', [0, 1], `ux-rot-${stamp}`)
await t.openPath(rotCopy)
await sleep(1400)
check('初始第 2 页为旋转页', Math.round(t.docState.pageBoxes[1].w) === 842, t.docState.pageBoxes[1])

await t.movePage(1, 0)
await sleep(1400)
check('移动后第 1 页为旋转页', Math.round(t.docState.pageBoxes[0].w) === 842, t.docState.pageBoxes[0])

await t.undo()
await sleep(1600)
check('撤销移动恢复顺序', Math.round(t.docState.pageBoxes[0].w) === 595, t.docState.pageBoxes[0])

/* ---------- 4. 剪贴板/多选/层级/锁定 ---------- */

t.docState.currentPage = 1
const rectA = t.withIdentity({
  kind: 'rect',
  page: 0,
  bbox: { x: 100, y: 100, w: 80, h: 40 },
  color: '#e03131',
  opacity: 1,
  thickness: 1.5
})
const rectB = t.withIdentity({
  kind: 'rect',
  page: 0,
  bbox: { x: 220, y: 100, w: 80, h: 40 },
  color: '#e03131',
  opacity: 1,
  thickness: 1.5
})
t.addAnnotation(rectA)
t.addAnnotation(rectB)
await sleep(150)
check('两个矩形', t.annotState.items.length === 2, t.annotState.items.length)

t.ui.selectedAnnotationIds = [rectA.id]
check('复制返回 1', t.copySelection() === 1)
check('粘贴返回 1', t.pasteClipboard() === 1)
await sleep(150)
check('粘贴后 3 条', t.annotState.items.length === 3, t.annotState.items.length)
const pasted = t.annotState.items[t.annotState.items.length - 1]
check('粘贴为新 id', pasted.id !== rectA.id)
check('粘贴偏移 +12', Math.abs(pasted.bbox.y - rectA.bbox.y - 12) < 0.01, [rectA.bbox.y, pasted.bbox.y])

t.docState.currentPage = 2
t.ui.selectedAnnotationIds = [rectA.id]
t.copySelection()
t.pasteClipboard()
await sleep(150)
check('跨页粘贴到第 2 页', t.annotState.items[t.annotState.items.length - 1].page === 1, t.annotState.items[t.annotState.items.length - 1].page)
await t.undo()
await sleep(200)
t.docState.currentPage = 1
await t.undo()
await sleep(200)
check('撤销两次回到 2 条', t.annotState.items.length === 2, t.annotState.items.length)

t.ui.selectedAnnotationIds = [rectA.id]
t.duplicateSelection()
await sleep(150)
check('再制后 3 条', t.annotState.items.length === 3, t.annotState.items.length)
await t.undo()
await sleep(200)
check('撤销再制 2 条', t.annotState.items.length === 2, t.annotState.items.length)

t.bringToFront(rectA.id)
await sleep(100)
check('置顶后 A 在末位', t.annotState.items[t.annotState.items.length - 1].id === rectA.id)
await t.undo()
await sleep(200)
check('撤销置顶恢复层序', t.annotState.items[0].id === rectA.id && t.annotState.items[1].id === rectB.id)

t.ui.selectedAnnotationIds = [rectA.id, rectB.id]
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
await sleep(200)
check('批量删除清空', t.annotState.items.length === 0, t.annotState.items.length)
await t.undo()
await sleep(250)
check(
  '撤销批量删除恢复原序',
  t.annotState.items.length === 2 && t.annotState.items[0].id === rectA.id && t.annotState.items[1].id === rectB.id,
  t.annotState.items.map((a) => a.id)
)

t.updateAnnotation(rectA.id, { locked: true })
await sleep(100)
check('锁定字段生效', t.annotState.items[0].locked === true)

/* ---------- 5. 搜索打磨 ---------- */

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
const search = await t.search('第', 2)
check('截断标记', search.truncated === true, search)
check('限制返回 2 条', search.matches.length === 2, search.matches.length)

t.searchState.results = search.matches
t.searchState.current = 0
t.searchState.truncated = true
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true }))
await sleep(500)
check('F3 下一条', t.searchState.current === 1, t.searchState.current)
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', shiftKey: true, bubbles: true }))
await sleep(500)
check('Shift+F3 上一条', t.searchState.current === 0, t.searchState.current)

/* ---------- 6. 翻页键 ---------- */

window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
await sleep(300)
check('右箭头下一页', t.docState.currentPage === 2, t.docState.currentPage)
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
await sleep(300)
check('Home 首页', t.docState.currentPage === 1, t.docState.currentPage)
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
await sleep(300)
check('End 末页', t.docState.currentPage === 3, t.docState.currentPage)

/* ---------- 7. 侧栏同步滚动(50 页大文档在 tmp/,由 npm run samples 生成) ---------- */

await t.openPath(`${__smokeRoot}/tmp/50pages.pdf`)
await sleep(2200)
check('大文档已打开', t.docState.pageCount === 50, t.docState.pageCount)
t.scrollToPage(40)
await sleep(800)
const scroller = document.querySelector('.thumbs-scroll')
check('侧栏跟随滚动', !!scroller && scroller.scrollTop > 200, scroller ? Math.round(scroller.scrollTop) : null)

/* ---------- 8. 工具栏切工具清空选中 ---------- */

t.docState.currentPage = 1
const rectC = t.withIdentity({
  kind: 'rect',
  page: 0,
  bbox: { x: 60, y: 60, w: 60, h: 30 },
  color: '#e03131',
  opacity: 1,
  thickness: 1.5
})
t.addAnnotation(rectC)
t.ui.selectedAnnotationIds = [rectC.id]
await sleep(150)
const toolButtons = [...document.querySelectorAll('.toolbar button')]
const rectButton = toolButtons.find((el) => el.textContent.trim() === '矩形')
check('找到矩形工具按钮', !!rectButton)
rectButton.click()
await sleep(200)
check('切工具清空选中', t.ui.selectedAnnotationIds.length === 0, t.ui.selectedAnnotationIds)

/* ---------- 拖拽排序:反馈 + 自动滚动 ---------- */
// 用 50 页文档:3 页夹具的缩略图列表不溢出,无法验证自动滚动
await t.openPath(`${__smokeRoot}/tmp/50pages.pdf`)
await sleep(2200)

const thumbEl = (n) => document.querySelector(`[data-thumb="${n}"]`)
check('缩略图可拖拽', thumbEl(1)?.getAttribute('draggable') === 'true', thumbEl(1)?.getAttribute('draggable'))

// dataTransfer 必须是真实 DataTransfer(传普通对象会抛 TypeError);Chromium 108 支持 new DataTransfer()
const drag = (type, el, clientY) => {
  el.dispatchEvent(
    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientY })
  )
}
const r2 = thumbEl(2).getBoundingClientRect()
drag('dragstart', thumbEl(1), r2.top)
await sleep(150) // 等 Vue 刷新 DOM(类名更新在 nextTick)
drag('dragover', thumbEl(2), r2.bottom - 2) // 下半区
await sleep(150)
check('dragover 出现落点提示', thumbEl(2).classList.contains('drop-after'), thumbEl(2).className)
check('拖动源项变淡', thumbEl(1).classList.contains('dragging'), thumbEl(1).className)
drag('drop', thumbEl(2), r2.bottom - 2)
await sleep(1800)
check('拖拽后页数不变', t.docState.pageCount === 50, t.docState.pageCount)
check(
  '拖拽后提示已清除',
  !document.querySelector('.thumb.drop-after') && !document.querySelector('.thumb.dragging')
)

// 边缘自动滚动:先滚到中部,再从列表上边缘拖
const thumbScroller = document.querySelector('.thumbs-scroll')
thumbScroller.scrollTop = Math.floor(thumbScroller.scrollHeight / 2)
await sleep(150)
const scrollBefore = thumbScroller.scrollTop
drag('dragstart', thumbEl(1), thumbScroller.getBoundingClientRect().top)
drag('dragover', thumbEl(1), thumbScroller.getBoundingClientRect().top + 4) // 进入上边缘带
await sleep(500) // 让 rAF 循环跑若干帧
drag('dragend', thumbEl(1), 0)
check(
  '拖到上边缘触发自动滚动',
  thumbScroller.scrollTop < scrollBefore,
  { before: scrollBefore, after: thumbScroller.scrollTop }
)

/* ---------- 页面操作后不闪:滚动位置与可见画布保持 ---------- */
t.scrollToPage(20)
await sleep(1400)
const viewer = document.querySelector('.viewer')
const topBefore = viewer.scrollTop
check('已滚动到中部', topBefore > 1000, topBefore)
const nonEmptyBefore = [...document.querySelectorAll('.page-canvas')].filter((c) => c.width > 0).length

await t.movePage(19, 21)
await sleep(1800)

const topAfter = viewer.scrollTop
check('页面操作后滚动位置未被甩回顶部', topAfter > 1000, { before: topBefore, after: topAfter })
check('页面操作后当前页未被重置为 1', t.docState.currentPage > 1, t.docState.currentPage)
check(
  '页面操作后可见页已重绘(非空白)',
  [...document.querySelectorAll('.page-canvas')].filter((c) => c.width > 0).length >= 1,
  { before: nonEmptyBefore }
)
check('滚动位置偏移 < 200px', Math.abs(topAfter - topBefore) < 200, { before: topBefore, after: topAfter })

/* ---------- 输入框守卫:注释正文里按 Ctrl+E 不应弹出导出对话框 ---------- */
await t.scrollToPage(1)
await sleep(800)
t.addAnnotation(
  t.withIdentity({ kind: 'text', page: 0, bbox: { x: 80, y: 500, w: 220, h: 40 }, color: '#212529', opacity: 1, text: '输入测试', fontSize: 14 })
)
await sleep(500)
const textShape = [...document.querySelectorAll('[data-page="1"] .ann-layer > g.shape')].pop()
check('文字注释已创建', !!textShape, document.querySelectorAll('[data-page="1"] .ann-layer > g.shape').length)
// 形状只在 select 工具下可接收双击(pointerEvents 绑定在工具上)
t.ui.tool = 'select'
await sleep(200)
textShape.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
await sleep(500)
const editor = document.querySelector('.ann-editor textarea')
check('画布编辑器已打开', !!editor)
editor.focus()
editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }))
await sleep(400)
check('输入框内 Ctrl+E 不弹对话框', !document.querySelector('.mask .dialog'))
check('输入框保持焦点', document.activeElement === editor, document.activeElement?.tagName)
editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await sleep(200)

return {
  saveInPlace: 'ok',
  pageUndo: 'ok',
  movePage: 'ok',
  clipboard: 'ok',
  zorder: 'ok',
  lock: 'ok',
  search: 'ok',
  keys: 'ok',
  syncScroll: 'ok',
  setTool: 'ok',
  dragFeedback: 'ok',
  noFlashOnPageOp: 'ok',
  typingGuardShortcuts: 'ok'
}
