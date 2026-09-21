/**
 * Per-iteration arena rewind, placed after the lane vectorizer has seen the
 * loops it can lift. The census (compile/analyze/frame-effects.js) marks a
 * loop whose iteration lets no allocation escape and that builds a value;
 * the emitter (emit/control-flow.js) records that loop's label under the
 * function's name. This pass gives such a loop a save of the heap pointer
 * before it and a restore at the top of every iteration, through a marker
 * local (`$<mark>lrw<N>`) the link pass (optimize/arena-rewind.js)
 * validates against the body's callees and strips where it cannot keep it.
 *
 * Inserted here rather than at emission so the loop keeps the exact shape
 * the vectorizer, the loop rotation and the load hoists match on. The loop
 * is found in its own function by its label (labels count from zero in
 * every function): the peephole walk copies the spine of every loop it
 * changes inside, so the node recorded at emission is gone by now, and a
 * loop the vectorizer lifted keeps its label with a numeric body, where
 * the link pass drops the marker for want of an allocation.
 *
 * @module optimize/loop-rewind
 */
import { ctx, HEAP } from '../ctx.js'
import { T as MARK } from '../ast.js'

const HEADER = new Set(['export', 'param', 'result', 'local'])

/**
 * @param funcs    emitted function arrays
 * @param owners   Map of function name (`$name`) → Set of its loop labels (`['loop', label, ...body]`) to rewind
 * A module with no allocator declares no heap pointer (the stdlib pull
 * declares `__heap` for an owned memory), and then nothing rewinds.
 */
export function insertLoopRewinds(funcs, owners) {
  if (!owners?.size) return
  const shared = ctx.memory.shared
  if (!shared && !ctx.scope.globals.has('__heap')) return
  const save = (name) => ['local.set', name, shared ? ['i32.load', ['i32.const', HEAP.PTR_ADDR]] : ['global.get', '$__heap']]
  const restore = (name) => shared ? ['i32.store', ['i32.const', HEAP.PTR_ADDR], ['local.get', name]] : ['global.set', '$__heap', ['local.get', name]]
  let id = 0
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func') continue
    const labels = owners.get(fn[1])
    if (!labels?.size) continue
    const locals = [], done = new Set()   // a loop met through its block is not met again as the block's child
    const visit = (list, from) => {
      for (let i = from; i < list.length; i++) {
        const n = list[i]
        if (!Array.isArray(n)) continue
        const loopNode = n[0] === 'loop' && labels.has(n[1]) ? n
          : n[0] === 'block' && Array.isArray(n[2]) && n[2][0] === 'loop' && labels.has(n[2][1]) ? n[2] : null
        if (loopNode !== null && !done.has(loopNode)) {
          done.add(loopNode)
          const name = `$${MARK}lrw${id++}`
          locals.push(['local', name, 'i32'])
          loopNode.splice(2, 0, restore(name))
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
