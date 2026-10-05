// 生成随包第三方许可清单:生产依赖(electron-builder 打进 asar)+ Vite 打进 bundle 的 vue 运行时 + 内置字体/CMaps
// 输出:src/renderer/public/third-party-notices.json(应用内「关于」读取;并作为 extraResources 随安装包附带)
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))

/** Vite 会把这些 devDependencies 编译进 bundle,但不随 node_modules 分发,需单列 */
const BUNDLED_DEV = ['vue', '@vue/runtime-dom', '@vue/runtime-core', '@vue/reactivity', '@vue/shared']

const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice)/i
const MAX_TEXT = 100000

function licenseText(pkgDir) {
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

function packageEntry(name, dir, version) {
  let pkg = {}
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    // 包目录缺失时降级为 lockfile 信息
  }
  const license = pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : null)
  return { name, version: version ?? pkg.version ?? '', license, homepage: pkg.homepage ?? null, text: licenseText(dir) }
}

const entries = []
// 1) 生产依赖树(lockfile v3 packages 中非 dev 条目;含 pdfjs-dist 的 optional 依赖)
for (const [key, meta] of Object.entries(lock.packages ?? {})) {
  if (!key || meta.dev) continue
  entries.push(packageEntry(key.split('node_modules/').pop(), join(root, key), meta.version))
}
// 2) 打进 bundle 的 vue 运行时(devDependencies)
for (const name of BUNDLED_DEV) {
  const dir = join(root, 'node_modules', name)
  try {
    statSync(dir)
  } catch {
    continue
  }
  entries.push(packageEntry(name, dir, null))
}
// 3) 内置资源许可(pdf.js 标准字体 / CMaps)
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