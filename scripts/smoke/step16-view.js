// 步骤 16 冒烟:阅读视图(连续/单页/双页)、实际大小、适合页面/宽度、单页滚轮翻页
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
const btn = (title) => {
  const el = document.querySelector(`.status-bar button[title="${title}"]`)
  check(`状态栏按钮存在:${title}`, !!el)
  return el
}
const viewerEl = () => document.querySelector('.viewer')
const shownPages = () => [...document.querySelectorAll('.page-wrap')].filter((el) => el.style.display !== 'none')
const pageRect = (n) => document.querySelector(`[data-page="${n}"]`).getBoundingClientRect()
const rowRect = () => document.querySelector('.spread-row').getBoundingClientRect()
const wheel = (el, deltaY) => el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1600)
check('默认连续模式', t.docState.viewMode === 'continuous', t.docState.viewMode)
check('连续模式 3 页在 DOM', document.querySelectorAll('.page-wrap').length === 3)
check('连续模式无行容器', document.querySelectorAll('.spread-row').length === 0)

/* ---------- 1. 实际大小 ---------- */
btn('实际大小 (1:1)').click()
await sleep(400)
check('实际大小 = 100%', Math.abs(t.docState.scale - 1) < 1e-6, t.docState.scale)

/* ---------- 2. 双页阅览布局 ---------- */
btn('双页阅览').click()
await sleep(500)
check('切到双页', t.docState.viewMode === 'two', t.docState.viewMode)
check('双页按钮高亮', btn('双页阅览').classList.contains('active'))
const rows = document.querySelectorAll('.spread-row')
check('3 页 = 2 行(1-2 / 3)', rows.length === 2, rows.length)
const r1 = pageRect(1)
const r2 = pageRect(2)
const r3 = pageRect(3)
check('1、2 页同行', Math.abs(r1.top - r2.top) < 1, [r1.top, r2.top])
check('1 在 2 左侧且留 16px 间距', r2.left >= r1.right + 15, [r1.right, r2.left])
check('3 页在下一行', r3.top > r1.top + 100, [r1.top, r3.top])

/* ---------- 3. 双页下的适合宽度 / 适合页面 ---------- */
btn('适合宽度 (Ctrl+0)').click()
await sleep(400)
check('双页适合宽度:整行不超出视口', rowRect().width <= viewerEl().clientWidth - 48 + 1, [rowRect().width, viewerEl().clientWidth])
btn('适合页面').click()
await sleep(400)
check('双页适合页面:行高不超出视口', rowRect().height <= viewerEl().clientHeight - 48 + 1, [rowRect().height, viewerEl().clientHeight])
check('双页适合页面:行宽也不超出视口', rowRect().width <= viewerEl().clientWidth - 48 + 1, [rowRect().width, viewerEl().clientWidth])

/* ---------- 4. 双页按整行步进 ---------- */
t.scrollToPage(1)
await sleep(300)
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
await sleep(300)
check('双页右箭头步进整行 → 第 3 页', t.docState.currentPage === 3, t.docState.currentPage)

/* ---------- 5. 单页阅览 ---------- */
btn('单页阅览').click()
await sleep(500)
check('切到单页', t.docState.viewMode === 'single', t.docState.viewMode)
check('单页仅 1 页可见', shownPages().length === 1, shownPages().length)
check(
  '单页显示当前页',
  shownPages()[0].dataset.page === String(t.docState.currentPage),
  [shownPages()[0].dataset.page, t.docState.currentPage]
)
const singleRect = shownPages()[0].getBoundingClientRect()
const viewerRect = viewerEl().getBoundingClientRect()
check(
  '单页水平居中',
  Math.abs(singleRect.left - viewerRect.left - (viewerRect.right - singleRect.right)) < 2,
  [singleRect.left - viewerRect.left, viewerRect.right - singleRect.right]
)

/* ---------- 6. 单页滚轮翻页 ---------- */
const el = viewerEl()
t.scrollToPage(1)
await sleep(400)
wheel(el, 120)
await sleep(300)
check('页面装得下:滚轮下翻到第 2 页', t.docState.currentPage === 2, t.docState.currentPage)
check('翻页后回到页首', el.scrollTop === 0, el.scrollTop)
wheel(el, -120)
await sleep(300)
check('滚轮上翻回第 1 页', t.docState.currentPage === 1, t.docState.currentPage)

btn('实际大小 (1:1)').click()
await sleep(400)
el.scrollTop = 0
wheel(el, 120)
await sleep(300)
check('页高于视口:未到页底不翻页', t.docState.currentPage === 1, t.docState.currentPage)
el.scrollTop = el.scrollHeight
wheel(el, 120)
await sleep(300)
check('滚到页底后翻页', t.docState.currentPage === 2, t.docState.currentPage)

/* ---------- 7. 回到连续阅读 ---------- */
btn('连续阅读').click()
await sleep(500)
check('切回连续', t.docState.viewMode === 'continuous', t.docState.viewMode)
const page2Top = pageRect(2).top - viewerEl().getBoundingClientRect().top
check('连续:当前页贴视口顶部', Math.abs(page2Top - 24) < 30, page2Top)

/* ---------- 8. 模式跨文档保留 ---------- */
btn('单页阅览').click()
await sleep(400)
await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1600)
check('重开文档保留单页模式', t.docState.viewMode === 'single', t.docState.viewMode)
check('重开后仅 1 页可见', shownPages().length === 1, shownPages().length)

/* ---------- 9. 缩放输入框与常用比例菜单 ---------- */
const zoomInput = () => document.querySelector('.status-bar .zoom-input')
check('缩放输入框存在', !!zoomInput())
check('输入框显示当前比例', zoomInput().value === `${Math.round(t.docState.scale * 100)}%`, zoomInput().value)

zoomInput().value = '150'
zoomInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
await sleep(300)
check('输入 150 回车 → 150%', Math.abs(t.docState.scale - 1.5) < 1e-6, t.docState.scale)
check('输入框回显 150%', zoomInput().value === '150%', zoomInput().value)

zoomInput().value = '999'
zoomInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
await sleep(300)
check('999 被限制在 400%', Math.abs(t.docState.scale - 4) < 1e-6, t.docState.scale)
check('回显 400%', zoomInput().value === '400%', zoomInput().value)

zoomInput().value = 'abc'
zoomInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
await sleep(300)
check('非法输入不改动缩放', Math.abs(t.docState.scale - 4) < 1e-6, t.docState.scale)
check('非法输入回显当前值', zoomInput().value === '400%', zoomInput().value)

zoomInput().focus()
zoomInput().value = '125'
zoomInput().blur()
await sleep(300)
check('失焦提交 125%', Math.abs(t.docState.scale - 1.25) < 1e-6, t.docState.scale)

document.querySelector('.status-bar .zoom-menu-btn').click()
await sleep(200)
check('菜单打开', !!document.querySelector('.zoom-menu'))
const zoomItems = [...document.querySelectorAll('.zoom-menu button')]
check('菜单含 8 个常用比例', zoomItems.length === 8, zoomItems.length)
check('当前比例高亮', !!zoomItems.find((el) => el.classList.contains('active') && el.textContent.trim() === '125%'))
zoomItems.find((el) => el.textContent.trim() === '50%').click()
await sleep(300)
check('点选 50% 生效', Math.abs(t.docState.scale - 0.5) < 1e-6, t.docState.scale)
check('点选后菜单关闭', !document.querySelector('.zoom-menu'))
check('输入框同步 50%', zoomInput().value === '50%', zoomInput().value)

document.querySelector('.status-bar .zoom-menu-btn').click()
await sleep(200)
document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
await sleep(200)
check('点击外部关闭菜单', !document.querySelector('.zoom-menu'))

document.querySelector('.status-bar button[title="放大 (Ctrl+=)"]').click()
await sleep(200)
check('放大按钮后输入框同步', zoomInput().value === `${Math.round(t.docState.scale * 100)}%`, zoomInput().value)

return {
  actualSize: 'ok',
  twoPageLayout: 'ok',
  twoPageFit: 'ok',
  spreadStep: 'ok',
  singlePage: 'ok',
  wheelFlip: 'ok',
  backToContinuous: 'ok',
  modePersistence: 'ok',
  zoomInput: 'ok',
  zoomMenu: 'ok'
}
