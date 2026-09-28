// A test the summary's kinds decide takes one arm on every run: `x instanceof
// Float32Array` of a binding that only ever holds Float32Arrays, Array.isArray
// of one that holds none, `typeof x === 'function'` of one that holds numbers,
// a name that only holds null (summary/index.js decided). The summary walks
// the arm that runs alone, so an overloaded function, its first argument
// samples here and options there, keeps the options object's shape where only
// the samples' path runs; the plan drops the other arm (plan/fold-kind-tests.js).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

const src = `
let settings = (o) => ({ size: o?.frameSize ?? 2048, f: o?.factor ?? 1 })
let stretch = (data, opts) => {
  if (Array.isArray(data) && data.length) return data.map(ch => stretch(ch, opts))
  if (data instanceof Float64Array) data = Float32Array.from(data)
  if (!(data instanceof Float32Array)) return settings(data).size
  let o = settings(opts), s = 0
  for (let i = 0; i < data.length; i++) s += data[i] * o.f
  return s + o.size
}
let inp = new Float32Array(8).fill(0.5)
export let batch = (k) => stretch(inp, { factor: k, frameSize: 1024 })
let kind = (v) => v instanceof Float32Array ? 'f32' : Array.isArray(v) ? 'arr' : v instanceof Map ? 'map' : v instanceof Set ? 'set' : typeof v
export let mixed = (k) => [kind(inp), kind([1]), kind(new Map()), kind(new Set()), kind(k), kind(k > 0 ? inp : [2]), kind(inp.subarray(2))].join()
`

for (const optimize of levels(0, 2, 3, 'size'))
  test(`kind tests: decided and open tests agree with the host at ${optimize}`, () => {
    const host = oracle(src), mod = jz(src, { optimize }).exports
    for (const k of [0, 3]) {
      is(mod.batch(k), host.batch(k), `batch(${k})`)
      is(mod.mixed(k), host.mixed(k), `mixed(${k})`)
    }
  })

test('kind tests: the arm a decided test never takes loses no shape', () => {
  const entries = []
  compile(src, { warnings: { entries } })
  const lost = entries.filter(e => e.code === 'shape-lost' && /factor|frameSize/.test(e.message))
  ok(!lost.length, lost.map(e => e.message).join('; '))
})

// An option that may be a number or a function (a stretch factor, a hop):
// given a number, `typeof f === 'function'` is false, the hook it guards stays
// null, and the object handed to the hook's call is never handed anywhere.
const hooks = `
let settings = (o) => { let f = o?.factor ?? 1, hop = typeof f === 'function' ? (t) => 512 / f(t) : 512 / f; return { hop } }
let run = (o) => { const h = settings(o).hop, fn = typeof h === 'function' ? h : null; const ctx = { a: 1, b: 2 }; let s = 0; for (let i = 0; i < 4; i++) { if (fn) ctx.a = fn(i, ctx); s += ctx.a * ctx.b + (fn ? 0 : h) } return s }
export let lit = () => run({ factor: 0.8 })
let kind = (v) => typeof v === 'number' ? 'n' : typeof v === 'string' ? 's' : typeof v === 'object' ? (v === null ? 'null' : 'o') : typeof v === 'undefined' ? 'u' : typeof v
export let kinds = (k) => [kind(1), kind('a'), kind(null), kind(undefined), kind({}), kind([]), kind(() => 1), kind(k > 0 ? 1 : 'x'), kind(k > 0 ? null : undefined)].join()`

test('kind tests: typeof and a name decide their tests where the kinds do', () => {
  const host = oracle(hooks)
  for (const optimize of levels(0, 2, 3)) {
    const mod = jz(hooks, { optimize }).exports
    is(mod.lit(), host.lit(), `lit at ${optimize}`)
    for (const k of [0, 1]) is(mod.kinds(k), host.kinds(k), `kinds(${k}) at ${optimize}`)
  }
  const entries = []
  compile(hooks, { warnings: { entries } })
  ok(!entries.some(e => e.code === 'shape-lost'), entries.filter(e => e.code === 'shape-lost').map(e => e.message).join('; '))
})
