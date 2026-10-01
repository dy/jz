// A loop indexing by numbers the program cannot prove integers runs, when
// they are int32s, as a copy over names written from `x | 0`
// (plan/integral-loops.js): the same values, so the same results for every
// number, integral or not.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat } from './util.js'

// a ring buffer's cursor and a tap count read back from a state record
const fir = `const st = { p: 0, taps: 5 }
const h = new Float64Array(9).map((_, i) => 1 / (i + 1)), buf = new Float64Array(9)
export let set = (p, taps) => { st.p = p; st.taps = taps }
export let run = (n) => { let N = st.taps, p = st.p, out = 0
  for (let i = 0; i < n; i++) { buf[p] = i * 0.5; let acc = 0, idx = p
    for (let k = 0; k < N; k++) { acc += buf[idx] * h[k]; idx = idx === 0 ? N - 1 : idx - 1 }
    out += acc; p = (p + 1) % N }
  st.p = p; return out }
export let cursor = () => st.p`

test('integral loops: every cursor and count agrees with JS, integral or not', () => {
  const js = oracle(fir)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(fir, { optimize }).exports
    for (const [p, taps] of [[0, 5], [3, 9], [2.5, 5], [-0, 5], [NaN, 4], [2 ** 31, 3], [-1, 5], [4, 0], [1, 2.5], [-3, 7]]) {
      js.set(p, taps); m.set(p, taps)
      for (const n of [0, 1, 7]) {
        const a = js.run(n), b = m.run(n)
        ok(Object.is(a, b), `run(${n}) with p=${p}, taps=${taps} at ${optimize}: ${b} for ${a}`)
        ok(Object.is(js.cursor(), m.cursor()), `cursor after, p=${p}, taps=${taps} at ${optimize}: ${m.cursor()} for ${js.cursor()}`)
      }
    }
  }
})

test('integral loops: what else the loop writes reads the same after it', () => {
  const src = `const buf = new Float64Array(8)
    export let run = (p0, n, tag) => { let p = p0, s = tag, count = 0, last = null
      for (let i = 0; i < n; i++) { buf[p & 7] = i; buf[p] += i; s += 'ab'[i & 1]; count++; last = i > 2 ? { i } : last; p = (p + 3) % 8 }
      return s + ':' + p + ':' + count + ':' + (last ? last.i : -1) + ':' + buf[2] }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const { run } = jz(src, { optimize }).exports
    for (const [p0, n, tag] of [[1, 6, 'x'], [2.5, 4, 'y'], [-0, 3, ''], [5, 0, 'z'], [NaN, 2, 'w']]) is(run(p0, n, tag), js.run(p0, n, tag), `run(${p0}, ${n}) at ${optimize}`)
  }
})

// `p = q + 1` reads q, which the loop halves: q is no integer, so p is none
// either; the census drops both and stops (it used to re-add q forever)
test('integral loops: a handler reads what the loop wrote before it threw', () => {
  // a copy writes the cursor under a name of its own, which a throw leaves unwritten
  const src = `const buf = new Float64Array(8)
    export let run = (p0, k) => { let p = p0, h = 0
      try { for (let i = 0; i < 8; i++) { h += 1; p = (p + 1) % 5; if (i === k) throw new Error('x'); buf[p] = i } } catch (e) { return h * 100 + p }
      return h }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const [p, k] of [[2, 3], [2, 20], [2.5, 1], [0, 0]]) is(m.run(p, k), js.run(p, k), `run(${p}, ${k}) at ${optimize}`)
  }
})

test('integral loops: an index read through a name the loop writes a fraction to agrees with JS', () => {
  const src = `export let f = (n, p0) => { const a = new Float64Array(4); let p = p0, q = 0.5
    for (let i = 0; i < n; i++) { a[p] += 1; p = q + 1; q = q * 0.5 } return a[0] + a[1] * 10 + a[2] * 100 }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const { f } = jz(src, { optimize }).exports
    for (const [n, p0] of [[0, 0], [1, 0], [3, 2], [4, 1.5]]) is(f(n, p0), js.f(n, p0), `f(${n}, ${p0}) at ${optimize}`)
  }
})

// A filter state read back from storage of mixed kinds (a Float64Array by
// default, a plain list where the caller keeps one): `z1 = s[0]` is of no
// known kind, and each `+` of it asks for a string. Where the state holds
// Numbers the loop runs as a copy whose sums add.
const biquad = `function state() { return new Float64Array(2) }
function section(fc) { const a = Math.exp(-fc); return { b0: 1 - a, b1: 0.1, b2: 0, a1: -a, a2: 0.05 } }
function biquad(data, c, s = state()) {
  let z1 = s[0], z2 = s[1]
  for (let i = 0, l = data.length; i < l; i++) {
    let x = data[i]
    let y = c.b0 * x + z1
    z1 = c.b1 * x - c.a1 * y + z2
    z2 = c.b2 * x - c.a2 * y
    data[i] = y
  }
  s[0] = z1; s[1] = z2
  return data
}
const lp = section(0.3), hp = section(0.1), st = [0, 0], odd = ['1', 0]
const buf = new Float32Array(64)
export let run = (k) => {
  for (let i = 0; i < 64; i++) buf[i] = ((i * 13 + k) % 17) / 8 - 1
  biquad(buf, lp, st)
  const t = biquad(new Float32Array(buf), hp)
  const u = biquad(new Float32Array(3), hp, odd)
  return buf[7] + buf[63] + t[9] + st[0] + ':' + u[0] + u[2] + odd[0]
}`

test('integral loops: a state of unknown kind agrees with JS, a number or not', () => {
  const js = oracle(biquad)
  for (const optimize of levels(0, 2, 3)) {
    const { run } = jz(biquad, { optimize }).exports
    for (const k of [0, 1, 2, 5]) is(run(k), js.run(k), `run(${k}) at ${optimize}`)
  }
})

test('integral loops: where the state holds Numbers the loop adds them', () => {
  if (belowOpt(2)) return
  const text = wat(biquad, { optimize: 2 })
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  // the filter loop: five coefficient reads, a sample in and out, no string test
  ok(loops.some(l => (l.match(/f64\.load/g) || []).length >= 5 && /f32\.store/.test(l) && !/call \$__(is_str_key|add_slow|to_num)/.test(l)), 'a copy of the filter loop adds Numbers')
})

// A callback a factory returns keeps its state on a record, fields added on
// first use: `let keys = state.keys` may be undefined as far as the summary
// knows, and each access in the loop tests it. Where all are present the
// loop, a closure's own, runs as a copy that reads them as the typed arrays
// and the record (read only by its fields) they are.
const stateful = `function makeProcess(tol) {
  return function (mag, state) {
    if (!state.keys) { state.keys = new Float64Array(mag.length); state.acc = new Float64Array(mag.length); state.coef = { g: tol, h: 0.5 } }
    let keys = state.keys, acc = state.acc, coef = state.coef, s = 0, m = mag.length - 1
    while (m > 0) { keys[m] = mag[m] * coef.g + acc[m - 1]; acc[m] = keys[m] * coef.h; s += keys[m]; m -= 1 + (m & 1) }
    return s
  }
}
const p = makeProcess(0.3), st = {}, mag = new Float64Array(16)
export let f = (k) => { for (let i = 0; i < 16; i++) mag[i] = (i * k) % 5; return p(mag, st) }
export let g = (k) => makeProcess(k)(mag, {})`

test('integral loops: a state field that may be missing agrees with JS', () => {
  const js = oracle(stateful)
  for (const optimize of levels(0, 2, 3)) {
    const { f, g } = jz(stateful, { optimize }).exports
    for (const k of [1, 2, 3]) { is(f(k), js.f(k), `f(${k}) at ${optimize}`); is(g(k), js.g(k), `g(${k}) at ${optimize}`) }
  }
})

test('integral loops: where the state is present a copy of the closure loop reads it untested', () => {
  if (belowOpt(2)) return
  const text = wat(stateful, { optimize: 2 })
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  ok(loops.some(l => (l.match(/f64\.store/g) || []).length >= 2 && !/call \$__throw_property_nullish/.test(l)), 'a copy of the loop tests none of them')
})

test('integral loops: the integral copy reads by an i32 index', () => {
  if (belowOpt(2)) return
  const text = wat(fir, { optimize: 2 })
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  // the tap loop: a buffer read and a coefficient read, no float index to convert
  ok(loops.some(l => (l.match(/f64\.load/g) || []).length >= 2 && !/\(loop[\s\S]*\(loop/.test(l) && !/trunc_sat/.test(l)), 'an inner loop indexes without converting a float')
})

test('integral loops: the guard converts no object, and a parameter every call binds to an integer needs none (test/twin-locals.js pins its copy)', () => {
  // `key | 0` in the guard ran valueOf before the loop: once more, and where a loop of no iterations runs none
  const src = `export let f = (n) => { const a = new Float64Array(4); a[0] = 5; let calls = 0
      const key = { valueOf () { calls++; return 0 } }
      let s = 0
      for (let i = 0; i < n; i++) s += a[key]
      return s * 100 + calls }
    const walk = (s, off, n) => { let r = off, t = 0; for (let i = 0; i < n; i++) t += s[r++]; return t }
    export let g = (off) => walk(new Uint8Array(16).fill(3), off | 0, 4)`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const n of [0, 3]) is(m.f(n), js.f(n), `f(${n}) at ${optimize}`)
    is(m.g(2), js.g(2), `g at ${optimize}`)
  }
})

// A counter tested against a name of unknown integrality (`i < n`, n a lag bound
// a caller passes as a float): the counter is an int32 only in a copy where the
// bound is one, the correlation's reads then whole indices (stretch-psola's
// period search ran twice as slow without it).
test('integral loops: a counter bounded by a float of unknown integrality counts in an int32 copy', () => {
  const src = `const d = new Float32Array(96)
    for (let i = 0; i < 96; i++) d[i] = Math.sin(i * 0.37) + (i % 5) * 0.1
    function corr (data, pos, lo, hi) { let best = -1, at = 0
      for (let lag = lo; lag <= hi; lag++) { let s = 0, e = 0, n = hi
        for (let i = 0; i < n; i++) { const b = data[pos + i + lag]; s += data[pos + i] * b; e += b * b }
        const r = e > 0 ? s / Math.sqrt(e) : 0
        if (r > best) { best = r; at = lag } }
      return at * 1000 + best }
    export let f = (pos, lo, hi) => corr(d, pos * 0.5, lo * 0.5, hi * 0.5)`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const a of [[0, 4, 20], [6, 2, 30], [1, 3, 21], [80, 4, 40], [3, 7, 7]]) is(m.f(...a), js.f(...a), `f(${a}) at ${optimize}`)
  }
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  const inner = loops.filter(l => !/\(loop/.test(l.slice(5)) && /f32\.load/.test(l))
  ok(inner.some(l => !/trunc_sat/.test(l) && !/f64\.convert_i32_s/.test(l)), 'a copy of the correlation indexes by an int32 counter')
})

// A copy writes back what it wrote under names of its own after the loop: a jump
// to a label outside (`continue out`, `break out`) would leave past that, so a
// loop with one keeps its own names.
test('integral loops: a loop that jumps to a label outside it agrees with JS', () => {
  const src = `export let f = (x) => { let s = 0; s = x; out: for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { if (j > x) continue out; s += 1 } } s = s * 2; return s }
    export let g = (x, n) => { let s = x, p = 0; out: for (let k = 0; k < 3; k++) { for (let i = 0; i < n; i++) { p = (p + 3) % 7; if (p > x) break out; s += p } } return s * 10 + p }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) for (const splitBindings of [true, false]) {
    const m = jz(src, { optimize: typeof optimize === 'number' ? { level: optimize, splitBindings } : optimize }).exports
    for (const x of [0, 1, 3, 7, 2.5]) is([m.f(x), m.g(x, 6)], [js.f(x), js.g(x, 6)], `x = ${x} at ${optimize}${splitBindings ? '' : ', bindings whole'}`)
  }
})


test('integral loops: Number counters cross signed-word boundaries without wrapping', () => {
  const src = `function keep(x) { return x }
    export function up(n) { let out = []; for (let i = 2147483647; i < n; i++) { out.push(i, keep(i % 6)); if (out.length === 4) break } return out }
    export function down(n) { let out = []; for (let i = -2147483648; i > n; i--) { out.push(i, keep(i % 6)); if (out.length === 4) break } return out }
    export function stride(n) { let out = []; for (let i = 2147483646; i < n; i += 3) { out.push(i); if (out.length === 3) break } return out }
    export function observed(n) { let i = 2147483647; if (i < n) i++; const j = i; return [i, j, i < n, i === 2147483648] }
    let counter = 0;
    export function global(n) { counter = 2147483647; let out = []; while (counter < n) { out.push(counter++); if (out.length === 2) break } return out }
  `
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const m = jz(src, { optimize }).exports
    for (const n of [2147483647, 2147483649, 2147483649, 2147483651, 2147483649, NaN, Infinity, -Infinity])
      for (const name of ['up', 'stride', 'observed', 'global']) is(m[name](n), js[name](n), `${name}(${n}) at ${optimize}`)
    for (const n of [-2147483648, -2147483650, -2147483650, -2147483652, -2147483650, NaN, Infinity, -Infinity])
      is(m.down(n), js.down(n), `down(${n}) at ${optimize}`)
  }
})

test('integral loops: bounded copies preserve fractional bounds, initialization, mutation and exits', () => {
  const src = `
    export function ordinary(n) { let out = []; for (let i = 0; i < n; i++) { out.push(i, n); if (out.length === 6) break } return out }
    export function negative(n) { let out = []; for (let i = -2; i < n; i++) { out.push(i, n); if (out.length === 6) break } return out }
    export function descending(n) { let out = []; for (let i = 2; i > n; i--) { out.push(i, n); if (out.length === 6) break } return out }
    export function inclusive(n) { let out = []; for (let i = 2147483647; i <= n; i++) { out.push(i); if (out.length === 3) break } return out }
    export function changed(n) { let out = []; for (let i = (n = 2147483649, 2147483647); i < n; i++) { out.push(i); if (out.length === 3) break } return out }
    export function captured(n) { let out = [], bound = n; function change() { bound = 2147483650 } for (let i = 2147483647; i < bound; i++) { out.push(i); change(); if (out.length === 3) break } return out }
    export function moving(n) { let out = []; for (let i = 2147483647; i < n; i++) { out.push(i); n = 2147483650; if (out.length === 3) break } return out }
    export function jumped(n) { let out = []; for (let i = 2147483647; i < n; i++) { if (i === 2147483647) continue; out.push(i); break } return out }
    export function fractional(n) { let out = []; for (let i = -0; i < n; i += 0.5) { out.push(i); if (out.length === 3) break } return out }
  `
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const m = jz(src, { optimize }).exports
    for (const n of [0, 1, 1, 2.5, 1, -0, -1.5, NaN, Infinity, -Infinity, 2147483649])
      for (const name of ['ordinary', 'negative', 'descending', 'inclusive', 'changed', 'captured', 'moving', 'jumped', 'fractional'])
        is(m[name](n), js[name](n), `${name}(${n}) at ${optimize}`)
  }
})

test('integral loops: explicit word counters preserve wrapping and full Number thresholds', () => {
  const functions = [['lt', 'i < n'], ['le', 'i <= n'], ['gtMirror', 'n > i'], ['geMirror', 'n >= i']]
    .flatMap(([name, condition]) => [2147483647, -2].map((start, index) => `export function ${name}${index}(n) { let out = []; for (let i = ${start}; ${condition}; i = (i + 1) | 0) { out.push(i); if (out.length === 3) break } return out }`)).join('\n')
  const js = oracle(functions)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const m = jz(functions, { optimize }).exports
    for (const n of [2147483647, 2147483649, 2147483649, -1.5, 2147483649, -2147483649, -0, NaN, Infinity, -Infinity])
      for (const name of Object.keys(js)) is(m[name](n), js[name](n), `${name}(${n}) at ${optimize}`)
  }
})
