/**
 * Collection module — Set, Map, HASH (dynamic string-keyed objects).
 *
 * Set: type=8, open addressing hash table. Entries: [hash|seq:8, key:8] (16B each).
 * Map: type=9, same but entries: [hash|seq:8, key:8, val:8] (24B each).
 * HASH: type=7, same layout as Map but uses content-based string hash + equality.
 * Every table additionally carries an i32 HASH LANE (cap × 4 B) AFTER the entry
 * region — the only thing probes walk (see probeStart) — so allocations are
 * cap × (entrySize + 4) bytes; entry offsets and iteration are unchanged.
 *
 * @module collection
 */

import { typed, asF64, asI64, asI32, NULL_NAN, UNDEF_NAN, TOMB_NAN, temp, tempI32, tempI64, allocPtr, undefExpr, mkPtrIR, ptrTypeEq, elemStore, elemLoad, carrierF64 } from '../src/ir.js'
import { emit, deps, call } from '../src/bridge.js'
import { valTypeOf } from '../src/kind.js'
import { VAL, lookupValType } from '../src/reps.js'
import { hasOwnContinue, isBlockBody, isLiteralStr } from '../src/ast.js'
import { ctx, inc, PTR, LAYOUT, registerGetter, declGlobal } from '../src/ctx.js'
import { STR_INTERN_BIT, STR_HCACHE_BIT, ssoBitI64Hex, encodePtrHi, i64Hex } from '../layout.js'
import { ssoEncode } from './string.js'

const SSO_BIT_I64 = ssoBitI64Hex()
// NaN-box bits of the SSO string 'length' — computed once; see the STRING
// arm in __dyn_get_t_h and __length's property-fallback arm (module/core.js).
// ssoEncode('length') never returns null (6 ASCII).
export const LENGTH_SSO_I64 = (() => { const e = ssoEncode('length'); return i64Hex((BigInt(encodePtrHi(4, e.aux) >>> 0) << 32n) | BigInt(e.offset)) })()

const SET_ENTRY = 16  // hash + key
const MAP_ENTRY = 24  // hash + key + value
const INIT_CAP = 8    // initial capacity (must be power of 2)

// __dyn_props global-table membership filter (see __dyn_props_filter's declGlobal
// comment). offExpr is an i32 WAT expr for the offset key. Mix folds the offset's
// mid bits (allocations are 8-byte aligned, so raw low bits are useless) down to
// a 6-bit bucket in a 64-bit bitset — never-false-negative, no false-negative risk
// from collisions (a collision just makes the filter's "maybe present" wider).
const dynPropsFilterBitIR = (offExpr) =>
  `(i64.shl (i64.const 1) (i64.extend_i32_u (i32.and (i32.xor (i32.shr_u ${offExpr} (i32.const 3)) (i32.shr_u ${offExpr} (i32.const 9))) (i32.const 63))))`
// Set the filter bit for an offset key that was just inserted into the global table.
export const dynPropsFilterSetIR = (offExpr) =>
  `(global.set $__dyn_props_filter (i64.or (global.get $__dyn_props_filter) ${dynPropsFilterBitIR(offExpr)}))`
// True (i32) when the filter bit is clear — i.e. offExpr is PROVEN never inserted,
// safe to skip the __ihash_get_local probe entirely. False (bit set) means "maybe
// present, maybe a collision" — falls through to the real probe.
export const dynPropsFilterMissIR = (offExpr) =>
  `(i64.eqz (i64.and (global.get $__dyn_props_filter) ${dynPropsFilterBitIR(offExpr)}))`

// The post-init high-water mark (see module/core.js's __heap_reset) as a WAT operand —
// everything at/above it is EPHEMERAL (this compile's own arena, wiped by `_clear`);
// everything below it is DURABLE (module-init state, survives `_clear` forever). Falls
// back to a literal 0 (every offset reads as "ephemeral") when the module has no
// `__heap_reset` global at all (no allocator, or shared memory, whose reset is a plain
// HEAP.START rewind with no high-water-mark concept — see core.js). Read at
// template-EXPANSION time (thunked callers only — see durableFwdLogIR/heapResetWat
// consumers), so it observes the FINAL declaration state, not whatever was true when
// collection.js's own module body first ran.
//
// DURABLE-RECEIVER POLICY (dyn-props twin of the above): a receiver allocated
// at/below __heap_reset outlives `_clear()`, but a sidecar installed for it at
// RUNTIME lives in the round's arena — the surviving header slot then dangles
// across `_clear()` and the next round corrupts reused memory. So runtime
// dyn-prop writes on a durable receiver (off < __heap_reset) route to the
// GLOBAL __dyn_props table instead — __clear resets it, so prop lifetime
// matches storage lifetime. Init-time writes still land in durable sidecars
// (__heap_reset is seeded to data-end until __start's tail captures the
// post-init top, so off >= __heap_reset holds throughout init). Every read/
// write/delete/enumerate site that consults a header sidecar gates on this —
// see module/object.js's emitEnumerateObject and module/json.js's __json_obj
// for the array-IR / WAT-string twins that merge in the global table for
// durable receivers.
export const heapResetWat = () => ctx.scope.globals.has('__heap_reset') ? '(global.get $__heap_reset)' : '(i32.const 0)'

// A growable ARRAY/HASH/SET/MAP relocates by leaving a forwarding header behind
// (cap=-1 sentinel at off-4, new offset at off-8 — see layout.js's followForwardingWat).
// That is only safe WITHIN one compile round: `_clear()` rewinds the arena but never
// zeroes memory, so a forward written into a DURABLE header (offOld < __heap_reset,
// i.e. the block predates this round) permanently points at an EPHEMERAL target that
// the next round's allocations silently overwrite — any later chase through the
// durable alias then lands on garbage or goes OOB (.work/todo.md groundtruth archive,
// "array-growth forwarding is not _clear-safe"). Growing an EPHEMERAL block needs no
// protection: everything reachable from it is ephemeral too, so the whole chain (old
// header, new header, and every durable-side reference to it — there are none, by
// construction) is reclaimed together at `_clear()`.
//
// Fix: at the grow/shift site, BEFORE writing the forward (while off/len/cap — the
// header's pre-relocation state — are still live locals), log the durable→ephemeral
// transition to a small resettable side-table (module/core.js's __durable_fwd_log/
// __durable_fwd_heal) instead of (or rather: in addition to, so the in-round chase
// still works) trusting the header alone. `_clear()` then HEALS each logged header
// back to its exact pre-relocation (len, cap) — undoing the forward mark, so the
// durable block reverts to self-contained, non-forwarding, and correct (its own
// element/entry cells were never touched by the relocation; only the header words
// were). This keeps followForwardingWat/__ptr_offset_fwd (the hot chase, ~25% of
// self-host compile ticks) completely UNTOUCHED — the check only runs on the already-
// cold relocation path, and the heal sweep only runs inside `_clear()`, bounded by
// however many durable relocations happened that round (0 in the overwhelmingly
// common case).
//
// Checks BOTH ends, not just "is off durable": a fresh `__alloc_hdr`/`__alloc_hdr_n`
// target (grow, genUpsert/genUpsertGrow) is unconditionally ephemeral whenever the
// source-durable check can even fire (any allocation live past `__start`'s tail-
// capture is by construction >= the now-final `__heap_reset`), so newOff's own check
// is redundant there — but `.shift()`'s "new" header is just `off + 8`, a position
// INSIDE the same block, not a fresh allocation: ordinarily still durable (shifting a
// durable array is legitimate, persistent state and must NOT be undone at `_clear`),
// and only crosses into ephemeral in the one-in-8-bytes edge case where `off` sits
// exactly at `__heap_reset - 8`. Requiring both conditions everywhere makes the
// invariant self-evidently correct at every call site instead of relying on a
// per-caller argument about what its "new" offset can be.
// Emits nothing at all (not even a call site) when there's no `__heap_reset` to compare
// against — shared memory's `__clear` is a plain rewind-to-HEAP.START with no high-water
// mark (core.js), so EVERYTHING resets uniformly there and no state is ever "durable" to
// begin with (a separate, pre-existing, documented gap — see core.js's shared-memory
// `__clear` comment). Testing `ctx.scope.globals.has('__heap_reset')` directly (not just
// deferring to heapResetWat()'s own `(i32.const 0)` fallback, which would still emit an
// always-false-but-present call) matters for self-host inclusion: array.js's/
// collection.js's deps() edges declare '__durable_fwd_log' unconditionally at every grow/
// shift site, so core.js must ALSO unconditionally register the function whenever those
// sites exist — but core.js only defines __durable_fwd_log/__durable_fwd_heal in the
// owned-memory branch (they need __heap/__heap_reset, which shared memory doesn't have).
// A shared-memory build reaching this function with the fallback would therefore
// reference a never-registered stdlib name, tripping assemble.js's `internal: stdlib
// '__durable_fwd_log' was requested but never registered` sanity check.
export const durableFwdLogIR = (off, newOff, len, cap) => {
  if (!ctx.scope.globals.has('__heap_reset')) return ''
  return `
    (if (i32.and (i32.lt_u (local.get $${off}) ${heapResetWat()}) (i32.ge_u (local.get $${newOff}) ${heapResetWat()}))
      (then (call $__durable_fwd_log (local.get $${off}) (local.get $${len}) (local.get $${cap}))))`
}

// Value-write sibling of durableFwdLogIR: an EPHEMERAL boxed value stored into a
// DURABLE collection slot dangles across `_clear` (the corpus-wide warm trap — a
// durable memo dict handing round-1 node arrays into round-2's tree). Log the slot
// so `__durable_slot_heal` (wired into `__clear`) overwrites it with `undefined` —
// the pointed-at data dies with the arena, so entry-death is the only sound
// semantics. `slotLocal`+`byteOff` name the value slot; `valLocal` holds the boxed
// bits (i64). Same shared-memory gate as durableFwdLogIR (no watermark, no sweep).
export const durableSlotLogIR = (slotLocal, byteOff, valLocal) => {
  if (!ctx.scope.globals.has('__heap_reset')) return ''
  const addr = byteOff ? `(i32.add (local.get $${slotLocal}) (i32.const ${byteOff}))` : `(local.get $${slotLocal})`
  return `
    (if (i32.and (i32.lt_u ${addr} ${heapResetWat()}) (call $__is_eph_bits (local.get $${valLocal})))
      (then (call $__durable_slot_log ${addr} (i32.const 0))))`
}

// ENTRY-insert variant: a NEW entry inserted into DURABLE table storage is
// round state regardless of what the key/value are — a fresh instance would not
// have the entry at all, and an ephemeral KEY can't even be value-healed (probes
// and enumeration would hash/compare the dangling box; measured: warm round 2
// hashed 15.5 MB of garbage-length "strings" where round 1 hashed 415 KB — the
// whole 2× warm-vs-fresh gap). Log the ENTRY base with bit0 set plus the table
// storage base; the heal turns the entry into a zombie — key ← TOMB_NAN
// (unforgeable, deref-free in every eq family), value ← undefined, table len
// decremented — that probes pass over and __coll_order/len-sized iterations
// skip. The slot stays occupied until the table grows (zombies never resurrect:
// nothing eq-matches TOMB_NAN). Entry addresses are 8-aligned → bit0 is free.
export const durableEntryLogIR = (slotLocal, offLocal) => {
  if (!ctx.scope.globals.has('__heap_reset')) return ''
  return `
    (if (i32.lt_u (local.get $${slotLocal}) ${heapResetWat()})
      (then (call $__durable_slot_log (i32.or (local.get $${slotLocal}) (i32.const 1)) (local.get $${offLocal}))))`
}

// Clamp to the >=2 convention (0=empty slot, 1=tombstone) — shared by every hash
// producer (SSO mix, byte-FNV, __jp_str, buildInternTable) so they all clamp identically.
const clampHash = (h) => (h <= 1 ? (h + 2) | 0 : h)

// SSO mix: 7 ops over the packed NaN-box lo/hi (see __str_hash's SSO branch,
// module/collection.js below, for the WAT twin — both MUST compute the same value).
// lo = offset (payload bits 0-31), hi = aux masked to bits 0-12 (length + char 4-5
// tail — SSO_BIT itself is excluded by the mask, so hi only carries discriminating
// content). Replaces the old 6-iteration per-char FNV loop with a fixed-cost mix.
const ssoMix = (lo, hi) => {
  let h = Math.imul(hi ^ 0x9E3779B9, 0x85EBCA6B)
  h = Math.imul(lo ^ h, 0xC2B2AE35)
  h = (h ^ (h >>> 15)) | 0
  return clampHash(h) >>> 0
}

// Byte-FNV-1a over UTF-8-ish bytes (charCodeAt & 0xFF — ASCII-only callers guarantee
// codepoint < 0x80, so this equals the byte value). Heap strings (>6 bytes or non-ASCII)
// keep this; __str_hash's heap branch and buildInternTable's static-intern prehash both
// compute the identical function — see module/string.js bind('str') and internProbeWat.
const byteFnv = (str) => {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ (str.charCodeAt(i) & 0xFF), 0x01000193) | 0
  return clampHash(h)
}

// Compile-time hash for an ASCII string LITERAL — must equal __str_hash's runtime
// result for the same content: ≤6-ASCII strings are ALWAYS SSO (module/string.js header
// invariant), so they use the new ssoMix; longer/non-ASCII strings stay on heap and use
// byte-FNV. Callers (litKeyHash below, module/core.js, module/array.js, module/json.js)
// pass ASCII content — non-ASCII goes through the runtime __str_hash path instead.
export function strHashLiteral(str) {
  const sso = ssoEncode(str)
  if (sso) return ssoMix(sso.offset | 0, sso.aux & 0x1FFF)
  return byteFnv(str)
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

// Compile-time probe hash for a LITERAL collection/property key, else null. A numeric
// constant → numHashLiteral; an ASCII string literal → strHashLiteral. The string case is
// ASCII-only on purpose: strHashLiteral's byte-FNV branch folds `charCodeAt(i) & 0xFF`,
// which equals __str_hash / __map_hash (FNV-1a over the UTF-8 bytes) ONLY for code points
// < 0x80 — a non-ASCII literal would fold a different hash than its stored key and silently
// miss, so it falls back to the runtime hash. (The ≤6-ASCII branch uses the SSO mix instead —
// still ASCII-only, since ssoEncode itself rejects non-ASCII and returns null.) Lets
// `m.get("if")` / `m.has("x")` skip the per-access __map_hash call.
const ASCII_KEY = /^[\x00-\x7f]*$/
const litKeyHash = (key) => {
  const num = numConstLiteral(key)
  if (num != null) return numHashLiteral(num)
  if (isLiteralStr(key) && ASCII_KEY.test(key[1])) return strHashLiteral(key[1])
  return null
}

// Key-equality expressions for probe templates — run only after a LANE hash hit
// (the probe skeleton compares hashes; these decide the hit). The inline
// `storedKey == queryKey` bit-eq decides the overwhelmingly-common identity case
// — interned/SSO literals and the same heap pointer are bit-equal — WITHOUT the
// __str_eq / __same_value_zero call frame. Sound for both: bit-equality implies
// string-equality and SameValueZero (the only cross-bit-pattern equals — +0/-0,
// distinct NaN payloads — fall through to the full compare, never the reverse).
const keyEq = (fullEq) =>
  `(if (result i32)
        (i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))
        (then (i32.const 1))
        (else ${fullEq}))`
const strEqG = keyEq('(call $__str_eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))')
const sameValueZeroEqG = keyEq('(call $__same_value_zero (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))')
const bitEq = '(i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))'

// HASH-LANE probe. Entries keep the classic layout ([hash|seq:8][key:8][val:8] —
// iteration, heal, durable logs, delete-shift and clones are untouched), but a
// parallel i32 HASH LANE (cap × 4 B, zero-filled, AFTER the entry region) is what
// probes WALK: one 4-byte load per step, 16 hash checks per cache line where the
// 24-byte entry stride gave 2-3, and a miss chain touches an 8 kB lane instead of
// sweeping a 48 kB table through L1 (the wordcount-vs-C probe-footprint gap).
// Empty ⇔ lane word 0 (hash clamp keeps real hashes ≥ 2); healed zombies KEEP
// their stale hash in the lane and are passed by the key compare exactly as the
// entry-walk passed them. $ls walks the lane ($lb/$end its bounds); $slot (the
// entry address) derives only on a hash hit / at the insert slot. Every table
// alloc pays entrySize+4 per slot; the entry region offsets are unchanged.
const LANE = 4
const probeStart = (entrySize, idxExpr = '(i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1)))') =>
  `(local.set $lb (i32.add (local.get $off) (i32.mul (local.get $cap) (i32.const ${entrySize}))))
    (local.set $end (i32.add (local.get $lb) (i32.shl (local.get $cap) (i32.const 2))))
    (local.set $ls (i32.add (local.get $lb) (i32.shl ${idxExpr} (i32.const 2))))`
const probeNext = () =>
  `(local.set $ls (i32.add (local.get $ls) (i32.const 4)))
      (if (i32.ge_u (local.get $ls) (local.get $end)) (then (local.set $ls (local.get $lb))))`
// entry address of the lane cursor's slot
const slotFromLane = (entrySize) =>
  `(local.set $slot (i32.add (local.get $off)
        (i32.mul (i32.shr_u (i32.sub (local.get $ls) (local.get $lb)) (i32.const 2)) (i32.const ${entrySize}))))`
// probe-loop locals shared by every template
const laneLocals = '(local $lb i32) (local $ls i32) (local $hw i32)'
// cap-tries exhausted with no remembered zombie: rescan for any TOMB key via
// the shared cold helper (an all-zombies-with-foreign-hashes table —
// durable-heal-heavy warm embedders only; the lane probe only notices zombies
// on a hash hit). $__zomb_scan falls back to slot 0 when the table is truly
// full of live keys, which the 75%-load grow makes unreachable.
const zombieRescan = (entrySize) => `(if (i32.eqz (local.get $zb)) (then
            (local.set $zb (call $__zomb_scan (local.get $off) (local.get $cap) (i32.const ${entrySize})))
            (local.set $zbl (i32.add (local.get $lb)
              (i32.shl (i32.div_u (i32.sub (local.get $zb) (local.get $off)) (i32.const ${entrySize})) (i32.const 2))))))`

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
    ;; Grow at 75% load (size*4 >= cap*3): 2× table, rehash, forward-mark old header.
    (if (i32.ge_s (i32.mul (local.get $size) (i32.const 4)) (i32.mul (local.get $cap) (i32.const 3)))
      (then
        (local.set $newcap (i32.shl (local.get $cap) (i32.const 1)))
        (local.set $newptr (call $__alloc_hdr_n (i32.const 0) (local.get $newcap) (i32.const ${entrySize + LANE})))
        (local.set $nlb (i32.add (local.get $newptr) (i32.mul (local.get $newcap) (i32.const ${entrySize}))))
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
              (i32.store (i32.add (local.get $nlb) (i32.shl (local.get $newidx) (i32.const 2))) (local.get $h))
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
    ;; zombie-aware LANE probe (durable-slot heal, TOMB_NAN keys): a zombie keeps
    ;; its stale hash in the lane, so it is only NOTICED on a hash hit (key reads
    ;; TOMB) — reuse still catches the dominant re-insert-same-key case, and the
    ;; cap-tries fallback rescans for any zombie before giving up.
    (block $done (loop $probe
      (local.set $hw (i32.load (local.get $ls)))
      (if (i32.eqz (local.get $hw))
        (then
          (if (local.get $zb)
            (then (local.set $slot (local.get $zb)) (local.set $ls (local.get $zbl)))
            (else ${slotFromLane(entrySize)}))
          ${seqStore}
          (i32.store (local.get $ls) (local.get $h))
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${durableEntryLogIR('slot', 'off')}${storeVal}
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromLane(entrySize)}
          (if (i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (i64.const ${TOMB_NAN}))
            (then (if (i32.eqz (local.get $zb))
              (then (local.set $zb (local.get $slot)) (local.set $zbl (local.get $ls)))))
            (else (if ${eqExpr} ${onMatch})))))
      ${probeNext()}
      (local.set $ztr (i32.add (local.get $ztr) (i32.const 1)))
      (if (i32.ge_s (local.get $ztr) (local.get $cap))
        (then
          ${zombieRescan(entrySize)}
          (local.set $slot (local.get $zb))
          (local.set $ls (local.get $zbl))
          ${seqStore}
          (i32.store (local.get $ls) (local.get $h))
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
      (local.set $hw (i32.load (local.get $ls)))
      (if (i32.eqz (local.get $hw)) (then ${onEmpty}))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromLane(entrySize)}
          (if ${eqExpr} (then ${onFound}))))
      ${probeNext()}
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
        (local.set $hw (i32.load (local.get $ls)))
        (if (i32.eqz (local.get $hw)) (then (br $absent)))
        (if (i32.eq (local.get $hw) (local.get $h))
          (then
            ${slotFromLane(entrySize)}
            (if ${eqExpr} (then (br $found)))))
        ${probeNext()}
        (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
        (br_if $absent (i32.ge_s (local.get $tries) (local.get $cap)))
        (br $probe)))
      (return (i32.const 0)))
    ;; $slot holds the entry to remove ($ls its lane word). Walk forward; move back
    ;; any entry whose home is not cyclically within (i, j], else it would become
    ;; unreachable from its home. The lane word travels with each moved entry.
    (local.set $i (local.get $slot))
    (local.set $j (local.get $slot))
    (local.set $li (local.get $ls))
    (local.set $lj (local.get $ls))
    (block $stop (loop $shift
      (local.set $j (i32.add (local.get $j) (i32.const ${entrySize})))
      (local.set $lj (i32.add (local.get $lj) (i32.const 4)))
      (if (i32.ge_u (local.get $lj) (local.get $end))
        (then (local.set $j (local.get $off)) (local.set $lj (local.get $lb))))
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
      (i32.store (local.get $li) (i32.load (local.get $lj)))
      (local.set $i (local.get $j))
      (local.set $li (local.get $lj))
      (br $shift)))
    (i64.store (local.get $i) (i64.const 0))
    (i64.store (i32.add (local.get $i) (i32.const 8)) (i64.const 0))
    (i32.store (local.get $li) (i32.const 0))
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
        (local.set $newcap (i32.shl (local.get $cap) (i32.const 1)))
        (local.set $newptr (call $__alloc_hdr_n (i32.const 0) (local.get $newcap) (i32.const ${entrySize + LANE})))
        (local.set $nlb (i32.add (local.get $newptr) (i32.mul (local.get $newcap) (i32.const ${entrySize}))))
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
              (i32.store (i32.add (local.get $nlb) (i32.shl (local.get $newidx) (i32.const 2))) (local.get $h))
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
    ;; zombie-aware LANE probe (durable-slot heal, TOMB_NAN keys) — see genUpsert.
    (block $done (loop $probe
      (local.set $hw (i32.load (local.get $ls)))
      (if (i32.eqz (local.get $hw))
        (then
          (if (local.get $zb)
            (then (local.set $slot (local.get $zb)) (local.set $ls (local.get $zbl)))
            (else ${slotFromLane(entrySize)}))
          ${seqStore}
          (i32.store (local.get $ls) (local.get $h))
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
              (then (local.set $zb (local.get $slot)) (local.set $zbl (local.get $ls)))))
            (else (if ${eqExpr}
              (then
                (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))${durableSlotLogIR('slot', 16, 'val')}
                (br $done)))))))
      ${probeNext()}
      (local.set $ztr (i32.add (local.get $ztr) (i32.const 1)))
      (if (i32.ge_s (local.get $ztr) (local.get $cap))
        (then
          ${zombieRescan(entrySize)}
          (local.set $slot (local.get $zb))
          (local.set $ls (local.get $zbl))
          ${seqStore}
          (i32.store (local.get $ls) (local.get $h))
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
        (local.set $newcap (i32.shl (local.get $cap) (i32.const 1)))
        (local.set $newptr (call $__alloc_hdr_n (i32.const 0) (local.get $newcap) (i32.const ${entrySize + LANE})))
        (local.set $nlb (i32.add (local.get $newptr) (i32.mul (local.get $newcap) (i32.const ${entrySize}))))
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
              (i32.store (i32.add (local.get $nlb) (i32.shl (local.get $newidx) (i32.const 2))) (local.get $h))
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
      (local.set $hw (i32.load (local.get $ls)))
      (if (i32.eqz (local.get $hw))
        (then
          (if (local.get $zb)
            (then (local.set $slot (local.get $zb)) (local.set $ls (local.get $zbl)))
            (else ${slotFromLane(entrySize)}))
          ${seqStore}
          (i32.store (local.get $ls) (local.get $h))
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
              (then (local.set $zb (local.get $slot)) (local.set $zbl (local.get $ls)))))
            (else (if ${eqExpr} (then (br $done)))))))
      ${probeNext()}
      (local.set $ztr (i32.add (local.get $ztr) (i32.const 1)))
      (if (i32.ge_s (local.get $ztr) (local.get $cap))
        (then
          ${zombieRescan(entrySize)}
          (local.set $slot (local.get $zb))
          (local.set $ls (local.get $zbl))
          ${seqStore}
          (i32.store (local.get $ls) (local.get $h))
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${durableEntryLogIR('slot', 'off')}
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (i64.const ${UNDEF_NAN}))
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
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
      (local.set $hw (i32.load (local.get $ls)))
      (if (i32.eqz (local.get $hw))
        (then (return (i64.const ${missing}))))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromLane(entrySize)}
          (if ${eqExpr}
            (then (return (i64.load (i32.add (local.get $slot) (i32.const 16))))))))
      ${probeNext()}
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
      (local.set $hw (i32.load (local.get $ls)))
      (if (i32.eqz (local.get $hw)) (then ${onEmpty}))
      (if (i32.eq (local.get $hw) (local.get $h))
        (then
          ${slotFromLane(entrySize)}
          (if ${eqExpr} (then ${onFound}))))
      ${probeNext()}
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    ${notFound})`
}

function genUpsertStrictPrehashed(name, entrySize, eqExpr, expectedType) {
  return `(func $${name} (param $obj i64) (param $key i64) (param $h i32) (param $val i64) (result i64)
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
    ;; zombie-aware LANE probe (durable-slot heal, TOMB_NAN keys) — see genUpsert.
    (block $done (loop $probe
      (local.set $hw (i32.load (local.get $ls)))
      (if (i32.eqz (local.get $hw))
        (then
          (if (local.get $zb)
            (then (local.set $slot (local.get $zb)) (local.set $ls (local.get $zbl)))
            (else ${slotFromLane(entrySize)}))
          ${seqStore}
          (i32.store (local.get $ls) (local.get $h))
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
              (then (local.set $zb (local.get $slot)) (local.set $zbl (local.get $ls)))))
            (else (if ${eqExpr}
              (then
                (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))${durableSlotLogIR('slot', 16, 'val')}
                (br $done)))))))
      ${probeNext()}
      (local.set $ztr (i32.add (local.get $ztr) (i32.const 1)))
      (if (i32.ge_s (local.get $ztr) (local.get $cap))
        (then
          ${zombieRescan(entrySize)}
          (local.set $slot (local.get $zb))
          (local.set $ls (local.get $zbl))
          ${seqStore}
          (i32.store (local.get $ls) (local.get $h))
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${durableEntryLogIR('slot', 'off')}
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))${durableSlotLogIR('slot', 16, 'val')}
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (br $probe)))
    (local.get $obj))`
}


export default (ctx) => {
  // Feature-gated deps: EXTERNAL-dependent symbols are only pulled when features.external.
  // Evaluated lazily at resolveIncludes() time — after emission has finalized ctx.features.
  const ifExt = (name) => () => ctx.features.external ? [name] : []
  // Whether durableFwdLogIR emits a real call (vs '' — see its own comment): only when
  // __heap_reset exists (owned-memory builds; shared memory never declares it — core.js).
  // Gates the deps() edges below the SAME way, so a shared-memory build (where core.js
  // never registers __durable_fwd_log/__durable_fwd_heal) never requests a name nothing
  // delivers.
  const needsDurableFwdLog = () => ctx.scope.globals.has('__heap_reset')
  // durableSlotLogIR's call pair, gated identically (see its comment): every helper
  // that stores a VALUE into a collection slot may log a durable-slot write.
  const slotLogDeps = () => needsDurableFwdLog() ? ['__durable_slot_log', '__is_eph_bits'] : []
  deps({
    __same_value_zero: ['__str_eq'],
    __map_hash: ['__hash', '__str_hash'],
    // '__durable_fwd_log' on __set_add/__map_set/__hash_set/__hash_set_local: an
    // EXPLICIT edge, not left to the auto-dep scan — genUpsert/genUpsertGrow's
    // `forward` branch always contains a durableFwdLogIR() call, but self-host's
    // realize/regex-scan auto-deps path silently drops a helper reachable only that
    // way (the "Unknown func $__clamp_idx" shape documented in
    // test/selfhost-includes.js) — that test would fail (and the kernel would trap)
    // without these edges.
    // slotLogDeps: hasVal=false skips the VALUE slot-log, but the ENTRY-insert
    // log (durableEntryLogIR) still calls $__durable_slot_log — without the
    // explicit edge the kernel leg drops the helper (auto-scan divergence, the
    // selfhost-includes class) and every `new Set(...)` fails to compile there.
    __set_add: () => [...(ctx.features.external ? ['__map_hash', '__same_value_zero', '__ptr_offset', '__ptr_offset_fwd', '__alloc_hdr_n', '__zomb_scan', '__ext_set'] : ['__map_hash', '__same_value_zero', '__ptr_offset', '__ptr_offset_fwd', '__alloc_hdr_n', '__zomb_scan']), ...(needsDurableFwdLog() ? ['__durable_fwd_log'] : []), ...slotLogDeps()],
    __set_has: () => ctx.features.external ? ['__map_hash', '__same_value_zero', '__ptr_offset', '__ptr_offset_fwd', '__ext_has'] : ['__map_hash', '__same_value_zero', '__ptr_offset', '__ptr_offset_fwd'],
    __set_delete: ['__map_hash', '__same_value_zero'],
    __set_add_all: ['__ptr_offset', '__ptr_offset_fwd', '__cap', '__len', '__coll_order', '__set_add'],
    __set_filter: ['__ptr_offset', '__ptr_offset_fwd', '__cap', '__len', '__coll_order', '__set_add', '__set_has', '__map_has'],
    __set_all: ['__ptr_offset', '__ptr_offset_fwd', '__cap', '__len', '__coll_order', '__set_has', '__map_has'],
    __sclone: ['__sclone_rec', '__mkptr', '__alloc_hdr_n'],
    __sclone_rec: ['__ptr_type', '__ptr_offset', '__ptr_offset_fwd', '__ptr_aux', '__is_nullish', '__len', '__alloc', '__alloc_hdr_n', '__mkptr', '__map_get', '__map_set', '__set_add', '__coll_order', '__arr_from', '__obj_clone', '__sclone_hash_vals'],
    __sclone_hash_vals: ['__sclone_rec'],
    __map_set: () => [...(ctx.features.external ? ['__map_hash', '__same_value_zero', '__ptr_offset', '__ptr_offset_fwd', '__alloc_hdr_n', '__zomb_scan', '__ext_set'] : ['__map_hash', '__same_value_zero', '__ptr_offset', '__ptr_offset_fwd', '__alloc_hdr_n', '__zomb_scan']), ...(needsDurableFwdLog() ? ['__durable_fwd_log'] : []), ...slotLogDeps()],
    __map_get: () => ctx.features.external ? ['__ext_prop', '__map_set', '__ptr_offset', '__ptr_offset_fwd'] : ['__map_set', '__ptr_offset', '__ptr_offset_fwd'],
    __map_get_h: () => ctx.features.external ? ['__ext_prop', '__same_value_zero', '__ptr_offset', '__ptr_offset_fwd'] : ['__same_value_zero', '__ptr_offset', '__ptr_offset_fwd'],
    __map_has: () => ctx.features.external ? ['__map_hash', '__same_value_zero', '__ptr_offset', '__ptr_offset_fwd', '__ext_has'] : ['__map_hash', '__same_value_zero', '__ptr_offset', '__ptr_offset_fwd'],
    // Prehashed has-probes: caller folds the hash, so no __map_hash dependency.
    __map_has_h: () => ctx.features.external ? ['__same_value_zero', '__ptr_offset', '__ptr_offset_fwd', '__ext_has'] : ['__same_value_zero', '__ptr_offset', '__ptr_offset_fwd'],
    __set_has_h: () => ctx.features.external ? ['__same_value_zero', '__ptr_offset', '__ptr_offset_fwd', '__ext_has'] : ['__same_value_zero', '__ptr_offset', '__ptr_offset_fwd'],
    __map_delete: ['__map_hash', '__same_value_zero'],
    __map_from: ['__ptr_type', '__ptr_offset', '__ptr_offset_fwd', '__len', '__typed_idx', '__map_set', '__mkptr', '__alloc_hdr_n', '__coll_order'],
    // own edge: __map_new's body calls $__alloc_hdr_n — auto-scan-only
    // reachability vanishes under self-host (test/selfhost-includes.js)
    __map_new: ['__alloc_hdr_n'],
    __hash_set: () => [
      ...(ctx.features.external ? ['__str_hash', '__str_eq', '__ptr_type', '__ext_set', '__dyn_set'] : ['__str_hash', '__str_eq', '__ptr_type', '__dyn_set']),
      '__zomb_scan',
      ...(needsDurableFwdLog() ? ['__durable_fwd_log'] : []),
      ...slotLogDeps(),
    ],
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
    __hash_set_local_h: () => ['__str_eq', '__zomb_scan', ...slotLogDeps()],
    __hash_set_local: () => ['__str_hash', '__str_eq', '__alloc_hdr_n', '__mkptr', '__zomb_scan', ...(needsDurableFwdLog() ? ['__durable_fwd_log'] : []), ...slotLogDeps()],
    __hash_slot: () => ['__str_hash', '__str_eq', '__alloc_hdr_n', '__ptr_type', '__ptr_offset', '__ptr_offset_fwd', '__zomb_scan', ...(needsDurableFwdLog() ? ['__durable_fwd_log'] : []), ...slotLogDeps()],
    __slot_write: () => slotLogDeps(),
    __ihash_get_local: ['__map_hash'],
    __ihash_set_local: () => ['__map_hash', '__alloc_hdr_n', '__mkptr', '__zomb_scan', ...slotLogDeps()],
    __dyn_get_t: ['__dyn_get_t_h', '__str_hash', '__is_str_key', '__to_str'],
    __dyn_get_t_h: ['__ihash_get_local', '__str_eq', '__is_nullish', '__hash_get_local_h', '__str_arr_idx', '__str_byteLen'],
    __dyn_get: ['__dyn_get_t', '__ptr_type'],
    __dyn_get_expr_t: ['__dyn_get_t', '__hash_get_local', '__is_str_key', '__to_str', '__ptr_offset', '__ptr_offset_fwd'],
    __dyn_get_expr_t_h: ['__dyn_get_t_h', '__hash_get_local_h'],
    __dyn_get_expr: ['__dyn_get_expr_t', '__ptr_type'],
    __dyn_get_any: ['__dyn_get_any_t', '__ptr_type'],
    __dyn_get_any_t: () => ctx.features.external
      ? ['__dyn_get_t', '__hash_get_local', '__ext_prop', '__is_str_key', '__to_str', '__ptr_offset', '__ptr_offset_fwd']
      : ['__dyn_get_t', '__hash_get_local', '__is_str_key', '__to_str', '__ptr_offset', '__ptr_offset_fwd'],
    __dyn_get_any_t_h: () => ctx.features.external
      ? ['__dyn_get_t_h', '__hash_get_local_h', '__ext_prop']
      : ['__dyn_get_t_h', '__hash_get_local_h'],
    __dyn_get_or: ['__dyn_get'],
    __dyn_set: ['__hash_new', '__hash_new_small', '__ihash_get_local', '__ihash_set_local', '__hash_set_local', '__ptr_offset', '__ptr_offset_fwd', '__is_nullish', '__str_eq', '__is_str_key', '__to_str', '__arr_set_idx_ptr', '__str_arr_idx'],
    __dyn_move: ['__ihash_get_local', '__ihash_set_local', '__is_nullish'],
    __hash_del_local: ['__str_hash', '__str_eq', '__ptr_type'],
    __dyn_del: ['__hash_del_local', '__ihash_get_local', '__is_nullish', '__is_str_key', '__to_str', '__str_arr_idx'],
    __str_arr_idx: ['__str_byteLen', '__char_at'],
    __coll_clear: ['__ptr_type', '__ptr_offset', '__ptr_offset_fwd'],
  })

  inc('__ptr_offset', '__ptr_offset_fwd', '__cap')

  // Monotonic insertion counter packed into each entry's hash-word high 32 bits
  // (see seqStore). Restores JS insertion order at iteration without growing
  // entries or touching the lookup/delete hot paths. i32: wraps after 2^32 total
  // inserts — unreachable in practice; fresh per wasm instance.
  if (!ctx.scope.globals.has('__seq'))
    declGlobal('__seq', 'i32')

  // for-in enum cache (core.js __hash_keys_ro): cached boxed key array keyed by
  // (table off, live len). Declared here unconditionally — genDelete's HASH
  // invalidation hook references $__enumc_off in its static WAT text, so the
  // global must exist in any build that reaches __hash_del_local, for-in or not
  // (same pattern as __seq/__dyn_props above; watr treeshakes them when unused).
  if (!ctx.scope.globals.has('__enumc_off')) {
    declGlobal('__enumc_off', 'i32')
    declGlobal('__enumc_len', 'i32')
    declGlobal('__enumc_arr', 'f64')
  }

  if (!ctx.scope.globals.has('__dyn_props'))
    declGlobal('__dyn_props', 'f64')
  // Never-false-negative membership filter over offsets ever inserted into the
  // global __dyn_props table: a 64-bit bitset, bit = mix(off) & 63 for every
  // offset key ever written there (see dynPropsFilterSetIR — all 3 insert
  // sites: __dyn_set's global-table fallback, __dyn_move's own rekey, and
  // array.js's headerPropsToGlobalIR). Probe sites (__dyn_move, __dyn_del's
  // global fallback) test the bit first and skip the __ihash_get_local probe
  // on a clear bit — sound because misses are never possible (bits are only
  // ever set, never cleared; a false positive just falls through to the real
  // probe). __dyn_props itself is never reset by __clear (see core.js), so
  // this filter doesn't need resetting either.
  if (!ctx.scope.globals.has('__dyn_props_filter'))
    declGlobal('__dyn_props_filter', 'i64')
  // 1-slot inline cache for the global __dyn_props lookup. Hot path for
  // metacircular workloads (watr WAT parser): ~96% of execution sits in
  // __dyn_get_t / __ihash_get_local. Caches last-seen (off → propsPtr) at
  // the top of __dyn_get_t; invalidated by __dyn_set when the same off's
  // propsPtr is replaced (rehash on grow). Sentinel cache_off = -1 cannot
  // collide with a real memory offset (always non-negative i32).
  if (!ctx.scope.globals.has('__dyn_get_cache_off'))
    declGlobal('__dyn_get_cache_off', 'i32', -1)
  if (!ctx.scope.globals.has('__dyn_get_cache_props'))
    declGlobal('__dyn_get_cache_props', 'f64')
  // Schema name table for __dyn_get's OBJECT-schema fallback (polymorphic-receiver
  // `.prop` access). Same declaration as json.js — defined here too so collection
  // doesn't transitively require json. compile.js's schemaInit populates it when
  // schema list is non-empty AND (__stringify OR __dyn_get) is included.
  if (!ctx.scope.globals.has('__schema_tbl'))
    declGlobal('__schema_tbl', 'i32')

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
      (call $__alloc_hdr_n (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY + LANE}))))`

  // === Set ===

  ctx.core.emit['new.Set'] = (iterExpr) => {
    ctx.features.set = true
    if (iterExpr == null) {
      const out = allocPtr({ type: PTR.SET, len: 0, cap: INIT_CAP, stride: SET_ENTRY + LANE, tag: 'set' })
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
    const out = allocPtr({ type: PTR.SET, len: 0, cap: capExpr, stride: SET_ENTRY + LANE, tag: 'set' })
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
  // `h` (optional precomputed key hash) appends to the call → routes to the `_h` prehashed
  // probes, skipping __map_hash per access; omitted → the generic hashing probes.
  const collProbeDyn = (mapFn, setFn) => (collExpr, key, h) => {
    inc(mapFn, setFn, '__ptr_type')
    const o = temp('cp'), k = tempI64('cpk')
    const extra = h != null ? [['i32.const', h]] : []
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${o}`, asF64(emit(collExpr))],
      ['local.set', `$${k}`, asI64(emit(key))],
      ['f64.convert_i32_s', ['if', ['result', 'i32'],
        ptrTypeEq(['local.get', `$${o}`], PTR.MAP),
        ['then', ['call', `$${mapFn}`, ['i64.reinterpret_f64', ['local.get', `$${o}`]], ['local.get', `$${k}`], ...extra]],
        ['else', ['call', `$${setFn}`, ['i64.reinterpret_f64', ['local.get', `$${o}`]], ['local.get', `$${k}`], ...extra]]]]], 'f64')
  }
  // `.has` on an unproven receiver: a literal key folds its hash and uses the _h probes.
  ctx.core.emit['.has'] = (collExpr, key) => {
    const h = litKeyHash(key)
    return h != null
      ? collProbeDyn('__map_has_h', '__set_has_h')(collExpr, key, h)
      : collProbeDyn('__map_has', '__set_has')(collExpr, key)
  }
  ctx.core.emit['.delete'] = collProbeDyn('__map_delete', '__set_delete')
  // Typed Set.has: literal key → prehashed __set_has_h, else the generic probe.
  ctx.core.emit[`.${VAL.SET}:has`] = (collExpr, key) => {
    const h = litKeyHash(key)
    if (h == null) return call('__set_has', 'II', 'i32')(collExpr, key)
    inc('__set_has_h')
    return typed(['f64.convert_i32_s', ['call', '$__set_has_h', asI64(emit(collExpr)), asI64(emit(key)), ['i32.const', h]]], 'f64')
  }
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
            (i32.add (i32.const ${SET_ENTRY + LANE})
              (i32.shl (i32.eq (local.get $t) (i32.const ${PTR.MAP})) (i32.const 3)))))
        (i32.store (i32.sub (local.get $off) (i32.const 8)) (i32.const 0))))
    (f64.reinterpret_i64 (i64.const ${UNDEF_NAN})))`

  // `.size` on a PROVEN Set/Map: entry count at off-8, direct __len.
  const sizeLen = (expr) => {
    inc('__len')
    return typed(['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', asF64(emit(expr))]]], 'f64')
  }
  registerGetter(`.${VAL.SET}:size`, sizeLen)
  registerGetter(`.${VAL.MAP}:size`, sizeLen)
  // `.size` on an unproven receiver: in JS only Set/Map expose an entry count —
  // on everything else `size` is an ordinary own property (or undefined). The
  // old bare-__len form read the length HEADER of whatever arrived, silently
  // returning 0 for `{size: 4}` — which broke the self-host kernel reading
  // `ctx.runtime.internTable.size` (the last L2 byte-parity divergence).
  // NaN-check guards real numbers whose bit pattern could false-match the tag
  // compare; the dyn dispatcher covers OBJECT schema slots, HASH keys,
  // sidecars, and primitives (→ undefined).
  registerGetter('.size', (expr) => {
    inc('__len', '__ptr_type', '__dyn_get_expr_t_h')
    const o = temp('szv')
    const t = tempI32('szt')
    const og = ['local.get', `$${o}`]
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${o}`, asF64(emit(expr))],
      ['local.set', `$${t}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', og]]],
      ['if', ['result', 'f64'],
        ['i32.and',
          ['f64.ne', og, og],
          ['i32.or',
            ['i32.eq', ['local.get', `$${t}`], ['i32.const', PTR.SET]],
            ['i32.eq', ['local.get', `$${t}`], ['i32.const', PTR.MAP]]]],
        ['then', ['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', og]]]],
        ['else', ['f64.reinterpret_i64', ['call', '$__dyn_get_expr_t_h',
          ['i64.reinterpret_f64', og], asI64(emit(['str', 'size'])), ['local.get', `$${t}`],
          ['i32.const', strHashLiteral('size')]]]]]], 'f64')
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
  ctx.core.stdlib['__set_add'] = () => genUpsert('__set_add', SET_ENTRY, '$__map_hash', sameValueZeroEqG, PTR.SET, false, ctx.features.external)
  ctx.core.stdlib['__set_has'] = () => genLookup('__set_has', SET_ENTRY, '$__map_hash', sameValueZeroEqG, PTR.SET, false, ctx.features.external)
  ctx.core.stdlib['__set_has_h'] = () => genLookupStrictPrehashed('__set_has_h', SET_ENTRY, sameValueZeroEqG, PTR.SET, UNDEF_NAN, ctx.features.external, false)
  ctx.core.stdlib['__set_delete'] = genDelete('__set_delete', SET_ENTRY, '$__map_hash', sameValueZeroEqG, PTR.SET)

  // ES2025 Set algebra (union/intersection/difference/symmetricDifference +
  // isSubsetOf/isSupersetOf/isDisjointFrom). Three shared walkers over the
  // receiver's insertion order (__coll_order — result order is spec-exact); an
  // `other` that is not a real Set/Map is treated as empty (__set_has/__map_has
  // type-guard a wrong receiver to 0), the native-litmus line (a proven Set or
  // Map is in-model; an arbitrary set-like is not, no .has/.keys dispatch).
  // __set_add's SameValueZero dedup + insertion-seq stamping make add-order the
  // result order for free.
  // $stride is the src collection's entry stride (SET_ENTRY for a Set, MAP_ENTRY
  // for a Map) — a Map's keys sit at slot+8 too, so a Map `other` iterates as a
  // key set. The key is always at slot+8 in both layouts.
  const setWalkPreamble = `(local $off i32) (local $cap i32) (local $n i32) (local $ord i32) (local $i i32) (local $slot i32) (local $key i64) (local $has i32)
    (local.set $off (call $__ptr_offset (local.get $src)))
    (local.set $cap (call $__cap (local.get $src)))
    (local.set $n (call $__len (local.get $src)))
    (local.set $ord (call $__coll_order (local.get $off) (local.get $cap) (local.get $stride)))`
  const setWalkKey = `(local.set $slot (i32.load (i32.add (local.get $ord) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $key (i64.load (i32.add (local.get $slot) (i32.const 8))))`
  const otherHas = `(if (result i32) (local.get $otherIsMap)
        (then (call $__map_has (local.get $other) (local.get $key)))
        (else (call $__set_has (local.get $other) (local.get $key))))`
  // dst ← dst ∪ src (add every src key in insertion order).
  ctx.core.stdlib['__set_add_all'] = `(func $__set_add_all (param $dst i64) (param $src i64) (param $stride i32) (result i64)
    ${setWalkPreamble}
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $n)))
      ${setWalkKey}
      (local.set $dst (call $__set_add (local.get $dst) (local.get $key)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (local.get $dst))`
  // For each src key, add to dst iff (other has key) == keep. keep=1 → intersection;
  // keep=0 → difference / symmetricDifference pass.
  ctx.core.stdlib['__set_filter'] = `(func $__set_filter (param $dst i64) (param $src i64) (param $stride i32) (param $other i64) (param $otherIsMap i32) (param $keep i32) (result i64)
    ${setWalkPreamble}
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $n)))
      ${setWalkKey}
      (local.set $has ${otherHas})
      (if (i32.eq (local.get $has) (local.get $keep))
        (then (local.set $dst (call $__set_add (local.get $dst) (local.get $key)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (local.get $dst))`
  // Predicate: return 0 as soon as any src key's presence in other != want; else 1.
  // isSubsetOf(A,B) = all(A, B, want=1); isDisjointFrom(A,B) = all(A, B, want=0).
  ctx.core.stdlib['__set_all'] = `(func $__set_all (param $src i64) (param $stride i32) (param $other i64) (param $otherIsMap i32) (param $want i32) (result i32)
    ${setWalkPreamble}
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $n)))
      ${setWalkKey}
      (local.set $has ${otherHas})
      (if (i32.ne (local.get $has) (local.get $want)) (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (i32.const 1))`

  // === Map ===

  ctx.core.emit['new.Map'] = (iterExpr) => {
    ctx.features.map = true
    if (iterExpr == null) {
      const out = allocPtr({ type: PTR.MAP, len: 0, cap: INIT_CAP, stride: MAP_ENTRY + LANE, tag: 'map' })
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
    // Keys and values are boxed-value slots — booleans cross as their atom so
    // set(true, …)/get(true) agree on bits and stored values keep identity.
    const value = val === undefined ? asI64(undefExpr()) : asI64(carrierF64(val, emit(val)))
    return typed(['f64.reinterpret_i64', ['call', '$__map_set', asI64(emit(mapExpr)), asI64(carrierF64(key, emit(key))), value]], 'f64')
  }
  ctx.core.emit[`.${VAL.MAP}:set`] = ctx.core.emit['.set']

  const emitMapGet = (mapExpr, key) => {
    const h = litKeyHash(key)
    if (h != null) {
      inc('__map_get_h')
      return typed(['f64.reinterpret_i64', ['call', '$__map_get_h', asI64(emit(mapExpr)), asI64(emit(key)), ['i32.const', h]]], 'f64')
    }
    inc('__map_get')
    // Key is a boxed-value slot — a bool key probes with the same atom bits .set stored.
    return typed(['f64.reinterpret_i64', ['call', '$__map_get', asI64(emit(mapExpr)), asI64(carrierF64(key, emit(key)))]], 'f64')
  }

  ctx.core.emit['.get'] = emitMapGet
  ctx.core.emit[`.${VAL.MAP}:get`] = emitMapGet

  // Typed Map.has: literal key → prehashed __map_has_h, else the generic probe.
  ctx.core.emit[`.${VAL.MAP}:has`] = (collExpr, key) => {
    const h = litKeyHash(key)
    if (h == null) return call('__map_has', 'II', 'i32')(collExpr, key)
    inc('__map_has_h')
    return typed(['f64.convert_i32_s', ['call', '$__map_has_h', asI64(emit(collExpr)), asI64(emit(key)), ['i32.const', h]]], 'f64')
  }
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
  // A typed array (PTR.TYPED) is NOT PTR.ARRAY, so without an explicit branch it fell
  // through to `local.get $t` (return the receiver). For .values that is correct (the
  // receiver iterates its values), but .keys then yielded values instead of indices and
  // .entries yielded scalars instead of [i, value] pairs. The typedWalk arg restores the
  // right behavior for typed receivers (keys → index array, entries → typed-aware pairs).
  const collViewDyn = (mapWalk, setWalk, arrWalk, typedWalk) => (expr) => {
    inc('__ptr_type')
    const t = temp('cd')
    const pt = () => ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]
    const branch = (tag, walk, rest) =>
      ['if', ['result', 'f64'], ['i32.eq', pt(), ['i32.const', tag]], ['then', walk(t)], ['else', rest]]
    const tree = branch(PTR.MAP, mapWalk, branch(PTR.SET, setWalk,
      branch(PTR.ARRAY, arrWalk, branch(PTR.TYPED, typedWalk, ['local.get', `$${t}`]))))
    return typed(['block', ['result', 'f64'], ['local.set', `$${t}`, asF64(emit(expr))], tree], 'f64')
  }
  // keys: index array [0..len-1] for both plain and typed (length-based, no element reads).
  ctx.core.emit['.keys'] = collViewDyn(
    t => collKeysFromTemp(t, MAP_ENTRY, 8), t => collKeysFromTemp(t, SET_ENTRY, 8), arrIdxFromTemp, arrIdxFromTemp)
  // values: the receiver iterates its own elements (correct for plain and typed alike).
  ctx.core.emit['.values'] = collViewDyn(
    t => collKeysFromTemp(t, MAP_ENTRY, 16), t => collKeysFromTemp(t, SET_ENTRY, 8), t => ['local.get', `$${t}`], t => ['local.get', `$${t}`])
  // entries: [i, element] pairs; the typed variant reads elements width/kind-aware.
  ctx.core.emit['.entries'] = collViewDyn(
    t => collEntriesFromTemp(t, MAP_ENTRY, 8, 16), t => collEntriesFromTemp(t, SET_ENTRY, 8, 8), arrEntriesFromTemp, arrEntriesFromTempTyped)

  // Map/Set forEach(cb): invoke cb(value, key) per live entry in insertion order.
  // Map yields (value=val@16, key=key@8); Set yields (value=key@8, key@8) — the
  // spec passes the element as both value and key. The trailing collection arg is
  // dropped (as array/typedarray forEach drop the array arg) so we never exceed
  // the uniform closure width (forEach autoloads array → closure floor 2). Uses
  // the closure-call path like typedarray:forEach — forEach isn't a hot path.
  const collForEach = (stride, valOff, keyOff) => (expr, fn) => {
    inc('__ptr_offset', '__ptr_offset_fwd', '__cap', '__len', '__coll_order')
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

  // === ES2025 Set algebra emitters ===
  // A = receiver (proven SET). `other` (B) may be a Set or Map at runtime; its
  // stride/probe-kind is resolved once via __ptr_type (a Map's keys are its key
  // set). Set-returning ops thread the fresh dst through the walker (forwarding
  // is transparent, but re-capture is defensively correct); predicates fold the
  // i32 result to a boolean carrier.
  const isMapRT = (f64) => ['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', f64]], ['i32.const', PTR.MAP]]
  const strideRT = (f64) => ['select', ['i32.const', MAP_ENTRY], ['i32.const', SET_ENTRY], isMapRT(f64)]
  const isMapI32 = (f64) => isMapRT(f64)  // 1 if Map, 0 otherwise
  // Evaluate A,B into temps; hand their f64 accessors to `body`, which returns
  // the block's final value node. resultType picks Set (f64) vs predicate (i32).
  const setBin = (a, b, resultType, body) => {
    inc('__ptr_type')
    const aT = temp('sopa'), bT = temp('sopb')
    const aF = typed(['local.get', `$${aT}`], 'f64'), bF = typed(['local.get', `$${bT}`], 'f64')
    return typed(['block', ['result', resultType],
      ['local.set', `$${aT}`, asF64(emit(a))],
      ['local.set', `$${bT}`, asF64(emit(b))],
      body(aF, bF)], resultType)
  }
  // Build the fresh-dst + threaded-walker-call sequence, returning the dst temp.
  const buildSet = (steps, tag) => {
    const dst = allocPtr({ type: PTR.SET, len: 0, cap: INIT_CAP, stride: SET_ENTRY + LANE, tag })
    const dstT = temp('sopd')
    const dI = () => ['i64.reinterpret_f64', ['local.get', `$${dstT}`]]
    const seq = ['block', ['result', 'f64'], dst.init, ['local.set', `$${dstT}`, dst.ptr]]
    for (const call of steps(dstT, dI)) seq.push(['local.set', `$${dstT}`, ['f64.reinterpret_i64', call]])
    seq.push(['local.get', `$${dstT}`])
    return seq
  }
  const addAll = (dI, srcF, strideIR) => ['call', '$__set_add_all', dI(), ['i64.reinterpret_f64', srcF], strideIR]
  const filterInto = (dI, srcF, strideIR, otherF, otherIsMap, keep) =>
    ['call', '$__set_filter', dI(), ['i64.reinterpret_f64', srcF], strideIR, ['i64.reinterpret_f64', otherF], otherIsMap, ['i32.const', keep]]
  const allMatch = (srcF, strideIR, otherF, otherIsMap, want) =>
    ['call', '$__set_all', ['i64.reinterpret_f64', srcF], strideIR, ['i64.reinterpret_f64', otherF], otherIsMap, ['i32.const', want]]

  ctx.core.emit['.set:union'] = (a, b) => { inc('__set_add_all')
    return setBin(a, b, 'f64', (aF, bF) => buildSet((dstT, dI) => [
      addAll(dI, aF, ['i32.const', SET_ENTRY]),
      addAll(dI, bF, strideRT(bF)),
    ], 'setu')) }

  ctx.core.emit['.set:intersection'] = (a, b) => { inc('__set_filter', '__len')
    // Walk the SMALLER operand (ties → `this`, A) for spec-exact result order.
    return setBin(a, b, 'f64', (aF, bF) => {
      const aLen = ['call', '$__len', ['i64.reinterpret_f64', aF]]
      const bLen = ['call', '$__len', ['i64.reinterpret_f64', bF]]
      const walkA = buildSet((dstT, dI) => [filterInto(dI, aF, ['i32.const', SET_ENTRY], bF, isMapI32(bF), 1)], 'seti')
      const walkB = buildSet((dstT, dI) => [filterInto(dI, bF, strideRT(bF), aF, ['i32.const', 0], 1)], 'seti')
      return ['if', ['result', 'f64'], ['i32.le_s', aLen, bLen], ['then', walkA], ['else', walkB]]
    }) }

  ctx.core.emit['.set:difference'] = (a, b) => { inc('__set_filter')
    // Always A's order (spec: iterate `this`, keep those NOT in other).
    return setBin(a, b, 'f64', (aF, bF) => buildSet((dstT, dI) => [
      filterInto(dI, aF, ['i32.const', SET_ENTRY], bF, isMapI32(bF), 0),
    ], 'setd')) }

  ctx.core.emit['.set:symmetricDifference'] = (a, b) => { inc('__set_filter')
    // (A not in B, A's order) then (B not in A, B's order).
    return setBin(a, b, 'f64', (aF, bF) => buildSet((dstT, dI) => [
      filterInto(dI, aF, ['i32.const', SET_ENTRY], bF, isMapI32(bF), 0),
      filterInto(dI, bF, strideRT(bF), aF, ['i32.const', 0], 0),
    ], 'setx')) }

  ctx.core.emit['.set:isSubsetOf'] = (a, b) => { inc('__set_all')
    // every key of A is in B
    return setBin(a, b, 'i32', (aF, bF) => allMatch(aF, ['i32.const', SET_ENTRY], bF, isMapI32(bF), 1)) }

  ctx.core.emit['.set:isSupersetOf'] = (a, b) => { inc('__set_all')
    // every key of B is in A (walk B; A is always a Set → otherIsMap=0)
    return setBin(a, b, 'i32', (aF, bF) => allMatch(bF, strideRT(bF), aF, ['i32.const', 0], 1)) }

  ctx.core.emit['.set:isDisjointFrom'] = (a, b) => { inc('__set_all')
    // no key of A is in B
    return setBin(a, b, 'i32', (aF, bF) => allMatch(aF, ['i32.const', SET_ENTRY], bF, isMapI32(bF), 0)) }

  // === ES2024 Object.groupBy / Map.groupBy ===
  // Both bucket items by cb(item, i): Object.groupBy keys a dictionary (HASH)
  // by ToPropertyKey → __to_str; Map.groupBy keys a Map by SameValueZero (raw
  // boxed value). Buckets are plain arrays appended in iteration order. The
  // source normalizes through __iter_arr (Array/String/TypedArray pass through,
  // Set→keys, Map→entries) and reads elements via the polymorphic __typed_idx.
  const emitGroupBy = (isMap) => (items, fn) => {
    inc('__iter_arr', '__len', '__typed_idx', '__arr_push1')
    inc(...(isMap ? ['__map_set', '__map_get'] : ['__hash_new', '__hash_set', '__hash_get', '__to_str']))
    const recv = temp('gbs'), cb = temp('gbc'), result = temp('gbr')
    const len = tempI32('gbl'), i = tempI32('gbi')
    const item = temp('gbv'), key = tempI64('gbk'), bucket = temp('gbb')
    const id = ctx.func.uniq++
    const resI64 = ['i64.reinterpret_f64', ['local.get', `$${result}`]]
    const nb = allocPtr({ type: PTR.ARRAY, len: 0, cap: 0, tag: 'gbn' })
    const initResult = isMap
      ? (() => { const out = allocPtr({ type: PTR.MAP, len: 0, cap: INIT_CAP, stride: MAP_ENTRY + LANE, tag: 'gbm' })
          return ['block', ['result', 'f64'], out.init, out.ptr] })()
      : ['call', '$__hash_new']
    const keyOf = (cbResult) => isMap ? asI64(cbResult) : ['call', '$__to_str', asI64(cbResult)]
    const get = isMap ? '$__map_get' : '$__hash_get'
    const set = isMap ? '$__map_set' : '$__hash_set'
    ctx.runtime.throws = true
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${recv}`, asF64(emit(['()', '__iter_arr', items]))],
      ['local.set', `$${cb}`, asF64(emit(fn))],
      // spec GroupBy step 2: IsCallable(callbackfn) — throw before iterating,
      // not an indirect-call trap mid-loop
      ['if', ['i32.eqz', ptrTypeEq(typed(['local.get', `$${cb}`], 'f64'), PTR.CLOSURE)],
        ['then', ['throw', '$__jz_err', ['f64.const', 0]]]],
      ['local.set', `$${result}`, initResult],
      ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${recv}`]]]],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$gbrk${id}`, ['loop', `$gloop${id}`,
        ['br_if', `$gbrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
        ['local.set', `$${item}`, ['call', '$__typed_idx', ['i64.reinterpret_f64', ['local.get', `$${recv}`]], ['local.get', `$${i}`]]],
        ['local.set', `$${key}`, keyOf(ctx.closure.call(typed(['local.get', `$${cb}`], 'f64'),
          [typed(['local.get', `$${item}`], 'f64'), typed(['f64.convert_i32_s', ['local.get', `$${i}`]], 'f64')]))],
        ['local.set', `$${bucket}`, ['f64.reinterpret_i64', ['call', get, resI64, ['local.get', `$${key}`]]]],
        // miss → fresh bucket, insert it (each distinct key allocates once)
        ['if', ['i64.eq', ['i64.reinterpret_f64', ['local.get', `$${bucket}`]], ['i64.const', UNDEF_NAN]],
          ['then',
            nb.init,
            ['local.set', `$${bucket}`, nb.ptr],
            ['local.set', `$${result}`, ['f64.reinterpret_i64',
              ['call', set, resI64, ['local.get', `$${key}`], ['i64.reinterpret_f64', ['local.get', `$${bucket}`]]]]]]],
        // push may relocate the bucket — re-store the (possibly moved) pointer
        ['local.set', `$${bucket}`, ['call', '$__arr_push1', ['i64.reinterpret_f64', ['local.get', `$${bucket}`]], typed(['local.get', `$${item}`], 'f64')]],
        ['local.set', `$${result}`, ['f64.reinterpret_i64',
          ['call', set, resI64, ['local.get', `$${key}`], ['i64.reinterpret_f64', ['local.get', `$${bucket}`]]]]],
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$gloop${id}`]]],
      ['local.get', `$${result}`]], 'f64')
  }
  ctx.core.emit['Object.groupBy'] = emitGroupBy(false)
  ctx.core.emit['Map.groupBy'] = emitGroupBy(true)

  // === structuredClone — deep arena clone ===
  // Walks the value graph copying every mutable container: arrays, schema
  // objects (incl. branded Dates), dictionary HASHes, Set/Map (insertion order
  // kept; Map keys AND values cloned, like the host), typed arrays, DataViews
  // and ArrayBuffers (a buffer shared by several views stays shared in the
  // clone). Numbers/atoms are immediate and strings immutable — passed through.
  // Closures and host handles raise (the host's DataCloneError). The `transfer`
  // option is out of model (arena memory has nothing to detach) and ignored.
  //
  // Identity memo: a real MAP keyed by boxed-pointer bits (SameValueZero on
  // non-string pointers ≡ bit identity) — cycles terminate, diamond sharing
  // dedupes. Every clone target is allocated at its final capacity, so no fill
  // can trigger a grow: memo'd pointers stay canonical and `===` identity
  // inside the cloned graph holds bit-exactly. The memo itself may grow, but
  // __map_set forward-marks, so a stale $memo in an outer frame still resolves.

  ctx.core.stdlib['__sclone'] = `(func $__sclone (param $v f64) (result f64)
    (call $__sclone_rec (local.get $v)
      (i64.reinterpret_f64 (call $__mkptr (i32.const ${PTR.MAP}) (i32.const 0)
        (call $__alloc_hdr_n (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY + LANE}))))))`

  // Deep-clone the values of a freshly copied HASH table, in place.
  ctx.core.stdlib['__sclone_hash_vals'] = `(func $__sclone_hash_vals (param $off i32) (param $memo i64)
    (local $cap i32) (local $i i32) (local $slot i32)
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $cap)))
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const ${MAP_ENTRY}))))
      (if (i32.and
            (i64.ne (i64.load (local.get $slot)) (i64.const 0))
            (i64.ne (i64.load (i32.add (local.get $slot) (i32.const 8))) (i64.const ${TOMB_NAN})))
        (then (i64.store (i32.add (local.get $slot) (i32.const 16))
          (i64.reinterpret_f64 (call $__sclone_rec
            (f64.reinterpret_i64 (i64.load (i32.add (local.get $slot) (i32.const 16))))
            (local.get $memo))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))`

  ctx.core.stdlib['__sclone_rec'] = () => {
    // Guarded: template expansion (pullStdlib) runs AFTER assemble's schema-table
    // build — an unconditional declGlobal would reset the freshly-baked init offset
    // back to 0 and every schema consumer would see an empty table.
    if (!ctx.scope.globals.has('__schema_tbl')) declGlobal('__schema_tbl', 'i32')
    return `(func $__sclone_rec (param $v f64) (param $memo i64) (result f64)
    (local $bits i64) (local $t i32) (local $hit i64) (local $out f64) (local $side i64)
    (local $src i32) (local $dst i32) (local $n i32) (local $cap i32) (local $i i32)
    (local $slot i32) (local $ord i32) (local $stride i32) (local $aux i32) (local $root i32) (local $newroot i32)
    ;; ordinary numbers (incl. ±Infinity) are immediate
    (if (f64.eq (local.get $v) (local.get $v)) (then (return (local.get $v))))
    (local.set $bits (i64.reinterpret_f64 (local.get $v)))
    ;; negative-NaN bit patterns are numeric NaN, never boxes
    (if (i64.eq (i64.and (local.get $bits) (i64.const 0xFFF0000000000000)) (i64.const 0xFFF0000000000000))
      (then (return (local.get $v))))
    (local.set $t (call $__ptr_type (local.get $bits)))
    ;; atoms (canonical NaN / undefined / null / booleans) + immutable strings: share
    (if (i32.or (i32.eq (local.get $t) (i32.const ${PTR.ATOM})) (i32.eq (local.get $t) (i32.const ${PTR.STRING})))
      (then (return (local.get $v))))
    ;; functions / host handles: DataCloneError
    (if (i32.or (i32.eq (local.get $t) (i32.const ${PTR.CLOSURE})) (i32.eq (local.get $t) (i32.const ${PTR.EXTERNAL})))
      (then (throw $__jz_err (f64.const 0))))
    ;; already cloned? (cycle / diamond sharing) — __map_get yields raw i64 bits
    (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
    (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))

    (if (i32.eq (local.get $t) (i32.const ${PTR.ARRAY}))
      (then
        (local.set $out (call $__arr_from (local.get $bits)))
        (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
        (local.set $dst (call $__ptr_offset (i64.reinterpret_f64 (local.get $out))))
        (local.set $n (call $__len (local.get $bits)))
        (block $ad (loop $al
          (br_if $ad (i32.ge_s (local.get $i) (local.get $n)))
          (local.set $slot (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 3))))
          (f64.store (local.get $slot) (call $__sclone_rec (f64.load (local.get $slot)) (local.get $memo)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $al)))
        (return (local.get $out))))

    (if (i32.eq (local.get $t) (i32.const ${PTR.OBJECT}))
      (then
        (local.set $out (call $__obj_clone (local.get $v)))
        (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
        ;; deep the schema slots — slot count via aux → schema table, like __obj_clone
        (if (i32.ne (global.get $__schema_tbl) (i32.const 0))
          (then (local.set $n (call $__len
            (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (call $__ptr_aux (local.get $bits)) (i32.const 3))))))))
        (local.set $dst (call $__ptr_offset (i64.reinterpret_f64 (local.get $out))))
        (block $od (loop $ol
          (br_if $od (i32.ge_s (local.get $i) (local.get $n)))
          (local.set $slot (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 3))))
          (f64.store (local.get $slot) (call $__sclone_rec (f64.load (local.get $slot)) (local.get $memo)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $ol)))
        ;; deep the dyn-props sidecar's values (__obj_clone already re-tabled it)
        (local.set $side (i64.load (i32.sub (local.get $dst) (i32.const 16))))
        (if (i32.eq (call $__ptr_type (local.get $side)) (i32.const ${PTR.HASH}))
          (then (call $__sclone_hash_vals (call $__ptr_offset (local.get $side)) (local.get $memo))))
        (return (local.get $out))))

    (if (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
      (then
        (local.set $out (call $__obj_clone (local.get $v)))
        (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
        (call $__sclone_hash_vals (call $__ptr_offset (i64.reinterpret_f64 (local.get $out))) (local.get $memo))
        (return (local.get $out))))

    (if (i32.or (i32.eq (local.get $t) (i32.const ${PTR.SET})) (i32.eq (local.get $t) (i32.const ${PTR.MAP})))
      (then
        (local.set $stride (select (i32.const ${MAP_ENTRY}) (i32.const ${SET_ENTRY}) (i32.eq (local.get $t) (i32.const ${PTR.MAP}))))
        (local.set $src (call $__ptr_offset (local.get $bits)))
        (local.set $cap (i32.load (i32.sub (local.get $src) (i32.const 4))))
        (local.set $out (call $__mkptr (local.get $t) (i32.const 0)
          (call $__alloc_hdr_n (i32.const 0) (local.get $cap) (i32.add (local.get $stride) (i32.const ${LANE})))))
        (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
        ;; walk the source in insertion order; ≤len inserts into cap slots never grow,
        ;; so $out's bits stay canonical (the memo entry above remains the pointer)
        (local.set $n (i32.load (i32.sub (local.get $src) (i32.const 8))))
        (local.set $ord (call $__coll_order (local.get $src) (local.get $cap) (local.get $stride)))
        (block $cd (loop $cl
          (br_if $cd (i32.ge_s (local.get $i) (local.get $n)))
          (local.set $slot (i32.load (i32.add (local.get $ord) (i32.shl (local.get $i) (i32.const 2)))))
          (if (i32.eq (local.get $t) (i32.const ${PTR.MAP}))
            (then (drop (call $__map_set (i64.reinterpret_f64 (local.get $out))
              (i64.reinterpret_f64 (call $__sclone_rec (f64.reinterpret_i64 (i64.load (i32.add (local.get $slot) (i32.const 8)))) (local.get $memo)))
              (i64.reinterpret_f64 (call $__sclone_rec (f64.reinterpret_i64 (i64.load (i32.add (local.get $slot) (i32.const 16)))) (local.get $memo))))))
            (else (drop (call $__set_add (i64.reinterpret_f64 (local.get $out))
              (i64.reinterpret_f64 (call $__sclone_rec (f64.reinterpret_i64 (i64.load (i32.add (local.get $slot) (i32.const 8)))) (local.get $memo)))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $cl)))
        (return (local.get $out))))

    (if (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
      (then
        (local.set $aux (call $__ptr_aux (local.get $bits)))
        (local.set $src (call $__ptr_offset (local.get $bits)))
        (if (i32.and (local.get $aux) (i32.const 8))
          (then
            ;; view: clone the root buffer once — memo'd as its boxed BUFFER value,
            ;; the exact key .buffer reconstructs — and rebase the descriptor
            (local.set $root (i32.load (i32.add (local.get $src) (i32.const 8))))
            (local.set $newroot (call $__ptr_offset (i64.reinterpret_f64
              (call $__sclone_rec (call $__mkptr (i32.const ${PTR.BUFFER}) (i32.const 0) (local.get $root)) (local.get $memo)))))
            (local.set $dst (call $__alloc (i32.const 16)))
            (i32.store (local.get $dst) (i32.load (local.get $src)))
            (i32.store (i32.add (local.get $dst) (i32.const 4))
              (i32.add (local.get $newroot) (i32.sub (i32.load (i32.add (local.get $src) (i32.const 4))) (local.get $root))))
            (i32.store (i32.add (local.get $dst) (i32.const 8)) (local.get $newroot))
            (i32.store (i32.add (local.get $dst) (i32.const 12)) (i32.const 0)))
          (else
            ;; owned storage: raw byte copy (header len is in bytes)
            (local.set $n (i32.load (i32.sub (local.get $src) (i32.const 8))))
            (local.set $dst (call $__alloc_hdr_n (local.get $n) (local.get $n) (i32.const 1)))
            (memory.copy (local.get $dst) (local.get $src) (local.get $n))))
        (local.set $out (call $__mkptr (i32.const ${PTR.TYPED}) (local.get $aux) (local.get $dst)))
        (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
        (return (local.get $out))))

    (if (i32.eq (local.get $t) (i32.const ${PTR.BUFFER}))
      (then
        (local.set $src (call $__ptr_offset (local.get $bits)))
        (local.set $n (i32.load (i32.sub (local.get $src) (i32.const 8))))
        (local.set $dst (call $__alloc_hdr_n (local.get $n) (local.get $n) (i32.const 1)))
        (memory.copy (local.get $dst) (local.get $src) (local.get $n))
        (local.set $out (call $__mkptr (i32.const ${PTR.BUFFER}) (i32.const 0) (local.get $dst)))
        (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
        (return (local.get $out))))

    ;; unrecognized tag — pass through
    (local.get $v))`
  }

  // structuredClone(value[, options]) — options.transfer ignored (see above).
  ctx.core.emit['structuredClone'] = (val, _opts) => {
    inc('__sclone')
    // __obj_clone/__sclone_rec read $__schema_tbl but only join includes via the
    // pullStdlib dep-closure — after assemble has already decided whether to build
    // the table. Flag the consumption explicitly (same hook as the enumeration
    // scaffolds), or every OBJECT clones as zero slots.
    ctx.runtime.schemaTblConsumed = true
    // carrierF64: a bare boolean arg rides as a 0/1 carrier — box it to the
    // TRUE/FALSE atom so the clone round-trips `true`, not the number 1.
    return typed(['call', '$__sclone', carrierF64(val, emit(val))], 'f64')
  }

  // Generated Map probe functions
  ctx.core.stdlib['__map_set'] = () => genUpsert('__map_set', MAP_ENTRY, '$__map_hash', sameValueZeroEqG, PTR.MAP, true, ctx.features.external)
  ctx.core.stdlib['__map_get'] = () => genLookup('__map_get', MAP_ENTRY, '$__map_hash', sameValueZeroEqG, PTR.MAP, true, ctx.features.external)
  ctx.core.stdlib['__map_get_h'] = () => genLookupStrictPrehashed('__map_get_h', MAP_ENTRY, sameValueZeroEqG, PTR.MAP, UNDEF_NAN, ctx.features.external)
  ctx.core.stdlib['__map_has_h'] = () => genLookupStrictPrehashed('__map_has_h', MAP_ENTRY, sameValueZeroEqG, PTR.MAP, UNDEF_NAN, ctx.features.external, false)
  ctx.core.stdlib['__map_has'] = () => genLookup('__map_has', MAP_ENTRY, '$__map_hash', sameValueZeroEqG, PTR.MAP, false, ctx.features.external)
  ctx.core.stdlib['__map_delete'] = genDelete('__map_delete', MAP_ENTRY, '$__map_hash', sameValueZeroEqG, PTR.MAP)

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
      (call $__alloc_hdr_n (i32.const 0) (local.get $newcap) (i32.const ${MAP_ENTRY + LANE})))))
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

  // SSO branch: fixed 7-op avalanche mix over the packed NaN-box lo/hi, replacing the
  // old 6-iteration per-char FNV loop (~36 ops worst case). lo = payload bits 0-31
  // (the $off field, which for an SSO ptr IS the packed chars 0-3 + low nibble of
  // char 4 — no memory, no per-char extraction), hi = aux masked to 13 bits (length
  // + char 4-5 tail; SSO_BIT itself sits at aux bit 14, outside the mask, so it never
  // pollutes the mix). Same lo/hi pair strHashLiteral (module/collection.js, JS side)
  // builds from ssoEncode's {offset, aux} — the two MUST compute the identical
  // constant-for-constant mix or literal-prehashed probes silently miss. Heap strings
  // (>6 bytes or non-ASCII) are unaffected: they keep byte-FNV-1a below.
  // ~95M calls in watr self-host; SSO is the overwhelming majority post-invariant
  // (ec6a229: any ≤6-byte ASCII string IS SSO).
  ctx.core.stdlib['__str_hash'] = `(func $__str_hash (param $s i64) (result i32)
    (local $h i32) (local $len i32) (local $lenA i32) (local $i i32) (local $t i32) (local $off i32) (local $aux i32) (local $w i32) (local $hi i32) (local $cs i32)
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $s) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $s) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $aux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $s) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING})) (i32.shr_u (local.get $aux) (i32.const 14)))
      (then
        (local.set $hi (i32.and (local.get $aux) (i32.const 0x1FFF)))
        (local.set $h (i32.mul
          (i32.xor (local.get $off) (i32.mul (i32.xor (local.get $hi) (i32.const 0x9E3779B9)) (i32.const 0x85EBCA6B)))
          (i32.const 0xC2B2AE35)))
        (local.set $h (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 15)))))
      (else
        (local.set $h (i32.const 0x811c9dc5))
        ;; canonical interned static: cached post-clamp FNV at -8 (see layout.js)
        (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
              (i32.and (i32.ge_u (local.get $off) (i32.const 8))
                (i32.eq (i32.and (local.get $aux) (i32.const ${LAYOUT.SSO_BIT | LAYOUT.SLICE_BIT | STR_INTERN_BIT})) (i32.const ${STR_INTERN_BIT}))))
          (then (return (i32.load (i32.sub (local.get $off) (i32.const 8))))))
        ;; runtime-built heap string with a lazy hash cell at -8 (STR_HCACHE_BIT,
        ;; layout.js): 0 = uncomputed — fall through to the FNV walk and fill it
        ;; below. Mask excludes SLICE (its aux[12:0] is a length, bit 1 incidental).
        (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
              (i32.eq (i32.and (local.get $aux) (i32.const ${LAYOUT.SLICE_BIT | STR_HCACHE_BIT})) (i32.const ${STR_HCACHE_BIT})))
          (then
            (local.set $cs (i32.sub (local.get $off) (i32.const 8)))
            (local.set $h (i32.load (local.get $cs)))
            (if (local.get $h) (then (return (local.get $h))))
            (local.set $h (i32.const 0x811c9dc5))))
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
    (if (i32.le_s (local.get $h) (i32.const 1))
      (then (local.set $h (i32.add (local.get $h) (i32.const 2)))))
    ;; fill the lazy hash cell (post-clamp, so 0 stays unambiguous "uncomputed")
    (if (local.get $cs) (then (i32.store (local.get $cs) (local.get $h))))
    (local.get $h))`

  // Cold shared rescan for the upsert templates' cap-tries fallback: first
  // TOMB-keyed (zombied) slot of the table, or slot 0 when none exists (a
  // truly-full-of-live-keys table — unreachable behind the 75%-load grow).
  ctx.core.stdlib['__zomb_scan'] = `(func $__zomb_scan (param $off i32) (param $cap i32) (param $es i32) (result i32)
    (local $slot i32) (local $end i32)
    (local.set $slot (local.get $off))
    (local.set $end (i32.add (local.get $off) (i32.mul (local.get $cap) (local.get $es))))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $slot) (local.get $end)))
      (br_if $d (i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (i64.const ${TOMB_NAN})))
      (local.set $slot (i32.add (local.get $slot) (local.get $es)))
      (br $l)))
    (select (local.get $off) (local.get $slot) (i32.ge_u (local.get $slot) (local.get $end))))`

  ctx.core.stdlib['__hash_new'] = `(func $__hash_new (result f64)
    (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0)
      (call $__alloc_hdr_n (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY + LANE}))))`

  // Small initial capacity for propsPtr-style hashes (per-object dyn props).
  // Most receivers in real code carry 0-2 dyn props; paying 8-slot up-front
  // is wasted memory + probe-loop cache pressure. Grows to 4/8/... on demand.
  // L3/'speed' opts into a larger initial cap (default 8) to skip 2→4→8 growth
  // when AST-style nodes carry 3-5 props (watr.compile's profile).
  const smallCap = Math.max(ctx.transform.optimize?.hashSmallInitCap | 0, 2)
  ctx.core.stdlib['__hash_new_small'] = `(func $__hash_new_small (result f64)
    (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0)
      (call $__alloc_hdr_n (i32.const 0) (i32.const ${smallCap}) (i32.const ${MAP_ENTRY + LANE}))))`

  ctx.core.stdlib['__hash_get_local'] = genLookupStrict('__hash_get_local', MAP_ENTRY, '$__str_hash', strEqG, PTR.HASH)
  ctx.core.stdlib['__hash_get_local_h'] = genLookupStrictPrehashed('__hash_get_local_h', MAP_ENTRY, strEqG, PTR.HASH)
  ctx.core.stdlib['__hash_set_local_h'] = () => genUpsertStrictPrehashed('__hash_set_local_h', MAP_ENTRY, strEqG, PTR.HASH)
  // Thunked (not called eagerly) so genUpsertGrow's durableFwdLogIR reads
  // heapResetWat()'s FINAL declaration state — see collection.js's heapResetWat
  // comment; module load order isn't otherwise settled at the time this string
  // would eagerly evaluate (same reasoning as module/core.js's __obj_clone).
  ctx.core.stdlib['__hash_set_local'] = () => genUpsertGrow('__hash_set_local', MAP_ENTRY, '$__str_hash', strEqG, PTR.HASH, true, false, true)
  ctx.core.stdlib['__hash_slot'] = () => genSlotUpsert('__hash_slot', MAP_ENTRY, '$__str_hash', strEqG)
  // The RMW fusion's value update — the store plus the durable-heal protocol
  // (mirrors durableSlotLogIR exactly; kept in the kernel so heal logic has one home).
  ctx.core.stdlib['__slot_write'] = () => ctx.scope.globals.has('__heap_reset')
    ? `(func $__slot_write (param $a i32) (param $v i64)
    (i64.store (local.get $a) (local.get $v))
    (if (i32.and (i32.lt_u (local.get $a) ${heapResetWat()}) (call $__is_eph_bits (local.get $v)))
      (then (call $__durable_slot_log (local.get $a) (i32.const 0)))))`
    : `(func $__slot_write (param $a i32) (param $v i64)
    (i64.store (local.get $a) (local.get $v)))`
  // Tombstones an entry in a HASH (string keys). Returns 1 if found+deleted, 0 otherwise.
  // Used as the bucket-level primitive for __dyn_del.
  ctx.core.stdlib['__hash_del_local'] = genDelete('__hash_del_local', MAP_ENTRY, '$__str_hash', strEqG, PTR.HASH)
  // Outer __dyn_props hash: keyed by object offset (i32 as f64 bits), value is per-object props hash.
  // Uses bit-hash + i64.eq — no string allocation for the unique integer key.
  ctx.core.stdlib['__ihash_get_local'] = genLookupStrict('__ihash_get_local', MAP_ENTRY, '$__map_hash', '(i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))', PTR.HASH)
  ctx.core.stdlib['__ihash_set_local'] = () => genUpsertGrow('__ihash_set_local', MAP_ENTRY, '$__map_hash', '(i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))', PTR.HASH, true)

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
  // If-expression, NOT i32.or: `or` evaluates both arms, calling __str_eq even
  // when the bit-eq already decided — that bare call per schema-key step was
  // the hottest __str_eq producer in the self-host (the kernel includes __jp
  // for optJSON, so the fallback arm is always compiled in).
  // The __str_eq fallback (JSON-parsed heap keys) is prefixed by an inline
  // one-SSO⇒ne test when SSO is on: any SSO operand with unequal bits cannot
  // content-match (≤6-ASCII⇒SSO invariant, module/string.js), so the call —
  // the hottest __str_eq producer in the self-host — is skipped for every
  // SSO-keyed miss step; only heap-vs-heap candidates still pay it.
  // Types allocated via __alloc_hdr/__alloc_hdr_n (see core.js) reserve a 16-byte
  // header with a propsPtr slot at off-16: ARRAY, OBJECT, TYPED, SET, MAP. HASH is
  // its own storage (no sidecar — handled by its own dedicated arm). Every OTHER
  // type (STRING, CLOSURE, ATOM, BUFFER, REGEX, DATE, EXTERNAL, …) has NO such
  // slot — reading off-16 for one of them walks into whatever memory precedes it
  // (for a static/interned STRING literal, unrelated PRECEDING STATIC DATA) and
  // misreads it as a props pointer, occasionally matching the HASH tag by chance
  // and handing a garbage pointer to __hash_get_local_h → OOB trap. The ORIGINAL
  // (pre-durable-policy) code never had this gap: each header-type arm below
  // individually gated on its OWN type tag before ever touching off-16. The
  // durable-receiver policy's sidecar-check (__dyn_get_t_h, __dyn_del) must gate
  // on this SAME explicit set, not the broader "not HASH" the global-table probe
  // uses (that probe is a safe opaque off-keyed hash lookup for any type).
  const hasPropsSidecarWat = (typeExpr) =>
    `(i32.or (i32.eq ${typeExpr} (i32.const ${PTR.ARRAY}))
       (i32.or (i32.eq ${typeExpr} (i32.const ${PTR.OBJECT}))
         (i32.or (i32.eq ${typeExpr} (i32.const ${PTR.TYPED}))
           (i32.or (i32.eq ${typeExpr} (i32.const ${PTR.SET}))
                   (i32.eq ${typeExpr} (i32.const ${PTR.MAP}))))))`
  const schemaKeyEq = (storedKey, userKey) => ctx.core.includes.has('__jp_obj') || ctx.core.includes.has('__jp')
    ? `(if (result i32) (i64.eq ${storedKey} ${userKey})
        (then (i32.const 1))
        (else ${ctx.features.sso
          ? `(if (result i32) (i64.ne (i64.and (i64.or ${storedKey} ${userKey}) (i64.const ${SSO_BIT_I64})) (i64.const 0))
            (then (i32.const 0))
            (else (call $__str_eq ${storedKey} ${userKey})))`
          : `(call $__str_eq ${storedKey} ${userKey})`}))`
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
          (if ${schemaKeyEq(`(i64.load (i32.add (local.get $koff) (i32.shl (local.get $idx) (i32.const 3))))`, `(local.get $key)`)}
            (then
              (i64.store (i32.add (local.get $off) (i32.shl (local.get $idx) (i32.const 3))) (local.get $val))
              (br $schemaSetDone)))
          (local.set $idx (i32.add (local.get $idx) (i32.const 1)))
          (br $schemaSetLoop)))))` : ''

  // Canonical array-index parse of a string key: '0' | [1-9][0-9]{0,9} within
  // i32 range → the index, else -1. JS property semantics: a canonical numeric
  // string on an ARRAY receiver addresses the ELEMENT ('1' ≡ 1), so every
  // string-keyed dyn entry must classify before probing the props sidecar.
  // __char_at returns the true byte (0 only past the REAL length, which
  // $__str_byteLen bounds first), so embedded-NUL keys can't false-match.
  ctx.core.stdlib['__str_arr_idx'] = `(func $__str_arr_idx (param $key i64) (result i32)
    (local $len i32) (local $i i32) (local $c i32) (local $n i64)
    (local.set $len (call $__str_byteLen (local.get $key)))
    (if (i32.or (i32.eqz (local.get $len)) (i32.gt_u (local.get $len) (i32.const 10)))
      (then (return (i32.const -1))))
    (if (i32.and (i32.eq (call $__char_at (local.get $key) (i32.const 0)) (i32.const 48))
                 (i32.gt_u (local.get $len) (i32.const 1)))
      (then (return (i32.const -1))))
    (block $bad
      (loop $l
        (if (i32.ge_u (local.get $i) (local.get $len))
          (then
            (if (i64.gt_u (local.get $n) (i64.const 2147483646)) (then (return (i32.const -1))))
            (return (i32.wrap_i64 (local.get $n)))))
        (local.set $c (i32.sub (call $__char_at (local.get $key) (local.get $i)) (i32.const 48)))
        (br_if $bad (i32.gt_u (local.get $c) (i32.const 9)))
        (local.set $n (i64.add (i64.mul (local.get $n) (i64.const 10)) (i64.extend_i32_u (local.get $c))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (i32.const -1))`

  ctx.core.stdlib['__dyn_get'] = `(func $__dyn_get (param $obj i64) (param $key i64) (result i64)
    (call $__dyn_get_t (local.get $obj) (local.get $key) (call $__ptr_type (local.get $obj))))`

  // Thin wrapper: ToPropertyKey the runtime key, hash it once, delegate to the
  // prehashed body. Constant-key call sites bypass this and call $__dyn_get_t_h
  // directly with strHashLiteral() (compile-time keys are already strings).
  // ToPropertyKey: a non-string key (number/bool/null/undefined) addresses the
  // same slot as its string form — o[97] ≡ o['97'] (JS spec). Writes stringify
  // (emit-assign's staticPropertyKey fold, __dyn_set below), so reads must too.
  ctx.core.stdlib['__dyn_get_t'] = `(func $__dyn_get_t (param $obj i64) (param $key i64) (param $type i32) (result i64)
    (if (i32.eqz (call $__is_str_key (local.get $key)))
      (then (local.set $key (call $__to_str (local.get $key)))))
    (call $__dyn_get_t_h (local.get $obj) (local.get $key) (local.get $type) (call $__str_hash (local.get $key))))`

  ctx.core.stdlib['__dyn_get_t_h'] = () => `(func $__dyn_get_t_h (param $obj i64) (param $key i64) (param $type i32) (param $h i32) (result i64)
    (local $props i64) (local $off i32) (local $val i64)
    (local $poff i32) (local $pcap i32) (local $pend i32) (local $idx i32) (local $slot i32) (local $tries i32)
    ${buildObjectSchemaLocals()}
    ;; Real-number receiver (f===f — pointers are NaN-boxed) has no props: bail before
    ;; treating its bits as a heap offset (\`(5).foo\`/\`(5)[k]\` → undefined, not OOB).
    (if (f64.eq (f64.reinterpret_i64 (local.get $obj)) (f64.reinterpret_i64 (local.get $obj)))
      (then (return (i64.const ${UNDEF_NAN}))))
    ;; STRING receiver + 'length' key → aux/byte length directly. Strings are
    ;; primitives — they can never carry dyn props, yet an SSO string's packed
    ;; chars LOOK like a tiny durable heap offset, so \`op.length\` in a parser
    ;; loop (jessie: 1.96M reads/run, ~30% of runtime, causally measured by
    ;; probe-doubling) took the durable global-probe arm for nothing. One i64
    ;; compare: a runtime 'length' key is ALWAYS SSO (≤6 ASCII invariant), so
    ;; constant-vs-key bit equality is exact. Other keys fall through unchanged.
    ;; Form-proof: the const key at _h call sites may be DATA-INTERNED rather
    ;; than SSO, so bit-equality alone goes dead — gate on the prehashed key
    ;; hash (compile-time constant, zero cost) and confirm content via
    ;; __str_eq (SSO/heap-form agnostic).
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.STRING}))
                 (i32.eq (local.get $h) (i32.const ${strHashLiteral('length')})))
      (then
        (if (call $__str_eq (local.get $key) (i64.const ${LENGTH_SSO_I64}))
          (then (return (i64.reinterpret_f64 (f64.convert_i32_s (call $__str_byteLen (local.get $obj)))))))))
    ;; STRING receivers END here: strings are primitives — no dyn props, no
    ;; sidecar, no global-table entries (writes below drop, JS semantics), so
    ;; the probe chain can never produce a value. Method-name lookups on
    ;; unproven string receivers (cur.charCodeAt in a parser loop — jessie:
    ;; 1.38M reads/run, every one a guaranteed miss) made this the largest
    ;; single dyn sink after the array-index fix.
    (if (i32.eq (local.get $type) (i32.const ${PTR.STRING}))
      (then (return (i64.const ${UNDEF_NAN}))))
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
            ;; $__heap_end64 (i64), not i32.shl (memory.size) 16: at the wasm32 ceiling
            ;; (memory.size()==65536 pages), the i32 form overflows to exactly 0 —
            ;; see layout.js's followForwardingWat comment for the full account.
            (br_if $done (i64.gt_u (i64.extend_i32_u (local.get $off)) (global.get $__heap_end64)))
            (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
            (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (br $follow)))
        ;; Canonical-index string key ('1' ≡ 1, JS array-index semantics) →
        ;; ELEMENT, not sidecar. This is the single string-keyed net covering
        ;; every read entry (dot, expr slow path, any, prehashed const keys):
        ;; __dyn_set routes such keys to elements, so the sidecar can never
        ;; hold them and an in-range miss is definitively undefined.
        ;; Inline first-char digit reject: identifier keys ('loc', 'length' —
        ;; the kernel-hot shape on array AST nodes) skip the parse call.
        (if (i32.and (i32.ge_u (local.get $off) (i32.const 16))
              (i32.lt_u (i32.sub (if (result i32) (i64.ne (i64.and (local.get $key) (i64.const ${SSO_BIT_I64})) (i64.const 0))
              (then (i32.and (i32.wrap_i64 (local.get $key)) (i32.const 127)))
              (else (i32.load8_u (i32.wrap_i64 (i64.and (local.get $key) (i64.const ${LAYOUT.OFFSET_MASK})))))) (i32.const 48)) (i32.const 10)))
          (then
            (local.set $idx (call $__str_arr_idx (local.get $key)))
            (if (i32.ge_s (local.get $idx) (i32.const 0))
              (then
                (if (i32.lt_u (local.get $idx) (i32.load (i32.sub (local.get $off) (i32.const 8))))
                  (then (return (i64.load (i32.add (local.get $off) (i32.shl (local.get $idx) (i32.const 3)))))))
                (return (i64.const ${UNDEF_NAN}))))))))
    ;; DURABLE-RECEIVER POLICY: a receiver allocated at/below the post-init
    ;; high-water mark (__heap_reset) outlives _clear, but a sidecar CREATED
    ;; FOR IT AT RUNTIME lives in the round's arena — the receiver's header
    ;; slot survives _clear while the sidecar behind it doesn't, so __dyn_set
    ;; routes runtime (post-init) writes on a durable receiver to the GLOBAL
    ;; __dyn_props table instead (which __clear resets — prop lifetime
    ;; matches storage). BUT a durable receiver's off-16 sidecar can ALSO
    ;; hold real data: __heap_reset is only seeded to its final value at the
    ;; TAIL of __start, so a prop written *during* init (e.g. a module-level
    ;; IIFE mutating an init-built table — jz's own compile.js population of
    ;; watr's opcode dict) sees off >= __heap_reset (still low) at write time
    ;; and lands in the sidecar — which is itself durable (allocated before
    ;; the same tail-capture), so nothing dangles. The same receiver can thus
    ;; carry keys in BOTH places: untouched init-time keys in the sidecar,
    ;; keys added or reassigned at runtime in the global table. Check global
    ;; first (a key present in both was necessarily reassigned at runtime,
    ;; so the newer global entry wins), then the sidecar. HASH is exempted —
    ;; it is its own storage, no sidecar/global split applies to it.
    (if (i32.and (i32.ne (local.get $type) (i32.const ${PTR.HASH}))
                 (i32.lt_u (local.get $off) ${heapResetWat()}))
      (then
        ;; Header-carrying durable receiver: read its off-16 word ONCE. bit0 =
        ;; RUNTIME-SHADOWED (set by __dyn_set's global route): only then can a
        ;; global-table entry exist, so unmarked receivers skip the probe
        ;; entirely — 60% of jessie's 1.07M durable probes were such
        ;; always-miss reads (causally measured via probe-doubling, ~18% of
        ;; runtime). Root≠0 guards the post-_clear stale-marker case (the
        ;; wiped table must not be probed through a null root). Receivers
        ;; without a header slot keep the unconditional bloom+probe path.
        (if (i32.and ${hasPropsSidecarWat('(local.get $type)')} (i32.ge_u (local.get $off) (i32.const 16)))
          (then
            (local.set $props (i64.load (i32.sub (local.get $off) (i32.const 16))))
            ;; a shifted ARRAY's word holds forwarding bytes (not 0, not
            ;; HASH-tagged): __arr_shift migrated its props to the global
            ;; table and CANNOT mark — such receivers keep the unconditional
            ;; probe (jump to the no-header path below via $probe).
            (if (i32.eqz (i32.or (i64.eqz (local.get $props))
                  (i32.eq (i32.wrap_i64 (i64.and (i64.shr_u (local.get $props) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))) (i32.const ${PTR.HASH}))))
              (then (local.set $props (i64.const 0)) (local.set $tries (i32.const -1))))
            (if (i32.and (i32.eq (local.get $tries) (i32.const 0))
                  (i32.and (i32.and (i32.wrap_i64 (local.get $props)) (i32.const 1))
                           (f64.ne (global.get $__dyn_props) (f64.const 0))))
              (then
                (if (i32.eqz ${dynPropsFilterMissIR('(local.get $off)')})
                  (then
                    (local.set $val (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props))
                      (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))))
                    (if (i32.eqz (call $__is_nullish (local.get $val)))
                      (then
                        (local.set $val (call $__hash_get_local_h (local.get $val) (local.get $key) (local.get $h)))
                        (if (i64.ne (local.get $val) (i64.const ${UNDEF_NAN})) (then (return (local.get $val))))))))))
            (local.set $props (i64.and (local.get $props) (i64.const -2)))
            (if (i32.eq
                  (i32.wrap_i64 (i64.and (i64.shr_u (local.get $props) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
                  (i32.const ${PTR.HASH}))
              (then (return (call $__hash_get_local_h (local.get $props) (local.get $key) (local.get $h))))))
          (else (local.set $tries (i32.const -1))))
        (if (i32.eq (local.get $tries) (i32.const -1))
          (then
            (local.set $tries (i32.const 0))
            (if (i32.eqz ${dynPropsFilterMissIR('(local.get $off)')})
              (then
                (local.set $props (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props))
                  (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))))
                (if (i32.eqz (call $__is_nullish (local.get $props)))
                  (then
                    (local.set $val (call $__hash_get_local_h (local.get $props) (local.get $key) (local.get $h)))
                    (if (i64.ne (local.get $val) (i64.const ${UNDEF_NAN})) (then (return (local.get $val))))))))))
        ;; Miss on both global and sidecar: an OBJECT still needs the
        ;; schema-slot arm before giving up — a schema-poisoned variable
        ;; (one variable bound to two different object shapes) resolves its
        ;; field via the runtime schemaId lookup, not via any dyn-props
        ;; path. A durable such object has no dyn props at all, so both
        ;; checks above always miss for it and this must still run before
        ;; concluding UNDEF. Self-contained here (not a fallthrough into the
        ;; block below) so this arm's control flow never depends on the
        ;; ephemeral-only header arms or their shared global-fallback code.
        ${buildObjectSchemaArm()}
        (return (i64.const ${UNDEF_NAN}))))
    (block $dynDone
      (block $haveProps
        ;; Ephemeral-only from here down (durable receivers already
        ;; returned above) — the off >= __heap_reset conjuncts below are
        ;; therefore always true, kept for defensive clarity and a single
        ;; source of truth with __dyn_set/__dyn_del's mirrored gates.
        ;; ARRAY: header propsPtr at $off-16 is valid only when shift hasn't
        ;; rewritten the slot with forwarding bytes. Validate via HASH tag —
        ;; rejects 0 (no props) and forwarding garbage. Misses fall through to
        ;; the global hash, where __arr_shift migrates props on first .shift().
        (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
                     (i32.and (i32.ge_u (local.get $off) (i32.const 16))
                       (i32.ge_u (local.get $off) ${heapResetWat()})))
          (then
            (local.set $props (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
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
        ;; off-16 from __alloc_hdr — but only when also ephemeral (durable-
        ;; receiver policy above). The slot is either 0 (no dyn props yet) or
        ;; a HASH — no forwarding-garbage case like ARRAY, so a bit-zero test
        ;; is enough. Static-segment and durable-heap objects fall through to
        ;; the global hash.
        (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                     (i32.ge_u (local.get $off) ${heapResetWat()}))
          (then
            (local.set $props (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
            (br_if $dynDone (i64.eqz (local.get $props)))
            (br $haveProps)))
        ;; HASH: a plain dict whose string keys ARE its own bucket entries — the
        ;; receiver IS its props table, so probe it directly (a HASH never carries
        ;; an off-16 dyn sidecar). A statically HASH-typed h[k] already inlines
        ;; __hash_get; this path serves receivers whose HASH type is only known at
        ;; runtime — e.g. a value read back through a function return, as in
        ;; derive(emitter)[op]. Without it, dyn-get reads the (absent) sidecar and
        ;; reports every key missing. HASH is its own storage (no sidecar, no
        ;; global split) — durability is irrelevant here.
        (if (i32.eq (local.get $type) (i32.const ${PTR.HASH}))
          (then
            (local.set $props (local.get $obj))
            (br $haveProps)))
        ;; Other header types (TYPED/SET/MAP) carry propsPtr at off-16
        ;; directly, bypassing the global __dyn_props hash — again only when
        ;; ephemeral.
        (if (i32.and (i32.and (i32.ge_u (local.get $off) (i32.const 16))
                (i32.ge_u (local.get $off) ${heapResetWat()}))
              (i32.or (i32.eq (local.get $type) (i32.const ${PTR.TYPED}))
                (i32.or (i32.eq (local.get $type) (i32.const ${PTR.SET}))
                        (i32.eq (local.get $type) (i32.const ${PTR.MAP})))))
          (then
            (local.set $props (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
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
        ;; hash-first: slot stores the key's hash in its low 32 bits — one i32
        ;; compare rejects collision steps without walking key bytes.
        (if (i32.eq (i32.load (local.get $slot)) (local.get $h))
          (then (if (call $__str_eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))
            (then (return (i64.load (i32.add (local.get $slot) (i32.const 16))))))))
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
    (local $f f64) (local $idx i32) (local $base i32)
    ;; Real-number receiver → no props; its garbage tag could match HASH and hit the
    ;; __hash_get_local arm below (heap read at a bogus offset → OOB).
    (if (f64.eq (f64.reinterpret_i64 (local.get $obj)) (f64.reinterpret_i64 (local.get $obj)))
      (then (return (i64.const ${UNDEF_NAN}))))
    ;; ARRAY + raw integer key → ELEMENT read (JS array-index semantics), BEFORE
    ;; ToPropertyKey. This is the generic \`a[i]\` fallback: the former
    ;; stringify+str_hash+durable-double-probe chain taxed every numeric read
    ;; on an unproven array (jessie's charcode tables: 3.7M reads/run). An
    ;; in-range integer key can only live in the elements (__dyn_set routes it
    ;; there), so OOB is definitively undefined. Fractional/negative/huge keys
    ;; fall through to the string path (they are sidecar keys, '1.5'/'-1').
    (if (i32.eq (local.get $t) (i32.const ${PTR.ARRAY}))
      (then
        (local.set $f (f64.reinterpret_i64 (local.get $key)))
        (if (f64.eq (local.get $f) (local.get $f))
          (then
            (local.set $idx (i32.trunc_sat_f64_s (local.get $f)))
            (if (i32.and (f64.eq (f64.convert_i32_s (local.get $idx)) (local.get $f))
                         (i32.ge_s (local.get $idx) (i32.const 0)))
              (then
                (local.set $base (call $__ptr_offset (local.get $obj)))
                (if (i32.lt_u (local.get $idx) (i32.load (i32.sub (local.get $base) (i32.const 8))))
                  (then (return (i64.load (i32.add (local.get $base) (i32.shl (local.get $idx) (i32.const 3)))))))
                (return (i64.const ${UNDEF_NAN}))))))))
    ;; ToPropertyKey — see __dyn_get_t; normalized here so the HASH arm reads string-keyed.
    (if (i32.eqz (call $__is_str_key (local.get $key)))
      (then (local.set $key (call $__to_str (local.get $key)))))
    ;; HASH receivers FIRST: hashes never carry dyn_props (those attach to
    ;; OBJECT/ARRAY only — the invariant __dyn_get_any already exploits), so
    ;; the former dyn_get_t-then-fallback order paid the full str_hash +
    ;; durable double-probe chain per read just to miss.
    (if (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
      (then (return (call $__hash_get_local (local.get $obj) (local.get $key)))))
    (call $__dyn_get_t (local.get $obj) (local.get $key) (local.get $t)))`

  // Prehashed variant of __dyn_get_expr_t for constant string keys: the FNV hash
  // is folded at compile time (strHashLiteral), so no __str_hash call at runtime.
  ctx.core.stdlib['__dyn_get_expr_t_h'] = `(func $__dyn_get_expr_t_h (param $obj i64) (param $key i64) (param $t i32) (param $h i32) (result i64)
    ;; Real-number receiver → no props; guard the HASH arm OOB (see __dyn_get_expr_t).
    (if (f64.eq (f64.reinterpret_i64 (local.get $obj)) (f64.reinterpret_i64 (local.get $obj)))
      (then (return (i64.const ${UNDEF_NAN}))))
    ;; HASH receivers first — same wasted-chain argument as __dyn_get_expr_t.
    (if (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
      (then (return (call $__hash_get_local_h (local.get $obj) (local.get $key) (local.get $h)))))
    (call $__dyn_get_t_h (local.get $obj) (local.get $key) (local.get $t) (local.get $h)))`

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
    (local $val i64) (local $f f64) (local $idx i32) (local $base i32)
    ;; Real-number receiver → no props, and its garbage tag could match ARRAY
    ;; below (bogus base → OOB). Same guard the expression tail repeats.
    (if (f64.eq (f64.reinterpret_i64 (local.get $obj)) (f64.reinterpret_i64 (local.get $obj)))
      (then (return (i64.const ${UNDEF_NAN}))))
    ;; ARRAY + raw integer key → element read, before ToPropertyKey — the same
    ;; generic array-index arm as __dyn_get_expr_t (see there for the analysis).
    (if (i32.eq (local.get $t) (i32.const ${PTR.ARRAY}))
      (then
        (local.set $f (f64.reinterpret_i64 (local.get $key)))
        (if (f64.eq (local.get $f) (local.get $f))
          (then
            (local.set $idx (i32.trunc_sat_f64_s (local.get $f)))
            (if (i32.and (f64.eq (f64.convert_i32_s (local.get $idx)) (local.get $f))
                         (i32.ge_s (local.get $idx) (i32.const 0)))
              (then
                (local.set $base (call $__ptr_offset (local.get $obj)))
                (if (i32.lt_u (local.get $idx) (i32.load (i32.sub (local.get $base) (i32.const 8))))
                  (then (return (i64.load (i32.add (local.get $base) (i32.shl (local.get $idx) (i32.const 3)))))))
                (return (i64.const ${UNDEF_NAN}))))))))
    ;; ToPropertyKey — see __dyn_get_t; normalized here so the HASH arm reads string-keyed.
    (if (i32.eqz (call $__is_str_key (local.get $key)))
      (then (local.set $key (call $__to_str (local.get $key)))))
    ;; A real number receiver (f===f — NaN-boxed pointers are NaN) has no dynamic
    ;; props: \`(5).foo\` is undefined. Without this guard the bits are reinterpreted as
    ;; a pointer and \`__dyn_get_t\` reads heap at a bogus offset → OOB for large values.
    (if (result i64) (f64.eq (f64.reinterpret_i64 (local.get $obj)) (f64.reinterpret_i64 (local.get $obj)))
      (then (i64.const ${UNDEF_NAN}))
      (else
        (if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
          (then (call $__hash_get_local (local.get $obj) (local.get $key)))
          (else
            (local.set $val (call $__dyn_get_t (local.get $obj) (local.get $key) (local.get $t)))
            (if (result i64)
              (i64.ne (local.get $val) (i64.const ${UNDEF_NAN}))
              (then (local.get $val))
              (else ${extArm})))))))`
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
    ;; Real-number receiver → no dynamic props (see __dyn_get_any_t); guard the OOB.
    (if (result i64) (f64.eq (f64.reinterpret_i64 (local.get $obj)) (f64.reinterpret_i64 (local.get $obj)))
      (then (i64.const ${UNDEF_NAN}))
      (else
        (if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
          (then (call $__hash_get_local_h (local.get $obj) (local.get $key) (local.get $h)))
          (else
            (local.set $val (call $__dyn_get_t_h (local.get $obj) (local.get $key) (local.get $t) (local.get $h)))
            (if (result i64)
              (i64.ne (local.get $val) (i64.const ${UNDEF_NAN}))
              (then (local.get $val))
              (else ${extArm})))))))`
  }

  // Hot for `node.loc = pos` patterns (e.g. watr's parser tags every nested level).
  // Defer the root insert to the end and gate it on props-ptr change: most calls hit
  // the no-grow case where the ptr is unchanged and the root slot already points to it.
  // __ptr_offset inlined (forwarding-aware) — only ARRAY ever has forwarding.
  ctx.core.stdlib['__dyn_set'] = () => `(func $__dyn_set (param $obj i64) (param $key i64) (param $val i64) (result i64)
    (local $root i64) (local $props i64) (local $oldProps i64) (local $objKey i64)
    (local $off i32) (local $type i32) (local $kf f64) (local $kidx i32) ${buildObjectSchemaSetLocals()}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $type (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    ;; STRING receiver: primitives drop property writes (JS non-strict
    ;; semantics) — the read path above guarantees UNDEF for them, so
    ;; storing would only create unreadable entries. NaN guard: a real
    ;; number's garbage tag may alias STRING; those keep today's path.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.STRING}))
                 (f64.ne (f64.reinterpret_i64 (local.get $obj)) (f64.reinterpret_i64 (local.get $obj))))
      (then (return (local.get $val))))
    ;; ARRAY + integer key → ELEMENT store (grow + hole-fill via the same
    ;; helper the statically-proven \`a[i]=v\` path uses), matching JS index
    ;; semantics and the element arms in the dyn read entries. Guard real-
    ;; number receivers first — their garbage tag could match ARRAY and the
    ;; store would land OOB. Raw numeric arm before ToPropertyKey (hot);
    ;; canonical numeric STRING arm after it ('1' ≡ 1). __arr_set_idx_ptr
    ;; leaves a forwarding header on grow, which every dyn/static reader
    ;; already follows — binding-unaware callers stay correct.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
                 (f64.ne (f64.reinterpret_i64 (local.get $obj)) (f64.reinterpret_i64 (local.get $obj))))
      (then
        (local.set $kf (f64.reinterpret_i64 (local.get $key)))
        (if (f64.eq (local.get $kf) (local.get $kf))
          (then
            (local.set $kidx (i32.trunc_sat_f64_s (local.get $kf)))
            (if (i32.and (f64.eq (f64.convert_i32_s (local.get $kidx)) (local.get $kf))
                         (i32.ge_s (local.get $kidx) (i32.const 0)))
              (then
                (drop (call $__arr_set_idx_ptr (local.get $obj) (local.get $kidx) (f64.reinterpret_i64 (local.get $val))))
                (return (local.get $val)))))
          (else
            ;; key is non-number here (NaN-boxed) — a bare tag test IS the
            ;; string test, no __is_str_key call (its NaN guard is redundant).
            (if (i32.eq (i32.wrap_i64 (i64.and (i64.shr_u (local.get $key) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))) (i32.const ${PTR.STRING}))
              (then
                ;; first-char digit reject — see __dyn_get_t_h's net
                (if (i32.lt_u (i32.sub (if (result i32) (i64.ne (i64.and (local.get $key) (i64.const ${SSO_BIT_I64})) (i64.const 0))
              (then (i32.and (i32.wrap_i64 (local.get $key)) (i32.const 127)))
              (else (i32.load8_u (i32.wrap_i64 (i64.and (local.get $key) (i64.const ${LAYOUT.OFFSET_MASK})))))) (i32.const 48)) (i32.const 10))
                  (then
                    (local.set $kidx (call $__str_arr_idx (local.get $key)))
                    (if (i32.ge_s (local.get $kidx) (i32.const 0))
                      (then
                        (drop (call $__arr_set_idx_ptr (local.get $obj) (local.get $kidx) (f64.reinterpret_i64 (local.get $val))))
                        (return (local.get $val))))))))))))
    ;; ToPropertyKey — see __dyn_get_t. Stored keys are always strings.
    (if (i32.eqz (call $__is_str_key (local.get $key)))
      (then (local.set $key (call $__to_str (local.get $key)))))
    ;; CLOSURE with no env (offset 0): key __dyn_props on the function table index — see __dyn_get_t.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.CLOSURE})) (i32.eqz (local.get $off)))
      (then (local.set $off (i32.sub (i32.const -1)
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK})))))))
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then
        (block $done
          (loop $follow
            (br_if $done (i32.lt_u (local.get $off) (i32.const 16)))
            ;; $__heap_end64 (i64), not i32.shl (memory.size) 16: at the wasm32 ceiling
            ;; (memory.size()==65536 pages), the i32 form overflows to exactly 0 —
            ;; see layout.js's followForwardingWat comment for the full account.
            (br_if $done (i64.gt_u (i64.extend_i32_u (local.get $off)) (global.get $__heap_end64)))
            (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
            (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (br $follow)))))
    ${buildObjectSchemaSetArm()}
    ;; Header types carry propsPtr at off-16. Read/grow/write directly there;
    ;; skip the global __dyn_props hash entirely. ARRAY also uses this slot, but
    ;; only when shift hasn't overwritten it with forwarding bytes (HASH-tagged
    ;; check rejects 0 + forwarding garbage). Shifted ARRAYs fall back to the
    ;; global __dyn_props where __arr_shift has migrated their props. DURABLE-
    ;; RECEIVER POLICY (see heapResetWat): a durable receiver (off < the
    ;; post-init high-water mark) always falls through to the global table too,
    ;; regardless of shift state — this mirrors __dyn_get_t_h's ARRAY arm.
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then
        (if (i32.and (i32.ge_u (local.get $off) (i32.const 16))
              (i32.ge_u (local.get $off) ${heapResetWat()}))
          (then
            (local.set $oldProps (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
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
    ;; OBJECT: heap-allocated AND ephemeral (durable-receiver policy) writes
    ;; propsPtr directly at off-16. The slot is 0 (init) or HASH — no
    ;; forwarding-garbage like ARRAY. Static-segment and durable-heap OBJECTs
    ;; fall through to the global __dyn_props.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                 (i32.ge_u (local.get $off) ${heapResetWat()}))
      (then
        (local.set $oldProps (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
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
    ;; TYPED/SET/MAP header sidecar — ephemeral only (durable-receiver policy).
    (if (i32.and (i32.and (i32.ge_u (local.get $off) (i32.const 16)) (i32.ge_u (local.get $off) ${heapResetWat()}))
          (i32.or (i32.eq (local.get $type) (i32.const ${PTR.TYPED}))
            (i32.or (i32.eq (local.get $type) (i32.const ${PTR.SET}))
                    (i32.eq (local.get $type) (i32.const ${PTR.MAP})))))
      (then
        (local.set $oldProps (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
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
    ;; Filter: a clear bit proves this offset was never inserted — the probe
    ;; would miss, so skip straight to "no existing props" without calling
    ;; __ihash_get_local. A set bit (maybe-present, or a collision) falls
    ;; through to the real probe. Never a false negative — see filter's decl.
    (local.set $oldProps
      (if (result i64) ${dynPropsFilterMissIR('(local.get $off)')}
        (then (i64.const ${UNDEF_NAN}))
        (else (call $__ihash_get_local (local.get $root) (local.get $objKey)))))
    (local.set $props
      (if (result i64) (call $__is_nullish (local.get $oldProps))
        (then (i64.reinterpret_f64 (call $__hash_new_small)))
        (else (local.get $oldProps))))
    (local.set $props (call $__hash_set_local (local.get $props) (local.get $key) (local.get $val)))
    ;; for-in enum cache: a global-side prop insert changes a durable receiver's
    ;; enumeration without touching the (sidecar-keyed) cache key — clear it.
    ;; Unconditional: an insert into an EXISTING per-object hash skips the
    ;; props≠oldProps rekey below, so this can't ride that guard. Cold path.
    (global.set $__enumc_off (i32.const 0))
    (if (i64.ne (local.get $props) (local.get $oldProps))
      (then
        (local.set $root (call $__ihash_set_local (local.get $root) (local.get $objKey) (local.get $props)))
        (global.set $__dyn_props (f64.reinterpret_i64 (local.get $root)))
        ${dynPropsFilterSetIR('(local.get $off)')}
        (if (i32.eq (local.get $off) (global.get $__dyn_get_cache_off))
          (then (global.set $__dyn_get_cache_props (f64.reinterpret_i64 (local.get $props)))))))
    ;; RUNTIME-SHADOWED MARKER: this durable receiver now has (at least one)
    ;; runtime-written prop living in the global table — set bit0 of its own
    ;; off-16 props word so the read path probes the global table ONLY for
    ;; shadowed receivers (unshadowed durable reads skip straight to the
    ;; init-time sidecar; measured: 60% of jessie's 1.07M probes are such
    ;; always-miss reads). Only header-carrying receivers whose word is 0 or
    ;; a real HASH ptr are marked — a shifted ARRAY's forwarding bytes (tag
    ;; 0xF) must never be touched, and CLOSURE pseudo-offsets have no header.
    ;; HASH ptr offsets are 8-aligned, so bit0 is free; every consumer of a
    ;; DURABLE off-16 word masks it back out (i64.and -2).
    (if (i32.and (i32.and (i32.ge_u (local.get $off) (i32.const 16))
                          (i32.lt_u (local.get $off) ${heapResetWat()}))
                 ${hasPropsSidecarWat('(local.get $type)')})
      (then
        (local.set $oldProps (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
        (if (i32.or (i64.eqz (local.get $oldProps))
                    (i32.eq (i32.wrap_i64 (i64.and (i64.shr_u (local.get $oldProps) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))) (i32.const ${PTR.HASH})))
          (then (i64.store (i32.sub (local.get $off) (i32.const 16))
                           (i64.or (local.get $oldProps) (i64.const 1)))))))
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
    (local $off i32) (local $type i32) (local $hit i32) (local $delidx i32) ${buildObjectSchemaSetLocals()}
    ;; ToPropertyKey — see __dyn_get_t. Stored keys are always strings.
    (if (i32.eqz (call $__is_str_key (local.get $key)))
      (then (local.set $key (call $__to_str (local.get $key)))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $type (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    ;; HASH receiver is ITS OWN storage (dictionary-mode {} — __dyn_set/__dyn_get
    ;; write/read its entry table directly): delete the entry there. Every arm
    ;; below only probes the props SIDECAR, which a dictionary doesn't use for
    ;; its own keys — without this arm, delete d[k] silently no-ops.
    (if (i32.eq (local.get $type) (i32.const ${PTR.HASH}))
      (then (return (call $__hash_del_local (local.get $obj) (local.get $key)))))
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
            ;; $__heap_end64 (i64), not i32.shl (memory.size) 16: at the wasm32 ceiling
            ;; (memory.size()==65536 pages), the i32 form overflows to exactly 0 —
            ;; see layout.js's followForwardingWat comment for the full account.
            (br_if $done (i64.gt_u (i64.extend_i32_u (local.get $off)) (global.get $__heap_end64)))
            (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
            (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (br $follow)))
        ;; Canonical-index key → element home (mirrors __dyn_set/__dyn_get):
        ;; delete arr[i] leaves a hole (undefined), length unchanged — JS
        ;; semantics. OOB delete is a no-op that still reports success.
        (if (i32.ge_u (local.get $off) (i32.const 16))
          (then
            (local.set $delidx (i32.const -1))
            (if (i32.lt_u (i32.sub (if (result i32) (i64.ne (i64.and (local.get $key) (i64.const ${SSO_BIT_I64})) (i64.const 0))
              (then (i32.and (i32.wrap_i64 (local.get $key)) (i32.const 127)))
              (else (i32.load8_u (i32.wrap_i64 (i64.and (local.get $key) (i64.const ${LAYOUT.OFFSET_MASK})))))) (i32.const 48)) (i32.const 10))
              (then (local.set $delidx (call $__str_arr_idx (local.get $key)))))
            (if (i32.ge_s (local.get $delidx) (i32.const 0))
              (then
                (if (i32.lt_u (local.get $delidx) (i32.load (i32.sub (local.get $off) (i32.const 8))))
                  (then (i64.store (i32.add (local.get $off) (i32.shl (local.get $delidx) (i32.const 3))) (i64.const ${UNDEF_NAN}))))
                (return (i32.const 1))))))))
    ;; DURABLE-RECEIVER POLICY (see __dyn_get_t_h's declaration comment for the
    ;; full rationale): a durable receiver's key can live in EITHER the global
    ;; table (runtime-written) or its off-16 sidecar (init-time-written) — try
    ;; BOTH and OR the hit bits, not just the first that resolves. This is the
    ;; delete-specific twist: a key set at init then reassigned at runtime
    ;; exists in BOTH places (global shadows it for reads), so deleting only
    ;; the global copy would leave the stale sidecar entry to resurface on the
    ;; next get once the (now correctly empty) global lookup falls through to
    ;; it. HASH is exempted — it is its own storage.
    (if (i32.and (i32.ne (local.get $type) (i32.const ${PTR.HASH}))
                 (i32.lt_u (local.get $off) ${heapResetWat()}))
      (then
        (if (i32.eqz ${dynPropsFilterMissIR('(local.get $off)')})
          (then
            (local.set $root (i64.reinterpret_f64 (global.get $__dyn_props)))
            (if (i64.ne (local.get $root) (i64.const 0))
              (then
                (local.set $props (call $__ihash_get_local (local.get $root) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))))
                (if (i32.eqz (call $__is_nullish (local.get $props)))
                  (then (local.set $hit (i32.or (local.get $hit) (call $__hash_del_local (local.get $props) (local.get $key))))))))))
        (if (i32.and ${hasPropsSidecarWat('(local.get $type)')} (i32.ge_u (local.get $off) (i32.const 16)))
          (then
            (local.set $oldProps (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
            (if (i32.eq
                  (i32.wrap_i64 (i64.and (i64.shr_u (local.get $oldProps) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
                  (i32.const ${PTR.HASH}))
              (then (local.set $hit (i32.or (local.get $hit) (call $__hash_del_local (local.get $oldProps) (local.get $key))))))))
        (return (local.get $hit))))
    ;; ARRAY landed propsPtr (HASH-tagged means real sidecar; else fall through
    ;; to global). Ephemeral only — durable receivers already returned above.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
                 (i32.and (i32.ge_u (local.get $off) (i32.const 16))
                   (i32.ge_u (local.get $off) ${heapResetWat()})))
      (then
        (local.set $oldProps (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
        (if (i32.eq
              (i32.wrap_i64 (i64.and (i64.shr_u (local.get $oldProps) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
              (i32.const ${PTR.HASH}))
          (then (return (i32.or (local.get $hit) (call $__hash_del_local (local.get $oldProps) (local.get $key))))))))
    ;; OBJECT heap: propsPtr directly at off-16 — ephemeral only.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                 (i32.ge_u (local.get $off) ${heapResetWat()}))
      (then
        (local.set $oldProps (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
        (if (i64.eqz (local.get $oldProps)) (then (return (local.get $hit))))
        (return (i32.or (local.get $hit) (call $__hash_del_local (local.get $oldProps) (local.get $key))))))
    ;; Other header types (TYPED/HASH/SET/MAP) — ephemeral only.
    (if (i32.and (i32.and (i32.ge_u (local.get $off) (i32.const 16)) (i32.ge_u (local.get $off) ${heapResetWat()}))
          (i32.or (i32.eq (local.get $type) (i32.const ${PTR.TYPED}))
            (i32.or (i32.eq (local.get $type) (i32.const ${PTR.HASH}))
              (i32.or (i32.eq (local.get $type) (i32.const ${PTR.SET}))
                      (i32.eq (local.get $type) (i32.const ${PTR.MAP}))))))
      (then
        (local.set $oldProps (i64.and (i64.load (i32.sub (local.get $off) (i32.const 16))) (i64.const -2)))
        (if (i64.eqz (local.get $oldProps)) (then (return (local.get $hit))))
        (return (i32.or (local.get $hit) (call $__hash_del_local (local.get $oldProps) (local.get $key))))))
    ;; Fallback: global __dyn_props keyed by offset.
    (local.set $root (i64.reinterpret_f64 (global.get $__dyn_props)))
    (if (i64.eqz (local.get $root)) (then (return (local.get $hit))))
    ;; Filter-proven absent: this offset was never inserted into __dyn_props,
    ;; so there's nothing to delete — skip the __ihash_get_local probe.
    (if ${dynPropsFilterMissIR('(local.get $off)')} (then (return (local.get $hit))))
    (local.set $props (call $__ihash_get_local (local.get $root) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))))
    (if (call $__is_nullish (local.get $props)) (then (return (local.get $hit))))
    (i32.or (local.get $hit) (call $__hash_del_local (local.get $props) (local.get $key))))`

  // Called on EVERY array shift/grow once __dyn_set is included (module has any
  // dynamic-prop write) — almost always a miss (arrays with dyn props are rare).
  // The filter bit lets a miss return in O(1) globals-only work instead of an
  // __ihash_get_local probe (hash + bucket walk). Sound: a clear bit proves
  // $oldOff was never inserted, so the probe below would find nothing anyway.
  // Returns i32 1 if an entry was found+rekeyed, 0 on a no-op — callers use this
  // to know whether to mark the relocated array's header (see DYN_PROPS_GLOBAL_SENTINEL).
  ctx.core.stdlib['__dyn_move'] = `(func $__dyn_move (param $oldOff i32) (param $newOff i32) (result i32)
    (local $props i64) (local $root i64)
    (if (f64.eq (global.get $__dyn_props) (f64.const 0)) (then (return (i32.const 0))))
    (if ${dynPropsFilterMissIR('(local.get $oldOff)')} (then (return (i32.const 0))))
    (local.set $props (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $oldOff)))))
    (if (call $__is_nullish (local.get $props)) (then (return (i32.const 0))))
    (local.set $root (call $__ihash_set_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $newOff))) (local.get $props)))
    (global.set $__dyn_props (f64.reinterpret_i64 (local.get $root)))
    ${dynPropsFilterSetIR('(local.get $newOff)')}
    ;; for-in enum cache: props re-keyed to a relocated receiver — global-side
    ;; enumeration state changed without touching the sidecar-keyed cache. Clear.
    (global.set $__enumc_off (i32.const 0))
    (i32.const 1))`

  // Generated HASH probe functions
  ctx.core.stdlib['__hash_set'] = () => genUpsertGrow('__hash_set', MAP_ENTRY, '$__str_hash', strEqG, PTR.HASH, false, ctx.features.external, true)
  ctx.core.stdlib['__hash_get'] = () => genLookup('__hash_get', MAP_ENTRY, '$__str_hash', strEqG, PTR.HASH, true, ctx.features.external)
  ctx.core.stdlib['__hash_has'] = () => genLookup('__hash_has', MAP_ENTRY, '$__str_hash', strEqG, PTR.HASH, false, ctx.features.external)

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

      const schemaIdx = typeof obj === 'string' ? ctx.schema.slotOf(obj, prop) : ctx.schema.slotOf(null, prop)
      if (schemaIdx >= 0) return typed(['i32.const', 1], 'i32')
      // A schema MISS does not prove absence: an OBJECT can carry off-schema
      // dynamic props (`o.z = …` → __dyn_set's propsPtr), and under the self-host
      // kernel schema.slotOf can under-resolve even an in-schema key. Don't fold to
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
    // ES: for-of / spread over null/undefined is a TypeError ("x is not
    // iterable") — throw, per spec. The silent zero-iteration this replaces
    // masked two real self-host miscompiles (a folded undefined-guard and a
    // never-armed matchAll swallowed their wrong undefineds into empty loops)
    // before they were caught. Known-vt receivers skip the check entirely.
    ctx.runtime.throws = true
    inc('__ptr_type', '__is_nullish')
    const ptrType = () => ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]
    return typed(['block', ['result', 'f64'], bind,
      ['if', ['call', '$__is_nullish', ['i64.reinterpret_f64', ['local.get', `$${t}`]]],
        ['then', ['throw', '$__jz_err', ['f64.const', 0]]]],
      ['if', ['result', 'f64'], ['i32.eq', ptrType(), ['i32.const', PTR.SET]],
        ['then', collKeysFromTemp(t, SET_ENTRY)],
        ['else', ['if', ['result', 'f64'], ['i32.eq', ptrType(), ['i32.const', PTR.MAP]],
          ['then', collEntriesFromTemp(t, MAP_ENTRY)],
          ['else', ['local.get', `$${t}`]]]]]], 'f64')
  }

  // === for...in on dynamic objects (HASH iteration) ===

  // Flatten a statement/block to void IR — a self-host-robust inline of
  // emitVoid+emitBlockBody (see the call site in for-in for why the bridge
  // emitVoid can't be used here). Recurses into `{}` blocks; emits each leaf
  // statement in void position and drops any leftover value.
  const emitFlatVoid = (node) => {
    if (isBlockBody(node)) {
      if (node.length === 1) return []
      const inner = node[1]
      const stmts = Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
      const out = []
      for (const s of stmts) if (s != null && typeof s !== 'number') out.push(...emitFlatVoid(s))
      return out
    }
    const ir = emit(node, 'void')
    if (ir == null) return []
    const items = Array.isArray(ir) && (typeof ir[0] === 'string' || ir[0] == null) ? [ir] : ir
    return ir.type && ir.type !== 'void' ? [...items, 'drop'] : items
  }

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
    // NOTE: `flat(body)` (the bridge-dispatched emitVoid) miscompiles in this
    // self-host call context — it returns [] for a void-postfix body
    // (`for (k in o) n++`, lowered to `(++n)-1`), silently dropping the loop
    // body so the kernel-compiled for-in iterates but does nothing. The exact
    // same emit+flatten logic inlined here compiles correctly. emitFlatVoid
    // mirrors emitVoid/emitBlockBody (minus early-return refinement narrowing,
    // which a loop body does not need).
    try { bodyFlat = emitFlatVoid(body) }
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
  inc('__ptr_offset', '__ptr_offset_fwd', '__cap', '__len', '__coll_order')
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
  inc('__ptr_offset', '__ptr_offset_fwd', '__cap', '__len', '__alloc_hdr', '__coll_order')
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
  inc('__len', '__ptr_offset', '__ptr_offset_fwd', '__alloc_hdr')
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

// TypedArray.prototype.entries() → dense Array of [index, element] pairs, reading each
// element width/kind-aware via __typed_get_idx (the plain arrEntriesFromTemp uses a raw
// f64.load, wrong for non-f64 typed arrays). Guarded on __typed_get_idx being registered:
// it only is when the typedarray module is loaded, which is exactly when a PTR.TYPED
// value can exist — so when absent, this branch is dead and falls back to the receiver.
function arrEntriesFromTempTyped(t) {
  if (!ctx.core.stdlib['__typed_get_idx']) return ['local.get', `$${t}`]
  inc('__len', '__typed_get_idx', '__alloc_hdr')
  const n = tempI32('aetn'), i = tempI32('aeti'), pair = tempI32('aetp')
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${n}`], tag: 'aet' })
  const id = ctx.func.uniq++
  const P = () => ['i64.reinterpret_f64', ['local.get', `$${t}`]]
  return ['block', ['result', 'f64'],
    ['local.set', `$${n}`, ['call', '$__len', P()]],
    out.init,
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$aetbrk${id}`, ['loop', `$aetloop${id}`,
      ['br_if', `$aetbrk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${n}`]]],
      ['local.set', `$${pair}`, ['call', '$__alloc_hdr', ['i32.const', 2], ['i32.const', 2]]],
      ['f64.store', ['local.get', `$${pair}`], ['f64.convert_i32_s', ['local.get', `$${i}`]]],
      ['f64.store', ['i32.add', ['local.get', `$${pair}`], ['i32.const', 8]],
        ['call', '$__typed_get_idx', P(), ['local.get', `$${i}`]]],
      elemStore(out.local, i, mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${pair}`])),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$aetloop${id}`]]],
    out.ptr]
}
