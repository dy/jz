/**
 * How far the speed tier's copies of code may grow one function.
 *
 * A specialized loop, a version beside the loop as written, an unswitched or
 * unrolled copy, a shared body spliced at a second site, a helper's fast path
 * at every site: each trades bytes for a faster path, and in a kernel the trade
 * pays. In a large function it does not. V8 runs a function in its baseline
 * tier until the optimizing tier has compiled it, and that compile grows faster
 * than the function: watr's `normalize`, 7 KB at the size tier and 55 KB at the
 * speed tier, took 20 ms of TurboFan against 437 (a loaded M-series machine),
 * longer than the bench's 24 runs, which spent most of their time in baseline
 * code (2.6x V8 on x64; with the baseline tier off, 0.68x). So a copy is made
 * while its function is not large, and a large function keeps its code as
 * written.
 *
 * Large is measured where each pass works, in its own units:
 * - source nodes (`nodeSize`) for the plan's copies and splices: a function past
 *   `SOURCE_FULL` takes no more. Each such copy is bounded by its pass (a loop
 *   of at most 800 nodes, a spliced body of at most 400), so a function ends
 *   within one copy of the bound;
 * - IR nodes (`irSize`) for the optimizer's, on the function as emitted: a copy
 *   is made only where the function stays within `IR_FULL` with it (a
 *   specialized copy can be as large as the function), a per-site fast path
 *   only in a function within it.
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

/** The source nodes past which a function takes no more copies: the inliner's
 *  caller room (a driver of three hundred kernels each called once, spliced
 *  into one function of thirty thousand lines, never left the baseline tier).
 *  The corpus's kernels copy below 2100 nodes; webaudio's `main` was 5674
 *  nodes when the typed-array unroll took it to 34018, watr's `assemble` 4787
 *  at its integral copy. */
export const SOURCE_FULL = 3000

/** The IR nodes a function may reach by the optimizer's copies. The corpus's
 *  kernels specialize to at most 12.6K (stdlib's gamma `compute`, polytri's
 *  `decomposePolygon2Quick`); watr's `normalize` is emitted at 13.8K. */
export const IR_FULL = 13000

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
