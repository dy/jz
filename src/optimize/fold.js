/**
 * Constant folding on the tape: an instruction whose value is known from
 * its operands becomes that value, and a `select` on a constant condition
 * becomes the arm taken, when the operand it drops has no effect. What the
 * fold knows today: a finite value (`f64.convert_i32_s`, a finite constant,
 * a local every definition of which is finite) compared against a NaN or
 * an infinity (`f64.ne` is 1, `f64.eq` 0: the guard jz's integer arithmetic
 * carries on a value it converted itself, `select(v, 0, ne(x, inf))`, is
 * `v`), a comparison of two `f64` constants (a test of an argument a spliced
 * call was passed as a literal: `floor(3) === 3`), `i32.and` and `i32.or`
 * with a constant that decides or passes the other operand, `i32.eqz` of a
 * constant, `select` on a constant.
 *
 * @module optimize/fold
 */
import { T, NONE, OP_NUM, OP_STR, node, num, replace, intern } from '../ir/tape.js'
import { FX, fxOf, nameOf, bodyOf, ops, i32Const } from './fn.js'

/** Whether evaluating the subtree at `id` has no effect and cannot trap: reads of locals and globals, arithmetic. */
const inert = (id) => {
  const stack = [id]
  while (stack.length) {
    const n = stack.pop(), fx = fxOf(n)
    if (fx !== FX.PURE && fx !== FX.GET && fx !== FX.GLOBAL_GET) return false
    for (let c = T.a[n]; c !== NONE; c = T.next[c]) stack.push(c)
  }
  return true
}
/** The value of an `f64.const` at `id`, or null. */
const f64Const = (id, F64_CONST) => {
  if (T.op[id] !== F64_CONST) return null
  const v = T.a[id]
  if (v === NONE) return null
  if (T.op[v] === OP_NUM) return T.imm[v]
  if (T.op[v] === OP_STR) { const s = T.syms[T.sym[v]]; return s.startsWith('nan') ? NaN : s === 'inf' ? Infinity : s === '-inf' ? -Infinity : Number(s) }
  return null
}

export function fold(f) {
  const O = ops(), body = bodyOf(f)
  if (body === NONE) return
  const F64_CONST = intern('f64.const'), F64_NE = intern('f64.ne'), F64_EQ = intern('f64.eq'), CONV_S = intern('f64.convert_i32_s'), CONV_U = intern('f64.convert_i32_u')
  const F64_LT = intern('f64.lt'), F64_GT = intern('f64.gt'), F64_LE = intern('f64.le'), F64_GE = intern('f64.ge'), I32_AND = intern('i32.and'), I32_OR = intern('i32.or')
  // an instruction whose value is 0 or 1
  const TRUTH = new Set([F64_NE, F64_EQ, F64_LT, F64_GT, F64_LE, F64_GE, O.I32_EQZ, O.I32_NE, ...['i32.eq', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u', 'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u', 'i64.eq', 'i64.ne', 'i64.eqz'].map(intern)])
  // the atom first: a store evaluates its array ahead of its value, and a node may grow the tape to a new one
  const i32 = (k) => { const v = num(k), n = node(O.I32_CONST); T.a[n] = v; return n }
  const second = (n) => T.a[n] === NONE ? NONE : T.next[T.a[n]]
  const third = (n) => second(n) === NONE ? NONE : T.next[second(n)]
  // A finite f64: a converted i32, a finite constant, or a local every definition of
  // which is finite (a parameter's value is the caller's; a local never defined reads 0).
  const finiteLocals = new Map()   // symbol → true when every set or tee is finite
  const finite = (id) => {
    const op = T.op[id]
    if (op === CONV_S || op === CONV_U) return true
    if (op === F64_CONST) return Number.isFinite(f64Const(id, F64_CONST))
    return op === O.LOCAL_GET && finiteLocals.get(nameOf(id)) === true
  }
  const params = new Set()
  for (let c = T.next[T.a[f]]; c !== NONE; c = T.next[c]) if (T.op[c] === O.PARAM && T.a[c] !== NONE && T.op[T.a[c]] === OP_STR) params.add(T.sym[T.a[c]])
  for (let round = 0; round < 2; round++) {   // a local defined from another finite local settles in the second round
    const stack = [body]
    for (let s = T.next[body]; s !== NONE; s = T.next[s]) stack.push(s)
    while (stack.length) {
      const n = stack.pop(), fx = fxOf(n)
      if (fx === FX.SET || fx === FX.TEE) {
        const name = nameOf(n), v = second(n)
        const ok = v !== NONE && T.next[v] === NONE && finite(v) && !params.has(name)
        finiteLocals.set(name, ok && finiteLocals.get(name) !== false)
      }
      for (let c = T.a[n]; c !== NONE; c = T.next[c]) stack.push(c)
    }
  }
  // The folded form of `n`, or NONE.
  const folded = (n) => {
    const op = T.op[n]
    if (op === F64_NE || op === F64_EQ || op === F64_LT || op === F64_GT || op === F64_LE || op === F64_GE) {
      const a = T.a[n], b = second(n)
      if (b === NONE || T.next[b] !== NONE) return NONE
      const ka = f64Const(a, F64_CONST), kb = f64Const(b, F64_CONST)
      // two constants: a NaN of any payload compares as a NaN does
      if (ka !== null && kb !== null)
        return i32(+(op === F64_EQ ? ka === kb : op === F64_NE ? ka !== kb : op === F64_LT ? ka < kb : op === F64_GT ? ka > kb : op === F64_LE ? ka <= kb : ka >= kb))
      if (op !== F64_NE && op !== F64_EQ) return NONE
      const decided = (ka !== null && !Number.isFinite(ka) && finite(b) && inert(b)) || (kb !== null && !Number.isFinite(kb) && finite(a) && inert(a))
      return decided ? i32(op === F64_NE ? 1 : 0) : NONE
    }
    if (op === I32_AND || op === I32_OR) {
      const a = T.a[n], b = second(n)
      if (b === NONE || T.next[b] !== NONE) return NONE
      const ka = i32Const(a), kb = i32Const(b)
      if (ka !== null && kb !== null) return i32(op === I32_AND ? ka & kb : ka | kb)
      const k = kb !== null ? kb : ka, x = kb !== null ? a : b
      if (k === null) return NONE
      // the constant decides: `x & 0`, `x | -1`, where `x` runs nothing
      if (k === (op === I32_AND ? 0 : -1)) return inert(x) ? i32(k) : NONE
      // the constant passes `x`: `x & -1`, `x | 0`, and `x & 1` over a truth value
      if (k === (op === I32_AND ? -1 : 0) || (op === I32_AND && k === 1 && TRUTH.has(T.op[x]))) { T.next[x] = NONE; return x }
      return NONE
    }
    if (op === O.I32_EQZ) { const k = i32Const(T.a[n]); return k === null || T.next[T.a[n]] !== NONE ? NONE : i32(k === 0 ? 1 : 0) }
    if (op === O.SELECT) {
      const a = T.a[n], b = second(n), c = third(n)
      if (c === NONE || T.next[c] !== NONE) return NONE
      const k = i32Const(c)
      if (k === null) return NONE
      const keep = k !== 0 ? a : b, drop = k !== 0 ? b : a
      if (!inert(drop)) return NONE
      T.next[keep] = NONE
      return keep
    }
    return NONE
  }
  const visit = (n) => {
    for (let c = T.a[n]; c !== NONE; c = T.next[c]) {
      if (T.op[c] < 0) continue
      visit(c)
      const r = folded(c)
      if (r !== NONE) { replace(n, c, r); c = r }
    }
  }
  visit(f)
}
