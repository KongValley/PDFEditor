// 步骤 28 冒烟:补齐此前从未被自动化走到的用户可见功能 —— 注释层级三键、搜索失效、
// 前进历史、走原生对话框的「提取页面」与「另存为」(依赖 PDF_EDITOR_SMOKE_DIALOG_DIR 替身)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
const page0Ids = () => t.annotState.items.filter((a) => a.page === 0).map((a) => a.id)
const toastText = () => t.ui.toast?.text ?? ''

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1600)

/* ---------- 1. 层级:置底 / 下移 / 边界钳制 ---------- */
const [A, B, C] = ['rect', 'rect', 'rect'].map((kind, i) =>
  t.withIdentity({ kind, page: 0, bbox: { x: 60 + i * 30, y: 700, w: 80, h: 40 }, color: '#e03131', opacity: 1, thickness: 2 })
)
for (const ann of [A, B, C]) t.addAnnotation(ann)
check('三条批注按添加顺序', JSON.stringify(page0Ids()) === JSON.stringify([A.id, B.id, C.id]), page0Ids())

t.sendToBack(A.id)
check('置底后 A 排首位', page0Ids()[0] === A.id, { order: page0Ids(), a: A.id, b: B.id, c: C.id })

t.moveUp(A.id)
check('上移一位后 A 排第二', page0Ids()[1] === A.id, page0Ids())

t.moveDown(A.id)
check('下移一位后 A 回到首位', page0Ids()[0] === A.id, page0Ids())

t.sendToBack(C.id)
const afterBack = page0Ids()
t.moveDown(C.id)
check('已在最底层的再下移不越界', page0Ids()[0] === C.id, page0Ids())
t.bringToFront(C.id)
check('置顶后 C 回到末位', page0Ids()[page0Ids().length - 1] === C.id, afterBack)

/* ---------- 2. 搜索失效:页面操作后结果清空 ---------- */
// 走真实搜索栏(输入 + Enter),只有 UI 路径才会写 searchState.results
t.ui.searchOpen = true
await sleep(300)
const input = document.querySelector('.search-bar .search-input')
check('搜索栏已打开', !!input)
input.value = '编辑器'
input.dispatchEvent(new Event('input', { bubbles: true }))
await sleep(1500)
check('搜索有命中', t.searchState.results.length > 0, t.searchState.results.length)
await t.insertBlankPage(0)
await sleep(1200)
check('页面操作后搜索结果被清空', t.searchState.results.length === 0, t.searchState.results.length)
t.ui.searchOpen = false
await sleep(200)

/* ---------- 3. 前进历史(直接调用 goForward,step19 只从快捷键走) ---------- */
t.scrollToPage(3)
await sleep(1200) // 等 700ms 去抖把页码记进历史
check('已定位到第 3 页', t.docState.currentPage === 3, t.docState.currentPage)
check('可后退', t.readingState.canBack === true, t.readingState)
t.goBack()
await sleep(400)
check('后退到第 1 页', t.docState.currentPage === 1, t.docState.currentPage)
check('可前进', t.readingState.canForward === true, t.readingState)
t.goForward()
await sleep(1200)
check('前进回到第 3 页', t.docState.currentPage === 3, t.docState.currentPage)

/* ---------- 4. 提取页面(走原生对话框替身) ---------- */
await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
await t.extractPages([0, 1])
await sleep(1500)
const extractToast = toastText()
check('提取成功提示', extractToast.startsWith('已提取 2 页'), extractToast)
const extractedPath = extractToast.slice('已提取 2 页:'.length).trim()
check('提取产物落在替身目录', extractedPath.includes('dialog'), extractedPath)
await t.openPath(extractedPath)
await sleep(1500)
check('导出文件只有 2 页', t.docState.pageCount === 2, t.docState.pageCount)

/* ---------- 5. 另存为(走原生对话框替身) ---------- */
await t.saveDocumentAs()
await sleep(1500)
check('另存为成功提示', toastText().startsWith('已保存'), toastText())
check('另存为落在替身目录', t.docState.filePath.includes('dialog'), t.docState.filePath)

return {
  zorder: 'ok',
  searchInvalidate: 'ok',
  forwardHistory: 'ok',
  extract: 'ok',
  saveAs: 'ok'
}