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
  agree("W3 ramp conditional store", `const a = new Uint8Array(64), b = new Uint8Array(64)
export let f = () => { for (let i = 0; i < 64; i++) { a[i] = i & 127; if ((i & 1) === 0) b[i] = 7 }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + b[i]) % 1000003; return h }`)
  agree("W4 ramp shift 16", `const a = new Uint8Array(64), b = new Uint8Array(64)
export let f = () => { for (let i = 0; i < 64; i++) a[i] = (i * 37 + 11) & 127
  for (let i = 0; i < 64; i++) b[i] = (a[i] * a[i]) >> 16
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + b[i]) % 1000003; return h }`)
  agree("W5 tone-map arm store", `const d = new Int32Array(64), a = new Int32Array(64), b = new Int32Array(64)
export let f = () => { for (let i = 0; i < 64; i++) d[i] = (i * 37 + 11) & 127
  for (let i = 0; i < 64; i++) { const v = d[i]; if (v > 60) { b[i] = 7; a[i] = (Math.log(v * 1.5 + 1) * 20) | 0 } }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + a[i] + b[i]) % 1000003; return h }`)
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

// A store under a condition beside a ramp, at an address no lane address names.
test('vector legality: arms', () => {
  agree("C-ramp cond store strided", `const o = new Int32Array(64), p = new Int32Array(160)
export let f = () => { for (let i = 0; i < 64; i++) { o[i] = i * 3; if ((i & 1) === 0) p[2 * i] = 5 }
  let h = 0; for (let k = 0; k < 160; k++) h = (h * 31 + p[k]) % 1000003; return h + o[7] }`)
})

// A lane narrower than the scalar's word: a byte or 16-bit lane shifts by its count modulo
// its width, the word by it modulo 32; a product of two unsigned bytes overflows a 16-bit lane.
test('vector legality: narrow', () => {
  agree("S-u8 shl 8", `const a = new Uint8Array(64), b = new Uint8Array(64)
export let f = () => { for (let k = 0; k < 64; k++) a[k] = k * 7 + 3
  for (let i = 0; i < 64; i++) b[i] = a[i] << 8
  let h = 0; for (let k = 0; k < 64; k++) h = (h * 31 + b[k]) % 1000003; return h }`)
  agree("S-u8 shl by arg 8", `const a = new Uint8Array(64), b = new Uint8Array(64)
export let f = (s) => { for (let k = 0; k < 64; k++) a[k] = k * 7 + 3
  for (let i = 0; i < 64; i++) b[i] = a[i] << s
  let h = 0; for (let k = 0; k < 64; k++) h = (h * 31 + b[k]) % 1000003; return h }`, [8])
  agree("S-u16 shl 16", `const a = new Uint16Array(64), b = new Uint16Array(64)
export let f = () => { for (let k = 0; k < 64; k++) a[k] = k * 997 + 3
  for (let i = 0; i < 64; i++) b[i] = a[i] << 16
  let h = 0; for (let k = 0; k < 64; k++) h = (h * 31 + b[k]) % 1000003; return h }`)
  agree("S-i16 shl 17", `const a = new Int16Array(64), b = new Int16Array(64)
export let f = () => { for (let k = 0; k < 64; k++) a[k] = k * 997 - 3000
  for (let i = 0; i < 64; i++) b[i] = a[i] << 17
  let h = 0; for (let k = 0; k < 64; k++) h = (h * 31 + b[k]) % 1000003; return h }`)
  agree("OS-5-j-mixloop", `
const wt2 = new Int8Array(64)
const inp = new Uint8Array(4096), wt = new Uint8Array(64), out = new Int32Array(4096)
export let f = () => {
  for (let i = 0; i < 4096; i++) inp[i] = 200 + (i & 31)
  for (let i = 0; i < 64; i++) wt[i] = 180 + (i & 15)
  for (let i = 0; i < 64; i++) wt2[i] = i * 7 - 100
  for (let ox = 0; ox < 256; ox++) {
    let acc = 0; for (let kx = 0; kx < 4; kx++) { acc += inp[ox + kx] * wt[kx]; acc += inp[ox + kx + 4] * wt2[kx] } out[ox] = acc
  }
  
  let h = 0; for (let i = 0; i < 256; i++) h = (Math.imul(h, 31) + out[i]) | 0; return h
}`)
})

// An address the lift keeps as written, lane 0's, reading what only lane 0 holds: the ramp's
// copy of the counter, a convolution tap strided, reversed or scaled, a store or a local the
// convolution's setup computes once for eight pixels.
test('vector legality: addresses', () => {
  agree("L-R4-a copy of i used as index and data", `const o = new Uint8Array(64), p = new Uint8Array(64), s = new Uint8Array(64)
export let f = () => {
  for (let i = 0; i < 64; i++) { const j = i; o[j] = (j * 5) & 255 }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + o[i] + p[i]) % 1000003; return h }`)
  agree("L-R4-e pure ramp with lane temps feeding address copy", `const o = new Uint8Array(64), p = new Uint8Array(64), s = new Uint8Array(64)
export let f = () => {
  for (let i = 0; i < 64; i++) { const j = i; const t = (j * 7) & 255; o[j] = t }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + o[i] + p[i]) % 1000003; return h }`)
  agree("L-R4-f copy of i, widening u8 map", `const o = new Uint8Array(64), p = new Uint8Array(64), s = new Uint8Array(64)
export let f = () => { for (let i = 0; i < 64; i++) s[i] = (i * 37 + 11) & 127
  for (let i = 0; i < 64; i++) { const j = i; o[j] = (s[j] * 3) & 255 }
  let h = 0; for (let i = 0; i < 64; i++) h = (h * 31 + o[i] + p[i]) % 1000003; return h }`)
  agree("OS-6-a-stride2", `

const inp = new Int8Array(4096), wt = new Int8Array(64), out = new Int32Array(4096)
export let f = () => {
  for (let i = 0; i < 4096; i++) inp[i] = (i * 37 + 11) & 255
  for (let i = 0; i < 64; i++) wt[i] = (i * 91 + 5) & 255
  
  for (let ox = 0; ox < 256; ox++) {
    let acc = 0; for (let kx = 0; kx < 4; kx++) acc += inp[ox * 2 + kx] * wt[kx]; out[ox] = acc
  }
  
  let h = 0; for (let i = 0; i < 256; i++) h = (Math.imul(h, 31) + out[i]) | 0; return h
}`)
  agree("OS-6-c-reverse", `

const inp = new Int8Array(4096), wt = new Int8Array(64), out = new Int32Array(4096)
export let f = () => {
  for (let i = 0; i < 4096; i++) inp[i] = (i * 37 + 11) & 255
  for (let i = 0; i < 64; i++) wt[i] = (i * 91 + 5) & 255
  
  for (let ox = 0; ox < 256; ox++) {
    let acc = 0; for (let kx = 0; kx < 4; kx++) acc += inp[1000 - ox + kx] * wt[kx]; out[ox] = acc
  }
  
  let h = 0; for (let i = 0; i < 256; i++) h = (Math.imul(h, 31) + out[i]) | 0; return h
}`)
  agree("OS-6-e-mulvar", `

const inp = new Int8Array(4096), wt = new Int8Array(64), out = new Int32Array(4096)
export let f = () => {
  for (let i = 0; i < 4096; i++) inp[i] = (i * 37 + 11) & 255
  for (let i = 0; i < 64; i++) wt[i] = (i * 91 + 5) & 255
  const s = 3
  for (let ox = 0; ox < 256; ox++) {
    let acc = 0; for (let kx = 0; kx < 4; kx++) acc += inp[ox * s + kx] * wt[kx]; out[ox] = acc
  }
  
  let h = 0; for (let i = 0; i < 256; i++) h = (Math.imul(h, 31) + out[i]) | 0; return h
}`)
  agree("OS-6-f-storebefore", `
const side = new Int32Array(4096)
const inp = new Int8Array(4096), wt = new Int8Array(64), out = new Int32Array(4096)
export let f = () => {
  for (let i = 0; i < 4096; i++) inp[i] = (i * 37 + 11) & 255
  for (let i = 0; i < 64; i++) wt[i] = (i * 91 + 5) & 255
  
  for (let ox = 0; ox < 256; ox++) {
    side[ox] = ox + 1; let acc = 0; for (let kx = 0; kx < 4; kx++) acc += inp[ox + kx] * wt[kx]; out[ox] = acc
  }
  for (let i = 0; i < 256; i++) out[i] = out[i] + side[i]
  let h = 0; for (let i = 0; i < 256; i++) h = (Math.imul(h, 31) + out[i]) | 0; return h
}`)
  agree("OS-6-g-derivedlocal", `

const inp = new Int8Array(4096), wt = new Int8Array(64), out = new Int32Array(4096)
export let f = () => {
  for (let i = 0; i < 4096; i++) inp[i] = (i * 37 + 11) & 255
  for (let i = 0; i < 64; i++) wt[i] = (i * 91 + 5) & 255
  
  for (let ox = 0; ox < 256; ox++) {
    const q = (ox * 3) | 0; let acc = 0; for (let kx = 0; kx < 4; kx++) acc += inp[ox + kx] * wt[kx]; out[ox] = acc + q
  }
  
  let h = 0; for (let i = 0; i < 256; i++) h = (Math.imul(h, 31) + out[i]) | 0; return h
}`)
})

// The RGBA box sums (blur-channel.js): a statement after the four stores or between the taps
// and the stores, a tap count each pixel sets, a window longer than the 16-bit guard holds, a sum
// read or seeded beside its accumulation, a pixel local read after the loop, a row offset the
// pixel loop sets before its sums.
test('vector legality: channels', () => {
  agree("CH-3-a-tailstore", `

const R = 4, W = 64
const src = new Uint8Array(W * 4 + 64), dst = new Uint8Array(W * 4 + 64), aux = new Int32Array(W + 8)
const blurRow = (src, dst, aux, w, r) => {
  const n = 2 * r + 1
  
  for (let x = r; x < w - r; x++) {
    
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    
    for (let k = -r; k <= r; k++) {
      
      const p = (x + k) << 2
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      
    }
    const o = x << 2; dst[o] = (s0 / n) | 0; dst[o + 1] = (s1 / n) | 0; dst[o + 2] = (s2 / n) | 0; dst[o + 3] = (s3 / n) | 0
    aux[x] = x + 1
  }
  
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  for (let i = 0; i < dst.length; i++) dst[i] = (i * 5) & 255
  blurRow(src, dst, aux, W, R)
  let h = 0; for (let i = 0; i < dst.length; i++) h = (Math.imul(h, 31) + dst[i]) | 0; for (let i = 0; i < aux.length; i++) h = (Math.imul(h, 31) + aux[i]) | 0; return h
}`)
  agree("CH-3-d-prestore-reads-acc", `

const R = 4, W = 64
const src = new Uint8Array(W * 4 + 64), dst = new Uint8Array(W * 4 + 64), aux = new Int32Array(W + 8)
const blurRow = (src, dst, aux, w, r) => {
  const n = 2 * r + 1
  
  for (let x = r; x < w - r; x++) {
    
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    
    for (let k = -r; k <= r; k++) {
      
      const p = (x + k) << 2
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      
    }
    const o = x << 2; aux[x] = s0; dst[o] = (s0 / n) | 0; dst[o + 1] = (s1 / n) | 0; dst[o + 2] = (s2 / n) | 0; dst[o + 3] = (s3 / n) | 0; 
    
  }
  
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  for (let i = 0; i < dst.length; i++) dst[i] = (i * 5) & 255
  blurRow(src, dst, aux, W, R)
  let h = 0; for (let i = 0; i < dst.length; i++) h = (Math.imul(h, 31) + dst[i]) | 0; for (let i = 0; i < aux.length; i++) h = (Math.imul(h, 31) + aux[i]) | 0; return h
}`)
  agree("CH-3-e-tail-aux5", `

const R = 4, W = 64
const src = new Uint8Array(W * 4 + 64), dst = new Uint8Array(W * 4 + 64), aux = new Int32Array(W + 8)
const blurRow = (src, dst, aux, w, r) => {
  const n = 2 * r + 1
  
  for (let x = r; x < w - r; x++) {
    
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    
    for (let k = -r; k <= r; k++) {
      
      const p = (x + k) << 2
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      
    }
    const o = x << 2; dst[o] = (s0 / n) | 0; dst[o + 1] = (s1 / n) | 0; dst[o + 2] = (s2 / n) | 0; dst[o + 3] = (s3 / n) | 0
    aux[x] = x + 1
  }
  
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  for (let i = 0; i < dst.length; i++) dst[i] = (i * 5) & 255
  blurRow(src, dst, aux, W, R)
  return aux[4] * 1000 + aux[5]
}`)
  agree("CH-3-f-pre-aux5", `

const R = 4, W = 64
const src = new Uint8Array(W * 4 + 64), dst = new Uint8Array(W * 4 + 64), aux = new Int32Array(W + 8)
const blurRow = (src, dst, aux, w, r) => {
  const n = 2 * r + 1
  
  for (let x = r; x < w - r; x++) {
    
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    
    for (let k = -r; k <= r; k++) {
      
      const p = (x + k) << 2
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      
    }
    const o = x << 2; aux[x] = x + 1; dst[o] = (s0 / n) | 0; dst[o + 1] = (s1 / n) | 0; dst[o + 2] = (s2 / n) | 0; dst[o + 3] = (s3 / n) | 0; 
    
  }
  
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  for (let i = 0; i < dst.length; i++) dst[i] = (i * 5) & 255
  blurRow(src, dst, aux, W, R)
  return aux[4] * 1000 + aux[5]
}`)
  agree("CH-3-g-tail-total", `

const R = 4, W = 64
const src = new Uint8Array(W * 4 + 64), dst = new Uint8Array(W * 4 + 64), aux = new Int32Array(W + 8)
const blurRow = (src, dst, aux, w, r) => {
  const n = 2 * r + 1
  let total = 0
  for (let x = r; x < w - r; x++) {
    
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    
    for (let k = -r; k <= r; k++) {
      
      const p = (x + k) << 2
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      
    }
    const o = x << 2; dst[o] = (s0 / n) | 0; dst[o + 1] = (s1 / n) | 0; dst[o + 2] = (s2 / n) | 0; dst[o + 3] = (s3 / n) | 0
    total += s0
  }
  aux[0] = total
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  for (let i = 0; i < dst.length; i++) dst[i] = (i * 5) & 255
  blurRow(src, dst, aux, W, R)
  return aux[0]
}`)
  agree("CH-4-a-tap-le-x", `

const R = 4, W = 64
const src = new Uint8Array(4096), dst = new Uint8Array(W * 4 + 64), aux = new Int32Array(W + 8)
const blurRow = (src, dst, aux, w, r) => {
  const n = 9
  
  for (let x = r; x < w - r; x++) {
    
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    
    for (let k = 0; k <= x; k++) {
      
      const p = (x + k) << 2
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      
    }
    const o = x << 2; dst[o] = (s0 / n) | 0; dst[o + 1] = (s1 / n) | 0; dst[o + 2] = (s2 / n) | 0; dst[o + 3] = (s3 / n) | 0
    
  }
  
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  for (let i = 0; i < dst.length; i++) dst[i] = (i * 5) & 255
  blurRow(src, dst, aux, W, R)
  let h = 0; for (let i = 0; i < dst.length; i++) h = (Math.imul(h, 31) + dst[i]) | 0; for (let i = 0; i < aux.length; i++) h = (Math.imul(h, 31) + aux[i]) | 0; return h
}`)
  agree("CH-4-b-long-window", `

const R = 4, W = 64
const src = new Uint8Array(8192), dst = new Uint8Array(W * 4 + 64), aux = new Int32Array(W + 8)
const blurRow = (src, dst, aux, w, r) => {
  const n = 1005
  
  for (let x = r; x < w - r; x++) {
    
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    
    for (let k = -1000; k <= r; k++) {
      
      const p = (x + k + 1000) << 2
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      
    }
    const o = x << 2; dst[o] = (s0 / n) | 0; dst[o + 1] = (s1 / n) | 0; dst[o + 2] = (s2 / n) | 0; dst[o + 3] = (s3 / n) | 0
    
  }
  
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  for (let i = 0; i < dst.length; i++) dst[i] = (i * 5) & 255
  blurRow(src, dst, aux, W, R)
  let h = 0; for (let i = 0; i < dst.length; i++) h = (Math.imul(h, 31) + dst[i]) | 0; for (let i = 0; i < aux.length; i++) h = (Math.imul(h, 31) + aux[i]) | 0; return h
}`)
  agree("CH-5-c-break-on-acc", `

const R = 4, W = 64
const src = new Uint8Array(W * 4 + 64), dst = new Uint8Array(W * 4 + 64), aux = new Int32Array(W + 8)
const blurRow = (src, dst, aux, w, r) => {
  const n = 2 * r + 1
  
  for (let x = r; x < w - r; x++) {
    
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    
    for (let k = -r; k <= r; k++) {
      
      const p = (x + k) << 2
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      if (s0 > 700) break
    }
    const o = x << 2; dst[o] = (s0 / n) | 0; dst[o + 1] = (s1 / n) | 0; dst[o + 2] = (s2 / n) | 0; dst[o + 3] = (s3 / n) | 0
    
  }
  
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  for (let i = 0; i < dst.length; i++) dst[i] = (i * 5) & 255
  blurRow(src, dst, aux, W, R)
  let h = 0; for (let i = 0; i < dst.length; i++) h = (Math.imul(h, 31) + dst[i]) | 0; for (let i = 0; i < aux.length; i++) h = (Math.imul(h, 31) + aux[i]) | 0; return h
}`)
  agree("CH-5-e-cond-seed", `

const R = 4, W = 64
const src = new Uint8Array(W * 4 + 64), dst = new Uint8Array(W * 4 + 64), aux = new Int32Array(W + 8)
const blurRow = (src, dst, aux, w, r) => {
  const n = 9
  for (let i = 0; i < 70; i++) aux[i] = i * 3 + 1
  for (let x = r; x < w - r; x++) {
    
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    if (aux[x] > 100) s0 = 5000
    for (let k = -r; k <= r; k++) {
      
      const p = (x + k) << 2
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      
    }
    const o = x << 2; dst[o] = (s0 / n) | 0; dst[o + 1] = (s1 / n) | 0; dst[o + 2] = (s2 / n) | 0; dst[o + 3] = (s3 / n) | 0
    
  }
  
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  for (let i = 0; i < dst.length; i++) dst[i] = (i * 5) & 255
  blurRow(src, dst, aux, W, R)
  let h = 0; for (let i = 0; i < dst.length; i++) h = (Math.imul(h, 31) + dst[i]) | 0; for (let i = 0; i < aux.length; i++) h = (Math.imul(h, 31) + aux[i]) | 0; return h
}`)
  agree("CH-5-f-inner-reads-acc-int", `

const R = 4, W = 64
const src = new Uint8Array(W * 4 + 64), dst = new Uint8Array(W * 4 + 64), aux = new Int32Array(W + 8)
const blurRow = (src, dst, aux, w, r) => {
  const n = 2 * r + 1
  for (let i = 0; i < 70; i++) aux[i] = i * 3 + 1
  for (let x = r; x < w - r; x++) {
    let cnt = 0
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    
    for (let k = -r; k <= r; k++) {
      cnt = (cnt + (s0 & 1)) | 0
      const p = (x + k) << 2
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      
    }
    const o = x << 2; dst[o] = ((s0 + cnt) / n) | 0; dst[o + 1] = ((s1 + cnt) / n) | 0; dst[o + 2] = ((s2 + cnt) / n) | 0; dst[o + 3] = ((s3 + cnt) / n) | 0
    
  }
  
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  for (let i = 0; i < dst.length; i++) dst[i] = (i * 5) & 255
  blurRow(src, dst, aux, W, R)
  let h = 0; for (let i = 0; i < dst.length; i++) h = (Math.imul(h, 31) + dst[i]) | 0; for (let i = 0; i < aux.length; i++) h = (Math.imul(h, 31) + aux[i]) | 0; return h
}`)
  agree("CH-7-c-o-ret", `

const R = 4, W = 64
const src = new Uint8Array(W * 4 + 64), dst = new Uint8Array(W * 4 + 64), aux = new Int32Array(W + 8)
const blurRow = (src, dst, aux, w, r) => {
  const n = 2 * r + 1
  let o = 0
  for (let x = r; x < w - r; x++) {
    
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    
    for (let k = -r; k <= r; k++) {
      
      const p = (x + k) << 2
      s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      
    }
    o = x << 2; ; dst[o] = (s0 / n) | 0; dst[o + 1] = (s1 / n) | 0; dst[o + 2] = (s2 / n) | 0; dst[o + 3] = (s3 / n) | 0; 
    
  }
  aux[0] = o
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  for (let i = 0; i < dst.length; i++) dst[i] = (i * 5) & 255
  blurRow(src, dst, aux, W, R)
  return aux[0]
}`)
  agree("CH-8-a-row-local-in-pixel-loop", `

const src = new Uint8Array(4096), dst = new Uint8Array(4096)
const blurRows = (src, dst, w, r) => {
  const n = 2 * r + 1
  for (let y = 0; y < 6; y++) {
    
    for (let x = r; x < w - r; x++) {
      const rowb = y * 64
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0
      for (let k = -r; k <= r; k++) {
        const p = (rowb + x + k + 8) << 2
        s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]
      }
      const o = (rowb + x) << 2
      dst[o] = (s0 / n) | 0; dst[o + 1] = (s1 / n) | 0; dst[o + 2] = (s2 / n) | 0; dst[o + 3] = (s3 / n) | 0
    }
  }
}
export let f = () => {
  for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 29 + 11) & 255
  blurRows(src, dst, 64, 4)
  let h = 0; for (let i = 0; i < dst.length; i++) h = (Math.imul(h, 31) + dst[i]) | 0; return h
}`)
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
