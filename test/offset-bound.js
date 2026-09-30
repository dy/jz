// A counter bounded by a length less a loop constant (`i + k < n`, a lag or a
// tap, compile/plan/counted-loops.js offsetTest) is tested against that
// difference, taken once: the extent proofs then read every element of the
// window present, where each read had tested its index and each trip had
// added the offset in floats. Every shape agrees with the host, the ones the
// rewrite leaves alone included: an offset of no integer, a list's length a
// push can move.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const src = `const x = new Float32Array(48)
for (let i = 0; i < 48; i++) x[i] = Math.sin(i * 0.4) + i * 0.01
function autocorr (v, p) { let n = v.length, R = new Float64Array(p + 1)
  for (let k = 0; k <= p; k++) { let s = 0; for (let i = 0; i + k < n; i++) s += v[i] * v[i + k]; R[k] = s } return R }
export let lag = (p, from) => { const R = autocorr(x.subarray(from, from + 32), p); let h = 0; for (let k = 0; k <= p; k++) h = h * 1.5 + R[k]; return h }
export let incl = (k) => { let s = 0; for (let i = 0; k + i <= x.length - 1; i++) s += x[i + k]; return s }
export let lit = () => { let s = 0; for (let i = 2; i + 5 < x.length; i++) s += x[i] - x[i + 5]; return s }
export let frac = (k) => { let s = 0; for (let i = 0; i + k < x.length; i++) s += i; return s }
export let grow = () => { const l = [1, 2, 3]; let s = 0; for (let i = 0; i + 1 < l.length; i++) { s += l[i]; if (l.length < 6) l.push(i) } return s + l.length }`

test('offset bound: every window agrees with the host', () => {
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = run(src, { optimize })
    for (const [p, from] of [[0, 0], [1, 0], [5, 7], [31, 3], [34, 0], [40, 2]]) ok(Object.is(m.lag(p, from), host.lag(p, from)), `lag(${p}, ${from}) at ${optimize}`)
    for (const k of [0, 3, 47, 48, 60]) ok(Object.is(m.incl(k), host.incl(k)), `incl(${k}) at ${optimize}`)
    ok(Object.is(m.lit(), host.lit()), `lit at ${optimize}`)
    for (const k of [0.5, -2.25, 10.75, 1e20, NaN]) ok(Object.is(m.frac(k), host.frac(k)), `frac(${k}) at ${optimize}`)
    ok(Object.is(m.grow(), host.grow()), `grow at ${optimize}`)
  }
})

test('offset bound: the window reads its elements unchecked', () => {
  if (belowOpt(2)) return
  // autocorr kept a function of its own: its one caller splices it, and so does watr
  const body = funcWat(wat(src, { optimize: { level: 2, sourceInline: false, inlineFns: false, watr: false } }), 'autocorr')
  const loops = []
  for (let at = body.indexOf('(loop'); at >= 0; at = body.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = body[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < body.length)
    loops.push(body.slice(at, end))
  }
  const inner = loops.filter(l => !/\(loop/.test(l.slice(5)) && /f32\.load/.test(l))
  ok(inner.length > 0, 'found the window loop')
  // the bound's own form; a checked twin, where one is kept, is the other arm
  ok(inner.some(l => !/f64\.add\s*\(f64\.convert_i32_s/.test(l) && !/\(select/.test(l)), 'a window loop adds no offset in floats and tests no index')
})
