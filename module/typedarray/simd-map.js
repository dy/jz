/**
 * SIMD auto-vectorization for TypedArray.prototype.map(): pattern detection
 * over the callback AST (analyzeSimd) plus v128 + scalar-remainder codegen
 * (genSimdMap), for the recognized ops (mul/add/sub/div, bitwise
 * &|^<<>>>>>, neg, Math.abs/sqrt/ceil/floor) on Int32/Uint32/Float32/
 * Float64 elements. Not every (op, element kind) pair has an exact WASM
 * lane form — no integer SIMD/scalar div instruction exists, sqrt/ceil/
 * floor are float-only, signed abs disagrees with an unsigned element, and
 * ECMAScript ToInt32 on a float element has no vectorized form at all —
 * genSimdMap's SIMD_MAP_VALID_KINDS table is the SINGLE authority on which
 * pairs it lowers; every other pair declines the fast path (see genSimdMap's
 * comment) rather than mis-lower it.
 *
 * Pure move out of module/typedarray.js (stdlib-generators minimality pass):
 * `.typed:map`'s one call site there now imports analyzeSimd/genSimdMap from
 * here instead of defining them inline — same call, same arguments, same
 * emitted WAT. See .work/archive/stdlib-generators.md for the extraction boundary
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
// operator → op-name mapping lives there. Used below only to ToInt32-normalize
// a surviving constant; SIMD_MAP_VALID_KINDS (consulted by genSimdMap) is the
// single authority on which element kinds this family actually reaches, so
// simdOp/scalarOp's bitwise arms can stay i32-only unconditionally.
const BITWISE_OPS = new Set(['and', 'or', 'xor', 'shl', 'shr', 'shru'])

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


// === SIMD op-validity table — genSimdMap's SINGLE authority ===
//
// Which (op, elemType) pairs the codegen above can lower to an instruction
// that computes the exact ECMAScript value, for EVERY input — not just the
// ones a hand-picked test happened to try. elemType: 4=Int32Array,
// 5=Uint32Array, 6=Float32Array, 7=Float64Array (elem-tables.js's index
// order; 0-3 — i8/u8/i16/u16 — never reach here, already declined below by
// the element-family dispatch: no i8x16/i16x8 lane path exists for
// `.typed:map`).
//
// A pair absent from its op's Set has no instruction sequence that
// reproduces the ECMAScript value — genSimdMap declines to the generic
// per-element lowering (module/typedarray.js), which computes in f64/f32
// and stores through elemStoreIR's real ToInt32/ToUint32/f32-demote
// conversion; not reimplemented here. Never emit an instruction that
// doesn't exist (WASM SIMD has no integer lane div/sqrt/ceil/floor —
// "Unknown instruction i32x4.div" is a compile-time crash, not a decline)
// and never emit one whose semantics silently disagree with ECMAScript's
// (signed i32x4/i32 abs on an UNSIGNED Uint32Array element: the correct op
// is identity, not "negate when the sign bit is set" — a wrong VALUE, not
// an invalid module, but the same unvalidated-pair shape).
const F = new Set([6, 7]) // float kinds: Float32Array, Float64Array
const I = new Set([4, 5]) // integer kinds: Int32Array, Uint32Array
const ALL = new Set([4, 5, 6, 7])

const SIMD_MAP_VALID_KINDS = {
  // mul/add/sub: f64(x) OP f64(c) stored via ToInt32/ToUint32. Exact-integer
  // f64 arithmetic agrees bit-for-bit with i32 wrapping arithmetic (the same
  // ring narrowI32 relies on, src/ir.js) — PROVIDED c itself is an integer,
  // checked below BY VALUE (an integer ELEMENT with a FRACTIONAL c still
  // needs the once-only ToInt32 the generic path applies: `x*1.5` on
  // Int32Array x=3 is ToInt32(4.5)=4, not 3 — rounding the constant first
  // would silently compute the wrong answer, not merely reject). div has NO
  // integer lane form at ANY constant: WASM SIMD defines no i32x4.div (nor a
  // scalar i32.div), and even a hypothetical i32.div_s/u would trap on /0
  // and on INT32_MIN/-1 where ECMAScript's float-divide-then-ToInt32 just
  // returns 0 or wraps — no constant shape rescues it.
  mul: ALL, add: ALL, sub: ALL, div: F,

  // Bitwise/shift: ECMAScript ToInt32 on a FLOAT element's value has no
  // vectorized form (WASM SIMD's only float→int lanes — i32x4.trunc_sat_*/
  // f64x2_*_zero — SATURATE out-of-range magnitudes instead of wrapping mod
  // 2^32 like ToInt32 does) — integer-only. A surviving constant is
  // ToInt32-normalized below (toI32Const), independent of this table.
  and: I, or: I, xor: I, shl: I, shr: I, shru: I,

  // Two's-complement wraparound negation IS modular arithmetic mod 2^32 —
  // bit-identical to ToInt32(-x)/ToUint32(-x) for every x, signed or
  // unsigned interpretation alike (negation, unlike abs below, doesn't
  // depend on which values count as "negative"). IEEE754 negate is an exact
  // sign-bit flip. Valid everywhere.
  neg: ALL,

  // Math.abs: signed lane abs (i32x4.abs / select+negate-if-negative)
  // matches Math.abs on a genuinely SIGNED int32 value (Int32Array). On a
  // Uint32Array the stored bits are the same, but the JS VALUE is already
  // non-negative by construction — Math.abs is the identity there, not
  // "negate when the top bit is set"; the signed-abs lane op computes the
  // wrong value (e.g. element 4294967295 misreports as 1) — Uint32Array
  // excluded. Float abs is a direct, exact sign-bit clear either width.
  abs: new Set([4, 6, 7]),

  // sqrt/ceil/floor: no integer lane form exists (no i32x4.sqrt/ceil/floor,
  // nor scalar i32.sqrt/ceil/floor — float-only WASM instructions).
  // ECMAScript computes in double and applies ToInt32/ToUint32 once, on
  // store — exactly what the generic per-element lowering already does.
  sqrt: F, ceil: F, floor: F,
}

// Within the arithmetic family, an INTEGER element additionally needs an
// integer-valued constant (SIMD_MAP_VALID_KINDS.mul's comment above) — div
// is already absent from I entirely, so no constant shape admits it back in.
const NEEDS_INT_CONST_ON_INT_ELEM = new Set(['mul', 'add', 'sub'])


/**
 * Generate a SIMD map function as WAT string.
 * Takes (src: f64) → f64, returns new typed array with transform applied.
 */
function genSimdMap(name, elemType, pattern) {
  const { op, val } = pattern
  let c = val

  // Single authority: does this (op, elemType) pair have an exact WASM lane
  // form? See SIMD_MAP_VALID_KINDS above — analyzeSimd deliberately stays
  // element-kind-agnostic (its own comment), so this is the ONE place the
  // decision lives. Absence falls through to the caller's (module/
  // typedarray.js's `.typed:map`) generic per-element lowering.
  if (!SIMD_MAP_VALID_KINDS[op]?.has(elemType)) return null

  // Arithmetic on an integer element additionally needs an integer-valued
  // constant, checked by VALUE (not just kind) — see SIMD_MAP_VALID_KINDS
  // .mul's comment. analyzeSimd never inspects `c` beyond "is it a number",
  // so this stays genSimdMap's decision alone, same as the table above.
  if (I.has(elemType) && NEEDS_INT_CONST_ON_INT_ELEM.has(op) && !Number.isInteger(c))
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
    ;; .work/evidence.md §Region arena). __typed_slice_rt (below) already
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
