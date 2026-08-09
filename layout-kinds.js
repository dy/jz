/**
 * Heap-kind registry — COMPACT EXECUTABLE metadata only (audit-#16 registry
 * finding, .work/research.md §Heap-kind registry Slice 4: production dist
 * cost fix). This is the per-tag authority every consumer of a NaN-boxed
 * value's KIND derives from — the composition point for carrier boxing ×
 * region relocation. What's here is exactly what production READS: enums,
 * numbers, short symbolic strings, no prose.
 *
 * PRODUCTION-CONSUMED: module/core.js's $__eq and module/collection.js's
 * $__same_value_zero/$__map_hash import eqIdentityChain/
 * sameValueZeroIdentityChain/mapHashStringArm/mapHashBigintArm below —
 * every byte here ships in dist/jz.js. Slice 3 (2026-08-08) put this table
 * on that path; Slice 4 (this split) is the fix for what Slice 3's own
 * landing measured: the ORIGINAL single-file registry carried full per-kind
 * prose (allocShape, childPointers, forwarding, interopDecode, typeofArm
 * descriptions, cross-consumer findings writeups) in the SAME object the
 * generators iterate, and esbuild's minifier only strips JS comments —
 * string-literal PROPERTY VALUES survive verbatim, so that prose rode into
 * dist/jz.js (+19,613B) and, transitively through the generated WAT text
 * size, dist/jz.wasm (+60,511B). The prose itself, plus the FINDINGS array,
 * now lives in layout-kinds-doc.js, which imports and EXTENDS this table —
 * nothing here is duplicated there. See that file's header for the doc-side
 * rationale and test/layout-kinds.js for the shadow checks (import both).
 *
 * LEAF MODULE — imports only layout.js (the err-codes.js pattern: safe for
 * `jz/interop` and tests without pulling the compiler).
 */
import { PTR, LAYOUT, ATOM, STR_INTERN_BIT } from './layout.js'

/**
 * @typedef {Object} KindEntry
 * @property {number|null} tag PTR.* (layout.js) or null for the two tagless kinds (NUMBER, and ATOM
 *                              sub-rows share PTR.ATOM=0 with a distinguishing `aux`).
 * @property {number|string|null} aux Short aux-semantics symbol: a reserved constant (0, ATOM.*), or a
 *                              short tag naming what the aux bits carry (e.g. 'schemaId'). Full prose is
 *                              layout-kinds-doc.js's `auxNote`.
 * @property {'value'|'content'|'pointer-bits'|'exact-bits'} identity Identity-arm family this kind's
 *                              ==/===/Set-Map keying belongs to. Full prose is doc's `identityNote`.
 * @property {{kind:'content', order:number}} [identityArm] STRING/BIGINT only — `order` fixes this
 *                              kind's position in the generated content-identity dispatch chain below
 *                              (checked in ascending order; the tags are mutually exclusive so this is a
 *                              byte-match constraint on generated text, not a soundness one).
 */

/** @type {Record<string, KindEntry>} */
export const KIND_REGISTRY = {
  NUMBER: { tag: null, aux: null, identity: 'value' },
  STRING: { tag: PTR.STRING, aux: null, identity: 'content', identityArm: { kind: 'content', order: 1 } },
  ARRAY: { tag: PTR.ARRAY, aux: null, identity: 'pointer-bits' },
  OBJECT: { tag: PTR.OBJECT, aux: 'schemaId', identity: 'pointer-bits' },
  HASH: { tag: PTR.HASH, aux: 0, identity: 'pointer-bits' },
  SET: { tag: PTR.SET, aux: 0, identity: 'pointer-bits' },
  MAP: { tag: PTR.MAP, aux: 0, identity: 'pointer-bits' },
  TYPED: { tag: PTR.TYPED, aux: 'elemTypeCode', identity: 'pointer-bits' },
  BUFFER: { tag: PTR.BUFFER, aux: 0, identity: 'pointer-bits' },
  CLOSURE: { tag: PTR.CLOSURE, aux: 'fnTableIndex', identity: 'pointer-bits' },
  EXTERNAL: { tag: PTR.EXTERNAL, aux: 'reserved', identity: 'pointer-bits' },
  BIGINT: { tag: PTR.BIGINT, aux: 0, identity: 'content', identityArm: { kind: 'content', order: 0 } },
  'ATOM.NULL': { tag: PTR.ATOM, aux: ATOM.NULL, identity: 'exact-bits' },
  'ATOM.UNDEFINED': { tag: PTR.ATOM, aux: ATOM.UNDEF, identity: 'exact-bits' },
  'ATOM.BOOLEAN': { tag: PTR.ATOM, aux: `${ATOM.FALSE}|${ATOM.TRUE}`, identity: 'exact-bits' },
  'ATOM.SYMBOL': { tag: PTR.ATOM, aux: 'symbolId', identity: 'exact-bits' },
}

// ============================================================================
// Identity-dispatch arm generation (Heap-kind registry Slice 3, .work/
// research.md §Heap-kind registry — "3 $__eq/$__map_hash arms generated").
// module/core.js's $__eq and module/collection.js's $__same_value_zero/
// $__map_hash each hand-roll a tag-dispatch chain that special-cases the
// CONTENT-identity kinds — every other kind needs no arm at all, relying on
// the caller's own bit-equality fast path (pointer-bits identity IS bit
// equality). Which kinds get an arm, and in what order, is data: the
// `identityArm` column on KIND_REGISTRY.STRING/BIGINT above (every other
// row has no identityArm, so none is seeded).
//
// NOT a single generic WAT-synthesis template: $__eq and $__same_value_zero
// realize the SAME STRING content-identity fact with two real textual
// differences (a per-operand NaN re-guard, an interned-vs-interned short-
// circuit — both present in $__eq, absent in $__same_value_zero). Forcing
// them identical would be a BEHAVIOR change, which this table's mandate
// forbids ("moves the source of truth, not the behavior") — so each
// consumer keeps its own generator function below, hand-authored and
// guarded (assertContentOrder) rather than synthesized from a shared
// template, and the divergence is named in layout-kinds-doc.js's FINDINGS
// (identity-arm-divergence) instead of silently unified. A genuinely
// table-driven synthesis (loop over CONTENT_IDENTITY_ORDER, emit each arm's
// text from a per-kind template) was evaluated for this split and rejected:
// with only two content-identity kinds and two textually-DIFFERENT STRING
// arms across consumers, any shared-template rewrite changes the generated
// WAT text by construction — byte-identity with the pre-split generated
// output wins over a marginal iteration-count reduction from 2 to "a loop
// of 2".
// ============================================================================

export const CONTENT_IDENTITY_ORDER = Object.keys(KIND_REGISTRY)
  .filter(k => KIND_REGISTRY[k].identityArm?.kind === 'content')
  .sort((a, b) => KIND_REGISTRY[a].identityArm.order - KIND_REGISTRY[b].identityArm.order)

// Every generator below hand-encodes CONTENT_IDENTITY_ORDER === ['BIGINT', 'STRING']
// in its own nesting (BIGINT checked first) — this assert fires closed instead of
// silently drifting if the registry's content-identity kind set or order ever
// changes without the generator text being revisited.
const assertContentOrder = (fnName) => {
  if (CONTENT_IDENTITY_ORDER.length !== 2 || CONTENT_IDENTITY_ORDER[0] !== 'BIGINT' || CONTENT_IDENTITY_ORDER[1] !== 'STRING')
    throw new Error(`${fnName}: KIND_REGISTRY's content-identity kinds changed (${CONTENT_IDENTITY_ORDER.join(',')}) — this hand-authored arm text needs updating to match`)
}

/** $__eq's (module/core.js) content-identity tag-dispatch chain, spliced in right
 *  after $ta/$tb are extracted: BIGINT payload compare, else STRING (guarded
 *  per-operand against a non-NaN false-tag alias, with an interned-vs-interned
 *  short-circuit), else unequal. Verbatim source of truth for that span — see
 *  test/layout-kinds.js's byte-identity proof. */
export function eqIdentityChain() {
  assertContentOrder('eqIdentityChain')
  return `(if (result i32)
              (i32.and (i32.eq (local.get $ta) (i32.const ${PTR.BIGINT})) (i32.eq (local.get $tb) (i32.const ${PTR.BIGINT})))
              (then (i64.eq
                (i64.load (call $__ptr_offset (local.get $a)))
                (i64.load (call $__ptr_offset (local.get $b)))))
              (else
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
              (else (i32.const 0)))))`
}

/** $__same_value_zero's (module/collection.js) content-identity chain — same
 *  BIGINT arm as eqIdentityChain (byte-identical text), but a SIMPLER STRING
 *  arm: see layout-kinds-doc.js's FINDINGS[identity-arm-divergence]. */
export function sameValueZeroIdentityChain() {
  assertContentOrder('sameValueZeroIdentityChain')
  return `(if (result i32)
              (i32.and (i32.eq (local.get $ta) (i32.const ${PTR.BIGINT})) (i32.eq (local.get $tb) (i32.const ${PTR.BIGINT})))
              (then (i64.eq
                (i64.load (call $__ptr_offset (local.get $a)))
                (i64.load (call $__ptr_offset (local.get $b)))))
              (else
            (if (result i32)
              (i32.and
                (i32.eq (local.get $ta) (i32.const ${PTR.STRING}))
                (i32.eq (local.get $tb) (i32.const ${PTR.STRING})))
              (then (call $__str_eq (local.get $a) (local.get $b)))
              (else (i32.const 0)))))`
}

/** $__map_hash's STRING content-identity arm — an early-return statement
 *  (map_hash's shape is sequential guards, not a nested chain), hashes via
 *  __str_hash. */
export function mapHashStringArm() {
  return `(if (i32.and (f64.ne (local.get $f) (local.get $f))
          (i32.eq (local.get $t) (i32.const ${PTR.STRING})))
      (then (return (call $__str_hash (local.get $v)))))`
}

/** $__map_hash's BIGINT content-identity arm — hashes the payload cell via
 *  __hash, folding away the two reserved sentinel buckets (0/1). */
export function mapHashBigintArm() {
  return `(if (i32.and (f64.ne (local.get $f) (local.get $f))
          (i32.eq (local.get $t) (i32.const ${PTR.BIGINT})))
      (then (local.set $h (call $__hash (i64.load (call $__ptr_offset (local.get $v)))))
        (return (if (result i32) (i32.le_s (local.get $h) (i32.const 1))
          (then (i32.add (local.get $h) (i32.const 2)))
          (else (local.get $h))))))`
}
