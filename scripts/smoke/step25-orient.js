// 步骤 25 冒烟:扫描件「统一页面方向」—— 纯函数判定 + 计划生成 + 应用/撤销 + 重绘
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

/* ---------- 1. 纯函数 ---------- */
check('纵向识别', t.orientationOf(595, 842) === 'portrait', t.orientationOf(595, 842))
check('横向识别', t.orientationOf(842, 595) === 'landscape', t.orientationOf(842, 595))
check('方形识别', t.orientationOf(600, 600) === 'square', t.orientationOf(600, 600))
check('近方形识别(2% 内)', t.orientationOf(600, 610) === 'square', t.orientationOf(600, 610))
check('基准取多数派', t.pickBaseOrientation(['portrait', 'portrait', 'landscape']) === 'portrait', null)
check('平票无法判定', t.pickBaseOrientation(['portrait', 'landscape']) === null, null)
check('方形不参与基准', t.pickBaseOrientation(['square', 'landscape', 'landscape']) === 'landscape', null)

/* ---------- 2. 夹具端到端:分析与计划 ---------- */
// 夹具(scripts/make-mixed-orient-sample.mjs):
//   p1-3 纵向正立 | p4 横向框+内容转 90°(横躺) | p5 纵向框+内容转 180°(倒置) | p6 横向框+内容正立(宽表格)
await t.openPath(`${__smokeRoot}/samples/sample-mixed-orient.pdf`)
await sleep(1500)
check('夹具 6 页', t.docState.pageCount === 6, t.docState.pageCount)
check('p4 为横向', t.docState.pageBoxes[3].w > t.docState.pageBoxes[3].h, t.docState.pageBoxes[3])
check('p6 为横向', t.docState.pageBoxes[5].w > t.docState.pageBoxes[5].h, t.docState.pageBoxes[5])

/* ---------- 3. 内容姿态判定(直接调用,覆盖不进入计划的情况) ---------- */
// p5 页面方向与基准一致(纵向),按设计不进入"统一方向"计划;
// 但内容倒置的判定本身要能独立验证
check('p4 内容横躺', (await t.detectContentPosture(4)) === 'sideways', await t.detectContentPosture(4))
check('p5 内容倒置', (await t.detectContentPosture(5)) === 'inverted', await t.detectContentPosture(5))
check('p1 内容正立', (await t.detectContentPosture(1)) === 'upright', await t.detectContentPosture(1))
check('p6 内容相对页面正立(真正横向页)', (await t.detectContentPosture(6)) === 'upright', await t.detectContentPosture(6))

/* ---------- 4. 统一方向的分析与计划 ---------- */
await t.normalizePageOrientation()
await sleep(500)
const state = t.orientationDialogState
check('对话框已打开', state.open === true, state.open)
check('分析结束', state.scanning === false, state.scanning)
check('基准为纵向', state.base === 'portrait', state.base)
const byPage = Object.fromEntries(state.items.map((item) => [item.page, item]))
const dump = state.items.map((i) => `${i.page}:${i.from}->${i.to} d=${i.delta} ${i.reason}`)
// 只分析"页面方向与基准不同"的页:p5 页面方向本身一致,按设计不进计划
check('候选页为 p4/p6', state.items.length === 2, dump)
check('p4 判为横躺并建议转 90°', byPage[4]?.delta === 90 && byPage[4]?.reason === 'text-sideways', byPage[4])
check('p6 真正横向页不被误伤(delta=0)', byPage[6]?.delta === 0 && byPage[6]?.reason === 'page-only', byPage[6])
check('与基准一致的页不在计划里', byPage[1] === undefined && byPage[2] === undefined && byPage[3] === undefined, dump)

/* ---------- 3. 应用 ---------- */
await t.applyOrientationFix(state.items)
await sleep(2500)
check('对话框已关闭', t.orientationDialogState.open === false, t.orientationDialogState.open)
check('p4 应用后变为纵向', t.docState.pageBoxes[3].w < t.docState.pageBoxes[3].h, t.docState.pageBoxes[3])
check('p5 仍为纵向(180° 不换宽高)', t.docState.pageBoxes[4].w < t.docState.pageBoxes[4].h, t.docState.pageBoxes[4])
check('p6 未被改动', t.docState.pageBoxes[5].w > t.docState.pageBoxes[5].h, t.docState.pageBoxes[5])
check('页数不变', t.docState.pageCount === 6, t.docState.pageCount)

/* ---------- 4. 撤销 ---------- */
await t.undo()
await sleep(2500)
check('撤销后 p4 恢复横向', t.docState.pageBoxes[3].w > t.docState.pageBoxes[3].h, t.docState.pageBoxes[3])

/* ---------- 7. 页面几何变化后必须重绘(geometryVersion) ---------- */
await t.normalizePageOrientation()
await sleep(500)
await t.applyOrientationFix(t.orientationDialogState.items)
await sleep(2000)
// 位图只为可见页渲染(见 PageCanvas.renderPage 的 !props.visible 早退),先滚到第 4 页
await t.scrollToPage(4)
await sleep(2500)
const canvas4 = document.querySelector('[data-page="4"] .page-canvas')
// 修复后第 4 页是纵向 → 位图应呈纵向(w < h);改前位图停留在旧朝向(横向)
check('第 4 页位图已按新方向重绘', !!canvas4 && canvas4.width > 0 && canvas4.height > canvas4.width, {
  w: canvas4?.width,
  h: canvas4?.height
})
const thumb4 = document.querySelector('[data-thumb="4"] canvas')
check('第 4 页缩略图已重绘', !!thumb4 && thumb4.width > 0, { w: thumb4?.width })

return {
  pure: 'ok',
  plan: dump,
  apply: 'ok',
  undo: 'ok',
  redraw: 'ok'
}