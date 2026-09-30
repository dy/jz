// The shapes behind the audiojs results, each reduced to the smallest kernel that shows it.
// Three tables: programs whose value differs from JavaScript, programs that do not compile,
// and loops that run slower than under V8, each beside the control that compiles tight.
//
//   node bench/_audiojs/shapes.mjs            all three
//   node bench/_audiojs/shapes.mjs wrong      wrong | reject | slow | math

import { readFileSync } from 'node:fs'
import { jz, compile, measure, table, commit } from './lib.mjs'

const N = 65536
const first = e => String(e?.message ?? e).split('\n')[0].slice(0, 110)
const show = v => { const s = JSON.stringify(ArrayBuffer.isView(v) ? [...v] : v); return s.length > 60 ? s.slice(0, 57) + '…' : s }
let uid = 0
const asJs = src => import('data:text/javascript,' + encodeURIComponent(src + '\n//' + uid++))

// ── 1. Wrong: the compiled program returns another value than JavaScript, or traps ──────
// f(host) is called with a Uint8Array 0…127 where the case takes an argument.
const WRONG = {
  'W1 view of a host-passed array, joined with a fresh array in one binding: byteOffset': `
    export let f = (b) => { let src = b.subarray(44); if (b.length < 0) src = new Uint8Array(8); return [src.byteOffset, src.length, src[0]] }`,
  'W1 the same view handed to a constructor (decode-wav samples())': `
    let view = (raw, n) => { let src = raw; if (n < 0) src = new Uint8Array(n * 2); return new Uint16Array(src.buffer, src.byteOffset, n) }
    export let f = (b) => { let s = view(b.subarray(44), 4); return [s.length, s.byteOffset, s[0], s[1]] }`,
  'W2 optional output: out = output || internal': `
    let sp = new Float64Array(4)
    let g = (output) => { let out = output || sp; for (let i = 0; i < 4; i++) out[i] = i * 2; return out }
    export let f = () => { let o = new Float64Array(4); g(o); return o }`,
  'W2 optional output of another element kind': `
    let sp = new Float64Array(4)
    let g = (output) => { let out = output || sp; for (let i = 0; i < 4; i++) out[i] = i * 2; return out }
    export let f = () => { let o = new Float32Array(4); g(o); return o }`,
  'W3 length of a typed array chosen by a conditional': `
    let L = new Float32Array(4), R = new Float32Array(4), p = { channel: 'right' }
    let g = (left, right, params) => { let target = params.channel === 'left' ? left : right; return target.length }
    export let f = () => [g(L, R, p)]`,
  'W4 conditional whose test assigns what its arms read, added to a variable': `
    let D = 4, val = new Float64Array(D), head = new Int32Array(1), size = new Int32Array(1)
    val[0] = 24; val[1] = 91; size[0] = 2
    let g = (v) => { let r = 0; for (let k = 0; k < 1; k++) { let o = k * D, h = head[k], n = size[k], t
      while (n && val[o + ((t = h + n - 1) >= D ? t - D : t)] >= v) n--
      t = h + n >= D ? h + n - D : h + n
      val[o + t] = v; n++; size[k] = n; r = n * 10 + t } return r }
    export let f = () => [g(61), val[0], val[1], val[2]]`,
  'W5 array kept in a property added after creation, then grown': `
    let st = {}
    let step = (i) => { if (!st.history) st.history = []; let hist = st.history; let a = new Float64Array(2); a[0] = i + 1; hist.push(a); return hist[0][0] + hist.length * 100 }
    export let f = () => [step(0), step(1), step(2), step(3), st.history[3][0]]`,
  'W6 sum of squares (JS adds left to right)': `
    let X = new Float32Array(${N}); for (let i = 0; i < ${N}; i++) X[i] = Math.fround(((i * 2654435761 >>> 0) / 4294967296 - 0.5) * 1.4)
    export let f = () => { let q = 0; for (let i = 0; i < ${N}; i++) q += X[i] * X[i]; return [q] }`,
  'W7 sine of pi, and the sign of the sine of 3 pi (a square wave made with Math.sign)': `
    export let f = () => [Math.sin(Math.PI), Math.sign(Math.sin(3 * Math.PI))]`,
  'W8 typed array binding reassigned to a longer array, length read in a callee': `
    let len = (x) => x.length
    export let f = () => { let buf = new Float64Array(0); buf = new Float64Array(8); return [len(buf)] }`,
  'W8 module scratch array grown on demand, loop in a callee bounded by its length': `
    let buf = new Float64Array(0)
    let sum = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s }
    let frame = (n) => { if (buf.length !== n) buf = new Float64Array(n); buf.fill(1); return sum(buf) }
    export let f = () => [frame(8), frame(16)]`,
  'W9 parameter reassigned to a typed array on one path, tested with instanceof on all': `
    function isF32(data, flag) { if (flag) data = new Float32Array(4); return data instanceof Float32Array ? 1 : 0 }
    export let f = () => [isF32({ factor: 2 }, 0), isF32(new Float64Array(2), 0), isF32([1, 2], 0), isF32({ factor: 2 }, 1)]`,
  'W9 the audiojs entry: options in, a stream writer out (after a Float64Array arm)': `
    let batch = (d) => new Float32Array(d.length * 2)
    let writer = (o) => (chunk) => chunk
    function go(data) {
      if (data instanceof Float64Array) data = Float32Array.from(data)
      if (!(data instanceof Float32Array)) return writer(data)
      return batch(data)
    }
    export let f = () => [typeof go({ factor: 2 })]`,
  'W10 entry that returns a channel array, a stream writer or a Float32Array (repro/entry-return.js)': readFileSync(new URL('./repro/entry-return.js', import.meta.url), 'utf8'),
  'W10 record from two return sites, its field a typed array at one and undefined at the other': `
    let kind = (o) => o instanceof Float32Array ? 'Float32Array' : typeof o
    function core(data) {
      if (data.length < 100) return { out: new Float32Array(data.length), contour: null }
      let out
      return { out, contour: 0 }
    }
    let batch = (data) => core(data).out
    export let f = () => [kind(batch(new Float32Array(64))), kind(batch(new Float32Array(200)))]`,
}

async function wrong() {
  const host = Uint8Array.from({ length: 128 }, (_, i) => i), rows = []
  for (const [name, src] of Object.entries(WRONG)) {
    const want = show((await asJs(src)).f(host))
    let got
    try { got = show(jz(src).exports.f(host)) } catch (e) { got = 'throws: ' + first(e) }
    rows.push([name, want, got, want === got ? 'same' : 'differs'])
  }
  console.log('\n## value differs from JavaScript\n')
  table(['shape', 'JavaScript', 'jz', ''], rows)
}

// ── 2. Rejected: valid JavaScript that does not compile ─────────────────────────────────
const REJECT = {
  'L1 typed-array constructor as a value': `
    let view = (raw, T, n) => new T(raw.buffer, raw.byteOffset, n)
    export let f = (b) => view(b, b.length > 4 ? Uint16Array : Int32Array, 2)[0]`,
  'L2 import() of a literal specifier inside a function': { src: `
    export let f = async (n) => n > 0 ? (await import('./dep.js')).twice(n) : 0`, modules: { './dep.js': 'export let twice = n => n * 2' } },
  'L3 binding that is Boolean or Number: a && b && n (repro/bool-or-number.js)': readFileSync(new URL('./repro/bool-or-number.js', import.meta.url), 'utf8'),
  'L4 property named with a non-ASCII letter: unit.µs': `
    let unit = {}
    unit.µs = 1e-3
    export let f = () => unit.µs`,
  'L5 rest of a destructured options parameter: ({ duration = 4, ...opts } = {})': `
    let fm = (freq, { ratio = 1, index = 1, duration = 1 } = {}) => freq * ratio + index + duration
    let bell = (freq = 440, { duration = 4, ...opts } = {}) => fm(freq, { ratio: 1.4, index: 10, duration, ...opts })
    export let f = (o) => bell(220, o)`,
}

function reject() {
  const rows = []
  for (const [name, c] of Object.entries(REJECT)) {
    const { src, ...opts } = typeof c === 'string' ? { src: c } : c
    try { compile(src, opts); rows.push([name, 'compiles']) } catch (e) { rows.push([name, first(e)]) }
  }
  console.log('\n## valid JavaScript that does not compile\n')
  table(['shape', 'jz'], rows)
}

// ── 3. Slow: the loop runs, agrees with JavaScript, and loses to V8 ─────────────────────
// Convention: run() is timed. The module owns X, Y (Float32Array N) behind bufX/bufY and the
// harness fills them, unless the kernel fills its own input (filled) or opens first (open);
// host: n passes n typed arrays allocated in wasm memory; reset drops what a call allocated.
const own = `
const N = ${N}
let X = new Float32Array(N), Y = new Float32Array(N), O = new Float32Array(N)
export let bufX = () => X
export let bufY = () => Y
`
const sumsq = `let ms = (chs) => { let q = 0; for (let c = 0; c < chs.length; c++) { let x = chs[c]; for (let i = 0; i < x.length; i++) q += x[i] * x[i] } return q }`
const i16 = `let i16 = (ch, nch, len, buf) => {
      let out = new Int16Array(buf.buffer, 0, len * nch)
      for (let c = 0; c < nch; c++) for (let x = ch[c], i = 0, o = c; i < len; i++, o += nch) { let s = x[i]; out[o] = Math.floor((s < -1 ? -1 : s > 1 ? 1 : s) * 0x7FFF + 0.5) }
    }
    let B = new Uint8Array(N * 4)`
const encoder = (kind) => `
    function i24(ch, nch, len, buf) {
      for (let c = 0; c < nch; c++) for (let x = ch[c], i = 0, o = c * 3; i < len; i++, o += nch * 3) {
        let s = x[i], v = Math.floor((s < -1 ? -1 : s > 1 ? 1 : s) * 0x7FFFFF + 0.5)
        buf[o] = v & 0xFF; buf[o + 1] = (v >> 8) & 0xFF; buf[o + 2] = (v >> 16) & 0xFF
      }
    }
    function i16(ch, nch, len, buf) { let out = new Int16Array(buf.buffer, 0, len * nch); for (let c = 0; c < nch; c++) for (let x = ch[c], i = 0, o = c; i < len; i++, o += nch) { let s = x[i]; out[o] = Math.floor((s < -1 ? -1 : s > 1 ? 1 : s) * 0x7FFF + 0.5) } }
    ${kind}function wav(opts) {
      let { bitDepth = 16 } = opts, bps = bitDepth >> 3, nch = 0
      return { encode }
      function encode(ch) { if (!nch) nch = ch.length; let len = ch[0].length, buf = new Uint8Array(len * nch * bps); (bitDepth === 24 ? i24 : i16)(ch, nch, len, buf); return buf }
    }
    let enc = null
    export let open = ${kind}() => { enc = ${kind ? 'await ' : ''}wav({ bitDepth: 24 }); return 1 }
    export let run = (l, r) => enc.encode([l, r])[9]`
const SLOW = {
  'control: module-owned array, loop written against it': { src: own + `export let run = () => { let q = 0; for (let i = 0; i < N; i++) q += X[i] * X[i]; return q }` },
  'S1 typed array passed by the host': { src: own + `export let run = (x) => { let q = 0; for (let i = 0; i < x.length; i++) q += x[i] * x[i]; return q }`, host: 1 },
  'S2 channels in an array: ms([X, Y])': { src: own + sumsq + `\nexport let run = () => ms([X, Y])` },
  'S2 the same kernel with a second caller passing host arrays': { src: own + sumsq + `\nexport let run = () => ms([X, Y])\nexport let other = (l, r) => ms([l, r])` },
  'S3 recursion seeded from state on the parameter object, made on first use': { src: own + `
    let p = { fs: 44100 }
    let proc = (x, params) => { let s = params.state ??= new Float64Array(2), z = s[0], a = 1 / params.fs; for (let i = 0; i < x.length; i++) z = z * 0.5 + x[i] * a; s[0] = z; return z }
    export let run = () => proc(X, p)` },
  'S3 the same with the state array declared in the object literal': { src: own + `
    let p = { fs: 44100, state: new Float64Array(2) }
    let proc = (x, params) => { let s = params.state, z = s[0], a = 1 / params.fs; for (let i = 0; i < x.length; i++) z = z * 0.5 + x[i] * a; s[0] = z; return z }
    export let run = () => proc(X, p)` },
  'S3 control: the state in a module-level array, the scalar still read from the object': { src: own + `
    let p = { fs: 44100 }, S = new Float64Array(2)
    let proc = (x, params) => { let z = S[0], a = 1 / params.fs; for (let i = 0; i < x.length; i++) z = z * 0.5 + x[i] * a; S[0] = z; return z }
    export let run = () => proc(X, p)` },
  'S4 scratch buffer memoized in an object by size': { src: own + `
    let scratch = {}
    let win = (x) => { let n = x.length, buf = scratch[n] ??= new Float32Array(n); for (let i = 0; i < n; i++) buf[i] = x[i] * 0.5; return buf }
    export let run = () => win(X)[7]` },
  'S4 control: memoized in a Map': { src: own + `
    let cache = new Map()
    let init = (n) => { let e = { buf: new Float32Array(n) }; cache.set(n, e); return e }
    let win = (x) => { let n = x.length, { buf } = cache.get(n) || init(n); for (let i = 0; i < n; i++) buf[i] = x[i] * 0.5; return buf }
    export let run = () => win(X)[7]` },
  'S5 interleave and quantize to int16, module-owned channels': { src: own + i16 + `\nexport let run = () => { i16([X, Y], 2, N, B); return B[9] }` },
  'S5 the same with channels passed by the host': { src: own + i16 + `\nexport let run = (l, r) => { i16([l, r], 2, N, B); return B[9] }`, host: 2 },
  'S5 control: 16-bit table decode and de-interleave (decode-wav loop), input made in the module': { src: `
    const N = ${N}
    let RAW = new Uint8Array(N * 4), T = new Float32Array(65536), seed = 1
    for (let i = 0; i < N * 4; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; RAW[i] = seed >>> 24 }
    for (let u = 0; u < 65536; u++) { let v = u << 16 >> 16; T[u] = v < 0 ? v / 32768 : v / 32767 }
    let d16 = (raw, nCh, frames) => {
      let ch = Array.from({ length: nCh }, () => new Float32Array(frames))
      let s = new Uint16Array(raw.buffer, raw.byteOffset, frames * nCh)
      for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c; i < frames; i++, k += nCh) x[i] = T[s[k]]
      return ch
    }
    export let run = () => d16(RAW, 2, N)[1][9]`, reset: true, filled: true },
  'S6 atom contract: gain through the generated entry (process closure in a module binding)': { src: `
    const N = ${N}
    let gainFn = (data, params = {}) => { let dB = params.dB ?? 0, g = Math.pow(10, dB / 20); for (let i = 0, l = data.length; i < l; i++) data[i] *= g; return data }
    const gain = (ctx) => { const p = {}; return (inputs, outputs, params) => { const inp = inputs[0], out = outputs[0]; if (!inp || !inp.length) return; p.dB = params.dB[0]; for (let c = 0; c < inp.length; c++) { out[c].set(inp[c]); gainFn(out[c], p) } } }
    const params = { dB: new Float32Array([-6]) }
    let inputs = [], outputs = [], proc = (inputs, outputs, params, frames) => {}
    const ctx = { sampleRate: 44100, params: { dB: new Float32Array([-6]) } }
    inputs[0] = [new Float32Array(N), new Float32Array(N)]; outputs[0] = [new Float32Array(N), new Float32Array(N)]
    proc = gain(ctx)
    export let bufX = () => inputs[0][0]
    export let bufY = () => inputs[0][1]
    export let run = () => { proc(inputs, outputs, params, N); return outputs[0][1][9] }` },
  'S6 control: the same gain written against module-owned arrays': { src: own + `
    let P = new Float32Array(N)
    export let run = () => { let g = Math.pow(10, -6 / 20); for (let i = 0; i < N; i++) { O[i] = X[i] * g; P[i] = Y[i] * g } return P[9] }` },
  'S7 copy: Y.set(X)': { src: own + `export let run = () => { Y.set(X); return Y[9] }` },
  'S7 copy through channel arrays, as the atom manifests do: out[c].set(inp[c])': { src: own + `let inp = [X], out = [Y]\nexport let run = () => { for (let c = 0; c < inp.length; c++) out[c].set(inp[c]); return Y[9] }` },
  'S7 move: X.copyWithin(0, 512, N)': { src: own + `export let run = () => { X.copyWithin(0, 512, N); return X[9] }` },
  'S7 clear: Y.fill(0, 100, N)': { src: own + `export let run = () => { Y.fill(0, 100, N); return Y[9] }` },
  'S7 copy by constructor: new Float32Array(X)': { src: own + `export let run = () => new Float32Array(X)[9]`, reset: true },
  'S7 control: X.slice(0, N)': { src: own + `export let run = () => X.slice(0, N)[9]`, reset: true },
  'S7 control: the copy as a loop': { src: own + `export let run = () => { for (let i = 0; i < N; i++) Y[i] = X[i]; return Y[9] }` },
  'S8 encoder made by an async factory (encode-wav), 24-bit': { src: `const N = ${N}\n` + encoder('async '), host: 2, open: true },
  'S8 control: the same encoder made by a plain factory': { src: `const N = ${N}\n` + encoder(''), host: 2, open: true },
}

async function slow() {
  const sig = Float32Array.from({ length: N }, (_, i) => Math.sin(i * 0.01) * 0.7 + ((i * 2654435761 >>> 0) / 4294967296 - 0.5) * 0.2)
  const rows = []
  for (const [name, k] of Object.entries(SLOW)) {
    const js = await asJs(k.src)
    let w
    try { w = jz(k.src) } catch (e) { rows.push([name, '', '', '', 'does not compile: ' + first(e)]); continue }
    const { exports: wz, memory } = w
    if (k.open) { await js.open(); await wz.open() }
    else if (!k.filled) { js.bufX().set(sig); js.bufY().set(sig); wz.bufX().set(sig); wz.bufY().set(sig) }
    let ja = [], wa = []
    if (k.host) {
      const boxes = Array.from({ length: k.host }, () => memory.allocTyped(Float32Array, N).box)
      for (const b of boxes) memory.read(b).set(sig)          // after every allocation: growth detaches earlier views
      ja = boxes.map(() => sig); wa = boxes
    }
    try {
      const a = js.run(...ja), b = wz.run(...wa)
      // a kernel that allocates per call is dropped per call where nothing else lives on the heap
      const t = measure({ js: () => js.run(...ja), jz: k.reset ? () => { wz.run(...wa); memory.reset() } : () => wz.run(...wa) }, { rounds: 60, warm: 10, inner: k.open ? 1 : 4 })
      rows.push([name, (t.js * 1000).toFixed(0), (t.jz * 1000).toFixed(0), (t.js / t.jz).toFixed(2) + '×', Object.is(a, b) ? 'same' : `js ${a}, jz ${b}`])
    } catch (e) { rows.push([name, '', '', '', 'fails at run: ' + first(e)]) }
  }
  console.log(`\n## loops slower than V8 (N = ${N}; speed above 1× means jz is faster)\n`)
  table(['shape', 'V8 µs', 'jz µs', 'jz speed', 'result'], rows)
}

// ── 4. Math kernels against V8's: share of bit-identical results, largest distance ──────
async function math() {
  const fns = ['sin', 'cos', 'tan', 'atan', 'atan2', 'asin', 'acos', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'pow', 'sinh', 'cosh', 'tanh', 'hypot', 'cbrt', 'sqrt']
  const range = { sin: [-50, 50], cos: [-50, 50], tan: [-1.5, 1.5], atan: [-50, 50], atan2: [-50, 50], asin: [-1, 1], acos: [-1, 1], exp: [-20, 20], expm1: [-2, 2], log: [1e-6, 1e4], log2: [1e-6, 1e4], log10: [1e-6, 1e4], log1p: [-0.9, 10], pow: [0, 100], sinh: [-5, 5], cosh: [-5, 5], tanh: [-5, 5], hypot: [-50, 50], cbrt: [-100, 100], sqrt: [0, 1e6] }
  const M = 20000, call = (f, x) => f === 'pow' ? `Math.pow(${x}, 1.7)` : f === 'atan2' || f === 'hypot' ? `Math.${f}(${x}, 0.37)` : `Math.${f}(${x})`
  const src = `let xs = new Float64Array(${M}), out = new Float64Array(${M})\nexport let input = () => xs\n` + fns.map(f => `export let ${f}_ = () => { for (let i = 0; i < ${M}; i++) out[i] = ${call(f, 'xs[i]')}; return out }`).join('\n')
  const { exports: wz } = jz(src), js = await asJs(src)
  const f64 = new Float64Array(1), i64 = new BigInt64Array(f64.buffer)
  const bits = x => { f64[0] = x; return i64[0] }
  let seed = 12345
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
  const rows = []
  for (const f of fns) {
    const [lo, hi] = range[f], xs = Float64Array.from({ length: M }, () => lo + (hi - lo) * rnd())
    js.input().set(xs); wz.input().set(xs)
    const a = js[f + '_'](), b = wz[f + '_']()
    let same = 0, worst = 0, rel = 0
    for (let i = 0; i < M; i++) {
      if (Object.is(a[i], b[i])) { same++; continue }
      const d = bits(a[i]) - bits(b[i]), u = Number(d < 0n ? -d : d)
      if (u > worst) { worst = u; rel = Math.abs((a[i] - b[i]) / a[i]) }
    }
    rows.push([f, (same / M * 100).toFixed(1) + '%', worst, worst ? rel.toExponential(1) : '0'])
  }
  console.log(`\n## Math functions against V8 (${M} arguments each)\n`)
  table(['function', 'bit-identical', 'largest distance, ulp', 'relative error there'], rows)
}

const c = await commit()
console.log(`jz ${c.jz}, node ${process.version}`)
const want = process.argv.slice(2), on = k => !want.length || want.includes(k)
if (on('wrong')) await wrong()
if (on('reject')) reject()
if (on('slow')) await slow()
if (on('math')) await math()
process.exit(0)
