/**
 * Object module — literals and property access.
 *
 * Type=6 (OBJECT): schemaId in aux, properties as sequential f64 in memory.
 * Schema = compile-time known property names. Access by index via ptr module.
 *
 * @module object
 */

import { emit, typed, asF64, valTypeOf, VAL } from '../src/compile.js'
import { ctx, err } from '../src/ctx.js'

const ARRAY = 1, STRING = 4, STRING_SSO = 5, OBJECT = 6

export default () => {
  // Object literal: {x: 1, y: 2} → allocate, fill, return pointer with schemaId
  ctx.emit['{}'] = (...props) => {
    if (props.length === 0)
      return typed(['call', '$__mkptr', ['i32.const', OBJECT], ['i32.const', 0], ['i32.const', 0]], 'f64')

    const names = [], values = []
    for (const p of props) {
      if (Array.isArray(p) && p[0] === ':') { names.push(p[1]); values.push(p[2]) }
    }

    // Use variable's merged schema if available (from Object.assign inference), else register literal schema
    let schemaId = ctx.schema.register(names)
    if (ctx.schema.target) {
      const varId = ctx.schema.vars.get(ctx.schema.target)
      if (varId != null) schemaId = varId
    }
    const schema = ctx.schema.list[schemaId]
    const t = `__obj${ctx.uniq++}`
    ctx.locals.set(t, 'i32')

    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', schema.length * 8]]],
    ]
    for (let i = 0; i < values.length; i++)
      body.push(['f64.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]], asF64(emit(values[i]))])
    body.push(['call', '$__mkptr', ['i32.const', OBJECT], ['i32.const', schemaId], ['local.get', `$${t}`]])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // === Object static methods ===

  ctx.emit['Object.keys'] = (obj) => {
    const schema = resolveSchema(obj)
    if (!schema) err('Object.keys requires object with known schema')
    return emitStringArray(schema)
  }

  ctx.emit['Object.values'] = (obj) => {
    const schema = resolveSchema(obj)
    if (!schema) err('Object.values requires object with known schema')
    const va = asF64(emit(obj))
    const n = schema.length
    const t = `__ov${ctx.uniq++}`, arr = `__oa${ctx.uniq++}`
    ctx.locals.set(t, 'f64'); ctx.locals.set(arr, 'i32')
    const body = [
      ['local.set', `$${t}`, va],
      ['local.set', `$${arr}`, ['call', '$__alloc', ['i32.const', n * 8 + 8]]],
      ['i32.store', ['local.get', `$${arr}`], ['i32.const', n]],
      ['i32.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', 4]], ['i32.const', n]],
      ['local.set', `$${arr}`, ['i32.add', ['local.get', `$${arr}`], ['i32.const', 8]]],
    ]
    for (let i = 0; i < n; i++)
      body.push(['f64.store',
        ['i32.add', ['local.get', `$${arr}`], ['i32.const', i * 8]],
        ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.const', i * 8]]]])
    body.push(['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${arr}`]])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  ctx.emit['Object.entries'] = (obj) => {
    const schema = resolveSchema(obj)
    if (!schema) err('Object.entries requires object with known schema')
    const va = asF64(emit(obj))
    const n = schema.length
    const t = `__oe${ctx.uniq++}`, arr = `__oa${ctx.uniq++}`, pair = `__op${ctx.uniq++}`
    ctx.locals.set(t, 'f64'); ctx.locals.set(arr, 'i32'); ctx.locals.set(pair, 'i32')
    const body = [
      ['local.set', `$${t}`, va],
      ['local.set', `$${arr}`, ['call', '$__alloc', ['i32.const', n * 8 + 8]]],
      ['i32.store', ['local.get', `$${arr}`], ['i32.const', n]],
      ['i32.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', 4]], ['i32.const', n]],
      ['local.set', `$${arr}`, ['i32.add', ['local.get', `$${arr}`], ['i32.const', 8]]],
    ]
    for (let i = 0; i < n; i++) {
      body.push(
        ['local.set', `$${pair}`, ['call', '$__alloc', ['i32.const', 24]]],
        ['i32.store', ['local.get', `$${pair}`], ['i32.const', 2]],
        ['i32.store', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 4]], ['i32.const', 2]],
        ['local.set', `$${pair}`, ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]]],
        ['f64.store', ['local.get', `$${pair}`], emitStringLiteral(schema[i])],
        ['f64.store', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]],
          ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.const', i * 8]]]],
        ['f64.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', i * 8]],
          ['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${pair}`]]])
    }
    body.push(['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${arr}`]])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  ctx.emit['Object.assign'] = (target, ...sources) => {
    if (typeof target === 'string') {
      const vt = ctx.valTypes?.get(target)
      if (vt && vt !== VAL.OBJECT) {
        const allProps = []
        for (const src of sources) {
          const s = resolveSchema(src)
          if (!s) err('Object.assign: source needs known schema')
          for (const p of s) if (!allProps.includes(p)) allProps.push(p)
        }
        const boxedSchema = ['__inner__', ...allProps]
        const schemaId = ctx.schema.register(boxedSchema)
        ctx.schema.vars.set(target, schemaId)
        const t = `__bx${ctx.uniq++}`, s = `__bs${ctx.uniq++}`
        ctx.locals.set(t, 'i32'); ctx.locals.set(s, 'f64')
        const body = [
          ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', boxedSchema.length * 8]]],
          ['f64.store', ['local.get', `$${t}`], asF64(emit(target))],
        ]
        for (const source of sources) {
          const sSchema = resolveSchema(source)
          body.push(['local.set', `$${s}`, asF64(emit(source))])
          for (let si = 0; si < sSchema.length; si++) {
            const ti = boxedSchema.indexOf(sSchema[si])
            if (ti < 0) continue
            body.push(['f64.store',
              ['i32.add', ['local.get', `$${t}`], ['i32.const', ti * 8]],
              ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${s}`]], ['i32.const', si * 8]]]])
          }
        }
        body.push(['local.set', `$${target}`,
          ['call', '$__mkptr', ['i32.const', OBJECT], ['i32.const', schemaId], ['local.get', `$${t}`]]])
        body.push(['local.get', `$${target}`])
        return typed(['block', ['result', 'f64'], ...body], 'f64')
      }
    }
    const tSchema = resolveSchema(target)
    if (!tSchema) err('Object.assign: target needs known schema')
    const t = `__at${ctx.uniq++}`, s = `__as${ctx.uniq++}`
    ctx.locals.set(t, 'f64'); ctx.locals.set(s, 'f64')
    const body = [['local.set', `$${t}`, asF64(emit(target))]]
    for (const source of sources) {
      const sSchema = resolveSchema(source)
      if (!sSchema) err('Object.assign: source needs known schema')
      body.push(['local.set', `$${s}`, asF64(emit(source))])
      for (let si = 0; si < sSchema.length; si++) {
        const ti = tSchema.indexOf(sSchema[si])
        if (ti < 0) continue
        body.push(['f64.store',
          ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.const', ti * 8]],
          ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${s}`]], ['i32.const', si * 8]]]])
      }
    }
    body.push(['local.get', `$${t}`])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }
}

// --- Helpers ---

function resolveSchema(obj) {
  if (typeof obj === 'string') {
    const id = ctx.schema.vars.get(obj)
    if (id != null) return ctx.schema.list[id]
  }
  if (Array.isArray(obj) && obj[0] === '{}')
    return obj.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
  return null
}

function emitStringLiteral(str) {
  if (str.length <= 4 && /^[\x00-\x7f]*$/.test(str)) {
    let packed = 0
    for (let i = 0; i < str.length; i++) packed |= str.charCodeAt(i) << (i * 8)
    return ['call', '$__mkptr', ['i32.const', 5], ['i32.const', str.length], ['i32.const', packed]]
  }
  const len = str.length, t = `__sl${ctx.uniq++}`
  ctx.locals.set(t, 'i32')
  const body = [
    ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', len + 4]]],
    ['i32.store', ['local.get', `$${t}`], ['i32.const', len]],
    ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]]],
  ]
  for (let i = 0; i < len; i++)
    body.push(['i32.store8', ['i32.add', ['local.get', `$${t}`], ['i32.const', i]], ['i32.const', str.charCodeAt(i)]])
  body.push(['call', '$__mkptr', ['i32.const', 4], ['i32.const', 0], ['local.get', `$${t}`]])
  return ['block', ['result', 'f64'], ...body]
}

function emitStringArray(names) {
  const n = names.length, arr = `__sa${ctx.uniq++}`
  ctx.locals.set(arr, 'i32')
  const body = [
    ['local.set', `$${arr}`, ['call', '$__alloc', ['i32.const', n * 8 + 8]]],
    ['i32.store', ['local.get', `$${arr}`], ['i32.const', n]],
    ['i32.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', 4]], ['i32.const', n]],
    ['local.set', `$${arr}`, ['i32.add', ['local.get', `$${arr}`], ['i32.const', 8]]],
  ]
  for (let i = 0; i < n; i++)
    body.push(['f64.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', i * 8]], emitStringLiteral(names[i])])
  body.push(['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${arr}`]])
  return typed(['block', ['result', 'f64'], ...body], 'f64')
}
