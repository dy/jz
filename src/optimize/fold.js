/**
 * Constant folding on the tape: an instruction whose value is known from
 * its operands becomes that value, and a `select` on a constant condition
 * becomes the arm taken, when the operand it drops has no effect. What the
 * fold knows today: a finite value (`f64.convert_i32_s`, a finite constant,
 * a local every definition of which is finite) compared against a NaN or
 * an infinity (`f64.ne` is 1, `f64.eq` 0: the guard jz's integer arithmetic
 * carries on a value it converted itself, `select(v, 0, ne(x, inf))`, is
 * `v`), `i32.eqz` of a constant, `select` on a constant.
 *
 * @module optimize/fold
 */
import { T, NONE, OP_NUM, OP_STR, node, num, replace } from '../ir/tape.js'
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
  const sym = (s) => T.symId.get(s) ?? -2
  const F64_CONST = sym('f64.const'), F64_NE = sym('f64.ne'), F64_EQ = sym('f64.eq'), CONV_S = sym('f64.convert_i32_s'), CONV_U = sym('f64.convert_i32_u')
  const i32 = (k) => { const n = node(O.I32_CONST); T.a[n] = num(k); return n }
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
    if (op === F64_NE || op === F64_EQ) {
      const a = T.a[n], b = second(n)
      if (b === NONE || T.next[b] !== NONE) return NONE
      const ka = f64Const(a, F64_CONST), kb = f64Const(b, F64_CONST)
      const decided = (ka !== null && !Number.isFinite(ka) && finite(b) && inert(b)) || (kb !== null && !Number.isFinite(kb) && finite(a) && inert(a))
      return decided ? i32(op === F64_NE ? 1 : 0) : NONE
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
