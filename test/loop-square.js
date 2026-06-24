// Bounded-square narrowing (src/compile/loop-square.js): `i*i` under an `i*i < CONST`
// (CONST ≤ 2³⁰) guard is carried as i32 (rewritten to Math.imul) instead of f64 — the
// Sieve-of-Eratosthenes shape `for(i; i*i<LIMIT; i++) for(j=i*i; j<LIMIT; j+=i) …`.
//
// Soundness rests on two facts, pinned below: (1) the guard constant ≤ 2³⁰ keeps the
// product < 2³¹ even at the loop EXIT (where i*i is computed before the `<` test and
// overshoots the bound), so Math.imul(i,i) == i*i; (2) the IV is +1-incremented and not
// otherwise mutated. Outside that envelope the product MUST stay f64.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel } from './_matrix.js'
import parseWat from 'watr/parse'

const loopHasF64Mul = (src, opt = 2) => {
  const tree = parseWat(compile(src, { optimize: opt, wat: true }))
  let hit = false
  const walk = (n, inLoop) => {
    if (!Array.isArray(n)) return
    const here = inLoop || n[0] === 'loop'
    if (here && n[0] === 'f64.mul') hit = true
    for (let i = 1; i < n.length; i++) walk(n[i], here)
  }
  walk(tree, false)
  return hit
}
// sieve of Eratosthenes, internal Int32Array, const bound — counts primes below n.
const sieveSrc = (n) => `export let f = () => {
  const c = new Int32Array(${n}); let count = 0
  for (let i = 2; i * i < ${n}; i++) { if (c[i] === 0) { count = count + 1 | 0; for (let j = i * i; j < ${n}; j = j + i) c[j] = 1 } }
  let t = 0; for (let k = 2; k < ${n}; k++) if (c[k] === 0) t = t + 1 | 0
  return t | 0
}`
const primesBelow = (n) => { const c = new Int32Array(n); for (let i = 2; i * i < n; i++) if (!c[i]) for (let j = i * i; j < n; j += i) c[j] = 1; let t = 0; for (let k = 2; k < n; k++) if (!c[k]) t++; return t }

// ── narrowing fires (structural) ──────────────────────────────────────────────
test('loopSquare: ablation — `i*i < CONST` (CONST ≤ 2³⁰) carries i32, not f64', () => {
  if (onKernel()) return  // kernel runs optimize:false; this inspects optimize:2 WAT
  const src = `export let f = () => { const c = new Int32Array(1000); for (let i = 2; i * i < 1000; i++) { c[i & 1023] = i } return 0 }`
  ok(loopHasF64Mul(src, { loopSquare: false }), 'control: f64.mul in loop with pass OFF')
  ok(!loopHasF64Mul(src, 2), 'INVARIANT: no f64.mul in loop with pass ON (i*i → Math.imul)')
})

test('loopSquare: the whole sieve narrows — no f64.mul in any loop', () => {
  if (onKernel()) return
  ok(!loopHasF64Mul(sieveSrc(1000), 2), 'sieve product/counter chain is i32 end-to-end')
})

// ── soundness boundaries: MUST stay f64 outside the proven envelope ────────────
test('loopSquare: SOUND — only narrows within the envelope', () => {
  if (onKernel()) return
  const mul = (src) => loopHasF64Mul(src, 2)  // true = stayed f64 (not narrowed)
  ok(!mul(`export let f = (c) => { for (let i = 2; i * i < 1073741824; i++) c[i & 3] = 1; return 0 }`), 'bound = 2³⁰ exactly → narrows')
  ok(mul(`export let f = (c) => { for (let i = 2; i * i < 1073741825; i++) c[i & 3] = 1; return 0 }`), 'bound = 2³⁰+1 → stays f64 (exit could overflow)')
  ok(mul(`export let f = (c, m) => { for (let i = 2; i * i < m; i++) c[i & 3] = 1; return 0 }`), 'variable bound → stays f64 (unknown range)')
  ok(mul(`export let f = () => { const c = new Int32Array(64); for (let i = 2; i * i < 1000; i++) { i = i + 3 | 0; c[i & 63] = 1 } return 0 }`), 'IV reassigned in body → stays f64')
  ok(mul(`export let f = (c) => { for (let i = 2; i * i < 1000; i = i + 2) c[i & 3] = 1; return 0 }`), 'non-+1 step → stays f64')
})

// ── correctness, including the exit overshoot (i*i ≥ bound, evaluated narrowed) ─
test('loopSquare: sieve bit-exact vs JS (incl. exit-overshoot at 2³⁰)', () => {
  for (const n of [100, 1000, 100000]) is(jz(sieveSrc(n), { optimize: 2 }).exports.f(), primesBelow(n), `primes below ${n}`)
  // No array (32k iters): the exit iteration computes i*i ≥ bound — must match JS even narrowed.
  for (const B of [1073741824, 1073741823, 1000000000]) {
    const src = `export let f = () => { let cnt = 0; for (let i = 2; i * i < ${B}; i++) cnt = cnt + 1 | 0; return cnt | 0 }`
    const ref = (() => { let cnt = 0; for (let i = 2; i * i < B; i++) cnt = cnt + 1 | 0; return cnt | 0 })()
    is(jz(src, { optimize: 2 }).exports.f(), ref, `exit-overshoot count at bound ${B}`)
  }
})
