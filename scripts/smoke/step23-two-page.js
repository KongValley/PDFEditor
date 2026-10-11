// 步骤 23 冒烟:双页模式不出现整页空白(看门狗超时可自愈 + 并发闸门 + 播种竞态)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (cond, timeout = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (cond()) return true
    await sleep(50)
  }
  return false
}
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
/** 密集采样(每像素):小页/低缩放下稀疏采样会漏掉文字墨迹 */
const ink = (el) => {
  const c = el.querySelector('.page-canvas')
  if (!c || c.width === 0) return 0
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let n = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) n++
  return n
}
const visible = () => [...document.querySelectorAll('.page-wrap')].filter((el) => el.dataset.visible === '1')
const btn = (label) => [...document.querySelectorAll('.status-bar button')].find((b) => b.textContent.trim() === label)

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
if (!(await until(() => !!document.querySelector('[data-page="1"] .ann-layer')))) throw new Error('首页未渲染')

/* ---------- 1. 正常切双页:可见页全部有内容 ---------- */
btn('双页').click()
if (!(await until(() => t.docState.viewMode === 'two' && visible().length >= 2 && visible().every((el) => ink(el) > 0))))
  throw new Error('双页可见页未渲染: ' + JSON.stringify(visible().map((el) => `${el.dataset.page}:${ink(el)}`)))
check('双页模式生效', t.docState.viewMode === 'two', t.docState.viewMode)
check('双页渲染出两行(1-2 / 3)', document.querySelectorAll('.spread-row').length === 2)
const vis1 = visible()
check('双页可见页 ≥ 2', vis1.length >= 2, vis1.length)
check(
  '双页可见页均有内容(非白页)',
  vis1.every((el) => ink(el) > 0),
  vis1.map((el) => `${el.dataset.page}:${ink(el)}`)
)

/* ---------- 2. 回归:瞬态超时不再留下永久白页 ---------- */
// 改前行为:超时只重试 1 次即放弃 → 白页,且滚动/缩放都不恢复(仅切模式恢复)
// 用 stallNext 精确制造"某一页渲染停摆",而不是把 timeoutMs 压到 1ms ——
// 后者会让同屏每一页都必然超时,断言结果随机器负载漂移(step17 已覆盖通用重试链路)
btn('连续').click()
if (!(await until(() => t.docState.viewMode === 'continuous'))) throw new Error('未切回连续模式')
// 本步的等待预算按 8s 看门狗 + 400/800/1200ms 退避算;慢机自适应放宽会超出该预算,
// 用 overrideMs 固定成默认值,让断言只测"超时→重试→自愈"这条链路本身
t.renderWatchdog.overrideMs = 8000
const beforeTimeouts = t.renderWatchdog.timeouts
t.renderWatchdog.stallNext = true // 下一次渲染模拟停摆:真实结果忽略,靠看门狗超时后重试自愈
btn('双页').click()
// 先等双页切换的 watch 落定(位图按旧 scale 复用),
// 再改 scale:两者同批调度时 watch 只跑一次,位图仍被判为可用,stallNext 永远等不到消费者
await sleep(500)
// A2 修好后位图按内容正确复用:切模式可能命中缓存、根本没有新渲染。
// 用缩放变更强制可见页真实重渲染,让停摆必然发生
const stallScale = t.docState.scale
t.docState.scale = stallScale * 1.01
if (
  !(
    await until(
      () => t.renderWatchdog.timeouts > beforeTimeouts && visible().length > 0 && visible().every((el) => ink(el) > 0),
      30000
    )
  )
)
  throw new Error('停摆后可见页未自愈: ' + JSON.stringify(visible().map((el) => `${el.dataset.page}:${ink(el)}`)))
t.docState.scale = stallScale
t.renderWatchdog.overrideMs = 0
const vis2 = visible()
check('超时计数已记录', t.renderWatchdog.timeouts > beforeTimeouts, t.renderWatchdog.timeouts)
check(
  '瞬态超时后可见页最终有内容(不再永久白页)',
  vis2.length > 0 && vis2.every((el) => ink(el) > 0),
  vis2.map((el) => `${el.dataset.page}:${ink(el)}`)
)

/* ---------- 3. 双页下滚动:可见页始终有内容 ---------- */
t.scrollToPage(3)
if (!(await until(() => visible().length > 0 && visible().every((el) => ink(el) > 0))) ) throw new Error('滚动后可见页未渲染')
const vis3 = visible()
check(
  '双页滚动后可见页有内容',
  vis3.length > 0 && vis3.every((el) => ink(el) > 0),
  vis3.map((el) => `${el.dataset.page}:${ink(el)}`)
)

/* ---------- 4. 并发闸门未泄漏:槽位应已全部归还 ---------- */
check('并发闸门已定义', t.renderGate && t.renderGate.max >= 1, t.renderGate)
check('渲染槽全部归还', t.renderGate.active === 0, t.renderGate)
// 等待队列分优先级三桶(当前页 > 其它页 > 缩略图):数总量而不是取 .length
const pendingSlots = Object.values(t.renderGate.waiters).reduce((sum, queue) => sum + queue.length, 0)
check('无遗留等待者', pendingSlots === 0, pendingSlots)

/* ---------- 5. 机器画像:闸门上限按机器档位而非固定 2 ---------- */
const info = await window.pdfAPI.invoke('app:runtimeInfo')
check('runtimeInfo 含机器画像', typeof info.arch === 'string' && typeof info.lowMem === 'boolean', info)
check('闸门上限与机器档位一致', t.renderGate.max === (info.lowMem ? 1 : 2), {
  max: t.renderGate.max,
  lowMem: info.lowMem
})

return {
  twoPage: 'ok',
  noPermanentBlank: 'ok',
  gateMax: t.renderGate.max,
  machine: { arch: info.arch, lowMem: info.lowMem, totalMemMB: info.totalMemMB },
  timeouts: t.renderWatchdog.timeouts
}
