// A closure made inside an async function or a generator is typed as the
// same closure made inside a plain function. An await resumes with the settled
// value of its operand (`__awaited`, jzify/generators.js), which the summary
// reads off a promise it names at each async call (src/summary/index.js
// promiseAt, awaited); the machine's locals hold no value before the statement
// that initializes them (src/ast.js TDZ). The kernel is
// the encoder of @audio/encode-wav, made by an async factory (bench/_audiojs
// shapes.mjs, S8): its loop called `__add_slow`, `__is_str_key` and
// `__dyn_set` per sample, 0.03× of V8 where the plain factory ran 0.3×.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels, onKernel, onWasi } from './_matrix.js'
import { oracle, wat } from './util.js'

const N = 64
const kernel = `
function i24(ch, nch, len, buf) {
  for (let c = 0; c < nch; c++) for (let x = ch[c], i = 0, o = c * 3; i < len; i++, o += nch * 3) {
    let s = x[i], v = Math.floor((s < -1 ? -1 : s > 1 ? 1 : s) * 0x7FFFFF + 0.5)
    buf[o] = v & 0xFF; buf[o + 1] = (v >> 8) & 0xFF; buf[o + 2] = (v >> 16) & 0xFF
  }
}
function i16(ch, nch, len, buf) { let out = new Int16Array(buf.buffer, 0, len * nch); for (let c = 0; c < nch; c++) for (let x = ch[c], i = 0, o = c; i < len; i++, o += nch) { let s = x[i]; out[o] = Math.floor((s < -1 ? -1 : s > 1 ? 1 : s) * 0x7FFF + 0.5) } }
let X = new Float32Array(${N}), Y = new Float32Array(${N})
for (let i = 0; i < ${N}; i++) { X[i] = Math.sin(i * 0.3) * 1.2; Y[i] = Math.cos(i * 0.2) * 0.9 }
let enc = null
export let run = () => { let b = enc.encode([X, Y]), h = 0; for (let i = 0; i < b.length; i++) h = (h * 31 + b[i]) | 0; return h }
`
const body = `let { bitDepth = 16 } = opts, bps = bitDepth >> 3, nch = 0`
const encode = `function encode(ch) { if (!nch) nch = ch.length; let len = ch[0].length, buf = new Uint8Array(len * nch * bps); (bitDepth === 24 ? i24 : i16)(ch, nch, len, buf); return buf }`
const FACTORIES = {
  plain: `function wav(opts) { ${body}; return { encode }; ${encode} }
export let open = () => { enc = wav({ bitDepth: 24 }); return 1 }`,
  async: `async function wav(opts) { ${body}; return { encode }; ${encode} }
export let open = async () => { enc = await wav({ bitDepth: 24 }); return 1 }`,
  generator: `function* wav(opts) { ${body}; yield { encode }; ${encode} }
export let open = () => { enc = wav({ bitDepth: 24 }).next().value; return 1 }`,
}
const asyncShape = (name) => name.startsWith('async')
// What a loop pays per sample when an index, a store target or a number has
// lost its kind: a generic sum, a key test, a generic store, a conversion.
const SLOW = /call \$(__add_slow|__dyn_set|__is_str_key|__str_concat_fresh|__to_num)\b/g
const span = (text, at) => { let d = 0; for (let i = at; i < text.length; i++) { if (text[i] === '(') d++; else if (text[i] === ')' && --d === 0) return text.slice(at, i + 1) } return text.slice(at) }
// Those calls inside the loops of the program's own functions (the runtime's are `__…`, `jz_…$…`).
const slowLoops = (text) => {
  const out = new Set()
  for (const m of text.matchAll(/\n {2}\(func \$\uE000?([^\s)]+)/g)) {
    if (/^(__|jz_)/.test(m[1])) continue
    const fn = span(text, m.index + 3)
    for (const l of fn.matchAll(/\(loop\b/g)) for (const c of span(fn, l.index).match(SLOW) ?? []) out.add(`${m[1]}: ${c}`)
  }
  return [...out]
}

test('async factory: the closures it makes agree with JavaScript', async () => {
  for (const [name, factory] of Object.entries(FACTORIES)) {
    if (asyncShape(name) && (onWasi() || onKernel())) continue
    const src = kernel + factory, host = oracle(src)
    await host.open()
    const want = host.run()
    for (const optimize of levels(0, 2, 3)) {
      const m = jz(src, { optimize }).exports
      await m.open()
      is(m.run(), want, `${name} factory at ${optimize}`)
      is(m.run(), want, `${name} factory at ${optimize}, again`)
    }
  }
})

test('async factory: the kernel loop compiles as the plain factory\'s', () => {
  if (belowOpt(2) || onWasi()) return
  for (const [name, factory] of Object.entries(FACTORIES)) {
    const slow = slowLoops(wat(kernel + factory, { optimize: 2 }))
    ok(!slow.length, `${name} factory: no generic sum, key test, store or conversion per sample: ${slow.join('; ')}`)
  }
})

test('async factory: an await resumes with the settled value of its operand', async () => {
  if (onWasi() || onKernel()) return
  // each await its own kind: a number, a record, an array, a closure, a string,
  // a value that is no promise, a promise another async call settles with
  const src = `const num = async (n) => n * 2
const rec = async (n) => ({ a: n, b: [n, n + 1] })
const fn = async (k) => (x) => x * k
const str = async (n) => 'v' + n
const inner = async (n) => ({ k: n })
const outer = async (n) => inner(n + 1)
export let f = async (n) => {
  const x = await num(n), r = await rec(x), g = await fn(3), t = await str(n), p = await { v: n }, o = await outer(n)
  let s = 0
  for (let i = 0; i < 3; i++) { const q = await rec(i); s += q.b[1] }
  return x + r.a + r.b[1] + g(n) + t.length + p.v + o.k + s
}`
  const want = await oracle(src).f(5)
  for (const optimize of levels(0, 2, 3)) is(await jz(src, { optimize }).exports.f(5), want, `at ${optimize}`)
})

test('async factory: a promise made another way, a thenable and a rejection keep their values', async () => {
  if (onWasi() || onKernel()) return
  const src = `const bad = async (n) => { if (n > 0) throw new Error('boom ' + n); return n }
const opt = async ({ a } = null) => a
export let f = async (n) => {
  const r = await Promise.resolve({ w: n }), q = await new Promise((res) => res(n * 3)), t = await { then(res) { res(n + 5) } }
  let e = '', d = ''
  try { await bad(n) } catch (x) { e = x.message }
  try { await opt(null) } catch (x) { d = 'rejected' }
  return r.w + q + t + e + d
}`
  const want = await oracle(src).f(2)
  for (const optimize of levels(0, 2, 3)) is(await jz(src, { optimize }).exports.f(2), want, `at ${optimize}`)
})

test('generator: a declaration without a value is undefined each time it runs', () => {
  // the loop suspends, so its body's `let x` is one of the machine's locals
  const src = `function* g(n) { for (let i = 0; i < 3; i++) { let x; if (i === n) x = i; yield String(x) } }
export let f = (n) => [...g(n)].join(',')`
  const want = oracle(src).f(0)
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.f(0), want, `at ${optimize}`)
})
