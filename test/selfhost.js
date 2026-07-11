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
  // OPCODE-dict miscompile (2026-07): watr's packData (data-segment zero-run trim/merge/
  // split, watr/src/optimize.js) corrupted jz's internStrings-encoded static data
  // (src/compile/index.js buildInternTable: an 8-byte [hash u32][len u32] header + a
  // sparse open-addressing intern-probe table, both zero-run-dense) — ONLY at self-host
  // scale (native jz building dist/jz.wasm from the full self.js graph; a wrapped or
  // reduced graph doesn't reproduce it). Surfaced as watr's OWN embedded instr() throwing
  // "Unknown instruction f64.nearest" when the kernel compiled a program whose Math.exp/
  // sin/cos/tan/pow/expm1/sinh lowering pulls in a WAT-TEXT stdlib template (module/
  // math.js, parsed by watr's parser at KERNEL RUNTIME) containing that opcode name —
  // never on Math.round's f64.nearest (a plain JS array-literal AST node, a different
  // construction path const.js's OPCODE dict has no trouble matching). Bisected via
  // optimize's object-config form on the exact self.js entry: {level:1, watr:true} and
  // {level:2, watr:false} both compile the kernel correctly; watr + internStrings
  // TOGETHER are required, and disabling watr's packData pass alone (its ~20 other
  // passes + internStrings stay on) fixes it. Fixed in scripts/selfhost-build.mjs
  // (optimize: {level, watr:{packData:false}}) — jz's own build orchestration choosing a
  // watr config safe for self-compile, not a source workaround (watr is de-forked; jz
  // doesn't patch it). math-exp/math-expm1 above already cover this path; sin/cos/pow
  // add coverage for Math functions no other selfhost.js sample reaches.
  ['math-sin',    'export let main = () => (Math.abs(Math.sin(1.2) - 0.9320390859672263) < 1e-6) | 0', 1],
  ['math-cos',    'export let main = () => (Math.abs(Math.cos(1.2) - 0.3623577544766736) < 1e-6) | 0', 1],
  ['math-pow',    'export let main = () => (Math.abs(Math.pow(2.5, 3.7) - 29.67413253642086) < 1e-6) | 0', 1],
  // Typed-array element WRITE with a literal RHS ('samples[j] > 0'-shaped repro,
  // .work/selfhost-perf-groundtruth.md): jzify's isDestructurePat (jzify/hoist-vars.js)
  // misclassified `arr[i] = v` as a destructuring-assignment pattern — both share the
  // '[]' tag pre-prepare(), disambiguated only by arity (pattern length ≤2, element
  // access always length 3). Native jzify reconstructs byte-identical IR either way for
  // this shape (masking it); the kernel's compiled pattern-walk path throws "expected
  // emitted IR value … got empty value" (src/ir.js asF64) instead. See test/parser-bugs.js.
  ['typed-elem-write-literal', 'export let main = () => { const s = new Float64Array(5); s[0] = 3; return s[0] === 3 ? 1 : 0 }', 1],
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
  // charCodeAt-on-param is load-bearing: it pulls the abi/string.js param
  // decomposition, whose module-level ssoBitI64 memo used to dangle across
  // _clear (warm round 2 emitted `(i64.const <garbage bytes>)` → watr
  // "Bad int" — the tokenizer warm-trap). The memo is gone; this pins it.
  const src = 'export let main = (s) => { let h = 0; for (let i = 0; i < 10; i++) h += i * i + s.charCodeAt(0); return h }'
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

// Warm-instance reuse WITHOUT any `_clear()` — the bump arena grows monotonically
// across every compile, exactly the condition under which narrow.js's pointer-ABI
// fixes (applyPointerParamAbi's missing ptrAux, passthroughPtrParam's recursive
// delegation — both in this same test/selfhost.js file's neighbor tests natively,
// see test/objects.js's "devirt schema-slot" tests for the host-level pin) used to
// leave a Map/Object receiver whose real schema the static analysis can't see
// (bindAssignSchema poisons the binding on disagreeing assignments) routing
// through ctx.schema.guardedSlotOf's speculative devirtualization with a wrong or
// missing schema aux. The corruption doesn't surface on round 1 — the guard's
// dyn-props fallback and the header allocator both write real, valid memory each
// time, just occasionally at a wrong offset, and it takes dozens of accumulated
// compiles (never rewound, unlike the _clear test above) for the drift to walk
// off the end of a page and trap "memory access out of bounds" instead of
// silently misreading. Two field-name shapes (both single-letter-adjacent to
// jz's own AST op tags, and a common short property name) at 30 rounds each was
// the smallest N that reproduced that bug reliably.
//
// Bumped 30→40 rounds/program to also cover a FOURTH, independent bug this same
// stress shape (repeated Map/HASH-growth allocation, no _clear) surfaces once the
// bump arena's absolute byte address crosses ~2 GiB and later needs the wasm32
// memory to grow to its full 65536-page (4 GiB) ceiling: layout.js's
// followForwardingWat/ptrOffsetFwdWat (the ARRAY/SET/MAP/HASH relocation-forwarding
// chase every dyn-prop/collection dereference runs through) bounded a pointer
// offset against `i32.shl(memory.size, 16)` — which overflows to exactly 0 the one
// time memory.size() reaches 65536 (65536*65536 == 2^32, unrepresentable in i32).
// That silently disabled the forward-chase for the rest of execution: a stale
// reference to an already-relocated collection stopped following its forwarding
// header and read the abandoned block's cap=-1 sentinel as a real capacity,
// producing wild table-probe writes ("memory access out of bounds" inside
// __alloc_hdr_n, or an unbounded probe loop, depending on layout — the exact
// shape that landed at a given round was highly layout-sensitive, but the trigger
// — sustained dyn-props allocation pressure with no reset — was not). Fixed by
// comparing in i64 against a cached $__heap_end64 global (module/core.js,
// layout.js) instead of the overflowing i32 shift. 40 rounds/program comfortably
// exceeds every round this bug was observed to fire at across multiple builds
// (22-52, layout-dependent) without running long enough to reach the genuine
// 4 GiB ceiling itself (~100+ rounds, where an honest `unreachable` OOM trap is
// the correct outcome, not a bug). Keep at or above 40 rather than shrinking it
// back down to "looks clean in a quick run".
test('selfhost: warm-instance reuse with NO _clear — repeated Map+prop-access compiles stay clean', () => {
  getSelf()
  const warm = instantiate(readFileSync(SELF), { memory: 8192 })
  const PROGRAMS = [
    "export let go = () => { const m = new Map(); m.set('a', { zzqqxxdiagfield: true }); const g = m.get('a'); return g.zzqqxxdiagfield ? 1 : 0 }",
    "export let go = () => { const m = new Map(); m.set('a', { mut: true }); const g = m.get('a'); return g.mut ? 1 : 0 }",
  ]
  for (const src of PROGRAMS) {
    for (let round = 0; round < 40; round++) {
      const out = warm.exports.default(warm.memory.String(src), 0, warm.memory.String('2'))
      const bin = warm.memory.read(out)
      const bytes = bin instanceof Uint8Array ? bin : new Uint8Array(bin)
      ok(bytes.length > 8, `round ${round}: compiled wasm bytes (no allocator trap)`)
      is(instantiate(bytes, { memory: 64 }).exports.go(), 1, `round ${round}: g's own field reads back true`)
    }
  }
})
