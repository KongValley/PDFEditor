// 依次运行全部冒烟脚本(每个脚本使用独立 user-data-dir,避免多实例缓存争用导致抖动)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
  'step26-image2pdf.js',
  'step27-rotate-fit.js',
  'step28-user-actions.js',
  'step29-error-paths.js'
]

if (!existsSync(join(root, 'samples', 'sample-zh.pdf'))) {
  console.error('缺少 samples/,请先运行 npm run samples')
  process.exit(1)
}

// 复位会被步骤原地改写的夹具:多个步骤把批注存回 samples/sample-zh.pdf 本体
// (step14/15/28 的「保存直存」「另存为」之外的路径),一次崩在中途的运行会把批注留在
// 样本里,导致下一次跑出「注释多了 2 条」这类与代码无关的假红。这里每次开跑前重生成,
// samples/ 本就不入版本库(代价 ≈0.2s)。
for (const script of ['make-samples.mjs', 'make-outline-sample.mjs']) {
  const reset = spawnSync(process.execPath, [join(root, 'scripts', script)], { cwd: root, stdio: 'inherit' })
  if (reset.status !== 0) {
    console.error(`重生成夹具失败:${script}`)
    process.exit(1)
  }
}
// sidecar 是上一轮遗留的恢复源,一并清掉
for (const name of readdirSync(join(root, 'samples'))) {
  if (name.endsWith('.pdfanno.json')) rmSync(join(root, 'samples', name), { force: true })
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

// 护栏前置:产物含超出目标运行时(Electron 22 / Chromium 108)的新特性时,
// 没必要先付 28 次 Electron 冷启动的代价才发现
const compat = spawnSync(process.execPath, [join(root, 'scripts', 'check-compat.mjs')], {
  cwd: root,
  stdio: 'inherit'
})
if (compat.status !== 0) {
  console.error('兼容性检查未通过,已跳过冒烟')
  process.exit(1)
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
  'step26-image2pdf.js': '120000',
  'step27-rotate-fit.js': '120000',
  'step28-user-actions.js': '180000',
  'step29-error-paths.js': '180000'
}

// 按步注入的环境变量:只有这两步需要(原生对话框替身 / 强制走「缺中文字体」路径)
const STEP_ENV = {
  'step28-user-actions.js': { PDF_EDITOR_SMOKE_DIALOG_DIR: join(tmpDir, 'dialog') },
  'step29-error-paths.js': { PDF_EDITOR_SMOKE_CJK_FONT: 'none' }
}

let failed = 0
for (const script of scripts) {
  const name = script.replace(/\.js$/, '')
  const outFile = join(tmpDir, `smoke-${name}.json`)
  rmSync(outFile, { force: true })
  const stepTimeoutMs = Number(STEP_TIMEOUTS[script] ?? 60000)
  // 进程级看门狗:脚本内的 PDF_EDITOR_SMOKE_TIMEOUT 只在「窗口已就绪、脚本已开始跑」之后才生效。
  // 窗口起不来时(无显示环境/CI runner)spawnSync 会永远等下去,这里用 spawnSync 自身的 timeout
  // 兜底:到点强杀进程树,让该步记为失败并继续往下跑,而不是整轮挂死。
  const spawn = spawnSync(electron, ['.', `--user-data-dir=${join(tmpDir, `udd-${name}`)}`], {
    cwd: root,
    env: {
      ...process.env,
      ...(STEP_ENV[script] ?? {}),
      PDF_EDITOR_SMOKE: '1',
      PDF_EDITOR_SMOKE_SCRIPT: join('scripts', 'smoke', script),
      PDF_EDITOR_SMOKE_OUT: outFile,
      PDF_EDITOR_SMOKE_ROOT: root,
      PDF_EDITOR_SMOKE_TIMEOUT: String(stepTimeoutMs)
    },
    stdio: 'ignore',
    timeout: stepTimeoutMs + 60000,
    killSignal: 'SIGKILL'
  })
  let report = { ok: false, error: '未生成结果文件' }
  if ((spawn.error || spawn.signal) && !existsSync(outFile)) {
    report = {
      ok: false,
      error: `Electron 未在 ${stepTimeoutMs + 60000}ms 内退出(${spawn.signal ?? spawn.error?.code ?? 'unknown'}),通常意味着窗口没能创建`
    }
  }
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
