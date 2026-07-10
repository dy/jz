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

/** Distance between two f64s in ULPs, via the standard monotonic bit-ordinal mapping
 *  (Bruce Dawson's "Comparing Floating Point Numbers"): map each f64's bit pattern to
 *  a same-signed 64-bit ordinal so ordinal order matches value order, then diff. NaN
 *  pairs (both NaN) are 0 apart; a NaN vs a non-NaN is Infinity apart. */
export function ulpDiff(a, b) {
  if (Object.is(a, b)) return 0
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity
  const buf = new ArrayBuffer(8)
  const f64v = new Float64Array(buf), u64v = new BigUint64Array(buf)
  const ord = (x) => { f64v[0] = x; const u = u64v[0]; return u < 0x8000000000000000n ? u + 0x8000000000000000n : 0xFFFFFFFFFFFFFFFFn - u }
  const oa = ord(a), ob = ord(b)
  return Number(oa > ob ? oa - ob : ob - oa)
}
