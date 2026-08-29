/**
 * The f64 NaN-boxed sentinel/boolean value model: reserved-atom construction
 * (null/undefined/false/true), sentinel-bit matching (isNullish/isUndef/
 * isNull/isBoolAtom), boxed-boolean carriers (boolBoxIR/carrierF64/
 * unboxBoolIR), the nullish-receiver TypeError constructor, and truthiness
 * testing (truthyIR). Merged in one family, not split into a separate
 * 'truthy.js': boolBoxIR calls truthyIR, and truthyIR calls isNullish -- a
 * genuine two-way dependency in the ORIGINAL code between sentinel
 * construction and truthiness testing, not a splitting artifact. See
 * .work/ir-split.md.
 *
 * @module ir/sentinels
 */

import { ctx, inc, PTR, LAYOUT } from '../ctx.js'
import { VAL, lookupValType } from '../reps.js'
import { valTypeOf } from '../kind.js'
import { atomNanHex, nanPrefixHex, i64Hex } from '../../layout.js'
import { typed } from './tag.js'
import { temp, tempI32 } from './locals.js'
import { mkPtrIR } from './pointers.js'
import { asF64, asI64 } from './numeric.js'
import { bigintStrict, bigintEraseErr } from './bigint.js'

/** Reserved atoms (PTR.ATOM tag, offset=0).
 *    aux=1 → null      (NULL_NAN)
 *    aux=2 → undefined (UNDEF_NAN)
 *    aux=4 → false     (FALSE_NAN)
 *    aux=5 → true      (TRUE_NAN)
 *  See module/symbol.js for the broader reserved-atom-id scheme.
 *  Distinct from 0, NaN, and all pointers. Triggers default params.
 *  At the JS boundary, null and undefined preserve their identity for interop. */
export const NULL_NAN = atomNanHex(1)

export const UNDEF_NAN = atomNanHex(2)

/** Zombie-entry key sentinel for the durable-slot heal (__durable_slot_heal,
 *  module/core.js): written over a healed durable dict entry's KEY so probes and
 *  enumeration skip it. Unforgeable: ATOM tag with a saturated aux+offset no
 *  boxing path ever produces (real atom ids are tiny). Every equality family is
 *  deref-free on it: i64.eq mismatches, __str_eq bails on the non-STRING tag,
 *  __same_value_zero's atom arm is bit-equality. */
export const TOMB_NAN = '0x7FF87FFFFFFFFFFF'

/** Boxed-boolean carrier. `false`/`true` are reserved atoms — materialized only
 *  where boolean identity is observed (typeof/String/JSON/host boundary); in
 *  branch/arithmetic position booleans stay raw i32/f64 0/1. The atomId encodes
 *  the truth value in its low bit (4=false, 5=true), so `aux & 1` recovers 0/1
 *  and `4 | bit` boxes it — see boolBoxIR / unboxBoolIR. */
export const BOOL_ATOM_BASE = 4

export const FALSE_NAN = atomNanHex(4)

export const TRUE_NAN = atomNanHex(5)

/** WAT-template-ready sentinel expressions for use in stdlib template strings.
 *  `f64.const nan:0xHEX` is 3 bytes shorter than `f64.reinterpret_i64 (i64.const ...)`. */
export const NULL_WAT = `(f64.const nan:${NULL_NAN})`

export const UNDEF_WAT = `(f64.const nan:${UNDEF_NAN})`

export const NULL_IR = ['f64.const', `nan:${NULL_NAN}`]

export const UNDEF_IR = ['f64.const', `nan:${UNDEF_NAN}`]

export const FALSE_IR = ['f64.const', `nan:${FALSE_NAN}`]

export const TRUE_IR = ['f64.const', `nan:${TRUE_NAN}`]

// .slice() before typed(): NULL_IR is a shared module-level template (like its
// UNDEF_IR/FALSE_IR/TRUE_IR siblings below, which already copy) — typed() tags
// `.type` onto the node it's given, so calling it on the shared array directly
// mutates ONE instance repeatedly. Natively harmless (same idempotent value each
// time, plain GC heap). In the self-hosted kernel `.type=` is a dynamic-key write
// that lazily allocates a per-object props sidecar the FIRST time it's called —
// which happens well after module-init (`__start`), so that sidecar lives ABOVE
// `__heap_reset` in the bump arena and dangles after `_clear` rewinds it: the
// NEXT `nullExpr()` call (next compile) reads NULL_IR's now-stale header propsPtr
// and corrupts memory. A missing `.slice()` this whole time — surfaced only by
// warm-instance reuse actually re-invoking it post-`_clear`.
export const nullExpr = () => typed(NULL_IR.slice(), 'f64')

export const undefExpr = () => typed(UNDEF_IR.slice(), 'f64')

/** Materialize the boxed-boolean carrier from a 0/1-valued expression. The atom
 *  is `BOOL_ATOM_BASE | bit`, so boxing is one `i32.or` then an ATOM mkptr; when
 *  the input folds to a constant 0/1 we emit the `f64.const nan:` literal directly.
 *  Used only at observation/escape sites — never in branch or arithmetic position. */
export function boolBoxIR(e) {
  const i = truthyIR(e)
  if (Array.isArray(i) && i[0] === 'i32.const') return typed((i[1] ? TRUE_IR : FALSE_IR).slice(), 'f64')
  return mkPtrIR(['i32.const', PTR.ATOM], ['i32.or', ['i32.const', BOOL_ATOM_BASE], i], ['i32.const', 0])
}

/** Value-preserving f64 carrier for a value entering an untyped slot — container
 *  stores, collection keys/values, dyn-prop writes, generic call args. A boolean
 *  keeps its identity as the TRUE/FALSE atom box (typeof/String/strict-eq survive
 *  the round-trip); everything else takes the plain asF64 box. Never use in branch
 *  or arithmetic position — truthyIR/toNumF64 own those (raw 0/1 there by design).
 *  Callers emit(node) ONCE and pass both (emitting per-arm inside a ternary wrapped
 *  by different coercions is the self-host-fragile shape — see emit.js 'return'). */
export function carrierF64(node, emitted, kind = 'collection') {
  if (valTypeOf(node) === VAL.BOOL) return boolBoxIR(emitted)
  // BigInt normalization is owned by RepresentationPlan at the caller's
  // concrete edge. Strict mode remains a diagnostic for an unresolved
  // generic slot; it does not choose the default representation.
  if (bigintStrict() && valTypeOf(node) === VAL.BIGINT &&
      !(Array.isArray(node) && node[0] === '?:'))
    bigintEraseErr(kind, typeof node === 'string' ? node : 'this expression')
  return asF64(emitted)
}

/** BOOL-preserving carrier for statically narrow slots. BigInt edges are
 *  normalized by RepresentationPlan before reaching this helper. */
export function carrierF64Narrow(node, emitted, kind = 'collection') {
  if (valTypeOf(node) === VAL.BOOL) return boolBoxIR(emitted)
  return asF64(emitted)
}

/** Recover the 0/1 i32 value of a known boxed-boolean f64 expression: `aux & 1`. */
export function unboxBoolIR(f64expr) {
  if (Array.isArray(f64expr) && f64expr[0] === 'f64.const') {
    const bits = typeof f64expr[1] === 'string' ? f64expr[1].replace(/^nan:/, '') : null
    if (bits === TRUE_NAN) return typed(['i32.const', 1], 'i32')
    if (bits === FALSE_NAN) return typed(['i32.const', 0], 'i32')
  }
  return typed(['i32.and', ['i32.wrap_i64', ['i64.shr_u', ['i64.reinterpret_f64', f64expr], ['i64.const', String(LAYOUT.AUX_SHIFT)]]], ['i32.const', 1]], 'i32')
}

// f64 ops whose result is always a plain NUMBER (never a NaN-boxed carrier) and can
// be NaN — their truthiness must test NaN by value, not by bit pattern (see truthyIR).
const NUM_F64_TRUTHY_OPS = new Set([
  'f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.neg', 'f64.abs', 'f64.sqrt',
  'f64.min', 'f64.max', 'f64.ceil', 'f64.floor', 'f64.trunc', 'f64.nearest', 'f64.copysign',
])

const numericTruthy = e => {
  const t = temp('tb')
  const g = () => typed(['local.get', `$${t}`], 'f64')
  return typed(['block', ['result', 'i32'],
    ['local.set', `$${t}`, e],
    ['i32.and', ['f64.ne', g(), ['f64.const', 0]], ['f64.eq', g(), g()]]], 'i32')
}

// i32 ops whose result is already a 0/1 boolean (comparisons + eqz) — safe to use
// directly as a truthiness without a redundant `!= 0`.
// Ops whose result is already a canonical i32 boolean (0 or 1) — a condition built
// from one needs no `i32.ne(_, 0)` normalization. Every wasm comparison returns 0/1,
// so the f64/f32/i64 relations belong here too (they were missing — a `a > b ? …`
// f64 compare was wrapped in a dead `i32.ne(f64.gt …, 0)` in every branch/select).
const I32_BOOL_OPS = new Set(['i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u',
  'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u', 'i32.eqz',
  'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge',
  'f32.eq', 'f32.ne', 'f32.lt', 'f32.gt', 'f32.le', 'f32.ge',
  'i64.eq', 'i64.ne', 'i64.lt_s', 'i64.lt_u', 'i64.gt_s', 'i64.gt_u',
  'i64.le_s', 'i64.le_u', 'i64.ge_s', 'i64.ge_u', 'i64.eqz'])

export function truthyIR(e) {
  // An i32 *constant* is a concrete number, not a known 0/1 boolean — fold it to its
  // truthiness (nonzero → 1).
  if (Array.isArray(e) && e[0] === 'i32.const') return typed(['i32.const', e[1] ? 1 : 0], 'i32')
  if (e.type === 'i32') {
    // A comparison/eqz result is already 0/1 → use directly. Any *other* i32 may be a
    // concrete narrowed integer (e.g. `Boolean(n)` where n is an i32 number), which is
    // NOT a 0/1 boolean — normalize via `!= 0` so its truthiness is correct.
    if (Array.isArray(e) && I32_BOOL_OPS.has(e[0])) return e
    return typed(['i32.ne', e, ['i32.const', 0]], 'i32')
  }
  // Unboxed pointer offsets: truthy iff non-zero offset.
  if (e.ptrKind != null) return typed(['i32.ne', e, ['i32.const', 0]], 'i32')
  if (Array.isArray(e)) {
    if (e[0] === 'f64.convert_i32_s' || e[0] === 'f64.convert_i32_u')
      return typed(['i32.ne', e[1], ['i32.const', 0]], 'i32')
    if (e[0] === 'call' && e[1] === '$__is_truthy') return typed(e, 'i32')
    // Fold literal f64 constants: zero/NaN → 0, any other number → 1.
    if (e[0] === 'f64.const' && typeof e[1] === 'number') {
      return typed(['i32.const', (e[1] !== 0 && !Number.isNaN(e[1])) ? 1 : 0], 'i32')
    }
    // Fold NaN-boxed sentinel literals in `f64.const nan:0x...` form (boolean
    // atoms, null/undefined): TRUE → 1, everything else nullish/false → 0.
    if (e[0] === 'f64.const' && typeof e[1] === 'string' && e[1].startsWith('nan:')) {
      const bits = e[1].slice(4)
      if (bits === TRUE_NAN) return typed(['i32.const', 1], 'i32')
      if (bits === FALSE_NAN || bits === UNDEF_NAN || bits === NULL_NAN) return typed(['i32.const', 0], 'i32')
    }
    // Fold NaN-boxed pointer literals: UNDEF/NULL/canonical-NaN sentinels are falsy;
    // all other NaN-boxed pointers (SSO strings, heap ptrs, etc.) are truthy.
    if (e[0] === 'f64.reinterpret_i64' && Array.isArray(e[1]) && e[1][0] === 'i64.const') {
      const bits = String(e[1][1])
      const FALSY = new Set([UNDEF_NAN, NULL_NAN, FALSE_NAN, nanPrefixHex(), '0x7FFA400000000000'])
      return typed(['i32.const', FALSY.has(bits) ? 0 : 1], 'i32')
    }
    // Fresh pointer constructors never produce nullish. Treat as always truthy.
    if (e[0] === 'call' && typeof e[1] === 'string' &&
        (e[1].startsWith('$__mkptr') || e[1] === '$__alloc' ||
         e[1] === '$__alloc_hdr' || e[1].startsWith('$__alloc_hdr_'))) {
      return typed(['i32.const', 1], 'i32')
    }
    // Pointer-typed local reads: value is never a plain number — truthy iff not nullish.
    // (local.get $x) where $x's valType is a non-STRING pointer kind.
    if (e[0] === 'local.get' && typeof e[1] === 'string') {
      const name = e[1][0] === '$' ? e[1].slice(1) : e[1]
      const vt = lookupValType(name)
      if (vt === VAL.ARRAY || vt === VAL.OBJECT || vt === VAL.SET || vt === VAL.MAP ||
          vt === VAL.CLOSURE || vt === VAL.TYPED || vt === VAL.BUFFER || vt === VAL.REGEX || vt === VAL.DATE) {
        return typed(['i32.eqz', isNullish(e)], 'i32')
      }
      // A plain NUMBER is truthy iff non-zero AND not NaN. `f64.eq x x` tests NaN by
      // VALUE (false for ANY NaN bits), so this is correct on every platform — unlike
      // __is_truthy, which bit-compares the canonical number-NaN and so mis-reads
      // x86's sign-set 0xFFF8.. NaN (from f64.div(0,0) / %) as a truthy box. (local.get
      // is pure → duplicated, not teed.) Bigint carriers are reinterpret/i64 shapes
      // and never reach here as VAL.NUMBER.
      if (vt === VAL.NUMBER) {
        const g = () => typed(['local.get', e[1]], 'f64')
        return typed(['i32.and', ['f64.ne', g(), ['f64.const', 0]], ['f64.eq', g(), g()]], 'i32')
      }
    }
    // Direct number-producing f64 expression (arithmetic, or the `%` / __rem helper):
    // same NaN-safe test, single-evaluated through a temp (the value may be a call).
    if (NUM_F64_TRUTHY_OPS.has(e[0]) || (e[0] === 'call' && e[1] === '$__rem')) return numericTruthy(e)
  }
  // Composite IR tagged by emit as a definite NUMBER. Use value-based NaN
  // truthiness; opaque f64 carriers (strings/objects/bigints/nullish/booleans)
  // remain on __is_truthy so NaN-boxed payloads stay truthy/falsy by tag.
  if (e.valKind === VAL.NUMBER) return numericTruthy(e)
  inc('__is_truthy')
  return typed(['call', '$__is_truthy', asI64(e)], 'i32')
}

export const toBoolFromEmitted = truthyIR

// Shared peephole for the NaN-box sentinel checks. When the operand's bits are
// statically known — an unboxed pointer (never an atom → 0), a numeric `f64.const`
// (never an atom → 0), or a boxed `(f64.const nan:…)` / `(f64.reinterpret_i64
// (i64.const …))` literal — resolve `onBits(bitsHex)` / 0 at compile time; else
// hand the expr to `fallback` for the runtime test. One place owns the literal set.
const constI32 = (b) => typed(['i32.const', b ? 1 : 0], 'i32')

const matchF64Bits = (f64expr, onBits, fallback) => {
  if (f64expr.ptrKind != null) return constI32(0)
  if (Array.isArray(f64expr)) {
    if (f64expr[0] === 'f64.const') {
      const lit = String(f64expr[1])
      return lit.startsWith('nan:') ? onBits(lit.slice(4)) : constI32(0)
    }
    if (f64expr[0] === 'f64.reinterpret_i64' && Array.isArray(f64expr[1]) && f64expr[1][0] === 'i64.const')
      return onBits(String(f64expr[1][1]))
  }
  return fallback(f64expr)
}

export const isNullish = (f64expr) => matchF64Bits(f64expr,
  bits => constI32(bits === NULL_NAN || bits === UNDEF_NAN),
  (e) => {
    // (local.get $x): inline the test, reinterpreting twice (V8 CSEs it). Other
    // exprs call $__is_nullish — keeps binary size stable and evaluates once.
    if (Array.isArray(e) && e[0] === 'local.get') {
      const bits = ['i64.reinterpret_f64', e]
      return typed(['i32.or',
        ['i64.eq', bits, ['i64.const', NULL_NAN]],
        ['i64.eq', ['i64.reinterpret_f64', e], ['i64.const', UNDEF_NAN]]], 'i32')
    }
    inc('__is_nullish')
    return typed(['call', '$__is_nullish', ['i64.reinterpret_f64', e]], 'i32')
  })

/** Check if f64 expr is exactly `undefined` (UNDEF_NAN). Returns i32.
 *  Used by default-param semantics — only `undefined` (or missing arg) triggers
 *  the default; `null` should pass through. */
export const isUndef = (f64expr) => matchF64Bits(f64expr,
  bits => constI32(bits === UNDEF_NAN),
  (e) => typed(['i64.eq', ['i64.reinterpret_f64', e], ['i64.const', UNDEF_NAN]], 'i32'))

/** Check if f64 expr is exactly `null` (NULL_NAN). Returns i32.
 *  Strict `=== null` must match only null — not undefined (use isUndef for that). */
export const isNull = (f64expr) => matchF64Bits(f64expr,
  bits => constI32(bits === NULL_NAN),
  (e) => typed(['i64.eq', ['i64.reinterpret_f64', e], ['i64.const', NULL_NAN]], 'i32'))

/** Construct a real TypeError object and throw it through the ordinary
 *  `$__jz_err` channel. Kind-specific member-access/call nullish-
 *  receiver checks are the caller: a REAL schema-tagged Error object, not a
 *  bare numeric code, is what makes `catch (e) { e instanceof TypeError }`
 *  true in-wasm (the tag+schema arm of the Error model's truth table,
 *  .work/todo.md §deletion-sweep §4 — the numeric-code range arm is unsound
 *  and must not be reintroduced) and what lets interop.js's
 *  decodeThrown resolve an UNCAUGHT throw to a real host TypeError
 *  (errorSidClassOf) — no new decode machinery on either side, both paths
 *  are exactly what a user's own `new TypeError()` already exercises.
 *
 *  Builds the object INLINE — same shape as module/core.js's buildErrorObject
 *  (alloc_hdr + one store per ERR_SCHEMA_PROPS slot + mkPtrIR) — rather than
 *  calling `ctx.core.emit['TypeError']` through it: that path interns the
 *  class name via `emit(['str', 'TypeError'])`, which needs module/string.js
 *  loaded, same as this function now needs directly (below).
 *
 *  INVARIANT: `.name`/`.message` must both be set — a caught synthetic
 *  TypeError with either left `undefined` breaks `e.name === 'TypeError'`
 *  and breaks `String(e)` producing a real "TypeError: <msg>". `ctx.module.
 *  include('string')` (module/array.js's own established pattern for forcing
 *  a cross-module dependency from inside another module) makes
 *  `ctx.core.emit['str']` safe to call here even when this is the ONLY
 *  string-shaped thing the whole program does — a program that never reaches
 *  a nullish-receiver check still pays nothing (the include only fires when
 *  this function is actually called during emission).
 *  `kind` selects the message family per real JS's own split: a property/
 *  method READ on a nullish receiver ('read', the default — every call site
 *  but the callee-nullish one below) says "Cannot read properties of
 *  undefined"; calling a nullish value AS a function ('call') says "is not a
 *  function" — V8's own two-message split, minus the specific property/
 *  callee name (would need one distinct interned string per distinct name
 *  used anywhere in the program — real size cost for a message-text nicety,
 *  out of scope; the class + a non-empty, on-topic message is the contract).
 *  `instanceof` needs none of this: class identity lives in the schema id
 *  (aux bits), not in any slot value. */
export function throwTypeErrorIR(kind = 'read') {
  ctx.runtime.throws = true
  inc('__alloc_hdr')
  ctx.module.include('string')
  const sid = ctx.schema.errorSid('TypeError')
  const p = tempI32('nrerrp')
  const t = temp('nrerr')
  const nameIR = asF64(ctx.core.emit['str']('TypeError'))
  const msgIR = asF64(ctx.core.emit['str'](kind === 'call' ? 'is not a function' : 'Cannot read properties of undefined'))
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${p}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(2)]]],
    ctx.abi.object.ops.store(['local.get', `$${p}`], 0, msgIR),
    ctx.abi.object.ops.store(['local.get', `$${p}`], 1, nameIR),
    ['local.set', `$${t}`, mkPtrIR(PTR.OBJECT, sid, ['local.get', `$${p}`])],
    ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${t}`]]],
    ['throw', '$__jz_err', ['local.get', `$${t}`]]], 'f64')
}

/** Mask that clears the boolean atom's truth bit, mapping TRUE_NAN→FALSE_NAN.
 *  `(bits & BOOL_ATOM_MASK) === FALSE_NAN` recognizes both in one i64.and+i64.eq.
 *  Built via i64Hex (32-bit-half formatting), NOT raw `.toString(16)` on the
 *  BigInt — this mask has bit 63 set, and under self-host BigInts are raw
 *  signed i64 bits (kind-erased), so `.toString(16)` on a bit-63-set value
 *  renders a signed "-…" fragment (the same nanPrefixMaskHex regression class
 *  i64Hex exists to avoid — see layout.js): the root cause of the
 *  in-kernel "Bad int 0x000000-100000001" watr parse failure when done wrong. */
const BOOL_ATOM_MASK = i64Hex(~(1n << BigInt(LAYOUT.AUX_SHIFT)))

/** Check if f64 expr is a boxed-boolean atom (TRUE_NAN or FALSE_NAN). Returns i32.
 *  Single-eval: masks the truth bit and compares to FALSE_NAN once. */
export const isBoolAtom = (f64expr) => matchF64Bits(f64expr,
  bits => constI32(bits === TRUE_NAN || bits === FALSE_NAN),
  (e) => typed(['i64.eq',
    ['i64.and', ['i64.reinterpret_f64', e], ['i64.const', BOOL_ATOM_MASK]],
    ['i64.const', FALSE_NAN]], 'i32'))
