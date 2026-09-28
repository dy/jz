// A store on a primitive throws in strict code, which every jz module is: the
// receiver, the key and the value evaluate, then the TypeError (emit-assign.js
// primitiveStore for a receiver the summary proves primitive, __dyn_set for one
// that may also be an object). A primitive never took an auto-boxed layout:
// a module `let n = 5` with `n.tag = 1` compiled invalid wasm, a captured one
// an unresolvable name, and a store through an unknown receiver wrote through
// a number's bits as if they were a pointer.
import test from 'tst'
import { levels } from './_matrix.js'
import { agree } from './util.js'

// The oracle evaluates through `new Function`, sloppy unless told: the
// directive gives it the strict semantics every jz module has.
const src = `'use strict'
let n = 5
let log = []
let key = () => { log.push('k'); return 'x' }
let val = () => { log.push('v'); return 1 }
let catching = (f) => { try { return 'ok:' + f() } catch (e) { return e.name + ':' + (e instanceof TypeError) } }
let put = (v) => { v.x = 1; return 2 }
function g() { return 1 }
let h = () => 1
export let local = () => catching(() => { let m = 5; m.tag = 1; return m.tag })
export let module = () => catching(() => { n.tag = 1; return n.tag })
export let captured = () => { let m = 5; let add = () => { m.tag = (m.tag ?? 0) + 1; return m.tag }; return [typeof m.tag, catching(add), m + 1].join() }
export let strings = () => [catching(() => { let s = 'ab'; s.x = 1; return s.x }), catching(() => { let s = 'ab'; s[0] = 'x'; return s })].join()
export let booleans = (c) => catching(() => { let b = c > 0; b.x = 1; return b.x })
export let union = (k) => catching(() => put(k > 5 ? {} : 3))
export let order = () => { log.length = 0; catching(() => { let m = 5; m[key()] = val() }); return log.join() }
export let objects = () => [put({}), catching(() => { g.count = (g.count ?? 0) + 1; return g.count }), catching(() => { h.count = 2; return h.count + h() })].join()
export let readOnly = () => { let m = 5; let get = () => m.tag; return [typeof get(), m + 1].join() }`
const calls = [['local', []], ['module', []], ['captured', []], ['strings', []], ['booleans', [1]], ['union', [9]], ['union', [0]], ['order', []], ['objects', []], ['readOnly', []]]

for (const optimize of levels(0, 2, 3, 'size'))
  test(`primitive store: a property store on a primitive throws TypeError at ${optimize}`, () => {
    for (const [name, args] of calls) agree(src, name, args, { optimize }, `${name}(${args}) at ${optimize}`)
  })
