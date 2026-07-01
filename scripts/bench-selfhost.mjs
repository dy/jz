#!/usr/bin/env node
// Self-host compile-throughput benchmark: jz.wasm vs jz.js compiling the bench corpus.
//
// The apples-to-apples question behind self-hosting: when the SAME compiler source
// (scripts/self.js — parse → jzify → prepare → compile → watr-encode) runs as wasm
// (dist/jz.wasm, jz compiled by jz) vs as plain JS in V8, which compiles real programs
// faster? Both rows run in the same node/V8; the only variable is wasm vs JS-source.
//
// Workload = the bench corpus (mat4, fft, mandelbrot, crc32, …) — the same programs
// the cross-engine bench compiles — each inlining benchlib so it's a standalone module
// (matches bench.mjs's benchSource()). Output bytes are checksummed and the wasm/JS
// results compared, so the timing run doubles as a determinism + parity gate.
//
// Methodology note: the self-host kernel bump-allocates per compile and its cross-
// compile caches assume an immortal arena (see DESIGN / _clear), so we cannot reset and
// reuse one instance across the corpus. We instantiate a FRESH wasm instance per program
// (instantiation excluded from the timed region) and take the min of N warm runs — the
// steady-state per-compile cost, the fair comparison to the JS compiler's warmed path.
//
// Run: node scripts/bench-selfhost.mjs            (level 0, the default)
//      JZ_LEVEL=2 node scripts/bench-selfhost.mjs (once the level-2 self-host path is sound)

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { instantiate } from '../interop.js'
import compileSelf from './self.js'
import { HELPER_COUNTERS, HELPER_SITE_PREFIX } from '../src/helper-counters.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BENCH = join(ROOT, 'bench')
const LIB = join(BENCH, '_lib', 'benchlib.js')
const WASM = join(ROOT, 'dist', 'jz.wasm')
const LEVEL = process.env.JZ_LEVEL ?? '0'
const RUNS = Math.max(8, Number(process.env.JZ_BENCH_RUNS) || 18)
const WARM = 8
// Opt-in: one wasm instance per CASE, `_clear()` between the N timed runs (instead
// of a fresh instance per run). Requires the warm-instance-reuse fix (module-level
// caches that used to dangle across `_clear` — DOLLAR/stdlibParseCache/programFacts-
// style Maps, the __dyn_props/__dyn_get_cache_* globals, NULL_IR's missing .slice(),
// subscript's comment-list cache, watr's err.src/err.loc — see module/core.js
// __clear, src/ir.js clearDollar, scripts/self.js setupSelf). Still fresh String
// marshaling per run OUTSIDE the timed region, mirroring timeMinWasm's methodology.
// KNOWN GAP: a small, content/order-dependent subset of the corpus (observed:
// tokenizer, json) still traps/errors on a warm 2nd+ compile — an unresolved
// watr-internal parser/assemble state issue: reproduces even compiling a
// trivial fixed WAT string twice in one instance with no jz involvement at all
// (`compile('(module (func (export "f") (result i32) (i32.const 42)))')` twice,
// 2nd call: "Unknown type i32"). Root cause not yet found. JZ_BENCH_WARM reports
// such cases as skipped rather than silently mistiming or crashing the whole run.
const WARM_INSTANCE = /^(1|true|yes)$/i.test(process.env.JZ_BENCH_WARM || '')
const COUNT_HELPERS = /^(1|true|yes)$/i.test(process.env.JZ_HELPER_COUNTERS || '')
const HELPER_SITES = process.env.JZ_HELPER_SITES || ''
const COUNT_SITES = !!HELPER_SITES && !/^(0|false|no)$/i.test(HELPER_SITES)
const HELPER_SITE_FILTER = /^(1|true|yes)$/i.test(HELPER_SITES) ? 'ptr_offset' : HELPER_SITES
const PROFILE_HELPERS = COUNT_HELPERS || COUNT_SITES

// Corpus = every bench case with a real .js source. Skip self-referential / graph cases.
const CASES = ['alpha','blur','bytebeat','dotprod','fft','lorenz','nbody','particle','synth',
  'biquad','mat4','poly','bitwise','tokenizer','callback','aos','mandelbrot','json','sort',
  'crc32','matmul','heat']

// Inline benchlib (export let → const) and strip its import — the standalone module the
// compiler sees, same transform bench.mjs uses for the native/wasi self-timing path.
const benchlib = readFileSync(LIB, 'utf8').replace(/\bexport let\b/g, 'const')
const sourceFor = (name) => {
  let src = readFileSync(join(BENCH, name, `${name}.js`), 'utf8')
  if (src.includes('../_lib/benchlib.js'))
    src = benchlib + '\n' + src.replace(/import\s+\{[^}]+\}\s+from\s+['"]\.\.\/_lib\/benchlib\.js['"]\s*\n?/g, '')
  return src
}

const ensureWasm = () => {
  if (existsSync(WASM) && !PROFILE_HELPERS) return
  console.log(PROFILE_HELPERS ? 'building instrumented self-host…' : 'dist/jz.wasm missing — building self-host…')
  const env = PROFILE_HELPERS
    ? { ...process.env, JZ_HELPER_COUNTERS: '1', ...(COUNT_SITES ? { JZ_HELPER_SITES: HELPER_SITE_FILTER } : {}) }
    : process.env
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'selfhost-build.mjs')], { cwd: ROOT, stdio: 'inherit', env, timeout: 600_000 })
  if (r.status !== 0) throw new Error(`selfhost build failed (exit ${r.status})`)
}

const fnv = (bytes) => { let h = 0x811c9dc5 | 0; for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193); return h >>> 0 }

const timeMin = (fn) => {
  for (let i = 0; i < WARM; i++) fn()
  let best = Infinity
  for (let r = 0; r < RUNS; r++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t) }
  return best
}

// Time the WASM compile across WARM+RUNS iterations, each on a FRESH instance.
// The kernel bump-allocates per compile and never resets its arena (cross-compile
// caches assume an immortal arena), so reusing ONE instance for N compiles
// exhausts memory on a large program — `blur` traps on its 4th compile. A fresh
// instance per iteration models the real "one compile per instance" usage;
// instantiation + source marshaling stay OUT of the timed region (the steady-state
// per-compile cost is the fair comparison to the JS compiler's warmed path).
const timeMinWasm = (src) => {
  const setup = () => { const inst = instantiate(wasmBytes, { memory: 8192 }); const sp = inst.memory.String(src); const lp = inst.memory.String(LEVEL); return () => inst.memory.read(inst.exports.default(sp, 0, lp)) }
  for (let i = 0; i < WARM; i++) setup()()
  let best = Infinity
  for (let r = 0; r < RUNS; r++) { const fn = setup(); const t = performance.now(); fn(); best = Math.min(best, performance.now() - t) }
  return best
}

// JZ_BENCH_WARM=1 variant: ONE instance for the whole case, `_clear()` between the
// N timed runs. String marshaling (fresh source pointer per run) stays outside the
// timed region, same as timeMinWasm — the only difference is instantiation is
// hoisted out of the loop too, removing the ~4% first-touch-page-fault tax fresh-
// instance timing pays inside the timed region (see .work/selfhost-perf-groundtruth.md).
// Returns null if the case traps mid-run (caller records it as skipped rather than
// reporting a bogus/partial time).
const timeMinWasmWarm = (src) => {
  const inst = instantiate(wasmBytes, { memory: 8192 })
  const runOnce = () => { const sp = inst.memory.String(src); const lp = inst.memory.String(LEVEL); const out = inst.exports.default(sp, 0, lp); inst.memory.read(out); inst.instance.exports._clear() }
  try {
    for (let i = 0; i < WARM; i++) runOnce()
    let best = Infinity
    for (let r = 0; r < RUNS; r++) { const t = performance.now(); runOnce(); best = Math.min(best, performance.now() - t) }
    return best
  } catch { return null }
}

const readHelperCounters = (exports) => {
  const out = []
  for (const [helper, label] of HELPER_COUNTERS) {
    const g = exports[`__hc_${label}`]
    if (!g) continue
    const n = Number(g.value)
    if (n) out.push({ helper, label, n })
  }
  return out
}

const addHelperCounters = (totals, exports) => {
  const counts = readHelperCounters(exports)
  if (PROFILE_HELPERS && !counts.length && !exports.__helper_counts_reset)
    throw new Error('JZ_HELPER_COUNTERS=1 requested, but dist/jz.wasm has no helper counter exports')
  for (const { label, n } of counts) totals[label] = (totals[label] || 0) + n
}

const readHelperSites = (exports) => {
  const out = new Map()
  for (const [name, g] of Object.entries(exports)) {
    if (!name.startsWith(HELPER_SITE_PREFIX) || !g || typeof g.value !== 'bigint') continue
    const parts = name.slice(HELPER_SITE_PREFIX.length).split(':')
    if (parts.length < 3) continue
    const id = parts.shift()
    const label = parts.shift()
    const func = parts.join(':')
    out.set(name, { id, label, func, n: Number(g.value) })
  }
  return out
}

const addHelperSiteDeltas = (totals, before, after) => {
  for (const [name, row] of after) {
    const base = before.get(name)?.n || 0
    const n = row.n - base
    if (n <= 0) continue
    const prev = totals.get(name)
    totals.set(name, prev ? { ...prev, n: prev.n + n } : { ...row, n })
  }
}

ensureWasm()
const wasmBytes = readFileSync(WASM)

const profileLabel = COUNT_SITES ? `helper counters + callsites(${HELPER_SITE_FILTER}) ON` : COUNT_HELPERS ? 'helper counters ON' : ''
console.log(`self-host compile throughput — corpus × ${CASES.length}, optimize level ${LEVEL}${profileLabel ? ` (${profileLabel}; timings are instrumented)` : ''}${WARM_INSTANCE ? ' [JZ_BENCH_WARM: one instance per case, _clear() between runs]' : ''}\n`)
console.log('case          js(ms)  wasm(ms)  ratio   parity')
console.log('─'.repeat(52))

let sumJs = 0, sumWasm = 0, ratios = [], okN = 0, skipped = []
const helperTotals = Object.create(null)
const helperSiteTotals = new Map()
for (const name of CASES) {
  const src = sourceFor(name)
  // JS compiler reference + checksum
  let jsBytes
  try { jsBytes = compileSelf(src, false, LEVEL) } catch (e) { skipped.push(`${name}(js:${e.message.slice(0,18)})`); continue }
  // WASM compiler — fresh instance, exclude instantiation from timing
  const self = instantiate(wasmBytes, { memory: 8192 })
  if (PROFILE_HELPERS) self.instance.exports.__helper_counts_reset?.()
  const helperSitesBefore = COUNT_SITES ? readHelperSites(self.instance.exports) : null
  const compileWasm = () => self.memory.read(self.exports.default(self.memory.String(src), 0, self.memory.String(LEVEL)))
  let wasmBytesOut
  try { wasmBytesOut = compileWasm() } catch (e) { self && skipped.push(`${name}(wasm:${e.message.slice(0,18)})`); continue }
  if (PROFILE_HELPERS) addHelperCounters(helperTotals, self.instance.exports)
  if (COUNT_SITES) addHelperSiteDeltas(helperSiteTotals, helperSitesBefore, readHelperSites(self.instance.exports))
  const parity = fnv(jsBytes) === fnv(wasmBytesOut instanceof Uint8Array ? wasmBytesOut : new Uint8Array(wasmBytesOut)) ? 'ok' : 'DIFF'

  const js = timeMin(() => compileSelf(src, false, LEVEL))
  const wasm = WARM_INSTANCE ? timeMinWasmWarm(src) : timeMinWasm(src)
  if (wasm == null) { skipped.push(`${name}(warm-trap)`); continue }
  sumJs += js; sumWasm += wasm; ratios.push(wasm / js); okN++
  const flag = wasm < js ? '' : ' ⚠'
  console.log(`${name.padEnd(12)} ${js.toFixed(2).padStart(6)} ${wasm.toFixed(2).padStart(9)}  ${(wasm/js).toFixed(2)}×${flag}  ${parity}`)
}

const geo = ratios.length ? Math.exp(ratios.reduce((a, b) => a + Math.log(b), 0) / ratios.length) : NaN
console.log('─'.repeat(52))
console.log(`TOTAL (${okN}/${CASES.length})  js ${sumJs.toFixed(1)}ms   wasm ${sumWasm.toFixed(1)}ms`)
console.log(`geomean ratio: ${geo.toFixed(2)}× — wasm is ${geo < 1 ? (1/geo).toFixed(2)+'× FASTER' : geo.toFixed(2)+'× slower'} than jz.js`)
if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`)
if (PROFILE_HELPERS) {
  const rows = Object.entries(helperTotals).sort((a, b) => b[1] - a[1])
  console.log('\nhelper counters — one compile per successful corpus case')
  console.log('helper              calls')
  console.log('─'.repeat(32))
  for (const [label, n] of rows) console.log(`${label.padEnd(18)} ${String(n).padStart(12)}`)
}
if (COUNT_SITES) {
  const rows = [...helperSiteTotals.values()].sort((a, b) => b.n - a.n).slice(0, 50)
  console.log('\nhelper callsites — dynamic deltas from the parity compile')
  console.log('helper              calls  function')
  console.log('─'.repeat(64))
  for (const { label, n, func } of rows)
    console.log(`${label.padEnd(18)} ${String(n).padStart(12)}  ${func}`)
}
