/**
 * Boolean-context canonicalization, on the tape. At a true zero/nonzero
 * position, a `br_if`, `if`, `i32.eqz` or `select` condition, these are
 * the inner value: `i32.ne(X, 0) → X`, `i32.ne(0, X) → X`,
 * `i32.eqz(i32.eqz(X)) → X`. jz emits the redundant compare from
 * `while (x !== 0)` and from rotateLoops' negation (which strips one `eqz`
 * and leaves the `i32.ne`). V8 happens to fold it; JSC and wasmtime need
 * not, so it goes for minimal output regardless of engine. Only at proven
 * boolean positions: a value-position `ne` or `eqz` produces a real 0/1.
 *
 * @module optimize/bool-contexts
 */
import { T, NONE, replace } from '../ir/tape.js'
import { ops, bodyOf, i32Const } from './fn.js'

export function simplifyBoolContexts(f) {
  const O = ops(), body = bodyOf(f)
  if (body === NONE) return
  const only = (n) => T.a[n] !== NONE && T.next[T.a[n]] === NONE ? T.a[n] : NONE
  const simp = (n) => {
    for (;;) {
      if (T.op[n] === O.I32_NE) {
        const x = T.a[n], y = x === NONE ? NONE : T.next[x]
        if (y !== NONE && T.next[y] === NONE) {
          if (i32Const(y) === 0) { n = x; continue }
          if (i32Const(x) === 0) { n = y; continue }
        }
      }
      if (T.op[n] === O.I32_EQZ && only(n) !== NONE && T.op[only(n)] === O.I32_EQZ && only(only(n)) !== NONE) { n = only(only(n)); continue }
      return n
    }
  }
  const at = (parent, c) => { if (c !== NONE) { const r = simp(c); if (r !== c) replace(parent, c, r) } }
  const visit = (n) => {
    for (let c = T.a[n]; c !== NONE; c = T.next[c]) if (T.op[c] >= 0) visit(c)
    const op = T.op[n], c1 = T.a[n]
    if (op === O.BR_IF) { if (c1 !== NONE && T.next[c1] !== NONE && T.next[T.next[c1]] === NONE) at(n, T.next[c1]) }
    else if (op === O.I32_EQZ) { if (only(n) !== NONE) at(n, c1) }
    else if (op === O.IF) { const c = c1 !== NONE && T.op[c1] === O.RESULT ? T.next[c1] : c1; if (c !== NONE && T.op[c] >= 0) at(n, c) }
    else if (op === O.SELECT) { const c2 = c1 === NONE ? NONE : T.next[c1], c3 = c2 === NONE ? NONE : T.next[c2]; if (c3 !== NONE && T.next[c3] === NONE && T.op[c3] >= 0) at(n, c3) }
  }
  for (let s = body; s !== NONE; s = T.next[s]) if (T.op[s] >= 0) visit(s)
}
