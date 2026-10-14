/**
 * In-place compaction of what a loop keeps. An iteration that allocates and
 * lets some of it escape (into a binding of the function, a container made
 * before the loop) cannot restore the heap pointer at its start as a rewind
 * loop does (optimize/loop-rewind.js): what it kept would go with its
 * temporaries. Here the loop keeps what its roots reach, and no more: at the
 * top of an iteration, once the memory above the loop's mark holds four
 * times what the last compaction kept and megabytes besides, the kernel of
 * module/core/compact.js runs with the function's locals as roots beside the
 * module's globals, every local forwarded before the move. `s = x + s` and
 * `a = a.concat(b)` over a long loop then hold the live string or array and
 * at most a few megabytes besides, not every one they replaced.
 *
 * Roots: every f64 parameter and every f64 local in scope at the loop (a
 * value in one either names a block, which the kernel forwards, or is a
 * number, which it leaves), and every local among them holding a raw address
 * by its kind (active-function.js publishLoopRewinds). A binding the body
 * declares is dead at the loop's top, as are the emitter's temporaries, so
 * neither is read there: a site's reads keep their locals live across the
 * loop, which the engine pays for in registers. A local that holds a pointer
 * the previous compaction did not forward would name moved memory, so every
 * root is marked live or not; a dead root's block stays one round more. Values held outside the function (the module's
 * bindings, the host's handles, containers older than the loop) are reached
 * from the globals and from the locals that name them, and the host's pin
 * keeps the heap below what it holds. Memory below the loop's mark never
 * moves, so no address a caller holds changes.
 *
 * Placed like the per-iteration rewind: after the lane vectorizer and the
 * loop passes, the loop found in its own function by its label. The marker
 * locals (`$<mark>lrcN`, `$<mark>lrcNlive`) carry the mark and what the last
 * compaction kept; link treats the kernels as the protocol's own
 * (optimize/arena-rewind.js).
 *
 * @module optimize/loop-compact
 */
import { ctx } from '../ctx.js'
import { T as MARK } from '../ast.js'

const HEADER = new Set(['export', 'param', 'result', 'local'])
const written = (label) => typeof label === 'string' ? label.replace(/(?:\.f\d+)+$/, '') : label
/** A compaction pays off once the kept memory holds this much beyond four
 *  times what the last one kept: a walk costs what it keeps, so the slack is
 *  megabytes, not a page, and a loop whose iterations keep a growing value
 *  pays a few walks per hundred megabytes allocated, one whose live data is
 *  large pays one per several times that. */
const SLACK = 16 << 20

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
    // the roots of a loop: every f64 parameter and every f64 local in scope at
    // it (a binding the body declares is dead at its top), and the raw
    // addresses by kind among them
    const params = [], f64Locals = []
    for (let i = 1; i < fn.length; i++) {
      const h = fn[i]
      if (!Array.isArray(h) || (h[0] !== 'local' && h[0] !== 'param') || h[2] !== 'f64') continue
      ;(h[0] === 'param' ? params : f64Locals).push(h[1])
    }
    const declared = new Set(fn.filter(h => Array.isArray(h) && (h[0] === 'local' || h[0] === 'param') && h[2] === 'i32').map(h => h[1]))
    const site = (mark, live, outer) => {
      const marks = [], fwds = []
      const f64 = outer ? [...params, ...f64Locals.filter(n => outer.has(n))] : [...params, ...f64Locals]
      const raw = own.raw.filter(([name]) => declared.has(name) && (!outer || outer.has(name) || !f64Locals.includes(name)))
      for (const name of f64) {
        marks.push(['call', '$__gc_mark', ['i64.reinterpret_f64', ['local.get', name]]])
        fwds.push(['local.set', name, ['f64.reinterpret_i64', ['call', '$__gc_fwd', ['i64.reinterpret_f64', ['local.get', name]]]]])
      }
      for (const [name, tag, aux] of raw) {
        marks.push(['call', '$__gc_mark', ['i64.reinterpret_f64', ['call', '$__mkptr', ['i32.const', tag], ['i32.const', aux], ['local.get', name]]]])
        fwds.push(['local.set', name, ['call', '$__gc_fwd_raw', ['local.get', name]]])
      }
      return ['if',
        ['i32.gt_u', ['i32.sub', ['global.get', '$__heap'], ['local.get', mark]], ['i32.add', ['i32.shl', ['local.get', live], ['i32.const', 2]], ['i32.const', SLACK]]],
        ['then', ['if', ['call', '$__gc_begin', ['local.get', mark]],
          ['then', ...marks, ['call', '$__gc_walk'], ...fwds, ['local.set', live, ['i32.sub', ['call', '$__gc_move'], ['local.get', mark]]]]]]]
    }
    const locals = [], done = new Set()
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
          loopNode.splice(2, 0, site(mark, live, own.outer?.get(written(loopNode[1])) ?? null))
          list.splice(i, 0, ['local.set', mark, ['global.get', '$__heap']], ['local.set', live, ['i32.const', 0]])
          i += 2
        }
        visit(n, 1)
      }
    }
    visit(fn, 1)
    if (!locals.length) continue
    ctx.plans.hasCompactLoops = true
    let at = 1
    for (let i = 1; i < fn.length; i++) if (Array.isArray(fn[i]) && HEADER.has(fn[i][0])) at = i + 1
    fn.splice(at, 0, ...locals)
  }
}
