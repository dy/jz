// A comparison of Float32Array data with a double in an f32 lane answers as JavaScript's at
// every level (optimize/vectorize/lift.js laneTestOf). JavaScript compares the element promoted
// to a double, exactly (IEEE 754-2019 §5.11: an ordered comparison of the values, NaN unordered,
// -0 equal to +0); the lane compares singles. For x a single and a double d, f = RN32(d) (§4.3.1,
// round to nearest, ties to even, as Math.fround): a single other than f lies on the same side
// of d as of f, and at x = f the truth is f's own against d, so
//   x OP d  =  x OP' f  or  (x == f and f OP d),   OP' the strict form of OP.
// A constant's tie is decided at compile time (`x > 0.1` is `x >= RN32(0.1)`, `x == 0.1` false);
// an invariant's is a lane mask computed once. Demoting d to the nearest single alone answered
// `a[i - 1] > 0.1` true at an element RN32(0.1) at 'speed', where JavaScript answers false: a
// whole value, the other arm of the select. The population over every operator and the ends:
// test/single-compare-population.js.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, oracle, wat } from './util.js'

const LEVELS = [false, true, 'size', { level: 'speed', relaxedFloat: false }, 'speed']
const name = (o) => JSON.stringify(o)
const lanes = (src, optimize) => (wat(src, { optimize }).match(/f32x4\.(eq|ne|lt|gt|le|ge)/g) || []).length

test('single compare: an element at RN32(0.1) is above 0.1, in the lanes too', () => {
  const src = `export let f = (n) => {
  const a = new Float32Array(n), o = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = i % 3 ? 0.5 : 0.1
  for (let i = 1; i < n - 1; i++) o[i] = a[i - 1] > 0.1 ? a[i + 1] : 0.25
  return o
}`
  const want = Array.from(oracle(src).f(8))
  is(want[1], 0.5, 'Node: a[0] = RN32(0.1) > 0.1')
  for (const optimize of LEVELS) is(Array.from(run(src, { optimize }).f(8)), want, `${name(optimize)}: as Node`)
  // the loop lifts to an f32 lane at the default level and at speed (the arm 0.25 is a single)
  for (const optimize of [true, 'speed']) ok(lanes(src, optimize) > 0, `${name(optimize)}: an f32x4 comparison`)
})

test('single compare: each operator against a constant between singles, on one, and NaN', () => {
  // RN32(0.1) > 0.1 (rounds up), RN32(0.7) < 0.7 (rounds down), 0.5 a single, NaN unordered
  const data = [Math.fround(0.1), Math.fround(0.7), 0.5, -0, 0, NaN, Infinity, -Infinity, 1e-45, 3.4028234663852886e38]
  const rows = []
  for (const op of ['>', '>=', '<', '<=', '===', '!==']) for (const c of ['0.1', '0.7', '0.5', 'NaN', '1e39', '1e-50']) for (const left of [false, true])
    rows.push(`(n) => { const D = [${data.map(v => Object.is(v, -0) ? '-0' : String(v)).join(', ')}]; const a = new Float32Array(n), o = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = D[i % D.length]
  for (let i = 1; i < n - 1; i++) o[i] = ${left ? `${c} ${op} a[i - 1]` : `a[i - 1] ${op} ${c}`} ? a[i + 1] : 0.25
  return o }`)
  const src = rows.map((r, i) => `export let f${i} = ${r}`).join('\n'), host = oracle(src)
  for (const optimize of LEVELS) {
    const mine = run(src, { optimize })
    let bad = null
    for (let i = 0; i < rows.length && !bad; i++) {
      const w = Array.from(host[`f${i}`](23)), g = Array.from(mine[`f${i}`](23))
      if (w.some((v, k) => !Object.is(v, g[k]))) bad = `${rows[i].match(/o\[i\] = ([^?]*)/)[1].trim()}: node ${w}, jz ${g}`
    }
    ok(bad === null, `${name(optimize)}: ${rows.length} comparisons as Node` + (bad ? `; not at ${bad}` : ''))
  }
})

test('single compare: an invariant double, its tie a mask', () => {
  const src = `export let f = (n, w) => {
  const a = new Float32Array(n), o = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = i % 3 ? 0.5 : 0.1
  for (let i = 1; i < n - 1; i++) o[i] = a[i - 1] > w ? a[i + 1] : 0.25
  return o
}`
  const host = oracle(src).f
  for (const optimize of LEVELS) {
    const mine = run(src, { optimize }).f
    for (const w of [0.1, Math.fround(0.1), 0.7, 0.5, NaN, -0, 1e39, -1e39]) is(Array.from(mine(9, w)), Array.from(host(9, w)), `${name(optimize)}: w = ${w}`)
  }
})
