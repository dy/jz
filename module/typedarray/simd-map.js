/**
 * SIMD auto-vectorization for TypedArray.prototype.map(): pattern detection
 * over the callback AST (analyzeSimd) plus v128 + scalar-remainder codegen
 * (genSimdMap), for the recognized scalar-op families (mul/add/sub/div/neg/
 * abs/sqrt/ceil/floor) on Int32/Uint32/Float32/Float64 elements, plus
 * bitwise (&|^<<>>>>>) on Int32/Uint32 elements only — a float element's
 * ECMAScript ToInt32 has no SIMD-lane form, so genSimdMap declines the fast
 * path for that combination (see its comment) rather than mis-lower it.
 *
 * Pure move out of module/typedarray.js (stdlib-generators minimality pass):
 * `.typed:map`'s one call site there now imports analyzeSimd/genSimdMap from
 * here instead of defining them inline — same call, same arguments, same
 * emitted WAT. See .work/stdlib-generators.md for the extraction boundary
 * and the byte-identity verification method.
 *
 * Imports STRIDE/SHIFT/LOAD/STORE from the `./elem-tables.js` sibling (not
 * from `../typedarray.js`, which imports analyzeSimd/genSimdMap FROM this
 * file) — typedarray.js's own resolveModuleGraph (self-compile) rejects
 * circular module imports, so this stays a one-directional leaf-module
 * chain: elem-tables.js ← simd-map.js ← typedarray.js.
 *
 * @module typedarray/simd-map
 */

import { PTR } from '../../src/ctx.js'
import { STRIDE, SHIFT, LOAD, STORE } from './elem-tables.js'

// SIMD: vector width per element type (elements per v128)
const VEC_WIDTH = [16, 16, 8, 8, 4, 4, 4, 2] // 128 bits / element bits

// Bitwise/shift op names analyzeSimd's bitwise branch (below) produces — the JS
// operator → op-name mapping lives there. genSimdMap is the SINGLE gate that
// declines this family for a float element (see its comment); simdOp/scalarOp's
// bitwise arms below rely on that gate and stay i32-only.
const BITWISE_OPS = new Set(['and', 'or', 'xor', 'shl', 'shr', 'shru'])

// Arithmetic op names analyzeSimd's binary branch (below) produces for x*c/
// x+c/x-c/x/c. genSimdMap is the SINGLE gate that declines this family on an
// INTEGER element (elemType 4/5) when `c` is fractional — see genSimdMap's
// comment for why a float element needs no such gate.
const ARITH_OPS = new Set(['mul', 'add', 'sub', 'div'])

// Plain-number ECMAScript ToInt32 — the same fold `src/ir.js`'s `toI32` applies
// to a literal `f64.const` (`Number.isFinite(v) ? v | 0 : 0`, "JS `|0` is
// ToInt32"), mirrored here because this module hand-emits WAT text from bare
// JS numbers, never IR nodes (toI32 itself walks an IR tree — wrong shape for
// a raw AST constant). genSimdMap reuses this ONE function for both bitwise
// value-conversion (and/or/xor: the ELEMENT undergoes ToInt32, so the constant
// combined with it must too) and shift-count conversion (shl/shr/shru: JS
// masks the count via ToUint32(c)&31) — WASM's shl/shr_s/shr_u instructions,
// scalar AND i32x4 lane-wise alike, already reduce ANY i32 shift-count operand
// modulo 32 at the instruction-semantics level (Core Spec "Numerics — Shifts":
// k = i2 mod N), and ToInt32(c)'s bit pattern shares the same low 5 bits as
// ToUint32(c)'s — so one conversion correctly serves both families; no
// per-operator special case.
const toI32Const = c => Number.isFinite(c) ? c | 0 : 0


// === SIMD pattern detection ===

/** Check if AST node is a constant number; `false` means "not a constant".
 *  This function's other returns are plain JS numbers (`typeof node ===
 *  'number'`) — a mixed NUMBER|BOOL return join, checked via `!== false` at
 *  the call sites below. This is sound only because a statically-BOOL return
 *  tail in any >=2-return, non-uniform-BOOL function gets boxed into a real
 *  f64 atom at every escape site — src/compile/emit.js's 'return' handler and
 *  src/compile/index.js emitFunc's ctx.func.mixedAtomReturn cover this
 *  generally, not just the historical special cases (closures, a
 *  provably-uniform-BOOL return). Without that general boxing, `false` here
 *  would silently cross as the plain float 0, indistinguishable from a
 *  genuine constant `0` at `!== false`. */
const isConst = node => {
  if (typeof node === 'number') return node
  if (Array.isArray(node) && node[0] == null && typeof node[1] === 'number') return node[1]
  return false
}

/**
 * Analyze callback body for SIMD-vectorizable patterns.
 * Returns { op, val } or null.
 *
 * Deliberately element-kind-agnostic — this matches the bitwise family
 * against ANY element type, float included. genSimdMap (the only caller,
 * which alone knows the elemType) is the SINGLE place that decides which
 * (op, elemType) combinations the fast path actually supports; don't add
 * an elemType check here too — see genSimdMap's comment for why.
 */
function analyzeSimd(body, param) {
  if (!Array.isArray(body)) return null
  const [op, ...args] = body

  // Binary: x*c, x+c, x-c, x/c (and commutative)
  if (['+', '-', '*', '/'].includes(op) && args.length === 2) {
    const [a, b] = args
    const isA = a === param, isB = b === param
    const cA = !isA && isConst(a), cB = !isB && isConst(b)
    if (op === '*' && ((isA && cB !== false) || (isB && cA !== false)))
      return { op: 'mul', val: isA ? cB : cA }
    if (op === '+' && ((isA && cB !== false) || (isB && cA !== false)))
      return { op: 'add', val: isA ? cB : cA }
    if (op === '-' && isA && cB !== false) return { op: 'sub', val: cB }
    if (op === '/' && isA && cB !== false) return { op: 'div', val: cB }
  }

  // Bitwise: x&c, x|c, x^c, x<<c, x>>c, x>>>c
  if (['&', '|', '^', '<<', '>>', '>>>'].includes(op) && args.length === 2) {
    const [a, b] = args
    if (a === param && isConst(b) !== false) {
      const ops = { '&': 'and', '|': 'or', '^': 'xor', '<<': 'shl', '>>': 'shr', '>>>': 'shru' }
      return { op: ops[op], val: isConst(b) }
    }
  }

  // Unary minus: ['u-', param]
  if (op === 'u-' && args[0] === param) return { op: 'neg' }

  // Math.abs/sqrt/ceil/floor
  if (op === '()' && typeof args[0] === 'string' && args[0].startsWith('math.')) {
    const method = args[0].slice(5)
    const fnArg = args[1]
    if (fnArg === param && ['abs', 'sqrt', 'ceil', 'floor'].includes(method))
      return { op: method }
  }

  return null
}


// === SIMD + scalar WAT codegen (parameterized by type prefix) ===

/** Generate SIMD v128 op. p=prefix (f64x2/f32x4/i32x4), t=const type (f64/f32/i32). */
const simdOp = (p, t) => (op, c) => {
  const s = `(${p}.splat (${t}.const ${c}))`
  const ops = {
    mul: `${p}.mul (local.get $v) ${s}`, add: `${p}.add (local.get $v) ${s}`,
    sub: `${p}.sub (local.get $v) ${s}`, div: `${p}.div (local.get $v) ${s}`,
    neg: `${p}.neg (local.get $v)`, abs: `${p}.abs (local.get $v)`,
    sqrt: `${p}.sqrt (local.get $v)`, ceil: `${p}.ceil (local.get $v)`, floor: `${p}.floor (local.get $v)`,
    // i32-only: genSimdMap declines a float element for this op family before
    // ever calling simdF64/simdF32 (see its comment) — `p`/`t` here are
    // always the i32x4/i32 prefix whenever `op` is one of these.
    and: `v128.and (local.get $v) (i32x4.splat (i32.const ${c}))`,
    or: `v128.or (local.get $v) (i32x4.splat (i32.const ${c}))`,
    xor: `v128.xor (local.get $v) (i32x4.splat (i32.const ${c}))`,
    shl: `i32x4.shl (local.get $v) (i32.const ${c})`, shr: `i32x4.shr_s (local.get $v) (i32.const ${c})`,
    shru: `i32x4.shr_u (local.get $v) (i32.const ${c})`,
  }
  return ops[op] ? `(local.set $v (${ops[op]}))` : null
}

/** Generate scalar remainder op. t=type prefix (f64/f32/i32), v=local name. */
const scalarOp = (t, v) => (op, c) => {
  const g = `(local.get $${v})`
  const ops = {
    mul: `(${t}.mul ${g} (${t}.const ${c}))`, add: `(${t}.add ${g} (${t}.const ${c}))`,
    sub: `(${t}.sub ${g} (${t}.const ${c}))`, div: `(${t}.div ${g} (${t}.const ${c}))`,
    neg: t === 'i32' ? `(i32.sub (i32.const 0) ${g})` : `(${t}.neg ${g})`,
    abs: t === 'i32' ? `(select (i32.sub (i32.const 0) ${g}) ${g} (i32.lt_s ${g} (i32.const 0)))` : `(${t}.abs ${g})`,
    sqrt: `(${t}.sqrt ${g})`, ceil: `(${t}.ceil ${g})`, floor: `(${t}.floor ${g})`,
    // i32-only: genSimdMap declines a float element for this op family before
    // ever calling scalarF64/scalarF32 (see its comment) — `t`/`g` here are
    // always the i32 local whenever `op` is one of these.
    and: `(i32.and ${g} (i32.const ${c}))`, or: `(i32.or ${g} (i32.const ${c}))`,
    xor: `(i32.xor ${g} (i32.const ${c}))`, shl: `(i32.shl ${g} (i32.const ${c}))`,
    shr: `(i32.shr_s ${g} (i32.const ${c}))`, shru: `(i32.shr_u ${g} (i32.const ${c}))`,
  }
  return ops[op]
}

const simdF64 = simdOp('f64x2', 'f64'), simdF32 = simdOp('f32x4', 'f32'), simdI32 = simdOp('i32x4', 'i32')
const scalarF64 = scalarOp('f64', 'e'), scalarF32 = scalarOp('f32', 'ef'), scalarI32 = scalarOp('i32', 'ei')


/**
 * Generate a SIMD map function as WAT string.
 * Takes (src: f64) → f64, returns new typed array with transform applied.
 */
function genSimdMap(name, elemType, pattern) {
  const { op, val } = pattern
  let c = val

  // Bitwise/shift family (&|^<<>>>>>) needs ECMAScript ToInt32 applied to the
  // element VALUE first — `x & 1` on a Float32Array element 1.5 is 1, not a
  // raw-bit reinterpret. For Int32/Uint32 elements the stored i32 bits already
  // ARE that ToInt32'd value, so the fast path below applies the op directly.
  // For a Float32Array/Float64Array element there is no vectorized ToInt32:
  // WASM SIMD's only float→int lanes (i32x4.trunc_sat_f32x4_*/
  // f64x2_*_zero) SATURATE out-of-range magnitudes instead of wrapping mod
  // 2^32 like ToInt32 does (e.g. ToInt32(3e9) must wrap to a specific
  // negative i32, not clamp to INT32_MAX), so no SIMD instruction sequence
  // reproduces it lane-wise — and the scalar tail's `i32.and`-family ops need
  // an actual i32 operand, not an f32/f64 local's raw bits (mixing them is
  // invalid WAT, not merely wrong — the bug this comment now prevents).
  // Decline the fast path here — the SAME `return null` the i8/i16/u8/u16
  // branch below already uses — so the caller (module/typedarray.js's
  // `.typed:map`) falls through to the generic per-element map lowering,
  // which already threads every bitwise op through the real ToInt32
  // (src/ir.js toI32, via emit.js's `&|^<<>>>>>` handlers) and stores the
  // result back through elemStoreIR's f32.demote_f64/f64.store — the ONE
  // existing authority for float-element bitwise; not reimplemented here.
  // This is genSimdMap's single element-kind gate for the family — analyzeSimd
  // deliberately stays element-kind-agnostic (see its own comment) so the
  // decision lives in exactly one place.
  if ((elemType === 6 || elemType === 7) && BITWISE_OPS.has(op)) return null

  // Arithmetic (mul/add/sub/div) on an INTEGER element (Int32Array/Uint32Array)
  // with a fractional `c`: JS computes `x OP c` in f64 (the loaded int32 value
  // promoted to double) and applies ToInt32/ToUint32 only ONCE, when STORING
  // the mapped value back — e.g. `x * 1.5` on an Int32Array element x=3 is
  // f64(3)*1.5=4.5, ToInt32(4.5)=4, NOT 3 (rounding/truncating the constant to
  // `x*1` first would silently compute the wrong answer, not merely reject).
  // An integer-valued `c` needs no such guard: exact-integer f64 arithmetic and
  // i32 wrapping arithmetic agree bit-for-bit (the same ring narrowI32 already
  // relies on, src/ir.js), so the fast path stays safe and fires as before.
  // Declined via the SAME `return null` idiom as the float×bitwise gate above,
  // so the caller falls through to the SAME generic per-element lowering
  // (module/typedarray.js), which computes in f64 and stores through
  // elemStoreIR's real ToInt32/ToUint32 conversion — not reimplemented here.
  // This is genSimdMap's single constant-shape gate for the family; analyzeSimd
  // deliberately stays element-kind-agnostic (see its own comment) AND never
  // inspects `c`'s value beyond "is it a number" — so, like the float×bitwise
  // decision, this one lives in exactly one place too.
  if ((elemType === 4 || elemType === 5) && ARITH_OPS.has(op) && !Number.isInteger(c))
    return null

  // A surviving bitwise/shift constant is embedded VERBATIM into `i32.const`/
  // `i32x4.splat (i32.const …)` below (simdI32/scalarI32) — normalize it to
  // ToInt32 first via toI32Const (see its comment above). Left as-is, the raw
  // JS AST literal (`1.5`, `-1.5`, `Infinity`, `2147483648.7`, …) isn't even
  // valid WAT integer syntax, so an unnormalized fractional/non-finite `c` is
  // not merely a wrong-value bug but a compile failure ("Bad int 1.5") — a
  // spurious REJECT of valid JS (`x & 1.5` ≡ `x & 1` per ECMAScript ToInt32).
  if (BITWISE_OPS.has(op)) c = toI32Const(c)

  const stride = STRIDE[elemType]
  const shift = SHIFT[elemType]
  const load = LOAD[elemType], store = STORE[elemType]
  const vw = VEC_WIDTH[elemType]
  const vBytes = vw * stride // always 16 (128 bits)

  // Choose SIMD + scalar codegen by element family
  let simdOp, scalarOp, scalarLocal, scalarLoad, scalarStore
  if (elemType === 7) { // Float64Array
    simdOp = simdF64(op, c); scalarOp = scalarF64(op, c)
    scalarLocal = '(local $e f64)'; scalarLoad = 'f64.load'; scalarStore = 'f64.store'
  } else if (elemType === 6) { // Float32Array
    simdOp = simdF32(op, c); scalarOp = scalarF32(op, c)
    scalarLocal = '(local $ef f32)'; scalarLoad = 'f32.load'; scalarStore = 'f32.store'
  } else if (elemType >= 4) { // Int32Array/Uint32Array
    simdOp = simdI32(op, c); scalarOp = scalarI32(op, c)
    scalarLocal = '(local $ei i32)'; scalarLoad = 'i32.load'; scalarStore = 'i32.store'
  } else return null // i8/i16/u8/u16 — no SIMD path (would need i8x16/i16x8)

  if (!simdOp || !scalarOp) return null

  // Scalar remainder: load element into local, then store transform result
  const byteOff = `(i32.add (local.get $srcOff) (i32.shl (local.get $i) (i32.const ${shift})))`
  const dstByteOff = `(i32.add (local.get $dstOff) (i32.shl (local.get $i) (i32.const ${shift})))`
  const scalarLoadSet = elemType === 7 ? `(local.set $e (${scalarLoad} ${byteOff}))`
    : elemType === 6 ? `(local.set $ef (${scalarLoad} ${byteOff}))`
    : `(local.set $ei (${scalarLoad} ${byteOff}))`
  const scalarStoreExpr = `${scalarLoadSet}\n      (${store} ${dstByteOff} ${scalarOp})`

  return `(func $${name} (param $src i64) (result f64)
    (local $len i32) (local $srcOff i32) (local $dstOff i32)
    (local $i i32) (local $simdLen i32) (local $byteOff i32)
    (local $v v128)
    ${scalarLocal}
    (local.set $len (call $__len (local.get $src)))
    (local.set $srcOff (call $__typed_data (local.get $src)))
    ;; Alloc result typed array via the canonical header allocator (NOT a
    ;; hand-rolled (i32.const 8)+byteLen alloc) — TYPED is in
    ;; __dyn_get_t_h's propsPtr-sidecar set (module/collection.js:
    ;; hasPropsSidecarWat), so a genuine .map() result needs the same
    ;; 16-byte [propsPtr@-16,len@-8,cap@-4] header every other ARRAY/
    ;; OBJECT/TYPED/SET/MAP allocation gets, or that word aliases whatever
    ;; memory preceded this allocation (FOURTH mechanism class,
    ;; .work/research.md §Region arena). __typed_slice_rt (below) already
    ;; establishes the canonical shape for TYPED results: stride=1 (raw
    ;; bytes), len=cap=byteLen — mirrored here exactly.
    (local.set $dstOff (call $__alloc_hdr_n (i32.shl (local.get $len) (i32.const ${shift})) (i32.shl (local.get $len) (i32.const ${shift})) (i32.const 1)))
    ;; SIMD loop: process ${vw} elements at a time
    (local.set $simdLen (i32.and (local.get $len) (i32.const ${~(vw - 1)})))
    (local.set $i (i32.const 0))
    (block $sdone (loop $sloop
      (br_if $sdone (i32.ge_u (local.get $i) (local.get $simdLen)))
      (local.set $byteOff (i32.shl (local.get $i) (i32.const ${shift})))
      (local.set $v (v128.load (i32.add (local.get $srcOff) (local.get $byteOff))))
      ${simdOp}
      (v128.store (i32.add (local.get $dstOff) (local.get $byteOff)) (local.get $v))
      (local.set $i (i32.add (local.get $i) (i32.const ${vw})))
      (br $sloop)))
    ;; Scalar remainder
    (block $rdone (loop $rloop
      (br_if $rdone (i32.ge_u (local.get $i) (local.get $len)))
      ${scalarStoreExpr}
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $rloop)))
    (call $__mkptr (i32.const ${PTR.TYPED}) (i32.const ${elemType}) (local.get $dstOff)))`
}

export { analyzeSimd, genSimdMap }
