/**
 * Array module — literals, indexing.
 *
 * Type=1 (ARRAY): inline length in aux bits (≤32767 elements).
 * Elements stored as sequential f64 in linear memory.
 *
 * Also handles [] indexing dispatch: arrays → f64.load, strings → char_at.
 *
 * @module array
 */

import { emit, typed, asF64, asI32 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const ARRAY = 1, STRING = 4, STRING_SSO = 5

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

  // Index read: arr[i] → f64.load, or str[i] → charCodeAt (if string module loaded)
  ctx.emit['[]'] = (arr, idx) => {
    const va = emit(arr), vi = asI32(emit(idx))
    const ptrExpr = asF64(va)

    // If string module is loaded, emit runtime type dispatch
    if (ctx.modules['string'])
      return typed(
        ['if', ['result', 'f64'],
          ['i32.ge_u', ['call', '$__ptr_type', ptrExpr], ['i32.const', STRING]],
          ['then', ['f64.convert_i32_u', ['call', '$__char_at', ptrExpr, vi]]],
          ['else', ['f64.load', ['i32.add', ['call', '$__ptr_offset', ptrExpr], ['i32.shl', vi, ['i32.const', 3]]]]]],
        'f64')

    // Array-only: direct f64.load
    return typed(
      ['f64.load', ['i32.add', ['call', '$__ptr_offset', ptrExpr], ['i32.shl', vi, ['i32.const', 3]]]],
      'f64')
  }
}
