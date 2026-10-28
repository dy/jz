/**
 * A receiver's forward hop, resolved once per loop.
 *
 *   for (let k = from; k < to; k++) dst.push(src[k * 2], src[k * 2 + 1])
 *
 * An element read of an array that may have grown first asks its header
 * whether the block moved (ir/pointers.js fwdOffsetIR, the element readers of
 * module/array.js): a load, a compare and a call the engine must allow for,
 * per read. A block moves only inside a call (every forward word is written
 * by the runtime's relocation, a shift or a compaction), so for a receiver
 * the loop never rebinds the hop answers the same between two calls that may
 * move a block. LICM takes it out of a loop that calls nothing and writes no
 * header (optimize/licm.js); a push in the loop does both (its length store,
 * its growth call), and every other receiver kept its hops: `src` above asked
 * twice a pass.
 *
 * Here the hop is a local of the loop, set before the loop and again right
 * after each call in it that may move a block: a read before that call in
 * evaluation order takes the answer of before, one after it the new one, as
 * the hops did. A hop reads its receiver through the copies a read makes of
 * it (`$av = $poly`, its low word in `$ao`, the forward word LICM hoisted);
 * the walk keeps what each local was last set to, while nothing it reads has
 * changed since, so a hop through them is one of `$poly`. The sets keep the
 * guards of `__ptr_offset_fwd` (an offset below 8 or past the memory is
 * answered as it is): a receiver that holds no array where the loop reads
 * none traps nowhere. The set before the loop tests in line and calls only
 * where the block moved; after a call that may move a block, a call more to
 * the chase is the cheap part.
 *
 * Runs once the loop compaction is in (optimize/loop-compact.js): a compacted
 * loop is re-entered through the block around it, where the set before the
 * loop stands, so a compaction's move is followed as a call's is. A loop with
 * a handler (a throw out of a call that moved a block would skip its set), an
 * indirect call, or a call that may move a block other than the runtime's cold
 * ones (a push's growth, the iteration's release) keeps its hops: a set after
 * each call of the program's own, or of a dynamic read's helper, cost more
 * bytes than it saved time (webaudio's tick loops grew 11 KB).
 *
 * @module optimize/forward-hops
 */
import { walkAst } from '../ast.js'
import { findBodyStart, nextLocalId } from '../ir.js'
import { isMemWrite } from 'watr/optimize'
import { LAYOUT } from '../ctx.js'
import { HEADER_STORE_FREE } from './licm.js'

const isArr = Array.isArray
const FWD = '$__ptr_offset_fwd'
const LISTS = new Set(['block', 'loop', 'then', 'else'])
const HANDLERS = new Set(['try', 'try_table', 'catch', 'catch_all', 'delegate'])
const LEAVES = new Set(['return_call', 'return_call_indirect', 'return_call_ref'])
const BOX = new Set(['f64', 'i64'])
// The runtime calls that move a block only on a loop's cold paths: a push's or
// an index store's growth, the iteration's release past its budget, a durable
// array's first save of a round.
const COLD = new Set(['$__arr_room', '$__arr_grow', '$__arr_grow_known', '$__arr_set_idx_ptr', '$__iter_release', '$__durable_arr_snap'])
const COPY = new Set(['i32.wrap_i64', 'i64.reinterpret_f64', 'f64.reinterpret_i64'])

const same = (a, b) => {
  if (!isArr(a) || !isArr(b)) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false
  return true
}
const isConst = (n, op, v) => isArr(n) && n.length === 2 && n[0] === op && String(n[1]) === String(v)
const isMask = (n) => isConst(n, 'i64.const', LAYOUT.OFFSET_MASK)
const isGet = (n) => isArr(n) && n.length === 2 && n[0] === 'local.get' && typeof n[1] === 'string'
const isSet = (n) => isArr(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string'
// A value a local's copy is kept of: a local read under the box's reinterpret
// and low-word steps, or the forward word below such a low word.
const copyOf = (v) => isArr(v) && (isGet(v) ||
  v.length === 2 && COPY.has(v[0]) && copyOf(v[1]) ||
  v.length === 3 && v[0] === 'i64.and' && isMask(v[2]) && copyOf(v[1]) ||
  v.length === 3 && v[0] === 'i32.sub' && isConst(v[2], 'i32.const', 4) && copyOf(v[1]))
const reads = (v, name) => {
  if (!isArr(v)) return false
  if (isGet(v)) return v[1] === name
  for (let i = 1; i < v.length; i++) if (reads(v[i], name)) return true
  return false
}

// The allocator moves the heap's top, no block; a throw helper never returns.
const stillByName = (callee) => callee.startsWith('$__alloc') || callee.startsWith('$__throw_')

/**
 * The functions that move no block, read off their bodies: no indirect call,
 * no store but an element's payload (a forward word is an `i32.store`, a
 * bulk copy may carry one), and calls only to the allocator or to functions
 * of the same kind, found by a fixpoint over the call graph. A global they
 * write is no block. An import may call back into the module: it moves.
 */
export function collectStillFuncs(funcs) {
  const facts = new Map()
  for (const fn of funcs) {
    if (!isArr(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') continue
    const calls = new Set()
    let ok = true
    walkAst(fn, { enter: n => {
      if (!ok) return false
      const op = n[0]
      if (op === 'call') { if (typeof n[1] === 'string') calls.add(n[1]); else ok = false }
      else if (op === 'call_indirect' || op === 'call_ref' || LEAVES.has(op)) ok = false
      else if (isMemWrite(op) && !HEADER_STORE_FREE.has(op)) ok = false
    } })
    facts.set(fn[1], { calls, ok })
  }
  const still = new Set()
  for (const [name, f] of facts) if (f.ok) still.add(name)
  for (let changed = true; changed;) {
    changed = false
    for (const name of [...still]) for (const c of facts.get(name).calls)
      if (!stillByName(c) && !still.has(c)) { still.delete(name); changed = true; break }
  }
  return still
}

/** The result types of every function the module defines or imports, by name. */
export function collectResults(funcs, imports) {
  const out = new Map()
  const resultsOf = (node) => {
    const r = []
    for (const c of node) if (isArr(c) && c[0] === 'result') for (let i = 1; i < c.length; i++) r.push(c[i])
    return r
  }
  for (const fn of funcs) if (isArr(fn) && fn[0] === 'func' && typeof fn[1] === 'string') out.set(fn[1], resultsOf(fn))
  for (const imp of imports ?? []) {
    if (!isArr(imp)) continue
    for (const c of imp) if (isArr(c) && c[0] === 'func' && typeof c[1] === 'string') out.set(c[1], resultsOf(c))
  }
  return out
}

/** Hoist the forward hops of each loop's unrebound receivers in `fn`. */
export function hoistForwardHops(fn, still, results) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const start = findBodyStart(fn)
  if (start < 0) return
  const types = new Map()
  for (let i = 2; i < start; i++) {
    const c = fn[i]
    if (isArr(c) && (c[0] === 'param' || c[0] === 'local') && typeof c[1] === 'string') types.set(c[1], c[2])
  }
  let id = nextLocalId(fn, 'fh')
  const locals = []
  const fresh = (type) => { const name = `$__fh${id++}`; locals.push(['local', name, type]); return name }
  const temps = new Map()   // a result type → the local a followed call parks its result in
  const temp = (type) => { if (!temps.has(type)) temps.set(type, fresh(type)); return temps.get(type) }
  const moves = (callee) => !(typeof callee === 'string' && (stillByName(callee) || still.has(callee)))
  const writtenOf = new Map()
  const written = (n) => {
    let out = writtenOf.get(n)
    if (!out) { out = new Set(); walkAst(n, { enter: c => { if (isSet(c)) out.add(c[1]) } }); writtenOf.set(n, out) }
    return out
  }

  // The receiver behind a box, an offset and a forward word, through the
  // copies `env` holds: the box local, or null.
  const boxRoot = (e, env, d) => {
    if (d > 16 || !isArr(e)) return null
    if (e.length === 2 && (e[0] === 'i64.reinterpret_f64' || e[0] === 'f64.reinterpret_i64')) return boxRoot(e[1], env, d + 1)
    if (!isGet(e)) return null
    const v = env.get(e[1])
    return v ? boxRoot(v, env, d + 1) : BOX.has(types.get(e[1])) ? e[1] : null
  }
  const offsetRoot = (e, env, d) => {
    if (d > 16 || !isArr(e)) return null
    if (e.length === 2 && e[0] === 'i32.wrap_i64') {
      const b = e[1]
      return boxRoot(isArr(b) && b.length === 3 && b[0] === 'i64.and' && isMask(b[2]) ? b[1] : b, env, d + 1)
    }
    const v = isGet(e) ? env.get(e[1]) : null
    return v ? offsetRoot(v, env, d + 1) : null
  }
  const wordRoot = (e, env, d) => {
    if (d > 16 || !isArr(e)) return null
    if (e.length === 3 && e[0] === 'i32.sub' && isConst(e[2], 'i32.const', 4)) return offsetRoot(e[1], env, d + 1)
    const v = isGet(e) ? env.get(e[1]) : null
    return v ? wordRoot(v, env, d + 1) : null
  }
  // The word test of a hop, `(i32.eq (i32.load A) (i32.const -1))`: A, or null.
  const testOf = (c) => {
    if (!isArr(c) || c.length !== 3 || c[0] !== 'i32.eq' || !isConst(c[2], 'i32.const', -1)) return null
    const load = c[1]
    return isArr(load) && load.length === 2 && load[0] === 'i32.load' ? load[1] : null
  }
  const isFwdOf = (call, arg) => isArr(call) && call.length === 3 && call[0] === 'call' && call[1] === FWD && same(call[2], arg)
  /** A hop at `n` and the receiver it resolves: { root } for the value form
   *  `(if (result i32) T (then (call fwd RAW)) (else RAW))`, { root, into } for
   *  the statement form `(if T (then (local.set $o (call fwd (local.get $o)))))`
   *  whose test tees `$o` the receiver's low word (or reads one set before). */
  const hopAt = (n, env) => {
    if (!isArr(n) || n[0] !== 'if') return null
    if (n.length === 5 && isConst(n[1], 'result', 'i32')) {
      const a = testOf(n[2]), then = n[3], els = n[4]
      if (!a || !isArr(then) || then.length !== 2 || then[0] !== 'then' || !isArr(els) || els.length !== 2 || els[0] !== 'else') return null
      if (!isFwdOf(then[1], els[1])) return null
      const root = offsetRoot(els[1], env, 0)
      return root && wordRoot(a, env, 0) === root ? { root, into: null } : null
    }
    if (n.length !== 3) return null
    const a = testOf(n[1]), then = n[2]
    if (!isArr(a) || a.length !== 3 || a[0] !== 'i32.sub' || !isConst(a[2], 'i32.const', 4)) return null
    if (!isArr(then) || then.length !== 2 || then[0] !== 'then') return null
    const set = then[1]
    if (!isArr(set) || set.length !== 3 || set[0] !== 'local.set' || typeof set[1] !== 'string') return null
    const o = set[1]
    if (!isFwdOf(set[2], ['local.get', o])) return null
    const t = a[1]
    const root = isArr(t) && t.length === 3 && t[0] === 'local.tee' && t[1] === o ? offsetRoot(t[2], env, 0)
      : isConst(t, 'local.get', o) ? offsetRoot(t, env, 0) : null
    return root ? { root, into: o } : null
  }

  // A local written: its copy and every copy that reads it go.
  const kill = (env, name) => {
    env.delete(name)
    const gone = []
    for (const [k, v] of env) if (reads(v, name)) gone.push(k)
    for (const k of gone) env.delete(k)
  }
  const killAll = (env, names) => { for (const name of names) kill(env, name) }

  // Whether the loop's hops pay to hoist: no handler, and every call that may
  // move a block one of the runtime's cold ones (COLD), so a set after a call
  // runs where the loop already paid a call it rarely makes. A loop that calls
  // the program's own code or reads through a dynamic helper keeps its hops:
  // there each set would follow a call of the pass, in bytes and in time.
  const followable = (loop) => {
    let ok = true
    walkAst(loop, { enter: n => {
      if (!ok) return false
      const op = n[0]
      if (HANDLERS.has(op) || op === 'call_indirect' || op === 'call_ref') ok = false
      else if (op === 'call' && moves(n[1]) && (!COLD.has(n[1]) || (results.get(n[1])?.length ?? 2) > 1)) ok = false
    } })
    return ok
  }

  const raw = (root) => ['i32.wrap_i64', types.get(root) === 'f64' ? ['i64.reinterpret_f64', ['local.get', root]] : ['local.get', root]]
  // After a call that may move a block: the chase, guards and all.
  const resolve = (root) => ['call', FWD, raw(root)]
  // Before a loop, entered as often as the code around it runs: the guards
  // and the forward word in line (layout.js followForwardingWat), the chase
  // called only where the block moved.
  const enter = (root) => ['if', ['result', 'i32'],
    ['i32.and', ['i32.ge_u', raw(root), ['i32.const', 8]], ['i64.le_u', ['i64.extend_i32_u', raw(root)], ['global.get', '$__heap_end64']]],
    ['then', ['if', ['result', 'i32'], ['i32.eq', ['i32.load', ['i32.sub', raw(root), ['i32.const', 4]]], ['i32.const', -1]],
      ['then', resolve(root)], ['else', raw(root)]]],
    ['else', raw(root)]]

  /**
   * The walk, in evaluation order. `env`: what each local holds a copy of
   * here. `active`: the hop locals of the loops around, { root, r }.
   * `found`: where set, the walk only collects the receivers of hops it meets.
   * Returns how many statements it put before parent[i].
   */
  const visit = (parent, i, env, active, found) => {
    const n = parent[i]
    if (!isArr(n)) return 0
    const hop = hopAt(n, env)
    if (hop) {
      if (found) { found.add(hop.root); return 0 }
      const g = active.find(g => g.root === hop.root)
      if (g) {
        if (hop.into) { parent[i] = ['local.set', hop.into, ['local.get', g.r]]; kill(env, hop.into) }
        else parent[i] = ['local.get', g.r]
        return 0
      }
    }
    const op = n[0]
    if (op === 'loop') {
      const inner = new Map(env)
      killAll(inner, written(n))
      const groups = []
      if (!found && (parent === fn || LISTS.has(parent[0])) && followable(n)) {
        const roots = new Set()
        visitList(n, 1, new Map(inner), [], roots)
        const w = written(n)
        for (const root of roots) if (!w.has(root) && !active.some(g => g.root === root)) groups.push({ root, r: fresh('i32') })
      }
      visitList(n, 1, inner, groups.length ? [...active, ...groups] : active, found)
      killAll(env, written(n))
      if (!groups.length) return 0
      parent.splice(i, 0, ...groups.map(g => ['local.set', g.r, enter(g.root)]))
      return groups.length
    }
    if (op === 'block') { visitList(n, 1, env, active, found); killAll(env, written(n)); return 0 }
    if (op === 'if') {
      let j = 1
      for (; j < n.length && !(isArr(n[j]) && (n[j][0] === 'then' || n[j][0] === 'else')); j++) visit(n, j, env, active, found)
      for (; j < n.length; j++) if (isArr(n[j])) visitList(n[j], 1, new Map(env), active, found)
      killAll(env, written(n))
      return 0
    }
    for (let j = 1; j < n.length; j++) visit(n, j, env, active, found)
    if (isSet(n)) { kill(env, n[1]); if (copyOf(n[2]) && !reads(n[2], n[1])) env.set(n[1], n[2]) }
    if (!found && active.length && op === 'call' && moves(n[1])) {
      const t = results.get(n[1]) ?? []
      const sets = active.map(g => ['local.set', g.r, resolve(g.root)])
      for (const s of sets) resets.add(s)
      const w = t.length === 0 ? ['block', n, ...sets]
        : ['block', ['result', t[0]], ['local.set', temp(t[0]), n], ...sets, ['local.get', temp(t[0])]]
      parent[i] = w
      wrappers.push([parent, w, n])
    }
    return 0
  }
  const visitList = (n, from, env, active, found) => {
    for (let j = from; j < n.length; j++) j += visit(n, j, env, active, found)
  }
  const resets = new Set(), wrappers = []
  visitList(fn, start, new Map(), [], null)
  if (!locals.length) return
  // A re-resolve no read of its local follows (the arm a loop breaks out of
  // after its splits) goes; a call left with none is the call again.
  const track = new Set(locals.map(l => l[1]))
  const dead = deadResets(fn, start, track, resets)
  for (const [parent, w, call] of wrappers) {
    const keep = w.filter(c => !dead.has(c))
    if (keep.length === w.length) continue
    const left = keep.some(c => resets.has(c))
    const at = parent.indexOf(w)
    if (at < 0) continue
    parent[at] = left ? keep : call
  }
  fn.splice(start, 0, ...locals)
}

/**
 * The re-resolves (`resets`, sets of the `track` locals) after which no read
 * of their local comes before it is set again or the function ends: a
 * backward liveness over the structured code for those locals alone
 * (optimize/loop-compact.js liveIn, the general one). A branch carries what
 * is live at its target, a loop its own live-in as a fixed point; an
 * unconditional branch, a return and a trap end what follows them.
 */
function deadResets(fn, start, track, resets) {
  const dead = new Set()
  const EMPTY = new Set()
  const add = (a, b) => { let out = null; for (const x of b) if (!a.has(x)) (out ??= new Set(a)).add(x); return out ?? a }
  const label = (labels, name) => labels.get(name) ?? EMPTY
  const liveIn = (n, out, labels) => {
    if (!isArr(n)) return out
    const op = n[0]
    if (op === 'local.get') {
      if (!track.has(n[1]) || out.has(n[1])) return out
      const live = new Set(out)
      live.add(n[1])
      return live
    }
    if (op === 'local.set' || op === 'local.tee') {
      let live = out
      if (track.has(n[1])) {
        if (resets.has(n)) { if (out.has(n[1])) dead.delete(n); else dead.add(n) }
        if (out.has(n[1])) { live = new Set(out); live.delete(n[1]) }
      }
      return liveIn(n[2], live, labels)
    }
    if (op === 'br' || op === 'br_if' || op === 'br_table') {
      let live = op === 'br_if' ? out : EMPTY
      for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string') live = add(live, label(labels, n[i]))
      for (let i = n.length - 1; i >= 1; i--) if (isArr(n[i])) live = liveIn(n[i], live, labels)
      return live
    }
    if (op === 'return' || op === 'unreachable' || op === 'throw' || op === 'throw_ref' || op === 'return_call' || op === 'return_call_indirect' || op === 'return_call_ref')
      return seq(n, EMPTY, labels)
    if (op === 'block') return seq(n, out, typeof n[1] === 'string' ? new Map(labels).set(n[1], out) : labels)
    if (op === 'loop') {
      if (typeof n[1] !== 'string') return seq(n, out, labels)
      let live = out
      for (;;) {
        const next = seq(n, out, new Map(labels).set(n[1], live))
        let grew = false
        for (const x of next) if (!live.has(x)) { grew = true; break }
        if (!grew) return next
        live = add(live, next)
      }
    }
    if (op === 'if') {
      const inner = typeof n[1] === 'string' ? new Map(labels).set(n[1], out) : labels
      let arms = null, other = false
      for (let i = n.length - 1; i >= 1; i--) {
        const c = n[i]
        if (!isArr(c) || (c[0] !== 'then' && c[0] !== 'else')) continue
        if (c[0] === 'else') other = true
        arms = add(arms ?? EMPTY, seq(c, out, inner))
      }
      let live = arms ? (other ? arms : add(arms, out)) : out
      for (let i = n.length - 1; i >= 1; i--) {
        const c = n[i]
        if (isArr(c) && c[0] !== 'then' && c[0] !== 'else' && c[0] !== 'result' && c[0] !== 'param') live = liveIn(c, live, labels)
      }
      return live
    }
    return seq(n, out, labels)
  }
  const seq = (n, out, labels) => {
    let live = out
    for (let i = n.length - 1; i >= 1; i--) if (isArr(n[i]) && n[i][0] !== 'result' && n[i][0] !== 'param') live = liveIn(n[i], live, labels)
    return live
  }
  let live = EMPTY
  for (let i = fn.length - 1; i >= start; i--) live = liveIn(fn[i], live, new Map())
  return dead
}
