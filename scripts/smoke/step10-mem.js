// 步骤 10 冒烟(低内存):50 页文档连续翻页后,页缓存与画布数量受控
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

await t.openPath(`${__smokeRoot}/tmp/50pages.pdf`)
await sleep(2000)
check('50 页文档已打开', t.docState.pageCount === 50, t.docState.pageCount)

for (let page = 1; page <= 50; page++) {
  t.scrollToPage(page)
  await sleep(60)
}
await sleep(600)

const nonEmptyCanvases = [...document.querySelectorAll('.page-canvas')].filter((c) => c.width > 0).length
const cached = t.cachedPageCount()
const heap = performance.memory?.usedJSHeapSize ?? -1

check('非空页面画布 ≤ 10', nonEmptyCanvases <= 10, nonEmptyCanvases)
// 12 上限 + 缩略图可见页余量(缩略图可见项受保护,不参与回收)
check('页缓存 ≤ 24', cached <= 24, cached)
check('页缓存远小于总页数', cached < 50, cached)
if (heap > 0) check('JS 堆 < 400MB', heap < 400 * 1024 * 1024, `${Math.round(heap / 1024 / 1024)}MB`)

// 回访已回收的页:必须能重新渲染(缓存回收不能破坏再次访问)
t.scrollToPage(1)
const revisitDeadline = Date.now() + 10000
let firstCanvas = document.querySelector('[data-page="1"] .page-canvas')
while ((!firstCanvas || firstCanvas.width === 0) && Date.now() < revisitDeadline) {
  await sleep(150)
  firstCanvas = document.querySelector('[data-page="1"] .page-canvas')
}
check('回访第 1 页可重新渲染', !!firstCanvas && firstCanvas.width > 0, firstCanvas ? firstCanvas.width : null)
const aliveThumbs = [...document.querySelectorAll('.thumb-canvas')].filter((c) => c.width > 0).length
check('缩略图仍有渲染', aliveThumbs > 0, aliveThumbs)
const pins = t.pinnedPageCounts()
check('缩略图 pin 规模受控(≤ 16)', pins.thumbs <= 16, pins)
check('主视图 pin 规模受控(≤ 8)', pins.viewer <= 8, pins)

return {
  pageCount: t.docState.pageCount,
  nonEmptyCanvases,
  cachedPages: cached,
  jsHeapMB: heap > 0 ? Math.round(heap / 1024 / 1024) : 'n/a',
  revisitCanvasWidth: firstCanvas ? firstCanvas.width : 0,
  aliveThumbs,
  pins
}
