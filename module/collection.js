/**
 * Collection module — Set, Map, HASH (dynamic string-keyed objects).
 *
 * Set: type=8, open addressing hash table. Entries: [hash:f64, key:f64] (16B each).
 * Map: type=9, same but entries: [hash:f64, key:f64, val:f64] (24B each).
 * HASH: type=7, same layout as Map but uses content-based string hash + equality.
 *
 * @module collection
 */

import { emit, emitFlat, typed, asF64, asI32, valTypeOf, VAL, T, NULL_NAN, UNDEF_NAN, temp, allocPtr } from '../src/compile.js'
import { ctx, inc, PTR } from '../src/ctx.js'

const SET_ENTRY = 16  // hash + key
const MAP_ENTRY = 24  // hash + key + value
const INIT_CAP = 8    // initial capacity (must be power of 2)

// Equality expressions for probe templates
const f64Eq = '(f64.eq (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))'
const strEq = '(call $__str_eq (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))'

/** Generate upsert (add/set) probe function. hasVal: store value at slot+16. */
function genUpsert(name, entrySize, hashFn, eqExpr, expectedType, hasVal) {
  const valParam = hasVal ? '(param $val f64) ' : ''
  const storeVal = hasVal ? `\n          (f64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))` : ''
  const onMatch = hasVal
    ? `(then\n          (f64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))\n          (br $done))`
    : `(then (br $done))`

  const extBranch = hasVal
    ? '(then (call $__ext_set (local.get $coll) (local.get $key) (local.get $val)) drop)'
    : '(then (nop))'
  return `(func $${name} (param $coll f64) (param $key f64) ${valParam}(result f64)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32)
    (if (i32.ne (call $__ptr_type (local.get $coll)) (i32.const ${expectedType})) (then (if (i32.eq (call $__ptr_type (local.get $coll)) (i32.const ${PTR.EXTERNAL})) ${extBranch}) (return (local.get $coll))))
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
function genLookup(name, entrySize, hashFn, eqExpr, expectedType, wantValue) {
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
    (if (i32.ne (call $__ptr_type (local.get $coll)) (i32.const ${expectedType})) (then (if (i32.eq (call $__ptr_type (local.get $coll)) (i32.const ${PTR.EXTERNAL}))
        (then (return (call $__ext_${wantValue ? 'prop' : 'has'} (local.get $coll) (local.get $key))))
        (else ${onEmpty}))))
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
function genDelete(name, entrySize, hashFn, eqExpr, expectedType) {
  return `(func $${name} (param $coll f64) (param $key f64) (result i32)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32) (local $tries i32)
    (if (i32.ne (call $__ptr_type (local.get $coll)) (i32.const ${expectedType})) (then (return (i32.const 0))))
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

/** Generate growable upsert. Grows table at 75% load, rehashes, then inserts.
 *  strict=false: EXTERNAL fallback via __ext_set. strict=true: reject wrong type. */
function genUpsertGrow(name, entrySize, hashFn, eqExpr, typeConst, strict = false) {
  const typeGuard = strict
    ? `(if (i32.ne (call $__ptr_type (local.get $obj)) (i32.const ${typeConst}))
      (then (return (local.get $obj))))`
    : `(if (i32.ne (call $__ptr_type (local.get $obj)) (i32.const ${typeConst})) (then (if (i32.eq (call $__ptr_type (local.get $obj)) (i32.const ${PTR.EXTERNAL})) (then (call $__ext_set (local.get $obj) (local.get $key) (local.get $val)) drop)) (return (local.get $obj))))`
  return `(func $${name} (param $obj f64) (param $key f64) (param $val f64) (result f64)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32)
    (local $size i32) (local $newptr i32) (local $newcap i32) (local $i i32)
    (local $oldslot i32) (local $newidx i32) (local $newslot i32)
    ${typeGuard}
    (local.set $off (call $__ptr_offset (local.get $obj)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $size (i32.load (i32.sub (local.get $off) (i32.const 8))))
    ;; Grow if load factor > 75%: size * 4 >= cap * 3
    (if (i32.ge_s (i32.mul (local.get $size) (i32.const 4)) (i32.mul (local.get $cap) (i32.const 3)))
      (then
        (local.set $newcap (i32.shl (local.get $cap) (i32.const 1)))
        (local.set $newptr (call $__alloc_hdr (i32.const 0) (local.get $newcap) (i32.const ${entrySize})))
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

function genLookupStrict(name, entrySize, hashFn, eqExpr, expectedType, missing = UNDEF_NAN) {
  return `(func $${name} (param $coll f64) (param $key f64) (result f64)
    (local $off i32) (local $cap i32) (local $h i32) (local $idx i32) (local $slot i32) (local $tries i32)
    (if (i32.ne (call $__ptr_type (local.get $coll)) (i32.const ${expectedType}))
      (then (return (f64.reinterpret_i64 (i64.const ${missing})))))
    (local.set $off (call $__ptr_offset (local.get $coll)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (block $done (loop $probe
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const ${entrySize}))))
      (if (f64.eq (f64.load (local.get $slot)) (f64.const 0))
        (then (return (f64.reinterpret_i64 (i64.const ${missing})))))
      (if ${eqExpr}
        (then (return (f64.load (i32.add (local.get $slot) (i32.const 16))))))
      (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (f64.reinterpret_i64 (i64.const ${missing})))`
}


export default () => {
  inc('__ptr_offset', '__cap')

  if (!ctx.scope.globals.has('__dyn_props'))
    ctx.scope.globals.set('__dyn_props', '(global $__dyn_props (mut f64) (f64.const 0))')

  ctx.core.stdlib['__ext_prop'] = '(import "env" "__ext_prop" (func $__ext_prop (param f64 f64) (result f64)))'
  ctx.core.stdlib['__ext_has'] = '(import "env" "__ext_has" (func $__ext_has (param f64 f64) (result i32)))'
  ctx.core.stdlib['__ext_set'] = '(import "env" "__ext_set" (func $__ext_set (param f64 f64 f64) (result i32)))'
  ctx.core.stdlib['__ext_call'] = '(import "env" "__ext_call" (func $__ext_call (param f64 f64 f64) (result f64)))'
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
    const out = allocPtr({ type: PTR.SET, len: 0, cap: INIT_CAP, stride: SET_ENTRY, tag: 'set' })
    return typed(['block', ['result', 'f64'], out.init, out.ptr], 'f64')
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
  ctx.core.stdlib['__set_add'] = genUpsert('__set_add', SET_ENTRY, '$__hash', f64Eq, PTR.SET, false)
  ctx.core.stdlib['__set_has'] = genLookup('__set_has', SET_ENTRY, '$__hash', f64Eq, PTR.SET, false)
  ctx.core.stdlib['__set_delete'] = genDelete('__set_delete', SET_ENTRY, '$__hash', f64Eq, PTR.SET)

  // === Map ===

  ctx.core.emit['new.Map'] = () => {
    const out = allocPtr({ type: PTR.MAP, len: 0, cap: INIT_CAP, stride: MAP_ENTRY, tag: 'map' })
    return typed(['block', ['result', 'f64'], out.init, out.ptr], 'f64')
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
  ctx.core.stdlib['__map_set'] = genUpsert('__map_set', MAP_ENTRY, '$__hash', f64Eq, PTR.MAP, true)
  ctx.core.stdlib['__map_get'] = genLookup('__map_get', MAP_ENTRY, '$__hash', f64Eq, PTR.MAP, true)

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

  ctx.core.stdlib['__hash_new'] = `(func $__hash_new (result f64)
    (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0)
      (call $__alloc_hdr (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY}))))`

  ctx.core.stdlib['__hash_get_local'] = genLookupStrict('__hash_get_local', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH)
  ctx.core.stdlib['__hash_set_local'] = genUpsertGrow('__hash_set_local', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH, true)

  ctx.core.stdlib['__dyn_get'] = `(func $__dyn_get (param $obj f64) (param $key f64) (result f64)
    (local $props f64) (local $objKey f64)
    (if (result f64) (f64.eq (global.get $__dyn_props) (f64.const 0))
      (then (f64.reinterpret_i64 (i64.const ${UNDEF_NAN})))
      (else
        (local.set $objKey (call $__to_str (f64.convert_i32_s (call $__ptr_offset (local.get $obj)))))
        (local.set $props (call $__hash_get_local (global.get $__dyn_props) (local.get $objKey)))
        (if (result f64) (call $__is_nullish (local.get $props))
          (then (f64.reinterpret_i64 (i64.const ${UNDEF_NAN})))
          (else (call $__hash_get_local (local.get $props) (local.get $key)))))))`

  ctx.core.stdlib['__dyn_get_or'] = `(func $__dyn_get_or (param $obj f64) (param $key f64) (param $fallback f64) (result f64)
    (local $val f64)
    (local.set $val (call $__dyn_get (local.get $obj) (local.get $key)))
    (if (result f64)
      (i64.eq (i64.reinterpret_f64 (local.get $val)) (i64.const ${UNDEF_NAN}))
      (then (local.get $fallback))
      (else (local.get $val))))`

  ctx.core.stdlib['__dyn_get_expr'] = `(func $__dyn_get_expr (param $obj f64) (param $key f64) (result f64)
    (local $val f64)
    (local.set $val (call $__dyn_get (local.get $obj) (local.get $key)))
    (if (result f64)
      (i64.ne (i64.reinterpret_f64 (local.get $val)) (i64.const ${UNDEF_NAN}))
      (then (local.get $val))
      (else
        (if (result f64) (i32.eq (call $__ptr_type (local.get $obj)) (i32.const ${PTR.HASH}))
          (then (call $__hash_get_local (local.get $obj) (local.get $key)))
          (else (f64.reinterpret_i64 (i64.const ${NULL_NAN})))))))`

  ctx.core.stdlib['__dyn_set'] = `(func $__dyn_set (param $obj f64) (param $key f64) (param $val f64) (result f64)
    (local $root f64) (local $props f64) (local $objKey f64)
    (local.set $root (global.get $__dyn_props))
    (if (f64.eq (local.get $root) (f64.const 0))
      (then
        (local.set $root (call $__hash_new))
        (global.set $__dyn_props (local.get $root))))
    (local.set $objKey (call $__to_str (f64.convert_i32_s (call $__ptr_offset (local.get $obj)))))
    (local.set $props (call $__hash_get_local (local.get $root) (local.get $objKey)))
    (if (call $__is_nullish (local.get $props))
      (then
        (local.set $props (call $__hash_new))
        (local.set $root (call $__hash_set_local (local.get $root) (local.get $objKey) (local.get $props)))
        (global.set $__dyn_props (local.get $root))))
    (local.set $props (call $__hash_set_local (local.get $props) (local.get $key) (local.get $val)))
    (local.set $root (call $__hash_set_local (global.get $__dyn_props) (local.get $objKey) (local.get $props)))
    (global.set $__dyn_props (local.get $root))
    (local.get $val))`

  ctx.core.stdlib['__dyn_move'] = `(func $__dyn_move (param $oldOff i32) (param $newOff i32)
    (local $props f64) (local $root f64)
    (if (f64.eq (global.get $__dyn_props) (f64.const 0)) (then (return)))
    (local.set $props (call $__hash_get_local (global.get $__dyn_props) (call $__to_str (f64.convert_i32_s (local.get $oldOff)))))
    (if (call $__is_nullish (local.get $props)) (then (return)))
    (local.set $root (call $__hash_set_local (global.get $__dyn_props) (call $__to_str (f64.convert_i32_s (local.get $newOff))) (local.get $props)))
    (global.set $__dyn_props (local.get $root)))`

  // Generated HASH probe functions
  ctx.core.stdlib['__hash_set'] = genUpsertGrow('__hash_set', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH)
  ctx.core.stdlib['__hash_get'] = genLookup('__hash_get', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH, true)
  ctx.core.stdlib['__hash_has'] = genLookup('__hash_has', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH, false)

  // === `in` operator: key in obj → HASH key existence check ===
  ctx.core.emit['in'] = (key, obj) => {
    const objType = typeof obj === 'string'
      ? (ctx.func.valTypes?.get(obj) || ctx.scope.globalValTypes?.get(obj))
      : valTypeOf(obj)

    if (Array.isArray(key) && key[0] === 'str') {
      const prop = key[1]
      if (prop === 'length' && (objType === VAL.ARRAY || objType === VAL.TYPED || objType === VAL.STRING || objType === VAL.SET || objType === VAL.MAP))
        return typed(['i32.const', 1], 'i32')

      const schemaIdx = typeof obj === 'string' ? ctx.schema.find(obj, prop) : ctx.schema.find(null, prop)
      if (schemaIdx >= 0) return typed(['i32.const', 1], 'i32')
      if (objType === VAL.OBJECT) return typed(['i32.const', 0], 'i32')
    }

    const keyTmp = temp()
    const objTmp = temp()
    const idxTmp = `${T}in_idx${ctx.func.uniq++}`
    const typeTmp = `${T}in_type${ctx.func.uniq++}`
    const outTmp = `${T}in_out${ctx.func.uniq++}`
    ctx.func.locals.set(idxTmp, 'i32')
    ctx.func.locals.set(typeTmp, 'i32')
    ctx.func.locals.set(outTmp, 'i32')

    const keyVal = ['local.get', `$${keyTmp}`]
    const objVal = ['local.get', `$${objTmp}`]
    const idxVal = ['local.get', `$${idxTmp}`]
    const typeVal = ['local.get', `$${typeTmp}`]
    const isStringKey = ['call', '$__is_str_key', keyVal]
    const isStringLike = ['i32.or',
      ['i32.eq', typeVal, ['i32.const', PTR.STRING]],
      ['i32.eq', typeVal, ['i32.const', PTR.SSO]]]
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
          ['i32.or',
            ['i32.eq', typeVal, ['i32.const', PTR.STRING]],
            ['i32.eq', typeVal, ['i32.const', PTR.SSO]]],
          ['i32.or',
            ['i32.or',
              ['i32.eq', typeVal, ['i32.const', PTR.SET]],
              ['i32.eq', typeVal, ['i32.const', PTR.MAP]]],
            ['i32.eq', typeVal, ['i32.const', PTR.CLOSURE]]]]]]

    inc('__ptr_type', '__len', '__str_byteLen', '__hash_has', '__ext_has', '__is_str_key', '__to_str', '__dyn_get', '__is_nullish')

    return typed(['block', ['result', 'i32'],
      ['local.set', `$${objTmp}`, asF64(emit(obj))],
      ['local.set', `$${keyTmp}`, asF64(emit(key))],
      ['local.set', `$${outTmp}`, ['i32.const', 0]],
      ['local.set', `$${typeTmp}`, ['call', '$__ptr_type', objVal]],
      ['local.set', `$${idxTmp}`, ['i32.trunc_sat_f64_s', keyVal]],

      ['if', ['i32.and',
        ['f64.eq', keyVal, keyVal],
        ['i32.and',
          ['f64.eq', ['f64.convert_i32_s', idxVal], keyVal],
          ['i32.ge_s', idxVal, ['i32.const', 0]]]],
        ['then',
          ['if', isStringLike,
            ['then', ['local.set', `$${outTmp}`, ['i32.lt_u', idxVal, ['call', '$__str_byteLen', objVal]]]]],
          ['if', isArrayLike,
            ['then', ['local.set', `$${outTmp}`, ['i32.lt_u', idxVal, ['call', '$__len', objVal]]]]]]],

      ['if', isStringKey,
        ['then',
          ['if', hasDynProps,
            ['then', ['local.set', `$${outTmp}`,
              ['i32.eqz', ['call', '$__is_nullish', ['call', '$__dyn_get', objVal, keyVal]]]]]]]],

      ['if', ['i32.eq', typeVal, ['i32.const', PTR.HASH]],
        ['then', ['local.set', `$${outTmp}`,
          ['if', ['result', 'i32'], isStringKey,
            ['then', ['call', '$__hash_has', objVal, keyVal]],
            ['else', ['call', '$__hash_has', objVal, ['call', '$__to_str', keyVal]]]]]]],

      ['if', ['i32.eq', typeVal, ['i32.const', 2]],
        ['then', ['local.set', `$${outTmp}`, ['call', '$__ext_has', objVal, keyVal]]]],

      ['local.get', `$${outTmp}`]], 'i32')
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
