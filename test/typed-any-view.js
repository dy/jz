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
