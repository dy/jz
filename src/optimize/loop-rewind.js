/**
 * Per-iteration arena rewind, placed after the lane vectorizer has seen the
 * loops it can lift. The census (compile/analyze/frame-effects.js) marks a
 * loop whose iteration lets no allocation escape and that builds a value;
 * the emitter (emit/control-flow.js) records that loop's WAT block node.
 * This pass gives such a loop a save of the heap pointer before it and a
 * restore at the top of every iteration, through a marker local
 * (`$<mark>lrw<N>`) the link pass (optimize/arena-rewind.js) validates against the
 * body's callees and strips where it cannot keep it.
 *
 * Inserted here rather than at emission so the loop keeps the exact shape
 * the vectorizer, the loop rotation and the load hoists match on: a
 * vectorized loop is a new node the pass never sees (its body is numeric).
 *
 * @module optimize/loop-rewind
 */
import { ctx, HEAP } from '../ctx.js'
import { T as MARK } from '../ast.js'

const HEADER = new Set(['export', 'param', 'result', 'local'])

/**
 * @param funcs    emitted function arrays
 * @param nodes    WeakSet of loop block nodes `['block', brk, ['loop', label, ...body]]` to rewind
 * A module with no allocator declares no heap pointer (the stdlib pull
 * declares `__heap` for an owned memory), and then nothing rewinds.
 */
export function insertLoopRewinds(funcs, nodes) {
  if (!nodes) return
  const shared = ctx.memory.shared
  if (!shared && !ctx.scope.globals.has('__heap')) return
  const save = (name) => ['local.set', name, shared ? ['i32.load', ['i32.const', HEAP.PTR_ADDR]] : ['global.get', '$__heap']]
  const restore = (name) => shared ? ['i32.store', ['i32.const', HEAP.PTR_ADDR], ['local.get', name]] : ['global.set', '$__heap', ['local.get', name]]
  let id = 0
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func') continue
    const locals = []
    const visit = (list, from) => {
      for (let i = from; i < list.length; i++) {
        const n = list[i]
        if (!Array.isArray(n)) continue
        if (nodes.has(n) && n[0] === 'block' && Array.isArray(n[2]) && n[2][0] === 'loop') {
          nodes.delete(n)
          const name = `$${MARK}lrw${id++}`
          locals.push(['local', name, 'i32'])
          n[2].splice(2, 0, restore(name))
          list.splice(i, 0, save(name))
          i++
        }
        visit(n, 1)
      }
    }
    visit(fn, 1)
    if (!locals.length) continue
    // Declare the marker locals after the last header entry.
    let at = 1
    for (let i = 1; i < fn.length; i++) if (Array.isArray(fn[i]) && HEADER.has(fn[i][0])) at = i + 1
    fn.splice(at, 0, ...locals)
  }
}
