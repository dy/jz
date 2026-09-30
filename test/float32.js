// Float arithmetic written as `Math.fround` of an operator over `Math.fround`s
// runs in single precision (src/optimize/float32.js, pass `narrowFloat32`): the
// operator is the single one and the conversions around it are gone, a local
// that only ever holds a single is one. Rounding the double result of `+`, `-`,
// `*`, `/` or `sqrt` over two singles gives what the single operator gives
// (Figueroa, "When is double rounding innocuous?", SIGNUM Newsletter 30(3),
// 1995: the wide format holds 2p + 2 bits, 53 ≥ 2·24 + 2), so every form answers
// what the host answers, to the bit. The reference is the host itself: each
// kernel runs under Node over the same inputs.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, funcWat, oracle, run, wat } from './util.js'

const HEAD = 'var f32 = Math.fround\n'
const kernels = {
  mul: 'export let f = (x, y) => f32(f32(x) * f32(y))',
  add: 'export let f = (x, y) => f32(f32(x) + f32(y))',
  sub: 'export let f = (x, y) => f32(f32(x) - f32(y))',
  div: 'export let f = (x, y) => f32(f32(x) / f32(y))',
  'a constant operand': 'export let f = (x, y) => f32(f32(1 / f32(x)) + f32(f32(y) * 0.5))',
  'a constant no single holds': 'export let f = (x, y) => f32(f32(x) * 0.1) + f32(f32(y) / 3)',
  sqrt: 'export let f = (x, y) => f32(Math.sqrt(f32(f32(x) + f32(y))))',
  'abs, neg, floor, ceil, trunc': 'export let f = (x, y) => f32(Math.abs(f32(x))) + f32(-f32(y)) * 2 + f32(Math.floor(f32(x))) * 4 + f32(Math.ceil(f32(y))) * 8 + f32(Math.trunc(f32(x)))',
  'min and max': 'export let f = (x, y) => f32(Math.min(f32(x), f32(y))) - f32(Math.max(f32(x), f32(y))) * 2',
  'locals that hold singles': 'export let f = (x, y) => { x = f32(x); y = f32(y); return f32(Math.sqrt(f32(f32(x * x) + f32(y * y)))) }',
  'a local read as a double too': 'export let f = (x, y) => { const a = f32(x), b = f32(y); const c = f32(a * b); return c > 1 ? f32(c - a) + a * 2 : f32(c + b) }',
  'a local defined in arms': 'export let f = (x, y) => { let a; if (x > y) a = f32(x); else a = f32(f32(y) * 2); return f32(a * a) + f32(a / 3) }',
  'a local carried by a loop': 'export let f = (x, y) => { let s = f32(0); const d = f32(y); for (let i = 0; i < 5; i++) s = f32(s * d + f32(x)); return s }',
  'a sum of doubles rounded once': 'export let f = (x, y) => f32(x * y + x)',
  'an operator over one single and one double': 'export let f = (x, y) => f32(f32(x) * y)',
}
const EDGES = [0, -0, 1, -1, 0.5, 3, 0.1, 1 / 3, NaN, Infinity, -Infinity,
  1.401298464324817e-45, 1.1754943508222875e-38, 3.4028234663852886e+38, 3.4028235677973366e+38, 1e39, -1e39, 1e-46,
  16777216, 16777217, 16777219, 1.0000001192092896, 1.00000017881393432617, 0.99999994039535522461, 123456.789, -7.25e-7, 2 ** 52 + 1, 5e-324]

test('float32: the single operator answers what the double one rounded answers', () => {
  for (const [name, body] of Object.entries(kernels)) {
    const src = HEAD + body, host = oracle(src)
    for (const optimize of levels(0, 2, 3)) {
      const m = run(src, { optimize })
      let bad = 0, first = ''
      for (const x of EDGES) for (const y of EDGES) {
        const want = host.f(x, y), got = m.f(x, y)
        if (!Object.is(got, want) && !(got !== got && want !== want)) { if (!bad++) first = `f(${x}, ${y}) = ${got}, the host answers ${want}` }
      }
      is(bad, 0, `${name} at ${optimize}${first && ': ' + first}`)
    }
  }
})

test('float32: the same over the numbers between', () => {
  // a multiplicative generator's numbers, spread over the singles' exponents
  let s = 0x2545f491
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296 }
  const xs = Array.from({ length: 400 }, () => (next() - 0.5) * 2 ** Math.floor((next() - 0.5) * 80))
  for (const [name, body] of Object.entries(kernels)) {
    const src = HEAD + body, host = oracle(src)
    for (const optimize of levels(2, 3)) {
      const m = run(src, { optimize })
      let bad = 0, first = ''
      for (let i = 0; i + 1 < xs.length; i++) {
        const want = host.f(xs[i], xs[i + 1]), got = m.f(xs[i], xs[i + 1])
        if (!Object.is(got, want) && !(got !== got && want !== want)) { if (!bad++) first = `f(${xs[i]}, ${xs[i + 1]}) = ${got}, the host answers ${want}` }
      }
      is(bad, 0, `${name} at ${optimize}${first && ': ' + first}`)
    }
  }
})

test('float32: the operator runs on singles', () => {
  if (belowOpt(2)) return
  const count = (s, re) => (s.match(re) || []).length
  const of = (body, opts) => funcWat(wat(HEAD + body, { optimize: 2, ...opts }), 'f')
  const mul = of(kernels.mul)
  is(count(mul, /f32\.mul/g), 1, 'a product of singles is a single product')
  is(count(mul, /f64\.mul/g), 0)
  is(count(mul, /f64\.promote_f32/g), 1, 'one widening, of the result')
  const hyp = of(kernels['locals that hold singles'])
  is(count(hyp, /f64\.(mul|add|sqrt)/g), 0, 'a local that holds a single is read as one')
  ok(count(hyp, /f32\.sqrt/g) === 1 && count(hyp, /f32\.mul/g) === 2 && count(hyp, /f32\.add/g) === 1, 'the root of a sum of squares, in singles')
  is(count(hyp, /f64\.promote_f32/g), 1)
  is(count(of(kernels['a constant operand']), /f64\.(mul|div|add)/g), 0, 'a constant a single holds is that single')
  ok(count(of(kernels['a constant no single holds']), /f64\.mul/g) === 1, 'a constant no single holds keeps its double product')
  is(count(of(kernels['a sum of doubles rounded once']), /f32\.(mul|add)/g), 0, 'an operator over doubles stays one')
  is(count(of(kernels['an operator over one single and one double']), /f32\.mul/g), 0, 'and over one double')
  is(count(of(kernels.mul, { optimize: { level: 2, narrowFloat32: false } }), /f32\.mul/g), 0, 'the pass is what does it')
})

// Then the pass's second half: a local every write of which holds an exact single, or one
// rounding step whose every read only rounds it, is an f32 local (src/optimize/float32.js
// narrowLocals). Every value is a differential against the host, bit for bit through
// Float32Array storage; the WAT shows the arithmetic's width.
// The kernel is the module's only user code: the counts are over the module. The
// shapes hold once the optimizer ran; every leg runs the differentials.
const count = (text, op) => (text.match(new RegExp(`\\(${op.replace('.', '\\.')}[\\s)]`, 'g')) || []).length
const shapes = (src, check) => { if (!belowOpt(2)) check(wat(src)) }

// Pseudo-random f32 values in [-1, 1) and the exact bits of a Float32Array, as an
// i32 hash both sides compute alike (Math.imul steps stay exact past 2^53).
const FILL = `
  let s = seed | 0
  for (let i = 0; i < a.length; i++) { s = (Math.imul(s, 1103515245) + 12345) | 0; a[i] = (s >> 8) / 8388608 }`
const HASH = `
  const u = new Uint32Array(out.buffer, out.byteOffset, out.length)
  let h = 0
  for (let i = 0; i < u.length; i++) h = (h * 31 + u[i]) | 0
  return h`
const SEEDS = [1, 7, 123456789]

test('float32: a projection in f32, its scale applied and stored', () => {
  const src = `const fround = Math.fround
function dot(ax, ay, az, bx, by, bz) { return fround(fround(fround(ax * bx) + fround(ay * by)) + fround(az * bz)) }
function proj(target, off, x, y, z, nx, ny, nz) {
  const d = dot(x, y, z, nx, ny, nz)
  x = fround(x - fround(d * nx))
  y = fround(y - fround(d * ny))
  z = fround(z - fround(d * nz))
  if (Math.abs(x) > 1.1754943508222875e-38 || Math.abs(y) > 1.1754943508222875e-38 || Math.abs(z) > 1.1754943508222875e-38) {
    const s = fround(1 / fround(Math.sqrt(dot(x, y, z, x, y, z))))
    x *= s; y *= s; z *= s
  }
  target[off] = x; target[off + 1] = y; target[off + 2] = z
}
export function f(n, seed) {
  const a = new Float32Array(n * 3), out = new Float32Array(n * 3)${FILL}
  const nx = a[0], ny = a[1], nz = a[2]
  for (let i = 0; i < n; i++) proj(out, i * 3, a[i * 3], a[i * 3 + 1], a[i * 3 + 2], nx, ny, nz)${HASH}
}`
  shapes(src, w => {
    ok(count(w, 'f32.mul') >= 6, 'the products compute in f32')
    ok(count(w, 'f32.sub') >= 3 && count(w, 'f32.add') >= 2, 'the sums and differences compute in f32')
    ok(count(w, 'f32.sqrt') >= 1, 'the length computes in f32')
    ok(count(w, 'f32.gt') >= 3, 'the zero tests compare in f32')
  })
  for (const n of [0, 1, 2, 17, 100]) for (const seed of SEEDS) agree(src, 'f', [n, seed])
})

test('float32: a product rounded early when every read rounds it', () => {
  const src = `const fround = Math.fround
export function f(n, seed) {
  const a = new Float32Array(n), out = new Float32Array(n)${FILL}
  for (let i = 0; i < n; i++) {
    const sx = fround(a[i] * 3), scale = fround(1 / fround(a[i] + 2))
    out[i] = sx * scale
  }${HASH}
}`
  shapes(src, w => {
    ok(count(w, 'f32.mul') >= 2, 'the store value computes in f32')
  })
  for (const n of [0, 1, 5, 64]) for (const seed of SEEDS) agree(src, 'f', [n, seed])
})

test('float32: a value whose rounding would show stays f64', () => {
  const src = `export function f(n, seed) {
  const a = new Float32Array(n), out = new Float32Array(n)${FILL}
  for (let i = 0; i < n; i++) { const y = a[i] * 3; const z = y + 1; out[i] = z }${HASH}
}`
  shapes(src, w => {
    is(count(w, 'f32.mul'), 0, 'the product stays f64: its sum reads it before the store rounds')
    is(count(w, 'f32.add'), 0, 'the sum stays f64')
  })
  for (const n of [0, 1, 5, 64]) for (const seed of SEEDS) agree(src, 'f', [n, seed])
})

test('float32: a compare against a constant the f32 format holds, and one it does not', () => {
  const src = `const fround = Math.fround
export function f(n, seed) {
  const a = new Float32Array(n), out = new Float32Array(n * 2)${FILL}
  let c = 0
  for (let i = 0; i < n; i++) {
    const x = fround(a[i] * a[i]), y = fround(a[i] + 1)
    out[i] = x; out[n + i] = y
    if (x > 0.25) c++
    if (y > 0.1) c += 2
  }
  return c
}`
  shapes(src, w => {
    ok(count(w, 'f32.gt') >= 1, '0.25 compares in f32')
    ok(count(w, 'f64.gt') >= 1, '0.1 is not an f32 value: the compare stays f64')
  })
  for (const n of [0, 1, 5, 64]) for (const seed of SEEDS) agree(src, 'f', [n, seed])
})

test('float32: a read exact by its reaching write alone, of a local that stays f64', () => {
  // The store temp copies `v` while only the constant reaches it; `v` itself
  // keeps f64 for its later sum. The copy demotes the read without loss.
  const src = `export function f(n, seed) {
  const a = new Float32Array(n), out = new Float32Array(n * 2)${FILL}
  let v = 2
  for (let i = 0; i < n; i++) {
    out[i] = v
    v = a[i] * 1.5 + 0.1
    out[n + i] = v
  }${HASH}
}`
  for (const n of [0, 1, 5, 64]) for (const seed of SEEDS) agree(src, 'f', [n, seed])
})

test('float32: a write late in a loop body reaches the read at its head', () => {
  // `prev` holds an f64 product from the previous iteration, so the product
  // under `fround` stays f64; only the first iteration sees the exact zero.
  const src = `const fround = Math.fround
export function f(n, seed) {
  const a = new Float32Array(n), out = new Float32Array(n)${FILL}
  let prev = 0
  for (let i = 0; i < n; i++) { out[i] = fround(prev * a[i]); prev = a[i] * 3 + 0.5 }${HASH}
}`
  shapes(src, w => {
    is(count(w, 'f32.mul'), 0, 'the carried product is f64 at the head of the next iteration')
  })
  for (const n of [0, 1, 2, 5, 64]) for (const seed of SEEDS) agree(src, 'f', [n, seed])
})

test('float32: the pass keeps the marks later passes read', () => {
  // A function-table call devirtualizes by a mark emit left on the call node
  // (optimize/devirt.js); the pass rewrites the function it lives in without
  // losing it, so the speed tier still lowers the call to its direct arms.
  const src = `const fround = Math.fround
const ops = [(x, k) => fround(x * k), (x, k) => fround(x + k), (x, k) => fround(k - x)]
export function f(n, sel, k) {
  const a = new Float32Array(n), out = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = i * 0.5
  for (let i = 0; i < n; i++) out[i] = ops[sel](a[i], k)
  let s = 0
  for (let i = 0; i < n; i++) s += out[i]
  return s
}`
  if (!belowOpt(3)) ok(wat(src, { optimize: 'speed' }).includes('br_table'), 'the table call keeps its direct arms')
  for (const sel of [0, 1, 2]) for (const n of [0, 1, 9]) agree(src, 'f', [n, sel, 1.5], { optimize: 'speed' })
})

test('float32: a value that may hold a BigInt box beside exact values keeps its bits', () => {
  // The unbox test copies the operand into a temp through a read node the
  // emitter places twice (the IR is a DAG): the temp holds a box or a number
  // and must stay f64, whatever the other writes of the locals it copies.
  const src = `function make(useBig) {
  let o = { field: 0 }
  if (useBig) o.field = 9223372036854775807n
  else o.field = 1
  return o
}
export let f = (useBig) => { let o = make(useBig); return String(o.field + 0n) }`
  agree(src, 'f', [1])
})

test('float32: a local written by constants alone stays f64', () => {
  // Every write of \`step\` is a constant the f32 format holds, and every read is
  // f64 arithmetic: narrowing it would add one promote a read and remove nothing.
  const src = `export function f(n, k) {
  let step = 1, s = 0
  for (let i = 0; i < n; i++) {
    if (k * i > 7.5) step = 2; else step = 0.5
    s += step * 0.1 + k
  }
  return s
}`
  shapes(src, w => {
    is(count(w, 'f64.promote_f32'), 0, 'no promote is added')
    ok(!/\(local \$\S+ f32\)/.test(w), 'no local narrows')
  })
  for (const n of [0, 1, 9, 40]) for (const k of [0.25, 1.5, -3]) agree(src, 'f', [n, k])
})

test('float32: a missing element is NaN through f32 arithmetic', () => {
  const src = `const fround = Math.fround
export function f(n, k) {
  const a = new Float32Array(n), out = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = i + 1
  for (let i = 0; i < n; i++) out[i] = fround(a[i + k] - a[i])
  let nans = 0, sum = 0
  for (let i = 0; i < n; i++) { if (out[i] !== out[i]) nans++; else sum += out[i] }
  return nans * 1000 + sum
}`
  for (const [n, k] of [[4, 0], [4, 1], [4, 3], [4, 4], [8, 5]]) agree(src, 'f', [n, k])
})
