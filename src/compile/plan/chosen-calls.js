/**
 * A local that holds one of several functions and is only called calls the
 * one it holds directly.
 *
 * `let fn = type === 'highpass' ? highpass : lowpass`, then `fn(fc, Q, fs)`
 * per sample: the functions are values, so each has a table entry and a
 * trampoline, every call is indirect with its arguments boxed, and neither
 * body can inline into the loop. Holding the chosen function's number
 * instead (`let fn = type === 'highpass' ? 0 : 1`), each call is the choice
 * of direct calls `fn === 0 ? highpass(fc, Q, fs) : lowpass(fc, Q, fs)`: one
 * compare of a number the loop does not change, then a call typed and
 * inlinable like any other.
 *
 * The same functions run with the same arguments in the same order. The
 * local is read nowhere but as a callee and written nowhere but its
 * declaration; each function it may hold is named by a function declaration
 * nothing assigns and nothing in the function shadows, so the name reads the
 * same function where the local was bound and where it is called. A call's
 * arguments are copied into each arm, of which one runs; a site whose copies
 * would add more than a few nodes, or whose arguments call the local again,
 * leaves the local as it is.
 *
 * @module compile/plan/chosen-calls
 */
import { ctx } from '../../ctx.js'
import { ASSIGN_OPS, isBlockBody, some, walkAst } from '../../ast.js'
import { frameRoots } from '../../function.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'
import { clonePlain, collectBindings, nodeSize } from './common.js'

const MAX_COPY = 48

const bare = (n) => Array.isArray(n) && n[0] === '()' && n.length === 2 ? bare(n[1]) : n

/** The function names a choice (`c ? f : g`, nested, grouped) ends in, in order; null for anything else. */
const leavesOf = (n, out = []) => {
  n = bare(n)
  if (typeof n === 'string') return ctx.funcs.names.has(n) ? (out.push(n), out) : null
  if (!Array.isArray(n) || n[0] !== '?:') return null
  return leavesOf(n[2], out) && leavesOf(n[3], out)
}

/** The choice with each function name replaced by its number. */
const numbered = (n, index) => {
  n = bare(n)
  return typeof n === 'string' ? [null, index.get(n)] : ['?:', n[1], numbered(n[2], index), numbered(n[3], index)]
}

/** Whether every mention of `name` in `node` is the callee of a call, the calls
 *  going to `calls`; the declarator `decl` counts for its initializer alone.
 *  A write, a read as a value or a closure mentioning the name is none. */
const onlyCalled = (node, name, calls, decl) => {
  if (node === decl) return onlyCalled(decl[2], name, calls, decl)
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node) || node[0] === 'str' || node[0] == null) return true
  if (node[0] === '=>') return !some(node, n => n.includes(name))
  if (node[0] === '.' || node[0] === '?.') return onlyCalled(node[1], name, calls, decl)
  let i = 1
  if (node[0] === '()' && node[1] === name) { calls.push(node); i = 2 }
  for (; i < node.length; i++) if (!onlyCalled(node[i], name, calls, decl)) return false
  return true
}

/** Call `f` on each statement of `node` in a statement's place (a sequence, a
 *  block, an arm, a loop body), replacing it with what `f` returns, if anything:
 *  a sequence returned into a sequence joins it, so its declarations stay in scope. */
const statements = (node, f) => {
  if (!Array.isArray(node) || node[0] === '=>') return
  const op = node[0]
  const at = op === ';' ? node.map((_, i) => i).slice(1) : op === '{}' && isBlockBody(node) ? [1]
    : op === 'if' ? [2, 3] : op === 'while' ? [2] : op === 'for' ? [node.length - 1] : []
  for (let k = at.length - 1; k >= 0; k--) {
    const i = at[k]
    if (!Array.isArray(node[i])) continue
    const r = f(node[i])
    if (!r) statements(node[i], f)
    else if (op === ';' && r[0] === ';') node.splice(i, 1, ...r.slice(1))
    else node[i] = r
  }
  if (!at.length) for (let i = 1; i < node.length; i++) statements(node[i], f)
}

/** Names the program assigns anywhere: module code, every function body and default. */
const assignedNames = (ast) => {
  const out = new Set()
  const scan = (root) => walkAst(root, { enter: (n) => {
    if ((ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') && typeof n[1] === 'string') out.add(n[1])
  } })
  scan(ast)
  for (const mi of ctx.module.moduleInits || []) scan(mi)
  for (const f of ctx.funcs.list) if (f.body && !f.raw) for (const r of frameRoots(f)) scan(r)
  return out
}

export const callChosenFunctions = (ast) => {
  if (ctx.transform.optimize?.callChosenFunctions === false || !ctx.funcs.names?.size) return false
  let assigned = null, changed = false
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    // `let fn = c ? f : g`, the one binding of its name in the function
    const decls = new Map(), counts = new Map()
    walkAst(func.body, { enter: (n) => {
      if (n[0] === '=>') return false
      if (n[0] !== 'let' && n[0] !== 'const') return
      for (let i = 1; i < n.length; i++) {
        const d = n[i], name = Array.isArray(d) && d[0] === '=' ? d[1] : d
        if (typeof name !== 'string') continue
        counts.set(name, (counts.get(name) ?? 0) + 1)
        const leaves = Array.isArray(d) && leavesOf(d[2])
        if (leaves) decls.set(name, { d, leaves })
      }
    } })
    if (!decls.size) continue
    const params = new Set((func.sig?.params ?? []).map(p => p.name))
    const locals = new Set(params)
    collectBindings(func.body, locals)
    let rewrote = false
    for (const [name, { d, leaves }] of decls) {
      if (counts.get(name) !== 1 || params.has(name) || leaves.some(f => locals.has(f))) continue
      const calls = []
      if (!onlyCalled(func.body, name, calls, d) || !calls.length) continue
      const fns = [...new Set(leaves)]
      // each call's arguments are copied whole: none holds another call of the name
      if (calls.some(c => nodeSize(c) * (fns.length - 1) > MAX_COPY || c.slice(2).some(a => some(a, n => n.includes(name))))) continue
      assigned ??= assignedNames(ast)
      if (fns.some(f => assigned.has(f))) continue
      const index = new Map(fns.map((f, i) => [f, i]))
      d[2] = numbered(d[2], index)
      // `test ? a : b` of what `wrap` makes of each function's call, a statement's
      // choice an `if` (whose arms the inliner splices), an expression's a `?:`
      const choose = (c, wrap, op) => {
        const call = (f) => wrap(['()', f, ...c.slice(2).map(clonePlain)])
        let out = call(fns[fns.length - 1])
        for (let i = fns.length - 2; i >= 0; i--) out = [op, ['===', name, [null, i]], call(fns[i]), out]
        return out
      }
      const own = new Set(calls)
      statements(func.body, (st) => {
        if (own.has(st)) { own.delete(st); return choose(st, c => c, 'if') }
        if ((st[0] === '=' || st[0] === 'return') && own.has(st[st.length - 1]) && (st[0] === 'return' || typeof st[1] === 'string')) {
          const c = st[st.length - 1]
          own.delete(c)
          return choose(c, st[0] === 'return' ? c => ['return', c] : c => ['=', st[1], c], 'if')
        }
        // `let x = fn(…)`, its one declarator: `let x; if (…) x = f(…); else x = g(…)`
        if ((st[0] === 'let' || st[0] === 'const') && st.length === 2 && Array.isArray(st[1]) && st[1][0] === '=' &&
            typeof st[1][1] === 'string' && own.has(st[1][2])) {
          const c = st[1][2], x = st[1][1]
          own.delete(c)
          return [';', ['let', x], choose(c, c => ['=', x, c], 'if')]
        }
      })
      for (const c of own) c.splice(0, c.length, ...choose(c, c => c, '?:'))
      rewrote = true
    }
    // rewritten in place: the facts cached for the body describe what it was
    if (rewrote) { invalidateProgramFactsCache(func.body); invalidateBodies([func.body]); changed = true }
  }
  return changed
}
