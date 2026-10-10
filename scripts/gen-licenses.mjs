// 生成随包第三方许可清单:Vite 打进 bundle 的运行时依赖 + electron 运行时 + 内置字体/CMaps
// 注:所有包都在 devDependencies(依赖全部由 electron-vite 打进 out/,asar 不含 node_modules,
// 见 README「10. 构建」),因此按「是否打进产物」界定,不再看 dependencies/dev 标记。
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Vite 打进 bundle 的运行时包(直接依赖);构建工具(vite/electron-builder/vue-tsc 等)不随包分发,传递闭包在下方遍历补齐 */
const BUNDLED_RUNTIME = [
  'vue',
  '@vue/runtime-dom',
  '@vue/runtime-core',
  '@vue/reactivity',
  '@vue/shared',
  'pdfjs-dist',
  'pdf-lib',
  '@pdf-lib/fontkit'
]

/** 个别包的 LICENSE 不在包根(记录其相对路径) */
const LICENSE_PATH_OVERRIDES = {}

const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice)/i
const MAX_TEXT = 100000

function licenseText(pkgDir, override) {
  if (override) {
    try {
      return readFileSync(join(pkgDir, override), 'utf8')
    } catch {
      // 指定路径读取失败时退回目录扫描
    }
  }
  let names = []
  try {
    names = readdirSync(pkgDir)
  } catch {
    return null
  }
  const file = names.find((name) => LICENSE_FILE_RE.test(name) && statSync(join(pkgDir, name)).isFile())
  if (!file) return null
  const text = readFileSync(join(pkgDir, file), 'utf8')
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…(截断)` : text
}

/** 包内无 LICENSE 文件时:从 README 提取「License」小节,再不行给 SPDX 短语(条目不缺文本) */
function licenseTextFallback(name, dir, spdx) {
  try {
    const readme = readFileSync(join(dir, 'README.md'), 'utf8')
    const at = readme.toLowerCase().lastIndexOf('## license')
    if (at >= 0) {
      const section = readme.slice(at, at + 4000).trim()
      return `${section}\n\n(${name} 包内无独立 LICENSE 文件,以上摘自其 README)`
    }
  } catch {
    // README 也没有:落到 SPDX 短语
  }
  return `${spdx ?? 'Unknown'} License — ${name} 随应用二进制分发,著作权归原作者所有。`
}

function packageEntry(name, dir, version) {
  let pkg = {}
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    // 包目录缺失时降级为 lockfile 信息
  }
  const license = pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : null)
  const text = licenseText(dir, LICENSE_PATH_OVERRIDES[name])
  return {
    name,
    version: version ?? pkg.version ?? '',
    license,
    homepage: pkg.homepage ?? null,
    text: text ?? licenseTextFallback(name, dir, license)
  }
}

const entries = []
// 1) 打进 bundle 的运行时依赖及其传递闭包(node_modules 实目录遍历)
const runtimeClosure = new Set()
const visit = (name) => {
  if (runtimeClosure.has(name)) return
  const pkgPath = join(root, 'node_modules', name)
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'))
  } catch {
    return
  }
  runtimeClosure.add(name)
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep)
}
for (const name of BUNDLED_RUNTIME) visit(name)
for (const name of runtimeClosure) entries.push(packageEntry(name, join(root, 'node_modules', name), null))
// 2) 打进的 tesseract.js dist 是自包含 bundle(它的 node-only 依赖没进产物,不能走闭包遍历),连同 wasm 核一起登记
for (const name of ['tesseract.js', 'tesseract.js-core']) {
  entries.push(packageEntry(name, join(root, 'node_modules', name), null))
}
// 3) 内置资源许可(pdf.js 标准字体 / CMaps / OCR 语言数据)
const ASSETS = [
  {
    name: 'Foxit standard fonts (PDFium)',
    license: 'BSD-3-Clause',
    homepage: 'https://github.com/mozilla/pdf.js',
    path: 'src/renderer/public/standard_fonts/LICENSE_FOXIT'
  },
  {
    name: 'Liberation fonts',
    license: 'SIL OFL 1.1',
    homepage: 'https://github.com/liberationfonts/liberation-fonts',
    path: 'src/renderer/public/standard_fonts/LICENSE_LIBERATION'
  },
  {
    name: 'pdf.js CMaps',
    license: 'Apache-2.0',
    homepage: 'https://github.com/mozilla/pdf.js',
    path: 'src/renderer/public/cmaps/LICENSE'
  },
  {
    name: 'Tesseract osd traineddata(整页朝向识别的语言数据)',
    license: 'Apache-2.0',
    homepage: 'https://github.com/tesseract-ocr/tessdata',
    path: 'src/renderer/public/ocr/LICENSE-osd.txt'
  }
]
for (const asset of ASSETS) {
  let text = null
  try {
    text = readFileSync(join(root, asset.path), 'utf8')
  } catch {
    // 文件缺失时留空,由清单标注
  }
  entries.push({ name: asset.name, version: '', license: asset.license, homepage: asset.homepage, text })
}

const seen = new Set()
const unique = entries
  .filter((entry) => {
    const key = `${entry.name}@${entry.version}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const missing = unique.filter((entry) => !entry.text)
const outPath = join(root, 'src', 'renderer', 'public', 'third-party-notices.json')
writeFileSync(outPath, `${JSON.stringify({ entries: unique }, null, 2)}\n`, 'utf8')
console.log(
  `[licenses] 已生成 ${outPath}(${unique.length} 条${missing.length ? `;无许可文本:${missing.map((e) => e.name).join(', ')}` : ''})`
)