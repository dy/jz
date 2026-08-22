/**
 * Object module — literals and property access.
 *
 * Type=6 (OBJECT): schemaId in aux, properties as sequential f64 in memory.
 * Schema = compile-time known property names. Access by index via ptr module.
 *
 * @module object
 */

import { dataAlign, dataPush, dataLen, pushStaticSlots } from '../src/static-data.js'
import { typed, asF64, asI64, NULL_NAN, UNDEF_NAN, temp, tempI32, tempI64, block64, ptrTypeEq, dispatchByPtrType, allocPtr, needsDynShadow, mkPtrIR, extractF64Bits, slotAddr, elemLoad, elemStore, freshId, isUndef, undefExpr } from '../src/ir.js'
import { emit, storedValue, storedValueNarrow } from '../src/bridge.js'
import { staticArrayPtr } from './array.js'
import { GROW_QUAD_CAP } from './collection.js'
import { valTypeOf, shapeOf } from '../src/kind.js'
import { VAL, lookupValType, repOf, updateRep } from '../src/reps.js'
import { ctx, err, inc, PTR, LAYOUT, declGlobal, DBG_INVARIANTS } from '../src/ctx.js'
import { isReassigned } from '../src/ast.js'
import { ERR, ERR_CLASS_NAMES, ERR_SCHEMA_PROPS } from '../err-codes.js'

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

// Array-IR twin of collection.js's heapResetWat (WAT-string form) — both MUST
// gate identically. True when `off` is ephemeral (>= the post-init high-water
// mark): only then does a receiver's off-16 header sidecar hold the live
// dyn-prop truth. See collection.js's heapResetWat for the full durable-
// receiver policy rationale.
const heapResetIR = () => ctx.scope.globals.has('__heap_reset') ? ['global.get', '$__heap_reset'] : ['i32.const', 0]

// Exact safe capacity for a KNOWN-SIZE dyn-props shadow mirror (the per-object
// props hash a `needsDynShadow` literal mirrors every schema field into at
// construction — see the `shadow` branch below). module/collection.js's
// __hash_new_small floors/guesses a fixed cap (module-wide hashSmallInitCap,
// 2 or 8) for the ad-hoc "unknown eventual size, probably 0-2 props" receiver
// — the RIGHT default for that case (module/collection.js's own doc), but
// wrong in both directions for a schema mirror, whose final size
// (schema.length) is a compile-time FACT, not a guess: too big for a 1-2-field
// schema (wasted slots, paid on every construction) and too small for a
// 7+-field schema (1-2 wasted grow generations, each abandoned forever in the
// bump arena, never reclaimed). This simulates genUpsertGrow's real grow
// mechanics step by step (rather than a derived closed form) so it can never
// drift out of sync with what it's sizing against: the 75%-load trigger
// (`size*4 >= cap*3`, unchanged by the map-growth tiering) AND nextCapIR's
// post-map-growth tiered RATE (2× below GROW_QUAD_CAP, 4× at/above it — both
// module/collection.js). schema.length is a literal's own field count, never
// remotely near GROW_QUAD_CAP (8192), so the 4× tier is dead code for every
// real caller today — simulated anyway so this can't silently go stale the
// day some generated/bundled literal schema ever does cross it.
const hashCapFor = (n) => {
  let cap = 2, size = 0
  for (let i = 0; i < n; i++) {
    if (size * 4 >= cap * 3) cap *= cap >= GROW_QUAD_CAP ? 4 : 2
    size++
  }
  return cap
}

export default (ctx) => {
  inc('__mkptr', '__alloc', '__alloc_hdr', '__ptr_offset', '__len', '__ptr_type')
  // Pure schema resolver for expressions (name → bound schema, literal → keys,
  // spread literal → merged) — exposed as a ctx hook so plan-time passes
  // (analyze's Object.assign predictor, slice-4 P3) mirror emit's resolution
  // exactly instead of duplicating it.
  ctx.schema.resolveExpr = resolveSchema

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
      // Dictionary mode: a `{}` whose binding takes ONLY computed-key access (no
      // static prop ever — merged schema empty) is a string-keyed dictionary, not
      // a fixed-shape record. Represent it as a real HASH so every get/set is one
      // strict probe instead of the OBJECT dyn-sidecar detour, and the RMW fusion
      // (`o[k] = f(o[k])`, emit-assign.js) can hold a slot address. The same
      // heuristic V8 uses to send such objects to dictionary mode. Sound: all dyn
      // paths dispatch on the runtime tag, and mem.Hash marshals it as a plain
      // object at the boundary.
      if (target && !merged?.length && ctx.types.dynWriteVars?.has(target)) {
        ctx.module.include('collection')
        const domain = ctx.func.leanHashDomains?.get(target)
        const old = asI64(emit(target))
        inc('__hash_reuse_eph')
        // The dict decision is made at PLAN time (analyze's dynWriteVars +
        // empty-merged gate stamps VAL.HASH on both decl and `=` paths) —
        // this branch's own condition is the same predicate, so the rep is
        // already HASH here. Assert-only tripwire (slice-4 P4 flip).
        if (DBG_INVARIANTS && repOf(target)?.val !== VAL.HASH)
          throw new Error(`P4 dict-mode drift: ${target} reaches the HASH branch with plan val=${repOf(target)?.val}`)
        // Preallocation sizing must be a COMPILE-TIME fact only (repOf
        // arrayLen — the same fact emit-assign.js's RMW capHint uses): the
        // domain hint name may be a LOCAL whose def executes after this
        // alloc (a for-of/for-in iterator temp is declared in the loop's
        // own init, always textually after `const T = {}`), so emitting a
        // runtime `domain.length` read here dereferenced an uninitialized
        // local (0.0) and trapped OOB (.work/todo.md §deletion-sweep).
        // The hint is speed-only by contract (analyze.js dictDomainOf: an
        // over/underestimate cannot affect semantics) — unproven length
        // degrades to the default cap, never a runtime read.
        const domainLen = domain ? repOf(domain)?.arrayLen : null
        const want = ['i32.const', domainLen > 0 ? domainLen * 4 : 8]
        return typed(['call', '$__hash_reuse_eph', old, want], 'f64')
      }
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
      // Non-superset merged schema: the literal is authoritative for its own
      // shape — schemaId stays litId for THIS allocation. The var's binding is
      // plan state and already litId (plan-time literal binding; the stale
      // cross-function collision this branch once repaired died with Stage-1
      // binding totality). Assert-only tripwire (slice-4 P3 flip).
      else if (names.length && DBG_INVARIANTS && ctx.schema.vars.get(target) !== litId)
        throw new Error(`P3 literal-rebind drift: ${target} bound to sid=${ctx.schema.vars.get(target)}, literal is sid=${litId}`)
    }
    const schema = ctx.schema.list[schemaId]
    const t = tempI32('obj')
    const ptr = temp('objp')

    // R: Static data segment for objects of pure-literal property values (own-memory only).
    // Even with shadow needed, we can skip alloc + N stores; just feed literal values to __dyn_set.
    // schemaId (dyn-reach slice): this construction's OWN just-resolved sid —
    // the SAME id the write-hazard scan resolves for this exact literal shape,
    // so needsDynShadow's per-schema check agrees with dynPointsTo's granularity.
    const shadow = needsDynShadow(target, schemaId)
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
    // `!shadow`: a computed-key write on the target (`o[k]=v`) mutates the object —
    // a shared static instance would leak call N's writes into call N+1. The old
    // shadow-mirror masked this by re-storing literal values through __dyn_set's
    // schema-arm on every evaluation (an accidental reset that still leaked
    // runtime-ADDED keys); with the mirror gone (tier 2), mutable literals must
    // allocate fresh per evaluation — the runtime path below.
    if (neverWritten && !shadow && values.length >= 2 && values.length === schema.length && !ctx.memory.shared) {
      // storedValueNarrow, NOT storedValue: this branch only runs when
      // `!shadow` (just checked above), so there is NEVER a __dyn_get mirror
      // for this literal's fields — no registry-aware dynamic reader can ever
      // observe them. See carrierF64Narrow's own doc comment (ir.js).
      const emitted = values.map(storedValueNarrow)
      // asF64 folds i32.const → f64.const so int-literal values also qualify.
      const slots = emitted.map(v => extractF64Bits(v))
      if (slots.every(b => b !== null)) {
        // Reorder into schema-slot order before laying out the static segment.
        const orderedBits = emitted.map(() => null)
        for (let i = 0; i < values.length; i++) orderedBits[slotOf(i)] = slots[i]
        // Full 16-byte __alloc_hdr-shaped header ([props:8]=0, len=0, cap=slots):
        // dyn machinery reads the off-16 props word — a headerless static object
        // aliased whatever data preceded it (the durable-dangler garbage class),
        // and a runtime dyn-set/delete on the shared instance now has a real,
        // writable slot to install a sidecar into. No runtime shadow mirror
        // either way (tier 2): dyn READS of schema props resolve through the
        // schema-arm (__schema_tbl — itself static data now), so the old
        // per-prop __dyn_set mirror was pure init cost — the block it emitted
        // also made the literal non-const, forcing every ENCLOSING literal
        // (`const A = [{…}, {…}]`) to build at runtime.
        dataAlign(8)
        const hdrOff = dataLen()
        const hdr = new Uint8Array(16); const hdv = new DataView(hdr.buffer)
        hdv.setInt32(12, ctx.abi.object.ops.allocSlots ? ctx.abi.object.ops.allocSlots(schema.length) : schema.length, true)
        let hdrChunk = ''
        for (let i = 0; i < 16; i++) hdrChunk += String.fromCharCode(hdr[i])
        dataPush(hdrChunk)
        pushStaticSlots(orderedBits)
        return mkPtrIR(PTR.OBJECT, schemaId, hdrOff + 16)
      }
    }

    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(schema.length)]]],
    ]
    // storedValueNarrow when !shadow — same reasoning as the static-segment
    // branch just above (carrierF64Narrow's own doc comment, ir.js): no
    // __dyn_set mirror below means no registry-aware reader ever observes
    // this slot. Using the wide box here instead would corrupt the next
    // fixed-offset f64.load reading raw, e.g. `let o = {n: 4611686018427387903n};
    // o.n += 1n` on an object that doesn't qualify for the static path
    // (`values.length < 2`) and so takes this runtime-alloc path.
    //
    // CARRIER PROGRAM §15/§16: the per-FIELD choice derives from
    // ctx.schema.slotBigintBoxedBySid (module/schema.js) — the per-SCHEMA
    // census fact — instead of this literal's own raw `shadow`. A schemaId
    // can be shared by a shadowed and a non-shadowed constructor; write and
    // read (emitSchemaSlotRead, module/core.js) can only pair soundly at
    // schema granularity, so a non-shadowed sibling of a schema that has ANY
    // shadowed constructor boxes too — a rare, harmless cost, never a
    // per-instance runtime tag guess. CARRIER_BOX-gated inside the helper
    // (answers false when off); storedValue and storedValueNarrow are
    // byte-identical to each other whenever the flag is off (both degrade to
    // the same asF64/boolBoxIR fallback — see carrierF64/carrierF64Narrow,
    // ir.js), so this substitution is a true no-op for the default build
    // regardless of which branch the fact picks.
    const fieldStoredValue = (i) =>
      (ctx.schema.slotBigintBoxedBySid?.(schemaId, names[i]) ? storedValue : storedValueNarrow)(values[i])
    for (let i = 0; i < values.length; i++)
      body.push(ctx.abi.object.ops.store(['local.get', `$${t}`], slotOf(i), fieldStoredValue(i)))
    body.push(['local.set', `$${ptr}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`])])
    if (shadow) {
      inc('__dyn_set', '__hash_new_cap')
      // Presize the props hash to hold every schema field with zero grows
      // (hashCapFor's doc above) instead of leaving it to __dyn_set's own
      // lazy __hash_new_small create-on-first-write. off-16 is the fresh
      // __alloc_hdr header's props slot (zeroed above) — writing the sized
      // hash there directly means the FIRST __dyn_set call below already
      // finds a correctly-sized table and never re-creates or re-grows it.
      body.push(['i64.store', ['i32.sub', ['local.get', `$${t}`], ['i32.const', 16]],
        ['i64.reinterpret_f64', ['call', '$__hash_new_cap', ['i32.const', hashCapFor(schema.length)]]]])
      for (let i = 0; i < schema.length; i++)
        body.push(['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', ['local.get', `$${ptr}`]], asI64(emit(['str', String(schema[i])])),
          ctx.abi.object.ops.loadBits(['local.get', `$${t}`], i)]])
    }
    body.push(['local.get', `$${ptr}`])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // === Object static methods ===

  // Object.freeze: identity passthrough — jz objects have no per-property
  // metadata, so write-protection is not enforced (documented divergence).
  // Call forms are folded away in prepare (which records the binding in
  // ctx.runtime.frozenVars so isFrozen answers true for it); this emitter
  // survives only for freeze-as-a-value (`arr.map(Object.freeze)`).
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
  const objQuery = (pick, frozenAware = false) => (obj) => {
    let v = pick(extKind(obj))
    if (frozenAware) {
      // A binding freeze() marked in prepare (composition unwraps to the same
      // name there). Trustworthy only while never reassigned — a rebind points
      // at a fresh, unfrozen object.
      if (typeof obj === 'string' && ctx.runtime.frozenVars?.has(obj) &&
        !isReassigned(ctx.func.body, obj)) v = 1
    }
    if (obj == null) return typed(['f64.const', v], 'f64')
    return typed(['block', ['result', 'f64'], ['drop', asF64(emit(obj))], ['f64.const', v]], 'f64')
  }
  ctx.core.emit['Object.isExtensible'] = objQuery((k) => k.ext)
  ctx.core.emit['Object.isSealed'] = objQuery((k) => k.sealed)
  ctx.core.emit['Object.isFrozen'] = objQuery((k) => k.frozen, true)

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
    return typed(['block', ['result', 'f64'], ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['f64.const', ERR.OBJECT_NULLISH]]], ['throw', '$__jz_err', ['f64.const', ERR.OBJECT_NULLISH]]], 'f64')
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
    const id = freshId(ctx)
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

  // Shared by Object.keys and __keys_ro. `ro` marks the for-in path: its result
  // is read-only by construction (the lowering only reads ks[i]/ks.length), so
  // the HASH arms may serve the shared enum-cache array (core.js __hash_keys_ro)
  // instead of a fresh copy. Object.keys stays fresh — callers may mutate it.
  const emitKeysGeneric = (obj, ro) => {
    // Shared memory: cache globals are per-instance but the table is cross-thread,
    // and shared's `__clear` (plain rewind, core.js) takes no reset injections —
    // both break the cache's invalidation story. Serve the uncached path there.
    if (ctx.memory.shared) ro = false
    const nullish = requireCoercible(obj)
    if (nullish) return nullish
    if (isHashTyped(obj)) return ro ? emitHashKeysRO(obj) : emitHashKeys(obj)
    if (arrayValType(obj)) return idxKeys(obj, '__len')
    if (stringValType(obj)) return idxKeys(obj, '__str_len')
    const schema = resolveSchema(obj)
    // Conditional-spread slots (schemaCondNames): the plain value-blind fold
    // below (every schema name unconditionally present) is wrong for a
    // schema whose slot(s) may hold the UNDEF absent-sentinel — route those
    // through the compile-time-specialized value-checked enumerator instead.
    // Gate: dynWriteVars, NOT mayHaveDynProps — mayHaveDynProps's dynKeyVars
    // census flags a computed READ (`o[k]`) as readily as a computed WRITE
    // (`o[k]=v`; see __keys_ro's own identical narrowing, just below), but
    // only a write can add a prop this fold would miss. Found live, not
    // assumed: `for (k in o) sum += o[k]` — for-in's OWN `o[k]` read inside
    // the SAME loop that enumerates `o` — tripped mayHaveDynProps on `o`,
    // silently falling through to the value-blind emitRuntimeKeys path
    // below and wrongly counting an absent conditional slot.
    const condNames = schemaCondNames(obj)
    if (schema && !hasOutOfSchemaWrites(obj, schema) &&
      (condNames?.size ? !ctx.types.dynWriteVars?.has(obj) : !mayHaveDynProps(obj))) {
      if (condNames?.size) return emitCondAwareKeys(obj, schema, condNames)
      return emitStringArray(schema)
    }
    // Unknown receiver, or schema with possible dyn props: dispatch on ptr-type
    // at runtime (HASH probe table / OBJECT schema+dyn merge / else []).
    return emitRuntimeKeys(obj, ro)
  }
  ctx.core.emit['Object.keys'] = (obj) => emitKeysGeneric(obj, false)
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
    // schema: a bare var with NO computed-key writes (`o[k]=v`) and no literal
    // writes outside the schema — either kind adds enumerable keys the pool
    // would drop (computed writes via dynWriteVars; out-of-schema literal
    // writes land in the dyn sidecar — see hasOutOfSchemaWrites).
    // `mayHaveDynProps` is too coarse here — it also flags computed-READ receivers,
    // and for-in's own `o[k]` read would otherwise veto its own pooling.
    // Conditional-spread slots (schemaCondNames): pooling a SINGLE static key
    // array requires the key SET to be a compile-time constant shared by
    // EVERY instance of the schema — false here by construction (a DIFFERENT
    // instance's group can be absent). Excluded up front so a cond-absent
    // receiver falls to emitKeysGeneric(obj, true), which recomputes
    // per-instance via emitCondAwareKeys — freshly allocated each for-in,
    // correct over pooled.
    if (typeof obj === 'string' && !ctx.types.dynWriteVars?.has(obj) && !isHashTyped(obj) && !arrayValType(obj) && !stringValType(obj)) {
      const schema = resolveSchema(obj)
      if (schema && !hasOutOfSchemaWrites(obj, schema) && !schemaCondNames(obj)?.size) {
        const slots = schema.map(name => extractF64Bits(asF64(emit(['str', name]))))
        if (slots.every(b => b !== null)) return staticArrayPtr(slots)
      }
    }
    return emitKeysGeneric(obj, true)
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
      // Conditional-spread slot (ctx.schema.condAbsentProps — module/object.js
      // conditionalSpreadGroup): "in schema" no longer means "present" for
      // this exact prop, so the value-blind fold below must not fire — fall
      // through to the runtime `in` operator, whose own generic OBJECT arm
      // (module/collection.js) is already value-based (`__dyn_get` +
      // nullish), giving the correct answer with no help needed here.
      if (typeof obj === 'string' && ctx.schema.slotOf?.(obj, litKey) >= 0 &&
        !ctx.schema.condAbsentAt?.(ctx.schema.idOf(obj), litKey))
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
      const id = freshId(ctx)
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
    // Conditional-spread slots — see Object.keys' identical guard (dynWriteVars,
    // not mayHaveDynProps — the read-vs-write narrowing) above.
    const condNames = schemaCondNames(obj)
    if (!schema || hasOutOfSchemaWrites(obj, schema) ||
      (condNames?.size ? ctx.types.dynWriteVars?.has(obj) : mayHaveDynProps(obj))) return emitRuntimeValues(obj)
    if (condNames?.size) return emitCondAwareValues(obj, schema, condNames)
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
      const id = freshId(ctx)
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
      const id = freshId(ctx)
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
    // Conditional-spread slots — see Object.keys' identical guard (dynWriteVars,
    // not mayHaveDynProps — the read-vs-write narrowing) above.
    const condNames = schemaCondNames(obj)
    if (!schema || hasOutOfSchemaWrites(obj, schema) ||
      (condNames?.size ? ctx.types.dynWriteVars?.has(obj) : mayHaveDynProps(obj))) return emitRuntimeEntries(obj)
    if (condNames?.size) return emitCondAwareEntries(obj, schema, condNames)
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
    // A fresh, anonymous object-LITERAL target (`Object.assign({}, {a:1})`,
    // `Object.assign({b:2}, {a:1}, {c:3})`) is not a pre-existing allocation —
    // nothing else can hold a reference to it, so unlike every other target
    // shape below (a bound name or any other pre-existing value, whose
    // physical slot layout was already fixed at ITS OWN construction site and
    // can only be OVERWRITTEN — see `tSchema.indexOf(...) < 0 ⇒ continue` a
    // few lines down, and src/prepare/index.js's inferAssignSchema, which
    // grows a BOUND name's registered schema but explicitly bails
    // `typeof target !== 'string'`), Object.assign here is free to choose the
    // result's layout, because IT is the one constructing it. ECMA-262
    // Object.assign copies each source's own enumerable keys onto target
    // left-to-right via an ordinary [[Set]] (later source wins on a
    // collision); CopyDataProperties (object spread) merges the identical run
    // of props/sources the identical way — jz has no getters/setters/Proxies
    // to tell the two apart. So for a literal target ONLY,
    // `Object.assign({...targetProps}, s1, s2)` reduces structurally to
    // `{...targetProps, ...s1, ...s2}` — the exact merge emitObjectSpread
    // already builds (own props first, each source as a spread group, later
    // wins, first-occurrence slot order) — reusing its schema-growth instead
    // of re-deriving a second copy of it. Previously this shape fell through
    // to `resolveSchema(target)` below, which reads a literal's OWN props as
    // its COMPLETE fixed schema (correct for a real pre-existing object,
    // wrong here) — so any source key absent from the target literal silently
    // had no slot to land in (`Object.assign({}, {a:1})` produced a 0-slot
    // object; JS gives `{a:1}`).
    if (Array.isArray(target) && target[0] === '{}')
      return emitObjectSpread([...literalProps(target), ...sources.map(s => ['...', s])])
    // Conditional-spread slots (schemaCondNames): every branch below copies
    // RAW slot bits, value-blind — correct only when every slot a source
    // schema lists is unconditionally present. Treat a cond-absent
    // target/source's schema as UNRESOLVABLE here (exactly resolveSchema's
    // pre-this-feature answer for the same binding, back when its
    // construction still took the dynamic-HASH path) — every branch already
    // has a documented dynamic fallback (or, for the boxed-non-OBJECT-target
    // branch, an existing "source needs known schema" compile error) for
    // that case; none of them need to learn a new one.
    const knownSchema = (x) => { const s = sourceSchema(x); return s && !schemaCondNames(x)?.size ? s : null }
    if (typeof target === 'string') {
      const vt = repOf(target)?.val
      if (vt && vt !== VAL.OBJECT) {
        const allProps = []
        for (const src of sources) {
          const s = knownSchema(src)
          if (!s) err('Object.assign: source needs known schema')
          for (const p of s) if (!allProps.includes(p)) allProps.push(p)
        }
        const boxedSchema = ['__inner__', ...allProps]
        // register() dedupes by shape, so this returns the id the plan-time
        // predictor (analyze's Object.assign post-walk pass) already bound to
        // the target — the binding + externSlotSids belt are plan state now.
        // Assert-only tripwire (slice-4 P3 flip).
        const schemaId = ctx.schema.register(boxedSchema)
        if (DBG_INVARIANTS && ctx.schema.idOf(target) !== schemaId)
          throw new Error(`P3 Object.assign drift: ${target} plan-bound sid=${ctx.schema.idOf(target)}, emit computes sid=${schemaId}`)
        const t = tempI32('bx'), s = temp('bs')
        const body = [
          ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(boxedSchema.length)]]],
          ctx.abi.object.ops.store(['local.get', `$${t}`], 0, asF64(emit(target))),
        ]
        const sBase = tempI32('sb')
        for (const source of sources) {
          const sSchema = sourceSchema(source)
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
    const sourceSchemas = sources.map(knownSchema)
    if (!tSchema) return emitObjectAssignDynamic(target, sources)
    if (sourceSchemas.some(s => !s)) return emitDynamicAssign(target, sources, sourceSchemas)
    // Extern-write belt: cross-schema slot copies into the TARGET's sid below
    // (plan's hazard scan marks the same target when it resolves it).
    const tSid = typeof target === 'string'
      ? (repOf(target)?.schemaId ?? ctx.schema.vars.get(target)) : null
    if (tSid != null) ctx.schema.externSlotSids?.add(tSid)
    const t = temp('at'), s = temp('as')
    const tBase = tempI32('tb'), sBase2 = tempI32('sb')
    // When the target carries a dynamic-props shadow (needsDynShadow), reads of an
    // unknown-schema alias (`let r = Object.assign(t, …); r.a`) dispatch through
    // __dyn_get_any → the hash, not the schema slot. A slot-only write would leave
    // the hash stale, so mirror each store into __dyn_set, exactly as the object
    // literal emit does (above). False unless a collection/dyn-key module is live,
    // so the common fixed-schema assign keeps its slot-only fast path.
    // tSid (dyn-reach slice): already resolved just above for the extern-belt
    // add — the target's own sid, same granularity the write-hazard scan uses.
    const shadow = needsDynShadow(target, tSid)
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
    const id = freshId(ctx)
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
function emitDynamicAssign(target, sources, sourceSchemas = sources.map(sourceSchema)) {
  ctx.module.include('collection')
  inc('__hash_set', '__dyn_get_any', '__ptr_offset', '__len')
  const t = temp('adt'), s = temp('ads'), sBase = tempI32('adsb')
  const keys = temp('adk'), keysBase = tempI32('adkb'), len = tempI32('adn')
  const i = tempI32('adi'), key = temp('adkey')
  const id = freshId(ctx)
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
  const id = freshId(ctx)
  const setKey = (keyBits, valBits) =>
    ['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', ['local.get', `$${t}`]], keyBits, valBits]]
  const body = [['local.set', `$${t}`, asF64(emit(target))]]

  for (let si = 0; si < sources.length; si++) {
    const source = sources[si]
    const sSchema = sourceSchema(source)
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

// A literal-key write of a key OUTSIDE the receiver's schema lands in the
// dyn-props sidecar (locals get no propMap/autoBox merge) — the static schema
// fold would silently drop it from enumeration, so such receivers must take
// the runtime merge path. Bare-var receivers only, mirroring dynWriteVars'
// per-name precision (expression receivers are runtime-dispatched anyway).
const hasOutOfSchemaWrites = (obj, schema) => {
  if (typeof obj !== 'string') return false
  const w = ctx.types.literalWriteKeys?.get(obj)
  if (!w) return false
  for (const k of w) if (!schema.includes(k)) return true
  return false
}

// `sourceSchema` is the spread/Object.assign SOURCE-position schema resolver.
// Error must resolve to the SAME schema — physical `['message','name']`,
// enumerable — on every enumeration surface: `Object.keys`/`JSON.stringify`
// and `spread`/`Object.assign` must agree on what enumerates, or the same
// object answers "does this property enumerate" differently depending only
// on which builtin asked. DECISION (documented divergence, see .work/todo.md
// §deletion-sweep): Error is an ordinary object on every enumeration surface
// — keys/JSON/spread/assign/for-in all see the physical `['message','name']`
// layout, consistently. This diverges from real JS (whose Error properties
// are non-enumerable on all four surfaces) but keeps jz's OWN four surfaces
// mutually consistent, at zero machinery cost: the alternative (full JS
// fidelity) needs a per-property enumerability flag threaded through every
// enumeration site — the exact per-property "enumerated" flag the schema-id
// design (this file, `errorSid`) deliberately avoids carrying. `sourceSchema`
// is now a plain alias for `resolveSchema` — kept as a distinct name because
// call sites below document SOURCE-position intent, not because it still
// special-cases anything.
const sourceSchema = (obj) => resolveSchema(obj)

// Recognizes a literal `new X(...)`/`X(...)` Error-constructor-call node
// (the same AST shape emitErrorInstanceof's tier-1 fold and `isErrorSchemaSource`
// used to check) as carrying the physical Error schema `['message','name']`
// — every one of the 7 classes shares this exact layout (module/schema.js's
// `errorSid`, salted-but-content-identical registration). A BOUND Error name
// already resolves through `ctx.schema.resolve` below (its declaration-schema
// binding, src/prepare/index.js's `bindDeclSchema`) with no help needed here;
// this closes the one shape that binding doesn't cover — an Error constructed
// and used inline, never given a name (`Object.assign(new TypeError('x'), …)`,
// `Object.keys(new TypeError('x'))`) — which previously left `resolveSchema`
// returning null for the un-recognized call node, routing callers into
// dynamic-runtime-keys machinery. For most callers that dynamic path just
// works (if slowly); `Object.assign`'s dynamic arm (`emitObjectAssignDynamic`)
// has an unrelated pre-existing bug (never pulls the `array` module its own
// `__dyn_set` dependency needs, "internal: stdlib '__arr_set_idx_ptr' was
// requested but never registered") that this closes the same way the sibling
// spread-source crash is closed: by making the schema KNOWN, not by fixing
// the dynamic path itself.
const errorLiteralSchema = (obj) =>
  Array.isArray(obj) && obj[0] === '()' && typeof obj[1] === 'string' && ERR_CLASS_NAMES.includes(obj[1])
    ? ERR_SCHEMA_PROPS : null

// A `{}` literal AST NODE's own props, flattened. Comma-grouped children
// arrive as `['{}', [',', p1, p2, …]]` (prep's grouping of 2+ props) —
// same unwrap needed everywhere a tagged '{}' node (not yet destructured
// into an emit call's `...rawProps`) is inspected directly: resolveSchema,
// conditionalSpreadGroup, and Object.assign's literal-target reduction
// below all resolve the identical node shape and must agree on its props.
const literalProps = (node) =>
  node.length === 2 && Array.isArray(node[1]) && node[1][0] === ',' ? node[1].slice(1) : node.slice(1)

function resolveSchema(obj) {
  if (typeof obj === 'string') return ctx.schema.resolve(obj)
  const errSchema = errorLiteralSchema(obj)
  if (errSchema) return errSchema
  if (Array.isArray(obj) && obj[0] === '{}') {
    const props = literalProps(obj)
    // A spread-bearing literal's schema is the MERGE emitObjectSpread builds
    // (or null when any source is unknown → HASH result, runtime enumeration).
    // Filtering to ':'-entries here made Object.keys({ ...S, z: 9 }) fold to
    // ['z'] while the object's real slot layout carried S's keys too — the
    // spread's keys vanished from keys/values/entries/for-in/JSON while
    // remaining readable as properties (watr-in-kernel's normalize() cfg).
    if (props.some(p => Array.isArray(p) && p[0] === '...')) return spreadLiteralSchema(props)
    return props.filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
  }
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
  return sourceSchema(obj)
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

// Recognizes `cond && {k: v, …}` (module/function.js bodyFn's
// `...(restParam && { rest: restParam })` idiom, 12 independent instances in
// that one literal) as a CONDITIONAL spread group: a spread source whose KEY
// SET is statically known — the inner literal's own props — but whose
// PRESENCE at any one construction depends on a runtime condition. Chained
// guards (`a && (b && {…})`) unwrap through the right arm — the ORIGINAL
// node is still emitted as ONE unit by the caller (short-circuit + side
// effects run exactly once); only the key list needs unwrapping here. The
// inner literal must carry ONLY ':' props (no nested spread — keeps the
// runtime branch below a single present/absent copy, not a recursive
// merge); a spread-bearing inner literal falls through to null, same as any
// other unresolvable source (today's `emitDynamicSpread`, unchanged).
function conditionalSpreadGroup(node) {
  if (!Array.isArray(node) || node[0] !== '&&' || node.length !== 3) return null
  let inner = node[2]
  while (Array.isArray(inner) && inner[0] === '&&' && inner.length === 3) inner = inner[2]
  if (!Array.isArray(inner) || inner[0] !== '{}') return null
  const props = literalProps(inner)
  if (!props.length || !props.every(p => Array.isArray(p) && p[0] === ':')) return null
  return { keys: props.map(p => p[1]), props }
}

// Shared spread-merge walker behind spreadLiteralSchema (resolveSchema's
// consumer — key list only) and emitObjectSpread (needs the condNames split
// too, to know which slots get a runtime present/absent branch instead of an
// unconditional copy). Unions names in first-occurrence order; a name
// touched by more than one source bails the WHOLE merge (→ null, today's
// `emitDynamicSpread`) EXACTLY when a conditional group is on either side of
// the collision — resolving "does a later absent group leave an earlier
// value untouched" needs per-write provenance this fold doesn't track, and
// the target shape (bodyFn's 12 groups, each owning distinct keys) never
// collides. Two ORDINARY (non-conditional) sources sharing a key is
// unaffected: that's spread's ordinary last-wins semantics, unchanged from
// before this function existed. Re-spreading an ALREADY conditionally-
// schema'd source (`{...bodyFnLikeThing}`) also bails — propagating
// condNames through a second hop of spread is real but out of scope (see
// conditionalSpreadGroup's doc); staying null here just keeps that source on
// today's proven-safe dynamic path instead of silently losing the "maybe
// absent" fact one hop out.
function mergeSpreadNames(props) {
  const names = [], condNames = new Set(), seen = new Set()
  for (const p of props) {
    if (Array.isArray(p) && p[0] === '...') {
      const group = conditionalSpreadGroup(p[1])
      if (group) {
        for (const n of group.keys) {
          if (seen.has(n)) return null
          seen.add(n); names.push(n); condNames.add(n)
        }
        continue
      }
      const s = spreadSourceSchema(p[1])
      if (!s) return null
      // A bare-name source whose OWN schema already carries conditional
      // slots (an earlier application of this same fold) — bail rather than
      // silently drop the "maybe absent" fact one spread hop out (see doc).
      if (typeof p[1] === 'string' && ctx.schema.hasCondAbsent?.(ctx.schema.idOf(p[1]))) return null
      for (const n of s) {
        if (condNames.has(n)) return null
        if (!seen.has(n)) { seen.add(n); names.push(n) }
      }
    } else if (Array.isArray(p) && p[0] === ':') {
      if (condNames.has(p[1])) return null
      if (!seen.has(p[1])) { seen.add(p[1]); names.push(p[1]) }
    }
  }
  return { names, condNames }
}

// Merged static schema of a spread-bearing literal, or null when any spread
// source's key set is unknown at compile time (→ HASH result). The SINGLE
// source of truth for emitObjectSpread (which builds the object with exactly
// this slot layout) and resolveSchema (which keys/values/entries/for-in fold
// against) — the two MUST agree or enumeration drops the spread's keys.
function spreadLiteralSchema(props) {
  return mergeSpreadNames(props)?.names ?? null
}

function emitObjectSpread(props, spreadTarget = takeLiteralTarget()) {
  // Resolve every spread source's schema. A source with no static schema means
  // its full key set is unknown at compile time, so the merge result must be a
  // HASH (dynamic dict) — a fixed schema would silently drop the source's keys
  // it doesn't list. Only when EVERY source is known do we build the fixed-shape
  // OBJECT below.
  const merged = mergeSpreadNames(props)
  const allNames = merged?.names ?? null
  const allKnown = allNames != null
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

  const condNames = merged.condNames
  // Salted by the conditional prop set itself (not just a fixed marker): two
  // conditional literals sharing both the FULL prop list AND the identical
  // condNames set may still safely share a sid (schema.register's own content
  // dedup); one that differs in EITHER must not, or ctx.schema.condAbsentProps
  // (keyed by sid) would only be able to record one of the two truths. An
  // ordinary literal/spread with the identical physical prop list but no
  // conditional group (e.g. `{a: undefined}` colliding with `{...(c&&{a:1})}`'s
  // merged shape) never shares the salted id either — it keeps its own,
  // unconditionally-present sid (see test/conditional-spread.js).
  const schemaId = ctx.schema.register(allNames, condNames.size ? 'cond:' + [...condNames].sort().join(',') : undefined)
  if (condNames.size) ctx.schema.condAbsentProps.set(schemaId, condNames)
  // Extern-write belt: the spread slot-copies below write source-schema values
  // into this sid outside the write censuses' view (collectSlotWriteHazards
  // normally resolves the same merge at plan time; the belt covers divergence).
  ctx.schema.externSlotSids?.add(schemaId)
  const schema = ctx.schema.list[schemaId]
  const t = tempI32('obj')
  const ptr = temp('objp')
  const src = tempI32('osp')

  const body = [['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(schema.length)]]]]

  // Process props in order — later props override earlier (JS semantics)
  for (const p of props) {
    if (Array.isArray(p) && p[0] === '...') {
      const group = conditionalSpreadGroup(p[1])
      if (group) {
        // `cond && {k: v, …}` — emit the ORIGINAL node once (correct
        // short-circuit, side effects run exactly once), then branch on
        // whether the result is a genuine OBJECT pointer. `&&` is
        // value-preserving: a falsy `cond` surfaces AS-IS (false/null/
        // undefined/0/…, not necessarily the `false` atom), so the sound,
        // general presence test is the pointer's OWN tag, not a specific
        // sentinel-bits compare. Present: copy the group's own freshly-built
        // slots across (mirrors the ordinary known-schema copy below).
        // Absent: every slot this group owns gets the UNDEF sentinel
        // explicitly — each slot in `schema` is written EXACTLY once across
        // this whole loop (mergeSpreadNames' collision bail guarantees no
        // other prop/group also targets it), so there is no earlier value
        // to accidentally clobber.
        inc('__ptr_type', '__ptr_offset')
        const gv = temp('csv'), go = tempI32('cso')
        const present = [], absent = []
        group.props.forEach((gp, gi) => {
          const ti = schema.indexOf(group.keys[gi])
          if (ti < 0) return
          present.push(ctx.abi.object.ops.store(['local.get', `$${t}`], ti, ctx.abi.object.ops.load(['local.get', `$${go}`], gi)))
          absent.push(ctx.abi.object.ops.store(['local.get', `$${t}`], ti, undefExpr()))
        })
        body.push(
          ['local.set', `$${gv}`, asF64(emit(p[1]))],
          ['if', ['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${gv}`]]], ['i32.const', PTR.OBJECT]],
            ['then', ['local.set', `$${go}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${gv}`]]]], ...present],
            ['else', ...absent]])
        continue
      }
      const sSchema = spreadSourceSchema(p[1])
      body.push(['local.set', `$${src}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', asF64(emit(p[1]))]]])
      for (let si = 0; si < sSchema.length; si++) {
        const ti = schema.indexOf(sSchema[si])
        if (ti < 0) continue
        body.push(ctx.abi.object.ops.store(['local.get', `$${t}`], ti, ctx.abi.object.ops.load(['local.get', `$${src}`], si)))
      }
    } else if (Array.isArray(p) && p[0] === ':') {
      const ti = schema.indexOf(p[1])
      // CARRIER PROGRAM §15/§16 (see the plain-literal construction's own
      // comment above, ~line 220): schema-wide fact instead of an
      // unconditional box — a schema shared by a shadowed spread/literal
      // elsewhere still boxes here even when THIS particular spread target
      // isn't itself shadowed. No-op under CARRIER_BOX=off (storedValue and
      // storedValueNarrow are byte-identical then).
      if (ti >= 0) body.push(ctx.abi.object.ops.store(['local.get', `$${t}`], ti,
        (ctx.schema.slotBigintBoxedBySid?.(schemaId, p[1]) ? storedValue : storedValueNarrow)(p[2])))
    }
  }

  body.push(['local.set', `$${ptr}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${t}`])])
  // schemaId (dyn-reach slice): this spread's OWN just-registered sid (above) —
  // same granularity the write-hazard scan resolves for this merged shape.
  if (needsDynShadow(spreadTarget, schemaId)) {
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
  const id = freshId(ctx)
  // `__hash_set` may rehash and return a new pointer, so thread it back into $t.
  const setKey = (keyBits, valBits) =>
    ['local.set', `$${t}`, ['f64.reinterpret_i64',
      ['call', '$__hash_set', ['i64.reinterpret_f64', ['local.get', `$${t}`]], keyBits, valBits]]]
  const body = [['local.set', `$${t}`, ['call', '$__hash_new']]]

  for (let pi = 0; pi < props.length; pi++) {
    const p = props[pi]
    if (Array.isArray(p) && p[0] === ':') {
      // storedValue (carrierF64 ingress): a literal `true` must land as its TRUE
      // atom, not raw 1 bits — hash reads are dynamic-unknown, so strict `=== true`
      // compares IDENTITY against the atom (the resolveOptimize preset chain lost
      // every literal bool override in-kernel through exactly this raw store).
      body.push(setKey(asI64(emit(['str', String(p[1])])), asI64(storedValue(p[2]))))
      continue
    }
    const group = conditionalSpreadGroup(p[1])
    if (group) {
      // `cond && {k: v, …}` reaching a HASH destination (some OTHER source in
      // this same literal is genuinely unresolvable) — mirrors emitObjectSpread's
      // OWN conditional-group arm, but simpler: a HASH has no pre-allocated
      // slot to blank, so the absent arm inserts NOTHING (no setKey calls at
      // all) rather than writing an UNDEF placeholder — exactly `{...false}`'s
      // real JS "contributes zero keys" semantics, with no residual "present
      // but happens to be undefined" ambiguity (unlike the OBJECT arm, a HASH
      // key's mere INSERTION already means present — see conditionalSpreadGroup's
      // own doc for why that residual gap is inherent to the OBJECT slot model).
      inc('__ptr_type')
      body.push(['local.set', `$${s}`, asF64(emit(p[1]))])
      const setKeys = group.props.map((gp, gi) =>
        setKey(asI64(emit(['str', String(group.keys[gi])])), ctx.abi.object.ops.loadBits(['local.get', `$${sBase}`], gi)))
      body.push(['if', ['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${s}`]]], ['i32.const', PTR.OBJECT]],
        ['then', ['local.set', `$${sBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]], ...setKeys]])
      continue
    }
    const sSchema = spreadSourceSchema(p[1])
    body.push(['local.set', `$${s}`, asF64(emit(p[1]))])
    if (sSchema) {
      body.push(['local.set', `$${sBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]])
      // An ORDINARY (non-conditional-group) source whose OWN schema already
      // carries conditional slots (mergeSpreadNames bailed the WHOLE literal
      // here rather than fold it — see that function's own doc; this branch
      // is exactly what runs instead) must NOT blindly insert every schema
      // key: an absent slot (its value is the UNDEF sentinel) must
      // contribute NOTHING to the destination HASH, mirroring the
      // conditional-group arm's own "absent inserts nothing" semantics
      // just above — found live, not assumed: Object.keys on the result
      // wrongly included the absent key before this check existed.
      const srcCondNames = typeof p[1] === 'string' ? ctx.schema.condAbsentProps.get(ctx.schema.idOf(p[1])) : null
      for (let si = 0; si < sSchema.length; si++) {
        const setStmt = setKey(asI64(emit(['str', String(sSchema[si])])), ctx.abi.object.ops.loadBits(['local.get', `$${sBase}`], si))
        body.push(srcCondNames?.has(sSchema[si])
          ? ['if', ['i32.eqz', isUndef(ctx.abi.object.ops.load(['local.get', `$${sBase}`], si))], ['then', setStmt]]
          : setStmt)
      }
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

// resolveSchema's condNames sibling: which of THIS receiver's resolved
// schema names (if any) come from a conditional-spread group
// (conditionalSpreadGroup/mergeSpreadNames above) — the set
// Object.keys/values/entries' static fold (and __keys_ro's pool) must
// exclude from their value-blind "in schema ⇒ present" shortcut, routing
// them through emitCondAwareEnumerate below instead. Mirrors resolveSchema's
// OWN two receiver shapes: a bare name consults the POST-REGISTRATION
// ctx.schema.condAbsentProps side table (populated when that name's own
// `emitObjectSpread` ran, always before this — jz emits in source order);
// a raw `{}` AST node (an inline literal passed directly, e.g.
// `Object.keys({...(cond && {x:1})})` — never separately declared, so no
// sid exists to look up) re-derives it from mergeSpreadNames directly, the
// same recomputation resolveSchema's own '{}' branch does for `.names`.
// Null (not an empty Set) when `obj` carries no conditional slots at all —
// callers gate on `?.size` so the ordinary, zero-cost path is unaffected.
function schemaCondNames(obj) {
  if (typeof obj === 'string') {
    const sid = ctx.schema.idOf(obj)
    return sid != null ? ctx.schema.condAbsentProps.get(sid) : null
  }
  if (Array.isArray(obj) && obj[0] === '{}') {
    const props = obj.length === 2 && Array.isArray(obj[1]) && obj[1][0] === ','
      ? obj[1].slice(1) : obj.slice(1)
    if (props.some(p => Array.isArray(p) && p[0] === '...')) return mergeSpreadNames(props)?.condNames ?? null
  }
  return null
}

// Compile-time-specialized keys/values/entries enumerator for a receiver
// whose schema IS known at this call site (same no-dyn-props/no-out-of-
// schema-writes precondition the plain static fold above already requires)
// AND carries conditional-spread slots (schemaCondNames). Unlike
// emitEnumerateObject (ONE runtime-dispatched shape serving EVERY schema via
// the `__schema_tbl` sid lookup, blind to any one schema's own layout — the
// path a receiver with an UNRESOLVABLE-here schema still takes, unchanged),
// this generates ONE UNROLLED sequence per call site: an ordinary slot
// stores unconditionally (zero added cost vs today's plain static fold); a
// conditional slot is guarded by a runtime `isUndef` check on ITS OWN slot
// value, skipped (not stored, output index not advanced) when absent —
// `undefExpr()`/`isUndef` is exactly the sentinel emitObjectSpread's
// conditional-group arm writes for an absent group, so this reads back
// precisely what construction recorded. `storeAt({i, base, out, o})`
// returns the IR for storing schema[i]'s key/value/pair at output index
// `o` (`i` is compile-time, `base`/`out`/`o` are locals). Residual,
// documented gap (shared with hasOwnProperty/`in`'s own guard, see
// conditionalSpreadGroup): a PRESENT group whose value happens to BE
// `undefined` is indistinguishable from absent here, same as everywhere
// else this design signals presence through the value channel.
function emitCondAwareEnumerate(obj, schema, condNames, storeAt) {
  inc('__ptr_offset')
  const t = temp('cae'), base = tempI32('caeb'), o = tempI32('caeo')
  const out = allocPtr({ type: PTR.ARRAY, len: schema.length, tag: 'cae' })
  const body = [
    ['local.set', `$${t}`, asF64(emit(obj))], out.init,
    ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${o}`, ['i32.const', 0]]]
  for (let i = 0; i < schema.length; i++) {
    const store = [...storeAt({ i, base, out: out.local, o }),
      ['local.set', `$${o}`, ['i32.add', ['local.get', `$${o}`], ['i32.const', 1]]]]
    if (condNames.has(schema[i]))
      body.push(['if', ['i32.eqz', isUndef(ctx.abi.object.ops.load(['local.get', `$${base}`], i))], ['then', ...store]])
    else
      body.push(...store)
  }
  body.push(['i32.store', ['i32.sub', ['local.get', `$${out.local}`], ['i32.const', 8]], ['local.get', `$${o}`]])
  body.push(out.ptr)
  return typed(['block', ['result', 'f64'], ...body], 'f64')
}

const emitCondAwareKeys = (obj, schema, condNames) => emitCondAwareEnumerate(obj, schema, condNames,
  ({ i, out, o }) => [elemStore(out, o, emit(['str', String(schema[i])]))])

const emitCondAwareValues = (obj, schema, condNames) => emitCondAwareEnumerate(obj, schema, condNames,
  ({ i, out, o, base }) => [elemStore(out, o, ctx.abi.object.ops.load(['local.get', `$${base}`], i))])

const emitCondAwareEntries = (obj, schema, condNames) => {
  const pair = tempI32('caep')
  inc('__alloc_hdr')
  return emitCondAwareEnumerate(obj, schema, condNames,
    ({ i, out, o, base }) => [
      ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2]]],
      ['f64.store', slotAddr(pair, 0), emit(['str', String(schema[i])])],
      ['f64.store', slotAddr(pair, 1), ctx.abi.object.ops.load(['local.get', `$${base}`], i)],
      elemStore(out, o, mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${pair}`]))])
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

// for-in over a statically-HASH receiver: serve keys through the shared enum
// cache (core.js __hash_keys_ro) — read-only by the for-in lowering's contract.
function emitHashKeysRO(obj) {
  inc('__hash_keys_ro')
  declEnumcGlobals()
  return typed(['call', '$__hash_keys_ro', ['i64.reinterpret_f64', asF64(emit(obj))]], 'f64')
}

// __hash_keys_ro's cache globals — declared at emit time so the helper's text
// resolves even in builds where collection.js (which also declares them for its
// delete-hook) never loads. enumcConsumed marks that some enumeration site can
// FILL the cache this build (the OBJECT arm is inline IR — reachability can't
// see it), so assemble.js knows to reset it in `__clear` (ABA guard).
function declEnumcGlobals() {
  ctx.runtime.enumcConsumed = true
  if (!ctx.scope.globals.has('__enumc_off')) {
    declGlobal('__enumc_off', 'i32')
    declGlobal('__enumc_len', 'i32')
    declGlobal('__enumc_arr', 'f64')
  }
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
  inc('__ptr_offset', '__cap', '__coll_order')
  const off = tempI32('hko'), cap = tempI32('hkc'), n = tempI32('hkn')
  const i = tempI32('hki'), ord = tempI32('hkr'), slot = tempI32('hks')
  // len is __coll_order's OWN live count, not the header length (core.js
  // __coll_order header comment: the two can disagree) — out must be sized to
  // what the fill loop below actually writes.
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'hka' })
  const id = freshId(ctx)
  return ['block', ['result', 'f64'],
    ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${cap}`, ['call', '$__cap', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${ord}`, ['call', '$__coll_order', ['local.get', `$${off}`], ['local.get', `$${cap}`], ['i32.const', 24]]],
    ['local.set', `$${n}`, ['global.get', '$__coll_order_n']],
    out.init,
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
  inc('__ptr_offset', '__cap', '__coll_order')
  const off = tempI32('hvo'), cap = tempI32('hvc'), n = tempI32('hvn')
  const i = tempI32('hvi'), ord = tempI32('hvr'), slot = tempI32('hvs')
  // len is __coll_order's OWN live count — see hashKeysFromTemp's comment above.
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'hva' })
  const id = freshId(ctx)
  return ['block', ['result', 'f64'],
    ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${cap}`, ['call', '$__cap', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${ord}`, ['call', '$__coll_order', ['local.get', `$${off}`], ['local.get', `$${cap}`], ['i32.const', 24]]],
    ['local.set', `$${n}`, ['global.get', '$__coll_order_n']],
    out.init,
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
  inc('__ptr_offset', '__cap', '__alloc_hdr', '__coll_order')
  const off = tempI32('heo'), cap = tempI32('hec'), n = tempI32('hen')
  const i = tempI32('hei'), ord = tempI32('her'), slot = tempI32('hes'), pair = tempI32('hep')
  // len is __coll_order's OWN live count — see hashKeysFromTemp's comment above.
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'hea' })
  const id = freshId(ctx)
  return ['block', ['result', 'f64'],
    ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${cap}`, ['call', '$__cap', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${ord}`, ['call', '$__coll_order', ['local.get', `$${off}`], ['local.get', `$${cap}`], ['i32.const', 24]]],
    ['local.set', `$${n}`, ['global.get', '$__coll_order_n']],
    out.init,
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
function emitRuntimeKeys(obj, ro) {
  const t = temp('rk')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, asF64(emit(obj))],
    runtimeKeysFromTemp(t, 'rk', ro)], 'f64')
}

function runtimeKeysFromTemp(t, tag, ro) {
  if (ctx.memory.shared) ro = false  // see emitKeysGeneric — no enum cache under shared memory
  inc('__ptr_type')
  // Ensure the schema table global exists even in programs that never use
  // JSON.parse or compile-time schemas — the OBJECT arm reads it at runtime
  // and the watr resolver requires the symbol to be declared. Declaring is not
  // enough: the OBJECT arm READS the table inline (no named helper to count),
  // so mark consumption for assemble.js's needsSchemaTbl gate or the table
  // stays 0 and enumeration silently yields zero schema keys.
  if (!ctx.scope.globals.has('__schema_tbl'))
    declGlobal('__schema_tbl', 'i32')
  ctx.runtime.schemaTblConsumed = true
  const tt = tempI32(`${tag}t`)
  const empty = allocPtr({ type: PTR.ARRAY, len: 0, tag: `${tag}e` })
  return ['block', ['result', 'f64'],
    ['local.set', `$${tt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['if', ['result', 'f64'],
      ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.HASH]],
      // for-in (ro): serve the shared enum-cache array — see emitHashKeysRO.
      ['then', ro
        ? (inc('__hash_keys_ro'), declEnumcGlobals(),
          ['call', '$__hash_keys_ro', ['i64.reinterpret_f64', ['local.get', `$${t}`]]])
        : hashKeysFromTemp(t)],
      ['else', ['if', ['result', 'f64'],
        ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.OBJECT]],
        ['then', objectKeysFromTemp(t, ro)],
        ['else', ['block', ['result', 'f64'], empty.init, empty.ptr]]]]]]
}

function emitRuntimeValues(obj) {
  inc('__ptr_type')
  if (!ctx.scope.globals.has('__schema_tbl'))
    declGlobal('__schema_tbl', 'i32')
  ctx.runtime.schemaTblConsumed = true
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
  ctx.runtime.schemaTblConsumed = true
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
function emitEnumerateObject(t, emitStaticStore, emitDynStore, ro) {
  inc('__alloc_hdr', '__ptr_offset', '__coll_order')
  if (ro) declEnumcGlobals()
  // Durable-receiver global-table merge (see below) only when collection.js's
  // dyn-props machinery is actually part of this build — a program that never
  // writes a dynamic prop anywhere never loads collection.js, so __dyn_props/
  // __ihash_get_local wouldn't exist to reference.
  const hasDynProps = ctx.scope.globals.has('__dyn_props')
  if (hasDynProps) inc('__ihash_get_local', '__is_nullish')
  const sid = tempI32('oes'), src = tempI32('oesrc'), sn = tempI32('oen')
  const base = tempI32('oebase'), props = tempI64('oepr')
  // TWO dyn-prop sources for a DURABLE receiver: the off-16 sidecar (populated
  // if this receiver got dyn props DURING init, while __heap_reset was still
  // low) and the global __dyn_props table (populated by RUNTIME/post-init
  // writes — see collection.js's heapResetWat). Either, both, or neither may
  // be non-empty; enumerate whichever exist, deduping across schema ∪ global
  // ∪ sidecar (in that priority — global shadows a sidecar entry with the
  // same key, matching __dyn_get_t_h's read priority). An EPHEMERAL receiver
  // only ever uses the sidecar slot (poffG stays 0 for it).
  const poffG = tempI32('oepoG'), pcapG = tempI32('oepcG'), dnG = tempI32('oednG'), ordG = tempI32('oeordG')
  const poffS = tempI32('oepoS'), pcapS = tempI32('oepcS'), dnS = tempI32('oednS'), ordS = tempI32('oeordS')
  // dnG/dnS (above) stay the HEADER length — the cheap for-in cache key
  // (roHit/cache-store below), read before __coll_order ever runs. dnGReal/
  // dnSReal are __coll_order's OWN live counts, read right after each call —
  // walkDyn's actual loop bound MUST use these, not the header, or a header/
  // real-occupancy desync walks past __coll_order's real buffer (see
  // __coll_order's header comment, core.js, for why they can disagree). `total`
  // (below) keeps sizing off the header value — header ≥ real is the only
  // possible direction (an insert can only ever be dropped from the gathered
  // count, never conjured), so it stays a valid upper bound for the trimmed
  // (header-patched) output allocation.
  const dnGReal = tempI32('oednGr'), dnSReal = tempI32('oednSr')
  const total = tempI32('oetot')
  const out = tempI32('oeo'), i = tempI32('oei'), o = tempI32('oej')
  const slot = tempI32('oesl')
  const j = tempI32('oej2'), skip = tempI32('oesk'), pair = tempI32('oep')
  const id = freshId(ctx)
  const env = { out, o, src, base, i, slot, pair }
  // for-in enum cache, OBJECT arm (see core.js __hash_keys_ro for the scheme).
  // Key = (sidecar off, sidecar len): the sidecar identifies the object (one
  // sidecar per object, offs unique), sid/schema are immutable per object, and
  // every other key-set change clears the cache — sidecar inserts change dnS
  // (natural miss), sidecar/global deletes and global dyn-prop inserts clear
  // __enumc_off at their (cold) sites. Checked BEFORE the global __dyn_props
  // probe, so a hit skips the ihash lookup too — sound because any global-side
  // structural change since fill cleared the cache. poffS≠0 guard: an empty
  // cache (off 0) must not match a sidecar-less object.
  const roHit = ro ? [['if', ['i32.and',
      ['i32.and',
        ['i32.ne', ['local.get', `$${poffS}`], ['i32.const', 0]],
        ['i32.eq', ['local.get', `$${poffS}`], ['global.get', '$__enumc_off']]],
      ['i32.eq', ['local.get', `$${dnS}`], ['global.get', '$__enumc_len']]],
    ['then', ['br', `$oed${id}`, ['global.get', '$__enumc_arr']]]]] : []
  // Dedup-and-store one dyn source's dn live slots (at poff/pcap, ord already
  // computed) against the schema (0..sn @ src) and, when `against` is given,
  // a second dyn source's already-walked ord array (0..dn2 @ ord2).
  const walkDyn = (label, dn, ord, against) => ['if', ['i32.ne', ['local.get', `$${dn}`], ['i32.const', 0]],
    ['then',
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$${label}brk${id}`, ['loop', `$${label}loop${id}`,
        ['br_if', `$${label}brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${dn}`]]],
        ['local.set', `$${slot}`, ['i32.load', ['i32.add', ['local.get', `$${ord}`],
          ['i32.shl', ['local.get', `$${i}`], ['i32.const', 2]]]]],
        ['local.set', `$${skip}`, ['i32.const', 0]],
        ['local.set', `$${j}`, ['i32.const', 0]],
        ['block', `$${label}skbrk${id}`, ['loop', `$${label}skloop${id}`,
          ['br_if', `$${label}skbrk${id}`, ['i32.ge_s', ['local.get', `$${j}`], ['local.get', `$${sn}`]]],
          ['if', ['i64.eq',
              ['i64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]],
              ['i64.load', ['i32.add', ['local.get', `$${src}`], ['i32.shl', ['local.get', `$${j}`], ['i32.const', 3]]]]],
            ['then', ['local.set', `$${skip}`, ['i32.const', 1]], ['br', `$${label}skbrk${id}`]]],
          ['local.set', `$${j}`, ['i32.add', ['local.get', `$${j}`], ['i32.const', 1]]],
          ['br', `$${label}skloop${id}`]]],
        ...(against ? [
          ['if', ['i32.eqz', ['local.get', `$${skip}`]],
            ['then',
              ['local.set', `$${j}`, ['i32.const', 0]],
              ['block', `$${label}gdbrk${id}`, ['loop', `$${label}gdloop${id}`,
                ['br_if', `$${label}gdbrk${id}`, ['i32.ge_s', ['local.get', `$${j}`], ['local.get', `$${against.dn}`]]],
                ['if', ['i64.eq',
                    ['i64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]],
                    ['i64.load', ['i32.add', ['i32.load', ['i32.add', ['local.get', `$${against.ord}`],
                      ['i32.shl', ['local.get', `$${j}`], ['i32.const', 2]]]], ['i32.const', 8]]]],
                  ['then', ['local.set', `$${skip}`, ['i32.const', 1]], ['br', `$${label}gdbrk${id}`]]],
                ['local.set', `$${j}`, ['i32.add', ['local.get', `$${j}`], ['i32.const', 1]]],
                ['br', `$${label}gdloop${id}`]]]]]] : []),
        ['if', ['i32.eqz', ['local.get', `$${skip}`]],
          ['then',
            ...emitDynStore(env),
            ['local.set', `$${o}`, ['i32.add', ['local.get', `$${o}`], ['i32.const', 1]]]]],
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$${label}loop${id}`]]]]]
  return ['block', `$oed${id}`, ['result', 'f64'],
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
    // Dyn-props: heap OBJECTs carry a HASH propsPtr either at base-16
    // (populated by an init-time write, or by any write at all on an
    // EPHEMERAL receiver — one allocated after the post-init high-water
    // mark, per the durable-receiver policy) or in the global __dyn_props
    // table keyed by offset (populated by a RUNTIME/post-init write on a
    // DURABLE receiver; see collection.js's heapResetWat). Static-segment
    // objects (base < __heap_start) have no header at all and predate any
    // warm-reuse machinery, so they contribute no dyn keys either way.
    ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${dnG}`, ['i32.const', 0]],
    ['local.set', `$${poffG}`, ['i32.const', 0]],
    ['local.set', `$${dnS}`, ['i32.const', 0]],
    ['local.set', `$${poffS}`, ['i32.const', 0]],
    ['if', ['i32.ge_u', ['local.get', `$${base}`], heapResetIR()],
      ['then',
        ['local.set', `$${props}`, ['i64.load', ['i32.sub', ['local.get', `$${base}`], ['i32.const', 16]]]],
        ['if', ['i32.eq',
            ['i32.wrap_i64', ['i64.and', ['i64.shr_u', ['local.get', `$${props}`], ['i64.const', LAYOUT.TAG_SHIFT]], ['i64.const', LAYOUT.TAG_MASK]]],
            ['i32.const', PTR.HASH]],
          ['then',
            // Resolve forward chain — HASH may have forwarded on grow; the raw
            // propsPtr offset would point at the forward record, not live slots.
            ['local.set', `$${poffS}`, ['call', '$__ptr_offset', ['local.get', `$${props}`]]],
            ['local.set', `$${pcapS}`, ['i32.load', ['i32.sub', ['local.get', `$${poffS}`], ['i32.const', 4]]]],
            ['local.set', `$${dnS}`, ['i32.load', ['i32.sub', ['local.get', `$${poffS}`], ['i32.const', 8]]]]]],
        ...roHit],
      ...(hasDynProps ? [['else',
        // Sidecar (init-time keys, if any) — only for genuinely heap-allocated
        // receivers (base >= __heap_start): static-segment objects have no
        // header at all, so the off-16 read would hit neighboring static data.
        // Durable words may carry the runtime-shadowed bit0 marker
        // (collection.js __dyn_set) — mask it out or the resolved sidecar off
        // is misaligned.
        ['if', ['i32.ge_u', ['local.get', `$${base}`], ['global.get', '$__heap_start']],
          ['then',
        ['local.set', `$${props}`, ['i64.and',
          ['i64.load', ['i32.sub', ['local.get', `$${base}`], ['i32.const', 16]]], ['i64.const', -2]]],
        ['if', ['i32.eq',
            ['i32.wrap_i64', ['i64.and', ['i64.shr_u', ['local.get', `$${props}`], ['i64.const', LAYOUT.TAG_SHIFT]], ['i64.const', LAYOUT.TAG_MASK]]],
            ['i32.const', PTR.HASH]],
          ['then',
            ['local.set', `$${poffS}`, ['call', '$__ptr_offset', ['local.get', `$${props}`]]],
            ['local.set', `$${pcapS}`, ['i32.load', ['i32.sub', ['local.get', `$${poffS}`], ['i32.const', 4]]]],
            ['local.set', `$${dnS}`, ['i32.load', ['i32.sub', ['local.get', `$${poffS}`], ['i32.const', 8]]]]]]]],
        ...roHit,
        // Global (runtime-written keys, if any) — NO heap_start gate: __dyn_set
        // routes writes on STATIC-SEGMENT receivers here too (they have no
        // header, so the global table is their only storage), and the probe is
        // keyed by offset, needing no header. Gating it on heap_start silently
        // dropped `o.zz = 3` on a data-segment literal from enumeration.
        ['if', ['f64.ne', ['global.get', '$__dyn_props'], ['f64.const', 0]],
          ['then',
            ['local.set', `$${props}`, ['call', '$__ihash_get_local',
              ['i64.reinterpret_f64', ['global.get', '$__dyn_props']],
              ['i64.reinterpret_f64', ['f64.convert_i32_s', ['local.get', `$${base}`]]]]],
            ['if', ['i32.eqz', ['call', '$__is_nullish', ['local.get', `$${props}`]]],
              ['then',
                ['local.set', `$${poffG}`, ['call', '$__ptr_offset', ['local.get', `$${props}`]]],
                ['local.set', `$${pcapG}`, ['i32.load', ['i32.sub', ['local.get', `$${poffG}`], ['i32.const', 4]]]],
                ['local.set', `$${dnG}`, ['i32.load', ['i32.sub', ['local.get', `$${poffG}`], ['i32.const', 8]]]]]]]]]] : [])],
    // for-in with no dyn sources at all: the enumeration IS the schema key
    // array, and __schema_tbl[sid] already holds it as a static jz array —
    // return it boxed directly. Read-only by for-in's contract, static by
    // construction: no alloc, no cache, no invalidation. Every schema
    // (including the Error schema — its two slots are ordinary, fully
    // enumerable properties) qualifies uniformly.
    ...(ro ? [['if', ['i32.and',
        ['i32.and', ['i32.eqz', ['local.get', `$${dnG}`]], ['i32.eqz', ['local.get', `$${dnS}`]]],
        ['i32.ne', ['local.get', `$${src}`], ['i32.const', 0]]],
      ['then', ['br', `$oed${id}`, mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${src}`])]]]] : []),
    // Over-allocate sn+dnG+dnS; patch length to actual `o` post-dedup so
    // removed shadow-mirror/cross-source-duplicate slots never expose
    // garbage tails.
    ['local.set', `$${total}`, ['i32.add', ['local.get', `$${sn}`], ['i32.add', ['local.get', `$${dnG}`], ['local.get', `$${dnS}`]]]],
    ['local.set', `$${out}`, ['call', '$__alloc_hdr', ['local.get', `$${total}`], ['local.get', `$${total}`]]],
    ['local.set', `$${o}`, ['i32.const', 0]],
    // Static schema slots — every key is unique by construction, unconditionally.
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$sbrk${id}`, ['loop', `$sloop${id}`,
      ['br_if', `$sbrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${sn}`]]],
      ...emitStaticStore(env), ['local.set', `$${o}`, ['i32.add', ['local.get', `$${o}`], ['i32.const', 1]]],
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$sloop${id}`]]],
    // Dyn-prop slots in insertion order (__coll_order sorts the live 24-byte
    // slots by packed seq; hash@+0, key@+8, value@+16). Skip entries whose key
    // is already in the schema — when an object literal has shadow=true (per
    // needsDynShadow), each schema key is mirrored into propsPtr at construction
    // so dyn-key reads hit the hash fast path; the mirror is not an enumeration
    // entity, so we must not emit it twice. Global walks first (schema-dedup
    // only); sidecar walks second (schema-dedup AND global-dedup, so a key
    // present in both — reassigned at runtime after being set at init — is
    // emitted once, from the authoritative global copy).
    ['if', ['i32.ne', ['local.get', `$${poffG}`], ['i32.const', 0]],
      ['then',
        ['local.set', `$${ordG}`, ['call', '$__coll_order', ['local.get', `$${poffG}`], ['local.get', `$${pcapG}`], ['i32.const', 24]]],
        ['local.set', `$${dnGReal}`, ['global.get', '$__coll_order_n']]]],
    ['if', ['i32.ne', ['local.get', `$${poffS}`], ['i32.const', 0]],
      ['then',
        ['local.set', `$${ordS}`, ['call', '$__coll_order', ['local.get', `$${poffS}`], ['local.get', `$${pcapS}`], ['i32.const', 24]]],
        ['local.set', `$${dnSReal}`, ['global.get', '$__coll_order_n']]]],
    walkDyn('oeg', dnGReal, ordG, null),
    walkDyn('oes', dnSReal, ordS, { dn: dnGReal, ord: ordG }),
    ['i32.store', ['i32.sub', ['local.get', `$${out}`], ['i32.const', 8]], ['local.get', `$${o}`]],
    // Fill the enum cache (keyed by sidecar — see roHit above). Objects without
    // a sidecar are either tier-1 (returned above) or global-only (rare; a 0 key
    // would collide across objects, so leave them uncached).
    ...(ro ? [['if', ['i32.ne', ['local.get', `$${poffS}`], ['i32.const', 0]],
      ['then',
        ['global.set', '$__enumc_off', ['local.get', `$${poffS}`]],
        ['global.set', '$__enumc_len', ['local.get', `$${dnS}`]],
        ['global.set', '$__enumc_arr', mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${out}`])]]]] : []),
    mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${out}`])]
}

// Object.keys for an OBJECT — copy schema key (i64@src+i*8) then dyn key (i64@slot+8).
// ro (for-in): serve the static schema array / enum cache — see emitEnumerateObject.
const objectKeysFromTemp = (t, ro) => emitEnumerateObject(t,
  ({ out, o, src, i }) => [
    ['i64.store',
      ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${o}`], ['i32.const', 3]]],
      ['i64.load', ['i32.add', ['local.get', `$${src}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]]],
  ({ out, o, slot }) => [
    ['i64.store',
      ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${o}`], ['i32.const', 3]]],
      ['i64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]]]], ro)

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
