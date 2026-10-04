// 步骤 4 冒烟:页面管理(删除/旋转/空白页/合并/拆分导出)+ 注释页号迁移
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

window.confirm = () => true // 冒烟模式自动确认

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
check('初始页数 3', t.docState.pageCount === 3, t.docState.pageCount)

// 第 3 页(index 2)放一条注释,删除第 1 页后应迁移到 index 1
t.addAnnotation(
  t.withIdentity({
    kind: 'highlight',
    page: 2,
    bbox: { x: 50, y: 50, w: 100, h: 20 },
    color: '#ffe066',
    opacity: 0.4
  })
)
check('注释已添加', t.annotState.items.length === 1)

// 1) 删除第 1 页
await t.deletePages([0])
await sleep(700)
check('删除后页数 2', t.docState.pageCount === 2, t.docState.pageCount)
check('注释迁移到新页 1', t.annotState.items[0].page === 1, t.annotState.items[0].page)
check('视图页元素 2', document.querySelectorAll('.page-wrap').length === 2, document.querySelectorAll('.page-wrap').length)

// 2) 旋转第 1 页 90°:页面占位应变为横向(842x595)
await t.rotatePages([0], 90)
await sleep(800)
const wrap1 = document.querySelector('[data-page="1"]')
const aspect = wrap1 ? wrap1.clientWidth / wrap1.clientHeight : 0
check(
  '旋转后页面为横向',
  !!wrap1 && wrap1.clientWidth > wrap1.clientHeight && Math.abs(aspect - 842 / 595) < 0.05,
  wrap1 ? `${wrap1.clientWidth}x${wrap1.clientHeight}` : null
)

// 3) 插入空白页(当前页之后)
t.docState.currentPage = 1
await t.insertBlankPage(0)
await sleep(700)
check('插入后页数 3', t.docState.pageCount === 3, t.docState.pageCount)
const blankBox = t.docState.pageBoxes[1]
check('空白页尺寸等于参考页', Math.round(blankBox.w) === 595 && Math.round(blankBox.h) === 842, blankBox)

// 4) 合并:指定页码 + 输出新文件 + 编辑器切换 + 落盘重开
const counts = await window.pdfAPI.invoke('pdf:pageCounts', [
  `${__smokeRoot}/samples/sample-rotated.pdf`,
  `${__smokeRoot}/samples/sample-encrypted.pdf`,
  `${__smokeRoot}/samples/no-such.pdf`
])
check('页数读取:rotated=2', counts[0].pageCount === 2, counts[0])
check('页数读取:加密报错', typeof counts[1].error === 'string', counts[1])
check('页数读取:缺失报错', typeof counts[2].error === 'string', counts[2])

const rotated = `${__smokeRoot}/samples/sample-rotated.pdf`
await t.mergePdfs([rotated], [{ path: rotated, pages: [0] }], `${__smokeRoot}/tmp/merge-out.pdf`)
await sleep(900)
check('合并后页数 4(仅第 1 页)', t.docState.pageCount === 4, t.docState.pageCount)
check('编辑器切到合并结果', (t.docState.filePath ?? '').endsWith('merge-out.pdf'), t.docState.filePath)

await t.openPath(`${__smokeRoot}/tmp/merge-out.pdf`)
await sleep(1300)
check('合并产物 4 页', t.docState.pageCount === 4, t.docState.pageCount)
check('重开后注释恢复', t.annotState.items.length === 1, t.annotState.items.length)

// 5) 拆分导出所选页(直接传目标路径,绕过对话框)
await t.exportPages([0, 1], `${__smokeRoot}/tmp/export-pages.pdf`)
await sleep(600)

return {
  pageCount: t.docState.pageCount,
  annotationPage: t.annotState.items[0]?.page,
  exported: `${__smokeRoot}/tmp/export-pages.pdf`,
  pageBoxes: t.docState.pageBoxes.map((b) => `${Math.round(b.w)}x${Math.round(b.h)}`)
}
