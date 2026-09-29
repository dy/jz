// Array arguments at the export boundary. An export whose parameter is used as
// a numeric array has kind variants (narrow/param-abi.js): Float64Array at every
// typed slot under its own name, Float32Array under a hidden one, and, where an
// in-place slot (stored into and read back) stands beside another, Float32Array
// there with Float64Array elsewhere. The host calls the one its arguments fit exactly
// (interop.js kindDispatch), so an element the body stores and reads back
// rounds as the caller's array rounds it; a conversion to Float64Array is taken
// only where it is exact. Whatever the call writes into an argument's copy
// comes back, read after the call (it may grow the memory).
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels, belowOpt, onWasi } from './_matrix.js'
import { oracle } from './util.js'

const src = `
export let readBack = (a) => { a[0] = 0.1; a[1] = 1.5; a[2] = 300; return a[0] + a[1] + a[2] }
export let gain = (buf, g) => { for (let i = 0; i < buf.length; i++) buf[i] = buf[i] * g; return buf.length }
export let iir = (x, c) => { let y1 = 0; for (let i = 0; i < x.length; i++) { const y = c[0] * x[i] + c[1] * y1; x[i] = y; y1 = x[i] } return x[x.length - 1] }
export let sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }
export let half = (a, b) => { for (let i = 0; i < a.length; i++) b[i] = a[i] * 0.5; return b.length }
export let open = (x) => { for (let i = 1; i < x.length; i++) x[i] = x[i] * 0.3 + x[i - 1] * 0.7; return x[x.length - 1] }`

const fill = (K, n, f) => { const a = K === Array ? new Array(n) : new K(n); for (let i = 0; i < n; i++) a[i] = f(i); return a }
const wave = i => Math.sin(i * 0.7) * 3.3
const same = (a, b) => a.length === b.length && Array.prototype.every.call(a, (v, i) => Object.is(v, b[i]))
// Calls whose arguments each variant takes exactly, as [name, make-arguments].
const CALLS = [
  ...[Float64Array, Float32Array, Array].map(K => [`readBack(${K.name})`, 'readBack', () => [fill(K, 3, () => 0)]]),
  ...[Float64Array, Float32Array, Array].map(K => [`gain(${K.name})`, 'gain', () => [fill(K, 9, wave), 0.3]]),
  ...[Float64Array, Float32Array].map(K => [`iir(${K.name}, Array)`, 'iir', () => [fill(K, 17, wave), [0.3, 0.71]]]),
  ['iir(Float32Array, Float32Array)', 'iir', () => [fill(Float32Array, 17, wave), Float32Array.of(0.3, 0.71)]],
  ...[Float64Array, Float32Array, Int16Array, Uint8Array, Int32Array, Array].map(K => [`sum(${K.name})`, 'sum', () => [fill(K, 7, i => i * 1.7)]]),
  ['half(Float32Array, Float64Array)', 'half', () => [fill(Float32Array, 5, wave), new Float64Array(5)]],
  ['half(Float64Array, Int16Array)', 'half', () => [fill(Float64Array, 5, i => i * 91.7), new Int16Array(5)]],
  ['half(Float32Array, Float32Array)', 'half', () => [fill(Float32Array, 5, wave), new Float32Array(5)]],
  ['half(x, x): one array at two slots', 'half', () => { const x = fill(Float64Array, 5, wave); return [x, x] }],
  ...[Float64Array, Float32Array, Int16Array].map(K => [`open(${K.name}), a slot the compiler left open`, 'open', () => [fill(K, 9, i => i * 10)]]),
]

for (const optimize of levels(0, 2, 3, 'size'))
  test(`call boundary: results and arguments agree with the host at ${optimize}`, () => {
    const want = oracle(src), { exports } = jz(src, { optimize })
    for (const [label, name, make] of CALLS) {
      const a = make(), b = make()
      is(exports[name](...b), want[name](...a), `${label}: result at ${optimize}`)
      ok(a.every((x, i) => typeof x !== 'object' || same(x, b[i])), `${label}: arguments after the call at ${optimize}`)
    }
  })

test('call boundary: an in-place slot refuses a kind that would round otherwise', () => {
  const { exports } = jz(src)
  for (const K of [Int16Array, Uint8Array, Int32Array])
    throws(() => exports.gain(new K(4), 0.5), e => e instanceof TypeError && /reads it back/.test(e.message), `gain(${K.name})`)
  throws(() => exports.sum(null), e => e instanceof TypeError, 'sum(null)')
  // The mixed variant: the in-place slot takes Float32Array, the read one Float64Array.
  const want = oracle(src).iir(fill(Float32Array, 9, wave), Float64Array.of(0.3, 0.71))
  is(exports.iir(fill(Float32Array, 9, wave), Float64Array.of(0.3, 0.71)), want, 'iir(Float32Array, Float64Array)')
})

test('call boundary: a jz buffer of the slot kind is the storage, another kind converts and comes back', () => {
  for (const optimize of levels(0, 2)) {
    const { exports, memory } = jz(src, { optimize })
    for (const K of ['Float64Array', 'Float32Array']) {
      const box = memory[K](new globalThis[K]([1, 2, 3, 4]))
      is(exports.gain(box, 0.5), 4, `gain(${K} buffer) at ${optimize}`)
      ok(same(memory.read(box), new globalThis[K]([0.5, 1, 1.5, 2])), `${K} buffer written in place at ${optimize}`)
    }
    // A view of this memory is copied like any host array; its writes go back into the region it spans.
    const parent = memory.Float64Array(new Float64Array([1, 2, 3, 4, 5, 6]))
    const sub = memory.read(parent).subarray(2, 5)
    is(exports.gain(sub, 2), 3, `gain(subarray view) at ${optimize}`)
    ok(same(memory.read(parent), new Float64Array([1, 2, 6, 8, 10, 6])), `writes land in the subarray's parent at ${optimize}`)
  }
})

test('call boundary: a call that grows the memory still writes back into the buffer it was given', () => {
  // An Int16Array buffer at a written Float64Array slot converts to a copy; the
  // call grows the memory (its views detach) and the write-back re-reads the
  // buffer after.
  const grow = `export let fill = (src, out, n) => { const t = new Float64Array(n); t[n - 1] = 1; for (let i = 0; i < out.length; i++) out[i] = src[i] + 1; return t[n - 1] + t.length }`
  const { exports, memory } = jz(grow)
  const box = memory.Int16Array(new Int16Array(3)), before = memory.buffer.byteLength
  is(exports.fill([1, 2, 3], box, 1 << 20), (1 << 20) + 1)
  ok(memory.buffer.byteLength > before, 'the call grew the memory')
  ok(same(memory.read(box), new Int16Array([2, 3, 4])), 'the Int16Array buffer took the writes')
})

test('call boundary: a helper the variants call runs typed in each kind', () => {
  // Each variant's call joins the census: the helper splits per kind rather than reading any array.
  const src = `function dot(w, t) { let s = 0; for (let i = 0; i < t.length; i++) s += w[i] * t[i]; return s }
    export let fit = (target) => { const w = new Float64Array(target.length); for (let i = 0; i < w.length; i++) w[i] = i; return dot(w, target) }`
  if (!belowOpt(2)) ok(!/\$__typed_idx|\$__to_num/.test(compile(src, { wat: true })), 'no generic element read')
  const want = oracle(src), { exports } = jz(src)
  // whole numbers: a float sum may add in lanes (README), these add exactly
  for (const K of [Float64Array, Float32Array, Array]) is(exports.fit(fill(K, 7, i => i * 3 - 5)), want.fit(fill(K, 7, i => i * 3 - 5)), `fit(${K.name})`)
})

test('call boundary: a variant is minted where its kinds differ', () => {
  const hidden = (fn, code = src) => WebAssembly.Module.exports(new WebAssembly.Module(compile(code))).map(e => e.name).filter(n => n.startsWith(fn + ':')).sort()
  is(hidden('sum').join(), 'sum:Float32Array', 'a read-only slot: the Float32Array kinds only')
  is(hidden('gain').join(), 'gain:Float32Array', 'an in-place slot alone: the mixed kinds are Float32Array\'s')
  const mix = 'export let mix = (out, src) => { for (let i = 0; i < out.length; i++) out[i] = out[i] * 0.5 + src[i]; return out.length }'
  is(hidden('mix', mix).join(), 'mix:Float32Array,mix:mixed', 'an in-place slot beside a read-only one: both')
  // `out` takes its kind a round after `acc`, whose elements it stores: the
  // mixed variant is minted then, `acc` taking its Float32Array there
  const late = 'export let late = (acc, out, n) => { for (let i = 0; i < n; i++) acc[i] = acc[i] * 0.5 + 1; for (let i = 0; i < n; i++) out[i] = acc[i] + acc[i] * 0.5; return n }'
  is(hidden('late', late).join(), 'late:Float32Array,late:mixed', 'minted in a later round')
  for (const [code, name, make] of [[mix, 'mix', () => [Float32Array.of(1, 2), Float64Array.of(0.1, 0.2)]], [late, 'late', () => [Float32Array.of(0.1, 0.2), new Float64Array(2), 2]]]) {
    const want = oracle(code)[name], { exports } = jz(code), a = make(), b = make()
    is(exports[name](...a), want(...b), name)
    ok(a.every((x, i) => typeof x !== 'object' || same(x, b[i])), `${name}: the mixed kinds round as JS rounds them`)
  }
})

test('call boundary: a slot that may be a written plain array takes any value and selects no variant', () => {
  // The compiler marks a parameter the body may store into as a plain array `Array+`
  // (boundary-wrap.js), and says so of more than it must: `n`, handed to subarray,
  // carries the mark beside the typed slot. Such a slot takes whatever arrives, as
  // itself; only the typed slots choose the variant (interop.js slotsOf).
  const code = `export let head = (data, n) => { let h = data.subarray(0, n); let s = 0; for (let i = 0; i < h.length; i++) s += h[i]; return s }
    export let damp = (buf, n) => { const h = buf.subarray(0, n); for (let i = 0; i < buf.length; i++) buf[i] = buf[i] * 0.1; return buf[0] + buf[1] + h.length }`
  const slots = Object.fromEntries(JSON.parse(new TextDecoder().decode(
    WebAssembly.Module.customSections(new WebAssembly.Module(compile(code)), 'jz:i64exp')[0])).map(e => [e.name, e.t]))
  is(slots.head['1'], 'Array+', 'head: the number parameter carries the mark')
  is(slots.damp['1'], 'Array+', 'damp: beside an in-place typed slot')
  const want = oracle(code), { exports } = jz(code)
  is(exports.head([1, 2, 3, 4], 2), 3, 'head(Array, number): 1 + 2')
  is(exports.head(Float32Array.of(1, 2, 3, 4), 3), want.head(Float32Array.of(1, 2, 3, 4), 3), 'head(Float32Array, number)')
  // 0.1 stored into a Float32Array reads back 0.10000000149011612: the sum tells the variant that ran.
  for (const K of [Float32Array, Float64Array]) {
    const a = K.of(1, 2, 3), b = K.of(1, 2, 3)
    is(exports.damp(b, 2), want.damp(a, 2), `damp(${K.name}, number): the variant of its kind`)
    ok(same(a, b), `damp(${K.name}, number): the argument after the call`)
  }
})

test('call boundary: the variants stay hidden, their advisories speak once', () => {
  const warnings = []
  const { exports } = jz(src, { warnings: w => warnings.push(w) })
  is(Object.keys(exports).filter(k => k.includes(':')).length, 0, 'no variant among the exports')
  ok(!warnings.some(w => /\$(Float32Array|mixed)/.test(`${w.fn} ${w.message}`)), 'no advisory names a variant')
})

test('call boundary: a typed array the module keeps on a host object stays its storage', () => {
  if (onWasi()) return  // an object of the host's
  // interop.js __ext_set files a live view and wrapVal reads it back as the
  // module's own storage: state carried on a caller's options object accumulates.
  const src = `export let bag = (p, x) => { const s = p.state ??= new Float64Array(2); s[0] = s[0] * 0.5 + x; return s[0] }`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const want = oracle(src), { exports } = jz(src, { optimize })
    const a = {}, b = {}
    for (let i = 0; i < 5; i++) is(exports.bag(b, 3), want.bag(a, 3), `call ${i} at ${optimize}`)
    is(b.state[0], a.state[0], `the host reads the module's state at ${optimize}`)
  }
})
