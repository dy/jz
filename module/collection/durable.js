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

import { numericArraysOn } from '../../src/compile/numeric-arrays.js'
import { ctx, LAYOUT } from '../../src/ctx.js'
import { i64Hex } from '../../layout.js'

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
// alloc:false exports no reset operation, so logging/healing would have no
// consumer and is omitted with the rest of that standalone ABI.
export const hasDurableReset = () => ctx.transform.alloc !== false && ctx.scope.globals.has('__heap_reset')
export const heapResetWat = () => hasDurableReset() ? '(global.get $__heap_reset)' : '(i32.const 0)'

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
// target (genUpsert/genUpsertGrow) is unconditionally ephemeral whenever the
// source-durable check can even fire (any allocation live past `__start`'s tail-
// capture is by construction >= the now-final `__heap_reset`), so newOff's own check
// is redundant there; requiring both keeps the invariant correct at every call site
// without a per-caller argument about what its "new" offset can be. (An array's
// shift and grow save the array whole instead: durableArrSnapIR, durableArrSnapBaseIR.)
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
  if (!hasDurableReset()) return ''
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
  if (!hasDurableReset()) return ''
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
// differed round to round). A table (a Set's, a Map's, a dictionary's) is saved
// whole at its round's first write (durableTblSnapIR); an array's N element cells
// have no per-slot identity to hang a per-write log off without paying an idempotent-scan on EVERY store — ruinous for
// .sort()/.reverse() (O(n) or O(n log n) swaps, each a separate write) and no
// cheaper than the alternative below for the bulk ops (.fill/.splice/.copyWithin)
// that dominate the broken-op list.
//
// Fix: WHOLE-ARRAY snapshot-on-first-touch, not per-element logging. The first
// mutating call of a round to a given durable array (header-changing OR
// element-changing — `__durable_arr_snap`'s own idempotent-per-`off` scan, mirroring
// `__durable_fwd_log`'s, makes call ORDER irrelevant: whichever site touches this
// array first this round does the real work, every later site this round is a cheap
// no-op) copies its CURRENT header and `len*8` live bytes (a shifted array's from
// its base, core/durable-log.js) into a record, ONE bounded copy per touched
// durable array per round, not one log call per element write. `_clear()`'s
// `__durable_arr_heal` (core/durable-log.js) copies the record back: exact
// byte-for-byte data recovery: arrays need the true value back, not a safe
// substitute, to satisfy the splice repro's "reads back wrong DATA" complaint. Reading CURRENT
// len at the call site is only safe because it's captured at the round's true FIRST
// touch (idempotency, same reasoning as durableLenLogIR) — every LATER call this
// round, however it got there, is protected by an ALREADY-correct snapshot.
// ARRAY-only by design: replaces durableLenLogIR/durableFwdLogIR at every array.js
// call site (arrGrow's relocation, __arr_set_idx_ptr, __arr_push1, __arr_set_length,
// __arr_unshift, __arr_splice, __arr_fill, __arr_copyWithin, .reverse, .sort, and
// __arr_shift through durableArrSnapBaseIR) except __set_len's non-ARRAY branch (TYPED/HASH/SET/MAP share
// __set_len's generic tag dispatch but have different entry strides — this helper's
// `len*8`-byte-cell assumption is array-specific; __set_len keeps durableLenLogIR
// for those). Collections keep durableFwdLogIR/durableLenLogIR unchanged for their
// OWN table-header growth — this is a parallel, independent mechanism, not a
// replacement of the shared one.
// The round's first store into a durable array saves it (core/durable-log.js
// `__durable_arr_snap`); every later store finds its bit set and returns. The
// helpers built from these templates (push, splice, fill, set) already pay a
// call per operation, so they ask the helper; the inliner copies their bodies
// into callers, and the bit test inline would be copied with them.
// `ptr`, the local holding the array's pointer where the helper has it: an
// array whose aux is ARRAY_RAW (compile/numeric-arrays.js) logs a raw record,
// bit 1 of the offset passed (core/durable-log.js), whose cells no walk reads.
export const durableArrSnapIR = (base, ptr = null) => {
  if (!hasDurableReset()) return ''
  const off = ptr && numericArraysOn() ? `(i32.or (local.get $${base}) ${rawSnapBitWat(`(local.get $${ptr})`)})` : `(local.get $${base})`
  return `
    (if (i32.lt_u (local.get $${base}) ${heapResetWat()})
      (then (call $__durable_arr_snap ${off})))`
}
// A shift moves the live header and keeps the base (layout.js arrBaseWat):
// the record of a shifted array is made from its base, whose bit marks it
// saved (core/durable-log.js `__durable_arr_snap`), so the shift tests the
// base's bit, the one address that stays as its header moves. The test is
// inline, as a queue drained by shift() runs it once an element: storage
// the call made itself pays the compare with the reset mark, a durable
// array saved this round the byte test, and only the round's first shift
// of a durable array the call.
export const durableArrSnapBaseIR = (base, off, ptr) => {
  if (!hasDurableReset()) return ''
  const b = `(local.get $${base})`, seen = '(global.get $__durable_arr_seen)'
  const at = numericArraysOn() ? `(i32.or (local.get $${off}) ${rawSnapBitWat(`(local.get $${ptr})`)})` : `(local.get $${off})`
  return `
    (if (i32.lt_u ${b} ${heapResetWat()})
      (then (if (i32.or (i32.eqz ${seen})
            (i32.eqz (i32.and (i32.load8_u (i32.add ${seen} ${seenCellWat(b)}))
              (i32.shl (i32.const 1) (i32.and (i32.shr_u ${b} (i32.const 3)) (i32.const 7))))))
        (then (call $__durable_arr_snap ${at})))))`
}
// Bit 1 where the pointer's aux is ARRAY_RAW (layout.js): the aux's low bit is the pointer's bit 32.
const rawSnapBitWat = (bits) => `(i32.and (i32.wrap_i64 (i64.shr_u ${bits} (i64.const 31))) (i32.const 2))`
export const rawSnapBitNode = (bits) => ['i32.and', ['i32.wrap_i64', ['i64.shr_u', bits, ['i64.const', 31]]], ['i32.const', 2]]

// A binding whose every value is a literal the running call made (the frame census's
// freshObjects, compile/analyze/frame-effects.js): only the start writes the reset mark,
// 0 as it begins, so what a call makes is never below it while that call stores into it,
// and a store through such a name needs no record and no test. A generator's or an async
// function's binding that crosses a yield or an await is a field of its frame's record
// (jzify/generators.js), no name a store goes through. `recv`, the receiver as written.
export const madeByCall = (recv) => typeof recv === 'string' && ctx.func.freshObjects?.has(recv) === true

// IR-node (array-tree) twin of durableArrSnapIR, for the two array mutators built as
// raw IR arrays instead of WAT-template strings (.reverse/.sort — emitArrayReverseInPlace/
// emitArraySortInPlace, module/array.js — a callback comparator can't be spliced into a
// backtick template) and the no-insert-args `.splice(start, count)` inline emitter
// (ctx.core.emit['.splice'], module/array.js), which was found — in the course of this
// fix — to have NO durable header-length log at all (a separate, narrower gap than the
// per-element one, since it's a DIFFERENT code path than the `__arr_splice` stdlib
// function the heal-length session patched: that one only handles the WITH-inserts
// overload). This one call, added to that emitter, fixes both gaps for that path at once.
// A direct element store (emit-assign.js storeFixedElement, call-args.js) is a
// few instructions, so here the bit test is inline: a store in a loop pays a
// byte load and a branch, and the call runs once per array per round.
// `bits`, the array's pointer as an i64 expression, read only where the call runs.
// The record is the round's: the escape flag goes down to the array as it is made, since an
// in-place store of a number is no escape the frame census counts, and a frame that restored
// the heap over the record left the log naming freed memory (optimize/arena-rewind.js
// CENSUS_SITED; the next walk of the log, module/core/reach.js `__survive`, never ended).
export const durableArrSnapNode = (base, bits = null, recv = null) => {
  if (!hasDurableReset() || madeByCall(recv)) return ['nop']
  const b = ['local.get', `$${base}`], seen = ['global.get', '$__durable_arr_seen']
  const unsaved = ['i32.or', ['i32.eqz', seen],
    ['i32.eqz', ['i32.and', ['i32.load8_u', ['i32.add', seen, seenCellNode(b)]],
      ['i32.shl', ['i32.const', 1], ['i32.and', ['i32.shr_u', b, ['i32.const', 3]], ['i32.const', 7]]]]]]
  const snap = ['call', '$__durable_arr_snap', bits && numericArraysOn() ? ['i32.or', ['local.get', `$${base}`], rawSnapBitNode(bits)] : b]
  const lower = ctx.scope.globals.has('__esc') ? [['call', '$__esc_at', b]] : []
  return ['if', ['i32.lt_u', b, ['global.get', '$__heap_reset']],
    ['then', ['if', unsaved, ['then', snap, ...lower]]]]
}

// The cell of the durable bitmap that holds an address's bit: the address
// over 64, less the stub log's table (core/stub-log.js) above it, which the
// start makes first and which holds no durable storage (`__durable_skip`
// bytes from `__durable_lo`; both 0 without one). One rule for every reader,
// spelled as the snapshots' WAT text (core/durable-log.js) and as the inline
// test's IR node above: the test asks the bit the snapshot sets.
export const seenCellWat = (off) =>
  `(i32.shr_u (i32.sub ${off} (select (global.get $__durable_skip) (i32.const 0) (i32.ge_u ${off} (global.get $__durable_lo)))) (i32.const 6))`
export const seenCellNode = (b) =>
  ['i32.shr_u', ['i32.sub', b, ['select', ['global.get', '$__durable_skip'], ['i32.const', 0], ['i32.ge_u', b, ['global.get', '$__durable_lo']]]], ['i32.const', 6]]

// A field of an object made at start receives a value that is no number (a
// pointer into the round's arena, a string of the static data or inline, an
// atom): record its prior value once. A number it keeps (README, Memory). The
// address bitmap is shared with array snapshots; an odd record address
// distinguishes a field from an array header. Callers pass an already
// evaluated value so getters and RHS effects run once.
/** Whether the i64 bits `b` name no number: a box whose tag or aux is set (a
 *  numeric NaN is a box of neither, src/ir/sentinels.js numberNanIR). The tag
 *  and the aux fill the bits between the offset and the prefix (layout.js), and
 *  a box's sign bit is clear, so that is one signed compare: above a numeric
 *  NaN's box with every offset bit set. A number reads at or below it (a NaN
 *  with its sign set, a negative value, below zero). */
const NUMBER_TOP = i64Hex(LAYOUT.NAN_PREFIX_BITS | BigInt(LAYOUT.OFFSET_MASK))
export const noNumberWat = (b) => `(i64.gt_s ${b} (i64.const ${NUMBER_TOP}))`
const noNumberNode = (b) => ['i64.gt_s', b, ['i64.const', NUMBER_TOP]]
export const durableObjSnapIR = (base, val, slot) => {
  if (!hasDurableReset()) return ''
  return `
    (if (i32.lt_u (local.get $${base}) ${heapResetWat()})
      (then (if ${noNumberWat(`(local.get $${val})`)}
        (then (call $__durable_obj_snap (i32.add (local.get $${base}) (i32.shl (local.get $${slot}) (i32.const 3))))))))`
}
export const durableObjSnapNode = (base, value, slot) => {
  if (!hasDurableReset()) return ['nop']
  const b = ['local.get', `$${base}`]
  const addr = slot === 0 ? b : ['i32.add', b, ['i32.const', slot * 8]]
  return ['if', ['i32.lt_u', b, ['global.get', '$__heap_reset']],
    ['then', ['if', noNumberNode(['i64.reinterpret_f64', value]),
      ['then', ['call', '$__durable_obj_snap', addr]]]]]
}

// An object of fixed fields made at start whose field a delete takes, or a store
// gives back: the field's value (its record, core/durable-log.js
// `__durable_obj_snap`) where `idx` names it, and the mask of its deleted fields,
// the header's word (layout.js markDeletedSlotWat), saved once a round.
export const durableMaskSnapIR = (off, idx = null) => {
  if (!hasDurableReset()) return ''
  return `
    (if (i32.lt_u (local.get $${off}) ${heapResetWat()})
      (then${idx ? `
        (call $__durable_obj_snap (i32.add (local.get $${off}) (i32.shl (local.get $${idx}) (i32.const 3))))` : ''}
        (call $__durable_words_snap (i32.sub (local.get $${off}) (i32.const 8)) (i32.const 1))))`
}

// A table (a Set's or a Map's, module/collection/ordered.js; a dictionary's,
// module/collection/upsert.js) at `off` of `bytes` is saved whole at the
// round's first write (core/durable-log.js `__durable_tbl_snap`). A table the
// call made pays the compare with the reset mark; the table saved last, the
// one a module's writes keep coming back to, a second compare with
// `__durable_tbl_last`, which the save sets and the reset clears; any other
// durable table the call, whose body tests its bit.
export const durableTblSnapIR = (off, bytes) => {
  if (!hasDurableReset()) return ''
  return `
    (if (i32.lt_u (local.get $${off}) ${heapResetWat()})
      (then (if (i32.ne (local.get $${off}) (global.get $__durable_tbl_last))
        (then (call $__durable_tbl_snap (local.get $${off}) ${bytes})))))`
}
