// 步骤 12 冒烟:页码范围解析 + 提取(导出到固定路径)/ 分段拆分 / 删除
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ---------- 1. 解析器(纯函数) ---------- */

check('单页', eq(t.parsePageRange('2', 3), [1]))
check('区间+单点', eq(t.parsePageRange('1-2,3', 3), [0, 1, 2]))
check('越界拒绝', t.parsePageRange('5', 3) === null)
check('倒序拒绝', t.parsePageRange('2-1', 3) === null)
check('空串拒绝', t.parsePageRange('', 3) === null)
check('0 拒绝', t.parsePageRange('0', 3) === null)
check('乱文拒绝', t.parsePageRange('abc', 3) === null)
check('中文逗号', eq(t.parsePageRange('1，3', 5), [0, 2]))
check('空白分隔', eq(t.parsePageRange('1 3', 5), [0, 2]))
check('去重升序', eq(t.parsePageRange('3,1,2', 5), [0, 1, 2]))

/* ---------- 2. 连续段切分(纯函数) ---------- */

check('连续段合并', eq(t.splitPageSegments([0, 1, 2]), [[0, 1, 2]]))
check('断点分段', eq(t.splitPageSegments([0, 1, 5]), [[0, 1], [5]]))
check('单页成段', eq(t.splitPageSegments([0, 2, 4]), [[0], [2], [4]]))

/* ---------- 3. 提取:直接 pageops export 到固定路径(绕开保存对话框) ---------- */

window.confirm = () => true

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1200)
check('初始 3 页', t.docState.pageCount === 3, t.docState.pageCount)

// 提取全部 3 页到 tmp,无对话框直连 IPC(targetPath 参数)
await t.exportPages([0, 1, 2], `${__smokeRoot}/tmp/pages-extract.pdf`)
await sleep(400)
await t.openPath(`${__smokeRoot}/tmp/pages-extract.pdf`)
await sleep(1200)
check('提取产物为 3 页', t.docState.pageCount === 3, t.docState.pageCount)
await sleep(200)

// 重开原文档:原文档页数与注释不受影响(提取是复制,不是改写)
await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1200)
check('原文档仍 3 页', t.docState.pageCount === 3, t.docState.pageCount)

/* ---------- 4. 删除:范围删除后 pageCount 变化 ---------- */

await t.deletePages([1])
await sleep(600)
check('删除第 2 页后剩 2 页', t.docState.pageCount === 2, t.docState.pageCount)
await t.deletePages([0])
await sleep(600)
check('再删第 1 页后剩 1 页', t.docState.pageCount === 1, t.docState.pageCount)
// 不能删除全部页面:应保持 1 页不变
await t.deletePages([0])
await sleep(600)
check('删空被拒绝,仍剩 1 页', t.docState.pageCount === 1, t.docState.pageCount)

return {
  parse: 'ok',
  segments: 'ok',
  extract: 'ok',
  delete: 'ok'
}
