/**
 * Collection module — Set, Map, HASH (dynamic string-keyed objects).
 *
 * Set: type=8, open addressing hash table. Entries: [hash:f64, key:f64] (16B each).
 * Map: type=9, same but entries: [hash:f64, key:f64, val:f64] (24B each).
 * HASH: type=7, same layout as Map but uses content-based string hash + equality.
 *
 * @module collection
 */

import { typed, asF64, asI64, asI32, NULL_NAN, UNDEF_NAN, temp, tempI32, tempI64, allocPtr, undefExpr, mkPtrIR, ptrTypeEq, elemStore, elemLoad } from '../src/ir.js'
import { emit, flat, deps, call } from '../src/bridge.js'
import { valTypeOf } from '../src/kind.js'
import { VAL, lookupValType } from '../src/reps.js'
import { hasOwnContinue } from '../src/ast.js'
import { ctx, inc, PTR, LAYOUT, getter } from '../src/ctx.js'

const SET_ENTRY = 16  // hash + key
const MAP_ENTRY = 24  // hash + key + value
const INIT_CAP = 8    // initial capacity (must be power of 2)

export function strHashLiteral(str) {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ (str.charCodeAt(i) & 0xFF), 0x01000193) | 0
  return h <= 1 ? (h + 2) | 0 : h
}

const HASH_BUF = new ArrayBuffer(8)
const HASH_F64 = new Float64Array(HASH_BUF)
const HASH_U32 = new Uint32Array(HASH_BUF)

export function numHashLiteral(n) {
  if (Object.is(n, 0) || Object.is(n, -0)) return 2
  HASH_F64[0] = n
  const h = (HASH_U32[0] ^ HASH_U32[1]) | 0
  return h <= 1 ? (h + 2) | 0 : h
}

function numConstLiteral(expr) {
  if (typeof expr === 'number' && Number.isFinite(expr)) return expr
  if (Array.isArray(expr) && expr[0] == null && typeof expr[1] === 'number' && Number.isFinite(expr[1])) return expr[1]
  return null
}

// Equality expressions for probe templates
const sameValueZeroEq = '(call $__same_value_zero (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))'
const strEq = '(call $__str_eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))'

// Open-addressing probe walked additively by entrySize: avoids an i32.mul + mask per
// step (vs recomputing slot = off + idx*entrySize). Needs $off/$cap/$h set and $end/$slot
// locals declared. `idxExpr` is the first-slot index (defaults to h mod cap; cap is pow2).
const probeStart = (entrySize, idxExpr = '(i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1)))') =>
  `(local.set $end (i32.add (local.get $off) (i32.mul (local.get $cap) (i32.const ${entrySize}))))
    (local.set $slot (i32.add (local.get $off) (i32.mul ${idxExpr} (i32.const ${entrySize}))))`
const probeNext = (entrySize) =>
  `(local.set $slot (i32.add (local.get $slot) (i32.const ${entrySize})))
      (if (i32.ge_u (local.get $slot) (local.get $end)) (then (local.set $slot (local.get $off))))`

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
 *  The table grows at 75% load by allocating a 2× table, rehashing, and forward-marking
 *  the old header (cap=-1 sentinel, new offset at -8) — the array growth idiom. The boxed
 *  pointer the caller holds is returned UNCHANGED; future ops resolve it through
 *  __ptr_offset, which follows the chain. This is why Set/Map (held in caller locals, and
 *  possibly aliased) forward rather than remint like HASH (whose pointer lives in a single
 *  owner's propsPtr slot that genUpsertGrow can rewrite). */
function genUpsert(name, entrySize, hashFn, eqExpr, expectedType, hasVal, hasExt) {
  const valParam = hasVal ? '(param $val i64) ' : ''
  const storeVal = hasVal ? `\n          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))` : ''
  const onMatch = hasVal
    ? `(then\n          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))\n          (br $done))`
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
    (local $oldslot i32) (local $newidx i32) (local $newslot i32)
    ${typeGuard}
    (local.set $off (call $__ptr_offset (local.get $coll)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $size (i32.load (i32.sub (local.get $off) (i32.const 8))))
    ;; Grow at 75% load (size*4 >= cap*3): 2× table, rehash, forward-mark old header.
    (if (i32.ge_s (i32.mul (local.get $size) (i32.const 4)) (i32.mul (local.get $cap) (i32.const 3)))
      (then
        (local.set $newcap (i32.shl (local.get $cap) (i32.const 1)))
        (local.set $newptr (call $__alloc_hdr_n (i32.const 0) (local.get $newcap) (i32.const ${entrySize})))
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
              (i32.store (i32.sub (local.get $newptr) (i32.const 8))
                (i32.add (i32.load (i32.sub (local.get $newptr) (i32.const 8))) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $rl)))
        (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newptr))
        (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
        (local.set $off (local.get $newptr))
        (local.set $cap (local.get $newcap))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot)))
        (then
          ${seqStore}
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${storeVal}
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if ${eqExpr} ${onMatch})
      ${probeNext(entrySize)}
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
    ${typeGuard}
    (local.set $off ${offExpr})
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot))) (then ${onEmpty}))
      (if ${eqExpr} (then ${onFound}))
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
  return `(func $${name} (param $coll i64) (param $key i64) (result i32)
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32) (local $tries i32)
    (local $i i32) (local $j i32) (local $k i32) (local $n i32)
    (if (i32.ne (call $__ptr_type (local.get $coll)) (i32.const ${expectedType})) (then (return (i32.const 0))))
    (local.set $off (call $__ptr_offset (local.get $coll)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $found
      (block $absent (loop $probe
        (if (i64.eqz (i64.load (local.get $slot))) (then (br $absent)))
        (if ${eqExpr} (then (br $found)))
        ${probeNext(entrySize)}
        (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
        (br_if $absent (i32.ge_s (local.get $tries) (local.get $cap)))
        (br $probe)))
      (return (i32.const 0)))
    ;; $slot holds the entry to remove. Walk forward; move back any entry whose home
    ;; is not cyclically within (i, j], else it would become unreachable from its home.
    (local.set $i (local.get $slot))
    (local.set $j (local.get $slot))
    (block $stop (loop $shift
      (local.set $j (i32.add (local.get $j) (i32.const ${entrySize})))
      (if (i32.ge_u (local.get $j) (local.get $end)) (then (local.set $j (local.get $off))))
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
      (memory.copy (local.get $i) (local.get $j) (i32.const ${entrySize}))
      (local.set $i (local.get $j))
      (br $shift)))
    (i64.store (local.get $i) (i64.const 0))
    (i64.store (i32.add (local.get $i) (i32.const 8)) (i64.const 0))
    (i32.store (i32.sub (local.get $off) (i32.const 8))
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
    (local $oldslot i32) (local $newidx i32) (local $newslot i32)
    ${typeGuard}
    (local.set $off (call $__ptr_offset (local.get $obj)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $size (i32.load (i32.sub (local.get $off) (i32.const 8))))
    ;; Grow if load factor > 75%: size * 4 >= cap * 3
    (if (i32.ge_s (i32.mul (local.get $size) (i32.const 4)) (i32.mul (local.get $cap) (i32.const 3)))
      (then
        (local.set $newcap (i32.shl (local.get $cap) (i32.const 1)))
        (local.set $newptr (call $__alloc_hdr_n (i32.const 0) (local.get $newcap) (i32.const ${entrySize})))
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
              (i32.store (i32.sub (local.get $newptr) (i32.const 8))
                (i32.add (i32.load (i32.sub (local.get $newptr) (i32.const 8))) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $rl)))
        ${forward
          // Forward-mark the old header (cap=-1 sentinel at -4, new offset at -8) and
          // keep the boxed pointer the caller holds: any alias resolves through
          // __ptr_offset. This preserves JS reference identity for a grown dict held in
          // multiple places (e.g. ctx.core.emit), which remint cannot.
          ? `(i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newptr))
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
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot)))
        (then
          ${seqStore}
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if ${eqExpr}
        (then
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (br $done)))
      ${probeNext(entrySize)}
      (br $probe)))
    (local.get $obj))`
}

function genLookupStrict(name, entrySize, hashFn, eqExpr, expectedType, missing = UNDEF_NAN) {
  return `(func $${name} (param $coll i64) (param $key i64) (result i64)
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32) (local $tries i32)
    (if (i32.ne
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $coll) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${expectedType}))
      (then (return (i64.const ${missing}))))
    (local.set $off (call $__ptr_offset (local.get $coll)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot)))
        (then (return (i64.const ${missing}))))
      (if ${eqExpr}
        (then (return (i64.load (i32.add (local.get $slot) (i32.const 16))))))
      ${probeNext(entrySize)}
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (i64.const ${missing}))`
}

function genLookupStrictPrehashed(name, entrySize, eqExpr, expectedType, missing = UNDEF_NAN, hasExt = false) {
  const tExpr = `(i32.wrap_i64 (i64.and (i64.shr_u (local.get $coll) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`
  const typeGuard = hasExt
    ? `(if (i32.ne ${tExpr} (i32.const ${expectedType}))
      (then
        (if (i32.eq ${tExpr} (i32.const ${PTR.EXTERNAL}))
          (then (return (call $__ext_prop (local.get $coll) (local.get $key))))
          (else (return (i64.const ${missing}))))))`
    : `(if (i32.ne ${tExpr} (i32.const ${expectedType}))
      (then (return (i64.const ${missing}))))`
  // SET/MAP/HASH grow by forward-marking; a boxed pointer may be stale → follow the chain.
  const offExpr = '(call $__ptr_offset (local.get $coll))'
  return `(func $${name} (param $coll i64) (param $key i64) (param $h i32) (result i64)
    (local $off i32) (local $cap i32) (local $end i32) (local $slot i32) (local $tries i32)
    ${typeGuard}
    (local.set $off ${offExpr})
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot)))
        (then (return (i64.const ${missing}))))
      (if ${eqExpr}
        (then (return (i64.load (i32.add (local.get $slot) (i32.const 16))))))
      ${probeNext(entrySize)}
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (i64.const ${missing}))`
}

function genUpsertStrictPrehashed(name, entrySize, eqExpr, expectedType) {
  return `(func $${name} (param $obj i64) (param $key i64) (param $h i32) (param $val i64) (result i64)
    (local $off i32) (local $cap i32) (local $end i32) (local $slot i32)
    (if (i32.ne
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${expectedType}))
      (then (return (local.get $obj))))
    (local.set $off (call $__ptr_offset (local.get $obj)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot)))
        (then
          ${seqStore}
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if ${eqExpr}
        (then
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (br $done)))
      ${probeNext(entrySize)}
      (br $probe)))
    (local.get $obj))`
}


export default (ctx) => {
  // Feature-gated deps: EXTERNAL-dependent symbols are only pulled when features.external.
  // Evaluated lazily at resolveIncludes() time — after emission has finalized ctx.features.
  const ifExt = (name) => () => ctx.features.external ? [name] : []
  deps({
    __same_value_zero: ['__str_eq'],
    __map_hash: ['__hash', '__str_hash'],
    __set_add: () => ctx.features.external ? ['__map_hash', '__same_value_zero', '__ptr_offset', '__alloc_hdr_n', '__ext_set'] : ['__map_hash', '__same_value_zero', '__ptr_offset', '__alloc_hdr_n'],
    __set_has: () => ctx.features.external ? ['__map_hash', '__same_value_zero', '__ptr_offset', '__ext_has'] : ['__map_hash', '__same_value_zero', '__ptr_offset'],
    __set_delete: ['__map_hash', '__same_value_zero'],
    __map_set: () => ctx.features.external ? ['__map_hash', '__same_value_zero', '__ptr_offset', '__alloc_hdr_n', '__ext_set'] : ['__map_hash', '__same_value_zero', '__ptr_offset', '__alloc_hdr_n'],
    __map_get: () => ctx.features.external ? ['__ext_prop', '__map_set', '__ptr_offset'] : ['__map_set', '__ptr_offset'],
    __map_get_h: () => ctx.features.external ? ['__ext_prop', '__same_value_zero', '__ptr_offset'] : ['__same_value_zero', '__ptr_offset'],
    __map_has: () => ctx.features.external ? ['__map_hash', '__same_value_zero', '__ptr_offset', '__ext_has'] : ['__map_hash', '__same_value_zero', '__ptr_offset'],
    __map_delete: ['__map_hash', '__same_value_zero'],
    __map_from: ['__ptr_type', '__ptr_offset', '__len', '__typed_idx', '__map_set', '__mkptr', '__alloc_hdr_n', '__coll_order'],
    __hash_set: () => ctx.features.external
      ? ['__str_hash', '__str_eq', '__ptr_type', '__ext_set', '__dyn_set']
      : ['__str_hash', '__str_eq', '__ptr_type', '__dyn_set'],
    __hash_get: () => ctx.features.external
      ? ['__str_hash', '__str_eq', '__ptr_type', '__ext_prop']
      : ['__str_hash', '__str_eq', '__ptr_type'],
    __hash_has: () => ctx.features.external
      ? ['__str_hash', '__str_eq', '__ptr_type', '__ext_has']
      : ['__str_hash', '__str_eq', '__ptr_type'],
    __hash_new: ['__alloc_hdr_n'],
    __hash_new_small: ['__alloc_hdr_n', '__mkptr'],
    __hash_get_local: ['__str_hash', '__str_eq'],
    __hash_get_local_h: ['__str_eq'],
    __hash_set_local_h: ['__str_eq'],
    __hash_set_local: ['__str_hash', '__str_eq', '__alloc_hdr_n', '__mkptr'],
    __ihash_get_local: ['__map_hash'],
    __ihash_set_local: ['__map_hash', '__alloc_hdr_n', '__mkptr'],
    __dyn_get_t: ['__dyn_get_t_h', '__str_hash'],
    __dyn_get_t_h: ['__ihash_get_local', '__str_eq', '__is_nullish'],
    __dyn_get: ['__dyn_get_t', '__ptr_type'],
    __dyn_get_expr_t: ['__dyn_get_t', '__hash_get_local'],
    __dyn_get_expr_t_h: ['__dyn_get_t_h', '__hash_get_local_h'],
    __dyn_get_expr: ['__dyn_get_expr_t', '__ptr_type'],
    __dyn_get_any: ['__dyn_get_any_t', '__ptr_type'],
    __dyn_get_any_t: () => ctx.features.external
      ? ['__dyn_get_t', '__hash_get_local', '__ext_prop']
      : ['__dyn_get_t', '__hash_get_local'],
    __dyn_get_any_t_h: () => ctx.features.external
      ? ['__dyn_get_t_h', '__hash_get_local_h', '__ext_prop']
      : ['__dyn_get_t_h', '__hash_get_local_h'],
    __dyn_get_or: ['__dyn_get'],
    __dyn_set: ['__hash_new', '__hash_new_small', '__ihash_get_local', '__ihash_set_local', '__hash_set_local', '__ptr_offset', '__is_nullish', '__str_eq'],
    __dyn_move: ['__ihash_get_local', '__ihash_set_local', '__is_nullish'],
    __hash_del_local: ['__str_hash', '__str_eq', '__ptr_type'],
    __dyn_del: ['__hash_del_local', '__ihash_get_local', '__is_nullish'],
    __coll_clear: ['__ptr_type', '__ptr_offset'],
  })

  inc('__ptr_offset', '__cap')

  // Monotonic insertion counter packed into each entry's hash-word high 32 bits
  // (see seqStore). Restores JS insertion order at iteration without growing
  // entries or touching the lookup/delete hot paths. i32: wraps after 2^32 total
  // inserts — unreachable in practice; fresh per wasm instance.
  if (!ctx.scope.globals.has('__seq'))
    ctx.scope.globals.set('__seq', '(global $__seq (mut i32) (i32.const 0))')

  if (!ctx.scope.globals.has('__dyn_props'))
    ctx.scope.globals.set('__dyn_props', '(global $__dyn_props (mut f64) (f64.const 0))')
  // 1-slot inline cache for the global __dyn_props lookup. Hot path for
  // metacircular workloads (watr WAT parser): ~96% of execution sits in
  // __dyn_get_t / __ihash_get_local. Caches last-seen (off → propsPtr) at
  // the top of __dyn_get_t; invalidated by __dyn_set when the same off's
  // propsPtr is replaced (rehash on grow). Sentinel cache_off = -1 cannot
  // collide with a real memory offset (always non-negative i32).
  if (!ctx.scope.globals.has('__dyn_get_cache_off'))
    ctx.scope.globals.set('__dyn_get_cache_off', '(global $__dyn_get_cache_off (mut i32) (i32.const -1))')
  if (!ctx.scope.globals.has('__dyn_get_cache_props'))
    ctx.scope.globals.set('__dyn_get_cache_props', '(global $__dyn_get_cache_props (mut f64) (f64.const 0))')
  // Schema name table for __dyn_get's OBJECT-schema fallback (polymorphic-receiver
  // `.prop` access). Same declaration as json.js — defined here too so collection
  // doesn't transitively require json. compile.js's schemaInit populates it when
  // schema list is non-empty AND (__stringify OR __dyn_get) is included.
  if (!ctx.scope.globals.has('__schema_tbl'))
    ctx.scope.globals.set('__schema_tbl', '(global $__schema_tbl (mut i32) (i32.const 0))')

  // __ext_* imports carry NaN-boxed pointers across the env boundary as i64
  // (not f64) to dodge V8's f64 NaN canonicalization at the wasm↔JS edge —
  // same hazard as env.print / env.setTimeout (see module/console.js header).
  // i32 returns (has/set) and arg shapes stay; only boxed-pointer carriers move.
  ctx.core.stdlib['__ext_prop'] = '(import "env" "__ext_prop" (func $__ext_prop (param i64 i64) (result i64)))'
  ctx.core.stdlib['__ext_has'] = '(import "env" "__ext_has" (func $__ext_has (param i64 i64) (result i32)))'
  ctx.core.stdlib['__ext_set'] = '(import "env" "__ext_set" (func $__ext_set (param i64 i64 i64) (result i32)))'
  ctx.core.stdlib['__ext_call'] = '(import "env" "__ext_call" (func $__ext_call (param i64 i64 i64) (result i64)))'
  // Hash function: simple f64 → i32 hash
  ctx.core.stdlib['__hash'] = `(func $__hash (param $v i64) (result i32)
    (i32.wrap_i64 (i64.xor
      (local.get $v)
      (i64.shr_u (local.get $v) (i64.const 32)))))`
  inc('__hash')

  ctx.core.stdlib['__same_value_zero'] = `(func $__same_value_zero (param $a i64) (param $b i64) (result i32)
    (local $fa f64) (local $fb f64) (local $ta i32) (local $tb i32)
    (if (result i32) (i64.eq (local.get $a) (local.get $b))
      (then (i32.const 1))
      (else
        (local.set $fa (f64.reinterpret_i64 (local.get $a)))
        (local.set $fb (f64.reinterpret_i64 (local.get $b)))
        (if (result i32)
          (i32.and
            (f64.eq (local.get $fa) (local.get $fa))
            (f64.eq (local.get $fb) (local.get $fb)))
          (then (f64.eq (local.get $fa) (local.get $fb)))
          (else
            (local.set $ta (i32.wrap_i64 (i64.and (i64.shr_u (local.get $a) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
            (local.set $tb (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
            (if (result i32)
              (i32.and
                (i32.eq (local.get $ta) (i32.const ${PTR.STRING}))
                (i32.eq (local.get $tb) (i32.const ${PTR.STRING})))
              (then (call $__str_eq (local.get $a) (local.get $b)))
              (else (i32.const 0))))))))`

  ctx.core.stdlib['__map_hash'] = `(func $__map_hash (param $v i64) (result i32)
    (local $f f64) (local $t i32) (local $h i32)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $v) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    ;; NaN-boxed strings carry the tag inside a NaN payload. Regular numbers
    ;; (e.g. f64.convert_i32_s offsets used as __ihash keys) can alias mantissa
    ;; bits onto the type slot — gate the str-hash dispatch on actual NaN.
    (if (i32.and (f64.ne (local.get $f) (local.get $f))
          (i32.eq (local.get $t) (i32.const ${PTR.STRING})))
      (then (return (call $__str_hash (local.get $v)))))
    (if (f64.eq (local.get $f) (f64.const 0)) (then (return (i32.const 2))))
    (if (i32.and (i32.eq (local.get $t) (i32.const 0)) (f64.ne (local.get $f) (local.get $f)))
      (then (return (i32.const 3))))
    (local.set $h (call $__hash (local.get $v)))
    (if (result i32) (i32.le_s (local.get $h) (i32.const 1))
      (then (i32.add (local.get $h) (i32.const 2)))
      (else (local.get $h))))`

  // __map_new() → f64 — allocate empty Map (for JSON.parse, runtime creation)
  ctx.core.stdlib['__map_new'] = `(func $__map_new (result f64)
    (call $__mkptr (i32.const ${PTR.MAP}) (i32.const 0)
      (call $__alloc_hdr_n (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY}))))`

  // === Set ===

  ctx.core.emit['new.Set'] = (iterExpr) => {
    ctx.features.set = true
    if (iterExpr == null) {
      const out = allocPtr({ type: PTR.SET, len: 0, cap: INIT_CAP, stride: SET_ENTRY, tag: 'set' })
      return typed(['block', ['result', 'f64'], out.init, out.ptr], 'f64')
    }
    // new Set(iterable): __iter_arr normalizes any iterable to an index-iterable
    // dense array (Set→keys, Map→[k,v] entries, Array/String/TypedArray pass
    // through), so a Set/Map/Array source all seed uniformly. __set_add does
    // SameValueZero dedup + −0 normalization. A non-iterable normalizes to a
    // non-array value — the ptr_type guard zeroes the length so the loop is skipped.
    //
    // __set_add grows on demand, but pre-sizing the table to fit the source array
    // skips the rehash churn of building it up from INIT_CAP. cap = 1 << (32 −
    // clz(m−1)) with m = 2*len + INIT_CAP is the smallest power of two > 2*len:
    // distinct entries ≤ len, so the table lands ≤50% full and never needs to grow
    // while seeding. Floors at INIT_CAP for the empty/short case.
    inc('__set_add', '__ptr_type', '__len', '__typed_idx')
    const setL = temp('nss'), arrL = temp('nsa')
    const iL = tempI32('nsi'), lenL = tempI32('nsl')
    const capExpr = ['i32.shl', ['i32.const', 1],
      ['i32.sub', ['i32.const', 32], ['i32.clz',
        ['i32.sub',
          ['i32.add', ['i32.shl', ['local.get', `$${lenL}`], ['i32.const', 1]], ['i32.const', INIT_CAP]],
          ['i32.const', 1]]]]]
    const out = allocPtr({ type: PTR.SET, len: 0, cap: capExpr, stride: SET_ENTRY, tag: 'set' })
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${arrL}`, asF64(emit(['()', '__iter_arr', iterExpr]))],
      ['local.set', `$${lenL}`, ['i32.const', 0]],
      ['if', ['i32.eq',
          ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${arrL}`]]],
          ['i32.const', PTR.ARRAY]],
        ['then', ['local.set', `$${lenL}`,
          ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${arrL}`]]]]]],
      out.init,
      ['local.set', `$${setL}`, out.ptr],
      ['local.set', `$${iL}`, ['i32.const', 0]],
      ['block', `$d_${iL}`, ['loop', `$l_${iL}`,
        ['br_if', `$d_${iL}`, ['i32.ge_s', ['local.get', `$${iL}`], ['local.get', `$${lenL}`]]],
        ['local.set', `$${setL}`, ['f64.reinterpret_i64',
          ['call', '$__set_add',
            ['i64.reinterpret_f64', ['local.get', `$${setL}`]],
            ['i64.reinterpret_f64', ['call', '$__typed_idx',
              ['i64.reinterpret_f64', ['local.get', `$${arrL}`]],
              ['local.get', `$${iL}`]]]]]],
        ['local.set', `$${iL}`, ['i32.add', ['local.get', `$${iL}`], ['i32.const', 1]]],
        ['br', `$l_${iL}`]]],
      ['local.get', `$${setL}`]], 'f64')
  }

  ctx.core.emit['.add'] = call('__set_add', 'II', 'i64')

  // `.has` / `.delete` exist on BOTH Set and Map, which differ only in entry
  // stride (16 vs 24). A receiver of unproven kind (e.g. a Map read off a nested
  // object field like `ctx.scope.globals`) must resolve MAP vs SET at runtime:
  // the Set probe carries a PTR.SET type guard that rejects a Map outright, so
  // routing a Map through `__set_has`/`__set_delete` makes every lookup/delete
  // silently report absent. Mirrors collViewDyn below; typed receivers skip it.
  const collProbeDyn = (mapFn, setFn) => (collExpr, key) => {
    inc(mapFn, setFn, '__ptr_type')
    const o = temp('cp'), k = tempI64('cpk')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${o}`, asF64(emit(collExpr))],
      ['local.set', `$${k}`, asI64(emit(key))],
      ['f64.convert_i32_s', ['if', ['result', 'i32'],
        ptrTypeEq(['local.get', `$${o}`], PTR.MAP),
        ['then', ['call', `$${mapFn}`, ['i64.reinterpret_f64', ['local.get', `$${o}`]], ['local.get', `$${k}`]]],
        ['else', ['call', `$${setFn}`, ['i64.reinterpret_f64', ['local.get', `$${o}`]], ['local.get', `$${k}`]]]]]], 'f64')
  }
  ctx.core.emit['.has'] = collProbeDyn('__map_has', '__set_has')
  ctx.core.emit['.delete'] = collProbeDyn('__map_delete', '__set_delete')
  ctx.core.emit[`.${VAL.SET}:has`] = call('__set_has', 'II', 'i32')
  ctx.core.emit[`.${VAL.SET}:delete`] = call('__set_delete', 'II', 'i32')

  // Map.prototype.clear / Set.prototype.clear — drop every entry. `.clear` only
  // exists on Map/Set in JS, so a single generic emitter is unambiguous; the
  // stdlib reads the ptr tag to pick the entry stride.
  ctx.core.emit['.clear'] = call('__coll_clear', 'I')

  // Zero every slot (so probes see empty) and reset the length header. Entry
  // stride is 16 for a SET, 24 for a MAP — `(t == MAP) << 3` adds the 8-byte
  // value column. Returns undefined; a non-collation arg is a guarded no-op.
  ctx.core.stdlib['__coll_clear'] = `(func $__coll_clear (param $coll i64) (result f64)
    (local $off i32) (local $cap i32) (local $t i32)
    (local.set $t (call $__ptr_type (local.get $coll)))
    (if (i32.or (i32.eq (local.get $t) (i32.const ${PTR.SET})) (i32.eq (local.get $t) (i32.const ${PTR.MAP})))
      (then
        (local.set $off (call $__ptr_offset (local.get $coll)))
        (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
        (memory.fill (local.get $off) (i32.const 0)
          (i32.mul (local.get $cap)
            (i32.add (i32.const ${SET_ENTRY})
              (i32.shl (i32.eq (local.get $t) (i32.const ${PTR.MAP})) (i32.const 3)))))
        (i32.store (i32.sub (local.get $off) (i32.const 8)) (i32.const 0))))
    (f64.reinterpret_i64 (i64.const ${UNDEF_NAN})))`

  ctx.core.emit['.size'] = getter((expr) => {
    return typed(['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', asF64(emit(expr))]]], 'f64')
  })

  // x instanceof Map / Set — typed-pointer predicates emitted by jzify. NaN-check
  // first (non-pointer numbers must report false), then compare __ptr_type tag.
  // Mirrors module/array.js's Array.isArray inline form. Result is i32 (boolean).
  ctx.core.emit['__is_map'] = (x) => {
    const v = asF64(emit(x))
    const t = temp('imap')
    return typed(['i32.and',
      ['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
      ptrTypeEq(['local.get', `$${t}`], PTR.MAP)], 'i32')
  }
  ctx.core.emit['__is_set'] = (x) => {
    const v = asF64(emit(x))
    const t = temp('iset')
    return typed(['i32.and',
      ['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
      ptrTypeEq(['local.get', `$${t}`], PTR.SET)], 'i32')
  }

  // Generated Set probe functions
  ctx.core.stdlib['__set_add'] = () => genUpsert('__set_add', SET_ENTRY, '$__map_hash', sameValueZeroEq, PTR.SET, false, ctx.features.external)
  ctx.core.stdlib['__set_has'] = () => genLookup('__set_has', SET_ENTRY, '$__map_hash', sameValueZeroEq, PTR.SET, false, ctx.features.external)
  ctx.core.stdlib['__set_delete'] = genDelete('__set_delete', SET_ENTRY, '$__map_hash', sameValueZeroEq, PTR.SET)

  // === Map ===

  ctx.core.emit['new.Map'] = (iterExpr) => {
    ctx.features.map = true
    if (iterExpr == null) {
      const out = allocPtr({ type: PTR.MAP, len: 0, cap: INIT_CAP, stride: MAP_ENTRY, tag: 'map' })
      return typed(['block', ['result', 'f64'], out.init, out.ptr], 'f64')
    }
    // new Map(iterable): seed from another Map or an array of [key, value] pairs.
    // Delegated to a stdlib helper (vs inlined like Set) — `new Map(x)` is heavily
    // used (the compiler copies fact Maps per function), so one shared helper keeps
    // output small. Non-Map/Array args yield an empty map (guarded in the helper).
    inc('__map_from')
    return typed(['call', '$__map_from', asI64(emit(iterExpr))], 'f64')
  }

  ctx.core.emit['.set'] = (mapExpr, key, val) => {
    inc('__map_set')
    const value = val === undefined ? asI64(undefExpr()) : asI64(emit(val))
    return typed(['f64.reinterpret_i64', ['call', '$__map_set', asI64(emit(mapExpr)), asI64(emit(key)), value]], 'f64')
  }
  ctx.core.emit[`.${VAL.MAP}:set`] = ctx.core.emit['.set']

  const emitMapGet = (mapExpr, key) => {
    const constKey = numConstLiteral(key)
    if (constKey != null) {
      inc('__map_get_h')
      return typed(['f64.reinterpret_i64', ['call', '$__map_get_h', asI64(emit(mapExpr)), asI64(emit(key)), ['i32.const', numHashLiteral(constKey)]]], 'f64')
    }
    inc('__map_get')
    return typed(['f64.reinterpret_i64', ['call', '$__map_get', asI64(emit(mapExpr)), asI64(emit(key))]], 'f64')
  }

  ctx.core.emit['.get'] = emitMapGet
  ctx.core.emit[`.${VAL.MAP}:get`] = emitMapGet

  ctx.core.emit[`.${VAL.MAP}:has`] = call('__map_has', 'II', 'i32')
  ctx.core.emit[`.${VAL.MAP}:delete`] = call('__map_delete', 'II', 'i32')

  // Map/Set iteration views: keys() / values() / entries() materialize a dense
  // Array snapshot (jz models iterators as arrays — for-of/spread consume them
  // directly). Set keys===values===elements; Set entries yield [v, v] pairs.
  // Registered per concrete type; an unproven receiver resolves SET vs MAP at
  // runtime via `.keys`/`.values`/`.entries` below.
  const collView = (walk) => (expr) => {
    const t = temp('cv')
    return typed(['block', ['result', 'f64'], ['local.set', `$${t}`, asF64(emit(expr))], walk(t)], 'f64')
  }
  ctx.core.emit[`.${VAL.MAP}:keys`] = collView(t => collKeysFromTemp(t, MAP_ENTRY, 8))
  ctx.core.emit[`.${VAL.MAP}:values`] = collView(t => collKeysFromTemp(t, MAP_ENTRY, 16))
  ctx.core.emit[`.${VAL.MAP}:entries`] = collView(t => collEntriesFromTemp(t, MAP_ENTRY, 8, 16))
  ctx.core.emit[`.${VAL.SET}:keys`] = collView(t => collKeysFromTemp(t, SET_ENTRY, 8))
  ctx.core.emit[`.${VAL.SET}:values`] = ctx.core.emit[`.${VAL.SET}:keys`]
  ctx.core.emit[`.${VAL.SET}:entries`] = collView(t => collEntriesFromTemp(t, SET_ENTRY, 8, 8))

  // Generic keys()/values()/entries() for a receiver whose collection kind isn't
  // statically proven (e.g. a Map read off an object field): resolve MAP vs SET
  // vs ARRAY once at runtime. ARRAY.values() is the array itself; .keys() yields
  // indices; .entries() yields [i, el]. Any other receiver passes through.
  const collViewDyn = (mapWalk, setWalk, arrWalk) => (expr) => {
    inc('__ptr_type')
    const t = temp('cd')
    const pt = () => ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]
    const branch = (tag, walk, rest) =>
      ['if', ['result', 'f64'], ['i32.eq', pt(), ['i32.const', tag]], ['then', walk(t)], ['else', rest]]
    const tree = branch(PTR.MAP, mapWalk, branch(PTR.SET, setWalk,
      branch(PTR.ARRAY, arrWalk, ['local.get', `$${t}`])))
    return typed(['block', ['result', 'f64'], ['local.set', `$${t}`, asF64(emit(expr))], tree], 'f64')
  }
  ctx.core.emit['.keys'] = collViewDyn(
    t => collKeysFromTemp(t, MAP_ENTRY, 8), t => collKeysFromTemp(t, SET_ENTRY, 8), arrIdxFromTemp)
  ctx.core.emit['.values'] = collViewDyn(
    t => collKeysFromTemp(t, MAP_ENTRY, 16), t => collKeysFromTemp(t, SET_ENTRY, 8), t => ['local.get', `$${t}`])
  ctx.core.emit['.entries'] = collViewDyn(
    t => collEntriesFromTemp(t, MAP_ENTRY, 8, 16), t => collEntriesFromTemp(t, SET_ENTRY, 8, 8), arrEntriesFromTemp)

  // Map/Set forEach(cb): invoke cb(value, key) per live entry in insertion order.
  // Map yields (value=val@16, key=key@8); Set yields (value=key@8, key@8) — the
  // spec passes the element as both value and key. The trailing collection arg is
  // dropped (as array/typedarray forEach drop the array arg) so we never exceed
  // the uniform closure width (forEach autoloads array → closure floor 2). Uses
  // the closure-call path like typedarray:forEach — forEach isn't a hot path.
  const collForEach = (stride, valOff, keyOff) => (expr, fn) => {
    inc('__ptr_offset', '__cap', '__len', '__coll_order')
    const t = temp('fe'), cb = temp('fecb')
    const off = tempI32('feo'), cap = tempI32('fec'), n = tempI32('fen')
    const i = tempI32('fei'), ord = tempI32('fer'), slot = tempI32('fes')
    const id = ctx.func.uniq++
    const at = (o) => typed(['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', o]]], 'f64')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(expr))],
      ['local.set', `$${cb}`, asF64(emit(fn))],
      ['local.set', `$${n}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
      ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
      ['local.set', `$${cap}`, ['call', '$__cap', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
      ['local.set', `$${ord}`, ['call', '$__coll_order', ['local.get', `$${off}`], ['local.get', `$${cap}`], ['i32.const', stride]]],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$febrk${id}`, ['loop', `$feloop${id}`,
        ['br_if', `$febrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${n}`]]],
        ['local.set', `$${slot}`, ['i32.load', ['i32.add', ['local.get', `$${ord}`],
          ['i32.shl', ['local.get', `$${i}`], ['i32.const', 2]]]]],
        ['drop', asF64(ctx.closure.call(typed(['local.get', `$${cb}`], 'f64'),
          [at(valOff), at(keyOff)]))],
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$feloop${id}`]]],
      ['f64.const', 0]], 'f64')
  }
  ctx.core.emit[`.${VAL.MAP}:forEach`] = collForEach(MAP_ENTRY, 16, 8)
  ctx.core.emit[`.${VAL.SET}:forEach`] = collForEach(SET_ENTRY, 8, 8)

  // Generated Map probe functions
  ctx.core.stdlib['__map_set'] = () => genUpsert('__map_set', MAP_ENTRY, '$__map_hash', sameValueZeroEq, PTR.MAP, true, ctx.features.external)
  ctx.core.stdlib['__map_get'] = () => genLookup('__map_get', MAP_ENTRY, '$__map_hash', sameValueZeroEq, PTR.MAP, true, ctx.features.external)
  ctx.core.stdlib['__map_get_h'] = () => genLookupStrictPrehashed('__map_get_h', MAP_ENTRY, sameValueZeroEq, PTR.MAP, UNDEF_NAN, ctx.features.external)
  ctx.core.stdlib['__map_has'] = () => genLookup('__map_has', MAP_ENTRY, '$__map_hash', sameValueZeroEq, PTR.MAP, false, ctx.features.external)
  ctx.core.stdlib['__map_delete'] = genDelete('__map_delete', MAP_ENTRY, '$__map_hash', sameValueZeroEq, PTR.MAP)

  // new Map(iterable) seeder. Source is another Map (copy live [key,val] slots) or
  // an array of [key,value] pairs (`new Map([["a",1],…])`); any other arg yields an
  // empty map. Pre-sizes cap to fit (smallest pow2 > 2·n, floor INIT_CAP) so seeding
  // never triggers a rehash. Occupied MAP slot ⇔ hash word ≠ 0 (genDelete shift-back
  // writes 0, leaving no tombstones — matches the rehash loop's own occupancy test).
  ctx.core.stdlib['__map_from'] = `(func $__map_from (param $src i64) (result f64)
    (local $map i64) (local $t i32) (local $off i32) (local $cap i32)
    (local $i i32) (local $n i32) (local $slot i32) (local $entry i64) (local $newcap i32) (local $ord i32)
    (local.set $t (call $__ptr_type (local.get $src)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.MAP}))
      (then
        (local.set $off (call $__ptr_offset (local.get $src)))
        (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
        (local.set $n (i32.load (i32.sub (local.get $off) (i32.const 8)))))
      (else (if (i32.eq (local.get $t) (i32.const ${PTR.ARRAY}))
        (then (local.set $n (call $__len (local.get $src)))))))
    (local.set $newcap (i32.shl (i32.const 1)
      (i32.sub (i32.const 32) (i32.clz
        (i32.sub (i32.add (i32.shl (local.get $n) (i32.const 1)) (i32.const ${INIT_CAP})) (i32.const 1))))))
    (local.set $map (i64.reinterpret_f64 (call $__mkptr (i32.const ${PTR.MAP}) (i32.const 0)
      (call $__alloc_hdr_n (i32.const 0) (local.get $newcap) (i32.const ${MAP_ENTRY})))))
    (if (i32.eq (local.get $t) (i32.const ${PTR.MAP}))
      (then
        ;; Copy in source insertion order so the new map enumerates identically.
        (local.set $ord (call $__coll_order (local.get $off) (local.get $cap) (i32.const ${MAP_ENTRY})))
        (block $dm (loop $lm
          (br_if $dm (i32.ge_s (local.get $i) (local.get $n)))
          (local.set $slot (i32.load (i32.add (local.get $ord) (i32.shl (local.get $i) (i32.const 2)))))
          (local.set $map (call $__map_set (local.get $map)
            (i64.load (i32.add (local.get $slot) (i32.const 8)))
            (i64.load (i32.add (local.get $slot) (i32.const 16)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $lm))))
      (else (if (i32.eq (local.get $t) (i32.const ${PTR.ARRAY}))
        (then
          (block $da (loop $la
            (br_if $da (i32.ge_s (local.get $i) (local.get $n)))
            (local.set $entry (i64.reinterpret_f64 (call $__typed_idx (local.get $src) (local.get $i))))
            (local.set $map (call $__map_set (local.get $map)
              (i64.reinterpret_f64 (call $__typed_idx (local.get $entry) (i32.const 0)))
              (i64.reinterpret_f64 (call $__typed_idx (local.get $entry) (i32.const 1)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $la)))))))
    (f64.reinterpret_i64 (local.get $map)))`

  // === HASH — dynamic string-keyed object (type=7) ===

  // FNV-1a hash of string content (works on both SSO and heap strings)
  // FNV-1a. ~95M calls in watr self-host. Inline char-fetch: hoist type/offset out of the
  // byte loop so SSO branch uses dword shifts and STRING branch uses raw load8_u — neither
  // calls anything per byte (vs original 1×__char_at → __ptr_type + __ptr_offset per byte).
  ctx.core.stdlib['__str_hash'] = `(func $__str_hash (param $s i64) (result i32)
    (local $h i32) (local $len i32) (local $lenA i32) (local $i i32) (local $t i32) (local $off i32) (local $aux i32) (local $w i32)
    (local.set $h (i32.const 0x811c9dc5))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $s) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $s) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $aux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $s) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING})) (i32.shr_u (local.get $aux) (i32.const 14)))
      (then
        (local.set $len (i32.and (local.get $aux) (i32.const 7)))
        (block $ds (loop $ls
          (br_if $ds (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $h (i32.mul
            (i32.xor (local.get $h)
              (i32.and (i32.shr_u (local.get $off) (i32.shl (local.get $i) (i32.const 3))) (i32.const 0xFF)))
            (i32.const 0x01000193)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $ls))))
      (else
        (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING})) (i32.ge_u (local.get $off) (i32.const 4)))
          (then (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 4))))))
        ;; 4-byte unrolled FNV-1a: each iter loads i32, mixes 4 bytes (little-endian) sequentially.
        (local.set $lenA (i32.and (local.get $len) (i32.const -4)))
        (block $d4 (loop $l4
          (br_if $d4 (i32.ge_s (local.get $i) (local.get $lenA)))
          (local.set $w (i32.load (i32.add (local.get $off) (local.get $i))))
          (local.set $h (i32.mul (i32.xor (local.get $h) (i32.and (local.get $w) (i32.const 0xFF))) (i32.const 0x01000193)))
          (local.set $h (i32.mul (i32.xor (local.get $h) (i32.and (i32.shr_u (local.get $w) (i32.const 8)) (i32.const 0xFF))) (i32.const 0x01000193)))
          (local.set $h (i32.mul (i32.xor (local.get $h) (i32.and (i32.shr_u (local.get $w) (i32.const 16)) (i32.const 0xFF))) (i32.const 0x01000193)))
          (local.set $h (i32.mul (i32.xor (local.get $h) (i32.shr_u (local.get $w) (i32.const 24))) (i32.const 0x01000193)))
          (local.set $i (i32.add (local.get $i) (i32.const 4)))
          (br $l4)))
        (block $dh (loop $lh
          (br_if $dh (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $h (i32.mul
            (i32.xor (local.get $h)
              (i32.load8_u (i32.add (local.get $off) (local.get $i))))
            (i32.const 0x01000193)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $lh)))))
    ;; Ensure >= 2 (0=empty, 1=tombstone)
    (if (result i32) (i32.le_s (local.get $h) (i32.const 1))
      (then (i32.add (local.get $h) (i32.const 2))) (else (local.get $h))))`

  ctx.core.stdlib['__hash_new'] = `(func $__hash_new (result f64)
    (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0)
      (call $__alloc_hdr_n (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY}))))`

  // Small initial capacity for propsPtr-style hashes (per-object dyn props).
  // Most receivers in real code carry 0-2 dyn props; paying 8-slot up-front
  // is wasted memory + probe-loop cache pressure. Grows to 4/8/... on demand.
  // L3/'speed' opts into a larger initial cap (default 8) to skip 2→4→8 growth
  // when AST-style nodes carry 3-5 props (watr.compile's profile).
  const smallCap = Math.max(ctx.transform.optimize?.hashSmallInitCap | 0, 2)
  ctx.core.stdlib['__hash_new_small'] = `(func $__hash_new_small (result f64)
    (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0)
      (call $__alloc_hdr_n (i32.const 0) (i32.const ${smallCap}) (i32.const ${MAP_ENTRY}))))`

  ctx.core.stdlib['__hash_get_local'] = genLookupStrict('__hash_get_local', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH)
  ctx.core.stdlib['__hash_get_local_h'] = genLookupStrictPrehashed('__hash_get_local_h', MAP_ENTRY, strEq, PTR.HASH)
  ctx.core.stdlib['__hash_set_local_h'] = genUpsertStrictPrehashed('__hash_set_local_h', MAP_ENTRY, strEq, PTR.HASH)
  ctx.core.stdlib['__hash_set_local'] = genUpsertGrow('__hash_set_local', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH, true, false, true)
  // Tombstones an entry in a HASH (string keys). Returns 1 if found+deleted, 0 otherwise.
  // Used as the bucket-level primitive for __dyn_del.
  ctx.core.stdlib['__hash_del_local'] = genDelete('__hash_del_local', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH)
  // Outer __dyn_props hash: keyed by object offset (i32 as f64 bits), value is per-object props hash.
  // Uses bit-hash + i64.eq — no string allocation for the unique integer key.
  ctx.core.stdlib['__ihash_get_local'] = genLookupStrict('__ihash_get_local', MAP_ENTRY, '$__map_hash', '(i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))', PTR.HASH)
  ctx.core.stdlib['__ihash_set_local'] = genUpsertGrow('__ihash_set_local', MAP_ENTRY, '$__map_hash', '(i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))', PTR.HASH, true)

  // Inline __ptr_offset (forwarding-aware) and __hash_get_local body — dyn_get is the
  // single hottest stdlib symbol in watr self-host (~95M calls). props returned by
  // __ihash_get_local is always HASH (or NULL_NAN, filtered by __is_nullish), so the
  // inlined probe skips a redundant type check + bit unboxing per call.
  //
  // OBJECT receivers fall back to schema-aware slot lookup when __dyn_props has no
  // entry — covers polymorphic-receiver patterns (e.g. `let o = w?n():s()` with
  // structurally distinct schemas) where receiver schemaId is unknown at compile
  // time but lives at runtime in the NaN-box aux bits. Gated on schema name table
  // presence (lifted in compile.js whenever __dyn_get is included). Static-shape
  // monomorphic OBJECTs hit the compile-time slot read path and never reach here.
  // Wrapped in a factory: `ctx.schema.list.length` is observed at template
  // expansion time, after all schemas have been registered. Setting the
  // template at module-init froze hasSchemas to false and dropped the arm
  // for any schema registered later in the compile (the common case for
  // anonymous-literal arguments crossing call boundaries).
  // Schema-arm key compare uses i64.eq instead of __str_eq: schema keys and
  // the call-site key both come from the interned string pool (same NaN-box
  // bits for identical literals), so bit-equality is correct and skips a
  // per-iter function call. Real-world strings sharing prefix bytes are not
  // a concern here — keys are static literals from the source program.
  // Schema-arm key compare: i64.eq first for the static-shape case (compile-time
  // schemas hold pool-interned keys with identical NaN-box bits as call-site
  // literals — single bit-eq decides). Falls back to __str_eq when bits differ
  // so runtime-registered schemas (e.g. JSON.parse OBJECTs whose keys are
  // freshly heap-allocated by __jp_str) still resolve correctly.
  const schemaKeyEq = (storedKey, userKey) => ctx.core.includes.has('__jp_obj') || ctx.core.includes.has('__jp')
    ? `(i32.or
        (i64.eq ${storedKey} ${userKey})
        (call $__str_eq ${storedKey} ${userKey}))`
    : `(i64.eq ${storedKey} ${userKey})`
  const buildObjectSchemaArm = () => (ctx.schema.list.length > 0 || ctx.core.includes.has('__jp_obj')) ? `
    (if (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
      (then
        (if (i32.ne (global.get $__schema_tbl) (i32.const 0))
          (then
            (local.set $sid (i32.wrap_i64 (i64.and (i64.shr_u
              (local.get $obj) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
            (local.set $kbits
              (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3)))))
            (local.set $koff (i32.wrap_i64 (i64.and (local.get $kbits) (i64.const ${LAYOUT.OFFSET_MASK}))))
            (local.set $nkeys (i32.load (i32.sub (local.get $koff) (i32.const 8))))
            (local.set $idx (i32.const 0))
            (block $kdone (loop $kloop
              (br_if $kdone (i32.ge_s (local.get $idx) (local.get $nkeys)))
              (if ${schemaKeyEq(`(i64.load (i32.add (local.get $koff) (i32.shl (local.get $idx) (i32.const 3))))`, `(local.get $key)`)}
                (then (return (i64.load (i32.add (local.get $off) (i32.shl (local.get $idx) (i32.const 3)))))))
              (local.set $idx (i32.add (local.get $idx) (i32.const 1)))
              (br $kloop)))))))` : ''
  const buildObjectSchemaLocals = () => (ctx.schema.list.length > 0 || ctx.core.includes.has('__jp_obj'))
    ? '(local $sid i32) (local $kbits i64) (local $koff i32) (local $nkeys i32)'
    : ''
  // Same lazy-gating story as buildObjectSchemaArm above — observed at
  // template-expansion time so schemas registered later in the compile
  // still pull the arm in.
  const buildObjectSchemaSetLocals = () => (ctx.schema.list.length > 0 || ctx.core.includes.has('__jp_obj'))
    ? '(local $sid i32) (local $kbits i64) (local $koff i32) (local $nkeys i32) (local $idx i32)'
    : ''
  const buildObjectSchemaSetArm = () => (ctx.schema.list.length > 0 || ctx.core.includes.has('__jp_obj')) ? `
    ;; If a dynamic write targets an existing fixed-shape field, update the
    ;; payload slot as well as the dynamic sidecar below. Otherwise bracket
    ;; writes and later dot reads can diverge.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                 (i32.ne (global.get $__schema_tbl) (i32.const 0)))
      (then
        (local.set $sid (i32.wrap_i64 (i64.and (i64.shr_u
          (local.get $obj) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
        (local.set $kbits
          (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3)))))
        (local.set $koff (i32.wrap_i64 (i64.and (local.get $kbits) (i64.const ${LAYOUT.OFFSET_MASK}))))
        (local.set $nkeys (i32.load (i32.sub (local.get $koff) (i32.const 8))))
        (local.set $idx (i32.const 0))
        (block $schemaSetDone (loop $schemaSetLoop
          (br_if $schemaSetDone (i32.ge_s (local.get $idx) (local.get $nkeys)))
          (if (call $__str_eq
                (i64.load (i32.add (local.get $koff) (i32.shl (local.get $idx) (i32.const 3))))
                (local.get $key))
            (then
              (i64.store (i32.add (local.get $off) (i32.shl (local.get $idx) (i32.const 3))) (local.get $val))
              (br $schemaSetDone)))
          (local.set $idx (i32.add (local.get $idx) (i32.const 1)))
          (br $schemaSetLoop)))))` : ''

  ctx.core.stdlib['__dyn_get'] = `(func $__dyn_get (param $obj i64) (param $key i64) (result i64)
    (call $__dyn_get_t (local.get $obj) (local.get $key) (call $__ptr_type (local.get $obj))))`

  // Thin wrapper: hash the key once, delegate to the prehashed body. Constant-key
  // call sites bypass this and call $__dyn_get_t_h directly with strHashLiteral().
  ctx.core.stdlib['__dyn_get_t'] = `(func $__dyn_get_t (param $obj i64) (param $key i64) (param $type i32) (result i64)
    (call $__dyn_get_t_h (local.get $obj) (local.get $key) (local.get $type) (call $__str_hash (local.get $key))))`

  ctx.core.stdlib['__dyn_get_t_h'] = () => `(func $__dyn_get_t_h (param $obj i64) (param $key i64) (param $type i32) (param $h i32) (result i64)
    (local $props i64) (local $off i32)
    (local $poff i32) (local $pcap i32) (local $pend i32) (local $idx i32) (local $slot i32) (local $tries i32)
    ${buildObjectSchemaLocals()}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; CLOSURE with no env (offset 0): many function refs share offset 0, so key the
    ;; global __dyn_props hash on the function table index (negative — can't collide
    ;; with real heap/data offsets). Closures *with* env keep their unique env ptr.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.CLOSURE})) (i32.eqz (local.get $off)))
      (then (local.set $off (i32.sub (i32.const -1)
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK})))))))
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then
        (block $done
          (loop $follow
            (br_if $done (i32.lt_u (local.get $off) (i32.const 16)))
            (br_if $done (i32.gt_u (local.get $off) (i32.shl (memory.size) (i32.const 16))))
            (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
            (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (br $follow)))))
    (block $dynDone
      (block $haveProps
        ;; ARRAY: header propsPtr at $off-16 is valid only when shift hasn't
        ;; rewritten the slot with forwarding bytes. Validate via HASH tag —
        ;; rejects 0 (no props) and forwarding garbage. Misses fall through to
        ;; the global hash, where __arr_shift migrates props on first .shift().
        (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
                     (i32.ge_u (local.get $off) (i32.const 16)))
          (then
            (local.set $props (i64.load (i32.sub (local.get $off) (i32.const 16))))
            (br_if $haveProps (i32.eq
              (i32.wrap_i64 (i64.and (i64.shr_u (local.get $props) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
              (i32.const ${PTR.HASH})))
            ;; Fresh array (header propsPtr=0, no shift, no props): skip the
            ;; global hash probe — there's nothing to find. Shifted arrays read
            ;; forwarding bytes here (low32=newOff, high32=-1) → non-zero, so
            ;; this br_if doesn't fire and they fall through to __dyn_props.
            (br_if $dynDone (i64.eqz (local.get $props)))
            (local.set $props (i64.const 0))))
        ;; OBJECT: heap-allocated (off >= __heap_start) carries propsPtr at
        ;; off-16 from __alloc_hdr. The slot is either 0 (no dyn props yet) or
        ;; a HASH — no forwarding-garbage case like ARRAY, so a bit-zero test
        ;; is enough. Static-segment objects fall through to the global hash.
        (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                     (i32.ge_u (local.get $off) (global.get $__heap_start)))
          (then
            (local.set $props (i64.load (i32.sub (local.get $off) (i32.const 16))))
            (br_if $dynDone (i64.eqz (local.get $props)))
            (br $haveProps)))
        ;; HASH: a plain dict whose string keys ARE its own bucket entries — the
        ;; receiver IS its props table, so probe it directly (a HASH never carries
        ;; an off-16 dyn sidecar). A statically HASH-typed h[k] already inlines
        ;; __hash_get; this path serves receivers whose HASH type is only known at
        ;; runtime — e.g. a value read back through a function return, as in
        ;; derive(emitter)[op]. Without it, dyn-get reads the (absent) sidecar and
        ;; reports every key missing.
        (if (i32.eq (local.get $type) (i32.const ${PTR.HASH}))
          (then
            (local.set $props (local.get $obj))
            (br $haveProps)))
        ;; Other header types (TYPED/SET/MAP) carry propsPtr at off-16
        ;; directly, bypassing the global __dyn_props hash.
        (if (i32.and (i32.ge_u (local.get $off) (i32.const 16))
              (i32.or (i32.eq (local.get $type) (i32.const ${PTR.TYPED}))
                (i32.or (i32.eq (local.get $type) (i32.const ${PTR.SET}))
                        (i32.eq (local.get $type) (i32.const ${PTR.MAP})))))
          (then
            (local.set $props (i64.load (i32.sub (local.get $off) (i32.const 16))))
            (br_if $dynDone (i64.eqz (local.get $props)))
            (br $haveProps)))
        ;; Fall back to the global __dyn_props hash (CLOSURE, shifted ARRAY,
        ;; static-segment OBJECT). 1-slot cache covers both hits and misses
        ;; (props=0 sentinel) so header-less types skip __ihash_get_local probes.
        (br_if $dynDone (f64.eq (global.get $__dyn_props) (f64.const 0)))
        (if (i32.eq (local.get $off) (global.get $__dyn_get_cache_off))
          (then
            (local.set $props (i64.reinterpret_f64 (global.get $__dyn_get_cache_props)))
            (br_if $dynDone (i64.eqz (local.get $props))))
          (else
            (local.set $props (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props))
              (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))))
            (global.set $__dyn_get_cache_off (local.get $off))
            (if (call $__is_nullish (local.get $props))
              (then
                (global.set $__dyn_get_cache_props (f64.const 0))
                (br $dynDone))
              (else
                (global.set $__dyn_get_cache_props (f64.reinterpret_i64 (local.get $props))))))))
      (local.set $poff (call $__ptr_offset (local.get $props)))
      (local.set $pcap (i32.load (i32.sub (local.get $poff) (i32.const 4))))
      (local.set $pend (i32.add (local.get $poff) (i32.mul (local.get $pcap) (i32.const ${MAP_ENTRY}))))
      (local.set $slot (i32.add (local.get $poff) (i32.mul (i32.and (local.get $h) (i32.sub (local.get $pcap) (i32.const 1))) (i32.const ${MAP_ENTRY}))))
      (block $hdone (loop $hprobe
        (br_if $dynDone (i64.eqz (i64.load (local.get $slot))))
        (if (call $__str_eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))
          (then (return (i64.load (i32.add (local.get $slot) (i32.const 16))))))
        (local.set $slot (i32.add (local.get $slot) (i32.const ${MAP_ENTRY})))
        (if (i32.ge_u (local.get $slot) (local.get $pend)) (then (local.set $slot (local.get $poff))))
        (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
        (br_if $hdone (i32.ge_s (local.get $tries) (local.get $pcap)))
        (br $hprobe))))${buildObjectSchemaArm()}
    (i64.const ${UNDEF_NAN}))`

  ctx.core.stdlib['__dyn_get_or'] = `(func $__dyn_get_or (param $obj i64) (param $key i64) (param $fallback i64) (result i64)
    (local $val i64)
    (local.set $val (call $__dyn_get (local.get $obj) (local.get $key)))
    (if (result i64)
      (i64.eq (local.get $val) (i64.const ${UNDEF_NAN}))
      (then (local.get $fallback))
      (else (local.get $val))))`

  ctx.core.stdlib['__dyn_get_expr'] = `(func $__dyn_get_expr (param $obj i64) (param $key i64) (result i64)
    (call $__dyn_get_expr_t (local.get $obj) (local.get $key) (call $__ptr_type (local.get $obj))))`

  ctx.core.stdlib['__dyn_get_expr_t'] = `(func $__dyn_get_expr_t (param $obj i64) (param $key i64) (param $t i32) (result i64)
    (local $val i64)
    (local.set $val (call $__dyn_get_t (local.get $obj) (local.get $key) (local.get $t)))
    (if (result i64)
      (i64.ne (local.get $val) (i64.const ${UNDEF_NAN}))
      (then (local.get $val))
      (else
        (if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
          (then (call $__hash_get_local (local.get $obj) (local.get $key)))
          (else (i64.const ${UNDEF_NAN}))))))`

  // Prehashed variant of __dyn_get_expr_t for constant string keys: the FNV hash
  // is folded at compile time (strHashLiteral), so no __str_hash call at runtime.
  ctx.core.stdlib['__dyn_get_expr_t_h'] = `(func $__dyn_get_expr_t_h (param $obj i64) (param $key i64) (param $t i32) (param $h i32) (result i64)
    (local $val i64)
    (local.set $val (call $__dyn_get_t_h (local.get $obj) (local.get $key) (local.get $t) (local.get $h)))
    (if (result i64)
      (i64.ne (local.get $val) (i64.const ${UNDEF_NAN}))
      (then (local.get $val))
      (else
        (if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
          (then (call $__hash_get_local_h (local.get $obj) (local.get $key) (local.get $h)))
          (else (i64.const ${UNDEF_NAN}))))))`

  // Like __dyn_get_expr but also resolves EXTERNAL host objects via __ext_prop.
  // Used at call sites where receiver type is statically unknown.
  // When features.external is off, collapses to __dyn_get_expr shape (no EXTERNAL probe).
  ctx.core.stdlib['__dyn_get_any'] = () => {
    // Fast path: HASH check first, route directly to __hash_get_local. Hashes never carry
    // dyn_props (those are for OBJECT/ARRAY attached props), so the original __dyn_get
    // call was always wasted work on hashes — and JSON.parse / Map-style code is the
    // dominant HASH consumer.
    return `(func $__dyn_get_any (param $obj i64) (param $key i64) (result i64)
    (call $__dyn_get_any_t (local.get $obj) (local.get $key) (call $__ptr_type (local.get $obj))))`
  }

  ctx.core.stdlib['__dyn_get_any_t'] = () => {
    const extArm = ctx.features.external
      ? `(if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.EXTERNAL}))
            (then (call $__ext_prop (local.get $obj) (local.get $key)))
            (else (i64.const ${UNDEF_NAN})))`
      : `(i64.const ${UNDEF_NAN})`
    return `(func $__dyn_get_any_t (param $obj i64) (param $key i64) (param $t i32) (result i64)
    (local $val i64)
    (if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
      (then (call $__hash_get_local (local.get $obj) (local.get $key)))
      (else
        (local.set $val (call $__dyn_get_t (local.get $obj) (local.get $key) (local.get $t)))
        (if (result i64)
          (i64.ne (local.get $val) (i64.const ${UNDEF_NAN}))
          (then (local.get $val))
          (else ${extArm})))))`
  }

  // Prehashed variant of __dyn_get_any_t for constant string keys: the FNV hash
  // is folded at compile time (strHashLiteral), so no __str_hash call at runtime.
  // Hot for the layered-parser pattern — `parse.step`/`parse.space`/… reads a
  // function-object property with a literal key on every parser step.
  ctx.core.stdlib['__dyn_get_any_t_h'] = () => {
    const extArm = ctx.features.external
      ? `(if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.EXTERNAL}))
            (then (call $__ext_prop (local.get $obj) (local.get $key)))
            (else (i64.const ${UNDEF_NAN})))`
      : `(i64.const ${UNDEF_NAN})`
    return `(func $__dyn_get_any_t_h (param $obj i64) (param $key i64) (param $t i32) (param $h i32) (result i64)
    (local $val i64)
    (if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
      (then (call $__hash_get_local_h (local.get $obj) (local.get $key) (local.get $h)))
      (else
        (local.set $val (call $__dyn_get_t_h (local.get $obj) (local.get $key) (local.get $t) (local.get $h)))
        (if (result i64)
          (i64.ne (local.get $val) (i64.const ${UNDEF_NAN}))
          (then (local.get $val))
          (else ${extArm})))))`
  }

  // Hot for `node.loc = pos` patterns (e.g. watr's parser tags every nested level).
  // Defer the root insert to the end and gate it on props-ptr change: most calls hit
  // the no-grow case where the ptr is unchanged and the root slot already points to it.
  // __ptr_offset inlined (forwarding-aware) — only ARRAY ever has forwarding.
  ctx.core.stdlib['__dyn_set'] = () => `(func $__dyn_set (param $obj i64) (param $key i64) (param $val i64) (result i64)
    (local $root i64) (local $props i64) (local $oldProps i64) (local $objKey i64)
    (local $off i32) (local $type i32) ${buildObjectSchemaSetLocals()}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $type (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    ;; CLOSURE with no env (offset 0): key __dyn_props on the function table index — see __dyn_get_t.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.CLOSURE})) (i32.eqz (local.get $off)))
      (then (local.set $off (i32.sub (i32.const -1)
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK})))))))
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then
        (block $done
          (loop $follow
            (br_if $done (i32.lt_u (local.get $off) (i32.const 16)))
            (br_if $done (i32.gt_u (local.get $off) (i32.shl (memory.size) (i32.const 16))))
            (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
            (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (br $follow)))))
    ${buildObjectSchemaSetArm()}
    ;; Header types carry propsPtr at off-16. Read/grow/write directly there;
    ;; skip the global __dyn_props hash entirely. ARRAY also uses this slot, but
    ;; only when shift hasn't overwritten it with forwarding bytes (HASH-tagged
    ;; check rejects 0 + forwarding garbage). Shifted ARRAYs fall back to the
    ;; global __dyn_props where __arr_shift has migrated their props.
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then
        (if (i32.ge_u (local.get $off) (i32.const 16))
          (then
            (local.set $oldProps (i64.load (i32.sub (local.get $off) (i32.const 16))))
            (if (i32.or
                  (i64.eqz (local.get $oldProps))
                  (i32.eq
                    (i32.wrap_i64 (i64.and (i64.shr_u (local.get $oldProps) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
                    (i32.const ${PTR.HASH})))
              (then
                (local.set $props
                  (if (result i64) (i64.eqz (local.get $oldProps))
                    (then (i64.reinterpret_f64 (call $__hash_new_small)))
                    (else (local.get $oldProps))))
                (local.set $props (call $__hash_set_local (local.get $props) (local.get $key) (local.get $val)))
                (if (i64.ne (local.get $props) (local.get $oldProps))
                  (then (i64.store (i32.sub (local.get $off) (i32.const 16)) (local.get $props))))
                (return (local.get $val))))))))
    ;; OBJECT: heap-allocated (off >= __heap_start) writes propsPtr directly at
    ;; off-16. The slot is 0 (init) or HASH — no forwarding-garbage like ARRAY.
    ;; Static-segment OBJECTs fall through to the global __dyn_props.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                 (i32.ge_u (local.get $off) (global.get $__heap_start)))
      (then
        (local.set $oldProps (i64.load (i32.sub (local.get $off) (i32.const 16))))
        (local.set $props
          (if (result i64) (i64.eqz (local.get $oldProps))
            (then (i64.reinterpret_f64 (call $__hash_new_small)))
            (else (local.get $oldProps))))
        (local.set $props (call $__hash_set_local (local.get $props) (local.get $key) (local.get $val)))
        (if (i64.ne (local.get $props) (local.get $oldProps))
          (then (i64.store (i32.sub (local.get $off) (i32.const 16)) (local.get $props))))
        (return (local.get $val))))
    ;; HASH: a plain dict — its string keys ARE its own bucket entries (there is no
    ;; off-16 sidecar; that belongs to TYPED/SET/MAP, which have a native shape PLUS
    ;; ad-hoc props). Write directly into the receiver, mirroring __dyn_get's HASH arm.
    ;; __hash_set_local forwards on grow, so the caller's boxed pointer stays valid.
    (if (i32.eq (local.get $type) (i32.const ${PTR.HASH}))
      (then
        (drop (call $__hash_set_local (local.get $obj) (local.get $key) (local.get $val)))
        (return (local.get $val))))
    (if (i32.and (i32.ge_u (local.get $off) (i32.const 16))
          (i32.or (i32.eq (local.get $type) (i32.const ${PTR.TYPED}))
            (i32.or (i32.eq (local.get $type) (i32.const ${PTR.SET}))
                    (i32.eq (local.get $type) (i32.const ${PTR.MAP})))))
      (then
        (local.set $oldProps (i64.load (i32.sub (local.get $off) (i32.const 16))))
        (local.set $props
          (if (result i64) (i64.eqz (local.get $oldProps))
            (then (i64.reinterpret_f64 (call $__hash_new_small)))
            (else (local.get $oldProps))))
        (local.set $props (call $__hash_set_local (local.get $props) (local.get $key) (local.get $val)))
        (if (i64.ne (local.get $props) (local.get $oldProps))
          (then (i64.store (i32.sub (local.get $off) (i32.const 16)) (local.get $props))))
        (return (local.get $val))))
    ;; Fallback: non-header types use the global __dyn_props.
    (local.set $root (i64.reinterpret_f64 (global.get $__dyn_props)))
    (if (i64.eqz (local.get $root))
      (then (local.set $root (i64.reinterpret_f64 (call $__hash_new)))))
    (local.set $objKey (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off))))
    (local.set $oldProps (call $__ihash_get_local (local.get $root) (local.get $objKey)))
    (local.set $props
      (if (result i64) (call $__is_nullish (local.get $oldProps))
        (then (i64.reinterpret_f64 (call $__hash_new_small)))
        (else (local.get $oldProps))))
    (local.set $props (call $__hash_set_local (local.get $props) (local.get $key) (local.get $val)))
    (if (i64.ne (local.get $props) (local.get $oldProps))
      (then
        (local.set $root (call $__ihash_set_local (local.get $root) (local.get $objKey) (local.get $props)))
        (global.set $__dyn_props (f64.reinterpret_i64 (local.get $root)))
        (if (i32.eq (local.get $off) (global.get $__dyn_get_cache_off))
          (then (global.set $__dyn_get_cache_props (f64.reinterpret_i64 (local.get $props)))))))
    (local.get $val))`

  // Tag-dispatched delete (mirrors __dyn_set's dispatch). Returns 1 if a slot was
  // found+tombstoned, 0 otherwise. Header types (ARRAY non-shifted, OBJECT heap-only,
  // TYPED/HASH/SET/MAP) carry propsPtr at off-16; others fall back to the global
  // __dyn_props hash keyed by offset.
  // Schema-aware delete arm: when the receiver is an OBJECT with a known schema and
  // the key matches a static slot, overwrite that slot with UNDEF_NAN so subsequent
  // reads see "absent" (matches `delete obj.a; obj.a → undefined`). Without this,
  // the shadow-store delete alone would leave the structural slot intact and a later
  // ctx[k] read would re-surface the original value.
  const buildObjectSchemaDelArm = () => (ctx.schema.list.length > 0 || ctx.core.includes.has('__jp_obj')) ? `
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                 (i32.ne (global.get $__schema_tbl) (i32.const 0)))
      (then
        (local.set $sid (i32.wrap_i64 (i64.and (i64.shr_u
          (local.get $obj) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
        (local.set $kbits
          (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3)))))
        (local.set $koff (i32.wrap_i64 (i64.and (local.get $kbits) (i64.const ${LAYOUT.OFFSET_MASK}))))
        (local.set $nkeys (i32.load (i32.sub (local.get $koff) (i32.const 8))))
        (local.set $idx (i32.const 0))
        (block $schemaDelDone (loop $schemaDelLoop
          (br_if $schemaDelDone (i32.ge_s (local.get $idx) (local.get $nkeys)))
          (if (call $__str_eq
                (i64.load (i32.add (local.get $koff) (i32.shl (local.get $idx) (i32.const 3))))
                (local.get $key))
            (then
              (i64.store (i32.add (local.get $off) (i32.shl (local.get $idx) (i32.const 3))) (i64.const ${UNDEF_NAN}))
              (local.set $hit (i32.const 1))
              (br $schemaDelDone)))
          (local.set $idx (i32.add (local.get $idx) (i32.const 1)))
          (br $schemaDelLoop)))))` : ''

  ctx.core.stdlib['__dyn_del'] = () => `(func $__dyn_del (param $obj i64) (param $key i64) (result i32)
    (local $root i64) (local $props i64) (local $oldProps i64)
    (local $off i32) (local $type i32) (local $hit i32) ${buildObjectSchemaSetLocals()}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $type (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    ${buildObjectSchemaDelArm()}
    ;; CLOSURE with no env: rekey to function table index (parallels __dyn_set / __dyn_get_t_h).
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.CLOSURE})) (i32.eqz (local.get $off)))
      (then (local.set $off (i32.sub (i32.const -1)
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK})))))))
    ;; ARRAY: follow forwarding chain to landed base.
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then
        (block $done
          (loop $follow
            (br_if $done (i32.lt_u (local.get $off) (i32.const 16)))
            (br_if $done (i32.gt_u (local.get $off) (i32.shl (memory.size) (i32.const 16))))
            (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
            (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (br $follow)))))
    ;; ARRAY landed propsPtr (HASH-tagged means real sidecar; else fall through to global).
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
                 (i32.ge_u (local.get $off) (i32.const 16)))
      (then
        (local.set $oldProps (i64.load (i32.sub (local.get $off) (i32.const 16))))
        (if (i32.eq
              (i32.wrap_i64 (i64.and (i64.shr_u (local.get $oldProps) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
              (i32.const ${PTR.HASH}))
          (then (return (i32.or (local.get $hit) (call $__hash_del_local (local.get $oldProps) (local.get $key))))))))
    ;; OBJECT heap: propsPtr directly at off-16.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                 (i32.ge_u (local.get $off) (global.get $__heap_start)))
      (then
        (local.set $oldProps (i64.load (i32.sub (local.get $off) (i32.const 16))))
        (if (i64.eqz (local.get $oldProps)) (then (return (local.get $hit))))
        (return (i32.or (local.get $hit) (call $__hash_del_local (local.get $oldProps) (local.get $key))))))
    ;; Other header types (TYPED/HASH/SET/MAP).
    (if (i32.and (i32.ge_u (local.get $off) (i32.const 16))
          (i32.or (i32.eq (local.get $type) (i32.const ${PTR.TYPED}))
            (i32.or (i32.eq (local.get $type) (i32.const ${PTR.HASH}))
              (i32.or (i32.eq (local.get $type) (i32.const ${PTR.SET}))
                      (i32.eq (local.get $type) (i32.const ${PTR.MAP}))))))
      (then
        (local.set $oldProps (i64.load (i32.sub (local.get $off) (i32.const 16))))
        (if (i64.eqz (local.get $oldProps)) (then (return (local.get $hit))))
        (return (i32.or (local.get $hit) (call $__hash_del_local (local.get $oldProps) (local.get $key))))))
    ;; Fallback: global __dyn_props keyed by offset.
    (local.set $root (i64.reinterpret_f64 (global.get $__dyn_props)))
    (if (i64.eqz (local.get $root)) (then (return (local.get $hit))))
    (local.set $props (call $__ihash_get_local (local.get $root) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))))
    (if (call $__is_nullish (local.get $props)) (then (return (local.get $hit))))
    (i32.or (local.get $hit) (call $__hash_del_local (local.get $props) (local.get $key))))`

  ctx.core.stdlib['__dyn_move'] = `(func $__dyn_move (param $oldOff i32) (param $newOff i32)
    (local $props i64) (local $root i64)
    (if (f64.eq (global.get $__dyn_props) (f64.const 0)) (then (return)))
    (local.set $props (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $oldOff)))))
    (if (call $__is_nullish (local.get $props)) (then (return)))
    (local.set $root (call $__ihash_set_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $newOff))) (local.get $props)))
    (global.set $__dyn_props (f64.reinterpret_i64 (local.get $root))))`

  // Generated HASH probe functions
  ctx.core.stdlib['__hash_set'] = () => genUpsertGrow('__hash_set', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH, false, ctx.features.external, true)
  ctx.core.stdlib['__hash_get'] = () => genLookup('__hash_get', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH, true, ctx.features.external)
  ctx.core.stdlib['__hash_has'] = () => genLookup('__hash_has', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH, false, ctx.features.external)

  // === `delete obj[k]`: lift from prepare for computed-key removal ===
  // Static-key `delete obj.x` / `delete obj["x"]` is rejected in prepare (fixed schema);
  // only the runtime-dispatched form reaches here. JS returns `true` on success — we
  // surface the actual found/not-found bit as i32 (`true`/`false` ↔ 1/0 in jz NaN-box).
  ctx.core.emit['delete'] = (obj, key) => {
    inc('__dyn_del')
    return typed(['call', '$__dyn_del', asI64(emit(obj)), asI64(emit(key))], 'i32')
  }

  // === `in` operator: key in obj → HASH key existence check ===
  ctx.core.emit['in'] = (key, obj) => {
    const objType = typeof obj === 'string' ? lookupValType(obj) : valTypeOf(obj)

    if (Array.isArray(key) && key[0] === 'str') {
      const prop = key[1]
      if (prop === 'length' && (objType === VAL.ARRAY || objType === VAL.TYPED || objType === VAL.STRING || objType === VAL.SET || objType === VAL.MAP))
        return typed(['i32.const', 1], 'i32')

      const schemaIdx = typeof obj === 'string' ? ctx.schema.find(obj, prop) : ctx.schema.find(null, prop)
      if (schemaIdx >= 0) return typed(['i32.const', 1], 'i32')
      // A schema MISS does not prove absence: an OBJECT can carry off-schema
      // dynamic props (`o.z = …` → __dyn_set's propsPtr), and under the self-host
      // kernel schema.find can under-resolve even an in-schema key. Don't fold to
      // a static 0 — fall through to the runtime probe below, which reads the
      // actual property via __dyn_get (OBJECT is in `hasDynProps`) and reports
      // presence by non-nullish, exactly as the `.`/`[]` READ path resolves it.
    }

    const keyTmp = temp()
    const objTmp = temp()
    const idxTmp = tempI32('in_idx')
    const typeTmp = tempI32('in_type')
    const outTmp = tempI32('in_out')

    const keyVal = ['local.get', `$${keyTmp}`]
    const objVal = ['local.get', `$${objTmp}`]
    const idxVal = ['local.get', `$${idxTmp}`]
    const typeVal = ['local.get', `$${typeTmp}`]
    const isStringKey = ['call', '$__is_str_key', ['i64.reinterpret_f64', keyVal]]
    const isStringLike = ['i32.eq', typeVal, ['i32.const', PTR.STRING]]
    const isArrayLike = ['i32.or',
      ['i32.eq', typeVal, ['i32.const', PTR.ARRAY]],
      ['i32.eq', typeVal, ['i32.const', PTR.TYPED]]]
    const hasDynProps = ['i32.or',
      ['i32.eq', typeVal, ['i32.const', PTR.OBJECT]],
      ['i32.or',
        ['i32.or',
          ['i32.eq', typeVal, ['i32.const', PTR.ARRAY]],
          ['i32.eq', typeVal, ['i32.const', PTR.TYPED]]],
        ['i32.or',
          ['i32.eq', typeVal, ['i32.const', PTR.STRING]],
          ['i32.or',
            ['i32.or',
              ['i32.eq', typeVal, ['i32.const', PTR.SET]],
              ['i32.eq', typeVal, ['i32.const', PTR.MAP]]],
            ['i32.eq', typeVal, ['i32.const', PTR.CLOSURE]]]]]]

    inc('__ptr_type', '__len', '__str_byteLen', '__hash_has', '__is_str_key', '__to_str', '__dyn_get', '__is_nullish')
    if (ctx.features.external) inc('__ext_has')

    return typed(['block', ['result', 'i32'],
      ['local.set', `$${objTmp}`, asF64(emit(obj))],
      ['local.set', `$${keyTmp}`, asF64(emit(key))],
      ['local.set', `$${outTmp}`, ['i32.const', 0]],
      ['local.set', `$${typeTmp}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', objVal]]],
      ['local.set', `$${idxTmp}`, ['i32.trunc_sat_f64_s', keyVal]],

      ['if', ['i32.and',
        ['f64.eq', keyVal, keyVal],
        ['i32.and',
          ['f64.eq', ['f64.convert_i32_s', idxVal], keyVal],
          ['i32.ge_s', idxVal, ['i32.const', 0]]]],
        ['then',
          ['if', isStringLike,
            ['then', ['local.set', `$${outTmp}`, ['i32.lt_u', idxVal, ['call', '$__str_byteLen', ['i64.reinterpret_f64', objVal]]]]]],
          ['if', isArrayLike,
            ['then', ['local.set', `$${outTmp}`, ['i32.lt_u', idxVal, ['call', '$__len', ['i64.reinterpret_f64', objVal]]]]]]]],

      ['if', isStringKey,
        ['then',
          ['if', hasDynProps,
            ['then', ['local.set', `$${outTmp}`,
              ['i32.eqz', ['call', '$__is_nullish', ['call', '$__dyn_get', ['i64.reinterpret_f64', objVal], ['i64.reinterpret_f64', keyVal]]]]]]]]],

      ['if', ['i32.eq', typeVal, ['i32.const', PTR.HASH]],
        ['then', ['local.set', `$${outTmp}`,
          ['if', ['result', 'i32'], isStringKey,
            ['then', ['call', '$__hash_has', ['i64.reinterpret_f64', objVal], ['i64.reinterpret_f64', keyVal]]],
            ['else', ['call', '$__hash_has', ['i64.reinterpret_f64', objVal], ['call', '$__to_str', ['i64.reinterpret_f64', keyVal]]]]]]]],

      ...(ctx.features.external ? [['if', ['i32.eq', typeVal, ['i32.const', PTR.EXTERNAL]],
        ['then', ['local.set', `$${outTmp}`, ['call', '$__ext_has',
          ['i64.reinterpret_f64', objVal], ['i64.reinterpret_f64', keyVal]]]]]] : []),

      ['local.get', `$${outTmp}`]], 'i32')
  }

  // === iterable normalization: Set/Map → dense Array ===

  // `for (x of coll)` and `[...coll]` iterate in *value* order, but a Set/Map
  // stores entries in a sparse open-addressing table (live slots scattered among
  // empties). Index access `coll[i]` would read raw slot words. So normalize a
  // Set→keys-array / Map→[k,v]-entries-array once at loop/spread setup; an Array,
  // String, or TypedArray is already index-iterable and passes through untouched
  // (no copy). `valTypeOf(['()','__iter_arr',x])` (src/kind.js) mirrors this:
  // Set/Map → ARRAY, everything else → x's own type, so the downstream `arr[i]`
  // / `.length` dispatch stays statically typed.
  ctx.core.emit['__iter_arr'] = (src) => {
    const vt = valTypeOf(src)
    if (vt === VAL.ARRAY || vt === VAL.STRING || vt === VAL.TYPED || vt === VAL.BUFFER)
      return asF64(emit(src))
    const t = temp('iter')
    const bind = ['local.set', `$${t}`, asF64(emit(src))]
    if (vt === VAL.SET) return typed(['block', ['result', 'f64'], bind, collKeysFromTemp(t, SET_ENTRY)], 'f64')
    if (vt === VAL.MAP) return typed(['block', ['result', 'f64'], bind, collEntriesFromTemp(t, MAP_ENTRY)], 'f64')
    // Unknown receiver: resolve the kind once at runtime (loop-invariant).
    inc('__ptr_type')
    const ptrType = () => ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]
    return typed(['block', ['result', 'f64'], bind,
      ['if', ['result', 'f64'], ['i32.eq', ptrType(), ['i32.const', PTR.SET]],
        ['then', collKeysFromTemp(t, SET_ENTRY)],
        ['else', ['if', ['result', 'f64'], ['i32.eq', ptrType(), ['i32.const', PTR.MAP]],
          ['then', collEntriesFromTemp(t, MAP_ENTRY)],
          ['else', ['local.get', `$${t}`]]]]]], 'f64')
  }

  // === for...in on dynamic objects (HASH iteration) ===

  // for-in: iterate HASH entries, binding key string to loop variable.
  // Also handles OBJECT/ARRAY/etc whose dynamic props are stored at off-16
  // as a HASH (see __dyn_set). Non-HASH receivers redirect to that props HASH.
  ctx.core.emit['for-in'] = (varName, src, body) => {
    const off = tempI32('ho'), cap = tempI32('hc'), n = tempI32('hn'), ord = tempI32('hr')
    const i = tempI32('hi'), slot = tempI32('hs')
    const ptrI64 = tempI64('hp'), srcOff = tempI32('hso'), srcType = tempI32('hst')
    if (!ctx.func.locals.has(varName)) ctx.func.locals.set(varName, 'f64')
    const id = ctx.func.uniq++
    const brk = `$brk${id}`, loop = `$loop${id}`, cont = `$cont${id}`
    const va = asF64(emit(src))
    const needsCont = hasOwnContinue(body)
    ctx.func.stack.push({ brk, loop: needsCont ? cont : loop })
    let bodyFlat
    try { bodyFlat = flat(body) }
    finally { ctx.func.stack.pop() }
    const bodyBlock = needsCont ? [['block', cont, ...bodyFlat]] : bodyFlat
    inc('__ptr_type', '__len', '__coll_order')
    return [
      // Save source ptr as i64
      ['local.set', `$${ptrI64}`, ['i64.reinterpret_f64', va]],
      ['local.set', `$${srcType}`, ['call', '$__ptr_type', ['local.get', `$${ptrI64}`]]],
      // If not HASH, follow off-16 to props hash (or zero if no props yet).
      ['if', ['i32.ne', ['local.get', `$${srcType}`], ['i32.const', PTR.HASH]],
        ['then',
          ['local.set', `$${srcOff}`, ['call', '$__ptr_offset', ['local.get', `$${ptrI64}`]]],
          ['if', ['i32.ge_u', ['local.get', `$${srcOff}`], ['i32.const', 16]],
            ['then',
              ['local.set', `$${ptrI64}`, ['i64.load', ['i32.sub', ['local.get', `$${srcOff}`], ['i32.const', 16]]]]],
            ['else',
              ['local.set', `$${ptrI64}`, ['i64.const', 0]]]]]],
      // Empty / null props: skip iteration entirely.
      ['if', ['i64.ne', ['local.get', `$${ptrI64}`], ['i64.const', 0]],
        ['then',
          ['local.set', `$${off}`, ['call', '$__ptr_offset', ['local.get', `$${ptrI64}`]]],
          ['local.set', `$${cap}`, ['call', '$__cap', ['local.get', `$${ptrI64}`]]],
          ['local.set', `$${n}`, ['call', '$__len', ['local.get', `$${ptrI64}`]]],
          // Snapshot live slots in insertion order (JS for-in spec order). Walk
          // the snapshot; re-check occupancy so a key the body deletes before it
          // is reached is skipped rather than re-bound from an emptied slot.
          ['local.set', `$${ord}`, ['call', '$__coll_order', ['local.get', `$${off}`], ['local.get', `$${cap}`], ['i32.const', MAP_ENTRY]]],
          ['local.set', `$${i}`, ['i32.const', 0]],
          ['block', brk, ['loop', loop,
            ['br_if', brk, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${n}`]]],
            ['local.set', `$${slot}`, ['i32.load', ['i32.add', ['local.get', `$${ord}`],
              ['i32.shl', ['local.get', `$${i}`], ['i32.const', 2]]]]],
            ['if', ['i64.ne', ['i64.load', ['local.get', `$${slot}`]], ['i64.const', 0]],
              ['then',
                ['local.set', `$${varName}`, ['f64.reinterpret_i64', ['i64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]]]],
                ...bodyBlock]],
            ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
            ['br', loop]]]]]
    ]
  }
}

// Walk a Set/Map backing table (bound f64 local `t`), copying one column of each
// live entry into a fresh dense Array sized to the live count. `stride` is the
// entry size (Set 16, Map 24); the first f64 word of each slot is the stored
// hash — 0 marks an empty slot (no tombstones: delete back-shifts). `fieldOff`
// picks the column: 8 = key (Set element / Map key), 16 = Map value. Mirrors
// object.js's hash*FromTemp. Used by `__iter_arr` and `.keys()`/`.values()`.
function collKeysFromTemp(t, stride, fieldOff = 8) {
  inc('__ptr_offset', '__cap', '__len', '__coll_order')
  const off = tempI32('cko'), cap = tempI32('ckc'), n = tempI32('ckn')
  const i = tempI32('cki'), ord = tempI32('ckr'), slot = tempI32('cks')
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'cka' })
  const id = ctx.func.uniq++
  return ['block', ['result', 'f64'],
    ['local.set', `$${n}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    out.init,
    ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${cap}`, ['call', '$__cap', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${ord}`, ['call', '$__coll_order', ['local.get', `$${off}`], ['local.get', `$${cap}`], ['i32.const', stride]]],
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$ckbrk${id}`, ['loop', `$ckloop${id}`,
      ['br_if', `$ckbrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${n}`]]],
      ['local.set', `$${slot}`, ['i32.load', ['i32.add', ['local.get', `$${ord}`],
        ['i32.shl', ['local.get', `$${i}`], ['i32.const', 2]]]]],
      elemStore(out.local, i,
        ['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', fieldOff]]]),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$ckloop${id}`]]],
    out.ptr]
}

// Like collKeysFromTemp but builds 2-element pair arrays — Map/Set `entries()`
// and `[...map]` yield pairs. Each live slot contributes a fresh 2-element Array
// [slot+aOff, slot+bOff] boxed into the output: Map entries use (8,16) → [k,v];
// Set entries use (8,8) → [v,v].
function collEntriesFromTemp(t, stride, aOff = 8, bOff = 16) {
  inc('__ptr_offset', '__cap', '__len', '__alloc_hdr', '__coll_order')
  const off = tempI32('ceo'), cap = tempI32('cec'), n = tempI32('cen')
  const i = tempI32('cei'), ord = tempI32('cer'), slot = tempI32('ces'), pair = tempI32('cep')
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'cea' })
  const id = ctx.func.uniq++
  return ['block', ['result', 'f64'],
    ['local.set', `$${n}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    out.init,
    ['local.set', `$${off}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${cap}`, ['call', '$__cap', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${ord}`, ['call', '$__coll_order', ['local.get', `$${off}`], ['local.get', `$${cap}`], ['i32.const', stride]]],
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$cebrk${id}`, ['loop', `$celoop${id}`,
      ['br_if', `$cebrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${n}`]]],
      ['local.set', `$${slot}`, ['i32.load', ['i32.add', ['local.get', `$${ord}`],
        ['i32.shl', ['local.get', `$${i}`], ['i32.const', 2]]]]],
      ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2]]],
      ['f64.store', ['local.get', `$${pair}`],
        ['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', aOff]]]],
      ['f64.store', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]],
        ['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', bOff]]]],
      elemStore(out.local, i, mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${pair}`])),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$celoop${id}`]]],
    out.ptr]
}

// Array.prototype.keys() → dense Array of indices [0, 1, …, len-1] as numbers.
function arrIdxFromTemp(t) {
  inc('__len')
  const n = tempI32('ain'), i = tempI32('aii')
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'aia' })
  const id = ctx.func.uniq++
  return ['block', ['result', 'f64'],
    ['local.set', `$${n}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    out.init,
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$aibrk${id}`, ['loop', `$ailoop${id}`,
      ['br_if', `$aibrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${n}`]]],
      elemStore(out.local, i, ['f64.convert_i32_s', ['local.get', `$${i}`]]),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$ailoop${id}`]]],
    out.ptr]
}

// Array.prototype.entries() → dense Array of [index, element] pair arrays.
function arrEntriesFromTemp(t) {
  inc('__len', '__ptr_offset', '__alloc_hdr')
  const n = tempI32('aen'), i = tempI32('aei'), src = tempI32('aes'), pair = tempI32('aep')
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'aea' })
  const id = ctx.func.uniq++
  return ['block', ['result', 'f64'],
    ['local.set', `$${n}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    out.init,
    ['local.set', `$${src}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$aebrk${id}`, ['loop', `$aeloop${id}`,
      ['br_if', `$aebrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${n}`]]],
      ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2]]],
      ['f64.store', ['local.get', `$${pair}`], ['f64.convert_i32_s', ['local.get', `$${i}`]]],
      ['f64.store', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]], elemLoad(src, i)],
      elemStore(out.local, i, mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${pair}`])),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$aeloop${id}`]]],
    out.ptr]
}
