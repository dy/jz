import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile as jzCompile, instantiate } from '../index.js'
import { compile as watrCompile } from 'watr'

// Helper: compile JS to WASM binary
const compile = (code, opts) => watrCompile(jzCompile(code, opts))

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
  const wat = jzCompile(`
    export const testI8 = () => { let b = new Int8Array(1); return b.length }
    export const testU8 = () => { let b = new Uint8Array(1); return b.length }
    export const testI16 = () => { let b = new Int16Array(1); return b.length }
    export const testU16 = () => { let b = new Uint16Array(1); return b.length }
    export const testI32 = () => { let b = new Int32Array(1); return b.length }
    export const testU32 = () => { let b = new Uint32Array(1); return b.length }
    export const testF32 = () => { let b = new Float32Array(1); return b.length }
    export const testF64 = () => { let b = new Float64Array(1); return b.length }
  `)
  ok(wat.includes('__alloc_typed'))
})

// ========== TypedArray Methods ==========

test('TypedArray - fill method', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float32Array(5)
      buf.fill(42)
      return buf[0] + buf[4]
    }
  `)
  is(test(), 84)
})

test('TypedArray - fill with start/end', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(5)
      buf.fill(0)
      buf.fill(7, 1, 4)
      return buf[0] + buf[1] + buf[2] + buf[3] + buf[4]
    }
  `)
  is(test(), 21)  // 0 + 7 + 7 + 7 + 0
})

test('TypedArray - at method (positive)', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float32Array(3)
      buf[0] = 10; buf[1] = 20; buf[2] = 30
      return buf.at(1)
    }
  `)
  is(test(), 20)
})

test('TypedArray - at method (negative)', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float32Array(3)
      buf[0] = 10; buf[1] = 20; buf[2] = 30
      return buf.at(-1)
    }
  `)
  is(test(), 30)
})

test('TypedArray - indexOf', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(5)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 2; buf[4] = 1
      return buf.indexOf(2)
    }
  `)
  is(test(), 1)
})

test('TypedArray - indexOf (not found)', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(3)
      buf[0] = 1; buf[1] = 2; buf[2] = 3
      return buf.indexOf(99)
    }
  `)
  is(test(), -1)
})

test('TypedArray - lastIndexOf', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(5)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 2; buf[4] = 1
      return buf.lastIndexOf(2)
    }
  `)
  is(test(), 3)
})

test('TypedArray - includes', async () => {
  const { testYes, testNo } = await run(`
    export const testYes = () => {
      let buf = new Float32Array(3)
      buf[0] = 1.5; buf[1] = 2.5; buf[2] = 3.5
      return buf.includes(2.5)
    }
    export const testNo = () => {
      let buf = new Float32Array(3)
      buf[0] = 1.5; buf[1] = 2.5; buf[2] = 3.5
      return buf.includes(99)
    }
  `)
  is(testYes(), 1)
  is(testNo(), 0)
})

test('TypedArray - slice', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(5)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4; buf[4] = 5
      let s = buf.slice(1, 4)
      return s.length * 100 + s[0] + s[1] + s[2]
    }
  `)
  is(test(), 309)  // length=3, sum=2+3+4=9
})

test('TypedArray - slice negative indices', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(5)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4; buf[4] = 5
      let s = buf.slice(-3, -1)
      return s.length * 100 + s[0] + s[1]
    }
  `)
  is(test(), 207)  // length=2, [3,4]
})

test('TypedArray - reverse', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(4)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4
      buf.reverse()
      return buf[0] * 1000 + buf[1] * 100 + buf[2] * 10 + buf[3]
    }
  `)
  is(test(), 4321)
})

test('TypedArray - copyWithin', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(5)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4; buf[4] = 5
      buf.copyWithin(0, 3)  // copy [4,5] to start
      return buf[0] * 10000 + buf[1] * 1000 + buf[2] * 100 + buf[3] * 10 + buf[4]
    }
  `)
  is(test(), 45345)
})

test('TypedArray - every (pass)', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(4)
      buf[0] = 2; buf[1] = 4; buf[2] = 6; buf[3] = 8
      return buf.every(x => x % 2 === 0)
    }
  `)
  is(test(), 1)
})

test('TypedArray - every (fail)', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(4)
      buf[0] = 2; buf[1] = 4; buf[2] = 5; buf[3] = 8
      return buf.every(x => x % 2 === 0)
    }
  `)
  is(test(), 0)
})

test('TypedArray - some (pass)', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(4)
      buf[0] = 1; buf[1] = 3; buf[2] = 4; buf[3] = 7
      return buf.some(x => x % 2 === 0)
    }
  `)
  is(test(), 1)
})

test('TypedArray - some (fail)', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(4)
      buf[0] = 1; buf[1] = 3; buf[2] = 5; buf[3] = 7
      return buf.some(x => x % 2 === 0)
    }
  `)
  is(test(), 0)
})

test('TypedArray - find', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(4)
      buf[0] = 1; buf[1] = 3; buf[2] = 4; buf[3] = 7
      return buf.find(x => x > 2)
    }
  `)
  is(test(), 3)
})

test('TypedArray - findIndex', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(4)
      buf[0] = 1; buf[1] = 3; buf[2] = 4; buf[3] = 7
      return buf.findIndex(x => x > 2)
    }
  `)
  is(test(), 1)
})

test('TypedArray - map', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float32Array(3)
      buf[0] = 1; buf[1] = 2; buf[2] = 3
      let doubled = buf.map(x => x * 2)
      return doubled[0] + doubled[1] + doubled[2]
    }
  `)
  is(test(), 12)
})

test('TypedArray - filter', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(5)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4; buf[4] = 5
      let evens = buf.filter(x => x % 2 === 0)
      return evens.length * 100 + evens[0] + evens[1]
    }
  `)
  is(test(), 206)  // length=2, [2,4]
})

test('TypedArray - reduce', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float32Array(4)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4
      return buf.reduce((acc, x) => acc + x, 0)
    }
  `)
  is(test(), 10)
})

test('TypedArray - reduceRight', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(3)
      buf[0] = 1; buf[1] = 2; buf[2] = 3
      return buf.reduceRight((acc, x) => acc * 10 + x, 0)
    }
  `)
  is(test(), 321)  // ((0*10+3)*10+2)*10+1 = 321
})

// forEach with mutation NOT SUPPORTED - closures capture by value
// Use reduce instead for accumulation patterns
test.skip('TypedArray - forEach (unsupported: mutable capture)', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float64Array(3)
      buf[0] = 1; buf[1] = 2; buf[2] = 3
      let sum = 0
      buf.forEach(x => { sum = sum + x })
      return sum
    }
  `)
  is(test(), 6)
})

// Use reduce for accumulation - no mutable capture needed
test('TypedArray - reduce sum', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float64Array(3)
      buf[0] = 1; buf[1] = 2; buf[2] = 3
      return buf.reduce((acc, x) => acc + x, 0)
    }
  `)
  is(test(), 6)
})

test('TypedArray - set', async () => {
  const { test } = await run(`
    export const test = () => {
      let src = new Int32Array(3)
      src[0] = 10; src[1] = 20; src[2] = 30
      let dst = new Int32Array(5)
      dst.set(src, 1)
      return dst[0] + dst[1] + dst[2] + dst[3] + dst[4]
    }
  `)
  is(test(), 60)  // 0 + 10 + 20 + 30 + 0
})

test('TypedArray - subarray', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float64Array(5)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4; buf[4] = 5
      let sub = buf.subarray(1, 4)
      return sub.length + sub[0] + sub[1] + sub[2]
    }
  `)
  is(test(), 12)  // 3 + 2 + 3 + 4
})

test('TypedArray - BYTES_PER_ELEMENT', async () => {
  const { test32, test64 } = await run(`
    export const test32 = () => {
      let buf = new Float32Array(1)
      return buf.BYTES_PER_ELEMENT
    }
    export const test64 = () => {
      let buf = new Float64Array(1)
      return buf.BYTES_PER_ELEMENT
    }
  `)
  is(test32(), 4)
  is(test64(), 8)
})

// ES2023 methods

test('TypedArray - sort', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float64Array(5)
      buf[0] = 3; buf[1] = 1; buf[2] = 4; buf[3] = 1; buf[4] = 5
      buf.sort()
      return buf[0] * 10000 + buf[1] * 1000 + buf[2] * 100 + buf[3] * 10 + buf[4]
    }
  `)
  is(test(), 11345)  // [1,1,3,4,5]
})

test('TypedArray - sort Int32Array', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Int32Array(4)
      buf[0] = 9; buf[1] = -5; buf[2] = 3; buf[3] = 0
      buf.sort()
      return buf[0] * 1000 + buf[1] * 100 + buf[2] * 10 + buf[3]
    }
  `)
  is(test(), -5000 + 0 + 30 + 9)  // [-5,0,3,9]
})

test('TypedArray - toReversed', async () => {
  const { original, reversed } = await run(`
    export const original = () => {
      let buf = new Float64Array(3)
      buf[0] = 1; buf[1] = 2; buf[2] = 3
      let rev = buf.toReversed()
      return buf[0]  // original unchanged
    }
    export const reversed = () => {
      let buf = new Float64Array(3)
      buf[0] = 1; buf[1] = 2; buf[2] = 3
      let rev = buf.toReversed()
      return rev[0] * 100 + rev[1] * 10 + rev[2]
    }
  `)
  is(original(), 1)   // original unchanged
  is(reversed(), 321) // reversed copy
})

test('TypedArray - toSorted', async () => {
  const { original, sorted } = await run(`
    export const original = () => {
      let buf = new Float64Array(4)
      buf[0] = 4; buf[1] = 2; buf[2] = 3; buf[3] = 1
      let s = buf.toSorted()
      return buf[0]  // original unchanged
    }
    export const sorted = () => {
      let buf = new Float64Array(4)
      buf[0] = 4; buf[1] = 2; buf[2] = 3; buf[3] = 1
      let s = buf.toSorted()
      return s[0] * 1000 + s[1] * 100 + s[2] * 10 + s[3]
    }
  `)
  is(original(), 4)    // original unchanged
  is(sorted(), 1234)   // sorted copy
})

test('TypedArray - with', async () => {
  const { original, modified } = await run(`
    export const original = () => {
      let buf = new Float64Array(3)
      buf[0] = 1; buf[1] = 2; buf[2] = 3
      let w = buf.with(1, 99)
      return buf[1]  // original unchanged
    }
    export const modified = () => {
      let buf = new Float64Array(3)
      buf[0] = 1; buf[1] = 2; buf[2] = 3
      let w = buf.with(1, 99)
      return w[0] * 100 + w[1] + w[2]
    }
  `)
  is(original(), 2)   // original unchanged
  is(modified(), 202) // 1*100 + 99 + 3
})

test('TypedArray - with negative index', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float64Array(3)
      buf[0] = 1; buf[1] = 2; buf[2] = 3
      let w = buf.with(-1, 99)  // last element
      return w[0] * 100 + w[1] * 10 + w[2]
    }
  `)
  is(test(), 219)  // 1*100 + 2*10 + 99
})

// SIMD tests - Float64Array.map auto-vectorization
test('TypedArray - SIMD map multiply', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float64Array(8)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4
      buf[4] = 5; buf[5] = 6; buf[6] = 7; buf[7] = 8
      let doubled = buf.map(x => x * 2)
      return doubled[0] + doubled[3] + doubled[7]
    }
  `)
  is(test(), 26)  // 2 + 8 + 16
})

test('TypedArray - SIMD map add', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float64Array(4)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4
      let result = buf.map(x => x + 10)
      return result[0] + result[3]
    }
  `)
  is(test(), 25)  // 11 + 14
})

test('TypedArray - SIMD map odd length (remainder)', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float64Array(5)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4; buf[4] = 5
      let result = buf.map(x => x * 3)
      return result[4]  // 5 * 3 = 15 (remainder element)
    }
  `)
  is(test(), 15)
})

test('TypedArray - SIMD map divide', async () => {
  const { test } = await run(`
    export const test = () => {
      let buf = new Float64Array(4)
      buf[0] = 2; buf[1] = 4; buf[2] = 6; buf[3] = 8
      let result = buf.map(x => x / 2)
      return result[0] + result[1] + result[2] + result[3]
    }
  `)
  is(test(), 10)  // 1 + 2 + 3 + 4
})

// Float32Array SIMD tests (f32x4 - 4 elements per vector)
test('TypedArray - SIMD Float32Array map multiply', async () => {
  let { test } = await run(`
    export let test = () => {
      let buf = new Float32Array(8)
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4
      buf[4] = 5; buf[5] = 6; buf[6] = 7; buf[7] = 8
      let result = buf.map(x => x * 2)
      return result[0] + result[1] + result[2] + result[3] + result[4] + result[5] + result[6] + result[7]
    }
  `)
  is(test(), 72)  // 2+4+6+8+10+12+14+16
})

test('TypedArray - SIMD Float32Array map with remainder', async () => {
  let { test } = await run(`
    export let test = () => {
      let buf = new Float32Array(6)  // 6 elements: 4 SIMD + 2 remainder
      buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4; buf[4] = 5; buf[5] = 6
      let result = buf.map(x => x + 10)
      return result[0] + result[1] + result[2] + result[3] + result[4] + result[5]
    }
  `)
  is(test(), 81)  // 11+12+13+14+15+16
})
