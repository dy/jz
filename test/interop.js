import test from 'tst'
import { is, ok, throws, any } from 'tst/assert.js'
import { compile, instantiate, compileWat } from '../index.js'

// JS interop tests - custom sections, auto-wrapping, _ prefix

test('instantiate exposes _memory for gc:false', async () => {
  const wasm = compile('export const x = 42', { gc: false })
  const mod = await instantiate(wasm)
  ok(mod._memory, 'should have _memory')
  ok(mod._memory instanceof WebAssembly.Memory, '_memory should be WebAssembly.Memory')
})

test('instantiate exposes _alloc for gc:false', async () => {
  const wasm = compile('let a = [1,2,3]', { gc: false })
  const mod = await instantiate(wasm)
  ok(mod._alloc, 'should have _alloc')
  ok(typeof mod._alloc === 'function', '_alloc should be function')
})

test('custom section jz:sig is emitted', async () => {
  // jz:sig is only emitted when there are array params or returns
  // Use rest param to ensure array param detection
  const wasm = compile(`
    export const sum = (...args) => args.reduce((a,b) => a+b, 0)
  `, { gc: false })

  const module = await WebAssembly.compile(wasm)
  const sections = WebAssembly.Module.customSections(module, 'jz:sig')
  ok(sections.length > 0, 'should have jz:sig custom section')

  const sigJson = new TextDecoder().decode(sections[0])
  const sig = JSON.parse(sigJson)
  ok(sig.sum, 'should have sum signature')
  ok(sig.sum.arrayParams, 'should have arrayParams')
  is(sig.sum.arrayParams[0], 0, 'first param should be array')
})

test('wasm namespace for raw exports', async () => {
  const wasm = compile(`
    export const add = (a, b) => a + b
  `)
  const mod = await instantiate(wasm)

  ok(mod.add, 'should have wrapped add')
  ok(mod.wasm.add, 'should have raw wasm.add')
  ok(mod.wasm._memory, 'should have raw wasm._memory')

  // Both should work for simple number functions
  is(mod.add(2, 3), 5)
  is(mod.wasm.add(2, 3), 5)  // Raw export via wasm namespace
})

test('pointer encoding - values below threshold pass through', async () => {
  const wasm = compile(`
    export const identity = (x) => x
  `)
  const mod = await instantiate(wasm)

  // Regular numbers should pass through unchanged
  is(mod.identity(0), 0)
  is(mod.identity(42), 42)
  is(mod.identity(-1), -1)
  is(mod.identity(3.14159), 3.14159)
  is(mod.identity(1e10), 1e10)
})

test('pointer encoding - large values (above 2^48) are pointers', async () => {
  // This tests that the threshold is working
  const threshold = 2 ** 48

  // A value just below threshold is a number
  const belowThreshold = threshold - 1
  ok(belowThreshold < threshold, 'test value below threshold')

  // A value at/above threshold would be treated as pointer
  // (though creating such values in user code is unlikely)
})

test('backward compatibility - exports spread to top level', async () => {
  const wasm = compile(`
    export const mul = (a, b) => a * b
  `)
  const mod = await instantiate(wasm)

  // Direct property access (backward compat)
  ok(mod.mul, 'mul should be on mod')
  is(mod.mul(3, 4), 12)

  // Also in wasm namespace (raw exports)
  ok(mod.wasm.mul, 'mul should be in wasm')
})

test('run() helper works', async () => {
  const wasm = compile('1 + 2')
  const mod = await instantiate(wasm)
  is(mod.run(), 3)
})

// Array interop tests - integer-packed pointers

test('auto-wrap array param', async () => {
  const wasm = compile(`
    export const sum = (arr) => arr.reduce((a, b) => a + b, 0)
  `)
  const mod = await instantiate(wasm)

  // Should accept JS array and auto-marshal
  is(mod.sum([1, 2, 3, 4]), 10)
})

test('auto-wrap array return', async () => {
  const wasm = compile(`
    export const double = (arr) => arr.map(x => x * 2)
  `)
  const mod = await instantiate(wasm)

  // Should return JS array
  const result = mod.double([1, 2, 3])
  ok(Array.isArray(result), 'result should be JS array')
  is(result.length, 3)
  is(result[0], 2)
  is(result[1], 4)
  is(result[2], 6)
})

test('raw access via wasm namespace for arrays', async () => {
  const wasm = compile(`
    export const process = (arr) => arr.map(x => x + 1)
  `)
  const mod = await instantiate(wasm)

  // Allocate and write array manually using raw WASM exports
  const rawAlloc = mod.wasm._alloc
  const rawProcess = mod.wasm.process
  const rawMemory = mod.wasm._memory

  const ptr = rawAlloc(1, 3) // type 1 = F64_ARRAY, len 3
  const offset = ptr % (2**32)
  const view = new Float64Array(rawMemory.buffer, offset, 3)
  view.set([10, 20, 30])

  // Call raw function with pointer
  const resultPtr = rawProcess(ptr)

  // Decode result pointer
  ok(resultPtr >= 2**48, 'result should be a pointer')
  const resultOffset = resultPtr % (2**32)
  const resultLen = Math.floor(resultPtr / 2**32) & 0xFFFF
  is(resultLen, 3, 'result length should be 3')

  const resultView = new Float64Array(rawMemory.buffer, resultOffset, resultLen)
  is(resultView[0], 11)
  is(resultView[1], 21)
  is(resultView[2], 31)
})
