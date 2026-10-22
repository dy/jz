/**
 * Records: the named properties of an array whose names the program fixes
 * (src/compile/array-records.js), in slots its header's property word names.
 *
 * The word is a RECORD pointer, its aux the layout; the block behind it:
 *
 *   [-16: i32 names][-12: i32 layout][-8: i32 inserted][-4: i32 words]
 *   [slot 0 … slot names-1][a word of order bytes, a layout of several names]
 *
 * A slot holds its property's value, or TOMB_NAN while the array has none of
 * that name. A layout of several names keeps the order of their first stores,
 * slot indices a byte each after the slots (enumeration lists names in it);
 * a deletion takes the name out of the list. The layout's names are the static
 * table `$__rec_tbl` (src/wat/assemble/start-fn.js): per layout a static array
 * of key strings, as `$__schema_tbl` is per object layout.
 *
 * Only a site that names a layout makes a record (`__rec_set`), in an array
 * whose word is still zero. The dynamic paths (collection.js, object.js) read a
 * record as they read a dictionary (`__rec_get`, `__rec_hash`), store into one
 * a name it lays out, and turn it into a dictionary (`__rec_hash`, in place)
 * for a name it does not. The durable-receiver policy holds as for a
 * dictionary: a store on an array older than the reset mark goes to the global
 * table, and a record made at init stays as it is.
 *
 * @module collection/record
 */

import { ctx, PTR, followForwardingWat, declGlobal } from '../../src/ctx.js'
import { deps } from '../../src/bridge.js'
import { TOMB_NAN } from '../../src/ir.js'
import { encodePtrHi, ptrIsWat } from '../../layout.js'
import { heapResetWat } from './durable.js'
import { recordsOn } from '../../src/compile/array-records.js'

/** The high word of a record pointer of layout 0; a layout's is this or its id. */
export const RECORD_HI = encodePtrHi(PTR.RECORD, 0)

/** WAT i32: whether the i64 `w` (a property word) names a record. */
export const isRecordWat = (w) => ptrIsWat(PTR.RECORD, w)

/** WAT i32: the test `test` of a property word, or its naming a record where
 *  the program lays records out (the dynamic paths' "a table of properties"). */
export const orRecordWat = (test, w) => recordsOn() ? `(i32.or ${test} ${isRecordWat(w)})` : test

// The layouts' name table, laid out with the start function's tables.
const recTbl = () => { if (!ctx.scope.globals.has('__rec_tbl')) declGlobal('__rec_tbl', 'i32'); return '(global.get $__rec_tbl)' }

// Store `val` in slot `slot` (an i32 expression) at `$at` of the record `$rec`
// of `$n` names; a name stored the first time joins the order list. Locals
// `$rec $n $at $cnt`.
const putWat = (slot) => `
    (if (i32.gt_u (local.get $n) (i32.const 1))
      (then (if (i64.eq (i64.load (local.get $at)) (i64.const ${TOMB_NAN}))
        (then
          (local.set $cnt (i32.load (i32.sub (local.get $rec) (i32.const 8))))
          (i32.store8 (i32.add (i32.add (local.get $rec) (i32.shl (local.get $n) (i32.const 3))) (local.get $cnt)) ${slot})
          (i32.store (i32.sub (local.get $rec) (i32.const 8)) (i32.add (local.get $cnt) (i32.const 1)))))))
    (i64.store (local.get $at) (local.get $val))`

export default function registerRecords() {
  deps({
    __rec_new: ['__alloc'],
    __rec_set: ['__rec_set_tail', '__ptr_offset_fwd'],
    __rec_set_tail: ['__rec_new', '__dyn_set', '__ptr_offset_fwd'],
    __rec_read: ['__ptr_offset_fwd', '__dyn_get_t_h'],
    __rec_slot: ['__key_eq'],
    __rec_get: ['__rec_slot'],
    __rec_put: [],
    __rec_del: ['__rec_slot'],
    __rec_hash: ['__hash_new_small', '__hash_set_local'],
  })

  // A record of layout `rid`, `n` names: every slot absent, the order list
  // empty (a layout holds at most four names, compile/array-records.js: their
  // order list is one word).
  ctx.core.stdlib.__rec_new = `(func $__rec_new (param $rid i32) (param $n i32) (result i32)
    (local $words i32) (local $p i32) (local $i i32)
    (local.set $words (i32.add (local.get $n) (i32.gt_u (local.get $n) (i32.const 1))))
    (local.set $p (call $__alloc (i32.add (i32.const 16) (i32.shl (local.get $words) (i32.const 3)))))
    (i64.store (local.get $p) (i64.or (i64.extend_i32_u (local.get $n)) (i64.shl (i64.extend_i32_u (local.get $rid)) (i64.const 32))))
    (i64.store offset=8 (local.get $p) (i64.shl (i64.extend_i32_u (local.get $words)) (i64.const 32)))
    (local.set $p (i32.add (local.get $p) (i32.const 16)))
    (block $done (loop $slot
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (i64.store (i32.add (local.get $p) (i32.shl (local.get $i) (i32.const 3))) (i64.const ${TOMB_NAN}))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $slot)))
    (if (i32.gt_u (local.get $n) (i32.const 1))
      (then (i64.store (i32.add (local.get $p) (i32.shl (local.get $n) (i32.const 3))) (i64.const 0))))
    (local.get $p))`

  // `obj.key = val` where the site names the layout `rid`, its slot and name
  // count in `sn` (slot << 8 | names): a slot store into the record of an
  // array allocated in this round. The head the engine inlines stores where
  // the array has its record; the tail makes one where it has no properties
  // yet, and anything else (no array, a durable one, a dictionary, another
  // layout) is the dynamic store.
  const ephemeral = (off) => heapResetWat() === '(i32.const 0)' ? '(i32.const 1)' : `(i32.ge_u ${off} ${heapResetWat()})`
  ctx.core.stdlib.__rec_set = () => `(func $__rec_set (param $obj i64) (param $key i64) (param $val i64) (param $rid i32) (param $sn i32) (result i64)
    (local $off i32) (local $w i64) (local $rec i32) (local $n i32) (local $at i32) (local $cnt i32)
    (if (i32.and ${ptrIsWat(PTR.ARRAY, '(local.get $obj)')}
          (i32.ge_u (local.tee $off (i32.wrap_i64 (local.get $obj))) (i32.const 16)))
      (then
        ${followForwardingWat('$off', { lowGuard: false })}
        (local.set $w (i64.load (i32.sub (local.get $off) (i32.const 16))))
        (if (i32.and ${ephemeral('(local.get $off)')}
              (i32.eq (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))) (i32.or (i32.const ${RECORD_HI}) (local.get $rid))))
          (then
            (local.set $rec (i32.wrap_i64 (local.get $w)))
            (local.set $n (i32.and (local.get $sn) (i32.const 255)))
            (local.set $at (i32.add (local.get $rec) (i32.shl (i32.shr_u (local.get $sn) (i32.const 8)) (i32.const 3))))
            ${putWat('(i32.shr_u (local.get $sn) (i32.const 8))')}
            (return (local.get $val))))))
    (call $__rec_set_tail (local.get $obj) (local.get $key) (local.get $val) (local.get $rid) (local.get $sn)))`

  ctx.core.stdlib.__rec_set_tail = () => `(func $__rec_set_tail (param $obj i64) (param $key i64) (param $val i64) (param $rid i32) (param $sn i32) (result i64)
    (local $off i32) (local $rec i32) (local $n i32) (local $at i32) (local $cnt i32)
    (if (i32.and ${ptrIsWat(PTR.ARRAY, '(local.get $obj)')}
          (i32.ge_u (local.tee $off (i32.wrap_i64 (local.get $obj))) (i32.const 16)))
      (then
        ${followForwardingWat('$off', { lowGuard: false })}
        (if (i32.and ${ephemeral('(local.get $off)')} (i64.eqz (i64.load (i32.sub (local.get $off) (i32.const 16)))))
          (then
            (local.set $n (i32.and (local.get $sn) (i32.const 255)))
            (local.set $rec (call $__rec_new (local.get $rid) (local.get $n)))
            (i64.store (i32.sub (local.get $off) (i32.const 16))
              (i64.or (i64.shl (i64.extend_i32_u (i32.or (i32.const ${RECORD_HI}) (local.get $rid))) (i64.const 32))
                      (i64.extend_i32_u (local.get $rec))))
            (local.set $at (i32.add (local.get $rec) (i32.shl (i32.shr_u (local.get $sn) (i32.const 8)) (i32.const 3))))
            ${putWat('(i32.shr_u (local.get $sn) (i32.const 8))')}
            (return (local.get $val))))))
    (call $__dyn_set (local.get $obj) (local.get $key) (local.get $val)))`

  // The dynamic store of a name the record word `w` lays out, in its slot `slot`.
  ctx.core.stdlib.__rec_put = `(func $__rec_put (param $w i64) (param $slot i32) (param $val i64)
    (local $rec i32) (local $n i32) (local $at i32) (local $cnt i32)
    (local.set $rec (i32.wrap_i64 (local.get $w)))
    (local.set $n (i32.load (i32.sub (local.get $rec) (i32.const 16))))
    (local.set $at (i32.add (local.get $rec) (i32.shl (local.get $slot) (i32.const 3))))
    ${putWat('(local.get $slot)')})`

  // `arr.key` on an array where the site names the layout `rid` and its slot
  // (`h` the key's hash): the value the array's record of that layout holds
  // there, or else the dynamic read, which answers an absent slot, any other
  // table of properties and a durable array a round has written (its newer
  // values are the global table's).
  ctx.core.stdlib.__rec_read = () => `(func $__rec_read (param $obj i64) (param $key i64) (param $h i32) (param $rid i32) (param $slot i32) (result i64)
    (local $off i32) (local $w i64) (local $v i64)
    (if (i32.and ${ptrIsWat(PTR.ARRAY, '(local.get $obj)')}
          (i32.ge_u (local.tee $off (i32.wrap_i64 (local.get $obj))) (i32.const 16)))
      (then
        ${followForwardingWat('$off', { lowGuard: false })}
        (local.set $w (i64.load (i32.sub (local.get $off) (i32.const 16))))
        (if (i32.and (i32.eq (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))) (i32.or (i32.const ${RECORD_HI}) (local.get $rid)))
              (i32.eqz (i32.and (i32.wrap_i64 (local.get $w)) (i32.const 1))))
          (then
            (local.set $v (i64.load (i32.add (i32.wrap_i64 (local.get $w)) (i32.shl (local.get $slot) (i32.const 3)))))
            (if (i64.ne (local.get $v) (i64.const ${TOMB_NAN})) (then (return (local.get $v))))))))
    (call $__dyn_get_t_h (local.get $obj) (local.get $key)
      (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const 47)) (i64.const 15))) (local.get $h)))`

  // The slot of `key` in the layout of the record word `w`, or -1.
  ctx.core.stdlib.__rec_slot = () => `(func $__rec_slot (param $w i64) (param $key i64) (result i32)
    (local $rec i32) (local $keys i32) (local $n i32) (local $i i32) (local $k i64)
    (local.set $rec (i32.wrap_i64 (local.get $w)))
    (local.set $n (i32.load (i32.sub (local.get $rec) (i32.const 16))))
    (local.set $keys (i32.wrap_i64 (i64.load (i32.add ${recTbl()}
      (i32.shl (i32.load (i32.sub (local.get $rec) (i32.const 12))) (i32.const 3))))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $k (i64.load (i32.add (local.get $keys) (i32.shl (local.get $i) (i32.const 3)))))
      (if (i32.or (i64.eq (local.get $k) (local.get $key)) (call $__key_eq (local.get $k) (local.get $key)))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))`

  // The value `key` holds in the record word `w`, TOMB_NAN where it holds none.
  ctx.core.stdlib.__rec_get = `(func $__rec_get (param $w i64) (param $key i64) (result i64)
    (local $slot i32)
    (local.set $slot (call $__rec_slot (local.get $w) (local.get $key)))
    (if (i32.lt_s (local.get $slot) (i32.const 0)) (then (return (i64.const ${TOMB_NAN}))))
    (i64.load (i32.add (i32.wrap_i64 (local.get $w)) (i32.shl (local.get $slot) (i32.const 3)))))`

  // `delete` of `key` from the record word `w`: its slot absent, its name out of the order list.
  ctx.core.stdlib.__rec_del = `(func $__rec_del (param $w i64) (param $key i64)
    (local $rec i32) (local $slot i32) (local $n i32) (local $order i32) (local $cnt i32) (local $i i32)
    (local.set $slot (call $__rec_slot (local.get $w) (local.get $key)))
    (if (i32.lt_s (local.get $slot) (i32.const 0)) (then (return)))
    (local.set $rec (i32.wrap_i64 (local.get $w)))
    (if (i64.eq (i64.load (i32.add (local.get $rec) (i32.shl (local.get $slot) (i32.const 3)))) (i64.const ${TOMB_NAN})) (then (return)))
    (i64.store (i32.add (local.get $rec) (i32.shl (local.get $slot) (i32.const 3))) (i64.const ${TOMB_NAN}))
    (local.set $n (i32.load (i32.sub (local.get $rec) (i32.const 16))))
    (if (i32.le_u (local.get $n) (i32.const 1)) (then (return)))
    (local.set $order (i32.add (local.get $rec) (i32.shl (local.get $n) (i32.const 3))))
    (local.set $cnt (i32.load (i32.sub (local.get $rec) (i32.const 8))))
    (block $found (loop $find
      (br_if $found (i32.ge_u (local.get $i) (local.get $cnt)))
      (br_if $found (i32.eq (i32.load8_u (i32.add (local.get $order) (local.get $i))) (local.get $slot)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $find)))
    (if (i32.ge_u (local.get $i) (local.get $cnt)) (then (return)))
    (memory.copy (i32.add (local.get $order) (local.get $i)) (i32.add (i32.add (local.get $order) (local.get $i)) (i32.const 1))
      (i32.sub (i32.sub (local.get $cnt) (local.get $i)) (i32.const 1)))
    (local.set $cnt (i32.sub (local.get $cnt) (i32.const 1)))
    (i32.store8 (i32.add (local.get $order) (local.get $cnt)) (i32.const 0))
    (i32.store (i32.sub (local.get $rec) (i32.const 8)) (local.get $cnt)))`

  // A dictionary of the record word `w`'s properties in the order they were
  // first stored: what enumeration reads, and what a record turns into.
  ctx.core.stdlib.__rec_hash = () => `(func $__rec_hash (param $w i64) (result i64)
    (local $rec i32) (local $keys i32) (local $n i32) (local $cnt i32) (local $i i32) (local $slot i32) (local $v i64) (local $h i64)
    (local.set $rec (i32.wrap_i64 (local.get $w)))
    (local.set $n (i32.load (i32.sub (local.get $rec) (i32.const 16))))
    (local.set $keys (i32.wrap_i64 (i64.load (i32.add ${recTbl()}
      (i32.shl (i32.load (i32.sub (local.get $rec) (i32.const 12))) (i32.const 3))))))
    (local.set $h (i64.reinterpret_f64 (call $__hash_new_small)))
    ;; one name lists no order: its slot is its only entry
    (local.set $cnt (select (i32.load (i32.sub (local.get $rec) (i32.const 8))) (i32.const 1) (i32.gt_u (local.get $n) (i32.const 1))))
    (block $done (loop $entry
      (br_if $done (i32.ge_u (local.get $i) (local.get $cnt)))
      (local.set $slot (if (result i32) (i32.gt_u (local.get $n) (i32.const 1))
        (then (i32.load8_u (i32.add (i32.add (local.get $rec) (i32.shl (local.get $n) (i32.const 3))) (local.get $i))))
        (else (i32.const 0))))
      (local.set $v (i64.load (i32.add (local.get $rec) (i32.shl (local.get $slot) (i32.const 3)))))
      (if (i64.ne (local.get $v) (i64.const ${TOMB_NAN}))
        (then (local.set $h (call $__hash_set_local (local.get $h)
          (i64.load (i32.add (local.get $keys) (i32.shl (local.get $slot) (i32.const 3)))) (local.get $v)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $entry)))
    (local.get $h))`
}
