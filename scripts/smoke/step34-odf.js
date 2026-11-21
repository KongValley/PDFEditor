// 步骤 34 冒烟:ODF(OpenDocument)导入 —— .odt/.ods/.odp 转换后进入编辑流程,
// 文字/表格/幻灯片可见且可检索,保存必须另存为 .pdf。
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (cond, timeout = 15000) => {
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
const toastText = () => t.ui.toast?.text ?? ''
const docReady = () => !!t.docState.pdfDoc && t.docState.pageBoxes.length === t.docState.pageCount

const root = __smokeRoot
const odtPath = `${root}\\samples\\sample-odt.odt`
const odsPath = `${root}\\samples\\sample-ods.ods`
const odpPath = `${root}\\samples\\sample-odp.odp`

/** 走 doc:open(会真正触发转换)读某页文字;这与打开对话框走同一条主进程路径 */
async function readPageText(path, pageNumber) {
  const opened = await window.pdfAPI.invoke('doc:open', path)
  if (!opened?.ok) throw new Error(`转换失败:${opened?.errorMessage ?? opened?.error}`)
  if (!opened.buffer) throw new Error('转换产物没有回传 buffer(stream=' + opened.stream + ')')
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

async function pdfInfo(path) {
  const opened = await window.pdfAPI.invoke('doc:open', path)
  if (!opened?.ok) throw new Error(`转换失败:${opened?.errorMessage ?? opened?.error}`)
  const info = {
    kind: opened.kind,
    pageCount: opened.pageCount,
    latin: '',
    pageSizes: []
  }
  if (!opened.buffer) return info
  const bytes = new Uint8Array(opened.buffer)
  // 只看结构里的 ASCII 片段(是否有图片 XObject),不必完整解码
  let latin = ''
  for (let i = 0; i < bytes.length; i++) latin += String.fromCharCode(bytes[i])
  info.latin = latin
  const doc = await t.pdfjs.getDocument({ data: opened.buffer }).promise
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const viewport = page.getViewport({ scale: 1 })
      info.pageSizes.push({ width: viewport.width, height: viewport.height })
    }
  } finally {
    await doc.cleanup()
  }
  if (opened.docId) await window.pdfAPI.invoke('doc:release', opened.docId)
  return info
}

/* ============================ S1 .odt 文字文档 ============================ */
await section('S1 打开 ODT', async () => {
  await t.openPath(odtPath)
  must(await until(docReady, 30000), 'ODT 转换后文档未就绪')
  check('s1-pages', t.docState.pageCount === 2, t.docState.pageCount)
  check('s1-source-kind', t.docState.sourceKind === 'odf', t.docState.sourceKind)
  check('s1-path', /\.odt$/i.test(t.docState.filePath ?? ''), t.docState.filePath)
  check('s1-toast', /已把 ODF 转换为 PDF|ODF 转换完成/.test(toastText()), toastText())
  check('s1-warning-toast', /ODF 转换完成,有 1 条提示/.test(toastText()), toastText())
  check(
    's1-header-warning',
    t.docState.ofdWarnings.some((warning) => warning.includes('页眉/页脚')),
    t.docState.ofdWarnings
  )
  const first = t.docState.pageBoxes[0]
  check('s1-page-size', Math.abs(first.w - 595.28) < 2 && Math.abs(first.h - 841.89) < 2, first)

  const text1 = (await readPageText(odtPath, 1)).replace(/\s+/g, '')
  check('s1-text-title', text1.includes('ODF导入冒烟'), text1.slice(0, 200))
  check('s1-text-body', text1.includes('列表第一项') && text1.includes('合并单元格'), text1.slice(0, 300))
  const text2 = (await readPageText(odtPath, 2)).replace(/\s+/g, '')
  check('s1-page2', text2.includes('ODT-PAGE-2'), text2.slice(0, 200))

  const info = await pdfInfo(odtPath)
  check('s1-image', info.latin.includes('/Subtype /Image'), '')
})

/* ============================ S2 .ods 表格文档 ============================ */
await section('S2 打开 ODS', async () => {
  await t.openPath(odsPath)
  must(await until(docReady, 30000), 'ODS 转换后文档未就绪')
  check('s2-pages', t.docState.pageCount === 2, t.docState.pageCount)
  check('s2-source-kind', t.docState.sourceKind === 'odf', t.docState.sourceKind)
  const text1 = (await readPageText(odsPath, 1)).replace(/\s+/g, '')
  check('s2-sheet1', text1.includes('苹果') && text1.includes('合计36元'), text1.slice(0, 300))
  const text2 = (await readPageText(odsPath, 2)).replace(/\s+/g, '')
  check('s2-sheet2', text2.includes('ODS-SHEET-2'), text2.slice(0, 200))
  const info = await pdfInfo(odsPath)
  check('s2-page-size', Math.abs(info.pageSizes[0].width - 595.28) < 2, info.pageSizes[0])
})

/* ============================ S3 .odp 演示文档 ============================ */
await section('S3 打开 ODP', async () => {
  await t.openPath(odpPath)
  must(await until(docReady, 30000), 'ODP 转换后文档未就绪')
  check('s3-pages', t.docState.pageCount === 2, t.docState.pageCount)
  check('s3-source-kind', t.docState.sourceKind === 'odf', t.docState.sourceKind)
  const text1 = (await readPageText(odpPath, 1)).replace(/\s+/g, '')
  check('s3-title', text1.includes('ODP演示标题'), text1.slice(0, 200))
  check('s3-shape-text', text1.includes('黄色形状'), text1.slice(0, 300))
  const text2 = (await readPageText(odpPath, 2)).replace(/\s+/g, '')
  check('s3-slide2', text2.includes('ODP-SLIDE-2'), text2.slice(0, 200))
  const info = await pdfInfo(odpPath)
  check(
    's3-landscape',
    Math.abs(info.pageSizes[0].width - 793.7) < 2 && Math.abs(info.pageSizes[0].height - 595.28) < 2,
    info.pageSizes[0]
  )
})

/* ============================ S4 保存语义:ODF 源永不原地写回 ============================ */
await section('S4 ODF 源保存必须另存为 .pdf', async () => {
  await t.openPath(odtPath)
  must(await until(docReady, 30000), '重新打开 ODT 失败')
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
  await t.saveDocument()
  must(await until(() => !t.docState.dirty, 20000), `保存未完成:${toastText()}`)
  const savedPath = t.docState.filePath ?? ''
  check('s4-saved-as-pdf', /\.pdf$/i.test(savedPath), savedPath)
  check('s4-not-odf', !/\.(odt|ods|odp)$/i.test(savedPath), savedPath)
  check('s4-source-kind-flipped', t.docState.sourceKind === 'pdf', t.docState.sourceKind)
  const info = await window.pdfAPI.invoke('smoke:fileInfo', savedPath)
  check('s4-file-exists', !!info?.exists && info.size > 0, info)
  // 源 .odt 必须原样未动:还能按 ODF 打开,页数不变
  const source = await window.pdfAPI.invoke('doc:open', odtPath)
  check('s4-source-intact', source?.ok && source?.kind === 'odf' && source?.pageCount === 2, {
    ok: source?.ok,
    kind: source?.kind,
    pages: source?.pageCount
  })
  if (source?.docId) await window.pdfAPI.invoke('doc:release', source.docId)
})

/* ============================ S5 终态:停在 ODP 首页(供人工看图) ============================ */
await section('S5 回到 ODP 首页', async () => {
  await t.openPath(odpPath)
  must(await until(docReady, 30000), '回到 ODP 失败')
  check('s5-source-kind', t.docState.sourceKind === 'odf', t.docState.sourceKind)
})

/* ============================ 结果 ============================ */
if (failures.length > 0) {
  throw new Error(
    `ODF 冒烟失败 ${failures.length}/${checks.length}:` +
      failures.map((f) => `${f.name}${f.extra ? `(${f.extra})` : ''}`).join(';')
  )
}
return { checks: checks.length, failures: [] }
