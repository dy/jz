/**
 * Math module - Math.sin, Math.cos, Math.sqrt, Math.PI, etc.
 *
 * Module API:
 * - regEmit('math.X', deps, args => WasmNode) — emit handler + declarative stdlib deps
 * - ctx.core.stdlib['math.X'] = '(func ...)' - WAT function definitions
 * - watDeps({ 'math.X': ['dep'] }) - WAT stdlib→stdlib edges (expanded transitively)
 *
 * Prepare resolves Math.sin(x) → ['()', 'math.sin', x]
 * Compile looks up ctx.core.emit['math.sin'] and calls it.
 *
 * @module math
 */

import { typed, asF64, asI32, toI32, toNumF64, temp, arrayLoop, isLit, litVal, isPureIR } from '../src/ir.js'
import { emit, emitter, regEmit, watDeps, dualCall, attachDeps } from '../src/stdlib-emit.js'
import { repOf } from '../src/reps.js'

export default (ctx) => {
  watDeps({
    'math.sin': ['math.sin_core'],
    'math.cos': ['math.cos_core'],
    'math.sin_core': ['math.isFinite'],
    'math.cos_core': ['math.isFinite'],
    'math.tan': ['math.sin', 'math.cos'],
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
  const call = (name, ...args) => typed(['call', `$${name}`, ...args.map(a => toNumF64(a, emit(a)))], 'f64')

  // Canonicalize a possibly-NaN f64 result. A wasm arithmetic op that mints a
  // fresh NaN (f64.sqrt of a negative, f64.min/max with a NaN operand) leaves
  // the sign bit nondeterministic — x86 yields the negative NaN 0xFFF8.., ARM
  // the positive 0x7FF8... jz's carrier reserves 0x7FF8.. as THE number-NaN;
  // a negative-NaN number is bit-identical to a negative BigInt and corrupts
  // untyped === / typeof. So fold any NaN back to canonical where one is born.
  const canon = (node) => {
    const t = temp('cn')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, node],
      ['select',
        ['f64.const', 'nan'],
        ['local.get', `$${t}`],
        ['f64.ne', ['local.get', `$${t}`], ['local.get', `$${t}`]]]], 'f64')
  }

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
  ctx.core.emit['math.sqrt'] = a => canon(f('f64.sqrt', a))
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
  regEmit('math.sign', ['math.sign'], a => call('math.sign', a))

  // Trig — isSinCoreFastPath skips the $math.sin/$math.cos wrapper call.
  ctx.core.emit['math.sin'] = dualCall(
    emitter(['math.sin'], a => call('math.sin', a)),
    emitter(['math.sin_core', 'math.isFinite'], a => call('math.sin_core', a)),
    isSinCoreFastPath)
  ctx.core.emit['math.cos'] = dualCall(
    emitter(['math.cos'], a => call('math.cos', a)),
    emitter(['math.cos_core', 'math.isFinite'], a => call('math.cos_core', a)),
    isSinCoreFastPath)
  regEmit('math.tan', ['math.tan'], a => call('math.tan', a))

  // Inverse trig
  regEmit('math.asin', ['math.asin'], a => call('math.asin', a))
  regEmit('math.acos', ['math.acos'], a => call('math.acos', a))
  regEmit('math.atan', ['math.atan'], a => call('math.atan', a))
  regEmit('math.atan2', ['math.atan2'], (a, b) => call('math.atan2', a, b))

  // Hyperbolic
  regEmit('math.sinh', ['math.sinh'], a => call('math.sinh', a))
  regEmit('math.cosh', ['math.cosh'], a => call('math.cosh', a))
  regEmit('math.tanh', ['math.tanh'], a => call('math.tanh', a))

  // Inverse hyperbolic
  regEmit('math.asinh', ['math.asinh'], a => call('math.asinh', a))
  regEmit('math.acosh', ['math.acosh'], a => call('math.acosh', a))
  regEmit('math.atanh', ['math.atanh'], a => call('math.atanh', a))

  // Exponential and logarithmic
  regEmit('math.exp', ['math.exp'], a => call('math.exp', a))
  regEmit('math.expm1', ['math.expm1'], a => call('math.expm1', a))
  regEmit('math.log', ['math.log'], a => call('math.log', a))
  regEmit('math.log2', ['math.log2'], a => call('math.log2', a))
  regEmit('math.log10', ['math.log10'], a => call('math.log10', a))
  regEmit('math.log1p', ['math.log1p'], a => call('math.log1p', a))

  // Power. Constant-integer-exponent `Math.pow(x,n)` / `x ** n` (|n| ≤ POW_FOLD_MAX)
  // lower to inline square-and-multiply instead of a $math.pow call. The fold is
  // bit-identical to $math.pow's integer fast path: that path runs the same LSB-first
  // square-and-multiply, and an f64 product's magnitude is the rounded product of the
  // operand magnitudes regardless of sign — so multiplying the *signed* base reproduces
  // both the exact bits and the result sign (negative iff x<0 ∧ n odd, which is exactly
  // its `neg_base`). A program whose only pow use is folded then never pulls the
  // math.pow/exp/log stdlib. `**`'s exponent is parsed as a bare number (incl. negatives).
  const POW_FOLD_MAX = 8
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
  const powCall = emitter(['math.pow'], (a, b) => call('math.pow', a, b))
  const expPosPow = (base, exp) =>
    typed(['call', '$math.exp', ['f64.mul', toNumF64(exp, emit(exp)), ['f64.const', Math.log(base)]]], 'f64')
  const expPowCall = emitter(['math.exp'], (base, exp) => expPosPow(base, exp))
  // Shared pow/** lowering. `expPosPow` is only for `**`: it is bit-identical to
  // $math.pow for fractional exponents (e.g. 2**(n/12)) but not for integer
  // Math.pow — exp(log(b)*y) loses ulps and misses overflow (test262 S8.5).
  const emitPow = (a, b, allowExpPos) => {
    const n = constInt(b)
    if (n !== null && Math.abs(n) <= POW_FOLD_MAX) return foldPow(a, n)
    if (constNum(b) === 0.5) return canon(typed(['f64.sqrt', toNumF64(a, emit(a))], 'f64'))
    if (allowExpPos) {
      const cb = constNum(a)
      // Integer literal exponents keep $math.pow (exact bits + overflow semantics).
      if (cb != null && cb > 0 && Number.isFinite(cb) && n === null) return expPowCall(cb, b)
    }
    return powCall(a, b)
  }
  ctx.core.emit['math.pow'] = attachDeps((a, b) => emitPow(a, b, false), powCall.deps)
  ctx.core.emit['**'] = attachDeps((a, b) => emitPow(a, b, true), powCall.deps)
  regEmit('math.cbrt', ['math.cbrt'], a => call('math.cbrt', a))
  regEmit('math.hypot', ['math.hypot'], (a, b, ...rest) => {
    if (a === undefined) return typed(['f64.const', 0], 'f64')
    if (b === undefined) return f('f64.abs', a)
    let r = call('math.hypot', a, b)
    // ToNumber every rest arg too (matches min/max) — an object arg's valueOf
    // must run and may throw, which Math.hypot propagates.
    for (const x of rest) r = typed(['call', '$math.hypot', r, toNumF64(x, emit(x))], 'f64')
    return r
  })

  // Math.sumPrecise(iterable) — exact, correctly-rounded summation (ECMA-262).
  // jz models the array case; the WAT routine sums via a fixed-point accumulator.
  regEmit('math.sumPrecise', ['math.sumPrecise'], arr =>
    typed(['call', '$math.sumPrecise', ['i64.reinterpret_f64', asF64(emit(arr))]], 'f64'))

  // Integer/bit operations: return i32 directly. Consumers `asF64`-rebox at
  // store/return boundaries; consumers staying in i32 (bit chains, i32 locals)
  // skip the convert/trunc round-trip entirely.
  // Operands take ECMAScript ToInt32 (wrapping), not saturation — `Math.imul(x, k)`
  // with a literal k ≥ 2³¹ must wrap to negative, matching JS, not clamp to INT_MAX.
  ctx.core.emit['math.clz32'] = a => typed(['i32.clz', toI32(emit(a))], 'i32')
  ctx.core.emit['math.imul'] = (a, b) => typed(['i32.mul', toI32(emit(a)), toI32(emit(b))], 'i32')

  // Random
  regEmit('math.random', ['math.random'], () => typed(['call', '$math.random'], 'f64'))

  // ============================================
  // WAT stdlib implementations
  // ============================================

  ctx.core.stdlib['math.sign'] = `(func $math.sign (param $x f64) (result f64)
    ;; sign(NaN) = NaN, sign(±0) = ±0 — both pass x through unchanged.
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (if (result f64) (f64.gt (local.get $x) (f64.const 0.0))
      (then (f64.const 1.0))
      (else (f64.const -1.0))))`

  ctx.core.stdlib['math.sin_core'] = `(func $math.sin_core (param $x f64) (result f64)
    (local $n i32) (local $r f64) (local $x2 f64) (local $sign f64)
    (if (i32.eqz (call $math.isFinite (local.get $x))) (then (return (f64.const nan))))
    (local.set $sign (f64.const 1.0))
    (local.set $n (i32.trunc_f64_s (f64.floor (f64.div (local.get $x) (f64.const ${Math.PI})))))
    (local.set $r (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $n)) (f64.const ${Math.PI}))))
    (if (i32.and (local.get $n) (i32.const 1)) (then (local.set $sign (f64.const -1.0))))
    (if (f64.gt (local.get $r) (f64.const ${Math.PI / 2})) (then (local.set $r (f64.sub (f64.const ${Math.PI}) (local.get $r)))))
    (if (f64.lt (local.get $r) (f64.const 0.0)) (then
      (local.set $r (f64.neg (local.get $r)))
      (local.set $sign (f64.neg (local.get $sign)))))
    (local.set $x2 (f64.mul (local.get $r) (local.get $r)))
    (f64.mul (local.get $sign) (f64.mul (local.get $r) (f64.sub (f64.const 1.0) (f64.mul (local.get $x2)
      (f64.sub (f64.const 0.16666666666666666) (f64.mul (local.get $x2)
        (f64.sub (f64.const 0.008333333333333333) (f64.mul (local.get $x2)
          (f64.sub (f64.const 0.0001984126984126984) (f64.mul (local.get $x2)
            (f64.sub (f64.const 0.0000027557319223985893) (f64.mul (local.get $x2)
              (f64.const 2.505210838544172e-8))))))))))))))`

  ctx.core.stdlib['math.sin'] = `(func $math.sin (param $x f64) (result f64)
    (call $math.sin_core (local.get $x)))`

  ctx.core.stdlib['math.cos_core'] = `(func $math.cos_core (param $x f64) (result f64)
    (local $n i32) (local $r f64) (local $x2 f64) (local $sign f64)
    (if (i32.eqz (call $math.isFinite (local.get $x))) (then (return (f64.const nan))))
    (local.set $sign (f64.const 1.0))
    (local.set $n (i32.trunc_f64_s (f64.floor (f64.div (local.get $x) (f64.const ${Math.PI})))))
    (local.set $r (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $n)) (f64.const ${Math.PI}))))
    (if (i32.and (local.get $n) (i32.const 1)) (then (local.set $sign (f64.const -1.0))))
    (if (f64.gt (local.get $r) (f64.const ${Math.PI / 2})) (then
      (local.set $r (f64.sub (f64.const ${Math.PI}) (local.get $r)))
      (local.set $sign (f64.neg (local.get $sign)))))
    (if (f64.lt (local.get $r) (f64.const 0.0)) (then (local.set $r (f64.neg (local.get $r)))))
    (local.set $x2 (f64.mul (local.get $r) (local.get $r)))
    (f64.mul (local.get $sign) (f64.sub (f64.const 1.0) (f64.mul (local.get $x2)
      (f64.sub (f64.const 0.5) (f64.mul (local.get $x2)
        (f64.sub (f64.const 0.041666666666666664) (f64.mul (local.get $x2)
          (f64.sub (f64.const 0.001388888888888889) (f64.mul (local.get $x2)
            (f64.sub (f64.const 0.0000248015873015873) (f64.mul (local.get $x2)
              (f64.const 2.7557319223985893e-7)))))))))))))`

  ctx.core.stdlib['math.cos'] = `(func $math.cos (param $x f64) (result f64)
    (call $math.cos_core (local.get $x)))`

  ctx.core.stdlib['math.tan'] = `(func $math.tan (param $x f64) (result f64)
    (f64.div (call $math.sin (local.get $x)) (call $math.cos (local.get $x))))`

  ctx.core.stdlib['math.exp'] = `(func $math.exp (param $x f64) (result f64)
    (local $k i32) (local $t f64) (local $t2 f64) (local $result f64) (local $pow2 f64)
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    ;; +Infinity → +Infinity; finite overflow (x > 709) also rounds to +Infinity.
    (if (result f64) (f64.gt (local.get $x) (f64.const 709.0)) (then (f64.const inf)) (else
      (if (result f64) (f64.lt (local.get $x) (f64.const -745.0)) (then (f64.const 0.0)) (else
        (local.set $k (i32.trunc_f64_s (f64.div (local.get $x) (f64.const ${Math.LN2}))))
        (local.set $t (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $k)) (f64.const ${Math.LN2}))))
        (local.set $t2 (f64.mul (local.get $t) (local.get $t)))
        (local.set $result (f64.add (f64.const 1.0) (f64.add (local.get $t)
          (f64.mul (local.get $t2) (f64.add (f64.const 0.5)
            (f64.mul (local.get $t) (f64.add (f64.const 0.16666666666666666)
              (f64.mul (local.get $t) (f64.add (f64.const 0.041666666666666664)
                (f64.mul (local.get $t) (f64.add (f64.const 0.008333333333333333)
                  (f64.mul (local.get $t) (f64.const 0.001388888888888889)))))))))))))
        (local.set $pow2 (f64.const 1.0))
        (if (i32.gt_s (local.get $k) (i32.const 0))
          (then (block $done (loop $loop
            (br_if $done (i32.le_s (local.get $k) (i32.const 0)))
            (local.set $pow2 (f64.mul (local.get $pow2) (f64.const 2.0)))
            (local.set $k (i32.sub (local.get $k) (i32.const 1)))
            (br $loop)))
            (local.set $result (f64.mul (local.get $result) (local.get $pow2))))
          (else (if (i32.lt_s (local.get $k) (i32.const 0))
            (then (block $done2 (loop $loop2
              (br_if $done2 (i32.ge_s (local.get $k) (i32.const 0)))
              (local.set $pow2 (f64.mul (local.get $pow2) (f64.const 2.0)))
              (local.set $k (i32.add (local.get $k) (i32.const 1)))
              (br $loop2)))
              (local.set $result (f64.div (local.get $result) (local.get $pow2)))))))
        (local.get $result))))))`

  ctx.core.stdlib['math.expm1'] = `(func $math.expm1 (param $x f64) (result f64)
    ;; Preserve sign of zero: expm1(±0) = ±0.
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (f64.sub (call $math.exp (local.get $x)) (f64.const 1.0)))`

  // log(x) via bit-level frexp + sqrt(2)-centered split + atanh series.
  //   x = m * 2^k   with bits-extracted k (no loop)
  //   if m >= sqrt(2): m /= 2, k += 1     so m ∈ [sqrt(2)/2, sqrt(2)) ≈ [0.707, 1.414)
  //   s = (m-1)/(m+1)                     |s| ≤ 0.172
  //   log(x) = k·ln(2) + 2s·(1 + s²/3 + s⁴/5 + ... + s¹⁶/17)
  // With 9 polynomial terms and |s|≤0.172, truncation error ≈ 2|s|·z⁹/19 ≈ 4e-17,
  // close to f64 ulp. The whole routine is branchless after edge cases.
  // Edge cases: NaN→NaN, ≤0 distinguishes 0→-Inf, <0→NaN; +Inf passes through.
  ctx.core.stdlib['math.log'] = `(func $math.log (param $x f64) (result f64)
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
    (local.set $s (f64.div (f64.sub (local.get $m) (f64.const 1.0))
                           (f64.add (local.get $m) (f64.const 1.0))))
    (local.set $z (f64.mul (local.get $s) (local.get $s)))
    ;; Horner: 1 + z/3 + z²/5 + z³/7 + z⁴/9 + z⁵/11 + z⁶/13 + z⁷/15 + z⁸/17
    (f64.add
      (f64.mul (f64.convert_i32_s (local.get $k)) (f64.const ${Math.LN2}))
      (f64.mul (f64.const 2.0) (f64.mul (local.get $s) (f64.add (f64.const 1.0)
        (f64.mul (local.get $z) (f64.add (f64.const 0.3333333333333333)
          (f64.mul (local.get $z) (f64.add (f64.const 0.2)
            (f64.mul (local.get $z) (f64.add (f64.const 0.14285714285714285)
              (f64.mul (local.get $z) (f64.add (f64.const 0.1111111111111111)
                (f64.mul (local.get $z) (f64.add (f64.const 0.09090909090909091)
                  (f64.mul (local.get $z) (f64.add (f64.const 0.07692307692307693)
                    (f64.mul (local.get $z) (f64.add (f64.const 0.06666666666666667)
                      (f64.mul (local.get $z) (f64.const 0.058823529411764705)))))))))))))))))))))`

  ctx.core.stdlib['math.log2'] = `(func $math.log2 (param $x f64) (result f64)
    (f64.div (call $math.log (local.get $x)) (f64.const ${Math.LN2})))`

  // log10 via fdlibm's two-term decomposition: log10(x) = k*log10(2) + log10(m).
  // A plain log(x)/ln(10) double-rounds (rounding of log itself, then of the
  // divide), so exact powers of ten drift — log10(1000) lands on 2.9999…996.
  // Reducing x = m·2^k, splitting log10(2) and 1/ln(10) into hi/lo halves, and
  // keeping the bulk term (k·log10_2hi, hi·ivln10hi) carry-free recovers the
  // last ulps, so log10(10/100/1000/…) round-trips to exact integers.
  ctx.core.stdlib['math.log10'] = `(func $math.log10 (param $x f64) (result f64)
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
    (f64.add (local.get $vallo) (local.get $w)))`

  // log1p(x) via Kahan's compensated trick: with u = 1+x, log(u) loses bits when x is
  // small (because u rounds to ~1), but the ratio x/(u-1) is exactly the missing factor.
  // For u==1 (x below ulp), result is just x; preserves -0 from x=-0 path.
  ctx.core.stdlib['math.log1p'] = `(func $math.log1p (param $x f64) (result f64)
    (local $u f64)
    ;; log1p(+Inf) = +Inf — the ratio trick below would compute Inf/Inf = NaN.
    (if (f64.eq (local.get $x) (f64.const inf)) (then (return (f64.const inf))))
    (local.set $u (f64.add (f64.const 1.0) (local.get $x)))
    (if (f64.eq (local.get $u) (f64.const 1.0))
      (then (return (local.get $x))))
    (f64.div
      (f64.mul (call $math.log (local.get $u)) (local.get $x))
      (f64.sub (local.get $u) (f64.const 1.0))))`

  ctx.core.stdlib['math.pow'] = `(func $math.pow (param $x f64) (param $y f64) (result f64)
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
    (call $math.exp (f64.mul (local.get $y) (call $math.log (local.get $x)))))`

  // fdlibm atan: 4-region argument reduction onto |r| ≤ tan(π/16), then an
  // 11-term odd polynomial split into even/odd parts. Accurate to <1 ulp —
  // the old Taylor series was ~2e-6 off near |x|=0.5. Drives asin/acos/atan2.
  ctx.core.stdlib['math.atan'] = `(func $math.atan (param $x f64) (result f64)
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
    (f64.copysign (local.get $res) (local.get $x)))`

  ctx.core.stdlib['math.asin'] = `(func $math.asin (param $x f64) (result f64)
    ;; Domain is [-1, 1]; outside it (including ±Infinity), Math.asin returns NaN.
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 1.0))
      (then (f64.const nan))
      (else (call $math.atan (f64.div (local.get $x)
        (f64.sqrt (f64.sub (f64.const 1.0) (f64.mul (local.get $x) (local.get $x)))))))))`

  ctx.core.stdlib['math.acos'] = `(func $math.acos (param $x f64) (result f64)
    (f64.sub (f64.const ${Math.PI / 2}) (call $math.asin (local.get $x))))`

  ctx.core.stdlib['math.atan2'] = `(func $math.atan2 (param $y f64) (param $x f64) (result f64)
    ;; If either argument is NaN, the result is NaN (ECMA-262 21.3.2.5).
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (f64.ne (local.get $y) (local.get $y)) (then (return (local.get $y))))
    (if (result f64) (f64.eq (local.get $x) (f64.const 0.0)) (then
      ;; y is ±0 too: result is ±0 when x is +0, ±π when x is -0; sign taken from y.
      (if (result f64) (f64.eq (local.get $y) (f64.const 0.0))
        (then (f64.copysign
          (select (f64.const ${Math.PI}) (f64.const 0.0)
                  (f64.lt (f64.copysign (f64.const 1.0) (local.get $x)) (f64.const 0.0)))
          (local.get $y)))
        (else
          (if (result f64) (f64.gt (local.get $y) (f64.const 0.0)) (then (f64.const ${Math.PI / 2})) (else (f64.neg (f64.const ${Math.PI / 2})))))))
      (else (if (result f64) (f64.ge (local.get $x) (f64.const 0.0))
        (then (call $math.atan (f64.div (local.get $y) (local.get $x))))
        (else (if (result f64) (f64.ge (local.get $y) (f64.const 0.0))
          (then (f64.add (call $math.atan (f64.div (local.get $y) (local.get $x))) (f64.const ${Math.PI})))
          (else (f64.sub (call $math.atan (f64.div (local.get $y) (local.get $x))) (f64.const ${Math.PI})))))))))`

  ctx.core.stdlib['math.sinh'] = `(func $math.sinh (param $x f64) (result f64)
    (local $ex f64)
    ;; Preserve sign of zero: sinh(±0) = ±0 (the f64.lt sign test below is false for -0).
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (local.set $ex (call $math.exp (f64.abs (local.get $x))))
    (local.set $ex (f64.mul (f64.const 0.5) (f64.sub (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))
    (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $ex))) (else (local.get $ex))))`

  ctx.core.stdlib['math.cosh'] = `(func $math.cosh (param $x f64) (result f64)
    (local $ex f64) (local.set $ex (call $math.exp (f64.abs (local.get $x))))
    (f64.mul (f64.const 0.5) (f64.add (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))`

  ctx.core.stdlib['math.tanh'] = `(func $math.tanh (param $x f64) (result f64)
    (local $e2x f64)
    ;; Preserve sign of zero: tanh(±0) = ±0 (the f64.lt sign test below is false for -0).
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 22.0))
      (then (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.const -1.0)) (else (f64.const 1.0))))
      (else (local.set $e2x (call $math.exp (f64.mul (f64.const 2.0) (f64.abs (local.get $x)))))
        (local.set $e2x (f64.div (f64.sub (local.get $e2x) (f64.const 1.0)) (f64.add (local.get $e2x) (f64.const 1.0))))
        (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $e2x))) (else (local.get $e2x))))))`

  ctx.core.stdlib['math.asinh'] = `(func $math.asinh (param $x f64) (result f64)
    ;; ±Infinity and NaN pass through unchanged. (log(±Inf + sqrt(Inf²+1)) → NaN otherwise.)
    (if (i32.eqz (call $math.isFinite (local.get $x))) (then (return (local.get $x))))
    ;; Preserve sign of zero: asinh(±0) = ±0.
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    (call $math.log (f64.add (local.get $x) (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0))))))`

  ctx.core.stdlib['math.acosh'] = `(func $math.acosh (param $x f64) (result f64)
    (if (f64.eq (local.get $x) (f64.const inf)) (then (return (f64.const inf))))
    ;; acosh is defined only for x >= 1; everything below (incl. -Inf) is NaN.
    (if (result f64) (f64.lt (local.get $x) (f64.const 1.0)) (then (f64.const nan)) (else
      (call $math.log (f64.add (local.get $x) (f64.sqrt (f64.sub (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0))))))))`

  ctx.core.stdlib['math.atanh'] = `(func $math.atanh (param $x f64) (result f64)
    ;; Preserve sign of zero: atanh(±0) = ±0.
    (if (f64.eq (local.get $x) (f64.const 0.0)) (then (return (local.get $x))))
    ;; ±Infinity → NaN. Without this the (1+x)/(1-x) ratio is Inf/Inf, whose
    ;; sign-nondeterministic arithmetic NaN would escape non-canonical on x86.
    (if (f64.eq (f64.abs (local.get $x)) (f64.const inf)) (then (return (f64.const nan))))
    (f64.mul (f64.const 0.5) (call $math.log (f64.div (f64.add (f64.const 1.0) (local.get $x)) (f64.sub (f64.const 1.0) (local.get $x))))))`

  ctx.core.stdlib['math.cbrt'] = `(func $math.cbrt (param $x f64) (result f64)
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
        (local.get $y))))`

  // Small finite-test helper (NaN→0, ±Inf→0, finite→1). Used by transcendental
  // functions that need to short-circuit on infinite inputs.
  ctx.core.stdlib['math.isFinite'] = `(func $math.isFinite (param $x f64) (result i32)
    (i32.and
      (f64.eq (local.get $x) (local.get $x))
      (f64.lt (f64.abs (local.get $x)) (f64.const inf))))`

  ctx.core.stdlib['math.hypot'] = `(func $math.hypot (param $x f64) (param $y f64) (result f64)
    ;; Any ±Infinity argument ⇒ +Infinity, even when the other is NaN (ECMA-262 21.3.2.18).
    (if (f64.eq (f64.abs (local.get $x)) (f64.const inf)) (then (return (f64.const inf))))
    (if (f64.eq (f64.abs (local.get $y)) (f64.const inf)) (then (return (f64.const inf))))
    (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.mul (local.get $y) (local.get $y)))))`

  ctx.core.stdlib['math.random'] = `(func $math.random (result f64)
    (local $s i32)
    (local.set $s (global.get $math.rng_state))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 13))))
    (local.set $s (i32.xor (local.get $s) (i32.shr_u (local.get $s) (i32.const 17))))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 5))))
    (global.set $math.rng_state (local.get $s))
    (f64.div (f64.convert_i32_u (i32.and (local.get $s) (i32.const 0x7FFFFFFF))) (f64.const 2147483647.0)))`

  ctx.core.stdlib['math.sumPrecise'] = `(func $math.sumPrecise (param $arr i64) (result f64)
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
    (select (f64.neg (local.get $res)) (local.get $res) (local.get $resultNeg)))`

  // Global for random state
  ctx.scope.globals.set('math.rng_state', '(global $math.rng_state (mut i32) (i32.const 12345))')
}
