// Import statement tests
import test from 'tst'
import { is, ok, throws, almost } from 'tst/assert.js'
import jz, { compile } from '../index.js'

// Helper: compile and run
function run(code) {
  const wasm = compile(code)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  return inst.exports
}

// Named imports
test('import { sin } from math', () => {
  const { f } = run(`
    import { sin } from 'math'
    export let f = x => sin(x)
  `)
  almost(f(0), 0, 1e-6)
})

test('import { sin, cos } from math', () => {
  const { f } = run(`
    import { sin, cos } from 'math'
    export let f = x => sin(x) + cos(x)
  `)
  almost(f(0), 1, 1e-6) // sin(0) + cos(0) = 0 + 1
})

test('import { PI, E } from math', () => {
  const { f, g } = run(`
    import { PI, E } from 'math'
    export let f = () => PI
    export let g = () => E
  `)
  almost(f(), Math.PI)
  almost(g(), Math.E)
})

test('import { sqrt, abs } from math', () => {
  const { f } = run(`
    import { sqrt, abs } from 'math'
    export let f = x => sqrt(abs(x))
  `)
  is(f(-16), 4)
})

// Aliased imports
test('import { sin as s } from math', () => {
  const { f } = run(`
    import { sin as s } from 'math'
    export let f = x => s(x)
  `)
  almost(f(0), 0, 1e-6)
})

test('import { PI as pi, sin as sine } from math', () => {
  const { f } = run(`
    import { PI as pi, sin as sine } from 'math'
    export let f = () => sine(pi / 2)
  `)
  almost(f(), 1, 0.01)
})

// Mixed with Math.X (backward compat)
test('import + Math.X coexist', () => {
  const { f } = run(`
    import { sin } from 'math'
    export let f = x => sin(x) + Math.cos(x)
  `)
  almost(f(0), 1, 1e-6)
})

// Error cases
test('import unknown module', () => {
  throws(() => run(`import { x } from 'unknown'`), /not found|unknown/i)
})

test('import unknown symbol', () => {
  throws(() => run(`import { unknown } from 'math'`), /not found|unknown/i)
})

// Multiple imports
test('multiple import statements', () => {
  const { f } = run(`
    import { sin } from 'math'
    import { cos } from 'math'
    export let f = x => sin(x) * cos(x)
  `)
  almost(f(Math.PI / 4), 0.5, 0.01)
})

// Namespace imports
test('import * as m from math', () => {
  const { f } = run(`
    import * as m from 'math'
    export let f = x => m.sin(x)
  `)
  almost(f(0), 0, 1e-6)
})

test('import * as m - constants', () => {
  const { f } = run(`
    import * as m from 'math'
    export let f = () => m.PI
  `)
  almost(f(), Math.PI)
})

test('import * as m - combined', () => {
  const { f } = run(`
    import * as m from 'math'
    export let f = () => m.sin(m.PI / 2)
  `)
  almost(f(), 1, 0.01)
})

// Default import (treated as namespace)
test('import math from math', () => {
  const { f } = run(`
    import math from 'math'
    export let f = x => math.sqrt(x)
  `)
  is(f(16), 4)
})

// ============================================
// Source module bundling (Tier 2)
// ============================================

test('import: source module basic', () => {
  const { exports } = jz(
    'import { add } from "./math.jz"; export let f = (a, b) => add(a, b)',
    { modules: { './math.jz': 'export let add = (a, b) => a + b' } }
  )
  is(exports.f(3, 4), 7)
})

test('import: source module multiple exports', () => {
  const math = 'export let add = (a, b) => a + b; export let mul = (a, b) => a * b'
  const { exports } = jz(
    'import { add, mul } from "./m.jz"; export let f = (a, b) => add(a, b) + mul(a, b)',
    { modules: { './m.jz': math } }
  )
  is(exports.f(3, 4), 19)  // 7 + 12
})

test('import: transitive imports', () => {
  const base = 'export let base = (x) => x * 2'
  const mid = 'import { base } from "./base.jz"; export let ext = (x) => base(x) + 1'
  const { exports } = jz(
    'import { ext } from "./mid.jz"; export let f = (x) => ext(x)',
    { modules: { './mid.jz': mid, './base.jz': base } }
  )
  is(exports.f(5), 11)  // 5*2 + 1
})

test('import: bundled module newline ! after comment', () => {
  const mod = `
    export let f = () => {
      let a
      a ??= 41

      // keep separate statement
      !0 && (a += 1)
      return a
    }
  `
  const { exports } = jz(
    'import { f } from "./m.jz"; export let g = () => f()',
    { modules: { './m.jz': mod } }
  )
  is(exports.g(), 42)
})

test('import: unknown export errors', () => {
  throws(() => jz(
    'import { nope } from "./m.jz"; export let f = () => nope()',
    { modules: { './m.jz': 'export let add = (a, b) => a + b' } }
  ), /not exported/)
})

// === export default + default import ===

test('export default: arrow function', () => {
  const wasm = compile('export default (x) => x + 1')
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm))
  is(inst.exports.default(41), 42)
})

test('export default: alias existing function', () => {
  const wasm = compile('export let add = (a, b) => a + b; export default add')
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm))
  is(inst.exports.default(20, 22), 42)
  is(inst.exports.add(1, 2), 3)
})

test('import default: bundled module', () => {
  const { exports: { f } } = jz(
    'import add from "./m.jz"; export let f = () => add(20, 22)',
    { modules: { './m.jz': 'const add = (a, b) => a + b; export default add' } }
  )
  is(f(), 42)
})

test('import default: bundled arrow', () => {
  const { exports: { f } } = jz(
    'import dbl from "./d.jz"; export let f = (x) => dbl(x)',
    { modules: { './d.jz': 'export default (x) => x * 2' } }
  )
  is(f(21), 42)
})

// ============================================
// Host imports (Tier 3)
// ============================================

test('import: host function', () => {
  const { exports } = jz(
    'import { double } from "host"; export let f = (x) => double(x) + 1',
    { imports: { host: { double: (x) => x * 2 } } }
  )
  is(exports.f(5), 11)
})

test('import: multiple host functions', () => {
  const { exports } = jz(
    'import { a, b } from "mylib"; export let f = (x) => a(x) + b(x)',
    { imports: { mylib: { a: (x) => x + 1, b: (x) => x * 10 } } }
  )
  is(exports.f(3), 34)  // 4 + 30
})
