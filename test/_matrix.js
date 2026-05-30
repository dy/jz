/**
 * Test-matrix axis awareness (optimize level + host).
 *
 * `npm run test:opt0|opt1|opt3` set `JZ_TEST_OPTIMIZE` and `test:wasi` sets
 * `JZ_TEST_HOST`, which index.js applies as compile defaults. Most tests assert
 * behaviour (correctness) and run on every leg. Two families don't:
 *
 *  1. Optimizer-OUTPUT pins — binary-size thresholds, "this pass eliminated X",
 *     SIMD advisories, vectorized-vs-baseline equality — whose premise only holds
 *     once the relevant pass ran. Guard with `if (belowOpt(N)) return`.
 *  2. JS-host-only behaviour — host/env imports, tagged-template interpolation of
 *     live JS values, externref/js-string interop, external (host) objects, host
 *     timer wiring, and the callable-`run`-export-returns-a-value pattern (`run` is
 *     the reserved void WASI command entry). These can't apply under the hostless
 *     WASI boundary. Guard with `if (onWasi()) return`.
 *
 * Guarding (vs deleting) keeps each test live on the legs where it IS meaningful.
 *
 * @module test/_matrix
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

/** Resolved compile host for this run ('js' default; 'wasi' under test:wasi). */
export const HOST = process.env.JZ_TEST_HOST || 'js'

/** True under the hostless WASI boundary — a JS-host-only assertion (env/host imports,
 *  template-interpolated JS values, externref/js-string, external objects, host timers,
 *  callable-`run`-returns-value) can't apply, so the test should `return` early. */
export const onWasi = () => HOST === 'wasi'

/** True under the self-host kernel target (test:wasm, JZ_TEST_TARGET=jz.wasm), where
 *  jz.compile routes through the jz.wasm KERNEL — jz's own pipeline compiled to wasm by
 *  jz. The kernel takes a RAW parsed AST and owns reset+jzify+prepare+compile internally,
 *  so host-side options that shape compilation never reach it: optimize level (SIMD,
 *  dead-code/size pins), imports/modules/memory wiring, inspect/wat output. Tests that
 *  assert those — optimizer-output shape, emitted-WAT structure, host-bridge behaviour —
 *  cannot hold here (distinct from a genuine value miscompile, which is a real bug).
 *  Guard with `if (onKernel()) return`. */
export const onKernel = () => process.env.JZ_TEST_TARGET === 'jz.wasm'
