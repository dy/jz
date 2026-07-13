// jz/transform — jzify as a standalone source→source tool (full JS in,
// canonical jz out). Same jzify/ module the compiler runs default-on; this
// entry is for tooling and the REPL's auto-jzify-on-paste. The gate that
// matters: the transformed source COMPILES and runs identical to the input.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import transform, { } from '../transform.js'

const runs = (src, ...args) => jz(src).exports.f(...args)

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
    // strip BOTH quote forms: codegen prints strings double-quoted, and the
    // injected runtimes carry `typeof x !== "function"` guards
    ok(!/\bvar\b|\bswitch\b|\bfunction\b/.test(out.replace(/'[^']*'|"[^"]*"/g, '')), `lowered: ${out.slice(0, 60)}`)
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
  // `==` is not canonical — its rewrite counts as a lowering
  ok(transform('export let f = (x) => x == 0', { onlyLowered: true }) != null, '== counts as lowering')
})

// `export var` can't keep the keyword on the hoisted declarator (`export x = 1`
// is not JS). Values hoist + assign + `export { }` clause; function-valued
// declarators stay in place as `export let f = fn` (a function binding, not a
// closure-valued global). The output must run as JS AND compile as jz.
test('transform: export var — valid JS output, values and functions intact', async () => {
  const src = 'export var a = 1, b = 2; export var f = function (x) { return x * a + b }; export var [p, q] = [3, 4]'
  const out = transform(src)
  ok(!/export\s+[A-Za-z_$][\w$]*\s*=/.test(out), 'no `export name =` (invalid JS) left')
  const js = await import('data:text/javascript,' + encodeURIComponent(out))
  is([js.a, js.b, js.f(3), js.p, js.q].join(','), '1,2,5,3,4', 'runs as JS with live bindings')
  const m = jz(out)
  is([m.exports.a.value, m.exports.b.value, m.exports.f(3), m.exports.p.value, m.exports.q.value].join(','), '1,2,5,3,4', 'compiles as jz')
})

// Equality canonicalization (converter-only; compile path keeps JS-loose `==`).
// jz's `==` coerces statically-known mixed types like JS, so the rewrite is
// by proof: null idiom → two-arm test, typeof/same-type literals → strict op,
// mixed literals → folded constant, anything else → strict op + eqeq advisory.
test('transform: == canonicalizes — null idiom exact, typeof silent, literals fold, rest advised', async () => {
  const out = transform('export let f = (x) => x == null ? 1 : 0')
  is(out, 'export let f = (x) => x === null || x === undefined ? 1 : 0')
  const js = await import('data:text/javascript,' + encodeURIComponent(out))
  const g = jz(out).exports.f
  is([js.f(undefined), js.f(null), js.f(0), g(undefined), g(null), g(0)].join(','), '1,1,0,1,1,0', 'undefined still matches, as JS and as jz')
  // effectful operand binds once (IIFE), not twice
  const src2 = 'let n = 0; let get = () => { n += 1; return null }; export let f = () => { let r = get() != null; return n * 10 + (r ? 1 : 0) }'
  is(runs(transform(src2)), runs(src2), 'single evaluation of effectful operand')
  is(transform('export let f = (x) => typeof x == "number"'), 'export let f = (x) => typeof x === "number"')
  is(transform('export let f = () => 1 == "1"'), 'export let f = () => true', 'mixed literals fold to the loose result')
  const warnings = { entries: [] }
  transform('let a = 1\nlet b = 2\nexport let f = () => a == b', { warnings })
  is(warnings.entries.map(w => `${w.code}:${w.line}`).join(','), 'eqeq:3', 'unproven site advised with source line')
  const silent = { entries: [] }
  transform('export let f = (x) => x == null || typeof x == "number"', { warnings: silent })
  is(silent.entries.length, 0, 'proven rewrites carry no advisory')
})

// THE round-trip the CLI advertises: `jz --jzify lib.js → lib.jz`, and `.jz`
// implies strict — so the converter's output must compile under strict.
test('transform: output compiles under strict (.jz round-trip)', () => {
  const out = transform('export var s = 2\nexport function f(x) { if (x == 0) return 0; return Math.abs(x) * s }')
  is(jz(out, { strict: true }).exports.f(-3), 6)
})

// try/catch/finally printing (codegen had no `try` printer — output was unparseable)
// + precedence-aware printing: synthesized trees carry no `()` group nodes, so
// a `||` under `&&` must parenthesize, `??` may not mix bare with `&&`/`||`.
test('transform: try/catch/finally and synthesized precedence re-parse', async () => {
  const src = 'export let f = (x) => { let r = 0; try { if (x < 0) throw "neg"; r = x } catch (e) { r = -1 } finally { r += 10 } return r }'
  const out = transform(src)
  is([runs(out, 5), runs(out, -5)].join(','), '15,9', 'try/catch/finally round-trips')
  const mixed = transform('export let f = (a, b) => a != null && b == null ? 1 : 0')
  const js = await import('data:text/javascript,' + encodeURIComponent(mixed))
  const g = jz(mixed).exports.f
  is([js.f(1, null), js.f(1, 1), g(1, null), g(1, 1)].join(','), '1,0,1,0', '|| under && parenthesized, JS ≡ jz')
  for (const s of ['export let f = (a, b, c) => (a || b) && c', 'export let f = (a, b) => a ?? (b || 1)']) {
    const once = transform(s)
    is(transform(once), once, `fixed point: ${s.slice(19)}`)
  }
})
