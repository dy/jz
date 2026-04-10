/**
 * Collection module — Set, Map, HASH (dynamic string-keyed objects).
 *
 * Set: type=8, open addressing hash table. Entries: [hash:f64, key:f64] (16B each).
 * Map: type=9, same but entries: [hash:f64, key:f64, val:f64] (24B each).
 * HASH: type=7, same layout as Map but uses content-based string hash + equality.
 *
 * @module collection
 */

import { emit, emitFlat, typed, asF64, asI32, T, NULL_NAN } from '../src/compile.js'
import { ctx, inc, PTR } from '../src/ctx.js'

const SET_ENTRY = 16  // hash + key
const MAP_ENTRY = 24  // hash + key + value
const INIT_CAP = 8    // initial capacity (must be power of 2)

// Equality expressions for probe templates
const f64Eq = '(f64.eq (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))'
const strEq = '(call $__str_eq (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))'

/** Generate upsert (add/set) probe function. hasVal: store value at slot+16. */
function genUpsert(name, entrySize, hashFn, eqExpr, hasVal) {
  const valParam = hasVal ? '(param $val f64) ' : ''
  const storeVal = hasVal ? `\n          (f64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))` : ''
  const onMatch = hasVal
    ? `(then\n          (f64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))\n          (br $done))`
    : `(then (br $done))`

  return `(func $${name} (param $coll f64) (param $key f64) ${valParam}(result f64)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32)
    (local.set $off (call $__ptr_offset (local.get $coll)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${entrySize}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0))
        (then
          (f64.store (local.get $slot) (f64.reinterpret_i64 (i64.extend_i32_u (local.get $h))))
          (f64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${storeVal}
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if ${eqExpr} ${onMatch})
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (br $probe)))
    (local.get $coll))`
}

/** Generate lookup probe function.
 *  wantValue=true: return slot value, missing => NULL_NAN sentinel.
 *  wantValue=false: return i32 0/1 existence flag. */
function genLookup(name, entrySize, hashFn, eqExpr, wantValue) {
  const rt = wantValue ? 'f64' : 'i32'
  const onEmpty = wantValue
    ? `(return (f64.reinterpret_i64 (i64.const ${NULL_NAN})))`
    : '(return (i32.const 0))'
  const onFound = wantValue
    ? '(return (f64.load (i32.add (local.get $slot) (i32.const 16))))'
    : '(return (i32.const 1))'
  const notFound = wantValue
    ? `(f64.reinterpret_i64 (i64.const ${NULL_NAN}))`
    : '(i32.const 0)'

  return `(func $${name} (param $coll f64) (param $key f64) (result ${rt})
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32) (local $tries i32)
    (local.set $off (call $__ptr_offset (local.get $coll)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${entrySize}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0)) (then ${onEmpty}))
      (if ${eqExpr} (then ${onFound}))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    ${notFound})`
}

/** Generate delete probe function. Zero out entry on match. */
function genDelete(name, entrySize, hashFn, eqExpr) {
  return `(func $${name} (param $coll f64) (param $key f64) (result i32)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32) (local $tries i32)
    (local.set $off (call $__ptr_offset (local.get $coll)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${entrySize}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0)) (then (return (i32.const 0))))
      (if ${eqExpr}
        (then
          (f64.store (local.get $slot) (f64.const 0))
          (f64.store (i32.add (local.get $slot) (i32.const 8)) (f64.const 0))
          (return (i32.const 1))))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (i32.const 0))`
}

/** Generate growable upsert (for HASH). Grows table at 75% load, rehashes, then inserts. */
function genUpsertGrow(name, entrySize, hashFn, eqExpr, typeConst) {
  return `(func $${name} (param $obj f64) (param $key f64) (param $val f64) (result f64)
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
        (local.set $newptr (call $__alloc_hdr (i32.const 0) (local.get $newcap) (i32.const ${entrySize})))
        ;; Rehash existing entries
        (local.set $i (i32.const 0))
        (block $rd (loop $rl
          (br_if $rd (i32.ge_s (local.get $i) (local.get $cap)))
          (local.set $oldslot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const ${entrySize}))))
          (if (f64.ne (f64.load (local.get $oldslot)) (f64.const 0))
            (then
              (local.set $h (call ${hashFn} (f64.load (i32.add (local.get $oldslot) (i32.const 8)))))
              (local.set $newidx (i32.and (local.get $h) (i32.sub (local.get $newcap) (i32.const 1))))
              (block $ins (loop $probe2
                (local.set $newslot (i32.add (local.get $newptr) (i32.mul (local.get $newidx) (i32.const ${entrySize}))))
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
        (local.set $off (local.get $newptr))
        (local.set $cap (local.get $newcap))
        (local.set $obj (call $__mkptr (i32.const ${typeConst}) (i32.const 0) (local.get $newptr)))))
    ;; Insert/update
    (local.set $h (call ${hashFn} (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${entrySize}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0))
        (then
          (f64.store (local.get $slot) (f64.reinterpret_i64 (i64.extend_i32_u (local.get $h))))
          (f64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))
          (f64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if ${eqExpr}
        (then
          (f64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (br $done)))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (br $probe)))
    (local.get $obj))`
}


export default () => {
  // Hash function: simple f64 → i32 hash
  ctx.core.stdlib['__hash'] = `(func $__hash (param $v f64) (result i32)
    (i32.wrap_i64 (i64.xor
      (i64.reinterpret_f64 (local.get $v))
      (i64.shr_u (i64.reinterpret_f64 (local.get $v)) (i64.const 32)))))`
  inc('__hash')

  // __map_new() → f64 — allocate empty Map (for JSON.parse, runtime creation)
  ctx.core.stdlib['__map_new'] = `(func $__map_new (result f64)
    (call $__mkptr (i32.const ${PTR.MAP}) (i32.const 0)
      (call $__alloc_hdr (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY}))))`

  // === Set ===

  ctx.core.emit['new.Set'] = () => {
    const t = `${T}set${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'i32')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', INIT_CAP], ['i32.const', SET_ENTRY]]],
      ['call', '$__mkptr', ['i32.const', PTR.SET], ['i32.const', 0], ['local.get', `$${t}`]]], 'f64')
  }

  ctx.core.emit['.add'] = (setExpr, val) => {
    inc('__set_add')
    return typed(['call', '$__set_add', asF64(emit(setExpr)), asF64(emit(val))], 'f64')
  }

  ctx.core.emit['.has'] = (setExpr, val) => {
    inc('__set_has')
    return typed(['f64.convert_i32_s', ['call', '$__set_has', asF64(emit(setExpr)), asF64(emit(val))]], 'f64')
  }

  ctx.core.emit['.delete'] = (setExpr, val) => {
    inc('__set_delete')
    return typed(['f64.convert_i32_s', ['call', '$__set_delete', asF64(emit(setExpr)), asF64(emit(val))]], 'f64')
  }

  ctx.core.emit['.size'] = (expr) => {
    return typed(['f64.convert_i32_s', ['call', '$__len', asF64(emit(expr))]], 'f64')
  }

  // Generated Set probe functions
  ctx.core.stdlib['__set_add'] = genUpsert('__set_add', SET_ENTRY, '$__hash', f64Eq, false)
  ctx.core.stdlib['__set_has'] = genLookup('__set_has', SET_ENTRY, '$__hash', f64Eq, false)
  ctx.core.stdlib['__set_delete'] = genDelete('__set_delete', SET_ENTRY, '$__hash', f64Eq)

  // === Map ===

  ctx.core.emit['new.Map'] = () => {
    const t = `${T}map${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'i32')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', INIT_CAP], ['i32.const', MAP_ENTRY]]],
      ['call', '$__mkptr', ['i32.const', PTR.MAP], ['i32.const', 0], ['local.get', `$${t}`]]], 'f64')
  }

  ctx.core.emit['.set'] = (mapExpr, key, val) => {
    inc('__map_set')
    return typed(['call', '$__map_set', asF64(emit(mapExpr)), asF64(emit(key)), asF64(emit(val))], 'f64')
  }

  ctx.core.emit['.get'] = (mapExpr, key) => {
    inc('__map_get')
    return typed(['call', '$__map_get', asF64(emit(mapExpr)), asF64(emit(key))], 'f64')
  }

  // Generated Map probe functions
  ctx.core.stdlib['__map_set'] = genUpsert('__map_set', MAP_ENTRY, '$__hash', f64Eq, true)
  ctx.core.stdlib['__map_get'] = genLookup('__map_get', MAP_ENTRY, '$__hash', f64Eq, true)

  // === HASH — dynamic string-keyed object (type=7) ===

  // FNV-1a hash of string content (works on both SSO and heap strings)
  ctx.core.stdlib['__str_hash'] = `(func $__str_hash (param $s f64) (result i32)
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
  ctx.core.stdlib['__str_eq'] = `(func $__str_eq (param $a f64) (param $b f64) (result i32)
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

  ctx.core.stdlib['__hash_new'] = `(func $__hash_new (result f64)
    (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0)
      (call $__alloc_hdr (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY}))))`

  // Generated HASH probe functions
  ctx.core.stdlib['__hash_set'] = genUpsertGrow('__hash_set', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH)
  ctx.core.stdlib['__hash_get'] = genLookup('__hash_get', MAP_ENTRY, '$__str_hash', strEq, true)
  ctx.core.stdlib['__hash_has'] = genLookup('__hash_has', MAP_ENTRY, '$__str_hash', strEq, false)

  // === `in` operator: key in obj → HASH key existence check ===
  ctx.core.emit['in'] = (key, obj) => {
    inc('__hash_has')
    return typed(['call', '$__hash_has', asF64(emit(obj)), asF64(emit(key))], 'i32')
  }

  // === for...in on dynamic objects (HASH iteration) ===

  // for-in: iterate HASH entries, binding key string to loop variable
  ctx.core.emit['for-in'] = (varName, src, body) => {
    const off = `${T}ho${ctx.func.uniq++}`, cap = `${T}hc${ctx.func.uniq++}`
    const i = `${T}hi${ctx.func.uniq++}`, slot = `${T}hs${ctx.func.uniq++}`
    ctx.func.locals.set(off, 'i32'); ctx.func.locals.set(cap, 'i32')
    ctx.func.locals.set(i, 'i32'); ctx.func.locals.set(slot, 'i32')
    if (!ctx.func.locals.has(varName)) ctx.func.locals.set(varName, 'f64')
    const id = ctx.func.uniq++
    const va = asF64(emit(src))
    const bodyFlat = emitFlat(body)
    return [
      ['local.set', `$${off}`, ['call', '$__ptr_offset', va]],
      ['local.set', `$${cap}`, ['call', '$__cap', va]],
      ['local.set', `$${i}`, ['i32.const', 0]],
      ['block', `$brk${id}`, ['loop', `$loop${id}`,
        ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${cap}`]]],
        ['local.set', `$${slot}`, ['i32.add', ['local.get', `$${off}`],
          ['i32.mul', ['local.get', `$${i}`], ['i32.const', MAP_ENTRY]]]],
        ['if', ['f64.ne', ['f64.load', ['local.get', `$${slot}`]], ['f64.const', 0]],
          ['then',
            ['local.set', `$${varName}`, ['f64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]]],
            ...bodyFlat]],
        ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]]
    ]
  }
}
