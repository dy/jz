/**
 * Object module — literals and property access.
 *
 * Type=6 (OBJECT): schemaId in aux, properties as sequential f64 in memory.
 * Schema = compile-time known property names. Access by index via ptr module.
 *
 * @module object
 */

import { emit, typed, asF64, valTypeOf, VAL, T } from '../src/compile.js'
import { ctx, err, inc, PTR } from '../src/ctx.js'


export default () => {
  // Object literal: {x: 1, y: 2} → allocate, fill, return pointer with schemaId
  ctx.core.emit['{}'] = (...props) => {
    if (props.length === 0)
      return typed(['call', '$__mkptr', ['i32.const', PTR.OBJECT], ['i32.const', 0], ['i32.const', 0]], 'f64')

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
    const t = `${T}obj${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'i32')

    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', schema.length * 8]]],
    ]
    for (let i = 0; i < values.length; i++)
      body.push(['f64.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]], asF64(emit(values[i]))])
    body.push(['call', '$__mkptr', ['i32.const', PTR.OBJECT], ['i32.const', schemaId], ['local.get', `$${t}`]])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // === Object static methods ===

  ctx.core.emit['Object.keys'] = (obj) => {
    const schema = resolveSchema(obj)
    if (!schema) err('Object.keys requires object with known schema')
    return emitStringArray(schema)
  }

  ctx.core.emit['Object.values'] = (obj) => {
    const schema = resolveSchema(obj)
    if (!schema) err('Object.values requires object with known schema')
    const va = asF64(emit(obj))
    const n = schema.length
    const t = `${T}ov${ctx.func.uniq++}`, arr = `${T}oa${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'f64'); ctx.func.locals.set(arr, 'i32')
    const body = [
      ['local.set', `$${t}`, va],
      ['local.set', `$${arr}`, ['call', '$__alloc_hdr', ['i32.const', n], ['i32.const', n], ['i32.const', 8]]],
    ]
    for (let i = 0; i < n; i++)
      body.push(['f64.store',
        ['i32.add', ['local.get', `$${arr}`], ['i32.const', i * 8]],
        ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.const', i * 8]]]])
    body.push(['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${arr}`]])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  ctx.core.emit['Object.entries'] = (obj) => {
    const schema = resolveSchema(obj)
    if (!schema) err('Object.entries requires object with known schema')
    const va = asF64(emit(obj))
    const n = schema.length
    const t = `${T}oe${ctx.func.uniq++}`, arr = `${T}oa${ctx.func.uniq++}`, pair = `${T}op${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'f64'); ctx.func.locals.set(arr, 'i32'); ctx.func.locals.set(pair, 'i32')
    const body = [
      ['local.set', `$${t}`, va],
      ['local.set', `$${arr}`, ['call', '$__alloc_hdr', ['i32.const', n], ['i32.const', n], ['i32.const', 8]]],
    ]
    for (let i = 0; i < n; i++) {
      body.push(
        ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2], ['i32.const', 8]]],
        ['f64.store', ['local.get', `$${pair}`], emit(['str', schema[i]])],
        ['f64.store', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]],
          ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.const', i * 8]]]],
        ['f64.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', i * 8]],
          ['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${pair}`]]])
    }
    body.push(['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${arr}`]])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  ctx.core.emit['Object.assign'] = (target, ...sources) => {
    if (typeof target === 'string') {
      const vt = ctx.func.valTypes?.get(target)
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
        const t = `${T}bx${ctx.func.uniq++}`, s = `${T}bs${ctx.func.uniq++}`
        ctx.func.locals.set(t, 'i32'); ctx.func.locals.set(s, 'f64')
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
          ['call', '$__mkptr', ['i32.const', PTR.OBJECT], ['i32.const', schemaId], ['local.get', `$${t}`]]])
        body.push(['local.get', `$${target}`])
        return typed(['block', ['result', 'f64'], ...body], 'f64')
      }
    }
    const tSchema = resolveSchema(target)
    if (!tSchema) err('Object.assign: target needs known schema')
    const t = `${T}at${ctx.func.uniq++}`, s = `${T}as${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'f64'); ctx.func.locals.set(s, 'f64')
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

  // Object.fromEntries(arr) → creates HASH from array of [key, value] pairs
  ctx.core.emit['Object.fromEntries'] = (arr) => {
    inc('__hash_new', '__hash_set')
    inc('__str_hash', '__str_eq')
    const va = asF64(emit(arr))
    const t = `${T}fe${ctx.func.uniq++}`, ptr = `${T}fp${ctx.func.uniq++}`, len = `${T}fl${ctx.func.uniq++}`
    const i = `${T}fi${ctx.func.uniq++}`, pair = `${T}fv${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'f64'); ctx.func.locals.set(ptr, 'i32'); ctx.func.locals.set(len, 'i32')
    ctx.func.locals.set(i, 'i32'); ctx.func.locals.set(pair, 'i32')
    const id = ctx.func.uniq++
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, ['call', '$__hash_new']],
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', va]],
      ['local.set', `$${len}`, ['call', '$__len', va]],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$brk${id}`, ['loop', `$loop${id}`,
        ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
        // Load pair (array of 2): pair = ptr_offset(arr[i])
        ['local.set', `$${pair}`, ['call', '$__ptr_offset',
          ['f64.load', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]]],
        // hash_set(result, pair[0], pair[1])
        ['local.set', `$${t}`, ['call', '$__hash_set', ['local.get', `$${t}`],
          ['f64.load', ['local.get', `$${pair}`]],
          ['f64.load', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]]]]],
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]],
      ['local.get', `$${t}`]], 'f64')
  }

  // Object.create(proto) → shallow copy of object (same schema, copied properties)
  ctx.core.emit['Object.create'] = (proto) => {
    const schema = resolveSchema(proto)
    if (!schema) err('Object.create requires object with known schema')
    const n = schema.length
    const schemaId = ctx.schema.register(schema)
    const t = `${T}oc${ctx.func.uniq++}`, s = `${T}os${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'i32'); ctx.func.locals.set(s, 'f64')
    const body = [
      ['local.set', `$${s}`, asF64(emit(proto))],
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', n * 8]]],
    ]
    // Copy all properties from proto
    for (let i = 0; i < n; i++)
      body.push(['f64.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]],
        ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${s}`]], ['i32.const', i * 8]]]])
    body.push(['call', '$__mkptr', ['i32.const', PTR.OBJECT], ['i32.const', schemaId], ['local.get', `$${t}`]])
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

function emitStringArray(names) {
  const n = names.length, arr = `${T}sa${ctx.func.uniq++}`
  ctx.func.locals.set(arr, 'i32')
  const body = [
    ['local.set', `$${arr}`, ['call', '$__alloc_hdr', ['i32.const', n], ['i32.const', n], ['i32.const', 8]]],
  ]
  for (let i = 0; i < n; i++)
    body.push(['f64.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', i * 8]], emit(['str', names[i]])])
  body.push(['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${arr}`]])
  return typed(['block', ['result', 'f64'], ...body], 'f64')
}
