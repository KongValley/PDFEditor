// 步骤 22 冒烟:页面旋转入口(快捷键 / 状态栏按钮 / 右键菜单)+ 常用操作快捷键
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
const box = (n) => t.docState.pageBoxes[n - 1]
const key = (opts) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts }))
const btn = (title) => document.querySelector(`.status-bar button[title="${title}"]`)
const menuItems = () => [...document.querySelectorAll('.page-menu button')].map((b) => b.textContent.trim())

// 删除页与右键菜单「删除该页」走 window.confirm,冒烟里直接放行
window.confirm = () => true

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1600)
check('3 页文档已打开', t.docState.pageCount === 3, t.docState.pageCount)

/* ---------- 1. 快捷键 [ / ] 旋转当前页 ---------- */
t.scrollToPage(1)
await sleep(300)
const before1 = { ...box(1) }
const before2 = { ...box(2) }
check('第 1 页初始为纵向', before1.w < before1.h, before1)

key({ key: ']', code: 'BracketRight' })
await sleep(1200)
check('] 旋转当前页后尺寸互换', box(1).w === before1.h && box(1).h === before1.w, { before: before1, after: box(1) })
check('] 不改变页数', t.docState.pageCount === 3, t.docState.pageCount)
check('] 不影响其它页', box(2).w === before2.w && box(2).h === before2.h, box(2))

key({ key: '[', code: 'BracketLeft' })
await sleep(1200)
check('[ 复原第 1 页尺寸', box(1).w === before1.w && box(1).h === before1.h, box(1))

/* ---------- 2. 状态栏旋转按钮 ---------- */
const leftBtn = btn('左旋当前页 ([)')
const rightBtn = btn('右旋当前页 (])')
check('状态栏存在左旋按钮', !!leftBtn)
check('状态栏存在右旋按钮', !!rightBtn)
rightBtn.click()
await sleep(1200)
check('状态栏右旋按钮生效', box(1).w === before1.h && box(1).h === before1.w, box(1))
leftBtn.click()
await sleep(1200)
check('状态栏左旋按钮复原', box(1).w === before1.w && box(1).h === before1.h, box(1))

/* ---------- 3. 主视图右键菜单 ---------- */
const page2 = document.querySelector('[data-page="2"]')
check('第 2 页存在', !!page2)
page2.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }))
await sleep(200)
check('右键弹出页面菜单', !!document.querySelector('.page-menu'))
check('菜单记录页号为 2', t.ui.pageMenu.page === 2, t.ui.pageMenu.page)
const items = menuItems()
check('菜单含 6 项', items.length === 6, items)
check('菜单含「提取该页为新 PDF」', items.some((x) => x.includes('提取该页为新 PDF')), items)
check('菜单含「导出该页为 PNG」', items.some((x) => x.includes('导出该页为 PNG')), items)

// 点击「左旋 90°」:第 2 页尺寸互换、第 1 页不变
const beforeP2 = { ...box(2) }
const beforeP1 = { ...box(1) }
document.querySelectorAll('.page-menu button')[0].click()
await sleep(1400)
check('菜单左旋生效(第 2 页)', box(2).w === beforeP2.h && box(2).h === beforeP2.w, { before: beforeP2, after: box(2) })
check('菜单左旋不影响第 1 页', box(1).w === beforeP1.w && box(1).h === beforeP1.h, box(1))
check('点击菜单项后菜单关闭', !document.querySelector('.page-menu'))

/* ---------- 4. 缩略图右键菜单 ---------- */
const thumb3 = document.querySelector('[data-thumb="3"]')
check('缩略图 3 存在', !!thumb3)
thumb3.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 400 }))
await sleep(200)
check('缩略图右键弹出菜单', !!document.querySelector('.page-menu'))
check('缩略图菜单记录页号为 3', t.ui.pageMenu.page === 3, t.ui.pageMenu.page)
// 关闭:点击菜单外部(真实点击在元素上派发,再冒泡/捕获到 window)
document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
await sleep(200)
check('点击外部关闭菜单', !document.querySelector('.page-menu'))

/* ---------- 5. 阅读视图快捷键 Ctrl+1/2/3 ---------- */
key({ key: '2', ctrlKey: true })
await sleep(500)
check('Ctrl+2 → 单页', t.docState.viewMode === 'single', t.docState.viewMode)
key({ key: '3', ctrlKey: true })
await sleep(500)
check('Ctrl+3 → 双页', t.docState.viewMode === 'two', t.docState.viewMode)
key({ key: '1', ctrlKey: true })
await sleep(500)
check('Ctrl+1 → 连续', t.docState.viewMode === 'continuous', t.docState.viewMode)

/* ---------- 6. 面板显隐 Ctrl+B / Ctrl+Shift+B ---------- */
check('缩略图栏初始可见', !!document.querySelector('.thumbs'))
check('右侧面板初始可见', !!document.querySelector('.right-panel'))
key({ key: 'b', ctrlKey: true })
await sleep(400)
check('Ctrl+B 隐藏缩略图栏', !document.querySelector('.thumbs'))
check('隐藏缩略图栏不影响右侧面板', !!document.querySelector('.right-panel'))
key({ key: 'b', ctrlKey: true })
await sleep(600)
check('Ctrl+B 再次显示缩略图栏', !!document.querySelector('.thumbs'))
key({ key: 'b', ctrlKey: true, shiftKey: true })
await sleep(400)
check('Ctrl+Shift+B 隐藏右侧面板', !document.querySelector('.right-panel'))
check('隐藏右侧面板不影响缩略图栏', !!document.querySelector('.thumbs'))
key({ key: 'b', ctrlKey: true, shiftKey: true })
await sleep(400)
check('Ctrl+Shift+B 再次显示右侧面板', !!document.querySelector('.right-panel'))

/* ---------- 7. 页面操作快捷键 ---------- */
const pagesBefore = t.docState.pageCount
key({ key: 'n', ctrlKey: true, shiftKey: true })
await sleep(1400)
check('Ctrl+Shift+N 插入空白页(页数 +1)', t.docState.pageCount === pagesBefore + 1, {
  before: pagesBefore,
  after: t.docState.pageCount
})
key({ key: 'Delete', ctrlKey: true, shiftKey: true })
await sleep(1400)
check('Ctrl+Shift+Delete 删除当前页(页数 −1)', t.docState.pageCount === pagesBefore, t.docState.pageCount)

/* ---------- 8. 输入框守卫:搜索框内按 [ 不触发旋转 ---------- */
key({ key: 'f', ctrlKey: true })
await sleep(400)
const searchInput = document.querySelector('.search-input')
check('搜索框已打开', !!searchInput)
const sizeBefore = { ...box(1) }
searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: '[', code: 'BracketLeft', bubbles: true }))
await sleep(600)
check('输入框内 [ 不触发旋转', box(1).w === sizeBefore.w && box(1).h === sizeBefore.h, box(1))
key({ key: 'Escape' })
await sleep(200)

/* ---------- 9. 页面重排后表单字段页号必须跟着迁移 ---------- */
// 单页文档调 movePage 会被判"目标位置与当前位置相同",先把表单样例并进来凑出多页
await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1600)
await t.mergePdfs([{ path: `${__smokeRoot}/samples/sample-form.pdf` }])
await sleep(2000)
check('合并后为 4 页', t.docState.pageCount === 4, t.docState.pageCount)
check('合并后表单字段在第 4 页', t.docState.formFields.length > 0, t.docState.formFields.length)
check(
  '合并后表单字段页号为 3',
  t.docState.formFields.every((f) => f.page === 3),
  t.docState.formFields.map((f) => f.page)
)
await t.movePage(3, 0) // 增量 pageMap 分支:不重建 pdf.js 文档
await sleep(2000)
check(
  '页面移动后表单字段页号跟随迁移',
  t.docState.formFields.every((f) => f.page === 0),
  t.docState.formFields.map((f) => f.page)
)

return {
  rotate: 'ok',
  statusButtons: 'ok',
  contextMenu: 'ok',
  viewModes: 'ok',
  panels: 'ok',
  pageOps: 'ok',
  typingGuard: 'ok',
  formFieldRemap: 'ok'
}
