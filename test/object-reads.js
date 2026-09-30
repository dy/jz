// A key a loop reads of an object the function made and only reads is read
// once, where it is made (plan/object-reads.js): a dictionary built by a spread
// is hashed once a key, not once an iteration; anything that can change the
// object or see it keeps the reads where they are.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
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
const loopsOf = (text) => {
  const out = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    out.push(text.slice(at, end))
  }
  return out
}

test('object reads: a spread record a loop reads is hashed once a key', () => {
  const src = `const P = { a: { freq: 900, s: 1 }, b: { freq: 300, t: 2 } }
    export let f = (k, n) => { let p = { ...P[k], amp: 0.5 }; let s = 0; for (let i = 0; i < n; i++) s += (p.freq ?? 440) * p.amp + (p.t ?? 0); return s }`
  agrees(src, [['f', 'a', 5], ['f', 'b', 3], ['f', 'c', 2], ['f', 'a', 0]])
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 }), last = loopsOf(funcWat(text, 'f$exp') || funcWat(text, 'f')).at(-1)
  ok(last && !/call \$__(hash|dyn)/.test(last), 'the loop looks nothing up')
})

test('object reads: what can change or see the object keeps its reads', () => {
  agrees(`export let f = (k, n) => { let p = { freq: k }; let s = 0; for (let i = 0; i < n; i++) { s += p.freq; p.freq = i } return s }`, [['f', 1.5, 5]])
  agrees(`let bump = (o) => { o.freq++ }
    export let f = (k, n) => { let p = { freq: k }; let s = 0; for (let i = 0; i < n; i++) { s += p.freq; bump(p) } return s }`, [['f', 1.5, 5]])
  agrees(`export let f = (k, n) => { let p = { freq: k, g() { this.freq++; return 0 } }; let s = 0; for (let i = 0; i < n; i++) s += p.freq + p.g(); return s }`, [['f', 1.5, 5]])
  agrees(`export let f = (k, n) => { let p = { freq: k }; let w = () => { p.freq *= 2 }; let s = 0; for (let i = 0; i < n; i++) { s += p.freq; w() } return s }`, [['f', 1.5, 5]])
  agrees(`export let f = (k, n) => { let c = 0; let p = { get freq() { return ++c } }; let s = 0; for (let i = 0; i < n; i++) s += p.freq; return s + k }`, [['f', 1.5, 5]])
  agrees(`export let f = (k, n) => { let s = 0; for (let i = 0; i < n; i++) { let p = { freq: i * k }; for (let j = 0; j < 3; j++) s += p.freq } return s }`, [['f', 1.5, 5], ['f', 2, 0]])
})
