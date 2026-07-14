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
import { inc, declGlobal, err } from '../src/ctx.js'
import { repOf, VAL } from '../src/reps.js'
import { valTypeOf } from '../src/kind.js'

export default (ctx) => {
  // `**`/Math.pow kernel select — see the single authoritative comment block just above
  // `emitPow` (below) for full crPow/approxPow semantics. Read once here; every other site
  // (deps table, pow_core/pow_fold/pow_fold_v dual bodies) just branches on this.
  const crPow = !!ctx.transform.optimize?.crPow
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
    'math.pow': ['math.pow_core'],
    'math.pow_core': crPow ? ['math.pow_transcend'] : ['math.pow_scalbn'],
    'math.pow_scalbn': [],
    // math.pow_transcend/math.pow_fold only exist (are registered as wat() templates below) when
    // optimize.crPow is set — see the authoritative comment above emitPow. Declaring their deps
    // unconditionally here is harmless when crPow is off: nothing ever inc()s 'math.pow_fold' in
    // that mode (emitPow's const-exponent branch calls $math.exp/$math.log instead), so this edge
    // is simply never traversed.
    'math.pow_transcend': ['math.pow_scalbn'],
    'math.pow_fold': ['math.pow_transcend'],
    'math.asin': [],
    'math.acos': ['math.asin'],
    'math.atan2': ['math.atan'],
    'math.sinh': ['math.exp'],
    'math.cosh': ['math.exp'],
    'math.tanh': ['math.exp'],
    'math.asinh': ['math.isFinite', 'math.log'],
    'math.acosh': ['math.log'],
    'math.atanh': ['math.log'],
    'math.cbrt': ['math.isFinite'],
    'math.fifthroot': ['math.isFinite'],
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

  // Constants — each folds to its `(f64.const …)` inline (no stdlib dep, hence
  // direct emit rather than reg). Written out (not a `Math[name]` loop) because the
  // self-host subset can't resolve dynamic access on the `Math` compile-time namespace.
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
  // ES2025 Math.f16round — no wasm f16 ops, so round in software (exactly).
  reg('math.f16round', ['math.f16round'], a => fn('math.f16round', a))

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
    // BigInt ** is real JS (2n ** 3n === 8n) but unimplemented — the f64 pow
    // pipeline would reinterpret raw i64 bits. Reject instead of silent garbage.
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      err('BigInt exponentiation (`**`) not supported — use a multiply loop or Number(x)')
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
    //   OFF (DEFAULT, today's shipped behavior, bit-for-bit): exp(c·log(x)) — that IS $math.pow's
    //     own non-integer tail (the final line of $math.pow below), so it is BIT-IDENTICAL to the
    //     call for every finite x and for x ∈ {±0, +∞, NaN}: log+exp carry the edges (log(NaN)=NaN,
    //     log(0)=−∞, log(<0)=NaN, log(+∞)=+∞; exp(±∞)=∞/0). The ONE divergence is x=−∞: this
    //     yields NaN where Math.pow gives ±∞ — the same deliberate boundary trade jz already makes
    //     for `(−∞)**0.5` (see the sqrt fold above); −∞ is never a real tone-map/gamma base. The
    //     k/5-exponent gammas (sRGB/Rec.709 decode, 2.4/2.2/…) skip log/exp entirely via an
    //     UNCONDITIONAL algebraic fifthroot fold (x^(k/5) = x^p·fifthroot(x^r), p=⌊c⌋, r=5c−5p ∈
    //     1..4, ~3.6e-10 rel err, not correctly rounded, measured worst case ~473ulp
    //     test/fifthroot-ulp.js) — this was always the plain-build behavior and stays so.
    //   ON: the constant exponent instead routes through $math.pow_fold, which shares
    //     $math.pow_transcend's two-phase Ziv dd/td kernel with the runtime-y path $math.pow_core
    //     uses when crPow is on (see $math.pow_transcend's own comment for the algorithm) —
    //     CORRECTLY ROUNDED (0 misrounds on the 5152-vector CORE-MATH-class gate,
    //     test/pow-cr.js). c needs no pre-split: the shared kernel's multiply is a twoProd-based
    //     exact product (Dekker-splits BOTH operands internally), so the call is just x and the
    //     f64.const literal c. HONEST COST: measured ~13x the default exp∘log fold's runtime on
    //     the gamma-heavy color benches (colorpq 13.6x behind V8 under crPow, vs ~1x today) —
    //     correctness has a real price, so this stays opt-in rather than default
    //     (`{ optimize: { crPow: true } }`). Under crPow, the fifthroot fast path is ALSO opt-in
    //     rather than automatic (`{ optimize: { approxPow: true } }`, default OFF): correctness
    //     wins by default once crPow has opted into the correctly-rounded kernel family — a
    //     caller who wants both speed AND crPow's runtime-y correctness sets both flags.
    if (isLit(irB)) {
      const c = litVal(irB)
      // Finite x<0 → NaN to match Math.pow on a non-integer exponent (the exp·log form's
      // log(<0)=NaN). x=-Infinity is its OWN case, not "negative": |x|=Infinity means Math.pow
      // ignores the sign for a non-integer exponent (c > 0 in this branch's guard, so the result
      // is +Infinity). x=+0/-0/+∞/NaN carry correctly through power + fifthroot.
      const fifthrootGate = crPow ? ctx.transform.optimize?.approxPow : true
      if (fifthrootGate && Number.isFinite(c) && c > 0 && c < 5 && !Number.isInteger(c) && Number.isInteger(c * 5)) {
        inc('math.fifthroot')
        const t = temp('pw'), g = get(t)
        const ipow = (k) => k === 1 ? g : k === 2 ? ['f64.mul', g, g]
          : k === 3 ? ['f64.mul', ['f64.mul', g, g], g] : ['f64.mul', ['f64.mul', g, g], ['f64.mul', g, g]]  // k ∈ 1..4
        const p = Math.floor(c), r = Math.round(c * 5) - p * 5
        const root = ['call', '$math.fifthroot', ipow(r)]
        const body = p === 0 ? root : ['f64.mul', ipow(p), root]
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${t}`, irA],
          ['if', ['result', 'f64'], ['f64.eq', g, ['f64.const', '-inf']],
            ['then', ['f64.const', 'inf']],
            ['else', ['if', ['result', 'f64'], ['f64.lt', g, ['f64.const', 0]],
              ['then', ['f64.const', 'nan']], ['else', body]]]]], 'f64')
      }
      if (crPow) {
        if (Number.isFinite(c) && !Number.isInteger(c) && c !== 0.5 && c !== -0.5) {
          inc('math.pow_fold')
          // c needs no hi/lo pre-split: $math.pow_fold shares $math.pow_transcend's kernel,
          // which exact-multiplies via twoProd (Dekker split done ON BOTH operands inside the
          // kernel) rather than fdlibm's manual y1/y2 chop — so a single f64.const suffices.
          return typed(['call', '$math.pow_fold', irA, ['f64.const', c]], 'f64')
        }
      } else if (Number.isFinite(c) && !Number.isInteger(c) && c !== 0.5 && c !== -0.5) {
        return (inc('math.exp'), inc('math.log'),
          typed(['call', '$math.exp', ['f64.mul', irB, ['call', '$math.log', irA]]], 'f64'))
      }
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
  // Range-reduction constants via plain number interpolation: `${number}` now formats
  // through the Ryū shortest-round-trip __ftoa in BOTH legs (host and self-hosted
  // kernel), so the full-precision f64 bakes into the WAT verbatim — the former
  // string-literal workaround for the kernel's 9-digit dtoa is obsolete.
  const PI = Math.PI, INV_PI = 1 / Math.PI, HALF_PI = Math.PI / 2

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
  const horner2 = (cs, v = '$r2') => cs.reduceRight((acc, c, i) =>
    i === cs.length - 1 ? splat(c)
      : `(f64x2.add ${splat(c)} (f64x2.mul (local.get ${v}) ${acc}))`, '')
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
  // pow has no cheap 2-lane polynomial (it is exp(y·ln x) with cancellation-sensitive reductions),
  // so the f64x2 mirror computes each lane with the scalar $math.pow and repacks — BIT-EXACT by
  // construction. No transcendental speedup, but it keeps a pow-bearing pixel kernel's surrounding
  // f64x2 arithmetic vectorized (the per-pixel-color pass only emits this when a truly-2-wide op —
  // sin2/cos2/sqrt — already justifies the pair, so the extract/repack never makes a kernel slower).
  wat('math.pow2', `(func $math.pow2 (param $x v128) (param $y v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.pow (f64x2.extract_lane 0 (local.get $x)) (f64x2.extract_lane 0 (local.get $y))))
      (call $math.pow (f64x2.extract_lane 1 (local.get $x)) (f64x2.extract_lane 1 (local.get $y)))))`, ['math.pow'])

  // $math.pow_fold_v — SIMD twin of $math.pow_fold, ONLY registered under optimize.crPow (that
  // fold itself only exists then — see the authoritative comment above emitPow). Per-lane scalar
  // repack — BIT-EXACT by construction, no cheap 2-lane polynomial for the branchy fdlibm-style
  // dd/td kernel — and it keeps a constant-exponent-pow-bearing pixel kernel's surrounding f64x2
  // arithmetic vectorized exactly like pow2/atan2_2/hypot_2/cbrt_v/fifthroot_v already do for
  // their own callees. c arrives as v128 (every PPC_CALL2 arg is lifted through the generic splat
  // path — see src/optimize/vectorize.js), but every lane holds the SAME compile-time constant,
  // so extracting lane 0 for both scalar calls is exact. Off crPow, the vectorizer's own
  // const-exponent lift (vectorize.js) uses $math.exp_v/$math.log_v directly instead — no mirror
  // needed here, matching the default exp(c·log(x)) fold's own shape.
  if (crPow) {
    wat('math.pow_fold_v', `(func $math.pow_fold_v (param $x v128) (param $c v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.pow_fold
        (f64x2.extract_lane 0 (local.get $x))
        (f64x2.extract_lane 0 (local.get $c))))
      (call $math.pow_fold
        (f64x2.extract_lane 1 (local.get $x))
        (f64x2.extract_lane 1 (local.get $c)))))`, ['math.pow_fold'])
  }

  // atan2/hypot/log have no cheap 2-lane polynomial (multi-`return` fdlibm bodies), so — like pow2 —
  // each f64x2 mirror computes both lanes with the SCALAR helper and repacks: BIT-EXACT by
  // construction. The per-pixel-color pass only emits these when a truly-2-wide op (sin2/cos2/sqrt)
  // already justifies the f64x2 pair, so the extract/repack never makes a kernel slower.
  // NOTE: names avoid the $math.log2/$math.exp2 collision (those are log-/exp-BASE-2).
  wat('math.atan2_2', `(func $math.atan2_2 (param $y v128) (param $x v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.atan2 (f64x2.extract_lane 0 (local.get $y)) (f64x2.extract_lane 0 (local.get $x))))
      (call $math.atan2 (f64x2.extract_lane 1 (local.get $y)) (f64x2.extract_lane 1 (local.get $x)))))`, ['math.atan2'])
  wat('math.hypot_2', `(func $math.hypot_2 (param $x v128) (param $y v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.hypot (f64x2.extract_lane 0 (local.get $x)) (f64x2.extract_lane 0 (local.get $y))))
      (call $math.hypot (f64x2.extract_lane 1 (local.get $x)) (f64x2.extract_lane 1 (local.get $y)))))`, ['math.hypot'])
  // cbrt/fifthroot: same per-lane scalar repack (their scalar bodies are branchy exponent-split +
  // Newton, no cheap 2-lane poly). BIT-EXACT by construction. Unlocks the Oklab/OkLCh path (3 cbrt
  // per pixel) and the sRGB/Rec.709 `x**(k/5)` gamma so their surrounding f64x2 arithmetic vectorizes.
  wat('math.cbrt_v', `(func $math.cbrt_v (param $x v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.cbrt (f64x2.extract_lane 0 (local.get $x))))
      (call $math.cbrt (f64x2.extract_lane 1 (local.get $x)))))`, ['math.cbrt'])
  wat('math.fifthroot_v', `(func $math.fifthroot_v (param $x v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.fifthroot (f64x2.extract_lane 0 (local.get $x))))
      (call $math.fifthroot (f64x2.extract_lane 1 (local.get $x)))))`, ['math.fifthroot'])
  // True f64x2 log — both lanes through one fdlibm poly (≈2× over two scalar calls). The HOT path
  // (both lanes a normal finite x>0) mirrors $math.log's normal branch op-for-op: bit-exact (the
  // sqrt2-center conditional becomes a per-lane bitselect; the i32 exponent k becomes an f64 via the
  // 2^52 magic-add, identical to convert_i32_s for |k|≤1075). Any other lane (≤0/∞/NaN/denormal)
  // routes BOTH lanes to the scalar fallback → bit-exact by construction, edges never lose precision.
  wat('math.log_v', `(func $math.log_v (param $x v128) (result v128)
    (local $k v128) (local $m v128) (local $mask v128) (local $s v128) (local $z v128)
    (if (result v128)
      (i64x2.all_true (v128.and
        (f64x2.ge (local.get $x) (f64x2.splat (f64.const 0x1p-1022)))
        (f64x2.lt (local.get $x) (f64x2.splat (f64.const inf)))))
      (then
        (local.set $k (f64x2.sub
          (v128.or (v128.and (i64x2.shr_u (local.get $x) (i32.const 52)) (i64x2.splat (i64.const 0x7ff)))
                   (i64x2.splat (i64.const 0x4330000000000000)))
          (f64x2.splat (f64.const 4503599627371519))))
        (local.set $m (v128.or (v128.and (local.get $x) (i64x2.splat (i64.const 0x000fffffffffffff))) (i64x2.splat (i64.const 0x3ff0000000000000))))
        (local.set $mask (f64x2.ge (local.get $m) (f64x2.splat (f64.const 1.4142135623730951))))
        (local.set $m (v128.bitselect (f64x2.mul (local.get $m) (f64x2.splat (f64.const 0.5))) (local.get $m) (local.get $mask)))
        (local.set $k (f64x2.add (local.get $k) (v128.and (local.get $mask) (f64x2.splat (f64.const 1.0)))))
        ;; mirrors scalar $math.log op-for-op (same constants/order) → bit-exact lanes
        (local.set $s (f64x2.div (f64x2.sub (local.get $m) (f64x2.splat (f64.const 1.0))) (f64x2.add (local.get $m) (f64x2.splat (f64.const 1.0)))))
        (local.set $z (f64x2.mul (local.get $s) (local.get $s)))
        (f64x2.add
          (f64x2.mul (local.get $k) (f64x2.splat (f64.const ${Math.LN2})))
          (f64x2.mul (f64x2.mul (f64x2.splat (f64.const 2.0)) (local.get $s))
            (f64x2.add (f64x2.splat (f64.const 1.0))
              (f64x2.mul (local.get $z)
                (f64x2.add (f64x2.splat (f64.const 0.33333333283005556))
                  (f64x2.mul (local.get $z)
                    (f64x2.add (f64x2.splat (f64.const 0.20000059590510924))
                      (f64x2.mul (local.get $z)
                        (f64x2.add (f64x2.splat (f64.const 0.14275490984342690))
                          (f64x2.mul (local.get $z) (f64x2.splat (f64.const 0.11663796426848184)))))))))))))
      (else
        (f64x2.replace_lane 1
          (f64x2.splat (call $math.log (f64x2.extract_lane 0 (local.get $x))))
          (call $math.log (f64x2.extract_lane 1 (local.get $x)))))))`, ['math.log'])

  // True f64x2 exp2 — hot path (round(y) ∈ (−1023,1024), the normal-result range) mirrors $math.exp2's
  // single-IEEE-build branch op-for-op (Horner over f=y−round(y), 2^k via (k+1023)<<52); edges
  // (overflow/underflow/denormal/NaN) route both lanes to the scalar fallback → bit-exact.
  wat('math.exp2_v', `(func $math.exp2_v (param $y v128) (result v128)
    (local $k v128) (local $f v128)
    (local.set $k (f64x2.nearest (local.get $y)))
    (if (result v128)
      (i64x2.all_true (v128.and
        (f64x2.gt (local.get $k) (f64x2.splat (f64.const -1023)))
        (f64x2.lt (local.get $k) (f64x2.splat (f64.const 1024)))))
      (then
        (local.set $f (f64x2.sub (local.get $y) (local.get $k)))
        (f64x2.mul ${horner2(EXP2_C, '$f')}
          (i64x2.shl (i64x2.add
            (i64x2.extend_low_i32x4_s (i32x4.trunc_sat_f64x2_s_zero (local.get $k)))
            (i64x2.splat (i64.const 1023))) (i32.const 52))))
      (else
        (f64x2.replace_lane 1
          (f64x2.splat (call $math.exp2 (f64x2.extract_lane 0 (local.get $y))))
          (call $math.exp2 (f64x2.extract_lane 1 (local.get $y)))))))`, ['math.exp2'])

  // e^x = 2^(x·log2e) — defers to exp2_v exactly as scalar $math.exp defers to $math.exp2. Bit-exact.
  wat('math.exp_v', `(func $math.exp_v (param $x v128) (result v128)
    (call $math.exp2_v (f64x2.mul (local.get $x) (f64x2.splat (f64.const ${Math.LOG2E})))))`, ['math.exp2_v'])

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
      (f64.mul (f64.mul (f64.const 2.0) (local.get $s))
        (f64.add (f64.const 1.0)
          (f64.mul (local.get $z)
            (f64.add (f64.const 0.33333333283005556)
              (f64.mul (local.get $z)
                (f64.add (f64.const 0.20000059590510924)
                  (f64.mul (local.get $z)
                    (f64.add (f64.const 0.14275490984342690)
                      (f64.mul (local.get $z) (f64.const 0.11663796426848184)))))))))))))`)

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


  // The entire correctly-rounded kernel below (codegen helpers, breakpoint tables, and the
  // $math.pow_transcend registration itself) is built and registered ONLY when `optimize.crPow`
  // is set — see the authoritative crPow/approxPow comment above `emitPow` for why it's opt-in
  // (honest cost: ~13x the old fold's runtime on gamma-heavy color kernels). Gating the whole
  // section (not just the wat() registration) means a plain build pays zero JS-side cost for
  // table-hex construction / codegen generation, and $math.pow_transcend never enters
  // ctx.core.stdlib at all — so it can't accidentally leak into a default-build's includes set.
  if (crPow) {
  // ============================================
  // Correctly-rounded pow: two-phase Ziv dd/td kernel
  // ============================================
  // $math.pow_transcend(x,y) — x>0 finite, y finite nonzero (the transcendental tail both
  // $math.pow_core (runtime y) and $math.pow_fold (compile-time-constant y) delegate to, once
  // their own special-case ladders rule out NaN/±Inf/±0/x<0/y==0/±1/integer-in-i32-range/y==
  // ±0.5). Ported from a from-scratch double-double/triple-double design (NOT fdlibm's e_pow.c
  // — that algorithm targets ~1ulp, not correct rounding, and the earlier fdlibm-ported
  // $math.pow_core missed 8.2% of the CR vector gate; see test/pow-cr.js), using a Ziv rounding
  // test to promote from cheap double-double (phase 1) to triple-double (phase 2) only when
  // phase 1's own error bound can't certify the final rounding. Design + derivation fully
  // worked out and differentially validated (5152/5152 gate vectors + 26k targeted adversarial
  // + 150k general-random cases, 0 misrounds) in scratchpad/pow/ before this port — see
  // pow_dd.mjs (the reference prototype every WAT line here mirrors 1:1) and its measurement
  // scripts (measure_log2_abs.py, measure_exp2_unscaled.py) for the error-bound derivations
  // cited below.
  //
  // ALGORITHM (both phases share this shape, at k=2 (dd) or k=3 (td) limbs):
  //   1. log2(x) to k-limb precision: bit-extract x=m·2^kexp (m∈[1,2)), look up the table
  //      breakpoint m0_j nearest m (top-8-mantissa-bit index j, LOG2_TABLE — 256 entries ×
  //      k-limb log2(1+j/256), injected as a linear-memory data table, see injectTable in
  //      src/wat/assemble.js — same mechanism as module/number.js's Eisel-Lemire/Ryū tables),
  //      then log2(x) = kexp + log2(m0_j) + log2(1+r) where r=(m-m0_j)/m0_j (|r|<2^-8, so a
  //      short Horner series converges fast — LOG_SERIES, Mercator ln(1+r) coefficients).
  //      CANCELLATION FIX: when m>=1.5 (j>=128), regroup as (kexp+1)+(log2(m0_j)-1)+log2(1+r)
  //      instead of kexp+log2(m0_j)+log2(1+r) — both are the same value (subtracting the exact
  //      integer 1 from a k-limb value is lossless), but the regrouped form never lets two O(1)
  //      quantities nearly cancel down to a near-zero log2(x) (x close to a power of 2): the
  //      naive form loses up to ~50 bits there since the k-limb fold's error is bounded
  //      relative to the DISCARDED O(1) input magnitude, not the tiny post-cancellation output.
  //   2. Multiply by y (exact-ish via twoProd, which Dekker-splits BOTH operands — no manual
  //      y1/y2 pre-split needed, unlike fdlibm/the old $math.pow_fold's c1/c2 params).
  //   3. 2^L via the same shape: round to nearest integer n (f64.nearest — IEEE round-ties-to-
  //      even, spliced back in via $math.pow_scalbn), then a 256-point sub-table (EXP2_TABLE,
  //      2^(idx/256) for idx∈[-128,127]) plus a short Horner series (EXP_SERIES, e^u
  //      coefficients with ln2 powers folded in) on the doubly-reduced fraction.
  //   4. ROUNDING TEST: eps = |y|·LOG2_ABS_ERR[k]·ln2 + EXP2_REL_ERR[k], applied as
  //      |result_hi|·eps to the k-limb result. LOG2_ABS_ERR is an ABSOLUTE bound on step 1's
  //      error (measured empirically, ~uniform over x — dd 2^-77.15, td 2^-148.2, before an
  //      8+ bit margin), scaled by |y| because step 2 turns a fixed absolute log2(x) error
  //      into an absolute error in L=y·log2(x) that GROWS WITH |y| — this is the term a naive
  //      "eps=|result|*E" misses: when x is adversarially close to a power of 2 (log2(x) tiny)
  //      and y is huge, |L| can stay modest even as |y|→huge, so bounding eps off the RESULT's
  //      own magnitude alone silently understates the true uncertainty by a factor of
  //      |y|·log2(x)/L. (Confirmed the hard way: x=1-2^-53, y=1e18 missed by 8 ulps under the
  //      naive formula; 0 misses with this one, across every stress set above.) EXP2_REL_ERR
  //      is step 3's own relative error (dd 2^-72.55, td 2^-156.9, unscaled — the final ·2^n
  //      splice via $math.pow_scalbn is a separate, already-exact staged multiply, musl
  //      scalbn.c, adding none). d(2^L)/dL = 2^L·ln2 converts L's absolute error to the
  //      result's relative error, hence the ln2 factor. PHASE-1 COST: the dd Horner series
  //      (steps 1 and 3) uses a CHEAP HYBRID — the dominant correction term is kept at full dd
  //      precision (one extra mulExt) but the rest of the series runs in plain f64 on the
  //      leading limb, since a fully-plain series measured only ~2^-69 (too loose for
  //      colorpq's own PQ exponents — ~47% phase-2 escalation there) while a fully-rigorous
  //      dd Horner chain (every term compensated) made phase 1 ~28x slower than the fdlibm
  //      kernel it replaced. This hybrid is the measured middle ground — see powLog1pCheapGen's
  //      and the exp2 P-series' own comments below.
  //   5. If phase 1 (dd) can't certify: recompute at phase 2 (td). Phase 2 is expected to
  //      ALWAYS certify (0 uncertain-after-phase-2 cases across every validation set) — if it
  //      doesn't, this returns its best-effort value rather than nothing (see the mission
  //      note: an uncertain result here would mean the gate found a case beyond what
  //      scratchpad/pow/ discovered, worth its own report, not a silent wrong answer).
  //
  // |y| > 1e20 short-circuits BEFORE any of the above: the smallest possible |log2(x)| for
  // finite x>0,x!=1 is ~1.6e-16 (x adjacent to 1), so |y|>1100/1.6e-16~=6.9e18 already forces
  // definite overflow/underflow — 1e20 keeps ~15x margin above that while staying far under
  // ~1.34e300, where twoProd's internal Veltkamp split (SPLITTER·y) would itself overflow to
  // Infinity and corrupt the multiply. x==1 is handled explicitly there too (pow_fold has no
  // x==1 pre-check of its own — it relies on log2(1)=0 exactly zeroing the product for ANY y,
  // which the main kernel already gives it, but the |y|>1e20 short-circuit bypasses the main
  // kernel entirely so needs its own x==1 case).
  const POW_LOG2_T = 8, POW_EXP2_T = 8
  const POW_LOG_N_DD = 9, POW_LOG_N_TD = 18, POW_EXP_N_DD = 8, POW_EXP_N_TD = 15
  // dd (k=2) bounds measured for the CHEAP-HYBRID phase-1 Horner below (leading correction
  // term at DD precision via one extra mulExt, tail terms plain-f64): worst dd log2 abs err
  // 2^-77.15, dd exp2 rel err 2^-72.55 over a 15k+-point sweep incl. subnormals/adversarial
  // near-power-of-2 x (scratchpad/pow/measure_log2_abs.py, measure_exp2_unscaled.py) — ~9
  // bits margin below each. An all-plain-tail version (no DD leading-correction term) measured
  // only 2^-68.97 / 2^-71.27 — too loose for colorpq's own PQ exponents (~47% phase-2
  // escalation measured there, worse than the expensive full-rigor path it replaced); this
  // hybrid recovers the needed precision for one extra mulExt (~35 ops) instead of the full
  // ~(N-1)-deep dd Horner chain (~300+ ops) it replaces. td (k=3) unchanged: phase 2 still
  // uses the fully-rigorous Horner (powHornerExt).
  const POW_LOG2_ABS_ERR = { 2: 2 ** -68, 3: 2 ** -138 }
  const POW_EXP2_REL_ERR = { 2: 2 ** -64, 3: 2 ** -146 }
  // Mercator ln(1+r) coefficients (r^1..r^18), each a 3-limb (hi,mid,lo) f64 expansion —
  // uniform 3-limb treatment (not just enough for dd) avoids per-coefficient precision
  // bookkeeping: a plain-f64 a2..a4 would itself cap the td rounding-test budget at ~2^-114
  // (worked by hand: a coefficient's contribution to total relative error is
  // a_i·r^(i-1)·(coefficient's own rel. error), and for i=2..4 with |r|<=2^-8 that leaves only
  // ~50-70 bits of slack from a plain double) — 3-limb coefficients remove that risk entirely
  // at zero extra runtime cost (dd just reads the hi limb). Generated by
  // scratchpad/pow/gen_tables.py (mpmath, 400-bit) — verified against the CR vector gate, not
  // hand-derived.
  const POW_LOG_SERIES = [
    [1, 0, 0],
    [-0.5, 0, 0],
    [0.3333333333333333, 1.850371707708594e-17, 1.0271626370065257e-33],
    [-0.25, 0, 0],
    [0.2, -1.1102230246251566e-17, 6.162975822039155e-34],
    [-0.16666666666666666, -9.25185853854297e-18, -5.135813185032629e-34],
    [0.14285714285714285, 7.93016446160826e-18, 4.4021255871708246e-34],
    [-0.125, 0, 0],
    [0.1111111111111111, 6.1679056923619804e-18, 3.423875456688419e-34],
    [-0.1, 5.551115123125783e-18, -3.0814879110195775e-34],
    [0.09090909090909091, -2.523234146875356e-18, 7.003381615953585e-35],
    [-0.08333333333333333, -4.625929269271485e-18, -2.5679065925163143e-34],
    [0.07692307692307693, -4.270088556250602e-18, 2.370375316168906e-34],
    [-0.07142857142857142, -3.96508223080413e-18, -2.2010627935854123e-34],
    [0.06666666666666667, 9.251858538542971e-19, 1.2839532962581572e-35],
    [-0.0625, 0, 0],
    [0.058823529411764705, 8.163404592832033e-19, 1.1328999672866093e-35],
    [-0.05555555555555555, -3.0839528461809902e-18, -1.7119377283442096e-34]]
  // 2^r2 coefficients (r2^0..r2^15): b_k = ln2^k/k!, so the series is directly in the reduced
  // fraction r2 (no separate u=r2·ln2 extended multiply needed). Same uniform-3-limb rigor.
  const POW_EXP_SERIES = [
    [1, 0, 0],
    [0.6931471805599453, 2.3190468138462996e-17, 5.707708438416212e-34],
    [0.24022650695910072, -9.493931253182876e-18, -2.4105486965696903e-34],
    [0.05550410866482158, -3.1658222903912804e-18, 1.1357423645400287e-34],
    [0.009618129107628477, 2.8324606784381e-19, 1.85284146980722e-35],
    [0.0013333558146428443, 1.3928059563172586e-20, -7.148318211080472e-37],
    [0.0001540353039338161, 1.1783618439907562e-20, 4.5910849836706486e-38],
    [0.000015252733804059841, -8.027446755055875e-22, -3.3547393057817446e-38],
    [0.000001321548679014431, -2.0162732323629023e-24, 1.2689094913973184e-40],
    [1.01780860092397e-7, -1.949520713756723e-24, 9.914912572246126e-41],
    [7.054911620801123e-9, -2.9110453965609406e-26, 1.2702853147779823e-42],
    [4.4455382718708116e-10, -1.2731051485060954e-26, 4.420326254448758e-43],
    [2.5678435993488206e-11, -3.6970912098302563e-28, 1.7132265077294294e-44],
    [1.3691488853904128e-12, 7.770795328665668e-29, 4.5200006429723875e-45],
    [6.778726354822545e-14, 5.7164033621144854e-30, 2.4988036368119357e-47],
    [3.1324367070884287e-15, -3.9318558140598756e-32, -2.0482463830537468e-48],
    [1.3570247948755148e-16, -1.057117616368963e-32, -1.512313747717571e-49]]
  const POW_LOG2E = [1.4426950408889634, 2.0355273740931033e-17, -1.0614659956117258e-33]   // 1/ln2, 3-limb

  // ---- WAT codegen: EFT (error-free transform) primitives, no FMA (Dekker splits) ----
  // A Builder accumulates a statement list (nested — if/then/else bodies build with
  // sub-scopes, `B.sub()`, and splice into the parent as `(then ${sub.stmts.join(' ')})`).
  //
  // REGISTER POOL (not one fresh local per intermediate value): `tmp()` used to mint a
  // brand-new WASM local for every single EFT micro-step — twoSum alone burns 3, twoProd 7,
  // and a k-limb Horner chains dozens of these per term. For $math.pow_transcend that summed
  // to ~7000 locals, and both the wasm engine's own compiler and jz's THIS ADD MADE
  // codegen/optimize passes pay for it: colorpq measured ~15x the old fdlibm kernel's time,
  // and a pow-using program's OWN compile time went ~0.1s -> ~4.1s. WASM locals are
  // function-scoped, not block-scoped, so distinct intermediates can share one physical slot
  // once the earlier one's last use has passed — a classic linear-scan register allocation,
  // done here as a two-pass token scheme instead of hand-tracking free lists at every call
  // site (that would be exactly as error-prone as the bug it's fixing):
  //   PASS 1 (this Builder): `tmp()` does NOT pick a real local name. It mints a UNIQUE ID,
  //   emits `(local.set \x01ID\x02 expr)` into the statement stream, and returns
  //   `(local.get \x01ID\x02)` for the caller to embed in later expressions — U+0001/U+0002
  //   control chars so a token can never collide with real WAT text or another token's digits.
  //   Text order here IS execution order (statements append in the order they run; the one
  //   place order gets locally inverted — a `(local.set TARGET expr)` prints TARGET before
  //   expr's own operand reads, though expr evaluates first at runtime — only costs a missed
  //   same-statement reuse opportunity, e.g. `x = a+a` not sharing a's slot with x; it never
  //   causes an early free, because freeing is keyed off each id's PRECOMPUTED true last-use
  //   position, not scan position — see powResolvePool).
  //   PASS 2 (`powResolvePool`, called once on the fully-assembled function body): scan for
  //   every token, resolve each id's real last use, walk the text again allocating a small
  //   per-type register file (separate pools for f64/i32/i64 — a value can only reuse a
  //   same-typed slot), freeing a register the instant its id's last use is seen. Mutable
  //   locals (below) are NOT pooled — they're few, and their whole point is surviving across
  //   sub-scopes, so they keep stable dedicated names exactly as before.
  const POW_TOK_1 = '\x01', POW_TOK_2 = '\x02'
  const powMkBuilder = (prefix, shared) => {
    shared ??= { n: 0, type: {}, mutDecls: [] }
    const stmts = []
    const tmp = (expr, type = 'f64') => {
      const id = shared.n++
      shared.type[id] = type
      const tok = `${POW_TOK_1}${id}${POW_TOK_2}`
      stmts.push(`(local.set ${tok} ${expr})`)
      return `(local.get ${tok})`
    }
    // .set returns the STATEMENT STRING (does not push itself) — a mutable local is
    // typically declared in one scope but assigned from several (if/then/else sub-scopes),
    // so the caller must explicitly `.raw()` the result onto whichever scope is active.
    const mutable = (base, type = 'f64') => {
      const name = `$${prefix}_${base}${shared.n++}`
      shared.mutDecls.push(`(local ${name} ${type})`)
      return { name, get: `(local.get ${name})`, set: (expr) => `(local.set ${name} ${expr})` }
    }
    const raw = (s) => stmts.push(s)
    const sub = (p) => powMkBuilder(p ?? prefix, shared)
    return { tmp, mutable, raw, sub, stmts, mutDecls: shared.mutDecls, type: shared.type }
  }
  // Pass 2 of the register pool (see the Builder comment above): resolve every \x01id\x02
  // token in `text` to a real, REUSED local name. Returns the extra `(local ...)` decls the
  // pool needs (concat with the mutable-local decls already collected) and the resolved text.
  const powResolvePool = (text, typeOf) => {
    const tokenRe = /local\.(set|get) \x01(\d+)\x02/g
    const events = []
    for (let m; (m = tokenRe.exec(text));) events.push({ isSet: m[1] === 'set', id: +m[2], at: m.index })
    const lastUse = {}
    for (const e of events) if (!e.isSet) lastUse[e.id] = e.at   // last (highest-index) 'get' wins
    const free = { f64: [], i32: [], i64: [] }, next = { f64: 0, i32: 0, i64: 0 }, regOf = {}
    for (const e of events) {
      const type = typeOf[e.id]
      if (e.isSet) regOf[e.id] = free[type].length ? free[type].pop() : next[type]++
      else if (e.at === lastUse[e.id]) free[type].push(regOf[e.id])
    }
    const resolved = text.replace(/\x01(\d+)\x02/g, (_, idStr) => `$pt_${typeOf[+idStr]}_${regOf[+idStr]}`)
    const decls = []
    for (const type of ['f64', 'i32', 'i64']) for (let i = 0; i < next[type]; i++) decls.push(`(local $pt_${type}_${i} ${type})`)
    return { decls, resolved }
  }
  const POW_SPLITTER = '134217729' // 2^27+1, Veltkamp split constant for f64's 53-bit mantissa
  const powSplit = (B, a) => {
    const c = B.tmp(`(f64.mul (f64.const ${POW_SPLITTER}) ${a})`)
    const hi = B.tmp(`(f64.sub ${c} (f64.sub ${c} ${a}))`)
    const lo = B.tmp(`(f64.sub ${a} ${hi})`)
    return [hi, lo]
  }
  const powTwoSum = (B, a, b) => {
    const s = B.tmp(`(f64.add ${a} ${b})`)
    const bb = B.tmp(`(f64.sub ${s} ${a})`)
    const e = B.tmp(`(f64.add (f64.sub ${a} (f64.sub ${s} ${bb})) (f64.sub ${b} ${bb}))`)
    return [s, e]
  }
  const powTwoProd = (B, a, b) => {
    const p = B.tmp(`(f64.mul ${a} ${b})`)
    const [ah, al] = powSplit(B, a), [bh, bl] = powSplit(B, b)
    const t1 = B.tmp(`(f64.sub (f64.mul ${ah} ${bh}) ${p})`)
    const t2 = B.tmp(`(f64.add ${t1} (f64.mul ${ah} ${bl}))`)
    const t3 = B.tmp(`(f64.add ${t2} (f64.mul ${al} ${bh}))`)
    const e = B.tmp(`(f64.add ${t3} (f64.mul ${al} ${bl}))`)
    return [p, e]
  }
  // absorb: ripple `term` top-down into a k-limb accumulator (array of k expr-refs) via
  // twoSum; the final carry-out (dropped) is ~2^-53k relative to the LARGEST term folded so
  // far, so a chain of these absorptions gives a k-limb-equivalent (~53k-bit) result.
  const powAbsorb = (B, acc, term) => {
    const next = []
    let carry = term
    for (let j = 0; j < acc.length; j++) { const [s, e] = powTwoSum(B, acc[j], carry); next.push(s); carry = e }
    return next
  }
  const powFoldK = (B, terms, k) => { let acc = new Array(k).fill('(f64.const 0)'); for (const t of terms) acc = powAbsorb(B, acc, t); return acc }
  const powMulExtDouble = (B, A, y, k) => {
    const terms = []
    for (let i = 0; i < k; i++) {
      if (i === k - 1) terms.push(`(f64.mul ${A[i]} ${y})`)
      else { const [p, e] = powTwoProd(B, A[i], y); terms.push(p, e) }
    }
    return powFoldK(B, terms, k)
  }
  // k-limb * k-limb, triangular (drop cross terms below k-limb precision — the standard
  // QD-library dd_mul generalizes cleanly to k limbs this way).
  const powMulExt = (B, A, Bv, k) => {
    const terms = []
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
      if (i + j >= k) continue
      if (i + j === k - 1) terms.push(`(f64.mul ${A[i]} ${Bv[j]})`)
      else { const [p, e] = powTwoProd(B, A[i], Bv[j]); terms.push(p, e) }
    }
    return powFoldK(B, terms, k)
  }
  const powAddExt = (B, A, Bv, k) => powFoldK(B, [...A, ...Bv], k)
  // u/v (plain doubles, u,v exact by construction at every call site — Sterbenz subtraction
  // against a bit-truncated table breakpoint) to k-limb precision via iterative refinement:
  // each pass forms the EXACT residual u-s·v (twoProd+twoSum) and divides it again, recovering
  // ~53 more bits per pass.
  const powDivExt = (B, u, v, k) => {
    const terms = []
    let rHi = u, rLo = '(f64.const 0)'
    for (let pass = 0; pass < k; pass++) {
      const s = B.tmp(`(f64.div ${rHi} ${v})`)
      const [p, e] = powTwoProd(B, s, v)
      const [t1, t1e] = powTwoSum(B, rHi, `(f64.neg ${p})`)
      const [t2, t2e] = powTwoSum(B, rLo, `(f64.neg ${e})`)
      rHi = B.tmp(`(f64.add ${t1} ${t2})`); rLo = B.tmp(`(f64.add ${t1e} ${t2e})`)
      terms.push(s)
    }
    return powFoldK(B, terms, k)
  }
  // Horner (highest degree first) over a k-limb variable, coefficients as 3-limb JS rows
  // (only the first k limbs of each are used).
  const powHornerExt = (B, coefRows, k, xLimbs) => {
    const N = coefRows.length
    let acc = coefRows[N - 1].slice(0, k).map(v => `(f64.const ${v})`)
    for (let i = N - 2; i >= 0; i--) {
      acc = powMulExt(B, acc, xLimbs, k)
      acc = powAddExt(B, acc, coefRows[i].slice(0, k).map(v => `(f64.const ${v})`), k)
    }
    return acc
  }

  // frexp: x>0 finite, in mutable local xLoc (rescaled in-place for subnormals). Returns
  // {kexp (mutable i32), m (f64 expr, in [1,2)), mHi (i32 expr, high word of m's bit pattern)}.
  const powFrexpGen = (B, xLoc) => {
    const bits0 = B.tmp(`(i64.reinterpret_f64 ${xLoc.get})`, 'i64')
    const hi0 = B.tmp(`(i32.wrap_i64 (i64.shr_u ${bits0} (i64.const 32)))`, 'i32')
    const kexp = B.mutable('kexp', 'i32')
    B.raw(kexp.set('(i32.const 0)'))
    const subB = B.sub('frs')
    subB.raw(xLoc.set(`(f64.mul ${xLoc.get} (f64.const ${2 ** 54}))`))
    subB.raw(kexp.set('(i32.const -54)'))
    B.raw(`(if (i32.eqz (i32.shr_u ${hi0} (i32.const 20))) (then ${subB.stmts.join(' ')}))`)
    const bits = B.tmp(`(i64.reinterpret_f64 ${xLoc.get})`, 'i64')
    const hi = B.tmp(`(i32.wrap_i64 (i64.shr_u ${bits} (i64.const 32)))`, 'i32')
    const lo = B.tmp(`(i32.wrap_i64 ${bits})`, 'i32')
    B.raw(kexp.set(`(i32.add ${kexp.get} (i32.sub (i32.shr_u ${hi} (i32.const 20)) (i32.const 1023)))`))
    const mHi = B.tmp(`(i32.or (i32.and ${hi} (i32.const 0x800fffff)) (i32.const 0x3ff00000))`, 'i32')
    const m = B.tmp(`(f64.reinterpret_i64 (i64.or (i64.shl (i64.extend_i32_u ${mHi}) (i64.const 32)) (i64.extend_i32_u ${lo})))`)
    return { kexp, m, mHi }
  }

  // CHEAP-HYBRID phase-1 (dd only) series evaluation: ln(1+r) = r + a2 r^2 + a3 r^3 + ... .
  // Mercator's series has ALL integer powers of r (unlike atanh's odd-power-only series, the
  // shape exp2's series shares — see below), so a plain-Horner tail's reduction variable is r
  // itself, NOT r^2 (an earlier version mistakenly reused the odd-series r^2 pattern here;
  // confirmed wrong against the mpmath oracle — it silently dropped odd-power siblings of the
  // r^2 term, landing ~2^-16 absolute error instead of the intended ~2^-69). a2 r^2 is kept at
  // DD precision (one mulExt for r^2 + one mulExtDouble by the constant) since it's the
  // dominant correction: a fully-plain series (a2 onward all plain f64, ~2 ops/term) measured
  // only ~2^-69 dd precision — too loose for colorpq's own PQ exponents (~47% phase-2
  // escalation measured, worse than the fully-rigorous dd Horner it was meant to replace,
  // which itself made phase 1 ~28x slower than the fdlibm kernel it replaced). This hybrid —
  // one extra dd multiply for a2 r^2, plain Horner for a3 r^3 onward (truly O(r^3), tiny) —
  // measured 2^-77.15 dd absolute error (scratchpad/pow/measure_log2_abs.py), recovering the
  // needed precision for a fraction of full rigor's ~(logNTerms-1)-deep dd Horner chain cost.
  const powLog1pCheapGen = (B, r, logNTerms) => {
    const r0 = r[0]
    const rSq = powMulExt(B, r, r, 2)
    const a2Term = powMulExtDouble(B, rSq, `(f64.const ${POW_LOG_SERIES[1][0]})`, 2)
    let Qtail = `(f64.const ${POW_LOG_SERIES[logNTerms - 1][0]})`
    for (let i = logNTerms - 2; i >= 2; i--) Qtail = B.tmp(`(f64.add (f64.mul ${Qtail} ${r0}) (f64.const ${POW_LOG_SERIES[i][0]}))`)
    const tail = B.tmp(`(f64.mul (f64.mul (f64.mul ${r0} ${r0}) ${r0}) ${Qtail})`)
    return powFoldK(B, [...r, ...a2Term, tail], 2)
  }

  // log2(x) to k-limb precision — see the header comment for the algorithm and the
  // cancellation-fix rationale. tblBase: WAT expr for LOG2_TABLE's injected base address.
  const powLog2ExtGen = (B, xLoc, k, tblBase, logNTerms) => {
    const { kexp, m, mHi } = powFrexpGen(B, xLoc)
    const T = POW_LOG2_T
    const j = B.tmp(`(i32.and (i32.shr_u ${mHi} (i32.const ${20 - T})) (i32.const ${(1 << T) - 1}))`, 'i32')
    const maskHi = (0xfff00000 | (((1 << T) - 1) << (20 - T))) >>> 0
    const m0Hi = B.tmp(`(i32.and ${mHi} (i32.const ${maskHi | 0}))`, 'i32')
    const m0 = B.tmp(`(f64.reinterpret_i64 (i64.shl (i64.extend_i32_u ${m0Hi}) (i64.const 32)))`)
    const u = B.tmp(`(f64.sub ${m} ${m0})`)
    const r = powDivExt(B, u, m0, k)
    const lnP = k === 2 ? powLog1pCheapGen(B, r, logNTerms) : powMulExt(B, powHornerExt(B, POW_LOG_SERIES.slice(0, logNTerms), k, r), r, k)
    const log2P = powMulExt(B, lnP, POW_LOG2E.slice(0, k).map(v => `(f64.const ${v})`), k)
    const addr = B.tmp(`(i32.add ${tblBase} (i32.mul ${j} (i32.const 24)))`, 'i32')
    const tHi = B.tmp(`(f64.load offset=0 ${addr})`)
    const tMid = k >= 2 ? B.tmp(`(f64.load offset=8 ${addr})`) : null
    const tLo = k >= 3 ? B.tmp(`(f64.load offset=16 ${addr})`) : null
    const tableEntryRaw = [tHi, tMid, tLo].slice(0, k)
    const kexpAdj = B.mutable('kexpadj', 'i32')
    const teAdj = tableEntryRaw.map((_, i) => B.mutable('te' + i))
    const elseB = B.sub('lelse')
    elseB.raw(kexpAdj.set(kexp.get))
    teAdj.forEach((h, i) => elseB.raw(h.set(tableEntryRaw[i])))
    const thenB = B.sub('lthen')
    thenB.raw(kexpAdj.set(`(i32.add ${kexp.get} (i32.const 1))`))
    const shifted = powFoldK(thenB, [...tableEntryRaw, '(f64.const -1)'], k)
    shifted.forEach((h, i) => thenB.raw(teAdj[i].set(h)))
    B.raw(`(if (i32.ge_s ${j} (i32.const ${(1 << T) / 2})) (then ${thenB.stmts.join(' ')}) (else ${elseB.stmts.join(' ')}))`)
    const kexpF = B.tmp(`(f64.convert_i32_s ${kexpAdj.get})`)
    return powFoldK(B, [kexpF, ...teAdj.map(h => h.get), ...log2P], k)
  }

  // 2^L to k-limb precision — Llimbs is a k-limb array. Returns {limbs: k-limb array of the
  // UNSCALED fractional-part result, n: i32 expr, the exponent $math.pow_scalbn splices in}.
  const powExp2ExtGen = (B, Llimbs, k, tblBase, expNTerms) => {
    const n0 = B.tmp(`(f64.nearest ${Llimbs[0]})`)   // ties-to-even, IEEE roundTiesToEven
    const n = B.tmp(`(i32.trunc_f64_s ${n0})`, 'i32')
    const nF = B.tmp(`(f64.convert_i32_s ${n})`)
    const negNF = B.tmp(`(f64.neg ${nF})`)
    const rExp = powFoldK(B, [...Llimbs, negNF], k)
    const idxF0 = B.tmp(`(f64.nearest (f64.mul ${rExp[0]} (f64.const 256)))`)
    const idxI0 = B.tmp(`(i32.trunc_f64_s ${idxF0})`, 'i32')
    const idxLo = B.tmp(`(select (i32.const -128) ${idxI0} (i32.lt_s ${idxI0} (i32.const -128)))`, 'i32')
    const idx = B.tmp(`(select (i32.const 127) ${idxLo} (i32.gt_s ${idxLo} (i32.const 127)))`, 'i32')
    const idxF = B.tmp(`(f64.convert_i32_s ${idx})`)
    const negIdxOver256 = B.tmp(`(f64.neg (f64.div ${idxF} (f64.const 256)))`)
    const r2 = powFoldK(B, [...rExp, negIdxOver256], k)
    const addr = B.tmp(`(i32.add ${tblBase} (i32.mul (i32.add ${idx} (i32.const 128)) (i32.const 24)))`, 'i32')
    const eHi = B.tmp(`(f64.load offset=0 ${addr})`)
    const eMid = k >= 2 ? B.tmp(`(f64.load offset=8 ${addr})`) : null
    const eLo = k >= 3 ? B.tmp(`(f64.load offset=16 ${addr})`) : null
    const tableEntry = [eHi, eMid, eLo].slice(0, k)
    // CHEAP phase-1 (dd only): 2^r2 = 1 + b1*r2 + b2*r2^2+... . Unlike log's series (odd
    // powers of r only, naturally a series in r^2), exp2's has BOTH parities of r2, so a
    // plain tail Horner runs IN r2 (not r2^2). b1*r2 and b2*r2^2 are kept at DD precision
    // (b1*r2: one mulExt; b2*r2^2: one mulExt for r2^2 + one mulExtDouble by b2) — b1 is the
    // dominant correction (ln2, not O(r2) small) and b2's term needed the same DD treatment
    // log2's a2 did (see powLog1pCheapGen's comment: a plain-double b2 alone measured only
    // ~2^-71 dd precision, too loose for colorpq's own PQ exponents). b3 onward (O(r2^3),
    // truly small) stay a cheap plain Horner on r2's leading limb. Phase 2 (td) keeps the
    // fully-rigorous Horner.
    const P = k === 2 ? (() => {
      const r2_0 = r2[0]
      const term1 = powMulExt(B, r2, POW_EXP_SERIES[1].slice(0, 2).map(v => `(f64.const ${v})`), 2)
      const r2Sq = powMulExt(B, r2, r2, 2)
      const term2 = powMulExtDouble(B, r2Sq, `(f64.const ${POW_EXP_SERIES[2][0]})`, 2)
      let Qtail = `(f64.const ${POW_EXP_SERIES[expNTerms - 1][0]})`
      for (let i = expNTerms - 2; i >= 3; i--) Qtail = B.tmp(`(f64.add (f64.mul ${Qtail} ${r2_0}) (f64.const ${POW_EXP_SERIES[i][0]}))`)
      const tail = B.tmp(`(f64.mul (f64.mul (f64.mul ${r2_0} ${r2_0}) ${r2_0}) ${Qtail})`)
      return powFoldK(B, ['(f64.const 1)', ...term1, ...term2, tail], 2)
    })() : powHornerExt(B, POW_EXP_SERIES.slice(0, expNTerms), k, r2)
    const result = powMulExt(B, tableEntry, P, k)
    return { limbs: result, n }
  }

  // Assemble $math.pow_transcend's full body — see the header comment for the algorithm.
  const genPowTranscend = () => {
    const B = powMkBuilder('pt')
    const xLoc = { get: '(local.get $x)', set: (e) => `(local.set $x ${e})` }
    const yLoc = { get: '(local.get $y)' }
    const logTbl = '(global.get $math.pow_log2_tbl)', expTbl = '(global.get $math.pow_exp2_tbl)'
    B.raw(`(if (f64.gt (f64.abs ${yLoc.get}) (f64.const 1e20))
      (then
        (if (f64.eq ${xLoc.get} (f64.const 1.0)) (then (return (f64.const 1.0))))
        (if (i32.eq (f64.gt ${xLoc.get} (f64.const 1.0)) (f64.gt ${yLoc.get} (f64.const 0.0)))
          (then (return (f64.const inf)))
          (else (return (f64.const 0.0))))))`)
    const epsExpr = (k) => `(f64.add (f64.mul (f64.abs ${yLoc.get}) (f64.const ${POW_LOG2_ABS_ERR[k] * Math.LN2})) (f64.const ${POW_EXP2_REL_ERR[k]}))`
    const emitPhase = (k, logN, expN, isLast) => {
      const Bp = B.sub(`p${k}`)
      const logx = powLog2ExtGen(Bp, xLoc, k, logTbl, logN)
      const L = powMulExtDouble(Bp, logx, yLoc.get, k)
      Bp.raw(`(if (f64.gt ${L[0]} (f64.const 1100)) (then (return (f64.const inf))))`)
      Bp.raw(`(if (f64.lt ${L[0]} (f64.const -1100)) (then (return (f64.const 0.0))))`)
      const { limbs, n } = powExp2ExtGen(Bp, L, k, expTbl, expN)
      const hi = limbs[0]
      const loSum = limbs.length === 2 ? limbs[1] : Bp.tmp(`(f64.add ${limbs[1]} ${limbs[2]})`)
      const eps = Bp.tmp(`(f64.mul (f64.abs ${hi}) ${epsExpr(k)})`)
      const lowerU = Bp.tmp(`(f64.add ${hi} (f64.sub ${loSum} ${eps}))`)
      const upperU = Bp.tmp(`(f64.add ${hi} (f64.add ${loSum} ${eps}))`)
      const lower = Bp.tmp(`(call $math.pow_scalbn ${lowerU} ${n})`)
      const upper = Bp.tmp(`(call $math.pow_scalbn ${upperU} ${n})`)
      if (isLast) {
        // Phase 2: return best-effort if STILL uncertain rather than nothing — validated 0
        // occurrences (see header comment), so this is a documented safety net, not a live path.
        Bp.raw(`(if (f64.eq ${lower} ${upper}) (then (return ${lower})))`)
        Bp.raw(`(return (call $math.pow_scalbn (f64.add ${hi} ${loSum}) ${n}))`)
      } else {
        Bp.raw(`(if (f64.eq ${lower} ${upper}) (then (return ${lower})))`)
      }
      B.raw(Bp.stmts.join(' '))
    }
    emitPhase(2, POW_LOG_N_DD, POW_EXP_N_DD, false)   // phase 1 (dd) — cheap common path
    emitPhase(3, POW_LOG_N_TD, POW_EXP_N_TD, true)    // phase 2 (td) — rare, always returns
    // Pool resolution runs ONCE over the whole (both-phases) body — phase 2's pool reuses
    // phase 1's already-declared registers for free (phase 1 has unconditionally returned or
    // finished by the time phase 2's code runs, so none of its values are still live).
    const { decls: poolDecls, resolved } = powResolvePool(B.stmts.join(' '), B.type)
    return `(func $math.pow_transcend (param $x f64) (param $y f64) (result f64)
      ${B.mutDecls.join(' ')} ${poolDecls.join(' ')}
      ${resolved})`
  }

  // LOG2_TABLE / EXP2_TABLE: 256 entries x 24 bytes (3 little-endian f64 limbs each) —
  // log2(1+j/256) for j=0..255, and 2^(j/256) for j=-128..127 respectively, computed at
  // 400-bit precision (scratchpad/pow/gen_table_bytes.py) and decomposed into a 3-limb
  // (hi,mid,lo) expansion. Injected as linear-memory data tables only when
  // $math.pow_transcend survives reachability pruning — same lazy-table mechanism as
  // module/number.js's Eisel-Lemire/Ryū tables (src/wat/assemble.js's injectTable).
  // Char-array + one join, not `s += chr` — the concat form allocates ~n²/2 bytes
  // of dead strings PER COMPILE (see module/number.js hexToBytes; these two 6 KB
  // tables alone cost ~38 MB per compile inside the warm self-host kernel).
  const powHexToBytes = (hex) => { const chars = []; for (let i = 0; i < hex.length; i += 2) chars.push(String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))); return chars.join('') }
  ctx.runtime.powLog2Table = powHexToBytes('00000000000000000000000000000000000000000000000077ac7a6dc409773f11be24496fb6123c3b347080dd8794b85108efb650fe863f545e00ec8de32f3c1b6e1364c677b7b80c7ba9173136913f5244249b06ed323c2a1c23cc79b1b1382ad2c28596e7963fbd9f7b0776643dbc240d89569f6bd0b8860f85ba63939c3f4fd3c53da09b393c4625f31f589fceb8133413d5d11ca13fb96c05fbba7e22bc4c51f7bfdabcc438265a689430eda33f94c41fb8a513303c793aa68b0ca5de3887fd8e75d3baa63fe15b4b78039b383c47694326e7dbdeb8945149c3bf85a93f84de43ed3828483cf3f7d42fc9c7d5385fab0ab9fa4dac3ff088332c0f0e16bcabfd82b1d22bb438a05332838913af3f941a1251be8c47bcbd52d1caebcbde389b9fa29f38ebb03fb89951d1220c53bcc8f350916b06f7383d5a137e5b4bb23f6982ba324c975dbc5a236e632449ffb8c3f127dd2faab33fcf5af27697fd43bcf1f84223b5a9dd38b73b0336b807b53f962e4b42968645bcc3a726e5b1a7d0381613c9faf663b63f165198e014335f3caa60f0b586a7e4b881a2b896eebeb73ffaa11a19d7204e3cc6f7e155cfe6e4385b33466ea118b93f1793ac6d736354bc7864eca6dc37d7b8948434df1171ba3f2c3dc4e1a7bb34bcc015918a7db6d3b8baabad4042c8bb3f5f46b969b1ec583ceff73abe6978f4b8da825be3341ebd3ff9f2c83cce42533c5c0a5ab00caff838b2a57f11ec72be3ff229dcd9b5bd3c3c269c2dee50a99338a5000b0f6ac6bf3fc8bd1ae7b2ec5bbc650e64f59a00f9b8e479da8c588cc03fabd60be410766abcf915400c2b5407b92e0689b4e134c13fa5990dfe7d4bf9bb7d2ad8d3216153b87b2b5597d1dcc13f580e1e0c15a9673cb48ad47da875053940a6074b2984c23f75f7d6545da26cbcfa5e49a32e63d9381aae78e2e92ac33f4ca775c0f2514f3cce4e3bb09a6ce6b8648a9a6d14d1c33fd6b8a9e091e93fbc75ebf8dbb645deb84df783f9a976c43fb61fb2a0749c583ce9c4c7b3adeec3388a5c7a90ab1bc53ffffd1626022c623ca7ad823d61350ab988d6fb391ac0c53f5d7e7d3bfd1768bc175706c3b68be4b81613c9faf663c63f165198e014336f3caa60f0b586a7f4b87f02efd44207c73f3ebf6b7d0ee0543c8fb96547d9baf2b8df5dd0c7fea9c73f73e823be64033dbce83e96073d3dd2b8b3032fd02b4cc83fb5e2c488db6e11bc056a892605e1b1b86c2b35e8caedc83f93d99a79af8c62bcc54f06e9bdd5fb38df707e07dd8ec93f5cb9486574d6173cacc5ecec97067ab86bb82023632fca3ff0426d6cbde35abce5070ddc7ac5ed3894ecb42d5ecfca3fcae73f34e11e40bc0a755f41905ada38e9955f17cf6ecb3f1fed8b3363fb6a3cd85d40b152cdbfb8ee4dd9cdb60dcc3ffc7326669b38603c4b467ddb2794f7b8c90d773c16accc3f72b8d369cd4e6abc806de7e032de02397059324cee49cd3ffde27e4da5855bbcaa9696fa807cf7b80f48b1e33fe7cd3fbee1328cbd414ebcbcc95491b201bdb84d6a4ee70b84ce3f1e087115061b5cbc60b030556103efb8278f20395320cf3f3b63cc994add613c102efc634c070bb90a6802b916bccf3f78c253cc6cd4513ca5245261b641f9b864064da2ab2bd03f080bd6a4173a71bc2da3b9354c8316390930b0db0a79d03f1755679ac6c07b3ce15b7bbc9e99f4b88f2a547529c6d03f80f4f91638c176bcd26695fc04a30e39760bd3da0713d13fd952c3d2477b6abcfa87cdb933f80339ff08bb76a65fd13f19074f118e5f763c18de3de5e230e03870f091b205acd13f28e3b7e11ca3743c2d27cdb11d061a39138ed8f625f8d13feae6fb6934f4653c90705860f1fc0db93a070eab0744d23fffec16ad916e7fbc9d5879e10b11f0b88326b335ab8fd23fe68b905ae8c0783cee68dcd263041fb9af9a4dfc10dbd23fcf1b638fdec47b3c8c0b388be38e0b3936286b633926d33f84aac40f074779bcbfab01bd18770cb9edcda4ce2471d33f09fcb449663763bc61f47613e486f138fbdca1a0d3bbd33f2e67c98b3c9f7abc0a3c205ca8401d3949041b3b4606d43fcd4809d1bc6c7d3c2a8a0790f35e1239c44fddfe7c50d43f47ce00d897ca7abcd53ea5dd0d110eb98b1bcd4b789ad43f02250b90406d1bbc2107a84e9accb2b86afbe88038e4d43f7e15e9f4380a31bcdcfc34744a96c738b3964cfcbd2dd53f6df28739d8737f3c963cbcdfbdcb1239cb78331b0977d53f1dfbc4941fbe73bcc16aed90a11a173988d6fb391ac0d53f5d7e7d3bfd1778bc175706c3b68bf4b8ae4829b4f108d63f90e6b762fc437abc229eb942275c0139a77b67e48f51d63f6761371287dd5abc3aa3d2812e2dfeb8b8d48c24f599d63fbf2d0d1552317a3cf76c79d8b07900b9de0c9dcd21e2d63fc13dd18254e3753c9b5fdf0e6cdeedb883c1cb37162ad73ffe57d79ac9f27abc298095e3a6b60ab93cfb7ebad271d73f58dbed2a13905bbc7c586bcf6d78acb8c4aa51ac57b9d73f1973fbf4dbd8753c9ba604e122a91c39541c1663a500d83fbd6ffa045b57693c92fc8dbdb01109398e61d833bc47d83f50788d88b51f6cbcdb586a5764280e3926b2e0729c8ed83f59c9cdd666d276bc0d389238c13bf5b872c3b57346d5d83f029394b6bd3075bcace6ccd843b3eb3809171f89ba1bd93f591ea5be52d372bcbabea8db8561f5389c402705f961d93fcae648a198c27cbcd8d85468593e15392f231e3902a8d93f61ca2187b65d6a3cae856f613cdcf5b8e0259b75d6edd93f4d548ec138c97dbc6e4615f85919fab851607f0a7633da3f4f181acaefa078bcce5307c0dc1f1b39f4bef746e178da3f12255c6a81a0743cd9092cebb25310b9491f7f7918beda3f433aa7aa8d5b5ebccfaf2a3d6e78fc383464e0ef1b03db3fbbc3aeb00598793c01fb7d4ab51aef38a18238f7eb47db3f769dc041e4fa76bc1ca17fb58e54fcb87a86f8db888cdb3ffcdad1a788327abc185ec9d84c6917b93190e7e9f2d0db3fa5fb37c7f42e75bcccb6f58b4853e438e6ca246c2a15dc3fdd6b5ada1aed6fbc6cd3c85eb27dfd38565b29ad2f59dc3fccbcbb52b99f7f3c8f98615681a70839b447caf6029ddc3fefc12b2e1c4066bca759ba2e38380db97d583a92a4e0dc3fd32f8ce87a516bbc3256b5de8fea0bb97df20bc81424dd3fd2532ab56f85743cf6de402f466a19390fea32e05367dd3fadaafa661e141cbc41b70b733ebfb638b94f062262aadd3fb7115671a574123cfb166c7b12c998b84c3642d43feddd3f417c4558c6ae733cb148e84eb38906b99872093ded2fde3fab4274ae4ae44b3c4eb0ef05d239e738d254e7a16a72de3f26e2e8253ca3483cead4eb46d1abe938ce5bd147b8b4de3fedf5807972f9743c67dcd35f8f3c1db920e22873d6f6de3f05410e6a80477f3c052b89cc18e01bb941c5bc67c538df3f95a09716e48067bc6c9170aaa87df0b8cf06cb68857adf3f85d7fd3f67f368bcfeab6d06a572f3b80a6802b916bcdf3f78c253cc6cd4613ca5245261b64109b99bff839a79fddf3f1e1df432e08c71bc9c7b522da1d31db9e0647227571fe03fb3d35c08819a5bbc22e19f1dfab4f5387f99978bda3fe03fd7b302321aca793c965b13a96a1a1cb9b24ef2194760e03fe1bf9c8f8f4c7f3c7774560493da00393d707ff29c80e03ffb604507cf96843c14119e661e3d2cb9fce1f834dca0e03f7d89a14939f97fbc8c408a347a691ab9a63ad60005c1e03f97d8a6d49520863cbbd3507e50152e39117c4d7517e1e03f25fd24caabae633c59dbf2681135f9b8eac853b11301e13f39eb9b6b37c78e3c9aab6d4d3bad273907189ed3f920e13fa3e922b068a5763c11edb582d0dcf6b844e5a1fac940e13feda773b5967a88bc144f94a8b57b2ab906e095448460e13fbb9cf58f372b4e3ce14b4924263defb86a9772cf2880e13fcd14455f3aae833c64118711066328392124f3b8b79fe13f560d30d570588c3c1cdd0facd6ea23390ed0951e31bfe13f79322356ec4a6cbca4a92aa782e3efb8a6bb9c1d95dee13ff71dc7864c7a683c06826616e9c1053926810ed3e3fde13f3c11ce515790803c66b2444f756321399ad5b65b1d1de23ffe5085167aa8783c1ce5b612371907b9c82727d4413ce23f271053c3981d503ce95ac3f97f91fd38043db758515be23fd3234640a3a1853ca1ab3dd3bdddcf38f8cb85054c7ae23f7dba8e833be1453cbedcc5d20357c4b8601579f63199e23fcce24577f67c843c172f390d4111e738d17a3f4703b8e23f5d7e7d3bfd1758bc175706c3b68bd4b880135013c0d6e23f00152f8a532a893c1fdc538c184f18b9263feb7568f5e23f129369d18c27643cb276d8e56f160db9f2361b8afc13e33f5ba380201df97c3cd64c3f7a65591639a79cb46a7c32e33ff0de02fd36ca7bbc0c06dc6e9e93f038d9075732e850e33fad9c236c369367bc7f05fdde145dd13862916dfb3f6fe33f367354a8dc11803cde84334f45d82c39095d2fe0838de33f74c573e1f00d743c609be325b09519396721a0fab3abe33f837d8bdfa69a79bcc0d5ca39c6bd12b912ae9064d0c9e33f037548d90a66713c395785b1a416e5b816709f37d9e7e33fb25469eba9b88a3c2480d0cf4fca22b9bcf4388dce05e43f3155354ed01264bcdee718dd34b4e038a96a987eb023e43f13ab5274d8c1893cfdb1b510c36428396521c8247f41e43fba5e598d949384bc7b14b14bad8625b93907a2983a5fe43f4563f60700ca86bc1fec8214717c25b98725d0f2e27ce43f765b20176fbc6cbc592f4b2d8401cfb88b1bcd4b789ae43f02250b90406d2bbc2107a84e9accc2b89597e4bbfab7e43ffc88584319168f3c96bfee6e01c826b9c4ce335b6ad5e43ffd1c66fe7b9b823cc0eb11bc6f3c2a393ef3a941c7f2e43f2a41e0c21fd48d3c4aeb6c47e4ca2439f9a808871110e53fcb6e3a645b0b71bc96b1cdc5ea3a1cb90979e442492de53f872a21e126bd833c0fe501f3ef482c398e43a58c6e4ae53f2f511567cd9383bc4e72080bce8407b92cb0867b8167e53f2e0ceeafe9c58e3cb79888f79702f438349d98268284e53f524bb9163a397ebcf31c237aa74408395c8dbfa470a1e53f128e3e7941e3753cce6c6e1b142201b93514b50c4dbee53f6a77b73f304585bcf8b9740a80fc2c393c41087517dbe53fd1bddaea9170823c246ab064e3a12e39af091ef4cff7e53fa8cce84f39cd81bc3421d8c8d74e133909b131a07614e63f757150e4468c89bc39d6d6a7fea41c394830558f0b31e63f0079c785961a803c93dc40242a991939f09b71d78e4de63f5b7ae1bf03e189bc162fc6fad21e2539cc88478e006ae63f688d375e926879bc951ea4e7f0880a39876f6fc96086e63f0863be0edcc57b3cab6f8436246a02b90a0f5a9eafa2e63fcd17e4e52a13503c63d242f484abe7b8aecd5022edbee63f44d085404f15573ccaeda1d38b17fcb84a19766a19dbe63fed4ae5c0074173bc907c7c6d7869e83818c6c58b34f7e63ff11a37c3035e86bceff8b79f00162a397c6c159b3e13e73f8eec374280e96abca590e5638bf30a39b0c514ad372fe73f6b58d0c874317abc5e8018b59c37fab854074ed61f4be73f9b5717e0438d7cbc6410c80351581cb9ee3d262bf766e73fe3445acca40e79bcb2b3cc56aad4183957a6ddbfbd82e73fa9aa97841ff28e3c6a61907b62d30739200690a8739ee73f359d5b12b6997dbc9627f17d649010b9e40235f918bae73ffe3843fe6ed5533c9fcab70049eaf7b8a478a0c5add5e73f2b94a6ec8e10803c6cb1db0274ad0e3916cf822132f1e73f0aca0044996877bcc710352dacc002b9f94d6920a60ce83fcfe408da2e777bbc69d61732359a1cb97370bed50928e83fc61e9eecfd1172bc579fdd769b4b08397437ca545d43e83f3c9ef37c620c82bcbd53ce5e01582e39267bb2b0a05ee83ff6a164e8fc86603c2d47bb03261b0ab9713b7bfcd379e83fe437c2d7fd6680bc5558ec831c1104398bef064bf794e83fab46f6b1a81b803cec5de7ffc5170239a9d416af0ab0e83f66bc3a4772936ebc67c36537994b04b9be3b4b3b0ecbe83f9139815edd2583bc662c2a03fe40fab861d6230202e6e83fe7fffaf34f058ebce5c2d57efdde2ab9cd020016e600e93fd7e7827bafc02bbcf027ceedad06ceb809171f89ba1be93f591ea5be52d382bcbabea8db856105392faba06d7f36e93f91bc0893e6cd88bccbfceb62785015b9e3e284d53451e93fbdf7d66e1ed3893c9d0c9c36425429b9f6b5acd2da6be93f21b9ceeab61360bccb7764f9653bb7382f38da767186e93f2888c1bea6ac8ebc406dd1df2375283950e0b0d3f8a0e93f1a68a15a46b570bc8d6ba4053bc6ec384dceb5fa70bbe93fcd12e6cdd8f48ebc7e24784e1d692439b31050fdd9d5e93f9f201d485699893c20951ae31ca1163956e9c8ec33f0e93f8c0022383473843cf72a91eb42b429392d114cda7e0aea3fad307e44d1ce69bc702c58ab6e9ffcb877fbe7d6ba24ea3f755665fb7d4685bcd385e0ef5e3e0f391f188ef3e73eea3fb6f4ae7239c377bcac2756dcc9840539641513410659ea3f615ec42b3ff3723c050953d2b0ad0539c8202fd01573ea3fdb7d04707daa80bc5efe989afe291a3945277eb1168dea3f5fbc1e68cd5183bc2702d97631cd2039d31480f508a7ea3f83c81af28d378f3cb388bd7d6b3324393b1399acecc0ea3fa83c6a749e1e743cdf8cb825035f103933c811e7c1daea3f0446284fe95477bc3e1518d1a3add5b8d69217b588f4ea3f40053c5a9c2285bc6a3c4f1b236f16b96cc8bc26410eeb3f657bf258892c74bc9be263b24582f8b88af0f84beb27eb3fe039978dacb5813c39717c469ac9f1388c00a9348741eb3f04094138a34373bc8c5eb6705eb3183966968ff0145beb3f8af0e29f617969bca36a7364a6910bb9da32558f9474eb3f328ecd50dcd2823c24674ff4c13121b909738820068eeb3f2207b1253b3a6d3c7783398bc47a013964499eb369a7eb3f195d29bcfdf05d3c91da8d264765f0380636f257bfc0eb3fc2663452b28a8bbc0b619135c20016b96e7ec61c07daeb3f4b26fb7d48ba82bc99bb8e64fe4c15b9a764441141f3eb3f98120d122ec880bc12d26ec7b7621c39d35d7c446d0cec3f181d57696ab6883ca9fa0f5fd12323b9294866c58b25ec3fe421be5f902085bc5cfda2344d0aecb855a0e1a29c3eec3fd8db24a7c5b4793c6404f112870ff83858b6b5eb9f57ec3f21885cbb346b77bc2c8dd898b28b0839c7e191ae9570ec3f321123c6262f883ca757ad98fd1813398eb50dfa7d89ec3f45b4b56827338ebcc59293d5a4cd05b91633a9dc58a2ec3f845560c871ff7a3ceaed46e7a7e707b9f6fccc6426bbec3f650beb3ea14c84bc8c4b723d8263d1380789caa0e6d3ec3fa99d75b745de7ebc38536df498741d390352dc9e99ecec3fc21d1c8244ea34bcf1276543cc97c2389608266d3f05ed3fea3970d725c68c3c397d4a1509362639f1c3b419d81ded3f618abf846e6c7bbc52967f81e85dd1b8d5317fb26336ed3fc756dad61bbc743cbed589c694ae02392bc66545e24eed3f95b6ab8a134983bc4472bd382730d8380fea32e05367ed3fadaafa661e142cbc41b70b733ebfc6386c2a9b90b87fed3f3e7a5e000ae4813c6816c627539bdd3815663d641098ed3ff4dd5c8afc1d7ebc37fbf11ca96b16b965fba2685bb0ed3f4157db0f051086bc56bfa336022415b96cf53fab99c8ed3fc610b5aece99873c4a43f49e7ece1839a4387339cbe0ed3f076449764fa1893ce078ad79fc952b392caf8620f0f8ed3ff42a1a0fd2fb823c12457dae837b25399674af6d0811ee3f1127236d46f6743c6ad25a250dd512b940010e2e1429ee3f53bce367aaba6f3c365de723eef605393d55ae6e1341ee3f526182b3fbe46a3c726973fdd2e1f3b8ce22883c0659ee3f9bb16e6a4486853c8418f66d2bd0fb386ff87ea4ec70ee3fdbac353308d469bcbb876170a7fc0c39736a62b3c688ee3f22f8030e977785bc4ac7071b50511c393a3cee7594a0ee3fb0136e2f2ac661bc74a9d9e5ec5808b9fb88caf855b8ee3f1e6177ceb8965a3ca19ca5358cfff2b823ec8b480bd0ee3fedcfc0d5f1c3853c77915b9723432eb950a9b371b4e7ee3f22bd9f7c705b8f3c5681bfee5c86fbb8e4d3af8051ffee3ff028ad2566d87cbc75f354baab9716b93076db81e216ef3fb6af1046c9907d3c180dd176e53df5b845b87e81672eef3f944297b35d84553cad04dc0df604f6385506cf8be045ef3f08c13df95693833c866b8ceab3e007b9be36efac4d5def3f50b2c2cc7743873c26d77b68f1bc2039aeafeff0ae74ef3f7c394ed0242f74bca5acdbec3b0b0f39698cce63048cef3f333da705926b8cbc6e234642e55f2bb933c277114ea3ef3f9fd3b5e7a2a4883c99d69a522bdc26b9df44c5058cbaef3f85142fff53d77f3c37b8092cdfbef438f92a7f4cbed1ef3f0d44837388ac803cbadcada742ae0339a0d15bf1e4e8ef3fb42d1722f1ec723c88907f3167a61eb9')
  ctx.runtime.powExp2Table = powHexToBytes('cd3b7f669ea0e63f5664b21334dd8bbc75c1de3a3e7d25393e1775fa52b0e63f0e9d9a2cf5386a3c186d6259ba6bf938bfda0b7512c0e63f0d0bff67568962bc196c76585cefff384576d4dddccfe63f0973f1b6a97a8c3c9e7de927cb80f8b82f1a653cb2dfe63fab883c683abe5bbc78e7bb8af859ba38e53a599892efe63fb2c81a9e74b980bc90d12acab38d0ab9849451f97dffe63ff60e86250f3c78bc6e954a3f920100b9872ef466740fe73f5fa65ad444d6493ca1a2478fa89cddb8745fece8751fe73f997a8886476e71bcc3a45369796912b98ad0ea86822fe73f722cd62ca00a82bc87af0b7efb8d18b97481a5489a3fe73f3cd5656cd9a880bc68a7f317e22a2839fdcbd735bd4fe73f1c6e8a61fd47803c04b9ad3f03422b39c9674256eb5fe73fd36d3157592480bce8e519fae7f828b9096eabb12470e73ff847911677788b3c93b1e7d1c5b9eeb83f5dde4f6980e73f2d16020ab866883cf7327930424d24b9f61cac38b990e73f3eddaa62a849833c5fbd4fd609b100b98701eb7314a1e73f2f9904ee771574bcd4102d937a21d4b8dbcf76097bb1e73f88dc6884b5eb8bbc6dc00b4b750313b932c13001edc1e73fd64d16d14c128f3c03bbc26c234d2db9f086ff626ad2e73fb4b872fbdbbd813c8c6f94b65eda29b9624ecf36f3e2e73f7e7915ba025d603cdffcf827140ae73891c4918487f3e73fae1193cf117f70bcffb785360b9f1139121a3e542704e83f2b976d62867c82bc6eb1c9710d4e1d39d906d1add214e83f4d1d150d3764843c77d261654d692c3913ce4c998925e83fd83215d41d4c8dbcc1bacb65adf6e038f741b91e4c36e83fd52bdf319a9b893c8b2005ab00511e39adc723461a47e83ffbcd41a384d678bcd1ef165ce19115b9215b9f17f457e83fd016b2f848a74bbc90ee2ee7e658ea38ed92449bd968e83fbaf6d49bf8c68fbc21d98151f6161fb936a431d9ca79e83fbd47dbd2d7d2753c1fa99ec1799607b999668ad9c78ae83f3ab57cf3c294893cde85f33e28612d390f5878a4d09be83f2b20754495538d3cf40038928efd2fb9dba02a42e5ace83f274b8656f1e9863c336383a7440603b97817d6ba05bee83f6e4443fc5ecb8e3c607ef4b4f14e2e398c44b51632cfe83faae3e9325ed560bcd69d83dbb3daf3b8d966085e6ae0e83fe6b2c96f4a1187bca37c34ae62d1213936771599aef1e83f6c97e3a213cc753c6351b8d226bfc3388a2c28d0fe02e93fd23ffe85ca92853c7a400aa6ecaa2939c6ff910b5b14e93f2425582e79d68dbc4a53045285031c39e22faa53c325e93f7fdb39a65f4573bc430b22ab9a041ab9e5c5cdb03737e93fbc7eb581c75f57bcb20dac57e297f638e5985f2bb848e93f992d7d79d6c37dbc0b7e50ed82a614b90f52c8cb445ae93f39f0a5967c4b66bcbb8ba9c95370d0b8b370769add6be93f96c8197f96a54bbc2911a0e23348ec38504ede9f827de93fd1851b7c5b188dbc6f4b14d7b9ed2739a2227ae4338fe93fed784ca2daab6c3c12c377c8c22e0fb9ba07ca70f1a0e93f32e6ce91bd7381bc5f965478985300b90dfe534dbbb2e93f18d5f64d4ed88dbc314b18fee4670f3990f0a38291c4e93fbef271b0467c6c3c5c0843796b370639d5b84b1974d6e93f3382dda3be1685bc98c691ebba1905b92323e31963e8e93f6e4ce678ca24683ce0ba2b082cf9a0389ef2078d5efae93fcefaf1aacea974bc5d7888fce6f0143965e55d7b660cea3f33d51c5d495983bcfbb4514508541339bbb88eed7a1eea3f0ee78bee18668c3cc0782db72f7f2b39332d4aec9b30ea3fab36dc7d5c30863c176dc222fa472539d80a4680c942ea3f20b19f5880a78abc8391d8419e6e2db95d253eb20355ea3fe1418ddb6e2f8dbc483fd6df7afdfbb85260f48a4a67ea3f66036730560f553c750452ee9686eb3858b330139e79ea3fc763c5ca7ecb8b3c51f77631697826b9592ec153fe8bea3fa915bab267f884bc76a16b560d1f2039bffd79556b9eea3f31fdf70ec9fa803cb98c9ee36ab11839ba6e3521e5b0ea3f4545e9da319c783c71d9f0903bf40ab97af3d3bf6bc3ea3fd06ce7ca34927fbcf89676fcdb60fcb874273c3affd5ea3fe5b8b1b63bef873c842b2fd1551a23b9add35a999fe8ea3f81cc5d34cda1873cea75e63abc7f2a39fff222e64cfbea3fcd5e310ffcb284bc302f93a6d252223966b68d29070eeb3f25e4804cf5de8bbc0056c595bb1c143952899a6cce20eb3fcc56074a02dd843c9e8c92f6da8328b9fb154fb8a233eb3f08d784305e8052bcd9a4dd0ebcbaf238b149b7158446eb3f907cdfe93d766fbc6ff5f31c40e5f3b83a59e58d7259eb3fe36dbabbdf718cbcdff71d087074fcb82ac5f1296e6ceb3f6e3f8852f3a8823c6298a998eea11739475efbf2767feb3f3bac547e4f5865bc72abe18144a6fa38e44927f28c92eb3fc665cb5416728bbc672431d91e1115394a06a130b0a5eb3f2e29540ed3fc8ebc673c5091bfd1dab81f6f9ab7e0b8eb3f056269c9d1522fbc882005b899b4b1b8d2c14b901ecceb3f849e2d7ad03d723c58120e0564a1193907a2f3c369dfeb3f525bea6023262cbcff8465c2b82acbb8091ed75bc2f2eb3f739c6b3fcafd8ebcda59cdce817e02393db341612806ec3f34cafba15a8a7dbc9546df0f5dfd06b99c5285dd9b19ec3fdd4850896510713cda285912519e09392c65fad91c2dec3fd7a5c81716e586bcdee5ea370eaf05b97ad0ff5fab40ec3f0ac683e037458b3cf8f470facda6143922fbfa784754ec3fafb59324072f813cac83f5444e6317394bd1572ef167ec3fad3c48ff4d88823cb25c9d324cc41fb933c98889a87bec3f595525bebb767ebc00b57558843902b9b5e706946d8fec3f445c8048bcac613cfab800c1aaedf638dbc4515740a3ec3ff5080dd1bef277bc5a5894cc3352c4386990efdc20b7ec3fdb49e9d1cb03653c2e036b5665870d3975166d2e0fcbec3f939000860f226dbcb3b373e724040e39fac35d550bdfec3f729d82533bd87dbc4920743a07eaeab874ab5b5b15f3ec3f57ff6db8e9088abcf76dba56fe4307b97c89074a2d07ed3f9c7a794337bc8cbcf6a09d0344702eb968c9082b531bed3fee369a213656853c73cd11c6e66c29b9f2890d08872fed3f78859d717b488dbce7faa9b262daf238d6a1caeac843ed3f14165abf53db833cf7567a10bd20243987a4fbdc1858ed3f07375bd702ed723cfc3155b053b0fab8d3e662e8766ced3fa065814a7ae84f3cff759cf50117cb389883c916e380ed3fe8dfed8bc11e81bc5a76c87a4ed00eb97560ff715d95ed3fbef69abb2d058a3c14204926c50d23398532db03e6a9ed3f32b56d6900238c3c15c60e6f24f6273915833ad67cbeed3fe48b6b92f1768bbc2d61e6118f8320b960b401f321d3ed3fc318f07857da823cf31c66adde6c2cb958061c64d5e7ed3f8fba798e52a58cbce15e2b82fdf914395f9b7b3397fced3f5c4b184fcda581bcd6ef44a925722b39177d196b6711ee3f447f5cbd29b562bc2a07a59c3086033929a1f5144626ee3f96147a8127b687bc9a408c8018982bb912ee163b333bee3f8bc6fd31a4f489bc84c79e916db82839f63f8be72e50ee3f8fcca980899e733c78d2c2b32ce91139766d67243965ee3f35b72275f83f76bc18a7b58dfcbd0139834cc7fb517aee3fe28d0cca22d5823ccba9b6b057a728b940b7cd77798fee3fb154b080940881bccbb70358ae061339da90a4a2afa4ee3f93289c17239c8ebcdef3bb42f2c01fb96eca7c86f4b9ee3ff2e493222f83843ce8cb5102c40f29b9f1678e2d48cfee3f8cad11b4f3938cbc3bb444efdfb920b9108518a2aae4ee3f8d5687a48dc6813c247e07b58d1c0339275a61ee1bfaee3fb0b6a486f4c78d3c69ff29d2d56d2f392a41b61c9c0fef3f451d1865002283bc5bb0934211f823b997ba6b372b25ef3f438e0dbfa5a1833c16b57654adc624397472dd48c93aef3fde37d83e5a5a69bc10cce43f180ae43840456e5b7650ef3f8ba1d82de1d3893cf30ec8ff9b0104b9f84488793266ef3f3e3439357ba38f3c139e4c5aa426173914be9cadfd7bef3f0a3506d012bb8dbc4dfa8072cec52539893c2402d891ef3f89f679a7a82e51bc57efc3bf2493f8b8d8909e81c1a7ef3f1e93a5f35348773c51766fc360c0ed3814d59236babdef3fb68e0915736769bc329a8ad2d40c0b39f1718f2bc2d3ef3fe779659674eb523c6cc54e9396f0f238d9232a6bd9e9ef3fe3fd427403a6643cf30a13e885afeb38000000000000f03f00000000000000000000000000000000bfbc5afa1a0bf03f719f60a7b2f684bc083c3f52dd550bb93533fba93d16f03fb7cdb89a29619b3c8709d80780f42b3981023b146821f03fb64ec50f31bf82bc0bff27a73e9529396180773e9a2cf03f5d085b53839071bcd5743d0a5b0819b9ccbb112ed437f03f1ae1adee1168653ce977bd5a3d310139857f6ee81543f03f6ec977191ca390bc40404bf4fb12f9b8b154f6725f4ef03f8dd0a03a79c3843ce2af722b139c2fb9748515d3b059f03f65b475a4e2738d3c7e258d4ff95f1039891f3c0e0a65f03f97c399577bcb95bc984c6cfeade03339def6dd296b70f03f273cb1e2df918cbcab242c2e1fb41f3936a8722bd47bf03f008745543423833c6e3699508d2b09b9c89b75184587f03fff84b24bbe86613c4f416bd920580139e00766f6bd92f03fd13f0a80638096bcf83ed6f89f18043983f3c6ca3e9ef03f366131187848913c59c2fdd1458b34b919391f9bc7a9f03f381d3d876cd1853cdd230277d9f82cb90f89f96c58b5f03f0b61dc4a2ea6983c4cf7ebd69b7c36b9856ce445f1c0f03fef1cd20689f9943c8e3712c4719d0339f747722b92ccf03f714fe216dc1e903ce36f4e56ac8a3e39ec5d39233bd8f03f6a313fe44dc19bbc9c382ec1be9616b9a2d1d332ece3f03f537bc527173a403cdb9d4e9976aae5b8c5a9df5fa5eff03f1b0254bcb99d94bcfcf10371d54a3db91bd3feaf66fbf03f7bbd4ec4ed9b6bbc5942d8491febfab83e23d7283007f13fd5fd9216eb468d3ca875485b01571f39515b12d00113f13f3a9b443910c596bc2d568f988bd52939b62a5eabdb1ef13f72fb03f754a49cbc8825b0214b45f338cc316cc0bd2af13fc7a56cb314b551bc203108428f8df0b8ab04f214a836f13ff0dc48ba8f1067bcaa1ce9344e9a0c39e02da9ae9a42f13f9e36f19abf2f93bc1664c7b47bfe32b92e314f93954ef13fab44bf39e8918bbc327293d6fedd27b9518ea5c8985af13f0aabeeb96a40823c74c47952571b10b9c2c37154a466f13f321aea823bf2583c80f4f9656fecfc387b517d3cb872f13f768ad7b9419081bcf03fa16a40f22439c0bb9586d47ef13f645aace23f9e703c10929cec4cf90039ea8d8c38f98af13f6c0f97d1231091bcc5970b04f02517392f5d37582697f13f087ef185ddaa943c99a3308a6729263975cb6feb5ba3f13fe468497b4c5b8e3ce86a928361d30a391c8a13f899aff13f8092b6a485bf973cd07bbf23c4c215b9d45c0484e0bbf13f07f62e35865399bc8e710395a60c24b96b1c28952fc8f13fc9f810807709903c674ec981b87518b9aab9683187d4f13f3c64a2006e019e3c18b981082da61e392740b45ee7e0f13fdeb68c08d8fd96bc068766819f4530b91dd9fc2250edf13f8cb77b0298df91bc7574c4364d503e394dce3884c1f9f13f5caf97a024f59bbc1c06837fd78627b9d68c62883b06f23f95844a8175c78d3ca41e6fc1db8107b919a87835be12f23fc9aafc2c2d59933caac80902b46416b996dc7d91491ff23feea594947ea9823c6b10b7b3c29326b9d11279a2dd2bf23f9fd67755fb348d3c7830845221871bb93862756e7a38f23f7305c7b67eb0993ce032f59a9fd824b90a1482fb1f45f23f96a91c91cccf8a3c00703c513b4618393fa6b24fce51f23fa4f4f4be55c18a3c97f7dcafc8a9f13875ce1e71855ef23f2c1bc34aa2e1933ccd8b08766eba3539dd7ce265456bf23fd9e9409933bd823c771b463a3977123929df1d340e78f23f6ce7f9057c069e3c8b53e4ceb7d43bb98163f5e1df84f23f7e0d3f8c3a4c9abc7d2de5a2da7f363970bb9175ba91f23fbd1c402872cc82bcc4e4462d90a3d738e1de1ff59d9ef23f5512adafe812863c9046608544e50d39130fd1668aabf23fa7901619435799bcf6b7737e6dde2db990d9dad07fb8f23fa41a38d6dc0a41bcbd6d79b85f88e0382f1b77397ec5f23f2451eba6450195bcd4bf5c425c243eb90b03e4a685d2f23fd541db544702903c0793cbf8d8e91eb98915641f96dff23f98e1bcfbcf169d3c80f75c7ac6ad2a39562f3ea9afecf23f8323d5450fca713c2ad1e6de087b0d396b88bd4ad2f9f23f93da2b53553c65bc9820749c0886023915b7310afe06f33fe48231d26af4863cd9d09cf0b2b71739fdb2eeed3214f33fd1fcf3f3a359893cb5811b07eb1c29b931d84cfc7021f33f7c04188ee79c8a3ce8852b888c771b3932eaa83bb82ef33f18f3b43ce8459cbcb998083ac7783bb9ff1664b2083cf33fa65936842127933c6bfc6ceaa20634b92dfae3666249f33fa4810893755a83bcc96c7b6aaf7504b9f19f925fc556f33f28464e5cee5c8bbcf2d520e524e528b93b88dea23164f33f5eb86ca044318cbc96802341b08b2f39cba93a37a771f33fe2ea42bfea3a96bcfa6b51123e7e38394a751e23267ff33f3cb2ce9ecaf599bcf8127eed6974053966d8056dae8cf33fbd04993c8d959ebc214f40617aa72039ef40711b409af33f34298efca5a999bc7a0b91aef88f31b9f79fe534dba7f33fe3f561d636e475bc96c217ffb1b00939f46cecbf7fb5f33f18ff6fe2664c953c80bee3b2f8683d39e5a813c32dc3f33fc3295d37f8ff9ebc5a39932a3f1421b973e1ed44e5d0f33f714c288cd0e87f3c1559a64e16bac1382234124ca6def33fbc9ef01109da8a3cb78ffa68ba0828b975511cdf70ecf33fca9b8c7b63f68abc26ba49f3debc09b91c80ac0445faf33ff3f956f923d097bc0d2024373e4730b924a067c32208f43f48d0f4b6f8dd8b3ccf9544751c8b22392a2ef7210a16f43f7892301c69f35ebc1865fcea432bd3b88a460927fb23f43fdd14b3c02d4698bc80feff78d9ca31b997a850d9f531f43f99795fe3ddc781bcef5f1996c4032939d4b9843ffa3ff43f03c00497be80883cdf5849ca664929b92d896160084ef43fd080ef047a9b483c22d9e32d31acd0b832d2a742205cf43f8e1ffb82196468bcc85a5ae4395af8b857001ded416af43f768a64d14b949c3c3a1ff24f40df373937328b666d78f43f335744edf0209cbc083b3da2afb61cb9d03cc1b5a286f43ff06290b6a3c1733cc03a74aeeb1e0e39d2ae92e1e194f43fa09e495e89b283bca67223bb055c2f39ded3d7f02aa3f43f56bed1f362cb993cc7e261c776181939d7b76dea7db1f43ff097287fb82581bc2dee116a40241839272a36d5dabff43fe242ecaf97437d3c392b5c74c706ec3814c117b841cef43f5dbd0a69295e903c6778872174972bb90dddfd99b2dcf43f33786abcdbec983c439b5569c9121239ffabd8812debf43f527a5d2e7d2595bc22db115a0e772eb9a72c9d76b2f9f43fe35759d209b394bccd85b6d71faaf1b8ee31457f4108f53f5f46b7499b247a3cf8110a5f6d420fb94266cfa2da16f53fef93bd6985768fbc7d172682710ef938ef4e3fe87d25f53f71efef438d997cbce8d175164a9710b9824f9d562b34f53fad3cb11dbe7a80bc4c211f9533a70f3927adf6f4e242f53f7e5f2d196d92873caa6ba02e782611b90f925dcaa451f53f9be5edef9c688dbc93041b7791c91939d210e9dd7060f53ff0eb8e166efb90bc715c57ae29113939da27b536476ff53fad931d012cbb993cff13a65268f80fb9cfc4e2db277ef53fc4b9578a8cb990bc20aa4f1f89393db9fdc797d4128df53fe81d9a5be195823cc6e4d12ad9262ab9cc07ff27089cf53f0fe667e4cee297bc25bc1b2f770c2d39295448dd07abf53fad4746054c32963cfeda6f50ee4427b9037aa8fb11baf53f1a3e234ca1779bbc004288b1df763439b746598a26c9f53fa28669811b4b3c3c8c97545273c28e38938b999045d8f53f4356b4a8a7d69cbcfbb7d1eccf6d32394821ad156fe7f53f5ee68030f9a69b3cd6a75fb79a5f39b971ebdc20a3f6f53f92cfcde3ddea89bc7974c7fba6e1203909dc76b9e105f63f47de569b42e293bc88252eb9542c13b9f4f6cde62a15f63f274cb84a3e4b9e3cc85a3264caa305b985553ab07e24f63f97b4407ec18393bc91b9cf57e7d80539fd29191ddd33f63fe564b9be1047983cb6dd0b51212e373920c3cc344643f63f33899d753c488cbc0fc4c10040901339b78fbcfeb952f63f093ea7c9d5e39abc1a3c878aa6fd3339252255823862f63f341c598709b69bbc3b0adcf437a33439f63308c7c171f63f34616c5832878ebc25da440de8592f3973a94cd45581f63f653ef744ae38603cff043b630328efb838959eb1f490f63f5d44eb9abd04883caaebbcc8eaf828b9')

  wat('math.pow_transcend', genPowTranscend(), ['math.pow_scalbn'])
  } // if (crPow)

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
    ;; Remaining case: x > 0 finite (≠1), y finite (≠0,≠1) and not an i32-range integer.
    ;; $math.pow_core below is a correctly-rounded fdlibm port by default (no exp/log double-
    ;; rounding), or — under optimize.crPow — CORRECTLY ROUNDED in the stronger CORE-MATH sense
    ;; (two-phase Ziv dd/td kernel, see $math.pow_core's own comment).
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

  // x**y for the case the ladder above can't fast-path: x > 0 finite (≠1), y finite (≠0,≠1) and
  // not an i32-range integer. y==0.5 is always special-cased to hardware sqrt (correctly
  // rounded, cheaper than either general kernel below) regardless of crPow. Two kernels, picked
  // by `optimize.crPow` (see the authoritative comment above `emitPow` for the flag's full
  // semantics and the measured cost of switching):
  //   OFF (DEFAULT): ported from fdlibm/FreeBSD msun's e_pow.c (Sun Microsystems, freely
  //     licensed — https://raw.githubusercontent.com/freebsd/freebsd-src/main/lib/msun/src/
  //     e_pow.c), the same algorithm V8's base/ieee754.cc ports for Math.pow — so this targets
  //     bit-exactness against the host, not just low ulps (though it is "nearly rounded", not
  //     CORE-MATH-class correctly rounded — see $math.pow_transcend for that). Trimmed to the
  //     x>0 slice: fdlibm's sign/yisint bookkeeping for x<0 is dead weight here (x<0 already
  //     returned NaN above).
  //     1. log2(x) in double-double (hi+lo): bit-extract the exponent, reduce the mantissa
  //        around 1 or 1.5 (whichever centers it tighter), run the L1..L6 minimax on
  //        s=(m-bp)/(m+bp). |y| ≥ 2^31 skips straight to a 1-term series, valid because the
  //        only way such a y doesn't over/underflow outright is x within 2^-20 of 1.
  //     2. y*log2(x) in double-double, with an early overflow/underflow return once the
  //        exponent product is unambiguously outside (-1075, 1024).
  //     3. 2^(that product): round to the nearest integer n — via the high-word bit trick
  //        fdlibm uses, not float rounding, so the fractional remainder stays exact — evaluate
  //        the P1..P5 minimax on the fraction, then splice n back in as a raw exponent-field
  //        add, falling back to $math.pow_scalbn only when that add would underflow the
  //        exponent field.
  //   ON: delegates to the shared two-phase Ziv dd/td kernel — see $math.pow_transcend's own
  //     comment above for the algorithm. CORE-MATH-class correctly rounded (0 misrounds on the
  //     5152-vector gate, test/pow-cr.js) at a measured ~13x runtime cost on gamma-heavy color
  //     kernels (colorpq), hence opt-in rather than default.
  wat('math.pow_core', crPow
    ? `(func $math.pow_core (param $x f64) (param $y f64) (result f64)
    (if (f64.eq (local.get $y) (f64.const 0.5))
      (then (return (f64.sqrt (local.get $x)))))
    (call $math.pow_transcend (local.get $x) (local.get $y)))`
    : `(func $math.pow_core (param $x f64) (param $y f64) (result f64)
    (local $ax f64) (local $u f64) (local $v f64) (local $w f64) (local $t f64) (local $r f64)
    (local $t1 f64) (local $t2 f64) (local $y1 f64) (local $p_h f64) (local $p_l f64) (local $z f64)
    (local $ss f64) (local $s2 f64) (local $s_h f64) (local $s_l f64) (local $t_h f64) (local $t_l f64)
    (local $z_h f64) (local $z_l f64) (local $bp_k f64) (local $dp_h_k f64) (local $dp_l_k f64)
    (local $ix i32) (local $hy i32) (local $iy i32) (local $j i32) (local $i i32) (local $k i32) (local $n i32)

    ;; y == 0.5 exactly (x > 0 here, always a valid sqrt domain): matches fdlibm/V8's own sqrt
    ;; fast path, and f64.sqrt is correctly rounded so this can only help bit-exactness.
    (if (f64.eq (local.get $y) (f64.const 0.5))
      (then (return (f64.sqrt (local.get $x)))))

    (local.set $ax (local.get $x))
    (local.set $ix (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $x)) (i64.const 32))))
    (local.set $hy (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $y)) (i64.const 32))))
    (local.set $iy (i32.and (local.get $hy) (i32.const 0x7fffffff)))

    (if (i32.gt_u (local.get $iy) (i32.const 0x41e00000))
      (then
        ;; |y| > 2^31: definite overflow/underflow unless x is within ~2^-20 of 1, in which
        ;; case log(x) via a short series (x-x^2/2+x^3/3-x^4/4) suffices.
        (if (i32.gt_u (local.get $iy) (i32.const 0x43f00000))
          (then
            (if (i32.le_u (local.get $ix) (i32.const 0x3fefffff))
              (then (return (select (f64.const inf) (f64.const 0.0) (i32.lt_s (local.get $hy) (i32.const 0))))))
            (if (i32.ge_u (local.get $ix) (i32.const 0x3ff00000))
              (then (return (select (f64.const inf) (f64.const 0.0) (i32.gt_s (local.get $hy) (i32.const 0))))))))
        (if (i32.lt_u (local.get $ix) (i32.const 0x3fefffff))
          (then (return (select (f64.const inf) (f64.const 0.0) (i32.lt_s (local.get $hy) (i32.const 0))))))
        (if (i32.gt_u (local.get $ix) (i32.const 0x3ff00000))
          (then (return (select (f64.const inf) (f64.const 0.0) (i32.gt_s (local.get $hy) (i32.const 0))))))
        (local.set $t (f64.sub (local.get $ax) (f64.const 1.0)))
        (local.set $w (f64.mul (f64.mul (local.get $t) (local.get $t))
          (f64.sub (f64.const 0.5) (f64.mul (local.get $t)
            (f64.sub (f64.const 3.3333333333333331e-01) (f64.mul (local.get $t) (f64.const 0.25)))))))
        (local.set $u (f64.mul (f64.const 1.44269502162933349609e+00) (local.get $t)))
        (local.set $v (f64.sub (f64.mul (local.get $t) (f64.const 1.92596299112661746887e-08))
                                (f64.mul (local.get $w) (f64.const 1.44269504088896338700e+00))))
        (local.set $t1 (f64.add (local.get $u) (local.get $v)))
        (local.set $t1 (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $t1)) (i64.const 0xffffffff00000000))))
        (local.set $t2 (f64.sub (local.get $v) (f64.sub (local.get $t1) (local.get $u)))))
      (else
        (local.set $n (i32.const 0))
        ;; Subnormal x: scale into the normal range and remember the shift.
        (if (i32.lt_u (local.get $ix) (i32.const 0x00100000))
          (then
            (local.set $ax (f64.mul (local.get $ax) (f64.const 9007199254740992.0)))
            (local.set $n (i32.sub (local.get $n) (i32.const 53)))
            (local.set $ix (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ax)) (i64.const 32))))))
        (local.set $n (i32.add (local.get $n) (i32.sub (i32.shr_u (local.get $ix) (i32.const 20)) (i32.const 0x3ff))))
        (local.set $j (i32.and (local.get $ix) (i32.const 0x000fffff)))
        (local.set $ix (i32.or (local.get $j) (i32.const 0x3ff00000)))
        ;; Interval split: center the reduced mantissa on 1 (k=0, |x|<sqrt(3/2)) or 1.5
        ;; (k=1, |x|<sqrt(3)) — whichever keeps s=(m-bp[k])/(m+bp[k]) smaller.
        (if (i32.le_u (local.get $j) (i32.const 0x0003988E))
          (then (local.set $k (i32.const 0)))
          (else (if (i32.lt_u (local.get $j) (i32.const 0x000BB67A))
            (then (local.set $k (i32.const 1)))
            (else
              (local.set $k (i32.const 0))
              (local.set $n (i32.add (local.get $n) (i32.const 1)))
              (local.set $ix (i32.sub (local.get $ix) (i32.const 0x00100000)))))))
        (local.set $ax (f64.reinterpret_i64
          (i64.or (i64.and (i64.reinterpret_f64 (local.get $ax)) (i64.const 0x00000000ffffffff))
                  (i64.shl (i64.extend_i32_u (local.get $ix)) (i64.const 32)))))
        (local.set $bp_k (select (f64.const 1.5) (f64.const 1.0) (i32.eq (local.get $k) (i32.const 1))))
        (local.set $dp_h_k (select (f64.const 0.584962487220764160156) (f64.const 0.0) (i32.eq (local.get $k) (i32.const 1))))
        (local.set $dp_l_k (select (f64.const 1.35003920212974897128e-08) (f64.const 0.0) (i32.eq (local.get $k) (i32.const 1))))
        (local.set $u (f64.sub (local.get $ax) (local.get $bp_k)))
        (local.set $v (f64.div (f64.const 1.0) (f64.add (local.get $ax) (local.get $bp_k))))
        (local.set $ss (f64.mul (local.get $u) (local.get $v)))
        (local.set $s_h (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $ss)) (i64.const 0xffffffff00000000))))
        ;; t_h ≈ (ax+bp[k]) with its low 32 bits cleared, built directly from ix's bits (half
        ;; the exponent+mantissa, plus fdlibm's fixed per-k offsets) rather than an add+round.
        (local.set $t_h (f64.reinterpret_i64 (i64.shl
          (i64.extend_i32_u (i32.add (i32.add
            (i32.or (i32.shr_u (local.get $ix) (i32.const 1)) (i32.const 0x20000000))
            (i32.const 0x00080000))
            (i32.shl (local.get $k) (i32.const 18))))
          (i64.const 32))))
        (local.set $t_l (f64.sub (local.get $ax) (f64.sub (local.get $t_h) (local.get $bp_k))))
        (local.set $s_l (f64.mul (local.get $v)
          (f64.sub (f64.sub (local.get $u) (f64.mul (local.get $s_h) (local.get $t_h))) (f64.mul (local.get $s_h) (local.get $t_l)))))
        (local.set $s2 (f64.mul (local.get $ss) (local.get $ss)))
        (local.set $r (f64.mul (f64.mul (local.get $s2) (local.get $s2))
          (f64.add (f64.const 5.99999999999994648725e-01) (f64.mul (local.get $s2)
            (f64.add (f64.const 4.28571428578550184252e-01) (f64.mul (local.get $s2)
              (f64.add (f64.const 3.33333329818377432918e-01) (f64.mul (local.get $s2)
                (f64.add (f64.const 2.72728123808534006489e-01) (f64.mul (local.get $s2)
                  (f64.add (f64.const 2.30660745775561754067e-01) (f64.mul (local.get $s2) (f64.const 2.06975017800338417784e-01)))))))))))))
        (local.set $r (f64.add (local.get $r) (f64.mul (local.get $s_l) (f64.add (local.get $s_h) (local.get $ss)))))
        (local.set $s2 (f64.mul (local.get $s_h) (local.get $s_h)))
        (local.set $t_h (f64.add (f64.add (f64.const 3.0) (local.get $s2)) (local.get $r)))
        (local.set $t_h (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $t_h)) (i64.const 0xffffffff00000000))))
        (local.set $t_l (f64.sub (local.get $r) (f64.sub (f64.sub (local.get $t_h) (f64.const 3.0)) (local.get $s2))))
        (local.set $u (f64.mul (local.get $s_h) (local.get $t_h)))
        (local.set $v (f64.add (f64.mul (local.get $s_l) (local.get $t_h)) (f64.mul (local.get $t_l) (local.get $ss))))
        (local.set $p_h (f64.add (local.get $u) (local.get $v)))
        (local.set $p_h (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $p_h)) (i64.const 0xffffffff00000000))))
        (local.set $p_l (f64.sub (local.get $v) (f64.sub (local.get $p_h) (local.get $u))))
        (local.set $z_h (f64.mul (f64.const 9.61796700954437255859e-01) (local.get $p_h)))
        (local.set $z_l (f64.add (f64.add
          (f64.mul (f64.const -7.02846165095275826516e-09) (local.get $p_h))
          (f64.mul (local.get $p_l) (f64.const 9.61796693925975554329e-01)))
          (local.get $dp_l_k)))
        (local.set $t (f64.convert_i32_s (local.get $n)))
        (local.set $t1 (f64.add (f64.add (f64.add (local.get $z_h) (local.get $z_l)) (local.get $dp_h_k)) (local.get $t)))
        (local.set $t1 (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $t1)) (i64.const 0xffffffff00000000))))
        (local.set $t2 (f64.sub (local.get $z_l)
          (f64.sub (f64.sub (f64.sub (local.get $t1) (local.get $t)) (local.get $dp_h_k)) (local.get $z_h))))))

    ;; Combine: (y1+y2)*(t1+t2) where y1 is y with its low 32 bits cleared, y2=y-y1 — a
    ;; double-double multiply of y against log2(x).
    (local.set $y1 (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $y)) (i64.const 0xffffffff00000000))))
    (local.set $p_l (f64.add (f64.mul (f64.sub (local.get $y) (local.get $y1)) (local.get $t1)) (f64.mul (local.get $y) (local.get $t2))))
    (local.set $p_h (f64.mul (local.get $y1) (local.get $t1)))
    (local.set $z (f64.add (local.get $p_l) (local.get $p_h)))
    (local.set $j (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $z)) (i64.const 32))))
    (local.set $i (i32.wrap_i64 (i64.reinterpret_f64 (local.get $z))))

    (if (i32.ge_s (local.get $j) (i32.const 0x40900000))
      (then
        (if (i32.ne (i32.or (i32.sub (local.get $j) (i32.const 0x40900000)) (local.get $i)) (i32.const 0))
          (then (return (f64.const inf)))
          (else (if (f64.gt (f64.add (local.get $p_l) (f64.const 8.0085662595372944372e-17)) (f64.sub (local.get $z) (local.get $p_h)))
            (then (return (f64.const inf)))))))
      (else (if (i32.ge_u (i32.and (local.get $j) (i32.const 0x7fffffff)) (i32.const 0x4090cc00))
        (then
          (if (i32.ne (i32.or (i32.sub (local.get $j) (i32.const 0xc090cc00)) (local.get $i)) (i32.const 0))
            (then (return (f64.const 0.0)))
            (else (if (f64.le (local.get $p_l) (f64.sub (local.get $z) (local.get $p_h)))
              (then (return (f64.const 0.0))))))))))

    ;; 2^(p_h+p_l): round to nearest integer n (bit trick, not float round, to keep the
    ;; fractional remainder's low bits exact), evaluate the P1..P5 kernel on it, splice n back
    ;; in as a raw exponent-field add.
    (local.set $i (i32.and (local.get $j) (i32.const 0x7fffffff)))
    (local.set $k (i32.sub (i32.shr_u (local.get $i) (i32.const 20)) (i32.const 0x3ff)))
    (local.set $n (i32.const 0))
    (if (i32.gt_u (local.get $i) (i32.const 0x3fe00000))
      (then
        (local.set $n (i32.add (local.get $j) (i32.shr_u (i32.const 0x00100000) (i32.add (local.get $k) (i32.const 1)))))
        (local.set $k (i32.sub (i32.shr_u (i32.and (local.get $n) (i32.const 0x7fffffff)) (i32.const 20)) (i32.const 0x3ff)))
        (local.set $t (f64.reinterpret_i64 (i64.shl
          (i64.extend_i32_u (i32.and (local.get $n) (i32.xor (i32.shr_u (i32.const 0x000fffff) (local.get $k)) (i32.const -1))))
          (i64.const 32))))
        (local.set $n (i32.shr_u (i32.or (i32.and (local.get $n) (i32.const 0x000fffff)) (i32.const 0x00100000)) (i32.sub (i32.const 20) (local.get $k))))
        (if (i32.lt_s (local.get $j) (i32.const 0)) (then (local.set $n (i32.sub (i32.const 0) (local.get $n)))))
        (local.set $p_h (f64.sub (local.get $p_h) (local.get $t)))))
    (local.set $t (f64.add (local.get $p_l) (local.get $p_h)))
    (local.set $t (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $t)) (i64.const 0xffffffff00000000))))
    (local.set $u (f64.mul (local.get $t) (f64.const 6.93147182464599609375e-01)))
    (local.set $v (f64.add (f64.mul (f64.sub (local.get $p_l) (f64.sub (local.get $t) (local.get $p_h))) (f64.const 6.93147180559945286227e-01))
                            (f64.mul (local.get $t) (f64.const -1.90465429995776804525e-09))))
    (local.set $z (f64.add (local.get $u) (local.get $v)))
    (local.set $w (f64.sub (local.get $v) (f64.sub (local.get $z) (local.get $u))))
    (local.set $t (f64.mul (local.get $z) (local.get $z)))
    (local.set $t1 (f64.sub (local.get $z) (f64.mul (local.get $t)
      (f64.add (f64.const 1.66666666666666019037e-01) (f64.mul (local.get $t)
        (f64.add (f64.const -2.77777777770155933842e-03) (f64.mul (local.get $t)
          (f64.add (f64.const 6.61375632143793436117e-05) (f64.mul (local.get $t)
            (f64.add (f64.const -1.65339022054652515390e-06) (f64.mul (local.get $t) (f64.const 4.13813679705723846039e-08))))))))))))
    (local.set $r (f64.sub
      (f64.div (f64.mul (local.get $z) (local.get $t1)) (f64.sub (local.get $t1) (f64.const 2.0)))
      (f64.add (local.get $w) (f64.mul (local.get $z) (local.get $w)))))
    (local.set $z (f64.sub (f64.const 1.0) (f64.sub (local.get $r) (local.get $z))))
    (local.set $j (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $z)) (i64.const 32))))
    (local.set $j (i32.add (local.get $j) (i32.shl (local.get $n) (i32.const 20))))
    (if (result f64) (i32.le_s (i32.shr_s (local.get $j) (i32.const 20)) (i32.const 0))
      (then (call $math.pow_scalbn (local.get $z) (local.get $n)))
      (else (f64.reinterpret_i64 (i64.or (i64.and (i64.reinterpret_f64 (local.get $z)) (i64.const 0x00000000ffffffff))
                                          (i64.shl (i64.extend_i32_u (local.get $j)) (i64.const 32)))))))`,
    crPow ? ['math.pow_transcend'] : ['math.pow_scalbn'])

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

  // fdlibm atan: 4-region argument reduction onto |r| ≤ tan(π/16), then an
  // 11-term odd polynomial split into even/odd parts. Accurate to <1 ulp —
  // the old Taylor series was ~2e-6 off near |x|=0.5. Drives asin/acos/atan2.
  // Fast atan: sign symmetry (work on |x|), two-stage reduction onto [0, tan(π/8)] — |x|>1 →
  // π/2−atan(1/x), then t>tan(π/8) → π/8+atan((t−C)/(1+Ct)) — then a degree-5 minimax t·P(t²).
  // Replaces the fdlibm 4-way / 11-term / extended-precision form (correctly-rounded but ~3× the
  // ops). Max rel err 6e-10 over all of ℝ — well within jz's ~1e-9 transcendental budget. asin =
  // atan(x/√(1−x²)) and acos = π/2−asin inherit it, so all three drop from ~1.6–2.3× to under V8.
  wat('math.atan', `(func $math.atan (param $x f64) (result f64)
    (local $t f64) (local $u f64) (local $r f64) (local $off f64) (local $flip i32)
    ;; NaN passes through; ±0 returns x (preserves sign of zero); ±Inf flows through (1/Inf=0 → π/2).
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (local.set $t (f64.abs (local.get $x)))
    (local.set $off (f64.const 0.0))
    (local.set $flip (i32.const 0))
    (if (f64.gt (local.get $t) (f64.const 1.0))
      (then (local.set $t (f64.div (f64.const 1.0) (local.get $t))) (local.set $flip (i32.const 1))))
    (if (f64.gt (local.get $t) (f64.const 0.41421356237309503))
      (then
        (local.set $t (f64.div (f64.sub (local.get $t) (f64.const 0.41421356237309503))
                               (f64.add (f64.const 1.0) (f64.mul (f64.const 0.41421356237309503) (local.get $t)))))
        (local.set $off (f64.const 0.39269908169872414))))
    (local.set $u (f64.mul (local.get $t) (local.get $t)))
    (local.set $r (f64.add (local.get $off)
      (f64.mul (local.get $t)
        (f64.add (f64.const 0.99999999939667072)
          (f64.mul (local.get $u)
            (f64.add (f64.const -0.33333307625846248)
              (f64.mul (local.get $u)
                (f64.add (f64.const 0.19998216947828790)
                  (f64.mul (local.get $u)
                    (f64.add (f64.const -0.14240083011830104)
                      (f64.mul (local.get $u)
                        (f64.add (f64.const 0.10573479828448784)
                          (f64.mul (local.get $u) (f64.const -0.060347904072425573))))))))))))))
    (if (local.get $flip) (then (local.set $r (f64.sub (f64.const 1.5707963267948966) (local.get $r)))))
    (f64.copysign (local.get $r) (local.get $x)))`)

  // Fast asin: small-argument poly a + a·u·R(u) (u=a²) with the standard half-angle reduction for
  // |x|>0.5 — a = sqrt((1−|x|)/2) maps the singular end to the smooth domain, asin = π/2 − 2·poly.
  // One sqrt only on the upper half, no atan/div. R is a degree-6 minimax on [0,0.25]; max rel err
  // ~2.6e-10. Replaces asin = atan(x/√(1−x²)) (which paid a div + atan's own reductions).
  wat('math.asin', `(func $math.asin (param $x f64) (result f64)
    (local $ax f64) (local $a f64) (local $u f64) (local $r f64)
    ;; |x|>1 → NaN (covers ±Inf); NaN propagates (the >1 test is false, poly carries NaN through).
    (if (f64.gt (f64.abs (local.get $x)) (f64.const 1.0)) (then (return (f64.const nan))))
    (local.set $ax (f64.abs (local.get $x)))
    (if (f64.le (local.get $ax) (f64.const 0.5))
      (then (local.set $a (local.get $ax)))
      (else (local.set $a (f64.sqrt (f64.mul (f64.const 0.5) (f64.sub (f64.const 1.0) (local.get $ax)))))))
    (local.set $u (f64.mul (local.get $a) (local.get $a)))
    (local.set $r (f64.add (local.get $a) (f64.mul (f64.mul (local.get $a) (local.get $u))
      (f64.add (f64.const 0.16666666715486264)
        (f64.mul (local.get $u)
          (f64.add (f64.const 0.074999892151409259)
            (f64.mul (local.get $u)
              (f64.add (f64.const 0.044648555271317079)
                (f64.mul (local.get $u)
                  (f64.add (f64.const 0.030259196387355945)
                    (f64.mul (local.get $u)
                      (f64.add (f64.const 0.023661273034955098)
                        (f64.mul (local.get $u)
                          (f64.add (f64.const 0.010472588920432560)
                            (f64.mul (local.get $u) (f64.const 0.031028862087420162))))))))))))))))
    (if (f64.gt (local.get $ax) (f64.const 0.5))
      (then (local.set $r (f64.sub (f64.const 1.5707963267948966) (f64.mul (f64.const 2.0) (local.get $r))))))
    (f64.copysign (local.get $r) (local.get $x)))`)

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

  // Bit-hack initial guess (divide the IEEE exponent by 3 via an integer divide of the raw bits,
  // plus a magic bias) then 3 Newton steps  t = (2t + a/t²)/3  — quadratic convergence, max rel err
  // ~1e-12 over the whole f64 range. Replaces the old `pow(x,1/3)` seed: no exp/log call, ~3-4×
  // faster (the colorconv / Oklab hot path is 3 cbrt per pixel), and a program whose only
  // transcendental is cbrt no longer pulls the pow/exp/log stdlib. Not bit-identical to V8's fdlibm
  // cbrt (neither was the pow form) — jz's transcendentals are fast minimax/Newton approximations.
  wat('math.cbrt', `(func $math.cbrt (param $x f64) (result f64)
    (local $a f64) (local $t f64) (local $s f64)
    ;; NaN / ±Infinity / ±0 pass through unchanged (sign of zero preserved).
    (if (i32.eqz (call $math.isFinite (local.get $x))) (then (return (local.get $x))))
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (local.set $a (f64.abs (local.get $x)))
    (local.set $s (f64.const 1.0))
    ;; subnormal |x| < 2^-1022: scale up by 2^60 so the exponent split is valid; cbrt(2^60) = 2^20.
    (if (f64.lt (local.get $a) (f64.const 2.2250738585072014e-308))
      (then (local.set $a (f64.mul (local.get $a) (f64.const 1152921504606846976.0)))
            (local.set $s (f64.const 9.5367431640625e-07))))
    (local.set $t (f64.reinterpret_i64
      (i64.add (i64.div_u (i64.reinterpret_f64 (local.get $a)) (i64.const 3)) (i64.const 0x2A9F7893BF800000))))
    (local.set $t (f64.mul (f64.add (f64.add (local.get $t) (local.get $t)) (f64.div (local.get $a) (f64.mul (local.get $t) (local.get $t)))) (f64.const 0.3333333333333333)))
    (local.set $t (f64.mul (f64.add (f64.add (local.get $t) (local.get $t)) (f64.div (local.get $a) (f64.mul (local.get $t) (local.get $t)))) (f64.const 0.3333333333333333)))
    (local.set $t (f64.mul (f64.add (f64.add (local.get $t) (local.get $t)) (f64.div (local.get $a) (f64.mul (local.get $t) (local.get $t)))) (f64.const 0.3333333333333333)))
    (local.set $t (f64.mul (local.get $t) (local.get $s)))
    (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $t))) (else (local.get $t))))`)

  // Fifth root of v ≥ 0 — same bit-hack seed (÷5 of the raw bits) + 3 Newton steps t=(4t+v/t⁴)/5.
  // Caller (constant-exponent pow with denominator 5, e.g. the sRGB 2.4 gamma) guarantees v ≥ 0.
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
    (f64.mul (local.get $t) (local.get $s)))`)

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
