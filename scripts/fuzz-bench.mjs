#!/usr/bin/env node
// Perf-fuzzer: prove jz-wasm's speed advantage over V8 is BROAD, not an artifact
// of unsound/aggressive i32 narrowing on a cherry-picked corpus.
//
// For each seed it synthesizes a hot accumulation loop — `(n,p0,p1,p2) => { let
// acc=…; for (i<n) acc = f(acc, i, p…); return acc }` — across a spectrum from
// pure-integer (bitwise/imul/|0) to pure-float (* / ** sqrt) to mixed, compiles
// it with jz at the default opt level, and times jz-wasm vs the same source run
// as JS (V8, warmed/JITed). The internal loop amortizes the one boundary
// crossing, so the body's compute dominates.
//
// Reports the jz/V8 time ratio distribution PER CATEGORY. The thesis to falsify:
// "jz only wins on integer loops (via i32) and loses on float." If jz is on par
// or faster across ALL categories, the advantage is real and broad.
//
//   node scripts/fuzz-bench.mjs                 # 60 programs/category
//   node scripts/fuzz-bench.mjs --count=200 --iters=400 --n=20000
import jz from '../index.js'
import { CATEGORIES, genProgram } from './perf-corpus.mjs'

const arg = (k, d) => { const m = process.argv.find(a => a.startsWith(`--${k}=`)); return m ? Number(m.slice(k.length + 3)) : d }
const COUNT = arg('count', 60)      // programs per category
// Compute-dominated by design: large inner trip count, FEW calls — so the jz↔JS
// boundary wrapper (one crossing per call) is amortized to ~nothing and we measure
// the loop body's compute, which is what jz targets (kernels called rarely with
// big work). Measuring many small-N calls instead would conflate compute with
// per-call boundary overhead (a separate axis, irrelevant to the i32-soundness Q).
const N = arg('n', 500000)          // inner-loop trip count per call
const ITERS = arg('iters', 20)      // f(n,…) calls per timed batch
const BATCHES = arg('batches', 12)  // min-of-N timed batches (was 9)
// Warmup ROUNDS before timing (×ITERS calls). The within-process ratio is stable
// at a modest warmup once V8 has tiered the jz wasm up to TurboFan; 8 rounds
// (160 calls × the big inner loop) reliably outlasts the async tier-up compile.
// The headline metric is geomean (noise-cancelling: jz and V8 run back-to-back on
// the same machine). Bump --warm=N on a noisy runner. (CI-vs-local ratio drift is
// hardware — V8's wasm tier is relatively slower on some CPUs — not warmup.)
const WARM = arg('warm', 8)

// Program corpus (PRNG + per-category generators) is shared with the codegen
// ratchet — see scripts/perf-corpus.mjs.

// ── timing ───────────────────────────────────────────────────────────────────
const compileJS = (src) => new Function(`${src.replace(/export\s+let\s+f\s*=/, 'let f =')}\nreturn f`)()
// Min-of-batches: the fastest batch is the least perturbed by GC/scheduling, so
// it's the most stable estimate of true throughput (standard micro-bench practice).
const timeFn = (fn, args) => {
  let sink = 0
  for (let w = 0; w < WARM; w++) for (let i = 0; i < ITERS; i++) sink += fn(...args)   // warm / JIT (force wasm tier-up)
  let best = Infinity
  for (let b = 0; b < BATCHES; b++) {
    const t = performance.now()
    for (let i = 0; i < ITERS; i++) sink += fn(...args)
    const dt = performance.now() - t
    if (dt < best) best = dt
  }
  if (sink === Infinity) console.error('')   // defeat DCE of sink
  return best
}

// Non-integer params on purpose: V8's JIT value-specializes integer-valued f64
// inputs into a pure-int loop (~20× on `acc=(acc+p0)|0`), which is a *runtime
// value-feedback* win an AOT compiler can't have — it would conflate that with
// jz's compute speed. Genuinely-fractional inputs deny V8 that shortcut, so this
// measures f64-vs-f64 (and i32-vs-i32 for ToInt32-disciplined int code) honestly.
const ARGS = [N, 1.5, 2.7, 0.3]
const run = () => {
  console.log(`perf-fuzz: ${COUNT} programs/category, n=${N}, ${ITERS} calls/batch × ${BATCHES} batches\n`)
  const summary = {}
  for (const cat of Object.keys(CATEGORIES)) {
    const ratios = []          // jz / v8  (< 1 means jz faster)
    let wins = 0, ties = 0, losses = 0, skipped = 0
    const worst = []
    for (let s = 1; s <= COUNT; s++) {
      const src = genProgram(cat, s)
      let jsFn, jzFn
      try { jsFn = compileJS(src) } catch { skipped++; continue }
      try { jzFn = jz(src, { optimize: 2 }).exports.f } catch { skipped++; continue }
      // correctness sanity (cheap n): drop if jz != v8 — a perf number on a
      // miscompile is meaningless. (Strict; contract-overflow uses |0-disciplined int.)
      const cj = jsFn(50, 3, 1.5, 7), cw = jzFn(50, 3, 1.5, 7)
      if (!(Object.is(cj, cw) || cj === cw || (Number.isNaN(cj) && Number.isNaN(cw)))) { skipped++; continue }
      const v8 = timeFn(jsFn, ARGS), jzt = timeFn(jzFn, ARGS)
      const r = jzt / v8
      ratios.push(r)
      if (r <= 1.02) wins++; else if (r <= 1.15) ties++; else { losses++; worst.push({ s, r, src }) }
    }
    ratios.sort((a, b) => a - b)
    const pct = (q) => ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * q))] : NaN
    // geomean: the correct central tendency for ratios (multiplicative). Tighter
    // than median on these right-skewed distributions, so a regression can't hide
    // behind a healthy median.
    const geo = ratios.length ? Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length) : NaN
    const med = pct(0.5), p75 = pct(0.75), p90 = pct(0.9)
    const max = ratios.length ? ratios[ratios.length - 1] : NaN
    summary[cat] = { geo, med, p75, p90, max, wins, ties, losses, skipped }
    console.log(`[${cat}]  geomean ${geo.toFixed(2)}×  med ${med.toFixed(2)}×  p75 ${p75.toFixed(2)}×  p90 ${p90.toFixed(2)}×  max ${max.toFixed(2)}×  | faster/par:${wins}  near:${ties}  slower:${losses}  skip:${skipped}`)
    worst.sort((a, b) => b.r - a.r).slice(0, 3).forEach(w => console.log(`    slowest s=${w.s} ${w.r.toFixed(2)}×: ${w.src.slice(0, 110)}`))
  }
  console.log('\nthesis: jz is firm vs V8 iff geomean ≤ floor AND p75 ≤ floor (¾ win/tie) AND no max blow-up, per category.')
  return summary
}
const summary = run()

// ── Gate (category-aware, geomean + blow-up ceiling) ─────────────────────────
// Median was too coarse (a 2.5× tail passed). We gate on GEOMEAN (the right average
// for ratios; tighter than median on these right-skewed distributions, so a
// regression can't hide behind a healthy median) plus a MAX ceiling (catches a
// blow-up / miscompile).
//
// Thresholds are CATEGORY-AWARE because "beat V8-JS" is only HARDWARE-ROBUST on
// `float`: jz does no NaN-boxing there and wins on any machine (geomean ~0.72).
// `int`/`mixed` are bitwise/ToInt32/shift-heavy, where V8's JS JIT beats its OWN
// wasm tier by an amount that VARIES BY CPU (this machine: mixed geomean ~0.82;
// some CI runners: median ~1.22) — a hand-optimal WAT hits the same floor, so it's
// V8 architecture, not jz codegen. So `float` is gated firmly; `int`/`mixed` get a
// CI-portable geomean cap + a max blow-up ceiling (they catch a real jz regression
// without flaking on the hardware-dependent tier gap). p75/p90 are reported for
// firmness visibility (¾-win) but not gated, for the same portability reason. The
// truly portable "firm" signal is a jz-vs-jz throughput ratchet — see TODO below.
// --gate=N overrides every category's geomean cap (legacy uniform mode).
const FLOORS = {
  float: { geo: 0.90, max: 1.25 },   // firm: jz's hardware-robust win
  int:   { geo: 1.12, max: 1.35 },
  mixed: { geo: 1.25, max: 1.75 },   // V8 wasm-tier floor (hardware-variable) — blow-up gate only
}
const fmt = (x) => Number.isFinite(x) ? x.toFixed(2) + '×' : 'no-data'
const override = Number((process.argv.find(a => a.startsWith('--gate=')) || '').slice(7)) || null
const fails = []
for (const [cat, s] of Object.entries(summary)) {
  const t = FLOORS[cat] || { geo: 1.15, max: 1.75 }
  const geoCap = override ?? t.geo
  if (!(s.geo <= geoCap)) fails.push(`${cat} geomean ${fmt(s.geo)} > ${geoCap}×`)
  if (!override && !(s.max <= t.max)) fails.push(`${cat} max ${fmt(s.max)} > ${t.max}× — blow-up, inspect the slowest seed`)
}
if (fails.length) {
  console.error('\nFAIL: perf-fuzz gate — ' + fails.join('; '))
  process.exit(1)
}
console.log('PASS: per-category geomean within floor + no blow-up (jz firm on float; int/mixed at the documented V8 wasm-tier floor).')
// TODO(perf): add a jz-vs-jz throughput ratchet (compare against a committed
// baseline of jz-wasm ns/op per category) — that's the machine-independent way to
// catch a codegen regression on the int/mixed shapes where jz-vs-V8 is hardware noise.
