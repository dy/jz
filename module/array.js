/**
 * Array module — literals, indexing, methods, push/pop.
 *
 * Type=1 (ARRAY): C-style header in memory.
 * Layout: [-8:len(i32)][-4:cap(i32)][elem0:f64, elem1:f64, ...]
 * offset points to elem0 (past header). len/cap mutable. Aliases see changes.
 *
 * @module array
 */

import { emit, typed, asF64, asI32, valTypeOf, VAL, T, NULL_NAN, UNDEF_NAN, temp, multiCount, materializeMulti } from '../src/compile.js'
import { ctx, inc, PTR } from '../src/ctx.js'


/** Allocate array: 8-byte header (len+cap) + n*8 data via __alloc_hdr. Returns offset to data start. */
function allocArray(len, cap) {
  if (cap == null) cap = len
  const t = `${T}arr${ctx.func.uniq++}`
  ctx.func.locals.set(t, 'i32')
  return {
    local: t,
    setup: [
      ['local.set', `$${t}`, ['call', '$__alloc_hdr',
        typeof len === 'number' ? ['i32.const', len] : len,
        typeof cap === 'number' ? ['i32.const', cap] : cap,
        ['i32.const', 8]]],
    ],
  }
}

/** Emit a loop that iterates over array elements. Helper for methods. */
function arrayLoop(arrExpr, bodyFn) {
  const arr = `${T}aa${ctx.func.uniq++}`, ptr = `${T}ap${ctx.func.uniq++}`, len = `${T}al${ctx.func.uniq++}`, i = `${T}ai${ctx.func.uniq++}`, item = `${T}av${ctx.func.uniq++}`
  ctx.func.locals.set(arr, 'f64')
  ctx.func.locals.set(ptr, 'i32')
  ctx.func.locals.set(len, 'i32')
  ctx.func.locals.set(i, 'i32')
  ctx.func.locals.set(item, 'f64')
  const id = ctx.func.uniq++
  return [
    ['local.set', `$${arr}`, asF64(arrExpr)],
    ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['local.get', `$${arr}`]]],
    ['local.set', `$${len}`, ['call', '$__len', ['local.get', `$${arr}`]]],
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$brk${id}`, ['loop', `$loop${id}`,
      ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
      ['local.set', `$${item}`, elemLoad(ptr, i)],
      ...bodyFn(ptr, len, i, typed(['local.get', `$${item}`], 'f64')),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$loop${id}`]]],
  ]
}

function elemLoad(ptr, i) {
  return ['f64.load', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]
}

function elemStore(ptr, i, val) {
  return ['f64.store', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]], val]
}

function hoistCallback(fn) {
  const cb = `${T}af${ctx.func.uniq++}`
  ctx.func.locals.set(cb, 'f64')
  return {
    setup: ['local.set', `$${cb}`, asF64(emit(fn))],
    value: typed(['local.get', `$${cb}`], 'f64'),
  }
}

function hoistArrayValue(arr) {
  const recv = `${T}ar${ctx.func.uniq++}`
  ctx.func.locals.set(recv, 'f64')
  return {
    setup: ['local.set', `$${recv}`, asF64(emit(arr))],
    value: typed(['local.get', `$${recv}`], 'f64'),
  }
}

export default () => {
  // Array.isArray(x): check ptr_type === PTR.ARRAY
  ctx.core.emit['Array.isArray'] = (x) => {
    const v = asF64(emit(x))
    const t = `${T}t${ctx.func.uniq++}`; ctx.func.locals.set(t, 'f64')
    return typed(['i32.and',
      ['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
      ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${t}`]], ['i32.const', PTR.ARRAY]]], 'i32')
  }

  ctx.core.stdlib['__arr_idx'] = `(func $__arr_idx (param $ptr f64) (param $i i32) (result f64)
    (if (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (call $__len (local.get $ptr))))
      (then (f64.reinterpret_i64 (i64.const ${UNDEF_NAN})))
      (else
        (f64.load
          (i32.add
            (call $__ptr_offset (local.get $ptr))
            (i32.shl (local.get $i) (i32.const 3)))))))`

  ctx.core.stdlib['__typed_idx'] = `(func $__typed_idx (param $ptr f64) (param $i i32) (result f64)
    (local $off i32) (local $et i32) (local $len i32)
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (local.set $len (call $__len (local.get $ptr)))
    (if (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (local.get $len)))
      (then (f64.reinterpret_i64 (i64.const ${UNDEF_NAN})))
      (else
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
          (else (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))))))`

  // Array.from(src) — shallow copy of array (memory.copy of f64 elements)
  ctx.core.stdlib['__arr_from'] = `(func $__arr_from (param $src f64) (result f64)
    (local $len i32) (local $dst i32)
    (local.set $len (call $__len (local.get $src)))
    (local.set $dst (call $__alloc_hdr (local.get $len) (local.get $len) (i32.const 8)))
    (memory.copy (local.get $dst) (call $__ptr_offset (local.get $src)) (i32.shl (local.get $len) (i32.const 3)))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $dst)))`

  ctx.core.emit['Array.from'] = (src) => {
    inc('__arr_from')
    return typed(['call', '$__arr_from', asF64(emit(src))], 'f64')
  }

  // Grow array if capacity insufficient. Returns (possibly new) NaN-boxed pointer.
  // Old storage is left behind as a forwarding header so existing aliases keep
  // seeing the current backing store after growth.
  ctx.core.stdlib['__arr_grow'] = `(func $__arr_grow (param $ptr f64) (param $minCap i32) (result f64)
    (local $t i32) (local $off i32) (local $oldCap i32) (local $newCap i32) (local $newOff i32) (local $len i32)
    (local.set $t (call $__ptr_type (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    ;; Defensive path: invalid/non-array pointer -> create fresh array buffer.
    (if
      (i32.or
        (i32.ne (local.get $t) (i32.const ${PTR.ARRAY}))
        (i32.lt_u (local.get $off) (i32.const 8)))
      (then
        (local.set $newCap (select (local.get $minCap) (i32.const 4) (i32.gt_s (local.get $minCap) (i32.const 4))))
        (local.set $newOff (call $__alloc_hdr (i32.const 0) (local.get $newCap) (i32.const 8)))
        (return (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $newOff)))))
    (local.set $oldCap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (if (i32.ge_s (local.get $oldCap) (local.get $minCap))
      (then (return (local.get $ptr))))
    (local.set $newCap (select
      (local.get $minCap)
      (i32.shl (local.get $oldCap) (i32.const 1))
      (i32.gt_s (local.get $minCap) (i32.shl (local.get $oldCap) (i32.const 1)))))
    (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
    (local.set $newOff (call $__alloc_hdr (local.get $len) (local.get $newCap) (i32.const 8)))
    (memory.copy (local.get $newOff) (local.get $off) (i32.shl (local.get $len) (i32.const 3)))
    (call $__dyn_move (local.get $off) (local.get $newOff))
    (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newOff))
    (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $newOff)))`

  ctx.core.stdlib['__arr_set_idx_ptr'] = `(func $__arr_set_idx_ptr (param $ptr f64) (param $i i32) (param $val f64) (result f64)
    (local $len i32)
    (if (i32.lt_s (local.get $i) (i32.const 0))
      (then (return (local.get $ptr))))
    (local.set $len (call $__len (local.get $ptr)))
    (if (i32.ge_u (local.get $i) (local.get $len))
      (then
        (local.set $ptr (call $__arr_grow (local.get $ptr) (i32.add (local.get $i) (i32.const 1))))
        (call $__set_len (local.get $ptr) (i32.add (local.get $i) (i32.const 1)))))
    (f64.store
      (i32.add (call $__ptr_offset (local.get $ptr)) (i32.shl (local.get $i) (i32.const 3)))
      (local.get $val))
    (local.get $ptr))`

  // === Array literal ===

  ctx.core.emit['['] = (...elems) => {
    const hasSpread = elems.some(e => Array.isArray(e) && e[0] === '...')

    if (!hasSpread) {
      const len = elems.length
      const { local: t, setup } = allocArray(len, Math.max(len, 4))  // min cap=4 for small pushes
      const body = [...setup]
      for (let i = 0; i < len; i++)
        body.push(['f64.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]], asF64(emit(elems[i]))])
      body.push(['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${t}`]])
      return typed(['block', ['result', 'f64'], ...body], 'f64')
    }

    const { local: off, setup } = allocArray(0, Math.max(elems.length, 4))
    const out = `${T}sa${ctx.func.uniq++}`, pos = `${T}sp${ctx.func.uniq++}`
    ctx.func.locals.set(out, 'f64'); ctx.func.locals.set(pos, 'i32')
    inc('__arr_set_idx_ptr')

    const body = [
      ...setup,
      ['local.set', `$${out}`, ['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${off}`]]],
      ['local.set', `$${pos}`, ['i32.const', 0]],
    ]

    for (const e of elems) {
      if (Array.isArray(e) && e[0] === '...') {
        const src = `${T}ss${ctx.func.uniq++}`, slen = `${T}sl${ctx.func.uniq++}`, si = `${T}si${ctx.func.uniq++}`
        ctx.func.locals.set(src, 'f64'); ctx.func.locals.set(slen, 'i32'); ctx.func.locals.set(si, 'i32')
        const id = ctx.func.uniq++
        const spreadVal = multiCount(e[1]) ? materializeMulti(e[1]) : asF64(emit(e[1]))
        const spreadItem = ctx.module.modules['string']
          ? ['if', ['result', 'f64'],
            ['i32.or',
              ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${src}`]], ['i32.const', PTR.STRING]],
              ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${src}`]], ['i32.const', PTR.SSO]]],
            ['then', (inc('__str_idx'), ['call', '$__str_idx', ['local.get', `$${src}`], ['local.get', `$${si}`]])],
            ['else', (inc('__typed_idx'), ['call', '$__typed_idx', ['local.get', `$${src}`], ['local.get', `$${si}`]])]]
          : (inc('__typed_idx'), ['call', '$__typed_idx', ['local.get', `$${src}`], ['local.get', `$${si}`]])

        body.push(
          ['local.set', `$${src}`, spreadVal],
          ['local.set', `$${slen}`, ['call', '$__len', ['local.get', `$${src}`]]],
          ['local.set', `$${si}`, ['i32.const', 0]],
          ['block', `$brk${id}`, ['loop', `$loop${id}`,
            ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${si}`], ['local.get', `$${slen}`]]],
            ['local.set', `$${out}`, ['call', '$__arr_set_idx_ptr', ['local.get', `$${out}`], ['local.get', `$${pos}`], spreadItem]],
            ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
            ['local.set', `$${si}`, ['i32.add', ['local.get', `$${si}`], ['i32.const', 1]]],
            ['br', `$loop${id}`]]])
      } else {
        body.push(
          ['local.set', `$${out}`, ['call', '$__arr_set_idx_ptr', ['local.get', `$${out}`], ['local.get', `$${pos}`], asF64(emit(e))]],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]])
      }
    }

    body.push(['local.get', `$${out}`])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // === Index read ===

  ctx.core.emit['[]'] = (arr, idx) => {
    const keyType = typeof idx === 'string'
      ? (ctx.func.valTypes?.get(idx) || ctx.scope.globalValTypes?.get(idx))
      : valTypeOf(idx)
    const useRuntimeKeyDispatch = keyType == null || (typeof idx === 'string' && keyType !== VAL.STRING)
    // TypedArray: type-aware load
    if (typeof arr === 'string' && ctx.func.valTypes?.get(arr) === 'typed' && ctx.core.emit['.typed:[]']) {
      const r = ctx.core.emit['.typed:[]'](arr, idx)
      if (r) return r
    }
    // Multi-value calls are materialized at call site (see '()' handler), so
    // func()[i] works naturally — func() returns a heap array pointer, [i] indexes it.
    const vt = typeof arr === 'string'
      ? (ctx.func.valTypes?.get(arr) || ctx.scope.globalValTypes?.get(arr))
      : valTypeOf(arr)
    const va = emit(arr), vi = asI32(emit(idx))
    const ptrExpr = asF64(va)
    const dynLoad = (objExpr, keyExpr) => {
      inc('__dyn_get')
      return ['call', '$__dyn_get', objExpr, keyExpr]
    }
    const stringLoad = () => (inc('__str_idx'), ['call', '$__str_idx', ptrExpr, vi])
    const arrayLoad = (inc('__typed_idx'), ['call', '$__typed_idx', ptrExpr, vi])
    const emitDynamicKeyDispatch = (objExpr, numericLoad) => {
      const keyTmp = temp()
      ctx.func.locals.set(keyTmp, 'f64')
      inc('__is_str_key')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${keyTmp}`, asF64(emit(idx))],
        ['if', ['result', 'f64'], ['call', '$__is_str_key', ['local.get', `$${keyTmp}`]],
          ['then', dynLoad(objExpr, ['local.get', `$${keyTmp}`])],
          ['else', numericLoad(['local.get', `$${keyTmp}`])]]], 'f64')
    }
    // Boxed object: string keys address the box, numeric keys address the inner array.
    if (typeof arr === 'string' && ctx.schema.isBoxed?.(arr)) {
      const inner = ctx.schema.emitInner(arr)
      if (keyType === VAL.STRING) return typed(dynLoad(asF64(emit(arr)), asF64(emit(idx))), 'f64')
      if (useRuntimeKeyDispatch)
        return emitDynamicKeyDispatch(asF64(emit(arr)), keyExpr =>
          ['f64.load', ['i32.add', ['call', '$__ptr_offset', inner], ['i32.shl', asI32(typed(keyExpr, 'f64')), ['i32.const', 3]]]])
      return typed(
        ['f64.load', ['i32.add', ['call', '$__ptr_offset', inner], ['i32.shl', vi, ['i32.const', 3]]]],
        'f64')
    }
    // Known array → direct f64 element load, skip string check
    if (keyType === VAL.STRING)
      return typed(dynLoad(ptrExpr, asF64(emit(idx))), 'f64')
    if (vt === 'array') {
      const baseTmp = temp()
      ctx.func.locals.set(baseTmp, 'f64')
      return useRuntimeKeyDispatch
        ? typed(['block', ['result', 'f64'],
          ['local.set', `$${baseTmp}`, ptrExpr],
          emitDynamicKeyDispatch(typed(['local.get', `$${baseTmp}`], 'f64'), keyExpr => {
            const keyI32 = asI32(typed(keyExpr, 'f64'))
            return (inc('__typed_idx'), ['call', '$__typed_idx', ['local.get', `$${baseTmp}`], keyI32])
          })], 'f64')
        : typed(['block', ['result', 'f64'],
          ['local.set', `$${baseTmp}`, ptrExpr],
          (inc('__typed_idx'), ['call', '$__typed_idx', ['local.get', `$${baseTmp}`], vi])], 'f64')
    }
    // Known string → single-char SSO string
    if (vt === 'string')
      return typed(stringLoad(), 'f64')
    if (useRuntimeKeyDispatch)
      return emitDynamicKeyDispatch(ptrExpr, keyExpr => {
        const keyI32 = asI32(typed(keyExpr, 'f64'))
        if (ctx.module.modules['string']) {
          return ['if', ['result', 'f64'],
            ['i32.or',
              ['i32.eq', ['call', '$__ptr_type', ptrExpr], ['i32.const', PTR.STRING]],
              ['i32.eq', ['call', '$__ptr_type', ptrExpr], ['i32.const', PTR.SSO]]],
            ['then', (inc('__str_idx'), ['call', '$__str_idx', ptrExpr, keyI32])],
            ['else', (inc('__typed_idx'), ['call', '$__typed_idx', ptrExpr, keyI32])]]
        }
        return (inc('__typed_idx'), ['call', '$__typed_idx', ptrExpr, keyI32])
      })
    // Unknown → runtime dispatch (string module loaded → check ptr_type)
    if (ctx.module.modules['string'])
      return typed(
        ['if', ['result', 'f64'],
          ['i32.or',
            ['i32.eq', ['call', '$__ptr_type', ptrExpr], ['i32.const', PTR.STRING]],
            ['i32.eq', ['call', '$__ptr_type', ptrExpr], ['i32.const', PTR.SSO]]],
          ['then', stringLoad()],
          ['else', arrayLoad]],
        'f64')
    return typed(arrayLoad, 'f64')
  }

  // === Push/Pop (mutate in place) ===

  // .push(val) → append, increment len, return array (possibly reallocated pointer)
  ctx.core.emit['.push'] = (arr, ...vals) => {
    inc('__arr_grow')
    const va = asF64(emit(arr))
    const t = `${T}pp${ctx.func.uniq++}`, len = `${T}pl${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'f64'); ctx.func.locals.set(len, 'i32')

    const body = [
      ['local.set', `$${t}`, va],
      ['local.set', `$${len}`, ['call', '$__len', ['local.get', `$${t}`]]],
      // Grow if needed: ensure cap >= len + vals.length
      ['local.set', `$${t}`, ['call', '$__arr_grow', ['local.get', `$${t}`],
        ['i32.add', ['local.get', `$${len}`], ['i32.const', vals.length]]]],
    ]

    // Store each value and increment len
    for (const val of vals) {
      const vv = asF64(emit(val))
      body.push(
        ['f64.store',
          ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]],
          vv],
        ['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['i32.const', 1]]]
      )
    }

    // Update length header, update source variable (pointer may have changed from grow), return new length
    body.push(['call', '$__set_len', ['local.get', `$${t}`], ['local.get', `$${len}`]])
    // Update the source variable if it's a named variable (so arr still points to valid memory)
    if (typeof arr === 'string') {
      if (ctx.func.boxed?.has(arr)) {
        body.push(['f64.store', ['local.get', `$${ctx.func.boxed.get(arr)}`], ['local.get', `$${t}`]])
      }
      else if (ctx.scope.globals.has(arr) && !ctx.func.locals?.has(arr))
        body.push(['global.set', `$${arr}`, ['local.get', `$${t}`]])
      else
        body.push(['local.set', `$${arr}`, ['local.get', `$${t}`]])
    }
    body.push(['f64.convert_i32_s', ['local.get', `$${len}`]])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // .pop() → decrement len, return removed element
  ctx.core.emit['.pop'] = (arr) => {
    const va = asF64(emit(arr))
    const t = `${T}po${ctx.func.uniq++}`, len = `${T}pl${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'f64'); ctx.func.locals.set(len, 'i32')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, va],
      ['local.set', `$${len}`, ['i32.sub', ['call', '$__len', ['local.get', `$${t}`]], ['i32.const', 1]]],
      ['call', '$__set_len', ['local.get', `$${t}`], ['local.get', `$${len}`]],
      ['f64.load',
        ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]]], 'f64')
  }

  // .shift() → remove first element, shift remaining left, return removed
  ctx.core.emit['.shift'] = (arr) => {
    inc('__arr_shift')
    return typed(['call', '$__arr_shift', asF64(emit(arr))], 'f64')
  }

  ctx.core.stdlib['__arr_shift'] = `(func $__arr_shift (param $arr f64) (result f64)
    (local $off i32) (local $len i32) (local $val f64)
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__len (local.get $arr)))
    (if (result f64) (i32.le_s (local.get $len) (i32.const 0))
      (then (f64.const 0))
      (else
        (local.set $val (f64.load (local.get $off)))
        (memory.copy
          (local.get $off)
          (i32.add (local.get $off) (i32.const 8))
          (i32.shl (i32.sub (local.get $len) (i32.const 1)) (i32.const 3)))
        (call $__set_len (local.get $arr) (i32.sub (local.get $len) (i32.const 1)))
        (local.get $val))))`

  // .unshift(val) → prepend element, shift existing right
  ctx.core.emit['.unshift'] = (arr, val) => {
    inc('__arr_unshift')
    return typed(['call', '$__arr_unshift', asF64(emit(arr)), asF64(emit(val))], 'f64')
  }

  ctx.core.stdlib['__arr_unshift'] = `(func $__arr_unshift (param $arr f64) (param $val f64) (result f64)
    (local $off i32) (local $len i32)
    (local.set $arr (call $__arr_grow (local.get $arr) (i32.add (call $__len (local.get $arr)) (i32.const 1))))
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__len (local.get $arr)))
    (memory.copy
      (i32.add (local.get $off) (i32.const 8))
      (local.get $off)
      (i32.shl (local.get $len) (i32.const 3)))
    (f64.store (local.get $off) (local.get $val))
    (call $__set_len (local.get $arr) (i32.add (local.get $len) (i32.const 1)))
    (f64.convert_i32_s (i32.add (local.get $len) (i32.const 1))))`

  // .some(fn) → return 1 if any element passes, else 0 (early exit)
  ctx.core.emit['.some'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const r = `${T}sr${ctx.func.uniq++}`
    ctx.func.locals.set(r, 'f64')
    const exit = `$exit${ctx.func.uniq++}`
    const cb = hoistCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', (inc('__is_truthy'), ['call', '$__is_truthy', asF64(ctx.closure.call(cb.value, [item, typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')]))]),
        ['then', ['local.set', `$${r}`, ['f64.const', 1]], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${r}`, ['f64.const', 0]],
      ['block', exit, ...loop],
      ['local.get', `$${r}`]], 'f64')
  }

  // .every(fn) → return 1 if all elements pass, else 0 (early exit)
  ctx.core.emit['.every'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const r = `${T}ev${ctx.func.uniq++}`
    ctx.func.locals.set(r, 'f64')
    const exit = `$exit${ctx.func.uniq++}`
    const cb = hoistCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', ['i32.eqz', (inc('__is_truthy'), ['call', '$__is_truthy', asF64(ctx.closure.call(cb.value, [item, typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')]))])],
        ['then', ['local.set', `$${r}`, ['f64.const', 0]], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${r}`, ['f64.const', 1]],
      ['block', exit, ...loop],
      ['local.get', `$${r}`]], 'f64')
  }

  // .findIndex(fn) → return index of first matching element, or -1 (early exit)
  ctx.core.emit['.findIndex'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const r = `${T}fi${ctx.func.uniq++}`
    ctx.func.locals.set(r, 'f64')
    const exit = `$exit${ctx.func.uniq++}`
    const cb = hoistCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', (inc('__is_truthy'), ['call', '$__is_truthy', asF64(ctx.closure.call(cb.value, [item, typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')]))]),
        ['then', ['local.set', `$${r}`, ['f64.convert_i32_s', ['local.get', `$${i}`]]], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${r}`, ['f64.const', -1]],
      ['block', exit, ...loop],
      ['local.get', `$${r}`]], 'f64')
  }

  // === Array methods ===

  ctx.core.emit['.map'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const out = `${T}mo${ctx.func.uniq++}`, len = `${T}ml${ctx.func.uniq++}`
    ctx.func.locals.set(out, 'i32'); ctx.func.locals.set(len, 'i32')
    const cb = hoistCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      elemStore(out, i, asF64(ctx.closure.call(cb.value, [item, typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')])))
    ])
    // Allocate header + data for result
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${len}`, ['call', '$__len', recv.value]],
      ['local.set', `$${out}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]]],
      ['i32.store', ['local.get', `$${out}`], ['local.get', `$${len}`]],  // len
      ['i32.store', ['i32.add', ['local.get', `$${out}`], ['i32.const', 4]], ['local.get', `$${len}`]],  // cap
      ['local.set', `$${out}`, ['i32.add', ['local.get', `$${out}`], ['i32.const', 8]]],
      ...loop,
      ['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${out}`]]], 'f64')
  }

  ctx.core.emit['.filter'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const out = `${T}fo${ctx.func.uniq++}`, count = `${T}fc${ctx.func.uniq++}`, maxLen = `${T}fm${ctx.func.uniq++}`
    ctx.func.locals.set(out, 'i32'); ctx.func.locals.set(count, 'i32'); ctx.func.locals.set(maxLen, 'i32')
    const cb = hoistCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', (inc('__is_truthy'), ['call', '$__is_truthy', asF64(ctx.closure.call(cb.value, [item, typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')]))]),
        ['then',
          ['f64.store', ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${count}`], ['i32.const', 3]]], item],
          ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${maxLen}`, ['call', '$__len', recv.value]],
      ['local.set', `$${out}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', ['local.get', `$${maxLen}`], ['i32.const', 3]]]]],
      ['i32.store', ['local.get', `$${out}`], ['i32.const', 0]],  // len=0 initially
      ['i32.store', ['i32.add', ['local.get', `$${out}`], ['i32.const', 4]], ['local.get', `$${maxLen}`]],  // cap
      ['local.set', `$${out}`, ['i32.add', ['local.get', `$${out}`], ['i32.const', 8]]],
      ['local.set', `$${count}`, ['i32.const', 0]],
      ...loop,
      // Set actual length
      ['i32.store', ['i32.sub', ['local.get', `$${out}`], ['i32.const', 8]], ['local.get', `$${count}`]],
      ['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${out}`]]], 'f64')
  }

  ctx.core.emit['.reduce'] = (arr, fn, init) => {
    const recv = hoistArrayValue(arr)
    const acc = `${T}ra${ctx.func.uniq++}`
    ctx.func.locals.set(acc, 'f64')
    const cb = hoistCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, _i, item) => [
      ['local.set', `$${acc}`, asF64(ctx.closure.call(cb.value, [typed(['local.get', `$${acc}`], 'f64'), item]))]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${acc}`, init ? asF64(emit(init)) : ['f64.const', 0]],
      ...loop,
      ['local.get', `$${acc}`]], 'f64')
  }

  ctx.core.emit['.forEach'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const tmp = `${T}ft${ctx.func.uniq++}`
    ctx.func.locals.set(tmp, 'f64')
    const cb = hoistCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['local.set', `$${tmp}`, asF64(ctx.closure.call(cb.value, [item, typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')]))]
    ])
    return typed(['block', ['result', 'f64'], recv.setup, cb.setup, ...loop, ['f64.const', 0]], 'f64')
  }

  ctx.core.emit['.find'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    const result = `${T}ff${ctx.func.uniq++}`
    ctx.func.locals.set(result, 'f64')
    const exit = `$exit${ctx.func.uniq++}`
    const cb = hoistCallback(fn)
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', (inc('__is_truthy'), ['call', '$__is_truthy', asF64(ctx.closure.call(cb.value, [item, typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')]))]),
        ['then', ['local.set', `$${result}`, item], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ['local.set', `$${result}`, ['f64.reinterpret_i64', ['i64.const', NULL_NAN]]],
      ['block', exit, ...loop],
      ['local.get', `$${result}`]], 'f64')
  }

  ctx.core.emit['.indexOf'] = (arr, val) => {
    const recv = hoistArrayValue(arr)
    const vv = asF64(emit(val))
    const result = `${T}ix${ctx.func.uniq++}`
    ctx.func.locals.set(result, 'i32')
    const exit = `$exit${ctx.func.uniq++}`
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', ['f64.eq', item, vv],
        ['then', ['local.set', `$${result}`, ['local.get', `$${i}`]], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ['local.set', `$${result}`, ['i32.const', -1]],
      ['block', exit, ...loop],
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }

  ctx.core.emit['.includes'] = (arr, val) => {
    const recv = hoistArrayValue(arr)
    const vv = asF64(emit(val))
    const result = `${T}ic${ctx.func.uniq++}`
    ctx.func.locals.set(result, 'i32')
    const exit = `$exit${ctx.func.uniq++}`
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', ['f64.eq', item, vv],
        ['then', ['local.set', `$${result}`, ['i32.const', 1]], ['br', exit]]]
    ])
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ['local.set', `$${result}`, ['i32.const', 0]],
      ['block', exit, ...loop],
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }

  // .at(i) → array element with negative index support
  ctx.core.emit['.array:at'] = (arr, idx) => {
    const t = `${T}ai${ctx.func.uniq++}`, a = `${T}aa${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'i32'); ctx.func.locals.set(a, 'f64')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${a}`, asF64(emit(arr))],
      ['local.set', `$${t}`, asI32(emit(idx))],
      // Negative index: t += length
      ['if', ['i32.lt_s', ['local.get', `$${t}`], ['i32.const', 0]],
        ['then', ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`],
          ['call', '$__len', ['local.get', `$${a}`]]]]]],
      ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${a}`]],
        ['i32.shl', ['local.get', `$${t}`], ['i32.const', 3]]]]], 'f64')
  }

  ctx.core.emit['.slice'] = (arr, start, end) => {
    const recv = hoistArrayValue(arr)
    const vs = asI32(emit(start))
    const ve = end ? asI32(emit(end)) : ['call', '$__len', recv.value]
    const out = `${T}so${ctx.func.uniq++}`, len = `${T}sl${ctx.func.uniq++}`, j = `${T}sj${ctx.func.uniq++}`, ptr = `${T}sp${ctx.func.uniq++}`
    ctx.func.locals.set(out, 'i32'); ctx.func.locals.set(len, 'i32'); ctx.func.locals.set(j, 'i32'); ctx.func.locals.set(ptr, 'i32')
    const id = ctx.func.uniq++
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', recv.value]],
      ['local.set', `$${len}`, ['i32.sub', ve, vs]],
      // Alloc header + data
      ['local.set', `$${out}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]]],
      ['i32.store', ['local.get', `$${out}`], ['local.get', `$${len}`]],
      ['i32.store', ['i32.add', ['local.get', `$${out}`], ['i32.const', 4]], ['local.get', `$${len}`]],
      ['local.set', `$${out}`, ['i32.add', ['local.get', `$${out}`], ['i32.const', 8]]],
      ['local.set', `$${j}`, ['i32.const', 0]],
      ['block', `$brk${id}`, ['loop', `$loop${id}`,
        ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${j}`], ['local.get', `$${len}`]]],
        ['f64.store',
          ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${j}`], ['i32.const', 3]]],
          ['f64.load', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['i32.add', vs, ['local.get', `$${j}`]], ['i32.const', 3]]]]],
        ['local.set', `$${j}`, ['i32.add', ['local.get', `$${j}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]],
      ['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${out}`]]], 'f64')
  }

  // .concat(...others) → concatenate arrays
  ctx.core.emit['.array:concat'] = (arr, ...others) => {
    const result = `${T}res${ctx.func.uniq++}`, len = `${T}len${ctx.func.uniq++}`, pos = `${T}pos${ctx.func.uniq++}`
    ctx.func.locals.set(result, 'i32')
    ctx.func.locals.set(len, 'i32')
    ctx.func.locals.set(pos, 'i32')

    const recv = hoistArrayValue(arr)
    const va = recv.value

    // Calculate total length
    const body = [
      recv.setup,
      ['local.set', `$${len}`, ['call', '$__len', va]],
    ]

    const otherVals = []
    for (const other of others) {
      const vo = asF64(emit(other))
      otherVals.push(vo)
      body.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['call', '$__len', vo]]])
    }

    // Allocate result array
    body.push(
      ['local.set', `$${result}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]]],
      ['i32.store', ['local.get', `$${result}`], ['local.get', `$${len}`]],
      ['i32.store', ['i32.add', ['local.get', `$${result}`], ['i32.const', 4]], ['local.get', `$${len}`]],
      ['local.set', `$${result}`, ['i32.add', ['local.get', `$${result}`], ['i32.const', 8]]]
    )

    // Copy source array
    body.push(
      ['local.set', `$${pos}`, ['i32.const', 0]],
      ['local.set', `$${len}`, ['call', '$__len', va]]
    )
    const id = ctx.func.uniq++
    body.push(
      ['block', `$done${id}`, ['loop', `$loop${id}`,
        ['br_if', `$done${id}`, ['i32.ge_s', ['local.get', `$${pos}`], ['local.get', `$${len}`]]],
        ['f64.store',
          ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]],
          ['f64.load', ['i32.add', ['call', '$__ptr_offset', va], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]]]],
        ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]]
    )

    // Copy each other array
    let offset = `${T}off${ctx.func.uniq++}`
    ctx.func.locals.set(offset, 'i32')
    body.push(['local.set', `$${offset}`, ['call', '$__len', va]])

    for (let i = 0; i < otherVals.length; i++) {
      const vo = otherVals[i]
      const id2 = ctx.func.uniq++
      body.push(
        ['local.set', `$${pos}`, ['i32.const', 0]],
        ['local.set', `$${len}`, ['call', '$__len', vo]],
        ['block', `$done${id2}`, ['loop', `$loop${id2}`,
          ['br_if', `$done${id2}`, ['i32.ge_s', ['local.get', `$${pos}`], ['local.get', `$${len}`]]],
          ['f64.store',
            ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['i32.add', ['local.get', `$${offset}`], ['local.get', `$${pos}`]], ['i32.const', 3]]],
            ['f64.load', ['i32.add', ['call', '$__ptr_offset', vo], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]]]],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
          ['br', `$loop${id2}`]]],
        ['local.set', `$${offset}`, ['i32.add', ['local.get', `$${offset}`], ['local.get', `$${len}`]]]
      )
    }

    body.push(['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${result}`]])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // .flat() → flatten one level of nested arrays
  ctx.core.stdlib['__arr_flat'] = `(func $__arr_flat (param $src f64) (result f64)
    (local $len i32) (local $off i32) (local $i i32) (local $total i32) (local $dst i32) (local $pos i32)
    (local $elem f64) (local $subLen i32) (local $subOff i32) (local $j i32)
    (local.set $off (call $__ptr_offset (local.get $src)))
    (local.set $len (call $__len (local.get $src)))
    ;; First pass: count total elements
    (local.set $total (i32.const 0)) (local.set $i (i32.const 0))
    (block $c1 (loop $cl1
      (br_if $c1 (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $elem (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
      (if (i32.and (f64.ne (local.get $elem) (local.get $elem))
        (i32.eq (call $__ptr_type (local.get $elem)) (i32.const ${PTR.ARRAY})))
        (then (local.set $total (i32.add (local.get $total) (call $__len (local.get $elem)))))
        (else (local.set $total (i32.add (local.get $total) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cl1)))
    ;; Allocate result
    (local.set $dst (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $total) (i32.const 3)))))
    (i32.store (local.get $dst) (local.get $total))
    (i32.store (i32.add (local.get $dst) (i32.const 4)) (local.get $total))
    (local.set $dst (i32.add (local.get $dst) (i32.const 8)))
    ;; Second pass: copy
    (local.set $pos (i32.const 0)) (local.set $i (i32.const 0))
    (block $c2 (loop $cl2
      (br_if $c2 (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $elem (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
      (if (i32.and (f64.ne (local.get $elem) (local.get $elem))
        (i32.eq (call $__ptr_type (local.get $elem)) (i32.const ${PTR.ARRAY})))
        (then
          (local.set $subOff (call $__ptr_offset (local.get $elem)))
          (local.set $subLen (call $__len (local.get $elem)))
          (local.set $j (i32.const 0))
          (block $s (loop $sl
            (br_if $s (i32.ge_s (local.get $j) (local.get $subLen)))
            (f64.store (i32.add (local.get $dst) (i32.shl (local.get $pos) (i32.const 3)))
              (f64.load (i32.add (local.get $subOff) (i32.shl (local.get $j) (i32.const 3)))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $sl))))
        (else
          (f64.store (i32.add (local.get $dst) (i32.shl (local.get $pos) (i32.const 3))) (local.get $elem))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cl2)))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $dst)))`

  ctx.core.emit['.flat'] = (arr) => {
    inc('__arr_flat')
    return typed(['call', '$__arr_flat', asF64(emit(arr))], 'f64')
  }

  // .flatMap(fn) → map then flatten
  ctx.core.emit['.flatMap'] = (arr, fn) => {
    // Desugar: arr.map(fn).flat()
    const mapped = ctx.core.emit['.map'](arr, fn)
    inc('__arr_flat')
    return typed(['call', '$__arr_flat', asF64(mapped)], 'f64')
  }

  // .join(sep) → concatenate array elements with separator string
  ctx.core.emit['.join'] = (arr, sep) => {
    inc('__str_join')
    return typed(['call', '$__str_join', asF64(emit(arr)), asF64(emit(sep))], 'f64')
  }
}
