/**
 * Object module — literals and property access.
 *
 * Type=6 (OBJECT): schemaId in aux, properties as sequential f64 in memory.
 * Schema = compile-time known property names. Access by index via ptr module.
 *
 * @module object
 */

import { typed, asF64, asI64, temp, tempI32, allocPtr, needsDynShadow, mkPtrIR, extractF64Bits, appendStaticSlots, slotAddr, elemStore } from '../src/ir.js'
import { emit } from '../src/emit.js'
import { valTypeOf, lookupValType, VAL, repOf, updateRep } from '../src/analyze.js'
import { ctx, err, inc, PTR } from '../src/ctx.js'


export default (ctx) => {
  inc('__mkptr', '__alloc', '__alloc_hdr', '__ptr_offset', '__len', '__ptr_type')

  // Object literal: {x: 1, y: 2} → allocate, fill, return pointer with schemaId.
  // OBJECT alloc uses __alloc_hdr (16-byte header at off-16) to enable per-object
  // propsPtr — dyn property writes (e.g. `ctx.metadata = {}` in watr) hit the
  // per-object hash directly, skipping the global __dyn_props probe. The
  // header gate `off >= __heap_start` keeps static-segment objects on the
  // global-hash path (their off-16 belongs to neighboring static slots).
  ctx.core.emit['{}'] = (...rawProps) => {
    if (rawProps.length === 0)
      return mkPtrIR(PTR.OBJECT, 0, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', 1], ['i32.const', 8]])

    // Flatten comma-grouped props: [',', p1, p2] → [p1, p2]
    const props = rawProps.length === 1 && Array.isArray(rawProps[0]) && rawProps[0][0] === ','
      ? rawProps[0].slice(1) : rawProps

    const target = takeLiteralTarget()

    // Object spread: {...a, x: 1, ...b} — merge schemas, copy props from sources
    const hasSpreads = props.some(p => Array.isArray(p) && p[0] === '...')
    if (hasSpreads) return emitObjectSpread(props, target)

    const names = [], values = []
    for (const p of props) {
      if (Array.isArray(p) && p[0] === ':') { names.push(p[1]); values.push(p[2]) }
    }

    // Use variable's merged schema if available (from Object.assign inference), else register literal schema.
    let schemaId = ctx.schema.register(names)
    if (target) {
      const merged = ctx.schema.resolve(target)
      if (merged) schemaId = ctx.schema.idOf(target)
    }
    const schema = ctx.schema.list[schemaId]
    const t = tempI32('obj')
    const ptr = temp('objp')

    // R: Static data segment for objects of pure-literal property values (own-memory only).
    // Even with shadow needed, we can skip alloc + N stores; just feed literal values to __dyn_set.
    const shadow = needsDynShadow(target)
    if (values.length >= 2 && !ctx.memory.shared) {
      const emitted = values.map(emit)
      // asF64 folds i32.const → f64.const so int-literal values also qualify.
      const slots = emitted.map(v => extractF64Bits(asF64(v)))
      if (slots.every(b => b !== null)) {
        const off = appendStaticSlots(slots)
        const staticPtr = mkPtrIR(PTR.OBJECT, schemaId, off)
        if (!shadow) return staticPtr
        inc('__dyn_set')
        const body = [['local.set', `$${ptr}`, staticPtr]]
        for (let i = 0; i < schema.length; i++)
          body.push(['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', ['local.get', `$${ptr}`]],
            asI64(emit(['str', String(schema[i])])), asI64(emitted[i])]])
        body.push(['local.get', `$${ptr}`])
        return typed(['block', ['result', 'f64'], ...body], 'f64')
      }
    }

    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', Math.max(1, schema.length)], ['i32.const', 8]]],
    ]
    for (let i = 0; i < values.length; i++)
      body.push(['f64.store', slotAddr(t, i), asF64(emit(values[i]))])
    body.push(['local.set', `$${ptr}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`])])
    if (shadow) {
      inc('__dyn_set')
      for (let i = 0; i < schema.length; i++)
        body.push(['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', ['local.get', `$${ptr}`]], asI64(emit(['str', String(schema[i])])),
          ['i64.load', slotAddr(t, i)]]])
    }
    body.push(['local.get', `$${ptr}`])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // === Object static methods ===

  ctx.core.emit['Object.keys'] = (obj) => {
    if (isHashTyped(obj)) return emitHashKeys(obj)
    const schema = resolveSchema(obj)
    if (schema) return emitStringArray(schema)
    // Receiver type unknown at compile time. Dispatch on ptr-type at
    // runtime: HASH walks the probe table, anything else returns [].
    return emitRuntimeKeys(obj)
  }

  ctx.core.emit['Object.values'] = (obj) => {
    const schema = resolveSchema(obj)
    if (!schema) err('Object.values requires object with known schema')
    const va = asF64(emit(obj))
    const n = schema.length
    const t = temp('ov'), base = tempI32('vb')
    const out = allocPtr({ type: PTR.ARRAY, len: n, tag: 'oa' })
    const body = [['local.set', `$${t}`, va], out.init,
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]]
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
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]]
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
      const vt = repOf(target)?.val
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
        updateRep(target, { schemaId })
        const t = tempI32('bx'), s = temp('bs')
        const body = [
          ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', Math.max(1, boxedSchema.length)], ['i32.const', 8]]],
          ['f64.store', ['local.get', `$${t}`], asF64(emit(target))],
        ]
        const sBase = tempI32('sb')
        for (const source of sources) {
          const sSchema = resolveSchema(source)
          body.push(['local.set', `$${s}`, asF64(emit(source))])
          body.push(['local.set', `$${sBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]])
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
      ['local.set', `$${tBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]]
    for (const source of sources) {
      const sSchema = resolveSchema(source)
      if (!sSchema) err('Object.assign: source needs known schema')
      body.push(['local.set', `$${s}`, asF64(emit(source))])
      body.push(['local.set', `$${sBase2}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]])
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
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', va]]],
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', va]]],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$brk${id}`, ['loop', `$loop${id}`,
        ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
        // Load pair (array of 2): pair = ptr_offset(arr[i])
        ['local.set', `$${pair}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64',
          ['f64.load', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]]]],
        // hash_set(result, pair[0], pair[1])
        ['local.set', `$${t}`, ['f64.reinterpret_i64', ['call', '$__hash_set', ['i64.reinterpret_f64', ['local.get', `$${t}`]],
          ['i64.load', ['local.get', `$${pair}`]],
          ['i64.load', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]]]]]],
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
      // Header propsPtr lives at $off-16 (current ARRAY layout). We alias src's hash
      // by copying the slot; __dyn_move covers the shifted-array case where props
      // were migrated to the global __dyn_props.
      inc('__arr_from', '__dyn_move', '__ptr_offset')
      const src = temp('ocs')
      const dst = temp('ocd')
      const srcOff = tempI32('ocso')
      const dstOff = tempI32('ocdo')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${src}`, asF64(emit(proto))],
        ['local.set', `$${dst}`, ['call', '$__arr_from', ['i64.reinterpret_f64', ['local.get', `$${src}`]]]],
        ['local.set', `$${srcOff}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${src}`]]]],
        ['local.set', `$${dstOff}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${dst}`]]]],
        ['f64.store',
          ['i32.sub', ['local.get', `$${dstOff}`], ['i32.const', 16]],
          ['f64.load', ['i32.sub', ['local.get', `$${srcOff}`], ['i32.const', 16]]]],
        ['call', '$__dyn_move',
          ['local.get', `$${srcOff}`],
          ['local.get', `$${dstOff}`]],
        ['local.get', `$${dst}`]], 'f64')
    }
    const schema = resolveSchema(proto)
    if (!schema) {
      if (protoType == null) {
        const value = temp('ocr')
        inc('__arr_from', '__dyn_move', '__ptr_offset')
        const dst2 = temp('ocd')
        const srcOff2 = tempI32('ocso')
        const dstOff2 = tempI32('ocdo')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${value}`, asF64(emit(proto))],
          ['if', ['result', 'f64'],
            ['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${value}`]]], ['i32.const', PTR.ARRAY]],
            ['then', ['block', ['result', 'f64'],
              ['local.set', `$${dst2}`, ['call', '$__arr_from', ['i64.reinterpret_f64', ['local.get', `$${value}`]]]],
              ['local.set', `$${srcOff2}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${value}`]]]],
              ['local.set', `$${dstOff2}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${dst2}`]]]],
              ['f64.store',
                ['i32.sub', ['local.get', `$${dstOff2}`], ['i32.const', 16]],
                ['f64.load', ['i32.sub', ['local.get', `$${srcOff2}`], ['i32.const', 16]]]],
              ['call', '$__dyn_move',
                ['local.get', `$${srcOff2}`],
                ['local.get', `$${dstOff2}`]],
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
      ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', Math.max(1, n)], ['i32.const', 8]]],
      ['local.set', `$${srcBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]],
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
function takeLiteralTarget() {
  const frame = ctx.schema.targetStack.at(-1)
  if (!frame) return null
  if (typeof frame === 'string') return frame
  if (!frame.active) return null
  frame.active = false
  return frame.name
}

function emitObjectSpread(props, spreadTarget = takeLiteralTarget()) {
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

  const body = [['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', Math.max(1, schema.length)], ['i32.const', 8]]]]

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
            ['f64.reinterpret_i64', ['call', '$__dyn_get_or', ['i64.reinterpret_f64', ['local.get', `$${srcF}`]],
              asI64(emit(['str', String(schema[i])])),
              ['i64.load', slot]]]])
        }
        continue
      }
      body.push(['local.set', `$${src}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', asF64(emit(p[1]))]]])
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
  if (needsDynShadow(spreadTarget)) {
    inc('__dyn_set')
    for (let i = 0; i < schema.length; i++)
      body.push(['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', ['local.get', `$${ptr}`]], asI64(emit(['str', String(schema[i])])),
        ['i64.load', slotAddr(t, i)]]])
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

// VAL.HASH covers both literal-typed bindings and JSON-shape inferred chains
// (e.g. JSON.parse('{...}') → walked via shapeOf for nested `.prop` access).
// Schema fallback only fires when the static path can't classify the receiver.
function isHashTyped(obj) {
  if (typeof obj === 'string') return lookupValType(obj) === VAL.HASH
  return valTypeOf(obj) === VAL.HASH
}

// HASH layout: open-addressed probe table, each entry 24 bytes —
// [hash:f64][key:f64][value:f64]. Slot is empty when hash field == 0
// (tombstone == 1). __len exposes live entry count at off-8; __cap exposes
// slot count at off-4. Output array is pre-sized to __len; walk all cap
// slots and append occupied keys. Iteration order is hash-derived, matching
// jz's `for-in` over HASH — not the JS spec's insertion order.
function emitHashKeys(obj) {
  const t = temp('hk')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, asF64(emit(obj))],
    hashKeysFromTemp(t)], 'f64')
}

// Inline body of the HASH walk against an already-bound f64 local. Shared by
// the static-HASH path and the runtime-dispatch path so both produce the same
// IR shape from the same source — only difference is whether they enter from
// a static type guard or a runtime ptr-type check.
function hashKeysFromTemp(t) {
  inc('__ptr_offset', '__cap', '__len')
  const off = tempI32('hko'), cap = tempI32('hkc'), n = tempI32('hkn')
  const i = tempI32('hki'), o = tempI32('hkj'), slot = tempI32('hks')
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'hka' })
  const id = ctx.func.uniq++
  return ['block', ['result', 'f64'],
    ['local.set', `$${n}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    out.init,
    ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${cap}`, ['call', '$__cap', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['local.set', `$${o}`, ['i32.const', 0]],
    ['block', `$brk${id}`, ['loop', `$loop${id}`,
      ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${cap}`]]],
      ['local.set', `$${slot}`, ['i32.add', ['local.get', `$${off}`],
        ['i32.mul', ['local.get', `$${i}`], ['i32.const', 24]]]],
      ['if', ['f64.ne', ['f64.load', ['local.get', `$${slot}`]], ['f64.const', 0]],
        ['then',
          elemStore(out.local, o,
            ['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]]),
          ['local.set', `$${o}`, ['i32.add', ['local.get', `$${o}`], ['i32.const', 1]]]]],
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$loop${id}`]]],
    out.ptr]
}

// Type-unknown receiver: bind the value, branch on ptr-type. HASH walks the
// probe table; everything else (ARRAY, OBJECT-without-resolvable-schema,
// nullish, primitives) returns an empty array. The empty-array fallback is
// allocated in both arms for type uniformity at the if-result boundary.
function emitRuntimeKeys(obj) {
  inc('__ptr_type')
  const t = temp('rk')
  const empty = allocPtr({ type: PTR.ARRAY, len: 0, tag: 'rke' })
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, asF64(emit(obj))],
    ['if', ['result', 'f64'],
      ['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]], ['i32.const', PTR.HASH]],
      ['then', hashKeysFromTemp(t)],
      ['else', ['block', ['result', 'f64'], empty.init, empty.ptr]]]], 'f64')
}
