/**
 * Definite assignment: the bare declarations of a function body (`let x`)
 * whose every read follows an assignment on every path that reaches it. Such
 * a binding never shows the `undefined` it is declared with, so the summary
 * declares it empty instead of absent and its kind is the join of what is
 * assigned (`let t; if (c) t = a[0]; else t = b[0]; out[0] = t` stores a
 * number, not a number that may be missing).
 *
 * The walk carries the set of names assigned so far and joins it where paths
 * meet: both arms of a branch must assign, a loop body may not run, a handler
 * starts from what held before the `try`. A closure runs at a time the walk
 * does not know, so a name it mentions must be assigned where the closure is
 * made. The answer may leave out a binding that is always assigned; it never
 * includes one a read can find unassigned. It walks prepared bodies: patterns,
 * `switch`, `do` and for-of/in heads are already lowered.
 *
 * @module summary/definite
 */
import { MUTATE_OPS } from '../ast.js'

const LOGICAL_ASSIGN = new Set(['||=', '&&=', '??='])

/** The names `body` declares bare and assigns before every read, nested closures' own aside. */
export function definitelyAssigned(body) {
  const bare = new Set()
  const declared = (n) => {
    if (!Array.isArray(n) || n[0] === '=>') return
    if (n[0] === 'let') { for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string') bare.add(n[i]) }
    for (let i = 1; i < n.length; i++) declared(n[i])
  }
  declared(body)
  if (!bare.size) return bare

  // A state is the set of names assigned on every path to here; `null` past a
  // statement that leaves (no path continues, so every name counts assigned).
  const join = (a, b) => { if (a === null) return b; if (b === null) return a; const out = new Set(); for (const x of a) if (b.has(x)) out.add(x); return out }
  const fork = (a) => a === null ? null : new Set(a)
  const assign = (name, a) => { if (a !== null && bare.has(name)) a.add(name); return a }
  const read = (name, a) => { if (a !== null && bare.has(name) && !a.has(name)) bare.delete(name) }
  const mentions = (n, a) => {
    if (typeof n === 'string') read(n, a)
    else if (Array.isArray(n)) for (let i = 1; i < n.length; i++) mentions(n[i], a)
  }
  const seq = (n, a, from = 1) => { for (let i = from; i < n.length; i++) a = walk(n[i], a); return a }

  const walk = (n, a) => {
    if (typeof n === 'string') { read(n, a); return a }
    if (!Array.isArray(n)) return a
    const op = n[0]
    if (op == null || op === 'str') return a
    if (op === '=>') { mentions(n[1], a); mentions(n[2], a); return a }
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=') a = assign(d[1], walk(d[2], a)) }
      return a
    }
    if (MUTATE_OPS.has(op)) {
      const t = n[1]
      if (typeof t !== 'string') return seq(n, a)   // a member or an element: its receiver and key are read
      if (op === '=') return assign(t, walk(n[2], a))
      read(t, a)
      if (LOGICAL_ASSIGN.has(op)) { walk(n[2], fork(a)); return a }
      return assign(t, n.length > 2 ? walk(n[2], a) : a)
    }
    if (op === 'if' || op === '?:' || op === '?') {
      a = walk(n[1], a)
      return join(walk(n[2], fork(a)), n[3] == null ? a : walk(n[3], fork(a)))
    }
    if (op === '&&' || op === '||' || op === '??' || op === '?.' || op === '?.()' || op === '?.[]') {
      a = walk(n[1], a)
      seq(n, fork(a), 2)
      return a
    }
    if (op === 'for' && n.length === 5) {
      a = walk(n[2], walk(n[1], a))
      walk(n[3], walk(n[4], fork(a)) ?? fork(a))
      return a
    }
    if (op === 'while') { a = walk(n[1], a); walk(n[2], fork(a)); return a }
    if (op === 'return' || op === 'throw') { seq(n, a); return null }
    if (op === 'break' || op === 'continue') return null
    if (op === 'catch') { walk(n[1], fork(a)); walk(n[3], fork(a)); return a }
    if (op === 'finally') { walk(n[1], fork(a)); return walk(n[2], a) }
    if (op === 'label') return walk(n[2], a)
    return seq(n, a)
  }
  walk(body, new Set())
  return bare
}
