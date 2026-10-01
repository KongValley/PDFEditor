// 同步 pdfjs 运行时资源(cmaps / 标准字体;v3 无 iccs/wasm)到 renderer public 目录
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', 'pdfjs-dist')
const dest = join(root, 'src', 'renderer', 'public')

// 先清空已知资源目录,避免版本降级后残留旧版本资源(如 v6 的 iccs/wasm)
for (const name of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
  rmSync(join(dest, name), { recursive: true, force: true })
}

for (const name of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
  const src = join(from, name)
  if (!existsSync(src)) continue
  cpSync(src, join(dest, name), { recursive: true })
  console.log(`[pdfjs-assets] 已同步 ${name}`)
}
