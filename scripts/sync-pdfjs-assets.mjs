// 同步 pdfjs 运行时资源(cmaps / 标准字体;v3 无 iccs/wasm)到 renderer public 目录
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', 'pdfjs-dist')
const dest = join(root, 'src', 'renderer', 'public')
const names = ['cmaps', 'standard_fonts', 'iccs', 'wasm']

// 依赖未变即跳过:dist 一次跑 4 遍 build,每遍都重删重拷约 1.9MB × 184 个文件纯属重复劳动。
// stamp 绑定 package-lock.json 的内容哈希,版本降级后必然失效,不会残留旧资源。
const lockHash = createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex')
const stampPath = join(dest, '.pdfjs-sync-stamp.json')
const stampEntries = names.flatMap((name) => {
  const src = join(from, name)
  return existsSync(src) ? [name] : []
})
const stampCurrent = () => {
  try {
    const parsed = JSON.parse(readFileSync(stampPath, 'utf8'))
    return (
      parsed['lockHash'] === lockHash &&
      Array.isArray(parsed['entries']) &&
      parsed['entries'].length === stampEntries.length &&
      stampEntries.every((name) => existsSync(join(dest, name)))
    )
  } catch {
    return false
  }
}
if (stampCurrent()) {
  console.log('[pdfjs-assets] 已是最新,跳过')
} else {
  // 先清空已知资源目录,避免版本降级后残留旧版本资源(如 v6 的 iccs/wasm)
  for (const name of names) {
    rmSync(join(dest, name), { recursive: true, force: true })
  }

  for (const name of names) {
    const src = join(from, name)
    if (!existsSync(src)) continue
    cpSync(src, join(dest, name), { recursive: true })
    console.log(`[pdfjs-assets] 已同步 ${name}`)
  }
  writeFileSync(stampPath, `${JSON.stringify({ lockHash, entries: stampEntries })}\n`, 'utf8')
}
