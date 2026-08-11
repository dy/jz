import { OPTF } from './ctx.js'
import { ERR } from '../err-codes.js'
/**
 * Pure IR construction helpers for WAT-as-array output.
 *
 * # Stage contract
 *   IN:  bare primitives (strings, numbers, AST nodes), ctx reads for locals/globals/schema
 *   OUT: tagged IR nodes (arrays with `.type` property)
 *   NO-EMIT: nothing here calls `emit()` — these are leaf constructors. Helpers that
 *        recurse into AST nodes (toBool, materializeMulti, emitDecl, buildArrayWithSpreads,
 *        emitTypeofCmp) live in emit.js because they invoke the dispatch table.
 *
 * # Layers
 *   - Type tagging (`typed`, coercions)
 *   - Nullish sentinels + NaN-boxed pointer construction
 *   - Literal / purity classifiers
 *   - Constant pools (WASM_OPS, MEM_OPS, mutator sets)
 *   - Temp-local factories (mutate `ctx.func.locals`)
 *   - Variable storage abstraction (boxed/global/local dispatch)
 *   - Array-layout IR (slot/elem loads, allocPtr, arrayLoop)
 *
 * @module ir
 */

import { ctx, err, inc, PTR, LAYOUT, CARRIER_BOX } from './ctx.js'
import { ptrBoxPrefixBigInt, ptrBits, i64Hex, atomNanHex, nanPrefixHex, OBJECT_SCHEMA_HI_MASK, objectSchemaGuardHex } from '../layout.js'
import { ERR_CLASS_NAMES } from '../err-codes.js'
import { I32_MIN, I32_MAX, isI32, isLiteralStr, isFuncRef, isLeaf } from './ast.js'
import { VAL, lookupValType, repOf, repOfGlobal } from './reps.js'
import { valTypeOf, censusMaybeUndefined, censusMaybeUndefinedKind, censusShapedNode } from './kind.js'
import { T } from './ast.js'
import { objLiteralSchemaId } from './static.js'

export { I32_MIN, I32_MAX, isI32, isLiteralStr, isFuncRef }

// === Type helpers ===

/** Tag a WASM node with its result type. */
export const typed = (node, type) => (node.type = type, node)

/** NaN-box prefix for a pointer of VAL kind K with aux bits: `0x7FF8 | type<<47 | aux<<32`. */
function ptrBoxPrefix(ptrType, aux = 0) {
  return ptrBoxPrefixBigInt(ptrType, aux)
}

/** Build f64 NaN-boxed pointer IR from an i32 offset node of known kind.
 *  `aux` is the 15-bit secondary tag (schema ID for OBJECT, element type for TYPED, etc.). */
function boxPtrIR(i32node, ptrType, aux = 0) {
  const prefix = ptrBoxPrefix(ptrType, aux)
  const result = typed(['f64.reinterpret_i64',
    ['i64.or',
      ['i64.const', '0x' + prefix.toString(16).toUpperCase()],
      ['i64.extend_i32_u', i32node]]], 'f64')
  // TAG-PRESERVING REBOX (research.md §Carrier invariant, "DECL-INIT WALL
  // ROOT-CAUSED"): typed() above sets only .type on the fresh wrapper node —
  // the source i32node's .ptrKind/.ptrAux (set by readVar-style construction)
  // do NOT propagate onto it. The bits are right (the NaN-box correctly
  // encodes ptrType/aux in the prefix), but the METADATA a downstream
  // consumer reads off the RESULT node (emitDecl's P1 predictor parity
  // assert) is gone, so any caller that boxes a tagged pointer (storedValue
  // → carrierF64 → asF64 → here) silently drops tags the caller never asked
  // to lose.
  //
  // NOT copied onto `.ptrKind`/`.ptrAux` themselves (tried first, reverted —
  // see the forced-invariants proof run that caught it): those two names are
  // a load-bearing DISPATCH convention read throughout ir.js — "`.ptrKind !=
  // null` means this node's OWN representation is an unboxed i32 pointer
  // offset" (asF64 here, truthyIR, writeVar, the matchF64Bits/isNullish
  // family all branch on it without re-checking `.type`). `result` here is
  // f64-typed (already boxed); stamping `.ptrKind` on it makes every one of
  // those sites mistake an already-boxed f64 for a raw i32 offset needing
  // (re-)boxing — verified as a REAL crash, not theoretical: a second asF64
  // pass over an emitDecl coercion's already-boxed `val` re-entered boxPtrIR
  // and emitted `i64.extend_i32_u` on an f64 operand, failing wasm
  // validation ("expected type i32, found f64.reinterpret_i64"). Carried
  // instead under NEW, non-colliding names nothing else reads — additive by
  // construction, zero risk to the existing i32-only convention.
  if (i32node.ptrKind != null) result.srcPtrKind = i32node.ptrKind
  if (i32node.ptrAux != null) result.srcPtrAux = i32node.ptrAux
  // .closureFuncIdx has no such collision (every existing reader treats it as
  // plain informational metadata, never as a type-implying dispatch tag), so
  // it copies forward under its own name unchanged. In practice this is a
  // no-op today: every current minter (mkPtrIR call sites) already builds an
  // f64-typed node directly, so a closureFuncIdx-carrying node never reaches
  // boxPtrIR as `i32node` — kept for the hypothetical i32-typed unboxed-
  // CLOSURE-local carrier, harmless either way.
  if (i32node.closureFuncIdx != null) result.closureFuncIdx = i32node.closureFuncIdx
  return result
}

/** Coerce node to f64. Pointer-kinded i32 offsets rebox via NaN-tag fusion, not numeric convert.
 *  The `unsigned` flag (set by `>>>` codegen) opts into `convert_i32_u` so the canonical
 *  `(x >>> 0)` uint32 idiom converts to a positive f64 in [0, 2^32) instead of sign-flipping. */
export const asF64 = n => {
  if (n == null) err(`compiler internal: expected emitted IR value in ${ctx.func.current?.name || '<module>'}, got empty value`)
  // A v128 (SIMD) value can't be NaN-boxed into the uniform f64 closure ABI — there is no
  // lossless f64 carrier for 128 bits. This is reached only at a closure boundary: a SIMD
  // value captured by, passed to, returned from, or flowing through a `(…)=>…` used as a
  // VALUE — most commonly an IIFE `(() => f32x4.…)()`, which jz lowers via the closure path.
  // Without this guard the coercion emits `f64.convert_i32_s(<v128>)` and dies in the wasm
  // validator with an opaque type error. Keep SIMD inside a NAMED top-level function called
  // directly (`let sdf = (x) => f32x4.…; sdf(v)` lowers to a typed v128 `call`, no boxing),
  // and extract scalars with `f64x2.lane` / `f32x4.lane` before crossing a closure boundary.
  if (n.type === 'v128') err(`SIMD (v128) values can't cross a closure/IIFE boundary — closures use the uniform f64 ABI. Move the SIMD into a named top-level function called directly, or extract a lane (f64x2.lane / f32x4.lane) to an f64 first.`)
  if (n.ptrKind != null) return boxPtrIR(n, valKindToPtr(n.ptrKind), n.ptrAux || 0)
  if (n.type === 'f64') return n
  if (n.type === 'i64') {
    // Cancel the reinterpret round-trip at construction: reinterpret is bit-preserving
    // both ways, so f64.reinterpret_i64(i64.reinterpret_f64(X)) === X. Folding here keeps
    // the pair out of the IR entirely (smaller tree for every downstream pass) instead of
    // letting fusedRewrite untangle it post-emit.
    if (Array.isArray(n) && n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1])) return typed(n[1], 'f64')
    return typed(['f64.reinterpret_i64', n], 'f64')
  }
  // A `.unsigned` const carries its uint32 value as a signed i32 bit pattern, so
  // widen via `>>> 0` (e.g. -1 → 4294967295); a plain const copies through verbatim.
  if (n[0] === 'i32.const' && typeof n[1] === 'number') return typed(['f64.const', n.unsigned ? n[1] >>> 0 : n[1]], 'f64')
  return typed([n.unsigned ? 'f64.convert_i32_u' : 'f64.convert_i32_s', n], 'f64')
}

/** Coerce node to i32 (saturating — fast, correct for values < 2^31). */
export const asI32 = n => {
  if (n.type === 'i32') return n
  // Peephole: trunc_sat_f64_s(convert_i32_*(x)) === x. The argument of f64.convert_i32_*
  // is i32 by WASM validation, so peel unconditionally and re-tag.
  if (Array.isArray(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'f64.convert_i32_u')) {
    const inner = n[1]
    return Array.isArray(inner) ? typed(inner, 'i32') : inner
  }
  // Provably i32-ranged values keep the single-op bare trunc (exact there —
  // no saturation can fire); everything else wraps through i64: this coercion
  // feeds i32-NARROWED param/cell boundaries, where the narrowing proof is
  // "the value is consumed by int32 ops" — ES ToInt32 semantics, which WRAP
  // mod 2^32. Bare trunc_sat saturates at INT32_MAX, so `(u >>> 0)` on a
  // narrowed param read 0x7fffffff for any hi-word ≥ 2^31 (every negative
  // f64's upper half — the bug that corrupted extractF64Bits' static slots
  // for negative fields). Same lowering and |x| ≥ 2^63 boundary as toI32.
  const rng = f64Range(n)
  if (rng && rng.lo >= I32_MIN && rng.hi <= I32_MAX) return typed(['i32.trunc_sat_f64_s', n], 'i32')
  return typed(['i32.wrap_i64', ['i64.trunc_sat_f64_s', n]], 'i32')
}

/** Coerce node to i32 by SATURATING at INT32_MIN/INT32_MAX (NaN -> 0) — the ES
 *  ToIntegerOrInfinity contract a position/index/length argument needs (String/Array
 *  `.slice`/`.indexOf`/`.includes`/… position args), as opposed to asI32's ToInt32-WRAP
 *  contract (bitwise-op operands, i32-narrowed storage). Using asI32 for a position
 *  argument is a real, silent-wrong bug whenever the value isn't PROVABLY i32-ranged
 *  (asI32's fallback then goes through `i64.trunc_sat_f64_s` + `i32.wrap_i64`, and
 *  wrapping i64::MAX/MIN's low 32 bits gives -1/0 instead of saturating): confirmed live,
 *  `str.includes(needle, Infinity)` — and any position >= 2^63, e.g. `1e20` — wrapped to
 *  -1 and was read back downstream as "index from the end" instead of "past the end".
 *  `i32.trunc_sat_f64_s` alone already implements exactly the wanted mapping (±Infinity
 *  -> INT32_MAX/MIN, NaN -> 0, in-range -> truncated value) with no i64 detour needed —
 *  the ONE-op direct form is not just correct here but cheaper than asI32's fallback. */
export const asI32Sat = n => {
  if (n.type === 'i32') return n
  if (Array.isArray(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'f64.convert_i32_u')) {
    const inner = n[1]
    return Array.isArray(inner) ? typed(inner, 'i32') : inner
  }
  return typed(['i32.trunc_sat_f64_s', n], 'i32')
}

/** Coerce node to i32 offset for a ptr-narrowed return / store. Same-kind unboxed
 *  ptr passes through; otherwise extract low 32 bits from the NaN-boxed f64
 *  (NOT trunc — that would convert numerically). */
export const asPtrOffset = (n, ptrKind) => {
  if (n.ptrKind === ptrKind) return n
  const f = asF64(n)
  // Peel the inner reinterpret round-trip before wrapping: i64.reinterpret_f64(f64.reinterpret_i64(Y)) === Y.
  const bits = Array.isArray(f) && f[0] === 'f64.reinterpret_i64' && Array.isArray(f[1]) ? f[1] : ['i64.reinterpret_f64', f]
  return typed(['i32.wrap_i64', bits], 'i32')
}

/** Coerce emitted IR to a target WASM param type ('i32' | 'i64' | 'f64'). */
// i32 target: toI32 (not asI32) — same reasoning as writeVar's i32-local
// coercion (P0-2 sibling, 2026-08-02): a strict superset of the `|0` wrap
// contract that ALSO tries narrowI32's ring recovery first. Covers BOTH of
// asParamType's consumers safely: call-ARGUMENT coercion (target is the
// callee's own i32-typed param cell — a consistent-wrap "storage" write,
// exactly like a local assignment) and RETURN coercion (target is the
// caller-observed function result — but `t==='i32'` there is only ever
// reached once narrowI32Results has ALREADY strictly proven the return
// tail's own magnitude fits, via the identical exprType(strict) proof
// tryI32Arith consults — so the value toI32 recovers here is faithful by
// construction, never an unproven wrap escaping bare).
export const asParamType = (n, t) => t === 'i32' ? toI32(n) : t === 'i64' ? asI64(n) : t === 'v128' ? n : asF64(n)

// Sound upper bound on the value of a masking expr (`&` / `>>>`), so a product
// against it can be proven < 2^53 and narrow to i32.mul instead of the guarded f64
// path. `& m` with a non-negative mask m clamps the result to [0, m] (regardless of
// the other operand's sign); `>>> k` is logical, so it's ≤ 2^(32−k). Anything else
// (signed shift, plain locals, negative mask) stays the full i32 range.
export const maskBound = (x) => {
  if (!Array.isArray(x)) return 2 ** 31
  if (x[0] === 'i32.const') return x[1] >= 0 ? x[1] : 2 ** 31
  if (x[0] === 'i32.and') return Math.min(maskBound(x[1]), maskBound(x[2]))
  if (x[0] === 'i32.shr_u') {
    const k = Array.isArray(x[2]) && x[2][0] === 'i32.const' ? (x[2][1] & 31) : 0
    return k > 0 ? 2 ** (32 - k) : 2 ** 31
  }
  return 2 ** 31
}

/**
 * Narrow an f64 arithmetic tree under ToInt32 — the general int-accumulator path.
 *
 * ToInt32 is reduction mod 2^32, and {+, −, ×} form a RING under that modulus:
 * operands may wrap to i32 eagerly and the final result still equals ToInt32 of
 * the JS value — PROVIDED the original f64 computation was exact (no rounding).
 * Exactness is tracked structurally: every interior node's worst-case magnitude
 * (`maxAbs`, real un-wrapped value) must stay below 2^53. Leaves are peeled
 * `f64.convert_i32_*` wrappers (≤2^31/2^32) and integer constants.
 *
 * `/` is NOT a ring op (fractions): it narrows only at the ToInt32 ROOT, with a
 * FAITHFUL numerator (i32 value == JS value — wrapped sums excluded) and a
 * constant integer divisor. i32.div_s truncates toward zero exactly like
 * ToInt32 of the f64 quotient (error < ulp/2 < distance-to-integer for any i32
 * numerator); c ∈ {0,−1,1} are diverted (trap / INT_MIN trap / identity).
 *
 * Returns {node (i32-typed), maxAbs, faithful} or null — callers use `.node`.
 */
const narrowI32 = (x, isRoot) => {
  if (!Array.isArray(x)) return null
  // `maskBound` (magnitude bound from `&`/`>>>` structure, defaulting to the full
  // i32 magnitude when it can't prove tighter) gives this leaf's REAL worst-case
  // value instead of the blanket i32 ceiling — so a masked leaf (bytebeat's
  // `t*(m&63)` under its `&255` sink) keeps the ring below 2^53 and narrows to
  // `i32.mul` here, same as it would if the `*` operator's OWN admission
  // (emit.js `mulFitsI32`) had proven it — but this narrowing only ever fires
  // under a proven ToInt32 root (toI32's callers: `&`/`|`/`^`/`<<`/`>>>`/an i32-
  // typed local destination), where wraparound is provably harmless (P0-2
  // ledger) — unlike `mulFitsI32`, which guards a value that may escape as a
  // plain f64 number with no further truncation to absorb the wrap.
  if (x.type === 'i32') return { node: x, maxAbs: maskBound(x), faithful: true }
  const op = x[0]
  if (op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u')
    // Peel — same as toI32's peephole. _u values ∈ [0, 2^32): the re-tag IS the
    // wrap (ring-compatible), but the i32 view differs from the JS value above
    // 2^31, so _u is not faithful.
    return {
      node: Array.isArray(x[1]) ? typed(x[1], 'i32') : x[1],
      maxAbs: op === 'f64.convert_i32_s' ? maskBound(x[1]) : 2 ** 32,
      faithful: op === 'f64.convert_i32_s',
    }
  if (op === 'f64.const' && typeof x[1] === 'number' && Number.isInteger(x[1]) && Math.abs(x[1]) < 2 ** 52)
    return { node: typed(['i32.const', x[1] | 0], 'i32'), maxAbs: Math.abs(x[1]), faithful: Math.abs(x[1]) < 2 ** 31 }
  if (op === 'f64.add' || op === 'f64.sub' || op === 'f64.mul') {
    const a = narrowI32(x[1]), b = narrowI32(x[2])
    if (!a || !b) return null
    const maxAbs = op === 'f64.mul' ? a.maxAbs * b.maxAbs : a.maxAbs + b.maxAbs
    if (maxAbs >= 2 ** 53) return null
    const iop = op === 'f64.add' ? 'i32.add' : op === 'f64.sub' ? 'i32.sub' : 'i32.mul'
    return { node: typed([iop, a.node, b.node], 'i32'), maxAbs, faithful: false }
  }
  if (op === 'f64.neg') {
    const a = narrowI32(x[1])
    if (!a) return null
    return { node: typed(['i32.sub', ['i32.const', 0], a.node], 'i32'), maxAbs: a.maxAbs, faithful: false }
  }
  if (op === 'f64.div' && isRoot) {
    const a = narrowI32(x[1])
    if (!a || !a.faithful) return null
    const c = Array.isArray(x[2]) && x[2][0] === 'f64.const' && typeof x[2][1] === 'number' ? x[2][1] : null
    if (c == null || !Number.isInteger(c) || c === 0 || c === 1 || Math.abs(c) >= 2 ** 31) return null
    // c = −1 would trap on INT_MIN; 0 − x wraps INT_MIN → INT_MIN, matching ToInt32(2^31).
    const node = c === -1
      ? typed(['i32.sub', ['i32.const', 0], a.node], 'i32')
      : typed(['i32.div_s', a.node, ['i32.const', c]], 'i32')
    return { node, maxAbs: 2 ** 31, faithful: c !== -1 }
  }
  return null
}

// Conservative VALUE-RANGE for a pure f64 expression tree: returns { lo, hi } bounding
// every value the node can take, or null when unknown. SOUND by construction — each rule
// over-approximates using the SAME f64 ops the runtime uses (f64 +/−/× are monotone in
// each argument, so combining endpoint-bounds with plain JS doubles yields bounds that
// contain the true value). A null/non-finite endpoint anywhere collapses to null, so a
// non-null result also PROVES the value is finite (never NaN, never ±∞). Used by toI32 to
// drop the +∞-guard `select` (and the i64 round-trip when the value fits i32) — the guard
// exists only to remap +∞→0, so a proof of finiteness retires it.
const fin = (lo, hi) => (Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi) ? { lo, hi } : null
// Range of the i32 that feeds an `f64.convert_i32_*`, refined by a narrowing load width.
const convRange = (child, signed) => {
  if (Array.isArray(child)) {
    const o = child[0]
    if (o === 'i32.load8_u') return { lo: 0, hi: 255 }
    if (o === 'i32.load8_s') return { lo: -128, hi: 127 }
    if (o === 'i32.load16_u') return { lo: 0, hi: 65535 }
    if (o === 'i32.load16_s') return { lo: -32768, hi: 32767 }
    if (o === 'i32.const' && typeof child[1] === 'number') return signed ? { lo: child[1] | 0, hi: child[1] | 0 } : { lo: child[1] >>> 0, hi: child[1] >>> 0 }
  }
  return signed ? { lo: I32_MIN, hi: I32_MAX } : { lo: 0, hi: 4294967295 }
}
// `get`, when supplied, resolves a `(local.get $V)` to $V's single defining value node
// (a `name → defExpr | null` map/function built from a one-def-per-local scan). This lets the
// range see through the temps that inlining introduces — e.g. `floor(mul(convert($px),0.03125))`
// stashed in `$xi` before truncation — so the i32-fit proof survives the indirection. SOUND
// without code motion: a single-textual-def local holds exactly the value its def computes, so
// the def's range bounds every value the local can take, even if the def's inputs vary across
// iterations. A self-referential (loop-carried) single def is caught by the `seen` cycle guard
// and yields null (unknown), which is conservative.
export const f64Range = (n, get) => {
  const seen = get ? new Set() : null
  const r = (n) => {
    if (!Array.isArray(n)) return null
    const op = n[0]
    if (op === 'local.get' && get && typeof n[1] === 'string') {
      if (seen.has(n[1])) return null               // loop-carried / cyclic def → unknown
      const def = typeof get === 'function' ? get(n[1]) : get.get(n[1])
      if (!def) return null
      seen.add(n[1]); const rng = r(def); seen.delete(n[1])
      return rng
    }
    if (op === 'f64.const') return typeof n[1] === 'number' ? fin(n[1], n[1]) : null   // `nan:…`/Inf literal strings → null
    if (op === 'f64.convert_i32_s') return convRange(n[1], true)
    if (op === 'f64.convert_i32_u') return convRange(n[1], false)
    if (op === 'f64.neg') { const a = r(n[1]); return a && fin(-a.hi, -a.lo) }
    if (op === 'f64.abs') { const a = r(n[1]); return a && fin(a.lo > 0 ? a.lo : a.hi < 0 ? -a.hi : 0, Math.max(-a.lo, a.hi)) }
    if (op === 'f64.sqrt') { const a = r(n[1]); return a && a.lo >= 0 && fin(Math.sqrt(a.lo), Math.sqrt(a.hi)) }
    // Rounding ops preserve finiteness and are monotonic, so the range maps elementwise. This lets
    // `Math.floor(x)|0` over a bounded x (every grid/image/audio index: `px*scale`, perm[] lookups)
    // drop the +∞-guard + i64 round-trip in toI32 down to a single i32.trunc_sat_f64_s. `nearest`
    // (round-half-to-even) lands in {floor,ceil} so its bounds are floor(lo)..ceil(hi).
    if (op === 'f64.floor') { const a = r(n[1]); return a && fin(Math.floor(a.lo), Math.floor(a.hi)) }
    if (op === 'f64.ceil')  { const a = r(n[1]); return a && fin(Math.ceil(a.lo), Math.ceil(a.hi)) }
    if (op === 'f64.trunc') { const a = r(n[1]); return a && fin(Math.trunc(a.lo), Math.trunc(a.hi)) }
    if (op === 'f64.nearest') { const a = r(n[1]); return a && fin(Math.floor(a.lo), Math.ceil(a.hi)) }
    if (op === 'f64.add') { const a = r(n[1]), b = r(n[2]); return a && b && fin(a.lo + b.lo, a.hi + b.hi) }
    if (op === 'f64.sub') { const a = r(n[1]), b = r(n[2]); return a && b && fin(a.lo - b.hi, a.hi - b.lo) }
    if (op === 'f64.mul') {
      const a = r(n[1]), b = r(n[2]); if (!a || !b) return null
      const p = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi]
      return fin(Math.min(...p), Math.max(...p))
    }
    if (op === 'f64.div') {
      const c = Array.isArray(n[2]) && n[2][0] === 'f64.const' && typeof n[2][1] === 'number' ? n[2][1] : null
      if (c == null || c === 0) return null               // variable / zero divisor → may be ±∞
      const a = r(n[1]); if (!a) return null
      const p = [a.lo / c, a.hi / c]
      return fin(Math.min(...p), Math.max(...p))
    }
    if (op === 'f64.min') { const a = r(n[1]), b = r(n[2]); return a && b && fin(Math.min(a.lo, b.lo), Math.min(a.hi, b.hi)) }
    if (op === 'f64.max') { const a = r(n[1]), b = r(n[2]); return a && b && fin(Math.max(a.lo, b.lo), Math.max(a.hi, b.hi)) }
    return null
  }
  return r(n)
}

/** Coerce node to i32 with wrapping (JS `|0` semantics: values > 2^31 wrap to negative).
 *  Per ECMAScript ToInt32, NaN and ±∞ map to 0. `i64.trunc_sat_f64_s` handles NaN
 *  and -∞ correctly, but +∞ saturates to i64_max which wraps to -1 — guard +∞ via
 *  branchless `select`. For non-leaf inputs `n` is stashed in a temp f64 local so it's
 *  evaluated exactly once (avoid side-effect re-execution and bytecode duplication). */
export const toI32 = n => {
  if (n.type === 'i32') return n
  // Peephole: i32.wrap_i64(i64.trunc_sat_f64_s(f64.convert_i32_*(x))) === x for all i32
  // inputs (both signed and unsigned variants round-trip identically). The argument of
  // f64.convert_i32_* is i32 by WASM validation, so peel unconditionally and re-tag.
  if (Array.isArray(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'f64.convert_i32_u')) {
    const inner = n[1]
    return Array.isArray(inner) ? typed(inner, 'i32') : inner
  }
  if (Array.isArray(n) && n[0] === 'f64.const' && typeof n[1] === 'number') {
    const v = n[1]
    return typed(['i32.const', Number.isFinite(v) ? v | 0 : 0], 'i32')   // JS `|0` is ToInt32
  }
  // General int-arithmetic narrowing: an exact-int f64 tree of {+,−,×,neg,/C}
  // computes in i32 (mod-2^32 ring) — no trunc/guard at all.
  const nw = narrowI32(n, true)
  if (nw) return nw.node
  // Value-range narrowing: a NON-integer f64 tree (e.g. `10 + 200·(u8[i]/255)`) the ring
  // path rejects, but whose value is PROVABLY FINITE — so the +∞-guard `select` is dead.
  // When the value also provably fits i32, a single `i32.trunc_sat_f64_s` IS exact ToInt32
  // (no saturation can fire in-range, no NaN, no ±∞) — dropping the i64 round-trip AND the
  // guard. Pervasive in pixel/colour packing: `(base + scale·v)|0`.
  const rng = f64Range(n)
  if (rng) {
    if (rng.lo >= I32_MIN && rng.hi <= I32_MAX) return typed(['i32.trunc_sat_f64_s', n], 'i32')
    // Finite and within (−2^63, 2^63): keep the mod-2^32 wrap, drop the (now-dead) +∞ guard.
    // i64.trunc_sat does not saturate in this window, so wrap_i64 == ToInt32. Beyond ±2^63 we
    // fall through to the guarded path (which already saturates there — the documented boundary).
    if (rng.lo >= -9223372036854775808 && rng.hi < 9223372036854775808)
      return typed(['i32.wrap_i64', ['i64.trunc_sat_f64_s', n]], 'i32')
  }
  // Leaf nodes are cheap to duplicate; for everything else, evaluate once via local.tee.
  // `i32.wrap_i64(i64.trunc_sat_f64_s x)` is exact ToInt32 for |x| < 2^63 (the
  // overwhelming common range), maps NaN/−∞→0, and +∞ is guarded to 0 by the
  // select. For |x| ≥ 2^63 it saturates rather than wrapping mod 2^32 — a
  // deliberately-allowed asm.js-style boundary (no per-`|0` helper/guard cost).
  const wrap = x => typed(['i32.wrap_i64', ['i64.trunc_sat_f64_s', x]], 'i32')
  if (isLeaf(n)) {
    return typed(['select', wrap(n), ['i32.const', 0], ['f64.ne', n, ['f64.const', Infinity]]], 'i32')
  }
  const t = temp('inf')
  return typed(['select',
    wrap(['local.tee', `$${t}`, n]),
    ['i32.const', 0],
    ['f64.ne', ['local.get', `$${t}`], ['f64.const', Infinity]]
  ], 'i32')
}

/** Extract i64 from BigInt-as-f64. */
export const asI64 = n => {
  const f = asF64(n)
  // Cancel reinterpret round-trip: i64.reinterpret_f64(f64.reinterpret_i64(Y)) === Y.
  if (Array.isArray(f) && f[0] === 'f64.reinterpret_i64' && Array.isArray(f[1])) return typed(f[1], 'i64')
  return typed(['i64.reinterpret_f64', f], 'i64')
}

/** Wrap i64 result back to BigInt-as-f64. */
export const fromI64 = n => {
  // Cancel reinterpret round-trip: f64.reinterpret_i64(i64.reinterpret_f64(X)) === X.
  if (Array.isArray(n) && n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1])) return typed(n[1], 'f64')
  return typed(['f64.reinterpret_i64', n], 'f64')
}

// === BigInt carrier boxing (CARRIER PROGRAM Slice 1, .work/carrier-
// representation-design.md §7, default flipped ON at §34) — every consumer
// below is gated behind JZ_CARRIER_BOX/CARRIER_BOX (`JZ_CARRIER_BOX=0` opts
// back out to the legacy raw carrier). PTR.BIGINT (layout.js,
// tag 5) is the heap-boxed representation round-3/4's `bigintBoxed` solver
// fact (reps.js) names: an 8-byte cell holding the raw i64 payload,
// NaN-boxed the same way every other heap kind (STRING/OBJECT/…) already is.

/** Materialize a boxed BigInt: alloc an 8-byte cell, store the raw i64
 *  payload, return the NaN-boxed PTR.BIGINT pointer (f64). `i64IR` must
 *  already be the raw i64 bits (asI64'd) — this function only allocates +
 *  stores + tags, the same division of labor as boolBoxIR/allocPtr (callers
 *  own extracting the payload). */
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

/** Runtime twin of unboxBigInt for a value with no STATIC boxed-or-raw proof
 *  either way (CONSERVATIVE PAIRING — coordinator ruling, .work/context-
 *  sensitivity-survey.md 2026-08-09, closing the §15/§16 chain): tag-checks
 *  the value at runtime via `$__ptr_type` (the same primitive every
 *  registry-aware dynamic reader — $__dyn_get/$__typeof/$__to_num/$__eq's
 *  own PTR.BIGINT arms, Slice 3 — already dispatches on) and unboxes through
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
 *  "structural fallback gets false" scope §16 already established for a
 *  chain receiver, module/core.js emitSchemaSlotRead's own doc comment) of a
 *  schema slot the write-side census observed BIGINT on AND boxes wide
 *  (ctx.schema.slotBigintBoxedAt), but cannot PROVE uniformly BIGINT
 *  (ctx.schema.slotBigintProvenAt — `slotHazarded`'s `pointsTo==='ALL'`
 *  blanket, §17-§21, audited genuinely load-bearing, REFUTED as narrowable). This is
 *  the read-side gap §15 found and §16 could only close for the PROVEN
 *  half: `readI64`'s own `typeof node === 'string'` guard structurally
 *  cannot see a `.`-node operand at all, so an arithmetic-core call site
 *  reading a possible-but-unproven schema field via `LAYOUT.NAN_PREFIX_BITS`-
 *  shaped source (§15's own repro) fell to the naive `asI64` reinterpret —
 *  misreading a real box's own NaN-tag bits as the payload. Deliberately
 *  does NOT touch emitSchemaSlotRead's own return value (module/core.js):
 *  that value must stay box-preserving f64 for every OTHER consumer this
 *  same read reaches (the WASM export boundary's host-side generic decode,
 *  $__eq, $__typeof, $__dyn_get) — all already correctly PTR.BIGINT-aware
 *  at the point THEY dereference, per Slice 3 — eagerly unboxing at the
 *  read site itself was tried and found to break exactly that class (a
 *  plain `export let f = () => obj.bigField` regressed from a correct
 *  BigInt result to NaN once the read pre-decoded the box, confirmed via a
 *  live differential against the unfixed baseline before landing this
 *  narrower, readI64-scoped version instead). */
export const isSchemaSlotBigintPossible = (node) =>
  CARRIER_BOX && Array.isArray(node) && node[0] === '.' &&
  typeof node[1] === 'string' && typeof node[2] === 'string' &&
  ctx.schema.slotBigintBoxedAt?.(node[1], node[2]) === true &&
  ctx.schema.slotBigintProvenAt?.(node[1], node[2]) !== true

/** True iff `name`'s solver-settled rep (reps.js `bigintBoxed`, round-3/4
 *  fixpoint) proves this binding must materialize as a real PTR.BIGINT box
 *  AT A W-SINK INSIDE THIS FUNCTION — i.e. `name` currently holds RAW i64
 *  bits that still need boxing at the point of use. Never fail-closed toward
 *  true on a missing rep — an unproven/absent fact means "no evidence this
 *  name is ever ambiguous", the same default every other REP_FIELDS
 *  consumer treats absence as (reps.js's own contract); guessing "boxed"
 *  here would deref a value that was never actually boxed.
 *
 *  Excludes the CURRENT function's own params: narrow.js's bigintBoxedVerdict
 *  comment is explicit that a param's `bigintBoxed=true` is consulted "by
 *  the call-site emitter, not by the callee body: once boxed, the callee
 *  simply carries an opaque pointer through" — coerceArg (emit.js) already
 *  boxes the ARGUMENT at every call site that needs it, so inside THIS
 *  function such a param's f64 slot already holds the box (or genuinely
 *  raw bits, if the actual call passed a non-bigint value — either way,
 *  opaque here). Re-running boxBigInt on it at a further sink (return,
 *  another store, …) would box the pointer's OWN bits as if they were a
 *  fresh bigint payload — a box-of-a-box, found live during this slice's
 *  own development (a `(x) => x` identity function repro) and fixed here
 *  at the single shared predicate rather than in each of carrierF64/
 *  'return'/'?:' separately. */
export const isProvenBoxedBigint = (name) =>
  repOf(name)?.bigintBoxed === true && !ctx.func.current?.params?.some(p => p.name === name)

/** Slice-2 def-side predicate: does this AST node, flowing into a W-sink,
 *  need to cross as a real PTR.BIGINT box? A bare name defers to its
 *  solver-settled rep (the whole-program fact — may resolve raw-forever);
 *  any other BIGINT-kinded expression reaching a sink has no binding to
 *  carry a rep, so analyze.js's own W-sink walk (markBigintSink) never
 *  tracks it — box unconditionally, matching the design's "inline
 *  expressions box at emission time directly from the AST shape, no rep
 *  needed" (round-3/4 §3.2, analyze.js's own comment above markBigintSink).
 *
 *  Excludes `'?:'` nodes from that unconditional fallback: a ternary's own
 *  BIGINT-via-nullish-carry (kind.js VT['?:']) is exactly the shape
 *  emit.js's dedicated '?:' handler already owns end-to-end (it boxes only
 *  the non-nullish arm, `if`/`else`-gated, never the merged whole) — asking
 *  THIS predicate to independently re-decide "does the whole merged node
 *  need a box" and wrap `emit(node)`'s already-correct result a second time
 *  is a real box-of-a-box (found live during this slice's own development,
 *  a `(cond, x) => cond ? x : null`-returning repro whose return-site
 *  wiring reboxed the ternary handler's own output). Every OTHER compound
 *  shape (`+`, `&&`, `||`, …) has no dedicated box-wiring of its own, so
 *  `emit(node)` never boxes internally there — the unconditional fallback
 *  stays correct for them. */
export const needsBigintBox = (node) => {
  if (typeof node === 'string') return isProvenBoxedBigint(node)
  return Array.isArray(node) && node[0] !== '?:' && valTypeOf(node) === VAL.BIGINT
}

// === CARRIER PROGRAM Slice 3 (R-recovery, read side) ===

/** True iff `name`'s f64 slot, INSIDE THIS FUNCTION, durably holds a real
 *  PTR.BIGINT box rather than raw i64-as-f64 bits — the exact inverse
 *  question isProvenBoxedBigint answers (that predicate is "still raw,
 *  needs boxing at a further sink"; this one is "already boxed, needs
 *  UNBOXING before raw i64 arithmetic touches it"). Per isProvenBoxedBigint's
 *  own doc comment, only a PARAM can be durably boxed on entry: coerceArg
 *  (emit.js) boxes the ARGUMENT at every call site whose callee param
 *  settled bigintBoxed=true (Slice 2), so the callee's param slot holds
 *  the caller's box from function entry onward — unlike a plain local,
 *  whose OWN slot always stays raw (Slice 2's W-sink wiring boxes a FRESH
 *  COPY at each qualifying use site — carrierF64/`return`/`'?:'` — never
 *  the local's own storage; reps.js's bigintBoxed doc comment states the
 *  DESIGN'S full intent as "boxed at the point of write, unboxed at every
 *  later read" — this predicate + readI64 below is that read-side half,
 *  scoped to the one case Slice 2 actually materializes a persistent box:
 *  params crossing the call ABI). */
export const isCurrentlyBoxedBigint = (name) =>
  repOf(name)?.bigintBoxed === true && !!ctx.func.current?.params?.some(p => p.name === name)

/** True iff `name` was declared directly from a ternary-nullish BIGINT merge
 *  (`let r = cond ? BigInt(x) : null`) — the ONE OTHER shape (besides a
 *  boxed param, isCurrentlyBoxedBigint above) whose "always stays raw" claim
 *  is false. That predicate's own doc comment is explicit that carrierF64/
 *  'return'/'?:' box a FRESH COPY "never the local's own storage" — true for
 *  carrierF64/'return' (the box exists only at the point of USE, e.g.
 *  storing `r` into an object property boxes a copy, `r` itself stays raw)
 *  but NOT for '?:': when a ternary-nullish BIGINT merge is a decl's own
 *  init, the merge's result — a real box on the bigint arm, the null/undef
 *  sentinel on the other — becomes the declared name's ENTIRE, PERMANENT
 *  storage from that point on; there never was a separate "raw bits" form of
 *  `r` to begin with. `bigintBoxed` (analyze.js markBigintSink) can't record
 *  this fact itself — it only fires for a BARE-NAME arm reaching a sink, and
 *  a ternary's own arm is almost always an inline expression (`BigInt(x)`,
 *  not a name) — so this is a SEPARATE fact, in a SEPARATE channel:
 *  ctx.func.ternaryBoxedNames, an emission-tier TRANSIENT Set (compile/
 *  index.js enterFunc, reset per function — NOT updateRep/the rep system;
 *  passes.js's own "emission tier never writes durable analysis state" exit
 *  grep is a real, checked invariant), populated by emitDecl (emit.js) at
 *  the one point it's cheaply and soundly knowable: right after compiling a
 *  decl whose init matches the '?:' handler's OWN (narrower) box condition —
 *  exactly one arm BIGINT, the other a nullish literal — NOT the broader
 *  kind.js VT['?:'] "both arms same kind" rule, which also types BIGINT for
 *  two non-nullish BIGINT arms (`neg ? -BigInt(mag) : BigInt(mag)`) that the
 *  '?:' handler leaves raw. Using the broad test here was itself a live bug
 *  (.work/carrier-representation-design.md §13/§14: registered watr/src/
 *  optimize.js's `_i64Canon` inline-argument temp as ternary-boxed though
 *  nothing was boxed, so readI64 below unboxed a raw value as a bogus
 *  pointer). Found live (the ORIGINAL incident this predicate exists for):
 *  watr-adjacent `let r = a > 0 ? BigInt(a) : null; return r == null ? 'x' :
 *  r.toString(16)` —
 *  `.bigint:toString`'s own readI64(n, emit(n)) call (module/number.js) is
 *  correctly wired, but couldn't see the box without this fact: `r` is a
 *  LOCAL, not a param, so isCurrentlyBoxedBigint alone missed it. */
export const isTernaryBoxedBigint = (name) => ctx.func.ternaryBoxedNames?.has(name) === true

/** Read-side twin of carrierF64: extract raw i64 bits from a BIGINT-typed
 *  operand, unboxing FIRST when the bare name's current representation is a
 *  real PTR.BIGINT box (isCurrentlyBoxedBigint or isTernaryBoxedBigint).
 *  Byte-identical to a plain asI64(emitted) call for every other shape —
 *  inline expressions, non-boxed locals, and (by construction) every param
 *  isProvenBoxedBigint would have boxed instead. The chokepoint the
 *  arithmetic core's ~10 VAL.BIGINT-gated `asI64(emit(x))` call sites route
 *  through (bigIntOperand/bigIntUnary and the postfix/compound-assign
 *  shortcuts that bypass them), plus method-dispatch consumers like
 *  `.bigint:toString` (module/number.js), so a boxed param OR ternary-boxed
 *  local never has its pointer bits misread as a bigint payload.
 *
 *  CONSERVATIVE PAIRING's own class (isSchemaSlotBigintPossible, above) is
 *  a THIRD, narrower shape this same chokepoint now also covers: a `.prop`
 *  read of a schema field this program can't PROVE uniformly BIGINT (so
 *  `emitted` stays the box-preserving f64 emitSchemaSlotRead's default arm
 *  always returned, unlike the two name-based predicates above, which
 *  select an ALREADY-i64-typed `emitted` at the read site itself). Checked
 *  last — after the two proven, static, zero-runtime-cost predicates — so
 *  a name that's ALSO a boxed param never pays the extra tag check its own
 *  static proof already made unnecessary. */
export function readI64(node, emitted) {
  if (CARRIER_BOX && typeof node === 'string' && (isCurrentlyBoxedBigint(node) || isTernaryBoxedBigint(node)))
    return unboxBigInt(emitted)
  if (isSchemaSlotBigintPossible(node)) return maybeUnboxBigInt(emitted)
  return asI64(emitted)
}

// === Nullish sentinels ===

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
export function carrierF64(node, emitted) {
  if (valTypeOf(node) === VAL.BOOL) return boolBoxIR(emitted)
  // Slice 2 (CARRIER PROGRAM, .work/carrier-representation-design.md §7) def-
  // side wiring — OFF by default (CARRIER_BOX), byte-identical to the prior
  // asF64-only body. carrierF64 is the design's own single W-sink choke-point
  // for boxed-value storage positions (bridge.js storedValue's whole reason
  // to exist — object/dyn-prop store, array-elem store, Set/Map, closure
  // capture all route their stored value through here): when proven, box
  // BEFORE the raw asF64 carrier would otherwise cross into that slot.
  if (CARRIER_BOX && needsBigintBox(node)) return boxBigInt(asI64(emitted))
  return asF64(emitted)
}

/** Narrow-admission twin of carrierF64 — same BOOL-atom-boxing contract
 *  (unconditional, unchanged), but for BIGINT admits ONLY the bare-name case
 *  independently proven by isProvenBoxedBigint — never carrierF64's OTHER
 *  (unconditional inline-expression) fallback. That fallback is sound at
 *  carrierF64's REAL W-sinks (a genuine heap object/array/Set/Map's dyn-prop
 *  or element store, closure-capture): storage a later, independently-
 *  compiled reader can only observe through registry-aware dynamic dispatch
 *  ($__dyn_get, iteration, …), which correctly recognizes a PTR.BIGINT box.
 *  Two call sites need this narrower admission instead, both found live by
 *  running test/watr.js's own self-hosted-through-jz battery under
 *  JZ_CARRIER_BOX=1 (the first real end-to-end BigInt-heavy-program pass
 *  Slice 2's own gates never ran — see .work/carrier-representation-
 *  design.md §11/§12):
 *
 *  1. emit.js 'return', when `ctx.func.boxedResult`/`mixedAtomReturn`
 *     ("boxes") is true. Neither flag is an interprocedural proof that any
 *     CALLER of the result expects a BigInt box (unlike params, where
 *     coerceArg/isCurrentlyBoxedBigint pair a call-site box with a
 *     callee-body unbox) — `boxedResult` is set unconditionally for EVERY
 *     closure-convention body regardless of whether THIS closure's own
 *     return is uniformly BIGINT, and `mixedAtomReturn` is a parallel,
 *     BOOL-only heuristic (its own doc comment at compile/index.js states
 *     plainly "every non-bool-mixed function... [is] untouched either way"
 *     as the pre-carrier-box contract). Found live: watr's own `compile.js`
 *     `limits()` — `is64 ? v => { if (typeof v === 'bigint') return v;
 *     return BigInt(v) } : parseUint` — the closure's `return BigInt(v)`
 *     boxed unconditionally (an inline expression, `boxes` true only because
 *     it's a closure body), then `uleb(parse(minVal), out)` called the box
 *     through `call_indirect` with NO statically-provable-BIGINT call site
 *     for narrow.js to seed `uleb`'s own param as bigintBoxed — `uleb`'s
 *     `n & 0x7Fn` read the pointer's own bits raw.
 *  2. emit.js's SRoA flat-object/array field init (`let o = {a: 1n}` — no
 *     heap alloc; every read/write rewrites to a plain `o#i` local, per its
 *     own comment). A flat field's value is emitted via storedValue for BOOL
 *     identity's sake (an untyped slot ANY dynamic dyn-shadow fallback might
 *     still observe) — but there is no such fallback for a name that never
 *     needed one to become flat in the first place, and the flat-field READ
 *     side (the `.`/`[]` flat hooks) reads the local's bits raw, with no
 *     unboxing. Found live: `let o = {n: 4611686018427387903n}; o.n++` —
 *     the object literal's OWN field initializer (a bare BIGINT LITERAL, no
 *     ambiguity whatsoever) got boxed on write into the flat local, then
 *     `o.n++`'s arithmetic (bigIntOperand/readI64, sound in isolation) read
 *     that local's bits raw, misreinterpreting the pointer as a payload.
 *
 *  Both are the SAME class of bug as needsBigintBox's own doc comment warns
 *  against generalizing beyond its verified sinks: a def-side box fired at a
 *  W-sink shape whose actual consumer isn't the registry-aware dynamic
 *  reader the unconditional fallback assumes. */
export function carrierF64Narrow(node, emitted) {
  if (valTypeOf(node) === VAL.BOOL) return boolBoxIR(emitted)
  if (CARRIER_BOX && typeof node === 'string' && isProvenBoxedBigint(node)) return boxBigInt(asI64(emitted))
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

// === Constants ===

/** Max arity of inline closure slots. Closures are compiled with signature
 *  (env f64, argc i32, a0..a{MAX-1} f64) → f64 — no per-call heap alloc.
 *  Direct (non-spread) calls with more args than MAX error. Spread calls are
 *  unbounded: the spread site publishes the full args-array offset in
 *  $__closure_spill, and a rest-param callee reads args[MAX..argc-1] from it
 *  (see module/function.js spread path + compile/index.js rest collection). */
export const MAX_CLOSURE_ARITY = 8

/** Matches WASM instructions that require a memory section. */
// Any instruction that touches linear memory ⇒ the module must declare memory.
// Matches every `memory.*` op (size/grow/copy/fill/init) and every typed load/store
// incl. width suffixes (load8_u, store16, i64.load32_s, v128.load, …). The old
// hand-enumerated list silently missed memory.copy/fill, v128.load/store and
// i64.store8/16/32 (all used in stdlib) — a body using only those would wrongly
// report no-memory. Broad-but-precise: only `memory.` and `<type>.load|store` match.
export const MEM_OPS = /\b(memory\.\w+|(?:i32|i64|f32|f64|v128)\.(?:load|store)\w*)\b/

export const WASM_OPS = new Set(['block','loop','if','then','else','br','br_if','call','call_indirect','return','return_call','throw','try_table','catch','nop','drop','unreachable','select','result','mut','param','func','module','memory','table','elem','data','type','import','export','local','global','ref'])
export const SPREAD_MUTATORS = new Set(['push', 'add', 'set', 'unshift'])
export const BOXED_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort'])

// === Pointer construction ===

const litI32 = n => Array.isArray(n) && n[0] === 'i32.const' && typeof n[1] === 'number' ? n[1] : null

/** Pack (type, aux, offset) into the f64 NaN-box bit pattern as a hex string. */
const packPtrBits = (type, aux, offset) => i64Hex(ptrBits(type, aux, offset))

/** Build `__mkptr(type, aux, offset)` IR. Folds to `(f64.const nan:0x...)` — 9 bytes
 *  vs 12 for `f64.reinterpret_i64 (i64.const ...)` — when all args are i32 literals.
 *  Args may be raw IR nodes or numbers (numbers are wrapped as i32.const). */
export function mkPtrIR(type, aux, offset) {
  const tIR = typeof type === 'number' ? ['i32.const', type] : type
  const aIR = typeof aux === 'number' ? ['i32.const', aux] : aux
  const oIR = typeof offset === 'number' ? ['i32.const', offset] : offset
  const tL = litI32(tIR), aL = litI32(aIR), oL = litI32(oIR)
  if (tL != null && aL != null && oL != null)
    return typed(['f64.const', 'nan:' + packPtrBits(tL, aL, oL)], 'f64')
  inc('__mkptr')
  return typed(['call', '$__mkptr', tIR, aIR, oIR], 'f64')
}

/** Offset extraction for a NaN-boxed pointer.
 *  Goes through `__ptr_offset`, which chases the relocation-forwarding chain
 *  (cap == -1 sentinel at off-4 → relocated offset at off-8). The chase is a
 *  single load+compare for any live (non-forwarded) header, so it is a no-op for
 *  fixed-shape receivers (OBJECT/TYPED/…) whose cap word is never -1.
 *
 *  We do NOT skip it for "non-ARRAY" static types: that shortcut was unsound on
 *  two counts. (1) ARRAY is not the only growable container — HASH/SET/MAP relocate
 *  too. (2) jz value types are not always precise: a binding inferred OBJECT (a
 *  polymorphic parameter, a widened union) can hold a relocated ARRAY at runtime.
 *  Writing through its stale pre-relocation base then clobbers whatever now occupies
 *  that freed region — a memory-safety hazard that must not depend on inference
 *  precision. Memory safety is unconditional; the forwarding follow stays.
 *  If the node is already an unboxed pointer (ptrKind), return it directly. */
export function ptrOffsetIR(valIR, valType) {
  if (valIR.ptrKind != null && valIR.ptrKind !== VAL.ARRAY) return valIR
  inc('__ptr_offset')
  return ['call', '$__ptr_offset', ['i64.reinterpret_f64', valIR]]
}

/** Map VAL.* → PTR.* when unambiguous. STRING is ambiguous (heap vs SSO). ARRAY maps
 *  to PTR.ARRAY but callers that want to skip forwarding must check separately. */
const VAL_TO_PTR = {
  array: PTR.ARRAY, object: PTR.OBJECT, set: PTR.SET, map: PTR.MAP,
  closure: PTR.CLOSURE, typed: PTR.TYPED, buffer: PTR.BUFFER, date: PTR.OBJECT,
}
export const valKindToPtr = (vt) => VAL_TO_PTR[vt]

/** Type-tag extraction for a NaN-boxed pointer. Unambiguous VAL → constant; known i32
 *  offset of a ptrKind → constant (no reinterpret); otherwise inline bit-extraction. */
export function ptrTypeIR(valIR, valType) {
  if (valIR.ptrKind != null) return typed(['i32.const', VAL_TO_PTR[valIR.ptrKind]], 'i32')
  const known = valType != null ? VAL_TO_PTR[valType] : undefined
  if (known != null) return ['i32.const', known]
  return ['i32.wrap_i64', ['i64.and',
    ['i64.shr_u', ['i64.reinterpret_f64', valIR], ['i64.const', 47]],
    ['i64.const', 0xF]]]
}

// SELF-HOST CONTRACT: f64 slot BITS travel as canonical '0x'+16-hex STRINGS.
// A BigInt crossing a function return / array element / object slot is
// kind-erased in the kernel (raw i64 bits are untagged) and every subsequent
// op on it misdispatches; BigInt64Array/BigUint64Array views and
// DataView.{get,set}BigUint64 are a legacy f64-value shim there. Strings are
// tagged and survive every boundary; BigInt math happens only inside single
// expressions. (Same contract as watr/optimize's i64 VALUE CONTRACT.)
const _F64_BITS_BUF = new ArrayBuffer(8)
const _F64_BITS_F = new Float64Array(_F64_BITS_BUF)
const _F64_BITS_U32 = new Uint32Array(_F64_BITS_BUF)  // LE halves: [0]=lo, [1]=hi
const _hx8 = (u) => (u >>> 0).toString(16).padStart(8, '0')

/** Return i64 bit pattern (BigInt) of a pure-literal IR node, or null if non-literal. */
export function extractF64Bits(node) {
  if (!Array.isArray(node)) return null
  if (node[0] === 'f64.const') {
    if (typeof node[1] === 'number') { _F64_BITS_F[0] = node[1]; return '0x' + _hx8(_F64_BITS_U32[1]) + _hx8(_F64_BITS_U32[0]) }
    if (typeof node[1] === 'string' && node[1].startsWith('nan:')) {
      try {
        const v = BigInt(node[1].slice(4)) | 0x7ff0000000000000n
        return '0x' + v.toString(16).padStart(16, '0')
      } catch { return null }
    }
    return null
  }
  if (node[0] === 'f64.reinterpret_i64' && Array.isArray(node[1]) && node[1][0] === 'i64.const' && typeof node[1][1] === 'string') {
    const s = node[1][1]
    if (s.startsWith('-')) {
      // Two's complement WITHOUT a 2^64 term: (-1 − |v|) + 1 ≡ 2^64 − |v| both
      // natively and on the kernel's mod-2^64 carrier (1n<<64n is unrepresentable
      // there and would silently corrupt).
      try {
        const v = (0xffffffffffffffffn - BigInt(s.slice(1)) + 1n) & 0xffffffffffffffffn
        return '0x' + v.toString(16).padStart(16, '0')
      } catch { return null }
    }
    try {
      const v = BigInt(s)
      return '0x' + v.toString(16).padStart(16, '0')
    } catch { return null }
  }
  return null
}

/** Append `slots` ('0x'+16-hex bit strings, see contract above) to
 *  ctx.runtime.data 8-byte aligned, return raw byte offset of first slot.
 *  Slots that look like NaN-boxed pointers are recorded in
 *  `ctx.runtime.staticPtrSlots` so the prefix-strip pass can patch their
 *  embedded offsets. Writes go through u32 halves — DataView's BigInt
 *  accessors are unfaithful in the self-host kernel. */
export function appendStaticSlots(slots, headerBytes = 0) {
  if (!ctx.runtime.data) ctx.runtime.data = ''
  while (ctx.runtime.data.length % 8 !== 0) ctx.runtime.data += '\0'
  const off = ctx.runtime.data.length
  const u8 = new Uint8Array(headerBytes + slots.length * 8)
  const dv = new DataView(u8.buffer)
  for (let i = 0; i < slots.length; i++) {
    const h = slots[i]
    dv.setUint32(headerBytes + i * 8, parseInt(h.slice(10), 16) >>> 0, true)
    dv.setUint32(headerBytes + i * 8 + 4, parseInt(h.slice(2, 10), 16) >>> 0, true)
  }
  let chunk = ''
  for (let i = 0; i < u8.length; i++) chunk += String.fromCharCode(u8[i])
  ctx.runtime.data += chunk
  if (!ctx.runtime.staticPtrSlots) ctx.runtime.staticPtrSlots = []
  for (let i = 0; i < slots.length; i++) {
    if ((parseInt(slots[i].slice(2, 6), 16) & 0xFFF8) === LAYOUT.NAN_PREFIX) {
      ctx.runtime.staticPtrSlots.push(off + i * 8)
    }
  }
  return off
}

// === Literal / purity checks ===

/** Check if emitted node is a compile-time constant. */
export const isLit = n => (n[0] === 'i32.const' || n[0] === 'f64.const') && typeof n[1] === 'number'
// Unchecked — the caller must have proven isLit(n) first. Distinct contract from
// loop-model.js's loopLitVal / prepare/index.js's local numLitVal (post-prepare-AST,
// not emitted-IR, and both validate the literal shape before extracting).
export const litVal = n => n[1]
export const isNullLit = n => Array.isArray(n) && n.length === 2 && n[0] == null && n[1] == null
export const isUndefLit = n => Array.isArray(n) && n.length === 0
export const isNullishLit = n => isNullLit(n) || isUndefLit(n)

/** Side-effect-free (safe for WASM select). */
const PURE_OPS = new Set(['i32.const', 'f64.const', 'local.get', 'global.get',
  'f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.neg', 'f64.abs', 'f64.sqrt',
  'i32.add', 'i32.sub', 'i32.mul', 'i32.and', 'i32.or', 'i32.xor',
  'f64.convert_i32_s', 'f64.convert_i32_u', 'i32.trunc_sat_f64_s',
  'i32.wrap_i64', 'i64.trunc_sat_f64_s', 'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge',
  'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.gt_s', 'i32.le_s', 'i32.ge_s', 'i32.eqz',
  'select'])   // select of pure operands: both arms evaluate eagerly, no trap/effect — a nested
               // select chain (the branchless arm-update accumulator) stays select all the way
export const isPureIR = n => Array.isArray(n) && PURE_OPS.has(n[0]) && n.slice(1).every(c => !Array.isArray(c) || isPureIR(c))

// Ops PURE_OPS admits into `select` (no trap, no effect) but whose LATENCY is high
// enough that eagerly computing an arm that would otherwise be skipped can lose to a
// well-predicted branch: f64.div and f64.sqrt are non-pipelined/10-40+ cycles on most
// cores, unlike the single-cycle add/mul/compare/bitwise set PURE_OPS otherwise admits.
// (i32.div_s/u, i32.rem_s/u, and any `call` are already excluded from PURE_OPS itself —
// they trap or aren't provably effect-free — so they never reach a select gate at all;
// only these two f64 ops are "pure but expensive".) A select-gate site must veto BOTH
// arms with this predicate before choosing `select` over the lazy `if`/`else` — checked
// recursively so a cascaded N-way ternary (each level itself a pure select) doesn't hide
// an expensive op several levels down (a single div anywhere in the chain forces every
// level above it to eagerly pay for it every time `select` nests arms eagerly).
const EXPENSIVE_PURE_OPS = new Set(['f64.div', 'f64.sqrt'])
export const hasExpensiveOp = n => Array.isArray(n) && (EXPENSIVE_PURE_OPS.has(n[0]) || n.some(hasExpensiveOp))

// A select's CONDITION is a cost axis distinct from hasExpensiveOp's ARMS. `&&`/`||`
// lower short-circuit evaluation to a value-`if` whenever eager (i32.and/i32.or) isn't
// sound or isn't cheap — canonically `x < n && a[x] < a[x+1]` (a bounds guard ANDed with
// a load-bearing compare) becomes `if (result i32) (local.tee $t cond1) (then f64.lt
// (load)(load)) (else (local.get $t))` (emit.js '&&', the i32 fast path). Feeding THAT
// as a select's condition means every iteration pays the load's latency plus the tee/get
// shuffle unconditionally — even on the (common) iterations where cond1 alone would have
// short-circuited a lazy if/else past the load entirely. Measured on sort's "pick larger
// child" (`child+1<n && a[child]<a[child+1]) ? child+1 : child`): branch-form surgery on
// exactly this shape closed ~all of a 1.115x gap vs zig-wasm (checksum-stable).
// Scoped narrowly to the shape that regressed: a nested value-`if` (the short-circuit
// lowering, not a plain multi-compare chain — those either collapse to i32.and/i32.eqz
// upstream or never touch memory) whose subtree carries a memory load. A cheap
// comparison-only flag (`(h & 1) === 0`, noise's gradient sign-flip) never builds this
// shape at all and must keep `select`; vetoing on load-freedom alone would wrongly catch
// pointer-typed local.get reads too, so this checks for actual load OPS, not pointers.
const hasLoadOp = n => Array.isArray(n) && (typeof n[0] === 'string' && MEM_OPS.test(n[0]) || n.some(hasLoadOp))
export const dataDependentFlag = n => Array.isArray(n) &&
  (n[0] === 'if' ? hasLoadOp(n) : n.some(dataDependentFlag))

/** Ops whose f64 result is always a plain number (never a NaN-boxed pointer).
 *  Used by toNumF64 to skip the __to_num wrapper when the value is provably numeric.
 *  NOTE: f64.const is NOT included — it may encode a NaN-boxed pointer. */
const PURE_F64_OPS = new Set([
  'f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.neg', 'f64.abs', 'f64.sqrt',
  'f64.min', 'f64.max', 'f64.ceil', 'f64.floor', 'f64.trunc', 'f64.nearest', 'f64.copysign',
  'f64.convert_i32_s', 'f64.convert_i32_u', 'f64.promote_f32',
])

/** True iff `r` provably yields a plain f64 NUMBER (never a NaN-boxed pointer or
 *  nullish sentinel). A `block`/`if` is numeric only when its value-producing tail
 *  is — so `o.a?.b` (a block whose result is a property value or undef sentinel)
 *  is correctly NOT numeric, while `cond ? n*2 : n*3` is. Conservative: any shape
 *  not provably numeric (property gets, user calls, local.get, f64.const nan:…)
 *  returns false, so the caller keeps the __to_num coercion. */
export const isNumericIR = (r) => {
  if (!Array.isArray(r)) return false
  const op = r[0]
  if (PURE_F64_OPS.has(op)) return true
  if (op === 'call' && typeof r[1] === 'string' && (r[1].startsWith('$math.') || r[1] === '$__time_ms')) return true
  if (op === 'f64.const') return typeof r[1] === 'number'   // 'nan:…' carrier ⇒ pointer/sentinel
  if (op === 'block') return isNumericIR(r[r.length - 1])   // block value = its tail expr
  if (op === 'if') {                                        // both arms must be numeric
    const thenArm = r.find(x => Array.isArray(x) && x[0] === 'then')
    const elseArm = r.find(x => Array.isArray(x) && x[0] === 'else')
    return !!thenArm && !!elseArm &&
      isNumericIR(thenArm[thenArm.length - 1]) && isNumericIR(elseArm[elseArm.length - 1])
  }
  return false
}

/** Resolve compile-time value type from AST node (literal → name → lookup). */
export const resolveValType = (node, valTypeOf, lookupValType) =>
  valTypeOf(node) ?? (typeof node === 'string' ? lookupValType(node) : null)

/** Check if (a, op, b) is a postfix pattern: [op, name] and [, 1] literal. */
export const isPostfix = (a, op, b) => Array.isArray(a) && a[0] === op && Array.isArray(b) && b[0] == null && b[1] === 1

/** Emit a numeric constant with correct i32/f64 typing.
 *  `-0` is f64-only (i32 has no signed zero) — preserve the sign by emitting f64. */
export const emitNum = v => isI32(v)
  ? typed(['i32.const', v], 'i32')
  // Emit NaN via the `nan` token, not the raw JS number: a numeric NaN literal in
  // the IR loses its quiet-mantissa bit (0x7FF8→0x7FF0, i.e. becomes Infinity) when
  // the self-host kernel marshals the IR back across the wasm→host boundary. The
  // `nan` token assembles to the canonical 0x7FF8 number-NaN unambiguously.
  : typed(['f64.const', v !== v ? 'nan' : v], 'f64')

// === Temp locals ===

/** Allocate a fresh local name with the given tag, registered as `type`. The
 *  selfhost compiler doesn't yet handle exported-const arrow factories returning
 *  closures, so the three temp() helpers stay as `function` declarations and
 *  delegate to this shared core. */
function freshLocal(type, tag) {
  let name
  do { name = `${T}${tag}${ctx.func.uniq++}` } while (ctx.func.locals.has(name))
  ctx.func.locals.set(name, type)
  return name
}
export function temp    (tag = '') { return freshLocal('f64', tag) }
export function tempI32 (tag = '') { return freshLocal('i32', tag) }
export function tempI64 (tag = '') { return freshLocal('i64', tag) }

// === IR scaffolds ===

/** Wrap a sequence of statements as a typed `(block (result <type>) …)`.
 *  Default result is `f64` (the value-type for most jz emissions).
 *  Shorthand for the `typed(['block', ['result', T], …stmts], T)` pattern that
 *  appears in nearly every emitter — keeps call sites focused on the body. */
export const block64 = (...stmts) => typed(['block', ['result', 'f64'], ...stmts], 'f64')
export const blockTyped = (type, ...stmts) => typed(['block', ['result', type], ...stmts], type)

/** Allocate an f64 temp, set it to `val`, run `body(name)` and yield its result.
 *  `body` may return either a single IR node (used as the block result) or an
 *  array of nodes whose last expression becomes the result. Eliminates the
 *  repetitive `const t = temp(); …['local.set', $t, val]; …['local.get', $t]`
 *  scaffold around tee-and-use patterns. */
export function withTemp(val, body, tag = '') {
  const t = temp(tag)
  const out = body(t)
  const tail = Array.isArray(out) && out.every(n => Array.isArray(n)) ? out : [out]
  return block64(['local.set', `$${t}`, val], ...tail)
}

/** Whole-fn structural refcount: walks `fn`, counting how many times each
 *  array node is referenced. Used by optimizer passes to skip shared subtrees
 *  (watr CSE may leave them) — mutating a node with refcount > 1 would also
 *  affect references outside the current region. Single-pass O(N). */
export function buildRefcount(fn) {
  const refcount = new Map()
  const walk = (node) => {
    if (!Array.isArray(node)) return
    const n = (refcount.get(node) || 0) + 1
    refcount.set(node, n)
    if (n > 1) return  // already counted children below
    for (let i = 0; i < node.length; i++) walk(node[i])
  }
  walk(fn)
  return refcount
}

/** Pick the next free `$__<prefix><id>` local-name id by collecting all
 *  existing ids in a single walk. Replaces the per-pass
 *  `while (fn.some(... === $__prefixK)) k++` (O(K·N)) with one O(N) scan. */
export function nextLocalId(fn, prefix) {
  // HIGH-WATER mark (max existing + 1), NOT the first free id. Callers allocate sequentially
  // (id++), so a first-gap start would walk straight into an existing higher local once watr's
  // coalesce has left non-contiguous numbering (e.g. $__pe0,$__pe1,$__pe5 → start at 2, then
  // mint 3,4,5 and collide on $__pe5 = "Duplicate local"). High-water is always collision-free.
  const needle = `$__${prefix}`
  let id = 0
  const walk = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith(needle)) {
      const tail = n[1].slice(needle.length)
      if (/^\d+$/.test(tail)) { const k = +tail; if (k >= id) id = k + 1 }
    }
    for (let i = 0; i < n.length; i++) walk(n[i])
  }
  walk(fn)
  return id
}

/** Single-kind ptr-tag predicate: `__ptr_type(bits) == ptr`. Takes the f64
 *  carrier expression and the PTR constant. Use this when guarding one branch;
 *  use `dispatchByPtrType` for multi-case forks. Stamps `inc('__ptr_type')`. */
export function ptrTypeEq(f64Expr, ptr) {
  inc('__ptr_type')
  return typed(['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', f64Expr]], ['i32.const', ptr]], 'i32')
}

/** ToPrimitive sidecar probe (ES2024 7.1.1): an own `valueOf`/`toString` data
 *  property shadows the builtin. Reads the dynamic-prop sidecar slot keyed by
 *  `nameIR` (an emitted i64 string key) off receiver `objIR`; if it holds a
 *  closure, yields `onOverride($p)`, else `onFallback($o)` (both f64). Shared by
 *  the member-READ path (module/core.js — onOverride returns the closure value,
 *  onFallback calls the arity-≤1 builtin) and the method-CALL path (emit.js —
 *  onOverride invokes the closure, onFallback calls the builtin method). */
export function sidecarOverride(objIR, nameIR, onOverride, onFallback) {
  const o = temp('vo'), p = temp('vp')
  inc('__dyn_get_expr', '__ptr_type')
  // Primitive receivers can never carry an own property that shadows a
  // builtin (numbers: no props at all; strings: property writes drop —
  // module/collection.js STRING arms), so the override probe is statically
  // futile for them. One inline number test + tag test skips the 3-frame
  // __dyn_get_expr chain — parser loops calling s.charCodeAt through an
  // unproven receiver were paying it per character (jessie: 1.19M/run at
  // one site). The or's second operand reads garbage tag bits when the
  // first is true (real number) — harmless, the or is already decided.
  return block64(
    ['local.set', `$${o}`, asF64(objIR)],
    ['local.set', `$${p}`, ['if', ['result', 'f64'],
      ['i32.and',
        ['f64.ne', ['local.get', `$${o}`], ['local.get', `$${o}`]],
        ['i64.ne',
          ['i64.and', ['i64.reinterpret_f64', ['local.get', `$${o}`]], ['i64.const', i64Hex(BigInt(LAYOUT.TAG_MASK) << BigInt(LAYOUT.TAG_SHIFT))]],
          ['i64.const', i64Hex(BigInt(PTR.STRING) << BigInt(LAYOUT.TAG_SHIFT))]]],
      ['then', ['f64.reinterpret_i64',
        ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', ['local.get', `$${o}`]], nameIR]]],
      ['else', undefExpr()]]],
    ['if', ['result', 'f64'],
      ptrTypeEq(['local.get', `$${p}`], PTR.CLOSURE),
      ['then', onOverride(p, o)],
      ['else', onFallback(o)]])
}

/** Dispatch on `__ptr_type(bits)` — emits a right-leaning if/else chain over
 *  PTR constants. `cases` is `[[PTR.X, ir], …]`; `fallback` is the else IR.
 *  `resultType` defaults to `'f64'`; pass `null` for a void dispatch (e.g.
 *  pure memory-writing branches). Centralizes the
 *  `i32.eq (call $__ptr_type bits) (i32.const PTR.X)` pattern so emitters
 *  dispatching by pointer kind stay declarative. */
export function dispatchByPtrType(typeLocal, cases, fallback, resultType = 'f64') {
  let out = fallback
  const head = resultType ? ['if', ['result', resultType]] : ['if']
  for (let i = cases.length - 1; i >= 0; i--) {
    const [ptr, ir] = cases[i]
    out = [...head,
      ['i32.eq', ['local.get', `$${typeLocal}`], ['i32.const', ptr]],
      ['then', ir],
      ['else', out]]
  }
  return out
}

// === Numeric helpers ===

/** WASM has no f64.rem — implement as a - trunc(a/b) * b.
 *  Both `a` and `b` appear twice in the expansion; cache non-pure operands
 *  in locals so side effects (e.g. assignments) only execute once. */
// JS `%` on the f64 path. Delegates to the exact `__rem` (binary fmod) stdlib —
// the textbook `a - b*trunc(a/b)` is inexact for large a/b and wrong on the
// ±Inf / 0 / NaN edges. The i32.rem_s fast path in emit.js handles the common
// integer-with-nonzero-literal-divisor case; everything else lands here.
export const f64rem = (a, b) => (inc('__rem'), typed(['call', '$__rem', a, b], 'f64'))

/** Resolve the slot index of a ToPrimitive method (`valueOf`/`toString`) on an
 *  OBJECT operand — from a schema-bound variable or an inline object literal.
 *  Returns -1 when the method is absent. */
function primMethodIdx(node, name) {
  if (typeof node === 'string') return ctx.schema.slotOf(node, name)
  const sid = objLiteralSchemaId(node)
  const props = sid != null ? ctx.schema.list[sid] : null
  return props ? props.indexOf(name) : -1
}

/** Emit the ES `OrdinaryToPrimitive` method-fallback chain for an OBJECT operand,
 *  returning an i64 IR node holding the resulting primitive — or null when the
 *  object exposes none of the hinted methods. `order` is the method-try order
 *  (number hint → [valueOf,toString]; string hint → [toString,valueOf]). Each
 *  present method is called in turn: a primitive result short-circuits out, a
 *  non-primitive (object) result falls through to the next method, and if every
 *  method yields a non-primitive a TypeError is thrown — the spec algorithm. */
function toPrimitiveChain(node, v, order) {
  const present = order.map(name => primMethodIdx(node, name)).filter(i => i >= 0)
  if (!present.length) return null
  ctx.runtime.throws = true
  inc('__is_object')
  const blk = `$tp${ctx.func.uniq++}`
  const prim = tempI64('prim')
  const optr = tempI32('op')
  // Resolve the object's data pointer once — `v` may carry side effects and is
  // referenced once per method slot below.
  const body = [['result', 'i64'],
    ['local.set', `$${optr}`, ptrOffsetIR(v, VAL.OBJECT)]]
  for (const idx of present) {
    const method = typed(ctx.abi.object.ops.load(['local.get', `$${optr}`], idx), 'f64')
    body.push(
      ['local.set', `$${prim}`, asI64(ctx.closure.call(method, []))],
      ['br_if', blk, ['local.get', `$${prim}`],
        ['i32.eqz', ['call', '$__is_object', ['local.get', `$${prim}`]]]])
  }
  // Every method returned a non-primitive — `Cannot convert object to primitive`.
  body.push(['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['f64.const', ERR.TO_PRIMITIVE]]], ['throw', '$__jz_err', ['f64.const', ERR.TO_PRIMITIVE]])
  return typed(['block', blk, ...body], 'i64')
}

/** Structural clone of an already-emitted IR node. Two DIFFERENT positions in the
 *  final tree must never share one node object: a later pass (CSE, peephole, local
 *  renumbering) that walks the tree and mutates/tags a node in place only sees ONE
 *  of the two logical occurrences and silently mutates both — the exact "IR-aliasing"
 *  hazard multiple emit sites must avoid when a value is READ into more than one
 *  branch of an if/else or more than one argument position. Caller's responsibility:
 *  the node must be side-effect-free to duplicate (a local/cell read, not a call) —
 *  see coerceNullishToNum below for the established idiom. Does not preserve `.type`/
 *  `.ptrKind` (a plain array map): every consumer of a cloned node already re-derives
 *  those from context (`node?.type ? node : typed(node, 'f64')`), so this only needs
 *  to reproduce the value-computing shape, not its cached metadata. */
export const cloneIR = (n) => Array.isArray(n) ? n.map(cloneIR) : n

/** ToNumber for a runtime value that may carry a nullish sentinel: null→+0, undefined→NaN,
 *  anything else → itself. `valIR` must be side-effect-free (a local read) — it is duplicated,
 *  so each occurrence gets a fresh clone. Used for bindings flagged in ctx.func.maybeNullish;
 *  a real number isn't either sentinel, so it falls through the `else` unchanged. */
export const coerceNullishToNum = (valIR) => typed(
  ['if', ['result', 'f64'],
    ['i64.eq', ['i64.reinterpret_f64', cloneIR(valIR)], ['i64.const', NULL_NAN]],
    ['then', ['f64.const', 0]],
    ['else', ['if', ['result', 'f64'],
      ['i64.eq', ['i64.reinterpret_f64', cloneIR(valIR)], ['i64.const', UNDEF_NAN]],
      ['then', ['f64.const', 'nan']],
      ['else', cloneIR(valIR)]]]],
  'f64')

/** ToString for an i64 string carrier that may hold the UNDEF_NAN sentinel:
 *  undefined→"undefined", anything else → itself. The STRING-domain mirror of
 *  coerceNullishToNum just above — same "`valIR` must be side-effect-free, it
 *  is duplicated" contract — but only ONE sentinel arm (never NULL_NAN: this
 *  design's whole census/maybeUndefined machinery is specifically about a
 *  dict/Map absent-key read, which is real JS `undefined`, never `null` —
 *  matching toNumF64's own NUMBER-census widening, which is likewise gated
 *  to NUMBER only, never both nullish kinds). "undefined" reuses the fixed
 *  static-string table module/number.js already builds for every OTHER
 *  nullish/NaN-to-string site in the codebase (`__static_str(6)` — see its
 *  own doc comment for the full index table) rather than a new string-
 *  constant mechanism: MAX_SSO=6 can't hold 9-char "undefined" inline
 *  (ssoStrI64 below is not an option), and this file's NO-EMIT contract
 *  (module/string.js imports FROM here, so the reverse import would cycle —
 *  see ssoStrI64's own doc) blocks reaching `emit(['str', …])` for a fresh
 *  data-segment literal. `inc('__static_str')` is the established, ALREADY-
 *  used-from-outside-its-owning-module precedent (module/atomics.js's
 *  `Atomics.wait`, which pulls the SAME helper the same way for its
 *  'ok'/'not-equal'/'timed-out' results) — safe here because every call site
 *  of toStrI64's widening below is itself a STRING-coercion context
 *  (String()/template-literal/`+`-concat), which autoload.js's own MOD_DEPS
 *  already makes depend on 'number' before 'string' loads, so `__static_str`
 *  is always registered by the time this runs. */
export const coerceNullishToStr = (valIR) => {
  inc('__static_str')
  return typed(
    ['if', ['result', 'i64'],
      ['i64.eq', cloneIR(valIR), ['i64.const', UNDEF_NAN]],
      ['then', typed(['i64.reinterpret_f64', ['call', '$__static_str', ['i32.const', 6]]], 'i64')],
      ['else', cloneIR(valIR)]],
    'i64')
}

/** Coerce an emitted IR value to a plain f64 Number per JS `ToNumber`.
 *  Skips coercion when static type proves the value is already numeric
 *  (i32 node, compile-time literal, known VAL.NUMBER/VAL.BIGINT). When the full
 *  string-parsing `__to_num` isn't loaded (no string module → no strings can
 *  exist) nullish *literals* still fold statically (null→+0, undefined→NaN);
 *  non-literal values pass through uncoerced — except bindings flagged
 *  maybeNullish, which get a runtime nullish coerce (null-flow correctness). */
export function toNumF64(node, v) {
  // An i32 node carrying `.ptrKind` is an *unboxed pointer* (object/array local),
  // not a number — skipping coercion would reinterpret pointer bits as an f64.
  // Only a plain i32 (loop counter, `x|0`) is genuinely already-numeric.
  if ((v.type === 'i32' && v.ptrKind == null) || isLit(v)) return asF64(v)
  // A DIRECT sentinel const (a statically-proven-OOB read folds straight to
  // UNDEF, no if-form) coerces per ToNumber before the vt fast-outs below —
  // valTypeOf claims NUMBER from the receiver's element type, blind to the
  // OOB path, and the raw payload would ride f64 arithmetic out as `undefined`.
  if (Array.isArray(v) && v[0] === 'f64.const' && typeof v[1] === 'string') {
    if (v[1] === `nan:${UNDEF_NAN}`) return typed(['f64.const', 'nan'], 'f64')
    if (v[1] === `nan:${NULL_NAN}`) return typed(['f64.const', 0], 'f64')
  }
  // Checked typed-array read (`.typed:[]` tags checkedNumRead): number|undefined
  // with the undefined confined to a CONSTANT miss arm. ToNumber of that arm
  // folds statically (undefined → canonical NaN) — the hit arm is already a
  // plain-number load. Without the fold the UNDEF sentinel enters f64 arithmetic
  // as a "number" (valTypeOf claims NUMBER from the ELEMENT type, blind to the
  // OOB path — checked BEFORE the vt fast-outs below for exactly that reason),
  // and hardware NaN propagation carries its PAYLOAD to the escape, where the
  // boundary decodes it back as `undefined` (JS: NaN).
  if (v.checkedNumRead && Array.isArray(v)) {
    const foldArm = (n) => Array.isArray(n) && n[0] === 'f64.const' && n[1] === `nan:${UNDEF_NAN}`
      ? ['f64.const', 'nan'] : n
    if (v[0] === 'if')   // (if (result f64) cond (then load) (else UNDEF))
      return typed(v.map(c => Array.isArray(c) && c[0] === 'else' && c.length === 2
        ? ['else', foldArm(c[1])] : c), 'f64')
    if (v[0] === 'block') {   // (block (result f64) …sets (select load UNDEF in))
      const tail = v[v.length - 1]
      if (Array.isArray(tail) && tail[0] === 'select')
        return typed([...v.slice(0, -1), ['select', tail[1], foldArm(tail[2]), tail[3]]], 'f64')
    }
  }
  // A binding assigned a nullish literal may hold null/undefined here — coerce per ToNumber
  // (null→+0, undefined→NaN); a real number falls through unchanged. Only flagged bindings pay
  // this, so the numeric kernels jz optimizes for (which never assign null) stay untouched.
  if (typeof node === 'string' && ctx.func.maybeNullish?.has(node)) return coerceNullishToNum(asF64(v))
  const vt = valTypeOf(node)
  if (vt === VAL.BOOL) return typed(['f64.convert_i32_s', truthyIR(v)], 'f64')
  // Slice 7 widening (.work/todo.md §deletion-sweep §14/§15's own
  // honest-boundary gap): `vt` stays permanently null for a decl/param/capture-
  // hopped census-NUMBER claim (§14 point 3 — `val` never carries a census
  // claim, by construction) even though `presentVal` (Slice 6, kind.js
  // `censusMaybeUndefinedKind`) already proves the exact same "every value
  // ever WRITTEN was NUMBER" fact the branch below already trusts once
  // `valTypeOf` itself happens to prove it (currently only the param case,
  // where `val` IS `vt`'s own source — see that function's own doc comment).
  // Consult it directly instead of waiting on `vt`, strictly for NUMBER —
  // never BIGINT, for the exact reason the comment just below stays unchanged
  // (ToNumber(bigint) throws in real JS; this whole family stays as
  // permissively unsound for BIGINT as it always was, not newly closed here).
  const censusNum = vt == null && censusMaybeUndefinedKind(node) === VAL.NUMBER
  if (vt === VAL.NUMBER || vt === VAL.BIGINT || censusNum) {
    // maybeUndefined join (.work/todo.md §deletion-sweep §1a): a dict-census
    // NUMBER claim is a "every value ever WRITTEN" fact, not a "this key
    // exists" proof — an absent key reads real `undefined` at runtime. Gated
    // on VAL.NUMBER only (never BIGINT: real JS THROWS mixing BigInt and
    // undefined in arithmetic, coerceNullishToNum's undefined→NaN answer
    // would be wrong there — left exactly as unsound as today, not newly
    // broken, not closed by this fix). censusMaybeUndefined short-circuits on
    // node[0] before touching ctx.func.localReps, so every proven-NUMBER
    // site that isn't a dict-mode `[]`/`.` read (loop counters, schema slots,
    // the overwhelming hot-path case) pays zero new cost — same node object,
    // same asF64(v) call, no new branch taken.
    if ((vt === VAL.NUMBER || censusNum) && censusMaybeUndefined(node)) {
      // coerceNullishToNum's OWN contract (its doc comment above): `valIR`
      // "must be side-effect-free... it is duplicated". True for the dict/
      // Map direct-read shape (censusShapedNode) and a bare name (a local
      // read) — both pure. NOT true for kind.js's call-result arm
      // (censusMaybeUndefinedKind's `callResultMayBeUndefinedKind` fallback,
      // .work/todo.md §deletion-sweep §5 criterion 3): an arbitrary
      // function call can have real side effects, and cloneIR's triplication
      // would fire them 3x. Found LIVE (not assumed): a captured-mutation
      // counter incremented 3x instead of once when its value flowed through
      // a non-inlined callee's return before reaching `+`. Hoist into a temp
      // FIRST so cloneIR only triplicates a cheap `local.get` — one
      // evaluation, sound for every node shape, byte-identical to before for
      // the two ORIGINAL (pure) arms since this branch is skipped for them.
      // KEPT through the Slice-4 VT-wiring revert (audit #10, §14 is the
      // re-enablement path): `vt === VAL.NUMBER` for a call node requires
      // `func.valResult` to have already settled NUMBER for a census-shaped
      // return tail, which itself requires the reverted VT promotion — so
      // this whole branch is unreachable with VT dormant, sound-but-inert,
      // same status as kind.js's callResultMayBeUndefinedKind it protects.
      if (typeof node !== 'string' && !censusShapedNode(node)) {
        const t = temp('cnn')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${t}`, asF64(v)],
          coerceNullishToNum(typed(['local.get', `$${t}`], 'f64'))], 'f64')
      }
      return coerceNullishToNum(asF64(v))
    }
    return asF64(v)
  }
  if (vt === VAL.DATE) {
    const ptr = v.ptrKind === VAL.DATE
      ? v
      : ['i32.wrap_i64', ['i64.reinterpret_f64', asF64(v)]]
    return typed(['f64.load', ptr], 'f64')
  }
  // ToPrimitive (number hint): an OBJECT operand coerces through the
  // `OrdinaryToPrimitive` method chain [valueOf, toString] — `valueOf` is tried
  // first, and when it yields a non-primitive `toString` is tried; if both
  // yield non-primitives a TypeError is thrown. The chosen primitive still
  // flows through `__to_num` so a string return ("−7") is parsed. An abrupt
  // completion (throwing method) propagates through the closure call.
  if (vt === VAL.OBJECT && ctx.closure.call && ctx.schema.slotOf) {
    const prim = toPrimitiveChain(node, v, ['valueOf', 'toString'])
    if (prim) {
      // No `__to_num` helper → the program provably has no strings, so the
      // primitive is a non-string value already usable as an f64.
      if (!ctx.core.stdlib['__to_num']) return asF64(prim)
      inc('__to_num')
      return typed(['call', '$__to_num', prim], 'f64')
    }
  }
  // intCertain locals: every reachable def is integer-valued, so the binding
  // never carries a NaN-boxed pointer — skip the __to_num wrapper.
  if (typeof node === 'string' && repOf(node)?.intCertain === true) return asF64(v)
  // intCertain schema slot reads `o.x`: every observed write is integer-shaped,
  // so the loaded f64 is a plain number — same justification as the local case.
  if (Array.isArray(node) && node[0] === '.' && typeof node[1] === 'string' && typeof node[2] === 'string') {
    if (ctx.schema.slotIntCertainAt?.(node[1], node[2]) === true) return asF64(v)
  }
  // Guarded schema-slot read whose ONE schema censuses the slot NUMBER
  // (emitSchemaSlotGuarded's stamp): SINK the coercion into the arms — the
  // guard-HIT raw load is already a plain number; only the dyn-miss arm pays
  // __to_num. The shapes-dispatch pattern (`measure(o)` over 8 schemas) drops
  // a per-field ToNumber call from every hot read this way.
  if (v.guardedNumSlot && Array.isArray(v) && v[0] === 'if') {
    const out = v.map((c, i) => {
      if (Array.isArray(c) && c[0] === 'else' && c.length === 2) {
        if (!ctx.core.stdlib['__to_num']) return c
        inc('__to_num')
        return ['else', typed(['call', '$__to_num', asI64(typed(c[1], 'f64'))], 'f64')]
      }
      return c
    })
    return typed(out, 'f64')
  }
  // IR-level shapes that produce real f64 numbers (never NaN-boxed pointers):
  // i32→f64 conversions, stdlib clock helper, length/ptr helpers.
  // Skip the __to_num call wrapper for these — they always return plain f64.
  if (Array.isArray(v)) {
    if (v[0] === 'f64.convert_i32_s' || v[0] === 'f64.convert_i32_u') return v
    if (v[0] === 'call' && v[1] === '$__time_ms') return v
    // __length, __str_len return f64.convert_i32_s of an i32 — never a boxed pointer.
    if (v[0] === 'call' && (v[1] === '$__length' || v[1] === '$__len' || v[1] === '$__str_len')) return v
    // __ptr_type returns i32 tag, __ptr_offset returns i32 offset — both numeric.
    if (v[0] === 'call' && (v[1] === '$__ptr_type' || v[1] === '$__ptr_offset')) return v
  }
  // f64 arithmetic ops and math intrinsics never produce NaN-boxed pointers — the
  // result is always a plain f64 number. Skip __to_num for these, eliminating the
  // call overhead that dominates tight numeric kernels (floatbeats, matrix loops).
  // A `block`/`if` qualifies only when its value-producing tail is provably numeric
  // (`isNumericIR`): `cond ? n*2 : n*3` skips, but `o.a?.b` (block yielding a
  // property value / undef sentinel) does NOT — else `o.a?.b > 6` would compare the
  // boxed string's NaN bits (NaN > 6 → false). User function calls are excluded too
  // (may return dynamic-property strings); only $math.* is provably numeric.
  if (v.type === 'f64' && Array.isArray(v) && (
    PURE_F64_OPS.has(v[0]) ||
    (v[0] === 'call' && typeof v[1] === 'string' && v[1].startsWith('$math.')) ||
    ((v[0] === 'block' || v[0] === 'if') && isNumericIR(v))
  )) return v
  if (!ctx.core.stdlib['__to_num']) {
    // No full ToNumber helper loaded — the program provably has no strings.
    // A nullish *literal* still coerces (null→+0, undefined→NaN) — fold it
    // statically so `Math.log10(null)` & friends are correct at zero cost.
    // Non-literal values fall through to `asF64`: an untyped runtime value
    // *could* be a nullish sentinel, but blanket per-use coercion taxes every
    // numeric kernel (fib, math loops) — nullable-param coercion belongs once
    // at the function boundary (null-flow inference), not at each use site.
    const f = asF64(v)
    if (Array.isArray(f) && f[0] === 'f64.const' && typeof f[1] === 'string') {
      const lit = f[1]
      if (lit.startsWith('nan:'))                           // NaN-boxed sentinel/pointer
        return typed(['f64.const', lit.slice(4) === NULL_NAN ? 0 : 'nan'], 'f64')
    }
    return f
  }
  inc('__to_num')
  // Inline number fast path (the engines' move): every non-NaN f64 IS its own
  // ToNumber — only NaN bit patterns (all NaN-boxed pointers + sentinels, plus
  // genuine NaN) take the call. One self-compare against a call per site; the
  // dictionary-count idiom (`o[k] | 0` on a number-or-undefined slot) drops a
  // per-token call this way. Optimize-gated: the O0 tier keeps the compact call.
  // EXCEPT a boxed BigInt carrier: unlike every other non-number kind it is raw
  // i64 bits reinterpreted as f64, never NaN-boxed, so it also passes "not NaN"
  // and must NOT take this shortcut unconverted. Only PAY for that extra check
  // (same magnitude heuristic TYPEOF.bigint uses, emit.js: finite, nonzero,
  // subnormal abs) in a program that can actually construct a BigInt anywhere
  // (ctx.features.bigint, set once by prep()'s universal per-node scan on the
  // sole two construction sites — a bigint literal or a `BigInt(x)` call) — a
  // program with zero BigInt construction can never produce that carrier, so
  // every dynamic coercion in it (e.g. an untyped array element read) is sound
  // under the plain NaN check alone. Un-gated this taxed every hot-loop numeric
  // coercion whether or not the program ever touches BigInt (ring/fgather
  // perf-ratchet regression, .work/todo.md).
  if ((ctx.transform.optFlags & OPTF.inlineToNum)) {
    const t = temp('tnum')
    const get = () => ['local.get', `$${t}`]
    const notNan = ['f64.eq', get(), get()]
    const cond = ctx.features.bigint
      ? ['i32.and', notNan, ['i32.eqz', ['i32.and',
          ['f64.ne', get(), ['f64.const', 0]],
          ['f64.lt', ['f64.abs', get()], ['f64.const', 2.2250738585072014e-308]]]]]
      : notNan
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(v)],
      ['if', ['result', 'f64'],
        cond,
        ['then', get()],
        ['else', ['call', '$__to_num', ['i64.reinterpret_f64', get()]]]]], 'f64')
  }
  return typed(['call', '$__to_num', asI64(v)], 'f64')
}

/** Coerce an emitted IR value to a jz string per JS `ToString`, returning an
 *  i64 string value. The mirror of `toNumF64` for the string hint: an OBJECT
 *  operand coerces through `OrdinaryToPrimitive(string)` — method chain
 *  [toString, valueOf], `toString` first with fallback to `valueOf`, TypeError
 *  if both yield non-primitives. The chosen primitive still flows through
 *  `__to_str` so a numeric return is rendered. A throwing method propagates as
 *  an abrupt completion through the closure call. */
export function toStrI64(node, v) {
  const vt = valTypeOf(node)
  // §16→§18 STRING-census widening (.work/todo.md §deletion-sweep):
  // mirrors toNumF64's NUMBER-census widening (38dd0dca) for the
  // STRING case. Two shapes both currently fall all the way through to the
  // fully generic `__to_str` dynamic dispatch at the bottom of this function
  // whenever `censusMaybeUndefined(node)` is true: a decl/param-hopped
  // STRING-census claim (`vt` stays permanently null — §14 point 3, `val`
  // never carries a census claim for that shape; `censusMaybeUndefinedKind`
  // proves it instead, via `presentVal`/`val` fallback) and a param whose
  // ordinary `val` fold happens to land STRING (the one shape where `vt`
  // itself already proves it, mirroring toNumF64's own "the param case,
  // where `val` IS `vt`'s own source"). §16 found this ALREADY CORRECT (the
  // generic `__to_str` stdlib helper's own UNDEF_NAN branch already renders
  // "undefined") — this is a pure codegen improvement, value-neutral, same
  // class as 38dd0dca: route both through a cheap 2-branch sentinel dispatch
  // (coerceNullishToStr, above) instead of the full dynamic dispatch call.
  const censusStr = vt == null && censusMaybeUndefinedKind(node) === VAL.STRING
  if ((vt === VAL.STRING || censusStr) && censusMaybeUndefined(node)) {
    // Same triplication-safety concern toNumF64's own widening documents: a
    // direct census-shaped read or a bare-name copy-through is pure
    // (cloneIR-safe to duplicate inside coerceNullishToStr's if/else), but
    // the call-result arm (censusMaybeUndefinedKind's `callResultMayBeUndefinedKind`
    // fallback) can carry real side effects — hoist into a temp first so
    // only a cheap `local.get` gets duplicated.
    if (typeof node !== 'string' && !censusShapedNode(node)) {
      const t = tempI64('cns')
      return typed(['block', ['result', 'i64'],
        ['local.set', `$${t}`, asI64(v)],
        coerceNullishToStr(typed(['local.get', `$${t}`], 'i64'))], 'i64')
    }
    return coerceNullishToStr(asI64(v))
  }
  // ToString(string) is the identity — no coercion needed, no __to_str call.
  // Without this, a proven-string operand (a template-literal interpolation
  // `${s}`, module/string.js strcat's partStrI64) still paid for the fully
  // generic __to_str dispatch, dragging its NUMBER arm's Ryu float formatter
  // (__ftoa/__ftoa_shortest/__ryu_*) into any module with a dynamic template
  // literal — even one that never stringifies a number.
  // maybeUndefined join (.work/todo.md §deletion-sweep §1/Slice 5): a
  // dict-census STRING claim (every value ever WRITTEN through `name[k]=v`
  // was a string) is, same as the NUMBER claim toNumF64 already guards,
  // "every value ever written" — NOT "this key exists". An absent key reads
  // real `undefined` at runtime regardless of the census's claimed kind, so
  // `vt === VAL.STRING` here can be TRUE while `v`'s actual bits are
  // UNDEF_NAN. Module/string.js's `bind('String', …)` calls THIS function
  // believing it already routes maybeUndefined-flagged reads through the
  // general __to_str path (its own comment: "falls through to the LAST
  // branch... already correct") — true for a NUMBER-kind census (that
  // belief is what motivated skipping the __ftoa arm), but this STRING-kind
  // identity fast-return was an UNGUARDED early return ABOVE that same LAST
  // branch, so a STRING-census absent key hit IT first: `asI64(v)` reinterprets
  // the raw UNDEF_NAN bits as if they were a valid string i64, which decodes
  // back out as the bare `undefined` VALUE, not the string `"undefined"` —
  // confirmed live (String() AND template-literal interpolation both), found
  // during the Slice 5 site survey. Fixed at THIS chokepoint (not the
  // caller) so every caller (String(), strcat's per-part loop) inherits it.
  if (vt === VAL.STRING && !censusMaybeUndefined(node)) return asI64(v)
  // Error-schema special case (.work/todo.md §deletion-sweep §Consequence): `${e}`/
  // String(e) on a real Error object must format via spec's Error.prototype.toString
  // (name if message empty / message if name empty / name+': '+message otherwise /
  // 'Error' if both empty — ECMA-262 20.5.3.4), not the generic OBJECT
  // toPrimitiveChain below (which knows nothing about Error, and Error exposes no
  // toString/valueOf slot for it to find) nor __to_str's fallback (raw pointer bits
  // reinterpreted as a string — a pre-existing bug for every OBJECT kind __to_str
  // doesn't special-case, confirmed live: `${anyDynamicObject}` → "").
  // Gated on ctx.features.error (prepare's whole-program "is an Error class ever
  // constructed" scan, order-independent for the same reason ctx.features.bigint
  // is a prescan, not a during-emit flag — see toNumF64 above): a program that never
  // constructs an Error takes NONE of this, zero added bytes. Narrowed further to
  // vt == null (unknown/dynamic) || vt === VAL.OBJECT: a provably-non-OBJECT operand
  // (NUMBER/ARRAY/MAP/…) can never be our Error schema, so even an Error-using
  // program's non-Error toStrI64 call sites pay nothing extra.
  if (ctx.features.error && (vt == null || vt === VAL.OBJECT)) {
    const used = ctx.features.errorClasses
    const t = temp('everr')
    const get = () => typed(['local.get', `$${t}`], 'f64')
    // audit-#9 P0-2 brand redesign: each Error class carries its OWN sid, so
    // recognizing "this is SOME Error object" (any of the 7) needs one masked-
    // i64 guard per class the program actually constructs, OR'd together —
    // ERR_CLASS_NAMES' fixed order (not Set insertion order) so the emitted
    // chain depends only on WHICH classes exist, never incidental AST-walk
    // order. Same masked-i64-compare shape as module/core.js's
    // emitSchemaSlotGuarded / objectSchemaGuardHex (shared via layout.js) per
    // arm: proves "is an OBJECT" AND "is exactly this class's schema" in one
    // compare each.
    const guard = ERR_CLASS_NAMES.filter(c => used.has(c))
      .map(c => ['i64.eq',
        ['i64.and', asI64(get()), ['i64.const', OBJECT_SCHEMA_HI_MASK]],
        ['i64.const', objectSchemaGuardHex(ctx.schema.errorSid(c))]])
      .reduce((x, y) => ['i32.or', x, y])
    const off = ['i32.wrap_i64', ['i64.and', asI64(get()), ['i64.const', LAYOUT.OFFSET_MASK]]]
    return typed(['block', ['result', 'i64'],
      ['local.set', `$${t}`, asF64(v?.type ? v : typed(v, 'f64'))],
      ['if', ['result', 'i64'],
        guard,
        ['then', errToStringIR(off)],
        ['else', coerceRest(node, get(), vt)]]], 'i64')
  }
  return coerceRest(node, v, vt)
}

/** Everything toStrI64 did before the Error-schema special case existed — split
 *  out so that arm's runtime-guard "else" branch (a non-Error OBJECT, or any
 *  other kind, once the guard has already proven it isn't our Error schema)
 *  falls to EXACTLY this, unchanged. When ctx.features.error is false (no Error
 *  ever constructed) toStrI64 calls this directly with no wrapping at all — the
 *  zero-cost path for every Error-free program. */
function coerceRest(node, v, vt) {
  if (vt === VAL.OBJECT && ctx.closure.call && ctx.schema.slotOf) {
    const prim = toPrimitiveChain(node, v, ['toString', 'valueOf'])
    if (prim) {
      inc('__to_str')
      return typed(['call', '$__to_str', prim], 'i64')
    }
  }
  // Provably-integer operand → render with the i32-only formatter, bypassing __to_str's
  // float machinery (__ftoa/__toExp/__pow10, ~2 KB). A raw i32 value (`n|0`, a bitwise
  // result, a loop counter) carries no NaN-box, so its ToString is just digits + sign.
  // ptrKind != null means it's an unboxed pointer (i32 offset), NOT a number — exclude.
  if (v.type === 'i32' && v.ptrKind == null) {
    inc('__i32_to_str')
    return typed(['i64.reinterpret_f64', ['call', '$__i32_to_str', v]], 'i64')
  }
  inc('__to_str')
  // readI64 (CARRIER PROGRAM Slice 3): a proven-BIGINT node whose bare name
  // is a currently-boxed param must be unboxed before $__to_str sees it —
  // for every other shape this is byte-identical to the old asI64(v) call
  // (dynamic/unproven operands still pass their raw bits through unchanged,
  // for $__to_str's own tag dispatch to interpret).
  return typed(['call', '$__to_str', readI64(node, v)], 'i64')
}

/** Spec's Error.prototype.toString (20.5.3.4) for a proven Error-schema object,
 *  given `off` — an i32 IR expr for its payload byte offset (cloned per use: the
 *  emitted tree references it three times, and IR-aliasing corrupts a later
 *  local-lifetime pass — see cloneIR's doc). Loads message (slot 0) / name (slot
 *  1) once each, then: both empty → "Error"; message empty → name; name empty →
 *  message; else → name + ": " + message, via the same $__str_concat_fresh the
 *  ordinary `+` string-concat operator itself calls (not a new primitive). Every
 *  built-in class's `name` is a non-empty static literal (module/core.js's
 *  buildErrorObject) — the nameEmpty arm only fires if a caught Error's `.name`
 *  was reassigned to `''` after construction. */
function errToStringIR(off) {
  inc('__str_byteLen', '__str_concat_fresh')
  const tm = tempI64('emsg'), tn = tempI64('ename')
  const ml = tempI32('emlen'), nl = tempI32('enlen')
  return typed(['block', ['result', 'i64'],
    ['local.set', `$${tm}`, ctx.abi.object.ops.loadBits(cloneIR(off), 0)],
    ['local.set', `$${tn}`, ctx.abi.object.ops.loadBits(cloneIR(off), 1)],
    ['local.set', `$${ml}`, ['call', '$__str_byteLen', ['local.get', `$${tm}`]]],
    ['local.set', `$${nl}`, ['call', '$__str_byteLen', ['local.get', `$${tn}`]]],
    ['if', ['result', 'i64'],
      ['i32.eqz', ['local.get', `$${ml}`]],
      ['then', ['if', ['result', 'i64'],
        ['i32.eqz', ['local.get', `$${nl}`]],
        ['then', ssoStrI64('Error')],
        ['else', ['local.get', `$${tn}`]]]],
      ['else', ['if', ['result', 'i64'],
        ['i32.eqz', ['local.get', `$${nl}`]],
        ['then', ['local.get', `$${tm}`]],
        ['else', ['i64.reinterpret_f64', ['call', '$__str_concat_fresh',
          ['i64.reinterpret_f64', ['call', '$__str_concat_fresh', ['local.get', `$${tn}`], ssoStrI64(': ')]],
          ['local.get', `$${tm}`]]]]]]]], 'i64')
}

/** Pack a ≤6-char ALL-ASCII compile-time-known literal directly into an SSO
 *  NaN-boxed string i64 constant — no heap, no runtime call. This file has a
 *  NO-EMIT contract (see module header): module/string.js's `emit(['str', …])`
 *  path isn't reachable here (module/string.js imports FROM this file — the
 *  reverse import would cycle), so this duplicates the packing arithmetic of
 *  module/string.js's `ssoEncode` (the single runtime source of truth for
 *  user string literals) for the two FIXED literals errToStringIR needs
 *  ("Error", ": ") rather than import it. Both fit MAX_SSO=6 with room to
 *  spare; not a general-purpose literal builder. */
function ssoStrI64(str) {
  let offset = 0, auxChars = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i), bit = i * 7
    if (bit <= 24) offset |= c << bit
    else if (bit < 32) { offset |= (c & 0xF) << 28; auxChars |= c >> 4 }
    else auxChars |= c << (bit - 32)
  }
  const aux = LAYOUT.SSO_BIT | (str.length << 10) | auxChars
  return typed(['i64.const', i64Hex(ptrBits(PTR.STRING, aux, offset >>> 0))], 'i64')
}

/** Convert already-emitted WASM node to i32 boolean. NaN is falsy (like JS).
 *  Peepholes: i32 → as-is; `f64.convert_i32_*(x)` → x (i32 conversion never NaN);
 *  nested `__is_truthy(x)` → x (already 0/1); literal f64 const folds to 0/1. */
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

// === Value-type classification ===

export function usesDynProps(vt) {
  return vt === VAL.ARRAY || vt === VAL.STRING || vt === VAL.CLOSURE
    || vt === VAL.TYPED || vt === VAL.SET || vt === VAL.MAP || vt === VAL.REGEX
}

/** Does this object literal / property write need a `__dyn_props` shadow update?
 *  `target` is the var name receiving the literal (or null when escaping). */
export function needsDynShadow(target) {
  if (!ctx.module.modules.collection) return false
  // Functions/CLOSURE always need dynamic props so cross-module property
  // access (fn.parse, i32.parse aliases) sees the same value as schema slots.
  const vt = typeof target === 'string' ? (ctx.func.localReps?.get(target)?.val || ctx.scope.globalValTypes?.get(target)) : null
  if (vt === 'closure' || usesDynProps(vt)) return true
  // A module-wide dynamic-key access (`obj[expr]`) means ANY object may later be
  // read through the dyn-props hash (__dyn_get_any), so every object literal is
  // built with a shadow. Mutation sites (Object.assign, `o.k = v`) must mirror
  // into that same shadow or a subsequent hash read returns a stale slot value.
  // Honor anyDynKey for NAMED targets too — not just anonymous (target == null)
  // literals — so construct-time shadowing and mutate-time mirroring agree. They
  // desynced before: a named literal shadowed via anyDynKey, but its assign saw
  // only dynKeyVars (which holds the *dynamically-keyed* vars, not this binding).
  if (ctx.types?.anyDynKey) return true
  const dyn = ctx.types?.dynKeyVars
  return target != null && dyn ? dyn.has(target) : false
}

// === Variable storage abstraction ===
// Centralizes the boxed/global/local 3-way dispatch (used by =, ++/--, +=, etc.)

/** Check if name is a module-scope global (not shadowed by local/param). */
/** Bound in the current function frame — a declared local or a parameter. */
export const isBoundName = name =>
  ctx.func.locals?.has(name) || ctx.func.current?.params?.some(p => p.name === name)

export function isGlobal(name) {
  return ctx.scope.globals.has(name) && !ctx.func.locals?.has(name) && !ctx.func.current?.params?.some(p => p.name === name)
}

/** Check if assigning to name would violate const. Only applies when not shadowed. */
export function isConst(name) {
  return ctx.scope.consts?.has(name) && !ctx.func.locals?.has(name) && !ctx.func.current?.params?.some(p => p.name === name)
}

/** Get i32 memory address for a boxed variable's cell. Cell locals are always i32. */
export function boxedAddr(name) {
  return ['local.get', `$${ctx.func.boxed.get(name)}`]
}

// '$'-prefixed name memo. readVar/writeVar run per IR node; rebuilding the
// `$name` string each time costs an alloc+copy in the self-host kernel AND
// produces a fresh instance per use — making watr's name-keyed lookups
// content-compare. The memo returns ONE canonical instance per name, so
// construction is a map hit and every downstream comparison is bit-eq.
// Module-level: in-kernel it lives per instance (arena strings are immortal),
// natively it is a plain cross-compile cache; the name vocabulary is bounded.
let DOLLAR = new Map()
export const dollar = (name) => {
  let v = DOLLAR.get(name)
  if (v === undefined) { v = '$' + name; DOLLAR.set(name, v) }
  return v
}
// Self-host-only: DOLLAR's keys/values are both arena strings built during compile
// (the `name`s come from the source being compiled) AND the Map's own backing
// table is itself an arena allocation. Natively the arena is the host GC heap, so
// stale entries (or a `.clear()`) are enough — the old backing store just becomes
// garbage. In-kernel the arena is a bump allocator that `_clear` rewinds between
// compiles: `.clear()` alone leaves the Map pointing at its OLD backing table,
// which a later allocation can overwrite while still "owned" by DOLLAR (as opposed
// to the entries becoming merely unreachable) — so a warm-instance compile loop
// must swap in a FRESH Map (not just empty this one) after every `_clear`
// (see scripts/self.js setupSelf). Verified empirically: `.clear()` alone still
// trapped `__hash_set_local` on the 2nd compile of a warm instance.
export const clearDollar = () => { DOLLAR = new Map() }

/** Read variable value: boxed → f64.load, global → global.get, local → local.get.
 *  Unboxed pointer locals (repOf(name).ptrKind) tag the returned node with `.ptrKind`
 *  so downstream coercions know it's an i32 offset, not a numeric. */
export function readVar(name) {
  if (ctx.func.boxed?.has(name)) {
    // i32-narrowed cell (closure-capture narrowing — see analyzeFuncForEmit's
    // cellTypes): the cell stores a raw i32, load it directly.
    if (ctx.func.cellTypes?.has(name)) return typed(['i32.load', boxedAddr(name)], 'i32')
    return typed(['f64.load', boxedAddr(name)], 'f64')
  }
  if (isGlobal(name)) {
    // A module-level integer const (`const N = 16384`) is an immutable compile-time
    // value: emit i32.const directly (when it fits i32) so `x % N` / `x & N` / `x / N`
    // and counters bounded by N take the native integer path, instead of the global
    // folding to an f64 constant and routing through the f64 round-trip. Value-preserving
    // — an f64 consumer widens the i32.const via convert, which folds back to f64.const.
    const ci = ctx.scope.constInts?.get?.(name)
    if (ci != null && isI32(ci)) return typed(['i32.const', ci], 'i32')
    // Fractional pre-folded const (`const nv = 2610/16384`): same immutability
    // argument as the integer arm — substitute the literal so downstream
    // compile-time folds (constant-exponent pow, ranges) see the value.
    const cn = ctx.scope.constNums?.get?.(name)
    if (cn != null) { const node = typed(['f64.const', cn], 'f64'); node.valKind = VAL.NUMBER; return node }
    const gt = ctx.scope.globalTypes.get(name) || 'f64'
    const node = typed(['global.get', dollar(name)], gt)
    const grep = repOfGlobal(name)
    if (gt === 'f64' && (lookupValType(name) === VAL.NUMBER || grep?.val === VAL.NUMBER)) node.valKind = VAL.NUMBER
    // ptrKind tags a raw i32 pointer offset — meaningful only for an i32-STORED
    // global (a typed-array/buffer carrier unboxed by unboxConstTypedGlobals). An
    // f64 global holds a NaN-boxed value: object/array reads unbox at the access
    // site via the schema/reinterpret path, never an i32 reinterpret of the storage.
    // Attaching ptrKind to an f64 global makes `asF64` box the f64 *as if it were an
    // i32* (i64.extend_i32_u on a global.get of type f64 → invalid wasm). Gate on the
    // storage type so the tag follows the declared ABI.
    if (gt === 'i32' && grep?.ptrKind != null) {
      node.ptrKind = grep.ptrKind
      if (grep.ptrAux != null) node.ptrAux = grep.ptrAux
    }
    return node
  }
  const t = ctx.func.locals?.get(name) || ctx.func.current?.params?.find(p => p.name === name)?.type || 'f64'
  const rep = repOf(name)
  // Const-arg propagation: param proven to be the same integer literal at every static
  // call site (cross-call fixpoint sets rep.intConst). Substitute the read with the
  // literal — lets watr fold guards and treeshake unused params without touching the
  // param ABI (which the V8 inliner is sensitive to: narrowing nStages from f64→i32
  // tanked biquad ~60%). Type follows the local's declared type to preserve any
  // coercions the surrounding code expects.
  if (rep?.intConst != null) {
    return t === 'i32' ? typed(['i32.const', rep.intConst], 'i32')
                       : typed(['f64.const', rep.intConst], 'f64')
  }
  const node = typed(['local.get', dollar(name)], t)
  if (t === 'f64' && (lookupValType(name) === VAL.NUMBER || rep?.val === VAL.NUMBER)) node.valKind = VAL.NUMBER
  // Proven uint32 accumulator local (narrowUint32): a later asF64 must widen with
  // convert_i32_u (the i32 bit pattern is an unsigned value), not _s. `.wrapSafe`
  // marks it as the always-ToUint32-sunk kind so the arithmetic widening guards
  // keep it on the i32 path — wrapping is its intended semantics, not a leak.
  if (t === 'i32' && rep?.unsigned) { node.unsigned = true; node.wrapSafe = true }
  if (rep?.ptrKind != null) {
    node.ptrKind = rep.ptrKind
    // closureAux: emission-minted table idx for an unboxed CLOSURE local (slice-4 P2) —
    // per-function emission state; the map only ever holds CLOSURE names.
    const aux = rep.ptrAux ?? ctx.func.closureAux?.get(name) ?? ctx.schema.idOf?.(name)
    if (aux != null) node.ptrAux = aux
    // structInline cursor into a PACKED (i32-cell) array: slot access must
    // pick the packedI32 ops, not the f64 slot layout — the flag rides the
    // node because a standalone object of the same sid keeps f64 slots.
    if (rep.ptrKind === VAL.OBJECT && ctx.schema.inlineCellCursors?.get(ctx.func.current)?.has(name))
      node.cellI32 = true
    // Union cursor (analyzeUnionInline): packed i32 cells; the slot comes from
    // the refinement chain (schema.slotOf), never a single sid aux.
    if (rep.ptrKind === VAL.OBJECT && ctx.schema.inlineUnionCursors?.get(ctx.func.current)?.has(name)) {
      node.cellI32 = true
      node.unionKey = ctx.schema.inlineUnionCursors.get(ctx.func.current).get(name)
    }
  }
  // Union-cursor PARAM (stage 3): the packed cell address rides the OBJECT
  // NaN-box across the call, so the param has val=OBJECT but no ptrKind (it's a
  // boxed f64, not an unboxed local). Tag its reads cellI32 + unionKey; the
  // slot read (emitPropAccess) unboxes to the cell address then packedI32-loads.
  // NO ptrKind on the tag: the node's storage IS f64 (the NaN-box), and
  // ptrKind on an f64-typed node makes asF64/asI64 box it as if it were a raw
  // i32 offset (the f64-global hazard above) — any non-field-read use of the
  // param (dyn fallback, logging, compare) must keep the plain f64 carrier.
  // (A local cursor is caught by the ptrKind branch above; this is the
  // f64-carrier param case only.)
  else if (ctx.schema.inlineUnionCursors?.get(ctx.func.current)?.has(name)) {
    node.cellI32 = true
    node.unionKey = ctx.schema.inlineUnionCursors.get(ctx.func.current).get(name)
  }
  return node
}

/** Write variable value. void_ → local.set (no result); otherwise → local.tee.
 *  valIR is raw emit result — coerced to f64 for boxed/global, to local type for locals. */
export function writeVar(name, valIR, void_) {
  // Loop-guard hull channel invalidation (emit.js's loopGuardHi/boundedHi,
  // sort lever): a `while(name < bound)`-derived upper-bound fact for `name`
  // is only valid until the FIRST write to `name` — writeVar is the single
  // choke point every bare-name write path (`=`, `+=`, `++`/`--`, a for-loop
  // step) funnels through, so one delete here covers all of them. Emission
  // order matches evaluation order up to this point, so any comparison that
  // already READ the fact (via boundedHi, before this write emitted) stays
  // sound — only what's emitted AFTER this write loses it.
  ctx.types.loopGuardHi?.delete(name)
  if (ctx.func.boxed?.has(name)) {
    const addr = boxedAddr(name)
    // i32-narrowed cell: store the raw i32 (mirrors the integer-global write
    // gate below — the storage type decides the coercion).
    const i32Cell = ctx.func.cellTypes?.has(name)
    const st = i32Cell ? 'i32.store' : 'f64.store'
    const v = i32Cell ? asI32(valIR) : asF64(valIR)
    if (void_) return typed(['block', [st, addr, v]], 'void')
    const t = i32Cell ? tempI32() : temp()
    return typed(['block', ['result', i32Cell ? 'i32' : 'f64'],
      ['local.set', `$${t}`, v],
      [st, addr, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]], i32Cell ? 'i32' : 'f64')
  }
  if (isGlobal(name)) {
    // Scalar globals are f64 by default, but integer-global inference (plan.js)
    // narrows purpose-focused counters/sizes to i32 — coerce the write to match.
    const gt = ctx.scope.globalTypes.get(name) || 'f64'
    const v = gt === 'i32' ? asI32(valIR) : asF64(valIR)
    if (void_) return typed(['block', ['global.set', dollar(name), v]], 'void')
    const t = gt === 'i32' ? tempI32() : temp()
    return typed(['block', ['result', gt],
      ['local.set', `$${t}`, v],
      ['global.set', dollar(name), ['local.get', `$${t}`]],
      ['local.get', `$${t}`]], gt)
  }
  // NOTE: an unknown name is NOT minted here — a write-legalized binding lets a
  // later-emitted read of the same undeclared name resolve to 0 instead of
  // rejecting (test262 pins the ReferenceError: `x = x`, `x++`, `x + (x = 1)`
  // — 50 in-scope failures from an unconditional mint). The one structural
  // write-only binder, a bare undeclared `for (k in o)` head, is declared at
  // its prepare lowering instead.
  // A PARAMETER has no `let`/`const` decl for analyzeBody to seed into
  // ctx.func.locals — mirrors readVar's identical fallback (above) to the
  // signature's declared type. Needed once narrowMutatedParams (narrow.js)
  // lets an i32-specialized param be reassigned: without this fallback the
  // write defaulted to 'f64' (an i32 param was never written before this
  // lever — the mutation guard excluded it), coercing the RHS through
  // asF64 into a local the wasm signature declares i32 — a validation-
  // failing local.set type clash (the narrow.js comment's "generic f64
  // assign path").
  const t = ctx.func.locals.get(name) || ctx.func.current?.params?.find(p => p.name === name)?.type || 'f64'
  const ptrKind = repOf(name)?.ptrKind
  let coerced
  if (ptrKind != null) {
    // Local stores unboxed i32 offset. If RHS is already a same-kind offset, pass through;
    // otherwise extract low 32 bits from the NaN-boxed f64.
    coerced = valIR.ptrKind === ptrKind
      ? valIR
      : typed(['i32.wrap_i64', ['i64.reinterpret_f64', asF64(valIR)]], 'i32')
  } else {
    // i32 target: toI32 (not asI32) — a strict superset (same `|0`/ToInt32
    // wrap contract, ir.js docstrings) that ALSO tries narrowI32's ring-
    // arithmetic recovery first. Needed since P0-2 sibling (2026-08-02):
    // tryI32Arith (emit.js) now requires a magnitude proof before admitting
    // `i32.add`/`i32.sub` (a value that might escape BARE, e.g. via `return`,
    // can no longer trust an unproven wrap) — but an assignment INTO an
    // i32-typed local like the loop-counter idiom `i = i + 1` has no such
    // escape (every read of `i` re-applies this SAME wrap), so it doesn't
    // need tryI32Arith's admission at all: narrowI32's own (looser, ring-safe
    // under 2^53) recovery already re-narrows the resulting f64.add here,
    // right at the one assignment site that's provably safe to wrap.
    coerced = t === 'v128' ? valIR : t === 'f64' ? asF64(valIR) : toI32(valIR)
  }
  if (void_) return typed(['local.set', dollar(name), coerced], 'void')
  const teeNode = typed(['local.tee', dollar(name), coerced], t)
  if (ptrKind != null) teeNode.ptrKind = ptrKind
  return teeNode
}

/** Check if f64 expr is nullish (NULL_NAN or UNDEF_NAN). Returns i32.
 *  Peepholes: fold known NaN-boxed sentinel literals; elide on numeric literals;
 *  unboxed pointer locals are proven non-null by unboxablePtrs.
 *  Inlines directly: (i32.or (i64.eq bits NULL_NAN) (i64.eq bits UNDEF_NAN))
 *  rather than calling $__is_nullish — saves WASM call dispatch in V8 JIT. */
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
 *  `$__jz_err` channel. audit-#10 kind-specific member-access/call nullish-
 *  receiver checks are the caller: a REAL schema-tagged Error object, not a
 *  bare numeric code, is what makes `catch (e) { e instanceof TypeError }`
 *  true in-wasm (the tag+schema arm of the Error model's truth table,
 *  .work/todo.md §deletion-sweep §4 — the numeric-code range arm it also names was
 *  removed as unsound, audit-#8 P0-2) and what lets interop.js's
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
 *  `.name`/`.message` (audit-#11 P1, closing the residual this function's own
 *  comment used to document): a caught synthetic TypeError read BOTH as
 *  `undefined` — `e.name` should be `'TypeError'`, `String(e)` a real
 *  "TypeError: <msg>". A prior draft of this exact fix was tried and reverted
 *  (src/prepare/index.js's `censusShapedNode` prescan comment, still visible
 *  in git blame) after it "re-exposed two SEPARATE PRE-EXISTING, unrelated
 *  bugs" (`__mkptr` literal-offset arg folding, `.call`/`.apply`/`.bind`
 *  static-lowering thisArg drop) that happened to trigger whenever
 *  module/string.js loaded alongside them. Re-verified live for this session
 *  (SIMD-only nullish-check repro, `.call`/`.apply`/`.bind` repros, full
 *  battery/selfhost/fuzz gates below) — neither reproduces on current HEAD;
 *  both were independently fixed by unrelated commits since. `ctx.module.
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
 *  i64Hex exists to avoid — see layout.js). Confirmed root cause of the
 *  in-kernel "Bad int 0x000000-100000001" watr parse failure. */
const BOOL_ATOM_MASK = i64Hex(~(1n << BigInt(LAYOUT.AUX_SHIFT)))

/** Check if f64 expr is a boxed-boolean atom (TRUE_NAN or FALSE_NAN). Returns i32.
 *  Single-eval: masks the truth bit and compares to FALSE_NAN once. */
export const isBoolAtom = (f64expr) => matchF64Bits(f64expr,
  bits => constI32(bits === TRUE_NAN || bits === FALSE_NAN),
  (e) => typed(['i64.eq',
    ['i64.and', ['i64.reinterpret_f64', e], ['i64.const', BOOL_ATOM_MASK]],
    ['i64.const', FALSE_NAN]], 'i32'))

// === Array layout helpers — routed through the array carrier (abi/array.js) ===

/** Slot address: element `idx` off `baseLocal`. Constant idx folds the `*8`. */
export function slotAddr(baseLocal, idx) {
  return ctx.abi.array.ops.addr(['local.get', `$${baseLocal}`], idx)
}

/** Load f64 element from array data at ptr + i*8. ptr/i are local name strings. */
export function elemLoad(ptr, i) {
  return ctx.abi.array.ops.load(['local.get', `$${ptr}`], ['local.get', `$${i}`])
}

/** Store f64 val at array data ptr + i*8. ptr/i are local name strings. */
export function elemStore(ptr, i, val) {
  return ctx.abi.array.ops.store(['local.get', `$${ptr}`], ['local.get', `$${i}`], val)
}

/** Emit a loop iterating over array elements. Returns IR instruction list.
 *  bodyFn(ptr, len, i, item) should return an array of IR instructions.
 *  ARRAY-only — elemLoad assumes f64-stride data layout. After __ptr_offset
 *  resolves forwarding, len lives at ptr-8, so skip the second __len call
 *  (which would re-walk forwarding + dispatch on type).
 *
 *  Optional `lenLocal`: caller already has the array length in an i32 local
 *  (e.g. from sizing the output before the loop). Reuses it instead of
 *  re-loading from ptr-8.
 *  Optional `ptrLocal`: caller already has the resolved ARRAY data pointer in
 *  an i32 local. Reuses it instead of calling __ptr_offset again. */
export function arrayLoop(arrExpr, bodyFn, lenLocal, ptrLocal, reverse) {
  const arr = ptrLocal ? null : temp('aa'), ptr = ptrLocal ?? tempI32('ap'), i = tempI32('ai'), item = temp('av')
  const len = lenLocal ?? tempI32('al')
  const id = ctx.func.uniq++
  const setup = []
  if (!ptrLocal) {
    inc('__ptr_offset')
    setup.push(
      ['local.set', `$${arr}`, asF64(arrExpr)],
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${arr}`]]]],
    )
  }
  if (!lenLocal) setup.push(
    ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]])
  // Forward: i 0→len-1. Reverse (findLast*): i len-1→0, same elem indices.
  const start = reverse ? ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]] : ['i32.const', 0]
  const done = reverse ? ['i32.lt_s', ['local.get', `$${i}`], ['i32.const', 0]]
                       : ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]
  const step = ['i32.const', reverse ? -1 : 1]
  setup.push(
    ['local.set', `$${i}`, start],
    ['block', `$brk${id}`, ['loop', `$loop${id}`,
      ['br_if', `$brk${id}`, done],
      ['local.set', `$${item}`, elemLoad(ptr, i)],
      ...bodyFn(ptr, len, i, typed(['local.get', `$${item}`], 'f64')),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], step]],
      ['br', `$loop${id}`]]])
  return setup
}

/** Build a NaN-boxed pointer from a header allocation.
 *  type/aux/stride may be JS numbers; len/cap may be JS numbers or IR.
 *  Returns { local, init, ptr } where:
 *    local — i32 name pointing to data start (post-header)
 *    init  — IR statement that allocates and sets `local`
 *    ptr   — f64 IR expression: __mkptr(type, aux, local).
 *  Caller emits init, fills via local, then uses ptr (or local for further work). */
export function allocPtr({ type, aux = 0, len, cap, stride = 8, tag = 'ap' }) {
  // stride=8 (f64 slots — Array/HASH/OBJECT) hits the specialized __alloc_hdr which
  // hardcodes the multiply. Everything else (Set:16, Map probe:24, raw bytes:1) goes
  // through the generic __alloc_hdr_n(len, cap, stride).
  const local = tempI32(tag)
  const irOf = v => typeof v === 'number' ? ['i32.const', v] : v
  const args = [irOf(len), irOf(cap == null ? len : cap)]
  let helper
  if (stride === 8) helper = '__alloc_hdr'
  else { helper = '__alloc_hdr_n'; args.push(['i32.const', stride]) }
  inc(helper)
  const init = ['local.set', `$${local}`, ['call', '$' + helper, ...args]]
  const ptr = mkPtrIR(type, aux, ['local.get', `$${local}`])
  return { local, init, ptr }
}

// === Multi-value + control-flow reads ===

/** Check if a call expression targets a multi-value function. Returns result count or 0. */
export function multiCount(callNode) {
  if (!Array.isArray(callNode) || callNode[0] !== '()') return 0
  const name = callNode[1]
  if (typeof name !== 'string') return 0
  const func = ctx.func.map?.get(name)
  return func?.sig.results.length > 1 ? func.sig.results.length : 0
}

/** Get current loop labels or throw. */
export function loopTop() {
  const top = ctx.func.stack.at(-1)
  if (!top) err('break/continue outside loop')
  return top
}

// === Data shaping ===

/** Normalize emit result to instruction list. */
export const flat = ir => {
  if (ir == null) return []
  if (!Array.isArray(ir)) return [ir]  // bare 'drop', 'nop', etc.
  if (ir.length === 0) return []
  if (typeof ir[0] === 'string' || ir[0] == null) return [ir]  // single instruction: ['op', ...args] or [null, val]
  return ir  // multi-instruction: [instr1, instr2, ...]
}

/**
 * Reconstruct arguments with spreads inserted at correct positions.
 * Example: normal=[a, c], spreads=[{pos:1, expr:arr}] → [a, __spread(arr), c]
 */
/** Find the index of the first body-content child in a (func ...) WAT node.
 *  Skips $name, (export …), (import …), (type …), (param …), (result …), (local …).  */
export function findBodyStart(fn) {
  for (let i = 2; i < fn.length; i++) {
    const c = fn[i]
    if (!Array.isArray(c)) continue
    if (c[0] === 'export' || c[0] === 'import' || c[0] === 'type' ||
        c[0] === 'param' || c[0] === 'result' || c[0] === 'local') continue
    return i
  }
  return fn.length
}

/** Debug-mode structural check of a `(func …)` IR node. Catches the bug classes
 *  that otherwise surface as OPAQUE watr errors several phases later — `Duplicate
 *  local $x`, `Unknown local $x` — but here pinned to the exact name (and, via the
 *  caller, the phase + function) that produced them, so a codegen/optimizer bug is
 *  localized at its source instead of at watr. Self-contained: validates every
 *  `local.{get,set,tee}` against the function header's param/local declarations,
 *  and rejects a duplicate declaration. Returns an error string, or null if clean.
 *  (Call-target and type-tag validation need the module symbol table + a type pass;
 *  deferred — locals are the common codegen-bug class and need nothing external.) */
export function verifyFn(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return null
  const bodyStart = findBodyStart(fn)
  const declared = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (!Array.isArray(c) || (c[0] !== 'param' && c[0] !== 'local') || typeof c[1] !== 'string') continue
    if (declared.has(c[1])) return `duplicate local/param ${c[1]}`
    declared.add(c[1])
  }
  let bad = null
  const walk = (n) => {
    if (bad || !Array.isArray(n)) return
    const op = n[0]
    if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string' && !declared.has(n[1])) {
      bad = `${op} of undeclared local ${n[1]}`; return
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) walk(fn[i])
  return bad
}

// === HIR provenance link (.work/research.md §BodyModel slice 4; audit-#15 item 5) ===
//
// Connects a WAT-level loop block node (the vectorizer's own scaffold — matchBlockLoop's
// `blockNode`, src/optimize/vectorize.js) back to the facts proved about it at HIR-lowering time
// (src/compile/emit.js's `'for'` handler, the sole writer) — its induction-variable/guard names
// and the counter/guard hull `forCounterRange` proves (src/static.js) — so BodyModel can
// eventually consult these instead of re-deriving them from the lowered WAT. Landed as the link +
// a DBG shadow-assert only (vectorize.js's assertLoopPlanAgrees) — no consumer yet.
//
// Lives here, not in compile/loop-model.js (AST-level loop primitives, pre-emission) or
// optimize/vectorize.js (the sole reader): this module is the neutral WAT-IR-node seam already
// imported by both without a layering violation, and the link's key is a WAT node.
//
// Keyed by WAT block-node IDENTITY via a WeakMap, not a stamped property, per the design's
// BINDING pre-trio spec (1): a rewrite that mints a fresh block array (any AST-to-WAT pass
// running between emission and the vectorizer walk that reads it) naturally drops out of the map.
// A miss is the CORRECT "decline, don't guess" answer for a rewritten loop (spec 2: fail-open),
// never an error — every reader must treat `loopPlanLink.get(node) === undefined` as "no HIR
// facts available", not as a negative fact about the loop.
//
// Each entry is `{ plan, lowering }`, NOT one flat record — audit-#15 item 5's correction:
//   `plan`     — the immutable HIR-side facts (id, hull, boundConst). Frozen: renaming a WAT
//                local downstream must never look like it changed what HIR proved.
//   `lowering` — the WAT-side name map (ivName, guardName). Mutable, owned by the backend: a pass
//                that renames a linked loop's own IV/guard local in place (emit.js's
//                freshenUnrolledScalarBindings, the one instance found so far — see its own doc)
//                updates ONLY this half, keeping the fact synchronized without mutating an HIR
//                fact after the fact.
// SESSION-OWNED (audit-#19 P0, folded into ctx.plans by architecture re-audit
// item 3, .work/todo.md — see src/compile/closure-plan.js's sibling doc
// comment for the full stale-plan-HIT hazard under self-hosting). Lives at
// `ctx.plans.loweringLinks`, a fresh WeakMap every reset() (src/ctx.js).
// Readers: `ctx.plans.loweringLinks.get(node) === undefined` is the CORRECT
// "decline, don't guess" answer for a rewritten loop (spec 2: fail-open),
// never an error.

// Separate id space from compile/loop-model.js's freshLoopId: a LoopPlan id identifies a HIR loop
// RECORD, never used to name anything emitted, so it must not share a counter with generated-
// local suffixes.
export const freshLoopPlanId = () => ctx.transform.loopPlanId++

/**
 * Tail-call rewrite: walks tail positions of an emitted IR tree and replaces
 * direct `(call $name args...)` ops with `(return_call $name args...)`.
 *
 * Tail positions, recursively from the IR root:
 *   - the root itself (function's terminal value-producing expression, or the
 *     emitted value of an explicit `return X`)
 *   - both arms of `(if (result T) cond (then ...) (else ...))`
 *   - last instruction of `(block (result T) ...)`
 *
 * Only fires when caller and callee result types match — if they didn't match,
 * `asParamType`/`asPtrOffset` would have wrapped the call in a conversion op,
 * pushing the `call` away from the tail position. We don't recurse into
 * arithmetic / select / loop ops: their results aren't standalone-tail control
 * transfers.
 *
 * Two callers:
 *   - `compile.js` runs it on the function's final value-producing IR to TCO
 *     expression-bodied arrows like `(n, acc) => n <= 0 ? acc : sum(n-1, acc+n)`
 *     where the AST has no `return` keyword.
 *   - `emit.js` `'return'` op handler runs it on the emitted return expression
 *     so explicit `return cond ? f(x) : g(x)` also gets deep tail rewriting.
 *
 * Returns the input unchanged when no transform applies.
 */
export const tcoTailRewrite = (ir, resultType) => {
  // audit-#11: TargetProfile's own noTailCall (session.js — on for host:'native',
  // the wasm2c-lowering lane with a known return_call+multi-value codegen bug)
  // is the NAMED-POLICY source; opts.noTailCall stays a separate, additive
  // explicit override usable under ANY host (e.g. a plain js/wasi target that
  // wants ordinary call frames for a reason unrelated to wasm2c — cli.js's
  // `--no-tail-call` flag doesn't require `--host native`).
  if (ctx.transform.targetProfile.noTailCall || ctx.transform.noTailCall || ctx.func.inTry) return ir
  if (!Array.isArray(ir)) return ir
  const op = ir[0]
  if (op === 'call' && typeof ir[1] === 'string') {
    // IR call name is `$name`; func.map keys are bare `name`.
    const calleeName = ir[1].startsWith('$') ? ir[1].slice(1) : ir[1]
    const callee = ctx.func.map.get(calleeName)
    // If this is a known user func, verify result-type match. Otherwise
    // (closures, imports, runtime helpers — not in `ctx.func.map`) trust the
    // tail-position invariant: emit.js' asParamType/asPtrOffset already wrapped
    // any mismatched call in a conversion op, so a bare `(call $X …)` at the
    // tail of the function/if/block has by construction the same result type
    // as the caller.
    if (callee) {
      if (callee.raw) return ir
      const calleeRT = callee.sig?.results?.[0] ?? 'f64'
      if (calleeRT !== resultType) return ir
    }
    return typed(['return_call', ...ir.slice(1)], resultType)
  }
  if (op === 'if' && Array.isArray(ir[1]) && ir[1][0] === 'result') {
    let changed = false
    const newIr = ir.slice()
    for (let i = 3; i < newIr.length; i++) {
      const arm = newIr[i]
      if (Array.isArray(arm) && (arm[0] === 'then' || arm[0] === 'else') && arm.length > 1) {
        const last = arm[arm.length - 1]
        const rewritten = tcoTailRewrite(last, resultType)
        if (rewritten !== last) {
          newIr[i] = [...arm.slice(0, -1), rewritten]
          changed = true
        }
      }
    }
    return changed ? typed(newIr, ir.type) : ir
  }
  if (op === 'block' && ir.length > 1) {
    const last = ir[ir.length - 1]
    const rewritten = tcoTailRewrite(last, resultType)
    if (rewritten !== last) return typed([...ir.slice(0, -1), rewritten], ir.type)
  }
  return ir
}

export function reconstructArgsWithSpreads(normal, spreads) {
  const combined = []
  let normalIdx = 0
  for (let targetPos = 0; targetPos <= normal.length; targetPos++) {
    for (const spread of spreads) {
      if (spread.pos === targetPos) {
        combined.push(['__spread', spread.expr])
      }
    }
    if (normalIdx < normal.length) {
      combined.push(normal[normalIdx++])
    }
  }
  return combined
}
