// 步骤 29 冒烟:失败与降级路径 —— 打不开的文件、缺中文字体(依赖 PDF_EDITOR_SMOKE_CJK_FONT=none)、
// 无字体时 ASCII 仍可保存、环境自检随之显示「未找到」、保存到目录路径必然失败
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
const toast = () => t.ui.toast ?? { text: '', kind: '' }

/* ---------- 1. 打不开的文件 ---------- */
const opened = await t.openByPath(`${__smokeRoot}/tmp/__not_exists__.pdf`)
check('打开失败返回 false', opened === false, opened)
check('错误信息非空', typeof t.docState.loadError === 'string' && t.docState.loadError.length > 0, t.docState.loadError)

/* ---------- 2. 缺中文字体:保存中文批注必须失败且原因可读 ---------- */
await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1600)
t.addAnnotation(
  t.withIdentity({
    kind: 'text',
    page: 0,
    bbox: { x: 60, y: 700, w: 200, h: 40 },
    text: '缺字体测试',
    fontSize: 14,
    rotate: 0,
    color: '#212529',
    opacity: 1
  })
)
await sleep(300)
await t.saveDocument()
await sleep(1500)
check('缺字体提示可读', toast().text.includes('缺少可嵌入的中文字体'), toast().text)
check('提示为错误态', toast().kind === 'error', toast().kind)

/* ---------- 3. 同环境下纯 ASCII 批注仍可保存 ---------- */
// 样本自身可能带有历史中文文字批注(此前步骤写过的 sidecar 会被打开时恢复),
// 一并改成 ASCII,才能单独验证「缺字体不牵连 ASCII 内容」
for (const ann of t.annotState.items) {
  if (ann.kind === 'text') ann.text = 'ASCII only'
}
check('批注文本已全部改为 ASCII', t.exportAnnotations().filter((a) => a.kind === 'text').every((a) => !/[^\x00-\x7f]/.test(a.text ?? '')), t.exportAnnotations().map((a) => a.text))
await t.saveDocument()
await sleep(1500)
// 成功路径仍会带一条「缺字体」warning(该批注是文字类),因此以「非错误态 + 脏标记已清」为准
check(
  'ASCII 保存未报缺字体错误',
  !toast().text.includes('缺少可嵌入的中文字体'),
  { toast: toast().text, payload: t.exportAnnotations().map((a) => a.text) }
)
check('ASCII 保存为成功态', toast().kind !== 'error', toast().kind)
check('保存后脏标记已清', t.docState.dirty === false, t.docState.dirty)

/* ---------- 4. 环境自检随之显示「未找到」 ---------- */
document.querySelector('.toolbar button[title="关于 / 开源许可"]').click()
await sleep(1200)
const envText = document.querySelector('.mask .env-check')?.textContent ?? ''
check('环境自检显示字体缺失', envText.includes('未找到'), envText)
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await sleep(300)

/* ---------- 5. targetPath 指向目录:必然写失败并回传原因 ---------- */
const bad = await window.pdfAPI.invoke('save:saveAs', {
  docId: t.docState.docId,
  defaultPath: 'x.pdf',
  targetPath: `${__smokeRoot}/tmp`,
  annotations: t.exportAnnotations(),
  formValues: {},
  writeSidecar: false
})
check('写入目录失败', bad.ok === false, bad)
check('失败原因非空', typeof bad.error === 'string' && bad.error.length > 0, bad.error)

return {
  openMissing: 'ok',
  missingFont: 'ok',
  asciiStillWorks: 'ok',
  envCheck: 'ok',
  badTarget: 'ok'
}