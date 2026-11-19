// 步骤 33 冒烟:注释字体选择(枚举系统字体 / 工具栏与属性面板 / 画布渲染 / 保存回读)
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (cond, timeout = 5000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (cond()) return true
    await sleep(50)
  }
  return false
}
const check = (name, cond, extra) => {
  if (!cond) throw new Error(`断言失败: ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`)
}
const log = (name) => console.log(`[step33] ${name} @${Date.now() - started}ms`)
const started = Date.now()

/* ---------- 1. 主进程字体枚举 ---------- */

const listed = await window.pdfAPI.invoke('fonts:list')
check('fonts:list 成功', listed.ok === true && Array.isArray(listed.fonts), listed)
const fonts = listed.fonts ?? []
check('字体列表非空', fonts.length >= 5, fonts.length)
check(
  '字体项含字族名与显示名',
  fonts.every((font) => typeof font.family === 'string' && font.family !== '' && typeof font.label === 'string' && font.label !== ''),
  fonts.slice(0, 3)
)
// 中文注释优先挑中文字体;CI runner 上有下载的思源黑体,内网机器有黑体/宋体/雅黑
const preferred = ['SimHei', 'KaiTi', 'SimSun', 'Microsoft YaHei', 'Noto Sans SC', 'Source Han Sans SC']
const primary = preferred.map((family) => fonts.find((font) => font.family === family)).find(Boolean) ?? fonts[0]
const secondary = fonts.find((font) => font.family !== primary.family)
check('至少有两种可选字体', !!secondary, fonts.map((font) => font.family).slice(0, 5))
log(`picked ${primary.family} / ${secondary?.family}`)

/* ---------- 2. 在副本上放一条指定字体的文字注释 ---------- */

const stamp = Date.now()
const tmp = `${__smokeRoot}/tmp`
const split = await window.pdfAPI.invoke('pdf:splitTasks', {
  tasks: [{ mode: 'ranges', path: `${__smokeRoot}/samples/sample-zh.pdf`, ranges: [[0, 1]] }],
  outputDir: `${tmp}/font-copy-${stamp}`
})
check('副本生成', split[0]?.ok === true, split[0])
const file = split[0].outputs[0]

await t.openPath(file)
await until(() => t.docState.pageCount === 2 && t.annotState.items.length === 0)

const ann = t.withIdentity({
  kind: 'text',
  page: 0,
  bbox: { x: 80, y: 520, w: 260, h: 60 },
  color: '#212529',
  opacity: 1,
  text: '字体测试 ABC',
  fontSize: 20,
  rotate: 0,
  fontFamily: primary.family
})
t.addAnnotation(ann)
await until(() => t.annotState.items.length === 1)

// 画布覆盖层:SVG 文本的 font-family 应包含所选字族
const textEl = await (async () => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const el = document.querySelector('.ann-layer .text-ann')
    if (el) return el
    await sleep(50)
  }
  return null
})()
check('文字注释已渲染到覆盖层', !!textEl)
const renderedFont = textEl ? getComputedStyle(textEl).fontFamily : ''
check('画布使用所选字体', renderedFont.toLowerCase().includes(primary.family.toLowerCase()), renderedFont)

/* ---------- 3. 属性面板字体下拉框 ---------- */

t.ui.selectedAnnotationIds = [ann.id]
const select = await (async () => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const el = document.querySelector('.props .font-select')
    if (el) return el
    await sleep(50)
  }
  return null
})()
check('属性面板出现字体下拉框', !!select)
check('下拉框当前值等于注释字体', select?.value === primary.family, select?.value)
const optionValues = select ? [...select.options].map((option) => option.value) : []
check('下拉框列出系统字体', optionValues.includes(primary.family) && optionValues.includes(secondary.family), optionValues.slice(0, 5))
check('下拉框有「默认字体」项', optionValues.includes(''), optionValues.slice(0, 3))

// 改选另一种字体:注释模型与「新建注释默认字体」都应跟着变
select.value = secondary.family
select.dispatchEvent(new Event('change', { bubbles: true }))
await until(() => t.annotState.items[0]?.fontFamily === secondary.family, 3000)
check('切换字体写入注释', t.annotState.items[0].fontFamily === secondary.family, t.annotState.items[0].fontFamily)
check('切换字体同步为新注释默认值', t.ui.fontFamily === secondary.family, t.ui.fontFamily)
const renderedFont2 = document.querySelector('.ann-layer .text-ann')
check(
  '切换后画布字体随之更新',
  !!renderedFont2 && getComputedStyle(renderedFont2).fontFamily.toLowerCase().includes(secondary.family.toLowerCase()),
  renderedFont2 ? getComputedStyle(renderedFont2).fontFamily : ''
)

// 再用工具栏:选文字工具后出现字体下拉框,新建注释沿用工具栏所选字体
const textTool = [...document.querySelectorAll('.toolbar button')].find((button) => button.textContent?.trim() === '文字')
check('工具栏文字工具存在', !!textTool)
textTool.click()
await sleep(100)
const toolbarSelect = document.querySelector('.toolbar .font-select')
check('文字工具显示工具栏字体下拉框', !!toolbarSelect)
toolbarSelect.value = primary.family
toolbarSelect.dispatchEvent(new Event('change', { bubbles: true }))
await until(() => t.ui.fontFamily === primary.family, 2000)
const ann2 = t.withIdentity({
  kind: 'text',
  page: 0,
  bbox: { x: 80, y: 460, w: 220, h: 40 },
  color: '#212529',
  opacity: 1,
  text: '工具栏字体',
  fontSize: 16,
  rotate: 0,
  fontFamily: t.ui.fontFamily || undefined
})
t.addAnnotation(ann2)
check('新注释沿用工具栏字体', t.annotState.items.find((item) => item.id === ann2.id)?.fontFamily === primary.family)

/* ---------- 4. 保存 → 重开:字体元数据随 PDF 回读 ---------- */

log('save')
await t.saveDocument()
await sleep(1200)
log('reopen')
await t.openPath(file)
await until(() => t.annotState.items.length === 2, 5000)
const restored = t.annotState.items.find((item) => item.id === ann.id)
const restored2 = t.annotState.items.find((item) => item.id === ann2.id)
check('重开恢复两条注释', !!restored && !!restored2, t.annotState.items.length)
check('fontFamily 随 PDF 保存/回读', restored.fontFamily === secondary.family, restored.fontFamily)
check('第二条注释 fontFamily 保留', restored2.fontFamily === primary.family, restored2.fontFamily)

// 终态截图供人工确认布局:属性面板显示字体行,工具栏也显示文字工具的字体下拉框
t.ui.selectedAnnotationIds = [ann.id]
t.ui.tool = 'text'
await sleep(600)

return { fonts: fonts.length, primary: primary.family, secondary: secondary.family }
