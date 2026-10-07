// 交错对比:同一批次内交替跑 1.8.1 / 1.9.0,抵消系统漂移;输出成对差值与中位数。
// 用法: node scripts/perf-interleave.mjs [对数]
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const buildA = { name: '1.8.1', root: join(here, '..', '..', 'pdf-editor-181') }
const buildB = { name: '1.9.0', root: join(here, '..') }
const pairs = Number(process.argv[2] ?? 5)

for (const b of [buildA, buildB]) {
  if (!existsSync(join(b.root, 'tmp', 'large.pdf'))) {
    console.error(`缺少 ${b.name} 的 tmp/large.pdf`)
    process.exit(1)
  }
}

function run(build, tag) {
  const exe = join(build.root, 'node_modules', 'electron', 'dist', 'electron.exe')
  const out = join('tmp', `perf-${tag}.json`)
  const r = spawnSync(exe, ['.', `--user-data-dir=tmp/udd-${tag}`], {
    cwd: build.root,
    env: {
      ...process.env,
      PDF_EDITOR_SMOKE: '1',
      PDF_EDITOR_SMOKE_SCRIPT: 'scripts/perf-probe.js',
      PDF_EDITOR_SMOKE_OUT: out,
      PDF_EDITOR_SMOKE_TIMEOUT: '240000',
      PDF_EDITOR_SMOKE_SETTLE: '300',
      PDF_EDITOR_SMOKE_ROOT: build.root
    },
    stdio: 'ignore',
    timeout: 240000
  })
  if (r.status !== 0) return null
  const j = JSON.parse(readFileSync(join(build.root, out), 'utf8'))
  return j.ok ? j : null
}

const med = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}
const rows = []
for (let i = 1; i <= pairs; i++) {
  // 交替顺序(偶/奇颠倒),进一步抵消预热偏差
  const order = i % 2 ? [buildA, buildB] : [buildB, buildA]
  for (const b of order) {
    const res = run(b, `${b.name.replace(/\./g, '')}-p${i}`)
    if (res) rows.push({ build: b.name, pair: i, res })
    process.stderr.write(`[${b.name} pair ${i}] ${res ? 'ok' : 'FAIL'}\n`)
  }
}

const field = (j, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), j)
const METRICS = [
  ['openMs', 'result.openMs'],
  ['jumpBlockingMs', 'result.blockingMs'],
  ['jumpLongTasks', 'result.longTasks'],
  ['contScrollMs', 'result.continuousScrollMs'],
  ['contBlockingMs', 'result.continuousBlockingMs'],
  ['heapOpenMB', 'result.heap.afterOpen'],
  ['heapIdleMB', 'result.heap.idle'],
  ['rendererRssMB', 'proc:Tab'],
  ['totalRssMB', 'totalRss'],
  ['rendererCpuPeak', 'cpu:Tab']
]

const valueOf = (j, m) => {
  if (m.startsWith('proc:')) {
    const p = (j.metrics?.processes ?? []).find((x) => x.type === m.slice(5))
    return p?.rssMB ?? null
  }
  if (m.startsWith('cpu:')) {
    const p = (j.metrics?.processes ?? []).find((x) => x.type === m.slice(4))
    return p?.cpuPeakPercent ?? null
  }
  if (m === 'totalRss') return (j.metrics?.processes ?? []).reduce((s, p) => s + (p.rssMB ?? 0), 0)
  return field(j, m)
}

const summary = { pairs, runsA: rows.filter((r) => r.build === buildA.name).length, runsB: rows.filter((r) => r.build === buildB.name).length, metrics: {} }
for (const [label, path] of METRICS) {
  const a = rows.filter((r) => r.build === buildA.name).map((r) => valueOf(r.res, path)).filter((v) => typeof v === 'number' && v >= 0)
  const b = rows.filter((r) => r.build === buildB.name).map((r) => valueOf(r.res, path)).filter((v) => typeof v === 'number' && v >= 0)
  if (!a.length || !b.length) continue
  const ma = med(a)
  const mb = med(b)
  summary.metrics[label] = {
    '1.8.1': ma,
    '1.9.0': mb,
    delta: mb - ma,
    deltaPct: ma ? Number((((mb - ma) / ma) * 100).toFixed(1)) : null,
    rangeA: `${Math.min(...a)}..${Math.max(...a)}`,
    rangeB: `${Math.min(...b)}..${Math.max(...b)}`
  }
}
console.log(JSON.stringify(summary, null, 2))
