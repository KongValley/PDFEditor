// 兼容性护栏:构建产物中出现超出目标运行时的新特性即非零退出。
//
// 目标:Electron 22.3.27 = Chromium 108 / Node 16.17(main、preload)。
// 为什么需要本脚本:build.target 只降级语法,不拦"新 API";CSS 侧 electron-vite 的 renderer
// 预设 minify=false 且没有 lightningcss/postcss,build.target 对 CSS 完全不生效(原样透传),
// 写一句 color-mix() 既不会降级也不会报错,只在 Win7/老 Chromium 上静默失效。
//
// 名单是**保守超集**:个别条目在目标运行时其实已可用(如 Object.hasOwn、scrollbar-gutter),
// 列在这里是为了"新特性进入产物"这件事必须过一次人工判断,而不是等到内网机器上才发现不显示。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
const CHROME_TARGET = 108
const NODE_TARGET = '16.17'

/** main / preload 与 renderer 分档:structuredClone 在主进程要 Node 17,在渲染层 Chrome 98 就有 */
const JS_BAN = [
  { id: 'structuredClone(', re: /structuredClone\(/, chrome: 98, node: 17 },
  { id: 'Object.hasOwn(', re: /Object\.hasOwn\(/, chrome: 93, node: 16.9 },
  { id: 'Array.fromAsync(', re: /Array\.fromAsync\(/, chrome: 122, node: 22 },
  { id: 'Promise.withResolvers(', re: /Promise\.withResolvers\(/, chrome: 119, node: 22 },
  { id: 'Object.groupBy(', re: /Object\.groupBy\(/, chrome: 117, node: 21 },
  { id: 'Map.groupBy(', re: /Map\.groupBy\(/, chrome: 117, node: 21 },
  { id: '.toSorted(', re: /\.toSorted\(/, chrome: 110, node: 20 },
  { id: '.toReversed(', re: /\.toReversed\(/, chrome: 110, node: 20 },
  { id: '.toSpliced(', re: /\.toSpliced\(/, chrome: 110, node: 20 },
  { id: '.findLast(', re: /\.findLast\(/, chrome: 97, node: 18 },
  { id: '.findLastIndex(', re: /\.findLastIndex\(/, chrome: 97, node: 18 },
  { id: 'isWellFormed(', re: /isWellFormed\(/, chrome: 111, node: 20 },
  { id: 'AbortSignal.timeout(', re: /AbortSignal\.timeout\(/, chrome: 103, node: 17.3 },
  // 收紧到 Array.prototype.group 本体:pdf.js 的 OperatorList 有 this.group(opTreeElement.items)
  { id: 'Array.prototype.group(', re: /Array\.prototype\.group\b/, chrome: 117, node: 21 },
  { id: 'navigator.gpu', re: /navigator\.gpu\b/, chrome: 113, node: 21 }
]

// .at(、replaceAll、atob/btoa、OffscreenCanvas 在目标运行时均已支持,故意不进名单
/** CSS 只在 .css 产物上扫:CSS 不降级,不支持的特性不会报错、只会静默失效 */
const CSS_BAN = [
  { id: 'oklch(', re: /oklch\(/, chrome: 111 },
  { id: 'oklab(', re: /oklab\(/, chrome: 111 },
  { id: 'color-mix(', re: /color-mix\(/, chrome: 111 },
  { id: 'light-dark(', re: /light-dark\(/, chrome: 123 },
  { id: '@layer', re: /@layer\b/, chrome: 99 },
  { id: '@container', re: /@container\b/, chrome: 105 },
  { id: ':has(', re: /:has\(/, chrome: 105 },
  { id: 'text-wrap:', re: /text-wrap\s*:/, chrome: 114 },
  { id: 'scrollbar-gutter', re: /scrollbar-gutter/, chrome: 94 },
  { id: 'overflow: clip', re: /overflow\s*:\s*clip\b/, chrome: 90 },
  { id: 'subgrid', re: /subgrid/, chrome: 117 },
  { id: 'popover', re: /\bpopover\b/, chrome: 114 },
  { id: '::backdrop', re: /::backdrop\b/, chrome: 76 },
  { id: 'field-sizing', re: /field-sizing/, chrome: 123 },
  { id: 'anchor-name', re: /anchor-name/, chrome: 125 },
  { id: 'view-timeline', re: /view-timeline/, chrome: 115 },
  { id: 'container-type', re: /container-type/, chrome: 105 },
  { id: '@media (width <', re: /@media[^{]*\([^{]*\bwidth\s*</, chrome: 104 }
]

function pick(dir, re) {
  const abs = join(outDir, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((name) => re.test(name))
    .map((name) => join(abs, name))
}

const nodeFiles = ['main/index.js', 'preload/index.js'].map((p) => join(outDir, p))
const chromeFiles = [...pick('renderer/assets', /^index-.*\.js$/), ...pick('renderer/assets', /^pdf\.worker\.min-.*\.js$/)]
const cssFiles = pick('renderer/assets', /^index-.*\.css$/)

const missing = [
  ...nodeFiles.filter((f) => !existsSync(f)),
  ...(chromeFiles.length === 0 ? [join(outDir, 'renderer/assets/index-*.js')] : []),
  ...(cssFiles.length === 0 ? [join(outDir, 'renderer/assets/index-*.css')] : [])
]
if (missing.length > 0) {
  console.error(`缺少构建产物(${missing.map((f) => relative(root, f)).join('、')}),请先运行 npm run build`)
  process.exit(1)
}

const hits = []

function scan(file, text, rules, describe) {
  for (const rule of rules) {
    if (!rule.re.test(text)) continue
    hits.push(`${relative(root, file).split('\\').join('/')} · ${rule.id} · ${describe(rule)}`)
  }
}

for (const file of nodeFiles) {
  const text = readFileSync(file, 'utf8')
  scan(
    file,
    text,
    JS_BAN,
    (r) => `需 Node ${r.node},目标 Node ${NODE_TARGET}(Electron 22)`
  )
}
for (const file of chromeFiles) {
  const text = readFileSync(file, 'utf8')
  // renderer 侧 Chrome 98 起就有 structuredClone,从名单里去掉
  const rules = JS_BAN.filter((r) => r.id !== 'structuredClone(')
  scan(
    file,
    text,
    rules,
    (r) => `需 Chrome ${r.chrome},目标 Chromium ${CHROME_TARGET}(Electron 22)`
  )
}
for (const file of cssFiles) {
  const text = readFileSync(file, 'utf8')
  scan(file, text, CSS_BAN, (r) => `需 Chrome ${r.chrome},目标 Chromium ${CHROME_TARGET}(Electron 22);CSS 不降级`)
}

const total = nodeFiles.length + chromeFiles.length + cssFiles.length
if (hits.length === 0) {
  console.log(`兼容检查通过:${total} 个产物,0 处超目标特性`)
  process.exit(0)
}
for (const hit of hits) console.log(`超目标特性 · ${hit}`)
console.log(`\n合计 ${hits.length} 处超目标特性(共扫描 ${total} 个产物)`)
process.exit(1)