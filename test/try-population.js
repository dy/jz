// A population of parameters of two kinds used inside a try statement, each answering what
// Node answers at levels 0 and 2 and at speed. `use(o, t)` is called with two values of
// different kinds and uses `o` one way (stores through it, keeps it, returns it, reassigns
// it, alone or under a test that proves something of it, calls it, captures it, hands it
// on) in the protected body, the handler or the finalizer; `f` then reads both values
// back. The same use with no try statement is the last position: where it differs too,
// the defect is not the try statement's. The finalizer is a position twice: after a body
// that cannot throw it is emitted in a row with the body, no handler made; after one that
// throws it is emitted once for each way out, and the handler's copy runs where the
// other did not.
//
// Four defects of 1.0.3 fail here, each with its fix taken out: a reader of the other
// layout, a parameter's incoming kind and a proof's saved mask left standing past an
// assignment on a path the walk does not follow, and the binding split reading a statement
// folded away (.work/architecture.md, "A bundle with a CommonJS module").
//
// Every program has its own `use`, `show` and state, the 56 pairs of a use and a position to a
// module (test/_population.js): what a callee is told of its arguments is the program's own, as
// in a module of one.
// That is its cost: 4,312 programs with callees of their own, about eleven minutes of one
// core at the three levels.
import test from 'tst'
import { population, sampled } from './_population.js'

// (levels 1 and 3 and size agree too, 2026-11-15: twice the time for no program more)
const CONFIGS = [0, 2, 'speed']
const KINDS = {
  obj: `{ x: 1 }`, obj2: `{ y: 2, x: 3 }`, arr: `[1, 2]`, num: `7`, str: `'s'`, nul: `null`,
  typed: `new Float64Array(2)`, fn: `(a) => a + 1`,
}
const SHOW = `let show = (v) => v === null ? 'null' : v === undefined ? 'undef' : typeof v === 'function' ? 'fn' + v(1)
  : Array.isArray(v) ? 'arr' + v.length + ':' + typeof v[0] + v[0] : v instanceof Float64Array ? 'ta' + v[0]
  : typeof v === 'object' ? 'obj' + typeof v.x + v.x : typeof v + v`
const isObj = (o) => `${o} !== null && typeof ${o} === 'object' && !Array.isArray(${o}) && !(${o} instanceof Float64Array)`
// [name, the module's declarations, the use, what f returns after the try, what main reads of the state]
const USES = [
  ['a field stored', '', `if (${isObj('o')}) o.x = 'str'`, '0', '0'],
  ['an element stored', '', `if (Array.isArray(o)) o[0] = 'str'`, '0', '0'],
  ['a typed element stored', '', `if (o instanceof Float64Array) o[0] = 9`, '0', '0'],
  ['a push', '', `if (Array.isArray(o)) o.push('str')`, '0', '0'],
  ['kept in a global', 'let hold = null', `hold = o`, '0', `${isObj('hold')} ? (hold.x = 'kept', 1) : 0`],
  ['kept in a list', 'let held = []', `held.push(o)`, '0', `held.length`],
  ['called', 'let got = 0', `if (typeof o === 'function') got += o(4)`, 'got', '0'],
  ['reassigned', '', `if (typeof o === 'number') o = { x: o }`, 'show(o)', '0'],
  ['reassigned under a proof', `let seen = ''`, `if (o != null) { if (typeof o === 'number') o = null; seen = show(o) }`, 'seen', '0'],
  ['captured', 'let later = null', `later = () => o`, '0', `show(later())`],
  ['handed on', `let sink = (v) => { if (${isObj('v')}) v.x = 'str' }`, `sink(o)`, '0', '0'],
]
const POSITIONS = [
  ['the body', (use) => `try { ${use} } catch (e) { r = -1 }`],
  ['the handler', (use) => `try { if (t) throw 1 } catch (e) { ${use} }`],
  ['the finalizer', (use) => `try { r = 1 } finally { ${use} }`],
  ['the finalizer of a body that throws', (use) => `try { try { if (t) throw 1 } finally { ${use} } } catch (e) { r = 3 }`],
  ['a body with a finalizer', (use) => `try { ${use} } finally { r += 1 }`],
  ['a handler that throws on', (use) => `try { try { if (t) throw 1 } catch (e) { ${use}; throw e } } catch (e) { r = 2 }`],
  ['no try', (use) => `{ ${use} }`],
]
const PAIRS = Object.keys(KINDS).flatMap(a => Object.keys(KINDS).filter(b => b !== a).map(b => [a, b]))
// a program's own names: every top-level binding of it gets its number
const OWN = ['show', 'use', 'hold', 'held', 'got', 'seen', 'later', 'sink']
const program = ([, decl, stmt, ret, post], at, [ka, kb]) => `${SHOW}
${decl}
let use = (o, t) => { let r = 0; ${at(stmt)}; return '' + r + ':' + ${ret} }
export let f = () => { let a = ${KINDS[ka]}, b = ${KINDS[kb]}
  let ra = use(a, 1), rb = use(b, 1)
  let post = ${post}
  return ra + '|' + rb + '|' + post + '|' + show(a) + '|' + show(b) }`

for (const use of USES) test(sampled(`try population: a parameter of two kinds, ${use[0]} inside a try statement: ${POSITIONS.length * PAIRS.length} programs, ${CONFIGS.length} configurations`), () =>
  population(`try population: ${use[0]}`, POSITIONS.flatMap(([where, at]) => PAIRS.map(pair => ({
    name: `${use[0]} in ${where}, ${pair[0]} and ${pair[1]}`, src: program(use, at, pair), args: [[]],
  }))), { configs: CONFIGS, own: OWN, chunk: PAIRS.length }))
