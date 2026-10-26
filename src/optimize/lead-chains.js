/**
 * A loop body that is a run of arithmetic statements computes the chain through
 * it a few links ahead of the work that hangs off it (speed tier, after watr):
 *
 *   y0 = b0*x + z0;  z0 = b1*x - a1*y0 + z1;  z1 = b2*x - a2*y0
 *   y1 = b0'*y0 + z0'; z0' = …;               z1' = …
 *   y2 = …
 *     →
 *   y0 = …;  y1 = …;  y2 = …;  y3 = …;  z0 = …;  z1 = …;  y4 = …;  z0' = …;  z1' = …
 *
 * A filter cascade's output runs through every section in turn, each section's
 * state updates waiting on its output but nothing waiting on them until the next
 * sample. A core issues the oldest ready work first: written section by section,
 * the next section's output waits behind the state updates of the one before,
 * and the chain, the iteration's critical path, stalls behind work with slack.
 * Second-order sections in their library form (sosfilter) ran 0.89x their time
 * on an AMD Zen 5, 0.95x on a Zen 3 and a Zen 4, 0.90-0.92x on Intel Xeons,
 * with the outputs three sections ahead (four: 0.89x, 0.98x on a Zen 3).
 *
 * The spine is the run's longest chain of statements by latency; what a link
 * needs goes just before it, and the work hanging off link k (reading it, needed
 * by no later link) goes after link k + LEAD, in the order written, but for a
 * store, which goes right after link k: nothing waits on it, and it retires. A run of at
 * least MIN_LINKS links with work of WEIGHT cycles left behind is rewritten; a
 * chain whose side work feeds its next links (an integrator's stages) has
 * nothing hanging and stays as written. A local written more than once in the
 * run takes a fresh name for each write but its last, and a tee nested in a
 * statement becomes a statement of its own, so each value is one statement.
 * Loads keep their order with the run's stores; a run holding a call, a branch,
 * a trap or a global write is left as written.
 *
 * @module optimize/lead-chains
 */

import { clone } from './vectorize/access.js'

const isArr = Array.isArray
// the links a chain runs ahead of the work hanging off it
const LEAD = 3
// the links a chain must have, the cycles of a hanging statement worth moving, the statements of a run
const MIN_LINKS = 8, WEIGHT = 6, MIN_RUN = 12
const LOAD = /^(?:i32|i64|f32|f64)\.load(?:8|16|32)?(?:_[su])?$/
const STORE = /^(?:i32|i64|f32|f64)\.store(?:8|16|32)?$/
const FIXED = /^(?:call|return|br|unreachable|throw|rethrow|global\.set|memory\.|table\.|block|loop|if|try|v128\.(?:load|store))|atomic|^(?:i32|i64)\.(?:div|rem)_[su]$|^(?:i32|i64)\.trunc_f(?:32|64)_[su]$/
const SLOW = /^f(?:32|64)\.(?:div|sqrt)$/

const walk = (n, f) => { if (!isArr(n)) return; f(n); for (let i = 1; i < n.length; i++) walk(n[i], f) }
const writes = (c) => (c[0] === 'local.set' || c[0] === 'local.tee') && typeof c[1] === 'string'

/** The cycles from a statement's operands to its value (a coarse x64 table). */
const latency = (n) => {
  if (!isArr(n) || typeof n[0] !== 'string') return 0
  let d = 0
  for (let i = 1; i < n.length; i++) { const c = latency(n[i]); if (c > d) d = c }
  const op = n[0]
  if (op === 'local.get' || op === 'local.set' || op === 'local.tee' || op.endsWith('.const')) return d
  if (LOAD.test(op)) return d + 5
  if (SLOW.test(op)) return d + 13
  if (op.startsWith('f64.') || op.startsWith('f32.') || op.endsWith('.mul')) return d + 3
  return d + 1
}

/** Whether every operation of a statement may move within the run. */
const movable = (s) => {
  if (!isArr(s) || !(s[0] === 'local.set' && s.length === 3 && typeof s[1] === 'string' || STORE.test(s[0]))) return false
  let ok = true
  walk(s, (c) => { if (typeof c[0] !== 'string' || FIXED.test(c[0])) ok = false })
  return ok
}

/**
 * Split each tee of statement `s` into a set before it, where nothing the
 * statement evaluates before the tee writes a local or reads the tee's.
 * Returns the statements, the set ones first.
 */
const splitTees = (s) => {
  const out = []
  for (let guard = 0; guard < 64; guard++) {
    // the first tee in evaluation order, with what was evaluated before it
    let found = null
    const seen = []
    const visit = (n, parent, idx) => {
      if (found || !isArr(n)) return
      for (let i = 1; i < n.length; i++) visit(n[i], n, i)
      if (found) return
      if (n[0] === 'local.tee' && n !== s) { found = { n, parent, idx, before: seen.slice() }; return }
      seen.push(n)
    }
    if (s[0] === 'local.set') visit(s[2], s, 2)
    else for (let i = 1; i < s.length; i++) visit(s[i], s, i)
    if (!found) break
    const x = found.n[1]
    // what ran before it must neither write a local nor read this one
    if (found.before.some(b => writes(b) || b[0] === 'local.get' && b[1] === x)) break
    out.push(['local.set', x, found.n[2]])
    found.parent[found.idx] = ['local.get', x]
  }
  out.push(s)
  return out
}

/** Schedule the statements of a loop's run; returns the new statements, or null to keep the run. */
const schedule = (run, fresh, types) => {
  // one value per statement: tees split out, each repeated write but the last renamed
  let stmts = []
  for (const s of run) stmts.push(...splitTees(clone(s)))
  if (stmts.some(s => s[0] === 'local.set' && !types.has(s[1]))) return null
  const last = new Map()
  for (let i = 0; i < stmts.length; i++) if (stmts[i][0] === 'local.set') last.set(stmts[i][1], i)
  const cur = new Map()
  const renamed = stmts.map((s, i) => {
    const r = clone(s)
    const sub = (n) => {
      if (!isArr(n)) return
      if (n[0] === 'local.get' && cur.has(n[1])) n[1] = cur.get(n[1])
      for (let k = 1; k < n.length; k++) sub(n[k])
    }
    if (r[0] === 'local.set') {
      sub(r[2])
      const x = r[1]
      if (last.get(x) !== i) { const y = fresh(x); cur.set(x, y); r[1] = y }
      else cur.delete(x)
    } else sub(r)
    return r
  })
  stmts = renamed
  const n = stmts.length
  // dependences: a value's reads after its write, the last write of a name after the
  // reads of the value it replaces, and memory in order around every store
  const defOf = new Map(), preds = stmts.map(() => new Set())
  const liveReads = new Map()   // name → statements reading its incoming value
  let lastStore = -1
  const loads = []
  for (let i = 0; i < n; i++) {
    const s = stmts[i]
    const rhs = s[0] === 'local.set' ? s[2] : s
    let isLoad = false
    walk(rhs, (c) => {
      if (c[0] === 'local.get') {
        if (defOf.has(c[1])) preds[i].add(defOf.get(c[1]))
        else { let l = liveReads.get(c[1]); if (!l) liveReads.set(c[1], l = []); l.push(i) }
      } else if (LOAD.test(c[0])) isLoad = true
    })
    if (STORE.test(s[0])) {
      if (lastStore >= 0) preds[i].add(lastStore)
      for (const l of loads) preds[i].add(l)
      lastStore = i
    } else if (isLoad && lastStore >= 0) preds[i].add(lastStore)
    if (isLoad) loads.push(i)
    if (s[0] === 'local.set') {
      for (const r of liveReads.get(s[1]) ?? []) if (r !== i) preds[i].add(r)
      defOf.set(s[1], i)
    }
  }
  const succs = stmts.map(() => [])
  for (let i = 0; i < n; i++) for (const p of preds[i]) succs[p].push(i)
  const height = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) { let h = 0; for (const j of succs[i]) if (height[j] > h) h = height[j]; height[i] = latency(stmts[i]) + h }
  // the spine: the run's longest chain of statements, by latency
  const spine = []
  let top = 0
  for (let i = 1; i < n; i++) if (height[i] > height[top]) top = i
  for (let s = top; s >= 0;) {
    spine.push(s)
    let next = -1
    for (const j of succs[s]) if (next < 0 || height[j] > height[next]) next = j
    s = next
  }
  if (spine.length < MIN_LINKS) return null
  const link = new Map(spine.map((s, k) => [s, k]))
  // what a link needs before it: the first link each statement leads to
  const need = new Array(n).fill(Infinity)
  for (let k = spine.length - 1; k >= 0; k--) {
    const stack = [...preds[spine[k]]]
    while (stack.length) { const p = stack.pop(); if (link.has(p) || need[p] <= k) continue; need[p] = k; stack.push(...preds[p]) }
  }
  // the work hanging off the spine: the last link it reads (edges run forward, so preds come first)
  const stage = new Array(n).fill(-1)
  for (let i = 0; i < n; i++) for (const p of preds[i]) stage[i] = Math.max(stage[i], link.has(p) ? link.get(p) : stage[p])
  // each link after what it needs, the work of the link LEAD links back after it
  const placed = new Array(n).fill(false), order = []
  const place = (i) => { if (placed[i]) return; placed[i] = true; for (const p of [...preds[i]].sort((a, b) => a - b)) place(p); order.push(i) }
  const hangs = (i) => need[i] === Infinity && !link.has(i)
  for (let k = 0; k < spine.length; k++) {
    for (let i = 0; i < n; i++) if (need[i] === k) place(i)
    place(spine[k])
    // a store hanging off the link goes right after it: it has nothing to wait for, and retires
    for (let i = 0; i < n; i++) if (hangs(i) && stage[i] === k && STORE.test(stmts[i][0])) place(i)
    if (k >= LEAD) for (let i = 0; i < n; i++) if (hangs(i) && stage[i] === k - LEAD) place(i)
  }
  for (let i = 0; i < n; i++) place(i)
  // worth it only where work of some weight now waits behind a link it preceded
  const pos = new Array(n)
  order.forEach((i, k) => { pos[i] = k })
  const led = order.some(i => hangs(i) && latency(stmts[i]) >= WEIGHT &&
    spine.some(s => s > i && pos[s] < pos[i]))
  if (!led) return null
  return order.map(i => stmts[i])
}

/** Lead the chains of every loop of function `fn` whose body is one run. */
const leadFunc = (fn) => {
  const names = new Set(), decls = [], types = new Map()
  walk(fn, (c) => { if (typeof c[1] === 'string' && c[1][0] === '$') names.add(c[1]) })
  for (const c of fn) if (isArr(c) && (c[0] === 'local' || c[0] === 'param') && typeof c[1] === 'string' && typeof c[2] === 'string') types.set(c[1], c[2])
  let uid = 0, pending = []
  const fresh = (x) => { let s = `${x}$l${uid++}`; while (names.has(s)) s = `${x}$l${uid++}`; names.add(s); pending.push(['local', s, types.get(x)]); return s }
  walk(fn, (L) => {
    if (L[0] !== 'loop') return
    let i = 1
    while (i < L.length && (!isArr(L[i]) || L[i][0] === 'result' || L[i][0] === 'param' || L[i][0] === 'type')) i++
    // the run: every statement up to a closing branch back
    let end = L.length
    const tail = L[end - 1]
    if (isArr(tail) && (tail[0] === 'br_if' || tail[0] === 'br')) end--
    const run = L.slice(i, end)
    if (run.length < MIN_RUN || !run.every(movable)) return
    pending = []
    const out = schedule(run, fresh, types)
    if (!out) return
    L.splice(i, end - i, ...out)
    decls.push(...pending)
  })
  if (decls.length) {
    let at = 2
    while (at < fn.length && isArr(fn[at]) && (fn[at][0] === 'param' || fn[at][0] === 'result' || fn[at][0] === 'local' || fn[at][0] === 'export' || fn[at][0] === 'type')) at++
    fn.splice(at, 0, ...decls)
  }
}

/** Lead the chains of the loops of `ast` (a module). */
export function leadChains(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) if (isArr(fn) && fn[0] === 'func') leadFunc(fn)
  return ast
}
