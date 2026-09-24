// Statement scheduling (watr's schedule, enabled by jz with its math runtime vouched
// pure: src/optimize/watr-tail.js): within a straight-line run, statements go by
// the longest chain of work still depending on them, so independent kernel calls
// start together. Every case is a differential against the same program with the
// pass off: the bits never change. The pass's own unit cases live with it, in
// watr's test/schedule.js.
import test from 'tst'
import { is } from 'tst/assert.js'
import { funcWat as funcWatOf, run, wat } from './util.js'

const ON = { optimize: 'speed' }
const OFF = { optimize: { level: 'speed', scheduleStatements: false } }
/** The function's WAT, under its own name or its export wrapper's. */
const funcWat = (text, name) => funcWatOf(text, name) || funcWatOf(text, `${name}$exp`)
/** Kernel calls whose argument is itself a kernel call: a dependent pair issued back to back. */
const nested = (text) => (text.match(/sin_core\s*\(call \$math\.sin_core/g) || []).length

test('scheduling: independent chains start together', () => {
  const src = `export let f = (a, b) => { const p = Math.sin(a); const q = Math.sin(p) + 1; const r = Math.sin(b); const s = Math.sin(r) + 1; return q * s }`
  is(nested(funcWat(wat(src, OFF), 'f')), 2, 'as written: each chain nests its two calls')
  is(nested(funcWat(wat(src, ON), 'f')), 0, 'scheduled: the two independent calls first, then the two dependent ones')
  is(run(src, ON).f(0.3, 0.9), run(src, OFF).f(0.3, 0.9))
})

test('scheduling: a load stays after the store it reads, a store after the load it clobbers', () => {
  const src = `export let g = (a, b) => { const out = new Float64Array(4); out[0] = Math.sin(a); const t = out[0]; out[0] = Math.sin(b) + t; const u = out[0]; out[1] = Math.sin(t) + u; return out[0] * 3 + out[1] }`
  is(run(src, ON).g(0.3, 0.9), run(src, OFF).g(0.3, 0.9))
})

test('scheduling: a loop body schedules each iteration, never across the back edge', () => {
  const src = `export let h = (n) => { let x = 0.5, y = 0.25, s = 0; for (let i = 0; i < n; i++) { const p = Math.sin(x); const q = Math.sin(p); const r = Math.sin(y); const t = Math.sin(r); s += q * t; x = q + 0.1; y = t + 0.2 } return s }`
  const on = funcWat(wat(src, ON), 'h')
  is(nested(on), 0)
  is(run(src, ON).h(50), run(src, OFF).h(50))
})

test('scheduling: an effectful call keeps its place among effects', () => {
  const src = `let log = []
export let k = (a, b) => { log = []; const p = Math.sin(a); log.push(p); const q = Math.sin(b); log.push(q); log.push(Math.sin(p) + Math.sin(q)); return log.length === 3 ? log[0] + log[1] * 2 + log[2] * 4 : -1 }`
  is(run(src, ON).k(0.3, 0.9), run(src, OFF).k(0.3, 0.9))
})

test('scheduling: integer recurrence agrees with JavaScript across optimization tiers', () => {
  const src = `export function f(n, seed, bound) {
    let carry = seed | 0
    for (let i = 0; i < n; i++) {
      const next = (carry + 3) | 0, other = bound | 0
      let m = 7
      if (next < m) m = next
      if (other < m) m = other
      carry = m
    }
    return carry
  }`
  const native = new Function(src.replace('export ', '') + '; return f')()
  for (const optimize of [0, 2, 'speed', 'size']) {
    const { f } = run(src, { optimize })
    for (const n of [0, 1, 1, 7]) for (const seed of [-2147483648, -1, 0, 2147483647])
      is(f(n, seed, -1), native(n, seed, -1), `${optimize}: n=${n}, seed=${seed}`)
  }
})
