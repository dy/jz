/**
 * Math module - Math.sin, Math.cos, Math.sqrt, Math.PI, etc.
 *
 * Module API:
 * - reg('math.X', deps, args => WasmNode) — emit handler + declarative stdlib deps
 * - wat('math.X', `(func …)`) — WAT stdlib via bridge
 * - deps({ 'math.X': ['dep'] }) - WAT stdlib→stdlib deps (expanded transitively)
 *
 * Prepare resolves Math.sin(x) → ['()', 'math.sin', x]
 * Compile looks up ctx.core.emit['math.sin'] and calls it.
 *
 * @module math
 */

import { typed, asF64, toI32, toNumF64, temp, arrayLoop, isLit, litVal, isPureIR } from '../src/ir.js'
import { emit, emitter, reg, deps, tag, wat } from '../src/bridge.js'
import { inc, err } from '../src/ctx.js'
import { repOf, VAL } from '../src/reps.js'
import { valTypeOf } from '../src/kind.js'
import { registerPowTranscend } from './math/pow-transcend.js'
import { powFold } from '../src/prepare/math-kernel.js'
import { PI, HALF_PI, PIO2_CW, INV_PIO2, ROUND_MAGIC, CW_LIMIT, PIO2_LO, TWO_OVER_PI_HEX, SIN_C, COS_C, ATAN_C, ASIN_C, EXPM1_C, LOG_C, EXP2_TAB_HEX, EXP2_Q, EXP_Q, EXP_L1, EXP_L2, POW_LOG_TAB_HEX, POW_LOG_A, POW_LN2HI, POW_LN2LO, polyTree, fifthFold } from './math/trig-tables.js'
import { hexBytes } from '../src/static-data.js'
import { registerMathSimd } from './math/simd.js'
import { registerSumPrecise } from './math/sum-precise.js'
import { registerMathRandom } from './math/random.js'

export default (ctx) => {
  // `**`/Math.pow kernel select — see the single authoritative comment block just above
  // `emitPow` (below) for full crPow/approxPow semantics. Read once here; every other site
  // (deps table, pow_core/pow_fold/pow_fold_v dual bodies) just branches on this.
  const crPow = !!ctx.transform.optimize?.crPow
  deps({
    'math.sin': ['math.rem_pio2'],
    'math.cos': ['math.rem_pio2'],
    'math.tan': ['math.rem_pio2'],
    'math.rem_pio2': [],
    'math.exp': [],
    'math.expm1': ['math.exp'],
    'math.log2': ['math.log'],
    'math.log1p': ['math.log'],
    'math.pow': ['math.pow_core'],
    'math.pow_core': crPow ? ['math.pow_transcend'] : [],
    'math.pow_scalbn': [],
    // math.pow_transcend/math.pow_fold only exist (are registered as wat() templates below) when
    // optimize.crPow is set — see the authoritative comment above emitPow. Declaring their deps
    // unconditionally here is harmless when crPow is off: nothing ever inc()s 'math.pow_fold' in
    // that mode (emitPow's const-exponent branch calls $math.exp/$math.log instead), so this edge
    // is simply never traversed.
    'math.pow_transcend': ['math.pow_scalbn'],
    'math.pow_fold': ['math.pow_transcend'],
    'math.asin': [],
    'math.acos': [],
    'math.atan2': ['math.atan'],
    'math.sinh': ['math.exp', 'math.expm1'],
    'math.cosh': ['math.exp'],
    'math.tanh': ['math.expm1'],
    'math.asinh': ['math.log', 'math.log1p'],
    'math.acosh': ['math.log', 'math.log1p'],
    'math.atanh': ['math.log1p'],
    'math.cbrt': ['math.isFinite'],
    'math.fifthroot': ['math.isFinite'],
    'math.pow_fifths': ['math.fifthroot'],
    'math.sumPrecise': ['__ptr_offset', '__len', '__alloc'],
  })
  // Helpers: all math ops take f64 and return f64. Args go through ToNumber
  // (toNumF64) — ECMA Math methods coerce each argument, so null→0, undefined→NaN.
  const f = (op, a) => typed([op, toNumF64(a, emit(a))], 'f64')
  // floor/ceil/trunc/round are no-ops on integer-valued operands. When the
  // arg is a local whose every def is integer-valued (intCertain lattice),
  // skip the wasm op and just hand back the operand cast to f64. Same elision
  // fires for schema-field reads `o.x` when every observed write to that slot
  // is integer-shaped (ctx.schema.slotIntCertainAt).
  const isIntCertain = a => {
    if (typeof a === 'string') return repOf(a)?.intCertain === true
    if (Array.isArray(a) && a[0] === '.' && typeof a[1] === 'string' && typeof a[2] === 'string') {
      return ctx.schema.slotIntCertainAt?.(a[1], a[2]) === true
    }
    return false
  }
  // An integer rounds to itself, as a Number: a Boolean (integer-certain) converts.
  const fInt = (op, a) => isIntCertain(a) ? toNumF64(a, emit(a)) : f(op, a)
  // ECMA Math methods perform ToNumber on each argument. toNumF64 short-circuits
  // for known-number nodes, and routes everything else through __to_num so null→0,
  // undefined→NaN, and strings get parsed. Without this, raw NaN-boxed pointers
  // (null/undefined/strings) would propagate through math.log etc. and surface
  // as the original null/undefined sentinel after decode.
  // A canon'd operand feeding a math call is redundant: the callee (log/sin/exp/…)
  // propagates a non-canonical NaN identically and re-canon-izes its own result.
  // `Math.log(Math.log(x))` thus sheds the inner per-call select + f64.ne.
  const stripCanon = (v) => (v && v.canonOf != null) ? typed(v.canonOf, 'f64') : v
  const fn = (name, ...args) => typed(['call', `$${name}`, ...args.map(a => stripCanon(toNumF64(a, emit(a))))], 'f64')

  // Canonicalize a possibly-NaN f64 result. A wasm arithmetic op that mints a
  // fresh NaN (f64.sqrt of a negative, f64.min/max with a NaN operand) leaves
  // the sign bit nondeterministic — x86 yields the negative NaN 0xFFF8.., ARM
  // the positive 0x7FF8... jz's carrier reserves 0x7FF8.. as THE number-NaN;
  // a negative-NaN number is bit-identical to a negative BigInt and corrupts
  // untyped === / typeof. So fold any NaN back to canonical where one is born.
  const canon = (node) => {
    const t = temp('cn')
    const ir = typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, node],
      ['select',
        ['f64.const', 'nan'],
        ['local.get', `$${t}`],
        ['f64.ne', ['local.get', `$${t}`], ['local.get', `$${t}`]]]], 'f64')
    // Tag the wrapper so a NaN-propagating f64 consumer (`f64.add`/`mul`/… that
    // itself canon-izes on escape) can strip the redundant inner canon: the raw
    // op result `node` propagates a freshly-minted NaN identically through the
    // consumer, and only the OUTERMOST escaping value needs the canonical form.
    ir.canonOf = node
    return ir
  }

  // sqrt(x) needs no NaN-canon when its argument is provably ≥ 0 with no spurious NaN:
  // the result is then a normal non-negative f64 (or +0 / +inf, or a propagated input
  // NaN that is already canonical), never a freshly-minted ±NaN. A sum of pure squares
  // — the vector-length idiom sqrt(x*x + y*y + …) — is exactly that: every term is ≥ +0
  // (even ±0·±0 = +0, ±inf² = +inf), the sum never cancels to inf−inf, and any NaN can
  // only come from a NaN input (already the canonical number-NaN). So a distance /
  // normalize loop sheds the per-sqrt select + f64.ne + local on its critical path.
  // `pure` excludes call/load/tee, so two structurally-equal operands of a `*` really
  // are the same value (a genuine square), not two side-effecting evaluations.
  const pureF64 = (n) => !Array.isArray(n) ? true :
    (n[0] === 'local.get' || n[0] === 'global.get' || n[0] === 'f64.const' || n[0] === 'i32.const' || n[0] === 'i64.const') ? true :
    (n[0] === 'f64.add' || n[0] === 'f64.sub' || n[0] === 'f64.mul' || n[0] === 'f64.div' || n[0] === 'f64.neg' || n[0] === 'f64.abs' || n[0] === 'f64.convert_i32_s' || n[0] === 'f64.convert_i32_u') ? n.slice(1).every(pureF64) : false
  const sameIR = (a, b) => Array.isArray(a) !== Array.isArray(b) ? false : !Array.isArray(a) ? a === b : (a.length === b.length && a.every((x, i) => sameIR(x, b[i])))
  const nonNegF64 = (n) => !Array.isArray(n) ? false :
    n[0] === 'f64.mul' ? (pureF64(n[1]) && sameIR(n[1], n[2])) :     // x·x ≥ 0
    n[0] === 'f64.add' ? (nonNegF64(n[1]) && nonNegF64(n[2])) :      // (≥0) + (≥0) ≥ 0
    n[0] === 'f64.const' ? (typeof n[1] === 'number' && n[1] >= 0) : false
  const sqrtIR = (a) => { const ir = f('f64.sqrt', a); return nonNegF64(ir[1]) ? ir : canon(ir) }

  // Constants — each folds to its `(f64.const …)` inline (no stdlib dep, hence
  // direct emit rather than reg). Written out (not a `Math[name]` loop) because the
  // self-compile subset can't resolve dynamic access on the `Math` compile-time namespace.
  ctx.core.emit['math.PI'] = () => typed(['f64.const', Math.PI], 'f64')
  ctx.core.emit['math.E'] = () => typed(['f64.const', Math.E], 'f64')
  ctx.core.emit['math.LN2'] = () => typed(['f64.const', Math.LN2], 'f64')
  ctx.core.emit['math.LN10'] = () => typed(['f64.const', Math.LN10], 'f64')
  ctx.core.emit['math.LOG2E'] = () => typed(['f64.const', Math.LOG2E], 'f64')
  ctx.core.emit['math.LOG10E'] = () => typed(['f64.const', Math.LOG10E], 'f64')
  ctx.core.emit['math.SQRT2'] = () => typed(['f64.const', Math.SQRT2], 'f64')
  ctx.core.emit['math.SQRT1_2'] = () => typed(['f64.const', Math.SQRT1_2], 'f64')

  /** Emit array reduce with a WASM binary op (for Math.max(...arr), Math.min(...arr)) */
  function emitArrayReduce(wasmOp, arrExpr, initVal) {
    const acc = temp('mr')
    const loop = arrayLoop(emit(arrExpr), (_ptr, _len, _i, item) => [
      ['local.set', `$${acc}`, [wasmOp, ['local.get', `$${acc}`], asF64(item)]]
    ])
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${acc}`, ['f64.const', initVal]],
      ...loop,
      ['local.get', `$${acc}`]], 'f64')
  }

  // Built-in WASM ops. sqrt/min/max mint a fresh NaN (sqrt of a negative, min/max
  // with a NaN operand) whose sign is platform-nondeterministic — `canon` folds it
  // back to the canonical pattern. abs/floor/ceil/trunc never produce a new NaN.
  ctx.core.emit['math.sqrt'] = a => sqrtIR(a)
  ctx.core.emit['math.abs'] = a => f('f64.abs', a)
  ctx.core.emit['math.floor'] = a => fInt('f64.floor', a)
  ctx.core.emit['math.ceil'] = a => fInt('f64.ceil', a)
  ctx.core.emit['math.trunc'] = a => fInt('f64.trunc', a)
  // Math.min/max fold their operands with a wasm op. f64.min/max PROPAGATE a
  // NaN but never MINT one, so `canon` is needed only when an operand could
  // itself be NaN. An operand provably never is when it's an intCertain local/
  // slot, a non-NaN numeric literal, or an i32-typed carrier (`x|0`, compares,
  // lengths). When every operand qualifies, drop `canon` — erasing its cost
  // from the common integer-clamp idiom Math.min(idx, len) / Math.max(x|0, lo).
  const neverNaN = (src, v) =>
    isIntCertain(src) || (typeof src === 'number' && src === src) ||
    (v.type === 'i32' && v.ptrKind == null) || (isLit(v) && litVal(v) === litVal(v))
  const minmax = (op, ident) => (a, b, ...rest) => {
    if (a === undefined) return typed(['f64.const', ident], 'f64')
    // Spread: Math.min(...arr) — array contents unknown, keep canon
    if (!b && Array.isArray(a) && a[0] === '...') return canon(emitArrayReduce(op, a[1], ident))
    // Mixed: Math.max(1e-12, ...scores) folds scalars and spread elements in
    // order into one accumulator (a scalar operand still ToNumbers).
    const all = b === undefined ? [a] : [a, b, ...rest]
    if (all.some(x => Array.isArray(x) && x[0] === '...')) {
      const acc = temp('mr')
      const steps = []
      for (const x of all) {
        if (Array.isArray(x) && x[0] === '...')
          steps.push(...arrayLoop(emit(x[1]), (_ptr, _len, _i, item) => [
            ['local.set', `$${acc}`, [op, ['local.get', `$${acc}`], asF64(item)]]]))
        else steps.push(['local.set', `$${acc}`, [op, ['local.get', `$${acc}`], toNumF64(x, emit(x))]])
      }
      return canon(typed(['block', ['result', 'f64'],
        ['local.set', `$${acc}`, ['f64.const', ident]], ...steps, ['local.get', `$${acc}`]], 'f64'))
    }
    const src = b === undefined ? [a] : [a, b, ...rest]
    const ev = src.map(x => emit(x))
    let r = typed([op, toNumF64(src[0], ev[0]),
      b === undefined ? ['f64.const', ident] : toNumF64(src[1], ev[1])], 'f64')
    for (let i = 2; i < src.length; i++) r = typed([op, r, toNumF64(src[i], ev[i])], 'f64')
    return src.every((s, i) => neverNaN(s, ev[i])) ? r : canon(r)
  }
  ctx.core.emit['math.min'] = minmax('f64.min', Infinity)
  ctx.core.emit['math.max'] = minmax('f64.max', -Infinity)
  // f64.nearest is roundTiesToEven; JS Math.round is roundTiesToward+∞. They agree
  // everywhere except exact half-integers n+0.5 with n even (nearest→n, JS→n+1).
  // Detect that one case — `nearest(x) === x - 0.5` — and bump by one. (The −0.5→−0
  // and 0.49999…94→0 edges already match `f64.nearest`.)
  ctx.core.emit['math.round'] = a => {
    if (isIntCertain(a)) return asF64(emit(a))
    const t = temp('rnd'), n = temp('rnd')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, toNumF64(a, emit(a))],
      ['local.set', `$${n}`, ['f64.nearest', ['local.get', `$${t}`]]],
      ['select',
        ['f64.add', ['local.get', `$${n}`], ['f64.const', 1]],
        ['local.get', `$${n}`],
        ['f64.eq', ['local.get', `$${n}`], ['f64.sub', ['local.get', `$${t}`], ['f64.const', 0.5]]]],
    ], 'f64')
  }
  ctx.core.emit['math.fround'] = a => typed(['f64.promote_f32', ['f32.demote_f64', toNumF64(a, emit(a))]], 'f64')
  // ES2025 Math.f16round — no wasm f16 ops, so round in software (exactly, kernel in core.js).
  reg('math.f16round', ['math.f16round'], a => fn('math.f16round', a))

  // Sign
  reg('math.sign', ['math.sign'], a => fn('math.sign', a))

  // Trig
  reg('math.sin', ['math.sin'], a => fn('math.sin', a))
  reg('math.cos', ['math.cos'], a => fn('math.cos', a))
  reg('math.tan', ['math.tan'], a => fn('math.tan', a))

  // Inverse trig
  reg('math.asin', ['math.asin'], a => fn('math.asin', a))
  reg('math.acos', ['math.acos'], a => fn('math.acos', a))
  reg('math.atan', ['math.atan'], a => fn('math.atan', a))
  reg('math.atan2', ['math.atan2'], (a, b) => fn('math.atan2', a, b))

  // Hyperbolic
  reg('math.sinh', ['math.sinh'], a => fn('math.sinh', a))
  reg('math.cosh', ['math.cosh'], a => fn('math.cosh', a))
  reg('math.tanh', ['math.tanh'], a => fn('math.tanh', a))

  // Inverse hyperbolic
  reg('math.asinh', ['math.asinh'], a => fn('math.asinh', a))
  reg('math.acosh', ['math.acosh'], a => fn('math.acosh', a))
  reg('math.atanh', ['math.atanh'], a => fn('math.atanh', a))

  // Exponential and logarithmic
  reg('math.exp', ['math.exp'], a => fn('math.exp', a))
  reg('math.expm1', ['math.expm1'], a => fn('math.expm1', a))
  reg('math.log', ['math.log'], a => fn('math.log', a))
  reg('math.log2', ['math.log2'], a => fn('math.log2', a))
  reg('math.log10', ['math.log10'], a => fn('math.log10', a))
  reg('math.log1p', ['math.log1p'], a => fn('math.log1p', a))

  // Power. Constant-integer-exponent `Math.pow(x,n)` / `x ** n` (|n| ≤ POW_FOLD_MAX)
  // lower to inline square-and-multiply instead of a $math.pow call. The fold is
  // bit-identical to $math.pow's integer fast path: that path runs the same LSB-first
  // square-and-multiply, and an f64 product's magnitude is the rounded product of the
  // operand magnitudes regardless of sign — so multiplying the *signed* base reproduces
  // both the exact bits and the result sign (negative iff x<0 ∧ n odd, which is exactly
  // its `neg_base`). A program whose only pow use is folded then never pulls the
  // math.pow/exp/log stdlib. `**`'s exponent is parsed as a bare number (incl. negatives).
  const POW_FOLD_MAX = 16
  const get = name => ['local.get', `$${name}`]
  const constInt = b => {
    const v = typeof b === 'number' ? b
      : (Array.isArray(b) && b.length === 2 && b[0] == null && typeof b[1] === 'number') ? b[1]
      : null
    return v != null && Number.isInteger(v) ? v : null
  }
  const foldPow = (a, n) => {
    const baseIR = toNumF64(a, emit(a))
    // pow(x,0) === 1 for every x (NaN/±0/±Inf included). Keep the base's side
    // effects (a call, a throwing valueOf), discard its value, yield 1.
    if (n === 0) return isPureIR(baseIR)
      ? typed(['f64.const', 1], 'f64')
      : typed(['block', ['result', 'f64'], ['drop', baseIR], ['f64.const', 1]], 'f64')
    const b = temp('pw')
    // a negative exponent squares the reciprocal, as $math.pow does: 1/x^n overflowed
    // to 0 where x^-n is still a double
    const stmts = [['local.set', `$${b}`, n < 0 ? ['f64.div', ['f64.const', 1], baseIR] : baseIR]]
    // square-and-multiply, LSB-first — mirrors $math.pow's loop association exactly,
    // so the rounding tree (and thus the last bit) matches.
    let sq = b, res = null, minted = false
    for (let m = Math.abs(n); m > 0; m >>= 1) {
      if (m & 1) {
        if (res === null) res = sq                 // lowest set bit: result := this square (skip ×1)
        else { const r = temp('pw'); stmts.push(['local.set', `$${r}`, ['f64.mul', get(res), get(sq)]]); res = r; minted = true }
      }
      if (m >> 1) { const s = temp('pw'); stmts.push(['local.set', `$${s}`, ['f64.mul', get(sq), get(sq)]]); sq = s; minted = true }
    }
    const result = get(res)
    if (n < 0) minted = true   // the reciprocal
    // A NaN minted by f64.mul/div has a platform-nondeterministic sign; jz's value
    // model requires the one canonical number-NaN, so `canon` folds it back. Skip when
    // the base provably can't be NaN (same test min/max uses) or when no op was minted
    // (|n|=1 hands the base straight through, already canonical).
    const inner = typed(['block', ['result', 'f64'], ...stmts, result], 'f64')
    return (minted && !neverNaN(a, baseIR)) ? canon(inner) : inner
  }
  const constNum = b => typeof b === 'number' ? b
    : (Array.isArray(b) && b.length === 2 && b[0] == null && typeof b[1] === 'number') ? b[1]
    : null
  // `x ** 0.5` folds to f64.sqrt instead of the exp/log $math.pow call — saves the
  // whole pow/exp/log stdlib (the headline `dist` example drops from ~1.0kB to 70B)
  // and runs at hardware-sqrt speed. f64.sqrt is correctly-rounded, so for every
  // normal input it is bit-identical to V8's `Math.pow(x, 0.5)`, and it agrees with
  // jz's own `Math.sqrt(x)` by construction (mirrors the math.sqrt emit: always
  // canon, since a negative finite base yields a NaN whose sign needs canonicalizing).
  // Two exotic inputs follow sqrt rather than Math.pow semantics — a deliberate
  // trade in the same class as jz's other boundary divergences: `(-0) ** 0.5` is -0
  // (Math.pow: +0; and -0 === 0), `(-Infinity) ** 0.5` is NaN (Math.pow: +Infinity).
  // `** -0.5` is intentionally NOT folded: 1/sqrt double-rounds and loses the last
  // ULP vs Math.pow's single rounding, so it keeps the exact $math.pow path.
  const powCall = emitter(['math.pow'], (a, b) => fn('math.pow', a, b))
  // Shared pow/** lowering.
  const emitPow = (a, b, allowExpPos) => {
    // BigInt ** is real JS (2n ** 3n === 8n) but unimplemented — the f64 pow
    // pipeline would reinterpret raw i64 bits. Reject instead of silent garbage.
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      err('BigInt exponentiation (`**`) not supported — use a multiply loop or Number(x)')
    const n = constInt(b)
    if (n !== null && Math.abs(n) <= POW_FOLD_MAX) return foldPow(a, n)
    if (constNum(b) === 0.5) { const ir = typed(['f64.sqrt', toNumF64(a, emit(a))], 'f64'); return nonNegF64(ir[1]) ? ir : canon(ir) }
    // Both args are compile-time constants: evaluate now, emit f64.const, as the lowering
    // below would compute it (src/prepare/math-kernel.js powFold, the kernels' twin).
    // Catches pow(2, -2/12) where the arithmetic folds emit f64.const for both sides.
    const ca = constNum(a), cb = constNum(b)
    if (ca !== null && cb !== null) return typed(['f64.const', powFold(ca, cb)], 'f64')
    // IR-level fold: peek at emitted IR for both args — e.g. -2/12 emits f64.const -0.1666.
    // We emit, check, and if not foldable, the emitted IR is used by the fallthrough paths.
    const irA = toNumF64(a, emit(a)), irB = toNumF64(b, emit(b))
    if (isLit(irA) && isLit(irB)) return typed(['f64.const', powFold(litVal(irA), litVal(irB))], 'f64')
    // Constant non-integer exponent c: inline Math.pow(x,c) as a fast fold instead of the
    // general $math.pow. Skipping the ~15-branch pow special-case ladder (only the x-dependent
    // slice — NaN/±Inf/0/negative — is needed; every y-branch is statically dead since c is a
    // known finite non-0/1/±0.5/integer literal) + the call frame is still a per-pixel win on
    // the gamma curves (v**0.45, a**(1/2.4)) that dominate tone-mapping, and a program whose
    // only pow is folded this way never pulls the general $math.pow/pow_core. Integers stay on
    // $math.pow (its square-and-multiply path is exact, not transcendental); ±0.5 stays sqrt
    // (also exact, correctly rounded by hardware).
    //
    // KERNEL SELECT — `optimize.crPow` (default OFF) picks how a constant non-integer exponent
    // lowers:
    //   OFF (DEFAULT): the k/5-exponent gammas (sRGB/Rec.709 decode, 2.4/2.2/…) take the
    //     algebraic fifthroot fold, $math.pow_fifths (x^(k/5) = x^p·fifthroot(x^r), p=⌊c⌋,
    //     r=5c−5p ∈ 1..4; four Newton steps, within 40 ulp of x^c, not correctly rounded,
    //     pinned by test/pow.js). Every other constant takes the same `$math.pow` call a runtime exponent
    //     takes: its ladder settles the edges (x=−∞ included) and $math.pow_core, Arm's
    //     optimized-routines pow (see its comment below), does the rest within an ulp of the
    //     host — so `x ** c` and `Math.pow(x, y)` with y == c agree bit for bit, and the
    //     constant fold of the same expression (src/prepare/math-kernel.js) is the kernel's
    //     twin.
    //   ON: the constant exponent instead routes through $math.pow_fold, which shares
    //     $math.pow_transcend's two-phase Ziv dd/td kernel with the runtime-y path $math.pow_core
    //     uses when crPow is on (see $math.pow_transcend's own comment for the algorithm) —
    //     CORRECTLY ROUNDED (0 misrounds on the 5152-vector CORE-MATH-class gate,
    //     test/pow-cr.js). c needs no pre-split: the shared kernel's multiply is a twoProd-based
    //     exact product (Dekker-splits BOTH operands internally), so the call is just x and the
    //     f64.const literal c. HONEST COST: measured 8× the default kernel per call (79 ns
    //     against 9.9 ns, a 4M-call loop over 1024 bases with y = 2.45) — correctness has a
    //     real price, so this stays opt-in rather than default (`{ optimize: { crPow: true } }`).
    //     Under crPow, the fifthroot fast path is ALSO opt-in rather than automatic
    //     (`{ optimize: { approxPow: true } }`, default OFF): correctness wins by default once
    //     crPow has opted into the correctly-rounded kernel family — a caller who wants both
    //     speed AND crPow's runtime-y correctness sets both flags.
    if (isLit(irB)) {
      const c = litVal(irB)
      // Finite x<0 → NaN to match Math.pow on a non-integer exponent (the exp·log form's
      // log(<0)=NaN). x=-Infinity is its OWN case, not "negative": |x|=Infinity means Math.pow
      // ignores the sign for a non-integer exponent (c > 0 in this branch's guard, so the result
      // is +Infinity). x=+0/-0/+∞/NaN carry correctly through power + fifthroot.
      // The fifthroot fold is within 40 ulp of x^c (four Newton steps, see $math.fifthroot;
      // [lo, hi], trig-tables.js fifthFold, is where it runs on x itself, $math.pow_fifths
      // scales every other x): the transcendental-kernel class the README documents, so it
      // stays the default; under crPow it is the opt-in `approxPow`.
      const fifthrootGate = crPow ? ctx.transform.optimize?.approxPow : true
      if (fifthrootGate && Number.isFinite(c) && c > 0 && c < 5 && !Number.isInteger(c) && Number.isInteger(c * 5)) {
        inc('math.pow_fifths')
        const { lo, hi } = fifthFold(c)
        return typed(['call', '$math.pow_fifths', irA, ['f64.const', c], ['f64.const', lo], ['f64.const', hi]], 'f64')
      }
      if (crPow) {
        if (Number.isFinite(c) && !Number.isInteger(c) && c !== 0.5 && c !== -0.5) {
          inc('math.pow_fold')
          // c needs no hi/lo pre-split: $math.pow_fold shares $math.pow_transcend's kernel,
          // which exact-multiplies via twoProd (Dekker split done ON BOTH operands inside the
          // kernel) rather than fdlibm's manual y1/y2 chop — so a single f64.const suffices.
          return typed(['call', '$math.pow_fold', irA, ['f64.const', c]], 'f64')
        }
      }
      // Otherwise the constant exponent takes the same kernel as a runtime one
      // ($math.pow's ladder and $math.pow_core, within an ulp of the host), so `x ** 2.4`
      // and `Math.pow(x, 2.4)` agree bit for bit; exp(c·log(x)) was a second algorithm
      // with its own rounding.
    }
    // base 2 → dedicated 2^y (exp2 is exact for integer y, and skips exp's ×ln2/÷ln2).
    // Every other literal base keeps $math.pow: `exp(y·ln base)` would lose ulps and,
    // worse, miss Math.pow's integer-exponent semantics — e.g. `16 ** flen` with a
    // runtime-integer flen must reproduce the exact square-and-multiply value (2⁵² for
    // flen=13), which only $math.pow's integer fast path delivers.
    if (allowExpPos && isLit(irA) && litVal(irA) === 2 && n === null)
      return (inc('math.exp2'), typed(['call', '$math.exp2', irB], 'f64'))
    return (inc('math.pow'), typed(['call', '$math.pow', irA, irB], 'f64'))
  }
  ctx.core.emit['math.pow'] = tag((a, b) => emitPow(a, b, true), powCall.deps)
  ctx.core.emit['**'] = tag((a, b) => emitPow(a, b, true), powCall.deps)
  reg('math.cbrt', ['math.cbrt'], a => fn('math.cbrt', a))
  reg('math.hypot', ['math.hypot'], (a, b, ...rest) => {
    if (a === undefined) return typed(['f64.const', 0], 'f64')
    // Spread: Math.hypot(...arr) folds the kernel pairwise over the elements
    // (hypot(hypot(a, b), c) is the same overflow-safe magnitude).
    if (!b && Array.isArray(a) && a[0] === '...') {
      const acc = temp('hy')
      const loop = arrayLoop(emit(a[1]), (_ptr, _len, _i, item) => [
        ['local.set', `$${acc}`, ['call', '$math.hypot', ['local.get', `$${acc}`], asF64(item)]]
      ])
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${acc}`, ['f64.const', 0]],
        ...loop,
        ['local.get', `$${acc}`]], 'f64')
    }
    if (b === undefined) return f('f64.abs', a)
    let r = fn('math.hypot', a, b)
    // ToNumber every rest arg too (matches min/max) — an object arg's valueOf
    // must run and may throw, which Math.hypot propagates.
    for (const x of rest) r = typed(['call', '$math.hypot', r, toNumF64(x, emit(x))], 'f64')
    return r
  })

  registerSumPrecise()

  // Integer/bit operations: return i32 directly. Consumers `asF64`-rebox at
  // store/return boundaries; consumers staying in i32 (bit chains, i32 locals)
  // skip the convert/trunc round-trip entirely.
  // Operands take ECMAScript ToInt32 (wrapping), not saturation — `Math.imul(x, k)`
  // with a literal k ≥ 2³¹ must wrap to negative, matching JS, not clamp to INT_MAX.
  ctx.core.emit['math.clz32'] = a => typed(['i32.clz', toI32(emit(a))], 'i32')
  ctx.core.emit['math.imul'] = (a, b) => typed(['i32.mul', toI32(emit(a)), toI32(emit(b))], 'i32')

  registerMathRandom()

  // ============================================
  // WAT stdlib implementations
  // ============================================

  // Round-to-nearest-f16 without double rounding: add-then-subtract s = 1.5·2^(52+k)
  // makes the f64 adder itself round |x| to a multiple of the f16 quantum 2^k,
  // ties-to-even (sum stays in s's binade, so the subtraction is exact). k comes
  // from |x|'s exponent: eu-10 for f16 normals (eu ≥ -14), -24 in the subnormal
  // range. Overflow boundary: |x| ≥ 65520 (= 65504 + half-ulp) → ±∞, per spec.
  wat('math.f16round', `(func $math.f16round (param $x f64) (result f64)
    (local $abs i64) (local $eu i32) (local $s f64)
    (local.set $abs (i64.and (i64.reinterpret_f64 (local.get $x)) (i64.const 0x7FFFFFFFFFFFFFFF)))
    ;; NaN, ±Infinity, ±0 pass through
    (if (i64.ge_u (local.get $abs) (i64.const 0x7FF0000000000000)) (then (return (local.get $x))))
    (if (i64.eqz (local.get $abs)) (then (return (local.get $x))))
    (if (f64.ge (f64.reinterpret_i64 (local.get $abs)) (f64.const 65520))
      (then (return (f64.copysign (f64.const inf) (local.get $x)))))
    (local.set $eu (i32.sub (i32.wrap_i64 (i64.shr_u (local.get $abs) (i64.const 52))) (i32.const 1023)))
    (local.set $s (f64.reinterpret_i64 (i64.or
      (i64.shl (i64.extend_i32_s (i32.add
        (select (i32.sub (local.get $eu) (i32.const 10)) (i32.const -24)
          (i32.ge_s (local.get $eu) (i32.const -14)))
        (i32.const 1075))) (i64.const 52))
      (i64.const 0x0008000000000000))))
    (f64.copysign
      (f64.sub (f64.add (f64.reinterpret_i64 (local.get $abs)) (local.get $s)) (local.get $s))
      (local.get $x)))`)

  wat('math.sign', `(func $math.sign (param $x f64) (result f64)
    ;; sign(NaN) = NaN, sign(±0) = ±0 — both pass x through unchanged.
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (if (result f64) (f64.gt (local.get $x) (f64.const 0.0))
      (then (f64.const 1.0))
      (else (f64.const -1.0))))`)

  // The shared evaluation tree (module/math/trig-tables.js polyTree) in scalar
  // WAT: the same tree the 2-wide builder and the JS constant folder use, so
  // all three agree bit for bit.
  const horner = (cs, v) => polyTree(cs, {
    konst: (c) => `(f64.const ${c})`,
    mul: (a, b) => `(f64.mul ${a} ${b})`,
    add: (a, b) => `(f64.add ${a} ${b})`,
  }, `(local.get ${v})`)

  // sin, cos and tan: x = n·π/2 + r with |r| ≤ π/4 (the constants and their bounds are
  // module/math/trig-tables.js's), then sin(r) or cos(r) by n's parity, negated by its
  // second bit. Below 2^24 the reduction is inline Cody–Waite: n from x·2/π rounded by
  // ROUND_MAGIC, whose low word then holds n, and r = x − n·π/2 in four parts, every
  // cancelling step exact, so r stays within an ulp of the true remainder at the
  // doubles closest to a multiple of π/2 (sin(π) is 1.2246467991473532e-16, as in V8).
  // Past 2^24 $math.rem_pio2 does Payne–Hanek. A NaN or an infinity (x − x is NaN)
  // returns the canonical NaN. One kernel runs, chosen by a branch on n's parity: a
  // phase advancing less than π/2 a step keeps it predicted.
  const [H1, H2, H3, H4] = PIO2_CW
  const reduceTrig = `
    (if (f64.lt (f64.abs (local.get $x)) (f64.const ${CW_LIMIT}))
      (then
        (local.set $t (f64.add (f64.mul (local.get $x) (f64.const ${INV_PIO2})) (f64.const ${ROUND_MAGIC})))
        (local.set $n (f64.sub (local.get $t) (f64.const ${ROUND_MAGIC})))
        (local.set $r (f64.sub (f64.sub (f64.sub (f64.sub (local.get $x)
          (f64.mul (local.get $n) (f64.const ${H1}))) (f64.mul (local.get $n) (f64.const ${H2})))
          (f64.mul (local.get $n) (f64.const ${H3}))) (f64.mul (local.get $n) (f64.const ${H4}))))
        (local.set $k (i32.wrap_i64 (i64.reinterpret_f64 (local.get $t)))))
      (else
        (if (f64.ne (f64.sub (local.get $x) (local.get $x)) (f64.const 0)) (then (return (f64.const nan))))
        (local.set $k (local.set $r (call $math.rem_pio2 (local.get $x))))))`
  const trigLocals = '(local $t f64) (local $n f64) (local $r f64) (local $z f64) (local $k i32)'
  // sin(r) for an even quadrant, cos(r) for an odd one, then the sign by the second bit
  const quadrant = `
    (local.set $z (f64.mul (local.get $r) (local.get $r)))
    (local.set $r (if (result f64) (i32.and (local.get $k) (i32.const 1))
      (then ${horner(COS_C, '$z')})
      (else (f64.mul (local.get $r) ${horner(SIN_C, '$z')}))))
    (select (f64.neg (local.get $r)) (local.get $r) (i32.and (local.get $k) (i32.const 2)))`
  wat('math.sin', `(func $math.sin (param $x f64) (result f64)
    ${trigLocals}${reduceTrig}${quadrant})`)
  // cos(x) = sin(x + π/2): the next quadrant
  wat('math.cos', `(func $math.cos (param $x f64) (result f64)
    ${trigLocals}${reduceTrig}
    (local.set $k (i32.add (local.get $k) (i32.const 1)))${quadrant})`)
  // tan(x) = sin(r)/cos(r) for an even quadrant, −cos(r)/sin(r) for an odd one
  wat('math.tan', `(func $math.tan (param $x f64) (result f64)
    ${trigLocals} (local $s f64) (local $c f64)${reduceTrig}
    (local.set $z (f64.mul (local.get $r) (local.get $r)))
    (local.set $s (f64.mul (local.get $r) ${horner(SIN_C, '$z')}))
    (local.set $c ${horner(COS_C, '$z')})
    (if (result f64) (i32.and (local.get $k) (i32.const 1))
      (then (f64.div (f64.neg (local.get $c)) (local.get $s)))
      (else (f64.div (local.get $s) (local.get $c)))))`)

  // Payne–Hanek for a finite |x| ≥ 2^24: the quadrant (in the low bits of the i32) and
  // r = x − n·π/2, |r| ≤ π/4. x = m·2^E with m its 53-bit significand; x·2/π mod 4 is
  // m times the 2/π bits from 2^1 down, the bits of higher weight contributing multiples
  // of 4. The 192 of them from bit E − 1 (module/math/trig-tables.js TWO_OVER_PI, a
  // word pad first so E ≥ −28 never indexes before the table) multiply m in 64-bit
  // pieces, the product kept mod 2^192: its top two bits are n mod 4, the next 128 the
  // fraction, rounded to the nearest quadrant and scaled back by π/2. Every step is
  // integer and exact up to the fraction's conversion; r lands within 1.3 ulp of the
  // true remainder (the smallest any double has, 2^-61 at x = 6381956970095103·2^797,
  // leaves the fraction's high word at least 5, so the normalization below never
  // sees it zero). No loop and no scratch memory: the table is read-only.
  const M32 = '(i64.const 0xffffffff)'
  // hi:lo = m·w for m < 2^53 (split in $mh:$ml), w < 2^64, from four 32×32 products
  const mul128 = (w, hi, lo) => `
    (local.set $ll (i64.mul (local.get $ml) (i64.and ${w} ${M32})))
    (local.set $lh (i64.mul (local.get $ml) (i64.shr_u ${w} (i64.const 32))))
    (local.set $hl (i64.mul (local.get $mh) (i64.and ${w} ${M32})))
    (local.set $mid (i64.add (i64.add (i64.shr_u (local.get $ll) (i64.const 32)) (i64.and (local.get $lh) ${M32})) (i64.and (local.get $hl) ${M32})))
    (local.set ${lo} (i64.or (i64.shl (local.get $mid) (i64.const 32)) (i64.and (local.get $ll) ${M32})))
    (local.set ${hi} (i64.add (i64.add (i64.add (i64.mul (local.get $mh) (i64.shr_u ${w} (i64.const 32)))
      (i64.shr_u (local.get $lh) (i64.const 32))) (i64.shr_u (local.get $hl) (i64.const 32))) (i64.shr_u (local.get $mid) (i64.const 32))))`
  // the 64 bits of 2/π from the window's word `off`, shifted by $sh ((v >> 1) >> (63 − sh)
  // is v >> (64 − sh) that also holds at sh = 0, where a shift by 64 would be by 0)
  const window = (off) => `(i64.or (i64.shl (i64.load offset=${off} (local.get $tb)) (local.get $sh))
      (i64.shr_u (i64.shr_u (i64.load offset=${off + 8} (local.get $tb)) (i64.const 1)) (i64.sub (i64.const 63) (local.get $sh))))`
  ctx.runtime.pio2Table = hexBytes(TWO_OVER_PI_HEX)
  wat('math.rem_pio2', `(func $math.rem_pio2 (param $x f64) (result i32 f64)
    (local $b i64) (local $e i32) (local $tb i32) (local $sh i64) (local $ml i64) (local $mh i64) (local $w i64)
    (local $ll i64) (local $lh i64) (local $hl i64) (local $mid i64) (local $a1 i64) (local $a0 i64) (local $b1 i64) (local $b0 i64)
    (local $p1 i64) (local $p2 i64) (local $fh i64) (local $fl i64) (local $s i64) (local $k i32) (local $neg i32) (local $f f64)
    (local.set $b (i64.reinterpret_f64 (local.get $x)))
    (local.set $ml (i64.or (i64.and (local.get $b) (i64.const 0xfffffffffffff)) (i64.const 0x10000000000000)))
    (local.set $mh (i64.shr_u (local.get $ml) (i64.const 32)))
    (local.set $ml (i64.and (local.get $ml) ${M32}))
    ;; E + 62, E the exponent less 1075: the window starts at word (E + 62) >> 6, bit (E + 62) & 63
    (local.set $e (i32.sub (i32.and (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const 52))) (i32.const 0x7ff)) (i32.const 1013)))
    (local.set $tb (i32.add (global.get $math.pio2_tbl) (i32.shl (i32.shr_u (local.get $e) (i32.const 6)) (i32.const 3))))
    (local.set $sh (i64.extend_i32_u (i32.and (local.get $e) (i32.const 63))))
    ;; m·(w2:w1:w0) mod 2^192 = p2:p1:a0
    (local.set $w ${window(16)})${mul128('(local.get $w)', '$a1', '$a0')}
    (local.set $w ${window(8)})${mul128('(local.get $w)', '$b1', '$b0')}
    (local.set $p1 (i64.add (local.get $a1) (local.get $b0)))
    (local.set $p2 (i64.add (i64.add (local.get $b1) (i64.mul (i64.or (i64.shl (local.get $mh) (i64.const 32)) (local.get $ml)) ${window(0)}))
      (i64.extend_i32_u (i64.lt_u (local.get $p1) (local.get $a1)))))
    ;; n mod 4 and the fraction's top 128 bits; a fraction of ½ or more takes the next quadrant
    (local.set $k (i32.wrap_i64 (i64.shr_u (local.get $p2) (i64.const 62))))
    (local.set $fh (i64.or (i64.shl (local.get $p2) (i64.const 2)) (i64.shr_u (local.get $p1) (i64.const 62))))
    (local.set $fl (i64.or (i64.shl (local.get $p1) (i64.const 2)) (i64.shr_u (local.get $a0) (i64.const 62))))
    (local.set $neg (i32.wrap_i64 (i64.shr_u (local.get $fh) (i64.const 63))))
    (if (local.get $neg)
      (then
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (local.set $fh (i64.add (i64.xor (local.get $fh) (i64.const -1)) (i64.extend_i32_u (i64.eqz (local.get $fl)))))
        (local.set $fl (i64.sub (i64.const 0) (local.get $fl)))))
    ;; |fraction| to a double: its top 64 bits normalized, scaled by 2^-(64 + s)
    (local.set $s (i64.clz (local.get $fh)))
    (local.set $f (f64.mul
      (f64.convert_i64_u (i64.or (i64.shl (local.get $fh) (local.get $s))
        (i64.shr_u (i64.shr_u (local.get $fl) (i64.const 1)) (i64.sub (i64.const 63) (local.get $s)))))
      (f64.reinterpret_i64 (i64.shl (i64.sub (i64.const 959) (local.get $s)) (i64.const 52)))))
    (local.set $f (f64.add (f64.mul (local.get $f) (f64.const ${HALF_PI})) (f64.mul (local.get $f) (f64.const ${PIO2_LO}))))
    ;; the sign: the rounding's and x's
    (if (i32.ne (local.get $neg) (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const 63))))
      (then (local.set $f (f64.neg (local.get $f)))))
    (if (i64.lt_s (local.get $b) (i64.const 0)) (then (local.set $k (i32.sub (i32.const 0) (local.get $k)))))
    (local.get $k) (local.get $f))`)

  registerMathSimd()

  // The table kernels (module/math/trig-tables.js EXP2_TAB): 2^y = 2^e · T[j] · 2^f
  // with k = round(64y), j = k mod 64, e = ⌊k/64⌋ and |f| ≤ 1/128 – f = y − k/64 is
  // exact, the two being within a factor of two. T[j] is the double nearest 2^(j/64)
  // and tail[j] the relative remainder its rounding dropped, so T + T·(q + tail) with
  // q = 2^f − 1 = f·(ln2 + f·ln2²/2 + … ) rounds once: 0.52 ulp against a 200-bit
  // reference over the whole range, at half the flops of the 14-term series over
  // |f| ≤ ½ this replaces (2 ulp). `Math.exp`, `Math.pow(2, x)`, sinh/cosh/tanh and
  // the colour cases' decode ride on these. e^x reduces on its own: k = round(64x/ln2),
  // r = (x − k·L1) − k·L2 (L1 the 36-bit head of ln2/64, so k·L1 is exact), then the
  // same table with q = e^r − 1 = r·(1 + r/2 + …) – 2^(x·log2 e) lost |x| ulp to the
  // rounding of the product (26 ulp at |x| = 40).
  ctx.runtime.exp2Table = hexBytes(EXP2_TAB_HEX)
  if (!crPow) ctx.runtime.powLogTable = hexBytes(POW_LOG_TAB_HEX)
  wat('math.exp2', `(func $math.exp2 (param $y f64) (result f64)
    (local $k i32) (local $e i32) (local $k2 i32) (local $tb i32) (local $f f64) (local $t f64) (local $p f64)
    (if (f64.ne (local.get $y) (local.get $y)) (then (return (local.get $y))))
    (if (result f64) (f64.gt (local.get $y) (f64.const 1024.0)) (then (f64.const inf)) (else
      (if (result f64) (f64.lt (local.get $y) (f64.const -1075.0)) (then (f64.const 0.0)) (else
        (local.set $k (i32.trunc_f64_s (f64.nearest (f64.mul (local.get $y) (f64.const 64.0)))))
        (local.set $f (f64.sub (local.get $y) (f64.mul (f64.convert_i32_s (local.get $k)) (f64.const 0.015625))))
        (local.set $tb (i32.add (global.get $math.exp2_tbl) (i32.shl (i32.and (local.get $k) (i32.const 63)) (i32.const 4))))
        (local.set $t (f64.load (local.get $tb)))
        (local.set $p (f64.add (local.get $t) (f64.mul (local.get $t)
          (f64.add (f64.mul (local.get $f) ${horner(EXP2_Q, '$f')}) (f64.load offset=8 (local.get $tb))))))
        (local.set $e (i32.shr_s (local.get $k) (i32.const 6)))
        ;; 2^e: one IEEE-exponent build for a normal result (the hot path); the two-factor
        ;; split (2^k2 · 2^(e−k2)) only at the denormal and overflow edges. Bit-identical
        ;; for a normal e – powers of two multiply exactly.
        (if (result f64)
          (i32.and (i32.gt_s (local.get $e) (i32.const -1023)) (i32.lt_s (local.get $e) (i32.const 1024)))
          (then (f64.mul (local.get $p)
            (f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add (local.get $e) (i32.const 1023))) (i64.const 52)))))
          (else
            (local.set $k2 (i32.shr_s (local.get $e) (i32.const 1)))
            (f64.mul (f64.mul (local.get $p)
              (f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add (local.get $k2) (i32.const 1023))) (i64.const 52))))
              (f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add (i32.sub (local.get $e) (local.get $k2)) (i32.const 1023))) (i64.const 52)))))))))))`)

  wat('math.exp', `(func $math.exp (param $x f64) (result f64)
    (local $k i32) (local $e i32) (local $k2 i32) (local $tb i32) (local $f f64) (local $t f64) (local $p f64)
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (result f64) (f64.gt (local.get $x) (f64.const 709.782712893384)) (then (f64.const inf)) (else
      (if (result f64) (f64.lt (local.get $x) (f64.const -745.1332191019412)) (then (f64.const 0.0)) (else
        (local.set $k (i32.trunc_f64_s (f64.nearest (f64.mul (local.get $x) (f64.const ${64 / Math.LN2})))))
        (local.set $t (f64.convert_i32_s (local.get $k)))
        (local.set $f (f64.sub (f64.sub (local.get $x) (f64.mul (local.get $t) (f64.const ${EXP_L1}))) (f64.mul (local.get $t) (f64.const ${EXP_L2}))))
        (local.set $tb (i32.add (global.get $math.exp2_tbl) (i32.shl (i32.and (local.get $k) (i32.const 63)) (i32.const 4))))
        (local.set $t (f64.load (local.get $tb)))
        (local.set $p (f64.add (local.get $t) (f64.mul (local.get $t)
          (f64.add (f64.mul (local.get $f) ${horner(EXP_Q, '$f')}) (f64.load offset=8 (local.get $tb))))))
        (local.set $e (i32.shr_s (local.get $k) (i32.const 6)))
        ;; 2^e: one IEEE-exponent build for a normal result (the hot path); the two-factor
        ;; split (2^k2 · 2^(e−k2)) only at the denormal and overflow edges. Bit-identical
        ;; for a normal e – powers of two multiply exactly.
        (if (result f64)
          (i32.and (i32.gt_s (local.get $e) (i32.const -1023)) (i32.lt_s (local.get $e) (i32.const 1024)))
          (then (f64.mul (local.get $p)
            (f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add (local.get $e) (i32.const 1023))) (i64.const 52)))))
          (else
            (local.set $k2 (i32.shr_s (local.get $e) (i32.const 1)))
            (f64.mul (f64.mul (local.get $p)
              (f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add (local.get $k2) (i32.const 1023))) (i64.const 52))))
              (f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add (i32.sub (local.get $e) (local.get $k2)) (i32.const 1023))) (i64.const 52)))))))))))`)

  // The shared series and the shared evaluation tree — the JS constant folder
  // walks the same ones, so a folded `Math.expm1(0.3)` and the compiled kernel
  // agree bit for bit. `$x` carries the leading factor, so the tree evaluates
  // (e^x − 1)/x and the caller multiplies once.
  const expm1Series = horner(EXPM1_C, '$x')

  wat('math.expm1', `(func $math.expm1 (param $x f64) (result f64)
    ;; expm1(x) = e^x − 1. For |x| < 0.5 sum the series directly: there e^x is within ~1.6
    ;; of 1, so exp(x)−1 cancels the leading digits (the prior naive form lost up to ~11%
    ;; near 0); the series doesn't, and the leading x·(…) preserves the sign of ±0. Larger
    ;; |x| has no cancellation, so exp(x)−1 is accurate.
    (if (result f64) (f64.lt (f64.abs (local.get $x)) (f64.const 0.5))
      (then (f64.mul (local.get $x) ${expm1Series}))
      (else (f64.sub (call $math.exp (local.get $x)) (f64.const 1.0)))))`)

  // log(x) via bit-level frexp + sqrt(2)-centered split + atanh series.
  //   x = m * 2^k   with bits-extracted k (no loop)
  //   if m >= sqrt(2): m /= 2, k += 1     so m ∈ [sqrt(2)/2, sqrt(2)) ≈ [0.707, 1.414)
  //   s = (m-1)/(m+1)                     |s| ≤ 0.172
  //   log(x) = k·ln(2) + 2s·(1 + s²/3 + s⁴/5 + ... + s¹⁶/17)
  // With 9 polynomial terms and |s|≤0.172, truncation error ≈ 2|s|·z⁹/19 ≈ 4e-17,
  // close to f64 ulp. The whole routine is branchless after edge cases.
  // Edge cases: NaN→NaN, ≤0 distinguishes 0→-Inf, <0→NaN; +Inf passes through.
  wat('math.log', `(func $math.log (param $x f64) (result f64)
    (local $bits i64) (local $k i32) (local $m f64) (local $s f64) (local $z f64)
    (if (f64.ne (local.get $x) (local.get $x))
      (then (return (local.get $x))))
    (if (f64.le (local.get $x) (f64.const 0.0))
      (then
        (if (f64.eq (local.get $x) (f64.const 0.0))
          (then (return (f64.const -inf))))
        (return (f64.const nan))))
    (if (f64.eq (local.get $x) (f64.const inf))
      (then (return (local.get $x))))
    (local.set $k (i32.const 0))
    ;; Normalize denormals (exponent=0): scale by 2^54 and remember the shift,
    ;; so the bit-extracted exponent below is meaningful for every finite x > 0.
    (if (f64.lt (local.get $x) (f64.const 0x1p-1022))
      (then
        (local.set $x (f64.mul (local.get $x) (f64.const 0x1p54)))
        (local.set $k (i32.const -54))))
    ;; frexp via bit twiddling: k = ((bits >> 52) & 0x7ff) - 1023, then force exp=1023 so m ∈ [1,2).
    (local.set $bits (i64.reinterpret_f64 (local.get $x)))
    (local.set $k (i32.add (local.get $k) (i32.sub
                    (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const 52)) (i64.const 0x7ff)))
                    (i32.const 1023))))
    (local.set $m (f64.reinterpret_i64
                    (i64.or
                      (i64.and (local.get $bits) (i64.const 0x000fffffffffffff))
                      (i64.const 0x3ff0000000000000))))
    ;; Center on sqrt(2) to shrink |s| from 1/3 down to ~0.172.
    (if (f64.ge (local.get $m) (f64.const 1.4142135623730951))
      (then
        (local.set $m (f64.mul (local.get $m) (f64.const 0.5)))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))))
    ;; s = (m−1)/(m+1)  (|s| ≤ 3−2√2 ≈ 0.172); log(m) = 2s·(1 + z·G(z)), z = s², G a degree-3
    ;; minimax in z (Remez, equioscillation 5.8e-10). One short Horner replaces fdlibm's 7-term
    ;; even/odd split — ~40% fewer ops, max rel err 1.7e-11 (jz transcendentals target ~1e-9).
    (local.set $s (f64.div (f64.sub (local.get $m) (f64.const 1.0)) (f64.add (local.get $m) (f64.const 1.0))))
    (local.set $z (f64.mul (local.get $s) (local.get $s)))
    (f64.add
      (f64.mul (f64.convert_i32_s (local.get $k)) (f64.const ${Math.LN2}))
      (f64.mul (f64.mul (f64.const 2.0) (local.get $s)) ${horner(LOG_C, '$z')})))`)

  wat('math.log2', `(func $math.log2 (param $x f64) (result f64)
    (f64.div (call $math.log (local.get $x)) (f64.const ${Math.LN2})))`)

  // log10 via fdlibm's two-term decomposition: log10(x) = k*log10(2) + log10(m).
  // A plain log(x)/ln(10) double-rounds (rounding of log itself, then of the
  // divide), so exact powers of ten drift — log10(1000) lands on 2.9999…996.
  // Reducing x = m·2^k, splitting log10(2) and 1/ln(10) into hi/lo halves, and
  // keeping the bulk term (k·log10_2hi, hi·ivln10hi) carry-free recovers the
  // last ulps, so log10(10/100/1000/…) round-trips to exact integers.
  wat('math.log10', `(func $math.log10 (param $x f64) (result f64)
    (local $bits i64) (local $k i32) (local $m f64) (local $f f64)
    (local $hfsq f64) (local $s f64) (local $z f64) (local $w f64)
    (local $t1 f64) (local $t2 f64) (local $R f64)
    (local $hi f64) (local $lo f64) (local $dk f64)
    (local $valhi f64) (local $vallo f64) (local $y f64)
    ;; Special values: NaN→NaN, x≤0 → (-inf for 0, NaN for negative), +inf→+inf.
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (f64.le (local.get $x) (f64.const 0.0))
      (then
        (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (f64.const -inf))))
        (return (f64.const nan))))
    (if (f64.eq (local.get $x) (f64.const inf)) (then (return (local.get $x))))
    ;; Normalize subnormals so the bit-extracted exponent is meaningful.
    (local.set $k (i32.const 0))
    (if (f64.lt (local.get $x) (f64.const 0x1p-1022))
      (then
        (local.set $x (f64.mul (local.get $x) (f64.const 0x1p54)))
        (local.set $k (i32.const -54))))
    ;; frexp: k += exponent, m = mantissa forced into [1,2).
    (local.set $bits (i64.reinterpret_f64 (local.get $x)))
    (local.set $k (i32.add (local.get $k) (i32.sub
                    (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const 52)) (i64.const 0x7ff)))
                    (i32.const 1023))))
    (local.set $m (f64.reinterpret_i64
                    (i64.or (i64.and (local.get $bits) (i64.const 0x000fffffffffffff))
                            (i64.const 0x3ff0000000000000))))
    ;; Center on sqrt(2): m ∈ [sqrt2/2, sqrt2) keeps the kernel argument small.
    (if (f64.ge (local.get $m) (f64.const 1.4142135623730951))
      (then
        (local.set $m (f64.mul (local.get $m) (f64.const 0.5)))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))))
    ;; log(m) kernel: f - hfsq + s*(hfsq+R), s = f/(2+f), polynomial in s².
    (local.set $f (f64.sub (local.get $m) (f64.const 1.0)))
    (local.set $hfsq (f64.mul (f64.const 0.5) (f64.mul (local.get $f) (local.get $f))))
    (local.set $s (f64.div (local.get $f) (f64.add (f64.const 2.0) (local.get $f))))
    (local.set $z (f64.mul (local.get $s) (local.get $s)))
    (local.set $w (f64.mul (local.get $z) (local.get $z)))
    (local.set $t1 (f64.mul (local.get $w) (f64.add (f64.const 0.3999999999940942)
      (f64.mul (local.get $w) (f64.add (f64.const 0.22222198432149792)
        (f64.mul (local.get $w) (f64.const 0.15313837699209373)))))))
    (local.set $t2 (f64.mul (local.get $z) (f64.add (f64.const 0.6666666666666735)
      (f64.mul (local.get $w) (f64.add (f64.const 0.2857142874366239)
        (f64.mul (local.get $w) (f64.add (f64.const 0.1818357216161805)
          (f64.mul (local.get $w) (f64.const 0.14798198605116586)))))))))
    (local.set $R (f64.add (local.get $t2) (local.get $t1)))
    ;; hi = high 32 bits of (f - hfsq); lo = the carry-free remainder.
    (local.set $hi (f64.sub (local.get $f) (local.get $hfsq)))
    (local.set $hi (f64.reinterpret_i64
      (i64.and (i64.reinterpret_f64 (local.get $hi)) (i64.const 0xffffffff00000000))))
    (local.set $lo (f64.add
      (f64.sub (f64.sub (local.get $f) (local.get $hi)) (local.get $hfsq))
      (f64.mul (local.get $s) (f64.add (local.get $hfsq) (local.get $R)))))
    ;; Combine with k·log10(2): bulk in val_hi, corrections in val_lo.
    (local.set $valhi (f64.mul (local.get $hi) (f64.const 0.4342944818781689)))
    (local.set $dk (f64.convert_i32_s (local.get $k)))
    (local.set $y (f64.mul (local.get $dk) (f64.const 0.30102999566361177)))
    (local.set $vallo (f64.add (f64.add
      (f64.mul (local.get $dk) (f64.const 3.694239077158931e-13))
      (f64.mul (f64.add (local.get $lo) (local.get $hi)) (f64.const 2.5082946711645275e-11)))
      (f64.mul (local.get $lo) (f64.const 0.4342944818781689))))
    (local.set $w (f64.add (local.get $y) (local.get $valhi)))
    (local.set $vallo (f64.add (local.get $vallo)
      (f64.add (f64.sub (local.get $y) (local.get $w)) (local.get $valhi))))
    (f64.add (local.get $vallo) (local.get $w)))`)

  // log1p(x) via Kahan's compensated trick: with u = 1+x, log(u) loses bits when x is
  // small (because u rounds to ~1), but the ratio x/(u-1) is exactly the missing factor.
  // For u==1 (x below ulp), result is just x; preserves -0 from x=-0 path. The ratio is
  // taken first: log(u)·x overflowed to Infinity for x past 2.5e305. x ≤ −1 and NaN
  // answer before any arithmetic (−Infinity at −1, the canonical NaN otherwise).
  wat('math.log1p', `(func $math.log1p (param $x f64) (result f64)
    (local $u f64)
    (if (i32.eqz (f64.gt (local.get $x) (f64.const -1)))
      (then (return (select (f64.const -inf) (f64.const nan) (f64.eq (local.get $x) (f64.const -1))))))
    ;; log1p(+Inf) = +Inf: the ratio below would compute Inf/Inf = NaN.
    (if (f64.eq (local.get $x) (f64.const inf)) (then (return (f64.const inf))))
    (local.set $u (f64.add (f64.const 1.0) (local.get $x)))
    (if (f64.eq (local.get $u) (f64.const 1.0))
      (then (return (local.get $x))))
    (f64.mul (call $math.log (local.get $u)) (f64.div (local.get $x) (f64.sub (local.get $u) (f64.const 1.0)))))`)


  // The entire correctly-rounded kernel below (codegen helpers, breakpoint tables, and the
  // $math.pow_transcend registration itself) is built and registered ONLY when `optimize.crPow`
  // is set — see the authoritative crPow/approxPow comment above `emitPow` for why it's opt-in
  // (honest cost: ~13x the old fold's runtime on gamma-heavy color kernels). Gating the whole
  // section (not just the wat() registration) means a plain build pays zero JS-side cost for
  // table-hex construction / codegen generation, and $math.pow_transcend never enters
  // ctx.core.stdlib at all — so it can't accidentally leak into a default-build's includes set.
  if (crPow) {
  registerPowTranscend()
  } // if (crPow)

  wat('math.pow', `(func $math.pow (param $x f64) (param $y f64) (result f64)
    (local $result f64) (local $n i32) (local $neg_base i32) (local $abs_x f64)
    ;; the common case first: a positive finite x and a finite non-integer y (a NaN
    ;; fails every compare) go straight to the kernel, which takes x = 1 (log 0) and
    ;; y = 0.5 (a sqrt) itself; everything else walks the ladder below
    (local.set $abs_x (f64.abs (local.get $y)))
    (if (i32.and (i32.and (f64.gt (local.get $x) (f64.const 0.0)) (f64.lt (local.get $x) (f64.const inf)))
                 (i32.and (f64.lt (local.get $abs_x) (f64.const ${2 ** 63})) (f64.ne (f64.nearest (local.get $abs_x)) (local.get $abs_x))))
      (then (return (call $math.pow_core (local.get $x) (local.get $y)))))
    ;; y == 0 -> 1 (covers pow(NaN,0), pow(±0,0), pow(±Inf,0))
    (if (f64.eq (local.get $y) (f64.const 0.0)) (then (return (f64.const 1.0))))
    ;; y is NaN -> NaN
    (if (f64.ne (local.get $y) (local.get $y)) (then (return (local.get $y))))
    ;; x is NaN -> NaN
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    ;; y is ±Infinity
    (if (f64.eq (f64.abs (local.get $y)) (f64.const inf))
      (then
        (local.set $abs_x (f64.abs (local.get $x)))
        (if (f64.eq (local.get $abs_x) (f64.const 1.0))
          (then (return (f64.const nan))))
        (if (i32.eq (f64.gt (local.get $abs_x) (f64.const 1.0))
                    (f64.gt (local.get $y) (f64.const 0.0)))
          (then (return (f64.const inf)))
          (else (return (f64.const 0.0))))))
    ;; x == 1 -> 1 (after y=±Inf check, so 1**Inf already returned NaN)
    (if (f64.eq (local.get $x) (f64.const 1.0)) (then (return (f64.const 1.0))))
    ;; y == 1 -> x (preserves -0 for (-0)**1)
    (if (f64.eq (local.get $y) (f64.const 1.0)) (then (return (local.get $x))))
    ;; integer fast path, |y| ≤ 16: the square-and-multiply the constant-exponent
    ;; lowering uses (emitPow's foldPow), so x ** 16 and x ** y at y = 16 agree
    ;; bit for bit; a longer chain drifts by its length (x^1000 by 49 ulp), so every
    ;; other integer takes the kernel below, within an ulp of the true value.
    ;; A negative y squares the reciprocal: 1/x^n overflowed to 0 where x^-n is
    ;; still a double (5.67e102 ** -3 is 5.5e-309).
    ;; Also covers ±Infinity x: 1/Inf = 0 through the loop,
    ;; with neg_base (x<0 && odd y) producing -0 — required for (-Inf)**-odd.
    ;; Runs before the x==0 fallback so (-0)**oddInt correctly returns ∓0/∓Inf.
    (if (i32.and
          (f64.eq (f64.nearest (local.get $y)) (local.get $y))
          (f64.le (f64.abs (local.get $y)) (f64.const 16.0)))
      (then
        (local.set $abs_x (f64.abs (local.get $x)))
        (if (f64.lt (local.get $y) (f64.const 0.0))
          (then (local.set $abs_x (f64.div (f64.const 1.0) (local.get $abs_x)))))
        ;; copysign(1, x) gives -1 for any x with sign bit set (incl. -0); f64.lt picks that up.
        (local.set $neg_base (i32.and (f64.lt (f64.copysign (f64.const 1.0) (local.get $x)) (f64.const 0.0))
                                      (i32.and (i32.trunc_f64_s (local.get $y)) (i32.const 1))))
        (local.set $n (i32.trunc_f64_s (f64.abs (local.get $y))))
        (local.set $result (f64.const 1.0))
        (block $done
          (loop $loop
            (br_if $done (i32.le_s (local.get $n) (i32.const 0)))
            (if (i32.and (local.get $n) (i32.const 1))
              (then (local.set $result (f64.mul (local.get $result) (local.get $abs_x)))))
            (local.set $abs_x (f64.mul (local.get $abs_x) (local.get $abs_x)))
            (local.set $n (i32.shr_s (local.get $n) (i32.const 1)))
            (br $loop)))
        (if (local.get $neg_base)
          (then (local.set $result (f64.neg (local.get $result)))))
        (return (local.get $result))))
    ;; x is ±Infinity with |y| > 16 (the fast path above handles smaller y):
    ;; magnitude is Inf for y>0, 0 for y<0; sign is negative only when x is -Inf
    ;; and y is an odd integer. Odd-ness is tested in f64 (y, y/2 both integral)
    ;; to avoid an i32.trunc trap on |y| beyond i32 range.
    (if (f64.eq (f64.abs (local.get $x)) (f64.const inf))
      (then
        (local.set $result
          (select (f64.const inf) (f64.const 0.0) (f64.gt (local.get $y) (f64.const 0.0))))
        (if (i32.and (f64.lt (local.get $x) (f64.const 0.0))
                     (i32.and (f64.eq (f64.nearest (local.get $y)) (local.get $y))
                              (f64.ne (f64.nearest (f64.mul (local.get $y) (f64.const 0.5)))
                                      (f64.mul (local.get $y) (f64.const 0.5)))))
          (then (local.set $result (f64.neg (local.get $result)))))
        (return (local.get $result))))
    ;; x == ±0: y<0 ? Infinity : 0, negative for -0 and an odd integer y (|y| > 16 here)
    (if (f64.eq (local.get $x) (f64.const 0.0))
      (then
        (local.set $result (select (f64.const inf) (f64.const 0.0) (f64.lt (local.get $y) (f64.const 0.0))))
        (return (select (f64.neg (local.get $result)) (local.get $result)
          (i32.and (f64.lt (f64.copysign (f64.const 1.0) (local.get $x)) (f64.const 0.0))
                   (i32.and (f64.eq (f64.nearest (local.get $y)) (local.get $y))
                            (f64.ne (f64.nearest (f64.mul (local.get $y) (f64.const 0.5))) (f64.mul (local.get $y) (f64.const 0.5)))))))))
    ;; x < 0: a non-integer finite y -> NaN; an integer y beyond the fast path
    ;; takes |x| and, for an odd y, the sign (every |y| ≥ 2^53 is even)
    (if (f64.lt (local.get $x) (f64.const 0.0))
      (then
        (if (f64.ne (f64.nearest (local.get $y)) (local.get $y)) (then (return (f64.const nan))))
        (local.set $result (call $math.pow_core (f64.neg (local.get $x)) (local.get $y)))
        (return (select (f64.neg (local.get $result)) (local.get $result)
          (f64.ne (f64.nearest (f64.mul (local.get $y) (f64.const 0.5))) (f64.mul (local.get $y) (f64.const 0.5)))))))
    ;; Remaining case: x > 0 finite (≠1), y finite (≠0, ≠1), no integer of |y| ≤ 16.
    ;; $math.pow_core below is within 0.54 ulp by default (a double-double log, see its
    ;; comment), or — under optimize.crPow — CORRECTLY ROUNDED in the CORE-MATH sense
    ;; (two-phase Ziv dd/td kernel, see $math.pow_transcend's comment).
    (call $math.pow_core (local.get $x) (local.get $y)))`)

  // scalbn(x, n) = x * 2^n, correctly rounded even when the result lands in the subnormal
  // range (a single f64.mul by a bit-constructed 2^n would double-round there). Ported from
  // musl's src/math/scalbn.c (MIT — https://git.musl-libc.org/cgit/musl/tree/src/math/scalbn.c,
  // also FreeBSD msun's scalbn.c): splitting the scale into two safe steps, each within the
  // exact power-of-two range, avoids that double rounding. Only reached from $math.pow_core's
  // subnormal-result tail, where |n| stays well under 1075 — the >1023 branch and the doubly-
  // nested steps are dead there but kept for fidelity with the reference.
  wat('math.pow_scalbn', `(func $math.pow_scalbn (param $x f64) (param $n i32) (result f64)
    (local $y f64)
    (local.set $y (local.get $x))
    (if (i32.gt_s (local.get $n) (i32.const 1023))
      (then
        (local.set $y (f64.mul (local.get $y) (f64.const 0x1p1023)))
        (local.set $n (i32.sub (local.get $n) (i32.const 1023)))
        (if (i32.gt_s (local.get $n) (i32.const 1023))
          (then
            (local.set $y (f64.mul (local.get $y) (f64.const 0x1p1023)))
            (local.set $n (i32.sub (local.get $n) (i32.const 1023)))
            (if (i32.gt_s (local.get $n) (i32.const 1023)) (then (local.set $n (i32.const 1023)))))))
      (else (if (i32.lt_s (local.get $n) (i32.const -1022))
        (then
          (local.set $y (f64.mul (local.get $y) (f64.mul (f64.const 0x1p-1022) (f64.const 0x1p53))))
          (local.set $n (i32.add (local.get $n) (i32.const 969))) ;; 1022-53, staged to dodge subnormal double-rounding
          (if (i32.lt_s (local.get $n) (i32.const -1022))
            (then
              (local.set $y (f64.mul (local.get $y) (f64.mul (f64.const 0x1p-1022) (f64.const 0x1p53))))
              (local.set $n (i32.add (local.get $n) (i32.const 969)))
              (if (i32.lt_s (local.get $n) (i32.const -1022)) (then (local.set $n (i32.const -1022))))))))))
    (f64.mul (local.get $y)
      (f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add (local.get $n) (i32.const 1023))) (i64.const 52)))))`)

  // x**y for the case the ladder above can't fast-path: x > 0 finite, y finite and not an
  // integer of magnitude ≤ 16 (the common case enters here first, before the ladder). y==0.5 is
  // always special-cased to hardware sqrt (correctly rounded, cheaper than either general kernel
  // below) regardless of crPow. Two kernels, picked by `optimize.crPow` (see the authoritative
  // comment above `emitPow` for the flag's full semantics and the measured cost of switching):
  //   OFF (DEFAULT): Arm's optimized-routines pow (Szabolcs Nagy, 2018; MIT OR Apache-2.0 WITH
  //     LLVM-exception — https://github.com/ARM-software/optimized-routines/blob/master/math/
  //     pow.c), the algorithm glibc, musl and LLVM's libc ship: log(x) as a double-double from
  //     a 128-entry table of (1/c, log c) by the top mantissa bits (scripts/pow-log-table.mjs
  //     derives it from the same 200-bit arithmetic and checks it against pow_log_data.c), a
  //     degree-7 polynomial on the residual, y·log(x) as an exact split product, then jz's own
  //     exp table for 2^(k/64). Documented worst case 0.54 ulp; measured against the host's
  //     Math.pow it is bit-exact on 648 of 660 grid points and one ulp off on the rest
  //     (V8 ports fdlibm's e_pow.c, "nearly rounded" itself, so an occasional last-ulp
  //     difference between two sub-ulp kernels is expected). The template's own comment walks
  //     the steps; the JS twin in src/prepare/math-kernel.js (powCore) folds constants to the
  //     same bits.
  //   ON: delegates to the shared two-phase Ziv dd/td kernel — see $math.pow_transcend's own
  //     comment above for the algorithm. CORE-MATH-class correctly rounded (0 misrounds on the
  //     5152-vector gate, test/pow-cr.js) at a measured 8× the default kernel's cost per call,
  //     hence opt-in rather than default.
  wat('math.pow_core', crPow
    ? `(func $math.pow_core (param $x f64) (param $y f64) (result f64)
    (if (f64.eq (local.get $y) (f64.const 0.5))
      (then (return (f64.sqrt (local.get $x)))))
    (call $math.pow_transcend (local.get $x) (local.get $y)))`
    : `(func $math.pow_core (param $x f64) (param $y f64) (result f64)
    ;; x > 0 finite (≠1), y finite (≠0, ≠1) and no i32-range integer: x^y = exp(y·log(x))
    ;; with log(x) carried as a double-double, so a large y loses nothing to the
    ;; rounding of log(x) alone. Arm's optimized-routines pow (Szabolcs Nagy; MIT OR
    ;; Apache-2.0 WITH LLVM-exception) on jz's own exponential table: within 0.54 ulp,
    ;; ~40 flops and two table loads, no branch on the common path.
    ;;
    ;;   log(x) = k·ln2 + log(c) + log1p(z/c − 1)   x = 2^k·z, z ∈ [OFF, 2·OFF), c from the
    ;;   table by z's top mantissa bits, r = z/c − 1 exact (z split at 32 bits), the
    ;;   polynomial on |r| < 2^-7, the sum kept as hi + lo;
    ;;   y·(hi + lo) = ehi + elo with the factors split at 27 bits, so yhi·lhi is exact;
    ;;   exp(ehi + elo) = 2^(k/64)·(1 + tail + (e^f − 1)), f = ehi − k·ln2/64 + elo.
    (local $ix i64) (local $tmp i64) (local $sbits i64) (local $i i32) (local $k i32) (local $tb i32) (local $e i32)
    (local $z f64) (local $kd f64) (local $invc f64) (local $logc f64) (local $logctail f64)
    (local $zhi f64) (local $zlo f64) (local $rhi f64) (local $rlo f64) (local $r f64)
    (local $t1 f64) (local $t2 f64) (local $lo1 f64) (local $lo2 f64) (local $ar f64) (local $ar2 f64) (local $ar3 f64)
    (local $arhi f64) (local $arhi2 f64) (local $hi f64) (local $lo3 f64) (local $lo4 f64) (local $p f64) (local $lo f64) (local $lg f64) (local $tail f64)
    (local $yhi f64) (local $ylo f64) (local $lhi f64) (local $llo f64) (local $ehi f64) (local $elo f64)
    (local $ax f64) (local $f f64) (local $t f64) (local $q f64) (local $scale f64) (local $res f64) (local $one f64)
    ;; y == 0.5 exactly (x > 0): f64.sqrt is correctly rounded
    (if (f64.eq (local.get $y) (f64.const 0.5)) (then (return (f64.sqrt (local.get $x)))))
    ;; |y| < 2^-65: x^y = 1 + y·log(x) rounds to the double next to 1 on y's side of it
    ;; |y| ≥ 2^63: an even integer, an overflow or an underflow by the sides of 1 x and y are
    ;; on, 1 at x = 1 (the ladder's x = −1 arrives here as 1)
    (local.set $ax (f64.abs (local.get $y)))
    (if (f64.lt (local.get $ax) (f64.const ${2 ** -65}))
      (then (return (select (f64.add (f64.const 1.0) (local.get $y)) (f64.sub (f64.const 1.0) (local.get $y)) (f64.gt (local.get $x) (f64.const 1.0))))))
    (if (f64.ge (local.get $ax) (f64.const ${2 ** 63}))
      (then (return (select (f64.const 1.0)
        (select (f64.const inf) (f64.const 0.0) (i32.eq (f64.gt (local.get $x) (f64.const 1.0)) (f64.gt (local.get $y) (f64.const 0.0))))
        (f64.eq (local.get $x) (f64.const 1.0))))))
    ;; a subnormal x scales by 2^52, its exponent read 52 lower
    (local.set $ix (i64.reinterpret_f64 (local.get $x)))
    (if (i64.lt_u (local.get $ix) (i64.const 0x0010000000000000))
      (then (local.set $ix (i64.sub (i64.reinterpret_f64 (f64.mul (local.get $x) (f64.const 4503599627370496.0))) (i64.const 0x0340000000000000)))))
    (local.set $tmp (i64.sub (local.get $ix) (i64.const 0x3fe6955500000000)))
    (local.set $i (i32.and (i32.wrap_i64 (i64.shr_u (local.get $tmp) (i64.const 45))) (i32.const 127)))
    (local.set $k (i32.wrap_i64 (i64.shr_s (local.get $tmp) (i64.const 52))))
    (local.set $z (f64.reinterpret_i64 (i64.sub (local.get $ix) (i64.and (local.get $tmp) (i64.const 0xfff0000000000000)))))
    (local.set $kd (f64.convert_i32_s (local.get $k)))
    (local.set $tb (i32.add (global.get $math.pow_log_tbl) (i32.mul (local.get $i) (i32.const 24))))
    (local.set $invc (f64.load (local.get $tb)))
    (local.set $logc (f64.load offset=8 (local.get $tb)))
    (local.set $logctail (f64.load offset=16 (local.get $tb)))
    (local.set $zhi (f64.reinterpret_i64 (i64.and (i64.add (i64.reinterpret_f64 (local.get $z)) (i64.const 0x80000000)) (i64.const 0xffffffff00000000))))
    (local.set $zlo (f64.sub (local.get $z) (local.get $zhi)))
    (local.set $rhi (f64.sub (f64.mul (local.get $zhi) (local.get $invc)) (f64.const 1.0)))
    (local.set $rlo (f64.mul (local.get $zlo) (local.get $invc)))
    (local.set $r (f64.add (local.get $rhi) (local.get $rlo)))
    (local.set $t1 (f64.add (f64.mul (local.get $kd) (f64.const ${POW_LN2HI})) (local.get $logc)))
    (local.set $t2 (f64.add (local.get $t1) (local.get $r)))
    (local.set $lo1 (f64.add (f64.mul (local.get $kd) (f64.const ${POW_LN2LO})) (local.get $logctail)))
    (local.set $lo2 (f64.add (f64.sub (local.get $t1) (local.get $t2)) (local.get $r)))
    (local.set $ar (f64.mul (f64.const ${POW_LOG_A[0]}) (local.get $r)))
    (local.set $ar2 (f64.mul (local.get $r) (local.get $ar)))
    (local.set $ar3 (f64.mul (local.get $r) (local.get $ar2)))
    (local.set $arhi (f64.mul (f64.const ${POW_LOG_A[0]}) (local.get $rhi)))
    (local.set $arhi2 (f64.mul (local.get $rhi) (local.get $arhi)))
    (local.set $hi (f64.add (local.get $t2) (local.get $arhi2)))
    (local.set $lo3 (f64.mul (local.get $rlo) (f64.add (local.get $ar) (local.get $arhi))))
    (local.set $lo4 (f64.add (f64.sub (local.get $t2) (local.get $hi)) (local.get $arhi2)))
    (local.set $p (f64.mul (local.get $ar3)
      (f64.add (f64.const ${POW_LOG_A[1]}) (f64.add (f64.mul (local.get $r) (f64.const ${POW_LOG_A[2]}))
        (f64.mul (local.get $ar2) (f64.add (f64.const ${POW_LOG_A[3]}) (f64.add (f64.mul (local.get $r) (f64.const ${POW_LOG_A[4]}))
          (f64.mul (local.get $ar2) (f64.add (f64.const ${POW_LOG_A[5]}) (f64.mul (local.get $r) (f64.const ${POW_LOG_A[6]})))))))))))
    (local.set $lo (f64.add (f64.add (f64.add (f64.add (local.get $lo1) (local.get $lo2)) (local.get $lo3)) (local.get $lo4)) (local.get $p)))
    (local.set $lg (f64.add (local.get $hi) (local.get $lo)))
    (local.set $tail (f64.add (f64.sub (local.get $hi) (local.get $lg)) (local.get $lo)))
    (local.set $yhi (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $y)) (i64.const 0xfffffffff8000000))))
    (local.set $ylo (f64.sub (local.get $y) (local.get $yhi)))
    (local.set $lhi (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $lg)) (i64.const 0xfffffffff8000000))))
    (local.set $llo (f64.add (f64.sub (local.get $lg) (local.get $lhi)) (local.get $tail)))
    (local.set $ehi (f64.mul (local.get $yhi) (local.get $lhi)))
    (local.set $elo (f64.add (f64.mul (local.get $ylo) (local.get $lhi)) (f64.mul (local.get $y) (local.get $llo))))
    ;; exp(ehi + elo)
    (local.set $ax (f64.abs (local.get $ehi)))
    (if (f64.lt (local.get $ax) (f64.const ${2 ** -54}))
      (then (return (f64.add (f64.const 1.0) (local.get $ehi)))))
    (if (f64.ge (local.get $ax) (f64.const 1024.0))
      (then (return (select (f64.const 0.0) (f64.const inf) (f64.lt (local.get $ehi) (f64.const 0.0))))))
    (local.set $k (i32.trunc_f64_s (f64.nearest (f64.mul (local.get $ehi) (f64.const ${64 / Math.LN2})))))
    (local.set $kd (f64.convert_i32_s (local.get $k)))
    (local.set $f (f64.add (f64.sub (f64.sub (local.get $ehi) (f64.mul (local.get $kd) (f64.const ${EXP_L1}))) (f64.mul (local.get $kd) (f64.const ${EXP_L2}))) (local.get $elo)))
    (local.set $tb (i32.add (global.get $math.exp2_tbl) (i32.shl (i32.and (local.get $k) (i32.const 63)) (i32.const 4))))
    (local.set $t (f64.load (local.get $tb)))
    (local.set $q (f64.add (f64.load offset=8 (local.get $tb)) (f64.mul (local.get $f) ${horner(EXP_Q, '$f')})))
    (local.set $e (i32.shr_s (local.get $k) (i32.const 6)))
    (local.set $sbits (i64.add (i64.reinterpret_f64 (local.get $t)) (i64.shl (i64.extend_i32_s (local.get $e)) (i64.const 52))))
    ;; |ehi| < 512: the scale's exponent is in range, one rounding
    (if (f64.lt (local.get $ax) (f64.const 512.0))
      (then
        (local.set $scale (f64.reinterpret_i64 (local.get $sbits)))
        (return (f64.add (local.get $scale) (f64.mul (local.get $scale) (local.get $q))))))
    ;; the result may overflow (k ≥ 0) or underflow (k < 0): scale in two steps
    (if (i32.ge_s (local.get $k) (i32.const 0))
      (then
        (local.set $scale (f64.reinterpret_i64 (i64.sub (local.get $sbits) (i64.const 0x3f10000000000000))))
        (return (f64.mul (f64.add (local.get $scale) (f64.mul (local.get $scale) (local.get $q))) (f64.const ${2 ** 1009})))))
    (local.set $scale (f64.reinterpret_i64 (i64.add (local.get $sbits) (i64.const 0x3fe0000000000000))))
    (local.set $res (f64.add (local.get $scale) (f64.mul (local.get $scale) (local.get $q))))
    ;; a subnormal result: round to its precision before the scale, so it rounds once
    (if (f64.lt (f64.abs (local.get $res)) (f64.const 1.0))
      (then
        (local.set $one (select (f64.const -1.0) (f64.const 1.0) (f64.lt (local.get $res) (f64.const 0.0))))
        (local.set $lo (f64.add (f64.sub (local.get $scale) (local.get $res)) (f64.mul (local.get $scale) (local.get $q))))
        (local.set $hi (f64.add (local.get $one) (local.get $res)))
        (local.set $lo (f64.add (f64.add (f64.sub (local.get $one) (local.get $hi)) (local.get $res)) (local.get $lo)))
        (local.set $res (f64.sub (f64.add (local.get $hi) (local.get $lo)) (local.get $one)))))
    (f64.mul (local.get $res) (f64.const ${2 ** -1022})))`,
    crPow ? ['math.pow_transcend'] : [])

  // $math.pow_fold — Math.pow(x, C) for a COMPILE-TIME-CONSTANT non-integer exponent C under
  // optimize.crPow (module/math.js's emitPow const-exponent fold, and its SIMD twin
  // $math.pow_fold_v above / src/optimize/vectorize.js's PPC_CALL2 entry) — see the authoritative
  // comment above emitPow for the flag's full semantics. Off crPow, emitPow lowers the same
  // constant-exponent case to exp(c·log(x)) directly (no separate wat function); this one is
  // registered ONLY when crPow is on. Shares $math.pow_transcend's kernel with $math.pow_core —
  // see that function's comment for the algorithm; c needs no hi/lo pre-split (the kernel's
  // multiply is twoProd-based, Dekker-splitting both operands internally). Bypasses the
  // $math.pow wrapper's special-case ladder, so it replicates only the x-dependent slice of it
  // here (NaN/±Inf/±0/x<0) — the y-dependent branches (y==0/NaN/±Inf/±1, integer y) are ALL
  // statically dead, since emitPow only reaches this fold when c is a finite literal that is
  // none of those. x==1 needs no case either: log2(1) evaluates to exactly 0 (dd) for any c
  // (verified by the differential test), so the result is exactly 1.0.
  if (crPow) {
    wat('math.pow_fold', `(func $math.pow_fold (param $x f64) (param $c f64) (result f64)
    ;; NaN propagates (return x itself, preserving payload bits — same as $math.pow's own
    ;; NaN checks: no arithmetic runs, so nothing mints a non-canonical NaN).
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    ;; |x| == Infinity: magnitude is c>0 ? Inf : 0, UNSIGNED — c is never an odd integer here
    ;; (emitPow's guard excludes every integer c), so the sign never flips, matching
    ;; Math.pow(±Infinity, non-integer c) exactly.
    (if (f64.eq (f64.abs (local.get $x)) (f64.const inf))
      (then (return (select (f64.const inf) (f64.const 0.0) (f64.gt (local.get $c) (f64.const 0.0))))))
    ;; x == ±0: the reciprocal selection (c<0 ? Inf : 0), also unsigned for the same reason.
    (if (f64.eq (local.get $x) (f64.const 0.0))
      (then (return (select (f64.const inf) (f64.const 0.0) (f64.lt (local.get $c) (f64.const 0.0))))))
    ;; x < 0 with non-integer c → NaN (matches $math.pow's own x<0 branch).
    (if (f64.lt (local.get $x) (f64.const 0.0)) (then (return (f64.const nan))))
    (call $math.pow_transcend (local.get $x) (local.get $c)))`, ['math.pow_transcend'])
  } // if (crPow)

  // atan: on |x|, three intervals and at most one division: |x| ≤ tan(π/8) as it is,
  // up to tan(3π/8) as π/4 + atan((|x| − 1)/(|x| + 1)), past it as π/2 + atan(−1/|x|),
  // each argument within tan(π/8); then r·(1 + t·A(t)) (trig-tables.js ATAN_C, 8.8 ulp
  // minimax), and x's sign. ±0 stays itself, ±Infinity takes −1/∞ = −0 to ±π/2.
  wat('math.atan', `(func $math.atan (param $x f64) (result f64)
    (local $a f64) (local $t f64) (local $o f64) (local $z f64)
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (local.set $a (f64.abs (local.get $x)))
    (if (f64.le (local.get $a) (f64.const ${Math.SQRT2 - 1}))
      (then (local.set $t (local.get $a)))
      (else (if (f64.le (local.get $a) (f64.const ${Math.SQRT2 + 1}))
        (then
          (local.set $t (f64.div (f64.sub (local.get $a) (f64.const 1)) (f64.add (local.get $a) (f64.const 1))))
          (local.set $o (f64.const ${PI / 4})))
        (else
          (local.set $t (f64.div (f64.const -1) (local.get $a)))
          (local.set $o (f64.const ${HALF_PI}))))))
    (local.set $z (f64.mul (local.get $t) (local.get $t)))
    (f64.copysign (f64.add (local.get $o) (f64.mul (local.get $t) ${horner(ATAN_C, '$z')})) (local.get $x)))`)

  // asin and acos on |x| ≤ ½ take asin(a) = a·(1 + t·S(t)) (trig-tables.js ASIN_C, 33 ulp
  // minimax) at a = x; past ½ at a = √((1 − |x|)/2) (1 − |x| exact there), with
  // asin(|x|) = π/2 − 2·asin(a) and acos(x) = 2·asin(a), or π − 2·asin(a) below −½: no
  // cancellation near ±1, where acos(x) = π/2 − asin(x) lost every digit of a small
  // result. Both halves select rather than branch (the root is cheap beside a miss on
  // arguments that straddle ½). |x| > 1 and NaN give the canonical NaN.
  const asinK = (a) => `
    (local.set $z (f64.mul (local.get ${a}) (local.get ${a})))
    (local.set $s (f64.mul (local.get ${a}) ${horner(ASIN_C, '$z')}))`
  const halfAngle = `
    (local.set $h (f64.gt (local.get $a) (f64.const 0.5)))
    (local.set $a (select (f64.sqrt (f64.mul (f64.const 0.5) (f64.sub (f64.const 1) (local.get $a)))) (local.get $a) (local.get $h)))`
  wat('math.asin', `(func $math.asin (param $x f64) (result f64)
    (local $a f64) (local $z f64) (local $s f64) (local $h i32)
    (local.set $a (f64.abs (local.get $x)))
    (if (i32.eqz (f64.le (local.get $a) (f64.const 1))) (then (return (f64.const nan))))${halfAngle}${asinK('$a')}
    (f64.copysign (select (f64.sub (f64.const ${HALF_PI}) (f64.mul (f64.const 2) (local.get $s))) (local.get $s) (local.get $h)) (local.get $x)))`)

  wat('math.acos', `(func $math.acos (param $x f64) (result f64)
    (local $a f64) (local $z f64) (local $s f64) (local $h i32)
    (local.set $a (f64.abs (local.get $x)))
    (if (i32.eqz (f64.le (local.get $a) (f64.const 1))) (then (return (f64.const nan))))${halfAngle}
    ;; the kernel's argument: x itself up to ½ (asin is odd), the half angle past it
    (local.set $a (select (local.get $a) (local.get $x) (local.get $h)))${asinK('$a')}
    (select
      (select (f64.mul (f64.const 2) (local.get $s)) (f64.sub (f64.const ${PI}) (f64.mul (f64.const 2) (local.get $s))) (f64.gt (local.get $x) (f64.const 0)))
      (f64.sub (f64.const ${HALF_PI}) (local.get $s))
      (local.get $h)))`)

  wat('math.atan2', `(func $math.atan2 (param $y f64) (param $x f64) (result f64)
    ;; If either argument is NaN, the result is NaN (ECMA-262 21.3.2.5).
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (f64.ne (local.get $y) (local.get $y)) (then (return (local.get $y))))
    ;; ±∞/±∞ quadrant table (spec): ±π/4 when x is +∞, ±3π/4 when x is −∞, sign
    ;; from y — the atan(y/x) fallback would see ∞/∞ = NaN.
    (if (i32.and (f64.eq (f64.abs (local.get $y)) (f64.const inf))
                 (f64.eq (f64.abs (local.get $x)) (f64.const inf)))
      (then (return (f64.copysign
        (select (f64.const ${PI / 4}) (f64.const ${3 * PI / 4})
                (f64.gt (local.get $x) (f64.const 0.0)))
        (local.get $y)))))
    (if (result f64) (f64.eq (local.get $x) (f64.const 0.0)) (then
      ;; y is ±0 too: result is ±0 when x is +0, ±π when x is -0; sign taken from y.
      (if (result f64) (f64.eq (local.get $y) (f64.const 0.0))
        (then (f64.copysign
          (select (f64.const ${PI}) (f64.const 0.0)
                  (f64.lt (f64.copysign (f64.const 1.0) (local.get $x)) (f64.const 0.0)))
          (local.get $y)))
        (else
          (if (result f64) (f64.gt (local.get $y) (f64.const 0.0)) (then (f64.const ${HALF_PI})) (else (f64.neg (f64.const ${HALF_PI})))))))
      (else (if (result f64) (f64.ge (local.get $x) (f64.const 0.0))
        (then (call $math.atan (f64.div (local.get $y) (local.get $x))))
        ;; x < 0: shift by ±π with the sign of y INCLUDING -0 (copysign probe —
        ;; a plain y ≥ 0 reads -0 as nonnegative, turning atan2(-0,-1) into +π).
        (else (if (result f64) (f64.gt (f64.copysign (f64.const 1.0) (local.get $y)) (f64.const 0.0))
          (then (f64.add (call $math.atan (f64.div (local.get $y) (local.get $x))) (f64.const ${PI})))
          (else (f64.sub (call $math.atan (f64.div (local.get $y) (local.get $x))) (f64.const ${PI})))))))))`)

  // sinh through expm1 for small |x|: with t = e^|x| − 1, sinh|x| = t(t+2) / 2(t+1)
  // exactly, and that form never subtracts two nearly equal numbers. The plain
  // (e^x − e^−x)/2 does, and near zero it cancelled the answer away — 3.3e-13
  // relative at |x| ≈ 8e-4, against 3e-16 here. Past |x| = 1 the two exponentials
  // are far apart, nothing cancels, and the direct form avoids expm1's own range.
  // Past e^|x|'s overflow (709.78) the result is still finite up to 710.48:
  // (½e^(|x|/2))·e^(|x|/2), as fdlibm does, where e^|x| alone would be Infinity.
  const EXP_MAX = 709.782712893384
  wat('math.sinh', `(func $math.sinh (param $x f64) (result f64)
    (local $a f64) (local $ex f64) (local $t f64)
    ;; Preserve sign of zero: sinh(±0) = ±0; NaN is itself.
    (if (i32.or (f64.eq (local.get $x) (f64.const 0.0)) (f64.ne (local.get $x) (local.get $x))) (then (return (local.get $x))))
    (local.set $a (f64.abs (local.get $x)))
    (if (f64.lt (local.get $a) (f64.const 1.0))
      (then
        (local.set $t (call $math.expm1 (local.get $a)))
        (local.set $ex (f64.div
          (f64.mul (local.get $t) (f64.add (local.get $t) (f64.const 2.0)))
          (f64.mul (f64.const 2.0) (f64.add (local.get $t) (f64.const 1.0))))))
      (else (if (f64.gt (local.get $a) (f64.const ${EXP_MAX}))
        (then
          (local.set $t (call $math.exp (f64.mul (f64.const 0.5) (local.get $a))))
          (local.set $ex (f64.mul (f64.mul (f64.const 0.5) (local.get $t)) (local.get $t))))
        (else
          (local.set $ex (call $math.exp (local.get $a)))
          (local.set $ex (f64.mul (f64.const 0.5) (f64.sub (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))))))
    (f64.copysign (local.get $ex) (local.get $x)))`)

  wat('math.cosh', `(func $math.cosh (param $x f64) (result f64)
    (local $a f64) (local $ex f64)
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (local.set $a (f64.abs (local.get $x)))
    (if (f64.gt (local.get $a) (f64.const ${EXP_MAX}))
      (then
        (local.set $ex (call $math.exp (f64.mul (f64.const 0.5) (local.get $a))))
        (return (f64.mul (f64.mul (f64.const 0.5) (local.get $ex)) (local.get $ex)))))
    (local.set $ex (call $math.exp (local.get $a)))
    (f64.mul (f64.const 0.5) (f64.add (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))`)

  wat('math.tanh', `(func $math.tanh (param $x f64) (result f64)
    (local $e2x f64)
    ;; Preserve sign of zero: tanh(±0) = ±0 (the f64.lt sign test below is false for -0).
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 22.0))
      (then (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.const -1.0)) (else (f64.const 1.0))))
      ;; t = e^2|x| − 1 through expm1, then tanh|x| = t / (t + 2). The subtraction
      ;; the direct form does (e^2x − 1) cancels near zero and cost 4.1e-13
      ;; relative there; this form has nothing to cancel. |x| > 22 already
      ;; returned ±1 above, so t stays finite here.
      (else (local.set $e2x (call $math.expm1 (f64.mul (f64.const 2.0) (f64.abs (local.get $x)))))
        (local.set $e2x (f64.div (local.get $e2x) (f64.add (local.get $e2x) (f64.const 2.0))))
        (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $e2x))) (else (local.get $e2x))))))`)

  // asinh, acosh and atanh as fdlibm structures them (s_asinh.c, e_acosh.c, e_atanh.c)
  // on jz's log, log1p and sqrt: each form the one that cancels nothing in its range.
  // The direct log(x + √(x² + 1)) lost every digit for a negative or a small x
  // (asinh(−1e8) was −Infinity), log(x + √(x² − 1)) near 1 and ½·log((1 + x)/(1 − x))
  // near 0 lost most of them.
  wat('math.asinh', `(func $math.asinh (param $x f64) (result f64)
    (local $a f64) (local $t f64)
    ;; ±Infinity and NaN are themselves; below 2^-28, x (the x³/6 term is under half an ulp)
    (local.set $a (f64.abs (local.get $x)))
    (if (i32.eqz (f64.lt (local.get $a) (f64.const inf))) (then (return (local.get $x))))
    (if (f64.lt (local.get $a) (f64.const ${2 ** -28})) (then (return (local.get $x))))
    (local.set $a (if (result f64) (f64.gt (local.get $a) (f64.const ${2 ** 28}))
      (then (f64.add (call $math.log (local.get $a)) (f64.const ${Math.LN2})))
      (else (if (result f64) (f64.gt (local.get $a) (f64.const 2))
        (then (call $math.log (f64.add (f64.mul (f64.const 2) (local.get $a))
          (f64.div (f64.const 1) (f64.add (f64.sqrt (f64.add (f64.mul (local.get $a) (local.get $a)) (f64.const 1))) (local.get $a))))))
        (else
          (local.set $t (f64.mul (local.get $a) (local.get $a)))
          (call $math.log1p (f64.add (local.get $a)
            (f64.div (local.get $t) (f64.add (f64.const 1) (f64.sqrt (f64.add (f64.const 1) (local.get $t))))))))))))
    (f64.copysign (local.get $a) (local.get $x)))`)

  wat('math.acosh', `(func $math.acosh (param $x f64) (result f64)
    (local $t f64)
    ;; below 1 (−Infinity included) and NaN: NaN; +Infinity takes the first branch
    (if (i32.eqz (f64.ge (local.get $x) (f64.const 1))) (then (return (f64.const nan))))
    (if (f64.ge (local.get $x) (f64.const ${2 ** 28}))
      (then (return (f64.add (call $math.log (local.get $x)) (f64.const ${Math.LN2})))))
    (if (f64.gt (local.get $x) (f64.const 2))
      (then (return (call $math.log (f64.sub (f64.mul (f64.const 2) (local.get $x))
        (f64.div (f64.const 1) (f64.add (local.get $x) (f64.sqrt (f64.sub (f64.mul (local.get $x) (local.get $x)) (f64.const 1))))))))))
    (local.set $t (f64.sub (local.get $x) (f64.const 1)))
    (call $math.log1p (f64.add (local.get $t) (f64.sqrt (f64.add (f64.mul (f64.const 2) (local.get $t)) (f64.mul (local.get $t) (local.get $t)))))))`)

  wat('math.atanh', `(func $math.atanh (param $x f64) (result f64)
    (local $a f64) (local $t f64)
    (local.set $a (f64.abs (local.get $x)))
    ;; ±1: ±Infinity; past it and NaN: NaN; below 2^-28, x
    (if (i32.eqz (f64.lt (local.get $a) (f64.const 1)))
      (then (return (select (f64.copysign (f64.const inf) (local.get $x)) (f64.const nan) (f64.eq (local.get $a) (f64.const 1))))))
    (if (f64.lt (local.get $a) (f64.const ${2 ** -28})) (then (return (local.get $x))))
    (if (f64.lt (local.get $a) (f64.const 0.5))
      (then
        (local.set $t (f64.add (local.get $a) (local.get $a)))
        (local.set $t (f64.mul (f64.const 0.5) (call $math.log1p (f64.add (local.get $t)
          (f64.div (f64.mul (local.get $t) (local.get $a)) (f64.sub (f64.const 1) (local.get $a))))))))
      (else
        (local.set $t (f64.mul (f64.const 0.5) (call $math.log1p
          (f64.div (f64.add (local.get $a) (local.get $a)) (f64.sub (f64.const 1) (local.get $a))))))))
    (f64.copysign (local.get $t) (local.get $x)))`)

  // fdlibm s_cbrt.c (Sun, as shipped by FreeBSD/musl/V8's ieee754): a 5-bit
  // bit-hack seed, a polynomial to 23 bits, one Newton step to 53 bits with an
  // error under 0.667 ulp — exact on every perfect cube.
  wat('math.cbrt', `(func $math.cbrt (param $x f64) (result f64)
    (local $hx i32) (local $sign i32) (local $high i32) (local $t f64) (local $r f64) (local $s f64) (local $w f64)
    (if (i32.eqz (call $math.isFinite (local.get $x))) (then (return (local.get $x))))
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (local.set $hx (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $x)) (i64.const 32))))
    (local.set $sign (i32.and (local.get $hx) (i32.const 0x80000000)))
    (local.set $hx (i32.xor (local.get $hx) (local.get $sign)))
    (if (i32.lt_u (local.get $hx) (i32.const 0x00100000))
      (then
        ;; subnormal: scale by 2^54 before splitting the exponent
        (local.set $t (f64.mul (local.get $x) (f64.const 18014398509481984.0)))
        (local.set $high (i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $t)) (i64.const 32))) (i32.const 0x7fffffff)))
        (local.set $t (f64.reinterpret_i64 (i64.shl (i64.extend_i32_u
          (i32.or (local.get $sign) (i32.add (i32.div_u (local.get $high) (i32.const 3)) (i32.const 696219795)))) (i64.const 32)))))
      (else
        (local.set $t (f64.reinterpret_i64 (i64.shl (i64.extend_i32_u
          (i32.or (local.get $sign) (i32.add (i32.div_u (local.get $hx) (i32.const 3)) (i32.const 715094163)))) (i64.const 32))))))
    ;; cbrt(x) = t*cbrt(x/t^3) ~= t*P(t^3/x), to 23 bits
    (local.set $r (f64.mul (f64.mul (local.get $t) (local.get $t)) (f64.div (local.get $t) (local.get $x))))
    (local.set $t (f64.mul (local.get $t)
      (f64.add
        (f64.add (f64.const 1.87595182427177009643)
          (f64.mul (local.get $r) (f64.add (f64.const -1.88497979543377169875) (f64.mul (local.get $r) (f64.const 1.621429720105354466140)))))
        (f64.mul (f64.mul (f64.mul (local.get $r) (local.get $r)) (local.get $r))
          (f64.add (f64.const -0.758397934778766047437) (f64.mul (local.get $r) (f64.const 0.145996192886612446982)))))))
    ;; round t away from zero to 23 bits
    (local.set $t (f64.reinterpret_i64 (i64.and (i64.add (i64.reinterpret_f64 (local.get $t)) (i64.const 0x80000000)) (i64.const -1073741824))))
    ;; one Newton step to 53 bits
    (local.set $s (f64.mul (local.get $t) (local.get $t)))
    (local.set $r (f64.div (local.get $x) (local.get $s)))
    (local.set $w (f64.add (local.get $t) (local.get $t)))
    (local.set $r (f64.div (f64.sub (local.get $r) (local.get $t)) (f64.add (local.get $w) (local.get $r))))
    (f64.add (local.get $t) (f64.mul (local.get $t) (local.get $r))))`)

  // x^c for a constant c = k/5 in (0, 5) (emitPow's fold): x^p·fifthroot(x^r), p = ⌊c⌋,
  // r = k − 5p. On [lo, hi] (trig-tables.js fifthFold) that alone is within 40 ulp of x^c.
  // Past it x = 2^(5j)·x' with |log2 x'| ≤ 2 (x' takes x's significand), the fold runs on x'
  // and 2^(jk) scales it back (in two steps, so neither factor leaves the doubles), times
  // 1 + (5c − k)·ln2·j: c's own rounding, x^(c − k/5), on the 2^(5j) part (the part on x'
  // is under 8 ulp). x ≤ 0, NaN and ±Infinity take Math.pow's answers for a non-integer
  // c > 0. One call a power, so the lane vectorizer lifts it as one (pow_fifths_v).
  const fold5 = (x) => `(if (result f64) (f64.lt (local.get $r) (f64.const 2.5))
        (then (select (local.get $x2) ${x} (f64.gt (local.get $r) (f64.const 1.5))))
        (else (select (f64.mul (local.get $x2) (local.get $x2)) (f64.mul (local.get $x2) ${x}) (f64.gt (local.get $r) (f64.const 3.5)))))`
  const foldP = (x) => `(if (result f64) (f64.lt (local.get $p) (f64.const 0.5))
      (then (local.get $v))
      (else (f64.mul
        (if (result f64) (f64.lt (local.get $p) (f64.const 2.5))
          (then (select (local.get $x2) ${x} (f64.gt (local.get $p) (f64.const 1.5))))
          (else (select (f64.mul (local.get $x2) (local.get $x2)) (f64.mul (local.get $x2) ${x}) (f64.gt (local.get $p) (f64.const 3.5)))))
        (local.get $v))))`
  const pow2i = (e) => `(f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add ${e} (i32.const 1023))) (i64.const 52)))`
  wat('math.pow_fifths', `(func $math.pow_fifths (param $x f64) (param $c f64) (param $lo f64) (param $hi f64) (result f64)
    (local $p f64) (local $r f64) (local $x2 f64) (local $v f64) (local $b i64) (local $e i32) (local $j f64) (local $s f64) (local $bb f64) (local $jk i32)
    (local.set $p (f64.floor (local.get $c)))
    (local.set $r (f64.sub (f64.nearest (f64.mul (local.get $c) (f64.const 5))) (f64.mul (local.get $p) (f64.const 5))))
    (if (f64.ge (f64.mul (f64.sub (local.get $x) (local.get $lo)) (f64.sub (local.get $hi) (local.get $x))) (f64.const 0))
      (then
        (local.set $x2 (f64.mul (local.get $x) (local.get $x)))
        (local.set $v (call $math.fifthroot ${fold5('(local.get $x)')}))
        (return ${foldP('(local.get $x)')})))
    (if (i32.eqz (f64.gt (local.get $x) (f64.const 0)))
      (then (return (select (f64.const 0) (select (f64.const inf) (f64.const nan) (f64.eq (local.get $x) (f64.const -inf)))
        (f64.eq (local.get $x) (f64.const 0))))))
    (if (f64.eq (local.get $x) (f64.const inf)) (then (return (local.get $x))))
    (if (f64.lt (local.get $x) (f64.const 2.2250738585072014e-308))
      (then (local.set $x (f64.mul (local.get $x) (f64.const 18446744073709551616))) (local.set $e (i32.const -64))))
    (local.set $b (i64.reinterpret_f64 (local.get $x)))
    (local.set $e (i32.add (local.get $e) (i32.sub (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const 52))) (i32.const 1023))))
    (local.set $j (f64.nearest (f64.mul (f64.convert_i32_s (local.get $e)) (f64.const 0.2))))
    (local.set $jk (i32.trunc_f64_s (local.get $j)))
    (local.set $x (f64.reinterpret_i64 (i64.or (i64.and (local.get $b) (i64.const 0xfffffffffffff))
      (i64.shl (i64.extend_i32_s (i32.add (i32.sub (local.get $e) (i32.mul (local.get $jk) (i32.const 5))) (i32.const 1023))) (i64.const 52)))))
    (local.set $x2 (f64.mul (local.get $x) (local.get $x)))
    (local.set $v (call $math.fifthroot ${fold5('(local.get $x)')}))
    (local.set $v ${foldP('(local.get $x)')})
    ;; 5c − k exactly (5c = 4c + c as a TwoSum), then 1 + (5c − k)·ln2·j
    (local.set $s (f64.add (f64.mul (f64.const 4) (local.get $c)) (local.get $c)))
    (local.set $bb (f64.sub (local.get $s) (f64.mul (f64.const 4) (local.get $c))))
    (local.set $s (f64.add (f64.sub (local.get $s) (f64.nearest (f64.mul (local.get $c) (f64.const 5))))
      (f64.add (f64.sub (f64.mul (f64.const 4) (local.get $c)) (f64.sub (local.get $s) (local.get $bb))) (f64.sub (local.get $c) (local.get $bb)))))
    (local.set $v (f64.mul (local.get $v) (f64.add (f64.const 1) (f64.mul (f64.mul (local.get $s) (f64.const ${Math.LN2})) (local.get $j)))))
    ;; 2^(jk), past ±1100 an overflow or an underflow anyway, as two factors
    (local.set $jk (i32.mul (local.get $jk) (i32.trunc_f64_s (f64.nearest (f64.mul (local.get $c) (f64.const 5))))))
    (local.set $jk (select (i32.const 1100) (select (i32.const -1100) (local.get $jk) (i32.lt_s (local.get $jk) (i32.const -1100))) (i32.gt_s (local.get $jk) (i32.const 1100))))
    (f64.mul (f64.mul (local.get $v) ${pow2i('(i32.shr_s (local.get $jk) (i32.const 1))')})
      ${pow2i('(i32.sub (local.get $jk) (i32.shr_s (local.get $jk) (i32.const 1)))')}))`)

  // Fifth root of v ≥ 0 — same bit-hack seed (÷5 of the raw bits, within ~4%) + 4 Newton
  // steps t=(4t+v/t⁴)/5, the last one as a correction t + (v/t⁴ − t)/5. Newton squares
  // the relative error each step (×2 for a fifth root): 4e-2 → 3e-3 → 2e-5 → 6e-10 →
  // below f64 precision, so the root is within an ulp or two; the k/5 pow fold built on
  // it (x^p · fifthroot(x^r)) measures at most 4 ulp from x^(k/5) where x^r is a normal
  // double. Three steps stopped at ~6e-10, a million-ulp approximation.
  // Caller ($math.pow_fifths, e.g. the sRGB 2.4 gamma) guarantees v ≥ 0.
  wat('math.fifthroot', `(func $math.fifthroot (param $v f64) (result f64)
    (local $t f64) (local $s f64) (local $q f64)
    (if (i32.eqz (call $math.isFinite (local.get $v))) (then (return (local.get $v))))
    (if (f64.eq (local.get $v) (f64.const 0.0)) (then (return (f64.const 0.0))))
    (local.set $s (f64.const 1.0))
    ;; subnormal: scale by 2^100 = (2^20)^5; fifthroot(2^100) = 2^20
    (if (f64.lt (local.get $v) (f64.const 2.2250738585072014e-308))
      (then (local.set $v (f64.mul (local.get $v) (f64.const 1.2676506002282294e30)))
            (local.set $s (f64.const 9.5367431640625e-07))))
    (local.set $t (f64.reinterpret_i64
      (i64.add (i64.div_u (i64.reinterpret_f64 (local.get $v)) (i64.const 5)) (i64.const 0x3325E66666666800))))
    (local.set $q (f64.mul (local.get $t) (local.get $t)))
    (local.set $t (f64.mul (f64.add (f64.mul (f64.const 4.0) (local.get $t)) (f64.div (local.get $v) (f64.mul (local.get $q) (local.get $q)))) (f64.const 0.2)))
    (local.set $q (f64.mul (local.get $t) (local.get $t)))
    (local.set $t (f64.mul (f64.add (f64.mul (f64.const 4.0) (local.get $t)) (f64.div (local.get $v) (f64.mul (local.get $q) (local.get $q)))) (f64.const 0.2)))
    (local.set $q (f64.mul (local.get $t) (local.get $t)))
    (local.set $t (f64.mul (f64.add (f64.mul (f64.const 4.0) (local.get $t)) (f64.div (local.get $v) (f64.mul (local.get $q) (local.get $q)))) (f64.const 0.2)))
    ;; the last step as a correction, t + (v/t⁴ − t)/5: one rounding on a term ~1e-9 of t
    (local.set $q (f64.mul (local.get $t) (local.get $t)))
    (local.set $t (f64.add (local.get $t) (f64.mul (f64.sub (f64.div (local.get $v) (f64.mul (local.get $q) (local.get $q))) (local.get $t)) (f64.const 0.2))))
    (f64.mul (local.get $t) (local.get $s)))`)

  // Small finite-test helper (NaN→0, ±Inf→0, finite→1). Used by transcendental
  // functions that need to short-circuit on infinite inputs.
  wat('math.isFinite', `(func $math.isFinite (param $x f64) (result i32)
    (i32.and
      (f64.eq (local.get $x) (local.get $x))
      (f64.lt (f64.abs (local.get $x)) (f64.const inf))))`)

  wat('math.hypot', `(func $math.hypot (param $x f64) (param $y f64) (result f64)
    (local $ax f64) (local $ay f64) (local $big f64) (local $s f64)
    ;; Any ±Infinity argument ⇒ +Infinity, even when the other is NaN (ECMA-262 21.3.2.18).
    (if (f64.eq (f64.abs (local.get $x)) (f64.const inf)) (then (return (f64.const inf))))
    (if (f64.eq (f64.abs (local.get $y)) (f64.const inf)) (then (return (f64.const inf))))
    (local.set $ax (f64.abs (local.get $x)))
    (local.set $ay (f64.abs (local.get $y)))
    (local.set $big (f64.max (local.get $ax) (local.get $ay)))
    ;; Scale by a power of two (exact) so the squares can neither overflow
    ;; (hypot(1e300,1e300) is ~1.414e300, not Inf) nor flush to zero. The runt
    ;; arm may underflow in the big-scale branch — its relative contribution is
    ;; < 2^-200, beneath rounding. A NaN big (no Inf partner) skips both scale
    ;; branches and propagates through the square-sum as the result.
    (local.set $s (f64.const 1.0))
    (if (f64.ge (local.get $big) (f64.const ${2 ** 500}))
      (then (local.set $s (f64.const ${2 ** 600}))
        (local.set $ax (f64.mul (local.get $ax) (f64.const ${2 ** -600})))
        (local.set $ay (f64.mul (local.get $ay) (f64.const ${2 ** -600}))))
      (else (if (f64.le (local.get $big) (f64.const ${2 ** -500}))
        (then (local.set $s (f64.const ${2 ** -600}))
          (local.set $ax (f64.mul (local.get $ax) (f64.const ${2 ** 600})))
          (local.set $ay (f64.mul (local.get $ay) (f64.const ${2 ** 600})))))))
    (f64.mul (local.get $s)
      (f64.sqrt (f64.add (f64.mul (local.get $ax) (local.get $ax)) (f64.mul (local.get $ay) (local.get $ay))))))`)

}
