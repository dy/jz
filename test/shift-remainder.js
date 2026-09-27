// A remainder rebuilt from its shifted quotient is a mask
// (optimize/shift-remainder.js): `x - ((x >> k) << k)` is `x & (2^k - 1)` while
// neither the quotient nor `x` is written in between.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, wat } from './util.js'

const inputs = [0, 1, 7, 8, 15, 16, 17, 255, 65535, 65536, 65537, 6291456, 8291455, 2147483647, -1, -7, -8, -16, -17, -65536, -65537, -2147483648]

// Each is one exported function of two integers.
const forms = {
  'an unsigned shift': `(a, b) => { const x = a | 0, q = x >>> 16; return x - q * 65536 }`,
  'a signed shift': `(a, b) => { const x = a | 0, q = x >> 4; return x - q * 16 }`,
  'a shift back': `(a, b) => { const x = a | 0, q = x >>> 3; return (x - (q << 3)) | 0 }`,
  'a quotient in place': `(a, b) => { const x = a | 0; return (x - ((x >>> 3) << 3)) | 0 }`,
  'a signed quotient in place': `(a, b) => { const x = (a + b) | 0; return (x - ((x >> 5) * 32)) | 0 }`,
  'a quotient in place of another value': `(a, b) => { const x = a | 0, y = b | 0; return (x - ((y >>> 3) << 3)) | 0 }`,
  'a division truncated': `(a, b) => { const x = a | 0, q = (x / 65536) | 0; return x - q * 65536 }`,
  'a division of a masked value': `(a, b) => { const x = a & 0x7fffff, q = (x / 65536) | 0; return (x - q * 65536) / 65536 + q }`,
  'the quotient used as an index': `(a, b) => { const x = (a & 0xfffff) + 4096, q = x >>> 12, t = [3, 5, 7, 11, 13]; return (t[q & 3] * (x - q * 4096)) | 0 }`,
  'the value written between': `(a, b) => { let x = a | 0; const q = x >>> 3; x = (x + b) | 0; return (x - (q << 3)) | 0 }`,
  'the quotient written between': `(a, b) => { const x = a | 0; let q = x >>> 3; q = (q + b) | 0; return (x - (q << 3)) | 0 }`,
  'a quotient of either arm': `(a, b) => { const x = a | 0; let q = 0; if (b & 1) q = x >>> 3; else q = x >>> 2; return (x - (q << 3)) | 0 }`,
  'a quotient made in one arm': `(a, b) => { const x = a | 0; let q = x >>> 2; if (b & 1) q = x >>> 3; return (x - (q << 3)) | 0 }`,
  'another shift back': `(a, b) => { const x = a | 0, q = x >>> 3; return (x - (q << 2)) | 0 }`,
  'a quotient of another value': `(a, b) => { const x = a | 0, y = b | 0, q = y >>> 3; return (x - (q << 3)) | 0 }`,
  'a quotient carried into a loop': `(a, b) => { let x = a | 0, h = 0; const q = x >>> 4; for (let i = 0; i < 3; i++) { h = (h + (x - (q << 4))) | 0; x = (x + b) | 0 } return h }`,
  'a quotient made in a loop': `(a, b) => { let x = a | 0, h = 0; for (let i = 0; i < 4; i++) { const q = x >>> 5; h = (h * 31 + (x - q * 32) + q) | 0; x = (x + b + i) | 0 } return h }`,
}

test('shift remainder: every form agrees with JS', () => {
  const names = Object.keys(forms)
  const src = names.map((n, i) => `export let f${i} = ${forms[n]}`).join('\n')
  const host = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const mod = jz(src, { optimize }).exports
    names.forEach((n, i) => {
      for (const a of inputs) for (const b of [0, 1, 3, -5]) {
        const want = host[`f${i}`](a, b), got = mod[`f${i}`](a, b)
        ok(Object.is(want, got), `${n}, f(${a}, ${b}) at ${optimize}: ${got} for ${want}`)
      }
    })
  }
})

// The fixed-point split of a delay line: the quotient indexes, the remainder interpolates.
const split = `const run = (ring, out, n, step) => {
  let lfo = 0, head = 0
  for (let i = 0; i < n; i++) {
    lfo = (lfo + step) & 0xffffffff
    const raw = lfo & 0x1ffff
    const tri = raw < 0x10000 ? raw : 0x20000 - raw
    const dq = 96 * 65536 + tri * 2000
    const dInt = (dq / 65536) | 0
    const dFrac = (dq - dInt * 65536) / 65536.0
    out[i] = ring[(head - dInt) & 1023] * dFrac
    head = (head + 1) | 0
  }
}
export let f = (n) => {
  const ring = new Float64Array(1024), out = new Float64Array(64)
  for (let i = 0; i < 1024; i++) ring[i] = i * 0.5 + 1
  run(ring, out, 64, 977 + (n | 0))
  let h = 0
  for (let i = 0; i < 64; i++) h += out[i] * (i + 1)
  return h
}`

test('shift remainder: a fixed-point split', () => {
  const host = oracle(split).f
  for (const optimize of levels(0, 2, 3, 'size')) {
    const f = jz(split, { optimize }).exports.f
    for (const n of [0, 1, 131, 4096, 77777]) ok(Object.is(f(n), host(n)), `f(${n}) at ${optimize}: ${f(n)} for ${host(n)}`)
  }
})

test('shift remainder: the split masks', () => {
  if (belowOpt(2)) return
  const text = wat(split, { optimize: 2 })
  const body = (funcWat(text, 'f$exp') || funcWat(text, 'f') || text).replace(/\s+/g, ' ')
  ok(/\(i32\.and \(local\.get [^)]+\) \(i32\.const 65535\)\)/.test(body), 'the remainder is a mask')
  ok(!/\(i32\.(?:shl|mul) \(local\.get [^)]+\) \(i32\.const (?:16|65536)\)\)/.test(body), 'the quotient is not scaled back')
})
