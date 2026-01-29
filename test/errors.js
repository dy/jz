import test from 'tst'
import { ok } from 'tst/assert.js'
import compile from '../index.js'

const throws = (code, match, msg) => {
  let error
  try { compile(code) } catch (e) { error = e }
  ok(error && error.message.includes(match), `${msg}: expected "${match}", got "${error?.message}"`)
}

// ============================================================================
// Prohibited identifiers
// ============================================================================

test('prohibited: this', () => throws('export let f = () => this.x', 'this', 'this should error'))
test('prohibited: super', () => throws('export let f = () => super.x', 'super', 'super should error'))
test('prohibited: arguments', () => throws('export let f = () => arguments[0]', 'arguments', 'arguments should error'))
test('prohibited: eval', () => throws('eval("1")', 'eval', 'eval should error'))

// ============================================================================
// Prohibited ops
// ============================================================================

test('prohibited: async', () => throws('async function f() {}', 'async', 'async should error'))
test('prohibited: await', () => throws('export let f = async () => await x', 'async', 'async should error'))
test('prohibited: class', () => throws('class Foo {}', 'class', 'class should error'))
test('prohibited: yield', () => throws('function* f() { yield 1 }', 'generator', 'yield should error'))
test('prohibited: delete', () => throws('delete obj.x', 'delete', 'delete should error'))
test('prohibited: in', () => throws('"x" in obj', 'in', 'in should error'))
test('prohibited: instanceof', () => throws('x instanceof Array', 'instanceof', 'instanceof should error'))
test('prohibited: with', () => throws('with (obj) {}', 'with', 'with should error'))
test('prohibited: var', () => throws('var x = 1', 'var', 'var should error'))
test('prohibited: function', () => throws('function f() {}', 'function', 'function should error'))

// Constructor/namespace validation deferred to emit/modules
