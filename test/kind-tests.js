// A test the summary's kinds decide takes one arm on every run: `x instanceof
// Float32Array` of a binding that only ever holds Float32Arrays, Array.isArray
// of one that holds none (summary/index.js decided). The summary walks the arm
// that runs alone, so an overloaded function, its first argument samples here
// and options there, keeps the options object's shape where only the samples'
// path runs; the plan drops the arm that never runs (plan/fold-kind-tests.js).
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
