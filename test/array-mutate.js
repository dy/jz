import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { evaluate } from './util.js'

// Tests for array mutation methods: push, pop
// Note: gc:true returns new arrays:false may mutate in-place within capacity

// push - returns new array with element appended
test('push - basic', async () => {
  is(await evaluate('[1,2,3].push(4).length'), 4)
  is(await evaluate('[1,2,3].push(4)[3]'), 4)
  is(await evaluate('[1,2,3].push(4)[0]'), 1)
})

test('push - empty array', async () => {
  is(await evaluate('[].push(1).length'), 1)
  is(await evaluate('[].push(1)[0]'), 1)
})

test('push - preserves original elements', async () => {
  is(await evaluate('[10,20,30].push(40)[0]'), 10)
  is(await evaluate('[10,20,30].push(40)[1]'), 20)
  is(await evaluate('[10,20,30].push(40)[2]'), 30)
  is(await evaluate('[10,20,30].push(40)[3]'), 40)
})

test('push - with expression', async () => {
  is(await evaluate('[1,2].push(1+2)[2]'), 3)
  is(await evaluate('[1,2].push(Math.sqrt(16))[2]'), 4)
})

test('push - chained', async () => {
  is(await evaluate('[1].push(2).push(3).length'), 3)
  is(await evaluate('[1].push(2).push(3)[2]'), 3)
})

// pop - returns last element
test('pop - basic', async () => {
  is(await evaluate('[1,2,3].pop()'), 3)
  is(await evaluate('[10,20,30,40].pop()'), 40)
})

test('pop - single element', async () => {
  is(await evaluate('[42].pop()'), 42)
})

test('pop - empty array returns NaN', async () => {
  ok(isNaN(await evaluate('[].pop()')))
})

// push/pop use mutable semantics (like JS) for O(1) performance
// Note: unlike JS, push returns the array (for chaining), not the new length
test('push - mutable semantics', async () => {
  // Within capacity: push mutates the original, a and b point to same array
  is(await evaluate('{ let a = [1,2,3]; let b = a.push(4); a.length }'), 4)
  is(await evaluate('{ let a = [1,2,3]; let b = a.push(4); b.length }'), 4)
  is(await evaluate('{ let a = [1,2,3]; let b = a.push(4); a[3] }'), 4)
})

test('pop - mutable semantics', async () => {
  // pop mutates the original array
  is(await evaluate('{ let a = [1,2,3]; let x = a.pop(); a.length }'), 2)
  is(await evaluate('{ let a = [1,2,3]; let x = a.pop(); x }'), 3)
})

// Capacity tier tests (gc:false specific behavior)
// With implicit capacity tiers (4,8,16,32...), push within capacity is efficient
test('push - within capacity tier', async () => {
  // Array of 3 has capacity 4, push one stays in tier
  is(await evaluate('[1,2,3].push(4).length'), 4)
  // Array of 4 has capacity 4, push exceeds to capacity 8
  is(await evaluate('[1,2,3,4].push(5).length'), 5)
})

test('push - across capacity tiers', async () => {
  // Push multiple to cross tiers
  is(await evaluate('[1].push(2).push(3).push(4).push(5).length'), 5)
  is(await evaluate('[1].push(2).push(3).push(4).push(5)[4]'), 5)
})

// Stress test - many pushes
test('push - many elements', async () => {
  // Build array with reduce + push simulation
  is(await evaluate(`{
    let a = [0];
    let i = 1;
    while (i < 10) {
      a = a.push(i);
      i = i + 1;
    }
    a.length
  }`), 10)
})

// Combined push/pop patterns
test('push then pop', async () => {
  is(await evaluate('[1,2].push(3).pop()'), 3)
  is(await evaluate('[1].push(2).push(3).pop()'), 3)
})

// Filter with length check
test('filter and push', async () => {
  // Memory mode: filter returns proper length array [3,4,5], push adds 6
  const len = await evaluate('[1,2,3,4,5].filter(x => x > 2).push(6).length')
  is(len, 4)  // [3,4,5,6].length = 4
  const val = await evaluate('[1,2,3,4,5].filter(x => x > 2).push(6)[3]')
  is(val, 6)  // [3,4,5,6][3] = 6
})

// Map then push
test('map and push', async () => {
  is(await evaluate('[1,2,3].map(x => x * 2).push(8)[3]'), 8)
  is(await evaluate('[1,2,3].map(x => x * 2).push(8)[0]'), 2)
})
// === shift tests ===
// shift() returns first element (does not mutate in jz - returns same array)
test('shift - returns first element', async () => {
  is(await evaluate('[1, 2, 3].shift()'), 1)
  is(await evaluate('[10, 20, 30].shift()'), 10)
  is(await evaluate('[42].shift()'), 42)
})

test('shift - empty returns NaN', async () => {
  ok(isNaN(await evaluate('[].shift()')))
})

// Note: jz shift does NOT mutate - it just returns the first element
test('shift - original unchanged (jz semantics)', async () => {
  is(await evaluate('{ let a = [1, 2, 3]; a.shift(); a.length }'), 3)
  is(await evaluate('{ let a = [1, 2, 3]; a.shift(); a[0] }'), 1)
})

// === unshift tests ===
// unshift(x) prepends element, returns NEW array
test('unshift - prepends element', async () => {
  is(await evaluate('[2, 3].unshift(1)[0]'), 1)
  is(await evaluate('[2, 3].unshift(1)[1]'), 2)
  is(await evaluate('[2, 3].unshift(1)[2]'), 3)
  is(await evaluate('[2, 3].unshift(1).length'), 3)
})

test('unshift - empty array', async () => {
  is(await evaluate('[].unshift(5)[0]'), 5)
  is(await evaluate('[].unshift(5).length'), 1)
})

test('unshift - original unchanged (new array semantics)', async () => {
  is(await evaluate('{ let a = [1, 2]; let b = a.unshift(0); a.length }'), 2)
  is(await evaluate('{ let a = [1, 2]; let b = a.unshift(0); b.length }'), 3)
  is(await evaluate('{ let a = [1, 2]; let b = a.unshift(0); a[0] }'), 1)
  is(await evaluate('{ let a = [1, 2]; let b = a.unshift(0); b[0] }'), 0)
})

test('unshift - chained', async () => {
  is(await evaluate('[3].unshift(2).unshift(1).length'), 3)
  is(await evaluate('[3].unshift(2).unshift(1)[0]'), 1)
  is(await evaluate('[3].unshift(2).unshift(1)[1]'), 2)
  is(await evaluate('[3].unshift(2).unshift(1)[2]'), 3)
})

// Combinations
test('push and shift', async () => {
  is(await evaluate('[1, 2].push(3).shift()'), 1)
})

test('unshift and pop', async () => {
  is(await evaluate('[1, 2].unshift(0).pop()'), 2)
})

test('unshift and shift', async () => {
  is(await evaluate('[1, 2].unshift(0).shift()'), 0)
})

// Build array with unshift (reverse order)
test('unshift - build array', async () => {
  is(await evaluate(`{
    let a = [];
    let i = 3;
    while (i > 0) {
      a = a.unshift(i);
      i = i - 1;
    }
    a.length
  }`), 3)
  is(await evaluate(`{
    let a = [];
    let i = 3;
    while (i > 0) {
      a = a.unshift(i);
      i = i - 1;
    }
    a[0]
  }`), 1)
  is(await evaluate(`{
    let a = [];
    let i = 3;
    while (i > 0) {
      a = a.unshift(i);
      i = i - 1;
    }
    a[2]
  }`), 3)
})
// O(1) complexity tests - verify scaling via timing
// These catch regressions where push/pop/shift/unshift become O(n)
// O(1): 10x ops → ~10x time. O(n): 10x ops → ~100x time

import { compile } from './util.js'

async function measureOps(code, warmup = 2) {
  const mod = await compile(code)
  for (let i = 0; i < warmup; i++) mod.run()
  const start = performance.now()
  mod.run()
  return performance.now() - start
}

test('push - O(1) scaling', async () => {
  const t100 = await measureOps(`
    export const run = () => {
      let a = [];
      for (let i = 0; i < 100; i = i + 1) a = a.push(i);
      a.length
    }
  `)
  const t1000 = await measureOps(`
    export const run = () => {
      let a = [];
      for (let i = 0; i < 1000; i = i + 1) a = a.push(i);
      a.length
    }
  `)
  const ratio = t1000 / t100
  ok(ratio < 12, `push should be O(1): 10x ops → ${ratio.toFixed(1)}x time (expected <12x)`)
})

test('pop - O(1) scaling', async () => {
  const t100 = await measureOps(`
    export const run = () => {
      let a = [];
      for (let i = 0; i < 100; i = i + 1) a = a.push(i);
      for (let i = 0; i < 100; i = i + 1) a.pop();
      a.length
    }
  `)
  const t1000 = await measureOps(`
    export const run = () => {
      let a = [];
      for (let i = 0; i < 1000; i = i + 1) a = a.push(i);
      for (let i = 0; i < 1000; i = i + 1) a.pop();
      a.length
    }
  `)
  const ratio = t1000 / t100
  ok(ratio < 12, `pop should be O(1): 10x ops → ${ratio.toFixed(1)}x time (expected <12x)`)
})

test('shift - O(1) via ring buffer', async () => {
  const t100 = await measureOps(`
    export const run = () => {
      let a = [];
      for (let i = 0; i < 100; i = i + 1) a = a.push(i);
      a = a.unshift(0);
      for (let i = 0; i < 100; i = i + 1) a.shift();
      a.length
    }
  `)
  const t1000 = await measureOps(`
    export const run = () => {
      let a = [];
      for (let i = 0; i < 1000; i = i + 1) a = a.push(i);
      a = a.unshift(0);
      for (let i = 0; i < 1000; i = i + 1) a.shift();
      a.length
    }
  `)
  const ratio = t1000 / t100
  ok(ratio < 12, `shift should be O(1): 10x ops → ${ratio.toFixed(1)}x time (expected <12x)`)
})

test('unshift - O(1) via ring buffer', async () => {
  const t100 = await measureOps(`
    export const run = () => {
      let a = [];
      for (let i = 0; i < 100; i = i + 1) a = a.unshift(i);
      a.length
    }
  `)
  const t1000 = await measureOps(`
    export const run = () => {
      let a = [];
      for (let i = 0; i < 1000; i = i + 1) a = a.unshift(i);
      a.length
    }
  `)
  const ratio = t1000 / t100
  ok(ratio < 12, `unshift should be O(1): 10x ops → ${ratio.toFixed(1)}x time (expected <12x)`)
})

test('queue pattern - O(1) push+shift', async () => {
  const t100 = await measureOps(`
    export const run = () => {
      let a = [];
      a = a.unshift(0);
      for (let i = 0; i < 100; i = i + 1) { a = a.push(i); a.shift(); }
      a.length
    }
  `)
  const t1000 = await measureOps(`
    export const run = () => {
      let a = [];
      a = a.unshift(0);
      for (let i = 0; i < 1000; i = i + 1) { a = a.push(i); a.shift(); }
      a.length
    }
  `)
  const ratio = t1000 / t100
  ok(ratio < 12, `queue should be O(1): 10x ops → ${ratio.toFixed(1)}x time (expected <12x)`)
})

test('stack pattern - O(1) push+pop', async () => {
  const t100 = await measureOps(`
    export const run = () => {
      let a = [];
      for (let i = 0; i < 100; i = i + 1) { a = a.push(i); a.pop(); }
      a.length
    }
  `)
  const t1000 = await measureOps(`
    export const run = () => {
      let a = [];
      for (let i = 0; i < 1000; i = i + 1) { a = a.push(i); a.pop(); }
      a.length
    }
  `)
  const ratio = t1000 / t100
  ok(ratio < 12, `stack should be O(1): 10x ops → ${ratio.toFixed(1)}x time (expected <12x)`)
})
