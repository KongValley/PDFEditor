// 步骤 17 冒烟:渲染看门狗(模拟 worker 停摆 → 超时取消 → 重试一次)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
check('首页已渲染', !!document.querySelector('[data-page="1"] .ann-layer'))
check('默认看门狗参数', t.renderWatchdog.timeoutMs === 8000 && t.renderWatchdog.stallNext === false)

const beforeTimeout = t.renderWatchdog.timeouts
const beforeRenders = t.renderWatchdog.renders
t.renderWatchdog.timeoutMs = 400
t.renderWatchdog.stallNext = true
t.docState.scale = 1.5 // 触发可见页重渲染,首次渲染被模拟停摆
await sleep(2500)
check('看门狗超时计数 +1', t.renderWatchdog.timeouts === beforeTimeout + 1, t.renderWatchdog.timeouts)
check('stallNext 已被消费', t.renderWatchdog.stallNext === false)
check('重试成功重新渲染', t.renderWatchdog.renders >= beforeRenders + 1, [beforeRenders, t.renderWatchdog.renders])
check('重试后仍渲染完成', !!document.querySelector('[data-page="1"] .ann-layer'))

t.renderWatchdog.timeoutMs = 8000
return { watchdog: 'ok' }
