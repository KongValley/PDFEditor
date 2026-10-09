// 步骤 27 冒烟:页面/视图旋转后的自动缩放(当前页竖↔横翻转 → 整页可见)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
const viewerEl = () => document.querySelector('.viewer')
const pageW = () => document.querySelector('[data-page="1"]').getBoundingClientRect().width
const fits = () => pageW() <= viewerEl().clientWidth + 2

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1600)
check('样本首页为纵向', t.docState.pageBoxes[0].h > t.docState.pageBoxes[0].w, t.docState.pageBoxes[0])

/* 1. 页面旋转(写文件):手动放大后转横 → 自动重适应 */
t.zoomBy(5) // 钳到 400%,进入手动缩放(fitMode='none')
await sleep(400)
check('已放大到 400%', Math.abs(t.docState.scale - 4) < 1e-6, t.docState.scale)
await t.rotatePages([0], 90)
await sleep(1200)
check('首页转为横向', t.docState.pageBoxes[0].w > t.docState.pageBoxes[0].h, t.docState.pageBoxes[0])
check('转横后自动重适应(整页可见)', fits(), { pageW: pageW(), view: viewerEl().clientWidth })
check('缩放已重算(不再是 400%)', t.docState.scale < 4, t.docState.scale)

/* 2. 180° 不换宽高 → 不触发重适应 */
const scale180 = t.docState.scale
await t.rotatePages([0], 180)
await sleep(1200)
check('180° 后缩放不变', Math.abs(t.docState.scale - scale180) < 1e-6, { before: scale180, after: t.docState.scale })
check('仍是横向', t.docState.pageBoxes[0].w > t.docState.pageBoxes[0].h, t.docState.pageBoxes[0])

/* 3. 再转 90 回纵向 → 再次自动重适应 */
await t.rotatePages([0], 90)
await sleep(1200)
check('首页回到纵向', t.docState.pageBoxes[0].h > t.docState.pageBoxes[0].w, t.docState.pageBoxes[0])
check('回纵向后整页可见', fits(), { pageW: pageW(), view: viewerEl().clientWidth })
check('回纵向后缩放随之变化', t.docState.scale !== scale180, t.docState.scale)

/* 4. 视图旋转(不改文件):同样自动重适应,且不修改 pageBoxes */
const boxBefore = { ...t.docState.pageBoxes[0] }
t.zoomBy(5)
await sleep(400)
document.querySelector('.toolbar button[title="视图右旋 90°"]').click()
await sleep(1200)
check('视图旋转后整页可见', fits(), { pageW: pageW(), view: viewerEl().clientWidth })
check(
  '视图旋转不改文件',
  t.docState.pageBoxes[0].w === boxBefore.w && t.docState.pageBoxes[0].h === boxBefore.h,
  t.docState.pageBoxes[0]
)
document.querySelector('.toolbar button[title="视图左旋 90°"]').click()
await sleep(1200)
check('视图转回后整页可见', fits(), { pageW: pageW(), view: viewerEl().clientWidth })

return { pageRotateFit: 'ok', viewRotateFit: 'ok' }