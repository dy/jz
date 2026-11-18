// A population of comparisons of Float32Array data with doubles, against Node bit for bit at
// optimize false, true, size, `{ level: 'speed', relaxedFloat: false }` and speed: a comparison
// never changes its truth at any level (optimize/vectorize/lift.js laneTestOf; the rule and its
// references, IEEE 754-2019 §5.11 and §4.3.1, in test/single-compare.js). Six operators, the
// double on either side; constants that round up (0.1, 1/3) and down (0.7) to a single, a single
// (0.5, MAX_FLOAT, the least subnormal, the least normal), a tie to even (16777217), between
// MAX_FLOAT and the rounding threshold (3.4028235e38: RN32 is MAX_FLOAT) and past it (3.4028236e38,
// 1e39: RN32 is Infinity), their negatives, the infinities, NaN, both zeros, doubles below the
// least subnormal (1e-50) and between subnormals (2.5e-45, 1.1754942e-38); the same as an
// invariant passed in. Data on every constant's nearest single and both its neighbours, the zeros,
// the infinities, NaN. The loop shape is the stencil whose lane is f32 (a neighbour compared, the
// next stored), and a map, at lengths around a strip.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { run, oracle } from './util.js'
import { sample, sampled } from './_population.js'

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer)
const up = (x) => { if (x !== x || x === Infinity) return x; if (x === 0) return 1.401298464324817e-45; f32[0] = x; u32[0] += x > 0 ? 1 : -1; return f32[0] }
const down = (x) => -up(-x)
const MAXF = 3.4028234663852886e38
const C = [0.1, 1 / 3, 0.7, 0.5, 16777217, 16777217.5, -0.1, MAXF, 3.4028235e38, 3.4028236e38, 1e39, -1e39, -3.4028235e38,
  Infinity, -Infinity, NaN, 0, -0, 1e-50, -1e-50, 1e-45, 1.401298464324817e-45, 2.5e-45, 1.1754943508222875e-38, 1.1754942e-38]
const data = new Set([0, -0, Infinity, -Infinity, NaN, MAXF, -MAXF, 1, -1])
for (const c of C) { const f = Math.fround(c); for (const v of [f, up(f), down(f)]) data.add(v) }
const lit = (x) => Object.is(x, -0) ? '-0' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : Number.isNaN(x) ? 'NaN' : String(x)
const D = `const D = [${[...data].map(lit).join(', ')}]`
const OPS = ['>', '>=', '<', '<=', '===', '!==']
const fn = (test, shape) => `(n, w0) => {
  const a = new Float32Array(n), o = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = D[i % D.length]
  for (let i = ${shape === 'map' ? 0 : 1}; i < n - ${shape === 'map' ? 0 : 1}; i++) o[i] = ${shape === 'map' ? `${test('a[i]')} ? 1 : 0` : `${test('a[i - 1]')} ? a[i + 1] : 0.25`}
  return o
}`
const P = []
for (const shape of ['stencil', 'map']) for (const op of OPS) {
  for (const c of C) for (const left of [false, true]) P.push({ label: left ? `${lit(c)} ${op} x` : `x ${op} ${lit(c)}`, src: fn(x => left ? `${lit(c)} ${op} ${x}` : `${x} ${op} ${lit(c)}`, shape), ws: [0] })
  for (const left of [false, true]) P.push({ label: left ? `w ${op} x` : `x ${op} w`, src: fn(x => left ? `w0 ${op} ${x}` : `${x} ${op} w0`, shape), ws: C })
}
const LEVELS = [['false', false], ['true', true], ['size', 'size'], ['exact', { level: 'speed', relaxedFloat: false }], ['speed', 'speed']]
const CHUNK = 52

test(sampled('single compare population: every comparison as Node at every level'), () => {
  const Q = sample(P, 'comparisons')
  for (let at = 0; at < Q.length; at += CHUNK) {
    const part = Q.slice(at, at + CHUNK)
    const src = D + '\n' + part.map((p, i) => `export let f${i} = ${p.src}`).join('\n'), host = oracle(src)
    for (const [name, optimize] of LEVELS) {
      const mine = run(src, { optimize })
      let bad = null, n = 0
      for (let i = 0; i < part.length && !bad; i++) for (const w of part[i].ws) for (const len of [0, 3, 9, 41]) {
        n++
        const want = Array.from(host[`f${i}`](len, w)), got = Array.from(mine[`f${i}`](len, w))
        const k = want.findIndex((v, j) => !Object.is(v, got[j]))
        if (k >= 0) { bad = `${part[i].label} (w ${lit(w)}, n ${len})[${k}]: node ${lit(want[k])}, jz ${lit(got[k])}`; break }
      }
      ok(bad === null, `${name}: programs ${at}..${at + part.length - 1}, ${n} calls as Node` + (bad ? `; not at ${bad}` : ''))
    }
  }
})
