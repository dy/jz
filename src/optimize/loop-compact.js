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
 * its own live-in as a fixed point), among the locals written at all.
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
 * locals (`$<mark>lrcN`, `$<mark>lrcNth`) carry the mark and the threshold;
 * link treats the kernels as the protocol's own
 * (optimize/arena-rewind.js). A caller's local across a spliced site names
 * memory below the floor, and reaches above it only through a logged stub.

 *
 * @module optimize/loop-compact
 */
import { ctx } from '../ctx.js'
import { T as MARK } from '../ast.js'
import { compactSlack } from '../../module/core/stub-log.js'

const HEADER = new Set(['export', 'param', 'result', 'local'])
const written = (label) => typeof label === 'string' ? label.replace(/(?:\.f\d+)+$/, '') : label
/** A compaction pays off once the kept memory holds the slack (`SLACK`,
 *  `optimize.compactSlack`) beyond twice what the last one walked: a walk
 *  costs what it reaches, so the slack is megabytes, not a page, and a loop
 *  whose iterations keep a growing value pays a walk per few megabytes
 *  allocated, one whose live data is large pays one per several times that. Under pressure, as the memory's
 *  cap nears (less an eighth of the heap and `MARGIN` for the kernel's
 *  scratch), a compaction waits for `PRESSURE_SLACK` beyond an eighth of the
 *  walk instead: a walk per eighth of the live data, not per page. The kernel
 *  folds both rules into one heap address per compaction (`__gc_thresh`),
 *  so an iteration pays one comparison. */
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
 * anything else run in order, so each sees what the next needs. Liveness is
 * the whole rule: a binding the body declares is written before it is read
 * in every iteration, so it is dead at the top, and a caller's local across
 * an inlined loop, or a specialized path's copy of one, is live where its
 * reads say so.

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
  // the memory's cap in bytes, as an i32: its declared maximum, else the address space
  const cap = (ctx.memory.max > 0 && ctx.memory.max < 65536 ? ctx.memory.max * 65536 : 2 ** 32) | 0
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
    // written: every parameter, whatever its type (a raw address or a box
    // comes in as one), and every local some instruction sets
    const writes = new Set(), i64Locals = []
    for (let i = 1; i < fn.length; i++) { const h = fn[i]; if (!Array.isArray(h)) continue; if (h[0] === 'param') writes.add(h[1]); if ((h[0] === 'local' || h[0] === 'param') && h[2] === 'i64') i64Locals.push(h[1]) }
    // what each i32 and i64 local derives from: the f64 locals read in its
    // definitions, and what the i32 and i64 locals read there derive from
    // (a closure's environment address from its `$__env`, a hoisted data
    // address from the array's local): a site roots the source of a live one,
    // whose block it would otherwise take for garbage
    const sources = new Map(), f64Set = new Set([...params, ...f64Locals])
    const defs = []
    const noteWrites = (n) => {
      if (!Array.isArray(n)) return
      if (n[0] === 'local.set' || n[0] === 'local.tee') { writes.add(n[1]); if (!f64Set.has(n[1])) defs.push(n) }
      for (let i = 1; i < n.length; i++) noteWrites(n[i])
    }
    noteWrites(fn)
    const reads = (n, into) => { if (!Array.isArray(n)) return into; if (n[0] === 'local.get' || n[0] === 'local.tee') into.add(n[1]); for (let i = 1; i < n.length; i++) reads(n[i], into); return into }
    for (const d of defs) for (const r of reads(d[2], new Set())) (sources.get(d[1]) ?? sources.set(d[1], new Set()).get(d[1])).add(r)
    for (let changed = true; changed;) {
      changed = false
      for (const [, set] of sources) for (const r of [...set]) if (!f64Set.has(r)) for (const s of sources.get(r) ?? []) if (!set.has(s)) { set.add(s); changed = true }
    }
    // what a compaction does, outside the loop: the loop's top tests the
    // heap against the threshold and leaves for it, and re-enters after
    const compaction = (mark, thresh, read) => {
      const marks = [], fwds = []
      const derived = new Set()
      for (const n of read) for (const s of sources.get(n) ?? []) if (f64Set.has(s)) derived.add(s)
      const root = (n) => (read.has(n) || derived.has(n)) && writes.has(n)
      const f64 = [...params.filter(n => read.has(n) || derived.has(n)), ...f64Locals.filter(root)]
      // a box an i64 local holds (a value the optimizer narrowed, an error's
      // message): marked and forwarded as one, a number left alone (__gc_box)
      const i64 = i64Locals.filter(root)
      const raw = raws.filter(([name]) => read.has(name) && writes.has(name))
      for (const name of f64) {
        marks.push(['call', '$__gc_mark', ['i64.reinterpret_f64', ['local.get', name]]])
        fwds.push(['local.set', name, ['f64.reinterpret_i64', ['call', '$__gc_fwd', ['i64.reinterpret_f64', ['local.get', name]]]]])
      }
      for (const name of i64) {
        marks.push(['call', '$__gc_mark', ['local.get', name]])
        fwds.push(['local.set', name, ['call', '$__gc_fwd', ['local.get', name]]])
      }
      for (const [name, tag, aux] of raw) {
        marks.push(['call', '$__gc_mark', ['i64.reinterpret_f64', ['call', '$__mkptr', ['i32.const', tag], ['i32.const', aux], ['local.get', name]]]])
        fwds.push(['local.set', name, ['call', '$__gc_fwd_raw', ['local.get', name]]])
      }
      // declined (the kernel has no room, a checkpoint holds parked data, the
      // stub log overflowed): asked again a slack later, or never past the end
      const later = ['i32.add', ['global.get', '$__heap'], ['i32.const', compactSlack()]]
      return ['if', ['call', '$__gc_begin', ['local.get', mark]],
        ['then', ...marks, ['call', '$__gc_walk'], ...fwds, ['drop', ['call', '$__gc_move']],
          ['local.set', thresh, ['call', '$__gc_thresh', ['local.get', mark], ['global.get', '$__g_cost'], ['i32.const', cap - 1]]]],
        ['else', ['local.set', thresh, ['select', later, ['i32.const', -1], ['i32.gt_u', later, ['global.get', '$__heap']]]]]]
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
          const mark = `$${MARK}lrc${id}`, thresh = `$${MARK}lrc${id}th`, out = `$${MARK}lrc${id}out`, again = `$${MARK}lrc${id}again`, exit = `$${MARK}lrc${id}exit`
          id++
          locals.push(['local', mark, 'i32'], ['local', thresh, 'i32'])
          // The loop keeps no call of the kernel in its body (a call in a loop
          // keeps every load in it from leaving the loop): its top leaves for
          // the compaction past the threshold, and the loop around re-enters
          // it at the same iteration after. Its own label stays inside and its
          // break block, with whatever follows the loop in it, around.
          //   block $exit
          //     loop $again
          //       block $out  loop $L  (br_if $out past?) body…  end  (br $exit)  end
          //       compaction  (br $again)
          loopNode.splice(2, 0, ['br_if', out, ['i32.gt_u', ['global.get', '$__heap'], ['local.get', thresh]]])
          const around = ['block', exit, ['loop', again, ['block', out, loopNode, ['br', exit]], compaction(mark, thresh, liveAt.get(loopNode) ?? all), ['br', again]]]
          if (n === loopNode) list[i] = around
          else n.splice(n.indexOf(loopNode), 1, around)
          // The entry: the mark, and the threshold a slack past it, which is
          // what the kernel's rule gives before a walk (the pressure rule's
          // own floor is the same; a wrapped sum only asks a compaction early,
          // which sets the threshold properly). Nothing else: a store to a
          // global here cost a parser five percent.
          list.splice(i, 0, ['local.set', mark, ['global.get', '$__heap']],
            ['local.set', thresh, ['i32.add', ['local.get', mark], ['i32.const', compactSlack()]]])
          i += 3
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
