/**
 * Array module — literals, indexing, methods.
 *
 * Type=1 (ARRAY): inline length in aux bits (≤32767 elements).
 * Elements stored as sequential f64 in linear memory.
 *
 * Methods (.map, .filter, .reduce, etc.) use closures via fn module.
 *
 * @module array
 */

import { emit, typed, asF64, asI32 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const ARRAY = 1, STRING = 4, STRING_SSO = 5

/** Emit a loop that iterates over array elements. Helper for methods. */
function arrayLoop(arrExpr, bodyFn) {
  // bodyFn(ptrLocal, lenLocal, iLocal) → [...body instructions]
  const ptr = `__ap${ctx.uid++}`, len = `__al${ctx.uid++}`, i = `__ai${ctx.uid++}`
  ctx.locals.set(ptr, 'i32')
  ctx.locals.set(len, 'i32')
  ctx.locals.set(i, 'i32')
  const id = ctx.uid++
  const brk = `$brk${id}`, loop = `$loop${id}`

  return [
    ['local.set', `$${ptr}`, ['call', '$__ptr_offset', asF64(arrExpr)]],
    ['local.set', `$${len}`, ['call', '$__ptr_aux', asF64(arrExpr)]],
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', brk, ['loop', loop,
      ['br_if', brk, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
      ...bodyFn(ptr, len, i),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', loop]]],
  ]
}

/** Read element i from array pointer offset. */
function elemLoad(ptr, i) {
  return ['f64.load', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]
}

/** Store f64 value at element i of array pointer offset. */
function elemStore(ptr, i, val) {
  return ['f64.store', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]], val]
}

export default () => {
  // Array literal: [a, b, c] → allocate, fill, return NaN-boxed pointer
  ctx.emit['['] = (...elems) => {
    const len = elems.length
    const t = `__arr${ctx.uid++}`
    ctx.locals.set(t, 'i32')

    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', len * 8]]],
    ]
    for (let i = 0; i < len; i++)
      body.push(['f64.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]], asF64(emit(elems[i]))])
    body.push(['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', len], ['local.get', `$${t}`]])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // Index read: arr[i] or str[i]
  ctx.emit['[]'] = (arr, idx) => {
    const va = emit(arr), vi = asI32(emit(idx))
    const ptrExpr = asF64(va)

    if (ctx.modules['string'])
      return typed(
        ['if', ['result', 'f64'],
          ['i32.ge_u', ['call', '$__ptr_type', ptrExpr], ['i32.const', STRING]],
          ['then', ['f64.convert_i32_u', ['call', '$__char_at', ptrExpr, vi]]],
          ['else', ['f64.load', ['i32.add', ['call', '$__ptr_offset', ptrExpr], ['i32.shl', vi, ['i32.const', 3]]]]]],
        'f64')

    return typed(
      ['f64.load', ['i32.add', ['call', '$__ptr_offset', ptrExpr], ['i32.shl', vi, ['i32.const', 3]]]],
      'f64')
  }

  // === Array methods (registered as .methodName emitters) ===

  // .map(fn) → new array where each element = fn(elem)
  ctx.emit['.map'] = (arr, fn) => {
    const va = emit(arr)
    const out = `__mo${ctx.uid++}`
    ctx.locals.set(out, 'i32')
    const len = `__ml${ctx.uid++}`
    ctx.locals.set(len, 'i32')

    const loop = arrayLoop(va, (ptr, _len, i) => [
      elemStore(out, i, asF64(ctx.callClosure(emit(fn), [typed(elemLoad(ptr, i), 'f64')])))
    ])

    return typed(['block', ['result', 'f64'],
      ['local.set', `$${len}`, ['call', '$__ptr_aux', asF64(va)]],
      ['local.set', `$${out}`, ['call', '$__alloc', ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]],
      ...loop,
      ['call', '$__mkptr', ['i32.const', ARRAY], ['local.get', `$${len}`], ['local.get', `$${out}`]]], 'f64')
  }

  // .filter(fn) → new array with elements where fn(elem) is truthy
  ctx.emit['.filter'] = (arr, fn) => {
    const va = emit(arr)
    const out = `__fo${ctx.uid++}`, count = `__fc${ctx.uid++}`
    ctx.locals.set(out, 'i32')
    ctx.locals.set(count, 'i32')

    const loop = arrayLoop(va, (ptr, _len, i) => [
      ['if', ['f64.ne', asF64(ctx.callClosure(emit(fn), [typed(elemLoad(ptr, i), 'f64')])), ['f64.const', 0]],
        ['then',
          ['f64.store', ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${count}`], ['i32.const', 3]]], elemLoad(ptr, i)],
          ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
    ])

    // Allocate max-size, fill, return with actual count
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${out}`, ['call', '$__alloc', ['i32.shl', ['call', '$__ptr_aux', asF64(va)], ['i32.const', 3]]]],
      ['local.set', `$${count}`, ['i32.const', 0]],
      ...loop,
      ['call', '$__mkptr', ['i32.const', ARRAY], ['local.get', `$${count}`], ['local.get', `$${out}`]]], 'f64')
  }

  // .reduce(fn, init) → fold: fn(acc, elem) for each element
  ctx.emit['.reduce'] = (arr, fn, init) => {
    const va = emit(arr)
    const acc = `__ra${ctx.uid++}`
    ctx.locals.set(acc, 'f64')

    const loop = arrayLoop(va, (ptr, _len, i) => [
      ['local.set', `$${acc}`, asF64(ctx.callClosure(emit(fn), [typed(['local.get', `$${acc}`], 'f64'), typed(elemLoad(ptr, i), 'f64')]))]
    ])

    return typed(['block', ['result', 'f64'],
      ['local.set', `$${acc}`, init ? asF64(emit(init)) : ['f64.const', 0]],
      ...loop,
      ['local.get', `$${acc}`]], 'f64')
  }

  // .forEach(fn) → call fn(elem) for each, returns 0
  ctx.emit['.forEach'] = (arr, fn) => {
    const va = emit(arr)
    const tmp = `__ft${ctx.uid++}`
    ctx.locals.set(tmp, 'f64')
    const loop = arrayLoop(va, (ptr, _len, i) => [
      // Call closure, discard result by storing in temp
      ['local.set', `$${tmp}`, asF64(ctx.callClosure(emit(fn), [typed(elemLoad(ptr, i), 'f64')]))]
    ])
    return typed(['block', ['result', 'f64'], ...loop, ['f64.const', 0]], 'f64')
  }

  // .find(fn) → first element where fn(elem) truthy, else 0
  ctx.emit['.find'] = (arr, fn) => {
    const va = emit(arr)
    const result = `__ff${ctx.uid++}`, found = `__fd${ctx.uid++}`
    ctx.locals.set(result, 'f64')
    ctx.locals.set(found, 'i32')

    const loop = arrayLoop(va, (ptr, _len, i) => [
      // Only check if not already found
      ['if', ['i32.eqz', ['local.get', `$${found}`]],
        ['then',
          ['if', ['f64.ne', asF64(ctx.callClosure(emit(fn), [typed(elemLoad(ptr, i), 'f64')])), ['f64.const', 0]],
            ['then',
              ['local.set', `$${result}`, elemLoad(ptr, i)],
              ['local.set', `$${found}`, ['i32.const', 1]]]]]]
    ])

    return typed(['block', ['result', 'f64'],
      ['local.set', `$${result}`, ['f64.const', 0]],
      ['local.set', `$${found}`, ['i32.const', 0]],
      ...loop,
      ['local.get', `$${result}`]], 'f64')
  }

  // .indexOf(val) → index of first match, or -1
  ctx.emit['.indexOf'] = (arr, val) => {
    const va = emit(arr), vv = asF64(emit(val))
    const result = `__ix${ctx.uid++}`
    ctx.locals.set(result, 'i32')

    const loop = arrayLoop(va, (ptr, _len, i) => [
      ['if', ['f64.eq', elemLoad(ptr, i), vv],
        ['then', ['local.set', `$${result}`, ['local.get', `$${i}`]]]]
    ])

    return typed(['block', ['result', 'f64'],
      ['local.set', `$${result}`, ['i32.const', -1]],
      ...loop,
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }

  // .includes(val) → 1 if found, 0 if not
  ctx.emit['.includes'] = (arr, val) => {
    const va = emit(arr), vv = asF64(emit(val))
    const result = `__ic${ctx.uid++}`
    ctx.locals.set(result, 'i32')

    const loop = arrayLoop(va, (ptr, _len, i) => [
      ['if', ['f64.eq', elemLoad(ptr, i), vv],
        ['then', ['local.set', `$${result}`, ['i32.const', 1]]]]
    ])

    return typed(['block', ['result', 'f64'],
      ['local.set', `$${result}`, ['i32.const', 0]],
      ...loop,
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }

  // .slice(start, end) → new array from start to end (exclusive)
  ctx.emit['.slice'] = (arr, start, end) => {
    const va = emit(arr)
    const vs = asI32(emit(start))
    const ve = end ? asI32(emit(end)) : ['call', '$__ptr_aux', asF64(va)]
    const out = `__so${ctx.uid++}`, len = `__sl${ctx.uid++}`, j = `__sj${ctx.uid++}`
    ctx.locals.set(out, 'i32')
    ctx.locals.set(len, 'i32')
    ctx.locals.set(j, 'i32')

    const id = ctx.uid++
    const brk = `$brk${id}`, loop = `$loop${id}`
    const ptr = `__sp${ctx.uid++}`
    ctx.locals.set(ptr, 'i32')

    return typed(['block', ['result', 'f64'],
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', asF64(va)]],
      ['local.set', `$${len}`, ['i32.sub', ve, vs]],
      ['local.set', `$${out}`, ['call', '$__alloc', ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]],
      ['local.set', `$${j}`, ['i32.const', 0]],
      ['block', brk, ['loop', loop,
        ['br_if', brk, ['i32.ge_s', ['local.get', `$${j}`], ['local.get', `$${len}`]]],
        ['f64.store',
          ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${j}`], ['i32.const', 3]]],
          ['f64.load', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['i32.add', vs, ['local.get', `$${j}`]], ['i32.const', 3]]]]],
        ['local.set', `$${j}`, ['i32.add', ['local.get', `$${j}`], ['i32.const', 1]]],
        ['br', loop]]],
      ['call', '$__mkptr', ['i32.const', ARRAY], ['local.get', `$${len}`], ['local.get', `$${out}`]]], 'f64')
  }
}
