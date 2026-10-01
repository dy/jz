/**
 * Array module — literals, indexing, methods, push/pop.
 *
 * Type=1 (ARRAY): C-style header in memory.
 * Layout: [-8:len(i32)][-4:cap(i32)][elem0:f64, elem1:f64, ...]
 * offset points to elem0 (past header). len/cap mutable. Aliases see changes.
 *
 * @module array
 */

import { throwErrorIR, numberCarrierIR, numberNanIR, typed, asF64, asI64, asI32, keyIndex, UNDEF_NAN, TOMB_NAN, temp, tempI32, allocPtr, staticArrayPtr, arrayLoop, arrayValue, deferBigintBox, elemStore, throwTypeErrorIR, truthyIR, extractF64Bits, slotAddr, isLiteralStr, resolveValType, isGlobal, undefExpr, ptrTypeEq, boxedPtrTypeEq, isPureIR, freshId, isNullish, isUndef, toStrI64, fwdOffsetIR } from '../src/ir.js'
import { inBoundsArrIdx, typedIdxProven, wholeKey } from '../src/type.js'
import { emit, spread, deps, idx as emitIndex, storedValue, storedValuePlanned, positionArgs } from '../src/bridge.js'
import { censusMaybeUndefinedKind, isPresentNumber, valTypeOf } from '../src/kind.js'
import { extractParams, classifyParam, PARAM_NAME, ASSIGN_OPS, isArrayIndexKey, isReassigned, some } from '../src/ast.js'
import { staticPropertyKey, staticObjectProps, inlineArraySid, inlineArrayUnion, staticIndexKey, intLiteralValue, structLiteralFields, intExprRange } from '../src/static.js'
import { VAL, lookupValType, lookupNotString, isDisjointFrom, KIND_UNIVERSE, mayBeUndefined, repOf, repOfGlobal } from '../src/reps.js'
import { structInline } from '../src/abi/index.js'
import { ctx, inc, err, strictCode, warnDeopt, PTR, LAYOUT, followForwardingWat, setLinkDemand } from '../src/ctx.js'
import { strHashLiteral, dynPropsFilterSetIR, durableFwdLogIR, durableArrSnapIR, durableArrSnapNode } from './collection.js'
import { hasDurableReset } from './collection/durable.js'
import { errorCodeLiteral, ERR } from '../err-codes.js'
import { requireReceiverWat, requireObjectWat } from './core/error-object.js'
import { runsAccessor, runsConversion } from '../src/evaluation-effects.js'
import { DATA_VIEW_FLAG, nanPrefixHex } from '../layout.js'

const NAN_BITS = nanPrefixHex()
import { withRefinements } from '../src/compile/flow-types.js'
import { REP_EDGE_REJECT, representationProgramHasBigint, representationStorageWriteAction } from '../src/compile/representation-plan.js'
import { plannedTypedStorageCtor } from '../src/compile/typed-storage-plan.js'
import { scanBindingUses, USE, BINDING_USE_USES, BINDING_USE_KIND, BINDING_USE_KEY } from '../src/compile/analyze-scans.js'
import { restViewRead } from '../src/compile/rest-view.js'
import { core, hasTag, isNullable, K, NUMBER, tagOf, valOf } from '../src/summary/kind.js'
import { activeBoundsAssumption } from '../src/type/canonical-bounds.js'
import { hasExternalIngress } from '../src/compile/func-exports.js'
import { callbackLoop, hoistArrayValue, makeCallback, callbackElem, callbackArgReps, idxArg, arrArg, callbackReadsArray } from './array/callback.js'
import { arrayFromEmit } from './array/from.js'
import { registerEarlyExit } from './array/early-exit.js'
import { heapScratch, mergeSortIR } from './array/sort.js'


// Complement of {ARRAY, TYPED} in the VAL domain — the kindSet argument
// recvArrTyped's isDisjointFrom check (reps.js, .work/archive/lattice-design.md §5 Slice 2
// precedent) tests against. Computed once, module-level (not per-call).
const NOT_ARRAY_OR_TYPED = new Set(KIND_UNIVERSE.filter(k => k !== VAL.ARRAY && k !== VAL.TYPED))

/** Allocate ARRAY (type=1): header + n*8 data. Returns { local, setup, ptr } where local is data offset. */
function allocArray(len, cap) {
  const a = allocPtr({ type: PTR.ARRAY, len, cap, tag: 'arr' })
  return { local: a.local, setup: [a.init], ptr: a.ptr }
}

const arrayLenFromPtr = ptr => ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]

const needsArrayDynMove = () => (ctx.core.includes.has('__dyn_set') || ctx.core.includes.has('__dyn_set_own'))
// Head slack exists only where a shift can make it (see arrBaseWat): a program
// without one links a grow that never looks for it.
const needsHeadSlack = () => ctx.core.includes.has('__arr_shift')
// Whether durableFwdLogIR/durableArrSnapIR emit a real call (vs '' — see either's own
// comment): only when __heap_reset exists (owned-memory builds; shared memory never
// declares it — core.js). Gates the deps() edges below the SAME way, so a shared-memory
// build (where core.js never registers the durable-heal stdlib names) never requests a
// name nothing delivers — see collection.js's durableFwdLogIR/durableArrSnapIR comments
// for the full rationale. Name kept (not renamed to something array-snap-specific): still
// gates __arr_shift's OWN continued use of durableFwdLogIR (the one array.js call site NOT
// migrated to durableArrSnapIR — see that function's comment), so it remains an accurate
// name for what it tests, just no longer the ONLY durable-heal gate in this file.
const needsDurableFwdLog = hasDurableReset
// knownArray=true (__arr_grow_known): the raw offset + inline forwarding chase (see
// arrGrow below) calls $__ptr_offset_fwd directly, not the generic $__ptr_offset.
// '__durable_arr_snap' is an EXPLICIT edge (not left to the auto-dep scan): arrGrow's
// body always contains a durableArrSnapIR() call, but self-compile's realize/regex-scan
// auto-deps path silently drops a helper reachable only that way (the exact
// "Unknown func $__clamp_idx" shape documented in test/self-compile-includes.js) — that
// test would fail (and the kernel would trap) without this line.
const arrayGrowDeps = (knownArray = false) => () => [
  ...(knownArray ? ['__ptr_offset_fwd'] : ['__ptr_type', '__ptr_offset']),
  '__alloc_hdr', '__mkptr',
  ...(needsDurableFwdLog() ? ['__durable_arr_snap'] : []),
  ...(needsArrayDynMove() ? ['__dyn_move'] : []),
]

// Marks an ARRAY header slot ($off-16) as "props live in the global __dyn_props
// table, not here" — written whenever a shift/grow migrates or rekeys an entry
// there. Any nonzero, non-HASH-tagged i64 works: __dyn_get_t_h / __dyn_set /
// __dyn_del's ARRAY arms already treat "off-16 nonzero and not HASH-tagged" as
// "fall through to the global hash" (their only fast-accept is a HASH tag; their
// only fast-reject is exact zero). -1 decodes to tag 15, which is never PTR.HASH.
// Without this, a shift migrates props to the global table leaving nonzero
// leftover header bytes (which happens to satisfy "not zero, so check global") —
// but a *subsequent grow* allocates a fresh, zeroed header block, erasing that
// accidental signal and making __dyn_get_t_h wrongly conclude "no props" without
// ever consulting the global table. Writing this sentinel explicitly (instead of
// relying on incidental nonzero garbage) closes that gap for both shift and grow.
const DYN_PROPS_GLOBAL_SENTINEL = '(i64.const -1)'

// Arrays keep dynamic props in the global table because old/new array storage can
// be forwarded. Relocate that entry when growth moves the backing store; mark the
// new header so a later read/write/delete knows to consult the global table (the
// fresh __alloc_hdr block zeroes $newOff-16, which alone would read as "no props").
const maybeDynMoveIR = () => needsArrayDynMove()
  ? `(if (i32.eq (call $__dyn_move (local.get $off) (local.get $newOff)) (i32.const 1))
      (then (i64.store (i32.sub (local.get $newOff) (i32.const 16)) ${DYN_PROPS_GLOBAL_SENTINEL})))`
  : ''

// Per-object propsPtr lives in the 16-byte header at $off-16. On grow we copy it
// from old to new header (still HASH-tagged → unshifted ARRAY case). On shift we
// migrate it to the global __dyn_props because the forwarding writes overwrite
// the destination's $newOff-16 slot — headerPropsToGlobalIR marks that slot with
// DYN_PROPS_GLOBAL_SENTINEL so a later grow's fresh (zeroed) header doesn't lose
// the signal; maybeDynMoveIR marks it again on every subsequent grow/rekey.
const headerPropsCopyIR = () => needsArrayDynMove() ? `
    (local.set $oldProps (f64.load (i32.sub (local.get $off) (i32.const 16))))
    ;; strip the runtime-shadowed marker (collection.js bit0) — the relocated
    ;; header is ephemeral, where markers are meaningless and an odd props
    ;; offset would corrupt the sidecar probe
    (local.set $oldProps (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $oldProps)) (i64.const -2))))
    (if (i32.eq
          (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $oldProps)) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${PTR.HASH}))
      (then (f64.store (i32.sub (local.get $newOff) (i32.const 16)) (local.get $oldProps))))` : ''

const headerPropsToGlobalIR = () => needsArrayDynMove() ? `
    (if (i32.ge_u (local.get $off) (i32.const 16))
      (then
        (local.set $oldProps (f64.load (i32.sub (local.get $off) (i32.const 16))))
        (local.set $oldProps (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $oldProps)) (i64.const -2))))
        (if (i32.eq
              (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $oldProps)) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
              (i32.const ${PTR.HASH}))
          (then
            (local.set $root (global.get $__dyn_props))
            (if (f64.eq (local.get $root) (f64.const 0))
              (then (local.set $root (call $__hash_new))))
            (local.set $root (f64.reinterpret_i64 (call $__ihash_set_local
              (i64.reinterpret_f64 (local.get $root))
              (i64.reinterpret_f64 (f64.convert_i32_s (local.get $newOff)))
              (i64.reinterpret_f64 (local.get $oldProps)))))
            (global.set $__dyn_props (local.get $root))
            ${dynPropsFilterSetIR('(local.get $newOff)')}
            ;; for-in enum cache: sidecar props moved into the global table —
            ;; enumeration state changed off the site caches' keys. Move the epoch (see collection.js).
            (global.set $__enumc_epoch (i32.add (global.get $__enumc_epoch) (i32.const 1)))
            (i64.store (i32.sub (local.get $newOff) (i32.const 16)) ${DYN_PROPS_GLOBAL_SENTINEL}))))) ` : ''

// An own-name-current array binding (scanObjectArrayFacts): grown only
// through its own name with every grow written back, so the local always holds
// the live pointer and reads through it need no forwarding follow.
const currentBinding = (name) => ctx.func.localReps?.get(name)?.ownCurrent === true

export default (ctx) => {
  // Slice 4c/4e (RepresentationPlan v2): ONE plan-driven representation
  // decision for every fresh VALUE slot an array producer stores — literals
  // (4c) and the mutator family push/unshift/fill/Array.from (4e). Checked
  // per call (not at registration): the representation plan settles after module
  // registration. REJECT or a bigint-free program falls back to storedValue.
  // splice is deletion-only in the subset (no insert slots); copyWithin moves
  // already-stored bits; struct/packed/union pushes store schema-typed i32
  // fields (bigint-free by the slotI32Certain packing precondition) — exempt.
  const taggedStoredValue = (node) => {
    if (!representationProgramHasBigint(ctx)) return storedValue(node)
    const action = representationStorageWriteAction(ctx, node)
    return action === REP_EDGE_REJECT ? storedValue(node) : storedValuePlanned(node, action)
  }

  deps({
    __arr_idx: ['__ptr_offset_fwd', '__arr_value'],
    __arr_grow: arrayGrowDeps(false),
    __arr_grow_known: arrayGrowDeps(true),
    __arr_shift: () => [
      '__ptr_offset', '__arr_value',
      ...(needsDurableFwdLog() ? ['__durable_fwd_log'] : []),  // explicit edge — see arrayGrowDeps's comment
      ...(needsArrayDynMove() ? ['__dyn_move', '__hash_new', '__ihash_set_local'] : []),
    ],
    // '__durable_arr_snap' is an explicit edge on __arr_fill/__arr_copyWithin
    // (newly wired by this fix — see durableArrSnapIR's comment in collection.js)
    // and on all five below — see arrayGrowDeps's comment: each now calls
    // durableArrSnapIR directly in its OWN body (the whole-array element+header
    // heal, replacing the old header-only durableLenLogIR call at these same
    // sites), which self-compile's auto-dep scan cannot be relied on to discover
    // just because a callee (__arr_grow*) already depends on the name transitively.
    __arr_fill: () => ['__ptr_offset', '__clamp_idx', ...(needsDurableFwdLog() ? ['__durable_arr_snap'] : [])],  // body-calls __clamp_idx; declare it (self-compile auto-scan can't be relied on — see test/self-compile-includes.js)
    __arr_copyWithin: () => ['__ptr_type', '__ptr_offset', '__clamp_idx', ...(needsDurableFwdLog() ? ['__durable_arr_snap'] : [])],
    __arr_set_idx_ptr: ['__arr_grow', '__ptr_offset', ...(needsDurableFwdLog() ? ['__durable_arr_snap'] : [])],
    __arr_typed_set_idx: () => ['__ptr_type', '__ptr_aux', '__len', '__arr_set_idx_ptr',
      representationProgramHasBigint(ctx) || ctx.core.includes.has('__typed_set_idx_tagged') ? '__typed_set_idx_tagged' : '__typed_set_idx'],
    __arr_typed_obj_set_idx: ['__is_nullish', '__arr_typed_set_idx', '__ptr_type', '__dyn_set_own', '__i32_to_str'],
    __arr_push1: ['__arr_grow_known', '__ptr_offset_fwd', ...(needsDurableFwdLog() ? ['__durable_arr_snap'] : [])],
    __arr_push_slot: ['__arr_grow_known', '__ptr_offset_fwd', ...(needsDurableFwdLog() ? ['__durable_arr_snap'] : [])],
    __arr_set_length: ['__arr_grow_known', '__ptr_offset', '__ptr_type', '__to_num', '__to_int32', ...(needsDurableFwdLog() ? ['__durable_arr_snap'] : [])],
    __arr_unshift: ['__arr_grow', '__len', '__ptr_offset', ...(needsDurableFwdLog() ? ['__durable_arr_snap'] : [])],
    __arr_splice: ['__arr_grow', '__len', '__ptr_offset', '__alloc_hdr', '__mkptr', ...(needsDurableFwdLog() ? ['__durable_arr_snap'] : [])],
    __arr_flat: ['__ptr_offset', '__len', '__ptr_type', '__alloc_hdr', '__mkptr'],  // body-calls __alloc_hdr; declare it (self-compile auto-scan can't be relied on — see test/self-compile-includes.js)
    __typed_idx: () => ctx.linkDemand.typedarray || ctx.linkDemand.external
      ? ['__len', '__ptr_offset_fwd', '__arr_value']
      : ['__len', '__ptr_offset', '__ptr_offset_fwd', '__arr_value'],
    __arr_idx_known: ['__ptr_offset_fwd', '__arr_value'],
  })

  // Iteration methods invoke callbacks with an implicit trailing index: .map/
  // .filter/.forEach pass (item, idx); .reduce/.reduceRight pass (acc, item, idx).
  // The uniform closure width must accommodate the widest of these (arity 3) even
  // when no source-level closure declares that arity — otherwise a reduce callback
  // routed through the closure path overflows the call_indirect signature.
  ctx.closure.floor = Math.max(ctx.closure.floor ?? 0, 3)

  inc('__ptr_offset', '__ptr_type', '__len', '__set_len', '__typed_idx', '__is_truthy')

  // Array.isArray(x): check ptr_type === PTR.ARRAY.
  // Statically-known ARRAY values must answer from the FACT, not the carrier —
  // a rep-narrowed array (raw base local, e.g. a slice() result) is not a
  // NaN-box, so the runtime tag test would read a plain number and say false.
  ctx.core.emit['Array.isArray'] = (x) => {
    const vt = valTypeOf(x)
    if (vt === VAL.ARRAY) {
      const v = emit(x)
      return isPureIR(v) ? typed(['i32.const', 1], 'i32')
        : typed(['block', ['result', 'i32'], ['drop', asF64(v)], ['i32.const', 1]], 'i32')
    }
    return boxedPtrTypeEq(asF64(emit(x)), PTR.ARRAY)
  }

  ctx.core.emit['new.Array'] = (len) => {
    const n = tempI32('alen')
    const nIR = ['local.get', `$${n}`]
    // L3/'speed' bumps the cap floor to skip the first growth cycles (default 0
    // → grow on first push). Length stays exactly what the user requested.
    const minCap = ctx.transform.optimize?.arrayMinCap | 0
    const capIR = minCap > 0
      ? ['select', ['i32.const', minCap], nIR, ['i32.gt_s', ['i32.const', minCap], nIR]]
      : nIR
    const out = allocPtr({ type: PTR.ARRAY, len: nIR, cap: capIR, tag: 'newarr' })
    // The slots are holes: each reads undefined until written (the arena's
    // bytes read as 0; `a[0] ??= 7` on `new Array(1)` kept the 0).
    const k = tempI32('hole'), id = freshId(ctx)
    const holes = len == null ? [] : [
      ['local.set', `$${k}`, ['i32.const', 0]],
      ['block', `$hbrk${id}`, ['loop', `$hloop${id}`,
        ['br_if', `$hbrk${id}`, ['i32.ge_s', ['local.get', `$${k}`], nIR]],
        ['i64.store', ['i32.add', ['local.get', `$${out.local}`], ['i32.shl', ['local.get', `$${k}`], ['i32.const', 3]]], ['i64.const', TOMB_NAN]],
        ['local.set', `$${k}`, ['i32.add', ['local.get', `$${k}`], ['i32.const', 1]]],
        ['br', `$hloop${id}`]]]]
    // `new Array(len)` (23.1.1.1): a Number argument is the length, and one
    // that is not an integer in [0, 2^32) throws a RangeError; a single
    // argument of any other kind is the array's one element.
    const kind = len == null ? VAL.NUMBER : valTypeOf(len)
    if (len != null && kind != null && kind !== VAL.NUMBER) return emit(['[', len])
    const v = temp('alv'), vGet = ['local.get', `$${v}`]
    const lengthOf = ['block', ['result', 'i32'],
      ['local.set', `$${n}`, ['i32.trunc_sat_f64_u', vGet]],
      ['if', ['i32.or', ['f64.ne', vGet, ['f64.convert_i32_u', nIR]], ['f64.lt', vGet, ['f64.const', 0]]],
        ['then', ['drop', throwErrorIR('RangeError', 'Invalid array length')]]],
      nIR]
    const sized = ['block', ['result', 'f64'],
      ['local.set', `$${n}`, len == null ? ['i32.const', 0] : lengthOf],
      out.init,
      ...holes,
      out.ptr]
    if (len == null) return typed(sized, 'f64')
    // The kind settles at run time: a Number sizes (the number NaN included:
    // it throws), anything else is one element.
    const single = kind == null ? ['if', ['result', 'f64'], ['i32.or', ['f64.eq', vGet, vGet], numberNanIR(vGet)], ['then', sized], ['else', asF64(emit(['[', ['__raw_local', v]]))]] : sized
    return typed(['block', ['result', 'f64'], ['local.set', `$${v}`, asF64(emit(len))], single], 'f64')
  }

  // ARRAY-only indexed read. Inline forwarding-follow + bounds check + load — avoids
  // the redundant double pass through __len then __ptr_offset that both follow forwarding.
  ctx.core.stdlib['__arr_idx'] = `(func $__arr_idx (param $ptr i64) (param $i i32) (result f64)
    (local $off i32)
    (if (result f64)
      (i32.ne
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
        (i32.const ${PTR.ARRAY}))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
        ${followForwardingWat('$off', { lowGuard: true })}
        (if (result f64)
          (i32.and
            (i32.ge_u (local.get $off) (i32.const 8))
            (i32.and
              (i32.ge_s (local.get $i) (i32.const 0))
              (i32.lt_u (local.get $i) (i32.load (i32.sub (local.get $off) (i32.const 8))))))
          (then (call $__arr_value (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))))
          (else (f64.const nan:${UNDEF_NAN})))))) `

  ctx.core.stdlib['__arr_idx_known'] = `(func $__arr_idx_known (param $ptr i64) (param $i i32) (result f64)
    (local $off i32)
    (local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ${followForwardingWat('$off', { lowGuard: true })}
    (if (result f64)
      (i32.and
        (i32.ge_u (local.get $off) (i32.const 8))
        (i32.and
          (i32.ge_s (local.get $i) (i32.const 0))
          (i32.lt_u (local.get $i) (i32.load (i32.sub (local.get $off) (i32.const 8))))))
      (then (call $__arr_value (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))))
      (else (f64.const nan:${UNDEF_NAN}))))`

  // Runtime-dispatch index: element-type aware load with bounds check + view indirection.
  // Full body handles TYPED element types and view indirection since external host can
  // pass typed arrays even when typedarray module isn't loaded. When linkDemand.typedarray
  // and linkDemand.external are both off, collapses to ARRAY-only f64 indexing.
  // Array.from(src) — shallow copy. ARRAY receivers are already f64-stride, so a
  // straight memory.copy is correct and byte-identical to the plain-array hot
  // case (kept untouched — this is the common path, e.g. every internal
  // .reverse()/.sort()/toSorted()/spread-rest clone routes through here too).
  // Any other pointer type (TYPED element storage, forwarded/view-indirected
  // sources, BigInt64/Uint64 lanes, …) has non-f64 element stride/width, so a raw
  // byte copy is garbage — fall back to the polymorphic per-element reader that
  // already decodes every TYPED element kind + view indirection + bounds
  // Ordinary array slots hold tagged values, so BigInt elements must be boxed
  // by the shared tagged reader before leaving typed storage.
  ctx.core.stdlib['__arr_from'] = () => `(func $__arr_from (param $src i64) (result f64)
    (local $len i32) (local $dst i32) (local $i i32)
    (local.set $len (call $__len (local.get $src)))
    (local.set $dst (call $__alloc_hdr (local.get $len) (local.get $len)))
    (if (i32.eq (call $__ptr_type (local.get $src)) (i32.const ${PTR.ARRAY}))
      (then (memory.copy (local.get $dst) (call $__ptr_offset (local.get $src)) (i32.shl (local.get $len) (i32.const 3))))
      (else
        (local.set $i (i32.const 0))
        (block $brk (loop $loop
          (br_if $brk (i32.ge_s (local.get $i) (local.get $len)))
          (f64.store (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 3)))
            (call $${representationProgramHasBigint(ctx) ? '__typed_idx_tagged' : '__typed_idx'} (local.get $src) (local.get $i)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $loop)))))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $dst)))`

  // Value-copy consumers (spread, Array.from, change-by-copy methods) make
  // holes into own undefined slots; raw clones/slices preserve occupancy.
  deps({ __arr_values: ['__arr_value'], __arr_dense: ['__arr_from', '__ptr_offset', '__arr_values'] })
  ctx.core.stdlib['__arr_values'] = `(func $__arr_values (param $base i32) (param $n i32)
    (local $i i32) (local $p i32)
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $p (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 3))))
      (f64.store (local.get $p) (call $__arr_value (f64.load (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $next))))`
  ctx.core.stdlib['__arr_dense'] = `(func $__arr_dense (param $src i64) (result f64)
    (local $out f64) (local $base i32)
    (local.set $out (call $__arr_from (local.get $src)))
    (local.set $base (call $__ptr_offset (i64.reinterpret_f64 (local.get $out))))
    (call $__arr_values (local.get $base) (i32.load (i32.sub (local.get $base) (i32.const 8))))
    (local.get $out))`

  ctx.core.emit['Array.from'] = arrayFromEmit

  // Grow array if capacity insufficient. Returns (possibly new) NaN-boxed pointer.
  // Old storage is left behind as a forwarding header so existing aliases keep
  // seeing the current backing store after growth. `defensive` adds a type/bounds
  // guard (non-array ptr → fresh 4-cap buffer) for untyped call sites; the `_known`
  // variant skips it for hot paths that already proved the receiver is an array.
  // Single source of truth: both stdlib entries share the grow/relocate tail.
  // `_known` callers (all `deps()`-verified ARRAY-only: __arr_push1, __arr_set_length,
  // the inline-len array store) already proved the tag, so it inlines the raw offset +
  // forwarding chase (mirrors __arr_idx_known) instead of paying __ptr_offset's
  // tag-extract + FORWARDING_MASK dispatch — ARRAY always needs the chase (it's
  // forwarding-capable) but never needs the re-check this variant would otherwise repeat.
  // A shifted array. `__arr_shift` moves the header up one slot instead of
  // moving the elements: the vacated slot holds the new header's len/cap, and
  // its props word (the old header's len/cap words) holds the mark [base, -1],
  // the storage's base (for the first shift the base's own record, whose
  // target is the header itself). The base's record [live, -1] always
  // forwards to the live header (every shift rewrites it), a relocated block's
  // records forward to the new block's base, and every pointer a binding
  // holds is a base: nothing refers to the slots between the base and the
  // live header, so a grow may reuse them. An array below the reset mark
  // keeps its slots (the durable heal restores headers by their offset).
  const arrBaseWat = (off, base) => `
    (local.set ${base} (local.get ${off}))
    (if (i32.and (i32.eq (i32.load (i32.sub (local.get ${off}) (i32.const 12))) (i32.const -1))
                 (i32.ne (i32.load (i32.sub (local.get ${off}) (i32.const 16))) (i32.const -1)))
      (then
        (local.set ${base} (i32.load (i32.sub (local.get ${off}) (i32.const 16))))
        (local.set ${base} (select (i32.sub (local.get ${off}) (i32.const 8)) (local.get ${base}) (i32.eq (local.get ${base}) (local.get ${off}))))))`
  // Relocation: a fresh block, the old header forwarding to it.
  const relocateWat = () => `
    (local.set $newOff (call $__alloc_hdr (local.get $len) (local.get $newCap)))
    (memory.copy (local.get $newOff) (local.get $off) (i32.shl (local.get $len) (i32.const 3)))
    ${headerPropsCopyIR()}
    ${maybeDynMoveIR()}
    ${durableArrSnapIR('off')}
    (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newOff))
    (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
    (return (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $newOff)))`
  const arrGrow = (name, defensive) => {
    const slack = needsHeadSlack()
    // The array's storage ends at the heap top (nothing allocated since it)
    // and lies above the reset mark: extend it in place. No copy, no
    // forwarding header, and a push loop leaves one capacity in the arena,
    // not every doubling's (the same bump-extend a string at the heap top
    // takes). Anything else relocates.
    const extend = `
        (if (i32.or
              (i32.ne (i32.add (local.get $off) (i32.shl (local.get $oldCap) (i32.const 3))) (global.get $__heap))
              (i32.lt_u (local.get $off) (global.get $__heap_reset)))
          (then ${relocateWat()}))
        (local.set $newOff (i32.add (local.get $base) (i32.shl (local.get $newCap) (i32.const 3))))
        (if (i32.lt_u (local.get $newOff) (local.get $base)) (then (unreachable)))
        (if (i32.gt_u (local.get $newOff) (global.get $__heap_end)) (then (call $__memgrow (local.get $newOff))))
        (global.set $__heap (local.get $newOff))`
    // The head slack alone serves when it holds the array and fits the
    // request (less slack would slide again within as many pushes; the
    // doubling absorbs it instead); otherwise the storage grows first.
    const room = slack ? `
    (if (i32.and (i32.ge_u (local.get $off) (global.get $__heap_reset))
          (i32.and (i32.ge_s (local.get $head) (local.get $len))
                   (i32.ge_s (i32.add (local.get $head) (local.get $oldCap)) (local.get $minCap))))
      (then (local.set $newCap (i32.add (local.get $head) (local.get $oldCap))))
      (else ${extend}))` : `
    (block ${extend})`
    // A grow in place of a shifted array: the elements slide down to the
    // base, which is the header again.
    const slide = slack ? `
    (if (local.get $head)
      (then
        (memory.copy (local.get $base) (local.get $off) (i32.shl (local.get $len) (i32.const 3)))
        (i32.store (i32.sub (local.get $base) (i32.const 8)) (local.get $len))
        (local.set $newOff (local.get $base))
        ${maybeDynMoveIR()}))` : ''
    return `(func $${name} (param $ptr i64) (param $minCap i32) (result f64)
    ${defensive ? '(local $t i32) ' : ''}(local $off i32) (local $oldCap i32) (local $newCap i32) (local $newOff i32) (local $len i32) (local $base i32) (local $head i32)
    ${needsArrayDynMove() ? '(local $oldProps f64)' : ''}
    ${defensive ? `(local.set $t (call $__ptr_type (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    ;; Defensive path: invalid/non-array pointer -> create fresh array buffer.
    (if
      (i32.or
        (i32.ne (local.get $t) (i32.const ${PTR.ARRAY}))
        (i32.lt_u (local.get $off) (i32.const 8)))
      (then
        (local.set $newCap (select (local.get $minCap) (i32.const 4) (i32.gt_s (local.get $minCap) (i32.const 4))))
        (local.set $newOff (call $__alloc_hdr (i32.const 0) (local.get $newCap)))
        (return (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $newOff)))))` : `(local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ${followForwardingWat('$off', { lowGuard: true })}`}
    (local.set $oldCap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (if (i32.ge_s (local.get $oldCap) (local.get $minCap))
      (then (return (f64.reinterpret_i64 (local.get $ptr)))))
    (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
    ${slack ? `${arrBaseWat('$off', '$base')}
    (local.set $head (i32.shr_u (i32.sub (local.get $off) (local.get $base)) (i32.const 3)))` : '(local.set $base (local.get $off))'}
    (local.set $newCap (select
      (local.get $minCap)
      (i32.shl (i32.add (local.get $head) (local.get $oldCap)) (i32.const 1))
      (i32.gt_s (local.get $minCap) (i32.shl (i32.add (local.get $head) (local.get $oldCap)) (i32.const 1)))))
    ${!ctx.memory.shared && ctx.transform.alloc !== false ? `${room}${slide}
    (i32.store (i32.sub (local.get $base) (i32.const 4)) (local.get $newCap))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $base)))` : `${relocateWat()})`}`
  }

  ctx.core.stdlib['__arr_grow'] = () => arrGrow('__arr_grow', true)
  ctx.core.stdlib['__arr_grow_known'] = () => arrGrow('__arr_grow_known', false)

  // Hot for arr[i] = val (~18M calls in watr self-compile). Compute base via __ptr_offset
  // once and read len from the inline header (i32.load base-8) — avoids __len's separate
  // forwarding follow. On the rare grow path the base is recomputed after relocation.
  // durableArrSnapIR fires ONCE right after `base` resolves, before ANY write this call
  // could make (in-bounds overwrite of an EXISTING index, or the grow branch's gap-fill +
  // append) — this is the ONLY site an in-bounds `arr[i]=` overwrite (i < oldLen, no grow
  // at all) ever reaches, and it previously had ZERO durable protection (durableLenLogIR
  // only lived inside the grow branch, since only growth ever touched the LENGTH word —
  // but an in-bounds overwrite mutates a DATA cell with no length change at all, the exact
  // per-element gap this fix closes).
  ctx.core.stdlib['__arr_set_idx_ptr'] = `(func $__arr_set_idx_ptr (param $ptr i64) (param $i i32) (param $val f64) (result f64)
    (local $base i32) (local $p f64) (local $oldLen i32) (local $k i32)
    (local.set $p (f64.reinterpret_i64 (local.get $ptr)))
    (if (i32.lt_s (local.get $i) (i32.const 0))
      (then (return (local.get $p))))
    (local.set $base (call $__ptr_offset (local.get $ptr)))
    ${durableArrSnapIR('base')}
    (local.set $oldLen (i32.load (i32.sub (local.get $base) (i32.const 8))))
    (if (i32.ge_u (local.get $i) (local.get $oldLen))
      (then
        (local.set $p (call $__arr_grow (local.get $ptr) (i32.add (local.get $i) (i32.const 1))))
        (local.set $base (call $__ptr_offset (i64.reinterpret_f64 (local.get $p))))
        (i32.store (i32.sub (local.get $base) (i32.const 8)) (i32.add (local.get $i) (i32.const 1)))
        ;; gap slots [oldLen, i) are holes — fill with undefined, not zero
        (local.set $k (local.get $oldLen))
        (block $fdone (loop $fill
          (br_if $fdone (i32.ge_u (local.get $k) (local.get $i)))
          (i64.store (i32.add (local.get $base) (i32.shl (local.get $k) (i32.const 3))) (i64.const ${TOMB_NAN}))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $fill)))))
    (f64.store
      (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 3)))
      (local.get $val))
    (local.get $p))`

  // Compact runtime store for an index-only receiver proven not to be an
  // object/string. Keep the ARRAY/TYPED width fork out of hot loop bodies;
  // the speed-tier Float64 unswitch then removes this call from its fast arm.
  ctx.core.stdlib['__arr_typed_set_idx'] = () => {
    const tagged = representationProgramHasBigint(ctx)
    const store = tagged || ctx.core.includes.has('__typed_set_idx_tagged')
      ? `(drop (call $__typed_set_idx_tagged (local.get $ptr) (local.get $i) (local.get $val) (local.get $domain)))`
      : `(if (i32.or (i32.lt_u (local.get $i) (call $__len (local.get $ptr)))
                    (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const ${DATA_VIEW_FLAG})))
          (then (drop (call $__typed_set_idx (local.get $ptr) (local.get $i) (local.get $val)))))`
    return `(func $__arr_typed_set_idx (param $ptr i64) (param $i i32) (param $val f64) (param $domain i32) (result f64)
      (local $t i32)
      (local.set $t (call $__ptr_type (local.get $ptr)))
      (if (i32.eq (local.get $t) (i32.const ${PTR.ARRAY}))
        (then (return (call $__arr_set_idx_ptr (local.get $ptr) (local.get $i) (local.get $val)))))
      (if (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
        (then
          ${store}
          (return (f64.reinterpret_i64 (local.get $ptr)))))
      (f64.reinterpret_i64 (local.get $ptr)))`
  }

  // Property-capable sibling, pulled unless analysis proves ARRAY/TYPED.
  // Other objects use their ordinary own properties. Key/string helpers serve
  // that fallback; outlining keeps their dispatch out of the hot loop body.
  ctx.core.stdlib['__arr_typed_obj_set_idx'] = () => {
    return `(func $__arr_typed_obj_set_idx (param $ptr i64) (param $i i32) (param $val f64) (param $domain i32) (result f64)
    (local $t i32)
    (local.set $t (call $__ptr_type (local.get $ptr)))
    ${requireReceiverWat('(local.get $ptr)')}
    ${requireObjectWat('(local.get $ptr)', '(local.get $t)')}
    (if (i32.or (i32.eq (local.get $t) (i32.const ${PTR.ARRAY}))
                (i32.eq (local.get $t) (i32.const ${PTR.TYPED})))
      (then (return (call $__arr_typed_set_idx (local.get $ptr) (local.get $i) (local.get $val) (local.get $domain)))))
    (drop (call $__dyn_set_own (local.get $ptr)
      (i64.reinterpret_f64 (call $__i32_to_str (local.get $i)))
      (i64.reinterpret_f64 (local.get $val))))
    (f64.reinterpret_i64 (local.get $ptr)))`
  }

  // Out-of-line .push(val) for known-ARRAY receivers — keeps each call site to a
  // single call + var update instead of ~30 inlined instructions. Returns the
  // (possibly relocated) array pointer; caller derives the new length if needed.
  // durableArrSnapIR fires right after $base resolves (before the grow check and the
  // final store) even though push1 ITSELF never overwrites an existing index (it only
  // appends at $len, always a fresh slot) — see durableArrSnapIR's own comment: this
  // uniformity is load-bearing, not defensive belt-and-suspenders. If push1 kept the
  // old header-only log instead, and some OTHER op (e.g. a same-round `.length=`
  // shrink) had ALREADY logged this array into the array-snapshot table first, push1's
  // separate (old-mechanism) log would independently capture the header's CURRENT
  // (already-shrunk, not true-original) len into a DIFFERENT table — both heals then
  // run at `_clear()` and the one that runs second clobbers the other's correct
  // restore with its wrong one. One mechanism, one idempotent table, whichever call
  // reaches a given durable array first this round — is the only way every caller's
  // "first touch" assumption stays true simultaneously.
  ctx.core.stdlib['__arr_push1'] = `(func $__arr_push1 (param $ptr i64) (param $val f64) (result f64)
    (local $p f64) (local $base i32) (local $len i32)
    (local.set $p (f64.reinterpret_i64 (local.get $ptr)))
    (local.set $base (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ${followForwardingWat('$base', { lowGuard: true })}
    ${durableArrSnapIR('base')}
    (local.set $len (i32.load (i32.sub (local.get $base) (i32.const 8))))
    (if (i32.lt_s (i32.load (i32.sub (local.get $base) (i32.const 4))) (i32.add (local.get $len) (i32.const 1)))
      (then
        (local.set $p (call $__arr_grow_known (local.get $ptr) (i32.add (local.get $len) (i32.const 1))))
        (local.set $base (i32.wrap_i64 (i64.and (i64.reinterpret_f64 (local.get $p)) (i64.const ${LAYOUT.OFFSET_MASK}))))))
    (f64.store (i32.add (local.get $base) (i32.shl (local.get $len) (i32.const 3))) (local.get $val))
    (i32.store (i32.sub (local.get $base) (i32.const 8)) (i32.add (local.get $len) (i32.const 1)))
    (local.get $p))`

  // Reserve one element of `strideB` bytes on a known ARRAY whose header len
  // counts physical 8-byte cells: grow if needed, bump len to ⌈(n+1)·strideB/8⌉
  // and return (array pointer, element address). The caller stores the fields.
  // One call per structInline / union push site instead of the grow-and-index
  // sequence inlined at each; the logical count n = ⌊len·8/strideB⌋ is exact
  // for every stride ≥ 8 (the ceil slack is under one cell).
  // `zero` clears the element first (a union member writes only its own
  // lanes; the rest read as 0 by the carrier's contract). A proven fixed builder
  // shares this layout logic but needs neither forwarding nor growth.
  for (const fixed of [false, true]) {
    const name = fixed ? '__arr_push_slot_fixed' : '__arr_push_slot'
    ctx.core.stdlib[name] = `(func $${name} (param $ptr i64) (param $strideB i32) (param $zero i32) (result f64 i32)
    (local $p f64) (local $base i32) (local $n i32) (local $len i32) (local $slot i32)
    (local.set $p (f64.reinterpret_i64 (local.get $ptr)))
    (local.set $base (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ${fixed ? '' : followForwardingWat('$base', { lowGuard: true })}
    ${fixed ? '' : durableArrSnapIR('base')}
    (local.set $n (i32.div_u (i32.shl (i32.load (i32.sub (local.get $base) (i32.const 8))) (i32.const 3)) (local.get $strideB)))
    (local.set $len (i32.shr_u (i32.add (i32.mul (i32.add (local.get $n) (i32.const 1)) (local.get $strideB)) (i32.const 7)) (i32.const 3)))
    ${fixed ? '' : `(if (i32.lt_s (i32.load (i32.sub (local.get $base) (i32.const 4))) (local.get $len))
      (then
        (local.set $p (call $__arr_grow_known (local.get $ptr) (local.get $len)))
        (local.set $base (i32.wrap_i64 (i64.and (i64.reinterpret_f64 (local.get $p)) (i64.const ${LAYOUT.OFFSET_MASK}))))))`}
    (i32.store (i32.sub (local.get $base) (i32.const 8)) (local.get $len))
    (local.set $slot (i32.add (local.get $base) (i32.mul (local.get $n) (local.get $strideB))))
    (if (local.get $zero) (then (memory.fill (local.get $slot) (i32.const 0) (local.get $strideB))))
    (local.get $p)
    (local.get $slot))`
  }

  // arr.length = N. Truncation (N ≤ len) just rewrites the len word in place — no
  // relocation, so aliases keep their pointer. Growth past capacity relocates via
  // __arr_grow_known (old header forward-marked) and undefined-fills the new slots,
  // matching JS sparse-array semantics. Non-ARRAY receivers are left unchanged so a
  // mistyped `.length =` cannot corrupt object/collection headers. Returns the
  // (possibly relocated) pointer; the assignment's value is N (computed at the call site).
  ctx.core.stdlib['__arr_set_length'] = `(func $__arr_set_length (param $ptr i64) (param $value i64) (result f64)
    (local $base i32) (local $p f64) (local $oldLen i32) (local $cap i32) (local $k i32) (local $n i32)
    (local.set $p (f64.reinterpret_i64 (local.get $ptr)))
    (if (i32.ne (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.ARRAY}))
      (then (return (local.get $p))))
    ;; ArraySetLength performs two conversions, in order: observable valueOf
    ;; calls may give different values. The assignment still yields $value.
    (local.set $n (call $__to_int32 (call $__to_num (local.get $value))))
    (if (f64.ne (f64.convert_i32_u (local.get $n)) (call $__to_num (local.get $value)))
      (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${errorCodeLiteral(ERR.ARRAY_LENGTH)})))
        (throw $__jz_err (f64.const ${errorCodeLiteral(ERR.ARRAY_LENGTH)}))))
    ;; A dense eight-byte-slot array cannot fit this many elements in wasm32.
    (if (i32.gt_u (local.get $n) (i32.const 536870909))
      (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${errorCodeLiteral(ERR.HEAP_EXHAUSTED)})))
        (throw $__jz_err (f64.const ${errorCodeLiteral(ERR.HEAP_EXHAUSTED)}))))
    (local.set $base (call $__ptr_offset (local.get $ptr)))
    (if (i32.lt_u (local.get $base) (i32.const 8)) (then (return (local.get $p))))
    ${durableArrSnapIR('base')}
    (local.set $oldLen (i32.load (i32.sub (local.get $base) (i32.const 8))))
    (local.set $cap (i32.load (i32.sub (local.get $base) (i32.const 4))))
    (if (i32.gt_s (local.get $n) (local.get $cap))
      (then
        (local.set $p (call $__arr_grow_known (local.get $ptr) (local.get $n)))
        (local.set $base (call $__ptr_offset (i64.reinterpret_f64 (local.get $p))))))
    (if (i32.gt_u (local.get $n) (local.get $oldLen))
      (then
        (local.set $k (local.get $oldLen))
        (block $fdone (loop $fill
          (br_if $fdone (i32.ge_u (local.get $k) (local.get $n)))
          (i64.store (i32.add (local.get $base) (i32.shl (local.get $k) (i32.const 3))) (i64.const ${TOMB_NAN}))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $fill)))))
    (i32.store (i32.sub (local.get $base) (i32.const 8)) (local.get $n))
    (local.get $p))`

  // === Array literal ===

  const arrayLiteral = (elems, capacity = 0) => {
    const hasSpread = elems.some(e => Array.isArray(e) && e[0] === '...')
    const value = e => e == null ? typed(['f64.const', `nan:${TOMB_NAN}`], 'f64') : taggedStoredValue(e)

    // Synthetic destructuring arrays use the same tagged slots as ordinary
    // literals. Proven scalarization can erase the array before emission.
    if (!hasSpread) {
      const len = elems.length
      let vals
      // R: Static data segment for arrays of pure-literal elements (own-memory only).
      // Raw f64 bits embedded directly — a constant array becomes a const pointer with no
      // alloc and no per-element store. A static array aliases ONE shared data-segment
      // region, so this is sound only when no caller expects a fresh instance per
      // evaluation: at module scope the literal runs exactly once. A function-local
      // literal (which would leak in-place mutations across calls — a latent bug the old
      // len≥4 gate also had) allocs fresh instead. Module scope lifts the size floor too,
      // so `const x = [1, 2, 3]` is a data segment, not an alloc.
      if (ctx.func.atModuleScope && len >= 1 && !ctx.memory.shared) {
        // asF64 folds i32.const → f64.const literally, so int-literal arrays also qualify.
        // storedValue: a bool literal folds to its TRUE/FALSE atom const — still
        // static-extractable, and the element keeps boolean identity in the segment.
        vals = elems.map(value)
        const slots = vals.map(v => extractF64Bits(v))
        if (slots.every(b => b !== null)) {
          const ptr = staticArrayPtr(slots)
          // Every element a capture-free closure → tag the candidate set (funcIdx +
          // uniform-ABI body name) so a `const ops = [...arrows]` indexed CALL can
          // lower to a br_table of direct calls (emit.js tryConstFnArrayDispatch) —
          // the AOT form of a polymorphic inline cache, with the generic
          // call_indirect as the always-sound default arm.
          if (vals.length && vals.every(v => v.closureBodyName != null && v.closureFuncIdx != null))
            ptr.fnElements = vals.map(v => ({ idx: v.closureFuncIdx, name: v.closureBodyName }))
          return ptr
        }
      }
      // Nonempty literals start at their stated size. Empty builders keep
      // the growth reserve; proven builder capacity below still takes priority.
      const configuredLiteralCap = ctx.transform.optimize?.arrayLiteralMinCap
      const minCap = configuredLiteralCap == null
        ? (len ? 0 : Math.max(ctx.transform.optimize?.arrayMinCap | 0, 4))
        : Math.max(configuredLiteralCap | 0, 0)
      const a = allocArray(len, Math.max(len, minCap, capacity))
      const body = [...a.setup]
      for (let i = 0; i < len; i++)
        body.push(['f64.store', slotAddr(a.local, i), vals ? vals[i] : value(elems[i])])
      body.push(a.ptr)
      return typed(['block', ['result', 'f64'], ...body], 'f64')
    }

    // Spread literal: spread pre-sums the total length, allocates
    // exact, and bulk-copies ARRAY sources with a single memory.copy — vs the
    // per-element __arr_set_idx_ptr grow loop. Normalise the parser's `['...', x]`.
    return spread(elems.map(e =>
      Array.isArray(e) && e[0] === '...' ? ['__spread', e[1]] : e))
  }

  // Capacity is a settled builder fact; visible length still comes from the literal.
  const arrayCapacity = name => {
    const count = typeof name === 'string' ? ctx.func.localReps?.get(name)?.arrayCap : null
    if (count == null) return null
    const union = inlineArrayUnion(name), sid = inlineArraySid(name)
    const cells = union ? Math.ceil(count * union.stride / 2)
      : sid != null ? count * structInline(ctx.schema.list[sid].length, ctx.schema.inlineCellI32?.has(sid)).cpe : count
    return cells <= 0x1ffffffe ? cells : null
  }
  ctx.core.emit['['] = (...elems) => arrayLiteral(elems)
  ctx.core.emit['[capacity'] = (name, elems) => arrayLiteral(elems, arrayCapacity(name) ?? 0)

  // === Index read ===

  ctx.core.emit['[]'] = (arr, idx, node = null) => {
    // A rest slot view reads the argument slot (compile/rest-view.js).
    if (typeof arr === 'string' && ctx.func.restView?.has(arr)) return restViewRead(ctx.func.restView.get(arr), idx)
    const nullable = isNullable(ctx.summary?.at(ctx.func.current).kindOfExpr(arr)) &&
      !(typeof arr === 'string' && (repOf(arr)?.ptrKind != null || ctx.func.refinements?.get(arr)?.val != null || activeBoundsAssumption(ctx, arr, idx)))
    // A literal NEGATIVE index on a typed array or a string is out of
    // range → undefined, never a raw `payload + (-1)*8` load that
    // reads heap before the allocation. A side-effecting receiver still
    // evaluates. On any other receiver `o[-1]` reads the property "-1"
    // (ToPropertyKey): the generic paths below stringify the key. Mirrors
    // VT['[]'] returning null for the same case.
    { const li = intLiteralValue(idx)
      const rvt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
      if (!nullable && li != null && li < 0 && (rvt === VAL.TYPED || rvt === VAL.STRING ||
          rvt === VAL.ARRAY && ctx.summary?.at(ctx.func.current).arrayNumericPropertiesAbsent(arr)))
        return typeof arr === 'string'
          ? undefExpr()
          : typed(['block', ['result', 'f64'], ['drop', asF64(emit(arr))], undefExpr()], 'f64') }
    const scope = ctx.summary?.at(ctx.func.current)
    // A key's evaluation or coercion may rebind a named receiver too. A
    // callee can reach only captured/module bindings; ordinary local keys
    // preserve the receiver identity used by the loop proofs.
    const changing = typeof arr === 'string' && (isReassigned(idx, arr) ||
      (ctx.func.boxed?.has(arr) || isGlobal(arr)) &&
        (runsConversion(scope, ['[]', arr, idx]) || some(idx, n =>
          n[0] === 'new' || n[0] === '?.()' || n[0] === '()' && n.length > 2 || runsAccessor(scope, n) || runsConversion(scope, n))))
    // Hoist non-identifier arr so side-effecting sources (e.g. `foo.shift()[i]`) execute once.
    // The rest of the handler inlines `emit(arr)` into multiple IR positions, which would
    // otherwise re-execute the source expression per use at runtime.
    if (nullable || changing || typeof arr !== 'string' && !(Array.isArray(arr) && arr[0] === 'local.get')) {
      // Past the nullish check below the receiver is its payload kind: a
      // typed array that may be unset (`let x; … x = new Float64Array(n)`)
      // still indexes as a typed array, with an i32 index, not through the
      // generic keyed read.
      const view = nullable ? scope : null
      const vtArr = valTypeOf(arr) ?? (view ? valOf(core(view.kindOfExpr(arr))) : null)
      // A receiver that is itself an element read whose one missing value is
      // absence (`a[i][0]`, `a` an array of arrays) throws from that read's own
      // bounds test (the keyed read below, `throwAbsent`): the check after it
      // would test what the test already decided.
      const absentOnly = nullable && Array.isArray(arr) && arr[0] === '[]' && arr.length === 3 && view && !hasTag(view.kindOfExpr(arr), K.NULLISH)
      const prevThrow = ctx.func.throwAbsent
      if (absentOnly) ctx.func.throwAbsent = arr
      let source
      try { source = asF64(numberCarrierIR(arr, emit(arr))) } finally { ctx.func.throwAbsent = prevThrow }
      const present = absentOnly && source.presentRead === true
      // A numeric name/literal key cannot change a direct local receiver.
      // Keep its identity visible to loop proofs instead of capturing it.
      const direct = nullable && typeof arr === 'string' && source[0] === 'local.get' &&
        vtArr === VAL.TYPED && valOf(core(view.kindOfExpr(['[]', arr, idx]))) === VAL.NUMBER &&
        (typeof idx === 'string' || Array.isArray(idx) && idx[0] == null) && isPresentNumber(ctx, idx)
      const h = direct ? arr : temp('ai')
      if (!direct) {
        // Fresh captures carry only this expression's payload facts.
        if (vtArr) ctx.func.localValTypesOverlay.set(h, vtArr)
        if (vtArr === VAL.TYPED && !nullable) (ctx.func.presentTemps ??= new Set()).add(h)
        const typedCtor = vtArr === VAL.TYPED ? plannedTypedStorageCtor(ctx, arr) ?? view?.typedPayloadCtorOfExpr(arr) ?? null : null
        if (typedCtor) (ctx.func.localTypedElemsOverlay ||= new Map()).set(h, typedCtor)
      }
      const setup = direct ? [] : [['local.set', `$${h}`, source]]
      let key = idx
      if (nullable) {
        // GetV evaluates the key before rejecting the receiver, but converts
        // an object key only after that check. Keep the captured receiver and
        // key even if computing the key reassigns the source binding; a name
        // or a literal computes nothing and stays in place (an i32 counter
        // then indexes as i32).
        if (!(typeof idx === 'string' || (Array.isArray(idx) && (idx[0] == null || idx[0] === 'str')))) {
          key = temp('key')
          const keyType = valTypeOf(idx)
          const presentNumber = isPresentNumber(ctx, idx)
          setup.push(['local.set', `$${key}`, storedValue(idx)])
          if (keyType) ctx.func.localValTypesOverlay.set(key, presentNumber ? NUMBER : keyType)
        }
        // A name a statement of this block already checked is present (dispatch.js
        // emitBlockBody); the block emitter holds a name checked here present past it.
        if (!present && !(typeof arr === 'string' && ctx.func.refinements?.get(arr)?.notNullish)) {
          // A receiver whose only missing value is absence tests for undefined alone.
          const missing = hasTag(view.kindOfExpr(arr), K.NULLISH) ? isNullish : isUndef
          setup.push(['if', missing(typed(['local.get', `$${h}`], 'f64')), ['then', ['drop', throwTypeErrorIR()]]])
          if (typeof arr === 'string') (ctx.func.checkedRecv ??= []).push(arr)
        }
      }
      // The capture is the receiver, past its check: the summary answers for
      // it as for the expression (its cell, its fixed length).
      if (!direct) scope?.alias(h, arr, true)
      let result
      try {
        result = direct
          ? withRefinements(new Map([[arr, { val: VAL.TYPED, notNullish: true }]]), key, () => ctx.core.emit['[]'](arr, key))
          : ctx.core.emit['[]'](h, key)
      } finally { if (!direct) scope?.unalias(h) }
      const wrapped = typed(['block', ['result', 'f64'], ...setup, asF64(result)], 'f64')
      if (result?.checkedNumRead) wrapped.checkedNumRead = true
      if (result?.presentNumRead) wrapped.presentNumRead = true
      if (result?.presentRead) wrapped.presentRead = true
      if (result?.cellI32) { wrapped.cellI32 = true; wrapped.unionKey = result.unionKey }
      if (result?.indexValid) wrapped.indexValid = result.indexValid
      if (result && typeof result.bigintBox === 'function')
        deferBigintBox(wrapped, () => typed(['block', ['result', 'f64'], ...setup, asF64(result.bigintBox())], 'f64'))
      return wrapped
    }
    const keyType = typeof idx === 'string' ? lookupValType(idx) : valTypeOf(idx)
    const vt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    const numericKey = keyType === VAL.NUMBER && isPresentNumber(ctx, idx)
    // An object key needs ToPropertyKey even when produced by an expression.
    // Primitive keys keep the checked atom/BigInt and numeric-index paths below.
    if (keyType != null && keyType !== VAL.STRING && keyType !== VAL.NUMBER &&
        keyType !== VAL.BOOL && keyType !== VAL.BIGINT) {
      const key = temp('key'), value = storedValue(idx)
      const setup = [['local.set', `$${key}`, value]]
      if (valTypeOf(arr) == null)
        setup.push(['if', isNullish(asF64(emit(arr))), ['then', ['drop', throwTypeErrorIR()]]])
      setup.push(['local.set', `$${key}`, ['f64.reinterpret_i64', toStrI64(idx, typed(['local.get', `$${key}`], 'f64'))]])
      ctx.func.localValTypesOverlay.set(key, VAL.STRING)
      return typed(['block', ['result', 'f64'], ...setup, asF64(ctx.core.emit['[]'](arr, key))], 'f64')
    }
    const useRuntimeKeyDispatch = !numericKey && keyType !== VAL.STRING
    // A proven count/histogram dictionary stores only each value's observable
    // ToInt32 bits. All reads were proven bitwise-coerced, so wrap the standard
    // hash lookup's low word directly (missing undefined has low word zero).
    if (typeof arr === 'string' && ctx.func.i32HashLocals?.has(arr)) {
      inc('__hash_get_local')
      const obj = asI64(emit(arr))
      if (keyType === VAL.STRING || isLiteralStr(idx))
        return typed(['i32.wrap_i64', ['call', '$__hash_get_local', obj, asI64(emit(idx))]], 'i32')
      inc('__is_str_key', '__to_key')
      const kt = temp()
      // storedValue (not asF64(emit(idx))): READ-side sibling of MECHANISM A
      // (.work/archive/todo.md §deletion-sweep Finding #2) — an ambiguous BOOL∪NUMBER
      // merge key must reach __to_key/__hash_get_local boxed, or ToPropertyKey
      // normalizes the wrong (collapsed-number) bits. storedValue already
      // returns f64-typed IR, so no asF64 wrap is needed.
      return typed(['block', ['result', 'i32'],
        ['local.set', `$${kt}`, storedValue(idx)],
        ['if', ['i32.eqz', ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.get', `$${kt}`]]]],
          ['then', ['local.set', `$${kt}`, ['f64.reinterpret_i64', ['call', '$__to_key', ['i64.reinterpret_f64', ['local.get', `$${kt}`]]]]]]],
        ['i32.wrap_i64', ['call', '$__hash_get_local', obj, ['i64.reinterpret_f64', ['local.get', `$${kt}`]]]]], 'i32')
    }
    // TypedArray: type-aware load
    if (typeof arr === 'string' && ctx.core.emit['.typed:[]'] &&
        vt === VAL.TYPED) {
      if (!numericKey && !((keyType === VAL.NUMBER || censusMaybeUndefinedKind(idx) === VAL.NUMBER) && ctx.summary.typedPropertiesAbsent())) {
        ctx.module.include('collection')
        ctx.module.include('string')
        setLinkDemand('typedProperties')
        // A concrete ctor is payload provenance; a missing outer array slot
        // still has an undefined receiver tag, which the runtime must check.
        const present = repOf(arr)?.ptrKind === VAL.TYPED || ctx.func.presentTemps?.has(arr) || ctx.summary?.at(ctx.func.current).mayBeNullishExpr(arr) === false
        const fn = present ? '__dyn_get_t' : '__dyn_get'
        // A typed array answers a number key from its elements alone (an
        // integer-indexed exotic object: an invalid index reads undefined and
        // never a property), so a key the summary cannot type still indexes
        // directly once a runtime test proves it an integer the i32 index
        // holds exactly: every non-number is a NaN box and fails the test, and
        // a property name, an undefined key or a huge integer keeps the
        // dynamic get. A key known not to be a number skips the test; a
        // BigInt element stays tagged.
        const keyKind = present ? ctx.summary?.at(ctx.func.current).kindOfExpr(idx) : null
        const keyTag = keyKind == null ? K.ANY : tagOf(core(keyKind))
        const ctor = present && (keyTag === K.NUMBER || keyTag === K.ANY) ? plannedTypedStorageCtor(ctx, arr) : null
        if (ctor && !/Big/.test(ctor)) {
          // The key as stored (for the dynamic get) and, once the test holds,
          // as the i32 index the typed read takes.
          const kt = temp('key'), ki = tempI32('ki')
          ctx.func.localValTypesOverlay.set(ki, NUMBER)
          const fast = ctx.core.emit['.typed:[]'](arr, ki)
          if (fast) {
            inc('__dyn_get_t')
            return typed(['block', ['result', 'f64'],
              ['local.set', `$${kt}`, storedValue(idx)],
              ['if', ['result', 'f64'], ['f64.eq', ['local.get', `$${kt}`], ['f64.convert_i32_s', ['local.tee', `$${ki}`, ['i32.trunc_sat_f64_s', ['local.get', `$${kt}`]]]]],
                ['then', asF64(fast)],
                ['else', ['f64.reinterpret_i64', ['call', '$__dyn_get_t', asI64(emit(arr)), ['i64.reinterpret_f64', ['local.get', `$${kt}`]], ['i32.const', PTR.TYPED]]]]]], 'f64')
          }
        }
        // (a receiver a guard alone proves typed, no constructor's, keeps the
        // key-kind dispatch below: a number key reads the element through the
        // runtime's width dispatch, a string key the property)
        if (present) {
          inc(fn)
          return typed(['f64.reinterpret_i64', ['call', `$${fn}`, asI64(emit(arr)), asI64(storedValue(idx)), ['i32.const', PTR.TYPED]]], 'f64')
        }
      } else {
        const r = ctx.core.emit['.typed:[]'](arr, idx, node)
        if (r) return r
      }
    }
    // Literal string key on schema-known object → direct payload slot read (skip __dyn_get)
    const litKey = isLiteralStr(idx) ? idx[1]
      : typeof arr === 'string' && lookupValType(arr) === VAL.OBJECT ? staticPropertyKey(idx)
      : null
    // SRoA flat object/array: `o['k']` / `a[2]` → `local.get $o#i` (flatObjectCandidate).
    // A bare integer index resolves its slot key here (not via `litKey`, which stays
    // null for arrays so the heap-array / schema paths below are untouched).
    if (typeof arr === 'string' && ctx.func.flatObjects?.has(arr)) {
      const fo = ctx.func.flatObjects.get(arr)
      const flatKey = litKey != null ? litKey : staticIndexKey(idx)
      const fi = flatKey != null ? fo.names.indexOf(flatKey) : -1
      if (fi >= 0) return typed(['local.get', `$${arr}#${fi}`], 'f64')
    }
    // Share dot access's slot carrier contract, including unboxing. A second
    // plain-load path here disagrees with the representation plan on BigInts.
    if (litKey != null && typeof arr === 'string' && ctx.schema.slotOf?.(arr, litKey) >= 0)
      return emit(['.', arr, litKey])
    // A static string key on a receiver the summary shapes as an object is a
    // field read, on the same path as dot syntax (emit-assign.js's store rule).
    if (isLiteralStr(idx) && !isArrayIndexKey(idx[1]) && ctx.summary?.at(ctx.func.current).objectSidOfExpr(arr) != null)
      return emit(['.', arr, idx[1]])
    if (litKey != null && typeof arr === 'string' && lookupValType(arr) === VAL.HASH) {
      inc('__hash_get_local_h')
      return typed(['f64.reinterpret_i64', ['call', '$__hash_get_local_h', asI64(emit(arr)), asI64(emit(['str', litKey])), ['i32.const', strHashLiteral(litKey)]]], 'f64')
    }
    if (litKey != null && typeof arr !== 'string' && valTypeOf(arr) === VAL.HASH) {
      inc('__hash_get_local_h')
      return typed(['f64.reinterpret_i64', ['call', '$__hash_get_local_h', asI64(emit(arr)), asI64(emit(['str', litKey])), ['i32.const', strHashLiteral(litKey)]]], 'f64')
    }
    // Multi-value calls are materialized at call site (see '()' handler), so
    // func()[i] works naturally — func() returns a heap array pointer, [i] indexes it.
    // An unresolved receiver may be any host-provided TypedArray even when the
    // source names no typed constructor. Keep __typed_idx's runtime aux-width
    // dispatch live; otherwise its reachability factory collapses to the
    // ARRAY-only f64.load body and valid Int8/Int16/Int32/f32 reads decode
    // adjacent bytes as denormal garbage. Host f16/clamped/BigInt storage is
    // rejected at an evidence-free boundary; internal constructors set their
    // own specialized demand flags.
    if (vt == null) {
      if (!numericKey) {
        ctx.module.include('typedarray')
        setLinkDemand('typedProperties')
      }
      setLinkDemand('typedarray')
      setLinkDemand('typedRuntime')
    }
    // A canonical index key names the index (`o["1"]` is `o[1]`): on a receiver
    // of unknown kind it takes the index dispatch, where an array's, a typed
    // array's and a string's element answer and an object's property "1" does.
    if (vt == null && isLiteralStr(idx) && isArrayIndexKey(litKey)) return ctx.core.emit['[]'](arr, [null, Number(litKey)], node)
    // Literal keys on other receiver kinds share dot access's schema and host
    // dispatch. ARRAY/TYPED/STRING keep their own string-key semantics below.
    if (litKey != null && vt !== VAL.ARRAY && vt !== VAL.TYPED && vt !== VAL.STRING)
      return emit(['.', arr, litKey])
    const methodReader = ctx.funcs.builtinMethodReaders?.get(null)
    if (!strictCode() && methodReader?.active && !numericKey && (vt == null || vt === VAL.MAP || vt === VAL.SET))
      return emit(['()', methodReader.name, [',', arr, idx]])
    // emitIndex (not bare asI32(emit)) narrows integer index arithmetic — incl. a
    // literal term like the `+1` of `a[i*W + x + 1]` — to i32 ops instead of the
    // f64 convert/trunc round-trip. Non-i32 keys (string dispatch) fall back to
    // asI32(emit) inside emitIndex, so this is a strict improvement for every branch.
    const va = emit(arr), vi = emitIndex(idx)
    const ptrExpr = asF64(numberCarrierIR(arr, va))
    // Unknown property receivers can be host objects, just as for dot reads.
    // Numeric element paths do not request this fallback.
    const ensureHostOpaqueGet = () => {
      if (vt != null || !ctx.transform.targetProfile.envImports) return false
      // The shared helper resolves its host arm at link time, after every
      // producer has been emitted. Closed programs keep the internal body.
      if (hasExternalIngress()) setLinkDemand('external')
      ctx.module.include('collection')
      inc('__dyn_get_any')
      return true
    }
    const dynLoad = (objExpr, keyExpr) => {
      if (strictCode()) err(`strict mode: dynamic property access \`${typeof arr === 'string' ? arr : '<expr>'}[<expr>]\` falls back to __dyn_get. Use a literal key or known typed-array receiver, or pass { strict: false }.`)
      warnDeopt('deopt-dyn-read', `dynamic property read \`${typeof arr === 'string' ? arr : '<expr>'}[…]\` couldn't resolve a static type — it falls back to a runtime hash lookup (~1.5–2× slower than a typed/slot read, far worse in a hot loop). Use a literal key, a typed-array receiver, or a Map for genuinely dynamic keys.`)
      const fn = ensureHostOpaqueGet() ? '__dyn_get_any' : '__dyn_get'
      if (fn === '__dyn_get') inc(fn)
      return ['f64.reinterpret_i64', ['call', `$${fn}`, ['i64.reinterpret_f64', objExpr], ['i64.reinterpret_f64', keyExpr]]]
    }
    const opaqueDynExprLoad = (objExpr, keyExpr) => {
      if (ensureHostOpaqueGet())
        return ['f64.reinterpret_i64', ['call', '$__dyn_get_any', ['i64.reinterpret_f64', objExpr], ['i64.reinterpret_f64', keyExpr]]]
      inc('__dyn_get_expr')
      return ['f64.reinterpret_i64', ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', objExpr], ['i64.reinterpret_f64', keyExpr]]]
    }
    // Numbers outside the array-index domain name own properties. Keep their
    // original value for ToPropertyKey; keyIndex's -1 sentinel loses it.
    const keyRange = numericKey ? intExprRange(idx) : null
    const elementKey = wholeKey(idx) && keyRange && keyRange[0] >= 0 && keyRange[1] < 0xffffffff
    const numericProps = !elementKey && !ctx.summary?.at(ctx.func.current).arrayNumericPropertiesAbsent(arr)
    const stringLoad = () => (inc('__str_idx'), ['call', '$__str_idx', ['i64.reinterpret_f64', ptrExpr], vi])
    // A numeric index on an unknown receiver is array/typed access by design — kept
    // lean (no OBJECT/HASH dyn-get fork): an object with numeric keys is a degenerate
    // pattern not worth a per-access string-coercion + hash probe in every hot loop.
    // The WRITE path still routes a numeric `o[i]=v` on an OBJECT to __dyn_set for
    // SAFETY (no schema-slot corruption / OOB), so such a read returns undefined
    // rather than corrupting — matching JS for an out-of-range typed/array index.
    const runtimeElemRead = (vt == null || vt === VAL.TYPED) && representationProgramHasBigint(ctx)
      ? '__typed_idx_tagged' : '__typed_idx'
    if (vt === VAL.TYPED || vt == null) setLinkDemand('typedRuntime')
    // A receiver a guard alone proves typed (`a instanceof Int32Array`, no
    // constructor in the program) needs the same width dispatch an unknown one
    // does above: the helper's array body reads eight bytes per element.
    if (vt === VAL.TYPED) setLinkDemand('typedarray')
    if (runtimeElemRead === '__typed_idx_tagged') inc(runtimeElemRead)
    // The array arm inline, ahead of the helper: the tag test (an array's
    // offset is a heap address; `__heap_end64` is not a validity bound, it
    // lags the host's own allocations), one forwarding hop (the chase stays
    // outlined), the bounds test, the load. An unresolved
    // receiver is an array at nearly every site that reaches here (an AST
    // node under a walker), and the helper's own dispatch, its second header
    // walk and its call frame were the price of every element read there.
    // `ptrExpr` is a plain read (the receiver was hoisted above); the index
    // lands in a temp once.
    const arrayFast = (slow, index = vi, receiver = ptrExpr) => {
      const off = tempI32('ao'), ix = tempI32('ax')
      inc('__ptr_offset_fwd')
      return ['block', ['result', 'f64'],
        ['local.set', `$${ix}`, index],
        ['if', ['result', 'f64'],
          ['i32.and', ptrTypeEq(receiver, PTR.ARRAY),
            ['i32.ge_u', ['local.tee', `$${off}`, ['i32.wrap_i64', ['i64.reinterpret_f64', receiver]]], ['i32.const', 8]]],
          ['then',
            ['if', ['i32.eq', ['i32.load', ['i32.sub', ['local.get', `$${off}`], ['i32.const', 4]]], ['i32.const', -1]],
              ['then', ['local.set', `$${off}`, ['call', '$__ptr_offset_fwd', ['local.get', `$${off}`]]]]],
            ['if', ['result', 'f64'],
              ['i32.lt_u', ['local.get', `$${ix}`], ['i32.load', ['i32.sub', ['local.get', `$${off}`], ['i32.const', 8]]]],
              ['then', arrayValue(ctx.abi.array.ops.load(['local.get', `$${off}`], ['local.get', `$${ix}`]))],
              ['else', undefExpr()]]],
          ['else', slow(['local.get', `$${ix}`])]]]
    }
    // Keep the existing direct array load for exact word indices. Only the
    // other arm needs ToPropertyKey, with receiver identity captured before
    // an effectful key and forwarding resolved afterwards.
    const arrayPropertyLoad = key => {
      ctx.module.include('collection')
      if (ctx.transform.optimize?.leanRuntime) return opaqueDynExprLoad(ptrExpr, key)
      const recv = temp('apr'), kt = temp('apk'), ki = tempI32('api')
      const r = typed(['local.get', `$${recv}`], 'f64'), k = typed(['local.get', `$${kt}`], 'f64')
      return ['block', ['result', 'f64'],
        ['local.set', `$${recv}`, ptrExpr], ['local.set', `$${kt}`, key],
        ['if', ['result', 'f64'], ['i32.ge_s', ['local.tee', `$${ki}`, keyIndex(k)], ['i32.const', 0]],
          ['then', arrayFast(ix => ['call', `$${runtimeElemRead}`, ['i64.reinterpret_f64', r], ix], ['local.get', `$${ki}`], r)],
          ['else', opaqueDynExprLoad(r, k)]]]
    }
    if (vt === VAL.ARRAY && keyType !== VAL.STRING && numericProps)
      return typed(arrayPropertyLoad(storedValue(idx)), 'f64')
    // The size tier keeps the helper's own dispatch (`leanRuntime`, the tier
    // that links the runtime lean): the inline arm is ~50 ops per site, 14 KB of
    // watr's size build for a walker's reads the speed build alone is timed on.
    const indexedLoad = ctx.transform.optimize?.leanRuntime
      ? ['block', ['result', 'f64'], ['call', `$${runtimeElemRead}`, ['i64.reinterpret_f64', ptrExpr], vi]]
      : arrayFast(ix => ['call', `$${runtimeElemRead}`, ['i64.reinterpret_f64', ptrExpr], ix])
    const arrayLoad = vt == null && numericProps
      ? ['if', ['result', 'f64'], ptrTypeEq(ptrExpr, PTR.ARRAY),
        ['then', arrayPropertyLoad(storedValue(idx))], ['else', indexedLoad]]
      : indexedLoad
    const emitDynamicKeyDispatch = (objExpr, numericLoad) => {
      const keyTmp = temp()
      // All boxed keys (and NaN) need ToPropertyKey. The dynamic helper owns
      // coercion, including object hooks; the numeric arm keeps index checks.
      ctx.module.include('string')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${keyTmp}`, storedValue(idx)],
        ['if', ['result', 'f64'], ['f64.ne', ['local.get', `$${keyTmp}`], ['local.get', `$${keyTmp}`]],
          ['then', dynLoad(objExpr, ['local.get', `$${keyTmp}`])],
          ['else', numericLoad(['local.get', `$${keyTmp}`])]]], 'f64')
    }
    // Boxed object: string keys address the box, numeric keys address the inner array.
    if (typeof arr === 'string' && ctx.schema.isBoxed?.(arr)) {
      const inner = ctx.schema.emitInner(arr)
      if (keyType === VAL.STRING) return typed(dynLoad(asF64(emit(arr)), asF64(emit(idx))), 'f64')
      inc('__arr_idx')
      if (useRuntimeKeyDispatch)
        return emitDynamicKeyDispatch(asF64(emit(arr)), keyExpr =>
          ['call', '$__arr_idx', asI64(inner), keyIndex(typed(keyExpr, 'f64'))])
      return typed(['call', '$__arr_idx', asI64(inner), vi], 'f64')
    }
    // HASH receiver with runtime string key: probe the HASH directly via
    // __hash_get_local. Mirrors the literal-key path above but defers the
    // hash computation to runtime. Non-string keys (known-numeric, or the
    // runtime-dispatch else-arm) go through __dyn_get_expr, whose entry
    // ToPropertyKey-normalizes — `h[97]` reads the '97' slot the (also
    // normalizing) write stored. A known HASH is never an array, so there is
    // no hot array-index path to protect here.
    if (vt === VAL.HASH) {
      if (keyType === VAL.STRING) {
        inc('__hash_get_local')
        return typed(['f64.reinterpret_i64', ['call', '$__hash_get_local', ['i64.reinterpret_f64', ptrExpr], asI64(emit(idx))]], 'f64')
      }
      if (useRuntimeKeyDispatch) {
        inc('__hash_get_local', '__is_str_key', '__dyn_get_expr')
        const keyTmp = temp()
        // storedValue: READ-side sibling of MECHANISM A (.work/archive/todo.md
        // §deletion-sweep Finding #2).
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${keyTmp}`, storedValue(idx)],
          ['if', ['result', 'f64'], ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.get', `$${keyTmp}`]]],
            ['then', ['f64.reinterpret_i64', ['call', '$__hash_get_local', ['i64.reinterpret_f64', ptrExpr], ['i64.reinterpret_f64', ['local.get', `$${keyTmp}`]]]]],
            ['else', ['f64.reinterpret_i64', ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', ptrExpr], ['i64.reinterpret_f64', ['local.get', `$${keyTmp}`]]]]]]], 'f64')
      }
      inc('__dyn_get_expr')
      // storedValue (not asI64(emit(idx))): same MECHANISM A read-side sibling —
      // the HASH-receiver __dyn_get_expr fallthrough (.work/archive/todo.md §deletion-sweep
      // Finding #2). storedValue returns f64-typed IR; asI64 wraps it for the i64 arg.
      return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', ptrExpr], asI64(storedValue(idx))]], 'f64')
    }
    // OBJECT receiver with a non-string key: never an array element — route to the
    // ToPropertyKey-normalizing dyn read (the WRITE side already goes to __dyn_set;
    // see the numeric-index design note below, which stays scoped to UNKNOWN receivers).
    if (vt === VAL.OBJECT && keyType !== VAL.STRING) {
      inc('__dyn_get_expr')
      // storedValue: same MECHANISM A read-side sibling (.work/archive/todo.md
      // §deletion-sweep Finding #2) — the OBJECT-receiver __dyn_get_expr fallthrough.
      return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', ptrExpr], asI64(storedValue(idx))]], 'f64')
    }
    // Known array → direct f64 element load, skip string check
    if (keyType === VAL.STRING)
      return typed(dynLoad(ptrExpr, asF64(emit(idx))), 'f64')
    if (vt === 'array') {
      // Presence is independent of the element kind. The checked array
      // helper handles an absent receiver before touching its header.
      if (mayBeUndefined(arr)) {
        if (useRuntimeKeyDispatch && !numericKey) {
          inc('__arr_idx')
          return emitDynamicKeyDispatch(ptrExpr, key => ['call', '$__arr_idx', asI64(ptrExpr), keyIndex(typed(key, 'f64'))])
        }
        // An absent receiver reads undefined, as the helper answers.
        return typed(arrayFast(() => undefExpr()), 'f64')
      }
      // Base offset of the array's data region. A binding proven never relocated
      // (neverGrownCandidate — a fresh array literal whose every use is a pure read, so no
      // grow op can ever run) skips the realloc-forwarding follow: its base is the raw
      // post-header offset `wrap(reinterpret(ptr) & OFFSET_MASK)`, no __ptr_offset call.
      // Memory-safe ONLY under that proof — a relocated array read through this stale
      // base would corrupt memory (see neverGrownCandidate's default-deny rationale).
      // An own-name-current binding (scanObjectArrayFacts: every grow
      // runs through this name and writes the pointer back) is never stale
      // either, so its reads take the raw base too; its header may relocate
      // between reads, which only neverGrown rules out (no base hoists here).
      // A receiver of fixed length (the summary's `lens`: every array it can hold
      // is built at one count and nothing in the program resizes any of them)
      // never relocates either, whatever names reach it: its base is the raw
      // offset, its length the count.
      // A module const frozen after init (plan/scope.js) knows its length the same way.
      const rep = typeof arr === 'string' ? ctx.func.localReps?.get(arr) ?? repOfGlobal(arr) : null
      const dense = ctx.summary?.at(ctx.func.current).arrayDenseOfExpr(arr) === true
      const value = load => dense ? load : arrayValue(load)
      const fixedLen = ctx.summary?.at(ctx.func.current)?.fixedLenOfExpr(arr) ?? (rep?.neverGrown === true ? rep.arrayLen ?? null : null)
      const neverGrown = fixedLen != null || rep?.neverGrown === true
      const arrBase = (pointer = ptrExpr, current = true) => neverGrown || (current && typeof arr === 'string' && currentBinding(arr))
        ? ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', pointer], ['i64.const', LAYOUT.OFFSET_MASK]]]
        : ctx.transform.optimize?.leanRuntime ? (inc('__ptr_offset'), ['call', '$__ptr_offset', ['i64.reinterpret_f64', pointer]])
        : fwdOffsetIR(pointer)
      const keyIsNum = numericKey
      const stLen = keyIsNum && typeof arr === 'string' ? ctx.scope.staticArrs?.get(arr)?.len ?? ctx.scope.staticLitLens?.get(arr) : null
      const staticProven = stLen != null && !!ctx.types.arrResized && !!ctx.types.nameEscapes
        && !ctx.types.arrResized.has(arr) && !ctx.types.nameEscapes.has(arr)
        && (range => range != null && range[0] >= 0 && range[1] < stLen)(intExprRange(idx))
      const fixedProven = keyIsNum && fixedLen != null
        && (range => range != null && range[0] >= 0 && range[1] < fixedLen)(intExprRange(idx))
      const idxProvenInBounds = fixedProven || keyIsNum && typeof arr === 'string' && (staticProven ||
        (typeof idx === 'string' && inBoundsArrIdx(ctx).has(arr + '\x00' + idx)) ||
        (rep?.arrayLen != null && typedIdxProven(arr, idx)))
      // structInline Array<S>: element i is K consecutive inline f64 schema
      // cells — no per-row heap object, no stored element pointer. `arr[i]` is
      // the byte address of the element's first cell, returned as a first-class
      // unboxed OBJECT pointer (schema S); `arr[i].field` then composes a plain
      // `+field*8` off it. The narrower proved every use of this binding is one
      // structInline handles (src/analyze.js analyzeStructInline).
      const u = inlineArrayUnion(arr)
      const inlSid = inlineArraySid(arr)
      if (u != null || inlSid != null) {
        const packed = u != null || ctx.schema.inlineCellI32?.has(inlSid)
        const strideB = u ? u.stride * 4 : structInline(ctx.schema.list[inlSid].length, packed).cpe * 8
        const pureIndex = isPureIR(vi), fast = idxProvenInBounds && pureIndex
        const baseI32 = tempI32('ab'), idxI32 = fast ? null : tempI32('ai')
        const base = fast ? ['local.tee', `$${baseI32}`, arrBase()] : ['local.get', `$${baseI32}`]
        const index = fast ? vi : ['local.get', `$${idxI32}`]
        const cell = typed(['i32.add', base, ['i32.mul', index, ['i32.const', strideB]]], 'i32')
        cell.ptrKind = VAL.OBJECT
        if (inlSid != null) cell.ptrAux = inlSid
        if (packed) cell.cellI32 = true
        if (u) cell.unionKey = u.key
        if (fast) return cell
        // Evaluate the receiver before the key, but follow relocation after
        // an effectful key. A call can grow this array or rebind its name.
        const capture = pureIndex ? null : temp('ar')
        const pre = pureIndex
          ? [['local.set', `$${baseI32}`, arrBase()], ['local.set', `$${idxI32}`, vi]]
          : [['local.set', `$${capture}`, ptrExpr], ['local.set', `$${idxI32}`, vi],
            ['local.set', `$${baseI32}`, arrBase(['local.get', `$${capture}`], false)]]
        if (idxProvenInBounds) return Object.assign(typed(['block', ['result', 'i32'], ...pre, cell], 'i32'),
          { ptrKind: cell.ptrKind, ptrAux: cell.ptrAux, cellI32: cell.cellI32, unionKey: cell.unionKey })
        // The header counts physical eight-byte cells. Keep absence boxed until
        // a projection requires an object; merely saving an OOB cursor is valid.
        const len = fixedLen != null ? ['i32.const', fixedLen]
          : ['i32.div_u', ['i32.shl', ['i32.load', ['i32.sub', base, ['i32.const', 8]]], ['i32.const', 3]], ['i32.const', strideB]]
        const throwing = node != null && node === ctx.func.throwAbsent
        const rd = typed(['block', ['result', 'f64'], ...pre,
          ['if', ['result', 'f64'], ['i32.lt_u', ['local.get', `$${idxI32}`], len],
            ['then', asF64(cell)], ['else', throwing ? throwTypeErrorIR() : undefExpr()]]], 'f64')
        if (packed) rd.cellI32 = true
        if (u) rd.unionKey = u.key
        if (throwing) rd.presentRead = true
        return rd
      }
      // Known-ARRAY → __arr_idx (single forwarding follow + inline bounds check),
      // not __typed_idx (which does __len + __ptr_offset = two forwarding follows
      // plus type-dispatch overhead irrelevant for plain arrays).
      // Inline fast path for any known plain ARRAY + numeric key: the type-tag
      // dispatch and bounds check inside __arr_idx(_known) are dead weight in hot
      // kernels — most visibly AST walkers doing `node[i]` over heterogeneous
      // arrays, where no element schema/valType is ever inferred. Emit the
      // f64.load directly. base goes through __ptr_offset (still the forwarding
      // follow), and hoistAddrBase CSEs the (base, i) pair across the iteration
      // body. taggedLinear stores every element as one 8-byte f64 cell —
      // Array<NUMBER>/<STRING>/<OBJECT> alike — so a direct f64.load is correct
      // regardless of elem kind (raw f64 for NUMBER, NaN-boxed pointer for
      // OBJECT/STRING; downstream typed() handles both). The load shape is fixed
      // by the carrier, not by any rep fact, so we do NOT gate on a known element
      // schema/valType: a bare `let a = [...]` walked by index gets the same
      // inline load as an Array<{x,y,z}>. (structInline arrays returned above via
      // inlineArraySid; typed arrays are VAL.TYPED, handled below.)
      //
      // Take the UNCHECKED inline load only when the index is proven in-bounds by
      // an enclosing canonical loop `for (let i=C; i<arr.length; i++)` — a pure
      // index<length structural proof (scanBoundedArrIdx, src/type.js), itself
      // element-kind-independent. Skipping the bounds check on an arbitrary numeric
      // index is unsound: `a[1]` on a length-1 array would read the raw cell instead
      // of undefined; those fall through to the inline bounds-checked load below.
      // A static const array's literal length bounds an index whose integer hull
      // stays under it (`[2, 4, 2, 9][t >> 17 & 3]`, a literal prepare hoisted to a
      // const): never resized nor aliased, its length is the literal's for good.
      // Tag reads whose receiver folded to a compile-time constant box: when the
      // decl registers the same bits as a STATIC array (ctx.scope.staticArrs) and
      // the program never resizes/aliases the name, optimize's
      // foldStaticConstArrayReads collapses base+len to literals (the decl's
      // data-segment offset isn't known until module init emits, so emit can
      // only tag — same phasing as the constFnArrays devirt).
      const saTag = (node) => {
        if (typeof arr !== 'string') return node
        // Identity proof, either form: the receiver resolved to a DIRECT read of the
        // module global `arr` (global names are unique — same name the decl registers),
        // or it already folded to a constant box whose bits the decl records. A local
        // shadowing `arr` emits a local.get receiver — neither form matches, no tag.
        if (Array.isArray(ptrExpr) && ptrExpr[0] === 'global.get' && ptrExpr[1] === `$${arr}`) node.saArr = arr
        else {
          const bits = extractF64Bits(ptrExpr)
          if (bits !== null) { node.saArr = arr; node.saBits = bits }
        }
        return node
      }
      if (idxProvenInBounds) {
        // base local must be i32. Flat tee form so downstream peepholes can fold
        // `i32.wrap_i64 (i64.reinterpret_f64 (f64.load …))` → `i32.load …`
        // when this load feeds a ptrUnboxed OBJECT field.
        const baseI32 = tempI32('ab')
        return typed(saTag(value(ctx.abi.array.ops.load(
          ['local.tee', `$${baseI32}`, arrBase()],
          vi))), 'f64')
      }
      // Known plain array, numeric key, NOT proven in-bounds → inline bounds-checked
      // load: `idx < len ? load : undefined`. Same semantics as __arr_idx_known but
      // inline, so watr hoists the loop-invariant len load and CSEs the base — the
      // residual cost is a single (predictable) compare per access, not a call. Skipping
      // the check would read raw memory for OOB indices (e.g. `a[1]` on a length-1 array).
      if (keyIsNum) {
        const idxI32 = tempI32('ai')
        // The read is a receiver whose consumer throws on a missing value
        // (the nullable paths above): the miss arm throws here instead.
        const throwing = node != null && node === ctx.func.throwAbsent
        // The receiver is a variable read here (an expression was captured
        // above), so its base is spelled out at both the length and the cell:
        // a loop that writes no header hoists each as an invariant of its own
        // (optimize/licm.js), where a temp shared between them would keep the
        // length load inside; watr's value numbering merges what stays.
        const rd = typed(saTag(['if', ['result', 'f64'],
          ['i32.lt_u',
            ['local.tee', `$${idxI32}`, vi],
            fixedLen != null ? ['i32.const', fixedLen] : ['i32.load', ['i32.sub', arrBase(), ['i32.const', 8]]]],
          ['then', value(ctx.abi.array.ops.load(arrBase(), ['local.get', `$${idxI32}`]))],
          ['else', throwing ? throwTypeErrorIR() : undefExpr()]]), 'f64')
        if (throwing && dense) rd.presentRead = true
        // Same number|undefined contract as the typed checked read — but ONLY
        // when the elements are PROVEN numeric (arrayElemValType): a plain
        // array is heterogeneous, and tagging a string-element read would make
        // toNumF64 skip the full ToNumber ("hi" * 2 must be NaN, not the
        // pointer payload riding f64.mul to the boundary). Numeric-proven
        // dense receivers get the fold (miss arm → canonical NaN); a hole
        // may also be undefined in the hit arm and keeps ordinary coercion.
        if (dense && typeof arr === 'string' && ctx.func.localReps?.get(arr)?.arrayElemValType === VAL.NUMBER)
          rd.checkedNumRead = true
        return rd
      }
      const baseTmp = temp()
      // A present Number keeps the element path; boxed keys need ToPropertyKey.
      if (useRuntimeKeyDispatch && !keyIsNum)
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${baseTmp}`, ptrExpr],
          emitDynamicKeyDispatch(typed(['local.get', `$${baseTmp}`], 'f64'), keyExpr => {
            const keyI32 = keyIndex(typed(keyExpr, 'f64'))
            inc('__arr_idx')
            return (['call', '$__arr_idx', ['i64.reinterpret_f64', ['local.get', `$${baseTmp}`]], keyI32])
          })], 'f64')
      inc('__arr_idx_known')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${baseTmp}`, ptrExpr],
        (['call', '$__arr_idx_known', ['i64.reinterpret_f64', ['local.get', `$${baseTmp}`]], vi])], 'f64')
    }
    // A Number key indexes a code unit. Boxed keys still need ToPropertyKey,
    // even when the receiver's string kind is settled.
    if (vt === 'string') {
      if (useRuntimeKeyDispatch)
        return emitDynamicKeyDispatch(ptrExpr, key => {
          inc('__str_idx')
          return ['call', '$__str_idx', ['i64.reinterpret_f64', ptrExpr], keyIndex(typed(key, 'f64'))]
        })
      return typed(stringLoad(), 'f64')
    }
    // Known typed-array (ctor unknown — bimorphic call sites). Skip str-key dispatch
    // since arr is provably never a string. Inner __typed_idx still ctor-dispatches.
    // Key narrowing: if idx is provably NUMBER (via lookupValType on the name), the
    // str-key check is dead — emit the direct __typed_idx call. Other key shapes keep
    // the runtime str_key dispatch (rare for typed arrays but legal: arr['length']).
    if (vt === 'typed') {
      const keyIsNum = numericKey
      if (useRuntimeKeyDispatch && !keyIsNum)
        return emitDynamicKeyDispatch(ptrExpr, keyExpr => {
          const keyI32 = keyIndex(typed(keyExpr, 'f64'))
          return (['call', `$${runtimeElemRead}`, ['i64.reinterpret_f64', ptrExpr], keyI32])
        })
      return typed((['call', `$${runtimeElemRead}`, ['i64.reinterpret_f64', ptrExpr], vi]), 'f64')
    }
    // Pure-write narrowing: an `xs[i] = v` / `xs.length = n` site in this
    // body, with no offsetting string-shape evidence (typeof string check,
    // STRING_ONLY method call, string-literal assignment), proves `arr` isn't
    // a primitive string. Skip the runtime `__ptr_type==STRING` gate —
    // `__typed_idx` already handles both ARRAY and TYPED tags internally.
    // Discharge analysis lives in src/infer.js (notStringEvidence source); flow-sensitive
    // notString refinements (from `if (typeof x === 'string') return ...`) overlay via lookup.
    const notString = typeof arr === 'string' && lookupNotString(arr)
    // Cross-call-site CLASS proof (reps.js recvArrTyped, narrow.js
    // hardParamRecvArrTyped — extends the numeric-key unknown-receiver
    // soundness proof below): every live call site passes ARRAY
    // OR TYPED at this position — never necessarily the SAME one (that's `vt`,
    // already handled above), but always one of the two `$__typed_idx` already
    // dispatches on internally. OBJECT/HASH/STRING/etc are EXCLUDED by the
    // proof, so both runtime tag tests below (the ARRAY||TYPED ptrTypeEq guard
    // AND the STRING ptrTypeEq check) are dead — the receiver can never take
    // either's other arm. Collapses straight to the bare `__typed_idx` call,
    // same shape a single-kind-proven `vt` receiver gets. Expressed via
    // isDisjointFrom (reps.js, .work/archive/lattice-design.md §5 Slice 2 precedent) —
    // same computation, now through the projection idiom later slices reuse.
    const recvArrTyped = typeof arr === 'string' && isDisjointFrom(arr, NOT_ARRAY_OR_TYPED)
    // A present Number skips the boxed-key dispatch; its numeric arm is what runs. Fall through
    // to the direct ptr_type==STRING ? __str_idx : __typed_idx form below, which
    // indexes with the i32 `vi` and skips the per-element f64 round-trip + call.
    // Mirrors the `&& !keyIsNum` guard in the known-array/typed branches above.
    if (useRuntimeKeyDispatch && !numericKey)
      return emitDynamicKeyDispatch(ptrExpr, keyExpr => {
        const keyI32 = keyIndex(typed(keyExpr, 'f64'))
        // recvArrTyped: the receiver-CLASS proof above rules out OBJECT/HASH/
        // STRING at every call site, so neither runtime tag test below can ever
        // take its other arm — collapse straight to the bare __typed_idx call.
        if (recvArrTyped) return ['call', `$${runtimeElemRead}`, ['i64.reinterpret_f64', ptrExpr], keyI32]
        // Receiver AND key kind are both statically unproven here (the runtime
        // boxed-key dispatch above already ruled out boxes — this arm is
        // the "real number, unknown receiver" case). ARRAY/TYPED keep the lean
        // ctor-aware element read (__typed_idx); an OBJECT/HASH/CLOSURE receiver
        // with a numeric-looking key (`o={}; o['1']=9; o[numArr[j]]`) instead
        // ToPropertyKey-probes dyn-props via __dyn_get_expr — the SAME contract
        // module/array.js's proven-OBJECT/HASH branches above already use, closing
        // the gap where this fallback silently read undefined through __typed_idx's
        // unrelated __len-bounds-check arm. Mirrored below for the sibling
        // proven-NUMBER-key case (receiver kind, not key kind, decides the fork).
        const numericIndexed = numericProps
          ? ['if', ['result', 'f64'], ptrTypeEq(ptrExpr, PTR.ARRAY),
            ['then', arrayPropertyLoad(keyExpr)],
            ['else', ['call', `$${runtimeElemRead}`, ['i64.reinterpret_f64', ptrExpr], keyI32]]]
          : ['call', `$${runtimeElemRead}`, ['i64.reinterpret_f64', ptrExpr], keyI32]
        const typedOrDyn = ['if', ['result', 'f64'],
          ['i32.or', ptrTypeEq(ptrExpr, PTR.ARRAY), ptrTypeEq(ptrExpr, PTR.TYPED)],
          ['then', numericIndexed],
          ['else', opaqueDynExprLoad(ptrExpr, keyExpr)] ]
        if (ctx.module.modules['string'] && !notString) {
          return ['if', ['result', 'f64'],
            ptrTypeEq(ptrExpr, PTR.STRING),
            ['then', (inc('__str_idx'), ['call', '$__str_idx', ['i64.reinterpret_f64', ptrExpr], keyI32])],
            ['else', typedOrDyn]]
        }
        return typedOrDyn
      })
    // Proven-NUMBER key, receiver kind still unproven (not statically ARRAY/
    // TYPED/STRING/HASH/OBJECT/boxed — every arm above that could prove a
    // receiver kind already returned). Selection between the typed-indexed
    // read and a dyn-props read must depend on the RECEIVER, not the key: an
    // OBJECT/HASH receiver with a numeric-looking key (`o={}; o['1']=9;
    // o[n]` for a proven-NUMBER local `n`) must ToPropertyKey-probe dyn-props
    // exactly like the runtime-dispatched arm above, or the read silently
    // returns undefined for a value that IS present under the stringified key:
    // routing every proven-number key straight to __typed_idx reads raw __len
    // bounds — 0 for a non-array box — instead of the dyn-props sidecar.
    // ARRAY/TYPED still take the lean typed-array
    // read with NO runtime dispatch beyond this one pointer-kind tag test —
    // no __is_str_key/__to_str call, since the key is already proven
    // non-string. `keyTmp` holds the key's f64 form ONCE so both the
    // __typed_idx (i32-truncated) and __dyn_get_expr (boxed f64→key) arms —
    // and the optional STRING pointer-kind check — read the same evaluation
    // of `idx`, matching the single-eval discipline `emitDynamicKeyDispatch`
    // uses above.
    if (keyType === VAL.NUMBER) {
      // recvArrTyped: the receiver-CLASS proof (declared above, reps.js doc)
      // rules out OBJECT/HASH/STRING at every call site — neither the
      // ARRAY||TYPED tag test nor the STRING tag test below can ever take
      // its other arm. Collapse straight to the bare __typed_idx call,
      // reusing the same `arrayLoad` shape the fully-known-`vt` branches use.
      if (recvArrTyped) return typed(arrayLoad, 'f64')
      // `vi` — the SAME i32-narrowed index emitIndex() already produced above
      // (line 768, shared by arrayLoad/stringLoad below) — feeds the fast
      // ARRAY/TYPED arm exactly as `arrayLoad` did before this guard existed:
      // a compound i32 index tree (`j*W+x`) stays pure i32 arithmetic, no f64
      // round-trip, and the shape (ptrTypeEq + vi) is what the i32-narrowing/
      // unswitch/vectorize passes downstream already pattern-match — widening
      // `vi` back to f64 here (an earlier version of this fix did, to feed
      // BOTH arms from one value) still left an `f64.convert_i32_s` in the
      // compiled text and tripped the "index terms stay i32" pin even though
      // it's only ever reached on the cold path.
      // The __dyn_get_expr cold arm (OBJECT/HASH receiver) instead gets its
      // OWN independent f64 evaluation of `idx`, confined entirely to this
      // arm — safe (no double side-effect) because at most ONE of the two
      // branches runs per call: the hot arm consumes `vi`'s single line-768
      // evaluation, the cold arm consumes this one, and only one is ever
      // reached at runtime. Exact ToPropertyKey semantics (no truncation) at
      // the cost of a second (unreachable-together) codegen of `idx`, same
      // discipline `emitDynamicKeyDispatch`'s sibling arm above already uses
      // for its own single `emit(idx)`.
      // storedValue (not asF64(emit(idx))): READ-side sibling of MECHANISM A
      // (.work/archive/todo.md §deletion-sweep Finding #2) — this arm fires exactly
      // when keyType === VAL.NUMBER, which is what an ambiguous BOOL∪NUMBER
      // merge key statically collapses to; the cold arm must see the boxed
      // atom, not the raw collapsed bits.
      // The hot arm is `arrayLoad`: the array read inline (an AST node under
      // a walker reads `node[0]` here), the typed read through the helper.
      const guarded = ['if', ['result', 'f64'],
        ['i32.or', ptrTypeEq(ptrExpr, PTR.ARRAY), ptrTypeEq(ptrExpr, PTR.TYPED)],
        ['then', arrayLoad],
        ['else', opaqueDynExprLoad(ptrExpr, storedValue(idx))] ]
      if (ctx.module.modules['string'] && !notString)
        return typed(['if', ['result', 'f64'],
          ptrTypeEq(ptrExpr, PTR.STRING),
          ['then', stringLoad()],
          ['else', guarded]], 'f64')
      return typed(guarded, 'f64')
    }
    // Unknown → runtime dispatch (string module loaded → check ptr_type)
    if (ctx.module.modules['string'] && !notString)
      return typed(
        ['if', ['result', 'f64'],
          ptrTypeEq(ptrExpr, PTR.STRING),
          ['then', stringLoad()],
          ['else', arrayLoad]],
        'f64')
    return typed(arrayLoad, 'f64')
  }

  // === Push/Pop (mutate in place) ===

  // .push(val) → append, increment len, return array (possibly reallocated pointer)
  ctx.core.emit['.push'] = (arr, ...vals) => {
    // `_expect` is overwritten by recursive emit() calls below. Capture the
    // statement-position hint now so a dropped `xs.push(v)` can skip computing
    // the JS return length while still performing the mutation/writeback.
    const void_ = ctx.func._expect === 'void'
    const reserved = arrayCapacity(arr) != null
    // structInline Array<S>: `.push({S})` writes the K schema fields as
    // consecutive cells. Flatten the struct literal into K schema-ordered
    // field-value nodes and fall through to the general multi-value store path
    // — `len`/`cap` count physical 8-byte cells, so `__arr_grow_known` and the
    // cell loop are reused untouched; `.push` then returns the logical element
    // count (`len / cellsPerElem`). K=1 stays a single value → the
    // `__arr_push1` fast path. Packed schemas (inlineCellI32) store K raw i32
    // fields into ⌈K/2⌉ cells — the store loop below branches per layout.
    const inlUnion = typeof arr === 'string' ? inlineArrayUnion(arr) : null
    let inlSid = inlineArraySid(arr)
    let inlK = inlSid != null ? ctx.schema.list[inlSid].length : 0
    let inlPacked = inlSid != null && ctx.schema.inlineCellI32?.has(inlSid)
    let inlCpe = inlSid != null ? structInline(inlK, inlPacked).cpe : 1
    let unionB = 0                  // byte stride of a union element (0 = not a union push)
    if (inlUnion) {
      // BYTE-STRIDE union push: each member literal stores its OWN K fields
      // at slots 0..K-1 then zero-fills to the uniform `stride` i32 lanes —
      // a record is stride·4 bytes with NO pad cell (stride 5 → 20 B, not
      // 24). The union-specific store loop below keeps the header len in
      // physical 8-byte cells (⌈n·strideB/8⌉ — alloc/grow untouched).
      const flat = []
      for (const v of vals) {
        const parsed = Array.isArray(v) && v[0] === '{}' ? staticObjectProps(v.slice(1)) : null
        const msid = parsed ? ctx.schema.register(parsed.names, parsed.brand) : null
        if (msid == null || !inlUnion.sids.includes(msid))
          err(`Array.push on this union-typed array expects a literal matching one of: ${inlUnion.sids.map(sid => `{ ${ctx.schema.list[sid].join(', ')} }`).join(' or ')}`)
        const fields = structLiteralFields(v, msid)
        flat.push(...fields)
        for (let z = fields.length; z < inlUnion.stride; z++) flat.push([, 0])
      }
      vals = flat
      unionB = inlUnion.stride * 4
    }
    if (inlSid != null && !inlUnion) {
      const flat = []
      for (const v of vals) {
        const fields = structLiteralFields(v, inlSid)
        if (!fields) err(`structInline Array.push expects { ${ctx.schema.list[inlSid].join(', ')} } literal arguments`)
        flat.push(...fields)
      }
      vals = flat
    }
    // Physical cells this push appends (grow target + len increment basis).
    // Union: ⌈elems·strideB/8⌉ — a safe over-reserve (ceil(a+b) ≤ ceil a + ceil b).
    const pushCells = unionB ? Math.ceil((vals.length / inlUnion.stride) * unionB / 8)
      : inlPacked ? inlCpe * (vals.length / inlK) : vals.length
    // Out-of-line fast path: single value, named known-ARRAY receiver. One call +
    // var update instead of ~30 inlined instructions — the dominant size cost of
    // push-heavy code (e.g. watr's WASM emitter).
    if (!reserved && vals.length === 1 && typeof arr === 'string' && lookupValType(arr) === VAL.ARRAY) {
      inc('__arr_push1')
      const box = ctx.func.boxed?.get(arr)
      const isGlobal = !box && ctx.scope.globals.has(arr) && !ctx.func.locals?.has(arr)
      const readVar = box ? ['f64.load', ['local.get', `$${box}`]] : isGlobal ? ['global.get', `$${arr}`] : ['local.get', `$${arr}`]
      const writeVar = v => box ? ['f64.store', ['local.get', `$${box}`], v] : isGlobal ? ['global.set', `$${arr}`, v] : ['local.set', `$${arr}`, v]
      const vv = taggedStoredValue(vals[0])
      const pushed = ['call', '$__arr_push1', ['i64.reinterpret_f64', readVar], vv]
      if (void_) return typed(['block', writeVar(pushed)], 'void')
      return typed(['block', ['result', 'f64'],
        writeVar(pushed),
        ['f64.convert_i32_s', ['i32.load', ['i32.sub',
          ['call', '$__ptr_offset', ['i64.reinterpret_f64', readVar]], ['i32.const', 8]]]]], 'f64')
    }
    const va = asF64(emit(arr))
    const t = temp('pp'), len = tempI32('pl')
    // The pointer may relocate on grow: a named receiver is rebound to it (an
    // expression receiver reaches the moved buffer through forwarding).
    const writeBack = (body) => {
      if (typeof arr !== 'string') return
      if (ctx.func.boxed?.has(arr))
        body.push(['f64.store', ['local.get', `$${ctx.func.boxed.get(arr)}`], ['local.get', `$${t}`]])
      else if (ctx.scope.globals.has(arr) && !ctx.func.locals?.has(arr))
        body.push(['global.set', `$${arr}`, ['local.get', `$${t}`]])
      else
        body.push(['local.set', `$${arr}`, ['local.get', `$${t}`]])
    }

    // Known ARRAY → inline len as `i32.load(off - 8)` (ARRAY branch of __len). Saves a
    // full __ptr_type + dispatch per push site. The off<8 nullish guard in __len is
    // unreachable here: .push on a nullish var is a JS error before we get here.
    const vt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    const inlineLen = vt === VAL.ARRAY

    // Multi-cell element (structInline / union) on a known ARRAY pushed from
    // several sites of this function: __arr_push_slot reserves the element out
    // of line and each site stores only its fields, instead of the grow-and-
    // index sequence expanded per literal site. A lone site keeps the inline
    // sequence (the helper alone outweighs it).
    const pushSites = name => scanBindingUses(ctx.func.body).get(name)?.[BINDING_USE_USES]
      .filter(u => u[BINDING_USE_KIND] === USE.MEMBER_CALL && u[BINDING_USE_KEY] === 'push').length || 0
    if (inlineLen && (unionB || (inlSid != null && inlK > 1)) && typeof arr === 'string' && ctx.func.body && pushSites(arr) > 1) {
      const helper = reserved ? '__arr_push_slot_fixed' : '__arr_push_slot'
      inc(helper)
      const strideB = unionB || inlCpe * 8
      const lanes = unionB ? inlUnion.stride : inlK
      const laneB = unionB || inlPacked ? 4 : 8
      const slot = tempI32('ps')
      const body = [['local.set', `$${t}`, va]]
      const isZeroLit = (v) => Array.isArray(v) && v[0] == null && v[1] === 0
      for (let e = 0; e < vals.length; e += lanes) {
        // A union member's padding lanes are literal zeros: the helper clears
        // the element and the site skips them.
        const zero = unionB && vals.slice(e, e + lanes).some(isZeroLit) ? 1 : 0
        body.push(['local.set', `$${t}`, ['local.set', `$${slot}`,
          ['call', `$${helper}`, ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['i32.const', strideB], ['i32.const', zero]]]])
        for (let j = 0; j < lanes; j++) {
          if (zero && isZeroLit(vals[e + j])) continue
          const addr = j === 0 ? ['local.get', `$${slot}`] : ['i32.add', ['local.get', `$${slot}`], ['i32.const', j * laneB]]
          body.push(laneB === 4 ? ['i32.store', addr, asI32(emit(vals[e + j]))]
            : ['f64.store', addr, taggedStoredValue(vals[e + j])])
        }
      }
      writeBack(body)
      if (void_) return typed(['block', ...body], 'void')
      body.push(['f64.convert_i32_s', ['i32.div_u',
        ['i32.shl', ['i32.load', ['i32.sub',
          ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]], ['i32.const', 8]]], ['i32.const', 3]],
        ['i32.const', strideB]]])
      return typed(['block', ['result', 'f64'], ...body], 'f64')
    }

    const grow = inlineLen ? '__arr_grow_known' : '__arr_grow'
    if (!reserved) inc(grow)

    const body = [
      ['local.set', `$${t}`, va],
    ]
    const pushBase = tempI32('pb')
    // An own-name-current receiver holds the live pointer (and a grow's result
    // is fresh), so its base is the raw offset; anything else follows forwarding.
    const current = typeof arr === 'string' && currentBinding(arr)
    const baseOf = () => current
      ? ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['i64.const', LAYOUT.OFFSET_MASK]]]
      : ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]
    if (inlineLen) {
      // Hoist offset once; reuse for len load, cap-fits check, store base, and
      // post-grow rebase. On cap-fits (the common path) we skip __arr_grow's call
      // dispatch and prologue entirely; on grow we re-extract offset because the
      // alloc may have relocated the buffer.
      body.push(
        ['local.set', `$${pushBase}`, baseOf()],
        ['local.set', `$${len}`,
          ['i32.load', ['i32.sub', ['local.get', `$${pushBase}`], ['i32.const', 8]]]],
      )
      if (!reserved) body.push(
        ['if',
          ['i32.lt_s',
            ['i32.load', ['i32.sub', ['local.get', `$${pushBase}`], ['i32.const', 4]]],
            ['i32.add', ['local.get', `$${len}`], ['i32.const', pushCells]]],
          ['then',
            ['local.set', `$${t}`, ['call', `$${grow}`, ['i64.reinterpret_f64', ['local.get', `$${t}`]],
              ['i32.add', ['local.get', `$${len}`], ['i32.const', pushCells]]]],
            ['local.set', `$${pushBase}`, baseOf()]]],
      )
    } else {
      body.push(
        ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
        // Grow if needed: ensure cap >= len + pushCells
        ['local.set', `$${t}`, ['call', `$${grow}`, ['i64.reinterpret_f64', ['local.get', `$${t}`]],
          ['i32.add', ['local.get', `$${len}`], ['i32.const', pushCells]]]],
        ['local.set', `$${pushBase}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
      )
    }

    const ulg = unionB ? tempI32('ul') : null
    if (unionB) {
      // BYTE-STRIDE union store: logical count ⌊len·8/strideB⌋ (exact — see
      // the [] arm), byte cursor from it; each element writes `stride` raw
      // i32 lanes then advances by strideB bytes; the header len lands back
      // in physical cells as ⌈logical·strideB/8⌉.
      const nl = inlUnion.stride
      const ubc = tempI32('uc')
      body.push(
        ['local.set', `$${ulg}`, ['i32.div_s', ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]], ['i32.const', unionB]]],
        ['local.set', `$${ubc}`, ['i32.add', ['local.get', `$${pushBase}`], ['i32.mul', ['local.get', `$${ulg}`], ['i32.const', unionB]]]])
      for (let e = 0; e < vals.length; e += nl) {
        for (let j = 0; j < nl; j++)
          body.push(['i32.store',
            j === 0 ? ['local.get', `$${ubc}`] : ['i32.add', ['local.get', `$${ubc}`], ['i32.const', j * 4]],
            asI32(emit(vals[e + j]))])
        body.push(
          ['local.set', `$${ubc}`, ['i32.add', ['local.get', `$${ubc}`], ['i32.const', unionB]]],
          ['local.set', `$${ulg}`, ['i32.add', ['local.get', `$${ulg}`], ['i32.const', 1]]])
      }
      body.push(['local.set', `$${len}`,
        ['i32.shr_s', ['i32.add', ['i32.mul', ['local.get', `$${ulg}`], ['i32.const', unionB]], ['i32.const', 7]], ['i32.const', 3]]])
    } else if (inlPacked) {
      // Packed i32 cells: per element, K raw i32 stores at `base + len*8 + j*4`
      // (schema order — structLiteralFields already ordered the flatten), then
      // len advances by ⌈K/2⌉ physical cells. Values are exact by the
      // slotI32Certain census (packing precondition).
      for (let e = 0; e < vals.length; e += inlK) {
        for (let j = 0; j < inlK; j++) {
          const off = ['i32.add', ['local.get', `$${pushBase}`], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]
          body.push(['i32.store', j === 0 ? off : ['i32.add', off, ['i32.const', j * 4]], asI32(emit(vals[e + j]))])
        }
        body.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['i32.const', inlCpe]]])
      }
    } else {
      // Store each value and increment len
      for (const val of vals) {
        const vv = taggedStoredValue(val)
        body.push(
          ['f64.store',
            ['i32.add', ['local.get', `$${pushBase}`], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]],
            vv],
          ['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['i32.const', 1]]]
        )
      }
    }

    // Update length header (write directly via the offset we already hold —
    // skips __set_len's tag/forward dispatch), update source variable (pointer
    // may have changed from grow), return new length
    body.push(['i32.store', ['i32.sub', ['local.get', `$${pushBase}`], ['i32.const', 8]], ['local.get', `$${len}`]])
    writeBack(body)
    if (void_) return typed(['block', ...body], 'void')
    // structInline: `len` counts physical cells — `.push` returns the JS array
    // length, i.e. the logical element count (byte-stride unions carry it in
    // `ulg` directly; cell carriers divide by cells-per-element).
    const lenDiv = inlPacked ? inlCpe : inlK
    body.push(['f64.convert_i32_s', unionB ? ['local.get', `$${ulg}`]
      : lenDiv > 1
        ? ['i32.div_s', ['local.get', `$${len}`], ['i32.const', lenDiv]]
        : ['local.get', `$${len}`]])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // .pop() → decrement len, return removed element
  ctx.core.emit['.pop'] = (arr) => {
    const va = asF64(emit(arr))
    const t = temp('po'), len = tempI32('pl')
    // Known ARRAY → inline len (skips __len dispatch tree).
    const vt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    if (vt === VAL.ARRAY) {
      // The data offset once, with the forwarding hop inline (the chase stays
      // outlined); a shrink never relocates, so it serves the load too.
      const off = tempI32('pf')
      inc('__ptr_offset_fwd')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, va],
        ['local.set', `$${off}`, ['i32.wrap_i64', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
        ['if', ['i32.and', ['i32.ge_u', ['local.get', `$${off}`], ['i32.const', 8]],
                 ['i32.and', ['i64.le_u', ['i64.extend_i32_u', ['local.get', `$${off}`]], ['global.get', '$__heap_end64']],
                             ['i32.eq', ['i32.load', ['i32.sub', ['local.get', `$${off}`], ['i32.const', 4]]], ['i32.const', -1]]]],
          ['then', ['local.set', `$${off}`, ['call', '$__ptr_offset_fwd', ['local.get', `$${off}`]]]]],
        ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${off}`], ['i32.const', 8]]]],
        ['if', ['result', 'f64'], ['i32.eqz', ['local.get', `$${len}`]],
          ['then', undefExpr()],
          ['else',
            ['local.set', `$${len}`, ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]]],
            ['call', '$__set_len', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['local.get', `$${len}`]],
            arrayValue(['f64.load', ['i32.add', ['local.get', `$${off}`], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]])]]], 'f64')
    }
    const rawLen = ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, va],
      ['local.set', `$${len}`, rawLen],
      ['if', ['result', 'f64'], ['i32.eqz', ['local.get', `$${len}`]],
        ['then', undefExpr()],
        ['else',
          ['local.set', `$${len}`, ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]]],
          ['call', '$__set_len', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['local.get', `$${len}`]],
          arrayValue(['f64.load',
            ['i32.add', ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]])]]], 'f64')
  }

  // .shift() → remove first element, shift remaining left, return removed
  ctx.core.emit['.shift'] = (arr) => (inc('__arr_shift'),
    typed(['call', '$__arr_shift', asI64(emit(arr))], 'f64'))

  // .shift moves the header up one slot (see arrBaseWat above the grow):
  // the vacated slot takes the new header's len/cap, the old header's words
  // take the mark [base, -1], and the base's record forwards to the new
  // header. durableFwdLogIR on the off->newOff mark below: unlike grow (whose
  // newOff is always a FRESH allocation, unconditionally ephemeral whenever
  // off reads durable), shift's newOff is just off+8 — normally still in the
  // SAME durability class as off, so a shift of a durable array is ordinarily
  // legitimate persistent state that must survive `_clear`. It only crosses
  // into ephemeral in the one-in-8-bytes edge case where off sits exactly at
  // __heap_reset-8, which durableFwdLogIR's two-sided check (source durable
  // AND target ephemeral) catches without misfiring on the common case. The
  // base's record needs no log of its own: a durable base's header already
  // holds a forward, restored wholesale by whichever earlier relocation
  // logged it.
  ctx.core.stdlib['__arr_shift'] = () => `(func $__arr_shift (param $arr i64) (result f64)
    (local $off i32) (local $base i32) (local $newOff i32) (local $len i32) (local $cap i32) (local $val f64)
    ${needsArrayDynMove() ? '(local $oldProps f64) (local $root f64)' : ''}
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (if (result f64) (i32.lt_u (local.get $off) (i32.const 8))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
        (if (result f64) (i32.le_s (local.get $len) (i32.const 0))
          (then (f64.const nan:${UNDEF_NAN}))
          (else
            (local.set $val (call $__arr_value (f64.load (local.get $off))))
            (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
            (local.set $newOff (i32.add (local.get $off) (i32.const 8)))
            ${arrBaseWat('$off', '$base')}
            ${headerPropsToGlobalIR()}
            ;; the vacated slot: the new header's len/cap
            (i32.store (local.get $off) (i32.sub (local.get $len) (i32.const 1)))
            (i32.store (i32.add (local.get $off) (i32.const 4))
              (select (i32.sub (local.get $cap) (i32.const 1)) (i32.const 0) (i32.gt_s (local.get $cap) (i32.const 0))))
            ${maybeDynMoveIR()}
            ${durableFwdLogIR('off', 'newOff', 'len', 'cap')}
            ;; the old header's words: the new header's mark (see arrBaseWat)
            (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $base))
            (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
            ;; the base forwards to the live header
            (i32.store (i32.sub (local.get $base) (i32.const 8)) (local.get $newOff))
            (i32.store (i32.sub (local.get $base) (i32.const 4)) (i32.const -1))
            (local.get $val))))))`

  // .fill(value, start?, end?) — overwrite [start, end) with value; mutate + return the
  // array. start/end default to 0 / length and accept negatives (offset from end). The
  // INT_MAX end sentinel clamps to length in the helper, which also normalizes negatives.
  ctx.core.emit['.fill'] = (arr, val, start, end) => {
    inc('__arr_fill')
    // The receiver and the value first, then the positions: ToIntegerOrInfinity
    // (23.1.3.7 steps 6/8) through positionArgs, which converts a string,
    // rejects a BigInt and saturates ±Infinity for __clamp_idx.
    const recv = temp('afr'), value = temp('afv'), positions = positionArgs([start, end])
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${recv}`, asF64(emit(arr))],
      ['local.set', `$${value}`, val == null ? undefExpr() : asF64(taggedStoredValue(val))],
      ...positions.setup,
      ['call', '$__arr_fill',
        ['i64.reinterpret_f64', ['local.get', `$${recv}`]],
        ['local.get', `$${value}`],
        positions.index(0, ['i32.const', 0]),
        positions.index(1, ['i32.const', 0x7FFFFFFF])]], 'f64')
  }

  ctx.core.stdlib['__arr_fill'] = `(func $__arr_fill (param $arr i64) (param $val f64) (param $start i32) (param $end i32) (result f64)
    (local $off i32) (local $len i32) (local $i i32)
    (if (i32.eq
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $arr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${PTR.ARRAY}))
      (then
        (local.set $off (call $__ptr_offset (local.get $arr)))
        (if (i32.ge_u (local.get $off) (i32.const 8))
          (then
            ${durableArrSnapIR('off')}
            (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (local.set $start (call $__clamp_idx (local.get $start) (local.get $len)))
            (local.set $end (call $__clamp_idx (local.get $end) (local.get $len)))
            (local.set $i (local.get $start))
            (block $done (loop $fill
              (br_if $done (i32.ge_s (local.get $i) (local.get $end)))
              (f64.store (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))) (local.get $val))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $fill)))))))
    (f64.reinterpret_i64 (local.get $arr)))`

  // .splice(start) | .splice(start, deleteCount) → remove range, return removed as new array.
  // No-insert-args overload — a SEPARATE inline-IR emitter from the __arr_splice stdlib
  // function below (which only handles the WITH-inserts overload), so it needs its own
  // durable header-length log rather than inheriting one from that path:
  // durableArrSnapNode below closes both at once (header len/cap AND element data,
  // one call).
  ctx.core.emit['.splice'] = (arr, start, deleteCount) => {
    if (needsDurableFwdLog()) inc('__durable_arr_snap')  // explicit edge — see durableArrSnapIR's comment
    const recv = hoistArrayValue(arr)
    const va = recv.value
    // ToIntegerOrInfinity position arg (23.1.3.30 step 3) — asI32Sat, not asI32 (see
    // src/ir.js's doc comment): ±Infinity must saturate to INT32_MAX/MIN so the inline
    // [0,len] clamp below reads it as "past the end", not asI32's wrap-to -1/0.
    const positions = positionArgs([start, deleteCount])
    const vs = positions.index(0, ['i32.const', 0])
    const s = tempI32('sps'), cnt = tempI32('spc'), len = tempI32('spl'), off = tempI32('spo'), j = tempI32('spj')
    const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${cnt}`], tag: 'sp' })
    const id = freshId(ctx)
    // Known ARRAY → fuse len with offset (__len would re-compute __ptr_offset + dispatch).
    const svt = typeof arr === 'string' ? lookupValType(arr) : valTypeOf(arr)
    const lenInit = svt === VAL.ARRAY
      ? ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${off}`], ['i32.const', 8]]]]
      : ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', va]]]
    const body = [
      recv.setup,
      ...positions.setup,
      ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', va]]],
      lenInit,
      durableArrSnapNode(off),
      // clamp start to [0, len]
      ['local.set', `$${s}`, vs],
      ['if', ['i32.lt_s', ['local.get', `$${s}`], ['i32.const', 0]],
        ['then',
          ['local.set', `$${s}`, ['i32.add', ['local.get', `$${s}`], ['local.get', `$${len}`]]],
          ['if', ['i32.lt_s', ['local.get', `$${s}`], ['i32.const', 0]],
            ['then', ['local.set', `$${s}`, ['i32.const', 0]]]]]],
      ['if', ['i32.gt_s', ['local.get', `$${s}`], ['local.get', `$${len}`]],
        ['then', ['local.set', `$${s}`, ['local.get', `$${len}`]]]],
      // compute count: no start deletes nothing, a start without a count
      // deletes to the end (23.1.3.31 steps 7-8)
      start === undefined ? ['local.set', `$${cnt}`, ['i32.const', 0]]
        : deleteCount === undefined
        ? ['local.set', `$${cnt}`, ['i32.sub', ['local.get', `$${len}`], ['local.get', `$${s}`]]]
        : ['block',
            // asI32Sat (ditto): a huge/Infinity deleteCount must saturate to INT32_MAX, not
            // wrap negative. Compare against `len - s` (always small, never overflows) rather
            // than `s + cnt > len` — with cnt at INT32_MAX, `s + cnt` itself overflows i32 and
            // wraps negative, which would skip the clamp-down branch entirely (real bug: an
            // uncaught deleteCount:Infinity would fall through with cnt still at INT32_MAX and
            // OOB the removed-elements memory.copy below).
            ['local.set', `$${cnt}`, positions.index(1, ['i32.const', 0])],
            ['if', ['i32.lt_s', ['local.get', `$${cnt}`], ['i32.const', 0]],
              ['then', ['local.set', `$${cnt}`, ['i32.const', 0]]]],
            ['if', ['i32.gt_s',
                ['local.get', `$${cnt}`],
                ['i32.sub', ['local.get', `$${len}`], ['local.get', `$${s}`]]],
              ['then', ['local.set', `$${cnt}`,
                ['i32.sub', ['local.get', `$${len}`], ['local.get', `$${s}`]]]]]],
      // allocate result array of size cnt
      out.init,
      // copy removed elements into new array
      ['memory.copy',
        ['local.get', `$${out.local}`],
        ['i32.add', ['local.get', `$${off}`], ['i32.shl', ['local.get', `$${s}`], ['i32.const', 3]]],
        ['i32.shl', ['local.get', `$${cnt}`], ['i32.const', 3]]],
      // shift remaining elements left: copy arr[s+cnt..len] → arr[s..]
      ['memory.copy',
        ['i32.add', ['local.get', `$${off}`], ['i32.shl', ['local.get', `$${s}`], ['i32.const', 3]]],
        ['i32.add', ['local.get', `$${off}`], ['i32.shl',
          ['i32.add', ['local.get', `$${s}`], ['local.get', `$${cnt}`]], ['i32.const', 3]]],
        ['i32.shl',
          ['i32.sub', ['i32.sub', ['local.get', `$${len}`], ['local.get', `$${s}`]], ['local.get', `$${cnt}`]],
          ['i32.const', 3]]],
      // update length (write directly via the offset we already hold)
      ['i32.store', ['i32.sub', ['local.get', `$${off}`], ['i32.const', 8]], ['i32.sub', ['local.get', `$${len}`], ['local.get', `$${cnt}`]]],
      out.ptr,
    ]
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // .unshift(...vals) → prepend elements, shift existing right. Multi-arg per ES:
  // `a.unshift(1, 2, 3)` yields [1, 2, 3, …existing] and returns the NEW LENGTH
  // (the helper's contract — it mutates in place; a grow leaves a forwarding
  // pointer so the receiver box stays valid, no write-back). Args EVALUATE
  // left-to-right (spilled to temps in source order) but INSERT last-to-first
  // through the single-value helper so the block lands in argument order; the
  // receiver is evaluated ONCE. (The old emitter silently DROPPED every argument
  // past the first — in the self-compile kernel that broke assemble.js's own
  // `inject.unshift(setBase, ...stores)`, the last byte-parity ordering
  // divergence.)
  ctx.core.emit['.unshift'] = (arr, ...rawVals) => {
    // Flatten comma-grouped args: [',', v1, v2] → [v1, v2] (same unwrap as '{}')
    const vals = rawVals.length === 1 && Array.isArray(rawVals[0]) && rawVals[0][0] === ','
      ? rawVals[0].slice(1) : rawVals
    if (!vals.length) return emit(['.', arr, 'length'])
    inc('__arr_unshift')
    if (vals.length <= 1) {
      const val = vals[0]
      return typed(['call', '$__arr_unshift', asI64(emit(arr)), val === undefined ? undefExpr() : taggedStoredValue(val)], 'f64')
    }
    const recv = temp('usr')
    const temps = vals.map(() => temp('us'))
    const body = [
      ['local.set', `$${recv}`, asF64(emit(arr))],
      ...vals.map((v, i) => ['local.set', `$${temps[i]}`, taggedStoredValue(v)]),
    ]
    for (let i = vals.length - 1; i >= 1; i--)
      body.push(['drop', ['call', '$__arr_unshift', ['i64.reinterpret_f64', ['local.get', `$${recv}`]], ['local.get', `$${temps[i]}`]]])
    body.push(['call', '$__arr_unshift', ['i64.reinterpret_f64', ['local.get', `$${recv}`]], ['local.get', `$${temps[0]}`]])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // durableArrSnapIR fires on the (possibly post-grow) $off, before the shift-copy and
  // prepend store: if __arr_grow relocated, $off is now ephemeral and the guard no-ops
  // (grow's OWN call already protected the OLD block, which nothing here touches
  // in-place anymore); if it didn't relocate (spare capacity), $off is still the
  // ORIGINAL durable address and this is the only protection the shift-copy gets — grow
  // itself only ever logs on ITS relocating path, never on a same-capacity return.
  ctx.core.stdlib['__arr_unshift'] = `(func $__arr_unshift (param $arr i64) (param $val f64) (result f64)
    (local $off i32) (local $len i32) (local $a f64)
    (local.set $a (call $__arr_grow (local.get $arr) (i32.add (call $__len (local.get $arr)) (i32.const 1))))
    (local.set $off (call $__ptr_offset (i64.reinterpret_f64 (local.get $a))))
    ${durableArrSnapIR('off')}
    (local.set $len (call $__len (i64.reinterpret_f64 (local.get $a))))
    (memory.copy
      (i32.add (local.get $off) (i32.const 8))
      (local.get $off)
      (i32.shl (local.get $len) (i32.const 3)))
    (f64.store (local.get $off) (local.get $val))
    (i32.store (i32.sub (local.get $off) (i32.const 8)) (i32.add (local.get $len) (i32.const 1)))
    (f64.convert_i32_s (i32.add (local.get $len) (i32.const 1))))`

  // .splice(start, deleteCount, ...items) with inserts → __arr_splice. Deletes
  // `del` elements at `s`, inserts the elements of `ins`, returns the removed
  // elements as a new array. Mutation is in place: a grow relocates the buffer
  // but leaves a forwarding pointer, so the caller's NaN-box still resolves —
  // no write-back needed (mirrors __arr_unshift). memory.copy is memmove, so the
  // tail shift is correct whether the array grew (shift right) or shrank (left).
  ctx.core.stdlib['__arr_splice'] = `(func $__arr_splice (param $arr i64) (param $start i32) (param $del i32) (param $ins i64) (result f64)
    (local $off i32) (local $len i32) (local $s i32) (local $cnt i32)
    (local $m i32) (local $newLen i32) (local $tail i32) (local $out f64) (local $a f64)
    (local.set $len (call $__len (local.get $arr)))
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $s (local.get $start))
    (if (i32.lt_s (local.get $s) (i32.const 0))
      (then
        (local.set $s (i32.add (local.get $s) (local.get $len)))
        (if (i32.lt_s (local.get $s) (i32.const 0)) (then (local.set $s (i32.const 0))))))
    (if (i32.gt_s (local.get $s) (local.get $len)) (then (local.set $s (local.get $len))))
    (local.set $cnt (local.get $del))
    (if (i32.lt_s (local.get $cnt) (i32.const 0)) (then (local.set $cnt (i32.const 0))))
    (if (i32.gt_s (i32.add (local.get $s) (local.get $cnt)) (local.get $len))
      (then (local.set $cnt (i32.sub (local.get $len) (local.get $s)))))
    (local.set $m (call $__len (local.get $ins)))
    (local.set $newLen (i32.add (i32.sub (local.get $len) (local.get $cnt)) (local.get $m)))
    (local.set $tail (i32.sub (i32.sub (local.get $len) (local.get $s)) (local.get $cnt)))
    (local.set $out (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (call $__alloc_hdr (local.get $cnt) (local.get $cnt))))
    (memory.copy
      (call $__ptr_offset (i64.reinterpret_f64 (local.get $out)))
      (i32.add (local.get $off) (i32.shl (local.get $s) (i32.const 3)))
      (i32.shl (local.get $cnt) (i32.const 3)))
    (local.set $a (f64.reinterpret_i64 (local.get $arr)))
    (if (i32.gt_s (local.get $newLen) (local.get $len))
      (then (local.set $a (call $__arr_grow (local.get $arr) (local.get $newLen)))))
    (local.set $off (call $__ptr_offset (i64.reinterpret_f64 (local.get $a))))
    ${durableArrSnapIR('off')}
    (memory.copy
      (i32.add (local.get $off) (i32.shl (i32.add (local.get $s) (local.get $m)) (i32.const 3)))
      (i32.add (local.get $off) (i32.shl (i32.add (local.get $s) (local.get $cnt)) (i32.const 3)))
      (i32.shl (local.get $tail) (i32.const 3)))
    (memory.copy
      (i32.add (local.get $off) (i32.shl (local.get $s) (i32.const 3)))
      (call $__ptr_offset (local.get $ins))
      (i32.shl (local.get $m) (i32.const 3)))
    (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newLen))
    (local.get $out))`

  registerEarlyExit()

  // === Array methods ===

  // Fusion is only semantics-preserving when callbacks are side-effect-free.
  // A callback with calls or writes to outer state (e.g., `ctx.push(x)`) observes
  // the iteration order; fusing filter().forEach() would interleave them.
  // Conservative purity: no call-expressions (covers method calls, free fn calls);
  // no assignments to names not declared locally in the callback.
  function collectLocals(node, locals) {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string') locals.add(decl[1])
      }
    }
    for (let i = 1; i < node.length; i++) collectLocals(node[i], locals)
  }
  function isPureCallback(fn, setup) {
    if (!Array.isArray(fn) || fn[0] !== '=>') return false
    let view = ctx.summary?.at(fn[2])
    const raw = extractParams(fn[1]), params = new Set()
    for (const r of raw) {
      const p = classifyParam(r)
      if (typeof p[PARAM_NAME] !== 'string') return false   // destructuring can invoke getters
      params.add(p[PARAM_NAME])
    }
    const locals = new Set(params)
    collectLocals(fn[2], locals)
    let pure = true
    const walk = node => {
      if (!pure || !Array.isArray(node)) return
      const op = node[0]
      if (op === '=>') return
      if (runsAccessor(view, node) || runsConversion(view, node)) { pure = false; return }
      if (op === '()' || op === '?.()' || op === 'new') { pure = false; return }
      if (op === '++' || op === '--' || op === 'delete' || op === 'throw' || op === 'await' || op === 'yield') { pure = false; return }
      if (ASSIGN_OPS.has(op)) {
        const target = node[1]
        if (typeof target === 'string') { if (!locals.has(target)) { pure = false; return } }
        else { pure = false; return }
      }
      for (let i = 1; i < node.length; i++) walk(node[i])
    }
    for (const p of raw) if (Array.isArray(p) && p[0] === '=') walk(p[2])
    walk(fn[2])
    // A reduce seed is evaluated after its upstream array is complete. It
    // cannot move ahead of that loop when it writes or invokes user code.
    locals.clear()
    view = ctx.summary?.at(ctx.func.current)
    walk(setup)
    return pure
  }

  // Detect fuseable chain: arr.map(f).filter(g) etc.
  // Returns {source, method, fn} or null.
  function detectUpstream(arr) {
    if (!Array.isArray(arr) || arr[0] !== '()') return null
    const [, callee, ...callArgs] = arr
    if (!Array.isArray(callee) || callee[0] !== '.' || callArgs.length !== 1) return null
    const [, source, method] = callee
    if (method !== 'map' && method !== 'filter') return null
    if (!isPureCallback(callArgs[0])) return null
    return { source, method, fn: callArgs[0] }
  }

  ctx.core.emit['.map'] = (arr, fn, thisArg) => {
    // .filter(f).map(g) → single loop: test f, apply g if passes
    const up = detectUpstream(arr)
    if (thisArg === undefined && up && up.method === 'filter' && isPureCallback(fn) && !callbackReadsArray(fn)) {
      const recv = hoistArrayValue(up.source)
      const count = tempI32('fc'), maxLen = tempI32('fm'), base = tempI32('fb')
      const upReps = callbackArgReps(up.source)
      const filterCb = makeCallback(up.fn, upReps, callbackElem(up.source)), mapCb = makeCallback(fn, upReps, callbackElem(up.source))
      const out = allocPtr({ type: PTR.ARRAY, len: 0, cap: ['local.get', `$${maxLen}`], tag: 'fm' })
      const loop = callbackLoop(recv, (_p, _l, i, item) => [
        ['if', truthyIR(filterCb.call([item, idxArg(filterCb, i), arrArg(filterCb, recv.value)])),
          ['then',
            elemStore(out.local, count, asF64(mapCb.stored([item, idxArg(mapCb, count)]))),
            ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
      ], maxLen, base)
      inc('__ptr_offset')
      return typed(['block', ['result', 'f64'],
        recv.setup, filterCb.setup, mapCb.setup,
        ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
        ['local.set', `$${maxLen}`, arrayLenFromPtr(base)],
        out.init, ['local.set', `$${count}`, ['i32.const', 0]],
        ...loop,
        ['i32.store', ['i32.sub', ['local.get', `$${out.local}`], ['i32.const', 8]], ['local.get', `$${count}`]],
        out.ptr], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const len = tempI32('ml'), base = tempI32('mb')
    const cb = makeCallback(fn, callbackArgReps(arr), callbackElem(arr), thisArg)
    const lenIR = ['local.get', `$${len}`]
    const out = allocPtr({ type: PTR.ARRAY, len: lenIR, tag: 'mo' })
    // Reuse the precomputed len local in arrayLoop (skip its internal load).
    const loop = callbackLoop(recv, (_ptr, _len, i, item) => [
      elemStore(out.local, i, asF64(cb.stored([item, idxArg(cb, i), arrArg(cb, recv.value)])))
    ], len, base, false, { onMissing: i => [elemStore(out.local, i, ['f64.const', `nan:${TOMB_NAN}`])] })
    inc('__ptr_offset')
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup, cb.check,
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
      ['local.set', `$${len}`, arrayLenFromPtr(base)],
      out.init,
      ...loop,
      out.ptr], 'f64')
  }

  ctx.core.emit['.filter'] = (arr, fn, thisArg) => {
    // .map(f).filter(g) → single loop: apply f, test g, store if passes
    const up = detectUpstream(arr)
    if (thisArg === undefined && up && up.method === 'map' && isPureCallback(fn) && !callbackReadsArray(fn)) {
      const recv = hoistArrayValue(up.source)
      const count = tempI32('fc'), maxLen = tempI32('fm'), base = tempI32('fb'), mapped = temp('mv')
      const upReps = callbackArgReps(up.source)
      const mapCb = makeCallback(up.fn, upReps, callbackElem(up.source)), filterCb = makeCallback(fn)
      const out = allocPtr({ type: PTR.ARRAY, len: 0, cap: ['local.get', `$${maxLen}`], tag: 'mf' })
      const loop = callbackLoop(recv, (_p, _l, i, item) => [
        ['local.set', `$${mapped}`, asF64(mapCb.stored([item, idxArg(mapCb, i), arrArg(mapCb, recv.value)]))],
        ['if', truthyIR(filterCb.call([typed(['local.get', `$${mapped}`], 'f64'), idxArg(filterCb, i)])),
          ['then',
            ['f64.store', ['i32.add', ['local.get', `$${out.local}`], ['i32.shl', ['local.get', `$${count}`], ['i32.const', 3]]], ['local.get', `$${mapped}`]],
            ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
      ], maxLen, base)
      inc('__ptr_offset')
      return typed(['block', ['result', 'f64'],
        recv.setup, mapCb.setup, filterCb.setup,
        ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
        ['local.set', `$${maxLen}`, arrayLenFromPtr(base)],
        out.init, ['local.set', `$${count}`, ['i32.const', 0]],
        ...loop,
        ['i32.store', ['i32.sub', ['local.get', `$${out.local}`], ['i32.const', 8]], ['local.get', `$${count}`]],
        out.ptr], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const count = tempI32('fc'), maxLen = tempI32('fm'), base = tempI32('fb')
    const cb = makeCallback(fn, callbackArgReps(arr), callbackElem(arr), thisArg)
    const out = allocPtr({ type: PTR.ARRAY, len: 0, cap: ['local.get', `$${maxLen}`], tag: 'fo' })
    const loop = callbackLoop(recv, (_ptr, _len, i, item) => [
      ['if', truthyIR(cb.call([item, idxArg(cb, i), arrArg(cb, recv.value)])),
        ['then',
          ['f64.store', ['i32.add', ['local.get', `$${out.local}`], ['i32.shl', ['local.get', `$${count}`], ['i32.const', 3]]], item],
          ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
    ], maxLen, base)
    inc('__ptr_offset')
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup, cb.check,
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
      ['local.set', `$${maxLen}`, arrayLenFromPtr(base)],
      out.init,
      ['local.set', `$${count}`, ['i32.const', 0]],
      ...loop,
      // Patch actual length into header (data start - 8).
      ['i32.store', ['i32.sub', ['local.get', `$${out.local}`], ['i32.const', 8]], ['local.get', `$${count}`]],
      out.ptr], 'f64')
  }

  // A fold without an explicit seed must have consumed a first element.
  // Dense folds use the captured length; sparse/filter folds use a seeded
  // flag because a nonempty source can have no present/passing element.
  const reductionResult = (acc, seed) => {
    const value = typed(['local.get', `$${acc}`], 'f64')
    return seed == null ? value : typed(['if', ['result', 'f64'],
      ['local.get', `$${seed}`], ['then', value], ['else', throwTypeErrorIR()]], 'f64')
  }

  ctx.core.emit['.reduce'] = (arr, fn, init) => {
    const up = detectUpstream(arr)
    // .map(f).reduce(g, init) → single loop: apply f, accumulate with g
    if (up && up.method === 'map' && isPureCallback(fn, init) && !callbackReadsArray(fn, 3)) {
      const recv = hoistArrayValue(up.source)
      const acc = temp('ra'), mapped = temp('mv')
      const seeded = init === undefined && !recv.dense ? tempI32('rs') : null
      const upReps = callbackArgReps(up.source)
      const mapCb = makeCallback(up.fn, upReps, callbackElem(up.source)), redCb = makeCallback(fn, [{ tagged: true }])
      const mget = typed(['local.get', `$${mapped}`], 'f64')
      // map preserves indices → the reduce callback's index is the loop counter.
      const fold = i => ['local.set', `$${acc}`, asF64(redCb.stored([typed(['local.get', `$${acc}`], 'f64'), mget, idxArg(redCb, i, 2)]))]
      let inputLen
      const loop = callbackLoop(recv, (_p, len, i, item) => {
        inputLen = len
        return [
          ['local.set', `$${mapped}`, asF64(mapCb.stored([item, idxArg(mapCb, i), arrArg(mapCb, recv.value)]))],
          // No-init: seed accumulator with the first mapped element (see base path).
          init !== undefined ? fold(i)
            : ['if', ['i32.eqz', ['local.get', `$${seeded || i}`]],
                ['then', ['local.set', `$${acc}`, mget], ...(seeded ? [['local.set', `$${seeded}`, ['i32.const', 1]]] : [])],
                ['else', fold(i)]]
        ]
      })
      return typed(['block', ['result', 'f64'],
        recv.setup, mapCb.setup, redCb.setup,
        ...(seeded ? [['local.set', `$${seeded}`, ['i32.const', 0]]] : []),
        ['local.set', `$${acc}`, init !== undefined ? storedValue(init) : ['f64.const', 0]],
        redCb.check,
        ...loop, reductionResult(acc, init !== undefined ? null : seeded || inputLen)], 'f64')
    }
    // .filter(f).reduce(g, init) → single loop: test f, accumulate with g if passes
    if (up && up.method === 'filter' && isPureCallback(fn, init) && !callbackReadsArray(fn, 3)) {
      const recv = hoistArrayValue(up.source)
      const acc = temp('ra')
      // No-init: seed is the first *passing* element, whose index isn't known
      // statically (filter), so track a seeded flag rather than i==0.
      const seeded = init !== undefined ? null : tempI32('rs')
      const upReps = callbackArgReps(up.source)
      const filterCb = makeCallback(up.fn, upReps, callbackElem(up.source))
      // reduce cb signature: (acc, item, idx). Item rep mirrors upstream's item rep.
      const redCb = makeCallback(fn, [{ tagged: true }, upReps[0], { val: VAL.NUMBER }], callbackElem(up.source, 1))
      // filter renumbers: the reduce index counts *passing* elements, not the
      // source position, so track a dedicated filtered-position counter (only when
      // the callback actually reads its index — else idxArg drops the arg anyway).
      const usesIdx = redCb.usedParams ? !!redCb.usedParams[2] : true
      const fpos = usesIdx ? tempI32('rp') : null
      const fold = item => ['local.set', `$${acc}`, asF64(redCb.stored([typed(['local.get', `$${acc}`], 'f64'), item, fpos ? idxArg(redCb, fpos, 2) : null]))]
      const bump = fpos ? [['local.set', `$${fpos}`, ['i32.add', ['local.get', `$${fpos}`], ['i32.const', 1]]]] : []
      const accumulate = item => ['block',
        seeded
          ? ['if', ['local.get', `$${seeded}`],
              ['then', fold(item)],
              ['else', ['block', ['local.set', `$${acc}`, asF64(item)], ['local.set', `$${seeded}`, ['i32.const', 1]]]]]
          : fold(item),
        ...bump]
      const loop = callbackLoop(recv, (_p, _l, i, item) => [
        ['if', truthyIR(filterCb.call([item, idxArg(filterCb, i), arrArg(filterCb, recv.value)])),
          ['then', accumulate(item)]]
      ])
      return typed(['block', ['result', 'f64'],
        recv.setup, filterCb.setup, redCb.setup,
        ...(fpos ? [['local.set', `$${fpos}`, ['i32.const', 0]]] : []),
        ...(seeded ? [['local.set', `$${seeded}`, ['i32.const', 0]]] : []),
        ['local.set', `$${acc}`, init !== undefined ? storedValue(init) : ['f64.const', 0]],
        redCb.check,
        ...loop, reductionResult(acc, seeded)], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const acc = temp('ra')
    const seeded = init === undefined && !recv.dense ? tempI32('rs') : null
    // reduce cb signature: (acc, item, idx). Item rep mirrors recv's elem val type.
    // The accumulator is a tagged value across the seed, callback result,
    // and next iteration. Its kind can change during the fold.
    const reps = callbackArgReps(arr)
    const accRep = { tagged: true }
    const cb = makeCallback(fn, [accRep, reps[0], { val: VAL.NUMBER }, reps[2]])
    // No initial value: JS seeds the accumulator with the first present element
    // and folds over later present elements. A 0 seed is invisible for `+`
    // (additive identity) but wrong for `*` and non-numeric folds.
    const fold = (item, i) => ['local.set', `$${acc}`, asF64(cb.stored([typed(['local.get', `$${acc}`], 'f64'), item, idxArg(cb, i, 2), arrArg(cb, recv.value, 3)]))]
    let inputLen
    const loop = callbackLoop(recv, (_ptr, len, i, item) => {
      inputLen = len
      return [init !== undefined ? fold(item, i)
        : ['if', ['i32.eqz', ['local.get', `$${seeded || i}`]],
            ['then', ['local.set', `$${acc}`, asF64(item)], ...(seeded ? [['local.set', `$${seeded}`, ['i32.const', 1]]] : [])],
            ['else', fold(item, i)]]]
    })
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ...(seeded ? [['local.set', `$${seeded}`, ['i32.const', 0]]] : []),
      ['local.set', `$${acc}`, init !== undefined ? storedValue(init) : ['f64.const', 0]],
      cb.check,
      ...loop,
      reductionResult(acc, init !== undefined ? null : seeded || inputLen)], 'f64')
  }

  // .reduceRight(fn, init) — same accumulator fold as .reduce but the last
  // arrayLoop arg (reverse) walks elements len-1→0. No map/filter fusion: the
  // reverse-fused shapes don't occur in practice and the base case is the only
  // form jz emits. (Previously absent despite being autoload-declared + test262-
  // tracked — a phantom builtin that silently returned undefined.)
  ctx.core.emit['.reduceRight'] = (arr, fn, init) => {
    const recv = hoistArrayValue(arr)
    const acc = temp('ra')
    const seeded = init === undefined && !recv.dense ? tempI32('rs') : null
    const reps = callbackArgReps(arr)
    const cb = makeCallback(fn, [{ tagged: true }, reps[0], { val: VAL.NUMBER }, reps[2]])
    // No-init: reverse walk seeds with the last present element, then folds down.
    const fold = (item, i) => ['local.set', `$${acc}`, asF64(cb.stored([typed(['local.get', `$${acc}`], 'f64'), item, idxArg(cb, i, 2), arrArg(cb, recv.value, 3)]))]
    let inputLen
    const loop = callbackLoop(recv, (_ptr, len, i, item) => {
      inputLen = len
      return [init !== undefined ? fold(item, i)
        : ['if', seeded ? ['i32.eqz', ['local.get', `$${seeded}`]] : ['i32.eq', ['local.get', `$${i}`], ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]]],
            ['then', ['local.set', `$${acc}`, asF64(item)], ...(seeded ? [['local.set', `$${seeded}`, ['i32.const', 1]]] : [])],
            ['else', fold(item, i)]]]
    }, null, null, true)
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup,
      ...(seeded ? [['local.set', `$${seeded}`, ['i32.const', 0]]] : []),
      ['local.set', `$${acc}`, init !== undefined ? storedValue(init) : ['f64.const', 0]],
      cb.check,
      ...loop,
      reductionResult(acc, init !== undefined ? null : seeded || inputLen)], 'f64')
  }

  ctx.core.emit['.forEach'] = (arr, fn, thisArg) => {
    // .map(f).forEach(g) → single loop: apply f, call g — no intermediate array
    const up = detectUpstream(arr)
    if (thisArg === undefined && up && up.method === 'map' && isPureCallback(fn) && !callbackReadsArray(fn)) {
      const recv = hoistArrayValue(up.source)
      const mapped = temp('mv'), tmp = temp('ft')
      const upReps = callbackArgReps(up.source)
      const mapCb = makeCallback(up.fn, upReps), forCb = makeCallback(fn)
      const loop = callbackLoop(recv, (_p, _l, i, item) => [
        ['local.set', `$${mapped}`, asF64(mapCb.call([item, idxArg(mapCb, i), arrArg(mapCb, recv.value)]))],
        ['local.set', `$${tmp}`, asF64(forCb.call([typed(['local.get', `$${mapped}`], 'f64'), idxArg(forCb, i)]))]
      ])
      return typed(['block', ['result', 'f64'], recv.setup, mapCb.setup, forCb.setup, forCb.check, ...loop, ['f64.const', 0]], 'f64')
    }
    if (thisArg === undefined && up && up.method === 'filter' && isPureCallback(fn) && !callbackReadsArray(fn)) {
      const recv = hoistArrayValue(up.source)
      const tmp = temp('ft')
      const upReps = callbackArgReps(up.source)
      const filterCb = makeCallback(up.fn, upReps), forCb = makeCallback(fn, upReps)
      const loop = callbackLoop(recv, (_p, _l, i, item) => [
        ['if', truthyIR(filterCb.call([item, idxArg(filterCb, i), arrArg(filterCb, recv.value)])),
          ['then', ['local.set', `$${tmp}`, asF64(forCb.call([item, idxArg(forCb, i)]))]]]
      ])
      return typed(['block', ['result', 'f64'], recv.setup, filterCb.setup, forCb.setup, forCb.check, ...loop, ['f64.const', 0]], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const tmp = temp('ft')
    const cb = makeCallback(fn, callbackArgReps(arr), null, thisArg)
    const loop = callbackLoop(recv, (_ptr, _len, i, item) => [
      ['local.set', `$${tmp}`, asF64(cb.call([item, idxArg(cb, i), arrArg(cb, recv.value)]))]
    ])
    return typed(['block', ['result', 'f64'], recv.setup, cb.setup, cb.check, ...loop, ['f64.const', 0]], 'f64')
  }

  // .reverse() → in-place swap arr[i] ↔ arr[len-1-i], returns the array.
  // Reverse an array VALUE in place, returning it. `.reverse` mutates the
  // receiver (setup hoists it once); `.toReversed` (ES2023) reverses a fresh
  // __arr_from copy so the receiver is untouched.
  function emitArrayReverseInPlace(setup, value) {
    const arrTmp = temp('rv')
    const base = tempI32('rb')
    const len = tempI32('rl')
    const i = tempI32('ri')
    const j = tempI32('rj')
    const tmp = temp('rt')
    const id = freshId(ctx)
    const exit = `$revexit${id}`, loop = `$revloop${id}`

    inc('__ptr_offset')
    if (needsDurableFwdLog()) inc('__durable_arr_snap')  // explicit edge — see durableArrSnapIR's comment

    const addr = (idxIR) => ['i32.add', ['local.get', `$${base}`], ['i32.shl', idxIR, ['i32.const', 3]]]

    return typed(['block', ['result', 'f64'],
      setup,
      ['local.set', `$${arrTmp}`, value],
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${arrTmp}`]]]],
      durableArrSnapNode(base),
      ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${base}`], ['i32.const', 8]]]],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['local.set', `$${j}`, ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]]],
      ['block', exit,
        ['loop', loop,
          ['br_if', exit, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${j}`]]],
          ['local.set', `$${tmp}`, ['f64.load', addr(['local.get', `$${i}`])]],
          ['f64.store', addr(['local.get', `$${i}`]), ['f64.load', addr(['local.get', `$${j}`])]],
          ['f64.store', addr(['local.get', `$${j}`]), ['local.get', `$${tmp}`]],
          ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
          ['local.set', `$${j}`, ['i32.sub', ['local.get', `$${j}`], ['i32.const', 1]]],
          ['br', loop]]],
      ['local.get', `$${arrTmp}`]
    ], 'f64')
  }
  ctx.core.emit['.reverse'] = (arr) => {
    const recv = hoistArrayValue(arr)
    return emitArrayReverseInPlace(recv.setup, recv.value)
  }
  ctx.core.emit['.toReversed'] = (arr) => {
    const copy = ctx.summary?.at(ctx.func.current).arrayDenseOfExpr(arr) ? '__arr_from' : '__arr_dense'
    inc(copy)
    return emitArrayReverseInPlace(['nop'], typed(['call', '$' + copy, asI64(emit(arr))], 'f64'))
  }

  // Sort an array VALUE in place, returning it: `.sort` sorts the receiver,
  // `.toSorted` (ES2023) a fresh __arr_from copy. As the spec's
  // SortIndexedProperties: the elements are read out once, undefined set aside
  // for the end (a comparator never sees it), the rest merge sorted stably
  // (module/array/sort.js) and written back, the array re-read after the
  // comparator ran (it may have grown the array). A comparator's positive
  // result puts a after b; NaN is no order. The default order compares each
  // element's string once made (__to_str → __str_cmp, code unit order, not
  // locale-aware): records of a key and its value.
  function emitArraySortInPlace(setup, value, fn, dense = false) {
    const arrTmp = temp('sr'), base = tempI32('sb'), len = tempI32('sl'), m = tempI32('sm'), i = tempI32('si')
    const buf = tempI32('sbf'), tmp = tempI32('stp'), v = temp('sv'), present = dense ? null : tempI32('sn')
    const id = freshId(ctx)
    const shift = fn == null ? 4 : 3
    let cmpSetup = ['nop'], after
    if (fn == null) {
      // default comparator is ToString + code unit compare: both live in the string
      // module, which an all-numeric program hasn't loaded (dangling inc otherwise)
      ctx.module.include('string')
      inc('__to_str', '__str_cmp')
      after = (a, b) => ['i32.gt_s', ['call', '$__str_cmp', ['i64.load', a], ['i64.load', b]], ['i32.const', 0]]
    } else {
      const cb = makeCallback(fn, [])
      cmpSetup = cb.setup
      after = (a, b) => ['f64.gt', asF64(cb.call([typed(['f64.load', a], 'f64'), typed(['f64.load', b], 'f64')])), ['f64.const', 0]]
    }
    inc('__ptr_offset')
    if (needsDurableFwdLog()) inc('__durable_arr_snap')  // explicit edge — see durableArrSnapIR's comment
    const get = (n) => ['local.get', `$${n}`]
    const slot = (b, k) => ['i32.add', get(b), ['i32.shl', get(k), ['i32.const', 3]]]
    const rec = (k) => ['i32.add', get(buf), ['i32.shl', get(k), ['i32.const', shift]]]
    const scratch = heapScratch(buf, ['i32.shl', get(len), ['i32.const', shift + 1]])
    const collect = ['if', ['i32.eqz', isUndef(get(v))], ['then',
      ...(fn == null
        ? [['i64.store', rec(m), ['call', '$__to_str', ['i64.reinterpret_f64', get(v)]]],
           ['f64.store', ['i32.add', rec(m), ['i32.const', 8]], get(v)]]
        : [['f64.store', rec(m), get(v)]]),
      ['local.set', `$${m}`, ['i32.add', get(m), ['i32.const', 1]]]]]
    return typed(['block', ['result', 'f64'],
      setup,
      cmpSetup,
      ['local.set', `$${arrTmp}`, value],
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', get(arrTmp)]]],
      ['local.set', `$${len}`, ['i32.load', ['i32.sub', get(base), ['i32.const', 8]]]],
      ['if', ['i32.gt_s', get(len), ['i32.const', 1]], ['then',
        ...scratch.take,
        ['local.set', `$${tmp}`, ['i32.add', get(buf), ['i32.shl', get(len), ['i32.const', shift]]]],
        // the elements out, undefined set aside
        ['local.set', `$${m}`, ['i32.const', 0]], ['local.set', `$${i}`, ['i32.const', 0]],
        ...(dense ? [] : [['local.set', `$${present}`, ['i32.const', 0]]]),
        ['block', `$sortgd${id}`, ['loop', `$sortg${id}`,
          ['br_if', `$sortgd${id}`, ['i32.ge_s', get(i), get(len)]],
          ['local.set', `$${v}`, ['f64.load', slot(base, i)]],
          dense ? collect : ['if', ['i64.ne', ['i64.reinterpret_f64', get(v)], ['i64.const', TOMB_NAN]], ['then',
            ['local.set', `$${present}`, ['i32.add', get(present), ['i32.const', 1]]], collect]],
          ['local.set', `$${i}`, ['i32.add', get(i), ['i32.const', 1]]],
          ['br', `$sortg${id}`]]],
        mergeSortIR(buf, tmp, m, shift, after),
        // back into the array, as it stands now, undefined last
        ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', get(arrTmp)]]],
        durableArrSnapNode(base),
        ['local.set', `$${i}`, ['i32.const', 0]],
        ['block', `$sortwd${id}`, ['loop', `$sortw${id}`,
          ['br_if', `$sortwd${id}`, ['i32.ge_s', get(i), get(len)]],
          ['f64.store', slot(base, i), ['if', ['result', 'f64'], ['i32.lt_s', get(i), get(m)],
            ['then', ['f64.load', fn == null ? ['i32.add', rec(i), ['i32.const', 8]] : rec(i)]],
            ['else', dense ? undefExpr() : ['if', ['result', 'f64'], ['i32.lt_s', get(i), get(present)],
              ['then', undefExpr()], ['else', ['f64.const', `nan:${TOMB_NAN}`]]]]]],
          ['local.set', `$${i}`, ['i32.add', get(i), ['i32.const', 1]]],
          ['br', `$sortw${id}`]]],
        scratch.release]],
      get(arrTmp)
    ], 'f64')
  }
  ctx.core.emit['.sort'] = (arr, fn) => {
    const recv = hoistArrayValue(arr)
    return emitArraySortInPlace(recv.setup, recv.value, fn, recv.dense)
  }
  ctx.core.emit['.toSorted'] = (arr, fn) => {
    const copy = ctx.summary?.at(ctx.func.current).arrayDenseOfExpr(arr) ? '__arr_from' : '__arr_dense'
    inc(copy)
    return emitArraySortInPlace(['nop'], typed(['call', '$' + copy, asI64(emit(arr))], 'f64'), fn, true)
  }

  // .with(index, value) (ES2023) — a COPY with one element replaced. Negative
  // index counts from the end; an out-of-range index throws (RangeError in JS —
  // jz collapses Error subclasses to one generic throw, like .typed:with).
  ctx.core.emit['.with'] = (arr, index, value) => {
    const copy = ctx.summary?.at(ctx.func.current).arrayDenseOfExpr(arr) ? '__arr_from' : '__arr_dense'
    inc(copy, '__ptr_offset')
    ctx.runtime.throws = true
    const c = temp('awc'), base = tempI32('awb'), len = tempI32('awl'), idx = tempI32('awi')
    const positions = positionArgs([index])
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${c}`, typed(['call', '$' + copy, asI64(emit(arr))], 'f64')],
      ['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${c}`]]]],
      ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${base}`], ['i32.const', 8]]]],
      // ToIntegerOrInfinity position arg (23.1.3.42 step 3) through positionArgs:
      // a string converts, a BigInt throws, ±Infinity saturates so the range
      // check below throws instead of wrapping to a valid negative index.
      ...positions.setup,
      ['local.set', `$${idx}`, positions.index(0)],
      ['if', ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]],
        ['then', ['local.set', `$${idx}`, ['i32.add', ['local.get', `$${idx}`], ['local.get', `$${len}`]]]]],
      ['if', ['i32.or',
        ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]],
        ['i32.ge_s', ['local.get', `$${idx}`], ['local.get', `$${len}`]]],
        ['then', ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['f64.const', errorCodeLiteral(ERR.ARRAY_WITH_INDEX)]]], ['throw', '$__jz_err', ['f64.const', errorCodeLiteral(ERR.ARRAY_WITH_INDEX)]]]],
      ['f64.store',
        ['i32.add', ['local.get', `$${base}`], ['i32.shl', ['local.get', `$${idx}`], ['i32.const', 3]]],
        storedValue(value)],
      ['local.get', `$${c}`]], 'f64')
  }

  // .copyWithin(target, start, end?) — in-place overlap-safe move, returns the
  // receiver. memory.copy is memmove-semantic (bulk-memory), so unlike the
  // element-kind-aware __typed_copyWithin, plain arrays need no direction loop.
  ctx.core.emit['.copyWithin'] = (arr, target, start, end) => {
    inc('__arr_copyWithin')
    // ToIntegerOrInfinity position args (23.1.3.4 steps 3/5/7) through positionArgs.
    const recv = temp('acr'), positions = positionArgs([target, start, end])
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${recv}`, asF64(emit(arr))],
      ...positions.setup,
      ['call', '$__arr_copyWithin', ['i64.reinterpret_f64', ['local.get', `$${recv}`]],
        positions.index(0, ['i32.const', 0]),
        positions.index(1, ['i32.const', 0]),
        positions.index(2, ['i32.const', 0x7FFFFFFF])]], 'f64')
  }
  ctx.core.stdlib['__arr_copyWithin'] = `(func $__arr_copyWithin (param $arr i64) (param $target i32) (param $start i32) (param $end i32) (result f64)
    (local $off i32) (local $len i32) (local $count i32)
    (if (i32.eq (call $__ptr_type (local.get $arr)) (i32.const ${PTR.ARRAY}))
      (then
        (local.set $off (call $__ptr_offset (local.get $arr)))
        ${durableArrSnapIR('off')}
        (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
        (local.set $target (call $__clamp_idx (local.get $target) (local.get $len)))
        (local.set $start (call $__clamp_idx (local.get $start) (local.get $len)))
        (local.set $end (call $__clamp_idx (local.get $end) (local.get $len)))
        (local.set $count (i32.sub (local.get $end) (local.get $start)))
        (if (i32.gt_s (local.get $count) (i32.sub (local.get $len) (local.get $target)))
          (then (local.set $count (i32.sub (local.get $len) (local.get $target)))))
        (if (i32.gt_s (local.get $count) (i32.const 0))
          (then (memory.copy
            (i32.add (local.get $off) (i32.shl (local.get $target) (i32.const 3)))
            (i32.add (local.get $off) (i32.shl (local.get $start) (i32.const 3)))
            (i32.shl (local.get $count) (i32.const 3)))))))
    (f64.reinterpret_i64 (local.get $arr)))`

  // Array.of(...items) — spec-identical to the array literal `[...items]`; the
  // `[` emitter already handles spread-tagged args and the static-data path.
  // (Distinct from `Array(n)`, which makes a length-n hole array.)
  ctx.core.emit['Array.of'] = (...items) => ctx.core.emit['['](...items)

  // Boxed pointer values (strings/objects/etc.) carry NaN payloads, and
  // f64.eq treats NaN as not-equal to anything — even bit-identical NaN —
  // so a raw f64 compare misses string and reference matches. Route those
  // through __eq, the same helper `==` uses for STRING/BIGINT/cross-type.
  // f64.eq stays the fast path when the search value is statically NUMBER.
  const arrEqIR = (val) => {
    const vt = resolveValType(val, valTypeOf, lookupValType)
    if (vt === VAL.NUMBER) return (item, vv) => ['f64.eq', item, vv]
    inc('__eq')
    return (item, vv) => ['call', '$__eq', ['i64.reinterpret_f64', item], ['i64.reinterpret_f64', vv]]
  }

  // The search methods' fromIndex (23.1.3.17 steps 4-9, 23.1.3.20 steps 4-8):
  // ToIntegerOrInfinity through positionArgs, a negative one counted from the
  // end and clamped at 0; lastIndexOf's default is the last index and a
  // positive one clamps to it.
  const fromIndexIR = (positions, len, last) => {
    const from = tempI32('from')
    const fromLen = ['local.get', `$${len}`]
    const value = positions.index(0, last ? ['i32.sub', fromLen, ['i32.const', 1]] : ['i32.const', 0])
    return { local: from, setup: [
      ['local.set', `$${from}`, value],
      ['if', ['i32.lt_s', ['local.get', `$${from}`], ['i32.const', 0]],
        ['then', ['local.set', `$${from}`, ['i32.add', ['local.get', `$${from}`], fromLen]],
          ['if', ['i32.lt_s', ['local.get', `$${from}`], ['i32.const', 0]], ['then', ['local.set', `$${from}`, ['i32.const', last ? -1 : 0]]]]],
        ...(last ? [['else', ['if', ['i32.ge_s', ['local.get', `$${from}`], fromLen], ['then', ['local.set', `$${from}`, ['i32.sub', fromLen, ['i32.const', 1]]]]]]] : [])],
    ] }
  }
  ctx.core.emit['.indexOf'] = (arr, val, fromIndex) => {
    const recv = hoistArrayValue(arr)
    const value = temp('ixv')
    const vv = typed(['local.get', `$${value}`], 'f64')
    const positions = positionArgs([fromIndex])
    const eq = arrEqIR(val)
    const result = tempI32('ix'), len = tempI32('ixl'), ptr = tempI32('ixp')
    const from = fromIndexIR(positions, len, false)
    const exit = `$exit${freshId(ctx)}`
    inc('__ptr_offset')
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', eq(item, vv),
        ['then', ['local.set', `$${result}`, ['local.get', `$${i}`]], ['br', exit]]]
    ], len, ptr, false, ['local.get', `$${from.local}`], { fixed: true, dense: recv.dense })
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ['local.set', `$${value}`, asF64(val === undefined ? undefExpr() : storedValue(val))],
      ...positions.setup,
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
      ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]],
      ...from.setup,
      ['local.set', `$${result}`, ['i32.const', -1]],
      ['block', exit, ...loop],
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }

  // Array.prototype.includes compares by SameValueZero (23.1.3.16): NaN finds
  // NaN, unlike indexOf. A number-NaN is only ever the canonical pattern, so
  // for a proven-number search value the NaN case is one bit compare.
  ctx.core.emit['.includes'] = (arr, val, fromIndex) => {
    const recv = hoistArrayValue(arr)
    const vv = temp('icv')
    const positions = positionArgs([fromIndex])
    const vget = typed(['local.get', `$${vv}`], 'f64')
    let eq
    if (resolveValType(val, valTypeOf, lookupValType) === VAL.NUMBER) {
      eq = (item) => ['i32.or', ['f64.eq', item, vget],
        ['i32.and', ['i64.eq', ['i64.reinterpret_f64', item], ['i64.const', NAN_BITS]],
                    ['i64.eq', ['i64.reinterpret_f64', vget], ['i64.const', NAN_BITS]]]]
    } else {
      ctx.module.include('collection')
      inc('__same_value_zero')
      eq = (item) => ['call', '$__same_value_zero', ['i64.reinterpret_f64', item], ['i64.reinterpret_f64', vget]]
    }
    const result = tempI32('ic'), len = tempI32('icl'), ptr = tempI32('icp')
    const from = fromIndexIR(positions, len, false)
    const exit = `$exit${freshId(ctx)}`
    inc('__ptr_offset')
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', eq(item),
        ['then', ['local.set', `$${result}`, ['i32.const', 1]], ['br', exit]]]
    ], len, ptr, false, ['local.get', `$${from.local}`], { fixed: true, dense: recv.dense, visitMissing: true })
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ['local.set', `$${vv}`, asF64(val === undefined ? undefExpr() : storedValue(val))],
      ...positions.setup,
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
      ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]],
      ...from.setup,
      ['local.set', `$${result}`, ['i32.const', 0]],
      ['block', exit, ...loop],
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }

  // Capture the search value once, then scan backwards from fromIndex.
  ctx.core.emit['.lastIndexOf'] = (arr, val, fromIndex) => {
    const recv = hoistArrayValue(arr)
    const value = temp('lxv')
    const vv = typed(['local.get', `$${value}`], 'f64')
    const positions = positionArgs([fromIndex])
    const eq = arrEqIR(val)
    const result = tempI32('lx'), len = tempI32('lxl'), ptr = tempI32('lxp')
    const from = fromIndexIR(positions, len, true)
    const exit = `$exit${freshId(ctx)}`
    inc('__ptr_offset')
    // Backwards from fromIndex: the first hit is the last occurrence.
    const loop = arrayLoop(recv.value, (_ptr, _len, i, item) => [
      ['if', eq(item, vv),
        ['then', ['local.set', `$${result}`, ['local.get', `$${i}`]], ['br', exit]]]
    ], len, ptr, true, ['local.get', `$${from.local}`], { fixed: true, dense: recv.dense })
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ['local.set', `$${value}`, asF64(val === undefined ? undefExpr() : storedValue(val))],
      ...positions.setup,
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
      ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]],
      ...from.setup,
      ['local.set', `$${result}`, ['i32.const', -1]],
      ['block', exit, ...loop],
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }

  // Relative positions use the original length and saturate huge numbers.
  // An out-of-range position yields undefined without touching element storage.
  const undefNanIR = () => ['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]]
  ctx.core.emit['.array:at'] = (arr, ...args) => {
    const vt = valTypeOf(arr), kind = valTypeOf(args[0])
    const recv = hoistArrayValue(arr), positions = positionArgs(args)
    const t = tempI32('ai'), off = tempI32('ao'), len = tempI32('al')
    const mayMutate = args[0] != null && kind !== VAL.NUMBER && kind !== VAL.BOOL && kind !== VAL.STRING
    inc('__ptr_offset')
    const read = mayMutate ? (vt === VAL.ARRAY ? '__arr_idx_known' : '__arr_idx') : null
    if (read) inc(read)
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ...positions.setup,
      ['local.set', `$${off}`, ['call', '$__ptr_offset', asI64(recv.value)]],
      ['local.set', `$${len}`, vt === VAL.ARRAY ? arrayLenFromPtr(off) : ['call', '$__len', asI64(recv.value)]],
      ['local.set', `$${t}`, positions.index(0)],
      ['if', ['i32.lt_s', ['local.get', `$${t}`], ['i32.const', 0]],
        ['then', ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['local.get', `$${len}`]]]]],
      ['if', ['result', 'f64'],
        ['i32.or', ['i32.lt_s', ['local.get', `$${t}`], ['i32.const', 0]], ['i32.ge_s', ['local.get', `$${t}`], ['local.get', `$${len}`]]],
        ['then', undefNanIR()],
        // Conversion can grow/forward or shrink the receiver. Keep the original
        // relative length, but read the current element through the shared helper.
        ['else', read ? ['call', `$${read}`, asI64(recv.value), ['local.get', `$${t}`]]
          : arrayValue(['f64.load', ['i32.add', ['local.get', `$${off}`],
            ['i32.shl', ['local.get', `$${t}`], ['i32.const', 3]]]])]]], 'f64')
  }
  ctx.core.emit['.array:at'].argc = 2
  ctx.core.emit['.at'] = ctx.core.emit['.array:at']

  ctx.core.emit['.slice'] = (arr, start, end, ...extra) => {
    // BUFFER slice → byte-level copy handled in typedarray module.
    const ctor = typeof arr === 'string' ? plannedTypedStorageCtor(ctx, arr) : null
    if ((valTypeOf(arr) === VAL.BUFFER || ctor === 'new.ArrayBuffer') && ctx.core.emit['.buffer:slice'])
      return ctx.core.emit['.buffer:slice'](arr, start, end, ...extra)
    const recv = hoistArrayValue(arr)
    const s = tempI32('ss'), e = tempI32('se'), len = tempI32('sl'), outLen = tempI32('sn'), ptr = tempI32('sp')
    // ToIntegerOrInfinity position args (23.1.3.28 step 3/5) — asI32Sat, not asI32: an
    // Infinity/NaN/fractional start or end must saturate (INT32_MAX/MIN), not asI32's
    // ToInt32-WRAP fallback — with asI32's wrap, `[1,2,3,4,5].slice(NaN, Infinity)` would
    // drop the last element (Infinity wraps to -1, read downstream as "one before the end").
    // ToIntegerOrInfinity through positionArgs (a string converts, a BigInt
    // throws, undefined takes the default); the arguments are captured
    // before the receiver's length is read.
    const positions = positionArgs([start, end])
    const rawStart = positions.index(0, ['i32.const', 0])
    const rawEnd = positions.index(1, ['local.get', `$${len}`])
    const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${outLen}`], tag: 'so' })
    return typed(['block', ['result', 'f64'],
      recv.setup,
      ...positions.setup,
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', recv.value]]],
      ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]],
      ['local.set', `$${s}`, rawStart],
      ['if', ['i32.lt_s', ['local.get', `$${s}`], ['i32.const', 0]],
        ['then', ['local.set', `$${s}`, ['i32.add', ['local.get', `$${s}`], ['local.get', `$${len}`]]]]],
      ['if', ['i32.lt_s', ['local.get', `$${s}`], ['i32.const', 0]], ['then', ['local.set', `$${s}`, ['i32.const', 0]]]],
      ['if', ['i32.gt_s', ['local.get', `$${s}`], ['local.get', `$${len}`]], ['then', ['local.set', `$${s}`, ['local.get', `$${len}`]]]],
      ['local.set', `$${e}`, rawEnd],
      ['if', ['i32.lt_s', ['local.get', `$${e}`], ['i32.const', 0]],
        ['then', ['local.set', `$${e}`, ['i32.add', ['local.get', `$${e}`], ['local.get', `$${len}`]]]]],
      ['if', ['i32.lt_s', ['local.get', `$${e}`], ['i32.const', 0]], ['then', ['local.set', `$${e}`, ['i32.const', 0]]]],
      ['if', ['i32.gt_s', ['local.get', `$${e}`], ['local.get', `$${len}`]], ['then', ['local.set', `$${e}`, ['local.get', `$${len}`]]]],
      ['local.set', `$${outLen}`, ['i32.sub', ['local.get', `$${e}`], ['local.get', `$${s}`]]],
      ['if', ['i32.lt_s', ['local.get', `$${outLen}`], ['i32.const', 0]], ['then', ['local.set', `$${outLen}`, ['i32.const', 0]]]],
      out.init,
      ['memory.copy',
        ['local.get', `$${out.local}`],
        ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${s}`], ['i32.const', 3]]],
        ['i32.shl', ['local.get', `$${outLen}`], ['i32.const', 3]]],
      out.ptr], 'f64')
  }

  // .concat(...others) copies array cells, but appends every other value once.
  ctx.core.emit['.array:concat'] = (arr, ...others) => {
    const recv = hoistArrayValue(arr), len = tempI32('concatLen'), pos = tempI32('concatPos')
    const body = [recv.setup], sources = [{ value: recv.value, array: true }]
    // All argument expressions run before concat observes any source length.
    for (const other of others) {
      const name = temp('concatArg'), value = typed(['local.get', `$${name}`], 'f64')
      body.push(['local.set', `$${name}`, storedValue(other)])
      const vt = valTypeOf(other)
      sources.push({ value, array: vt === VAL.ARRAY ? true : vt ? false : null })
    }
    inc('__len', '__ptr_offset')
    body.push(['local.set', `$${len}`, ['i32.const', 0]])
    for (const source of sources) {
      const { value, array } = source
      const count = tempI32('concatCount')
      source.count = ['local.get', `$${count}`]
      if (array === null) {
        const flag = tempI32('concatArray')
        body.push(['local.set', `$${flag}`, ['i32.and', ['f64.ne', value, value], ptrTypeEq(value, PTR.ARRAY)]])
        source.test = ['local.get', `$${flag}`]
      }
      const size = ['call', '$__len', ['i64.reinterpret_f64', value]]
      body.push(['local.set', `$${count}`, array === true ? size : array === false ? ['i32.const', 1]
        : ['if', ['result', 'i32'], source.test, ['then', size], ['else', ['i32.const', 1]]]],
        ['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], source.count]])
    }
    const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${len}`], tag: 'concat' })
    body.push(out.init, ['local.set', `$${pos}`, ['i32.const', 0]])
    for (const { value, array, test, count } of sources) {
      const dest = ['i32.add', ['local.get', `$${out.local}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]]
      const copy = ['memory.copy', dest, ['call', '$__ptr_offset', ['i64.reinterpret_f64', value]], ['i32.shl', count, ['i32.const', 3]]]
      const append = ['f64.store', dest, value]
      body.push(array === true ? copy : array === false ? append : ['if', test, ['then', copy], ['else', append]],
        ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], count]])
    }
    return typed(['block', ['result', 'f64'], ...body, out.ptr], 'f64')
  }
  // Unqualified alias so an untyped-receiver `.concat` gets emit's runtime
  // string-vs-array ptr-type branch (string → `.string:concat`, array → this),
  // mirroring `.at`. A known-ARRAY receiver still dispatches here directly.
  ctx.core.emit['.concat'] = ctx.core.emit['.array:concat']

  // .flat() → flatten one level of nested arrays
  ctx.core.stdlib['__arr_flat'] = `(func $__arr_flat (param $src i64) (result f64)
    (local $len i32) (local $off i32) (local $i i32) (local $total i32) (local $dst i32) (local $pos i32)
    (local $elem f64) (local $subLen i32) (local $subOff i32) (local $j i32)
    (local.set $off (call $__ptr_offset (local.get $src)))
    (local.set $len (call $__len (local.get $src)))
    ;; First pass: count total elements
    (local.set $total (i32.const 0)) (local.set $i (i32.const 0))
    (block $c1 (loop $cl1
      (br_if $c1 (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $elem (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
      (if (i32.and (f64.ne (local.get $elem) (local.get $elem))
        (i32.eq (call $__ptr_type (i64.reinterpret_f64 (local.get $elem))) (i32.const ${PTR.ARRAY})))
        (then (local.set $total (i32.add (local.get $total) (call $__len (i64.reinterpret_f64 (local.get $elem))))))
        (else (local.set $total (i32.add (local.get $total) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cl1)))
    ;; Allocate result via the canonical header allocator (NOT a hand-rolled
    ;; (i32.const 8)+total*8 alloc, which this function used to do directly):
    ;; __dyn_get_t_h's ARRAY branch unconditionally reads the propsPtr word
    ;; at off-16 for every ARRAY receiver (module/collection.js). __alloc_hdr
    ;; reserves and zeroes that word as part of its 16-byte header; a
    ;; hand-rolled 8-byte header left it out entirely, silently relying on
    ;; the following bytes being untouched (zero) fresh linear memory — true
    ;; before region-arena's compaction starts reusing already-written
    ;; address ranges, false after (FOURTH mechanism, .work/evidence.md
    ;; §Region arena: the "stale receiver" was never stale or unrooted — it
    ;; was a genuine, freshly-built .flatMap() result whose off-16 word
    ;; aliased a neighboring allocation's leftover bytes).
    (local.set $dst (call $__alloc_hdr (local.get $total) (local.get $total)))
    ;; Second pass: copy
    (local.set $pos (i32.const 0)) (local.set $i (i32.const 0))
    (block $c2 (loop $cl2
      (br_if $c2 (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $elem (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
      (if (i64.eq (i64.reinterpret_f64 (local.get $elem)) (i64.const ${TOMB_NAN})) (then
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $cl2)))
      (if (i32.and (f64.ne (local.get $elem) (local.get $elem))
        (i32.eq (call $__ptr_type (i64.reinterpret_f64 (local.get $elem))) (i32.const ${PTR.ARRAY})))
        (then
          (local.set $subOff (call $__ptr_offset (i64.reinterpret_f64 (local.get $elem))))
          (local.set $subLen (call $__len (i64.reinterpret_f64 (local.get $elem))))
          (local.set $j (i32.const 0))
          (block $s (loop $sl
            (br_if $s (i32.ge_s (local.get $j) (local.get $subLen)))
            (local.set $elem (f64.load (i32.add (local.get $subOff) (i32.shl (local.get $j) (i32.const 3)))))
            (if (i64.ne (i64.reinterpret_f64 (local.get $elem)) (i64.const ${TOMB_NAN})) (then
              (f64.store (i32.add (local.get $dst) (i32.shl (local.get $pos) (i32.const 3))) (local.get $elem))
              (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $sl))))
        (else
          (f64.store (i32.add (local.get $dst) (i32.shl (local.get $pos) (i32.const 3))) (local.get $elem))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cl2)))
    (i32.store (i32.sub (local.get $dst) (i32.const 8)) (local.get $pos))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $dst)))`

  ctx.core.emit['.flat'] = (arr) => (inc('__arr_flat'),
    typed(['call', '$__arr_flat', asI64(emit(arr))], 'f64'))

  // Flatten each callback result before invoking the next callback. A later
  // callback may mutate a previously returned array, including the receiver.
  ctx.core.emit['.flatMap'] = (arr, fn, thisArg) => {
    if (isPureCallback(fn)) {
      // With no intervening effects, two passes can size the result exactly.
      const mapped = ctx.core.emit['.map'](arr, fn, thisArg)
      inc('__arr_flat')
      return typed(['call', '$__arr_flat', asI64(mapped)], 'f64')
    }
    const recv = hoistArrayValue(arr)
    const cb = makeCallback(fn, callbackArgReps(arr), callbackElem(arr), thisArg)
    const mapped = temp('fm'), result = temp('fr')
    const value = typed(['local.get', `$${mapped}`], 'f64')
    const out = allocPtr({ type: PTR.ARRAY, len: 0, cap: 4, tag: 'fo' })
    inc('__arr_push1')
    const append = item => ['local.set', `$${result}`, ['call', '$__arr_push1',
      ['i64.reinterpret_f64', ['local.get', `$${result}`]], item]]
    const loop = callbackLoop(recv, (_ptr, _len, i, item) => [
      ['local.set', `$${mapped}`, asF64(cb.stored([item, idxArg(cb, i), arrArg(cb, recv.value)]))],
      ['if', ['i32.and', ['f64.ne', value, value], ptrTypeEq(value, PTR.ARRAY)],
        ['then', ...arrayLoop(value, (_p, _l, _i, nested) => [append(nested)], undefined, undefined, false, undefined, { fixed: true })],
        ['else', append(value)]]
    ])
    return typed(['block', ['result', 'f64'], recv.setup, cb.setup, cb.check,
      out.init, ['local.set', `$${result}`, out.ptr], ...loop,
      ['local.get', `$${result}`]], 'f64')
  }

  // .join(sep) → concatenate array elements with separator string
  ctx.core.emit['.join'] = (arr, sep) => (inc('__str_join'),
    typed(['call', '$__str_join', asI64(emit(arr)), asI64(storedValue(sep == null ? ['str', ','] : sep))], 'f64'))
}
