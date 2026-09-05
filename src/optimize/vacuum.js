/**
 * Vacuum, on the tape: what computes nothing goes. A `nop` leaves its
 * scope; `drop V` keeps V's effects alone (a pure V vanishes, a pure op
 * over a `local.tee` collapses to the store, the post-increment's dead
 * old-value arithmetic); `select x x c` with pure x and c is x; an `if`
 * with empty arms is its condition's effect, an empty `else` goes, an
 * empty `then` before an `else` flips the condition (void `if`s alone).
 *
 * @module optimize/vacuum
 */
import { T, NONE, node, remove, replace, push, intern } from '../ir/tape.js'
import { FX, fxOf, ops, pure, same, bodyOf } from './fn.js'

export function vacuum(f) {
  const O = ops(), body = bodyOf(f)
  if (body === NONE) return
  const NOP = intern('nop'), DROP = intern('drop')
  const detach = (id) => { T.next[id] = NONE; return id }
  const only = (n) => T.a[n] !== NONE && T.next[T.a[n]] === NONE ? T.a[n] : NONE
  const count = (n) => { let k = 0; for (let c = T.a[n]; c !== NONE; c = T.next[c]) k++; return k }
  const isScope = (op) => op === O.FUNC || op === O.BLOCK || op === O.LOOP || op === O.THEN || op === O.ELSE
  // The statements that keep `v`'s effects once its value is discarded: a pure value
  // contributes nothing, an eager value op its operands' effects, a `local.tee` its
  // store; a call, a store or a structured form stays under a `drop`.
  const eager = (n) => { const fx = fxOf(n); return fx === FX.PURE || fx === FX.GET || fx === FX.GLOBAL_GET || fx === FX.LOAD }
  const dropEffects = (v, out) => {
    if (T.op[v] < 0 || pure(v)) return out
    if (T.op[v] === O.LOCAL_TEE && count(v) === 2) { const set = node(O.LOCAL_SET); T.a[set] = T.a[v]; out.push(set); return out }
    if (eager(v)) { for (let c = T.a[v], next; c !== NONE; c = next) { next = T.next[c]; dropEffects(c, out) } return out }
    const d = node(DROP); push(d, detach(v)); out.push(d); return out
  }
  // The replacement of `n`, or NONE; `[]` (an empty list) means "delete".
  const rewritten = (n) => {
    const op = T.op[n]
    if (op === NOP) return []
    if (op === DROP && only(n) !== NONE) {
      const eff = dropEffects(only(n), [])
      if (eff.length === 0) return []
      if (eff.length === 1) return eff[0]
      const b = node(O.BLOCK); for (const e of eff) push(b, detach(e)); return b
    }
    if (op === O.SELECT && count(n) === 3) {
      const a = T.a[n], b = T.next[a], c = T.next[b]
      if (same(a, b) && pure(a) && pure(c)) return detach(a)
    }
    if (op === O.IF) {
      let cond = NONE, thn = NONE, els = NONE, res = NONE
      for (let c = T.a[n]; c !== NONE; c = T.next[c]) { if (T.op[c] === O.RESULT) res = c; else if (T.op[c] === O.THEN) thn = c; else if (T.op[c] === O.ELSE) els = c; else cond = c }
      if (cond === NONE) return NONE
      const thenEmpty = thn === NONE || T.a[thn] === NONE, elseEmpty = els === NONE || T.a[els] === NONE
      if (thenEmpty && elseEmpty) { if (pure(cond)) return []; const d = node(DROP); push(d, detach(cond)); return d }
      if (els !== NONE && elseEmpty && !thenEmpty) { remove(n, els); return NONE }
      if (thenEmpty && thn !== NONE && els !== NONE && !elseEmpty && res === NONE) {
        const eqz = node(O.I32_EQZ); push(eqz, detach(cond))
        const out = node(O.IF); push(out, eqz)
        const t = node(O.THEN); T.a[t] = T.a[els]; push(out, t)
        return out
      }
    }
    return NONE
  }
  const visit = (n) => {
    for (let c = T.a[n], prev = NONE; c !== NONE;) {
      const next = T.next[c]
      if (T.op[c] >= 0) visit(c)
      const r = T.op[c] >= 0 ? rewritten(c) : NONE
      if (Array.isArray(r)) {   // delete: a nop, or a statement without effect
        if (isScope(T.op[n])) { remove(n, c); c = next; continue }
        const nop = node(NOP); replace(n, c, nop); prev = nop; c = next; continue
      }
      if (r !== NONE) { replace(n, c, r); prev = r } else prev = c
      c = next
    }
  }
  visit(f)
}
