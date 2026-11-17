// A population of reductions over the fields of records held k elements to a record in one array,
// against Node bit for bit at optimize false, true, size, `{ level: 'speed', relaxedFloat: false }`
// and speed (optimize/vectorize/reduce.js tryReduceBitExact: a field's two lanes the reads of two
// passes, the block of a record of two, three or four where every field is read, a gather of
// each other; the accumulators' lanes added in the loop's order). The rows: strides 2, 3, 4, 5
// and 8; every field, every field out of order, two of three, one; the array ending exactly after
// the last field the loop reads (two of three: the gather, which reads nothing more); a stride-1
// read beside every one; an inlined helper's value block; two names of one array; a plain array;
// a Float32Array's records, a loop counting down and a store into the array read (each left as
// written); trip counts 1, 2, 3, 17 and 48 over runtime record bases. Each row's work per element
// is a Bernstein basis' (`b1`, `b2` of t), enough for the cost gate to take the lanes; a row the
// lift takes is listed with what it takes, checked at level 2.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { run, oracle, wat } from './util.js'

const LEVELS = [['false', false], ['true', true], ['size', 'size'], ['exact', { level: 'speed', relaxedFloat: false }], ['speed', 'speed']]
// (R records of K points, each record k fields; `len` the array's length; `body` the inner loop's
// statements over t = u[i], w, b1, b2, o = r * K, and the fields; the sums s0..s2 out per record)
const prog = ({ k, K, R = 5, len, body, hold = 'f64', head = '', alias = false, loop = 'for (let i = 0; i < K; i++)' }) => `const R = ${R}, K = ${K}
${head}
const N = ${len ?? `R * K * ${k}`}
const pts = ${hold === 'plain' ? '[]' : `new ${hold === 'f32' ? 'Float32Array' : 'Float64Array'}(N)`}, u = new Float64Array(K), out = new Float64Array(R * 3)
export let main = () => {
  for (let i = 0; i < N; i++) ${hold === 'plain' ? 'pts.push(' : 'pts[i] = ('}((i * 37) % 23 - 11) * 0.125 + i * 1e-3)
  for (let i = 0; i < K; i++) u[i] = (i + 1) / (K + 1)
  ${alias ? 'const p2 = pts' : ''}
  for (let r = 0; r < R; r++) {
    const o = r * K
    let s0 = 0, s1 = 0, s2 = 0
    ${loop} {
      const t = u[i], w = 1.0 - t, b1 = 3.0 * t * w * w, b2 = 3.0 * t * t * w
      ${body}
    }
    out[r * 3] = s0; out[r * 3 + 1] = s1; out[r * 3 + 2] = s2
  }
  return [...out]
}`
const f = (k, j) => `pts[(o + i) * ${k} + ${j}]`
// (two weighted fields x, y and the sums of them)
const sums = 's0 += x * x + y * y; s1 += x * y - t * w; s2 += x * w + y * t'
const H = `const h1 = (t) => { const v = 1.0 - t; return 3.0 * t * v * v }
const h2 = (t) => { const v = 1.0 - t; return 3.0 * t * t * v }`
const ROWS = []
for (const K of [1, 2, 3, 17, 48]) {
  ROWS.push([`k 2, both fields, K ${K}`, { k: 2, K, body: `const x = ${f(2, 0)} * b1, y = ${f(2, 1)} * b2; ${sums}` }, K > 3 && 'block'])
  ROWS.push([`k 3, every field, K ${K}`, { k: 3, K, body: `const x = ${f(3, 0)} * b1, y = ${f(3, 1)} * b2, z = ${f(3, 2)} * w; s0 += x * x + y * y; s1 += y * z + x * w; s2 += z * t - x * b2` }, K > 3 && 'block'])
}
ROWS.push(['k 4, every field', { k: 4, K: 17, body: `const x = ${f(4, 0)} * b1, y = ${f(4, 1)} * b2, z = ${f(4, 2)} * w, q = ${f(4, 3)} * t; s0 += x * q + y * z; s1 += x * x - q * w; s2 += z * b1 + y` }, 'block'])
ROWS.push(['k 4, every field out of order', { k: 4, K: 17, body: `const z = ${f(4, 2)} * w, x = ${f(4, 0)} * b1, q = ${f(4, 3)} * t, y = ${f(4, 1)} * b2; s0 += z * q + x * y; s1 += q * q - z * b1; s2 += y * w + x` }, 'block'])
ROWS.push(['k 5, one field', { k: 5, K: 17, body: `const x = ${f(5, 3)}; s0 += x * b1 * b2 + w * t; s1 += x * x * b1 - t * b2; s2 += (x - t) * (x + w)` }, 'gather'])
ROWS.push(['k 8, two fields', { k: 8, K: 17, body: `const x = ${f(8, 0)} * b1, y = ${f(8, 7)} * b2; ${sums}` }, 'gather'])
ROWS.push(['k 3, two of three, the array ending after the last read', { k: 3, K: 17, len: '(R * K - 1) * 3 + 2', body: `const x = ${f(3, 0)} * b1, y = ${f(3, 1)} * b2; ${sums}` }, 'gather'])
ROWS.push(['k 2, an inlined helper', { k: 2, K: 48, head: H, body: `const x = h1(t) * ${f(2, 0)}, y = h2(t) * ${f(2, 1)}; ${sums}` }, 'block'])
ROWS.push(['k 2, two names of one array', { k: 2, K: 17, alias: true, body: `const x = pts[(o + i) * 2] * b1, y = p2[(o + i) * 2 + 1] * b2; ${sums}` }, null])
ROWS.push(['k 2, a plain array', { k: 2, K: 17, hold: 'plain', body: `const x = ${f(2, 0)} * b1, y = ${f(2, 1)} * b2; ${sums}` }, null])
ROWS.push(['k 2, a Float32Array', { k: 2, K: 17, hold: 'f32', body: `const x = ${f(2, 0)} * b1, y = ${f(2, 1)} * b2; ${sums}` }, null])
ROWS.push(['k 2, counting down', { k: 2, K: 17, loop: 'for (let i = K - 1; i >= 0; i--)', body: `const x = ${f(2, 0)} * b1, y = ${f(2, 1)} * b2; ${sums}` }, null])
ROWS.push(['k 2, a store into the array read', { k: 2, K: 17, body: `const x = ${f(2, 0)} * b1; s0 += x * x; pts[(o + i) * 2 + 1] = x * 0.5; s1 += ${f(2, 1)} * b2` }, null])

test('record lanes population: every row as Node at every level, the lifts as listed', () => {
  for (const [label, p, lifts] of ROWS) {
    const src = prog(p), want = oracle(src).main()
    if (lifts) {
      const w = wat(src, { optimize: true })
      const n = (w.match(lifts === 'block' ? /i8x16\.shuffle/g : /f64x2\.replace_lane/g) || []).length
      ok(n > 0, `${label}: the ${lifts} at level 2`)
    }
    for (const [name, optimize] of LEVELS) {
      const got = run(src, { optimize }).main()
      const at = want.findIndex((v, i) => !Object.is(v, got[i]))
      ok(at < 0 && got.length === want.length, `${label}, ${name}: as Node` + (at < 0 ? '' : ` (out[${at}]: node ${want[at]}, jz ${got[at]})`))
    }
  }
})
