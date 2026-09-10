// Test utilities. Thin pass-throughs to jz / compile — no preset gating.
// Internal representation is analysis-driven; tests assert behaviour and IR
// shape, not preset names. Boundary variants belong on `opts.host`.
import jz, { compile } from '../index.js'
import { is } from 'tst/assert.js'

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

/** Compile to WAT text. */
export const wat = (code, opts = {}) => compile(code, { ...opts, wat: true })

/** The same module evaluated by the host: every `export` binding of `src`, as
 *  Node computes it. The differential oracle — "valid jz = valid JS". */
export function oracle(src) {
  const pairs = [...src.matchAll(/\bexport\s+(?:async\s+)?(?:let|const|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g)].map(m => [m[1], m[1]])
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g))
    for (const part of m[1].split(',')) { const as = part.trim().split(/\s+as\s+/); if (as[0]) pairs.push([as[as.length - 1], as[0]]) }
  const body = src.replace(/\bexport\s*\{[^}]*\}\s*;?/g, '').replace(/\bexport\s+default\s+/g, '').replace(/\bexport\s+(?=(?:async\s+)?(?:let|const|var|function|class)\b)/g, '')
  return new Function(`${body}\nreturn { ${pairs.map(([k, v]) => k === v ? k : k + ': ' + v).join(', ')} }`)()
}

/** Assert that jz and the host agree on `exports[name](...args)`; returns the value. */
export const agree = (src, name, args = [], opts, label) => {
  const want = oracle(src)[name](...args), got = run(src, opts)[name](...args)
  is(got, want, label || `${name}(${args.map(String).join(', ')}): ${src.replace(/\s+/g, ' ').trim().slice(0, 72)}`)
  return got
}

/** One module for several single-function programs — each an arrow source, or a
 *  whole `export let f = <arrow>` program with nothing else in it — returning their
 *  compiled functions in order. One compile where each would have been one. */
export const batch = (srcs, opts) => {
  const fns = run(srcs.map((s, i) => `export let c${i} = ${s.replace(/^\s*export\s+let\s+f\s*=\s*/, '')}`).join('\n'), opts)
  return srcs.map((_, i) => fns[`c${i}`])
}

/** A table of programs as one compile. Each row is [label, src, want, ...args]:
 *  `src` is an arrow, batched with the other arrow rows, or a whole program
 *  beginning with `export`, compiled alone (its export `f` is called).
 *  Asserts `f(...args)` equals `want` under `label`. */
export const cases = (rows, opts) => {
  const arrow = (src) => !/^\s*export\b/.test(src)
  const shared = batch(rows.filter(([, src]) => arrow(src)).map(([, src]) => src), opts)
  let k = 0
  for (const [label, src, want, ...args] of rows) {
    const f = arrow(src) ? shared[k++] : run(src, opts).f
    is(f(...args), want, label)
  }
}

/** One function's text out of a WAT module, by paren matching — slicing to the next
 *  `(func` would overrun into lifted closures and give false positives. */
export function funcWat(text, name) {
  const m = new RegExp(`\\(func \\$${name.replace(/[$]/g, '\\$')}(?=[\\s)])`).exec(text)
  if (!m) return ''
  let depth = 0
  for (let i = m.index; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(m.index, i + 1)
  }
  return text.slice(m.index)
}

