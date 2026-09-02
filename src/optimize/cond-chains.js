/**
 * Short-circuit conditions as branch chains.
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
import { findBodyStart } from '../ir.js'

let uid = 0

const isGet = (n, t) => Array.isArray(n) && n[0] === 'local.get' && n[1] === t

/** AND/OR diamond → { kind, t, a, b } or null. */
function diamond(n) {
  if (!Array.isArray(n) || n[0] !== 'if' || n.length !== 5) return null
  const [, res, cond, thn, els] = n
  if (!Array.isArray(res) || res[0] !== 'result' || res[1] !== 'i32') return null
  if (!Array.isArray(cond) || cond[0] !== 'local.tee' || typeof cond[1] !== 'string') return null
  const t = cond[1]
  if (!Array.isArray(thn) || thn[0] !== 'then' || thn.length !== 2 || !Array.isArray(els) || els[0] !== 'else' || els.length !== 2) return null
  if (isGet(els[1], t)) return { kind: 'and', t, a: cond[2], b: thn[1] }
  if (isGet(thn[1], t)) return { kind: 'or', t, a: cond[2], b: els[1] }
  return null
}

const isEqz = (c) => Array.isArray(c) && c[0] === 'i32.eqz' && c.length === 2
const isZero = (c) => Array.isArray(c) && c[0] === 'i32.const' && (c[1] === 0 || c[1] === '0')
// `X != 0` is X in a boolean context (the truthiness canonicalization
// simplifyBoolContexts strips later)
const bool = (c) => {
  while (Array.isArray(c) && c[0] === 'i32.ne' && c.length === 3 && (isZero(c[2]) || isZero(c[1]))) c = isZero(c[2]) ? c[1] : c[2]
  return c
}

const hasDiamond = (c0) => { const c = bool(c0); return !!diamond(c) || (isEqz(c) && hasDiamond(c[1])) }

export function chainConditions(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  // reads and writes per local: a diamond's temp goes only when the diamond is its sole user
  const reads = new Map(), writes = new Map()
  const tally = (n) => {
    if (!Array.isArray(n)) return
    if (typeof n[1] === 'string') {
      if (n[0] === 'local.get') reads.set(n[1], (reads.get(n[1]) || 0) + 1)
      else if (n[0] === 'local.set' || n[0] === 'local.tee') writes.set(n[1], (writes.get(n[1]) || 0) + 1)
    }
    for (let i = 1; i < n.length; i++) tally(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) tally(fn[i])
  const dropped = new Set()
  const fresh = () => `$__cc${uid++}`
  // A diamond's left operand as a plain condition; the tee stays when the temp has other users.
  const left = (d) => {
    if ((reads.get(d.t) || 0) <= 1 && (writes.get(d.t) || 0) <= 1) { dropped.add(d.t); return d.a }
    return ['local.tee', d.t, d.a]
  }
  // jump to F when c is false; fall through when true
  const jf = (c0, F, out) => {
    const c = bool(c0), d = diamond(c)
    if (d && d.kind === 'and') { jf(left(d), F, out); jf(d.b, F, out); return }
    if (d && d.kind === 'or') {
      const T = fresh(), inner = []
      jt(left(d), T, inner); jf(d.b, F, inner)
      out.push(['block', T, ...inner]); return
    }
    if (isEqz(c) && hasDiamond(c[1])) { jt(c[1], F, out); return }
    out.push(['br_if', F, isEqz(c) ? c[1] : ['i32.eqz', c]])
  }
  // jump to T when c is true; fall through when false
  const jt = (c0, T, out) => {
    const c = bool(c0), d = diamond(c)
    if (d && d.kind === 'or') { jt(left(d), T, out); jt(d.b, T, out); return }
    if (d && d.kind === 'and') {
      const F = fresh(), inner = []
      jf(left(d), F, inner); jf(d.b, F, inner); inner.push(['br', T])
      out.push(['block', F, ...inner]); return
    }
    if (isEqz(c) && hasDiamond(c[1])) { jf(c[1], T, out); return }
    out.push(['br_if', T, c])
  }
  // A VALUE if whose test holds a diamond, anywhere in an expression: the
  // then arm becomes the branch value and the else arm the fallthrough of a
  // result block. Returns the replacement or null.
  const valueIf = (s) => {
    if (!Array.isArray(s) || s[0] !== 'if' || !Array.isArray(s[1]) || s[1][0] !== 'result' || s[1].length !== 2 || !hasDiamond(s[2])) return null
    const thn = s.find(c => Array.isArray(c) && c[0] === 'then'), els = s.find(c => Array.isArray(c) && c[0] === 'else')
    if (!thn || !els || thn.length < 2 || els.length < 2) return null
    const T = s[1][1]
    const val = (arm) => arm.length === 2 ? arm[1] : ['block', ['result', T], ...arm.slice(1)]
    const x = fresh(), end = fresh(), inner = []
    jf(s[2], x, inner)
    return ['block', end, ['result', T], ['block', x, ...inner, ['br', end, val(thn)]], val(els)]
  }
  const rewriteExpr = (n) => {
    if (!Array.isArray(n)) return
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!Array.isArray(c)) continue
      const r = valueIf(c)
      if (r) { n[i] = r; rewriteExpr(r); continue }
      rewriteExpr(c)
    }
  }
  const rewriteList = (list, start) => {
    for (let i = start; i < list.length; i++) {
      const s = list[i]
      if (!Array.isArray(s)) continue
      const op = s[0]
      const r = valueIf(s)
      if (r) { list[i] = r; rewriteExpr(r); continue }
      if (op === 'if' && Array.isArray(s[1]) && s[1][0] !== 'result' && hasDiamond(s[1])) {
        const thn = s.find(c => Array.isArray(c) && c[0] === 'then'), els = s.find(c => Array.isArray(c) && c[0] === 'else')
        const T = thn ? thn.slice(1) : [], E = els ? els.slice(1) : []
        rewriteList(T, 0); rewriteList(E, 0)
        const x = fresh(), inner = []
        jf(s[1], x, inner)
        let node
        if (E.length) { const end = fresh(); inner.push(...T, ['br', end]); node = ['block', end, ['block', x, ...inner], ...E] }
        else { inner.push(...T); node = ['block', x, ...inner] }
        list[i] = node
        continue
      }
      if (op === 'br_if' && s.length === 3 && hasDiamond(s[2])) {
        const out = []
        jt(s[2], s[1], out)
        list.splice(i, 1, ...out); i += out.length - 1
        continue
      }
      if (op === 'block' || op === 'loop') {
        let k = 1
        while (k < s.length && (typeof s[k] === 'string' || (Array.isArray(s[k]) && s[k][0] === 'result'))) k++
        rewriteList(s, k)
      } else if (op === 'if') {
        rewriteExpr(s[1][0] === 'result' ? [null, s[2]] : [null, s[1]])
        for (let k = 1; k < s.length; k++) { const c = s[k]; if (Array.isArray(c) && (c[0] === 'then' || c[0] === 'else')) rewriteList(c, 1) }
      } else rewriteExpr(s)
    }
  }
  rewriteList(fn, bodyStart)
  if (dropped.size) for (let i = fn.length - 1; i >= 2; i--) {
    const c = fn[i]
    if (Array.isArray(c) && c[0] === 'local' && dropped.has(c[1])) fn.splice(i, 1)
  }
}
