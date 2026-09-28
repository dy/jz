// A binding initialized from an element the emitter loaded without a check
// holds a number for the rest of its block (emit/dispatch.js presentElement):
// its numeric uses convert nothing. The checked twin of a versioned loop keeps
// the conversion, since there the element may be missing.
import test from 'tst'
import { is } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'

const check = (src, args, name) => {
  for (const optimize of levels(0, 2, 3, 'size')) agree(src, 'f', args, { optimize }, `${name} at ${optimize}`)
}
// The conversions of the swap temp `tr` to a number: select(NaN, tr, tr is undefined).
const conversions = text => (text.match(/\(select\s*\(f64\.const nan\)\s*\(local\.get \$[^\s()]*_tr\)/g) || []).length

test('numeric conversion: a parameter fed by numeric elements retains only the undefined arm', () => {
  const src = `function calc(x) { return [x, x - 1] }
    const a = [2, -0, NaN, Infinity]; export function f(i) { return calc(a[i]) }`
  for (const i of [-1, 0, 1, 2, 3, 4]) check(src, [i], `numeric element ${i}`)
  const body = funcWat(wat(src, { optimize: 0 }), 'calc')
  is(body.includes('0x7FF8000100000000'), false, 'a closed Number|undefined parameter has no null-to-zero branch')
  is(body.includes('0x7FF8000200000000'), true, 'a missing element still becomes NaN at its numeric use')
})

test('numeric conversion: possible nulls from elements, callers and captured writes still become zero', () => {
  const rows = [
    `function calc(x) { return [x, x - 1] }
      const a = [2, null]; export function f(i) { return calc(a[i]) }`,
    `export function f(x) { return [x, x - 1] }`,
    `function calc(x, i) { const change = () => { x = null }; if (i) change(); return [x, x - 1] }
      const a = [2, 3]; export function f(i) { return calc(a[i], i) }`,
  ]
  for (let r = 0; r < rows.length; r++) for (const v of r === 1 ? [2, null, undefined] : [0, 1, 2])
    check(rows[r], [v], `nullable source ${r}, ${v}`)
})

const swap = `const swap = (re, perm, n) => {
  for (let i = 0; i < n; i++) {
    const j = perm[i]
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr }
  }
}
export let f = (n, size, reach) => {
  const re = new Float64Array(size), perm = new Uint32Array(80)
  for (let i = 0; i < size; i++) re[i] = i * 1.5 + 0.25
  for (let i = 0; i < 80; i++) perm[i] = (i * 7 + 3) % reach
  for (let r = 0; r < 3; r++) swap(re, perm, n)
  let h = 0
  for (let i = 0; i < size; i++) h += (re[i] === re[i] ? re[i] : -1) * (i + 1)
  return h
}`

// The one conversion left is the store `re[j] = tr`: `j = perm[i]` may miss
// (i past perm's 80 elements), a property store would keep `tr` as it is, so
// the all-uses proof cannot normalize `tr` at its write. The versioned arm has
// proven both indices in range by then; a presence proof reading the arm's own
// guard makes this 0. (Before the summary stopped demanding a typed array's
// index, the fixture took the dynamic key path, 355 KB with no select at all.)
test('present init: the fast arm of a versioned swap stores its temp unconverted', () => {
  is(conversions(wat(swap, { optimize: 3 })), 1, 'the temp converts once, at the store whose key may miss')
})

test('present init: swaps inside and past the arrays match the host', () => {
  // n within the arrays, n past `re` (missing elements store NaN), targets past `re`.
  for (const [n, size, reach] of [[0, 64, 64], [64, 64, 64], [40, 64, 80], [70, 64, 64], [80, 50, 80], [80, 64, 200]])
    check(swap, [n, size, reach], `swap(${n}, ${size}, ${reach})`)
})

test('present init: a binding assigned again keeps its conversions', () => {
  const src = `export let f = (n, size) => {
  const a = new Float64Array(size), b = new Float64Array(64)
  for (let i = 0; i < size; i++) a[i] = i + 0.5
  let s = 0
  for (let i = 0; i < n; i++) {
    let v = a[i]
    s += v * 2
    v = a[i + 40]
    b[i & 63] = v
    s += v === v ? v : -3
  }
  for (let i = 0; i < 64; i++) s += (b[i] === b[i] ? b[i] : -7) * (i + 1)
  return s
}`
  for (const [n, size] of [[0, 64], [24, 64], [64, 64], [70, 64], [30, 50]]) check(src, [n, size], `reassigned(${n}, ${size})`)
})

test('present init: narrower elements widen to numbers too', () => {
  const src = `export let f = (n, size) => {
  const a = new Int16Array(size), b = new Float32Array(size), o = new Float64Array(64)
  for (let i = 0; i < size; i++) { a[i] = i * 37 - 500; b[i] = i / 3 }
  let s = 0
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i]
    o[i & 63] = x
    o[(i + 1) & 63] = y
    s += x * 0.5 + y
  }
  for (let i = 0; i < 64; i++) s += (o[i] === o[i] ? o[i] : -7) * (i + 1)
  return s
}`
  for (const [n, size] of [[0, 64], [24, 64], [64, 64], [70, 64], [30, 20]]) check(src, [n, size], `narrow(${n}, ${size})`)
})
