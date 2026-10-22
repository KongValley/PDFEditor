// 步骤 30 冒烟:单进程完整用户旅程(打开 → 搜索/注释/大纲 → 页面操作 → 保存 →
// 重启前回读 → 导出/提取 → 未保存守卫 → 大文件进度与搜索取消 → 阅读位置落盘)。
// 软断言聚合:一节失败不阻断后续节,结尾一次性报告全部失败项。
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (cond, timeout = 10000, label = 'condition') => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(50)
  }
  return false
}
const must = (cond, message) => {
  if (!cond) throw new Error(message)
}
const checks = []
const failures = []
const check = (name, cond, extra) => {
  checks.push(name)
  if (!cond) failures.push({ name, extra: extra === undefined ? '' : JSON.stringify(extra) })
}
const section = async (name, fn) => {
  try {
    await fn()
  } catch (err) {
    failures.push({ name, extra: err instanceof Error ? err.message : String(err) })
  }
}

const confirmAnswers = []
window.confirm = () => (confirmAnswers.length > 0 ? confirmAnswers.shift() : true)

const e2eDir = `${__smokeRoot}\\tmp\\e2e`
const dialogDir = `${e2eDir}\\dialog`
const openMe = `${dialogDir}\\open-me.pdf`
const formPath = `${e2eDir}\\form.pdf`
const largePath = `${__smokeRoot}\\tmp\\large.pdf`

const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const findButton = (root, text) =>
  [...(root ?? document).querySelectorAll('button')].find((b) => textOf(b) === text)
const clickButton = (root, text) => {
  const button = findButton(root, text)
  if (!button) throw new Error(`找不到按钮:${text}`)
  button.click()
  return button
}
const fire = (target, type, x, y) => {
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }))
}
const key = (target, value, options = {}) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }))
}
const toastText = () => t.ui.toast?.text ?? ''
const docReady = () => !!t.docState.pdfDoc && t.docState.pageBoxes.length === t.docState.pageCount
const rowInput = (dialog, label) => {
  const row = [...dialog.querySelectorAll('.row')].find((r) => textOf(r.querySelector('.label')) === label)
  return row?.querySelector('input, select') ?? null
}
const setInput = (el, value) => {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

async function readPageText(path, pageNumber) {
  const opened = await window.pdfAPI.invoke('doc:open', path)
  if (!opened || !opened.buffer) throw new Error('读取产物失败:无 buffer')
  const doc = await t.pdfjs.getDocument({ data: opened.buffer }).promise
  try {
    const page = await doc.getPage(pageNumber)
    const content = await page.getTextContent()
    return content.items.map((item) => item.str).join(' ')
  } finally {
    await doc.cleanup()
    if (opened.docId) await window.pdfAPI.invoke('doc:release', opened.docId)
  }
}

let expectedAnnotations = 0

/* ============================ S0 冷启动/空状态 ============================ */
await section('S0 冷启动/空状态', async () => {
  check('s0-no-document', !t.docState.pdfDoc, t.docState.pdfDoc ? '已有文档' : '')
  check('s0-empty-hint', textOf(document.querySelector('.empty-hint')).includes('打开或拖入'))
  check('s0-no-recent', document.querySelectorAll('.recent-item').length === 0)
  const toolbar = document.querySelector('.toolbar')
  for (const label of ['保存', '另存为', '导出图片', '打印']) {
    const button = findButton(toolbar, label)
    check(`s0-disabled-${label}`, !!button && button.disabled === true)
  }
  const tools = [...document.querySelectorAll('.toolbar-row')][1]?.querySelectorAll('button') ?? []
  check('s0-tools-disabled', tools.length >= 10 && [...tools].every((b) => b.disabled === true), tools.length)
})

/* ============================ S1 真实“打开”按钮 ============================ */
await section('S1 真实打开按钮', async () => {
  clickButton(document.querySelector('.toolbar'), '打开')
  const ready = await until(
    () => !!t.docState.pdfDoc && t.docState.pageBoxes.length === t.docState.pageCount && t.docState.pageCount === 3,
    25000
  )
  must(ready, '通过工具栏打开后文档未就绪')
  check('s1-page-count', t.docState.pageCount === 3, t.docState.pageCount)
  check('s1-path', t.docState.filePath.endsWith('open-me.pdf'), t.docState.filePath)
  check('s1-status-file', textOf(document.querySelector('.status-file')) === 'open-me.pdf', textOf(document.querySelector('.status-file')))
  check('s1-clean', t.docState.dirty === false, t.docState.dirty)
  must(await until(() => !!document.querySelector('[data-page="1"] .ann-layer')), '首页注释层未挂载')
  check('s1-first-page-rendered', true)
})

/* ============================ S2 搜索 UI ============================ */
await section('S2 搜索 UI', async () => {
  key(window, 'f', { ctrlKey: true })
  must(await until(() => !!document.querySelector('.search-bar .search-input')), '搜索栏未打开')
  const input = document.querySelector('.search-input')
  setInput(input, '编辑器')
  must(await until(() => t.searchState.results.length === 2, 15000), '搜索未得到 2 条命中')
  check('s2-counter-first', textOf(document.querySelector('.search-bar .counter')) === '1 / 2', textOf(document.querySelector('.search-bar .counter')))
  check('s2-current-first', t.searchState.current === 0, t.searchState.current)
  check('s2-highlights', document.querySelectorAll('.search-layer rect').length >= 2, document.querySelectorAll('.search-layer rect').length)
  key(input, 'Enter')
  await until(() => t.searchState.current === 1, 3000)
  check('s2-next-hit', t.searchState.current === 1, t.searchState.current)
  check('s2-counter-second', textOf(document.querySelector('.search-bar .counter')) === '2 / 2', textOf(document.querySelector('.search-bar .counter')))
  key(input, 'Escape')
  await sleep(120)
  check('s2-closed', t.ui.searchOpen === false, t.ui.searchOpen)
  check('s2-results-cleared', t.searchState.results.length === 0 && t.searchState.query === '', {
    results: t.searchState.results.length,
    query: t.searchState.query
  })
  check('s2-highlights-cleared', document.querySelectorAll('.search-layer rect').length === 0, document.querySelectorAll('.search-layer rect').length)
})

/* ============================ S3 文本选择 + 划选高亮 ============================ */
await section('S3 文本选择 + 划选高亮', async () => {
  t.scrollToPage(1)
  must(await until(() => t.docState.currentPage === 1, 5000), '无法回到第 1 页')
  must(
    await until(() => !!document.querySelector('[data-page="1"] .textLayer span'), 10000),
    '文本层未渲染'
  )
  const textLayer = document.querySelector('[data-page="1"] .textLayer')
  check('text-layer-selectable', getComputedStyle(textLayer).userSelect === 'text', getComputedStyle(textLayer).userSelect)

  // 通过主进程 webContents.sendInputEvent 发送真实鼠标拖拽,验证 Chromium 原生文本划选
  const candidates = [...textLayer.querySelectorAll('span')]
    .map((el) => ({ el, rect: el.getBoundingClientRect(), text: el.textContent.trim() }))
    .filter((item) => item.rect.width > 40 && item.rect.height > 6 && item.text.length > 3)
  must(candidates.length > 0, '文本层没有可拖选的长文本')
  const target = candidates[0]
  const from = { x: target.rect.left + 2, y: target.rect.top + target.rect.height / 2 }
  const to = { x: target.rect.right - 2, y: target.rect.top + target.rect.height / 2 }
  const drag = await window.pdfAPI.invoke('smoke:mouseDrag', { from, to, steps: 10 })
  check('mouse-drag-api', drag && drag.ok === true, drag)
  must(await until(() => (window.getSelection()?.toString() ?? '').trim().length > 0, 5000), '真实鼠标拖拽未产生文本选区')
  const nativeSelection = (window.getSelection()?.toString() ?? '').replace(/\s+/g, '')
  check('text-native-mouse-selection', nativeSelection.length >= 4, {
    selected: window.getSelection()?.toString() ?? '',
    target: target.text
  })

  clickButton(document.querySelector('.toolbar'), '高亮')
  const wrap = document.querySelector('[data-page="1"]')
  const box = wrap.getBoundingClientRect()
  fire(wrap, 'pointerdown', box.left + 80, box.top + 80)
  fire(wrap, 'pointerup', box.left + 90, box.top + 85)
  must(await until(() => t.annotState.items.some((a) => a.kind === 'highlight'), 5000), '划选未生成高亮')
  const highlightCount = t.annotState.items.filter((a) => a.kind === 'highlight').length
  check('s3-highlight-created', highlightCount >= 1, highlightCount)
})

/* ============================ S4 注释/属性/列表/撤销 ============================ */
await section('S4 注释/属性/列表/撤销', async () => {
  t.scrollToPage(1)
  must(await until(() => t.docState.currentPage === 1 && !!document.querySelector('[data-page="1"] .ann-layer'), 10000), '第 1 页未就绪')
  const before = t.annotState.items.length
  clickButton(document.querySelector('.toolbar'), '矩形')
  const wrap = document.querySelector('[data-page="1"]')
  const svg = wrap.querySelector('.ann-layer')
  must(!!svg, '注释层未挂载')
  const box = svg.getBoundingClientRect()
  fire(svg, 'pointerdown', box.left + 120, box.top + 120)
  fire(window, 'pointermove', box.left + 260, box.top + 220)
  fire(window, 'pointerup', box.left + 260, box.top + 220)
  must(await until(() => t.annotState.items.length === before + 1), '拖拽未创建矩形')
  const rect = t.annotState.items[t.annotState.items.length - 1]
  check('s4-rect-created', rect.kind === 'rect', rect.kind)
  check('s4-tool-reset', t.ui.tool === 'select', t.ui.tool)
  check('s4-shape-count', document.querySelectorAll('.ann-layer .shape').length >= before + 1, document.querySelectorAll('.ann-layer .shape').length)

  // 矩形绘制完成只回到选择工具,不会自动选中;从列表选中后才出现属性面板
  const initialRectRow = [...document.querySelectorAll('.ann-item')].find((row) => textOf(row.querySelector('.kind')) === '矩形')
  must(!!initialRectRow, '注释列表无矩形行')
  initialRectRow.click()
  await sleep(80)
  check('s4-selected', t.ui.selectedAnnotationIds.includes(rect.id), t.ui.selectedAnnotationIds)
  must(await until(() => !!document.querySelector('.props')), '属性面板未出现')
  const props = document.querySelector('.props')
  const swatches = props.querySelectorAll('.swatch')
  must(swatches.length >= 3, '色板数量不足')
  const colorBefore = t.annotState.items.find((a) => a.id === rect.id).color
  swatches[2].click()
  await sleep(50)
  const colorAfter = t.annotState.items.find((a) => a.id === rect.id).color
  check('s4-color-change', colorAfter !== colorBefore, { before: colorBefore, after: colorAfter })
  const opacity = props.querySelector('input[type="range"]')
  opacity.value = '0.5'
  opacity.dispatchEvent(new Event('input', { bubbles: true }))
  opacity.dispatchEvent(new Event('change', { bubbles: true }))
  await sleep(50)
  check('s4-opacity', t.annotState.items.find((a) => a.id === rect.id).opacity === 0.5, t.annotState.items.find((a) => a.id === rect.id).opacity)
  clickButton(props, '锁定')
  await sleep(60)
  check('s4-locked', t.annotState.items.find((a) => a.id === rect.id).locked === true, t.annotState.items.find((a) => a.id === rect.id).locked)
  clickButton(props, '解锁')

  clickButton(document.querySelector('.toolbar'), '文字')
  fire(svg, 'pointerdown', box.left + 320, box.top + 320)
  fire(window, 'pointerup', box.left + 320, box.top + 320)
  must(await until(() => !!document.querySelector('.ann-editor-input')), '文字编辑器未出现')
  const editor = document.querySelector('.ann-editor-input')
  editor.value = 'FLOW'
  editor.dispatchEvent(new Event('input', { bubbles: true }))
  editor.dispatchEvent(new Event('blur', { bubbles: true }))
  must(await until(() => t.annotState.items.some((a) => a.kind === 'text' && a.text === 'FLOW'), 5000), '文字注释未提交')
  check('s4-text-created', t.annotState.items.some((a) => a.kind === 'text' && a.text === 'FLOW'))

  // 列表选中矩形 → 复制/粘贴
  const rectRow = [...document.querySelectorAll('.ann-item')].find((row) => textOf(row.querySelector('.kind')) === '矩形')
  must(!!rectRow, '注释列表无矩形行')
  rectRow.click()
  await sleep(50)
  check('s4-list-select', t.ui.selectedAnnotationIds.includes(rect.id), t.ui.selectedAnnotationIds)
  const countBeforePaste = t.annotState.items.length
  key(window, 'c', { ctrlKey: true })
  key(window, 'v', { ctrlKey: true })
  must(await until(() => t.annotState.items.length === countBeforePaste + 1, 5000), '粘贴未新增注释')
  const pasted = t.annotState.items[t.annotState.items.length - 1]
  check('s4-paste-kind', pasted.kind === 'rect', pasted.kind)
  check('s4-paste-offset', Math.abs(pasted.bbox.x - rect.bbox.x - 12) < 0.6 && Math.abs(pasted.bbox.y - rect.bbox.y - 12) < 0.6, {
    from: rect.bbox,
    to: pasted.bbox
  })

  // 列表筛选/删除/撤销/重做
  const selects = document.querySelectorAll('.ann-list .filters select')
  must(selects.length === 2, '注释列表筛选缺失')
  setInput(selects[0], 'all')
  setInput(selects[1], 'rect')
  await sleep(80)
  const rectRows = [...document.querySelectorAll('.ann-item')]
  check('s4-filter-rect', rectRows.length >= 2, rectRows.length)
  const target = rectRows[0]
  target.click()
  await sleep(50)
  const selectedId = t.ui.selectedAnnotationIds[0]
  check(
    's4-row-select',
    !!selectedId && t.annotState.items.find((a) => a.id === selectedId)?.kind === 'rect',
    t.ui.selectedAnnotationIds
  )
  const beforeDelete = t.annotState.items.length
  target.querySelector('.del').click()
  must(await until(() => t.annotState.items.length === beforeDelete - 1, 3000), '列表删除未生效')
  key(window, 'z', { ctrlKey: true })
  must(await until(() => t.annotState.items.length === beforeDelete, 5000), '撤销未恢复注释')
  key(window, 'y', { ctrlKey: true })
  must(await until(() => t.annotState.items.length === beforeDelete - 1, 5000), '重做未删除注释')
  key(window, 'z', { ctrlKey: true })
  must(await until(() => t.annotState.items.length === beforeDelete, 5000), '二次撤销未恢复注释')

  const kinds = new Set(t.annotState.items.map((a) => a.kind))
  check('s4-kinds', kinds.has('highlight') && kinds.has('rect') && kinds.has('text'), [...kinds])
  expectedAnnotations = t.annotState.items.length
})

/* ============================ S5 大纲编辑 ============================ */
await section('S5 大纲编辑', async () => {
  clickButton(document.querySelector('.right-panel .tabs'), '大纲')
  must(await until(() => !!document.querySelector('.outline')), '大纲面板未出现')
  clickButton(document.querySelector('.outline'), '+ 书签')
  must(await until(() => !!document.querySelector('.outline .edit-input')), '书签输入框未出现')
  const input = document.querySelector('.outline .edit-input')
  setInput(input, 'FLOW-BOOKMARK')
  key(input, 'Enter')
  must(await until(() => t.docState.outline.some((n) => n.title === 'FLOW-BOOKMARK'), 8000), '新增书签未生效')

  const rowOf = (title) =>
    [...document.querySelectorAll('.outline .node-row')].find((row) => textOf(row.querySelector('.title')) === title)
  const row = rowOf('FLOW-BOOKMARK')
  must(!!row, '书签行未渲染')
  clickButton(row, '改')
  must(await until(() => !!document.querySelector('.outline .edit-input')), '重命名输入框未出现')
  const renameInput = document.querySelector('.outline .edit-input')
  setInput(renameInput, 'FLOW-BOOKMARK2')
  key(renameInput, 'Enter')
  must(await until(() => t.docState.outline.some((n) => n.title === 'FLOW-BOOKMARK2'), 8000), '重命名书签未生效')

  const row2 = rowOf('FLOW-BOOKMARK2')
  must(!!row2, '重命名后的书签行未渲染')
  confirmAnswers.push(false)
  clickButton(row2, '删')
  await sleep(250)
  check('s5-delete-cancel-keeps', t.docState.outline.some((n) => n.title === 'FLOW-BOOKMARK2'), t.docState.outline.map((n) => n.title))
  row2.querySelector('.title').click()
  await until(() => t.docState.currentPage === 1, 4000)
  check('s5-bookmark-jump', t.docState.currentPage === 1, t.docState.currentPage)
})

/* ============================ S6 水印/页码反馈 ============================ */
await section('S6 水印/页码反馈', async () => {
  const thumbs = document.querySelector('.pages-toolbar')
  must(!!thumbs, '缩略图工具栏缺失')
  clickButton(thumbs, '水印')
  must(await until(() => t.ui.watermarkDialog.open && !!document.querySelector('.mask .dialog')), '水印对话框未打开')
  let dialog = document.querySelector('.mask .dialog')
  setInput(dialog.querySelector('input'), '1')
  const textInput = rowInput(dialog, '文本')
  setInput(textInput, 'FLOW-MARK')
  const dirtyBefore = t.docState.dirty
  const cancelButton = findButton(dialog, '取消')
  cancelButton.focus()
  key(cancelButton, 'Enter')
  await sleep(300)
  check('enter-on-cancel-no-confirm', t.ui.watermarkDialog.open === true, t.ui.watermarkDialog.open)
  check('enter-on-cancel-no-dirty', t.docState.dirty === dirtyBefore, t.docState.dirty)
  if (!t.ui.watermarkDialog.open) {
    // 基线(修复前)会误确认:等操作结束并撤销,重新打开对话框继续后续检查
    await until(() => t.ui.busy === null, 15000)
    await t.undo()
    await sleep(200)
    clickButton(document.querySelector('.pages-toolbar'), '水印')
    must(await until(() => t.ui.watermarkDialog.open, 5000), '水印对话框重新打开失败')
    dialog = document.querySelector('.mask .dialog')
  }

  const failed = await t.addWatermark({
    pages: [0],
    text: '',
    fontSize: 48,
    opacity: 0.15,
    rotation: 45,
    tile: false,
    color: '#e03131'
  })
  check('s6-empty-watermark-rejected', failed === false, failed)
  await until(() => t.ui.problems.some((p) => p.title === '添加水印失败'), 5000)
  check('pageop-failure-problem', t.ui.problems.some((p) => p.title === '添加水印失败'), t.ui.problems.map((p) => p.title))
  const toast = document.querySelector('.toast')
  const mask = document.querySelector('.mask')
  check('toast-above-dialog', !!toast && !!mask && parseInt(getComputedStyle(toast).zIndex, 10) > parseInt(getComputedStyle(mask).zIndex, 10), {
    toast: toast ? getComputedStyle(toast).zIndex : 'none',
    mask: mask ? getComputedStyle(mask).zIndex : 'none'
  })
  clickButton(document.querySelector('.mask .dialog'), '取消')
  await sleep(100)

  clickButton(document.querySelector('.pages-toolbar'), '水印')
  must(await until(() => t.ui.watermarkDialog.open, 5000), '水印对话框未重新打开')
  dialog = document.querySelector('.mask .dialog')
  setInput(dialog.querySelector('input'), '1')
  setInput(rowInput(dialog, '文本'), 'FLOW-MARK')
  clickButton(dialog, '确定')
  check('watermark-running-state', t.ui.watermarkDialog.running === true, t.ui.watermarkDialog.running)
  check('watermark-busy', t.ui.busy === '正在添加水印…', t.ui.busy)
  must(
    await until(
      () => toastText().startsWith('已添加水印') && !t.ui.watermarkDialog.open && t.ui.busy === null,
      8000
    ),
    '水印成功提示/关闭缺失'
  )
  check('watermark-success-toast', toastText().startsWith('已添加水印'), toastText())

  clickButton(document.querySelector('.pages-toolbar'), '页码')
  must(await until(() => t.ui.pageNumberDialog.open, 5000), '页码对话框未打开')
  dialog = document.querySelector('.mask .dialog')
  setInput(dialog.querySelector('input'), '1')
  const formatSelect = rowInput(dialog, '格式')
  setInput(formatSelect, '1 / N')
  clickButton(dialog, '确定')
  check('page-number-running-state', t.ui.pageNumberDialog.running === true, t.ui.pageNumberDialog.running)
  check('page-number-busy', t.ui.busy === '正在添加页码…', t.ui.busy)
  must(
    await until(
      () => toastText().startsWith('已添加页码') && !t.ui.pageNumberDialog.open && t.ui.busy === null,
      8000
    ),
    '页码成功提示缺失'
  )
  check('page-number-success-toast', toastText().startsWith('已添加页码'), toastText())
})

/* ============================ S7 页面选择/旋转/删除/插入 ============================ */
await section('S7 页面选择/旋转/删除/插入', async () => {
  const thumbChecks = document.querySelectorAll('.thumb-check')
  must(thumbChecks.length >= 2, '缩略图选择框不足')
  thumbChecks[0].click()
  thumbChecks[1].click()
  await sleep(80)
  check('s7-selected-two', document.querySelectorAll('.thumb.selected').length === 2, document.querySelectorAll('.thumb.selected').length)

  const original = { w: t.docState.pageBoxes[0].w, h: t.docState.pageBoxes[0].h }
  clickButton(document.querySelector('.pages-toolbar'), '右旋')
  check('rotate-busy', t.ui.busy === '正在旋转页面…', t.ui.busy)
  must(await until(() => t.ui.busy === null, 20000), '旋转未结束')
  must(await until(docReady, 15000), '旋转后页面几何未就绪')
  check('s7-rotated', Math.abs(t.docState.pageBoxes[0].w - original.h) < 1 && Math.abs(t.docState.pageBoxes[0].h - original.w) < 1, {
    before: original,
    after: t.docState.pageBoxes[0]
  })
  key(window, 'z', { ctrlKey: true })
  must(
    await until(
      () => Math.abs(t.docState.pageBoxes[0].w - original.w) < 1 && Math.abs(t.docState.pageBoxes[0].h - original.h) < 1 && docReady() && t.annotState.items.length === expectedAnnotations,
      10000
    ),
    '撤销旋转未恢复几何/注释'
  )
  check('s7-annotations-after-rotate', t.annotState.items.length === expectedAnnotations, t.annotState.items.length)

  const pageCount = t.docState.pageCount
  confirmAnswers.push(false)
  clickButton(document.querySelector('.pages-toolbar'), '删除')
  await sleep(300)
  check('delete-cancel-keeps-selection', t.docState.pageCount === pageCount && document.querySelectorAll('.thumb.selected').length === 2, {
    pages: t.docState.pageCount,
    selected: document.querySelectorAll('.thumb.selected').length
  })

  confirmAnswers.push(true)
  clickButton(document.querySelector('.pages-toolbar'), '删除')
  must(
    await until(() => t.docState.pageCount === pageCount - 2 && toastText().startsWith('已删除'), 15000),
    `删除页面未生效(${t.docState.pageCount}/${toastText()})`
  )
  check('s7-deleted-toast', toastText().startsWith('已删除'), toastText())
  check('s7-selection-cleared', document.querySelectorAll('.thumb.selected').length === 0, document.querySelectorAll('.thumb.selected').length)
  key(window, 'z', { ctrlKey: true })
  must(
    await until(
      () => t.docState.pageCount === pageCount && docReady() && t.annotState.items.length === expectedAnnotations,
      15000
    ),
    '撤销删除未恢复页数/注释'
  )
  check('s7-annotations-after-delete', t.annotState.items.length === expectedAnnotations, t.annotState.items.length)

  clickButton(document.querySelector('.pages-toolbar'), '空白页')
  must(await until(() => t.docState.pageCount === pageCount + 1 && docReady(), 15000), '插入空白页未生效')
  key(window, 'z', { ctrlKey: true })
  must(
    await until(
      () => t.docState.pageCount === pageCount && docReady() && t.annotState.items.length === expectedAnnotations,
      15000
    ),
    '撤销插入未恢复页数/注释'
  )
  check('s7-annotations-after-insert', t.annotState.items.length === expectedAnnotations, t.annotState.items.length)
})

/* ============================ S8 合并/拆分包含语义 ============================ */
await section('S8 合并/拆分包含语义', async () => {
  must(await until(docReady, 15000), '页面几何未就绪,缩略图工具栏未挂载')
  clickButton(document.querySelector('.pages-toolbar'), '合并')
  must(await until(() => t.mergeDialogState.open, 5000), '合并对话框未打开')
  must(
    await until(() => textOf(document.querySelector('.mask .dialog .title')) === '合并页面', 5000),
    '合并对话框 DOM 未挂载'
  )
  const mergeDialog = document.querySelector('.mask .dialog')
  clickButton(mergeDialog, '+ 添加文件')
  must(await until(() => t.mergeDialogState.rows.length === 2, 15000), '合并对话框未加入第二行')
  const extraPages = t.mergeDialogState.rows[1].pageCount
  const totalText = () => textOf(mergeDialog.querySelector('.total'))
  check('merge-total-includes-checked', totalText() === `共 ${3 + extraPages} 页`, totalText())
  const rows = mergeDialog.querySelectorAll('.row-wrap')
  const extraCheck = rows[1].querySelector('input[type="checkbox"]')
  extraCheck.checked = false
  extraCheck.dispatchEvent(new Event('change', { bubbles: true }))
  await sleep(80)
  check('merge-uncheck-updates-total', totalText() === '共 3 页', totalText())
  const mergePrimary = findButton(mergeDialog, '开始合并')
  check('merge-uncheck-disables-start', !!mergePrimary && mergePrimary.disabled === true, mergePrimary?.disabled)
  extraCheck.checked = true
  extraCheck.dispatchEvent(new Event('change', { bubbles: true }))
  await sleep(80)
  check('merge-recheck-enables', !!mergePrimary && mergePrimary.disabled === false, mergePrimary?.disabled)
  clickButton(mergeDialog, '取消')
  await until(() => !t.mergeDialogState.open, 3000)
  await sleep(100)

  clickButton(document.querySelector('.pages-toolbar'), '拆分')
  must(await until(() => t.splitDialogState.open && t.splitDialogState.rows.length === 1, 5000), '拆分对话框未打开')
  try {
    const splitTitles = () => [...document.querySelectorAll('.mask .dialog .title')].map(textOf)
    must(
      await until(() => splitTitles().includes('拆分页面'), 15000),
      `拆分对话框 DOM 未挂载(titles=${JSON.stringify(splitTitles())}, masks=${document.querySelectorAll('.mask').length})`
    )
    const splitDialog = document.querySelector('.mask .dialog')
    clickButton(splitDialog, '+ 添加文件')
    must(await until(() => t.splitDialogState.rows.length === 2, 15000), '拆分对话框未加入第二行')
    const splitChecks = splitDialog.querySelectorAll('.row-wrap input[type="checkbox"]')
    const splitPrimary = () => findButton(splitDialog, '开始拆分')
    splitChecks[0].checked = false
    splitChecks[0].dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(80)
    check('split-uncheck-current', !!splitPrimary() && splitPrimary().disabled === false, splitPrimary()?.disabled)
    splitChecks[1].checked = false
    splitChecks[1].dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(80)
    check('split-uncheck-all-disables', !!splitPrimary() && splitPrimary().disabled === true, splitPrimary()?.disabled)
    splitChecks[0].checked = true
    splitChecks[0].dispatchEvent(new Event('change', { bubbles: true }))
    splitChecks[1].checked = true
    splitChecks[1].dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(50)
    check(
      's8-remove-selected-label',
      [...splitDialog.querySelectorAll('.list-foot button')].some((b) => textOf(b).startsWith('移除选中')),
      [...splitDialog.querySelectorAll('.list-foot button')].map(textOf)
    )
    clickButton(splitDialog, '取消')
    await sleep(100)
  } finally {
    // 任一步失败都关闭拆分对话框,避免模态守卫把后续 Ctrl+E/Ctrl+F 全部吞掉
    t.splitDialogState.open = false
  }
})

/* ============================ S9 对话框键盘与 Ctrl+O ============================ */
await section('S9 对话框键盘与 Ctrl+O', async () => {
  must(await until(docReady, 15000), '页面几何未就绪')
  key(window, 's', { ctrlKey: true })
  await sleep(100)
  must(await until(() => toastText().startsWith('已保存') && t.ui.busy === null, 20000), '保存未完成')
  clickButton(document.querySelector('.pages-toolbar'), '合并')
  must(await until(() => t.mergeDialogState.open, 5000), '合并对话框未打开')
  const docId = t.docState.docId
  key(window, 'o', { ctrlKey: true })
  await until(() => t.docState.docId !== docId, 2000)
  check('ctrl-o-blocked-by-modal', t.docState.docId === docId, { before: docId, after: t.docState.docId })
  check('ctrl-o-modal-stays-open', t.mergeDialogState.open === true, t.mergeDialogState.open)
  key(window, 'Escape')
  await sleep(300)
  check('esc-closes-merge', t.mergeDialogState.open === false, {
    open: t.mergeDialogState.open,
    splitOpen: t.splitDialogState.open,
    busy: t.ui.busy,
    active: document.activeElement?.tagName ?? '?'
  })
  if (t.mergeDialogState.open) clickButton(document.querySelector('.mask .dialog'), '取消')
  await sleep(100)
})

/* ============================ S10 保存与持久化回读 ============================ */
await section('S10 保存与持久化回读', async () => {
  key(window, 's', { ctrlKey: true })
  await sleep(100)
  must(await until(() => toastText().startsWith('已保存') && t.docState.dirty === false && t.ui.busy === null, 20000), '保存未完成')
  check('s10-save-clean', t.docState.dirty === false, t.docState.dirty)
  check('s10-save-path', t.docState.filePath.endsWith('open-me.pdf'), t.docState.filePath)
  await t.openPath(openMe)
  check('s10-annotations-restored', t.annotState.items.length === expectedAnnotations, t.annotState.items.length)
  check('s10-text-restored', t.annotState.items.some((a) => a.kind === 'text' && a.text === 'FLOW'), t.annotState.items.filter((a) => a.kind === 'text').map((a) => a.text))
  check('s10-outline-restored', t.docState.outline.some((n) => n.title === 'FLOW-BOOKMARK2'), t.docState.outline.map((n) => n.title))
  const pageText = await readPageText(openMe, 1)
  check('s10-watermark-persisted', pageText.includes('FLOW-MARK'), pageText.slice(0, 300))
  check('s10-pagenumber-persisted', pageText.includes('1 / 3'), pageText.slice(0, 300))

  await t.openPath(formPath)
  must(await until(() => t.docState.formFields.length >= 2, 10000), '表单字段未发现')
  const textInput = document.querySelector('.form-layer input[type="text"]')
  const checkInput = document.querySelector('.form-layer input[type="checkbox"]')
  must(!!textInput && !!checkInput, '表单控件未渲染')
  setInput(textInput, 'FLOW-FORM')
  checkInput.checked = true
  checkInput.dispatchEvent(new Event('change', { bubbles: true }))
  await sleep(80)
  check('s10-form-dirty', t.docState.dirty === true, t.docState.dirty)
  key(window, 's', { ctrlKey: true })
  await sleep(100)
  must(await until(() => toastText().startsWith('已保存') && t.ui.busy === null, 20000), '表单保存未完成')
  await t.openPath(formPath)
  const restoredText = t.docState.formFields.find((f) => f.type === 'text')
  const restoredCheck = t.docState.formFields.find((f) => f.type === 'checkbox')
  check('s10-form-text-restored', restoredText?.value === 'FLOW-FORM', restoredText?.value)
  check('s10-form-check-restored', restoredCheck?.value === true, restoredCheck?.value)
  await t.openPath(openMe)
})

/* ============================ S11 导出/提取产物 ============================ */
await section('S11 导出/提取产物', async () => {
  key(window, 'e', { ctrlKey: true })
  must(await until(() => toastText().startsWith('已导出图片:'), 20000), '导出图片无提示')
  const pngPath = toastText().slice('已导出图片:'.length).trim()
  const pngInfo = await window.pdfAPI.invoke('smoke:fileInfo', pngPath)
  check('s11-png-exists', pngInfo.exists === true && pngInfo.size > 0, pngInfo)

  const clear = findButton(document.querySelector('.pages-toolbar'), '清空')
  if (clear && !clear.disabled) clear.click()
  clickButton(document.querySelector('.pages-toolbar'), '提取')
  must(
    await until(() => textOf(document.querySelector('.mask .dialog .title')) === '提取页面', 5000),
    '提取对话框未打开'
  )
  const dialog = document.querySelector('.mask .dialog')
  setInput(dialog.querySelector('input'), '2')
  await sleep(80)
  const confirmButton = findButton(dialog, '确定')
  must(!!confirmButton && confirmButton.disabled === false, '提取范围未通过校验')
  confirmButton.click()
  must(await until(() => toastText().startsWith('已提取 1 页:'), 20000), `提取无成功提示:${toastText()}`)
  const extractedPath = toastText().slice('已提取 1 页:'.length).trim()
  const info = await window.pdfAPI.invoke('smoke:fileInfo', extractedPath)
  check('s11-extract-exists', info.exists === true && info.size > 0, info)
  const counts = await window.pdfAPI.invoke('pdf:pageCounts', [extractedPath])
  check('s11-extract-pages', Array.isArray(counts) && counts[0]?.pageCount === 1, counts)
})

/* ============================ S12 未保存更改守卫 ============================ */
await section('S12 未保存更改守卫', async () => {
  const rotateButton = document.querySelector('.status-bar button[title^="右旋当前页"]')
  must(!!rotateButton, '状态栏右旋按钮缺失')
  rotateButton.click()
  must(await until(() => t.docState.dirty === true && t.ui.busy === null, 15000), '旋转未置脏')
  const docId = t.docState.docId
  confirmAnswers.push(false)
  clickButton(document.querySelector('.toolbar'), '打开')
  await sleep(600)
  check('s12-cancel-keeps-doc', t.docState.docId === docId && t.docState.dirty === true, { docId: t.docState.docId, dirty: t.docState.dirty })
  confirmAnswers.push(true)
  clickButton(document.querySelector('.toolbar'), '打开')
  must(await until(() => t.docState.docId !== docId && t.docState.dirty === false && t.docState.pageCount === 3, 25000), '确认放弃后未打开新文档')
  check('s12-confirm-opens', t.docState.filePath.endsWith('open-me.pdf') && t.docState.pageCount === 3, { path: t.docState.filePath, pages: t.docState.pageCount })
})

/* ============================ S13 打开进度/搜索取消/阅读位置 ============================ */
await section('S13 打开进度/搜索取消/阅读位置', async () => {
  const opening = t.openByPath(largePath)
  const loadingVisible = await until(
    () => !!document.querySelector('.status-loading') && !!document.querySelector('.status-cancel'),
    5000
  )
  check('status-loading-visible', loadingVisible, {
    text: textOf(document.querySelector('.status-loading')),
    cancel: !!document.querySelector('.status-cancel')
  })
  check('status-loading-text', textOf(document.querySelector('.status-loading')).includes('正在'), textOf(document.querySelector('.status-loading')))
  const opened = await opening
  must(opened === true && t.docState.pageCount === 400, `大文档打开失败:${t.docState.pageCount}`)
  t.scrollToPage(3)
  must(await until(() => t.docState.currentPage === 3, 5000), '大文档无法定位第 3 页')

  key(window, 'f', { ctrlKey: true })
  must(await until(() => !!document.querySelector('.search-input'), 3000), '搜索栏未打开')
  const input = document.querySelector('.search-input')
  setInput(input, 'page')
  const sawSearching = await until(() => t.searchState.searching === true, 3000)
  if (sawSearching) {
    key(input, 'Escape')
    await until(() => t.searchState.searching === false, 15000)
    await sleep(1500)
    check('search-close-no-jump', t.ui.searchOpen === false && t.searchState.results.length === 0 && t.docState.currentPage === 3, {
      open: t.ui.searchOpen,
      results: t.searchState.results.length,
      page: t.docState.currentPage
    })
  } else {
    checks.push('search-race-skipped')
    key(input, 'Escape')
    await sleep(200)
    check('search-close-clears', t.searchState.results.length === 0, t.searchState.results.length)
  }

  await t.openPath(openMe)
  t.scrollToPage(3)
  must(await until(() => t.docState.currentPage === 3, 5000), '重开旅程文档后无法定位第 3 页')
  const recentSaved = await until(async () => {
    const info = await window.pdfAPI.invoke('app:recentGet', openMe)
    return info && info.page === 3
  }, 8000)
  check('s13-recent-page', recentSaved, await window.pdfAPI.invoke('app:recentGet', openMe))
  check('s13-final-clean', t.docState.dirty === false, t.docState.dirty)
})

/* ============================ S14 结果 ============================ */
if (failures.length > 0) {
  throw new Error(
    `全流程失败 ${failures.length}/${checks.length}:` +
      failures.map((f) => `${f.name}${f.extra ? `(${f.extra})` : ''}`).join(';')
  )
}
return { checks: checks.length, failures: [] }
