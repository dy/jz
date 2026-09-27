// A typed receiver whose element kind only the run decides is decoded once per
// loop (optimize/typed-decode.js): its float accesses load and store directly,
// every other answer stays the runtime helper's.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, wat } from './util.js'

// Buffers of every numeric kind behind one array: the summary names them typed
// arrays of open kind. `pick(k)` cycles Float32Array, Float64Array, a view of
// each, and two integer kinds the decode leaves to the helper.
const pool = `const pick = (k, n) => [new Float32Array(n), new Float64Array(n), new Float32Array(2 * n).subarray(n, 2 * n),
  new Float64Array(3 * n).subarray(n, 2 * n), new Int16Array(n), new Uint8Array(n)][k % 6]
`
const agrees = (src, args, label) => {
  const host = oracle(src).f
  for (const optimize of levels(0, 2, 3, 'size')) {
    const f = jz(src, { optimize }).exports.f
    for (const a of args) {
      const want = host(...a), got = f(...a)
      ok(Object.is(want, got), `${label}, f(${a}) at ${optimize}: ${got} for ${want}`)
    }
  }
}
const kinds = [0, 1, 2, 3, 4, 5].map(k => [k])

const gain = `${pool}
const run = (inp, out, g, n) => { for (let i = 0; i < n; i++) out[i] = inp[i] * g[i] }
export let f = (k) => {
  const n = 40, g = new Float64Array(n), a = pick(k, n), b = pick(k + 1, n)
  for (let i = 0; i < n; i++) { g[i] = 0.5 + i * 0.125; a[i] = (i % 17) - 8 + k * 0.5 }
  run(a, b, g, n)
  let h = 0
  for (let i = 0; i < n; i++) h += b[i] * (i + 1)
  return h
}`

// Two outputs and one input: more receivers than a versioned loop carries.
const pan = `${pool}
const run = (inp, l, r, c, s, n) => { for (let i = 0; i < n; i++) { l[i] = inp[i] * c; r[i] = inp[i] * s } }
export let f = (k) => {
  const n = 40, a = pick(k, n), l = pick(k + 1, n), r = pick(k + 2, n)
  for (let i = 0; i < n; i++) a[i] = (i % 13) * 0.75 - 4
  run(a, l, r, 0.7, 0.3, n)
  let h = 0
  for (let i = 0; i < n; i++) h += l[i] * (i + 1) - r[i] * (i + 2)
  return h
}`

// The loop runs past the end of both arrays: a read there is undefined, a store is dropped.
const past = `${pool}
export let f = (k) => {
  const n = 12, a = pick(k, n), b = pick(k + 3, n)
  for (let i = 0; i < n + 4; i++) a[i] = i * 1.5 + 0.25
  let h = 0, miss = 0
  for (let i = 0; i < n + 4; i++) {
    b[i] = a[i] + 1
    const v = b[i]
    if (v === undefined) miss++
    else h += v * (i + 1)
  }
  return h * 100 + miss
}`

// An index computed per access, and a receiver the outer loop replaces.
const nest = `${pool}
export let f = (k) => {
  const n = 16, bufs = [pick(k, n), pick(k + 1, n), pick(k + 2, n)]
  let h = 0, base = 0
  for (let c = 0; c < 3; c++) {
    const a = bufs[c], b = bufs[(c + 1) % 3]
    for (let i = 0; i < n; i++) a[i] = i * 0.5 + c
    for (let i = 0; i < n - 4; i++) b[base + i] = a[i + (c & 1)] * 2
    for (let i = 0; i < n; i++) h += b[i] * (i + c + 1)
    base = (base + 1) & 3
  }
  return h
}`

// A stored value of open kind: a number stores as it is, anything else takes ToNumber.
const open = `${pool}
const vals = [1.5, '2.5', true, null, undefined, 'x', -0, 7]
export let f = (k) => {
  const n = 8, a = pick(k, n)
  for (let i = 0; i < n; i++) a[i] = vals[i]
  let h = 0, nan = 0
  for (let i = 0; i < n; i++) { const v = a[i]; if (v !== v) nan++; else h += v * (i + 1) }
  return h * 10 + nan
}`

test('typed decode: a gain loop over buffers of open kind', () => agrees(gain, kinds, 'gain'))
test('typed decode: two outputs and one input', () => agrees(pan, kinds, 'pan'))
test('typed decode: reads and stores past the end', () => agrees(past, kinds, 'past'))
test('typed decode: a computed index and a receiver an outer loop replaces', () => agrees(nest, kinds, 'nest'))
test('typed decode: a stored value of open kind', () => agrees(open, kinds, 'open'))

test('typed decode: a missing receiver throws where the access runs', () => {
  const src = `${pool}
export let f = (k) => {
  const bufs = [pick(k, 8), undefined]
  let h = 0
  for (let c = 0; c < 2; c++) {
    const a = bufs[c]
    try { for (let i = 0; i < 8; i++) { h += 1; a[i] = i; h += a[i] } } catch (e) { h += 1000 }
  }
  return h
}`
  agrees(src, kinds, 'missing receiver')
})

test('typed decode: the loop holds a direct access beside each helper call', () => {
  if (belowOpt(3)) return
  // `run` is inlined into its caller: the loop is wherever the decode locals are.
  const text = wat(pan, { optimize: 3 })
  const body = funcWat(text, 'f$exp') || funcWat(text, 'f')
  ok(/\$__utd\d+/.test(body), 'receivers decoded into locals')
  ok(/f32\.store/.test(body) && /f64\.store/.test(body), 'a store of each float width')
})
