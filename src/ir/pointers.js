/**
 * NaN-box pointer construction/extraction + pointer-tag runtime dispatch.
 * boxPtrIR is exported (beyond the original file's private scope) only so
 * ir/numeric.js's asF64 can reach it — not part of the barrel's public
 * re-export list, since it wasn't part of the original public API.
 *
 * @module ir/pointers
 */

import { PTR, inc } from '../ctx.js'
import { VAL } from '../reps.js'
import { ptrBoxPrefixBigInt, ptrBits, i64Hex } from '../../layout.js'
import { typed } from './tag.js'

/** NaN-box prefix for a pointer of VAL kind K with aux bits: `0x7FF8 | type<<47 | aux<<32`. */
function ptrBoxPrefix(ptrType, aux = 0) {
  return ptrBoxPrefixBigInt(ptrType, aux)
}

/** Build f64 NaN-boxed pointer IR from an i32 offset node of known kind.
 *  `aux` is the 15-bit secondary tag (schema ID for OBJECT, element type for TYPED, etc.).
 *  Second PTR.OBJECT construction site (mkPtrIR's own doc names both, including the
 *  `.schemaSid` node-tag contract) — reboxing an already-unboxed pointer (narrow.js's
 *  applyPointerParamAbi devirt, e.g. a recursive OBJECT param) mints no NEW mkptr call,
 *  so it must tag the schema-liveness fact onto ITS OWN result node. */
export function boxPtrIR(i32node, ptrType, aux = 0) {
  const prefix = ptrBoxPrefix(ptrType, aux)
  // i64Hex, not prefix.toString(16) — prefix is BY CONSTRUCTION a NaN-box
  // pattern (NAN_PREFIX_BITS | type<<47 | aux<<32), the exact self-host
  // hazard fixed identically in specializeMkptr/extractF64Bits (see their
  // own doc, fix/shape8-member-callee): under self-host, readI64/
  // isPlanTaggedBigint can misjudge this shape as a boxed pointer and
  // unbox it as one. i64Hex reaches the hex digits via shift/and/Number,
  // never a `.toString()` call.
  const result = typed(['f64.reinterpret_i64',
    ['i64.or',
      ['i64.const', i64Hex(prefix)],
      ['i64.extend_i32_u', i32node]]], 'f64')
  if (ptrType === PTR.OBJECT) result.schemaSid = aux
  // TAG-PRESERVING REBOX (.work/research.md §Carrier invariant, "DECL-INIT
  // WALL"): typed() above sets only .type on the fresh wrapper node —
  // the source i32node's .ptrKind/.ptrAux (set by readVar-style construction)
  // do NOT propagate onto it. The bits are right (the NaN-box correctly
  // encodes ptrType/aux in the prefix), but the METADATA a downstream
  // consumer reads off the RESULT node (emitDecl's P1 predictor parity
  // assert) is gone, so any caller that boxes a tagged pointer (storedValue
  // → carrierF64 → asF64 → here) silently drops tags the caller never asked
  // to lose.
  //
  // INVARIANT: must NOT copy onto `.ptrKind`/`.ptrAux` themselves — those two
  // names are a load-bearing DISPATCH convention read throughout ir.js —
  // "`.ptrKind != null` means this node's OWN representation is an unboxed
  // i32 pointer offset" (asF64 here, truthyIR, writeVar, the
  // matchF64Bits/isNullish family all branch on it without re-checking
  // `.type`). `result` here is f64-typed (already boxed); stamping
  // `.ptrKind` on it would make every one of those sites mistake an
  // already-boxed f64 for a raw i32 offset needing (re-)boxing — a real
  // crash: a second asF64 pass over an emitDecl coercion's already-boxed
  // `val` re-enters boxPtrIR and emits `i64.extend_i32_u` on an f64 operand,
  // failing wasm validation ("expected type i32, found f64.reinterpret_i64").
  // Carried instead under NEW, non-colliding names nothing else reads —
  // additive by construction, zero risk to the existing i32-only convention.
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

const litI32 = n => Array.isArray(n) && n[0] === 'i32.const' && typeof n[1] === 'number' ? n[1] : null

/** Pack (type, aux, offset) into the f64 NaN-box bit pattern as a hex string. */
const packPtrBits = (type, aux, offset) => i64Hex(ptrBits(type, aux, offset))

/** Build `__mkptr(type, aux, offset)` IR. Folds to `(f64.const nan:0x...)` — 9 bytes
 *  vs 12 for `f64.reinterpret_i64 (i64.const ...)` — when all args are i32 literals.
 *  Args may be raw IR nodes or numbers (numbers are wrapped as i32.const).
 *
 *  EMISSION-TIME SCHEMA-LIVENESS TAG (replaces the former post-treeshake WAT
 *  scan — see src/compile/index.js's jz:schema comment for the full account):
 *  a `.schemaSid` property on the RETURNED node, additive metadata in the same
 *  family as `.type`/`.ptrKind`/`.ptrAux` (boxPtrIR below stamps the identical
 *  tag). mkPtrIR/boxPtrIR are the only two places a PTR.OBJECT pointer is ever
 *  IR-constructed; `aL` is a schema id here or nowhere, still a plain JS
 *  number, never a string a later pass could reformat. Tagging the NODE
 *  instead of recording into a flat set keeps the fact post-treeshake
 *  accurate for free: src/compile/index.js's collection walk runs over the
 *  already-pruned sec.stdlib/funcs/start/globals/elem, so a construction
 *  whose sole containing function treeshake later removed entirely is never
 *  visited — no separate reachability accounting needed here. */
export function mkPtrIR(type, aux, offset) {
  const tIR = typeof type === 'number' ? ['i32.const', type] : type
  const aIR = typeof aux === 'number' ? ['i32.const', aux] : aux
  const oIR = typeof offset === 'number' ? ['i32.const', offset] : offset
  const tL = litI32(tIR), aL = litI32(aIR), oL = litI32(oIR)
  if (tL != null && aL != null && oL != null) {
    const node = typed(['f64.const', 'nan:' + packPtrBits(tL, aL, oL)], 'f64')
    if (tL === PTR.OBJECT) node.schemaSid = aL
    return node
  }
  inc('__mkptr')
  const node = typed(['call', '$__mkptr', tIR, aIR, oIR], 'f64')
  if (tL === PTR.OBJECT && aL != null) node.schemaSid = aL
  return node
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
        // i64Hex, not v.toString(16): v is BY CONSTRUCTION a NaN-exponent
        // pattern (the `| 0x7ff0...n` above) — under self-host, readI64/
        // isPlanTaggedBigint can misjudge exactly this shape as a boxed
        // pointer and unbox it as one (ir.js's own SELF-COMPILE CONTRACT
        // note, mkPtrIR's identical fix in optimize/index.js's
        // specializeMkptr, fix/shape8-member-callee). i64Hex reaches the
        // hex digits via shift/and/Number, never .toString().
        return i64Hex(v)
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
        return i64Hex(v)  // i64Hex, not v.toString(16) — same self-host hazard as above
      } catch { return null }
    }
    try {
      const v = BigInt(s)
      return i64Hex(v)  // i64Hex, not v.toString(16) — same self-host hazard as above
    } catch { return null }
  }
  return null
}

// === Literal / purity checks ===

/** Single-kind ptr-tag predicate: `__ptr_type(bits) == ptr`. Takes the f64
 *  carrier expression and the PTR constant. Use this when guarding one branch;
 *  use `dispatchByPtrType` for multi-case forks. Stamps `inc('__ptr_type')`. */
export function ptrTypeEq(f64Expr, ptr) {
  inc('__ptr_type')
  return typed(['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', f64Expr]], ['i32.const', ptr]], 'i32')
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
