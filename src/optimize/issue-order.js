/**
 * A loop body of floating-point arithmetic, whose operations no load, store, call or
 * branch separates, is written in the order that issues its dependence chain soonest
 * (speed tier, after watr): a Runge-Kutta step, a recurrence of several state values.
 *
 * V8 emits the operations of such a body in the order the module writes them. An AMD
 * Zen 3 or Zen 4 core assigns each floating-point operation to one of two scheduling
 * queues as it dispatches it, the emptier one; each queue issues to its own multiply
 * pipe and its own add pipe. An operation of the chain that becomes ready behind
 * another of its class in its own queue waits a cycle while the other queue's pipe
 * sits idle, and a cycle of the chain is a cycle of the loop. The order of the
 * operations decides the queues; an Intel Xeon binds each to one of its two
 * floating-point ports as it allocates it, alike. The Lorenz attractor's step (57
 * cycles of dependent 3-cycle operations) ran 59.6 cycles as written on an EPYC 7763,
 * 57.4 in the order deno's V8 gives its JavaScript, and 57.3 in the order this pass
 * picks: 3.7% less time there, 4.1% on a Zen 4 EPYC 9V74, 3.9% on a Zen 5 EPYC 9V45,
 * 1.0-1.4% on Xeons.
 *
 * Every operation becomes a statement of its own, the reads of a local written in the
 * run read the value of its latest write, and each local the run writes takes its last
 * value at the end. A few orders are candidates: the source's and decreasing height
 * (the latency from an operation to the end of the run), ties by earliest start or by
 * adds first, then source order either way. A model of each machine (dispatch six a
 * cycle into a 64-entry window, the emptier queue; issue the oldest ready operation:
 * on Zen, of each class from each queue, three cycles to an add, subtract or multiply;
 * on a Xeon, of either class from each port, four cycles) runs each over many
 * iterations, the values the run leaves feeding the next. The order that takes the
 * fewest cycles an iteration over the two replaces the source's where it is slower on
 * neither and saves 1% of them. An operation used only by the next one stays nested in
 * it. A run of fewer than MIN_OPS floating-point operations, or one with an operation
 * outside the set below, is left as written.
 *
 * @module optimize/issue-order
 */

const isArr = Array.isArray
// the floating-point operations of a run and their latencies (an EPYC 7763's): the
// multiply and the add pipes take the first two; the rest issue anywhere in a cycle
const MUL = new Set(['f64.mul']), ADD = new Set(['f64.add', 'f64.sub'])
const OTHER = { 'f64.div': 13, 'f64.sqrt': 15, 'f64.neg': 1, 'f64.abs': 1, 'f64.min': 1, 'f64.max': 1, 'f64.copysign': 1 }
const LEAF = /^(?:local\.get|global\.get|f64\.const)$/
// the operations a run needs before it is worth a schedule, the steps a model runs, the modelled share it must save
const MIN_OPS = 16, STEPS = 48, GAIN = 0.99

const latency = (op) => MUL.has(op) || ADD.has(op) ? 3 : OTHER[op]

/** The run's operations, one per value, or null where a statement is not one of them. */
const flatten = (stmts, types) => {
  const ops = [], cur = new Map()
  const flat = (n) => {
    if (!isArr(n) || typeof n[0] !== 'string') return null
    const op = n[0]
    if (LEAF.test(op)) return op === 'local.get' && cur.has(n[1]) ? { t: cur.get(n[1]) } : { leaf: n }
    if (op === 'local.tee') {
      const v = flat(n[2])
      if (!v || types.get(n[1]) !== 'f64') return null
      const t = v.t ?? push(['f64.copy', v])
      cur.set(n[1], t)
      return { t }
    }
    if (latency(op) == null) return null
    const args = []
    for (let i = 1; i < n.length; i++) { const a = flat(n[i]); if (!a) return null; args.push(a) }
    return { t: push([op, ...args]) }
  }
  const push = (node) => { ops.push(node); return ops.length - 1 }
  for (const s of stmts) {
    if (!isArr(s) || s[0] !== 'local.set' || types.get(s[1]) !== 'f64') return null
    const v = flat(s[2])
    if (!v) return null
    const t = v.t ?? push(['f64.copy', v])
    cur.set(s[1], t)
  }
  return { ops, cur }
}

/** Modelled cycles an iteration takes with the operations issued in `order` (`xeon`: one class, four cycles). */
const model = (ops, deps, carried, order, xeon) => {
  const N = ops.length, pos = []
  for (let p = 0; p < N; p++) pos[order[p]] = p
  const T = N * STEPS, done = [], queue = [], cls = [], lat = [], ins = []
  for (let it = 0; it < STEPS; it++) for (let p = 0; p < N; p++) {
    const k = order[p], g = it * N + p, op = ops[k][0]
    cls[g] = MUL.has(op) ? (xeon ? 1 : 0) : ADD.has(op) ? 1 : 2
    lat[g] = op === 'f64.copy' ? 0 : xeon && cls[g] === 1 ? 4 : latency(op)
    done[g] = Infinity
    const a = []
    for (const d of deps[k]) a.push(it * N + pos[d])
    if (it > 0) for (const d of carried[k]) a.push((it - 1) * N + pos[d])
    ins[g] = a
  }
  let next = 0, cycle = 0, win = []
  const size = [0, 0]
  while (next < T || win.length) {
    for (let d = 0; d < 6 && next < T && win.length < 64; d++) {
      if (cls[next] < 2) { const q = size[0] <= size[1] ? 0 : 1; queue[next] = q; size[q]++ }
      win.push(next++)
    }
    const used = [0, 0, 0, 0], keep = []
    for (const g of win) {
      let ready = true
      for (const j of ins[g]) if (done[j] > cycle) { ready = false; break }
      if (ready && cls[g] === 2) { done[g] = cycle + lat[g]; continue }
      const slot = cls[g] * 2 + queue[g]
      if (ready && !used[slot]) { used[slot] = 1; done[g] = cycle + lat[g]; size[queue[g]]--; continue }
      keep.push(g)
    }
    win = keep
    cycle++
  }
  const end = (it) => { let m = 0; for (let p = 0; p < N; p++) if (done[it * N + p] > m) m = done[it * N + p]; return m }
  const a = STEPS >> 1, b = STEPS - 1
  return (end(b) - end(a)) / (b - a)
}

/** The order the model prefers for a run's operations, or null to keep the source's. */
const pick = (ops, cur) => {
  const N = ops.length
  const deps = ops.map(n => n.slice(1).filter(a => a.t != null).map(a => a.t))
  // a read of a local the run writes is a read of its incoming value (flatten maps a read after
  // a write to the write's operation): the last write of the iteration before
  const carried = ops.map(n => {
    const c = []
    for (const a of n.slice(1)) if (a.leaf && a.leaf[0] === 'local.get' && cur.has(a.leaf[1])) c.push(cur.get(a.leaf[1]))
    return c
  })
  const lat = ops.map(n => n[0] === 'f64.copy' ? 0 : latency(n[0]))
  const succ = ops.map(() => [])
  deps.forEach((d, i) => { for (const p of d) succ[p].push(i) })
  const h = [], st = []
  for (let i = N - 1; i >= 0; i--) { let m = 0; for (const j of succ[i]) if (h[j] > m) m = h[j]; h[i] = lat[i] + m }
  for (let i = 0; i < N; i++) { let m = 0; for (const d of deps[i]) if (st[d] + lat[d] > m) m = st[d] + lat[d]; st[i] = m }
  const src = [], idx = []
  for (let i = 0; i < N; i++) { src.push(i); idx.push(i) }
  const add = (k) => ADD.has(ops[k][0]) ? 0 : 1
  const orders = [
    idx.slice().sort((a, b) => h[b] - h[a] || st[a] - st[b] || a - b),
    idx.slice().sort((a, b) => h[b] - h[a] || st[a] - st[b] || b - a),
    idx.slice().sort((a, b) => h[b] - h[a] || b - a),
    idx.slice().sort((a, b) => h[b] - h[a] || add(a) - add(b) || b - a),
  ]
  const zen0 = model(ops, deps, carried, src, false), xeon0 = model(ops, deps, carried, src, true)
  let best = null, cost = 2 * GAIN
  for (const o of orders) {
    const zen = model(ops, deps, carried, o, false) / zen0, xeon = model(ops, deps, carried, o, true) / xeon0
    if (zen <= 1 && xeon <= 1 && zen + xeon < cost) { cost = zen + xeon; best = o }
  }
  return best
}

/** Rewrite one loop's run in `order`; `fresh` names a new f64 local. */
const emit = (ops, cur, order, fresh) => {
  const N = ops.length, uses = new Array(N).fill(0)
  for (const n of ops) for (const a of n.slice(1)) if (a.t != null) uses[a.t]++
  // a value the run leaves in a local is used there too
  for (const t of cur.values()) uses[t]++
  const name = [], node = []
  const operand = (a) => a.t != null ? (node[a.t] ?? ['local.get', name[a.t]]) : a.leaf
  const out = []
  for (let p = 0; p < N; p++) {
    const k = order[p], n = ops[k]
    const v = n[0] === 'f64.copy' ? operand(n[1]) : [n[0], ...n.slice(1).map(operand)]
    // used once, by the next operation: nested in it (its operands are values already computed)
    const nextK = p + 1 < N ? order[p + 1] : -1
    if (uses[k] === 1 && nextK >= 0 && ops[nextK].slice(1).some(a => a.t === k)) { node[k] = v; continue }
    name[k] = fresh()
    out.push(['local.set', name[k], v])
  }
  for (const [x, t] of cur) out.push(['local.set', x, node[t] ?? ['local.get', name[t]]])
  return out
}

/** Order the runs of every loop of function `fn`. */
const orderFunc = (fn) => {
  const names = new Set(), types = new Map()
  const walk = (n, f) => { if (!isArr(n)) return; f(n); for (let i = 1; i < n.length; i++) walk(n[i], f) }
  walk(fn, (c) => { if (typeof c[1] === 'string' && c[1][0] === '$') names.add(c[1]) })
  for (const c of fn) if (isArr(c) && (c[0] === 'local' || c[0] === 'param') && typeof c[1] === 'string' && typeof c[2] === 'string') types.set(c[1], c[2])
  let uid = 0
  const decls = []
  const fresh = () => { let s = `$io${uid++}`; while (names.has(s)) s = `$io${uid++}`; names.add(s); decls.push(['local', s, 'f64']); return s }
  walk(fn, (L) => {
    if (L[0] !== 'loop') return
    let i = 1
    while (i < L.length && (!isArr(L[i]) || L[i][0] === 'result' || L[i][0] === 'param' || L[i][0] === 'type')) i++
    let end = L.length
    const tail = L[end - 1]
    if (isArr(tail) && (tail[0] === 'br_if' || tail[0] === 'br')) end--
    const run = L.slice(i, end)
    if (!run.length) return
    const f = flatten(run, types)
    if (!f) return
    let n = 0
    for (const o of f.ops) if (MUL.has(o[0]) || ADD.has(o[0])) n++
    if (n < MIN_OPS) return
    const order = pick(f.ops, f.cur)
    if (!order) return
    L.splice(i, end - i, ...emit(f.ops, f.cur, order, fresh))
  })
  if (decls.length) {
    let at = 2
    while (at < fn.length && isArr(fn[at]) && (fn[at][0] === 'param' || fn[at][0] === 'result' || fn[at][0] === 'local' || fn[at][0] === 'export' || fn[at][0] === 'type')) at++
    fn.splice(at, 0, ...decls)
  }
}

/** Order the floating-point runs of the loops of `ast` (a module). */
export function issueOrder(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) if (isArr(fn) && fn[0] === 'func') orderFunc(fn)
  return ast
}
