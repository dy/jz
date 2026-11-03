/**
 * A loop that allocates nothing as emitted carries no allocation machinery.
 *
 * The frame census (compile/analyze/frame-effects.js) gives a loop whose
 * iteration allocates and lets something escape a compaction of what it keeps
 * (`allocLoops`, optimize/loop-compact.js) and, where the frame flags its
 * escapes, a release of each iteration by the flag (`releaseLoops`,
 * emit/control-flow.js iterationRelease). It reads the source, before
 * anything is emitted: an object literal allocates there, though the emitter
 * may write it into the cells its element had (emit-assign.js
 * tryStructInlineReplaceStore, `ps[i] = { x, y }`), and a helper a call reaches
 * allocates there, though the body it was emitted to does not. Each of an
 * iteration's machinery is paid on every iteration (the compaction's test of
 * the heap at the loop's top, the release's test of the compaction epoch and
 * of the heap), and a compacting loop's site rebinds every root it forwards,
 * which keeps a receiver's forward hop in the loop (optimize/forward-hops.js).
 *
 * Here, once every function is emitted and before the runtime is pulled and
 * the optimizer runs, each such loop is asked again as emitted: one whose
 * body cannot move the heap's top on a path that stays in the loop keeps
 * neither. Its iterations pay nothing for memory they never make, its
 * receivers' hops leave it, and a module none of whose loops compacts lays
 * out no stub log (module/core/stub-log.js, sixteen pages).
 *
 * Dropping a loop's machinery is sound whatever the loop does: a compaction
 * and a release only give memory back, and a loop that never gives back
 * keeps what it made until the frame around it, the loop around it or the
 * host does. A release is dropped whole or not at all: its marks before the
 * loop, its test at the top, and the floor it puts back where the loop ends,
 * returns or breaks (`$__ibase`, the flag it took over) are one protocol, each
 * node tagged with the release it belongs to as it is emitted; where a node
 * of it is missing or a read of its locals stands outside it, it stays.
 *
 * What may move the heap's top up, read off the code as emitted: a write of
 * `$__heap` (an allocation in line, or a restore: either way counted), a call
 * of the allocator or of a function whose body may (a fixpoint over the call
 * graph, the program's functions as emitted and the runtime's templates as
 * written), any indirect call, a call of an import (the host may allocate in
 * the module's memory as it hands a value back, or call an export that does),
 * and any callee of which nothing is known. A call that never returns (a
 * throw helper, or one `unreachable` follows: optimize/arena-rewind.js
 * neverReturns) allocates only on a path that leaves by an exception. That
 * path leaves the loop where no handler stands between the throw and the
 * loop: none in the loop's body, none in a function of the calls that lead
 * there. A body with a handler is asked whole, every callee's throws with it.
 *
 * @module optimize/quiet-loops
 */
import { ctx } from '../ctx.js'

const isArr = Array.isArray
const ALLOCATORS = new Set(['$__alloc', '$__alloc_hdr', '$__alloc_hdr_n'])
// The reset log's saves (core/durable-log.js): a container's first store of a
// round copies it into a record the log keeps until the round's clear, once
// per container. No compaction or release could give that back: a loop that
// allocates nothing else carries neither (a loop whose stores are in bounds
// saves its arrays once ahead of itself, emit/control-flow.js).
const LOGS = new Set(['$__durable_arr_snap', '$__durable_obj_snap'])
const HANDLERS = new Set(['try', 'try_table', 'catch', 'catch_all', 'catch_ref', 'catch_all_ref', 'delegate'])
const INDIRECT = new Set(['call_indirect', 'call_ref', 'return_call_indirect', 'return_call_ref'])
const DIRECT = new Set(['call', 'return_call'])
const TEXT_HANDLER = /\((?:try|try_table|catch|catch_all|delegate)\b/
const TEXT_RAISES = /global\.set\s+\$__heap(?![\w.])|\b(?:call_indirect|call_ref|return_call_indirect|return_call_ref)\b|\(import\b/
const TEXT_CALL = /\b(?:call|return_call)\s+(\$[A-Za-z_][\w.]*)/g
// A specialized copy's label: the loop's own and a tag per copy around it (optimize/specialize.js)
const COPY = /(?:\.f\d+)+$/

/** A call that never returns: a throw helper, or one `unreachable` follows. */
const neverReturns = (callee, next) => callee.startsWith('$__throw') ||
  isArr(next) && (next[0] === 'unreachable' || next[0] === 'drop' && isArr(next[1]) && next[1][0] === 'unreachable')

const hasHandler = (n) => {
  if (!isArr(n)) return false
  if (HANDLERS.has(n[0])) return true
  for (let i = 1; i < n.length; i++) if (hasHandler(n[i])) return true
  return false
}

/** What `n` does to the heap's top by itself: `raises` where it may move it
 *  up on a path that returns, `thrown` where on a path a call that never
 *  returns leaves by; `calls` the functions it calls on paths that return,
 *  `throws` those on paths that leave. Nodes a release tags (`iterRelease`)
 *  are its protocol's, which only gives back. */
function scan(n, out = { raises: false, thrown: false, calls: new Set(), throws: new Set() }, leaving = false) {
  if (!isArr(n)) return out
  for (let i = 1; i < n.length; i++) {
    const c = n[i]
    if (!isArr(c) || c.iterRelease) continue
    const op = c[0]
    let leaves = leaving
    if (DIRECT.has(op) && typeof c[1] === 'string' && !LOGS.has(c[1])) {
      leaves = leaves || neverReturns(c[1], n[i + 1])
      if (ALLOCATORS.has(c[1])) { if (leaves) out.thrown = true; else out.raises = true }
      else (leaves ? out.throws : out.calls).add(c[1])
    }
    else if (INDIRECT.has(op) || op === 'global.set' && c[1] === '$__heap') { if (leaves) out.thrown = true; else out.raises = true }
    scan(c, out, leaves)
  }
  return out
}

/** Whether a call of a function may move the heap's top up: `strict`, on any
 *  path, a throw caught on the way included; `returning`, on a path that
 *  returns to a caller with no handler around it (a function with a handler
 *  answers strictly: what it catches returns). Asked by name, answered once. */
function heapRaisers(sec) {
  const ir = new Map()
  for (const list of [sec.funcs, sec.start]) for (const f of list) if (isArr(f) && f[0] === 'func' && typeof f[1] === 'string') ir.set(f[1], f)
  const imports = new Set()
  for (const list of [sec.imports, ctx.module.imports]) for (const imp of list ?? [])
    if (isArr(imp)) for (const d of imp) if (isArr(d) && d[0] === 'func' && typeof d[1] === 'string') imports.add(d[1])
  const RAISES = { handles: false, raises: true, thrown: false, calls: new Set(), throws: new Set() }
  const facts = new Map()   // name → { handles, raises, thrown, calls, throws }
  const factsOf = (name) => {
    if (ALLOCATORS.has(name) || imports.has(name)) return RAISES
    const f = ir.get(name)
    if (f) return { handles: hasHandler(f), ...scan(f) }
    const v = ctx.core.stdlib[name.slice(1)]
    let text = null
    try { text = typeof v === 'function' ? v() : v } catch { text = null }
    if (typeof text !== 'string' || TEXT_RAISES.test(text)) return RAISES
    const out = { handles: TEXT_HANDLER.test(text), raises: false, thrown: false, calls: new Set(), throws: new Set() }
    for (const m of text.matchAll(TEXT_CALL)) {
      const callee = m[1]
      if (callee === name) continue
      if (ALLOCATORS.has(callee)) return RAISES
      ;(callee.startsWith('$__throw') ? out.throws : out.calls).add(callee)
    }
    return out
  }
  let strict = null, returning = null
  // the least fixpoint from `seeds` back along the edges `edges` gives each caller
  const close = (seeds, edges) => {
    const set = new Set(seeds), callers = new Map(), work = [...set]
    for (const [name, f] of facts) for (const c of edges(f)) (callers.get(c) ?? callers.set(c, []).get(c)).push(name)
    while (work.length) for (const caller of callers.get(work.pop()) ?? []) if (!set.has(caller)) { set.add(caller); work.push(caller) }
    return set
  }
  const solve = () => {
    const unknown = [...facts.values()].flatMap(f => [...f.calls, ...f.throws]).filter(c => !facts.has(c))
    strict = close([...unknown, ...[...facts].filter(([, f]) => f.raises || f.thrown).map(([n]) => n)], f => [...f.calls, ...f.throws])
    // a function with a handler answers strictly; one without, by its returning paths
    returning = close([...unknown, ...[...facts].filter(([n, f]) => f.handles ? strict.has(n) : f.raises).map(([n]) => n)], f => f.handles ? [] : [...f.calls])
  }
  return {
    /** Learn the functions `names` reach. */
    reach(names) {
      const work = [...names]
      while (work.length) {
        const name = work.pop()
        if (facts.has(name)) continue
        const f = factsOf(name)
        facts.set(name, f)
        for (const c of [...f.calls, ...f.throws]) if (!facts.has(c)) work.push(c)
      }
      strict = returning = null
    },
    /** Whether `name` may move the heap's top: on any path, or (`leaves`: no
     *  handler stands between it and the loop) on a path that returns. */
    raises(name, leaves) {
      if (strict === null) solve()
      return !facts.has(name) || (leaves ? returning : strict).has(name)
    },
  }
}

/** The release a loop's top belongs to (emit/control-flow.js iterationRelease): its first tagged child. */
const releaseOf = (loop) => {
  for (let i = 2; i < loop.length; i++) { const c = loop[i]; if (isArr(c) && c.iterRelease && typeof c.iterRelease === 'object') return c.iterRelease }
  return null
}

/** Take a release out of `fn` whole: every node tagged with it, where each
 *  one it tagged is found and no read or write of its locals stands outside
 *  them. Otherwise nothing changes. */
function dropRelease(fn, rel) {
  const found = [], names = new Set(rel.locals)
  let stray = false
  const visit = (n) => {
    for (let i = 1; i < n.length && !stray; i++) {
      const c = n[i]
      if (!isArr(c)) continue
      if (c.iterRelease === rel) { found.push([n, c]); continue }
      if ((c[0] === 'local.get' || c[0] === 'local.set' || c[0] === 'local.tee') && names.has(c[1])) { stray = true; return }
      visit(c)
    }
  }
  visit(fn)
  if (stray || found.length !== rel.count) return false
  for (const [parent, c] of found) { const at = parent.indexOf(c); if (at > 0) parent.splice(at, 1) }
  return true
}

/**
 * Drop the compaction and the iteration release of every loop in `sec`'s
 * functions that allocates nothing as emitted.
 */
export function quietLoops(sec) {
  const compacts = ctx.plans.compactLoopLabels
  // (a release includes its kernel as it is emitted: none, and no compaction, asks nothing)
  if (!compacts?.size && !ctx.core.includes.has('__iter_release') && !ctx.core.includes.has('__iter_take')) return
  // candidates: each loop the census gave a compaction or a release
  const loops = []
  for (const list of [sec.funcs, sec.start]) for (const fn of list) {
    if (!isArr(fn) || fn[0] !== 'func') continue
    const labels = typeof fn[1] === 'string' ? compacts?.get(fn[1])?.labels : null
    const visit = (n) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        if (c[0] === 'loop') {
          const compact = !!labels && typeof c[1] === 'string' && labels.has(c[1]), rel = releaseOf(c)
          if (compact || rel) loops.push({ fn, loop: c, compact, rel })
        }
        visit(c)
      }
    }
    visit(fn)
  }
  if (!loops.length) return
  const heap = heapRaisers(sec)
  for (const l of loops) { l.scan = scan(l.loop); l.handles = hasHandler(l.loop) }
  heap.reach(loops.flatMap(l => [...l.scan.calls, ...l.scan.throws]))
  for (const { fn, loop, compact, rel, scan: s, handles } of loops) {
    // a throw leaves a loop with no handler in it: only the paths that return count there
    if (handles ? s.raises || s.thrown || [...s.calls, ...s.throws].some(c => heap.raises(c, false))
      : s.raises || [...s.calls].some(c => heap.raises(c, true))) continue
    if (compact) {
      const own = compacts.get(fn[1])
      own.labels.delete(loop[1])
      if (!own.labels.size) compacts.delete(fn[1])
    }
    if (rel) dropRelease(fn, rel)
  }
}

/**
 * Ask the question again of the loops as the optimizer left them. A loop
 * whose generic arm a specialized copy turned into a leave for the loop as
 * written (optimize/specialize.js: a dynamic `+` that may concatenate, its
 * strings and objects left to the loop as written) allocates nothing in the
 * copy, though the loop it copies does: the copy's iterations pay no release
 * test, and no compaction or rewind goes in around it (loop-compact.js,
 * loop-rewind.js, `ctx.plans.quietLoopNodes`). Only the test the copy carries
 * at its top goes: the release's marks before the loop and its floor after it
 * are the loop as written's too, and a test only gives memory back.
 */
export function quietOptimizedLoops(sec) {
  const compacts = ctx.plans.compactLoopLabels, rewinds = ctx.plans.rewindLoopLabels
  if (!compacts?.size && !rewinds?.size && !ctx.core.includes.has('__iter_take')) return
  const loops = []
  for (const list of [sec.funcs, sec.start]) for (const fn of list) {
    if (!isArr(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') continue
    const compact = compacts?.get(fn[1])?.labels, rewind = rewinds?.get(fn[1])
    const visit = (n) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        if (c[0] === 'loop' && typeof c[1] === 'string' && COPY.test(c[1])) {
          const base = c[1].replace(COPY, '')
          if (compact?.has(base) || rewind?.has(base) || releaseOf(c)) loops.push(c)
        }
        visit(c)
      }
    }
    visit(fn)
  }
  if (!loops.length) return
  const heap = heapRaisers(sec)
  const scans = loops.map(loop => ({ loop, s: scan(loop), handles: hasHandler(loop) }))
  heap.reach(scans.flatMap(({ s }) => [...s.calls, ...s.throws]))
  const quiet = ctx.plans.quietLoopNodes ??= new WeakSet()
  for (const { loop, s, handles } of scans) {
    if (handles ? s.raises || s.thrown || [...s.calls, ...s.throws].some(c => heap.raises(c, false))
      : s.raises || [...s.calls].some(c => heap.raises(c, true))) continue
    quiet.add(loop)
    for (let i = loop.length - 1; i >= 2; i--) if (isArr(loop[i]) && loop[i].iterRelease) loop.splice(i, 1)
  }
}
