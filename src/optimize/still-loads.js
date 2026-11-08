/**
 * A loop that writes no memory and calls nothing reads the same value from an
 * address it does not change: such a read, and the work over reads alone, runs
 * once before the loop (speed tier, before watr).
 *
 * The planes of a frustum read for every sphere it culls, spliced into the loop
 * over the spheres and written out pass by pass (plan/exit-tests.js): `planes[k]`,
 * its `normal`, the normal's coordinates and the plane's constant, six times,
 * through a chain of three loads each, every round. V8 moves no load out of a
 * wasm loop, and watr's LICM moves pure expressions only, no load: a load a
 * store may change is no invariant without an alias analysis. Here none can:
 * nothing in the loop writes memory, so a load reads what it read the round
 * before wherever its address is the same.
 *
 * What moves is what every round runs before anything can leave it: the
 * statements of the loop's body from its start, up to the first that may branch
 * at all or end the round (its latch among them), and the expressions inside
 * them that no arm skips. The first round runs the same work, so a load that
 * traps traps there too, and running it ahead of the loop runs no read the loop
 * would not have. A value is invariant where it reads only literals, globals
 * (nothing in the loop sets one), locals the loop writes nowhere, and locals the
 * loop writes once, at a place every round runs, with an invariant value, before
 * any read of them in the round. An invariant expression holding a load moves
 * into a local of its own, and such a write whose value holds one moves whole;
 * a write of a value without a load moves only ahead of a read that moves and
 * needs it (watr's LICM moves the rest, and the pass leaves it that work). A loop
 * with a call, a store, a memory or table operation that writes, a global's write
 * or a handler keeps its reads.
 *
 * @module optimize/still-loads
 */
import { isMemWrite } from 'watr/optimize'

const isArr = Array.isArray
// (sets, not patterns: the compiler compiles itself, and its source keeps to plain string tests)
const LISTS = new Set(['func', 'block', 'loop', 'then', 'else'])
const LABELLED = new Set(['block', 'loop', 'if', 'try', 'try_table'])
const BRANCHES = new Set(['br', 'br_if', 'br_table', 'return', 'unreachable', 'throw', 'throw_ref', 'rethrow', 'delegate', 'return_call', 'return_call_indirect', 'return_call_ref'])
const OPAQUE = new Set(['call', 'call_indirect', 'call_ref', 'return_call', 'return_call_indirect', 'return_call_ref', 'try', 'try_table', 'catch', 'catch_all', 'global.set'])
const WRITES = new Set(['local.set', 'local.tee'])
const HEADER = new Set(['export', 'param', 'result', 'local', 'type'])
const NUMBERS = new Set(['i32', 'i64', 'f32', 'f64'])
const TESTS = new Set(['eq', 'ne', 'lt', 'gt', 'le', 'ge', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u', 'eqz'])

const label = (n) => typeof n[1] === 'string' && n[1][0] === '$' ? n[1] : null
const some = (n, f) => isArr(n) && (f(n) || n.some((c, i) => i > 0 && some(c, f)))
const isLoad = (op) => typeof op === 'string' && op.includes('.load') && !op.includes('.atomic.')
const branches = (n) => some(n, m => BRANCHES.has(m[0]))

/** Move the invariant reads of `loop` before it: the statements it puts there, or null. */
function stillLoop(loop, fresh) {
  // (nothing in the loop writes memory, calls, sets a global or handles a throw)
  if (some(loop, n => typeof n[0] === 'string' && (isMemWrite(n[0]) || OPAQUE.has(n[0])))) return null
  const start = label(loop) ? 2 : 1
  if (loop.slice(start).some(c => isArr(c) && (c[0] === 'result' || c[0] === 'param' || c[0] === 'type'))) return null
  const writes = new Map()
  some(loop, n => { if (WRITES.has(n[0]) && typeof n[1] === 'string') writes.set(n[1], (writes.get(n[1]) ?? 0) + 1); return false })
  // the statements every round runs before anything can branch
  let end = start
  while (end < loop.length && isArr(loop[end]) && !branches(loop[end])) end++
  if (end === start) return null
  // a write of an invariant value with no load, which watr's LICM moves as well, is pending: it
  // moves only ahead of a read the pass moves (`need`)
  const inv = new Set(), read = new Set(), out = [], pending = new Map(), held = new Set()
  const invariant = (e) => {
    if (!isArr(e)) return true
    const op = e[0]
    if (op === 'local.get') return typeof e[1] === 'string' && (!writes.has(e[1]) || inv.has(e[1]))
    if (WRITES.has(op)) return held.has(e)
    if (LABELLED.has(op)) return false
    for (let i = 1; i < e.length; i++) if (isArr(e[i]) && !invariant(e[i])) return false
    return true
  }
  const noteReads = (e) => some(e, m => { if (m[0] === 'local.get' && typeof m[1] === 'string') read.add(m[1]); return false })
  const holdsLoad = (e) => some(e, m => isLoad(m[0]))
  const move = (w, parent, i) => {
    need(w[2])
    out.push(['local.set', w[1], w[2]])
    parent[i] = w[0] === 'local.tee' ? ['local.get', w[1]] : null
  }
  // the pending writes `e` holds or reads, moved ahead of it in the order they run
  const need = (e) => {
    if (!isArr(e)) return
    for (let i = 1; i < e.length; i++) {
      const c = e[i]
      if (!isArr(c)) continue
      if (held.has(c)) { held.delete(c); pending.delete(c[1]); move(c, e, i) }
      else need(c)
      if (c[0] === 'local.get' && pending.has(c[1])) { const [w, wp, wi] = pending.get(c[1]); pending.delete(c[1]); held.delete(w); move(w, wp, wi) }
    }
  }
  // `e` whole, where it is invariant: a load, or work over loads, into a local of its own; a write,
  // its value holding a load, moved
  const take = (e, parent, i) => {
    const op = e[0]
    if (WRITES.has(op)) {
      const x = e[1]
      if (writes.get(x) !== 1 || read.has(x) || !invariant(e[2])) return false
      noteReads(e[2])
      inv.add(x)
      if (holdsLoad(e[2])) move(e, parent, i)
      else { pending.set(x, [e, parent, i]); held.add(e) }
      return true
    }
    if (op === 'block' || !holdsLoad(e) || !invariant(e)) return false
    const name = fresh(e)
    if (!name) return false
    noteReads(e)
    need(e)
    out.push(['local.set', name, e])
    parent[i] = ['local.get', name]
    return true
  }
  // `e`, child `i` of `parent`, a value every round computes, in the order it evaluates: its
  // invariant work moved out, the rest as it was
  const visit = (e, parent, i) => {
    if (!isArr(e)) return
    const op = e[0]
    if (op === 'local.get') { if (typeof e[1] === 'string') read.add(e[1]); return }
    if (WRITES.has(op) && (typeof e[1] !== 'string' || e.length !== 3)) return
    if (take(e, parent, i)) return
    // (an arm runs on some rounds: the test alone; a block, branch-free as the statement holding it, all of it; a loop none)
    if (op === 'if') { let t = label(e) ? 2 : 1; while (isArr(e[t]) && (e[t][0] === 'result' || e[t][0] === 'type' || e[t][0] === 'param')) t++; visit(e[t], e, t); return }
    if (LABELLED.has(op)) { if (op === 'block') for (let k = label(e) ? 2 : 1; k < e.length; k++) visit(e[k], e, k); return }
    for (let k = 1; k < e.length; k++) visit(e[k], e, k)
    // (what its operands moved out may leave the rest invariant)
    take(e, parent, i)
  }
  for (let k = start; k < end; k++) visit(loop[k], loop, k)
  if (!out.length) return null
  // (a write moved out of a statement list or a value block leaves the statements around it)
  const prune = (n) => { if (!isArr(n)) return; for (let k = n.length - 1; k >= 1; k--) { if (n[k] === null) n.splice(k, 1); else prune(n[k]) } }
  prune(loop)
  return out
}

/** Move the invariant reads of every function's loops that write no memory and call nothing ahead of them. */
export function hoistStillLoads(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) {
    if (!isArr(fn) || fn[0] !== 'func' || !some(fn, n => n[0] === 'loop')) continue
    const locals = new Map()
    for (const c of fn) if (isArr(c) && (c[0] === 'local' || c[0] === 'param') && typeof c[1] === 'string') locals.set(c[1], c[2])
    const decls = []
    let id = 0
    // a local for `e`'s value, of its type (null where the type is not one a local takes)
    const fresh = (e) => {
      const t = typeOf(e, locals)
      if (!t) return null
      let name = `$__still${id++}`
      while (locals.has(name)) name = `$__still${id++}`
      locals.set(name, t)
      decls.push(['local', name, t])
      return name
    }
    // innermost first: what a loop moves out lands in the loop around it, which may move it again
    const walk = (n) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        walk(c)
        if (c[0] === 'loop' && LISTS.has(n[0])) {
          const moved = stillLoop(c, fresh)
          if (moved) { n.splice(i, 0, ...moved); i += moved.length }
        }
      }
    }
    walk(fn)
    if (decls.length) {
      let at = typeof fn[1] === 'string' ? 2 : 1
      while (at < fn.length && isArr(fn[at]) && HEADER.has(fn[at][0])) at++
      fn.splice(at, 0, ...decls)
    }
  }
  return ast
}

// The value type of a scalar expression (a load's, an operator's by its prefix, a test's i32, a
// local's), or null for one a local here should not take.
const typeOf = (e, locals) => {
  if (!isArr(e) || typeof e[0] !== 'string') return null
  const op = e[0]
  if (op === 'local.get') return locals.get(e[1]) ?? null
  const dot = op.indexOf('.')
  if (dot < 0) return null
  const p = op.slice(0, dot)
  if (!NUMBERS.has(p)) return null
  return TESTS.has(op.slice(dot + 1)) ? 'i32' : p
}
