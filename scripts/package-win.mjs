// 单架构打包:node scripts/package-win.mjs <ia32|x64>
// ia32 → release/Win7-32位/,x64 → release/Win10-64位/,各含安装包(NSIS)与便携版,文件名自明。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const arch = process.argv[2]
if (arch !== 'ia32' && arch !== 'x64') {
  console.error('用法: node scripts/package-win.mjs <ia32|x64>')
  process.exit(1)
}

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const productName = pkg.build?.productName ?? pkg.name
const releaseDir = path.join(root, 'release')
const label = arch === 'ia32' ? 'Win7-32位' : 'Win10-64位'
const outDir = path.join(releaseDir, label)

// 只清本架构目录 + release 根目录的 exe/blockmap(保证识别与命名无歧义);
// 不清空 release/ 整体,另一个架构的目录与 unpacked 目录需保留。
rmSync(outDir, { recursive: true, force: true })
if (existsSync(releaseDir)) {
  for (const name of readdirSync(releaseDir)) {
    if (name.endsWith('.exe') || name.endsWith('.blockmap')) rmSync(path.join(releaseDir, name), { force: true })
  }
}

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

const child = spawn(
  process.execPath,
  [path.join(root, 'node_modules/electron-builder/cli.js'), '--win', 'nsis', 'portable', `--${arch}`],
  { cwd: root, env }
)
let log = ''
child.stdout.on('data', (c) => {
  log += c
  process.stdout.write(c)
})
child.stderr.on('data', (c) => {
  log += c
  process.stderr.write(c)
})
const code = await new Promise((resolve) => child.on('close', resolve))
if (code !== 0) {
  console.error(`electron-builder 退出码 ${code}`)
  process.exit(code ?? 1)
}

// 从构建日志确定产物路径;解析不到时回退到 release 根目录扫描(Setup 字样 = NSIS)
const artifacts = { nsis: null, portable: null }
for (const m of log.matchAll(/building\s+target=(nsis|portable)\s+file=(.+)/g)) {
  artifacts[m[1]] = path.resolve(root, m[2].trim().replace(/\s+archs?=.*$/, ''))
}
if (!artifacts.nsis || !artifacts.portable) {
  const exes = readdirSync(releaseDir)
    .filter((f) => f.endsWith('.exe'))
    .map((f) => path.join(releaseDir, f))
  artifacts.nsis ||= exes.find((f) => /setup/i.test(path.basename(f))) ?? null
  artifacts.portable ||= exes.find((f) => f !== artifacts.nsis) ?? null
}
if (!artifacts.nsis || !artifacts.portable || !existsSync(artifacts.nsis) || !existsSync(artifacts.portable)) {
  console.error('无法确定构建产物路径,release 根目录内容:', readdirSync(releaseDir))
  process.exit(1)
}

const nsisName = `${productName}-安装包-${pkg.version}-${label}.exe`
const portableName = `${productName}-便携版-${pkg.version}-${label}.exe`
mkdirSync(outDir, { recursive: true })
renameSync(artifacts.nsis, path.join(outDir, nsisName))
renameSync(artifacts.portable, path.join(outDir, portableName))
const blockmap = `${artifacts.nsis}.blockmap`
if (existsSync(blockmap)) renameSync(blockmap, path.join(outDir, `${nsisName}.blockmap`))

console.log(`\n完成:release/${label}/`)
for (const f of readdirSync(outDir)) console.log(`  ${f}`)
