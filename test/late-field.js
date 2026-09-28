// A property the program adds to an object after its creation reads `undefined`
// until it is assigned: a module `let st = {}` grown by a function, a function's
// own properties, an auto-boxed binding. The slots such a binding gains hold the
// undefined sentinel, not the allocator's zero (module/object.js's empty literal,
// the auto-box preambles in start-fn.js and emit/dispatch.js), so a test for the
// property fires and the array kept there grows in place; the summary holds them
// absent at the literal (summary/index.js staticLiteral), so `=== undefined`
// stays a runtime test.
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
