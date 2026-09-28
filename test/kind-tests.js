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

// A parameter's default reads its argument by position when the function reads
// `arguments` (jzify/arguments.js). What the calls pass there decides the
// default's test: a `null` argument is no missing one, so `f(null)` keeps it.
test('kind tests: a default read by position runs only where a call leaves the argument out', () => {
  const cases = [
    `function f(a = 9) { return arguments.length * 100 + (a === null ? 10 : a === undefined ? 20 : a) }
export let g = () => f() * 1000 + f(null)`,
    `function f(a = 9) { return arguments.length * 100 + a }
export let g = () => f() * 1000 + f(5)`,
    `function f(a = 9) { return arguments.length * 100 + a }
export let g = () => f() * 1000 + f(undefined)`,
    `function f(a, b = 7) { return arguments.length * 100 + a + b }
export let g = () => f(1) * 1000 + f(1, 2)`,
  ]
  for (const src of cases) {
    const want = oracle(src).g()
    for (const optimize of levels(0, 2)) is(jz(src, { optimize }).exports.g(), want, `${src.split('\n')[1]} at ${optimize}`)
  }
})

// A decided test still runs where evaluating it may do something: a call its
// `||` evaluates before the operand that decided it, a member read that throws
// on a missing receiver. Only the arm it never takes goes.
test('kind tests: a decided test keeps its effects', () => {
  const cases = [
    `let n = 0
let bump = () => { n++; return 0 }
export let f = (k) => { const o = { a: k }; if (bump() || o) return n * 10 + o.a; return -1 }`,
    `let n = 0
let bump = () => { n++; return 1 }
export let f = (k) => { const s = 'x'; const r = (bump() && typeof s === 'number') ? 1 : 2; return n * 10 + r }`,
    `export let f = (k) => { const x = k > 0 ? 5 : null; try { if (x.foo) return 1; return 2 } catch (e) { return 3 } }`,
  ]
  for (const src of cases) for (const optimize of levels(0, 2)) {
    const js = oracle(src), mod = jz(src, { optimize }).exports
    is([mod.f(0), mod.f(1)], [js.f(0), js.f(1)], `${src.split('\n').pop()} at ${optimize}`)
  }
})
