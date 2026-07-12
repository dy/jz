// jz/transform — jzify as a standalone source→source tool (full JS in,
// canonical jz out). Same jzify/ module the compiler runs default-on; this
// entry is for tooling and the REPL's auto-jzify-on-paste. The gate that
// matters: the transformed source COMPILES and runs identical to the input.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import transform, { } from '../transform.js'

const runs = (src) => jz(src).exports.f()

test('transform: root entry re-exports the same function', async () => {
  const { transform: rootTransform } = await import('../index.js')
  is(rootTransform, transform)
})

test('transform: lowered output compiles and matches the original', () => {
  const cases = [
    `var x = 1; export function f() { return x == null ? 0 : x + 2 }`,
    `function P(n){this.n=n} P.prototype.get=function(){return this.n*2}
     export function f(){ return new P(21).get() }`,
    // (`;` after the switch block: jessie has no ASI there — upstream gap)
    `export function f(){ let r=''; switch(2){ case 1: r='a'; break; case 2: r='b'; default: r+='!' }; return r }`,
    `class A { constructor(x){this.x=x} static make(v){ return new A(v) } }
     export let f = () => A.make(7).x`,
    `function* g(n){ for (let i=0;i<n;i++) yield i }
     export let f = () => [...g(4).map((x)=>x*10)].join(',')`,
  ]
  for (const src of cases) {
    const out = transform(src)
    ok(!/\bvar\b|\bswitch\b|\bfunction\b/.test(out.replace(/'[^']*'/g, '')), `lowered: ${out.slice(0, 60)}`)
    is(runs(out), runs(src), `equal result for: ${src.slice(0, 50)}`)
  }
})

test('transform: unified parse — NaN marker prints back, shebang stripped', () => {
  is(transform('export let f = () => NaN'), 'export let f = () => NaN')
  ok(transform('#!/usr/bin/env node\nexport let x = 1').includes('export let x = 1'))
})

test('transform: canonical jz passes through compilable', () => {
  const src = `export let f = (a) => { let s = 0; for (const v of [1, 2, a]) s += v; return s }`
  is(runs(transform(src)), runs(src))
})

test('transform: onlyLowered — null for canonical source (bytes/comments kept), source for real lowerings', () => {
  is(transform('export let f = (x) => x * 2  // doubles', { onlyLowered: true }), null)
  is(transform('export let f = () => 1n << 3n', { onlyLowered: true }), null)
  const t = transform('var x = 1; export function f() { return x }', { onlyLowered: true })
  ok(t != null && !/\bvar\b|\bfunction\b/.test(t), 'full-JS forms lower')
})
