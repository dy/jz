#!/usr/bin/env node
// Regression gate: jz-compiled-to-native must be faster than V8-hosted on every example.
//
// For each .wat in $EX_DIR:
//   - Runs the native binary (whose harness already takes median of 90 samples)
//   - Runs the V8 baseline (median of 30 samples in the JS process)
//   - Compares and asserts native < V8
//
// Each side is invoked 3 times; we take the min to suppress macOS scheduler jitter.
// Exits non-zero on any regression.
//
// Env:
//   BIN     — native binary. Default: /tmp/jz-c/watr-native
//   EX_DIR  — examples dir.  Default: <jz>/node_modules/watr/test/example
//   ITERS   — iters per run. Default: 30
//   RUNS    — invocations per side. Default: 3
//   MARGIN  — required win factor. Default: 1.0 (must be strictly faster)
//
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const JZ_ROOT = path.resolve(__dirname, '..')

const BIN = process.env.BIN || '/tmp/jz-c/watr-native'
// watr's published package omits test fixtures; look in a sibling watr checkout.
const EX_CANDIDATES = [
  process.env.EX_DIR,
  path.resolve(JZ_ROOT, '../watr/test/example'),
  path.join(JZ_ROOT, 'node_modules/watr/test/example'),
].filter(Boolean)
const EX_DIR = EX_CANDIDATES.find(d => fs.existsSync(d))
const ITERS = parseInt(process.env.ITERS || '30')
const RUNS = parseInt(process.env.RUNS || '3')
const MARGIN = parseFloat(process.env.MARGIN || '1.0')

if (!fs.existsSync(BIN)) {
  console.error(`native binary not found: ${BIN}`)
  console.error(`build it first: ${path.join(__dirname, 'native/build.sh')}`)
  process.exit(2)
}
if (!EX_DIR) {
  console.error(`examples dir not found. Tried:\n  ${EX_CANDIDATES.join('\n  ')}`)
  console.error(`set EX_DIR to a directory of .wat fixtures (e.g. watr/test/example)`)
  process.exit(2)
}

const min = (xs) => xs.reduce((a, b) => a < b ? a : b)

function benchNative(file) {
  const samples = []
  for (let i = 0; i < RUNS; i++) {
    const r = spawnSync(BIN, [file, String(ITERS)], { encoding: 'utf8' })
    if (r.status !== 0) { console.error(`native failed on ${file}:\n${r.stderr}`); process.exit(3) }
    // stdout: path \t inLen \t outLen \t ms
    samples.push(parseFloat(r.stdout.trim().split('\t')[3]))
  }
  return min(samples)
}

// Each V8 run gets a fresh node process. Otherwise the 2nd/3rd in-process run sees
// V8 already at peak tier-up (effectively measuring fully-optimized V8 vs cold native).
// We want steady-state V8 perf, so we burn enough warmup time for TurboFan to settle:
// at least 200 iters AND 200ms of total warmup work (whichever takes longer).
// This isolates intrinsic compile speed from V8 tier-up jitter.
const V8_BENCH_SCRIPT = `
import fs from 'fs'
import { compile } from 'watr'
const wat = fs.readFileSync(process.argv[1], 'utf8')
const iters = +process.argv[2]
let warmStart = performance.now(), warmIters = 0
while (warmIters < 200 || performance.now() - warmStart < 200) { compile(wat); warmIters++ }
const t = performance.now()
for (let i = 0; i < iters; i++) compile(wat)
process.stdout.write(((performance.now() - t) / iters).toFixed(3))
`
function benchV8(file) {
  const samples = []
  for (let i = 0; i < RUNS; i++) {
    const r = spawnSync('node', ['--input-type=module', '-e', V8_BENCH_SCRIPT, '--', file, String(ITERS)], {
      encoding: 'utf8', cwd: JZ_ROOT,
    })
    if (r.status !== 0) { console.error(`v8 failed on ${file}:\n${r.stderr}`); process.exit(3) }
    samples.push(parseFloat(r.stdout))
  }
  return min(samples)
}

const files = fs.readdirSync(EX_DIR).filter(f => f.endsWith('.wat')).sort()
console.log(`bench: ${files.length} examples, ITERS=${ITERS}, RUNS=${RUNS}, MARGIN=${MARGIN}x`)
console.log(`native: ${BIN}`)
console.log()

const W = Math.max(...files.map(f => f.length))
console.log(`${'example'.padEnd(W)}  ${'native'.padStart(8)}  ${'v8'.padStart(8)}  ${'V8/N'.padStart(6)}  status`)
console.log('-'.repeat(W + 38))

const losers = []
for (const f of files) {
  const file = path.join(EX_DIR, f)
  const n = benchNative(file)
  const v = benchV8(file)
  const ratio = v / n  // >1 = native wins
  const win = ratio > MARGIN
  if (!win) losers.push({ f, n, v, ratio })
  console.log(`${f.padEnd(W)}  ${n.toFixed(3).padStart(8)}  ${v.toFixed(3).padStart(8)}  ${ratio.toFixed(2).padStart(6)}  ${win ? 'OK' : 'LOSS'}`)
}

console.log()
if (losers.length === 0) {
  console.log(`PASS: native faster than V8 on all ${files.length}/${files.length} examples`)
  process.exit(0)
} else {
  console.log(`FAIL: native slower than V8 on ${losers.length}/${files.length} examples:`)
  for (const l of losers) console.log(`  ${l.f}: native=${l.n.toFixed(3)}ms v8=${l.v.toFixed(3)}ms (${l.ratio.toFixed(2)}x)`)
  process.exit(1)
}
