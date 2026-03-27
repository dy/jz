/**
 * String module — literals, .length, [i] (charCodeAt).
 *
 * Type=4 (STRING): inline length in aux, ASCII bytes in memory.
 * Type=5 (STRING_SSO): ≤4 ASCII chars packed in pointer (no memory).
 *
 * @module string
 */

import { emit, typed, asF64, asI32 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const STRING = 4, STRING_SSO = 5
const MAX_SSO = 4  // 8 bits × 4 chars = 32 bits in offset field

export default () => {
  // String literal: "abc" → SSO if ≤4 ASCII, else allocate in memory
  ctx.emit['str'] = (str) => {
    if (str.length <= MAX_SSO && /^[\x00-\x7f]*$/.test(str)) {
      // SSO: aux=length, offset=packed chars (8 bits each, little-endian)
      let packed = 0
      for (let i = 0; i < str.length; i++) packed |= str.charCodeAt(i) << (i * 8)
      return typed(['call', '$__mkptr', ['i32.const', STRING_SSO], ['i32.const', str.length], ['i32.const', packed]], 'f64')
    }

    // Heap string: [-4:len(i32)][chars:u8...]
    const len = str.length
    const t = `__str${ctx.uid++}`
    ctx.locals.set(t, 'i32')

    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', len + 4]]],  // 4-byte header + chars
      ['i32.store', ['local.get', `$${t}`], ['i32.const', len]],  // store len
      ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]]],  // skip header
    ]
    for (let i = 0; i < len; i++)
      body.push(['i32.store8', ['i32.add', ['local.get', `$${t}`], ['i32.const', i]], ['i32.const', str.charCodeAt(i)]])
    body.push(['call', '$__mkptr', ['i32.const', STRING], ['i32.const', 0], ['local.get', `$${t}`]])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // === WAT char extraction helpers ===

  // SSO: chars packed in offset field (8 bits each, little-endian)
  ctx.stdlib['__sso_char'] = `(func $__sso_char (param $ptr f64) (param $i i32) (result i32)
    (i32.and (i32.shr_u (call $__ptr_offset (local.get $ptr)) (i32.mul (local.get $i) (i32.const 8))) (i32.const 0xFF)))`

  // Heap: load byte at offset + i
  ctx.stdlib['__str_char'] = `(func $__str_char (param $ptr f64) (param $i i32) (result i32)
    (i32.load8_u (i32.add (call $__ptr_offset (local.get $ptr)) (local.get $i))))`

  // Dispatch: check type, call appropriate helper
  ctx.stdlib['__char_at'] = `(func $__char_at (param $ptr f64) (param $i i32) (result i32)
    (if (result i32) (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${STRING_SSO}))
      (then (call $__sso_char (local.get $ptr) (local.get $i)))
      (else (call $__str_char (local.get $ptr) (local.get $i)))))`

  for (const name of ['__sso_char', '__str_char', '__char_at'])
    ctx.includes.add(name)
}
