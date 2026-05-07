// Lattice unit tests for analyzeIntCertain (S2 Stage 4a — pure analysis,
// no codegen impact). Pins the forward-propagation rule against AST inputs
// before any codegen extension consumes it.
import test from 'tst'
import { is } from 'tst/assert.js'
import { parse } from 'subscript/feature/jessie'
import prepare, { GLOBALS } from '../src/prepare.js'
import { ctx, reset } from '../src/ctx.js'
import { emitter } from '../src/emit.js'
import { analyzeValTypes, analyzeIntCertain, analyzeLocals, repOf, updateRep, VAL } from '../src/analyze.js'

// Run the analyzer against a single user-defined arrow body. Returns a Proxy
// that yields `true` for every intCertain-marked local and `false` otherwise
// (so tests can assert `is(r.n, false)` without distinguishing "not intCertain"
// from "no rep entry"). `paramVals` mirrors what narrowSignatures pre-seeds in
// the real pipeline — needed only for tests that exercise `.length` /
// receiver-typed rules.
function run(code, paramVals) {
  reset(emitter, GLOBALS)
  prepare(parse(code))
  const fn = ctx.func.list.find(f => !f.raw && !f.exported && f.body && Array.isArray(f.body))
    || ctx.func.list[0]
  const body = fn.body
  ctx.func.locals = analyzeLocals(body)
  if (paramVals) for (const [n, v] of Object.entries(paramVals)) updateRep(n, { val: v })
  analyzeValTypes(body)
  analyzeIntCertain(body)
  return new Proxy({}, { get: (_, name) => repOf(name)?.intCertain === true })
}

test('intCertain: integer literal init', () => {
  const r = run('let f = () => { let i = 0; let j = 1.5 }')
  is(r.i, true); is(r.j, false)
})

test('intCertain: bitwise / comparison results are int', () => {
  const r = run('let f = () => { let x = 5 | 0; let y = 3 & 1; let z = 1 < 2 }')
  is(r.x, true); is(r.y, true); is(r.z, true)
})

test('intCertain: closure under +,-,*,% with int operands', () => {
  const r = run('let f = () => { let i = 5; let j = i * 2 + 1; let k = i % 3 }')
  is(r.i, true); is(r.j, true); is(r.k, true)
})

test('intCertain: division poisons', () => {
  const r = run('let f = () => { let i = 5; let j = i / 2 }')
  is(r.i, true); is(r.j, false)
})

test('intCertain: self-recursive `i = i + 1` stays int (fixpoint)', () => {
  const r = run('let f = () => { let i = 0; i = i + 1 }')
  is(r.i, true)
})

test('intCertain: reassignment with non-int RHS poisons', () => {
  const r = run('let f = () => { let i = 0; i = 1.5 }')
  is(r.i, false)
})

test('intCertain: poison is sticky across all defs (order-insensitive)', () => {
  const r = run('let f = () => { let i = 0; let j = i + 1; i = 1.5 }')
  is(r.i, false); is(r.j, false)
})

test('intCertain: `++` / `--` preserve', () => {
  const r = run('let f = () => { let i = 0; i++; let k = 0; k-- }')
  is(r.i, true); is(r.k, true)
})

test('intCertain: compound `+=` / `-=` / `*=` / `%=` preserve', () => {
  const r = run('let f = () => { let a = 0; let b = 0; let c = 0; let d = 0; a += 5; b -= 1; c *= 2; d %= 3 }')
  is(r.a, true); is(r.b, true); is(r.c, true); is(r.d, true)
})

test('intCertain: bitwise compounds (&=, |=, ^=, <<=, >>=, >>>=) always int', () => {
  const r = run('let f = () => { let a = 1.5; let b = 1.5; a &= 7; b <<= 2 }')
  // Even though init is non-int, the bitwise compound result is always int —
  // BUT semantics require ALL defs are int. Init 1.5 is non-int → poison.
  is(r.a, false); is(r.b, false)
})

test('intCertain: bitwise compounds with int init stay int', () => {
  const r = run('let f = () => { let a = 1; let b = 1; a &= 7; b <<= 2 }')
  is(r.a, true); is(r.b, true)
})

test('intCertain: `/=` / `**=` poison', () => {
  const r = run('let f = () => { let a = 4; let b = 2; a /= 2; b **= 2 }')
  is(r.a, false); is(r.b, false)
})

test('intCertain: ?: / && / || conciliate both branches', () => {
  // z's `c && 1` left-operand `c` is a param of unknown val — conservative: not int.
  const r = run('let f = (c) => { let x = c ? 1 : 2; let y = c ? 1 : 1.5; let z = c && 1 }')
  is(r.x, true); is(r.y, false); is(r.z, false)
})

test('intCertain: && / || when both operands provably int', () => {
  const r = run('let f = () => { let a = 5; let b = 0 || a; let c = 1 && 2 }')
  is(r.a, true); is(r.b, true); is(r.c, true)
})

test('intCertain: Math.{imul, clz32, floor, ceil, round, trunc} are int', () => {
  const r = run('let f = () => { let a = Math.imul(3, 4); let b = Math.floor(1.5); let c = Math.clz32(1); let d = Math.round(2.7) }')
  is(r.a, true); is(r.b, true); is(r.c, true); is(r.d, true)
})

test('intCertain: Math.sqrt / Math.sin / Math.cos poison', () => {
  const r = run('let f = () => { let a = Math.sqrt(4); let b = Math.sin(1); let c = Math.cos(2) }')
  is(r.a, false); is(r.b, false); is(r.c, false)
})

test('intCertain: .length on TYPED / ARRAY / STRING / BUFFER receiver is int', () => {
  const r1 = run('let f = (arr) => { let n = arr.length }', { arr: VAL.TYPED })
  is(r1.n, true)
  const r2 = run('let f = (s) => { let n = s.length }', { s: VAL.STRING })
  is(r2.n, true)
})

test('intCertain: .length on unknown receiver does not claim int', () => {
  const r = run('let f = (x) => { let n = x.length }')
  is(r.n, false)
})

test('intCertain: transitive — j = i + 1 follows i', () => {
  const r1 = run('let f = () => { let i = 5; let j = i + 1; let k = j * 2 }')
  is(r1.i, true); is(r1.j, true); is(r1.k, true)
  const r2 = run('let f = () => { let i = 5.5; let j = i + 1 }')
  is(r2.i, false); is(r2.j, false)
})
