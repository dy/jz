// A call spliced at its site (src/compile/plan/inline.js) binds a parameter to a
// temporary where the body writes it, or where its argument is not simple. A
// parameter the body leaves alone reads its simple argument directly, in a body
// that writes another one too: `put(target, offset, x, y)` rounding x and y in
// place still stores through `target` and `offset` as they were passed. Every
// value is a differential against the host; the WAT shows the receiver is no
// temporary.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { agree, funcWat, wat } from './util.js'
import { belowOpt, levels } from './_matrix.js'

const each = (src, rows) => { for (const optimize of levels(0, 2, 3)) for (const args of rows) agree(src, 'f', args, { optimize }, `f(${args.join(', ')}) at ${optimize}`) }

test('inline args: a body that writes two of its parameters', () => {
  const src = `const put = (target, offset, x, y) => { x = Math.fround(x * 2); y = Math.fround(y + 1); target[offset] = x; target[offset + 1] = y }
  export function f(n) {
    const a = new Float32Array(8)
    let o = 0
    for (let i = 0; i < n; i++) { put(a, o, i + 0.5, o); o = (o + 2) & 7 }
    let s = 0
    for (let i = 0; i < 8; i++) s = s * 3 + a[i]
    return s
  }`
  each(src, [[0], [1], [4], [9]])
  if (belowOpt(2)) return
  const f = funcWat(wat(src), 'f$exp') || funcWat(wat(src), 'f')
  ok(!/call \$put/.test(f), 'the call is spliced')
  const loop = f.slice(f.indexOf('(loop '), f.indexOf('(br $loop'))
  ok(loop.includes('f32.store') && !/i64\.reinterpret_f64/.test(loop), 'the receiver is no box to take apart at each store')
})

test('inline args: one variable passed for a parameter written and one left alone', () => {
  const src = `const g = (a, b) => { a = a + 1; return a * 10 + b }
  export function f(x) { let s = 0; for (let i = 0; i < 3; i++) s += g(x + i, x + i); return s }`
  each(src, [[0], [2], [-3], [1.5]])
})

test('inline args: an argument that writes what another argument names', () => {
  const src = `const h = (a, b, c) => { c = c * 2; return a * 100 + b * 10 + c }
  export function f(x) { let i = x, s = 0; for (let k = 0; k < 3; k++) s += h(i, i++, i); return s + i }`
  each(src, [[0], [1], [5]])
})

test('inline args: a body that writes what an argument names', () => {
  const src = `let v = 0
  const w = (a, b) => { b = b + 1; v = 7; return a + b }
  export function f(x) { v = x; let s = 0; for (let k = 0; k < 2; k++) s += w(v, k); return s + v }`
  each(src, [[0], [3], [-2]])
})
