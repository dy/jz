/**
 * Hash-table probe/upsert/lookup/delete pipeline — the open-addressing
 * codegen shared by every Set/Map/HASH stdlib entry in module/collection.js.
 *
 * Pure move out of collection.js (stdlib-generators minimality pass): every
 * export below is called from collection.js's `export default` exactly as
 * before, at the same call sites, with the same arguments. This file changes
 * WHERE the code lives, not what it emits — see .work/archive/stdlib-generators.md
 * for the extraction boundary and the byte-identity verification method.
 *
 * Imports the durable-log helpers from the `./durable.js` sibling (not from
 * `../collection.js`, which imports the generators below FROM this file) —
 * collection.js's own resolveModuleGraph (self-compile) rejects circular
 * module imports, so this stays a one-directional leaf-module chain:
 * durable.js ← upsert.js ← collection.js.
 *
 * @module collection/upsert
 */

import { TOMB_NAN, UNDEF_NAN } from '../../src/ir.js'
import { ctx, PTR, LAYOUT } from '../../src/ctx.js'
import { STR_HCACHE_BIT } from '../../layout.js'
import { durableFwdLogIR, durableSlotLogIR, durableEntryLogIR, durableSlotCancelIR, durableSlotRelogIR } from './durable.js'

// Normal outputs keep the cache-dense HASH LANE introduced for wordcount
// (+7.2% measured). The self-compile artifact's compact profile drops only that
// redundant copy: probes walk the entry-resident low hash word instead. This is
// resolved while templates are materialized, so neither layout pays a runtime
// branch and ordinary user output remains byte-identical.
export const LANE = 4
export const collectionLaneBytes = () => ctx.transform.compactCollections ? 0 : LANE
export const collectionStride = (entrySize) => entrySize + collectionLaneBytes()
const hasProbeLane = () => collectionLaneBytes() !== 0

// Shared grow-capacity policy for every open-addressing Set/Map/Hash table
// (genUpsert, genUpsertGrow, genSlotUpsert, genEphemeralSlotUpsert — four
// otherwise-independent grow blocks, all doubling `cap` at 75% load; this is
// the ONE place that decides the next capacity, so all four move together).
//
// Why tiered, not a flat factor bump: nothing in a compiled program's own
// runtime ever reclaims a grow's abandoned OLD table (its header is forward-
// marked and the caller's pointer chases through it, per genUpsert's own
// header comment — that is a permanent, not a transient, cost whenever
// region-arena compaction is inactive, which is the shipped default;
// REGION_HOOKS_ACTIVE, scripts/self.js). For a table settling at final
// capacity C after growing by a constant factor f, the total bytes EVER
// allocated across its whole chain (every abandoned generation plus the
// live one) is C·f/(f−1): 2× ⇒ 2.00C (1.00C of that is dead, abandoned
// generations), 4× ⇒ 1.33C (0.33C dead) — quadrupling cuts the dead-
// generation tax by two thirds. The cost is coarser post-grow load factor
// (more headroom sits briefly unused right after a jump: 4× lands a table
// at 18.75% full instead of 2×'s 37.5%), which only matters for the FINAL
// grow a table ever does — bounded, and only paid by tables that actually
// reach GROW_QUAD_CAP.
//
// Measured (2026-08-22, fresh site attribution on the jz×jz goal-gate,
// dormant/shipped config, .work/evidence.md): the overwhelming majority of
// tables — every per-object dyn-props hash chief among them — never grow
// past a handful of entries at all (≈94% of one run's __hash_new_small
// tables never triggered a single subsequent grow). Doubling stays exactly
// as it was for all of those — this policy only changes behavior once a
// table has already grown past GROW_QUAD_CAP, which is precisely where a
// self-hosted compiler's own large, long-lived tables (symbol/intern
// tables, ctx-level maps) concentrate.
//
// cap MUST stay a power of 2 either way — every probe's index wraparound is
// an `(i32.and idx (cap-1))` mask, not a modulo — and ×4 (shl by 2) preserves
// that identically to ×2 (shl by 1), so this is a pure capacity-growth-rate
// change: same open addressing, same probe sequence shape, same $__seq-
// ordered iteration (capacity is never observable from JS), just fewer
// generations for a table large enough to reach the tier.
export const GROW_QUAD_CAP = 8192
const nextCapIR = (capLocal = '$cap', newcapLocal = '$newcap') =>
  `(local.set ${newcapLocal} (i32.shl (local.get ${capLocal})
    (select (i32.const 2) (i32.const 1) (i32.ge_u (local.get ${capLocal}) (i32.const ${GROW_QUAD_CAP})))))`
const probeStart = (entrySize, idxExpr = '(i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1)))') => hasProbeLane()
  ? `(local.set $lb (i32.add (local.get $off) (i32.mul (local.get $cap) (i32.const ${entrySize}))))
    (local.set $end (i32.add (local.get $lb) (i32.shl (local.get $cap) (i32.const 2))))
    (local.set $ls (i32.add (local.get $lb) (i32.shl ${idxExpr} (i32.const 2))))`
  : `(local.set $end (i32.add (local.get $off) (i32.mul (local.get $cap) (i32.const ${entrySize}))))
    (local.set $slot (i32.add (local.get $off) (i32.mul ${idxExpr} (i32.const ${entrySize}))))`
const probeNext = (entrySize) => hasProbeLane()
  ? `(local.set $ls (i32.add (local.get $ls) (i32.const 4)))
      (if (i32.ge_u (local.get $ls) (local.get $end)) (then (local.set $ls (local.get $lb))))`
  : `(local.set $slot (i32.add (local.get $slot) (i32.const ${entrySize})))
      (if (i32.ge_u (local.get $slot) (local.get $end)) (then (local.set $slot (local.get $off))))`
const indexedProbeStart = (entrySize) => hasProbeLane()
  ? `(local.set $lb (i32.add (local.get $off) (i32.mul (local.get $cap) (i32.const ${entrySize}))))
    (local.set $end (i32.add (local.get $lb) (i32.shl (local.get $cap) (i32.const 2))))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $ls (i32.add (local.get $lb) (i32.shl (local.get $idx) (i32.const 2))))`
  : `(local.set $end (i32.add (local.get $off) (i32.mul (local.get $cap) (i32.const ${entrySize}))))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${entrySize}))))`
const indexedProbeNext = (entrySize) => hasProbeLane()
  ? `(local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (local.set $ls (i32.add (local.get $ls) (i32.const 4)))
      (if (i32.ge_u (local.get $ls) (local.get $end)) (then (local.set $ls (local.get $lb))))`
  : probeNext(entrySize)
const slotFromIndexed = (entrySize) => hasProbeLane()
  ? `(local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${entrySize}))))`
  : ''
const slotFromLane = (entrySize) => hasProbeLane()
  ? `(local.set $slot (i32.add (local.get $off)
        (i32.mul (i32.shr_u (i32.sub (local.get $ls) (local.get $lb)) (i32.const 2)) (i32.const ${entrySize}))))`
  : ''
const laneLocals = '(local $lb i32) (local $ls i32) (local $hw i32)'
const probeHashLoad = () => hasProbeLane()
  ? '(local.set $hw (i32.load (local.get $ls)))'
  : '(local.set $hw (i32.load (local.get $slot)))'
const probeHashStore = () => hasProbeLane() ? '(i32.store (local.get $ls) (local.get $h))' : ''
const useRememberedZombie = () => hasProbeLane()
  ? '(local.set $slot (local.get $zb)) (local.set $ls (local.get $zbl))'
  : '(local.set $slot (local.get $zb))'
const rememberZombie = () => hasProbeLane()
  ? '(local.set $zb (local.get $slot)) (local.set $zbl (local.get $ls))'
  : '(local.set $zb (local.get $slot))'
const restoreZombieProbe = () => hasProbeLane() ? '(local.set $ls (local.get $zbl))' : ''
const laneBaseInit = (base, cap, entrySize) => hasProbeLane()
  ? `(local.set $${base} (i32.add (local.get $newptr) (i32.mul (local.get $${cap}) (i32.const ${entrySize}))))`
  : ''
const laneRehashStore = (base, idx) => hasProbeLane()
  ? `(i32.store (i32.add (local.get $${base}) (i32.shl (local.get $${idx}) (i32.const 2))) (local.get $h))`
  : ''
const deleteShiftInit = () => hasProbeLane()
  ? `(local.set $i (local.get $slot))
    (local.set $j (local.get $slot))
    (local.set $li (local.get $ls))
    (local.set $lj (local.get $ls))`
  : `(local.set $i (local.get $slot))
    (local.set $j (local.get $slot))`
const deleteShiftNext = (entrySize) => hasProbeLane()
  ? `(local.set $j (i32.add (local.get $j) (i32.const ${entrySize})))
      (local.set $lj (i32.add (local.get $lj) (i32.const 4)))
      (if (i32.ge_u (local.get $lj) (local.get $end))
        (then (local.set $j (local.get $off)) (local.set $lj (local.get $lb))))`
  : `(local.set $j (i32.add (local.get $j) (i32.const ${entrySize})))
      (if (i32.ge_u (local.get $j) (local.get $end)) (then (local.set $j (local.get $off))))`
const deleteShiftLaneMove = () => hasProbeLane()
  ? `(i32.store (local.get $li) (i32.load (local.get $lj)))
      (local.set $i (local.get $j))
      (local.set $li (local.get $lj))`
  : '(local.set $i (local.get $j))'
const deleteShiftLaneClear = () => hasProbeLane() ? '(i32.store (local.get $li) (i32.const 0))' : ''
// cap-tries exhausted with no remembered zombie: rescan for any TOMB key via
// the shared cold helper. A true full-live table is unreachable behind growth.
const zombieRescan = (entrySize) => hasProbeLane()
  ? `(if (i32.eqz (local.get $zb)) (then
            (local.set $zb (call $__zomb_scan (local.get $off) (local.get $cap) (i32.const ${entrySize})))
            (local.set $zbl (i32.add (local.get $lb)
              (i32.shl (i32.div_u (i32.sub (local.get $zb) (local.get $off)) (i32.const ${entrySize})) (i32.const 2))))))`
  : `(if (i32.eqz (local.get $zb)) (then
            (local.set $zb (call $__zomb_scan (local.get $off) (local.get $cap) (i32.const ${entrySize})))))`

// Store a fresh entry's hash word, packing a monotonic insertion sequence
// (global $__seq) into its free high 32 bits. The hash itself only ever occupies
// the low 32 (always ≥2), so "empty slot ⇔ word==0" and the i32.wrap_i64
// home-bucket math are untouched; rehash/back-shift copy the whole word, so the
// sequence rides along for free. Iteration reads it back (via __coll_order) to
// restore JS insertion order. Emitted only on the insert-new branch — updates
// keep the original entry (and its sequence) in place.
const seqStore = `(i64.store (local.get $slot)
            (i64.or (i64.extend_i32_u (local.get $h)) (i64.shl (i64.extend_i32_u (global.get $__seq)) (i64.const 32))))
          (global.set $__seq (i32.add (global.get $__seq) (i32.const 1)))`

/** Generate upsert (add/set) probe for a growable collection (Set/Map). hasVal: store
 *  value at slot+16. hasExt: emit EXTERNAL fallthrough (call $__ext_set on non-matching
 *  type). Gated off → type mismatch just returns coll unchanged.
 *
 *  The table grows at 75% load by allocating a 2×/4× table (nextCapIR — tiered past
 *  GROW_QUAD_CAP), rehashing, and forward-marking the old header (cap=-1 sentinel, new
 *  offset at -8) — the array growth idiom. The boxed
 *  pointer the caller holds is returned UNCHANGED; future ops resolve it through
 *  __ptr_offset, which follows the chain. This is why Set/Map (held in caller locals, and
 *  possibly aliased) forward rather than remint like HASH (whose pointer lives in a single
 *  owner's propsPtr slot that genUpsertGrow can rewrite). */
function genUpsert(name, entrySize, hashFn, eqExpr, expectedType, hasVal, hasExt) {
  const valParam = hasVal ? '(param $val i64) ' : ''
  const slotLog = hasVal ? durableSlotLogIR('slot', 16, 'val') : ''
  const storeVal = hasVal ? `\n          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))${slotLog}` : ''
  const onMatch = hasVal
    ? `(then\n          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))${slotLog}\n          (br $done))`
    : `(then (br $done))`
  const rehashVal = hasVal
    ? `\n              (i64.store (i32.add (local.get $newslot) (i32.const 16)) (i64.load (i32.add (local.get $oldslot) (i32.const 16))))`
    : ''

  const extBranch = hasVal
    ? '(then (call $__ext_set (local.get $coll) (local.get $key) (local.get $val)) drop)'
    : '(then (nop))'
  const tExpr = `(i32.wrap_i64 (i64.and (i64.shr_u (local.get $coll) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`
  const typeGuard = hasExt
    ? `(if (i32.ne ${tExpr} (i32.const ${expectedType})) (then (if (i32.eq ${tExpr} (i32.const ${PTR.EXTERNAL})) ${extBranch}) (return (local.get $coll))))`
    : `(if (i32.ne ${tExpr} (i32.const ${expectedType})) (then (return (local.get $coll))))`
  return `(func $${name} (param $coll i64) (param $key i64) ${valParam}(result i64)
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32)
    (local $size i32) (local $newptr i32) (local $newcap i32) (local $i i32)
    (local $oldslot i32) (local $newidx i32) (local $newslot i32) (local $zb i32) (local $ztr i32)
    ${laneLocals} (local $zbl i32) (local $nlb i32)
    ${typeGuard}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $coll) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ;; the cap load IS the forward check: -1 sentinel hops via the cold helper,
    ;; the live path pays zero extra — the per-probe __ptr_offset call drops
    (if (i32.eq (local.get $cap) (i32.const -1))
      (then
        (local.set $off (call $__ptr_offset_fwd (local.get $off)))
        (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))))
    (local.set $size (i32.load (i32.sub (local.get $off) (i32.const 8))))
    ;; Grow at 75% load (size*4 >= cap*3): 2×/4× table (nextCapIR), rehash, forward-mark old header.
    (if (i32.ge_s (i32.mul (local.get $size) (i32.const 4)) (i32.mul (local.get $cap) (i32.const 3)))
      (then
        ${nextCapIR()}
        (local.set $newptr (call $__alloc_hdr_n (i32.const 0) (local.get $newcap) (i32.const ${collectionStride(entrySize)})))
        ${laneBaseInit('nlb', 'newcap', entrySize)}
        (i64.store (i32.sub (local.get $newptr) (i32.const 16)) (i64.load (i32.sub (local.get $off) (i32.const 16))))
        (local.set $i (i32.const 0))
        (block $rd (loop $rl
          (br_if $rd (i32.ge_s (local.get $i) (local.get $cap)))
          (local.set $oldslot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const ${entrySize}))))
          (if (i64.ne (i64.load (local.get $oldslot)) (i64.const 0))
            (then
              (local.set $h (call ${hashFn} (i64.load (i32.add (local.get $oldslot) (i32.const 8)))))
              (local.set $newidx (i32.and (local.get $h) (i32.sub (local.get $newcap) (i32.const 1))))
              (block $ins (loop $probe2
                (local.set $newslot (i32.add (local.get $newptr) (i32.mul (local.get $newidx) (i32.const ${entrySize}))))
                (br_if $ins (i64.eqz (i64.load (local.get $newslot))))
                (local.set $newidx (i32.and (i32.add (local.get $newidx) (i32.const 1)) (i32.sub (local.get $newcap) (i32.const 1))))
                (br $probe2)))
              (i64.store (local.get $newslot) (i64.load (local.get $oldslot)))
              (i64.store (i32.add (local.get $newslot) (i32.const 8)) (i64.load (i32.add (local.get $oldslot) (i32.const 8))))${rehashVal}
              ${laneRehashStore('nlb', 'newidx')}
              (i32.store (i32.sub (local.get $newptr) (i32.const 8))
                (i32.add (i32.load (i32.sub (local.get $newptr) (i32.const 8))) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $rl)))
        ${durableFwdLogIR('off', 'newptr', 'size', 'cap')}
        (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newptr))
        (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
        (local.set $off (local.get $newptr))
        (local.set $cap (local.get $newcap))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    ;; zombie-aware ${hasProbeLane() ? 'LANE ' : ''}probe (durable-slot heal, TOMB_NAN keys): a zombie keeps
    ;; its stale hash in the ${hasProbeLane() ? 'lane' : 'entry word'}, so it is only NOTICED on a hash hit (key reads
    ;; TOMB) — reuse still catches the dominant re-insert-same-key case, and the
    ;; cap-tries fallback rescans for any zombie before giving up.
    (block $done (loop $probe
      ${probeHashLoad()}
      (if (i32.eqz (local.get $hw))
        (then
          (if (local.get $zb)
            (then ${useRememberedZombie()})
            (else ${slotFromLane(entrySize)}))
          ${seqStore}
          ${probeHashStore()}
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${durableEntryLogIR('slot', 'off')}${storeVal}
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromLane(entrySize)}
          (if (i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (i64.const ${TOMB_NAN}))
            (then (if (i32.eqz (local.get $zb))
              (then ${rememberZombie()})))
            (else (if ${eqExpr} ${onMatch})))))
      ${probeNext(entrySize)}
      (local.set $ztr (i32.add (local.get $ztr) (i32.const 1)))
      (if (i32.ge_s (local.get $ztr) (local.get $cap))
        (then
          ${zombieRescan(entrySize)}
          (local.set $slot (local.get $zb))
          ${restoreZombieProbe()}
          ${seqStore}
          ${probeHashStore()}
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${durableEntryLogIR('slot', 'off')}${storeVal}
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (br $probe)))
    (local.get $coll))`
}

/** Generate lookup probe function.
 *  wantValue=true: return slot value, missing => `undefined` (UNDEF_NAN) — a
 *    missing Map entry / object property reads as `undefined` in JS, never null.
 *  wantValue=false: return i32 0/1 existence flag.
 *  hasExt: emit EXTERNAL fallthrough (delegate to __ext_prop/__ext_has). */
function genLookup(name, entrySize, hashFn, eqExpr, expectedType, wantValue, hasExt) {
  const rt = wantValue ? 'i64' : 'i32'
  const onEmpty = wantValue
    ? `(return (i64.const ${UNDEF_NAN}))`
    : '(return (i32.const 0))'
  const onFound = wantValue
    ? '(return (i64.load (i32.add (local.get $slot) (i32.const 16))))'
    : '(return (i32.const 1))'
  const notFound = wantValue
    ? `(i64.const ${UNDEF_NAN})`
    : '(i32.const 0)'
  const tExpr = `(i32.wrap_i64 (i64.and (i64.shr_u (local.get $coll) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`
  const typeGuard = hasExt
    ? `(if (i32.ne ${tExpr} (i32.const ${expectedType})) (then (if (i32.eq ${tExpr} (i32.const ${PTR.EXTERNAL}))
        (then (return ${wantValue
          ? '(call $__ext_prop (local.get $coll) (local.get $key))'
          : '(call $__ext_has (local.get $coll) (local.get $key))'}))
        (else ${onEmpty}))))`
    : `(if (i32.ne ${tExpr} (i32.const ${expectedType})) (then ${onEmpty}))`
  // SET/MAP/HASH all grow by forward-marking the old header (genUpsert / genUpsertGrow
  // with forward=true), so a boxed pointer may be stale → resolve through the chain.
  const offExpr = '(call $__ptr_offset (local.get $coll))'

  return `(func $${name} (param $coll i64) (param $key i64) (result ${rt})
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32) (local $tries i32)
    ${laneLocals}
    ${typeGuard}
    (local.set $off ${offExpr})
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      ${probeHashLoad()}
      (if (i32.eqz (local.get $hw)) (then ${onEmpty}))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromLane(entrySize)}
          (if ${eqExpr} (then ${onFound}))))
      ${probeNext(entrySize)}
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    ${notFound})`
}

/** Generate delete probe function. Backward-shift deletion: after removing an entry,
 *  pull back any following entry whose home slot lies outside the opened gap, so the
 *  "empty slot ⇒ end of probe chain" invariant holds without tombstones. Returns 1 if
 *  the key was present (and len decremented), 0 otherwise. Home slots are recomputed
 *  from the stored hash (low 32 bits), so no rehash of the key is needed during the shift. */
function genDelete(name, entrySize, hashFn, eqExpr, expectedType) {
  // for-in enum cache invalidation (core.js __hash_keys_ro / object.js
  // emitEnumerateObject): delete is the one key-set change the cache's
  // (off, len) key can miss — a later insert restores the cached len with a
  // different key set. Unconditional clear (not off-compare): the OBJECT-arm
  // cache is keyed by SIDECAR off, but a durable receiver's runtime props live
  // in per-object hashes under __dyn_props whose offs the cache never sees —
  // a delete there must still invalidate. HASH deletes are cold; SET/MAP
  // tables never feed enumeration, so only the HASH instance pays.
  const enumcInval = expectedType === PTR.HASH
    ? `(global.set $__enumc_off (i32.const 0))
    `
    : ''
  return `(func $${name} (param $coll i64) (param $key i64) (result i32)
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32) (local $tries i32)
    (local $i i32) (local $j i32) (local $k i32) (local $n i32)
    ${laneLocals} (local $li i32) (local $lj i32)
    (if (i32.ne (call $__ptr_type (local.get $coll)) (i32.const ${expectedType})) (then (return (i32.const 0))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $coll) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ;; the cap load IS the forward check: -1 sentinel hops via the cold helper,
    ;; the live path pays zero extra — the per-probe __ptr_offset call drops
    (if (i32.eq (local.get $cap) (i32.const -1))
      (then
        (local.set $off (call $__ptr_offset_fwd (local.get $off)))
        (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $found
      (block $absent (loop $probe
        ${probeHashLoad()}
        (if (i32.eqz (local.get $hw)) (then (br $absent)))
        (if (i32.eq (local.get $hw) (local.get $h))
          (then
            ${slotFromLane(entrySize)}
            (if ${eqExpr} (then (br $found)))))
        ${probeNext(entrySize)}
        (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
        (br_if $absent (i32.ge_s (local.get $tries) (local.get $cap)))
        (br $probe)))
      (return (i32.const 0)))
    ;; $slot holds the entry to remove ($ls its lane word). Cancel any pending
    ;; durable log for THIS key's own address before the shift walk below can
    ;; relocate a DIFFERENT (still-live) entry onto that same address — cancelling
    ;; after the walk instead cannot tell the two apart once they collide (see
    ;; durableSlotCancelIR's comment for the full native repro).
    ${durableSlotCancelIR('slot', entrySize)}
    ;; Walk forward; move back any entry whose home is not cyclically within
    ;; (i, j], else it would become unreachable from its home. The normal
    ;; layout moves the redundant lane word in parallel.
    ${deleteShiftInit()}
    (block $stop (loop $shift
      ${deleteShiftNext(entrySize)}
      (br_if $stop (i64.eqz (i64.load (local.get $j))))
      ;; Empty slot ends the cluster (load < 100%). A 100%-full table has none — lookups
      ;; tolerate that via the $tries<cap bound, so delete must too: after $cap advances $j
      ;; has cycled back to the gap origin; stop and clear the final gap.
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br_if $stop (i32.ge_u (local.get $n) (local.get $cap)))
      (local.set $k (i32.add (local.get $off)
        (i32.mul (i32.and (i32.wrap_i64 (i64.load (local.get $j))) (i32.sub (local.get $cap) (i32.const 1))) (i32.const ${entrySize}))))
      (if (i32.le_u (local.get $i) (local.get $j))
        (then (br_if $shift (i32.and (i32.lt_u (local.get $i) (local.get $k)) (i32.le_u (local.get $k) (local.get $j)))))
        (else (br_if $shift (i32.or  (i32.lt_u (local.get $i) (local.get $k)) (i32.le_u (local.get $k) (local.get $j))))))
      (memory.copy (local.get $i) (local.get $j) (i32.const ${entrySize}))${durableSlotRelogIR('j', 'i', entrySize)}
      ${deleteShiftLaneMove()}
      (br $shift)))
    (i64.store (local.get $i) (i64.const 0))
    (i64.store (i32.add (local.get $i) (i32.const 8)) (i64.const 0))
    ${deleteShiftLaneClear()}
    ${enumcInval}(i32.store (i32.sub (local.get $off) (i32.const 8))
      (i32.sub (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
    (i32.const 1))`
}

/** Generate growable upsert. Grows table at 75% load, rehashes, then inserts.
 *  strict=true: reject wrong type.
 *  strict=false: EXTERNAL → __ext_set, other non-HASH types → __dyn_set (global props).
 *  The non-strict fallback is critical for untyped variables (e.g. arrays from
 *  Object.create) that receive property writes — without it writes silently vanish. */
function genUpsertGrow(name, entrySize, hashFn, eqExpr, typeConst, strict = false, hasExt = false, forward = false) {
  const nonHashFallback = hasExt
    ? `(if (i32.eq (call $__ptr_type (local.get $obj)) (i32.const ${PTR.EXTERNAL}))
            (then (call $__ext_set (local.get $obj) (local.get $key) (local.get $val)) drop)
            (else (call $__dyn_set (local.get $obj) (local.get $key) (local.get $val)) drop))`
    : `(call $__dyn_set (local.get $obj) (local.get $key) (local.get $val)) drop`
  const typeGuard = strict
    ? `(if (i32.ne (call $__ptr_type (local.get $obj)) (i32.const ${typeConst}))
      (then (return (local.get $obj))))`
    : `(if (i32.ne (call $__ptr_type (local.get $obj)) (i32.const ${typeConst}))
        (then
          ${nonHashFallback}
          (return (local.get $obj))))`
  return `(func $${name} (param $obj i64) (param $key i64) (param $val i64) (result i64)
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32)
    (local $size i32) (local $newptr i32) (local $newcap i32) (local $i i32)
    (local $oldslot i32) (local $newidx i32) (local $newslot i32) (local $zb i32) (local $ztr i32)
    ${laneLocals} (local $zbl i32) (local $nlb i32)
    ${typeGuard}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ;; the cap load IS the forward check: -1 sentinel hops via the cold helper,
    ;; the live path pays zero extra — the per-probe __ptr_offset call drops
    (if (i32.eq (local.get $cap) (i32.const -1))
      (then
        (local.set $off (call $__ptr_offset_fwd (local.get $off)))
        (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))))
    (local.set $size (i32.load (i32.sub (local.get $off) (i32.const 8))))
    ;; Grow if load factor > 75%: size * 4 >= cap * 3
    (if (i32.ge_s (i32.mul (local.get $size) (i32.const 4)) (i32.mul (local.get $cap) (i32.const 3)))
      (then
        ${nextCapIR()}
        (local.set $newptr (call $__alloc_hdr_n (i32.const 0) (local.get $newcap) (i32.const ${collectionStride(entrySize)})))
        ${laneBaseInit('nlb', 'newcap', entrySize)}
        (local.set $i (i32.const 0))
        (block $rd (loop $rl
          (br_if $rd (i32.ge_s (local.get $i) (local.get $cap)))
          (local.set $oldslot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const ${entrySize}))))
          (if (i64.ne (i64.load (local.get $oldslot)) (i64.const 0))
            (then
              (local.set $h (call ${hashFn} (i64.load (i32.add (local.get $oldslot) (i32.const 8)))))
              (local.set $newidx (i32.and (local.get $h) (i32.sub (local.get $newcap) (i32.const 1))))
              (block $ins (loop $probe2
                (local.set $newslot (i32.add (local.get $newptr) (i32.mul (local.get $newidx) (i32.const ${entrySize}))))
                (br_if $ins (i64.eqz (i64.load (local.get $newslot))))
                (local.set $newidx (i32.and (i32.add (local.get $newidx) (i32.const 1)) (i32.sub (local.get $newcap) (i32.const 1))))
                (br $probe2)))
              (i64.store (local.get $newslot) (i64.load (local.get $oldslot)))
              (i64.store (i32.add (local.get $newslot) (i32.const 8)) (i64.load (i32.add (local.get $oldslot) (i32.const 8))))
              (i64.store (i32.add (local.get $newslot) (i32.const 16)) (i64.load (i32.add (local.get $oldslot) (i32.const 16))))
              ${laneRehashStore('nlb', 'newidx')}
              (i32.store (i32.sub (local.get $newptr) (i32.const 8))
                (i32.add (i32.load (i32.sub (local.get $newptr) (i32.const 8))) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $rl)))
        ${forward
          // Forward-mark the old header (cap=-1 sentinel at -4, new offset at -8) and
          // keep the boxed pointer the caller holds: any alias resolves through
          // __ptr_offset. This preserves JS reference identity for a grown dict held in
          // multiple places (e.g. ctx.core.emit), which remint cannot. Log the pre-grow
          // (off, size, cap) first (durableFwdLogIR — no-op unless $off predates this
          // round) so `_clear` can heal a durable header instead of leaving it forwarded
          // at an ephemeral target that the next round overwrites.
          ? `${durableFwdLogIR('off', 'newptr', 'size', 'cap')}
        (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newptr))
        (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
        (local.set $off (local.get $newptr))
        (local.set $cap (local.get $newcap))`
          // Remint: hand back a fresh boxed pointer. Only safe when a single owner
          // (a local threaded via the return, or the global __dyn_props) is updated.
          : `(local.set $off (local.get $newptr))
        (local.set $cap (local.get $newcap))
        (local.set $obj (i64.reinterpret_f64 (call $__mkptr (i32.const ${typeConst}) (i32.const 0) (local.get $newptr))))`}))
    ;; Insert/update
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    ;; zombie-aware ${hasProbeLane() ? 'LANE ' : ''}probe (durable-slot heal, TOMB_NAN keys) — see genUpsert.
    (block $done (loop $probe
      ${probeHashLoad()}
      (if (i32.eqz (local.get $hw))
        (then
          (if (local.get $zb)
            (then ${useRememberedZombie()})
            (else ${slotFromLane(entrySize)}))
          ${seqStore}
          ${probeHashStore()}
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${durableEntryLogIR('slot', 'off')}
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))${durableSlotLogIR('slot', 16, 'val')}
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromLane(entrySize)}
          (if (i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (i64.const ${TOMB_NAN}))
            (then (if (i32.eqz (local.get $zb))
              (then ${rememberZombie()})))
            (else (if ${eqExpr}
              (then
                (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))${durableSlotLogIR('slot', 16, 'val')}
                (br $done)))))))
      ${probeNext(entrySize)}
      (local.set $ztr (i32.add (local.get $ztr) (i32.const 1)))
      (if (i32.ge_s (local.get $ztr) (local.get $cap))
        (then
          ${zombieRescan(entrySize)}
          (local.set $slot (local.get $zb))
          ${restoreZombieProbe()}
          ${seqStore}
          ${probeHashStore()}
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${durableEntryLogIR('slot', 'off')}
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))${durableSlotLogIR('slot', 16, 'val')}
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (br $probe)))
    (local.get $obj))`
}

/** RMW slot upsert — genUpsertGrow's exact machinery (grow + forward-mark +
 *  zombie-aware probe) returning the entry's VALUE SLOT ADDRESS instead of
 *  storing a value: `o[k] = f(o[k])` fusion (emit-assign.js) hashes and probes
 *  ONCE for the read-modify-write instead of a full get + set pair. On insert
 *  the value seeds `undefined` (what a plain read of a missing key yields) and
 *  the entry-log runs, so the caller's later __slot_write is an ordinary value
 *  update. Sound across growth because the caller's BOX never changes: the old
 *  header forward-marks and the returned address points into the new table.
 *  Returns 0 unless the receiver is a live HASH — caller falls back to the
 *  generic dyn read/write pair. */
function genSlotUpsert(name, entrySize, hashFn, eqExpr) {
  return `(func $${name} (param $obj i64) (param $key i64) (result i32)
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32)
    (local $size i32) (local $newptr i32) (local $newcap i32) (local $i i32)
    (local $oldslot i32) (local $newidx i32) (local $newslot i32) (local $zb i32) (local $ztr i32)
    (local $kaux i32) (local $koff i32)
    ${laneLocals} (local $zbl i32) (local $nlb i32)
    (if (i32.ne (call $__ptr_type (local.get $obj)) (i32.const ${PTR.HASH}))
      (then (return (i32.const 0))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ;; the cap load IS the forward check: -1 sentinel hops via the cold helper,
    ;; the live path pays zero extra — the per-probe __ptr_offset call drops
    (if (i32.eq (local.get $cap) (i32.const -1))
      (then
        (local.set $off (call $__ptr_offset_fwd (local.get $off)))
        (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))))
    (local.set $size (i32.load (i32.sub (local.get $off) (i32.const 8))))
    (if (i32.ge_s (i32.mul (local.get $size) (i32.const 4)) (i32.mul (local.get $cap) (i32.const 3)))
      (then
        ${nextCapIR()}
        (local.set $newptr (call $__alloc_hdr_n (i32.const 0) (local.get $newcap) (i32.const ${collectionStride(entrySize)})))
        ${laneBaseInit('nlb', 'newcap', entrySize)}
        (local.set $i (i32.const 0))
        (block $rd (loop $rl
          (br_if $rd (i32.ge_s (local.get $i) (local.get $cap)))
          (local.set $oldslot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const ${entrySize}))))
          (if (i64.ne (i64.load (local.get $oldslot)) (i64.const 0))
            (then
              (local.set $h (call ${hashFn} (i64.load (i32.add (local.get $oldslot) (i32.const 8)))))
              (local.set $newidx (i32.and (local.get $h) (i32.sub (local.get $newcap) (i32.const 1))))
              (block $ins (loop $probe2
                (local.set $newslot (i32.add (local.get $newptr) (i32.mul (local.get $newidx) (i32.const ${entrySize}))))
                (br_if $ins (i64.eqz (i64.load (local.get $newslot))))
                (local.set $newidx (i32.and (i32.add (local.get $newidx) (i32.const 1)) (i32.sub (local.get $newcap) (i32.const 1))))
                (br $probe2)))
              (i64.store (local.get $newslot) (i64.load (local.get $oldslot)))
              (i64.store (i32.add (local.get $newslot) (i32.const 8)) (i64.load (i32.add (local.get $oldslot) (i32.const 8))))
              (i64.store (i32.add (local.get $newslot) (i32.const 16)) (i64.load (i32.add (local.get $oldslot) (i32.const 16))))
              ${laneRehashStore('nlb', 'newidx')}
              (i32.store (i32.sub (local.get $newptr) (i32.const 8))
                (i32.add (i32.load (i32.sub (local.get $newptr) (i32.const 8))) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $rl)))
        ${durableFwdLogIR('off', 'newptr', 'size', 'cap')}
        (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newptr))
        (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
        (local.set $off (local.get $newptr))
        (local.set $cap (local.get $newcap))))
    ${hashFn === '$__str_hash' ? `;; tiered $__str_hash: the two FAST arms inline — SSO arithmetic mix and
    ;; the heap lazy-hash-cell load, one of which the dictionary-count hot path
    ;; pays per probe. Cold shapes (interned statics, uncached walk — and the
    ;; one-in-4G SSO mix that hashes to 0) call the helper, which recomputes
    ;; identically. Gates mirror $__str_hash's own exactly.
    (local.set $kaux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $key) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
    (local.set $h (i32.const 0))
    (if (i32.eq (i32.wrap_i64 (i64.and (i64.shr_u (local.get $key) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))) (i32.const ${PTR.STRING}))
      (then
        (local.set $koff (i32.wrap_i64 (i64.and (local.get $key) (i64.const ${LAYOUT.OFFSET_MASK}))))
        (if (i32.shr_u (local.get $kaux) (i32.const 14))
          (then
            (local.set $h (i32.mul
              (i32.xor (local.get $koff) (i32.mul (i32.xor (i32.and (local.get $kaux) (i32.const 0x1FFF)) (i32.const 0x9E3779B9)) (i32.const 0x85EBCA6B)))
              (i32.const 0xC2B2AE35)))
            (local.set $h (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 15))))
            ;; $__str_hash's post-mix clamp, replicated EXACTLY (i32.le_s — it
            ;; shifts every NEGATIVE-signed hash by 2, not just 0/1): the
            ;; tiered value must be bit-equal to the helper's return and to
            ;; the lazy hash cells (they cache post-clamp values).
            (if (i32.le_s (local.get $h) (i32.const 1))
              (then (local.set $h (i32.add (local.get $h) (i32.const 2))))))
          (else
            (if (i32.and (i32.ge_u (local.get $koff) (i32.const 8))
                  (i32.eq (i32.and (local.get $kaux) (i32.const ${LAYOUT.SLICE_BIT | STR_HCACHE_BIT})) (i32.const ${STR_HCACHE_BIT})))
              (then (local.set $h (i32.load (i32.sub (local.get $koff) (i32.const 8))))))))))
    (if (i32.eqz (local.get $h)) (then (local.set $h (call ${hashFn} (local.get $key)))))`
    : `(local.set $h (call ${hashFn} (local.get $key)))`}
    ${probeStart(entrySize)}
    (block $done (loop $probe
      ${probeHashLoad()}
      (if (i32.eqz (local.get $hw))
        (then
          (if (local.get $zb)
            (then ${useRememberedZombie()})
            (else ${slotFromLane(entrySize)}))
          ${seqStore}
          ${probeHashStore()}
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${durableEntryLogIR('slot', 'off')}
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (i64.const ${UNDEF_NAN}))
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromLane(entrySize)}
          (if (i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (i64.const ${TOMB_NAN}))
            (then (if (i32.eqz (local.get $zb))
              (then ${rememberZombie()})))
            (else (if ${eqExpr} (then (br $done)))))))
      ${probeNext(entrySize)}
      (local.set $ztr (i32.add (local.get $ztr) (i32.const 1)))
      (if (i32.ge_s (local.get $ztr) (local.get $cap))
        (then
          ${zombieRescan(entrySize)}
          (local.set $slot (local.get $zb))
          ${restoreZombieProbe()}
          ${seqStore}
          ${probeHashStore()}
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${durableEntryLogIR('slot', 'off')}
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (i64.const ${UNDEF_NAN}))
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (br $probe)))
    (i32.add (local.get $slot) (i32.const 16)))`
}

// Fresh non-escaping HASH upsert. The compiler proves this dictionary is used
// only by computed get/RMW sites: no delete (therefore no tombstones), no
// enumeration (therefore no insertion-order sequence), and no escape across a
// heap reset (therefore no durable forwarding/slot logs). Keep the standard
// HASH layout so ordinary strict lookups remain compatible, but make the hot
// upsert the textbook open-addressing loop emitted by C.
function genEphemeralSlotUpsert(name, entrySize) {
  const lane = hasProbeLane()
  const growBases = lane
    ? `(local.set $oldlb (i32.add (local.get $off) (i32.mul (local.get $cap) (i32.const ${entrySize}))))
        (local.set $newlb (i32.add (local.get $newptr) (i32.mul (local.get $newcap) (i32.const ${entrySize}))))`
    : ''
  const loadOldHash = lane
    ? '(local.set $h (i32.load (i32.add (local.get $oldlb) (i32.shl (local.get $i) (i32.const 2)))))'
    : `(local.set $oldslot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const ${entrySize}))))
          (local.set $h (i32.load (local.get $oldslot)))`
  const setOldSlot = lane
    ? `(local.set $oldslot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const ${entrySize}))))`
    : ''
  const findNewSlot = lane
    ? `(local.set $ls (i32.add (local.get $newlb) (i32.shl (local.get $idx) (i32.const 2))))
                (br_if $ins (i32.eqz (i32.load (local.get $ls))))`
    : `(local.set $newslot (i32.add (local.get $newptr) (i32.mul (local.get $idx) (i32.const ${entrySize}))))
                (br_if $ins (i64.eqz (i64.load (local.get $newslot))))`
  const storeNewHash = lane ? '(i32.store (local.get $ls) (local.get $h))' : ''
  const startProbe = lane
    ? `(local.set $lb (i32.add (local.get $off) (i32.mul (local.get $cap) (i32.const ${entrySize}))))
    (local.set $end (i32.add (local.get $lb) (i32.shl (local.get $cap) (i32.const 2))))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $ls (i32.add (local.get $lb) (i32.shl (local.get $idx) (i32.const 2))))`
    : `(local.set $end (i32.add (local.get $off) (i32.mul (local.get $cap) (i32.const ${entrySize}))))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${entrySize}))))`
  const loadProbeHash = lane ? '(i32.load (local.get $ls))' : '(i32.load (local.get $slot))'
  const deriveSlot = lane
    ? `(local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${entrySize}))))`
    : ''
  const storeProbeLane = lane ? '(i32.store (local.get $ls) (local.get $h))' : ''
  const nextProbe = lane
    ? `(local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (local.set $ls (i32.add (local.get $ls) (i32.const 4)))
      (if (i32.ge_u (local.get $ls) (local.get $end)) (then (local.set $ls (local.get $lb))))`
    : `(local.set $slot (i32.add (local.get $slot) (i32.const ${entrySize})))
      (if (i32.ge_u (local.get $slot) (local.get $end)) (then (local.set $slot (local.get $off))))`
  return `(func $${name} (param $obj i64) (param $key i64) (result i32)
    (local $off i32) (local $cap i32) (local $size i32) (local $h i32) (local $kaux i32) (local $koff i32)
    (local $i i32) (local $idx i32) (local $slot i32) (local $hw i32)
    (local $lb i32) (local $ls i32) (local $end i32)
    (local $oldlb i32) (local $oldslot i32)
    (local $newptr i32) (local $newcap i32) (local $newlb i32) (local $newslot i32)
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (if (i32.eq (local.get $cap) (i32.const -1))
      (then
        (local.set $off (call $__ptr_offset_fwd (local.get $off)))
        (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))))
    (local.set $size (i32.load (i32.sub (local.get $off) (i32.const 8))))
    (if (i32.ge_s (i32.shl (local.get $size) (i32.const 2)) (i32.mul (local.get $cap) (i32.const 3)))
      (then
        ${nextCapIR()}
        (local.set $newptr (call $__alloc_hash_eph (i32.const 0) (local.get $newcap)))
        ${growBases}
        (local.set $i (i32.const 0))
        (block $rd (loop $rl
          (br_if $rd (i32.ge_s (local.get $i) (local.get $cap)))
          ${loadOldHash}
          (if (local.get $h)
            (then
              ${setOldSlot}
              (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $newcap) (i32.const 1))))
              (block $ins (loop $pl2
                ${findNewSlot}
                (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $newcap) (i32.const 1))))
                (br $pl2)))
              (local.set $newslot (i32.add (local.get $newptr) (i32.mul (local.get $idx) (i32.const ${entrySize}))))
              (i64.store (local.get $newslot) (i64.load (local.get $oldslot)))
              (i64.store offset=8 (local.get $newslot) (i64.load offset=8 (local.get $oldslot)))
              (i64.store offset=16 (local.get $newslot) (i64.load offset=16 (local.get $oldslot)))
              ${storeNewHash}))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $rl)))
        (i32.store (i32.sub (local.get $newptr) (i32.const 8)) (local.get $size))
        (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newptr))
        (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
        (local.set $off (local.get $newptr))
        (local.set $cap (local.get $newcap))))
    ;; Cached/tiny string hash fast paths inline (same contract as __str_hash).
    (local.set $kaux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $key) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
    (local.set $koff (i32.wrap_i64 (i64.and (local.get $key) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $h (i32.const 0))
    (if (i32.eq (i32.wrap_i64 (i64.and (i64.shr_u (local.get $key) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))) (i32.const ${PTR.STRING}))
      (then
        (if (i32.shr_u (local.get $kaux) (i32.const 14))
          (then
            (local.set $h (i32.mul
              (i32.xor (local.get $koff) (i32.mul (i32.xor (i32.and (local.get $kaux) (i32.const 0x1FFF)) (i32.const 0x9E3779B9)) (i32.const 0x85EBCA6B)))
              (i32.const 0xC2B2AE35)))
            (local.set $h (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 15))))
            (if (i32.le_s (local.get $h) (i32.const 1)) (then (local.set $h (i32.add (local.get $h) (i32.const 2))))))
          (else
            (if (i32.and (i32.ge_u (local.get $koff) (i32.const 8))
                  (i32.eq (i32.and (local.get $kaux) (i32.const ${LAYOUT.SLICE_BIT | STR_HCACHE_BIT})) (i32.const ${STR_HCACHE_BIT})))
              (then (local.set $h (i32.load (i32.sub (local.get $koff) (i32.const 8))))))))))
    (if (i32.eqz (local.get $h)) (then (local.set $h (call $__str_hash (local.get $key)))))
    ${startProbe}
    (block $done (loop $probe
      (local.set $hw ${loadProbeHash})
      (if (i32.eqz (local.get $hw))
        (then
          ${deriveSlot}
          (i64.store (local.get $slot) (i64.extend_i32_u (local.get $h)))
          (i64.store offset=8 (local.get $slot) (local.get $key))
          (i64.store offset=16 (local.get $slot) (i64.const ${UNDEF_NAN}))
          ${storeProbeLane}
          (i32.store (i32.sub (local.get $off) (i32.const 8)) (i32.add (local.get $size) (i32.const 1)))
          (br $done)))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${deriveSlot}
          (br_if $done
            (if (result i32)
              (i64.eq (i64.load offset=8 (local.get $slot)) (local.get $key))
              (then (i32.const 1))
              (else (call $__str_eq (i64.load offset=8 (local.get $slot)) (local.get $key)))))))
      ${nextProbe}
      (br $probe)))
    (i32.add (local.get $slot) (i32.const 16)))`
}

// Capacity-planned sibling: analysis proved all inserted keys originate from
// one finite domain and allocated ≥4× that domain, so growth/forwarding and the
// size counter are unreachable. capHint folds the header load for a fixed-size
// domain; zero retains the dynamic-domain form.
function genEphemeralFixedSlot(name, entrySize) {
  return `(func $${name} (param $obj i64) (param $key i64) (param $capHint i32) (result i32)
    (local $off i32) (local $cap i32) (local $h i32) (local $kaux i32) (local $koff i32)
    (local $idx i32) (local $slot i32) (local $hw i32) (local $lb i32) (local $ls i32) (local $end i32)
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (local.get $capHint))
    (if (i32.eqz (local.get $cap))
      (then (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))))
    (local.set $kaux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $key) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
    (local.set $koff (i32.wrap_i64 (i64.and (local.get $key) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $h (i32.const 0))
    (if (i32.eq (i32.wrap_i64 (i64.and (i64.shr_u (local.get $key) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))) (i32.const ${PTR.STRING}))
      (then
        (if (i32.shr_u (local.get $kaux) (i32.const 14))
          (then
            (local.set $h (i32.mul
              (i32.xor (local.get $koff) (i32.mul (i32.xor (i32.and (local.get $kaux) (i32.const 0x1FFF)) (i32.const 0x9E3779B9)) (i32.const 0x85EBCA6B)))
              (i32.const 0xC2B2AE35)))
            (local.set $h (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 15))))
            (if (i32.le_s (local.get $h) (i32.const 1)) (then (local.set $h (i32.add (local.get $h) (i32.const 2))))))
          (else
            (if (i32.and (i32.ge_u (local.get $koff) (i32.const 8))
                  (i32.eq (i32.and (local.get $kaux) (i32.const ${LAYOUT.SLICE_BIT | STR_HCACHE_BIT})) (i32.const ${STR_HCACHE_BIT})))
              (then (local.set $h (i32.load (i32.sub (local.get $koff) (i32.const 8))))))))))
    (if (i32.eqz (local.get $h)) (then (local.set $h (call $__str_hash (local.get $key)))))
    ${indexedProbeStart(entrySize)}
    (block $done (loop $probe
      ${probeHashLoad()}
      (if (i32.eqz (local.get $hw))
        (then
          ${slotFromIndexed(entrySize)}
          (i64.store (local.get $slot) (i64.extend_i32_u (local.get $h)))
          (i64.store offset=8 (local.get $slot) (local.get $key))
          (i64.store offset=16 (local.get $slot) (i64.const ${UNDEF_NAN}))
          ${probeHashStore()}
          (br $done)))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromIndexed(entrySize)}
          (br_if $done
            (if (result i32) (i64.eq (i64.load offset=8 (local.get $slot)) (local.get $key))
              (then (i32.const 1))
              (else (call $__str_eq (i64.load offset=8 (local.get $slot)) (local.get $key)))))))
      ${indexedProbeNext(entrySize)}
      (br $probe)))
    (i32.add (local.get $slot) (i32.const 16)))`
}

function genLookupStrict(name, entrySize, hashFn, eqExpr, expectedType, missing = UNDEF_NAN) {
  return `(func $${name} (param $coll i64) (param $key i64) (result i64)
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32) (local $tries i32)
    ${laneLocals}
    (if (i32.ne
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $coll) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${expectedType}))
      (then (return (i64.const ${missing}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $coll) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ;; the cap load IS the forward check: -1 sentinel hops via the cold helper,
    ;; the live path pays zero extra — the per-probe __ptr_offset call drops
    (if (i32.eq (local.get $cap) (i32.const -1))
      (then
        (local.set $off (call $__ptr_offset_fwd (local.get $off)))
        (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      ${probeHashLoad()}
      (if (i32.eqz (local.get $hw))
        (then (return (i64.const ${missing}))))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromLane(entrySize)}
          (if ${eqExpr}
            (then (return (i64.load (i32.add (local.get $slot) (i32.const 16))))))))
      ${probeNext(entrySize)}
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (i64.const ${missing}))`
}

// wantValue=true (default): return the slot value, missing → `missing` (i64). wantValue=false:
// return an i32 0/1 existence flag (for `.has`). Mirrors genLookup's two-mode shape, prehashed.
function genLookupStrictPrehashed(name, entrySize, eqExpr, expectedType, missing = UNDEF_NAN, hasExt = false, wantValue = true) {
  const rt = wantValue ? 'i64' : 'i32'
  const onEmpty = wantValue ? `(return (i64.const ${missing}))` : '(return (i32.const 0))'
  const onFound = wantValue ? '(return (i64.load (i32.add (local.get $slot) (i32.const 16))))' : '(return (i32.const 1))'
  const notFound = wantValue ? `(i64.const ${missing})` : '(i32.const 0)'
  const extHit = wantValue ? '(call $__ext_prop (local.get $coll) (local.get $key))' : '(call $__ext_has (local.get $coll) (local.get $key))'
  const tExpr = `(i32.wrap_i64 (i64.and (i64.shr_u (local.get $coll) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`
  const typeGuard = hasExt
    ? `(if (i32.ne ${tExpr} (i32.const ${expectedType}))
      (then
        (if (i32.eq ${tExpr} (i32.const ${PTR.EXTERNAL}))
          (then (return ${extHit}))
          (else ${onEmpty}))))`
    : `(if (i32.ne ${tExpr} (i32.const ${expectedType}))
      (then ${onEmpty}))`
  return `(func $${name} (param $coll i64) (param $key i64) (param $h i32) (result ${rt})
    (local $off i32) (local $cap i32) (local $end i32) (local $slot i32) (local $tries i32)
    ${laneLocals}
    ${typeGuard}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $coll) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ;; the cap load IS the forward check: -1 sentinel hops via the cold helper,
    ;; the live path pays zero extra — the per-probe __ptr_offset call drops
    (if (i32.eq (local.get $cap) (i32.const -1))
      (then
        (local.set $off (call $__ptr_offset_fwd (local.get $off)))
        (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      ${probeHashLoad()}
      (if (i32.eqz (local.get $hw)) (then ${onEmpty}))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromLane(entrySize)}
          (if ${eqExpr} (then ${onFound}))))
      ${probeNext(entrySize)}
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    ${notFound})`
}

// `hasVal` (region-arena rebuild fix, .work/evidence.md §Region arena):
// added so PTR.SET (16-byte, key-only entries — no room for a value word at
// slot+16) can share this generator instead of a hand-duplicated copy —
// mirrors genUpsert's own hasVal toggle immediately above verbatim. Default
// true preserves every existing caller (__hash_set_local_h, MAP-shaped)
// byte-for-byte.
function genUpsertStrictPrehashed(name, entrySize, eqExpr, expectedType, hasVal = true) {
  const valParam = hasVal ? '(param $val i64) ' : ''
  const storeValNew = hasVal ? `\n          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))${durableSlotLogIR('slot', 16, 'val')}` : ''
  const storeValMatch = hasVal
    ? `(then\n                (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))${durableSlotLogIR('slot', 16, 'val')}\n                (br $done))`
    : `(then (br $done))`
  return `(func $${name} (param $obj i64) (param $key i64) (param $h i32) ${valParam}(result i64)
    (local $off i32) (local $cap i32) (local $end i32) (local $slot i32) (local $zb i32) (local $ztr i32)
    ${laneLocals} (local $zbl i32)
    (if (i32.ne
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${expectedType}))
      (then (return (local.get $obj))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ;; the cap load IS the forward check: -1 sentinel hops via the cold helper,
    ;; the live path pays zero extra — the per-probe __ptr_offset call drops
    (if (i32.eq (local.get $cap) (i32.const -1))
      (then
        (local.set $off (call $__ptr_offset_fwd (local.get $off)))
        (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))))
    ${probeStart(entrySize)}
    ;; zombie-aware ${hasProbeLane() ? 'LANE ' : ''}probe (durable-slot heal, TOMB_NAN keys) — see genUpsert.
    (block $done (loop $probe
      ${probeHashLoad()}
      (if (i32.eqz (local.get $hw))
        (then
          (if (local.get $zb)
            (then ${useRememberedZombie()})
            (else ${slotFromLane(entrySize)}))
          ${seqStore}
          ${probeHashStore()}
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${durableEntryLogIR('slot', 'off')}${storeValNew}
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromLane(entrySize)}
          (if (i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (i64.const ${TOMB_NAN}))
            (then (if (i32.eqz (local.get $zb))
              (then ${rememberZombie()})))
            (else (if ${eqExpr}
              ${storeValMatch})))))
      ${probeNext(entrySize)}
      (local.set $ztr (i32.add (local.get $ztr) (i32.const 1)))
      (if (i32.ge_s (local.get $ztr) (local.get $cap))
        (then
          ${zombieRescan(entrySize)}
          (local.set $slot (local.get $zb))
          ${restoreZombieProbe()}
          ${seqStore}
          ${probeHashStore()}
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${durableEntryLogIR('slot', 'off')}${storeValNew}
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (br $probe)))
    (local.get $obj))`
}

export {
  genUpsert, genLookup, genDelete, genUpsertGrow, genSlotUpsert,
  genEphemeralSlotUpsert, genEphemeralFixedSlot, genLookupStrict,
  genLookupStrictPrehashed, genUpsertStrictPrehashed,
}
