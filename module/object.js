/**
 * Object module — literals and property access.
 *
 * Type=6 (OBJECT): schemaId in aux, properties as sequential f64 in memory.
 * Schema = compile-time known property names. Access by index via ptr module.
 *
 * @module object
 */

import { emit, typed, asF64 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const OBJECT = 6

export default () => {
  // Object literal: {x: 1, y: 2} → allocate, fill, return pointer with schemaId
  ctx.emit['{}'] = (...props) => {
    if (props.length === 0)
      return typed(['call', '$__mkptr', ['i32.const', OBJECT], ['i32.const', 0], ['i32.const', 0]], 'f64')

    const names = [], values = []
    for (const p of props) {
      if (Array.isArray(p) && p[0] === ':') { names.push(p[1]); values.push(p[2]) }
    }

    const schemaId = ctx.schema.register(names)
    const t = `__obj${ctx.uid++}`
    ctx.locals.set(t, 'i32')

    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', values.length * 8]]],
    ]
    for (let i = 0; i < values.length; i++)
      body.push(['f64.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]], asF64(emit(values[i]))])
    body.push(['call', '$__mkptr', ['i32.const', OBJECT], ['i32.const', schemaId], ['local.get', `$${t}`]])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }
}
