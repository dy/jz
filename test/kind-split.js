// A loop reading elements of a name that may hold a typed array or something
// else runs, where it holds the typed array, as a copy reading that array's
// elements by their kind (plan/kind-split.js; the summary narrows a typed
// array class test to its element kind): the same values, the same throws.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat } from './util.js'

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
const loopsOf = (text) => {
  const out = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    out.push(text.slice(at, end))
  }
  return out
}

// the modal synth's exciter: an impulse the kernel makes, or what the caller passed
const modal = `let render = (exciter, n) => {
  let exc
  if (exciter === 'impulse') { exc = new Float32Array(1); exc[0] = 1 } else exc = exciter
  let out = new Float32Array(n), y = 0
  for (let i = 0; i < n; i++) { let x = i < exc.length ? 0.5 * exc[i] : 0; y = y * 0.9 + x; out[i] = y }
  return out
}
export let f = (k, n) => render(k ? 'impulse' : 'noise', n)[3]
export let g = (n) => render(new Float32Array(8).fill(0.25), n)[5]
export let h = (n) => { let b = new Float32Array(16).fill(0.5); return render(b.subarray(4, 12), n)[6] }`

test('kind split: a name of several kinds reads its typed elements by kind where it holds them', () => {
  agrees(modal, [['f', 1, 50], ['f', 0, 50], ['g', 20], ['h', 20], ['f', 1, 0]])
  // a caller passing another element kind: the test fails for it, the loop reads it as before
  agrees(modal + `\nexport let d = (n) => render(new Float64Array(8).fill(0.125), n)[5]`, [['d', 20], ['g', 20]])
  if (belowOpt(2)) return
  ok(loopsOf(wat(modal, { optimize: 2 })).some(l => /f32\.load/.test(l) && !/call \$__(typed_idx|dyn_get|length)/.test(l)), 'a loop reads the elements as Float32 loads')
})

test('kind split: a name the loop writes or a closure sees keeps one loop', () => {
  agrees(`export let f = (k, n) => { let a = k ? new Float32Array(4).fill(1) : 'abcd', s = 0
    for (let i = 0; i < n; i++) { s += a.length; if (i === 2) a = 'xy' } return s }`, [['f', 1, 5], ['f', 0, 5]])
  agrees(`export let f = (k, n) => { let a = k ? new Float32Array(4).fill(1) : 'abcd', s = 0
    let swap = () => { a = [9, 9] }
    for (let i = 0; i < n; i++) { s += a[i % 4] === undefined ? 0 : 1; if (i === 1) swap() } return s }`, [['f', 1, 5], ['f', 0, 5]])
})

// a kernel taking a mono buffer or a list of channels (the reverbs' `data`):
// its channels are the typed arrays the callers pass, so each copy the loop
// runs as reads them by kind, and sums them as numbers
test('kind split: a mono buffer or a list of channels reads the channels by their kind', () => {
  const src = `const mono = new Float32Array([0.5, -1, 2, 0.25]), left = new Float32Array([1, 2, 3, 4]), right = new Float32Array([4, 3, 2, 1])
const mix = (data, g) => {
  let stereo = data[0]?.length !== undefined
  let L = stereo ? data[0] : data, R = stereo ? data[1] : null, acc = 0
  for (let i = 0; i < L.length; i++) {
    let x = stereo ? (L[i] + R[i]) * 0.5 : L[i]
    acc = acc * g + x
    if (stereo) { L[i] = x; R[i] = -x } else L[i] = x * 2
  }
  return acc
}
export let run = (which, g) => which ? mix([left, right], g) : mix(mono, g)
export let peek = () => [...mono, ...left, ...right].join()`
  agrees(src, [['run', 0, 0.5], ['run', 1, 0.5], ['run', 1, 2], ['peek']])
  // channels of another kind: the test fails for them, the loop reads them as before
  agrees(src + `\nexport let odd = (g) => mix([new Float64Array([1, 2]), 'ab'], g) + mix([new Float32Array(2), new Float64Array(2)], g)`, [['odd', 0.5], ['run', 1, 0.5]])
  if (belowOpt(2)) return
  const f = wat(src, { optimize: 2 }), mix = f.slice(f.indexOf('(func $mix'), f.indexOf('(func', f.indexOf('(func $mix') + 5))
  ok(loopsOf(mix).some(l => /f32\.load/.test(l) && !/call \$__(add_slow|typed_idx|dyn_get)/.test(l)), 'a loop reads the channels as Float32 and adds numbers')
})

// A kernel a tracker's closure calls with the array its factory was given: one
// caller passes a Float32Array, another a Float64Array. Each constructor gets a
// copy of the loop, the class test proving its element kind though the name
// held a number array of either kind before it.
test('kind split: an array of either of two kinds, handed on through a closure, reads each by its kind', () => {
  const src = `function g(data, pos, N, win) { let re = 0, im = 0; for (let i = 0; i < N; i++) { let x = (data[pos + i] || 0) * win[i]; re += x * 0.5; im -= x * 0.25 } return [re, im] }
function mk(source, N) { const win = new Float64Array(N).fill(0.5); return function at(t) { const [r0, i0] = g(source, t, N, win); const [r1, i1] = g(source, t + 1, N, win); return r0 + i1 } }
export let a = (n) => { const m = new Float32Array(n).map((_, i) => i * 0.25); const at = mk(m, 8); return at(1) + at(n - 4) }
export let b = (n) => { const m = new Float64Array(n).map((_, i) => i * 0.1); const at = mk(m, 8); return at(1) + at(n - 2) }
export let c = (n) => { const m = new Int16Array(n).fill(3); const at = mk(m, 8); return at(2) }`
  agrees(src, [['a', 16], ['b', 16], ['a', 6], ['b', 5], ['c', 12]])
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 }), g = text.slice(text.indexOf('(func $g'), text.indexOf('\n  (func ', text.indexOf('(func $g') + 5))
  const loops = loopsOf(g)
  ok(loops.some(l => /f32\.load/.test(l) && !/call \$__typed_idx/.test(l)), 'a copy reads Float32 loads')
  ok(loops.some(l => !/f32\.load/.test(l) && /f64\.load[\s\S]*f64\.load/.test(l) && !/call \$__typed_idx/.test(l)), 'a copy reads Float64 loads')
})

// A name that holds one of several functions (a namespace read by a key the
// host picks) returns what each of them returns: the loop over the result is
// copied for each constructor, also where the callback that runs it was spliced
// into the function that called its factory (the summary looks at the splice).
test('kind split: the result of a call through a choice of functions reads by the kind each returns', () => {
  const c = `export function white (n, seed) { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = (i * seed) % 7; return d }
export function pink (n, seed) { const d = new Float64Array(n); for (let i = 0; i < n; i++) d[i] = (i + seed) % 5; return d }`
  const direct = `import * as colors from './c.js'
export let run = (color, n) => { const fn = colors[color]; const d = fn(n, 3); const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = d[i] * 0.5; return out[n - 1] }`
  const factory = `import * as colors from './c.js'
const make = (seed) => (color, n, out) => { const fn = colors[color]; const d = fn(n, seed); for (let i = 0; i < n; i++) out[i] = d[i] * 0.5 }
let proc = null
export let start = (seed) => { proc = make(seed); return 1 }
export let run = (color, n) => { const out = new Float32Array(n); proc(color, n, out); return out[n - 1] }`
  const host = new Function(c.replace(/export /g, '') + '; return { white, pink }')()
  const want = (color, n, seed = 3) => host[color](n, seed)[n - 1] * 0.5
  for (const optimize of levels(0, 2, 3)) {
    const d = jz(direct, { modules: { './c.js': c }, optimize }).exports
    const f = jz(factory, { modules: { './c.js': c }, optimize }).exports
    f.start(3)
    for (const [color, n] of [['white', 9], ['pink', 9], ['white', 2], ['pink', 40]]) {
      ok(Object.is(d.run(color, n), want(color, n)), `${color}(${n}) at ${optimize}`)
      ok(Object.is(f.run(color, n), Math.fround(want(color, n))), `${color}(${n}) through the callback at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  for (const src of [direct, factory]) {
    const text = wat(src, { modules: { './c.js': c }, optimize: 2 })
    const loops = loopsOf(text).filter(l => /f32\.store/.test(l) && !/\(loop[\s\S]*\(loop/.test(l.slice(5)))
    ok(loops.some(l => /f32\.load/.test(l) && !/call \$__typed_idx/.test(l)) && loops.some(l => /f64\.load/.test(l) && !/call \$__typed_idx/.test(l)), 'a copy reads each kind')
  }
})

// An AudioBuffer-like container: its channels are views of one Float32Array,
// and a parameter's mix swaps a Float64Array into a channel (web-audio-api's
// AudioBuffer `_channels`). The summary keeps the pair of widths through the
// join (summary/kind.js TYPED_FLOAT), so a loop over channels of either width
// runs a copy for each width they all may hold, and the vectorizer lifts the
// copies; a mix of widths runs the loop as written.
const channels = `const BLOCK = 64
class Buf {
  #n
  #data
  #channels
  constructor(nch, len) {
    this.#n = nch
    this.#data = new Float32Array(len * nch)
    const channels = this.#channels = new Array(nch)
    for (let c = 0; c < nch; c++) channels[c] = this.#data.subarray(c * len, (c + 1) * len)
  }
  get _channels() { return this.#channels }
  getChannelData(c) {
    if (c < 0 || c >= this.#n) throw new Error('channel')
    return this.#channels[c]
  }
}
const scale = (inBuf, outBuf, k) => {
  const inp = inBuf.getChannelData(0), out = outBuf.getChannelData(0)
  for (let i = 0; i < BLOCK; i++) out[i] = inp[i] * k
}
const mix = (inBuf, outBuf) => {
  const inp = inBuf.getChannelData(0), out = outBuf.getChannelData(0)
  for (let i = 0; i < BLOCK; i++) out[i] += inp[i]
}
export let f = (n) => {
  const a = new Buf(1, BLOCK), b = new Buf(1, BLOCK), w = new Buf(1, BLOCK), v = new Buf(1, BLOCK)
  w._channels[0] = new Float64Array(BLOCK)
  v._channels[0] = new Float64Array(BLOCK)
  for (let i = 0; i < BLOCK; i++) { a.getChannelData(0)[i] = i / 7 + n; v.getChannelData(0)[i] = 1 / (i + 3) }
  // the graph's edges, as a renderer walks them: each pair of either width
  const bufs = [a, b, w, v], edges = [0, 1, 1, 2, 3, 2, 0, 1, 3, 2]
  let h = 0
  for (let r = 0; r < 3; r++) {
    for (let e = 0; e < edges.length; e += 2) {
      const from = bufs[edges[e]], to = bufs[edges[e + 1]]
      if (e % 4 === 0) scale(from, to, 0.5 + r)
      else mix(from, to)
    }
    h += b.getChannelData(0)[r + 5] + w.getChannelData(0)[r * 3] * 1e-3
  }
  return h
}`

test('kind split: channels of either float width run a copy for each width they share', () => {
  agrees(channels, [['f', 0], ['f', 2], ['f', -1]])
  if (belowOpt(2)) return
  const text = wat(channels, { optimize: 2 })
  ok(/f32x4\./.test(text), 'the Float32 copies are lifted')
  ok(/f64x2\./.test(text), 'the Float64 copies are lifted')
})

// A parameter's input mix (web-audio-api's AudioInput): its buffer is made
// lazily and a closure swaps a Float64Array into its channel, so the summary
// meets the channels as Float32Array views a round before it meets the
// Float64Array. The copy under `instanceof Float64Array` must read Float64
// elements still: a test that kept the Float32Array kind of the early round
// joined it with the later Float64Array to an element kind no test proves,
// and the copy ran the generic width dispatch.
const paramMix = `const BLOCK = 64
class Buf {
  #n
  #data
  #channels
  constructor(nch, len) {
    this.#n = nch
    this.#data = new Float32Array(len * nch)
    const channels = this.#channels = new Array(nch)
    for (let c = 0; c < nch; c++) channels[c] = this.#data.subarray(c * len, (c + 1) * len)
  }
  get _channels() { return this.#channels }
  getChannelData(c) {
    if (c < 0 || c >= this.#n) throw new Error('channel')
    return this.#channels[c]
  }
}
const mix = (inBuf, outBuf) => {
  const inp = inBuf.getChannelData(0), out = outBuf.getChannelData(0)
  for (let i = 0; i < BLOCK; i++) out[i] += inp[i]
}
class Input {
  constructor(wide) { this.wide = wide; this.widen = b => { b._channels[0] = new Float64Array(BLOCK) } }
  tick(src) {
    if (!this.buf) { this.buf = new Buf(1, BLOCK); if (this.wide) this.widen(this.buf) }
    mix(src, this.buf)
    return this.buf
  }
}
export let f = (n) => {
  const src = new Buf(1, BLOCK), p = new Input(true), q = new Input(false), r = new Input(true)
  src.getChannelData(0).fill(n + 0.25)
  let h = 0
  for (let k = 0; k < 3; k++) {
    const w = p.tick(src)
    h += w.getChannelData(0)[k] + q.tick(src).getChannelData(0)[k + 1]
    mix(w, r.tick(q.tick(src)))
    h += r.buf.getChannelData(0)[k + 2]
  }
  return h
}`
// innermost loops storing elements without the generic typed helpers or a width dispatch
const directStores = (text) => loopsOf(text).filter(l => !/\(loop[\s\S]*\(loop/.test(l.slice(5)) && /f(32|64)\.store/.test(l) &&
  !/call \$__(typed|dyn)|__utw/.test(l) && !(/f32\.store/.test(l) && /f64\.store/.test(l)))

test('kind split: a Float64Array test over channels first met as Float32Array views reads them as Float64Array', () => {
  agrees(paramMix, [['f', 0], ['f', 1.5], ['f', -2]])
  if (belowOpt(2)) return
  const loops = directStores(wat(paramMix, { optimize: 2 }))
  ok(loops.some(l => /f64\.store/.test(l) && !/f32\.load/.test(l)), 'a copy stores and reads Float64 elements directly')
})
