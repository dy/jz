/**
 * `exprType` — infer expression result type (i32 vs f64) from AST, without
 * emitting. Used to determine local variable types before compilation. HALF
 * of a two-file shared contract with `emit.js` (see the doc comment above
 * `exprType` below): "when does i32 arithmetic stay i32 vs widen to f64" is
 * decided in TWO places that must agree — emit.js DECIDES, this mirrors —
 * kept as one dispatch function so that contract stays legible as a whole
 * (see `.work/type-split.md` for why it isn't split further).
 *
 * @module type/expr-type
 */
import { isI32 } from '../ast.js'
import { ctx } from '../ctx.js'
import { VAL, lookupValType } from '../reps.js'
import {
  valTypeOfWithLocals, hasAmbiguousBoolMerge, censusShapedNode, censusMaybeUndefinedKind,
  exprPresentValIn, exprMapGetShapedIn,
} from '../kind.js'
import { propValType, CMP_OPS } from '../kind-traits.js'
import { NO_VALUE, staticValue, intExprRange } from '../static.js'
import { typedElemAux } from '../../layout.js'
import { typedStorageNameCtor } from '../typed-context.js'
import { inBoundsCharCodeAt } from './canonical-bounds.js'

// Resolve a name's typed-array element ctor: in-progress local overlay (analyzeBody) →
// per-func map (post-analyze) → module-global registry. The global fallback matters during
// analyzeBody/narrow when the per-func map is null, so a read of a *global* typed array
// (`DX[i]` with `let DX = new Int32Array(...)` at module scope) resolves its element type
// instead of defaulting to f64. Guard against local shadows / dynamic rewrites (cf. kind.js).
const typedElemCtorOf = (name, locals) => typedStorageNameCtor(ctx, name, locals)

// An expression whose i32 value carries the unsigned [0, 2^32) magnitude (not a signed i32):
// `>>>`, an unsigned-result call, or a Uint32Array read (aux 5 — the only typed array whose
// element can exceed signed-i32 range). The +/-/*/% rules widen these to f64 so `U[i] + 1`
// near 2^32 doesn't wrap; bitwise/store consumers are ToInt32-exact and keep the i32 bits.
const isUnsignedI32Expr = (e, locals) => Array.isArray(e) && (
  e[0] === '>>>' ||
  (e[0] === '()' && typeof e[1] === 'string' && ctx.funcs.map?.get(e[1])?.sig?.unsignedResult === true) ||
  (e[0] === '[]' && typeof e[1] === 'string' && typedElemAux(typedElemCtorOf(e[1], locals)) === 5)
)

/**
 * Infer expression result type from AST (without emitting).
 * Used to determine local variable types before compilation.
 * Looks up `locals` first, then current-function params (for i32-specialized params).
 *
 * `valTypes` (optional): Map<name, VAL.*> — VAL-KIND facts for the CURRENT
 * body's locals (analyzeBody(body).valTypes), consulted ONLY by the bitwise-
 * ops BigInt gate below. Round-6 prereq (a) sibling: that gate's own BigInt
 * check used a bare valTypeOf(expr), whose recursion into a bare identifier
 * (numericUnaryVT → valTypeOf(name) → the GLOBAL lookupValType) can't see a
 * local's kind before narrow.js's per-function reps are live — the exact gap
 * valTypeOfWithLocals (kind.js) exists to close. Phase E (narrowI32Results)
 * runs this early, so without `valTypes` a proven-BigInt local's `~`/`&`/etc.
 * return tail silently narrowed the function's WASM result to i32 (a NUMBER),
 * contradicting Phase E2's (narrowValResults, same body, same local) now-
 * correct BIGINT valResult claim — a WAT-validation crash, not a silent one,
 * since the two phases' facts about the SAME expression must agree. Omitted
 * by every other caller (defaults to undefined): they run late enough that
 * lookupValType alone is already sound, or don't call through this gate.
 */
// `bodyRoot` (optional, §14 point 4 fallout): the ctx-INDEPENDENT structural
// presentVal trace (kind.js exprPresentValIn/namePresentValInBody) for the
// bitwise-ops BigInt guard below, needed specifically by narrow.js's
// `narrowI32Results` — a whole-program pre-pass that runs BEFORE per-function
// `ctx.func.localReps` is live, so `censusMaybeUndefinedKind`'s bare-name arm
// (which DOES need ctx) can't see a presentVal-carrying local there. Every
// OTHER caller of exprType runs at emit time (`ctx.func.locals`, reps live)
// where `censusMaybeUndefinedKind` alone already resolves a bare name — they
// pass no `bodyRoot` and are unaffected (parameter is optional, threaded
// through recursive calls purely for the callers that do supply it).
export function exprType(expr, locals, valTypes, strict, bodyRoot) {
  if (expr == null) return 'f64'
  if (typeof expr === 'number')
    return isI32(expr) ? 'i32' : 'f64'
  if (typeof expr === 'string') {
    if (locals?.has?.(expr)) return locals.get(expr)
    const paramType = ctx.func.current?.params?.find(p => p.name === expr)?.type
    if (paramType) return paramType
    // A module-level INTEGER const (`const N = 16384`) is an integer compile-time
    // constant — type it i32 when it fits, regardless of the global's f64 (NaN-box)
    // storage. Otherwise a counter bounded by it (`for (i=0; i<N; i++)`) widens to
    // f64 and `x % N` / `x & N` / `x / N` take the f64 round-trip instead of the
    // native integer path (i32.rem_s / i32.and / i32.shr). Mirrors a literal int.
    const ci = ctx.scope?.constInts?.get?.(expr)
    if (ci != null && isI32(ci)) return 'i32'
    // Module-level numeric consts emitted as wasm globals with a known wasm type.
    // Only propagate primitive numeric kinds — i64 globals are reserved for the
    // NaN-box carrier ABI and shouldn't influence local typing.
    const gt = ctx.scope?.globalTypes?.get?.(expr)
    if (gt === 'i32' || gt === 'f64') return gt
    return 'f64'
  }
  if (!Array.isArray(expr)) return 'f64'

  const [op, ...args] = expr
  if (op == null) return exprType(args[0], locals, valTypes, strict, bodyRoot) // literal [, value]

  // Statically evaluable to -0 (e.g. -1 * 0) — i32 would lose the sign.
  const sv = staticValue(expr)
  if (sv !== NO_VALUE && typeof sv === 'number' && Object.is(sv, -0)) return 'f64'

  // Always f64
  if (op === '/' || op === '**' || op === '[' || op === '{}' || op === 'str') return 'f64'
  // arr[i] — integer typed arrays (Int8/Uint8/Int16/Uint16/Int32/Uint32, aux 0..5) read as i32:
  // the element IS a 32-bit machine integer, so a binding used in integer/bitwise ops stays i32
  // instead of round-tripping i32.load → f64 → trunc back (the deopt that made packed-pixel fade
  // loops like lorenz slow). Uint32 reads carry the full 0..2^32-1 range as the i32 bit-pattern;
  // ToInt32-coercing uses (& | ^ << >> >>>, i32.store) are bit-exact, and value uses that need the
  // unsigned magnitude (compare, f64 convert) go through the elem-aux's unsigned path. Floats
  // (Float32/Float64, aux 6/7) genuinely yield f64. typedElems: in-progress reads come from
  // localTypedElemsOverlay during analyzeBody; post-analyze passes read ctx.func.typedElem.
  if (op === '[]') {
    if (typeof args[0] === 'string') {
      // Resolve the element ctor across local overlay → per-func map → module-global registry
      // (the global fallback is why `DX[i]` on a module-scope Int32Array types as i32 instead of
      // f64-round-tripping integer accumulation like `ax = ax + DX[i]`). See typedElemCtorOf.
      const ctor = typedElemCtorOf(args[0], locals)
      if (ctor) {
        const aux = typedElemAux(ctor)
        // int family only — Float16Array shares code 3 with a flag; its elements are floats.
        // NOTE the i32 claim is a VALUE-context answer (ToInt32 consumers fold a
        // miss's undefined to 0, correctly). STORAGE narrowing (an i32 local
        // cell) must additionally prove the read cannot miss — the cell would
        // trunc_sat the miss's NaN to 0 — and that veto lives with the cell
        // writers in analyze.js (body-local proofs, cache-pure), not here:
        // exprType runs inside the context-pure cached analyzeBody where the
        // emit-time prover state (typedIdxProven) is unavailable/foreign.
        if (aux != null && (aux & 7) <= 5 && !(aux & 32)) return 'i32'
      }
    }
    return 'f64'
  }
  // A sized built-in property on a statically-known receiver (`.length` on
  // STRING/ARRAY/TYPED, `.size` on SET/MAP, `.byteLength`/`.byteOffset` on
  // TYPED/BUFFER) returns i32 directly (`__len`/`__str_byteLen` return i32).
  // Keeping it i32 lets analyzeBody keep the counter local i32, eliminating the
  // per-iteration `f64.convert_i32_s` widen and matching `arr[i]`/`i*k` truncs.
  // The membership lives in one place — `propValType` (src/kind-traits.js).
  if (op === '.') {
    if (typeof args[0] === 'string' && propValType(args[1], lookupValType(args[0])) === VAL.NUMBER) return 'i32'
    // Strict-int32 schema slot (write census): the read emits as a raw i32
    // (emitSchemaSlotRead's trunc route), so the static local-slot classifier
    // must agree — `const x = hitX ? p.x : nx` then declares x i32 instead of
    // f64, and the whole ternary/arith chain stays in int registers.
    if (typeof args[0] === 'string' && ctx.schema?.slotI32CertainAt?.(args[0], args[1])) return 'i32'
    return 'f64'
  }
  // Comparisons, logical-not, and unsigned shift always yield an i32 — a boolean,
  // or a ToUint32 result. True even on BigInt operands (`>>>` throws on bigint, so
  // it never reaches here with one).
  if (CMP_OPS.has(op) || op === '>>>') return 'i32'
  // Bitwise & signed-shift: i32 on numbers, but f64 when operands are BigInt — the
  // result is a bigint carried in the i64-bits-as-f64 ABI, not a 32-bit int.
  // valTypeOfWithLocals (not a bare valTypeOf(expr)): `valTypes` — when the
  // caller has it (narrowI32Results, this phase's only BigInt-sensitive
  // caller) — resolves a bare identifier's kind from analyzeBody's per-body
  // facts BEFORE narrow.js's global per-function reps are live; see the
  // module doc above exprType.
  if (['&', '|', '^', '~', '<<', '>>'].includes(op)) {
    // PRECISE census checks (§14 point 4 fallout) — an ACTUAL BIGINT-kind
    // resolution (censusMaybeUndefinedKind's own dictValueKindOf/mapValueKindOf
    // receiver-kind check filters out a plain array/typed-array receiver
    // already — never fires for `arr[i]`), plus the ctx-independent
    // `exprPresentValIn`/`exprMapGetShapedIn` structural twins for a
    // whole-program pre-pass where `ctx.func.localReps` isn't live yet.
    // Checked UNCONDITIONALLY, before `valTypeOfWithLocals` — NOT gated on
    // `vt == null` (a real regression this design's own §14 point 4 landing
    // found: the arithmetic/bitwise family's OWN deliberate "unknown operand
    // → NUMBER" optimistic default, kind.js, resolves `vt` to a DEFINITE
    // VAL.NUMBER for exactly this shape — bare census-sourced names, unresolved
    // by `resolveLocal` — so gating this behind `vt == null` skipped it
    // entirely, the WASM validator's own type-mismatch catching what would
    // otherwise have been a desynced boundary wrapper).
    const preciseBigCensus = (e) => censusMaybeUndefinedKind(e) === VAL.BIGINT ||
      (bodyRoot && (exprPresentValIn(e, bodyRoot) === VAL.BIGINT || exprMapGetShapedIn(e, bodyRoot)))
    if (preciseBigCensus(args[0]) || (args.length > 1 && preciseBigCensus(args[1]))) return 'f64'
    const vt = valTypeOfWithLocals(expr, name => valTypes?.get(name) ?? lookupValType(name))
    if (vt === VAL.BIGINT) return 'f64'
    // IMPRECISE, purely-structural fallback (censusShapedNode's own broad
    // `[]`/`.` arm ALSO matches an ordinary array/typed-array 2-arg index —
    // `arr[i] & mask` is common in hot bitwise code) — kept GATED on
    // `vt == null`, the EXACT original (pre-§14-point-4) condition, never
    // widened: unconditionally applying this broad check regressed
    // vectorization for exactly that ordinary-array shape (measured, caught
    // by the gate run — `test/inference.js`'s PRNG bitwise-kernel pin lost
    // its v128 codegen entirely), confirmed the array/typed-array case
    // reaches here with `vt` ALREADY non-null (definitively resolved), so
    // this arm is unreached for it either way — restored to its narrowest,
    // originally-verified-safe form.
    if (vt == null && (censusShapedNode(args[0]) || (args.length > 1 && censusShapedNode(args[1])))) return 'f64'
    return 'i32'
  }
  // Preserve i32 if both operands i32. `strict` additionally requires a
  // magnitude-bound proof the sum/difference fits signed i32 (P0-2 sibling,
  // 2026-08-02) — needed ONLY by callers deciding whether a value may escape
  // BARE with no further ToInt32 sink (tryI32Arith, emit.js). Every other
  // caller (local/param storage-type decisions — the overwhelming majority)
  // omits it: a value merely STORED i32 is safe regardless of magnitude,
  // since every read of that storage re-applies the identical ToInt32
  // conversion the write did — a magnitude-strict default here (measured,
  // reverted) demoted 8/10 perf-ratchet benchmarks' hottest accumulator/
  // index shapes from i32 to f64.
  if (op === '+' || op === '-') {
    const ta = exprType(args[0], locals, valTypes, strict)
    const tb = args[1] != null ? exprType(args[1], locals, valTypes, strict) : ta // unary: inherit
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // A uint32 operand ([0, 2^32)) makes the result exceed signed i32 range, so
    // emit widens to f64 (see emit.js `+`/`-`). exprType must agree — else
    // narrowing the result back to i32 would trunc_sat-saturate the f64 to INT32_MAX.
    if (isUnsignedI32Expr(args[0], locals) || (args[1] != null && isUnsignedI32Expr(args[1], locals))) return 'f64'
    if (!strict || args[1] == null) return 'i32'  // unary: no combination magnitude to bound
    if (sv !== NO_VALUE && typeof sv === 'number') return isI32(sv) ? 'i32' : 'f64'
    const bound = e => {
      const r = intExprRange(e)
      return r != null ? Math.max(Math.abs(r[0]), Math.abs(r[1])) : 0x80000000
    }
    return bound(args[0]) + bound(args[1]) <= 0x7fffffff ? 'i32' : 'f64'
  }
  // `%` is i32 only when emit takes the i32.rem_s path: both operands i32, neither
  // unsigned, AND the divisor is a nonzero integer constant. A 0 or runtime divisor
  // yields NaN via f64rem (f64), so result-narrowing must NOT see i32 here — else a
  // NaN remainder gets i32.trunc_sat'd to 0. Mirrors the emit.js `%` guard exactly.
  if (op === '%') {
    const ta = exprType(args[0], locals, valTypes, strict), tb = exprType(args[1], locals, valTypes, strict)
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    if (isUnsignedI32Expr(args[0], locals) || isUnsignedI32Expr(args[1], locals)) return 'f64'
    const dv = staticValue(args[1])
    return (dv !== NO_VALUE && typeof dv === 'number' && dv !== 0 && Number.isInteger(dv)) ? 'i32' : 'f64'
  }
  // `*` — a JS multiply is an f64 operation; `i32.mul` reproduces it faithfully
  // only when the exact product provably fits signed i32 (±(2^31−1)) — NOT
  // merely f64-exact (P0-2 ledger: the old "one literal operand ≤2^22, other
  // side unbounded" rule let `i32.mul` wrap past i32 range while staying
  // f64-representable, corrupting any consumer that widens the result straight
  // to f64). Stay i32 when both operands are i32 *and* the product provably
  // fits: a fully-static product checked directly, otherwise a magnitude BOUND
  // on EACH operand (intExprRange's hull — resolves module const-ints, ranged
  // decl reps, masks/ternaries) whose PRODUCT (not either bound alone) clears
  // the i32 ceiling. Mirrors emit.js `mulFitsI32`/`mulRangeFitsI32` exactly —
  // this must stay a SUBSET of emit's verdict (never claim i32 where emit
  // might widen to f64): an unproven operand costs the full i32 magnitude in
  // the product check, same sentinel emit's `maskBound` defaults to.
  if (op === '*') {
    const ta = exprType(args[0], locals, valTypes, strict), tb = exprType(args[1], locals, valTypes, strict)
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // uint32 operand: product can exceed i32; emit widens to f64 (see emit.js `*`).
    if (isUnsignedI32Expr(args[0], locals) || isUnsignedI32Expr(args[1], locals)) return 'f64'
    if (sv !== NO_VALUE && typeof sv === 'number') return isI32(sv) ? 'i32' : 'f64'
    const bound = e => {
      const r = intExprRange(e)
      return r != null ? Math.max(Math.abs(r[0]), Math.abs(r[1])) : 0x80000000
    }
    return bound(args[0]) * bound(args[1]) <= 0x7fffffff ? 'i32' : 'f64'
  }
  // `u+` truly just preserves its operand's type (ToNumber, no arithmetic). `u-`
  // is `0 - x` — same overflow shape as binary `-` (line ~2351 above) and needs
  // the same magnitude-bound proof under `strict`: negating I32_MIN (-2^31)
  // overflows to 2^31, one past I32_MAX, and negating a proven-unsigned i32
  // ([0, 2^32)) — a `>>>`/unsignedResult/Uint32Array-read value, or a
  // narrowUint32 accumulator local (isUnsignedI32Expr doesn't see the latter;
  // its range is simply unproven, so the generic bound fallback below already
  // catches it) — can go far past it (`-(3000000000)` = -3000000000). Missing
  // this let narrowI32Results (the only `strict` caller with no further
  // ToInt32 sink) commit a function's result to i32 for `return -y`, then
  // wrap the true value through i32.wrap_i64(trunc_sat) instead of leaving it
  // f64 — silently corrupting both `-(-2^31)` (signed) and `-(unsigned h)`.
  if (op === 'u+') return exprType(args[0], locals, valTypes, strict)
  if (op === 'u-') {
    const t = exprType(args[0], locals, valTypes, strict)
    if (t !== 'i32') return t
    if (isUnsignedI32Expr(args[0], locals)) return 'f64'
    if (!strict) return 'i32'
    if (sv !== NO_VALUE && typeof sv === 'number') return isI32(sv) ? 'i32' : 'f64'
    const r = intExprRange(args[0])
    const bound = r != null ? Math.max(Math.abs(r[0]), Math.abs(r[1])) : 0x80000000
    return bound <= 0x7fffffff ? 'i32' : 'f64'
  }
  // Ternary / logical: conciliate
  if (op === '?:' || op === '&&' || op === '||') {
    const branches = op === '?:' ? [args[1], args[2]] : [args[0], args[1]]
    const ta = exprType(branches[0], locals, valTypes, strict), tb = exprType(branches[1], locals, valTypes, strict)
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // research.md §Carrier invariant: both branches are i32-REPRESENTABLE (a
    // comparison's 0/1 and a NUMBER literal both answer 'i32' here — this
    // function only asks "does the WASM storage type fit", not "do the two
    // branches carry the same represented VALUE"), but a BOOL∪NUMBER merge
    // (`cond && 1`, `cond ? 1 : false`) needs its BOOL arm to keep its
    // TRUE/FALSE atom identity — an i32-classification is exactly what lets
    // a caller narrow this expression's storage to i32 and permanently lose
    // that atom (narrowI32Results' return-tail narrowing, the param lattice's
    // argWasmType — both consult exprType, both would otherwise commit to a
    // narrowing no downstream boxing fix could recover from). hasAmbiguousBoolMerge
    // is the same locals-aware resolver Phase E's BigInt gate two branches up
    // already needed (this phase runs before ctx.func.localReps is populated).
    if (hasAmbiguousBoolMerge(expr, e => valTypeOfWithLocals(e, name => valTypes?.get(name) ?? lookupValType(name))))
      return 'f64'
    return 'i32'
  }
  if (op === '[') return 'f64'
  // Builtin calls with known i32 result. Math.imul / Math.clz32 always produce
  // a 32-bit integer; recognising this here keeps `let x = Math.imul(...)` (and
  // chains like `x = Math.imul(x, k) + 12345`) on the i32 ABI all the way
  // through, instead of widening the local to f64 because exprType defaulted.
  if (op === '()') {
    if (args[0] === 'math.imul' || args[0] === 'math.clz32') return 'i32'
    // SIMD intrinsics → v128 lane vector, except lane-extract / reductions which
    // hand a scalar back (i32x4.lane / v128.anyTrue / v128.allTrue → i32;
    // f32x4.lane → f64). See module/simd.js.
    if (typeof args[0] === 'string' && (args[0].startsWith('f32x4.') || args[0].startsWith('i32x4.') || args[0].startsWith('f64x2.') || args[0].startsWith('v128.'))) {
      if (args[0] === 'f32x4.lane' || args[0] === 'f64x2.lane') return 'f64'
      if (args[0] === 'i32x4.lane' || args[0] === 'v128.anyTrue' || args[0] === 'v128.allTrue') return 'i32'
      return 'v128'
    }
    // charCodeAt: i32 when the index is provably in `[0, recv.length)` (an
    // induction variable bounded by `recv.length` — OOB impossible). Otherwise
    // f64: the JS-spec OOB result is NaN, which is not representable as i32.
    if (Array.isArray(args[0]) && args[0][0] === '.' && args[0][2] === 'charCodeAt'
        && inBoundsCharCodeAt(ctx).has(args[0])) return 'i32'
    // User-function call: consult the callee's narrowed result type. By the time
    // analyzeBody runs in emitFunc, narrowSignatures has set sig.results[0]='i32'
    // on every body-i32-only func. Propagating this lets `let h = userFn(...)`
    // (mix in callback bench: i32-FNV) keep h as an i32 local instead of widening
    // to f64 and round-tripping i32↔f64 every iteration.
    if (typeof args[0] === 'string') {
      const f = ctx.funcs.map?.get(args[0])
      if (f?.sig?.results?.length === 1 && f.sig.results[0] === 'i32' && f.sig.ptrKind == null) return 'i32'
      if (f?.sig?.results?.length === 1 && f.sig.results[0] === 'v128') return 'v128'   // SIMD helper
    }
  }
  return 'f64'
}
