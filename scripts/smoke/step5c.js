// 步骤 5c 冒烟:受密码保护的 PDF → 密码输入流程(错误重试 + 正确解锁)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

const root = 'F:/DeepSeek工作区/pdf编辑器'
const openPromise = t.openPath(`${root}/samples/sample-encrypted-pw.pdf`)
await sleep(1200)

const dialog = document.querySelector('.mask .dialog')
check('弹出密码输入框', !!dialog, null)
const message = dialog.querySelector('.message')?.textContent ?? ''
check('提示需要密码', message.includes('密码'), message)

// 1) 错误密码 → 重新提示
const input = document.querySelector('.mask input[type="password"]')
input.value = 'wrong-password'
input.dispatchEvent(new Event('input', { bubbles: true }))
document.querySelector('.mask button.primary').dispatchEvent(new MouseEvent('click', { bubbles: true }))
await sleep(1500)
const dialog2 = document.querySelector('.mask .dialog')
check('密码错误后重新弹出', !!dialog2, null)
const message2 = dialog2?.querySelector('.message')?.textContent ?? ''
check('提示密码错误', message2.includes('错误'), message2)

// 2) 正确密码 → 解锁
const input2 = document.querySelector('.mask input[type="password"]')
input2.value = 'test123'
input2.dispatchEvent(new Event('input', { bubbles: true }))
document.querySelector('.mask button.primary').dispatchEvent(new MouseEvent('click', { bubbles: true }))
await openPromise
await sleep(1200)

check('密码正确后打开文档', t.docState.pageCount === 1, t.docState.pageCount)
check('标记为加密文档', t.docState.encrypted === true, t.docState.encrypted)
check('密码框已关闭', !document.querySelector('.mask .dialog'), null)
const spans = document.querySelectorAll('.textLayer span').length
check('解锁后可渲染', spans >= 1, spans)

return { pageCount: t.docState.pageCount, encrypted: t.docState.encrypted, spans }
