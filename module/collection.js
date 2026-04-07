/**
 * Collection module — Set and Map.
 *
 * Set: type=8, open addressing hash table. Entries: [hash:f64, key:f64] (16B each).
 * Map: type=9, same but entries: [hash:f64, key:f64, val:f64] (24B each).
 * aux = size (number of entries). offset = memory address.
 * Capacity stored at offset-8 (i32).
 *
 * @module collection
 */

import { emit, typed, asF64, asI32, T } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const HASH = 7, SET = 8, MAP = 9
const SET_ENTRY = 16  // hash + key
const MAP_ENTRY = 24  // hash + key + value
const INIT_CAP = 8    // initial capacity (must be power of 2)

export default () => {
  // Hash function: simple f64 → i32 hash
  ctx.stdlib['__hash'] = `(func $__hash (param $v f64) (result i32)
    (i32.wrap_i64 (i64.xor
      (i64.reinterpret_f64 (local.get $v))
      (i64.shr_u (i64.reinterpret_f64 (local.get $v)) (i64.const 32)))))`
  ctx.includes.add('__hash')

  // __map_new() → f64 — allocate empty Map (for JSON.parse, runtime creation)
  ctx.stdlib['__map_new'] = `(func $__map_new (result f64)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.const ${INIT_CAP * MAP_ENTRY + 8})))
    (i32.store (local.get $ptr) (i32.const 0))
    (i32.store (i32.add (local.get $ptr) (i32.const 4)) (i32.const ${INIT_CAP}))
    (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))
    (call $__mkptr (i32.const ${MAP}) (i32.const 0) (local.get $ptr)))`

  // === Set ===

  // new Set() → allocate table, return pointer
  // Layout: [-8:size(i32)][-4:cap(i32)][entries...]
  ctx.emit['new.Set'] = () => {
    const t = `${T}set${ctx.uniq++}`
    ctx.locals.set(t, 'i32')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', INIT_CAP * SET_ENTRY + 8]]],
      ['i32.store', ['local.get', `$${t}`], ['i32.const', 0]],  // size=0
      ['i32.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]], ['i32.const', INIT_CAP]],  // cap
      ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['i32.const', 8]]],
      ['call', '$__mkptr', ['i32.const', SET], ['i32.const', 0], ['local.get', `$${t}`]]], 'f64')
  }

  // set.add(val) → mutate set, return set
  ctx.emit['.add'] = (setExpr, val) => {
    ctx.includes.add('__set_add')
    return typed(['call', '$__set_add', asF64(emit(setExpr)), asF64(emit(val))], 'f64')
  }

  // set.has(val) → 0 or 1
  ctx.emit['.has'] = (setExpr, val) => {
    ctx.includes.add('__set_has')
    return typed(['f64.convert_i32_s', ['call', '$__set_has', asF64(emit(setExpr)), asF64(emit(val))]], 'f64')
  }

  // set.delete(val) → 0 or 1
  ctx.emit['.delete'] = (setExpr, val) => {
    ctx.includes.add('__set_delete')
    return typed(['f64.convert_i32_s', ['call', '$__set_delete', asF64(emit(setExpr)), asF64(emit(val))]], 'f64')
  }

  // set.size / map.size → from memory header (offset-8)
  ctx.emit['.size'] = (expr) => {
    return typed(['f64.convert_i32_s', ['call', '$__len', asF64(emit(expr))]], 'f64')
  }

  // WAT: set_add — linear probing, mutates size in memory, returns same pointer
  ctx.stdlib['__set_add'] = `(func $__set_add (param $set f64) (param $val f64) (result f64)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32)
    (local.set $off (call $__ptr_offset (local.get $set)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call $__hash (local.get $val)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${SET_ENTRY}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0))
        (then
          (f64.store (local.get $slot) (f64.reinterpret_i64 (i64.extend_i32_u (local.get $h))))
          (f64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $val))
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if (f64.eq (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $val))
        (then (br $done)))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (br $probe)))
    (local.get $set))`

  ctx.stdlib['__set_has'] = `(func $__set_has (param $set f64) (param $val f64) (result i32)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32) (local $tries i32)
    (local.set $off (call $__ptr_offset (local.get $set)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call $__hash (local.get $val)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${SET_ENTRY}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0)) (then (return (i32.const 0))))
      (if (f64.eq (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $val)) (then (return (i32.const 1))))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (i32.const 0))`

  ctx.stdlib['__set_delete'] = `(func $__set_delete (param $set f64) (param $val f64) (result i32)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32) (local $tries i32)
    (local.set $off (call $__ptr_offset (local.get $set)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call $__hash (local.get $val)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${SET_ENTRY}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0)) (then (return (i32.const 0))))
      (if (f64.eq (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $val))
        (then
          (f64.store (local.get $slot) (f64.const 0))
          (f64.store (i32.add (local.get $slot) (i32.const 8)) (f64.const 0))
          (return (i32.const 1))))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (i32.const 0))`

  // === Map ===

  ctx.emit['new.Map'] = () => {
    const t = `${T}map${ctx.uniq++}`
    ctx.locals.set(t, 'i32')
    // Layout: [-8:size(i32)][-4:cap(i32)][entries...]
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', INIT_CAP * MAP_ENTRY + 8]]],
      ['i32.store', ['local.get', `$${t}`], ['i32.const', 0]],  // size=0
      ['i32.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]], ['i32.const', INIT_CAP]],  // cap
      ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['i32.const', 8]]],
      ['call', '$__mkptr', ['i32.const', MAP], ['i32.const', 0], ['local.get', `$${t}`]]], 'f64')
  }

  // map.set(key, val)
  ctx.emit['.set'] = (mapExpr, key, val) => {
    ctx.includes.add('__map_set')
    return typed(['call', '$__map_set', asF64(emit(mapExpr)), asF64(emit(key)), asF64(emit(val))], 'f64')
  }

  // map.get(key)
  ctx.emit['.get'] = (mapExpr, key) => {
    ctx.includes.add('__map_get')
    return typed(['call', '$__map_get', asF64(emit(mapExpr)), asF64(emit(key))], 'f64')
  }

  ctx.stdlib['__map_set'] = `(func $__map_set (param $map f64) (param $key f64) (param $val f64) (result f64)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32)
    (local.set $off (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call $__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${MAP_ENTRY}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0))
        (then
          (f64.store (local.get $slot) (f64.reinterpret_i64 (i64.extend_i32_u (local.get $h))))
          (f64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))
          (f64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if (f64.eq (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))
        (then
          (f64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (br $done)))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (br $probe)))
    (local.get $map))`

  ctx.stdlib['__map_get'] = `(func $__map_get (param $map f64) (param $key f64) (result f64)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32) (local $tries i32)
    (local.set $off (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call $__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${MAP_ENTRY}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0)) (then (return (f64.const 0))))
      (if (f64.eq (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))
        (then (return (f64.load (i32.add (local.get $slot) (i32.const 16))))))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (f64.const 0))`

  // === HASH — dynamic string-keyed object (type=7) ===
  // Same memory layout as Map (24-byte entries: hash, key, value).
  // Difference: uses content-based string hash + equality (SSO-safe).
  // Used for JSON.parse objects and dynamic property access.

  // FNV-1a hash of string content (works on both SSO and heap strings)
  ctx.stdlib['__str_hash'] = `(func $__str_hash (param $s f64) (result i32)
    (local $h i32) (local $len i32) (local $i i32)
    (local.set $h (i32.const 0x811c9dc5))
    (local.set $len (call $__str_byteLen (local.get $s)))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $h (i32.mul (i32.xor (local.get $h) (call $__char_at (local.get $s) (local.get $i))) (i32.const 0x01000193)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    ;; Ensure >= 2 (0=empty, 1=tombstone)
    (if (result i32) (i32.le_s (local.get $h) (i32.const 1))
      (then (i32.add (local.get $h) (i32.const 2))) (else (local.get $h))))`

  // String content equality (handles SSO vs heap cross-comparison)
  ctx.stdlib['__str_eq'] = `(func $__str_eq (param $a f64) (param $b f64) (result i32)
    (local $len i32) (local $i i32)
    ;; Fast path: bitwise equal
    (if (i64.eq (i64.reinterpret_f64 (local.get $a)) (i64.reinterpret_f64 (local.get $b)))
      (then (return (i32.const 1))))
    ;; Compare lengths
    (local.set $len (call $__str_byteLen (local.get $a)))
    (if (i32.ne (local.get $len) (call $__str_byteLen (local.get $b)))
      (then (return (i32.const 0))))
    ;; Compare chars (works for any SSO/heap combination via __char_at)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
      (if (i32.ne (call $__char_at (local.get $a) (local.get $i))
                  (call $__char_at (local.get $b) (local.get $i)))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.const 1))`

  ctx.stdlib['__hash_new'] = `(func $__hash_new (result f64)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.const ${INIT_CAP * MAP_ENTRY + 8})))
    (i32.store (local.get $ptr) (i32.const 0))
    (i32.store (i32.add (local.get $ptr) (i32.const 4)) (i32.const ${INIT_CAP}))
    (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))
    (call $__mkptr (i32.const ${HASH}) (i32.const 0) (local.get $ptr)))`

  ctx.stdlib['__hash_set'] = `(func $__hash_set (param $obj f64) (param $key f64) (param $val f64) (result f64)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32)
    (local $size i32) (local $newptr i32) (local $newcap i32) (local $i i32)
    (local $oldslot i32) (local $newidx i32) (local $newslot i32)
    (local.set $off (call $__ptr_offset (local.get $obj)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $size (i32.load (i32.sub (local.get $off) (i32.const 8))))
    ;; Grow if load factor > 75%: size * 4 >= cap * 3
    (if (i32.ge_s (i32.mul (local.get $size) (i32.const 4)) (i32.mul (local.get $cap) (i32.const 3)))
      (then
        (local.set $newcap (i32.shl (local.get $cap) (i32.const 1)))
        (local.set $newptr (call $__alloc (i32.add (i32.const 8) (i32.mul (local.get $newcap) (i32.const ${MAP_ENTRY})))))
        (i32.store (local.get $newptr) (i32.const 0))
        (i32.store (i32.add (local.get $newptr) (i32.const 4)) (local.get $newcap))
        (local.set $newptr (i32.add (local.get $newptr) (i32.const 8)))
        ;; Rehash existing entries
        (local.set $i (i32.const 0))
        (block $rd (loop $rl
          (br_if $rd (i32.ge_s (local.get $i) (local.get $cap)))
          (local.set $oldslot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const ${MAP_ENTRY}))))
          (if (f64.ne (f64.load (local.get $oldslot)) (f64.const 0))
            (then
              (local.set $h (call $__str_hash (f64.load (i32.add (local.get $oldslot) (i32.const 8)))))
              (local.set $newidx (i32.and (local.get $h) (i32.sub (local.get $newcap) (i32.const 1))))
              (block $ins (loop $probe2
                (local.set $newslot (i32.add (local.get $newptr) (i32.mul (local.get $newidx) (i32.const ${MAP_ENTRY}))))
                (br_if $ins (f64.eq (f64.load (local.get $newslot)) (f64.const 0)))
                (local.set $newidx (i32.and (i32.add (local.get $newidx) (i32.const 1)) (i32.sub (local.get $newcap) (i32.const 1))))
                (br $probe2)))
              (f64.store (local.get $newslot) (f64.load (local.get $oldslot)))
              (f64.store (i32.add (local.get $newslot) (i32.const 8)) (f64.load (i32.add (local.get $oldslot) (i32.const 8))))
              (f64.store (i32.add (local.get $newslot) (i32.const 16)) (f64.load (i32.add (local.get $oldslot) (i32.const 16))))
              (i32.store (i32.sub (local.get $newptr) (i32.const 8))
                (i32.add (i32.load (i32.sub (local.get $newptr) (i32.const 8))) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $rl)))
        ;; Update pointer to new table
        (local.set $off (local.get $newptr))
        (local.set $cap (local.get $newcap))
        (local.set $obj (call $__mkptr (i32.const ${HASH}) (i32.const 0) (local.get $newptr)))))
    ;; Insert/update
    (local.set $h (call $__str_hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${MAP_ENTRY}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0))
        (then
          (f64.store (local.get $slot) (f64.reinterpret_i64 (i64.extend_i32_u (local.get $h))))
          (f64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))
          (f64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if (call $__str_eq (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))
        (then
          (f64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (br $done)))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (br $probe)))
    (local.get $obj))`

  ctx.stdlib['__hash_get'] = `(func $__hash_get (param $obj f64) (param $key f64) (result f64)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32) (local $tries i32)
    (local.set $off (call $__ptr_offset (local.get $obj)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call $__str_hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${MAP_ENTRY}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0)) (then (return (f64.const 0))))
      (if (call $__str_eq (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))
        (then (return (f64.load (i32.add (local.get $slot) (i32.const 16))))))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (f64.const 0))`
}
