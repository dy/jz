/**
 * Tests of one shape joined by `|` or `&` run two to a vector (speed tier,
 * after watr):
 *
 *   (i32.or (i32.or (f64.lt (f64.add (f64.mul a0 x) c0) r) (f64.lt (f64.add (f64.mul a1 x) c1) r)) …)
 *
 * becomes `(v128.any_true (v128.or (f64x2.lt (f64x2.add (f64x2.mul A01 X) C01) R) …))`, A01 the
 * lanes a0 and a1, X the splat of x. A frustum's six plane tests of each sphere it culls
 * (plan/exit-tests.js writes them out, optimize/still-loads.js reads the planes ahead of the
 * loop): `n·c + d < -r` six times, the same operators over the planes' values beside the
 * sphere's own. Each pair of tests is one vector computation of its tree, the leaves that
 * differ between the pair its lanes, the leaves they share a splat; what a leaf of each lane
 * reads, where the loop around it writes neither, is packed once before the loop. The lanes
 * compute what the scalars did, operator by operator, in the same order: the same numbers,
 * NaNs and signed zeros. `any_true` of the masks joined by `v128.or` is the `|` of the
 * tests, `all_true` of those joined by `v128.and` the `&`; a test left without a pair joins
 * the result as a scalar.
 *
 * A tree takes the vectors where it holds four tests at least, every one a comparison of
 * floats over float arithmetic (`add`, `sub`, `mul`, `div`, `min`, `max`, the rounding and
 * sign operators), each pair the same operators at the same places; a leaf is a read of a
 * local, a literal, a global or any float the tree computes otherwise (a load), and nothing
 * in the tree writes memory, calls, branches or sets a local but the leaves both lanes share
 * (its tee goes with the splat) and locals nothing reads after the tree (src/optimize/
 * liveness.js). The vectors must cost fewer operators than the scalars did, the splats and
 * the lanes packed every round counted. Without SIMD (`optimize: { simd: false }`) the tests
 * stay scalar.
 *
 * @module optimize/pair-tests
 */
import { liveSeq } from './liveness.js'

const isArr = Array.isArray
// (sets, not patterns: the compiler compiles itself, and its source keeps to plain string tests)
const LISTS = new Set(['func', 'block', 'loop', 'then', 'else'])
const TESTS = new Set(['f64.lt', 'f64.gt', 'f64.le', 'f64.ge', 'f64.eq', 'f64.ne'])
const LANEWISE = new Set(['f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.min', 'f64.max',
  'f64.neg', 'f64.abs', 'f64.sqrt', 'f64.ceil', 'f64.floor', 'f64.trunc', 'f64.nearest', ...TESTS])
const JOINS = { 'i32.or': ['v128.or', 'v128.any_true'], 'i32.and': ['v128.and', 'i64x2.all_true'] }
const BARRIERS = new Set(['call', 'call_indirect', 'call_ref', 'return_call', 'return_call_indirect', 'return_call_ref', 'global.set', 'local.set',
  'br', 'br_if', 'br_table', 'return', 'unreachable', 'throw', 'block', 'loop', 'if', 'try', 'try_table'])
const HEADER = new Set(['export', 'param', 'result', 'local', 'type'])
/** The tests a tree holds at the least for its pairs to take vectors. */
export const MIN_TESTS = 4

const some = (n, f) => isArr(n) && (f(n) || n.some((c, i) => i > 0 && some(c, f)))
const same = (a, b) => a === b || isArr(a) && isArr(b) && a.length === b.length && a.every((c, i) => same(c, b[i]))
const clone = (n) => isArr(n) ? n.map(clone) : n
const isMemWrite = (op) => typeof op === 'string' && (op.includes('.store') || op.startsWith('memory.') || op.includes('.atomic.') || op.startsWith('table.'))
const ops = (n) => { if (!isArr(n)) return 0; let s = n[0] === 'local.get' || n[0] === 'local.tee' || typeof n[0] === 'string' && n[0].endsWith('.const') ? 0 : 1; for (let i = 1; i < n.length; i++) s += ops(n[i]); return s }

/** The leaves of the `op` chain at `n`, in the order they evaluate. */
const leavesOf = (n, op, out = []) => {
  if (isArr(n) && n[0] === op && n.length === 3) { leavesOf(n[1], op, out); leavesOf(n[2], op, out) }
  else out.push(n)
  return out
}

/** Pair the tests of every function's joined comparisons in `ast` (a module) into vectors. */
export function pairTests(ast, { simd = true } = {}) {
  if (!isArr(ast) || !simd) return ast
  for (const fn of ast) {
    if (!isArr(fn) || fn[0] !== 'func' || !some(fn, n => n[0] === 'loop') || !some(fn, n => TESTS.has(n[0]))) continue
    const locals = new Map()
    for (const c of fn) if (isArr(c) && (c[0] === 'local' || c[0] === 'param') && typeof c[1] === 'string') locals.set(c[1], c[2])
    // the joins of tests: [node, parent, index, statement, statement list, its index, the loops around]
    const found = []
    const walk = (n, stmt, list, at, loops) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        const s = LISTS.has(n[0]) ? c : stmt, l = LISTS.has(n[0]) ? n : list, k = LISTS.has(n[0]) ? i : at
        if (JOINS[c[0]] && loops.length && s) {
          const leaves = leavesOf(c, c[0])
          if (leaves.length >= MIN_TESTS && leaves.every(t => isArr(t) && TESTS.has(t[0]))) { found.push([c, n, i, s, l, k, loops]); continue }
        }
        walk(c, s, l, k, c[0] === 'loop' ? [...loops, [c, n]] : loops)
      }
    }
    walk(fn, null, null, 0, [])
    if (!found.length) continue
    // what is live past each statement holding a join (a tee nothing reads after it may go)
    const past = new Map(found.map(f => [f[3], null]))
    let body = 1
    for (let i = 1; i < fn.length; i++) if (isArr(fn[i]) && HEADER.has(fn[i][0])) body = i + 1
    liveSeq(['func', ...fn.slice(body)], new Set(), new Map(), new Map(), past)
    let id = 0
    const decls = [], hoists = new Map()   // loop → the packs set before it
    const fresh = () => { let name = `$__lanes${id++}`; while (locals.has(name)) name = `$__lanes${id++}`; locals.set(name, 'v128'); decls.push(['local', name, 'v128']); return name }
    for (const [join, parent, index, stmt, , , loops] of found) {
      const out = pairJoin(join, stmt, past.get(stmt) ?? null, loops, fresh, hoists)
      if (out) parent[index] = out
    }
    // (each loop's packs, ahead of it in its statement list)
    for (const [loop, { parent, sets }] of hoists) {
      const at = parent.indexOf(loop)
      if (at >= 0) parent.splice(at, 0, ...sets)
    }
    if (decls.length) {
      let at = typeof fn[1] === 'string' ? 2 : 1
      while (at < fn.length && isArr(fn[at]) && HEADER.has(fn[at][0])) at++
      fn.splice(at, 0, ...decls)
    }
  }
  return ast
}

/** The vector form of `join` (a chain of `i32.or` or `i32.and` over tests), or null. */
function pairJoin(join, stmt, live, loops, fresh, hoists) {
  if (!live || some(join, n => BARRIERS.has(n[0]) || isMemWrite(n[0]))) return null
  const [vjoin, reduce] = JOINS[join[0]]
  const leaves = leavesOf(join, join[0])
  // a tee is dead where nothing past the statement reads it and the statement reads it nowhere else
  const reads = new Map()
  some(stmt, n => { if (n[0] === 'local.get' && typeof n[1] === 'string') reads.set(n[1], (reads.get(n[1]) ?? 0) + 1); return false })
  const dead = (t) => !live.has(t) && !reads.has(t)
  // the loop the join's lanes are packed ahead of: the innermost around it, where it writes neither local
  const [loop, loopParent] = loops[loops.length - 1]
  const written = new Set()
  some(loop, n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') written.add(n[1]); return false })
  // (packed ahead of the loop only from a statement list: a loop in an operand has no place before it)
  const ahead = LISTS.has(loopParent[0])
  const still = (e) => ahead && isArr(e) && (e[0] === 'f64.const' || e[0] === 'local.get' && typeof e[1] === 'string' && !written.has(e[1]))
  const splats = new Map()   // a shared leaf's key → its splat's local
  const packs = []           // the packs set before the loop
  let cost = 0
  // a leaf both lanes share, splatted once: the first with its tee, the rest its local
  const shared = (a) => {
    const key = a[0] === 'local.get' || a[0] === 'local.tee' ? 'L' + a[1] : JSON.stringify(a)
    if (splats.has(key)) return ['local.get', splats.get(key)]
    const name = fresh()
    splats.set(key, name)
    if (!(a[0] === 'f64.const' || a[0] === 'local.get' && !written.has(a[1]))) cost += 1
    return ['local.tee', name, ['f64x2.splat', clone(a)]]
  }
  const pack = (a, b) => {
    const v = ['f64x2.replace_lane', '1', ['f64x2.splat', clone(a)], clone(b)]
    if (still(a) && still(b)) { const name = fresh(); packs.push(['local.set', name, v]); return ['local.get', name] }
    cost += 2
    return v
  }
  // the vector of `a` (lane 0) beside `b` (lane 1), or null
  const lanes = (a, b) => {
    if (!isArr(a) || !isArr(b)) return null
    if (a[0] === 'local.tee' && b[0] === 'local.get' && a[1] === b[1] || same(a, b) && !some(a, n => n[0] === 'local.tee')) return shared(a)
    if (a[0] === 'local.tee') return dead(a[1]) ? lanes(a[2], b) : null
    if (b[0] === 'local.tee') return dead(b[1]) ? lanes(a, b[2]) : null
    if (a[0] === b[0] && LANEWISE.has(a[0]) && a.length === b.length) {
      const kids = []
      for (let i = 1; i < a.length; i++) { const v = lanes(a[i], b[i]); if (!v) return null; kids.push(v) }
      cost += 1
      return ['f64x2.' + a[0].slice(4), ...kids]
    }
    // two leaves: a float each lane computes its own way
    if (some(a, n => n[0] === 'local.tee') || some(b, n => n[0] === 'local.tee')) return null
    return pack(a, b)
  }
  const masks = []
  for (let k = 0; k + 1 < leaves.length; k += 2) {
    if (leaves[k][0] !== leaves[k + 1][0]) return null
    const v = lanes(leaves[k], leaves[k + 1])
    if (!v) return null
    masks.push(v)
  }
  cost += masks.length + 1
  const scalar = leaves.reduce((s, t) => s + ops(t), 0) + leaves.length - 1
  if (cost >= scalar) return null
  let out = [reduce, masks.reduce((a, b) => [vjoin, a, b])]
  if (leaves.length % 2) out = [join[0], out, leaves[leaves.length - 1]]
  if (packs.length) {
    const h = hoists.get(loop) ?? { parent: loopParent, sets: [] }
    h.sets.push(...packs)
    hoists.set(loop, h)
  }
  return out
}
