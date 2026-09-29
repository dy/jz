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
