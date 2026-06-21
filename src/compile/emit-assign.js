/**
 * Assignment IR helpers — element writes (`arr[i] = v`), property writes
 * (`obj.p = v`), and the binding-persist discipline for helpers that may
 * relocate a header (`__arr_set_idx_ptr`, `__arr_grow`, `__hash_set`).
 *
 * Extracted from emit.js along its section banner; calls back into the
 * dispatcher through bridge.js (the same pattern module/*.js uses), so the
 * import graph stays acyclic: emit.js → emit-assign.js → bridge → emit.
 *
 * @module compile/emit-assign
 */

import { ctx, err, inc, warnDeopt, PTR } from '../ctx.js'
import { T } from '../ast.js'
import { staticPropertyKey, staticIndexKey } from '../static.js'
import { valTypeOf, shapeOf } from '../kind.js'
import { VAL, lookupValType, repOf } from '../reps.js'
import {
  typed, asF64, asI32, asI64, temp, tempI32, withTemp, block64,
  ptrOffsetIR, ptrTypeEq, boxedAddr, writeVar, isGlobal, isBoundName, isLiteralStr,
  usesDynProps, needsDynShadow, boolBoxIR,
} from '../ir.js'
import { emit } from '../bridge.js'


// Boxed-bool-aware store value: booleans persist as their tagged atom.
const storedValue = (node) => valTypeOf(node) === VAL.BOOL ? boolBoxIR(emit(node)) : asF64(emit(node))

// Integer array-index key: '3' → 3; rejects non-canonical and 2³²−1.
function arrayIndexKey(key) {
  const n = Number(key)
  const u = n >>> 0
  return String(u) === key && u !== 0xffffffff ? u : null
}

/** Write a (possibly relocated) f64 pointer back to its binding, honoring the
 *  same cell-vs-global-vs-local discipline as writeVar. Returns the store IR
 *  for the given f64 `ptr` expression; used as a callback by helpers that may
 *  relocate the array header (`__arr_set_idx_ptr`, `__arr_set_length`,
 *  `__arr_grow`, `__hash_set`). */
function persistBindingPtr(name, ptr) {
  // A NaN-boxed pointer never lands in an i32-narrowed cell: cellTypes requires
  // intCertain (integer-valued defs only), and a binding that receives array/hash
  // pointers is never integer-certain — so the f64 width is always right here.
  if (ctx.func.boxed?.has(name)) return ['f64.store', boxedAddr(name), ptr]
  if (isGlobal(name)) return ['global.set', `$${name}`, ptr]
  return ['local.set', `$${name}`, ptr]
}
/** Curried form for call sites that pass a persist callback. */
const persistBinding = name => ptr => persistBindingPtr(name, ptr)

/** Emit an ARRAY element write via `__arr_set_idx_ptr`. The helper may relocate
 *  the array header (capacity grow); `persist` writes the new pointer back to
 *  the receiver binding. Returns the stored value as the block result. */
function storeArrayPayload(arrExpr, idxNode, valueExpr, persist) {
  const arrTmp = `${T}asi${ctx.func.uniq++}`
  const idxTmp = `${T}asj${ctx.func.uniq++}`
  const valTmp = `${T}asv${ctx.func.uniq++}`
  ctx.func.locals.set(arrTmp, 'f64')
  ctx.func.locals.set(idxTmp, 'i32')
  ctx.func.locals.set(valTmp, 'f64')
  inc('__arr_set_idx_ptr')
  const body = [
    ['local.set', `$${arrTmp}`, arrExpr],
    ['local.set', `$${idxTmp}`, asI32(typed(idxNode, 'f64'))],
    ['local.set', `$${valTmp}`, valueExpr],
    ['local.set', `$${arrTmp}`, ['call', '$__arr_set_idx_ptr', ['i64.reinterpret_f64', ['local.get', `$${arrTmp}`]], ['local.get', `$${idxTmp}`], ['local.get', `$${valTmp}`]]],
  ]
  if (persist) body.push(persist(['local.get', `$${arrTmp}`]))
  body.push(['local.get', `$${valTmp}`])
  return block64(...body)
}

/** Strict-mode guard for dynamic property writes — emitted in branches that
 *  fall through to `__dyn_set` or its key-kind dispatch. */
function ensureDynSetAllowed(arr) {
  const arrLabel = typeof arr === 'string' ? arr : '<expr>'
  warnDeopt('deopt-dyn-write', `dynamic property write \`${arrLabel}[…] = …\` couldn't resolve a static type — it falls back to a runtime hash store (~2× slower than a typed/slot write, far worse in a hot loop). Use a literal key, a numeric typed-array index, or a Map for genuinely dynamic keys.`)
  if (!ctx.transform.strict) return
  err(`strict mode: dynamic property assignment \`${arrLabel}[<expr>] = ...\` falls back to __dyn_set. Use a literal key or known array/typed-array numeric index, or pass { strict: false }.`)
}

/** Last-resort dynamic property write through `__dyn_set`. */
function dynSetCall(arr, keyExpr, valueExpr) {
  ensureDynSetAllowed(arr)
  inc('__dyn_set')
  return typed(['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(arr)), asI64(keyExpr), asI64(valueExpr)]], 'f64')
}

/** Runtime fork by key kind: string keys go to `__dyn_set`, numeric keys go through
 *  `numericIR(keyExpr)`. Used when key type is unknown at compile time. */
function dispatchByKeyKind(arr, keyExpr, valueExpr, numericIR) {
  ensureDynSetAllowed(arr)
  const keyTmp = temp()
  return block64(
    ['local.set', `$${keyTmp}`, keyExpr],
    ['if', ['result', 'f64'], ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.get', `$${keyTmp}`]]],
      ['then', ['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(arr)), ['i64.reinterpret_f64', ['local.get', `$${keyTmp}`]], asI64(valueExpr)]]],
      ['else', numericIR(['local.get', `$${keyTmp}`])]])
}

/** Build a `__ptr_type`-fork IR for `arr[idx] = val` when receiver is opaque
 *  (non-string expr, or string-named binding of unknown VAL). Forks on
 *  ARRAY → `__arr_set_idx_ptr` (+ optional persist), TYPED → `__typed_set_idx`,
 *  else → raw f64.store at the OBJECT/HASH payload offset. */
function emitPolymorphicElementStore(arrExpr, idxI32, valueExpr, arrVT, persist) {
  const objTmp = temp('asu')
  const idxTmp = tempI32('asi')
  const ptrTmp = temp('asp')
  const valTmp = temp()
  const hasTypedSet = !!ctx.core.stdlib['__typed_set_idx']
  inc('__ptr_type', '__arr_set_idx_ptr')
  if (hasTypedSet) inc('__typed_set_idx')
  const arrSetCall = ['call', '$__arr_set_idx_ptr', ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]], ['local.get', `$${idxTmp}`], ['local.get', `$${valTmp}`]]
  const arrayBranch = ['block', ['result', 'f64'],
    ['local.set', `$${ptrTmp}`, arrSetCall],
    ...(persist ? [persist(['local.get', `$${ptrTmp}`])] : []),
    ['local.get', `$${valTmp}`]]
  const fallbackStore = ['block', ['result', 'f64'],
    ['f64.store', ['i32.add', ptrOffsetIR(['local.get', `$${objTmp}`], arrVT), ['i32.shl', ['local.get', `$${idxTmp}`], ['i32.const', 3]]], ['local.get', `$${valTmp}`]],
    ['local.get', `$${valTmp}`]]
  const elseBranch = hasTypedSet
    ? ['if', ['result', 'f64'],
        ptrTypeEq(['local.get', `$${objTmp}`], PTR.TYPED),
        ['then', ['call', '$__typed_set_idx', ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]], ['local.get', `$${idxTmp}`], ['local.get', `$${valTmp}`]]],
        ['else', fallbackStore]]
    : fallbackStore
  return block64(
    ['local.set', `$${objTmp}`, asF64(arrExpr)],
    ['local.set', `$${idxTmp}`, idxI32],
    ['local.set', `$${valTmp}`, valueExpr],
    ['if', ['result', 'f64'],
      ptrTypeEq(['local.get', `$${objTmp}`], PTR.ARRAY),
      ['then', arrayBranch],
      ['else', elseBranch]])
}

/** Element assignment: `arr[idx] = val`. Linear strategy chain — first match wins.
 *  Order matters: literal-key fast paths shadow generic stores; SRoA shadow before
 *  schema; typed-array element write before generic f64.store. */
export { persistBindingPtr }

export function emitElementAssign(arr, idx, val) {
  // _expect is clobbered by every sub-emit() — capture statement-position hint
  // up front so the typed-array element-write path can elide the value materialize.
  const void_ = ctx.func._expect === 'void'
  const keyType = valTypeOf(idx)
  // A provably-numeric index name — an int-certain loop counter or a NUMBER-typed
  // local — can never be a string key, so the runtime `__is_str_key` → `__dyn_set`
  // dispatch is dead. Mirrors the index *read* path (`intIndexIR`), closing the
  // read/write asymmetry on `arr[i] = …` inside refined-array loops.
  const idxNumericName = typeof idx === 'string' &&
    (repOf(idx)?.intCertain === true || repOf(idx)?.val === VAL.NUMBER)
  const useRuntimeKeyDispatch = !idxNumericName &&
    (keyType == null || (typeof idx === 'string' && keyType !== VAL.STRING))
  const keyExpr = asF64(emit(idx))
  const valueExpr = asF64(emit(val))
  // Literal string key, or schema-known object receiver with a static key expression.
  const litKey = isLiteralStr(idx) ? idx[1]
    : typeof arr === 'string' && lookupValType(arr) === VAL.OBJECT ? staticPropertyKey(idx)
    : null

  // 1. SRoA flat object/array: `o['k'] = x` / `a[2] = x` → `local.set $o#i` (no heap
  // store). A bare integer index resolves its slot key here (not via `litKey`).
  if (typeof arr === 'string' && ctx.func.flatObjects?.has(arr)) {
    const fo = ctx.func.flatObjects.get(arr)
    const flatKey = litKey != null ? litKey : staticIndexKey(idx)
    const fi = flatKey != null ? fo.names.indexOf(flatKey) : -1
    if (fi >= 0) return withTemp(valueExpr, t => [
      ['local.set', `$${arr}#${fi}`, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]])
  }
  // 2. Schema field literal key → direct payload-slot write.
  if (litKey != null && typeof arr === 'string' && ctx.schema.slotOf) {
    const slot = ctx.schema.slotOf(arr, litKey)
    if (slot >= 0) return withTemp(valueExpr, t => [
      ctx.abi.object.ops.store(ptrOffsetIR(asF64(emit(arr)), lookupValType(arr) || VAL.OBJECT), slot, ['local.get', `$${t}`]),
      ['local.get', `$${t}`]])
  }
  // 3. Known-ARRAY receiver + literal numeric key → __arr_set_idx_ptr.
  const arrIndex = litKey != null ? arrayIndexKey(litKey) : null
  if (arrIndex != null && typeof arr === 'string' && valTypeOf(arr) === VAL.ARRAY)
    return storeArrayPayload(asF64(emit(arr)), typed(['f64.const', arrIndex], 'f64'), valueExpr, persistBinding(arr))

  // 4. Known-STRING key → __dyn_set (after schema/SRoA literal-key paths).
  if (keyType === VAL.STRING) return dynSetCall(arr, keyExpr, valueExpr)

  // 5. Typed-array receiver → __typed_set_idx (or per-ctor element write).
  if (typeof arr === 'string' && ctx.core.emit['.typed:[]='] &&
      lookupValType(arr) === 'typed') {
    const r = ctx.core.emit['.typed:[]=']?.(arr, idx, val, void_)
    if (r) return r
    // Element ctor unknown — runtime aux-byte dispatch. __typed_set_idx
    // returns the stored value as f64, used directly as the expr result.
    inc('__typed_set_idx')
    return typed(['call', '$__typed_set_idx',
      asI64(emit(arr)), asI32(emit(idx)), valueExpr], 'f64')
  }

  // 6. Boxed schema array — payload pointer is stored at the receiver's payload offset.
  if (typeof arr === 'string' && ctx.schema.isBoxed?.(arr)) {
    const inner = ctx.schema.emitInner(arr)
    const arrVT = lookupValType(arr) || VAL.OBJECT
    const storeNumeric = keyNode => storeArrayPayload(inner, keyNode, valueExpr, ptr =>
      ['f64.store', ptrOffsetIR(asF64(emit(arr)), arrVT), ptr])
    if (useRuntimeKeyDispatch) {
      inc('__dyn_set', '__is_str_key')
      return dispatchByKeyKind(arr, keyExpr, valueExpr, storeNumeric)
    }
    return typed(storeNumeric(keyExpr), 'f64')
  }

  // 7. Known-ARRAY receiver, generic key.
  if (typeof arr === 'string' && valTypeOf(arr) === VAL.ARRAY) {
    const persist = persistBinding(arr)
    const arrExpr = asF64(emit(arr))
    if (useRuntimeKeyDispatch) {
      inc('__dyn_set', '__is_str_key')
      return dispatchByKeyKind(arr, keyExpr, valueExpr, keyNode => storeArrayPayload(arrExpr, keyNode, valueExpr, persist))
    }
    return storeArrayPayload(arrExpr, keyExpr, valueExpr, persist)
  }

  const knownArrVT = typeof arr === 'string' ? lookupValType(arr) : null
  const arrVT = knownArrVT || VAL.OBJECT

  // 7b. Known-OBJECT receiver with a non-static key. The schema-slot (step 2) and
  //     string-key (step 4) fast paths already returned, so the key here is a numeric
  //     or runtime-unknown expression. A raw indexed f64.store (steps 8–9 / the default
  //     below) would compute `ptrOffset(o) + i*8` into an allocation sized for schema
  //     slots only — silent slot corruption at small i, an out-of-bounds memory trap at
  //     large i. Route to __dyn_set (the per-OBJECT propsPtr hash sidecar), mirroring
  //     emitPropertyAssign's OBJECT dot-write path; __dyn_get reads it back. This closes
  //     the `o.prop=v` vs `o[expr]=v` asymmetry that faulted the self-host.
  if (knownArrVT === VAL.OBJECT) return dynSetCall(arr, keyExpr, valueExpr)

  // 8. Polymorphic + runtime key dispatch — key kind unknown AND receiver shape
  //    possibly TypedArray (or fully opaque). Numeric branch forks on __ptr_type.
  //    Deliberately a 2-fork (TYPED vs else) rather than reusing
  //    emitPolymorphicElementStore's 3-fork: dynamic-key dispatch only fires when
  //    receiver isn't statically ARRAY (Step 7 already caught that), so the
  //    ARRAY branch would be dead code that bloats every unknown-key write.
  if (useRuntimeKeyDispatch) {
    inc('__dyn_set', '__is_str_key')
    const hasTypedSet = !!ctx.core.stdlib['__typed_set_idx']
    if (knownArrVT == null && hasTypedSet) {
      const objTmp = temp('asu')
      const idxTmp = tempI32('asi')
      const valTmp = temp()
      inc('__ptr_type', '__typed_set_idx')
      // When arr type is unknown (could be TypedArray) and __typed_set_idx is
      // available, dispatch the numeric branch through __ptr_type so TypedArray
      // writes go by element type. Without this, ternary-typed arrays (e.g.
      // `num === 4 ? new Uint32Array(4) : new Uint8Array(16)`) would silently
      // f64.store boxed bytes regardless of element width.
      return dispatchByKeyKind(arr, keyExpr, valueExpr, keyNode => ['block', ['result', 'f64'],
        ['local.set', `$${objTmp}`, asF64(emit(arr))],
        ['local.set', `$${idxTmp}`, asI32(typed(keyNode, 'f64'))],
        ['local.set', `$${valTmp}`, valueExpr],
        ['if', ['result', 'f64'],
          ptrTypeEq(['local.get', `$${objTmp}`], PTR.TYPED),
          ['then', ['call', '$__typed_set_idx', ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]], ['local.get', `$${idxTmp}`], ['local.get', `$${valTmp}`]]],
          ['else', ['block', ['result', 'f64'],
            ['f64.store', ['i32.add', ptrOffsetIR(['local.get', `$${objTmp}`], arrVT), ['i32.shl', ['local.get', `$${idxTmp}`], ['i32.const', 3]]], ['local.get', `$${valTmp}`]],
            ['local.get', `$${valTmp}`]]]]])
    }
    const valTmp = temp()
    return dispatchByKeyKind(arr, keyExpr, valueExpr, keyNode => ['block', ['result', 'f64'],
      ['local.set', `$${valTmp}`, valueExpr],
      ['f64.store', ['i32.add', ptrOffsetIR(asF64(emit(arr)), arrVT), ['i32.shl', asI32(typed(keyNode, 'f64')), ['i32.const', 3]]], ['local.get', `$${valTmp}`]],
      ['local.get', `$${valTmp}`]])
  }

  // 9. Opaque receiver (non-string expr) or string-named with unknown VT — pure
  //    __ptr_type dispatch (no key-kind fork: key is provably numeric here).
  if (typeof arr !== 'string')
    return emitPolymorphicElementStore(emit(arr), asI32(emit(idx)), valueExpr, arrVT, null)
  if (knownArrVT == null)
    return emitPolymorphicElementStore(emit(arr), asI32(emit(idx)), valueExpr, arrVT, persistBinding(arr))

  // Default: known-VT receiver that isn't ARRAY/TYPED/OBJECT special — raw f64.store.
  return withTemp(valueExpr, t => [
    ['f64.store', ['i32.add', ptrOffsetIR(asF64(emit(arr)), arrVT), ['i32.shl', asI32(emit(idx)), ['i32.const', 3]]], ['local.get', `$${t}`]],
    ['local.get', `$${t}`]])
}

/** Property assignment: `obj.prop = val`. Strategies (first match wins):
 *    - `arr.length = N` resize (ARRAY or unknown receiver)
 *    - SRoA flat-object property
 *    - Schema-known field (with dyn shadow if needed)
 *    - OBJECT / dyn-props receiver → __dyn_set
 *    - Hoisted-but-not-declared binding (treat as dyn)
 *    - Non-string receiver expr → __dyn_set
 *    Default: __hash_set on a string-named receiver. */
export function emitPropertyAssign(obj, prop, val) {
  // arr.length = N — array resize. Intercept before the schema/object paths
  // (`length` is never a schema field). Only ARRAY (or unknown — the runtime
  // helper guards non-arrays) receivers resize; known OBJECT/Map/etc. keep
  // `.length =` as a plain property write below. The expression value is N.
  if (prop === 'length') {
    const recvVt = valTypeOf(obj)
    if (recvVt === VAL.TYPED) err(`Typed arrays are fixed-size — cannot assign to \`${typeof obj === 'string' ? obj : '<expr>'}.length\``)
    if (recvVt === VAL.ARRAY || recvVt == null) {
      inc('__arr_set_length')
      const arrTmp = `${T}aln${ctx.func.uniq++}`
      const nTmp = `${T}alv${ctx.func.uniq++}`
      ctx.func.locals.set(arrTmp, 'f64')
      ctx.func.locals.set(nTmp, 'i32')
      // Write the relocated pointer back to a simple var receiver so later
      // reads skip the forwarding hop; complex receivers stay correct via it.
      const persist = recvVt === VAL.ARRAY && typeof obj === 'string'
        ? persistBindingPtr(obj, ['local.get', `$${arrTmp}`])
        : null
      const body = [
        ['local.set', `$${arrTmp}`, asF64(emit(obj))],
        ['local.set', `$${nTmp}`, asI32(emit(val))],
        ['local.set', `$${arrTmp}`, ['call', '$__arr_set_length', ['i64.reinterpret_f64', ['local.get', `$${arrTmp}`]], ['local.get', `$${nTmp}`]]],
      ]
      if (persist) body.push(persist)
      body.push(['f64.convert_i32_s', ['local.get', `$${nTmp}`]])
      return block64(...body)
    }
  }
  // SRoA flat object: `o.prop = x` → `local.set $o#i` (no heap store).
  const flatW = typeof obj === 'string' ? ctx.func.flatObjects?.get(obj) : null
  if (flatW) {
    const fi = flatW.names.indexOf(prop)
    if (fi >= 0) return withTemp(storedValue(val), t => [
      ['local.set', `$${obj}#${fi}`, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]])
  }
  // Unboxed OBJECT-pointer receiver carrying its own schema on the value (ptrAux):
  // resolve the field slot directly, mirroring emitPropAccess (core.js). A param /
  // struct cell narrowed to an unboxed OBJECT ptr keeps its schema as `ptrAux`, not
  // in ctx.schema.vars under the name — so schema.slotOf(name) misses and the write
  // would fall to __dyn_set (propsPtr) while the READ resolves the slot via ptrAux,
  // targeting different memory (write lost). Match the read.
  {
    const vaProbe = emit(obj)
    if (vaProbe?.ptrKind === VAL.OBJECT && vaProbe.ptrAux != null) {
      const sch = ctx.schema.list[vaProbe.ptrAux]
      const si = sch ? sch.indexOf(prop) : -1
      if (si >= 0) return withTemp(storedValue(val), t => [
        ctx.abi.object.ops.store(ptrOffsetIR(asF64(emit(obj)), VAL.OBJECT), si, ['local.get', `$${t}`]),
        ['local.get', `$${t}`]])
    }
  }
  // Schema-based object → f64.store at fixed offset.
  if (typeof obj === 'string' && ctx.schema.slotOf) {
    const idx = ctx.schema.slotOf(obj, prop)
    if (idx >= 0) {
      const va = emit(obj), vv = storedValue(val), t = temp()
      const shadow = needsDynShadow(obj)
      if (shadow) inc('__dyn_set')
      const stmts = [
        ['local.set', `$${t}`, vv],
        ctx.abi.object.ops.store(ptrOffsetIR(asF64(va), lookupValType(obj) || VAL.OBJECT), idx, ['local.get', `$${t}`]),
      ]
      if (shadow)
        stmts.push(['drop', ['call', '$__dyn_set', asI64(va), asI64(emit(['str', prop])), ['i64.reinterpret_f64', ['local.get', `$${t}`]]]])
      stmts.push(['local.get', `$${t}`])
      return block64(...stmts)
    }
  }
  // Chained receiver (`a.b.c = v`): resolve the holder's static shape so the
  // write targets the SAME fixed slot the READ path uses (emitPropAccess →
  // shapeOf, core.js). Without this the write fell to __dyn_set (per-OBJECT
  // propsPtr) while `a.b.c` reads the schema slot — different memory, so the
  // value was lost (read returned the stale slot). This is what corrupted the
  // self-host `ctx.func.X = …` writes (e.g. finallyStack), dropping try/finally.
  if (typeof obj !== 'string') {
    const sh = shapeOf(obj)
    if (sh?.val === VAL.OBJECT && sh.names) {
      const i = sh.names.indexOf(prop)
      if (i >= 0) return withTemp(storedValue(val), t => [
        ctx.abi.object.ops.store(ptrOffsetIR(asF64(emit(obj)), VAL.OBJECT), i, ['local.get', `$${t}`]),
        ['local.get', `$${t}`]])
    }
  }
  if (typeof obj === 'string') {
    const objType = valTypeOf(obj)
    // OBJECT receivers (incl. JSON.parse-derived bindings) with off-schema
    // properties go through __dyn_set, which writes to the per-OBJECT
    // propsPtr at off-16 — same path as object-literal dyn shadow writes
    // (module/object.js). __hash_set assumes HASH bucket layout and would
    // corrupt OBJECT memory.
    if (usesDynProps(objType) || objType === VAL.OBJECT) {
      inc('__dyn_set')
      return typed(['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(obj)), asI64(emit(['str', prop])), asI64(storedValue(val))]], 'f64')
    }
    if (ctx.func.names.has(obj) && !isBoundName(obj)) {
      inc('__dyn_set')
      return typed(['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(obj)), asI64(emit(['str', prop])), asI64(storedValue(val))]], 'f64')
    }
    if (objType == null && ctx.transform.host !== 'wasi') {
      ctx.features.external = true
    }
    inc('__hash_set')
    // `__hash_set` returns the (possibly reallocated) HASH pointer, which must be
    // written back into `obj`. But JS `(obj.prop = v)` evaluates to `v`, not the
    // object — so capture the value and return it. This only diverges in value
    // position: postfix `o.p++` lowers to `(o.p = o.p+1) - 1`, `a = (o.p = v)`,
    // `f(o.p = v)`. Returning the pointer there computes `object - 1` → garbage
    // (the self-host regex `c.labelId++` bug). Void position discards the tail.
    const keyBits = asI64(emit(['str', prop]))
    return withTemp(storedValue(val), t => {
      const tget = ['local.get', `$${t}`]
      const setCall = typed(['f64.reinterpret_i64',
        ['call', '$__hash_set', asI64(emit(obj)), keyBits, ['i64.reinterpret_f64', tget]]], 'f64')
      const writeback = isGlobal(obj) ? ['global.set', `$${obj}`, setCall]
        // Closure-captured (boxed) locals store at the cell address, not the slot.
        : ctx.func.boxed?.has(obj) ? writeVar(obj, setCall, true)
        : ['local.set', `$${obj}`, setCall]
      return [writeback, tget]
    })
  }
  if (ctx.transform.host !== 'wasi') ctx.features.external = true
  inc('__dyn_set')
  return typed(['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(obj)), asI64(emit(['str', prop])), asI64(storedValue(val))]], 'f64')
}

