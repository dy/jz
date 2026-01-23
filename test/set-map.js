import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { evaluate, compile } from './util.js'

// ===== Set basic operations =====

test('Set: new Set() creates empty set', async () => {
  is(await evaluate('let s = new Set(); s.size'), 0)
})

test('Set: add and has with numbers', async () => {
  is(await evaluate('let s = new Set(); s.add(1); s.has(1)'), 1)
  is(await evaluate('let s = new Set(); s.add(1); s.has(2)'), 0)
})

test('Set: add returns set for chaining', async () => {
  is(await evaluate('let s = new Set(); s.add(1).add(2).add(3).size'), 3)
})

test('Set: size updates correctly', async () => {
  is(await evaluate('let s = new Set(); s.add(1); s.add(2); s.size'), 2)
  is(await evaluate('let s = new Set(); s.add(1); s.add(1); s.size'), 1) // No duplicates
})

test('Set: delete removes element', async () => {
  is(await evaluate('let s = new Set(); s.add(1); s.delete(1); s.has(1)'), 0)
  is(await evaluate('let s = new Set(); s.add(1); s.delete(1); s.size'), 0)
})

test('Set: delete returns whether element existed', async () => {
  is(await evaluate('let s = new Set(); s.add(1); s.delete(1)'), 1)
  is(await evaluate('let s = new Set(); s.delete(1)'), 0)
})

test('Set: clear removes all elements', async () => {
  is(await evaluate('let s = new Set(); s.add(1).add(2).add(3); s.clear(); s.size'), 0)
})

test('Set: works with negative numbers', async () => {
  is(await evaluate('let s = new Set(); s.add(-5); s.has(-5)'), 1)
  is(await evaluate('let s = new Set(); s.add(-5); s.has(5)'), 0)
})

test('Set: works with floating point', async () => {
  is(await evaluate('let s = new Set(); s.add(3.14); s.has(3.14)'), 1)
  is(await evaluate('let s = new Set(); s.add(3.14); s.has(3.15)'), 0)
})

// ===== Set with string keys =====

test('Set: works with string keys', async () => {
  is(await evaluate('let s = new Set(); s.add("hello"); s.has("hello")'), 1)
  is(await evaluate('let s = new Set(); s.add("hello"); s.has("world")'), 0)
})

test('Set: distinguishes strings from numbers', async () => {
  // "1" and 1 have different NaN-boxed representations
  const code = `
    let s = new Set()
    s.add("1")
    s.add(1)
    s.size
  `
  is(await evaluate(code), 2)
})

// ===== Map basic operations =====

test('Map: new Map() creates empty map', async () => {
  is(await evaluate('let m = new Map(); m.size'), 0)
})

test('Map: set and get with numbers', async () => {
  is(await evaluate('let m = new Map(); m.set(1, 100); m.get(1)'), 100)
  is(await evaluate('let m = new Map(); m.set(1, 100); m.get(2)'), 0) // undefined = 0
})

test('Map: set returns map for chaining', async () => {
  is(await evaluate('let m = new Map(); m.set(1, 10).set(2, 20).set(3, 30).size'), 3)
})

test('Map: has checks key existence', async () => {
  is(await evaluate('let m = new Map(); m.set(1, 100); m.has(1)'), 1)
  is(await evaluate('let m = new Map(); m.set(1, 100); m.has(2)'), 0)
})

test('Map: size updates correctly', async () => {
  is(await evaluate('let m = new Map(); m.set(1, 10); m.set(2, 20); m.size'), 2)
  is(await evaluate('let m = new Map(); m.set(1, 10); m.set(1, 20); m.size'), 1) // Update, not add
})

test('Map: set updates existing key', async () => {
  is(await evaluate('let m = new Map(); m.set(1, 10); m.set(1, 99); m.get(1)'), 99)
})

test('Map: delete removes entry', async () => {
  is(await evaluate('let m = new Map(); m.set(1, 100); m.delete(1); m.has(1)'), 0)
  is(await evaluate('let m = new Map(); m.set(1, 100); m.delete(1); m.size'), 0)
})

test('Map: delete returns whether key existed', async () => {
  is(await evaluate('let m = new Map(); m.set(1, 100); m.delete(1)'), 1)
  is(await evaluate('let m = new Map(); m.delete(1)'), 0)
})

test('Map: clear removes all entries', async () => {
  is(await evaluate('let m = new Map(); m.set(1, 10).set(2, 20); m.clear(); m.size'), 0)
})

// ===== Map with string keys =====

test('Map: works with string keys', async () => {
  is(await evaluate('let m = new Map(); m.set("name", 42); m.get("name")'), 42)
  is(await evaluate('let m = new Map(); m.set("name", 42); m.has("name")'), 1)
})

test('Map: string values', async () => {
  const instance = await compile(`
    export function test() {
      let m = new Map()
      m.set(1, "hello")
      return m.get(1)
    }
  `)
  is(instance.test(), "hello")
})

// ===== Collision handling =====

test('Set: handles many insertions (collision test)', async () => {
  const code = `
    let s = new Set()
    let i = 0
    while (i < 10) {
      s.add(i)
      i = i + 1
    }
    s.size
  `
  is(await evaluate(code), 10)
})

test('Map: handles many insertions (collision test)', async () => {
  const code = `
    let m = new Map()
    let i = 0
    while (i < 10) {
      m.set(i, i * 10)
      i = i + 1
    }
    m.get(5) + m.get(9)
  `
  is(await evaluate(code), 140) // 50 + 90
})

// ===== Edge cases =====

test('Set: works with zero', async () => {
  is(await evaluate('let s = new Set(); s.add(0); s.has(0)'), 1)
})

test('Map: works with zero key', async () => {
  is(await evaluate('let m = new Map(); m.set(0, 123); m.get(0)'), 123)
})

test('Set: custom capacity', async () => {
  is(await evaluate('let s = new Set(32); s.add(1); s.has(1)'), 1)
})

test('Map: custom capacity', async () => {
  is(await evaluate('let m = new Map(32); m.set(1, 100); m.get(1)'), 100)
})
