// Comprehensive data type tests: arrays, objects, strings
// Adapted from old arch tests + new NaN-boxing architecture
import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, adaptI64 } from './_matrix.js'

function run(code, opts) {
  const { module, instance } = jz(code, opts)
  return adaptI64(module, instance.exports)
}

// ============================================
// ARRAYS
// ============================================

// --- BigInt return boundary ---

test('bigint: a returned bigint crosses to JS as a real, lossless BigInt', () => {
  // Internally bigint rides an i64 reinterpreted into the f64 carrier; the export thunk exposes
  // the raw i64, so the host receives a genuine JS BigInt (was a lossy Number; raw bits before that).
  is(run('export let f = () => 100n').f(), 100n)
  is(run('export let f = () => 10n - 3n').f(), 7n)
  is(run('export let f = () => 0n - 5n').f(), -5n)             // signed
  is(run('export let f = () => { return 7n * 6n }').f(), 42n)
  // |value| ≥ 2^52 only on native: jz's inline bigint carrier is a subnormal-f64 NaN-box
  // (emit's `typeof === 'bigint'` heuristic keys on subnormal magnitude), so only bigints
  // whose i64 keeps the f64 exponent field zero (|v| < 2^52) stay distinguishable from
  // numbers in the dynamic path. Native compiles via host JS BigInt (arbitrary precision,
  // exact typeof) so the static VAL.BIGINT survives; the self-host kernel parses the literal
  // into its own i64 bigint, whose large carrier reads as a normal float and loses the tag.
  // Full 64-bit bigints need heap-bigints (no PTR.BIGINT yet) or a structurally-tagged
  // literal node through the parser — a feature, not a codegen fix. See statements.js.
  if (!onKernel()) is(run('export let f = () => 9007199254740993n').f(), 9007199254740993n)  // lossless past 2^53
})

test('bigint: internal calls keep the i64 carrier (only the JS boundary surfaces it)', () => {
  // g returns bigint; f does bigint math on g()'s result, then returns. Internal calls use the
  // f64 carrier, so g()'s value reaches f exactly; only f's `$exp` export result is i64.
  is(run('export let g = () => 5n; export let f = () => g() * 2n + 1n').f(), 11n)
})

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

test('array: growth preserves direct alias reads', () => {
  const { f } = run(`export let f = () => {
    let a = [7]
    let b = a
    a.push(1, 2, 3, 4)
    return [b.length, b[0], b[4]]
  }`)
  is(f()[0], 5)
  is(f()[1], 7)
  is(f()[2], 4)
})

test('array: dynamic string key write/read', () => {
  const { f } = run(`export let f = () => {
    let a = []
    let k = 'name'
    a[k] = 7
    return a[k]
  }`)
  is(f(), 7)
})

test('array: static write visible via dynamic key', () => {
  const { f } = run(`export let f = () => {
    let a = []
    let k = 'name'
    a.name = 7
    return [a.name, a[k]]
  }`)
  is(f()[0], 7)
  is(f()[1], 7)
})

test('array: dynamic write visible via static key', () => {
  const { f } = run(`export let f = () => {
    let a = []
    let k = 'name'
    a.name = 1
    a[k] = 8
    return a.name
  }`)
  is(f(), 8)
})

test('array: nested property writes on array-valued props', () => {
  const { f } = run(`export let f = () => {
    let ctx = []
    ctx.meta = []
    ctx.meta.name = 9
    return ctx.meta.name
  }`)
  is(f(), 9)
})

test('array: mixed numeric and string keys stay coherent', () => {
  const { f } = run(`export let f = () => {
    let a = []
    a[0] = []
    a[0].name = 6
    a.name = a[0]
    return a.name.name
  }`)
  is(f(), 6)
})

test('array: growth inside helper preserves caller view', () => {
  const { f } = run(`
    let grow = (a) => a.push(1, 2, 3, 4)
    export let f = () => {
      let a = [7]
      grow(a)
      return [a.length, a[0], a[4]]
    }
  `)
  is(f()[0], 5)
  is(f()[1], 7)
  is(f()[2], 4)
})

test('array: growth inside helper preserves nested aliases', () => {
  const { f } = run(`
    let grow = (a) => a.push(1, 2, 3, 4)
    export let f = () => {
      let a = [7]
      let box = [a]
      grow(a)
      return [box[0].length, box[0][0], box[0][4]]
    }
  `)
  is(f()[0], 5)
  is(f()[1], 7)
  is(f()[2], 4)
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

test('object: flat-object facts stay scoped per function', () => {
  const { f } = run(`
    let score = () => {
      const pair = {left: 2, right: 5}
      return pair.left + pair.right
    }
    export let f = () => score()
  `)
  is(f(), 7)
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

test('object: reassigned literal can use narrower field set', () => {
  is(run(`export let f = () => {
    let o = {}
    o.a = 1
    o.b = 2
    o.c = 3
    o = {a: 4, b: 5}
    return o.a + o.b
  }`).f(), 9)
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

test('object: param schema via default value', () => {
  is(run(`
    let getX = (v={x:0,y:0}) => v.x
    export let f = () => getX({x: 42, y: 0})
  `).f(), 42)
})

test('object: param schema default resolves ambiguity', () => {
  // {x,y} has x at offset 0; {z,x} has x at offset 1.
  // Default value declares v's schema as [x,y], so v.x = offset 0.
  is(run(`
    let getX = (v={x:0,y:0}) => v.x
    export let f = () => {
      let unrelated = {z: 0, x: 0}
      return getX({x: 7, y: 0}) + unrelated.z
    }
  `).f(), 7)
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
// String indexing (returns single-char string)
// ============================================

test('string: SSO [i] returns char string', () => {
  const { f } = jz('export let f = (i) => { let s = "hi"; return s[i] }').exports
  is(f(0), 'h')
  is(f(1), 'i')
})

test('string: heap [i] returns char string', () => {
  const { f } = jz('export let f = (i) => { let s = "hello world"; return s[i] }').exports
  is(f(0), 'h')
  is(f(6), 'w')
})

test('string: literal [i]', () => {
  is(jz('export let f = () => "abc"[1]').exports.f(), 'b')
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
// Set/Map grow past capacity + delete
// INIT_CAP=8, grows at 75% load (size≥6). These force ≥2 grows (8→16→32) so
// the forwarding/rehash path runs, and exercise backward-shift delete against
// the dense probe-chain collisions a grown table produces.
// ============================================

test('Set: grow past initial capacity keeps all members', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    for (let i = 0; i < 20; i++) s.add(i)
    let ok = 1
    for (let i = 0; i < 20; i++) if (!s.has(i)) ok = 0
    return ok + s.size
  }`)
  is(f(), 21)  // ok=1, size=20 — no member lost across rehash
})

test('Map: grow past initial capacity keeps all entries', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    for (let i = 0; i < 20; i++) m.set(i, i * 10)
    let sum = 0
    for (let i = 0; i < 20; i++) sum += m.get(i)
    return sum + m.size
  }`)
  is(f(), 1920)  // sum(i*10, 0..19)=1900, +size 20
})

test('Set: delete removes member and decrements size', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s.add(1); s.add(2); s.add(3)
    let r = s.delete(2)
    return r + (s.has(2) ? 100 : 0) + s.size
  }`)
  is(f(), 3)  // delete→1, has(2)→false, size→2
})

test('Map: delete removes entry and get returns undefined', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m.set(1, 10); m.set(2, 20)
    m.delete(1)
    return (m.get(1) === undefined ? 1 : 0) + m.size
  }`)
  is(f(), 2)  // get(1)→undefined, size→1
})

test('Set: delete absent member returns false (boolean, not boxed coll)', () => {
  // Regression: methodValType inferred `.delete` as VAL.SET, so `let r = s.delete(x)`
  // boxed the i32 result into a (truthy) NaN-box — absent deletes read as true.
  const { f } = run(`export let f = () => {
    let s = new Set()
    s.add(1)
    let r = s.delete(99)
    return (r ? 100 : 0) + s.size
  }`)
  is(f(), 1)  // delete(99)→false, size unchanged at 1
})

test('Set: delete preserves probe chain for survivors', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    for (let i = 0; i < 20; i++) s.add(i)
    for (let i = 0; i < 20; i += 2) s.delete(i)
    let ok = 1
    for (let i = 1; i < 20; i += 2) if (!s.has(i)) ok = 0
    for (let i = 0; i < 20; i += 2) if (s.has(i)) ok = 0
    return ok + s.size
  }`)
  is(f(), 11)  // odds survive, evens gone, size→10
})

test('Map: delete after grow preserves remaining entries', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    for (let i = 0; i < 20; i++) m.set(i, i)
    for (let i = 0; i < 10; i++) m.delete(i)
    let sum = 0
    for (let i = 10; i < 20; i++) sum += m.get(i)
    return sum + m.size
  }`)
  is(f(), 155)  // sum(10..19)=145, +size 10
})

test('Map: delete then re-add same key', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m.set(5, 50)
    m.delete(5)
    m.set(5, 99)
    return m.get(5) + m.size
  }`)
  is(f(), 100)  // 99 + size 1
})

test('Set: delete down to empty then re-add', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s.add(1); s.add(2)
    s.delete(1); s.delete(2)
    let emptied = s.size
    s.add(7)
    return emptied * 10 + (s.has(7) ? 1 : 0) + s.size
  }`)
  is(f(), 2)  // emptied=0, has(7)=1, size=1
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

test('array: push beyond capacity triggers grow', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    a.push(3)
    a.push(4)
    a.push(5)
    a.push(6)
    let b = [100]
    return a[4] + a[5] + b[0]
  }`)
  is(f(), 111)  // 5+6+100 — no heap corruption
})

test('array: grow links dynamic move helper after hash helpers', () => {
  const { f } = run(`export let f = () => {
    let obj = Object.fromEntries([["x", 3]])
    let values = []
    values.push({ a: 1 })
    values.push({ a: 2 })
    values.push({ a: 3 })
    values.push({ a: 4 })
    values.push({ a: 5 })
    return values.length + obj.x
  }`)
  is(f(), 8)
})

test('array: push many beyond initial cap', () => {
  const { f } = run(`export let f = () => {
    let a = []
    a.push(1)
    a.push(2)
    a.push(3)
    a.push(4)
    a.push(5)
    a.push(6)
    a.push(7)
    a.push(8)
    return a.length + a[7]
  }`)
  is(f(), 16)  // length=8, a[7]=8
})

test('array: out-of-range read returns undefined', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    return a[1]
  }`)
  ok(Number.isNaN(f()))
})

test('array: split missing item is undefined', () => {
  const { f } = run(`export let f = () => "unreachable".split(" ")[1]`)
  ok(Number.isNaN(f()))
})

test('array: truthy with ||', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    return (a || [2])[0]
  }`)
  is(f(), 1)
})

test('array: truthy with &&', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    return (a && [2])[0]
  }`)
  is(f(), 2)
})

test('array: pop on single element', () => {
  const { f } = run(`export let f = () => {
    let a = [42]
    let v = a.pop()
    return v + a.length
  }`)
  is(f(), 42)  // v=42, length=0
})

// ============================================
// Module-scope initialization (__start)
// ============================================

test('module-scope: let with expression', () => {
  is(run(`
    let q = 1 + 2
    export let f = () => q
  `).f(), 3)
})

test('module-scope: jzify hoisted bare var is global', () => {
  const wasm = compile(`
    var x
    x = 3
    export let f = () => x
  `, { jzify: true })
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm))
  is(inst.exports.f(), 3)
})

test('module-scope: array init', () => {
  is(run(`
    let a = [10, 20, 30]
    export let f = () => a[1]
  `).f(), 20)
})

test('module-scope: object init', () => {
  is(run(`
    let o = {x: 5, y: 10}
    export let f = () => o.x + o.y
  `).f(), 15)
})

test('module-scope: string init', () => {
  is(run(`
    let s = "hello"
    export let f = () => s.length
  `).f(), 5)
})

test('module-scope: const folded to immutable i32', () => {
  is(run(`
    const N = 100
    export let f = () => N * 2
  `).f(), 200)
})

test('module-scope: const expr folded', () => {
  is(run(`
    const N = 2 + 3
    export let f = () => N
  `).f(), 5)
})

test('module-scope: const float immutable', () => {
  const r = run(`
    const PI = 3.14159
    export let f = () => PI
  `).f()
  ok(Math.abs(r - 3.14159) < 0.0001)
})

test('module-scope: param shadows global', () => {
  is(run(`
    let x = 7
    export let f = (x) => x
  `).f(3), 3)
})

test('module-scope: local shadows global', () => {
  const { f, g } = run(`
    let x = 7
    export let f = () => { let x = 3; return x }
    export let g = () => x
  `)
  is(f(), 3)
  is(g(), 7)  // global x unchanged
})

test('Regression: negative literal index reads undefined, not heap (array + typed)', () => {
  // `a[-1]` once fell through the non-negative-literal fast path to a raw
  // `payload + (-1)*8` load that read heap *before* the allocation (a silent
  // info leak). A literal negative index is out of range → undefined (JS).
  // valTypeOf returns null for it too, so `=== undefined` isn't folded to false.
  const { arr, ta, deep, inb } = run(`
    export let arr = () => { let a = [10, 20, 30]; return a[-1] === undefined ? 7 : 9 }
    export let ta = () => { let a = new Float64Array(4); a[0] = 1.5; return a[-1] === undefined ? 7 : 9 }
    export let deep = () => { let a = [10, 20, 30]; return a[-3] === undefined ? 7 : 9 }
    export let inb = () => { let a = [10, 20, 30]; return a[1] }
  `)
  is(arr(), 7)
  is(ta(), 7)
  is(deep(), 7)
  is(inb(), 20)  // in-bounds read unchanged
})
