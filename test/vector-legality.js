// Vector lifts answer what the loop as written answers (src/optimize/vectorize/legality.js):
// programs each lift answered wrongly, at every level this leg owns. A lift checked against one
// legality, the same for every recognizer: the bytes two iterations of a strip touch, in the
// order the loop touches them; what it leaves in every local the loop writes; the iterations the
// loop runs. Beside it, what a private lift carries out: a store under a condition, an operation
// in a narrower lane, an address the lift keeps.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { compile, jz, oracle } from './util.js'

const agree = (name, src, args = []) => {
  const want = oracle(src).f(...args)
  for (const optimize of levels(2, 3)) is(jz(src, { optimize }).exports.f(...args), want, `${name} at ${optimize}`)
}

// The nine programs of phase 6's census (.work/maps/vectorize-leads.md), W1 to W9.
test('vector legality: nine', () => {
  agree("W1 reduce lane local read after", `const a = new Float64Array(64)
export let f = () => { for (let i = 0; i < 64; i++) a[i] = ((i * 7) % 13) - 5.75
  let s = 0, d = 0
  for (let i = 0; i < 64; i++) { d = a[i] * 2; s = s + d * d }
  return s + d }`)
  agree("W2 ramp two steps", `const a = new Uint8Array(64)
export let f = () => { for (let i = 0; i < 64; i++) { a[i] = i & 127; i++ }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + a[i]) % 1000003; return h }`)
  agree("W6 divergent escape carried scalar", `const out = new Float64Array(64)
export let f = () => { let k = 0.5
  for (let x = 0; x < 64; x++) { let zx = 0, it = 0
    while (it < 50) { zx = zx * zx + k; if (zx > 4) break; it++ }
    out[x] = it; k = k + 0.001 * it }
  return k }`)
  agree("W7 mirror store", `const a = new Float64Array(64)
export let f = () => { for (let i = 0; i < 64; i++) a[i] = ((i * 7) % 13) - 5.75
  for (let i = 1; i < 63; i++) a[63 - i] = a[i]
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + a[i]) % 1000003; return h }`)
  agree("W8 aos stride 2", `const a = new Float64Array(64)
export let f = () => { for (let i = 0; i < 64; i++) a[i] = ((i * 7) % 13) - 5.75
  for (let i = 0; i < 31; i++) a[2 * i + 2] = a[2 * i] + 1
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + a[i]) % 1000003; return h }`)
  agree("W9 aos stride 4", `const a = new Float64Array(64)
export let f = () => { for (let i = 0; i < 64; i++) a[i] = ((i * 7) % 13) - 5.75
  for (let i = 0; i < 15; i++) a[4 * i + 4] = a[4 * i] + 1
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + a[i]) % 1000003; return h }`)
})

// Two sites of one base whose iterations meet: a mirror whose bound passes the middle
// (rfft's cepstrum, an odd length) opens its strip past a test of the bytes the two stores touch.
test('vector legality: memory', () => {
  agree("M-cepstrum mirror past the middle", `const spec = new Float64Array(64), inp = new Float64Array(64)
export let f = (N, half) => { for (let k = 0; k < 64; k++) { spec[k] = k * 0.75 + 1; inp[k] = 0 }
  let k = 1
  while (k < half) { let lm = Math.log(spec[k] + 1e-6); inp[k] = lm; inp[N - k] = lm; k++ }
  let h = 0; for (let j = 0; j < 64; j++) h = h * 1.5 + inp[j] * (j + 1); return h }`, [63,33])
  agree("OS-4b epilogue stores the array the inner loop reads", `export let f = () => { const a = new Float64Array(64), b = new Float64Array(64), out = new Float64Array(64), c = new Float64Array(64), n = 16, w = 32
  for (let i = 0; i < 64; i++) { a[i] = ((i * 7) % 13) - 5.75; b[i] = i * 0.5 }
  for (let x = 0; x < w; x++) { let s = 0; for (let i = 0; i < n; i++) { s += a[i]; s += b[i] } a[x] = s * 0.001 }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + out[i] + c[i] * 7 + a[i]) % 1000003; return h + 0 }`)
})

// A local an outer pixel loop's inner loop sums, read after the outer loop.
test('vector legality: locals', () => {
  agree("OUT-1b the sum read after the loop", `export let f = () => { const a = new Float64Array(64), b = new Float64Array(64), out = new Float64Array(64), c = new Float64Array(64), n = 16, w = 32
  for (let i = 0; i < 64; i++) { a[i] = ((i * 7) % 13) - 5.75; b[i] = i * 0.5 }
  let s = 0; for (let x = 0; x < w; x++) { s = 0; for (let i = 0; i < n; i++) { s += a[i]; s += b[i] } out[x] = 1 }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + out[i] + c[i] * 7 + a[i]) % 1000003; return h + s }`)
})

// A loop that leaves on `x >= 0 && x < n` (one unsigned compare) entered below zero runs
// not once; a strip, counting signed, opens only where both ends are non-negative (memcpy, the
// map, the ramp, the tone map, the prefilter, the pixel pair).
test('vector legality: unsigned', () => {
  agree("U-copy memcpy", `const a = new Int32Array(256), b = new Int32Array(256)
export let f = () => { for (let k = 0; k < 256; k++) { a[k] = k + 1; b[k] = 0 }
  for (let x = -3; x >= 0 && x < a.length; x++) b[x] = a[x]
  let h = 0; for (let k = 0; k < 256; k++) h = (h * 31 + b[k]) % 1000003; return h }`)
  agree("U-map tryVectorize", `const a = new Int32Array(256), b = new Int32Array(256)
export let f = () => { for (let k = 0; k < 256; k++) { a[k] = k + 1; b[k] = 0 }
  for (let x = -3; x >= 0 && x < a.length; x++) b[x] = a[x] * 2
  let h = 0; for (let k = 0; k < 256; k++) h = (h * 31 + b[k]) % 1000003; return h }`)
  agree("U-ramp", `const o = new Uint8Array(256)
export let f = () => { for (let x = -3; x >= 0 && x < o.length; x++) o[x] = x & 127
  let h = 0; for (let k = 0; k < 256; k++) h = (h * 31 + o[k]) % 1000003; return h }`)
  agree("L-T4-u tone map entered at -2", `const d = new Int32Array(64), px = new Int32Array(64)
export let f = () => { for (let k = 0; k < 64; k++) { d[k] = (k * 37 + 11) & 127; px[k] = 0 }
  for (let i = -2; i >= 0 && i < d.length; i++) { const v = d[i]; px[i] = (Math.log(v * 1.5 + 1) * 20) | 0 }
  let h = 0; for (let k = 0; k < 64; k++) h = (h * 31 + px[k]) % 1000003; return h }`)
  agree("L1-u8", `const bmp = new Uint8Array(256)
export let f = (n) => { for (let i = 0; i < 256; i++) bmp[i] = (i % 17 === 0) ? 1 : 0
  let c = 0
  for (let x = -3; x >= 0 && x < bmp.length; x++) { if (bmp[x] === 1) { for (let k = 0; k < (x & 7); k++) c += k + x } }
  return c }`, [250])
  agree("L4-u1", `const out = new Float64Array(64)
export let f = () => { for (let qx = -1; qx >= 0 && qx < out.length; qx++) { let x = 0.3 * qx, k = 0
    while (x < 4) { x = x * x + 0.1; k++; if (k > 50) break }
    out[qx] = k }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + out[i]) % 1000003; return h }`)
})

// A counter stepped twice an iteration, in the body as in the loop's own step, or through a
// copy a conditional rewrites (`let y = x + 1; if (c) y = x + 2; x = y`): every step counted.
test('vector legality: steps', () => {
  agree("T-pixel stepped twice", `const out = new Float64Array(64)
export let f = () => { for (let x = 0; x < 64; x++) { let zx = 0, it = 0
    while (it < 50) { zx = zx * zx + x * 0.01; if (zx > 4) break; it++ }
    out[x] = it; x++ }
  let h = 0; for (let k = 0; k < 64; k++) h = (h * 31 + out[k]) % 1000003; return h }`)
  agree("L-R3-a bump then store at i and value of i", `const o = new Uint8Array(64), p = new Uint8Array(64), s = new Uint8Array(64)
export let f = () => {
  for (let i = 0; i < 63; i++) { i += 1; o[i] = (i * 5) & 255 }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + o[i] + p[i]) % 1000003; return h }`)
  agree("L-R3-b bump then store, constant value", `const o = new Uint8Array(64), p = new Uint8Array(64), s = new Uint8Array(64)
export let f = () => {
  for (let i = 0; i < 63; i++) { i += 1; o[i] = 7 }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + o[i] + p[i]) % 1000003; return h }`)
  agree("L-R3-d bump then temp then store", `const o = new Uint8Array(64), p = new Uint8Array(64), s = new Uint8Array(64)
export let f = () => {
  for (let i = 0; i < 63; i++) { i++; const t = i * 3; o[i] = t & 255 }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + o[i] + p[i]) % 1000003; return h }`)
  agree("L7-m", `const a = new Float64Array(80), b = new Float64Array(80)
export let f = () => { for (let k = 0; k < 80; k++) { a[k] = (k % 3 === 0 ? -1 : k * 0.5 + 1); b[k] = 0 }
  let x = 0
  while (x < 64) { const v = a[x]; b[x] = v * 2; let y = x + 1; if (v < 0) y = x + 2; x = y }
  let h = 0; for (let k = 0; k < 80; k++) h = h * 1.5 + b[k] + k * 0.01 * b[k]; return h + x }`)
})

// What the legality keeps: loops whose iterations a strip may run together, each still lifted
// (its own function's WAT holds a vector op) and answering what Node answers. A load one ahead
// of its store, an element in place, a store a pixel and a half ahead, a load a pixel ahead, a
// pixel's channel from another, a reduction's lane local nothing reads after it, a mirror to the
// middle (past a test of its bytes), an outer strip's epilogue reading and writing one element
// lane by lane, an unsigned exit entered at a non-negative counter, a byte shift under 8, two
// element stores packed into an array the loop makes from another's elements.
const A64 = 'const a = new Float64Array(64)\nexport let init = () => { for (let i = 0; i < 64; i++) a[i] = ((i * 7) % 13) - 5.75 }\nexport let check = () => { let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + a[i]) % 1000003; return h }\n'
const KEPT = [
  ['load one ahead of the store', A64 + 'export let f = () => { for (let i = 0; i < 63; i++) a[i] = a[i + 1] * 2; return 0 }'],
  ['in place', A64 + 'export let f = () => { for (let i = 0; i < 64; i++) a[i] = a[i] * 2 + 1; return 0 }'],
  ['store a pixel and a half ahead', A64 + 'export let f = () => { for (let i = 0; i < 30; i++) a[2 * i + 3] = a[2 * i] + 1; return 0 }'],
  ['load a pixel ahead', A64 + 'export let f = () => { for (let i = 0; i < 31; i++) a[2 * i] = a[2 * i + 2] + 1; return 0 }'],
  ['a pixel channel from another', A64 + 'export let f = () => { for (let i = 0; i < 32; i++) a[2 * i + 1] = a[2 * i] * 2; return 0 }'],
  ['a reduction whose lane local stays inside', A64 + 'export let f = () => { let s = 0; for (let i = 0; i < 64; i++) { const d = a[i] * 2; s = s + d * d } return s }'],
  ['a mirror to the middle', `const spec = new Float64Array(64), a = new Float64Array(64)
export let init = () => { for (let k = 0; k < 64; k++) { spec[k] = k * 0.75 + 1; a[k] = 0 } }
export let check = () => { let h = 0; for (let j = 0; j < 64; j++) h = h * 1.5 + a[j] * (j + 1); return h }
export let f = (N, half) => { let k = 1; while (k < half) { let lm = Math.log(spec[k] + 1e-6); a[k] = lm; a[N - k] = lm; k++ } return 0 }`, [64, 32]],
  ['an epilogue blending one element', `const a = new Int32Array(256)
export let init = () => { for (let k = 0; k < 256; k++) a[k] = k * 3 }
export let check = () => { let h = 0; for (let k = 0; k < 256; k++) h = (h * 31 + a[k]) % 1000003; return h }
export let f = (W) => { for (let x = 0; x < W; x++) { const fx = Math.sin(x * 0.37) * 0.5 + 0.5, g = Math.exp(-fx * 2)
  const at = (x * 3) % 256, o = a[at] & 255; a[at] = (o + ((g * 255 - o) * 0.5) | 0) & 255 } return 0 }`, [128]],
  ['an unsigned exit entered at 2', `const a = new Int32Array(256), b = new Int32Array(256)
export let init = () => { for (let k = 0; k < 256; k++) { a[k] = k + 1; b[k] = 0 } }
export let check = () => { let h = 0; for (let k = 0; k < 256; k++) h = (h * 31 + b[k]) % 1000003; return h }
export let f = () => { for (let x = 2; x >= 0 && x < a.length; x++) b[x] = a[x] * 2; return 0 }`],
  ['a byte shift under 8', `const a = new Uint8Array(64), b = new Uint8Array(64)
export let init = () => { for (let k = 0; k < 64; k++) a[k] = k * 7 + 3 }
export let check = () => { let h = 0; for (let k = 0; k < 64; k++) h = (h * 31 + b[k]) % 1000003; return h }
export let f = () => { for (let i = 0; i < 64; i++) b[i] = a[i] << 3; return 0 }`],
  ['a pair into an array it makes', A64 + 'let keep = null\nexport let f = () => { let s = 0; for (let i = 0; i < 62; i++) { keep = [a[i + 1], a[i + 2]]; s += keep[0] * 3 + keep[1] } return s }'],
]
test('vector legality: what it keeps lifted', () => {
  if (belowOpt(2)) return
  const fnOf = (w) => { const i = w.indexOf('(func $f'), j = w.indexOf('\n  (func ', i + 8); return w.slice(i, j < 0 ? undefined : j) }
  for (const [name, src, args = []] of KEPT) for (const optimize of levels(2, 3)) {
    ok(/v128|[if](?:8x16|16x8|32x4|64x2)\./.test(fnOf(compile(src, { optimize, wat: true }))), `${name}: lifted at ${optimize}`)
    const want = oracle(src), got = jz(src, { optimize }).exports
    want.init(); got.init()
    is(got.f(...args), want.f(...args), `${name}: f at ${optimize}`)
    is(got.check(), want.check(), `${name}: memory at ${optimize}`)
  }
})
