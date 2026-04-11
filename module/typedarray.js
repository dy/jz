/**
 * TypedArray module — Float64Array, Float32Array, Int32Array, etc.
 * SIMD auto-vectorization for .map() on recognized patterns.
 *
 * Type=3 (TYPED): aux=elemType (3 bits), length in memory header [-8:len][-4:cap].
 *
 * @module typed
 */

import { emit, typed, asF64, asI32, T } from '../src/compile.js'
import { ctx, inc, PTR } from '../src/ctx.js'


// Element types and their byte sizes
const ELEM = {
  Int8Array: 0, Uint8Array: 1,
  Int16Array: 2, Uint16Array: 3,
  Int32Array: 4, Uint32Array: 5,
  Float32Array: 6, Float64Array: 7,
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
    (local.set $srcOff (call $__ptr_offset (local.get $src)))
    ;; Alloc result typed array: header(8) + data
    (local.set $dst (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $len) (i32.const ${shift})))))
    (i32.store (local.get $dst) (local.get $len))
    (i32.store (i32.add (local.get $dst) (i32.const 4)) (local.get $len))
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
  // Constructor: new Float64Array(len) or new Uint8Array(buffer, offset, len)
  for (const [name, elemType] of Object.entries(ELEM)) {
    const stride = STRIDE[elemType]
    ctx.core.emit[`new.${name}`] = (lenExpr, offsetExpr, lenExpr2) => { console.log(`NEW ${name} len=${JSON.stringify(lenExpr)} off=${JSON.stringify(offsetExpr)} len2=${JSON.stringify(lenExpr2)}`);
      // View on existing buffer: TypedArray(buffer, offset, len) → typed ptr at buffer+offset
      if (offsetExpr != null && lenExpr2 != null) {
        const buf = ['call', '$__ptr_offset', asF64(emit(lenExpr))]  // extract i32 offset from f64 ptr
        const off = asI32(emit(offsetExpr))
        const len = asI32(emit(lenExpr2))
        const t = `${T}ta${ctx.func.uniq++}`
        ctx.func.locals.set(t, 'i32')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${t}`, ['i32.add', buf, off]],
          ['i32.store', ['i32.sub', ['local.get', `$${t}`], ['i32.const', 8]], len],
          ['i32.store', ['i32.sub', ['local.get', `$${t}`], ['i32.const', 4]], len],
          ['call', '$__mkptr', ['i32.const', PTR.TYPED], ['i32.const', elemType], ['local.get', `$${t}`]]], 'f64')
      }
      // Single arg: if source is known array type, use .from() conversion
      if (typeof lenExpr === 'string' && ctx.func.valTypes?.get(lenExpr) === 'array' && ctx.core.emit[`${name}.from`])
        return ctx.core.emit[`${name}.from`](lenExpr)
      // Normal: allocate fresh typed array (lenExpr is numeric size)
      const len = asI32(emit(lenExpr))
      const t = `${T}ta${ctx.func.uniq++}`
      ctx.func.locals.set(t, 'i32')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, ['call', '$__alloc_hdr', len, len, ['i32.const', stride]]],
        ['call', '$__mkptr', ['i32.const', PTR.TYPED], ['i32.const', elemType], ['local.get', `$${t}`]]], 'f64')
    }
  }

  // === ArrayBuffer/DataView — low-level memory for type-punning ===
  // All values are f64 (NaN-boxed). ArrayBuffer/DataView use Uint8Array ptr (type=3, elemType=1).

  // ArrayBuffer(n) → allocate n bytes, return as Uint8Array pointer
  ctx.core.emit['ArrayBuffer'] = (sizeExpr) => {
    const n = asI32(emit(sizeExpr))
    const t = `${T}ab${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'i32')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, ['call', '$__alloc_hdr', n, n, ['i32.const', 1]]],
      ['call', '$__mkptr', ['i32.const', PTR.TYPED], ['i32.const', 1], ['local.get', `$${t}`]]], 'f64')
  }

  // DataView(buffer) → passthrough (same f64 pointer)
  ctx.core.emit['DataView'] = (bufExpr) => asF64(emit(bufExpr))

  // BigInt64Array(buffer) → reinterpret same memory as Float64Array (elemType=7)
  ctx.core.emit['BigInt64Array'] = (bufExpr) => {
    const va = asF64(emit(bufExpr))
    return typed(['call', '$__mkptr', ['i32.const', PTR.TYPED], ['i32.const', 7],
      ['call', '$__ptr_offset', va]], 'f64')
  }

  // .buffer property → return same pointer (ArrayBuffer/DataView share memory)
  ctx.core.emit['.buffer'] = (expr) => asF64(emit(expr))

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
      const t = `${T}tf${ctx.func.uniq++}`, len = `${T}tfl${ctx.func.uniq++}`, i = `${T}tfi${ctx.func.uniq++}`, off = `${T}tfo${ctx.func.uniq++}`
      ctx.func.locals.set(t, 'i32'); ctx.func.locals.set(len, 'i32'); ctx.func.locals.set(i, 'i32'); ctx.func.locals.set(off, 'i32')
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
        ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['local.get', `$${len}`], ['local.get', `$${len}`], ['i32.const', stride]]],
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$brk${id}`, ['loop', `$loop${id}`,
          ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
          storeExpr,
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]],
        ['call', '$__mkptr', ['i32.const', PTR.TYPED], ['i32.const', elemType], ['local.get', `$${t}`]]], 'f64')
    }
  }

  // .length handled by ptr.js's __len (reads from memory header [-8:len])

  /** Resolve element type for a known TypedArray variable. Returns ELEM id or null. */
  const resolveElem = (arr) => {
    const ctor = typeof arr === 'string' && ctx.types.typedElem?.get(arr)
    if (!ctor) return null
    return ELEM[ctor.slice(4)] ?? null
  }

  // Runtime-dispatch typed index: checks ptr_type + aux to load with correct stride
  ctx.core.stdlib['__typed_idx'] = `(func $__typed_idx (param $ptr f64) (param $i i32) (result f64)
    (local $off i32) (local $et i32)
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (result f64) (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.TYPED}))
      (then
        (local.set $et (call $__ptr_aux (local.get $ptr)))
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
      (else (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))))`

  // Type-aware TypedArray read: arr[i]
  ctx.core.emit['.typed:[]'] = (arr, idx) => {
    const et = resolveElem(arr)
    if (et == null) return null // unknown type, fallback to generic
    const va = asF64(emit(arr)), vi = asI32(emit(idx))
    const off = ['i32.add', ['call', '$__ptr_offset', va], ['i32.shl', vi, ['i32.const', SHIFT[et]]]]
    if (et === 7) return typed(['f64.load', off], 'f64') // Float64Array
    if (et === 6) return typed(['f64.promote_f32', ['f32.load', off]], 'f64') // Float32Array
    // Integer types: load and convert to f64 (unsigned types use unsigned conversion)
    return typed([(et & 1) ? 'f64.convert_i32_u' : 'f64.convert_i32_s', [LOAD[et], off]], 'f64')
  }

  // Type-aware TypedArray write: arr[i] = val
  ctx.core.emit['.typed:[]='] = (arr, idx, val) => {
    const et = resolveElem(arr)
    if (et == null) return null
    const va = asF64(emit(arr)), vi = asI32(emit(idx)), vv = asF64(emit(val))
    const off = ['i32.add', ['call', '$__ptr_offset', va], ['i32.shl', vi, ['i32.const', SHIFT[et]]]]
    if (et === 7) return ['f64.store', off, vv] // Float64Array
    if (et === 6) return ['f32.store', off, ['f32.demote_f64', vv]] // Float32Array
    // Integer types: truncate f64 to i32, then store (unsigned types use unsigned truncation)
    return [STORE[et], off, [(et & 1) ? 'i32.trunc_f64_u' : 'i32.trunc_f64_s', vv]]
  }

  // .map() on TypedArrays — SIMD auto-vectorization when pattern detected
  ctx.core.emit['.typed:map'] = (arr, fn) => {
    // Resolve element type from variable tracking
    const ctor = typeof arr === 'string' && ctx.types.typedElem?.get(arr)
    const elemName = ctor?.slice(4) // 'new.Float64Array' → 'Float64Array'
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
          inc(funcName)
          return typed(['call', `$${funcName}`, asF64(emit(arr))], 'f64')
        }
      }
    }

    // Scalar fallback: proper typed-array map (preserves element type)
    if (elemType != null) {
      const va = emit(arr), vf = emit(fn)
      const out = `${T}tmo${ctx.func.uniq++}`, len = `${T}tml${ctx.func.uniq++}`, ptr = `${T}tmp${ctx.func.uniq++}`, i = `${T}tmi${ctx.func.uniq++}`
      ctx.func.locals.set(out, 'i32'); ctx.func.locals.set(len, 'i32'); ctx.func.locals.set(ptr, 'i32'); ctx.func.locals.set(i, 'i32')
      const stride = STRIDE[elemType], shift = SHIFT[elemType]

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
        ['local.set', `$${ptr}`, ['call', '$__ptr_offset', asF64(va)]],
        ['local.set', `$${len}`, ['call', '$__len', asF64(va)]],
        ['local.set', `$${out}`, ['call', '$__alloc_hdr', ['local.get', `$${len}`], ['local.get', `$${len}`], ['i32.const', stride]]],
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$brk${id}`, ['loop', `$loop${id}`,
          ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
          storeElem(asF64(ctx.closure.call(vf, [loadElem()]))),
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]],
        ['call', '$__mkptr', ['i32.const', PTR.TYPED], ['i32.const', elemType], ['local.get', `$${out}`]]], 'f64')
    }

    // Unknown typed array type: fall back to generic array .map
    if (ctx.core.emit['.map']) return ctx.core.emit['.map'](arr, fn)
    return null
  }
}
