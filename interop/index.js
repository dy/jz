/**
 * jz/interop — host-side ABI umbrella.
 *
 * Single entry point that sniffs each wasm module's `jz:abi` custom section
 * (emitted by jz.compile when the ABI deviates from the default `nanbox`
 * preset) and dispatches to the matching ABI driver. Wasm without the
 * section — legacy output, or anything compiled at the default preset —
 * falls through to the `nanbox` driver, preserving identical behavior for
 * everything compiled before the ABI machinery existed.
 *
 *     import { instantiate } from 'jz/interop'
 *     const { exports, memory } = instantiate(wasmBytes)
 *
 * `jz/interop/nanbox` is still importable directly when you know the wasm
 * is nanbox and want to skip the one-time sniff (~µs saved). The other
 * helpers (`memory`, `wrap`, `ptr`, …) are re-exported from this umbrella
 * because they're nanbox-codec utilities the host commonly wants alongside
 * `instantiate`; alternate-preset drivers will override them when they land.
 *
 * Section payload is the preset name as UTF-8 bytes (e.g. `nanbox+jsstring`)
 * — no JSON, no per-type map. The compiler-side `abi/index.js` PRESETS table
 * is the single source of truth for what a preset means; the host only needs
 * the name to pick a driver.
 *
 * @module jz/interop
 */

import * as nanbox from './nanbox.js'
import { customSection } from './_shared.js'

// Driver table — one entry per preset. Each driver exposes at minimum
// `instantiate(mod, opts)`. Today `nanbox` handles every preset whose wasm
// shape hasn't diverged from the baseline (the section name records intent;
// runtime behavior matches until a real driver lands).
const DRIVERS = {
  nanbox,
  // 'nanbox+jsstring' aliased to nanbox until a driver that wires
  // wasm:js-string externref imports lands. The recorded section name still
  // lets host code branch on intent if it wants to.
  'nanbox+jsstring': nanbox,
}

const sniffPreset = (mod) => {
  const bytes = customSection(mod, 'jz:abi')
  if (!bytes) return 'nanbox'   // legacy + default-preset wasm
  const name = new TextDecoder().decode(bytes)
  if (DRIVERS[name]) return name
  // Recorded a preset we don't have a driver for. Surface clearly — silent
  // fallback to nanbox would marshal wrong once codegen actually diverges.
  throw new Error(
    `jz/interop: wasm declares ABI preset '${name}' but no host driver matches. ` +
    `Available drivers: ${Object.keys(DRIVERS).join(', ')}.`)
}

/**
 * Instantiate a jz-compiled wasm module under the right host driver.
 * Accepts `Uint8Array`, `ArrayBuffer`, or a pre-built `WebAssembly.Module`.
 */
export const instantiate = (input, opts = {}) => {
  const mod = input instanceof WebAssembly.Module
    ? input
    : new WebAssembly.Module(input instanceof Uint8Array ? input : new Uint8Array(input))
  const preset = sniffPreset(mod)
  const driver = DRIVERS[preset]
  if (!driver) throw new Error(`jz/interop: no driver registered for preset '${preset}'`)
  return driver.instantiate(mod, opts)
}

// Nanbox-codec helpers, re-exported for callers that work with NaN-boxed
// values directly (memory marshaling, pointer inspection). Alternate-preset
// drivers can override these when they land — until then, these are the
// only codec helpers jz ships.
export const memory = nanbox.memory
export const wrap = nanbox.wrap
export const ptr = nanbox.ptr
export const offset = nanbox.offset
export const type = nanbox.type
export const aux = nanbox.aux
export const i64ToF64 = nanbox.i64ToF64
export const f64ToI64 = nanbox.f64ToI64
export const coerce = nanbox.coerce
export const NULL_NAN = nanbox.NULL_NAN
export const UNDEF_NAN = nanbox.UNDEF_NAN
