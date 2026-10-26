/**
 * A function whose body is a few instructions is spliced into every caller
 * (speed tier).
 *
 * V8 runs a module's functions as baseline code until each has run long
 * enough on its own: its optimizing compiler inlines a small callee, its
 * baseline compiler never does. There every call enters a frame through a
 * setup stub, stores the callee's locals' zeros and checks its tier-up budget
 * at the return, work a tag test or a pointer box (`__mkptr_1_0_d`, one `or`)
 * does not approach. A compiler module or a parser makes a call for every
 * few dozen instructions, most of them to such helpers, and runs as baseline
 * code for most of a short run: watr makes 12,000 calls a module it assembles,
 * and on an EPYC 7763 the frame setup stub alone took 8.5% of the samples in
 * its code (perf, main thread). A spliced helper also no longer waits for a
 * tier-up of its own: it runs as its callers run.
 *
 * The callee qualifies by size alone: at most `max` instruction nodes, no
 * loop (a loop is work enough to pay its call). watr's inliner does the
 * splice and its own checks (named locals, one result, no recursion, no tail
 * call, no reference other than a direct call); `pin` keeps the functions the
 * other passes need whole. After the splices the touched callers propagate
 * the arguments into the bodies, as watr's own inlining round does.
 *
 * @module optimize/inline-tiny
 */
import { inline, propagate, mergeBlocks, vacuum, coalesceLocals } from 'watr/optimize'

const isArr = Array.isArray
const HEAD = new Set(['export', 'import', 'type', 'param', 'result', 'local'])

const bodyStart = (fn) => {
  let i = typeof fn[1] === 'string' ? 2 : 1
  while (i < fn.length && isArr(fn[i]) && HEAD.has(fn[i][0])) i++
  return i
}

/** Instruction nodes of a body, or Infinity past `max` or at a loop. */
const tinySize = (fn, max) => {
  let n = 0
  const walk = (x) => {
    if (!isArr(x) || n > max) return
    if (x[0] === 'loop') { n = Infinity; return }
    n++
    for (let i = 1; i < x.length; i++) walk(x[i])
  }
  for (let i = bodyStart(fn); i < fn.length && n <= max; i++) walk(fn[i])
  return n
}

/** Splice every function of at most `max` instruction nodes into its callers, in place. */
export function inlineTiny(module, { pin = [], max = 16 } = {}) {
  if (!isArr(module) || module[0] !== 'module') return module
  const pins = new Set(pin)
  let tiny = 0
  // (a function a body names by `ref.func` is a value: watr's inliner counts only its calls)
  const refs = (x) => { if (!isArr(x)) return; if (x[0] === 'ref.func' && typeof x[1] === 'string') pins.add(x[1]); for (let i = 1; i < x.length; i++) refs(x[i]) }
  for (const n of module) {
    if (!isArr(n) || n[0] !== 'func' || typeof n[1] !== 'string') continue
    refs(n)
    if (tinySize(n, max) <= max) tiny++
    else pins.add(n[1])
  }
  if (!tiny) return module
  // watr's inliner takes one callee a round, sixteen rounds a call: call it until no
  // candidate remains (a callee it could not splice everywhere stays and stops being picked)
  const touched = new Set()
  for (let left = tiny; left > 0; left -= 16) {
    const count = module.length, reached = touched.size
    inline(module, { pin: pins, touched })
    if (module.length === count && touched.size === reached) break
  }
  if (!touched.size) return module
  for (const f of touched) propagate(f)
  coalesceLocals(vacuum(mergeBlocks(module)))
  return module
}
