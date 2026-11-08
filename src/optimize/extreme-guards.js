/**
 * A loop's running minimum or maximum changes on few of its rounds: the round
 * that keeps it tests only that, and falls through to the latch (speed tier).
 *
 *   (loop $L … (local.set $m (f64.min (local.get $m) X)) … (br_if $L C))
 *
 * where nothing else in the loop writes m, becomes
 *
 *   (block $out
 *     (loop $again
 *       (block $take
 *         (loop $L … (local.set $v X) …
 *           (br_if $take (i32.eqz (f64.gt (local.get $v) (local.get $m))))
 *           (br_if $L C) (br $out)))
 *       (local.set $m (f64.min (local.get $m) (local.get $v)))
 *       (br_if $again C)))
 *
 * `Math.min` and `Math.max` are f64.min and f64.max: a NaN of either operand is
 * the result, and -0 orders below +0. V8 lowers each on x64 to a compare and
 * three branches around a move, one of them taken on every round, and on arm64
 * to an `fmin` the next round's waits for. `v > m` decides f64.min(m, v) = m
 * exactly (two Numbers, v the larger: no NaN, no tie of zeros), as `v < m`
 * decides the maximum. A bounding box's corners (three's Box3.setFromArray), a
 * peak, a radius change on almost no round once a few have passed, and the
 * test of each falls through: V8 keeps a loop's blocks together, so the code
 * that takes an extreme, placed after the loop, is off the round's way. There
 * it takes that extreme, tests and takes the ones after it, runs the latch and
 * enters the loop again. On an EPYC 9V74 three's Box3.setFromArray and
 * Sphere radius pass (bench/threegeom's bounds) ran 0.69× the time with its six
 * extremes so, 0.82× with each one's update an arm the round jumped over.
 *
 * A value canonicalized on its way to the local (the NaN select over a tee of
 * the extreme) is canonicalized where the extreme is taken: its temp is one
 * nothing but such selects reads, or one the loop reads only there and that is
 * live neither into the loop nor past it (src/optimize/liveness.js).
 *
 * Each extreme's operand is read where its statement stood, into a local of its
 * own (or is the local it reads, where the rest of the round leaves that alone),
 * and the extreme is taken at the end of the round: nothing after its statement
 * reads or writes it, no branch leaves the round or starts the next one from
 * there, and the latch reads none of the extremes. A loop with a value, a latch
 * whose test holds a construct, and a function that branches by depth keep their
 * shape; a loop takes at most MAX_EXTREMES so.
 *
 * @module optimize/extreme-guards
 */
import { liveSeq } from './liveness.js'

const isArr = Array.isArray
// (sets, not patterns: the compiler compiles itself, and its source keeps to plain string tests)
const LABELLED = new Set(['block', 'loop', 'if', 'try', 'try_table'])
const BRANCHES = new Set(['br', 'br_if', 'br_table'])
const LEAVES = new Set(['return', 'unreachable', 'throw', 'throw_ref', 'rethrow', 'delegate', 'try', 'try_table', 'return_call', 'return_call_indirect', 'return_call_ref'])
const EXTREMES = new Set(['f64.min', 'f64.max'])
const HEADER = new Set(['export', 'param', 'result', 'local', 'type'])
/** The extremes one loop takes so: each one's code after the loop tests the ones after it. */
export const MAX_EXTREMES = 8

const label = (n) => typeof n[1] === 'string' && n[1][0] === '$' ? n[1] : null
// (a construct carrying a type yields a value: out of scope)
const typed = (n) => n.some((c, i) => i > 0 && isArr(c) && (c[0] === 'result' || c[0] === 'param' || c[0] === 'type'))
const some = (n, f) => isArr(n) && (f(n) || n.some((c, i) => i > 0 && some(c, f)))
const get = (n, x) => isArr(n) && n[0] === 'local.get' && n.length === 2 && n[1] === x
const reads = (n, x) => some(n, m => m[0] === 'local.get' && m[1] === x)
const writes = (n, x) => some(n, m => (m[0] === 'local.set' || m[0] === 'local.tee') && m[1] === x)
const nanConst = (n) => isArr(n) && n[0] === 'f64.const' && n.length === 2 && String(n[1]) === 'nan'
const clone = (n) => isArr(n) ? n.map(clone) : n

/** `(select (f64.const nan) (local.tee $t E) (f64.ne (local.get $t) (local.get $t)))`: the temp, else null. */
const canonTemp = (n) => isArr(n) && n[0] === 'select' && n.length === 4 && nanConst(n[1]) && isArr(n[2]) && n[2][0] === 'local.tee' &&
  n[2].length === 3 && typeof n[2][1] === 'string' && isArr(n[3]) && n[3][0] === 'f64.ne' && n[3].length === 3 &&
  get(n[3][1], n[2][1]) && get(n[3][2], n[2][1]) ? n[2][1] : null

/** Statement `s` as an extreme `m = min|max(m, X)`, maybe through a canonicalization whose temp
 *  `movable` admits: { m, op, x, canon }, else null. */
const extremeOf = (s, movable) => {
  if (!isArr(s) || s[0] !== 'local.set' || s.length !== 3 || typeof s[1] !== 'string') return null
  const m = s[1]
  let e = s[2], canon = null
  const t = canonTemp(e)
  if (t) { if (!movable(t)) return null; canon = e; e = e[2][2] }
  if (!isArr(e) || !EXTREMES.has(e[0]) || e.length !== 3) return null
  const x = get(e[1], m) ? e[2] : get(e[2], m) ? e[1] : null
  if (!x || reads(x, m) || writes(x, m)) return null
  return { m, op: e[0], x, canon }
}

/** Whether a branch in `n` leaves it (to a label no construct of `n` declares) or `n` leaves the function. */
const leaves = (n) => {
  const own = new Set()
  some(n, m => { if (LABELLED.has(m[0]) && label(m)) own.add(m[1]); return false })
  return some(n, m => LEAVES.has(m[0]) || BRANCHES.has(m[0]) && m.slice(1).some(c => typeof c === 'string' && !own.has(c)))
}

/** Take the extremes of `loop` (child `pos` of `parent`) after it, where a round's test says one changes. */
function guardLoop(loop, parent, pos, fresh, local, movable) {
  const L = label(loop)
  if (!L || typed(loop)) return
  const latch = loop[loop.length - 1]
  if (!isArr(latch) || latch[0] !== 'br_if' || latch.length !== 3 || latch[1] !== L || some(latch[2], n => LABELLED.has(n[0]))) return
  const end = loop.length - 1
  const found = []
  for (let i = 2; i < end; i++) {
    const r = extremeOf(loop[i], t => movable(t, loop))
    if (!r) continue
    // (a running extreme: its statement is the loop's one write of it)
    let count = 0
    some(loop, n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === r.m) count++; return false })
    if (count === 1) found.push({ ...r, at: i })
  }
  // (taken at the end of the round: nothing after its statement, the latch included, reads it)
  const taken = found.filter(r => !reads(latch[2], r.m) && loop.slice(r.at + 1, end).every((s, k) => {
    const other = found.find(o => o.at === r.at + 1 + k)
    return other ? !reads(other.x, r.m) : !reads(s, r.m) && !writes(s, r.m)
  })).slice(0, MAX_EXTREMES)
  if (!taken.length) return
  // (from the first extreme on, the round runs to its latch: nothing leaves it or starts the next)
  for (let j = taken[0].at; j < end; j++) if (leaves(loop[j])) return
  const keeps = [], takes = []
  for (const r of taken) {
    let v = r.x
    if (!(isArr(v) && v[0] === 'local.get' && v.length === 2 && typeof v[1] === 'string' &&
        !loop.slice(r.at + 1).some(s => writes(s, v[1])))) {
      const name = local()
      loop[r.at] = ['local.set', name, r.x]
      v = ['local.get', name]
    } else loop[r.at] = null
    keeps.push([r.op === 'f64.min' ? 'f64.gt' : 'f64.lt', v, ['local.get', r.m]])
    const value = [r.op, ['local.get', r.m], clone(v)]
    takes.push(['local.set', r.m, r.canon ? ['select', r.canon[1], ['local.tee', r.canon[2][1], value], r.canon[3]] : value])
  }
  // (the label that leaves the loop: its block's, where the loop ends one, else a block of its own)
  let out
  if (parent[0] === 'block' && pos === parent.length - 1 && label(parent) && !typed(parent)) out = parent[1]
  else { out = fresh('out'); parent[pos] = ['block', out, loop] }
  const again = fresh('again'), rares = taken.map(() => fresh('take'))
  const body = loop.slice(2, end).filter(s => s !== null)
  // each extreme's test leaves the loop where it fails, for code after it that takes the extreme,
  // tests and takes the ones after it, and runs the latch: the round that keeps every one falls through
  let list = [['loop', L, ...body, ...keeps.map((k, j) => ['br_if', rares[j], ['i32.eqz', k]]), clone(latch), ['br', out]]]
  for (let j = 0; j < taken.length; j++) {
    const rare = [clone(takes[j])]
    for (let q = j + 1; q < taken.length; q++) rare.push(['if', ['i32.eqz', clone(keeps[q])], ['then', clone(takes[q])]])
    rare.push(['br_if', again, clone(latch[2])])
    if (j < taken.length - 1) rare.push(['br', out])
    list = [['block', rares[j], ...list], ...rare]
  }
  loop.length = 0
  loop.push('loop', again, ...list)
}

/** Take the running extremes of every function's loops in `ast` (a module) where a round's test says one changes. */
export function guardExtremes(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) {
    if (!isArr(fn) || fn[0] !== 'func' || !some(fn, n => n[0] === 'loop') || !some(fn, n => EXTREMES.has(n[0]))) continue
    const labels = new Set(), locals = new Set(), tees = new Map(), gets = new Map()
    // (a branch by depth would reach another label once the loop is wrapped: such a function keeps its loops)
    let byDepth = false
    const collect = (n) => {
      if (!isArr(n)) return
      if (LABELLED.has(n[0]) && label(n)) labels.add(n[1])
      if ((n[0] === 'local' || n[0] === 'param') && typeof n[1] === 'string') locals.add(n[1])
      if (BRANCHES.has(n[0]) && n.slice(1).some(c => typeof c === 'number' || typeof c === 'string' && c[0] >= '0' && c[0] <= '9')) byDepth = true
      if (canonTemp(n)) tees.set(n[2][1], (tees.get(n[2][1]) ?? 0) + 1)
      if (n[0] === 'local.get' && typeof n[1] === 'string') gets.set(n[1], (gets.get(n[1]) ?? 0) + 1)
      for (const c of n) collect(c)
    }
    collect(fn)
    if (byDepth) continue
    // a canonicalization's temp nothing but its selects reads; else one the loop reads only there,
    // live neither into the loop nor past it (a temp the optimizer shares with code before the
    // loop: three's box corners)
    const canonOnly = new Set([...tees].filter(([t, k]) => gets.get(t) === 2 * k).map(([t]) => t))
    let lives = null
    const movable = (t, loop) => {
      if (canonOnly.has(t)) return true
      let inLoop = 0, selects = 0
      some(loop, n => { if (n[0] === 'local.get' && n[1] === t) inLoop++; if (canonTemp(n) === t) selects++; return false })
      if (inLoop !== 2 * selects) return false
      if (!lives) {
        const at = new Map(), past = new Map()
        some(fn, n => { if (n[0] === 'loop') { at.set(n, null); past.set(n, null) } return false })
        let body = 1
        for (let i = 1; i < fn.length; i++) if (isArr(fn[i]) && HEADER.has(fn[i][0])) body = i + 1
        liveSeq(['func', ...fn.slice(body)], new Set(), new Map(), at, past)
        lives = { at, past }
      }
      const into = lives.at.get(loop), after = lives.past.get(loop)
      return into != null && after != null && !into.has(t) && !after.has(t)
    }
    let id = 0, made = 0
    const fresh = (base) => {
      let name = `$${base}_x${id++}`
      while (labels.has(name)) name = `$${base}_x${id++}`
      labels.add(name)
      return name
    }
    const decls = []
    const local = () => {
      let name = `$__ex${made++}`
      while (locals.has(name)) name = `$__ex${made++}`
      locals.add(name)
      decls.push(['local', name, 'f64'])
      return name
    }
    // innermost first: an outer loop does not look inside its inner ones
    const walk = (n) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        walk(c)
        if (c[0] === 'loop' && (n[0] === 'func' || n[0] === 'block' || n[0] === 'loop' || n[0] === 'then' || n[0] === 'else')) guardLoop(c, n, i, fresh, local, movable)
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
