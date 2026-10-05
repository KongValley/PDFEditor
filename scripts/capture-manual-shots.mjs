// 生成操作手册截图:为每个功能状态启动一次应用,驱动 UI 后用冒烟框架截图
// 用法:node scripts/capture-manual-shots.mjs [--only 名称]
// 输出:docs/images/*.png(README.md 引用,随后 npm run manual 生成 PDF)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const outDir = join(root, 'docs', 'images')
const tmpDir = join(root, 'tmp', 'manual-shots')
mkdirSync(outDir, { recursive: true })
mkdirSync(tmpDir, { recursive: true })

/** 打开 sample-zh 并放几条注释,作为多数截图的基础现场 */
const SETUP = `
const t = window.__pdfEditorTest
if (!t) throw new Error('测试 API 未安装')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const add = (ann) => t.addAnnotation(t.withIdentity(ann))
async function baseDoc(withAnnots = true) {
  await t.openPath(\`\${__smokeRoot}/samples/sample-zh.pdf\`)
  await sleep(1500)
  if (!withAnnots) return
  add({ kind: 'highlight', page: 0, bbox: { x: 60, y: 668, w: 300, h: 16 }, color: '#ffe066', opacity: 0.45 })
  add({ kind: 'rect', page: 0, bbox: { x: 330, y: 560, w: 160, h: 70 }, color: '#e03131', opacity: 1, thickness: 1.5 })
  add({ kind: 'arrow', page: 0, bbox: { x: 100, y: 520, w: 130, h: 60 }, color: '#1971c2', opacity: 1, thickness: 2, from: { x: 100, y: 520 }, to: { x: 230, y: 580 } })
  add({ kind: 'text', page: 0, bbox: { x: 90, y: 470, w: 240, h: 44 }, color: '#212529', opacity: 1, text: '示例文字注释', fontSize: 16, rotate: 0 })
  add({ kind: 'stamp', page: 0, bbox: { x: 350, y: 430, w: 150, h: 48 }, color: '#2f9e44', opacity: 0.95, stampKey: 'approved', label: '已批准', fontSize: 16, rotate: 0 })
  add({ kind: 'note', page: 1, bbox: { x: 80, y: 700, w: 26, h: 26 }, color: '#f7c948', opacity: 1, text: '便签:第二页' })
  await sleep(300)
}
`

const SHOTS = [
  {
    name: '01-overview',
    caption: '界面总览:两行工具栏、左侧缩略图栏、主视图与右侧注释/大纲面板',
    body: `
await baseDoc()
t.ui.selectedAnnotationIds = []
await sleep(400)
return { shot: 'overview' }
`
  },
  {
    name: '02-tools',
    caption: '第二行是注释工具;图章工具会展开样式下拉框(已批准/作废/审核中…)',
    body: `
await baseDoc()
t.setTool ? t.setTool('stamp') : (t.ui.tool = 'stamp')
await sleep(400)
return { shot: 'tools', tool: t.ui.tool }
`
  },
  {
    name: '03-props',
    caption: '选中注释:画布上出现蓝色控制框与缩放手柄,右侧属性面板可改颜色/透明度/内容/层级/锁定',
    body: `
await baseDoc()
const textAnn = t.annotState.items.find((a) => a.kind === 'text')
t.ui.selectedAnnotationIds = [textAnn.id]
t.docState.currentPage = 1
await sleep(600)
return { shot: 'props', selected: textAnn.id }
`
  },
  {
    name: '04-search',
    caption: '搜索:命中在页面上高亮,计数显示「当前/总数」,F3 逐条跳转',
    body: `
await baseDoc(false)
t.ui.searchOpen = true
await sleep(300)
const input = document.querySelector('.search-input')
input.value = '第'
input.dispatchEvent(new Event('input', { bubbles: true }))
await sleep(1400)
return { shot: 'search', results: t.searchState.results.length }
`
  },
  {
    name: '05-thumbnails',
    caption: '缩略图栏:勾选页面后可批量删除/左旋/右旋;拖动缩略图可直接调整页序',
    body: `
await baseDoc()
t.ui.selectedAnnotationIds = []
for (const el of document.querySelectorAll('.thumb-check')) {
  if (el.parentElement?.parentElement?.dataset.thumb !== '1') el.click()
}
await sleep(500)
return { shot: 'thumbnails' }
`
  },
  {
    name: '06-export-dialog',
    caption: '导出页面(PNG 模式):可选逐页多图/拼接长图与方向;「包含注释」默认勾选,不勾则输出纯页面',
    body: `
await baseDoc()
t.ui.selectedAnnotationIds = []
const buttons = [...document.querySelectorAll('.pages-toolbar button')]
buttons.find((b) => b.textContent.trim() === '导出').click()
await sleep(500)
const rangeInput = document.querySelector('.mask .dialog input')
rangeInput.value = '1-3'
rangeInput.dispatchEvent(new Event('input', { bubbles: true }))
document.querySelector('.mask .dialog select').value = 'png'
document.querySelector('.mask .dialog select').dispatchEvent(new Event('change', { bubbles: true }))
await sleep(400)
return { shot: 'export-dialog' }
`
  },
  {
    name: '07-split-dialog',
    caption: '批量拆分:每行独立设置最大页数/页码范围与输出目录,「包含注释」默认勾选,重名自动改名',
    body: `
await baseDoc()
t.ui.selectedAnnotationIds = []
const buttons = [...document.querySelectorAll('.pages-toolbar button')]
buttons.find((b) => b.textContent.trim() === '拆分').click()
await sleep(500)
t.splitDialogState.rows.push({
  kind: 'file', path: 'D:\\\\资料\\\\季度报告.pdf', name: '季度报告.pdf', pageCount: 24,
  mode: 'ranges', start: '1', end: '24', pagesPerFile: '1', ranges: '1-8,9-16,17-24', selected: false
})
await sleep(400)
return { shot: 'split-dialog' }
`
  },
  {
    name: '08-merge-dialog',
    caption: '合并:当前文档整份参与,可追加文件并各自指定页码范围与顺序,输出名重名自动追加 -1',
    body: `
await baseDoc()
t.ui.selectedAnnotationIds = []
const buttons = [...document.querySelectorAll('.pages-toolbar button')]
buttons.find((b) => b.textContent.trim() === '合并').click()
await sleep(500)
t.mergeDialogState.rows.push({
  kind: 'file', path: 'D:\\\\资料\\\\附件.pdf', name: '附件.pdf', pageCount: 6,
  start: '1', end: '3', selected: false
})
t.mergeDialogState.outputName = '示例-合并'
await sleep(400)
return { shot: 'merge-dialog' }
`
  },
  {
    name: '09-encrypted-sidecar',
    caption: '加密 PDF:输入密码后注释与表单值保存到同名 sidecar(.pdfanno.json),保存后会提示',
    body: `
const pending = t.openPath(\`\${__smokeRoot}/samples/sample-encrypted-pw.pdf\`)
await sleep(1500)
const pwdInput = document.querySelector('.mask input[type="password"]')
pwdInput.value = 'test123'
pwdInput.dispatchEvent(new Event('input', { bubbles: true }))
document.querySelector('.mask button.primary').click()
await pending
await sleep(2500)
add({ kind: 'rect', page: 0, bbox: { x: 120, y: 500, w: 200, h: 60 }, color: '#e03131', opacity: 1, thickness: 2 })
t.ui.selectedAnnotationIds = []
await sleep(400)
await t.saveDocument()
await sleep(150)
return { shot: 'encrypted', pages: t.docState.pageCount, encrypted: t.docState.encrypted }
`
  }
]

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
let failed = 0
for (const shot of SHOTS) {
  if (only && shot.name !== only) continue
  const scriptPath = join(tmpDir, `${shot.name}.js`)
  const outPath = join(tmpDir, `${shot.name}.json`)
  const shotPath = join(outDir, `${shot.name}.png`)
  writeFileSync(scriptPath, SETUP + shot.body, 'utf8')
  rmSync(shotPath, { force: true })
  rmSync(outPath, { force: true })
  spawnSync(electron, ['.', `--user-data-dir=${join(tmpDir, `udd-${shot.name}`)}`], {
    cwd: root,
    env: {
      ...process.env,
      PDF_EDITOR_SMOKE: '1',
      PDF_EDITOR_SMOKE_SCRIPT: join('tmp', 'manual-shots', `${shot.name}.js`),
      PDF_EDITOR_SMOKE_OUT: outPath,
      PDF_EDITOR_SMOKE_SHOT: shotPath,
      PDF_EDITOR_SMOKE_ROOT: root,
      PDF_EDITOR_SMOKE_TIMEOUT: '60000',
      PDF_EDITOR_SMOKE_SETTLE: '1600'
    },
    stdio: 'ignore'
  })
  const ok = existsSync(shotPath)
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${shot.name} -> ${ok ? shotPath : '未生成截图'}`)
}
process.exit(failed === 0 ? 0 : 1)
