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
 * A single top-to-bottom pass over (every ctx.funcs.list body + the module
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
 *     deliberately NOT folded (self-compile's __ftoa is a 9-significant-digit
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

import { extractParams, classifyParam, PARAM_NAME } from '../ast.js'
import { ctx } from '../ctx.js'
import { MATH_KERNEL, powFold } from './math-kernel.js'
import * as bn from '../bignum.js'

// ---------------------------------------------------------------------------
// Rational — exact value = ±n/d, n/d: u32-limb magnitudes (bignum.js), sign
// carried alongside as `negative` (never folded into the limbs — every limb
// op is unsigned-magnitude-only). Every finite f64 IS an exact rational
// (double = mantissa * 2^exponent), so a literal seeds an EXACT starting
// point; +,-,*,/ stay exact through a whole formula; the f64 result is
// materialized via correctly-rounded decimal string -> Number() ONCE, at the
// point the chain stops (crosses into a non-arithmetic consumer, or reaches
// the top of a foldable subtree).
//
// Host-independent by construction: n/d must NEVER be carried as native BigInt
// gated on HOST_PROFILE.wideBigint — jz's own self-compile BigInt carrier is a
// WRAPPING i64 (see ctx.js), so any n/d past 64 bits (routine here: a tiny
// subnormal's f64ToRational alone needs a ~1075-bit denominator) would silently
// corrupt in-kernel, forcing native and kernel onto genuinely different fold
// algorithms — a compiler-output-depends-on-compiler-host determinism
// violation (test/kernel-parity.js fold|0/2/3, PARITY_TODO). bignum.js's limb
// arrays have no width ceiling (growing the array IS the carry) and every
// element is a plain safe-integer f64 — jz's own unambiguous number
// representation — so this module folds bit-identically whether it runs
// natively or self-compiled in-kernel.
// ---------------------------------------------------------------------------
const _f64buf = new ArrayBuffer(8)
const _f64f = new Float64Array(_f64buf)
const _f64u = new Uint32Array(_f64buf)   // native-endian halves: [0]=lo32, [1]=hi32 (matches ir.js's _F64_BITS_U32 convention)
const ONE = bn.fromSmall(1)

/** Signed magnitude add: (sA,mA) + (sB,mB) -> [sign, magnitude]. The one place
 *  sign combines across an add/sub of two (already-signed) rational terms —
 *  the limb layer itself never carries sign. */
function signedAdd(sA, mA, sB, mB) {
  if (sA === sB) return [sA, bn.add(mA, mB)]
  const c = bn.cmp(mA, mB)
  if (c === 0) return [false, bn.ZERO]
  return c > 0 ? [sA, bn.sub(mA, mB)] : [sB, bn.sub(mB, mA)]
}

function ratGcd(a, b) {
  while (!bn.isZero(b)) { const [, r] = bn.divMod(a, b); const t = b; b = r; a = t }
  return bn.isZero(a) ? ONE : a
}
/** n, d: magnitude limbs (d nonzero); negative: sign of the whole rational. */
function ratMake(negative, n, d) {
  if (bn.isZero(n)) return { negative: false, n: bn.ZERO, d: ONE }   // canonical zero, no signed-zero rational
  const g = ratGcd(n, d)
  const [nq] = bn.divMod(n, g)
  const [dq] = bn.divMod(d, g)
  return { negative, n: nq, d: dq }
}
/** Exact rational for a finite f64 (null for NaN/±Infinity — those bail the rational chain). */
function f64ToRational(x) {
  if (!Number.isFinite(x)) return null
  if (x === 0) return { negative: false, n: bn.ZERO, d: ONE }
  _f64f[0] = x
  const lo = _f64u[0] >>> 0, hi = _f64u[1] >>> 0
  const negative = (hi >>> 31) !== 0
  let exp = (hi >>> 20) & 0x7ff
  let mantHi = hi & 0xfffff
  const mantLo = lo
  if (exp === 0) exp = 1
  else mantHi |= 0x100000
  // mantHi (<= 0x1fffff, 21 bits) and mantLo (<= 0xffffffff, 32 bits) are each too
  // wide for a single 15-bit limb (bignum.js's base — see its module doc for why
  // 15, not 32) — build the combined 53-bit mantissa value (mantHi*2^32 + mantLo)
  // through the limb API instead of hand-packing a [lo,hi] pair.
  const mantissa = bn.add(bn.shiftLeft(bn.fromSmall(mantHi), 32), bn.fromSmall(mantLo))
  const e = exp - 1075
  const n = e >= 0 ? bn.shiftLeft(mantissa, e) : mantissa
  const d = e >= 0 ? ONE : bn.shiftLeft(ONE, -e)
  return ratMake(negative, n, d)
}
function ratAdd(a, b) {
  const [sign, mag] = signedAdd(a.negative, bn.mul(a.n, b.d), b.negative, bn.mul(b.n, a.d))
  return ratMake(sign, mag, bn.mul(a.d, b.d))
}
function ratSub(a, b) {
  const [sign, mag] = signedAdd(a.negative, bn.mul(a.n, b.d), !b.negative, bn.mul(b.n, a.d))
  return ratMake(sign, mag, bn.mul(a.d, b.d))
}
const ratMul = (a, b) => ratMake(a.negative !== b.negative, bn.mul(a.n, b.n), bn.mul(a.d, b.d))
const ratDiv = (a, b) => bn.isZero(b.n) ? null : ratMake(a.negative !== b.negative, bn.mul(a.n, b.d), bn.mul(a.d, b.n))
// ratToF64's digit budget MUST be counted from the first significant digit, not
// a flat count of fractional digits from the decimal point. A flat count
// undercounts in two independent ways:
//  (1) A rational whose magnitude is tiny (a compile-time-folded division
//      landing near/in the subnormal range, e.g. `1/1e300`, `1e-300/1e20`)
//      spends most of its decimal expansion on LEADING ZEROS before any
//      significant digit shows up — the smallest positive subnormal
//      (2^-1074 ≈ 4.94e-324) needs 323 of them. A flat 60-digit cap silently
//      truncated to an all-zero string there ("0.000…0"), which `Number()`
//      parses as exactly 0 — not a rounding error, a magnitude-dependent
//      WRONG ANSWER (confirmed live: `1/1e61` folded to 0 instead of 1e-61,
//      a perfectly ordinary — not even subnormal — double).
//  (2) Even at ordinary magnitude, "17 significant digits round-trips any
//      double" is a claim about reading an ALREADY-ROUNDED double back as
//      decimal — correctly ROUNDING an exact (possibly irrational-looking)
//      rational TO the nearest double is a stricter demand: a sum landing
//      extremely close to the exact halfway point between two representable
//      doubles (the textbook `0.1 + 0.2`, whose exact rational sum is
//      0.3000000000000000166533453693773481…, a hair above the true
//      0.3/0.30000000000000004 midpoint) needs enough trailing digits to see
//      PAST that near-tie. 60 significant digits (not just 17) is the exact
//      budget the original flat-60 version used and is proven correct by the
//      existing rational-carry precision tests — kept unchanged in count,
//      only moved to start counting from the first significant digit instead
//      of the decimal point, so it survives an arbitrarily long leading-zero
//      run too.
const RAT_SIG_DIGITS_AFTER_FIRST = 60
const RAT_MAX_FRAC_DIGITS = 384 + RAT_SIG_DIGITS_AFTER_FIRST  // > 323 leading zeros (2^-1074's decimal position) + margin, + the sig-digit budget above
/** Correctly-rounded rational -> f64: exact decimal expansion fed through the
 *  host's spec-mandated (round-to-nearest) string-to-Number parser. */
function ratToF64(r) {
  if (bn.isZero(r.n)) return 0
  const [intPart, rem0] = bn.divMod(r.n, r.d)
  let s = bn.toDecimalString(intPart)
  let rem = rem0
  if (!bn.isZero(rem)) {
    s += '.'
    let sigDigits = 0   // count of digits emitted SINCE the first nonzero one (0 while still in the leading-zero run)
    for (let i = 0; i < RAT_MAX_FRAC_DIGITS && !bn.isZero(rem) && sigDigits < RAT_SIG_DIGITS_AFTER_FIRST; i++) {
      rem = bn.mulSmall(rem, 10)
      const [dig, rem2] = bn.divMod(rem, r.d)   // dig < 10 by construction (rem < d before the *10)
      const digStr = bn.toDecimalString(dig)
      s += digStr
      if (sigDigits > 0 || digStr !== '0') sigDigits++
      rem = rem2
    }
  }
  return Number(r.negative ? '-' + s : s)
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
  return op == null || op === 'str' || op === 'bool' || op === 'bigint'
}
/** Read an already-literal AST node into an EvalResult (no evaluation, just recognition).
 *  A `[null, n]` node's payload is UNCONDITIONALLY a genuine number — bigint literals are
 *  the distinct `['bigint', decimalStr]` node (parse.js), never this shape, so
 *  every literal number (subnormal included) folds with no magnitude heuristic here. */
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

/** ES Abstract/Strict Equality, dispatched off EvalResult's OWN `.t` tag — not host
 *  `==`/`===` (the two call sites this replaced): those operators, evaluated HERE,
 *  compile through jz's own runtime equality helpers once this file is itself self-
 *  hosted, and the fully-dynamic fallback they hit for two untyped locals ($__eq /
 *  $__eq_strict, module/core.js) implements only what user-program `==` needed
 *  historically — not the full ES algorithm. Every EvalResult already carries an
 *  explicit, compile-time-known type tag, so recursing on tags is both a correctness
 *  fix (an explicit, spec-shaped algorithm instead of relying on a host operator) and
 *  a self-compile fix (never asks `==` to classify two runtime-dynamic operands itself).
 *  Number()/plain `===` on same-tagged operands below stay reliable self-compiled —
 *  same-type equality (NUMBER f64.eq/ REF_EQ/STRING content-eq) is the well-tested
 *  path emitLooseEq/emitStrictEq already special-case; only the CROSS-tag coercion
 *  and nullish-equivalence rules needed spelling out explicitly. */
function looseEqResult(a, b) {
  const aNil = a.t === 'null' || a.t === 'undef'
  const bNil = b.t === 'null' || b.t === 'undef'
  if (aNil || bNil) return aNil && bNil
  if (a.t === 'bool') return looseEqResult(numResult(a.v ? 1 : 0), b)
  if (b.t === 'bool') return looseEqResult(a, numResult(b.v ? 1 : 0))
  if (a.t === b.t) return a.v === b.v
  if (a.t === 'num' && b.t === 'str') return a.v === Number(b.v)
  if (a.t === 'str' && b.t === 'num') return Number(a.v) === b.v
  return false
}
function strictEqResult(a, b) {
  if (a.t !== b.t) return false
  if (a.t === 'null' || a.t === 'undef') return true
  return a.v === b.v
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
 *  not approximate. A non-finite rational result whose OWN op still lands finite when
 *  each side is already a correctly-rounded double (true precision win, e.g.
 *  `1e300*1e300/1e300`, chained through a `/` whose parent divides back down before this
 *  node's own overflow would ever surface) is KEPT — that's the accuracy win rational
 *  carry promises, not a divergence to guard against. But when THIS node's own
 *  correctly-rounded f64 result overflows to ±Infinity, ECMA-262 12.6.3/12.8.3 (each
 *  operator rounds its OWN result — a chain is never reassociated into one exact
 *  computation) requires that Infinity to propagate as-is: `(MAX_VALUE*1.1)*0.9`'s true
 *  mathematical product is finite (< MAX_VALUE), but per spec `MAX_VALUE*1.1` alone rounds
 *  to Infinity, and `Infinity*0.9` stays Infinity — jz must match that, not the
 *  reassociated finite answer the exact rational would compute if carried through. Bail
 *  the rational chain here (r:null) so any PARENT op falls back to plain per-op float
 *  arithmetic from this node's actual (overflowed) value instead of continuing from the
 *  pre-overflow exact one. Fires only at the finite/±Infinity boundary itself — every
 *  sub-Infinity result (the documented "more accurate, never less" feature) is untouched. */
function foldNumBinary(op, L, R, rationalOn) {
  const plain = plainNumOp(op, L.v, R.v)
  if (!rationalOn || !RATIONAL_OPS.has(op) || !L.r || !R.r) return numResult(plain)
  const rr = op === '-' ? ratSub(L.r, R.r) : op === '*' ? ratMul(L.r, R.r) : ratDiv(L.r, R.r)
  if (!rr) return numResult(plain)
  if (bn.isZero(rr.n)) return numResult(plain)
  if (!Number.isFinite(plain)) return numResult(plain)   // this op's own correctly-rounded result overflowed — bail the chain, see doc above
  return { t: 'num', v: ratToF64(rr), r: rr }
}
function foldNumAdd(L, R, rationalOn) {
  if (!rationalOn || !L.r || !R.r) return numResult(L.v + R.v)
  const rr = ratAdd(L.r, R.r)
  if (bn.isZero(rr.n)) return numResult(L.v + R.v)
  const plain = L.v + R.v
  if (!Number.isFinite(plain)) return numResult(plain)   // this op's own correctly-rounded result overflowed — see foldNumBinary's doc
  return { t: 'num', v: ratToF64(rr), r: rr }
}
function foldNumUnaryNeg(a) {
  if (a.v === 0) return numResult(-a.v)   // exact sign flip incl. ±0; limb magnitudes have no signed zero
  return a.r ? { t: 'num', v: -a.v, r: { negative: !a.r.negative, n: a.r.n, d: a.r.d } } : numResult(-a.v)
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
    switch (op) {
      case '<': return boolResult(toJSValue(a) < toJSValue(b))
      case '>': return boolResult(toJSValue(a) > toJSValue(b))
      case '<=': return boolResult(toJSValue(a) <= toJSValue(b))
      case '>=': return boolResult(toJSValue(a) >= toJSValue(b))
      case '==': return boolResult(looseEqResult(a, b))
      case '!=': return boolResult(!looseEqResult(a, b))
      case '===': return boolResult(strictEqResult(a, b))
      case '!==': return boolResult(!strictEqResult(a, b))
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Math.* / string-method call evaluation
// ---------------------------------------------------------------------------
// Value map, not a Set + `Math[k]` — computed Math members are outside the
// self-compile subset (see HOST_EXACT_UNARY below).
const MATH_CONST = {
  PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10,
  LOG2E: Math.LOG2E, LOG10E: Math.LOG10E, SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2,
}
// `Number.X` mirrors Math.X above — prepare's '.' handler (src/
// prepare/index.js `'.'(obj, prop)`) resolves it to the bare `'Number.X'` STRING
// (module/number.js's `ctx.core.emit['Number.MIN_VALUE']` etc. — the niladic-
// getter table for the whole family), which otherwise reaches emit as an opaque
// name with no provable VAL.NUMBER kind: unary `+`'s valTypeOf(a)===VAL.NUMBER
// fast path (emit.js 'u+') misses it and falls through to the runtime `__to_num`
// call — sound for every OTHER member of this table, but MIN_VALUE is the one
// subnormal constant, and __to_num's BigInt-carrier heuristic (module/number.js)
// misdecodes any nonzero finite subnormal as raw carrier bits: `+Number.MIN_VALUE`
// silently returned 1 instead of 5e-324. Folding to a literal HERE (pre-eval,
// before emit ever sees it) is the general fix: a `[null, v]` literal node's
// valTypeOf is unconditionally VAL.NUMBER (kind.js), so every consumer — unary
// `+`, arithmetic, the export-return boundary — gets the same numeric fast path
// Math.PI already gets, with zero per-consumer patching.
const NUMBER_CONST = {
  MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER, MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
  EPSILON: Number.EPSILON, MAX_VALUE: Number.MAX_VALUE, MIN_VALUE: Number.MIN_VALUE,
  POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity, NaN: NaN,
}
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
// Explicit per-name dispatch (not `Math[name](x)`): a computed member call on
// the Math namespace is outside the self-compile subset — pre-eval joined the
// kernel graph with the front-half unification (src/front.js), so every shape
// here must self-compile-compile. Same convention as recurse.js's wrapped isArr.
const HOST_EXACT_UNARY = {
  sqrt: (x) => Math.sqrt(x), abs: (x) => Math.abs(x), floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x), trunc: (x) => Math.trunc(x), round: (x) => Math.round(x),
  fround: (x) => Math.fround(x), sign: (x) => Math.sign(x),
}

function evalMathCall(name, vs) {
  if (name === 'pow') return vs.length === 2 ? numResult(powFold(vs[0], vs[1])) : null
  if (name === 'min') return numResult(vs.length ? Math.min(...vs) : Infinity)
  if (name === 'max') return numResult(vs.length ? Math.max(...vs) : -Infinity)
  if (name === 'imul') return vs.length === 2 ? numResult(Math.imul(vs[0], vs[1])) : null
  if (name === 'clz32') return vs.length === 1 ? numResult(Math.clz32(vs[0])) : null
  const uf = HOST_EXACT_UNARY[name]
  if (uf) return vs.length === 1 ? numResult(uf(vs[0])) : null
  const kfn = MATH_KERNEL['math.' + name]
  return kfn ? numResult(kfn(...vs)) : null
}

/** args: EvalResult[] (some entries may be null — the method itself validates types/arity).
 *  A `null` entry means "this argument IS present in the call but evalConst couldn't fold
 *  it" (e.g. an IIFE, or a bare `NaN`/`Infinity` identifier evalConst doesn't special-case)
 *  — distinct from a genuinely absent trailing argument, which reads back as JS `undefined`
 *  via out-of-bounds array access (collectArgs only ever returns entries for arguments
 *  actually written at the call site, so `args`'s length already tracks arity exactly). */
function evalStringMethod(name, s, args) {
  // `a === undefined`: index past `args.length` — no such argument at the call site, safe
  // to treat as the method's default. `a == null` (i.e. `a === null`, the OTHER falsy case)
  // must NOT take that branch — it means the argument IS there but isn't a fold-time
  // constant, and treating it as "absent" silently substitutes a wrong default (was reached
  // live via `"str".slice(NaN)` / `.slice(function(){}())`: NaN's dedicated `['nan']` AST
  // node and an unfoldable call both evalConst to `null`, and the OLD `a == null` clause
  // let them through as if omitted — `args[i].v` then crashed on the two-arg branch, and
  // charAt's `args[0]?.v ?? 0` silently folded to 0 without crashing, either way ignoring
  // the argument's real runtime value.
  const isNumOrAbsent = (a) => a === undefined || (a !== null && a.t === 'num')
  if (name === 'toUpperCase' && args.length === 0) return strResult(s.toUpperCase())
  if (name === 'toLowerCase' && args.length === 0) return strResult(s.toLowerCase())
  if (name === 'trim' && args.length === 0) return strResult(s.trim())
  if (name === 'slice' && args.length <= 2 && args.every(isNumOrAbsent)) {
    // Explicit arity dispatch, not `s.slice(args[0]?.v, args[1]?.v)`: an omitted
    // arg and an EXPLICITLY-passed `undefined` are the same value in host JS (so
    // the two-arg form with optional-chained `undefined`s was spec-correct
    // natively), but self-compiled this code compiles the CALL SITE itself — a
    // 2-arg `.slice(x, undefined)` call is a different compiled shape than the
    // 1-arg `.slice(x)` it's meant to mean, and jz's own `.slice` (module/
    // string.js) didn't treat an explicit-undefined `end` as "default to
    // length" the same way arity-omission does. Same class as the earlier
    // computed-Math-member self-compile-subset fixes — match the call shape the
    // caller actually intends, never synthesize an explicit undefined arg.
    const r = args.length === 0 ? s.slice()
      : args.length === 1 ? s.slice(args[0].v)
      : s.slice(args[0].v, args[1].v)
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
    if (node.startsWith('math.') && MATH_CONST[node.slice(5)] !== undefined) return numResult(MATH_CONST[node.slice(5)])
    if (node.startsWith('Number.') && NUMBER_CONST[node.slice(7)] !== undefined) return numResult(NUMBER_CONST[node.slice(7)])
    return null
  }
  if (!Array.isArray(node)) return null
  const op = node[0]

  if (op == null) {
    const v = node[1]
    if (typeof v === 'number') return numResult(v)   // bigint literals are the distinct 'bigint' op — never this shape
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
    if (node[1] === 'Math' && typeof node[2] === 'string' && MATH_CONST[node[2]] !== undefined) return numResult(MATH_CONST[node[2]])
    if (node[1] === 'Number' && typeof node[2] === 'string' && NUMBER_CONST[node[2]] !== undefined) return numResult(NUMBER_CONST[node[2]])
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
    if (typeof c[PARAM_NAME] === 'string') names.push(c[PARAM_NAME])
  }
  return names
}

function foldNode(node, env, state) {
  if (typeof node === 'string') {
    // A bare-string node is a plain identifier COPY-through in the common case,
    // but it is ALSO the exact shape prepare's '.' handler collapses a namespace
    // constant reference to (`'math.PI'`, `'Number.MIN_VALUE'`, …, see
    // MATH_CONST/NUMBER_CONST above) — a Math/Number constant used directly as
    // an expression (`() => Number.MIN_VALUE`, `return Math.PI`) never passes
    // through the op!=null `evalConst(node,…)` call below (there is no wrapping
    // op node), so this branch must exist or the whole-program's ONE
    // fold-to-literal chokepoint silently skips it, leaving an opaque
    // unresolvable-kind name to reach the export-return boundary, where it
    // decodes its raw f64 bits as an ambiguous carrier (a bare
    // `Number.MIN_VALUE`/`Math.PI` export would return a garbage BigInt).
    // Delegating the whole branch to evalConst (which already does the env
    // lookup, see below) picks up both tables uniformly, no new special case.
    const c = evalConst(node, env, state)
    return c ? nodeOf(c) : node
  }
  if (!Array.isArray(node)) return node
  const op = node[0]
  // 'bigint': the tagged literal (parse.js) — opaque here like str/bool;
  // its payload is a decimal STRING, not a name to look up (the generic child-recursion
  // fallback below would otherwise call foldNode on args[0] as if it were an identifier).
  if (op == null || op === 'str' || op === 'bool' || op === 'bigint') return node

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

/** Run preEval over the prepared module AST + every ctx.funcs.list body (mutated in place —
 *  the same funcInfo objects compile() reads). Single top-to-bottom pass; see module doc for
 *  why that's already a full fixpoint. */
export function preEval(ast) {
  // Rational carry runs on bignum.js's host-independent u32-limb arithmetic —
  // no width ceiling, no native-BigInt dependency, so it's unconditionally
  // available: native and the self-compile kernel fold identically
  // (test/kernel-parity.js fold|0/2/3).
  const rationalOn = ctx.transform.optimize?.rationalConst !== false
  const funcByName = new Map(ctx.funcs.list.map(f => [f.name, f]))
  const state = { rationalOn, funcByName, evaluating: new Set() }
  for (const f of ctx.funcs.list) f.body = foldFunctionBody(f.body, state)
  if (ast == null) return ast
  return foldBlockLike(ast, new Map(), state)
}
