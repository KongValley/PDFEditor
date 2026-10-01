// 步骤 5b 冒烟:加密文档检测 + sidecar-only 保存 + 页面操作拦截
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

await t.openPath(`${__smokeRoot}/samples/sample-encrypted.pdf`)
await sleep(1500)

check('识别为加密文档', t.docState.encrypted === true, t.docState.encrypted)
check('页数 1', t.docState.pageCount === 1, t.docState.pageCount)
const spans = document.querySelectorAll('.textLayer span').length
check('加密文档可正常渲染文本层', spans >= 1, spans)

// 加注释后保存 → 仅写 sidecar
t.addAnnotation(
  t.withIdentity({
    kind: 'highlight',
    page: 0,
    bbox: { x: 40, y: 110, w: 160, h: 24 },
    color: '#ffe066',
    opacity: 0.4
  })
)
const save = await window.pdfAPI.invoke('save:saveAs', {
  docId: t.docState.docId,
  defaultPath: 'saved-encrypted.pdf',
  targetPath: `${__smokeRoot}/tmp/saved-encrypted.pdf`,
  annotations: t.exportAnnotations(),
  formValues: {}
})
check('保存为 sidecar 模式', save.ok === true && save.mode === 'sidecar', save)

// 页面操作应被拒绝
const rotate = await window.pdfAPI.invoke('pageops:apply', {
  docId: t.docState.docId,
  op: { kind: 'rotate', pages: [0], delta: 90 }
})
check('加密文档拒绝页面操作', rotate.ok === false, rotate)

return { encrypted: t.docState.encrypted, saveMode: save.mode, rotateError: rotate.error, spans }
