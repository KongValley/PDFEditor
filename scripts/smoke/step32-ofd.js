// 步骤 32 冒烟:OFD 支持(导入转换 → 页数/页尺寸/文字 → 对话框导出 OFD → 重新导入闭环)。
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

const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const findButton = (root, text) => [...(root ?? document).querySelectorAll('button')].find((b) => textOf(b) === text)
const setInput = (el, value) => {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
const toastText = () => t.ui.toast?.text ?? ''

const ofdPath = `${__smokeRoot}\\samples\\sample-ofd.ofd`
const exportedOfd = `${__smokeRoot}\\tmp\\ofd-export.ofd`
const docReady = () => !!t.docState.pdfDoc && t.docState.pageBoxes.length === t.docState.pageCount

/** 用 pdf.js 读某页文字(与 step30 同法:直接走 doc:open 拿转换后的 PDF 字节) */
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

/** 读产物字节里的 ASCII 片段(latin1):用于断言 PDF 里有图片 XObject 等结构 */
async function latin1Of(path) {
  const opened = await window.pdfAPI.invoke('doc:open', path)
  const bytes = new Uint8Array(opened.buffer)
  let text = ''
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])
  if (opened.docId) await window.pdfAPI.invoke('doc:release', opened.docId)
  return text
}

/** 读某页的文字项(含 transform):用于校验 CTM 合成后的精确位置 */
async function readPageItems(path, pageNumber) {
  const opened = await window.pdfAPI.invoke('doc:open', path)
  if (!opened || !opened.buffer) throw new Error('读取产物失败:无 buffer')
  const doc = await t.pdfjs.getDocument({ data: opened.buffer }).promise
  try {
    const page = await doc.getPage(pageNumber)
    const content = await page.getTextContent()
    return content.items.filter((item) => item.str).map((item) => ({ str: item.str, transform: item.transform }))
  } finally {
    await doc.cleanup()
    if (opened.docId) await window.pdfAPI.invoke('doc:release', opened.docId)
  }
}

/* ============================ S1 打开 OFD ============================ */
await section('S1 打开 OFD 并转换', async () => {
  // 走 action 层(openPath)而不是 openByPath:转换提示 toast 由 action 层发出
  await t.openPath(ofdPath)
  must(await until(docReady, 20000), 'OFD 转换后文档未就绪')
  check('s1-pages', t.docState.pageCount === 2, t.docState.pageCount)
  check('s1-source-kind', t.docState.sourceKind === 'ofd', t.docState.sourceKind)
  check('s1-no-error', !t.docState.loadError, t.docState.loadError)
  // 源文件路径仍指向 .ofd(标题/状态栏/最近文件语义不变)
  check('s1-file-path', t.docState.filePath === ofdPath, t.docState.filePath)
  // 样例含「只声明签名引用、无呈现内容」的签章:必须如实告警(而不是静默丢)
  check('s1-warning-toast', /OFD 转换完成,有 \d+ 条提示/.test(toastText()), toastText())
  check(
    's1-warning-kind',
    t.docState.ofdWarnings.some((warning) => warning.includes('签章/注释只含签名引用')),
    t.docState.ofdWarnings
  )
  // 第 1 页 A4、第 2 页 A5:逐页 PhysicalBox 生效(±1pt)
  const first = t.docState.pageBoxes[0]
  const second = t.docState.pageBoxes[1]
  check('s1-page1-size', Math.abs(first.w - 595.28) < 1 && Math.abs(first.h - 841.89) < 1, first)
  check('s1-page2-size', Math.abs(second.w - 419.53) < 1 && Math.abs(second.h - 595.28) < 1, second)
  // 文字保留为真文本:ASCII 片段在缺中文字体的机器上也会画出来
  const items = await readPageItems(ofdPath, 1)
  const text = items.map((item) => item.str).join(' ')
  check('s1-text', text.includes('OFD-'), text.slice(0, 200))
  // CTM 缩放:TextCode X=200/Y=100 经 CTM(×0.3527778)后应落在 200pt / 页高-100pt
  const ctmItem = items.find((item) => item.str === 'CTM-TEXT')
  check(
    's1-ctm-position',
    !!ctmItem && Math.abs(ctmItem.transform[4] - 200) < 0.5 && Math.abs(ctmItem.transform[5] - (841.89 - 100)) < 0.5,
    ctmItem?.transform
  )
  // 签章:Appearance 里的图片被绘制进 PDF(正文图 + 签章图两张不同 PNG)
  const latin = await latin1Of(ofdPath)
  check('s1-seal-image', (latin.match(/\/Subtype \/Image/g) ?? []).length >= 2, '')
})

/* ============================ S2 对话框导出 OFD ============================ */
await section('S2 通过对话框导出 OFD', async () => {
  const button = findButton(null, '导出 OFD')
  must(!!button, '工具栏缺少「导出 OFD」按钮')
  button.click()
  must(await until(() => !!document.querySelector('.mask .dialog'), 8000), '导出 OFD 对话框未打开')
  const dialog = document.querySelector('.mask .dialog')
  check('s2-dialog-title', textOf(dialog.querySelector('.title')) === '导出 OFD', textOf(dialog.querySelector('.title')))
  // 模态期间文档级快捷键必须让位(keymap 的 modalOpen 已纳入本对话框)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true }))
  await sleep(120)
  check('s2-modal-guard', /请先关闭当前对话框/.test(toastText()), toastText())
  const rangeInput = dialog.querySelector('input:not([type="checkbox"])')
  const dpiSelect = dialog.querySelector('select')
  must(!!rangeInput && !!dpiSelect, '对话框缺少页码范围或分辨率控件')
  setInput(rangeInput, '1-2')
  await sleep(60)
  const exportButton = findButton(dialog, '导出')
  must(!!exportButton, '对话框缺少「导出」按钮')
  must(!exportButton.disabled, '「导出」在有效范围下被禁用')
  exportButton.click()
  must(await until(() => !document.querySelector('.mask .dialog'), 40000), '导出 OFD 对话框未在完成后关闭')
  check('s2-export-toast', /已导出 OFD/.test(toastText()), toastText())
  const reopened = await window.pdfAPI.invoke('doc:open', exportedOfd)
  check('s2-export-ok', !!reopened?.ok, reopened?.errorMessage ?? reopened?.error)
  check('s2-export-kind', reopened?.kind === 'ofd', reopened?.kind)
  check('s2-export-pages', reopened?.pageCount === 2, reopened?.pageCount)
  if (reopened?.docId) await window.pdfAPI.invoke('doc:release', reopened.docId)
})

/* ============================ S3 重新导入闭环 + 页码范围生效 ============================ */
await section('S3 重新导入导出的 OFD', async () => {
  // 走 action 层:这条路径没有告警,应给出「已把 OFD 转换为 PDF」提示
  await t.openPath(exportedOfd)
  must(await until(docReady, 20000), '导出的 OFD 重新打开失败')
  check('s3-convert-toast', /已把 OFD 转换为 PDF/.test(toastText()), toastText())
  check('s3-pages', t.docState.pageCount === 2, t.docState.pageCount)
  check('s3-source-kind', t.docState.sourceKind === 'ofd', t.docState.sourceKind)
  check('s3-page1-size', Math.abs(t.docState.pageBoxes[0].w - 595.28) < 1, t.docState.pageBoxes[0])
  // 图片页:PDF 里应有图片 XObject(读字节判定,不依赖渲染)
  const latin = await latin1Of(exportedOfd)
  check('s3-image-xobject', latin.includes('/Subtype /Image'), '')
  // 只导出第 2 页:产物页数为 1,且尺寸跟随该页(A5)
  await t.exportOfd({ pages: [1], dpi: 144, includeAnnotations: false })
  const single = await window.pdfAPI.invoke('doc:open', exportedOfd)
  check('s3-single-page', single?.pageCount === 1, single?.pageCount)
  if (single?.docId) await window.pdfAPI.invoke('doc:release', single.docId)
  await t.openByPath(exportedOfd)
  must(await until(docReady, 20000), '单页产物重新打开失败')
  check('s3-single-size', Math.abs(t.docState.pageBoxes[0].w - 419.53) < 1, t.docState.pageBoxes[0])
})

/* ============================ S4 不可见文本层 ============================ */
await section('S4 文本层可检索', async () => {
  await t.openByPath(ofdPath)
  must(await until(docReady, 20000), '重新打开 OFD 失败')
  // 带文本层导出:位图 + Alpha=0 文本,文字应能被重新读回。
  // 本应用自己的 OFD 导入按「逐字型」绘制 DeltaX 文本(无法用 pdf-lib 表达字间距),
  // 读回时 pdf.js 会把它拆成单字 item,故比较时忽略空白;真实 OFD 阅读器保留整段 TextCode。
  await t.exportOfd({ pages: [0], dpi: 144, includeAnnotations: false, textLayer: true })
  const withText = (await readPageText(exportedOfd, 1)).replace(/\s+/g, '')
  check('s4-text-roundtrip', withText.includes('CTM-TEXT') && withText.includes('OFD-'), withText.slice(0, 200))
  // 关掉文本层:同一页不再有可提取文字(只有位图)
  await t.exportOfd({ pages: [0], dpi: 144, includeAnnotations: false, textLayer: false })
  const withoutText = await readPageText(exportedOfd, 1)
  check('s4-text-optional', withoutText.trim() === '', withoutText.slice(0, 120))
  // 旋转页(/Rotate 90):同一份文档里第 1 页正常、第 2 页内容横躺 —— 一次导出两页,分别验证:
  // 第 1 页必须有文本层,第 2 页无文本层且要如实提示「旋转文字未生成文本层」
  const rotated = `${__smokeRoot}\\samples\\sample-rotated.pdf`
  await t.openByPath(rotated)
  must(await until(docReady, 20000), '打开旋转样例失败')
  await t.exportOfd({ pages: [0, 1], dpi: 144, includeAnnotations: false, textLayer: true })
  check('s4-rotated-warned', /旋转/.test(toastText()), toastText())
  const uprightText = await readPageText(exportedOfd, 1)
  check('s4-rotated-page1-text', uprightText.trim().length > 0, uprightText.slice(0, 120))
  const rotatedText = await readPageText(exportedOfd, 2)
  check('s4-rotated-page2-no-text', rotatedText.trim() === '', rotatedText.slice(0, 120))
})

/* ============================ S5 保存语义:OFD 源永不原地写回 ============================ */
await section('S5 OFD 源保存必须另存为 .pdf', async () => {
  await t.openPath(ofdPath)
  must(await until(docReady, 20000), '重新打开 OFD 失败')
  t.addAnnotation(
    t.withIdentity({
      kind: 'rect',
      page: 0,
      bbox: { x: 40, y: 700, w: 120, h: 60 },
      color: '#e03131',
      opacity: 1,
      thickness: 1.5
    })
  )
  await sleep(120)
  check('s4-dirty', t.docState.dirty === true, t.docState.dirty)
  // 保存对话框替身(STEP_ENV 已指向 tmp/dialog-ofd):默认名应为 <源名>.pdf,绝不能是 .ofd
  await t.saveDocument()
  must(await until(() => !t.docState.dirty, 15000), `保存未完成:${toastText()}`)
  const savedPath = t.docState.filePath ?? ''
  check('s4-saved-as-pdf', /\.pdf$/i.test(savedPath), savedPath)
  check('s4-not-ofd', !/\.ofd$/i.test(savedPath), savedPath)
  check('s4-source-kind-flipped', t.docState.sourceKind === 'pdf', t.docState.sourceKind)
  const info = await window.pdfAPI.invoke('smoke:fileInfo', savedPath)
  check('s4-file-exists', !!info?.exists && info.size > 0, info)
  // 源 .ofd 必须原样未动:重新读一遍仍能当 OFD 打开(页数不变)
  const source = await window.pdfAPI.invoke('doc:open', ofdPath)
  check('s4-source-intact', source?.ok && source?.kind === 'ofd' && source?.pageCount === 2, source?.pageCount)
  if (source?.docId) await window.pdfAPI.invoke('doc:release', source.docId)
})

/* ============================ S6 结果 ============================ */
if (failures.length > 0) {
  throw new Error(
    `OFD 冒烟失败 ${failures.length}/${checks.length}:` +
      failures.map((f) => `${f.name}${f.extra ? `(${f.extra})` : ''}`).join(';')
  )
}
return { checks: checks.length, failures: [] }
