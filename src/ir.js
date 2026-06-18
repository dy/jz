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

import { ctx, err, inc, PTR, LAYOUT } from './ctx.js'
import { ptrBoxPrefixBigInt, atomNanHex, nanPrefixHex } from '../layout.js'
import { I32_MIN, I32_MAX, isI32, isLiteralStr, isFuncRef } from './ast.js'
import { VAL, lookupValType, repOf, repOfGlobal } from './reps.js'
import { valTypeOf } from './kind.js'
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
  return typed(['f64.reinterpret_i64',
    ['i64.or',
      ['i64.const', '0x' + prefix.toString(16).toUpperCase()],
      ['i64.extend_i32_u', i32node]]], 'f64')
}

/** Coerce node to f64. Pointer-kinded i32 offsets rebox via NaN-tag fusion, not numeric convert.
 *  The `unsigned` flag (set by `>>>` codegen) opts into `convert_i32_u` so the canonical
 *  `(x >>> 0)` uint32 idiom converts to a positive f64 in [0, 2^32) instead of sign-flipping. */
export const asF64 = n => {
  if (n == null) err(`compiler internal: expected emitted IR value in ${ctx.func.current?.name || '<module>'}, got empty value`)
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
export const asParamType = (n, t) => t === 'i32' ? asI32(n) : t === 'i64' ? asI64(n) : t === 'v128' ? n : asF64(n)

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
  if (x.type === 'i32') return { node: x, maxAbs: 2 ** 31, faithful: true }
  const op = x[0]
  if (op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u')
    // Peel — same as toI32's peephole. _u values ∈ [0, 2^32): the re-tag IS the
    // wrap (ring-compatible), but the i32 view differs from the JS value above
    // 2^31, so _u is not faithful.
    return {
      node: Array.isArray(x[1]) ? typed(x[1], 'i32') : x[1],
      maxAbs: op === 'f64.convert_i32_s' ? 2 ** 31 : 2 ** 32,
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
  // Leaf nodes are cheap to duplicate; for everything else, evaluate once via local.tee.
  const isLeaf = Array.isArray(n) && n.length <= 2 &&
    (n[0] === 'f64.const' || n[0] === 'local.get' || n[0] === 'global.get')
  // `i32.wrap_i64(i64.trunc_sat_f64_s x)` is exact ToInt32 for |x| < 2^63 (the
  // overwhelming common range), maps NaN/−∞→0, and +∞ is guarded to 0 by the
  // select. For |x| ≥ 2^63 it saturates rather than wrapping mod 2^32 — a
  // deliberately-allowed asm.js-style boundary (no per-`|0` helper/guard cost).
  const wrap = x => typed(['i32.wrap_i64', ['i64.trunc_sat_f64_s', x]], 'i32')
  if (isLeaf) {
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
export const nullExpr = () => typed(NULL_IR, 'f64')
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
function packPtrBits(type, aux, offset) {
  const bits = LAYOUT.NAN_PREFIX_BITS
    | ((BigInt(type) & BigInt(LAYOUT.TAG_MASK)) << BigInt(LAYOUT.TAG_SHIFT))
    | ((BigInt(aux) & BigInt(LAYOUT.AUX_MASK)) << BigInt(LAYOUT.AUX_SHIFT))
    | (BigInt(offset >>> 0) & BigInt(LAYOUT.OFFSET_MASK))
  return '0x' + bits.toString(16).toUpperCase().padStart(16, '0')
}

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
// expressions. (Same contract as wat/optimize.js's i64 VALUE CONTRACT.)
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
  'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.gt_s', 'i32.le_s', 'i32.ge_s', 'i32.eqz'])
export const isPureIR = n => Array.isArray(n) && PURE_OPS.has(n[0]) && n.slice(1).every(c => !Array.isArray(c) || isPureIR(c))

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
  return block64(
    ['local.set', `$${o}`, asF64(objIR)],
    ['local.set', `$${p}`, ['f64.reinterpret_i64',
      ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', ['local.get', `$${o}`]], nameIR]]],
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
  body.push(['throw', '$__jz_err', ['f64.const', 0]])
  return typed(['block', blk, ...body], 'i64')
}

const cloneIR = (n) => Array.isArray(n) ? n.map(cloneIR) : n

/** ToNumber for a runtime value that may carry a nullish sentinel: null→+0, undefined→NaN,
 *  anything else → itself. `valIR` must be side-effect-free (a local read) — it is duplicated,
 *  so each occurrence gets a fresh clone. Used for bindings flagged in ctx.func.maybeNullish;
 *  a real number isn't either sentinel, so it falls through the `else` unchanged. */
const coerceNullishToNum = (valIR) => typed(
  ['if', ['result', 'f64'],
    ['i64.eq', ['i64.reinterpret_f64', cloneIR(valIR)], ['i64.const', NULL_NAN]],
    ['then', ['f64.const', 0]],
    ['else', ['if', ['result', 'f64'],
      ['i64.eq', ['i64.reinterpret_f64', cloneIR(valIR)], ['i64.const', UNDEF_NAN]],
      ['then', ['f64.const', 'nan']],
      ['else', cloneIR(valIR)]]]],
  'f64')

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
  // A binding assigned a nullish literal may hold null/undefined here — coerce per ToNumber
  // (null→+0, undefined→NaN); a real number falls through unchanged. Only flagged bindings pay
  // this, so the numeric kernels jz optimizes for (which never assign null) stay untouched.
  if (typeof node === 'string' && ctx.func.maybeNullish?.has(node)) return coerceNullishToNum(asF64(v))
  const vt = valTypeOf(node)
  if (vt === VAL.BOOL) return typed(['f64.convert_i32_s', truthyIR(v)], 'f64')
  if (vt === VAL.NUMBER || vt === VAL.BIGINT) return asF64(v)
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
  return typed(['call', '$__to_str', asI64(v)], 'i64')
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
const DOLLAR = new Map()
export const dollar = (name) => {
  let v = DOLLAR.get(name)
  if (v === undefined) { v = '$' + name; DOLLAR.set(name, v) }
  return v
}

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
    const aux = rep.ptrAux ?? ctx.schema.idOf?.(name)
    if (aux != null) node.ptrAux = aux
  }
  return node
}

/** Write variable value. void_ → local.set (no result); otherwise → local.tee.
 *  valIR is raw emit result — coerced to f64 for boxed/global, to local type for locals. */
export function writeVar(name, valIR, void_) {
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
  const t = ctx.func.locals.get(name) || 'f64'
  const ptrKind = repOf(name)?.ptrKind
  let coerced
  if (ptrKind != null) {
    // Local stores unboxed i32 offset. If RHS is already a same-kind offset, pass through;
    // otherwise extract low 32 bits from the NaN-boxed f64.
    coerced = valIR.ptrKind === ptrKind
      ? valIR
      : typed(['i32.wrap_i64', ['i64.reinterpret_f64', asF64(valIR)]], 'i32')
  } else {
    coerced = t === 'v128' ? valIR : t === 'f64' ? asF64(valIR) : asI32(valIR)
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

/** Mask that clears the boolean atom's truth bit, mapping TRUE_NAN→FALSE_NAN.
 *  `(bits & BOOL_ATOM_MASK) === FALSE_NAN` recognizes both in one i64.and+i64.eq. */
const BOOL_ATOM_MASK = '0x' + BigInt.asUintN(64, ~(1n << BigInt(LAYOUT.AUX_SHIFT))).toString(16).toUpperCase().padStart(16, '0')

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
  if (ctx.transform.noTailCall || ctx.func.inTry) return ir
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
