// Bench-pin tests: lock in competitive achievements so we don't regress.
//
// Goal (per project): jz must be faster than V8 and AssemblyScript on every
// bench. This file pins the (case, target) pairs we currently win or tie.
// Failing assertions = regression; "todo" pairs are listed for visibility but
// don't fail (they're aspirational targets to optimize next).
//
// Standalone runner: `npm run test:bench-pin`. Skipped from `npm test` because
// it spawns the bench harness (~10-15 s wall) and depends on optional `asc`.
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'tst'
import { ok } from 'tst/assert.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BENCH = join(ROOT, 'bench/bench.mjs')

// Per-case claims:
//  win  — jz median strictly < target median (3% headroom for noise)
//  tie  — jz median within 5% of target (asserted ≤ 1.05×)
//  todo — not yet won; printed but unasserted (next optimization candidate)
//  diff — not comparable (different checksum, e.g. tokenizer AS uses unicode tables)
//  na   — target unavailable for this case (no .as.ts source)
const PINS = {
  callback:  { v8: 'win',  as: 'win'  },
  mat4:      { v8: 'win',  as: 'win'  },
  poly:      { v8: 'win',  as: 'tie'  },
  biquad:    { v8: 'win',  as: 'todo' },
  bitwise:   { v8: 'todo', as: 'win'  },
  tokenizer: { v8: 'win',  as: 'diff' },
  aos:       { v8: 'todo', as: 'todo' },
  json:      { v8: 'todo', as: 'na'   },
}
const TOLERANCE = { win: 1.0, tie: 1.05 }

const ascAvailable = spawnSync('which', ['asc'], { stdio: 'ignore' }).status === 0
const cases = Object.keys(PINS)
const targets = ascAvailable ? 'v8,jz,as' : 'v8,jz'

console.log(`bench-pin: running ${cases.length} cases × {${targets}}…`)
const out = execFileSync('node', [BENCH, `--cases=${cases.join(',')}`, `--targets=${targets}`], {
  encoding: 'utf8',
  cwd: ROOT,
})

// Output shape:
//   # <name> (<id>)
//   [run]  <tid>  <name> … <µs> µs  cs=<n>
//   …
//     <name>   <ms> ms   <ratio>×   <thr>   <size>   <parity>
const SIZE_KB = { B: 1, kB: 1024, MB: 1024 * 1024 }
const TARGET_BY_NAME = {
  'jz → V8 wasm': 'jz',
  'V8 (node)': 'v8',
  'AssemblyScript (asc -O3)': 'as',
}
const runs = {}
let currentCase = null
for (const line of out.split('\n')) {
  const header = line.match(/^# .* \(([^)]+)\)$/)
  if (header) { currentCase = header[1]; runs[currentCase] = {}; continue }
  if (!currentCase) continue
  const run = line.match(/^\[run\]\s+(\w[\w-]*)\s+.*…\s*(\d+) µs\s+cs=(-?\d+)/)
  if (run) {
    runs[currentCase][run[1]] = { medianUs: +run[2], checksum: (+run[3]) >>> 0 }
    continue
  }
  const row = line.match(/^ {2}(jz → V8 wasm|V8 \(node\)|AssemblyScript \(asc -O3\))\s+[\d.]+ ms.*?\s(\d+(?:\.\d+)?) (B|kB|MB)\s+(\w+)\s*$/)
  if (row) {
    const tid = TARGET_BY_NAME[row[1]]
    const r = runs[currentCase][tid]
    if (r) {
      r.sizeBytes = Math.round(+row[2] * SIZE_KB[row[3]])
      r.parity = row[4]
    }
  }
}

const fmtMs = us => us == null ? '   —  ' : (us / 1000).toFixed(2).padStart(6)
const fmtKb = b => b == null ? '   —  ' : b < 1024 ? `${b} B`.padStart(6) : `${(b / 1024).toFixed(1)} kB`.padStart(6)
const claimMark = { win: '✓', tie: '≈', todo: '✗', diff: '?', na: ' ' }

console.log('\nbench-pin snapshot:')
console.log(`  ${'case'.padEnd(10)}  ${'jz_ms'.padStart(6)}  ${'v8_ms'.padStart(6)}  ${'as_ms'.padStart(6)}  ${'jz_sz'.padStart(6)}  vs.v8        vs.as`)
console.log(`  ${'-'.repeat(10)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  -----------  -----------`)
for (const id of cases) {
  const r = runs[id] || {}
  const rV8 = r.jz && r.v8 ? `${claimMark[PINS[id].v8]} ${(r.jz.medianUs / r.v8.medianUs).toFixed(2)}×` : `${claimMark[PINS[id].v8]}  —`
  const rAS = r.jz && r.as ? `${claimMark[PINS[id].as]} ${(r.jz.medianUs / r.as.medianUs).toFixed(2)}×` : `${claimMark[PINS[id].as]}  —`
  console.log(`  ${id.padEnd(10)}  ${fmtMs(r.jz?.medianUs)}  ${fmtMs(r.v8?.medianUs)}  ${fmtMs(r.as?.medianUs)}  ${fmtKb(r.jz?.sizeBytes)}  ${rV8.padEnd(11)}  ${rAS.padEnd(11)}`)
}
console.log()

// Speed pins.
for (const [id, claims] of Object.entries(PINS)) {
  for (const tid of ['v8', 'as']) {
    const claim = claims[tid]
    if (claim !== 'win' && claim !== 'tie') continue
    if (tid === 'as' && !ascAvailable) continue
    test(`bench-pin: ${id} jz ${claim} vs ${tid}`, () => {
      const r = runs[id]
      ok(r?.jz && r?.[tid], `missing data: jz=${!!r?.jz} ${tid}=${!!r?.[tid]}`)
      const ratio = r.jz.medianUs / r[tid].medianUs
      const limit = TOLERANCE[claim]
      ok(ratio <= limit,
        `${id}: jz ${(r.jz.medianUs / 1000).toFixed(2)}ms / ${tid} ${(r[tid].medianUs / 1000).toFixed(2)}ms = ${ratio.toFixed(3)}× > ${claim} limit ${limit}×`)
    })
  }
}

// jz wasm size budgets — regression guard against accidental codegen bloat.
// Tolerances absorb harmless codegen jitter; tighten/loosen by editing the
// budget. Sizes encode the snapshot from the perf-fusion landing.
const SIZE_BUDGET = {
  callback:  8800,
  mat4:      7900,
  poly:      7800,
  biquad:    8400,
  bitwise:   7800,
  tokenizer: 7900,
  aos:       9800,
  json:     11700,
}
for (const [id, budget] of Object.entries(SIZE_BUDGET)) {
  test(`bench-pin: ${id} jz wasm size ≤ ${budget} B`, () => {
    const r = runs[id]
    ok(r?.jz?.sizeBytes != null, `missing size for ${id}`)
    ok(r.jz.sizeBytes <= budget,
      `${id}: jz wasm ${r.jz.sizeBytes} B exceeds budget ${budget} B (+${r.jz.sizeBytes - budget})`)
  })
}
