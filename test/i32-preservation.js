// i32 type preservation tests
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile as jzCompile } from '../index.js'

// Helper to get WAT text
function getWat(code) {
  return jzCompile(code, { text: true })
}

test('i32 preservation - integer literals', () => {
  // Integer literals should use i32.const
  const wat = getWat('0')
  ok(wat.includes('i32.const 0'), 'integer 0 should be i32')

  const wat2 = getWat('42')
  ok(wat2.includes('i32.const 42'), 'integer 42 should be i32')

  const wat3 = getWat('-1')
  ok(wat3.includes('i32.const'), 'integer -1 should be i32')
})

test('i32 preservation - float literals use f64', () => {
  // Float literals should use f64.const
  const wat = getWat('3.14')
  ok(wat.includes('f64.const 3.14'), 'float 3.14 should be f64')

  const wat2 = getWat('0.5')
  ok(wat2.includes('f64.const 0.5'), 'float 0.5 should be f64')
})

test('i32 preservation - integer arithmetic with variables', () => {
  // i32 + i32 should stay i32 (need variables to prevent constant folding)
  const wat = getWat('let a = 1; a + 2')
  ok(wat.includes('i32.add'), 'i32 + i32 should use i32.add')
  ok(wat.includes('(local $a i32)'), 'variable should be i32')

  const wat2 = getWat('let x = 5; x - 3')
  ok(wat2.includes('i32.sub'), 'i32 - i32 should use i32.sub')

  const wat3 = getWat('let y = 2; y * 3')
  ok(wat3.includes('i32.mul'), 'i32 * i32 should use i32.mul')
})

test('i32 preservation - mixed arithmetic promotes to f64', () => {
  // i32 + f64 should promote to f64
  const wat = getWat('let a = 1; a + 0.5')
  ok(wat.includes('f64.add'), 'i32 + f64 should use f64.add')

  const wat2 = getWat('let x = 1.5; x + 2')
  ok(wat2.includes('f64.add'), 'f64 + i32 should use f64.add')
})

test('i32 preservation - comparisons produce i32', () => {
  // Comparisons should produce i32 result
  const wat = getWat('let a = 1; a < 2')
  ok(wat.includes('i32.lt_s'), 'i32 < i32 should use i32.lt_s')

  const wat2 = getWat('let x = 5; x >= 3')
  ok(wat2.includes('i32.ge_s'), 'i32 >= i32 should use i32.ge_s')
})

test('i32 preservation - bitwise always i32', () => {
  // Bitwise ops always work with i32
  const wat = getWat('let a = 5; a & 3')
  ok(wat.includes('i32.and'), 'bitwise & should use i32.and')

  const wat2 = getWat('let x = 1; x << 2')
  ok(wat2.includes('i32.shl'), 'left shift should use i32.shl')
})

test('i32 preservation - division always f64', () => {
  // Division in JS always produces float
  const wat = getWat('let a = 4; a / 2')
  ok(wat.includes('f64.div'), 'division should use f64.div')
})

test('i32 preservation - type promotion to f64', () => {
  // If a variable is assigned f64 later, it should be f64 from start
  const wat = getWat(`
    export const test = () => {
      let sum = 0
      sum = sum + 0.5
      return sum
    }
  `)
  ok(wat.includes('(local $sum'), 'should have sum local')
  ok(wat.includes('(local $sum_s1 f64)'), 'sum should be promoted to f64')
})

test('i32 preservation - function returns i32', () => {
  // Function that only returns i32 values should have i32 return type
  const wat = getWat(`
    export const isPositive = (x) => x > 0 ? 1 : 0
  `)
  ok(wat.includes('(result i32)'), 'function should return i32')
  // Return values 1 and 0 should be i32.const, not f64.const
  ok(wat.includes('(i32.const 1)'), 'return 1 should be i32')
  ok(wat.includes('(i32.const 0)'), 'return 0 should be i32')
})

test('i32 preservation - function returns f64 when needed', () => {
  // Function that returns float should have f64 return type
  const wat = getWat(`
    export const half = (x) => x / 2
  `)
  ok(wat.includes('(result f64)'), 'function should return f64')
})

test('i32 preservation - comparison function returns i32', () => {
  // Function with comparison return should be i32
  const wat = getWat(`
    export const equals = (a, b) => a === b
  `)
  ok(wat.includes('(result i32)'), 'comparison function should return i32')
})
