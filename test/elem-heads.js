// The element heads (layout.js numTypedWat): `__len`, the element reads, the
// element stores, the `.length` dispatchers and `__str_eq` answer their common
// case (an array's element in bounds, a numeric typed array's, owned or a view;
// the same or a short string) in a head small enough for the engine's inliner,
// and leave every other receiver, index and value to a tail, as `__rem` leaves
// its long division to `__rem_div`. A receiver whose kind the compiler cannot
// close reaches them; every element kind, index and value agrees with the host.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { compile } from '../index.js'
import { funcWat, oracle, run, wat } from './util.js'

const src = `
const typedOf = (k) => k === 0 ? new Float64Array(8) : k === 1 ? new Float32Array(8) : k === 2 ? new Uint8Array(8)
  : k === 3 ? new Int16Array(8) : k === 4 ? new Int32Array(8) : k === 5 ? new Float32Array(12).subarray(2, 10)
  : k === 6 ? new Uint16Array(12).subarray(3) : k === 7 ? new Uint8ClampedArray(8) : k === 8 ? new Int8Array(8)
  : new Uint32Array(8)
const indexedOf = (k) => k < 10 ? typedOf(k) : k === 10 ? [0, 0, 0, 0, 0, 0, 0, 0] : [1, 2]
const anyOf = (k) => k < 12 ? indexedOf(k) : { length: 3 }
const VALS = [1.5, -2.25, 3e9, -3e9, 255.7, 256, -129, 70000, 1 / 0, -1 / 0, 0 / 0, 2 ** 31, -(2 ** 31),
  2 ** 53 + 2, 2 ** 64 + 4096, '7', true, null, undefined, -0]
const code = (x) => typeof x === 'number'
  ? (x === x ? (x === 1 / 0 ? 1e300 : x === -1 / 0 ? -1e300 : 1 / x === -1 / 0 ? -1e-300 : x) : 1e299)
  : x === undefined ? 1e298 : x === null ? 1e297 : x === true ? 1e296 : 1e295
const fill = (a, j, out) => {
  for (let i = -1; i < 10; i++) a[i] = VALS[(i + j + 20) % 20]
  for (let i = -1; i < 10; i++) out.push(code(a[i]))
  out.push(a.length)
}
export let typed = () => { const out = []; for (let k = 0; k < 10; k++) for (let j = 0; j < 20; j++) fill(typedOf(k), j, out); return out }
export let indexed = () => { const out = []; for (let k = 0; k < 12; k++) for (let j = 0; j < 20; j++) fill(indexedOf(k), j, out); return out }
export let any = () => { const out = []; for (let k = 0; k < 13; k++) for (let j = 0; j < 20; j++) fill(anyOf(k), j, out); return out }
export let keys = () => {
  const m = {}, names = ['a', 'ab', 'abcdef', 'abcdefg', 'a much longer key', 'a much longer kez', 'length']
  for (let i = 0; i < names.length; i++) m[names[i]] = i
  let s = 0
  for (let i = 0; i < names.length; i++) s = s * 10 + (m[names[i]] ?? 9) + (m[names[i] + ''] === i ? 0 : 100)
  return s + (m['a much longer k' + 'ey'] ?? 50)
}`

test('element heads: every kind, index and value agrees with the host', () => {
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const wasm = run(src, { optimize })
    for (const f of ['typed', 'indexed', 'any', 'keys']) is(JSON.stringify(wasm[f]()), JSON.stringify(host[f]()), `${f} at ${optimize}`)
  }
})

// Wire bytes of each named function body: what the engine's inliner measures
// (V8 inlines a wasm callee of at most --wasm-inlining-max-size, 500 bytes).
const bodySizes = (bytes) => {
  let p = 8, imports = 0
  const u = () => { let r = 0, s = 0, b; do { b = bytes[p++]; r |= (b & 0x7f) << s; s += 7 } while (b & 0x80); return r >>> 0 }
  const skip = () => { const n = u(); p += n }
  const sizes = [], names = new Map()
  while (p < bytes.length) {
    const id = bytes[p++], len = u(), end = p + len
    if (id === 2) for (let n = u(); n > 0; n--) {
      skip(); skip()
      const kind = bytes[p++]
      if (kind === 0) { imports++; u() } else if (kind === 3) p += 2
      else if (kind === 4) { p++; u() } else { if (kind === 1) p++; const f = bytes[p++]; u(); if (f & 1) u() }
    }
    if (id === 10) for (let n = u(); n > 0; n--) { const size = u(); sizes.push(size); p += size }
    if (id === 0) {
      const nl = u(), name = new TextDecoder().decode(bytes.subarray(p, p + nl)); p += nl
      if (name === 'name') while (p < end) {
        const sub = bytes[p++], sl = u(), se = p + sl
        if (sub === 1) for (let n = u(); n > 0; n--) { const i = u(), l = u(); names.set(new TextDecoder().decode(bytes.subarray(p, p + l)), i); p += l }
        p = se
      }
    }
    p = end
  }
  return name => names.has(name) ? sizes[names.get(name) - imports] : null
}

test('element heads: loop-free, under the inliner limit, the rest in the tail', () => {
  if (belowOpt(3)) return
  const text = wat(src, { optimize: 3 }), size = bodySizes(compile(src, { optimize: 3, names: true }))
  const heads = ['__len', '__typed_idx', '__typed_idx_tagged', '__arr_typed_set_idx', '__arr_typed_obj_set_idx',
    '__typed_set_idx_tagged', '__length.value', '__str_eq']
  let seen = 0
  for (const name of heads) {
    const body = funcWat(text, name)
    if (!body) continue
    seen++
    ok(!/\(loop/.test(body), `${name} has no loop`)
    ok(body.includes(`call $${name}_tail`), `${name} leaves the rest to ${name}_tail`)
    ok(funcWat(text, `${name}_tail`).length > 0, `${name}_tail stays a function`)
    ok(size(name) < 500, `${name} is ${size(name)} bytes, under the inliner limit`)
  }
  ok(seen >= 6, `the program links the heads (${seen})`)
})
