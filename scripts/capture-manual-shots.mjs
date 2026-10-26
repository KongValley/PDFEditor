// 生成操作手册截图:为每个功能状态启动一次应用,驱动 UI 后用冒烟框架截图
// 用法:node scripts/capture-manual-shots.mjs [--only 名称]
// 输出:docs/images/*.png(README.md 引用,随后 npm run manual 生成 PDF)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
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
  mode: 'ranges', start: '1', end: '24', pagesPerFile: '1', ranges: '1-8,9-16,17-24', selected: true
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
  start: '1', end: '3', selected: true
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
  },
  {
    name: '10-open-progress',
    caption: '打开进度:大文件读取期间显示百分比与「取消」,读完自动进入阅读界面',
    settle: 200,
    prepare: async ({ tmpDir }) => {
      // 页数多才看得见「正在读取页面信息 x/N」阶段(字节数小、几何枚举慢)
      const fixture = join(tmpDir, 'many-pages.pdf')
      if (existsSync(fixture)) return
      mkdirSync(tmpDir, { recursive: true })
      const { PDFDocument, StandardFonts } = await import('pdf-lib')
      const doc = await PDFDocument.create()
      const font = await doc.embedFont(StandardFonts.Helvetica)
      for (let i = 0; i < 5000; i++) {
        doc.addPage([595, 842]).drawText(`page ${i + 1}`, { x: 40, y: 760, size: 12, font })
      }
      writeFileSync(fixture, await doc.save())
    },
    body: `
t.openByPath(\`\${__smokeRoot}/tmp/manual-shots/many-pages.pdf\`).catch(() => {})
await sleep(2500)
return { shot: 'open-progress', loading: t.docState.loading, progress: t.docState.loadProgress }
`
  },
  {
    name: '11-password',
    caption: '加密 PDF:打开时弹出密码框,输错重试,取消不影响已打开的文档',
    body: `
// 走正常打开路径(不 await:密码框不提交前打开不会完成)
const pending = t.openPath(\`\${__smokeRoot}/samples/sample-encrypted-pw.pdf\`)
pending.catch(() => {})
await sleep(1500)
return { shot: 'password', dialog: !!document.querySelector('.mask input[type="password"]') }
`
  },
  {
    name: '12-empty-recent',
    caption: '未打开文档时的空状态:打开文件 / 图片转 PDF 入口与「最近打开」列表',
    prepare: ({ root, uddDir }) => {
      mkdirSync(uddDir, { recursive: true })
      const entries = [
        ['samples/sample-zh.pdf', 3],
        ['samples/sample-outline.pdf', 2],
        ['samples/Scan.pdf', 7],
        ['samples/sample-form.pdf', 1]
      ]
      const files = {}
      entries.forEach(([rel, page], i) => {
        files[join(root, ...rel.split('/'))] = { page, at: Date.now() - i * 3600_000 }
      })
      writeFileSync(join(uddDir, 'recent.json'), JSON.stringify({ files }), 'utf8')
    },
    body: `
return { shot: 'empty-recent', recent: document.querySelectorAll('.recent-item').length }
`
  },
  {
    name: '13-two-page',
    caption: '双页阅览:每行两页(1-2 / 3-4),上一页/下一页按整行步进',
    body: `
await baseDoc(false)
;[...document.querySelectorAll('.status-bar button')].find((b) => b.textContent.trim() === '双页').click()
await sleep(1500)
return { shot: 'two-page', viewMode: t.docState.viewMode }
`
  },
  {
    name: '14-page-menu',
    caption: '右键菜单:主视图页面或缩略图上右键可旋转 / 插入空白页 / 删除 / 提取 / 导出该页',
    body: `
await baseDoc()
t.ui.selectedAnnotationIds = []
const rect = document.querySelector('.page-wrap').getBoundingClientRect()
t.ui.pageMenu = {
  open: true,
  page: 1,
  x: Math.round(rect.left + rect.width * 0.55),
  y: Math.round(rect.top + rect.height * 0.3)
}
await sleep(400)
return { shot: 'page-menu' }
`
  },
  {
    name: '15-print-dialog',
    caption: '打印:先设页码范围与清晰度(标准 / 高清),再进系统打印对话框',
    body: `
await baseDoc()
t.ui.selectedAnnotationIds = []
;[...document.querySelectorAll('.toolbar button')].find((b) => (b.title || '').includes('打印')).click()
await sleep(500)
const input = document.querySelector('.mask .dialog input')
input.value = '1-2'
input.dispatchEvent(new Event('input', { bubbles: true }))
const selects = [...document.querySelectorAll('.mask .dialog select')]
const quality = selects.find((s) => [...s.options].some((o) => o.textContent.includes('高清')))
if (quality) {
  quality.value = 'high'
  quality.dispatchEvent(new Event('change', { bubbles: true }))
}
await sleep(400)
return { shot: 'print-dialog', selects: selects.length }
`
  },
  {
    name: '16-about',
    caption: '关于:版本、环境自检(系统 / 字体 / 目录可写性)、运行日志开关与开源许可清单',
    // 日志目录按默认形态展示(截图里不要出现本机开发路径)
    env: { PDF_EDITOR_LOG_DIR: 'C:\\Users\\Administrator\\AppData\\Roaming\\PDF编辑器\\logs' },
    body: `
t.ui.aboutOpen = true
await sleep(1200)
return { shot: 'about' }
`
  },
  {
    name: '17-form',
    caption: '表单填写:覆盖层上就地填写,保存时写回 PDF(加密文档写同名 sidecar)',
    body: `
await t.openPath(\`\${__smokeRoot}/samples/sample-form.pdf\`)
await sleep(1500)
const input = document.querySelector('.form-layer input[type="text"]')
input.value = '张三'
input.dispatchEvent(new Event('input', { bubbles: true }))
const cb = document.querySelector('.form-layer input[type="checkbox"]')
cb.checked = true
cb.dispatchEvent(new Event('change', { bubbles: true }))
await sleep(400)
return { shot: 'form', values: t.docState.formValues }
`
  },
  {
    name: '18-outline',
    caption: '大纲(书签):右侧面板切换到大纲页签,点击跳页,行内新增 / 重命名 / 删除书签',
    body: `
await t.openPath(\`\${__smokeRoot}/samples/sample-outline.pdf\`)
await sleep(1800)
t.ui.sideTab = 'outline'
await sleep(500)
return { shot: 'outline' }
`
  },
  {
    name: '19-orientation',
    caption: '统一页面方向:逐页列出待调整页、判定原因与建议角度,可单独勾选与改角度',
    body: `
await t.openPath(\`\${__smokeRoot}/samples/sample-mixed-orient.pdf\`)
await sleep(1200)
await t.normalizePageOrientation()
for (let i = 0; i < 300; i++) {
  const s = t.orientationDialogState
  if (s.open && !s.scanning) break
  await sleep(100)
}
await sleep(600)
return { shot: 'orientation', items: t.orientationDialogState.items.length }
`
  },
  {
    name: '20-watermark',
    caption: '水印:自定义文字、字号、透明度、角度与颜色,可平铺;不勾选则留空 = 全部页',
    body: `
await baseDoc()
t.ui.watermarkDialog.preset = '1-3'
t.ui.watermarkDialog.open = true
await sleep(500)
return { shot: 'watermark' }
`
  },
  {
    name: '21-page-number',
    caption: '页码:按页码范围加页码,可选位置、起始编号与格式',
    body: `
await baseDoc()
t.ui.pageNumberDialog.preset = '2-3'
t.ui.pageNumberDialog.open = true
await sleep(500)
return { shot: 'page-number' }
`
  },
  {
    name: '22-ofd-export',
    caption: '导出 OFD:选页码范围、分辨率与是否含批注;产物为图片页 OFD,不含可检索文本',
    body: `
await t.openPath(\`\${__smokeRoot}/samples/sample-ofd.ofd\`)
await sleep(1500)
const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '导出 OFD')
button.click()
await sleep(600)
const rangeInput = document.querySelector('.mask .dialog input:not([type="checkbox"])')
rangeInput.value = '1-2'
rangeInput.dispatchEvent(new Event('input', { bubbles: true }))
await sleep(400)
return { shot: 'ofd-export', pages: t.docState.pageCount, kind: t.docState.sourceKind }
`
  },
  {
    name: '23-image2pdf',
    caption: '图片转 PDF:按选择顺序成页,页面尺寸可按图像像素或 A4,转换完自动打开',
    prepare: ({ root, tmpDir }) => {
      mkdirSync(tmpDir, { recursive: true })
      copyFileSync(join(root, 'resources', 'icon.png'), join(tmpDir, '扫描件-封面.png'))
      copyFileSync(join(root, 'resources', 'icon.png'), join(tmpDir, '扫描件-正文.png'))
    },
    body: `
await t.openImageToPdfDialog([
  \`\${__smokeRoot}/tmp/manual-shots/扫描件-封面.png\`,
  \`\${__smokeRoot}/tmp/manual-shots/扫描件-正文.png\`
])
await sleep(800)
return { shot: 'image2pdf', items: t.imagePdfDialogState.items.length }
`
  },
  {
    name: '24-problems',
    caption: '问题面板:保存 / 导出 / 打印的失败与提示集中在此,可重试、复制明细',
    body: `
await baseDoc()
t.ui.selectedAnnotationIds = []
t.ui.problems.push(
  {
    id: 'demo-1',
    at: Date.now() - 65000,
    title: '打印第 3 页渲染超时,已跳过该页',
    detail: '重试 3 次仍未完成,可重新打印该页;详细过程见运行日志'
  },
  {
    id: 'demo-2',
    at: Date.now() - 240000,
    title: '导出失败:目标目录不可写',
    detail: '请检查输出目录权限或换一个位置后重试'
  }
)
t.ui.problemsOpen = true
await sleep(500)
return { shot: 'problems', count: t.ui.problems.length }
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
  // 个别截图需要预置现场(生成大文件夹具 / 预填最近文件 / 准备示例图片)
  await shot.prepare?.({ root, tmpDir, uddDir: join(tmpDir, `udd-${shot.name}`) })
  spawnSync(electron, ['.', `--user-data-dir=${join(tmpDir, `udd-${shot.name}`)}`], {
    cwd: root,
    env: {
      ...process.env,
      ...(shot.env ?? {}),
      PDF_EDITOR_SMOKE: '1',
      PDF_EDITOR_SMOKE_SCRIPT: join('tmp', 'manual-shots', `${shot.name}.js`),
      PDF_EDITOR_SMOKE_OUT: outPath,
      PDF_EDITOR_SMOKE_SHOT: shotPath,
      PDF_EDITOR_SMOKE_ROOT: root,
      PDF_EDITOR_SMOKE_TIMEOUT: '60000',
      PDF_EDITOR_SMOKE_SETTLE: String(shot.settle ?? 1600)
    },
    stdio: 'ignore'
  })
  const ok = existsSync(shotPath)
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${shot.name} -> ${ok ? shotPath : '未生成截图'}`)
}
process.exit(failed === 0 ? 0 : 1)
