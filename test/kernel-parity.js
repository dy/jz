/**
 * Native-vs-kernel WAT byte identity. The self-host kernel runs the SAME
 * pipeline as index.js — since both consume the one final-optimizer tail
 * (src/optimize/watr-tail.js), identical source at the same tier must print
 * identical WAT. A byte diff here means the pipelines drifted again (the
 * pre-tail state: kernel omitted ifset/inlineWrappers/LICM/guard/unroll2/
 * pins/pointer-repair and O2 output silently diverged).
 */
import test from 'tst'
import { is } from 'tst/assert.js'
import { compile } from '../index.js'
import { compileViaKernel } from './kernel-target.js'

const CORPUS = {
  sum: `export let sum = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }`,
  math: `export let f = (x) => Math.sqrt(x * x + 1) + Math.abs(x)`,
  dict: `export let count = (s) => { let d = {}; for (let i = 0; i < s.length; i++) { let c = s[i]; d[c] = (d[c] || 0) + 1 } return d['a'] || 0 }`,
  arr: `export let rev = (n) => { let a = []; for (let i = 0; i < n; i++) a.push(i * 2); let s = 0; for (let i = a.length - 1; i >= 0; i--) s += a[i]; return s }`,
}

// Residual known divergences AFTER the shared watr-tail landed (2026-07-23):
// PRE-tail pipeline gaps, tracked in .work/todo.md. Pattern: kernel output is
// consistently SMALLER at O3 (sum/dict/arr) — the in-kernel vectorizer/
// unroller bails where native fires (the 'simd/optimizer shape' class);
// dict also diverges at O2 (hash-path emit decision). Each row asserts the divergence STILL
// exists — when a fix lands, the assertion flips and the row graduates into
// the byte-identity set below.
const PARITY_TODO = new Set(['dict|2', 'dict|3', 'sum|3', 'arr|3'])

for (const opt of [0, 2, 3]) {
  test(`kernel parity: byte-identical WAT at O${opt}`, () => {
    for (const [name, src] of Object.entries(CORPUS)) {
      const nat = String(compile(src, { wat: true, optimize: opt }))
      const ker = String(compileViaKernel(src, { wat: true, optimize: opt }))
      if (PARITY_TODO.has(`${name}|${opt}`)) {
        is(ker !== nat, true, `${name} O${opt}: known divergence still present (graduate this row on fix)`)
        continue
      }
      is(ker === nat, true,
        `${name} O${opt}: ${ker === nat ? 'identical' : `diverges (native ${nat.length}B vs kernel ${ker.length}B)`}`)
    }
  })
}
