// A loop is compiled twice (src/optimize/specialize.js): a copy for reads that hit
// and integers that are integers, where the values are carried in integer registers,
// and the loop as written for everything else. A read that misses leaves the copy
// for the loop as written, which goes on from the first statement of the stretch
// the read is in: what the round stored before is not stored again. Every value
// is a differential against the host, over arguments that stay in the arrays and
// arguments that leave them; the WAT shows the copy.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { agree, oracle, run, wat } from './util.js'
import { belowOpt } from './_matrix.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { specializeLoops } from '../src/optimize/specialize.js'
import { narrowInts } from '../src/optimize/int-narrow.js'

const count = (text, op) => (text.match(new RegExp(`\\(${op.replace('.', '\\.')}[\\s)]`, 'g')) || []).length
const copies = (text) => (text.match(/\(loop \$[^\s)]*\.f\d+[\s)]/g) || []).length
const shapes = (src, check) => { if (!belowOpt(2)) check(wat(src)) }
const SIZES = [0, 1, 2, 3, 5, 7, 16, 100]
const ANY = [...SIZES, -1, -3, 0.5, 2.75, NaN, -0, 1e9]

test('specialize: impossible byte extents do not hide reachable nested loops', () => {
  for (const ctor of ['Int32Array', 'Float32Array', 'Float64Array']) {
    const src = `export function f(n, view) {
      const storage = new ${ctor}(n + 2)
      const a = view ? storage.subarray(1, n + 1) : new ${ctor}(n); a[0] = 3
      let s = 0
      for (let r = 0; r < 3; r++) {
        let j = 0
        for (let i = 0; i < n; i++) { s += a[j]; j = (j + 1) & 2147483647 }
      }
      return s
    }`
    shapes(src, w => ok(copies(w) > 0, `${ctor}: reachable loops retain integer copies`))
    const actual = run(src), expected = oracle(src)
    for (const n of [0, 1, 8, 8, 3.5, NaN, 2, 8, -0]) for (const view of [false, true])
      ok(Object.is(actual.f(n, view), expected.f(n, view)), `${ctor}, view=${view}, length=${n}`)
  }
})

test('specialize: nested copies restore all live values on outward branches', () => {
  const condition = `(f64.gt (local.tee $p (f64.convert_i32_s
    (i32.rem_s (i32.trunc_sat_f64_s (f64.add (local.get $p) (f64.const 3)))
      (i32.const 7)))) (local.get $x))`
  for (const jump of [`(br_if $out ${condition})`, `(if ${condition} (then (br $out)))`]) {
    const ast = parseWat(`(module
      (func $f (export "f") (param $x f64) (param $n f64) (result f64)
        (local $k i32) (local $i f64) (local $s f64) (local $p f64)
        (local.set $s (local.get $x))
        (local.set $p (f64.const 7))
        (block $out (block $end (loop $outer
          (br_if $end (i32.ge_s (local.get $k) (i32.const 3)))
          (local.set $i (f64.const 0))
          (block $stop (loop $inner
            (br_if $stop (i32.eqz (f64.lt (local.get $i) (local.get $n))))
            (br_if $out (f64.lt (local.get $x) (f64.const 0)))
            ${jump}
            (local.set $s (f64.add (local.get $s) (local.get $p)))
            (local.set $i (f64.add (local.get $i) (f64.const 1)))
            (br $inner)))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $outer))))
        (f64.add (f64.mul (local.get $s) (f64.const 10)) (local.get $p))))`)
    const instantiate = () => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f
    const before = instantiate(), fn = ast.find(n => n[0] === 'func')
    const assumptions = specializeLoops(fn)
    ok(JSON.stringify(fn).includes('.f0.f1'), 'the regression exercises a copy inside another copy')
    const copied = instantiate()
    narrowInts(fn, assumptions)
    const narrowed = instantiate()
    for (const [x, n] of [[0, 6], [0, 6], [4, 3], [20, 5], [0, 0], [0, -1], [0, 6],
      [-1, 1], [0.5, 2.5], [-0, 1], [NaN, 3], [3, NaN], [Infinity, 1]]) {
      ok(Object.is(copied(x, n), before(x, n)), `copy: ${x}, ${n}`)
      ok(Object.is(narrowed(x, n), before(x, n)), `narrowed: ${x}, ${n}`)
    }
    is(narrowed(0, 6), 3, 'the first taken branch publishes its tee assignment')
  }
})

test('specialize: labelled break and continue keep nested copy state across calls', () => {
  for (const jump of ['break', 'continue']) {
    const source = `export function f(x,n) { let s=x,p=0
      out: for(let k=0;k<3;k++) { for(let i=0;i<n;i++) {
        p=(p+3)%7; if(p>x) ${jump} out; s+=p
      }} return s*10+p }`
    const actual = run(source), expected = oracle(source)
    for (const [x, n] of [[0, 6], [0, 6], [4, 3], [20, 5], [0, 0], [0, -1], [0, 6], [0.5, 2.5]])
      is(actual.f(x, n), expected.f(x, n), `${jump}, ${x}/${n}`)
  }
})

test('specialize: a counter that starts from a number', () => {
  const src = `export function f(n) {
  const a = new Int32Array(16)
  for (let e = n - 1; e >= 0; e--) { const base = e - e % 3, end = base + (e + 1) % 3; a[e & 15] += end }
  let s = 0
  for (let i = 0; i < 16; i++) s = s * 3 + a[i]
  return s
}`
  shapes(src, w => {
    ok(copies(w) >= 1, 'the loop has a copy')
    ok(count(w, 'i64.rem_s') + count(w, 'i32.rem_s') >= 2, 'its remainders are the integers\'')
  })
  for (const n of [...SIZES, -1, 0.5, 2.75, NaN, -0, 1000.5]) agree(src, 'f', [n])
})

test('specialize: an index read from an array, until it leaves', () => {
  const src = `export function f(n, to) {
  const m = (n & 15) + 16
  const next = new Int32Array(m), v = new Int32Array(m)
  for (let i = 0; i < m; i++) { next[i] = i + 1; v[i] = i * i - 40 }
  next[m - 1] = -1
  next[7] = to
  let s = 0, steps = 0
  for (let o = 0; o !== -1 && steps < 50; o = next[o], steps++) s = s * 3 + v[o] + (o % 3)
  return s
}`
  shapes(src, w => ok(copies(w) >= 1, 'the loop has a copy'))
  for (const n of [0, 5, 15]) for (const to of [8, 0, 3, -1, -2, 16, 31, 32, 1000, 2147483647, -2147483648]) agree(src, 'f', [n, to])
})

test('specialize: what the copy counted goes on where a read leaves', () => {
  const src = `export function f(n, bad) {
  const m = (n & 15) + 16
  const idx = new Int32Array(m), v = new Float64Array(m), w = new Int32Array(m)
  for (let i = 0; i < m; i++) { idx[i] = (i * 7) % m; v[i] = i / 8; w[i] = i * 3 }
  idx[bad & 31] = m + (bad >> 5)
  let s = 0, k = 0, last = -1, seen = 0
  for (let i = 0; i < m; i++) {
    const j = idx[i], x = v[j], y = w[j]
    if (x === undefined) { seen++; continue }
    k += y % 5
    last = j
    s = s * 1.25 + x + y
  }
  return s + k * 1000 + last * 1e6 + seen * 1e9
}`
  for (const n of [0, 3, 15]) for (const bad of [0, 1, 9, 31, 40, 100, 1000]) agree(src, 'f', [n, bad])
})

test('specialize: reads after a store in their iteration', () => {
  const src = `export function f(n) {
  const m = (n & 15) + 16
  const flags = new Uint8Array(m), members = new Int32Array(m), orig = new Int32Array(m), out = new Float32Array(m * 4)
  for (let i = 0; i < m; i++) { members[i] = (i * 7 + n) % m; orig[i] = (i * 5) % m; flags[i] = i & 3 }
  let s = 0
  for (let i = 0; i < m; i++) {
    const f = members[i] / 3 | 0
    let k = 0
    for (let j = 0; j < m; j++) if (flags[j] & 1) members[k++] = j
    const corner = members[i]
    const dst = (orig[f] * 3 + corner % 3) * 4
    out[dst] = k
    s += dst + flags[f] + out[dst + 1]
  }
  return s
}`
  for (const n of SIZES) agree(src, 'f', [n])
})

test('specialize: an index taken before its source moved on', () => {
  const src = `export function f(n, step) {
  const m = (n & 15) + 16
  const v = new Int32Array(m), out = new Int32Array(m)
  for (let i = 0; i < m; i++) v[i] = i * 3 - 7
  let x = n & 7, s = 0
  for (let k = 0; k < m; k++) {
    out[k] = k
    const t = x
    x = x * step + 1
    if (x > m + 9) x = x % 5
    const a = v[t], b = v[x]
    s = (s * 3 + (a === undefined ? 1000 : a) + (b === undefined ? 5000 : b)) | 0
  }
  return s + out[m - 1]
}`
  for (const n of [0, 3, 9]) for (const step of [1, 2, 5, 7]) agree(src, 'f', [n, step])
})

test('specialize: a read an earlier test keeps from an index it does not take', () => {
  const src = `export function f(n) {
  const m = (n & 15) + 16
  const next = new Int32Array(m), v = new Int32Array(m)
  for (let i = 0; i < m; i++) { next[i] = i % 4 === 3 ? -1 : (i + n) % m; v[i] = i * 3 }
  let s = 0
  for (let i = 0; i < m; i++) {
    const o = next[i]
    v[i] = s & 1023
    if (o < 0) continue
    s += v[o] + o % 3
  }
  return s
}`
  for (const n of SIZES) agree(src, 'f', [n])
})

test('specialize: loops in a loop that stores, each with a copy of its own', () => {
  const src = `export function f(n) {
  const m = (n & 15) + 16
  const tv = new Int32Array(m * 3), done = new Uint8Array(m * 3), nb = new Int32Array(m * 3), stack = new Int32Array(m + 1), group = new Int32Array(m)
  for (let i = 0; i < m * 3; i++) { tv[i] = (i * 5 + n) % m; nb[i] = i % 7 === 0 ? -1 : (i * 11 + 3) % m }
  let s = 0
  for (let seed = 0; seed < m * 3; seed++) {
    if (done[seed]) continue
    const rep = tv[seed]
    let size = 0, sp = 0
    stack[sp++] = seed / 3 | 0
    while (sp) {
      const f = stack[--sp], base = f * 3
      const c = tv[base] === rep ? 0 : tv[base + 1] === rep ? 1 : 2
      const corner = base + c
      if (done[corner]) continue
      done[corner] = 1
      if (size < m) group[size++] = corner
      const left = nb[corner], right = nb[base + (c + 2) % 3]
      if (right >= 0 && sp < m) stack[sp++] = right
      if (left >= 0 && sp < m) stack[sp++] = left
    }
    for (let i = 0; i < size; i++) { const corner = group[i]; s = (s * 31 + corner % 3 + tv[corner - corner % 3] + (corner / 3 | 0)) | 0 }
  }
  return s
}`
  shapes(src, w => ok(copies(w) >= 2, 'the loops have copies'))
  for (const n of SIZES) agree(src, 'f', [n])
})

test('specialize: a branch that leaves past the loop, and what is read after it', () => {
  const src = `export function f(n, stop) {
  const m = (n & 15) + 16
  const a = new Int32Array(m), b = new Int32Array(m)
  for (let i = 0; i < m; i++) { a[i] = (i * 7 + n) % (m + 2); b[i] = i * 2 - 5 }
  let s = 0, last = 0.5, hits = 0
  outer: for (let r = 0; r < 4; r++) {
    b[r] = s & 255
    for (let i = r; i < m; i++) {
      const j = a[i], x = b[j]
      if (x === undefined) { hits++; continue outer }
      if (j === stop) break outer
      last = j * 3 + 1
      s = s * 3 + x % 7
    }
    s += last
  }
  return s + last * 1e6 + hits * 1e9
}`
  for (const n of [0, 3, 14, 15]) for (const stop of [-1, 0, 5, 17]) agree(src, 'f', [n, stop])
})

test('specialize: a return inside the copy', () => {
  const src = `export function f(n, want) {
  const m = (n & 15) + 16
  const a = new Int32Array(m)
  for (let i = 0; i < m; i++) a[i] = (i * 7 + n) % m
  let at = n & 3, steps = 0
  while (steps < 40) {
    const v = a[at]
    if (v === want) return at * 100 + steps
    if (v === undefined) return -1 - steps
    at = v + (steps & 1) * m
    steps++
  }
  return -1000
}`
  for (const n of [0, 5, 15]) for (const want of [0, 3, 9, 100]) agree(src, 'f', [n, want])
})

test('specialize: floats that are no integers keep the loop as written', () => {
  const src = `export function f(n, start) {
  const m = (n & 15) + 16
  const v = new Float32Array(m)
  for (let i = 0; i < m; i++) v[i] = i / 4
  let s = 0
  for (let x = start; x < m; x += 1) s = s * 1.5 + v[x | 0] + x % 3
  return s
}`
  for (const n of [0, 7]) for (const start of ANY) agree(src, 'f', [n, start])
})

// The loop as written goes on in the middle of a round: a store the copy made
// is made once, a count it stepped is stepped once.
test('specialize: a read that leaves after the round has stored', () => {
  const src = `export function f(n, bad) {
  const m = 16, a = new Int32Array(m), b = new Float64Array(m), idx = new Int32Array(m)
  for (let i = 0; i < m; i++) { idx[i] = (i * 5) % m; b[i] = i / 4 }
  idx[bad & 15] = m + (bad >> 4)
  let s = 0, steps = 0
  for (let i = 0; i < n; i++) {
    const j = idx[i & 15]
    a[i & 15] = i
    steps++
    const x = b[j]
    a[(i + 1) & 15] += 1
    const y = a[j]
    const z = b[j + 1]
    s = s * 1.0001 + (x === undefined ? -1 : x) + (y === undefined ? -2 : y) + (z === undefined ? -3 : z)
  }
  return s + a[3] * 1000 + steps * 1e6
}`
  shapes(src, w => ok(copies(w) >= 1, 'the loop has a copy'))
  for (const n of [0, 1, 5, 16, 40]) for (const bad of [0, 3, 15, 16, 100, 255]) agree(src, 'f', [n, bad])
})

test('specialize: a count stepped inside the statement that reads', () => {
  const src = `export function f(n, deep) {
  const st = new Int32Array(8), v = new Float64Array(8)
  for (let i = 0; i < 8; i++) { st[i] = i * 3 - 4; v[i] = i + 0.5 }
  let sp = deep, s = 0, r = 0
  while (sp > 0 && r++ < n) {
    s = s * 3 + st[--sp] + (v[sp + 3] === undefined ? 1000 : v[sp + 3])
    if (s > 1e6) s %= 97
  }
  return s + sp * 1e7
}`
  for (const n of [0, 1, 4, 12]) for (const deep of [0, 1, 5, 8, 9, 12, -1]) agree(src, 'f', [n, deep])
})

test('specialize: reads under a test, after a store, in either arm', () => {
  const src = `export function f(n, bad) {
  const m = 16, a = new Int32Array(m), b = new Int32Array(m), c = new Float32Array(m)
  for (let i = 0; i < m; i++) { a[i] = (i * 11 + 3) % m; b[i] = i * i; c[i] = i / 2 }
  a[bad & 15] = m + 1 + (bad >> 4)
  let s = 0
  for (let i = 0; i < n; i++) {
    const j = a[i & 15]
    c[i & 15] = s
    if (i & 1) {
      b[(i + 3) & 15] = i
      const x = b[j]
      s += x === undefined ? 7 : x
    } else {
      const y = c[j]
      b[i & 15] += 2
      s += (y === undefined ? 9 : y) + b[j & 15]
    }
    s = s % 100003
  }
  return s + b[5] + c[6]
}`
  for (const n of [0, 2, 9, 33]) for (const bad of [0, 1, 6, 15, 16, 47]) agree(src, 'f', [n, bad])
})

// An index a test computes on its way: the local it sets is set where the
// read leaves as well.
test('specialize: an index set inside the test of its read', () => {
  const src = `export function f(n) {
  const a = new Float64Array(8)
  for (let i = 0; i < 8; i++) a[i] = i * 1.5
  let s = 0
  for (let i = 0; i < n; i++) { const k = a[(i * 7) % 11]; s += k === undefined ? 100 : k }
  return s
}`
  for (const n of [0, 1, 3, 8, 30]) agree(src, 'f', [n])
})

// A value tested for its kind before the runtime is asked: the copy keeps
// the arm a number takes, the loop as written has the other.
test('specialize: a key that stops being an index', () => {
  const src = `export function f(n, to) {
  const m = 16, next = new Int32Array(m), tv = new Int32Array(m), nb = new Int32Array(m)
  for (let i = 0; i < m; i++) { next[i] = i % 5 === 4 ? -1 : (i * 3 + 1) % m; tv[i] = (i * 7) % 5; nb[i] = -1 }
  next[6] = to
  let found = 0
  for (let e = 0; e < n; e++) {
    if (nb[e & 15] !== -1) continue
    const a = tv[e & 15], b = tv[(e + 1) & 15]
    let steps = 0
    for (let other = next[e & 15]; other !== -1 && steps < 20; other = next[other], steps++) {
      if (nb[other] !== -1) continue
      const obase = other - other % 3
      if (a === tv[obase + (other + 1) % 3] && b === tv[other]) {
        nb[e & 15] = obase / 3
        nb[other] = e
        found++
        break
      }
    }
  }
  let s = found
  for (let i = 0; i < m; i++) s = s * 3 + nb[i]
  return s
}`
  for (const n of [0, 4, 16, 30]) for (const to of [2, -1, 15, 16, 40, -7]) agree(src, 'f', [n, to])
})

// A read is a number where the emitter marked it one (a typed element): an
// array's slot holds any value, and a hole reads as undefined inside the array.
test('specialize: the slots of an array hold any value, a hole among them', () => {
  const src = `export function f(n) {
  const a = new Array(8), b = [1, 'x', null, undefined, 2.5, -0, NaN, 7]
  a.length = 9
  a[3] = 5
  a[8] = 'end'
  let holes = 0, strings = 0, s = 0
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i], z = a[i + 1]
    if (x === undefined) holes++
    if (typeof y === 'string') strings++
    if (z !== undefined && typeof z !== 'string') s += z
    if (y === null) s += 100
  }
  return holes * 10000 + strings * 1000 + s
}`
  for (const n of [0, 3, 8, 9, 12]) agree(src, 'f', [n])
  const holes = `let a = []
  export function f(count) {
    a = new Array(count)
    a.length = count + 1
    for (let i = 0; i <= count; i++) if (a[i] !== undefined) return -1 - i
    a[count] = 31
    let s = 0
    for (let i = 0; i <= count; i++) s = s * 3 + (a[i] === undefined ? 1 : a[i])
    return s
  }`
  for (const count of [0, 1, 4, 5, 16, 17]) agree(holes, 'f', [count])
})

// A loop the emitter versioned on its extents keeps its checked twin in the
// loop as written alone: the copy leaves where the extents fail.
test('specialize: extents that fail inside a copy', () => {
  const src = `export function f(n, len) {
  const a = new Float64Array(len), idx = new Int32Array(8), seen = new Int32Array(8)
  for (let i = 0; i < len; i++) a[i] = i + 0.5
  for (let i = 0; i < 8; i++) idx[i] = (i * 3) % 8
  let s = 0
  for (let r = 0; r < n; r++) {
    const m = idx[r & 7] + r
    seen[r & 7] += 1
    let t = 0
    for (let j = 0; j < m; j++) t += a[j] === undefined ? 100 : a[j]
    const x = a[idx[r & 7] * 3], y = a[seen[(r + 1) & 7] + m]
    s = s * 1.01 + t + (x === undefined ? 7 : x) + (y === undefined ? 9 : y)
  }
  return s + seen[3] * 1e6
}`
  shapes(src, w => ok(copies(w) >= 1, 'the loop has a copy'))
  for (const n of [0, 1, 5, 9, 20]) for (const len of [0, 4, 12, 24, 64]) agree(src, 'f', [n, len])
})

// The twin is no gain of the copy's own: the arm the extents choose runs as fast
// in the loop as written. A loop that would leave by its twin alone keeps its one
// form, and the loop inside it its one vector body.
test('specialize: a versioned loop alone buys no copy', () => {
  const src = `let fold = (re, n) => {
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half
        const x = re[b]
        re[b] = re[a] - x
        re[a] = re[a] + x
      }
    }
  }
}
export function f(n) {
  const N = n | 0
  const re = new Float64Array(N)
  for (let i = 0; i < N; i++) re[i] = (i * 37) % 11 - 5.5
  fold(re, N)
  let h = 0
  for (let i = 0; i < N; i++) h = h * 3 + re[i]
  return h
}`
  shapes(src, w => ok(copies(w) === 0, 'the loops have their one form'))
  for (const n of [0, 1, 2, 3, 4, 8, 64, 100]) agree(src, 'f', [n])
})
