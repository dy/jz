/**
 * A run of straight-line statements that reads or stores several elements of one
 * array at indexes held in bindings (a swap's `t = a[i]; a[i] = a[j]; a[j] = t`, a
 * heap's sift step, `a[i] = a[i] + a[j]`) pays at every access for what no index
 * proves: the index as a property key, the forwarding test, the length test, and at
 * a store the arm that grows the array. An index that is a method's parameter or a
 * recursion's has no range to prove, so the accesses are tested once instead: under
 * one guard that each index is an integer inside the array's length, the arm reads
 * and stores the cells in place, and where the guard fails the statements run as
 * written.
 *
 *   t = a[i]; a[i] = a[j]; a[j] = t
 *   →
 *   const a1 = a, n = a1.length
 *   if (i === (i | 0) && i >= 0 && i < n && j === (j | 0) && j >= 0 && j < n) {
 *     let i1 = i | 0, j1 = j | 0
 *     t = a1[i1]; a1[i1] = a1[j1]; a1[j1] = t
 *   } else { t = a[i]; a[i] = a[j]; a[j] = t }
 *
 * The arm's index bindings carry the guard's proof to the summary as a versioned
 * cursor's do (`lo`, `hi`, `bound`: summary/index.js noteHull; the emitter reads the
 * pair inside the length, type/canonical-bounds.js inBoundsArrIdx). The proof holds
 * while nothing in the run shrinks the array, binds its name or an index again, or
 * runs code: a run is declarations and assignments of pure expressions alone (no call
 * but `Math`'s, no closure, no control flow), and the canonical loop's own question
 * passes over it (preservesLoopBounds). A store through another name may grow the
 * array, under that name too: growth keeps every index inside, and each access follows
 * the forward. The receiver is a name or a path of names from an object the summary
 * holds present, read once for the arm; an index of -0 is 0 as a key.
 *
 * The run is the statements from the first access of the array to the last, where one
 * of them stores (a read's own tests cost what the guard's do; a store's growth arm, its
 * test of the heap after and the frame's protocol above it are what the guard spares)
 * and the names the run declares are read nowhere after it (each arm is a block). An
 * access a proof already holds inside the length is none of the run's: one a canonical
 * loop bounds, one at a versioned cursor, any of an array whose length never changes.
 * The speed tiers alone: the run is written twice.
 *
 * @module compile/plan/element-runs
 */
import { ctx } from '../../ctx.js'
import { T, ASSIGN_OPS, copyNode, noted, nodeKey } from '../../ast.js'
import { freshId } from '../../ir.js'
import { K, tagOf, core, isNullable } from '../../summary/kind.js'
import { nodeSize } from '../../growth.js'
import { preservesLoopBounds, scanBoundedArrIdx } from '../../type/canonical-bounds.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'

const isArr = Array.isArray
const MAX_RUN_NODES = 160   // the nodes a run copies at most
const ARRAY_TOP = 0x1ffffffe   // the count an array holds at most
// The operators of a run's expressions: arithmetic, comparison, choice, a member's and an element's read.
const PURE = new Set(['+', '-', '*', '/', '%', '**', 'u-', 'u+', '!', '~', '<', '<=', '>', '>=', '==', '!=', '===', '!==',
  '&', '|', '^', '<<', '>>', '>>>', '&&', '||', '??', '?:', '.', '[]'])
const LOGICAL_ASSIGN = new Set(['||=', '&&=', '??='])
const pure = (n) => {
  if (!isArr(n)) return true
  if (n[0] == null || n[0] === 'str') return true
  if (n[0] === '()') {
    if (typeof n[1] !== 'string' || !n[1].startsWith('math.') || n[1] === 'math.random') return false
    const a = n[2]
    return a == null || (isArr(a) && a[0] === ',' ? a.slice(1).every(pure) : pure(a))
  }
  if (!PURE.has(n[0])) return false
  if (n[0] === '.') return typeof n[2] === 'string' && pure(n[1])
  for (let i = 1; i < n.length; i++) if (!pure(n[i])) return false
  return true
}
/** A statement a run may hold: a declaration of names, or an assignment to a name, a member or an element, of pure expressions. */
const plain = (s) => {
  if (!isArr(s)) return false
  if (s[0] === 'let' || s[0] === 'const') return s.length > 1 && s.slice(1).every(d => typeof d === 'string' || isArr(d) && d[0] === '=' && typeof d[1] === 'string' && pure(d[2]))
  if (!ASSIGN_OPS.has(s[0]) || LOGICAL_ASSIGN.has(s[0]) || !pure(s[2])) return false
  const t = s[1]
  if (typeof t === 'string') return true
  if (s[0] !== '=' || !isArr(t)) return false
  return t[0] === '.' ? typeof t[2] === 'string' && pure(t[1]) : t[0] === '[]' && t.length === 3 && pure(t[1]) && pure(t[2])
}
// A name, or a path of names below one: what reading it twice reads the same of.
const path = (e) => typeof e === 'string' || (isArr(e) && e[0] === '.' && typeof e[2] === 'string' && path(e[1]))
const rootOf = (e) => typeof e === 'string' ? e : rootOf(e[1])
const propsOf = (e, out = new Set()) => { if (isArr(e)) { out.add(e[2]); propsOf(e[1], out) } return out }
const copyPath = (e) => typeof e === 'string' ? e : noted(e, ['.', copyPath(e[1]), e[2]])
const and = (terms) => terms.reduce((a, b) => ['&&', a, b])
const mentions = (n, names) => typeof n === 'string' ? names.has(n) : isArr(n) && n[0] !== 'str' && n[0] != null && n.some((c, i) => i > 0 && mentions(c, names))
const declaredBy = (s, out) => { if (isArr(s) && (s[0] === 'let' || s[0] === 'const')) for (let i = 1; i < s.length; i++) { const d = s[i]; out.add(typeof d === 'string' ? d : d[1]) } }
/** The element accesses of a statement: each `x[k]` node with whether the statement stores through it. */
const accesses = (s, out) => {
  const walk = (n, stored) => {
    if (!isArr(n) || n[0] == null || n[0] === 'str') return
    if (n[0] === '[]' && n.length === 3) out.push({ node: n, stored })
    for (let i = 1, end = n[0] === '.' ? 2 : n.length; i < end; i++) walk(n[i], false)
  }
  if (s[0] === 'let' || s[0] === 'const') { for (let i = 1; i < s.length; i++) if (isArr(s[i])) walk(s[i][2], false) }
  else { if (isArr(s[1])) { if (s[1][0] === '[]') { out.push({ node: s[1], stored: true }); walk(s[1][1], false); walk(s[1][2], false) } else walk(s[1], false) } walk(s[2], false) }
  return out
}

/** The run of `list` starting at or after `from` inside the plain statements `[from, to]`, or null: its bounds, receiver, indexes and access nodes.
 *  `held`: the accesses a proof already holds inside the length, which pay for no guard. */
const runIn = (list, from, to, view, held) => {
  const per = []   // per statement: its accesses
  const spans = new Map()   // receiver key → { recv, first, last, count }
  // an access at a name that no loop and no cursor's guard holds inside the length
  const open = (node) => typeof node[2] === 'string' && path(node[1]) && !held.has(node) && view.indexBoundOf(node[2]) !== node[1]
  for (let i = from; i <= to; i++) {
    const acc = accesses(list[i], [])
    per.push(acc)
    for (const { node } of acc) {
      if (!open(node)) continue
      const key = nodeKey(node[1]), sp = spans.get(key)
      if (sp) { sp.last = i; sp.count++ } else spans.set(key, { recv: node[1], first: i, last: i, count: 1 })
    }
  }
  for (const [key, sp] of spans) {
    if (sp.count < 2) continue
    const { recv, first, last } = sp
    const nodes = new Set(), keys = new Set()
    let stores = 0, size = 0
    for (let i = first; i <= last; i++) {
      size += nodeSize(list[i])
      for (const { node, stored } of per[i - from]) {
        if (!open(node) || nodeKey(node[1]) !== key) continue
        nodes.add(node); keys.add(node[2])
        if (stored) stores++
      }
    }
    // (a read's own tests cost what the guard's do: the guard pays where it spares a store its growth arm)
    if (size > MAX_RUN_NODES || !stores) continue
    const root = rootOf(recv), props = propsOf(recv), declared = new Set()
    for (let i = first; i <= last; i++) declaredBy(list[i], declared)
    const span = list.slice(first, last + 1)
    // (a member of the path stored in the run is another array at the next access)
    if (props.size && span.some(s => s[0] === '=' && isArr(s[1]) && s[1][0] === '.' && props.has(s[1][2]))) continue
    // each arm is a block: what the run declares is read inside it alone
    if (declared.size && list.slice(last + 1).some(s => mentions(s, declared))) continue
    const number = (k) => { const kind = view.kindOfExpr(k); return !!kind && tagOf(core(kind)) === K.NUMBER && !isNullable(kind) }
    if (![...keys].every(number)) continue
    const kind = view.kindOfExpr(recv)
    // (an array of a length that never changes pays a length test alone at each access)
    if (!kind || tagOf(core(kind)) !== K.ARRAY || view.fixedLenOfExpr(recv) != null) continue
    // a path is read ahead of the run: every object on it is one the summary holds present
    let present = true
    for (let e = recv; isArr(e); e = e[1]) if (view.mayBeNullishExpr(e[1]) !== false) present = false
    if (!present || !preservesLoopBounds([';', ...span], view, [root, ...keys])) continue
    return { first, last, recv, keys: [...keys], nodes, array: !isNullable(kind) }
  }
  return null
}

/** The run written under its guard: the `if` that replaces its statements. */
const guarded = (list, run) => {
  const { first, last, recv, keys, nodes } = run
  const at = list[first], fresh = (name, tag) => `${name}${T}${tag}${freshId(ctx)}`
  const array = fresh(rootOf(recv), 'ra'), twins = new Map(keys.map(k => [k, fresh(k, 'rk')]))
  // An array the summary holds present is read once ahead of the test, and its length; one that may be
  // missing or another kind is asked first, and read in the arm.
  const length = run.array ? fresh(rootOf(recv), 'rn') : null
  const terms = run.array ? [] : [['()', 'Array.isArray', copyPath(recv)]]
  for (const k of keys) terms.push(['===', k, ['|', k, [null, 0]]], ['>=', k, [null, 0]], ['<', k, length ?? ['.', copyPath(recv), 'length']])
  const held = noted(at, ['=', array, copyPath(recv)])
  const decls = run.array ? [] : [held]
  for (const k of keys) { const d = noted(at, ['=', twins.get(k), ['|', k, [null, 0]]]); d.lo = 0; d.hi = ARRAY_TOP; d.bound = array; decls.push(d) }
  const copy = (n) => {
    if (!isArr(n) || n[0] == null || n[0] === 'str') return n
    if (nodes.has(n)) return noted(n, ['[]', array, twins.get(n[2])])
    const c = copyNode(n)
    for (let i = 1; i < (n[0] === '.' ? 2 : n.length); i++) c[i] = copy(n[i])
    return c
  }
  const fast = noted(at, ['{}', noted(at, [';', noted(at, ['let', ...decls]), ...list.slice(first, last + 1).map(copy)])])
  const slow = noted(at, ['{}', noted(at, [';', ...list.slice(first, last + 1)])])
  const out = noted(at, ['if', and(terms), fast, slow])
  out.elementRun = true
  return run.array ? [noted(at, ['const', held, noted(at, ['=', length, ['.', array, 'length']])]), out] : [out]
}

/** Whether some statement list of the program holds two accesses of one array at names in one stretch of plain statements: the summary is taken again only then. */
export function elementRunCandidates() {
  if (ctx.transform.optimize?.elementRuns === false) return false
  let found = false
  const lists = (node) => {
    if (found || !isArr(node) || node[0] == null || node[0] === 'str') return
    if (node[0] === ';') {
      let seen = null
      for (let i = 1; i < node.length && !found; i++) {
        if (!plain(node[i])) { seen = null; continue }
        for (const { node: n } of accesses(node[i], [])) {
          if (typeof n[2] !== 'string' || !path(n[1])) continue
          const key = nodeKey(n[1])
          if ((seen ??= new Set()).has(key)) found = true; else seen.add(key)
        }
      }
    }
    for (let i = 1; i < node.length; i++) lists(node[i])
  }
  for (const f of ctx.funcs.list) if (!f.raw && f.body != null) lists(f.body)
  return found
}

/** Write every run of element accesses under its guard; whether any was. */
export function guardElementRuns() {
  if (ctx.transform.optimize?.elementRuns === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    const view = ctx.summary?.at(func.sig)
    if (!view) continue
    let made = 0, held = null
    const lists = (node) => {
      if (!isArr(node) || node[0] == null || node[0] === 'str' || node[0] === '=>' || node.elementRun || node.cold) return
      if (node[0] === ';') {
        for (let i = 1; i < node.length; i++) {
          if (!plain(node[i])) continue
          let to = i
          while (to + 1 < node.length && plain(node[to + 1])) to++
          // (the accesses a canonical loop holds inside the length: found once, where a function has a stretch to ask of)
          if (held === null) { held = new Set(); scanBoundedArrIdx(func.body, null, null, held, view) }
          const run = to > i || accesses(node[i], []).length > 1 ? runIn(node, i, to, view, held) : null
          if (!run) { i = to; continue }
          const put = guarded(node, run)
          node.splice(run.first, run.last - run.first + 1, ...put)
          made++
          i = run.first + put.length - 1   // the statements after the run, in turn
        }
      }
      for (let i = 1; i < node.length; i++) lists(node[i])
    }
    lists(func.body)
    if (!made) continue
    invalidateProgramFactsCache(func.body)
    invalidateBodies([func.body])
    changed = true
  }
  return changed
}
