// Deopt battery — the "unreasonable" deopts: idiomatic source that jz narrows
// wrongly, paying the dynamic-dispatch tax despite carrying enough type evidence.
//
// Each case was found by firing realistic source "missiles" at the compiler and
// reading the WAT fingerprint (see .work/battery.mjs, .work/FINDINGS.md). The
// pinning discipline mirrors perf-ratchet.js / forin-deopt.js: a correctness
// `diff()` guards every case (never defend a miscompile), and each codegen pin
// is a regression backstop that locks in the fix.
//
// The three deopt classes fixed here (full root-cause + fix in .work/FINDINGS.md):
//
//   D1 — built-in numeric properties (.length/.byteLength/.byteOffset/.size) in `+`.
//        FIXED: propValType trait table (kind-traits.js) types these as NUMBER on
//        their sized kinds, so `+` skips the string-concat dispatch.
//
//   D2 — jagged `grid[i][j]` re-resolves `grid[i]` per inner iteration.
//        FIXED: three LICM extensions — if-arm purity, hasDirectStore effect flag,
//        and read-only heap-memory calls (__typed_idx/__str_idx) as hoistable.
//
//   D3 — `arr[<const idx>]()` stays call_indirect (devirt miss).
//        PINNED: devirtIndirect doesn't constant-fold the array-element load.
//
// Confirmed-reasonable cases (the "untyped stays dynamic" contract, NOT deopts)
// are documented in .work/FINDINGS.md so future fuzzing doesn't re-flag them.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, onWasi } from './_matrix.js'
import jz, { compile } from '../index.js'

const count = (s, re) => { const m = s.match(re); return m ? m.length : 0 }

// Run `src` as jz-wasm and as JS, assert equal. `src` exports `run`, which takes
// a parameter (a no-arg export is the reserved void entry under WASI).
function diff(src, arg = 0, label) {
  const jsRun = new Function(`${src.replace(/export\s+let\s+run\s*=/, 'let run =')}\nreturn run`)()
  const { exports } = jz(src)
  const want = jsRun(arg), got = exports.run(arg)
  is(got, want, (label || src.replace(/\s+/g, ' ').trim().slice(0, 72)))
  return got
}

// ════════════════════════════════════════════════════════════════════════════
// D1 — built-in numeric properties (.length/.byteLength/.byteOffset/.size) in `+`
// ════════════════════════════════════════════════════════════════════════════
//
// FIXED: the `propValType` trait table (kind-traits.js, mirroring `methodValType`)
// types built-in numeric properties as VAL.NUMBER on their respective sized kinds.
// `+` sees a known-NUMBER operand and skips the __is_str_key string-concat dispatch.
// Previously `.length + x` emitted __is_str_key×2 + __str_concat even though `.length`
// can never be a string on a typed array/plain array/string.
//
// Soundness: object schema slots (ctx.schema.slotVT) run earlier in VT['.'] and
// override this — `{length:'hi'}.length` keeps its true slot type. Untyped receivers
// stay null (could be an object with a string-valued shadow).

test('deopt D1: built-in numeric property + stays correct (diff vs JS)', () => {
  diff('export let run=(x)=>{let b=new Float64Array(x);let s=0;for(let i=0;i<b.length;i++)s+=b[i]+b.length;return s}', 12)
})

test('deopt D1: .length in + narrows to number (no string-concat dispatch)', () => {
  if (belowOpt(1)) return
  const wat = compile('export let f=(x)=>{let b=new Float64Array(x);let s=0;for(let i=0;i<b.length;i++)s+=b[i]+b.length;return s}', { wat: true })
  is(count(wat, /\$__is_str_key/g), 0, '.length is NUMBER on TYPED — + skips __is_str_key')
  is(count(wat, /\$__str_concat/g), 0, 'two numbers — + emits f64.add, not __str_concat')
})

test('deopt D1: all sized kinds narrow — typed/plain/string .length in +', () => {
  if (belowOpt(1)) return
  const typed = compile('export let f=(x)=>{let b=new Float64Array(x);let s=0;for(let i=0;i<b.length;i++)s+=b[i]+b.length;return s}', { wat: true })
  const plain = compile('export let f=(x)=>{let b=[1,2,3,4,5];let s=0;for(let i=0;i<b.length;i++)s+=b[i]+b.length;return s}', { wat: true })
  const str = compile('export let f=(s)=>{let n=0;for(let i=0;i<s.length;i++)n+=s.charCodeAt(i)+s.length;return n}', { wat: true })
  is(count(typed, /\$__str_concat/g), 0, 'typed-array .length + : no concat')
  is(count(plain, /\$__str_concat/g), 0, 'plain-array .length + : no concat')
  is(count(str, /\$__str_concat/g), 0, 'string .length + : no concat')
})

test('deopt D1: sibling numeric props narrow too — .byteLength/.byteOffset/.size', () => {
  // propValType generalizes beyond .length: every built-in numeric property on its
  // sized kind skips the string dispatch. These shared the D1 deopt before the fix.
  if (belowOpt(1)) return
  const bl = compile('export let f=(x)=>{let b=new Float64Array(x);let s=0;for(let i=0;i<b.length;i++)s+=b[i]+b.byteLength;return s}', { wat: true })
  const bo = compile('export let f=(x)=>{let b=new Float64Array(x);let s=0;for(let i=0;i<b.length;i++)s+=b[i]+b.byteOffset;return s}', { wat: true })
  const sz = compile('export let f=()=>{let m=new Map();m.set(1,2);let s=0;for(let i=0;i<10;i++)s+=i+m.size;return s}', { wat: true })
  is(count(bl, /\$__str_concat/g), 0, '.byteLength on TYPED narrows to NUMBER')
  is(count(bo, /\$__str_concat/g), 0, '.byteOffset on TYPED narrows to NUMBER')
  is(count(sz, /\$__str_concat/g), 0, '.size on MAP narrows to NUMBER')
})

test('deopt D1: NEGATIVE — * still narrows (control for the + fix)', () => {
  // * always narrowed .length; the D1 fix brings + to parity. Pin so a future
  // regression in either operator is caught.
  if (belowOpt(1)) return
  const wat = compile('export let f=(x)=>{let b=new Float64Array(x);let s=0;for(let i=0;i<b.length;i++)s+=b[i]*b.length;return s}', { wat: true })
  is(count(wat, /\$__is_str_key/g), 0, '* narrows .length — no string-key dispatch')
  is(count(wat, /\$__str_concat/g), 0, '* narrows .length — no concat fallback')
})

test('deopt D1: SOUNDNESS — object .length slot overrides the built-in type', () => {
  // An object literal with a `.length` slot keeps the slot's type (string here),
  // NOT the built-in NUMBER — schema slotVT runs earlier in VT['.'] and wins.
  // `o.length + o.x` must dispatch via __str_concat because o.length is a string.
  if (belowOpt(1)) return
  const wat = compile('export let f=()=>{let o={length:"hi",x:1};return o.length+o.x}', { wat: true })
  ok(count(wat, /\$__str_concat/g) >= 1, 'object .length slot keeps its string type over the built-in NUMBER')
})

test('deopt D1: SOUNDNESS — untyped receiver .length stays conservative', () => {
  // An untyped param could be an object with a string `.length` shadow, so
  // propValType gates on a known objType — `p.length` on an untyped param stays
  // null (dynamic dispatch), never wrongly typed NUMBER.
  if (belowOpt(1)) return
  const wat = compile('export let f=(p)=>p.length+1', { wat: true })
  ok(count(wat, /\$__str_concat/g) >= 1, 'untyped receiver .length stays dynamic (no unsound narrow)')
})

// ════════════════════════════════════════════════════════════════════════════
// D2 — jagged `grid[i][j]` re-resolves `grid[i]` per inner iteration
// ════════════════════════════════════════════════════════════════════════════
//
// FIXED: three LICM extensions in hoistInvariantLoop (src/optimize/index.js):
//   1. `if`-arm purity — a value-producing `if` whose condition and both arms
//      are pure is itself pure (the tag-dispatch idiom wrapping element reads).
//   2. `hasDirectStore` effect flag — tracks any f64.store/i32.store in the loop.
//   3. Read-only heap-memory calls (__typed_idx/__str_idx) — safe to hoist when
//      no mutating call and no direct store can modify heap memory. Allocation/
//      dispatch-only calls (__str_concat/__is_str_key/__to_num/__to_str) don't
//      modify EXISTING heap memory, so they don't block the hoist.
// Together these let LICM hoist `grid[i]` (a tag-dispatch `if` wrapping
// __typed_idx/__str_idx) out of a read-only `for(j){…grid[i][j]…}` inner loop.
// The pin uses 50×50 bounds to avoid small-loop unrolling masking the effect.

const D2_SRC = (hoist) => `let grid
  export let init=(n)=>{grid=[];for(let i=0;i<n;i++)grid.push(new Float64Array(n));return grid}
  export let read=()=>{let s=0;for(let i=0;i<50;i++){${hoist ? 'let row=grid[i];' : ''}for(let j=0;j<50;j++)s+=${hoist ? 'row[j]' : 'grid[i][j]'}}return s}`

test('deopt D2: jagged grid[i][j] read stays correct (diff vs JS)', () => {
  const js = new Function(D2_SRC(false).replace(/export\s+let\s+(init|read)\s*=/g, 'let $1=') + '\nreturn { init, read }')()
  const { exports } = jz(D2_SRC(false))
  exports.init(50); js.init(50)
  is(exports.read(), js.read(), 'jagged read sum matches JS')
})

test('deopt D2: grid[i] is hoisted out of the inner j-loop (LICM)', () => {
  if (belowOpt(1)) return
  const nohoist = compile(D2_SRC(false), { wat: true })
  const hoist = compile(D2_SRC(true), { wat: true })
  // Before the fix, nohoist emitted MORE __typed_idx than the manual-hoist form
  // because grid[i] was re-resolved per inner iteration. After the fix, the
  // compiler hoists grid[i] itself — both forms emit the same count.
  is(count(nohoist, /\$__typed_idx/g), count(hoist, /\$__typed_idx/g),
    'auto-LICM matches manual hoist — grid[i] no longer re-resolved per inner iter')
})

test('deopt D2: inner j-loop contains no outer-counter $i reference', () => {
  // Machine-independent proof: after LICM, the inner j-loop body must not
  // reference the outer counter $i at all (grid[i] was hoisted to a snap local).
  if (belowOpt(1)) return
  const wat = compile(D2_SRC(false), { wat: true })
  const fi = wat.indexOf('(func $read')
  const seg = wat.slice(fi)
  const loopIdxs = []
  const re = /\(loop/g
  let m
  while ((m = re.exec(seg))) loopIdxs.push(fi + m.index)
  ok(loopIdxs.length >= 2, 'expected nested i/j loops')
  const innerStart = loopIdxs[loopIdxs.length - 1]
  let depth = 0, innerEnd = innerStart
  for (let j = innerStart; j < wat.length; j++) {
    if (wat[j] === '(') depth++
    else if (wat[j] === ')' && --depth === 0) { innerEnd = j; break }
  }
  const inner = wat.slice(innerStart, innerEnd + 1)
  is(count(inner, /local\.get \$i\b/g), 0, 'inner j-loop has no $i reference — grid[i] hoisted')
})

// ════════════════════════════════════════════════════════════════════════════
// D3 — `arr[<const idx>]()` stays call_indirect (devirt miss)
// ════════════════════════════════════════════════════════════════════════════
//
// PINNED (not yet fixed): a constant-index read of an array-literal-of-functions
// (`arr[0]`) produces a value devirtIndirect doesn't recognize as a known function
// ref, so the call stays `call_indirect`. The callee is statically known.
// Fix lever: constant-fold `arr[<i32.const>]` over a literal array of functions to
// the function ref before devirtIndirect runs.

test('deopt D3: arr[0](...) stays correct (diff vs JS)', () => {
  diff('export let run=(a)=>{let add=(x,y)=>x+y;let arr=[add];return arr[0](a,a)}', 3, 'arr[0](a,a)')
})

test('deopt D3: arr[0](...) with constant index stays call_indirect', () => {
  if (belowOpt(1)) return
  const wat = compile('export let f=(a,b)=>{let add=(x,y)=>x+y;let arr=[add];return arr[0](a,b)}', { wat: true })
  // CURRENT: call_indirect=1. GOAL: 0 (folds to a direct call $add).
  ok(count(wat, /call_indirect/g) <= 1, 'call_indirect ceiling (GOAL: 0 — arr[0] is statically add)')
})

test('deopt D3: NEGATIVE — direct call is already clean', () => {
  // Control: the same function called directly (no array indirection) emits a
  // direct call and is tiny. Pin so the D3 ceiling is measured against the
  // achievable floor.
  if (belowOpt(1)) return
  const wat = compile('export let f=(a,b)=>{let add=(x,y)=>x+y;return add(a,b)}', { wat: true })
  is(count(wat, /call_indirect/g), 0, 'direct call has no call_indirect')
})

// ════════════════════════════════════════════════════════════════════════════
// Behavioral pin — D1 fix converges the .length-in-+ and |0-pinned forms
// ════════════════════════════════════════════════════════════════════════════

test('deopt D1: .length-in-+ vs |0-pinned converge after the propValType fix', () => {
  if (onWasi()) return               // the JS memory codec is the js-host path
  if (process.env.JZ_PERF !== '1') return  // informational only by default
  const N = 10000, ITERS = 500
  const plain = jz('export let f=(x)=>{let b=new Float64Array(x);let s=0;for(let i=0;i<b.length;i++)s+=b[i]+b.length;return s}').exports.f
  const pinned = jz('export let f=(x)=>{let b=new Float64Array(x);let s=0;for(let i=0;i<b.length;i++)s+=b[i]+(b.length|0);return s}').exports.f
  const bench = (fn) => { for (let i = 0; i < 50; i++) fn(N); const t = performance.now(); for (let i = 0; i < ITERS; i++) fn(N); return performance.now() - t }
  const plainT = bench(plain), pinnedT = bench(pinned)
  console.log(`  D1 .length-in-+ : ${plainT.toFixed(2)}ms  vs  |0-pinned : ${pinnedT.toFixed(2)}ms  (ratio ${(plainT / pinnedT).toFixed(2)}x — should be ~1.0 after the fix)`)
  ok(plainT < pinnedT * 1.3, 'plain .length-in-+ is within 30% of the |0-pinned form (fix converged them)')
})
