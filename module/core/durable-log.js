/**
 * Durable-heap `_clear()`-survival logging — the own-memory (non-shared)
 * relocation/value-write heal-on-clear family. A "durable" allocation (below
 * `__heap_reset`, the post-init high-water mark) outlives `_clear()`; an
 * "ephemeral" one (at/above it) is this compile round's own arena, wiped
 * every round. These runtime WAT helpers log/heal the handful of relocation
 * and value-write shapes where a durable header or slot would otherwise
 * dangle across a `_clear()` — see module/collection/durable.js's
 * `heapResetWat` doc comment for the full policy these implement.
 *
 * Pure move out of module/core.js (pipeline-minimality core split) — a
 * self-contained leaf nested inside core.js's own `if (ctx.memory.shared)
 * {…} else {…}` (own-memory arm only; shared memory has no single-owner
 * high-water-mark heap pointer to log against). Zero coupling to
 * region-arena.js (the other family in that same arm): grep-verified zero
 * `__region_*` references in this file's own body, zero `__durable_*`
 * references in region-arena.js's.
 *
 * @module core/durable-log
 */
import { ctx, declGlobal, PTR, LAYOUT } from '../../src/ctx.js'
import { UNDEF_NAN, TOMB_NAN } from '../../src/ir.js'
import { nanPrefixHex, nanPrefixMaskHex, ssoBitI64Hex } from '../../layout.js'

export const registerDurableLog = () => {
  // Durable relocation log — see collection.js's durableFwdLogIR for the full
  // rationale (array/hash/set/map growth forwards a DURABLE header into an
  // EPHEMERAL new block; `_clear` must heal that back before rewinding the arena
  // or the durable alias dangles forever). `__durable_fwd_buf` is allocated
  // lazily (raw `__alloc`, no forwarding-capable header of its own — it must
  // never recurse into the bug it exists to fix) on the first durable grow of a
  // round; `__durable_fwd_heal` (wired into `__clear` post-hoc, see
  // src/wat/assemble.js) restores every logged header to its pre-grow (len, cap)
  // and resets both globals to 0 so the buffer is re-allocated fresh next round —
  // it only needs to survive from "logged this round" to "healed at this round's
  // `_clear`", never across a reset. 256 entries is a trap-on-overflow ceiling
  // for a count that is 0 in the overwhelmingly common program (real durable-
  // growth sites are a handful of compiler-internal structures, not user data).
  declGlobal('__durable_fwd_buf', 'i32')
  declGlobal('__durable_fwd_n', 'i32')
  // Idempotent per $off (scan-then-append): a durable header's FIRST touch
  // this round — whether that's a relocating grow (arrGrow/genUpsertGrow) OR
  // a plain in-place length write that still fits in existing capacity
  // (__arr_push1/__arr_set_idx_ptr/__arr_set_length/__arr_unshift/
  // __arr_splice/__set_len's durableLenLogIR call, module/collection.js) —
  // must capture the header's true pre-round (len, cap); every LATER touch
  // of the SAME header this round has to be a no-op, or it would clobber
  // the true snapshot with an already-mutated value. Concretely: push()ing
  // 4 elements into a durable array whose __start capacity was 4 bumps len
  // 0→1→2→3→4 IN PLACE with no log at all (no relocation happened yet) —
  // only the 5th push crosses into a fresh ephemeral block and finally logs,
  // but by then it reads len=4 off the header, not the true post-__start 0.
  // Healing "restored" the header to a length it never had — the corpus
  // repro (`site.push(...)` × 150 across one `_clear()`) read back `154`,
  // not `150`: the 4 leaked pre-grow pushes plus the 150 real ones. Scanning
  // pending entries for a dup is the same bounded-and-rare cost class as
  // __durable_slot_relog/__durable_slot_cancel's scans below — this log is
  // 0 entries in the overwhelmingly common program.
  ctx.core.stdlib['__durable_fwd_log'] = `(func $__durable_fwd_log (param $off i32) (param $len i32) (param $cap i32)
    (local $base i32) (local $n i32) (local $i i32) (local $sb i32)
    (local.set $n (global.get $__durable_fwd_n))
    (block $scanned (loop $scan
      (br_if $scanned (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $sb (i32.add (global.get $__durable_fwd_buf) (i32.mul (local.get $i) (i32.const 12))))
      (if (i32.eq (i32.load (local.get $sb)) (local.get $off)) (then (return)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.eqz (global.get $__durable_fwd_buf))
      (then (global.set $__durable_fwd_buf (call $__alloc (i32.const 3072)))))
    (if (i32.ge_s (local.get $n) (i32.const 256)) (then (unreachable)))
    (local.set $base (i32.add (global.get $__durable_fwd_buf) (i32.mul (local.get $n) (i32.const 12))))
    (i32.store (local.get $base) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $len))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (local.get $cap))
    (global.set $__durable_fwd_n (i32.add (local.get $n) (i32.const 1))))`
  ctx.core.stdlib['__durable_fwd_heal'] = `(func $__durable_fwd_heal
    (local $i i32) (local $n i32) (local $base i32) (local $off i32)
    (local.set $n (global.get $__durable_fwd_n))
    (block $done (loop $l
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $base (i32.add (global.get $__durable_fwd_buf) (i32.mul (local.get $i) (i32.const 12))))
      (local.set $off (i32.load (local.get $base)))
      (i32.store (i32.sub (local.get $off) (i32.const 8)) (i32.load (i32.add (local.get $base) (i32.const 4))))
      (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.load (i32.add (local.get $base) (i32.const 8))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $__durable_fwd_n (i32.const 0))
    (global.set $__durable_fwd_buf (i32.const 0)))`

  // Durable ARRAY element-data log — collection.js's durableArrSnapIR/
  // durableArrSnapNode have the full rationale: the header-only fwd log above
  // restores a durable array's (len, cap) WORDS but never the CELLS between
  // them, so any in-place element write (arr[i]=, splice/copyWithin/unshift's
  // memory.copy shifts, reverse/sort's swaps, fill's overwrite) leaks round 1's
  // data into round 2 even though the length reads back correct. WHOLE-ARRAY
  // snapshot-on-first-touch (not per-element logging — see the design comment
  // in collection.js for why): idempotent-per-`off` scan (identical shape to
  // __durable_fwd_log's above, own 256-entry/16-byte-stride table so it never
  // interacts with collections' OWN use of the fwd/slot logs), and on the
  // round's true first touch to a given durable array, reads len/cap FRESH off
  // the header (still the true pre-round values at that point, whichever site
  // got there first) and memcpy's the CURRENT `len*8` live bytes into a fresh
  // shadow block. `__durable_arr_heal` (wired into `__clear` post-hoc, like the
  // other three heals) restores the header words AND memcpy's the shadow back —
  // exact byte-for-byte recovery, not durableSlotLogIR's "value unrecoverable,
  // undefined is honest" fallback: arrays need the true prior value back to
  // satisfy the splice repro (`a.splice(1,2)` must give the SAME answer every
  // round, not just the same LENGTH). 256 entries mirrors __durable_fwd_buf's
  // own trap-on-overflow ceiling — 0 pending entries in the overwhelmingly
  // common program (most durable arrays are never mutated in place at all).
  declGlobal('__durable_arr_buf', 'i32')
  declGlobal('__durable_arr_n', 'i32')
  ctx.core.stdlib['__durable_arr_snap'] = `(func $__durable_arr_snap (param $off i32)
    (local $n i32) (local $i i32) (local $base i32) (local $len i32) (local $shadow i32)
    (local.set $n (global.get $__durable_arr_n))
    (block $scanned (loop $scan
      (br_if $scanned (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $base (i32.add (global.get $__durable_arr_buf) (i32.mul (local.get $i) (i32.const 16))))
      (if (i32.eq (i32.load (local.get $base)) (local.get $off)) (then (return)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.eqz (global.get $__durable_arr_buf))
      (then (global.set $__durable_arr_buf (call $__alloc (i32.const 4096)))))
    (if (i32.ge_s (local.get $n) (i32.const 256)) (then (unreachable)))
    (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
    (local.set $shadow (call $__alloc (i32.shl (local.get $len) (i32.const 3))))
    (memory.copy (local.get $shadow) (local.get $off) (i32.shl (local.get $len) (i32.const 3)))
    (local.set $base (i32.add (global.get $__durable_arr_buf) (i32.mul (local.get $n) (i32.const 16))))
    (i32.store (local.get $base) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $len))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (i32.store (i32.add (local.get $base) (i32.const 12)) (local.get $shadow))
    (global.set $__durable_arr_n (i32.add (local.get $n) (i32.const 1))))`
  ctx.core.stdlib['__durable_arr_heal'] = `(func $__durable_arr_heal
    (local $i i32) (local $n i32) (local $base i32) (local $off i32) (local $len i32) (local $shadow i32)
    (local.set $n (global.get $__durable_arr_n))
    (block $done (loop $l
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $base (i32.add (global.get $__durable_arr_buf) (i32.mul (local.get $i) (i32.const 16))))
      (local.set $off (i32.load (local.get $base)))
      (local.set $len (i32.load (i32.add (local.get $base) (i32.const 4))))
      (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $len))
      (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.load (i32.add (local.get $base) (i32.const 8))))
      (local.set $shadow (i32.load (i32.add (local.get $base) (i32.const 12))))
      (memory.copy (local.get $off) (local.get $shadow) (i32.shl (local.get $len) (i32.const 3)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $__durable_arr_n (i32.const 0))
    (global.set $__durable_arr_buf (i32.const 0)))`

  // Durable SLOT log — the value-write sibling of the relocation log above. A
  // collection whose storage is DURABLE (init-created dict, off < __heap_reset)
  // can receive an EPHEMERAL boxed value at runtime (a memo caching this round's
  // parsed node, a registry entry) — the slot then dangles across \`_clear\` and
  // the next round reads reused-arena garbage through it (the corpus-wide warm
  // trap: a durable literal-text→node dict handing round-1 node arrays into
  // round-2's tree). Writers call \`__durable_slot_log(addr)\` when storing an
  // ephemeral value into a durable slot (see collection.js durableSlotLogIR);
  // \`__durable_slot_heal\` (wired into \`__clear\` post-hoc, like the fwd heal)
  // overwrites every logged slot with \`undefined\` — the pointed-at data dies
  // with the arena, so entry-death is the only sound semantics. Same lazy-buffer
  // + trap-ceiling design as the fwd log; slots are 4 bytes each so one page
  // covers 1024 writes (durable-receiver writes are rare by construction).
  declGlobal('__durable_slot_buf', 'i32')
  declGlobal('__durable_slot_n', 'i32')
  ctx.core.stdlib['__is_eph_bits'] = `(func $__is_eph_bits (param $b i64) (result i32)
    (local $t i32)
    ;; boxed heap pointer: quiet-NaN prefix, heap-kind tag, non-SSO, offset past the durable watermark
    (if (i64.ne (i64.and (local.get $b) (i64.const ${nanPrefixMaskHex()})) (i64.const ${nanPrefixHex()}))
      (then (return (i32.const 0))))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    ;; heap kinds {ARRAY,BUFFER,TYPED,STRING,OBJECT,HASH,SET,MAP,CLOSURE} = bits 1-4,6-10 → 0x7DE
    (if (i32.eqz (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const 0x7DE)))
      (then (return (i32.const 0))))
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
                 (i64.ne (i64.and (local.get $b) (i64.const ${ssoBitI64Hex()})) (i64.const 0)))
      (then (return (i32.const 0))))
    (i32.ge_u (i32.wrap_i64 (i64.and (local.get $b) (i64.const 0xFFFFFFFF))) (global.get $__heap_reset)))`
  ctx.core.stdlib['__durable_slot_log'] = `(func $__durable_slot_log (param $addr i32) (param $tbl i32)
    (local $n i32) (local $base i32)
    (if (i32.eqz (global.get $__durable_slot_buf))
      (then (global.set $__durable_slot_buf (call $__alloc (i32.const 8192)))))
    (local.set $n (global.get $__durable_slot_n))
    (if (i32.ge_s (local.get $n) (i32.const 1024)) (then (unreachable)))
    (local.set $base (i32.add (global.get $__durable_slot_buf) (i32.shl (local.get $n) (i32.const 3))))
    (i32.store (local.get $base) (local.get $addr))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $tbl))
    (global.set $__durable_slot_n (i32.add (local.get $n) (i32.const 1))))`
  // A durable-slot log entry names a PHYSICAL address (the entry slot, or a value
  // word inside it) captured at LOG time. That address goes stale if the SAME
  // table's genDelete backward-shifts a LATER key across it before this round's
  // _clear() ever runs — delete relocates live bytes (memory.copy) but has no way
  // to know a log entry points into what it's about to move. A stale address then
  // makes __durable_slot_heal zombie/decrement whatever NOW occupies the old spot
  // (collateral damage to an unrelated entry) while the entry that should have
  // died survives, unTOMB'd, with a real hash word — __coll_order finds it as a
  // live, garbage-keyed phantom (native repro: durable Map, one same-round insert,
  // then delete enough OTHER keys to backward-shift the inserted entry's slot,
  // then _clear() — .size correctly hits 0 but .keys() still yields one entry).
  // Fix at the move site, not the heal: genDelete calls this for every entry it
  // relocates, sliding any logged address that fell inside the entry's old byte
  // range by the same delta the memory.copy just applied — the log stays accurate
  // through however many shifts happen before heal runs. Cheap in the (dominant)
  // no-pending-log case: $__durable_slot_n is 0 whenever no durable table received
  // a fresh insert this round, and the caller checks that BEFORE calling in (see
  // genDelete) so this function's own scan never runs on the hot delete path.
  ctx.core.stdlib['__durable_slot_relog'] = `(func $__durable_slot_relog (param $old i32) (param $new i32) (param $size i32)
    (local $i i32) (local $n i32) (local $base i32) (local $a i32) (local $bare i32)
    (local.set $n (global.get $__durable_slot_n))
    (block $done (loop $l
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $base (i32.add (global.get $__durable_slot_buf) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $a (i32.load (local.get $base)))
      (local.set $bare (i32.and (local.get $a) (i32.const -2)))
      (if (i32.and (i32.ge_u (local.get $bare) (local.get $old))
                   (i32.lt_u (local.get $bare) (i32.add (local.get $old) (local.get $size))))
        (then (i32.store (local.get $base)
          (i32.or (i32.add (local.get $new) (i32.sub (local.get $bare) (local.get $old)))
                  (i32.and (local.get $a) (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))`
  // Sibling of __durable_slot_relog above, for the OTHER thing that can happen to
  // a logged address before heal runs: the entry (or the durable slot a value was
  // logged against) gets genuinely `.delete()`d THIS SAME round, before _clear().
  // genDelete already decremented the table's real length for that delete — a
  // stale log entry left pointing at the (now zeroed, or since reused by a LATER
  // insert's probe) address would make __durable_slot_heal decrement AGAIN
  // (double-decrement: native repro — durable Map, insert a key this round, then
  // `.delete()` that same key before `_clear()`, size correctly nets to 0, but the
  // stale log still fires at clear and drives it to -1) and/or zombie or
  // value-clear whatever unrelated LIVE entry has since taken that address (a
  // second native repro: two keys durably inserted into the SAME table this
  // round, delete only the first — if that delete's backward-shift moves the
  // SECOND key into the first's old slot, the first key's own still-pending log
  // now points at the second key's relocated data; uncancelled, it zombies and
  // double-decrements the second key too, though nothing ever asked to remove
  // it). Called from genDelete with the MATCHED entry's OWN address (collection.js
  // durableSlotCancelIR's comment has the full call-site reasoning — it is NOT
  // simply "wherever the shift loop's final vacated slot lands"). Cancels by
  // zeroing the log record's own addr word — 0 is never a real logged
  // address, every log target is a heap offset well above the reserved
  // low-memory region — any pending log whose address fell inside that entry's
  // byte range, so __durable_slot_heal below skips it entirely.
  ctx.core.stdlib['__durable_slot_cancel'] = `(func $__durable_slot_cancel (param $addr i32) (param $size i32)
    (local $i i32) (local $n i32) (local $base i32) (local $a i32) (local $bare i32)
    (local.set $n (global.get $__durable_slot_n))
    (block $done (loop $l
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $base (i32.add (global.get $__durable_slot_buf) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $a (i32.load (local.get $base)))
      (local.set $bare (i32.and (local.get $a) (i32.const -2)))
      (if (i32.and (i32.ge_u (local.get $bare) (local.get $addr))
                   (i32.lt_u (local.get $bare) (i32.add (local.get $addr) (local.get $size))))
        (then (i32.store (local.get $base) (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))`
  ctx.core.stdlib['__durable_slot_heal'] = `(func $__durable_slot_heal
    (local $i i32) (local $n i32) (local $a i32) (local $base i32) (local $tbl i32)
    (local.set $n (global.get $__durable_slot_n))
    (block $done (loop $l
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $base (i32.add (global.get $__durable_slot_buf) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $a (i32.load (local.get $base)))
      (local.set $tbl (i32.load (i32.add (local.get $base) (i32.const 4))))
      ;; addr 0 marks a CANCELLED entry (__durable_slot_cancel, above) — a delete
      ;; this round removed the logged target before heal ever ran; skip it.
      (if (local.get $a) (then
      (if (i32.and (local.get $a) (i32.const 1))
        ;; bit0: ENTRY heal — this round INSERTED the entry into durable storage; a
        ;; fresh instance would not have it. Zombie it (key TOMB — probes pass over,
        ;; __coll_order skips) and decrement the table len so len-sized iteration
        ;; and .size agree. Runs AFTER __durable_fwd_heal, so a grown-then-healed
        ;; table's len is already its restored pre-grow value.
        ;;
        ;; Key-only: do NOT also clear a "value" word at $a+16. genUpsert shares
        ;; this log between SET (16-byte entries: hash@0, key@8 — no value field)
        ;; and MAP/HASH (24-byte: hash@0, key@8, value@16) — a SET's $a+16 is the
        ;; NEXT entry's hash word (or past the table's own end, for the last slot),
        ;; so writing there corrupted a neighbor's occupancy bit, planting a
        ;; phantom "live" entry __coll_order would then find (native repro: a
        ;; durable Set + one same-round insert + _clear() left .size correct
        ;; but .keys() one element too many, decoding the stray UNDEF_NAN write).
        ;; The value word is provably dead weight for MAP/HASH too — every
        ;; consumer (genLookup's probe, genUpsert's zombie-rescan, __coll_order's
        ;; gather) treats key===TOMB_NAN as skip-unconditionally and never reads
        ;; the paired value, so clearing it served no reachable purpose there
        ;; either. TOMB-ing the key alone is sufficient and stride-safe.
        (then
          (local.set $a (i32.and (local.get $a) (i32.const -2)))
          (i64.store (i32.add (local.get $a) (i32.const 8)) (i64.const ${TOMB_NAN}))
          (i32.store (i32.sub (local.get $tbl) (i32.const 8))
            (i32.sub (i32.load (i32.sub (local.get $tbl) (i32.const 8))) (i32.const 1))))
        ;; plain: VALUE heal — the entry pre-existed durably; its old value is
        ;; unrecoverable, undefined is the honest read.
        (else (i64.store (local.get $a) (i64.const ${UNDEF_NAN}))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $__durable_slot_n (i32.const 0))
    (global.set $__durable_slot_buf (i32.const 0)))`
}
