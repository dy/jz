/**
 * Short-circuit conditions as branch chains, on the tape.
 *
 * `&&` / `||` emit as VALUE diamonds so they can stand in any expression:
 *   (if (result i32) (local.tee $t A) (then B) (else (local.get $t)))     ;; A && B
 *   (if (result i32) (local.tee $t A) (then (local.get $t)) (else B))     ;; A || B
 * In a CONDITION position (the test of a void `if`, a `br_if`) the diamond
 * materializes the boolean through a phi and branches on it again: two
 * branches and a register move per operand. C compilers lower the same test
 * as one conditional branch per operand (jump-if-false into a block); the
 * scan loop of the trace bench spent 40% of its time in the diamonds.
 *
 * Every void `if`, `br_if` and value `if` whose condition holds a diamond
 * (under the `X != 0` truthiness wrapper simplifyBoolContexts strips later)
 * takes the jump form instead:
 *   (if C (then T) (else E))  →  (block $e (block $x jf(C, $x) T (br $e)) E)
 *   (if C (then T))           →  (block $x jf(C, $x) T)
 *   (br_if $L C)              →  jt(C, $L)      (br_if $L (i32.eqz C)) → jf(C, $L)
 *   (if (result R) C (then A) (else B))  →  (block $e (result R) (block $x jf(C, $x) (br $e A)) B)
 * with the classic recursive jump-if-false / jump-if-true generators over
 * the AND/OR tree; every operand is evaluated at most once and only when the
 * short-circuit reaches it, exactly as the diamond did. The tee'd temp goes
 * when the diamond was its only reader and writer.
 *
 * @module optimize/cond-chains
 */
import { T, NONE, OP_STR, node, str, sym, push, remove, replace, insertAfter } from '../ir/tape.js'
import { ops, bodyOf, stmtsOf, tallies, dropLocals, i32Const } from './fn.js'

export function chainConditions(f) {
  const O = ops(), body = bodyOf(f)
  if (body === NONE) return
  const I32 = T.symId.get('i32')
  const isGet = (n, t) => T.op[n] === O.LOCAL_GET && T.sym[T.a[n]] === t
  const only = (n) => T.a[n] !== NONE && T.next[T.a[n]] === NONE ? T.a[n] : NONE   // the sole child
  const children = (n) => { const out = []; for (let c = T.a[n]; c !== NONE; c = T.next[c]) out.push(c); return out }
  const arms = (s) => { let thn = NONE, els = NONE; for (let c = T.a[s]; c !== NONE; c = T.next[c]) { if (T.op[c] === O.THEN) thn = c; else if (T.op[c] === O.ELSE) els = c } return { thn, els } }
  /** AND/OR diamond → { kind, t, a, b } or null. */
  const diamond = (n) => {
    if (n === NONE || T.op[n] !== O.IF) return null
    const res = T.a[n], cond = res === NONE ? NONE : T.next[res], thn = cond === NONE ? NONE : T.next[cond], els = thn === NONE ? NONE : T.next[thn]
    if (els === NONE || T.next[els] !== NONE) return null
    if (T.op[res] !== O.RESULT || only(res) === NONE || T.sym[only(res)] !== I32) return null
    if (T.op[cond] !== O.LOCAL_TEE || T.a[cond] === NONE || T.op[T.a[cond]] !== OP_STR) return null
    const t = T.sym[T.a[cond]], a = T.next[T.a[cond]]
    if (a === NONE || T.next[a] !== NONE) return null
    if (T.op[thn] !== O.THEN || T.op[els] !== O.ELSE) return null
    const tv = only(thn), ev = only(els)
    if (tv === NONE || ev === NONE) return null
    if (isGet(ev, t)) return { kind: 'and', t, a, b: tv }
    if (isGet(tv, t)) return { kind: 'or', t, a, b: ev }
    return null
  }
  const isEqz = (c) => c !== NONE && T.op[c] === O.I32_EQZ && only(c) !== NONE
  // `X != 0` is X in a boolean context (the truthiness canonicalization simplifyBoolContexts strips later)
  const bool = (c) => {
    for (;;) {
      if (c === NONE || T.op[c] !== O.I32_NE) return c
      const x = T.a[c], y = x === NONE ? NONE : T.next[x]
      if (y === NONE || T.next[y] !== NONE) return c
      if (i32Const(y) === 0) c = x; else if (i32Const(x) === 0) c = y; else return c
    }
  }
  const hasDiamond = (c0) => { const c = bool(c0); return !!diamond(c) || (isEqz(c) && hasDiamond(only(c))) }
  // reads and writes per local: a diamond's temp goes only when the diamond is its sole user
  const { sets, gets, tees } = tallies(body, true)
  const dropped = new Set()
  let uid = 0
  const fresh = () => `$__cc${uid++}`
  const detach = (id) => { T.next[id] = NONE; return id }
  const mk = (op, ...kids) => { const n = node(op); for (const k of kids) push(n, detach(k)); return n }
  const eqz = (c) => mk(O.I32_EQZ, c)
  const brIf = (L, c) => mk(O.BR_IF, str(L), c)
  const result = (ty) => { const r = node(O.RESULT); push(r, sym(ty)); return r }
  // A diamond's left operand as a plain condition; the tee stays when the temp has other users.
  const left = (d) => {
    if ((gets.get(d.t) || 0) <= 1 && (sets.get(d.t) || 0) + (tees.get(d.t) || 0) <= 1) { dropped.add(d.t); return d.a }
    return mk(O.LOCAL_TEE, sym(d.t), d.a)
  }
  // jump to F when c is false; fall through when true
  const jf = (c0, F, out) => {
    const c = bool(c0), d = diamond(c)
    if (d && d.kind === 'and') { jf(left(d), F, out); jf(d.b, F, out); return }
    if (d && d.kind === 'or') {
      const L = fresh(), inner = []
      jt(left(d), L, inner); jf(d.b, F, inner)
      out.push(mk(O.BLOCK, str(L), ...inner)); return
    }
    if (isEqz(c) && hasDiamond(only(c))) { jt(only(c), F, out); return }
    out.push(brIf(F, isEqz(c) ? only(c) : eqz(c)))
  }
  // jump to L when c is true; fall through when false
  const jt = (c0, L, out) => {
    const c = bool(c0), d = diamond(c)
    if (d && d.kind === 'or') { jt(left(d), L, out); jt(d.b, L, out); return }
    if (d && d.kind === 'and') {
      const F = fresh(), inner = []
      jf(left(d), F, inner); jf(d.b, F, inner); inner.push(mk(O.BR, str(L)))
      out.push(mk(O.BLOCK, str(F), ...inner)); return
    }
    if (isEqz(c) && hasDiamond(only(c))) { jf(only(c), L, out); return }
    out.push(brIf(L, c))
  }
  // A VALUE if whose test holds a diamond, anywhere in an expression: the then arm becomes the
  // branch value and the else arm the fallthrough of a result block. Returns the replacement or NONE.
  const valueIf = (s) => {
    if (T.op[s] !== O.IF) return NONE
    const res = T.a[s]
    if (res === NONE || T.op[res] !== O.RESULT || only(res) === NONE) return NONE
    const cond = T.next[res]
    if (cond === NONE || !hasDiamond(cond)) return NONE
    const { thn, els } = arms(s)
    if (thn === NONE || els === NONE || T.a[thn] === NONE || T.a[els] === NONE) return NONE
    const ty = T.sym[only(res)]
    const val = (arm) => { const kids = children(arm); return kids.length === 1 ? kids[0] : mk(O.BLOCK, result(ty), ...kids) }
    const x = fresh(), end = fresh(), inner = []
    jf(cond, x, inner)
    return mk(O.BLOCK, str(end), result(ty), mk(O.BLOCK, str(x), ...inner, mk(O.BR, str(end), val(thn))), val(els))
  }
  const rewriteExpr = (n) => {
    for (let c = T.a[n]; c !== NONE; c = T.next[c]) {
      if (T.op[c] < 0) continue
      const r = valueIf(c)
      if (r !== NONE) { replace(n, c, r); c = r }
      rewriteExpr(c)
    }
  }
  const rewriteList = (parent, first) => {
    for (let s = first, next; s !== NONE; s = next) {
      next = T.next[s]
      if (T.op[s] < 0) continue
      const op = T.op[s]
      const r = valueIf(s)
      if (r !== NONE) { replace(parent, s, r); rewriteExpr(r); continue }
      const c1 = T.a[s]
      if (op === O.IF && c1 !== NONE && T.op[c1] !== O.RESULT && hasDiamond(c1)) {
        const { thn, els } = arms(s)
        if (thn !== NONE) rewriteList(thn, T.a[thn])
        if (els !== NONE) rewriteList(els, T.a[els])
        const x = fresh(), inner = []
        jf(c1, x, inner)
        const Ts = thn === NONE ? [] : children(thn), Es = els === NONE ? [] : children(els)
        let out
        if (Es.length) { const end = fresh(); inner.push(...Ts, mk(O.BR, str(end))); out = mk(O.BLOCK, str(end), mk(O.BLOCK, str(x), ...inner), ...Es) }
        else { inner.push(...Ts); out = mk(O.BLOCK, str(x), ...inner) }
        replace(parent, s, out)
        continue
      }
      if (op === O.BR_IF && c1 !== NONE && T.next[c1] !== NONE && T.next[T.next[c1]] === NONE && hasDiamond(T.next[c1])) {
        const out = []
        jt(T.next[c1], T.syms[T.sym[c1]], out)
        let prev = s
        for (const o of out) { insertAfter(parent, prev, o); prev = o }
        remove(parent, s)
        continue
      }
      if (op === O.BLOCK || op === O.LOOP) rewriteList(s, stmtsOf(s))
      else if (op === O.IF) {
        const cond = c1 !== NONE && T.op[c1] === O.RESULT ? T.next[c1] : c1
        if (cond !== NONE && T.op[cond] >= 0) { const r = valueIf(cond); if (r !== NONE) { replace(s, cond, r); rewriteExpr(r) } else rewriteExpr(cond) }
        for (const c of children(s)) if (T.op[c] === O.THEN || T.op[c] === O.ELSE) rewriteList(c, T.a[c])
      } else rewriteExpr(s)
    }
  }
  rewriteList(f, body)
  if (dropped.size) dropLocals(f, dropped)
}
