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
