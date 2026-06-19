// Shared headline stats (assets/headline.js) — pins the figure CONTRACT so a refactor
// can't silently change the numbers the landing hero and the bench strip show. Pure
// function over a synthetic results.json (no jz compile), so it runs on every leg.
import test from 'tst'
import { is } from 'tst/assert.js'
import { headlineStats } from '../assets/headline.js'

const C = (jz, rest) => ({ targets: { jz, ...rest } })

test('headline: ratios are geomean(target/jz), peak is max, sizes are median', () => {
  const r = { cases: {
    a: C({ medianUs: 100, bytes: 1000, parity: 'ok' },
      { v8: { medianUs: 200, parity: 'ok' }, as: { medianUs: 300, bytes: 900, parity: 'ok' }, 'rust-wasm': { medianUs:90, parity: 'ok' } }),
    b: C({ medianUs: 100, bytes: 2000, parity: 'ok' },
      { v8: { medianUs: 400, parity: 'ok' }, as: { medianUs: 300, bytes: 1000, parity: 'ok' }, 'rust-wasm': { medianUs:110, parity: 'ok' } }),
  } }
  const s = headlineStats(r)
  is(s.asspeed, '3×')    // geomean(300/100, 300/100) — the figure this test exists to pin
  is(s.v8, '2.8×')       // geomean(2, 4) = √8
  is(s.rust, '1×')       // geomean(0.9, 1.1) ≈ 0.995 → 1×
  is(s.peak, '4×')       // max V8/jz speedup, not a geomean
  is(s.assize, '2×')     // median(1000/900, 2000/1000)
})

test('headline: a WRONG-result (parity DIFF) run is excluded from the ratio', () => {
  const r = { cases: {
    a: C({ medianUs: 100, parity: 'ok' }, { as: { medianUs: 300, parity: 'ok' } }),
    b: C({ medianUs: 100, parity: 'ok' }, { as: { medianUs: 9999, parity: 'DIFF' } }),  // miscompiled → must not count
  } }
  is(headlineStats(r).asspeed, '3×')   // only case `a`; the DIFF run is dropped
})

test('headline: null when a target is absent (never NaN/Infinity)', () => {
  const s = headlineStats({ cases: { a: C({ medianUs: 100, parity: 'ok' }, { v8: { medianUs: 200, parity: 'ok' } }) } })
  is(s.asspeed, null)    // no AssemblyScript target anywhere
  is(s.porf, null)
  is(s.assize, null)
})
