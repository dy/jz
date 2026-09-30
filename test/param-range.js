// The hull of the arguments a parameter receives over the function's direct
// calls (src/summary `argRanges`, `paramRangesOf`): a counter's span, the
// arithmetic on it, a caller's own hull through a chain of calls. A position
// some call leaves unbounded is null; a hull that keeps widening (a recursion
// feeding its own argument) opens; a function the host or a closure table may
// call has none. The emitter starts a parameter's flow interval from it, so a
// ToInt32 of `floor(y) + gy` inside a sampler needs no infinity guard.
import test from 'tst'
import { is } from 'tst/assert.js'
import { _compileInProcess as compile } from '../index.js'
// These probes inspect the in-process summary; runtime checks still use the matrix target.
import { ctx } from '../src/ctx.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'

const ranges = (src, name) => {
  compile(src, { optimize: 0 })
  const fn = ctx.funcs.list.find(f => f.name === name)
  return fn ? ctx.summary.paramRangesOf(fn.name) : undefined
}

test('parameter hull: counters, arithmetic and a caller\'s hull flow into the callee', () => {
  const src = `const N = 100
    function f(x, y) { return x + y }
    function g(z) { return f(z * 2, 1) }
    export const h = () => { let s = 0; for (let i = 0; i < N; i++) s += f(i, 0.5) + g(i); return s }`
  is(JSON.stringify(ranges(src, 'f')), JSON.stringify([[0, 198], [0.5, 1]]), 'f: the hull of h\'s and g\'s calls')
  is(JSON.stringify(ranges(src, 'g')), JSON.stringify([[0, 99]]), 'g: the counter\'s span')
  is(ranges(src, 'h'), null, 'an exported function is called by the host')
})

test('parameter hull: an unbounded call, a widening recursion, an escaped function', () => {
  is(JSON.stringify(ranges(`function f(x, y) { return x + y }
    export const w = (v) => f(v, 2) + f(1, 3)`, 'f')), JSON.stringify([null, [2, 3]]), 'a host value leaves x open, y keeps its hull')
  is(JSON.stringify(ranges(`function r(k) { return k > 5 ? 0 : r(k + 1) }
    export const t = () => r(0)`, 'r')), JSON.stringify([null]), 'a recursion widening its own argument opens')
  is(JSON.stringify(ranges(`function f(x) { return x }
    export const s = () => f(1) + f(...[2, 3])`, 'f')), JSON.stringify([null]), 'a spread argument leaves the position open')
  is(JSON.stringify(ranges(`function nz(v, out, o) { out[o] = v; return out }
    function m(v) { return nz(v, [0, 0], 0) }
    m.assign = nz
    const W = [0, 0]
    export const p = (v) => { m.assign(v, W, 5); return W.length + m(v)[0] }`, 'nz')), JSON.stringify([null, null, [0, 5]]), 'a call through a property joins the hull with the direct call\'s')
})

test('parameter hull: widening is independent for each function and argument position', () => {
  const sources = [
    `function f(x, y) { return x > 8 ? y : f(x + 1, y) }
     function g(x, y) { return y > 8 ? x : g(x, y + 1) }
     export function t() { return f(0, 2) + g(3, 0) }`,
    `function f(x, y) { return y > 8 ? x : f(x, y + 1) }
     function g(x, y) { return x > 8 ? y : g(x + 1, y) }
     export function t() { return f(2, 0) + g(0, 3) }`,
  ]
  const expected = [
    [[null, [2, 2]], [[3, 3], null]],
    [[[2, 2], null], [null, [3, 3]]],
  ]
  for (const i of [0, 0, 1, 0]) {
    is(ranges(sources[i], 'f'), expected[i][0], `f in program ${i}`)
    is(ranges(sources[i], 'g'), expected[i][1], `g in program ${i}`)
    for (const optimize of levels(0, 1, 2, 3, 'size')) agree(sources[i], 't', [], { optimize })
  }
})

// Every channel that binds a function's parameters notes the call's arguments
// (summary `bind`): a call through a table or a function's property joins the
// hull like a direct call; one that cannot align them (`.call`, `.apply`, a
// callback) opens the position; a function the host or a dispatcher may call
// has no hull. A channel that noted nothing would leave the hull to the direct
// calls, and a store the hull bounds would land past what the other channel's
// arguments reach (`out[o + s]` with `o` from the property call alone).
test('parameter hull: every call channel joins the hull, the host opens it', () => {
  is(JSON.stringify(ranges(`function esc(a) { return a * 2 }
    const fs = [esc]
    export const u = (i) => fs[i](3) + esc(1)`, 'esc')), JSON.stringify([[1, 3]]), 'a table call joins the hull')
  is(JSON.stringify(ranges(`function nz(v, out, s, o) { out[o] = v; out[o + s] = 0; return out }
    function m(v) { return nz(v, [0, 0], 1, 0) }
    m.assign = nz
    const W = [0, 0]
    export const u = (x) => { m.assign(x, W, 1, 1); return m(x)[0] + W[1] }`, 'nz')), JSON.stringify([null, null, [1, 1], [0, 1]]), 'a call through a function\'s property joins the hull')
  is(JSON.stringify(ranges(`function f(a, b) { return a + b }
    export const u = (x) => f(1, 2) + f.call(null, x, 3)`, 'f')), JSON.stringify([null, [2, 3]]), '`f.call` on the function itself is its direct call (prepare folds it)')
  is(JSON.stringify(ranges(`function f(a, b) { return a + b }
    const fs = [f]
    export const u = (x) => f(1, 2) + fs[0].call(null, x, 3)`, 'f')), JSON.stringify([null, null]), '`.call` on a closure value cannot align its arguments: the positions open')
  is(JSON.stringify(ranges(`function f(a, b) { return a + b }
    const fs = [f]
    export const u = (x) => f(1, 2) + fs[0].apply(null, [x, 3])`, 'f')), JSON.stringify([null, null]), '`.apply` opens the positions')
  is(JSON.stringify(ranges(`function f(a) { return a * 2 }
    export const u = () => [1, 2].map(f)[0] + f(1)`, 'f')), JSON.stringify([null]), 'a callback opens the positions')
  is(ranges(`export function nz(v, out, s, o) { out[o] = v; out[o + s] = 0; return out }
    const W = [0, 0]
    export const u = (x) => { nz(x, W, 1, 0); return W[0] }`, 'nz'), null, 'an exported function is called by the host with anything')
  is(ranges(`function esc(a) { return a * 2 }
    export const fs = [esc]
    export const u = (i) => fs[i](3)`, 'esc'), null, 'a function the host holds takes anything')
  // The stores the hull bounds agree with the host through every channel.
  const src = `function nz(v, out, s, o) { out[o] = v; out[o + s] = 0; return out }
    function m(v) { return nz(v, [0, 0], 1, 0) }
    m.assign = nz
    const T = [nz]
    const W = [0, 0], X = [0, 0], Y = [0, 0]
    export const prop = (x) => { m.assign(x, W, 1, 1); return W.length * 100 + W[0] * 2 + W[1] + (W[2] ?? -1) + m(x)[0] }
    export const table = (x) => { T[0](x, X, 1, 1); return X.length * 100 + X[0] * 2 + X[1] + (X[2] ?? -1) + m(x)[0] }
    export const called = (x) => { nz.call(null, x, Y, 1, 1); return Y.length * 100 + Y[0] * 2 + Y[1] + (Y[2] ?? -1) + m(x)[0] }`
  for (const optimize of levels(0, 2, 3)) for (const name of ['prop', 'table', 'called']) agree(src, name, [3], { optimize }, `${name} at ${optimize}`)
})

test('parameter hull: const arguments capture bounded arithmetic at their initializer', () => {
  const src = `function f(x, y) { return x + y }
    export const h = () => { let s = 0; for (let i = 0; i < 10; i++) {
      const x = i * 0.25, y = x + 0.5; s += f(x, y)
    } return s }`
  is(JSON.stringify(ranges(src, 'f')), JSON.stringify([[0, 2.25], [0.5, 2.75]]))
  for (const optimize of levels(0, 2, 3)) agree(src, 'h', [], { optimize })
  is(JSON.stringify(ranges(`function f(x) { return x }
    export const h = n => { const x = n * 0.25; return f(x) }`, 'f')), '[null]', 'an unbounded initializer remains unbounded')
  is(JSON.stringify(ranges(`function f(x) { return x }
    function g(x) { x = Infinity; const y = x; return f(y) }
    export const h = () => g(1)`, 'f')), '[null]', 'a rewritten parameter no longer holds its incoming hull')
  const captured = `function f(x) { return x | 0 }
    function g(x) { const change = () => { x = Infinity }; change(); const y = x; return f(y) }
    export const h = () => g(1)`
  is(JSON.stringify(ranges(captured, 'f')), '[null]', 'a captured writer also invalidates the incoming hull')
  for (const optimize of levels(0, 2, 3)) agree(captured, 'h', [], { optimize })
  const boundary = `function calc(x) { return x | 0 }
    export function f(x) { const y = x; return calc(y) }
    export function g() { return f(1) }`
  is(ranges(boundary, 'f'), null, 'a bounded internal call does not close an exported entry')
  is(JSON.stringify(ranges(boundary, 'calc')), '[null]', 'an exported caller cannot supply a closed hull through its const')
  for (const optimize of levels(0, 2, 3)) for (const x of [Infinity, -Infinity]) agree(boundary, 'f', [x], { optimize })
})

const sampler = `const perm = new Uint8Array(512)
  for (let i = 0; i < 512; i++) perm[i] = (i * 7) & 255
  function sample(y) { const iy = Math.floor(y); let s = 0; for (let gy = -1; gy <= 1; gy++) s += perm[(iy + gy) & 255]; return s }
  export const f = () => { let s = 0; for (let i = 0; i < 1000; i++) s += sample(i * 0.37); return s }`

test('parameter hull: a bounded sampler index converts without the infinity guard', () => {
  for (const optimize of levels(0, 2, 3)) agree(sampler, 'f', [], { optimize }, `the sum at ${optimize}`)
  if (belowOpt(2)) return
  const text = wat(sampler, { optimize: 2 })
  const body = funcWat(text, 'sample') + (funcWat(text, 'f$exp') || funcWat(text, 'f'))
  is((body.match(/\(select/g) || []).length, 0, 'floor(y) + gy is finite: no guard')
})
