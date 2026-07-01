/**
 * Self-host gate: build dist/jz.wasm, instantiate it, and verify its
 * `default(source)` round-trips real programs through the in-wasm pipeline.
 *
 * Contract (matches scripts/selfhost-build.mjs + scripts/self.js):
 *   host:   self   = instantiate(dist/jz.wasm)
 *   wasm:   bytes  = self.default(source)   // parse → jzify → prepare → compile → watr
 *   host:   result = instantiate(bytes).exports.main()
 *
 * The whole compiler runs in wasm — the host only passes the source string in and
 * reads the wasm bytes out. dist/jz.wasm is jz, compiled by jz.
 *
 * Run: node test/selfhost.js   |   CI: npm run test:self
 */
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { instantiate } from '../interop.js'
import jz from '../index.js'   // native compiler — the correctness reference for the kernel's output

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'scripts/selfhost-build.mjs')
const SELF = join(ROOT, 'dist/jz.wasm')

const ensureSelf = () => {
  if (existsSync(SELF)) return
  const r = spawnSync(process.execPath, [BUILD], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 })
  if (r.status !== 0) {
    console.log(r.stdout); console.log(r.stderr)
    throw new Error(`selfhost build exit ${r.status}`)
  }
}

// One instance reused across samples — instantiation is the slow part (~4 MB
// wasm). compileSelf resets its internal ctx on each call, so samples don't
// contaminate each other.
let self
const getSelf = () => {
  if (!self) {
    ensureSelf()
    self = instantiate(readFileSync(SELF), { memory: 8192 })
  }
  return self
}

const compileViaSelf = (src) => {
  const s = getSelf()
  const out = s.exports.default(s.memory.String(src))
  const bin = s.memory.read(out)
  const bytes = bin instanceof Uint8Array ? bin : new Uint8Array(bin)
  if (bytes.length <= 8) throw new Error('self-host returned empty wasm: ' + bytes.length + ' bytes')
  return bytes
}

test('selfhost: build dist/jz.wasm', () => {
  const r = spawnSync(process.execPath, [BUILD], {
    cwd: ROOT, encoding: 'utf8', timeout: 600_000,
  })
  if (r.status !== 0) { console.log(r.stdout); console.log(r.stderr) }
  ok(r.status === 0, `build exit ${r.status}`)
  ok(r.stdout.includes('jz.wasm'), 'self-host artifact reported')
  ok(readFileSync(SELF).byteLength > 100_000, 'self-host wasm has substance')
})

// Sample programs the self-host compiler must lower correctly. Each tuple is
// [label, source, expected-main()-result]. Picked to cover the major
// emit paths (arith, calls, loops, strings, arrays, objects, closures).
const SAMPLES = [
  ['arithmetic',  'export let main = () => 3 + 4 * 5', 23],
  ['function',    'let inc = x => x + 1; export let main = () => inc(10)', 11],
  ['loop',        'export let main = () => { let s = 0; for (let i = 0; i < 10; i++) s += i; return s }', 45],
  ['string-len',  'export let main = () => "hello world".length', 11],
  ['array-reduce','export let main = () => [1,2,3,4,5].reduce((a,b)=>a+b, 0)', 15],
  ['closure',     'let mk = n => (x => x + n); let add5 = mk(5); export let main = () => add5(7)', 12],
  ['recursion',   'let fib = n => n < 2 ? n : fib(n-1) + fib(n-2); export let main = () => fib(10)', 55],
  // Math intrinsics whose emitters build WAT strings at compile time — guards the
  // class of self-host bug where the builder uses a construct the kernel lacks
  // (Math.expm1's Horner fold once used Array.reduceRight, absent from jz's runtime,
  // so the kernel interpolated `undefined` into the WAT). Tolerance-checked in-program
  // (returns 1/0) so the exact-equality assert below stays uniform.
  ['math-sqrt',   'export let main = () => (Math.abs(Math.sqrt(2) - 1.4142135623730951) < 1e-9) | 0', 1],
  ['math-exp',    'export let main = () => (Math.abs(Math.exp(0.3) - 1.3498588075760032) < 1e-6) | 0', 1],
  ['math-expm1',  'export let main = () => (Math.abs(Math.expm1(0.3) - 0.3498588075760032) < 1e-6) | 0', 1],
]

for (const [label, src, expected] of SAMPLES) {
  test(`selfhost: ${label}`, () => {
    const bin = compileViaSelf(src)
    ok(bin.byteLength > 10, 'self-host produced wasm bytes')
    const inst = instantiate(bin, { memory: 256 })
    is(inst.exports.main(), expected, `main() === ${expected}`)
  })
}

// The SAMPLES above round-trip at optimize:false (compileViaSelf passes no optJSON),
// so they never reach watr's single-call inliner. This pins the LEVEL-2 inliner path:
// inlineOnce grew large enough that the self-host kernel mis-compiled its `pinned` Set
// local (pointer zeroed → __set_add trapped "memory access out of bounds" on every L2
// compile of a program with an inlinable helper). The fix extracts inlBuildPinned to a
// small scope; a future re-inline would re-break this. forEach's `x=>s+=x` is the single-
// call helper inlineOnce lifts, so this routes straight through the once-trapping path.
test('selfhost: level-2 inliner is sound (inlineOnce pinned-Set)', () => {
  getSelf()  // ensure dist/jz.wasm built
  const s = instantiate(readFileSync(SELF), { memory: 8192 })  // fresh instance, as a real self-host run does
  const src = 'export let main = () => { let s = 0; [1,2,3,4].forEach(x => s += x); return s }'
  const out = s.exports.default(s.memory.String(src), 0, s.memory.String(JSON.stringify({ level: 2 })))
  const bin = s.memory.read(out)
  const bytes = bin instanceof Uint8Array ? bin : new Uint8Array(bin)
  ok(bytes.length > 8, 'level-2 self-host produced wasm bytes (no __set_add trap)')
  is(instantiate(bytes, { memory: 256 }).exports.main(), 10, 'main() === 10 (1+2+3+4)')
})

// Pins the LEVEL-2 f64-constant pool. hoistConstantPool used to key+emit a pooled constant
// through `String(number)`, which keeps only ~9 sig digits IN THE KERNEL (jz's number formatter),
// so a high-precision literal lost precision (0.041666666666666664 → 0x1.5555558325751p-5) — the
// kernel's L2 output diverged from jz.js (fft/synth twiddle coefficients). Fixed by keying on the
// exact 64 bits and emitting the number itself. A 17-digit literal used twice (so it pools) whose
// reciprocal is a clean integer makes any precision loss numerically visible.
test('selfhost: level-2 f64-constant pool keeps full precision', () => {
  getSelf()
  const s = instantiate(readFileSync(SELF), { memory: 8192 })
  // 0.041666666666666664 === 1/24 exactly; pooled (two uses) → its reciprocal must stay 24.
  const src = 'export let main = () => { const a = 0.041666666666666664; const b = 0.041666666666666664; return 1/a + 1/b }'
  const out = s.exports.default(s.memory.String(src), 0, s.memory.String(JSON.stringify({ level: 2 })))
  const bin = s.memory.read(out)
  const bytes = bin instanceof Uint8Array ? bin : new Uint8Array(bin)
  is(instantiate(bytes, { memory: 256 }).exports.main(), 48, 'kernel-pooled 1/24 stays exact (1/a+1/b === 48)')
  is(instantiate(bytes, { memory: 256 }).exports.main(), jz(src).exports.main(), 'kernel L2 === jz.js L2')
})

// Pins the LEVEL-2 LICM hoist-local typing. resultType (src/optimize/index.js) classified a
// hoisted subtree's wasm type; its comparison-op guard was a regex `/^(eq|ne|lt|gt|le|ge)(_[su])?$/`
// which, compiled into the kernel at −O2, mis-anchored — `f64.nearest`'s mantissa `nearest` starts
// with `ne`, so the kernel matched it as a comparison and typed the hoisted `f64.nearest(p0)` local
// i32 → `local.set (f64.nearest …)` = invalid wasm (f64 into i32). jz.js used V8's regex (correct),
// so this was KERNEL-ONLY and only the full local fuzz (seed=192) surfaced it. Fixed by detecting
// comparison mantissas with an explicit Set. Needs the LICM shape: Math.round(p0) loop-invariant in
// the INNER of two nested loops, p0 reassigned in the OUTER → the round's f64.nearest is hoisted.
test('selfhost: level-2 LICM types a hoisted f64.nearest local f64 (Math.round in nested loops)', () => {
  getSelf()
  const s = instantiate(readFileSync(SELF), { memory: 8192 })
  const src = 'let f = (p0) => { let r = 0; let i = 0; while (i < 4) { let j = 0; while (j < 3) { r = r + Math.round(p0); j = j + 1; } p0 = p0 + 0.4; i = i + 1; } return r }; export let main = () => f(2.6)'
  const out = s.exports.default(s.memory.String(src), 0, s.memory.String(JSON.stringify({ level: 2 })))
  const bin = s.memory.read(out)
  const bytes = bin instanceof Uint8Array ? bin : new Uint8Array(bin)
  // instantiate THROWS if the kernel emitted invalid wasm (f64.nearest into an i32 local).
  is(instantiate(bytes, { memory: 256 }).exports.main(), 39, 'kernel L2 round-in-nested-loops valid + correct (3+3+3+4 rounds ×3)')
  is(instantiate(bytes, { memory: 256 }).exports.main(), jz(src, { optimize: 2 }).exports.main(), 'kernel L2 === jz.js L2')
})

// Pins the f64x2 lane vectorizer under self-host — it broke ENTIRELY two ways this regression hit:
//  (1) tryToneMap built its `ctx` with a different field set than the other lifters; the kernel
//      infers one struct layout per shared callee (liftFail), so the mismatched shape corrupted
//      field reads and liftExprV returned null across the board (re-broke 11657cf), and
//  (2) the kernel pipeline (scripts/self.js) omitted appendLateStdlib, so the 'post' vectorizer's
//      injected `$math.log_v` body was never appended → "Unknown func $math.log_v" at instantiate.
// A tone-map kernel lifts Math.log → f64x2.log_v, exercising both. Compile it SIMD ('speed') and
// scalar (optimize:false) through the kernel; both must instantiate and yield the same checksum.
test('selfhost: f64x2 lane vectorizer is sound (tone-map ctx-shape + late stdlib)', () => {
  getSelf()
  const TONE = `
    let dens = new Uint32Array(64), px = new Uint32Array(64)
    export let main = () => {
      let i = 0
      while (i < 64) { dens[i] = (i * 53) % 600; i++ }
      i = 0
      while (i < 64) { let v = dens[i], g = 0; if (v > 0) { let L = Math.log(v + 1.0) * 44.0; g = (L > 255.0 ? 255.0 : L) | 0 } px[i] = (255 << 24) | (g << 16) | (g << 8) | g; i++ }
      let s = 0; i = 0; while (i < 64) { s = (s + px[i]) | 0; i++ }
      return s
    }`
  const native = jz(TONE, { optimize: 'speed' }).exports.main()   // the correct checksum
  const s = instantiate(readFileSync(SELF), { memory: 8192 })
  // {level:'speed'} (object form, as the kernel-target always passes) → the f64x2 tone-map vectorizer
  const out = s.exports.default(s.memory.String(TONE), 0, s.memory.String(JSON.stringify({ level: 'speed' })))
  const bin = s.memory.read(out), bytes = bin instanceof Uint8Array ? bin : new Uint8Array(bin)
  ok(bytes.length > 8, 'self-host produced wasm bytes (no ctx-shape malformed lift)')
  // instantiate would throw "Unknown func $math.log_v" if appendLateStdlib were missing; the
  // |0 truncation in the kernel absorbs the f64x2 poly's sub-ULP lane noise, so the checksum is exact.
  is(instantiate(bytes, { memory: 256 }).exports.main(), native, 'kernel SIMD tone-map === native')
})

// Warm-instance reuse: instantiate ONCE, `_clear()` the bump arena between compiles,
// and pin byte-parity against a fresh instance compiling the same programs. Exercises
// the caches that used to dangle across a warm `_clear` (all now reset/copy-on-tag
// per compile): DOLLAR + stdlibParseCache (src/ir.js, src/wat/assemble.js — swap in a
// fresh Map, not `.clear()`, since the old backing table is itself an arena
// allocation), the program-facts WeakMaps (src/compile/{analyze,analyze-scans,
// program-facts}.js — same fresh-instance-not-clear fix), the runtime __dyn_props /
// __dyn_get_cache_off / __dyn_get_cache_props globals (module/core.js __clear, reset
// alongside __heap), NULL_IR's missing `.slice()` before `typed()` (src/ir.js —
// mutating the shared template in place left a dangling props sidecar), and
// subscript's comment-list cache (external fix, feature/comment.js — rebuilds once
// per top-level parse() instead of once ever). compile-clear-compile-clear-compile:
// three rounds catch a fix that only survives ONE `_clear` (e.g. a reset that clears
// state but not a downstream 1-slot cache pointing at it).
test('selfhost: warm-instance reuse — compile, _clear(), compile again, byte-parity vs fresh', () => {
  const src = 'export let main = () => { let s = 0; for (let i = 0; i < 10; i++) s += i * i; return s }'
  const level = '0'
  const fresh = () => {
    const inst = instantiate(readFileSync(SELF), { memory: 8192 })
    const out = inst.exports.default(inst.memory.String(src), 0, inst.memory.String(level))
    const bin = inst.memory.read(out)
    return bin instanceof Uint8Array ? bin : new Uint8Array(bin)
  }
  const baseline = fresh()
  ok(baseline.length > 8, 'fresh-instance baseline compiled')

  const warm = instantiate(readFileSync(SELF), { memory: 8192 })
  for (let round = 0; round < 3; round++) {
    const out = warm.exports.default(warm.memory.String(src), 0, warm.memory.String(level))
    const bin = warm.memory.read(out)
    const bytes = bin instanceof Uint8Array ? bin : new Uint8Array(bin)
    is(bytes.length, baseline.length, `round ${round}: byte length matches fresh instance`)
    ok(bytes.every((b, i) => b === baseline[i]), `round ${round}: byte-identical to fresh instance`)
    warm.instance.exports._clear()
  }
})
