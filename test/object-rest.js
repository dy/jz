// Object rest: `{a, ...r} = o` binds `r` to the spread of `o` without `a`
// (ES CopyDataProperties with the pattern's keys excluded), whatever `o` is.
// A source whose layout the program knows copies its slots; any other (a host
// object, a dictionary, a union of layouts, a string or an array) copies its
// own enumerable keys at run time, integer keys first. Every program runs
// against the host, at every level, key order included.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels, onWasi } from './_matrix.js'
import { oracle } from './util.js'
import { parse, has } from '../scripts/wat-probe.mjs'

// JSON keeps key order; undefined and a thrown TypeError get names of their own
const show = (v) => JSON.stringify(v, (k, x) => x === undefined ? '<undefined>' : x)
const outcome = (f) => { try { return show(f()) } catch (e) { return e instanceof TypeError ? 'TypeError' : 'throws ' + e.message } }
// a host object stays behind the JS boundary: the hostless WASI one cannot pass it in
const hostObject = (v) => v !== null && typeof v === 'object' && (!Array.isArray(v) || v.some(hostObject))
const agree = (cases) => {
  for (const [name, src, ...args] of cases) for (const optimize of levels(0, 2, 3)) {
    if (onWasi() && args.some(hostObject)) continue
    const want = outcome(() => oracle(src).f(...args))
    is(outcome(() => jz(src, { optimize }).exports.f(...args)), want, `${name} O${optimize}`)
  }
}

test('object rest: a host object', () => agree([
  ['named keys', `export let f = (o) => { let {a, ...r} = o; return r }`, { z: 0, a: 1, b: 2, 3: 'x', 1: 'y' }],
  ['key order', `export let f = (o) => { let {a, ...r} = o; return Object.keys(r).join() }`, { z: 0, a: 1, b: 2, 3: 'x', 1: 'y' }],
  ['no named keys', `export let f = (o) => { let {...r} = o; return r }`, { a: 1, b: [2] }],
  ['absent keys', `export let f = (o) => { let {a, b, ...r} = o; return [a, b, r] }`, { b: 2, c: 3 }],
  ['a copy', `export let f = (o) => { let {a, ...r} = o; r.b = 9; r.z = 1; return [o.b, r] }`, { a: 1, b: 2 }],
  ['an array', `export let f = ({0: a, ...r}) => [a, r]`, [1, 2, 3]],
  ['a string', `export let f = ({length, ...r}) => [length, r]`, 'ab'],
  ['a number', `export let f = ({...r}) => r`, 7],
]))

test('object rest: null and undefined throw, a default does not', () => agree([
  ['declaration of null', `export let f = (o) => { let {a, ...r} = o; return r }`, null],
  ['rest alone of undefined', `export let f = (o) => { let {...r} = o; return r }`, undefined],
  ['empty pattern', `export let f = (o) => { let {} = o; return 1 }`, null],
  ['parameter of null', `export let f = ({a = 5, ...r} = {}) => [a, r]`, null],
  ['parameter default', `export let f = ({a = 5, ...r} = {}) => [a, r]`],
  ['parameter given', `export let f = ({a = 5, ...r} = {}) => [a, r]`, { a: 1, q: 2 }],
  ['nested null', `export let f = (o) => { let {p: {...r}} = o; return r }`, { p: null }],
]))

test('object rest: objects of the module', () => agree([
  ['known layout', `export let f = (n) => { let o = {a: n, b: 2, c: 'c'}; let {a, ...r} = o; return [a, r, r.b, r.a] }`, 1],
  ['literal source', `export let f = () => { let {a, ...r} = {a: 1, b: 2, c: 3}; return Object.keys(r).join() }`],
  ['a later field', `export let f = () => { let o = {a: 1, b: 2}; o.c = 3; let {a, ...r} = o; return Object.keys(r).join() }`],
  ['module scope', `let o = {a: 1, b: 'two', c: [3]}; let {a, ...r} = o; export let f = () => [a, r, r.c[0]]`],
  ['union of layouts', `export let f = (c) => { let o = c ? {a: 1, b: 2} : {b: 'x', d: 4}; let {b, ...r} = o; return [b, r, r.a, r.d] }`, 0],
  ['union, other arm', `export let f = (c) => { let o = c ? {a: 1, b: 2} : {b: 'x', d: 4}; let {b, ...r} = o; return [b, r, r.a, r.d] }`, 1],
  ['dictionary', `export let f = (ks) => { let o = {}; for (let k of ks) o[k] = k.length; let {a, ...r} = o; let s = 0; for (let k in r) s += r[k]; return [a, r, s] }`, ['a', 'bb', 'ccc']],
  ['class instance', `class P { constructor() { this.x = 1; this.y = 2 } m() { return 3 } }; export let f = () => { let {x, ...r} = new P(); return [x, r] }`],
  ['everything named', `export let f = () => { let {a, b, ...r} = {a: 1, b: 2}; return [r, Object.keys(r).length] }`],
  ['rest of a rest', `export let f = (o) => { let {a, ...r} = o; let {b, ...q} = r; return [a, b, q] }`, { a: 1, b: 2, c: 3 }],
]))

test('object rest: getters run for the copied keys only', () => agree([
  ['named getter', `export let f = () => { let n = 0; let o = { get a() { n++; return 1 }, get b() { n += 10; return 2 } }; let {a, ...r} = o; return [a, r, n] }`],
  ['all copied', `export let f = () => { let n = 0; let o = { get a() { n++; return 1 }, get b() { n += 10; return 2 } }; let {...r} = o; return [r, n] }`],
]))

test('object rest: computed keys', () => agree([
  ['runtime key', `export let f = (k, o) => { let {[k]: v, ...r} = o; return [v, r] }`, 'b', { a: 1, b: 2, c: 3 }],
  ['number key', `export let f = (k, o) => { let {[k]: v, ...r} = o; return [v, r] }`, 1, { 1: 'one', b: 2 }],
  ['absent key', `export let f = (k, o) => { let {[k]: v, ...r} = o; return [v, r] }`, 'zz', { a: 1 }],
  ['null source', `export let f = (k, o) => { let {[k]: v, ...r} = o; return [v, r] }`, 'zz', null],
  ['known layout', `export let f = (k) => { let o = {a: 1, b: 2, c: 3}; let {[k]: v, ...r} = o; return [v, r, r.a] }`, 'b'],
  ['constant key', `const K = 'b'; export let f = () => { let o = {a: 1, b: 2, c: 3}; let {[K]: v, ...r} = o; return [v, r] }`],
  ['literal key', `export let f = () => { let o = {a: 1, b: 2, c: 3}; let {['a']: v, ...r} = o; return [v, r] }`],
  ['folded key', `export let f = (o) => { let {[1 + 1]: x, ...r} = o; return [x, r] }`, { 2: 'two', c: 3 }],
]))

test('object rest: quoted and numeric keys', () => agree([
  ['quoted', `export let f = (o) => { let {'a-b': x, ...r} = o; return [x, r] }`, { 'a-b': 1, c: 2 }],
  ['number', `export let f = (o) => { let {"q": x, 1.5: y, ...r} = o; return [x, y, r] }`, { q: 1, '1.5': 2, c: 3 }],
  ['quoted index', `export let f = (o) => { let {'0': x, length} = o; return [x, length] }`, [7, 8]],
  ['not an index', `export let f = (o) => { let {'01': x, ...r} = o; return [x, r] }`, { '01': 1, 1: 2 }],
]))

test('object rest: assignment and loop patterns', () => agree([
  ['statement', `export let f = (o) => { let a, r; ({a, ...r} = o); return [a, r] }`, { a: 1, b: 2 }],
  ['rest alone', `export let f = (o) => { let r; ({...r} = o); return r }`, { a: 1, b: 2 }],
  ['rest alone of null', `export let f = (o) => { let r; ({...r} = o); return r }`, null],
  ['value', `export let f = (o) => { let a, r; let v = ({a, ...r} = o); return [v === o, r] }`, { a: 1, b: 2 }],
  ['nested', `export let f = (o) => { let {p: {a, ...r}, ...s} = o; return [a, r, s] }`, { p: { a: 1, b: 2 }, q: 3 }],
  ['in an array pattern', `export let f = (o) => { let [{a, ...r}] = o; return [a, r] }`, [{ a: 1, c: 3 }]],
  ['for of', `export let f = (xs) => { let out = []; for (let {id, ...rest} of xs) out.push(Object.keys(rest).length + id); return out }`, [{ id: 1, a: 1 }, { id: 2, b: 1, c: 2 }]],
]))

test('object rest: spread and read downstream', () => agree([
  // @audio/synth-fm: a voice's options pass on to another voice
  ['fm voice', `let fm = (freq, { ratio = 1, index = 1, duration = 1 } = {}) => freq * ratio + index + duration
    let bell = (freq = 440, { duration = 4, ...opts } = {}) => fm(freq, { ratio: 1.4, index: 10, duration, ...opts })
    export let f = (o) => bell(220, o)`, { ratio: 2 }],
  ['fm voice, defaults', `let fm = (freq, { ratio = 1, index = 1, duration = 1 } = {}) => freq * ratio + index + duration
    let bell = (freq = 440, { duration = 4, ...opts } = {}) => fm(freq, { ratio: 1.4, index: 10, duration, ...opts })
    export let f = (o) => bell(220, o)`],
  ['fm voice, module caller', `let fm = (freq, { ratio = 1, index = 1, duration = 1 } = {}) => freq * ratio + index + duration
    let bell = (freq = 440, { duration = 4, ...opts } = {}) => fm(freq, { ratio: 1.4, index: 10, duration, ...opts })
    export let f = (c) => bell(100, c ? { ratio: 3 } : { index: 5, duration: 2 }) + bell(100)`, 0],
  ['spread back', `export let f = (o) => { let {a, ...r} = o; let s = {...r, z: 9}; return [s.b, s.z, s.a, Object.keys(s).join()] }`, { a: 1, b: 2 }],
  ['returned', `let g = ({x = 1, ...o} = {}) => ({ y: 2, x, ...o }); export let f = (p) => [g(p), g({x: 4, w: 'w'}).w]`, { y: 5, x: 3 }],
  ['stringified', `export let f = (o) => { let {a, ...r} = o; return JSON.stringify(r) + typeof r }`, { a: 1, b: [1, { c: 2 }] }],
]))

test('object rest: a known layout copies its slots', () => {
  const tree = parse(`export let f = (n) => { let o = {a: n, b: 2, c: 3}; let {a, ...r} = o; return r.b + r.c }`, 0)
  // Exported reflection helpers can carry dictionaries of their own.
  const fn = tree.find(n => n[0] === 'func' && n[1] === '$f')
  ok(fn, 'the source function is present')
  ok(!has(fn, n => n[0] === 'call' && n[1] === '$__hash_new'), 'no dictionary: the rest is a layout of its own')
  ok(!has(fn, n => n[0] === 'call' && n[1] === '$__str_eq'), 'no key compares at run time')
})

test('object rest: the fields of a rest whose source layout only the summary knows read as slots', () => {
  const src = `let g = ({a, ...r}) => r.b * 2 + r.c\nexport let f = (n) => g({a: 1, b: n, c: 3}) + g({a: 2, b: 5, c: n})`
  for (const optimize of levels(0, 2, 3)) {
    is(jz(src, { optimize }).exports.f(4), oracle(src).f(4), `O${optimize}`)
    // Reflection exports may link generic readers. The source functions and
    // their rest-specialized copies must still read these fields as slots.
    const functions = parse(src, optimize).filter(n => n[0] === 'func' && !n[1].startsWith('$__'))
    ok(functions.length && functions.every(fn => !has(fn, n => n[0] === 'call' && /^\$__dyn_get/.test(n[1]))), `a layout of its own O${optimize}`)
  }
})
