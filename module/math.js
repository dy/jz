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

import { typed, asF64, asI32, toI32, toNumF64, temp, arrayLoop, isLit, litVal, isPureIR } from '../src/ir.js'
import { emit, emitter, reg, deps, dual, tag, wat, hostImport } from '../src/bridge.js'
import { inc, declGlobal } from '../src/ctx.js'
import { repOf } from '../src/reps.js'

export default (ctx) => {
  // Math.random seeding. DEFAULT: entropy-seeded once from the host on first use (crypto under
  // host:'js', `random_get` under WASI), so randomness "just works" and isn't silently reproducible.
  // `randomSeed: <n>` picks a fixed seed for a reproducible sequence; `true` forces entropy explicitly.
  // Either way jz emits the randomness syscall only when `Math.random` is actually used.
  const rngEntropy = ctx.transform.randomSeed === undefined || ctx.transform.randomSeed === true
  const rngSeedConst = typeof ctx.transform.randomSeed === 'number'
    ? ((ctx.transform.randomSeed >>> 0) || 1)   // xorshift dies on 0 → floor at 1
    : 12345
  deps({
    'math.sin': ['math.sin_core'],
    'math.cos': ['math.cos_core'],
    'math.sin_core': [],
    'math.cos_core': [],
    'math.tan': ['math.sin', 'math.cos'],
    'math.exp': ['math.exp2'],
    'math.expm1': ['math.exp'],
    'math.log2': ['math.log'],
    'math.log1p': ['math.log'],
    'math.pow': ['math.exp', 'math.log'],
    'math.asin': ['math.atan'],
    'math.acos': ['math.asin'],
    'math.atan2': ['math.atan'],
    'math.sinh': ['math.exp'],
    'math.cosh': ['math.exp'],
    'math.tanh': ['math.exp'],
    'math.asinh': ['math.isFinite', 'math.log'],
    'math.acosh': ['math.log'],
    'math.atanh': ['math.log'],
    'math.cbrt': ['math.isFinite', 'math.pow'],
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
  // Emit-time fast path: call $math.sin_core/$math.cos_core directly instead of
  // the $math.sin/$math.cos wrappers. sin_core still runs the isFinite guard
  // (finite operands can overflow to ±Inf); this only saves a call indirection.
  const isBoundName = (name) =>
    typeof name === 'string' && (
      repOf(name) != null ||
      ctx.func.locals?.has(name) ||
      ctx.func.current?.params?.some(p => p.name === name)
    )
  const isSinCoreFastPath = (src) => {
    if (src == null) return false
    if (typeof src === 'number') return Number.isFinite(src)
    if (typeof src === 'string') return isIntCertain(src) || isBoundName(src)
    if (!Array.isArray(src)) return false
    const op = src[0]
    // jz source literals: [null, n], [, bool], [null, null]
    if (op == null && src.length === 2) {
      const v = src[1]
      if (typeof v === 'number') return Number.isFinite(v)
      if (typeof v === 'boolean') return true
      if (v == null) return true
    }
    if (op === 'literal') {
      const v = src[1]
      return typeof v === 'number' && Number.isFinite(v)
    }
    if (op === 'global' || op === 'param') return true
    if (op === '()') {
      const fn = src[1]
      if (fn === 'math.PI' || fn === 'math.E' || fn === 'math.LN2' || fn === 'math.SQRT2') return true
      if (typeof fn === 'string' && fn.startsWith('math.')) {
        const finiteOps = new Set([
          'math.abs', 'math.floor', 'math.ceil', 'math.trunc', 'math.round', 'math.sqrt',
          'math.sin', 'math.cos', 'math.tan', 'math.imul', 'math.clz32',
        ])
        if (finiteOps.has(fn)) return src.slice(2).every(isSinCoreFastPath)
      }
    }
    if (op === '|' && src.length === 3) return isSinCoreFastPath(src[1]) && isSinCoreFastPath(src[2])
    if (op === '%' || op === '&' || op === '^' || op === '<<' || op === '>>' || op === '>>>') {
      return src.slice(1).every(isSinCoreFastPath)
    }
    if (op === '+' || op === '-' || op === '*' || op === '**') {
      return src.slice(1).every(isSinCoreFastPath)
    }
    if (op === '/') return isSinCoreFastPath(src[1]) && isSinCoreFastPath(src[2])
    if (op === '?:' && src.length === 4) return isSinCoreFastPath(src[2]) && isSinCoreFastPath(src[3])
    if ((op === '&&' || op === '||') && src.length === 3) return isSinCoreFastPath(src[1]) && isSinCoreFastPath(src[2])
    if (op === '!' && src.length === 2) return isSinCoreFastPath(src[1])
    if (op === '[]' && src.length === 3) {
      // Chord tables / semitone indices — index is int-shaped, element is a small int.
      return isSinCoreFastPath(src[2]) || isIntCertain(src[2])
    }
    if (op === '.' && src.length === 3 && src[2] === 'length') {
      return typeof src[1] === 'string' || isSinCoreFastPath(src[1])
    }
    if (op === '.' && src.length === 3) return isIntCertain(src)
    return false
  }
  const fInt = (op, a) => isIntCertain(a) ? asF64(emit(a)) : f(op, a)
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

  // Constants
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

  // Sign
  reg('math.sign', ['math.sign'], a => fn('math.sign', a))

  // Trig — isSinCoreFastPath skips the $math.sin/$math.cos wrapper call.
  ctx.core.emit['math.sin'] = dual(
    emitter(['math.sin'], a => fn('math.sin', a)),
    emitter(['math.sin_core'], a => fn('math.sin_core', a)),
    isSinCoreFastPath)
  ctx.core.emit['math.cos'] = dual(
    emitter(['math.cos'], a => fn('math.cos', a)),
    emitter(['math.cos_core'], a => fn('math.cos_core', a)),
    isSinCoreFastPath)
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
    const stmts = [['local.set', `$${b}`, baseIR]]
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
    let result = get(res)
    if (n < 0) { result = ['f64.div', ['f64.const', 1], result]; minted = true }   // y<0 → reciprocal, as $math.pow does
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
  // base-2 power → dedicated $math.exp2(y) (skips exp's ×ln2 / ÷ln2 round-trip)
  const exp2Call = emitter(['math.exp2'], (exp) => typed(['call', '$math.exp2', toNumF64(exp, emit(exp))], 'f64'))
  // Shared pow/** lowering.
  const emitPow = (a, b, allowExpPos) => {
    const n = constInt(b)
    if (n !== null && Math.abs(n) <= POW_FOLD_MAX) return foldPow(a, n)
    if (constNum(b) === 0.5) { const ir = typed(['f64.sqrt', toNumF64(a, emit(a))], 'f64'); return nonNegF64(ir[1]) ? ir : canon(ir) }
    // Both args are compile-time constants: evaluate now, emit f64.const.
    // Catches pow(2, -2/12) where the arithmetic folds emit f64.const for both sides.
    const ca = constNum(a), cb = constNum(b)
    if (ca !== null && cb !== null) return typed(['f64.const', Math.pow(ca, cb)], 'f64')
    // IR-level fold: peek at emitted IR for both args — e.g. -2/12 emits f64.const -0.1666.
    // We emit, check, and if not foldable, the emitted IR is used by the fallthrough paths.
    const irA = toNumF64(a, emit(a)), irB = toNumF64(b, emit(b))
    if (isLit(irA) && isLit(irB)) return typed(['f64.const', Math.pow(litVal(irA), litVal(irB))], 'f64')
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
    if (b === undefined) return f('f64.abs', a)
    let r = fn('math.hypot', a, b)
    // ToNumber every rest arg too (matches min/max) — an object arg's valueOf
    // must run and may throw, which Math.hypot propagates.
    for (const x of rest) r = typed(['call', '$math.hypot', r, toNumF64(x, emit(x))], 'f64')
    return r
  })

  // Math.sumPrecise(iterable) — exact, correctly-rounded summation (ECMA-262).
  // jz models the array case; the WAT routine sums via a fixed-point accumulator.
  reg('math.sumPrecise', ['math.sumPrecise'], arr =>
    typed(['call', '$math.sumPrecise', ['i64.reinterpret_f64', asF64(emit(arr))]], 'f64'))

  // Integer/bit operations: return i32 directly. Consumers `asF64`-rebox at
  // store/return boundaries; consumers staying in i32 (bit chains, i32 locals)
  // skip the convert/trunc round-trip entirely.
  // Operands take ECMAScript ToInt32 (wrapping), not saturation — `Math.imul(x, k)`
  // with a literal k ≥ 2³¹ must wrap to negative, matching JS, not clamp to INT_MAX.
  ctx.core.emit['math.clz32'] = a => typed(['i32.clz', toI32(emit(a))], 'i32')
  ctx.core.emit['math.imul'] = (a, b) => typed(['i32.mul', toI32(emit(a)), toI32(emit(b))], 'i32')

  // Random
  reg('math.random', ['math.random'], () => {
    // Entropy mode: pull the host randomness syscall on demand (only when
    // Math.random is actually used) — env.rngSeed (JS host) or WASI random_get.
    if (rngEntropy) {
      if (ctx.transform.host === 'wasi')
        hostImport('wasi_snapshot_preview1', 'random_get', ['func', '$__random_get', ['param', 'i32'], ['param', 'i32'], ['result', 'i32']])
      else
        hostImport('env', 'rngSeed', ['func', '$__env_rng_seed', ['result', 'i32']])
    }
    return typed(['call', '$math.random'], 'f64')
  })

  // ============================================
  // WAT stdlib implementations
  // ============================================

  wat('math.sign', `(func $math.sign (param $x f64) (result f64)
    ;; sign(NaN) = NaN, sign(±0) = ±0 — both pass x through unchanged.
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (if (result f64) (f64.gt (local.get $x) (f64.const 0.0))
      (then (f64.const 1.0))
      (else (f64.const -1.0))))`)

  // sin/cos over the folded range [0, π/2] use a 5-term MINIMAX polynomial in x² (Horner
  // form, generated below). It beats the prior 6-term Taylor on both counts: one fewer
  // multiply (faster — the floatbeat synth is sin-bound), and lower error (sin ≤ 1.9e-8,
  // cos ≤ 1.3e-7 vs Taylor's ~6e-8 / ~5e-7) — minimax spreads error evenly across the range
  // instead of piling unused precision near 0. Coeffs fit by scripts/minimax-trig.mjs.
  const horner = (cs, v) => cs.reduceRight((acc, c, i) =>
    i === cs.length - 1 ? `(f64.const ${c})`
      : `(f64.add (f64.const ${c}) (f64.mul (local.get ${v}) ${acc}))`, '')
  const SIN_C = [1, -0.16666660296130772, 0.008333091744946387, -0.00019811771757028443, 0.000002611054662215034]
  const COS_C = [1, -0.4999993043717576, 0.04166402742354027, -0.0013856638518363177, 0.00002321737177898552]
  // 2^f over the reduced range f ∈ [-0.5, 0.5] for $math.exp2 (rel. err ≤ 6e-9). Lets the
  // base-2 power `2**y` skip the ×ln2 / ÷ln2 round-trip exp(y·ln2) pays — see $math.exp2.
  const EXP2_C = [1, 0.6931472000619209, 0.24022650999918949, 0.05550340682450019, 0.009618048870444599, 0.0013395279077191057, 0.00015463102004723134]
  // Range-reduction constants embedded as exact round-trip decimal STRINGS, not
  // `${Math.PI}`/`${1/Math.PI}` number interpolation. These multiply the (possibly
  // astronomically large) argument, so any lost digit wrecks large-arg reduction. Under
  // self-host the kernel formats `${number}` through __ftoa — a 9-significant-digit dtoa
  // (module/number.js) — which would bake "3.14159265"/"0.318309886" into the WAT and
  // throw the reduced quadrant off (Δ≈0.2 at x≈2267). A string interpolates verbatim, so
  // watr parses the full-precision f64 in both legs. Values are native toString's shortest
  // round-trip reprs of Math.PI, 1/Math.PI, Math.PI/2 — byte-identical to the old output.
  const PI = '3.141592653589793', INV_PI = '0.3183098861837907', HALF_PI = '1.5707963267948966'

  // Round-to-nearest reduction r = x − q·π ∈ [−π/2, π/2], in pure f64 — no int conversion,
  // so it never traps and never saturates. A SECOND pass folds the q·π rounding error back
  // in, keeping r bounded even for astronomically large x where the first pass loses all
  // precision: Math.sin must return a value in [−1,1] for every finite input, not Inf/garbage.
  // For |x| ≲ 1e15 the second pass is a no-op (q2 = 0) and the result is bit-identical to a
  // single reduction. The odd poly r·P(r²) handles r<0 on its own (sin is odd); the sign is the
  // parity of the total quotient, taken in f64 as q − 2·round(q/2). ×(1/π) avoids a divide.
  // ±Infinity and NaN must return NaN. Guard before reduction instead of relying on
  // Inf−Inf·π to mint one: that arithmetic NaN has platform-dependent bits and can
  // escape as a non-canonical NaN-box on x86/Linux.
  // The second reduction pass only corrects an r that the first pass left outside
  // [−π/2, π/2]; for in-range r, q2 is 0 and the pass is a no-op, so gating it on
  // |r| > π/2 is bit-identical for all finite inputs while sparing the common case
  // ~6 ops. Both are generic wins for every sin/cos/tan/exp-via-trig call site.
  wat('math.sin_core', `(func $math.sin_core (param $x f64) (result f64)
    (local $q f64) (local $q2 f64) (local $r f64) (local $r2 f64)
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (f64.const nan))))
    (if (f64.eq (f64.abs (local.get $x)) (f64.const inf)) (then (return (f64.const nan))))
    ;; |x| ≤ 2⁻²⁷: sin(x) = x to within a fraction of an ulp, and returning x preserves the
    ;; sign of ±0 (the range reduction below would turn -0 into +0: -0 − (-0·π) = +0).
    (if (f64.lt (f64.abs (local.get $x)) (f64.const ${2 ** -27})) (then (return (local.get $x))))
    (local.set $q (f64.nearest (f64.mul (local.get $x) (f64.const ${INV_PI}))))
    (local.set $r (f64.sub (local.get $x) (f64.mul (local.get $q) (f64.const ${PI}))))
    (if (f64.gt (f64.abs (local.get $r)) (f64.const ${HALF_PI}))
      (then
        (local.set $q2 (f64.nearest (f64.mul (local.get $r) (f64.const ${INV_PI}))))
        (local.set $r (f64.sub (local.get $r) (f64.mul (local.get $q2) (f64.const ${PI}))))
        (local.set $q (f64.add (local.get $q) (local.get $q2)))))
    (local.set $q (f64.sub (local.get $q) (f64.mul (f64.const 2) (f64.nearest (f64.mul (local.get $q) (f64.const 0.5))))))
    (local.set $r2 (f64.mul (local.get $r) (local.get $r)))
    (local.set $r (f64.mul (local.get $r) ${horner(SIN_C, '$r2')}))
    ;; Negate for odd quasiperiods
    (if (f64.gt (f64.abs (local.get $q)) (f64.const 0.5)) (then (local.set $r (f64.neg (local.get $r)))))
    ;; Clamp to [-1, 1]: polynomial approximation can overshoot by ~1e-8 near peaks.
    ;; Branchless (f64.min/f64.max) avoids branch misprediction near peaks.
    (f64.min (f64.max (local.get $r) (f64.const -1.0)) (f64.const 1.0)))`)

  wat('math.sin', `(func $math.sin (param $x f64) (result f64)
    (call $math.sin_core (local.get $x)))`)

  wat('math.cos_core', `(func $math.cos_core (param $x f64) (result f64)
    (local $q f64) (local $q2 f64) (local $r f64) (local $r2 f64)
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (f64.const nan))))
    (if (f64.eq (f64.abs (local.get $x)) (f64.const inf)) (then (return (f64.const nan))))
    (local.set $q (f64.nearest (f64.mul (local.get $x) (f64.const ${INV_PI}))))
    (local.set $r (f64.sub (local.get $x) (f64.mul (local.get $q) (f64.const ${PI}))))
    (if (f64.gt (f64.abs (local.get $r)) (f64.const ${HALF_PI}))
      (then
        (local.set $q2 (f64.nearest (f64.mul (local.get $r) (f64.const ${INV_PI}))))
        (local.set $r (f64.sub (local.get $r) (f64.mul (local.get $q2) (f64.const ${PI}))))
        (local.set $q (f64.add (local.get $q) (local.get $q2)))))
    (local.set $q (f64.sub (local.get $q) (f64.mul (f64.const 2) (f64.nearest (f64.mul (local.get $q) (f64.const 0.5))))))
    (local.set $r2 (f64.mul (local.get $r) (local.get $r)))
    (local.set $r ${horner(COS_C, '$r2')})
    ;; Negate for odd quasiperiods
    (if (f64.gt (f64.abs (local.get $q)) (f64.const 0.5)) (then (local.set $r (f64.neg (local.get $r)))))
    ;; Clamp to [-1, 1]: polynomial approximation can overshoot by ~1e-8 near peaks.
    ;; Branchless (f64.min/f64.max) avoids branch misprediction near peaks.
    (f64.min (f64.max (local.get $r) (f64.const -1.0)) (f64.const 1.0)))`)

  wat('math.cos', `(func $math.cos (param $x f64) (result f64)
    (call $math.cos_core (local.get $x)))`)

  wat('math.tan', `(func $math.tan (param $x f64) (result f64)
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (f64.const nan))))
    (if (f64.eq (f64.abs (local.get $x)) (f64.const inf)) (then (return (f64.const nan))))
    (f64.div (call $math.sin (local.get $x)) (call $math.cos (local.get $x))))`)

  // ── f64x2 SIMD sin/cos — both lanes through one polynomial ───────────────────
  // The scalar sin_core/cos_core algorithm lifted to two f64 lanes: same
  // round-to-nearest π reduction, same minimax poly (SIN_C/COS_C), same quadrant
  // parity — but every branch becomes branchless so two independent angles cost one
  // evaluation. A kernel computing sin and cos of distinct args (rotations, de Jong /
  // Clifford maps, oscillator banks) packs them two-per-vector and ≈halves trig cost.
  //   • Both reduction passes run unconditionally: for an in-range r the second pass'
  //     q2 = nearest(r/π) = 0, so it's an exact no-op — no per-lane branch needed, and
  //     it still rescues |x| up to ~1e15 just like the scalar's gated pass.
  //   • NaN and ±∞ fall out as NaN through the arithmetic (∞ − ∞·π = NaN); a v128 lane
  //     is raw f64, not a NaN-box, so the canonical-NaN guard the scalar needs is moot.
  //   • Sign flip for odd quadrants is `r XOR (mask & −0.0)` (mask = |q|>0.5); final
  //     min/max clamps the ~1e-8 poly overshoot to [−1,1], same as scalar.
  const splat = (c) => `(f64x2.splat (f64.const ${c}))`
  const horner2 = (cs) => cs.reduceRight((acc, c, i) =>
    i === cs.length - 1 ? splat(c)
      : `(f64x2.add ${splat(c)} (f64x2.mul (local.get $r2) ${acc}))`, '')
  // Shared reduce → r ∈ [−π/2,π/2] in $r, quadrant parity in $q (branchless, 2 passes).
  const reduce2 = `
    (local.set $q (f64x2.nearest (f64x2.mul (local.get $x) ${splat(INV_PI)})))
    (local.set $r (f64x2.sub (local.get $x) (f64x2.mul (local.get $q) ${splat(PI)})))
    (local.set $q2 (f64x2.nearest (f64x2.mul (local.get $r) ${splat(INV_PI)})))
    (local.set $r (f64x2.sub (local.get $r) (f64x2.mul (local.get $q2) ${splat(PI)})))
    (local.set $q (f64x2.add (local.get $q) (local.get $q2)))
    (local.set $q (f64x2.sub (local.get $q) (f64x2.mul ${splat(2)} (f64x2.nearest (f64x2.mul (local.get $q) ${splat(0.5)})))))
    (local.set $r2 (f64x2.mul (local.get $r) (local.get $r)))`
  // r XOR (|q|>0.5 ? −0.0 : 0), then clamp to [−1,1].
  const signClamp = `
    (local.set $r (v128.xor (local.get $r)
      (v128.and (f64x2.gt (f64x2.abs (local.get $q)) ${splat(0.5)}) ${splat('-0.0')})))
    (f64x2.min (f64x2.max (local.get $r) ${splat(-1)}) ${splat(1)})`
  wat('math.sin2', `(func $math.sin2 (param $x v128) (result v128)
    (local $q v128) (local $q2 v128) (local $r v128) (local $r2 v128)${reduce2}
    (local.set $r (f64x2.mul (local.get $r) ${horner2(SIN_C)}))${signClamp})`)
  wat('math.cos2', `(func $math.cos2 (param $x v128) (result v128)
    (local $q v128) (local $q2 v128) (local $r v128) (local $r2 v128)${reduce2}
    (local.set $r ${horner2(COS_C)})${signClamp})`)

  // e^x = 2^(x·log2 e) — defer to the faster $math.exp2 (one multiply, no division, and
  // exp2's NaN/overflow/underflow guards cover exp's). Accurate to exp2's ~6e-9, better
  // than the old 7-term Taylor, and it shares one code path with `2**`.
  wat('math.exp', `(func $math.exp (param $x f64) (result f64)
    (call $math.exp2 (f64.mul (local.get $x) (f64.const ${Math.LOG2E}))))`)

  // 2^y, the dedicated base-2 power. `2**y` lowers here instead of exp(y·ln2): no ×ln2
  // (so no reciprocal cancellation against exp's ÷ln2), a poly over the tighter [-0.5,0.5],
  // and the same O(1) IEEE-exponent build of 2^k. ~6e-9 rel. error — well inside tolerance.
  wat('math.exp2', `(func $math.exp2 (param $y f64) (result f64)
    (local $k i32) (local $f f64) (local $k2 i32) (local $p f64)
    (if (f64.ne (local.get $y) (local.get $y)) (then (return (local.get $y))))
    (if (result f64) (f64.gt (local.get $y) (f64.const 1024.0)) (then (f64.const inf)) (else
      (if (result f64) (f64.lt (local.get $y) (f64.const -1075.0)) (then (f64.const 0.0)) (else
        (local.set $k (i32.trunc_f64_s (f64.nearest (local.get $y))))
        (local.set $f (f64.sub (local.get $y) (f64.convert_i32_s (local.get $k))))
        (local.set $p ${horner(EXP2_C, '$f')})
        ;; 2^k via a single IEEE-exponent build for the normal range (the hot path); the
        ;; two-factor split (2^k2 · 2^(k−k2)) is only needed at the denormal/overflow edges.
        ;; For normal k both are bit-identical (powers of two multiply exactly) — free speedup.
        (if (result f64)
          (i32.and (i32.gt_s (local.get $k) (i32.const -1023)) (i32.lt_s (local.get $k) (i32.const 1024)))
          (then (f64.mul (local.get $p)
            (f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add (local.get $k) (i32.const 1023))) (i64.const 52)))))
          (else
            (local.set $k2 (i32.shr_s (local.get $k) (i32.const 1)))
            (f64.mul (f64.mul (local.get $p)
              (f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add (local.get $k2) (i32.const 1023))) (i64.const 52))))
              (f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add (i32.sub (local.get $k) (local.get $k2)) (i32.const 1023))) (i64.const 52)))))))))))`)

  // Maclaurin coefficients 1/1!…1/8! for e^x−1 = x·(1 + x/2! + x²/3! + …), Horner-nested
  // (built with an explicit right-to-left fold so the parens stay balanced — and so the
  // builder uses only constructs the self-host kernel can compile: Array.reduceRight is
  // not in jz's runtime, so under the kernel it returns undefined and that token lands
  // verbatim in the emitted WAT).
  const expm1Coef = [1, 1 / 2, 1 / 6, 1 / 24, 1 / 120, 1 / 720, 1 / 5040, 1 / 40320]
  let expm1Series = ''
  for (let i = expm1Coef.length - 1; i >= 0; i--)
    expm1Series = expm1Series
      ? `(f64.add (f64.const ${expm1Coef[i]}) (f64.mul (local.get $x) ${expm1Series}))`
      : `(f64.const ${expm1Coef[i]})`
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
    (local $f f64) (local $w f64) (local $t1 f64) (local $t2 f64) (local $hfsq f64)
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
    ;; s = f/(2+f) with f = m−1 (= (m−1)/(m+1)); then the fdlibm even/odd-split
    ;; polynomial. Two parallel Horner chains (t1 over even powers, t2 over odd)
    ;; cut the dependency chain ~in half vs one 9-deep Horner — more ILP, fewer
    ;; terms — and reconstruct log(m) = f − hfsq + s·(hfsq + t1 + t2). ~1 ulp.
    (local.set $f (f64.sub (local.get $m) (f64.const 1.0)))
    (local.set $s (f64.div (local.get $f) (f64.add (local.get $f) (f64.const 2.0))))
    (local.set $z (f64.mul (local.get $s) (local.get $s)))
    (local.set $w (f64.mul (local.get $z) (local.get $z)))
    (local.set $t1 (f64.mul (local.get $w) (f64.add (f64.const 0.3999999999940941908)
      (f64.mul (local.get $w) (f64.add (f64.const 0.2222219843214978396)
        (f64.mul (local.get $w) (f64.const 0.1531383769920937332)))))))
    (local.set $t2 (f64.mul (local.get $z) (f64.add (f64.const 0.6666666666666735130)
      (f64.mul (local.get $w) (f64.add (f64.const 0.2857142874366239149)
        (f64.mul (local.get $w) (f64.add (f64.const 0.1818357216161805012)
          (f64.mul (local.get $w) (f64.const 0.1479819860511658591)))))))))
    (local.set $hfsq (f64.mul (f64.const 0.5) (f64.mul (local.get $f) (local.get $f))))
    (f64.add
      (f64.mul (f64.convert_i32_s (local.get $k)) (f64.const ${Math.LN2}))
      (f64.add (f64.sub (local.get $f) (local.get $hfsq))
        (f64.mul (local.get $s) (f64.add (local.get $hfsq)
          (f64.add (local.get $t1) (local.get $t2))))))))`)

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
  // For u==1 (x below ulp), result is just x; preserves -0 from x=-0 path.
  wat('math.log1p', `(func $math.log1p (param $x f64) (result f64)
    (local $u f64)
    ;; log1p(+Inf) = +Inf — the ratio trick below would compute Inf/Inf = NaN.
    (if (f64.eq (local.get $x) (f64.const inf)) (then (return (f64.const inf))))
    (local.set $u (f64.add (f64.const 1.0) (local.get $x)))
    (if (f64.eq (local.get $u) (f64.const 1.0))
      (then (return (local.get $x))))
    (f64.div
      (f64.mul (call $math.log (local.get $u)) (local.get $x))
      (f64.sub (local.get $u) (f64.const 1.0))))`)

  wat('math.pow', `(func $math.pow (param $x f64) (param $y f64) (result f64)
    (local $result f64) (local $n i32) (local $neg_base i32) (local $abs_x f64)
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
    ;; integer fast path: y integer in i32 range. Binary exponentiation is
    ;; O(log |n|) so the bound only matters for i32.trunc_f64_s safety.
    ;; Also covers ±Infinity x: abs_x stays Inf through the loop, 1/Inf=0,
    ;; with neg_base (x<0 && odd y) producing -0 — required for (-Inf)**-odd.
    ;; Runs before the x==0 fallback so (-0)**oddInt correctly returns ∓0/∓Inf.
    (if (i32.and
          (f64.eq (f64.nearest (local.get $y)) (local.get $y))
          (f64.lt (f64.abs (local.get $y)) (f64.const 2147483648.0)))
      (then
        (local.set $abs_x (f64.abs (local.get $x)))
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
        (if (f64.lt (local.get $y) (f64.const 0.0))
          (then (local.set $result (f64.div (f64.const 1.0) (local.get $result)))))
        (if (local.get $neg_base)
          (then (local.set $result (f64.neg (local.get $result)))))
        (return (local.get $result))))
    ;; x is ±Infinity with |y| >= 2^31 (the i32 fast path above handles smaller y):
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
    ;; x == 0 with non-integer y -> y<0 ? Infinity : 0 (sign-of-zero only matters for integer y, handled above)
    (if (f64.eq (local.get $x) (f64.const 0.0))
      (then
        (if (f64.lt (local.get $y) (f64.const 0.0))
          (then (return (f64.const inf)))
          (else (return (f64.const 0.0))))))
    ;; x < 0, non-integer finite y -> NaN
    (if (f64.lt (local.get $x) (f64.const 0.0))
      (then (return (f64.const nan))))
    (call $math.exp (f64.mul (local.get $y) (call $math.log (local.get $x)))))`)

  // fdlibm atan: 4-region argument reduction onto |r| ≤ tan(π/16), then an
  // 11-term odd polynomial split into even/odd parts. Accurate to <1 ulp —
  // the old Taylor series was ~2e-6 off near |x|=0.5. Drives asin/acos/atan2.
  wat('math.atan', `(func $math.atan (param $x f64) (result f64)
    (local $abs_x f64) (local $id i32) (local $r f64) (local $z f64) (local $w f64)
    (local $s1 f64) (local $s2 f64) (local $ahi f64) (local $alo f64) (local $res f64)
    ;; NaN passes through unchanged.
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (local.set $abs_x (f64.abs (local.get $x)))
    ;; |x| >= 2^66: atan saturates to ±π/2.
    (if (f64.ge (local.get $abs_x) (f64.const 7.378697629483821e19))
      (then (return (f64.copysign (f64.const 1.5707963267948966) (local.get $x)))))
    (if (f64.lt (local.get $abs_x) (f64.const 0.4375))
      (then
        ;; |x| < 2^-27: atan(x) ≈ x (also preserves sign of zero).
        (if (f64.lt (local.get $abs_x) (f64.const 7.450580596923828e-9))
          (then (return (local.get $x))))
        (local.set $id (i32.const -1))
        (local.set $r (local.get $x)))
      (else
        (local.set $r (local.get $abs_x))
        (if (f64.lt (local.get $abs_x) (f64.const 1.1875))
          (then
            (if (f64.lt (local.get $abs_x) (f64.const 0.6875))
              (then ;; id=0: r = (2x-1)/(2+x)
                (local.set $id (i32.const 0))
                (local.set $r (f64.div (f64.sub (f64.mul (f64.const 2.0) (local.get $r)) (f64.const 1.0))
                                       (f64.add (f64.const 2.0) (local.get $r)))))
              (else ;; id=1: r = (x-1)/(x+1)
                (local.set $id (i32.const 1))
                (local.set $r (f64.div (f64.sub (local.get $r) (f64.const 1.0))
                                       (f64.add (local.get $r) (f64.const 1.0)))))))
          (else
            (if (f64.lt (local.get $abs_x) (f64.const 2.4375))
              (then ;; id=2: r = (x-1.5)/(1+1.5x)
                (local.set $id (i32.const 2))
                (local.set $r (f64.div (f64.sub (local.get $r) (f64.const 1.5))
                                       (f64.add (f64.const 1.0) (f64.mul (f64.const 1.5) (local.get $r))))))
              (else ;; id=3: r = -1/x
                (local.set $id (i32.const 3))
                (local.set $r (f64.div (f64.const -1.0) (local.get $r)))))))))
    (local.set $z (f64.mul (local.get $r) (local.get $r)))
    (local.set $w (f64.mul (local.get $z) (local.get $z)))
    (local.set $s1 (f64.mul (local.get $z)
      (f64.add (f64.const 0.3333333333333293)
        (f64.mul (local.get $w) (f64.add (f64.const 0.14285714272503466)
          (f64.mul (local.get $w) (f64.add (f64.const 0.09090887133436507)
            (f64.mul (local.get $w) (f64.add (f64.const 0.06661073137387531)
              (f64.mul (local.get $w) (f64.add (f64.const 0.049768779946159324)
                (f64.mul (local.get $w) (f64.const 0.016285820115365782)))))))))))))
    (local.set $s2 (f64.mul (local.get $w)
      (f64.add (f64.const -0.19999999999876483)
        (f64.mul (local.get $w) (f64.add (f64.const -0.11111110405462356)
          (f64.mul (local.get $w) (f64.add (f64.const -0.0769187620504483)
            (f64.mul (local.get $w) (f64.add (f64.const -0.058335701337905735)
              (f64.mul (local.get $w) (f64.const -0.036531572744216916)))))))))))
    ;; |x| < 0.4375: result = r - r*(s1+s2), sign carried by r itself.
    (if (i32.lt_s (local.get $id) (i32.const 0))
      (then (return (f64.sub (local.get $r) (f64.mul (local.get $r) (f64.add (local.get $s1) (local.get $s2)))))))
    ;; Reconstruct: z = atanhi[id] - ((r*(s1+s2) - atanlo[id]) - r), sign of x.
    (if (i32.eq (local.get $id) (i32.const 0))
      (then (local.set $ahi (f64.const 0.4636476090008061)) (local.set $alo (f64.const 2.2698777452961687e-17)))
      (else (if (i32.eq (local.get $id) (i32.const 1))
        (then (local.set $ahi (f64.const 0.7853981633974483)) (local.set $alo (f64.const 3.061616997868383e-17)))
        (else (if (i32.eq (local.get $id) (i32.const 2))
          (then (local.set $ahi (f64.const 0.982793723247329)) (local.set $alo (f64.const 1.3903311031230998e-17)))
          (else (local.set $ahi (f64.const 1.5707963267948966)) (local.set $alo (f64.const 6.123233995736766e-17))))))))
    (local.set $res (f64.sub (local.get $ahi)
      (f64.sub (f64.sub (f64.mul (local.get $r) (f64.add (local.get $s1) (local.get $s2))) (local.get $alo))
               (local.get $r))))
    (f64.copysign (local.get $res) (local.get $x)))`)

  wat('math.asin', `(func $math.asin (param $x f64) (result f64)
    ;; Domain is [-1, 1]; outside it (including ±Infinity), Math.asin returns NaN.
    ;; sin/cos output is clamped to [-1, 1] by sin_core/cos_core, so no tolerance needed here.
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 1.0))
      (then (f64.const nan))
      (else (call $math.atan (f64.div (local.get $x)
        (f64.sqrt (f64.sub (f64.const 1.0) (f64.mul (local.get $x) (local.get $x)))))))))`)

  wat('math.acos', `(func $math.acos (param $x f64) (result f64)
    (f64.sub (f64.const ${HALF_PI}) (call $math.asin (local.get $x))))`)

  wat('math.atan2', `(func $math.atan2 (param $y f64) (param $x f64) (result f64)
    ;; If either argument is NaN, the result is NaN (ECMA-262 21.3.2.5).
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (f64.ne (local.get $y) (local.get $y)) (then (return (local.get $y))))
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
        (else (if (result f64) (f64.ge (local.get $y) (f64.const 0.0))
          (then (f64.add (call $math.atan (f64.div (local.get $y) (local.get $x))) (f64.const ${PI})))
          (else (f64.sub (call $math.atan (f64.div (local.get $y) (local.get $x))) (f64.const ${PI})))))))))`)

  wat('math.sinh', `(func $math.sinh (param $x f64) (result f64)
    (local $ex f64)
    ;; Preserve sign of zero: sinh(±0) = ±0 (the f64.lt sign test below is false for -0).
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (local.set $ex (call $math.exp (f64.abs (local.get $x))))
    (local.set $ex (f64.mul (f64.const 0.5) (f64.sub (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))
    (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $ex))) (else (local.get $ex))))`)

  wat('math.cosh', `(func $math.cosh (param $x f64) (result f64)
    (local $ex f64) (local.set $ex (call $math.exp (f64.abs (local.get $x))))
    (f64.mul (f64.const 0.5) (f64.add (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))`)

  wat('math.tanh', `(func $math.tanh (param $x f64) (result f64)
    (local $e2x f64)
    ;; Preserve sign of zero: tanh(±0) = ±0 (the f64.lt sign test below is false for -0).
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 22.0))
      (then (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.const -1.0)) (else (f64.const 1.0))))
      (else (local.set $e2x (call $math.exp (f64.mul (f64.const 2.0) (f64.abs (local.get $x)))))
        (local.set $e2x (f64.div (f64.sub (local.get $e2x) (f64.const 1.0)) (f64.add (local.get $e2x) (f64.const 1.0))))
        (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $e2x))) (else (local.get $e2x))))))`)

  wat('math.asinh', `(func $math.asinh (param $x f64) (result f64)
    ;; ±Infinity and NaN pass through unchanged. (log(±Inf + sqrt(Inf²+1)) → NaN otherwise.)
    (if (i32.eqz (call $math.isFinite (local.get $x))) (then (return (local.get $x))))
    ;; Preserve sign of zero: asinh(±0) = ±0.
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (call $math.log (f64.add (local.get $x) (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0))))))`)

  wat('math.acosh', `(func $math.acosh (param $x f64) (result f64)
    (if (f64.eq (local.get $x) (f64.const inf)) (then (return (f64.const inf))))
    ;; acosh is defined only for x >= 1; everything below (incl. -Inf) is NaN.
    (if (result f64) (f64.lt (local.get $x) (f64.const 1.0)) (then (f64.const nan)) (else
      (call $math.log (f64.add (local.get $x) (f64.sqrt (f64.sub (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0))))))))`)

  wat('math.atanh', `(func $math.atanh (param $x f64) (result f64)
    ;; Preserve sign of zero: atanh(±0) = ±0.
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    ;; ±Infinity → NaN. Without this the (1+x)/(1-x) ratio is Inf/Inf, whose
    ;; sign-nondeterministic arithmetic NaN would escape non-canonical on x86.
    (if (f64.eq (f64.abs (local.get $x)) (f64.const inf)) (then (return (f64.const nan))))
    (f64.mul (f64.const 0.5) (call $math.log (f64.div (f64.add (f64.const 1.0) (local.get $x)) (f64.sub (f64.const 1.0) (local.get $x))))))`)

  wat('math.cbrt', `(func $math.cbrt (param $x f64) (result f64)
    (local $y f64)
    ;; ±Infinity and NaN pass through; preserve sign of zero.
    (if (i32.eqz (call $math.isFinite (local.get $x))) (then (return (local.get $x))))
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (if (result f64) (f64.lt (local.get $x) (f64.const 0.0))
      (then (f64.neg (call $math.cbrt (f64.neg (local.get $x)))))
      (else
        ;; Initial guess via pow, then Newton-Raphson: y = (2y + x/y²)/3
        (local.set $y (call $math.pow (local.get $x) (f64.const 0.3333333333333333)))
        (local.set $y (f64.div (f64.add (f64.mul (f64.const 2.0) (local.get $y)) (f64.div (local.get $x) (f64.mul (local.get $y) (local.get $y)))) (f64.const 3.0)))
        (local.set $y (f64.div (f64.add (f64.mul (f64.const 2.0) (local.get $y)) (f64.div (local.get $x) (f64.mul (local.get $y) (local.get $y)))) (f64.const 3.0)))
        (local.get $y))))`)

  // Small finite-test helper (NaN→0, ±Inf→0, finite→1). Used by transcendental
  // functions that need to short-circuit on infinite inputs.
  wat('math.isFinite', `(func $math.isFinite (param $x f64) (result i32)
    (i32.and
      (f64.eq (local.get $x) (local.get $x))
      (f64.lt (f64.abs (local.get $x)) (f64.const inf))))`)

  wat('math.hypot', `(func $math.hypot (param $x f64) (param $y f64) (result f64)
    ;; Any ±Infinity argument ⇒ +Infinity, even when the other is NaN (ECMA-262 21.3.2.18).
    (if (f64.eq (f64.abs (local.get $x)) (f64.const inf)) (then (return (f64.const inf))))
    (if (f64.eq (f64.abs (local.get $y)) (f64.const inf)) (then (return (f64.const inf))))
    (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.mul (local.get $y) (local.get $y)))))`)

  // xorshift32 → [0,1). In entropy mode a one-shot prologue replaces the fixed
  // initial state with host entropy on first call (branch is well-predicted after).
  const rngSeedPrologue = rngEntropy ? `(if (i32.eqz (global.get $math.rng_seeded))
      (then (global.set $math.rng_state (call $__rng_seed)) (global.set $math.rng_seeded (i32.const 1))))
    ` : ``
  wat('math.random', `(func $math.random (result f64)
    (local $s i32)
    ${rngSeedPrologue}(local.set $s (global.get $math.rng_state))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 13))))
    (local.set $s (i32.xor (local.get $s) (i32.shr_u (local.get $s) (i32.const 17))))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 5))))
    (global.set $math.rng_state (local.get $s))
    (f64.div (f64.convert_i32_u (i32.and (local.get $s) (i32.const 0x7FFFFFFF))) (f64.const 2147483647.0)))`,
    rngEntropy ? ['__rng_seed'] : [])

  wat('math.sumPrecise', `(func $math.sumPrecise (param $arr i64) (result f64)
    ;; Exact summation via a 2304-bit fixed-point accumulator (36 i64 words,
    ;; little-endian two's complement) holding sum*2^1074. Every finite f64 is an
    ;; integer multiple of 2^-1074, so the running sum carries zero rounding
    ;; error; a single ties-to-even rounding at the end yields the result.
    (local $base i32) (local $n i32) (local $i i32) (local $acc i32) (local $addr i32) (local $j i32)
    (local $b i64) (local $exp i32) (local $sig i64) (local $shift i32) (local $wi i32) (local $bo i32)
    (local $lo i64) (local $hi i64) (local $loW i64) (local $hiW i64) (local $ext i64) (local $neg i32)
    (local $carry i32) (local $old i64) (local $s i64) (local $s2 i64) (local $addend i64)
    (local $sawNaN i32) (local $posInf i32) (local $negInf i32) (local $allNegZero i32)
    (local $L i32) (local $word i64) (local $resultNeg i32)
    (local $rwi i32) (local $rbo i32) (local $top i64) (local $roundBit i64) (local $sticky i32) (local $k i32)
    (local $pow f64) (local $res f64)
    ;; allocate + zero 36 i64 words
    (local.set $acc (call $__alloc (i32.const 288)))
    (local.set $j (i32.const 0))
    (block $zdone (loop $zero
      (br_if $zdone (i32.ge_u (local.get $j) (i32.const 288)))
      (i64.store (i32.add (local.get $acc) (local.get $j)) (i64.const 0))
      (local.set $j (i32.add (local.get $j) (i32.const 8)))
      (br $zero)))
    (local.set $allNegZero (i32.const 1))
    (local.set $base (call $__ptr_offset (local.get $arr)))
    (local.set $n (call $__len (local.get $arr)))
    ;; accumulate every element
    (local.set $i (i32.const 0))
    (block $idone (loop $iter
      (br_if $idone (i32.ge_u (local.get $i) (local.get $n)))
      (block $next
        (local.set $b (i64.load (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 3)))))
        (local.set $exp (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const 52)) (i64.const 0x7ff))))
        (local.set $sig (i64.and (local.get $b) (i64.const 0xfffffffffffff)))
        (local.set $neg (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const 63))))
        ;; NaN / +-Infinity
        (if (i32.eq (local.get $exp) (i32.const 0x7ff))
          (then
            (if (i64.ne (local.get $sig) (i64.const 0))
              (then (local.set $sawNaN (i32.const 1)))
              (else (if (local.get $neg)
                (then (local.set $negInf (i32.const 1)))
                (else (local.set $posInf (i32.const 1))))))
            (br $next)))
        ;; -0 tracking: any element not bit-identical to -0 clears allNegZero
        (if (i64.ne (local.get $b) (i64.const 0x8000000000000000))
          (then (local.set $allNegZero (i32.const 0))))
        ;; +-0 contributes nothing
        (if (i32.and (i32.eqz (local.get $exp)) (i64.eqz (local.get $sig)))
          (then (br $next)))
        ;; significand + bit shift: normal adds the implicit bit, shift=exp-1; subnormal shift=0
        (if (i32.eqz (local.get $exp))
          (then (local.set $shift (i32.const 0)))
          (else
            (local.set $sig (i64.or (local.get $sig) (i64.const 0x10000000000000)))
            (local.set $shift (i32.sub (local.get $exp) (i32.const 1)))))
        (local.set $wi (i32.shr_u (local.get $shift) (i32.const 6)))
        (local.set $bo (i32.and (local.get $shift) (i32.const 63)))
        (local.set $lo (i64.shl (local.get $sig) (i64.extend_i32_u (local.get $bo))))
        (local.set $hi (if (result i64) (i32.eqz (local.get $bo))
          (then (i64.const 0))
          (else (i64.shr_u (local.get $sig) (i64.extend_i32_u (i32.sub (i32.const 64) (local.get $bo)))))))
        ;; subtraction of a negative element = adding (~M)+1 with sign-extension ext=-1
        (local.set $ext (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $neg))))
        (local.set $loW (i64.xor (local.get $lo) (local.get $ext)))
        (local.set $hiW (i64.xor (local.get $hi) (local.get $ext)))
        (local.set $carry (local.get $neg))
        (local.set $j (local.get $wi))
        (block $adone (loop $add
          (br_if $adone (i32.ge_u (local.get $j) (i32.const 36)))
          (local.set $addend (select (local.get $loW)
            (select (local.get $hiW) (local.get $ext)
              (i32.eq (local.get $j) (i32.add (local.get $wi) (i32.const 1))))
            (i32.eq (local.get $j) (local.get $wi))))
          (local.set $addr (i32.add (local.get $acc) (i32.shl (local.get $j) (i32.const 3))))
          (local.set $old (i64.load (local.get $addr)))
          (local.set $s (i64.add (local.get $old) (local.get $addend)))
          (local.set $s2 (i64.add (local.get $s) (i64.extend_i32_u (local.get $carry))))
          (local.set $carry (i32.or (i64.lt_u (local.get $s) (local.get $old)) (i64.lt_u (local.get $s2) (local.get $s))))
          (i64.store (local.get $addr) (local.get $s2))
          (local.set $j (i32.add (local.get $j) (i32.const 1)))
          (br $add))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $iter)))
    ;; special results
    (if (local.get $sawNaN) (then (return (f64.const nan))))
    (if (i32.and (local.get $posInf) (local.get $negInf)) (then (return (f64.const nan))))
    (if (local.get $posInf) (then (return (f64.const inf))))
    (if (local.get $negInf) (then (return (f64.neg (f64.const inf)))))
    ;; sign of accumulator = top bit of word 35; negate the magnitude if set
    (local.set $resultNeg (i32.wrap_i64 (i64.shr_u (i64.load (i32.add (local.get $acc) (i32.const 280))) (i64.const 63))))
    (if (local.get $resultNeg) (then
      (local.set $j (i32.const 0))
      (local.set $carry (i32.const 1))
      (block $ndone (loop $negl
        (br_if $ndone (i32.ge_u (local.get $j) (i32.const 36)))
        (local.set $addr (i32.add (local.get $acc) (i32.shl (local.get $j) (i32.const 3))))
        (local.set $old (i64.xor (i64.load (local.get $addr)) (i64.const -1)))
        (local.set $s (i64.add (local.get $old) (i64.extend_i32_u (local.get $carry))))
        (local.set $carry (i64.lt_u (local.get $s) (local.get $old)))
        (i64.store (local.get $addr) (local.get $s))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $negl)))))
    ;; bit length L (scan words high -> low)
    (local.set $L (i32.const 0))
    (local.set $j (i32.const 35))
    (block $ldone (loop $lscan
      (local.set $word (i64.load (i32.add (local.get $acc) (i32.shl (local.get $j) (i32.const 3)))))
      (if (i64.ne (local.get $word) (i64.const 0))
        (then
          (local.set $L (i32.sub (i32.add (i32.mul (local.get $j) (i32.const 64)) (i32.const 64))
            (i32.wrap_i64 (i64.clz (local.get $word)))))
          (br $ldone)))
      (br_if $ldone (i32.eqz (local.get $j)))
      (local.set $j (i32.sub (local.get $j) (i32.const 1)))
      (br $lscan)))
    ;; sum is exactly zero: -0 for empty input or an all-(-0) list, else +0
    (if (i32.eqz (local.get $L)) (then
      (return (if (result f64) (i32.or (i32.eqz (local.get $n)) (local.get $allNegZero))
        (then (f64.reinterpret_i64 (i64.const 0x8000000000000000)))
        (else (f64.const 0))))))
    ;; magnitude fits in 53 bits: exact, scale by 2^-1074 (reinterpret of i64 1)
    (if (i32.le_u (local.get $L) (i32.const 53)) (then
      (local.set $res (f64.mul (f64.convert_i64_u (i64.load (local.get $acc))) (f64.reinterpret_i64 (i64.const 1))))
      (return (select (f64.neg (local.get $res)) (local.get $res) (local.get $resultNeg)))))
    ;; round to nearest f64 (ties-to-even). top 53 bits start at bit L-53.
    (local.set $wi (i32.shr_u (i32.sub (local.get $L) (i32.const 53)) (i32.const 6)))
    (local.set $bo (i32.and (i32.sub (local.get $L) (i32.const 53)) (i32.const 63)))
    (local.set $top (i64.shr_u (i64.load (i32.add (local.get $acc) (i32.shl (local.get $wi) (i32.const 3)))) (i64.extend_i32_u (local.get $bo))))
    (if (i32.ne (local.get $bo) (i32.const 0)) (then
      (local.set $top (i64.or (local.get $top)
        (i64.shl (i64.load (i32.add (local.get $acc) (i32.shl (i32.add (local.get $wi) (i32.const 1)) (i32.const 3))))
          (i64.extend_i32_u (i32.sub (i32.const 64) (local.get $bo))))))))
    (local.set $top (i64.and (local.get $top) (i64.const 0x1fffffffffffff)))
    ;; round bit at L-54, sticky = OR of every lower bit
    (local.set $rwi (i32.shr_u (i32.sub (local.get $L) (i32.const 54)) (i32.const 6)))
    (local.set $rbo (i32.and (i32.sub (local.get $L) (i32.const 54)) (i32.const 63)))
    (local.set $roundBit (i64.and (i64.shr_u (i64.load (i32.add (local.get $acc) (i32.shl (local.get $rwi) (i32.const 3)))) (i64.extend_i32_u (local.get $rbo))) (i64.const 1)))
    (local.set $sticky (i32.const 0))
    (local.set $j (i32.const 0))
    (block $sdone (loop $sscan
      (br_if $sdone (i32.ge_u (local.get $j) (local.get $rwi)))
      (if (i64.ne (i64.load (i32.add (local.get $acc) (i32.shl (local.get $j) (i32.const 3)))) (i64.const 0))
        (then (local.set $sticky (i32.const 1))))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $sscan)))
    (if (i64.ne (i64.and (i64.load (i32.add (local.get $acc) (i32.shl (local.get $rwi) (i32.const 3))))
                         (i64.sub (i64.shl (i64.const 1) (i64.extend_i32_u (local.get $rbo))) (i64.const 1)))
                (i64.const 0))
      (then (local.set $sticky (i32.const 1))))
    (if (i32.and (i64.eq (local.get $roundBit) (i64.const 1))
                 (i32.or (local.get $sticky) (i32.wrap_i64 (i64.and (local.get $top) (i64.const 1)))))
      (then (local.set $top (i64.add (local.get $top) (i64.const 1)))))
    ;; result = top * 2^k where k is the exponent of top's low bit
    (local.set $k (i32.sub (local.get $L) (i32.const 1127)))
    (if (i32.ge_s (local.get $k) (i32.const 1024)) (then
      (return (select (f64.neg (f64.const inf)) (f64.const inf) (local.get $resultNeg)))))
    (local.set $pow (if (result f64) (i32.ge_s (local.get $k) (i32.const -1022))
      (then (f64.reinterpret_i64 (i64.shl (i64.extend_i32_u (i32.add (local.get $k) (i32.const 1023))) (i64.const 52))))
      (else (f64.reinterpret_i64 (i64.shl (i64.const 1) (i64.extend_i32_u (i32.add (local.get $k) (i32.const 1074))))))))
    (local.set $res (f64.mul (f64.convert_i64_u (local.get $top)) (local.get $pow)))
    (select (f64.neg (local.get $res)) (local.get $res) (local.get $resultNeg)))`)

  // Global for random state — seeded with the fixed constant (deterministic) or,
  // in entropy mode, overwritten from the host on first Math.random() call.
  declGlobal('math.rng_state', 'i32', rngSeedConst)
  if (rngEntropy) {
    declGlobal('math.rng_seeded', 'i32')
    // One i32 of host entropy, floored at 1 (xorshift32 is dead at state 0).
    wat('__rng_seed', ctx.transform.host === 'wasi'
      ? `(func $__rng_seed (result i32)
    (local $buf i32) (local $s i32)
    (local.set $buf (call $__alloc (i32.const 4)))
    (drop (call $__random_get (local.get $buf) (i32.const 4)))
    (local.set $s (i32.load (local.get $buf)))
    (select (local.get $s) (i32.const 1) (local.get $s)))`
      : `(func $__rng_seed (result i32)
    (local $s i32)
    (local.set $s (call $__env_rng_seed))
    (select (local.get $s) (i32.const 1) (local.get $s)))`,
      ctx.transform.host === 'wasi' ? ['__alloc'] : [])
  }
}
