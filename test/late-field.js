// A property the program adds to an object after its creation reads `undefined`
// until it is assigned: a module `let st = {}` grown by a function, a function's
// own properties. The slots a literal's declared keys gain hold the undefined
// sentinel, not the allocator's zero (module/object.js's empty literal), so a
// test for the property fires and the array kept there grows in place; the
// summary holds them absent at the literal (summary/index.js staticLiteral), so
// `=== undefined` stays a runtime test.
import test from 'tst'
import { levels } from './_matrix.js'
import { agree } from './util.js'

const src = `let st = {}
let step = (i) => { if (!st.history) st.history = []; let hist = st.history; let a = new Float64Array(2); a[0] = i + 1; hist.push(a); return hist[0][0] + hist.length * 100 }
export let grown = () => [step(0), step(1), step(2), step(3), st.history[3][0]].join()
let cfg = {}
let setup = (n) => { if (!cfg.size) { cfg.size = n; cfg.taps = [] } cfg.taps.push(n); return cfg.taps.length * 10 + cfg.size }
export let twoProps = () => [typeof cfg.size, setup(3), setup(5), typeof cfg.size, cfg.taps.length].join()
let st2 = {}
let touch = () => { if (!st2.history) st2.history = [1]; return 1 }
export let before = () => [typeof st2.history, st2.history ? 1 : 0, touch(), typeof st2.history, st2.history ? 1 : 0].join()
function g() { return 1 }
export let fnProps = () => { let before = typeof g.count; g.count = (g.count ?? 0) + 1; g.count++; return [before, g.count, g()].join() }
export let localObj = (k) => { let o = {}; let before = typeof o.hist; if (k) o.hist = [1, 2]; return [before, typeof o.hist, o.hist ? o.hist.length : -1].join() }
export let localLoop = (n) => { let o = {}; for (let i = 0; i < n; i++) { if (!o.acc) o.acc = []; o.acc.push(i) } return [typeof o.acc, o.acc ? o.acc.length : -1].join() }
let st3 = {}
let touch3 = () => { if (!st3.history) st3.history = [1]; return 1 }
export let tested = () => [st3.history === undefined, st3.history == null, touch3(), st3.history === undefined, st3.history.length].join()
let st4 = { a: 1 }
export let widened = () => { let r = [st4.b === undefined, st4.a]; st4.b = 'x'; r.push(st4.b === undefined, st4.b); return r.join() }`
const calls = [['grown', []], ['twoProps', []], ['before', []], ['fnProps', []], ['localObj', [0]], ['localObj', [3]], ['localLoop', [0]], ['localLoop', [3]], ['tested', []], ['widened', []]]

for (const optimize of levels(0, 2, 3, 'size'))
  test(`late field: a property added after creation reads undefined until assigned at ${optimize}`, () => {
    for (const [name, args] of calls) agree(src, name, args, { optimize }, `${name}(${args}) at ${optimize}`)
  })

// A module binding whose keys a function adds later is the object itself, its
// added keys where any object's go (its own property table): a box standing in
// for it listed `__inner__` among its keys, answered `in` before the store,
// serialized the box and gave an alias taken before the box its bare object.
const grownSrc = `let st = {}
let alias = st
let touch = () => { st.history = [1]; return 1 }
let seen = () => [Object.keys(st).join(), 'history' in st, JSON.stringify(st), st.hasOwnProperty('history'), alias === st, JSON.stringify(alias)].join('|')
export let f = () => [seen(), touch(), seen()].join('/')
let cfg = { a: 1 }
let cfgAlias = cfg
let setCfg = () => { cfg.b = 2; return 1 }
let cfgSeen = () => [Object.keys(cfg).join(), 'b' in cfg, JSON.stringify(cfg), cfg.hasOwnProperty('b'), cfgAlias === cfg].join('|')
export let g = () => [cfgSeen(), setCfg(), cfgSeen()].join('/')
let arr = [1, 2]
export let h = () => [Object.assign(arr, { x: 3 }) === arr, arr.length, arr.x, 'x' in arr, JSON.stringify(arr)].join('|')
let reg = {}
let fill = () => { reg.get = (k) => k * 2; reg.has = (k) => k > 1; reg.keys = () => 'own'; return 1 }
export let m = () => [fill(), reg.get(2), reg.has(3), reg.keys(), Object.keys(reg).join()].join('|')`
for (const optimize of levels(0, 2, 3))
  test(`late field: a module binding grown later keeps its identity and its keys at ${optimize}`, () => {
    for (const name of ['f', 'g', 'h', 'm']) agree(grownSrc, name, [], { optimize }, `${name} at ${optimize}`)
  })

// A numeric-demanded export parameter (`n`, a loop bound) reseeds the summary's
// kinds: a function property, a module global the plan names by its writes,
// starts undefined in that second seeding too.
const reseedSrc = `function g() { return 1 }
export let fnProp = () => { let before = typeof g.count; g.count = (g.count ?? 0) + 1; return [before, g.count].join() }
export let loop = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }`
for (const optimize of levels(0, 2, 3, 'size'))
  test(`late field: a function property starts undefined after the kinds reseed at ${optimize}`, () => {
    agree(reseedSrc, 'fnProp', [], { optimize }, `fnProp at ${optimize}`)
  })
