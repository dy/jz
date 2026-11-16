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
 * The durable-heap logs record only mutations of containers made before the reset mark, each a
 * store the census counts: its site lowers the flag to the durable receiver, so no frame restores
 * over a logging path. A frame that restored over the record left the log naming freed memory: the
 * next walk of the log (`__survive` as an outermost frame that ran an escape returns) followed what
 * a later allocation wrote there without end, and `memory.reset()` read it back and trapped.
 *
 * @module core/durable-log
 */
import { numericArraysOn } from '../../src/compile/numeric-arrays.js'
import { ctx, declGlobal, PTR, LAYOUT } from '../../src/ctx.js'
import { UNDEF_NAN } from '../../src/ir.js'
import { nanPrefixHex, nanPrefixMaskHex, ssoBitI64Hex, arrBaseWat } from '../../layout.js'
import { seenCellWat, noNumberWat } from '../collection/durable.js'

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
  // `_clear`", never across a reset. It starts at 256 entries and doubles as a
  // round fills it (`__durable_fwd_cap` the entries it has room for): a count
  // that is 0 in the overwhelmingly common program, and only a round's
  // relocations of storage older than it in any.
  declGlobal('__durable_fwd_buf', 'i32')
  declGlobal('__durable_fwd_n', 'i32')
  declGlobal('__durable_fwd_cap', 'i32')
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
  // pending entries for a dup is bounded and rare — this log is 0 entries in
  // the overwhelmingly common program.
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
      (then
        (global.set $__durable_fwd_buf (call $__alloc (i32.const 3072)))
        (global.set $__durable_fwd_cap (i32.const 256))))
    ;; full: the records move to a buffer twice the size
    (if (i32.ge_u (local.get $n) (global.get $__durable_fwd_cap))
      (then
        (local.set $base (call $__alloc (i32.mul (global.get $__durable_fwd_cap) (i32.const 24))))
        (memory.copy (local.get $base) (global.get $__durable_fwd_buf) (i32.mul (local.get $n) (i32.const 12)))
        (global.set $__durable_fwd_buf (local.get $base))
        (global.set $__durable_fwd_cap (i32.shl (global.get $__durable_fwd_cap) (i32.const 1)))))
    (local.set $base (i32.add (global.get $__durable_fwd_buf) (i32.mul (local.get $n) (i32.const 12))))
    (i32.store (local.get $base) (local.get $off))
    (i32.store offset=4 (local.get $base) (local.get $len))
    (i32.store offset=8 (local.get $base) (local.get $cap))
    (global.set $__durable_fwd_n (i32.add (local.get $n) (i32.const 1))))`
  ctx.core.stdlib['__durable_fwd_heal'] = `(func $__durable_fwd_heal
    (local $i i32) (local $n i32) (local $base i32) (local $off i32)
    (local.set $n (global.get $__durable_fwd_n))
    (block $done (loop $l
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $base (i32.add (global.get $__durable_fwd_buf) (i32.mul (local.get $i) (i32.const 12))))
      (local.set $off (i32.load (local.get $base)))
      (i32.store (i32.sub (local.get $off) (i32.const 8)) (i32.load offset=4 (local.get $base)))
      (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.load offset=8 (local.get $base)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $__durable_fwd_n (i32.const 0))
    (global.set $__durable_fwd_buf (i32.const 0))
    (global.set $__durable_fwd_cap (i32.const 0)))`

  // Durable ARRAY element-data log — collection.js's durableArrSnapIR/
  // durableArrSnapNode have the full rationale: the header-only fwd log above
  // restores a durable array's (len, cap) WORDS but never the CELLS between
  // them, so any in-place element write (arr[i]=, splice/copyWithin/unshift's
  // memory.copy shifts, reverse/sort's swaps, fill's overwrite) leaks round 1's
  // data into round 2 even though the length reads back correct. WHOLE-ARRAY
  // snapshot-on-first-touch (not per-element logging — see the design comment
  // in collection.js for why): the round's first touch of a durable array
  // reads len/cap FRESH off the header (still the true pre-round values at
  // that point, whichever site got there first) and copies the `len*8` live
  // bytes beside them. `__durable_arr_heal` (wired into `__clear` post-hoc,
  // like the relocation heal) restores the header words AND the cells —
  // exact byte-for-byte recovery: arrays need the true prior value back to
  // satisfy the splice repro (`a.splice(1,2)` must give the SAME answer every
  // round, not just the same LENGTH).
  //
  // Sized by the data, not by a ceiling: a simulation keeps its state in
  // durable arrays and writes every one of them each step, thousands of vec3
  // in one round. `__durable_arr_seen` holds one bit per durable 8-byte
  // address, so "already saved this round" is a load and a test on every later
  // store; `__durable_arr_log` heads a list of records [next, at, n, 0,
  // words], one allocation each: the `n` words from `at` as they stood, the
  // array's header and cells. Both live in the round's arena and die with
  // it. The heal walks the list newest first, as an undo log does: a word
  // two records hold takes the older's, which holds it as the round found it.
  //
  // A shifted array (layout.js arrBaseWat) is saved from its base: its
  // storage is the base's header, which forwards to the live one, the slots
  // its shifts left and the live header and cells. A shift rewrites the
  // base's forward, the live header's words and the slot after them, so a
  // record from the live header alone left the forward to the round: an
  // array shifted as the module started read wrong after a reset, and some
  // later calls never returned (test/reset-population.js with it so). The
  // base's bit marks the array saved: a later shift, whose
  // live header moved, tests that bit (module/collection/durable.js
  // durableArrSnapBaseIR), and a store at the moved header finds it here
  // and sets its own.
  declGlobal('__durable_arr_seen', 'i32')
  declGlobal('__durable_arr_log', 'i32')
  // the table saved last this round (module/collection/durable.js durableTblSnapIR)
  declGlobal('__durable_tbl_last', 'i32')
  // the stub log's table (module/core/stub-log.js), made first as the module
  // starts: no durable array lies in it, so the bitmaps skip its addresses
  // (`__durable_skip` bytes from `__durable_lo` down; both 0 without one):
  // every reader takes a bit's cell by one rule, collection/durable.js seenCellWat
  declGlobal('__durable_lo', 'i32')
  declGlobal('__durable_skip', 'i32')
  // Bit 1 of \`off\` marks an array whose elements are raw Numbers (layout.js
  // ARRAY_RAW): its record keeps the bit, and no walk reads its cells for pointers.
  ctx.core.stdlib['__durable_arr_snap'] = () => {
    // the bit of an address in the bitmap: tested, the call returns; else set
    const mark = (a) => `
    (local.set $cell (i32.add (global.get $__durable_arr_seen) ${seenCellWat(a)}))
    (local.set $bit (i32.shl (i32.const 1) (i32.and (i32.shr_u ${a} (i32.const 3)) (i32.const 7))))
    (if (i32.and (i32.load8_u (local.get $cell)) (local.get $bit)) (then (return)))
    (i32.store8 (local.get $cell) (i32.or (i32.load8_u (local.get $cell)) (local.get $bit)))`
    // where no shift is linked, every array's base is its header
    const shifts = ctx.core.includes.has('__arr_shift')
    return `(func $__durable_arr_snap (param $off i32)
    (local $cell i32) (local $bit i32) (local $n i32) (local $rec i32) (local $at i32)${shifts ? ' (local $base i32)' : ''}${numericArraysOn() ? ` (local $raw i32)
    (local.set $raw (i32.and (local.get $off) (i32.const 2)))
    (local.set $off (i32.xor (local.get $off) (local.get $raw)))` : ''}
    (if (i32.eqz (global.get $__durable_arr_seen))
      (then
        (local.set $n (i32.add (i32.shr_u (i32.sub (global.get $__heap_reset) (global.get $__durable_skip)) (i32.const 6)) (i32.const 1)))
        (global.set $__durable_arr_seen (call $__alloc (local.get $n)))
        (memory.fill (global.get $__durable_arr_seen) (i32.const 0) (local.get $n))))
    ${mark('(local.get $off)')}
    (local.set $at (i32.sub (local.get $off) (i32.const 8)))${shifts ? `
    ;; a shifted array: saved from its base, once a round
    ${arrBaseWat('$off', '$base')}
    (if (i32.ne (local.get $base) (local.get $off))
      (then ${mark('(local.get $base)')}
        (local.set $at (i32.sub (local.get $base) (i32.const 8)))))` : ''}
    ;; the words from the first saved to the last cell
    (local.set $n (i32.add (i32.shr_u (i32.sub (local.get $off) (local.get $at)) (i32.const 3)) (i32.load (i32.sub (local.get $off) (i32.const 8)))))
    (local.set $rec (call $__alloc (i32.add (i32.const 16) (i32.shl (local.get $n) (i32.const 3)))))
    (i32.store (local.get $rec) (global.get $__durable_arr_log))
    (i32.store offset=4 (local.get $rec) ${numericArraysOn() ? '(i32.or (local.get $at) (local.get $raw))' : '(local.get $at)'})
    (i32.store offset=8 (local.get $rec) (local.get $n))
    (i32.store offset=12 (local.get $rec) (i32.const 0))
    (memory.copy (i32.add (local.get $rec) (i32.const 16)) (local.get $at) (i32.shl (local.get $n) (i32.const 3)))
    (global.set $__durable_arr_log (local.get $rec)))`
  }
  // `n` words from `at`, saved as they stand at their first write of the round
  // in the array's record, which the heal copies back; the bit of `at` marks
  // them saved. A table's (below) and an object's mask of deleted fields.
  ctx.core.stdlib['__durable_words_snap'] = `(func $__durable_words_snap (param $at i32) (param $n i32)
    (local $cell i32) (local $bit i32) (local $rec i32)
    (if (i32.eqz (global.get $__durable_arr_seen))
      (then
        (local.set $rec (i32.add (i32.shr_u (i32.sub (global.get $__heap_reset) (global.get $__durable_skip)) (i32.const 6)) (i32.const 1)))
        (global.set $__durable_arr_seen (call $__alloc (local.get $rec)))
        (memory.fill (global.get $__durable_arr_seen) (i32.const 0) (local.get $rec))))
    (local.set $cell (i32.add (global.get $__durable_arr_seen) ${seenCellWat('(local.get $at)')}))
    (local.set $bit (i32.shl (i32.const 1) (i32.and (i32.shr_u (local.get $at) (i32.const 3)) (i32.const 7))))
    (if (i32.and (i32.load8_u (local.get $cell)) (local.get $bit)) (then (return)))
    (i32.store8 (local.get $cell) (i32.or (i32.load8_u (local.get $cell)) (local.get $bit)))
    (local.set $rec (call $__alloc (i32.add (i32.const 16) (i32.shl (local.get $n) (i32.const 3)))))
    (i32.store (local.get $rec) (global.get $__durable_arr_log))
    (i32.store offset=4 (local.get $rec) (local.get $at))
    (i32.store offset=8 (local.get $rec) (local.get $n))
    (i32.store offset=12 (local.get $rec) (i32.const 0))
    (memory.copy (i32.add (local.get $rec) (i32.const 16)) (local.get $at) (i32.shl (local.get $n) (i32.const 3)))
    (global.set $__durable_arr_log (local.get $rec)))`
  // A table (a Set's or a Map's, module/collection/ordered.js; a dictionary's,
  // module/collection/upsert.js), saved whole at the round's first write as an
  // array is: its header and its block of `bytes` (entries, buckets and counts),
  // to the 8 bytes the allocation rounds it to. A set, an add, a delete, a clear
  // and a growth's forward are all undone by one record, where the entries' own
  // logs (an insertion tombstoned at the reset, a value replaced by undefined)
  // left a delete, a clear and a store of a number or of a string of the
  // static data or inline in the round.
  ctx.core.stdlib['__durable_tbl_snap'] = `(func $__durable_tbl_snap (param $off i32) (param $bytes i32)
    (global.set $__durable_tbl_last (local.get $off))
    (call $__durable_words_snap (i32.sub (local.get $off) (i32.const 8))
      (i32.shr_u (i32.add (local.get $bytes) (i32.const 15)) (i32.const 3))))`
  // An object field's undo record shares the array log and address bitmap.
  // Only a store of an ephemeral pointer needs one. Recording that field,
  // rather than scanning the whole object, never interprets a neighboring
  // raw BigInt's bits as a pointer. The marked address names one saved cell.
  // Its allocation belongs to the round even when a nested frame made it.
  ctx.core.stdlib['__durable_obj_snap'] = () => `(func $__durable_obj_snap (param $off i32)
    (local $cell i32) (local $bit i32) (local $size i32) (local $rec i32)
    (if (i32.eqz (global.get $__durable_arr_seen))
      (then
        (local.set $size (i32.add (i32.shr_u (i32.sub (global.get $__heap_reset) (global.get $__durable_skip)) (i32.const 6)) (i32.const 1)))
        (global.set $__durable_arr_seen (call $__alloc (local.get $size)))
        (memory.fill (global.get $__durable_arr_seen) (i32.const 0) (local.get $size))))
    (local.set $cell (i32.add (global.get $__durable_arr_seen) ${seenCellWat('(local.get $off)')}))
    (local.set $bit (i32.shl (i32.const 1) (i32.and (i32.shr_u (local.get $off) (i32.const 3)) (i32.const 7))))
    (if (i32.and (i32.load8_u (local.get $cell)) (local.get $bit)) (then (return)))
    (i32.store8 (local.get $cell) (i32.or (i32.load8_u (local.get $cell)) (local.get $bit)))
    (local.set $rec (call $__alloc (i32.const 24)))
    (i32.store (local.get $rec) (global.get $__durable_arr_log))
    (i32.store offset=4 (local.get $rec) (i32.or (local.get $off) (i32.const 1)))
    (i32.store offset=8 (local.get $rec) (i32.const 0))
    (i32.store offset=12 (local.get $rec) (i32.const 1))
    (i64.store offset=16 (local.get $rec) (i64.load (local.get $off)))
    (global.set $__durable_arr_log (local.get $rec))${ctx.scope.globals.has('__esc') ? `
    (call $__esc_at (local.get $off))` : ''})`
  // A captured cell's record (src/ir/vars.js capturedCellSave) is the field's.
  // A call of it reaches the record's lowering of the flag, so the frame
  // around it reads the flag, but allocates nothing of the frame's: the
  // record is the round's (optimize/arena-rewind.js ROUND_ALLOCS). Counted as
  // the closure's own allocation, never run, it made an async function's
  // continuation never resume (test/async.js, bare fetch); skipped as a log
  // the census guards, a frame around it could restore over the record.
  ctx.core.stdlib['__durable_cell_snap'] = `(func $__durable_cell_snap (param $off i32) (call $__durable_obj_snap (local.get $off)))`
  ctx.core.stdlib['__durable_arr_heal'] = () => `(func $__durable_arr_heal
    (local $rec i32) (local $off i32) (local $len i32) (local $i i32) (local $was i64)
    (local.set $rec (global.get $__durable_arr_log))
    (block $done (loop $l
      (br_if $done (i32.eqz (local.get $rec)))
      (local.set $off (i32.load offset=4 (local.get $rec)))
      (local.set $len (i32.load offset=8 (local.get $rec)))
      (if (i32.and (local.get $off) (i32.const 1))
        (then${ctx.core.includes.has('__durable_obj_snap') ? `
          ;; an object field: restore its saved value while it holds no number (a number it keeps)
          (local.set $off (i32.and (local.get $off) (i32.const -2)))
          (local.set $i (i32.shl (i32.load offset=12 (local.get $rec)) (i32.const 3)))
          (block $slots (loop $slot
            (br_if $slots (i32.eqz (local.get $i)))
            (local.set $i (i32.sub (local.get $i) (i32.const 8)))
            (local.set $was (i64.load (i32.add (local.get $off) (local.get $i))))
            (if ${noNumberWat('(local.get $was)')}
              (then
                (local.set $was (i64.load (i32.add (i32.add (local.get $rec) (i32.const 16)) (local.get $i))))
                (i64.store (i32.add (local.get $off) (local.get $i))
                  (select (i64.const ${UNDEF_NAN}) (local.get $was) (call $__is_eph_bits (local.get $was))))))
            (br $slot)))` : ''})
        (else
          ;; an array: its words as they stood${numericArraysOn() ? ` (bit 1, raw cells, is no part of the address)` : ''}
          (memory.copy (i32.and (local.get $off) (i32.const -8)) (i32.add (local.get $rec) (i32.const 16)) (i32.shl (local.get $len) (i32.const 3)))))
      (local.set $rec (i32.load (local.get $rec)))
      (br $l)))
    (global.set $__durable_arr_log (i32.const 0))
    (global.set $__durable_arr_seen (i32.const 0))
    (global.set $__durable_tbl_last (i32.const 0)))`

  // Whether the bits `b` name the round's memory: a boxed heap pointer (no
  // inline string) at or past the reset mark. The field heal asks it of a
  // saved value, a captured cell's save of the value it stores.
  ctx.core.stdlib['__is_eph_bits'] = `(func $__is_eph_bits (param $b i64) (result i32)
    (local $t i32)
    ;; boxed heap pointer: quiet-NaN prefix, heap-kind tag, non-SSO, offset past the durable watermark
    (if (i64.ne (i64.and (local.get $b) (i64.const ${nanPrefixMaskHex()})) (i64.const ${nanPrefixHex()}))
      (then (return (i32.const 0))))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    ;; heap kinds {ARRAY,BUFFER,TYPED,STRING,BIGINT,OBJECT,HASH,SET,MAP,CLOSURE} = bits 1-10 → 0x7FE
    (if (i32.eqz (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const 0x7FE)))
      (then (return (i32.const 0))))
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
                 (i64.ne (i64.and (local.get $b) (i64.const ${ssoBitI64Hex()})) (i64.const 0)))
      (then (return (i32.const 0))))
    (i32.ge_u (i32.wrap_i64 (i64.and (local.get $b) (i64.const 0xFFFFFFFF))) (global.get $__heap_reset)))`
}
