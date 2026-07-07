/**
 * Core module — NaN-boxing, bump allocator, property dispatch.
 *
 * Foundation for all heap types. Every module depends on this.
 * NaN-boxing: see LAYOUT in src/ctx.js for the canonical bit layout.
 *
 * Auto-included by array/object/string modules.
 *
 * @module core
 */

import { typed, asF64, asI32, asI64, NULL_NAN, UNDEF_NAN, TOMB_NAN, FALSE_NAN, TRUE_NAN, temp, usesDynProps, ptrOffsetIR, isNullish, valKindToPtr, sidecarOverride, undefExpr } from '../src/ir.js'
import { emit, spread, deps, wat } from '../src/bridge.js'
import { reconstructArgsWithSpreads } from '../src/ir.js'
import { valTypeOf, shapeOf } from '../src/kind.js'
import { T } from '../src/ast.js'
import { inlineArraySid } from '../src/static.js'
import { VAL, lookupValType, lookupNotString, repOf, updateRep } from '../src/reps.js'
import { ctx, err, inc, PTR, LAYOUT, HEAP, FORWARDING_MASK, emitArity, followForwardingWat, declGlobal } from '../src/ctx.js'
import { ptrOffsetFwdWat, STR_INTERN_BIT } from '../layout.js'
import { nanPrefixHex, encodePtrHi, i64Hex } from '../layout.js'
import { initSchema } from './schema.js'
import { strHashLiteral, heapResetWat } from './collection.js'

const NAN_BITS = nanPrefixHex()

export default (ctx) => {
  deps({
    __eq: ['__str_eq', '__ptr_type'],
    __typeof: ['__ptr_type', '__is_nullish'],
    __len: ['__typed_shift', '__ptr_offset', '__ptr_offset_fwd'],
    __cap: ['__typed_shift', '__ptr_type', '__ptr_offset', '__ptr_aux'],
    __typed_data: ['__ptr_offset', '__ptr_aux'],
    __ptr_offset: ['__ptr_offset_fwd'],
    __ptr_offset_fwd: [],
    __is_str_key: ['__ptr_type'],
    __str_len: ['__ptr_type', '__ptr_offset', '__ptr_aux'],
    __set_len: ['__ptr_offset_fwd'],
    __length: ['__ptr_type', '__str_len', '__len'],
    __alloc: ['__memgrow'],
    __alloc_hdr: ['__alloc'],
    __alloc_hdr_n: ['__alloc'],
    __coll_order: ['__alloc'],
    // Durable-receiver global-table merge (see __obj_clone's body) pulls in
    // __ihash_get_local/__is_nullish only when collection.js's dyn-props
    // machinery is actually part of this build (mirrors json.js's __json_obj
    // and array.js's needsArrayDynMove-gated deps thunks).
    __obj_clone: () => ['__ptr_type', '__ptr_aux', '__ptr_offset', '__len', '__cap', '__alloc_hdr', '__alloc_hdr_n', '__mkptr',
      ...(ctx.scope.globals.has('__dyn_props') ? ['__ihash_get_local', '__is_nullish'] : [])],
    __durable_fwd_log: ['__alloc'],
    __durable_fwd_heal: [],
    __durable_slot_log: ['__alloc'],
    __durable_slot_heal: [],
    __is_eph_bits: [],
  })

  ctx.core.stdlib['__is_nullish'] = `(func $__is_nullish (param $v i64) (result i32)
    (i32.or
      (i64.eq (local.get $v) (i64.const ${NULL_NAN}))
      (i64.eq (local.get $v) (i64.const ${UNDEF_NAN}))))`

  ctx.core.stdlib['__eq'] = `(func $__eq (param $a i64) (param $b i64) (result i32)
    (local $fa f64) (local $fb f64) (local $ta i32) (local $tb i32)
    ;; Fast path: bit equality covers identical pointers AND interned/SSO strings (same content
    ;; → same bits). Failing universal-NaN test catches NaN===NaN→false. Saves the NaN-check
    ;; pair (4 f64.eq) on the hottest case in watr (op === 'literal-string'). A number-NaN is
    ;; *only ever* the canonical NAN_BITS here: math ops canonicalize at the source (the
    ;; canon helper in module/math.js), so a non-canonical 0xFFF8.. pattern can only be a
    ;; negative BigInt carrier — bit-identical to itself and correctly equal.
    (if (result i32) (i64.eq (local.get $a) (local.get $b))
      (then (i64.ne (local.get $a) (i64.const ${NAN_BITS})))
      (else
        ;; Bits differ. Numeric path covers -0/+0 and any normal numeric inequality.
        (local.set $fa (f64.reinterpret_i64 (local.get $a)))
        (local.set $fb (f64.reinterpret_i64 (local.get $b)))
        (if (result i32)
          (i32.and
            (f64.eq (local.get $fa) (local.get $fa))
            (f64.eq (local.get $fb) (local.get $fb)))
          (then (f64.eq (local.get $fa) (local.get $fb)))
          (else
            ;; At least one operand is a NaN-box (the && above failed). For both to
            ;; be strings BOTH must be NaN-boxed: tag bits are only meaningful on a
            ;; NaN-box, so a normal number whose exponent bits happen to alias the
            ;; STRING tag (e.g. ASCII content read as f64) must NOT route to __str_eq
            ;; — that would deref garbage. number-vs-string is simply false.
            (local.set $ta (i32.wrap_i64 (i64.and (i64.shr_u (local.get $a) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
            (local.set $tb (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
            (if (result i32)
              (i32.and
                (i32.and (f64.ne (local.get $fa) (local.get $fa)) (i32.eq (local.get $ta) (i32.const ${PTR.STRING})))
                (i32.and (f64.ne (local.get $fb) (local.get $fb)) (i32.eq (local.get $tb) (i32.const ${PTR.STRING}))))
              (then
                ;; both canonical interned (bit-ne already known) ⇒ unequal —
                ;; skip the __str_eq call entirely (see STR_INTERN_BIT, layout.js)
                (if (result i32)
                  (i32.and
                    (i32.eq (i32.and (i32.wrap_i64 (i64.shr_u (local.get $a) (i64.const ${LAYOUT.AUX_SHIFT}))) (i32.const ${LAYOUT.SSO_BIT | LAYOUT.SLICE_BIT | STR_INTERN_BIT})) (i32.const ${STR_INTERN_BIT}))
                    (i32.eq (i32.and (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const ${LAYOUT.AUX_SHIFT}))) (i32.const ${LAYOUT.SSO_BIT | LAYOUT.SLICE_BIT | STR_INTERN_BIT})) (i32.const ${STR_INTERN_BIT})))
                  (then (i32.const 0))
                  (else (call $__str_eq (local.get $a) (local.get $b)))))
              (else (i32.const 0))))))))`

  ctx.core.stdlib['__is_null'] = `(func $__is_null (param $v i64) (result i32)
    (i64.eq (local.get $v) (i64.const ${NULL_NAN})))`

  // Truthy check: handles regular numbers AND NaN-boxed pointers
  // Falsy: 0, -0, NaN, null, undefined, "" (empty SSO)
  ctx.core.stdlib['__is_truthy'] = `(func $__is_truthy (param $v i64) (result i32)
    (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (result i32) (f64.eq (local.get $f) (local.get $f))
      (then (f64.ne (local.get $f) (f64.const 0)))
      (else
        (i32.and
          (i32.and
            (i32.and
              (i64.ne (local.get $v) (i64.const ${NAN_BITS}))
              (i64.ne (local.get $v) (i64.const ${NULL_NAN})))
            (i32.and
              (i64.ne (local.get $v) (i64.const ${UNDEF_NAN}))
              (i64.ne (local.get $v) (i64.const 0x7FFA400000000000))))
          (i64.ne (local.get $v) (i64.const ${FALSE_NAN}))))))`

  ctx.core.stdlib['__is_str_key'] = `(func $__is_str_key (param $v i64) (result i32)
    (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (result i32) (f64.eq (local.get $f) (local.get $f))
      (then (i32.const 0))
      (else
        (i32.eq (call $__ptr_type (i64.reinterpret_f64 (local.get $f))) (i32.const ${PTR.STRING})))))`


  // Default dynamic-property helpers are harmless stubs. The collection module
  // overrides them with the real sidecar-property implementation.
  ctx.core.stdlib['__dyn_get'] = `(func $__dyn_get (param $obj i64) (param $key i64) (result i64)
    (i64.const ${UNDEF_NAN}))`
  ctx.core.stdlib['__dyn_get_or'] = `(func $__dyn_get_or (param $obj i64) (param $key i64) (param $fallback i64) (result i64)
    (local.get $fallback))`
  // Sidecar probe entry (sidecarOverride / the builtin-shadow method fork): with
  // no dyn-props module there are no own props — the probe always misses and the
  // builtin arm runs, which is exactly the stub-world semantics.
  ctx.core.stdlib['__dyn_get_expr'] = `(func $__dyn_get_expr (param $obj i64) (param $key i64) (result i64)
    (i64.const ${UNDEF_NAN}))`
  ctx.core.stdlib['__dyn_set'] = `(func $__dyn_set (param $obj i64) (param $key i64) (param $val i64) (result i64)
    (local.get $val))`
  // Signature must match collection.js's real __dyn_move (i32 result: 1 = an
  // entry was found+rekeyed, 0 = no-op) — array.js's grow/shift call sites are
  // built once and call whichever version ends up registered.
  ctx.core.stdlib['__dyn_move'] = `(func $__dyn_move (param $oldOff i32) (param $newOff i32) (result i32)
    (i32.const 0))`

  // Memory section auto-enabled: compile.js checks ctx.module.modules.ptr

  // === NaN-boxing: encode/decode ===

  ctx.core.stdlib['__mkptr'] = `(func $__mkptr (param $type i32) (param $aux i32) (param $offset i32) (result f64)
    (f64.reinterpret_i64 (i64.or
      (i64.const ${NAN_BITS})
      (i64.or
        (i64.shl (i64.and (i64.extend_i32_u (local.get $type)) (i64.const ${LAYOUT.TAG_MASK})) (i64.const ${LAYOUT.TAG_SHIFT}))
        (i64.or
          (i64.shl (i64.and (i64.extend_i32_u (local.get $aux)) (i64.const ${LAYOUT.AUX_MASK})) (i64.const ${LAYOUT.AUX_SHIFT}))
          (i64.and (i64.extend_i32_u (local.get $offset)) (i64.const ${LAYOUT.OFFSET_MASK})))))))`

  // Relative-index clamp to `[0, len]` — the JS `RelativeIndex`/`ToIntegerOrInfinity`
  // bounds dance shared by slice/subarray/fill/copyWithin (string + typed + array).
  // Single shared body so N method bodies don't each inline the same six branches.
  wat('__clamp_idx', `(func $__clamp_idx (param $v i32) (param $len i32) (result i32)
    (if (i32.lt_s (local.get $v) (i32.const 0)) (then (local.set $v (i32.add (local.get $v) (local.get $len)))))
    (if (i32.lt_s (local.get $v) (i32.const 0)) (then (local.set $v (i32.const 0))))
    (if (i32.gt_s (local.get $v) (local.get $len)) (then (local.set $v (local.get $len))))
    (local.get $v))`)

  // Polymorphic element read for any heap-indexable (ARRAY or TYPED). The one
  // home for `arr[i]` lowering: ARRAY and typed reads both route here, plain-array
  // programs get the ARRAY-only collapse, typed programs the full elem dispatch.
  ctx.core.stdlib['__typed_idx'] = () => {
    if (!ctx.features.typedarray && !ctx.features.external) {
      return `(func $__typed_idx (param $ptr i64) (param $i i32) (result f64)
    (local $len i32)
    (local.set $len (call $__len (local.get $ptr)))
    (if (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (local.get $len)))
      (then (f64.const nan:${UNDEF_NAN}))
      (else (f64.load (i32.add (call $__ptr_offset (local.get $ptr)) (i32.shl (local.get $i) (i32.const 3)))))))`
    }
    // Hot (~37M calls in watr self-host). Type/aux/offset extracted once from $ptr.
    return `(func $__typed_idx (param $ptr i64) (param $i i32) (result f64)
    (local $t i32) (local $off i32) (local $et i32) (local $len i32) (local $aux i32)
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; ARRAY fast path: follow forwarding inline, bounds-check against header len, f64.load — no $__len call.
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.ARRAY})) (i32.ge_u (local.get $off) (i32.const 8)))
      (then
        ${followForwardingWat('$off', { lowGuard: false })}
        (return (if (result f64)
          (i32.and (i32.ge_s (local.get $i) (i32.const 0)) (i32.lt_u (local.get $i) (i32.load (i32.sub (local.get $off) (i32.const 8)))))
          (then (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
          (else (f64.const nan:${UNDEF_NAN}))))))
    (local.set $aux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
    (if
      (i32.and
        (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
        (i32.ne (i32.and (local.get $aux) (i32.const 8)) (i32.const 0)))
      (then (local.set $off (i32.load (i32.add (local.get $off) (i32.const 4))))))
    (local.set $len (call $__len (local.get $ptr)))
    (if (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (local.get $len)))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (if (result f64) (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
          (then
            (local.set $et (i32.and (local.get $aux) (i32.const 7)))
            (if (result f64) (i32.ge_u (local.get $et) (i32.const 6))
              (then (if (result f64) (i32.eq (local.get $et) (i32.const 7))
                (then (if (result f64) (i32.and (local.get $aux) (i32.const 16))
                  (then (f64.reinterpret_i64 (i64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))))
                  (else (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))))
                (else (f64.promote_f32 (f32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))))
              (else (if (result f64) (i32.ge_u (local.get $et) (i32.const 4))
                (then (if (result f64) (i32.and (local.get $et) (i32.const 1))
                  (then (f64.convert_i32_u (i32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))
                  (else (f64.convert_i32_s (i32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 2))))))))
                (else (if (result f64) (i32.ge_u (local.get $et) (i32.const 2))
                  (then (if (result f64) (i32.and (local.get $et) (i32.const 1))
                    (then (f64.convert_i32_u (i32.load16_u (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1))))))
                    (else (f64.convert_i32_s (i32.load16_s (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1))))))))
                  (else (if (result f64) (i32.and (local.get $et) (i32.const 1))
                    (then (f64.convert_i32_u (i32.load8_u (i32.add (local.get $off) (local.get $i)))))
                    (else (f64.convert_i32_s (i32.load8_s (i32.add (local.get $off) (local.get $i)))))))))))))
          (else (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))))))`
  }

  ctx.core.stdlib['__ptr_offset_fwd'] = ptrOffsetFwdWat()

  ctx.core.stdlib['__ptr_offset'] = `(func $__ptr_offset (param $ptr i64) (result i32)
    (local $bits i64) (local $off i32) (local $t i32)
    (local.set $bits (local.get $ptr))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; ARRAY/SET/MAP/HASH can be reallocated on growth; follow the forwarding pointer
    ;; (cap=-1 sentinel at -4, new offset at -8). Other types never forward, so they skip
    ;; the loop; a well-formed ptr without forwarding pays one bounds + cap check per hop.
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (if (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${FORWARDING_MASK}))
      (then
        ${followForwardingWat('$off', { lowGuard: true })}))
    (local.get $off))`

  ctx.core.stdlib['__ptr_aux'] = `(func $__ptr_aux (param $ptr i64) (result i32)
    (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))`

  // Exact JS `%` (fmod) for the f64 path. wasm has no f64 remainder, and the
  // textbook `a - b*trunc(a/b)` is both INEXACT (rounding in trunc/mul/sub for
  // large a/b) and WRONG on the IEEE edges. This does the spec exactly:
  //   NaN if a or b is NaN, a is ±Inf, or b is 0; a if b is ±Inf or |a|<|b|;
  //   otherwise binary long division — scale |b| up to ≤|a|, then subtract-and-
  //   halve back down to |b|. Every step (×2, ×0.5, aligned subtraction) is
  //   exact in f64, so the remainder is bit-identical to JS. Sign follows the
  //   dividend (copysign), matching `(-5)%3 === -2`, `5%(-3) === 2`, `-0%3 === -0`.
  ctx.core.stdlib['__rem'] = `(func $__rem (param $a f64) (param $b f64) (result f64)
    (local $x f64) (local $y f64)
    (if (f64.ne (local.get $a) (local.get $a)) (then (return (local.get $a))))
    (if (f64.ne (local.get $b) (local.get $b)) (then (return (local.get $b))))
    (local.set $x (f64.abs (local.get $a)))
    (local.set $y (f64.abs (local.get $b)))
    (if (i32.or (f64.eq (local.get $x) (f64.const inf)) (f64.eq (local.get $y) (f64.const 0)))
      (then (return (f64.div (f64.const 0) (f64.const 0)))))
    (if (i32.or (f64.eq (local.get $y) (f64.const inf)) (f64.lt (local.get $x) (local.get $y)))
      (then (return (local.get $a))))
    (block $up (loop $ul
      (br_if $up (f64.gt (f64.mul (local.get $y) (f64.const 2)) (local.get $x)))
      (local.set $y (f64.mul (local.get $y) (f64.const 2)))
      (br $ul)))
    (block $dn (loop $dl
      (br_if $dn (f64.lt (local.get $y) (f64.abs (local.get $b))))
      (if (f64.ge (local.get $x) (local.get $y)) (then (local.set $x (f64.sub (local.get $x) (local.get $y)))))
      (local.set $y (f64.mul (local.get $y) (f64.const 0.5)))
      (br $dl)))
    (f64.copysign (local.get $x) (local.get $a)))`


  ctx.core.stdlib['__ptr_type'] = `(func $__ptr_type (param $ptr i64) (result i32)
    (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))`

  // True iff a NaN-boxed value is a non-primitive (heap object) — tag is neither
  // ATOM (null/undefined/boolean/symbol) nor STRING. A genuine f64 Number is
  // never NaN-boxed, so `f64.eq(x,x)` holding proves it a primitive. Drives the
  // ES `OrdinaryToPrimitive` method-fallback chain (src/ir.js toPrimitiveChain).
  ctx.core.stdlib['__is_object'] = `(func $__is_object (param $p i64) (result i32)
    (local $t i32)
    (if (f64.eq (f64.reinterpret_i64 (local.get $p)) (f64.reinterpret_i64 (local.get $p)))
      (then (return (i32.const 0))))
    (local.set $t (call $__ptr_type (local.get $p)))
    (i32.and
      (i32.ne (local.get $t) (i32.const ${PTR.ATOM}))
      (i32.ne (local.get $t) (i32.const ${PTR.STRING}))))`

  // === Bump allocator ===

  // Heap-base watermark: gates header-backed propsPtr fast paths so static-data
  // OBJECT slots (offsets < heap base) don't misread arbitrary memory at off-16.
  // Updated by optimizeModule() when data segment exceeds HEAP.START bytes.
  declGlobal('__heap_start', 'i32', HEAP.START)

  // Shared memory keeps the heap pointer in linear memory (memory[HEAP.PTR_ADDR]):
  // wasm globals are per-instance, so threads sharing one memory must share one
  // pointer cell. Non-shared memory (incl. alloc:false) uses the `$__heap`
  // global — exported so the JS-side adapter (memory.String etc) bumps the same
  // pointer. Storing it in memory would collide with the static data section
  // whenever the data exceeds HEAP.PTR_ADDR bytes.
  // Geometric memory growth shared by `__alloc` and the in-place string
  // bump-extend paths (string.js). Ensures linear memory covers byte offset
  // `$next`, growing when short. Growing one page at a time turns a long-running
  // embedding (watr called thousands of times) into O(n²) — each memory.grow may
  // relocate and copy the whole heap — so we request at least the current size
  // (≥2× total) in one shot; only on hitting the declared maximum do we fall back
  // to the bare minimum. `$need` is the TOTAL pages required to cover $next; the
  // byte size of memory ((memory.size)<<16) is computed in i64 because it
  // overflows i32 at the wasm32 max of 65536 pages (4 GiB) — without that,
  // capacity reads as 0 and every allocation spuriously tries to grow past the
  // ceiling, trapping near 4 GiB.
  ctx.core.stdlib['__memgrow'] = `(func $__memgrow (param $next i32)
    (local $cur i32) (local $need i32)
    (local.set $need (i32.wrap_i64 (i64.shr_u (i64.add (i64.extend_i32_u (local.get $next)) (i64.const 65535)) (i64.const 16))))
    (if (i32.gt_u (local.get $need) (memory.size))
      (then
        (if (i64.gt_u (i64.extend_i32_u (local.get $need)) (i64.const 65536)) (then (unreachable)))
        (local.set $cur (i32.sub (local.get $need) (memory.size)))            ;; minimum delta
        (if (i32.lt_u (local.get $cur) (memory.size)) (then (local.set $cur (memory.size))))  ;; geometric
        (if (i32.gt_u (i32.add (local.get $cur) (memory.size)) (i32.const 65536))
          (then (local.set $cur (i32.sub (i32.const 65536) (memory.size)))))  ;; cap at wasm32 max
        (if (i32.eq (memory.grow (local.get $cur)) (i32.const -1))
          (then (if (i32.eq (memory.grow (i32.sub (local.get $need) (memory.size))) (i32.const -1))
            (then (unreachable))))))))`

  if (ctx.memory.shared) {
    // Heap offset stored at memory[HEAP.PTR_ADDR] (i32), just before heap start at
    // HEAP.START. Threads sharing one memory must share one pointer cell.
    ctx.core.stdlib['__alloc'] = `(func $__alloc (param $bytes i32) (result i32)
      (local $ptr i32) (local $next i32)
      (local.set $ptr (i32.load (i32.const ${HEAP.PTR_ADDR})))
      (local.set $next (i32.and (i32.add (i32.add (local.get $ptr) (local.get $bytes)) (i32.const 7)) (i32.const -8)))
      (call $__memgrow (local.get $next))
      (i32.store (i32.const ${HEAP.PTR_ADDR}) (local.get $next))
      (local.get $ptr))`
    // NOTE: shared memory rewinds to the raw HEAP.START, NOT a post-init high-water
    // mark — so a shared module whose `__start` heap-allocates (strPool memory.init,
    // module-init state) loses that state on `_clear`. Pre-existing; unlike the owned
    // path below it has no `__heap_reset` analogue because the rewind target would need
    // a reserved low-memory cell (the [0,HEAP.START) region is already spoken for —
    // clock at 0, heap ptr at HEAP.PTR_ADDR). Owned memory (the self-host + default
    // case) is the one fixed below; revisit shared if a thread-pooled reset hits it.
    ctx.core.stdlib['__clear'] = `(func $__clear
      (i32.store (i32.const ${HEAP.PTR_ADDR}) (i32.const ${HEAP.START})))`
  } else {
    // Own memory: heap offset in a global, exported so the JS-side adapter
    // (alloc:false, no `_alloc` export) shares the pointer.
    declGlobal('__heap', 'i32', HEAP.START, { export: '__heap' })
    // `__clear` rewinds to the *post-module-init* high-water mark, not the static
    // data end: a module whose top-level code heap-allocates (e.g. the self-host
    // compiler building its GLOBALS/atom tables in `__start`) leaves live state
    // above the data segment that a reset must preserve. `__heap_reset` is seeded
    // to the data end (assemble.js heapBase patch) and overwritten by `__start`'s
    // tail with the heap top after init runs (buildStartFn) — so for a module with
    // no init allocations it equals the data end, and for self-host it spares the
    // compiler's init state. (Distinct from `__heap_start`, the propsPtr watermark,
    // which must stay at the data end or init-time heap objects misread as static.)
    declGlobal('__heap_reset', 'i32', HEAP.START)
    ctx.core.stdlib['__alloc'] = `(func $__alloc (param $bytes i32) (result i32)
      (local $ptr i32) (local $next i32)
      (local.set $ptr (global.get $__heap))
      (local.set $next (i32.and (i32.add (i32.add (local.get $ptr) (local.get $bytes)) (i32.const 7)) (i32.const -8)))
      (call $__memgrow (local.get $next))
      (global.set $__heap (local.get $next))
      (local.get $ptr))`
    // __clear rewinds the bump arena, but __dyn_props/__dyn_get_cache_* (declared
    // unconditionally whenever the collection module loads — module/collection.js)
    // cache pointers/offsets INTO that arena across calls, so a warm compile-clear-
    // compile loop needs them reset too — see the post-hoc patch in
    // src/wat/assemble.js (search "__dyn_props reset") for WHY this can't gate on
    // `ctx.scope.globals.has(...)` at declaration time: that's true whenever
    // collection is loaded AT ALL, even for a program that never touches dynamic
    // props, and __clear's own resolved text is scanned by reachableStdlib — an
    // unconditional `global.set $__dyn_props` line here would leak that (dead,
    // for this program) name into non-dyn-prop output, both wasting bytes and
    // (worse) tripping WAT-substring test assertions like
    // `!/__dyn_get/.test(wat)` (test/closures.js) since __dyn_get_cache_off/props
    // contain that substring. The real gate — whether __dyn_set (the only writer
    // of __dyn_props) is actually reachable — isn't known until AFTER
    // reachableStdlib runs, so the reset is injected post-hoc once that's settled.
    ctx.core.stdlib['__clear'] = `(func $__clear
      (global.set $__heap (global.get $__heap_reset)))`

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
    ctx.core.stdlib['__durable_fwd_log'] = `(func $__durable_fwd_log (param $off i32) (param $len i32) (param $cap i32)
      (local $base i32) (local $n i32)
      (if (i32.eqz (global.get $__durable_fwd_buf))
        (then (global.set $__durable_fwd_buf (call $__alloc (i32.const 3072)))))
      (local.set $n (global.get $__durable_fwd_n))
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
      (if (i64.ne (i64.and (local.get $b) (i64.const 0xFFF8000000000000)) (i64.const 0x7FF8000000000000))
        (then (return (i32.const 0))))
      (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
      ;; heap kinds {ARRAY,BUFFER,TYPED,STRING,OBJECT,HASH,SET,MAP,CLOSURE} = bits 1-4,6-10 → 0x7DE
      (if (i32.eqz (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const 0x7DE)))
        (then (return (i32.const 0))))
      (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
                   (i64.ne (i64.and (local.get $b) (i64.const ${(BigInt(LAYOUT.SSO_BIT) << 32n).toString()})) (i64.const 0)))
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
    ctx.core.stdlib['__durable_slot_heal'] = `(func $__durable_slot_heal
      (local $i i32) (local $n i32) (local $a i32) (local $base i32) (local $tbl i32)
      (local.set $n (global.get $__durable_slot_n))
      (block $done (loop $l
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $base (i32.add (global.get $__durable_slot_buf) (i32.shl (local.get $i) (i32.const 3))))
        (local.set $a (i32.load (local.get $base)))
        (local.set $tbl (i32.load (i32.add (local.get $base) (i32.const 4))))
        (if (i32.and (local.get $a) (i32.const 1))
          ;; bit0: ENTRY heal — this round INSERTED the entry into durable storage; a
          ;; fresh instance would not have it. Zombie it (key TOMB, value undefined —
          ;; probes pass over, __coll_order skips) and decrement the table len so
          ;; len-sized iteration and .size agree. Runs AFTER __durable_fwd_heal, so a
          ;; grown-then-healed table's len is already its restored pre-grow value.
          (then
            (local.set $a (i32.and (local.get $a) (i32.const -2)))
            (i64.store (i32.add (local.get $a) (i32.const 8)) (i64.const ${TOMB_NAN}))
            (i64.store (i32.add (local.get $a) (i32.const 16)) (i64.const ${UNDEF_NAN}))
            (i32.store (i32.sub (local.get $tbl) (i32.const 8))
              (i32.sub (i32.load (i32.sub (local.get $tbl) (i32.const 8))) (i32.const 1))))
          ;; plain: VALUE heal — the entry pre-existed durably; its old value is
          ;; unrecoverable, undefined is the honest read.
          (else (i64.store (local.get $a) (i64.const ${UNDEF_NAN}))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
      (global.set $__durable_slot_n (i32.const 0))
      (global.set $__durable_slot_buf (i32.const 0)))`
  }

  // Build an insertion-ordered list of live slot offsets for a Set/Map/HASH
  // backing table at $off (cap slots of $stride bytes). Returns a fresh i32 array
  // (live-count entries) of slot offsets sorted by packed sequence (the insertion
  // counter rides in each entry's hash-word high 32 bits — see collection.js's
  // seqStore). Every order-sensitive iteration (keys/values/entries, for-in,
  // spread, JSON, Map copy) walks this instead of raw slot order, so jz matches
  // the JS spec's insertion order. Lives in core (not collection) because object
  // and json iterate HASH tables without pulling the collection module. Insertion
  // sort: enumerated collections are small, and it stays branch-light when sorted.
  ctx.core.stdlib['__coll_order'] = `(func $__coll_order (param $off i32) (param $cap i32) (param $stride i32) (result i32)
    (local $i i32) (local $n i32) (local $slot i32) (local $buf i32)
    (local $j i32) (local $k i32) (local $cur i32) (local $sq i32)
    ;; A null/empty backing pointer (off below the heap base) has no live slots —
    ;; ordering it yields the empty list. Guard before the $off-8 length read so a
    ;; degenerate receiver returns an empty buffer instead of faulting on load(-8).
    (if (i32.lt_u (local.get $off) (i32.const ${HEAP.START})) (then (return (call $__alloc (i32.const 0)))))
    (local.set $buf (call $__alloc (i32.shl (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 2))))
    ;; gather live slot offsets (occupied ⇔ hash word ≠ 0)
    (block $gd (loop $gl
      (br_if $gd (i32.ge_s (local.get $i) (local.get $cap)))
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $i) (local.get $stride))))
      (if (i32.and
            (i64.ne (i64.load (local.get $slot)) (i64.const 0))
            ;; skip healed zombie entries (durable-slot heal: key = TOMB sentinel)
            (i64.ne (i64.load (i32.add (local.get $slot) (i32.const 8))) (i64.const ${TOMB_NAN})))
        (then
          (i32.store (i32.add (local.get $buf) (i32.shl (local.get $n) (i32.const 2))) (local.get $slot))
          (local.set $n (i32.add (local.get $n) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $gl)))
    ;; insertion-sort buf[0..n) ascending by sequence = hash-word high 32 bits
    (local.set $j (i32.const 1))
    (block $sd (loop $sl
      (br_if $sd (i32.ge_s (local.get $j) (local.get $n)))
      (local.set $cur (i32.load (i32.add (local.get $buf) (i32.shl (local.get $j) (i32.const 2)))))
      (local.set $sq (i32.wrap_i64 (i64.shr_u (i64.load (local.get $cur)) (i64.const 32))))
      (local.set $k (i32.sub (local.get $j) (i32.const 1)))
      (block $id (loop $il
        (br_if $id (i32.lt_s (local.get $k) (i32.const 0)))
        (br_if $id (i32.le_u
          (i32.wrap_i64 (i64.shr_u (i64.load (i32.load (i32.add (local.get $buf) (i32.shl (local.get $k) (i32.const 2))))) (i64.const 32)))
          (local.get $sq)))
        (i32.store (i32.add (local.get $buf) (i32.shl (i32.add (local.get $k) (i32.const 1)) (i32.const 2)))
          (i32.load (i32.add (local.get $buf) (i32.shl (local.get $k) (i32.const 2)))))
        (local.set $k (i32.sub (local.get $k) (i32.const 1)))
        (br $il)))
      (i32.store (i32.add (local.get $buf) (i32.shl (i32.add (local.get $k) (i32.const 1)) (i32.const 2))) (local.get $cur))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $sl)))
    (local.get $buf))`

  // === Memory-based length/cap helpers (C-style headers) ===

  // Array/TypedArray/Buffer: [-8:len(i32)][-4:cap(i32)][data...]
  // For ARRAY/HASH/SET/MAP: len is element count.
  // For BUFFER: len is byte count. For owned TYPED: header stores byte count; len
  // is derived as byteLen >> log2(stride) so reinterpret views share their parent
  // BUFFER's header (zero-copy aliasing).
  // For TYPED subviews (aux bit 3 set): offset points to a 16-byte descriptor
  //   [0:byteLen(i32)][4:dataOff(i32)][8:parentOff(i32)][12:pad]
  // elemType = aux & 7, isView = aux & 8.
  ctx.core.stdlib['__typed_shift'] = `(func $__typed_shift (param $et i32) (result i32)
    (if (result i32) (i32.eq (local.get $et) (i32.const 7))
      (then (i32.const 3))
      (else (if (result i32) (i32.ge_u (local.get $et) (i32.const 4))
        (then (i32.const 2))
        (else (i32.shr_u (local.get $et) (i32.const 1)))))))`

  // Real data address for any TYPED ptr: owned → offset, view → [offset+4].
  ctx.core.stdlib['__typed_data'] = `(func $__typed_data (param $ptr i64) (result i32)
    (local $off i32)
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (result i32) (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const 8))
      (then (i32.load (i32.add (local.get $off) (i32.const 4))))
      (else (local.get $off))))`

  // Hot (~85M calls in watr self-host). Type/offset extraction inlined; forwarding
  // loop only entered for ARRAY. ARRAY fast path dominates (nodes?.length, out.length …).
  ctx.core.stdlib['__len'] = `(func $__len (param $ptr i64) (result i32)
    (local $bits i64) (local $t i32) (local $off i32) (local $aux i32)
    (local.set $bits (local.get $ptr))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; ARRAY fast path: follow forwarding inline, then load len at off-8.
    (if (result i32)
      (i32.and (i32.eq (local.get $t) (i32.const 1)) (i32.ge_u (local.get $off) (i32.const 8)))
      (then
        ${followForwardingWat('$off', { lowGuard: false })}
        (i32.load (i32.sub (local.get $off) (i32.const 8))))
      (else
        (if (result i32)
          (i32.and
            (i32.ge_u (local.get $off) (i32.const 8))
            (i32.or
              (i32.eq (local.get $t) (i32.const 3))
              (i32.or (i32.eq (local.get $t) (i32.const ${PTR.BUFFER}))
                (i32.or (i32.eq (local.get $t) (i32.const 7))
                  (i32.or (i32.eq (local.get $t) (i32.const 8)) (i32.eq (local.get $t) (i32.const 9)))))))
          (then
            (if (result i32) (i32.eq (local.get $t) (i32.const 3))
              (then
                (local.set $aux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
                (if (result i32) (i32.and (local.get $aux) (i32.const 8))
                  (then (i32.shr_u (i32.load (local.get $off))
                                   (call $__typed_shift (i32.and (local.get $aux) (i32.const 7)))))
                  (else (i32.shr_u (i32.load (i32.sub (local.get $off) (i32.const 8)))
                                   (call $__typed_shift (i32.and (local.get $aux) (i32.const 7)))))))
              ;; HASH/SET/MAP/BUFFER: re-resolve offset so grown SET/MAP follow the
              ;; forwarding chain (HASH/BUFFER never forward → same inline offset).
              (else (i32.load (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 8))))))
          (else (i32.const 0))))))`

  ctx.core.stdlib['__cap'] = `(func $__cap (param $ptr i64) (result i32)
    (local $t i32) (local $off i32) (local $aux i32)
    (local.set $t (call $__ptr_type (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (result i32)
      (i32.and
        (i32.ge_u (local.get $off) (i32.const 4))
        (i32.or
          (i32.or
            (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 3)))
            (i32.eq (local.get $t) (i32.const ${PTR.BUFFER})))
          (i32.or (i32.eq (local.get $t) (i32.const 7))
            (i32.or (i32.eq (local.get $t) (i32.const 8)) (i32.eq (local.get $t) (i32.const 9))))))
      (then
        (if (result i32) (i32.eq (local.get $t) (i32.const 3))
          (then
            (local.set $aux (call $__ptr_aux (local.get $ptr)))
            (if (result i32) (i32.and (local.get $aux) (i32.const 8))
              ;; views are non-growable: cap = len (byteLen at [off])
              (then (i32.shr_u (i32.load (local.get $off))
                               (call $__typed_shift (i32.and (local.get $aux) (i32.const 7)))))
              (else (i32.shr_u (i32.load (i32.sub (local.get $off) (i32.const 4)))
                               (call $__typed_shift (i32.and (local.get $aux) (i32.const 7)))))))
          (else (i32.load (i32.sub (local.get $off) (i32.const 4))))))
      (else (i32.const 0))))`

  // String length (UTF-8 byte count). Heap: [-4:len(i32)][chars...]; SSO (7-bit codec):
  // len at aux bits 10-12 (= payload bits 42-44). See module/string.js codec.
  ctx.core.stdlib['__str_len'] = `(func $__str_len (param $ptr i64) (result i32)
    (local $off i32) (local $aux i32)
    (if (i32.ne (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.STRING}))
      (then (return (i32.const 0))))
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (if (i32.and (local.get $aux) (i32.const ${LAYOUT.SSO_BIT}))
      (then (return (i32.and (i32.shr_u (local.get $aux) (i32.const 10)) (i32.const 7)))))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (result i32) (i32.ge_u (local.get $off) (i32.const 4))
      (then (i32.load (i32.sub (local.get $off) (i32.const 4))))
      (else (i32.const 0))))`

  // Set len in memory (for push/pop). Hot (~42M calls in watr self-host).
  // Type/offset extraction inlined; forwarding loop only entered for ARRAY.
  ctx.core.stdlib['__set_len'] = `(func $__set_len (param $ptr i64) (param $len i32)
    (local $bits i64) (local $t i32) (local $off i32)
    (local.set $bits (local.get $ptr))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; Only ARRAY (1), TYPED (3), HASH (7), SET (8), MAP (9) carry an 8-byte header.
    ;; Of those, only ARRAY can be forwarded — follow the chain inline.
    (if
      (i32.and
        (i32.ge_u (local.get $off) (i32.const 8))
        (i32.or
          (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 3)))
          (i32.or (i32.eq (local.get $t) (i32.const 7))
            (i32.or (i32.eq (local.get $t) (i32.const 8)) (i32.eq (local.get $t) (i32.const 9))))))
      (then
        (if (i32.eq (local.get $t) (i32.const 1))
          (then
            ${followForwardingWat('$off', { lowGuard: true })}))
        (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $len)))))`

  // Alloc header(16) + data(cap*stride). Layout: [propsPtr@-16(f64=0), len@-8, cap@-4],
  // data starts at returned offset. propsPtr at -16 holds a per-object dynamic-property hash
  // (NaN-boxed PTR.HASH) for ARRAY/HASH/MAP/SET; 0 means "no dyn props yet". This lets
  // __dyn_get_t / __dyn_set sidestep the global __dyn_props lookup on the hot path.
  // Read offsets relative to the returned data ptr stay unchanged (-8 len, -4 cap).
  // Default stride=8 (f64 NaN-boxed slot) — used by every Array/HASH/OBJECT alloc.
  // Specialized over a generic (len, cap, stride) helper to drop a fat (i32.const 8)
  // immediate at every call site (~20+) plus a param/local.get pair in the body.
  // Non-8 strides (Set: 16, Map/HASH probe: 24, TypedArray raw: 1) use __alloc_hdr_n.
  ctx.core.stdlib['__alloc_hdr'] = `(func $__alloc_hdr (param $len i32) (param $cap i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.add (i32.const 16) (i32.shl (local.get $cap) (i32.const 3)))))
    (i64.store (local.get $ptr) (i64.const 0))
    (i32.store (i32.add (local.get $ptr) (i32.const 8)) (local.get $len))
    (i32.store (i32.add (local.get $ptr) (i32.const 12)) (local.get $cap))
    (i32.add (local.get $ptr) (i32.const 16)))`

  // Generic header allocator for non-8 strides: Set (16), Map probe (24), TypedArray raw (1).
  // Same 16-byte header layout as __alloc_hdr; per-entry stride is passed dynamically.
  // Header (16B) + cap*stride slots. Collections (Set/Map/HASH) key "empty slot"
  // off a zero hash word, so the slot region MUST start zeroed. The bump allocator
  // reuses memory after a heap reset (__clear) without re-zeroing, so we cannot
  // lean on fresh-page zeroing here — clear the slots explicitly. Also covers the
  // grow path, which rehashes into a freshly-allocated table expecting empties.
  ctx.core.stdlib['__alloc_hdr_n'] = `(func $__alloc_hdr_n (param $len i32) (param $cap i32) (param $stride i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.add (i32.const 16) (i32.mul (local.get $cap) (local.get $stride)))))
    (i64.store (local.get $ptr) (i64.const 0))
    (i32.store (i32.add (local.get $ptr) (i32.const 8)) (local.get $len))
    (i32.store (i32.add (local.get $ptr) (i32.const 12)) (local.get $cap))
    (memory.fill (i32.add (local.get $ptr) (i32.const 16)) (i32.const 0) (i32.mul (local.get $cap) (local.get $stride)))
    (i32.add (local.get $ptr) (i32.const 16)))`

  // Shallow clone of an OBJECT or HASH, preserving its runtime type — the copy
  // semantics of a single unknown spread `{ ...src }` (module/object.js). Without
  // this, `{ ...src }` aliases src, so any later write to the result mutates the
  // source (a real bug: jz's own narrow.js had to route around it). Per JS spread,
  // the clone is SHALLOW: scalar slots are copied by value; nested object/string
  // pointers are shared (immutable strings; nested objects are aliased as in V8).
  //
  //  - OBJECT: alloc a fresh header'd object with the same schemaId and copy its N
  //    schema slots (N = key count of __schema_tbl[sid], robust to static-segment
  //    sources that carry no len/cap header). Then deep-copy the per-instance
  //    dyn-props HASH (base-16) so `o[k]=v` keys added before the spread carry over
  //    independently — heap objects only; static-segment objects have no header.
  //  - HASH: copy header + every probe slot wholesale (entries hold immutable
  //    string keys + scalar/pointer values — a byte copy is an independent dict).
  //  - anything else (primitive): nothing to clone, return as-is.
  // Thunked (not a plain template string) so heapResetWat()/the __dyn_props
  // presence check below read the FINAL declaration state — see collection.js's
  // heapResetWat comment for why.
  ctx.core.stdlib['__obj_clone'] = () => `(func $__obj_clone (param $v f64) (result f64)
    (local $bits i64) (local $t i32) (local $sid i32) (local $n i32) (local $cap i32)
    (local $src i32) (local $dst i32) (local $props i64)
    (local.set $bits (i64.reinterpret_f64 (local.get $v)))
    (local.set $t (call $__ptr_type (local.get $bits)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.OBJECT}))
      (then
        (local.set $sid (call $__ptr_aux (local.get $bits)))
        (local.set $src (call $__ptr_offset (local.get $bits)))
        (local.set $n (i32.const 0))
        (if (i32.ne (global.get $__schema_tbl) (i32.const 0))
          (then (local.set $n (call $__len
            (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3))))))))
        (local.set $cap (i32.add (local.get $n) (i32.eqz (local.get $n))))
        (local.set $dst (call $__alloc_hdr (i32.const 0) (local.get $cap)))
        (memory.copy (local.get $dst) (local.get $src) (i32.shl (local.get $n) (i32.const 3)))
        ;; Dyn-props (off-schema keys added by o[k]=v): heap-allocated sources
        ;; (src >= __heap_start) carry them at src-16 as a HASH sidecar
        ;; (populated by an init-time write, or by any write at all on an
        ;; EPHEMERAL source) and/or in the global __dyn_props table (populated
        ;; by a RUNTIME/post-init write on a DURABLE source — see
        ;; collection.js's heapResetWat for the full policy). Static-segment
        ;; sources (src < __heap_start) have no header — both checks below
        ;; are gated on src >= __heap_start so neither reads neighbor static
        ;; data. Prefers the sidecar when present (authoritative for a
        ;; DURABLE source's untouched init-time keys, and the only source for
        ;; an ephemeral one); falls back to the global entry otherwise. A
        ;; source with keys split across BOTH (some at init, more added at
        ;; runtime) clones only the sidecar's — a known narrow gap versus
        ;; Object.keys/JSON.stringify's full merge, accepted here because a
        ;; spread of such a genuinely mixed durable dict is materially rarer.
        (local.set $props (i64.load (i32.sub (local.get $src) (i32.const 16))))
        (if (i32.and (i32.ge_u (local.get $src) (global.get $__heap_start))
                     (i32.eq (call $__ptr_type (local.get $props)) (i32.const ${PTR.HASH})))
          (then (i64.store (i32.sub (local.get $dst) (i32.const 16))
            (i64.reinterpret_f64 (call $__obj_clone (f64.reinterpret_i64 (local.get $props))))))${ctx.scope.globals.has('__dyn_props') ? `
          (else
            (if (i32.and (i32.ge_u (local.get $src) (global.get $__heap_start))
                         (i32.lt_u (local.get $src) ${heapResetWat()}))
              (then
                (if (f64.ne (global.get $__dyn_props) (f64.const 0))
                  (then
                    (local.set $props (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $src)))))
                    (if (i32.eqz (call $__is_nullish (local.get $props)))
                      (then (i64.store (i32.sub (local.get $dst) (i32.const 16))
                        (i64.reinterpret_f64 (call $__obj_clone (f64.reinterpret_i64 (local.get $props)))))))))))` : ''}))
        (return (call $__mkptr (i32.const ${PTR.OBJECT}) (local.get $sid) (local.get $dst)))))
    (if (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
      (then
        (local.set $cap (call $__cap (local.get $bits)))
        (local.set $src (call $__ptr_offset (local.get $bits)))
        (local.set $dst (call $__alloc_hdr_n (i32.const 0) (local.get $cap) (i32.const 24)))
        (memory.copy
          (i32.sub (local.get $dst) (i32.const 16))
          (i32.sub (local.get $src) (i32.const 16))
          (i32.add (i32.const 16) (i32.mul (local.get $cap) (i32.const 24))))
        (return (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0) (local.get $dst)))))
    (local.get $v))`

  // Allocator + exports are deferred: only included when memory is actually needed.
  // Any module using allocPtr/inc('__alloc') pulls these in via ctx.core.stdlibDeps.
  // compile.js emits _alloc/_clear exports + memory section only when __alloc is in includes.
  ctx.core._allocRawFuncs = [
    '(func (export "_alloc") (param $bytes i32) (result i32) (call $__alloc (local.get $bytes)))',
    '(func (export "_clear") (call $__clear))',
  ]

  // Not-nullish check: f64 WAT node is neither NULL_NAN nor UNDEF_NAN.
  // Routes through isNullish() so peepholes (ptrKind, NaN-boxed literal, local.get inline)
  // apply — otherwise this would always emit a __is_nullish call even for provable cases.
  const notNullish = v => ['i32.eqz', isNullish(v)]

  // Optional-chain wrapper: eval guard, if non-nullish emit access, else `undefined`.
  // Per spec, `null?.a` and `undefined?.a` both short-circuit to undefined, not null.
  const emitNullishGuarded = (guard, access) => typed(['if', ['result', 'f64'],
    notNullish(guard),
    ['then', access],
    ['else', ['f64.const', `nan:${UNDEF_NAN}`]]], 'f64')

  // === Shared dispatch helpers ===

  /** Emit .length access for a WASM f64 node. Monomorphize by vt, or runtime dispatch.
   *  ARRAY/SET/MAP share a single layout: length is i32 at offset-8. We inline that load
   *  directly instead of calling __len which re-dispatches on type. ptrOffsetIR handles
   *  ARRAY forwarding (non-ARRAY skips the forwarding loop). TYPED has a variable-width
   *  layout depending on the aux typed-element shift, so it still routes through __len.
   *  `notString` (from rep.notString — write-shape evidence rules out primitive string)
   *  routes the otherwise-unknown case through __len directly, eliding the STRING arm
   *  of __length. __len returns 0 on tags it doesn't recognize, matching JS's
   *  `undefined` semantics on non-pointer .length (the binding writes through xs[i]
   *  / xs.length, so reaching .length with a non-pointer is unreachable in practice). */
  function emitLengthAccess(va, vt, notString = false) {
    // jsstring carrier: receiver is an externref slot (boundary param tagged
    // `jsstring` by narrow.js phase J). Route to the `wasm:js-string` length
    // builtin directly — no SSO unbox, zero copy.
    if (va?.type === 'externref') {
      ctx.core.jsstring.add('length')
      return typed(['f64.convert_i32_s', ['call', '$__jss_length', va]], 'f64')
    }
    if (vt === VAL.ARRAY || vt === VAL.SET || vt === VAL.MAP) {
      const off = ptrOffsetIR(va, vt)
      return typed(['f64.convert_i32_s', ['i32.load', ['i32.sub', off, ['i32.const', 8]]]], 'f64')
    }
    if (vt === VAL.TYPED)
      return typed(['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', va]]], 'f64')
    // Known string → byteLen via the active string rep. Pass the slot
    // carrier (f64 under nanbox-sso) — the rep op handles internal
    // reinterpret/wrap. The `?.` call site passes a bare `['local.get', $t]`
    // without a `.type` tag, so coerce defensively to f64.
    if (vt === VAL.STRING) {
      const f64Va = va?.type === 'f64' ? va : typed(va, 'f64')
      return typed(['f64.convert_i32_s', ctx.abi.string.ops.byteLen(f64Va, ctx)], 'f64')
    }
    // Unknown but proven not-string → __len directly (skips the STRING arm of __length).
    if (notString) {
      inc('__len')
      ctx.features.typedarray = true
      return typed(['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', va]]], 'f64')
    }
    // Unknown → runtime dispatch via stdlib. Set/Map dispatch arms are pulled
    // only when user code actually constructs Set/Map (collection.js sets the
    // feature flags at the construction site); otherwise dispatch falls through
    // to ARRAY/STRING/TYPED. typedarray stays on because typed arrays are
    // commonly passed from JS via jz.memory.* without an in-program constructor.
    inc('__length')
    ctx.features.typedarray = true
    return typed(['call', '$__length', ['i64.reinterpret_f64', va]], 'f64')
  }

  // Known-schema fields live in the object payload. Dynamic sidecars are only
  // for ad-hoc props on pointer-backed values, so schema reads should bypass it.
  // Slot val-types reach the emit-time consumer via valTypeOf → ctx.schema.slotVT
  // (read on the AST `.prop` node), not via tagging this IR node.
  function emitSchemaSlotRead(baseExpr, idx) {
    // An unboxed proven-non-ARRAY pointer (a structInline element cell, a narrowed local)
    // reaches ptrOffsetIR raw so it returns the offset directly — no `__ptr_offset` call.
    // Pre-boxing via asF64 strips ptrKind and forces every field read onto the call path
    // (the dcbb433 perf cliff on object/struct kernels — `p.x,p.y,p.z` per loop iteration).
    // A NaN-box or untyped value still routes through f64 for the reinterpret/forwarding path.
    const base = (baseExpr?.ptrKind != null && baseExpr.ptrKind !== VAL.ARRAY)
      ? baseExpr
      : (baseExpr?.type === 'f64' ? baseExpr : asF64(baseExpr))
    return typed(ctx.abi.object.ops.load(ptrOffsetIR(base, VAL.OBJECT), idx), 'f64')
  }

  // Top 32 bits of the i64 NaN-box carrier: NAN_PREFIX | PTR tag (TAG_SHIFT=47)
  // | schemaId aux (AUX_SHIFT=32) — layout.js packs all three above bit 31, so
  // masking the whole high word and comparing to encodePtrHi(OBJECT, sid) proves
  // "is an OBJECT" AND "is exactly this schema" in one i64 compare; the low
  // word (this instance's heap offset) is irrelevant and stays unmasked.
  const OBJECT_SCHEMA_HI_MASK = '0xFFFFFFFF00000000'
  const objectSchemaGuardHex = (sid) => i64Hex(BigInt(encodePtrHi(PTR.OBJECT, sid)) << 32n)

  /** Monomorphic schema-slot devirtualization for a receiver whose static type
   *  is fully unknown (emitPropAccess's `vt == null` case, the __dyn_get_any_t_h
   *  path). `guard` (from ctx.schema.guardedSlotOf) proves `prop` names a field
   *  on exactly one registered schema program-wide: the subscript dispatch-
   *  descriptor pattern (`d.op`/`d.l`/`d.word`) and jz's own emit-table/IR-node
   *  reads under self-host are both a hot dot-read whose receiver is ALWAYS
   *  that one schema in practice, even though it flows through a parameter or
   *  array element the static analysis never pins to VAL.OBJECT.
   *
   *  Emits a single masked i64 compare (OBJECT_SCHEMA_HI_MASK) then a direct
   *  payload-slot load; any other receiver (a different schema, or not an
   *  OBJECT at all) falls to `slow()` — the exact call this site would have
   *  emitted with no guard at all, so this can only ever be as fast, never
   *  wrong. Soundness: collection.js's __dyn_set schema arm
   *  (buildObjectSchemaSetArm) mirrors every dynamic write to a schema-named
   *  key into the payload slot, so the slot stays authoritative even after an
   *  `obj[k] = v` write through the dyn-props sidecar/global table — schema
   *  fields are never shadowed by a dynamic write. */
  function emitSchemaSlotGuarded(va, guard, slow) {
    const bits = asI64(va?.type ? va : typed(va, 'f64'))
    const cond = ['i64.eq',
      ['i64.and', bits, ['i64.const', OBJECT_SCHEMA_HI_MASK]],
      ['i64.const', objectSchemaGuardHex(guard.sid)]]
    // PTR.OBJECT never forwards (FORWARDING_MASK — ctx.js — only ARRAY/HASH/
    // SET/MAP headers relocate on growth), so once the guard above has proven
    // the tag, the payload offset is a bare mask: no __ptr_offset call needed.
    // ptrOffsetIR (src/ir.js) always emits that call for an untyped node — it
    // has no way to know the forwarding check is dead here — so this inlines
    // the same extraction __ptr_offset itself would perform for an OBJECT tag.
    const off = ['i32.wrap_i64', ['i64.and', bits, ['i64.const', LAYOUT.OFFSET_MASK]]]
    const fast = typed(ctx.abi.object.ops.load(off, guard.slot), 'f64')
    return typed(['if', ['result', 'f64'],
      cond,
      ['then', fast],
      ['else', slow()]], 'f64')
  }

  function emitHashGetLocalConst(base, key, prop) {
    inc('__hash_get_local_h')
    const receiver = asI64(base?.type ? base : typed(base, 'f64'))
    return typed(['f64.reinterpret_i64', ['call', '$__hash_get_local_h', receiver, key, ['i32.const', strHashLiteral(prop)]]], 'f64')
  }

  function emitTypeTag(receiver, vt) {
    const p = valKindToPtr(vt)
    if (p != null) return ['i32.const', p]
    inc('__ptr_type')
    return ['call', '$__ptr_type', receiver]
  }

  function emitDynGetExprTyped(base, key, vt, prop) {
    const receiver = asI64(base?.type ? base : typed(base, 'f64'))
    // Constant string key: fold the FNV hash at compile time and call the
    // prehashed body — no __str_hash on every access.
    if (typeof prop === 'string') {
      inc('__dyn_get_expr_t_h')
      return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_expr_t_h', receiver, key, emitTypeTag(receiver, vt), ['i32.const', strHashLiteral(prop)]]], 'f64')
    }
    inc('__dyn_get_expr_t')
    return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_expr_t', receiver, key, emitTypeTag(receiver, vt)]], 'f64')
  }

  function emitDynGetAnyTyped(base, key, vt, prop) {
    const receiver = asI64(base?.type ? base : typed(base, 'f64'))
    // Constant string key: fold the FNV hash at compile time and call the
    // prehashed body — no __str_hash on every access (hot for `parse.step` etc).
    if (typeof prop === 'string') {
      inc('__dyn_get_any_t_h')
      return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_any_t_h', receiver, key, emitTypeTag(receiver, vt), ['i32.const', strHashLiteral(prop)]]], 'f64')
    }
    inc('__dyn_get_any_t')
    return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_any_t', receiver, key, emitTypeTag(receiver, vt)]], 'f64')
  }

  // Walk an AST expression that may resolve to an OBJECT literal at compile
  // time. Returns the literal `['{}', ...]` node, or null. Handles direct
  // literals and `.prop` chains over them. Spread props are unsupported —
  // they shift slot positions and would need their own resolution.
  function literalAst(obj) {
    if (Array.isArray(obj) && obj[0] === '{}') {
      // Bail on spreads — they change effective slot ordering.
      const props = obj.slice(1)
      const flat = props.length === 1 && Array.isArray(props[0]) && props[0][0] === ','
        ? props[0].slice(1) : props
      for (const p of flat) if (Array.isArray(p) && p[0] === '...') return null
      return obj
    }
    if (Array.isArray(obj) && obj[0] === '.' && typeof obj[2] === 'string') {
      const inner = literalAst(obj[1])
      if (!inner) return null
      const innerProps = inner.slice(1)
      const innerFlat = innerProps.length === 1 && Array.isArray(innerProps[0]) && innerProps[0][0] === ','
        ? innerProps[0].slice(1) : innerProps
      for (const p of innerFlat) {
        if (Array.isArray(p) && p[0] === ':' && p[1] === obj[2]) return literalAst(p[2])
      }
    }
    return null
  }

  // Slot index of `prop` within a literal-resolved expression, or -1.
  function literalSlot(obj, prop) {
    const lit = literalAst(obj)
    if (!lit) return -1
    const props = lit.slice(1)
    const flat = props.length === 1 && Array.isArray(props[0]) && props[0][0] === ','
      ? props[0].slice(1) : props
    for (let i = 0; i < flat.length; i++) {
      const p = flat[i]
      if (Array.isArray(p) && p[0] === ':' && p[1] === prop) return i
    }
    return -1
  }

  /** Emit .prop access for a WASM f64 node using schema or HASH fallback. */
  function emitPropAccess(va, obj, prop, fromOptional = false) {
    // Anonymous-literal fast path: when `obj` resolves at compile time to an
    // object literal `{...}` (either directly, or through a `.prop` chain
    // walked back to one), use the literal's slot index instead of falling
    // through to `__dyn_get_expr`. Fresh OBJECT literals carry no off-16
    // propsPtr so the dispatcher reads NULL_NAN. The varName-bound path
    // (`let o = {a:1}; o.a`) already works via `ctx.schema.idOf(varName)`;
    // this extends the same shape resolution to `({a:1}).a` and chains like
    // `({a:{b:1}}).a.b` where the receiver is anonymous. Spread sources
    // (`{...x}`) shift slot ordering and would need their own resolution.
    const slot = literalSlot(obj, prop)
    if (slot >= 0) return emitSchemaSlotRead(va, slot)
    // Receiver IR is an unboxed OBJECT pointer carrying its own schema (a
    // structInline element cell, a narrowed local): resolve the field's fixed
    // slot directly from `ptrAux` — more precise than the structural
    // `ctx.schema.slotOf(null, …)` and never falls to the dyn dispatcher.
    if (va?.ptrKind === VAL.OBJECT && va.ptrAux != null && typeof prop === 'string') {
      const sch = ctx.schema.list[va.ptrAux]
      const si = sch ? sch.indexOf(prop) : -1
      if (si >= 0) return emitSchemaSlotRead(va, si)
    }
    let schemaIdx = typeof obj === 'string' ? ctx.schema.slotOf(obj, prop) : ctx.schema.slotOf(null, prop)
    // Chain receiver (e.g. `o.meta.bias`): when the chain resolves to a known
    // OBJECT shape via JSON-shape propagation, the parent shape's `names`
    // gives the slot directly. Avoids the structural ambiguity of
    // ctx.schema.slotOf(null, prop) when multiple registered schemas share a key.
    if (schemaIdx < 0 && typeof obj !== 'string') {
      const sh = shapeOf(obj)
      if ((sh?.val === VAL.OBJECT || sh?.val === VAL.HASH) && sh.names) {
        const i = sh.names.indexOf(prop)
        if (i >= 0) schemaIdx = i
      }
    }
    const key = asI64(emit(['str', prop]))
    if (schemaIdx >= 0) return emitSchemaSlotRead(va, schemaIdx)
    if (typeof obj === 'string') {
      const vt = lookupValType(obj)
      if (usesDynProps(vt)) {
        return emitDynGetExprTyped(va, key, vt, prop)
      }
      if (vt === VAL.HASH) {
        return emitHashGetLocalConst(va, key, prop)
      }
      // OBJECT off-schema prop: __dyn_get_expr_t reads the per-OBJECT propsPtr
      // at off-16 (set by __dyn_set). __hash_get assumes HASH bucket layout
      // and would mis-read OBJECT memory.
      if (vt === VAL.OBJECT) {
        return emitDynGetExprTyped(va, key, vt, prop)
      }
      if (vt == null) {
        // In WASI mode, values are always JSON-derived (never PTR.EXTERNAL host objects).
        // Skip the external branch and dispatch through the typed HASH/OBJECT path.
        const isWasi = ctx.transform.host === 'wasi'
        // `fromOptional` (a `?.prop` read) short-circuits on nullish, so its
        // PTR.EXTERNAL arm is dead unless host externals are already in play —
        // don't force the __ext_prop import just for an optional read.
        if (!isWasi && !fromOptional) ctx.features.external = true
        const slow = () => isWasi ? emitDynGetExprTyped(va, key, vt, prop) : emitDynGetAnyTyped(va, key, vt, prop)
        // Monomorphic schema-slot devirtualization (see emitSchemaSlotGuarded):
        // `prop` uniquely identifies one registered schema program-wide, so
        // guard on it instead of always paying the full dynamic dispatch
        // (durable-receiver check + ihash probe + schema-table scan).
        const guard = ctx.schema.guardedSlotOf(prop)
        return guard ? emitSchemaSlotGuarded(va, guard, slow) : slow()
      }
      // Primitive receiver (number/boolean/bigint): no dynamic props — `(5).foo` is
      // undefined. Without this the value falls to the __hash_get fallback, which
      // reinterprets the primitive's bits as a HASH pointer and reads heap → OOB.
      if (vt === VAL.NUMBER || vt === VAL.BOOL || vt === VAL.BIGINT) return undefExpr()
      inc('__hash_get', '__str_hash', '__str_eq')
      return typed(['f64.reinterpret_i64', ['call', '$__hash_get', asI64(va), key]], 'f64')
    }
    // Non-string receiver: route through HASH fast path when valTypeOf can
    // resolve the chain to a known HASH (e.g. `o.meta.bias` where `o.meta` is
    // a HASH per the parsed JSON shape). Falls back to dynamic dispatch
    // otherwise.
    if (valTypeOf(obj) === VAL.HASH) {
      return emitHashGetLocalConst(va, key, prop)
    }
    inc('__dyn_get_expr')
    return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_expr', asI64(va), key]], 'f64')
  }

  // Runtime .length dispatch — factory elides branches for types that can't exist in
  // this program (features.* + hash-stdlib presence). ARRAY is always live; STRING and
  // number are always dispatched. The __len disjunction collapses to whichever of
  // ARRAY/TYPED/HASH/SET/MAP are reachable. STRING covers both heap and SSO via __str_len.
  ctx.core.stdlib['__length'] = () => {
    const types = [PTR.ARRAY]
    if (ctx.features.typedarray) types.push(PTR.TYPED)
    if (ctx.core.includes.has('__hash_new') || ctx.core.includes.has('__dyn_set') || ctx.core.includes.has('__hash_set'))
      types.push(PTR.HASH)
    if (ctx.features.set) types.push(PTR.SET)
    if (ctx.features.map) types.push(PTR.MAP)
    const eqT = (n) => `(i32.eq (local.get $t) (i32.const ${n}))`
    let disj = eqT(types[0])
    for (let i = 1; i < types.length; i++) disj = `(i32.or ${disj} ${eqT(types[i])})`
    const lenArm = `(block (result f64)
            (local.set $off (i32.wrap_i64 (i64.and (local.get $v) (i64.const ${LAYOUT.OFFSET_MASK}))))
            (if (result f64) ${disj}
              (then
                (if (result f64) (i32.ge_u (local.get $off) (i32.const 8))
                  (then (f64.convert_i32_s (call $__len (local.get $v))))
                  (else (f64.const nan:${UNDEF_NAN}))))
              (else (f64.const nan:${UNDEF_NAN}))))`
    const stringArm = `(if (result f64) (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
            (then (f64.convert_i32_s (call $__str_len (local.get $v))))
            (else ${lenArm}))`
    return `(func $__length (param $v i64) (result f64)
    (local $f f64) (local $t i32) (local $off i32)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (result f64) (f64.eq (local.get $f) (local.get $f))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (local.set $t (call $__ptr_type (local.get $v)))
        ${stringArm})))`
  }

  // === Property dispatch (.length, .prop) ===

  ctx.core.emit['.'] = (obj, prop) => {
    // SRoA flat object: `o.prop` → `local.get $o#i` (analyze.js scanFlatObjects).
    const flatR = typeof obj === 'string' ? ctx.func.flatObjects?.get(obj) : null
    if (flatR) {
      const fi = flatR.names.indexOf(prop)
      if (fi >= 0) return typed(['local.get', `$${obj}#${fi}`], 'f64')
    }

    // Boxed object: delegate .length and .prop to inner value or schema
    if (typeof obj === 'string' && ctx.schema.isBoxed(obj)) {
      if (prop === 'length') {
        const inner = ctx.schema.emitInner(obj)
        return typed(['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', inner]]], 'f64')
      }
      const idx = ctx.schema.slotOf(obj, prop)
      if (idx >= 0) return emitSchemaSlotRead(emit(obj), idx)
    }

    if (prop === 'length') {
      // Fast path: typed-narrowed local (ptrKind=TYPED with known ptrAux) — bypass
      // the f64 NaN-rebox + __len ptr-type/aux re-extraction round-trip.
      // Owned typed (aux & 8 == 0): byteLen at off-8, shifted by element shift.
      // View typed (aux & 8): byteLen stored at off+0 (descriptor head), shifted.
      if (typeof obj === 'string') {
        const r = repOf(obj)
        if (r?.ptrKind === VAL.TYPED && r.ptrAux != null) {
          const aux = r.ptrAux, isView = (aux & 8) !== 0
          const et = aux & 7
          const shift = et === 7 ? 3 : et >= 4 ? 2 : et >> 1
          const off = ['local.get', `$${obj}`]
          const byteLen = isView
            ? ['i32.load', off]
            : ['i32.load', ['i32.sub', off, ['i32.const', 8]]]
          const lenI32 = shift === 0
            ? typed(byteLen, 'i32')
            : typed(['i32.shr_u', byteLen, ['i32.const', shift]], 'i32')
          return typed(['f64.convert_i32_s', lenI32], 'f64')
        }
      }
      // String literal: fold to its UTF-8 byte length. jz strings are stored as
      // UTF-8 and __str_byteLen returns byte count, so this matches the runtime
      // semantics. Skips the call + NaN-unbox round-trip entirely.
      if (Array.isArray(obj) && (obj[0] === 'str' || obj[0] == null) && typeof obj[1] === 'string') {
        return typed(['f64.const', new TextEncoder().encode(obj[1]).length], 'f64')
      }
      // structInline Array<S>: the header `len` counts physical f64 cells (K
      // per element), so the JS array length is `physicalLen / K`.
      const inlSid = inlineArraySid(obj)
      if (inlSid != null) {
        const K = ctx.schema.list[inlSid].length
        const physLen = ['i32.load', ['i32.sub', ptrOffsetIR(asF64(emit(obj)), VAL.ARRAY), ['i32.const', 8]]]
        return typed(['f64.convert_i32_s', K > 1 ? ['i32.div_s', physLen, ['i32.const', K]] : physLen], 'f64')
      }
      const rep = typeof obj === 'string' ? repOf(obj) : null
      const vt = rep ? rep.val : valTypeOf(obj)
      const notString = vt == null && typeof obj === 'string' && lookupNotString(obj)
      // jsstring carrier: keep the externref-typed IR so emitLengthAccess can
      // dispatch to `wasm:js-string.length` instead of forcing through f64.
      const recv = emit(obj)
      if (recv?.type === 'externref') return emitLengthAccess(recv, vt, notString)
      return emitLengthAccess(asF64(recv), vt, notString)
    }

    // Type-specific property emitter (`.regex:source`, …) — the property-read
    // mirror of the `.vt:method` method-dispatch table. Only entries tagged as
    // getters (via `getter()`) fire here: reading `re.source` yields a value,
    // but reading `m.keys`/`re.test` is not a call and must not invoke the
    // method (which would materialize a view / run the probe).
    const ptRep = typeof obj === 'string' ? repOf(obj) : null
    const ptVt = ptRep ? ptRep.val : valTypeOf(obj)
    if (ptVt) {
      const tpKey = `.${ptVt}:${prop}`
      const tpEmitter = ctx.core.emit[tpKey]
      if (tpEmitter && ctx.core.getters.has(tpKey)) return tpEmitter(obj)
    }

    // valueOf/toString are ToPrimitive hooks (ES2024 7.1.1) that an own data
    // property shadows. On a heap receiver carrying a dynamic-prop sidecar
    // (array/typed/object), reading `obj.valueOf`/`obj.toString` must return an
    // assigned override when present, else the inherited builtin. Without this,
    // the arity-1 builtin emitter below (returns the receiver) masks the
    // override. The method-call path in src/emit.js runs the parallel probe and
    // additionally covers statically-unknown receivers (e.g. `arr[0].valueOf()`);
    // a bare read of an unknown-type receiver can't yield a builtin-as-value
    // here anyway, so this read path stays scoped to known sidecar types.
    if ((prop === 'valueOf' || prop === 'toString') && ctx.closure.call &&
        (ptVt === VAL.ARRAY || ptVt === VAL.TYPED || ptVt === VAL.OBJECT)) {
      const builtin = ctx.core.emit[`.${ptVt}:${prop}`] || ctx.core.emit[`.${prop}`]
      if (builtin && emitArity(builtin) <= 1) {
        return sidecarOverride(emit(obj), asI64(emit(['str', prop])),
          (p) => ['local.get', `$${p}`],          // READ: yield the override closure value
          (o) => asF64(builtin(o)))               // else the arity-≤1 builtin's value
      }
    }

    // Module-registered property getter (.size, .byteLength, …). Methods sharing
    // the bare-`.prop` table (`.values`, `.pop`, date getters) are untagged and
    // fall through to a real property read — `m.values` reads the "values" field.
    const propKey = `.${prop}`
    const propEmitter = ctx.core.emit[propKey]
    if (propEmitter && ctx.core.getters.has(propKey)) return propEmitter(obj)

    return emitPropAccess(emit(obj), obj, prop)
  }

  // Optional-chain short-circuit: store the receiver/callee into temp `$t`
  // once, evaluate `thenIR` when it is non-nullish, else yield `undefined`.
  // local.set + local.get (never a local.tee feeding the guard) because
  // notNullish inlines an isNullish check — (i32.or (i64.eq X NULL)
  // (i64.eq X UNDEF)) — that duplicates its operand, so a tee'd
  // side-effecting value would run twice.
  const optionalGuard = (t, va, thenIR) =>
    typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, va],
      ['if', ['result', 'f64'],
        notNullish(typed(['local.get', `$${t}`], 'f64')),
        ['then', thenIR],
        ['else', ['f64.const', `nan:${UNDEF_NAN}`]]]], 'f64')

  // Receiver-evaluate-once: allocate a fresh hoist-temp `$t`, emit `value` into
  // it, then call `useFn(t)` to build the consumer IR — wrapping both in an
  // optionalGuard so the consumer runs only when `$t` is non-nullish. Used by
  // `?.` / `?.[]` / `?.()` whose receiver is read twice (the nullish check and
  // the dispatched access) but must evaluate once. Rep-seeding for the temp,
  // when the receiver's value-type drives downstream dispatch, lives inside
  // the useFn callback so it runs before the consumer IR consults reps.
  const evalOnce = (value, useFn) => {
    const t = temp()
    const va = asF64(emit(value))
    return optionalGuard(t, va, useFn(t))
  }

  // Optional chaining: obj?.prop → undefined if obj is nullish, else obj.prop.
  // Delegate the property read to emitPropAccess — the SAME resolution the plain
  // `.` emitter uses (passing the hoisted temp's value for the load, but the
  // original `obj` name for schema/valType lookup). The previous hand-rolled copy
  // diverged: it lacked emitPropAccess's `VAL.OBJECT off-schema → __dyn_get_expr`
  // branch and fell to `__hash_get`, which mis-reads fixed-shape OBJECT memory
  // (a self-host miscompile — `o?.x` returned undefined under the kernel).
  ctx.core.emit['?.'] = (obj, prop) => evalOnce(obj, (t) => {
    const rep = typeof obj === 'string' ? repOf(obj) : null
    const vt = rep ? rep.val : valTypeOf(obj)
    if (prop === 'length') {
      const notString = vt == null && typeof obj === 'string' && lookupNotString(obj)
      return emitLengthAccess(['local.get', `$${t}`], vt, notString)
    }
    // Type-specific + module-registered property getters (`.size`, `.byteLength`,
    // `.regex:source`, …) — the SAME getter dispatch the plain `.` emitter runs
    // (only entries tagged via `getter()` fire; untagged `.values`/`.pop` stay a
    // field read). Read the already-hoisted, null-guarded temp `t` rather than
    // re-emitting `obj`. Without this `s?.size` fell straight to emitPropAccess (a
    // plain field read) and returned undefined — a Set/Map size getter never ran.
    if (vt) {
      const tgKey = `.${vt}:${prop}`
      const tg = ctx.core.emit[tgKey]
      if (tg && ctx.core.getters.has(tgKey)) return tg(t)
    }
    const gKey = `.${prop}`
    const g = ctx.core.emit[gKey]
    if (g && ctx.core.getters.has(gKey)) return g(t)
    return emitPropAccess(typed(['local.get', `$${t}`], 'f64'), obj, prop, true)
  })

  // Optional index: arr?.[i] → null if arr is null, else arr[i]
  // Cache base in temp, propagate valType so []'s type dispatch works
  ctx.core.emit['?.[]'] = (arr, idx) => evalOnce(arr, (t) => {
    // Emit-time rep seed on fresh `?.[]` hoist-temp (lifecycle: analysis-vs-emit).
    // Propagate source type to temp so [] dispatch (string, typed, etc.) works
    // when the inner `ctx.core.emit['[]'](t, idx)` re-enters dispatch.
    const srcType = typeof arr === 'string' ? repOf(arr)?.val : null
    if (srcType) updateRep(t, { val: srcType })
    if (typeof arr === 'string' && ctx.types.typedElem?.has(arr)) {
      if (!ctx.types.typedElem) ctx.types.typedElem = new Map()
      ctx.types.typedElem.set(t, ctx.types.typedElem.get(arr))
    }
    return asF64(ctx.core.emit['[]'](t, idx))
  })

  // Optional call: fn?.(...args) → null if fn is null, else call fn
  ctx.core.emit['?.()'] = (callee, ...args) => {
    // Statically-lifted func-prop callee: `p.step?.()` where prepare lifted
    // `p.step = arrow` into the named function `p$step`. Non-nullish by
    // construction, so the optional is moot — delegate to the full `()` dispatch
    // (direct call). Without this arm the dead-write-drop plan (which assumes
    // call sites lower to direct calls) drops the write while this emitter read
    // the never-written dyn table → undefined. multiProp (reassigned) slots stay
    // dynamic: their live value is the prop-global and may legitimately be nullish.
    if (Array.isArray(callee) && callee[0] === '.' && typeof callee[1] === 'string' && typeof callee[2] === 'string') {
      const base = ctx.scope.chain[callee[1]] || callee[1]
      if (ctx.func.names.has(`${base}$${callee[2]}`) && !ctx.func.multiProp.has(`${base}.${callee[2]}`)) {
        const callArgs = args.length === 0 ? null : args.length === 1 ? args[0] : [',', ...args]
        return asF64(ctx.core.emit['()'](callee, callArgs))
      }
    }
    // Method-reference callee: `recv.m(...)` or `recv?.m(...)` form. Methods are
    // statically registered emitters and aren't real closure values, so route them
    // as a direct method call. The outer optional short-circuits when the receiver
    // is nullish — the method itself is statically known to exist.
    if (Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.') && typeof callee[2] === 'string') {
      const method = callee[2]
      if (ctx.core.emit[`.${method}`]) {
        const recv = callee[1]
        return evalOnce(recv, (t) => {
          // Emit-time rep seed on fresh `?.()` recv-temp so the dispatch fast-paths fire.
          const vt = typeof recv === 'string' ? repOf(recv)?.val : valTypeOf(recv)
          if (vt) updateRep(t, { val: vt })
          // Re-enter the full `()` method dispatch (runtime string/array dispatch,
          // charCodeAt, schema, …) rather than the bare generic `.${method}` emitter
          // — that emitter is the *array* `includes`/`indexOf`/… and would mis-run on
          // a string receiver. Mirrors `?.[]`'s re-entry into `[]`. The method is
          // statically known to exist, so the inner optional is moot; `t` is already
          // nullish-guarded by evalOnce. Args re-bundle into the `()` arg slot.
          const callArgs = args.length === 0 ? null : args.length === 1 ? args[0] : [',', ...args]
          return asF64(ctx.core.emit['()'](['.', t, method], callArgs))
        })
      }
    }
    if (!ctx.closure.call) err('Optional call requires fn module')
    return evalOnce(callee, (t) => {
      // Spread args: mirror the regular `()` emitter — reconstruct the args array
      // and route through `closure.call(_, [arrayIR], prebuiltArray=true)`. Without
      // this, the raw `['...', expr]` node falls through to the bare spread emitter
      // and errors as "Spread (...) can only be used in function/method calls".
      const hasSpread = args.some(a => Array.isArray(a) && a[0] === '...')
      let callResult
      if (hasSpread) {
        const normal = [], spreads = []
        for (const a of args) {
          if (Array.isArray(a) && a[0] === '...') spreads.push({ pos: normal.length, expr: a[1] })
          else normal.push(a)
        }
        const combined = reconstructArgsWithSpreads(normal, spreads)
        const arrayIR = spread(combined)
        callResult = ctx.closure.call(typed(['local.get', `$${t}`], 'f64'), [arrayIR], true)
      } else {
        callResult = ctx.closure.call(typed(['local.get', `$${t}`], 'f64'), args)
      }
      return asF64(callResult)
    })
  }

  // Statically boolean-typed operands: `Boolean(x)`, logical-not, and the
  // relational/equality comparisons always yield a JS boolean — jz carries it as
  // f64 0/1 but `typeof` must still report "boolean". None of these ops can
  // produce a non-boolean, so the recognizer never false-positives. The `()`
  // arm also unwraps parenthesized expressions (`typeof (a < b)`).
  const BOOL_RESULT_OPS = new Set(['!', '<', '<=', '>', '>=', '==', '!=', '===', '!=='])
  const isBoolExpr = (n) => Array.isArray(n) && (
    BOOL_RESULT_OPS.has(n[0]) ||
    (n[0] === '()' && (n[1] === 'Boolean' || isBoolExpr(n[1]))))

  // typeof: returns JS-style string. Reachable results are number/undefined/string/function/symbol/object/boolean
  // (booleans without a static type hit the number branch; no bigints). Strings are preallocated into globals and
  // initialized in __start (see compile.js). Comparison patterns (typeof x === 'string') are optimized
  // in prepare.js (resolveTypeof) and emitted as direct type checks via emitTypeofCmp, bypassing this path.
  ctx.core.emit['typeof'] = (a) => {
    if (valTypeOf(a) === VAL.BIGINT) return emit(['str', 'bigint'])
    // VAL.BOOL covers boolean literals, comparisons, `!` and bindings inferred
    // boolean; isBoolExpr additionally catches `Boolean(x)` and parenthesized forms.
    if (valTypeOf(a) === VAL.BOOL || isBoolExpr(a)) return emit(['str', 'boolean'])
    if (!ctx.runtime.typeofStrs) {
      ctx.runtime.typeofStrs = ['number', 'undefined', 'string', 'function', 'symbol', 'object', 'boolean']
      for (const s of ctx.runtime.typeofStrs)
        declGlobal(`__tof_${s}`, 'f64')
    }
    inc('__typeof')
    // Receiver type unknown; enable branches that wouldn't otherwise be reachable.
    ctx.features.closure = true
    return typed(['call', '$__typeof', asI64(emit(a))], 'f64')
  }

  ctx.core.stdlib['__typeof'] = () => {
    const stringTest = `(i32.eq (local.get $t) (i32.const ${PTR.STRING}))`
    const closureArm = ctx.features.closure
      ? `(if (i32.eq (local.get $t) (i32.const ${PTR.CLOSURE}))
      (then (return (global.get $__tof_function))))`
      : ''
    return `(func $__typeof (param $v i64) (result f64)
    (local $f f64) (local $t i32)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (f64.eq (local.get $f) (local.get $f))
      (then (return (global.get $__tof_number))))
    ;; Canonical JS NaN (0x7FF8000000000000) overlaps ATOM tag=0 aux=0 offset=0.
    ;; That bit pattern is the math NaN value, not a tagged pointer — treat as "number".
    ;; Negative-NaN bit patterns (sign bit set) don't match NAN_PREFIX so are uniquely numeric.
    (if (i32.or
          (i64.eq (local.get $v) (i64.const ${NAN_BITS}))
          (i64.eq (i64.and (local.get $v) (i64.const 0xFFF0000000000000))
                  (i64.const 0xFFF0000000000000)))
      (then (return (global.get $__tof_number))))
    (if (i64.eq (local.get $v) (i64.const ${UNDEF_NAN}))
      (then (return (global.get $__tof_undefined))))
    ;; typeof null === "object" — the historical JS quirk, distinct from undefined.
    (if (i64.eq (local.get $v) (i64.const ${NULL_NAN}))
      (then (return (global.get $__tof_object))))
    ;; Boolean atoms (FALSE_NAN / TRUE_NAN) — carry at the JS boundary.
    (if (i64.eq (i64.and (local.get $v) (i64.const 0xFFFFFFFEFFFFFFFF)) (i64.const ${FALSE_NAN}))
      (then (return (global.get $__tof_boolean))))
    (local.set $t (call $__ptr_type (local.get $v)))
    (if ${stringTest}
      (then (return (global.get $__tof_string))))
    ${closureArm}
    (if (i32.eqz (local.get $t))
      (then (return (global.get $__tof_symbol))))
    (global.get $__tof_object))`
  }

  // === Schema helpers (centralized in module/schema.js) ===
  initSchema(ctx)

  // Low-level pointer helpers callable from jz code. Each handler inc()'s its
  // stdlib func so the call resolves at every optimize level. At opt≥1 fusedRewrite
  // inlines `call $__ptr_*` to bit-ops (the func is then dead-code-eliminated), but
  // the inc() must fire first so pullStdlib has the body when watr assembles at opt0.
  ctx.core.emit['__mkptr'] = (t, a, o) => (inc('__mkptr'), typed(['call', '$__mkptr', asI32(emit(t)), asI32(emit(a)), asI32(emit(o))], 'f64'))
  ctx.core.emit['__ptr_type'] = (p) => (inc('__ptr_type'), typed(['f64.convert_i32_s', ['call', '$__ptr_type', asI64(emit(p))]], 'f64'))
  ctx.core.emit['__ptr_aux'] = (p) => (inc('__ptr_aux'), typed(['f64.convert_i32_s', ['call', '$__ptr_aux', asI64(emit(p))]], 'f64'))
  ctx.core.emit['__ptr_offset'] = (p) => (inc('__ptr_offset'), typed(['f64.convert_i32_s', ['call', '$__ptr_offset', asI64(emit(p))]], 'f64'))

  // Error(msg) — passthrough (throw handles any value). Subclasses share the
  // same shape: jz doesn't model typed-error dispatch, so SyntaxError/TypeError/
  // RangeError/ReferenceError/URIError/EvalError all lower to the message
  // expression. `instanceof SyntaxError` returning correct results would need
  // proper class machinery; until then, code that throws specific subclasses
  // compiles and the user-visible message is preserved.
  // jz models an error as its message value (passthrough — `throw` accepts any
  // value). A no-arg `new Error()` has no message, so it lowers to `undefined`
  // rather than crashing on a missing argument. Emitting `['str','']` here would
  // drag the whole string module into programs that only `throw new Error()`.
  const passthroughError = (msg) => msg == null
    ? typed(['f64.const', `nan:${UNDEF_NAN}`], 'f64')
    : asF64(emit(msg))
  ctx.core.emit['Error'] = passthroughError
  ctx.core.emit['SyntaxError'] = passthroughError
  ctx.core.emit['TypeError'] = passthroughError
  ctx.core.emit['RangeError'] = passthroughError
  ctx.core.emit['ReferenceError'] = passthroughError
  ctx.core.emit['URIError'] = passthroughError
  ctx.core.emit['EvalError'] = passthroughError
}
