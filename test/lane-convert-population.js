// A population of loops that read integer elements into lanes, each answering what Node
// answers at every level: every source element type, signed and unsigned, by every
// destination element type, by every lowering that extends or converts an element (a map,
// a copy, a stencil, a reduction, a tone map, a column convolution). Each source holds
// values past 2^31, 2^15 and 2^7 and under them, so an unsigned element read as signed,
// or a signed one read as unsigned, shows in every lowering that takes it.
//
// Guards the class "a lane's conversion is signed or unsigned as the scalar's conversion is":
// an element's load says only how it widens to a word (`i32.load8_u` zero-extends), and the
// conversion of that word to a float says how its top bit reads (`f64.convert_i32_u`). The
// f32 map took the sign from the load (in v1.0.3: a Uint32Array copied to a
// Float32Array read 2^32 - 1 as -1 at levels 3 and speed, and `a[i] >>> 0` read a signed
// element signed, an Int8Array's or an Int16Array's at levels 2, 3 and speed, an Int32Array's
// at 3 and speed), which `a copy` of a Uint32Array and `an unsigned read` of a Uint32Array or
// a signed source into a Float32Array fail with its fix taken out.
import test from 'tst'
import { is } from 'tst/assert.js'
import { jz, oracle } from './util.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']
const N = 37
// Each element type keeps a word's low bits (a Uint8ClampedArray its clamp), so every source
// holds values on both sides of its own top bit.
const V = [0, 1, 0x7f, 0x80, 0xff, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff, 0x12345678, 0x89abcdef, 0xfedcba98, 200]
const SOURCES = ['Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array']
const DESTINATIONS = ['Float32Array', 'Float64Array', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array']
// The answer: each element by its place, a sum of integers and halves under 2^53 that every
// order adds alike, which any element's value moves (a string of them costs each compile 2.5
// times as much).
const weigh = (arr, len) => `let s = 0; for (let k = 0; k < ${len}; k++) s += ${arr}[k] * (k + 1); return s`
const every = weigh('d', 'n')
// [name, the loop and its answer]: into each destination
const MAPS = [
  ['a copy', `for (let i = 0; i < n; i++) d[i] = a[i]`],
  ['a scaled copy', `for (let i = 0; i < n; i++) d[i] = a[i] * 2 + 1`],
  ['a halved copy', `for (let i = 0; i < n; i++) d[i] = a[i] * 0.5`],
  ['a sum of two', `for (let i = 0; i < n; i++) d[i] = a[i] + b[i]`],
  ['a difference of two', `for (let i = 0; i < n; i++) d[i] = a[i] - b[i]`],
  ['an unsigned read', `for (let i = 0; i < n; i++) d[i] = a[i] >>> 0`],
  ['a stencil', `for (let i = 1; i < n - 1; i++) d[i] = a[i - 1] + a[i] + a[i + 1]`],
].map(([name, loop]) => [name, `${loop}\n  ${every}`])
// into a Number or a word
const REDUCTIONS = [
  ['a sum', `let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s`],
  ['a weighted sum', `let s = 0; for (let i = 0; i < n; i++) s += a[i] * c[i]; return s`],
  ['an unsigned sum', `let s = 0; for (let i = 0; i < n; i++) s += a[i] >>> 0; return s`],
  ['a word sum', `let s = 0; for (let i = 0; i < n; i++) s = (s + a[i]) | 0; return s`],
  ['a maximum', `let m = -Infinity; for (let i = 0; i < n; i++) m = Math.max(m, a[i]); return m`],
  ['a minimum', `let m = Infinity; for (let i = 0; i < n; i++) m = Math.min(m, a[i]); return m`],
  ['a count past 2^7', `let s = 0; for (let i = 0; i < n; i++) s += a[i] > 128 ? 1 : 0; return s`],
]
// into pixels (vectorize/tone-map.js: an element to an f64 island and back)
const TONES = [
  ['a tone map', `let i = 0
  while (i < n) {
    let e = a[i]
    if (e === 0) p[i] = 0xff000000
    else { let v = (Math.log(e + 1.0) * 44.0) / 255.0; if (v > 1.0) v = 1.0; let r = (235 * v) | 0; p[i] = (255 << 24) | (r << 16) | (r << 8) | r }
    i++
  }
  ${weigh('p', 'n')}`],
  ['a scaled tone map', `let i = 0
  while (i < n) { let e = a[i]; let v = e * 3 + 0.5; p[i] = (255 << 24) | ((v | 0) & 0xffffff); i++ }
  ${weigh('p', 'n')}`],
]
const program = (S, D, body) => `const V = [${V}]
export let main = (n) => {
  const a = new ${S}(n), b = new ${S}(n), c = new Float64Array(n), d = new ${D}(n), p = new Uint32Array(n)
  for (let i = 0; i < n; i++) { a[i] = V[i % 16]; b[i] = V[(i * 7 + 3) % 16]; c[i] = i % 5 - 2 }
  ${body}
}`
// an outer loop of output columns over unrolled taps (vectorize/outer-strip.js tryConvColumn)
const column = (S, D) => `const V = [${V}]
const W = 18, H = 6, K = 3, OW = W - K + 1, OH = H - K + 1
export let main = (n) => {
  const a = new ${S}(W * H), w = new Int8Array(K * K), d = new ${D}(OW * OH)
  for (let i = 0; i < W * H; i++) a[i] = V[(i * 5) % 16]
  for (let i = 0; i < K * K; i++) w[i] = (i * 37) % 7 - 3
  for (let oy = 0; oy < OH; oy++) for (let ox = 0; ox < OW; ox++) {
    let acc = 5
    for (let ky = 0; ky < K; ky++) for (let kx = 0; kx < K; kx++) acc += a[(oy + ky) * W + ox + kx] * w[ky * K + kx]
    const q = acc >> 3
    d[oy * OW + ox] = q < 0 ? 0 : q > 255 ? 255 : q
  }
  ${weigh('d', 'OW * OH')}
}`

// Every level of each program, its differences gathered: one assertion a test, naming each
// program and level that differs (an assertion stops its test at the first).
const article = (T) => T.startsWith('Int') ? 'an' : 'a'
const agree = (diffs, label, src) => {
  const want = String(oracle(src).main(N))
  for (const optimize of CONFIGS) {
    let got
    try { got = String(jz(src, { optimize }).exports.main(N)) } catch (e) { got = `throws: ${String(e.message).split('\n')[0]}` }
    if (got !== want) diffs.push(`${label}, at ${JSON.stringify(optimize)}: ${got}, where Node answers ${want}`)
  }
}

for (const S of SOURCES) {
  test(`lane convert population: ${S} by ${DESTINATIONS.length} destinations by ${MAPS.length} maps, ${CONFIGS.length} configurations`, () => {
    const diffs = []
    for (const D of DESTINATIONS) for (const [name, body] of MAPS) agree(diffs, `${name} of ${article(S)} ${S} into ${article(D)} ${D}`, program(S, D, body))
    is(diffs, [], `${S}: ${DESTINATIONS.length * MAPS.length} programs`)
  })
  test(`lane convert population: ${S} by ${REDUCTIONS.length} reductions, ${TONES.length} tone maps and a column convolution, ${CONFIGS.length} configurations`, () => {
    const diffs = []
    for (const [name, body] of [...REDUCTIONS, ...TONES]) agree(diffs, `${name} of ${article(S)} ${S}`, program(S, 'Float64Array', body))
    for (const D of ['Uint8Array', 'Float32Array']) agree(diffs, `a column convolution of ${article(S)} ${S} into ${article(D)} ${D}`, column(S, D))
    is(diffs, [], `${S}: ${REDUCTIONS.length + TONES.length + 2} programs`)
  })
}
