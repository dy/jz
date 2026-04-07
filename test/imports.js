// Import statement tests
import test from 'tst'
import { is, ok, throws, almost } from 'tst/assert.js'
import { compile } from '../index.js'

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
