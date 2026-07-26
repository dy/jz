/**
 * Native-vs-kernel WAT byte identity. The self-host kernel runs the SAME
 * pipeline as index.js — since both consume the one final-optimizer tail
 * (src/optimize/watr-tail.js), identical source at the same tier must print
 * identical WAT. A byte diff here means the pipelines drifted again (the
 * pre-tail state: kernel omitted ifset/inlineWrappers/LICM/guard/unroll2/
 * pins/pointer-repair and O2 output silently diverged).
 */
import test from 'tst'
import { is } from 'tst/assert.js'
import { compile } from '../index.js'
import { compileViaKernel } from './kernel-target.js'
import { onWasi } from './_matrix.js'

const CORPUS = {
  sum: `export let sum = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }`,
  math: `export let f = (x) => Math.sqrt(x * x + 1) + Math.abs(x)`,
  dict: `export let count = (s) => { let d = {}; for (let i = 0; i < s.length; i++) { let c = s[i]; d[c] = (d[c] || 0) + 1 } return d['a'] || 0 }`,
  arr: `export let rev = (n) => { let a = []; for (let i = 0; i < n; i++) a.push(i * 2); let s = 0; for (let i = a.length - 1; i >= 0; i--) s += a[i]; return s }`,
  // preEval coverage (audit P0 2026-07-25): the kernel entries used to skip the
  // preEval front-half stage entirely, so statically-foldable programs emitted
  // different bits than native AT EVERY TIER — and none of the rows above
  // exercised constant folding. These two are the audit's own repros: float
  // fold ordering (0.1+0.2-0.3 bit pattern) and pure-Math folding at O0.
  fold: `export let f = () => 0.1 + 0.2 - 0.3`,
  mfold: `export let g = () => Math.sqrt(9) + Math.abs(-2)`,
}

// Residual known divergences: NONE — every corpus row is byte-identical at
// every tier. The long-tail fell in four waves (2026-07-25): the elemOrigin
// gate (push-on-param element misproof), the dyn-spread raw-bool store
// (emitDynamicSpread missing carrierF64 — preset `=== true` gates read false
// in-kernel, dropping speed-tier passes; sum|3 + arr|3), the recursionUnroll
// shared-acc reset (the callee's non-zero acc init cloned verbatim reset the
// caller's total — the O3-built kernel's embedded watr count() undercounted
// arm sizes and mis-fired the select fold; dict|2 + dict|3), and the
// fold-fork below (fold|0/2/3). If a change re-opens a divergence, re-add its
// `name|opt` key here with a dated note.
// fold|* GRADUATED (audit P0-2, host-independent rational fold): the
// front-half unification (src/front.js) made the kernel RUN preEval (it used
// to skip it), which exposed this layer — native folded 0.1+0.2-0.3 through
// the exact-rational carry (rationalConst, gated on HOST_PROFILE.wideBigint)
// -> 2.775…e-17, while the kernel's i64-wrapping BigInt couldn't carry a
// rational past 64 bits and fell back to IEEE per-op folding -> 5.551…e-17 —
// compiled output depended on the COMPILER HOST, a determinism violation.
// Fix: pre-eval.js's Rational layer now runs on bignum.js's u32-limb
// arithmetic (plain JS number arrays — no width ceiling, no native BigInt),
// so it folds bit-identically whether this code runs natively or self-hosted
// in-kernel; HOST_PROFILE.wideBigint's only two readers (this gate and
// emitNeg's literal fallback) are both gone, and the flag was removed from
// ctx.js. mfold (integer Math fold) was already byte-identical (graduated
// 2026-07-25 the same day: that divergence was measured against a STALE
// dist whose build had crashed — pre-eval.js used computed Math members,
// outside the self-host subset; explicit dispatch tables fixed the build).
const PARITY_TODO = new Set()

for (const opt of [0, 2, 3]) {
  test(`kernel parity: byte-identical WAT at O${opt}`, () => {
    // wasi matrix leg: native picks up the WASI boundary shims the kernel's
    // js-host pipeline never emits — divergence by construction, not drift.
    if (onWasi()) return
    for (const [name, src] of Object.entries(CORPUS)) {
      const nat = String(compile(src, { wat: true, optimize: opt }))
      const ker = String(compileViaKernel(src, { wat: true, optimize: opt }))
      if (PARITY_TODO.has(`${name}|${opt}`)) {
        // Divergence-still-present tripwire (not a success claim — the todo
        // entries above carry the real status): flags a silent fix so the row
        // graduates into the byte-identity set.
        is(ker !== nat, true, `${name} O${opt}: known divergence vanished — graduate this row to byte-identity`)
        continue
      }
      is(ker === nat, true,
        `${name} O${opt}: ${ker === nat ? 'identical' : `diverges (native ${nat.length}B vs kernel ${ker.length}B)`}`)
    }
  })
}
