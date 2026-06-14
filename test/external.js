import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onWasi } from './_matrix.js'

// Helper: compile and run
function run(code, imports = {}) {
  return jz(code, { ...imports }).exports
}

test('Read property from external object', () => {
  if (onWasi()) return  // wasi: external object
  const { getProp } = run(`
    export const getProp = (obj) => {
      return obj.nodeType
    }
  `)

  const mockNode = { nodeType: 1, nodeName: 'DIV' }
  // JZ returns floats or pointers, so we might not be able to just pass 'mockNode' cleanly unless the test sets up externref or something.
  is(getProp(mockNode), 1)
})

test('Read property from external object via literal bracket key', () => {
  if (onWasi()) return  // wasi: external object
  // Regression: `obj['nodeType']` IS `obj.nodeType` — both must reach the
  // host-external read path. The `[]` emitter used to fall to `__dyn_get`
  // (internal HASH only, no external support), so a literal-key bracket read
  // on a host object silently returned undefined while dot access worked.
  const { getDot, getBracket } = run(`
    export const getDot = (obj) => obj.nodeType
    export const getBracket = (obj) => obj['nodeType']
  `)
  const mockNode = { nodeType: 1, nodeName: 'DIV' }
  is(getDot(mockNode), 1, 'dot access (control)')
  is(getBracket(mockNode), 1, 'literal-key bracket access must match dot')
})

test('Read nested property from external object via bracket keys', () => {
  if (onWasi()) return  // wasi: external object
  const { f } = run(`
    export const f = (obj) => obj['a']['b']
  `)
  is(f({ a: { b: 42 } }), 42, 'chained literal-key bracket reads match dot chain')
})

test('Literal-key bracket on a primitive arg stays undefined (no narrowing)', () => {
  if (onWasi()) return
  // The delegation must preserve polymorphism: a number/string receiver has no
  // such property → undefined, NOT a reinterpret of its bits as an object pointer.
  const { f } = run(`export const f = (x) => x['foo']`)
  is(f(42), undefined, 'number arg → undefined')
  is(f({ foo: 7 }), 7, 'object arg → property value')
})

test('Call method on external object', () => {
  if (onWasi()) return  // wasi: external object
  const { callMethod } = run(`
    export const callMethod = (obj) => {
      return obj.getAttribute('id').length
    }
  `)

  const mockNode = { 
    id: 'main',
    getAttribute(name) { return this[name] }
  }
  is(callMethod(mockNode), 4)
})

test('Set property on external object', () => {
  if (onWasi()) return  // wasi: external object
  const { setProp } = run(`
    export const setProp = (obj, val) => {
      obj.innerHTML = val
    }
  `)

  const mockNode = { innerHTML: '' }
  setProp(mockNode, 'Hello')
  is(mockNode.innerHTML, 'Hello')
})

test('Return external object from JZ', () => {
  if (onWasi()) return  // wasi: external object
  const instance = jz(`
    export const createNode = (doc) => {
      return doc.createElement('div')
    }
  `)
  const mockDoc = {
    createElement(name) { return { nodeName: name.toUpperCase() } }
  }
  const divPtr = instance.exports.createNode(mockDoc)
  const div = instance.memory.read(divPtr)
  is(div.nodeName, 'DIV')
})
