// 步骤 25 冒烟:扫描件「统一页面方向」—— 纯函数判定 + 计划生成 + 应用/撤销 + 重绘
//               + 内容上下颠倒(180°,文字层与纯图像两条判定路径)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
/** 计划里某页的条目(不存在返回 undefined) */
const byPlan = (items, page) => items.find((item) => item.page === page)

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
// p4(页面框不同 + 内容横躺)、p5(页面框与基准一致 + 内容倒置)、p6(真正横向页,只报不转)
check('计划含 p4/p5/p6', state.items.length === 3, dump)
// 内容转 90° 的页要转 270°(逆时针 90°)才正立:转 90° 会把它转成倒置(改前就是这么错的)
check('p4 判为横躺且方向为 270°', byPage[4]?.delta === 270 && byPage[4]?.reason === 'text-sideways', byPage[4])
check('p5 判为倒置并建议转 180°', byPage[5]?.delta === 180 && byPage[5]?.reason === 'text-inverted', byPage[5])
check('p6 真正横向页不被误伤(delta=0)', byPage[6]?.delta === 0 && byPage[6]?.reason === 'page-only', byPage[6])
check('与基准一致的页不在计划里', byPage[1] === undefined && byPage[2] === undefined && byPage[3] === undefined, dump)

// 对话框必须把计划显示出来:改前 rows 只在 open 变化时填充(那一刻计划还是空的),
// 计划到达后界面停在"以下 0 页"、"应用"置灰 —— 用户看到的就是卡住
const dialogRows = [...document.querySelectorAll('.dialog .row')]
check('对话框逐页列出待调整页', dialogRows.length === state.items.length, {
  rows: dialogRows.length,
  items: state.items.length
})
check(
  '每行显示页码与旋转角',
  dialogRows.every(
    (row, i) =>
      row.querySelector('.page-no')?.textContent?.includes(String(state.items[i].page)) &&
      row.querySelector('.delta')?.value === String(state.items[i].delta)
  ),
  dialogRows.map((row) => row.textContent.replace(/\s+/g, ' ').trim())
)
const applyButton = [...document.querySelectorAll('.dialog button')].find((el) => el.textContent.trim() === '应用')
check('「应用」可点击(有计划就点得动)', !!applyButton && applyButton.disabled === false, applyButton?.disabled)

/* ---------- 5. 应用:页面框与内容姿态都要对 ---------- */
await t.applyOrientationFix(state.items)
await sleep(2500)
check('对话框已关闭', t.orientationDialogState.open === false, t.orientationDialogState.open)
check('p4 应用后变为纵向', t.docState.pageBoxes[3].w < t.docState.pageBoxes[3].h, t.docState.pageBoxes[3])
check('p4 应用后内容正立(改前会转到倒置)', (await t.detectContentPosture(4)) === 'upright', await t.detectContentPosture(4))
check('p5 仍为纵向(180° 不换宽高)', t.docState.pageBoxes[4].w < t.docState.pageBoxes[4].h, t.docState.pageBoxes[4])
check('p5 应用后内容正立', (await t.detectContentPosture(5)) === 'upright', await t.detectContentPosture(5))
check('p6 未被改动', t.docState.pageBoxes[5].w > t.docState.pageBoxes[5].h, t.docState.pageBoxes[5])
check('页数不变', t.docState.pageCount === 6, t.docState.pageCount)

/* ---------- 6. 撤销 ---------- */
await t.undo()
await sleep(2500)
check('撤销后 p4 恢复横向', t.docState.pageBoxes[3].w > t.docState.pageBoxes[3].h, t.docState.pageBoxes[3])
check('撤销后 p5 恢复倒置', (await t.detectContentPosture(5)) === 'inverted', await t.detectContentPosture(5))

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

/* ---------- 8. 没有文字层的扫描件:靠全篇行墨迹剖面的共识 ---------- */
// 夹具(scripts/make-image-orient-sample.mjs):p1-3 图像页正立 | p4 图像页内容转 180°
// | p5 横向框、内容正立(只报不转)| p6 纵向框、内容整体转 90°(横躺,要转正)
// 单页剖面在 180° 前后完全镜像,判不出上下;只有与其它页的共识比较才认得出 p4
await t.openPath(`${__smokeRoot}/samples/sample-image-orient.pdf`)
await sleep(1500)
check('图像夹具 6 页', t.docState.pageCount === 6, t.docState.pageCount)
check('p6 为纵向', t.docState.pageBoxes[5].w < t.docState.pageBoxes[5].h, t.docState.pageBoxes[5])
check('图像页没有文字层', (await t.detectContentPosture(1)) === 'upright', await t.detectContentPosture(1))
await t.normalizePageOrientation()
await sleep(800)
const imageState = t.orientationDialogState
const imagePlan = imageState.items.map((i) => `${i.page}:${i.from}->${i.to} d=${i.delta} ${i.reason}`)
check('第 4 页报倒置、第 5/6 页报待调整', imageState.items.length === 3, imagePlan)
check(
  '第 4 页判为倒置并建议转 180°',
  byPlan(imageState.items, 4)?.delta === 180 && byPlan(imageState.items, 4)?.reason === 'text-inverted',
  imagePlan
)
check(
  '横向内容页不被误转(OCR 读不出合成图案时退回墨迹投影)',
  byPlan(imageState.items, 5)?.delta === 0 && byPlan(imageState.items, 5)?.reason === 'page-only',
  imagePlan
)
// 页面框已是基准向、内容却横躺:旧实现直接丢弃这类页,现在要转正(页面框随之翻转)
const sideways6 = byPlan(imageState.items, 6)
check(
  '纵向框 + 横躺内容页转正 90/270° 且页面框翻为横向',
  (sideways6?.delta === 90 || sideways6?.delta === 270) &&
    sideways6?.to === 'landscape' &&
    sideways6?.reason === 'text-sideways',
  sideways6
)
await t.applyOrientationFix(imageState.items)
await sleep(2500)
check('第 4 页仍为纵向(180° 不换宽高)', t.docState.pageBoxes[3].w < t.docState.pageBoxes[3].h, t.docState.pageBoxes[3])
// 修好后同一套分析必须不再报它(倒置已消除,共识剖面也回到了正立)
await t.normalizePageOrientation()
await sleep(1500)
check('修复后不再报第 4 页', t.orientationDialogState.items.every((item) => item.page !== 4), t.orientationDialogState.items)
check(
  '修复后没有待转页(第 5/6 页若仍列出,delta 必须为 0)',
  t.orientationDialogState.items.every((item) => item.delta === 0),
  t.orientationDialogState.items.map((i) => `${i.page}:d=${i.delta} ${i.reason}`)
)

/* ---------- 8.1 整份文档方向一致时:不报任何页,并给出明确提示 ---------- */
await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
await t.normalizePageOrientation()
await sleep(1500)
check('方向一致的文档不报任何页', t.orientationDialogState.items.length === 0, t.orientationDialogState.items)
check(
  '无待调整页时给出明确提示(而不是"以下 0 页")',
  document.querySelector('.dialog .message')?.textContent?.includes('无需调整') ||
    document.querySelector('.dialog .message')?.textContent?.includes('方向一致'),
  document.querySelector('.dialog .message')?.textContent
)

/* ---------- 9. 离线 OCR 方向识别(密排/无文字层页面的唯一手段) ---------- */
// 直接验机制:夹具是干净的矢量文字页,OSD 判得出朝向(合成图案页返回 null,由调用方退回墨迹判据)
await t.openPath(`${__smokeRoot}/samples/sample-mixed-orient.pdf`)
await sleep(1500)
const ocr = {}
for (const page of [1, 5, 6]) ocr[page] = await t.detectOrientationByOcr(page)
check('OCR 认出正立页为 0°', ocr[1]?.delta === 0, ocr[1])
check('OCR 认出倒置页为 180°', ocr[5]?.delta === 180, ocr[5])
check('OCR 认出真正横向页为 0°', ocr[6]?.delta === 0, ocr[6])
check(
  'OCR 结果带置信度(供阈值筛)',
  [ocr[1], ocr[5], ocr[6]].every((r) => typeof r?.confidence === 'number' && r.confidence >= 0),
  Object.values(ocr).map((r) => r?.confidence)
)

return {
  pure: 'ok',
  plan: dump,
  apply: 'ok',
  undo: 'ok',
  redraw: 'ok',
  imagePlan,
  ocr: Object.fromEntries(Object.entries(ocr).map(([page, r]) => [page, `${r?.delta}°/${r?.confidence?.toFixed(1)}`]))
}
