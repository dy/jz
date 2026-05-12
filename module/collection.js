/**
 * Collection module — Set, Map, HASH (dynamic string-keyed objects).
 *
 * Set: type=8, open addressing hash table. Entries: [hash:f64, key:f64] (16B each).
 * Map: type=9, same but entries: [hash:f64, key:f64, val:f64] (24B each).
 * HASH: type=7, same layout as Map but uses content-based string hash + equality.
 *
 * @module collection
 */

import { typed, asF64, asI64, asI32, NULL_NAN, UNDEF_NAN, temp, tempI32, tempI64, allocPtr, undefExpr } from '../src/ir.js'
import { emit, emitFlat } from '../src/emit.js'
import { valTypeOf, lookupValType, VAL } from '../src/analyze.js'
import { inc, PTR, LAYOUT } from '../src/ctx.js'

const SET_ENTRY = 16  // hash + key
const MAP_ENTRY = 24  // hash + key + value
const INIT_CAP = 8    // initial capacity (must be power of 2)

export function strHashLiteral(str) {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ (str.charCodeAt(i) & 0xFF), 0x01000193) | 0
  return h <= 1 ? (h + 2) | 0 : h
}

const HASH_BUF = new ArrayBuffer(8)
const HASH_F64 = new Float64Array(HASH_BUF)
const HASH_U32 = new Uint32Array(HASH_BUF)

export function numHashLiteral(n) {
  if (Object.is(n, 0) || Object.is(n, -0)) return 2
  HASH_F64[0] = n
  const h = (HASH_U32[0] ^ HASH_U32[1]) | 0
  return h <= 1 ? (h + 2) | 0 : h
}

function numConstLiteral(expr) {
  if (typeof expr === 'number' && Number.isFinite(expr)) return expr
  if (Array.isArray(expr) && expr[0] == null && typeof expr[1] === 'number' && Number.isFinite(expr[1])) return expr[1]
  return null
}

// Equality expressions for probe templates
const sameValueZeroEq = '(call $__same_value_zero (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))'
const strEq = '(call $__str_eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))'

// Open-addressing probe walked additively by entrySize: avoids an i32.mul + mask per
// step (vs recomputing slot = off + idx*entrySize). Needs $off/$cap/$h set and $end/$slot
// locals declared. `idxExpr` is the first-slot index (defaults to h mod cap; cap is pow2).
const probeStart = (entrySize, idxExpr = '(i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1)))') =>
  `(local.set $end (i32.add (local.get $off) (i32.mul (local.get $cap) (i32.const ${entrySize}))))
    (local.set $slot (i32.add (local.get $off) (i32.mul ${idxExpr} (i32.const ${entrySize}))))`
const probeNext = (entrySize) =>
  `(local.set $slot (i32.add (local.get $slot) (i32.const ${entrySize})))
      (if (i32.ge_u (local.get $slot) (local.get $end)) (then (local.set $slot (local.get $off))))`

/** Generate upsert (add/set) probe function. hasVal: store value at slot+16.
 *  hasExt: emit EXTERNAL fallthrough (call $__ext_set on non-matching type).
 *  Gated off → type mismatch just returns coll unchanged. */
function genUpsert(name, entrySize, hashFn, eqExpr, expectedType, hasVal, hasExt) {
  const valParam = hasVal ? '(param $val i64) ' : ''
  const storeVal = hasVal ? `\n          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))` : ''
  const onMatch = hasVal
    ? `(then\n          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))\n          (br $done))`
    : `(then (br $done))`

  const extBranch = hasVal
    ? '(then (call $__ext_set (local.get $coll) (local.get $key) (local.get $val)) drop)'
    : '(then (nop))'
  const tExpr = `(i32.wrap_i64 (i64.and (i64.shr_u (local.get $coll) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`
  const typeGuard = hasExt
    ? `(if (i32.ne ${tExpr} (i32.const ${expectedType})) (then (if (i32.eq ${tExpr} (i32.const ${PTR.EXTERNAL})) ${extBranch}) (return (local.get $coll))))`
    : `(if (i32.ne ${tExpr} (i32.const ${expectedType})) (then (return (local.get $coll))))`
  return `(func $${name} (param $coll i64) (param $key i64) ${valParam}(result i64)
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32)
    ${typeGuard}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $coll) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot)))
        (then
          (i64.store (local.get $slot) (i64.extend_i32_u (local.get $h)))
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))${storeVal}
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if ${eqExpr} ${onMatch})
      ${probeNext(entrySize)}
      (br $probe)))
    (local.get $coll))`
}

/** Generate lookup probe function.
 *  wantValue=true: return slot value, missing => NULL_NAN sentinel.
 *  wantValue=false: return i32 0/1 existence flag.
 *  hasExt: emit EXTERNAL fallthrough (delegate to __ext_prop/__ext_has). */
function genLookup(name, entrySize, hashFn, eqExpr, expectedType, wantValue, hasExt) {
  const rt = wantValue ? 'i64' : 'i32'
  const onEmpty = wantValue
    ? `(return (i64.const ${NULL_NAN}))`
    : '(return (i32.const 0))'
  const onFound = wantValue
    ? '(return (i64.load (i32.add (local.get $slot) (i32.const 16))))'
    : '(return (i32.const 1))'
  const notFound = wantValue
    ? `(i64.const ${NULL_NAN})`
    : '(i32.const 0)'
  const tExpr = `(i32.wrap_i64 (i64.and (i64.shr_u (local.get $coll) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`
  const typeGuard = hasExt
    ? `(if (i32.ne ${tExpr} (i32.const ${expectedType})) (then (if (i32.eq ${tExpr} (i32.const ${PTR.EXTERNAL}))
        (then (return ${wantValue
          ? '(call $__ext_prop (local.get $coll) (local.get $key))'
          : '(call $__ext_has (local.get $coll) (local.get $key))'}))
        (else ${onEmpty}))))`
    : `(if (i32.ne ${tExpr} (i32.const ${expectedType})) (then ${onEmpty}))`

  return `(func $${name} (param $coll i64) (param $key i64) (result ${rt})
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32) (local $tries i32)
    ${typeGuard}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $coll) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot))) (then ${onEmpty}))
      (if ${eqExpr} (then ${onFound}))
      ${probeNext(entrySize)}
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    ${notFound})`
}

/** Generate delete probe function. Zero out entry on match. */
function genDelete(name, entrySize, hashFn, eqExpr, expectedType) {
  return `(func $${name} (param $coll i64) (param $key i64) (result i32)
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32) (local $tries i32)
    (if (i32.ne (call $__ptr_type (local.get $coll)) (i32.const ${expectedType})) (then (return (i32.const 0))))
    (local.set $off (call $__ptr_offset (local.get $coll)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot))) (then (return (i32.const 0))))
      (if ${eqExpr}
        (then
          (i64.store (local.get $slot) (i64.const 0))
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (i64.const 0))
          (return (i32.const 1))))
      ${probeNext(entrySize)}
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (i32.const 0))`
}

/** Generate growable upsert. Grows table at 75% load, rehashes, then inserts.
 *  strict=true: reject wrong type.
 *  strict=false: EXTERNAL → __ext_set, other non-HASH types → __dyn_set (global props).
 *  The non-strict fallback is critical for untyped variables (e.g. arrays from
 *  Object.create) that receive property writes — without it writes silently vanish. */
function genUpsertGrow(name, entrySize, hashFn, eqExpr, typeConst, strict = false, hasExt = false) {
  const nonHashFallback = hasExt
    ? `(if (i32.eq (call $__ptr_type (local.get $obj)) (i32.const ${PTR.EXTERNAL}))
            (then (call $__ext_set (local.get $obj) (local.get $key) (local.get $val)) drop)
            (else (call $__dyn_set (local.get $obj) (local.get $key) (local.get $val)) drop))`
    : `(call $__dyn_set (local.get $obj) (local.get $key) (local.get $val)) drop`
  const typeGuard = strict
    ? `(if (i32.ne (call $__ptr_type (local.get $obj)) (i32.const ${typeConst}))
      (then (return (local.get $obj))))`
    : `(if (i32.ne (call $__ptr_type (local.get $obj)) (i32.const ${typeConst}))
        (then
          ${nonHashFallback}
          (return (local.get $obj))))`
  return `(func $${name} (param $obj i64) (param $key i64) (param $val i64) (result i64)
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32)
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
          (if (i64.ne (i64.load (local.get $oldslot)) (i64.const 0))
            (then
              (local.set $h (call ${hashFn} (i64.load (i32.add (local.get $oldslot) (i32.const 8)))))
              (local.set $newidx (i32.and (local.get $h) (i32.sub (local.get $newcap) (i32.const 1))))
              (block $ins (loop $probe2
                (local.set $newslot (i32.add (local.get $newptr) (i32.mul (local.get $newidx) (i32.const ${entrySize}))))
                (br_if $ins (i64.eqz (i64.load (local.get $newslot))))
                (local.set $newidx (i32.and (i32.add (local.get $newidx) (i32.const 1)) (i32.sub (local.get $newcap) (i32.const 1))))
                (br $probe2)))
              (i64.store (local.get $newslot) (i64.load (local.get $oldslot)))
              (i64.store (i32.add (local.get $newslot) (i32.const 8)) (i64.load (i32.add (local.get $oldslot) (i32.const 8))))
              (i64.store (i32.add (local.get $newslot) (i32.const 16)) (i64.load (i32.add (local.get $oldslot) (i32.const 16))))
              (i32.store (i32.sub (local.get $newptr) (i32.const 8))
                (i32.add (i32.load (i32.sub (local.get $newptr) (i32.const 8))) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $rl)))
        (local.set $off (local.get $newptr))
        (local.set $cap (local.get $newcap))
        (local.set $obj (i64.reinterpret_f64 (call $__mkptr (i32.const ${typeConst}) (i32.const 0) (local.get $newptr))))))
    ;; Insert/update
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot)))
        (then
          (i64.store (local.get $slot) (i64.extend_i32_u (local.get $h)))
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if ${eqExpr}
        (then
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (br $done)))
      ${probeNext(entrySize)}
      (br $probe)))
    (local.get $obj))`
}

function genLookupStrict(name, entrySize, hashFn, eqExpr, expectedType, missing = UNDEF_NAN) {
  return `(func $${name} (param $coll i64) (param $key i64) (result i64)
    (local $off i32) (local $cap i32) (local $h i32) (local $end i32) (local $slot i32) (local $tries i32)
    (if (i32.ne
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $coll) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${expectedType}))
      (then (return (i64.const ${missing}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $coll) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $h (call ${hashFn} (local.get $key)))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot)))
        (then (return (i64.const ${missing}))))
      (if ${eqExpr}
        (then (return (i64.load (i32.add (local.get $slot) (i32.const 16))))))
      ${probeNext(entrySize)}
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (i64.const ${missing}))`
}

function genLookupStrictPrehashed(name, entrySize, eqExpr, expectedType, missing = UNDEF_NAN, hasExt = false) {
  const tExpr = `(i32.wrap_i64 (i64.and (i64.shr_u (local.get $coll) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`
  const typeGuard = hasExt
    ? `(if (i32.ne ${tExpr} (i32.const ${expectedType}))
      (then
        (if (i32.eq ${tExpr} (i32.const ${PTR.EXTERNAL}))
          (then (return (call $__ext_prop (local.get $coll) (local.get $key))))
          (else (return (i64.const ${missing}))))))`
    : `(if (i32.ne ${tExpr} (i32.const ${expectedType}))
      (then (return (i64.const ${missing}))))`
  return `(func $${name} (param $coll i64) (param $key i64) (param $h i32) (result i64)
    (local $off i32) (local $cap i32) (local $end i32) (local $slot i32) (local $tries i32)
    ${typeGuard}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $coll) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot)))
        (then (return (i64.const ${missing}))))
      (if ${eqExpr}
        (then (return (i64.load (i32.add (local.get $slot) (i32.const 16))))))
      ${probeNext(entrySize)}
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br_if $done (i32.ge_s (local.get $tries) (local.get $cap)))
      (br $probe)))
    (i64.const ${missing}))`
}

function genUpsertStrictPrehashed(name, entrySize, eqExpr, expectedType) {
  return `(func $${name} (param $obj i64) (param $key i64) (param $h i32) (param $val i64) (result i64)
    (local $off i32) (local $cap i32) (local $end i32) (local $slot i32)
    (if (i32.ne
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${expectedType}))
      (then (return (local.get $obj))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ${probeStart(entrySize)}
    (block $done (loop $probe
      (if (i64.eqz (i64.load (local.get $slot)))
        (then
          (i64.store (local.get $slot) (i64.extend_i32_u (local.get $h)))
          (i64.store (i32.add (local.get $slot) (i32.const 8)) (local.get $key))
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (i32.store (i32.sub (local.get $off) (i32.const 8))
            (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
          (br $done)))
      (if ${eqExpr}
        (then
          (i64.store (i32.add (local.get $slot) (i32.const 16)) (local.get $val))
          (br $done)))
      ${probeNext(entrySize)}
      (br $probe)))
    (local.get $obj))`
}


export default (ctx) => {
  // Feature-gated deps: EXTERNAL-dependent symbols are only pulled when features.external.
  // Evaluated lazily at resolveIncludes() time — after emission has finalized ctx.features.
  const ifExt = (name) => () => ctx.features.external ? [name] : []
  Object.assign(ctx.core.stdlibDeps, {
    __same_value_zero: ['__str_eq'],
    __map_hash: ['__hash', '__str_hash'],
    __set_add: () => ctx.features.external ? ['__map_hash', '__same_value_zero', '__ext_set'] : ['__map_hash', '__same_value_zero'],
    __set_has: () => ctx.features.external ? ['__map_hash', '__same_value_zero', '__ext_has'] : ['__map_hash', '__same_value_zero'],
    __set_delete: ['__map_hash', '__same_value_zero'],
    __map_set: () => ctx.features.external ? ['__map_hash', '__same_value_zero', '__ext_set'] : ['__map_hash', '__same_value_zero'],
    __map_get: () => ctx.features.external ? ['__ext_prop', '__map_set'] : ['__map_set'],
    __map_get_h: () => ctx.features.external ? ['__ext_prop', '__same_value_zero'] : ['__same_value_zero'],
    __map_has: () => ctx.features.external ? ['__map_hash', '__same_value_zero', '__ext_has'] : ['__map_hash', '__same_value_zero'],
    __map_delete: ['__map_hash', '__same_value_zero'],
    __hash_set: () => ctx.features.external
      ? ['__str_hash', '__str_eq', '__ptr_type', '__ext_set', '__dyn_set']
      : ['__str_hash', '__str_eq', '__ptr_type', '__dyn_set'],
    __hash_get: () => ctx.features.external
      ? ['__str_hash', '__str_eq', '__ptr_type', '__ext_prop']
      : ['__str_hash', '__str_eq', '__ptr_type'],
    __hash_has: () => ctx.features.external
      ? ['__str_hash', '__str_eq', '__ptr_type', '__ext_has']
      : ['__str_hash', '__str_eq', '__ptr_type'],
    __hash_new: ['__alloc_hdr'],
    __hash_new_small: ['__alloc_hdr', '__mkptr'],
    __hash_get_local: ['__str_hash', '__str_eq'],
    __hash_get_local_h: ['__str_eq'],
    __hash_set_local_h: ['__str_eq'],
    __hash_set_local: ['__str_hash', '__str_eq'],
    __ihash_get_local: ['__map_hash'],
    __ihash_set_local: ['__map_hash', '__alloc_hdr', '__mkptr'],
    __dyn_get_t: ['__dyn_get_t_h', '__str_hash'],
    __dyn_get_t_h: ['__ihash_get_local', '__str_eq', '__is_nullish'],
    __dyn_get: ['__dyn_get_t', '__ptr_type'],
    __dyn_get_expr_t: ['__dyn_get_t', '__hash_get_local'],
    __dyn_get_expr_t_h: ['__dyn_get_t_h', '__hash_get_local_h'],
    __dyn_get_expr: ['__dyn_get_expr_t', '__ptr_type'],
    __dyn_get_any: ['__dyn_get_any_t', '__ptr_type'],
    __dyn_get_any_t: () => ctx.features.external
      ? ['__dyn_get_t', '__hash_get_local', '__ext_prop']
      : ['__dyn_get_t', '__hash_get_local'],
    __dyn_get_or: ['__dyn_get'],
    __dyn_set: ['__hash_new', '__hash_new_small', '__ihash_get_local', '__ihash_set_local', '__hash_set_local', '__ptr_offset', '__is_nullish', '__str_eq'],
    __dyn_move: ['__ihash_get_local', '__ihash_set_local', '__is_nullish'],
  })

  inc('__ptr_offset', '__cap')

  if (!ctx.scope.globals.has('__dyn_props'))
    ctx.scope.globals.set('__dyn_props', '(global $__dyn_props (mut f64) (f64.const 0))')
  // 1-slot inline cache for the global __dyn_props lookup. Hot path for
  // metacircular workloads (watr WAT parser): ~96% of execution sits in
  // __dyn_get_t / __ihash_get_local. Caches last-seen (off → propsPtr) at
  // the top of __dyn_get_t; invalidated by __dyn_set when the same off's
  // propsPtr is replaced (rehash on grow). Sentinel cache_off = -1 cannot
  // collide with a real memory offset (always non-negative i32).
  if (!ctx.scope.globals.has('__dyn_get_cache_off'))
    ctx.scope.globals.set('__dyn_get_cache_off', '(global $__dyn_get_cache_off (mut i32) (i32.const -1))')
  if (!ctx.scope.globals.has('__dyn_get_cache_props'))
    ctx.scope.globals.set('__dyn_get_cache_props', '(global $__dyn_get_cache_props (mut f64) (f64.const 0))')
  // Schema name table for __dyn_get's OBJECT-schema fallback (polymorphic-receiver
  // `.prop` access). Same declaration as json.js — defined here too so collection
  // doesn't transitively require json. compile.js's schemaInit populates it when
  // schema list is non-empty AND (__stringify OR __dyn_get) is included.
  if (!ctx.scope.globals.has('__schema_tbl'))
    ctx.scope.globals.set('__schema_tbl', '(global $__schema_tbl (mut i32) (i32.const 0))')

  // __ext_* imports carry NaN-boxed pointers across the env boundary as i64
  // (not f64) to dodge V8's f64 NaN canonicalization at the wasm↔JS edge —
  // same hazard as env.print / env.setTimeout (see module/console.js header).
  // i32 returns (has/set) and arg shapes stay; only boxed-pointer carriers move.
  ctx.core.stdlib['__ext_prop'] = '(import "env" "__ext_prop" (func $__ext_prop (param i64 i64) (result i64)))'
  ctx.core.stdlib['__ext_has'] = '(import "env" "__ext_has" (func $__ext_has (param i64 i64) (result i32)))'
  ctx.core.stdlib['__ext_set'] = '(import "env" "__ext_set" (func $__ext_set (param i64 i64 i64) (result i32)))'
  ctx.core.stdlib['__ext_call'] = '(import "env" "__ext_call" (func $__ext_call (param i64 i64 i64) (result i64)))'
  // Hash function: simple f64 → i32 hash
  ctx.core.stdlib['__hash'] = `(func $__hash (param $v i64) (result i32)
    (i32.wrap_i64 (i64.xor
      (local.get $v)
      (i64.shr_u (local.get $v) (i64.const 32)))))`
  inc('__hash')

  ctx.core.stdlib['__same_value_zero'] = `(func $__same_value_zero (param $a i64) (param $b i64) (result i32)
    (local $fa f64) (local $fb f64) (local $ta i32) (local $tb i32)
    (if (result i32) (i64.eq (local.get $a) (local.get $b))
      (then (i32.const 1))
      (else
        (local.set $fa (f64.reinterpret_i64 (local.get $a)))
        (local.set $fb (f64.reinterpret_i64 (local.get $b)))
        (if (result i32)
          (i32.and
            (f64.eq (local.get $fa) (local.get $fa))
            (f64.eq (local.get $fb) (local.get $fb)))
          (then (f64.eq (local.get $fa) (local.get $fb)))
          (else
            (local.set $ta (i32.wrap_i64 (i64.and (i64.shr_u (local.get $a) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
            (local.set $tb (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
            (if (result i32)
              (i32.and
                (i32.eq (local.get $ta) (i32.const ${PTR.STRING}))
                (i32.eq (local.get $tb) (i32.const ${PTR.STRING})))
              (then (call $__str_eq (local.get $a) (local.get $b)))
              (else (i32.const 0))))))))`

  ctx.core.stdlib['__map_hash'] = `(func $__map_hash (param $v i64) (result i32)
    (local $f f64) (local $t i32) (local $h i32)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $v) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    ;; NaN-boxed strings carry the tag inside a NaN payload. Regular numbers
    ;; (e.g. f64.convert_i32_s offsets used as __ihash keys) can alias mantissa
    ;; bits onto the type slot — gate the str-hash dispatch on actual NaN.
    (if (i32.and (f64.ne (local.get $f) (local.get $f))
          (i32.eq (local.get $t) (i32.const ${PTR.STRING})))
      (then (return (call $__str_hash (local.get $v)))))
    (if (f64.eq (local.get $f) (f64.const 0)) (then (return (i32.const 2))))
    (if (i32.and (i32.eq (local.get $t) (i32.const 0)) (f64.ne (local.get $f) (local.get $f)))
      (then (return (i32.const 3))))
    (local.set $h (call $__hash (local.get $v)))
    (if (result i32) (i32.le_s (local.get $h) (i32.const 1))
      (then (i32.add (local.get $h) (i32.const 2)))
      (else (local.get $h))))`

  // __map_new() → f64 — allocate empty Map (for JSON.parse, runtime creation)
  ctx.core.stdlib['__map_new'] = `(func $__map_new (result f64)
    (call $__mkptr (i32.const ${PTR.MAP}) (i32.const 0)
      (call $__alloc_hdr (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY}))))`

  // === Set ===

  ctx.core.emit['new.Set'] = () => {
    ctx.features.set = true
    const out = allocPtr({ type: PTR.SET, len: 0, cap: INIT_CAP, stride: SET_ENTRY, tag: 'set' })
    return typed(['block', ['result', 'f64'], out.init, out.ptr], 'f64')
  }

  ctx.core.emit['.add'] = (setExpr, val) => {
    inc('__set_add')
    return typed(['f64.reinterpret_i64', ['call', '$__set_add', asI64(emit(setExpr)), asI64(emit(val))]], 'f64')
  }

  ctx.core.emit['.has'] = (setExpr, val) => {
    inc('__set_has')
    return typed(['f64.convert_i32_s', ['call', '$__set_has', asI64(emit(setExpr)), asI64(emit(val))]], 'f64')
  }

  ctx.core.emit['.delete'] = (setExpr, val) => {
    inc('__set_delete')
    return typed(['f64.convert_i32_s', ['call', '$__set_delete', asI64(emit(setExpr)), asI64(emit(val))]], 'f64')
  }

  ctx.core.emit['.size'] = (expr) => {
    return typed(['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', asF64(emit(expr))]]], 'f64')
  }

  // Generated Set probe functions
  ctx.core.stdlib['__set_add'] = () => genUpsert('__set_add', SET_ENTRY, '$__map_hash', sameValueZeroEq, PTR.SET, false, ctx.features.external)
  ctx.core.stdlib['__set_has'] = () => genLookup('__set_has', SET_ENTRY, '$__map_hash', sameValueZeroEq, PTR.SET, false, ctx.features.external)
  ctx.core.stdlib['__set_delete'] = genDelete('__set_delete', SET_ENTRY, '$__map_hash', sameValueZeroEq, PTR.SET)

  // === Map ===

  ctx.core.emit['new.Map'] = () => {
    ctx.features.map = true
    const out = allocPtr({ type: PTR.MAP, len: 0, cap: INIT_CAP, stride: MAP_ENTRY, tag: 'map' })
    return typed(['block', ['result', 'f64'], out.init, out.ptr], 'f64')
  }

  ctx.core.emit['.set'] = (mapExpr, key, val) => {
    inc('__map_set')
    const value = val === undefined ? asI64(undefExpr()) : asI64(emit(val))
    return typed(['f64.reinterpret_i64', ['call', '$__map_set', asI64(emit(mapExpr)), asI64(emit(key)), value]], 'f64')
  }
  ctx.core.emit[`.${VAL.MAP}:set`] = ctx.core.emit['.set']

  const emitMapGet = (mapExpr, key) => {
    const constKey = numConstLiteral(key)
    if (constKey != null) {
      inc('__map_get_h')
      return typed(['f64.reinterpret_i64', ['call', '$__map_get_h', asI64(emit(mapExpr)), asI64(emit(key)), ['i32.const', numHashLiteral(constKey)]]], 'f64')
    }
    inc('__map_get')
    return typed(['f64.reinterpret_i64', ['call', '$__map_get', asI64(emit(mapExpr)), asI64(emit(key))]], 'f64')
  }

  ctx.core.emit['.get'] = emitMapGet
  ctx.core.emit[`.${VAL.MAP}:get`] = emitMapGet

  ctx.core.emit[`.${VAL.MAP}:has`] = (mapExpr, key) => {
    inc('__map_has')
    return typed(['f64.convert_i32_s', ['call', '$__map_has', asI64(emit(mapExpr)), asI64(emit(key))]], 'f64')
  }

  ctx.core.emit[`.${VAL.MAP}:delete`] = (mapExpr, key) => {
    inc('__map_delete')
    return typed(['f64.convert_i32_s', ['call', '$__map_delete', asI64(emit(mapExpr)), asI64(emit(key))]], 'f64')
  }

  // Generated Map probe functions
  ctx.core.stdlib['__map_set'] = () => genUpsert('__map_set', MAP_ENTRY, '$__map_hash', sameValueZeroEq, PTR.MAP, true, ctx.features.external)
  ctx.core.stdlib['__map_get'] = () => genLookup('__map_get', MAP_ENTRY, '$__map_hash', sameValueZeroEq, PTR.MAP, true, ctx.features.external)
  ctx.core.stdlib['__map_get_h'] = () => genLookupStrictPrehashed('__map_get_h', MAP_ENTRY, sameValueZeroEq, PTR.MAP, NULL_NAN, ctx.features.external)
  ctx.core.stdlib['__map_has'] = () => genLookup('__map_has', MAP_ENTRY, '$__map_hash', sameValueZeroEq, PTR.MAP, false, ctx.features.external)
  ctx.core.stdlib['__map_delete'] = genDelete('__map_delete', MAP_ENTRY, '$__map_hash', sameValueZeroEq, PTR.MAP)

  // === HASH — dynamic string-keyed object (type=7) ===

  // FNV-1a hash of string content (works on both SSO and heap strings)
  // FNV-1a. ~95M calls in watr self-host. Inline char-fetch: hoist type/offset out of the
  // byte loop so SSO branch uses dword shifts and STRING branch uses raw load8_u — neither
  // calls anything per byte (vs original 1×__char_at → __ptr_type + __ptr_offset per byte).
  ctx.core.stdlib['__str_hash'] = `(func $__str_hash (param $s i64) (result i32)
    (local $h i32) (local $len i32) (local $lenA i32) (local $i i32) (local $t i32) (local $off i32) (local $aux i32) (local $w i32)
    (local.set $h (i32.const 0x811c9dc5))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $s) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $s) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $aux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $s) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING})) (i32.shr_u (local.get $aux) (i32.const 14)))
      (then
        (local.set $len (i32.and (local.get $aux) (i32.const 7)))
        (block $ds (loop $ls
          (br_if $ds (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $h (i32.mul
            (i32.xor (local.get $h)
              (i32.and (i32.shr_u (local.get $off) (i32.shl (local.get $i) (i32.const 3))) (i32.const 0xFF)))
            (i32.const 0x01000193)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $ls))))
      (else
        (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING})) (i32.ge_u (local.get $off) (i32.const 4)))
          (then (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 4))))))
        ;; 4-byte unrolled FNV-1a: each iter loads i32, mixes 4 bytes (little-endian) sequentially.
        (local.set $lenA (i32.and (local.get $len) (i32.const -4)))
        (block $d4 (loop $l4
          (br_if $d4 (i32.ge_s (local.get $i) (local.get $lenA)))
          (local.set $w (i32.load (i32.add (local.get $off) (local.get $i))))
          (local.set $h (i32.mul (i32.xor (local.get $h) (i32.and (local.get $w) (i32.const 0xFF))) (i32.const 0x01000193)))
          (local.set $h (i32.mul (i32.xor (local.get $h) (i32.and (i32.shr_u (local.get $w) (i32.const 8)) (i32.const 0xFF))) (i32.const 0x01000193)))
          (local.set $h (i32.mul (i32.xor (local.get $h) (i32.and (i32.shr_u (local.get $w) (i32.const 16)) (i32.const 0xFF))) (i32.const 0x01000193)))
          (local.set $h (i32.mul (i32.xor (local.get $h) (i32.shr_u (local.get $w) (i32.const 24))) (i32.const 0x01000193)))
          (local.set $i (i32.add (local.get $i) (i32.const 4)))
          (br $l4)))
        (block $dh (loop $lh
          (br_if $dh (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $h (i32.mul
            (i32.xor (local.get $h)
              (i32.load8_u (i32.add (local.get $off) (local.get $i))))
            (i32.const 0x01000193)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $lh)))))
    ;; Ensure >= 2 (0=empty, 1=tombstone)
    (if (result i32) (i32.le_s (local.get $h) (i32.const 1))
      (then (i32.add (local.get $h) (i32.const 2))) (else (local.get $h))))`

  ctx.core.stdlib['__hash_new'] = `(func $__hash_new (result f64)
    (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0)
      (call $__alloc_hdr (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY}))))`

  // Small initial capacity for propsPtr-style hashes (per-object dyn props).
  // Most receivers in real code carry 0-2 dyn props; paying 8-slot up-front
  // is wasted memory + probe-loop cache pressure. Grows to 4/8/... on demand.
  ctx.core.stdlib['__hash_new_small'] = `(func $__hash_new_small (result f64)
    (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0)
      (call $__alloc_hdr (i32.const 0) (i32.const 2) (i32.const ${MAP_ENTRY}))))`

  ctx.core.stdlib['__hash_get_local'] = genLookupStrict('__hash_get_local', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH)
  ctx.core.stdlib['__hash_get_local_h'] = genLookupStrictPrehashed('__hash_get_local_h', MAP_ENTRY, strEq, PTR.HASH)
  ctx.core.stdlib['__hash_set_local_h'] = genUpsertStrictPrehashed('__hash_set_local_h', MAP_ENTRY, strEq, PTR.HASH)
  ctx.core.stdlib['__hash_set_local'] = genUpsertGrow('__hash_set_local', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH, true)
  // Outer __dyn_props hash: keyed by object offset (i32 as f64 bits), value is per-object props hash.
  // Uses bit-hash + i64.eq — no string allocation for the unique integer key.
  ctx.core.stdlib['__ihash_get_local'] = genLookupStrict('__ihash_get_local', MAP_ENTRY, '$__map_hash', '(i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))', PTR.HASH)
  ctx.core.stdlib['__ihash_set_local'] = genUpsertGrow('__ihash_set_local', MAP_ENTRY, '$__map_hash', '(i64.eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))', PTR.HASH, true)

  // Inline __ptr_offset (forwarding-aware) and __hash_get_local body — dyn_get is the
  // single hottest stdlib symbol in watr self-host (~95M calls). props returned by
  // __ihash_get_local is always HASH (or NULL_NAN, filtered by __is_nullish), so the
  // inlined probe skips a redundant type check + bit unboxing per call.
  //
  // OBJECT receivers fall back to schema-aware slot lookup when __dyn_props has no
  // entry — covers polymorphic-receiver patterns (e.g. `let o = w?n():s()` with
  // structurally distinct schemas) where receiver schemaId is unknown at compile
  // time but lives at runtime in the NaN-box aux bits. Gated on schema name table
  // presence (lifted in compile.js whenever __dyn_get is included). Static-shape
  // monomorphic OBJECTs hit the compile-time slot read path and never reach here.
  // Wrapped in a factory: `ctx.schema.list.length` is observed at template
  // expansion time, after all schemas have been registered. Setting the
  // template at module-init froze hasSchemas to false and dropped the arm
  // for any schema registered later in the compile (the common case for
  // anonymous-literal arguments crossing call boundaries).
  // Schema-arm key compare uses i64.eq instead of __str_eq: schema keys and
  // the call-site key both come from the interned string pool (same NaN-box
  // bits for identical literals), so bit-equality is correct and skips a
  // per-iter function call. Real-world strings sharing prefix bytes are not
  // a concern here — keys are static literals from the source program.
  // Schema-arm key compare: i64.eq first for the static-shape case (compile-time
  // schemas hold pool-interned keys with identical NaN-box bits as call-site
  // literals — single bit-eq decides). Falls back to __str_eq when bits differ
  // so runtime-registered schemas (e.g. JSON.parse OBJECTs whose keys are
  // freshly heap-allocated by __jp_str) still resolve correctly.
  const schemaKeyEq = (storedKey, userKey) => ctx.core.includes.has('__jp_obj') || ctx.core.includes.has('__jp')
    ? `(i32.or
        (i64.eq ${storedKey} ${userKey})
        (call $__str_eq ${storedKey} ${userKey}))`
    : `(i64.eq ${storedKey} ${userKey})`
  const buildObjectSchemaArm = () => (ctx.schema.list.length > 0 || ctx.core.includes.has('__jp_obj')) ? `
    (if (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
      (then
        (if (i32.ne (global.get $__schema_tbl) (i32.const 0))
          (then
            (local.set $sid (i32.wrap_i64 (i64.and (i64.shr_u
              (local.get $obj) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
            (local.set $kbits
              (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3)))))
            (local.set $koff (i32.wrap_i64 (i64.and (local.get $kbits) (i64.const ${LAYOUT.OFFSET_MASK}))))
            (local.set $nkeys (i32.load (i32.sub (local.get $koff) (i32.const 8))))
            (local.set $idx (i32.const 0))
            (block $kdone (loop $kloop
              (br_if $kdone (i32.ge_s (local.get $idx) (local.get $nkeys)))
              (if ${schemaKeyEq(`(i64.load (i32.add (local.get $koff) (i32.shl (local.get $idx) (i32.const 3))))`, `(local.get $key)`)}
                (then (return (i64.load (i32.add (local.get $off) (i32.shl (local.get $idx) (i32.const 3)))))))
              (local.set $idx (i32.add (local.get $idx) (i32.const 1)))
              (br $kloop)))))))` : ''
  const buildObjectSchemaLocals = () => (ctx.schema.list.length > 0 || ctx.core.includes.has('__jp_obj'))
    ? '(local $sid i32) (local $kbits i64) (local $koff i32) (local $nkeys i32)'
    : ''
  // Same lazy-gating story as buildObjectSchemaArm above — observed at
  // template-expansion time so schemas registered later in the compile
  // still pull the arm in.
  const buildObjectSchemaSetLocals = () => (ctx.schema.list.length > 0 || ctx.core.includes.has('__jp_obj'))
    ? '(local $sid i32) (local $kbits i64) (local $koff i32) (local $nkeys i32) (local $idx i32)'
    : ''
  const buildObjectSchemaSetArm = () => (ctx.schema.list.length > 0 || ctx.core.includes.has('__jp_obj')) ? `
    ;; If a dynamic write targets an existing fixed-shape field, update the
    ;; payload slot as well as the dynamic sidecar below. Otherwise bracket
    ;; writes and later dot reads can diverge.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                 (i32.ne (global.get $__schema_tbl) (i32.const 0)))
      (then
        (local.set $sid (i32.wrap_i64 (i64.and (i64.shr_u
          (local.get $obj) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
        (local.set $kbits
          (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3)))))
        (local.set $koff (i32.wrap_i64 (i64.and (local.get $kbits) (i64.const ${LAYOUT.OFFSET_MASK}))))
        (local.set $nkeys (i32.load (i32.sub (local.get $koff) (i32.const 8))))
        (local.set $idx (i32.const 0))
        (block $schemaSetDone (loop $schemaSetLoop
          (br_if $schemaSetDone (i32.ge_s (local.get $idx) (local.get $nkeys)))
          (if (call $__str_eq
                (i64.load (i32.add (local.get $koff) (i32.shl (local.get $idx) (i32.const 3))))
                (local.get $key))
            (then
              (i64.store (i32.add (local.get $off) (i32.shl (local.get $idx) (i32.const 3))) (local.get $val))
              (br $schemaSetDone)))
          (local.set $idx (i32.add (local.get $idx) (i32.const 1)))
          (br $schemaSetLoop)))))` : ''

  ctx.core.stdlib['__dyn_get'] = `(func $__dyn_get (param $obj i64) (param $key i64) (result i64)
    (call $__dyn_get_t (local.get $obj) (local.get $key) (call $__ptr_type (local.get $obj))))`

  // Thin wrapper: hash the key once, delegate to the prehashed body. Constant-key
  // call sites bypass this and call $__dyn_get_t_h directly with strHashLiteral().
  ctx.core.stdlib['__dyn_get_t'] = `(func $__dyn_get_t (param $obj i64) (param $key i64) (param $type i32) (result i64)
    (call $__dyn_get_t_h (local.get $obj) (local.get $key) (local.get $type) (call $__str_hash (local.get $key))))`

  ctx.core.stdlib['__dyn_get_t_h'] = () => `(func $__dyn_get_t_h (param $obj i64) (param $key i64) (param $type i32) (param $h i32) (result i64)
    (local $props i64) (local $off i32)
    (local $poff i32) (local $pcap i32) (local $pend i32) (local $idx i32) (local $slot i32) (local $tries i32)
    ${buildObjectSchemaLocals()}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; CLOSURE with no env (offset 0): many function refs share offset 0, so key the
    ;; global __dyn_props hash on the function table index (negative — can't collide
    ;; with real heap/data offsets). Closures *with* env keep their unique env ptr.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.CLOSURE})) (i32.eqz (local.get $off)))
      (then (local.set $off (i32.sub (i32.const -1)
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK})))))))
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then
        (block $done
          (loop $follow
            (br_if $done (i32.lt_u (local.get $off) (i32.const 16)))
            (br_if $done (i32.gt_u (local.get $off) (i32.shl (memory.size) (i32.const 16))))
            (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
            (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (br $follow)))))
    (block $dynDone
      (block $haveProps
        ;; ARRAY: header propsPtr at $off-16 is valid only when shift hasn't
        ;; rewritten the slot with forwarding bytes. Validate via HASH tag —
        ;; rejects 0 (no props) and forwarding garbage. Misses fall through to
        ;; the global hash, where __arr_shift migrates props on first .shift().
        (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
                     (i32.ge_u (local.get $off) (i32.const 16)))
          (then
            (local.set $props (i64.load (i32.sub (local.get $off) (i32.const 16))))
            (br_if $haveProps (i32.eq
              (i32.wrap_i64 (i64.and (i64.shr_u (local.get $props) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
              (i32.const ${PTR.HASH})))
            (local.set $props (i64.const 0))))
        ;; OBJECT: heap-allocated (off >= __heap_start) carries propsPtr at
        ;; off-16 from __alloc_hdr. The slot is either 0 (no dyn props yet) or
        ;; a HASH — no forwarding-garbage case like ARRAY, so a bit-zero test
        ;; is enough. Static-segment objects fall through to the global hash.
        (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                     (i32.ge_u (local.get $off) (global.get $__heap_start)))
          (then
            (local.set $props (i64.load (i32.sub (local.get $off) (i32.const 16))))
            (br_if $dynDone (i64.eqz (local.get $props)))
            (br $haveProps)))
        ;; Other header types (TYPED/HASH/SET/MAP) carry propsPtr at off-16
        ;; directly, bypassing the global __dyn_props hash.
        (if (i32.and (i32.ge_u (local.get $off) (i32.const 16))
              (i32.or (i32.eq (local.get $type) (i32.const ${PTR.TYPED}))
                (i32.or (i32.eq (local.get $type) (i32.const ${PTR.HASH}))
                  (i32.or (i32.eq (local.get $type) (i32.const ${PTR.SET}))
                          (i32.eq (local.get $type) (i32.const ${PTR.MAP}))))))
          (then
            (local.set $props (i64.load (i32.sub (local.get $off) (i32.const 16))))
            (br_if $dynDone (i64.eqz (local.get $props)))
            (br $haveProps)))
        ;; Fall back to the global __dyn_props hash (CLOSURE, shifted ARRAY,
        ;; static-segment OBJECT). 1-slot cache covers both hits and misses
        ;; (props=0 sentinel) so header-less types skip __ihash_get_local probes.
        (br_if $dynDone (f64.eq (global.get $__dyn_props) (f64.const 0)))
        (if (i32.eq (local.get $off) (global.get $__dyn_get_cache_off))
          (then
            (local.set $props (i64.reinterpret_f64 (global.get $__dyn_get_cache_props)))
            (br_if $dynDone (i64.eqz (local.get $props))))
          (else
            (local.set $props (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props))
              (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))))
            (global.set $__dyn_get_cache_off (local.get $off))
            (if (call $__is_nullish (local.get $props))
              (then
                (global.set $__dyn_get_cache_props (f64.const 0))
                (br $dynDone))
              (else
                (global.set $__dyn_get_cache_props (f64.reinterpret_i64 (local.get $props))))))))
      (local.set $poff (i32.wrap_i64 (i64.and (local.get $props) (i64.const ${LAYOUT.OFFSET_MASK}))))
      (local.set $pcap (i32.load (i32.sub (local.get $poff) (i32.const 4))))
      (local.set $pend (i32.add (local.get $poff) (i32.mul (local.get $pcap) (i32.const ${MAP_ENTRY}))))
      (local.set $slot (i32.add (local.get $poff) (i32.mul (i32.and (local.get $h) (i32.sub (local.get $pcap) (i32.const 1))) (i32.const ${MAP_ENTRY}))))
      (block $hdone (loop $hprobe
        (br_if $dynDone (i64.eqz (i64.load (local.get $slot))))
        (if (call $__str_eq (i64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $key))
          (then (return (i64.load (i32.add (local.get $slot) (i32.const 16))))))
        (local.set $slot (i32.add (local.get $slot) (i32.const ${MAP_ENTRY})))
        (if (i32.ge_u (local.get $slot) (local.get $pend)) (then (local.set $slot (local.get $poff))))
        (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
        (br_if $hdone (i32.ge_s (local.get $tries) (local.get $pcap)))
        (br $hprobe))))${buildObjectSchemaArm()}
    (i64.const ${UNDEF_NAN}))`

  ctx.core.stdlib['__dyn_get_or'] = `(func $__dyn_get_or (param $obj i64) (param $key i64) (param $fallback i64) (result i64)
    (local $val i64)
    (local.set $val (call $__dyn_get (local.get $obj) (local.get $key)))
    (if (result i64)
      (i64.eq (local.get $val) (i64.const ${UNDEF_NAN}))
      (then (local.get $fallback))
      (else (local.get $val))))`

  ctx.core.stdlib['__dyn_get_expr'] = `(func $__dyn_get_expr (param $obj i64) (param $key i64) (result i64)
    (call $__dyn_get_expr_t (local.get $obj) (local.get $key) (call $__ptr_type (local.get $obj))))`

  ctx.core.stdlib['__dyn_get_expr_t'] = `(func $__dyn_get_expr_t (param $obj i64) (param $key i64) (param $t i32) (result i64)
    (local $val i64)
    (local.set $val (call $__dyn_get_t (local.get $obj) (local.get $key) (local.get $t)))
    (if (result i64)
      (i64.ne (local.get $val) (i64.const ${UNDEF_NAN}))
      (then (local.get $val))
      (else
        (if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
          (then (call $__hash_get_local (local.get $obj) (local.get $key)))
          (else (i64.const ${NULL_NAN}))))))`

  // Prehashed variant of __dyn_get_expr_t for constant string keys: the FNV hash
  // is folded at compile time (strHashLiteral), so no __str_hash call at runtime.
  ctx.core.stdlib['__dyn_get_expr_t_h'] = `(func $__dyn_get_expr_t_h (param $obj i64) (param $key i64) (param $t i32) (param $h i32) (result i64)
    (local $val i64)
    (local.set $val (call $__dyn_get_t_h (local.get $obj) (local.get $key) (local.get $t) (local.get $h)))
    (if (result i64)
      (i64.ne (local.get $val) (i64.const ${UNDEF_NAN}))
      (then (local.get $val))
      (else
        (if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
          (then (call $__hash_get_local_h (local.get $obj) (local.get $key) (local.get $h)))
          (else (i64.const ${NULL_NAN}))))))`

  // Like __dyn_get_expr but also resolves EXTERNAL host objects via __ext_prop.
  // Used at call sites where receiver type is statically unknown.
  // When features.external is off, collapses to __dyn_get_expr shape (no EXTERNAL probe).
  ctx.core.stdlib['__dyn_get_any'] = () => {
    // Fast path: HASH check first, route directly to __hash_get_local. Hashes never carry
    // dyn_props (those are for OBJECT/ARRAY attached props), so the original __dyn_get
    // call was always wasted work on hashes — and JSON.parse / Map-style code is the
    // dominant HASH consumer.
    return `(func $__dyn_get_any (param $obj i64) (param $key i64) (result i64)
    (call $__dyn_get_any_t (local.get $obj) (local.get $key) (call $__ptr_type (local.get $obj))))`
  }

  ctx.core.stdlib['__dyn_get_any_t'] = () => {
    const extArm = ctx.features.external
      ? `(if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.EXTERNAL}))
            (then (call $__ext_prop (local.get $obj) (local.get $key)))
            (else (i64.const ${NULL_NAN})))`
      : `(i64.const ${NULL_NAN})`
    return `(func $__dyn_get_any_t (param $obj i64) (param $key i64) (param $t i32) (result i64)
    (local $val i64)
    (if (result i64) (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
      (then (call $__hash_get_local (local.get $obj) (local.get $key)))
      (else
        (local.set $val (call $__dyn_get_t (local.get $obj) (local.get $key) (local.get $t)))
        (if (result i64)
          (i64.ne (local.get $val) (i64.const ${UNDEF_NAN}))
          (then (local.get $val))
          (else ${extArm})))))`
  }

  // Hot for `node.loc = pos` patterns (e.g. watr's parser tags every nested level).
  // Defer the root insert to the end and gate it on props-ptr change: most calls hit
  // the no-grow case where the ptr is unchanged and the root slot already points to it.
  // __ptr_offset inlined (forwarding-aware) — only ARRAY ever has forwarding.
  ctx.core.stdlib['__dyn_set'] = () => `(func $__dyn_set (param $obj i64) (param $key i64) (param $val i64) (result i64)
    (local $root i64) (local $props i64) (local $oldProps i64) (local $objKey i64)
    (local $off i32) (local $type i32) ${buildObjectSchemaSetLocals()}
    (local.set $off (i32.wrap_i64 (i64.and (local.get $obj) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $type (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    ;; CLOSURE with no env (offset 0): key __dyn_props on the function table index — see __dyn_get_t.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.CLOSURE})) (i32.eqz (local.get $off)))
      (then (local.set $off (i32.sub (i32.const -1)
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get $obj) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK})))))))
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then
        (block $done
          (loop $follow
            (br_if $done (i32.lt_u (local.get $off) (i32.const 16)))
            (br_if $done (i32.gt_u (local.get $off) (i32.shl (memory.size) (i32.const 16))))
            (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
            (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (br $follow)))))
    ${buildObjectSchemaSetArm()}
    ;; Header types carry propsPtr at off-16. Read/grow/write directly there;
    ;; skip the global __dyn_props hash entirely. ARRAY also uses this slot, but
    ;; only when shift hasn't overwritten it with forwarding bytes (HASH-tagged
    ;; check rejects 0 + forwarding garbage). Shifted ARRAYs fall back to the
    ;; global __dyn_props where __arr_shift has migrated their props.
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then
        (if (i32.ge_u (local.get $off) (i32.const 16))
          (then
            (local.set $oldProps (i64.load (i32.sub (local.get $off) (i32.const 16))))
            (if (i32.or
                  (i64.eqz (local.get $oldProps))
                  (i32.eq
                    (i32.wrap_i64 (i64.and (i64.shr_u (local.get $oldProps) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
                    (i32.const ${PTR.HASH})))
              (then
                (local.set $props
                  (if (result i64) (i64.eqz (local.get $oldProps))
                    (then (i64.reinterpret_f64 (call $__hash_new_small)))
                    (else (local.get $oldProps))))
                (local.set $props (call $__hash_set_local (local.get $props) (local.get $key) (local.get $val)))
                (if (i64.ne (local.get $props) (local.get $oldProps))
                  (then (i64.store (i32.sub (local.get $off) (i32.const 16)) (local.get $props))))
                (return (local.get $val))))))))
    ;; OBJECT: heap-allocated (off >= __heap_start) writes propsPtr directly at
    ;; off-16. The slot is 0 (init) or HASH — no forwarding-garbage like ARRAY.
    ;; Static-segment OBJECTs fall through to the global __dyn_props.
    (if (i32.and (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                 (i32.ge_u (local.get $off) (global.get $__heap_start)))
      (then
        (local.set $oldProps (i64.load (i32.sub (local.get $off) (i32.const 16))))
        (local.set $props
          (if (result i64) (i64.eqz (local.get $oldProps))
            (then (i64.reinterpret_f64 (call $__hash_new_small)))
            (else (local.get $oldProps))))
        (local.set $props (call $__hash_set_local (local.get $props) (local.get $key) (local.get $val)))
        (if (i64.ne (local.get $props) (local.get $oldProps))
          (then (i64.store (i32.sub (local.get $off) (i32.const 16)) (local.get $props))))
        (return (local.get $val))))
    (if (i32.and (i32.ge_u (local.get $off) (i32.const 16))
          (i32.or (i32.eq (local.get $type) (i32.const ${PTR.TYPED}))
            (i32.or (i32.eq (local.get $type) (i32.const ${PTR.HASH}))
              (i32.or (i32.eq (local.get $type) (i32.const ${PTR.SET}))
                      (i32.eq (local.get $type) (i32.const ${PTR.MAP}))))))
      (then
        (local.set $oldProps (i64.load (i32.sub (local.get $off) (i32.const 16))))
        (local.set $props
          (if (result i64) (i64.eqz (local.get $oldProps))
            (then (i64.reinterpret_f64 (call $__hash_new_small)))
            (else (local.get $oldProps))))
        (local.set $props (call $__hash_set_local (local.get $props) (local.get $key) (local.get $val)))
        (if (i64.ne (local.get $props) (local.get $oldProps))
          (then (i64.store (i32.sub (local.get $off) (i32.const 16)) (local.get $props))))
        (return (local.get $val))))
    ;; Fallback: non-header types use the global __dyn_props.
    (local.set $root (i64.reinterpret_f64 (global.get $__dyn_props)))
    (if (i64.eqz (local.get $root))
      (then (local.set $root (i64.reinterpret_f64 (call $__hash_new)))))
    (local.set $objKey (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off))))
    (local.set $oldProps (call $__ihash_get_local (local.get $root) (local.get $objKey)))
    (local.set $props
      (if (result i64) (call $__is_nullish (local.get $oldProps))
        (then (i64.reinterpret_f64 (call $__hash_new_small)))
        (else (local.get $oldProps))))
    (local.set $props (call $__hash_set_local (local.get $props) (local.get $key) (local.get $val)))
    (if (i64.ne (local.get $props) (local.get $oldProps))
      (then
        (local.set $root (call $__ihash_set_local (local.get $root) (local.get $objKey) (local.get $props)))
        (global.set $__dyn_props (f64.reinterpret_i64 (local.get $root)))
        (if (i32.eq (local.get $off) (global.get $__dyn_get_cache_off))
          (then (global.set $__dyn_get_cache_props (f64.reinterpret_i64 (local.get $props)))))))
    (local.get $val))`

  ctx.core.stdlib['__dyn_move'] = `(func $__dyn_move (param $oldOff i32) (param $newOff i32)
    (local $props i64) (local $root i64)
    (if (f64.eq (global.get $__dyn_props) (f64.const 0)) (then (return)))
    (local.set $props (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $oldOff)))))
    (if (call $__is_nullish (local.get $props)) (then (return)))
    (local.set $root (call $__ihash_set_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $newOff))) (local.get $props)))
    (global.set $__dyn_props (f64.reinterpret_i64 (local.get $root))))`

  // Generated HASH probe functions
  ctx.core.stdlib['__hash_set'] = () => genUpsertGrow('__hash_set', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH, false, ctx.features.external)
  ctx.core.stdlib['__hash_get'] = () => genLookup('__hash_get', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH, true, ctx.features.external)
  ctx.core.stdlib['__hash_has'] = () => genLookup('__hash_has', MAP_ENTRY, '$__str_hash', strEq, PTR.HASH, false, ctx.features.external)

  // === `in` operator: key in obj → HASH key existence check ===
  ctx.core.emit['in'] = (key, obj) => {
    const objType = typeof obj === 'string' ? lookupValType(obj) : valTypeOf(obj)

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
    const idxTmp = tempI32('in_idx')
    const typeTmp = tempI32('in_type')
    const outTmp = tempI32('in_out')

    const keyVal = ['local.get', `$${keyTmp}`]
    const objVal = ['local.get', `$${objTmp}`]
    const idxVal = ['local.get', `$${idxTmp}`]
    const typeVal = ['local.get', `$${typeTmp}`]
    const isStringKey = ['call', '$__is_str_key', ['i64.reinterpret_f64', keyVal]]
    const isStringLike = ['i32.eq', typeVal, ['i32.const', PTR.STRING]]
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
          ['i32.eq', typeVal, ['i32.const', PTR.STRING]],
          ['i32.or',
            ['i32.or',
              ['i32.eq', typeVal, ['i32.const', PTR.SET]],
              ['i32.eq', typeVal, ['i32.const', PTR.MAP]]],
            ['i32.eq', typeVal, ['i32.const', PTR.CLOSURE]]]]]]

    inc('__ptr_type', '__len', '__str_byteLen', '__hash_has', '__is_str_key', '__to_str', '__dyn_get', '__is_nullish')
    if (ctx.features.external) inc('__ext_has')

    return typed(['block', ['result', 'i32'],
      ['local.set', `$${objTmp}`, asF64(emit(obj))],
      ['local.set', `$${keyTmp}`, asF64(emit(key))],
      ['local.set', `$${outTmp}`, ['i32.const', 0]],
      ['local.set', `$${typeTmp}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', objVal]]],
      ['local.set', `$${idxTmp}`, ['i32.trunc_sat_f64_s', keyVal]],

      ['if', ['i32.and',
        ['f64.eq', keyVal, keyVal],
        ['i32.and',
          ['f64.eq', ['f64.convert_i32_s', idxVal], keyVal],
          ['i32.ge_s', idxVal, ['i32.const', 0]]]],
        ['then',
          ['if', isStringLike,
            ['then', ['local.set', `$${outTmp}`, ['i32.lt_u', idxVal, ['call', '$__str_byteLen', ['i64.reinterpret_f64', objVal]]]]]],
          ['if', isArrayLike,
            ['then', ['local.set', `$${outTmp}`, ['i32.lt_u', idxVal, ['call', '$__len', ['i64.reinterpret_f64', objVal]]]]]]]],

      ['if', isStringKey,
        ['then',
          ['if', hasDynProps,
            ['then', ['local.set', `$${outTmp}`,
              ['i32.eqz', ['call', '$__is_nullish', ['call', '$__dyn_get', ['i64.reinterpret_f64', objVal], ['i64.reinterpret_f64', keyVal]]]]]]]]],

      ['if', ['i32.eq', typeVal, ['i32.const', PTR.HASH]],
        ['then', ['local.set', `$${outTmp}`,
          ['if', ['result', 'i32'], isStringKey,
            ['then', ['call', '$__hash_has', ['i64.reinterpret_f64', objVal], ['i64.reinterpret_f64', keyVal]]],
            ['else', ['call', '$__hash_has', ['i64.reinterpret_f64', objVal], ['call', '$__to_str', ['i64.reinterpret_f64', keyVal]]]]]]]],

      ...(ctx.features.external ? [['if', ['i32.eq', typeVal, ['i32.const', PTR.EXTERNAL]],
        ['then', ['local.set', `$${outTmp}`, ['call', '$__ext_has',
          ['i64.reinterpret_f64', objVal], ['i64.reinterpret_f64', keyVal]]]]]] : []),

      ['local.get', `$${outTmp}`]], 'i32')
  }

  // === for...in on dynamic objects (HASH iteration) ===

  // for-in: iterate HASH entries, binding key string to loop variable.
  // Also handles OBJECT/ARRAY/etc whose dynamic props are stored at off-16
  // as a HASH (see __dyn_set). Non-HASH receivers redirect to that props HASH.
  ctx.core.emit['for-in'] = (varName, src, body) => {
    const off = tempI32('ho'), cap = tempI32('hc')
    const i = tempI32('hi'), slot = tempI32('hs')
    const ptrI64 = tempI64('hp'), srcOff = tempI32('hso'), srcType = tempI32('hst')
    if (!ctx.func.locals.has(varName)) ctx.func.locals.set(varName, 'f64')
    const id = ctx.func.uniq++
    const va = asF64(emit(src))
    const bodyFlat = emitFlat(body)
    inc('__ptr_type')
    return [
      // Save source ptr as i64
      ['local.set', `$${ptrI64}`, ['i64.reinterpret_f64', va]],
      ['local.set', `$${srcType}`, ['call', '$__ptr_type', ['local.get', `$${ptrI64}`]]],
      // If not HASH, follow off-16 to props hash (or zero if no props yet).
      ['if', ['i32.ne', ['local.get', `$${srcType}`], ['i32.const', PTR.HASH]],
        ['then',
          ['local.set', `$${srcOff}`, ['call', '$__ptr_offset', ['local.get', `$${ptrI64}`]]],
          ['if', ['i32.ge_u', ['local.get', `$${srcOff}`], ['i32.const', 16]],
            ['then',
              ['local.set', `$${ptrI64}`, ['i64.load', ['i32.sub', ['local.get', `$${srcOff}`], ['i32.const', 16]]]]],
            ['else',
              ['local.set', `$${ptrI64}`, ['i64.const', 0]]]]]],
      // Empty / null props: skip iteration entirely.
      ['if', ['i64.ne', ['local.get', `$${ptrI64}`], ['i64.const', 0]],
        ['then',
          ['local.set', `$${off}`, ['call', '$__ptr_offset', ['local.get', `$${ptrI64}`]]],
          ['local.set', `$${cap}`, ['call', '$__cap', ['local.get', `$${ptrI64}`]]],
          ['local.set', `$${i}`, ['i32.const', 0]],
          ['block', `$brk${id}`, ['loop', `$loop${id}`,
            ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${cap}`]]],
            ['local.set', `$${slot}`, ['i32.add', ['local.get', `$${off}`],
              ['i32.mul', ['local.get', `$${i}`], ['i32.const', MAP_ENTRY]]]],
            ['if', ['i64.ne', ['i64.load', ['local.get', `$${slot}`]], ['i64.const', 0]],
              ['then',
                ['local.set', `$${varName}`, ['f64.reinterpret_i64', ['i64.load', ['i32.add', ['local.get', `$${slot}`], ['i32.const', 8]]]]],
                ...bodyFlat]],
            ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
            ['br', `$loop${id}`]]]]]
    ]
  }
}
