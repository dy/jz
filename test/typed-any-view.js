// An owned typed array and a view of the same element kind meet in one binding
// (a `subarray` beside a fresh array, an FFT that returns its caller's buffer
// or a view of its own). The element kind survives the join; the view bit is
// read off the pointer at each access (layout.js TYPED_ELEM_ANY_VIEW_FLAG,
// module/typedarray.js typedDataAddr). Before, the join lost the element kind
// and every access went through the run-time element dispatch.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, wat } from './util.js'

const src = `
let x = new Float64Array(16)
for (let i = 0; i < 16; i++) x[i] = i + 0.25
let v = x.subarray(4, 12)
let pick = (k) => k > 0 ? v : new Float64Array(8).fill(2)
export let rw = (k) => { let a = pick(k), s = 0; for (let i = 0; i < a.length; i++) { a[i] = a[i] * 1.5 + i; s += a[i] } return s * 100 + a.length }
export let sub = (k) => { let a = pick(k).subarray(1, 5); let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s + a.length * 1000 }
export let bytes = (k) => { let a = pick(k); return [a.byteOffset, a.byteLength, a.BYTES_PER_ELEMENT, a.buffer.byteLength].join() }
let own = new Float64Array(9), scratch = new Float64Array(16)
let fft = (input, output) => { if (output) { for (let k = 0; k < 9; k++) output[k] = input[k] * 2; return output } let re = scratch.subarray(0, 9); for (let k = 0; k < 9; k++) re[k] = input[k] * 3; return re }
export let spectrum = (k) => { let r = fft(x, k > 0 ? own : null), s = 0; for (let i = 0; i < r.length; i++) s += r[i] * i; return s }
let norm = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return s }
export let param = (k) => norm(k > 0 ? x.subarray(2, 6) : own) + norm(x)
let i32 = new Int32Array(8).fill(3)
export let ints = (k) => { let a = k > 0 ? i32.subarray(2) : new Int32Array(4).fill(7); let s = 0; for (let i = 0; i < a.length; i++) { a[i] += i; s += a[i] } return s }
`
const calls = ['rw', 'sub', 'bytes', 'spectrum', 'param', 'ints'].flatMap(name => [[name, 1], [name, 0]])

for (const optimize of levels(0, 2, 3, 'size'))
  test(`typed any view: owned and view arrays of one kind in a binding agree with the host at ${optimize}`, () => {
    const host = oracle(src), mod = jz(src, { optimize }).exports
    for (const [name, k] of calls) is(mod[name](k), host[name](k), `${name}(${k})`)
  })

test('typed any view: the joined receiver reads its elements directly', () => {
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  for (const name of ['rw', 'spectrum']) {
    const body = funcWat(text, `${name}$exp`) || funcWat(text, name)
    ok(/f64\.load/.test(body), `${name}: an f64 load`)
    ok(!/__typed_idx|__typed_set_idx/.test(body), `${name}: no run-time element dispatch`)
  }
})

// Element methods walk a view's own elements: its data starts at the byte
// offset, a resizable buffer's view tracks the buffer, and a copy owns its
// data. `reduceRight` had no typed form and walked a view as an Array's
// 8-byte cells (a trap or 0); `toSorted` sorted its copy as a view. A
// BigInt64Array an exported function's parameter holds (the runtime fork's
// typed arm) hands find and reduce results over boxed, where they read as raw bits.
const viewMethods = `
let buf = new ArrayBuffer(64), whole = new Int16Array(buf)
for (let i = 0; i < 32; i++) whole[i] = (i * 7) % 11 + 1
let plain = () => new Int16Array(buf, 4, 5)
let sub = () => new Float64Array([1, 2, 3, 4, 5, 6]).subarray(2, 5)
let rsz = () => { let b = new ArrayBuffer(16, { maxByteLength: 64 }), a = new Float32Array(b); a.set([1, 2, 3, 4]); return new Float32Array(b, 4) }
let big = () => new BigInt64Array([1n, 2n, 3n, 4n]).subarray(1)
let views = [plain, sub, rsz]
let each = (f) => views.map(v => f(v())).join(' | ')
export let reduceRight = () => each(v => v.reduceRight((s, x, i, t) => s * 10 + x + i * t.length, 0))
export let reduceRightSeed = () => each(v => v.reduceRight((s, x) => s * 10 + x))
export let reduce = () => each(v => v.reduce((s, x, i) => s * 10 + x + i, 0))
export let findLast = () => each(v => [v.findLast(x => x < 4), v.findLastIndex(x => x < 4)].join())
export let lastIndexOf = () => each(v => [v.lastIndexOf(v[1]), v.lastIndexOf(99), v.indexOf(v[2])].join())
export let at = () => each(v => [v.at(-1), v.at(-v.length), v.at(0)].join())
export let copyWithin = () => each(v => { v.copyWithin(0, 1); return v.join() })
export let reverse = () => each(v => { v.reverse(); return v.join() })
export let toReversed = () => each(v => v.toReversed().join() + '/' + v.join())
export let toSorted = () => each(v => { v[0] = 50; return v.toSorted().join() + '/' + v.toSorted((a, b) => b - a).join() + '/' + v.join() })
export let bigint = () => [big().reduceRight((s, x) => s * 10n + x, 0n), big()?.reduceRight((s, x) => s * 10n + x), big().reduce((s, x) => s * 10n + x)].join()
export let param = () => { let r = (v) => v.reduceRight((s, x) => s * 10 + x, 0); return each(r) }
export let unknown = (v) => [v.find(x => x > 2n), v.findLast(x => x > 9n), v.reduce((s, x) => s * 10n + x), v?.reduceRight((s, x) => s * 10n + x, 0n)].map(String).join()
export let bigUnknown = () => unknown(big())
`
for (const optimize of levels(0, 2, 3, 'size'))
  test(`typed views: element methods walk the view's own elements at ${optimize}`, () => {
    const host = oracle(viewMethods), mod = jz(viewMethods, { optimize }).exports
    for (const name of Object.keys(host)) if (name !== 'unknown') is(mod[name](), host[name](), name)
  })
