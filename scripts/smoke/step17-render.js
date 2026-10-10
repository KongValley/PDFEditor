// 步骤 17 冒烟:渲染看门狗(模拟 worker 停摆 → 超时取消 → 有界退避重试 → 最终渲染成功)
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
check('并发渲染闸门已定义', t.renderGate && t.renderGate.max === 2, t.renderGate)

/* ---------- 预读:当前页画完后相邻页也要铺好,滚动时直接复用位图 ---------- */
// 省内存机(≤4GB)按设计不预读;其余机器必须能在不滚动的情况下把第 2 页也画出来
if (!t.machineProfile.lowMem) {
  const deadline = Date.now() + 8000
  let prefetched = false
  while (Date.now() < deadline) {
    if (document.querySelector('[data-page="2"]')?.getAttribute('data-rendered') === '1') {
      prefetched = true
      break
    }
    await sleep(100)
  }
  check('相邻页已被预读(无需滚动到该页)', prefetched, { depth: t.prefetchDepth() })
}

const beforeTimeout = t.renderWatchdog.timeouts
const beforeRenders = t.renderWatchdog.renders
t.renderWatchdog.timeoutMs = 400
t.renderWatchdog.stallNext = true
t.docState.scale = 1.5 // 触发可见页重渲染,首次渲染被模拟停摆
// 重试带退避(400/800/1200ms),等足够长时间让重试链跑完
await sleep(6000)
check('看门狗超时计数 ≥ +1', t.renderWatchdog.timeouts >= beforeTimeout + 1, t.renderWatchdog.timeouts)
check('stallNext 已被消费', t.renderWatchdog.stallNext === false)
check('重试成功重新渲染', t.renderWatchdog.renders >= beforeRenders + 1, [beforeRenders, t.renderWatchdog.renders])
check('重试后仍渲染完成', !!document.querySelector('[data-page="1"] .ann-layer'))

t.renderWatchdog.timeoutMs = 8000
return { watchdog: 'ok', gate: t.renderGate.max }
