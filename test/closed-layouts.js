// A read or a store through an object that is one of a few layouts and nothing
// else, every one holding the key, tests all but the last layout and has no
// dynamic arm behind them (module/schema.js closedGuardsFor; the read module/
// core.js closedRead, the stores src/compile/emit-assign.js). The summary names
// the layouts: a receiver that may be missing, one whose layouts it does not
// list, a key one layout lacks and more than four layouts keep the read they had.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { levels, onWasi } from './_matrix.js'
import { funcWat, oracle, wat, jz } from './util.js'

const agree = (src, calls) => {
  for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) {
    const want = oracle(src), got = jz(src, { optimize }).exports
    for (const [name, ...args] of calls) {
      let a, b
      try { a = String(want[name](...args)) } catch (e) { a = 'throws ' + e.constructor.name }
      try { b = String(got[name](...args)) } catch (e) { b = 'throws ' + (e instanceof TypeError ? 'TypeError' : e.constructor.name) }
      ok(a === b, `${name}(${args}) at ${optimize}: ${b} for ${a}`)
    }
  }
}
const dynamic = (text, fn) => funcWat(text, fn)?.match(/call \$__(dyn_get|dyn_set|hash_get|hash_set)\w*/g) ?? []

// records of two sets of keys in one list: `x` and `y` sit in other slots of each
const records = `const ps = []
for (let i = 0; i < 16; i++) ps.push(i & 1 ? { m: i, x: i * 0.5, y: i + 1, vx: 2, vy: 0.25 } : { x: i * 0.5, y: i + 1, vx: 3, vy: 0.5 })`
const kernels = `${records}
export let step = () => { for (let i = 0; i < ps.length; i++) { const p = ps[i]; p.x += p.vx; p.y += p.vy } return ps[0].x + ps[1].y }
export let sum = () => { let s = 0; for (let i = 0; i < ps.length; i++) s += ps[i].x + ps[i].y; return s }
export let keyed = () => { for (let i = 0; i < ps.length; i++) { const p = ps[i]; p['x'] = p['x'] + 1 } return ps[2].x + ps[3].x }
export let lacks = () => { let s = 0; for (let i = 0; i < ps.length; i++) s += ps[i].m ?? 100; return s }`

test('closed layouts: reads and stores through two layouts answer as JS', () => {
  agree(kernels, [['step'], ['sum'], ['step'], ['keyed'], ['sum'], ['lacks']])
})

test('closed layouts: no dynamic arm stands behind the layouts\' tests', () => {
  for (const optimize of levels(2, 3)) {
    const text = wat(kernels, { optimize })
    for (const fn of ['step', 'sum', 'keyed']) ok(!dynamic(text, fn).length, `${fn} at ${optimize}: ${dynamic(text, fn)}`)
  }
  // (the pass off: the dynamic arm stands, as at the reference levels)
  for (const level of levels(2)) ok(dynamic(wat(kernels, { optimize: { level, closedLayouts: false } }), 'step').length > 0, `the pass off at ${level} keeps the dynamic store`)
  // (the size tier shares the dispatcher's call: no chain a read)
  for (const optimize of levels('size')) ok(dynamic(wat(kernels, { optimize }), 'sum').length > 0, `the size tier keeps the shared read`)
})

// The summary must hold the receiver an object that is there, of layouts it lists.
test('closed layouts: a receiver that may be missing, or of layouts not listed, reads as JS', () => {
  agree(`const a = { x: 1, y: 2 }, b = { y: 3, x: 4, z: 5 }
    export let missing = (c) => { const o = c === 0 ? a : c === 1 ? b : null; return o.x * 10 + o.y }
    export let stored = (c) => { const o = c === 0 ? a : c === 1 ? b : null; o.x = c + 7; return a.x * 10 + b.x }
    export let undef = (c) => { const l = [a, b]; const o = l[c]; return o.x }
    export let parsed = (c) => { const o = c === 0 ? a : c === 1 ? b : JSON.parse('{"q":1,"y":8,"x":9}'); return o.x * 10 + o.y }
    export let gone = (c) => { const o = c ? { x: 1, y: 2 } : { y: 3, x: 4, z: 5 }; let k = 'x'; if (c > 1) delete o[k]; return (o.x ?? -1) * 10 + o.y }
    export let lacksOne = (c) => { const o = c ? { x: 1, y: 2 } : { y: 3, z: 5 }; return (o.x ?? -1) * 10 + o.y }
    export let storeLacks = (c) => { const o = c ? { x: 1, y: 2 } : { y: 3, z: 5 }; o.x = 6; return o.x * 10 + o.y }
    export let big = (c) => { const o = c ? { n: 1n, y: 2 } : { y: 3, n: 4n }; const was = o.n; o.n = 9n; o.n += was; return String(o.n) + ':' + o.y }
    export let mixedKinds = (c) => { const o = c ? { v: 1.5, y: 2 } : { y: 3, v: 'text' }; const was = o.v; o.v = c ? 'now' : 2.5; return was + ':' + o.v + ':' + o.y }`,
  [['missing', 0], ['missing', 1], ['missing', 2], ['stored', 0], ['stored', 1], ['stored', 2], ['undef', 0], ['undef', 1], ['undef', 5],
    ['parsed', 0], ['parsed', 1], ['parsed', 2], ['gone', 0], ['gone', 1], ['gone', 2], ['lacksOne', 0], ['lacksOne', 1], ['storeLacks', 0], ['storeLacks', 1],
    ['big', 0], ['big', 1], ['mixedKinds', 0], ['mixedKinds', 1]])
})

test('closed layouts: a host object in the receiver\'s place reads as JS', () => {
  if (onWasi()) return   // (no host object crosses there)
  const src = `const a = { x: 1, y: 2 }, b = { y: 3, x: 4, z: 5 }
    export let read = (o, c) => { const p = c === 0 ? a : c === 1 ? b : o; return p.x * 10 + p.y }
    export let write = (o, c) => { const p = c === 0 ? a : c === 1 ? b : o; p.x = 40; return p.x + p.y }`
  for (const optimize of levels(0, 2, 3, 'speed')) {
    const want = oracle(src), got = jz(src, { optimize }).exports
    for (const c of [0, 1, 2]) {
      ok(got.read({ y: 7, w: 0, x: 6 }, c) === want.read({ y: 7, w: 0, x: 6 }, c), `read ${c} at ${optimize}`)
      ok(got.write({ y: 7, w: 0, x: 6 }, c) === want.write({ y: 7, w: 0, x: 6 }, c), `write ${c} at ${optimize}`)
    }
  }
})

// Three and four layouts take the chain; five keep the table they had.
test('closed layouts: up to four layouts', () => {
  const lit = (n) => ['{ x: i, y: 1 }', '{ y: 2, x: i }', '{ a: 0, x: i, y: 3 }', '{ a: 0, b: 0, y: 4, x: i }', '{ c: 0, a: 0, b: 0, x: i, y: 5 }'].slice(0, n)
  const src = (n) => `const ps = []
    for (let i = 0; i < 20; i++) { const k = i % ${n}; ps.push(${lit(n).map((l, j) => j === n - 1 ? l : `k === ${j} ? ${l} : `).join('')}) }
    export let sum = () => { let s = 0; for (let i = 0; i < ps.length; i++) { const p = ps[i]; p.y += 1; s += p.x * 2 + p.y } return s }`
  for (const n of [3, 4, 5]) {
    agree(src(n), [['sum'], ['sum']])
    for (const optimize of levels(2)) {
      const calls = dynamic(wat(src(n), { optimize }), 'sum')
      ok(n > 4 ? calls.length > 0 : !calls.length, `${n} layouts at ${optimize}: ${calls}`)
    }
  }
})
