/**
 * Core module - Number, Object, Array, JSON, Set, Map utilities
 *
 * Covers everything that's not pure math or binary/typed arrays.
 * Many functions require memory/pointer operations that may not be implemented yet.
 *
 * @module core
 */

import { emit, typed, asF64 } from '../src/compile.js'

export default (ctx) => {
  const call = (name, ...args) => (ctx.includes.add(name), typed(['call', `$${name}`, ...args.map(a => asF64(emit(a)))], 'f64'))

  // Number utilities
  ctx.emit['core.parseIntFromCode'] = (code, radix) => call('core.parseIntFromCode', code, radix)
  ctx.emit['core.isNaN'] = a => call('core.isNaN', a)
  ctx.emit['core.isFinite'] = a => call('core.isFinite', a)
  ctx.emit['core.isInteger'] = a => call('core.isInteger', a)
  ctx.emit['isNaN'] = ctx.emit['core.isNaN']
  ctx.emit['isFinite'] = ctx.emit['core.isFinite']



  // ============================================
  // Hash utilities (internal, for Set/Map)
  // ============================================

  ctx.emit['core.__hash'] = (key) => (
    ctx.includes.add('core.__hash'),
    ['call', '$core.__hash', emit(key)]
  )
  ctx.emit['core.__key_eq'] = (a, b) => (
    ctx.includes.add('core.__key_eq'),
    ['call', '$core.__key_eq', emit(a), emit(b)]
  )

  // ============================================
  // Set operations
  // ============================================

  ctx.emit['core.Set.new'] = (cap) => (
    ctx.includes.add('core.__set_new'),
    ['call', '$core.__set_new', emit(cap)]
  )
  ctx.emit['core.Set.has'] = (set, key) => (
    ctx.includes.add('core.__hash').add('core.__key_eq').add('core.__set_has'),
    ['call', '$core.__set_has', emit(set), emit(key)]
  )
  ctx.emit['core.Set.add'] = (set, key) => (
    ctx.includes.add('core.__hash').add('core.__key_eq').add('core.__set_add'),
    ['call', '$core.__set_add', emit(set), emit(key)]
  )
  ctx.emit['core.Set.delete'] = (set, key) => (
    ctx.includes.add('core.__hash').add('core.__key_eq').add('core.__set_delete'),
    ['call', '$core.__set_delete', emit(set), emit(key)]
  )
  ctx.emit['core.Set.size'] = (set) => (
    ctx.includes.add('core.__set_size'),
    ['call', '$core.__set_size', emit(set)]
  )
  ctx.emit['core.Set.clear'] = (set) => (
    ctx.includes.add('core.__set_clear'),
    ['call', '$core.__set_clear', emit(set)]
  )

  // ============================================
  // Map operations
  // ============================================

  ctx.emit['core.Map.new'] = (cap) => (
    ctx.includes.add('core.__map_new'),
    ['call', '$core.__map_new', emit(cap)]
  )
  ctx.emit['core.Map.has'] = (map, key) => (
    ctx.includes.add('core.__hash').add('core.__key_eq').add('core.__map_has'),
    ['call', '$core.__map_has', emit(map), emit(key)]
  )
  ctx.emit['core.Map.get'] = (map, key) => (
    ctx.includes.add('core.__hash').add('core.__key_eq').add('core.__map_get'),
    ['call', '$core.__map_get', emit(map), emit(key)]
  )
  ctx.emit['core.Map.set'] = (map, key, val) => (
    ctx.includes.add('core.__hash').add('core.__key_eq').add('core.__map_set'),
    ['call', '$core.__map_set', emit(map), emit(key), emit(val)]
  )
  ctx.emit['core.Map.delete'] = (map, key) => (
    ctx.includes.add('core.__hash').add('core.__key_eq').add('core.__map_delete'),
    ['call', '$core.__map_delete', emit(map), emit(key)]
  )
  ctx.emit['core.Map.size'] = (map) => (
    ctx.includes.add('core.__map_size'),
    ['call', '$core.__map_size', emit(map)]
  )
  ctx.emit['core.Map.clear'] = (map) => (
    ctx.includes.add('core.__map_clear'),
    ['call', '$core.__map_clear', emit(map)]
  )

  // ============================================
  // JSON operations
  // ============================================

  ctx.emit['core.JSON.parse'] = (str) => (
    ctx.includes
      .add('core.__json_parse')
      .add('core.__json_parse_value')
      .add('core.__json_skip_ws')
      .add('core.__json_peek')
      .add('core.__json_advance')
      .add('core.__json_parse_string')
      .add('core.__json_parse_number')
      .add('core.__json_parse_array')
      .add('core.__json_parse_object')
      .add('core.__map_new')
      .add('core.__map_set')
      .add('core.__hash')
      .add('core.__key_eq')
      .add('math.pow'),
    ['call', '$core.__json_parse', emit(str)]
  )

  // ============================================
  // Array utilities
  // ============================================

  ctx.emit['core.Array.fill'] = (arr, val) => (
    ctx.includes.add('core.arrayFill'),
    ['call', '$core.arrayFill', emit(arr), emit(val)]
  )

  // ============================================
  // WAT stdlib implementations
  // ============================================

  // Number type checks
  ctx.stdlib['core.isNaN'] = `(func $core.isNaN (param $x f64) (result f64)
    (if (result f64) (f64.ne (local.get $x) (local.get $x)) (then (f64.const 1.0)) (else (f64.const 0.0))))`

  ctx.stdlib['core.isFinite'] = `(func $core.isFinite (param $x f64) (result f64)
    (if (result f64) (f64.eq (f64.sub (local.get $x) (local.get $x)) (f64.const 0.0))
      (then (f64.const 1.0)) (else (f64.const 0.0))))`

  ctx.stdlib['core.isInteger'] = `(func $core.isInteger (param $x f64) (result f64)
    (if (result f64) (i32.and
        (f64.eq (local.get $x) (local.get $x))
        (i32.and
          (f64.ne (f64.abs (local.get $x)) (f64.const inf))
          (f64.eq (f64.trunc (local.get $x)) (local.get $x))))
      (then (f64.const 1.0)) (else (f64.const 0.0))))`

  // parseInt from char code (0-9, a-z, A-Z)
  ctx.stdlib['core.parseIntFromCode'] = `(func $core.parseIntFromCode (param $code i32) (param $radix i32) (result f64)
    (local $digit i32)
    ;; '0'-'9' = 48-57 → 0-9
    (if (i32.and (i32.ge_s (local.get $code) (i32.const 48))
                 (i32.le_s (local.get $code) (i32.const 57)))
      (then (local.set $digit (i32.sub (local.get $code) (i32.const 48))))
    ;; 'A'-'Z' = 65-90 → 10-35
    (else (if (i32.and (i32.ge_s (local.get $code) (i32.const 65))
                       (i32.le_s (local.get $code) (i32.const 90)))
      (then (local.set $digit (i32.sub (local.get $code) (i32.const 55))))
    ;; 'a'-'z' = 97-122 → 10-35
    (else (if (i32.and (i32.ge_s (local.get $code) (i32.const 97))
                       (i32.le_s (local.get $code) (i32.const 122)))
      (then (local.set $digit (i32.sub (local.get $code) (i32.const 87))))
    ;; Invalid char
    (else (return (f64.const nan))))))))
    ;; Check if digit is valid for this radix
    (if (i32.ge_s (local.get $digit) (local.get $radix))
      (then (return (f64.const nan))))
    (f64.convert_i32_s (local.get $digit)))`

  // Hash function for f64 keys - handles strings by content, others by bits
  ctx.stdlib['core.__hash'] = `(func $core.__hash (param $key f64) (result i32)
    (local $h i32) (local $lo i32) (local $hi i32) (local $offset i32) (local $len i32) (local $i i32) (local $c i32)
    (local.set $lo (i32.wrap_i64 (i64.reinterpret_f64 (local.get $key))))
    (local.set $hi (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $key)) (i64.const 32))))
    ;; Check if string pointer: must be NaN-boxed (hi & 0xFFF80000 == 0x7FF80000) AND type=3
    (if (i32.and
          (i32.eq (i32.and (local.get $hi) (i32.const 0xFFF80000)) (i32.const 0x7FF80000))
          (i32.eq (i32.and (i32.shr_u (local.get $hi) (i32.const 15)) (i32.const 0xF)) (i32.const 3)))
      (then
        ;; String: FNV-1a hash of characters
        (local.set $offset (i32.and (local.get $lo) (i32.const 0x7FFFFFFF)))
        (local.set $len (i32.and
          (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $key)) (i64.const 31)))
          (i32.const 0xFFFF)))
        (local.set $h (i32.const 0x811c9dc5))
        (local.set $i (i32.const 0))
        (block $done (loop $loop
          (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $c (i32.load16_u (i32.add (local.get $offset) (i32.shl (local.get $i) (i32.const 1)))))
          (local.set $h (i32.mul (i32.xor (local.get $h) (local.get $c)) (i32.const 0x01000193)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $loop))))
      (else
        ;; Non-string: MurmurHash3-style bit mixing
        (local.set $h (i32.xor (local.get $lo) (local.get $hi)))
        (local.set $h (i32.mul (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 16))) (i32.const 0x85ebca6b)))
        (local.set $h (i32.mul (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 13))) (i32.const 0xc2b2ae35)))
        (local.set $h (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 16))))))
    ;; Ensure hash >= 2 (0=empty, 1=tombstone)
    (if (result i32) (i32.le_s (local.get $h) (i32.const 1))
      (then (i32.add (local.get $h) (i32.const 2)))
      (else (local.get $h))))`

  // Key equality: strings by content, others by bits
  ctx.stdlib['core.__key_eq'] = `(func $core.__key_eq (param $a f64) (param $b f64) (result i32)
    (local $hi_a i32) (local $hi_b i32) (local $off_a i32) (local $off_b i32) (local $len i32) (local $i i32)
    ;; Fast path: bitwise equal
    (if (i64.eq (i64.reinterpret_f64 (local.get $a)) (i64.reinterpret_f64 (local.get $b)))
      (then (return (i32.const 1))))
    ;; Check if both are string pointers (NaN-boxed with type=3)
    (local.set $hi_a (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $a)) (i64.const 32))))
    (local.set $hi_b (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $b)) (i64.const 32))))
    (if (i32.and
          (i32.and
            (i32.eq (i32.and (local.get $hi_a) (i32.const 0xFFF80000)) (i32.const 0x7FF80000))
            (i32.eq (i32.and (i32.shr_u (local.get $hi_a) (i32.const 15)) (i32.const 0xF)) (i32.const 3)))
          (i32.and
            (i32.eq (i32.and (local.get $hi_b) (i32.const 0xFFF80000)) (i32.const 0x7FF80000))
            (i32.eq (i32.and (i32.shr_u (local.get $hi_b) (i32.const 15)) (i32.const 0xF)) (i32.const 3))))
      (then
        ;; Both strings: compare lengths first
        (local.set $len (i32.and
          (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $a)) (i64.const 31)))
          (i32.const 0xFFFF)))
        (if (i32.ne (local.get $len) (i32.and
              (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $b)) (i64.const 31)))
              (i32.const 0xFFFF)))
          (then (return (i32.const 0))))
        ;; Compare characters
        (local.set $off_a (i32.and (i32.wrap_i64 (i64.reinterpret_f64 (local.get $a))) (i32.const 0x7FFFFFFF)))
        (local.set $off_b (i32.and (i32.wrap_i64 (i64.reinterpret_f64 (local.get $b))) (i32.const 0x7FFFFFFF)))
        (local.set $i (i32.const 0))
        (block $ne (loop $loop
          (br_if 2 (i32.ge_s (local.get $i) (local.get $len)))
          (br_if $ne (i32.ne
            (i32.load16_u (i32.add (local.get $off_a) (i32.shl (local.get $i) (i32.const 1))))
            (i32.load16_u (i32.add (local.get $off_b) (i32.shl (local.get $i) (i32.const 1))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $loop)))
        (return (i32.const 0))))
    (i32.const 0))`

  // Set operations - require __ptr_offset helper
  // NOTE: These require ctx.stdlib['__ptr_offset'], ctx.stdlib['__mkptr'], and memory globals
  // They may not work until the pointer system is fully implemented

  ctx.stdlib['core.__set_new'] = `(func $core.__set_new (param $cap i32) (result f64)
    (local $offset i32) (local $bytes i32)
    (if (i32.lt_s (local.get $cap) (i32.const 16))
      (then (local.set $cap (i32.const 16))))
    (local.set $bytes (i32.add (i32.const 16) (i32.shl (local.get $cap) (i32.const 4))))
    (local.set $offset (i32.add (global.get $__heap) (i32.const 16)))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (memory.fill (i32.sub (local.get $offset) (i32.const 16)) (i32.const 0) (local.get $bytes))
    (f64.store (i32.sub (local.get $offset) (i32.const 16)) (f64.convert_i32_s (local.get $cap)))
    (call $__mkptr (i32.const 4) (i32.const 0x8000) (local.get $offset)))`

  ctx.stdlib['core.__set_has'] = `(func $core.__set_has (param $set f64) (param $key f64) (result i32)
    (local $offset i32) (local $cap i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32)
    (local.set $offset (call $__ptr_offset (local.get $set)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $h (call $core.__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (block $found (block $not_found
      (loop $probe
        (br_if $not_found (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.shl (local.get $idx) (i32.const 4))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $not_found (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $core.__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (return (i32.const 0)))
    (i32.const 1))`

  ctx.stdlib['core.__set_add'] = `(func $core.__set_add (param $set f64) (param $key f64) (result f64)
    (local $offset i32) (local $cap i32) (local $size i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32) (local $firstDeleted i32)
    (local.set $offset (call $__ptr_offset (local.get $set)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $size (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 8)))))
    (local.set $h (call $core.__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (local.set $firstDeleted (i32.const -1))
    (block $found (block $insert
      (loop $probe
        (br_if $insert (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.shl (local.get $idx) (i32.const 4))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $insert (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.eq (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (local.get $firstDeleted) (i32.const -1))
              (then (local.set $firstDeleted (local.get $entryOff))))))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $core.__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (if (i32.ne (local.get $firstDeleted) (i32.const -1))
        (then (local.set $entryOff (local.get $firstDeleted)))
        (else (local.set $entryOff (i32.add (local.get $offset) (i32.shl (local.get $idx) (i32.const 4))))))
      (f64.store (local.get $entryOff) (f64.convert_i32_s (local.get $h)))
      (f64.store (i32.add (local.get $entryOff) (i32.const 8)) (local.get $key))
      (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.convert_i32_s (i32.add (local.get $size) (i32.const 1)))))
    (local.get $set))`

  ctx.stdlib['core.__set_delete'] = `(func $core.__set_delete (param $set f64) (param $key f64) (result i32)
    (local $offset i32) (local $cap i32) (local $size i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32)
    (local.set $offset (call $__ptr_offset (local.get $set)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $size (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 8)))))
    (local.set $h (call $core.__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (block $found (block $not_found
      (loop $probe
        (br_if $not_found (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.shl (local.get $idx) (i32.const 4))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $not_found (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $core.__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (return (i32.const 0)))
    (f64.store (local.get $entryOff) (f64.const 1))
    (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.convert_i32_s (i32.sub (local.get $size) (i32.const 1))))
    (i32.const 1))`

  ctx.stdlib['core.__set_size'] = `(func $core.__set_size (param $set f64) (result i32)
    (i32.trunc_f64_s (f64.load (i32.sub (call $__ptr_offset (local.get $set)) (i32.const 8)))))`

  ctx.stdlib['core.__set_clear'] = `(func $core.__set_clear (param $set f64) (result f64)
    (local $offset i32) (local $cap i32)
    (local.set $offset (call $__ptr_offset (local.get $set)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (memory.fill (local.get $offset) (i32.const 0) (i32.shl (local.get $cap) (i32.const 4)))
    (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.const 0))
    (local.get $set))`

  // Map operations
  ctx.stdlib['core.__map_new'] = `(func $core.__map_new (param $cap i32) (result f64)
    (local $offset i32) (local $bytes i32)
    (if (i32.lt_s (local.get $cap) (i32.const 16))
      (then (local.set $cap (i32.const 16))))
    (local.set $bytes (i32.add (i32.const 16) (i32.mul (local.get $cap) (i32.const 24))))
    (local.set $offset (i32.add (global.get $__heap) (i32.const 16)))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (memory.fill (i32.sub (local.get $offset) (i32.const 16)) (i32.const 0) (local.get $bytes))
    (f64.store (i32.sub (local.get $offset) (i32.const 16)) (f64.convert_i32_s (local.get $cap)))
    (call $__mkptr (i32.const 4) (i32.const 0xC000) (local.get $offset)))`

  ctx.stdlib['core.__map_has'] = `(func $core.__map_has (param $map f64) (param $key f64) (result i32)
    (local $offset i32) (local $cap i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32)
    (local.set $offset (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $h (call $core.__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (block $found (block $not_found
      (loop $probe
        (br_if $not_found (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.mul (local.get $idx) (i32.const 24))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $not_found (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $core.__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (return (i32.const 0)))
    (i32.const 1))`

  ctx.stdlib['core.__map_get'] = `(func $core.__map_get (param $map f64) (param $key f64) (result f64)
    (local $offset i32) (local $cap i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32)
    (local.set $offset (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $h (call $core.__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (block $found (result f64) (block $not_found
      (loop $probe
        (br_if $not_found (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.mul (local.get $idx) (i32.const 24))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $not_found (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $core.__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found (f64.load (i32.add (local.get $entryOff) (i32.const 16))))))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (f64.const 0)))`

  ctx.stdlib['core.__map_set'] = `(func $core.__map_set (param $map f64) (param $key f64) (param $val f64) (result f64)
    (local $offset i32) (local $cap i32) (local $size i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32) (local $firstDeleted i32)
    (local.set $offset (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $size (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 8)))))
    (local.set $h (call $core.__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (local.set $firstDeleted (i32.const -1))
    (block $found (block $insert
      (loop $probe
        (br_if $insert (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.mul (local.get $idx) (i32.const 24))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $insert (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.eq (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (local.get $firstDeleted) (i32.const -1))
              (then (local.set $firstDeleted (local.get $entryOff))))))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $core.__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (if (i32.ne (local.get $firstDeleted) (i32.const -1))
        (then (local.set $entryOff (local.get $firstDeleted)))
        (else (local.set $entryOff (i32.add (local.get $offset) (i32.mul (local.get $idx) (i32.const 24))))))
      (f64.store (local.get $entryOff) (f64.convert_i32_s (local.get $h)))
      (f64.store (i32.add (local.get $entryOff) (i32.const 8)) (local.get $key))
      (f64.store (i32.add (local.get $entryOff) (i32.const 16)) (local.get $val))
      (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.convert_i32_s (i32.add (local.get $size) (i32.const 1))))
      (return (local.get $map)))
    (f64.store (i32.add (local.get $entryOff) (i32.const 16)) (local.get $val))
    (local.get $map))`

  ctx.stdlib['core.__map_delete'] = `(func $core.__map_delete (param $map f64) (param $key f64) (result i32)
    (local $offset i32) (local $cap i32) (local $size i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32)
    (local.set $offset (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $size (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 8)))))
    (local.set $h (call $core.__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (block $found (block $not_found
      (loop $probe
        (br_if $not_found (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.mul (local.get $idx) (i32.const 24))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $not_found (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $core.__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (return (i32.const 0)))
    (f64.store (local.get $entryOff) (f64.const 1))
    (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.convert_i32_s (i32.sub (local.get $size) (i32.const 1))))
    (i32.const 1))`

  ctx.stdlib['core.__map_size'] = `(func $core.__map_size (param $map f64) (result i32)
    (i32.trunc_f64_s (f64.load (i32.sub (call $__ptr_offset (local.get $map)) (i32.const 8)))))`

  ctx.stdlib['core.__map_clear'] = `(func $core.__map_clear (param $map f64) (result f64)
    (local $offset i32) (local $cap i32)
    (local.set $offset (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (memory.fill (local.get $offset) (i32.const 0) (i32.mul (local.get $cap) (i32.const 24)))
    (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.const 0))
    (local.get $map))`

  // Array.fill - fill array with value
  ctx.stdlib['core.arrayFill'] = `(func $core.arrayFill (param $arr f64) (param $val f64) (result f64)
    (local $i i32) (local $len i32) (local $offset i32)
    (local.set $offset (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__ptr_len (local.get $arr)))
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
        (f64.store (i32.add (local.get $offset) (i32.shl (local.get $i) (i32.const 3))) (local.get $val))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (local.get $arr))`

  // JSON parsing - requires globals for parser state
  // NOTE: These require $__json_str, $__json_len, $__json_pos globals

  ctx.stdlib['core.__json_peek'] = `(func $core.__json_peek (result i32)
    (if (result i32) (i32.ge_s (global.get $__json_pos) (global.get $__json_len))
      (then (i32.const -1))
      (else (i32.load16_u (i32.add (global.get $__json_str)
        (i32.shl (global.get $__json_pos) (i32.const 1)))))))`

  ctx.stdlib['core.__json_advance'] = `(func $core.__json_advance (param $n i32)
    (global.set $__json_pos (i32.add (global.get $__json_pos) (local.get $n))))`

  ctx.stdlib['core.__json_skip_ws'] = `(func $core.__json_skip_ws
    (local $ch i32)
    (block $done (loop $loop
      (local.set $ch (call $core.__json_peek))
      (br_if $done (i32.and
        (i32.ne (local.get $ch) (i32.const 32))
        (i32.and (i32.ne (local.get $ch) (i32.const 9))
          (i32.and (i32.ne (local.get $ch) (i32.const 10))
            (i32.ne (local.get $ch) (i32.const 13))))))
      (call $core.__json_advance (i32.const 1))
      (br $loop))))`

  // JSON parse_string, parse_number, parse_array, parse_object, parse_value, parse
  // These are complex and require memory allocation - placeholder stubs for now

  ctx.stdlib['core.__json_parse_string'] = `(func $core.__json_parse_string (result f64)
    ;; TODO: Implement when string allocation is ready
    (f64.const 0))`

  ctx.stdlib['core.__json_parse_number'] = `(func $core.__json_parse_number (result f64)
    (local $neg i32) (local $val f64) (local $ch i32) (local $scale f64)
    (local $exp i32) (local $expNeg i32)
    (if (i32.eq (call $core.__json_peek) (i32.const 45))
      (then (local.set $neg (i32.const 1)) (call $core.__json_advance (i32.const 1))))
    (local.set $val (f64.const 0))
    (block $int_done (loop $int_loop
      (local.set $ch (call $core.__json_peek))
      (br_if $int_done (i32.or (i32.lt_s (local.get $ch) (i32.const 48))
                               (i32.gt_s (local.get $ch) (i32.const 57))))
      (local.set $val (f64.add (f64.mul (local.get $val) (f64.const 10))
        (f64.convert_i32_s (i32.sub (local.get $ch) (i32.const 48)))))
      (call $core.__json_advance (i32.const 1))
      (br $int_loop)))
    (if (i32.eq (call $core.__json_peek) (i32.const 46))
      (then
        (call $core.__json_advance (i32.const 1))
        (local.set $scale (f64.const 0.1))
        (block $frac_done (loop $frac_loop
          (local.set $ch (call $core.__json_peek))
          (br_if $frac_done (i32.or (i32.lt_s (local.get $ch) (i32.const 48))
                                    (i32.gt_s (local.get $ch) (i32.const 57))))
          (local.set $val (f64.add (local.get $val)
            (f64.mul (local.get $scale)
              (f64.convert_i32_s (i32.sub (local.get $ch) (i32.const 48))))))
          (local.set $scale (f64.mul (local.get $scale) (f64.const 0.1)))
          (call $core.__json_advance (i32.const 1))
          (br $frac_loop)))))
    (if (i32.or (i32.eq (call $core.__json_peek) (i32.const 101))
                (i32.eq (call $core.__json_peek) (i32.const 69)))
      (then
        (call $core.__json_advance (i32.const 1))
        (if (i32.eq (call $core.__json_peek) (i32.const 45))
          (then (local.set $expNeg (i32.const 1)) (call $core.__json_advance (i32.const 1)))
        (else (if (i32.eq (call $core.__json_peek) (i32.const 43))
          (then (call $core.__json_advance (i32.const 1))))))
        (local.set $exp (i32.const 0))
        (block $exp_done (loop $exp_loop
          (local.set $ch (call $core.__json_peek))
          (br_if $exp_done (i32.or (i32.lt_s (local.get $ch) (i32.const 48))
                                   (i32.gt_s (local.get $ch) (i32.const 57))))
          (local.set $exp (i32.add (i32.mul (local.get $exp) (i32.const 10))
            (i32.sub (local.get $ch) (i32.const 48))))
          (call $core.__json_advance (i32.const 1))
          (br $exp_loop)))
        (if (local.get $expNeg)
          (then (local.set $exp (i32.sub (i32.const 0) (local.get $exp)))))
        (local.set $val (f64.mul (local.get $val) (call $math.pow (f64.const 10) (f64.convert_i32_s (local.get $exp)))))))
    (if (result f64) (local.get $neg)
      (then (f64.neg (local.get $val)))
      (else (local.get $val))))`

  ctx.stdlib['core.__json_parse_array'] = `(func $core.__json_parse_array (result f64)
    ;; TODO: Implement when array allocation is ready
    (f64.const 0))`

  ctx.stdlib['core.__json_parse_object'] = `(func $core.__json_parse_object (result f64)
    ;; TODO: Implement when object/map allocation is ready
    (f64.const 0))`

  ctx.stdlib['core.__json_parse_value'] = `(func $core.__json_parse_value (result f64)
    (local $ch i32)
    (call $core.__json_skip_ws)
    (local.set $ch (call $core.__json_peek))
    (if (i32.eq (local.get $ch) (i32.const 34))
      (then
        (call $core.__json_advance (i32.const 1))
        (return (call $core.__json_parse_string))))
    (if (i32.eq (local.get $ch) (i32.const 91))
      (then
        (call $core.__json_advance (i32.const 1))
        (return (call $core.__json_parse_array))))
    (if (i32.eq (local.get $ch) (i32.const 123))
      (then
        (call $core.__json_advance (i32.const 1))
        (return (call $core.__json_parse_object))))
    (if (i32.or (i32.and (i32.ge_s (local.get $ch) (i32.const 48))
                         (i32.le_s (local.get $ch) (i32.const 57)))
                (i32.eq (local.get $ch) (i32.const 45)))
      (then (return (call $core.__json_parse_number))))
    (if (i32.eq (local.get $ch) (i32.const 116))
      (then (call $core.__json_advance (i32.const 4)) (return (f64.const 1))))
    (if (i32.eq (local.get $ch) (i32.const 102))
      (then (call $core.__json_advance (i32.const 5)) (return (f64.const 0))))
    (if (i32.eq (local.get $ch) (i32.const 110))
      (then (call $core.__json_advance (i32.const 4)) (return (f64.const 0))))
    (f64.const 0))`

  ctx.stdlib['core.__json_parse'] = `(func $core.__json_parse (param $str f64) (result f64)
    (global.set $__json_str (call $__ptr_offset (local.get $str)))
    (global.set $__json_len (call $__ptr_len (local.get $str)))
    (global.set $__json_pos (i32.const 0))
    (call $core.__json_parse_value))`

  // Globals for JSON parser state
  ctx.globals = ctx.globals || []
  ctx.globals.push('(global $__json_str (mut i32) (i32.const 0))')
  ctx.globals.push('(global $__json_len (mut i32) (i32.const 0))')
  ctx.globals.push('(global $__json_pos (mut i32) (i32.const 0))')
}
