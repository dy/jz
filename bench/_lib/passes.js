// The pass rule of every engine lane (bench/README.md, after the line every case
// prints). An engine compiles a function again, optimized, only after it has run a
// while, and a wasm function's new code serves its next call, never the one running
// (wasm has no on-stack replacement): a case whose pass ends first runs its timed loop
// in the engine's baseline tier. So the program's pass (its `main`: warm-ups, timed
// runs, one result line) repeats in one process until the engine has run it SETTLE_MS,
// and the pass after that is counted. A first pass of FIRST_MS or more counts as it
// is: its warm-ups, never under 3 of 24 runs in the corpus (test/bench-build.js), alone
// outlast SETTLE_MS, so its timed runs began after it. Every pass prints its own line;
// bench.mjs reads the first and the last. JZ_BENCH_PASSES=first runs the first pass
// alone, the protocol before this rule.
import process from 'node:process'

export const SETTLE_MS = 300
export const FIRST_MS = 8 * SETTLE_MS

/** Run `pass` (sync or async) by the rule; `first`: the first pass alone. */
export const settle = async (pass, first) => {
  const t0 = performance.now()
  await pass()
  if (first || performance.now() - t0 >= FIRST_MS) return
  while (performance.now() - t0 < SETTLE_MS) await pass()
  await pass()
}

/** The runners' entry: the rule, or the first pass alone under JZ_BENCH_PASSES=first. */
export const passes = pass => settle(pass, process.env.JZ_BENCH_PASSES === 'first')

/** The rule as an expression calling `entry`, for a script with no module loader
 *  (the shells' flat file, bench.mjs writeFlat). */
export const settleSource = entry => `((SETTLE_MS, FIRST_MS) => (${settle})(${entry}))(${SETTLE_MS}, ${FIRST_MS})`
