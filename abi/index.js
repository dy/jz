/**
 * jz/abi — per-type rep registry and tested presets.
 *
 * A **rep** is the strategy for representing one JS type in wasm (carrier
 * slot, codegen hooks, peephole rules). Each rep lives in
 * `abi/<type>/<rep>.js` and is imported here.
 *
 * A **preset** is a tested combination of reps — what `opts.abi: 'nanbox'`
 * actually resolves to. Preset values are the rep modules themselves (not
 * name strings), so `ctx.abi.<type>` directly references the rep object —
 * no name-indirection table, no lookup pass.
 *
 * Adding a rep:
 *   1. Drop `abi/<type>/<rep>.js` next to its siblings.
 *   2. Add it to the relevant preset entry below (or define a new preset).
 *   3. Wire any compiler hook that branches on it (today: optimize.js).
 *
 * @module jz/abi
 */

import numberNanboxF64 from './number/nanbox-f64.js'
import stringJsstring from './string/jsstring.js'

/** Named, tested rep combinations. Values are rep modules — direct refs, no
 *  string-name indirection. Future presets list aspirationally below; they
 *  land here as their reps land.
 *
 *    nanbox          — f64 carrier with NaN-boxed pointers. Default.
 *    nanbox+jsstring — same, but strings are externref via JS String Builtins
 *                      (scaffold today — codegen still nanbox until module/string.js
 *                      routes through ctx.abi.string. Section emit + dispatch already
 *                      observable: the preset name lands in the wasm and the host
 *                      picks the matching driver).
 *    flat            — typed slots (i32/f64/ptr+len/struct); no nan-box.
 *    gc              — wasm-gc (stringref, array, struct).
 */
export const PRESETS = {
  nanbox: { number: numberNanboxF64 },
  'nanbox+jsstring': { number: numberNanboxF64, string: stringJsstring },
}

/** Preset picked when `opts.abi` is omitted. */
export const DEFAULT_PRESET = 'nanbox'

/**
 * Resolve `opts.abi` into a `{ <type>: rep }` lookup object.
 * Accepts only a preset name. Free-form maps are not supported — preset
 * combinations are the unit of testing, and ad-hoc mixes have no driver.
 *
 * Throws on unknown preset; returns the canonical preset *object* (identity-
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

/** Reverse lookup: rep map → preset name, or null. Identity comparison —
 *  callers must pass an object obtained from `resolve()` or `PRESETS[*]`. */
export const presetName = (abi) => {
  for (const name of Object.keys(PRESETS)) if (PRESETS[name] === abi) return name
  return null
}
