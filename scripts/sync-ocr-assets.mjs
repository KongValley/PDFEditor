// 同步 OCR 运行时资产(tesseract.js worker / wasm 核心 / osd 语言数据)到 renderer public 目录
// 语言数据在 npm 包里是 .gz:构建期解压成 .traineddata,运行时不依赖解压能力,也不用往仓库塞二进制
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modules = join(root, 'node_modules')
const dest = join(root, 'src', 'renderer', 'public', 'ocr')

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

cpSync(join(modules, 'tesseract.js', 'dist', 'worker.min.js'), join(dest, 'worker.min.js'))
// 不带 SIMD 的核:老 Win7 机器的 CPU 不一定有 WASM SIMD,只带一份就不必按特性分发(代价是慢一点)
cpSync(join(modules, 'tesseract.js-core', 'tesseract-core.wasm.js'), join(dest, 'tesseract-core.wasm.js'))
writeFileSync(
  join(dest, 'osd.traineddata'),
  gunzipSync(readFileSync(join(modules, '@tesseract.js-data', 'osd', '4.0.0', 'osd.traineddata.gz')))
)
writeFileSync(
  join(dest, 'LICENSE-osd.txt'),
  'Tesseract osd 语言数据(整页朝向 / 书写系统检测)\n' +
    '来源:npm @tesseract.js-data/osd 4.0.0(上游 tesseract-ocr/tessdata)\n' +
    '许可:Apache-2.0\n'
)
console.log('[ocr-assets] 已同步 worker.min.js / tesseract-core.wasm.js / osd.traineddata')
