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
 * A call the program's own loop makes runs as often as the loop, and V8's
 * optimizing compiler, which inlines, does so within a budget its caller's
 * size sets, scaled by the module's share of functions under 50 bytes (read
 * as what its toolchain left to inline). At a jz module's share (7-29%) V8 14
 * takes the floor: the caller may grow by its own size, and past 640 wire
 * bytes by a tenth (the smaller of twice its bytes and the larger of 700 and
 * 1.1 times them). A loop formatting a record calls a digit count, a
 * conversion, a string's length and copy; its kernel of 738 bytes had room
 * for one of them, every other a call per record (strbuild: 14% of its time).
 * An engine without an inliner never splices at all. There the compiler
 * splices: a call takes the larger bound `loop` (watr's own, 90 nodes) where
 * the innermost loop around it, in a `user` function, makes it on every
 * iteration (outside the arms of an `if` within the loop) and calls nothing
 * but the runtime (no function of the program, no import, no indirect call).
 * Such a loop is a kernel whose work is the runtime it calls; a loop that
 * calls the program spends its time there, and an arm may run once in many
 * iterations (a loop's compaction runs once per 64 KiB it keeps, forwarding
 * every root: webaudio's speed build grew 38% when those joined). The sites
 * call a copy of the callee the inliner dissolves into them alone; every
 * other caller keeps the call.
 *
 * The callee qualifies by size alone: at most `max` instruction nodes (or
 * `loop`, at a loop's call), no loop (a loop is work enough to pay its call).
 * watr's inliner does the splice and its own checks (named locals, one
 * result, no recursion, no tail call, no reference other than a direct call);
 * `pin` keeps the functions the other passes need whole. After the splices
 * the touched callers propagate the arguments into the bodies, as watr's own
 * inlining round does.
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

const copy = (x) => isArr(x) ? x.map(copy) : x
const exported = (fn) => fn.some(x => isArr(x) && x[0] === 'export')
const calls = (x, name) => isArr(x) && (x[0] === 'call' && x[1] === name || x.some(c => calls(c, name)))
const funcs = (module) => module.filter(n => isArr(n) && n[0] === 'func' && typeof n[1] === 'string')
const drop = (module, which) => { for (let i = module.length - 1; i >= 0; i--) if (isArr(module[i]) && module[i][0] === 'func' && which(module[i])) module.splice(i, 1) }

/** Rename the target of every call `names` maps, in the bodies of `fns`, in place. */
const retarget = (fns, names) => {
  const walk = (x) => {
    if (!isArr(x)) return
    if (x[0] === 'call' && names.has(x[1])) x[1] = names.get(x[1])
    for (let i = 1; i < x.length; i++) walk(x[i])
  }
  for (const n of fns) for (let i = bodyStart(n); i < n.length; i++) walk(n[i])
}

const INDIRECT = new Set(['call_indirect', 'return_call_indirect', 'call_ref', 'return_call_ref'])

/** Whether code calls only the `runtime`: no function of the program, no import, no indirect call. */
const runtimeOnly = (x, runtime) => {
  if (!isArr(x)) return true
  if (INDIRECT.has(x[0]) || (x[0] === 'call' || x[0] === 'return_call') && !runtime(x[1])) return false
  for (let i = 1; i < x.length; i++) if (!runtimeOnly(x[i], runtime)) return false
  return true
}

/** Point each call to a function `warm` maps that the innermost loop around it makes on every
 *  iteration (outside the arms of an `if` within it), where that loop calls only the `runtime`, at
 *  the copy `warm` names, in the bodies of `fns`, in place. */
const leafLoopSites = (fns, warm, runtime) => {
  const walk = (x, hot) => {
    if (!isArr(x)) return
    if (x[0] === 'loop') hot = runtimeOnly(x, runtime)
    else if (x[0] === 'then' || x[0] === 'else') hot = false
    if (hot && x[0] === 'call' && warm.has(x[1])) x[1] = warm.get(x[1])
    for (let i = 1; i < x.length; i++) walk(x[i], hot)
  }
  for (const n of fns) for (let i = bodyStart(n); i < n.length; i++) walk(n[i], false)
}

/** Splice every function of at most `max` instruction nodes into its callers, and one of at most
 *  `loop` into the calls a loop of a `user` function makes where that loop calls only the
 *  runtime, in place. */
export function inlineTiny(module, { pin = [], max = 16, loop = max, user = () => true } = {}) {
  if (!isArr(module) || module[0] !== 'module') return module
  const pins = new Set(pin)
  const fns = funcs(module)
  // (a function a body names by `ref.func` is a value: watr's inliner counts only its calls)
  const refs = (x) => { if (!isArr(x)) return; if (x[0] === 'ref.func' && typeof x[1] === 'string') pins.add(x[1]); for (let i = 1; i < x.length; i++) refs(x[i]) }
  for (const n of fns) refs(n)
  let tiny = 0
  const warm = new Map()   // name → its loop copy's name
  for (const n of fns) {
    const size = tinySize(n, Math.max(max, loop))
    if (size <= max) { tiny++; continue }
    // (one calling itself would splice a level of itself)
    if (size <= loop && !pins.has(n[1]) && !exported(n) && !calls(n, n[1])) warm.set(n[1], `${n[1]}$loop`)
    pins.add(n[1])
  }
  if (warm.size) {
    const defined = new Set(fns.map(n => n[1]))
    leafLoopSites(fns.filter(n => user(n[1])), warm, name => defined.has(name) && !user(name))
    const called = new Set()
    for (const n of funcs(module)) for (const name of warm.values()) if (!called.has(name) && calls(n, name)) called.add(name)
    for (const n of fns) if (called.has(warm.get(n[1]))) { module.push(['func', warm.get(n[1]), ...copy(n.slice(2))]); tiny++ }
    for (const name of [...warm.keys()]) if (!called.has(warm.get(name))) warm.delete(name)
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
  if (warm.size) {
    // (a copy the inliner could not lift goes: its sites call the function again)
    const back = new Map([...warm].map(([name, copied]) => [copied, name]))
    drop(module, n => back.has(n[1]))
    retarget(funcs(module), back)
    // (a function only loops called goes with its last call)
    const named = new Set()
    const names = (x) => { for (let i = 1; i < x.length; i++) isArr(x[i]) ? names(x[i]) : warm.has(x[i]) && named.add(x[i]) }
    for (const n of module) if (isArr(n)) names(n[0] === 'func' ? n.slice(1) : n)
    drop(module, n => warm.has(n[1]) && !named.has(n[1]))
  }
  if (!touched.size) return module
  for (const f of touched) propagate(f)
  coalesceLocals(vacuum(mergeBlocks(module)))
  return module
}
