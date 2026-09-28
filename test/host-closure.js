// A closure the host holds is a function it calls: `{ encode, flush, free }`,
// the contract of a codec or a stream, returned by an export and driven from
// JavaScript. The module exports one trampoline (module/function.js
// __call_closure) when a closure's callers are unknown; the host reads the
// closure as a function calling it (interop.js wrap), with the arguments
// wrapped, the result read, a throw decoded and a promise adopted. Before, the
// host read the closure's box as a number.
import test from 'tst'
import { is } from 'tst/assert.js'
import { levels, onWasi } from './_matrix.js'
import { oracle, run } from './util.js'

const src = `
export let encoder = () => {
  let total = 0
  let sums = []
  let encode = (block) => { let s = 0; for (let i = 0; i < block.length; i++) s += block[i]; total += s; sums.push(s); return s }
  let flush = () => total + ':' + sums.join('/')
  let free = () => { sums.length = 0; return sums.length }
  return { encode, flush, free }
}
export let pair = () => [(a, b) => a + b, (s) => s + '!']
export let keyed = () => new Map([['inc', (x) => x + 1], ['neg', (x) => -x]])
export let rest = () => (a, ...xs) => a + ':' + xs.length + ':' + xs.join(',')
export let curry = () => (k) => (x) => x * k
export let thrower = () => (m) => { throw new RangeError('bad ' + m) }
export let counter = () => ({ n: 0, inc() { this.n++; return this.n } })
function twice(x) { return x * 2 }
export let named = () => twice
export let viaHost = (each, n) => { let s = 0; each(n, (i) => { s += i * i }); return s }
export let later = () => async (x) => x * 10
`

// What the host observes driving the exports: the same script for both.
const drive = async (e) => {
  const out = []
  const enc = e.encoder()
  out.push(typeof enc.encode, enc.encode([1, 2, 3]), enc.encode([4.5]), enc.flush(), enc.free(), enc.flush())
  const [add, bang] = e.pair()
  out.push(add(2, 3), add('a', 1), bang('hi'))
  const m = e.keyed()
  out.push(m.get('inc')(9), m.get('neg')(4))
  const r = e.rest()
  out.push(r(1), r(1, 2, 3), r(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11))
  out.push(e.curry()(3)(7))
  try { e.thrower()('x'); out.push('no throw') } catch (err) { out.push(err instanceof RangeError, err.message) }
  const c = e.counter()
  out.push(c.inc(), c.inc())
  out.push(e.named()(21))
  // a host function calling back into the module (WASI passes no host values)
  if (!onWasi()) out.push(e.viaHost((n, cb) => { for (let i = 0; i < n; i++) cb(i) }, 4))
  out.push(await e.later()(4))
  return out
}

for (const optimize of levels(0, 2, 3, 'size'))
  test(`host closure: the host calls a returned closure at ${optimize}`, async () => {
    const want = await drive(oracle(src))
    const got = await drive(run(src, { optimize }))
    is(got, want)
  })

// A closure stored on a host object or passed to its method: the host calls
// it later, as a listener.
test('host closure: a host object holds a closure and calls it', () => {
  if (onWasi()) return
  const e = run(`export let attach = (el, k) => { el.onclick = (v) => v * k; el.addEventListener('x', (v) => v + k); return 1 }`)
  const el = { l: [], addEventListener(type, f) { this.l.push(f) } }
  e.attach(el, 3)
  is([typeof el.onclick, el.onclick(5), el.l.length, el.l[0](5)], ['function', 15, 1, 8])
})
