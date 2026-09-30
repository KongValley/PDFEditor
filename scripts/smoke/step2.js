// 步骤 2 冒烟:打开中文样本,验证渲染/文本层/搜索/缩放/旋转/缩略图
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
  return true
}

await t.openPath('F:/DeepSeek工作区/pdf编辑器/samples/sample-zh.pdf')
await sleep(1500)

check('pageCount', t.docState.pageCount === 3, t.docState.pageCount)
check('pageBoxes', t.docState.pageBoxes.length === 3)
const canvas1 = document.querySelector('[data-page="1"] .page-canvas')
check('page1 rendered', canvas1 && canvas1.width > 1000, canvas1 ? canvas1.width : null)
const textSpans = document.querySelectorAll('.textLayer span').length
check('text layer spans', textSpans >= 5, textSpans)

const hits = await t.search('编辑器')
check('search hits', hits.length === 2, hits.length)
t.searchState.query = '编辑器'
t.searchState.results = hits
t.searchState.current = 0
await sleep(400)
const overlayRects = document.querySelectorAll('.page-wrap svg rect').length
check('search overlay rects', overlayRects === 2, overlayRects)

t.docState.scale = 1.5
await sleep(800)
const canvas1b = document.querySelector('[data-page="1"] .page-canvas')
check('zoom re-render', canvas1b.width === 892, canvas1b.width)

t.docState.scale = 1
t.docState.rotationView = 90
await sleep(800)
const wrap = document.querySelector('[data-page="1"]')
check('rotation swaps size', wrap.clientWidth === 842 && wrap.clientHeight === 595, {
  w: wrap.clientWidth,
  h: wrap.clientHeight
})
const canvas1c = document.querySelector('[data-page="1"] .page-canvas')
check('rotated render', canvas1c.width === 841 && canvas1c.height === 595, {
  w: canvas1c.width,
  h: canvas1c.height
})

t.docState.rotationView = 0
await sleep(600)

const thumbSizes = [...document.querySelectorAll('.thumb-canvas')].map((c) => `${c.width}x${c.height}`)
check('thumbnails rendered', thumbSizes.every((s) => s.startsWith('104x')), thumbSizes)

return {
  pageCount: t.docState.pageCount,
  textSpans,
  searchHits: hits.length,
  overlayRects,
  zoomCanvas: `${canvas1b.width}x${canvas1b.height}`,
  rotatedWrap: `${wrap.clientWidth}x${wrap.clientHeight}`,
  thumbSizes,
  proto: window.location.protocol
}
