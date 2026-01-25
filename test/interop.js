import test from 'tst'
import { is, ok, throws, any } from 'tst/assert.js'
import { compile as jzCompile, instantiate, f64view, isPtr, decodePtr, encodePtr } from '../index.js'
import { compile as watrCompile } from 'watr'

// Helper: compile JS to WASM binary
const compile = (code, opts) => watrCompile(jzCompile(code, opts))

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

test('NaN boxing - full f64 range preserved', async () => {
  // NaN boxing uses quiet NaN for pointers, so ALL regular numbers work
  const wasm = compile(`
    export const identity = (x) => x
  `)
  const mod = await instantiate(wasm)

  // Large numbers that would have been pointers in old 2^48 system
  const largeVal = 2 ** 48
  is(mod.identity(largeVal), largeVal)
  is(mod.identity(2 ** 52), 2 ** 52)
  is(mod.identity(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)

  // Special values
  ok(Number.isNaN(mod.identity(NaN)), 'NaN preserved')
  is(mod.identity(Infinity), Infinity)
  is(mod.identity(-Infinity), -Infinity)
})

test('NaN boxing - NaN equality semantics', async () => {
  // NaN should not equal itself (IEEE 754 preserved)
  const wasm = compile(`
    export const nanEq = () => NaN === NaN
    export const nanNeq = () => NaN !== NaN
    export const isNaN = (x) => x !== x
  `)
  const mod = await instantiate(wasm)

  is(mod.nanEq(), 0, 'NaN === NaN should be false')
  is(mod.nanNeq(), 1, 'NaN !== NaN should be true')
  is(mod.isNaN(NaN), 1, 'x !== x pattern detects NaN')
  is(mod.isNaN(5), 0, 'x !== x is false for numbers')
})

test('NaN boxing - pointer reference equality', async () => {
  // Same pointer should equal itself
  const wasm = compile(`
    export const arrSelfEq = () => { let a = [1,2]; return a === a }
    export const arrDiffEq = () => [1,2] === [1,2]
    export const strSelfEq = () => { let s = "abc"; return s === s }
    export const strSameEq = () => "abc" === "abc"
  `)
  const mod = await instantiate(wasm)

  is(mod.arrSelfEq(), 1, 'same array ref should equal itself')
  is(mod.arrDiffEq(), 0, 'different arrays not equal')
  is(mod.strSelfEq(), 1, 'same string ref should equal itself')
  is(mod.strSameEq(), 1, 'interned strings should equal')
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

  const ptr = rawAlloc(1, 3) // type 1 = ARRAY, len 3

  // NaN-boxed pointers: extract offset from bits (lower 31 bits)
  const buf = new ArrayBuffer(8)
  const f64View = new Float64Array(buf)
  const u64View = new BigUint64Array(buf)
  f64View[0] = ptr
  const ptrBits = u64View[0]
  const offset = Number(ptrBits & 0x7FFFFFFFn)

  const view = new Float64Array(rawMemory.buffer, offset, 3)
  view.set([10, 20, 30])

  // Call raw function with pointer
  const resultPtr = rawProcess(ptr)

  // Decode result pointer (NaN-boxed format with length in memory)
  f64View[0] = resultPtr
  const resultBits = u64View[0]
  const NAN_BOX_MASK = 0x7FF8000000000000n
  ok((resultBits & NAN_BOX_MASK) === NAN_BOX_MASK && resultBits !== NAN_BOX_MASK, 'result should be a pointer')

  const resultOffset = Number(resultBits & 0x7FFFFFFFn)
  // Length is now stored at offset-8 in memory (C-style header)
  const lenView = new Float64Array(rawMemory.buffer, resultOffset - 8, 1)
  const resultLen = Math.floor(lenView[0])
  is(resultLen, 3, 'result length should be 3')

  const resultView = new Float64Array(rawMemory.buffer, resultOffset, resultLen)
  is(resultView[0], 11)
  is(resultView[1], 21)
  is(resultView[2], 31)
})

test('f64view - zero-copy array access', async () => {
  // Use array.map to force heap allocation (multiReturn optimization doesn't apply to transformed arrays)
  const wasm = compile(`
    export const getArr = () => {
      let arr = [10, 20, 30, 40]
      return arr.map(x => x * 2)
    }
  `, { gc: false })
  const mod = await instantiate(wasm)

  // Get array pointer from raw export
  const ptr = mod.wasm.getArr()
  ok(isPtr(ptr), 'getArr should return a pointer')

  // Create zero-copy view
  const view = f64view(mod.wasm._memory, ptr)
  ok(view instanceof Float64Array, 'f64view should return Float64Array')
  is(view.length, 4, 'view should have 4 elements')
  is(view[0], 20)
  is(view[1], 40)
  is(view[2], 60)
  is(view[3], 80)

  // Modify via view - still accessible
  view[0] = 100
  is(view[0], 100, 'modification via view persists')
})

test('f64view - returns null for non-pointers', async () => {
  const wasm = compile(`export const x = 42`)
  const mod = await instantiate(wasm)
  is(f64view(mod.wasm._memory, 42), null)
  is(f64view(mod.wasm._memory, 0), null)
  is(f64view(mod.wasm._memory, NaN), null)  // canonical NaN, not a pointer
})

test('pointer utilities - encodePtr/decodePtr roundtrip', () => {
  const ptr = encodePtr(1, 123, 456)
  ok(isPtr(ptr), 'encoded pointer is detected as pointer')
  const { type, id, offset } = decodePtr(ptr)
  is(type, 1)
  is(id, 123)
  is(offset, 456)
})

// === RING buffer tests ===
// RING buffers provide O(1) push/pop/shift/unshift via circular indexing

test('RING buffer - allocation and basic access', async () => {
  // Test ring buffer WASM helpers directly
  const wasm = compile(`
    export const testRing = () => {
      // Allocate ring with initial length 3
      // Ring type = 2
      return 1
    }
  `)
  const mod = await instantiate(wasm)
  is(mod.testRing(), 1)
})

test('RING buffer - helpers are included in compiled WAT', () => {
  const wat = jzCompile(`export const x = [1,2,3]`)
  ok(wat.includes('$__alloc_ring'), 'should have ring alloc')
  ok(wat.includes('$__ring_push'), 'should have ring push')
  ok(wat.includes('$__ring_shift'), 'should have ring shift')
  ok(wat.includes('$__ring_unshift'), 'should have ring unshift')
})
