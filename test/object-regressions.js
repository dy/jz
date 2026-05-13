import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { i64ToF64 } from '../src/host.js'
import { run } from './util.js'

test('Regression: Object.assign overwrites existing field from subset schema', () => {
  const { f } = run(`export let f = () => {
    let target = {x: 1, y: 2}
    let patch = {x: 10}
    let out = Object.assign(target, patch)
    return [out.x, target.x, target.y]
  }`)
  const out = f()
  is(out[0], 10)
  is(out[1], 10)
  is(out[2], 2)
})

test('Regression: Object.assign extends target with new fields', () => {
  const { f } = run(`export let f = () => {
    let target = {x: 1}
    let left = {y: 2}
    let right = {z: 3}
    Object.assign(target, left, right)
    return target.x + target.y + target.z
  }`)
  is(f(), 6)
})

test('Regression: property read does not call method emitter with same name', () => {
  const { f } = run(`export let f = () => {
    let item = {}
    return item.add ?? 7
  }`)
  is(f(), 7)
})

test('Regression: mem.write partial object update preserves omitted fields', async () => {
  const r = await WebAssembly.instantiate(compile(`
    export let make = () => ({x: 1, y: 2, z: 3})
  `))
  const m = jz.memory(r)
  const ptr = i64ToF64(r.instance.exports.make())
  m.write(ptr, { y: 99 })
  const out = m.read(ptr)
  is(out.x, 1)
  is(out.y, 99)
  is(out.z, 3)
})

test('Regression: compile survives focused object mutation cases', () => {
  const wasm = compile(`
    export let f = () => {
      let target = {x: 1}
      Object.assign(target, {y: 2})
      return target.x + target.y
    }
  `)
  ok(wasm instanceof Uint8Array, 'object mutation regression compiles')
})

// Pre-existing bug surfaced while writing slot-type tests:
// `let o = w == 0 ? mkA() : mkB()` where both arms returned narrowed-i32 OBJECT
// pointers used to emit `(f64.convert_i32_s (if (result i32) ...))` — numeric
// convert of the offset rather than NaN-rebox. Subsequent `o.prop` then read
// from invalid memory. Fix: `?:` emit propagates matching ptrKind/ptrAux from
// both arms so downstream `asF64` takes the rebox path.
test('Regression: ?: with two narrowed-OBJECT helpers preserves pointer identity', () => {
  const { f } = run(`
    let mkA = () => ({ x: 11 })
    let mkB = () => ({ x: 22 })
    export let f = (w) => {
      let o = w == 0 ? mkA() : mkB()
      return o.x
    }
  `)
  is(f(0), 11)
  is(f(1), 22)
})

test('Regression: ?: with multi-prop OBJECT branches', () => {
  const { f } = run(`
    let a = () => ({ x: 1, y: 2 })
    let b = () => ({ x: 3, y: 4 })
    export let f = (w) => {
      let o = w == 0 ? a() : b()
      return o.x + o.y
    }
  `)
  is(f(0), 3)
  is(f(1), 7)
})

test('Regression: ?: result fed directly to .prop access', () => {
  const { f } = run(`
    let a = () => ({ x: 7 })
    let b = () => ({ x: 9 })
    export let f = (w) => (w == 0 ? a() : b()).x
  `)
  is(f(0), 7)
  is(f(1), 9)
})

test('Regression: ?: with literal object branches — distinct schemas', () => {
  // Two literal branches with different schemas. Both arms are inline `{}`
  // (no narrowed-call return), so this stresses the ptrKind propagation
  // through the object-literal emit shape rather than the call-result shape.
  const { f } = run(`
    export let f = (w) => {
      let o = w == 0 ? { x: 11, y: 1 } : { x: 22, z: 2 }
      return o.x
    }
  `)
  is(f(0), 11)
  is(f(1), 22)
})

test('Regression: ?: with both arms plain i32 numeric stays numeric', () => {
  // Negative case: neither arm has ptrKind, so the result must remain a plain
  // i32-or-f64 numeric (no NaN-rebox). Pins the "no false propagation" axis.
  const { f } = run(`
    export let f = (w) => {
      let v = w == 0 ? 11 : 22
      return v + 1
    }
  `)
  is(f(0), 12)
  is(f(1), 23)
})

test('Regression: ?: polymorphic — same-shape distinct OBJECT schemas dedup', () => {
  // Two distinct-but-structurally-identical schemas {x,y} dedup to the same
  // schemaId, so the receiver carries a consistent aux and `.prop` resolves
  // statically. Pinned so any future schema-id assignment change still
  // preserves this case.
  const { hx, hy } = run(`
    let p = () => ({ x: 11, y: 100 })
    let q = () => ({ x: 22, y: 200 })
    export let hx = (w) => { let o = w == 0 ? p() : q(); return o.x }
    export let hy = (w) => { let o = w == 0 ? p() : q(); return o.y }
  `)
  is(hx(0), 11)
  is(hx(1), 22)
  is(hy(0), 100)
  is(hy(1), 200)
})

// Polymorphic `?:` with two narrowed-OBJECT arms of structurally distinct
// schemas — `.prop` falls through `__dyn_get_any` → `__dyn_get`'s OBJECT-
// schema fallback (added in commit) which reads receiver aux as schemaId,
// looks up the schema name table, and resolves the slot at runtime.
// Each `?:` arm reboxes via the f64 path with its own ptrAux so the
// receiver carries the correct schemaId at runtime.
test('Regression: ?: polymorphic — different-shape OBJECT schemas resolve .prop', () => {
  const { hy } = run(`
    let n = () => ({ x: 11, y: 100 })
    let s = () => ({ y: 200, x: 22 })
    export let hy = (w) => { let o = w == 0 ? n() : s(); return o.y }
  `)
  is(hy(0), 100)
  is(hy(1), 200)
})

test('Regression: ?: polymorphic — different-shape OBJECT schemas resolve shared .prop', () => {
  // Field that exists in both schemas at different slot offsets — must
  // resolve to its per-arm slot value via runtime aux→sid dispatch.
  const { hx } = run(`
    let n = () => ({ x: 11, y: 100 })
    let s = () => ({ y: 200, x: 22 })
    export let hx = (w) => { let o = w == 0 ? n() : s(); return o.x }
  `)
  is(hx(0), 11)
  is(hx(1), 22)
})

test('Regression: ?: polymorphic — TYPED arrays with different element types', () => {
  // Same fix axis as polymorphic OBJECT — different ptrAux on TYPED arms
  // (Float64Array vs Int32Array elemType bits) must be preserved per arm
  // so element reads dispatch on the correct elemType at runtime.
  const { pick } = run(`
    let mkF = () => new Float64Array([1.5, 2.5, 3.5])
    let mkI = () => new Int32Array([10, 20, 30])
    export let pick = (w, i) => {
      let a = w == 0 ? mkF() : mkI()
      return a[i]
    }
  `)
  is(pick(0, 0), 1.5)
  is(pick(0, 1), 2.5)
  is(pick(1, 0), 10)
  is(pick(1, 1), 20)
})

// Object literals are laid out by schemaId; JSON.stringify resolves keys
// through the schema table, not the heap. A nested literal whose keys are
// unrelated to the enclosing binding's schema must keep its own schemaId —
// otherwise its keys collapse to the binding's at serialization.
test('Regression: nested literals retain own schemaId, not enclosing binding\'s', () => {
  const { f } = run(`export let f = () => {
    let x = "hi"
    let out = {ops: [{inner: {id: x}}]}
    return JSON.stringify(out)
  }`)
  is(f(), '{"ops":[{"inner":{"id":"hi"}}]}')
})

test('Regression: nested prefix literal does not inherit enclosing merged schemaId', () => {
  const { f } = run(`export let f = () => {
    let out = {a: {a: 1}}
    Object.assign(out, {b: 2})
    return JSON.stringify(out)
  }`)
  is(f(), '{"a":{"a":1},"b":2}')
})

// The slot fast-path for `o.prop` reads at a fixed offset with no runtime
// type check; it is only sound when the receiver is statically known to be
// OBJECT. A receiver whose type is unknown (e.g. a `?:` over JSON.parse
// erases its HASH type) must fall through to dynamic dispatch — slot 0 of
// a HASH is bucket metadata, not a property value.
test('Regression: unknown-typed receiver does not take OBJECT slot fast-path', () => {
  const { f } = run(`export let f = (w) => {
    let h = w == 0 ? JSON.parse('{"id":"hi"}') : JSON.parse('{"id":"bye"}')
    let out = { id: h.id }
    return out.id
  }`)
  is(f(0), 'hi')
  is(f(1), 'bye')
})

test('Regression: dynamic key write updates existing fixed-shape object slot', () => {
  const { dot, dyn, noFold } = run(`
    export let dot = (k) => {
      let o = { x: 1 }
      o[k] = 2
      return o.x
    }
    export let dyn = (k) => {
      let o = { x: 1 }
      o.x = 2
      o[k] = 3
      return o[k]
    }
    export let noFold = () => {
      let o = { k: 7, x: 9 }
      let k = "x"
      o[k] = 11
      return o.x + o.k
    }
  `)
  is(dot('x'), 2)
  is(dyn('x'), 3)
  is(noFold(), 18)
})

test('Regression: literal numeric string array assignment updates element storage', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    a["0"] = 2
    return a[0]
  }`)
  is(f(), 2)
})

// Object.keys on JSON.parse'd objects — folds to a fixed-shape OBJECT with
// known schema, so Object.keys returns the schema names. Mutation through
// __dyn_set stores into the per-OBJECT propsPtr sidecar; like object literals,
// runtime-added keys are not enumerated by Object.keys. Iteration order
// follows JSON insertion order (the schema preserves it).
test('Object.keys: returns schema names for JSON.parse OBJECT', () => {
  const { f } = run(`export let f = () => Object.keys(JSON.parse('{"a":1,"b":2,"c":3}')).length`)
  is(f(), 3)
})

test('Object.keys: empty JSON.parse returns empty array', () => {
  const { f } = run(`export let f = () => Object.keys(JSON.parse('{}')).length`)
  is(f(), 0)
})

test('Object.keys: JSON.parse OBJECT key set matches input', () => {
  const { f } = run(`export let f = () => {
    let o = JSON.parse('{"a":1,"b":2,"c":3}')
    let k = Object.keys(o)
    return (k.indexOf("a") >= 0) + (k.indexOf("b") >= 0) + (k.indexOf("c") >= 0)
  }`)
  is(f(), 3)
})

test('Object.keys: JSON.parse OBJECT does not return absent keys', () => {
  const { f } = run(`export let f = () => Object.keys(JSON.parse('{"a":1}')).indexOf("zzz")`)
  is(f(), -1)
})

// Mutation via __dyn_set writes into the OBJECT's propsPtr sidecar; the
// fixed schema view from Object.keys does not grow — same rule as for
// object literals (`let o = {a:1}; o.b = 2; Object.keys(o).length === 1`).
test('Object.keys: JSON.parse OBJECT mutation does not grow schema view', () => {
  const { f } = run(`export let f = () => {
    let o = JSON.parse('{"a":1}')
    o.b = 2
    o.c = 3
    return Object.keys(o).length
  }`)
  is(f(), 1)
})

test('Object.keys: nested JSON.parse OBJECT', () => {
  const { f } = run(`export let f = () => Object.keys(JSON.parse('{"x":{"a":1,"b":2,"c":3,"d":4}}').x).length`)
  is(f(), 4)
})

test('Object.keys: existing OBJECT-literal path still works', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 1, y: 2, z: 3}
    return Object.keys(o).length
  }`)
  is(f(), 3)
})
// Trailing commas in object literals: subscript represents `{a:1, b,}` as
// `[",", [":","a",1], "b", null]` — a phantom `null` entry past the last
// real prop. Without filtering in prep, the literal carried an extra
// "literal 0" slot and any downstream destructure or read-by-position
// resolved against the wrong layout.
test('Regression: object literal trailing comma after shorthand', () => {
  is(run(`export let f = () => {
    let a = 10, b = 20
    let o = { a, b, }
    return o.a + o.b
  }`).f(), 30)
})

test('Regression: object literal trailing comma feeding cross-fn destruct', () => {
  is(run(`
    let g = ({ method, input }) => method && input ? 1 : 0
    export let f = () => {
      let m = { name: "x" }
      let input = { y: 1 }
      return g({
        method: m,
        input,
      })
    }
  `).f(), 1)
})

// `.prop` on an anonymous object literal must read its declared slot. Without
// schema resolution from the literal's AST, the access fell through to
// __dyn_get_expr, which probes the off-16 propsPtr — fresh OBJECT literals
// have none, so the read returned NULL_NAN. The varName-bound form
// (`let o = {b:1}; o.b`) already worked because ctx.schema.idOf carries the
// schema; this extends the same shape resolution to anonymous receivers.
test('Regression: .prop on anonymous object literal resolves slot', () => {
  is(run(`export let f = () => ({b: 1}).b`).f(), 1)
})

test('Regression: .prop on multi-prop anonymous literal', () => {
  is(run(`export let f = () => ({a: 10, b: 20, c: 30}).b`).f(), 20)
  is(run(`export let f = () => ({a: 10, b: 20, c: 30}).c`).f(), 30)
})

// Chained `.prop.prop` over nested literals — outer `.a` returns the inner
// OBJECT pointer, and the outer `.b` slot read needs the inner literal's
// schema. The literal walk recurses through `.prop` chains over known
// literals to find the receiver schema at the deepest reachable node.
test('Regression: chained .prop on nested anonymous literals', () => {
  is(run(`export let f = () => ({a: {b: 7}}).a.b`).f(), 7)
})

test('Regression: deeply nested anonymous literals', () => {
  is(run(`export let f = () => ({x: {y: {z: 42}}}).x.y.z`).f(), 42)
})

// __dyn_get_t's OBJECT-schema arm is gated on `ctx.schema.list.length > 0`.
// Setting the stdlib template at module-init time froze the gate to false
// because schemas register lazily as the source is processed — the arm
// dropped out for any schema added later in the compile, leaving runtime
// `.prop` reads on OBJECT receivers without a static schemaId returning
// NULL_NAN. Lifting the gate to template-expansion time captures the final
// schema count.
test('Regression: cross-call OBJECT literal — `.prop` resolves via runtime schemaId', () => {
  const { f } = run(`
    let go = (o) => o.b
    export let f = () => go({a: 1, b: 2})
  `)
  is(f(), 2)
})

test('Regression: cross-call nested OBJECT literal — chained .prop resolves at runtime', () => {
  const { f } = run(`
    let go = (o) => o.a.b
    export let f = () => go({a: {b: 7}})
  `)
  is(f(), 7)
})

test('Regression: destructured-param OBJECT literal — inner .prop resolves', () => {
  const { f } = run(`
    let go = ({a}) => a.b
    export let f = () => go({a: {b: 11}})
  `)
  is(f(), 11)
})

test('Regression: through-fn nested with multiple props', () => {
  // Models the function-core pattern: `({methods, input}) => input.cart.x`.
  // Both `input` (param) and `input.cart` (slot value) are OBJECT pointers
  // with schemaId in NaN-box aux — runtime dispatch reads schema_tbl, finds
  // the prop's slot, returns the value.
  const { f } = run(`
    let go = ({a, b}) => a.x + b.y.z
    export let f = () => go({a: {x: 10}, b: {y: {z: 20}}})
  `)
  is(f(), 30)
})

// Object.keys on a receiver whose static type is unknown (param sourced from
// JSON.parse(runtimeStr), destructured from an untyped chain, returned by a
// polymorphic helper, etc.). The runtime dispatch checks ptr-type at the call
// site: HASH walks the probe table, anything else returns [].
test('Object.keys: runtime dispatch — untyped param holding HASH', () => {
  const { f } = run(`
    let inner = (h) => Object.keys(h).length
    export let f = (s) => inner(JSON.parse(s))
  `)
  is(f('{"a":1,"b":2,"c":3,"d":4}'), 4)
})

test('Object.keys: runtime dispatch — picks first key from HASH', () => {
  const { f } = run(`
    let pickFirst = (h) => Object.keys(h)[0]
    export let f = (s) => pickFirst(JSON.parse(s))
  `)
  const r = f('{"only":"value"}')
  is(r, 'only')
})

test('Object.keys: runtime dispatch — empty HASH', () => {
  const { f } = run(`
    let inner = (h) => Object.keys(h).length
    export let f = (s) => inner(JSON.parse(s))
  `)
  is(f('{}'), 0)
})

test('Object.keys: runtime dispatch — destructured-from-untyped chain', () => {
  // Param flows through destructuring on a chain whose root is
  // JSON.parse(runtimeStr), so `m` arrives shapeless even though it holds a
  // HASH at runtime.
  const { f } = run(`
    let countKeys = ({m}) => Object.keys(m.values).length
    export let f = (s) => countKeys(JSON.parse(s))
  `)
  is(f('{"m":{"values":{"a":1,"b":2,"c":3}}}'), 3)
})

test('Object.keys: runtime dispatch — non-HASH receiver returns empty', () => {
  // The empty-array fallback covers everything that isn't HASH at runtime
  // (number, nullish, primitives) without crashing.
  const { f } = run(`
    let inner = (h) => Object.keys(h).length
    export let f = (n) => inner(n + 0)
  `)
  is(f(42), 0)
})

test('Object.values: runtime dispatch — untyped param holding HASH', () => {
  const { f } = run(`
    let values = (h) => Object.values(h)
    export let f = (s) => {
      let v = values(JSON.parse(s))
      return v.indexOf("a") >= 0 && v.indexOf("b") >= 0 ? v.length : 0
    }
  `)
  is(f('{"first":"a","second":"b"}'), 2)
})

test('Object.values: runtime dispatch — untyped param holding OBJECT', () => {
  const { f } = run(`
    let sumValues = (o) => {
      let v = Object.values(o)
      return v[0] + v[1] + v[2]
    }
    export let f = () => sumValues({a: 1, b: 2, c: 3})
  `)
  is(f(), 6)
})

test('Object.values: runtime dispatch — empty HASH', () => {
  const { f } = run(`
    let inner = (h) => Object.values(h).length
    export let f = (s) => inner(JSON.parse(s))
  `)
  is(f('{}'), 0)
})

test('Object.values: runtime dispatch — non-object receiver returns empty', () => {
  const { f } = run(`
    let inner = (h) => Object.values(h).length
    export let f = (n) => inner(n + 0)
  `)
  is(f(42), 0)
})

test('Object.entries: runtime dispatch — untyped param holding HASH', () => {
  const { f } = run(`
    let entries = (h) => Object.entries(h)
    export let f = (s) => {
      let e = entries(JSON.parse(s))
      return e.length == 1 && e[0][0] == "only" && e[0][1] == 7 ? 1 : 0
    }
  `)
  is(f('{"only":7}'), 1)
})

test('Object.entries: runtime dispatch — untyped param holding OBJECT', () => {
  const { f } = run(`
    let sumEntries = (o) => {
      let e = Object.entries(o)
      return e.length == 2 && e[0][0] == "a" && e[0][1] == 1 && e[1][0] == "b" && e[1][1] == 2 ? 1 : 0
    }
    export let f = () => sumEntries({a: 1, b: 2})
  `)
  is(f(), 1)
})

test('Object.entries: runtime dispatch — non-object receiver returns empty', () => {
  const { f } = run(`
    let inner = (h) => Object.entries(h).length
    export let f = (n) => inner(n + 0)
  `)
  is(f(42), 0)
})

// hasOwnProperty: literal and known-schema fold + runtime dispatch.
// Without an own emit handler the call falls through to __ext_call and the
// resulting wasm requires JS host imports, defeating the host:'wasi' target.

test('hasOwnProperty: present key on fixed-shape OBJECT folds to true', () => {
  const { f } = run(`export let f = () => {
    const x = {a: 1, b: 2}
    return x.hasOwnProperty('a') ? 1 : 0
  }`)
  is(f(), 1)
})

test('hasOwnProperty: absent key on fixed-shape OBJECT folds to false', () => {
  const { f } = run(`export let f = () => {
    const x = {a: 1, b: 2}
    return x.hasOwnProperty('z') ? 1 : 0
  }`)
  is(f(), 0)
})

test('hasOwnProperty: empty object — no inherited toString', () => {
  const { f } = run(`export let f = () => ({}).hasOwnProperty('toString') ? 1 : 0`)
  is(f(), 0)
})

test('hasOwnProperty: presence not value — undefined-valued slot is true', () => {
  const { f } = run(`export let f = () => ({a: undefined}).hasOwnProperty('a') ? 1 : 0`)
  is(f(), 1)
})

test('hasOwnProperty: HASH receiver via JSON.parse', () => {
  const { f } = run(`export let f = (s, k) => JSON.parse(s).hasOwnProperty(k) ? 1 : 0`)
  is(f('{"a":1,"b":2}', 'a'), 1)
  is(f('{"a":1,"b":2}', 'z'), 0)
})

test('hasOwnProperty: Array numeric index', () => {
  const { f } = run(`export let f = () => {
    const a = [10, 20, 30]
    return a.hasOwnProperty(0) ? 1 : 0
  }`)
  is(f(), 1)
})

test('hasOwnProperty: Array out-of-range index', () => {
  const { f } = run(`export let f = () => {
    const a = [10, 20, 30]
    return a.hasOwnProperty(99) ? 1 : 0
  }`)
  is(f(), 0)
})

test('hasOwnProperty: closure receiver — no own caller property', () => {
  // test262 S13.2_A7_T1 shape: invoking on a function should produce false
  // (jz functions carry no own enumerable properties).
  const { f } = run(`export let f = () => (() => 1).hasOwnProperty('caller') ? 1 : 0`)
  is(f(), 0)
})

test('hasOwnProperty: dynamic key on known-schema OBJECT', () => {
  const { f } = run(`
    export let f = (k) => {
      const x = {a: 1, b: 2}
      return x.hasOwnProperty(k) ? 1 : 0
    }
  `)
  is(f('a'), 1)
  is(f('z'), 0)
})

test('jzify: Object.hasOwnProperty.call canonicalizes to instance hasOwnProperty', () => {
  const { f } = jz(`
    export let f = (k) => {
      const x = {a: 1, b: 2}
      return Object.hasOwnProperty.call(x, k) ? 1 : 0
    }
  `, { jzify: true }).exports
  is(f('a'), 1)
  is(f('z'), 0)
})

test('jzify: empty Object constructor guard canonicalizes to Object.keys check', () => {
  const { f } = jz(`
    export let f = (s) => {
      const configuration = JSON.parse(s)
      return configuration.constructor === Object && Object.keys(configuration).length === 0 ? 1 : 0
    }
  `, { jzify: true }).exports
  is(f('{}'), 1)
  is(f('{"a":1}'), 0)
})

// Regression: compound assignments on array targets crashed with
// "Unknown local $[],b,,0" because readVar() received an array node.
// Fix: desugar to name = name OP val when LHS is not a plain string.
test('Regression: compound assignments on typed-array index targets', () => {
  const { f } = run(`
    export let f = () => {
      const a = new Float64Array(4)
      a[0] = 1.0
      a[1] = 2.0
      a[0] += 10.0
      a[1] -= 1.0
      a[0] *= 2.0
      return a[0] + a[1]
    }
  `)
  is(f(), 23)
})

test('Regression: bitwise compound assignments on typed-array index targets', () => {
  const { f } = run(`
    export let f = () => {
      const a = new Int32Array(4)
      a[0] = 5
      a[0] &= 3
      a[0] |= 8
      return a[0]
    }
  `)
  is(f(), 9)
})
