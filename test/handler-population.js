// A population of try statements whose handler or finalizer runs from a point of the body
// that throws, each answering what Node answers at every level. A `try_table`'s catch clause
// is a branch to its label from every point of its body that may throw: what holds at the
// handler is what held before the body, and nothing the body or the normal copy of a
// finalizer computed holds there (a finalizer is emitted once for each way out of its body:
// the normal copy, the handler's, one before each `return`, `break` and `continue`). A local
// the handler reads is live through the whole body and holds what the body had written when
// it threw.
//
// Guards that class at each of its readers, each program failing with its fix taken out:
// optimize/reuse-loads.js (the handler's copy of a finalizer took the normal copy's load),
// optimize/settled-tests.js (a test the normal copy failed was dropped from the handler's),
// compile/cse-load.js (a read after the throw was cached for the finalizer), optimize/liveness.js
// through loop-compact.js (a list only the handler reads was no root of a compaction),
// compile/plan/integral-loops.js (an integral copy moved the steps of a local out of the try
// body), the emitter (a `return`'s copy of the finalizer threw into the try's own handler and
// ran again) and optimize/split-funcs.js (a run moved out of a list that had left with an
// earlier run: the locals a handler-crossing call adds landed in the wrong function, a
// compile error at levels 3 and speed). Each program is a module of its own: what the
// optimizer keeps across a try turns on what its module inlines and what its callers pass.
import test from 'tst'
import { is } from 'tst/assert.js'
import { jz, oracle } from './util.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']

const check = (name, src) => {
  let want
  try { want = String(oracle(src).main()) } catch (e) { want = `throws: ${String(e.message).split('\n')[0]}` }
  for (const optimize of CONFIGS) {
    let got
    try { got = String(jz(src, { optimize }).exports.main()) } catch (e) { got = `throws: ${String(e.message).split('\n')[0]}` }
    // (one assertion per differing program)
    if (got !== want) is(got, want, `${name}, at ${JSON.stringify(optimize)}`)
  }
}

// The grid: [name, written before the throw, written after it, what the handler or finalizer
// reads]; after the statement the function reads its locals and what the stores wrote.
const SHAPES = [
  ['a local rewritten', 'x = 2', 'x = 3', 'sum += x'],
  ['a local stepped', 'x = x + 1', 'x = x + 10', 'sum += x'],
  ['a local from a load', 'x = o[1]', 'x = o[2]', 'sum += x'],
  ['two locals', 'x = 5; y = x * 2', 'y = 7; x = 1', 'sum += x + y'],
  ['a global', 'g = 4', 'g = 9', 'sum += g'],
  ['a typed store', 'o[0] = 11', 'o[0] = 22', 'sum += o[0]'],
  ['typed stores at two indices', 'o[0] = 11', 'o[1] = 22', 'sum += o[0] + o[1]'],
  ['an element store', 'l[0] = 11', 'l[0] = 22', 'sum += l[0]'],
  ['a field store', 'p.a = 11', 'p.a = 22', 'sum += p.a'],
  ['a field store of an object the module keeps', 'q.a = 11', 'q.a = 22', 'sum += q.a'],
  ['a field read', 'x = 1', 'x = 2', 'sum += q.a + p.a'],
  ['a load after a store', 'x = o[1] + 1', 'o[1] = 50', 'sum += o[1] + x'],
  ['a tag', 'x = typeof v === "string" ? 1 : 2', 'x = 3', 'sum += x'],
  ['a float local', 'z = 0.5', 'z = 1.5', 'sum += z'],
  ['a local of a small range', 'x = 7 & 3', 'x = 100000', 'sum += x'],
  ['a byte store', 'b[1] = 200', 'b[1] = 7', 'sum += b[1]'],
  ['a string length', 'x = s.length', 'x = 0', 'sum += x'],
  ['a test of a local the throwing path wrote', 'if (t) x = 10', 'x = 1', 'if (x > 3) return 5; sum += 1'],
  ['a test of an element', 'if (t) o[0] = 10', 'o[0] = 1', 'if (o[0] > 3) return 5; sum += 1'],
]
const THROWS = [
  ['a throw', 'if (t) throw 1'],
  ['a callee that throws', 'thrower(t)'],
  ['a callee that throws in a loop', 'for (let j = 0; j < 2; j++) thrower(t && j)'],
]
const WRAPS = [
  ['a handler', (b, r) => `try { ${b} } catch (e) { ${r} }`],
  ['a finalizer', (b, r) => `try { ${b} } finally { ${r} }`],
  ['a handler and a finalizer', (b, r) => `try { ${b} } catch (e) { ${r} } finally { ${r} }`],
  ['a handler of a body that returns', (b, r) => `try { ${b}; return 1 } catch (e) { ${r} }`],
  ['a finalizer of a body that returns', (b, r) => `try { ${b}; return 1 } finally { ${r} }`],
  ['a handler around a finalizer', (b, r) => `try { try { ${b} } finally { sum += 1000 } } catch (e) { ${r} }`],
  ['a handler in a loop', (b, r) => `for (let k = 0; k < 3; k++) { try { ${b} } catch (e) { ${r} } }`],
  ['a loop in a handler\'s body', (b, r) => `try { for (let k = 0; k < 3; k++) { ${b} } } catch (e) { ${r} }`],
  ['a finalizer in a loop', (b, r) => `for (let k = 0; k < 3; k++) { try { ${b} } finally { ${r} } }`],
]
const grid = ([, pre, post, read], [, thrown], [, wrap]) => `let sum = 0, g = 0
let thrower = (t) => { if (t) throw 1; return 0 }
let keep = []
let f = (o, l, p, q, b, s, v, t) => { let x = 0, y = 0, z = 0.25; ${wrap(`${pre}; ${thrown}; ${post}`, read)}; sum += x + y + z + o[0] + o[1] + l[0] + p.a + q.a + b[1]; return 0 }
export let main = () => { sum = 0; g = 0
  const mk = () => { const q = { a: 1 }; keep.push(q); return q }
  try { f(new Float64Array([1, 2, 4, 8]), [1, 2, 3, 4], { a: 1 }, mk(), new Uint8Array([1, 2, 3, 4]), 'abcd', 'str', 0) } catch (e) { sum += 0.25 }
  try { f(new Float64Array([16, 32, 64, 128]), [5, 6, 7, 8], { a: 2 }, mk(), new Uint8Array([5, 6, 7, 8]), 'abcdef', 7, 1) } catch (e) { sum += 0.25 }
  try { f(new Float64Array([256, 512, 1024, 2048]), [9, 10, 11, 12], { a: 3 }, mk(), new Uint8Array([9, 10, 11, 12]), 'xy', 'z', 0) } catch (e) { sum += 0.25 }
  try { f(new Float64Array([3, 5, 7, 9]), [13, 14, 15, 16], { a: 4 }, mk(), new Uint8Array([13, 14, 15, 16]), 'qq', 3, 1) } catch (e) { sum += 0.25 }
  return sum + g * 1000 }`

for (const wrap of WRAPS) test(`handler population: ${wrap[0]}, ${SHAPES.length * THROWS.length} programs, ${CONFIGS.length} configurations`, () => {
  for (const shape of SHAPES) for (const thrown of THROWS) check(`${shape[0]} before ${thrown[0]}, in ${wrap[0]}`, grid(shape, thrown, wrap))
  is(true, true, `${wrap[0]}: ${SHAPES.length * THROWS.length} programs`)
})

// The exits of a body a finalizer runs for: a `return`, `break` or `continue` leaves the try
// statement and every one inside it, and a throw from the copy of the finalizer it runs is
// the statement's, past its own handler and the handlers inside it.
const exit = (f) => `${f}
export let main = () => { g = 0; let r = 0; try { r = f(1) } catch (e) { g += 100 }; return g * 10 + r }`
const EXITS = [
  ['a return, a finalizer that throws', `let g = 0
let thrower = (t) => { if (t) throw 3; return 0 }
let f = (t) => { try { if (t) return 5; thrower(0) } finally { g++; if (t) throw 1 } return 0 }`],
  ['a return under a handler, a finalizer that throws', `let g = 0
let f = (t) => { try { if (t) return 5 } catch (e) { throw e } finally { g++; if (t) throw 1 } return 0 }`],
  ['a return in a handler, a finalizer that throws', `let g = 0
let f = (t) => { try { if (t) throw 2 } catch (e) { return 7 } finally { g++; if (t) throw 1 } return 0 }`],
  ['a return under a handler that throws on, a finalizer that throws', `let g = 0
let f = (t) => { try { try { if (t) throw 2 } catch (e) { return 7 } } catch (e) { g += 1000 } finally { g++; if (t) throw 1 } return 0 }`],
  ['a return, a finalizer that throws, a handler around', `let g = 0
let thrower = (t) => { if (t) throw 3; return 0 }
let f = (t) => { try { try { if (t) return 5; thrower(0) } finally { g++; if (t) throw 1 } } catch (e) { g += 1000; return 8 } return 0 }`],
  ['a return, an inner finalizer that throws, an outer handler', `let g = 0
let f = (t) => { try { try { if (t) return 5 } finally { g += 2; if (t) throw 1 } } catch (e) { g += 1000 } finally { g++ } return 0 }`],
  ['a return, two finalizers, the outer throws', `let g = 0
let thrower = (t) => { if (t) throw 3; return 0 }
let f = (t) => { try { try { if (t) return 5; thrower(0) } finally { g += 2 } } finally { g++; if (t) throw 1 } return 0 }`],
  ['a return, a finalizer that returns', `let g = 0
let thrower = (t) => { if (t) throw 3; return 0 }
let f = (t) => { try { if (t) return 5; thrower(0) } finally { g++; if (t) return 9 } return 0 }`],
  ['a break, a finalizer that throws', `let g = 0
let thrower = (t) => { if (t) throw 3; return 0 }
let f = (t) => { for (let k = 0; k < 3; k++) { try { if (t) break; thrower(0) } finally { g++; if (t) throw 1 } } return 0 }`],
  ['a continue, a finalizer that throws', `let g = 0
let thrower = (t) => { if (t) throw 3; return 0 }
let f = (t) => { for (let k = 0; k < 3; k++) { try { if (t) continue; thrower(0) } finally { g++; if (t) throw 1 } } return 0 }`],
  ['a break under a handler, a finalizer that throws', `let g = 0
let f = (t) => { for (let k = 0; k < 3; k++) { try { try { if (t) break } catch (e) { g += 1000; throw e } } finally { g++; if (t) throw 1 } } return 0 }`],
]
test(`handler population: the exits a finalizer runs for, ${EXITS.length} programs, ${CONFIGS.length} configurations`, () => {
  for (const [name, f] of EXITS) check(name, exit(f))
  is(true, true, `exits: ${EXITS.length} programs`)
})

// What a compaction keeps: a loop that allocates and keeps some of it compacts what its roots
// reach, the locals live at its top among them; a list only the handler reads is live there.
const KEPT = [
  ['a list the handler reads, set again after the loop', `let f = (n) => {
  let keep = [7, 8, 9, 10]
  try {
    for (let i = 0; i < n; i++) { let a = [i, i + 1, i + 2, i + 3]; if (i % 50000 === 0) keep = a; if (i === n - 1) throw 1 }
    keep = [0, 0, 0, 0]
  } catch (e) { return keep[0] * 1000 + keep[3] }
  return -1
}
export let main = () => f(400000)`],
  ['a list the finalizer reads, set again after the loop', `let out = 0
let f = (n) => {
  let keep = [7, 8, 9, 10]
  try {
    for (let i = 0; i < n; i++) { let a = [i, i + 1, i + 2, i + 3]; if (i % 50000 === 0) keep = a; if (i === n - 1) throw 1 }
    keep = [0, 0, 0, 0]
  } finally { out = keep[0] * 1000 + keep[3] }
  return -1
}
export let main = () => { try { f(400000) } catch (e) { out += 0.5 } return out }`],
]
test(`handler population: what a compaction keeps, ${KEPT.length} programs, ${CONFIGS.length} configurations`, () => {
  for (const [name, src] of KEPT) check(name, src)
  is(true, true, `kept: ${KEPT.length} programs`)
})

// A program of the fuzzer the grid does not reach (its generator: nested try statements of
// every form over a local, an element and a field, two loops deep), reduced: moved in runs,
// its function's list left with an earlier run before a later run of it moved past a handler.
const FUZZED = [
  ['nested try statements two loops deep', `let sum0 = 0, g0 = 0
let thrower0 = (t, q) => { if (t === q) throw q; return 0 }
let f0 = (o, i, t) => { let x = i, y = 3, v = 0.5; let p = { a: 1, b: 2 };  try {  try {  } catch (e) {  throw e } } catch (e) {  try { if (t === 1) {  x = x & 255 } else { o[(x & 7)] = x + 1 }; } catch (e) { sum0 += 0.5;  } } finally {  try {  x = x | 0; } finally {  try { x = (x * 3) & 1023; sum0 += y + o[(i & 7)] } catch (e) { sum0 += 0.5;  } } }; for (let k2 = 0; k2 < 4; k2++) { if (t > 0) throw x; for (let k3 = 0; k3 < 4; k3++) { try { if ((t & 1) && x > 2) return sum0 } catch (e) {  throw e } finally { sum0 += o.length }; try { v = y * 0.5; v = v + p.a } catch (e) {  sum0 += e } finally { y = x + 10 }; thrower0(t, 2) } }; return x + y + v + p.a + p.b }
export let main = () => { sum0 = 0; g0 = 0
  try { sum0 += f0(new Uint8Array([1,2,250,4,5,255,7,8]), 0, 0) } catch (e) { sum0 += 0.25 }
  try { sum0 += f0(new Uint8Array([1,2,250,4,5,255,7,8]), 2, 1) } catch (e) { sum0 += 0.25 }
  return sum0 + g0 }`],
]
test(`handler population: programs of the fuzzer, ${FUZZED.length} programs, ${CONFIGS.length} configurations`, () => {
  for (const [name, src] of FUZZED) check(name, src)
  is(true, true, `fuzzed: ${FUZZED.length} programs`)
})
