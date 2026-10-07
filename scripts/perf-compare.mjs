// 在两套 out/ 上各跑 N 次同一负载,汇总耗时/内存/CPU。
// 用法: node scripts/perf-compare.mjs <标签> [次数]
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const label = process.argv[2]
const runs = Number(process.argv[3] ?? 3)
const exe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

if (!existsSync(join(root, 'tmp', 'large.pdf'))) {
  console.error('缺少 tmp/large.pdf')
  process.exit(1)
}

const results = []
for (let run = 1; run <= runs; run++) {
  const out = join('tmp', `perf-${label}-${run}.json`)
  const r = spawnSync(exe, ['.', `--user-data-dir=tmp/udd-perf-${label}-${run}`], {
    cwd: root,
    env: {
      ...process.env,
      PDF_EDITOR_SMOKE: '1',
      PDF_EDITOR_SMOKE_SCRIPT: 'scripts/perf-probe.js',
      PDF_EDITOR_SMOKE_OUT: out,
      PDF_EDITOR_SMOKE_TIMEOUT: '120000',
      PDF_EDITOR_SMOKE_SETTLE: '300',
      PDF_EDITOR_SMOKE_ROOT: root
    },
    stdio: 'ignore',
    timeout: 180000
  })
  if (r.status !== 0) console.error(`[${label} run ${run}] exit=${r.status}`)
  const json = JSON.parse(readFileSync(join(root, out), 'utf8'))
  results.push(json)
}

const ok = results.filter((r) => r.ok)
if (!ok.length) {
  console.error(`[${label}] 全部失败:`, results[0]?.error)
  process.exit(1)
}
const med = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const pick = (fn) => med(ok.map(fn))
const proc = (r, type) => r.metrics?.processes?.find((p) => p.type === type) ?? {}

const summary = {
  label,
  runs: ok.length,
  openMs: pick((r) => r.result.openMs),
  scrollMs: pick((r) => r.result.scrollMs),
  scrollFrames: pick((r) => r.result.scrollFrames),
  blockingMs: pick((r) => r.result.blockingMs),
  longTasks: pick((r) => r.result.longTasks),
  continuousScrollMs: pick((r) => r.result.continuousScrollMs),
  continuousScrollFrames: pick((r) => r.result.continuousScrollFrames),
  continuousBlockingMs: pick((r) => r.result.continuousBlockingMs),
  continuousCanvases: pick((r) => r.result.continuousCanvases),
  jsHeapAfterOpenMB: pick((r) => r.result.heap.afterOpen),
  jsHeapIdleMB: pick((r) => r.result.heap.idle),
  rendererRssMB: pick((r) => proc(r, 'Tab').rssMB ?? 0),
  browserRssMB: pick((r) => proc(r, 'Browser').rssMB ?? 0),
  gpuRssMB: pick((r) => proc(r, 'GPU').rssMB ?? 0),
  totalRssMB: pick((r) => (r.metrics?.processes ?? []).reduce((s, p) => s + (p.rssMB ?? 0), 0)),
  rendererCpuPeak: pick((r) => proc(r, 'Tab').cpuPeakPercent ?? 0),
  browserCpuPeak: pick((r) => proc(r, 'Browser').cpuPeakPercent ?? 0),
  range: ok[0].result.range
}
console.log(JSON.stringify(summary, null, 2))
