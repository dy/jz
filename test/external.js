import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'

// Helper: compile and run
function run(code, imports = {}) {
  return jz(code, { ...imports }).exports
}

test('Read property from external object', () => {
  const { getProp } = run(`
    export const getProp = (obj) => {
      return obj.nodeType
    }
  `)

  const mockNode = { nodeType: 1, nodeName: 'DIV' }
  // JZ returns floats or pointers, so we might not be able to just pass 'mockNode' cleanly unless the test sets up externref or something.
  is(getProp(mockNode), 1)
})

test('Call method on external object', () => {
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
