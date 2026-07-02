/**
 * preEval — unified compile-time constant-folding pass over the PREPARED AST
 * (runs once, right after `prepare()`, before `compile()`).
 *
 * Subsumes/extends the narrow const-folders already scattered through prepare
 * (staticValue, staticStringExpr, constNum in prepare/index.js) with one pass
 * that also folds: numeric arithmetic chains (with optional rational/extended
 * precision — see Rational below), comparisons/equality, `%`/bitwise ops,
 * ASCII string methods, pure `Math.*` calls (bit-exact vs jz's own kernel via
 * math-kernel.js, NOT host Math — see that module), dead `if`/`while(false)`
 * branches, and zero-arg pure function calls (which subsumes IIFE collapse:
 * lift-iife.js already turns `(() => EXPR)()` into a 0-param top-level
 * function + a 0-arg call before prepare ever runs, so "IIFE collapse" here
 * is just the general case of a 0-arg call whose target's body reduces to a
 * constant — same code path for a literal IIFE and an ordinary user-authored
 * zero-arg helper).
 *
 * # Architecture
 * Two cooperating passes, sharing one `env` (Map<name, EvalResult>) and one
 * `state` ({ rationalOn, funcByName, evaluating }):
 *
 *   evalConst(node, env, state) -> EvalResult | null
 *     Tries to reduce a whole expression subtree to a SINGLE constant value,
 *     recursing entirely in EvalResult space (never rebuilds AST nodes
 *     mid-chain) — this is what lets a numeric chain carry an exact Rational
 *     all the way to the final `+`/`-`/`*`/`/`  and round only once. Also
 *     resolves Math.* calls, ASCII string methods, and — recursively, with a
 *     cycle guard — zero-arg calls to other functions.
 *
 *   foldNode(node, env, state) -> node
 *     The tree REWRITER. At every node it first asks evalConst for a full
 *     reduction (turning that subtree into ONE literal node — the only place
 *     an exact Rational gets rounded to f64). When evalConst can't fully
 *     reduce (e.g. one operand is a runtime value), it falls back to
 *     structural per-child folding, plus statement-level dead-`if`/`while`-
 *     branch elimination (foldStmts).
 *
 * `env` (Map<name, EvalResult>) is the scaffolding for ONE narrowly-scoped use:
 * evalFunctionBodyConst's zero-arg-call evaluation threads its OWN, freshly-
 * empty env through a callee's `let`/`const`-then-`return` chain (so `helper`'s
 * internal `const a = 1+2; return a*3` resolves) — see evalStmtsConst. The
 * general `foldStmts`/`foldNode` walk never POPULATES it (a bare identifier
 * reference is therefore never rewritten): several existing passes downstream
 * pattern-match a NAMED loop bound/index/property-key expression structurally
 * rather than by value (clamp-peel + the multi-pixel SIMD blur match,
 * unrollSmallConstFor's trip-count shape, watr LICM's post-inline invariant
 * recognition, static.js's schema/SRoA static-vs-dynamic key classification —
 * discovered the hard way, by regressing each of them once). Rewriting
 * `row = y*ww` to `row = y*64` is value-identical but silently swaps which of
 * those shape-sensitive passes fires. Tier 1 stays inside the proven-safe
 * boundary: fold every expression tree, never rewrite a bare-name reference.
 *
 * A single top-to-bottom pass over (every ctx.func.list body + the module
 * body) is a full fixpoint: evalConst re-derives everything it needs from the
 * RAW callee body on demand (via state.funcByName), so it never depends on
 * another function having been folded first, regardless of declaration order.
 *
 * Identity preservation matters here beyond the usual "avoid needless
 * allocation": prepare() forward-seeds compile-stage fact stores (program-
 * facts.js's WeakMap caches, compile/infer.js's recordGlobalRep, ...) keyed by
 * the SPECIFIC node objects it walked. `foldStmts`/`foldBlockLike` return the
 * exact input array/node whenever nothing in it changed, all the way up, so a
 * subtree preEval didn't touch keeps the object identity those caches rely on.
 *
 * # Purity / precision guards
 *   - Zero-arg call folding evaluates the callee's OWN body in a FRESH empty
 *     env (no outer capture) and bails on anything but a `let`/`const` chain
 *     ending in one `return` — any other statement shape (if/for/throw/...)
 *     is conservatively left unfolded.
 *   - String folding is ASCII-only (jz strings are UTF-8 internally; a
 *     non-ASCII `.length`/`.slice` could disagree with host JS's UTF-16
 *     view — see README divergences) and mixed string+number `+` is
 *     deliberately NOT folded (self-host's __ftoa is a 9-significant-digit
 *     dtoa, host `String(number)` is shortest-round-trip — folding could
 *     bake a MORE precise string than the unfolded kernel would produce).
 *   - `Math.pow`/`**` folds via the exact 3-way split emit.js's own
 *     constant-arg fast path already uses (math-kernel.js `pow`) — zero new
 *     divergence from today's compiled output.
 *   - `optimize.rationalConst !== false` (default ON) gates the rational
 *     carry; off, numeric folding still happens (still shrinks WAT) via
 *     plain sequential per-op f64 rounding — bit-exact vs naive JS
 *     evaluation, for callers who want that instead.
 *
 * @module prepare/pre-eval
 */

import { extractParams, classifyParam } from '../ast.js'
import { ctx } from '../ctx.js'
import { MATH_KERNEL, powFold } from './math-kernel.js'

// ---------------------------------------------------------------------------
// Rational — exact value = n/d, n: signed BigInt, d: positive BigInt. Every
// finite f64 IS an exact rational (double = mantissa * 2^exponent), so a
// literal seeds an EXACT starting point; +,-,*,/ stay exact through a whole
// formula; the f64 result is materialized via correctly-rounded decimal
// string -> Number() ONCE, at the point the chain stops (crosses into a
// non-arithmetic consumer, or reaches the top of a foldable subtree).
// ---------------------------------------------------------------------------
const _buf = new ArrayBuffer(8)
const _dv = new DataView(_buf)
function f64Bits(x) { _dv.setFloat64(0, x, false); return _dv.getBigUint64(0, false) }

function ratGcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { [a, b] = [b, a % b] } return a || 1n }
function ratMake(n, d) {
  if (d < 0n) { n = -n; d = -d }
  const g = ratGcd(n, d)
  return { n: n / g, d: d / g }
}
/** Exact rational for a finite f64 (null for NaN/±Infinity — those bail the rational chain). */
function f64ToRational(x) {
  if (!Number.isFinite(x)) return null
  if (x === 0) return { n: 0n, d: 1n }
  const bits = f64Bits(x)
  const sign = (bits >> 63n) & 1n
  let exp = Number((bits >> 52n) & 0x7ffn)
  let mant = bits & 0xfffffffffffffn
  if (exp === 0) exp = 1
  else mant |= 0x10000000000000n
  const e = exp - 1075
  let n = mant, d = 1n
  if (e >= 0) n <<= BigInt(e)
  else d <<= BigInt(-e)
  if (sign) n = -n
  return ratMake(n, d)
}
const ratAdd = (a, b) => ratMake(a.n * b.d + b.n * a.d, a.d * b.d)
const ratSub = (a, b) => ratMake(a.n * b.d - b.n * a.d, a.d * b.d)
const ratMul = (a, b) => ratMake(a.n * b.n, a.d * b.d)
const ratDiv = (a, b) => b.n === 0n ? null : ratMake(a.n * b.d, a.d * b.n)
/** Correctly-rounded rational -> f64: exact decimal expansion (generous digit budget,
 *  far beyond the 17 significant digits that suffice to round-trip any double) fed
 *  through the host's spec-mandated (round-to-nearest) string-to-Number parser. */
function ratToF64(r) {
  if (r.n === 0n) return 0
  let n = r.n, neg = n < 0n
  if (neg) n = -n
  const d = r.d
  const intPart = n / d
  let rem = n % d
  let s = intPart.toString()
  if (rem !== 0n) {
    s += '.'
    for (let i = 0; i < 60 && rem !== 0n; i++) { rem *= 10n; const dig = rem / d; s += dig.toString(); rem %= d }
  }
  return Number(neg ? '-' + s : s)
}

// ---------------------------------------------------------------------------
// EvalResult: { t: 'num'|'str'|'bool'|'null'|'undef', v?, r? }
// ---------------------------------------------------------------------------
const numResult = (v) => ({ t: 'num', v, r: Number.isFinite(v) ? f64ToRational(v) : null })
const strResult = (v) => ({ t: 'str', v })
const boolResult = (v) => ({ t: 'bool', v: !!v })
const NULL_RESULT = { t: 'null' }
const UNDEF_RESULT = { t: 'undef' }

const isAsciiSafe = (s) => /^[\x00-\x7F]*$/.test(s)

function isLiteralNode(node) {
  if (!Array.isArray(node)) return false
  const op = node[0]
  return op == null || op === 'str' || op === 'bool'
}
/** Read an already-literal AST node into an EvalResult (no evaluation, just recognition). */
function literalOf(node) {
  if (!Array.isArray(node)) return null
  const op = node[0]
  if (op == null) {
    const v = node[1]
    if (typeof v === 'number') return numResult(v)
    if (v === null) return NULL_RESULT
    if (v === undefined) return UNDEF_RESULT
    if (typeof v === 'boolean') return boolResult(v)
    return null
  }
  if (op === 'str' && typeof node[1] === 'string') return strResult(node[1])
  if (op === 'bool') return boolResult(node[1])
  return null
}
/** EvalResult -> literal AST node. The ONE place a Rational's exact value is rounded
 *  and forgotten — callers only reach here once a chain truly terminates. */
function nodeOf(r) {
  switch (r.t) {
    case 'num': return [null, r.v]
    case 'str': return ['str', r.v]
    case 'bool': return ['bool', r.v ? 1 : 0]
    case 'null': return [null, null]
    default: return [null, undefined]
  }
}

const toJSValue = (r) => r.t === 'null' ? null : r.t === 'undef' ? undefined : r.v
function toNumResult(r) {
  if (r.t === 'num') return r
  if (r.t === 'bool') return numResult(r.v ? 1 : 0)
  if (r.t === 'null') return numResult(0)
  if (r.t === 'undef') return numResult(NaN)
  return null   // strings: deliberately NOT ToNumber-coerced (see module doc)
}
function toBoolean(r) {
  if (r.t === 'bool') return r.v
  if (r.t === 'num') return r.v !== 0 && !Number.isNaN(r.v)
  if (r.t === 'str') return r.v.length !== 0
  return false   // null/undefined
}

function plainNumOp(op, a, b) {
  switch (op) {
    case '-': return a - b
    case '*': return a * b
    case '/': return a / b
    case '%': return a % b
    case '&': return a & b
    case '|': return a | b
    case '^': return a ^ b
    case '<<': return a << b
    case '>>': return a >> b
    case '>>>': return a >>> b
  }
}
const NUM_ONLY_OPS = new Set(['-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>'])
const RATIONAL_OPS = new Set(['-', '*', '/'])
const CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!=', '===', '!=='])
const BINARY_OPS = new Set([...NUM_ONLY_OPS, ...CMP_OPS])

/** Numeric binary fold. Carries the exact Rational through +,-,*,/ when both operands
 *  still have one (state.rationalOn); falls back to plain per-op f64 otherwise. A ZERO
 *  rational result recomputes via plain f64 arithmetic instead — signed zero (`x+(-x)`
 *  -> +0, `0*-1` -> -0) has no faithful rational encoding, and plain JS +,-,*,/ already
 *  implement IEEE754 signed-zero correctly, so falling back for that one case is exact,
 *  not approximate. A non-finite rational result (true overflow of the exact formula,
 *  e.g. `1e300*1e300/1e300`) is KEPT — that's the accuracy win rational carry promises,
 *  not a divergence to guard against. */
function foldNumBinary(op, L, R, rationalOn) {
  const plain = plainNumOp(op, L.v, R.v)
  if (!rationalOn || !RATIONAL_OPS.has(op) || !L.r || !R.r) return numResult(plain)
  const rr = op === '-' ? ratSub(L.r, R.r) : op === '*' ? ratMul(L.r, R.r) : ratDiv(L.r, R.r)
  if (!rr) return numResult(plain)
  if (rr.n === 0n) return numResult(plain)
  return { t: 'num', v: ratToF64(rr), r: rr }
}
function foldNumAdd(L, R, rationalOn) {
  if (!rationalOn || !L.r || !R.r) return numResult(L.v + R.v)
  const rr = ratAdd(L.r, R.r)
  if (rr.n === 0n) return numResult(L.v + R.v)
  return { t: 'num', v: ratToF64(rr), r: rr }
}
function foldNumUnaryNeg(a) {
  if (a.v === 0) return numResult(-a.v)   // exact sign flip incl. ±0; BigInt has no signed zero
  return a.r ? { t: 'num', v: -a.v, r: { n: -a.r.n, d: a.r.d } } : numResult(-a.v)
}

function foldUnary(op, a) {
  if (op === 'u-') { const L = toNumResult(a); return L && foldNumUnaryNeg(L) }
  if (op === 'u+') return toNumResult(a)
  if (op === '!') return boolResult(!toBoolean(a))
  if (op === '~') return a.t === 'str' ? null : numResult(~toJSValue(a))
  return null
}

function foldBinary(op, a, b, rationalOn) {
  if (op === '+') {
    if (a.t === 'str' && b.t === 'str')
      return (isAsciiSafe(a.v) && isAsciiSafe(b.v)) ? strResult('' + a.v + b.v) : null
    if (a.t === 'str' || b.t === 'str') return null   // mixed string+number: see module doc
    const L = toNumResult(a), R = toNumResult(b)
    return (L && R) ? foldNumAdd(L, R, rationalOn) : null
  }
  if (op === '**') {
    const L = toNumResult(a), R = toNumResult(b)
    return (L && R) ? numResult(powFold(L.v, R.v)) : null
  }
  if (NUM_ONLY_OPS.has(op)) {
    const L = toNumResult(a), R = toNumResult(b)
    if (!L || !R) return null
    return op === '-' || op === '*' || op === '/' ? foldNumBinary(op, L, R, rationalOn) : numResult(plainNumOp(op, L.v, R.v))
  }
  if (CMP_OPS.has(op)) {
    if ((a.t === 'str' && !isAsciiSafe(a.v)) || (b.t === 'str' && !isAsciiSafe(b.v))) return null
    const x = toJSValue(a), y = toJSValue(b)
    switch (op) {
      case '<': return boolResult(x < y)
      case '>': return boolResult(x > y)
      case '<=': return boolResult(x <= y)
      case '>=': return boolResult(x >= y)
      case '==': return boolResult(x == y)
      case '!=': return boolResult(x != y)
      case '===': return boolResult(x === y)
      case '!==': return boolResult(x !== y)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Math.* / string-method call evaluation
// ---------------------------------------------------------------------------
const MATH_CONST = new Set(['PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2'])
// prepare resolves `Math.X` to a bare `'math.X'` STRING (both a niladic-call target
// `['()','math.sqrt',args]` and, for the no-arg constants, a plain value reference
// `'math.PI'` with no wrapping `()` at all) whenever it runs through the full host
// pipeline's jzify/autoload service wiring — `['.', 'Math', 'X']` only survives on a
// bare prepare() call with no services injected. Recognize both shapes.
function mathCalleeName(callee) {
  if (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Math' && typeof callee[2] === 'string') return callee[2]
  if (typeof callee === 'string' && callee.startsWith('math.')) return callee.slice(5)
  return null
}
// sqrt/abs/floor/ceil/trunc: IEEE754-mandated correctly-rounded in both JS and wasm.
// round/sign/fround: jz's WAT is deliberately engineered to reproduce these exact host
// JS semantics (see module/math.js). All bit-exact vs the compiled kernel by construction.
const HOST_EXACT_UNARY = new Set(['sqrt', 'abs', 'floor', 'ceil', 'trunc', 'round', 'fround', 'sign'])

function evalMathCall(name, vs) {
  if (name === 'pow') return vs.length === 2 ? numResult(powFold(vs[0], vs[1])) : null
  if (name === 'min') return numResult(vs.length ? Math.min(...vs) : Infinity)
  if (name === 'max') return numResult(vs.length ? Math.max(...vs) : -Infinity)
  if (name === 'imul') return vs.length === 2 ? numResult(Math.imul(vs[0], vs[1])) : null
  if (name === 'clz32') return vs.length === 1 ? numResult(Math.clz32(vs[0])) : null
  if (HOST_EXACT_UNARY.has(name)) return vs.length === 1 ? numResult(Math[name](vs[0])) : null
  const kfn = MATH_KERNEL['math.' + name]
  return kfn ? numResult(kfn(...vs)) : null
}

/** args: EvalResult[] (some entries may be null — the method itself validates types/arity). */
function evalStringMethod(name, s, args) {
  const isNumOrAbsent = (a) => a == null || a.t === 'num'
  if (name === 'toUpperCase' && args.length === 0) return strResult(s.toUpperCase())
  if (name === 'toLowerCase' && args.length === 0) return strResult(s.toLowerCase())
  if (name === 'trim' && args.length === 0) return strResult(s.trim())
  if (name === 'slice' && args.length <= 2 && args.every(isNumOrAbsent)) {
    const r = s.slice(args[0]?.v, args[1]?.v)
    return isAsciiSafe(r) ? strResult(r) : null
  }
  if (name === 'charAt' && args.length <= 1 && isNumOrAbsent(args[0])) return strResult(s.charAt(args[0]?.v ?? 0))
  if (name === 'indexOf' && args.length >= 1 && args[0]?.t === 'str' && isAsciiSafe(args[0].v))
    return numResult(s.indexOf(args[0].v, args[1]?.v))
  return null
}

function collectArgs(argsNode) {
  if (argsNode == null) return []
  if (Array.isArray(argsNode) && argsNode[0] === ',') return argsNode.slice(1)
  return [argsNode]
}

// ---------------------------------------------------------------------------
// evalConst — full-subtree constant evaluation (EvalResult space, no AST
// round-trips mid-chain — see module doc).
// ---------------------------------------------------------------------------
function evalConst(node, env, state) {
  if (typeof node === 'string') {
    const b = env.get(node)
    if (b !== undefined) return b
    if (node.startsWith('math.') && MATH_CONST.has(node.slice(5))) return numResult(Math[node.slice(5)])
    return null
  }
  if (!Array.isArray(node)) return null
  const op = node[0]

  if (op == null) {
    const v = node[1]
    if (typeof v === 'number') return numResult(v)
    if (v === null) return NULL_RESULT
    if (v === undefined) return UNDEF_RESULT
    if (typeof v === 'boolean') return boolResult(v)
    return null
  }
  if (op === 'str') return typeof node[1] === 'string' ? strResult(node[1]) : null
  if (op === 'bool') return boolResult(node[1])

  if (op === 'u-' || op === 'u+' || op === '!' || op === '~') {
    const a = evalConst(node[1], env, state)
    return a && foldUnary(op, a)
  }
  if (op === '+' || op === '**' || BINARY_OPS.has(op)) {
    if (node.length !== 3) return null
    const a = evalConst(node[1], env, state)
    if (!a) return null
    const b = evalConst(node[2], env, state)
    return b && foldBinary(op, a, b, state.rationalOn)
  }
  if (op === '&&' || op === '||' || op === '??') {
    const a = evalConst(node[1], env, state)
    if (!a) return null
    const takeLeft = op === '&&' ? !toBoolean(a) : op === '||' ? toBoolean(a) : !(a.t === 'null' || a.t === 'undef')
    const picked = takeLeft ? a : evalConst(node[2], env, state)
    // `&&`/`||`/`??` is value-preserving at RUNTIME (it returns whichever raw operand
    // won, untyped) — jz deliberately does NOT re-narrow that to the picked operand's
    // own type when the two operands' types differ (e.g. `5 && true` crosses the
    // boundary as the numeric carrier 1, not JS `true` — a documented gap, see
    // test/booleans.js). Folding to a literal of the picked operand's OWN type would be
    // MORE precise than that runtime behavior, i.e. a real divergence — so only fold
    // when the operand that would have been dropped has the SAME type as the one kept
    // (never fires here means never risks it; still folds the far more common
    // same-type case, e.g. `x ?? 0` chains, `a && b` boolean chains).
    if (!picked) return null
    // Both branches must independently prove out to a value (and agree in type) —
    // an un-evaluable other branch means its type is UNKNOWN here, which is exactly
    // the unsafe case (see comment above): stay conservative, don't fold.
    const other = takeLeft ? evalConst(node[2], env, state) : a
    return (other && other.t === picked.t) ? picked : null
  }
  if ((op === '?:' || op === '?') && node.length === 4) {
    const c = evalConst(node[1], env, state)
    if (!c) return null
    const cond = toBoolean(c)
    const picked = cond ? evalConst(node[2], env, state) : evalConst(node[3], env, state)
    if (!picked) return null
    const other = cond ? evalConst(node[3], env, state) : evalConst(node[2], env, state)
    return (other && other.t === picked.t) ? picked : null
  }
  if (op === '.' || op === '?.') {
    if (node[1] === 'Math' && typeof node[2] === 'string' && MATH_CONST.has(node[2])) return numResult(Math[node[2]])
    const recv = evalConst(node[1], env, state)
    if (recv && recv.t === 'str' && node[2] === 'length' && isAsciiSafe(recv.v)) return numResult(recv.v.length)
    return null
  }
  if (op === '()') return evalCallConst(node, env, state)
  if (op === ',') {
    let last = null
    for (let i = 1; i < node.length; i++) { last = evalConst(node[i], env, state); if (!last) return null }
    return last
  }
  return null
}

function evalCallConst(node, env, state) {
  const callee = node[1]
  const args = collectArgs(node.length > 2 ? node[2] : null)

  const mathName = mathCalleeName(callee)
  if (mathName != null) {
    const vs = []
    for (const a of args) { const r = evalConst(a, env, state); if (!r || r.t !== 'num') return null; vs.push(r.v) }
    return evalMathCall(mathName, vs)
  }
  if (Array.isArray(callee) && callee[0] === '.' && typeof callee[2] === 'string') {
    const recv = evalConst(callee[1], env, state)
    if (!recv || recv.t !== 'str' || !isAsciiSafe(recv.v)) return null
    return evalStringMethod(callee[2], recv.v, args.map(a => evalConst(a, env, state)))
  }
  if (typeof callee === 'string' && (node.length < 3 || node[2] == null)) {
    const f = state.funcByName.get(callee)
    if (f && f.sig?.params?.length === 0 && !f.rest && !f.defaults) return evalFunctionBodyConst(f, state)
  }
  return null
}

/** Zero-arg pure call collapse — subsumes IIFE collapse (see module doc). Evaluates the
 *  callee's OWN body in a fresh, empty env (no outer capture: purity stays trivially
 *  provable). Bails (returns null) on anything but a `let`/`const` chain of constants
 *  ending in exactly one `return`. Cycle-guarded for (mutual) self-recursive 0-arg calls. */
function evalFunctionBodyConst(f, state) {
  if (state.evaluating.has(f.name)) return null
  state.evaluating.add(f.name)
  try { return evalBodyConst(f.body, new Map(), state) }
  finally { state.evaluating.delete(f.name) }
}
function evalBodyConst(body, env, state) {
  if (!Array.isArray(body)) return null
  if (body[0] !== '{}' && body[0] !== ';') return evalConst(body, env, state)
  return evalStmtsConst(blockToStmtArray(body), env, state)
}
function evalStmtsConst(stmts, env, state) {
  const local = new Map(env)
  for (const s of stmts) {
    if (!Array.isArray(s)) return null
    if (s[0] === 'let' || s[0] === 'const') {
      for (let i = 1; i < s.length; i++) {
        const d = s[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') return null
        const v = evalConst(d[2], local, state)
        if (!v) return null
        local.set(d[1], v)
      }
      continue
    }
    if (s[0] === 'return') return s.length < 2 ? UNDEF_RESULT : evalConst(s[1], local, state)
    return null   // if/for/while/throw/expr-stmt/... — not fully constant, bail
  }
  return null   // fell off the end without a return
}

// ---------------------------------------------------------------------------
// foldNode — the tree rewriter. Tries evalConst first (full reduction); falls
// back to structural per-child folding otherwise.
// ---------------------------------------------------------------------------
function collectParamNamesShallow(paramsNode) {
  const names = []
  for (const p of extractParams(paramsNode)) {
    const c = classifyParam(p)
    if (typeof c.name === 'string') names.push(c.name)
  }
  return names
}

function foldNode(node, env, state) {
  if (typeof node === 'string') {
    const b = env.get(node)
    return b !== undefined ? nodeOf(b) : node
  }
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op == null || op === 'str' || op === 'bool') return node

  const full = evalConst(node, env, state)
  if (full) return nodeOf(full)

  if (op === '=>') {
    const childEnv = new Map(env)
    for (const p of collectParamNamesShallow(node[1])) childEnv.delete(p)
    const newBody = foldNode(node[2], childEnv, state)
    return newBody === node[2] ? node : [node[0], node[1], newBody]
  }
  if (op === 'for' && node.length === 5) {
    // Leave the loop HEAD (init/cond/step — incl. for-in/for-of, already desugared to
    // this shape by prepare) completely untouched: several downstream passes pattern-
    // match a loop's bound/index expressions structurally (auto-vectorization's
    // clamp-peel + 4-pixel SIMD blur match, unrollSmallConstFor's trip-count shape,
    // watr LICM's post-inline invariant recognition, ...). Replacing a symbolic bound
    // (`k <= rr`) with its folded literal (`k <= 4`) is VALUE-preserving but changes
    // which of those shape-sensitive passes fires — e.g. it can silently swap a SIMD
    // lane-vectorized loop for a fully unrolled one. The loop BODY has no such
    // structural sensitivity and still folds normally.
    const body = foldNode(node[4], new Map(env), state)
    return body === node[4] ? node : [node[0], node[1], node[2], node[3], body]
  }
  if (op === 'return') {
    if (node.length < 2) return node
    const v = foldNode(node[1], env, state)
    return v === node[1] ? node : ['return', v]
  }
  if (op === '&&' || op === '||' || op === '??') {
    const a = foldNode(node[1], env, state)
    const b = foldNode(node[2], env, state)
    return (a === node[1] && b === node[2]) ? node : [op, a, b]
  }
  if ((op === '?:' || op === '?') && node.length === 4) {
    const c = foldNode(node[1], env, state)
    const t = foldNode(node[2], env, state)
    const e = foldNode(node[3], env, state)
    return (c === node[1] && t === node[2] && e === node[3]) ? node : [node[0], c, t, e]
  }
  if (op === '.' || op === '?.') {
    const recv = foldNode(node[1], env, state)
    return recv === node[1] ? node : [node[0], recv, node[2]]
  }
  if (op === ':' && node.length === 3) {
    // Object-literal property `[':', key, value]`. A SHORTHAND property `{a}` desugars
    // to `[':', 'a', 'a']` — the same bare identifier in BOTH the key slot and the value
    // slot. Only the value is a real expression to fold/inline; the key slot is always a
    // property NAME (or, for `{[k]: v}`, a computed-key expression) — inlining an
    // identifier there would rewrite the property's NAME itself. Never touch it.
    const key = node[1]
    const value = foldNode(node[2], env, state)
    return value === node[2] ? node : [op, key, value]
  }
  if (op === '[]' && node.length === 3) {
    const base = foldNode(node[1], env, state)
    // Never inline an identifier KEY to a literal here: prepare() already ran its
    // static-vs-dynamic property/index classification (staticPropertyKey/staticIndexKey,
    // static.js — schema dynProps tracking, SRoA flat-array slots) against the ORIGINAL
    // `o[k]` shape and committed codegen decisions (e.g. for-in's dynamic-key bookkeeping)
    // to that. Rewriting `k` to a literal post-hoc would make `o[k]` LOOK static to
    // anything reading the AST downstream while every fact prepare recorded still says
    // "dynamic" — a stale-vs-fresh mismatch, not a value-preserving fold. A non-identifier
    // key (`o[i+1]`, `o[f()]`) was never eligible for that static fast path anyway, so it
    // folds normally.
    const key = typeof node[2] === 'string' ? node[2] : foldNode(node[2], env, state)
    return (base === node[1] && key === node[2]) ? node : [op, base, key]
  }
  if (op === '()') return foldCallPartial(node, env, state)
  if (op === ',') {
    const parts = node.slice(1).map(n => foldNode(n, env, state))
    return parts.some((p, i) => p !== node[i + 1]) ? [',', ...parts] : node
  }

  // Generic fallback: recurse into every child, preserving node shape. Covers
  // for/array-literal/object-literal/call-args-of-non-foldable-callee/etc.
  let changed = false
  const out = node.map((c, i) => {
    if (i === 0) return c
    const v = foldNode(c, env, state)
    if (v !== c) changed = true
    return v
  })
  return changed ? out : node
}

function foldCallPartial(node, env, state) {
  const callee = Array.isArray(node[1]) ? foldNode(node[1], env, state) : node[1]
  if (node.length < 3) return callee === node[1] ? node : [node[0], callee]
  const rawArgs = collectArgs(node[2])
  const args = rawArgs.map(a => foldNode(a, env, state))
  if (callee === node[1] && args.every((a, i) => a === rawArgs[i])) return node
  const newArgsNode = args.length === 0 ? null : args.length === 1 ? args[0] : [',', ...args]
  return [node[0], callee, newArgsNode]
}

// ---------------------------------------------------------------------------
// Statement-list folding: env threading (constant `let`/`const` -> inlined at
// every later reference), `if`/`while(false)` dead-branch splicing.
// ---------------------------------------------------------------------------
function blockToStmtArray(node) {
  if (node == null) return []
  if (Array.isArray(node) && node[0] === '{}') {
    const inner = node.length > 1 ? node[1] : null
    if (inner == null) return []
    return Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
  }
  if (Array.isArray(node) && node[0] === ';') return node.slice(1)
  return [node]
}
function wrapBlockLike(stmts, wasBraced) {
  if (!stmts.length) return wasBraced ? ['{}'] : [';']
  if (stmts.length === 1) return wasBraced ? ['{}', stmts[0]] : stmts[0]
  return wasBraced ? ['{}', [';', ...stmts]] : [';', ...stmts]
}
const sameStmts = (a, b) => a.length === b.length && a.every((s, i) => s === b[i])

// IMPORTANT — identity preservation: prepare() forward-seeds compile-stage fact stores
// (program-facts.js's WeakMap caches, compile/infer.js recordGlobalRep, ...) keyed by
// the SPECIFIC node objects it walked. Rebuilding a statement/block node whose content
// didn't actually change would silently orphan any per-node fact recorded against the
// original object. `foldStmts` therefore returns the exact input array (and
// `foldBlockLike` the exact input node) whenever nothing in it changed, all the way up.
function foldBlockLike(node, env, state) {
  const wasBraced = Array.isArray(node) && node[0] === '{}'
  const original = blockToStmtArray(node)
  const folded = foldStmts(original, env, state)
  return folded === original ? node : wrapBlockLike(folded, wasBraced)
}

function foldStmts(stmts, env, state) {
  const out = []
  for (const s0 of stmts) {
    const op = Array.isArray(s0) ? s0[0] : null

    if (op === 'let' || op === 'const') {
      // Fold each initializer's OWN expression (pure literal arithmetic/string/bool/
      // Math chains need no outside binding to reduce). Deliberately NOT propagated any
      // further: `env` here is never populated from a declaration, so a LATER reference
      // to `name` is never rewritten to its value. Earlier revisions did that (and it's
      // sound in isolation — see evalFunctionBodyConst's OWN, separately-scoped env,
      // which still does this safely for a zero-arg call's self-contained body) but
      // several existing passes downstream pattern-match a NAMED loop bound/index
      // expression structurally rather than by value — clamp-peel's & the multi-pixel
      // SIMD blur's loop-shape match, unrollSmallConstFor's trip-count shape, watr
      // LICM's post-inline invariant recognition all fire (or don't) off the SYMBOLIC
      // shape. Replacing `row = y*ww` with `row = y*64` is value-identical but silently
      // swaps which of those passes engages. Tier 1 stays inside the proven-safe
      // boundary: fold the expression tree, never rewrite a bare-name reference.
      const decls = []
      for (let i = 1; i < s0.length; i++) {
        const d = s0[i]
        if (!Array.isArray(d) || d[0] !== '=') { decls.push(d); continue }
        const name = d[1], init = d[2]
        const foldedInit = init !== undefined ? foldNode(init, env, state) : init
        decls.push(foldedInit === init ? d : ['=', name, foldedInit])
      }
      const declsChanged = decls.some((d, i) => d !== s0[i + 1])
      out.push(declsChanged ? [s0[0], ...decls] : s0)
      continue
    }

    if (op === 'if') {
      const condVal = evalConst(s0[1], env, state)
      if (condVal) {
        const takeThen = toBoolean(condVal)
        const branch = takeThen ? s0[2] : s0[3]
        if (branch != null) out.push(...foldStmts(blockToStmtArray(branch), new Map(env), state))
        continue
      }
      const cond = foldNode(s0[1], env, state)
      const thenF = s0[2] != null ? foldBlockLike(s0[2], new Map(env), state) : s0[2]
      const hasElse = s0.length > 3
      const elseF = hasElse ? (s0[3] != null ? foldBlockLike(s0[3], new Map(env), state) : s0[3]) : undefined
      const changed = cond !== s0[1] || thenF !== s0[2] || (hasElse && elseF !== s0[3])
      out.push(changed ? (hasElse ? ['if', cond, thenF, elseF] : ['if', cond, thenF]) : s0)
      continue
    }

    if (op === 'while') {
      const condVal = evalConst(s0[1], env, state)
      if (condVal && !toBoolean(condVal)) continue
      const cond = foldNode(s0[1], env, state)
      const bodyF = s0[2] != null ? foldBlockLike(s0[2], new Map(env), state) : s0[2]
      out.push(cond === s0[1] && bodyF === s0[2] ? s0 : ['while', cond, bodyF])
      continue
    }

    out.push(foldNode(s0, env, state))
  }
  return sameStmts(out, stmts) ? stmts : out
}

function foldFunctionBody(body, state) {
  if (body == null || isLiteralNode(body)) return body
  if (!Array.isArray(body) || (body[0] !== '{}' && body[0] !== ';')) return foldNode(body, new Map(), state)
  return foldBlockLike(body, new Map(), state)
}

/** Run preEval over the prepared module AST + every ctx.func.list body (mutated in place —
 *  the same funcInfo objects compile() reads). Single top-to-bottom pass; see module doc for
 *  why that's already a full fixpoint. */
export function preEval(ast) {
  const rationalOn = ctx.transform.optimize?.rationalConst !== false
  const funcByName = new Map(ctx.func.list.map(f => [f.name, f]))
  const state = { rationalOn, funcByName, evaluating: new Set() }
  for (const f of ctx.func.list) f.body = foldFunctionBody(f.body, state)
  if (ast == null) return ast
  return foldBlockLike(ast, new Map(), state)
}
