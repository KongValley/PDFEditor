// 步骤 21 冒烟:大文件 Range 流式加载(渲染层不接收整份字节,pdf.js 按需分段读取)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
const invoke = (channel, payload) => window.pdfAPI.invoke(channel, payload)

// 渲染是异步的(IntersectionObserver -> 取页 -> 画布),固定 sleep 在慢机上会假失败
async function waitForCanvas(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const canvas = document.querySelector(`[data-page="${page}"] .page-canvas`)
    if (canvas && canvas.width > 0) return canvas.width
    if (Date.now() > deadline) return canvas ? canvas.width : 0
    await sleep(150)
  }
}

/* ---------- 1. 大文件走 range:未整份传输且首页可渲染 ---------- */

await t.openPath(`${__smokeRoot}/tmp/large.pdf`)
await sleep(2500)

check('400 页文档已打开', t.docState.pageCount === 400, t.docState.pageCount)
// rangeStreamStats 是可变对象(每次打开就地更新),断言前先取快照
const largeStats = {
  mode: t.rangeStreamStats.mode,
  reads: t.rangeStreamStats.reads,
  bytes: t.rangeStreamStats.bytes,
  fileSize: t.rangeStreamStats.fileSize
}
check('打开方式为 range', largeStats.mode === 'range', largeStats)
check('发生了分段读取', largeStats.reads > 0, largeStats.reads)
check('未整份传输(< 文件大小一半)', largeStats.bytes < largeStats.fileSize / 2, {
  bytes: largeStats.bytes,
  fileSize: largeStats.fileSize
})

const firstCanvas = await waitForCanvas(1, 15000)
check('首页已渲染', firstCanvas > 0, firstCanvas)

/* ---------- 2. 远端页按需渲染 ---------- */
// 注意:pdf-lib 会把所有页对象/内容流写在文件头部(附件流在尾部),
// 因此「跳到远端页」不一定产生新的分段读取 —— 不能拿读取次数当断言。
// 真正要保护的是:远端页在 range 模式下能拿到正确字节并渲染出来。

t.scrollToPage(400)
const tailCanvas = await waitForCanvas(400, 20000)
check('第 400 页已渲染', tailCanvas > 0, tailCanvas)

/* ---------- 3. doc:readRange 契约 ---------- */

const head = await invoke('doc:readRange', { docId: t.docState.docId, begin: 0, end: 8 })
check('readRange 成功', head.ok === true && head.bytes?.byteLength === 8, head.ok ? head.bytes?.byteLength : head.error)
const magic = head.ok ? String.fromCharCode(...head.bytes.slice(0, 5)) : ''
check('前 5 字节为 %PDF-', magic === '%PDF-', magic)

const missing = await invoke('doc:readRange', { docId: 'missing', begin: 0, end: 8 })
check('未知 docId 返回失败', missing.ok === false && !!missing.error, missing)

/* ---------- 4. 页面操作后仍可用(重载走 buffer 分支) ---------- */

await t.rotatePages([0], 90)
const rotatedCanvas = await waitForCanvas(1, 15000)
check('旋转后页数不变', t.docState.pageCount === 400, t.docState.pageCount)
check('旋转后首页仍可渲染', rotatedCanvas > 0, rotatedCanvas)

/* ---------- 5. 小文件仍走 buffer(未被本次改动波及) ---------- */

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1200)
const smallMode = t.rangeStreamStats.mode
check('小文件走 buffer 分支', smallMode === 'buffer', smallMode)
check('小文件页数正确', t.docState.pageCount === 3, t.docState.pageCount)

return {
  large: { reads: largeStats.reads, bytes: largeStats.bytes, fileSize: largeStats.fileSize },
  tailCanvas,
  smallMode
}
