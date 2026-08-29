/**
 * Durable-heap logging — module/collection.js's `_clear()`-survival primitives.
 * A "durable" allocation (below `__heap_reset`, the post-init high-water mark)
 * outlives `_clear()`; an "ephemeral" one (at/above it) is this compile
 * round's own arena, wiped every round. These helpers log/heal the handful
 * of relocation and value-write shapes where a durable header or slot would
 * otherwise dangle across a `_clear()` — see heapResetWat's own doc comment
 * below for the full policy.
 *
 * Pure move out of collection.js (stdlib-generators minimality pass): this
 * is a leaf module (its only dependency is the `ctx` singleton) so that both
 * collection.js and collection/upsert.js can depend on it without forming a
 * cycle — collection/upsert.js's probe/grow templates call several of these
 * directly, and collection.js itself (plus module/array.js, module/core.js,
 * module/json.js externally) use the rest. Every export below is called at
 * the same sites, with the same arguments, as before the move.
 *
 * @module collection/durable
 */

import { ctx } from '../../src/ctx.js'

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
// durable alias then lands on garbage or goes OOB (.work/archive/todo.md groundtruth archive,
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
// self-compile compile ticks) completely UNTOUCHED — the check only runs on the already-
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
// always-false-but-present call) matters for self-compile inclusion: array.js's/
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

// IN-PLACE sibling of durableFwdLogIR: a header whose GROWTH still fits inside
// its existing capacity never relocates, so durableFwdLogIR's off/newOff-cross
// gate never fires for it — but the header's `len` word is about to advance
// past its post-__start value exactly as ephemerally as a relocating grow's,
// and unlike the relocating case nothing else logs it. Call this immediately
// BEFORE the len word is overwritten (array.js's __arr_push1/
// __arr_set_idx_ptr/__arr_set_length/__arr_unshift/__arr_splice, core.js's
// __set_len) so `__durable_fwd_log` still captures the header's true
// pre-round (len, cap) — it reads both fresh off the header itself, so no
// extra locals are needed at the call site. `__durable_fwd_log`'s own
// idempotent-per-`off` scan (core.js) makes this safe to call on EVERY write,
// relocating or not: only the FIRST touch of a given durable header each
// round ever records anything, so N in-place writes before an eventual grow
// (or none at all) all converge on the one correct original snapshot.
export const durableLenLogIR = (base) => {
  if (!ctx.scope.globals.has('__heap_reset')) return ''
  return `
    (if (i32.lt_u (local.get $${base}) ${heapResetWat()})
      (then (call $__durable_fwd_log (local.get $${base})
        (i32.load (i32.sub (local.get $${base}) (i32.const 8)))
        (i32.load (i32.sub (local.get $${base}) (i32.const 4))))))`
}

// ARRAY-only sibling of durableLenLogIR/durableFwdLogIR: those two heal a durable
// header's (len, cap) WORDS but never touch the CELLS between them — every in-place
// element write (`arr[i]=x` on an existing index, .splice/.copyWithin/.unshift's
// memory.copy shifts, .reverse/.sort's swaps, .fill's overwrite, and a `.length=`
// grow-in-place refill re-entering indices a same-round shrink narrowed past)
// mutates DURABLE data cells with no log at all, so `_clear()`'s header-only heal
// restores the right LENGTH but round 2 still reads round 1's leftover bytes at
// every surviving index (.work/evidence.md's own repro: `a.splice(1,2)` on
// `[1,2,3,4,5]` gave `3` both rounds — length healed — but the SURVIVING elements
// differed round to round). HASH/SET/MAP don't have this gap because their entries
// are individually addressed and durableEntryLogIR/durableSlotLogIR already log
// each one; an array's N element cells have no such per-slot identity to hang a
// per-write log off without paying an idempotent-scan on EVERY store — ruinous for
// .sort()/.reverse() (O(n) or O(n log n) swaps, each a separate write) and no
// cheaper than the alternative below for the bulk ops (.fill/.splice/.copyWithin)
// that dominate the broken-op list.
//
// Fix: WHOLE-ARRAY snapshot-on-first-touch, not per-element logging. The first
// mutating call of a round to a given durable array (header-changing OR
// element-changing — `__durable_arr_snap`'s own idempotent-per-`off` scan, mirroring
// `__durable_fwd_log`'s, makes call ORDER irrelevant: whichever site touches this
// array first this round does the real work, every later site this round is a cheap
// no-op) memcpy's its CURRENT `len*8` live bytes into a fresh shadow buffer and logs
// (off, len, cap, shadow) — ONE bounded copy per touched durable array per round,
// not one log call per element write. `_clear()`'s `__durable_arr_heal` (core.js)
// restores the header words from the log AND memcpy's the shadow back — exact
// byte-for-byte data recovery (unlike durableSlotLogIR's collection-value heal,
// which only guarantees "not a dangling pointer" and gives up the true prior value
// as unrecoverable; arrays need the true value back, not just a safe substitute, to
// satisfy the splice repro's "reads back wrong DATA" complaint). Reading CURRENT
// len at the call site is only safe because it's captured at the round's true FIRST
// touch (idempotency, same reasoning as durableLenLogIR) — every LATER call this
// round, however it got there, is protected by an ALREADY-correct snapshot.
// ARRAY-only by design: replaces durableLenLogIR/durableFwdLogIR at every array.js
// call site (arrGrow's relocation, __arr_set_idx_ptr, __arr_push1, __arr_set_length,
// __arr_unshift, __arr_splice, __arr_fill, __arr_copyWithin, .reverse, .sort) except
// __arr_shift (left on the old header-only mechanism — see that function's own
// comment: an in-place shift's rebasing is documented as legitimate persistent
// state, a header-identity choice orthogonal to per-element data corruption, not
// touched by this fix) and __set_len's non-ARRAY branch (TYPED/HASH/SET/MAP share
// __set_len's generic tag dispatch but have different entry strides — this helper's
// `len*8`-byte-cell assumption is array-specific; __set_len keeps durableLenLogIR
// for those). Collections keep durableFwdLogIR/durableLenLogIR unchanged for their
// OWN table-header growth — this is a parallel, independent mechanism, not a
// replacement of the shared one.
export const durableArrSnapIR = (base) => {
  if (!ctx.scope.globals.has('__heap_reset')) return ''
  return `
    (if (i32.lt_u (local.get $${base}) ${heapResetWat()})
      (then (call $__durable_arr_snap (local.get $${base}))))`
}

// IR-node (array-tree) twin of durableArrSnapIR, for the two array mutators built as
// raw IR arrays instead of WAT-template strings (.reverse/.sort — emitArrayReverseInPlace/
// emitArraySortInPlace, module/array.js — a callback comparator can't be spliced into a
// backtick template) and the no-insert-args `.splice(start, count)` inline emitter
// (ctx.core.emit['.splice'], module/array.js), which was found — in the course of this
// fix — to have NO durable header-length log at all (a separate, narrower gap than the
// per-element one, since it's a DIFFERENT code path than the `__arr_splice` stdlib
// function the heal-length session patched: that one only handles the WITH-inserts
// overload). This one call, added to that emitter, fixes both gaps for that path at once.
export const durableArrSnapNode = (base) => {
  if (!ctx.scope.globals.has('__heap_reset')) return ['nop']
  return ['if', ['i32.lt_u', ['local.get', `$${base}`], ['global.get', '$__heap_reset']],
    ['then', ['call', '$__durable_arr_snap', ['local.get', `$${base}`]]]]
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
// (unforgeable, deref-free in every eq family) — and decrements the table len,
// that probes pass over and __coll_order/len-sized iterations skip. The slot
// stays occupied until the table grows (zombies never resurrect: nothing
// eq-matches TOMB_NAN). Entry addresses are 8-aligned → bit0 is free. See
// durableSlotRelogIR below for why the logged address must stay accurate if a
// LATER delete this same round moves this entry before the log is healed.
export const durableEntryLogIR = (slotLocal, offLocal) => {
  if (!ctx.scope.globals.has('__heap_reset')) return ''
  return `
    (if (i32.lt_u (local.get $${slotLocal}) ${heapResetWat()})
      (then (call $__durable_slot_log (i32.or (local.get $${slotLocal}) (i32.const 1)) (local.get $${offLocal}))))`
}

// genDelete's backward-shift relocates a live entry's bytes (memory.copy) to
// close the gap left by the removed key. Any durable-slot log recorded earlier
// THIS round (durableEntryLogIR above, or durableSlotLogIR — a value write into
// a durable slot) may have captured a physical address inside the entry range
// being moved; left un-adjusted, that log then points at whatever the shift left
// behind (a different entry, or nothing), so __durable_slot_heal zombies/decrements
// the WRONG data at _clear() while the entry that should have died survives with
// a live hash word — __coll_order finds it as a garbage-keyed phantom. Slides any
// logged address inside [oldLocal, oldLocal+entrySize) by the same delta the copy
// just applied, keeping the log accurate through however many shifts happen before
// heal runs. Gated on $__durable_slot_n != 0 (read, not just the compile-time
// __heap_reset gate) so an ordinary (non-durable, or durable-but-nothing-logged-
// yet) delete — the overwhelmingly common case — pays one global read and a
// forward branch, never the call.
export const durableSlotRelogIR = (oldLocal, newLocal, entrySize) => {
  if (!ctx.scope.globals.has('__heap_reset')) return ''
  return `
    (if (global.get $__durable_slot_n)
      (then (call $__durable_slot_relog (local.get $${oldLocal}) (local.get $${newLocal}) (i32.const ${entrySize}))))`
}

// The OTHER thing that can happen to a logged address before it's healed: the
// entry (or the durable slot a value was logged against) is genuinely deleted
// THIS SAME round, before _clear() ever runs. genDelete already decremented the
// table's real length for that delete — a stale log left pointing at the
// (zeroed, or later reused) address would make __durable_slot_heal decrement
// AGAIN and/or corrupt whatever unrelated entry has since taken the address.
// Call with the MATCHED entry's own address ($slot, captured once before the
// backward-shift walk even starts) — not the loop's final vacated position
// ($i once the walk ends). Those are the same address only when the walk needs
// no shift; when it does, some OTHER live entry gets physically copied INTO
// $slot to close the gap (and durableSlotRelogIR, called at each shift hop,
// correctly moves THAT entry's own pending log along with it) — so by the time
// the walk ends, $slot holds someone else's now-relocated data and $i is the
// genuinely empty tail, while the KEY actually being removed was $slot all
// along. Cancelling at the wrong (post-shift $i) address left the removed
// key's own log live: __durable_slot_heal then zombied and double-decremented
// whatever entry the shift had relocated INTO $slot — a real, live, unrelated
// entry silently deleted (native repro: 2 durable inserts into the same table
// this round, delete only the FIRST — if deleting it backward-shifts the
// SECOND into its slot, that second entry vanishes at the next _clear() even
// though nothing ever asked for it to be removed).
export const durableSlotCancelIR = (addrLocal, entrySize) => {
  if (!ctx.scope.globals.has('__heap_reset')) return ''
  return `
    (if (global.get $__durable_slot_n)
      (then (call $__durable_slot_cancel (local.get $${addrLocal}) (i32.const ${entrySize}))))`
}
