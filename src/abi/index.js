/**
 * src/abi — internal codegen carriers.
 *
 * The `abi/` directory hosts compiler-internal codegen modules — one file per
 * value type, each exporting every carrier (slot strategy) the compiler may
 * pick for that type. **No user surface.** `opts.host` is the only knob users
 * see; internal representation is analysis-driven and per-site.
 *
 * Today the narrower has not yet been wired to pick carriers per site, so
 * each type module's `default` export is used as the carrier for every site
 * of that type. `ctx.abi.<type>` resolves to that default; codegen reads
 * `ctx.abi.string.ops.byteLen(...)` etc. Per-site dispatch arrives by
 * exposing all carriers (`ctx.abi.string.sso`, `.jsstring`) and letting
 * `narrow.js` tag each binding with a carrier choice.
 *
 * No presets, no preset-name discriminant, no public ABI knob — carrier
 * choice is analysis-driven, not user-pickable. See `.work/todo.md`
 * "Boundary protocol and internal representation" for the policy.
 *
 * @module src/abi
 */

import nanboxF64 from './number.js'
import sso, { jsstring } from './string.js'
import tagged from './object.js'

/** The default carrier bundle — what `ctx.abi` resolves to. Identity-stable
 *  reference so codegen can compare without string keys. */
export const DEFAULTS = Object.freeze({ number: nanboxF64, string: sso, object: tagged })

// Carrier re-exports — for tests and tools that want to reach a specific
// carrier directly. Per-site narrowing will use these via `ctx.abi.<type>`
// once the narrower exposes the full carrier dictionary.
export { nanboxF64, sso, jsstring, tagged }
