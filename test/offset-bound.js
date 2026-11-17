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
    // A float sum at level 3 may add in lanes, in another order (README, "Float results
    // at 'speed'": within n·2⁻⁵² of the terms' total magnitude): `lag`'s two reads at one
    // offset lift there since the address tees, so its sums are held to that bound and
    // to JavaScript's bits with relaxedFloat off; the other levels to the bits.
    const same = optimize === 3 ? (a, b) => Object.is(a, b) || Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)) : Object.is
    for (const [p, from] of [[0, 0], [1, 0], [5, 7], [31, 3], [34, 0], [40, 2]]) ok(same(m.lag(p, from), host.lag(p, from)), `lag(${p}, ${from}) at ${optimize}`)
    for (const k of [0, 3, 47, 48, 60]) ok(same(m.incl(k), host.incl(k)), `incl(${k}) at ${optimize}`)
    ok(same(m.lit(), host.lit()), `lit at ${optimize}`)
    for (const k of [0.5, -2.25, 10.75, 1e20, NaN]) ok(Object.is(m.frac(k), host.frac(k)), `frac(${k}) at ${optimize}`)
    ok(Object.is(m.grow(), host.grow()), `grow at ${optimize}`)
  }
  if (!belowOpt(3)) {
    const m = run(src, { optimize: { level: 3, relaxedFloat: false } })
    for (const [p, from] of [[0, 0], [1, 0], [5, 7], [31, 3], [34, 0], [40, 2]]) ok(Object.is(m.lag(p, from), host.lag(p, from)), `lag(${p}, ${from}) at 3 with relaxedFloat off`)
    for (const k of [0, 3, 47, 48, 60]) ok(Object.is(m.incl(k), host.incl(k)), `incl(${k}) at 3 with relaxedFloat off`)
    ok(Object.is(m.lit(), host.lit()), 'lit at 3 with relaxedFloat off')
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

// The same offset test over a bound of any kind (type/loop-versioning.js `offset`): the
// extents version reads `B - c` once at entry, its own test left as written in both arms,
// so its guard takes B as it is (a Number within the word, else the twin: an object's
// valueOf, a string, undefined, null, a BigInt, NaN and the infinities fail it unconverted,
// and the loop as written converts them as the source does) and c as a word. A fraction
// rounds toward the test (`i + 1 < 7.5`: the counter's most is ceil(6.5) - 1 = 6). A bound
// the body writes, a field (a read that may run code), a receiver the body replaces and an
// `!==` test take no version; a stride and a count down take their own paths.
const offsets = `const mk = (len) => { const s = new Float64Array(len); for (let i = 0; i < len; i++) s[i] = i * i + 0.5; return s }
export let next = (s, n) => { let t = 0; for (let i = 0; i + 1 < n; i++) t += s[i + 1] - s[i]; return t }
export let incl = (s, n) => { let t = 0; for (let i = 0; i + 1 <= n; i++) t += s[i + 1] === undefined ? 1000 : s[i + 1]; return t }
export let pair = (d, s, n) => { for (let i = 0; i + 1 < n; i++) d[i] = s[i + 1] + s[i]; return Array.from(d) }
export let word = (s, n, kk) => { const k = kk | 0; let t = 0; for (let i = 0; k + i < n; i++) t += s[i + k]; return t }
export let shrink = (s, n) => { let t = 0; for (let i = 0; i + 1 < n; i++) { t += s[i + 1]; n-- } return t }
export let unequal = (s, n) => { let t = 0; for (let i = 0; i + 1 !== n && i < 20; i++) t += s[i + 1] ?? 7; return t }
export let stride = (s, n) => { let t = 0; for (let i = 0; i + 1 < n; i += 2) t += s[i + 1] * s[i]; return t }
export let down = (s, n, m) => { let t = 0; for (let i = n - 1; i - 1 >= m; i--) t += s[i - 1] + s[i]; return t }
export let swap = (s, u, n) => { let t = 0; for (let i = 0; i + 1 < n; i++) { t += s[i + 1]; if (i === 2) s = u } return t }
export let field = (s, o) => { let t = 0; for (let i = 0; i + 1 < o.n; i++) { t += s[i + 1]; if (i === 1) o.n = 3 } return t }
export let shapes = () => [[8, 8], [8, 7], [7, 8], [3, 1], [0, 0], [8, 9]].map(([len, n]) => [next(mk(len), n), incl(mk(len), n), pair(new Float64Array(Math.max(len - 1, 0)), mk(len), n),
  word(mk(len), n, 2), shrink(mk(len), n), unequal(mk(len), n), stride(mk(len), n), down(mk(len), n, 0), down(mk(len), n, -2), swap(mk(len), mk(3), n), field(mk(len), { n })])
export let kinds = () => { const s = mk(8), r = []
  for (const n of ['10', '7', undefined, null, NaN, -Infinity, 7.5, 6.5, 8.5, -3, 0.5]) r.push([next(s, n), incl(s, n)])
  r.push([next(mk(7), 7.5), incl(mk(7), 6.5)])
  return r }
export let calls = () => { let c = 0; const o = { valueOf() { c++; return 6 } }, s = mk(8)
  const a = next(s, o), b = incl(s, o), d = pair(new Float64Array(8), s, o)
  let flip = 0; const p = { valueOf() { flip++; return flip > 3 ? 2 : 9 } }
  return [a, b, d, c, next(s, p), flip] }`

test('offset bound: a bound of any kind keeps the loop\'s answers and its conversions', () => {
  const host = oracle(offsets)
  for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) {
    const m = run(offsets, { optimize })
    ok(Object.is(JSON.stringify(m.shapes()), JSON.stringify(host.shapes())), `shapes at ${optimize}`)
    // (level 0, which versions nothing, compares a Number with a string or an object's
    // valueOf otherwise than the host: `0 + 1 < '10'` false there, no valueOf run, a defect
    // of its own, before and after this form)
    if (optimize === 0) continue
    ok(Object.is(JSON.stringify(m.kinds()), JSON.stringify(host.kinds())), `kinds at ${optimize}`)
    ok(Object.is(JSON.stringify(m.calls()), JSON.stringify(host.calls())), `valueOf calls at ${optimize}`)
  }
  // the offset form versions on its bound, a Number the guard tests within the word
  // (`|B| <= 2^31` on B as it is); the forms that take none test no bound
  const text = wat(offsets, { optimize: 'speed' })
  const tests = (name, b) => new RegExp(`f64\\.abs \\(local\\.get \\$${b}\\)`).test(funcWat(text, name))
  for (const name of ['next', 'incl', 'pair', 'stride', 'word']) ok(tests(name, 'n'), `${name}: versioned on n less its offset`)
  ok(tests('down', 'm'), 'down: versioned on m less its offset')
  for (const name of ['shrink', 'unequal', 'swap']) ok(!tests(name, 'n'), `${name}: no version on n`)
})
