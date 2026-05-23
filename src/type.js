/**
 * WASM local typing + typed-array metadata + integer proofs.
 *
 * - exprType: i32 vs f64 for locals/params
 * - typedElem*: PTR.TYPED NaN-box aux encoding
 * - scanBoundedLoops / inBoundsCharCodeAt: charCodeAt i32 contract proof
 * - intCertainMap / intExprChecker: integer-shaped binding analysis
 *
 * @module type
 */
import { isI32, isReassigned } from './ast.js'
import { ctx } from './ctx.js'
import { VAL, lookupValType } from './reps.js'
import { NO_VALUE, staticValue, intLiteralValue } from './static.js'

/** Extract typed-array ctor name ('new.Float32Array', 'new.Int8Array.view', etc) from RHS,
 *  or null if RHS isn't a typed-array/ArrayBuffer/DataView constructor. */
export function typedElemCtor(rhs) {
  if (!Array.isArray(rhs) || rhs[0] !== '()' || typeof rhs[1] !== 'string' || !rhs[1].startsWith('new.')) return null
  const args = rhs[2]
  const isView = rhs[1].endsWith('Array') && rhs[1] !== 'new.ArrayBuffer'
    && Array.isArray(args) && args[0] === ',' && args.length >= 4
  return isView ? rhs[1] + '.view' : rhs[1]
}

/** Base element-type codes for PTR.TYPED aux (0–7). BigInt ctors share 7 + TYPED_ELEM_BIGINT_FLAG. */
export const TYPED_ELEM_CODE = {
  Int8Array: 0, Uint8Array: 1, Int16Array: 2, Uint16Array: 3,
  Int32Array: 4, Uint32Array: 5, Float32Array: 6, Float64Array: 7,
  BigInt64Array: 7, BigUint64Array: 7,
}
export const TYPED_ELEM_VIEW_FLAG = 8
export const TYPED_ELEM_BIGINT_FLAG = 16

/** Encode element-type name (+ optional view/bigint flags) to PTR.TYPED aux bits. */
export function encodeTypedElemAux(name, isView = false) {
  const et = TYPED_ELEM_CODE[name]
  if (et == null) return null
  return et | (isView ? TYPED_ELEM_VIEW_FLAG : 0) |
    (name === 'BigInt64Array' || name === 'BigUint64Array' ? TYPED_ELEM_BIGINT_FLAG : 0)
}

/** Encode a `typedElemCtor` string ('new.Int32Array' | 'new.Int32Array.view') to the 4-bit
 *  aux value used in PTR.TYPED NaN-boxing. Returns null for unknown ctors (ArrayBuffer/DataView). */
export function typedElemAux(ctor) {
  if (!ctor || !ctor.startsWith('new.')) return null
  const isView = ctor.endsWith('.view')
  const name = isView ? ctor.slice(4, -5) : ctor.slice(4)
  return encodeTypedElemAux(name, isView)
}
const TYPED_ELEM_NAMES = ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']
export { TYPED_ELEM_NAMES }
/** Reverse of typedElemAux: pick a canonical ctor string for a 4-bit elem aux. Used
 *  to round-trip TYPED-narrowed call results through ctx.types.typedElem so the
 *  unboxed local's rep picks up the same aux. aux=7 is shared with BigInt typed
 *  arrays — Float64Array is canonical (read-side compares aux only). */
export function ctorFromElemAux(aux) {
  if (aux == null) return null
  const isView = (aux & 8) !== 0
  const name = (aux & 16) !== 0 ? 'BigInt64Array' : TYPED_ELEM_NAMES[aux & 7]
  if (!name) return null
  return isView ? `new.${name}.view` : `new.${name}`
}

/** Sentinel returned by `ternaryCtorOfRhs` when ternary branches resolve to
 *  different typed-array ctors — caller should drop any cached entry rather
 *  than leave a stale ctor (which would lock the wrong store width). */
export const MIXED_CTORS = Symbol('MIXED_CTORS')


/** A `?:`/`&&`/`||` expression — value depends on a condition, so its ctor
 *  must be derived by walking branches (handled by `ternaryCtorOfRhs`). */
export const isCondExpr = e => Array.isArray(e) && (e[0] === '?:' || e[0] === '&&' || e[0] === '||')

/** Walk a `?:`/`&&`/`||` expression and return:
 *  - a single ctor string when every branch resolves to the same ctor,
 *  - MIXED_CTORS when branches resolve to different ctors,
 *  - null when no branch resolves (caller's behavior unchanged). */
export function ternaryCtorOfRhs(rhs) {
  if (!Array.isArray(rhs)) return null
  const op = rhs[0]
  const lo = op === '?:' ? 2 : (op === '&&' || op === '||') ? 1 : 0
  if (!lo) return null
  const a = ternaryCtorOfRhs(rhs[lo]) ?? typedElemCtor(rhs[lo])
  const b = ternaryCtorOfRhs(rhs[lo + 1]) ?? typedElemCtor(rhs[lo + 1])
  return a && b ? (a === b ? a : MIXED_CTORS) : (a || b || null)
}

// =============================================================================
// charCodeAt in-bounds proof
// =============================================================================
// `String.prototype.charCodeAt` returns NaN for an out-of-range index, so the
// generic codegen contract is an f64 result (see module/string.js). When the
// index is the induction variable of a `for (let i = C; i < recv.length; i++)`
// loop, every `recv.charCodeAt(i)` in the loop body is statically inside
// `[0, recv.length)` — OOB is impossible — so the call may use the cheaper i32
// (raw-byte) contract instead. This is a static guarantee, not a guess.

/** Step expression of a `for` that increments `name` by exactly 1. */
function isUnitIncrement(step, name) {
  if (!Array.isArray(step)) return false
  if (step[0] === '++' && step[1] === name) return true
  // postfix `i++` in value position lowers to `(++i) - 1`
  if (step[0] === '-' && Array.isArray(step[1]) && step[1][0] === '++'
      && step[1][1] === name && intLiteralValue(step[2]) === 1) return true
  return false
}

/** `let`/`const` re-declaration of `name` within `node` — does not cross `=>`
 *  (a closure has its own scope; collection already stops at closure boundaries). */
function redeclaresName(node, name) {
  if (!Array.isArray(node) || node[0] === '=>') return false
  if (node[0] === 'let' || node[0] === 'const') {
    for (let k = 1; k < node.length; k++) {
      const d = node[k]
      if (d === name) return true
      if (Array.isArray(d) && d[0] === '=' && d[1] === name) return true
    }
  }
  for (let k = 1; k < node.length; k++) if (redeclaresName(node[k], name)) return true
  return false
}

/** Collect `recv.charCodeAt(idxVar)` callee nodes within `node`. Stops at `=>`:
 *  a closure may run after the loop, when `idxVar` has reached `recv.length`. */
function collectBoundedCC(node, recv, idxVar, set) {
  if (!Array.isArray(node) || node[0] === '=>') return
  if (node[0] === '()' && node.length === 3 && node[2] === idxVar
      && Array.isArray(node[1]) && node[1][0] === '.'
      && node[1][1] === recv && node[1][2] === 'charCodeAt')
    set.add(node[1])
  for (let k = 1; k < node.length; k++) collectBoundedCC(node[k], recv, idxVar, set)
}

/** Receiver of a `.length` expression, possibly wrapped in `(… | 0)` — the
 *  shape `prepare` produces when it hoists a for-cond bound. */
function lengthRecv(expr) {
  if (Array.isArray(expr) && expr[0] === '|' && intLiteralValue(expr[2]) === 0) expr = expr[1]
  if (Array.isArray(expr) && expr[0] === '.' && expr[2] === 'length'
      && typeof expr[1] === 'string') return expr[1]
  return null
}

/** Flatten `let`/`const` declarations (incl. `;`-joined groups) into `out`,
 *  mapping each declared name to its initializer expression. */
function collectDecls(node, out) {
  if (!Array.isArray(node)) return
  if (node[0] === ';') { for (let k = 1; k < node.length; k++) collectDecls(node[k], out); return }
  if (node[0] === 'let' || node[0] === 'const') {
    for (let k = 1; k < node.length; k++) {
      const d = node[k]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') out.set(d[1], d[2])
    }
  }
}

/** Walk `node`, recording in `set` the `charCodeAt` callee nodes proven in-bounds
 *  by an enclosing canonical induction loop `for (let i = C; i < recv.length; i++)`.
 *  Matches the post-`prepare` shape, where the `.length` bound is hoisted into a
 *  temp (`cond` becomes `i < lenTmp`, `lenTmp` declared in `init`). */
export function scanBoundedLoops(node, set) {
  if (!Array.isArray(node)) return
  if (node[0] === 'for' && node.length === 5) {
    const [, init, cond, step, body] = node
    let idx = null, recv = null, boundVar = null
    if (Array.isArray(cond) && cond[0] === '<' && typeof cond[1] === 'string') {
      const decls = new Map()
      collectDecls(init, decls)
      idx = cond[1]
      // index must be declared in `init` as `let i = C`, C an integer literal ≥ 0
      const start = decls.has(idx) ? intLiteralValue(decls.get(idx)) : null
      if (start == null || start < 0) idx = null
      // bound is `recv.length`, directly or via a hoisted temp declared in `init`
      let bound = cond[2]
      if (typeof bound === 'string') { boundVar = bound; bound = decls.get(bound) }
      recv = lengthRecv(bound)
    }
    // step `i++`; body never writes `i`/`recv`/the bound temp (incl. via
    // closures) and never re-declares `i`. Then every bare `i` in the body
    // satisfies `0 ≤ C ≤ i < recv.length`.
    if (idx && recv && idx !== recv && isUnitIncrement(step, idx)
        && !isReassigned(body, idx) && !isReassigned(body, recv)
        && (boundVar == null || !isReassigned(body, boundVar))
        && !redeclaresName(body, idx))
      collectBoundedCC(body, recv, idx, set)
  }
  for (let k = 1; k < node.length; k++) scanBoundedLoops(node[k], set)
}

const NO_BOUNDED_CC = new Set()  // shared immutable empty result

/** Set of `['.', recv, 'charCodeAt']` callee nodes in the current function whose
 *  index argument is provably within `[0, recv.length)`. Memoised per body. */
export function inBoundsCharCodeAt(ctx) {
  const body = ctx.func?.body
  if (!Array.isArray(body)) return NO_BOUNDED_CC
  if (ctx.func._ccBody === body) return ctx.func.ccInBounds
  const set = new Set()
  scanBoundedLoops(body, set)
  ctx.func.ccInBounds = set
  ctx.func._ccBody = body
  return set
}

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

// === Integer-certainty fixpoint (shared by analyzeIntCertain + program-facts) ===

const INT_BIT_OPS = new Set(['|', '&', '^', '~', '<<', '>>', '>>>'])
const INT_CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!=', '===', '!==', '!'])
const INT_CLOSED_OPS = new Set(['+', '-', '*', '%'])
const INT_MATH_FNS = new Set(['imul', 'clz32', 'floor', 'ceil', 'round', 'trunc'])

function collectIntDefs(body) {
  const defs = new Map()
  const pushDef = (name, rhs) => {
    let list = defs.get(name)
    if (!list) { list = []; defs.set(name, list) }
    list.push(rhs)
  }
  const collect = (node) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (const a of args)
        if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') pushDef(a[1], a[2])
    } else if (op === '=' && typeof args[0] === 'string') {
      pushDef(args[0], args[1])
    } else if (typeof op === 'string' && op.length > 1 && op.endsWith('=') &&
               !INT_CMP_OPS.has(op) && op !== '=>' && typeof args[0] === 'string') {
      pushDef(args[0], [op.slice(0, -1), args[0], args[1]])
    } else if ((op === '++' || op === '--') && typeof args[0] === 'string') {
      pushDef(args[0], [op === '++' ? '+' : '-', args[0], [null, 1]])
    }
    for (const a of args) collect(a)
  }
  collect(body)
  return defs
}

function makeIsIntExpr(intCertain) {
  return function isIntExpr(expr) {
    if (typeof expr === 'number') return Number.isInteger(expr) && !Object.is(expr, -0)
    if (typeof expr === 'boolean') return true
    if (typeof expr === 'string') return intCertain.get(expr) === true
    if (!Array.isArray(expr)) return false
    const sv = staticValue(expr)
    if (sv !== NO_VALUE && typeof sv === 'number' && Object.is(sv, -0)) return false
    const [op, ...args] = expr
    if (op == null) {
      const v = args[0]
      if (typeof v === 'number') return Number.isInteger(v) && !Object.is(v, -0)
      if (typeof v === 'boolean') return true
      return false
    }
    if (INT_BIT_OPS.has(op) || INT_CMP_OPS.has(op)) return true
    if (op === '.') {
      if ((args[1] === 'length' || args[1] === 'byteLength') && typeof args[0] === 'string') {
        const vt = lookupValType(args[0])
        return vt === VAL.TYPED || vt === VAL.ARRAY || vt === VAL.STRING || vt === VAL.BUFFER
      }
      if (args[1] === 'size' && typeof args[0] === 'string') {
        const vt = lookupValType(args[0])
        return vt === VAL.SET || vt === VAL.MAP
      }
      return false
    }
    if (INT_CLOSED_OPS.has(op)) {
      const a = isIntExpr(args[0])
      const b = args[1] != null ? isIntExpr(args[1]) : a
      return a && b
    }
    if (op === 'u-' || op === 'u+') return isIntExpr(args[0])
    if (op === '?:') return isIntExpr(args[1]) && isIntExpr(args[2])
    if (op === '&&' || op === '||') return isIntExpr(args[0]) && isIntExpr(args[1])
    if (op === '()') {
      const c = args[0]
      if (typeof c === 'string' && c.startsWith('math.') && INT_MATH_FNS.has(c.slice(5))) return true
      if (Array.isArray(c) && c[0] === '.' && c[1] === 'Math' && INT_MATH_FNS.has(c[2])) return true
    }
    return false
  }
}

/** Monotone fixpoint over binding defs in `body`. Map name → intCertain. */
export function intCertainMap(body) {
  const defs = collectIntDefs(body)
  if (defs.size === 0) return new Map()
  const intCertain = new Map()
  for (const name of defs.keys()) intCertain.set(name, true)
  const isIntExpr = makeIsIntExpr(intCertain)
  let changed = true
  while (changed) {
    changed = false
    for (const [name, rhsList] of defs) {
      if (!intCertain.get(name)) continue
      if (!rhsList.every(isIntExpr)) { intCertain.set(name, false); changed = true }
    }
  }
  return intCertain
}

/** Returns `expr => boolean` — integer-shaped expressions in `body`. */
export function intExprChecker(body) {
  return makeIsIntExpr(intCertainMap(body))
}
