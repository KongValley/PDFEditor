// 步骤 6 冒烟:表单字段发现、覆盖层填写、写回 PDF 并重新读取校验
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

const root = 'F:/DeepSeek工作区/pdf编辑器'
await t.openPath(`${root}/samples/sample-form.pdf`)
await sleep(1800)

const fields = t.docState.formFields
check('发现 2 个表单字段', fields.length === 2, fields.map((f) => `${f.name}:${f.type}`))
const nameField = fields.find((f) => f.name === 'name')
const agreeField = fields.find((f) => f.name === 'agree')
check('文本字段解析', !!nameField && nameField.type === 'text' && nameField.fullName === 'name', nameField)
check('复选框字段解析', !!agreeField && agreeField.type === 'checkbox', agreeField)

// 覆盖层控件已渲染
const controls = document.querySelectorAll('.form-layer .form-control')
check('表单控件已渲染', controls.length === 2, controls.length)

// 模拟用户填写
const textInput = document.querySelector('.form-layer input[type="text"]')
const checkbox = document.querySelector('.form-layer input[type="checkbox"]')
check('文本控件存在', !!textInput, null)
textInput.value = '张三'
textInput.dispatchEvent(new Event('input', { bubbles: true }))
checkbox.checked = true
checkbox.dispatchEvent(new Event('change', { bubbles: true }))
await sleep(150)
check('表单值已记录', t.docState.formValues['name'] === '张三' && t.docState.formValues['agree'] === true, t.docState.formValues)

// 保存(不写 sidecar,以便验证值确实写进了 PDF)
const save = await window.pdfAPI.invoke('save:saveAs', {
  docId: t.docState.docId,
  defaultPath: 'saved-form.pdf',
  targetPath: `${root}/tmp/saved-form.pdf`,
  annotations: [],
  formValues: { ...t.docState.formValues },
  writeSidecar: false
})
check('保存成功', save.ok === true, save)

// 重新打开保存后的文件:字段值应从 PDF 本身读出
await t.openPath(`${root}/tmp/saved-form.pdf`)
await sleep(1800)
const restored = t.docState.formFields
const restoredName = restored.find((f) => f.name === 'name')
const restoredAgree = restored.find((f) => f.name === 'agree')
check('文本值已写回 PDF', restoredName?.value === '张三', restoredName?.value)
check('复选框已勾选写回 PDF', restoredAgree?.value === true, restoredAgree?.value)

return {
  fields: fields.map((f) => `${f.name}:${f.type}`),
  restoredValues: { name: restoredName?.value, agree: restoredAgree?.value }
}
