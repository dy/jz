// A function chosen by a local and only called, a name that merely spells a
// function, an arrow returning a literal, a default an argument may need:
// each call stays a direct call the inliner can splice, and every result
// agrees with JS (plan/chosen-calls.js, plan/inline.js, program-facts).
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels, onWasi } from './_matrix.js'
import { oracle, wat } from './util.js'

const loopsOf = (text) => {
  const out = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    out.push(text.slice(at, end))
  }
  return out
}
const agrees = (src, calls) => {
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const [name, ...args] of calls) {
      const a = js[name](...args), b = m[name](...args)
      ok(Object.is(a, b), `${name}(${args.join(', ')}) at ${optimize}: ${b} for ${a}`)
    }
  }
}

// a filter's coefficient helpers, called through the one its type names
const filters = `const base = (w, q) => ({ c: 1 - w * w / 2, s: w - w * w * w / 6, a: (w - w * w * w / 6) / (2 * q) })
const norm = (b0, b1, a0, a1) => ({ b0: b0 / a0, b1: b1 / a0, a1: a1 / a0 })
function low (w, q = 0.5) { let { c, a } = base(w, q); return norm((1 - c) / 2, 1 - c, 1 + a, -2 * c) }
function high (w, q = 0.5) { let { c, a } = base(w, q); return norm((1 + c) / 2, -(1 + c), 1 + a, -2 * c) }
function band (w, q = 1) { let { c, a } = base(w, q); return norm(a, 0, 1 + a, -2 * c) }
export let run = (type, n, q) => {
  let fn = type === 'high' ? high : type === 'band' ? band : low
  const o = { q }
  let z = 0, out = 0
  for (let i = 0; i < n; i++) {
    let k = fn(0.1 + i * 0.01, o.q)
    let y = k.b0 * i + z
    z = k.b1 * i - k.a1 * y
    out += y
  }
  return out
}`

test('chosen calls: a local holding one of several functions calls each directly, the same results', () => {
  agrees(filters, [['run', 'low', 9, 0.7], ['run', 'high', 9, 0.7], ['run', 'band', 9, 0.7], ['run', 'band', 5, undefined], ['run', 'x', 0, 2]])
})

test('chosen calls: the loop calls no function value and allocates no coefficient record', () => {
  if (belowOpt(2)) return
  const text = wat(filters, { optimize: 2 })
  ok(!/call_indirect/.test(text), 'no indirect call')
  const loop = loopsOf(text).find(l => /f64\.div/.test(l)) ?? ''
  ok(loop, 'the sample loop')
  ok(!/call \$(low|high|band|norm|base)\b/.test(loop), 'each helper spliced into the loop')
  ok(!/__alloc/.test(loop), 'no record allocated per sample')
})

test('chosen calls: every place a call stands, and locals left as values', () => {
  const src = `function a (x) { return x + 1 } function b (x) { return x * 2 } function c (x) { return -x }
    let seen = 0
    function d (x) { seen++; return x }
    export let stmt = (t) => { let f = t ? a : b; f(3); return seen }
    export let ret = (t, x) => { const f = (t > 0 ? a : t < 0 ? c : b); return f(x) }
    export let assign = (t, x) => { let f = t ? a : b, r = 0; r = f(x); return r }
    export let nested = (t, x) => { let f = t ? a : b; return f(f(x) + 1) * 10 + f(2) }
    export let order = (t) => { let f = t ? d : a; let k = 0; return f((k += 5, k)) + f(k++) + k }
    export let value = (t, x) => { let f = t ? a : b; let g = f; return g(x) + f(x) }
    export let reassigned = (t, x) => { let f = t ? a : b; if (x > 5) f = c; return f(x) }
    export let captured = (t, x) => { let f = t ? a : b; let h = () => f(x); return h() }
    export let shadowed = (t, x) => { let f = t ? a : b; { let a = 7; x += a } return f(x) }`
  agrees(src, [['stmt', 1], ['stmt', 0], ['ret', 1, 4], ['ret', -1, 4], ['ret', 0, 4], ['assign', 1, 2], ['assign', 0, 2],
    ['nested', 1, 3], ['nested', 0, 3], ['order', 1], ['order', 0], ['value', 1, 3], ['value', 0, 3],
    ['reassigned', 1, 3], ['reassigned', 1, 9], ['reassigned', 0, 9], ['captured', 1, 2], ['captured', 0, 2], ['shadowed', 1, 1], ['shadowed', 0, 1]])
})

test('chosen calls: a string, a property or a key spelling a function leaves it inlinable', () => {
  const body = `function sq (x, y) { let a = x * x + y, b = a * 3 - x; return { p: a + b, q: b - a } }`
  const loop = (extra) => `${body} export let f = (o) => { let s = 0; for (let i = 0; i < 9; i++) { let r = sq(i, s % 7); s += r.p - r.q } return s ${extra} }`
  const srcs = [loop(''), loop(`+ (o.name || 'sq').length`), loop(`+ (o.sq ?? 1)`), loop(`+ ({ sq: 2 }).sq`)]
  // a host object reaches only the js host's module (the wasi host passes none)
  if (!onWasi()) for (const src of srcs) agrees(src, [['f', { name: 'abc', sq: 4 }], ['f', {}]])
  if (belowOpt(2)) return
  for (const src of srcs) ok(!/call \$sq\b/.test(wat(src, { optimize: 2 })), `sq spliced: ${src.slice(src.indexOf('return s'))}`)
})

test('chosen calls: an argument that may be undefined takes its default at the site', () => {
  const src = `function scale (x, k = 3, b = k) { return x * k + b }
    export let run = (o, n) => { let s = 0; for (let i = 0; i < n; i++) { let v = scale(i, o.k, o.b); s += v } return s }`
  if (!onWasi()) agrees(src, [['run', {}, 4], ['run', { k: 2 }, 4], ['run', { k: 2, b: 1 }, 4], ['run', { k: null }, 4], ['run', { b: null }, 4], ['run', { k: 0.5, b: -1 }, 3]])
  if (belowOpt(2)) return
  ok(!/call \$scale\b/.test(wat(src, { optimize: 2 })), 'scale spliced, its defaults tested in place')
})

test('chosen calls: a local each arm assigns a literal of the same keys is its fields', () => {
  const src = `export let run = (data, k) => { let s = 0
      for (let i = 0; i < data.length; i++) { let x = data[i]
        let c
        if (k === 0) c = { u: x * 2, v: x + 1 }
        else if (k === 1) { let t = x - 1; c = { v: t, u: t * t } }
        else c = { u: -x, v: 0 }
        s += c.u * c.v }
      return s }
    export let partial = (k) => { let c; if (k) c = { u: 1 }; return c.u }`
  const data = new Float64Array([1, 2.5, -3, 4])
  agrees(src, [['run', data, 0], ['run', data, 1], ['run', data, 2]])
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    is(m.partial(1), js.partial(1), `partial(1) at ${optimize}`)
    throws(() => m.partial(0), `partial(0) reads a field of undefined at ${optimize}`)
  }
  if (belowOpt(2)) return
  const loop = loopsOf(wat(src, { optimize: 2 })).find(l => /f64\.mul/.test(l)) ?? ''
  ok(loop && !/__alloc/.test(loop), 'no literal allocated per iteration')
})

test('chosen calls: a call whose body stores splices into a target naming its receiver and key', () => {
  const src = `function step (c, s, x) { let y = c.b0 * x + s[0]; s[0] = c.b1 * x - c.a1 * y + s[1]; s[1] = c.b2 * x - c.a2 * y; return y }
    const sec = { b0: 0.2, b1: 0.4, b2: 0.2, a1: -0.3, a2: 0.1 }, st = new Float64Array(2)
    export let run = (n) => { const b = new Float32Array(n).fill(1); for (let i = 0; i < b.length; i++) b[i] = step(sec, st, b[i]); return b[n - 1] + st[0] }
    export let alias = (n) => { const b = new Float64Array(n).fill(1); for (let i = 0; i < n; i++) b[i] = step(sec, b, b[i]); return b[0] + b[n - 1] }`
  agrees(src, [['run', 8], ['alias', 6]])
  if (belowOpt(2)) return
  ok(!/call \$step/.test(wat(src, { optimize: 2 })), 'step spliced into the loop')
})
