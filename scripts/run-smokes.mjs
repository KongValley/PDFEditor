// 依次运行全部冒烟脚本(每个脚本使用独立 user-data-dir,避免多实例缓存争用导致抖动)
import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const tmpDir = join(root, 'tmp')
mkdirSync(tmpDir, { recursive: true })

const allScripts = [
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
  'step29-error-paths.js',
  'step30-full-flow.js',
  'step31-relaunch.js'
]

// --only=step30-full-flow,step31-relaunch:只跑指定步骤(名字不带 .js),用于全流程回归。
// 夹具准备、兼容性检查与计时输出保持不变。
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='))
const onlyNames = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((n) => n.trim()).filter(Boolean)) : null
const scripts = onlyNames ? allScripts.filter((script) => onlyNames.has(script.replace(/\.js$/, ''))) : allScripts
if (scripts.length === 0) {
  console.error(`--only 未匹配任何步骤:${onlyArg}`)
  process.exit(1)
}
if (onlyNames) {
  const known = new Set(allScripts.map((script) => script.replace(/\.js$/, '')))
  const unknown = [...onlyNames].filter((name) => !known.has(name))
  if (unknown.length > 0) {
    console.error(`--only 包含未知步骤:${unknown.join(',')}`)
    process.exit(1)
  }
}

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
for (const [file, script] of [
  ['sample-mixed-orient.pdf', 'make-mixed-orient-sample.mjs'],
  ['sample-image-orient.pdf', 'make-image-orient-sample.mjs']
]) {
  if (existsSync(join(root, 'samples', file))) continue
  const gen = spawnSync(process.execPath, [join(root, 'scripts', script)], {
    cwd: root,
    stdio: 'inherit'
  })
  if (gen.status !== 0) {
    console.error(`生成 samples/${file} 失败`)
    process.exit(1)
  }
}

// 全流程夹具:step30 从替身对话框打开 open-me.pdf 并原地保存;step31 共用同一 user-data-dir
// 验证最近文件与阅读位置。每次开跑重建,避免上一轮保存/提取产物污染合并对话框。
const e2eDir = join(tmpDir, 'e2e')
const e2eDialogDir = join(e2eDir, 'dialog')
rmSync(e2eDir, { recursive: true, force: true })
mkdirSync(e2eDialogDir, { recursive: true })
for (const [source, target] of [
  [join(root, 'samples', 'sample-zh.pdf'), join(e2eDir, 'journey.pdf')],
  [join(root, 'samples', 'sample-outline.pdf'), join(e2eDir, 'extra.pdf')],
  [join(root, 'samples', 'sample-form.pdf'), join(e2eDir, 'form.pdf')]
]) {
  if (!existsSync(source)) {
    console.error(`缺少全流程夹具:${source}(请先运行 npm run samples)`)
    process.exit(1)
  }
  copyFileSync(source, target)
}
copyFileSync(join(e2eDir, 'journey.pdf'), join(e2eDialogDir, 'open-me.pdf'))
copyFileSync(join(e2eDir, 'extra.pdf'), join(e2eDialogDir, 'extra.pdf'))

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
  // 50 页文档 + 20+ 次打开:本地约 90s,慢机器/无 GPU 的 CI runner 上 300s 不够
  'step15-annots.js': '600000',
  'step21-range.js': '180000',
  'step22-pageops.js': '120000',
  'step23-two-page.js': '180000',
  'step24-long-image.js': '180000',
  'step25-orient.js': '180000',
  'step26-image2pdf.js': '120000',
  'step27-rotate-fit.js': '120000',
  'step28-user-actions.js': '180000',
  'step29-error-paths.js': '180000',
  'step30-full-flow.js': '240000',
  'step31-relaunch.js': '120000'
}

// 跨进程全流程:step31 复用 step30 的 profile(最近文件、阅读位置、日志)
const STEP_USERDATA = {
  'step31-relaunch.js': 'udd-step30-full-flow'
}

// 关键步骤落一张终态截图,供人工确认布局/toast/空白页(不参与断言)
const STEP_SHOTS = {
  'step30-full-flow.js': join(tmpDir, 'smoke-step30-full-flow.png'),
  'step31-relaunch.js': join(tmpDir, 'smoke-step31-relaunch.png')
}

// 按步注入的环境变量:只有这两步需要(原生对话框替身 / 强制走「缺中文字体」路径)
const STEP_ENV = {
  'step28-user-actions.js': { PDF_EDITOR_SMOKE_DIALOG_DIR: join(tmpDir, 'dialog') },
  'step29-error-paths.js': { PDF_EDITOR_SMOKE_CJK_FONT: 'none' },
  'step30-full-flow.js': {
    PDF_EDITOR_SMOKE_DIALOG_DIR: e2eDialogDir,
    PDF_EDITOR_SMOKE_OPEN_FILE: 'open-me.pdf'
  }
}

// step30 必须从干净 profile 起步(最近文件为空);step31 随后复用它的 profile
if (scripts.includes('step30-full-flow.js')) {
  rmSync(join(tmpDir, 'udd-step30-full-flow'), { recursive: true, force: true })
}

let failed = 0
const stepTimings = {}
for (const script of scripts) {
  const name = script.replace(/\.js$/, '')
  const stepStartedAt = Date.now()
  const outFile = join(tmpDir, `smoke-${name}.json`)
  // 该步 Electron 的完整 stdout/stderr(PASS/FAIL 之外的全部线索:渲染层 console 转发、
  // [stepNN] 阶段标记、主进程 warn/error)。失败时打尾部,本地与 CI 都能直接看到失败现场。
  const logFile = join(tmpDir, `smoke-${name}.log`)
  rmSync(outFile, { force: true })
  rmSync(logFile, { force: true })
  // 应用自己的运行日志也按步分目录:失败时它的尾部往往就是主进程最后做的事(保存/打开/页面操作)
  const appLogDir = join(tmpDir, 'step-logs', name)
  rmSync(appLogDir, { recursive: true, force: true })
  const stepTimeoutMs = Number(STEP_TIMEOUTS[script] ?? 60000)
  // 进程级看门狗:脚本内的 PDF_EDITOR_SMOKE_TIMEOUT 只在「窗口已就绪、脚本已开始跑」之后才生效。
  // 窗口起不来时(无显示环境/CI runner)spawnSync 会永远等下去,这里用 spawnSync 自身的 timeout
  // 兜底:到点强杀进程树,让该步记为失败并继续往下跑,而不是整轮挂死。
  const logFd = openSync(logFile, 'a')
  const spawn = spawnSync(
    electron,
    ['.', `--user-data-dir=${join(tmpDir, STEP_USERDATA[script] ?? `udd-${name}`)}`],
    {
      cwd: root,
      env: {
        ...process.env,
        ...(STEP_ENV[script] ?? {}),
        ...(STEP_SHOTS[script] ? { PDF_EDITOR_SMOKE_SHOT: STEP_SHOTS[script] } : {}),
        PDF_EDITOR_SMOKE: '1',
        PDF_EDITOR_SMOKE_SCRIPT: join('scripts', 'smoke', script),
        PDF_EDITOR_SMOKE_OUT: outFile,
        PDF_EDITOR_SMOKE_ROOT: root,
        PDF_EDITOR_SMOKE_TIMEOUT: String(stepTimeoutMs),
        PDF_EDITOR_LOG_DIR: appLogDir
      },
      stdio: ['ignore', logFd, logFd],
      timeout: stepTimeoutMs + 60000,
      killSignal: 'SIGKILL'
    }
  )
  closeSync(logFd)
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
  const stepMs = Date.now() - stepStartedAt
  stepTimings[name] = stepMs
  console.log(`${report.ok ? 'PASS' : 'FAIL'} ${name} (${stepMs}ms)${report.ok ? '' : ` - ${report.error}`}`)
  if (!report.ok) {
    for (const line of readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-15)) {
      console.log(`    | ${line}`)
    }
    // 该步应用日志的尾部:主进程最后做了什么(保存开始/完成、打开、页面操作)
    if (existsSync(appLogDir)) {
      for (const file of readdirSync(appLogDir).filter((n) => n.endsWith('.log'))) {
        const lines = readFileSync(join(appLogDir, file), 'utf8').split('\n').filter(Boolean)
        for (const line of lines.slice(-12)) console.log(`    # ${line}`)
      }
    }
  }
}

writeFileSync(join(tmpDir, 'smoke-timings.json'), `${JSON.stringify(stepTimings, null, 2)}\n`, 'utf8')
const slowest = Object.entries(stepTimings)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3)
  .map(([name, ms]) => `${name}=${ms}ms`)
console.log(`耗时最长:${slowest.join('、')}(全部见 tmp/smoke-timings.json)`)
console.log(failed === 0 ? `\n全部 ${scripts.length} 项冒烟通过` : `\n${failed}/${scripts.length} 项失败`)
process.exit(failed === 0 ? 0 : 1)
