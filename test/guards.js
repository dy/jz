// The guards of a specialized loop (src/optimize/guards.js): an index made of the
// loop's counter is tested ahead of the loop, for its first and its last round,
// and reads of one array side by side are tested by the first of them. A test
// that fails leaves for the loop as written, which answers every read as the
// host does. Every value is a differential against the host, over sizes that
// stay in the arrays and sizes that leave them; the WAT shows what was combined.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { agree, funcWat, wat } from './util.js'
import { belowOpt } from './_matrix.js'

const shapes = (src, check) => { if (!belowOpt(2)) check(funcWat(wat(src), 'f$exp') || funcWat(wat(src), 'f')) }
// The loops that hold no other loop, as text.
const innermost = (fn) => {
  const out = []
  for (let at = fn.indexOf('(loop '); at >= 0; at = fn.indexOf('(loop ', at + 1)) {
    let depth = 0, end = at
    for (; end < fn.length; end++) { if (fn[end] === '(') depth++; else if (fn[end] === ')' && --depth === 0) break }
    const body = fn.slice(at, end + 1)
    if (body.indexOf('(loop ', 1) < 0) out.push(body)
  }
  return out
}
const fewest = (fn, op) => Math.min(...innermost(fn).filter(l => l.includes(op)).map(l => (l.match(/\(br_if /g) || []).length))

test('guards: an index the counter makes, within the array and past it', () => {
  const src = `export function f(n, from) {
  const a = new Float64Array(24), idx = new Int32Array(24)
  for (let i = 0; i < 24; i++) { a[i] = i * 0.5 + 1; idx[i] = 23 - i }
  let s = 0
  for (let i = from; i < n; i++) {
    const x = a[i * 2 + 1], y = a[i + 3], z = idx[i]
    s = s * 1.5 + (x === undefined ? 100 : x) + (y === undefined ? 200 : y) + (z === undefined ? 300 : z)
  }
  return s
}`
  // one exit test is left in the loop that reads: the reads test ahead of it
  shapes(src, w => ok(fewest(w, 'f64.load') <= 1, 'the reads are tested ahead of the loop'))
  for (const n of [0, 1, 5, 11, 12, 13, 21, 24, 25, 40]) for (const from of [0, 2, 30, -1, -3]) agree(src, 'f', [n, from])
})

test('guards: a counter that runs down, and one that stops early', () => {
  const src = `export function f(n, stop) {
  const a = new Int32Array(20)
  for (let i = 0; i < 20; i++) a[i] = i * 7 - 30
  let s = 0
  for (let i = 0; i < n; i++) {
    const x = a[19 - i], y = a[i]
    if (i === stop) break
    s = (s * 3 + (x === undefined ? 5 : x) + (y === undefined ? 9 : y)) | 0
  }
  return s
}`
  for (const n of [0, 1, 19, 20, 21, 50]) for (const stop of [-1, 0, 3, 19, 20, 30]) agree(src, 'f', [n, stop])
})

test('guards: reads side by side from an index the round reads', () => {
  const src = `export function f(n, bad, at) {
  const m = 16, tv = new Int32Array(m), p = new Float32Array(m * 3 + at)
  for (let i = 0; i < m; i++) tv[i] = (i * 5 + 2) % m
  for (let i = 0; i < p.length; i++) p[i] = i / 8
  tv[bad & 15] = m + (bad >> 4)
  let s = 0
  for (let i = 0; i < n; i++) {
    const v = tv[i & 15] * 3
    const x = p[v], y = p[v + 1], z = p[v + 2]
    s = s * 1.25 + (x === undefined ? 10 : x) + (y === undefined ? 20 : y) + (z === undefined ? 30 : z)
  }
  return s
}`
  // three reads of one array: one branch leaves for all of them
  shapes(src, w => ok(fewest(w, 'f32.load') <= 3, 'the three reads share a guard'))
  for (const n of [0, 3, 16, 20]) for (const bad of [0, 7, 15, 16, 33]) for (const at of [0, -1, -2, -3, 5]) agree(src, 'f', [n, bad, at])
})

test('guards: reads side by side where only some run', () => {
  const src = `export function f(n, at) {
  const p = new Float64Array(30 + at), tv = new Int32Array(16)
  for (let i = 0; i < p.length; i++) p[i] = i * 0.25
  for (let i = 0; i < 16; i++) tv[i] = i * 2
  let s = 0
  for (let i = 0; i < n; i++) {
    const v = tv[i & 15]
    const x = p[v]
    if (i & 1) { const y = p[v + 1]; s += y === undefined ? 50 : y }
    else { const z = p[v + 2]; s += z === undefined ? 70 : z }
    s = s * 1.125 + (x === undefined ? 90 : x)
  }
  return s
}`
  for (const n of [0, 1, 2, 9, 16, 31]) for (const at of [0, 1, 2, 3, -1, -5, -29]) agree(src, 'f', [n, at])
})

test('guards: an index the loop leaves alone', () => {
  const src = `export function f(n, k) {
  const a = new Float64Array(10), b = new Int32Array(10)
  for (let i = 0; i < 10; i++) { a[i] = i + 0.5; b[i] = i * i }
  let s = 0
  for (let r = 0; r < 3; r++) {
    const base = r * 3 + k
    for (let i = 0; i < n; i++) {
      const x = a[base], y = a[base + 1], z = b[i]
      s = s * 1.5 + (x === undefined ? 1 : x) + (y === undefined ? 2 : y) + (z === undefined ? 3 : z)
    }
  }
  return s
}`
  for (const n of [0, 1, 10, 11]) for (const k of [0, 2, 3, 4, 9, -1, -7]) agree(src, 'f', [n, k])
})

// A read the program keeps within its array by a test of its index stays
// tested where it stands: a guard ahead of that test would leave on the round
// the test skips the read.
test('guards: a read a test of its index keeps from the border', () => {
  // (the labelled continue keeps the emitter from versioning the loop itself)
  const src = `export function f(n, len, off) {
  const a = new Float64Array(len), b = new Int32Array(len)
  for (let i = 0; i < len; i++) { a[i] = i * 0.5 + 1; b[i] = (i * 7) % 5 }
  let s = 0
  outer: for (let i = 0; i < n; i++) {
    const j = i + off
    const left = (j & 3) ? a[j - 1] : -1, right = (j & 3) !== 3 ? a[j + 1] : -2
    const mid = a[j], w = b[j]
    for (let k = 0; k < 2; k++) { if (w === 4 && k) continue outer; s += k }
    s = s * 1.0001 + (left === undefined ? 10 : left) + (right === undefined ? 20 : right) + (mid === undefined ? 30 : mid) * (w === undefined ? 7 : w)
  }
  return s
}`
  shapes(src, w => {
    const copy = w.slice(w.search(/\(loop \$[^\s)]*\.f\d+[\s)]/))
    const guards = (copy.slice(0, copy.indexOf('(br $loop')).match(/br_if \$[^\s)]*__sp\.f\d+a\d+/g) || []).length
    ok(guards === 2, 'the two border reads are tested where they stand, the two others ahead of the loop: ' + guards)
  })
  for (const n of [0, 1, 2, 9, 16, 17, 30]) for (const len of [16, 1, 0]) for (const off of [0, 1, 4, -1]) agree(src, 'f', [n, len, off])
})

test('guards: reads under a test of something else', () => {
  const src = `export function f(n, len) {
  const a = new Float64Array(len), flag = new Uint8Array(24)
  for (let i = 0; i < len; i++) a[i] = i + 0.25
  for (let i = 0; i < 24; i++) flag[i] = (i * 5) & 3
  let s = 0
  for (let i = 0; i < n; i++) {
    const k = flag[i % 24]
    if (k === 1) { const x = a[i], y = a[i + 1]; s += (x === undefined ? 100 : x) - (y === undefined ? 200 : y) }
    else if (k === 2) { if (s > 1e6) break; s += a[i + 2] === undefined ? 300 : a[i + 2] }
    s = s * 1.001
  }
  return s
}`
  for (const n of [0, 1, 7, 14, 15, 16, 40]) for (const len of [16, 17, 3, 0]) agree(src, 'f', [n, len])
})

// The bound a loop's counter runs to is read through the other tests the loop
// leaves by (`flag && j < n`, the emitter's short-circuit form), and an index
// the emitter keeps in a temp (`local.tee`) is the sum it stores. A test that
// equates the counter with another local, or tests an element it reads, bounds
// no index: the reads past it still take their tests ahead of the loop.
// A test on what a read answers (`pos[p + c] === 0`, the read hedged for a
// miss) bounds nothing of the address: the reads beside it in the ternary's
// arms are tested ahead of the loop like any other.
test('guards: a test on an element read shields no index made of its address', () => {
  const src = `export function f(pos, n) {
  if (!(pos instanceof Float32Array)) throw new TypeError('x')
  const bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length), result = new Int32Array(n)
  for (let v = 0; v < n; v++) {
    const p = v * 3
    let h = 2166136261
    for (let c = 0; c < 3; c++) h = Math.imul(h ^ (pos[p + c] === 0 ? 0 : bits[p + c]), 16777619)
    result[v] = h
  }
  return result[0] + result[n - 1]
}`
  shapes(src, w => ok(fewest(w, 'i32.load') <= 1, 'the bit reads are tested ahead of the loop'))
  const pos = n => { const a = new Float32Array(n * 3); for (let i = 0; i < a.length; i++) a[i] = i % 4 === 0 ? 0 : i * 0.5; return a }
  for (const n of [0, 1, 4, 9]) for (const m of [n, n + 1, Math.max(0, n - 1)]) agree(src, 'f', [pos(m), n])
})

// An inlined callee's reads index through temps the emitter tees inside the
// guard's test: a guard that merges into its neighbour, or goes ahead of the
// loop, keeps those assignments, the reads after it depend on them.
test('guards: the temps a removed test tees stay assigned', () => {
  const src = `const a = [], b = [], out = [0, 0, 0]
for (let i = 0; i < 64; i++) { a.push([i, i + 1, i + 2, i + 3]); b.push([i * 2, 1, 2, 3]) }
const dot = (p, q) => { let s = 0; for (let k = 0; k < 4; k++) { s += p[k] * q[k]; s += p[3 - k] - q[3 - k] } out[0] = s; return s + out[0] }
export const f = (n) => { let acc = 0; for (let i = 0; i < n; i++) acc += dot(a[i], b[i]); return acc }`
  for (const n of [0, 1, 3, 64]) agree(src, 'f', [n])
})

test('guards: a counter bounded beside a flag, read through a temp, past a test that bounds nothing', () => {
  const src = `export function f(n, len, flag) {
  const a = new Float64Array(len), m = new Uint8Array(32)
  for (let i = 0; i < len; i++) a[i] = i + 0.5
  for (let i = 0; i < 32; i++) m[i] = (i * 5) % 3
  let s = 0
  for (let i = 0; i < 4; i++) {
    for (let j = 0; flag && j < n; j++) {
      const q = j * 6
      if (i === j || m[j & 31]) continue
      const x = a[q] * 2 + a[q + 1] * 3 + a[q + 2] * 5, y = a[q + 3] * 7 + a[q + 4] * 11 + a[q + 5] * 13
      s += (x === x ? x : 100) + (y === y ? y : 1000)
    }
  }
  return s
}`
  shapes(src, w => ok(fewest(w, 'f64.load') <= 3, 'no read tests in the loop: its exit, its skips'))
  for (const n of [0, 1, 3, 5]) for (const len of [30, 29, 12, 0]) for (const flag of [1, 0]) agree(src, 'f', [n, len, flag])
})
