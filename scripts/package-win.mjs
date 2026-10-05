// 单架构打包:node scripts/package-win.mjs <win7-ia32|win10-x64|win10-ia32|win7-x64>
// 各组合 → release/<中文目录>/,含安装包(NSIS)与便携版,文件名自明。
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 随 Win7 分发目录附带的补丁安装说明(写入 前置补丁/安装说明.txt)
const PATCH_README = `Windows 7 前置补丁(适用于本目录中的安装包/便携版)

前提:Windows 7 SP1。
安装顺序:先装 KB4490628,再装 KB4474419;KB2533623、KB2670838 顺序不限。双击 .msu 逐个安装,提示重启就重启。

- KB2533623  强烈建议 — 提供 DLL 安全加载 API(SetDefaultDllDirectories);缺失时应用按旧式加载运行,老系统若报「无法定位程序输入点 SetDefaultDllDirectories 于动态链接库 KERNEL32.dll」补装它即可
- KB2670838  推荐 — Windows 7 平台更新(DirectWrite 1.1);未装时页面文字可能渲染模糊
- KB4490628  推荐 — 维护堆栈(KB4474419 的前置)
- KB4474419  推荐 — SHA-2 代码签名支持;企业内网更新分发与签名校验链路需要

官方下载地址(缺失时补取;下载页选 Windows 7 / 6.1、32 位或 64 位):
- KB2533623:https://support.microsoft.com/kb/2533623 (支持页,内含 x86/x64 下载入口)
- KB2670838:https://www.microsoft.com/en-us/download/details.aspx?id=36805
- KB4490628:https://www.catalog.update.microsoft.com/Search.aspx?q=KB4490628
- KB4474419:https://www.catalog.update.microsoft.com/Search.aspx?q=KB4474419

本应用完全离线运行,不联网、不校验代码签名;补上这些补丁可消除老系统上的兼容与渲染问题。
补丁来自 Microsoft 官方渠道,均带 Microsoft 数字签名;Win10 及以上系统不需要这些补丁。
`

// os → 打包目录名(中文,内网分发直观);arch → electron 架构 + 文件名后缀
const combos = {
  'win7-ia32': { os: 'Win7', arch: 'ia32' },
  'win10-x64': { os: 'Win10', arch: 'x64' },
  'win10-ia32': { os: 'Win10', arch: 'ia32' },
  'win7-x64': { os: 'Win7', arch: 'x64' }
}
const combo = process.argv[2]
if (!(combo in combos)) {
  console.error(`用法: node scripts/package-win.mjs <${Object.keys(combos).join('|')}>`)
  process.exit(1)
}
const { os, arch } = combos[combo]
const label = `${os}-${arch === 'ia32' ? '32位' : '64位'}`
const archLabel = combo

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const releaseDir = path.join(root, 'release')
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
  [path.join(root, 'node_modules/electron-builder/cli.js'), '--win', 'nsis', 'portable', `--${arch}`, '--publish', 'never'],
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

// 产物文件名用 ASCII:GitHub Release 资产名不接受中文
const nsisName = `pdf-editor-setup-${pkg.version}-${archLabel}.exe`
const portableName = `pdf-editor-portable-${pkg.version}-${archLabel}.exe`
mkdirSync(outDir, { recursive: true })
renameSync(artifacts.nsis, path.join(outDir, nsisName))
renameSync(artifacts.portable, path.join(outDir, portableName))
const blockmap = `${artifacts.nsis}.blockmap`
if (existsSync(blockmap)) renameSync(blockmap, path.join(outDir, `${nsisName}.blockmap`))

// Win7 前置补丁:从 win7-patches/ 复制本架构 .msu 到分发目录;无补丁源时只提示不失败(CI 无此目录)
if (os === 'Win7') {
  const patchSrc = path.join(root, 'win7-patches')
  const archToken = arch === 'ia32' ? /(^|[-_])x86([-_.]|$)/ : /(^|[-_])x64([-_.]|$)/
  const patches = existsSync(patchSrc)
    ? readdirSync(patchSrc).filter((f) => /\.msu$/i.test(f) && f.includes('6.1') && archToken.test(f.toLowerCase()))
    : []
  if (patches.length > 0) {
    const patchDir = path.join(outDir, '前置补丁')
    mkdirSync(patchDir, { recursive: true })
    for (const f of patches) copyFileSync(path.join(patchSrc, f), path.join(patchDir, f))
    writeFileSync(path.join(patchDir, '安装说明.txt'), PATCH_README, 'utf8')
  } else {
    console.log('  提示:win7-patches/ 无匹配的本架构 .msu,跳过「前置补丁」(见 README §1)')
  }
}

console.log(`\n完成:release/${label}/`)
for (const f of readdirSync(outDir)) console.log(`  ${f}`)
