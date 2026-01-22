import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile, instantiate } from '../index.js'

// Helper for near-equality
const nearly = (actual, expected, tolerance = 0.0001) => {
  ok(Math.abs(actual - expected) < tolerance, `Expected ${actual} to be near ${expected}`)
}

// Helper to run code and return exports
async function run(code) {
  const wasm = compile(code)
  const module = await WebAssembly.compile(wasm)
  const instance = await WebAssembly.instantiate(module)
  return instance.exports
}

// TypedArray Tests

test('TypedArray - Float32Array creation and access', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float32Array(4)
      buf[0] = 1.5
      buf[1] = 2.5
      buf[2] = 3.5
      buf[3] = 4.5
      return buf[0] + buf[1] + buf[2] + buf[3]
    }
  `)
  is(test(), 12)
})

test('TypedArray - Float64Array creation and access', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float64Array(2)
      buf[0] = 1.123456789012345
      buf[1] = 2.987654321098765
      return buf[0] + buf[1]
    }
  `)
  nearly(test(), 4.11111111011111)
})

test('TypedArray - Int32Array creation and access', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(3)
      buf[0] = 100
      buf[1] = 200
      buf[2] = 300
      return buf[0] + buf[1] + buf[2]
    }
  `)
  is(test(), 600)
})

test('TypedArray - Uint8Array creation and access', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Uint8Array(4)
      buf[0] = 10
      buf[1] = 20
      buf[2] = 30
      buf[3] = 40
      return buf[0] + buf[1] + buf[2] + buf[3]
    }
  `)
  is(test(), 100)
})

test('TypedArray - Int16Array creation and access', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int16Array(2)
      buf[0] = 1000
      buf[1] = 2000
      return buf[0] + buf[1]
    }
  `)
  is(test(), 3000)
})

test('TypedArray - length property', async () => {
  const { test } = await run(`
    export const test = (n) => {
      let buf = new Float32Array(n)
      return buf.length
    }
  `)
  is(test(10), 10)
  is(test(100), 100)
})

test('TypedArray - byteLength property', async () => {
  const { test32, test64 } = await run(`
    export const test32 = (n) => {
      let buf = new Float32Array(n)
      return buf.byteLength
    }
    export const test64 = (n) => {
      let buf = new Float64Array(n)
      return buf.byteLength
    }
  `)
  is(test32(10), 40)   // 10 * 4 bytes
  is(test64(10), 80)   // 10 * 8 bytes
})

test('TypedArray - dynamic length', async () => {
  const { test } = await run(`
    export const test = (n) => {
      let buf = new Float32Array(n)
      let sum = 0  // promoted to f64 since buf[i] is f64
      for (let i = 0; i < n; i++) {
        buf[i] = i * 0.5
        sum = sum + buf[i]
      }
      return sum
    }
  `)
  // sum of 0, 0.5, 1, 1.5, 2 = 5
  nearly(test(5), 5)
})

test('TypedArray - f64 accumulation via parameter', async () => {
  const { test } = await run(`
    export const test = (n, multiplier) => {
      let buf = new Float64Array(n)
      let sum = 0  // promoted to f64 since buf[i] is f64
      for (let i = 0; i < n; i++) {
        buf[i] = i * multiplier
        sum = sum + buf[i]
      }
      return sum
    }
  `)
  // sum of 0, 0.5, 1, 1.5, 2 = 5
  nearly(test(5, 0.5), 5)
})

test('TypedArray - Float32 precision', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float32Array(1)
      buf[0] = 1.1  // f32 has limited precision
      return buf[0]
    }
  `)
  // Float32 can't represent 1.1 exactly
  const result = test()
  ok(Math.abs(result - 1.1) < 0.0001)
})

test('TypedArray - Int8Array signed values', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int8Array(2)
      buf[0] = 127   // max positive
      buf[1] = -128  // min negative (wraps)
      return buf[0] + buf[1]
    }
  `)
  is(test(), -1)
})

test('TypedArray - loop fill and read', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float32Array(100)
      for (let i = 0; i < 100; i++) {
        buf[i] = i
      }
      let sum = 0
      for (let i = 0; i < 100; i++) {
        sum = sum + buf[i]
      }
      return sum
    }
  `)
  // sum of 0..99 = 99*100/2 = 4950
  is(test(), 4950)
})

test('TypedArray - multiple arrays', async () => {
  const { test } = await run(`
    export const test = () => {
      let a = new Float32Array(3)
      let b = new Float32Array(3)
      a[0] = 1; a[1] = 2; a[2] = 3
      b[0] = 10; b[1] = 20; b[2] = 30
      return a[0] + a[1] + a[2] + b[0] + b[1] + b[2]
    }
  `)
  is(test(), 66)
})

// All TypedArray constructors
test('TypedArray - all constructors compile', async () => {
  const wat = compile(`
    export const testI8 = () => { let b = new Int8Array(1); return b.length }
    export const testU8 = () => { let b = new Uint8Array(1); return b.length }
    export const testI16 = () => { let b = new Int16Array(1); return b.length }
    export const testU16 = () => { let b = new Uint16Array(1); return b.length }
    export const testI32 = () => { let b = new Int32Array(1); return b.length }
    export const testU32 = () => { let b = new Uint32Array(1); return b.length }
    export const testF32 = () => { let b = new Float32Array(1); return b.length }
    export const testF64 = () => { let b = new Float64Array(1); return b.length }
  `, { text: true })
  ok(wat.includes('__alloc_typed'))
})
