// 步骤 19 冒烟:前进/后退历史 + 上次阅读位置恢复
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
check('初始无历史', t.readingState.canBack === false && t.readingState.canForward === false, t.readingState)
const backBtn = document.querySelector('.status-bar button[title="后退 (Alt+←)"]')
check('后退按钮存在且禁用', !!backBtn && backBtn.disabled === true)

t.scrollToPage(3)
await sleep(1200) // 等去抖(700ms)记入历史与阅读位置
check('可后退', t.readingState.canBack === true, t.readingState)
check('后退按钮启用', backBtn.disabled === false)

t.goBack()
await sleep(400)
check('后退到第 1 页', t.docState.currentPage === 1, t.docState.currentPage)
check('可前进', t.readingState.canForward === true, t.readingState)
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }))
await sleep(1200) // 等最后一次去抖落盘(700ms),确保阅读位置记录为第 3 页
check('Alt+→ 前进到第 3 页', t.docState.currentPage === 3, t.docState.currentPage)

// 阅读位置:启用恢复后重开同一文件
t.setRestoreLastPage(true)
await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1600)
check('重开恢复上次阅读位置', t.docState.currentPage === 3, t.docState.currentPage)
check(
  '恢复位置提示',
  (document.querySelector('.toast')?.textContent ?? '').includes('上次阅读位置'),
  document.querySelector('.toast')?.textContent ?? ''
)
check('恢复后当前页已渲染', !!document.querySelector(`[data-page="${t.docState.currentPage}"] .ann-layer`))

return { history: 'ok', restore: 'ok' }
