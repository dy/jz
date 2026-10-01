// TypedArray.prototype.set, copyWithin and the copy constructor: a source of the
// same byte layout is one memory.copy (module/typedarray.js sameBytes: the same
// kind, or two plain integer kinds of one width), another kind converts element
// by element, a kind unknown at compile time decides on its aux byte at runtime.
// .set throws the RangeError of an offset outside the receiver.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { oracle, run, wat, funcWat } from './util.js'

const KINDS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']
// Every same-bytes pair besides the identity, and the conversions around them.
const PAIRS = [['Int8Array', 'Uint8Array'], ['Uint8Array', 'Int8Array'], ['Uint8Array', 'Uint8ClampedArray'], ['Uint8ClampedArray', 'Uint8Array'],
  ['Uint8ClampedArray', 'Int8Array'], ['Int16Array', 'Uint16Array'], ['Uint16Array', 'Int16Array'], ['Int32Array', 'Uint32Array'], ['Uint32Array', 'Int32Array'],
  ['Float32Array', 'Float64Array'], ['Float64Array', 'Float32Array'], ['Float64Array', 'Int32Array'], ['Int32Array', 'Float64Array'], ['Uint8Array', 'Float32Array'],
  ['Int16Array', 'Uint8Array'], ['Float32Array', 'Int8Array']]

// A checksum exact in f64 for the values seed writes (multiples of 1/8 below 2^32).
const pre = `
const sum = (a) => { let h = 0; for (let i = 0; i < a.length; i++) h = (h * 31 + a[i]) % 1000003; return h }
const seed = (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37) % 19 - 9 + i / 8 + (i % 7 === 0 ? 300 : 0) + (i === 5 ? 4e9 : 0); return a }
const pick = (k, n) => [${KINDS.map(K => `new ${K}(n)`).join(', ')}, new Float32Array(2 * n).subarray(n, 2 * n), new Int32Array(3 * n).subarray(n, 2 * n)][k % 11]
`
const staticSet = [...KINDS.map(K => [K, K]), ...PAIRS].map(([D, S]) =>
  `export let set_${D}_${S} = () => { const a = new ${D}(37), b = seed(new ${S}(37)); a.set(b); a.set(b.subarray(3, 9), 31); return sum(a) }`).join('\n')
const staticCtor = [...KINDS.map(K => [K, K]), ...PAIRS].map(([D, S]) =>
  `export let ctor_${D}_${S} = () => sum(new ${D}(seed(new ${S}(37))))`).join('\n')
// `T.from` of a typed array lists its elements: the constructor's copy.
const staticFrom = [...KINDS.map(K => [K, K]), ...PAIRS].map(([D, S]) =>
  `export let from_${D}_${S} = () => sum(${D}.from(seed(new ${S}(37))))`).join('\n')
const src = `${pre}${staticSet}\n${staticCtor}\n${staticFrom}
export let fromView = () => sum(Float64Array.from(seed(new Float32Array(50)).subarray(13, 50))) + sum(Int16Array.from(seed(new Float64Array(9)).subarray(2)))
export let views = () => { const a = new Float32Array(80).subarray(20, 57), b = seed(new Float32Array(50).subarray(13, 50)); a.set(b); return sum(a) }
export let overlapUp = () => { const a = seed(new Int32Array(37)); a.set(a.subarray(0, 30), 7); return sum(a) }
export let overlapDown = () => { const a = seed(new Int32Array(37)); a.set(a.subarray(7), 0); return sum(a) }
export let fromArray = () => { const a = new Int16Array(9); a.set([1.5, -2.5, 300, 4e9], 2); return sum(a) }
export let emptyAtEnd = () => { const a = seed(new Uint8Array(9)); a.set(new Uint8Array(0), 9); return sum(a) }
export let fractionalOffset = () => { const a = new Float32Array(8), b = seed(new Float32Array(3)); a.set(b, 1.5); return sum(a) }
export let selfCopy = () => { const a = seed(new Int32Array(9)); a.set(a); a.set(a, 0); return sum(a) }
export let noMove = () => { const a = seed(new Float64Array(9)); a.copyWithin(3, 3); a.copyWithin(0, 5, 2); a.copyWithin(9, 0); return sum(a) }
export let dyn = (k, j) => { const a = pick(k, 37), b = seed(pick(j, 37)); a.set(b); a.set(b.subarray(3, 9), 31); return sum(a) }
export let dynFromArray = (k) => { const a = pick(k, 9); a.set([1.5, -2.5, 300, 4e9], 2); return sum(a) }
export let ctorDyn = (k) => sum(new Float64Array(seed(pick(k, 37)))) + sum(new Int32Array(seed(pick(k, 37))))
export let within = (k) => { const a = seed(pick(k, 37)); a.copyWithin(5, 0, 20); a.copyWithin(0, 10); a.copyWithin(-6, -9, -2); return sum(a) }`
const names = Object.keys(oracle(src))
const argsOf = { dyn: [...Array(121)].map((_, i) => [i % 11, Math.floor(i / 11)]), dynFromArray: [...Array(11)].map((_, k) => [k]),
  ctorDyn: [...Array(11)].map((_, k) => [k]), within: [...Array(11)].map((_, k) => [k]) }

for (const optimize of levels(0, 2, 3, 'size'))
  test(`typed copy: set, copyWithin and the copy constructor agree with the host at ${optimize}`, () => {
    const want = oracle(src), got = run(src, { optimize })
    for (const name of names) for (const args of argsOf[name] ?? [[]])
      is(got[name](...args), want[name](...args), `${name}(${args}) at ${optimize}`)
  })

test('typed copy: BigInt kinds copy each other and themselves bit for bit', () => {
  const big = `const sum = (a) => { let h = 0n; for (let i = 0; i < a.length; i++) h = (h * 31n + BigInt.asIntN(64, a[i])) % 1000003n; return Number(h) }
    const seed = (a) => { for (let i = 0; i < a.length; i++) a[i] = BigInt(i * 37 % 19 - 9) * 1000000007n; return a }
    export let same = () => { const a = new BigInt64Array(9); a.set(seed(new BigInt64Array(9))); return sum(a) }
    export let cross = () => { const a = new BigUint64Array(9); a.set(seed(new BigInt64Array(9)), 0); return sum(a) }
    export let ctor = () => sum(new BigInt64Array(seed(new BigUint64Array(9))))
    export let within = () => { const a = seed(new BigInt64Array(9)); a.copyWithin(2, 0, 6); a.copyWithin(0, 3); return sum(a) }`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const want = oracle(big), got = run(big, { optimize })
    for (const name of ['same', 'cross', 'ctor', 'within']) is(got[name](), want[name](), `${name} at ${optimize}`)
  }
})

test('typed copy: .set throws the RangeError of an offset outside the receiver', () => {
  const src = `export let f = (off) => { const a = new Float32Array(8); a.set(new Float32Array(3), off); return a.length }
    export let dyn = (k, off) => { const a = [new Float32Array(8), new Uint8Array(8)][k]; a.set([1, 2, 3], off); return a.length }
    export let longer = (n) => { const a = new Float32Array(8); a.set(new Float32Array(n)); return a.length }`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const { f, dyn, longer } = run(src, { optimize })
    is(f(5), 8, `the last slot at ${optimize}`)
    is(dyn(1, 5), 8, `the last slot, runtime kind at ${optimize}`)
    is(longer(8), 8, `a source as long as the receiver at ${optimize}`)
    throws(() => longer(9), e => e instanceof RangeError, `a source longer than the receiver at ${optimize}`)
    for (const off of [6, -1, Infinity, -Infinity]) {
      throws(() => f(off), e => e instanceof RangeError, `offset ${off} at ${optimize}`)
      throws(() => dyn(0, off), e => e instanceof RangeError, `offset ${off}, runtime kind at ${optimize}`)
    }
  }
})

test('typed copy: from of a typed array is the constructor\'s copy, no list between', () => {
  const text = wat(`export let f = (v) => { const a = new Float32Array(64); a[3] = v; const b = Float64Array.from(a), c = Float32Array.from(a), d = Int16Array.from(b); return b[3] + c[3] + d[3] }`)
  const f = funcWat(text, 'f$exp') || funcWat(text, 'f')
  is((f.match(/memory\.copy/g) || []).length, 1, 'the same-bytes copy is a byte copy')
  ok(!/call \$__(arr_from|typed_idx)/.test(f), 'no list and no element helper')
})

test('typed copy: a same-bytes copy is one memory.copy, no element loop', () => {
  const text = wat(`export let f = (v) => { const a = new Float32Array(64), b = new Float32Array(64); b[1] = v; a.set(b, 1); const c = new Float32Array(a), d = new Uint32Array(new Int32Array(64)); return c[2] + d.length }`)
  const f = funcWat(text, 'f$exp') || funcWat(text, 'f')
  is((f.match(/memory\.copy/g) || []).length, 3, 'set and both constructor copies are byte copies')
  ok(!/\(loop /.test(f), 'no element loop')
  // The kernels inline into their caller at the default level: probe the module.
  const kernels = wat(`export let f = (v) => { const a = new Int16Array(64); a.fill(v); a.copyWithin(1, 0); return a[5] }`)
  ok(/memory\.fill/.test(kernels), 'fill has the memory.fill path')
  ok((kernels.match(/memory\.copy/g) || []).length >= 2 && !/typed_get_idx/.test(kernels), 'copyWithin is a byte move, no element read')
})

test('typed copy: a closed source extent needs only runtime element-kind dispatch', () => {
  const shape = `export function copy(a) { return new Float64Array(a) }`
  const text = wat(shape, { optimize: { level: 2, watr: false } })
  const body = funcWat(text, 'copy')
  ok(body.includes('call $__typed_get_idx'), 'the typed arm uses the existing in-bounds aux/view reader')
  ok(!body.includes('call $__typed_idx '), 'the typed copy loop does not repeat generic receiver/bounds checks')

  const src = `export function f(mode, count) {
    const a = new Float64Array([-8, -0, NaN, Infinity, -Infinity, 3.5]),
      b = new Uint32Array([7, 4294967295, 2147483648, 3, 4, 5])
    const source = mode ? b.subarray(1, count + 1) : a.subarray(1, count + 1)
    const copy = new Float64Array(source)
    source[0] = 91
    return [copy.length, copy[0], copy[1], copy[2], source[0]]
  }`
  const host = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const f = run(src, { optimize }).f
    for (const [mode, count] of [[0, 0], [1, 0], [0, 1], [0, 4], [0, 4], [1, 4], [0, 4]])
      is(f(mode, count), host(mode, count), `O${optimize}: kind ${mode}, view count ${count}`)
  }
})
