/**
 * Expression result type inference (i32 vs f64) without emitting.
 * @module types
 */
import { isI32 } from './ast.js'
import { ctx } from './ctx.js'
import { VAL, lookupValType } from './reps.js'
import { NO_VALUE, staticValue } from './static.js'
import { typedElemAux } from './typed.js'
import { inBoundsCharCodeAt } from './bounds.js'

const isUnsignedI32Expr = (e) => Array.isArray(e) && (
  e[0] === '>>>' ||
  (e[0] === '()' && typeof e[1] === 'string' && ctx.func.map?.get(e[1])?.sig?.unsignedResult === true)
)

/**
 * Infer expression result type from AST (without emitting).
 * Used to determine local variable types before compilation.
 * Looks up `locals` first, then current-function params (for i32-specialized params).
 */
export function exprType(expr, locals) {
  if (expr == null) return 'f64'
  if (typeof expr === 'number')
    return isI32(expr) ? 'i32' : 'f64'
  if (typeof expr === 'string') {
    if (locals?.has?.(expr)) return locals.get(expr)
    const paramType = ctx.func.current?.params?.find(p => p.name === expr)?.type
    if (paramType) return paramType
    // Module-level numeric consts (top-level `const N = 128`) are emitted as
    // wasm globals with a known wasm type. Without this lookup, references to
    // them inside functions fall back to f64, widening counters bounded by the
    // const (`for (let r = 0; r < N_ROUNDS; r++)`) to f64 via the comparison
    // pass. Only propagate primitive numeric kinds — i64 globals are reserved
    // for the NaN-box carrier ABI and shouldn't influence local typing.
    const gt = ctx.scope?.globalTypes?.get?.(expr)
    if (gt === 'i32' || gt === 'f64') return gt
    return 'f64'
  }
  if (!Array.isArray(expr)) return 'f64'

  const [op, ...args] = expr
  if (op == null) return exprType(args[0], locals) // literal [, value]

  // Statically evaluable to -0 (e.g. -1 * 0) — i32 would lose the sign.
  const sv = staticValue(expr)
  if (sv !== NO_VALUE && typeof sv === 'number' && Object.is(sv, -0)) return 'f64'

  // Always f64
  if (op === '/' || op === '**' || op === '[' || op === '{}' || op === 'str') return 'f64'
  // arr[i] — typed integer arrays return i32. Only Int8/Uint8/Int16/Uint16/Int32
  // (every value fits in signed i32). Skip Uint32: 0..2^32-1 overflows signed.
  // During analyzeBody the in-progress typedElems is in localTypedElemsOverlay;
  // post-analyze passes read from ctx.types.typedElem.
  if (op === '[]') {
    if (typeof args[0] === 'string') {
      const ctor = ctx.func.localTypedElemsOverlay?.get(args[0]) ?? ctx.types.typedElem?.get(args[0])
      if (ctor) {
        const aux = typedElemAux(ctor)
        if (aux != null && (aux & 7) <= 4) return 'i32'
      }
    }
    return 'f64'
  }
  // `.length` on a known sized receiver returns i32 directly (__len/__str_byteLen
  // both return i32). Letting it stay i32 lets analyzeBody keep the counter
  // local i32 too, eliminating the per-iteration `f64.convert_i32_s` widen and
  // the matching `i32.trunc_sat_f64_s` truncs at every `arr[i]` / `i*k` site.
  // Only safe when receiver type is statically known to expose an integer length.
  if (op === '.') {
    if (args[1] === 'length' && typeof args[0] === 'string') {
      const vt = lookupValType(args[0])
      if (vt === VAL.TYPED || vt === VAL.ARRAY || vt === VAL.STRING || vt === VAL.BUFFER) return 'i32'
    }
    if (args[1] === 'size' && typeof args[0] === 'string') {
      const vt = lookupValType(args[0])
      if (vt === VAL.SET || vt === VAL.MAP) return 'i32'
    }
    if (args[1] === 'byteLength' && typeof args[0] === 'string') {
      const vt = lookupValType(args[0])
      if (vt === VAL.BUFFER || vt === VAL.TYPED) return 'i32'
    }
    return 'f64'
  }
  // Always i32
  if (['>', '<', '>=', '<=', '==', '!=', '!', '&', '|', '^', '~', '<<', '>>', '>>>'].includes(op)) return 'i32'
  // Preserve i32 if both operands i32
  if (op === '+' || op === '-' || op === '%') {
    const ta = exprType(args[0], locals)
    const tb = args[1] != null ? exprType(args[1], locals) : ta // unary: inherit
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // A uint32 operand ([0, 2^32)) makes the result exceed signed i32 range, so
    // emit widens to f64 (see emit.js `+`/`-`/`%`). exprType must agree — else
    // narrowing the result back to i32 would trunc_sat-saturate the f64 to INT32_MAX.
    if (isUnsignedI32Expr(args[0]) || (args[1] != null && isUnsignedI32Expr(args[1]))) return 'f64'
    return 'i32'
  }
  // `*` — a JS multiply is an f64 operation; `i32.mul` reproduces it faithfully
  // only while the exact product is f64-exact. Stay i32 when both operands are
  // i32 *and* the product provably fits: a fully-static product checked
  // directly, otherwise a literal operand small enough that |literal|·2^31 ≤
  // 2^53 (mirrors emit.js `mulFitsI32` — keeps `i*4` i32, widens `h*16777619`).
  if (op === '*') {
    const ta = exprType(args[0], locals), tb = exprType(args[1], locals)
    if (ta !== 'i32' || tb !== 'i32') return 'f64'
    // uint32 operand: product can exceed i32; emit widens to f64 (see emit.js `*`).
    if (isUnsignedI32Expr(args[0]) || isUnsignedI32Expr(args[1])) return 'f64'
    if (sv !== NO_VALUE && typeof sv === 'number') return isI32(sv) ? 'i32' : 'f64'
    const small = e => {
      const v = staticValue(e)
      return v !== NO_VALUE && typeof v === 'number' && Math.abs(v) <= 0x400000
    }
    return small(args[0]) || small(args[1]) ? 'i32' : 'f64'
  }
  // Unary preserves type
  if (op === 'u-' || op === 'u+') return exprType(args[0], locals)
  // Ternary / logical: conciliate
  if (op === '?:' || op === '&&' || op === '||') {
    const branches = op === '?:' ? [args[1], args[2]] : [args[0], args[1]]
    const ta = exprType(branches[0], locals), tb = exprType(branches[1], locals)
    return ta === 'i32' && tb === 'i32' ? 'i32' : 'f64'
  }
  if (op === '[') return 'f64'
  // Builtin calls with known i32 result. Math.imul / Math.clz32 always produce
  // a 32-bit integer; recognising this here keeps `let x = Math.imul(...)` (and
  // chains like `x = Math.imul(x, k) + 12345`) on the i32 ABI all the way
  // through, instead of widening the local to f64 because exprType defaulted.
  if (op === '()') {
    if (args[0] === 'math.imul' || args[0] === 'math.clz32') return 'i32'
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
      const f = ctx.func.map?.get(args[0])
      if (f?.sig?.results?.length === 1 && f.sig.results[0] === 'i32' && f.sig.ptrKind == null) return 'i32'
    }
  }
  return 'f64'
}
