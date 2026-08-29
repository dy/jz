/**
 * BigInt carrier boxing — the phase-C representation campaign's box/unbox
 * pairing family (.work/phase-c-unification.md). PTR.BIGINT (layout.js, tag 5)
 * is the representation for an unprovable BigInt flow: an 8-byte cell holding
 * the raw i64 payload, NaN-boxed like every other heap kind. Moved verbatim —
 * same relative order, same conditional structure, same doc comments — this is
 * the file .work/phase-c-unification.md names as load-bearing (readI64's
 * maybeUnboxBigInt-vs-unboxBigInt dispatch, the i64Hex hazard notes elsewhere
 * in ir/pointers.js). No logic touched.
 *
 * @module ir/bigint
 */

import { ctx, err, inc, PTR } from '../ctx.js'
import { VAL } from '../reps.js'
import { valTypeOf } from '../kind.js'
import { BIGINT_REP_BOXED, BIGINT_REP_CLOSED, REP_EDGE_BOX, REP_EDGE_UNBOX, representationActiveMaterializedRep } from '../compile/representation-plan.js'
import { typed } from './tag.js'
import { temp, tempI32, blockTyped } from './locals.js'
import { mkPtrIR, ptrOffsetIR } from './pointers.js'
import { asF64, asI64, fromI64 } from './numeric.js'

// === BigInt carrier boxing (.work/carrier-representation-design.md) —
// PTR.BIGINT (layout.js, tag 5) is THE representation for an unprovable
// BigInt flow: an 8-byte cell holding the raw i64 payload, NaN-boxed the
// same way every other heap kind (STRING/OBJECT/…) is. Boxing is
// unconditional (the CARRIER_BOX flag and its JZ_CARRIER_BOX toggle were
// deleted once the boxed arm became the ratified default — genuine
// Number|BigInt unions in real programs make it the lawful semantics, not
// an interim). INVARIANT: any change here must keep "any input program
// legitimately reaching boxing compiles by DEFAULT" (5 banked unprovable
// sites: layout.js's i64Hex bits param, 4 in the watr npm dependency, plus
// subscript's BigInt literal parser via jessie).
//
// The fail-fast diagnostic below is OPT-IN, live-read via
// `JZ_BIGINT_STRICT=1` — for an inference session verifying residual
// unprovable sites are gone; scope it around exactly the compile() call
// that needs it.
export const bigintStrict = () => typeof process !== 'undefined' && process.env?.JZ_BIGINT_STRICT === '1'

/** Strict-mode diagnostic for a RepresentationPlan edge that cannot stay
 *  raw. `kind` names the edge class and `who` its binding or expression. */
export function bigintEraseErr(kind, who) {
  err(`BigInt value at this ${kind} can't be proven a single, uniform kind (${who}) — give it one statically-provable BigInt path for its whole lifetime (arithmetic/comparison between two BigInt operands, a BigInt64Array/BigUint64Array element, or BigInt()/Number() conversion of a provably-typed source) instead of letting it cross through a dynamically-kinded slot.`)
}

/** Materialize a boxed BigInt: alloc an 8-byte cell, store the raw i64
 *  payload, return the NaN-boxed PTR.BIGINT pointer (f64). `i64IR` must
 *  already be the raw i64 bits (asI64'd) — this function only allocates +
 *  stores + tags, the same division of labor as boolBoxIR/allocPtr (callers
 *  own extracting the payload). Retired as a live consequence by Slice 1
 *  (bigintEraseErr above, ir.js's own carrierF64/carrierF64Narrow, emit.js's
 *  coerceArg/return/ternary sites) — kept as a function because
 *  test/pointers.js's __box_bigint/__unbox_bigint test-only intrinsics
 *  (module/core.js) call it directly, unconditionally, bypassing the
 *  fixpoint entirely; not part of THIS slice's deletion surface (Slice 2/3). */
export function boxBigInt(i64IR) {
  inc('__alloc')
  const p = tempI32('bbig')
  return blockTyped('f64',
    ['local.set', `$${p}`, ['call', '$__alloc', ['i32.const', 8]]],
    ['i64.store', ['local.get', `$${p}`], i64IR],
    mkPtrIR(PTR.BIGINT, 0, ['local.get', `$${p}`]))
}

/** Recover the raw i64 payload from a boxed BigInt pointer (f64). Safe to
 *  route through the generic forwarding-aware ptrOffsetIR — PTR.BIGINT is
 *  never in FORWARDING_MASK (its cell never grows/relocates), so the chase
 *  is a no-op single load+compare, the same cost every other non-relocating
 *  tag (OBJECT/TYPED/…) already pays there. */
export function unboxBigInt(f64expr) {
  return typed(['i64.load', ptrOffsetIR(f64expr, VAL.BIGINT)], 'i64')
}

/** Apply one frozen RepresentationPlan edge action to a definite BigInt.
 *
 *  UNBOX goes through `maybeUnboxBigInt`, not the unconditional `unboxBigInt`
 *  (range-boundary BOX/UNBOX OOB fix, 2026-08): `action` here is a FIXPOINT
 *  verdict (edgeMaterializable, representation-plan.js), not a runtime fact —
 *  the fixpoint's own doc comments (edgeMaterializable's neighboring
 *  isMaterializedCallProducer/resultForwardsSingleParam slices, Shape #8's
 *  trail) already document that this proof is order-sensitive: a body built
 *  before its callee's own plan has settled can call this with `ir` genuinely
 *  RAW while `action` says UNBOX. `unboxBigInt` trusts its input completely —
 *  `ptrOffsetIR`'s `$__ptr_offset` masks the low 32 bits off WHATEVER i64
 *  it's handed and `i64.load`s there, no tag check, by design (the hot,
 *  every-heap-kind dereference path). A raw BigInt payload's own bits are
 *  exactly as capable of decoding to a garbage address as a corrupted
 *  pointer would be — confirmed live: 0x7fffffffffffffffn / 0xffffffffffffffffn
 *  (i64 max and the 2^64-1 wrapped pattern) both carry 0xFFFFFFFF in their
 *  low 32 bits, so an UNBOX wrongly applied to either (proof says boxed,
 *  runtime value is raw) makes `$__ptr_offset` return an address ~4 GiB out,
 *  and `i64.load` there traps ("memory access out of bounds") in any
 *  realistically-sized instance — not a hypothetical, this is byte-for-byte
 *  what `__unbox_bigint` applied directly to either literal reproduces
 *  (test/pointers.js's own boundary pins, `__box_bigint` first, never hit
 *  this — only a bare, unmatched UNBOX does). Every other BigInt boundary
 *  value in test/pointers.js's own pins (5n, -5n, 0n, i64 min, …) has small
 *  low-32 bits and merely reads/traps-silently-into adjacent heap garbage
 *  instead of a hard trap — same corruption, quieter failure mode, not
 *  safer.
 *
 *  `maybeUnboxBigInt` (already the established answer for every OTHER
 *  not-fully-closed BigInt read in this file/emit.js — readI64's schema-slot
 *  arm, bigIntOperand/bigIntUnary's CONSERVATIVE PAIRING) tags-checks via
 *  `$__ptr_type` first and only dereferences a genuine PTR.BIGINT; a
 *  mis-proven raw value takes the `else` (bits-are-already-the-payload)
 *  branch instead of dereferencing — no trap, and the CORRECT value once the
 *  proof is eventually right elsewhere. One extra `$__ptr_type` call
 *  (an i64 shift+and, already the cheapest primitive in this file) on every
 *  plan-directed UNBOX; BOX is unaffected (a box-side mis-proof double-boxes
 *  a garbage payload — a silent wrong-value bug already tracked separately,
 *  e.g. test/data.js's `.member`-call KNOWN-WRONG pin — never a dereference,
 *  so it cannot trap and is out of this fix's scope). */

// valTypeOf (kind.js) now resolves a `.`-member callee through the frozen
// call-target index (the same one representationActiveMaterializedRep's own
// `()` branch, above, and representation-plan.js's calleeNameOf/
// resolveMemberCallee already consult) — a `.`-member call proves exactly
// as BIGINT here as the equivalent bare-name call always did, so this gate
// needs no separate `.`-member admission path. (An earlier version of this
// fix re-derived the answer from representationActiveMaterializedRep's own
// CARRIER verdict — REP_EDGE_BOX/UNBOX-shaped, call-site-insensitive — as a
// stand-in for "is this proven BigInt"; that mismatched abstraction (a
// carrier-choice fact used as a semantic-kind proof) is what regressed
// watr's float_memory family, see .work/member-callee-binding-write-notes.md.
// valTypeOf asks the plain semantic question directly and needs no proxy.)
export function applyBigintRepresentationAction(ir, node, action) {
  if (valTypeOf(node) !== VAL.BIGINT) return ir
  if (action === REP_EDGE_BOX) return boxBigInt(asI64(ir))
  if (action === REP_EDGE_UNBOX) return fromI64(maybeUnboxBigInt(asF64(ir)))
  return ir
}

/** Runtime twin of unboxBigInt for a value with no STATIC boxed-or-raw proof
 *  either way (CONSERVATIVE PAIRING — coordinator ruling, see
 *  .work/context-sensitivity-survey.md): tag-checks
 *  the value at runtime via `$__ptr_type` (the same primitive every
 *  registry-aware dynamic reader — $__dyn_get/$__typeof/$__to_num/$__eq's
 *  own PTR.BIGINT arms — already dispatches on) and unboxes through
 *  unboxBigInt's own ptrOffsetIR deref when it IS a real box; otherwise the
 *  f64 bit pattern already IS the raw payload (this slot's write side never
 *  boxes a NUMBER-typed store — module/object.js's storedValue/
 *  storedValueNarrow split — so a non-boxed instance needs no decoding, only
 *  reinterpreting). One memory read either way (`f64expr` teed once, reused
 *  for the tag check and both arms) — cost lands only on the caller's own
 *  choice to invoke this, never on a proven-BIGINT or proven-not-BIGINT
 *  read. Returns i64, matching unboxBigInt's own convention. */
export function maybeUnboxBigInt(f64expr) {
  const t = temp('mbig')
  inc('__ptr_type')
  return typed(['if', ['result', 'i64'],
    ['i32.eq',
      ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.tee', `$${t}`, f64expr]]],
      ['i32.const', PTR.BIGINT]],
    ['then', unboxBigInt(['local.get', `$${t}`])],
    ['else', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]], 'i64')
}

/** True iff `node` is a `.prop` read (bare-name receiver only — the same
 *  "structural fallback gets false" scope module/core.js emitSchemaSlotRead's
 *  own doc comment establishes for a chain receiver) of a
 *  schema slot the write-side census observed BIGINT on AND boxes wide
 *  (ctx.schema.slotBigintBoxedAt), but cannot PROVE uniformly BIGINT
 *  (ctx.schema.slotBigintProvenAt — `slotHazarded`'s `pointsTo==='ALL'`
 *  blanket is genuinely load-bearing, not narrowable). INVARIANT: this
 *  read-side gap must stay closed — `readI64`'s own
 *  `typeof node === 'string'` guard structurally
 *  cannot see a `.`-node operand at all, so an arithmetic-core call site
 *  reading a possible-but-unproven schema field via `LAYOUT.NAN_PREFIX_BITS`-
 *  shaped source falls to the naive `asI64` reinterpret without it —
 *  misreading a real box's own NaN-tag bits as the payload. Deliberately
 *  does NOT touch emitSchemaSlotRead's own return value (module/core.js):
 *  that value must stay box-preserving f64 for every OTHER consumer this
 *  same read reaches (the WASM export boundary's host-side generic decode,
 *  $__eq, $__typeof, $__dyn_get) — all already correctly PTR.BIGINT-aware
 *  at the point THEY dereference. Eagerly unboxing at the
 *  read site itself breaks exactly that class: a
 *  plain `export let f = () => obj.bigField` regresses from a correct
 *  BigInt result to NaN once the read pre-decodes the box — this narrower,
 *  readI64-scoped version is required instead. */
export const isSchemaSlotBigintPossible = (node) =>
  Array.isArray(node) && node[0] === '.' &&
  typeof node[1] === 'string' && typeof node[2] === 'string' &&
  ctx.schema.slotBigintBoxedAt?.(node[1], node[2]) === true &&
  ctx.schema.slotBigintProvenAt?.(node[1], node[2]) !== true

/** Emission-tier fact for a local initialized from a BigInt/nullish ternary.
 *  RepresentationPlan owns general carriers; this retained transient marks
 *  the one local shape whose initializer itself emits the boxed arm. */
export const isTernaryBoxedBigint = (name) => ctx.func.ternaryBoxedNames?.has(name) === true

/** Extract raw i64 bits, unboxing when the plan, ternary-local fact, or
 *  schema-slot census says the emitted value is a PTR.BIGINT box. */
export const isPlanTaggedBigint = node =>
  representationActiveMaterializedRep(ctx, node) === (BIGINT_REP_BOXED | BIGINT_REP_CLOSED)

export function readI64(node, emitted) {
  if (
      ((typeof node === 'string' && isTernaryBoxedBigint(node)) || isPlanTaggedBigint(node)))
    // maybeUnboxBigInt, not unboxBigInt (range-boundary BOX/UNBOX OOB fix,
    // 2026-08 — the same fix already applied to applyBigintRepresentationAction's
    // UNBOX arm above and to emit.js's coerceArg): isPlanTaggedBigint's verdict
    // is representationActiveMaterializedRep's own FIXPOINT proof (edgeMaterializable),
    // not a runtime fact — order-sensitive by the same mechanism those two
    // call sites' doc comments already document, so a body built (or, under
    // self-host, a KERNEL BUILT from source containing an order-hazardous
    // consumer of this same fixpoint elsewhere — traced live, see
    // .work/todo.md's selfhost-fixpoint-divergence entry) before this proof
    // has genuinely settled can reach here with `node` truly RAW while the
    // verdict claims BOXED. unboxBigInt trusts its input completely and
    // dereferences unconditionally; maybeUnboxBigInt tag-checks first and
    // only dereferences a genuine PTR.BIGINT, falling back to the bits-are-
    // already-the-payload reinterpret otherwise — this was the one remaining
    // unguarded isPlanTaggedBigint-consuming call site of the three.
    return maybeUnboxBigInt(emitted)
  if (isSchemaSlotBigintPossible(node)) return maybeUnboxBigInt(emitted)
  return asI64(emitted)
}

// === Nullish sentinels ===
