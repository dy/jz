// Bench-pin tests — the competitive-regression gate.
//
// Project invariant (see CONTRIBUTING.md): on the bench corpus, jz wasm is
//   • at least as fast as V8, AssemblyScript and Porffor (speed-tuned build), and
//   • at least as small as AssemblyScript (-Oz) and Porffor (size-tuned build).
// Plus a self-check: `wasm-opt -Oz` should not be able to meaningfully shrink
// jz's own output (any slack it finds is a codegen-size bug).
//
// This file pins what we currently achieve. A failing assertion = regression.
// `todo` entries are aspirational targets — printed for visibility, not asserted —
// and should be promoted to `win`/`tie` the moment they're reached (ratchet).
//
// Standalone runner: `npm run test:bench-pin`. Skipped from `npm test` because
// it spawns the bench harness (~15-30 s) and needs optional toolchains
// (`asc`, `porf`, `wasm-opt`); CI installs all three (see .github/workflows/bench.yml).
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'tst'
import { ok } from 'tst/assert.js'
import { compile } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BENCH = join(ROOT, 'bench/bench.mjs')
const SIZE_SCRIPT = join(ROOT, 'scripts/bench-size.mjs')

const have = cmd => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0
const ascAvailable = have('asc')
const porfAvailable = have('porf')
const wasmOptAvailable = have('wasm-opt')

// ── Speed pins ──────────────────────────────────────────────────────────────
//  win  — jz median strictly < target median (small headroom for noise)
//  tie  — jz median within 5% of target
//  near — jz median within 10% of target
//  todo — not yet won; printed, unasserted (next optimization candidate)
//  diff — not comparable (different checksum, e.g. tokenizer AS uses unicode tables)
//  na   — target unavailable / unable to run this case
const SPEED = {
  callback:       { v8: 'win',  as: 'win',  porf: 'todo' },
  mat4:           { v8: 'win',  as: 'win',  porf: 'todo' },
  poly:           { v8: 'win',  as: 'tie',  porf: 'todo' },
  biquad:         { v8: 'win',  as: 'win',  porf: 'todo' },
  mandelbrot:     { v8: 'win',  as: 'tie',  porf: 'todo' },
  bitwise:        { v8: 'win',  as: 'win',  porf: 'todo' },
  tokenizer:      { v8: 'win',  as: 'diff', porf: 'todo' },
  aos:            { v8: 'win',  as: 'win',  porf: 'todo' },
  json:           { v8: 'win',  as: 'na',   porf: 'todo' },
  'json-dynamic': { v8: 'win',  as: 'na',   porf: 'todo' },
  // in-place heapsort (call-heavy inner loop indexing a Float64Array). Was ~8.6×
  // slower than V8/`asc -O3` until cross-call typed-array param propagation reached
  // the 3-deep `main→runKernel→heapsort→siftDown` chain (narrow.js: soft-fixpoint
  // ctor propagation + pointer-param val-kind seeding into refreshCallerLocals).
  // Now jz is in the same band as V8/`asc -O3`, but not stable enough on this
  // host for a per-case assertion; keep it visible and let geomean guard it.
  sort:           { v8: 'todo', as: 'todo', porf: 'todo' },
  // CRC-32 table hash — pure-integer kernel over a Uint8Array with an Int32Array
  // LUT, hot inner call `crc32(buf, table)`. jz beats V8 and matches `asc -O3`.
  crc32:          { v8: 'win',  as: 'tie',  porf: 'todo' },
  // watr is the one large real-program case; jz hovers around V8 parity here
  // (±10% run-to-run), so the honest, non-flaky pin is `near`, not `win`.
  watr:           { v8: 'near', as: 'na',   porf: 'na'   },
}
const SPEED_TOL = { win: 1.0, tie: 1.05, near: 1.10 }
// Aggregate speed ceiling: jz must not be slower than the field on average.
// (1.0 = parity; tighten as we win more.) Over cases with matching checksums.
const SPEED_GEOMEAN_MAX = { v8: 1.0, as: 1.0, porf: 1.10 }

// ── Size pins (jz `optimize:'size'` vs AS `-Oz --converge` and Porffor) ─────
//  win — jz strictly smaller    tie — within 5%    todo — not yet (unasserted)
// jz currently runs ~9% larger than `asc -Oz` (geomean) on the kernels; wasm-opt
// still finds ~25-30% slack — single-use runtime-helper inlining is the next lever.
// porf bundles a JS runtime, so jz is ~20× smaller there; that pin is a backstop.
const SIZE = {
  callback:       { as: 'win',  porf: 'win' },
  mat4:           { as: 'todo', porf: 'win' },
  poly:           { as: 'todo', porf: 'win' },
  biquad:         { as: 'todo', porf: 'win' },
  mandelbrot:     { as: 'tie',  porf: 'win' },
  bitwise:        { as: 'tie',  porf: 'win' },
  tokenizer:      { as: 'todo', porf: 'win' },
  aos:            { as: 'todo', porf: 'win' },
  json:           { as: 'na',   porf: 'win' },
  'json-dynamic': { as: 'na',   porf: 'win' },
  sort:           { as: 'todo', porf: 'win' },  // jz ~1.10× asc -Oz — generic codegen slack, not sort-specific
  crc32:          { as: 'todo', porf: 'win' },  // jz ~1.07× asc -Oz — same generic slack
  watr:           { as: 'na',   porf: 'na'  },
}
const SIZE_TOL = { win: 1.0, tie: 1.05 }
const SIZE_GEOMEAN_MAX = { as: 1.12, porf: 0.40 }  // jz/target geomean ceiling; ratchet `as` toward 1.0 (currently ~1.09×)
// `wasm-opt -Oz` slack budget: jz_opt / jz_raw must stay ≥ this (wasm-opt may
// remove ≤ (1-x) of jz output). Aspirational target: 0.95+. Current baseline
// with margin — shrink the budget as codegen tightens.
const WASMOPT_SLACK_MIN = 0.65

// Absolute byte backstop — catches gross codegen bloat independent of competitors.
const SIZE_BUDGET = {
  callback: 2500, mat4: 3400, poly: 2500, biquad: 4550, mandelbrot: 1800,
  bitwise: 2500, tokenizer: 3000, aos: 3500, json: 12500, 'json-dynamic': 12000, sort: 3500, crc32: 2200, watr: 180000,
}

// ── Run the speed harness ───────────────────────────────────────────────────
const speedCases = Object.keys(SPEED)
const speedTargets = ['v8', 'jz', ...(ascAvailable ? ['as'] : []), ...(porfAvailable ? ['porf'] : [])]
console.log(`bench-pin: speed — ${speedCases.length} cases × {${speedTargets.join(',')}}…`)
const speedOut = execFileSync('node', [BENCH, `--cases=${speedCases.join(',')}`, `--targets=${speedTargets.join(',')}`], { encoding: 'utf8', cwd: ROOT })

const SIZE_UNIT = { B: 1, kB: 1024, MB: 1024 * 1024 }
const TARGET_BY_NAME = {
  'jz → V8 wasm': 'jz', 'V8 (node)': 'v8',
  'AssemblyScript (asc -O3)': 'as', 'Porffor': 'porf',
}
function parseBenchOutput(text) {
  const parsed = {}
  let cur = null
  for (const line of text.split('\n')) {
    const header = line.match(/^# .* \(([^)]+)\)$/)
    if (header) { cur = header[1]; parsed[cur] = {}; continue }
    if (!cur) continue
    const run = line.match(/^\[run\]\s+(\w[\w-]*)\s+.*…\s*(\d+) µs\s+cs=(-?\d+)/)
    if (run) { parsed[cur][run[1]] = { medianUs: +run[2], checksum: (+run[3]) >>> 0 }; continue }
    const row = line.match(/^ {2}(jz → V8 wasm|V8 \(node\)|AssemblyScript \(asc -O3\)|Porffor)\s+[\d.]+ ms.*?\s(\d+(?:\.\d+)?) (B|kB|MB)\s+(\w+)\s*$/)
    if (row) {
      const tid = TARGET_BY_NAME[row[1]]
      const r = parsed[cur][tid]
      if (r) { r.sizeBytes = Math.round(+row[2] * SIZE_UNIT[row[3]]); r.parity = row[4] }
    }
  }
  return parsed
}
const runs = parseBenchOutput(speedOut)

// These cases' medians are noisy run-to-run — take the median of a few extra
// samples so the gate reflects steady-state, not whichever scheduler hiccup
// happened to land on the single bench.mjs invocation above.
const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1]
for (const id of ['watr', 'sort', 'crc32']) {
  if (!speedCases.includes(id) || !runs[id]?.v8 || !runs[id]?.jz) continue
  const s = { v8: [runs[id].v8.medianUs], jz: [runs[id].jz.medianUs] }
  for (let i = 1; i < 5; i++) {
    const x = parseBenchOutput(execFileSync('node', [BENCH, `--cases=${id}`, '--targets=v8,jz'], { encoding: 'utf8', cwd: ROOT }))
    if (x[id]?.v8?.medianUs) s.v8.push(x[id].v8.medianUs)
    if (x[id]?.jz?.medianUs) s.jz.push(x[id].jz.medianUs)
  }
  runs[id].v8.medianUs = median(s.v8); runs[id].jz.medianUs = median(s.jz)
}

// ── Run the size harness ────────────────────────────────────────────────────
console.log('bench-pin: size — compiling jz/AS/porf + wasm-opt self-check…')
const sizeOut = execFileSync('node', [SIZE_SCRIPT, '--json'], { encoding: 'utf8', cwd: ROOT })
const sizes = {}  // id → { jz, jzOpt, as, porf }
for (const line of sizeOut.split('\n')) {
  const m = line.match(/^SIZE (\S+) jz=(\d*) jz_wasmopt=(\d*) as=(\d*) porf=(\d*)/)
  if (m) sizes[m[1]] = { jz: +m[2] || null, jzOpt: +m[3] || null, as: +m[4] || null, porf: +m[5] || null }
}

// ── Snapshot table ──────────────────────────────────────────────────────────
const fmtMs = us => us == null ? '   —  ' : (us / 1000).toFixed(2).padStart(6)
const fmtKb = b => b == null ? '   —  ' : b < 1024 ? `${b} B`.padStart(7) : `${(b / 1024).toFixed(1)} kB`.padStart(7)
const mark = { win: '✓', tie: '≈', near: '~', todo: '✗', diff: '?', na: ' ' }
const ratioCell = (claim, num, den) => num != null && den != null ? `${mark[claim]} ${(num / den).toFixed(2)}×` : `${mark[claim]}  —`

console.log('\nbench-pin snapshot (speed = median ms, size = wasm bytes; "×" = jz/target):')
console.log(`  ${'case'.padEnd(13)}  ${'jz_ms'.padStart(6)}  spd.v8       spd.as       spd.porf     ${'jz_sz'.padStart(7)}  sz.AS        sz.porf      slack`)
console.log(`  ${'-'.repeat(13)}  ${'-'.repeat(6)}  -----------  -----------  -----------  ${'-'.repeat(7)}  -----------  -----------  ------`)
for (const id of speedCases) {
  const r = runs[id] || {}, sz = sizes[id] || {}
  const slack = sz.jz && sz.jzOpt ? `${((sz.jzOpt / sz.jz) * 100).toFixed(0)}%` : '  — '
  console.log(`  ${id.padEnd(13)}  ${fmtMs(r.jz?.medianUs)}  ` +
    `${ratioCell(SPEED[id].v8, r.jz?.medianUs, r.v8?.medianUs).padEnd(11)}  ` +
    `${ratioCell(SPEED[id].as, r.jz?.medianUs, r.as?.medianUs).padEnd(11)}  ` +
    `${ratioCell(SPEED[id].porf, r.jz?.medianUs, r.porf?.medianUs).padEnd(11)}  ` +
    `${fmtKb(sz.jz)}  ` +
    `${ratioCell(SIZE[id].as, sz.jz, sz.as).padEnd(11)}  ` +
    `${ratioCell(SIZE[id].porf, sz.jz, sz.porf).padEnd(11)}  ${slack.padStart(5)}`)
}

const geomean = xs => xs.length ? Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length) : null
const geoSpeed = tid => geomean(speedCases
  .map(id => runs[id]).filter(r => r?.jz && r?.[tid] && r.jz.checksum === r[tid].checksum)
  .map(r => r.jz.medianUs / r[tid].medianUs))
const geoSize = tid => geomean(Object.values(sizes).filter(s => s.jz && s[tid]).map(s => s.jz / s[tid]))
const geoSlack = geomean(Object.values(sizes).filter(s => s.jz && s.jzOpt).map(s => s.jzOpt / s.jz))
const gV8 = geoSpeed('v8'), gAsT = geoSpeed('as'), gPorfT = geoSpeed('porf')
const gAsS = geoSize('as'), gPorfS = geoSize('porf')
console.log(`\n  geomean speed jz/target:  v8 ${gV8?.toFixed(3) ?? '—'}×   as ${gAsT?.toFixed(3) ?? '—'}×   porf ${gPorfT?.toFixed(3) ?? '—'}×`)
console.log(`  geomean size  jz/target:  as ${gAsS?.toFixed(3) ?? '—'}×   porf ${gPorfS?.toFixed(3) ?? '—'}×   wasm-opt slack ${geoSlack?.toFixed(3) ?? '—'}×`)
console.log()

// ── Assertions: speed ───────────────────────────────────────────────────────
for (const [id, claims] of Object.entries(SPEED)) {
  for (const tid of ['v8', 'as', 'porf']) {
    const claim = claims[tid]
    if (!SPEED_TOL[claim]) continue
    if (tid === 'as' && !ascAvailable) continue
    if (tid === 'porf' && !porfAvailable) continue
    test(`bench-pin: speed ${id} jz ${claim} vs ${tid}`, () => {
      const r = runs[id]
      ok(r?.jz && r?.[tid], `missing data: jz=${!!r?.jz} ${tid}=${!!r?.[tid]}`)
      ok(r.jz.checksum === r[tid].checksum, `${id}: checksum mismatch jz=${r.jz.checksum} ${tid}=${r[tid].checksum} — pin should be 'diff'`)
      const ratio = r.jz.medianUs / r[tid].medianUs
      ok(ratio <= SPEED_TOL[claim], `${id}: jz ${(r.jz.medianUs / 1000).toFixed(2)}ms / ${tid} ${(r[tid].medianUs / 1000).toFixed(2)}ms = ${ratio.toFixed(3)}× > ${claim} limit ${SPEED_TOL[claim]}×`)
    })
  }
}
for (const tid of ['v8', 'as', 'porf']) {
  if (tid === 'as' && !ascAvailable) continue
  if (tid === 'porf' && !porfAvailable) continue
  const g = geoSpeed(tid)
  if (g == null) continue
  test(`bench-pin: speed geomean jz/${tid} ≤ ${SPEED_GEOMEAN_MAX[tid]}×`, () => {
    ok(g <= SPEED_GEOMEAN_MAX[tid], `geomean jz/${tid} = ${g.toFixed(3)}× > ${SPEED_GEOMEAN_MAX[tid]}×`)
  })
}

// ── Assertions: size ────────────────────────────────────────────────────────
for (const [id, claims] of Object.entries(SIZE)) {
  for (const tid of ['as', 'porf']) {
    const claim = claims[tid]
    if (!SIZE_TOL[claim]) continue
    if (tid === 'as' && !ascAvailable) continue
    if (tid === 'porf' && !porfAvailable) continue
    test(`bench-pin: size ${id} jz ${claim} vs ${tid}`, () => {
      const s = sizes[id]
      ok(s?.jz && s?.[tid], `missing size: jz=${s?.jz} ${tid}=${s?.[tid]}`)
      const ratio = s.jz / s[tid]
      ok(ratio <= SIZE_TOL[claim], `${id}: jz ${s.jz} B / ${tid} ${s[tid]} B = ${ratio.toFixed(3)}× > ${claim} limit ${SIZE_TOL[claim]}×`)
    })
  }
}
for (const tid of ['as', 'porf']) {
  if (tid === 'as' && !ascAvailable) continue
  if (tid === 'porf' && !porfAvailable) continue
  const g = geoSize(tid)
  if (g == null) continue
  test(`bench-pin: size geomean jz/${tid} ≤ ${SIZE_GEOMEAN_MAX[tid]}×`, () => {
    ok(g <= SIZE_GEOMEAN_MAX[tid], `geomean size jz/${tid} = ${g.toFixed(3)}× > ${SIZE_GEOMEAN_MAX[tid]}×`)
  })
}

// ── Assertions: wasm-opt self-check (codegen size slack) ────────────────────
if (wasmOptAvailable) {
  for (const id of Object.keys(SIZE)) {
    test(`bench-pin: ${id} wasm-opt slack ≥ ${WASMOPT_SLACK_MIN}× (jz codegen not bloated)`, () => {
      const s = sizes[id]
      ok(s?.jz && s?.jzOpt, `missing wasm-opt size for ${id}`)
      const slack = s.jzOpt / s.jz
      ok(slack >= WASMOPT_SLACK_MIN, `${id}: wasm-opt -Oz cut jz output ${s.jz} B → ${s.jzOpt} B (${slack.toFixed(3)}× < ${WASMOPT_SLACK_MIN}×) — codegen leaving too much on the table`)
    })
  }
}

// ── Assertions: absolute byte backstop ──────────────────────────────────────
for (const [id, budget] of Object.entries(SIZE_BUDGET)) {
  test(`bench-pin: ${id} jz wasm size ≤ ${budget} B (backstop)`, () => {
    const r = runs[id]
    ok(r?.jz?.sizeBytes != null, `missing size for ${id}`)
    ok(r.jz.sizeBytes <= budget, `${id}: jz wasm ${r.jz.sizeBytes} B exceeds budget ${budget} B (+${r.jz.sizeBytes - budget})`)
  })
}

// ── Size-optimized compile spot-checks (cheap, no external toolchain) ────────
const benchlibHostSource = () => {
  const src = readFileSync(join(ROOT, 'bench/_lib/benchlib.js'), 'utf8')
  return src.replace(`export let printResult = (medianUs, checksum, samples, stages, runs) => {
  console.log(\`median_us=\${medianUs} checksum=\${checksum} samples=\${samples} stages=\${stages} runs=\${runs}\`)
}`, `export let printResult = (medianUs, checksum, samples, stages, runs) => {
  env.logResult(medianUs, checksum, samples, stages, runs)
}`)
}
const sizeCompile = id => compile(readFileSync(join(ROOT, `bench/${id}/${id}.js`), 'utf8'), {
  modules: { '../_lib/benchlib.js': benchlibHostSource() },
  imports: { env: { logResult: { params: 5 } }, performance: { now: { params: 0, returns: 'number' } } },
  optimize: { smallConstForUnroll: false, scalarTypedArrayLen: 8 },
  alloc: false,
}).length
test('bench-pin: mat4 size-optimized compile ≤ 2500 B', () => { const b = sizeCompile('mat4'); ok(b <= 2500, `mat4 size-optimized compile: ${b} B exceeds 2500 B`) })
test('bench-pin: biquad size-optimized compile ≤ 3000 B', () => { const b = sizeCompile('biquad'); ok(b <= 3000, `biquad size-optimized compile: ${b} B exceeds 3000 B`) })
