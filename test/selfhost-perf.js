/**
 * Self-host PERFORMANCE gate — the hard pin on the V8-parity milestone.
 *
 * The achievement (2026-07-01, commits ec6a229..42dc91c): dist/jz.wasm — the jz
 * compiler compiled to wasm by jz — compiles the bench corpus faster than the
 * same compiler running as JS on V8 in the production warm-instance mode.
 * Paired, order-alternated 2026-07-15 measurements land at ~0.94–0.98×
 * warm and ~0.71–0.76× fresh. (The old independent-min method unfairly paired
 * unrelated best samples and drifted as high as 1.07× fresh.)
 *
 * Two layers, per the project's proof discipline (research.md):
 *  1. STRUCTURAL pins (deterministic, stopwatch-free): each perf lever leaves a
 *     named artifact in emitted WAT; deleting or breaking a lever fails these
 *     even on the noisiest machine.
 *  2. RATIO gates (wall-clock, machine-independent by construction): jz.wasm and
 *     jz.js compile the SAME programs in the SAME process — the ratio cancels
 *     machine speed. Both modes have a strict 0.99× victory cap.
 *
 * A warm-mode TRAP on the pinned corpus is a hard failure too — warm-instance
 * reuse (one instance, _clear between compiles) is part of the milestone.
 *
 * Run: node test/selfhost-perf.js   |   CI: .github/workflows/selfhost.yml
 */
import test from 'tst'
import { ok } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { instantiate } from '../interop.js'
import { compile } from '../index.js'
import compileSelf from '../scripts/self.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = join(ROOT, 'dist/jz.wasm')
const BENCH = join(ROOT, 'bench')

// ── Layer 1: structural lever pins (no stopwatch) ───────────────────────────

test('perf-pin: SSO fast-hash mix present in __str_hash', () => {
  // The 7-op multiplicative mix (62452a5). Its magic constants only appear when
  // the SSO branch is the mix, not the old per-char FNV loop.
  const wat = compile('export let f = (o, k) => o[k]', { wat: true })
  ok(/0x85EBCA6B|2246822507/i.test(wat), 'SSO hash mix constant in kernel WAT')
})

test('perf-pin: ≤6-ASCII⇒SSO invariant plumbing present (__sso_norm + bare-i64.eq ===)', () => {
  // (ec6a229) short-literal === lowers to a bare i64.eq — no helper call.
  const eq = compile('export let f = (x) => (x === "if") | 0', { wat: true })
  ok(!/\$__is_str_key|\$__str_eq|\$__eq\b/.test(eq), 'SSO-literal === is a bare i64.eq')
  // Producers normalize short heap results through __sso_norm.
  const tpl = compile('export let f = (s) => `x${s}`', { wat: true })
  ok(/\$__sso_norm/.test(tpl), 'template strcat routes through __sso_norm')
})

test('perf-pin: __dyn_props membership filter present and gating __dyn_move', () => {
  // (42dc91c) the never-false-negative bitset that skips the global-table probes.
  const wat = compile('export let f = (k) => { let a = [1]; a[k] = 2; a.shift(); return a[k] }', { wat: true })
  ok(/\$__dyn_props_filter/.test(wat), 'filter global declared')
  ok(/__dyn_props_filter[\s\S]*\$__dyn_move|\$__dyn_move[\s\S]*__dyn_props_filter/.test(wat),
    'filter wired alongside __dyn_move')
})

// (The proven-decode lever — __arr_grow_known's inline offset extract — is
// WAT-shape-pinned in test/feature-gating.js alongside its feature gates.)

// ── Layer 2: ratio gates (wall-clock, ratio cancels machine speed) ──────────

// Warm-safe subset of the bench corpus (tokenizer/json excluded until the
// watr-internal warm-recompile bug is fixed — see groundtruth). Spans math,
// arrays, strings-lite, closures, integer kernels.
const CASES = ['mat4', 'fft', 'biquad', 'sort', 'crc32', 'mandelbrot']
// Repeated paired level: warm ~0.94–0.98×, fresh ~0.71–0.76×.
// These are HARD gates: loosening them requires a justified re-baseline.
const WARM_CAP = 0.99
const FRESH_CAP = 0.99
const WARMUP = 20, RUNS = 20, LEVEL = '0'

const benchlib = readFileSync(join(BENCH, '_lib', 'benchlib.js'), 'utf8').replace(/\bexport let\b/g, 'const')
const sourceFor = (name) => {
  let src = readFileSync(join(BENCH, name, `${name}.js`), 'utf8')
  if (src.includes('../_lib/benchlib.js'))
    src = benchlib + '\n' + src.replace(/import\s+\{[^}]+\}\s+from\s+['"]\.\.\/_lib\/benchlib\.js['"]\s*\n?/g, '')
  return src
}

const ensureSelf = () => {
  if (existsSync(SELF)) return
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/selfhost-build.mjs')], { cwd: ROOT, stdio: 'inherit', timeout: 600_000 })
  if (r.status !== 0) throw new Error(`selfhost build exit ${r.status}`)
}

const timed = (fn) => { const t = performance.now(); fn(); return performance.now() - t }
const pairedRatio = (jsFn, prepareWasm) => {
  // Pair and alternate substrate order so suite heat / CPU-frequency drift
  // cannot consistently favor the runner measured second. Fresh setup happens
  // outside the timed window, matching the old startup-state contract.
  for (let i = 0; i < WARMUP; i++) { jsFn(); prepareWasm()() }
  const ratios = []
  for (let r = 0; r < RUNS; r++) {
    let js, wasm
    if (r & 1) { const run = prepareWasm(); wasm = timed(run); js = timed(jsFn) }
    else { js = timed(jsFn); const run = prepareWasm(); wasm = timed(run) }
    ratios.push(wasm / js)
  }
  ratios.sort((a, b) => a - b)
  return (ratios[RUNS / 2 - 1] + ratios[RUNS / 2]) / 2
}

const geo = (xs) => Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length)

test('perf-pin: warm-instance self-host compile < V8 JS', () => {
  ensureSelf()
  const wasmBytes = readFileSync(SELF)
  const ratios = []
  for (const name of CASES) {
    const src = sourceFor(name)
    const js = () => compileSelf(src, false, LEVEL)
    // ONE instance, _clear between compiles — a trap here is a hard failure
    // (warm reuse is part of the milestone), so no try/catch.
    const inst = instantiate(wasmBytes, { memory: 8192 })
    const runOnce = () => {
      const out = inst.exports.default(inst.memory.String(src), 0, inst.memory.String(LEVEL))
      inst.memory.read(out)
      inst.instance.exports._clear()
    }
    ratios.push(pairedRatio(js, () => runOnce))
  }
  const g = geo(ratios)
  ok(g <= WARM_CAP,
    `warm self-host geomean ${g.toFixed(3)}× > strict-win cap ${WARM_CAP}× ` +
    `(per-case: ${CASES.map((c, i) => `${c} ${ratios[i].toFixed(2)}`).join(', ')}). ` +
    `Find the regressing change; do NOT loosen this cap without a justified re-baseline.`)
  console.log(`  warm geomean ${g.toFixed(3)}× (cap ${WARM_CAP}×): ${CASES.map((c, i) => `${c} ${ratios[i].toFixed(2)}`).join(' ')}`)
})

test('perf-pin: fresh-instance self-host compile < V8 JS', () => {
  ensureSelf()
  const wasmBytes = readFileSync(SELF)
  const ratios = []
  for (const name of CASES) {
    const src = sourceFor(name)
    const js = () => compileSelf(src, false, LEVEL)
    const setup = () => {
      const inst = instantiate(wasmBytes, { memory: 8192 })
      const sp = inst.memory.String(src), lp = inst.memory.String(LEVEL)
      return () => inst.memory.read(inst.exports.default(sp, 0, lp))
    }
    ratios.push(pairedRatio(js, setup))
  }
  const g = geo(ratios)
  ok(g <= FRESH_CAP,
    `fresh self-host geomean ${g.toFixed(3)}× > cap ${FRESH_CAP}× ` +
    `(per-case: ${CASES.map((c, i) => `${c} ${ratios[i].toFixed(2)}`).join(', ')}). ` +
    `Find the regressing change; do NOT loosen this cap without a justified re-baseline.`)
  console.log(`  fresh geomean ${g.toFixed(3)}× (cap ${FRESH_CAP}×): ${CASES.map((c, i) => `${c} ${ratios[i].toFixed(2)}`).join(' ')}`)
})
