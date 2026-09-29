/**
 * A binding of a spliced call read where it holds a literal is the literal.
 *
 * A spliced call binds each argument its body writes to a name of its own
 * (`let min = -1.5`), and the body's tests of the parameter are then tests of a
 * literal: `if (min === 0) min = 0`, `min !== min`, `max <= min`. The walk
 * carries what each binding holds along the statements in the order they run:
 *
 *   - a read of a binding that holds one literal on every path to the read is
 *     that literal;
 *   - an operator over literals is its answer (a comparison, `!`, arithmetic on
 *     numbers, a function of `Math` every implementation rounds the same way),
 *     and a `&&` or `||` read as a test over a literal that decides it;
 *   - the arm a decided test rules out is no code, so what it would have
 *     written is not written, and the binding holds its literal past the test.
 *
 * What a binding holds is known where the walk knows every write that can
 * reach the read:
 *   - paths that meet keep a binding both hold the same literal for;
 *   - a loop, a labeled statement and a `try` start and end without the
 *     bindings written anywhere in them: a later pass of the loop, a `break`
 *     or a throw reaches a read by a path the walk does not follow;
 *   - a binding a closure mentions is not followed: a closure runs at a time
 *     of its own. Neither is a name of the module.
 *
 * The bindings followed are the ones the splices made (an argument's, a local
 * of the spliced body: the names that begin with the compiler's mark). A
 * binding the function's own source declared
 * keeps its name: the passes that read a loop by its shape (a clamp against
 * `w - 1`, a window of `2 * r + 1`) match the names the source wrote, and the
 * emitter folds a constant of the source where it is read.
 *
 * A name read as a receiver (`a.b`, `a[i]`, `a()`) stays a name: a literal has
 * no members to store to, and the read is an error the name's emitter reports.
 *
 * @module compile/plan/constants
 */
import { ctx } from '../../ctx.js'
import { MUTATE_OPS, EXACT_MATH, T } from '../../ast.js'
import { setFuncBody } from '../analyze/body-facts.js'
import { optimizing } from './common.js'

const isArr = Array.isArray
const GONE = [';']
const RECEIVER_OPS = new Set(['.', '?.', '[]', '?.[]', '()', '?.()', 'new'])
const LOGICAL = new Set(['&&', '||'])
const COMPARE = new Set(['===', '!==', '==', '!=', '<', '<=', '>', '>='])
const ARITH = new Set(['+', '-', '*', '/'])
const REGIONS = new Set(['for', 'while', 'label', 'catch', 'finally'])

/** A literal the walk follows: a number (no NaN, whose node is its own), a truth value, `undefined`, `null`. */
const isLit = (n) => isArr(n) && n.length === 2 && (
  n[0] === 'bool' ? n[1] === 0 || n[1] === 1 || typeof n[1] === 'boolean'
    : n[0] == null && (n[1] == null || typeof n[1] === 'boolean' || (typeof n[1] === 'number' && n[1] === n[1])))
const valueOf = (n) => n[0] === 'bool' ? !!n[1] : n[1]
const sameLit = (a, b) => Object.is(valueOf(a), valueOf(b))
const bool = (b) => ['bool', b ? 1 : 0]
const num = (v) => [null, v]

/** `n`, an operator whose operands were walked, as its answer where they decide it. */
const fold = (n, test) => {
  const op = n[0]
  if (COMPARE.has(op) && n.length === 3 && isLit(n[1]) && isLit(n[2])) {
    const a = valueOf(n[1]), b = valueOf(n[2])
    // values of two types are strictly unequal; the loose forms and the orders convert
    if (typeof a !== typeof b || (a === null) !== (b === null)) return op === '===' ? bool(false) : op === '!==' ? bool(true) : n
    if (typeof a === 'number') return bool(op === '===' || op === '==' ? a === b : op === '!==' || op === '!=' ? a !== b
      : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b)
    if (op === '===' || op === '==') return bool(a === b)
    if (op === '!==' || op === '!=') return bool(a !== b)
    return n
  }
  if (op === '!' && n.length === 2 && isLit(n[1])) return bool(!valueOf(n[1]))
  if (ARITH.has(op) && n.length === 3 && isLit(n[1]) && isLit(n[2]) && typeof valueOf(n[1]) === 'number' && typeof valueOf(n[2]) === 'number') {
    const a = valueOf(n[1]), b = valueOf(n[2])
    const v = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b
    return v === v ? num(v) : n
  }
  if (op === 'u-' && n.length === 2 && isLit(n[1]) && typeof valueOf(n[1]) === 'number') return num(-valueOf(n[1]))
  if (test && LOGICAL.has(op) && n.length === 3) {
    if (isLit(n[1])) return !!valueOf(n[1]) === (op === '||') ? bool(op === '||') : n[2]
    if (isLit(n[2]) && !!valueOf(n[2]) !== (op === '||')) return n[1]   // `a && true`, `a || false`: the test is `a`
  }
  return n
}

/** A call of an exact function of `Math` over number literals as its value. */
const foldCall = (n) => {
  if (n[0] !== '()' || n.length !== 3 || !EXACT_MATH.has(n[1])) return n
  const args = isArr(n[2]) && n[2][0] === ',' ? n[2].slice(1) : [n[2]]
  if (!args.every(a => isLit(a) && typeof valueOf(a) === 'number')) return n
  const v = EXACT_MATH.get(n[1])(...args.map(valueOf))
  return v === v ? num(v) : n
}

/** The names `n` writes or declares, closures aside. */
const written = (n, out = new Set()) => {
  if (!isArr(n) || n[0] == null || n[0] === 'str' || n[0] === '=>') return out
  if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string') out.add(n[1])
  if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
    const d = n[i]
    if (typeof d === 'string') out.add(d)
    else if (isArr(d) && d[0] === '=' && typeof d[1] === 'string') out.add(d[1])
  }
  for (let i = 1; i < n.length; i++) written(n[i], out)
  return out
}

/** The names the closures of `n` mention. */
const captured = (n, out = new Set(), inArrow = false) => {
  if (typeof n === 'string') { if (inArrow) out.add(n); return out }
  if (!isArr(n) || n[0] == null || n[0] === 'str') return out
  const arrow = inArrow || n[0] === '=>'
  for (let i = 1; i < n.length; i++) captured(n[i], out, arrow)
  return out
}

/** `f`'s body with each read of a binding that holds a literal there the literal. */
export const constantsIn = (f) => {
  const body = f.body
  // nothing to follow without a binding a literal is stored to
  let any = false
  const seek = (n) => {
    if (any || !isArr(n) || n[0] == null || n[0] === 'str' || n[0] === '=>') return
    if (n[0] === '=' && typeof n[1] === 'string' && n[1].startsWith(T) && isLit(n[2])) { any = true; return }
    for (let i = 1; i < n.length; i++) seek(n[i])
  }
  seek(body)
  if (!any) return body

  const closed = captured(body)
  if (f.defaults) for (const d of Object.values(f.defaults)) captured(d, closed, true)
  const follows = (name) => name.startsWith(T) && !closed.has(name) && !ctx.scope.globals.has(name) && name !== f.rest

  // A state: what each binding holds (name → literal), `dead` past a statement that leaves.
  const fork = (st) => ({ env: new Map(st.env), dead: st.dead })
  const meet = (a, b) => {
    if (a.dead) return b
    if (b.dead) return a
    const env = new Map()
    for (const [k, v] of a.env) { const w = b.env.get(k); if (w !== undefined && sameLit(v, w)) env.set(k, v) }
    return { env, dead: false }
  }
  const into = (st, from) => { st.env = from.env; st.dead = from.dead }
  const forget = (st, names) => { for (const x of names) st.env.delete(x) }
  const hold = (st, name, v) => { if (isLit(v) && follows(name)) st.env.set(name, v); else st.env.delete(name) }

  const children = (n, st, from = 1) => {
    let out = n
    for (let i = from; i < n.length; i++) {
      const c = walk(n[i], st)
      if (c !== n[i]) { if (out === n) out = n.slice(); out[i] = c }
    }
    return out
  }
  // a statement in a place that holds one statement
  const stmt = (n, st) => { const c = walk(n, st); return c === GONE ? [';'] : c }
  // a member, an element or a call: a head that is a name stays, the key and the arguments are read
  const member = (n, st) => {
    const from = n[0] === '.' || n[0] === '?.' ? n.length : 2
    const head = typeof n[1] === 'string' ? n[1] : walk(n[1], st)
    const out = children(n, st, from)
    return head === n[1] ? out : [n[0], head, ...out.slice(2)]
  }

  const walk = (n, st, test = false) => {
    if (typeof n === 'string') { const v = st.env.get(n); return v === undefined ? n : v.slice() }
    if (!isArr(n) || n[0] == null || n[0] === 'str' || n[0] === '=>') return n
    const op = n[0]

    // a list of statements, or the members of an object literal (a bare name there is a member's)
    if (op === ';' || op === '{}') {
      let out = n
      for (let i = 1; i < n.length; i++) {
        const c = st.dead || typeof n[i] === 'string' ? n[i] : walk(n[i], st)
        if (c === n[i]) { if (out !== n) out.push(c); continue }
        if (out === n) out = n.slice(0, i)
        if (c === GONE) { if (op === '{}') out.push([';']); continue }
        out.push(c)
      }
      return out
    }
    if (op === 'let' || op === 'const') {
      let out = n
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (typeof d === 'string') { st.env.delete(d); continue }
        if (isArr(d) && d[0] === '=' && typeof d[1] === 'string') {
          const v = walk(d[2], st)
          hold(st, d[1], v)
          if (v !== d[2]) { if (out === n) out = n.slice(); out[i] = ['=', d[1], v] }
          continue
        }
        const c = children(d, st)
        forget(st, written(n))
        if (c !== d) { if (out === n) out = n.slice(); out[i] = c }
      }
      return out
    }
    if (MUTATE_OPS.has(op)) {
      const t = n[1]
      if (typeof t === 'string') {
        const out = children(n, st, 2)
        if (op === '=') hold(st, t, out[2]); else st.env.delete(t)
        return out
      }
      const target = isArr(t) && RECEIVER_OPS.has(t[0]) ? member(t, st) : walk(t, st)
      const out = children(n, st, 2)
      return target === t ? out : [op, target, ...out.slice(2)]
    }
    if (op === 'if' || op === '?:' || op === '?') {
      const c = walk(n[1], st, true)
      if (isLit(c)) {
        const live = valueOf(c) ? n[2] : n[3]
        if (live == null) return op === 'if' ? GONE : n
        return op === 'if' ? stmt(live, st) : walk(live, st, test)
      }
      const a = fork(st), b = fork(st)
      const then = op === 'if' ? stmt(n[2], a) : walk(n[2], a, test)
      const other = n[3] == null ? n[3] : op === 'if' ? stmt(n[3], b) : walk(n[3], b, test)
      into(st, meet(a, b))
      return c === n[1] && then === n[2] && other === n[3] ? n : n.length > 3 ? [op, c, then, other] : [op, c, then]
    }
    if (LOGICAL.has(op) || op === '??') {
      const asTest = test && op !== '??'
      const a = walk(n[1], st, asTest)
      const rest = fork(st)
      let out = a === n[1] ? n : [op, a, ...n.slice(2)]
      for (let i = 2; i < n.length; i++) {
        const c = walk(n[i], rest, asTest)
        if (c !== n[i]) { if (out === n) out = n.slice(); out[i] = c }
      }
      into(st, meet(st, rest))
      return op === '??' ? out : fold(out, test)
    }
    if (REGIONS.has(op)) {
      // `for (init; …)` runs its init once, ahead of what repeats
      let out = n
      const counted = op === 'for' && n.length === 5
      if (counted) { const c = walk(n[1], st); if (c !== n[1]) { out = n.slice(); out[1] = c } }
      const first = counted || op === 'label' ? 2 : 1
      const inside = new Set()
      for (let i = first; i < n.length; i++) written(n[i], inside)
      forget(st, inside)
      for (let i = first; i < n.length; i++) {
        if (typeof n[i] === 'string') continue   // a handler's parameter
        const part = fork(st)
        const head = (op === 'for' || op === 'while') && i < n.length - 1
        const c = head ? walk(n[i], part, counted ? i === 2 : op === 'while') : stmt(n[i], part)
        if (c !== n[i]) { if (out === n) out = n.slice(); out[i] = c }
      }
      st.dead = false
      return out
    }
    if (op === 'return' || op === 'throw') { const out = children(n, st); st.dead = true; return out }
    if (op === 'break' || op === 'continue') { st.dead = true; return n }
    if (op === ':') { const v = walk(n[2], st); return v === n[2] ? n : [op, n[1], v] }
    if (RECEIVER_OPS.has(op)) return foldCall(member(n, st))
    if (op === '!') { const c = walk(n[1], st, true); return fold(c === n[1] ? n : [op, c], test) }
    return fold(children(n, st), test)
  }

  return walk(body, { env: new Map(), dead: false })
}

export const propagateConstants = () => {
  if (!optimizing()) return false
  let changed = false
  for (const f of ctx.funcs.list) {
    if (f.raw || !f.body || !isArr(f.body) || f.body[0] !== '{}') continue
    const body = constantsIn(f)
    if (body !== f.body) { setFuncBody(f, body); changed = true }
  }
  return changed
}
