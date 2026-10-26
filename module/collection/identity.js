/**
 * The identity a Set or Map hashes an array key by.
 *
 * A Set or Map hashes a key by its bits (module/collection.js `__map_hash`),
 * and an array's bits name the storage it lives in: a grow that relocates it
 * hands its own binding the new block's pointer, while a reference taken
 * before still names the old one (it forwards). One array would hash two ways
 * and `m.get(a)` miss after `a.push(…)`. A HASH, Set or Map that grows keeps
 * every reference's bits (its holders keep the forwarding pointer), and a
 * compaction rehashes what it moved (module/core/compact.js), so only an
 * array needs more.
 *
 * An array hashes by its identity: an offset it lived at, kept as the array
 * moves. An insertion into a Set or Map pins it (`__arr_pin`), writing
 * the identity word [id, IDENT_HI] where it has none, at the place
 * `__arr_ident_at` finds from the array's properties' word (off-16):
 *
 *   - a word of 0 or the global table's mark (-1) becomes the identity word,
 *     which the dynamic-property paths read as they read the mark: the array's
 *     properties, if any, live in the global table (collection.js `__dyn_get_t_h`);
 *   - a dictionary of properties keeps the word in its own header, unused by a
 *     dictionary, which a growth copies (collection/upsert.js `genUpsertGrow`)
 *     and a record turned dictionary starts with (record.js `__rec_hash`);
 *   - a record's own offset names it: a record moves only in a compaction,
 *     which rehashes the Sets and Maps after;
 *   - a shifted array's word is its base's mark (array.js arrBaseWat): the
 *     base's header keeps the word, which its first shift leaves as the
 *     identity word or zero (array.js `__arr_shift`).
 *
 * A grow carries the word to the new block (array.js arrGrow); a property
 * stored on a pinned array of no dictionary goes to the global table, as for
 * the mark. An unpinned array is in no table, so its identity is any offset
 * it holds: its live one.
 *
 * Kept only where some insertion into a Set or Map may take an array for its
 * key (`noteKeys`, `arrayKeysOn`).
 *
 * @module collection/identity
 */

import { ctx, PTR, LAYOUT, setLinkDemand } from '../../src/ctx.js'
import { K, bitOf, tagsOf } from '../../src/summary/kind.js'
import { recordsOn } from '../../src/compile/array-records.js'
import { ptrIsWat } from '../../layout.js'
import { deps } from '../../src/bridge.js'

/** WAT: an insertion's prologue that pins its key `key` (an i64 expression) where
 *  it is an array; nothing where arrays keep no identity. */
export const pinKeyWat = (key) => arrayKeysOn() ? `(if ${ptrIsWat(PTR.ARRAY, key)}
      (then (if (i32.ge_u (i32.wrap_i64 ${key}) (i32.const 16)) (then (if (i32.eqz ${pinnedWat(key)}) (then (call $__arr_pin ${key})))))))` : ''

// WAT i32: whether the header at the array `key`'s own offset (a stub's, where
// it moved: the move carried the word) holds an identity word or a record,
// which names it; anything else asks __arr_pin.
const pinnedWat = (key) => {
  const w = `(i64.load (i32.sub (i32.wrap_i64 ${key}) (i32.const 16)))`
  return recordsOn() ? `(i32.or ${isIdentWat(w)} ${isRecordWat(`(i64.and ${w} (i64.const -2))`)})` : isIdentWat(w)
}

/** Whether arrays keep an identity: some insertion into a Set or Map may take
 *  an array for its key (`noteKeys`). */
export const arrayKeysOn = () => ctx.linkDemand.arrayKeys === true

/** An insertion into a Set or Map whose key is `node` (no node: keys an emitter
 *  cannot name, a source's elements or a callback's results), at emit time. */
export const noteKeys = (node) => {
  const k = node === undefined ? null : ctx.summary?.at(ctx.func.current)?.kindOfExpr(node)
  if (k == null || (tagsOf(k) & bitOf(K.ARRAY)) !== 0) setLinkDemand('arrayKeys')
}

/** The identity word's high half; no pointer, the global table's mark or a
 *  shifted array's base mark has it. */
const IDENT_HI = -2

/** WAT i32: whether the i64 `w` is an identity word. */
const isIdentWat = (w) => `(i32.eq (i32.wrap_i64 (i64.shr_u ${w} (i64.const 32))) (i32.const ${IDENT_HI}))`

/** WAT i64: the identity word of the i32 offset `id`. */
export const identWordWat = (id) => `(i64.or (i64.const 0xFFFFFFFE00000000) (i64.extend_i32_u ${id}))`

// A record pointer (record.js isRecordWat, not imported: record.js imports this module).
const isRecordWat = (w) => ptrIsWat(PTR.RECORD, w)

const hashTagWat = (w) => `(i32.eq (i32.wrap_i64 (i64.and (i64.shr_u ${w} (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))) (i32.const ${PTR.HASH}))`

export default function registerIdentity() {
  deps({
    __arr_ident_at: ['__ptr_offset'],
    __arr_ident_word: ['__arr_ident_at'],
    __arr_pin: ['__arr_ident_at', '__arr_ident_word', '__ptr_offset'],
  })

  // Where the identity word of the array at live header `$off` lives or goes:
  // its properties' word, its base's for a shifted array (arrBaseWat's mark
  // [base, -1]), its dictionary's header word; minus the offset of a record,
  // which names it.
  ctx.core.stdlib['__arr_ident_at'] = () => `(func $__arr_ident_at (param $off i32) (result i32)
    (local $w i64) (local $at i32)
    (local.set $at (i32.sub (local.get $off) (i32.const 16)))
    (local.set $w (i64.load (local.get $at)))
    (if (i32.and (i32.eq (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))) (i32.const -1))
                 (i32.ne (i32.wrap_i64 (local.get $w)) (i32.const -1)))
      (then
        (local.set $at (i32.wrap_i64 (local.get $w)))
        (local.set $at (i32.sub (select (i32.sub (local.get $off) (i32.const 8)) (local.get $at) (i32.eq (local.get $at) (local.get $off))) (i32.const 16)))
        (local.set $w (i64.load (local.get $at)))))
    (if ${isIdentWat('(local.get $w)')} (then (return (local.get $at))))
    (local.set $w (i64.and (local.get $w) (i64.const -2)))
    (if ${hashTagWat('(local.get $w)')} (then (return (i32.sub (call $__ptr_offset (local.get $w)) (i32.const 16)))))
    ${recordsOn() ? `(if ${isRecordWat('(local.get $w)')} (then (return (i32.sub (i32.const 0) (i32.wrap_i64 (local.get $w))))))` : ''}
    (local.get $at))`

  // The identity word of the array at live header `$off`, or 0 where it has none.
  ctx.core.stdlib['__arr_ident_word'] = () => `(func $__arr_ident_word (param $off i32) (result i64)
    (local $at i32) (local $w i64)
    (if (i32.lt_u (local.get $off) (i32.const 16)) (then (return (i64.const 0))))
    (local.set $at (call $__arr_ident_at (local.get $off)))
    ${recordsOn() ? `(if (i32.lt_s (local.get $at) (i32.const 0)) (then (return ${identWordWat('(i32.sub (i32.const 0) (local.get $at))')})))` : ''}
    (local.set $w (i64.load (local.get $at)))
    (select (i64.and (local.get $w) (i64.const -2)) (i64.const 0) ${isIdentWat('(local.get $w)')}))`

  // Pin the array `$v` an insertion takes for its key: its identity word
  // written where it has none.
  ctx.core.stdlib['__arr_pin'] = () => `(func $__arr_pin (param $v i64)
    (local $off i32) (local $at i32)
    (local.set $off (call $__ptr_offset (local.get $v)))
    (if (i32.lt_u (local.get $off) (i32.const 16)) (then (return)))
    (local.set $at (call $__arr_ident_at (local.get $off)))
    ${recordsOn() ? `;; a record names it by its own offset (minus it here)
    (if (i32.lt_s (local.get $at) (i32.const 0)) (then (return)))` : ''}
    (if (i32.eqz ${isIdentWat('(i64.load (local.get $at))')})
      (then (i64.store (local.get $at) ${identWordWat('(local.get $off)')}))))`
}
