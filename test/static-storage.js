// Static typed storage: a constant-length typed array constructed once at module
// scope lives in the data segment. No allocator, no start-time construction; the
// base is an immutable global the static-prefix strip rebases; `.length` and
// `.byteLength` fold to constants. The compact prototype's typed row (287 bytes)
// was this placement; production carried ~330 bytes of allocator around the same
// loops.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { onKernel } from './_matrix.js'

const DSP = `const a = new Float64Array(64); const b = new Float64Array(64)
export let f = (x) => {
  for (let i = 0; i < a.length; i++) a[i] = x + i
  for (let j = 0; j < b.length; j++) b[j] = a[j] * 2 + 1
  let sum = 0
  for (let k = 0; k < b.length; k++) sum += b[k]
  return sum
}`

test('static storage: module-scope constant-length typed arrays need no allocator', () => {
  const wat = compile(DSP, { optimize: 'size', alloc: false, wat: true })
  ok(!/\$__alloc/.test(wat), 'no allocator')
  ok(!/global \$__heap\b/.test(wat), 'no heap global')
  ok(!/__alloc_hdr/.test(wat), 'no header construction at start')
  const bytes = compile(DSP, { optimize: 'size', alloc: false })
  ok(bytes.length <= 300, `typed row is ${bytes.length} bytes; the prototype's was 287`)
  for (const optimize of [0, 1, 2, 3, 'size']) {
    const { exports } = instantiate(compile(DSP, { optimize }))
    is(exports.f(3), 4480, `optimize ${optimize}`)
    is(exports.f(0), 4096)
  }
})

test('static storage: bases stay 16-byte aligned through the prefix strip and fold into memargs', () => {
  const wat = compile(DSP, { optimize: 'size', wat: true })
  ok(!/\$__start/.test(wat), 'no start function: the bindings are constants')
  ok(!/global\.get/.test(wat), 'no global reads: every base is a memarg offset')
  const offsets = [...wat.matchAll(/f64\.(?:load|store) offset=(\d+)/g)].map(m => Number(m[1]))
  ok(offsets.length >= 4, `memarg offsets: ${offsets.join(' ')}`)
  for (const off of offsets) is(off % 16, 0, `base ${off}`)
})

test('static storage: every element kind, with length and byteLength folded', () => {
  const src = `const i8 = new Int8Array(3); const u8 = new Uint8Array(5); const c8 = new Uint8ClampedArray(2)
    const i16 = new Int16Array(4); const u16 = new Uint16Array(4)
    const i32 = new Int32Array(8); const u32 = new Uint32Array(2)
    const f32 = new Float32Array(6); const f64 = new Float64Array(7)
    export let put = (i, v) => { i8[i] = v; u8[i] = v; c8[i & 1] = v; i16[i] = v; u16[i] = v; i32[i] = v; u32[i] = v; f32[i] = v; f64[i] = v }
    export let get = (i) => i8[i] + u8[i] + c8[i & 1] + i16[i] + u16[i] + i32[i] + u32[i] + f32[i] + f64[i]
    export let bytes = () => i8.byteLength + u8.byteLength + c8.byteLength + i16.byteLength + u16.byteLength + i32.byteLength + u32.byteLength + f32.byteLength + f64.byteLength
    export let lens = () => i8.length + u8.length + c8.length + i16.length + u16.length + i32.length + u32.length + f32.length + f64.length`
  const wat = compile(src, { optimize: 'size', wat: true })
  ok(!/\$__alloc/.test(wat), 'no allocator')
  ok(!/\$__len\b/.test(wat), 'no runtime length read')
  const { exports } = instantiate(compile(src))
  exports.put(1, 300)
  is(exports.get(1), 44 + 44 + 255 + 300 + 300 + 300 + 300 + 300 + 300)
  is(exports.bytes(), 3 + 5 + 2 + 8 + 8 + 32 + 8 + 24 + 56)
  is(exports.lens(), 3 + 5 + 2 + 4 + 4 + 8 + 2 + 6 + 7)
})

test('static storage: a module-level loop constructs distinct arrays', () => {
  const { exports } = jz(`const bufs = []
    for (let i = 0; i < 3; i++) bufs.push(new Float64Array(4))
    let k = 0
    const more = []
    while (k < 2) { more.push(new Int32Array(2)); k++ }
    export let f = () => { bufs[0][0] = 9; more[0][1] = 5; return bufs[1][0] * 10 + more[1][1] }`)
  is(exports.f(), 0)
})

test('static storage: a rewritten typed global drops its declaration facts', () => {
  const { exports } = jz(`let cur = new Float64Array(4)
    export let grow = () => { cur = new Float64Array(8); return cur.length }
    export let len = () => cur.length
    export let bytes = () => cur.byteLength`)
  is(exports.len(), 4)
  is(exports.bytes(), 32)
  is(exports.grow(), 8)
  is(exports.len(), 8)
  is(exports.bytes(), 64)
  const kind = jz(`let cur = new Float64Array(2)
    cur[0] = 1.5
    export let swap = () => { cur = new Int32Array(2); cur[0] = 7 }
    export let read = () => cur[0]`).exports
  is(kind.read(), 1.5)
  kind.swap()
  is(kind.read(), 7)
})

test('static storage: an export parameter stored into or indexing a typed array stays numeric', () => {
  if (onKernel()) return
  const src = `const buf = new Int32Array(8)
    export let put = (i, v) => { buf[i] = v }
    export let get = (i) => buf[i]`
  const bytes = compile(src, { optimize: 'size' })
  ok(bytes.length < 400, `${bytes.length} bytes: no ToNumber runtime for a typed store or index`)
  const { exports } = instantiate(bytes)
  exports.put(3, 300)
  is(exports.get(3), 300)
  exports.put('2', '7')
  is(exports.get(2), 7)
})

test('static storage: larger than the cap or dynamic in length still allocates', () => {
  const big = compile(`const t = new Float64Array(65536); export let f = (i) => { t[i] = i; return t[i] }`, { optimize: 'size', wat: true })
  ok(/\$__alloc/.test(big), 'over the 64 KiB cap: heap')
  const dyn = compile(`let n = 4; export let mk = () => new Float64Array(n).length`, { optimize: 'size', wat: true })
  ok(/\$__alloc/.test(dyn), 'runtime length: heap')
  const { exports } = instantiate(compile(`const t = new Float64Array(65536); export let f = (i) => { t[i] = i; return t[i] }`))
  is(exports.f(65535), 65535)
})
