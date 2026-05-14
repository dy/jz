/**
 * src/abi — internal codegen carriers.
 *
 * The `abi/` directory hosts compiler-internal codegen modules — one file per
 * value type, each exporting every carrier (slot strategy) the compiler may
 * pick for that type. **No user surface.** `opts.host` is the only knob
 * users see; internal representation is analysis-driven and per-site.
 *
 * Today the narrower has not yet been wired to pick carriers per site, so
 * one carrier per type is reached as the "default" — the one a type's
 * module exports as `default`. `ctx.abi.<type>` resolves to that carrier;
 * codegen reads `ctx.abi.string.ops.byteLen(...)` etc. Per-site dispatch
 * arrives by exposing all carriers (`ctx.abi.string.sso`, `.jsstring`) and
 * letting `narrow.js` tag each binding with a carrier choice.
 *
 * ## Transition notes
 *
 * `PRESETS`, `DEFAULT_PRESET`, `presetName`, `resolve` still exist as the
 * back-compat surface that `opts.abi` rides on. They're not the long-term
 * shape — see `.work/todo.md` "Boundary protocol and internal representation"
 * for the direction (presets are an internal default-bundle, not a user-
 * facing knob; `opts.host` replaces `opts.abi`). For now this module
 * preserves the existing wiring so the rename stays a no-op.
 *
 * @module src/abi
 */

import nanboxF64 from './number.js'
import sso from './string.js'
import { jsstring } from './string.js'

/** Named, internally-bundled carrier combinations.
 *
 *  These are *default-bundles* — what `ctx.abi` resolves to before per-site
 *  narrowing tags any binding. They are not a user surface; `opts.abi`
 *  remains as a transitional pass-through while `opts.host` plumbing lands.
 *
 *    nanbox          — f64 carrier with NaN-boxed pointers. Default.
 *                      strings: sso (≤4 ASCII chars inline, else heap).
 *    nanbox+jsstring — same number carrier; string carrier *announces* as
 *                      jsstring (the `jz:abi` discriminant records this)
 *                      but ops still route through `sso` until the 9-item
 *                      compiler-wide checklist in `string.js` lands. The
 *                      dispatch path (preset → carrier → ops → call sites)
 *                      is wired; only the codegen converges with `nanbox`.
 */
export const PRESETS = {
  nanbox: { number: nanboxF64, string: sso },
  'nanbox+jsstring': { number: nanboxF64, string: sso },
}

/** Default bundle when `opts.abi` is omitted. */
export const DEFAULT_PRESET = 'nanbox'

/**
 * Resolve `opts.abi` into a `{ <type>: carrier }` lookup object.
 * Accepts only a preset name. Free-form maps are not supported — internal
 * bundles are the unit of testing, and ad-hoc mixes have no driver.
 *
 * Throws on unknown preset; returns the canonical bundle *object* (identity-
 * stable across calls) so consumers can check `abi === PRESETS[DEFAULT_PRESET]`.
 */
export const resolve = (abi = DEFAULT_PRESET) => {
  if (typeof abi !== 'string') {
    throw new TypeError(`opts.abi must be a preset name string. Available: ${Object.keys(PRESETS).join(', ')}.`)
  }
  const preset = PRESETS[abi]
  if (!preset) {
    throw new Error(`abi: unknown preset '${abi}'. Available: ${Object.keys(PRESETS).join(', ')}.`)
  }
  return preset
}

/** Reverse lookup: carrier bundle → preset name, or null. Identity comparison —
 *  callers must pass an object obtained from `resolve()` or `PRESETS[*]`. */
export const presetName = (abi) => {
  for (const name of Object.keys(PRESETS)) if (PRESETS[name] === abi) return name
  return null
}

// Carrier re-exports — for tests and tools that want to reach a specific
// carrier without going through a preset. Per-site narrowing will use these
// directly once `ctx.abi.<type>` exposes the full carrier dictionary.
export { nanboxF64, sso, jsstring }
