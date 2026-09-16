/**
 * `exprType` — infer expression result type (i32 vs f64) from AST, without
 * emitting. Used to determine local variable types before compilation. HALF
 * of a two-file shared contract with `emit.js` (see the doc comment above
 * `exprType` below): "when does i32 arithmetic stay i32 vs widen to f64" is
 * decided in TWO places that must agree — emit.js DECIDES, this mirrors —
 * kept as one dispatch function so that contract stays legible as a whole
 * (see `.work/archive/type-split.md` for why it isn't split further).
 *
 * @module type/expr-type
 */
import { isI32 } from '../ast.js'
import { ctx } from '../ctx.js'
import { K, hasTag } from '../summary/kind.js'
import { VAL, lookupValType, repOf } from '../reps.js'
import {
  hasAmbiguousBoolMerge, censusShapedNode,
} from '../kind.js'
import { propValType, CMP_OPS } from '../kind-traits.js'
import { NO_VALUE, staticValue, intExprRange, constIntExpr, mulRangeFitsI32, negRangeFitsI32 } from '../static.js'
import { typedElemAux } from '../../layout.js'
import { typedStorageNameCtor } from '../typed-context.js'
import { inBoundsCharCodeAt } from './canonical-bounds.js'

// The bitwise and signed-shift operators: i32 on numbers, f64 (the i64 carrier) on BigInts.
const SIGNED_BIT_OPS = new Set(['&', '|', '^', '~', '<<', '>>'])

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
const isUnsignedI32Expr = (e, locals) => typeof e === 'string' ? !!repOf(e)?.unsigned : Array.isArray(e) && (
  e[0] === '>>>' ||
  (e[0] === '()' && typeof e[1] === 'string' && ctx.funcs.map?.get(e[1])?.sig?.unsignedResult === true) ||
  (e[0] === '[]' && typeof e[1] === 'string' && (typedElemAux(typedElemCtorOf(e[1], locals)) & 7) === 5)
)

/**
 * Infer expression result type from AST (without emitting).
 * Used to determine local variable types before compilation.
 * Looks up `locals` first, then current-function params (for i32-specialized params).
 *
 * `bodyRoot` selects the settled summary scope during whole-program narrowing.
 * Supplying `readPresent` selects lossless storage/result typing: only these
 * exact typed-read nodes may lose absence, and unsigned words need widening.
 * Without it, integer payloads stay i32 for word-coercing consumers.
 */
// Whole-program callers supply the body to select its settled summary scope.
export function exprType(expr, locals, valTypes, strict, bodyRoot, readPresent) {
  if (expr == null) return 'f64'
  if (typeof expr === 'number')
    return isI32(expr) ? 'i32' : 'f64'
  if (typeof expr === 'string') {
    if (locals?.has?.(expr)) return readPresent && repOf(expr)?.unsigned ? 'f64' : locals.get(expr)
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

  const op = expr[0]
  const arity = expr.length - 1
  if (op == null) return exprType(expr[1], locals, valTypes, strict, bodyRoot, readPresent) // literal [, value]

  // Statically evaluable to -0 (e.g. -1 * 0) — i32 would lose the sign.
  const sv = staticValue(expr)
  if (sv !== NO_VALUE && typeof sv === 'number' && Object.is(sv, -0)) return 'f64'

  // Always f64
  if (op === '/' || op === '**' || op === '[' || op === '{}' || op === 'str') return 'f64'
  // Integer typed payloads use i32 for word-coercing consumers. Storing a
  // Uint32 value also requires preserving its unsigned magnitude.
  if (op === '[]') {
    if (typeof expr[1] === 'string') {
      // Resolve the element ctor across local overlay → per-func map → module-global registry
      // (the global fallback is why `DX[i]` on a module-scope Int32Array types as i32 instead of
      // f64-round-tripping integer accumulation like `ax = ax + DX[i]`). See typedElemCtorOf.
      const ctor = typedElemCtorOf(expr[1], locals)
      if (ctor) {
        const aux = typedElemAux(ctor)
        // int family only — Float16Array shares code 3 with a flag; its elements are floats.
        // Payload classification only: a possible missing read still needs
        // a separate storage-presence proof before committing an i32 local.
        if (aux != null && (aux & 7) <= 5 && !(aux & 32))
          return !readPresent || ((aux & 7) !== 5 && readPresent.has(expr)) ? 'i32' : 'f64'
      }
    }
    return 'f64'
  }
  // A sized built-in property on a statically-known receiver (`.length` on
  // STRING/ARRAY/TYPED, `.size` on SET/MAP, `.byteLength`/`.byteOffset` on
  // TYPED/BUFFER) returns i32 directly (`__len`/`__str_length` return i32).
  // Keeping it i32 lets analyzeBody keep the counter local i32, eliminating the
  // per-iteration `f64.convert_i32_s` widen and matching `arr[i]`/`i*k` truncs.
  // The membership lives in one place — `propValType` (src/kind-traits.js).
  if (op === '.') {
    if (typeof expr[1] === 'string' && propValType(expr[2], lookupValType(expr[1]), expr[2] === 'length' ? typedElemCtorOf(expr[1], locals) : null) === VAL.NUMBER) return 'i32'
    // Strict-int32 schema slot (write census): the read emits as a raw i32
    // (emitSchemaSlotRead's trunc route), so the static local-slot classifier
    // must agree — `const x = hitX ? p.x : nx` then declares x i32 instead of
    // f64, and the whole ternary/arith chain stays in int registers.
    if (typeof expr[1] === 'string' && ctx.schema?.slotI32CertainAt?.(expr[1], expr[2])) return 'i32'
    return 'f64'
  }
  // Comparisons, logical-not, and unsigned shift always yield an i32 — a boolean,
  // or a ToUint32 result. True even on BigInt operands (`>>>` throws on bigint, so
  // it never reaches here with one).
  if (CMP_OPS.has(op) || op === '>>>') return 'i32'
  // Bitwise & signed-shift: i32 on numbers, but f64 when operands are BigInt — the
  // result is a bigint carried in the i64-bits-as-f64 ABI, not a 32-bit int.
  if (SIGNED_BIT_OPS.has(op)) {
    const summary = ctx.summary?.at(bodyRoot ?? ctx.func.current)
    if (summary && hasTag(summary.kindOfExpr(expr), K.BIGINT)) return 'f64'
    const vt = summary?.valOfExpr(expr)
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
    if (vt == null && (censusShapedNode(expr[1]) || (arity > 1 && censusShapedNode(expr[2])))) return 'f64'
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
    const ta = exprType(expr[1], locals, valTypes, strict, bodyRoot, readPresent)
    const tb = expr[2] != null ? exprType(expr[2], locals, valTypes, strict, bodyRoot, readPresent) : ta // unary: inherit
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // A uint32 operand ([0, 2^32)) makes the result exceed signed i32 range, so
    // emit widens to f64 (see emit.js `+`/`-`). exprType must agree — else
    // narrowing the result back to i32 would trunc_sat-saturate the f64 to INT32_MAX.
    if (isUnsignedI32Expr(expr[1], locals) || (expr[2] != null && isUnsignedI32Expr(expr[2], locals))) return 'f64'
    if (expr[2] == null) return op === '+' || negRangeFitsI32(expr[1]) ? 'i32' : 'f64'
    if (!strict) return 'i32'
    if (sv !== NO_VALUE && typeof sv === 'number') return isI32(sv) ? 'i32' : 'f64'
    const bound = e => {
      const r = intExprRange(e)
      return r != null ? Math.max(Math.abs(r[0]), Math.abs(r[1])) : 0x80000000
    }
    return bound(expr[1]) + bound(expr[2]) <= 0x7fffffff ? 'i32' : 'f64'
  }
  // `%` is i32 only when emit takes the i32.rem_s path: both operands i32, neither
  // unsigned, AND the divisor is a nonzero integer constant. A 0 or runtime divisor
  // yields NaN via f64rem (f64), so result-narrowing must NOT see i32 here — else a
  // NaN remainder gets i32.trunc_sat'd to 0. Mirrors the emit.js `%` guard exactly.
  if (op === '%') {
    const ta = exprType(expr[1], locals, valTypes, strict, bodyRoot, readPresent), tb = exprType(expr[2], locals, valTypes, strict, bodyRoot, readPresent)
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // the divisor as a folded module-const expression (`MAXPTS - 20 + 1`) is a literal too
    const dv = staticValue(expr[2]) !== NO_VALUE ? staticValue(expr[2]) : (constIntExpr(expr[2]) ?? NO_VALUE)
    if (isUnsignedI32Expr(expr[2], locals)) return 'f64'
    // A uint32 dividend by a positive literal takes emit's `i32.rem_u` path;
    // the remainder is below the divisor, a signed i32 whenever K ≤ 2^31.
    if (isUnsignedI32Expr(expr[1], locals))
      return (dv !== NO_VALUE && typeof dv === 'number' && Number.isInteger(dv) && dv > 0 && dv <= 0x80000000) ? 'i32' : 'f64'
    return (dv !== NO_VALUE && typeof dv === 'number' && dv !== 0 && Number.isInteger(dv)) ? 'i32' : 'f64'
  }
  // Storage and emission share the same product proof: both the magnitude
  // and the zero sign must survive an i32 multiply.
  if (op === '*') {
    const ta = exprType(expr[1], locals, valTypes, strict, bodyRoot, readPresent), tb = exprType(expr[2], locals, valTypes, strict, bodyRoot, readPresent)
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // uint32 operand: product can exceed i32; emit widens to f64 (see emit.js `*`).
    if (isUnsignedI32Expr(expr[1], locals) || isUnsignedI32Expr(expr[2], locals)) return 'f64'
    if (sv !== NO_VALUE && typeof sv === 'number') return isI32(sv) ? 'i32' : 'f64'
    return mulRangeFitsI32(expr[1], expr[2]) ? 'i32' : 'f64'
  }
  // Unary minus shares emission's magnitude and zero-sign proof.
  if (op === 'u+') return exprType(expr[1], locals, valTypes, strict, bodyRoot, readPresent)
  if (op === 'u-') {
    const t = exprType(expr[1], locals, valTypes, strict, bodyRoot, readPresent)
    return t === 'i32' && !isUnsignedI32Expr(expr[1], locals) && negRangeFitsI32(expr[1]) ? 'i32' : 'f64'
  }
  // Ternary / logical: conciliate
  if (op === '?:' || op === '&&' || op === '||') {
    const branches = op === '?:' ? [expr[2], expr[3]] : [expr[1], expr[2]]
    const ta = exprType(branches[0], locals, valTypes, strict, bodyRoot, readPresent), tb = exprType(branches[1], locals, valTypes, strict, bodyRoot, readPresent)
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
    if (hasAmbiguousBoolMerge(expr, e => ctx.summary?.at(bodyRoot ?? ctx.func.current).valOfExpr(e)))
      return 'f64'
    return 'i32'
  }
  if (op === '[') return 'f64'
  // Builtin calls with known i32 result. Math.imul / Math.clz32 always produce
  // a 32-bit integer; recognising this here keeps `let x = Math.imul(...)` (and
  // chains like `x = Math.imul(x, k) + 12345`) on the i32 ABI all the way
  // through, instead of widening the local to f64 because exprType defaulted.
  if (op === '()') {
    if (expr[1] === 'math.imul' || expr[1] === 'math.clz32') return 'i32'
    // SIMD intrinsics → v128 lane vector, except lane-extract / reductions which
    // hand a scalar back (i32x4.lane / v128.anyTrue / v128.allTrue → i32;
    // f32x4.lane → f64). See module/simd.js.
    if (typeof expr[1] === 'string' && (expr[1].startsWith('f32x4.') || expr[1].startsWith('i32x4.') || expr[1].startsWith('f64x2.') || expr[1].startsWith('v128.'))) {
      if (expr[1] === 'f32x4.lane' || expr[1] === 'f64x2.lane') return 'f64'
      if (expr[1] === 'i32x4.lane' || expr[1] === 'v128.anyTrue' || expr[1] === 'v128.allTrue') return 'i32'
      return 'v128'
    }
    // charCodeAt: i32 when the index is provably in `[0, recv.length)` (an
    // induction variable bounded by `recv.length` — OOB impossible). Otherwise
    // f64: the JS-spec OOB result is NaN, which is not representable as i32.
    if (Array.isArray(expr[1]) && expr[1][0] === '.' && expr[1][2] === 'charCodeAt'
        && inBoundsCharCodeAt(ctx).has(expr[1])) return 'i32'
    // User-function call: consult the callee's narrowed result type. By the time
    // analyzeBody runs in emitFunc, narrowSignatures has set sig.results[0]='i32'
    // on every body-i32-only func. Propagating this lets `let h = userFn(...)`
    // (mix in callback bench: i32-FNV) keep h as an i32 local instead of widening
    // to f64 and round-tripping i32↔f64 every iteration.
    if (typeof expr[1] === 'string') {
      const f = ctx.funcs.map?.get(expr[1])
      if (f?.sig?.results?.length === 1 && f.sig.results[0] === 'i32' && f.sig.ptrKind == null) return 'i32'
      if (f?.sig?.results?.length === 1 && f.sig.results[0] === 'v128') return 'v128'   // SIMD helper
    }
  }
  return 'f64'
}
