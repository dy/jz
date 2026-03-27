/**
 * Array module — literals, indexing, mutation.
 *
 * Arrays are NaN-boxed pointers to linear memory (f64 elements).
 * Type=1 (ARRAY): inline length in aux bits (≤32767 elements).
 *
 * Auto-included when code uses `[]` syntax. Requires ptr module.
 *
 * @module array
 */

import { emit, typed, asF64, asI32 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const ARRAY = 1

export default () => {
  // Array literal: [a, b, c] → allocate, fill, return NaN-boxed pointer
  ctx.emit['['] = (...elems) => {
    const len = elems.length
    const t = `__arr${ctx.uid++}`
    ctx.locals.set(t, 'i32')

    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', len * 8]]],
    ]
    for (let i = 0; i < len; i++) {
      body.push(['f64.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]], asF64(emit(elems[i]))])
    }
    body.push(['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', len], ['local.get', `$${t}`]])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // Array index read: arr[i] → f64.load
  ctx.emit['[]'] = (arr, idx) => {
    const va = emit(arr), vi = asI32(emit(idx))
    return typed(
      ['f64.load', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.shl', vi, ['i32.const', 3]]]],
      'f64'
    )
  }
}
