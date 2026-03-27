// Comprehensive data type tests: arrays, objects, strings
// Adapted from old arch tests + new NaN-boxing architecture
import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import compile from '../index.js'

function run(code) {
  const wasm = compile(code)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod).exports
}

// ============================================
// ARRAYS
// ============================================

// --- Literals & indexing ---

test('array: empty', () => {
  is(run('export let f = () => { let a = []; return a.length }').f(), 0)
})

test('array: single element', () => {
  is(run('export let f = () => { let a = [42]; return a[0] }').f(), 42)
})

test('array: 3 elements', () => {
  const { f } = run('export let f = (i) => { let a = [10, 20, 30]; return a[i] }')
  is(f(0), 10); is(f(1), 20); is(f(2), 30)
})

test('array: float elements', () => {
  const { f } = run('export let f = () => { let a = [1.5, 2.7, 3.14]; return a[2] }')
  almost(f(), 3.14)
})

test('array: negative values', () => {
  is(run('export let f = () => { let a = [-1, -2, -3]; return a[0] + a[1] + a[2] }').f(), -6)
})

// --- .length ---

test('array: .length 0', () => {
  is(run('export let f = () => [].length').f(), 0)
})

test('array: .length 1', () => {
  is(run('export let f = () => { let a = [99]; return a.length }').f(), 1)
})

test('array: .length 5', () => {
  is(run('export let f = () => { let a = [1,2,3,4,5]; return a.length }').f(), 5)
})

test('array: .length 20 (large)', () => {
  is(run(`export let f = () => {
    let a = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19]
    return a.length
  }`).f(), 20)
})

// --- Write ---

test('array: write single', () => {
  is(run('export let f = () => { let a = [0,0,0]; a[1] = 42; return a[1] }').f(), 42)
})

test('array: write computed index', () => {
  const { f } = run('export let f = (i, v) => { let a = [0,0,0]; a[i] = v; return a[i] }')
  is(f(0, 10), 10); is(f(2, 30), 30)
})

test('array: write preserves other elements', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    a[1] = 99
    return a[0] + a[2]
  }`)
  is(f(), 4)  // 1 + 3, a[1] changed but 0 and 2 untouched
})

// --- Loops ---

test('array: sum via loop', () => {
  is(run(`export let f = () => {
    let a = [1, 2, 3, 4, 5]
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i]
    return s
  }`).f(), 15)
})

test('array: fill via loop', () => {
  const { f } = run(`export let f = (n) => {
    let a = [0, 0, 0, 0, 0]
    for (let i = 0; i < 5; i++) a[i] = i * i
    return a[n]
  }`)
  is(f(0), 0); is(f(2), 4); is(f(4), 16)
})

test('array: dot product', () => {
  is(run(`
    let dot = (a, b) => {
      let s = 0
      for (let i = 0; i < a.length; i++) s += a[i] * b[i]
      return s
    }
    export let f = () => dot([1,2,3], [4,5,6])
  `).f(), 32)
})

// --- Pass & return ---

test('array: pass as param', () => {
  is(run(`
    let sum3 = (a) => a[0] + a[1] + a[2]
    export let f = () => sum3([10, 20, 30])
  `).f(), 60)
})

test('array: return pointer', () => {
  const { make, get } = run(`
    export let make = () => { let a = [5, 10, 15]; return a }
    export let get = (a, i) => a[i]
  `)
  const ptr = make()
  ok(isNaN(ptr))
  is(get(ptr, 0), 5)
  is(get(ptr, 2), 15)
})

// --- Multi-value vs pointer ---

test('array: literal return ≤8 = multi-value', () => {
  const r = run('export let f = (a, b) => [a + 1, b + 2]').f(10, 20)
  ok(Array.isArray(r))
  is(r[0], 11); is(r[1], 22)
})

test('array: >8 elements = pointer', () => {
  const { f, g } = run(`
    export let f = () => { let a = [1,2,3,4,5,6,7,8,9]; return a }
    export let g = (a) => a[8]
  `)
  ok(isNaN(f()))
  is(g(f()), 9)
})

// ============================================
// OBJECTS
// ============================================

// --- Literals & read ---

test('object: two properties', () => {
  const { f } = run('export let f = () => { let o = {x: 10, y: 20}; return o.x + o.y }')
  is(f(), 30)
})

test('object: three properties', () => {
  is(run('export let f = () => { let o = {r: 1, g: 2, b: 3}; return o.r + o.g + o.b }').f(), 6)
})

test('object: float values', () => {
  almost(run('export let f = () => { let o = {pi: 3.14, e: 2.71}; return o.pi }').f(), 3.14)
})

test('object: computed values', () => {
  is(run('export let f = (a, b) => { let o = {sum: a + b, diff: a - b}; return o.sum * o.diff }').f(5, 3), 16)
})

// --- Write ---

test('object: write property', () => {
  is(run('export let f = () => { let o = {x: 0, y: 0}; o.x = 42; return o.x }').f(), 42)
})

test('object: write preserves other props', () => {
  is(run(`export let f = () => {
    let o = {a: 1, b: 2, c: 3}
    o.b = 99
    return o.a + o.c
  }`).f(), 4)
})

// --- Pass & return ---

test('object: pass to function', () => {
  is(run(`
    let mag2 = (v) => v.x * v.x + v.y * v.y
    export let f = () => mag2({x: 3, y: 4})
  `).f(), 25)
})

test('object: return as pointer', () => {
  const { make, getX, getY } = run(`
    export let make = (a, b) => { let o = {x: a, y: b}; return o }
    export let getX = (o) => o.x
    export let getY = (o) => o.y
  `)
  const ptr = make(7, 11)
  ok(isNaN(ptr))
  is(getX(ptr), 7)
  is(getY(ptr), 11)
})

test('object: multiple instances same schema', () => {
  const { f } = run(`
    let dist = (a, b) => {
      let dx = a.x - b.x
      let dy = a.y - b.y
      return dx * dx + dy * dy
    }
    export let f = () => dist({x: 0, y: 0}, {x: 3, y: 4})
  `)
  is(f(), 25)
})

// ============================================
// STRINGS
// ============================================

// --- SSO (short string, ≤4 ASCII chars) ---

test('string: SSO creation', () => {
  const ptr = run('export let f = () => { let s = "hi"; return s }').f()
  ok(isNaN(ptr))  // NaN-boxed
})

test('string: SSO .length', () => {
  is(run('export let f = () => { let s = "abc"; return s.length }').f(), 3)
})

test('string: SSO empty', () => {
  is(run('export let f = () => { let s = ""; return s.length }').f(), 0)
})

test('string: SSO max (4 chars)', () => {
  is(run('export let f = () => { let s = "abcd"; return s.length }').f(), 4)
})

test('string: SSO single char', () => {
  is(run('export let f = () => { let s = "x"; return s.length }').f(), 1)
})

// --- Heap strings (>4 chars) ---

test('string: heap creation', () => {
  const ptr = run('export let f = () => { let s = "hello world"; return s }').f()
  ok(isNaN(ptr))
})

test('string: heap .length', () => {
  is(run('export let f = () => { let s = "hello world!"; return s.length }').f(), 12)
})

test('string: heap .length 5 (boundary)', () => {
  is(run('export let f = () => { let s = "hello"; return s.length }').f(), 5)
})

test('string: heap .length long', () => {
  is(run('export let f = () => { let s = "the quick brown fox jumps"; return s.length }').f(), 25)
})

// --- String as parameter ---

test('string: pass SSO to function', () => {
  is(run(`
    let len = (s) => s.length
    export let f = () => len("abc")
  `).f(), 3)
})

test('string: pass heap to function', () => {
  is(run(`
    let len = (s) => s.length
    export let f = () => len("hello world")
  `).f(), 11)
})

// ============================================
// MIXED
// ============================================

test('mixed: array of computed values', () => {
  const { f } = run(`export let f = (x) => {
    let a = [x, x * 2, x * 3]
    return a[0] + a[1] + a[2]
  }`)
  is(f(10), 60)
})

test('mixed: object with array access pattern', () => {
  const { f } = run(`export let f = () => {
    let data = [100, 200, 300]
    let cfg = {idx: 1, scale: 0.5}
    return data[cfg.idx]
  }`)
  is(f(), 200)
})

test('mixed: nested function calls', () => {
  is(run(`
    let add = (a, b) => a + b
    let scale = (v, s) => {
      let r = {x: v.x * s, y: v.y * s}
      return r
    }
    export let f = () => {
      let v = scale({x: 3, y: 4}, 2)
      return v.x + v.y
    }
  `).f(), 14)
})

// ============================================
// String indexing (charCodeAt)
// ============================================

test('string: SSO [i] charCodeAt', () => {
  // "hi"[0] = 'h' = 104, [1] = 'i' = 105
  const { f } = run('export let f = (i) => { let s = "hi"; return s[i] }')
  is(f(0), 104)
  is(f(1), 105)
})

test('string: heap [i] charCodeAt', () => {
  // "hello world"[0] = 'h' = 104, [6] = 'w' = 119
  const { f } = run('export let f = (i) => { let s = "hello world"; return s[i] }')
  is(f(0), 104)
  is(f(6), 119)
})

test('string: literal [i]', () => {
  is(run('export let f = () => "abc"[1]').f(), 98)  // 'b' = 98
})

// ============================================
// Array mutation: push, pop, alias
// ============================================

test('array: push basic', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    a.push(4)
    return a[3]
  }`)
  is(f(), 4)
})

test('array: push updates length', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    a.push(3)
    a.push(4)
    return a.length
  }`)
  is(f(), 4)
})

test('array: pop returns last', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20, 30]
    return a.pop()
  }`)
  is(f(), 30)
})

test('array: pop decrements length', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20, 30]
    a.pop()
    return a.length
  }`)
  is(f(), 2)
})

test('array: push then pop', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    a.push(99)
    return a.pop()
  }`)
  is(f(), 99)
})

test('array: alias sees length change', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    let b = a
    a.push(4)
    return b.length
  }`)
  is(f(), 4)  // b sees a's push because length is in memory
})

test('array: alias sees element write', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    let b = a
    a[0] = 99
    return b[0]
  }`)
  is(f(), 99)  // b sees a's write (same memory)
})

// ============================================
// Set/Map alias (mutate in place)
// ============================================

test('Set: add returns same pointer (alias-safe)', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    let s2 = s
    s.add(42)
    return s2.has(42)
  }`)
  is(f(), 1)  // s2 sees the add
})

test('Map: set returns same pointer (alias-safe)', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    let m2 = m
    m.set(1, 100)
    return m2.get(1)
  }`)
  is(f(), 100)  // m2 sees the set
})

// ============================================
// Edge cases: push chain, empty pop
// ============================================

test('array: push chained', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    a.push(2)
    a.push(3)
    a.push(4)
    return a[0] + a[1] + a[2] + a[3]
  }`)
  is(f(), 10)
})

test('array: push preserves existing', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20]
    a.push(30)
    return a[0] + a[1]
  }`)
  is(f(), 30)  // original elements unchanged
})

test('array: pop on single element', () => {
  const { f } = run(`export let f = () => {
    let a = [42]
    let v = a.pop()
    return v + a.length
  }`)
  is(f(), 42)  // v=42, length=0
})
