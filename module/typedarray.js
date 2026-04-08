/**
 * TypedArray module — Float64Array, Float32Array, Int32Array, etc.
 * SIMD auto-vectorization for .map() on recognized patterns.
 *
 * Type=3 (TYPED): aux=elemType (3 bits), length in memory header [-8:len][-4:cap].
 *
 * @module typed
 */

import { emit, typed, asF64, asI32, T } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const TYPED = 3

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
    (call $__mkptr (i32.const ${TYPED}) (i32.const ${elemType}) (local.get $dstOff)))`
}


export default () => {
  // Constructor: new Float64Array(len)
  for (const [name, elemType] of Object.entries(ELEM)) {
    const stride = STRIDE[elemType]
    ctx.emit[`new.${name}`] = (lenExpr) => {
      const len = asI32(emit(lenExpr))
      const t = `${T}ta${ctx.uniq++}`
      ctx.locals.set(t, 'i32')
      // Header: [-8:len(i32)][-4:cap(i32)][data...]. aux=elemType only.
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.mul', len, ['i32.const', stride]]]]],
        ['i32.store', ['local.get', `$${t}`], len],  // len
        ['i32.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]], len],  // cap
        ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['i32.const', 8]]],  // skip header
        ['call', '$__mkptr', ['i32.const', TYPED], ['i32.const', elemType], ['local.get', `$${t}`]]], 'f64')
    }
  }

  // TypedArray.from(arr) — convert regular array to typed array
  for (const [name, elemType] of Object.entries(ELEM)) {
    const stride = STRIDE[elemType], store = STORE[elemType]
    ctx.emit[`${name}.from`] = (src) => {
      const va = asF64(emit(src))
      const t = `${T}tf${ctx.uniq++}`, len = `${T}tfl${ctx.uniq++}`, i = `${T}tfi${ctx.uniq++}`, off = `${T}tfo${ctx.uniq++}`
      ctx.locals.set(t, 'i32'); ctx.locals.set(len, 'i32'); ctx.locals.set(i, 'i32'); ctx.locals.set(off, 'i32')
      const id = ctx.uniq++
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
        ['local.set', `$${t}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.mul', ['local.get', `$${len}`], ['i32.const', stride]]]]],
        ['i32.store', ['local.get', `$${t}`], ['local.get', `$${len}`]],
        ['i32.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]], ['local.get', `$${len}`]],
        ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['i32.const', 8]]],
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$brk${id}`, ['loop', `$loop${id}`,
          ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
          storeExpr,
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]],
        ['call', '$__mkptr', ['i32.const', TYPED], ['i32.const', elemType], ['local.get', `$${t}`]]], 'f64')
    }
  }

  // .length handled by ptr.js's __len (reads from memory header [-8:len])

  /** Resolve element type for a known TypedArray variable. Returns ELEM id or null. */
  const resolveElem = (arr) => {
    const ctor = typeof arr === 'string' && ctx.typedElem?.get(arr)
    if (!ctor) return null
    return ELEM[ctor.slice(4)] ?? null
  }

  // Runtime-dispatch typed index: checks ptr_type + aux to load with correct stride
  ctx.stdlib['__typed_idx'] = `(func $__typed_idx (param $ptr f64) (param $i i32) (result f64)
    (local $off i32) (local $et i32)
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (result f64) (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${TYPED}))
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
  ctx.emit['.typed:[]'] = (arr, idx) => {
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
  ctx.emit['.typed:[]='] = (arr, idx, val) => {
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
  ctx.emit['.typed:map'] = (arr, fn) => {
    // Resolve element type from variable tracking
    const ctor = typeof arr === 'string' && ctx.typedElem?.get(arr)
    const elemName = ctor?.slice(4) // 'new.Float64Array' → 'Float64Array'
    const elemType = elemName && ELEM[elemName]

    // Try SIMD: inline arrow with recognizable pattern
    if (elemType != null && Array.isArray(fn) && fn[0] === '=>') {
      const [, rawParam, body] = fn
      const param = Array.isArray(rawParam) && rawParam[0] === '()' ? rawParam[1] : rawParam
      const pattern = analyzeSimd(body, param)

      if (pattern) {
        const id = ctx.uniq++
        const funcName = `__simd_map_${id}`
        const wat = genSimdMap(funcName, elemType, pattern)
        if (wat) {
          ctx.stdlib[funcName] = wat
          ctx.includes.add(funcName)
          return typed(['call', `$${funcName}`, asF64(emit(arr))], 'f64')
        }
      }
    }

    // Scalar fallback: proper typed-array map (preserves element type)
    if (elemType != null) {
      const va = emit(arr), vf = emit(fn)
      const out = `${T}tmo${ctx.uniq++}`, len = `${T}tml${ctx.uniq++}`, ptr = `${T}tmp${ctx.uniq++}`, i = `${T}tmi${ctx.uniq++}`
      ctx.locals.set(out, 'i32'); ctx.locals.set(len, 'i32'); ctx.locals.set(ptr, 'i32'); ctx.locals.set(i, 'i32')
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

      const id = ctx.uniq++
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${ptr}`, ['call', '$__ptr_offset', asF64(va)]],
        ['local.set', `$${len}`, ['call', '$__len', asF64(va)]],
        ['local.set', `$${out}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8],
          ['i32.mul', ['local.get', `$${len}`], ['i32.const', stride]]]]],
        ['i32.store', ['local.get', `$${out}`], ['local.get', `$${len}`]],
        ['i32.store', ['i32.add', ['local.get', `$${out}`], ['i32.const', 4]], ['local.get', `$${len}`]],
        ['local.set', `$${out}`, ['i32.add', ['local.get', `$${out}`], ['i32.const', 8]]],
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$brk${id}`, ['loop', `$loop${id}`,
          ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
          storeElem(asF64(ctx.fn.call(vf, [loadElem()]))),
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]],
        ['call', '$__mkptr', ['i32.const', TYPED], ['i32.const', elemType], ['local.get', `$${out}`]]], 'f64')
    }

    // Unknown typed array type: fall back to generic array .map
    if (ctx.emit['.map']) return ctx.emit['.map'](arr, fn)
    return null
  }
}
