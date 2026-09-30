// A member no object the receiver may be ever holds reads undefined with no
// lookup (summary/query.js absentMember): an options key the caller's literal
// leaves out (`opts.release ?? 300`) is its default, not a probe per read.
// Anything that can give an object the key keeps the lookup.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels } from './_matrix.js'
import { oracle, wat, funcWat } from './util.js'

const res = (f) => { try { return f() } catch (e) { return 'throws ' + e.constructor.name } }
const agrees = (src, calls) => {
  for (const optimize of levels(0, 2, 3)) {
    const js = oracle(src), m = jz(src, { optimize }).exports
    for (const [name, ...args] of calls) {
      const a = res(() => js[name](...args)), b = res(() => m[name](...args))
      ok(Object.is(a, b) || a === b, `${name}(${args.join(', ')}) at ${optimize}: ${b} for ${a}`)
    }
  }
}

test('absent member: a key no literal holds and no store adds reads undefined', () => {
  const src = `let stream = (opts) => { let g = 0; return (x) => { g = g * 0.5 + x * (opts.release ?? 300) * opts.gain; return g } }
    export let f = (n) => { let s = stream({ gain: 2 }), t = 0; for (let i = 0; i < n; i++) t = s(i); return t }`
  agrees(src, [['f', 4], ['f', 0]])
  for (const optimize of levels(2, 3)) ok(!/__dyn_get|__hash_get/.test(wat(src, { optimize })), `no lookup at ${optimize}`)
})

test('absent member: whatever can give the object the key keeps the lookup', () => {
  agrees(`export let f = (x) => { let o = { a: x }; Object.assign(o, { rel: 7 }); return (o.rel ?? 3) + o.a }`, [['f', 5]])
  agrees(`let o = { a: 1 }; export let f = (x) => { if (x > 2) o.rel = x; return o.rel ?? 3 }`, [['f', 1], ['f', 5], ['f', 2]])
  agrees(`export let f = (x, k) => { let o = { a: 1 }; o[k] = x; return o.rel ?? 3 }`, [['f', 5, 'rel'], ['f', 5, 'b']])
  agrees(`export let f = (x) => { let a = { rel: x }; let o = { ...a, b: 1 }; return o.rel ?? 3 }`, [['f', 5]])
  agrees(`export let f = (s) => { let o = JSON.parse(s); return o.rel ?? 3 }`, [['f', '{"rel":9}'], ['f', '{}']])
  agrees(`let g = (o = {}) => o.rel ?? 3; export let f = (x) => g({ a: x }) + g() + g({ rel: x })`, [['f', 5]])
  agrees(`class P { m() { return 4 } get q() { return 6 } }; export let f = () => { let p = new P(); return p.m() + (p.q ?? 1) + (p.r ?? 2) }`, [['f']])
  agrees(`export let f = (x) => { let o = { get g() { return x } }; return o.g + (o.h ?? 2) }`, [['f', 3]])
})

test('absent member: a missing receiver still throws, and one the read evaluates still runs', () => {
  agrees(`let g = (o) => o.rel; export let f = (x) => { try { return g(x > 0 ? { a: 1 } : null) ?? 3 } catch (e) { return -1 } }`, [['f', 5], ['f', -5]])
  agrees(`let n = 0; let mk = () => { n++; return { a: 1 } }; export let f = () => { let r = mk().rel ?? 3; return r * 10 + n }`, [['f'], ['f']])
})
