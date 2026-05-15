// Test utilities. Thin pass-throughs to jz / compile — no preset gating.
// Internal representation is analysis-driven; tests assert behaviour and IR
// shape, not preset names. Boundary variants belong on `opts.host`.
import jz, { compile } from '../index.js'

/** Evaluate a JS expression via jz → WASM. */
export async function evaluate(code) {
  return jz(`export let main = () => ${code}`).exports.main()
}

/** Compile, instantiate, and wrap exports. */
export const run = (code, opts = {}) => jz(code, opts).exports

/** Compile-only — returns wasm bytes or WAT text. */
export const compileSrc = (code, opts = {}) => compile(code, opts)
