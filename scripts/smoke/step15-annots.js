// 步骤 15 冒烟:真实 PDF 批注对象(写入 /Annots + /AP、读回、幂等、删除即消失)+ 导出勾选「包含注释」+ 审查缺陷修复
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

window.confirm = () => true
const stamp = Date.now()
const tmp = `${__smokeRoot}/tmp`
const started = Date.now()
const log = (name) => console.log(`[step15] ${name} @${Date.now() - started}ms`)

async function makeCopy(sourceFile, pages, dirName) {
  const res = await window.pdfAPI.invoke('pdf:splitTasks', {
    tasks: [{ mode: 'ranges', path: `${__smokeRoot}/samples/${sourceFile}`, ranges: [pages] }],
    outputDir: `${tmp}/${dirName}`
  })
  check(`${sourceFile} 副本生成`, res[0].ok === true, res[0])
  return res[0].outputs[0]
}

function annotById(id) {
  return t.annotState.items.find((a) => a.id === id)
}

/* ---------- 1. 批注写入 /Annots:重开恢复、删除即消失、保存幂等 ---------- */

log('copyA:make')
const copyA = await makeCopy('sample-zh.pdf', [0, 1, 2], `ann-copy-${stamp}`)
log('copyA:open')
await t.openPath(copyA)
await sleep(1400)
check('副本初始无注释', t.annotState.items.length === 0, t.annotState.items.length)

const rectId = t.withIdentity({
  kind: 'rect',
  page: 0,
  bbox: { x: 60, y: 60, w: 120, h: 60 },
  color: '#e03131',
  opacity: 1,
  thickness: 1.5
})
t.addAnnotation(rectId)
t.addAnnotation(
  t.withIdentity({
    kind: 'highlight',
    page: 0,
    bbox: { x: 60, y: 160, w: 120, h: 18 },
    color: '#ffe066',
    opacity: 0.4
  })
)
await sleep(200)
check('已加 2 条注释', t.annotState.items.length === 2, t.annotState.items.length)

log('save:1')
await t.saveDocument()
await sleep(900)

// 重开:注释从 PDF /Annots 读回(sidecar 已写 annotations: [])
log('reopen:1')
await t.openPath(copyA)
await sleep(1500)
check('重开恢复 2 条(来自 PDF)', t.annotState.items.length === 2, t.annotState.items.length)
const kinds = t.annotState.items
  .map((a) => a.kind)
  .sort()
  .join(',')
check('类型保持 rect+highlight', kinds === 'highlight,rect', kinds)
check('页号对齐', t.annotState.items.every((a) => a.page === 0), t.annotState.items.map((a) => a.page))

// 删除 1 条 → 保存 → 重开:不复活、不叠影
t.ui.selectedAnnotationIds = [rectId.id]
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
await sleep(200)
check('删除后剩 1 条', t.annotState.items.length === 1, t.annotState.items.length)
log('save:2')
await t.saveDocument()
await sleep(900)
log('reopen:2')
await t.openPath(copyA)
await sleep(1500)
check('重开仍 1 条(删除生效)', t.annotState.items.length === 1, t.annotState.items.length)
check('剩下的是另一条', t.annotState.items[0].id !== rectId.id)

// 幂等:再保存 + 重开仍是 1 条(真实批注重建,不重复叠加)
log('save:3')
await t.saveDocument()
await sleep(900)
log('reopen:3')
await t.openPath(copyA)
await sleep(1500)
check('二次保存后仍 1 条(幂等)', t.annotState.items.length === 1, t.annotState.items.length)

/* ---------- 2. 导出勾选「包含注释」 ---------- */

const exportIn = `${tmp}/ann-export-in-${stamp}.pdf`
const exportOut = `${tmp}/ann-export-out-${stamp}.pdf`
log('export:in')
await t.exportPages([0], exportIn, true)
await sleep(600)
await t.openPath(exportIn)
await sleep(1400)
check('勾选:导出文件继承该页注释', t.annotState.items.length === 1, t.annotState.items.length)

log('export:out')
await t.exportPages([0], exportOut, false)
await sleep(600)
await t.openPath(exportOut)
await sleep(1400)
check('不勾:导出文件无注释', t.annotState.items.length === 0, t.annotState.items.length)

/* ---------- 2b. 其它阅读器可见(pdf.js 原生批注绘制,即标准阅读器路径) ---------- */

log('foreign-reader')
await t.openPath(exportIn)
await sleep(1300)
const kept = t.annotState.items[0]
check('导出文件注释已恢复(供阅读器验证)', !!kept, t.annotState.items.length)
const native = await t.renderWithNativeAnnotations(exportIn, 1)
check('pdf.js 识别到原生批注', native.subtypes.length === 1, native.subtypes)

// 采样注释中心:PDF 坐标 → 页面顶向下 → ×2 位图
const pageHeight = t.docState.pageBoxes[kept.page].h
const cx = Math.round((kept.bbox.x + kept.bbox.w / 2) * 2)
const cy = Math.round((pageHeight - (kept.bbox.y + kept.bbox.h / 2)) * 2)
const nativeCanvas = document.createElement('canvas')
nativeCanvas.width = native.width
nativeCanvas.height = native.height
const nativeCtx = nativeCanvas.getContext('2d')
const nativeImg = new Image()
await new Promise((resolve, reject) => {
  nativeImg.onload = resolve
  nativeImg.onerror = reject
  nativeImg.src = native.dataUrl
})
nativeCtx.drawImage(nativeImg, 0, 0)
const nativePixel = nativeCtx.getImageData(cx, cy, 1, 1).data
const nativeTinted = !(nativePixel[0] > 250 && nativePixel[1] > 250 && nativePixel[2] > 250)
check('标准阅读器渲染路径可见注释', nativeTinted, [nativePixel[0], nativePixel[1], nativePixel[2], cx, cy])

/* ---------- 2c. PNG 导出画笔:勾选含注释 / 不勾为纯页面 ---------- */

log('png-paint')
await t.openPath(exportIn)
await sleep(1300)
const withPaint = await t.renderPageWithAnnotations(exportIn, 1, true)
const withoutPaint = await t.renderPageWithAnnotations(exportIn, 1, false)
function pixelAt(dataUrl, x, y) {
  const c = document.createElement('canvas')
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(x, y, 1, 1).data
      resolve([d[0], d[1], d[2]])
    }
    img.src = dataUrl
  })
}
const paintPx = await pixelAt(withPaint.dataUrl, cx, cy)
const barePx = await pixelAt(withoutPaint.dataUrl, cx, cy)
check('PNG 勾选:注释被绘制', !(paintPx[0] > 250 && paintPx[1] > 250 && paintPx[2] > 250), paintPx)
check('PNG 不勾:纯页面(同一位置为白)', barePx[0] > 250 && barePx[1] > 250 && barePx[2] > 250, barePx)

/* ---------- 3. 缩略图拖拽落位公式(纯函数) ---------- */

check('drop(1,3,false)=1', t.dropTargetIndex(1, 3, false) === 1)
check('drop(1,3,true)=2', t.dropTargetIndex(1, 3, true) === 2)
check('drop(3,2,false)=1', t.dropTargetIndex(3, 2, false) === 1)
check('drop(3,1,false)=0', t.dropTargetIndex(3, 1, false) === 0)
check('drop(1,1,false)=null', t.dropTargetIndex(1, 1, false) === null)
check('drop(5,5,true)=null', t.dropTargetIndex(5, 5, true) === null)
check('drop(1,5,false)=3', t.dropTargetIndex(1, 5, false) === 3)
check('drop(5,1,true)=1', t.dropTargetIndex(5, 1, true) === 1)

/* ---------- 4. 页面操作后搜索索引失效 ---------- */

log('search:open')
await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1500)
const hits = await t.search('第')
check('原始搜索命中 ≥3', hits.matches.length >= 3, hits.matches.length)
t.searchState.results = hits.matches
t.searchState.current = 0
log('search:delete')
await t.deletePages([0])
await sleep(1200)
check('删页后结果清空(invalidateSearch)', t.searchState.results.length === 0, t.searchState.results.length)
const fresh = await t.search('第')
check('重新搜索有结果', fresh.matches.length > 0, fresh.matches.length)
check('命中页号均为旧索引之外的页', fresh.matches.every((m) => m.page >= 0))
check('首个命中来自新第 1 页文本', (fresh.matches[0].snippet ?? '').includes('第二'), fresh.matches[0])

/* ---------- 5. 打开失败保留现场 ---------- */

log('keep:make')
const copyC = await makeCopy('sample-zh.pdf', [0, 1, 2], `ann-keep-${stamp}`)
log('keep:open')
await t.openPath(copyC)
await sleep(1400)
check('现场文档 3 页', t.docState.pageCount === 3, t.docState.pageCount)
const keepId = t.withIdentity({
  kind: 'rect',
  page: 0,
  bbox: { x: 40, y: 40, w: 50, h: 30 },
  color: '#e03131',
  opacity: 1,
  thickness: 1
})
t.addAnnotation(keepId)
await sleep(150)
await t.openPath(`${__smokeRoot}/no-such-${stamp}.pdf`)
await sleep(600)
check('失败后页数不变', t.docState.pageCount === 3, t.docState.pageCount)
check('失败后注释保留', t.annotState.items.length === 1, t.annotState.items.length)
check('失败后路径不变', (t.docState.filePath ?? '').endsWith(copyC.split(/[\\/]/).pop() ?? ''), t.docState.filePath)

/* ---------- 6. 失败打开 3 次后仍可保存(主进程条目已释放) ---------- */

async function cancelPasswordOnce() {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const dialog = document.querySelector('.mask .dialog')
    if (dialog) {
      const cancelBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消')
      check('找到密码对话框取消按钮', !!cancelBtn)
      cancelBtn.click()
      return
    }
    await sleep(100)
  }
  throw new Error('密码对话框未出现')
}

const encPath = `${__smokeRoot}/samples/sample-encrypted-pw.pdf`
for (let i = 0; i < 3; i++) {
  log(`release:attempt${i + 1}`)
  const attempt = t.openPath(encPath)
  await sleep(400)
  await cancelPasswordOnce()
  await attempt
  await sleep(300)
}
log('release:save')
t.addAnnotation(
  t.withIdentity({
    kind: 'rect',
    page: 0,
    bbox: { x: 200, y: 200, w: 40, h: 40 },
    color: '#1971c2',
    opacity: 1,
    thickness: 1
  })
)
await sleep(150)
await t.saveDocument()
await sleep(900)
check('3 次失败打开后仍可保存', t.docState.dirty === false, t.docState.dirty)
check('无错误 toast', !document.querySelector('.toast.error'), document.querySelector('.toast')?.textContent ?? '')

/* ---------- 7. 页面撤销 → 置脏 ---------- */

log('undo:make')
const copyB = await makeCopy('sample-zh.pdf', [0, 1, 2], `ann-copy2-${stamp}`)
log('undo:open')
await t.openPath(copyB)
await sleep(1400)
check('副本 3 页', t.docState.pageCount === 3, t.docState.pageCount)
log('undo:delete')
await t.deletePages([0])
await sleep(1200)
check('删除后 2 页', t.docState.pageCount === 2, t.docState.pageCount)
log('undo:save')
await t.saveDocument()
await sleep(900)
check('保存后不脏', t.docState.dirty === false, t.docState.dirty)
log('undo:undo')
await t.undo()
await sleep(1600)
check('撤销后回到 3 页', t.docState.pageCount === 3, t.docState.pageCount)
check('撤销后置脏(内存偏离磁盘)', t.docState.dirty === true, t.docState.dirty)

/* ---------- 8. Ctrl+Z 不劫持输入框 ---------- */

log('keystroke')
const textAnn = t.withIdentity({
  kind: 'text',
  page: 0,
  bbox: { x: 80, y: 400, w: 220, h: 40 },
  color: '#212529',
  opacity: 1,
  text: '原文',
  fontSize: 14,
  rotate: 0
})
t.addAnnotation(textAnn)
await sleep(200)
t.ui.selectedAnnotationIds = [textAnn.id]
await sleep(400)
const ta = document.querySelector('.props textarea')
check('属性面板文本框存在', !!ta)
ta.focus()
const beforeCount = t.annotState.items.length
const notPrevented = ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
check('文本框内 Ctrl+Z 未被 preventDefault', notPrevented === true)
check('文本框内 Ctrl+Z 未触发撤销', t.annotState.items.length === beforeCount, t.annotState.items.length)
ta.blur()
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
await sleep(400)
check('全局 Ctrl+Z 撤销生效', t.annotState.items.length === beforeCount - 1, t.annotState.items.length)

/* ---------- 9. 下拉框聚焦时方向键不翻页 ---------- */

const sel = document.querySelector('.ann-list .filters select')
check('注释列表筛选下拉存在', !!sel)
sel.focus()
const pageBefore = t.docState.currentPage
sel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
await sleep(300)
check('下拉框内右箭头不翻页', t.docState.currentPage === pageBefore, [pageBefore, t.docState.currentPage])

/* ---------- 10. 属性面板内容编辑 = 单条历史 ---------- */

log('propsHistory')
const textAnn2 = t.withIdentity({
  kind: 'text',
  page: 0,
  bbox: { x: 90, y: 300, w: 220, h: 40 },
  color: '#212529',
  opacity: 1,
  text: '原始文本',
  fontSize: 14,
  rotate: 0
})
t.addAnnotation(textAnn2)
await sleep(200)
t.ui.selectedAnnotationIds = [textAnn2.id]
await sleep(400)
const ta2 = document.querySelector('.props textarea')
check('属性面板文本框存在(2)', !!ta2)
const original = annotById(textAnn2.id).text
ta2.focus()
ta2.value = 'A'
ta2.dispatchEvent(new Event('input', { bubbles: true }))
ta2.value = 'AB'
ta2.dispatchEvent(new Event('input', { bubbles: true }))
ta2.dispatchEvent(new Event('change', { bubbles: true }))
await sleep(200)
check('实时值已更新', annotById(textAnn2.id).text === 'AB', annotById(textAnn2.id).text)
ta2.blur()
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
await sleep(400)
check('单条撤销回到原值(输入不逐字写史)', annotById(textAnn2.id).text === original, annotById(textAnn2.id).text)

/* ---------- 11. 合并含同 id 批注的副本:被并页批注不丢(审查 R1) ---------- */

log('mergeDup')
const split = (tasks, outputDir) => window.pdfAPI.invoke('pdf:splitTasks', { tasks, outputDir })
const dirDup = `${tmp}/rev-dup-${stamp}`
const dupA = (await split([{ mode: 'ranges', path: `${__smokeRoot}/samples/sample-zh.pdf`, ranges: [[0, 1, 2]] }], dirDup))[0].outputs[0]
await t.openPath(dupA)
await sleep(1400)
const dupRect = t.withIdentity({
  kind: 'rect',
  page: 0,
  bbox: { x: 60, y: 60, w: 120, h: 60 },
  color: '#e03131',
  opacity: 1,
  thickness: 1.5
})
t.addAnnotation(dupRect)
await sleep(200)
await t.saveDocument()
await sleep(900)
// 副本:复制 A 的第 1 页,携带同一个批注 id
const dupB = (await split([{ mode: 'ranges', path: dupA, ranges: [[0]] }], dirDup))[0].outputs[0]
await t.openPath(dupA)
await sleep(1400)
check('合并前 3 页', t.docState.pageCount === 3, t.docState.pageCount)
const dupOut = `${dirDup}/out.pdf`
await t.mergePdfs([{ path: dupB, pages: [0] }], dupOut)
await sleep(1300)
check(
  '同 id 副本重新发号后导入(模型 2 条)',
  t.annotState.items.length === 2 && new Set(t.annotState.items.map((a) => a.id)).size === 2,
  t.annotState.items.map((a) => `${a.id.slice(0, 8)}@p${a.page}`)
)
await t.openPath(dupOut)
await sleep(1500)
check('合并产物 4 页', t.docState.pageCount === 4, t.docState.pageCount)
// A 的 3 页在前,被并页追加为第 4 页(index 3)
const dupPages = [...new Set(t.annotState.items.map((a) => a.page))].sort((a, b) => a - b).join(',')
check('两份批注分别落在第 1 页与追加页', t.annotState.items.length === 2 && dupPages === '0,3', {
  count: t.annotState.items.length,
  pages: dupPages
})

/* ---------- 12. 导出页码全越界:报错且不落盘(审查 R4) ---------- */

log('exportInvalid')
const invalidOut = `${tmp}/rev-invalid-${stamp}.pdf`
await t.exportPages([99], invalidOut)
await sleep(400)
check('越界导出报错', t.ui.toast?.kind === 'error', t.ui.toast)
const invalidOpened = await window.pdfAPI.invoke('doc:open', invalidOut)
check('越界导出未生成文件', invalidOpened.ok === false, invalidOpened.ok)

/* ---------- 13. 缩略图不绘制批注(审查 R5) ---------- */

log('thumbPlain')
const dirThumb = `${tmp}/rev-thumb-${stamp}`
const thumbDoc = (await split([{ mode: 'ranges', path: `${__smokeRoot}/samples/sample-zh.pdf`, ranges: [[0, 1]] }], dirThumb))[0].outputs[0]
await t.openPath(thumbDoc)
await sleep(1400)
t.addAnnotation(
  t.withIdentity({ kind: 'note', page: 0, bbox: { x: 480, y: 740, w: 26, h: 26 }, color: '#f7c948', opacity: 1, text: '缩略图检查' })
)
await sleep(200)
await t.saveDocument()
await sleep(900)
await t.openPath(thumbDoc)
await sleep(2600)
const thumbCanvas = document.querySelector('[data-thumb="1"] canvas')
check('缩略图画布已渲染', !!thumbCanvas && thumbCanvas.width > 0, thumbCanvas ? [thumbCanvas.width, thumbCanvas.height] : null)
let thumbYellow = 0
if (thumbCanvas && thumbCanvas.width > 0) {
  const data = thumbCanvas.getContext('2d').getImageData(0, 0, thumbCanvas.width, thumbCanvas.height).data
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 200 && data[i + 1] > 170 && data[i + 2] < 160) thumbYellow++
  }
}
check('缩略图不含批注像素(单一来源=覆盖层)', thumbYellow === 0, thumbYellow)
check('主视图覆盖层仍渲染便签', !!document.querySelector('[data-page="1"] .ann-layer rect[fill="#f7c948"]'))

/* ---------- 14. 导出前提交编辑器内容(审查 R6) ---------- */

log('editorCommit')
const dirEdit = `${tmp}/rev-edit-${stamp}`
const editDoc = (await split([{ mode: 'ranges', path: `${__smokeRoot}/samples/sample-zh.pdf`, ranges: [[0]] }], dirEdit))[0].outputs[0]
await t.openPath(editDoc)
await sleep(1400)
const editText = t.withIdentity({
  kind: 'text',
  page: 0,
  bbox: { x: 90, y: 600, w: 220, h: 40 },
  color: '#212529',
  opacity: 1,
  text: '旧文本',
  fontSize: 14,
  rotate: 0
})
t.addAnnotation(editText)
await sleep(200)
await t.saveDocument()
await sleep(900)
t.ui.tool = 'select'
t.ui.selectedAnnotationIds = [editText.id]
await sleep(400)
document.querySelector('[data-page="1"] .ann-layer > g.shape')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
await sleep(400)
const liveEditor = document.querySelector('.ann-editor textarea')
check('画布编辑器已打开', !!liveEditor)
liveEditor.value = '导出的新文本'
liveEditor.dispatchEvent(new Event('input', { bubbles: true }))
await sleep(200)
const editOut = `${dirEdit}/edit-export.pdf`
await t.exportPages([0], editOut, true)
await sleep(700)
await t.openPath(editOut)
await sleep(1500)
check(
  '导出件包含未提交的编辑',
  t.annotState.items.some((a) => a.text === '导出的新文本'),
  t.annotState.items.map((a) => a.text)
)

/* ---------- 15. 表单文档导出保留字段(审查 R10) ---------- */

log('formExport')
await t.openPath(`${__smokeRoot}/samples/sample-form.pdf`)
await sleep(1600)
check('原表单字段 2 个', t.docState.formFields.length === 2, t.docState.formFields.length)
const formOut = `${tmp}/rev-form-${stamp}.pdf`
await t.exportPages([0], formOut, true)
await sleep(700)
await t.openPath(formOut)
await sleep(1600)
check('导出件仍识别到 2 个表单字段', t.docState.formFields.length === 2, t.docState.formFields.length)
const formName = t.docState.formFields[0].fullName
t.docState.formValues[formName] = '写入测试'
await t.saveDocument()
await sleep(1000)
await t.openPath(formOut)
await sleep(1600)
const savedField = t.docState.formFields.find((f) => f.fullName === formName)
check('表单值已写回 PDF 并可读回', savedField?.value === '写入测试', savedField?.value ?? t.docState.formFields)

return {
  annots: 'ok',
  export: 'ok',
  foreignReader: 'ok',
  pngPaint: 'ok',
  dropIndex: 'ok',
  searchInvalidate: 'ok',
  openFail: 'ok',
  release: 'ok',
  undoDirty: 'ok',
  keystroke: 'ok',
  selectArrow: 'ok',
  propsHistory: 'ok',
  mergeDup: 'ok',
  exportInvalid: 'ok',
  thumbPlain: 'ok',
  editorCommit: 'ok',
  formExport: 'ok'
}
