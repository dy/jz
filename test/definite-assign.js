// A bare declaration (`let t`) that its function assigns before every read
// never shows the undefined it was declared with (src/summary/definite.js):
// the summary declares it empty, and what it holds is what was assigned. A
// declaration some read can find unassigned stays absent.
import test from 'tst'
import { is } from 'tst/assert.js'
import { compile } from '../index.js'
import { ctx } from '../src/ctx.js'
import { definitelyAssigned } from '../src/summary/definite.js'
import { K, hasTag } from '../src/summary/kind.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, oracle, run, wat } from './util.js'

// [name, source, args, the bare declarations assigned before every read]
const programs = [
  // A `let` assigned once, in the one arm that reads it, is a `const` of that
  // arm after prepare: nothing is left for the walk to prove.
  ['assigned in one arm and read there', `const o = [0, 0], q = [3, 4]
    const t = (out, a) => { let a0, a1; if (a === out) { out[1] = a[0] } else { a0 = a[0]; a1 = a[1]; out[0] = a0; out[1] = a1 } return out }
    export const f = () => { t(o, q); return o[0] + o[1] }`, [], []],
  ['assigned in one arm, read there and after', `const o = [0, 0], q = [3, 4]
    const t = (out, a) => { let a0, a1; if (a === out) { out[1] = a[0] } else { a0 = a[0]; a1 = a[1]; out[0] = a0 + a1 } if (a[0] > 1) { a0 = 7; a1 = 8; out[1] = a0 * a1 } return out }
    export const f = () => { t(o, q); return o[0] + o[1] }`, [], ['a0', 'a1']],
  ['assigned in both arms, read after', `export const f = (c) => { let t; if (c > 0) { t = 1 } else { t = 2 } return t * 10 }`, [1], ['t']],
  ['assigned in one arm, read after', `export const f = (c) => { let t; if (c > 0) { t = 1 } return t === undefined ? -1 : t }`, [0], []],
  ['read before the assignment', `export const f = (c) => { let t; const r = t === undefined ? 7 : 0; t = c; return r + t }`, [1], []],
  ['a loop body that may not run', `export const f = (n) => { let t; for (let i = 0; i < n; i++) { t = i } return t === undefined ? -1 : t }`, [0], []],
  // Assigned in the body and read only there: prepare declares it in the body, with its value.
  ['assigned then read inside a loop', `export const f = (n) => { let t, s = 0; for (let i = 0; i < n; i++) { t = i * 2; s += t } return s }`, [4], []],
  ['a closure made before the assignment', `export const f = (n) => { let t; const g = () => t === undefined ? -1 : t; const r = g(); t = n; return r + g() }`, [5], []],
  // The one assignment makes it a `const` after prepare: nothing is left to prove.
  ['a closure made after the assignment', `export const f = (n) => { let t; t = n; const g = () => t + 1; return g() }`, [5], []],
  ['an arm that returns', `export const f = (c) => { let t; if (c > 0) return 0; else t = 5; return t }`, [0], ['t']],
  ['a conditional assigning in both arms', `export const f = (c) => { let t; c > 0 ? (t = 1) : (t = 2); return t }`, [0], ['t']],
  ['a right side that may not run', `export const f = (c) => { let t; c > 0 && (t = 1); return t === undefined ? -1 : t }`, [0], []],
  ['a compound assignment reads first', `export const f = (c) => { let t; t += c; return t !== t ? 1 : 0 }`, [2], []],
  ['a try body that may leave early', `const bad = (c) => { if (c > 0) throw new Error('x'); return 1 }
    export const f = (c) => { let t; try { bad(c); t = 1 } catch (e) { } return t === undefined ? -1 : t }`, [1], []],
  ['a pattern assignment', `export const f = (c) => { let a, b; [a, b] = [c, c * 2]; return a + b }`, [3], ['a', 'b']],
  ['a switch that may skip', `export const f = (c) => { let t; switch (c) { case 1: t = 5; break } return t === undefined ? -1 : t }`, [2], []],
  ['a loop test that assigns', `let k = 0
    const next = () => { k = k + 1; return k <= 3 ? k : -1 }
    export const f = () => { let v, s = 0; while ((v = next()) > 0) s += v; return s + v }`, [], ['v']],
]

const source = name => name.replace(/[^A-Za-z0-9_$].*$/, '')

test('definite assignment: the declarations assigned before every read', () => {
  for (const [name, src, , want] of programs) {
    compile(src, { optimize: 0 })
    const found = new Set()
    for (const fn of ctx.funcs.list) if (fn.body) for (const n of definitelyAssigned(fn.body)) found.add(source(n))
    is([...found].sort().join(), [...want].sort().join(), name)
  }
})

test('definite assignment: every program matches the host', () => {
  for (const [name, src, args] of programs)
    for (const optimize of levels(0, 1, 2, 3)) agree(src, 'f', args, { optimize }, `${name} at ${optimize}`)
})

test('definite assignment: such a binding holds what was assigned, never absence', () => {
  compile(`const o = [0, 0], q = [3, 4]
    const t = (out, a) => { let a0, late; if (a === out) { out[1] = a[0] } else { a0 = a[0]; out[0] = a0 } late = late === undefined ? 1 : 2; return out }
    export const f = () => { t(o, q); return o[0] + o[1] }`, { optimize: 0 })
  const fn = ctx.funcs.map.get('t'), view = ctx.summary.at(fn.body)
  const spelled = name => JSON.parse(JSON.stringify(fn.body).match(new RegExp('"' + name + '[^"A-Za-z0-9_$][^"]*"'))[0])
  is(hasTag(view.kindOf(spelled('a0')), K.ABSENT), false, 'assigned before its reads')
  is(hasTag(view.kindOf(spelled('late')), K.ABSENT), true, 'read before its assignment')
  is(view.fixedLenOf('o'), 2, 'the array it is stored into keeps its elements present and its count')
})

// The module's own bare declarations: its statements run once, in order, and a
// function runs where one names it or, called by the host, after they end. A
// name assigned on every path before each read, and on every path to the end
// where a function reads it, never shows its `undefined`; any other stays
// absent, and an integer global a read can observe unassigned keeps the f64
// carrier (an i32 would read 0 where the host reads undefined).
// [name, source, the binding, whether a read can find it unassigned]
const modules = [
  ['both arms assign, read after (stdlib indices.js)', `var le = Math.random() < 2
    var H
    if (le === true) { H = 1 } else { H = 0 }
    var O = { H: H }
    var H2 = O.H
    export let f = (x) => x + H2 + H`, 'H2', false],
  ['one arm assigns', `var le = Math.random() < 2
    var H
    if (le === true) { H = 1 }
    export let f = (x) => x + (H === undefined ? 5 : H)`, 'H', true],
  ['read before the assignment', `var H
    var G = H
    H = 1
    export let f = (x) => x + (G === undefined ? 5 : G) + H`, 'G', true],
  ['a function called before the assignment reads it', `var H
    function g() { return H }
    var G = g()
    H = 1
    export let f = (x) => x + (G === undefined ? 5 : G) + H`, 'H', true],
  ['a function named before the assignment (a callback)', `var H
    function g() { return H }
    var G = [1].map(g)[0]
    H = 1
    export let f = (x) => x + (G === undefined ? 5 : G) + H`, 'H', true],
  ['a function called after the assignment', `var H
    H = 2
    function g() { return H * 2 }
    var G = g()
    export let f = (x) => x + G + H`, 'G', false],
  ['assigned in a function the host calls', `var H
    export let set = (v) => { H = v }
    export let f = (x) => x + (H === undefined ? 5 : H)`, 'H', true],
  ['a loop that may not run', `var H
    for (let i = 0; i < Math.random() * 2 - 5; i++) H = 1
    export let f = (x) => x + (H === undefined ? 5 : H)`, 'H', true],
  // The member's binding is read through its getter, which no statement names.
  ['a prototype member read before its store', `let n = 4
    class V { constructor() { this.x = 1 } }
    const a = new V()
    const before = a.k === undefined ? 1 : 0
    V.prototype.k = n * 2
    export let f = (x) => before * 100 + a.k + x`, null, true],
  ['a typeof test of the unassigned', `var H
    var G = H
    H = 1
    export let f = (x) => x + (typeof G === 'undefined' ? 5 : G) + H`, 'G', true],
]

test('definite assignment: a module declaration assigned on every path holds what was assigned', () => {
  for (const [name, src, binding, absent] of modules) {
    if (binding === null) continue   // a binding the lowering names: the host's answer below is its pin
    compile(src, { optimize: 0 })
    const k = ctx.summary.at(null).kindOf(binding)
    is(hasTag(k, K.ABSENT) || hasTag(k, K.NULLISH), absent, name)
  }
})

test('definite assignment: every module matches the host', () => {
  for (const [name, src] of modules)
    for (const optimize of levels(0, 1, 2, 3)) agree(src, 'f', [1], { optimize }, `${name} at ${optimize}`)
})

// The integer-global inference (plan/scope.js inferModuleIntGlobals) stores a
// module number as i32. One a read can find unassigned or null, where a read
// observes that (a presence test, the value handed on), keeps f64: an i32
// reads 0 there. One read only as a number, or one with a value from its
// declaration, stays i32.
// [name, source, the call, the global, its storage]
const globals = [
  ['null at first, tested for it', `let H = null
    export let set = (v) => { H = v | 0 }
    export let f = () => H === null ? 5 : H`, e => e.f(), 'H', 'f64'],
  ['null at first, read after the store', `let H = null
    export let set = (v) => { H = v | 0 }
    export let f = () => { set(3); return H === null ? 5 : H }`, e => e.f(), 'H', 'f64'],
  ['unassigned, tested loosely', `let H
    export let set = (v) => { H = v | 0 }
    export let f = () => H == null ? 5 : H`, e => e.f(), 'H', 'f64'],
  ['unassigned, tested by truth', `let H
    export let set = (v) => { H = v | 0 }
    export let f = () => H ? 1 : 2`, e => e.f(), 'H', 'f64'],
  ['unassigned, returned as it is', `let H
    export let set = (v) => { H = v | 0 }
    export let f = () => H`, e => String(e.f()), 'H', 'f64'],
  ['unassigned, handed to a function that tests it', `let H
    function t(v) { return v === undefined ? 5 : v }
    export let set = (v) => { H = v | 0 }
    export let f = () => t(H)`, e => e.f(), 'H', 'f64'],
  ['read only as a number (a loop bound)', `let N
    export let init = (k) => { N = k | 0 }
    export let f = () => { init(4); let s = 0; for (let i = 0; i < N; i++) s += i; return s }`, e => e.f(), 'N', 'i32'],
  ['declared with its value', `let W = 0
    export let init = (k) => { W = k | 0 }
    export let f = () => { init(4); return W * 2 }`, e => e.f(), 'W', 'i32'],
]

test('integer global: one a read can observe unassigned keeps the f64 carrier', () => {
  for (const [name, src, call, g, storage] of globals) {
    const want = call(oracle(src))
    for (const optimize of levels(0, 1, 2, 3)) is(call(run(src, { optimize })), want, `${name} at ${optimize}`)
    if (belowOpt(2)) continue
    const decl = wat(src, { optimize: 2 }).match(new RegExp('\\(global \\$' + g + '\\s[^\\n]*'))?.[0] ?? ''
    is(/\bi32\b/.test(decl) ? 'i32' : 'f64', storage, `${name}: $${g} is ${storage}`)
  }
})
