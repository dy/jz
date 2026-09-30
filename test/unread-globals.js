// A module binding nothing the program runs reads is not declared, where its
// value runs nothing (src/compile/plan/scope.js dropUnreadGlobals): a name, a
// literal, a closure, an operator over numbers, strings and booleans. A library
// binds `Function` for a code generator beside the evaluator the program calls;
// the binding has no reader, and a value the target has no form of stops no
// compile. At every level: what a program may name does not depend on the
// optimizer. A value whose evaluation runs code (a call, a conversion of an
// object) stays, and a binding with a reader that runs stays.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile } from '../index.js'
import { levels } from './_matrix.js'
import { oracle, run } from './util.js'

const LEVELS = levels(0, 1, 2, 3, 'size')
const GENERATOR = 'const factory = (c) => { const g = new Fcn("x", "return x + " + c); return g }\n'

// A binding with no reader that runs: [source, the host's source where the host differs]
const unread = {
  'a name the target has no value for': 'const Fcn = Function\n' + GENERATOR + 'export let f = (x) => x + 1',
  'declared beside one that is read': 'const K = 2, Fcn = Function, J = 3\n' + GENERATOR + 'export let f = (x) => x * K + J',
  'assigned in a statement of its own': 'let Fcn\nFcn = Function\n' + GENERATOR + 'export let f = (x) => x + 1',
  'read only by a binding with no reader': 'const Fcn = Function\nconst Make = Fcn\nexport let f = (x) => x + 1',
  'behind an operator that converts nothing': 'const Fcn = Function\nconst has = typeof Fcn === "function" && Fcn !== void 0\nexport let f = (x) => x + 1',
  'a closure that names it': 'const Fcn = Function\nconst make = () => Fcn\nexport let f = (x) => x + 1',
}

test('unread globals: a binding nothing reads stops no compile', () => {
  for (const [name, src] of Object.entries(unread)) {
    const host = oracle(src)
    for (const optimize of LEVELS) {
      const m = run(src, { optimize })
      for (const x of [0, 1.5, -3]) is(m.f(x), host.f(x), `${name} at ${optimize}: f(${x})`)
    }
  }
})

test('unread globals: a reader that runs keeps the binding', () => {
  const read = {
    'a function the host holds': 'const Fcn = Function\n' + GENERATOR + 'export let f = (x) => factory(1)(x)',
    'a statement of the module': 'const Fcn = Function\nconst made = new Fcn("x", "return x")\nexport let f = (x) => x + 1',
  }
  for (const [name, src] of Object.entries(read))
    for (const optimize of LEVELS) throws(() => compile(src, { optimize }), /'Function' as a value is not supported/, `${name} at ${optimize}`)
})

// A value whose evaluation runs code is evaluated, reader or none: [source, the calls]
const effects = {
  'a conversion of an object': 'let n = 0\nconst o = { valueOf: () => { n++; return 1 } }\nconst sum = o + 1\nexport let f = () => n',
  'a loose comparison of an object': 'let n = 0\nconst o = { valueOf: () => { n++; return 1 } }\nconst same = o == 1\nexport let f = () => n',
  'a call': 'let n = 0\nconst bump = () => { n += 2; return n }\nconst first = bump()\nexport let f = () => n',
  'a call inside an operator': 'let n = 0\nconst bump = () => { n += 2; return n }\nconst twice = bump() * 2 + 1\nexport let f = () => n',
  'an assignment inside a value': 'let n = 0\nconst k = (n = 5) + 1\nexport let f = () => n',
  'a step inside a value': 'let n = 0\nconst k = n++ + 1\nexport let f = () => n',
}

test('unread globals: a value that runs code is evaluated', () => {
  for (const [name, src] of Object.entries(effects)) {
    const host = oracle(src)
    for (const optimize of LEVELS) is(run(src, { optimize }).f(), host.f(), `${name} at ${optimize}`)
  }
})

test('unread globals: an exported binding stays for the host', () => {
  const src = 'export const K = 1.5\nexport let L = 2\nexport let f = (x) => x + 1'
  for (const optimize of LEVELS) {
    const m = run(src, { optimize })
    ok('K' in m && 'L' in m, `K and L at ${optimize}`)
    is(m.f(1), 2, `f at ${optimize}`)
  }
})
