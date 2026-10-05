// 把 README.md(操作手册)渲染为 PDF:Markdown → 带打印样式的 HTML → Edge/Chrome headless 打印
// 用法:node scripts/manual-to-pdf.mjs
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcMd = join(root, 'README.md')
const outPdf = join(root, '操作手册.pdf')
const tmpDir = join(root, 'tmp')
const tmpHtml = join(tmpDir, 'manual.html')

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
]

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 行内标记:先转义,再处理 `code`、**bold**、[text](url) */
function inline(text) {
  let out = escapeHtml(text)
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')
  out = out.replace(/(?<!["'>])(https?:\/\/[^\s<)]+)/g, '<a href="$1">$1</a>')
  return out
}

function markdownToHtml(md) {
  const lines = md.split(/\r?\n/)
  const html = []
  let i = 0
  let listType = null

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // 代码块
    if (line.startsWith('```')) {
      closeList()
      const buffer = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) buffer.push(lines[i++])
      i++
      html.push(`<pre><code>${escapeHtml(buffer.join('\n'))}</code></pre>`)
      continue
    }

    // 表格(表头 + 分隔行)
    if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      closeList()
      const cells = (row) =>
        row
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim())
      const head = cells(line)
      i += 2
      const body = []
      while (i < lines.length && /^\|/.test(lines[i])) body.push(cells(lines[i++]))
      html.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>')
      for (const row of body) {
        html.push('<tr>' + row.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>')
      }
      html.push('</tbody></table>')
      continue
    }

    // 分隔线
    if (/^---+\s*$/.test(line)) {
      closeList()
      html.push('<hr>')
      i++
      continue
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1].length
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i++
      continue
    }

    // 列表(顶层 `- ` 与 `1. `;缩进项并入上一行说明)
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const ordered = /^\d+\.\s+(.*)$/.exec(line)
    if (bullet || ordered) {
      const type = bullet ? 'ul' : 'ol'
      if (listType !== type) {
        closeList()
        html.push(`<${type}>`)
        listType = type
      }
      const items = [bullet ? bullet[1] : ordered[1]]
      i++
      // 续行(缩进的非空行)拼接到当前列表项
      while (i < lines.length && /^\s{2,}\S/.test(lines[i])) items.push(lines[i++].trim())
      html.push(`<li>${inline(items.join(' '))}</li>`)
      continue
    }

    // 空行
    if (line.trim() === '') {
      closeList()
      i++
      continue
    }

    // 段落
    closeList()
    const paragraph = [line]
    i++
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|\||```|---|[-*]\s|\d+\.\s)/.test(lines[i])) {
      paragraph.push(lines[i++])
    }
    html.push(`<p>${inline(paragraph.join(' '))}</p>`)
  }
  closeList()
  return html.join('\n')
}

const CSS = `
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
body {
  font-family: "Microsoft YaHei", "SimSun", "PingFang SC", sans-serif;
  font-size: 10.5pt; line-height: 1.7; color: #1c1f26; margin: 0;
}
h1 { font-size: 20pt; margin: 0 0 4mm; padding-bottom: 2mm; border-bottom: 2px solid #1971c2; }
h2 { font-size: 14.5pt; margin: 7mm 0 3mm; padding-left: 3mm; border-left: 4px solid #1971c2; page-break-after: avoid; }
h3 { font-size: 12pt; margin: 5mm 0 2mm; color: #14406f; page-break-after: avoid; }
h4 { font-size: 11pt; margin: 4mm 0 2mm; page-break-after: avoid; }
p { margin: 0 0 2.4mm; }
ul, ol { margin: 0 0 2.6mm; padding-left: 6mm; }
li { margin: 0 0 1.2mm; }
code { font-family: Consolas, "Courier New", monospace; background: #f1f3f7; border: 1px solid #e2e6ee; border-radius: 2px; padding: 0 1mm; font-size: 9.5pt; }
pre { background: #f6f8fb; border: 1px solid #dde3ec; border-radius: 3px; padding: 3mm; overflow: hidden; page-break-inside: avoid; }
pre code { background: none; border: none; padding: 0; font-size: 9pt; line-height: 1.5; }
table { width: 100%; border-collapse: collapse; margin: 0 0 3mm; page-break-inside: auto; }
th, td { border: 1px solid #c9d2de; padding: 1.6mm 2mm; text-align: left; vertical-align: top; font-size: 10pt; }
th { background: #eef3fa; font-weight: 600; }
tr { page-break-inside: avoid; }
hr { border: none; border-top: 1px solid #d5dbe5; margin: 5mm 0; }
a { color: #1971c2; text-decoration: none; word-break: break-all; }
strong { color: #10131a; }
`

const md = readFileSync(srcMd, 'utf8')
const bodyHtml = markdownToHtml(md)
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>PDF 编辑器 操作手册</title><style>${CSS}</style></head>
<body>${bodyHtml}</body></html>`

mkdirSync(tmpDir, { recursive: true })
writeFileSync(tmpHtml, html, 'utf8')

const browser = BROWSER_CANDIDATES.find((p) => existsSync(p))
if (!browser) {
  console.error('未找到 Edge/Chrome,无法打印 PDF。候选路径:\n' + BROWSER_CANDIDATES.join('\n'))
  process.exit(1)
}

rmSync(outPdf, { force: true })
const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-pdf-header-footer',
  `--print-to-pdf=${outPdf}`,
  `file:///${tmpHtml.replace(/\\/g, '/').replace(/^\/?/, '')}`
]
const result = spawnSync(browser, args, { stdio: 'inherit' })
if (!existsSync(outPdf)) {
  console.error(`PDF 生成失败(exit=${result.status})`)
  process.exit(1)
}
rmSync(tmpHtml, { force: true })
console.log(`已生成:${outPdf}`)
