import { OPTF } from '../src/ctx.js'
/**
 * TypedArray module — Float64Array, Float32Array, Int32Array, etc.
 * SIMD auto-vectorization for .map() on recognized patterns.
 *
 * Type=3 (TYPED): aux=elemType (3 bits), length in memory header [-8:len][-4:cap].
 *
 * @module typed
 */

import { typed, asF64, asI32, asI64, toNumF64, coerceNullishToNum, UNDEF_NAN, NULL_NAN, TRUE_NAN, FALSE_NAN, allocPtr, mkPtrIR, ptrOffsetIR, ptrTypeEq, temp, tempI32, tempI64, undefExpr, truthyIR } from '../src/ir.js'
import { isReassigned, T, ASSIGN_OPS } from '../src/ast.js'
import { emit, idx, deps, call } from '../src/bridge.js'
import { strHashLiteral } from './collection.js'
import { valTypeOf } from '../src/kind.js'
import { typedIdxProven, typedElemCtor, idxKey, constIntExpr } from '../src/type.js'
import { VAL, lookupValType } from '../src/reps.js'
import { nanPrefixHex, TYPED_ELEM_NAMES, TYPED_ELEM_CODE, TYPED_ELEM_BIGINT_FLAG, encodeTypedElemAux } from '../layout.js'
import { inc, PTR, LAYOUT, registerGetter } from '../src/ctx.js'

const _NAN_BITS = nanPrefixHex()


const typedAux = (name, isView = false) => encodeTypedElemAux(name, isView)
const STRIDE = [1, 1, 2, 2, 4, 4, 4, 8]
const SHIFT = [0, 0, 1, 1, 2, 2, 2, 3]
const LOAD = [
  'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u',
  'i32.load', 'i32.load', 'f32.load', 'f64.load',
]
const STORE = [
  'i32.store8', 'i32.store8', 'i32.store16', 'i32.store16',
  'i32.store', 'i32.store', 'f32.store', 'f64.store',
]
// f64 value → this element's stored representation (paired with STORE). Signed
// kinds trunc_s, unsigned trunc_u, f32 demotes, f64 stores as-is (null = identity).
const FROM_F64 = [
  'i32.trunc_f64_s', 'i32.trunc_f64_u', 'i32.trunc_f64_s', 'i32.trunc_f64_u',
  'i32.trunc_f64_s', 'i32.trunc_f64_u', 'f32.demote_f64', null,
]

// SIMD: vector width per element type (elements per v128)
const VEC_WIDTH = [16, 16, 8, 8, 4, 4, 4, 2] // 128 bits / element bits


// === SIMD pattern detection ===

/** Check if AST node is a constant number */
const isConst = node => {
  if (typeof node === 'number') return node
  if (Array.isArray(node) && node[0] == null && typeof node[1] === 'number') return node[1]
  return false
}

/**
 * Analyze callback body for SIMD-vectorizable patterns.
 * Returns { op, val } or null.
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
    // i32-only bitwise (no-op for float prefixes since analyzeSimd won't produce these for float)
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
  const { op, val: c } = pattern
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
    (local $len i32) (local $srcOff i32) (local $dstOff i32) (local $dst i32)
    (local $i i32) (local $simdLen i32) (local $byteOff i32)
    (local $v v128)
    ${scalarLocal}
    (local.set $len (call $__len (local.get $src)))
    (local.set $srcOff (call $__typed_data (local.get $src)))
    ;; Alloc result typed array: header(8) + data. Header stores byteLen = len << ${shift}.
    (local.set $dst (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $len) (i32.const ${shift})))))
    (i32.store (local.get $dst) (i32.shl (local.get $len) (i32.const ${shift})))
    (i32.store (i32.add (local.get $dst) (i32.const 4)) (i32.shl (local.get $len) (i32.const ${shift})))
    (local.set $dstOff (i32.add (local.get $dst) (i32.const 8)))
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


export default (ctx) => {
  deps({
    __byte_length: ['__ptr_type', '__ptr_offset', '__ptr_aux'],
    __byte_offset: ['__ptr_type', '__ptr_offset', '__ptr_aux'],
    __to_buffer: ['__ptr_type', '__ptr_offset', '__ptr_aux', '__mkptr'],
    __typed_set_idx: () => ['__ptr_aux', '__ptr_offset',
      ...(ctx.features.f16 ? ['__f64_to_f16'] : []), ...(ctx.features.clamped ? ['__u8_clamp'] : [])],
    __typed_get_idx: () => ['__ptr_aux', '__ptr_offset', ...(ctx.features.f16 ? ['__f16_to_f64'] : [])],
    // __clamp_idx is body-called by every range op (fill/copyWithin/subarray/slice). It has NO
    // other manual-dep edge in the whole stdlib, so it's reachable ONLY via resolveIncludes'
    // auto-scan — which diverges under self-host (jz.wasm), dropping it ("Unknown func
    // $__clamp_idx" on typed .fill/.subarray in the kernel). Declare it manually here so the
    // reliable dep path includes it. Pinned by test/selfhost-includes.js.
    __typed_fill: ['__len', '__typed_set_idx', '__clamp_idx'],
    __typed_reverse: ['__len', '__typed_get_idx', '__typed_set_idx'],
    __typed_copyWithin: ['__len', '__typed_get_idx', '__typed_set_idx', '__clamp_idx'],
    __typed_sort: ['__len', '__typed_get_idx', '__typed_set_idx'],
    __subarray: ['__ptr_aux', '__ptr_offset', '__typed_shift', '__typed_data', '__len', '__mkptr', '__alloc', '__clamp_idx'],
    __typed_slice_rt: ['__ptr_aux', '__typed_shift', '__typed_data', '__len', '__mkptr', '__alloc_hdr_n', '__clamp_idx'],
    // __str_join uses __typed_idx when typedarray is loaded (plain arrays promoted to
    // Int32Array by promoteIntArrayLiterals can produce PTR.TYPED results via .map()).
    __str_join: [...(ctx.core.stdlibDeps.__str_join ?? []), '__typed_idx'],
  })

  // .map invokes with arity 1; .forEach/.find/.some/.every/.filter/.findIndex
  // invoke with (item, idx) → arity 2. Reduce with (acc, item) → arity 2.
  // (jz omits the `arr` arg array-spec callbacks normally receive — matches
  // array.js convention.)
  ctx.closure.floor = Math.max(ctx.closure.floor ?? 0, 2)

  inc('__mkptr', '__alloc', '__len')

  const buf = call('__to_buffer', 'I')
  const blen = call('__byte_length', 'I', 'i32')
  const boff = call('__byte_offset', 'I', 'i32')

  // Unknown receiver for a buffer-family accessor: only BUFFER/TYPED own
  // `.buffer`/`.byteLength`/`.byteOffset` in JS — on everything else the name
  // is an ordinary own property (or undefined). Same dispatch shape as
  // collection.js's `.size` (the dot-name hijack class, .work/todo.md
  // 2026-07-11): a PROVEN BUFFER/TYPED receiver keeps the direct helper call;
  // otherwise tag-dispatch at runtime — the NaN-check guards real numbers
  // whose bit pattern could false-match the tag compare, and the prehashed
  // dyn dispatcher covers OBJECT schema slots, HASH keys, sidecars, and
  // primitives (→ undefined).
  const bufAccessorDyn = (prop, helper, direct) => (obj) => {
    const vt = valTypeOf(obj)
    if (vt === VAL.BUFFER || vt === VAL.TYPED) return direct(obj)
    inc('__ptr_type', '__dyn_get_expr_t_h', helper)
    const o = temp('bad'), t = tempI32('badt')
    const og = ['local.get', `$${o}`]
    const helperCall = ['call', `$${helper}`, ['i64.reinterpret_f64', og]]
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${o}`, asF64(emit(obj))],
      ['local.set', `$${t}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', og]]],
      ['if', ['result', 'f64'],
        ['i32.and',
          ['f64.ne', og, og],
          ['i32.or',
            ['i32.eq', ['local.get', `$${t}`], ['i32.const', PTR.BUFFER]],
            ['i32.eq', ['local.get', `$${t}`], ['i32.const', PTR.TYPED]]]],
        ['then', helper === '__to_buffer' ? typed(helperCall, 'f64') : ['f64.convert_i32_s', helperCall]],
        ['else', ['f64.reinterpret_i64', ['call', '$__dyn_get_expr_t_h',
          ['i64.reinterpret_f64', og], asI64(emit(['str', prop])), ['local.get', `$${t}`],
          ['i32.const', strHashLiteral(prop)]]]]]], 'f64')
  }
  const bufDyn = bufAccessorDyn('buffer', '__to_buffer', buf)
  const blenDyn = bufAccessorDyn('byteLength', '__byte_length', blen)
  const boffDyn = bufAccessorDyn('byteOffset', '__byte_offset', boff)

  // === Runtime helpers: byte length, buffer coerce ===
  // __typed_shift lives in core (needed by __len/__cap).

  // __byte_length(ptr) — byte size for BUFFER/TYPED; 0 otherwise.
  // BUFFER and owned TYPED store byteLen at [-8]. TYPED view (aux bit 3) stores byteLen
  // at descriptor[0].
  ctx.core.stdlib['__byte_length'] = `(func $__byte_length (param $ptr i64) (result i32)
    (local $t i32) (local $off i32)
    (local.set $t (call $__ptr_type (local.get $ptr)))
    (if (result i32)
      (i32.or
        (i32.eq (local.get $t) (i32.const ${PTR.BUFFER}))
        (i32.eq (local.get $t) (i32.const ${PTR.TYPED})))
      (then
        (local.set $off (call $__ptr_offset (local.get $ptr)))
        (if (result i32)
          (i32.and
            (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
            (i32.ne (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const 8)) (i32.const 0)))
          (then (i32.load (local.get $off)))
          (else (i32.load (i32.sub (local.get $off) (i32.const 8))))))
      (else (i32.const 0))))`

  // __to_buffer(ptr) — return a BUFFER aliasing the same bytes (zero-copy view).
  // BUFFER: passthrough.
  // Owned TYPED: retag as BUFFER at same offset — the byteLen header is shared.
  // TYPED view: retag as BUFFER at the parent data offset (descriptor[8]) — reconstructs
  // the root ArrayBuffer so its own header supplies byteLength.
  ctx.core.stdlib['__to_buffer'] = `(func $__to_buffer (param $ptr i64) (result f64)
    (local $t i32) (local $off i32)
    (local.set $t (call $__ptr_type (local.get $ptr)))
    (if (result f64) (i32.eq (local.get $t) (i32.const ${PTR.BUFFER}))
      (then (f64.reinterpret_i64 (local.get $ptr)))
      (else
        (local.set $off (call $__ptr_offset (local.get $ptr)))
        (if (result f64)
          (i32.and
            (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
            (i32.ne (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const 8)) (i32.const 0)))
          (then (call $__mkptr (i32.const ${PTR.BUFFER}) (i32.const 0)
                  (i32.load (i32.add (local.get $off) (i32.const 8)))))
          (else (call $__mkptr (i32.const ${PTR.BUFFER}) (i32.const 0) (local.get $off)))))))`

  // __subarray(ptr, begin, end, useEnd) — runtime-dispatched `.subarray(...)` for
  // when the receiver's elem type / view-ness isn't statically known (a binding
  // reassigned owned→view: `let c = new T(d); c = c.subarray(n)`). Reads elem type
  // and the view bit off the aux byte, so it is correct whether `ptr` is an owned
  // typed array or an existing view. Mirrors the static `.typed:subarray` emitter:
  // builds the 16-byte descriptor [byteLen][dataOff][rootOff] and tags TYPED|view.
  // Cold path (slicing, not per-element) — correctness over speed.
  ctx.core.stdlib['__subarray'] = `(func $__subarray (param $ptr i64) (param $begin i32) (param $end i32) (param $useEnd i32) (result f64)
    (local $aux i32) (local $shift i32) (local $off i32) (local $data i32) (local $root i32)
    (local $len i32) (local $lo i32) (local $hi i32) (local $n i32) (local $desc i32)
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (local.set $shift (call $__typed_shift (i32.and (local.get $aux) (i32.const 7))))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (local.set $data (call $__typed_data (local.get $ptr)))
    (local.set $root
      (if (result i32) (i32.and (local.get $aux) (i32.const 8))
        (then (i32.load (i32.add (local.get $off) (i32.const 8))))
        (else (local.get $off))))
    (local.set $len (call $__len (local.get $ptr)))
    (local.set $lo (call $__clamp_idx (local.get $begin) (local.get $len)))
    (if (local.get $useEnd)
      (then
        (local.set $hi (call $__clamp_idx (local.get $end) (local.get $len))))
      (else (local.set $hi (local.get $len))))
    (local.set $n (select (i32.sub (local.get $hi) (local.get $lo)) (i32.const 0) (i32.gt_s (local.get $hi) (local.get $lo))))
    (local.set $desc (call $__alloc (i32.const 16)))
    (i32.store (local.get $desc) (i32.shl (local.get $n) (local.get $shift)))
    (i32.store (i32.add (local.get $desc) (i32.const 4)) (i32.add (local.get $data) (i32.shl (local.get $lo) (local.get $shift))))
    (i32.store (i32.add (local.get $desc) (i32.const 8)) (local.get $root))
    (call $__mkptr (i32.const ${PTR.TYPED}) (i32.or (local.get $aux) (i32.const 8)) (local.get $desc)))`

  // __typed_slice_rt(ptr, begin, end, useEnd) — runtime-dispatched `.slice(...)` for
  // a receiver whose elem type / view-ness isn't statically known. Unlike subarray
  // this returns a fresh OWNED copy (bit-exact memory.copy, so bigint-safe too). Reads
  // elem type + data address off the aux byte. Cold path — correctness over speed.
  ctx.core.stdlib['__typed_slice_rt'] = `(func $__typed_slice_rt (param $ptr i64) (param $begin i32) (param $end i32) (param $useEnd i32) (result f64)
    (local $aux i32) (local $et i32) (local $shift i32) (local $src i32)
    (local $len i32) (local $lo i32) (local $hi i32) (local $n i32) (local $byteLen i32) (local $dst i32)
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (local.set $et (i32.and (local.get $aux) (i32.const 7)))
    (local.set $shift (call $__typed_shift (local.get $et)))
    (local.set $src (call $__typed_data (local.get $ptr)))
    (local.set $len (call $__len (local.get $ptr)))
    (local.set $lo (call $__clamp_idx (local.get $begin) (local.get $len)))
    (if (local.get $useEnd)
      (then
        (local.set $hi (call $__clamp_idx (local.get $end) (local.get $len))))
      (else (local.set $hi (local.get $len))))
    (local.set $n (select (i32.sub (local.get $hi) (local.get $lo)) (i32.const 0) (i32.gt_s (local.get $hi) (local.get $lo))))
    (local.set $byteLen (i32.shl (local.get $n) (local.get $shift)))
    (local.set $dst (call $__alloc_hdr_n (local.get $byteLen) (local.get $byteLen) (i32.const 1)))
    (memory.copy (local.get $dst) (i32.add (local.get $src) (i32.shl (local.get $lo) (local.get $shift))) (local.get $byteLen))
    (call $__mkptr (i32.const ${PTR.TYPED}) (i32.and (local.get $aux) (i32.const 119)) (local.get $dst)))`

  // Constructor: new Float64Array(len) | new F64Array(arr) | new F64Array(buf) | new F64Array(buf, off, len)
  for (const [name, elemType] of Object.entries(TYPED_ELEM_CODE)) {
    const aux = typedAux(name)
    const stride = STRIDE[elemType]
    ctx.core.emit[`new.${name}`] = (lenExpr, offsetExpr, lenExpr2) => {
      ctx.features.typedarray = true
      if (name === 'Float16Array') ctx.features.f16 = true
      if (name === 'Uint8ClampedArray') ctx.features.clamped = true
      const srcType = typeof lenExpr === 'string' ? lookupValType(lenExpr) : valTypeOf(lenExpr)
      // Subview: new TypedArray(buffer, byteOffset, length) — true JS-parity view.
      // Allocates a 16-byte descriptor [byteLen:i32][dataOff:i32][parentOff:i32][pad]
      // and tags the TYPED ptr with aux=elemType|8. Reads/writes alias the parent,
      // .buffer reconstructs the root BUFFER, .byteOffset = dataOff - parentOff.
      if (offsetExpr != null && lenExpr2 != null) {
        ctx.features.typedView = true  // subview aliases the parent buffer — SLP must not assume disjoint bases
        const src = temp('tvs')
        const parentOff = tempI32('tvp')
        const byteLen = tempI32('tvb')
        const dst = tempI32('tvd')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${src}`, asF64(emit(lenExpr))],
          ['local.set', `$${parentOff}`, ptrOffsetIR(['local.get', `$${src}`], srcType)],
          ['local.set', `$${byteLen}`, ['i32.mul', asI32(emit(lenExpr2)), ['i32.const', stride]]],
          ['local.set', `$${dst}`, ['call', '$__alloc', ['i32.const', 16]]],
          ['i32.store', ['local.get', `$${dst}`], ['local.get', `$${byteLen}`]],
          ['i32.store',
            ['i32.add', ['local.get', `$${dst}`], ['i32.const', 4]],
            ['i32.add', ['local.get', `$${parentOff}`], asI32(emit(offsetExpr))]],
          ['i32.store',
            ['i32.add', ['local.get', `$${dst}`], ['i32.const', 8]],
            ['local.get', `$${parentOff}`]],
          mkPtrIR(PTR.TYPED, typedAux(name, true), ['local.get', `$${dst}`])], 'f64')
      }
      // TypedArray(typedArray) COPIES into fresh storage with element conversion —
      // spec: only (buffer[, off, len]) constructs a view. Element reads go through
      // __typed_idx (the source's elemType lives in its aux at runtime), stores
      // convert to THIS view's elemType — `new Float64Array(int32Arr)` converts.
      const copyFromTyped = (srcTemp) => {
        inc('__typed_idx', '__len')
        const cl = tempI32('tcl'), ci = tempI32('tci')
        const out = allocPtr({ type: PTR.TYPED, aux,
          len: ['i32.mul', ['local.get', `$${cl}`], ['i32.const', stride]], stride: 1, tag: 'tc' })
        const conv = FROM_F64[elemType]
        const srcElem = ['call', '$__typed_idx', ['i64.reinterpret_f64', ['local.get', `$${srcTemp}`]], ['local.get', `$${ci}`]]
        const cid = ctx.func.uniq++
        const dstOff = ['i32.add', ['local.get', `$${out.local}`], ['i32.mul', ['local.get', `$${ci}`], ['i32.const', stride]]]
        const storeIR = (name === 'Float16Array' || name === 'Uint8ClampedArray')
          ? elemStoreIR({ et: elemType, isF16: name === 'Float16Array', isClamped: name === 'Uint8ClampedArray' }, dstOff, srcElem)
          : [STORE[elemType], dstOff, conv ? [conv, srcElem] : srcElem]
        return ['block', ['result', 'f64'],
          ['local.set', `$${cl}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${srcTemp}`]]]],
          out.init,
          ['local.set', `$${ci}`, ['i32.const', 0]],
          ['block', `$tcb${cid}`, ['loop', `$tclp${cid}`,
            ['br_if', `$tcb${cid}`, ['i32.ge_s', ['local.get', `$${ci}`], ['local.get', `$${cl}`]]],
            storeIR,
            ['local.set', `$${ci}`, ['i32.add', ['local.get', `$${ci}`], ['i32.const', 1]]],
            ['br', `$tclp${cid}`]]],
          out.ptr]
      }
      // Single arg array-like source: copy elements instead of treating the pointer as a length.
      if (srcType === VAL.ARRAY && ctx.core.emit[`${name}.from`])
        return ctx.core.emit[`${name}.from`](lenExpr)
      if (srcType === VAL.TYPED) {
        const src = temp('ts')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${src}`, asF64(emit(lenExpr))],
          copyFromTyped(src)], 'f64')
      }
      // Reinterpret on a buffer: zero-copy view. TYPED retagged at the same offset —
      // the byteLen header is shared with the parent. __len(view) = byteLen >> shift
      // computes elemCount for this view's elemType.
      if (srcType === VAL.BUFFER) {
        ctx.features.typedView = true  // zero-copy reinterpret aliases the source — SLP must not pack across it
        return mkPtrIR(PTR.TYPED, aux, ['call', '$__ptr_offset', ['i64.reinterpret_f64', asF64(emit(lenExpr))]])
      }
      if (srcType == null && ctx.core.emit[`${name}.from`]) {
        ctx.features.typedView = true  // unknown arg: runtime may take the buffer zero-copy-view branch

        // Runtime dispatch: number → allocate; array/typed → copy elements; buffer → zero-copy view.
        const src = temp('ts')
        const len = tempI32('tl')
        const shift = SHIFT[elemType]
        const numBytes = ['i32.shl', ['local.get', `$${len}`], ['i32.const', shift]]
        const numAlloc = allocPtr({ type: PTR.TYPED, aux, len: numBytes, stride: 1, tag: 'ta' })
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${src}`, asF64(emit(lenExpr))],
          ['if', ['result', 'f64'],
            ['f64.eq', ['local.get', `$${src}`], ['local.get', `$${src}`]],
            // Regular number: treat as length, allocate fresh typed array with byteLen header
            ['then', ['block', ['result', 'f64'],
              ['local.set', `$${len}`, ['i32.trunc_sat_f64_s', ['local.get', `$${src}`]]],
              numAlloc.init,
              numAlloc.ptr]],
            // Pointer: array → boxed-slot copy; typed → converted element copy; buffer → zero-copy view
            ['else', ['if', ['result', 'f64'],
              ptrTypeEq(['local.get', `$${src}`], PTR.ARRAY),
              ['then', ctx.core.emit[`${name}.from`](src)],
              ['else', ['if', ['result', 'f64'],
                ptrTypeEq(['local.get', `$${src}`], PTR.TYPED),
                ['then', copyFromTyped(src)],
                ['else', mkPtrIR(PTR.TYPED, aux,
                  ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${src}`]]])]]]]]]], 'f64')
      }
      // Normal: allocate fresh typed array (lenExpr is numeric size). Header stores byteLen.
      const shift = SHIFT[elemType]
      const lenL = tempI32('tan')
      const out = allocPtr({ type: PTR.TYPED, aux,
        len: ['i32.shl', ['local.get', `$${lenL}`], ['i32.const', shift]], stride: 1, tag: 'ta' })
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${lenL}`, asI32(emit(lenExpr))],
        out.init,
        out.ptr], 'f64')
    }
  }

  // === ArrayBuffer (PTR.BUFFER) and DataView ===
  // ArrayBuffer: first-class byte storage with [-8:byteLen][-4:byteCap][bytes].
  // DataView: passthrough ptr to the same BUFFER — DataView methods operate on raw bytes via offset.

  // ToIndex + allocation-ceiling for ArrayBuffer byte lengths: ToInteger (NaN→0,
  // trunc toward zero), then a RangeError for negatives and for any size jz
  // cannot represent as an i32 byte count. The ceiling sits just below 2^31 so
  // the trunc never traps and leaves room for the 8-byte buffer header — this
  // also rejects the spec's ≥2^53 case and genuinely un-allocatable sizes.
  ctx.core.stdlib['__ab_len'] = `(func $__ab_len (param $n f64) (result i32)
    (if (f64.ne (local.get $n) (local.get $n)) (then (local.set $n (f64.const 0))))
    (local.set $n (f64.trunc (local.get $n)))
    (if (i32.or
          (f64.lt (local.get $n) (f64.const 0))
          (f64.ge (local.get $n) (f64.const 2147483640)))
      (then (throw $__jz_err (f64.const 0))))
    (i32.trunc_f64_s (local.get $n)))`

  // new ArrayBuffer(n) → allocate n bytes, return as BUFFER pointer.
  // Length is ToNumber-coerced (ToIndex) so a Symbol length raises a TypeError;
  // __ab_len then throws a RangeError on a negative or oversized request.
  const arrayBufferCtor = (sizeExpr) => {
    ctx.runtime.throws = true
    inc('__ab_len')
    const n = typed(['call', '$__ab_len', toNumF64(sizeExpr, emit(sizeExpr))], 'i32')
    const out = allocPtr({ type: PTR.BUFFER, len: n, stride: 1, tag: 'ab' })
    return typed(['block', ['result', 'f64'], out.init, out.ptr], 'f64')
  }
  ctx.core.emit['new.ArrayBuffer'] = arrayBufferCtor

  // new DataView(buffer, byteOffset?, byteLength?) — a first-class view object,
  // represented exactly like a typed-array subview: a 16-byte descriptor
  // [byteLen:i32][dataOff:i32][parentOff:i32][pad] behind a TYPED|view pointer.
  // byteOffset/byteLength are ToIndex-coerced; the no-length form snapshots the
  // remaining buffer (buffer.byteLength - byteOffset). Because the view extent
  // lives in the descriptor, .byteLength/.byteOffset/.buffer and the get/set
  // bounds checks all read it at runtime — correct regardless of how the
  // receiver variable was assigned, and ArrayBuffer.isView(dv) is now true.
  ctx.core.emit['new.DataView'] = (bufExpr, offExpr, lenExpr) => {
    ctx.features.typedarray = true
    const src = temp('dvs')
    const parentOff = tempI32('dvp')
    const off = tempI32('dvo')
    const dst = tempI32('dvd')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${src}`, asF64(emit(bufExpr))],
      ['local.set', `$${parentOff}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${src}`]]]],
      ['local.set', `$${off}`, offExpr == null ? ['i32.const', 0] : dvIndex(offExpr)],
      ['local.set', `$${dst}`, ['call', '$__alloc', ['i32.const', 16]]],
      ['i32.store', ['local.get', `$${dst}`],
        lenExpr == null
          ? ['i32.sub', ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${src}`]]], ['local.get', `$${off}`]]
          : dvIndex(lenExpr)],
      ['i32.store', ['i32.add', ['local.get', `$${dst}`], ['i32.const', 4]],
        ['i32.add', ['local.get', `$${parentOff}`], ['local.get', `$${off}`]]],
      ['i32.store', ['i32.add', ['local.get', `$${dst}`], ['i32.const', 8]],
        ['local.get', `$${parentOff}`]],
      mkPtrIR(PTR.TYPED, 8, ['local.get', `$${dst}`])], 'f64')
  }

  // BigInt64Array(buffer) (bare form, legacy): coerce to same data, Float64Array-compatible storage.
  ctx.core.emit['BigInt64Array'] = (bufExpr) => {
    ctx.features.typedarray = true
    const va = asF64(emit(bufExpr))
    return mkPtrIR(PTR.TYPED, typedAux('BigInt64Array'), ['call', '$__ptr_offset', ['i64.reinterpret_f64', va]])
  }

  // .buffer — always aliased (zero-copy). BUFFER: passthrough.
  // Owned TYPED: retag as BUFFER at same offset — the byteLen header is shared.
  // TYPED view (incl. DataView): BUFFER at descriptor[8] (root parent data offset).
  registerGetter('.buffer', (obj) => {
    if (typeof obj === 'string') {
      const ctor = ctx.types.typedElem?.get(obj)
      if (ctor === 'new.ArrayBuffer') return asF64(emit(obj))
      if (ctor?.startsWith('new.')) {
        const isView = ctor.endsWith('.view')
        const name = isView ? ctor.slice(4, -5) : ctor.slice(4)
        if (TYPED_ELEM_CODE[name] != null) {
          const parentOff = isView
            ? ['i32.load', ['i32.add', ptrOffsetIR(emit(obj), VAL.TYPED), ['i32.const', 8]]]
            : ptrOffsetIR(emit(obj), VAL.TYPED)
          return mkPtrIR(PTR.BUFFER, 0, parentOff)
        }
      }
    }
    return bufDyn(obj)
  })

  // .byteLength — BUFFER: raw __len. Owned TYPED: elemCount * stride.
  // View TYPED (incl. DataView): descriptor[0], via the __byte_length fallback.
  registerGetter('.byteLength', (obj) => {
    if (typeof obj === 'string') {
      const ctor = ctx.types.typedElem?.get(obj)
      if (ctor === 'new.ArrayBuffer') {
        return typed(['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', asF64(emit(obj))]]], 'f64')
      }
      if (ctor && ctor.startsWith('new.')) {
        const isView = ctor.endsWith('.view')
        const name = isView ? ctor.slice(4, -5) : ctor.slice(4)
        const et = TYPED_ELEM_CODE[name]
        if (et != null) {
          if (isView) {
            return typed(['f64.convert_i32_s',
              ['i32.load', ptrOffsetIR(emit(obj), VAL.TYPED)]], 'f64')
          }
          return typed(['f64.convert_i32_s',
            ['i32.shl', ['call', '$__len', ['i64.reinterpret_f64', asF64(emit(obj))]], ['i32.const', SHIFT[et]]]], 'f64')
        }
      }
    }
    return blenDyn(obj)
  })

  // .byteOffset — owned: 0. View: descriptor[4] - descriptor[8].
  registerGetter('.byteOffset', (obj) => {
    if (typeof obj === 'string') {
      const ctor = ctx.types.typedElem?.get(obj)
      if (ctor?.endsWith('.view')) {
        const t = tempI32('bo')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${t}`, ptrOffsetIR(emit(obj), VAL.TYPED)],
          ['f64.convert_i32_s',
            ['i32.sub',
              ['i32.load', ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]]],
              ['i32.load', ['i32.add', ['local.get', `$${t}`], ['i32.const', 8]]]]]], 'f64')
      }
      if (ctor?.startsWith('new.') && TYPED_ELEM_CODE[ctor.slice(4)] != null) return typed(['f64.const', 0], 'f64')
    }
    return boffDyn(obj)
  })

  // Runtime fallback for .byteOffset when variable view-ness is unknown.
  ctx.core.stdlib['__byte_offset'] = `(func $__byte_offset (param $ptr i64) (result i32)
    (local $off i32)
    (if (result i32)
      (i32.and
        (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.TYPED}))
        (i32.ne (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const 8)) (i32.const 0)))
      (then
        (local.set $off (call $__ptr_offset (local.get $ptr)))
        (i32.sub
          (i32.load (i32.add (local.get $off) (i32.const 4)))
          (i32.load (i32.add (local.get $off) (i32.const 8)))))
      (else (i32.const 0))))`

  // ArrayBuffer.isView(x) — true iff x is a TYPED pointer. Typed arrays and
  // DataViews are both TYPED-tagged (a DataView is a TYPED|view descriptor), so
  // both report true; a bare ArrayBuffer is BUFFER-tagged and reports false.
  ctx.core.emit['ArrayBuffer.isView'] = (v) => {
    if (v === undefined) return typed(['f64.const', 0], 'f64')
    const va = asF64(emit(v))
    return typed(['f64.convert_i32_s', ptrTypeEq(va, PTR.TYPED)], 'f64')
  }

  // x instanceof Float64Array | Int32Array | … — typed-pointer predicate emitted
  // by jzify. NaN-check first, then __ptr_type === PTR.TYPED. Aux-byte ctor
  // discrimination (Float64 vs Int32) lives downstream in typedElem analysis —
  // this predicate only asserts "is some TypedArray". Result i32 (boolean).
  ctx.core.emit['__is_typed'] = (x) => {
    if (x === undefined) return typed(['i32.const', 0], 'i32')
    const v = asF64(emit(x))
    const t = temp('ityp')
    return typed(['i32.and',
      ['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
      ptrTypeEq(['local.get', `$${t}`], PTR.TYPED)], 'i32')
  }

  // buf.slice(begin?, end?) on a BUFFER → fresh BUFFER with the byte range copied.
  // Only dispatches statically when obj is a tracked ArrayBuffer/DataView variable.
  // Indices normalize through __clamp_idx (negative wraps from the end, then
  // clamp to [0, byteLength]) — the same bounds dance as every other range op.
  ctx.core.emit['.buf:slice'] = (obj, beginExpr, endExpr) => {
    inc('__clamp_idx')
    const src = temp('bss')
    const beg = tempI32('bsb')
    const end = tempI32('bse')
    const bytes = tempI32('bsn')
    const out = allocPtr({ type: PTR.BUFFER, len: ['local.get', `$${bytes}`], stride: 1, tag: 'bsd' })
    const lenWat = ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${src}`]]]
    const beginWat = beginExpr == null ? ['i32.const', 0] : asI32(emit(beginExpr))
    const endWat = endExpr == null ? lenWat : asI32(emit(endExpr))
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${src}`, asF64(emit(obj))],
      ['local.set', `$${beg}`, ['call', '$__clamp_idx', beginWat, lenWat]],
      ['local.set', `$${end}`, ['call', '$__clamp_idx', endWat, lenWat]],
      ['local.set', `$${bytes}`, ['i32.sub', ['local.get', `$${end}`], ['local.get', `$${beg}`]]],
      ['if',
        ['i32.lt_s', ['local.get', `$${bytes}`], ['i32.const', 0]],
        ['then', ['local.set', `$${bytes}`, ['i32.const', 0]]]],
      out.init,
      ['memory.copy',
        ['local.get', `$${out.local}`],
        ['i32.add', ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${src}`]]], ['local.get', `$${beg}`]],
        ['local.get', `$${bytes}`]],
      out.ptr], 'f64')
  }

  // DataView endianness — wasm memory is natively little-endian. The DV `littleEndian`
  // arg defaults to `false` per ECMA-262 (big-endian); when LE is false we have to
  // byte-swap. `staticLE` peels a literal `[null, x]` AST node and returns:
  //   true/false  — known endianness, no runtime branch needed
  //   null        — dynamic, emit `if le (native) else (bswap)`
  // We treat `undefined`/`null`/`0`/`''` as falsy (BE) per ToBoolean.
  const staticLE = (node) => {
    if (node === undefined) return false                              // arg omitted → BE
    // Prepare lowers a literal `true`/`false` endianness flag to `['bool', 0|1]`;
    // fold it so `dv.getInt16(p, true)` is one native load (no per-access LE branch
    // + dead byte-swap arm — the dominant overhead in DataView codec loops).
    if (Array.isArray(node) && node[0] === 'bool') return !!node[1]
    if (Array.isArray(node) && node[0] == null) {
      // [] → undefined, [null, x] → literal x
      if (node.length === 1) return false
      const v = node[1]
      if (v === undefined || v === null) return false
      if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return !!v
    }
    return null  // dynamic
  }

  // bswap16: i32 bytes [b0 b1] → [b1 b0]. Result is unsigned 16-bit; signed-16
  // sign-extension is applied by the load op (i32.load16_s) at the call site.
  const bswap16I32 = (v) => {
    const t = tempI32('bs16')
    return ['block', ['result', 'i32'],
      ['local.set', `$${t}`, v],
      ['i32.or',
        ['i32.shl', ['i32.and', ['local.get', `$${t}`], ['i32.const', 0xff]], ['i32.const', 8]],
        ['i32.and', ['i32.shr_u', ['local.get', `$${t}`], ['i32.const', 8]], ['i32.const', 0xff]]]]
  }

  // bswap32: i32 bytes [b0 b1 b2 b3] → [b3 b2 b1 b0]. Symmetric — used for both
  // load (after native LE load) and store (before native LE store).
  const bswap32I32 = (v) => {
    const t = tempI32('bs32')
    return ['block', ['result', 'i32'],
      ['local.set', `$${t}`, v],
      ['i32.or',
        ['i32.or',
          ['i32.shl', ['local.get', `$${t}`], ['i32.const', 24]],
          ['i32.shl', ['i32.and', ['local.get', `$${t}`], ['i32.const', 0xff00]], ['i32.const', 8]]],
        ['i32.or',
          ['i32.and', ['i32.shr_u', ['local.get', `$${t}`], ['i32.const', 8]], ['i32.const', 0xff00]],
          ['i32.and', ['i32.shr_u', ['local.get', `$${t}`], ['i32.const', 24]], ['i32.const', 0xff]]]]]
  }

  // bswap64: rotate bytes via two 32-bit halves. We need a runtime helper because
  // i64 doesn't have inline byte-swap and we'd otherwise emit a 64-line tree.
  ctx.core.stdlib['__bswap64'] = `(func $__bswap64 (param $v i64) (result i64)
    (local $r i64)
    (local.set $r (i64.shl (i64.and (local.get $v) (i64.const 0xff)) (i64.const 56)))
    (local.set $r (i64.or (local.get $r) (i64.shl (i64.and (local.get $v) (i64.const 0xff00)) (i64.const 40))))
    (local.set $r (i64.or (local.get $r) (i64.shl (i64.and (local.get $v) (i64.const 0xff0000)) (i64.const 24))))
    (local.set $r (i64.or (local.get $r) (i64.shl (i64.and (local.get $v) (i64.const 0xff000000)) (i64.const 8))))
    (local.set $r (i64.or (local.get $r) (i64.shr_u (i64.and (local.get $v) (i64.const 0xff00000000)) (i64.const 8))))
    (local.set $r (i64.or (local.get $r) (i64.shr_u (i64.and (local.get $v) (i64.const 0xff0000000000)) (i64.const 24))))
    (local.set $r (i64.or (local.get $r) (i64.shr_u (i64.and (local.get $v) (i64.const 0xff000000000000)) (i64.const 40))))
    (local.set $r (i64.or (local.get $r) (i64.shr_u (local.get $v) (i64.const 56))))
    (local.get $r))`
  const bswap64I64 = (v) => { inc('__bswap64'); return ['call', '$__bswap64', v] }

  // DV float reads return raw f64 bits, which may be non-canonical NaN (sign-flipped
  // or with payload). jz's `__eq` fast path only treats canonical NaN (0x7FF8…0000)
  // as NaN, so non-canonical NaN would break `v !== v` semantics. Canonicalize here
  // (cheap: 4 wasm ops) so `getFloat32`/`getFloat64` return a real-spec NaN value.
  ctx.core.stdlib['__canon_nan'] = `(func $__canon_nan (param $v f64) (result f64)
    (select
      (f64.reinterpret_i64 (i64.const ${_NAN_BITS}))
      (local.get $v)
      (f64.ne (local.get $v) (local.get $v))))`
  // Inline the NaN-canonicalization select rather than a call — a DataView float
  // read runs this per sample in codec loops, and the inlined `(select nan v (v≠v))`
  // is the exact idiom the auto-vectorizer recognizes (vs an opaque call).
  const canonNaN = (vIR) => {
    const t = temp('cn')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, vIR],
      ['select',
        ['f64.reinterpret_i64', ['i64.const', _NAN_BITS]],
        ['local.get', `$${t}`],
        ['f64.ne', ['local.get', `$${t}`], ['local.get', `$${t}`]]]], 'f64')
  }

  // ToIndex for DataView byte offsets (spec 25.1.2.x getViewValue/setViewValue):
  // ToIntegerOrInfinity then reject negatives and >2^53-1 with a RangeError. The
  // throw rides jz's $__jz_err tag so a user `try/catch` (or assert.throws) sees it.
  // trunc_sat keeps a huge-but-passing index from trapping the conversion — the
  // subsequent memory access fails the same way an oversized index always has.
  ctx.core.stdlib['__dv_index'] = `(func $__dv_index (param $idx f64) (result i32)
    (if (f64.ne (local.get $idx) (local.get $idx)) (then (local.set $idx (f64.const 0))))
    (local.set $idx (f64.trunc (local.get $idx)))
    (if (i32.or
          (f64.lt (local.get $idx) (f64.const 0))
          (f64.gt (local.get $idx) (f64.const 9007199254740991)))
      (then (throw $__jz_err (f64.const 0))))
    (i32.trunc_sat_f64_s (local.get $idx)))`

  // ToIndex the DV byte offset, throwing RangeError on a negative/oversized value.
  // The offset is ToNumber-coerced first (per ToIndex) so a Symbol byte offset
  // raises a TypeError instead of silently truncating to 0.
  const dvIndex = (offNode) => {
    ctx.runtime.throws = true
    inc('__dv_index')
    return typed(['call', '$__dv_index', toNumF64(offNode, emit(offNode))], 'i32')
  }

  // A DataView receiver resolves to its 16-byte descriptor pointer
  // [byteLen:i32][dataOff:i32][parentOff:i32]. get/set hoist this once, then
  // read dataOff (desc[4]) for the access address and byteLen (desc[0]) as the
  // view size for the bounds check.
  const dvDescriptor = (dv) => ptrOffsetIR(emit(dv), VAL.TYPED)
  const dvDataOff = (descLocal) => ['i32.load', ['i32.add', ['local.get', `$${descLocal}`], ['i32.const', 4]]]
  const dvViewSize = (descLocal) => ['i32.load', ['local.get', `$${descLocal}`]]

  // ToIndex the DV byte offset, then bounds-check `getIndex + elementSize > viewSize`
  // (spec 25.3.1.1 GetViewValue / SetViewValue step 13) — a RangeError when the
  // access would run past the view. elementSize moves to the static side of the
  // compare so a saturated/huge index can't overflow the i32 addition. viewSize is
  // read live from the descriptor, so the check holds for every DataView receiver.
  const dvIndexChecked = (offNode, size, viewSize) => {
    ctx.runtime.throws = true
    const idxT = tempI32('dvb')
    const offIR = emit(offNode)
    // Fast path: a proven-i32 byte offset (a loop-advanced `p`, `i*2`, a `|0` value)
    // carries no fraction/NaN/negative-from-ToNumber surprise, so it skips the f64
    // ToIndex round-trip and the `__dv_index` CALL — the dominant per-sample cost in
    // DataView-based codec loops. An i32 range (`<0`) + bounds (`>viewSize-size`)
    // check is all the spec needs here; this lowers `dv.getInt16(p,true)` to one
    // `i32.load16_s`, matching the explicit-typed-view path.
    if (offIR.type === 'i32') {
      return typed(['block', ['result', 'i32'],
        ['local.set', `$${idxT}`, offIR],
        ['if', ['i32.or',
            ['i32.lt_s', ['local.get', `$${idxT}`], ['i32.const', 0]],
            ['i32.gt_s', ['local.get', `$${idxT}`], ['i32.sub', viewSize, ['i32.const', size]]]],
          ['then', ['throw', '$__jz_err', ['f64.const', 0]]]],
        ['local.get', `$${idxT}`]], 'i32')
    }
    inc('__dv_index')
    return typed(['block', ['result', 'i32'],
      ['local.set', `$${idxT}`, typed(['call', '$__dv_index', toNumF64(offNode, offIR)], 'i32')],
      ['if', ['i32.gt_s', ['local.get', `$${idxT}`], ['i32.sub', viewSize, ['i32.const', size]]],
        ['then', ['throw', '$__jz_err', ['f64.const', 0]]]],
      ['local.get', `$${idxT}`]], 'i32')
  }

  // DataView set methods: extract i32 offset from f64 ptr, optionally byte-swap, store.
  // 8-bit ops ignore the LE arg entirely (single byte — no swap possible).
  const DV_SET = {
    setInt8: ['i32.store8', 'i32', 1],   setUint8: ['i32.store8', 'i32', 1],
    setInt16: ['i32.store16', 'i32', 2], setUint16: ['i32.store16', 'i32', 2],
    setInt32: ['i32.store', 'i32', 4],   setUint32: ['i32.store', 'i32', 4],
    setFloat32: ['f32.store', 'f32', 4], setFloat64: ['f64.store', 'f64', 8],
    setBigInt64: ['i64.store', 'i64', 8], setBigUint64: ['i64.store', 'i64', 8],
  }
  for (const [method, [storeOp, valType, size]] of Object.entries(DV_SET)) {
    ctx.core.emit[`.${method}`] = (dv, off, val, leNode) => {
      // Resolve the receiver's descriptor once; the store reads dataOff/byteLen from it.
      const desc = tempI32('dvD')
      const fin = (body) => ['block', ['local.set', `$${desc}`, dvDescriptor(dv)], body]
      const addr = ['i32.add', dvDataOff(desc), dvIndexChecked(off, size, dvViewSize(desc))]
      // Coerce value into the wasm value type the store op consumes. Non-BigInt
      // stores ToNumber the value first (per SetViewValue) so a Symbol value
      // raises a TypeError and a string value parses instead of truncating to 0.
      let v
      if (valType === 'i64') v = typed(['i64.reinterpret_f64', asF64(emit(val))], 'i64')
      else if (valType === 'f64') v = asF64(toNumF64(val, emit(val)))
      else if (valType === 'f32') v = typed(['f32.demote_f64', asF64(toNumF64(val, emit(val)))], 'f32')
      else v = asI32(toNumF64(val, emit(val)))

      if (size === 1) return fin([storeOp, addr, v])

      // For BE we byte-swap the integer payload; floats route through bitcast i↔f.
      const swap = (iVal) => size === 2 ? bswap16I32(iVal) : size === 4 ? bswap32I32(iVal) : bswap64I64(iVal)
      const beStore = () => {
        if (valType === 'f32') {
          const swapped = typed(['f32.reinterpret_i32', swap(typed(['i32.reinterpret_f32', v], 'i32'))], 'f32')
          return [storeOp, addr, swapped]
        }
        if (valType === 'f64') {
          const swapped = typed(['f64.reinterpret_i64', bswap64I64(typed(['i64.reinterpret_f64', v], 'i64'))], 'f64')
          return [storeOp, addr, swapped]
        }
        return [storeOp, addr, swap(v)]
      }

      const le = staticLE(leNode)
      if (le === true) return fin([storeOp, addr, v])
      if (le === false) return fin(beStore())
      // Dynamic: hoist value + addr into temps so each branch can re-use.
      const aT = tempI32('dvsa')
      const vLoc = valType === 'i64' ? tempI64('dvsv') : valType === 'i32' ? tempI32('dvsv') : temp('dvsv')
      // Re-declare with correct type for f32 (temp() defaults to f64).
      if (valType === 'f32') ctx.func.locals.set(vLoc, 'f32')
      const leT = tempI32('dvsle')
      return fin(['block',
        ['local.set', `$${aT}`, addr],
        ['local.set', `$${vLoc}`, v],
        ['local.set', `$${leT}`, truthyIR(emit(leNode))],
        ['if',
          ['local.get', `$${leT}`],
          ['then', [storeOp, ['local.get', `$${aT}`], typed(['local.get', `$${vLoc}`], valType)]],
          ['else', (() => {
            const refV = typed(['local.get', `$${vLoc}`], valType)
            if (valType === 'f32') return [storeOp, ['local.get', `$${aT}`], typed(['f32.reinterpret_i32', swap(typed(['i32.reinterpret_f32', refV], 'i32'))], 'f32')]
            if (valType === 'f64') return [storeOp, ['local.get', `$${aT}`], typed(['f64.reinterpret_i64', bswap64I64(typed(['i64.reinterpret_f64', refV], 'i64'))], 'f64')]
            return [storeOp, ['local.get', `$${aT}`], swap(refV)]
          })()]]])
    }
  }

  // DataView get methods: extract i32 offset, load value, optionally byte-swap, return as f64.
  // 8-bit ops ignore the LE arg entirely (single byte).
  const DV_GET = {
    getInt8: ['i32.load8_s', 'i32', 1, true],  getUint8: ['i32.load8_u', 'i32', 1, false],
    getInt16: ['i32.load16_s', 'i32', 2, true], getUint16: ['i32.load16_u', 'i32', 2, false],
    getInt32: ['i32.load', 'i32', 4, true],    getUint32: ['i32.load', 'i32', 4, false],
    getFloat32: ['f32.load', 'f32', 4, false], getFloat64: ['f64.load', 'f64', 8, false],
    getBigInt64: ['i64.load', 'i64', 8, true], getBigUint64: ['i64.load', 'i64', 8, false],
  }
  for (const [method, [loadOp, resultType, size, signed]] of Object.entries(DV_GET)) {
    ctx.core.emit[`.${method}`] = (dv, off, leNode) => {
      // Resolve the receiver's descriptor once; the load reads dataOff/byteLen from it.
      const desc = tempI32('dvD')
      const fin = (body) => typed(['block', ['result', 'f64'],
        ['local.set', `$${desc}`, dvDescriptor(dv)], asF64(body)], 'f64')
      const addr = ['i32.add', dvDataOff(desc), dvIndexChecked(off, size, dvViewSize(desc))]

      // Convert a wasm-typed raw value back into the f64 ABI return. Float reads
      // canonicalize NaN (see __canon_nan) so downstream `v !== v` works.
      const toF64 = (raw) => {
        if (resultType === 'f64') return canonNaN(raw)
        if (resultType === 'f32') return canonNaN(typed(['f64.promote_f32', raw], 'f64'))
        if (resultType === 'i64') return typed(['f64.reinterpret_i64', raw], 'f64')
        return typed(signed ? ['f64.convert_i32_s', raw] : ['f64.convert_i32_u', raw], 'f64')
      }

      if (size === 1) return fin(toF64(typed([loadOp, addr], resultType)))

      // LE path: native wasm load is already little-endian.
      // BE path: load as raw int (always little-endian on wasm), byte-swap, then
      //          reinterpret to the requested type so sign-extension matches.
      // For unsigned 16-bit, bswap16 only spans the low half — no extra masking needed.
      // For signed 16-bit BE, swap then sign-extend via `i32.extend16_s`.
      const beLoad = () => {
        if (size === 2) {
          const rawU = bswap16I32(typed(['i32.load16_u', addr], 'i32'))
          return toF64(typed(signed ? ['i32.extend16_s', rawU] : rawU, 'i32'))
        }
        if (size === 4) {
          if (resultType === 'f32') {
            return toF64(typed(['f32.reinterpret_i32', bswap32I32(typed(['i32.load', addr], 'i32'))], 'f32'))
          }
          return toF64(typed(bswap32I32(typed(['i32.load', addr], 'i32')), 'i32'))
        }
        // size === 8 (f64 or i64).
        if (resultType === 'f64') {
          return toF64(typed(['f64.reinterpret_i64', bswap64I64(typed(['i64.load', addr], 'i64'))], 'f64'))
        }
        return typed(['f64.reinterpret_i64', bswap64I64(typed(['i64.load', addr], 'i64'))], 'f64')
      }

      const le = staticLE(leNode)
      if (le === true) return fin(toF64(typed([loadOp, addr], resultType)))
      if (le === false) return fin(beLoad())
      // Dynamic LE: hoist addr, branch on leNode at runtime.
      const aT = tempI32('dvga')
      const leT = tempI32('dvgle')
      return fin(typed(['block', ['result', 'f64'],
        ['local.set', `$${aT}`, addr],
        ['local.set', `$${leT}`, truthyIR(emit(leNode))],
        ['if', ['result', 'f64'],
          ['local.get', `$${leT}`],
          ['then', asF64(toF64(typed([loadOp, ['local.get', `$${aT}`]], resultType)))],
          ['else', asF64((() => {
            // Replicate beLoad but using hoisted addr.
            const a = ['local.get', `$${aT}`]
            if (size === 2) {
              const rawU = bswap16I32(typed(['i32.load16_u', a], 'i32'))
              return toF64(typed(signed ? ['i32.extend16_s', rawU] : rawU, 'i32'))
            }
            if (size === 4) {
              if (resultType === 'f32') {
                return toF64(typed(['f32.reinterpret_i32', bswap32I32(typed(['i32.load', a], 'i32'))], 'f32'))
              }
              return toF64(typed(bswap32I32(typed(['i32.load', a], 'i32')), 'i32'))
            }
            if (resultType === 'f64') {
              return toF64(typed(['f64.reinterpret_i64', bswap64I64(typed(['i64.load', a], 'i64'))], 'f64'))
            }
            return typed(['f64.reinterpret_i64', bswap64I64(typed(['i64.load', a], 'i64'))], 'f64')
          })())]]], 'f64'))
    }
  }

  // DataView.getFloat16 / setFloat16 (ES2025) — the 2-byte binary16 payload
  // around the same descriptor/bounds/LE machinery as get/setUint16, with the
  // core conversion kernels at the value edge.
  ctx.core.emit['.getFloat16'] = (dv, off, leNode) => {
    inc('__f16_to_f64')
    const desc = tempI32('dvD')
    const addr = ['i32.add', dvDataOff(desc), dvIndexChecked(off, 2, dvViewSize(desc))]
    const cvt = (raw16) => typed(['call', '$__f16_to_f64', raw16], 'f64')
    const le = staticLE(leNode)
    let body
    if (le === true) body = cvt(['i32.load16_u', addr])
    else if (le === false) body = cvt(bswap16I32(typed(['i32.load16_u', addr], 'i32')))
    else {
      const aT = tempI32('dvga'), leT = tempI32('dvgle')
      body = typed(['block', ['result', 'f64'],
        ['local.set', `$${aT}`, addr],
        ['local.set', `$${leT}`, truthyIR(emit(leNode))],
        ['if', ['result', 'f64'], ['local.get', `$${leT}`],
          ['then', cvt(['i32.load16_u', ['local.get', `$${aT}`]])],
          ['else', cvt(bswap16I32(typed(['i32.load16_u', ['local.get', `$${aT}`]], 'i32')))]]], 'f64')
    }
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${desc}`, dvDescriptor(dv)],
      asF64(body)], 'f64')
  }

  ctx.core.emit['.setFloat16'] = (dv, off, val, leNode) => {
    inc('__f64_to_f16')
    const desc = tempI32('dvD'), aT = tempI32('dvsa'), vT = tempI32('dvsv16')
    const addr = ['i32.add', dvDataOff(desc), dvIndexChecked(off, 2, dvViewSize(desc))]
    const le = staticLE(leNode)
    const store = (bits) => ['i32.store16', ['local.get', `$${aT}`], bits]
    const bitsLE = ['local.get', `$${vT}`]
    const bitsBE = () => bswap16I32(typed(['local.get', `$${vT}`], 'i32'))
    let storeIR
    if (le === true) storeIR = store(bitsLE)
    else if (le === false) storeIR = store(bitsBE())
    else {
      const leT = tempI32('dvsle')
      storeIR = ['block',
        ['local.set', `$${leT}`, truthyIR(emit(leNode))],
        ['if', ['local.get', `$${leT}`], ['then', store(bitsLE)], ['else', store(bitsBE())]]]
    }
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${desc}`, dvDescriptor(dv)],
      ['local.set', `$${aT}`, addr],
      ['local.set', `$${vT}`, ['call', '$__f64_to_f16', asF64(emit(val))]],
      storeIR,
      undefExpr()], 'f64')
  }

  // TypedArray.from(arr) — convert regular array to typed array
  for (const [name, elemType] of Object.entries(TYPED_ELEM_CODE)) {
    const aux = typedAux(name)
    const stride = STRIDE[elemType], store = STORE[elemType]
    ctx.core.emit[`${name}.from`] = (src) => {
      ctx.features.typedarray = true
      if (name === 'Float16Array') ctx.features.f16 = true
      if (name === 'Uint8ClampedArray') ctx.features.clamped = true
      const fl = { et: elemType, isF16: name === 'Float16Array', isClamped: name === 'Uint8ClampedArray' }
      // Bare array-literal source (`Int32Array.from([…])`, `new Int32Array([…])`): build the
      // typed array directly — alloc + one native-typed store per element — instead of
      // materializing an intermediate f64 ARRAY (every element a 9-byte f64.const) plus a
      // per-element f64→elem copy loop. For an integer view each element then stores as an
      // i32.const (2 B for small values), so a constant program / lookup table stops
      // round-tripping through the boxed-f64 array. Fresh alloc per evaluation, so identity
      // and mutation semantics are unchanged. BigInt views (elemType>7) keep the loop.
      if (Array.isArray(src) && src[0] === '[' && elemType <= 7
          && !src.slice(1).some(e => Array.isArray(e) && e[0] === '...')) {
        const elems = src.slice(1)
        const out = allocPtr({ type: PTR.TYPED, aux, len: ['i32.const', elems.length * stride], stride: 1, tag: 'tf' })
        const body = [out.init]
        for (let k = 0; k < elems.length; k++) {
          const addr = k === 0 ? ['local.get', `$${out.local}`]
            : ['i32.add', ['local.get', `$${out.local}`], ['i32.const', k * stride]]
          if (fl.isF16 || fl.isClamped) { body.push(elemStoreIR(fl, addr, asF64(emit(elems[k])))); continue }
          const v = elemType <= 5 ? asI32(emit(elems[k]))
            : elemType === 6 ? ['f32.demote_f64', asF64(emit(elems[k]))]
            : asF64(emit(elems[k]))
          body.push([store, addr, v])
        }
        body.push(out.ptr)
        return typed(['block', ['result', 'f64'], ...body], 'f64')
      }
      const srcL = temp('tfs')
      const len = tempI32('tfl'), i = tempI32('tfi'), off = tempI32('tfo')
      const out = allocPtr({ type: PTR.TYPED, aux,
        len: ['i32.mul', ['local.get', `$${len}`], ['i32.const', stride]], stride: 1, tag: 'tf' })
      const t = out.local
      const id = ctx.func.uniq++
      const conv = FROM_F64[elemType]
      const srcF64 = ['f64.load', ['i32.add', ['local.get', `$${off}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]
      const dstAddr = ['i32.add', ['local.get', `$${t}`], ['i32.mul', ['local.get', `$${i}`], ['i32.const', stride]]]
      const storeExpr = (fl.isF16 || fl.isClamped)
        ? elemStoreIR(fl, dstAddr, srcF64)
        : [store, dstAddr, conv ? [conv, srcF64] : srcF64]
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${srcL}`, asF64(emit(src))],
        ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${srcL}`]]]],
        ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${srcL}`]]]],
        out.init,
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$brk${id}`, ['loop', `$loop${id}`,
          ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
          storeExpr,
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]],
        out.ptr], 'f64')
    }
  }

  // .length handled by ptr.js's __len (reads from memory header [-8:len])

  /** Resolve element type + view-ness for a known TypedArray expression.
   *  Returns { et, isView, isBigInt } or null. Handles:
   *    - bare binding: `xs` (in typedElem)
   *    - element-preserving method chain: `xs.filter(...)` / `xs.map(...)` /
   *      `xs.slice(...)` — walks back to the root binding. View-ness clears
   *      at the chain output (the result is always an owned typed array). */
  const TYPED_CHAIN_METHODS = new Set(['map', 'filter', 'slice'])
  const resolveElem = (arr) => {
    let receiver = arr, chainOutput = false, viewOutput = false
    // Walk method-call chain inward. `arr.method(...)` parses as
    // ['()', ['.', recv, 'method'], ...args] — peel until we hit a name. The OUTERMOST
    // op decides view-ness: `.subarray(...)` yields a zero-copy VIEW (reads must indirect
    // through the descriptor), whereas `.map`/`.slice`/… yield a fresh non-view copy.
    while (Array.isArray(receiver) && receiver[0] === '()' &&
        Array.isArray(receiver[1]) && receiver[1][0] === '.' &&
        (TYPED_CHAIN_METHODS.has(receiver[1][2]) || receiver[1][2] === 'subarray')) {
      if (!chainOutput) viewOutput = receiver[1][2] === 'subarray'
      receiver = receiver[1][1]
      chainOutput = true
    }
    // Nested receiver `arr[i]` where `arr`'s elements are typed arrays of a known
    // ctor (`Array.from(n, () => new Float32Array())` — codec channelData). The i-th
    // element IS that owned typed array; emit(receiver) already loads its pointer, so
    // the standard typedDataAddr path inlines `arr[i][j]` to a direct load/store.
    const ctor = (Array.isArray(receiver) && receiver[0] === '[]' && receiver.length === 3 && typeof receiver[1] === 'string'
        ? ctx.func.localReps?.get(receiver[1])?.arrayElemTypedCtor
        : null)
      || (typeof receiver === 'string' && ctx.types.typedElem?.get(receiver))
      // Direct fresh-ctor receiver: `new Int32Array([…]).map(f)` — the ctor call
      // node IS the receiver, no binding to look up. Without this the chain fell
      // to the plain-array emitters, which read f64 slots — silently wrong for
      // every element kind except Float64Array.
      || typedElemCtor(receiver)
    if (!ctor) return null
    const isView = viewOutput || (!chainOutput && ctor.endsWith('.view'))
    const name = ctor.endsWith('.view') ? ctor.slice(4, -5) : ctor.slice(4)
    const et = TYPED_ELEM_CODE[name]
    if (name === 'Float16Array') ctx.features.f16 = true
    if (name === 'Uint8ClampedArray') ctx.features.clamped = true
    return et == null ? null : { et, isView, name,
      isBigInt: name === 'BigInt64Array' || name === 'BigUint64Array',
      isF16: name === 'Float16Array', isClamped: name === 'Uint8ClampedArray' }
  }

  // Canonical element accessors — the ONE home for kind-aware load/store IR.
  // r is a resolveElem result (or {et,...} with optional flags). f16 rides the
  // u16 slot with a conversion kernel each way; clamped is a u8 with the
  // ToUint8Clamp store. Everything else keeps the exact historical opcodes.
  const elemLoadIR = (r, off) => {
    if (r.isBigInt) return ['f64.reinterpret_i64', ['i64.load', off]]
    if (r.isF16) { inc('__f16_to_f64'); return ['call', '$__f16_to_f64', ['i32.load16_u', off]] }
    if (r.et === 7) return ['f64.load', off]
    if (r.et === 6) return ['f64.promote_f32', ['f32.load', off]]
    return [(r.et & 1) ? 'f64.convert_i32_u' : 'f64.convert_i32_s', [LOAD[r.et], off]]
  }
  const elemStoreIR = (r, off, valF64) => {
    if (r.isBigInt) return ['i64.store', off, ['i64.reinterpret_f64', valF64]]
    if (r.isF16) { inc('__f64_to_f16'); return ['i32.store16', off, ['call', '$__f64_to_f16', valF64]] }
    if (r.isClamped) { inc('__u8_clamp'); return ['i32.store8', off, ['call', '$__u8_clamp', valF64]] }
    if (r.et === 7) return ['f64.store', off, valF64]
    if (r.et === 6) return ['f32.store', off, ['f32.demote_f64', valF64]]
    return [STORE[r.et], off, [(r.et & 1) ? 'i32.trunc_f64_u' : 'i32.trunc_f64_s', valF64]]
  }

  /** Emit the real data byte-address for a typed array IR node.
   *  Owned: low 32 bits of the NaN-box (or the unboxed local directly).
   *  View: load descriptor[4]. Uses ptrOffsetIR so unboxed-TYPED locals pass through
   *  without a rebox-then-unbox round trip, and globals fold to inline bit-extract. */
  // A typed array (Float64Array/Int32Array/…) is a FIXED-SIZE allocation — it has no
  // grow op, so it can never relocate, so its base needs no realloc-forwarding follow.
  // An already-unboxed pointer is the offset itself; a boxed f64 pointer extracts its
  // low-32 offset directly — no __ptr_offset call. (The general ptrOffsetIR keeps the
  // forwarding follow because ARRAY/HASH/SET/MAP relocate and an *inferred* OBJECT can
  // alias a relocated ARRAY — but VAL.TYPED is a narrow type that can only be a real
  // typed array, so the follow is provably dead here.)
  const typedBase = (objIR) => objIR.ptrKind != null && objIR.ptrKind !== VAL.ARRAY
    ? objIR
    : ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', asF64(objIR)], ['i64.const', LAYOUT.OFFSET_MASK]]]
  const typedDataAddr = (objIR, isView) => isView
    ? ['i32.load', ['i32.add', typedBase(objIR), ['i32.const', 4]]]
    : typedBase(objIR)

  // Runtime-dispatch typed index: checks ptr_type + aux to load with correct stride.
  // For TYPED views (aux bit 3), $off indirects through descriptor[4] to real data.
  ctx.core.stdlib['__typed_set_idx'] = () => `(func $__typed_set_idx (param $ptr i64) (param $i i32) (param $v f64) (result f64)
    (local $off i32) (local $aux i32) (local $et i32) (local $bits i32) (local $vb i64)
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (i32.ne (i32.and (local.get $aux) (i32.const 8)) (i32.const 0))
      (then (local.set $off (i32.load (i32.add (local.get $off) (i32.const 4))))))
    (local.set $et (i32.and (local.get $aux) (i32.const 7)))
    (if (i32.and (local.get $aux) (i32.const ${TYPED_ELEM_BIGINT_FLAG}))
      (then (i64.store (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))) (i64.reinterpret_f64 (local.get $v))))
      (else
        ;; ToNumber for NaN-boxed values (spec: typed element writes coerce).
        ;; true/false/null atoms store 1/0/0; other boxes (undefined, string,
        ;; object) store canonical NaN. Skipped on the BigInt arm above — raw
        ;; bigint i64 bits legitimately look like NaN through the f64 param.
        (if (f64.ne (local.get $v) (local.get $v))
          (then
            (local.set $vb (i64.reinterpret_f64 (local.get $v)))
            (local.set $v (f64.const nan))
            (if (i64.eq (local.get $vb) (i64.const ${TRUE_NAN}))
              (then (local.set $v (f64.const 1))))
            (if (i32.or (i64.eq (local.get $vb) (i64.const ${FALSE_NAN}))
                        (i64.eq (local.get $vb) (i64.const ${NULL_NAN})))
              (then (local.set $v (f64.const 0))))))
        ${ctx.features.f16 ? `(if (i32.and (local.get $aux) (i32.const 32)) (then
          (i32.store16 (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1)))
            (call $__f64_to_f16 (local.get $v)))
          (return (local.get $v))))` : ''}
        ${ctx.features.clamped ? `(if (i32.and (local.get $aux) (i32.const 64)) (then
          (i32.store8 (i32.add (local.get $off) (local.get $i))
            (call $__u8_clamp (local.get $v)))
          (return (local.get $v))))` : ''}
        (if (i32.eq (local.get $et) (i32.const 7))
          (then (f64.store (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))) (local.get $v)))
          (else
            (if (i32.eq (local.get $et) (i32.const 6))
              (then (f32.store (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))) (f32.demote_f64 (local.get $v))))
              (else
                (local.set $bits
                  (i32.wrap_i64
                    (if (result i64) (f64.lt (local.get $v) (f64.const 0))
                      (then (i64.trunc_sat_f64_s (local.get $v)))
                      (else (i64.trunc_sat_f64_u (local.get $v))))))
                (if (i32.ge_u (local.get $et) (i32.const 4))
                  (then (i32.store (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))) (local.get $bits)))
                  (else (if (i32.ge_u (local.get $et) (i32.const 2))
                    (then (i32.store16 (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1))) (local.get $bits)))
                    (else (i32.store8 (i32.add (local.get $off) (local.get $i)) (local.get $bits))))))))))))
    (local.get $v))`

  // .fill(value, start?, end?) for typed arrays. The plain-array __arr_fill gates
  // on PTR.ARRAY and silently no-ops a typed receiver (the storage layout and
  // element width differ); this loops the element-width-aware __typed_set_idx
  // over the clamped range so every element kind (u8…f64, BigInt) fills correctly.
  // start/end default 0/length, accept negatives, and clamp to [0, length].
  ctx.core.stdlib['__typed_fill'] = `(func $__typed_fill (param $ptr i64) (param $val f64) (param $start i32) (param $end i32) (result f64)
    (local $len i32) (local $i i32)
    (local.set $len (call $__len (local.get $ptr)))
    (local.set $start (call $__clamp_idx (local.get $start) (local.get $len)))
    (local.set $end (call $__clamp_idx (local.get $end) (local.get $len)))
    (local.set $i (local.get $start))
    (block $done (loop $fill
      (br_if $done (i32.ge_s (local.get $i) (local.get $end)))
      (drop (call $__typed_set_idx (local.get $ptr) (local.get $i) (local.get $val)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    (f64.reinterpret_i64 (local.get $ptr)))`

  // Element-width/-kind-aware read: arr[i] → f64, the read mirror of __typed_set_idx.
  // Integers convert by signedness (et&1 ⇒ unsigned); BigInt returns the raw i64 bits
  // reinterpreted as f64 so a get→set roundtrip is bit-exact (set_idx stores the bits
  // back unchanged). Used by the in-place algorithms below for random-access reads.
  ctx.core.stdlib['__typed_get_idx'] = () => `(func $__typed_get_idx (param $ptr i64) (param $i i32) (result f64)
    (local $off i32) (local $aux i32) (local $et i32)
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (i32.and (local.get $aux) (i32.const 8))
      (then (local.set $off (i32.load (i32.add (local.get $off) (i32.const 4))))))
    (local.set $et (i32.and (local.get $aux) (i32.const 7)))
    (if (result f64) (i32.and (local.get $aux) (i32.const ${TYPED_ELEM_BIGINT_FLAG}))
      (then (f64.reinterpret_i64 (i64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))))
      (else (if (result f64) (i32.eq (local.get $et) (i32.const 7))
        (then (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
        (else (if (result f64) (i32.eq (local.get $et) (i32.const 6))
          (then (f64.promote_f32 (f32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))
          (else (if (result f64) (i32.ge_u (local.get $et) (i32.const 4))
            (then (if (result f64) (i32.and (local.get $et) (i32.const 1))
              (then (f64.convert_i32_u (i32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))
              (else (f64.convert_i32_s (i32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))))
            (else (if (result f64) (i32.ge_u (local.get $et) (i32.const 2))
              (then ${ctx.features.f16 ? `(if (result f64) (i32.and (local.get $aux) (i32.const 32))
                (then (call $__f16_to_f64 (i32.load16_u (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1))))))
                (else ` : ''}(if (result f64) (i32.and (local.get $et) (i32.const 1))
                (then (f64.convert_i32_u (i32.load16_u (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1))))))
                (else (f64.convert_i32_s (i32.load16_s (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1)))))))${ctx.features.f16 ? '))' : ''})
              (else (if (result f64) (i32.and (local.get $et) (i32.const 1))
                (then (f64.convert_i32_u (i32.load8_u (i32.add (local.get $off) (local.get $i)))))
                (else (f64.convert_i32_s (i32.load8_s (i32.add (local.get $off) (local.get $i)))))))))))))))))`

  // .reverse() — in-place, element-kind-agnostic via get/set (bit-exact for BigInt).
  ctx.core.stdlib['__typed_reverse'] = `(func $__typed_reverse (param $ptr i64) (result f64)
    (local $len i32) (local $i i32) (local $j i32) (local $t f64)
    (local.set $len (call $__len (local.get $ptr)))
    (local.set $i (i32.const 0))
    (local.set $j (i32.sub (local.get $len) (i32.const 1)))
    (block $done (loop $rev
      (br_if $done (i32.ge_s (local.get $i) (local.get $j)))
      (local.set $t (call $__typed_get_idx (local.get $ptr) (local.get $i)))
      (drop (call $__typed_set_idx (local.get $ptr) (local.get $i) (call $__typed_get_idx (local.get $ptr) (local.get $j))))
      (drop (call $__typed_set_idx (local.get $ptr) (local.get $j) (local.get $t)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $j (i32.sub (local.get $j) (i32.const 1)))
      (br $rev)))
    (f64.reinterpret_i64 (local.get $ptr)))`

  // .copyWithin(target, start, end) — in-place overlap-safe move. Indices accept
  // negatives (from end) and clamp to [0, len]; count = min(end-start, len-target).
  // Direction picked so overlapping ranges don't clobber unread source elements.
  ctx.core.stdlib['__typed_copyWithin'] = `(func $__typed_copyWithin (param $ptr i64) (param $target i32) (param $start i32) (param $end i32) (result f64)
    (local $len i32) (local $count i32) (local $k i32)
    (local.set $len (call $__len (local.get $ptr)))
    (local.set $target (call $__clamp_idx (local.get $target) (local.get $len)))
    (local.set $start (call $__clamp_idx (local.get $start) (local.get $len)))
    (local.set $end (call $__clamp_idx (local.get $end) (local.get $len)))
    (local.set $count (i32.sub (local.get $end) (local.get $start)))
    (if (i32.gt_s (local.get $count) (i32.sub (local.get $len) (local.get $target)))
      (then (local.set $count (i32.sub (local.get $len) (local.get $target)))))
    (if (i32.lt_s (local.get $target) (local.get $start))
      (then
        (local.set $k (i32.const 0))
        (block $fd (loop $fl
          (br_if $fd (i32.ge_s (local.get $k) (local.get $count)))
          (drop (call $__typed_set_idx (local.get $ptr) (i32.add (local.get $target) (local.get $k))
            (call $__typed_get_idx (local.get $ptr) (i32.add (local.get $start) (local.get $k)))))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $fl))))
      (else
        (local.set $k (local.get $count))
        (block $bd (loop $bl
          (br_if $bd (i32.le_s (local.get $k) (i32.const 0)))
          (local.set $k (i32.sub (local.get $k) (i32.const 1)))
          (drop (call $__typed_set_idx (local.get $ptr) (i32.add (local.get $target) (local.get $k))
            (call $__typed_get_idx (local.get $ptr) (i32.add (local.get $start) (local.get $k)))))
          (br $bl)))))
    (f64.reinterpret_i64 (local.get $ptr)))`

  // .sort() — default numeric order (insertion sort, stable). NaN sorts to the end,
  // -0 before +0 (the equal-value tiebreak via signed-bit compare). BigInt arrays are
  // compared as signed i64 on their exact bits. A user comparator is handled inline by
  // the .typed:sort emitter (this helper is the no-argument numeric path).
  ctx.core.stdlib['__typed_sort'] = `(func $__typed_sort (param $ptr i64) (result f64)
    (local $isbig i32) (local $len i32) (local $i i32) (local $j i32) (local $saved f64) (local $nb f64)
    (local.set $isbig (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const ${TYPED_ELEM_BIGINT_FLAG})))
    (local.set $len (call $__len (local.get $ptr)))
    (local.set $i (i32.const 1))
    (block $od (loop $ol
      (br_if $od (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $saved (call $__typed_get_idx (local.get $ptr) (local.get $i)))
      (local.set $j (i32.sub (local.get $i) (i32.const 1)))
      (block $id (loop $il
        (br_if $id (i32.lt_s (local.get $j) (i32.const 0)))
        (local.set $nb (call $__typed_get_idx (local.get $ptr) (local.get $j)))
        (br_if $id (i32.eqz
          (if (result i32) (local.get $isbig)
            (then (i64.gt_s (i64.reinterpret_f64 (local.get $nb)) (i64.reinterpret_f64 (local.get $saved))))
            (else (if (result i32) (f64.ne (local.get $nb) (local.get $nb))
              (then (i32.eqz (f64.ne (local.get $saved) (local.get $saved))))
              (else (if (result i32) (f64.ne (local.get $saved) (local.get $saved))
                (then (i32.const 0))
                (else (if (result i32) (f64.gt (local.get $nb) (local.get $saved))
                  (then (i32.const 1))
                  (else (if (result i32) (f64.lt (local.get $nb) (local.get $saved))
                    (then (i32.const 0))
                    (else (i64.gt_s (i64.reinterpret_f64 (local.get $nb)) (i64.reinterpret_f64 (local.get $saved)))))))))))))))
        (drop (call $__typed_set_idx (local.get $ptr) (i32.add (local.get $j) (i32.const 1)) (local.get $nb)))
        (local.set $j (i32.sub (local.get $j) (i32.const 1)))
        (br $il)))
      (drop (call $__typed_set_idx (local.get $ptr) (i32.add (local.get $j) (i32.const 1)) (local.get $saved)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $ol)))
    (f64.reinterpret_i64 (local.get $ptr)))`

  ctx.core.emit['.typed:fill'] = (arr, val, start, end) => {
    inc('__typed_fill')
    return typed(['call', '$__typed_fill',
      asI64(emit(arr)),
      val == null ? undefExpr() : asF64(emit(val)),
      start == null ? ['i32.const', 0] : asI32(emit(start)),
      end == null ? ['i32.const', 0x7FFFFFFF] : asI32(emit(end))], 'f64')
  }

  // .reverse() / .copyWithin(...) for typed arrays. The plain-array helpers gate on
  // PTR.ARRAY and silently no-op a typed receiver; these go through the element-kind-
  // aware get/set helpers so every width and signedness reverses/moves correctly.
  ctx.core.emit['.typed:reverse'] = (arr) => {
    inc('__typed_reverse')
    return typed(['call', '$__typed_reverse', asI64(emit(arr))], 'f64')
  }

  ctx.core.emit['.typed:copyWithin'] = (arr, target, start, end) => {
    inc('__typed_copyWithin')
    return typed(['call', '$__typed_copyWithin',
      asI64(emit(arr)),
      target == null ? ['i32.const', 0] : asI32(emit(target)),
      start == null ? ['i32.const', 0] : asI32(emit(start)),
      end == null ? ['i32.const', 0x7FFFFFFF] : asI32(emit(end))], 'f64')
  }

  // .sort(compareFn?) for typed arrays. No argument → the numeric __typed_sort helper
  // (typed-array default is NUMERIC, unlike Array.sort's lexicographic default — so it
  // must NOT route through the plain-array string comparator). With a comparator, an
  // insertion sort is emitted inline, calling the closure per neighbor compare; a
  // positive return shifts (same convention as Array.prototype.sort).
  // Sort the typed array VALUE `arrValIR` in place and return it. Factored out so
  // .typed:sort sorts the receiver and .typed:toSorted sorts a fresh copy with one body.
  const emitTypedSort = (arrValIR, fn) => {
    if (fn == null) {
      inc('__typed_sort')
      return typed(['call', '$__typed_sort', asI64(arrValIR)], 'f64')
    }
    inc('__len', '__typed_get_idx', '__typed_set_idx')
    const arrL = temp('tsa'), cbL = temp('tsf')
    const len = tempI32('tsn'), i = tempI32('tsi'), j = tempI32('tsj')
    const cur = temp('tsc'), nb = temp('tsb')
    const id = ctx.func.uniq++
    const oE = `$tsoe${id}`, oL = `$tsol${id}`, iE = `$tsie${id}`, iL = `$tsil${id}`
    const ptr = () => ['i64.reinterpret_f64', ['local.get', `$${arrL}`]]
    const jp1 = ['i32.add', ['local.get', `$${j}`], ['i32.const', 1]]
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${arrL}`, asF64(arrValIR)],
      ['local.set', `$${cbL}`, asF64(emit(fn))],
      ['local.set', `$${len}`, ['call', '$__len', ptr()]],
      ['local.set', `$${i}`, ['i32.const', 1]],
      ['block', oE, ['loop', oL,
        ['br_if', oE, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
        ['local.set', `$${cur}`, ['call', '$__typed_get_idx', ptr(), ['local.get', `$${i}`]]],
        ['local.set', `$${j}`, ['i32.sub', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['block', iE, ['loop', iL,
          ['br_if', iE, ['i32.lt_s', ['local.get', `$${j}`], ['i32.const', 0]]],
          ['local.set', `$${nb}`, ['call', '$__typed_get_idx', ptr(), ['local.get', `$${j}`]]],
          // Break unless cmp(neighbor, cur) > 0. f64.gt is false for NaN (spec NaN-as-0).
          ['br_if', iE, ['i32.eqz', ['f64.gt',
            asF64(ctx.closure.call(typed(['local.get', `$${cbL}`], 'f64'),
              [typed(['local.get', `$${nb}`], 'f64'), typed(['local.get', `$${cur}`], 'f64')])),
            ['f64.const', 0]]]],
          ['drop', ['call', '$__typed_set_idx', ptr(), jp1, ['local.get', `$${nb}`]]],
          ['local.set', `$${j}`, ['i32.sub', ['local.get', `$${j}`], ['i32.const', 1]]],
          ['br', iL]]],
        ['drop', ['call', '$__typed_set_idx', ptr(), jp1, ['local.get', `$${cur}`]]],
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', oL]]],
      ['local.get', `$${arrL}`]], 'f64')
  }
  ctx.core.emit['.typed:sort'] = (arr, fn) => emitTypedSort(emit(arr), fn)

  // Type-aware TypedArray read: arr[i]. The DIRECT unchecked load is gated on the
  // structural in-bounds proof (inBoundsArrIdx — the same canonical `for (i=C≥0;
  // i<arr.length; i++)` scan the generic ARRAY read uses), which keeps every proven
  // hot loop byte-identical (the vectorizer's shapes). An UNPROVEN index takes the
  // checked form: JS reads `undefined` past the end — the unchecked load read
  // ADJACENT HEAP or trapped past memory (the Root F silent-corruption class).
  // `i32.lt_u` folds the negative case in (a negative i32 is a huge u32). The
  // checked result is number|undefined, so it carries NO valKind tag.
  // Elem-count for a checked site. A TypedArray's length is immutable, so for
  // a stable PARAM receiver (readable at entry, never reassigned in the body)
  // the shifted count materializes ONCE as a function-entry local shared by
  // every checked read/write guard of that receiver — the size-tier
  // complement of the speed tier's loop hoists (drained by collectParamInits,
  // the probeHoist mechanism). Non-params (mid-body inits) and reassigned
  // names keep the inline header load.
  const staticTypedLen = (arr) => {
    if (typeof arr !== 'string') return null
    // globalTypedLen originates at the declaration. A mutable module global may
    // later receive a same-ctor array of another length inside any function;
    // until an all-writers length lattice proves otherwise, never substitute
    // its declaration length into a guard.
    if (ctx.scope?.globals?.get(arr)?.mut && !ctx.func.locals?.has(arr)) return null
    return ctx.types.typedLen?.get(arr) ?? ctx.scope?.globalTypedLen?.get(arr) ?? null
  }
  const leanLen = (arr, et, isView) => {
    const staticLen = staticTypedLen(arr)
    if (staticLen != null) return ['i32.const', staticLen]
    const lenIR = () => ['i32.shr_u',
      ['i32.load', isView ? typedBase(emit(arr)) : ['i32.sub', typedBase(emit(arr)), ['i32.const', 8]]],
      ['i32.const', SHIFT[et]]]
    if (!(ctx.transform.optFlags & OPTF.leanCheckedIdx) ||
        typeof arr !== 'string' ||
        !ctx.func.current?.params?.some(p => p.name === arr) ||
        !ctx.func.body || isReassigned(ctx.func.body, arr)) return lenIR()
    const memo = (ctx.func.lenHoist ??= new Map())
    const key = `${arr} ${SHIFT[et]}${isView ? 'v' : ''}`
    let h = memo.get(key)
    if (!h) {
      h = { t: tempI32('tlen'), init: lenIR() }
      memo.set(key, h)
    }
    return ['local.get', `$${h.t}`]
  }
  // Coalesce the checked fetch bundle of an interpreter/decoder loop. For
  // `while (pc < N) { o = pc*W; x=code[o]; y=code[o+1]; … }`, a static
  // `code.length >= N*W` means every fetch is in-bounds whenever pc>=0. One
  // signed guard can therefore feed the whole adjacent bundle; negative pc
  // still yields each read's normal undefined arm. The dispatch/state body is
  // NOT cloned (unlike whole-loop versioning), so V8 sees one compact loop.
  const typedBundleGuard = (arr, i) => {
    if (typeof arr !== 'string') return null
    if (ctx.func._typedBundleBody !== ctx.func.body) {
      ctx.func._typedBundleBody = ctx.func.body
      ctx.func._typedBundleGuards = new Map()
      const stmtsOf = (b) => {
        while (Array.isArray(b) && b[0] === '{}' && b.length === 2) b = b[1]
        return Array.isArray(b) && (b[0] === ';' || b[0] === '{}') ? b.slice(1) : [b]
      }
      const declsIn = (s) => {
        const out = []
        if (Array.isArray(s) && (s[0] === 'let' || s[0] === 'const'))
          for (let k = 1; k < s.length; k++) if (Array.isArray(s[k]) && s[k][0] === '=' && typeof s[k][1] === 'string') out.push(s[k])
        return out
      }
      const hasWrite = (n, name) => {
        if (!Array.isArray(n)) return false
        if ((ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') && n[1] === name) return true
        for (let k = 1; k < n.length; k++) if (hasWrite(n[k], name)) return true
        return false
      }
      const scan = (n) => {
        if (!Array.isArray(n) || n[0] === '=>') return
        if (n[0] === 'while' && Array.isArray(n[1]) && n[1][0] === '<' && typeof n[1][1] === 'string') {
          const pc = n[1][1], bound = constIntExpr(n[1][2]), stmts = stmtsOf(n[2])
          if (bound != null && bound > 0) {
            for (const s of stmts) for (const d of (Array.isArray(s) && s[0] === 'const' ? declsIn(s) : [])) {
              const rhs = d[2]
              if (!(Array.isArray(rhs) && rhs[0] === '*' && rhs.length === 3)) continue
              const c1 = constIntExpr(rhs[1]), c2 = constIntExpr(rhs[2])
              const width = rhs[1] === pc ? c2 : rhs[2] === pc ? c1 : null
              if (width == null || width < 1) continue
              const base = d[1], groups = new Map(), bad = new Set()
              let pcWritten = false
              const walkReads = (x, visit) => {
                if (!Array.isArray(x) || x[0] === '=>') return
                if (x[0] === '[]' && typeof x[1] === 'string') {
                  let off = null
                  if (x[2] === base) off = 0
                  else if (Array.isArray(x[2]) && x[2][0] === '+' && x[2].length === 3) {
                    if (x[2][1] === base) off = constIntExpr(x[2][2])
                    else if (x[2][2] === base) off = constIntExpr(x[2][1])
                  }
                  if (off != null && off >= 0 && off < width) visit(x[1], off, idxKey(x[1], x[2]))
                }
                for (let k = 1; k < x.length; k++) walkReads(x[k], visit)
              }
              for (const st of stmts) {
                const directDecl = Array.isArray(st) && (st[0] === 'let' || st[0] === 'const')
                const writesPcHere = hasWrite(st, pc)
                walkReads(st, (recv, off, key) => {
                  if (pcWritten || writesPcHere || !directDecl) bad.add(recv)
                  else {
                    let g = groups.get(recv)
                    if (!g) groups.set(recv, g = { offsets: [], keys: [] })
                    if (!g.offsets.includes(off)) { g.offsets.push(off); g.keys.push(key) }
                  }
                })
                if (hasWrite(st, pc)) pcWritten = true
              }
              for (const [recv, g] of groups) {
                const len = staticTypedLen(recv)
                if (bad.has(recv) || g.keys.length < 2 || len == null || len < bound * width) continue
                const guard = { pc, primary: g.keys[0], temp: null }
                for (const key of g.keys) ctx.func._typedBundleGuards.set(key, guard)
              }
            }
          }
        }
        for (let k = 1; k < n.length; k++) scan(n[k])
      }
      scan(ctx.func.body)
    }
    const key = idxKey(arr, i), g = ctx.func._typedBundleGuards.get(key)
    if (!g) return null
    if (!g.temp) g.temp = tempI32('tbg')
    // The iv's CELL may be f64 (a maybe-miss def widened it — `pc = code[t]`
    // where the read can miss). Compare in the cell's own type: f64.ge(NaN, 0)
    // is false, so an undefined-flow iv correctly takes the checked path.
    const sign = ctx.func.locals.get(g.pc) === 'f64'
      ? ['f64.ge', ['local.get', `$${g.pc}`], ['f64.const', 0]]
      : ['i32.ge_s', ['local.get', `$${g.pc}`], ['i32.const', 0]]
    return key === g.primary
      ? ['local.tee', `$${g.temp}`, sign]
      : ['local.get', `$${g.temp}`]
  }

  // Prepared postfix indices have the canonical i32 form `(++i) - 1`.
  // Materialize the old value and advance separately: this preserves JS's
  // reference-before-RHS order while avoiding add→sub cancellation plus two
  // tees at every codec byte access.
  const postIncI32Index = (i) => {
    if (!(Array.isArray(i) && i[0] === '-' && constIntExpr(i[2]) === 1 &&
        Array.isArray(i[1]) && i[1][0] === '++' && typeof i[1][1] === 'string')) return null
    const name = i[1][1], old = emit(name)
    if (old?.type !== 'i32') return null
    const t = tempI32('tpi')
    return {
      pre: [['local.set', `$${t}`, old], emit(['++', name], 'void')],
      value: ['local.get', `$${t}`],
    }
  }

  ctx.core.emit['.typed:[]'] = (arr, i) => {
    const r = resolveElem(arr)
    if (r == null) return null // unknown type, fallback to generic
    const { et, isView, isBigInt } = r
    const key = idxKey(arr, i)
    const rmwRead = ctx.types.rmwReads?.get(key)
    if (rmwRead && et <= 5) {
      const rd = typed([(et & 1) ? 'f64.convert_i32_u' : 'f64.convert_i32_s',
        ['local.get', `$${rmwRead}`]], 'f64')
      rd.valKind = VAL.NUMBER
      return rd
    }
    const proven = typedIdxProven(arr, i) || ctx.types.rmwBounds?.has(key)
    const loadOf = (off) => elemLoadIR(r, off)
    if (!proven) {
      const bundleIn = typedBundleGuard(arr, i)
      // (A $__typed_idx call per site was tried for the size tier and REVERTED:
      // the helper + its __len/__ptr_offset chain cost ~+900 B while these
      // kernels have 1-3 unproven sites — inline wins until many sites share it.)
      // Size tier: IF-form checked read — guard hits load DIRECTLY (no address
      // clamp, no select pair), guard misses yield undefined. ~6 ops/site
      // leaner than the branchless form below, whose only reason is keeping
      // SPEED-tier kernel bodies branch-free for the SIMD lift (off at -Os).
      if ((ctx.transform.optFlags & OPTF.leanCheckedIdx)) {
        const ti = tempI32('tbi')
        const off = ['i32.add', typedDataAddr(emit(arr), isView),
          ['i32.shl', ['local.get', `$${ti}`], ['i32.const', SHIFT[et]]]]
        // Build the load IR BEFORE the index emission below: `idx(i)` recurses
        // into the emitter (the index may itself be a typed read), and under
        // self-host the deferred `loadOf` closure re-reading `r` after that
        // nested emit picked up the INNER array's element kind — `t[p[0]]` on a
        // Float64Array loaded with the Uint32Array's opcode (i32.load+convert,
        // value garbage). Eager construction pins the receiver's own kind.
        const loadIR = loadOf(off)
        // Preserve the old zero-metadata path for ordinary reads. Only a read
        // currently serving as another index pays to materialize its miss bit.
        if (!ctx.types.indexConsumer) {
          const rd = typed(['if', ['result', 'f64'],
            bundleIn
              ? ['block', ['result', 'i32'], ['local.set', `$${ti}`, idx(i)], bundleIn]
              : ['i32.lt_u', ['local.tee', `$${ti}`, idx(i)], leanLen(arr, et, isView)],
            ['then', loadIR], ['else', undefExpr()]], 'f64')
          if (!isBigInt) rd.checkedNumRead = true
          return rd
        }
        const tin = tempI32('tbn'), innerIdx = idx(i), innerValid = innerIdx.indexValid
        const ownValid = bundleIn || ['i32.lt_u', ['local.get', `$${ti}`], leanLen(arr, et, isView)]
        const condition = innerValid ? ['i32.and', innerValid, ownValid] : ownValid
        const rd = typed(['block', ['result', 'f64'],
          ['local.set', `$${ti}`, innerIdx],
          ['local.set', `$${tin}`, condition],
          ['if', ['result', 'f64'], ['local.get', `$${tin}`], ['then', loadIR], ['else', undefExpr()]],
        ], 'f64')
        rd.indexValid = ['local.get', `$${tin}`]
        // number|undefined with the undefined confined to a CONST arm — a numeric
        // consumer (toNumF64) folds ToNumber into that arm statically
        if (!isBigInt) rd.checkedNumRead = true
        return rd
      }
      // BRANCHLESS checked read: `select(load(in ? idx : 0), undefined, in)`. The
      // address clamp makes the load unconditionally safe (index 0 of the data
      // region is mapped arena even for a 0-length array — the loaded value is
      // select-discarded), and the branch-free shape keeps checked reads inside
      // straight-line kernel bodies the SIMD recognizers can still lift.
      // len inlines to one header load for a RESOLVED elem type (no call — the
      // SIMD recognizers require call-free kernel bodies): owned byteLen at
      // base-8, view byteLen at descriptor[0]; elemCount = byteLen >> shift.
      const ti = tempI32('tbi'), tin = tempI32('tbn')
      const lenIR = ['i32.shr_u',
        ['i32.load', isView ? typedBase(emit(arr)) : ['i32.sub', typedBase(emit(arr)), ['i32.const', 8]]],
        ['i32.const', SHIFT[et]]]
      const off = ['i32.add', typedDataAddr(emit(arr), isView),
        ['i32.shl', ['select', ['local.get', `$${ti}`], ['i32.const', 0], ['local.get', `$${tin}`]],
          ['i32.const', SHIFT[et]]]]
      // Eager load-IR: see the leanCheckedIdx comment above — the nested
      // `idx(i)` emit below must not run before the receiver's load op is built.
      const loadIR = loadOf(off)
      const innerIdx = idx(i)
      const innerValid = ctx.types.indexConsumer ? innerIdx.indexValid : null
      const ownValid = bundleIn || ['i32.lt_u', ['local.get', `$${ti}`], lenIR]
      const rd = typed(['block', ['result', 'f64'],
        ['local.set', `$${ti}`, innerIdx],
        ['local.set', `$${tin}`, innerValid ? ['i32.and', innerValid, ownValid] : ownValid],
        ['select', loadIR, undefExpr(), ['local.get', `$${tin}`]]], 'f64')
      if (ctx.types.indexConsumer) rd.indexValid = ['local.get', `$${tin}`]
      if (!isBigInt) rd.checkedNumRead = true
      return rd
    }
    const objIR = emit(arr), post = postIncI32Index(i)
    const nestedIndex = Array.isArray(i) && i[0] === '[]'
    let vi = post?.value ?? idx(i), indexPre = null, indexValid = nestedIndex ? vi.indexValid : null
    if (!post && indexValid) {
      const ti = tempI32('tbi')
      indexPre = ['local.set', `$${ti}`, vi]
      vi = ['local.get', `$${ti}`]
    }
    const off = ['i32.add', typedDataAddr(objIR, isView), ['i32.shl', vi, ['i32.const', SHIFT[et]]]]
    const value = post ? ['block', ['result', 'f64'], ...post.pre, loadOf(off)]
      : indexPre ? ['block', ['result', 'f64'], indexPre,
          ['if', ['result', 'f64'], indexValid, ['then', loadOf(off)], ['else', undefExpr()]]]
      : loadOf(off)
    if (isBigInt) return typed(value, 'f64')
    // Non-bigint typed elements are plain NUMBERS — tag the load so numeric-arm
    // predicates (isNumArm: `+` dispatch numSide, ?:/?? canon) skip box guards.
    const t = typed(value, 'f64')
    if (indexValid) t.checkedNumRead = true
    else t.valKind = VAL.NUMBER
    return t
  }

  // A store value that can evaluate INSIDE the bounds guard when the assignment
  // is a statement (void): pure reads/arithmetic — including a checked-read
  // if-form and compiler-owned tees (the ${'$'}+T temp namespace; their writes are
  // site-private) — but never calls or writes to user-visible names. Spec-wise
  // the RHS evaluates regardless of bounds; for a PURE value that is
  // unobservable, and dropping the temp+set per site is the -Os win on codec
  // kernels (out[op+k] = pure-int-expr).
  const PURE_STORE_OP = /^(i32|i64|f32|f64)\.(load(8_[su]|16_[su]|32_[su])?|const|add|sub|mul|div(_[su])?|and|or|xor|shl|shr_[su]|rotl|rotr|eqz|eq|ne|[lg][te](_[su])?|clz|ctz|popcnt|convert_i(32|64)_[su]|promote_f32|demote_f64|reinterpret_(i32|i64|f32|f64)|trunc_sat_f(32|64)_[su]|wrap_i64|extend(8|16|32)?_(s|i32_[su])|neg|abs|min|max|sqrt|ceil|floor|trunc|nearest|copysign)$/
  const pureStorable = (n) => {
    if (!Array.isArray(n)) return true
    const op = n[0]
    if (op === 'local.get') return typeof n[1] === 'string'
    if (op === 'local.tee') return typeof n[1] === 'string' && n[1].startsWith('$' + T) && pureStorable(n[2])
    if (op === 'select' || op === 'if' || op === 'block' || op === 'then' || op === 'else' || op === 'result')
      return n.slice(1).every(pureStorable)
    if (PURE_STORE_OP.test(op)) return n.slice(1).every(pureStorable)
    return false
  }

  // Type-aware TypedArray write: arr[i] = val. Same proof gate as the read: proven
  // indexes keep the direct unchecked store byte-identical; unproven ones evaluate
  // the RHS (its effects and the assignment's value are unconditional per spec),
  // then store only when `i u< len` — JS silently IGNORES out-of-bounds typed
  // writes, where the unchecked store corrupted adjacent heap (Root F).
  ctx.core.emit['.typed:[]='] = (arr, i, val, void_ = false) => {
    const r = resolveElem(arr)
    if (r == null) return null
    const { et, isView, isBigInt } = r
    const proven = typedIdxProven(arr, i)
    const nestedIndex = Array.isArray(i) && i[0] === '[]'
    const pre = []
    const post = postIncI32Index(i)
    let vi
    if (!proven) inc('__len')
    if (post) { pre.push(...post.pre); vi = post.value }
    else if (proven) vi = idx(i)
    else {
      const ti = tempI32('tbi'), emittedIdx = idx(i)
      pre.push(['local.set', `$${ti}`, emittedIdx])
      vi = ['local.get', `$${ti}`]
      if (nestedIndex && emittedIdx.indexValid) vi.indexValid = emittedIdx.indexValid
    }
    // Wrap a store statement in the bounds guard on the unproven path. The value
    // temp is set OUTSIDE the guard (spec: RHS evaluates regardless).
    const inheritedValid = vi.indexValid
    const guard = (store) => {
      if (proven && !inheritedValid) return store
      const inRange = proven ? inheritedValid : ['i32.lt_u', vi, leanLen(arr, et, isView)]
      const condition = inheritedValid && !proven ? ['i32.and', inheritedValid, inRange] : inRange
      return ['if', condition, ['then', store]]
    }
    const objIR = emit(arr)
    // Checked typed-array read/modify/write fusion. A statement such as
    // `a[i] = (a[i] + x) | 0` used to emit TWO guards (one for the RHS read,
    // one for the store), two length loads, and duplicate address arithmetic.
    // With a stable bare receiver/index and a side-effect-free i32 RHS, JS's
    // OOB behavior is equivalent to skipping the whole operation: the read's
    // undefined is consumed only by pure arithmetic and the write is ignored.
    // Emit one guard around a direct read + store. The temporary proof is
    // lexical to RHS emission; no other site or later statement inherits it.
    const sameIdx = (n) => Array.isArray(n) && n[0] === '[]' && n[1] === arr && idxKey(arr, n[2]) === idxKey(arr, i)
    const safeRmwAst = (n) => {
      if (!Array.isArray(n)) return true
      if (sameIdx(n)) return true
      const op = n[0]
      if (op === '()' && n.length > 2) {
        const callee = n[1]
        if (!(callee === 'math.imul' ||
            (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Math' && callee[2] === 'imul'))) return false
        return safeRmwAst(n[2])
      }
      if (op === '[]' || op === '.' || op === '?.' || op === 'new' || op === '=>' ||
          op === '++' || op === '--' || ASSIGN_OPS.has(op)) return false
      for (let k = 1; k < n.length; k++) if (!safeRmwAst(n[k])) return false
      return true
    }
    const hasSameRead = (n) => {
      if (!Array.isArray(n)) return false
      if (sameIdx(n)) return true
      for (let k = 1; k < n.length; k++) if (hasSameRead(n[k])) return true
      return false
    }
    const i32Rhs = sameIdx(val) || (Array.isArray(val) &&
      (val[0] === '&' || val[0] === '|' || val[0] === '^' || val[0] === '<<' || val[0] === '>>' || val[0] === '>>>' ||
       (val[0] === '()' && val.length > 2 && (val[1] === 'math.imul' ||
         (Array.isArray(val[1]) && val[1][0] === '.' && val[1][1] === 'Math' && val[1][2] === 'imul')))))
    const rmwKey = typeof arr === 'string' && typeof i === 'string' ? idxKey(arr, i) : null
    const rmwCandidate = !proven && void_ && et <= 5 && !r.isClamped && rmwKey != null &&
      i32Rhs && hasSameRead(val) && safeRmwAst(val)
    let valIR, rmwAddr = null, rmwValue = null
    if (rmwCandidate) {
      rmwAddr = tempI32('tra')
      rmwValue = tempI32('trv')
      const forced = (ctx.types.rmwBounds ??= new Set())
      const reads = (ctx.types.rmwReads ??= new Map())
      forced.add(rmwKey)
      reads.set(rmwKey, rmwValue)
      try { valIR = emit(val) } finally { forced.delete(rmwKey); reads.delete(rmwKey) }
    } else valIR = emit(val)
    const off = ['i32.add', typedDataAddr(objIR, isView), ['i32.shl', vi, ['i32.const', SHIFT[et]]]]
    if (r.isF16 || r.isClamped) {
      // conversion is not a truncation — always through the kernel (RTNE /
      // ToUint8Clamp); the i32Backed shortcut below would store raw low bits
      const vt = temp('tw')
      const conv = elemStoreIR(r, off, ['local.get', `$${vt}`])
      return typed(void_ ? ['block', ...pre,
        ['local.set', `$${vt}`, asF64(valIR)],
        guard(conv)]
        : ['block', ['result', 'f64'], ...pre,
        ['local.set', `$${vt}`, asF64(valIR)],
        guard(conv),
        ['local.get', `$${vt}`]], void_ ? 'void' : 'f64')
    }
    if (isBigInt) {
      if (void_ && (ctx.transform.optFlags & OPTF.leanCheckedIdx) && pureStorable(valIR)) return typed(['block', ...pre,
        guard(['i64.store', off, ['i64.reinterpret_f64', asF64(valIR)]])], 'void')
      const vt = temp('tw')
      return typed(void_ ? ['block', ...pre,
        ['local.set', `$${vt}`, asF64(valIR)],
        guard(['i64.store', off, ['i64.reinterpret_f64', ['local.get', `$${vt}`]]])]
        : ['block', ['result', 'f64'], ...pre,
        ['local.set', `$${vt}`, asF64(valIR)],
        guard(['i64.store', off, ['i64.reinterpret_f64', ['local.get', `$${vt}`]]]),
        ['local.get', `$${vt}`]], void_ ? 'void' : 'f64')
    }
    if (et === 7) { // Float64Array
      // ToNumber on the STORED value (spec: TypedArray stores coerce). Via
      // toNumF64, so a provably-numeric RHS keeps the raw store byte-identical
      // and a checked-read RHS folds its sentinel arm statically — raw sentinel
      // BITS in an f64 slot read back as `undefined` at the boundary where JS
      // stores (and reads back) NaN. The assignment's own VALUE (non-void
      // result) is the RHS pre-coercion per spec, so that path coerces a COPY
      // at the store only (nullish-canon on the temp — no strings can hide in
      // a no-__to_num program, so the sentinel canon IS full ToNumber there).
      const stored = toNumF64(val, valIR)
      if (void_) {
        if ((ctx.transform.optFlags & OPTF.leanCheckedIdx) && pureStorable(stored)) return typed(['block', ...pre,
          guard(['f64.store', off, asF64(stored)])], 'void')
        const vt = temp('tw')
        return typed(['block', ...pre,
          ['local.set', `$${vt}`, asF64(stored)],
          guard(['f64.store', off, ['local.get', `$${vt}`]])], 'void')
      }
      const vt = temp('tw')
      const reread = typed(['local.get', `$${vt}`], 'f64')
      const storeV = stored === valIR ? reread
        : ctx.core.stdlib['__to_num'] ? toNumF64(val, reread)
        : coerceNullishToNum(reread)
      return typed(['block', ['result', 'f64'], ...pre,
        ['local.set', `$${vt}`, asF64(valIR)],
        guard(['f64.store', off, asF64(storeV)]),
        ['local.get', `$${vt}`]], 'f64')
    }
    if (et === 6) {
      if (void_ && (ctx.transform.optFlags & OPTF.leanCheckedIdx) && pureStorable(valIR)) return typed(['block', ...pre,
        guard(['f32.store', off, ['f32.demote_f64', asF64(valIR)]])], 'void')
      const vt = temp('tw')
      return typed(void_ ? ['block', ...pre,
        ['local.set', `$${vt}`, asF64(valIR)],
        guard(['f32.store', off, ['f32.demote_f64', ['local.get', `$${vt}`]]])]
        : ['block', ['result', 'f64'], ...pre,
        ['local.set', `$${vt}`, asF64(valIR)],
        guard(['f32.store', off, ['f32.demote_f64', ['local.get', `$${vt}`]]]),
        ['local.get', `$${vt}`]], void_ ? 'void' : 'f64') // Float32Array
    }
    // Integer store: when the source is already i32-typed (bitwise ops, |0, known-i32 var) —
    // OR an `f64.convert_i32_*` that peels back to i32 (an Int8/Uint8/Int16/… element READ
    // materialized as f64 by the universal value model) — store the i32 low bits directly,
    // skipping the f64 detour that costs a sign branch + i64 trunc + i32 wrap on every write.
    // This eradicates the f64 round-trip on byte/typed-array TRANSFORMS — `out[i] = table[in[j]]`
    // and `dst[i] = src[j]` (base64, qoi, wav, blur) — where both sides are integer elements.
    // `store8/16` mask the low bits, so storing the convert's i32 source is bit-identical; the
    // non-void result reboxes that i32 to f64 (the assignment's RHS value, in element range here).
    // A lean checked READ as the store value (out[op] = src[i] — the codec
    // byte-transform class): ToInt32 composes through it — the hit arm's
    // convert peels to the raw i32 load, the undefined miss arm is NaN → 0.
    // Rebuilding as an i32 if-form keeps the store on the integer path
    // (no f64 round-trip, no temp) — the -Os pairing of the two emitters.
    if (Array.isArray(valIR) && valIR[0] === 'if' &&
        Array.isArray(valIR[1]) && valIR[1][1] === 'f64' &&
        Array.isArray(valIR[3]) && valIR[3][0] === 'then' &&
        Array.isArray(valIR[3][1]) && (valIR[3][1][0] === 'f64.convert_i32_s' || valIR[3][1][0] === 'f64.convert_i32_u') &&
        Array.isArray(valIR[4]) && valIR[4][0] === 'else' &&
        Array.isArray(valIR[4][1]) && valIR[4][1][0] === 'f64.const' && String(valIR[4][1][1]).startsWith('nan:')) {
      valIR = typed(['if', ['result', 'i32'], valIR[2],
        ['then', valIR[3][1][1]],
        ['else', ['i32.const', 0]]], 'i32')
    }
    const i32Backed = valIR.type === 'i32' ||
      (Array.isArray(valIR) && (valIR[0] === 'f64.convert_i32_s' || valIR[0] === 'f64.convert_i32_u'))
    if (i32Backed) {
      const vi32 = asI32(valIR)
      if (rmwCandidate && pureStorable(vi32))
        return typed(['block', ...pre, guard(['block',
          ['local.set', `$${rmwAddr}`, off],
          ['local.set', `$${rmwValue}`, [LOAD[et], ['local.get', `$${rmwAddr}`]]],
          [STORE[et], ['local.get', `$${rmwAddr}`], vi32]])], 'void')
      // lean (-Os) widens "cheap" to any pure value (inline into the guard, no
      // temp); SPEED tiers keep the narrow form — the temp'd store is the shape
      // the SIMD widening/in-place recognizers pattern-match (battery-caught).
      const cheap = (ctx.transform.optFlags & OPTF.leanCheckedIdx) ? pureStorable(vi32)
        : Array.isArray(vi32) &&
          ((vi32[0] === 'local.get' && typeof vi32[1] === 'string') ||
           (vi32[0] === 'i32.const' && (typeof vi32[1] === 'number' || typeof vi32[1] === 'string')))
      if (void_ && cheap && proven) return typed(pre.length
        ? ['block', ...pre, [STORE[et], off, vi32]]
        : [STORE[et], off, vi32], 'void')
      if (void_ && cheap) return typed(['block', ...pre, guard([STORE[et], off, vi32])], 'void')
      const v32 = tempI32('tw')
      return typed(void_ ? ['block', ...pre,
        ['local.set', `$${v32}`, vi32],
        guard([STORE[et], off, ['local.get', `$${v32}`]])]
        : ['block', ['result', 'f64'], ...pre,
        ['local.set', `$${v32}`, vi32],
        guard([STORE[et], off, ['local.get', `$${v32}`]]),
        [(et & 1) ? 'f64.convert_i32_u' : 'f64.convert_i32_s', ['local.get', `$${v32}`]]], void_ ? 'void' : 'f64')
    }
    const vt = temp('tw')
    const i32val = ['i32.wrap_i64',
      ['if', ['result', 'i64'], ['f64.lt', ['local.get', `$${vt}`], ['f64.const', 0]],
        ['then', ['i64.trunc_sat_f64_s', ['local.get', `$${vt}`]]],
        ['else', ['i64.trunc_sat_f64_u', ['local.get', `$${vt}`]]]]]
    return typed(void_ ? ['block', ...pre,
      ['local.set', `$${vt}`, asF64(valIR)],
      guard([STORE[et], off, i32val])]
      : ['block', ['result', 'f64'], ...pre,
      ['local.set', `$${vt}`, asF64(valIR)],
      guard([STORE[et], off, i32val]),
      ['local.get', `$${vt}`]], void_ ? 'void' : 'f64')
  }

  // TypedArray.prototype.set(source, offset = 0). Copies array-like numeric
  // values into the receiver. Falls back to runtime aux-byte dispatch via
  // __typed_set_idx when sibling-scope decls poison the dst's typedElem (e.g.
  // v128const's i-branch ternary `num===16 ? Uint8Array : Uint32Array`
  // hoisted alongside the f-branch's plain `new Uint8Array(16)`).
  ctx.core.emit['.typed:set'] = (arr, src, offset) => {
    const r = resolveElem(arr)
    inc('__len', '__typed_idx')
    if (r == null) inc('__typed_set_idx')
    const srcVal = src === undefined ? undefExpr() : asF64(emit(src))
    const offVal = offset === undefined ? typed(['i32.const', 0], 'i32') : asI32(emit(offset))
    const dst = r ? tempI32('tsd') : temp('tsd')
    const srcTmp = temp('tss'), len = tempI32('tsl'), off = tempI32('tso'), i = tempI32('tsi')
    const idx = ['i32.add', ['local.get', `$${off}`], ['local.get', `$${i}`]]
    const val = typed(['call', '$__typed_idx', ['i64.reinterpret_f64', ['local.get', `$${srcTmp}`]], ['local.get', `$${i}`]], 'f64')
    let store
    if (r) {
      const { et } = r
      const addr = ['i32.add', ['local.get', `$${dst}`], ['i32.shl', idx, ['i32.const', SHIFT[et]]]]
      store = elemStoreIR(r, addr, val)
    } else {
      store = ['drop', ['call', '$__typed_set_idx', ['i64.reinterpret_f64', ['local.get', `$${dst}`]], idx, val]]
    }
    const id = ctx.func.uniq++
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${dst}`, r ? typedDataAddr(emit(arr), r.isView) : asF64(emit(arr))],
      ['local.set', `$${srcTmp}`, srcVal],
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${srcTmp}`]]]],
      ['local.set', `$${off}`, offVal],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$brk${id}`, ['loop', `$loop${id}`,
        ['br_if', `$brk${id}`, ['i32.ge_u', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
        store,
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]],
      undefExpr()], 'f64')
  }

  // .map() on TypedArrays — SIMD auto-vectorization when pattern detected
  ctx.core.emit['.typed:map'] = (arr, fn) => {
    // Resolve element type + view-ness. `resolveElem` handles bare bindings AND
    // chained method receivers (`xs.filter(…).map(…)`) by walking back to the
    // root typedElem-tracked binding.
    const r = resolveElem(arr)
    const elemType = r?.et
    const isView = r?.isView
    const elemName = r?.name

    // BigInt typed arrays: SIMD path doesn't support them; defer to scalar map.
    if (r?.isBigInt) {
      // Fall through to generic .map below — keeps i64-via-NaN-box semantics intact.
      if (ctx.core.emit['.map']) return ctx.core.emit['.map'](arr, fn)
      return null
    }

    // Try SIMD: inline arrow with recognizable pattern (f16/clamped decline —
    // their element conversion is a call, not a lane op)
    if (elemType != null && !r.isF16 && !r.isClamped && Array.isArray(fn) && fn[0] === '=>') {
      const [, rawParam, body] = fn
      const param = Array.isArray(rawParam) && rawParam[0] === '()' ? rawParam[1] : rawParam
      const pattern = analyzeSimd(body, param)

      if (pattern) {
        const id = ctx.func.uniq++
        const funcName = `__simd_map_${id}`
        const wat = genSimdMap(funcName, elemType, pattern)
        if (wat) {
          ctx.core.stdlib[funcName] = wat
          inc(funcName, '__typed_data', '__len')
          return typed(['call', `$${funcName}`, asI64(emit(arr))], 'f64')
        }
      }
    }

    // Scalar fallback: proper typed-array map (preserves element type)
    if (elemType != null) {
      const va = emit(arr), vf = emit(fn)
      const len = tempI32('tml'), ptr = tempI32('tmp'), i = tempI32('tmi')
      const stride = STRIDE[elemType], shift = SHIFT[elemType]
      const dst = allocPtr({ type: PTR.TYPED, aux: typedAux(elemName),
        len: ['i32.shl', ['local.get', `$${len}`], ['i32.const', shift]], stride: 1, tag: 'tmo' })
      const out = dst.local

      const loadElem = () => {
        const off = ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', shift]]]
        return typed(elemLoadIR(r, off), 'f64')
      }
      const storeElem = (val) => {
        const off = ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', shift]]]
        return elemStoreIR(r, off, val)
      }

      const id = ctx.func.uniq++
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${ptr}`, typedDataAddr(va, isView)],
        ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', asF64(va)]]],
        dst.init,
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$brk${id}`, ['loop', `$loop${id}`,
          ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
          storeElem(asF64(ctx.closure.call(vf, [loadElem()]))),
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]],
        dst.ptr], 'f64')
    }

    // Unknown typed array type: fall back to generic array .map
    if (ctx.core.emit['.map']) return ctx.core.emit['.map'](arr, fn)
    return null
  }

  // === Shared typed iteration core ===
  //
  // typedLoop(arr, bodyFn, opts?) emits the common shape every typed iteration
  // method needs: resolve elemType from the receiver's tracked ctor, set up
  // (ptr, len, i) locals, walk i in [0, len), per iteration load arr[i] as f64
  // and pass it to bodyFn. Returns the IR setup statements.
  //
  // bodyFn(loadElem, i, len, ptr, exitLabel) returns IR statements. loadElem is
  // a function (called lazily so it isn't materialized for unused-item paths)
  // returning f64 IR for the current element. `exitLabel` lets the body break
  // out of the loop (e.g. `.find` after a hit, `.some`/`.every` on early
  // resolution). `i`/`len`/`ptr` are i32 local-name strings.
  const typedLoop = (arr, bodyFn) => {
    const r = resolveElem(arr)
    const id = ctx.func.uniq++
    const exit = `$brk${id}`
    const len = tempI32('tll'), i = tempI32('tli')
    // Static fast path: concrete element kind (and non-BigInt-ness) proven at
    // compile time — direct-typed load, no per-element dispatch.
    if (r && !r.isBigInt) {
      const { et, isView } = r
      const va = emit(arr)
      const ptr = tempI32('tlp')
      inc('__len')
      const loadElem = () => {
        const off = ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', SHIFT[et]]]]
        return typed(elemLoadIR(r, off), 'f64')
      }
      const setup = [
        ['local.set', `$${ptr}`, typedDataAddr(asF64(va), isView)],
        ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', asF64(va)]]],
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', exit, ['loop', `$loop${id}`,
          ['br_if', exit, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
          ...bodyFn(loadElem, i, len, ptr, exit),
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]]]
      return { setup, ptr, len, i, exit, et, isView, loadElem }
    }
    // Dynamic fallback: concrete element kind (or BigInt-ness) isn't provable
    // statically — `resolveElem` only tracks a receiver traced back to a bare
    // `new XArray(...)` binding, so a TYPED value that instead flowed through
    // an object field, a return value, or any other opaque path (still proven
    // *some* typed array — that's how it dispatched here at all — just not
    // WHICH one) has no ctor to key off. Read every element through
    // __typed_get_idx: the SAME runtime aux-tag dispatch .reverse/.sort/.fill/
    // .copyWithin already use UNCONDITIONALLY (module/core.js), correct for
    // any concrete kind including BigInt, one indirect call slower per
    // element than the static path above. This used to `return null`, which
    // every caller propagated as "unsupported" up to emitMethodCall — for a
    // receiver already proven VAL.TYPED that either crashed downstream (null
    // IR reaching a consumer) or, if a caller "fell back to the generic array
    // emitter" instead, would misread the typed array's packed native bytes
    // as 8-byte f64 slots (module/array.js's arrayLoop is ARRAY-only) —
    // silent corruption, not a fallback. This is the sound one.
    inc('__typed_get_idx', '__len')
    const av = temp('tla')
    const loadElem = () => typed(['call', '$__typed_get_idx',
      ['i64.reinterpret_f64', ['local.get', `$${av}`]], ['local.get', `$${i}`]], 'f64')
    const setup = [
      ['local.set', `$${av}`, asF64(emit(arr))],
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${av}`]]]],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', exit, ['loop', `$loop${id}`,
        ['br_if', exit, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
        ...bodyFn(loadElem, i, len, null, exit),
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]]]
    return { setup, ptr: null, len, i, exit, et: null, isView: false, loadElem }
  }

  // === Typed iteration emitters ===
  //
  // Each emitter dispatches via the `.typed:method` key on `ctx.core.emit`.
  // emit.js:2211 picks `.typed:<m>` over `.${m}` when the receiver's val type
  // is VAL.TYPED ('typed'), so a user-visible `arr.forEach(...)` on a tracked
  // typed-array binding routes here automatically.
  //
  // Calling convention: callbacks receive (item, idx) — matches array.js
  // (omits the `arr` arg that array-method spec passes; jz keeps the closure
  // ABI width at 2 to spare a slot across the whole program). Reduce passes
  // (acc, item). Closure invocation goes through `ctx.closure.call` directly.
  // The element-type-name list is needed by allocPtr for typedAux:
  const ET_NAME = TYPED_ELEM_NAMES

  // .forEach: callback (item, idx). Result is 0 to match array.js's
  // convention (spec says undefined; both modules pick 0 since f() exposes the
  // result as f64 and NaN-boxed undef reads as NaN).
  // Pre-allocate locals BEFORE typedLoop — bodyFn captures `cbLoc` by closure;
  // TDZ would fire if we declared it after.
  ctx.core.emit['.typed:forEach'] = (arr, fn) => {
    const cbLoc = temp('tfc')
    const loop = typedLoop(arr, (load, i) => [
      ['drop', asF64(ctx.closure.call(
        typed(['local.get', `$${cbLoc}`], 'f64'),
        [load(), typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')]))]
    ])
    if (!loop) return null
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${cbLoc}`, asF64(emit(fn))],
      ...loop.setup,
      ['f64.const', 0]], 'f64')
  }

  // .reduce: callback (acc, item) → acc. Without init, slot 0 seeds acc and
  // the callback skips on iteration 0. Matches JS semantics; the (idx, arr)
  // callback args are dropped (consistent with array.js).
  ctx.core.emit['.typed:reduce'] = (arr, fn, init) => {
    const cbLoc = temp('trc'), acc = temp('trv'), seeded = init !== undefined
    const loop = typedLoop(arr, (load, i) => {
      const step = ['local.set', `$${acc}`, asF64(ctx.closure.call(
        typed(['local.get', `$${cbLoc}`], 'f64'),
        [typed(['local.get', `$${acc}`], 'f64'), load()]))]
      if (seeded) return [step]
      // Unseeded: iteration 0 just stashes the value into acc.
      return [
        ['if', ['i32.eqz', ['local.get', `$${i}`]],
          ['then', ['local.set', `$${acc}`, load()]],
          ['else', step]]]
    })
    if (!loop) return null
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${cbLoc}`, asF64(emit(fn))],
      ['local.set', `$${acc}`, seeded ? asF64(emit(init)) : undefExpr()],
      ...loop.setup,
      ['local.get', `$${acc}`]], 'f64')
  }

  // .indexOf: scalar value-equality search. Returns -1 on miss. Compare on f64
  // — Array.prototype.indexOf uses strict equality (NaN ≠ NaN).
  // Effective start index for a fromIndex arg: negative counts from the end. The match
  // guard is `i >= start` and i ≥ 0, so a start below 0 needs no clamp (always passes).
  const fromStart = (fiL, len) => ['if', ['result', 'i32'],
    ['i32.lt_s', ['local.get', `$${fiL}`], ['i32.const', 0]],
    ['then', ['i32.add', ['local.get', `$${fiL}`], ['local.get', `$${len}`]]],
    ['else', ['local.get', `$${fiL}`]]]

  ctx.core.emit['.typed:indexOf'] = (arr, val, fromIndex) => {
    const found = tempI32('tif'), needle = temp('tin'), fiL = tempI32('tifx')
    const loop = typedLoop(arr, (load, i, len, _ptr, exit) => {
      const matched = ['f64.eq', load(), ['local.get', `$${needle}`]]
      const cond = fromIndex == null ? matched
        : ['i32.and', ['i32.ge_s', ['local.get', `$${i}`], fromStart(fiL, len)], matched]
      return [['if', cond, ['then',
        ['local.set', `$${found}`, ['local.get', `$${i}`]], ['br', exit]]]]
    })
    if (!loop) return null
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${needle}`, asF64(emit(val))],
      ['local.set', `$${found}`, ['i32.const', -1]],
      ...(fromIndex == null ? [] : [['local.set', `$${fiL}`, asI32(emit(fromIndex))]]),
      ...loop.setup,
      ['f64.convert_i32_s', ['local.get', `$${found}`]]], 'f64')
  }

  // .lastIndexOf(val): the last index whose element strictly-equals val, else -1.
  // Was unimplemented for typed arrays (threw). A forward scan that keeps the latest
  // match needs no reverse iteration — equivalent for the no-fromIndex form, which is
  // the common case. With a fromIndex the matcher additionally bounds i ≤ fromIndex
  // (negative counts from the end, resolved against the typedLoop len). NaN never
  // strict-equals (f64.eq), matching JS.
  ctx.core.emit['.typed:lastIndexOf'] = (arr, val, fromIndex) => {
    const found = tempI32('tlf'), needle = temp('tln'), fiL = tempI32('tlfi')
    const loop = typedLoop(arr, (load, i, len) => {
      const matched = ['f64.eq', load(), ['local.get', `$${needle}`]]
      if (fromIndex == null)
        return [['if', matched, ['then', ['local.set', `$${found}`, ['local.get', `$${i}`]]]]]
      const lim = ['if', ['result', 'i32'], ['i32.lt_s', ['local.get', `$${fiL}`], ['i32.const', 0]],
        ['then', ['i32.add', ['local.get', `$${fiL}`], ['local.get', `$${len}`]]],
        ['else', ['local.get', `$${fiL}`]]]
      return [['if', ['i32.and', ['i32.le_s', ['local.get', `$${i}`], lim], matched],
        ['then', ['local.set', `$${found}`, ['local.get', `$${i}`]]]]]
    })
    if (!loop) return null
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${needle}`, asF64(emit(val))],
      ['local.set', `$${found}`, ['i32.const', -1]],
      ...(fromIndex == null ? [] : [['local.set', `$${fiL}`, asI32(emit(fromIndex))]]),
      ...loop.setup,
      ['f64.convert_i32_s', ['local.get', `$${found}`]]], 'f64')
  }

  // .includes: like indexOf but NaN-equal-NaN (JS spec). Stash needle bits as
  // i64 and compare via i64.eq so two NaNs with matching bit patterns match
  // (f64.eq would say false).
  ctx.core.emit['.typed:includes'] = (arr, val, fromIndex) => {
    const found = tempI32('thf'), needle = temp('thn'), fiL = tempI32('thx')
    const loop = typedLoop(arr, (load, i, len, _ptr, exit) => {
      const matched = ['i32.or',
        ['f64.eq', load(), ['local.get', `$${needle}`]],
        ['i64.eq',
          ['i64.reinterpret_f64', load()],
          ['i64.reinterpret_f64', ['local.get', `$${needle}`]]]]
      const cond = fromIndex == null ? matched
        : ['i32.and', ['i32.ge_s', ['local.get', `$${i}`], fromStart(fiL, len)], matched]
      return [['if', cond, ['then', ['local.set', `$${found}`, ['i32.const', 1]], ['br', exit]]]]
    })
    if (!loop) return null
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${needle}`, asF64(emit(val))],
      ['local.set', `$${found}`, ['i32.const', 0]],
      ...(fromIndex == null ? [] : [['local.set', `$${fiL}`, asI32(emit(fromIndex))]]),
      ...loop.setup,
      ['f64.convert_i32_s', ['local.get', `$${found}`]]], 'f64')
  }

  // .find / .findIndex: linear scan, first truthy callback wins. Miss returns
  // undefined / -1 respectively.
  const findCommon = (arr, fn, returnIndex) => {
    const cbLoc = temp('tfc'), result = temp('tfr'), foundIdx = tempI32('tfi')
    const loop = typedLoop(arr, (load, i, _len, _ptr, exit) => {
      const itemLoc = temp('tfit')
      return [
        ['local.set', `$${itemLoc}`, load()],
        ['if', truthyIR(ctx.closure.call(
          typed(['local.get', `$${cbLoc}`], 'f64'),
          [typed(['local.get', `$${itemLoc}`], 'f64'),
           typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')])),
          ['then',
            returnIndex
              ? ['local.set', `$${foundIdx}`, ['local.get', `$${i}`]]
              : ['local.set', `$${result}`, typed(['local.get', `$${itemLoc}`], 'f64')],
            ['br', exit]]]
      ]
    })
    if (!loop) return null
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${cbLoc}`, asF64(emit(fn))],
      returnIndex
        ? ['local.set', `$${foundIdx}`, ['i32.const', -1]]
        : ['local.set', `$${result}`, undefExpr()],
      ...loop.setup,
      returnIndex
        ? typed(['f64.convert_i32_s', ['local.get', `$${foundIdx}`]], 'f64')
        : typed(['local.get', `$${result}`], 'f64')], 'f64')
  }
  ctx.core.emit['.typed:find'] = (arr, fn) => findCommon(arr, fn, false)
  ctx.core.emit['.typed:findIndex'] = (arr, fn) => findCommon(arr, fn, true)

  // .findLast / .findLastIndex — like find/findIndex but keep the LAST match instead of
  // the first, so no early break (a forward scan that overwrites on each hit). Without a
  // typed handler these routed through the plain-array versions, which read elements as
  // raw f64 and returned garbage for non-f64 typed arrays.
  const findLastCommon = (arr, fn, returnIndex) => {
    const cbLoc = temp('tLc'), result = temp('tLr'), foundIdx = tempI32('tLi')
    const loop = typedLoop(arr, (load, i) => {
      const itemLoc = temp('tLit')
      return [
        ['local.set', `$${itemLoc}`, load()],
        ['if', truthyIR(ctx.closure.call(
          typed(['local.get', `$${cbLoc}`], 'f64'),
          [typed(['local.get', `$${itemLoc}`], 'f64'),
           typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')])),
          ['then',
            returnIndex
              ? ['local.set', `$${foundIdx}`, ['local.get', `$${i}`]]
              : ['local.set', `$${result}`, typed(['local.get', `$${itemLoc}`], 'f64')]]]
      ]
    })
    if (!loop) return null
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${cbLoc}`, asF64(emit(fn))],
      returnIndex
        ? ['local.set', `$${foundIdx}`, ['i32.const', -1]]
        : ['local.set', `$${result}`, undefExpr()],
      ...loop.setup,
      returnIndex
        ? typed(['f64.convert_i32_s', ['local.get', `$${foundIdx}`]], 'f64')
        : typed(['local.get', `$${result}`], 'f64')], 'f64')
  }
  ctx.core.emit['.typed:findLast'] = (arr, fn) => findLastCommon(arr, fn, false)
  ctx.core.emit['.typed:findLastIndex'] = (arr, fn) => findLastCommon(arr, fn, true)

  // .some / .every: short-circuit boolean reduction. some=∃, every=∀.
  const anyAllCommon = (arr, fn, isEvery) => {
    const cbLoc = temp('tac'), result = tempI32('tar')
    const loop = typedLoop(arr, (load, i, _len, _ptr, exit) => {
      const test = truthyIR(ctx.closure.call(
        typed(['local.get', `$${cbLoc}`], 'f64'),
        [load(), typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')]))
      // every: exit on falsy with result=0. some: exit on truthy with result=1.
      return [
        ['if', isEvery ? ['i32.eqz', test] : test,
          ['then', ['local.set', `$${result}`, ['i32.const', isEvery ? 0 : 1]], ['br', exit]]]
      ]
    })
    if (!loop) return null
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${cbLoc}`, asF64(emit(fn))],
      ['local.set', `$${result}`, ['i32.const', isEvery ? 1 : 0]],
      ...loop.setup,
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }
  ctx.core.emit['.typed:some'] = (arr, fn) => anyAllCommon(arr, fn, false)
  ctx.core.emit['.typed:every'] = (arr, fn) => anyAllCommon(arr, fn, true)

  // .filter: produces a TYPED array of the same element type. Allocates worst-
  // case (len slots) then patches the byte-count header at the end with the
  // actual passed count. Mirrors .filter in array.js but with typed-aware
  // load/store.
  ctx.core.emit['.typed:filter'] = (arr, fn) => {
    const r = resolveElem(arr)
    if (!r || r.isBigInt) return null
    const { et, isView } = r
    const cbLoc = temp('tfc'), arrLoc = temp('tfa')
    const count = tempI32('tfn'), maxLen = tempI32('tfm')
    const srcPtr = tempI32('tfsp'), srcLen = tempI32('tfsl'), srci = tempI32('tfi')
    inc('__len')
    const loadAt = (ptrLoc, iLoc) => {
      const off = ['i32.add', ['local.get', `$${ptrLoc}`], ['i32.shl', ['local.get', `$${iLoc}`], ['i32.const', SHIFT[et]]]]
      return typed(elemLoadIR(r, off), 'f64')
    }
    const storeAt = (ptrLoc, iLoc, valF64) => {
      const off = ['i32.add', ['local.get', `$${ptrLoc}`], ['i32.shl', ['local.get', `$${iLoc}`], ['i32.const', SHIFT[et]]]]
      return elemStoreIR(r, off, valF64)
    }
    const dst = allocPtr({ type: PTR.TYPED, aux: typedAux(r.name || ET_NAME[et]),
      len: ['i32.shl', ['local.get', `$${maxLen}`], ['i32.const', SHIFT[et]]],
      stride: 1, tag: 'tfd' })
    const id = ctx.func.uniq++
    const passes = truthyIR(ctx.closure.call(
      typed(['local.get', `$${cbLoc}`], 'f64'),
      [loadAt(srcPtr, srci), typed(['f64.convert_i32_s', ['local.get', `$${srci}`]], 'f64')]))
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${cbLoc}`, asF64(emit(fn))],
      ['local.set', `$${arrLoc}`, asF64(emit(arr))],
      ['local.set', `$${srcPtr}`, typedDataAddr(typed(['local.get', `$${arrLoc}`], 'f64'), isView)],
      ['local.set', `$${srcLen}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${arrLoc}`]]]],
      ['local.set', `$${maxLen}`, ['local.get', `$${srcLen}`]],
      dst.init,
      ['local.set', `$${count}`, ['i32.const', 0]],
      ['local.set', `$${srci}`, ['i32.const', 0]],
      ['block', `$brk${id}`, ['loop', `$loop${id}`,
        ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${srci}`], ['local.get', `$${srcLen}`]]],
        ['if', passes,
          ['then',
            storeAt(dst.local, count, loadAt(srcPtr, srci)),
            ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]],
        ['local.set', `$${srci}`, ['i32.add', ['local.get', `$${srci}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]],
      // Patch byte-count header — __len reads from -8 then __typed_shift's by
      // the typed-elem stride, so we store `count * stride` bytes here.
      ['i32.store', ['i32.sub', ['local.get', `$${dst.local}`], ['i32.const', 8]],
        ['i32.shl', ['local.get', `$${count}`], ['i32.const', SHIFT[et]]]],
      dst.ptr], 'f64')
  }

  // .slice(start, end): produces TYPED array of same element type. Mirrors JS
  // semantics — negative indices wrap from end, out-of-range clamps to len.
  // Bulk copy via `memory.copy`.
  ctx.core.emit['.typed:slice'] = (arr, start, end) => {
    const r = resolveElem(arr)
    if (!r) {
      // Elem type / view-ness not statically known (owned→view reassigned binding).
      // Dispatch off the runtime aux byte instead of crashing on empty IR.
      inc('__typed_slice_rt')
      return typed(['call', '$__typed_slice_rt',
        ['i64.reinterpret_f64', asF64(emit(arr))],
        start == null ? ['i32.const', 0] : asI32(emit(start)),
        end == null ? ['i32.const', 0] : asI32(emit(end)),
        ['i32.const', end == null ? 0 : 1]], 'f64')
    }
    if (r.isBigInt) return null
    const { et, isView } = r
    const arrLoc = temp('tsa'), srcPtr = tempI32('tssp'), srcLen = tempI32('tssl')
    const lo = tempI32('tslo'), hi = tempI32('tshi'), n = tempI32('tsn')
    inc('__len')
    // ECMAScript ToInteger + clamp: idx := bound; idx := idx<0 ? max(0,idx+len) : min(len,idx).
    // Select-based to dodge nested if-arity rules.
    // defaultExpr: when boundExpr is omitted (e.g. arr.slice() / arr.slice(2)),
    // start defaults to 0 and end defaults to len.
    const clamp = (boundExpr, fallback, defaultExpr) => {
      if (boundExpr == null) return defaultExpr
      const idx = tempI32(fallback)
      return ['block', ['result', 'i32'],
        ['local.set', `$${idx}`, asI32(emit(boundExpr))],
        ['select',
          // negative branch: max(0, idx + len)
          ['select',
            ['i32.add', ['local.get', `$${idx}`], ['local.get', `$${srcLen}`]],
            ['i32.const', 0],
            ['i32.gt_s', ['i32.add', ['local.get', `$${idx}`], ['local.get', `$${srcLen}`]], ['i32.const', 0]]],
          // non-negative branch: min(len, idx)
          ['select',
            ['local.get', `$${srcLen}`],
            ['local.get', `$${idx}`],
            ['i32.gt_s', ['local.get', `$${idx}`], ['local.get', `$${srcLen}`]]],
          ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]]]]
    }
    const dst = allocPtr({ type: PTR.TYPED, aux: typedAux(r.name || ET_NAME[et]),
      len: ['i32.shl', ['local.get', `$${n}`], ['i32.const', SHIFT[et]]],
      stride: 1, tag: 'tsd' })
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${arrLoc}`, asF64(emit(arr))],
      ['local.set', `$${srcPtr}`, typedDataAddr(typed(['local.get', `$${arrLoc}`], 'f64'), isView)],
      ['local.set', `$${srcLen}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${arrLoc}`]]]],
      ['local.set', `$${lo}`, clamp(start, 'tslo2', ['i32.const', 0])],
      ['local.set', `$${hi}`, clamp(end, 'tshi2', ['local.get', `$${srcLen}`])],
      ['local.set', `$${n}`,
        ['select',
          ['i32.sub', ['local.get', `$${hi}`], ['local.get', `$${lo}`]],
          ['i32.const', 0],
          ['i32.gt_s', ['local.get', `$${hi}`], ['local.get', `$${lo}`]]]],
      dst.init,
      // memory.copy dst, src+lo*stride, n*stride
      ['memory.copy',
        ['local.get', `$${dst.local}`],
        ['i32.add', ['local.get', `$${srcPtr}`], ['i32.shl', ['local.get', `$${lo}`], ['i32.const', SHIFT[et]]]],
        ['i32.shl', ['local.get', `$${n}`], ['i32.const', SHIFT[et]]]],
      dst.ptr], 'f64')
  }

  // .toReversed() — a reversed COPY (receiver unchanged): full slice-copy, then reverse
  // the copy in place. (slice bails on BigInt, so BigInt receivers fall back to a throw.)
  ctx.core.emit['.typed:toReversed'] = (arr) => {
    const copy = ctx.core.emit['.typed:slice'](arr)
    if (!copy) return null
    inc('__typed_reverse')
    const c = temp('ttv')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${c}`, asF64(copy)],
      ['call', '$__typed_reverse', ['i64.reinterpret_f64', ['local.get', `$${c}`]]]], 'f64')
  }

  // .toSorted(fn?) — a sorted COPY (receiver unchanged): slice-copy, then sort in place.
  ctx.core.emit['.typed:toSorted'] = (arr, fn) => {
    const copy = ctx.core.emit['.typed:slice'](arr)
    return copy ? emitTypedSort(copy, fn) : null
  }

  // .with(index, value) — a COPY with one element replaced (receiver unchanged). Negative
  // index counts from the end; out of range throws RangeError ($__jz_err), per spec.
  ctx.core.emit['.typed:with'] = (arr, index, value) => {
    const copy = ctx.core.emit['.typed:slice'](arr)
    if (!copy) return null
    ctx.runtime.throws = true
    inc('__len', '__typed_set_idx')
    const c = temp('twc'), idx = tempI32('twi'), len = tempI32('twl')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${c}`, asF64(copy)],
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${c}`]]]],
      ['local.set', `$${idx}`, asI32(emit(index))],
      ['if', ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]],
        ['then', ['local.set', `$${idx}`, ['i32.add', ['local.get', `$${idx}`], ['local.get', `$${len}`]]]]],
      ['if', ['i32.or',
          ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]],
          ['i32.ge_s', ['local.get', `$${idx}`], ['local.get', `$${len}`]]],
        ['then', ['throw', '$__jz_err', ['f64.const', 0]]]],
      ['drop', ['call', '$__typed_set_idx', ['i64.reinterpret_f64', ['local.get', `$${c}`]],
        ['local.get', `$${idx}`], asF64(emit(value))]],
      ['local.get', `$${c}`]], 'f64')
  }

  // .subarray(begin, end) — a zero-copy VIEW sharing the receiver's buffer (writes alias,
  // NOT a copy). Builds the 16-byte descriptor [byteLen][dataOff][parentOff] and tags the
  // TYPED ptr with aux|view, exactly like new TypedArray(buffer, byteOffset, length).
  ctx.core.emit['.typed:subarray'] = (arr, begin, end) => {
    ctx.features.typedView = true  // zero-copy view aliases the receiver — covers inline `a.subarray(1)[i]=…` the bound-decl path in analyze.js misses
    const r = resolveElem(arr)
    if (!r) {
      // Elem type / view-ness not statically known (owned→view reassigned binding).
      // Dispatch off the runtime aux byte instead of crashing on empty IR.
      inc('__subarray')
      return typed(['call', '$__subarray',
        ['i64.reinterpret_f64', asF64(emit(arr))],
        begin == null ? ['i32.const', 0] : asI32(emit(begin)),
        end == null ? ['i32.const', 0] : asI32(emit(end)),
        ['i32.const', end == null ? 0 : 1]], 'f64')
    }
    const { et, isView, isBigInt } = r
    const shift = SHIFT[et]
    const viewAux = et | 8 | (isBigInt ? 16 : 0)
    const arrL = temp('tua'), srcOff = tempI32('tuo'), data = tempI32('tud'), root = tempI32('tur')
    const len = tempI32('tul'), lo = tempI32('tulo'), hi = tempI32('tuhi'), n = tempI32('tun'), desc = tempI32('tude')
    inc('__len')
    const off4 = (o) => ['i32.load', ['i32.add', ['local.get', `$${srcOff}`], ['i32.const', o]]]
    const clamp = (boundExpr, dflt, name) => {
      if (boundExpr == null) return dflt
      const v = tempI32(name)
      return ['block', ['result', 'i32'],
        ['local.set', `$${v}`, asI32(emit(boundExpr))],
        ['if', ['i32.lt_s', ['local.get', `$${v}`], ['i32.const', 0]],
          ['then', ['local.set', `$${v}`, ['i32.add', ['local.get', `$${v}`], ['local.get', `$${len}`]]]]],
        ['if', ['i32.lt_s', ['local.get', `$${v}`], ['i32.const', 0]],
          ['then', ['local.set', `$${v}`, ['i32.const', 0]]]],
        ['if', ['i32.gt_s', ['local.get', `$${v}`], ['local.get', `$${len}`]],
          ['then', ['local.set', `$${v}`, ['local.get', `$${len}`]]]],
        ['local.get', `$${v}`]]
    }
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${arrL}`, asF64(emit(arr))],
      ['local.set', `$${srcOff}`, typedBase(typed(['local.get', `$${arrL}`], 'f64'))],
      ['local.set', `$${data}`, isView ? off4(4) : ['local.get', `$${srcOff}`]],
      ['local.set', `$${root}`, isView ? off4(8) : ['local.get', `$${srcOff}`]],
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${arrL}`]]]],
      ['local.set', `$${lo}`, clamp(begin, ['i32.const', 0], 'tub')],
      ['local.set', `$${hi}`, clamp(end, ['local.get', `$${len}`], 'tue')],
      ['local.set', `$${n}`, ['select',
        ['i32.sub', ['local.get', `$${hi}`], ['local.get', `$${lo}`]], ['i32.const', 0],
        ['i32.gt_s', ['local.get', `$${hi}`], ['local.get', `$${lo}`]]]],
      ['local.set', `$${desc}`, ['call', '$__alloc', ['i32.const', 16]]],
      ['i32.store', ['local.get', `$${desc}`], ['i32.shl', ['local.get', `$${n}`], ['i32.const', shift]]],
      ['i32.store', ['i32.add', ['local.get', `$${desc}`], ['i32.const', 4]],
        ['i32.add', ['local.get', `$${data}`], ['i32.shl', ['local.get', `$${lo}`], ['i32.const', shift]]]],
      ['i32.store', ['i32.add', ['local.get', `$${desc}`], ['i32.const', 8]], ['local.get', `$${root}`]],
      mkPtrIR(PTR.TYPED, viewAux, ['local.get', `$${desc}`])], 'f64')
  }

  // === ES2026 Uint8Array base64/hex codecs ===
  // Kernels live in module/string.js (byte↔text is string domain); these
  // emitters wire the typed-array surface: u8.toBase64()/toHex()/setFrom*()
  // and the Uint8Array.fromBase64/fromHex statics. Options are compile-time
  // literals (jz doctrine: no per-call option-bag parsing) — alphabet
  // 'base64'|'base64url', omitPadding, and lastChunkHandling:'loose' (the
  // default; other modes are rejected with a clean error).
  const codecOpts = (node, method, allowPad) => {
    let url = 0, pad = 1
    if (node === undefined) return { url, pad }
    if (!Array.isArray(node) || (node[0] !== '{' && node[0] !== '{}'))
      err(`${method} options must be a literal object — jz resolves codec options at compile time`)
    // prepared literals arrive as ['{}'|'{', ...entries] (entries may also ride
    // a single ','/';' wrapper node)
    const entries = node.length === 2 && Array.isArray(node[1]) && (node[1][0] === ',' || node[1][0] === ';')
      ? node[1].slice(1) : node.slice(1).filter(e => e != null)
    const lit = (v) => Array.isArray(v) && v[0] === 'str' ? v[1]
      : Array.isArray(v) && v[0] === 'bool' ? !!v[1]
      : Array.isArray(v) && v[0] == null ? v[1] : undefined
    for (const it of entries) {
      if (!Array.isArray(it) || it[0] !== ':') err(`${method} options must use literal keys and values`)
      const k = typeof it[1] === 'string' ? it[1] : Array.isArray(it[1]) && it[1][0] === 'str' ? it[1][1] : null
      const v = lit(it[2])
      if (k === 'alphabet') {
        if (v === 'base64url') url = 1
        else if (v !== 'base64') err(`${method}: unknown alphabet ${JSON.stringify(v)} — 'base64' or 'base64url'`)
      } else if (k === 'omitPadding' && allowPad) pad = v ? 0 : 1
      else if (k === 'lastChunkHandling') {
        if (v !== 'loose') err(`${method}: only lastChunkHandling:'loose' (the default) is supported`)
      } else err(`${method}: unsupported option '${k}'`)
    }
    return { url, pad }
  }

  // {read, written} result record for setFromBase64/setFromHex — a one-shot
  // dictionary (HASH) object, same shape TextEncoder.encodeInto returns.
  const readWrittenHash = (rwIR) => {
    inc('__hash_new', '__hash_set')
    const rw = tempI64('sfrw'), h = temp('sfh')
    const hI64 = ['i64.reinterpret_f64', ['local.get', `$${h}`]]
    const field = (hi) => ['i64.reinterpret_f64', ['f64.convert_i32_s',
      ['i32.wrap_i64', hi ? ['i64.shr_u', ['local.get', `$${rw}`], ['i64.const', 32]] : ['local.get', `$${rw}`]]]]
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${rw}`, rwIR],
      ['local.set', `$${h}`, ['call', '$__hash_new']],
      ['local.set', `$${h}`, ['f64.reinterpret_i64',
        ['call', '$__hash_set', hI64, asI64(emit(['str', 'read'])), field(true)]]],
      ['local.set', `$${h}`, ['f64.reinterpret_i64',
        ['call', '$__hash_set', hI64, asI64(emit(['str', 'written'])), field(false)]]],
      ['local.get', `$${h}`]], 'f64')
  }

  const emitToBase64 = (arr, opts) => {
    const { url, pad } = codecOpts(opts, 'toBase64', true)
    ctx.runtime.throws = true
    inc('__u8_data', '__b64_enc', '__len')
    const t = temp('tb64')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(arr))],
      ['call', '$__b64_enc',
        ['call', '$__u8_data', ['i64.reinterpret_f64', ['local.get', `$${t}`]]],
        ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]],
        ['i32.const', url], ['i32.const', pad]]], 'f64')
  }
  ctx.core.emit['.typed:toBase64'] = ctx.core.emit['.toBase64'] = emitToBase64

  const emitToHex = (arr) => {
    ctx.runtime.throws = true
    inc('__u8_data', '__hex_enc', '__len')
    const t = temp('thex')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(arr))],
      ['call', '$__hex_enc',
        ['call', '$__u8_data', ['i64.reinterpret_f64', ['local.get', `$${t}`]]],
        ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]], 'f64')
  }
  ctx.core.emit['.typed:toHex'] = ctx.core.emit['.toHex'] = emitToHex

  const emitSetFromBase64 = (arr, str, opts) => {
    const { url } = codecOpts(opts, 'setFromBase64', false)
    ctx.runtime.throws = true
    inc('__b64_set')
    return readWrittenHash(['call', '$__b64_set', asI64(emit(arr)), asI64(emit(str)), ['i32.const', url]])
  }
  ctx.core.emit['.typed:setFromBase64'] = ctx.core.emit['.setFromBase64'] = emitSetFromBase64

  const emitSetFromHex = (arr, str) => {
    ctx.runtime.throws = true
    inc('__hex_set')
    return readWrittenHash(['call', '$__hex_set', asI64(emit(arr)), asI64(emit(str))])
  }
  ctx.core.emit['.typed:setFromHex'] = ctx.core.emit['.setFromHex'] = emitSetFromHex

  ctx.core.emit['Uint8Array.fromBase64'] = (str, opts) => {
    const { url } = codecOpts(opts, 'fromBase64', false)
    ctx.runtime.throws = true
    ctx.features.typedarray = true
    inc('__b64_from')
    return typed(['call', '$__b64_from', asI64(emit(str)), ['i32.const', url]], 'f64')
  }

  ctx.core.emit['Uint8Array.fromHex'] = (str) => {
    ctx.runtime.throws = true
    ctx.features.typedarray = true
    inc('__hex_from')
    return typed(['call', '$__hex_from', asI64(emit(str))], 'f64')
  }
}
