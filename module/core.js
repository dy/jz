/**
 * Core module — Number, Array, Object static methods and constants.
 *
 * Number.isNaN(x)           → x !== x
 * Number.isFinite(x)        → abs(x) < Infinity && x === x
 * Number.isInteger(x)       → trunc(x) === x && isFinite(x)
 * Number.parseInt(x)        → trunc(x)
 * Number.parseFloat(x)      → x (identity, already f64)
 * Number.MAX_SAFE_INTEGER   → 2^53 - 1
 * Number.MIN_SAFE_INTEGER   → -(2^53 - 1)
 * Number.EPSILON            → 2^-52
 * Number.MAX_VALUE          → 1.7976931348623157e+308
 * Number.MIN_VALUE          → 5e-324
 * Number.POSITIVE_INFINITY  → Infinity
 * Number.NEGATIVE_INFINITY  → -Infinity
 *
 * Array.isArray(x)          → ptr_type(x) === 1
 *
 * Object.keys(obj)          → string array from schema (compile-time)
 * Object.values(obj)        → f64 array from schema (compile-time)
 * Object.entries(obj)       → array of [key, val] pairs (compile-time)
 *
 * @module core
 */

import { emit, typed, asF64, valTypeOf, VAL } from '../src/compile.js'
import { ctx, err } from '../src/ctx.js'

const ARRAY = 1, STRING = 4, STRING_SSO = 5, OBJECT = 6

export default () => {
  // === Number constants ===

  ctx.emit['Number.MAX_SAFE_INTEGER'] = () => typed(['f64.const', 9007199254740991], 'f64')
  ctx.emit['Number.MIN_SAFE_INTEGER'] = () => typed(['f64.const', -9007199254740991], 'f64')
  ctx.emit['Number.EPSILON'] = () => typed(['f64.const', 2.220446049250313e-16], 'f64')
  ctx.emit['Number.MAX_VALUE'] = () => typed(['f64.const', 1.7976931348623157e+308], 'f64')
  ctx.emit['Number.MIN_VALUE'] = () => typed(['f64.const', 5e-324], 'f64')
  ctx.emit['Number.POSITIVE_INFINITY'] = () => typed(['f64.const', Infinity], 'f64')
  ctx.emit['Number.NEGATIVE_INFINITY'] = () => typed(['f64.const', -Infinity], 'f64')
  ctx.emit['Number.NaN'] = () => typed(['f64.const', NaN], 'f64')

  // === Number methods ===

  // isNaN: x !== x (only NaN fails self-equality)
  ctx.emit['Number.isNaN'] = (x) => {
    const v = asF64(emit(x))
    const t = `__t${ctx.uniq++}`
    ctx.locals.set(t, 'f64')
    return typed(['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]], 'i32')
  }

  // isFinite: not NaN and not ±Infinity
  ctx.emit['Number.isFinite'] = (x) => {
    const v = asF64(emit(x))
    const t = `__t${ctx.uniq++}`
    ctx.locals.set(t, 'f64')
    return typed(['i32.and',
      // x === x (not NaN)
      ['f64.eq', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
      // abs(x) < infinity
      ['f64.lt', ['f64.abs', ['local.get', `$${t}`]], ['f64.const', Infinity]]], 'i32')
  }

  // isInteger: x === trunc(x) && isFinite(x)
  ctx.emit['Number.isInteger'] = (x) => {
    const v = asF64(emit(x))
    const t = `__t${ctx.uniq++}`
    ctx.locals.set(t, 'f64')
    return typed(['i32.and',
      ['i32.and',
        ['f64.eq', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
        ['f64.lt', ['f64.abs', ['local.get', `$${t}`]], ['f64.const', Infinity]]],
      ['f64.eq', ['local.get', `$${t}`], ['f64.trunc', ['local.get', `$${t}`]]]], 'i32')
  }

  // parseInt: trunc to integer
  ctx.emit['Number.parseInt'] = (x) => typed(['f64.trunc', asF64(emit(x))], 'f64')

  // parseFloat: identity (already f64)
  ctx.emit['Number.parseFloat'] = (x) => asF64(emit(x))

  // === Array static methods ===

  // Array.isArray(x): check ptr_type === ARRAY
  ctx.emit['Array.isArray'] = (x) => {
    const v = asF64(emit(x))
    const t = `__t${ctx.uniq++}`
    ctx.locals.set(t, 'f64')
    return typed(['i32.and',
      // Must be NaN (is a pointer)
      ['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
      ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${t}`]], ['i32.const', ARRAY]]], 'i32')
  }

  // === Object static methods ===

  // Object.keys(obj) → array of string pointers (compile-time schema resolution)
  ctx.emit['Object.keys'] = (obj) => {
    const schema = resolveSchema(obj)
    if (!schema) err('Object.keys requires object with known schema')
    // Emit array of string literals
    const va = asF64(emit(obj))
    return emitStringArray(schema)
  }

  // Object.values(obj) → array of f64 values
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

  // Object.entries(obj) → array of [key, value] pairs
  ctx.emit['Object.entries'] = (obj) => {
    const schema = resolveSchema(obj)
    if (!schema) err('Object.entries requires object with known schema')
    const va = asF64(emit(obj))
    const n = schema.length
    const t = `__oe${ctx.uniq++}`, arr = `__oa${ctx.uniq++}`, pair = `__op${ctx.uniq++}`
    ctx.locals.set(t, 'f64'); ctx.locals.set(arr, 'i32'); ctx.locals.set(pair, 'i32')
    const body = [
      ['local.set', `$${t}`, va],
      // Outer array: n pairs
      ['local.set', `$${arr}`, ['call', '$__alloc', ['i32.const', n * 8 + 8]]],
      ['i32.store', ['local.get', `$${arr}`], ['i32.const', n]],
      ['i32.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', 4]], ['i32.const', n]],
      ['local.set', `$${arr}`, ['i32.add', ['local.get', `$${arr}`], ['i32.const', 8]]],
    ]
    for (let i = 0; i < n; i++) {
      // Each pair: [key_string_ptr, value]
      body.push(
        ['local.set', `$${pair}`, ['call', '$__alloc', ['i32.const', 24]]],  // header(8) + 2*f64(16)
        ['i32.store', ['local.get', `$${pair}`], ['i32.const', 2]],
        ['i32.store', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 4]], ['i32.const', 2]],
        ['local.set', `$${pair}`, ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]]],
        // pair[0] = key string
        ['f64.store', ['local.get', `$${pair}`], emitStringLiteral(schema[i])],
        // pair[1] = value
        ['f64.store', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]],
          ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.const', i * 8]]]],
        // Store pair pointer in outer array
        ['f64.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', i * 8]],
          ['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${pair}`]]])
    }
    body.push(['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${arr}`]])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // Object.assign(target, ...sources) → copy matching props from each source to target, return target
  ctx.emit['Object.assign'] = (target, ...sources) => {
    // Non-object target (array, string, etc.) → create boxed wrapper object
    if (typeof target === 'string') {
      const vt = ctx.valTypes?.get(target)
      if (vt && vt !== VAL.OBJECT) {
        // Collect all source props
        const allProps = []
        for (const src of sources) {
          const s = resolveSchema(src)
          if (!s) err('Object.assign: source needs known schema')
          for (const p of s) if (!allProps.includes(p)) allProps.push(p)
        }
        // Register boxed schema: ['__inner__', ...props]
        const boxedSchema = ['__inner__', ...allProps]
        const schemaId = ctx.schema.register(boxedSchema)
        ctx.schema.vars.set(target, schemaId)

        const t = `__bx${ctx.uniq++}`, s = `__bs${ctx.uniq++}`
        ctx.locals.set(t, 'i32'); ctx.locals.set(s, 'f64')
        const body = [
          // Allocate object: slot 0 = inner, remaining = props
          ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', boxedSchema.length * 8]]],
          // Store inner value in slot 0
          ['f64.store', ['local.get', `$${t}`], asF64(emit(target))],
        ]
        // Copy source props into remaining slots
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
        // Create object pointer and reassign variable
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
    const body = [
      ['local.set', `$${t}`, asF64(emit(target))],
    ]

    // Copy from each source object
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

/** Resolve schema for a variable or expression. */
function resolveSchema(obj) {
  if (typeof obj === 'string') {
    const id = ctx.schema.vars.get(obj)
    if (id != null) return ctx.schema.list[id]
  }
  // Inline object literal: ['{}', [':', 'x', ...], ...]
  if (Array.isArray(obj) && obj[0] === '{}')
    return obj.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
  return null
}

/** Emit a string literal as NaN-boxed pointer (SSO or heap). */
function emitStringLiteral(str) {
  if (str.length <= 4 && /^[\x00-\x7f]*$/.test(str)) {
    let packed = 0
    for (let i = 0; i < str.length; i++) packed |= str.charCodeAt(i) << (i * 8)
    return ['call', '$__mkptr', ['i32.const', 5], ['i32.const', str.length], ['i32.const', packed]]
  }
  const len = str.length
  const t = `__sl${ctx.uniq++}`
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

/** Emit an array of string pointers. */
function emitStringArray(names) {
  const n = names.length
  const arr = `__sa${ctx.uniq++}`
  ctx.locals.set(arr, 'i32')
  const body = [
    ['local.set', `$${arr}`, ['call', '$__alloc', ['i32.const', n * 8 + 8]]],
    ['i32.store', ['local.get', `$${arr}`], ['i32.const', n]],
    ['i32.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', 4]], ['i32.const', n]],
    ['local.set', `$${arr}`, ['i32.add', ['local.get', `$${arr}`], ['i32.const', 8]]],
  ]
  for (let i = 0; i < n; i++)
    body.push(['f64.store', ['i32.add', ['local.get', `$${arr}`], ['i32.const', i * 8]], emitStringLiteral(names[i])])
  body.push(['call', '$__mkptr', ['i32.const', 1], ['i32.const', 0], ['local.get', `$${arr}`]])
  return typed(['block', ['result', 'f64'], ...body], 'f64')
}
