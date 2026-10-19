/**
 * How far the speed tier's copies of code may grow one function.
 *
 * A specialized loop, a version beside the loop as written, an unswitched or
 * unrolled copy, a shared body spliced at a second site, a helper's fast path
 * at every site: each trades bytes for a faster path. V8 runs a function in
 * its baseline tier until the optimizing tier has compiled it, and that
 * compile takes about 2 ms a kilobyte of the function whatever the code does
 * (a loaded M-series machine): watr's `normalize`, a dispatch loop of
 * property reads and pushes, 13 ms at 7.4 KB (the size tier), 59 at 26.7 and
 * 125 at 53.7; waves' `frame`, stencils and pixel loops, 49 ms at 25.2 KB and
 * 90 at 37.9. Over 163 large functions of the corpus's speed builds, the
 * bytes predict the time as well as the bytes and the counts of blocks,
 * locals, calls and loops together. So a copy costs the same in any
 * function, and one large enough that its compile outlasts a short run
 * (watr's 24 runs spent most of their time in baseline code while
 * `normalize` compiled) takes only the copies that pay for it.
 *
 * What a copy buys depends on what its loop runs. A version of a loop (its
 * integral or specialized copy, an unswitched or kind-split one, a wide
 * accumulator) runs the loop's own arithmetic in words, vectorized, or past a
 * test it answered once; a call in the loop runs as it did. A kernel loop,
 * one calling nothing but the math kernels, the integer conversion and
 * remainder and a throw (judged in the version, where the version exists to
 * drop the loop's calls), spends every iteration in what its version speeds
 * up: waves' `frame` takes 0.77x the time with its versions (the CPU time of
 * 40 frames at 640x480, warm). A loop that calls into the runtime or the
 * program spends its iterations in the callees: watr, whose `normalize` is
 * versioned around its property reads, pushes and string indexes, runs no
 * faster for those versions with the baseline tier off (1.72 ms with them,
 * 1.66 without). So past its budget a function still versions its kernel
 * loops and makes no other copy: a version adds its loop once, so it grows
 * the function by at most its kernel loops a pass, where an unroll
 * multiplies a body by its trips, a splice adds a callee's body and a
 * per-site fast path one at every site.
 *
 * The budget is measured where each pass works, in its own units:
 * - source nodes (`nodeSize`) for the plan's copies and splices: past
 *   `SOURCE_FULL` a function takes no more but its kernel loops' versions
 *   (`kernelLoop`). Each such copy is bounded by its pass (a loop of at most
 *   800 nodes, a spliced body of at most 400), so but for its kernel loops'
 *   versions a function ends within one copy of the bound;
 * - IR nodes (`irSize`) for the optimizer's, on the function as emitted: a copy
 *   is made only where the function stays within `IR_FULL` with it (a
 *   specialized copy can be as large as the function) or the copy is of a
 *   kernel loop (`kernelLoopIR`), a per-site fast path only in a function
 *   within it.
 * The two are not one scale: a source node of numeric code emits one to three
 * IR nodes, one of dynamic code (a property read, a push) ten to thirty, which
 * only the emitted IR shows (watr's `normalize`, 1373 source nodes, emits
 * 13828; no count of the source's nodes, calls and reads predicts it within a
 * factor of three). The emitter's own copies (a typed loop's checked twin,
 * a small loop unrolled) are its kernels' speed and are left alone: gated on
 * the source size their copies reach, stdlib's ddot driver, 3125 nodes after
 * its integral copy, lost its vector loop and ran 7.5x slower.
 *
 * @module growth
 */
import { some } from './ast.js'
import { pureKernel } from './optimize/pure-funcs.js'

/** The source nodes past which a function takes no more copies but its kernel
 *  loops' versions: the inliner's caller room (a driver of three hundred
 *  kernels each called once, spliced into one function of thirty thousand
 *  lines, never left the baseline tier). The corpus's kernels copy below 2100
 *  nodes, and waves' `frame` (1305) passes it by its own kernel loops'
 *  versions; webaudio's `main` was 5674 nodes when the typed-array unroll took
 *  it to 34018, watr's `assemble` 4787 at its integral copy. */
export const SOURCE_FULL = 3000

/** The IR nodes a function may reach by the optimizer's copies of loops that
 *  call. The corpus's kernels specialize to at most 12.6K (stdlib's gamma
 *  `compute`, polytri's `decomposePolygon2Quick`); watr's `normalize` is
 *  emitted at 13.8K, and waves' `frame` reaches the specializer at 17.4K
 *  with its integral versions and leaves it at 21.9K. */
export const IR_FULL = 13000

/** Whether a source loop is a kernel's: it calls no function but Math's
 *  (`math.random` keeps a state, a call of its own). */
export const kernelLoop = (loop) => !some(loop, n => n[0] === 'new' || n[0] === '?.()' ||
  n[0] === '()' && n.length > 2 && !(typeof n[1] === 'string' && n[1].startsWith('math.') && n[1] !== 'math.random'))

// The calls a kernel makes: the math kernels, the integer conversion and
// remainder, and a throw, which never comes back to the loop.
const kernelCall = (name) => typeof name === 'string' &&
  (pureKernel(name) || name === '$__to_int32' || name === '$__rem' || name.startsWith('$__throw_'))

/** Whether IR code (a loop, or the version that would run in its place) is a
 *  kernel's: it calls nothing but `kernelCall`s. */
export const kernelLoopIR = (n) => {
  if (!Array.isArray(n)) return true
  const op = n[0]
  if (op === 'call' || op === 'return_call') { if (!kernelCall(n[1])) return false }
  else if (op === 'call_indirect' || op === 'call_ref' || op === 'return_call_indirect' || op === 'return_call_ref') return false
  for (let i = 1; i < n.length; i++) if (!kernelLoopIR(n[i])) return false
  return true
}

/** The source nodes of `node`, the inliner's cost weight too. A declaration
 *  weighs what it declares: `const x1 = v` is the store `x = v` is
 *  (prepare/split-bindings.js writes one for the other, and a body must not
 *  cross a budget by the rename). */
export const nodeSize = (node) => {
  if (!Array.isArray(node)) return 1
  let n = node[0] === 'let' || node[0] === 'const' ? 0 : 1
  for (let i = 1; i < node.length; i++) n += nodeSize(node[i])
  return n
}

/** The IR nodes of `n`: its instructions and their operand forms. */
export const irSize = (n) => {
  if (!Array.isArray(n)) return 0
  let s = 1
  for (let i = 0; i < n.length; i++) s += irSize(n[i])
  return s
}
