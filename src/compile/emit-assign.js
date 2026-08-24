import { OPTF } from '../ctx.js'
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

import { ctx, err, inc, warnDeopt, PTR, LAYOUT, setLinkDemand } from '../ctx.js'
import { T } from '../ast.js'
import { staticPropertyKey, staticIndexKey, staticObjectProps, inlineArraySid, structLiteralFields, inplaceKey } from '../static.js'
import { packedI32, structInline } from '../abi/index.js'
import { i64Hex, encodePtrHi } from '../../layout.js'
import { recordDynFnTableWrite, recordImperativeClosureTableWrite } from './dyn-closure-tables.js'
import { valTypeOf, shapeOf } from '../kind.js'
import { VAL, lookupValType, repOf } from '../reps.js'
import {
  typed, asF64, asI32, asI64, temp, tempI32, withTemp, block64,
  ptrOffsetIR, ptrTypeEq, boxedAddr, writeVar, isGlobal, isBoundName, isLiteralStr,
  usesDynProps, needsDynShadow, boolBoxIR, mkPtrIR, isNumericIR, undefExpr,
  freshId, boxBigInt,
} from '../ir.js'
import { emit, emitIdentitySafe, storedValue, storedValueNarrow } from '../bridge.js'
import { REP_EDGE_BOX, representationProgramHasBigint, representationStorageWriteAction } from './representation-plan.js'

// Boxed-bool-aware store value: booleans persist as their tagged atom. Now
// THE chokepoint, promoted to bridge.js (research.md §Carrier invariant) — every
// module/*.js consumer imports the same `storedValue` this file does, instead
// of hand-reimplementing the unsound `carrierF64(node, emit(node))` half.

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
  const arrTmp = `${T}asi${freshId(ctx)}`
  const idxTmp = `${T}asj${freshId(ctx)}`
  const valTmp = `${T}asv${freshId(ctx)}`
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

/** Last-resort dynamic property write through `__dyn_set`. Receiver-value contract:
 *  a HASH local dictWalkI32 proved i32-lean (ctx.func.i32HashLocals — every read
 *  bitwise-coerced, every write discarded; see analyze.js) stores its VALUES as raw
 *  i32 bits in the slot's low 32 bits, not NaN-boxed f64 — the read fast path
 *  (module/array.js's i32HashLocals arm) does a bare `i32.wrap_i64` with no
 *  unboxing. tryHashRmwFusion (emit-assign.js) honors this for `o[k]=f(o[k])`
 *  writes; a PLAIN write `o[k]=v` (no self-read, so RMW fusion declines) used to
 *  fall through here and box `v` as f64 regardless — write/read format mismatch,
 *  silently truncating every stored value to its low 32 bits reinterpreted as
 *  raw int (`o[k]=7` unreadable: __hash_get_local_h under `i32.wrap_i64` sees the
 *  f64 box's low word, 0). Every write path for an i32-lean receiver must agree
 *  with the read's raw-i32 contract, so this is the single choke point (dynSetCall
 *  is also step 7b's HASH fallback) that applies it uniformly. */
function dynSetCall(arr, keyExpr, valueExpr) {
  ensureDynSetAllowed(arr)
  inc('__dyn_set')
  if (typeof arr === 'string' && ctx.func.i32HashLocals?.has(arr)) {
    const valTmp = temp()
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${valTmp}`, valueExpr],
      ['drop', ['call', '$__dyn_set', asI64(emit(arr)), asI64(keyExpr),
        ['i64.extend_i32_u', asI32(typed(['local.get', `$${valTmp}`], 'f64'))]]],
      ['local.get', `$${valTmp}`]], 'f64')
  }
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

/** Outlined runtime element store for an opaque receiver. The helper owns the
 * ARRAY relocation, packed TypedArray width, OBJECT/HASH sidecar, and optional
 * EXTERNAL branches; keeping that fork out of a hot loop also gives the
 * Float64 unswitch one canonical call shape to eliminate. */
function emitPolymorphicElementStore(arrExpr, idxI32, valueExpr, valueDomain, persist, mayBeObject) {
  ctx.module.include('typedarray')
  setLinkDemand('typedarray')
  setLinkDemand('typedRuntime')
  const runtimeStore = mayBeObject ? '__arr_typed_obj_set_idx' : '__arr_typed_set_idx'
  if (mayBeObject) ctx.module.include('collection')
  inc(runtimeStore)
  const objTmp = temp('asu'), idxTmp = tempI32('asi'), ptrTmp = temp('asp'), valTmp = temp()
  return block64(
    ['local.set', `$${objTmp}`, asF64(arrExpr)],
    ['local.set', `$${idxTmp}`, idxI32],
    ['local.set', `$${valTmp}`, valueExpr],
    ['local.set', `$${ptrTmp}`, ['call', `$${runtimeStore}`,
      ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]],
      ['local.get', `$${idxTmp}`], ['local.get', `$${valTmp}`],
      ...(representationProgramHasBigint(ctx) ? [['i32.const', valueDomain]] : [])]],
    ...(persist ? [persist(['local.get', `$${ptrTmp}`])] : []),
    ['local.get', `$${valTmp}`])
}

/** Element assignment: `arr[idx] = val`. Linear strategy chain — first match wins.
 *  Order matters: literal-key fast paths shadow generic stores; SRoA shadow before
 *  schema; typed-array element write before generic f64.store. */
export { persistBindingPtr }

// `o[k] = f(o[k])` on a (possibly-)HASH receiver — the dictionary-counting idiom
// (histogram, wordcount, group-by). The generic lowering pays the string hash,
// probe, equality and dispatch TWICE per statement (a full dyn get plus a full
// dyn set). Fuse: __hash_slot probes ONCE (inserting `undefined` on miss — what
// the read of a missing key yields), the rhs computes against the loaded slot
// value, __slot_write stores back with the durable-heal protocol. Sound across
// growth (the receiver box never changes — forwarding header) and across memory
// growth (linear memory never moves). A non-HASH receiver at runtime returns
// slot 0 and takes the untouched generic path.
const _rmwStructEq = (a, b) => a === b ||
  (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => _rmwStructEq(x, b[i])))
// rhs allowlist: value ops only — a call could insert into the receiver (growing
// the table under the held slot address), an assignment or closure likewise.
const _rmwSafe = (n, readNode) => {
  if (!Array.isArray(n)) return true
  if (_rmwStructEq(n, readNode)) return true
  const op = n[0]
  if (op == null || op === 'str') return true
  if (op === '()' || op === '=>' || op === 'new' || typeof op !== 'string') return false
  if (op === '=' || op.endsWith('=') && op !== '==' && op !== '===' && op !== '!=' && op !== '!==' && op !== '<=' && op !== '>=') return false
  if (op === '++' || op === '--') return false
  for (let i = 1; i < n.length; i++) if (!_rmwSafe(n[i], readNode)) return false
  return true
}
function tryHashRmwFusion(arr, idx, val) {
  if (typeof arr !== 'string') return null
  // valTypeOf consults the decl-site FLOW overlay, which stamps a dictionary-
  // mode `{}` binding OBJECT (the literal node's kind) even though the
  // dictionary lowering just repped it VAL.HASH — honor the rep, else the
  // fusion never fires on exactly the bindings it exists for (`counts[w] =
  // (counts[w]|0)+1` on a computed-key dictionary).
  const at = repOf(arr)?.val === VAL.HASH ? VAL.HASH : valTypeOf(arr)
  if (at !== VAL.HASH && at != null) return null
  // A proven-string key probes directly; an unknown-typed name key takes the same
  // __is_str_key routing __dyn_set uses (numeric keys → slot 0 → generic path).
  const keyStr = (typeof idx === 'string' && valTypeOf(idx) === VAL.STRING) || isLiteralStr(idx)
  const keyUnknown = typeof idx === 'string' && valTypeOf(idx) == null
  if (!keyStr && !keyUnknown) return null
  const readNode = ['[]', arr, idx]
  let reads = 0
  const scan = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === '[]' && _rmwStructEq(n, readNode)) { reads++; return }
    for (let i = 1; i < n.length; i++) scan(n[i])
  }
  scan(val)
  if (!reads || !_rmwSafe(val, readNode)) return null
  const subst = (n) => !Array.isArray(n) ? n
    : (n[0] === '[]' && _rmwStructEq(n, readNode)) ? oldT
    : n.map((c, i) => i === 0 ? c : subst(c))
  const oT = temp('rmo'), kT = temp('rmk'), oldT = temp('rmold'), resT = temp('rmres')
  const slotT = tempI32('rms')
  const lean = ctx.func.leanHashLocals?.has(arr)
  const i32Values = lean && ctx.func.i32HashLocals?.has(arr)
  const domain = lean ? ctx.func.leanHashDomains?.get(arr) : null
  const domainLen = domain ? repOf(domain)?.arrayLen : null
  // The no-growth probe is valid only when analysis proved the source domain's
  // length immutable. A runtime `.length` preallocation hint alone is not a
  // finite-domain proof: the source array may grow while keys are inserted.
  const fixed = domainLen != null
  const slotFn = fixed ? '$__hash_slot_eph_fixed' : lean ? '$__hash_slot_eph' : '$__hash_slot'
  let capHint = 0
  if (fixed) { capHint = 2; while (capHint < domainLen * 4) capHint *= 2 }
  const slotCall = (obj, key) => ['call', slotFn, obj, key,
    ...(fixed ? [['i32.const', capHint]] : [])]
  // __dyn_set is only reachable below via the non-HASH fallback arm (line ~328);
  // a PROVEN-HASH receiver (`at === VAL.HASH`) takes the early-return probe/load/
  // store branch exclusively and never emits a `call $__dyn_set` — including it
  // anyway pulled __dyn_set's ToPropertyKey (→ __to_str → the whole Ryu formatter)
  // into every module with a proven-HASH counting idiom (`counts[w] = (counts[w]|0)+1`
  // on a dictionary-mode `{}`), even in a module that otherwise never stringifies a
  // number. STRATIFICATION lever retry (.work/todo.md): a genuine __dyn_set/
  // __dyn_get_t core-split was built, verified correct (two real dep-graph gate
  // bugs found+fixed: assemble.js's tblConsumed/__clear-reset enumerations and
  // array.js's needsArrayDynMove hardcode function names by exact string, so new
  // stratified names must be added to all three or reads/writes silently corrupt —
  // reproduced live via the JSON.parse+o[k] pin, root-caused, fixed) — but the
  // corpus-wide size sweep showed ZERO benefit anywhere (wordcount's Ryu-free state
  // predates this work, from the unrelated cross-call array-elem lattice fix) and a
  // real regression on the self-compiled watr case (+767B) from paying for the near-
  // duplicate core with no module ever shedding __to_str because of it. NOT landed;
  // this one line survives because it's independently sound on its own (zero new
  // functions, zero duplication cost, strictly more precise reachability — it can
  // only ever shrink a module, never grow one).
  inc(fixed ? '__hash_slot_eph_fixed' : lean ? '__hash_slot_eph' : '__hash_slot', ...(at === VAL.HASH ? [] : ['__dyn_set']))
  const resIR = asF64(emit(subst(val)))
  // Statically-numeric result (isNumericIR — the counting idiom's
  // `(o[k]|0)+1`): a plain number is never an ephemeral pointer, so
  // __slot_write's durable-heal barrier is provably dead — store bare and
  // skip the call + per-token __is_eph_bits test it wraps.
  const bare = isNumericIR(resIR)
  if (!bare) inc('__slot_write')
  const writeBack = bare
    ? ['i64.store', ['local.get', `$${slotT}`], ['i64.reinterpret_f64', ['local.get', `$${resT}`]]]
    : ['call', '$__slot_write', ['local.get', `$${slotT}`],
      ['i64.reinterpret_f64', ['local.get', `$${resT}`]]]
  // Proven HASH receiver: __hash_slot cannot take its non-HASH return-0 arm.
  // Normalize an unresolved key once through ToPropertyKey's string path, then
  // emit only probe→load→compute→store. This removes the enormous generic
  // __dyn_set fallback from dictionary-count loops and gives the optimizer a
  // compact hot function; the receiver's HASH fact was established before emit.
  if (at === VAL.HASH) {
    if (!keyStr) inc('__to_str')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${oT}`, asF64(emit(arr))],
      ['local.set', `$${kT}`, asF64(emit(idx))],
      ...(!keyStr ? [['if',
        ['i32.eqz', ['i32.and',
          ['f64.ne', ['local.get', `$${kT}`], ['local.get', `$${kT}`]],
          ['i64.eq',
            ['i64.and', ['i64.shr_u', ['i64.reinterpret_f64', ['local.get', `$${kT}`]],
              ['i64.const', String(LAYOUT.TAG_SHIFT)]], ['i64.const', String(LAYOUT.TAG_MASK)]],
            ['i64.const', String(PTR.STRING)]]]],
        ['then', ['local.set', `$${kT}`,
          ['f64.reinterpret_i64', ['call', '$__to_str', ['i64.reinterpret_f64', ['local.get', `$${kT}`]]]]]]]] : []),
      ['local.set', `$${slotT}`, slotCall(
        ['i64.reinterpret_f64', ['local.get', `$${oT}`]],
        ['i64.reinterpret_f64', ['local.get', `$${kT}`]])],
      ['local.set', `$${oldT}`, i32Values
        ? ['f64.convert_i32_s', ['i32.load', ['local.get', `$${slotT}`]]]
        : ['f64.load', ['local.get', `$${slotT}`]]],
      ['local.set', `$${resT}`, resIR],
      i32Values
        ? ['i32.store', ['local.get', `$${slotT}`], asI32(typed(['local.get', `$${resT}`], 'f64'))]
        : writeBack,
      ['local.get', `$${resT}`]], 'f64')
  }
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${oT}`, asF64(emit(arr))],
    ['local.set', `$${kT}`, asF64(emit(idx))],
    // Unknown-typed key: the same __is_str_key routing __dyn_set uses, but
    // inline — `f64.ne(k,k)` (only NaN patterns carry pointers) AND tag ==
    // STRING is 6 ops against a per-token call in the counting idiom's loop.
    ['local.set', `$${slotT}`, keyStr
      ? slotCall(
        ['i64.reinterpret_f64', ['local.get', `$${oT}`]],
        ['i64.reinterpret_f64', ['local.get', `$${kT}`]])
      : ['if', ['result', 'i32'],
        ['i32.and',
          ['f64.ne', ['local.get', `$${kT}`], ['local.get', `$${kT}`]],
          ['i64.eq',
            ['i64.and', ['i64.shr_u', ['i64.reinterpret_f64', ['local.get', `$${kT}`]],
              ['i64.const', String(LAYOUT.TAG_SHIFT)]], ['i64.const', String(LAYOUT.TAG_MASK)]],
            ['i64.const', String(PTR.STRING)]]],
        ['then', slotCall(
          ['i64.reinterpret_f64', ['local.get', `$${oT}`]],
          ['i64.reinterpret_f64', ['local.get', `$${kT}`]])],
        ['else', ['i32.const', 0]]]],
    ['if', ['result', 'f64'], ['i32.eqz', ['local.get', `$${slotT}`]],
      // non-HASH receiver: the generic dynamic write of the ORIGINAL rhs (its
      // reads re-emit as ordinary dyn gets on the same pure receiver/key)
      ['then', ['f64.reinterpret_i64', ['call', '$__dyn_set',
        ['i64.reinterpret_f64', ['local.get', `$${oT}`]],
        ['i64.reinterpret_f64', ['local.get', `$${kT}`]],
        asI64(emit(val))]]],
      ['else', typed(['block', ['result', 'f64'],
        ['local.set', `$${oldT}`, ['f64.load', ['local.get', `$${slotT}`]]],
        ['local.set', `$${resT}`, resIR],
        writeBack,
        ['local.get', `$${resT}`]], 'f64')]]], 'f64')
}

/** In-place replace-store: `arr[i] = {lit}` at a site the whole-program alias
 *  sweep proved safe (src/compile/inplace-store.js) overwrites the OLD
 *  element's payload slots instead of allocating a fresh object — the
 *  immutable-update idiom's per-step allocation churn goes to zero. Runtime
 *  guard: the old element's box must carry OBJECT tag + this literal's
 *  schemaId (one masked i64 compare — the emitSchemaSlotGuarded pattern);
 *  anything else (UNDEF from an out-of-bounds read, an alien schema, a
 *  non-object) takes the generic fresh-alloc arm, so semantics stay bit-exact.
 *  Literal values spill to temps FIRST — they may read the old element
 *  (`arr[i] = { x: p.y, y: p.x }` swaps). Fast-arm result is the old box:
 *  in place, the old object IS the new object (the array store is elided). */
function tryInplaceReplaceStore(arr, idx, val) {
  if (!Array.isArray(val) || val[0] !== '{}' || typeof arr !== 'string') return null
  // content key — see scanInplaceStores: node identity doesn't survive the
  // per-function body transforms between the sweep and emit
  const key = inplaceKey(arr, val)
  const entry = ctx.schema.inplaceStores?.get(key)
  if (!entry) return null
  if (valTypeOf(arr) !== VAL.ARRAY) return null
  const idxNumeric = (typeof idx === 'string' &&
    (repOf(idx)?.intCertain === true || repOf(idx)?.val === VAL.NUMBER)) || valTypeOf(idx) === VAL.NUMBER
  if (!idxNumeric) return null
  const parsed = staticObjectProps(val.slice(1))
  if (!parsed || !parsed.values.every(v => valTypeOf(v) === VAL.NUMBER)) return null
  const sid = ctx.schema.register(parsed.names)
  const schema = ctx.schema.list?.[sid]
  const ops = ctx.abi.object?.ops
  if (!schema || !ops) return null
  // Target-binding reuse (sweep-proven): the tracked alias `const p = arr[i]`
  // IS the current element — skip the `__arr_idx` re-read (forwarding follow +
  // bounds check per store) and guard/overwrite through the binding directly.
  const aliasOk = entry.alias && typeof idx === 'string' && idx === entry.idx
    && !ctx.func.boxed?.has(entry.alias)
  const aliasType = aliasOk ? ctx.func.locals.get(entry.alias) : null
  const vTs = parsed.values.map(() => temp('ipv'))
  const slots = parsed.names.map(nm => schema.indexOf(nm))
  // Strongest form: unboxablePtrs already narrowed the alias to a raw OBJECT
  // pointer of THIS schema — the runtime guard is statically discharged, the
  // whole store is bare slot overwrites (the immutable-update idiom's floor:
  // spill values, N stores, done).
  if (aliasType === 'i32' && repOf(entry.alias)?.ptrKind === VAL.OBJECT
      && (ctx.schema.vars.get(entry.alias) ?? repOf(entry.alias)?.schemaId) === sid) {
    return typed(['block', ['result', 'f64'],
      ...parsed.values.map((v, i) => ['local.set', `$${vTs[i]}`, storedValue(v)]),
      ...slots.map((slot, i) => ops.store(['local.get', `$${entry.alias}`], slot, ['local.get', `$${vTs[i]}`])),
      mkPtrIR(PTR.OBJECT, sid, ['local.get', `$${entry.alias}`])], 'f64')
  }
  const reuse = aliasOk && aliasType === 'f64' ? ['local.get', `$${entry.alias}`] : null
  inc('__alloc_hdr')
  if (!reuse) inc('__arr_idx')
  const kT = tempI32('ipk'), eT = temp('ipe'), oT = tempI32('ipo'), hT = tempI32('iph'), aTb = temp('ipa')
  const bitsE = () => ['i64.reinterpret_f64', ['local.get', `$${eT}`]]
  const fast = ['block', ['result', 'f64'],
    ['local.set', `$${oT}`, ['i32.wrap_i64', bitsE()]],
    ...slots.map((slot, i) => ops.store(['local.get', `$${oT}`], slot, ['local.get', `$${vTs[i]}`])),
    ['local.get', `$${eT}`]]
  const slow = ['block', ['result', 'f64'],
    ['local.set', `$${hT}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ops.allocSlots(schema.length)]]],
    ...slots.map((slot, i) => ops.store(['local.get', `$${hT}`], slot, ['local.get', `$${vTs[i]}`])),
    storeArrayPayload(typed(['local.get', `$${aTb}`], 'f64'), ['f64.convert_i32_s', ['local.get', `$${kT}`]],
      mkPtrIR(PTR.OBJECT, sid, ['local.get', `$${hT}`]), persistBinding(arr))]
  // JS member-store order: GetValue(base), then the property key, then the RHS
  // values — `a[i++] = {x: i}`'s x must see the incremented i while the store
  // still lands at the old index (caught by a differential probe; the values-
  // first order shipped that divergence at every optimize level).
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${aTb}`, asF64(emit(arr))],
    ['local.set', `$${kT}`, asI32(emit(idx))],
    ...parsed.values.map((v, i) => ['local.set', `$${vTs[i]}`, storedValue(v)]),
    ['local.set', `$${eT}`, reuse ?? ['call', '$__arr_idx', ['i64.reinterpret_f64', ['local.get', `$${aTb}`]], ['local.get', `$${kT}`]]],
    ['if', ['result', 'f64'],
      ['i64.eq',
        ['i64.and', bitsE(), ['i64.const', '0xFFFFFFFF00000000']],
        ['i64.const', i64Hex(BigInt(encodePtrHi(PTR.OBJECT, sid)) << 32n)]],
      ['then', fast],
      ['else', slow]]], 'f64')
}

/** structInline Array<S> wholesale element replace `a[i] = {S-literal}` — K
 *  f64 cell stores into the element's inline cells: no allocation, no box
 *  read, no identity guard (cells cannot hold aliens — the layout is fixed by
 *  analyzeStructInline's whole-program proof, which accepted this store via
 *  the inplace sweep's alias-liveness + reuse verdicts).
 *
 *  Evaluation order (JS: member target before RHS): the index and — on the
 *  non-cursor path — the receiver box spill FIRST, then the slot values (they
 *  may read the old element's fields: `a[i] = {x: p.y, y: p.x}` swaps).
 *
 *  Bounds: one `cellIdx < physLen` u-compare. In-bounds → K stores; anything
 *  else — i ≥ length (JS: array-extend) or a negative int-certain index
 *  (JS: sidecar property) — DROPS the write, the same contract as the
 *  checked-by-default typed store (OOB writes ignored). By then JS itself
 *  would have thrown at the cursor's `p.x` projection (undefined.x), which
 *  the carrier's unchecked cursor read already deviates on; the analyzer only
 *  accepts stores preceded by a same-index cursor read (reuse verdict), so
 *  append-idiom builders (`out[out.length] = {…}`) stay on the plain layout.
 *  No grow call exists in the arm, so loop-invariant base hoists stay sound.
 *
 *  Address: with the sweep's target-binding reuse, the cursor IS the cell
 *  address — base derives as `cursor − cellIdx*8` (pure arith); otherwise via
 *  __ptr_offset on the spilled box. */
function tryStructInlineReplaceStore(arr, idx, val) {
  if (typeof arr !== 'string') return null
  const sid = inlineArraySid(arr)
  if (sid == null) return null
  const schema = ctx.schema.list[sid]
  const fields = structLiteralFields(val, sid)
  // analyzeStructInline accepted every store site for this sid — a shape this
  // arm cannot lower here means the phases disagree; never fall through to a
  // boxed store on cell memory.
  if (!fields) err(`structInline replace-store expects { ${schema.join(', ')} } literal`)
  const void_ = ctx.func._expect === 'void'
  const K = schema.length
  const packed = ctx.schema.inlineCellI32?.has(sid)
  const cpe = structInline(K, packed).cpe   // physical 8-byte cells per element
  const ops = packed ? packedI32.ops : ctx.abi.object.ops
  const entry = ctx.schema.inplaceStores?.get(inplaceKey(arr, val))
  // Cursor reuse under the same conditions as tryInplaceReplaceStore's
  // strongest form: the tracked alias is an unboxed i32 OBJECT pointer of this
  // schema reading the same index — for the inline carrier that IS the cell
  // address (array.js '[]' structInline arm).
  const alias = entry?.alias && typeof idx === 'string' && idx === entry.idx &&
    !ctx.func.boxed?.has(entry.alias) && ctx.func.locals.get(entry.alias) === 'i32' &&
    repOf(entry.alias)?.ptrKind === VAL.OBJECT &&
    (ctx.schema.vars.get(entry.alias) ?? repOf(entry.alias)?.schemaId) === sid
    ? entry.alias : null
  const kT = tempI32('sik'), cT = tempI32('sic'), bT = tempI32('sib'), aT = tempI32('sia')
  const vTs = fields.map(() => packed ? tempI32('siv') : temp('siv'))
  const boxT = alias ? null : temp('sit')
  if (!alias) inc('__ptr_offset')
  const cellIdx = cpe === 1 ? ['local.get', `$${kT}`] : ['i32.mul', ['local.get', `$${kT}`], ['i32.const', cpe]]
  const body = [
    ['local.set', `$${kT}`, asI32(emit(idx))],
    ...(boxT ? [['local.set', `$${boxT}`, asF64(emit(arr))]] : []),
    // packed values are int32-exact by the slotI32Certain census. Non-packed
    // cells: CARRIER PROGRAM §15/§16 — the same per-schema slotBigintBoxedBySid
    // fact the other three write sites use (module/object.js construction/
    // spread, this function's own dot-assign branches), not an unconditional
    // storedValue. structInline element writes have their OWN dedicated read
    // arm (emitSchemaSlotRead, module/core.js, reached via the `.cellI32`/
    // ptrAux-tagged cursor path in emitPropAccess) — pairing this write with
    // that SAME fact is what makes the read side's unconditional unbox sound
    // for an inline-array element exactly as it is for a standalone `{S}`
    // object of the same schema (structInline's own analysis note: standalone
    // objects of a structInline-eligible schema are independent and can
    // coexist). No-op under CARRIER_BOX=off (byte-identical either way).
    ...fields.map((v, i) => ['local.set', `$${vTs[i]}`, packed ? asI32(emit(v))
      : (ctx.schema.slotBigintBoxedBySid?.(sid, schema[i]) ? storedValue : storedValueNarrow)(v)]),
    ['local.set', `$${cT}`, cellIdx],
    ['local.set', `$${bT}`, alias
      ? ['i32.sub', ['local.get', `$${alias}`], ['i32.shl', ['local.get', `$${cT}`], ['i32.const', 3]]]
      : ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${boxT}`]]]],
  ]
  const inBounds = ['i32.lt_u', ['local.get', `$${cT}`],
    ['i32.load', ['i32.sub', ['local.get', `$${bT}`], ['i32.const', 8]]]]
  const stores = [
    ['local.set', `$${aT}`, ['i32.add', ['local.get', `$${bT}`], ['i32.shl', ['local.get', `$${cT}`], ['i32.const', 3]]]],
    ...fields.map((v, i) => ops.store(['local.get', `$${aT}`], i, ['local.get', `$${vTs[i]}`])),
  ]
  if (void_) return typed(['block', ...body, ['if', inBounds, ['then', ...stores]]], 'void')
  // Value position is analyzer-poisoned (sweep candidates are statement-only);
  // belt for exotic statement shapes: yield the element as a boxed pointer —
  // under the inline carrier the cell address IS the object identity. A
  // PACKED cell address cannot be boxed (slot reads through a box assume f64
  // cells), so the phases disagreeing there is a compile error, not bytes.
  if (packed) err('structInline packed replace-store in value position — analyzeStructInline must poison this shape')
  return typed(['block', ['result', 'f64'], ...body,
    ['if', ['result', 'f64'], inBounds,
      ['then', ...stores, mkPtrIR(PTR.OBJECT, sid, ['local.get', `$${aT}`])],
      ['else', undefExpr()]]], 'f64')
}

export function emitElementAssign(arr, idx, val) {
  // 0. `obj.prop[idx] = val` where `obj`'s type is fully unknown (so `obj`
  // could be a host EXTERNAL object at runtime) — `__ext_prop` (interop.js)
  // always re-marshals a FRESH, disconnected copy of a container-valued
  // property (`wrapVal` deep-copies an array into fresh wasm memory, no
  // identity preserved with the host), so an index-write through THAT read —
  // whichever branch below performs it — mutates a copy nobody keeps; the
  // host object's own property is never touched, and a later read starts
  // over from the original, unmutated value. Recurse first with `arr`
  // replaced by a temp holding the (already-read) property value: every
  // existing branch (ARRAY/TYPED/HASH/OBJECT/polymorphic) applies to it
  // unchanged, including array-grow relocation (persistBinding keeps the temp
  // current). Then write the (possibly-relocated) mutated container back onto
  // the SAME property via `__hash_set` — the same general dynamic-property-set
  // primitive a plain `obj.prop = val` on an unknown-type receiver already
  // uses below, whose own type guard (genUpsertGrow, module/collection.js)
  // dispatches HASH natively, EXTERNAL to `__ext_set`, anything else to
  // `__dyn_set` — so a genuinely native (non-external) receiver, whose
  // property read already returned the live pointer with nothing to write
  // back, just re-stores the same pointer (idempotent). `mem.read` (interop.js)
  // already recursively decodes an ARRAY pointer back to a real JS array on
  // the host side, so this round-trips correctly, including one level of
  // array-of-arrays nesting.
  if (Array.isArray(arr) && arr[0] === '.' && typeof arr[2] === 'string' && valTypeOf(arr[1]) == null) {
    const [, obj, prop] = arr
    const objTmp = temp('eao'), arrTmp = temp('eaf'), resultTmp = temp('ear')
    ctx.func.locals.set(objTmp, 'f64')
    ctx.func.locals.set(arrTmp, 'f64')
    ctx.func.locals.set(resultTmp, 'f64')
    if (ctx.transform.targetProfile.envImports) setLinkDemand('external')
    inc('__hash_set')
    const storeIR = emitElementAssign(arrTmp, idx, val)
    return block64(
      ['local.set', `$${objTmp}`, asF64(emit(obj))],
      ['local.set', `$${arrTmp}`, asF64(emit(['.', objTmp, prop]))],
      ['local.set', `$${resultTmp}`, storeIR],
      ['drop', ['call', '$__hash_set',
        ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]],
        asI64(emit(['str', prop])),
        ['i64.reinterpret_f64', ['local.get', `$${arrTmp}`]]]],
      ['local.get', `$${resultTmp}`])
  }
  // structInline receivers first: once analyzeStructInline committed the sid
  // to the inline-cell layout, a boxed store (generic/inplace paths below)
  // would corrupt cell memory — this arm is the only sound lowering.
  const sIn = tryStructInlineReplaceStore(arr, idx, val)
  if (sIn) return sIn
  const rmw = (ctx.transform.optFlags & OPTF.hashRmwFusion) ? tryHashRmwFusion(arr, idx, val) : null
  if (rmw) return rmw
  const inplace = (ctx.transform.optFlags & OPTF.inplaceStore) ? tryInplaceReplaceStore(arr, idx, val) : null
  if (inplace) return inplace
  // SRoA flat object/array: `o['k'] = x` / `a[2] = x` → `local.set $o#i` (no
  // heap store). Checked EARLY, before keyExpr/valueExpr below, so `val`
  // emits exactly once through storedValueNarrow — NOT the generic
  // storedValue every other branch shares: see carrierF64Narrow's own doc
  // comment (ir.js) for why an unconditional inline-BIGINT box is wrong for a
  // flat field (reads/writes are all rewritten to plain local access, no
  // registry-aware dynamic reader ever downstream of it). Key resolution
  // mirrors the original `litKey ?? staticIndexKey(idx)` fallback chain
  // exactly (a literal string key, else a static property key for an
  // OBJECT-typed receiver, else a bare integer index) — `litKey` itself is
  // computed further below only for the OTHER (non-flat) branches.
  if (typeof arr === 'string' && ctx.func.flatObjects?.has(arr)) {
    const fo = ctx.func.flatObjects.get(arr)
    const flatLitKey = isLiteralStr(idx) ? idx[1] : lookupValType(arr) === VAL.OBJECT ? staticPropertyKey(idx) : null
    const flatKey = flatLitKey != null ? flatLitKey : staticIndexKey(idx)
    const fi = flatKey != null ? fo.names.indexOf(flatKey) : -1
    if (fi >= 0) return withTemp(storedValueNarrow(val), t => [
      ['local.set', `$${arr}#${fi}`, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]])
  }
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
  // storedValue (not asF64(emit(idx))): the universal computed-key emit site
  // feeding $__dyn_set — an 18th unswept MECHANISM A site (.work/todo.md
  // §deletion-sweep). storedValue already returns f64-typed IR in every
  // branch, so no asF64 wrap is needed; the non-ambiguous fallback
  // (carrierF64) is byte-identical to the asF64(emit(idx)) call it replaces.
  const keyExpr = storedValue(idx)
  // Boxed-bool-aware: `o[k] = false` through every receiver path (slot, SRoA,
  // array payload, __dyn_set) keeps boolean identity. The one representation-
  // sensitive consumer is the typed-array route — __typed_set_idx ToNumbers
  // NaN-boxed values (spec ToNumber for typed element writes), so a boxed
  // bool stores 0/1 there, never raw atom bits.
  //
  // storedValueNarrow, NOT storedValue, when `arr` is a KNOWN ARRAY whose
  // OWN element type is independently proven uniformly VAL.BIGINT
  // (repOf(arr)?.arrayElemValType — the array-elem census analyze.js already
  // maintains for `arr[i]`'s own read-side elision, kind.js valTypeOf):
  // every consumer of THIS array's elements (this write's own later reads,
  // arithmetic, iteration) already takes the STATIC bigint path BECAUSE the
  // census proves it — module/array.js's numeric-index read is a bare
  // f64.load, never routed through a registry-aware $__dyn_get/$__typeof
  // dispatch, so a box written here has no reader that would ever unbox it
  // (see carrierF64Narrow's own doc comment, ir.js, for the established
  // pattern this mirrors — found live: `let a = [4611686018427387903n];
  // a[0]++` boxed the literal on write, then `a[0]++`'s own bigIntOperand
  // arithmetic read the pointer's bits raw). Only steps 3/7 below (a
  // known-ARRAY receiver) can ever read `arrayElemValType` — every OTHER
  // branch (schema/hash/typed/polymorphic) leaves `arr` unproven or not an
  // ARRAY at all, so this condition is false there and behavior is
  // unchanged: still the full storedValue box for a genuinely mixed/unproven
  // element type, where a later dynamic reader may still need to tell a raw
  // number from a boxed bigint apart.
  const arrProvenBigintElems = typeof arr === 'string' && valTypeOf(arr) === VAL.ARRAY &&
    repOf(arr)?.arrayElemValType === VAL.BIGINT
  // BigInt retirement Slice 1 (.work/bigint-retirement-design.md §4): a
  // PROVEN TYPED receiver (BigInt64Array/BigUint64Array, `lookupValType(arr)
  // === 'typed'`, mirroring branch 5's own proven-ctor check below) is the
  // design's own explicit exemption — "each element's kind is fixed by the
  // array's ctor at every read... needs no boxing today and needs none
  // after retirement either." `valueExpr` is computed here, BEFORE branch 5
  // decides whether it even needs it (its own fast path — ctx.core.emit
  // ['.typed:[]='] — re-emits `val` independently and never reads
  // `valueExpr` at all) — so an unconditional `storedValue` here would
  // refuse to compile `arr[0] = BigInt(x)` for a freshly-constructed,
  // statically-known BigInt64Array even though nothing ambiguous is
  // happening. `storedValueNarrow` is the same safe default
  // arrProvenBigintElems already established: never fires for an inline
  // expression, only for a bare name independently proven boxed elsewhere.
  const arrProvenTyped = typeof arr === 'string' && lookupValType(arr) === 'typed' &&
    ctx.func.typedElem?.has(arr)
  const valueExpr = (arrProvenBigintElems || arrProvenTyped) ? storedValueNarrow(val) : storedValue(val)
  // A runtime-typed destination needs a self-describing value. A definite
  // BigInt source may lawfully stay raw under its ordinary RepresentationPlan
  // edge, so materialize the PTR.BIGINT tag specifically for the polymorphic
  // typed writer. Mixed sources already arrive tagged through storedValue.
  const valueVT = valTypeOf(val)
  const valueDomain = valueVT === VAL.BIGINT ? 1 : valueVT != null ? 0 : -1
  const taggedValueExpr = () => valueVT === VAL.BIGINT &&
      representationStorageWriteAction(ctx, val) !== REP_EDGE_BOX
    ? boxBigInt(asI64(valueExpr)) : valueExpr
  const runtimeTypedValueExpr = () => representationProgramHasBigint(ctx) ? taggedValueExpr() : valueExpr
  // dyn-closure-tables.js: `arr[idx] = val` into a proven-safe candidate closure
  // table — record this write's provenance (direct closure literal, or a call
  // to a function resolveDynFnTables can later prove is a closure factory) for
  // the program-wide same-body devirt proof. A no-op for every other array.
  if (typeof arr === 'string' && ctx.scope.dynFnTableCandidates?.has(arr))
    recordDynFnTableWrite(arr, val, valueExpr)
  // Closure-TABLE call-site PARAM lattice, IMPERATIVE-CONSTRUCTION class
  // (dyn-closure-tables.js scanImperativeClosureTableLatticeCandidates):
  // this write's emitted value IS the member resolveClosureTableParamLattice
  // merges call-site evidence into.
  if (typeof arr === 'string' && ctx.scope.imperativeClosureTableLatticeCandidates?.has(arr))
    recordImperativeClosureTableWrite(arr, valueExpr)
  // Literal string key, or schema-known object receiver with a static key expression.
  const litKey = isLiteralStr(idx) ? idx[1]
    : typeof arr === 'string' && lookupValType(arr) === VAL.OBJECT ? staticPropertyKey(idx)
    : null

  // 1. SRoA flat object/array — moved above (before keyExpr/valueExpr) so
  // `val` emits once through storedValueNarrow instead of the shared
  // storedValue; see that early check's own comment.
  // 2. Schema field literal key → direct payload-slot write.
  // SHADOW CONTRACT (same as the dot-path arms): when the module may read this
  // object dynamically, the mint seeded a props sidecar that __dyn_get probes
  // BEFORE the schema slots — a slot-only write here is masked by the stale
  // seed (this dropped `it['@@iterator'] = fn` for prehashed dot reads).
  if (litKey != null && typeof arr === 'string' && ctx.schema.slotOf) {
    const slot = ctx.schema.slotOf(arr, litKey)
    if (slot >= 0) {
      // sid (dyn-reach slice): resolved fresh here (slotOf's own structural
      // fallback can succeed with no precise idOf — needsDynShadow then fails
      // closed on the null sid, matching the pre-slice behavior exactly).
      const sid = ctx.schema.idOf(arr)
      const shadow = needsDynShadow(arr, sid)
      if (shadow) inc('__dyn_set')
      return withTemp(valueExpr, t => [
        ctx.abi.object.ops.store(ptrOffsetIR(asF64(emit(arr)), lookupValType(arr) || VAL.OBJECT), slot, ['local.get', `$${t}`]),
        ...(shadow ? [['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', asF64(emit(arr))], asI64(emit(['str', litKey])), ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]] : []),
        ['local.get', `$${t}`]])
    }
  }
  // 3. Known-ARRAY receiver + literal numeric key → __arr_set_idx_ptr.
  const arrIndex = litKey != null ? arrayIndexKey(litKey) : null
  if (arrIndex != null && typeof arr === 'string' && valTypeOf(arr) === VAL.ARRAY)
    return storeArrayPayload(asF64(emit(arr)), typed(['f64.const', arrIndex], 'f64'), valueExpr, persistBinding(arr))

  // 4. Known-STRING key → __dyn_set (after schema/SRoA literal-key paths).
  if (keyType === VAL.STRING) return dynSetCall(arr, keyExpr, valueExpr)

  // 5. Typed-array receiver → __typed_set_idx (or per-ctor element write).
  //    Also fires for a nested `arr[c]` receiver whose array's elements are typed
  //    arrays of a known ctor (codec `ch[c][i] = …` channelData scatter) — the
  //    `.typed:[]=` emitter resolves the element ctor and inlines the store.
  const nestedElemTypedCtor = Array.isArray(arr) && arr[0] === '[]' && arr.length === 3 &&
    typeof arr[1] === 'string' ? repOf(arr[1])?.arrayElemTypedCtor : null
  if (ctx.core.emit['.typed:[]='] &&
      ((typeof arr === 'string' && lookupValType(arr) === 'typed') || nestedElemTypedCtor)) {
    const r = ctx.core.emit['.typed:[]=']?.(arr, idx, val, void_)
    if (r) return r
    // Element ctor unknown — runtime aux-byte dispatch over the generic tagged
    // value channel. Numeric and BigInt destinations validate/coerce without
    // guessing from raw payload magnitude.
    const runtimeSet = representationProgramHasBigint(ctx) ? '__typed_set_idx_tagged' : '__typed_set_idx'
    inc(runtimeSet)
    return typed(['call', `$${runtimeSet}`,
      asI64(emit(arr)), asI32(emit(idx)), runtimeTypedValueExpr(),
      ...(runtimeSet === '__typed_set_idx_tagged' ? [['i32.const', valueDomain]] : [])], 'f64')
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
  //     the `o.prop=v` vs `o[expr]=v` asymmetry that faulted the self-compile.
  //     A known-HASH receiver (dictionary-mode `{}`) is the same class: a raw
  //     indexed store would scribble into probe-table slots — ToPropertyKey says
  //     o[97] addresses the '97' string slot. __dyn_set stringifies and probes.
  if (knownArrVT === VAL.OBJECT || knownArrVT === VAL.HASH) return dynSetCall(arr, keyExpr, valueExpr)

  // A receiver "may be an OBJECT/HASH at runtime" unless the analyzer has proven it
  // is an indexable array/typed candidate (`rep.notString`, set by infer.js for
  // bindings used as `x[i]` array/typed receivers — e.g. a Float64Array param `buf`).
  // Those keep the lean raw-store path and never drag in __dyn_set / __i32_to_str
  // (which carry their own rehash/itoa loops — a real size + hot-loop-ratchet cost).
  // Everything else (an object-literal local `let o = {}` — the Root A′ case — or a
  // fully-opaque expression) gets the OBJECT-safe fork that routes to the propsPtr
  // sidecar instead of an out-of-bounds raw f64.store.
  const mayBeObject = typeof arr !== 'string' || repOf(arr)?.notString !== true

  // 8. Polymorphic + runtime key dispatch — key kind unknown, receiver shape
  //    unproven. "Not statically ARRAY" (Step 7 already caught the PROVEN
  //    case: a named local whose VAL is known ARRAY) is NOT "never ARRAY at
  //    runtime" — an opaque/property-chain receiver (`o.inner.arr[k] = v`,
  //    no locally-typed ARRAY binding for Step 7 to catch) routinely IS an
  //    ARRAY pointer at runtime. This used to hand-roll a TYPED-only 2-fork
  //    (ARRAY never checked) that silently raw-stored ARRAY receivers here —
  //    skipping __arr_grow and the length-header bump __arr_set_idx_ptr does,
  //    so `arr[arr.length] = x` on any receiver Step 7 couldn't statically
  //    prove ARRAY corrupted the array instead of growing it (write landed,
  //    `.length` never moved — the array read back unchanged/empty forever).
  //    Reuses emitPolymorphicElementStore's full ARRAY/TYPED/OBJECT-HASH/raw
  //    fork instead, closing the gap at its root: one dispatch, no receiver
  //    shape special-cased out of the ARRAY check again by omission.
  if (useRuntimeKeyDispatch) {
    inc('__dyn_set', '__is_str_key')
    const persist = typeof arr === 'string' ? persistBinding(arr) : null
    return dispatchByKeyKind(arr, keyExpr, valueExpr, keyNode =>
      emitPolymorphicElementStore(emit(arr), asI32(typed(keyNode, 'f64')), runtimeTypedValueExpr(), valueDomain, persist, mayBeObject))
  }

  // 9. Opaque receiver (non-string expr) or string-named with unknown VT — pure
  //    __ptr_type dispatch (no key-kind fork: key is provably numeric here).
  if (typeof arr !== 'string')
    return emitPolymorphicElementStore(emit(arr), asI32(emit(idx)), runtimeTypedValueExpr(), valueDomain, null, mayBeObject)
  if (knownArrVT == null)
    return emitPolymorphicElementStore(emit(arr), asI32(emit(idx)), runtimeTypedValueExpr(), valueDomain, persistBinding(arr), mayBeObject)

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
    if (recvVt === VAL.TYPED) err(`Typed arrays are fixed-size — cannot assign to \`${typeof obj === 'string' ? obj : '<expr>'}.length\` — allocate a new typed array of the desired length instead`)
    if (recvVt === VAL.ARRAY || recvVt == null) {
      inc('__arr_set_length')
      const arrTmp = `${T}aln${freshId(ctx)}`
      const nTmp = `${T}alv${freshId(ctx)}`
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
  // storedValueNarrow, NOT storedValue: see carrierF64Narrow's own doc
  // comment (ir.js) — a flat field's reads/writes are all rewritten to plain
  // local access, no registry-aware dynamic reader ever downstream of it.
  const flatW = typeof obj === 'string' ? ctx.func.flatObjects?.get(obj) : null
  if (flatW) {
    const fi = flatW.names.indexOf(prop)
    if (fi >= 0) return withTemp(storedValueNarrow(val), t => [
      ['local.set', `$${obj}#${fi}`, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]])
  }
  // Unboxed OBJECT-pointer receiver carrying its own schema on the value (ptrAux):
  // resolve the field slot directly, mirroring emitPropAccess (core.js). A param /
  // struct cell narrowed to an unboxed OBJECT ptr keeps its schema as `ptrAux`, not
  // in ctx.schema.vars under the name — so schema.slotOf(name) misses and the write
  // would fall to __dyn_set (propsPtr) while the READ resolves the slot via ptrAux,
  // targeting different memory (write lost). Match the read.
  // SHADOW CONTRACT: when the module may read this object dynamically
  // (needsDynShadow), the literal mint seeded a props sidecar with each schema
  // key's INITIAL value, and __dyn_get probes that sidecar BEFORE the schema
  // slots — so a slot-only write here is invisible to dyn reads (the stale
  // sidecar copy masks it; this silently dropped `p.then = closure` in the
  // async runtime whenever any `x[expr]` appeared in the module). Mirror into
  // __dyn_set exactly like the named-receiver schema arm below.
  {
    const vaProbe = emit(obj)
    if (vaProbe?.ptrKind === VAL.OBJECT && vaProbe.ptrAux != null) {
      const sch = ctx.schema.list[vaProbe.ptrAux]
      const si = sch ? sch.indexOf(prop) : -1
      if (si >= 0) {
        // vaProbe.ptrAux (dyn-reach slice) IS this receiver's sid directly —
        // it is indexed into ctx.schema.list just above.
        const shadow = needsDynShadow(typeof obj === 'string' ? obj : null, vaProbe.ptrAux)
        if (shadow) inc('__dyn_set')
        // Packed i32 cells (structInline cursor, `.cellI32` node tag): the
        // field is a raw i32 at +si*4 — i32.store, no f64 boxing. The store
        // value is int32-exact by the slotI32Certain census (packing
        // precondition); the expression result converts back at one op.
        if (vaProbe.cellI32) {
          const t = tempI32('pcw')
          return block64(
            ['local.set', `$${t}`, asI32(emit(val))],
            packedI32.ops.store(ptrOffsetIR(vaProbe, VAL.OBJECT), si, ['local.get', `$${t}`]),
            ...(shadow ? [['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', asF64(emit(obj))], asI64(emit(['str', prop])), ['i64.reinterpret_f64', ['f64.convert_i32_s', ['local.get', `$${t}`]]]]]] : []),
            ['f64.convert_i32_s', ['local.get', `$${t}`]])
        }
        // storedValueNarrow when NOT shadowed: no __dyn_set mirror means no
        // registry-aware reader ever observes this slot — see
        // carrierF64Narrow's own doc comment (ir.js). Shadowed keeps the full
        // storedValue box: $__dyn_get DOES read this value dynamically then.
        //
        // CARRIER PROGRAM §15/§16: the BIGINT-boxing half of that choice
        // derives from the per-schema slotBigintBoxedBySid fact instead of
        // this write's own raw `shadow` (module/object.js's construction
        // comment has the full granularity rationale) — `shadow` itself is
        // untouched, still governs the __dyn_set mirror install below.
        // No-op under CARRIER_BOX=off (storedValue/storedValueNarrow are
        // byte-identical then).
        const boxed = ctx.schema.slotBigintBoxedBySid?.(vaProbe.ptrAux, prop)
        return withTemp(boxed ? storedValue(val) : storedValueNarrow(val), t => [
          ctx.abi.object.ops.store(ptrOffsetIR(asF64(emit(obj)), VAL.OBJECT), si, ['local.get', `$${t}`]),
          ...(shadow ? [['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', asF64(emit(obj))], asI64(emit(['str', prop])), ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]] : []),
          ['local.get', `$${t}`]])
      }
    }
  }
  // Schema-based object → f64.store at fixed offset.
  if (typeof obj === 'string' && ctx.schema.slotOf) {
    const idx = ctx.schema.slotOf(obj, prop)
    if (idx >= 0) {
      // sid (dyn-reach slice + CARRIER PROGRAM §15/§16): hoisted ABOVE shadow —
      // both the shadow decision and the BIGINT-boxing decision below need the
      // SAME sid, and both must fail closed together when `ctx.schema.slotOf`
      // resolves `idx` via its structural fallback with no precise idOf (a
      // poisoned/ambiguous binding): needsDynShadow(obj, null) itself then
      // falls back to the raw anyDynKey/dynKeyVars answer exactly as before
      // (the pre-slice behavior), and the boxed decision below falls back to
      // that same `shadow` value in that case too — one sid, one fallback.
      const sid = ctx.schema.idOf(obj)
      const shadow = needsDynShadow(obj, sid)
      // storedValueNarrow when NOT shadowed — see the identical reasoning at
      // this function's flat-object/unboxed-ptrAux branches above and
      // carrierF64Narrow's own doc comment (ir.js): no __dyn_set mirror means
      // no registry-aware reader ever observes this slot. Found live:
      // `let o = {n: 4611686018427387903n}; o.n += 1n` boxed the RHS
      // unconditionally, then the very next `f64.load` at this fixed offset
      // (this receiver has no shadow) read the pointer's bits raw.
      //
      // CARRIER PROGRAM §15/§16: derive the BIGINT-boxing half from the
      // per-schema slotBigintBoxedBySid fact (module/object.js's construction
      // comment has the granularity rationale) — `shadow` itself stays the
      // real needsDynShadow(obj, sid), still governing the __dyn_set mirror below.
      const boxed = sid != null ? ctx.schema.slotBigintBoxedBySid?.(sid, prop) : shadow
      const va = emit(obj), vv = boxed ? storedValue(val) : storedValueNarrow(val), t = temp()
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
  // self-compile `ctx.func.X = …` writes (e.g. finallyStack), dropping try/finally.
  if (typeof obj !== 'string') {
    const sh = shapeOf(obj)
    if (sh?.val === VAL.OBJECT && sh.names) {
      const i = sh.names.indexOf(prop)
      if (i >= 0) {
        // Same SHADOW CONTRACT as the ptrAux arm above: a slot-only write on a
        // shadowed object is masked by the mint-seeded sidecar for dyn reads.
        // sid (dyn-reach slice): `obj` is itself the chain expression (e.g.
        // `ctx.func` in `ctx.func.finallyStack = …`) — resolve it the SAME way
        // the write-hazard scan resolves a non-string receiver (sidOf's own
        // `ctx.schema.chainSid(obj, sidOf)`), using the public idOf as the
        // bare-name base case (mirrors kind.js's `chainSid(name, ctx.schema.idOf)`).
        // Fails closed to null (→ shadow=true under anyDynKey) on any
        // unresolved hop, exactly chainSid's own documented fail-closed shape.
        const chainedSid = ctx.schema.chainSid?.(obj, ctx.schema.idOf)
        const shadow = needsDynShadow(null, chainedSid)
        if (shadow) inc('__dyn_set')
        return withTemp(storedValue(val), t => [
          ctx.abi.object.ops.store(ptrOffsetIR(asF64(emit(obj)), VAL.OBJECT), i, ['local.get', `$${t}`]),
          ...(shadow ? [['drop', ['call', '$__dyn_set', ['i64.reinterpret_f64', asF64(emit(obj))], asI64(emit(['str', prop])), ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]] : []),
          ['local.get', `$${t}`]])
      }
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
    if (ctx.funcs.names.has(obj) && !isBoundName(obj)) {
      inc('__dyn_set')
      return typed(['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(obj)), asI64(emit(['str', prop])), asI64(storedValue(val))]], 'f64')
    }
    if (objType == null && ctx.transform.targetProfile.envImports) {
      setLinkDemand('external')
    }
    inc('__hash_set')
    // `__hash_set` returns the (possibly reallocated) HASH pointer, which must be
    // written back into `obj`. But JS `(obj.prop = v)` evaluates to `v`, not the
    // object — so capture the value and return it. This only diverges in value
    // position: postfix `o.p++` lowers to `(o.p = o.p+1) - 1`, `a = (o.p = v)`,
    // `f(o.p = v)`. Returning the pointer there computes `object - 1` → garbage
    // (the self-compile regex `c.labelId++` bug). Void position discards the tail.
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
  if (ctx.transform.targetProfile.envImports) setLinkDemand('external')
  inc('__dyn_set')
  return typed(['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(obj)), asI64(emit(['str', prop])), asI64(storedValue(val))]], 'f64')
}

