/**
 * f64/i32/i64 coercions, int-narrowing range analysis (narrowI32/f64Range),
 * and the ToInt32-wrap / ToNumber-adjacent numeric primitives (toI32, f64rem).
 *
 * @module ir/numeric
 */

import { ctx, err, inc } from '../ctx.js'
import { I32_MIN, I32_MAX, isLeaf } from '../ast.js'
import { typed } from './tag.js'
import { temp } from './locals.js'
import { boxPtrIR, valKindToPtr } from './pointers.js'

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
 *  wrapping i64::MAX/MIN's low 32 bits gives -1/0 instead of saturating): e.g.
 *  `str.includes(needle, Infinity)` — or any position >= 2^63, e.g. `1e20` — would wrap to
 *  -1 and read back downstream as "index from the end" instead of "past the end".
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
// coercion: a strict superset of the `|0` wrap
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
  // typed local destination), where wraparound is provably harmless —
  // unlike `mulFitsI32`, which guards a value that may escape as a
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

// JS `%` on the f64 path. Delegates to the exact `__rem` (binary fmod) stdlib —
// the textbook `a - b*trunc(a/b)` is inexact for large a/b and wrong on the
// ±Inf / 0 / NaN edges. The i32.rem_s fast path in emit.js handles the common
// integer-with-nonzero-literal-divisor case; everything else lands here.
export const f64rem = (a, b) => (inc('__rem'), typed(['call', '$__rem', a, b], 'f64'))
