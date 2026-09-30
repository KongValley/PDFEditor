// 步骤 7 冒烟:大纲解析、面板渲染与跳转
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

const root = 'F:/DeepSeek工作区/pdf编辑器'
await t.openPath(`${root}/samples/sample-outline.pdf`)
await sleep(1500)

const outline = t.docState.outline
check('大纲解析出 2 个顶层条目', outline.length === 2, outline.map((n) => n.title))
check('顶层标题正确', outline[0].title.includes('第 1 章'), outline[0].title)
check('嵌套子项解析', outline[0].children.length === 1 && outline[0].children[0].title.includes('1.1'), outline[0].children)
check('目标页码解析', outline[0].page === 0 && outline[1].page === 2, outline.map((n) => n.page))

// 面板渲染
t.ui.sideTab = 'outline'
await sleep(300)
const rows = document.querySelectorAll('.outline .node-row')
check('大纲面板渲染 3 行', rows.length === 3, rows.length)

// 点击第 2 章 → 跳转到第 3 页
const titles = [...document.querySelectorAll('.outline .title')]
const chapter2 = titles.find((el) => el.textContent.includes('第 2 章'))
check('找到第 2 章条目', !!chapter2, null)
chapter2.dispatchEvent(new MouseEvent('click', { bubbles: true }))
await sleep(600)
check('跳转到第 3 页', t.docState.currentPage === 3, t.docState.currentPage)

// 点击子项 1.1 → 跳转到第 2 页
const sub = [...document.querySelectorAll('.outline .title')].find((el) => el.textContent.includes('1.1'))
sub.dispatchEvent(new MouseEvent('click', { bubbles: true }))
await sleep(600)
check('跳转到第 2 页', t.docState.currentPage === 2, t.docState.currentPage)

// 折叠
const toggle = document.querySelector('.outline .toggle')
toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
await sleep(300)
check('折叠后隐藏子项', document.querySelectorAll('.outline .node-row').length === 2, document.querySelectorAll('.outline .node-row').length)

t.ui.sideTab = 'annotations'
return { titles: outline.map((n) => n.title), pages: outline.map((n) => n.page) }
