// 步骤 24 冒烟:机器画像 / 渲染闸门自适应 / 长图自动降 scale 与超限拦截 / 打印高清降级
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

/** 采集期间出现过的全部 toast(单条 toast 只存活 3.6s,长图渲染耗时更久,必须边跑边收) */
const toasts = []
const poll = setInterval(() => {
  const text = t.ui.toast?.text
  if (text && toasts[toasts.length - 1] !== text) toasts.push(text)
}, 50)

/* ---------- 1. 机器画像与渲染闸门按档取值 ---------- */
const info = await window.pdfAPI.invoke('app:runtimeInfo')
check('runtimeInfo 含机器画像', typeof info.arch === 'string' && typeof info.lowMem === 'boolean', info)
check('机器画像已就绪', t.machineProfile.ready === true && t.machineProfile.arch === info.arch, {
  ready: t.machineProfile.ready,
  arch: t.machineProfile.arch
})
check('渲染闸门按机器画像取值', t.renderGate.max === (info.lowMem ? 1 : 2), {
  max: t.renderGate.max,
  lowMem: info.lowMem
})

/* ---------- 2. 打印清晰度:纯函数断言,不触发系统打印对话框 ---------- */
const lowMemBefore = t.machineProfile.lowMem
t.machineProfile.lowMem = true
check('省内存机高清降为标准档', t.resolvePrintScale('high') === 2, t.resolvePrintScale('high'))
t.machineProfile.lowMem = false
check('常规机器高清仍为 300dpi', Math.abs(t.resolvePrintScale('high') - 300 / 72) < 1e-6, t.resolvePrintScale('high'))
check('标准档与机器无关', t.resolvePrintScale('standard') === 2, t.resolvePrintScale('standard'))
t.machineProfile.lowMem = lowMemBefore

/* ---------- 3. 长图超限:给出提示,不再静默返回 ---------- */
await t.openPath(`${__smokeRoot}/tmp/large.pdf`)
await sleep(1500)
check('大文档 400 页', t.docState.pageCount === 400, t.docState.pageCount)
const all = [...Array(400).keys()]
await t.exportPagesAsImages(all, 'long', 'v', false)
await sleep(300) // toast 由 50ms 轮询采集,导出返回后需让轮询跑一拍
const limitToast = toasts[toasts.length - 1] ?? ''
check('长图超限时明确报错(改前是无提示静默返回)', limitToast.includes('像素上限'), toasts)

/* ---------- 4. 长图页数可控:自动降 scale 并真正落盘 ---------- */
toasts.length = 0
await t.exportPagesAsImages(all.slice(0, 100), 'long', 'v', false)
await sleep(300)
check('已提示自动降分辨率', toasts.some((x) => x.includes('自动降到')), toasts)
check('降档后长图导出成功', toasts.some((x) => x.includes('已导出长图')), toasts)

/* ---------- 5. 逐页批量:规模超预判即拦截,不会走到保存目录对话框 ---------- */
toasts.length = 0
await t.exportPagesAsImages(all, 'each', undefined, false)
await sleep(300)
const batchToast = toasts[toasts.length - 1] ?? ''
check('批量导出超量被拦截', batchToast.includes('分批导出'), toasts)

/* ---------- 6. 软件光栅收敛:投影只画在可见页上 ---------- */
const wraps = [...document.querySelectorAll('.page-wrap')]
const shown = wraps.filter((el) => el.dataset.visible === '1')
const hidden = wraps.filter((el) => el.dataset.visible === '0')
check('可见页保留投影', shown.length > 0 && shown.every((el) => !el.classList.contains('page-noshadow')), shown.length)
check('离屏页去掉投影', hidden.length > 0 && hidden.every((el) => el.classList.contains('page-noshadow')), hidden.length)

clearInterval(poll)

return {
  machine: { arch: info.arch, lowMem: info.lowMem, totalMemMB: info.totalMemMB },
  gateMax: t.renderGate.max,
  printScaleHigh: t.resolvePrintScale('high'),
  longLimit: limitToast,
  longBatch: toasts.slice(-2),
  batchGuard: batchToast
}