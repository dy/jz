/**
 * In-place compaction of what a loop keeps. An iteration that allocates and
 * lets some of it escape (into a binding of the function, a container made
 * before the loop) cannot restore the heap pointer at its start as a rewind
 * loop does (optimize/loop-rewind.js): what it kept would go with its
 * temporaries. Here the loop keeps what its roots reach, and no more: at the
 * top of an iteration, once the memory above the loop's mark holds twice
 * what the last compaction walked and megabytes besides, the kernel of
 * module/core/compact.js runs with the function's locals as roots beside the
 * module's globals, every local forwarded before the move. `s = x + s` and
 * `a = a.concat(b)` over a long loop then hold the live string or array and
 * at most a few megabytes besides, not every one they replaced. A walk
 * reaches what the module keeps below the mark as well (an old container may
 * name a new value), so its cost, not the memory above the mark it kept,
 * sets the next trigger: a module holding a million objects compacts a
 * loop's churn once per several times their size, not once per sixteen
 * megabytes.
 *
 * Roots: the f64 parameters and f64 locals live at the loop's top (a value
 * in one either names a block, which the kernel forwards, or is a number,
 * which it leaves), and the locals among them holding a raw address by its
 * kind (active-function.js publishLoopRewinds). Live by a backward pass over
 * the function's structured code, expressions included (a `local.set` kills,
 * a read brings in, a branch brings in what is live past its target, a loop
 * its own live-in as a fixed point), among the bindings in scope at the loop
 * (a binding the body declares is dead at its top) that are written at all.
 * A local nothing reads past the loop's top is left alone whatever it holds:
 * a stale address in it harms nothing, and a site's reads keep their locals
 * live across the loop, which the engine pays for in registers and the
 * module in code and compile memory (a function of hundreds of locals and a
 * dozen loops would otherwise carry thousands of root reads, and its
 * compiled size with them). Every root is forwarded at every compaction, so
 * no root holds an address of moved memory; a dead root's block stays one
 * round more. Values held outside the function (the module's bindings, the
 * host's handles, containers older than the loop) are reached from the
 * globals and from the locals that name them, and the host's pin keeps the
 * heap below what it holds. Memory below the loop's mark never moves, so no
 * address a caller holds changes.
 *
 * Placed like the per-iteration rewind: after the lane vectorizer and the
 * loop passes, the loop found in its own function by its label. The marker
 * locals (`$<mark>lrcN`, `$<mark>lrcNlive`) carry the mark and what the last
 * compaction walked; link treats the kernels as the protocol's own
 * (optimize/arena-rewind.js).
 *
 * @module optimize/loop-compact
 */
import { ctx } from '../ctx.js'
import { T as MARK } from '../ast.js'

const HEADER = new Set(['export', 'param', 'result', 'local'])
const written = (label) => typeof label === 'string' ? label.replace(/(?:\.f\d+)+$/, '') : label
/** A compaction pays off once the kept memory holds this much beyond twice
 *  what the last one walked: a walk costs what it reaches, so the slack
 *  is megabytes, not a page, and a loop whose iterations keep a growing value
 *  pays a few walks per hundred megabytes allocated, one whose live data is
 *  large pays one per several times that. */
const SLACK = 16 << 20
const BR = new Set(['br', 'br_if', 'br_table'])
const HEAD = new Set(['result', 'param', 'type'])
const NONE = new Set()
const union = (a, b) => { for (const x of b) a.add(x); return a }

/**
 * Backward liveness over structured code, into expressions as well: the
 * locals live before a node, from those live after it. A `local.set` kills
 * its local, a read brings it in, a branch brings in what is live past its
 * target, a loop's own label the loop's live-in (its least fixed point), a
 * handler's what a throw anywhere in its body could reach; the children of
 * anything else run in order, so each sees what the next needs.
 * `at` receives the live set before each loop the caller asked about.
 */
const liveIn = (n, out, env, at) => {
  if (!Array.isArray(n)) return out
  const op = n[0]
  if (op === 'local.get') { if (out.has(n[1])) return out; return union(new Set(out), [n[1]]) }
  if (op === 'local.set' || op === 'local.tee') { const live = new Set(out); live.delete(n[1]); return liveIn(n[2], live, env, at) }
  if (BR.has(op)) {
    let live = out
    for (let i = n.length - 1; i >= 1; i--) live = typeof n[i] === 'string' ? union(new Set(live), env.get(n[i]) ?? NONE) : liveIn(n[i], live, env, at)
    return live
  }
  if (op === 'block' || op === 'loop') {
    const label = typeof n[1] === 'string' ? n[1] : null
    if (op !== 'loop' || !label) return liveSeq(n, out, label ? new Map(env).set(label, out) : env, at)
    // a branch back to the loop brings in its own live-in: the least fixed
    // point, from what is live past the loop
    const inner = new Map(env)
    let live = out
    for (;;) {
      inner.set(label, live)
      const next = liveSeq(n, out, inner, at)
      if ([...next].every(x => live.has(x))) { live = next; break }
      live = union(new Set(live), next)
    }
    if (at.has(n)) at.set(n, live)
    return live
  }
  if (op === 'try_table') {
    // a throw anywhere in the body reaches a handler: what is live past each
    // is live throughout, so at the entry
    let live = new Set(out)
    for (const c of n) if (Array.isArray(c) && c[0].startsWith('catch')) union(live, env.get(c[c.length - 1]) ?? NONE)
    return liveSeq(n, live, env, at)
  }
  if (op === 'if') {
    let arms = null, hasElse = false, cond = out
    if (typeof n[1] === 'string') env = new Map(env).set(n[1], out)
    for (let i = n.length - 1; i >= 1; i--) {
      const c = n[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'then' || c[0] === 'else') { arms = union(liveSeq(c, out, env, at), arms ?? NONE); if (c[0] === 'else') hasElse = true }
    }
    cond = arms ? (hasElse ? arms : union(arms, out)) : out
    for (let i = n.length - 1; i >= 1; i--) {
      const c = n[i]
      if (Array.isArray(c) && !HEAD.has(c[0]) && c[0] !== 'then' && c[0] !== 'else') cond = liveIn(c, cond, env, at)
    }
    return cond
  }
  return liveSeq(n, out, env, at)
}
/** The children of a node in order, each seeing what the next needs. */
const liveSeq = (n, out, env, at) => {
  let live = out
  for (let i = n.length - 1; i >= 1; i--) if (Array.isArray(n[i]) && !HEAD.has(n[i][0])) live = liveIn(n[i], live, env, at)
  return live
}

/**
 * @param funcs  emitted function arrays
 * @param owners Map of function name (`$name`) → { labels: Set of loop labels, raw: [[`$local`, tag, aux]…] }
 */
export function insertLoopCompacts(funcs, owners) {
  if (!owners?.size || ctx.memory.shared || !ctx.scope.globals.has('__heap')) return
  let id = 0
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func') continue
    const own = owners.get(fn[1])
    if (!own?.labels?.size) continue
    // the roots of a loop: the f64 parameters and f64 locals live at it, and
    // the raw addresses by kind among them
    const params = [], f64Locals = []
    for (let i = 1; i < fn.length; i++) {
      const h = fn[i]
      if (!Array.isArray(h) || (h[0] !== 'local' && h[0] !== 'param') || h[2] !== 'f64') continue
      ;(h[0] === 'param' ? params : f64Locals).push(h[1])
    }
    // the raw addresses by kind among the i32 locals, a specialized path's
    // copy of a local (`$x.f0`, optimize/specialize.js) by the local's kind
    const rawKind = new Map(own.raw.map(([name, tag, aux]) => [name, [tag, aux]]))
    const raws = []
    for (const h of fn) if (Array.isArray(h) && (h[0] === 'local' || h[0] === 'param') && h[2] === 'i32' && rawKind.has(written(h[1]))) raws.push([h[1], ...rawKind.get(written(h[1]))])
    const writes = new Set(params)
    const noteWrites = (n) => { if (!Array.isArray(n)) return; if (n[0] === 'local.set' || n[0] === 'local.tee') writes.add(n[1]); for (let i = 1; i < n.length; i++) noteWrites(n[i]) }
    noteWrites(fn)
    const site = (mark, live, outer, read) => {
      const marks = [], fwds = []
      // a specialized path's copy of a local is in scope where the local is
      const root = (n) => read.has(n) && writes.has(n) && (!outer || outer.has(written(n)))
      const f64 = [...params.filter(n => read.has(n)), ...f64Locals.filter(root)]
      const raw = raws.filter(([name]) => read.has(name) && writes.has(name))
      for (const name of f64) {
        marks.push(['call', '$__gc_mark', ['i64.reinterpret_f64', ['local.get', name]]])
        fwds.push(['local.set', name, ['f64.reinterpret_i64', ['call', '$__gc_fwd', ['i64.reinterpret_f64', ['local.get', name]]]]])
      }
      for (const [name, tag, aux] of raw) {
        marks.push(['call', '$__gc_mark', ['i64.reinterpret_f64', ['call', '$__mkptr', ['i32.const', tag], ['i32.const', aux], ['local.get', name]]]])
        fwds.push(['local.set', name, ['call', '$__gc_fwd_raw', ['local.get', name]]])
      }
      return ['if',
        ['i32.gt_u', ['i32.sub', ['global.get', '$__heap'], ['local.get', mark]], ['i32.add', ['i32.shl', ['local.get', live], ['i32.const', 1]], ['i32.const', SLACK]]],
        ['then', ['if', ['call', '$__gc_begin', ['local.get', mark]],
          ['then', ...marks, ['call', '$__gc_walk'], ...fwds, ['drop', ['call', '$__gc_move']], ['local.set', live, ['global.get', '$__g_cost']]]]]]
    }
    const locals = [], done = new Set()
    // the locals live at each site loop's top, before any site reads them
    const liveAt = new Map(), all = new Set([...params, ...f64Locals, ...raws.map(([n]) => n)])
    const find = (n) => { if (!Array.isArray(n)) return; if (n[0] === 'loop' && own.labels.has(written(n[1]))) liveAt.set(n, null); for (let i = 1; i < n.length; i++) find(n[i]) }
    find(fn)
    let body = 1
    for (let i = 1; i < fn.length; i++) if (Array.isArray(fn[i]) && HEADER.has(fn[i][0])) body = i + 1
    liveSeq(['func', ...fn.slice(body)], NONE, new Map(), liveAt)
    const visit = (list, from) => {
      for (let i = from; i < list.length; i++) {
        const n = list[i]
        if (!Array.isArray(n)) continue
        const loopNode = n[0] === 'loop' && own.labels.has(written(n[1])) ? n
          : n[0] === 'block' && Array.isArray(n[2]) && n[2][0] === 'loop' && own.labels.has(written(n[2][1])) ? n[2] : null
        if (loopNode !== null && !done.has(loopNode)) {
          done.add(loopNode)
          const mark = `$${MARK}lrc${id}`, live = `$${MARK}lrc${id}live`
          id++
          locals.push(['local', mark, 'i32'], ['local', live, 'i32'])
          loopNode.splice(2, 0, site(mark, live, own.outer?.get(written(loopNode[1])) ?? null, liveAt.get(loopNode) ?? all))
          list.splice(i, 0, ['local.set', mark, ['global.get', '$__heap']], ['local.set', live, ['i32.const', 0]])
          i += 2
        }
        visit(n, 1)
      }
    }
    visit(fn, 1)
    if (!locals.length) continue
    ctx.plans.hasCompactLoops = true
    fn.splice(body, 0, ...locals)
  }
}
