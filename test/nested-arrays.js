// Tests for nested arrays with mixed types
// gc:false: Full support via NaN-based pointer encoding in f64 arrays
// gc:true (features: 'gc'): Full support via anyref arrays
// Focus: Ensure both modes handle nested array cases correctly

import test from 'tst'
import { is } from 'tst/assert.js'
import { evaluate } from './util.js'

// ===== gc:true NESTED ARRAYS (anyref arrays) =====

test('nested arrays - static nested f64 arrays (gc:true)', async () => {
  is(await evaluate('[[1, 2, 3], [4, 5, 6]][0][1]'), 2)
})

test('nested arrays - static triple nested (gc:true)', async () => {
  is(await evaluate('[[[1, 2], [3, 4]], [[5, 6]]][0][0][1]'), 2)
})

test('nested arrays - quad nested (gc:true)', async () => {
  is(await evaluate('[[[[5]]]][0][0][0][0]'), 5)
})

test('nested arrays - dynamic index (gc:true)', async () => {
  is(await evaluate('let i = 1; [[1,2],[3,4]][i][0]'), 3)
})

test('nested arrays - nested with var (gc:true)', async () => {
  is(await evaluate('let a = [[1,2],[3,4]]; a[0][1]'), 2)
})

test('nested arrays - mixed depth (gc:true)', async () => {
  // Inner arrays have different lengths
  is(await evaluate('[[[1,2],[3,4,5]],[[6]]][0][1][2]'), 5)
})

// ===== gc:false NESTED ARRAYS (Full support) =====

test('nested arrays - static nested f64 arrays (gc:false)', async () => {
  is(await evaluate('[[1, 2, 3], [4, 5, 6]][0][1]', { gc: false }), 2)
})

test('nested arrays - static triple nested (gc:false)', async () => {
  is(await evaluate('[[[1, 2], [3, 4]], [[5, 6]]][0][0][1]', { gc: false }), 2)
})

test('nested arrays - dynamic nested with map (gc:false)', async () => {
  const code = `
    let a = [1, 2, 3]
    let b = a.map(x => [x, x * 2])
    b[1][0]
  `
  is(await evaluate(code, { gc: false }), 2)
})

test('nested arrays - mixed array with nested arrays (gc:false)', async () => {
  const code = `
    let a = [1, [2, 3], 4, [5, 6]]
    let b = a[1][0]
    b + a[3][1]
  `
  is(await evaluate(code, { gc: false }), 8)
})

test('nested arrays - mixed types with string (gc:false)', async () => {
  const code = `
    let a = [1, "hi", 2]
    let b = a[1]
    b.length
  `
  is(await evaluate(code, { gc: false }), 2)
})

test('nested arrays - array containing strings and numbers (gc:false)', async () => {
  const code = `
    let a = [1, "hello", 2, "world"]
    a[1].length + a[3].length
  `
  is(await evaluate(code, { gc: false }), 10)
})

test('nested arrays - array with string, number, nested array (gc:false)', async () => {
  const code = `
    let a = ["test", 3.5, [7, 8, 9]]
    a[1] + a[2][1]
  `
  is(await evaluate(code, { gc: false }), 11.5)
})

test('nested arrays - object in array (gc:false)', async () => {
  const code = `
    let a = [{x: 10, y: 20}, {x: 30, y: 40}]
    a[0].x + a[1].y
  `
  is(await evaluate(code, { gc: false }), 50)
})

test('nested arrays - mixed with objects and numbers (gc:false)', async () => {
  const code = `
    let a = [1, {x: 2}, 3, {x: 4}]
    a[0] + a[1].x + a[2] + a[3].x
  `
  is(await evaluate(code, { gc: false }), 10)
})

test('nested arrays - array with all types (gc:false)', async () => {
  const code = `
    let a = [1, "hi", [2, 3], {x: 4}]
    a[0] + a[1].length + a[2][0] + a[3].x
  `
  is(await evaluate(code, { gc: false }), 9)
})

test('nested arrays - reduce over mixed array (gc:false)', async () => {
  const code = `
    let a = [1, [2, 3], 4]
    a.reduce((acc, x) => typeof x === 'number' ? acc + x : acc + x[0], 0)
  `
  is(await evaluate(code, { gc: false }), 7)
})

test('nested arrays - static then dynamic modification (gc:false)', async () => {
  const code = `
    let a = [[1, 2], [3, 4]]
    let b = a.map(x => x[0] + 10)
    b[0] + b[1]
  `
  is(await evaluate(code, { gc: false }), 24)
})

test('nested arrays - deeply nested (gc:false)', async () => {
  const code = `
    let a = [[[[1, 2], 3]], 4]
    a[0][0][0][1] + a[1]
  `
  is(await evaluate(code, { gc: false }), 6)
})

test('nested arrays - alternating types (gc:false)', async () => {
  const code = `
    let a = [1, [2], 3, [4, 5], "x", [6]]
    a[1][0] + a[3][1] + a[5][0]
  `
  is(await evaluate(code, { gc: false }), 13)
})
