import { OPTF } from '../src/ctx.js'
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

import { typed, asF64, asI32, asI64, NULL_NAN, UNDEF_NAN, TOMB_NAN, FALSE_NAN, TRUE_NAN, temp, tempI32, mkPtrIR, usesDynProps, ptrOffsetIR, isNullish, isUndef, truthyIR, valKindToPtr, sidecarOverride, undefExpr, cloneIR, toStrI64, throwTypeErrorIR, boxBigInt, unboxBigInt } from '../src/ir.js'
import { emit, emitIdentitySafe, spread, deps, wat } from '../src/bridge.js'
import { reconstructArgsWithSpreads } from '../src/ir.js'
import { valTypeOf, shapeOf, hasAmbiguousBoolMerge, censusMaybeUndefined } from '../src/kind.js'
import { T } from '../src/ast.js'
import { inlineArraySid, inlineArrayUnion } from '../src/static.js'
import { packedI32, structInline } from '../src/abi/index.js'
import { VAL, lookupValType, lookupNotString, repOf, updateRep } from '../src/reps.js'
import { ctx, err, inc, PTR, LAYOUT, HEAP, FORWARDING_MASK, emitArity, followForwardingWat, declGlobal, setLinkDemand } from '../src/ctx.js'
import { ptrOffsetFwdWat, STR_INTERN_BIT } from '../layout.js'
import { nanPrefixHex, nanPrefixMaskHex, ssoBitI64Hex, OBJECT_SCHEMA_HI_MASK, objectSchemaGuardHex } from '../layout.js'
import { initSchema } from './schema.js'
import { strHashLiteral, heapResetWat, LENGTH_SSO_I64, SET_ENTRY, MAP_ENTRY, INIT_CAP, LANE } from './collection.js'
import { ERR_CLASS_NAMES } from '../err-codes.js'
import { eqIdentityChain, regionCopyRecBody } from '../layout-kinds.js'

const NAN_BITS = nanPrefixHex()

export default (ctx) => {
  deps({
    __eq: ['__str_eq', '__ptr_type', '__is_nullish'],
    __eq_strict: ['__eq', '__is_nullish'],
    __typeof: ['__ptr_type', '__is_nullish'],
    __len: ['__typed_shift', '__ptr_offset', '__ptr_offset_fwd'],
    __cap: ['__typed_shift', '__ptr_type', '__ptr_offset', '__ptr_aux'],
    __typed_data: ['__ptr_offset', '__ptr_aux'],
    __typed_idx: () => (ctx.linkDemand.f16 ? ['__f16_to_f64'] : []),
    __ptr_offset: ['__ptr_offset_fwd'],
    __ptr_offset_fwd: [],
    __is_str_key: ['__ptr_type'],
    __str_len: ['__ptr_type', '__ptr_offset', '__ptr_aux'],
    __set_len: ['__ptr_offset_fwd'],
    // Property-fallback arm (`.length` as an ordinary own key on OBJECT/HASH
    // receivers) needs the dyn dispatcher — but only when the program can even
    // HOLD such a property (a schema'd object or dyn/hash machinery exists);
    // string/array-only programs keep the lean undefined arm.
    __length: () => ['__ptr_type', '__str_len', '__len',
      ...(lengthNeedsDynArm() ? ['__dyn_get_expr_t_h'] : [])],
    __alloc: ['__memgrow'],
    __alloc_hdr: ['__alloc'],
    __alloc_hdr_n: ['__alloc'],
    __coll_order: ['__alloc'],
    __hash_keys_ro: ['__ptr_offset', '__coll_order', '__alloc_hdr', '__mkptr'],
    // Durable-receiver global-table merge (see __obj_clone's body) pulls in
    // __ihash_get_local/__is_nullish only when collection.js's dyn-props
    // machinery is actually part of this build (mirrors json.js's __json_obj
    // and array.js's needsArrayDynMove-gated deps thunks).
    __obj_clone: () => ['__ptr_type', '__ptr_aux', '__ptr_offset', '__len', '__cap', '__alloc_hdr', '__alloc_hdr_n', '__mkptr',
      ...(ctx.scope.globals.has('__dyn_props') ? ['__ihash_get_local', '__is_nullish'] : [])],
    __durable_fwd_log: ['__alloc'],
    __durable_fwd_heal: [],
    __durable_slot_log: ['__alloc'],
    __durable_slot_relog: [],
    __durable_slot_cancel: [],
    __durable_slot_heal: [],
    __is_eph_bits: [],
    // Region-arena Slice 1 (.work/research.md §Region arena) — see the definitions below
    // for the full rationale. __region_copy_rec's dep list mirrors __sclone_rec's
    // (module/collection.js) plus __coll_order/__set_add for the SET/MAP branch.
    __region_mark: [],
    // Function-valued (not a plain array): the $__dyn_props implicit-root
    // relocation deps below must be read at PULL time (mirrors __obj_clone/
    // __typed_idx/__length/__region_copy_rec below, all function-wrapped for
    // the exact same reason) — module/collection.js's `declGlobal('__dyn_props',
    // …)` hasn't run yet at THIS deps() call's own eval time (module/index.js
    // registers core before collection), so a plain array would eagerly bake
    // in `false` and permanently under-declare.
    __region_exit: () => ['__region_copy_rec', '__mkptr', '__alloc_hdr_n',
      ...(ctx.scope.globals.has('__dyn_props') ? ['__ptr_offset', '__coll_order', '__ihash_set_local'] : [])],
    // Heap-kind registry Slice 2 (.work/research.md §Heap-kind registry): no
    // longer gated on __dyn_props — a bare PTR.HASH region-root value
    // (regionArmHash, layout-kinds.js) reaches this helper independently of
    // whether the array/object dynamic-property sidecar machinery exists at
    // all (module/collection.js's dict/JSON.parse machinery can mint a HASH
    // with no __dyn_props global anywhere in the build). __map_get/__map_set/
    // __is_nullish added for this function's OWN memo hardening (see its
    // definition below).
    __region_relocate_props: ['__ptr_offset', '__alloc_hdr_n', '__mkptr', '__region_copy_rec', '__map_get', '__map_set', '__is_nullish'],
    // CLOSURE's env arm (layout-kinds.js regionArmClosure) — a boxed/mutable
    // capture's env slot holds a raw i32 pointer to an independently-heap-
    // allocated cell (module/function.js's `ctx.func.boxed`), not a NaN-boxed
    // f64, so it needs its OWN relocation helper (memoized by a synthetic
    // key so a cell shared by two closures relocates to ONE address, not
    // two) rather than routing through __region_copy_rec's f64 dispatch.
    __region_relocate_cell: ['__map_get', '__map_set', '__is_nullish', '__region_copy_rec', '__alloc'],
    __region_copy_rec: () => ['__ptr_type', '__ptr_offset', '__ptr_offset_fwd', '__ptr_aux', '__is_nullish',
      '__alloc', '__alloc_hdr', '__alloc_hdr_n', '__mkptr', '__map_get', '__map_set', '__set_add', '__coll_order',
      '__len', '__region_relocate_props', '__region_relocate_cell',
      // SET/MAP rebuild fix (.work/research.md §Region arena, front-boundary
      // hunt): regionArmSetMap (layout-kinds.js) now hashes a relocated
      // entry's key itself (via $__map_hash, on whichever bits are currently
      // safe to dereference) and inserts with the STRICT prehashed siblings
      // ($__map_set_h/$__set_add_h, module/collection.js) instead of the
      // growing, self-hashing $__map_set/$__set_add — an explicit edge
      // (matching every other helper reachable ONLY from a spliced WAT
      // template body, not a real call site auto-scan can see): self-host's
      // own realize/regex-scan misses template-only calls (test/selfhost-
      // includes.js's own "Unknown func" class), so without this a region-
      // live self-hosted kernel traps the instant it rebuilds its first
      // relocated Set/Map.
      '__map_hash', '__map_set_h', '__set_add_h',
      // ARRAY/OBJECT dyn-props migration (see the definitions below): a relocated
      // container's off-16 propsPtr sidecar needs the SAME grow/shift migration
      // arrGrow/arrShift already perform (module/array.js
      // headerPropsToGlobalIR/__dyn_move).
      ...(ctx.scope.globals.has('__dyn_props') ? ['__hash_new', '__ihash_set_local', '__ihash_get_local', '__is_nullish'] : [])],
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
        ;; Bits differ. JS loose ==: null == undefined is TRUE even though they're
        ;; bit-DISTINCT NaN-box sentinels (NULL_NAN ≠ UNDEF_NAN) — the fast bit-equality
        ;; check above can't catch it, and neither can the numeric/string paths below
        ;; (both operands read back as NaN, neither is a STRING pointer, so without this
        ;; check they fall through to the final "unequal" default). Checked before the
        ;; numeric path so a nullish/nullish pair never even computes fa/fb.
        (if (result i32)
          (i32.and (call $__is_nullish (local.get $a)) (call $__is_nullish (local.get $b)))
          (then (i32.const 1))
          (else
        ;; Numeric path covers -0/+0 and any normal numeric inequality.
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
            ;; CARRIER PROGRAM Slice 3 — registry-derived 'eq-identity' arm
            ;; (layout-kinds.js KIND_REGISTRY.BIGINT / FINDINGS[eq-identity]):
            ;; two independently-boxed BigInts compare by PAYLOAD content, not
            ;; pointer bits — the content-compare REF_EQ_KINDS' own comment
            ;; (src/compile/emit.js) already documents as the intent, closing
            ;; the gap where the promised fallback never existed.
            ${eqIdentityChain()}))))))))`

  // Strict `===` fallback for the fully-dynamic (neither-side-a-literal) case
  // emitStrictEq delegates to — everywhere ELSE strict and loose equality agree
  // bit-for-bit (that's why the delegation exists at all), EXCEPT the one loose-
  // only exception __eq implements: null == undefined. A thin wrapper, not a
  // duplicate of __eq's body: defer to __eq for every case, but intercept
  // "bits differ, both nullish" (the exact condition __eq's own exception
  // fires on) and force it back to unequal.
  ctx.core.stdlib['__eq_strict'] = `(func $__eq_strict (param $a i64) (param $b i64) (result i32)
    (if (result i32) (i64.eq (local.get $a) (local.get $b))
      (then (call $__eq (local.get $a) (local.get $b)))
      (else
        (if (result i32)
          (i32.and (call $__is_nullish (local.get $a)) (call $__is_nullish (local.get $b)))
          (then (i32.const 0))
          (else (call $__eq (local.get $a) (local.get $b)))))))`

  ctx.core.stdlib['__is_null'] = `(func $__is_null (param $v i64) (result i32)
    (i64.eq (local.get $v) (i64.const ${NULL_NAN})))`

  // Truthy check: handles regular numbers AND NaN-boxed pointers
  // Falsy: 0, -0, NaN, null, undefined, "" (empty SSO)
  // CARRIER PROGRAM Slice 3's BIGINT arm below is gated on ctx.features.bigint
  // (not unconditional): $__is_truthy is reachable from EVERY dynamic boolean
  // coercion (incl. the boundary boolean-boxing wrapper every exported boolean
  // return uses), so an unconditional `i64.load`/`call $__ptr_offset` reference
  // in its body would force memory declaration on every such program via
  // pullStdlib's needsMemory scan — even one with no BigInt syntax anywhere,
  // regressing the heap-free-minimal-output contract (found live: `(a) => a >
  // 0`'s boolean export wrapper). No program lacking ctx.features.bigint can
  // ever construct a PTR.BIGINT box (neither the test-only __box_bigint
  // intrinsic nor carrier-box's write-side wiring — both require real bigint
  // syntax), so the gate never hides a reachable case.
  ctx.core.stdlib['__is_truthy'] = () => `(func $__is_truthy (param $v i64) (result i32)
    (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (result i32) (f64.eq (local.get $f) (local.get $f))
      (then (f64.ne (local.get $f) (f64.const 0)))
      (else
        ${ctx.features.bigint ? `
        ;; a boxed BigInt's truthiness is VALUE-dependent (0n falsy, everything
        ;; else truthy — unlike every other heap kind reaching this dispatch,
        ;; always truthy regardless of "emptiness"), so it can't share the
        ;; blanket non-sentinel-pointer default below. Registry-derived
        ;; (layout-kinds.js KIND_REGISTRY.BIGINT.identity: content, not
        ;; pointer-bits).
        (if (result i32) (i32.eq (call $__ptr_type (local.get $v)) (i32.const ${PTR.BIGINT}))
          (then (i64.ne (i64.load (call $__ptr_offset (local.get $v))) (i64.const 0)))
          (else` : ''}
        (i32.and
          (i32.and
            (i32.and
              (i64.ne (local.get $v) (i64.const ${NAN_BITS}))
              (i64.ne (local.get $v) (i64.const ${NULL_NAN})))
            (i32.and
              (i64.ne (local.get $v) (i64.const ${UNDEF_NAN}))
              (i64.ne (local.get $v) (i64.const 0x7FFA400000000000))))
          (i64.ne (local.get $v) (i64.const ${FALSE_NAN})))${ctx.features.bigint ? ')))' : ')'}))`

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
    if (!ctx.linkDemand.typedarray && !ctx.linkDemand.external) {
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
                  (then ${ctx.linkDemand.f16 ? `(if (result f64) (i32.and (local.get $aux) (i32.const 32))
                    (then (call $__f16_to_f64 (i32.load16_u (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1))))))
                    (else ` : ''}(if (result f64) (i32.and (local.get $et) (i32.const 1))
                    (then (f64.convert_i32_u (i32.load16_u (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1))))))
                    (else (f64.convert_i32_s (i32.load16_s (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 1)))))))${ctx.linkDemand.f16 ? '))' : ''})
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
  // Current memory limit in BYTES — __alloc's inline fast-path check
  // (`next > __heap_end` → slow __memgrow call) replaces a per-alloc call whose
  // page math always concluded "no grow" (jessie: 1.1M entries/run). __memgrow
  // updates it after any growth; stale-LOW is safe (one extra slow call) and
  // wasm memory never shrinks. 65536-page (4 GiB) memories wrap the shl to 0 —
  // every alloc slow-paths there, still correct. Seeded 0: first alloc pays once.
  declGlobal('__heap_end', 'i32', 0)
  // i64 twin of __heap_end, for the CORRECTNESS-sensitive forwarding-chase bound
  // (layout.js's followForwardingWat/ptrOffsetFwdWat, and their inline collection.js
  // dyn-props copies): those checks gate whether a relocated ARRAY/SET/MAP/HASH's
  // forwarding header gets followed at all, so the __heap_end wraparound-to-0 at the
  // wasm32 4 GiB ceiling — benign for __alloc's slow-path retry — would there instead
  // silently disable forwarding forever (every off > 0 reads as "out of bounds", so the
  // cap=-1 sentinel of an abandoned block is never re-chased and gets misread as a real
  // capacity). __memgrow updates this alongside __heap_end so every hot dereference site
  // pays one $__heap_end64 global read instead of recomputing i64.shl(memory.size,16).
  declGlobal('__heap_end64', 'i64', 0)

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
            (then (unreachable)))))))
    (global.set $__heap_end (i32.shl (memory.size) (i32.const 16)))
    (global.set $__heap_end64 (i64.shl (i64.extend_i32_u (memory.size)) (i64.const 16))))`

  if (ctx.memory.shared) {
    // Heap offset stored at memory[HEAP.PTR_ADDR] (i32), just before heap start at
    // HEAP.START. Threads sharing one memory must share one pointer cell.
    // TRULY-shared memory (opts.sharedMemory → ctx.memory.atomic): the bump is a
    // CAS retry loop — a plain load/store pair would hand two racing threads the
    // same block. Plain imported memory keeps the cheap non-atomic bump.
    // $next's `(ptr+bytes+7)&~7` is plain i32 math — once memory.size() has grown to
    // the wasm32 ceiling (65536 pages), __memgrow's own `$need > 65536 → unreachable`
    // guard (above) can never fire again (memory.size() IS 65536, so no $need exceeds
    // it), leaving THIS addition as the only thing standing between a ptr near 4 GiB
    // and silent unsigned wraparound (next < ptr) — which would corrupt the bump
    // pointer backward and hand out a ptr the caller then writes past. The classic
    // unsigned-overflow idiom (`sum < addend` ⇒ wrapped) catches it for one cheap
    // extra compare on the hot path — cheaper than __memgrow's i64 widening, and
    // this is the ONLY overflow-prone add in __alloc (bytes/ptr are both already
    // valid non-negative i32 offsets, so `next < ptr` cannot false-positive).
    ctx.core.stdlib['__alloc'] = ctx.memory.atomic ? `(func $__alloc (param $bytes i32) (result i32)
      (local $ptr i32) (local $next i32)
      (block $done (loop $retry
        (local.set $ptr (i32.atomic.load (i32.const ${HEAP.PTR_ADDR})))
        (local.set $next (i32.and (i32.add (i32.add (local.get $ptr) (local.get $bytes)) (i32.const 7)) (i32.const -8)))
        (if (i32.lt_u (local.get $next) (local.get $ptr)) (then (unreachable)))
        (if (i32.gt_u (local.get $next) (global.get $__heap_end))
          (then (call $__memgrow (local.get $next))))
        (br_if $done (i32.eq
          (i32.atomic.rmw.cmpxchg (i32.const ${HEAP.PTR_ADDR}) (local.get $ptr) (local.get $next))
          (local.get $ptr)))
        (br $retry)))
      (local.get $ptr))` : `(func $__alloc (param $bytes i32) (result i32)
      (local $ptr i32) (local $next i32)
      (local.set $ptr (i32.load (i32.const ${HEAP.PTR_ADDR})))
      (local.set $next (i32.and (i32.add (i32.add (local.get $ptr) (local.get $bytes)) (i32.const 7)) (i32.const -8)))
      (if (i32.lt_u (local.get $next) (local.get $ptr)) (then (unreachable)))
      (if (i32.gt_u (local.get $next) (global.get $__heap_end))
        (then (call $__memgrow (local.get $next))))
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
      (${ctx.memory.atomic ? 'i32.atomic.store' : 'i32.store'} (i32.const ${HEAP.PTR_ADDR}) (i32.const ${HEAP.START})))`
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
    // See the shared-memory __alloc above for why the unsigned-wraparound guard
    // (`next < ptr`) is needed here too: once memory.size() organically reaches the
    // wasm32 ceiling (65536 pages — real compiles can get there, e.g. the self-host
    // kernel on a large graph), __memgrow's own ceiling check goes permanently dead
    // and this addition becomes the last line of defense.
    ctx.core.stdlib['__alloc'] = `(func $__alloc (param $bytes i32) (result i32)
      (local $ptr i32) (local $next i32)
      (local.set $ptr (global.get $__heap))
      (local.set $next (i32.and (i32.add (i32.add (local.get $ptr) (local.get $bytes)) (i32.const 7)) (i32.const -8)))
      (if (i32.lt_u (local.get $next) (local.get $ptr)) (then (unreachable)))
      (if (i32.gt_u (local.get $next) (global.get $__heap_end))
        (then (call $__memgrow (local.get $next))))
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

    // === Region-arena: fixpoint-round scoped reclaim (Slice 1) ===
    //
    // `__region_mark()` / `__region_exit(mark, root)` let a bounded, single-caller
    // fixpoint (watOptimize's per-round loop — wired from scripts/self.js's
    // `regionHooks`, see that file and src/optimize/watr-tail.js) reclaim EACH
    // ROUND's transient churn instead of retaining it for the whole compile: mark
    // the bump pointer at round start, then at round end Cheney-copy the round's
    // SURVIVING tree (`root`) down to the mark, compacting away everything else the
    // round allocated (churn/live measured 574x-2495x on the design's own corpora —
    // .work/research.md §Region arena; .work/research.md §Region arena is the design).
    //
    // NO in-place forwarding-header convention (boundary-arithmetic audit,
    // .work/research.md §Region arena — window B; this section originally read
    // like the durable machinery's __durable_fwd_log/heal above and array/hash/
    // set/map growth's grow-in-place stub, module/array.js arrGrow/module/
    // collection.js genUpsertGrow: leave `[-8:newOffset][-4:-1 sentinel]` at the
    // OLD site for __ptr_offset to chase on a later deref. That convention is
    // sound for GROWTH — the old site stays part of the same live arena forever,
    // so the stub is reliably there whenever chased. It is NOT sound here: this
    // function's own closing `memory.copy(mark, T, size)` below overwrites every
    // byte of [mark, mark+size) with the compacted survivors before ANY consumer
    // outside this traversal could read a stub written there, and the very next
    // round starts allocating fresh churn from the new heap top, overwriting
    // whatever stub bytes landed in [mark+size, T) the instant that space is
    // reused — a write with no reachable reader, always, not merely a rare race
    // (this was the target-pass-ablation "reshuffle" mechanism: different pass
    // orderings changed how much of that dead zone got clobbered before a stray
    // reference — if one ever existed — could chase it, reshuffling WHICH corpus
    // rows happened to trap without ever closing the wall). Healing is instead
    // direct and eager: every arm below rewrites its OWN parent's slot with the
    // relocated child's value as the walk descends, and the memo (`root`'s outer
    // call returns `$out`) makes the relocated ROOT itself the healed reference —
    // no chase, no dead-on-arrival write. This covers everything reachable from
    // `root`; a holder OUTSIDE root is a root-completeness question for the
    // CALLER's registration (watr's runRounds passes exactly [ast, dirty,
    // snapshots] as root and drains every other known module-scope scratch
    // global before calling in — src/optimize.js), not something an in-place
    // stub could ever have fixed anyway (it never survived long enough to help).
    //
    // Scope (the watr WAT-IR tree + the round loop's own dirty/snapshots
    // bookkeeping — never user data, this is an internal-only pair of intrinsics,
    // never exposed to jz source): ARRAY (the tree spine), STRING (heap tokens —
    // SSO strings and durable/pre-round heap strings pass through untouched, never
    // relocated), ATOM/number (immediate, untouched), SET/MAP (watr's own
    // `dirty`/`snapshots`, keyed on func-node ARRAY pointers: Map/Set hash+compare
    // on RAW bits with no forwarding chase — __same_value_zero/__map_hash — so a
    // relocated key silently un-finds itself unless the Set/Map's OWN entries
    // relocate too; handled below exactly like __sclone_rec's SET/MAP branch,
    // rebuilt via __coll_order insertion order so dirty-filtering's performance
    // survives the boundary intact, not just "safely degrades" to always-dirty).
    // OBJECT/HASH/TYPED/BUFFER/EXTERNAL gained real arms in Slice 2
    // (layout-kinds.js's regionCopyRecBody/KIND_REGISTRY); CLOSURE gained one
    // too (the front-boundary forcing case, .work/research.md §Region arena)
    // via the `$__closure_env_len`/`$__closure_env_mask` side table — see
    // layout-kinds.js regionArmClosure.
    //
    // Self-overlap: the compacted copy is NOT written in place at `mark` — source
    // (the round's live data, scattered through [mark, T)) and a naive in-place
    // target would occupy the SAME linear range, and nothing proves a traversal
    // order that never lets the write cursor overtake a not-yet-read survivor.
    // Instead the copy runs at the CURRENT heap top `T` (always disjoint from
    // [mark, T) — plain, already-proven $__alloc/$__alloc_hdr* bump allocation,
    // same as __sclone_rec), with every emitted pointer's offset pre-adjusted by
    // `delta = T - mark` (its FINAL, post-relocation address) as it's written — so
    // the one closing `memory.copy(mark, T, size)` (memmove-safe per WAT's
    // bulk-memory-ops spec, so safe even on the rare corpus where live size
    // approaches churn and the ranges truly overlap) needs no second fixup pass:
    // every pointer already points where its target WILL be once the move lands.

    ctx.core.stdlib['__region_mark'] = `(func $__region_mark (result f64)
      (f64.convert_i32_u (global.get $__heap)))`

    // Function form (see __region_copy_rec's comment below for why): the
    // $__dyn_props implicit-root block needs ctx.scope.globals.has('__dyn_props')
    // read at PULL time.
    ctx.core.stdlib['__region_exit'] = () => `(func $__region_exit (param $markF f64) (param $rootF f64) (result f64)
      (local $mark i32) (local $T i32) (local $delta i32) (local $memo i64) (local $out f64) (local $size i32)
      ${ctx.scope.globals.has('__dyn_props') ? '(local $dpBits i64) (local $dpOff i32) (local $dpCap i32) (local $dpNewOff i32) (local $dpOutPhys f64) (local $dpOrd i32) (local $dpN i32) (local $dpI i32) (local $dpSlot i32)' : ''}
      (local.set $mark (i32.trunc_f64_u (local.get $markF)))
      ;; fresh memo Map (identity: old bits -> new/final bits), same bootstrap __sclone uses
      (local.set $memo (i64.reinterpret_f64 (call $__mkptr (i32.const ${PTR.MAP}) (i32.const 0)
        (call $__alloc_hdr_n (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY + LANE})))))
      (local.set $T (global.get $__heap))
      (local.set $delta (i32.sub (local.get $T) (local.get $mark)))
      (local.set $out (call $__region_copy_rec (local.get $rootF) (local.get $memo) (local.get $mark) (local.get $delta)))
      ;; $__dyn_props implicit region root (audit finding, kernel-oracle
      ;; dvnested-mechanism O2/O3 regression, layer 2): the ARRAY dyn-props
      ;; migration above (__region_copy_rec's ARRAY branch) re-keys entries INTO
      ;; $__dyn_props's own backing HASH table via __ihash_set_local — but that
      ;; table itself is a GLOBAL, not part of [ast, dirty, snapshots] (the
      ;; caller-supplied root), so a mid-round GROW of $__dyn_props's OWN block
      ;; (first-ever dyn-props write this round, or a load-factor grow from
      ;; accumulated re-keys) allocates ABOVE mark and would otherwise be
      ;; silently reclaimed by this function's OWN closing rewind below — the
      ;; exact "container's own backing store straddling the boundary" hazard
      ;; already fixed for dirty/snapshots (research.md §Region arena), just a
      ;; DIFFERENT global that inventory sweep missed. Relocate it here,
      ;; unconditionally, the same way: __coll_order + reinsert (a relocated
      ;; i32-offset KEY needs a rehash — __map_hash-family hashing is bits-
      ;; based, same reasoning as the SET/MAP branch above). Keys are plain
      ;; numbers (immediate, never relocate) and values are per-array props
      ;; HASH pointers (out of Slice-1 scope, never relocated by this
      ;; mechanism — same as arrGrow's headerPropsCopyIR, which also copies
      ;; this exact pointer kind verbatim) — copied bit-for-bit, NOT recursed
      ;; through __region_copy_rec (which would hit its deliberate HASH trap).
      ${ctx.scope.globals.has('__dyn_props') ? `
      (local.set $dpBits (i64.reinterpret_f64 (global.get $__dyn_props)))
      (if (i32.and
            (f64.ne (global.get $__dyn_props) (f64.const 0))
            (i32.ge_u (call $__ptr_offset (local.get $dpBits)) (local.get $mark)))
        (then
          (local.set $dpOff (call $__ptr_offset (local.get $dpBits)))
          (local.set $dpCap (i32.load (i32.sub (local.get $dpOff) (i32.const 4))))
          (local.set $dpNewOff (call $__alloc_hdr_n (i32.const 0) (local.get $dpCap) (i32.add (i32.const ${MAP_ENTRY}) (i32.const ${LANE}))))
          (local.set $dpOutPhys (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0) (local.get $dpNewOff)))
          (local.set $dpOrd (call $__coll_order (local.get $dpOff) (local.get $dpCap) (i32.const ${MAP_ENTRY})))
          (local.set $dpN (global.get $__coll_order_n))
          (block $ded (loop $del
            (br_if $ded (i32.ge_s (local.get $dpI) (local.get $dpN)))
            (local.set $dpSlot (i32.load (i32.add (local.get $dpOrd) (i32.shl (local.get $dpI) (i32.const 2)))))
            (drop (call $__ihash_set_local (i64.reinterpret_f64 (local.get $dpOutPhys))
              (i64.reinterpret_f64 (f64.load (i32.add (local.get $dpSlot) (i32.const 8))))
              (i64.reinterpret_f64 (f64.load (i32.add (local.get $dpSlot) (i32.const 16))))))
            (local.set $dpI (i32.add (local.get $dpI) (i32.const 1)))
            (br $del)))
          ;; NO old-site forwarding stub (boundary-arithmetic audit, window B —
          ;; see regionArmArray's comment, layout-kinds.js, for the full
          ;; mechanism). $__dyn_props is a GLOBAL, not a value threaded through
          ;; a caller — the ONLY live reference to this table is the global
          ;; itself, healed directly on the next line; nothing else could ever
          ;; hold the old address to chase, stub or no stub. $dpOutPhys is only
          ;; valid to DEREFERENCE right now (T-relative staging), never to keep.
          (global.set $__dyn_props (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0) (i32.sub (local.get $dpNewOff) (local.get $delta))))))
      ` : ''}
      (local.set $size (i32.sub (global.get $__heap) (local.get $T)))
      (memory.copy (local.get $mark) (local.get $T) (local.get $size))
      (global.set $__heap (i32.add (local.get $mark) (local.get $size)))
      (local.get $out))`

    // Relocate a per-array/per-object dyn-props HASH's OWN CONTENTS across a
    // region boundary (audit finding, kernel-oracle dvnested-mechanism O2/O3
    // regression, layer 3 — the deepest one): the ARRAY dyn-props migration
    // in __region_copy_rec below re-keys the OUTER props-hash pointer (into
    // off-16 or $__dyn_props) but a bare pointer copy leaves the hash's OWN
    // VALUES unrelocated — e.g. `fn.cseLoadBases = new Set(...)` (src/compile/
    // index.js emitFunc) makes the props hash's ONE entry's VALUE an ephemeral
    // SET; copying the outer HASH pointer verbatim (arrGrow's headerPropsCopyIR
    // precedent — safe THERE because a plain grow never reclaims anything) still
    // leaves that Set unreachable from the region root, so region_exit's
    // closing rewind silently reclaims it — the trap manifests later, whenever
    // that specific memory gets reused and read back as garbage.
    // KEYS in this table are always prop-name STRINGS (JS object keys are
    // always strings — a genuine language invariant, not an SSO-only
    // assumption): every key is content-hashed, so its hash bucket position
    // is immutable across relocation regardless of whether the string is
    // SSO-inline or a real heap allocation — no rehash/reinsert needed, just
    // a verbatim bulk copy of the bucket structure (unlike $__dyn_props's OWN
    // table below, whose keys are OFFSETS that genuinely change value and do
    // need __coll_order + reinsert). BUT bucket-position stability is a
    // separate question from the KEY FIELD'S OWN STORED BITS staying valid:
    // a non-SSO key is a STRING pointer, and relocation must still fix up
    // THAT pointer to the string's new address — exactly the same "value
    // needs __region_copy_rec, container structure doesn't need rehash"
    // split regionArmSetMap (layout-kinds.js) already applies to VALUES,
    // just for the KEY side this time. Front-boundary front-boundary audit
    // (.work/research.md §Region arena, "second still-unfound mechanism"):
    // this function's original write relocated the VALUE at slot+16 (both
    // branches below) but left the KEY at slot+8 as a verbatim bit-copy —
    // correct ONLY for the compiler-internal dyn-props sidecar's own keys
    // (always short single-word identifiers that happen to fit inline SSO in
    // every real instance seen), silently WRONG for any general PTR.HASH
    // value regionArmHash exposes this function to (a plain user/self-hosted-
    // compiler `{}` used as a dynamic dict, e.g. module/prepare's per-function
    // `defaults` map keyed by parameter names) whose keys can exceed SSO
    // width: the stale, unrelocated key pointer keeps pointing at the OLD,
    // now-reclaimed address — reads fine immediately after exit (bytes not
    // yet overwritten) and silently corrupts once a later allocation reuses
    // that space (jessie/watr/jzify-entry's post-funcIdx-skew front-boundary
    // failures, `src/compile/plan/scope.js` flattenFuncNamespaces's
    // `Object.keys(fn.defaults)` reading garbage). Fixed below: relocate the
    // key field too, no rehash needed. Slot stride is bare MAP_ENTRY (matching
    // __coll_order/genUpsertGrow's OWN per-slot indexing — module/collection.js
    // genUpsertGrow's $entrySize, NOT entrySize+LANE, which is the ALLOCATION
    // size only: a trailing i32-per-slot lane array sits AFTER all cap slots,
    // not interleaved — the bulk copy below must include that trailing region
    // too, so a relocated table's fast-probe lane data isn't left as garbage).
    // Heap-kind registry Slice 2 (.work/research.md §Heap-kind registry): memo
    // hardening added. Originally safe without one (each ARRAY/OBJECT dyn-props
    // sidecar is a freshly-minted, never-shared HASH — one container per
    // owner, so no call site could ever revisit the SAME $propsF bits within
    // one traversal). regionArmHash (layout-kinds.js) now also reaches this
    // function directly for a BARE PTR.HASH region-root value, which — unlike
    // a sidecar — CAN be diamond-referenced (aliasing: `let b = a` copies the
    // same HASH bits into a second reachable slot) or even self-referential
    // (a dict holding itself). Without a memo, a revisit would either
    // re-copy (breaking `===` identity across the two references) or, worse,
    // infinitely recurse on a cycle. Checked/set exactly like every other
    // __region_copy_rec arm: memo hit short-circuits; the durable branch
    // memos itself (address never changes); the ephemeral branch memos
    // BEFORE the value-relocation loop (cycles terminate on revisit).
    ctx.core.stdlib['__region_relocate_props'] = `(func $__region_relocate_props (param $propsF f64) (param $memo i64) (param $mark i32) (param $delta i32) (result f64)
      (local $off i32) (local $cap i32) (local $n i32) (local $newOff i32) (local $i i32) (local $slot i32)
      (local $bits i64) (local $hit i64) (local $out f64)
      (if (f64.eq (local.get $propsF) (f64.const 0)) (then (return (local.get $propsF))))
      (local.set $bits (i64.reinterpret_f64 (local.get $propsF)))
      ;; Ordering audit (.work/research.md §Region arena, __region_copy_rec ORDERING
      ;; AUDIT): memo hit-check BEFORE any work, matching every other kind's arm —
      ;; this was previously missing on THIS function's durable path (see below).
      ;; A bare PTR.HASH region-root CAN be diamond-shared (unlike an ARRAY/OBJECT
      ;; dyn-props sidecar, always 1:1 per-owner); an ARRAY/OBJECT/HASH dyn-props
      ;; sidecar reached from a durable container this function ITSELF also walks
      ;; recursively (nested dicts) needs the same short-circuit.
      (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
      (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))
      (local.set $off (call $__ptr_offset (local.get $bits)))
      (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
      (local.set $n (i32.load (i32.sub (local.get $off) (i32.const 8))))
      (if (i32.lt_u (local.get $off) (local.get $mark))
        (then
          ;; durable container (created a prior compile / never grown this round):
          ;; values updated in place, container address unchanged — mirrors
          ;; __region_copy_rec's ARRAY/OBJECT branches' own durable-walk-in-place
          ;; case, INCLUDING their "memo itself BEFORE walking children" step —
          ;; the bug this audit found: without it, a SECOND visit to the SAME
          ;; durable container (diamond-shared) re-walks every slot and re-runs
          ;; __region_copy_rec on each VALUE — but the first visit already
          ;; OVERWROTE ephemeral values in place with their FINAL (delta-adjusted,
          ;; not-yet-physically-valid — the closing memory.copy hasn't landed)
          ;; address. Re-presenting that final bit pattern as if it were fresh
          ;; input bits: __ptr_offset's forwarding-chase (ARRAY/HASH/SET/MAP are
          ;; all FORWARDING_MASK members) reads whatever unrelated data currently
          ;; occupies that not-yet-written final address, the child-level $memo
          ;; (keyed on ORIGINAL bits) doesn't recognize the final bits as the same
          ;; object, and the value gets silently re-derived from garbage — a
          ;; corrupted (observed: silently truncated to length 0; kernel-scale
          ;; heaps with real leftover garbage there can misread a huge/negative
          ;; length instead, matching the wall's "memory access out of bounds"
          ;; signature) copy, with NO trap in the common case, confirmed via a
          ;; native (non-kernel) probe: a durable Object.fromEntries(...) HASH
          ;; reached twice from one ephemeral array ([d, d]), with one ephemeral
          ;; array-valued property assigned after __region_mark() — control
          ;; (single reference, or no ephemeral child) reads back correct;
          ;; two-or-more references to the SAME durable dict corrupts the
          ;; ephemeral child deterministically at every opt level (0-3).
          (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $propsF))))
          (block $pd (loop $pl
            (br_if $pd (i32.ge_s (local.get $i) (local.get $cap)))
            (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const ${MAP_ENTRY}))))
            (if (i64.ne (i64.load (local.get $slot)) (i64.const 0))
              (then
                ;; KEY at +8, fixed up in place — no rehash (see this function's
                ;; own doc: content-hashed bucket position is stable regardless).
                (f64.store (i32.add (local.get $slot) (i32.const 8))
                  (call $__region_copy_rec (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $memo) (local.get $mark) (local.get $delta)))
                (f64.store (i32.add (local.get $slot) (i32.const 16))
                  (call $__region_copy_rec (f64.load (i32.add (local.get $slot) (i32.const 16))) (local.get $memo) (local.get $mark) (local.get $delta)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $pl)))
          (return (local.get $propsF))))
      ;; ephemeral — relocate the container: fresh same-cap block (verbatim bulk
      ;; copy preserves bucket positions since keys' hashes are stable), then
      ;; relocate each occupied slot's VALUE in the NEW location.
      (local.set $newOff (call $__alloc_hdr_n (local.get $n) (local.get $cap) (i32.add (i32.const ${MAP_ENTRY}) (i32.const ${LANE}))))
      (memory.copy (local.get $newOff) (local.get $off) (i32.mul (local.get $cap) (i32.add (i32.const ${MAP_ENTRY}) (i32.const ${LANE}))))
      (local.set $out (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0) (i32.sub (local.get $newOff) (local.get $delta))))
      (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
      (local.set $i (i32.const 0))
      (block $qd (loop $ql
        (br_if $qd (i32.ge_s (local.get $i) (local.get $cap)))
        (local.set $slot (i32.add (local.get $newOff) (i32.mul (local.get $i) (i32.const ${MAP_ENTRY}))))
        (if (i64.ne (i64.load (local.get $slot)) (i64.const 0))
          (then
            ;; KEY at +8 — same fixup as the durable branch above, no rehash.
            (f64.store (i32.add (local.get $slot) (i32.const 8))
              (call $__region_copy_rec (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $memo) (local.get $mark) (local.get $delta)))
            (f64.store (i32.add (local.get $slot) (i32.const 16))
              (call $__region_copy_rec (f64.load (i32.add (local.get $slot) (i32.const 16))) (local.get $memo) (local.get $mark) (local.get $delta)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $ql)))
      ;; NO old-site forwarding stub — boundary-arithmetic audit, window B (see
      ;; regionArmArray's comment, layout-kinds.js, for the full mechanism).
      (local.get $out))`

    // Relocate a boxed-capture's shared payload cell (module/function.js's
    // `ctx.func.boxed` mechanism — an 8-byte `__alloc(8)` block holding ONE
    // f64 value, mutated in place so every closure that captured the SAME
    // source variable observes the SAME writes). Region arena's CLOSURE arm
    // (layout-kinds.js regionArmClosure) calls this per cell-mode env slot
    // INSTEAD OF __region_copy_rec directly: the slot holds the cell's RAW
    // i32 ADDRESS, not a NaN-boxed f64, so it can't go through that
    // function's own f64 tag dispatch.
    //
    // Memoized like every other arm — but a cell has no NaN-boxed identity
    // to key $memo on (it's a bare i32, never wrapped in a PTR.* tag), so
    // this synthesizes one: `f64.convert_i32_s(cellOff)` is always a plain
    // FINITE float (never a NaN-boxed bit pattern — every real heap pointer
    // this traversal ever memoizes carries the NaN prefix, layout.js), so it
    // can never collide with a real pointer's own memo entry, and reusing
    // $memo (already threaded through, already scoped to exactly one
    // __region_exit call) needs no new global state — the same trick
    // regionArmArray's own dyn-props migration already uses to key
    // $__dyn_props by a raw i32 offset (`f64.convert_i32_s`, that function's
    // own comment). This dedup is load-bearing, not an optimization: a cell
    // shared by two closures (aliasing two mutable captures of the same
    // source variable — the entire point of the boxed-cell mechanism) MUST
    // relocate to the SAME new address from both env slots, or the two
    // closures silently stop seeing each other's writes post-relocation.
    //
    // Durable branch carries the SAME memo-BEFORE-mutate ordering the TYPED
    // view-rebase audit fix required (.work/research.md §Region arena,
    // ordering audit): without it, a diamond-shared durable cell revisited a
    // second time in the same traversal would re-read its OWN already-
    // relocated (delta-adjusted, not-yet-physically-valid) payload as if it
    // were fresh input — the identical corruption class that fix closed for
    // __region_relocate_props/TYPED, closed here the same way (memo set
    // before the in-place mutation, not after).
    ctx.core.stdlib['__region_relocate_cell'] = `(func $__region_relocate_cell (param $cellOff i32) (param $memo i64) (param $mark i32) (param $delta i32) (result i32)
      (local $key f64) (local $hit i64) (local $newOff i32) (local $logOff i32)
      (local.set $key (f64.convert_i32_s (local.get $cellOff)))
      (local.set $hit (call $__map_get (local.get $memo) (i64.reinterpret_f64 (local.get $key))))
      (if (i32.eqz (call $__is_nullish (local.get $hit)))
        (then (return (i32.trunc_f64_s (f64.reinterpret_i64 (local.get $hit))))))
      (if (i32.lt_u (local.get $cellOff) (local.get $mark))
        (then
          (drop (call $__map_set (local.get $memo) (i64.reinterpret_f64 (local.get $key)) (i64.reinterpret_f64 (local.get $key))))
          (f64.store (local.get $cellOff) (call $__region_copy_rec (f64.load (local.get $cellOff)) (local.get $memo) (local.get $mark) (local.get $delta)))
          (return (local.get $cellOff))))
      ;; Ephemeral — $newOff is a PHYSICAL staging address (current heap top,
      ;; ABOVE mark); the ONLY closing fixup pass is __region_exit's single
      ;; bulk memory.copy(mark, T, size), which moves bytes verbatim and
      ;; never revisits pointer VALUES already written into the staged block.
      ;; Every other arm (see __region_relocate_props's own $out just above,
      ;; and __mkptr call sites throughout __region_copy_rec) therefore
      ;; pre-adjusts by -delta BEFORE writing a relocated address anywhere a
      ;; slot might read it back — this cell arm was the one place that
      ;; memoized/returned the raw physical $newOff instead, so any caller
      ;; that stores the result into an env slot (regionArmClosure,
      ;; layout-kinds.js — both its durable and ephemeral branches) persisted
      ;; a not-yet-final address, valid to dereference only AFTER this
      ;; round's closing copy — a real, confirmed-by-comparison-to-every-
      ;; sibling-arm's-own-convention bug, fixed here (.work/research.md
      ;; §Region arena, __region_relocate_cell delta-adjustment entry).
      ;; NOT the sole cause of the front-boundary's own garbage-cellOff wall:
      ;; a debug-global trace (same entry) caught the SAME symptom (a
      ;; ~1.2GB cellOff against 512MB memory) on a closure whose env block
      ;; was being relocated for the FIRST time this round (never touched
      ;; this fix's own write path yet) — a second, still-open mechanism,
      ;; diagnosed but not fixed. $logOff (= $newOff - $delta) is the FINAL
      ;; address, matching every other kind's own convention exactly;
      ;; $newOff itself stays the write target since the payload store below
      ;; runs THIS round, before the bulk copy lands.
      (local.set $newOff (call $__alloc (i32.const 8)))
      (local.set $logOff (i32.sub (local.get $newOff) (local.get $delta)))
      (drop (call $__map_set (local.get $memo) (i64.reinterpret_f64 (local.get $key)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $logOff)))))
      (f64.store (local.get $newOff) (call $__region_copy_rec (f64.load (local.get $cellOff)) (local.get $memo) (local.get $mark) (local.get $delta)))
      (local.get $logOff))`

    // Function form (not a plain template string): the ARRAY/OBJECT dyn-props
    // migration inside regionCopyRecBody (layout-kinds.js) is gated on
    // `ctx.scope.globals.has('__dyn_props')`, which must be read at PULL time
    // (src/wat/assemble.js calls a function-valued stdlib entry lazily, exactly
    // once, when the name is actually pulled in — see __obj_clone/__dyn_set
    // above for the same idiom), not at this file's own module-setup time,
    // when collection.js's global declarations may not have run yet. Likewise
    // OBJECT's schema-length lookup (regionArmObject) needs `$__schema_tbl`
    // declared — mirrors __sclone_rec's own guard (module/collection.js): a
    // build with no OBJECT anywhere still gets the global seeded to 0, so its
    // `(if (i32.ne $__schema_tbl 0) ...)` check degrades to "0 slots" safely
    // rather than referencing an undeclared global.
    //
    // Heap-kind registry Slice 2 (.work/research.md §Heap-kind registry): the
    // function BODY (locals + preamble + every kind's arm) is generated from
    // layout-kinds.js's regionCopyRecBody — BIGINT/STRING/ARRAY/SET+MAP
    // extracted verbatim from the pre-Slice-2 hand-written text (byte-identity
    // pinned in test/layout-kinds.js), OBJECT/HASH/TYPED/BUFFER/EXTERNAL/
    // CLOSURE all now real arms — see that file's own header for the full
    // rationale and FINDINGS['region-forwarding'] (layout-kinds-doc.js) for
    // the closed history.
    //
    // `$__closure_env_len`/`$__closure_env_mask`: CLOSURE's side table
    // (funcIdx → env slot count / cell-mode bitmask, src/wat/assemble.js
    // builds it from ctx.closure.envMeta once ctx.closure.table is final).
    // Declared unconditionally here, mirroring `$__schema_tbl` just below —
    // a build with no closures anywhere (or with __region_copy_rec pulled in
    // but assemble.js never populating the table because ctx.closure.table
    // is empty) still gets both globals seeded to 0, so regionArmClosure's
    // own `$__closure_env_len == 0` guard degrades safely rather than
    // referencing an undeclared global.
    ctx.core.stdlib['__region_copy_rec'] = () => {
      if (!ctx.scope.globals.has('__schema_tbl')) declGlobal('__schema_tbl', 'i32')
      if (!ctx.scope.globals.has('__closure_env_len')) declGlobal('__closure_env_len', 'i32')
      if (!ctx.scope.globals.has('__closure_env_mask')) declGlobal('__closure_env_mask', 'i32')
      return `(func $__region_copy_rec (param $v f64) (param $memo i64) (param $mark i32) (param $delta i32) (result f64)
${regionCopyRecBody({ hasDynProps: ctx.scope.globals.has('__dyn_props') })}`
    }

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
  //
  // $__coll_order_n: the buffer's REAL live-entry extent, stamped into this global
  // right before return. Every caller that treats the returned buffer as a bound
  // list MUST read this (not the table's own header length word at off-8) as its
  // iteration bound — the header and the real gathered count are NOT guaranteed to
  // agree (audit: .work/research.md §Region arena's 5e77f814 entry — a `new
  // Map(existingMap)` copy trusting the header length read a zeroed slot past
  // __coll_order's actual output, decoding the kernel's own static string-table
  // data at address 0). A single caller-local capture right after the call (the
  // existing pattern every site already uses for its OWN loop-bound local) is
  // reentrancy-safe: nested __coll_order calls from within the loop body (e.g.
  // structuredClone/region-copy recursing into a nested Set/Map) only clobber the
  // global AFTER the outer bound is already captured into its own local.
  declGlobal('__coll_order_n', 'i32')
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
    (global.set $__coll_order_n (local.get $n))
    (local.get $buf))`

  // for-in's HASH key enumeration with a 1-slot enum cache (V8's EnumCache analog).
  // A for-in over an unchanged dict re-derives the same key array every entry —
  // __coll_order buffer + out-array alloc + cap scan + sort per loop entry (the
  // dominant cost of any per-call `for (k in cfg)` pattern: jessie's comment
  // wrapper paid this per TOKEN). Cache the boxed key array keyed by
  // (table off, live len): an insert changes len, so it misses naturally with no
  // insert-side hook; the only len-preserving key-set change is delete-then-insert,
  // so the HASH delete (genDelete, collection.js) clears the cache unconditionally;
  // `__clear` resets it (arena rewind can re-issue the cached off to a new table).
  // Grow/remint relocation is safe hook-free: reads resolve forwarding to the new
  // off (≠ cached), and a husk off is never re-issued within an arena epoch.
  // ONLY sound for for-in (`__keys_ro`), whose result is read-only by construction —
  // Object.keys must keep fresh-array semantics (callers may mutate the result).
  // $n (the table's own header length) stays the CACHE KEY — cheap, read before
  // __coll_order even runs, gating the whole fast path — but the OUTPUT array's
  // size and the fill loop's bound use $realN (__coll_order's own live-gathered
  // count) instead: a header/real-occupancy desync must not leave the returned
  // array's tail uninitialized (over-alloc from a stale-high header) or read past
  // __coll_order's actual buffer (see __coll_order's own header comment).
  ctx.core.stdlib['__hash_keys_ro'] = `(func $__hash_keys_ro (param $hbits i64) (result f64)
    (local $off i32) (local $n i32) (local $realN i32) (local $ord i32) (local $i i32) (local $out i32)
    (local.set $off (call $__ptr_offset (local.get $hbits)))
    ;; degenerate/null backing (off below heap base): empty result, uncached
    (if (i32.lt_u (local.get $off) (i32.const ${HEAP.START}))
      (then (return (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (call $__alloc_hdr (i32.const 0) (i32.const 0))))))
    (local.set $n (i32.load (i32.sub (local.get $off) (i32.const 8))))
    (if (i32.and (i32.eq (local.get $off) (global.get $__enumc_off))
                 (i32.eq (local.get $n) (global.get $__enumc_len)))
      (then (return (global.get $__enumc_arr))))
    (local.set $ord (call $__coll_order (local.get $off)
      (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const 24)))
    (local.set $realN (global.get $__coll_order_n))
    (local.set $out (call $__alloc_hdr (local.get $realN) (local.get $realN)))
    (block $brk (loop $l
      (br_if $brk (i32.ge_s (local.get $i) (local.get $realN)))
      (i64.store (i32.add (local.get $out) (i32.shl (local.get $i) (i32.const 3)))
        (i64.load (i32.add (i32.load (i32.add (local.get $ord) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 8))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $__enumc_off (local.get $off))
    (global.set $__enumc_len (local.get $n))
    (global.set $__enumc_arr (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $out)))
    (global.get $__enumc_arr))`

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

  // === binary16 ↔ f64 (Float16Array / DataView.getFloat16 / Math.f16round) ===
  // Pure-integer, exactly rounded — f64 → f16 rounds DIRECTLY off the f64 bits
  // (an f32 hop double-rounds at the overflow boundary: 65519.999… must round
  // to 65504, not Inf). f16 → f64 is exact by construction (every half is a
  // double). NaN canonicalizes (sign/payload dropped) so `v !== v` stays sound
  // on jz's canonical-NaN model.
  ctx.core.stdlib['__f16_to_f64'] = `(func $__f16_to_f64 (param $b i32) (result f64)
    (local $h i32) (local $e i32) (local $m i32) (local $r f64)
    (local.set $h (i32.and (local.get $b) (i32.const 0x7FFF)))
    (local.set $e (i32.shr_u (local.get $h) (i32.const 10)))
    (local.set $m (i32.and (local.get $h) (i32.const 0x3FF)))
    (if (i32.eq (local.get $e) (i32.const 31))
      (then
        (if (local.get $m)
          (then (return (f64.reinterpret_i64 (i64.const ${nanPrefixHex()}))))
          (else (return (f64.reinterpret_i64 (i64.or (i64.const 0x7FF0000000000000)
            (i64.shl (i64.extend_i32_u (i32.and (local.get $b) (i32.const 0x8000))) (i64.const 48)))))))))
    (if (i32.eqz (local.get $e))
      ;; subnormal: mant · 2^-24 (exact — integer times a power of two)
      (then (local.set $r (f64.mul (f64.convert_i32_u (local.get $m)) (f64.const 5.960464477539063e-8))))
      (else (local.set $r (f64.reinterpret_i64 (i64.or
        (i64.shl (i64.extend_i32_u (i32.add (local.get $e) (i32.const 1008))) (i64.const 52))
        (i64.shl (i64.extend_i32_u (local.get $m)) (i64.const 42)))))))
    (f64.reinterpret_i64 (i64.or (i64.reinterpret_f64 (local.get $r))
      (i64.shl (i64.extend_i32_u (i32.and (local.get $b) (i32.const 0x8000))) (i64.const 48)))))`

  ctx.core.stdlib['__f64_to_f16'] = `(func $__f64_to_f16 (param $v f64) (result i32)
    (local $u i64) (local $sign i32) (local $ne i32) (local $half i32)
    (local $m i64) (local $full i64) (local $sh i64) (local $rb i64) (local $hp i64)
    (local.set $u (i64.reinterpret_f64 (local.get $v)))
    (local.set $sign (i32.wrap_i64 (i64.and (i64.shr_u (local.get $u) (i64.const 48)) (i64.const 0x8000))))
    (local.set $u (i64.and (local.get $u) (i64.const 0x7FFFFFFFFFFFFFFF)))
    (if (i64.ge_u (local.get $u) (i64.const 0x7FF0000000000000))
      (then (return (i32.or (local.get $sign)
        (select (i32.const 0x7E00) (i32.const 0x7C00) (i64.gt_u (local.get $u) (i64.const 0x7FF0000000000000)))))))
    (local.set $m (i64.and (local.get $u) (i64.const 0xFFFFFFFFFFFFF)))
    (local.set $ne (i32.sub (i32.wrap_i64 (i64.shr_u (local.get $u) (i64.const 52))) (i32.const 1008)))
    (if (i32.ge_s (local.get $ne) (i32.const 31))
      (then (return (i32.or (local.get $sign) (i32.const 0x7C00)))))
    (if (i32.ge_s (local.get $ne) (i32.const 1))
      (then ;; normal: 42 dropped mantissa bits round ties-to-even; a mantissa
            ;; carry overflows into the exponent or into infinity — both exact
        (local.set $half (i32.or (i32.shl (local.get $ne) (i32.const 10))
          (i32.wrap_i64 (i64.shr_u (local.get $m) (i64.const 42)))))
        (local.set $rb (i64.and (local.get $m) (i64.const 0x3FFFFFFFFFF)))
        (if (i32.or (i64.gt_u (local.get $rb) (i64.const 0x20000000000))
              (i32.and (i64.eq (local.get $rb) (i64.const 0x20000000000)) (i32.and (local.get $half) (i32.const 1))))
          (then (local.set $half (i32.add (local.get $half) (i32.const 1)))))
        (return (i32.or (local.get $sign) (local.get $half)))))
    (if (i32.lt_s (local.get $ne) (i32.const -10))
      (then (return (local.get $sign)))) ;; underflow → ±0
    ;; subnormal: shift the 53-bit significand by 43-ne (43…53), ties-to-even
    (local.set $full (i64.or (local.get $m) (i64.const 0x10000000000000)))
    (local.set $sh (i64.extend_i32_u (i32.sub (i32.const 43) (local.get $ne))))
    (local.set $half (i32.wrap_i64 (i64.shr_u (local.get $full) (local.get $sh))))
    (local.set $rb (i64.and (local.get $full) (i64.sub (i64.shl (i64.const 1) (local.get $sh)) (i64.const 1))))
    (local.set $hp (i64.shl (i64.const 1) (i64.sub (local.get $sh) (i64.const 1))))
    (if (i32.or (i64.gt_u (local.get $rb) (local.get $hp))
          (i32.and (i64.eq (local.get $rb) (local.get $hp)) (i32.and (local.get $half) (i32.const 1))))
      (then (local.set $half (i32.add (local.get $half) (i32.const 1)))))
    (i32.or (local.get $sign) (local.get $half)))`

  // ToUint8Clamp (Uint8ClampedArray stores): NaN → 0, clamp [0,255],
  // round-half-to-even — f64.nearest IS ties-to-even.
  ctx.core.stdlib['__u8_clamp'] = `(func $__u8_clamp (param $v f64) (result i32)
    (if (f64.ne (local.get $v) (local.get $v)) (then (return (i32.const 0))))
    (i32.trunc_sat_f64_u (f64.nearest (f64.min (f64.max (local.get $v) (f64.const 0)) (f64.const 255)))))`

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
        ;; 28 = MAP_ENTRY + the probe hash lane (collection.js) — the wholesale
        ;; copy must carry the lane or the clone's probes see stale zeros
        (local.set $dst (call $__alloc_hdr_n (i32.const 0) (local.get $cap) (i32.const 28)))
        (memory.copy
          (i32.sub (local.get $dst) (i32.const 16))
          (i32.sub (local.get $src) (i32.const 16))
          (i32.add (i32.const 16) (i32.mul (local.get $cap) (i32.const 28))))
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
   *  ARRAY length is i32 at offset-8 — inline that load directly instead of calling
   *  __len which re-dispatches on type. ptrOffsetIR handles
   *  ARRAY forwarding (non-ARRAY skips the forwarding loop). TYPED has a variable-width
   *  layout depending on the aux typed-element shift, so it still routes through __len.
   *  `notString` (from rep.notString — write-shape evidence rules out primitive string)
   *  routes the otherwise-unknown case through __len directly, eliding the STRING arm
   *  of __length. __len returns 0 on tags it doesn't recognize, matching JS's
   *  `undefined` semantics on non-pointer .length (the binding writes through xs[i]
   *  / xs.length, so reaching .length with a non-pointer is unreachable in practice). */
  function emitLengthAccess(va, vt, notString = false, mayBeUndef = false) {
    // jsstring carrier: receiver is an externref slot (boundary param tagged
    // `jsstring` by narrow.js phase J). Route to the `wasm:js-string` length
    // builtin directly — no SSO unbox, zero copy.
    if (va?.type === 'externref') {
      ctx.core.jsstring.add('length')
      return typed(['f64.convert_i32_s', ['call', '$__jss_length', va]], 'f64')
    }
    if (vt === VAL.ARRAY) {
      const off = ptrOffsetIR(va, vt)
      return typed(['f64.convert_i32_s', ['i32.load', ['i32.sub', off, ['i32.const', 8]]]], 'f64')
    }
    // Set/Map have no .length in JS — their count is `.size`. (The former
    // shared-layout __len shortcut returned the entry count here.)
    if (vt === VAL.SET || vt === VAL.MAP) return undefExpr()
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
      setLinkDemand('typedarray')
      return typed(['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', va]]], 'f64')
    }
    // Unknown → runtime dispatch via stdlib. Set/Map dispatch arms are pulled
    // only when user code actually constructs Set/Map (collection.js sets the
    // feature flags at the construction site); otherwise dispatch falls through
    // to ARRAY/STRING/TYPED. typedarray stays on because typed arrays are
    // commonly passed from JS via jz.memory.* without an in-program constructor.
    //
    // mayBeUndefined receiver ONLY (audit-#10 kind-specific table): `va` may
    // genuinely BE the nullish sentinel here — a census-shaped dict/Map
    // absent-key read (or a propagated-mayBeUndefined param/return/closure
    // hop, `censusMaybeUndefined`'s own reach) has no proven vt (§14's
    // opt-in model — a census read never sets `val`), so it lands in exactly
    // this arm, unlike a proven ARRAY/STRING/TYPED receiver which returns
    // above and pays nothing extra. Real JS throws TypeError for `.length`
    // off null/undefined — distinct from an ordinary object simply lacking
    // an own `.length` property, which still correctly reads `undefined`
    // via `__length`'s property-fallback arm below, unaffected by this
    // check. Gated on `mayBeUndef` — NOT merely "vt is unknown" — found
    // live, not assumed: `vt == null` alone is FAR broader than "might be
    // undefined" (a plain polymorphic-kind parameter passed a Float64Array
    // at one call site and an Int32Array at another has no single proven
    // `vt` either, but is never actually nullish — e.g. bench/poly.js's
    // `sum(arr)`), and gating on vt-null alone taxed EVERY such site with a
    // guard that could never fire, a real +0.069 SIZE-geomean regression
    // across the size-sweep corpus (49/49 cases, all vt-null-but-never-null
    // `.length` receivers) caught by the mandated gate before landing, not
    // shipped. `censusMaybeUndefined` (kind.js) is the EXISTING, narrower,
    // load-bearing "genuinely might be undefined" predicate this whole
    // design (§9-§16) already built and propagates through param/return/
    // closure hops — reused verbatim, not reinvented. `va` is captured once
    // (it may be a side-effecting expression, e.g. a `m.get(k)` call) so the
    // nullish test and the dispatch both read the SAME evaluation.
    if (mayBeUndef) {
      inc('__length')
      setLinkDemand('typedarray')
      const lt = temp('lnva')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${lt}`, va],
        ['if', ['result', 'f64'],
          isNullish(typed(['local.get', `$${lt}`], 'f64')),
          ['then', throwTypeErrorIR()],
          ['else', typed(['call', '$__length', ['i64.reinterpret_f64', ['local.get', `$${lt}`]]], 'f64')]]], 'f64')
    }
    inc('__length')
    setLinkDemand('typedarray')
    return typed(['call', '$__length', ['i64.reinterpret_f64', va]], 'f64')
  }

  // Known-schema fields live in the object payload. Dynamic sidecars are only
  // for ad-hoc props on pointer-backed values, so schema reads should bypass it.
  // Slot val-types reach the emit-time consumer via valTypeOf → ctx.schema.slotVT
  // (read on the AST `.prop` node), not via tagging this IR node.
  function emitSchemaSlotRead(baseExpr, idx, i32Certain, bigintProven) {
    // An unboxed proven-non-ARRAY pointer (a structInline element cell, a narrowed local)
    // reaches ptrOffsetIR raw so it returns the offset directly — no `__ptr_offset` call.
    // Pre-boxing via asF64 strips ptrKind and forces every field read onto the call path
    // (the dcbb433 perf cliff on object/struct kernels — `p.x,p.y,p.z` per loop iteration).
    // A NaN-box or untyped value still routes through f64 for the reinterpret/forwarding path.
    const base = (baseExpr?.ptrKind != null && baseExpr.ptrKind !== VAL.ARRAY)
      ? baseExpr
      : (baseExpr?.type === 'f64' ? baseExpr : asF64(baseExpr))
    // Packed i32 cells (structInline + inlineCellI32, flag rides the cursor
    // node): the field IS a raw i32 at +idx*4 — one i32.load, no trunc_sat.
    // A BIGINT slot is never i32-certain (census invariant, program-facts.js
    // analyzeSchemaSlotIntCertain) and inlineCellI32 requires EVERY slot
    // i32-certain — bigintProven and cellI32 are mutually exclusive by
    // construction, so this arm never needs to consult bigintProven at all.
    if (baseExpr?.cellI32) return typed(packedI32.ops.load(ptrOffsetIR(base, VAL.OBJECT), idx), 'i32')
    const load = ctx.abi.object.ops.load(ptrOffsetIR(base, VAL.OBJECT), idx)
    // Strict-int32 slot (ctx.schema.slotI32CertainAt — every censused write is
    // exactly-int32, never -0): land the value directly in i32. trunc_sat of
    // such an f64 is a value-exact round-trip, and every int consumer skips
    // the ToInt32 guard/convert battery the f64 route pays (the immutable
    // kernel's per-field cost); f64 consumers convert back at one op.
    if (i32Certain) return typed(['i32.trunc_sat_f64_s', load], 'i32')
    // CARRIER PROGRAM §15/§16: the third read surface Slice 3's arm inventory
    // never enumerated. A PROVEN-BIGINT slot (ctx.schema.slotBigintProvenAt/
    // BySid, module/schema.js — every write to this slot is proven BIGINT
    // AND the schema's write side boxes it) is UNCONDITIONALLY boxed by
    // construction (module/object.js's literal/spread construction, this
    // file's dot-assign and structInline element-store arms all derive from
    // the SAME per-schema fact) — a static read may unbox it directly instead
    // of handing a registry-only box pointer to every consumer as if it were
    // the field's raw value (the original §15 corruption: `LAYOUT.
    // NAN_PREFIX_BITS`'s bare f64.load fed a boxed pointer's own bits straight
    // into arithmetic). Returns the raw i64 payload — typed 'i64', mirroring
    // readI64/unboxBigInt's own convention (src/ir.js): a generic consumer
    // (asF64) reinterprets those bits into the SAME opaque f64 carrier every
    // OTHER unboxed BigInt value uses by default in this compiler, and any
    // consumer that reaches a genuine W-sink re-boxes fresh via carrierF64's
    // unconditional inline-expression fallback (this `.` node is an Array,
    // valTypeOf resolves BIGINT via slotVT) — exactly how every other inline
    // BIGINT expression already round-trips. UNPROVEN reads (bigintProven
    // false) fall through unchanged: the box keeps flowing as an opaque f64
    // value, which registry-aware consumers ($__dyn_get/$__typeof/$__to_num/
    // $__eq) already handle correctly per Slice 3.
    if (bigintProven) return unboxBigInt(typed(load, 'f64'))
    return typed(load, 'f64')
  }

  // Top 32 bits of the i64 NaN-box carrier: NAN_PREFIX | PTR tag (TAG_SHIFT=47)
  // | schemaId aux (AUX_SHIFT=32) — layout.js packs all three above bit 31, so
  // masking the whole high word and comparing to encodePtrHi(OBJECT, sid) proves
  // "is an OBJECT" AND "is exactly this schema" in one i64 compare; the low
  // word (this instance's heap offset) is irrelevant and stays unmasked.
  // (OBJECT_SCHEMA_HI_MASK / objectSchemaGuardHex now live in layout.js — shared
  // with src/ir.js's Error-schema toStrI64 guard, same encoding, one definition.)

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
  function emitSchemaSlotGuarded(va, guard, slow, prop) {
    // Clone: `slow` is a closure the CALLER built over the same `va` object
    // (emitPropAccess's `const slow = () => …emitDynGetAnyTyped(va, …)`), so this
    // function's own use of `va` below and the caller's use inside `slow()` would
    // otherwise be the SAME node appearing twice in the final if/then/else tree —
    // one logical read, but two tree positions. A later pass that walks the tree
    // once per node identity (not per position) — e.g. local-slot lifetime/reuse
    // analysis — sees only the FIRST occurrence's use and can free/reassign the
    // local behind the second, producing whatever locals happen to be resident at
    // that point (see cloneIR's doc; ir.js). va is a pure receiver read (a local/
    // cell load), safe to duplicate as long as each occurrence is its own object.
    va = cloneIR(va)
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
    // CARRIER PROGRAM §15/§16 (verified, not threaded — unlike emitSchemaSlotRead's
    // other call sites): `slow()` is a GENUINE dynamic dispatch whose receiver
    // could be any schema or none — it always returns the box itself (a valid
    // NaN-boxed f64), never an unboxed payload, because a registry-aware reader
    // can't statically prove a uniform kind. `fast`, below, must produce the
    // exact SAME representation: a wasm `if` requires both arms to share one
    // value type, and any downstream consumer of this merged result (readI64,
    // carrierF64) needs ONE consistent contract across both arms, not "box on
    // miss, raw payload on hit". So even when guard.sid/guard.slot IS a proven-
    // BIGINT-boxed slot (ctx.schema.slotBigintProvenBySid), `fast`'s plain load
    // is already correct AS-IS: it returns the box, matching `slow()` exactly —
    // no unbox belongs here. (A future dedicated arm COULD unbox both sides at
    // once by wrapping the whole `if` post-hoc, but no such consumer exists
    // today — left as a documented no-op rather than adding unused plumbing.)
    // CONSERVATIVE PAIRING (coordinator ruling, .work/context-sensitivity-
    // survey.md) — re-verified, explicitly excluded, not just left alone:
    // this arm's OWN output stays box-or-raw either way (unchanged above),
    // and the new dispatch lives one layer up, at readI64 (src/ir.js) — it
    // consults the ORIGINAL source AST node (`.prop`), not which internal
    // branch (this guard, or a plain schema read) produced the value, so a
    // guarded read's combined fast/slow result is already covered by readI64
    // once IT fires — no separate wiring needed here. It structurally never
    // fires for THIS site's own `obj` though: readI64's predicate needs
    // `obj` itself bound to a resolvable schemaId (ctx.schema.slotBigintBoxedAt),
    // and this whole function only runs when `obj`'s kind is fully unknown
    // (emitPropAccess's `vt == null` branch) — the same "structural fallback
    // gets false" scope-out §16 already established for the chain-receiver
    // case, not a new gap.
    const fast = typed(ctx.abi.object.ops.load(off, guard.slot), 'f64')
    const ir = typed(['if', ['result', 'f64'],
      cond,
      ['then', fast],
      ['else', slow()]], 'f64')
    // Slot-kind stamp for ToNumber sinking (toNumF64): when the ONE schema
    // this guard proves censuses the slot as NUMBER — and the prop is never
    // written anywhere (a write could store any kind) — the guard-HIT arm's
    // raw load is already a plain number. toNumF64 then coerces only the
    // dyn-miss arm instead of wrapping the whole read in __to_num — the
    // shapes-dispatch pattern's per-field coercion collapses on the hot path.
    if (ctx.schema.slotFacts?.get(guard.sid)?.[guard.slot]?.kind === VAL.NUMBER
        && ctx.types.writtenProps && !ctx.types.writtenProps.has(prop))
      ir.guardedNumSlot = true
    return ir
  }

  function emitHashGetLocalConst(base, key, prop) {
    inc('__hash_get_local_h')
    const receiver = asI64(base?.type ? base : typed(base, 'f64'))
    return typed(['f64.reinterpret_i64', ['call', '$__hash_get_local_h', receiver, key, ['i32.const', strHashLiteral(prop)]]], 'f64')
  }

  // Every call site embeds `receiver` a SECOND time directly (as the dyn-get
  // call's own receiver arg) alongside this function's result — clone so the two
  // occurrences are distinct node objects (see emitSchemaSlotGuarded's comment /
  // cloneIR's doc for why aliased IR nodes are unsound to leave standing).
  function emitTypeTag(receiver, vt) {
    const p = valKindToPtr(vt)
    if (p != null) return ['i32.const', p]
    inc('__ptr_type')
    return ['call', '$__ptr_type', cloneIR(receiver)]
  }

  function emitDynGetExprTyped(base, key, vt, prop) {
    const receiver = asI64(base?.type ? base : typed(base, 'f64'))
    // Constant string key: fold the FNV hash at compile time and call the
    // prehashed body — no __str_hash on every access.
    if (typeof prop === 'string') {
      inc('__dyn_get_expr_t_h')
      const call = ['call', '$__dyn_get_expr_t_h', receiver, key, emitTypeTag(receiver, vt), ['i32.const', strHashLiteral(prop)]]
      // Schema-set devirt marker — same contract as emitDynGetAnyTyped below
      // (identical 4-arg layout); without it the wasi host (linkDemand.external
      // off routes reads here) never devirtualizes megamorphic prop reads.
      // A branch-versioned fallback is already dominated by a failed exact-sid
      // guard; rebuilding per-read schema tables there is dead overhead.
      if ((ctx.transform.optFlags & OPTF.devirtDynProps) && !ctx.func._schemaSpecSlow) {
        call.dvProp = prop
        call.dvObject = vt === VAL.OBJECT
      }
      return typed(['f64.reinterpret_i64', call], 'f64')
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
      const call = ['call', '$__dyn_get_any_t_h', receiver, key, emitTypeTag(receiver, vt), ['i32.const', strHashLiteral(prop)]]
      // Schema-set devirt marker: the optimizer (devirtSchemaReads) rewrites this
      // megamorphic probe into a br_table over the module's registered schemas —
      // direct slot loads per schema, this call as the always-sound default arm.
      // Tagged here (not built) because schema.list is still growing while
      // function bodies emit; the pass runs after module init completes.
      if ((ctx.transform.optFlags & OPTF.devirtDynProps) && !ctx.func._schemaSpecSlow) {
        call.dvProp = prop
        call.dvObject = vt === VAL.OBJECT
      }
      return typed(['f64.reinterpret_i64', call], 'f64')
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

  // schemaId of a literal-resolved expression (literalSlot's own sibling),
  // or null. `literalAst` bails on any spread source, so this always mirrors
  // module/object.js's plain (non-spread) `litId = ctx.schema.register(names)`
  // in the SAME source order — and since this fast path only ever fires for
  // an ANONYMOUS literal (this file's own comment above literalAst: the
  // varName-bound `let o = {a:1}; o.a` case already resolves via
  // ctx.schema.idOf), `takeLiteralTarget()` is null at that literal's real
  // construction, so `schemaId` there is ALWAYS `litId` too — no merge-schema
  // branch to reproduce. CARRIER PROGRAM §15/§16: lets the literal fast path
  // consult ctx.schema.slotBigintProvenBySid the same as every other
  // emitSchemaSlotRead call site.
  function literalSid(obj) {
    const lit = literalAst(obj)
    if (!lit) return null
    const props = lit.slice(1)
    const flat = props.length === 1 && Array.isArray(props[0]) && props[0][0] === ','
      ? props[0].slice(1) : props
    const names = []
    for (const p of flat) if (Array.isArray(p) && p[0] === ':') names.push(p[1])
    return ctx.schema.register(names)
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
    if (slot >= 0) return emitSchemaSlotRead(va, slot, false, ctx.schema.slotBigintProvenBySid?.(literalSid(obj), prop))
    // Receiver IR is an unboxed OBJECT pointer carrying its own schema (a
    // structInline element cell, a narrowed local): resolve the field's fixed
    // slot directly from `ptrAux` — more precise than the structural
    // `ctx.schema.slotOf(null, …)` and never falls to the dyn dispatcher.
    if (va?.ptrKind === VAL.OBJECT && va.ptrAux != null && typeof prop === 'string') {
      const sch = ctx.schema.list[va.ptrAux]
      const si = sch ? sch.indexOf(prop) : -1
      if (si >= 0) return emitSchemaSlotRead(va, si, ctx.schema.slotI32CertainBySid?.(va.ptrAux, prop),
        ctx.schema.slotBigintProvenBySid?.(va.ptrAux, prop))
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
    if (schemaIdx >= 0) {
      // A precise schema id proves this is a fixed-size OBJECT allocation, not
      // an ARRAY value that may have relocated. Extract the payload offset from
      // the NaN-box directly instead of calling the generic forwarding-aware
      // __ptr_offset for every field. Branch-local schema speculation supplies
      // the same proof after its exact tag+sid guard, so an N-field variant pays
      // one guard and zero pointer-helper calls.
      let base = va
      const sid = typeof obj === 'string' ? ctx.schema.idOf(obj) : null
      const guardedIds = typeof obj === 'string' ? ctx.func.refinements?.get(obj)?.schemaIds : null
      // A union-cursor param (stage 3) carries the packed cell address as an f64
      // NaN-box (`va.cellI32`, tagged in readVar): unbox to the raw i32 address
      // here too, then carry cellI32/unionKey so emitSchemaSlotRead takes the
      // packed i32.load. Without the unbox the f64 node would reach the packed
      // load as an address (ptrOffsetIR returns a ptrKind'd node as-is → f64 used
      // as an address, invalid wasm). The discriminant read `o.k` has no
      // refinement/sid, so `va.cellI32` is the trigger that fires the unbox.
      if ((sid != null || guardedIds?.length || va?.cellI32 || (typeof obj === 'string' && lookupValType(obj) === VAL.OBJECT)) && va?.type === 'f64') {
        base = typed(['i32.wrap_i64', ['i64.reinterpret_f64', va]], 'i32')
        base.ptrKind = VAL.OBJECT
        base.ptrAux = sid ?? guardedIds?.[0]
        if (va.cellI32) { base.cellI32 = true; base.unionKey = va.unionKey }
      }
      return emitSchemaSlotRead(base, schemaIdx,
        typeof obj === 'string' && ctx.schema.slotI32CertainAt?.(obj, prop),
        typeof obj === 'string' && ctx.schema.slotBigintProvenAt?.(obj, prop))
    }
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
        const isWasi = !ctx.transform.targetProfile.envImports
        // `fromOptional` (a `?.prop` read) short-circuits on nullish, so its
        // PTR.EXTERNAL arm is dead unless host externals are already in play —
        // don't force the __ext_prop import just for an optional read.
        if (!isWasi && !fromOptional) setLinkDemand('external')
        const slow = () => isWasi ? emitDynGetExprTyped(va, key, vt, prop) : emitDynGetAnyTyped(va, key, vt, prop)
        // Monomorphic schema-slot devirtualization (see emitSchemaSlotGuarded):
        // `prop` uniquely identifies one registered schema program-wide, so
        // guard on it instead of always paying the full dynamic dispatch
        // (durable-receiver check + ihash probe + schema-table scan).
        const guard = ctx.func._schemaSpecSlow ? null : ctx.schema.guardedSlotOf(prop)
        return guard ? emitSchemaSlotGuarded(va, guard, slow, prop) : slow()
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
  // Can `.length` on an unproven receiver resolve to an ORDINARY own property?
  // Only when the program can hold one: a registered object schema, or the
  // dyn-prop/hash machinery. Otherwise the fallback arm stays plain undefined
  // and __length pulls no dyn dispatcher. The dispatcher lives in
  // module/collection.js — gate on its registration too, so a build whose
  // autoload never pulled that module keeps the lean arm instead of
  // requesting an unregistered stdlib. Consulted at pull time (factory +
  // deps thunk), when schemas, includes, and module set are final — same
  // pattern as the old HASH-arm includes probe.
  const lengthNeedsDynArm = () =>
    ctx.core.stdlib['__dyn_get_expr_t_h'] != null &&
    (ctx.schema?.list?.length > 0 || ctx.core.includes.has('__hash_new') ||
     ctx.core.includes.has('__dyn_set') || ctx.core.includes.has('__hash_set'))

  ctx.core.stdlib['__length'] = () => {
    const types = [PTR.ARRAY]
    if (ctx.linkDemand.typedarray) types.push(PTR.TYPED)
    const eqT = (n) => `(i32.eq (local.get $t) (i32.const ${n}))`
    let disj = eqT(types[0])
    for (let i = 1; i < types.length; i++) disj = `(i32.or ${disj} ${eqT(types[i])})`
    // Everything that is not a string/array/typed reads `length` as an ordinary
    // property: OBJECT schema slot, HASH key, sidecar — or undefined. (Set/Map
    // have NO .length in JS — their count is `.size`; the old HASH/SET/MAP
    // __len arms returned the entry count, which no JS engine does.) The dyn
    // dispatcher guards real-number receivers itself; gated to keep the lean
    // undefined arm in programs that can't hold such a property at all.
    const propArm = lengthNeedsDynArm()
      ? `(f64.reinterpret_i64 (call $__dyn_get_expr_t_h (local.get $v) (i64.const ${LENGTH_SSO_I64}) (local.get $t) (i32.const ${strHashLiteral('length')})))`
      : `(f64.const nan:${UNDEF_NAN})`
    const lenArm = `(block (result f64)
            (local.set $off (i32.wrap_i64 (i64.and (local.get $v) (i64.const ${LAYOUT.OFFSET_MASK}))))
            (if (result f64) ${disj}
              (then
                (if (result f64) (i32.ge_u (local.get $off) (i32.const 8))
                  (then (f64.convert_i32_s (call $__len (local.get $v))))
                  (else (f64.const nan:${UNDEF_NAN}))))
              (else ${propArm})))`
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

    // String-buffer SRoA: `line.length` where `line` dissolved into raw
    // (buf, len) locals (src/compile/emit.js tryConcatBufferDecl) — the total
    // was computed once at construction; no __str_byteLen re-decode.
    if (prop === 'length' && typeof obj === 'string') {
      const bufR = ctx.func.concatBufs?.get(obj)
      if (bufR) return typed(['f64.convert_i32_s', ['local.get', `$${bufR.len}`]], 'f64')
    }

    // Boxed object: delegate .length and .prop to inner value or schema
    if (typeof obj === 'string' && ctx.schema.isBoxed(obj)) {
      if (prop === 'length') {
        const inner = ctx.schema.emitInner(obj)
        return typed(['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', inner]]], 'f64')
      }
      const idx = ctx.schema.slotOf(obj, prop)
      if (idx >= 0) return emitSchemaSlotRead(emit(obj), idx, ctx.schema.slotI32CertainAt?.(obj, prop),
        ctx.schema.slotBigintProvenAt?.(obj, prop))
    }

    if (prop === 'length') {
      // Literal-size fold: `new T(<int literal>)` bindings never resize (JS
      // TypedArrays have no growth op), so a binding whose EVERY def in this
      // fact's scope agreed on a literal ctor size carries an exact, static
      // `.length` — no header load needed at all. ctx.types.typedLen (per-
      // function, analyze.js's makeTypedTracker) / ctx.scope.globalTypedLen
      // (whole-program, infer.js's recordGlobalRep) is the SAME fact
      // typedIdxProven (type.js) already trusts for bounds-check elision — a
      // strictly stronger safety bar than a `.length` VALUE read, so no new
      // proof is needed here, just reuse. Both maps are written by
      // typedStaticLen (src/type.js), which returns null for the `.view` ctor
      // shape (subarray / buffer-offset views) and for computed/ternary
      // sizes — so a view or non-literal receiver never lands in either map,
      // and this arm naturally falls through to the runtime paths below for
      // those. A PARAM receiver (size fixed only at the call site, not
      // visible in the callee's own facts) also has no entry here — it keeps
      // the runtime load too, until/unless a cross-function fact propagates
      // it into one of these two maps.
      if (typeof obj === 'string') {
        const litLen = ctx.types.typedLen?.get(obj) ?? ctx.scope?.globalTypedLen?.get(obj)
        if (litLen != null) return typed(['f64.const', litLen], 'f64')
      }
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
      // structInline Array<S>: the header `len` counts physical 8-byte cells
      // (K per element, ⌈K/2⌉ when packed i32), so the JS array length is
      // `physicalLen / cellsPerElem`.
      const inlSid = inlineArraySid(obj)
      const inlU = inlSid == null ? inlineArrayUnion(obj) : null
      if (inlSid != null || inlU != null) {
        const physLen = ['i32.load', ['i32.sub', ptrOffsetIR(asF64(emit(obj)), VAL.ARRAY), ['i32.const', 8]]]
        // Union arrays are BYTE-STRIDE (stride·4 B/record, header len in
        // physical 8-byte cells): logical = ⌊len·8 / strideB⌋ — exact for
        // every stride ≥ 2 (ceil(n·s/8)·8 < (n+1)·s always holds there).
        if (inlU != null) {
          const strideB = inlU.stride * 4
          return typed(['f64.convert_i32_s',
            ['i32.div_s', ['i32.shl', physLen, ['i32.const', 3]], ['i32.const', strideB]]], 'f64')
        }
        const cpe = structInline(ctx.schema.list[inlSid].length, ctx.schema.inlineCellI32?.has(inlSid)).cpe
        return typed(['f64.convert_i32_s', cpe > 1 ? ['i32.div_s', physLen, ['i32.const', cpe]] : physLen], 'f64')
      }
      const rep = typeof obj === 'string' ? repOf(obj) : null
      const vt = rep ? rep.val : valTypeOf(obj)
      // Proven OBJECT/HASH receiver: `.length` is an ordinary own property
      // (schema slot / hash key), never a builtin length — resolve statically
      // instead of paying __length's runtime dispatch.
      if (vt === VAL.OBJECT || vt === VAL.HASH) return emitPropAccess(emit(obj), obj, 'length')
      const notString = vt == null && typeof obj === 'string' && lookupNotString(obj)
      // audit-#10: only a genuinely mayBeUndefined receiver pays for the
      // nullish-receiver guard (see emitLengthAccess's own comment) — a
      // plain kind-unresolved-but-never-null receiver (e.g. a polymorphic
      // ARRAY/TYPED parameter) is unaffected.
      const mayBeUndef = vt == null && censusMaybeUndefined(obj)
      // jsstring carrier: keep the externref-typed IR so emitLengthAccess can
      // dispatch to `wasm:js-string.length` instead of forcing through f64.
      const recv = emit(obj)
      if (recv?.type === 'externref') return emitLengthAccess(recv, vt, notString, mayBeUndef)
      return emitLengthAccess(asF64(recv), vt, notString, mayBeUndef)
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
    // A PROVEN OBJECT/HASH receiver never has builtin accessors in JS — its
    // `.size`/`.byteLength` are ordinary own properties, so skip the getter and
    // fall through to the real property read below.
    const propKey = `.${prop}`
    const propEmitter = ctx.core.emit[propKey]
    if (propEmitter && ctx.core.getters.has(propKey) &&
        ptVt !== VAL.OBJECT && ptVt !== VAL.HASH) return propEmitter(obj)

    return emitPropAccess(emit(obj), obj, prop)
  }

  // Optional-chain short-circuit: store the receiver/callee into temp `$t`
  // once, evaluate `thenIR` when it is non-nullish, else yield `undefined`.
  // local.set + local.get (never a local.tee feeding the guard) because
  // notNullish inlines an isNullish check — (i32.or (i64.eq X NULL)
  // (i64.eq X UNDEF)) — that duplicates its operand, so a tee'd
  // side-effecting value would run twice.
  // asF64 on the taken arm: the dispatched access may come back i32-narrowed
  // (an int-certain slot read at O0 keeps its raw i32), and the f64-typed if
  // fails validation ("type error in fallthru: expected f64, got i32").
  const optionalGuard = (t, va, thenIR) =>
    typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, va],
      ['if', ['result', 'f64'],
        notNullish(typed(['local.get', `$${t}`], 'f64')),
        ['then', asF64(thenIR)],
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
    // Transient seed on the fresh `?.[]` hoist-temp (slice 3c-a): the temp
    // lives one expression — its kind goes on the OVERLAY (tier #2, torn
    // down with scope), not on durable reps. enterFunc/buildStartFn
    // guarantee the overlay exists for all emission.
    const srcType = typeof arr === 'string' ? repOf(arr)?.val : null
    if (srcType) ctx.func.localValTypesOverlay.set(t, srcType)
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
          // Transient seed on the fresh `?.()` recv-temp (slice 3c-a, see ?.[]).
          const vt = typeof recv === 'string' ? repOf(recv)?.val : valTypeOf(recv)
          if (vt) ctx.func.localValTypesOverlay.set(t, vt)
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
      // 'bigint': CARRIER PROGRAM Slice 3 (.work/carrier-representation-design.md
      // §7, layout-kinds.js registry's 'typeof' finding) — a boxed BigInt the
      // static analysis can't prove (the ONLY way $__typeof's dynamic dispatch
      // below ever sees a PTR.BIGINT tag; a proven-BIGINT operand statically
      // folds to the literal above and never reaches here).
      ctx.runtime.typeofStrs = ['number', 'undefined', 'string', 'function', 'symbol', 'object', 'boolean', 'bigint']
      for (const s of ctx.runtime.typeofStrs)
        declGlobal(`__tof_${s}`, 'f64')
    }
    inc('__typeof')
    // Receiver type unknown; enable branches that wouldn't otherwise be reachable.
    setLinkDemand('closure')
    // Ambiguous BOOL-merge operand (.work/todo.md §deletion-sweep):
    // valTypeOf(a) reads NUMBER here (the merge's benign coercion), so the
    // VAL.BOOL fold above correctly stays silent — but plain `emit(a)` still
    // collapses the merge's own BOOL arm to a raw 0/1 bit (the '?:'/'&&' handlers'
    // deliberate BOOL∪NUMBER-stays-raw rule), which $__typeof's dynamic dispatch
    // then reads as "number" even on the branch that's really `false`/`true`.
    // emitIdentitySafe re-emits the merge with that arm boxed to its atom first.
    const av = hasAmbiguousBoolMerge(a) ? emitIdentitySafe(a) : emit(a)
    return typed(['call', '$__typeof', asI64(av)], 'f64')
  }

  ctx.core.stdlib['__typeof'] = () => {
    const stringTest = `(i32.eq (local.get $t) (i32.const ${PTR.STRING}))`
    const closureArm = ctx.linkDemand.closure
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
    ;; CARRIER PROGRAM Slice 3 — registry-derived 'typeof' arm (layout-kinds.js
    ;; KIND_REGISTRY.BIGINT / FINDINGS[typeof]): a dynamically-boxed BigInt this
    ;; dispatch reaches (static PROVEN-bigint operands fold to the literal above
    ;; and never reach this dynamic dispatch at all) reports "bigint", not the
    ;; "object" default every other unrecognized-shape pointer falls to.
    (if (i32.eq (local.get $t) (i32.const ${PTR.BIGINT}))
      (then (return (global.get $__tof_bigint))))
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

  // CARRIER PROGRAM Slice 1 (.work/carrier-representation-design.md §7) unit-
  // level pins: __box_bigint/__unbox_bigint expose ir.js's boxBigInt/
  // unboxBigInt the same way __mkptr/__ptr_type/__ptr_offset above expose
  // their own ir.js primitives — callable ONLY when a test's jz source
  // literally names them, so ordinary program compiles (including the
  // self-hosted kernel, which never references these names) never reach this
  // code and stay byte-identical. `v` is a real jz value (any kind whose raw
  // f64 bits are the payload to box); `p` is a previously-boxed pointer.
  ctx.core.emit['__box_bigint'] = (v) => (inc('__alloc', '__mkptr'), boxBigInt(asI64(emit(v))))
  ctx.core.emit['__unbox_bigint'] = (p) => (inc('__ptr_offset'), typed(['f64.reinterpret_i64', unboxBigInt(asF64(emit(p)))], 'f64'))

  // Region-arena Slice 1 intrinsics (see the stdlib definitions above for the
  // full design) — callable ONLY from scripts/self.js (the self-host kernel
  // entry, never executed as native JS, only ever compiled), which threads them
  // into watr's optional per-round hooks via src/optimize/watr-tail.js's
  // `regionHooks`. `__region_mark` takes no args; `__region_exit` takes
  // (mark, root) and returns the possibly-relocated root — both raw f64 in,
  // f64 out, matching watr's own untyped AST-node value shape.
  ctx.core.emit['__region_mark'] = () => (inc('__region_mark'), typed(['call', '$__region_mark'], 'f64'))
  ctx.core.emit['__region_exit'] = (mark, root) => (inc('__region_exit'), typed(['call', '$__region_exit', asF64(emit(mark)), asF64(emit(root))], 'f64'))

  // Object-literal AST shape with NO 'toString'/'valueOf' key: a DEFINITIVE
  // (not merely unproven) empty OrdinaryToPrimitive method chain — a spread
  // makes the key set open (an unknown source might carry either at runtime),
  // so a spread-bearing literal is conservatively NOT closed.
  const isClosedObjLiteralNoStringMethod = (node) => {
    if (!Array.isArray(node) || node[0] !== '{}') return false
    const items = node.length === 2 && Array.isArray(node[1]) && node[1][0] === ','
      ? node[1].slice(1) : node.slice(1)
    for (const p of items) {
      if (Array.isArray(p) && p[0] === '...') return false
      const key = Array.isArray(p) && p[0] === ':' ? p[1] : (typeof p === 'string' ? p : null)
      if (key === 'toString' || key === 'valueOf') return false
    }
    return true
  }

  // Same "closed OrdinaryToPrimitive chain" fact as above, generalized from
  // "AST is literally a `{}` node" to "a bound name whose OWN declaration
  // schema is closed" (.work/todo.md §deletion-sweep finding-2: `let o = {}; new
  // Error(o).message` fell through the literal-only check to toStrI64's
  // generic OBJECT path, which — unlike the Error-schema arm right above it
  // — has no case for a plain user OBJECT and mis-renders it, a pre-existing,
  // documented, out-of-scope bug (§Consequence: `${anyDynamicObject}` → "").
  // Fixed the SAME way Finding 1 fixed Object.assign's target-provenance gap:
  // extend the literal-AST fact to the schema-BINDING fact a `let`/`const`
  // already carries, instead of touching the shared toStrI64 primitive.
  // Closed-world requires the schema to be the COMPLETE key set — a HASH-kind
  // binding, one with a computed write (`ctx.types.dynKeyVars`), or an
  // out-of-schema literal write (`ctx.types.literalWriteKeys`) could carry a
  // 'toString'/'valueOf' key the static schema doesn't list — those fall
  // through to the generic (still broken, still out-of-scope) toStrI64
  // OBJECT path unchanged.
  //
  // Gate on the SCHEMA ID directly (`ctx.schema.idOf`), not `valTypeOf(node)
  // === VAL.OBJECT` (audit-#11): the two are usually redundant, but a truly
  // EMPTY `let o = {}` is the one binding shape where they can come apart —
  // `ctx.schema.vars`/`idOf` (bound by prepare for a non-empty literal;
  // by src/compile/analyze.js's dict-aware decl scan for an empty `{}` —
  // see that file for why prepare itself can't safely bind that case) is a
  // durable, single-writer fact, while `.val` for this exact shape is ALSO
  // written by a second, independent, non-schema-aware body-fact pass
  // (compile/index.js's `bodyFacts.valTypes` loop) that can race/disagree and
  // poison-clear the field — observed live: `.val` read back `null` for a
  // provably-empty, provably-closed `o` despite the schema resolving fine.
  // `idOf` alone is exactly the fact this function needs (a real, closed,
  // non-Error prop list) and carries none of that fragility. Excluding an
  // Error-class sid is still required: `new Error(new TypeError('x')).message`
  // must NOT take this shortcut — that value needs Error.prototype.toString's
  // real "name: message" format (toStrI64's own Error-schema arm), not the
  // literal string '[object Object]'.
  const isClosedObjNoStringMethod = (node) => {
    if (isClosedObjLiteralNoStringMethod(node)) return true
    if (typeof node !== 'string') return false
    const sid = ctx.schema.idOf?.(node)
    if (sid == null || ctx.schema.isErrorSid?.(sid)) return false
    const schema = ctx.schema.list[sid]
    if (!schema || schema.includes('toString') || schema.includes('valueOf')) return false
    if (ctx.types.dynKeyVars?.has(node)) return false
    const w = ctx.types.literalWriteKeys?.get(node)
    if (w) for (const k of w) if (!schema.includes(k)) return false
    return true
  }

  // Error constructor message coercion — ES 20.5.1.1: argument absent OR its
  // VALUE is `undefined` → '' ; otherwise ToString(message). Routes through
  // toStrI64 (the same chokepoint String()/template literals use) for every
  // kind it already proves correctly (STRING identity, NUMBER, our own
  // Error-schema arm, the generic __to_str dispatch for atoms it special-
  // cases — NULL_NAN/UNDEF_NAN/TRUE_NAN/FALSE_NAN all format correctly
  // PROVIDED the operand reaches it already boxed). Two gaps toStrI64 does
  // NOT close by itself, both fixed here at the call site — matching every
  // other direct toStrI64 caller's own established convention (module/
  // string.js's per-leaf template formatter, src/compile/emit.js's `+`-concat
  // strOperand at ~4796-4797), not a toStrI64-internal change:
  //   (1) BOOL: jz keeps a statically-proven boolean in the cheap unboxed 0/1
  //       carrier for arithmetic. Handing that raw i32 straight to toStrI64
  //       hits its i32-provable-NUMBER fast path and stringifies the CARRIER
  //       ("0"/"1"), not the boolean (audit-#9 P1: `new Error(false).message`
  //       read "0"). Box through the same true/false select every other BOOL-
  //       aware caller already uses instead.
  //   (2) A message that's PROVABLY a plain object literal with no toString/
  //       valueOf (e.g. `new Error({})`) has a closed, empty method chain —
  //       toStrI64's generic OBJECT arm can't make that closed-world claim
  //       for an arbitrary (possibly dynamic) receiver, so it falls through
  //       to __to_str's raw-pointer-bits fallback (.work/todo.md §deletion-sweep's
  //       "Consequence" section, a PRE-EXISTING gap for any dynamic object,
  //       left as-is). The literal shape alone is enough to prove it here.
  //   (3) audit-#11: a genuinely DYNAMIC dict (VAL.HASH — JSON.parse, a
  //       computed-key-grown object; no fixed schema EVER exists for this
  //       kind, so isClosedObjNoStringMethod's schema lookup can never prove
  //       it either way) fell through to the same broken __to_str raw-bits
  //       fallback as (2) — worse, decoded as garbage at the host boundary
  //       (observed: a bogus BigInt), not even a wrong-looking object. A HASH
  //       is schema-less BY CONSTRUCTION: no closed-world proof is possible,
  //       ever, for whether it carries a runtime 'toString'/'valueOf' key
  //       (unlike (2), where non-closedness is merely unproven, not
  //       unprovable). Approximating "unprovable" as "absent" here — same
  //       discipline isClosedObjNoStringMethod itself already applies to
  //       every OTHER uncertain case — trades perfect ES fidelity (the rare
  //       dict that legitimately carries a runtime toString/valueOf) for a
  //       real string on the overwhelmingly common plain-data-dict case,
  //       strictly better than today's guaranteed-wrong fallback either way.
  const errorMessageIR = (msg) => {
    if (msg == null) return asF64(emit(['str', '']))
    const vt = valTypeOf(msg)
    if (vt === VAL.BOOL)
      return typed(['select', asF64(emit(['str', 'true'])), asF64(emit(['str', 'false'])), truthyIR(emit(msg))], 'f64')
    if (isClosedObjNoStringMethod(msg) || vt === VAL.HASH) return asF64(emit(['str', '[object Object]']))
    const boxed = asF64(emit(msg))
    // isUndef folds to a compile-time constant for any statically-provable
    // operand (a literal, or anything else valTypeOf/matchF64Bits can already
    // fold) — the common `new Error("literal")`/`new Error(x)` (x provably a
    // string/number) case pays no runtime branch. Only a genuinely dynamic
    // operand that MIGHT be undefined at runtime gets the block+local+if.
    const probe = isUndef(boxed)
    if (Array.isArray(probe) && probe[0] === 'i32.const')
      return probe[1] ? asF64(emit(['str', ''])) : typed(['f64.reinterpret_i64', toStrI64(msg, boxed)], 'f64')
    const mt = temp('emsgv')
    const mtGet = () => typed(['local.get', `$${mt}`], 'f64')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${mt}`, boxed],
      ['if', ['result', 'f64'], isUndef(mtGet()),
        ['then', asF64(emit(['str', '']))],
        ['else', ['f64.reinterpret_i64', toStrI64(msg, mtGet())]]]], 'f64')
  }

  // Error(msg)/new Error(msg) — a real PTR.OBJECT, schema ['message','name']
  // (audit-#9 P0-2 brand redesign, .work/todo.md §deletion-sweep §1). Class identity
  // lives in the SCHEMA ID (module/schema.js's ctx.schema.errorSid — one
  // DISTINCT id per class, minted with the class name as an internal dedupe
  // salt that never becomes a property), not in any slot: no hidden marker to
  // filter out of enumeration/dyn-dispatch/JSON, nothing to un-spell — the two
  // slots this object carries are the two ordinary, fully public properties a
  // real Error has. Construction reuses the exact runtime object-literal path
  // (module/object.js: $__alloc_hdr + one store per slot + mkPtrIR) — no new
  // allocation primitive, no new heap pointer tag. Reachability-gated like
  // every stdlib emitter: minting the schema and emitting this block only
  // happens when a program actually calls one of these 7 ctors, so an
  // Error-free module pays nothing.
  const buildErrorObject = (className, msg) => {
    inc('__alloc_hdr')
    const sid = ctx.schema.errorSid(className)
    const t = tempI32('errp')
    const nameIR = asF64(emit(['str', className]))
    const msgIR = errorMessageIR(msg)
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(2)]]],
      ctx.abi.object.ops.store(['local.get', `$${t}`], 0, msgIR),
      ctx.abi.object.ops.store(['local.get', `$${t}`], 1, nameIR),
      mkPtrIR(PTR.OBJECT, sid, ['local.get', `$${t}`])], 'f64')
  }
  // `new Error(x)`/`Error(x)` (with or without `new`) both route here: Error is
  // absent from includeForRuntimeCtor (src/autoload.js), so prepare's `new`
  // handler falls to the generic "unknown ctor → plain call" path — the same
  // ctx.core.emit['Error'] key a bare call resolves to. Correct per spec:
  // `Error(x)` without `new` also constructs a fresh Error.
  for (const cls of ERR_CLASS_NAMES) ctx.core.emit[cls] = (msg) => buildErrorObject(cls, msg)
}
