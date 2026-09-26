// Byte-store merging (optimize/peephole.js mergeByteStores): consecutive stores
// of one word's bytes at consecutive addresses are the word's little-endian
// store, which Wasm memory defines.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'

const count = (text, op) => (text.match(new RegExp(`\\(${op.replace('.', '\\.')}(?=[\\s)])`, 'g')) || []).length
const body = src => { const text = wat(src, { optimize: 3 }); return funcWat(text, 'f') || funcWat(text, 'f$exp') }
const stores = (text, ...ops) => ops.reduce((n, op) => n + count(text, op), 0)

const WORDS = [0, 1, 255, 256, 0x1234, 0xabcd, 0xffff, 0x10000, 0x7fffffff, -1, -2, -32768, 0xdeadbeef | 0, 2 ** 31, 1e10, -1e10, 3.7, NaN]

const check = (src, ...extra) => {
  for (const optimize of levels(0, 2, 3, 'size'))
    for (const w of WORDS) agree(src, 'f', [w, ...extra], { optimize }, `f(${w}) at ${optimize}`)
}

// A digest of the byte buffer the stores fill, so the host sees every byte.
const digest = (buf, n) => `let h = 0
    for (let i = 0; i < ${n}; i++) h = (h * 31 + ${buf}[i]) | 0
    return h`

test('store merge: a low byte and a shifted high byte become one halfword store', () => {
  const src = `export let f = (u) => {
    const o = new Uint8Array(16)
    for (let k = 0; k < 8; k += 2) { o[k] = u & 0xff; o[k + 1] = (u >>> 8) & 0xff; u = (u * 3) | 0 }
    ${digest('o', 16)}
  }`
  const text = body(src)
  is(count(text, 'i32.store8'), 0, 'no byte stores remain')
  ok(stores(text, 'i32.store16', 'i64.store16') > 0, 'halfword stores')
  check(src)
})

test('store merge: four bytes of one word become one word store', () => {
  const src = `export let f = (v) => {
    const b = new Uint8Array(16)
    for (let k = 0; k < 8; k += 4) {
      b[k] = v & 0xff; b[k + 1] = (v >>> 8) & 0xff; b[k + 2] = (v >>> 16) & 0xff; b[k + 3] = (v >>> 24) & 0xff
      v = (v * 3) | 0
    }
    ${digest('b', 16)}
  }`
  const text = body(src)
  is(count(text, 'i32.store8'), 0, 'no byte stores remain')
  ok(stores(text, 'i32.store', 'i64.store') > 0, 'word stores')
  check(src)
})

test('store merge: two halfwords become one word store', () => {
  const src = `export let f = (v) => {
    const b = new Uint16Array(8)
    for (let k = 0; k < 4; k += 2) { b[k] = v & 0xffff; b[k + 1] = (v >>> 16) & 0xffff; v = (v * 3) | 0 }
    ${digest('b', 8)}
  }`
  const text = body(src)
  is(stores(text, 'i32.store16', 'i64.store16'), 0, 'no halfword stores remain')
  ok(stores(text, 'i32.store', 'i64.store') > 0, 'word stores')
  check(src)
})

test('store merge: bytes of different words, or out of order, stay byte stores', () => {
  const twoWords = `export let f = (u) => {
    const o = new Uint8Array(16)
    for (let k = 0; k < 8; k += 2) { o[k] = u & 0xff; o[k + 1] = ((u + 3) >>> 8) & 0xff; u = (u * 3) | 0 }
    ${digest('o', 16)}
  }`
  ok(count(body(twoWords), 'i32.store8') > 0, 'two words keep byte stores')
  check(twoWords)
  const highFirst = `export let f = (u) => {
    const o = new Uint8Array(16)
    for (let k = 0; k < 8; k += 2) { o[k + 1] = (u >>> 8) & 0xff; o[k] = u & 0xff; u = (u * 3) | 0 }
    ${digest('o', 16)}
  }`
  ok(count(body(highFirst), 'i32.store8') > 0, 'the high byte first keeps byte stores')
  check(highFirst)
  const gap = `export let f = (u) => {
    const o = new Uint8Array(16)
    for (let k = 0; k < 8; k += 3) { o[k] = u & 0xff; o[k + 2] = (u >>> 8) & 0xff; u = (u * 3) | 0 }
    ${digest('o', 16)}
  }`
  ok(count(body(gap), 'i32.store8') > 0, 'a gap keeps byte stores')
  check(gap)
})

test('store merge: a write between the stores is not merged', () => {
  const src = `export let f = (u, k) => {
    const o = new Uint8Array(8)
    o[k] = u & 0xff
    k = k + 1
    o[k] = (u >>> 8) & 0xff
    ${digest('o', 8)}
  }`
  check(src, 0)
  check(src, 3)
  const word = `export let f = (u) => {
    const o = new Uint8Array(16)
    for (let k = 0; k < 8; k += 2) { o[k] = u & 0xff; u = u + 256; o[k + 1] = (u >>> 8) & 0xff }
    ${digest('o', 16)}
  }`
  ok(count(body(word), 'i32.store8') > 0, 'a changed word keeps byte stores')
  check(word)
})
