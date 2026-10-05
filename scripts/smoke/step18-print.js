// 步骤 18 冒烟:打印管线(分页传输 + 干跑 + 清晰度像素校验;真实打印对话框为手动项)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
const invoke = (channel, payload) => window.pdfAPI.invoke(channel, payload)

// 1) 空任务被拒绝
const empty = await invoke('app:printPrepare', { jobName: 'smoke', pageCount: 0, sizesMm: [] })
check('空页面被拒绝', empty.ok === false && !!empty.error, empty)

// 2) 分页传输(真实渲染管线产出 PNG)+ 干跑提交
await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
const rendered = await t.renderPageWithAnnotations(`${__smokeRoot}/samples/sample-zh.pdf`, 1, true)
const prepared = await invoke('app:printPrepare', {
  jobName: 'smoke-print',
  pageCount: 2,
  sizesMm: [{ w: 210, h: 297 }, { w: 210, h: 297 }]
})
check('创建打印任务', prepared.ok === true && !!prepared.jobId, prepared)
check('第一页写入成功', (await invoke('app:printAddPage', { jobId: prepared.jobId, index: 0, dataUrl: rendered.dataUrl })).ok === true)
check('第二页写入成功', (await invoke('app:printAddPage', { jobId: prepared.jobId, index: 1, dataUrl: rendered.dataUrl })).ok === true)
const dry = await invoke('app:printCommit', { jobId: prepared.jobId, dryRun: true })
check('干跑成功', dry.ok === true && dry.pageCount === 2, dry.error ?? dry.pageCount)
check('打印 HTML 含 2 张页面图', (String(dry.html).match(/<img /g) ?? []).length === 2, String(dry.html).slice(0, 120))
check('打印 HTML 使用页面尺寸', String(dry.html).includes('210.0mm 297.0mm'), String(dry.html).slice(0, 160))

// 3) 缺页提交被拒绝,且任务已清理
const partial = await invoke('app:printPrepare', { jobName: 'smoke-partial', pageCount: 2, sizesMm: [] })
await invoke('app:printAddPage', { jobId: partial.jobId, index: 0, dataUrl: rendered.dataUrl })
const badCommit = await invoke('app:printCommit', { jobId: partial.jobId, dryRun: true })
check('缺页提交被拒绝', badCommit.ok === false && !!badCommit.error, badCommit)
check('被拒绝后任务已清理', (await invoke('app:printCommit', { jobId: partial.jobId, dryRun: true })).ok === false)

// 4) 未知任务 / 越界页码 / abort
check(
  '未知任务被拒绝',
  (await invoke('app:printAddPage', { jobId: 'missing', index: 0, dataUrl: rendered.dataUrl })).ok === false
)
const bounded = await invoke('app:printPrepare', { jobName: 'smoke-oob', pageCount: 1, sizesMm: [] })
check(
  '越界页码被拒绝',
  (await invoke('app:printAddPage', { jobId: bounded.jobId, index: 5, dataUrl: rendered.dataUrl })).ok === false
)
check('abort 成功', (await invoke('app:printAbort', { jobId: bounded.jobId })).ok === true)
check('abort 后提交失败', (await invoke('app:printCommit', { jobId: bounded.jobId, dryRun: true })).ok === false)

// 5) 清晰度:标准 2×(≈144dpi)与高清 300dpi 的实际像素尺寸
const measure = (url) =>
  new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve({ w: 0, h: 0 })
    img.src = url
  })
const stdPng = await measure(await t.renderPrintPageDataUrl(1, true, 'standard'))
const hiPng = await measure(await t.renderPrintPageDataUrl(1, true, 'high'))
check('标准清晰度 ≈ 144dpi', stdPng.w > 1100 && stdPng.w < 1300, stdPng)
check('高清清晰度 ≈ 300dpi', hiPng.w > 2350 && hiPng.w < 2600, hiPng)

// 6) 工具栏打印入口 + 对话框含清晰度选项
const printBtn = document.querySelector('.toolbar button[title="打印 (Ctrl+P)"]')
check('工具栏打印按钮存在', !!printBtn)
printBtn.click()
await sleep(300)
check(
  '打印范围对话框打开',
  !!document.querySelector('.mask .dialog') &&
    (document.querySelector('.mask .dialog .title')?.textContent ?? '').includes('打印')
)
const qualitySelect = [...document.querySelectorAll('.mask .dialog select')].find((el) =>
  [...el.options].some((opt) => opt.value === 'high')
)
check('对话框含清晰度选项', !!qualitySelect, null)
check('清晰度默认标准', qualitySelect?.value === 'standard', qualitySelect?.value)
qualitySelect.value = 'high'
qualitySelect.dispatchEvent(new Event('change', { bubbles: true }))
await sleep(100)
check('可切到高清', qualitySelect.value === 'high')
document.querySelector('.mask .dialog .actions button')?.click() // 取消
await sleep(200)
check('取消后对话框关闭', !document.querySelector('.mask .dialog'))

return { printPipeline: 'ok', printQuality: 'ok', printDialog: 'ok' }
