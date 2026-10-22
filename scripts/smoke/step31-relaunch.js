// 步骤 31 冒烟:复用 step30 的 user-data-dir,验证重启后的最近文件、阅读位置、
// 注释/大纲/水印回读与窗口状态。与 step30 一样使用软断言聚合。
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (cond, timeout = 10000) => {
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
const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const toastText = () => t.ui.toast?.text ?? ''

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

try {
  must(await until(() => !!document.querySelector('.recent-item'), 10000), '最近文件列表未出现')
  const recent = await window.pdfAPI.invoke('app:recentList')
  const entry = (recent ?? []).find((item) => String(item.path).endsWith('open-me.pdf'))
  must(!!entry, '最近文件缺少 open-me.pdf')
  const expectedPage = entry.page
  check('s31-recent-page-saved', expectedPage > 1, expectedPage)

  const item = [...document.querySelectorAll('.recent-item')].find((el) =>
    textOf(el.querySelector('.recent-name')) === 'open-me.pdf'
  )
  must(!!item, '最近文件行未渲染')
  t.setRestoreLastPage(true)
  item.click()

  must(await until(() => t.docState.pageCount === 3, 25000), '最近文件打开失败')
  must(await until(() => t.docState.currentPage === expectedPage, 10000), `未恢复到第 ${expectedPage} 页`)
  check('s31-restored-page', t.docState.currentPage === expectedPage, t.docState.currentPage)
  check('s31-status-file', textOf(document.querySelector('.status-file')) === 'open-me.pdf', textOf(document.querySelector('.status-file')))
  check('s31-no-dirty', !document.querySelector('.status-dirty') && t.docState.dirty === false, t.docState.dirty)
  must(await until(() => !!document.querySelector(`[data-page="${expectedPage}"] .ann-layer`)), '恢复页注释层未挂载')
  check('s31-page-rendered', true)
  await until(() => toastText().includes('已回到上次阅读位置'), 5000)
  check('s31-restore-toast', toastText().includes('已回到上次阅读位置'), toastText())
  check('s31-annotations', t.annotState.items.length > 0, t.annotState.items.length)
  check('s31-text-annotation', t.annotState.items.some((a) => a.kind === 'text' && a.text === 'FLOW'), t.annotState.items.filter((a) => a.kind === 'text').map((a) => a.text))
  check('s31-outline', t.docState.outline.some((n) => n.title === 'FLOW-BOOKMARK2'), t.docState.outline.map((n) => n.title))
  const pageText = await readPageText(entry.path, 1)
  check('s31-watermark', pageText.includes('FLOW-MARK'), pageText.slice(0, 300))
} catch (err) {
  failures.push({ name: 'S31 重启回读', extra: err instanceof Error ? err.message : String(err) })
}

if (failures.length > 0) {
  throw new Error(
    `全流程失败 ${failures.length}/${checks.length}:` +
      failures.map((f) => `${f.name}${f.extra ? `(${f.extra})` : ''}`).join(';')
  )
}
return { checks: checks.length, failures: [] }
