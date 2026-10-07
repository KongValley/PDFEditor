// 性能探针:在 1.8.1 与 1.9.0 两套 out/ 上跑同一负载,输出可对比的耗时与内存。
// 只依赖 window.__pdfEditorTest 的稳定成员;1.9.0 专有接口用可选访问,1.8.1 上自动跳过。
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => performance.now()
const heapMB = () => {
  const h = performance.memory?.usedJSHeapSize ?? 0
  return h > 0 ? Math.round((h / 1048576) * 10) / 10 : -1
}
/** 连续取 3 次 JS 堆,取最小值(避开 GC 峰值) */
async function heapFloorMB() {
  const samples = []
  for (let i = 0; i < 3; i++) {
    samples.push(heapMB())
    await sleep(120)
  }
  const valid = samples.filter((s) => s >= 0)
  return valid.length ? Math.min(...valid) : -1
}

/* ---------- 1. 大文件打开耗时 + 稳定后内存 ---------- */
const openStart = now()
await t.openPath(`${__smokeRoot}/tmp/large.pdf`)
// 等首页画布真正出现(两套构建都用同一判据)
const openDeadline = now() + 30000
let firstOk = false
while (now() < openDeadline) {
  const c = document.querySelector('[data-page="1"] .page-canvas')
  if (c && c.width > 0) {
    firstOk = true
    break
  }
  await sleep(50)
}
const openMs = Math.round(now() - openStart)
await sleep(1500)

const peakHeapAfterOpen = await heapFloorMB()
const rangeStats = t.rangeStreamStats
  ? { mode: t.rangeStreamStats.mode, reads: t.rangeStreamStats.reads, bytes: t.rangeStreamStats.bytes }
  : { mode: 'n/a' }

/* ---------- 2. 滚动负载:40 次跳页,量总耗时/帧数/主线程阻塞 ---------- */
let frames = 0
let rafStop = false
const countFrame = () => {
  if (rafStop) return
  frames++
  requestAnimationFrame(countFrame)
}
requestAnimationFrame(countFrame)

// 主线程阻塞(长任务)是渲染卡顿的直接来源,比进程 CPU% 更能反映优化效果
let blockingMs = 0
let longTasks = 0
let observer = null
if (typeof PerformanceObserver !== 'undefined') {
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration >= 50) {
          blockingMs += e.duration
          longTasks++
        }
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    observer = null
  }
}

const scrollStart = now()
for (let i = 0; i < 40; i++) {
  t.scrollToPage(1 + Math.floor((i * (t.docState.pageCount - 1)) / 39))
  await sleep(50)
}
const scrollMs = Math.round(now() - scrollStart)
await sleep(1200)
rafStop = true
if (observer) observer.disconnect()

const heapAfterScroll = await heapFloorMB()

/* ---------- 3. 连续滚动:遍历整份文档,压几何计算与画布生命周期 ---------- */
// 跳页负载主要测打开与渲染;连续滚动才会触发每次滚动事件的几何计算(§4-2)
// 与视口外画布回收(§4-4),这才是那两项优化真正作用的地方。
const viewer = document.querySelector('.viewer')
let contMs = -1
let contFrames = 0
let contBlockingMs = 0
let contCanvases = -1
if (viewer) {
  let cFrames = 0
  let cStop = false
  const cCount = () => {
    if (cStop) return
    cFrames++
    requestAnimationFrame(cCount)
  }
  requestAnimationFrame(cCount)

  let cBlocking = 0
  let cObserver = null
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      cObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.duration >= 50) cBlocking += e.duration
      })
      cObserver.observe({ entryTypes: ['longtask'] })
    } catch {
      cObserver = null
    }
  }

  const total = viewer.scrollHeight - viewer.clientHeight
  const steps = 80
  const cStart = now()
  for (let i = 0; i <= steps; i++) {
    viewer.scrollTop = Math.round((total * i) / steps)
    await sleep(16)
  }
  contMs = Math.round(now() - cStart)
  await sleep(800)
  cStop = true
  if (cObserver) cObserver.disconnect()
  contFrames = cFrames
  contBlockingMs = Math.round(cBlocking)
  contCanvases = [...document.querySelectorAll('.page-canvas')].filter((c) => c.width > 0).length
}

/* ---------- 4. 空闲内存采样 ---------- */
await sleep(1500)
const idleHeapMB = await heapFloorMB()

const result = {
  openMs,
  firstPageRendered: firstOk,
  scrollMs,
  scrollFrames: frames,
  blockingMs: Math.round(blockingMs),
  longTasks,
  continuousScrollMs: contMs,
  continuousScrollFrames: contFrames,
  continuousBlockingMs: contBlockingMs,
  continuousCanvases: contCanvases,
  heap: { afterOpen: peakHeapAfterOpen, afterScroll: heapAfterScroll, idle: idleHeapMB },
  pageCount: t.docState.pageCount,
  range: rangeStats
}
// executeJavaScript 的返回值要过结构化克隆:先过一遍 JSON 保证只含纯数据
return JSON.parse(JSON.stringify(result))
