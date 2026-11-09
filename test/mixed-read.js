// A read of a name on a value that may be a primitive or an object of a few
// layouts (an array of numbers holding a record and a string: the summary's
// cell of a shape beside primitives, summary/query.js mixedLayoutsOfExpr)
// needs no lookup: a layout holding the name reads its slot behind its guard,
// a missing value throws the TypeError the read throws, and every other value
// reads undefined where none of its primitive's prototypes holds the name
// (module/core.js mixedRead). A ToNumber of the read sees a number or
// undefined. A name a value may hold another way keeps the lookup.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { oracle, wat, jz } from './util.js'

const res = (f) => { try { return f() } catch (e) { return 'throws ' + e.constructor.name } }
const agrees = (src, calls) => {
  for (const optimize of levels(0, 'size', 2, 3)) {
    const js = oracle(src), m = jz(src, { optimize }).exports
    for (const [name, ...args] of calls) {
      const a = res(() => js[name](...args)), b = res(() => m[name](...args))
      ok(Object.is(a, b) || a === b, `${name}(${args.join(', ')}) at ${optimize}: ${b} for ${a}`)
    }
  }
}
// (the lookup's own helpers too: the optimizer may inline the dispatcher)
const lookups = (src, optimize) => (wat(src, { optimize }).match(/\$__(dyn_get|hash_get|ext_get|key_eq)\w*/g) ?? []).length

const MK = `const mk = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); a[1] = { value: 7, w: 2 }; a[2] = 'payload'; return a }`

test('mixed read: a record beside numbers and a string reads its slot, every other value undefined', () => {
  const sum = MK + `
export let f = (n) => { const a = mk(n); let s = 0; for (let i = 0; i < a.length; i++) { const v = a[i].value; if (v !== undefined) s += v * 10 + i } return s }`
  // an element read is the receiver: read once, tested per layout
  const elem = MK + `
export let f = (n) => { const a = mk(n); return a[1].value + (a[0].w === undefined ? 10 : 0) + (a[2].value === undefined ? 100 : 0) }`
  // the arms a typeof test leaves (the bench's fold)
  const fold = MK + `
export let f = (n) => { const a = mk(n); let h = 0; for (let i = 0; i < a.length; i++) { const v = a[i]; h = h * 31 + (typeof v === 'number' ? v : typeof v === 'string' ? v.length : v.value) } return h }`
  for (const src of [sum, elem, fold]) {
    agrees(src, [['f', 4], ['f', 9]])
    for (const optimize of levels('size', 2, 3)) ok(lookups(src, optimize) === 0, `no lookup at ${optimize}: ${src.split('\n')[1]}`)
  }
})

test('mixed read: ToNumber of the read converts a number or undefined, no string', () => {
  const src = MK + `
export let f = (n) => { const a = mk(n); let s = 0; for (let i = 0; i < a.length; i++) { const v = a[i].value * 2; if (v === v) s += v } return s }`
  agrees(src, [['f', 4]])
  for (const optimize of levels('size', 2, 3)) ok(!/\(func \$__to_num\b/.test(wat(src, { optimize })), `no string parse at ${optimize}`)
})

test('mixed read: a missing value throws', () => {
  agrees(MK + `
export let f = (k) => { const a = mk(4); a.push(k > 0 ? null : undefined); try { return a[4].value } catch (e) { return e instanceof TypeError ? -1 : -2 } }
export let g = (k) => { const a = mk(4); a[6] = k; let s = 0; for (let i = 0; i < a.length; i++) { try { s += a[i].w ?? 1 } catch (e) { s += 100 } } return s }`,
  [['f', 1], ['f', -1], ['g', 3]])
})

test('mixed read: a name a value may hold another way keeps its answer', () => {
  // a string's length and index, a primitive's method, Object.prototype's
  agrees(MK + `
export let len = (n) => { const a = mk(n); let s = 0; for (let i = 0; i < a.length; i++) { const l = a[i].length; if (l !== undefined) s += l } return s }
export let idx = (n) => { const a = mk(n); let s = ''; for (let i = 0; i < a.length; i++) { const c = a[i][0]; if (c !== undefined) s += c } return s }
export let calls = (n) => { const a = mk(n); let r = ''; for (let i = 0; i < a.length; i++) { const v = a[i]; r += typeof v === 'number' ? v.toFixed(1) : typeof v === 'string' ? v.toUpperCase() : v.hasOwnProperty('value') } return r }`,
  [['len', 4], ['idx', 4], ['calls', 4]])
  // a property stored beside the layout, under a literal or a computed name
  agrees(`const mk = (k) => { const a = [0, 1, 2]; const o = { value: 7 }; if (k) o.extra = k; a[1] = o; a[2] = 'payload'; return a }
export let f = (k) => { const a = mk(k); let r = 0; for (let i = 0; i < a.length; i++) { const e = a[i].extra; if (e !== undefined) r += e } return r }`,
  [['f', 3], ['f', 0]])
  agrees(`const mk = (k) => { const a = [0, 1, 2]; const o = { value: 7 }; o[k] = 5; a[1] = o; a[2] = 'payload'; return a }
export let f = (k) => { const a = mk(k); let r = 0; for (let i = 0; i < a.length; i++) { const e = a[i].w; if (e !== undefined) r += e } return r }`,
  [['f', 'w'], ['f', 'z']])
  // a dictionary beside them
  agrees(`const mk = (k) => { const a = [0, 1, 2]; a[1] = k ? JSON.parse('{"value": 9}') : { value: 7 }; a[2] = 'payload'; return a }
export let f = (k) => { const a = mk(k); let r = 0; for (let i = 0; i < a.length; i++) { const e = a[i].value; if (e !== undefined) r += e } return r }`,
  [['f', 1], ['f', 0]])
})
