// 步骤 20 冒烟:关于 / 开源许可(清单随包、运行时版本、Esc 关闭)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}

const info = await window.pdfAPI.invoke('app:runtimeInfo')
check('运行时信息含版本', typeof info.version === 'string' && /^\d+\./.test(info.version), info)
// 环境自检的数据源(main 侧填齐)
check('运行时含 Electron/Chromium 版本', !!info.electron && !!info.chrome, info)
check('运行时含操作系统与架构', !!info.osRelease && !!info.osArch, info)
check('本机找到中文字体(文字批注/图章可保存)', info.cjkFontFile !== null && typeof info.cjkFontFile === 'string', info)
check('运行时含渲染模式与目录可写性', typeof info.gpuDisabled === 'boolean' && typeof info.userDataWritable === 'boolean', info)

await t.openPath(`${__smokeRoot}/samples/sample-zh.pdf`)
await sleep(1200)
const aboutBtn = document.querySelector('.toolbar button[title="关于 / 开源许可"]')
check('关于按钮存在', !!aboutBtn)
aboutBtn.click()
await sleep(700)
const dialogEl = document.querySelector('.mask .dialog')
const dialogText = dialogEl?.textContent ?? ''
check('关于对话框打开', !!dialogEl && dialogText.includes('关于'), dialogText.slice(0, 60))
check('正文含版本号', dialogText.includes(info.version), info.version)
// 环境自检区块:内网排障第一手材料
const envEl = document.querySelector('.mask .env-check')
const envText = envEl?.textContent ?? ''
check('存在环境自检区块', !!envEl, null)
check('环境自检显示渲染模式', envText.includes('软件渲染') || envText.includes('硬件加速'), envText)
check('环境自检显示中文字体', envText.includes('字体') && envText.includes('.ttf'), envText)
check('环境自检显示版本与内存', envText.includes(info.chrome) && envText.includes('MB'), envText)
const items = [...document.querySelectorAll('.mask details')]
check('许可条目充足', items.length >= 30, items.length)
const names = items.map((el) => el.querySelector('summary')?.textContent ?? '')
check('包含 vue', names.some((n) => n.startsWith('vue ')), names.slice(0, 8))
check('包含 pdfjs-dist', names.some((n) => n.startsWith('pdfjs-dist')), null)
const texts = [...document.querySelectorAll('.mask details pre')].map((el) => el.textContent ?? '')
check('含 MIT 许可文本', texts.some((text) => text.includes('MIT')), texts.length)
check('含 Apache 许可文本', texts.some((text) => text.includes('Apache License')), null)
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await sleep(200)
check('Esc 关闭关于', !document.querySelector('.mask .dialog'))

return { about: 'ok', notices: items.length }