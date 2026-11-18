// The pass rule of every engine lane (bench/README.md, after the line every case
// prints). An engine compiles a function again, optimized, only after it has run a
// while, and a wasm function's new code serves its next call, never the one running
// (wasm has no on-stack replacement): a case whose pass ends first runs its timed loop
// in the engine's baseline tier. So the program's pass (its `main`: warm-ups, timed
// runs, one result line) repeats in one process until the engine has run it SETTLE_MS,
// and the pass after that is counted. A first pass of FIRST_MS or more counts as it
// is: its warm-ups, never under 3 of 24 runs in the corpus (test/bench-build.js), alone
// outlast SETTLE_MS, so its timed runs began after it. Every pass prints its own line,
// and the rule prints `passes=<n>` after the last: bench.mjs holds the lines to that
// count, so a pass whose line went missing, or a process that ended before the rule
// did, fails the run instead of reading as one long first pass. JZ_BENCH_PASSES=first
// runs the first pass alone, the protocol before this rule; a count runs that many
// (bench.mjs asks a case's source whether its main carries state with two).
import process from 'node:process'

export const SETTLE_MS = 300
export const FIRST_MS = 8 * SETTLE_MS

/** Run `pass` (sync or async) by the rule, or `n` times; answer how many passes ran. */
export const settle = async (pass, n) => {
  const t0 = performance.now()
  let k = 0
  if (n) {
    while (k < n) { await pass(); k++ }
    return k
  }
  await pass(); k++
  if (performance.now() - t0 >= FIRST_MS) return k
  while (performance.now() - t0 < SETTLE_MS) { await pass(); k++ }
  await pass()
  return k + 1
}

/** JZ_BENCH_PASSES: unset, the rule (0); 'first', one pass; or a count. */
export const countOf = mode => !mode ? 0 : mode === 'first' ? 1 : /^[1-9]\d*$/.test(mode) ? +mode
  : (() => { throw Error(`JZ_BENCH_PASSES=${mode}: 'first' or a count of passes`) })()

/** The runners' entry: the rule, or JZ_BENCH_PASSES's count, and the count it ran. */
export const passes = async pass => console.log(`passes=${await settle(pass, countOf(process.env.JZ_BENCH_PASSES))}`)

/** The rule as an expression calling `entry`, for a script with no module loader
 *  (the shells' flat file, bench.mjs writeFlat, where `console.log` is the shell's print). */
export const settleSource = entry => `((SETTLE_MS, FIRST_MS) => (${settle})(${entry}).then(n => console.log('passes=' + n)))(${SETTLE_MS}, ${FIRST_MS})`
