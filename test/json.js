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

test('JSON.parse: runtime number argument parses after ToString coercion', () => {
  is(run(`export let f = value => JSON.parse(value)`).f(42), 42)
})

test('JSON.parse: runtime boolean argument parses after ToString coercion', () => {
  is(run(`export let f = value => JSON.stringify(JSON.parse(value < 2))`).f(1), 'true')
})

test('JSON.parse: undefined argument throws SyntaxError (ToString → "undefined")', () => {
  // Spec: ToString(undefined) is 'undefined', which is not valid JSON. The
  // literal fold mapped undefined → 'null' via loose ==, silently parsing.
  is(run(`export let f = () => { try { JSON.parse(undefined); return 'no-throw' } catch (e) { return 'threw' } }`).f(), 'threw')
  ok(run(`export let g = () => JSON.parse(null)`).g() === null, 'null still parses (ToString(null) = "null")')
})

test('JSON.parse: negative float', () => {
  is(run(`export let f = () => JSON.parse("-3.14")`).f(), -3.14)
})

test('JSON.parse: true', () => {
  // Must return boolean true, not numeric 1 — matches JS behaviour.
  is(run(`export let f = () => JSON.parse("true")`).f(), true)
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

test('JSON.parse: \\uXXXX escapes decode to UTF-8', () => {
  // ASCII code point → 1 byte.
  is(run(`export let f = () => JSON.parse('["a\\\\u0041b"]')[0]`).f(), 'aAb')
  // 2-byte code point (é = U+00E9) → 2 UTF-8 bytes; .length is byte length.
  is(run(`export let f = () => JSON.parse('["x\\\\u00e9y"]')[0]`).f(), 'xéy')
  // Surrogate pair (U+1F600) combines into one 4-byte code point.
  is(run(`export let f = () => JSON.parse('["\\\\uD83D\\\\uDE00!"]')[0]`).f(), '😀!')
  // \u escape on an object key.
  is(run(`export let f = () => JSON.parse('{"a\\\\u0041":7}').aA`).f(), 7)
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
  const wat = compile(`const SRC = '{"x":42}'; export let f = () => { const o = JSON.parse(SRC); return o.x }`, { wat: true, optimize: { watr: true } })
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
  const wat = compile(src, { wat: true, optimize: { watr: true } })
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
  // The shaped parser yields a known-SCHEMA object, so field reads compile to
  // direct slot loads; the generic runtime parser yields a hash read through
  // __dyn_get. The absence of __dyn_get is what proves the shape fast path fired —
  // and unlike the old `$__jp_shape_` symbol check, it survives the single-use
  // shape parser being inlined into $f (a size-neutral move some optimization
  // passes make, on the kernel leg and otherwise). Decouples the assertion from
  // byte-size heuristics so size optimizations can't silently flip it.
  ok(!/\$__dyn_get/.test(fMatch[0]), 'shaped: fields are slot reads, not __dyn_get')
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
  // Shaped → schema'd object → slot-read field access (no __dyn_get); robust to
  // the shared shape parser being inlined. See the stable-let test above.
  ok(!/\$__dyn_get/.test(fMatch[0]), 'shaped: fields are slot reads, not __dyn_get')
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

test('JSON.parse: repeated escaped runtime object keys reuse schema entries by decoded text', () => {
  const { f } = run(`export let f = source => {
    let input = JSON.parse(source)
    let first = input.items[0]
    let last = input.items[299]
    return Object.keys(first).length + input.items.length + (last.browser_ip === "1.2.3.299" ? 1000 : 0)
  }`)
  const items = Array.from(
    { length: 300 },
    (_, index) => `{"brow\\u0073er_ip":"1.2.3.${index}","long_key_valu\\u0065":"sample"}`
  ).join(",")

  is(f(`{"items":[${items}]}`), 1302)
})

test('JSON.parse: false fields remain falsy when filtering large parsed arrays', () => {
  const { f } = run(`export let f = source => {
    const input = JSON.parse(source)
    return input.cart.lines.filter(line => line.selected).length
  }`)
  const source = JSON.stringify({
    cart: {
      lines: Array.from({ length: 65 }, (_, index) => ({
        id: index,
        selected: index === 64,
      })),
    },
  })

  is(f(source), 1)
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

test('JSON.stringify: parsed input does not make grown pushed object array look circular', () => {
  const { f } = run(`export let f = source => {
    const lines = JSON.parse(source)
    const operations = []
    for (let i = 0; i < lines.length; i = i + 1) {
      operations.push({
        merchandiseId: "gid://shopify/ProductVariant/" + i,
        quantity: 1,
      })
    }
    return JSON.stringify({ operations })
  }`)
  const source = JSON.stringify(Array.from({ length: 1000 }, () => ({ selected: true })))
  const result = JSON.parse(f(source))

  is(result.operations.length, 1000)
  is(result.operations[999].quantity, 1)
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

test('JSON.stringify: assigned object boolean property serializes as boolean', () => {
  const { f } = run(`export let f = () => {
    let body = {}
    body.enabled = true
    body.selected = false
    return JSON.stringify(body)
  }`)

  is(f(), '{"enabled":true,"selected":false}')
})

test('JSON.stringify: assigned empty-object properties preserve nested body string', () => {
  const { f } = run(`export let f = () => {
    let input = { browser_ip: "1.2.3.4", cart_hash: "abc", extra_data: "x", is_bopis: true, mode: "test" }
    let body = {}
    if (input?.browser_ip) body.browser_ip = input.browser_ip
    if (input?.cart_hash) body.cart_hash = input.cart_hash
    body.extra_data = input.extra_data
    body.is_bopis = input.is_bopis ? true : false
    if (input.mode) body.mode = input.mode
    return JSON.stringify({ request: { body: JSON.stringify(body) } })
  }`)

  is(f(), '{"request":{"body":"{\\"browser_ip\\":\\"1.2.3.4\\",\\"cart_hash\\":\\"abc\\",\\"extra_data\\":\\"x\\",\\"is_bopis\\":true,\\"mode\\":\\"test\\"}"}}')
})

test('JSON runtime schemas: late closure parse does not overwrite compile-time stringify schemas', () => {
  const { f } = run(`
    let Host = {
      readInput(source) {
        return JSON.parse(source)
      },
      writeOutput(output) {
        return JSON.stringify(output)
      },
    }

    export let f = (source) => {
      Host.readInput(source)
      return Host.writeOutput({
        results: [
          { entry: { code: "alpha" } },
        ],
      })
    }
  `)

  is(
    f('{"source":{"items":[{"first":false,"kind":"sample","owner":"team"}],"meta":{"enabled":true,"count":2}},"options":[{"label":"primary","value":"alpha"}]}'),
    '{"results":[{"entry":{"code":"alpha"}}]}'
  )
})

test('JSON.parse: loose equality coerces numeric strings against numbers', () => {
  const { f } = run(`export let f = () => {
    const data = JSON.parse('{"value":"12.5","empty":null}')
    return [
      12.5 == data.value,
      13 != data.value,
      0 == data.empty,
    ]
  }`)

  const result = f()
  is(result[0], 1)
  is(result[1], 1)
  is(result[2], 0)
})

// === Boolean identity (regression: parser emitted numeric 1/0 instead of atoms) ===

test('JSON.parse: false is real boolean', () => {
  // typeof must be 'boolean', not 'number'. Before fix: returned 0.
  is(run(`export let f = () => JSON.parse("false")`).f(), false)
})

test('JSON.parse: typeof true is "boolean"', () => {
  is(run(`export let f = () => typeof JSON.parse("true")`).f(), 'boolean')
})

test('JSON.parse: typeof false is "boolean"', () => {
  is(run(`export let f = () => typeof JSON.parse("false")`).f(), 'boolean')
})

test('JSON.parse: [true,false] roundtrip via stringify', () => {
  // Before fix stringify produced '[null,null]' for boolean atoms it didn't recognise.
  is(run(`export let f = () => JSON.stringify(JSON.parse("[true,false]"))`).f(), '[true,false]')
})

test('JSON.parse: boolean in object roundtrips', () => {
  is(run(`export let f = () => JSON.stringify(JSON.parse('{"ok":true,"skip":false}'))`).f(), '{"ok":true,"skip":false}')
})

test('JSON.parse: boolean value is falsy/truthy', () => {
  // Boolean atoms are correctly falsy (false) and truthy (true) in conditionals.
  is(run(`export let f = () => JSON.parse("true") ? 1 : 0`).f(), 1)
  is(run(`export let f = () => JSON.parse("false") ? 1 : 0`).f(), 0)
})

test('JSON.stringify: true still serialises as "true"', () => {
  is(run(`export let f = () => JSON.stringify(true)`).f(), 'true')
})

test('JSON.stringify: false still serialises as "false"', () => {
  is(run(`export let f = () => JSON.stringify(false)`).f(), 'false')
})

// JSON.parse reviver (2026-07-10): was silently DROPPED — now lowers to an
// inline bottom-up walk (ES InternalizeJSONProperty). One documented edge:
// a reviver returning undefined assigns undefined instead of deleting.
// JSON.stringify with a non-foldable replacer now REJECTS (was silently ignored).
test('json: parse reviver applies bottom-up', () => {
  is(run(`export let f = () => { let o = JSON.parse('{"a":1,"b":2}', (k, v) => typeof v === "number" ? v * 2 : v); return o.a * 10 + o.b }`).f(), 24)
  is(run(`export let f = () => { let a = JSON.parse('[1,2,3]', (k, v) => typeof v === "number" ? v + 1 : v); return a[0] * 100 + a[1] * 10 + a[2] }`).f(), 234)
  is(run(`export let f = () => { let o = JSON.parse('{"x":{"y":5}}', (k, v) => typeof v === "number" ? v * 2 : v); return o.x.y }`).f(), 10)
  is(run(`export let f = () => JSON.parse('7', (k, v) => v + 1)`).f(), 8)
})
test('json: nullish reviver is spec-ignored; runtime replacer rejects', () => {
  is(run(`export let f = () => JSON.parse('{"a":5}', null).a`).f(), 5)
  is(run(`export let f = () => JSON.parse('7', undefined)`).f(), 7)
  let rejected = 0
  try { run(`let o = { a: 1 }; export let f = () => JSON.stringify(o, (k, v) => v).length`) } catch (e) { rejected = /replacer/.test(String(e)) ? 1 : 0 }
  is(rejected, 1)
})

// JSON.stringify(date) → ISO via toJSON semantics (host-exact): the branded
// date schema lets __json_obj recognize the receiver; invalid date → null.
test('JSON.stringify: Date serializes as ISO string', () => {
  const j = (code) => run(code).f()
  is(j(`export let f = () => JSON.stringify(new Date(86400000))`), '"1970-01-02T00:00:00.000Z"')
  is(j(`export let f = () => JSON.stringify({t: new Date(0), n: 1})`), '{"t":"1970-01-01T00:00:00.000Z","n":1}')
  is(j(`export let f = () => JSON.stringify([new Date(5)])`), '["1970-01-01T00:00:00.005Z"]')
  is(j(`export let f = () => JSON.stringify(new Date(NaN))`), 'null')
})
