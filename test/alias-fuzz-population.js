// Random programs over memory that aliases, each answering what Node answers at level 2 and speed
// (the phase 7 scout's fuzz, the levels it ran). Module storage of every kind one function reads
// and writes: a Float64Array and three views of it (two the same range, one overlapping), a
// Float64Array apart, two plain arrays, two objects, and helpers that write through any two of
// them; statements store an element or a field, assign a local, call a helper, loop over the
// views, branch. The second population adds an Int32Array counted into, a plain array grown by
// `push` and read at its end, and loops that read and write through a cursor. `f(s)` is called
// with 0 to 3 in order on one instance, the state carried from call to call, and returns a hash
// of the locals and of every store. A program Node throws on, or whose answers hold NaN or an
// infinity, is left out, as the scratch population left it.
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [2, 'speed']
const TA = ['A', 'B', 'C', 'D'], AR = ['r1', 'r2'], OB = ['o1', 'o2']
// (a linear congruential generator, its state set from the seed and the program's number)
const programs = (seed0, count, second) => {
  let st = 0
  const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296 }
  const ri = (n) => Math.floor(rnd() * n), pick = (a) => a[ri(a.length)]
  const gen = () => {
    const sc = ['x0', 'x1', 'x2']
    const idx = () => pick(['0', '1', '2', '3', '(s & 3)', '((s + 1) & 3)'])
    const lv = () => rnd() < 0.5 ? `${pick(TA)}[${idx()}]` : rnd() < 0.5 ? `${pick(AR)}[${idx()}]` : `${pick(OB)}.${pick(['x', 'y'])}`
    const ex = (d = 0) => { const r = rnd(); if (d > 2 || r < 0.25) return pick([String(ri(9) + 1), 's', ...sc]); if (r < 0.55) return lv(); return `(${ex(d + 1)} ${pick(['+', '-', '*'])} ${ex(d + 1)})` }
    const stmt = (d = 0) => {
      const r = rnd()
      if (r < 0.3) return `${lv()} = ${ex()}`
      if (r < 0.45) return `${pick(sc)} = ${ex()}`
      if (r < 0.55) return `h(${pick(TA)}, ${pick(TA)}, ${ri(5) + 1})`
      if (r < 0.62) return `k(${pick(OB)}, ${pick(OB)}, ${ri(5) + 1})`
      if (second) {
        if (r < 0.66) return `G[${idx()}] += ${ri(3) + 1}; if (G[${idx()}] >= 4) { x0 = x0 + 1 }`
        if (r < 0.70) return `r3.push(${ex()}); x1 = x1 + r3[r3.length - 1]`
        if (r < 0.74 && d < 2) return `for (let i = 0; i < ${ri(6) + 3}; i++) { const v = ${pick(TA)}[p & 7]; ${pick(TA)}[p & 7] = v + i + x2; p = p + ${ri(3) + 1} }`
        if (r < 0.78 && d < 2) return `for (let i = 0; i < ${ri(5) + 2}; i++) { const kk = r1[i] & 3; x0 = x0 + ${pick(TA)}[kk] + G[kk] }`
      }
      if (r < 0.72 && d < 2) return `for (let i = 0; i < ${ri(4) + 2}; i++) { ${stmt(d + 1)}; ${pick(TA)}[i] = ${pick(TA)}[i + ${ri(2)}] + ${ex()} }`
      if (r < 0.82 && d < 2) return `if (${ex()} > ${ri(20)}) { ${stmt(d + 1)} } else { ${stmt(d + 1)} }`
      return `${pick(sc)} = ${lv()}`
    }
    const body = Array.from({ length: 6 + ri(8) }, () => stmt()).join(';\n  ')
    return second ? `const buf = new Float64Array(32)
const A = buf.subarray(0, 12), B = buf.subarray(4, 16), C = buf.subarray(0, 12), D = new Float64Array(12)
const r1 = [1, 2, 3, 4, 5, 6], r2 = [7, 8, 9, 10, 11, 12], r3 = [1]
const G = new Int32Array(8)
const o1 = { x: 1, y: 2 }, o2 = { x: 3, y: 4 }
const h = (p, q, n) => { p[0] = q[1] + n; p[1] = q[0] * 2; p[2] = p[0] - q[2] }
const k = (p, q, n) => { p.x = q.y + n; p.y = q.x * 2 }
export let f = (s) => {
  let x0 = 1, x1 = 2, x2 = 3, p = 0
  ${body}
  let t = x0 + x1 * 3 + x2 * 7
  for (let i = 0; i < 8; i++) t = t * 3 + buf[i] + (i < 6 ? r1[i] + r2[i] : 0) + D[i]
  for (let i = 0; i < 8; i++) t = t * 5 + G[i]
  t = t + r3.length * 3 + r3[r3.length - 1]
  return t + p + o1.x * 5 + o1.y * 11 + o2.x * 13 + o2.y * 17
}` : `const buf = new Float64Array(32)
const A = buf.subarray(0, 12), B = buf.subarray(4, 16), C = buf.subarray(0, 12), D = new Float64Array(12)
const r1 = [1, 2, 3, 4, 5, 6], r2 = [7, 8, 9, 10, 11, 12]
const o1 = { x: 1, y: 2 }, o2 = { x: 3, y: 4 }
const h = (p, q, n) => { p[0] = q[1] + n; p[1] = q[0] * 2; p[2] = p[0] - q[2] }
const k = (p, q, n) => { p.x = q.y + n; p.y = q.x * 2 }
export let f = (s) => {
  let x0 = 1, x1 = 2, x2 = 3
  ${body}
  let t = x0 + x1 * 3 + x2 * 7
  for (let i = 0; i < 8; i++) t = t * 3 + buf[i] + (i < 6 ? r1[i] + r2[i] : 0) + D[i]
  return t + o1.x * 5 + o1.y * 11 + o2.x * 13 + o2.y * 17
}`
  }
  const out = []
  for (let n = 0; n < count; n++) {
    st = (seed0 * 7919 + n * 104729) >>> 0
    const src = gen()
    let want
    try { const fn = new Function(src.replace(/export let (\w+) = /g, 'var $1 = ') + '\nreturn f')(); want = [0, 1, 2, 3].map(s => fn(s)).join(',') } catch { continue }
    if (want.includes('NaN') || want.includes('Infinity')) continue
    out.push({ name: `seed ${seed0}, program ${n}`, src, args: [[0], [1], [2], [3]] })
  }
  return out
}
const OWN = ['buf', 'A', 'B', 'C', 'D', 'r1', 'r2', 'r3', 'G', 'o1', 'o2', 'h', 'k']

test(`alias fuzz population: 230 programs over aliasing views, arrays and objects, ${CONFIGS.length} configurations`, () =>
  population('alias fuzz', programs(1, 230, false), { configs: CONFIGS, own: OWN }))

test(`alias fuzz population: 150 programs adding an Int32Array, a growing array and a cursor, ${CONFIGS.length} configurations`, () =>
  population('alias fuzz 2', programs(1, 150, true), { configs: CONFIGS, own: OWN }))
