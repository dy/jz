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

// Exported for test/kernel-oracle.js — the ORACLE tier reuses these same source
// strings (byte identity alone certifies identically-wrong output just as easily
// as identically-right output; the oracle tier is the correctness check this
// file's byte-diff cannot provide — see that file's header).
export const CORPUS = {
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
  // Self-host miscompile #4 (audit re-hunt, 2026-07-30): a helper whose return
  // tails mix a NUMBER with a bare `false` literal, tested via `=== false` /
  // `!== false` at the call site — module/typedarray.js's `isConst` is this
  // shape (SIMD-pattern-detection: `typeof node === 'number' ? node : …
  // return false`), and its call sites in analyzeSimd gate on `!== false`.
  // Compiling THIS SOURCE (not running it) is what exposed the bug: native
  // jz never runs typedarray.js's own JS through jz's compiler, only the
  // kernel build does (dist/jz.wasm = jz compiling its own source) — so a
  // codegen defect in this exact shape stayed invisible until self-hosted.
  // Root cause: the boolean literal's cheap i32 0/1 representation (by
  // design — branch/arithmetic position) only gets boxed into a real f64
  // TRUE/FALSE atom at a handful of explicit escape sites; a NUMBER-mixed
  // generic-f64 return isn't one of them, so `return false` here silently
  // crossed as the plain float 0 — indistinguishable from a genuine `0`
  // constant at `!== false`, so the guard was always true. Originally worked
  // around at module/typedarray.js's `isConst` (a `null` sentinel instead of
  // overloading `false` — `null`'s compiled representation is always a
  // proper NaN-box, no i32-vs-f64 ambiguity) pending a real fix for "this
  // class of return-boxing gap elsewhere in the compiler" (audit #5 item 4).
  // That fix landed (audit #5 item 2, this exact CORPUS row — see
  // src/compile/emit.js 'return' + src/compile/index.js emitFunc's
  // ctx.func.mixedAtomReturn: a function with >= 2 syntactic return
  // statements that isn't proven uniformly BOOL now boxes any individually-
  // BOOL return tail to its TRUE_NAN/FALSE_NAN atom) — `isConst` was reverted
  // back to overloading `false` as ITS OWN generality test: the self-hosted
  // kernel now compiles this exact mixed-return shape, in the compiler's own
  // source, soundly.
  boolconst: `const g = (n) => { if (typeof n === 'number') return n; return false }
export let f = (s) => g(s) === false`,
  // Self-host miscompile #5 (audit re-hunt, 2026-07-30): composing two
  // typed-array constructors — `new Int32Array(new Float64Array([x]))` —
  // nests two instances of the SAME `new.${name}` closure template (module/
  // typedarray.js's `for (const [name, elemType] of Object.entries(...))`
  // loop). The outer (Int32Array) instance's copy path called `emit(lenExpr)`
  // (recursing into the inner Float64Array instance) BEFORE calling
  // `copyFromTyped(src)`, which itself closes over `elemType`/`aux`/`stride`/
  // `name` from the SAME loop — a nested emit() call between a closure's
  // capture and its later re-read is the ledger's "closure-capture-after-
  // nested-emit" self-host class (.work/todo.md 2026-07-23, TYPED-INDEX
  // KERNEL MISCOMPILE): once compiled by the kernel, the outer closure's
  // read of elemType AFTER the nested call observed the INNER (Float64Array,
  // elemType=7) iteration's value instead of its own (Int32Array, elemType=4)
  // — the copy loop wrote f64.store at stride 8 instead of the ToInt32-
  // wrapped i32.store at stride 4. Fixed by building copyFromTyped's (and the
  // sibling runtime-dispatch branch's) IR BEFORE the nested emit(lenExpr)
  // call — same final IR tree, reordered so the vulnerable closure reads
  // happen before the recursive compile, not after.
  nestedtyped: `export let f = (x) => new Int32Array(new Float64Array([x]))[0]`,
  // Class-wide sweep (2026-07-30, ledger-directed): three more capture-after-
  // nested-emit sites found and fixed alongside nestedtyped, all in
  // module/typedarray.js's per-iteration `for (const [...] of Object.entries(...))`
  // emitter closures — same root as nestedtyped, different tables/branches.
  // Fixed by snapshotting the closure's OWN captures into locals before the
  // first nested emit() call, so later reads see the local (immune) instead of
  // re-reading the free variable (which a nested sibling-closure invocation can
  // clobber once this file is kernel-compiled).
  // (1) new.${name}'s SUBVIEW branch (`new T(buffer, off, len)`): `stride`/
  // `name` read after emit(lenExpr2)/emit(offsetExpr) — untouched by the
  // nestedtyped fix, which only covered the srcType===TYPED and srcType==null
  // branches of the same closure.
  subviewtyped: `export let f = (buf) => new Int32Array(buf, 0, new Float64Array(4).length)`,
  // (2)+(3) the DataView get/set closures (DV_GET/DV_SET loops): loadOp/
  // resultType/size/signed (get) and storeOp/valType/size (set) read after
  // emit(off)/emit(val)/emit(leNode) — reachable via a DataView receiver
  // nesting another DataView call in an offset/value position.
  dvnested: `export let f = (dv) => dv.setFloat64(dv.getInt32(0), dv.getFloat64(8))`,
  // (4) TypedArray.from's array-literal fast path: stride/store/elemType
  // re-read for element k+1 after element k's emit() — reachable when one
  // literal element is itself a nested same-family typed-array construction.
  fromnested: `export let f = () => Int32Array.from([Float64Array.from([5])[0], 2])`,
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
//
// dict|2 + dict|3 briefly reopened, then re-closed, while landing audit-#10
// (2026-08-04, kind-specific nullish-receiver TypeError checks). An early
// draft gated the new checks on "receiver kind unresolved" alone, which
// fired for dict's s.length and, as a side effect, minted dict's first-ever
// Error schema -- which activated a previously-dead schema-checking arm in
// the shared stdlib helper $__dyn_get_t_h (module/collection.js), whose own
// WAT folds one truthiness check differently native vs self-hosted
// (confirmed PRE-EXISTING, not introduced by this task: reproduced
// identically at clean HEAD 1d083ba9 via a disposable worktree, forcing an
// unrelated dead-code Error schema into the same dict source). Landed fix:
// gate the checks on the narrower, pre-existing `censusMaybeUndefined`
// predicate (kind.js) instead -- "kind unresolved" alone is not "might be
// undefined" (a plain polymorphic-kind parameter, e.g. bench/poly.js's
// sum(arr) called with both a Float64Array and an Int32Array, is never
// nullish) -- which also fixed a real SIZE-geomean regression the broader
// gate caused across the size-sweep corpus. dict's s is a plain string
// parameter, never census-tainted, so it no longer reaches the guard, no
// schema gets minted, and dict is back to genuine byte-identity --
// reverified after the narrowing landed, not assumed.
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
