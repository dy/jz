/**
 * A loop that tests a name it never writes runs as two copies, one for each
 * answer: `if (c) { loop, c true } else { loop, c false }`. Each copy keeps
 * the arms of the tests its answer takes and drops the others, and gives its
 * own declarations fresh names, so a value a copy computes has the kind its
 * arm gives it: in a kernel taking a mono buffer or a list of channels,
 * `let x = stereo ? (L[i] + R[i]) * 0.5 : L[i]` is a number in the stereo copy,
 * and `x + lp` adds numbers there.
 *
 * The name is a local of the function (a parameter or a declaration outside
 * the loop) no closure names; the tests are an `if` or a `?:` of the name or
 * its `!`. The name's truth at the loop's entry is its truth at every test in
 * it, the loop never writing it. A loop with a closure, a label or a
 * suspension in it is left alone, and one too large to copy twice.
 *
 * @module compile/plan/unswitch-loops
 */
import { ctx } from '../../ctx.js'
import { T, some, walkAst } from '../../ast.js'
import { freshId } from '../../ir.js'
import { cloneWithSubst } from '../../type.js'
import { collectBindings, mutatesAny, nodeSize } from './common.js'

const LOOPS = new Set(['for', 'while'])
const TESTS = new Set(['if', '?:', '?'])
const MAX_SIZE = 800

/** The name a test reads, and whether through `!`. */
const tested = (t) => typeof t === 'string' ? { name: t, not: false }
  : Array.isArray(t) && t[0] === '!' && t.length === 2 && typeof t[1] === 'string' ? { name: t[1], not: true } : null

/** Keep, in `node`, the arms of the tests of `name` that `truth` takes. */
const fold = (node, name, truth) => {
  if (!Array.isArray(node)) return
  for (let j = 1; j < node.length; j++) {
    const c = node[j]
    if (!Array.isArray(c)) continue
    const t = TESTS.has(c[0]) ? tested(c[1]) : null
    if (t?.name === name) {
      // the arm taken; an `if` with none leaves an empty statement
      const arm = (truth !== t.not ? c[2] : c[3]) ?? null
      if (arm == null && node[0] === ';' && node.length > 2) node.splice(j, 1)
      else node[j] = arm
      j--
      continue
    }
    if (c[0] !== '=>') fold(c, name, truth)
  }
}

export const unswitchLoops = () => {
  if (ctx.transform.optimize?.unswitchLoops === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    // what a closure of the function names, it reads or writes where the copies cannot see
    const captured = new Set()
    walkAst(func.body, { enter: (n) => {
      if (n[0] !== '=>') return
      walkAst(n, { enter: (m) => { for (let i = 1; i < m.length; i++) if (typeof m[i] === 'string') captured.add(m[i]) } })
      return false
    } })
    const locals = new Set((func.sig?.params ?? []).map(p => p.name))
    collectBindings(func.body, locals)
    const loops = []
    walkAst(func.body, { enter: (node, parent, idx) => {
      if (node[0] === '=>') return false
      if (LOOPS.has(node[0]) && parent) { loops.push([node, parent, idx]); return false }
    } })
    for (const [loop, parent, idx] of loops) {
      if (parent[idx] !== loop || nodeSize(loop) > MAX_SIZE) continue
      if (some(loop, n => n[0] === '=>' || n[0] === 'label' || n[0] === 'yield' || n[0] === 'await')) continue
      const inner = new Set()
      collectBindings(loop, inner)
      let name = null
      walkAst(loop, { enter: (n) => {
        if (name != null || n[0] === '=>') return false
        const t = TESTS.has(n[0]) ? tested(n[1]) : null
        if (t && locals.has(t.name) && !inner.has(t.name) && !captured.has(t.name) && !ctx.funcs.names.has(t.name) && !mutatesAny(loop, new Set([t.name]))) name = t.name
      } })
      if (name == null) continue
      const copy = (truth) => {
        const own = new Map([...inner].map(n => [n, `${n}${T}sw${freshId(ctx)}`]))
        const out = cloneWithSubst(loop, new Map(), own)
        fold(out, name, truth)
        return out
      }
      parent[idx] = ['if', name, ['{}', [';', copy(true)]], ['{}', [';', copy(false)]]]
      changed = true
    }
  }
  return changed
}
