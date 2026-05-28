/**
 * Optimize-level awareness for the test matrix.
 *
 * `npm run test:opt0|opt1|opt3` set `JZ_TEST_OPTIMIZE`, which index.js applies as the
 * default optimize level. Most tests assert behaviour (correctness) and run at every
 * level. A handful are optimizer-OUTPUT pins — binary-size thresholds, "this pass
 * eliminated X", SIMD advisories, vectorized-vs-baseline equality — whose premise only
 * holds once the relevant pass has run. Those guard with `if (belowOpt(N)) return` so
 * they skip (not false-fail) below the level they target, keeping `test:matrix:full`
 * meaningful at every level.
 *
 * @module test/_opt
 */

const env = process.env.JZ_TEST_OPTIMIZE

/** Resolved optimize level for this run. Mirrors index.js TEST_ENV_DEFAULTS:
 *  no env → compiler default (2); `false` → 0; `size` → 2; `speed` → 3; numeric → itself. */
export const OPT_LEVEL =
  env == null ? 2
  : env === 'false' ? 0
  : /^-?\d+$/.test(env) ? Number(env)
  : env === 'size' ? 2
  : env === 'speed' ? 3
  : 2

/** True when this run's optimize level is below `min` — an optimizer-output assertion
 *  can't hold, so the test should `return` early instead of asserting a false regression. */
export const belowOpt = (min) => OPT_LEVEL < min
