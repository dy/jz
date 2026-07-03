/**
 * Object module — literals and property access.
 *
 * Type=6 (OBJECT): schemaId in aux, properties as sequential f64 in memory.
 * Schema = compile-time known property names. Access by index via ptr module.
 *
 * @module object
 */

import { typed, asF64, asI64, NULL_NAN, UNDEF_NAN, temp, tempI32, tempI64, block64, ptrTypeEq, dispatchByPtrType, allocPtr, needsDynShadow, mkPtrIR, extractF64Bits, appendStaticSlots, slotAddr, elemLoad, elemStore, boolBoxIR } from '../src/ir.js'
import { emit } from '../src/bridge.js'
import { staticArrayPtr } from './array.js'
import { valTypeOf, shapeOf } from '../src/kind.js'
import { VAL, lookupValType, repOf, updateRep } from '../src/reps.js'
import { ctx, err, inc, PTR, LAYOUT, declGlobal } from '../src/ctx.js'

// Object.prototype.toString tag per value category. Matches what JS engines
// return for primitive/built-in types; canonicalized from
// `Object.prototype.toString.call(x)` by jzify (see jzify/bundler.js).
const OBJECT_TO_STRING_TAGS = {
  [VAL.NUMBER]:  '[object Number]',
  [VAL.BIGINT]:  '[object BigInt]',
  [VAL.BOOL]:    '[object Boolean]',
  [VAL.STRING]:  '[object String]',
  [VAL.ARRAY]:   '[object Array]',
  [VAL.OBJECT]:  '[object Object]',
  [VAL.HASH]:    '[object Object]',
  [VAL.SET]:     '[object Set]',
  [VAL.MAP]:     '[object Map]',
  [VAL.CLOSURE]: '[object Function]',
  [VAL.REGEX]:   '[object RegExp]',
  [VAL.DATE]:    '[object Date]',
  [VAL.BUFFER]:  '[object ArrayBuffer]',
  [VAL.TYPED]:   '[object Object]',
}

const objectToStringTagForVal = (obj) => {
  const val = typeof obj === 'string' ? lookupValType(obj) : valTypeOf(obj)
  return val ? OBJECT_TO_STRING_TAGS[val] : null
}

// emit(node) ONCE, before branching — same self-host miscompile class as emit.js's
// 'return' handler (src/compile/emit.js): emit(node) called separately inline per
// ternary arm, wrapped by a DIFFERENT coercion (boolBoxIR vs asF64) per arm, is
// behaviorally identical in JS but self-host-fragile. See .work/selfhost-perf-groundtruth.md.
const storedValue = (node) => {
  const emitted = emit(node)
  return valTypeOf(node) === VAL.BOOL ? boolBoxIR(emitted) : asF64(emitted)
}

export default (ctx) => {
  inc('__mkptr', '__alloc', '__alloc_hdr', '__ptr_offset', '__len', '__ptr_type')

  // Object literal: {x: 1, y: 2} → allocate, fill, return pointer with schemaId.
  // OBJECT alloc uses __alloc_hdr (16-byte header at off-16) to enable per-object
  // propsPtr — dyn property writes (e.g. `ctx.metadata = {}` in watr) hit the
  // per-object hash directly, skipping the global __dyn_props probe. The
  // header gate `off >= __heap_start` keeps static-segment objects on the
  // global-hash path (their off-16 belongs to neighboring static slots).
  ctx.core.emit['{}'] = (...rawProps) => {
    if (rawProps.length === 0) {
      // Honor the literal target's autobox/merged schema so `let ctx = {}` followed
      // by `ctx.meta = ...` allocates with the right cap. Otherwise the default
      // cap=1 alloc overwrites the autobox preamble's wrapper, and subsequent
      // schema-slot writes to offsets >= 8 land out-of-bounds.
      const target = takeLiteralTarget()
      const merged = target ? ctx.schema.resolve(target) : null
      // Register the empty schema so schemaId always indexes a real schema.list
      // entry — __json_obj and dyn-get load keys via $__schema_tbl[sid] and would
      // crash on an unregistered id 0 (table left uninitialized when list empty).
      const schemaId = merged ? ctx.schema.idOf(target) : ctx.schema.register([])
      const cap = ctx.abi.object.ops.allocSlots(merged ? merged.length : 0)
      return mkPtrIR(PTR.OBJECT, schemaId, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', cap]])
    }

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

    // Use variable's merged schema if available (from Object.assign inference),
    // else register the literal's own schema. The merged schema is adopted only
    // when it is a *superset* of the literal's own fields — a legitimate
    // accumulation (`let o = {}; o.x = …`) always contains every literal key.
    // A merged schema missing any literal field is a stale cross-function name
    // collision (ctx.schema.vars is module-global, keyed by bare name): adopting
    // it would size the alloc to the wrong schema and overflow the object's
    // slots, corrupting adjacent heap. The literal is authoritative for its own
    // shape, so re-bind the variable to it for precise same-function reads.
    const litId = ctx.schema.register(names)
    let schemaId = litId
    if (target) {
      const merged = ctx.schema.resolve(target)
      if (merged && names.every(n => merged.includes(n))) schemaId = ctx.schema.idOf(target)
      else if (names.length) ctx.schema.vars.set(target, litId)
    }
    const schema = ctx.schema.list[schemaId]
    const t = tempI32('obj')
    const ptr = temp('objp')

    // R: Static data segment for objects of pure-literal property values (own-memory only).
    // Even with shadow needed, we can skip alloc + N stores; just feed literal values to __dyn_set.
    const shadow = needsDynShadow(target)
    // When the literal adopts a superset/merged schema (schemaId !== litId), the
    // field order in `schema` can differ from the literal's `names`, so each value
    // must land at its named slot `schema.indexOf(name)` — a positional `slot = i`
    // store would scatter values into the wrong (or another field's) slots.
    const slotOf = schemaId === litId ? (i => i) : (i => schema.indexOf(names[i]))
    // SOUNDNESS GATE: a static literal is ONE shared instance — every evaluation
    // returns the same pointer. That is only faithful when the object is never
    // mutated: `let mk = () => ({n:0,m:0}); mk().n++` must not bleed into the
    // next mk(). writtenProps (program-facts) holds every property name ever
    // written through ANY receiver — including expression receivers like
    // `map.get(k).n++` that no alias analysis could attribute — so a literal
    // whose schema intersects it allocates per-evaluation instead.
    const neverWritten = names.every(n => !ctx.module.writtenProps?.has(n))
    if (neverWritten && values.length >= 2 && values.length === schema.length && !ctx.memory.shared) {
      const emitted = values.map(storedValue)
      // asF64 folds i32.const → f64.const so int-literal values also qualify.
      const slots = emitted.map(v => extractF64Bits(v))
      if (slots.every(b => b !== null)) {
        // Reorder into schema-slot order before laying out the static segment.
        const ordered = emitted.map(() => null), orderedBits = emitted.map(() => null)
        for (let i = 0; i < values.length; i++) { ordered[slotOf(i)] = emitted[i]; orderedBits[slotOf(i)] = slots[i] }
        const off = appendStaticSlots(orderedBits)
        const staticPtr = mkPtrIR(PTR.OBJECT, schemaId, off)
        if (!shadow) return staticPtr
        inc('__dyn_set')
        const body = [['local.set', `$${ptr}`, staticPtr]]
        for (let i = 0; i < schema.length; i++)
          body.push(['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', ['local.get', `$${ptr}`]],
            asI64(emit(['str', String(schema[i])])), asI64(ordered[i])]])
        body.push(['local.get', `$${ptr}`])
        return typed(['block', ['result', 'f64'], ...body], 'f64')
      }
    }

    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(schema.length)]]],
    ]
    for (let i = 0; i < values.length; i++)
      body.push(ctx.abi.object.ops.store(['local.get', `$${t}`], slotOf(i), storedValue(values[i])))
    body.push(['local.set', `$${ptr}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`])])
    if (shadow) {
      inc('__dyn_set')
      for (let i = 0; i < schema.length; i++)
        body.push(['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', ['local.get', `$${ptr}`]], asI64(emit(['str', String(schema[i])])),
          ctx.abi.object.ops.loadBits(['local.get', `$${t}`], i)]])
    }
    body.push(['local.get', `$${ptr}`])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // === Object static methods ===

  ctx.core.emit['Object.freeze'] = (obj) => asF64(emit(obj))

  // Object.is(a, b) — SameValue, which on NaN-boxed f64 values is exact bit
  // equality. That is precisely why it diverges from `===`: +0 and -0 carry
  // distinct bit patterns (→ false), and a NaN equals itself bit-for-bit
  // (→ true). Objects/booleans/null/undefined compare by their fixed boxed
  // bits, i.e. reference identity, as SameValue requires. (Two distinct heap
  // strings would compare by pointer rather than content; jz only uses numeric
  // Object.is — overwhelmingly `Object.is(x, -0)` — so that path never arises.)
  ctx.core.emit['Object.is'] = (a, b) => typed(['i64.eq', asI64(emit(a)), asI64(emit(b))], 'i32')

  // Object.isExtensible / isSealed / isFrozen.
  // jz fixes an object's schema at construction: a `{…}` literal can
  // neither grow nor lose keys, so an OBJECT value is non-extensible and
  // sealed; its slots stay writable, so it is not frozen. Arrays, maps,
  // sets and hashes grow dynamically → extensible. Primitives are
  // non-objects → ES2015 reports them sealed & frozen, not extensible.
  const extKind = (obj) => {
    const t = typeof obj === 'string' ? lookupValType(obj) : valTypeOf(obj)
    if (t === VAL.OBJECT) return { ext: 0, sealed: 1, frozen: 0 }
    if (t === VAL.NUMBER || t === VAL.STRING || t === VAL.BIGINT) return { ext: 0, sealed: 1, frozen: 1 }
    return { ext: 1, sealed: 0, frozen: 0 }
  }
  const objQuery = (pick) => (obj) => {
    const v = pick(extKind(obj))
    if (obj == null) return typed(['f64.const', v], 'f64')
    return typed(['block', ['result', 'f64'], ['drop', asF64(emit(obj))], ['f64.const', v]], 'f64')
  }
  ctx.core.emit['Object.isExtensible'] = objQuery((k) => k.ext)
  ctx.core.emit['Object.isSealed'] = objQuery((k) => k.sealed)
  ctx.core.emit['Object.isFrozen'] = objQuery((k) => k.frozen)

  // RequireObjectCoercible: Object.keys/values/entries reject null & undefined
  // with a TypeError. A literal lowers to a [null, value] node — so `null` is
  // [null, null] and `undefined` is [null, undefined] (both JSON-print alike);
  // a missing argument arrives as JS undefined. Anything else (incl.
  // booleans/numbers, which JS boxes) is left to the normal path.
  const isNullishLiteral = (node) => node === undefined
    || (Array.isArray(node) && node.length === 2 && node[0] == null && node[1] == null)
  const requireCoercible = (node) => {
    if (!isNullishLiteral(node)) return null
    ctx.runtime.throws = true
    return typed(['block', ['result', 'f64'], ['throw', '$__jz_err', ['f64.const', 0]]], 'f64')
  }

  // Arrays and (coerced) strings expose their indices as own enumerable
  // keys — Object.keys/entries iterate "0".."n-1". `arrayValType` mirrors
  // `stringValType` below: a string arg is a variable name, anything else
  // an AST node.
  const arrayValType = (obj) => (typeof obj === 'string' ? lookupValType(obj) : valTypeOf(obj)) === VAL.ARRAY
  // Index-string key array for an array-like receiver. `lenCall` is the
  // length builtin: __len for jz arrays, __str_len for strings.
  const idxKeys = (obj, lenCall) => {
    inc(lenCall, '__to_str')
    const v = temp('ik'), i = tempI32('iki'), len = tempI32('ikl')
    const vPtr = () => ['i64.reinterpret_f64', ['local.get', `$${v}`]]
    const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${len}`], tag: 'ik' })
    const id = ctx.func.uniq++
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${v}`, asF64(emit(obj))],
      ['local.set', `$${len}`, ['call', `$${lenCall}`, vPtr()]],
      out.init,
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$brk${id}`, ['loop', `$loop${id}`,
        ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
        elemStore(out.local, i, ['f64.reinterpret_i64',
          ['call', '$__to_str', ['i64.reinterpret_f64', ['f64.convert_i32_s', ['local.get', `$${i}`]]]]]),
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]],
      out.ptr], 'f64')
  }

  ctx.core.emit['Object.keys'] = (obj) => {
    const nullish = requireCoercible(obj)
    if (nullish) return nullish
    if (isHashTyped(obj)) return emitHashKeys(obj)
    if (arrayValType(obj)) return idxKeys(obj, '__len')
    if (stringValType(obj)) return idxKeys(obj, '__str_len')
    const schema = resolveSchema(obj)
    // A static schema lists only the literal-known keys; a var that takes
    // computed writes (`o[k]=v`) also carries props in its per-object dyn HASH
    // that the schema omits. Enumerate those live (schema ∪ dyn props) — the gap
    // that blocked metacircularity (the compiler grows dicts then enumerates).
    if (schema && !mayHaveDynProps(obj)) return emitStringArray(schema)
    // Unknown receiver, or schema with possible dyn props: dispatch on ptr-type
    // at runtime (HASH probe table / OBJECT schema+dyn merge / else []).
    return emitRuntimeKeys(obj)
  }
  ctx.core.emit['Object.getOwnPropertyNames'] = ctx.core.emit['Object.keys']

  // for-in's read-only key enumeration (src/prepare for…in lowering). Identical to
  // Object.keys EXCEPT: when the receiver is a bare variable with a complete static
  // schema, the key list is a compile-time constant, so it pools ONE static-data
  // array (no per-evaluation alloc) — eliminating for-in's hot-loop heap-growth
  // cliff and its unbounded-allocation OOM. The pooled array is shared/read-only,
  // which is sound because for-in only reads ks[i]/ks.length (Object.keys can't pool:
  // user code may `.sort()`/`.reverse()` the result in place). Anything not a static
  // schema bare-var — arrays/strings/HASH/dyn-props/expressions — delegates to
  // Object.keys (evaluates the receiver, full runtime enumeration).
  ctx.core.emit['__keys_ro'] = (obj) => {
    // Pool only when the receiver's enumerable key set is provably the static
    // schema: a bare var with NO computed-key writes (`o[k]=v`) — those are the
    // only writes that add enumerable keys (computed reads / dot-adds don't).
    // `mayHaveDynProps` is too coarse here — it also flags computed-READ receivers,
    // and for-in's own `o[k]` read would otherwise veto its own pooling.
    if (typeof obj === 'string' && !ctx.types.dynWriteVars?.has(obj) && !isHashTyped(obj) && !arrayValType(obj) && !stringValType(obj)) {
      const schema = resolveSchema(obj)
      if (schema) {
        const slots = schema.map(name => extractF64Bits(asF64(emit(['str', name]))))
        if (slots.every(b => b !== null)) return staticArrayPtr(slots)
      }
    }
    return ctx.core.emit['Object.keys'](obj)
  }

  // Object.prototype.hasOwnProperty(key) — own-property presence check.
  // Compile-time fold for literal keys against object literals or variables
  // with known schemas; runtime path delegates to the `in` operator (same
  // ptr-type dispatch + __hash_has for HASH, dyn_props probe for OBJECT).
  ctx.core.emit['.hasOwnProperty'] = (obj, key) => {
    const litKey = Array.isArray(key) && key[0] === 'str' ? String(key[1]) : null
    if (litKey != null) {
      if (Array.isArray(obj) && obj[0] === '{}') {
        const has = obj.slice(1).some(p => Array.isArray(p) && p[0] === ':' && String(p[1]) === litKey)
        return typed(['block', ['result', 'f64'],
          ['drop', asF64(emit(obj))],
          ['f64.const', has ? 1 : 0]], 'f64')
      }
      if (typeof obj === 'string' && ctx.schema.slotOf?.(obj, litKey) >= 0)
        return typed(['f64.const', 1], 'f64')
    }
    return typed(['f64.convert_i32_s', emit(['in', key, obj])], 'f64')
  }
  ctx.core.emit[`.${VAL.HASH}:hasOwnProperty`] = ctx.core.emit['.hasOwnProperty']
  ctx.core.emit[`.${VAL.OBJECT}:hasOwnProperty`] = ctx.core.emit['.hasOwnProperty']
  ctx.core.emit[`.${VAL.ARRAY}:hasOwnProperty`] = ctx.core.emit['.hasOwnProperty']
  ctx.core.emit[`.${VAL.STRING}:hasOwnProperty`] = ctx.core.emit['.hasOwnProperty']
  ctx.core.emit[`.${VAL.CLOSURE}:hasOwnProperty`] = ctx.core.emit['.hasOwnProperty']
  // Object.hasOwn(o, k) — ES2022 static equivalent of o.hasOwnProperty(k).
  // Reuses the same own-property emitter; receiver-type variants above apply.
  ctx.core.emit['Object.hasOwn'] = (obj, key) => ctx.core.emit['.hasOwnProperty'](obj, key)

  // __object_toString(value) — canonicalized from `Object.prototype.toString.call(value)`
  // by jzify. Returns the spec-defined "[object Tag]" string. When the value's category
  // is known at compile time the tag folds to a static string load; otherwise the
  // runtime path dispatches on NaN-box bits (NaN→Number, NULL/UNDEF, then PTR type).
  ctx.core.emit['__object_toString'] = (obj) => {
    const emitTag = value => asF64(emit(['str', value]))
    const tag = objectToStringTagForVal(obj)
    if (tag) return block64(['drop', asF64(emit(obj))], emitTag(tag))

    const value = temp('otag'), type = tempI32('otagt')
    const bits = ['i64.reinterpret_f64', ['local.get', `$${value}`]]
    const byType = dispatchByPtrType(type, [
      [PTR.STRING,  emitTag('[object String]')],
      [PTR.ARRAY,   emitTag('[object Array]')],
      [PTR.BUFFER,  emitTag('[object ArrayBuffer]')],
      [PTR.CLOSURE, emitTag('[object Function]')],
      [PTR.SET,     emitTag('[object Set]')],
      [PTR.MAP,     emitTag('[object Map]')],
    ], emitTag('[object Object]'))
    const pointerTag = block64(['local.set', `$${type}`, ['call', '$__ptr_type', bits]], byType)
    const nonNumericTag = ['if', ['result', 'f64'],
      ['i64.eq', bits, ['i64.const', NULL_NAN]],
      ['then', emitTag('[object Null]')],
      ['else', ['if', ['result', 'f64'],
        ['i64.eq', bits, ['i64.const', UNDEF_NAN]],
        ['then', emitTag('[object Undefined]')],
        ['else', pointerTag]]]]
    return block64(
      ['local.set', `$${value}`, asF64(emit(obj))],
      ['if', ['result', 'f64'],
        ['f64.eq', ['local.get', `$${value}`], ['local.get', `$${value}`]],
        ['then', emitTag('[object Number]')],
        ['else', nonNumericTag]])
  }

  // String primitives are coerced to exotic String objects whose own enumerable
  // properties are the indexed characters. Object.values/entries iterate them.
  const stringValType = (obj) => (typeof obj === 'string' ? lookupValType(obj) : valTypeOf(obj)) === VAL.STRING

  ctx.core.emit['Object.values'] = (obj) => {
    const nullish = requireCoercible(obj)
    if (nullish) return nullish
    if (stringValType(obj)) {
      inc('__str_idx', '__str_len')
      const s = temp('osv'), i = tempI32('osvi'), len = tempI32('osvl')
      const sPtr = () => ['i64.reinterpret_f64', ['local.get', `$${s}`]]
      const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${len}`], tag: 'osv' })
      const id = ctx.func.uniq++
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${s}`, asF64(emit(obj))],
        ['local.set', `$${len}`, ['call', '$__str_len', sPtr()]],
        out.init,
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$brk${id}`, ['loop', `$loop${id}`,
          ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
          elemStore(out.local, i, ['call', '$__str_idx', sPtr(), ['local.get', `$${i}`]]),
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]],
        out.ptr], 'f64')
    }
    if (arrayValType(obj)) { inc('__arr_from'); return typed(['call', '$__arr_from', asI64(emit(obj))], 'f64') }
    if (isHashTyped(obj)) return emitHashValues(obj)
    const schema = resolveSchema(obj)
    if (!schema || mayHaveDynProps(obj)) return emitRuntimeValues(obj)
    const va = asF64(emit(obj))
    const n = schema.length
    const t = temp('ov'), base = tempI32('vb')
    const out = allocPtr({ type: PTR.ARRAY, len: n, tag: 'oa' })
    const body = [['local.set', `$${t}`, va], out.init,
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]]
    for (let i = 0; i < n; i++)
      body.push(['f64.store', slotAddr(out.local, i), ctx.abi.object.ops.load(['local.get', `$${base}`], i)])
    body.push(out.ptr)
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  ctx.core.emit['Object.entries'] = (obj) => {
    const nullish = requireCoercible(obj)
    if (nullish) return nullish
    if (stringValType(obj)) {
      inc('__str_idx', '__str_len', '__to_str')
      const s = temp('oes'), i = tempI32('oesi'), len = tempI32('oesl'), pair = tempI32('oep')
      const sPtr = () => ['i64.reinterpret_f64', ['local.get', `$${s}`]]
      const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${len}`], tag: 'oes' })
      const id = ctx.func.uniq++
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${s}`, asF64(emit(obj))],
        ['local.set', `$${len}`, ['call', '$__str_len', sPtr()]],
        out.init,
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$brk${id}`, ['loop', `$loop${id}`,
          ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
          ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2]]],
          ['f64.store', slotAddr(pair, 0), ['f64.reinterpret_i64',
            ['call', '$__to_str', ['i64.reinterpret_f64', ['f64.convert_i32_s', ['local.get', `$${i}`]]]]]],
          ['f64.store', slotAddr(pair, 1), ['call', '$__str_idx', sPtr(), ['local.get', `$${i}`]]],
          elemStore(out.local, i, mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${pair}`])),
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]],
        out.ptr], 'f64')
    }
    if (arrayValType(obj)) {
      inc('__len', '__to_str', '__ptr_offset', '__alloc_hdr')
      const v = temp('oea'), i = tempI32('oeai'), len = tempI32('oeal'), base = tempI32('oeab'), pair = tempI32('oeap')
      const vPtr = () => ['i64.reinterpret_f64', ['local.get', `$${v}`]]
      const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${len}`], tag: 'oea' })
      const id = ctx.func.uniq++
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${v}`, asF64(emit(obj))],
        ['local.set', `$${len}`, ['call', '$__len', vPtr()]],
        out.init,
        ['local.set', `$${base}`, ['call', '$__ptr_offset', vPtr()]],
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$brk${id}`, ['loop', `$loop${id}`,
          ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
          ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2]]],
          ['f64.store', slotAddr(pair, 0), ['f64.reinterpret_i64',
            ['call', '$__to_str', ['i64.reinterpret_f64', ['f64.convert_i32_s', ['local.get', `$${i}`]]]]]],
          ['f64.store', slotAddr(pair, 1), elemLoad(base, i)],
          elemStore(out.local, i, mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${pair}`])),
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$loop${id}`]]],
        out.ptr], 'f64')
    }
    if (isHashTyped(obj)) return emitHashEntries(obj)
    const schema = resolveSchema(obj)
    if (!schema || mayHaveDynProps(obj)) return emitRuntimeEntries(obj)
    const va = asF64(emit(obj))
    const n = schema.length
    const t = temp('oe'), pair = tempI32('op'), base = tempI32('eb')
    const out = allocPtr({ type: PTR.ARRAY, len: n, tag: 'oa' })
    const body = [['local.set', `$${t}`, va], out.init,
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]]
    for (let i = 0; i < n; i++) {
      body.push(
        ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2]]],
        ['f64.store', slotAddr(pair, 0), emit(['str', schema[i]])],
        ['f64.store', slotAddr(pair, 1), ctx.abi.object.ops.load(['local.get', `$${base}`], i)],
        ['f64.store', slotAddr(out.local, i), mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${pair}`])])
    }
    body.push(out.ptr)
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  ctx.core.emit['Object.assign'] = (target, ...sources) => {
    // RequireObjectCoercible(target) — null/undefined is a TypeError.
    const nullish = requireCoercible(target)
    if (nullish) return nullish
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
        // Emit-time rep mutation: Object.assign's target gains a freshly-registered
        // boxed-schema binding here; downstream `.prop` reads in the same emit pass
        // depend on schemaId being live on the rep, not just in ctx.schema.vars.
        updateRep(target, { schemaId })
        const t = tempI32('bx'), s = temp('bs')
        const body = [
          ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(boxedSchema.length)]]],
          ctx.abi.object.ops.store(['local.get', `$${t}`], 0, asF64(emit(target))),
        ]
        const sBase = tempI32('sb')
        for (const source of sources) {
          const sSchema = resolveSchema(source)
          body.push(['local.set', `$${s}`, asF64(emit(source))])
          body.push(['local.set', `$${sBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]])
          for (let si = 0; si < sSchema.length; si++) {
            const ti = boxedSchema.indexOf(sSchema[si])
            if (ti < 0) continue
            body.push(ctx.abi.object.ops.store(['local.get', `$${t}`], ti, ctx.abi.object.ops.load(['local.get', `$${sBase}`], si)))
          }
        }
        body.push(['local.set', `$${target}`,
          mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`])])
        body.push(['local.get', `$${target}`])
        return typed(['block', ['result', 'f64'], ...body], 'f64')
      }
    }
    const tSchema = resolveSchema(target)
    const sourceSchemas = sources.map(resolveSchema)
    if (!tSchema) return emitObjectAssignDynamic(target, sources)
    if (sourceSchemas.some(s => !s)) return emitDynamicAssign(target, sources, sourceSchemas)
    const t = temp('at'), s = temp('as')
    const tBase = tempI32('tb'), sBase2 = tempI32('sb')
    // When the target carries a dynamic-props shadow (needsDynShadow), reads of an
    // unknown-schema alias (`let r = Object.assign(t, …); r.a`) dispatch through
    // __dyn_get_any → the hash, not the schema slot. A slot-only write would leave
    // the hash stale, so mirror each store into __dyn_set, exactly as the object
    // literal emit does (above). False unless a collection/dyn-key module is live,
    // so the common fixed-schema assign keeps its slot-only fast path.
    const shadow = needsDynShadow(target)
    if (shadow) inc('__dyn_set')
    const body = [['local.set', `$${t}`, asF64(emit(target))],
      ['local.set', `$${tBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]]
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]
      const sSchema = sourceSchemas[i]
      body.push(['local.set', `$${s}`, asF64(emit(source))])
      body.push(['local.set', `$${sBase2}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]])
      for (let si = 0; si < sSchema.length; si++) {
        const ti = tSchema.indexOf(sSchema[si])
        if (ti < 0) continue
        body.push(ctx.abi.object.ops.store(['local.get', `$${tBase}`], ti, ctx.abi.object.ops.load(['local.get', `$${sBase2}`], si)))
        if (shadow)
          body.push(['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', ['local.get', `$${t}`]],
            asI64(emit(['str', String(tSchema[ti])])), ctx.abi.object.ops.loadBits(['local.get', `$${tBase}`], ti)]])
      }
    }
    body.push(['local.get', `$${t}`])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  ctx.core.emit['Object.defineProperty'] = () => {
    err('Object.defineProperty descriptor semantics are outside jz scope; jzify only folds static bundler export helpers')
  }

  // Object.fromEntries(arr) → creates HASH from array of [key, value] pairs.
  // Spec step 1 is RequireObjectCoercible(iterable): a missing/nullish argument
  // is a TypeError, not an `emit(undefined)` compiler crash.
  ctx.core.emit['Object.fromEntries'] = (arr) => {
    const nullishThrow = requireCoercible(arr)
    if (nullishThrow) return nullishThrow
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
    // Object.create(null) → a fresh, empty, extensible object (no prototype). Without
    // this it falls to the `protoType == null` runtime path below, which returns the
    // proto value (null) itself; property writes on null then land in the GLOBAL
    // __dyn_props table keyed by name, so two such objects collide on same-named keys
    // (`a=Object.create(null); b=Object.create(null); a.x=1; b.x=2` left a.x===2). Reuse
    // the empty-`{}` path, whose per-object hash keeps dynamic keys independent. (Native
    // never hit this — its compiler runs Object.create on the host JS engine.)
    if (isNullishLiteral(proto)) return ctx.core.emit['{}']()
    const protoType = typeof proto === 'string' ? lookupValType(proto) : valTypeOf(proto)
    if (protoType === VAL.ARRAY) {
      // Clone array data + link named-prop sidecar so for-in/bracket-name lookups
      // keep working after Object.create (watr's ctx.local = Object.create(param) pattern).
      // Header propsPtr lives at $off-16 (current ARRAY layout). We alias src's hash
      // by copying the slot; __dyn_move covers the shifted-array case where props
      // were migrated to the global __dyn_props.
      ctx.module.include('array')
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
        ['drop', ['call', '$__dyn_move',
          ['local.get', `$${srcOff}`],
          ['local.get', `$${dstOff}`]]],
        ['local.get', `$${dst}`]], 'f64')
    }
    const schema = resolveSchema(proto)
    if (!schema) {
      if (protoType == null) {
        const value = temp('ocr')
        ctx.module.include('array')
        inc('__arr_from', '__dyn_move', '__ptr_offset')
        const dst2 = temp('ocd')
        const srcOff2 = tempI32('ocso')
        const dstOff2 = tempI32('ocdo')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${value}`, asF64(emit(proto))],
          ['if', ['result', 'f64'],
            ptrTypeEq(['local.get', `$${value}`], PTR.ARRAY),
            ['then', ['block', ['result', 'f64'],
              ['local.set', `$${dst2}`, ['call', '$__arr_from', ['i64.reinterpret_f64', ['local.get', `$${value}`]]]],
              ['local.set', `$${srcOff2}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${value}`]]]],
              ['local.set', `$${dstOff2}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${dst2}`]]]],
              ['f64.store',
                ['i32.sub', ['local.get', `$${dstOff2}`], ['i32.const', 16]],
                ['f64.load', ['i32.sub', ['local.get', `$${srcOff2}`], ['i32.const', 16]]]],
              ['drop', ['call', '$__dyn_move',
                ['local.get', `$${srcOff2}`],
                ['local.get', `$${dstOff2}`]]],
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
      ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(n)]]],
      ['local.set', `$${srcBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]],
    ]
    // Copy all properties from proto
    for (let i = 0; i < n; i++)
      body.push(ctx.abi.object.ops.store(['local.get', `$${t}`], i, ctx.abi.object.ops.load(['local.get', `$${srcBase}`], i)))
    body.push(mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`]))
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }
}

// --- Helpers ---

// Used only after the target schema is known. Unknown HASH targets can grow by
// returning a new pointer, which would not preserve aliases to the old value.
function emitDynamicAssign(target, sources, sourceSchemas = sources.map(resolveSchema)) {
  ctx.module.include('collection')
  inc('__hash_set', '__dyn_get_any', '__ptr_offset', '__len')
  const t = temp('adt'), s = temp('ads'), sBase = tempI32('adsb')
  const keys = temp('adk'), keysBase = tempI32('adkb'), len = tempI32('adn')
  const i = tempI32('adi'), key = temp('adkey')
  const id = ctx.func.uniq++
  const body = [['local.set', `$${t}`, asF64(emit(target))]]

  for (let si = 0; si < sources.length; si++) {
    const source = sources[si]
    const sSchema = sourceSchemas[si]
    body.push(['local.set', `$${s}`, asF64(emit(source))])
    if (sSchema) {
      body.push(['local.set', `$${sBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]])
      for (let pi = 0; pi < sSchema.length; pi++)
        body.push(['local.set', `$${t}`, ['f64.reinterpret_i64',
          ['call', '$__hash_set', ['i64.reinterpret_f64', ['local.get', `$${t}`]],
            asI64(emit(['str', String(sSchema[pi])])),
            ctx.abi.object.ops.loadBits(['local.get', `$${sBase}`], pi)]]])
      continue
    }

    body.push(
      ['local.set', `$${keys}`, runtimeKeysFromTemp(s, 'adk')],
      ['local.set', `$${keysBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${keys}`]]]],
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${keys}`]]]],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$adbrk${id}_${si}`, ['loop', `$adloop${id}_${si}`,
        ['br_if', `$adbrk${id}_${si}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
        ['local.set', `$${key}`, ['f64.load',
          ['i32.add', ['local.get', `$${keysBase}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]],
        ['local.set', `$${t}`, ['f64.reinterpret_i64',
          ['call', '$__hash_set',
            ['i64.reinterpret_f64', ['local.get', `$${t}`]],
            ['i64.reinterpret_f64', ['local.get', `$${key}`]],
            ['call', '$__dyn_get_any',
              ['i64.reinterpret_f64', ['local.get', `$${s}`]],
              ['i64.reinterpret_f64', ['local.get', `$${key}`]]]]]],
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$adloop${id}_${si}`]]])
  }

  if (typeof target === 'string' && ctx.func.locals.get(target) === 'f64')
    body.push(['local.set', `$${target}`, ['local.get', `$${t}`]])
  body.push(['local.get', `$${t}`])
  return typed(['block', ['result', 'f64'], ...body], 'f64')
}

// Object.assign into a target whose schema is unknown at compile time (e.g.
// `ctx.core.stdlibDeps` — an empty `{}` grown dynamically). Copy every source
// key into the target's dynamic props via __dyn_set, which updates the
// per-object hash in place: the target pointer stays stable, so no write-back
// to the (possibly member-access) lvalue is needed. Returns the target.
function emitObjectAssignDynamic(target, sources) {
  ctx.module.include('collection')
  inc('__dyn_set', '__dyn_get_any', '__ptr_offset', '__len')
  const t = temp('oat'), s = temp('oas'), sBase = tempI32('oasb')
  const keys = temp('oak'), keysBase = tempI32('oakb'), len = tempI32('oan')
  const i = tempI32('oai'), key = temp('oakey')
  const id = ctx.func.uniq++
  const setKey = (keyBits, valBits) =>
    ['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', ['local.get', `$${t}`]], keyBits, valBits]]
  const body = [['local.set', `$${t}`, asF64(emit(target))]]

  for (let si = 0; si < sources.length; si++) {
    const source = sources[si]
    const sSchema = resolveSchema(source)
    body.push(['local.set', `$${s}`, asF64(emit(source))])
    if (sSchema) {
      body.push(['local.set', `$${sBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]])
      for (let pi = 0; pi < sSchema.length; pi++)
        body.push(setKey(asI64(emit(['str', String(sSchema[pi])])), ctx.abi.object.ops.loadBits(['local.get', `$${sBase}`], pi)))
      continue
    }
    body.push(
      ['local.set', `$${keys}`, runtimeKeysFromTemp(s, 'oak')],
      ['local.set', `$${keysBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${keys}`]]]],
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${keys}`]]]],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$oabrk${id}_${si}`, ['loop', `$oaloop${id}_${si}`,
        ['br_if', `$oabrk${id}_${si}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
        ['local.set', `$${key}`, ['f64.load',
          ['i32.add', ['local.get', `$${keysBase}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]],
        setKey(['i64.reinterpret_f64', ['local.get', `$${key}`]],
          ['call', '$__dyn_get_any', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['i64.reinterpret_f64', ['local.get', `$${key}`]]]),
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$oaloop${id}_${si}`]]])
  }
  body.push(['local.get', `$${t}`])
  return typed(['block', ['result', 'f64'], ...body], 'f64')
}

// A bound var is dynamically keyed when some `obj[k]=v` (non-literal key) wrote
// to it — program-facts records these in `ctx.types.dynKeyVars`. Such an object
// can hold props beyond its static schema, so schema-only enumeration would drop
// them; callers route it through the runtime schema∪dyn-props merge instead.
const mayHaveDynProps = (obj) => typeof obj === 'string' && !!ctx.types.dynKeyVars?.has(obj)

function resolveSchema(obj) {
  if (typeof obj === 'string') return ctx.schema.resolve(obj)
  if (Array.isArray(obj) && obj[0] === '{}')
    return obj.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
  // JSON-shape inferred: JSON.parse(constStr) call or `.prop`/`[i]` chain
  // resolving to a known OBJECT shape carries its key list as `names`.
  const sh = shapeOf(obj)
  if (sh?.val === VAL.OBJECT && sh.names) return sh.names
  return null
}

// Schema of a spread SOURCE, for the OBJECT-vs-HASH decision. A function
// parameter's runtime shape is caller-determined — its `resolveSchema` is an
// inferred/union guess bound only by emit (analysis sees it as unknown). Trusting
// it would (a) slot-index-copy from a layout the actual argument need not have and
// (b) make emit build an OBJECT while analysis HASH-typed the binding, so reads
// misdispatch. Treat params as unknown → dynamic runtime-key spread (always sound),
// mirroring spreadSchema in src/kind.js so both phases agree.
function spreadSourceSchema(obj) {
  if (typeof obj === 'string' && ctx.func.current?.params?.some(p => p.name === obj)) return null
  return resolveSchema(obj)
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
  // Resolve every spread source's schema. A source with no static schema means
  // its full key set is unknown at compile time, so the merge result must be a
  // HASH (dynamic dict) — a fixed schema would silently drop the source's keys
  // it doesn't list. Only when EVERY source is known do we build the fixed-shape
  // OBJECT below.
  const allNames = []
  const addName = n => { if (!allNames.includes(n)) allNames.push(n) }
  let allKnown = true
  for (const p of props) {
    if (Array.isArray(p) && p[0] === '...') {
      const s = spreadSourceSchema(p[1])
      if (s) for (const n of s) addName(n)
      else allKnown = false
    } else if (Array.isArray(p) && p[0] === ':') addName(p[1])
  }
  // Single unknown spread `{ ...src }` → shallow-clone src at runtime, preserving
  // its type (OBJECT→OBJECT, HASH→HASH). Aliasing src (the old shortcut) leaked
  // every later write to the result back into the source — a real correctness bug
  // (jz's own narrow.js had to hand-route around it). __obj_clone keys off the
  // box's runtime schemaId, so it copies static-segment sources too; the schema
  // table it reads must exist, so declare + force it (assemble.js).
  if (!allKnown && props.length === 1 && Array.isArray(props[0]) && props[0][0] === '...') {
    inc('__obj_clone')
    if (!ctx.scope.globals.has('__schema_tbl')) declGlobal('__schema_tbl', 'i32')
    return typed(['call', '$__obj_clone', asF64(emit(props[0][1]))], 'f64')
  }
  if (!allKnown) return emitDynamicSpread(props)

  const schemaId = ctx.schema.register(allNames)
  const schema = ctx.schema.list[schemaId]
  const t = tempI32('obj')
  const ptr = temp('objp')
  const src = tempI32('osp')

  const body = [['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(schema.length)]]]]

  // Process props in order — later props override earlier (JS semantics)
  for (const p of props) {
    if (Array.isArray(p) && p[0] === '...') {
      const sSchema = resolveSchema(p[1])
      body.push(['local.set', `$${src}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', asF64(emit(p[1]))]]])
      for (let si = 0; si < sSchema.length; si++) {
        const ti = schema.indexOf(sSchema[si])
        if (ti < 0) continue
        body.push(ctx.abi.object.ops.store(['local.get', `$${t}`], ti, ctx.abi.object.ops.load(['local.get', `$${src}`], si)))
      }
    } else if (Array.isArray(p) && p[0] === ':') {
      const ti = schema.indexOf(p[1])
      if (ti >= 0) body.push(ctx.abi.object.ops.store(['local.get', `$${t}`], ti, storedValue(p[2])))
    }
  }

  body.push(['local.set', `$${ptr}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`])])
  if (needsDynShadow(spreadTarget)) {
    inc('__dyn_set')
    for (let i = 0; i < schema.length; i++)
      body.push(['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', ['local.get', `$${ptr}`]], asI64(emit(['str', String(schema[i])])),
        ctx.abi.object.ops.loadBits(['local.get', `$${t}`], i)]])
  }
  body.push(['local.get', `$${ptr}`])
  return typed(['block', ['result', 'f64'], ...body], 'f64')
}

// Spread merge when any source schema is unknown: build a fresh HASH and copy
// every key of each source in order (later overrides earlier — JS semantics),
// threading explicit `k: v` props at their source position. Mirrors
// emitDynamicAssign but seeds an empty HASH instead of an existing target.
function emitDynamicSpread(props) {
  ctx.module.include('collection')
  inc('__hash_new', '__hash_set', '__dyn_get_any', '__ptr_offset', '__len')
  const t = temp('dst'), s = temp('dss'), sBase = tempI32('dssb')
  const keys = temp('dsk'), keysBase = tempI32('dskb'), len = tempI32('dsn')
  const i = tempI32('dsi'), key = temp('dskey')
  const id = ctx.func.uniq++
  // `__hash_set` may rehash and return a new pointer, so thread it back into $t.
  const setKey = (keyBits, valBits) =>
    ['local.set', `$${t}`, ['f64.reinterpret_i64',
      ['call', '$__hash_set', ['i64.reinterpret_f64', ['local.get', `$${t}`]], keyBits, valBits]]]
  const body = [['local.set', `$${t}`, ['call', '$__hash_new']]]

  for (let pi = 0; pi < props.length; pi++) {
    const p = props[pi]
    if (Array.isArray(p) && p[0] === ':') {
      body.push(setKey(asI64(emit(['str', String(p[1])])), asI64(emit(p[2]))))
      continue
    }
    const sSchema = spreadSourceSchema(p[1])
    body.push(['local.set', `$${s}`, asF64(emit(p[1]))])
    if (sSchema) {
      body.push(['local.set', `$${sBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]])
      for (let si = 0; si < sSchema.length; si++)
        body.push(setKey(asI64(emit(['str', String(sSchema[si])])), ctx.abi.object.ops.loadBits(['local.get', `$${sBase}`], si)))
      continue
    }
    body.push(
      ['local.set', `$${keys}`, runtimeKeysFromTemp(s, 'dsk')],
      ['local.set', `$${keysBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${keys}`]]]],
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${keys}`]]]],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$dsbrk${id}_${pi}`, ['loop', `$dsloop${id}_${pi}`,
        ['br_if', `$dsbrk${id}_${pi}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
        ['local.set', `$${key}`, ['f64.load',
          ['i32.add', ['local.get', `$${keysBase}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]],
        setKey(['i64.reinterpret_f64', ['local.get', `$${key}`]],
          ['call', '$__dyn_get_any', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['i64.reinterpret_f64', ['local.get', `$${key}`]]]),
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$dsloop${id}_${pi}`]]])
  }
  body.push(['local.get', `$${t}`])
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

function emitHashValues(obj) {
  const t = temp('hv')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, asF64(emit(obj))],
    hashValuesFromTemp(t)], 'f64')
}

function emitHashEntries(obj) {
  const t = temp('he')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, asF64(emit(obj))],
    hashEntriesFromTemp(t)], 'f64')
}

// Inline body of the HASH walk against an already-bound f64 local. Shared by
// the static-HASH path and the runtime-dispatch path so both produce the same
// IR shape from the same source — only difference is whether they enter from
// a static type guard or a runtime ptr-type check.
function hashKeysFromTemp(t) {
  inc('__ptr_offset', '__cap', '__len', '__coll_order')
  const off = tempI32('hko'), cap = tempI32('hkc'), n = tempI32('hkn')
  const i = tempI32('hki'), ord = tempI32('hkr'), slot = tempI32('hks')
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'hka' })
  const id = ctx.func.uniq++
  return ['block', ['result', 'f64'],
    ['local.set', `$${n}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    out.init,
    ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${cap}`, ['call', '$__cap', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${ord}`, ['call', '$__coll_order', ['local.get', `$${off}`], ['local.get', `$${cap}`], ['i32.const', 24]]],
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$brk${id}`, ['loop', `$loop${id}`,
      ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${n}`]]],
      ['local.set', `$${slot}`, ['i32.load', ['i32.add', ['local.get', `$${ord}`],
        ['i32.shl', ['local.get', `$${i}`], ['i32.const', 2]]]]],
      elemStore(out.local, i,
        ['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]]),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$loop${id}`]]],
    out.ptr]
}

function hashValuesFromTemp(t) {
  inc('__ptr_offset', '__cap', '__len', '__coll_order')
  const off = tempI32('hvo'), cap = tempI32('hvc'), n = tempI32('hvn')
  const i = tempI32('hvi'), ord = tempI32('hvr'), slot = tempI32('hvs')
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'hva' })
  const id = ctx.func.uniq++
  return ['block', ['result', 'f64'],
    ['local.set', `$${n}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    out.init,
    ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${cap}`, ['call', '$__cap', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${ord}`, ['call', '$__coll_order', ['local.get', `$${off}`], ['local.get', `$${cap}`], ['i32.const', 24]]],
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$vbrk${id}`, ['loop', `$vloop${id}`,
      ['br_if', `$vbrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${n}`]]],
      ['local.set', `$${slot}`, ['i32.load', ['i32.add', ['local.get', `$${ord}`],
        ['i32.shl', ['local.get', `$${i}`], ['i32.const', 2]]]]],
      elemStore(out.local, i,
        ['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 16]]]),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$vloop${id}`]]],
    out.ptr]
}

function hashEntriesFromTemp(t) {
  inc('__ptr_offset', '__cap', '__len', '__alloc_hdr', '__coll_order')
  const off = tempI32('heo'), cap = tempI32('hec'), n = tempI32('hen')
  const i = tempI32('hei'), ord = tempI32('her'), slot = tempI32('hes'), pair = tempI32('hep')
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'hea' })
  const id = ctx.func.uniq++
  return ['block', ['result', 'f64'],
    ['local.set', `$${n}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    out.init,
    ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${cap}`, ['call', '$__cap', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${ord}`, ['call', '$__coll_order', ['local.get', `$${off}`], ['local.get', `$${cap}`], ['i32.const', 24]]],
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$ebrk${id}`, ['loop', `$eloop${id}`,
      ['br_if', `$ebrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${n}`]]],
      ['local.set', `$${slot}`, ['i32.load', ['i32.add', ['local.get', `$${ord}`],
        ['i32.shl', ['local.get', `$${i}`], ['i32.const', 2]]]]],
      ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2]]],
      ['f64.store', ['local.get', `$${pair}`],
        ['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]]],
      ['f64.store', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]],
        ['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 16]]]],
      elemStore(out.local, i, mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${pair}`])),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$eloop${id}`]]],
    out.ptr]
}

// Type-unknown receiver: bind the value, branch on ptr-type. HASH walks the
// probe table; OBJECT loads the schema's key array (registered statically at
// compile time or lazily at runtime by JSON.parse via __jp_schema_get); other
// types (ARRAY, nullish, primitives) return an empty array. The empty-array
// fallback is allocated in all arms for type uniformity at the if boundary.
function emitRuntimeKeys(obj) {
  const t = temp('rk')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, asF64(emit(obj))],
    runtimeKeysFromTemp(t, 'rk')], 'f64')
}

function runtimeKeysFromTemp(t, tag) {
  inc('__ptr_type')
  // Ensure the schema table global exists even in programs that never use
  // JSON.parse or compile-time schemas — the OBJECT arm reads it at runtime
  // and the watr resolver requires the symbol to be declared.
  if (!ctx.scope.globals.has('__schema_tbl'))
    declGlobal('__schema_tbl', 'i32')
  const tt = tempI32(`${tag}t`)
  const empty = allocPtr({ type: PTR.ARRAY, len: 0, tag: `${tag}e` })
  return ['block', ['result', 'f64'],
    ['local.set', `$${tt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['if', ['result', 'f64'],
      ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.HASH]],
      ['then', hashKeysFromTemp(t)],
      ['else', ['if', ['result', 'f64'],
        ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.OBJECT]],
        ['then', objectKeysFromTemp(t)],
        ['else', ['block', ['result', 'f64'], empty.init, empty.ptr]]]]]]
}

function emitRuntimeValues(obj) {
  inc('__ptr_type')
  if (!ctx.scope.globals.has('__schema_tbl'))
    declGlobal('__schema_tbl', 'i32')
  const t = temp('rv'), tt = tempI32('rvt')
  const empty = allocPtr({ type: PTR.ARRAY, len: 0, tag: 'rve' })
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, asF64(emit(obj))],
    ['local.set', `$${tt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['if', ['result', 'f64'],
      ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.HASH]],
      ['then', hashValuesFromTemp(t)],
      ['else', ['if', ['result', 'f64'],
        ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.OBJECT]],
        ['then', objectValuesFromTemp(t)],
        ['else', ['block', ['result', 'f64'], empty.init, empty.ptr]]]]]], 'f64')
}

function emitRuntimeEntries(obj) {
  inc('__ptr_type')
  if (!ctx.scope.globals.has('__schema_tbl'))
    declGlobal('__schema_tbl', 'i32')
  const t = temp('re'), tt = tempI32('ret')
  const empty = allocPtr({ type: PTR.ARRAY, len: 0, tag: 'ree' })
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, asF64(emit(obj))],
    ['local.set', `$${tt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['if', ['result', 'f64'],
      ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.HASH]],
      ['then', hashEntriesFromTemp(t)],
      ['else', ['if', ['result', 'f64'],
        ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.OBJECT]],
        ['then', objectEntriesFromTemp(t)],
        ['else', ['block', ['result', 'f64'], empty.init, empty.ptr]]]]]], 'f64')
}

// Shared scaffold for Object.{keys,values,entries} on a runtime OBJECT.
//
// A plain JS object reports ALL its own keys at enumeration time. jz objects
// split that surface in two: a static SCHEMA (jz Array of key STRINGs registered
// in __schema_tbl[sid] + field values inline at base+i*8) and a per-instance
// HASH of dyn props at base-16 added by computed writes `o[k]=v`. Enumerating
// only the schema would silently drop dyn keys — the gap that blocked
// metacircularity (kernel dicts grow via `o[k]=v` then enumerate via Object.keys).
//
// All three variants share the entire scaffold — schema lookup, dyn discovery,
// over-alloc output, two iteration loops, shadow-mirror dedup, length patch,
// ARRAY ptr boxing. They differ ONLY in per-slot stores:
//   - keys:    write i64 key
//   - values:  write f64 value
//   - entries: alloc 2-slot pair + write boxed ptr
//
// Callbacks receive the active locals as named fields so each variant can
// reference what it needs without knowing the scaffold's layout.
function emitEnumerateObject(t, emitStaticStore, emitDynStore) {
  inc('__alloc_hdr', '__ptr_offset', '__coll_order')
  const sid = tempI32('oes'), src = tempI32('oesrc'), sn = tempI32('oen')
  const base = tempI32('oebase'), props = tempI64('oepr'), poff = tempI32('oepo')
  const pcap = tempI32('oepc'), dn = tempI32('oedn'), total = tempI32('oetot')
  const out = tempI32('oeo'), i = tempI32('oei'), o = tempI32('oej')
  const slot = tempI32('oesl'), ord = tempI32('oeord')
  const j = tempI32('oej2'), skip = tempI32('oesk'), pair = tempI32('oep')
  const id = ctx.func.uniq++
  const env = { out, o, src, base, i, slot, pair }
  return ['block', ['result', 'f64'],
    // Static schema row: sid (AUX bits) → __schema_tbl[sid] → src offset; n@src-8.
    // __schema_tbl is omitted when every program schema is empty (dyn-only dicts);
    // guard the read so empty-table programs see sn=0 here and still enumerate
    // dyn-props below.
    ['local.set', `$${sid}`, ['i32.wrap_i64', ['i64.and',
      ['i64.shr_u', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['i64.const', LAYOUT.AUX_SHIFT]],
      ['i64.const', LAYOUT.AUX_MASK]]]],
    ['local.set', `$${sn}`, ['i32.const', 0]],
    ['local.set', `$${src}`, ['i32.const', 0]],
    ['if', ['i32.ne', ['global.get', '$__schema_tbl'], ['i32.const', 0]],
      ['then',
        ['local.set', `$${src}`, ['i32.wrap_i64', ['i64.and',
          ['i64.load', ['i32.add', ['global.get', '$__schema_tbl'], ['i32.shl', ['local.get', `$${sid}`], ['i32.const', 3]]]],
          ['i64.const', LAYOUT.OFFSET_MASK]]]],
        ['local.set', `$${sn}`, ['i32.load', ['i32.sub', ['local.get', `$${src}`], ['i32.const', 8]]]]]],
    // Dyn-props: heap OBJECTs (base >= __heap_start) carry a HASH propsPtr at
    // base-16 (0 when none). Static-segment objects have no header, so they
    // contribute no dyn keys (poff stays 0).
    ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${dn}`, ['i32.const', 0]],
    ['local.set', `$${poff}`, ['i32.const', 0]],
    ['if', ['i32.ge_u', ['local.get', `$${base}`], ['global.get', '$__heap_start']],
      ['then',
        ['local.set', `$${props}`, ['i64.load', ['i32.sub', ['local.get', `$${base}`], ['i32.const', 16]]]],
        ['if', ['i32.eq',
            ['i32.wrap_i64', ['i64.and', ['i64.shr_u', ['local.get', `$${props}`], ['i64.const', LAYOUT.TAG_SHIFT]], ['i64.const', LAYOUT.TAG_MASK]]],
            ['i32.const', PTR.HASH]],
          ['then',
            // Resolve forward chain — HASH may have forwarded on grow; the raw
            // propsPtr offset would point at the forward record, not live slots.
            ['local.set', `$${poff}`, ['call', '$__ptr_offset', ['local.get', `$${props}`]]],
            ['local.set', `$${pcap}`, ['i32.load', ['i32.sub', ['local.get', `$${poff}`], ['i32.const', 4]]]],
            ['local.set', `$${dn}`, ['i32.load', ['i32.sub', ['local.get', `$${poff}`], ['i32.const', 8]]]]]]]],
    // Over-allocate sn+dn; patch length to actual `o` post-dedup so removed
    // shadow-mirror slots never expose garbage tails.
    ['local.set', `$${total}`, ['i32.add', ['local.get', `$${sn}`], ['local.get', `$${dn}`]]],
    ['local.set', `$${out}`, ['call', '$__alloc_hdr', ['local.get', `$${total}`], ['local.get', `$${total}`]]],
    ['local.set', `$${o}`, ['i32.const', 0]],
    // Static schema slots — no skip, schema keys are unique by construction.
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$sbrk${id}`, ['loop', `$sloop${id}`,
      ['br_if', `$sbrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${sn}`]]],
      ...emitStaticStore(env),
      ['local.set', `$${o}`, ['i32.add', ['local.get', `$${o}`], ['i32.const', 1]]],
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$sloop${id}`]]],
    // Dyn-prop slots in insertion order (__coll_order sorts the dn live 24-byte
    // slots by packed seq; hash@+0, key@+8, value@+16). Skip entries whose key
    // is already in the schema — when an object literal has shadow=true (per
    // needsDynShadow), each schema key is mirrored into propsPtr at construction
    // so dyn-key reads hit the hash fast path; the mirror is not an enumeration
    // entity, so we must not emit it twice.
    ['if', ['i32.ne', ['local.get', `$${poff}`], ['i32.const', 0]],
      ['then',
        ['local.set', `$${ord}`, ['call', '$__coll_order', ['local.get', `$${poff}`], ['local.get', `$${pcap}`], ['i32.const', 24]]],
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$dbrk${id}`, ['loop', `$dloop${id}`,
          ['br_if', `$dbrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${dn}`]]],
          ['local.set', `$${slot}`, ['i32.load', ['i32.add', ['local.get', `$${ord}`],
            ['i32.shl', ['local.get', `$${i}`], ['i32.const', 2]]]]],
          ['local.set', `$${skip}`, ['i32.const', 0]],
          ['local.set', `$${j}`, ['i32.const', 0]],
          ['block', `$skbrk${id}`, ['loop', `$skloop${id}`,
            ['br_if', `$skbrk${id}`, ['i32.ge_s', ['local.get', `$${j}`], ['local.get', `$${sn}`]]],
            ['if', ['i64.eq',
                ['i64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]],
                ['i64.load', ['i32.add', ['local.get', `$${src}`], ['i32.shl', ['local.get', `$${j}`], ['i32.const', 3]]]]],
              ['then', ['local.set', `$${skip}`, ['i32.const', 1]], ['br', `$skbrk${id}`]]],
            ['local.set', `$${j}`, ['i32.add', ['local.get', `$${j}`], ['i32.const', 1]]],
            ['br', `$skloop${id}`]]],
          ['if', ['i32.eqz', ['local.get', `$${skip}`]],
            ['then',
              ...emitDynStore(env),
              ['local.set', `$${o}`, ['i32.add', ['local.get', `$${o}`], ['i32.const', 1]]]]],
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['br', `$dloop${id}`]]]]],
    ['i32.store', ['i32.sub', ['local.get', `$${out}`], ['i32.const', 8]], ['local.get', `$${o}`]],
    mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${out}`])]
}

// Object.keys for an OBJECT — copy schema key (i64@src+i*8) then dyn key (i64@slot+8).
const objectKeysFromTemp = (t) => emitEnumerateObject(t,
  ({ out, o, src, i }) => [
    ['i64.store',
      ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${o}`], ['i32.const', 3]]],
      ['i64.load', ['i32.add', ['local.get', `$${src}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]]],
  ({ out, o, slot }) => [
    ['i64.store',
      ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${o}`], ['i32.const', 3]]],
      ['i64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]]]])

// Object.values for an OBJECT — copy schema value (f64@base+i*8) then dyn value (f64@slot+16).
const objectValuesFromTemp = (t) => emitEnumerateObject(t,
  ({ out, o, base, i }) => [
    ['f64.store',
      ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${o}`], ['i32.const', 3]]],
      ['f64.load', ['i32.add', ['local.get', `$${base}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]]],
  ({ out, o, slot }) => [
    ['f64.store',
      ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${o}`], ['i32.const', 3]]],
      ['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 16]]]]])

// Object.entries for an OBJECT — alloc 2-slot ARRAY pair {key, value} for each
// schema slot (key from src+i*8, value from base+i*8) then each dyn slot
// (key@slot+8, value@slot+16) and box the pair into out[o*8].
const objectEntriesFromTemp = (t) => emitEnumerateObject(t,
  ({ out, o, src, base, i, pair }) => [
    ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2]]],
    ['i64.store', ['local.get', `$${pair}`],
      ['i64.load', ['i32.add', ['local.get', `$${src}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]],
    ['f64.store', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]],
      ['f64.load', ['i32.add', ['local.get', `$${base}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]],
    ['f64.store',
      ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${o}`], ['i32.const', 3]]],
      mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${pair}`])]],
  ({ out, o, slot, pair }) => [
    ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2]]],
    ['i64.store', ['local.get', `$${pair}`],
      ['i64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]]],
    ['f64.store', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]],
      ['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 16]]]],
    ['f64.store',
      ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${o}`], ['i32.const', 3]]],
      mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${pair}`])]])
