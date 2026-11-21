// The hull of the arguments a parameter receives over the function's direct
// calls (src/summary `argRanges`, `paramRangesOf`): a counter's span, the
// arithmetic on it, a caller's own hull through a chain of calls. A position
// some call leaves unbounded is null; a recursion feeding its own argument
// settles at the value its own test of the parameter stops it at, and opens
// where it tests none or moves past it; a function the host or a closure table
// may call has none. The emitter starts a parameter's flow interval from it, so a
// ToInt32 of `floor(y) + gy` inside a sampler needs no infinity guard.
import test from 'tst'
import { is } from 'tst/assert.js'

// These probes inspect the in-process summary; runtime checks still use the matrix target.
import { ctx } from '../src/ctx.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, funcWat, wat, compileInProcess as compile } from './util.js'

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
  is(JSON.stringify(ranges(`function r(k, n) { return n ? r(k + 1, n - 1) : k }
    export const t = () => r(0, 3)`, 'r')), JSON.stringify([null, null]), 'a recursion widening an argument it never tests opens')
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
  // (each recursion counts to the 9 its own test stops it at: test below, 'a recursion counting to a constant it tests')
  const expected = [
    [[[0, 9], [2, 2]], [[3, 3], [0, 9]]],
    [[[2, 2], [0, 9]], [[0, 9], [3, 3]]],
  ]
  for (const i of [0, 0, 1, 0]) {
    is(ranges(sources[i], 'f'), expected[i][0], `f in program ${i}`)
    is(ranges(sources[i], 'g'), expected[i][1], `g in program ${i}`)
    for (const optimize of levels(0, 1, 2, 3, 'size')) agree(sources[i], 't', [], { optimize })
  }
})

// A recursion's argument: the calls from outside start its hull (a function no call has bound
// yet has not run, so its own call of itself bounds nothing then), each round moves it a step,
// and at the third the end that moved jumps to the constant the function tests the parameter
// against. The test's own narrowing in the round after (`n !== 0` of 0 to 6 leaves 1 to 6) says
// whether the hull holds there; one that moves on opens.
const hulls = (src, names) => { compile(src, { optimize: 0 }); return names.map(n => JSON.stringify(ctx.summary.paramRangesOf(n))).join(' ') }
test('parameter hull: a recursion counting to a constant it tests settles there', () => {
  const src = `const v = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    const down = (n) => { if (n !== 0) { v[n - 1] = n; down(n - 1) } }
    const up = (c) => { if (c === 6) return; v[c] = c; up(c + 1) }
    const a = (k) => k > 5 ? 0 : a(k + 1)
    const b = (k) => { if (k >= 6) return 0; v[k] = k; return b(k + 1) }
    const c = (k) => { if (k <= 0) return 0; v[k] = k; return c(k - 1) }
    const d = (k) => { if (k < 1) return 0; v[k - 1] = k; return d(k - 1) }
    const by2 = (k) => { if (k < 10) { v[k] = k; by2(k + 2) } }
    const by3 = (k) => { if (k <= 0) return 0; v[k] = k; return by3(k - 3) }
    const flipped = (k) => { if (6 > k) { v[k] = 1; flipped(k + 1) } }
    const even = (n) => n === 0 ? 1 : odd(n - 1), odd = (n) => n === 0 ? 0 : even(n - 1)
    export const run = () => { down(6); up(0); by2(0); flipped(0); return a(0) + b(0) + c(6) + d(6) + by3(7) + even(6) * 50 + v[5] + v[10] * 3 + v.length * 100 }`
  is(hulls(src, ['down', 'up', 'a', 'b', 'c', 'd', 'flipped']), '[[0,6]] [[0,6]] [[0,6]] [[0,6]] [[0,6]] [[0,6]] [[0,6]]', 'a step of one, to the constant either arm of the test stops it at')
  is(hulls(src, ['by2', 'by3']), '[[0,11]] [[-2,7]]', 'a step past the constant: the hull a round after the jump records')
  is(hulls(src, ['even', 'odd']), '[[0,6]] [[0,5]]', 'two functions feeding each other')
  agree(src, 'run')
  for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) agree(src, 'run', [], { optimize })
})

test('parameter hull: a recursion past its test, of fractions, or with no test opens', () => {
  // (6, 4, 2, 0 by the source, but an interval under `!== 0` cannot say the step lands on 0)
  is(hulls(`const v = [0, 0, 0, 0, 0, 0, 0, 0]
    const f = (k) => { if (k !== 0) { v[k] = 1; f(k - 2) } }
    export const run = () => { f(6); return v[2] }`, ['f']), '[null]', 'a step of two under an equality')
  // (0.5, 1.5, 2.5, 3.5: the test leaves no integers, so it narrows nothing)
  is(hulls(`const q = (k) => { if (k < 3) q(k + 1) }
    export const run = () => { q(0.5); return 1 }`, ['q']), '[null]', 'fractions under an order test')
})

test('parameter hull: what a test leaves a name ends with its arm', () => {
  // (past the arm the name is 0 to 3 again; a hull the arm's 1 to 3 left would miss the call with 0)
  is(hulls(`const v = [0, 0, 0, 0]
    const w = (k) => v[k]
    const p = (k) => { if (k !== 0) { v[k] = 1 } return w(k) }
    export const run = () => p(0) + p(3)`, ['p', 'w']), '[[0,3]] [[0,3]]', 'the name past its arm')
})

// A function's stores decide nothing before a call has bound its parameters: the callee's hull
// settles a round after its caller's, and a store read before it would open the array for good.
// With the recursion's hull the swap's indexes are 0 to 5 and the literal keeps its six.
test('parameter hull: a callee of a recursion stores inside the array\'s length', () => {
  const src = `const v = [0, 0, 0, 0, 0, 0]
    let count = 0
    const swap = (i, j) => { const tmp = v[i]; v[i] = v[j]; v[j] = tmp }
    const permute = (n) => { count += 1; if (n !== 0) { const n1 = n - 1; permute(n1); for (let i = n1; i >= 0; i -= 1) { swap(n1, i); permute(n1); swap(n1, i) } } }
    export let run = (inner) => { let ok = 1; for (let k = 0; k < inner; k++) { count = 0; permute(6); if (count !== 8660) ok = 0 } return ok }`
  is(hulls(src, ['permute', 'swap']), '[[0,6]] [[0,5],[0,5]]', 'the recursion\'s argument and the indexes it hands on')
  for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) agree(src, 'run', [2], { optimize })
  if (belowOpt(2)) return
  const text = wat(src, { optimize: { level: 2, sourceInline: false, inlineFns: false } })
  is(/\$__arr_set|\$__ptr_offset_fwd|\$__esc_elem/.test(funcWat(text, 'swap')), false, 'the swap stores in place: nothing grows, nothing forwards, nothing is asked of the heap after')
  // (a counter from a parameter of integers down to zero: `fill`'s start is 3 to 5)
  const fill = `const v = [0, 0, 0, 0, 0, 0]
    const fill = (n) => { for (let i = n; i >= 0; i--) v[i] = n }
    export const run = () => { fill(3); fill(5); return v[4] * 10 + v[0] + v.length * 100 }`
  agree(fill, 'run')
  is(/\$__arr_set/.test(funcWat(wat(fill, { optimize: { level: 2, sourceInline: false, inlineFns: false } }), 'fill')), false, 'a descent from a parameter of integers stores in place')
  // (a hull of 1 to 2 with 1.5 in it bounds the store, a property's there, and is no index: the cell's own store would take 1.5 for 1)
  const fraction = `const v = [0, 0, 0, 0, 0, 0]
    const put = (i, x) => { v[i] = x }
    export const run = () => { put(1, 5); put(1.5, 6); put(2, 7); return v[1] * 100 + v[2] * 10 + (v[1.5] === 6 ? 1 : 0) + v.length * 1000 }`
  for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) agree(fraction, 'run', [], { optimize })
})

// Every channel that binds a function's parameters notes the call's arguments
// (summary `bind`): a call through a table or a function's property joins the
// hull like a direct call; one that cannot align them (`.call`, `.apply`, a
// callback) opens the position; a function the host or a dispatcher may call
// has no hull.
test('parameter hull: every call channel joins the hull, the host opens it', () => {
  is(JSON.stringify(ranges(`function esc(a) { return a * 2 }
    const fs = [esc]
    export const u = (i) => fs[+i](3) + esc(1)`, 'esc')), JSON.stringify([[1, 3]]), 'a table call joins the hull')
  is(ranges(`function esc(a) { return a * 2 }
    const fs = [esc]
    export const u = (i) => fs[i](3) + esc(1)`, 'esc'), null, 'an arbitrary property key can expose an unknown callable')
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
