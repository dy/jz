/**
 * Object module — literals and property access.
 *
 * Type=6 (OBJECT): schemaId in aux, properties as sequential f64 in memory.
 * Schema = compile-time known property names. Access by index via ptr module.
 *
 * @module object
 */

import { emit, typed, asF64, valTypeOf, lookupValType, VAL, temp, tempI32, allocPtr, needsDynShadow, mkPtrIR, extractF64Bits, appendStaticSlots, slotAddr } from '../src/compile.js'
import { ctx, err, inc, PTR } from '../src/ctx.js'


export default (ctx) => {
  inc('__mkptr', '__alloc', '__alloc_hdr', '__ptr_offset', '__len', '__ptr_type')

  // Object literal: {x: 1, y: 2} → allocate, fill, return pointer with schemaId
  ctx.core.emit['{}'] = (...rawProps) => {
    if (rawProps.length === 0)
      return mkPtrIR(PTR.OBJECT, 0, ['call', '$__alloc', ['i32.const', 8]])

    // Flatten comma-grouped props: [',', p1, p2] → [p1, p2]
    const props = rawProps.length === 1 && Array.isArray(rawProps[0]) && rawProps[0][0] === ','
      ? rawProps[0].slice(1) : rawProps

    // Object spread: {...a, x: 1, ...b} — merge schemas, copy props from sources
    const hasSpreads = props.some(p => Array.isArray(p) && p[0] === '...')
    if (hasSpreads) return emitObjectSpread(props)

    const names = [], values = []
    for (const p of props) {
      if (Array.isArray(p) && p[0] === ':') { names.push(p[1]); values.push(p[2]) }
    }

    // Use variable's merged schema if available (from Object.assign inference), else register literal schema
    let schemaId = ctx.schema.register(names)
    const target = ctx.schema.targetStack.at(-1)
    if (target) {
      const merged = ctx.schema.resolve(target)
      if (merged) schemaId = ctx.schema.vars.get(target)
    }
    const schema = ctx.schema.list[schemaId]
    const t = tempI32('obj')
    const ptr = temp('objp')

    // R: Static data segment for objects of pure-literal property values (own-memory only).
    // Even with shadow needed, we can skip alloc + N stores; just feed literal values to __dyn_set.
    const shadow = needsDynShadow(target)
    if (values.length >= 2 && !ctx.memory.shared) {
      const emitted = values.map(emit)
      const slots = emitted.map(extractF64Bits)
      if (slots.every(b => b !== null)) {
        const off = appendStaticSlots(slots)
        const staticPtr = mkPtrIR(PTR.OBJECT, schemaId, off)
        if (!shadow) return staticPtr
        inc('__dyn_set')
        const body = [['local.set', `$${ptr}`, staticPtr]]
        for (let i = 0; i < schema.length; i++)
          body.push(['drop', ['call', '$__dyn_set', ['local.get', `$${ptr}`],
            emit(['str', String(schema[i])]), asF64(emitted[i])]])
        body.push(['local.get', `$${ptr}`])
        return typed(['block', ['result', 'f64'], ...body], 'f64')
      }
    }

    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', schema.length * 8]]],
    ]
    for (let i = 0; i < values.length; i++)
      body.push(['f64.store', slotAddr(t, i), asF64(emit(values[i]))])
    body.push(['local.set', `$${ptr}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`])])
    if (shadow) {
      inc('__dyn_set')
      for (let i = 0; i < schema.length; i++)
        body.push(['drop', ['call', '$__dyn_set', ['local.get', `$${ptr}`], emit(['str', String(schema[i])]),
          ['f64.load', slotAddr(t, i)]]])
    }
    body.push(['local.get', `$${ptr}`])

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
    const t = temp('ov'), base = tempI32('vb')
    const out = allocPtr({ type: PTR.ARRAY, len: n, tag: 'oa' })
    const body = [['local.set', `$${t}`, va], out.init,
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['local.get', `$${t}`]]]]
    for (let i = 0; i < n; i++)
      body.push(['f64.store', slotAddr(out.local, i), ['f64.load', slotAddr(base, i)]])
    body.push(out.ptr)
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  ctx.core.emit['Object.entries'] = (obj) => {
    const schema = resolveSchema(obj)
    if (!schema) err('Object.entries requires object with known schema')
    const va = asF64(emit(obj))
    const n = schema.length
    const t = temp('oe'), pair = tempI32('op'), base = tempI32('eb')
    const out = allocPtr({ type: PTR.ARRAY, len: n, tag: 'oa' })
    const body = [['local.set', `$${t}`, va], out.init,
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['local.get', `$${t}`]]]]
    for (let i = 0; i < n; i++) {
      body.push(
        ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2], ['i32.const', 8]]],
        ['f64.store', slotAddr(pair, 0), emit(['str', schema[i]])],
        ['f64.store', slotAddr(pair, 1), ['f64.load', slotAddr(base, i)]],
        ['f64.store', slotAddr(out.local, i), mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${pair}`])])
    }
    body.push(out.ptr)
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
        const t = tempI32('bx'), s = temp('bs')
        const body = [
          ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', boxedSchema.length * 8]]],
          ['f64.store', ['local.get', `$${t}`], asF64(emit(target))],
        ]
        const sBase = tempI32('sb')
        for (const source of sources) {
          const sSchema = resolveSchema(source)
          body.push(['local.set', `$${s}`, asF64(emit(source))])
          body.push(['local.set', `$${sBase}`, ['call', '$__ptr_offset', ['local.get', `$${s}`]]])
          for (let si = 0; si < sSchema.length; si++) {
            const ti = boxedSchema.indexOf(sSchema[si])
            if (ti < 0) continue
            body.push(['f64.store', slotAddr(t, ti), ['f64.load', slotAddr(sBase, si)]])
          }
        }
        body.push(['local.set', `$${target}`,
          mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`])])
        body.push(['local.get', `$${target}`])
        return typed(['block', ['result', 'f64'], ...body], 'f64')
      }
    }
    const tSchema = resolveSchema(target)
    if (!tSchema) err('Object.assign: target needs known schema')
    const t = temp('at'), s = temp('as')
    const tBase = tempI32('tb'), sBase2 = tempI32('sb')
    const body = [['local.set', `$${t}`, asF64(emit(target))],
      ['local.set', `$${tBase}`, ['call', '$__ptr_offset', ['local.get', `$${t}`]]]]
    for (const source of sources) {
      const sSchema = resolveSchema(source)
      if (!sSchema) err('Object.assign: source needs known schema')
      body.push(['local.set', `$${s}`, asF64(emit(source))])
      body.push(['local.set', `$${sBase2}`, ['call', '$__ptr_offset', ['local.get', `$${s}`]]])
      for (let si = 0; si < sSchema.length; si++) {
        const ti = tSchema.indexOf(sSchema[si])
        if (ti < 0) continue
        body.push(['f64.store', slotAddr(tBase, ti), ['f64.load', slotAddr(sBase2, si)]])
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
    const t = temp('fe'), ptr = tempI32('fp'), len = tempI32('fl')
    const i = tempI32('fi'), pair = tempI32('fv')
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
    const protoType = typeof proto === 'string' ? lookupValType(proto) : valTypeOf(proto)
    if (protoType === VAL.ARRAY) {
      // Clone array data + link named-prop sidecar so for-in/bracket-name lookups
      // keep working after Object.create (watr's ctx.local = Object.create(param) pattern).
      inc('__arr_from', '__dyn_move', '__ptr_offset')
      const src = temp('ocs')
      const dst = temp('ocd')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${src}`, asF64(emit(proto))],
        ['local.set', `$${dst}`, ['call', '$__arr_from', ['local.get', `$${src}`]]],
        ['call', '$__dyn_move',
          ['call', '$__ptr_offset', ['local.get', `$${src}`]],
          ['call', '$__ptr_offset', ['local.get', `$${dst}`]]],
        ['local.get', `$${dst}`]], 'f64')
    }
    const schema = resolveSchema(proto)
    if (!schema) {
      if (protoType == null) {
        const value = temp('ocr')
        inc('__arr_from', '__dyn_move', '__ptr_offset')
        const dst2 = temp('ocd')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${value}`, asF64(emit(proto))],
          ['if', ['result', 'f64'],
            ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${value}`]], ['i32.const', PTR.ARRAY]],
            ['then', ['block', ['result', 'f64'],
              ['local.set', `$${dst2}`, ['call', '$__arr_from', ['local.get', `$${value}`]]],
              ['call', '$__dyn_move',
                ['call', '$__ptr_offset', ['local.get', `$${value}`]],
                ['call', '$__ptr_offset', ['local.get', `$${dst2}`]]],
              ['local.get', `$${dst2}`]]],
            ['else', ['local.get', `$${value}`]]]] , 'f64')
      }
      err('Object.create requires object with known schema')
    }
    const n = schema.length
    const schemaId = ctx.schema.register(schema)
    const t = tempI32('oc'), s = temp('os')
    const srcBase = tempI32('cb')
    const body = [
      ['local.set', `$${s}`, asF64(emit(proto))],
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', n * 8]]],
      ['local.set', `$${srcBase}`, ['call', '$__ptr_offset', ['local.get', `$${s}`]]],
    ]
    // Copy all properties from proto
    for (let i = 0; i < n; i++)
      body.push(['f64.store', slotAddr(t, i), ['f64.load', slotAddr(srcBase, i)]])
    body.push(mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`]))
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }
}

// --- Helpers ---

function resolveSchema(obj) {
  if (typeof obj === 'string') return ctx.schema.resolve(obj)
  if (Array.isArray(obj) && obj[0] === '{}')
    return obj.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
  return null
}

/**
 * Emit object literal with spread: {...a, x: 1, ...b, y: 2}
 * Merges schemas from all sources, allocates result, copies in order.
 */
function emitObjectSpread(props) {
  // Collect merged schema: union of all spread source schemas + explicit props
  const allNames = []
  const addName = n => { if (!allNames.includes(n)) allNames.push(n) }
  for (const p of props) {
    if (Array.isArray(p) && p[0] === '...') {
      const s = resolveSchema(p[1])
      if (s) for (const n of s) addName(n)
    } else if (Array.isArray(p) && p[0] === ':') addName(p[1])
  }
  // Pragmatic fallback: single spread source with no resolvable schema
  // (e.g. `{ ...opts }` where opts is a parameter). Emit source directly.
  // Alias rather than clone — safe for read-only use; mutation would affect source.
  if (!allNames.length && props.length === 1 && Array.isArray(props[0]) && props[0][0] === '...') {
    return typed(asF64(emit(props[0][1])), 'f64')
  }
  if (!allNames.length) err('Object spread: cannot resolve source schema')

  const schemaId = ctx.schema.register(allNames)
  const schema = ctx.schema.list[schemaId]
  const t = tempI32('obj')
  const ptr = temp('objp')
  const src = tempI32('osp')

  const body = [['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', schema.length * 8]]]]

  // Process props in order — later props override earlier (JS semantics)
  let srcF
  for (const p of props) {
    if (Array.isArray(p) && p[0] === '...') {
      const sSchema = resolveSchema(p[1])
      if (!sSchema) {
        // Unknown-schema source (e.g. parameter). Override each slot via runtime
        // __dyn_get_or using existing value as fallback. Requires collection module.
        if (!ctx.module.modules.collection) err('Object spread: source needs known schema')
        inc('__dyn_get_or')
        srcF ??= temp('ospf')
        body.push(['local.set', `$${srcF}`, asF64(emit(p[1]))])
        for (let i = 0; i < schema.length; i++) {
          const slot = slotAddr(t, i)
          body.push(['f64.store', slot,
            ['call', '$__dyn_get_or', ['local.get', `$${srcF}`],
              emit(['str', String(schema[i])]),
              ['f64.load', slot]]])
        }
        continue
      }
      body.push(['local.set', `$${src}`, ['call', '$__ptr_offset', asF64(emit(p[1]))]])
      for (let si = 0; si < sSchema.length; si++) {
        const ti = schema.indexOf(sSchema[si])
        if (ti < 0) continue
        body.push(['f64.store', slotAddr(t, ti), ['f64.load', slotAddr(src, si)]])
      }
    } else if (Array.isArray(p) && p[0] === ':') {
      const ti = schema.indexOf(p[1])
      if (ti >= 0) body.push(['f64.store', slotAddr(t, ti), asF64(emit(p[2]))])
    }
  }

  body.push(['local.set', `$${ptr}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`])])
  const spreadTarget = ctx.schema.targetStack.at(-1)
  if (needsDynShadow(spreadTarget)) {
    inc('__dyn_set')
    for (let i = 0; i < schema.length; i++)
      body.push(['drop', ['call', '$__dyn_set', ['local.get', `$${ptr}`], emit(['str', String(schema[i])]),
        ['f64.load', slotAddr(t, i)]]])
  }
  body.push(['local.get', `$${ptr}`])
  return typed(['block', ['result', 'f64'], ...body], 'f64')
}

function emitStringArray(names) {
  const n = names.length
  const out = allocPtr({ type: PTR.ARRAY, len: n, tag: 'sa' })
  const body = [out.init]
  for (let i = 0; i < n; i++)
    body.push(['f64.store', slotAddr(out.local, i), emit(['str', names[i]])])
  body.push(out.ptr)
  return typed(['block', ['result', 'f64'], ...body], 'f64')
}
