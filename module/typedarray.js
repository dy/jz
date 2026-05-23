/**
 * TypedArray module — Float64Array, Float32Array, Int32Array, etc.
 * SIMD auto-vectorization for .map() on recognized patterns.
 *
 * Type=3 (TYPED): aux=elemType (3 bits), length in memory header [-8:len][-4:cap].
 *
 * @module typed
 */

import { typed, asF64, asI32, asI64, toNumF64, UNDEF_NAN, allocPtr, mkPtrIR, ptrOffsetIR, temp, tempI32, tempI64, undefExpr, truthyIR } from '../src/ir.js'
import { emit, idx, deps, call } from '../src/bridge.js'
import { valTypeOf } from '../src/val-type.js'
import { TYPED_ELEM_NAMES, TYPED_ELEM_CODE, TYPED_ELEM_BIGINT_FLAG, encodeTypedElemAux } from '../src/typed.js'
import { VAL, lookupValType } from '../src/reps.js'
import { nanPrefixHex } from '../layout.js'
import { inc, PTR } from '../src/ctx.js'

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
    __typed_set_idx: ['__ptr_aux', '__ptr_offset'],
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

  // Constructor: new Float64Array(len) | new F64Array(arr) | new F64Array(buf) | new F64Array(buf, off, len)
  for (const [name, elemType] of Object.entries(TYPED_ELEM_CODE)) {
    const aux = typedAux(name)
    const stride = STRIDE[elemType]
    ctx.core.emit[`new.${name}`] = (lenExpr, offsetExpr, lenExpr2) => {
      ctx.features.typedarray = true
      const srcType = typeof lenExpr === 'string' ? lookupValType(lenExpr) : valTypeOf(lenExpr)
      // Subview: new TypedArray(buffer, byteOffset, length) — true JS-parity view.
      // Allocates a 16-byte descriptor [byteLen:i32][dataOff:i32][parentOff:i32][pad]
      // and tags the TYPED ptr with aux=elemType|8. Reads/writes alias the parent,
      // .buffer reconstructs the root BUFFER, .byteOffset = dataOff - parentOff.
      if (offsetExpr != null && lenExpr2 != null) {
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
      // Single arg array-like source: copy elements instead of treating the pointer as a length.
      if (srcType === VAL.ARRAY && ctx.core.emit[`${name}.from`])
        return ctx.core.emit[`${name}.from`](lenExpr)
      // Reinterpret on a buffer or another typed array: zero-copy view.
      // TYPED retagged at the same offset — the byteLen header is shared with the parent.
      // __len(view) = byteLen >> shift computes elemCount for this view's elemType.
      if (srcType === VAL.BUFFER || srcType === VAL.TYPED) {
        return mkPtrIR(PTR.TYPED, aux, ['call', '$__ptr_offset', ['i64.reinterpret_f64', asF64(emit(lenExpr))]])
      }
      if (srcType == null && ctx.core.emit[`${name}.from`]) {
        // Runtime dispatch: number → allocate; array → copy elements; buffer/typed → zero-copy view.
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
            // Pointer: array → copy elements; buffer/typed → zero-copy view on same offset
            ['else', ['if', ['result', 'f64'],
              ['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${src}`]]], ['i32.const', PTR.ARRAY]],
              ['then', ctx.core.emit[`${name}.from`](src)],
              ['else', mkPtrIR(PTR.TYPED, aux,
                ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${src}`]]])]]]]], 'f64')
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
  ctx.core.emit['.buffer'] = (obj) => {
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
    return buf(obj)
  }

  // .byteLength — BUFFER: raw __len. Owned TYPED: elemCount * stride.
  // View TYPED (incl. DataView): descriptor[0], via the __byte_length fallback.
  ctx.core.emit['.byteLength'] = (obj) => {
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
    return blen(obj)
  }

  // .byteOffset — owned: 0. View: descriptor[4] - descriptor[8].
  ctx.core.emit['.byteOffset'] = (obj) => {
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
    return boff(obj)
  }

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
    return typed(['f64.convert_i32_s',
      ['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', va]], ['i32.const', PTR.TYPED]]], 'f64')
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
      ['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]], ['i32.const', PTR.TYPED]]], 'i32')
  }

  // buf.slice(begin?, end?) on a BUFFER → fresh BUFFER with the byte range copied.
  // Only dispatches statically when obj is a tracked ArrayBuffer/DataView variable.
  ctx.core.emit['.buf:slice'] = (obj, beginExpr, endExpr) => {
    const src = temp('bss')
    const beg = tempI32('bsb')
    const end = tempI32('bse')
    const bytes = tempI32('bsn')
    const out = allocPtr({ type: PTR.BUFFER, len: ['local.get', `$${bytes}`], stride: 1, tag: 'bsd' })
    const beginWat = beginExpr == null ? ['i32.const', 0] : asI32(emit(beginExpr))
    const endWat = endExpr == null
      ? ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${src}`]]]
      : asI32(emit(endExpr))
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${src}`, asF64(emit(obj))],
      ['local.set', `$${beg}`, beginWat],
      ['local.set', `$${end}`, endWat],
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
  const canonNaN = (vIR) => { inc('__canon_nan'); return typed(['call', '$__canon_nan', vIR], 'f64') }

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
    return typed(['block', ['result', 'i32'],
      ['local.set', `$${idxT}`, dvIndex(offNode)],
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

  // TypedArray.from(arr) — convert regular array to typed array
  for (const [name, elemType] of Object.entries(TYPED_ELEM_CODE)) {
    const aux = typedAux(name)
    const stride = STRIDE[elemType], store = STORE[elemType]
    ctx.core.emit[`${name}.from`] = (src) => {
      ctx.features.typedarray = true
      const srcL = temp('tfs')
      const len = tempI32('tfl'), i = tempI32('tfi'), off = tempI32('tfo')
      const out = allocPtr({ type: PTR.TYPED, aux,
        len: ['i32.mul', ['local.get', `$${len}`], ['i32.const', stride]], stride: 1, tag: 'tf' })
      const t = out.local
      const id = ctx.func.uniq++
      const storeExpr = elemType === 7 ? ['f64.store',
          ['i32.add', ['local.get', `$${t}`], ['i32.mul', ['local.get', `$${i}`], ['i32.const', stride]]],
          ['f64.load', ['i32.add', ['local.get', `$${off}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]]
        : elemType === 6 ? ['f32.store',
          ['i32.add', ['local.get', `$${t}`], ['i32.mul', ['local.get', `$${i}`], ['i32.const', stride]]],
          ['f32.demote_f64', ['f64.load', ['i32.add', ['local.get', `$${off}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]]]
        : [store,
          ['i32.add', ['local.get', `$${t}`], ['i32.mul', ['local.get', `$${i}`], ['i32.const', stride]]],
          [(elemType & 1) ? 'i32.trunc_f64_u' : 'i32.trunc_f64_s',
            ['f64.load', ['i32.add', ['local.get', `$${off}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]]]
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
    let receiver = arr, chainOutput = false
    // Walk method-call chain inward. `arr.method(...)` parses as
    // ['()', ['.', recv, 'method'], ...args] — peel until we hit a name.
    while (Array.isArray(receiver) && receiver[0] === '()' &&
        Array.isArray(receiver[1]) && receiver[1][0] === '.' &&
        TYPED_CHAIN_METHODS.has(receiver[1][2])) {
      receiver = receiver[1][1]
      chainOutput = true
    }
    const ctor = typeof receiver === 'string' && ctx.types.typedElem?.get(receiver)
    if (!ctor) return null
    const isView = !chainOutput && ctor.endsWith('.view')
    const name = ctor.endsWith('.view') ? ctor.slice(4, -5) : ctor.slice(4)
    const et = TYPED_ELEM_CODE[name]
    return et == null ? null : { et, isView, isBigInt: name === 'BigInt64Array' || name === 'BigUint64Array' }
  }

  /** Emit the real data byte-address for a typed array IR node.
   *  Owned: low 32 bits of the NaN-box (or the unboxed local directly).
   *  View: load descriptor[4]. Uses ptrOffsetIR so unboxed-TYPED locals pass through
   *  without a rebox-then-unbox round trip, and globals fold to inline bit-extract. */
  const typedDataAddr = (objIR, isView) => isView
    ? ['i32.load', ['i32.add', ptrOffsetIR(objIR, VAL.TYPED), ['i32.const', 4]]]
    : ptrOffsetIR(objIR, VAL.TYPED)

  // Runtime-dispatch typed index: checks ptr_type + aux to load with correct stride.
  // For TYPED views (aux bit 3), $off indirects through descriptor[4] to real data.
  // Factory — collapses to ARRAY-only f64 indexing when no TYPED pointer can reach here.
  // Identical factory in array.js; whichever module loads last wins the registration.
  ctx.core.stdlib['__typed_idx'] = () => {
    if (!ctx.features.typedarray && !ctx.features.external) {
      return `(func $__typed_idx (param $ptr i64) (param $i i32) (result f64)
    (local $len i32)
    (local.set $len (call $__len (local.get $ptr)))
    (if (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (local.get $len)))
      (then (f64.const nan:${UNDEF_NAN}))
      (else (f64.load (i32.add (call $__ptr_offset (local.get $ptr)) (i32.shl (local.get $i) (i32.const 3)))))))`
    }
    return `(func $__typed_idx (param $ptr i64) (param $i i32) (result f64)
    (local $off i32) (local $et i32) (local $len i32) (local $aux i32)
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    ;; ARRAY fast path: __ptr_offset already followed any forwarding — read header len + f64.load, no $__len call.
    (if (i32.and (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.ARRAY})) (i32.ge_u (local.get $off) (i32.const 8)))
      (then (return (if (result f64)
        (i32.and (i32.ge_s (local.get $i) (i32.const 0)) (i32.lt_u (local.get $i) (i32.load (i32.sub (local.get $off) (i32.const 8)))))
        (then (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
        (else (f64.const nan:${UNDEF_NAN}))))))
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (if
      (i32.and
        (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.TYPED}))
        (i32.ne (i32.and (local.get $aux) (i32.const 8)) (i32.const 0)))
      (then (local.set $off (i32.load (i32.add (local.get $off) (i32.const 4))))))
    (local.set $len (call $__len (local.get $ptr)))
    (if (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (local.get $len)))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (if (result f64) (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.TYPED}))
          (then
            (local.set $et (i32.and (local.get $aux) (i32.const 7)))
            (if (result f64) (i32.ge_u (local.get $et) (i32.const 6))
              (then (if (result f64) (i32.eq (local.get $et) (i32.const 7))
                (then (if (result f64) (i32.and (local.get $aux) (i32.const ${TYPED_ELEM_BIGINT_FLAG}))
                  (then (f64.reinterpret_i64 (i64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))))
                  (else (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))))
                (else (f64.promote_f32 (f32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))))
              (else (if (result f64) (i32.ge_u (local.get $et) (i32.const 4))
                (then (if (result f64) (i32.and (local.get $et) (i32.const 1))
                  (then (f64.convert_i32_u (i32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))
                  (else (f64.convert_i32_s (i32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))))
                (else (if (result f64) (i32.ge_u (local.get $et) (i32.const 2))
                  (then (if (result f64) (i32.and (local.get $et) (i32.const 1))
                    (then (f64.convert_i32_u (i32.load16_u (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1))))))
                    (else (f64.convert_i32_s (i32.load16_s (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1))))))))
                  (else (if (result f64) (i32.and (local.get $et) (i32.const 1))
                    (then (f64.convert_i32_u (i32.load8_u (i32.add (local.get $off) (local.get $i)))))
                    (else (f64.convert_i32_s (i32.load8_s (i32.add (local.get $off) (local.get $i)))))))))))))
          (else (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))))))`
  }

  ctx.core.stdlib['__typed_set_idx'] = `(func $__typed_set_idx (param $ptr i64) (param $i i32) (param $v f64) (result f64)
    (local $off i32) (local $aux i32) (local $et i32) (local $bits i32)
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (i32.ne (i32.and (local.get $aux) (i32.const 8)) (i32.const 0))
      (then (local.set $off (i32.load (i32.add (local.get $off) (i32.const 4))))))
    (local.set $et (i32.and (local.get $aux) (i32.const 7)))
    (if (i32.and (local.get $aux) (i32.const ${TYPED_ELEM_BIGINT_FLAG}))
      (then (i64.store (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))) (i64.reinterpret_f64 (local.get $v))))
      (else
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

  // Type-aware TypedArray read: arr[i]
  ctx.core.emit['.typed:[]'] = (arr, i) => {
    const r = resolveElem(arr)
    if (r == null) return null // unknown type, fallback to generic
    const { et, isView, isBigInt } = r
    const objIR = emit(arr), vi = idx(i)
    const off = ['i32.add', typedDataAddr(objIR, isView), ['i32.shl', vi, ['i32.const', SHIFT[et]]]]
    if (isBigInt) return typed(['f64.reinterpret_i64', ['i64.load', off]], 'f64')
    if (et === 7) return typed(['f64.load', off], 'f64') // Float64Array
    if (et === 6) return typed(['f64.promote_f32', ['f32.load', off]], 'f64') // Float32Array
    // Integer types: load and convert to f64 (unsigned types use unsigned conversion)
    return typed([(et & 1) ? 'f64.convert_i32_u' : 'f64.convert_i32_s', [LOAD[et], off]], 'f64')
  }

  // Type-aware TypedArray write: arr[i] = val
  ctx.core.emit['.typed:[]='] = (arr, i, val, void_ = false) => {
    const r = resolveElem(arr)
    if (r == null) return null
    const { et, isView, isBigInt } = r
    const objIR = emit(arr), vi = idx(i), valIR = emit(val)
    const off = ['i32.add', typedDataAddr(objIR, isView), ['i32.shl', vi, ['i32.const', SHIFT[et]]]]
    if (isBigInt) {
      const vt = temp('tw')
      return typed(void_ ? ['block',
        ['local.set', `$${vt}`, asF64(valIR)],
        ['i64.store', off, ['i64.reinterpret_f64', ['local.get', `$${vt}`]]]]
        : ['block', ['result', 'f64'],
        ['local.set', `$${vt}`, asF64(valIR)],
        ['i64.store', off, ['i64.reinterpret_f64', ['local.get', `$${vt}`]]],
        ['local.get', `$${vt}`]], void_ ? 'void' : 'f64')
    }
    if (et === 7) {
      const vt = temp('tw')
      return typed(void_ ? ['block',
        ['local.set', `$${vt}`, asF64(valIR)],
        ['f64.store', off, ['local.get', `$${vt}`]]]
        : ['block', ['result', 'f64'],
        ['local.set', `$${vt}`, asF64(valIR)],
        ['f64.store', off, ['local.get', `$${vt}`]],
        ['local.get', `$${vt}`]], void_ ? 'void' : 'f64') // Float64Array
    }
    if (et === 6) {
      const vt = temp('tw')
      return typed(void_ ? ['block',
        ['local.set', `$${vt}`, asF64(valIR)],
        ['f32.store', off, ['f32.demote_f64', ['local.get', `$${vt}`]]]]
        : ['block', ['result', 'f64'],
        ['local.set', `$${vt}`, asF64(valIR)],
        ['f32.store', off, ['f32.demote_f64', ['local.get', `$${vt}`]]],
        ['local.get', `$${vt}`]], void_ ? 'void' : 'f64') // Float32Array
    }
    // Integer store: when the source is already i32-typed (bitwise ops, |0,
    // typed-array load, known-i32 var), store it directly — skip the f64
    // detour that costs a sign branch + i64 trunc + i32 wrap on every write.
    if (valIR.type === 'i32') {
      const cheap = Array.isArray(valIR) &&
        ((valIR[0] === 'local.get' && typeof valIR[1] === 'string') ||
         (valIR[0] === 'i32.const' && (typeof valIR[1] === 'number' || typeof valIR[1] === 'string')))
      if (void_ && cheap) return typed([STORE[et], off, valIR], 'void')
      const v32 = tempI32('tw')
      return typed(void_ ? ['block',
        ['local.set', `$${v32}`, valIR],
        [STORE[et], off, ['local.get', `$${v32}`]]]
        : ['block', ['result', 'f64'],
        ['local.set', `$${v32}`, valIR],
        [STORE[et], off, ['local.get', `$${v32}`]],
        [(et & 1) ? 'f64.convert_i32_u' : 'f64.convert_i32_s', ['local.get', `$${v32}`]]], void_ ? 'void' : 'f64')
    }
    const vt = temp('tw')
    const i32val = ['i32.wrap_i64',
      ['if', ['result', 'i64'], ['f64.lt', ['local.get', `$${vt}`], ['f64.const', 0]],
        ['then', ['i64.trunc_sat_f64_s', ['local.get', `$${vt}`]]],
        ['else', ['i64.trunc_sat_f64_u', ['local.get', `$${vt}`]]]]]
    return typed(void_ ? ['block',
      ['local.set', `$${vt}`, asF64(valIR)],
      [STORE[et], off, i32val]]
      : ['block', ['result', 'f64'],
      ['local.set', `$${vt}`, asF64(valIR)],
      [STORE[et], off, i32val],
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
      store = et === 7 ? ['f64.store', addr, val]
        : et === 6 ? ['f32.store', addr, ['f32.demote_f64', val]]
        : [STORE[et], addr, [(et & 1) ? 'i32.trunc_f64_u' : 'i32.trunc_f64_s', val]]
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
    const elemName = r && (r.isBigInt
      ? (elemType === 7 ? 'BigInt64Array' : 'BigUint64Array')  // unreachable: SIMD path gated below
      : ['Int8Array','Uint8Array','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array'][elemType])

    // BigInt typed arrays: SIMD path doesn't support them; defer to scalar map.
    if (r?.isBigInt) {
      // Fall through to generic .map below — keeps i64-via-NaN-box semantics intact.
      if (ctx.core.emit['.map']) return ctx.core.emit['.map'](arr, fn)
      return null
    }

    // Try SIMD: inline arrow with recognizable pattern
    if (elemType != null && Array.isArray(fn) && fn[0] === '=>') {
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
        if (elemType === 7) return typed(['f64.load', off], 'f64')
        if (elemType === 6) return typed(['f64.promote_f32', ['f32.load', off]], 'f64')
        return typed([(elemType & 1) ? 'f64.convert_i32_u' : 'f64.convert_i32_s', [LOAD[elemType], off]], 'f64')
      }
      const storeElem = (val) => {
        const off = ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', shift]]]
        if (elemType === 7) return ['f64.store', off, val]
        if (elemType === 6) return ['f32.store', off, ['f32.demote_f64', val]]
        return [STORE[elemType], off, [(elemType & 1) ? 'i32.trunc_f64_u' : 'i32.trunc_f64_s', val]]
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
  // and pass it to bodyFn. Returns the IR setup statements. Returns null if the
  // element type can't be resolved — callers fall back to the generic array
  // emitter.
  //
  // bodyFn(loadElem, i, len, ptr, exitLabel) returns IR statements. loadElem is
  // a function (called lazily so it isn't materialized for unused-item paths)
  // returning f64 IR for the current element. `exitLabel` lets the body break
  // out of the loop (e.g. `.find` after a hit, `.some`/`.every` on early
  // resolution). `i`/`len`/`ptr` are i32 local-name strings.
  const typedLoop = (arr, bodyFn) => {
    const r = resolveElem(arr)
    if (!r) return null
    const { et, isView, isBigInt } = r
    if (isBigInt) return null  // BigInt: defer to generic .map (returns BigInts via f64-bits NaN-box)
    const va = emit(arr)
    const len = tempI32('tll'), ptr = tempI32('tlp'), i = tempI32('tli')
    const id = ctx.func.uniq++
    const exit = `$brk${id}`
    inc('__len')
    const loadElem = () => {
      const off = ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', SHIFT[et]]]]
      if (et === 7) return typed(['f64.load', off], 'f64')
      if (et === 6) return typed(['f64.promote_f32', ['f32.load', off]], 'f64')
      return typed([(et & 1) ? 'f64.convert_i32_u' : 'f64.convert_i32_s', [LOAD[et], off]], 'f64')
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
  ctx.core.emit['.typed:indexOf'] = (arr, val) => {
    const found = tempI32('tif'), needle = temp('tin')
    const loop = typedLoop(arr, (load, i, _len, _ptr, exit) => [
      ['if', ['f64.eq', load(), ['local.get', `$${needle}`]],
        ['then',
          ['local.set', `$${found}`, ['local.get', `$${i}`]],
          ['br', exit]]]
    ])
    if (!loop) return null
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${needle}`, asF64(emit(val))],
      ['local.set', `$${found}`, ['i32.const', -1]],
      ...loop.setup,
      ['f64.convert_i32_s', ['local.get', `$${found}`]]], 'f64')
  }

  // .includes: like indexOf but NaN-equal-NaN (JS spec). Stash needle bits as
  // i64 and compare via i64.eq so two NaNs with matching bit patterns match
  // (f64.eq would say false).
  ctx.core.emit['.typed:includes'] = (arr, val) => {
    const found = tempI32('thf'), needle = temp('thn')
    const loop = typedLoop(arr, (load, _i, _len, _ptr, exit) => [
      ['if',
        ['i32.or',
          ['f64.eq', load(), ['local.get', `$${needle}`]],
          ['i64.eq',
            ['i64.reinterpret_f64', load()],
            ['i64.reinterpret_f64', ['local.get', `$${needle}`]]]],
        ['then', ['local.set', `$${found}`, ['i32.const', 1]], ['br', exit]]]
    ])
    if (!loop) return null
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${needle}`, asF64(emit(val))],
      ['local.set', `$${found}`, ['i32.const', 0]],
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
      if (et === 7) return typed(['f64.load', off], 'f64')
      if (et === 6) return typed(['f64.promote_f32', ['f32.load', off]], 'f64')
      return typed([(et & 1) ? 'f64.convert_i32_u' : 'f64.convert_i32_s', [LOAD[et], off]], 'f64')
    }
    const storeAt = (ptrLoc, iLoc, valF64) => {
      const off = ['i32.add', ['local.get', `$${ptrLoc}`], ['i32.shl', ['local.get', `$${iLoc}`], ['i32.const', SHIFT[et]]]]
      if (et === 7) return ['f64.store', off, valF64]
      if (et === 6) return ['f32.store', off, ['f32.demote_f64', valF64]]
      return [STORE[et], off, [(et & 1) ? 'i32.trunc_f64_u' : 'i32.trunc_f64_s', valF64]]
    }
    const dst = allocPtr({ type: PTR.TYPED, aux: typedAux(ET_NAME[et]),
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
    if (!r || r.isBigInt) return null
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
    const dst = allocPtr({ type: PTR.TYPED, aux: typedAux(ET_NAME[et]),
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
}
