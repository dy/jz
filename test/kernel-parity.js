/**
 * Native-vs-kernel WAT byte identity. The self-compile kernel runs the SAME
 * pipeline as index.js — since both consume the one final-optimizer tail
 * (src/optimize/watr-tail.js), identical source at the same tier must print
 * identical WAT. A byte diff here means the pipelines drifted again (the
 * pre-tail state: kernel omitted ifset/inlineWrappers/LICM/guard/unroll2/
 * pins/pointer-repair and O2 output silently diverged).
 */
import test from 'tst'
import { is, throws } from 'tst/assert.js'
import { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { compileViaKernel } from './kernel-target.js'
import { onWasi, levels } from './_matrix.js'
import { CORPUS } from './_kernel-corpus.js'


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
// so it folds bit-identically whether this code runs natively or self-compiled
// in-kernel; HOST_PROFILE.wideBigint's only two readers (this gate and
// emitNeg's literal fallback) are both gone, and the flag was removed from
// ctx.js. mfold (integer Math fold) was already byte-identical (graduated
// 2026-07-25 the same day: that divergence was measured against a STALE
// dist whose build had crashed — pre-eval.js used computed Math members,
// outside the self-compile subset; explicit dispatch tables fixed the build).
//
// dict|2 + dict|3 briefly reopened, then re-closed, while landing audit-#10
// (2026-08-04, kind-specific nullish-receiver TypeError checks). An early
// draft gated the new checks on "receiver kind unresolved" alone, which
// fired for dict's s.length and, as a side effect, minted dict's first-ever
// Error schema -- which activated a previously-dead schema-checking arm in
// the shared stdlib helper $__dyn_get_t_h (module/collection.js), whose own
// WAT folds one truthiness check differently native vs self-compiled
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

test('kernel parity: owned, imported and shared memory preserve options and returned values', () => {
  const src = `export function f(n) {
    const a = new Uint8Array(n & 7)
    return ['prefix-' + n, a.length, a[0]]
  }`
  for (const optimize of levels(0, 2, 3)) {
    const cases = [null, false, true, false, true, null]
    for (let i = 0; i < cases.length; i++) {
      const shared = cases[i], imported = shared !== null
      const memory = imported ? new WebAssembly.Memory({ initial: 2, maximum: 8, shared }) : null
      const descriptor = { initial: 2, maximum: 8, ...(imported ? { import: true, shared } : {}) }
      const opts = { optimize, host: 'js', memory: imported && i < 3 ? memory : descriptor }
      const wat = compileViaKernel(src, { ...opts, wat: true })
      is(wat === compile(src, { ...opts, wat: true }), true, `memory case ${i}, O${optimize}: WAT parity`)
      const bytes = compileViaKernel(src, opts)
      const p = instantiate(bytes, imported ? { memory } : {})
      for (const n of [0, 1, 1, 6, 0])
        is(p.exports.f(n), ['prefix-' + n, n & 7, n & 7 ? 0 : undefined], `memory case ${i}, O${optimize}: n=${n}`)
    }
  }
  for (const initial of [-1, 0.5, NaN, Infinity, -Infinity, 65537, '2', true])
    for (const memory of [initial, { initial }])
      throws(() => compileViaKernel(src, { memory }), /non-negative integer page count/)
  for (const maximum of [0, -1, 1.5, NaN, Infinity, -Infinity, 65537])
    throws(() => compileViaKernel(src, { memory: { maximum } }), /positive integer page count/)
  throws(() => compileViaKernel(src, { memory: { initial: 4, maximum: 2 } }), /below the initial/)
  is(instantiate(compileViaKernel(src)).exports.f(0), ['prefix-0', 0, undefined], 'ordinary compilation after rejected limits')
})

test('kernel parity: static data respects maximum pages and failed assembly leaves no state', () => {
  const literal = 'x'.repeat(40000)
  const src = `export function f(){return ${JSON.stringify(literal)}}`
  for (const compiler of [compile, compileViaKernel]) {
    for (const maximum of [1, 1, 2, 1, 2]) {
      const opts = { memory: { maximum } }
      if (maximum === 1) throws(() => compiler(src, opts), /exceeding memory.maximum/)
      else {
        const p = instantiate(compiler(src, opts))
        is(p.exports.f(), literal)
        is(p.exports.f(), literal, 'same instance again')
        is(p.memory.buffer.byteLength, 2 * 65536)
      }
    }
    is(instantiate(compiler('export function f(){return "ok"}', { memory: { maximum: 1 } })).exports.f(), 'ok', 'smaller static data after assembly rejection')
    is(instantiate(compiler(src)).exports.f(), literal, 'default maximum after bounded compilation')
  }
})

test('kernel parity: fixed-memory rejects unsafe final code and recovers to ordinary compilation', () => {
  const cases = [
    ['dynamic allocation', 'export function f(n){return new Float64Array(n).length}', /heap allocation or memory growth/],
    ['escaping constant allocation', 'export function f(){return new Float64Array(4)}', /heap allocation or memory growth/],
    ['growing state', 'let a=[];export function f(n){a.push(n);return a.length}', /heap allocation or memory growth/],
    ['host call', 'import {tick} from "host";export function f(){return tick()}', /host or unresolved call/],
    ['recursive scratch', 'export function f(n){const a=new Float64Array(4);a[0]=n;return n>0?f(n-1)+a[0]:a[0]}', /recursive call/],
    ['recursive scratch in another caller', 'function step(n){const a=new Float64Array(4);a[0]=n;return n>0?step(n-1)+a[0]:a[0]}export function f(){return step(0)}export function outside(n){return step(n)}', /recursive call/],
  ]
  const opts = { host: 'js', optimize: 0, memory: { fixed: ['f'] }, imports: { host: { tick: () => 1 } } }
  for (const [name, src, reason] of cases) {
    throws(() => compile(src, opts), reason, `${name}: native proof`)
    throws(() => compileViaKernel(src, opts), reason, `${name}: hosted proof`)
  }
  const src = 'export function f(n){return new Float64Array(n).length}'
  is(instantiate(compileViaKernel(src)).exports.f(2), 2, 'the default compiler remains usable after rejected contracts')
})

test('kernel parity: fixed scratch preserves zeroing, repeated calls and changed contracts', () => {
  const src = 'export function f(i,x){const a=new Float64Array(4);a[i]=x;return a[0]+a[1]}'
  for (const optimize of levels(0, 2, 3)) {
    const opts = { optimize, host: 'js', memory: { fixed: ['f'] } }
    is(compileViaKernel(src, { ...opts, wat: true }), compile(src, { ...opts, wat: true }), `fixed scratch WAT, O${optimize}`)
    const p = instantiate(compileViaKernel(src, opts)), used = p.memory.used, bytes = p.memory.buffer.byteLength
    for (const [i, x, expected] of [[0, 7, 7], [0, 7, 7], [1, 11, 11], [3, 4, 0], [4, 9, 0], [-1, 2, 0], [0, 0, 0]])
      is(p.exports.f(i, x), expected, `scratch[${i}], O${optimize}`)
    is(p.memory.used, used, 'no retained allocation')
    is(p.memory.buffer.byteLength, bytes, 'no growth')
    const other = 'export function g(n){const a=new Int8Array(4);a[0]=n;return a[0]}'
    is(instantiate(compileViaKernel(other, { optimize, memory: { fixed: ['g'] } })).exports.g(257), 1, 'a different contract and element layout')
    is(instantiate(compileViaKernel(src, opts)).exports.f(1, 13), 13, 'original contract after a changed program')
  }
})

for (const opt of levels(0, 2, 3)) {
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
