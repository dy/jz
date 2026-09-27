// Float → integer quantization loops: a cursor beside the counter is rewritten
// over the counter (vectorize/counter-run.js), and a lane the body's clamps
// bound within i32 truncates as a vector (vectorize/map.js rangedTruncations).
import test from 'tst'
import { ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'

const body = src => { const text = wat(src, { optimize: 3 }); return funcWat(text, 'f') || funcWat(text, 'f$exp') }
const check = (src, args, name) => {
  for (const optimize of levels(0, 2, 3, 'size')) agree(src, 'f', args, { optimize }, `${name} at ${optimize}`)
}

// Samples with the values a conversion must get right: NaN, infinities, the
// rails, fractions either side of zero, and magnitudes past i32.
const fill = `const SPECIAL = [NaN, Infinity, -Infinity, 0, -0, 1, -1, 0.99999, -0.99999, 1.00001, -1.00002, 0.5, -0.5, 1e-300, 70000, -70000, 3e9, -3e9]
  for (let i = 0; i < n; i++) s[i] = i < 18 ? SPECIAL[i] : ((i * 7919) % 2001 - 1000) / 800`
const digest = (buf, n) => `let h = 0
  for (let i = 0; i < ${n}; i++) h = (h * 31 + ${buf}[i]) | 0
  return h`

test('quantize: a byte cursor beside the counter vectorizes as PCM-16', () => {
  const src = `export let f = (n) => {
  const s = new Float64Array(200), o = new Uint8Array(444)
  ${fill}
  let op = 44
  for (let i = 0; i < n; i++) {
    let v = s[i] * 32767.0
    if (v > 32767.0) v = 32767.0
    else if (v < -32768.0) v = -32768.0
    const u = (v | 0) & 0xffff
    o[op] = u & 0xff
    o[op + 1] = (u >>> 8) & 0xff
    op += 2
  }
  o[0] = op & 0xff; o[1] = op >> 8
  ${digest('o', 444)}
}`
  const text = body(src)
  ok(/i32x4\.trunc_sat_f64x2_s_zero/.test(text), 'the clamped lane truncates as a vector')
  ok(/v128\.load/.test(text), 'the samples load two at a time')
  for (const n of [0, 1, 2, 3, 17, 18, 19, 64, 199, 200]) check(src, [n], `pcm16(${n})`)
})

test('quantize: the cursor lands on its value after the loop, whatever the entry', () => {
  const src = `export let f = (n, from) => {
  const s = new Float64Array(200), o = new Int16Array(260)
  ${fill}
  let op = 7 + from
  for (let i = from; i < n; i++) {
    let v = s[i] * 1000.0
    if (v > 32767.0) v = 32767.0
    if (v < -32768.0) v = -32768.0
    o[op] = v | 0
    op += 1
  }
  o[0] = op
  ${digest('o', 260)}
}`
  for (const [n, from] of [[0, 0], [1, 0], [7, 3], [64, 1], [200, 0], [200, 199], [5, 9]]) check(src, [n, from], `cursor(${n}, ${from})`)
})

test('quantize: a cursor read outside an address, and a step of three, stay exact', () => {
  const src = `export let f = (n) => {
  const s = new Float64Array(200), o = new Uint8Array(640)
  ${fill}
  let op = 2, acc = 0
  for (let i = 0; i < n; i++) {
    let v = s[i] * 100.0
    if (v > 127.0) v = 127.0
    else if (v < -128.0) v = -128.0
    o[op] = v | 0
    acc = (acc + op) | 0
    op += 3
  }
  o[0] = acc & 0xff; o[1] = op & 0xff
  ${digest('o', 640)}
}`
  for (const n of [0, 1, 2, 9, 64, 200]) check(src, [n], `step3(${n})`)
})

test('quantize: an unclamped or widely clamped lane keeps the wrapping conversion', () => {
  const unclamped = `export let f = (n) => {
  const s = new Float64Array(200), o = new Int32Array(200)
  ${fill}
  for (let i = 0; i < n; i++) o[i] = (s[i] * 1e6) | 0
  ${digest('o', 200)}
}`
  ok(!/i32x4\.trunc_sat_f64x2_s_zero/.test(body(unclamped)), 'no saturating lane conversion without a bound')
  for (const n of [0, 1, 19, 200]) check(unclamped, [n], `unclamped(${n})`)
  const wide = `export let f = (n) => {
  const s = new Float64Array(200), o = new Int32Array(200)
  ${fill}
  for (let i = 0; i < n; i++) {
    let v = s[i] * 1e6
    if (v > 3e9) v = 3e9
    else if (v < -3e9) v = -3e9
    o[i] = v | 0
  }
  ${digest('o', 200)}
}`
  ok(!/i32x4\.trunc_sat_f64x2_s_zero/.test(body(wide)), 'a clamp past i32 proves nothing')
  for (const n of [0, 1, 19, 200]) check(wide, [n], `wide(${n})`)
})

test('quantize: a clamp at function level retires the guard too', () => {
  const src = `export let f = (x) => {
  let v = x * 2.5
  if (v > 1000.0) v = 1000.0
  else if (v < -1000.0) v = -1000.0
  return v | 0
}`
  ok(!/f64\.const inf/.test(body(src)), 'no ±∞ guard')
  for (const x of [NaN, Infinity, -Infinity, 0, -0, 1.5, -399.9, 400, 1e300, -1e300]) check(src, [x], `clamp(${x})`)
})
