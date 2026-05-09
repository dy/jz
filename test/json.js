// JSON.stringify and JSON.parse tests
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { run } from './util.js'

// === JSON.stringify ===

test('JSON.stringify: number', () => {
  is(run(`export let f = () => JSON.stringify(42).length`).f(), 2)
})

test('JSON.stringify: string', () => {
  is(run(`export let f = () => JSON.stringify("hi").length`).f(), 4)
})

test('JSON.stringify: array', () => {
  is(run(`export let f = () => JSON.stringify([1,2,3]).length`).f(), 7)
})

test('JSON.stringify: NaN → null', () => {
  is(run(`export let f = () => JSON.stringify(0/0).length`).f(), 4)
})

test('JSON.stringify: Infinity → null', () => {
  is(run(`export let f = () => JSON.stringify(1/0).length`).f(), 4)
})

test('JSON.stringify: nested', () => {
  is(run(`export let f = () => JSON.stringify([[1],[2]]).length`).f(), 9)
})

test('JSON.stringify: empty array', () => {
  is(run(`export let f = () => JSON.stringify([]).length`).f(), 2)
})

// === JSON.parse ===

test('JSON.parse: number', () => {
  is(run(`export let f = () => JSON.parse("42")`).f(), 42)
})

test('JSON.parse: negative float', () => {
  is(run(`export let f = () => JSON.parse("-3.14")`).f(), -3.14)
})

test('JSON.parse: true', () => {
  is(run(`export let f = () => JSON.parse("true")`).f(), 1)
})

test('JSON.parse: null', () => {
  ok(run(`export let f = () => JSON.parse("null")`).f() === null)
})

test('JSON.parse: array length', () => {
  is(run(`export let f = () => JSON.parse("[1,2,3]").length`).f(), 3)
})

test('JSON.parse: array element', () => {
  is(run(`export let f = () => JSON.parse("[10,20,30]")[1]`).f(), 20)
})

test('JSON.parse: string length', () => {
  is(run('export let f = () => JSON.parse(\'\"hello\"\').length').f(), 5)
})

test('JSON.parse: string with escape sequences decodes to correct length', () => {
  // Escapes in the non-simple path (>4 byte output) must count toward $len so
  // the alloc fits the decoded body. A raw escape (\") forwards to the same
  // literal byte; the decoded string is "abc\"def" → 8 bytes.
  is(run(`export let f = () => JSON.parse('"abc\\\\"def"').length`).f(), 7)
  // \n and \" mixed; decoded length is 5 ("a\nb\"c" → a, NL, b, ", c).
  is(run(`export let f = () => JSON.parse('"a\\\\nb\\\\"c"').length`).f(), 5)
})

test('JSON.parse: object value with escape', () => {
  // Reproduces the bug surface: object value strings with escapes were
  // silently corrupting the heap because the second-scan decode wrote past
  // the under-sized alloc.
  is(run(`export let f = () => JSON.parse('{"k":"a\\\\"b"}').k.length`).f(), 3)
})

test('JSON.parse: nested array', () => {
  is(run(`export let f = () => JSON.parse("[[1,2],[3]]")[0][1]`).f(), 2)
})

test('JSON.parse: roundtrip', () => {
  is(run(`export let f = () => JSON.stringify(JSON.parse("[1,2,3]")).length`).f(), 7)
})

// === JSON.parse objects (HASH type) ===

test('JSON.parse: object dot access', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"x":42}'); return o.x }`).f(), 42)
})

test('JSON.parse: static object dot access uses fixed-slot OBJECT load', () => {
  // const o = JSON.parse(SRC) folds to a fixed-shape OBJECT (schema-tagged,
  // slot-based). o.x reads `f64.load offset=0` from the object payload — no
  // hash dispatch, no runtime parser.
  const wat = compile(`const SRC = '{"x":42}'; export let f = () => { const o = JSON.parse(SRC); return o.x }`, { wat: true })
  ok(!wat.includes('$__jp'))
  ok(!wat.includes('$__hash_get'))
  ok(!wat.includes('$__hash_get_local'))
  ok(!wat.includes('$__dyn_get_any'))
  ok(!wat.includes('$__dyn_get_expr'))
  ok(wat.includes('f64.load'))
})

test('JSON.parse: static parse returns fresh HASH each call', () => {
  is(run(`const SRC = '{"x":42}'; export let f = () => {
    const a = JSON.parse(SRC)
    const b = JSON.parse(SRC)
    a.x = 7
    return b.x
  }`).f(), 42)
})

test('JSON.parse: nested chains stay on OBJECT fast path', () => {
  // o.meta.bias and items[j].id should resolve to fixed-slot f64.load reads —
  // shape propagation lifts intermediate `o.meta` and `items[j]` to known
  // OBJECT schemas so neither hash dispatch nor the dyn dispatcher is pulled in.
  const src = `
    const SRC = '{"items":[{"id":1}],"meta":{"bias":11}}'
    export let f = () => {
      const o = JSON.parse(SRC)
      const items = o.items
      const it = items[0]
      return o.meta.bias + it.id
    }
  `
  const wat = compile(src, { wat: true })
  ok(!wat.includes('$__jp'))
  ok(!wat.includes('$__hash_get'))
  ok(!wat.includes('$__hash_get_local'))
  ok(!wat.includes('$__dyn_get_any'))
  ok(!wat.includes('$__dyn_get_expr'))
  ok(wat.includes('f64.load'))
  is(run(src).f(), 12)
})

test('JSON.parse: stable let source uses shaped runtime parser', () => {
  const src = `
    let SRC = '{"items":[{"id":1,"kind":2,"value":10}],"meta":{"scale":7,"bias":11}}'
    export let f = () => {
      let o = JSON.parse(SRC)
      return o.meta.bias + o.items[0].id
    }
  `
  const wat = compile(src, { wat: true })
  const fMatch = wat.match(/\(func \$f[\s\S]*?^  \)$/m)
  ok(fMatch, 'expected $f function in WAT')
  ok(wat.includes('$__jp_shape_'))
  ok(!/call \$__jp\b/.test(fMatch[0]))
  is(run(src).f(), 12)
})

test('JSON.parse: runtime-selected literal sources share shaped parser', () => {
  const src = `
    const SOURCES = [
      '{"items":[{"id":1,"kind":2,"value":10}],"meta":{"scale":7,"bias":11}}',
      '{"items":[{"id":4,"kind":1,"value":8}],"meta":{"scale":5,"bias":17}}',
    ]
    export let f = (i) => {
      let o = JSON.parse(SOURCES[i & 1])
      return o.meta.bias + o.items[0].id
    }
  `
  const wat = compile(src, { wat: true })
  const fMatch = wat.match(/\(func \$f[\s\S]*?^  \)$/m)
  ok(fMatch, 'expected $f function in WAT')
  ok(wat.includes('$__jp_shape_'))
  ok(!/call \$__jp\b/.test(fMatch[0]))
  is(run(src).f(0), 12)
  is(run(src).f(1), 21)
})

test('JSON.parse: mixed-order literal sources stay generic', () => {
  const src = `
    const SOURCES = ['{"a":1,"b":2}', '{"b":20,"a":10}']
    export let f = (i) => JSON.parse(SOURCES[i & 1]).a
  `
  const wat = compile(src, { wat: true })
  ok(!wat.includes('$__jp_shape_'))
  is(run(src).f(0), 1)
  is(run(src).f(1), 10)
})

test('JSON.parse: object multiple keys', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"a":10,"b":20}'); return o.a + o.b }`).f(), 30)
})

test('JSON.parse: nested object', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"a":{"b":99}}'); return o.a.b }`).f(), 99)
})

test('JSON.parse: array of objects', () => {
  is(run(`export let f = () => { let a = JSON.parse('[{"x":1},{"x":2}]'); return a[0].x + a[1].x }`).f(), 3)
})

test('JSON.parse: many keys (grow)', () => {
  is(run(`export let f = () => {
    let o = JSON.parse('{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9}')
    return o.a + o.i
  }`).f(), 10)
})

test('JSON.parse: missing key returns nullish', () => {
  const v = run(`export let f = () => { let o = JSON.parse('{"x":1}'); return o.z }`).f()
  ok(v === null || v === undefined)
})

test('JSON.parse: string value access', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"name":"jz"}'); return o.name.length }`).f(), 2)
})

test('JSON.parse: write property', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"x":1}'); o.x = 99; return o.x }`).f(), 99)
})

test('JSON.parse: add new property', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"x":1}'); o.y = 2; return o.x + o.y }`).f(), 3)
})

// HASH bracket-read with non-literal key — local string var, function param,
// or any expression resolving to a runtime string. Routes through
// __hash_get_local; the hash code is computed at call time rather than
// baked in as it is for literal keys.
test('JSON.parse: HASH bracket with local string var', () => {
  is(run(`export let f = () => {
    let o = JSON.parse('{"a":1,"b":2,"c":3}')
    let k = "b"
    return o[k]
  }`).f(), 2)
})

test('JSON.parse: HASH bracket with param key', () => {
  const { f } = run(`export let f = (k) => {
    let o = JSON.parse('{"foo":42,"bar":99}')
    return o[k]
  }`)
  is(f('foo'), 42)
  is(f('bar'), 99)
})

test('JSON.parse: HASH bracket misses return undefined', () => {
  const v = run(`export let f = () => {
    let o = JSON.parse('{"a":1}')
    let k = "absent"
    return o[k]
  }`).f()
  ok(v === null || v === undefined)
})

// === JSON.stringify: objects ===

test('JSON.stringify: schema object', () => {
  const { f } = run(`export let f = () => {
    let o = { x: 1, y: 2 }
    return JSON.stringify(o)
  }`)
  is(f(), '{"x":1,"y":2}')
})

test('JSON.stringify: nested object', () => {
  const { f } = run(`export let f = () => {
    let inner = { a: 10 }
    let outer = { b: inner }
    return JSON.stringify(outer)
  }`)
  is(f(), '{"b":{"a":10}}')
})

test('JSON.stringify: object with string value', () => {
  const { f } = run(`export let f = () => {
    let o = { name: "jz" }
    return JSON.stringify(o)
  }`)
  is(f(), '{"name":"jz"}')
})

test('JSON.stringify: object in array', () => {
  const { f } = run(`export let f = () => {
    let a = [{ x: 1 }, { x: 2 }]
    return JSON.stringify(a)
  }`)
  is(f(), '[{"x":1},{"x":2}]')
})

test('JSON.stringify: HASH roundtrip', () => {
  const { f } = run(`export let f = () => {
    let o = JSON.parse('{"a":1,"b":2}')
    return JSON.stringify(o)
  }`)
  const result = f()
  // HASH iteration order may differ from insertion order
  const parsed = JSON.parse(result)
  is(parsed.a, 1)
  is(parsed.b, 2)
})

test('JSON.stringify: empty object', () => {
  const { f } = run(`export let f = () => {
    let o = JSON.parse('{}')
    return JSON.stringify(o)
  }`)
  is(f(), '{}')
})
