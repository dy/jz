// State a kernel keeps on the object it is handed, read and written per
// iteration, lives in locals for the loop and is stored back after it
// (plan/loop-fields.js): the same values, the same throws, every level.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat } from './util.js'

const loopsOf = (text) => {
  const out = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    out.push(text.slice(at, end))
  }
  return out
}
const res = (f) => { try { return f() } catch (e) { return 'throws ' + e.constructor.name } }
const agrees = (src, calls) => {
  for (const optimize of levels(0, 2, 3)) {
    const js = oracle(src), m = jz(src, { optimize }).exports
    for (const [name, ...args] of calls) {
      const a = res(() => js[name](...args)), b = res(() => m[name](...args))
      ok(Object.is(a, b) || a === b, `${name}(${args.join(', ')}) at ${optimize}: ${b} for ${a}`)
    }
  }
}

// a one-pole smoother and a state-variable filter keeping their state on the parameter object
const kernel = `function svf (s, x, f, q) { s.l += f * s.b; let h = x - s.l - q * s.b; s.b += f * h; return [s.l, s.b, h] }
function kern (data, params) {
  let fc = params.fc || 100
  if (!params._sub) { params._sub = { l: 0, b: 0 }; params._out = { l: 0, b: 0 }; params._dc = 0; params._cur = fc }
  for (let i = 0, n = data.length; i < n; i++) {
    params._cur += (fc - params._cur) * 0.01
    let [sub] = svf(params._sub, data[i] / params._cur, 0.1, 1.2)
    let h = sub * 0.6 + Math.abs(sub) * 0.4
    params._dc += 0.01 * (h - params._dc)
    svf(params._out, h - params._dc, 0.2, 0.8)
    data[i] = data[i] - 0.5 * sub + params._out.b
  }
  return data
}
const chP = [{ fc: 100 }, { fc: 250 }]
export let run = (n) => { const d = new Float64Array(n).fill(1); kern(d, chP[0]); kern(d, chP[0]); kern(d, chP[1]); return d[n - 1] + chP[0]._dc + chP[0]._out.b + chP[1]._cur }
export let missing = (n) => { const d = new Float64Array(n).fill(1); return kern(d, chP[5]) }`

test('loop fields: state on the parameter object and on records it holds agrees with JS', () => {
  agrees(kernel, [['run', 7], ['run', 1], ['run', 0], ['missing', 3], ['missing', 0]])
})

test('loop fields: the loop keeps its state in locals', () => {
  if (belowOpt(2)) return
  const loops = loopsOf(wat(kernel, { optimize: 2 })).filter(l => /f64\.mul/.test(l))
  ok(loops.some(l => (l.match(/f64\.(load|store)/g) || []).length === 2 && !/call \$/.test(l)), 'one loop reads and writes the sample alone, and calls nothing')
})

test('loop fields: one record reached through two names stays in memory', () => {
  const src = `function mix (d, a, b) { for (let i = 0; i < d.length; i++) { a.v += d[i]; d[i] = b.v } return a.v }
    const o = { v: 1 }, p = { v: 10 }
    export let same = (n) => mix(new Float64Array(n).fill(2), o, o) + o.v
    export let apart = (n) => mix(new Float64Array(n).fill(2), p, { v: 3 }) + p.v`
  agrees(src, [['same', 4], ['apart', 4], ['same', 0]])
})

test('loop fields: a loop that calls, or stores under a computed key, keeps its fields in memory', () => {
  const src = `let seen = 0
    function tick (o) { seen += o.acc; return 1 }
    function calls (d, o) { for (let i = 0; i < d.length; i++) { o.acc += d[i]; tick(o) } return seen }
    function keyed (d, o, k) { for (let i = 0; i < d.length; i++) { o.acc += d[i]; o[k] = i } return o.acc }
    const s = { acc: 0 }, t = { acc: 0, other: 0 }
    export let a = (n) => calls(new Float64Array(n).fill(1), s)
    export let b = (n, k) => keyed(new Float64Array(n).fill(1), t, k)`
  agrees(src, [['a', 3], ['b', 3, 'other'], ['b', 3, 'acc']])
})

// a biquad section's state in its own Float64Array, stepped per sample
const section = `function step (c, s, x) { let y = c.b0 * x + s[0]; s[0] = c.b1 * x - c.a1 * y + s[1]; s[1] = c.b2 * x - c.a2 * y; return y }
function kern (band, sec, st) { for (let i = 0; i < band.length; i++) band[i] = step(sec, st, band[i]); return st[0] + st[1] }
const sec = { b0: 0.2, b1: 0.4, b2: 0.2, a1: -0.3, a2: 0.1 }`

test('loop fields: a state array element at a constant index lives in a local for the loop', () => {
  const src = section + `
export let run = (n) => { const b = new Float32Array(n).fill(1), st = new Float64Array(2); return kern(b, sec, st) + kern(b, sec, st) + (b[n - 1] ?? 0) }
export let short = (n) => { const b = new Float32Array(n).fill(1), st = new Float64Array(1); return kern(b, sec, st) + b[n - 1] }`
  agrees(src, [['run', 8], ['run', 0], ['short', 5]])
  if (belowOpt(2)) return
  const loops = loopsOf(wat(src, { optimize: 2 })).filter(l => /f32\.store/.test(l))
  ok(loops.some(l => !/f64\.(load|store)/.test(l)), 'one copy of the sample loop holds the state in locals')
})

test('loop fields: a state array that may share a buffer with the samples stays in memory', () => {
  agrees(section + `
export let shared = (n) => { const b = new Float64Array(n).fill(1); return kern(b, sec, b) + b[0] }
export let apart = (n) => { const b = new Float64Array(n).fill(1), st = new Float64Array(2); return kern(b, sec, st) + b[0] }`, [['shared', 6], ['apart', 6]])
})

// A typed array made over another's buffer writes its elements: `U[0] = i`
// changes the bits `F[0]` reads back, so F's element stays in memory where the
// program makes one, whatever element kind it has.
test('loop fields: a state array another kind of array views stays in memory', () => {
  agrees(`const F = new Float64Array(1), U = new Uint32Array(F.buffer)
export let f = (x, n) => { let acc = 0; for (let i = 0; i < n; i++) { F[0] = x * i; acc += (U[1] ^ U[0]) >>> 0; U[0] = i; acc += F[0] } return acc }`,
    [['f', 1.5, 9], ['f', -0, 9], ['f', 4503599627370497, 9]])
  agrees(`export let f = (x, n) => { const m = new ArrayBuffer(16), F = new Float64Array(m), B = new Uint8Array(m); let acc = 0
      for (let i = 0; i < n; i++) { F[1] = x + i; B[15] = i; acc += F[1] } return acc }`, [['f', 1.5, 5], ['f', -2, 3]])
})

// A value that may be missing (`a[k]` past a typed array's end) stored into a
// Float64Array element reads back NaN: the store converts it, a local would not,
// so such an element stays in memory.
test('loop fields: an element a loop stores a maybe-missing value into reads back its number', () => {
  agrees(`export let f = (k) => { const a = new Float32Array(4), b = new Float64Array(4); let s = 1
      for (let i = 0; i < 3; i++) { b[1] = k > 0 ? a[k] : -3; s = b[1] } return s }`, [['f', 1], ['f', 9], ['f', -1]])
  agrees(`export let f = (k) => { const o = { p: undefined }, b = new Float64Array(4); if (k === 1) o.p = 2.5; let s = 1
      for (let i = 0; i < 3; i++) { b[1] = o.p; s = b[1] + s } return s }`, [['f', 1], ['f', 9]])
})

// A cascade of sections kept as the library keeps them: coefficient records,
// each section's state a pair array, a stage loop of a constant count. The
// stage loop is written out, and the sample loop then holds every coefficient
// and every state element in a local, the pairs stored back after it; a call
// handing one pair for two sections (the pairs found not distinct) runs the
// loop as written.
const cascadeOf = (coefs, count) => `${coefs}
const filter = (data, coefs, state) => {
  const n = ${count}
  for (let i = 0; i < data.length; i++) {
    let x = data[i]
    for (let j = 0; j < n; j++) {
      const c = coefs[j], s = state[j]
      const y = c.b0 * x + s[0]
      s[0] = c.b1 * x - c.a1 * y + s[1]
      s[1] = c.b2 * x - c.a2 * y
      x = y
    }
    data[i] = x
  }
  return state[0][0] + state[n - 1][1]
}
export let run = (len) => { const d = new Float64Array(len).fill(1), st = []; for (let j = 0; j < 4; j++) st.push([0, 0]); return filter(d, coefs, st) + filter(d, coefs, st) + (d[len - 1] ?? 0) }
export let shared = (len) => { const d = new Float64Array(len).fill(1), z = [0, 0], st = [z, z, [0, 0], z]; return filter(d, coefs, st) + (d[len - 1] ?? 0) + z[1] }`
const record = (i) => `{ b0: ${0.2 + i * 0.01}, b1: 0.3, b2: 0.2, a1: ${-0.4 + i * 0.02}, a2: 0.1 }`
const cascade = cascadeOf(`const coefs = [${[0, 1, 2, 3].map(record).join(', ')}]`, '4')
const holdsState = (src) => {
  for (const optimize of levels(2, 3)) {
    const loops = loopsOf(wat(src, { optimize })).filter(l => (l.match(/f64\.mul/g) || []).length >= 20)
    ok(loops.some(l => (l.match(/f64\.(load|store)/g) || []).length === 2 && !/call \$|i64\.load|i32\.load/.test(l)), `at ${optimize}: one loop reads and writes the sample alone`)
  }
}

test('loop fields: a cascade of sections in pair arrays agrees with JS, its pairs apart or shared', () => {
  agrees(cascade, [['run', 9], ['run', 1], ['run', 0], ['shared', 9], ['shared', 0]])
})

test('loop fields: the sample loop of a cascade holds its coefficients and state in locals', () => holdsState(cascade))

// The library's count is the length of the array its design function built
// (`const n = coefs.length`, summary builtLenOf): a constant all the same.
const designed = cascadeOf(`const design = (n) => { const sos = []; for (let i = 0; i < n; i++) sos.push({ b0: 0.2 + i * 0.01, b1: 0.3, b2: 0.2, a1: -0.4 + i * 0.02, a2: 0.1 }); return sos }
const coefs = design(4)`, 'coefs.length')

test('loop fields: a cascade over the sections a design function built agrees with JS and holds its state', () => {
  agrees(designed, [['run', 9], ['run', 0], ['shared', 9]])
  holdsState(designed)
})

// An element alias reads its array each pass where the loop may change that
// array: a store of its length (the next pass reads a missing element and
// throws, as the host does), or a store of the element itself.
test('loop fields: an element alias of an array the loop truncates or rewrites reads it every pass', () => {
  agrees(`const f = (data, state, cut) => { for (let i = 0; i < data.length; i++) { const s = state[0]; s[0] = s[0] + data[i]; s[1] = data[i]; if (i === cut) state.length = 0 } return state.length }
export let run = (cut) => { const st = [[0, 0]]; return f(new Float64Array(5).fill(1), st, cut) }`, [['run', 2], ['run', 9]])
  agrees(`const f = (data, state) => { for (let i = 0; i < data.length; i++) { const s = state[0]; s[0] = s[0] + data[i]; s[1] = data[i]; state[0] = state[1] } return state[0][0] + state[1][0] }
export let go = () => f(new Float64Array(5).fill(1), [[0, 0], [10, 0]])`, [['go']])
})

// A box grown by the points of a buffer as three.js's Box3.setFromArray grows
// it: each point read into a module scratch vector (`_vector.fromArray`), the
// box's min and max vectors stored per point. The three receivers are vectors
// of one layout made at one site (the constructor's literal), so no
// construction site tells them apart: the copy holds their fields where it
// finds them three objects at run time, and the loop as written runs where two
// are one. Another class's accessor of the same name (Quaternion's `get x()`)
// leaves a vector's `x` a field. A coordinate a read past the buffer's end
// leaves undefined is a Number or missing: the copy finds the box's present
// and holds them as Numbers, tested once before the loop.
const box = `class Q { constructor() { this._x = 0 } get x() { return this._x } set x(v) { this._x = v } }
class V {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
  fromArray(a, o = 0) { this.x = a[o]; this.y = a[o + 1]; this.z = a[o + 2]; return this }
  min(v) { this.x = Math.min(this.x, v.x); this.y = Math.min(this.y, v.y); this.z = Math.min(this.z, v.z); return this }
  max(v) { this.x = Math.max(this.x, v.x); this.y = Math.max(this.y, v.y); this.z = Math.max(this.z, v.z); return this }
}
const _vector = new V()
class Box {
  constructor(min = new V(Infinity, Infinity, Infinity), max = new V(-Infinity, -Infinity, -Infinity)) { this.min = min; this.max = max }
  setFromArray(a) { for (let i = 0, il = a.length; i < il; i += 3) { this.min.min(_vector.fromArray(a, i)); this.max.max(_vector) } return this }
}
const q = new Q(), pts = new Float32Array(30)
for (let i = 0; i < pts.length; i++) pts[i] = Math.sin(i * 7) * 10
const box = new Box(), one = new V(Infinity, Infinity, Infinity), shared = new Box(one, one), held = new Box(_vector, new V())
const sum = (b) => b.min.x + b.min.y + b.min.z + b.max.x + b.max.y + b.max.z
export let grow = () => { q.x = 2; return sum(box.setFromArray(pts)) + q.x + _vector.z }
export let same = () => sum(shared.setFromArray(pts)) + _vector.x
export let scratch = () => sum(held.setFromArray(pts))
export let missing = () => { box.min.fromArray(pts, 29); return sum(box.setFromArray(pts)) }
export let none = () => { box.min.fromArray(pts, 29); box.setFromArray(new Float32Array(0)); return box.min.y === undefined ? 1 : 0 }`

test('loop fields: vectors of one layout a loop stores through several receivers agree with JS, distinct or one', () => {
  agrees(box, [['grow'], ['same'], ['scratch'], ['missing'], ['none'], ['grow']])
})

test('loop fields: a box grown point by point holds its vectors in locals, as Numbers', () => {
  if (belowOpt(2)) return
  for (const optimize of levels(2, 3)) {
    const loops = loopsOf(wat(box, { optimize })).filter(l => /f64\.min/.test(l) && /f32\.load/.test(l) && l.indexOf('(loop', 1) < 0)
    // (an undefined test reads the bits: `i64.eq (i64.reinterpret_f64 …) undefined`)
    ok(loops.some(l => !/f64\.(load|store)|i64\.reinterpret_f64/.test(l)), `at ${optimize}: a loop reads the points alone, no field and no undefined test`)
  }
})
