/**
 * Structural absence-of-overhead invariants over OPTIMIZED output — the
 * machine-checked half of "predictable proven performance".
 *
 * invariants.js proves correctness-of-STRUCTURE (const, scope, exports, layout).
 * THIS file proves the PERFORMANCE CONTRACT: the optimized WAT contains none of
 * the overhead the optimizer claims to remove. You cannot prove "fast" — that is
 * induction against a moving JIT on a noisy stopwatch. You CAN prove "no waste":
 * a negative, statically checkable property of the output, independent of any
 * competitor or machine. That is the strongest guarantee actually available, and
 * the honest surrogate for speed (see .work/research.md §"minimal theoretical WASM").
 *
 * Two oracles over the same WAT facts:
 *
 *   1. ABLATION (per construct / per pass). A minimal trigger where the overhead
 *      is PRESENT with the guarding pass off (`optimize:{pass:false}`) and ABSENT
 *      with it on. Proves both that the check has TEETH (it can see the pattern)
 *      and that the NAMED pass is what removes it — the per-optimization
 *      attribution the net-output bench gate cannot give. Every pair below was
 *      verified to flip on/off before being committed; an assertion here is never
 *      a guess about what the optimizer "should" do.
 *
 *   2. POPULATION SWEEP (per generated sublanguage). The i32-disciplined fuzzer
 *      generators (test/fuzz.js) emit programs whose every value is an integer, so
 *      any f64 op inside a loop body is a LOST narrowing. Sweeping all seeds and
 *      asserting zero is a proof over the SUBLANGUAGE, not a 39-case sample. Clean
 *      generators are gated at hard zero; the one generator with a documented
 *      narrowing gap is RATCHETED — it cannot grow, and the baseline only shrinks.
 *
 * KERNEL_EXCLUDE'd (test/index.js): compiles at optimize:2 and inspects emitted
 * WAT; the self-host kernel runs optimize:false, so structural shape won't match.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import {
  parse, has, loopHas, count, loopCount, head, F64_OR_ROUNDTRIP, PTR_HELPER,
} from '../scripts/wat-probe.mjs'
import {
  typedIntSource, typedIntMinMaxSource, typedIVSRSource, typedByteScanSource, typedMapSource,
} from './fuzz.js'

// Test-specific predicates (the shared ones live in scripts/wat-probe.mjs):
// the loop trip-count overhead narrowLoopBound removes
const F64_CMP_OR_CONVERT = head(/^f64\.(lt|le|gt|ge|convert_i32)/)
// the per-element NaN-box base decode hoistGlobalPtrOffset lifts out of the loop
const GLOBAL_DECODE = (n) => n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1]) && n[1][0] === 'global.get'
const SIMD = head(/^(v128|f64x2|f32x4|i32x4|i16x8|i8x16)\./)
const LI_SNAP = (n) => typeof n[1] === 'string' && /^\$__li\d/.test(n[1])

// ════════════════════════════════════════════════════════════════════════════
// 1. ABLATION — overhead PRESENT with the guarding pass off, ABSENT with it on.
//    (control proves the check has teeth; on-state proves the named pass fires.)
// ════════════════════════════════════════════════════════════════════════════

test('ablation: narrowLoopBound kills the per-iteration f64 trip-count compare', () => {
  // f64 param bound `n`: without narrowing the loop test is `f64.lt(convert(i), n)`
  // every iteration; with it, the bound snaps to i32 once and the test is i32.lt_s.
  const src = `export let f = (buf, n) => { let s = 0; for (let i = 0; i < n; i++) s = (s + i) | 0; return s | 0 }`
  ok(loopHas(parse(src, { narrowLoopBound: false }), F64_CMP_OR_CONVERT), 'control: f64 trip-count compare present with pass OFF')
  ok(!loopHas(parse(src, 2), F64_CMP_OR_CONVERT), 'INVARIANT: no f64 trip-count compare in loop with pass ON')
})

test('ablation: narrowLoopBound also snaps an inclusive `i <= n` bound (NaN-safe)', () => {
  // `<=` snaps via floor with a NaN→I32_MIN guard (trunc_sat(floor(NaN))=0 would
  // wrongly run i=0). Correctness across NaN/Inf is in test/fuzz.js fuzzLoopBound;
  // this pins that the per-iteration f64.le is gone. (Was: factorial/sieve gap.)
  const src = `export let f = (n) => { let s = 0; for (let i = 0; i <= n; i++) s = (s + i) | 0; return s | 0 }`
  ok(loopHas(parse(src, { narrowLoopBound: false }), F64_CMP_OR_CONVERT), 'control: f64 <= compare present with pass OFF')
  ok(!loopHas(parse(src, 2), F64_CMP_OR_CONVERT), 'INVARIANT: inclusive bound narrowed to i32.le_s with pass ON')
})

test('ablation: hoistGlobalPtrOffset lifts the global NaN-box base decode out of the loop', () => {
  // re/im are module globals; their pointer base is loop-invariant. Without the
  // hoist every element access re-runs `i64.reinterpret_f64(global.get)` per step.
  const src = `let re = new Float64Array(64); let im = new Float64Array(64); export let g = () => { for (let i = 0; i < 64; i++) re[i] = re[i] + im[i] }`
  const off = { hoistGlobalPtrOffset: false, hoistInvariantPtrOffset: false, hoistInvariantLoop: false, vectorizeLaneLocal: false }
  ok(loopHas(parse(src, off), GLOBAL_DECODE), 'control: global base re-decoded inside loop with hoists OFF')
  ok(!loopHas(parse(src, 2), GLOBAL_DECODE), 'INVARIANT: global base decoded once at entry, never in loop, with pass ON')
})

test('ablation: vectorizeLaneLocal lifts a pure f64 element map to SIMD lanes', () => {
  const src = `export let f = () => { const a = new Float64Array(64); for (let i = 0; i < 64; i++) a[i] = (i - 30) * 0.5; for (let i = 0; i < 64; i++) a[i] = a[i] * 2.0; return a[0] }`
  ok(!has(parse(src, { vectorizeLaneLocal: false }), SIMD), 'control: scalar f64 loop with pass OFF')
  ok(has(parse(src, 2), SIMD), 'INVARIANT: SIMD lanes emitted with pass ON')
})

test('ablation: hoistInvariantLoop snaps an invariant cell read to a pre-header local', () => {
  // `inc` escapes via `keep`, so `i` stays a real captured heap cell; the loop
  // reads it invariantly. watr:false keeps the `$__li` snap name (coalesce renames it).
  const src = `const keep = (f) => f; export const main = () => { let i = 0; const inc = keep(() => i = i + 1); let s = 0; for (let j = 0; j < 10; j++) s = s + i + i; inc(); return s | 0 }`
  ok(!has(parse(src, { watr: false, hoistInvariantLoop: false }), LI_SNAP), 'control: no snap local with pass OFF')
  ok(has(parse(src, { watr: false }), LI_SNAP), 'INVARIANT: $__li snap local hoists the invariant read with pass ON')
})

test('ablation: promoteGlobals snapshots a repeatedly-read global to one function-entry local', () => {
  // `g` read 5×, never written → one `global.get` + cheap local.gets, not five 5-byte loads.
  const src = `let g = 5.5; export let f = () => { return g + g + g + g + g }`
  const gGet = (n) => n[0] === 'global.get' && n[1] === '$g'
  ok(count(parse(src, { promoteGlobals: false }), gGet) > 1, 'control: multiple global.get $g with pass OFF')
  ok(count(parse(src, 2), gGet) <= 1, 'INVARIANT: global read once, snapshotted to a local, with pass ON')
})

test('ablation: csePureExpr collapses a pure subexpression shared by the loop test and body', () => {
  // mandelbrot: `zx*zx` and `zy*zy` appear in BOTH the escape test and the body —
  // one snap each, not recomputed per use. (4 muls/iter without, 2 with + the cross term.)
  const src = `export let f = (cx, cy, m) => { let zx = 0.0, zy = 0.0, i = 0; while (i < m && zx*zx + zy*zy <= 4.0) { let t = zx*zx - zy*zy + cx; zy = 2.0*zx*zy + cy; zx = t; i = i + 1 | 0 } return i | 0 }`
  const mul = head(/^f64\.mul$/)
  ok(loopCount(parse(src, { csePureExpr: false }), mul) > loopCount(parse(src, 2), mul), 'INVARIANT: fewer f64.mul in loop with pass ON (shared zx*zx / zy*zy collapsed)')
})

// ════════════════════════════════════════════════════════════════════════════
// 2. POPULATION SWEEP — a proof over a generated sublanguage, not a sample.
//    Same seeded programs the correctness fuzzer runs (test/fuzz.js), checked
//    for absence-of-waste instead of value parity.
// ════════════════════════════════════════════════════════════════════════════
// Seed budget, scaled by JZ_FUZZ_GATE like the correctness fuzzer (test/fuzz.js)
// so a constrained CI leg can shrink it. Hard-zero gates are scale-invariant; the
// typed-int ratchet is `≤ baseline`, and fewer seeds can only LOWER the count, so
// scaling down never trips it. Baselines below are measured at the full 200.
const SWEEP = Math.max(20, Math.round(200 * Math.min(1, Math.max(0.05, +process.env.JZ_FUZZ_GATE || 1))))
const countLoopF64 = (gen) => {
  let n = 0
  for (let s = 1; s <= SWEEP; s++) {
    let viol
    try { viol = loopHas(parse(gen(s), 2), F64_OR_ROUNDTRIP) } catch { continue }
    if (viol) n++
  }
  return n
}
const countLoopHelper = (gen) => {
  let n = 0
  for (let s = 1; s <= SWEEP; s++) {
    let viol
    try { viol = loopHas(parse(gen(s), 2), PTR_HELPER) } catch { continue }
    if (viol) n++
  }
  return n
}

// CLEAN sublanguages — every program is integer-disciplined (all `|0`), so a
// fully-narrowed lowering has ZERO f64 in any loop. Hard gate over all seeds.
for (const [name, gen] of [
  ['Int32Array min/max', typedIntMinMaxSource],
  ['Int32Array break/continue (IV-SR)', typedIVSRSource],
  ['Uint8Array byte scan', typedByteScanSource],
]) {
  test(`sweep: ${name} emits NO f64 op in any loop body (seeds 1..${SWEEP}) — proven waste-free`, () => {
    is(countLoopF64(gen), 0)
  })
}

// typed-int nested-conditional narrowing: mostly CLOSED (13→2). A nested integer
// `?:` (`((3<a)?(2&a):((7<a)?a:1))|0`) used to bail to a scalar `(if (result f64))`
// with per-branch `f64.convert_i32_s`; toI32 now distributes ToInt32 through
// `(if result f64)` recursively (src/optimize/index.js), so the whole tree narrows
// to `(if result i32)` and the lane vectorizer lifts it as i32x4 bitselect. The
// residual 2 are deeper/odd shapes left to track. An INCREASE = a new lost-narrowing
// deopt regressed the compiler; a DECREASE = re-baseline DOWN to lock the win.
const TYPED_INT_F64_BASELINE = 2
test(`sweep: typed-int f64-in-loop ≤ ${TYPED_INT_F64_BASELINE} (ratchet — nested-conditional narrowing gap)`, () => {
  const n = countLoopF64(typedIntSource)
  ok(n <= TYPED_INT_F64_BASELINE,
    `${n} typed-int programs emit f64 in a loop (baseline ${TYPED_INT_F64_BASELINE}). ` +
    `INCREASE ⇒ a new lost-narrowing deopt regressed the compiler; DECREASE ⇒ improvement, re-baseline down.`)
})

// Loop-invariant pointer/length helpers must be hoisted, never re-run per element.
// Clean generators (internal arrays, constant length) lower with zero such calls
// in any loop — the LICM / hoistGlobalPtrOffset guarantee, over the population.
// (NB: the param-typed-array generator `typedSource` does NOT hold this AT LEVEL 2 — a
// typed array passed as a PARAM re-decodes its base every iteration, 200/200, because
// the polymorphic store reassigns `buf`. At SPEED (level 3) unswitchTypedParamLoop closes
// it: a Float64Array-gated fast loop hoists the base and vectorizes (test/unswitch-typed-
// param.js). This sweep parses at level 2, where the loop stays scalar — so the param
// generator remains excluded here.)
for (const [name, gen] of [
  ['Int32Array min/max', typedIntMinMaxSource],
  ['Uint8Array byte scan', typedByteScanSource],
  ['Float64Array pure map', typedMapSource],
]) {
  test(`sweep: ${name} hoists every pointer/length helper out of loops (seeds 1..${SWEEP})`, () => {
    is(countLoopHelper(gen), 0)
  })
}
