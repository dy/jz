// Sentinel guards (src/compile/sentinel-guard.js): a range test versions the
// reads only a data sentinel bounds. The kernel is the lower envelope of parabolas
// (the exact distance transform's 1-D pass, bench/sdf): its hull cursor is
// popped until a comparison with the `-INF` sentinel fails and scanned until
// the `+INF` one stops it. Every case runs against the host, with inputs that
// break the sentinels (-Infinity pops past z[0], NaN fails every comparison),
// so the unguarded original loops run too.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, levels } from './_matrix.js'
import { funcWat, oracle } from './util.js'

const N = 48
const ENVELOPE = `
const INF = 1e20
const edt1d = (f, d, v, z, n) => {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k])
    while (s <= z[k]) {
      k--
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}
export let run = (seed, mode) => {
  const f = new Float64Array(${N}), d = new Float64Array(${N}), v = new Int32Array(${N}), z = new Float64Array(${N + 1})
  let s = seed | 0
  for (let i = 0; i < ${N}; i++) {
    s = (s * 1103515245 + 12345) | 0
    const r = (s >>> 8) % 100
    f[i] = mode === 0 ? (r < 30 ? 0 : INF) : mode === 1 ? r - 50 : mode === 2 ? (r < 10 ? -Infinity : r) : (r < 10 ? NaN : r)
  }
  edt1d(f, d, v, z, ${N})
  let h = 0
  for (let i = 0; i < ${N}; i++) h = (h * 31 + (d[i] === d[i] ? d[i] % 1000003 : 7)) % 1000000007
  let hv = 0
  for (let i = 0; i < ${N}; i++) hv = (hv * 17 + v[i]) % 1000000007
  return h + '/' + hv + '/' + z[0]
}`

const GUARDS_OFF = { level: 'speed', sentinelGuards: false }
/** Checked element reads: each yields undefined (or NaN, consumed by arithmetic) on its miss arm. */
const missArms = (wat) => (wat.match(/\(else \(f64\.const nan\b/g) || []).length
const kernelOf = (wat) => funcWat(wat, 'edt1d') || funcWat(wat, 'run') || funcWat(wat, 'run$exp')

test('sentinel guard: the lower envelope matches the host with and without its sentinels', () => {
  const native = oracle(ENVELOPE).run
  for (const optimize of [...levels(0, 2, 3, 'size'), GUARDS_OFF]) {
    const wasm = jz(ENVELOPE, { optimize }).exports.run
    for (let mode = 0; mode < 4; mode++) for (let seed = 1; seed <= 12; seed++)
      is(wasm(seed, mode), native(seed, mode), `${JSON.stringify(optimize)}: mode ${mode}, seed ${seed}`)
  }
})

test('sentinel guard: the pop, the scan and the read after the scan run unchecked on the fast path', () => {
  if (onKernel()) return
  const guarded = kernelOf(compile(ENVELOPE, { optimize: 'speed', wat: true }))
  const plain = kernelOf(compile(ENVELOPE, { optimize: GUARDS_OFF, wat: true }))
  // the pop guard `k >= 1` (an exit branches on its negation, `k < 1`), the scan
  // guard `k <= N - 1`, the suffix guard after it
  ok(/\(i32\.(ge|lt)_s \(local\.get \$[^\s)]*k[^\s)]*\) \(i32\.const 1\)\)/.test(guarded), 'the pop tests k >= 1')
  ok(new RegExp(`\\(i32\\.le_s \\(local\\.get \\$[^\\s)]*k[^\\s)]*\\) \\(i32\\.const ${N - 1}\\)\\)`).test(guarded), `the scan and its suffix test k <= ${N - 1}`)
  // every checked read of the unguarded build survives only in the slow copies
  is(missArms(guarded), missArms(plain), 'the slow copies keep every original check')
  ok(missArms(plain) > 0, 'the unguarded kernel checks its cursor reads')
})

test('sentinel guard: the size tier copies nothing', () => {
  if (onKernel()) return
  is(compile(ENVELOPE, { optimize: 'size', wat: true }), compile(ENVELOPE, { optimize: { level: 'size', sentinelGuards: false }, wat: true }))
})

// The forms decline where a copy could not stand for the original: a loop that
// breaks itself (the slow loop would run after the break), a cursor a closure
// writes, a cursor the suffix writes. Each still computes the host's result.
test('sentinel guard: a break, a captured cursor and a suffix write keep the original code', () => {
  const cases = {
    ownBreak: `export function f(n) {
      const z = new Float64Array(8); for (let t = 0; t < 8; t++) z[t] = t - 4
      let k = 7, s = 0
      while (n <= z[k]) { k--; if (z[k] === -2) break; s += z[k] }
      return s * 100 + k }`,
    captured: `export function f(n) {
      const z = new Float64Array(8); for (let t = 0; t < 8; t++) z[t] = t - 4
      let k = 7, s = 0
      const drop = () => { k-- }
      while (n <= z[k]) { drop(); s += z[k] }
      return s * 100 + k }`,
    suffixWrite: `export function f(n) {
      const z = new Float64Array(8), v = new Int32Array(8)
      for (let t = 0; t < 8; t++) { z[t] = t; v[t] = t * 3 }
      let k = 0
      while (z[k + 1] < n) k++
      const a = v[k]
      k++
      const b = v[k]
      return (a === undefined ? -1 : a) * 1000 + (b === undefined ? -1 : b) }`,
  }
  for (const optimize of levels(0, 2, 3, 'size')) for (const [name, src] of Object.entries(cases)) {
    const native = oracle(src).f, wasm = jz(src, { optimize }).exports.f
    for (const n of [-10, -3, 0, 2, 7, 20, NaN]) is(wasm(n), native(n), `${name}(${n}), O${optimize}`)
  }
})

// Loop-entry versioning owns a counted loop and a computed index: one test per
// entry beats one per pass, so the guards leave both alone.
test('sentinel guard: a counted loop and a computed index keep loop-entry versioning', () => {
  if (onKernel()) return
  const cases = {
    counted: `let buf = new Float64Array(256)
      export let f = (n) => { let i = 0, acc = 0.3
        while (i < (n | 0)) { acc = buf[i] + acc * 0.5; i = i + 1 }
        return acc }`,
    countedScan: `let a = new Int32Array(64)
      export let f = (n, x) => { let c = 0
        while (c < (n | 0) && a[c] !== x) c++
        return c }`,
    computed: `let img = new Float64Array(4096)
      export let f = (W, H) => { let w = W | 0, h = H | 0, py = 0, s = 0.0
        while (py < h) { let qx = 0
          while (qx < w) { let idx = py * w + qx; s = s + img[idx]; qx = qx + 1 }
          py = py + 1 }
        return s }`,
  }
  for (const [name, src] of Object.entries(cases))
    is(compile(src, { optimize: 'speed', wat: true }), compile(src, { optimize: GUARDS_OFF, wat: true }), name)
})
