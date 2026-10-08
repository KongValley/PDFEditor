// 依次运行全部冒烟脚本(每个脚本使用独立 user-data-dir,避免多实例缓存争用导致抖动)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const tmpDir = join(root, 'tmp')
mkdirSync(tmpDir, { recursive: true })

const scripts = [
  'step1.js',
  'step2.js',
  'step3.js',
  'step4.js',
  'step5.js',
  'step5b.js',
  'step5c.js',
  'step6.js',
  'step7.js',
  'step8.js',
  'step9.js',
  'step10-mem.js',
  'step11-doccycle.js',
  'step12-pages-range.js',
  'step13-batch.js',
  'step14-ux.js',
  'step15-annots.js',
  'step16-view.js',
  'step17-render.js',
  'step18-print.js',
  'step19-nav.js',
  'step20-about.js',
  'step21-range.js',
  'step22-pageops.js',
  'step23-two-page.js',
  'step24-long-image.js',
  'step25-orient.js',
  'step26-image2pdf.js'
]

if (!existsSync(join(root, 'samples', 'sample-zh.pdf'))) {
  console.error('缺少 samples/,请先运行 npm run samples')
  process.exit(1)
}

// 大文件夹具(range 流式加载冒烟用):缺失时现场生成(≈30MB,约 2s)
if (!existsSync(join(root, 'tmp', 'large.pdf'))) {
  const gen = spawnSync(process.execPath, [join(root, 'scripts', 'make-large-sample.mjs')], {
    cwd: root,
    stdio: 'inherit'
  })
  if (gen.status !== 0) {
    console.error('生成 tmp/large.pdf 失败')
    process.exit(1)
  }
}

// 方向不一致夹具(「统一页面方向」冒烟用):samples/ 不入版本库,缺失时现场生成(≈1s)
if (!existsSync(join(root, 'samples', 'sample-mixed-orient.pdf'))) {
  const genOrient = spawnSync(process.execPath, [join(root, 'scripts', 'make-mixed-orient-sample.mjs')], {
    cwd: root,
    stdio: 'inherit'
  })
  if (genOrient.status !== 0) {
    console.error('生成 samples/sample-mixed-orient.pdf 失败')
    process.exit(1)
  }
}

// 单步脚本超时(毫秒):默认 60s;重负载步骤给更宽裕的上限
// step13/14/15 含批量拆分、50 页大文档、20+ 次文档打开;渲染层偶发首屏等待
// (见 docs/代码审查报告.md「存疑」第 4 条)会额外消耗 20s/次,独立跑约 28–50s,套件内更慢
const STEP_TIMEOUTS = {
  'step13-batch.js': '180000',
  'step14-ux.js': '120000',
  'step15-annots.js': '300000',
  'step21-range.js': '180000',
  'step22-pageops.js': '120000',
  'step23-two-page.js': '180000',
  'step24-long-image.js': '180000',
  'step25-orient.js': '180000',
  'step26-image2pdf.js': '120000'
}

let failed = 0
for (const script of scripts) {
  const name = script.replace(/\.js$/, '')
  const outFile = join(tmpDir, `smoke-${name}.json`)
  rmSync(outFile, { force: true })
  spawnSync(electron, ['.', `--user-data-dir=${join(tmpDir, `udd-${name}`)}`], {
    cwd: root,
    env: {
      ...process.env,
      PDF_EDITOR_SMOKE: '1',
      PDF_EDITOR_SMOKE_SCRIPT: join('scripts', 'smoke', script),
      PDF_EDITOR_SMOKE_OUT: outFile,
      PDF_EDITOR_SMOKE_ROOT: root,
      PDF_EDITOR_SMOKE_TIMEOUT: STEP_TIMEOUTS[script] ?? '60000'
    },
    stdio: 'ignore'
  })
  let report = { ok: false, error: '未生成结果文件' }
  if (existsSync(outFile)) {
    try {
      report = JSON.parse(readFileSync(outFile, 'utf8'))
    } catch (err) {
      report = { ok: false, error: `结果文件解析失败:${String(err)}` }
    }
  }
  if (!report.ok) failed++
  console.log(`${report.ok ? 'PASS' : 'FAIL'} ${name}${report.ok ? '' : ` - ${report.error}`}`)
}

console.log(failed === 0 ? `\n全部 ${scripts.length} 项冒烟通过` : `\n${failed}/${scripts.length} 项失败`)
process.exit(failed === 0 ? 0 : 1)
