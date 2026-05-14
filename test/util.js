// Test utilities. ABI-aware: `JZ_ABI=<preset> npm test` re-runs the suite under
// a different rep map. Tests that don't care just call `run(code)`; tests that
// do gate with `supportsAbi('nanbox')`.
import jz, { compile } from '../index.js'
import { PRESETS } from '../abi/index.js'

export const ABI = process.env.JZ_ABI || 'nanbox'

if (!PRESETS[ABI]) {
  console.error(
    `JZ_ABI=${JSON.stringify(ABI)} is not a known preset. ` +
    `Available: ${Object.keys(PRESETS).join(', ')}.`)
  process.exit(1)
}

/** Evaluate a JS expression via jz → WASM. */
export async function evaluate(code) {
  return jz(`export let main = () => ${code}`, { abi: ABI }).exports.main()
}

/** Compile, instantiate, and wrap exports. Single source of truth via jz().
 *  Accepts an optional opts object; `opts.abi` overrides the JZ_ABI env. */
export const run = (code, opts = {}) => jz(code, { abi: ABI, ...opts }).exports

/** Compile-only — returns wasm bytes or WAT text. */
export const compileSrc = (code, opts = {}) => compile(code, { abi: ABI, ...opts })

/** True iff the active ABI matches one of `abis`. Top-of-test gate:
 *  `if (!supportsAbi('nanbox')) return` for nanbox-only assertions. */
export const supportsAbi = (...abis) => abis.includes(ABI)
