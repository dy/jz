/**
 * A loop over items whose round opens with a gather, a read at an address read
 * from memory, and then searches, reads the next round's gather while this round
 * searches (speed tier, after watr):
 *
 *   (loop $L
 *     (block $B
 *       (br_if $B (i32.eq (local.tee $r (i32.load (… (local.tee $k (i32.load (local.get $p))) …))) EMPTY))
 *       (loop $S …))                                     ;; the search: a probe chain
 *     …
 *     (local.set $p (i32.add (local.get $p) (i32.const 4)))
 *     (br_if $L (i32.lt_s (local.tee $i (i32.add (local.get $i) (i32.const 1))) N)))
 *
 * becomes
 *
 *   (local.set $r' (i32.load (… (local.tee $k' (i32.load (local.get $p))) …)))   ;; the first round's, before the loop
 *   (loop $L
 *     (local.set $k (local.get $k')) (local.set $r (local.get $r'))
 *     (local.set $r' (i32.load (… (local.tee $k' (i32.load
 *       (select (i32.add (local.get $p) (i32.const 4)) (local.get $p)            ;; the next round's item, or this one's
 *         (i32.lt_s (i32.add (local.get $i) (i32.const 1)) N)))) …)))         ;; where no round follows
 *     (block $B (br_if $B (i32.eq (local.get $r) EMPTY)) (loop $S …))
 *     …)
 *
 * A hash join's probe side, a dictionary's lookups: each item hashes its key to a
 * slot and walks the chain from there. Where the chain ends is data, a branch the
 * core mispredicts about once an item, and the work after a mispredicted branch
 * is thrown away: the next item's key, its hash and its slot's read, a cache miss
 * once the table outgrows the first level, start only once the branch resolves.
 * Read a round ahead, the next slot is in flight before the search's branches,
 * and the misprediction no longer waits for it (the prefetching of a hash join's
 * probe, Chen, Ailamaki, Gibbons and Mowry, "Improving Hash Join Performance
 * through Prefetching", ICDE 2004).
 *
 * Exact. The gather E is the first thing the round evaluates past statements that
 * read no memory and cannot trap, and the loop neither stores, nor calls, nor
 * leaves but by its own test, so memory is the same from one round's start to the
 * next, and a round that starts reaches its test. E reads only locals the loop
 * never writes and its inductions, each written once a round after E, at the
 * body's top level or in the test (`local.tee`), by a step of itself and of names
 * the loop never writes, so the next round's E is E over each step. The test,
 * over the steps, says at the start of a round whether the next one runs: E reads
 * each induction's step where it does, the value the next round would read, and
 * the induction itself where it does not, this round's E again, whose reads the
 * round made already, its value read by nothing. A select, not a branch: a branch
 * around the read gave each of its values a move on either arm. Each local E
 * writes takes its value where E stood, as the round begins.
 *
 * Declined: a body that stores, calls, branches out of the loop or back to it but
 * by its test; a gather with no read of a read, or one past MAX_NODES; a round
 * with no loop after its gather; a branch by depth.
 *
 * @module optimize/lead-gathers
 */

const isArr = Array.isArray
const MAX_NODES = 48   // nodes of a gather read a round ahead at most
// (sets, not patterns: the compiler compiles itself, and its source keeps to plain string tests)
const BRANCH = new Set(['br', 'br_if', 'br_table'])
const LABELED = new Set(['block', 'loop', 'if', 'try', 'try_table'])
const LISTS = new Set(['block', 'loop', 'then', 'else', 'func'])
const COMPARE = new Set(['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u', 'lt', 'gt', 'le', 'ge', 'eqz'])
const HEAD = new Set(['export', 'import', 'type', 'param', 'result', 'local'])

const label = (n) => typeof n[1] === 'string' && n[1][0] === '$' ? n[1] : null
const typed = (n) => n.slice(2, 4).some(c => isArr(c) && (c[0] === 'result' || c[0] === 'param' || c[0] === 'type'))
const has = (n, pred) => isArr(n) && (pred(n) || n.some(c => has(c, pred)))
const copy = (n) => isArr(n) ? n.map(copy) : n
const size = (n) => isArr(n) ? n.reduce((s, c) => s + size(c), 1) : 0
const g = (x) => ['local.get', x]
const op = (n) => isArr(n) && typeof n[0] === 'string' ? n[0] : ''
const isLoad = (n) => { const o = op(n); return o.indexOf('.load') > 0 && !o.startsWith('v128') && o.indexOf('atomic') < 0 }
const isStore = (n) => { const o = op(n); return o.indexOf('.store') > 0 || o.indexOf('atomic') >= 0 || o.startsWith('memory.') || o.startsWith('table.') }
const isWrite = (n) => (op(n) === 'local.set' || op(n) === 'local.tee') && typeof n[1] === 'string'
/** What may trap besides a load: a division, a float truncation, an explicit trap. */
const traps = (n) => {
  const o = op(n)
  return o.indexOf('.div_') > 0 || o.indexOf('.rem_') > 0 || o.indexOf('.trunc_f') > 0 && o.indexOf('_sat_') < 0 || o === 'unreachable'
}
/** Plain: no branch, no call, no store, no nested control. */
const plain = (n) => !has(n, c => { const o = op(c)
  return BRANCH.has(o) || LABELED.has(o) || o.startsWith('call') || o.startsWith('return') || o.startsWith('throw') || o === 'rethrow' || isStore(c) || o === 'select' && c.length > 4 })

/** The wasm type of value node `n`, given the function's local types, or null. */
const typeOf = (n, types) => {
  const o = op(n)
  if (o === 'local.tee' || o === 'local.get') return types.get(n[1]) ?? null
  const dot = o.indexOf('.')
  if (dot < 0) return null
  const t = o.slice(0, dot), rest = o.slice(dot + 1)
  if (t !== 'i32' && t !== 'i64' && t !== 'f32' && t !== 'f64') return null
  return COMPARE.has(rest) ? 'i32' : t
}

/**
 * The gather of statement `s`: the outermost value its round evaluates first that is
 * a local.tee or a load. Returns { node, parent, at } or null.
 */
const firstValue = (s) => {
  // past a structured node's label and type
  const inner = (n) => { let at = label(n) ? 2 : 1; while (at < n.length && isArr(n[at]) && (n[at][0] === 'result' || n[at][0] === 'type')) at++; return at }
  let n = s
  for (let guard = 0; guard < 64 && isArr(n); guard++) {
    const o = op(n)
    let at = -1
    if (o === 'block' || o === 'if') at = inner(n)
    else if (o === 'br_if') { if (n.length !== 3) return null; at = 2 }   // (a branch carrying a value evaluates it first)
    else if (o === 'local.set' || o === 'drop') at = n.length - 1
    else if (o === 'loop' || o === 'local.get' || o.endsWith('.const')) return null
    else if (o.indexOf('.') > 0) {
      // an operator: its first operand runs first
      at = 1
      while (at < n.length && !isArr(n[at])) at++
    } else return null
    if (at < 0 || at >= n.length || !isArr(n[at])) return null
    const c = n[at]
    if (op(c) === 'local.tee' || isLoad(c)) return { node: c, parent: n, at }
    n = c
  }
  return null
}

/** Whether `e` reads an address that is itself read from memory. */
const gathers = (e) => has(e, n => isLoad(n) && has(n.slice(1), isLoad))

/** Rewrite the gathering loops of function `fn`. */
const rewriteFunc = (fn) => {
  // a branch by depth names no label: the loop's exits could not be checked
  if (has(fn, n => BRANCH.has(n[0]) && n.slice(1).some(c => typeof c === 'number' || typeof c === 'string' && c[0] >= '0' && c[0] <= '9'))) return
  const types = new Map()
  for (const n of fn) if (isArr(n) && (n[0] === 'param' || n[0] === 'local') && typeof n[1] === 'string' && n[1][0] === '$' && typeof n[2] === 'string') types.set(n[1], n[2])
  const taken = new Set()
  const collect = (n) => { if (!isArr(n)) return; for (const c of n) if (typeof c === 'string' && c[0] === '$') taken.add(c); else collect(c) }
  collect(fn)
  let uid = 0
  const fresh = (t) => { let s = `$__lg${uid++}`; while (taken.has(s)) s = `$__lg${uid++}`; taken.add(s); locals.push([s, t]); return s }
  const locals = []

  // the plan for loop L, or null
  const plan = (L) => {
    const lab = label(L)
    if (!lab || typed(L)) return null
    const S = L.slice(2), back = S[S.length - 1]
    if (!isArr(back) || back[0] !== 'br_if' || back.length !== 3 || back[1] !== lab || !plain(back[2]) || has(back[2], traps)) return null
    const body = S.slice(0, -1)
    // no store, call or exit but by the test; no branch back but the test
    const inside = new Set()
    const defs = (n) => { if (!isArr(n)) return; if (LABELED.has(n[0]) && label(n)) inside.add(n[1]); for (const c of n) defs(c) }
    for (const s of body) defs(s)
    const leaves = (n) => {
      const o = op(n)
      if (isStore(n) || o.startsWith('call') || o.startsWith('return') || o.startsWith('throw') || o === 'rethrow' || o === 'try' || o === 'try_table' || o === 'delegate') return true
      return BRANCH.has(o) && n.slice(1).some(c => typeof c === 'string' && c[0] === '$' && !inside.has(c))
    }
    if (body.some(s => has(s, leaves))) return null
    // the round's search: the first statement with a loop; those before it read no memory and cannot trap
    let k = 0
    while (k < body.length && !has(body[k], n => n[0] === 'loop')) k++
    if (k === body.length) return null
    for (let j = 0; j < k; j++) if (!plain(body[j]) || has(body[j], n => isLoad(n) || traps(n))) return null
    const first = firstValue(body[k])
    if (!first) return null
    const E = first.node
    if (size(E) > MAX_NODES || !plain(E) || has(E, traps) || !gathers(E)) return null
    // the locals L writes, and how often
    const writes = new Map()
    const census = (n) => { if (!isArr(n)) return; if (isWrite(n)) writes.set(n[1], (writes.get(n[1]) || 0) + 1); for (const c of n) census(c) }
    for (const s of S) census(s)
    const invariant = (x) => !writes.has(x)
    // an induction: written once, by a step of itself and of invariants, at the body's top
    // level after the gather's statement or in the test; its next value is that step
    const next = new Map()
    const stepOf = (x, V) => {
      if (!plain(V) || has(V, n => isLoad(n) || traps(n))) return null
      let ok = true
      has(V, n => { if (n[0] === 'local.get' && n[1] !== x && !invariant(n[1])) ok = false; return false })
      return ok ? V : null
    }
    for (let j = k + 1; j < body.length; j++) {
      const s = body[j]
      if (op(s) === 'local.set' && s.length === 3 && typeof s[1] === 'string' && writes.get(s[1]) === 1) {
        const V = stepOf(s[1], s[2])
        if (V) next.set(s[1], V)
      }
    }
    const tees = []
    has(back[2], n => { if (op(n) === 'local.tee') tees.push(n); return false })
    for (const t of tees) if (writes.get(t[1]) === 1) { const V = stepOf(t[1], t[2]); if (V) next.set(t[1], V) }
    // E reads invariants and inductions; the locals it writes, it does not read
    const written = new Set(), carried = []
    let ok = true
    const scan = (n) => {
      if (!isArr(n) || !ok) return
      for (let i = 1; i < n.length; i++) scan(n[i])
      if (n[0] === 'local.get' && !(invariant(n[1]) || next.has(n[1]))) ok = false
      if (n[0] === 'local.tee') {
        if (written.has(n[1]) || next.has(n[1]) || !types.has(n[1])) ok = false
        written.add(n[1]); carried.push(n[1])
      }
    }
    scan(E)
    if (!ok) return null
    if (has(E, n => n[0] === 'local.get' && written.has(n[1]))) return null
    // the test reads invariants, the inductions' steps, and a tee'd counter only in its own step
    let testOk = true
    const testScan = (n, own) => {
      if (!isArr(n) || !testOk) return
      if (n[0] === 'local.tee') { if (!next.has(n[1])) testOk = false; testScan(n[2], n[1]); return }
      if (n[0] === 'local.get' && n[1] !== own && !invariant(n[1]) && !(next.has(n[1]) && !tees.some(t => t[1] === n[1]))) testOk = false
      for (let i = 1; i < n.length; i++) testScan(n[i], own)
    }
    testScan(back[2], null)
    if (!testOk) return null
    const rootType = typeOf(E, types)
    if (!rootType) return null
    return { L, body, back, k, first, E, next, carried, rootType, tees }
  }

  // the loop with its gather read a round ahead, and the first round's gather before it
  const lead = ({ L, body, back, k, first, E, next, carried, rootType, tees }) => {
    const ahead = new Map(carried.map(x => [x, fresh(types.get(x))]))
    const root = op(E) === 'local.tee' ? null : fresh(rootType)   // a load's value, carried
    const now = root ? fresh(rootType) : null                       // ... and this round's copy of it
    // E over `step`: its tees write the carried locals, its inductions read `step(x)`
    const over = (n, step) => {
      if (!isArr(n)) return n
      if (n[0] === 'local.get' && next.has(n[1])) return step(n[1])
      if (n[0] === 'local.tee') return ['local.tee', ahead.get(n[1]), over(n[2], step)]
      return n.map(c => over(c, step))
    }
    const asSet = (e) => op(e) === 'local.tee' ? ['local.set', e[1], e[2]] : ['local.set', root, e]
    const here = asSet(over(E, x => g(x)))
    // whether the next round runs: the test over this round's steps
    const teed = new Set(tees.map(t => t[1]))
    const ahead1 = (n) => {
      if (!isArr(n)) return n
      if (n[0] === 'local.tee') return ahead1(n[2])
      if (n[0] === 'local.get' && next.has(n[1]) && !teed.has(n[1])) return copy(next.get(n[1]))
      return n.map(ahead1)
    }
    const runs = ahead1(back[2])
    // each induction its next value where the next round runs, its own where none does (the
    // round's own gather again, read already): no branch, and nothing past what the loop reads
    let reads = 0
    has(E, n => { if (n[0] === 'local.get' && next.has(n[1])) reads++; return false })
    const pre = [], test = reads > 1 ? fresh('i32') : null
    if (test) pre.push(['local.set', test, runs])
    const nextE = asSet(over(E, x => ['select', copy(next.get(x)), g(x), test ? g(test) : copy(runs)]))
    const copies = carried.map(x => ['local.set', x, g(ahead.get(x))])
    if (root) copies.push(['local.set', now, g(root)])
    first.parent[first.at] = g(root ? now : E[1])
    const head = L.slice(0, 2)
    const out = [...head, ...body.slice(0, k), ...copies, ...pre, nextE, ...body.slice(k), back]
    return [here, out]
  }

  // innermost first, each loop planned against its body as the source left it; a loop
  // holding one that reads ahead keeps its shape (its plan would read a body the other rewrites)
  const found = [], planned = new Set()
  const visit = (n) => {
    if (!isArr(n)) return
    for (let j = 1; j < n.length; j++) {
      const c = n[j]
      if (!isArr(c)) continue
      visit(c)
      if (c[0] !== 'loop' || !LISTS.has(n[0]) || has(c.slice(2), m => planned.has(m))) continue
      const P = plan(c)
      if (P) { found.push([n, P]); planned.add(c) }
    }
  }
  visit(fn)
  if (!found.length) return
  for (const [list, P] of found) {
    const at = list.indexOf(P.L)
    if (at < 0) continue
    const [here, loop] = lead(P)
    list.splice(at, 1, here, loop)
  }
  let head = 2
  while (head < fn.length && isArr(fn[head]) && HEAD.has(fn[head][0])) head++
  fn.splice(head, 0, ...locals.map(([x, t]) => ['local', x, t]))
}

/** Read each gathering loop's next gather a round ahead, in every function of `ast` (a module). */
export function leadGathers(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) if (isArr(fn) && fn[0] === 'func') rewriteFunc(fn)
  return ast
}
