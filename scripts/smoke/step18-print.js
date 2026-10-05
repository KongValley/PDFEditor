// 步骤 18 冒烟:打印管线(离屏渲染 → 主进程打印 HTML,干跑;真实打印对话框为手动项)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

// 1) 空输入被拒绝
const bad = await window.pdfAPI.invoke('app:printPages', { jobName: 'smoke', dataUrls: [], sizesMm: [] })
check('空页面被拒绝', bad.ok === false && !!bad.error, bad)

// 2) 走真实渲染管线(现成的 test API:离屏渲染 + 注释叠加)后干跑打印
await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
const rendered = await t.renderPageWithAnnotations(`${__smokeRoot}/samples/sample-zh.pdf`, 1, true)
const dry = await window.pdfAPI.invoke('app:printPages', {
  jobName: 'smoke-print',
  dataUrls: [rendered.dataUrl, rendered.dataUrl],
  sizesMm: [{ w: 210, h: 297 }, { w: 210, h: 297 }],
  dryRun: true
})
check('打印干跑成功', dry.ok === true && dry.pageCount === 2, dry.error ?? dry.pageCount)
check('打印 HTML 含 2 张页面图', (String(dry.html).match(/<img /g) ?? []).length === 2, dry.html?.slice?.(0, 120))
check('打印 HTML 使用页面尺寸', String(dry.html).includes('210.0mm 297.0mm'), String(dry.html).slice(0, 160))

// 3) 工具栏打印入口存在(点击会打开范围对话框)
const printBtn = document.querySelector('.toolbar button[title="打印 (Ctrl+P)"]')
check('工具栏打印按钮存在', !!printBtn)
printBtn.click()
await sleep(300)
check(
  '打印范围对话框打开',
  !!document.querySelector('.mask .dialog') &&
    (document.querySelector('.mask .dialog .title')?.textContent ?? '').includes('打印')
)
document.querySelector('.mask .dialog .actions button')?.click() // 取消
await sleep(200)
check('取消后对话框关闭', !document.querySelector('.mask .dialog'))

return { printPipeline: 'ok', printDialog: 'ok' }
