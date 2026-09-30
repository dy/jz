// A destructuring assignment to member targets (`({a: t.x} = o)`, `[t.x,
// u[i]] = arr`) writes through the reference it took before reading the
// source, as ES orders it. Such a write reaches an object outside its
// literal's layout, like any store through an alias or a helper's parameter:
// the module keeps it in the object's own dictionary (its header's, or for a
// durable object the table its offset keys), and the host used to decode the
// object from its layout's slots alone, so the property vanished on the way
// out, and a deleted slot stayed. The host now asks the module for both
// (module/collection.js __obj_props, __obj_deleted; interop.js mem.read).
import test from 'tst'
import { is } from 'tst/assert.js'
import jz from '../index.js'
import { levels, onWasi } from './_matrix.js'
import { oracle } from './util.js'

const show = (v) => JSON.stringify(v, (k, x) => x === undefined ? '<undefined>' : x)
const agree = (cases) => {
  for (const [name, src, ...args] of cases) for (const optimize of levels(0, 2, 3)) {
    // the hostless WASI boundary passes no object in and decodes none out
    if (onWasi()) continue
    is(show(jz(src, { optimize }).exports.f(...args)), show(oracle(src).f(...args)), `${name} O${optimize}`)
  }
}

test('member targets: a destructuring assignment writes through member targets', () => agree([
  ['object pattern', `export let f = (o) => { let t = {}; ({a: t.x, b: t.y} = o); return t }`, { a: 1, b: 2 }],
  ['array pattern', `export let f = (arr) => { let t = {}, u = [0, 0]; let i = 1; [t.x, u[i]] = arr; return [t, u] }`, [7, 8]],
  ['nested', `export let f = (o) => { let t = {}; ({a: {b: t.y}} = o); return t }`, { a: { b: 5 } }],
  ['a bracket key', `export let f = (o) => { let t = {}; ({a: t['x']} = o); return t }`, { a: 1 }],
  ['a computed key', `export let f = (o, k) => { let t = {}; ({a: t[k]} = o); return t }`, { a: 1 }, 'q'],
  ['module object', `let t = {}\nexport let f = (o) => { ({a: t.x} = o); return t }`, { a: 1 }],
  ['a default', `export let f = (o) => { let t = {}; ({a: t.x = 4} = o); return t }`, {}],
  ['an array default', `export let f = () => { let t = {}; [t.x = 5] = []; return t }`],
  ['returned inside', `export let f = (o) => { let t = {}; ({a: t.x} = o); return [t, { t }] }`, { a: 1 }],
]))

test('member targets: target references evaluate before the source is read', () => {
  const pre = `let log = []\nlet t = {}, u = [0, 0]\nlet getT = () => { log.push('t'); return t }\nlet getU = () => { log.push('u'); return u }\nlet key = (k) => { log.push('k' + k); return k }\n`
  agree([
    ['object', pre + `export let f = () => { let src = { get a() { log.push('get a'); return 1 }, get b() { log.push('get b'); return 2 } }
      ;({ a: getT()[key('x')], b: getU()[key(1)] } = src)
      return [log.join(), t, u] }`],
    ['a computed pattern key first', pre + `export let f = () => { let src = { get a() { log.push('get a'); return 1 } }
      ;({ [key('a')]: getT().x } = src)
      return [log.join(), t] }`],
    ['array', pre + `export let f = () => { let it = { i: 0, next() { log.push('next'); return this.i < 2 ? { value: ++this.i, done: false } : { value: undefined, done: true } }, [Symbol.iterator]() { return this } }
      ;[getT().x, getU()[key(1)]] = it
      return [log.join(), t, u] }`],
    ['a default after the read', pre + `export let f = () => { let src = { get a() { log.push('get a'); return undefined } }
      ;({ a: getT().x = (log.push('dflt'), 5) } = src)
      return [log.join(), t] }`],
  ])
})

test('member targets: the host sees every own property an object holds', () => agree([
  ['an alias write', `export let f = () => { let t = {a: 1}; let u = t; u.x = 2; return t }`],
  ['a helper parameter', `let set = (o) => { o.x = 1 }\nexport let f = () => { let t = {}; set(t); return t }`],
  ['a module object', `let t = { a: 1 }\nlet u = t\nu.y = 2\nexport let f = () => { let v = t; v.x = 3; return t }`],
  ['an accessor', `export let f = () => { let t = { a: 1, get b() { return 2 } }; let u = t; u.x = 3; return t }`],
  ['an accessor on a module object', `let t = { a: 1, get b() { return 2 } }\nexport let f = () => { let u = t; u.x = 3; return t }`],
  ['index keys first', `export let f = () => { let t = { a: 1 }; let u = t; u[2] = 'two'; u.x = 3; u[1] = 'one'; return t }`],
  ['a slot written again', `export let f = () => { let t = { a: 1 }; let u = t; u.x = 3; u.a = 5; return t }`],
  ['a deleted slot', `export let f = (k) => { let o = { a: 1, b: 2 }; delete o[k]; return [o, o.a] }`, 'a'],
]))
