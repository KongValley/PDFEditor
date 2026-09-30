// 同步 pdfjs 运行时资源(cmaps / 标准字体 / ICC / wasm)到 renderer public 目录
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', 'pdfjs-dist')
const dest = join(root, 'src', 'renderer', 'public')

for (const name of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
  const src = join(from, name)
  if (!existsSync(src)) continue
  const target = join(dest, name)
  rmSync(target, { recursive: true, force: true })
  cpSync(src, target, { recursive: true })
  console.log(`[pdfjs-assets] 已同步 ${name}`)
}
