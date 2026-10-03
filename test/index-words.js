// Element indices and conversions the speed tier computes in integer registers:
// a loop over module-level dimensions (`while (y < H - 1)`, `a[y * W + x]`), a key
// with one product among its terms, ToInt32 tested against the 32-bit range, and
// a tone map that skips its costly arm where no pixel takes it. Each answers
// what the source answers, at every number the edges reach.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import parseWat from 'watr/parse'
import jz from '../index.js'
import { levels } from './_matrix.js'
import { funcWat, oracle, wat } from './util.js'

const EDGES = [0, -0, 0.5, -0.5, 1.9999, -1.9999, 2147483647, 2147483648, -2147483648, -2147483649,
  4294967295.5, 4294967296, 4294967301, -4294967301, 2 ** 51 - 0.5, 2 ** 51, -(2 ** 51) + 0.5, -(2 ** 51),
  2 ** 52 + 1, 2 ** 53, -(2 ** 53), 2 ** 63, 1e300, -1e300, Infinity, -Infinity, NaN]

test('index words: a stencil over module dimensions answers as JS and runs in lanes', () => {
  const src = `let W = 0, H = 0, R, I
    export let resize = (w, h) => { W = w; H = h; R = new Float64Array(w * h > 0 ? w * h : 0); I = new Float64Array(w * h > 0 ? w * h : 0)
      for (let k = 0; k < R.length; k++) I[k] = (k * 7) % 13 }
    export let step = () => {
      let y = 1
      while (y < H - 1) {
        let x = 1
        while (x < W - 1) { let c = y * W + x; R[c] = R[c] + I[c - W] + I[c + W] + I[c - 1] + I[c + 1] - 4 * I[c]; x++ }
        y++
      }
      let s = 0; for (let k = 0; k < R.length; k++) s += R[k] * (k % 5)
      return s
    }`
  for (const optimize of levels(0, 2, 'speed')) {
    const got = jz(src, { optimize }).exports, host = oracle(src)
    for (const [w, h] of [[8, 6], [17, 3], [3, 3], [1, 9], [9, 1], [0, 4], [6.5, 4], [5, 4.5]]) {
      got.resize(w, h); host.resize(w, h)
      is(got.step(), host.step(), `O${optimize} ${w}×${h}`)
    }
  }
  ok(/f64x2/.test(wat(src, { optimize: 'speed' })), 'the interior runs two cells a step')
})

test('index words: a key with one product reads and writes the element JS names', () => {
  const src = `let a = new Float64Array(64)
    for (let k = 0; k < 64; k++) a[k] = k + 0.5
    export let get = (y, w, x) => { y = y | 0; w = w | 0; x = x | 0; return a[y * w + x] }
    export let put = (y, w, x) => { y = y | 0; w = w | 0; x = x | 0; a[y * w - x] = 99; let s = 0; for (let k = 0; k < 64; k++) s += a[k]; a.fill(1); return s }`
  const cases = [[0, 0, 0], [3, 8, 5], [7, 8, 7], [8, 8, 0], [-1, 8, 9], [1, -8, 70], [65536, 65536, 0], [65536, 65536, 5],
    [2147483647, 2147483647, 1], [-2147483648, -2147483648, 0], [-2147483648, 2147483647, 63], [46341, 46341, -2147483648], [4294967, 1000, 0]]
  for (const optimize of levels(0, 2, 'speed')) {
    const got = jz(src, { optimize }).exports, host = oracle(src)
    for (const [y, w, x] of cases) {
      is(got.get(y, w, x), host.get(y, w, x), `O${optimize} get ${y}*${w}+${x}`)
      is(got.put(y, w, x), host.put(y, w, x), `O${optimize} put ${y}*${w}-${x}`)
    }
  }
})

test('index words: ToInt32 answers at every edge with its 32-bit test first', () => {
  const src = `export let t = (x) => x | 0
    export let m = (x) => (x * 1.5) | 0
    export let pack = (r, g, b) => (255 << 24) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0)`
  const guarded = wat(src, { optimize: 'speed' })
  ok(/f64\.abs[\s\S]*?2251799813685248[\s\S]*?6755399441055744/.test(guarded), 'the speed tier tests the magnitude, then adds')
  ok(!/f64\.abs/.test(wat(src, { optimize: 'size' })), 'the size tier keeps the single exact form')
  // (`|0` saturates past 2^63 by design, src/ir/numeric.js toI32: the edges below it)
  for (const optimize of levels(0, 2, 'speed', 'size')) {
    const got = jz(src, { optimize }).exports, host = oracle(src)
    for (const x of EDGES.filter(x => !(Math.abs(x * 1.5) >= 2 ** 63) || !Number.isFinite(x))) {
      is(got.t(x), host.t(x), `O${optimize} ${x} | 0`)
      is(got.m(x), host.m(x), `O${optimize} (${x} * 1.5) | 0`)
      is(got.pack(x, -x, x / 3), host.pack(x, -x, x / 3), `O${optimize} pack ${x}`)
    }
  }
})

// The speed tier takes an integer's word without a conversion: within ±2^51 its
// truncation plus 1.5·2^52 holds it in the low bits (wordTruncation: 'add').
// Each place a word is taken answers as JS past that range too: an element
// key's test, a bounded ToInt32, 64-bit arithmetic and a key past the word.
test('index words: words by the add answer at every edge', () => {
  const src = `let a = new Int32Array(8)
    for (let i = 0; i < 8; i++) a[i] = i * 10 + 1
    export let get = (k) => a[k]
    export let put = (k, v) => { a[k] = v; return a[k & 7] }
    export let clamp = (x) => { let v = x; if (v > 1) v = 1; if (v < 0) v = 0; return (v * 255) | 0 }
    export let near = (x) => { let s = 0; for (let i = 0; i < 4; i++) s = (s + (x + i) * 3) | 0; return s }
    export let spiral = (dx, dy) => {
      let ax = dx, ay = dy
      if (ax < 0) ax = -ax
      if (ay < 0) ay = -ay
      let k = ax > ay ? ax : ay
      if (k === 0) return 1
      let pos = dy === k ? 6 * k + dx + k - 1 : dx === k ? k - 1 - dy : 4 * k + dy + k - 1
      return (2 * k - 1) * (2 * k - 1) + 1 + pos
    }`
  ok(/6755399441055744/.test(wat(src, { optimize: 'speed' })), 'the speed tier adds')
  for (const optimize of levels(2, 'speed')) {
    const got = jz(src, { optimize }).exports, host = oracle(src)
    for (const x of EDGES) {
      is(got.get(x), host.get(x), `O${optimize} a[${x}]`)
      // (`k & 7` saturates past 2^63 by design, as `|0` does)
      if (Math.abs(x) < 2 ** 63 || !Number.isFinite(x)) is(got.put(x, 7), host.put(x, 7), `O${optimize} a[${x}] = 7`)
      is(got.clamp(x), host.clamp(x), `O${optimize} clamp ${x}`)
      if (Math.abs(x) < 2 ** 62 || !Number.isFinite(x)) is(got.near(x), host.near(x), `O${optimize} near ${x}`)
      for (const y of [0, -3, x | 0]) is(got.spiral(x | 0, y), host.spiral(x | 0, y), `O${optimize} spiral ${x | 0}, ${y}`)
    }
  }
})

// A module bound the loop also reads past its test (`f[k * n + c]` under
// `while (c < n)`, a lattice's collide step) keeps its int32 alias: the index
// is integer arithmetic, not a product of numbers.
test('index words: a module bound read in the body keys its elements in words', () => {
  const src = `let n = 0, f, solid
    export let init = (w, h) => { n = w * h; f = new Float64Array(9 * n); solid = new Uint8Array(n)
      for (let i = 0; i < 9 * n; i++) f[i] = (i % 13) * 0.5; solid[3] = 1 }
    export let step = () => {
      let c = 0, s = 0
      while (c < n) {
        if (solid[c] === 0) { let k = 0; while (k < 9) { s += f[k * n + c]; k++ } }
        c++
      }
      return s
    }`
  for (const optimize of levels(0, 2, 'speed')) {
    const got = jz(src, { optimize }).exports, host = oracle(src)
    for (const m of [got, host]) m.init(7, 5)
    is(got.step(), host.step(), `O${optimize} step`)
  }
  const loops = []
  const walk = n => { if (!Array.isArray(n)) return; if (n[0] === 'loop') loops.push(n); n.forEach(walk) }
  walk(parseWat(funcWat(wat(src, { optimize: 'speed' }), 'step')))
  const has = (n, op) => Array.isArray(n) && (n[0] === op || n.some(c => has(c, op)))
  const inner = loops.filter(l => !l.slice(1).some(c => has(c, 'loop')))
  ok(inner.some(l => has(l, 'f64.load') && !has(l, 'f64.mul')), 'a row of elements read by an integer key')
})

test('index words: a sum with one product under a saturating truncation keeps its element', () => {
  const src = `let a = new Float64Array(32), ky = new Int32Array(4), kx = new Int32Array(4)
    for (let k = 0; k < 32; k++) a[k] = k * 3 + 1
    export let gather = (y, x, dy, dx, w) => {
      y = y | 0; x = x | 0; w = w | 0; ky[0] = dy; kx[0] = dx
      let s = 0, k = 0
      while (k < 2) { let yy = y + ky[k], xx = x + kx[k]; s += a[yy * w + xx]; k++ }
      return s
    }`
  const cases = [[1, 2, 0, 0, 8], [3, 7, 1, -1, 8], [0, 0, -1, 0, 8], [2147483647, 0, 1, 0, 2147483647], [-2147483648, 5, -1, 0, 65536],
    [65536, 0, 0, 0, 65536], [1, 31, 0, 1, 0], [0, -2147483648, 0, -1, 1]]
  for (const optimize of levels(0, 2, 'speed')) {
    const got = jz(src, { optimize }).exports, host = oracle(src)
    for (const c of cases) is(got.gather(...c), host.gather(...c), `O${optimize} gather ${c}`)
  }
})

test('index words: a while bound of stable names converts like the loop it copies', () => {
  const src = `let N = 0
    export let setN = (n) => { N = n }
    export let span = (xs) => { let s = 0, i = 0; while (i < N - 1) { s += xs[i + 1] - xs[i]; i++ } return s }
    export let count = (n) => { let c = 0, i = 0; while (i <= 2 * n + 1) { c++; i++ } return c }`
  const xs = Float64Array.from({ length: 40 }, (_, k) => (k * 37) % 23)
  for (const optimize of levels(0, 2, 'speed')) {
    const got = jz(src, { optimize }).exports, host = oracle(src)
    // (a bound past the array reads undefined: NaN, as JS sums it)
    for (const n of [0, 1, 2, 2.5, 7, 40, 45.5, -3, NaN, -Infinity, -(2 ** 31) - 5, -0]) {
      got.setN(n); host.setN(n)
      is(got.span(xs), host.span(xs), `O${optimize} span N=${n}`)
      is(got.count(n), host.count(n), `O${optimize} count n=${n}`)
    }
  }
})

test('index words: a tone map skips its log where no pixel of a pair takes it', () => {
  const src = `let dens, px, n = 0
    export let resize = (w, h) => { n = w * h; dens = new Uint32Array(n); px = new Uint32Array(n) }
    export let fill = (every) => { for (let i = 0; i < n; i++) dens[i] = i % every === 0 ? 1 + (i & 63) : 0 }
    export let frame = (pr, ir) => {
      let i = 0
      while (i < n) {
        let d = dens[i]
        if (d === 0) px[i] = 0xff000000
        else { let v = (Math.log(d + 1.0) * 44.0) / 255.0; if (v > 1.0) v = 1.0; let r = (pr + (ir - pr) * v) | 0; px[i] = (255 << 24) | (r << 16) | (r << 8) | r }
        i++
      }
      let h = 0; for (let k = 0; k < n; k++) h = (h * 31 + px[k]) | 0
      return h
    }`
  const w = wat(src, { optimize: 'speed' })
  ok(/math\.log_v/.test(w), 'the map runs two pixels a step')
  const lanes = jz(src, { optimize: 'speed' }).exports, scalar = jz(src, { optimize: { level: 'speed', toneMap: false } }).exports
  for (const [width, height] of [[16, 8], [7, 3], [1, 1]]) for (const every of [1, 2, 3, 10, 1000]) {
    lanes.resize(width, height); scalar.resize(width, height); lanes.fill(every); scalar.fill(every)
    is(lanes.frame(0, 235), scalar.frame(0, 235), `${width}×${height} every ${every}`)
  }
})

test('index words: a tone map wraps each lane past 2^31 as ToInt32 does, and reads and writes a Float32Array', () => {
  // the lanes truncate within the 32-bit range and take the exact form past it
  const wrap = `let dens, px, n = 0
    export let resize = (w) => { n = w; dens = new Uint32Array(n); px = new Uint32Array(n); for (let i = 0; i < n; i++) dens[i] = i % 11 }
    export let frame = (k) => {
      let i = 0
      while (i < n) { let d = dens[i]; let v = d * k + 0.5; px[i] = (255 << 24) | ((v | 0) & 0xffffff); i++ }
      let h = 0; for (let j = 0; j < n; j++) h = (h * 31 + px[j]) | 0
      return h
    }`
  ok(/f64x2/.test(wat(wrap, { optimize: 'speed' })), 'the map runs two pixels a step')
  const got = jz(wrap, { optimize: 'speed' }).exports, host = oracle(wrap)
  for (const n of [64, 7, 1]) {
    got.resize(n); host.resize(n)
    for (const k of [1, 1e6, 3e9, -7e9, 1e12, NaN, Infinity]) is(got.frame(k), host.frame(k), `n=${n} k=${k}`)
  }
  // an exposure buffer fades in place and composites (swarm, lorenz)
  const ink = `let px, ink, n = 0
    export let resize = (w) => { n = w; px = new Uint32Array(n); ink = new Float32Array(n); for (let i = 0; i < n; i++) ink[i] = (i % 97) / 50 - 0.3 }
    export let frame = (pr, ir) => {
      let i = 0
      while (i < n) { let e = ink[i] * 0.996; ink[i] = e; let v = e < 1.0 ? e * 0.55 : 0.55; let r = (pr + (ir - pr) * v) | 0; px[i] = (255 << 24) | (r << 16) | r; i++ }
      let h = 0; for (let j = 0; j < n; j++) h = (h * 31 + px[j] + ((ink[j] * 1e6) | 0)) | 0
      return h
    }`
  ok(/f64x2\.promote_low_f32x4/.test(wat(ink, { optimize: 'speed' })), 'the exposure reads two floats a step')
  const lanes = jz(ink, { optimize: 'speed' }).exports, scalar = oracle(ink)
  for (const n of [33, 2, 1]) {
    lanes.resize(n); scalar.resize(n)
    for (const [pr, ir] of [[0, 235], [235, 0], [3e9, -3e9]]) for (let f = 0; f < 3; f++) is(lanes.frame(pr, ir), scalar.frame(pr, ir), `n=${n} ${pr}→${ir} frame ${f}`)
  }
})

test('index words: clamped neighbours of a row-major cell read the elements JS names', () => {
  // `hf[qx > 0 ? i - 1 : i]`: each arm a word key; `i = py * W + qx` a word the guard proved
  const src = `let W = 0, H = 0, hf, out
    export let resize = (w, h) => { W = w; H = h; let n = w * h > 0 ? Math.floor(w * h) : 0
      hf = new Float64Array(n); out = new Float64Array(n); for (let k = 0; k < n; k++) hf[k] = (k * 7) % 13 }
    export let frame = () => {
      let py = 0
      while (py < H) {
        let qx = 0
        while (qx < W) {
          let i = py * W + qx
          let gl = hf[qx > 0 ? i - 1 : i], gr = hf[qx < W - 1 ? i + 1 : i]
          let gu = hf[py > 0 ? i - W : i], gd = hf[py < H - 1 ? i + W : i]
          out[i] = (gr - gl) * 0.5 + (gd - gu) * 0.5 + hf[i]
          qx++
        }
        py++
      }
      let s = 0; for (let k = 0; k < out.length; k++) s += out[k] * (k % 7)
      return s
    }`
  for (const optimize of levels(0, 2, 'speed')) {
    const got = jz(src, { optimize }).exports, host = oracle(src)
    for (const [w, h] of [[9, 5], [1, 7], [7, 1], [2, 2], [0, 3], [4.5, 3], [3, 4.5], [17, 9]]) {
      got.resize(w, h); host.resize(w, h)
      is(got.frame(), host.frame(), `O${optimize} ${w}×${h}`)
    }
  }
})
