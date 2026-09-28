// The hull of the arguments a parameter receives over the function's direct
// calls (src/summary `argRanges`, `paramRangesOf`): a counter's span, the
// arithmetic on it, a caller's own hull through a chain of calls. A position
// some call leaves unbounded is null; a hull that keeps widening (a recursion
// feeding its own argument) opens; a function the host or a closure table may
// call has none. The emitter starts a parameter's flow interval from it, so a
// ToInt32 of `floor(y) + gy` inside a sampler needs no infinity guard.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
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
  is(ranges(`function esc(a) { return a * 2 }
    const fs = [esc]
    export const u = (i) => fs[i](3)`, 'esc'), null, 'a function a table may call takes anything')
  is(JSON.stringify(ranges(`function f(x) { return x }
    export const s = () => f(1) + f(...[2, 3])`, 'f')), JSON.stringify([null]), 'a spread argument leaves the position open')
  is(JSON.stringify(ranges(`function nz(v, out, o) { out[o] = v; return out }
    function m(v) { return nz(v, [0, 0], 0) }
    m.assign = nz
    const W = [0, 0]
    export const p = (v) => { m.assign(v, W, 5); return W.length + m(v)[0] }`, 'nz')), JSON.stringify([null, null, null]), 'a function also called through a property receives what no direct call shows')
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
