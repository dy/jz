/**
 * TypedArray module — Float64Array, Float32Array, Int32Array, etc.
 * SIMD auto-vectorization for .map() on recognized patterns.
 *
 * Type=3 (TYPED): aux=elemType (3 bits), length in memory header [-8:len][-4:cap].
 *
 * @module typed
 */

import { emit, typed, asF64, asI32, valTypeOf, VAL, T, UNDEF_NAN, allocPtr } from '../src/compile.js'
import { ctx, inc, PTR } from '../src/ctx.js'


// Element types and their byte sizes
const ELEM = {
  Int8Array: 0, Uint8Array: 1,
  Int16Array: 2, Uint16Array: 3,
  Int32Array: 4, Uint32Array: 5,
  Float32Array: 6, Float64Array: 7,
  BigInt64Array: 7, BigUint64Array: 7,
}
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

  return `(func $${name} (param $src f64) (result f64)
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


export default () => {
  inc('__mkptr', '__alloc', '__ptr_offset', '__ptr_type', '__len')

  // === Runtime helpers: byte length, buffer coerce ===
  // __typed_shift lives in core (needed by __len/__cap).

  // __byte_length(ptr) — byte size for BUFFER/TYPED; 0 otherwise.
  // BUFFER and owned TYPED store byteLen at [-8]. TYPED view (aux bit 3) stores byteLen
  // at descriptor[0].
  ctx.core.stdlib['__byte_length'] = `(func $__byte_length (param $ptr f64) (result i32)
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
  ctx.core.stdlib['__to_buffer'] = `(func $__to_buffer (param $ptr f64) (result f64)
    (local $t i32) (local $off i32)
    (local.set $t (call $__ptr_type (local.get $ptr)))
    (if (result f64) (i32.eq (local.get $t) (i32.const ${PTR.BUFFER}))
      (then (local.get $ptr))
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
  for (const [name, elemType] of Object.entries(ELEM)) {
    const stride = STRIDE[elemType]
    ctx.core.emit[`new.${name}`] = (lenExpr, offsetExpr, lenExpr2) => {
      const srcType = typeof lenExpr === 'string'
        ? (ctx.func.valTypes?.get(lenExpr) || ctx.scope.globalValTypes?.get(lenExpr))
        : valTypeOf(lenExpr)
      // Subview: new TypedArray(buffer, byteOffset, length) — true JS-parity view.
      // Allocates a 16-byte descriptor [byteLen:i32][dataOff:i32][parentOff:i32][pad]
      // and tags the TYPED ptr with aux=elemType|8. Reads/writes alias the parent,
      // .buffer reconstructs the root BUFFER, .byteOffset = dataOff - parentOff.
      if (offsetExpr != null && lenExpr2 != null) {
        const src = `${T}tvs${ctx.func.uniq++}`
        const parentOff = `${T}tvp${ctx.func.uniq++}`
        const byteLen = `${T}tvb${ctx.func.uniq++}`
        const dst = `${T}tvd${ctx.func.uniq++}`
        ctx.func.locals.set(src, 'f64')
        ctx.func.locals.set(parentOff, 'i32')
        ctx.func.locals.set(byteLen, 'i32')
        ctx.func.locals.set(dst, 'i32')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${src}`, asF64(emit(lenExpr))],
          ['local.set', `$${parentOff}`, ['call', '$__ptr_offset', ['local.get', `$${src}`]]],
          ['local.set', `$${byteLen}`, ['i32.mul', asI32(emit(lenExpr2)), ['i32.const', stride]]],
          ['local.set', `$${dst}`, ['call', '$__alloc', ['i32.const', 16]]],
          ['i32.store', ['local.get', `$${dst}`], ['local.get', `$${byteLen}`]],
          ['i32.store',
            ['i32.add', ['local.get', `$${dst}`], ['i32.const', 4]],
            ['i32.add', ['local.get', `$${parentOff}`], asI32(emit(offsetExpr))]],
          ['i32.store',
            ['i32.add', ['local.get', `$${dst}`], ['i32.const', 8]],
            ['local.get', `$${parentOff}`]],
          ['call', '$__mkptr', ['i32.const', PTR.TYPED], ['i32.const', elemType | 8], ['local.get', `$${dst}`]]], 'f64')
      }
      // Single arg array-like source: copy elements instead of treating the pointer as a length.
      if (srcType === VAL.ARRAY && ctx.core.emit[`${name}.from`])
        return ctx.core.emit[`${name}.from`](lenExpr)
      // Reinterpret on a buffer or another typed array: zero-copy view.
      // TYPED retagged at the same offset — the byteLen header is shared with the parent.
      // __len(view) = byteLen >> shift computes elemCount for this view's elemType.
      if (srcType === VAL.BUFFER || srcType === VAL.TYPED) {
        return typed(['call', '$__mkptr',
          ['i32.const', PTR.TYPED],
          ['i32.const', elemType],
          ['call', '$__ptr_offset', asF64(emit(lenExpr))]], 'f64')
      }
      if (srcType == null && ctx.core.emit[`${name}.from`]) {
        // Runtime dispatch: number → allocate; array → copy elements; buffer/typed → zero-copy view.
        const src = `${T}ts${ctx.func.uniq++}`
        const len = `${T}tl${ctx.func.uniq++}`
        ctx.func.locals.set(src, 'f64')
        ctx.func.locals.set(len, 'i32')
        const shift = SHIFT[elemType]
        const numBytes = ['i32.shl', ['local.get', `$${len}`], ['i32.const', shift]]
        const numAlloc = allocPtr({ type: PTR.TYPED, aux: elemType, len: numBytes, stride: 1, tag: 'ta' })
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
              ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${src}`]], ['i32.const', PTR.ARRAY]],
              ['then', ctx.core.emit[`${name}.from`](src)],
              ['else', ['call', '$__mkptr',
                ['i32.const', PTR.TYPED],
                ['i32.const', elemType],
                ['call', '$__ptr_offset', ['local.get', `$${src}`]]]]]]]], 'f64')
      }
      // Normal: allocate fresh typed array (lenExpr is numeric size). Header stores byteLen.
      const shift = SHIFT[elemType]
      const lenL = `${T}tan${ctx.func.uniq++}`
      ctx.func.locals.set(lenL, 'i32')
      const out = allocPtr({ type: PTR.TYPED, aux: elemType,
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

  // new ArrayBuffer(n) → allocate n bytes, return as BUFFER pointer
  const arrayBufferCtor = (sizeExpr) => {
    const n = asI32(emit(sizeExpr))
    const out = allocPtr({ type: PTR.BUFFER, len: n, stride: 1, tag: 'ab' })
    return typed(['block', ['result', 'f64'], out.init, out.ptr], 'f64')
  }
  ctx.core.emit['new.ArrayBuffer'] = arrayBufferCtor

  // new DataView(buffer) → same ptr (BUFFER). Its type tag may differ from BUFFER but methods ignore type.
  ctx.core.emit['new.DataView'] = (bufExpr) => asF64(emit(bufExpr))

  // BigInt64Array(buffer) (bare form, legacy): coerce to same data, Float64Array-compatible storage.
  ctx.core.emit['BigInt64Array'] = (bufExpr) => {
    const va = asF64(emit(bufExpr))
    return typed(['call', '$__mkptr', ['i32.const', PTR.TYPED], ['i32.const', 7],
      ['call', '$__ptr_offset', va]], 'f64')
  }

  // .buffer — always aliased (zero-copy). BUFFER/DataView: passthrough.
  // Owned TYPED: retag as BUFFER at same offset — the byteLen header is shared.
  // TYPED view: BUFFER at descriptor[8] (root parent data offset).
  ctx.core.emit['.buffer'] = (obj) => {
    if (typeof obj === 'string') {
      const ctor = ctx.types.typedElem?.get(obj)
      if (ctor === 'new.ArrayBuffer' || ctor === 'new.DataView') return asF64(emit(obj))
      if (ctor?.startsWith('new.')) {
        const isView = ctor.endsWith('.view')
        const name = isView ? ctor.slice(4, -5) : ctor.slice(4)
        if (ELEM[name] != null) {
          const parentOff = isView
            ? ['i32.load', ['i32.add', ['call', '$__ptr_offset', asF64(emit(obj))], ['i32.const', 8]]]
            : ['call', '$__ptr_offset', asF64(emit(obj))]
          return typed(['call', '$__mkptr',
            ['i32.const', PTR.BUFFER], ['i32.const', 0], parentOff], 'f64')
        }
      }
    }
    inc('__to_buffer')
    return typed(['call', '$__to_buffer', asF64(emit(obj))], 'f64')
  }

  // .byteLength — BUFFER: raw __len. Owned TYPED: elemCount * stride. View TYPED: descriptor[0].
  ctx.core.emit['.byteLength'] = (obj) => {
    if (typeof obj === 'string') {
      const ctor = ctx.types.typedElem?.get(obj)
      if (ctor === 'new.ArrayBuffer' || ctor === 'new.DataView') {
        return typed(['f64.convert_i32_s', ['call', '$__len', asF64(emit(obj))]], 'f64')
      }
      if (ctor && ctor.startsWith('new.')) {
        const isView = ctor.endsWith('.view')
        const name = isView ? ctor.slice(4, -5) : ctor.slice(4)
        const et = ELEM[name]
        if (et != null) {
          if (isView) {
            return typed(['f64.convert_i32_s',
              ['i32.load', ['call', '$__ptr_offset', asF64(emit(obj))]]], 'f64')
          }
          return typed(['f64.convert_i32_s',
            ['i32.shl', ['call', '$__len', asF64(emit(obj))], ['i32.const', SHIFT[et]]]], 'f64')
        }
      }
    }
    inc('__byte_length')
    return typed(['f64.convert_i32_s', ['call', '$__byte_length', asF64(emit(obj))]], 'f64')
  }

  // .byteOffset — owned: 0. View: descriptor[4] - descriptor[8].
  ctx.core.emit['.byteOffset'] = (obj) => {
    if (typeof obj === 'string') {
      const ctor = ctx.types.typedElem?.get(obj)
      if (ctor?.endsWith('.view')) {
        const t = `${T}bo${ctx.func.uniq++}`
        ctx.func.locals.set(t, 'i32')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${t}`, ['call', '$__ptr_offset', asF64(emit(obj))]],
          ['f64.convert_i32_s',
            ['i32.sub',
              ['i32.load', ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]]],
              ['i32.load', ['i32.add', ['local.get', `$${t}`], ['i32.const', 8]]]]]], 'f64')
      }
    }
    inc('__byte_offset')
    return typed(['f64.convert_i32_s', ['call', '$__byte_offset', asF64(emit(obj))]], 'f64')
  }

  // Runtime fallback for .byteOffset when variable view-ness is unknown.
  ctx.core.stdlib['__byte_offset'] = `(func $__byte_offset (param $ptr f64) (result i32)
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

  // ArrayBuffer.isView(x) — true iff x is a TYPED pointer. (DataView passthrough cannot be
  // distinguished from ArrayBuffer since both are BUFFER pointers; both report false.)
  ctx.core.emit['ArrayBuffer.isView'] = (v) => {
    const va = asF64(emit(v))
    return typed(['f64.convert_i32_s',
      ['i32.eq', ['call', '$__ptr_type', va], ['i32.const', PTR.TYPED]]], 'f64')
  }

  // buf.slice(begin?, end?) on a BUFFER → fresh BUFFER with the byte range copied.
  // Only dispatches statically when obj is a tracked ArrayBuffer/DataView variable.
  ctx.core.emit['.buf:slice'] = (obj, beginExpr, endExpr) => {
    const src = `${T}bss${ctx.func.uniq++}`
    const beg = `${T}bsb${ctx.func.uniq++}`
    const end = `${T}bse${ctx.func.uniq++}`
    const bytes = `${T}bsn${ctx.func.uniq++}`
    ctx.func.locals.set(src, 'f64')
    ctx.func.locals.set(beg, 'i32')
    ctx.func.locals.set(end, 'i32')
    ctx.func.locals.set(bytes, 'i32')
    const out = allocPtr({ type: PTR.BUFFER, len: ['local.get', `$${bytes}`], stride: 1, tag: 'bsd' })
    const beginWat = beginExpr == null ? ['i32.const', 0] : asI32(emit(beginExpr))
    const endWat = endExpr == null
      ? ['call', '$__len', ['local.get', `$${src}`]]
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
        ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${src}`]], ['local.get', `$${beg}`]],
        ['local.get', `$${bytes}`]],
      out.ptr], 'f64')
  }

  // DataView set methods: extract i32 offset from f64 ptr, store value
  const DV_SET = {
    setInt8: 'i32.store8', setUint8: 'i32.store8',
    setInt16: 'i32.store16', setUint16: 'i32.store16',
    setInt32: 'i32.store', setUint32: 'i32.store',
    setFloat32: 'f32.store', setFloat64: 'f64.store',
    setBigInt64: 'i64.store', setBigUint64: 'i64.store',
  }
  for (const [method, storeOp] of Object.entries(DV_SET)) {
    ctx.core.emit[`.${method}`] = (dv, off, val, _le) => {
      const dvOff = ['call', '$__ptr_offset', asF64(emit(dv))]
      const addr = ['i32.add', dvOff, asI32(emit(off))]
      let v = emit(val)
      if (method.includes('BigInt') || method.includes('BigUint'))
        v = typed(['i64.reinterpret_f64', asF64(v)], 'i64')
      else if (method.includes('Float64')) v = asF64(v)
      else if (method.includes('Float32')) v = typed(['f32.demote_f64', asF64(v)], 'f32')
      else v = asI32(v)
      return [storeOp, addr, v]
    }
  }

  // DataView get methods: extract i32 offset, load value, return as f64
  const DV_GET = {
    getInt8: ['i32.load8_s', 'i32'], getUint8: ['i32.load8_u', 'i32'],
    getInt16: ['i32.load16_s', 'i32'], getUint16: ['i32.load16_u', 'i32'],
    getInt32: ['i32.load', 'i32'], getUint32: ['i32.load', 'i32'],
    getFloat32: ['f32.load', 'f32'], getFloat64: ['f64.load', 'f64'],
    getBigInt64: ['i64.load', 'i64'], getBigUint64: ['i64.load', 'i64'],
  }
  for (const [method, [loadOp, resultType]] of Object.entries(DV_GET)) {
    ctx.core.emit[`.${method}`] = (dv, off, _le) => {
      const addr = ['i32.add', ['call', '$__ptr_offset', asF64(emit(dv))], asI32(emit(off))]
      const raw = typed([loadOp, addr], resultType)
      if (resultType === 'f64') return raw
      if (resultType === 'f32') return typed(['f64.promote_f32', raw], 'f64')
      if (resultType === 'i64') return typed(['f64.reinterpret_i64', raw], 'f64')
      return typed(['f64.convert_i32_s', raw], 'f64')
    }
  }

  // TypedArray.from(arr) — convert regular array to typed array
  for (const [name, elemType] of Object.entries(ELEM)) {
    const stride = STRIDE[elemType], store = STORE[elemType]
    ctx.core.emit[`${name}.from`] = (src) => {
      const va = asF64(emit(src))
      const len = `${T}tfl${ctx.func.uniq++}`, i = `${T}tfi${ctx.func.uniq++}`, off = `${T}tfo${ctx.func.uniq++}`
      ctx.func.locals.set(len, 'i32'); ctx.func.locals.set(i, 'i32'); ctx.func.locals.set(off, 'i32')
      const out = allocPtr({ type: PTR.TYPED, aux: elemType,
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
        ['local.set', `$${off}`, ['call', '$__ptr_offset', va]],
        ['local.set', `$${len}`, ['call', '$__len', va]],
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

  /** Resolve element type + view-ness for a known TypedArray variable.
   *  Returns { et, isView } or null. */
  const resolveElem = (arr) => {
    const ctor = typeof arr === 'string' && ctx.types.typedElem?.get(arr)
    if (!ctor) return null
    const isView = ctor.endsWith('.view')
    const name = isView ? ctor.slice(4, -5) : ctor.slice(4)
    const et = ELEM[name]
    return et == null ? null : { et, isView }
  }

  /** Emit the real data byte-address for a typed array WAT f64 node.
   *  Owned: __ptr_offset(va). View: load descriptor[4]. */
  const typedDataAddr = (va, isView) => isView
    ? ['i32.load', ['i32.add', ['call', '$__ptr_offset', va], ['i32.const', 4]]]
    : ['call', '$__ptr_offset', va]

  // Runtime-dispatch typed index: checks ptr_type + aux to load with correct stride.
  // For TYPED views (aux bit 3), $off indirects through descriptor[4] to real data.
  ctx.core.stdlib['__typed_idx'] = `(func $__typed_idx (param $ptr f64) (param $i i32) (result f64)
    (local $off i32) (local $et i32) (local $len i32) (local $aux i32)
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
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
      (then (f64.reinterpret_i64 (i64.const ${UNDEF_NAN})))
      (else
        (if (result f64) (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.TYPED}))
          (then
            (local.set $et (i32.and (local.get $aux) (i32.const 7)))
            (if (result f64) (i32.ge_u (local.get $et) (i32.const 6))
              (then (if (result f64) (i32.eq (local.get $et) (i32.const 7))
                (then (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
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

  // Type-aware TypedArray read: arr[i]
  ctx.core.emit['.typed:[]'] = (arr, idx) => {
    const r = resolveElem(arr)
    if (r == null) return null // unknown type, fallback to generic
    const { et, isView } = r
    const va = asF64(emit(arr)), vi = asI32(emit(idx))
    const off = ['i32.add', typedDataAddr(va, isView), ['i32.shl', vi, ['i32.const', SHIFT[et]]]]
    if (et === 7) return typed(['f64.load', off], 'f64') // Float64Array
    if (et === 6) return typed(['f64.promote_f32', ['f32.load', off]], 'f64') // Float32Array
    // Integer types: load and convert to f64 (unsigned types use unsigned conversion)
    return typed([(et & 1) ? 'f64.convert_i32_u' : 'f64.convert_i32_s', [LOAD[et], off]], 'f64')
  }

  // Type-aware TypedArray write: arr[i] = val
  ctx.core.emit['.typed:[]='] = (arr, idx, val) => {
    const r = resolveElem(arr)
    if (r == null) return null
    const { et, isView } = r
    const va = asF64(emit(arr)), vi = asI32(emit(idx)), vv = asF64(emit(val))
    const off = ['i32.add', typedDataAddr(va, isView), ['i32.shl', vi, ['i32.const', SHIFT[et]]]]
    if (et === 7) return ['f64.store', off, vv] // Float64Array
    if (et === 6) return ['f32.store', off, ['f32.demote_f64', vv]] // Float32Array
    // Integer types: truncate f64 to i32, then store (unsigned types use unsigned truncation)
    return [STORE[et], off, [(et & 1) ? 'i32.trunc_f64_u' : 'i32.trunc_f64_s', vv]]
  }

  // .map() on TypedArrays — SIMD auto-vectorization when pattern detected
  ctx.core.emit['.typed:map'] = (arr, fn) => {
    // Resolve element type + view-ness from variable tracking
    const ctor = typeof arr === 'string' && ctx.types.typedElem?.get(arr)
    const isView = ctor?.endsWith('.view')
    const elemName = isView ? ctor.slice(4, -5) : ctor?.slice(4)
    const elemType = elemName && ELEM[elemName]

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
          return typed(['call', `$${funcName}`, asF64(emit(arr))], 'f64')
        }
      }
    }

    // Scalar fallback: proper typed-array map (preserves element type)
    if (elemType != null) {
      const va = emit(arr), vf = emit(fn)
      const len = `${T}tml${ctx.func.uniq++}`, ptr = `${T}tmp${ctx.func.uniq++}`, i = `${T}tmi${ctx.func.uniq++}`
      ctx.func.locals.set(len, 'i32'); ctx.func.locals.set(ptr, 'i32'); ctx.func.locals.set(i, 'i32')
      const stride = STRIDE[elemType], shift = SHIFT[elemType]
      const dst = allocPtr({ type: PTR.TYPED, aux: elemType,
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
        ['local.set', `$${ptr}`, typedDataAddr(asF64(va), isView)],
        ['local.set', `$${len}`, ['call', '$__len', asF64(va)]],
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
}
