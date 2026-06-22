// Object shape & semantics: literals (schemas, trailing commas, nested,
// anonymous-receiver `.prop`), Object.* methods (assign/freeze/keys/values/
// entries/getOwnPropertyNames/hasOwnProperty/create), polymorphic receivers
// through `?:`, dynamic key writes against fixed-shape slots.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { i64ToF64 } from '../interop.js'
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

test('Regression: Object.freeze returns the input object value', () => {
  const { f } = run(`
    const config = Object.freeze({ mode: 1 })
    export let f = () => config.mode
  `)
  is(f(), 1)
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

test('Regression: Object.assign copies unknown-schema source', () => {
  const { f } = run(`export let f = (json) => {
    let out = {x: 0, y: 0}
    Object.assign(out, JSON.parse(json))
    return out.x * 10 + out.y
  }`)
  is(f('{"x":4,"y":7}'), 47)
})

test('Regression: Object.assign with unknown-schema source preserves target alias', () => {
  const { f } = run(`export let f = (json) => {
    let target = {x: 0}
    let alias = target
    let out = Object.assign(target, JSON.parse(json))
    return alias.x * 100 + target.y * 10 + (out === alias)
  }`)
  is(f('{"x":4,"y":7}'), 471)
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
  // Object result is a NaN-box → i64 carrier; reinterpret the raw i64 to the f64 pointer.
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

test('Regression: object-slot booleans preserve strict identity', () => {
  const { directTrue, aliasFalse } = run(`
    export let directTrue = () => {
      var object = {undefined: true}
      return object.undefined === true
    }
    export let aliasFalse = () => {
      let object = {x: false}
      let alias = object
      return alias.x === false
    }
  `)
  is(directTrue(), true)
  is(aliasFalse(), true)
})

test('Regression: object-slot booleans coerce with Number and String', () => {
  const { numbers, strings } = run(`
    export let numbers = () => {
      let falseObject = {x: false}
      let trueObject = {x: true}
      let falseAlias = falseObject
      let trueAlias = trueObject
      return Number(falseAlias.x) * 10 + Number(trueAlias.x)
    }
    export let strings = () => {
      let falseObject = {x: false}
      let trueObject = {x: true}
      let falseAlias = falseObject
      let trueAlias = trueObject
      return String(falseAlias.x) + ":" + String(trueAlias.x)
    }
  `)
  is(numbers(), 1)
  is(strings(), 'false:true')
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

test('Regression: numeric runtime key write on fixed-shape object preserves schema slots (no OOB)', () => {
  // `o[i] = v` with a runtime numeric index on a schema object once emitted a raw
  // array-style `f64.store(ptrOffset(o) + i*8)` — corrupting schema slots at small i and
  // trapping (memory access out of bounds) at large i. It now routes to __dyn_set (the
  // per-OBJECT propsPtr sidecar), mirroring `o.prop = v`. This is the exact fault that
  // broke the self-host when the dispatch table gained integer keys; runs under test:wasm.
  const { slot, loop, big, compound } = run(`
    export let slot = (i) => { let o = { x: 1 }; o[i] = 99; return o.x }
    export let loop = () => { let o = { x: 1, y: 2 }; for (let i = 0; i < 3; i++) o[i] = 9; return o.x * 10 + o.y }
    export let big = (i) => { let o = { x: 1 }; o[i] = 99; return o.x }
    export let compound = (i) => { let o = { x: 5 }; o[i] += 1; return o.x }
  `)
  is(slot(0), 1)     // i=0 overlaps slot-0 position — must not corrupt o.x
  is(slot(1), 1)     // adjacent heap — must not corrupt
  is(loop(), 12)     // x=1, y=2 unchanged; no trap across iterations
  is(big(8000), 1)   // large i — must not trap (out of bounds)
  is(compound(0), 5) // undefined+1=NaN to sidecar; slot 0 (o.x) untouched
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

test('Object.getOwnPropertyNames: returns object literal property names', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 1, y: 2, z: 3}
    let names = Object.getOwnPropertyNames(o)
    return names.indexOf("x") + names.indexOf("y") + names.indexOf("z")
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

// ECMA-262 keeps one property per name; a repeated key overwrites the earlier
// initializer. jz folds the duplicates into a single schema slot holding the last
// value — never two slots, never the first write.
test('Regression: duplicate object-literal keys — last write wins, single slot', () => {
  is(run(`export let f = () => ({a: 1, a: 2}).a`).f(), 2)
  is(run(`export let f = () => ({a: 1, b: 2, a: 3}).a`).f(), 3)
  is(run(`export let f = () => ({a: 1, b: 2, a: 3}).b`).f(), 2)
  is(run(`export let f = () => { let o = { x: 1, x: 2, x: 3 }; return o.x }`).f(), 3)
  is(run(`export let f = () => Object.keys({a: 1, a: 2}).length`).f(), 1)
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

test('Regression: anonymous fixed-shape object literals do not allocate dynamic shadows', () => {
  const wat = compile(`export let f = (items) => {
    let output = []
    for (let i = 0; i < items.length; i = i + 1) {
      let item = items[i]
      output.push({ id: item.id, quantity: item.quantity })
    }
    return output.length
  }`, { jzify: true, wat: true })

  ok(!/call \$__dyn_set/.test(wat), 'anonymous fixed-shape literals should not allocate sidecar hashes')
})

// When the program does any `obj[k]` with computed key elsewhere, anyDynKey
// becomes true → every anonymous-escaping object literal shadow-writes its
// schema keys to the per-object propsPtr (so future `o[k]` lookups can hit
// the mirror). The schema slots and the propsPtr are then twin representations
// of the same keys. Object.keys / values / entries / JSON.stringify must NOT
// enumerate schema-mirrored keys twice — propsPtr-for-schema-keys is a
// runtime mirror for dyn-key reads, not an enumeration entity. Without dedup,
// the kernel (which uses dyn access internally → anyDynKey=true) emits
// duplicated keys in its own JSON output, breaking metacircular byte-identity.
// (Heap-path literals only: literals whose values are all constants take the
// static-segment path and store no propsPtr — they hit no dedup gate.)
test('Regression: shadow-mirrored schema keys not duplicated by JSON.stringify', () => {
  const { f } = run(`export let f = (t, k, v) => {
    let probe = t[k]              // forces anyDynKey
    let x = v + 1, y = v + 2      // var values → heap-path literal
    return JSON.stringify({a: x, b: y})
  }`)
  is(f({x: 9}, 'x', 10), '{"a":11,"b":12}')
})

test('Regression: shadow-mirrored schema keys not duplicated by Object.keys (bound var with dyn write)', () => {
  // Bound-var with `o[k] = v` → dynKeyVars.has('o') → needsDynShadow('o') = true.
  // Object literal shadow-writes its schema keys to propsPtr; off-schema 'c'
  // is added later. Schema-only enumeration would drop 'c'; un-deduped union
  // would emit a, b, a, b, c. Correct: a, b, c.
  const { f } = run(`export let f = (t, k, v) => {
    let probe = t[k]
    let x = v + 1, y = v + 2
    let o = {a: x, b: y}
    o[k] = 99
    return Object.keys(o).length
  }`)
  is(f({x: 9}, 'c', 10), 3)
})

test('Regression: shadow-mirrored schema keys not duplicated by Object.values', () => {
  const { f } = run(`export let f = (t, k, v) => {
    let probe = t[k]
    let x = v + 1, y = v + 2
    return Object.values({a: x, b: y}).length
  }`)
  is(f({x: 9}, 'x', 10), 2)
})

test('Regression: shadow-mirrored schema keys not duplicated by Object.entries', () => {
  const { f } = run(`export let f = (t, k, v) => {
    let probe = t[k]
    let x = v + 1, y = v + 2
    return Object.entries({a: x, b: y}).length
  }`)
  is(f({x: 9}, 'x', 10), 2)
})

// Mixed: schema keys + a runtime-added off-schema key. Schema-shadowed
// entries on propsPtr must be skipped during enumeration; the off-schema
// entry must still appear exactly once.
test('Regression: shadow + off-schema dyn key — exact JSON enumeration', () => {
  const { f } = run(`export let f = (t, k, v) => {
    let probe = t[k]
    let x = v + 1, y = v + 2
    let o = {a: x, b: y}
    o[k] = 99
    return JSON.stringify(o)
  }`)
  is(f({x: 9}, 'c', 10), '{"a":11,"b":12,"c":99}')
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

test('Object.hasOwn: dynamic key on known-schema OBJECT', () => {
  const { f } = run(`
    export let f = (k) => {
      const x = {a: 1, b: 2}
      return Object.hasOwn(x, k) ? 1 : 0
    }
  `)
  is(f('a'), 1)
  is(f('z'), 0)
})

test('Object.hasOwn: HASH receiver via JSON.parse', () => {
  const { f } = run(`export let f = (s, k) => Object.hasOwn(JSON.parse(s), k) ? 1 : 0`)
  is(f('{"a":1,"b":2}', 'a'), 1)
  is(f('{"a":1,"b":2}', 'z'), 0)
})

test('Object.hasOwn: Array numeric index', () => {
  const { f } = run(`export let f = () => {
    const a = [10, 20, 30]
    return Object.hasOwn(a, 0) ? 1 : 0
  }`)
  is(f(), 1)
})

test('Object.hasOwn: String numeric index', () => {
  const { f } = run(`export let f = (i) => Object.hasOwn("abc", i) ? 1 : 0`)
  is(f(1), 1)
  is(f(9), 0)
})

test('Object.hasOwn: absent inherited property on empty object', () => {
  const { f } = run(`export let f = () => Object.hasOwn({}, 'toString') ? 1 : 0`)
  is(f(), 0)
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

test('jzify: Object.prototype.hasOwnProperty.call canonicalizes to instance hasOwnProperty', () => {
  const { f } = jz(`
    export let f = (k) => {
      const x = {a: 1, b: 2}
      return Object.prototype.hasOwnProperty.call(x, k) ? 1 : 0
    }
  `, { jzify: true }).exports
  is(f('a'), 1)
  is(f('z'), 0)
})

test('jzify: Object.prototype.toString.call canonicalizes to object tag helper', () => {
  const { objectTag, arrayTag, sameTag } = jz(`
    export let objectTag = (json) => Object.prototype.toString.call(JSON.parse(json)) === "[object Object]" ? 1 : 0
    export let arrayTag = () => Object.prototype.toString.call([1, 2]) === "[object Array]" ? 1 : 0
    export let sameTag = (left, right) => Object.prototype.toString.call(JSON.parse(left)) === Object.prototype.toString.call(JSON.parse(right)) ? 1 : 0
  `, { jzify: true }).exports
  is(objectTag('{"a":1}'), 1)
  is(arrayTag(), 1)
  is(sameTag('{"a":1}', '{"b":2}'), 1)
  is(sameTag('{"a":1}', '[1]'), 0)
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

test('jzify: map(String) canonicalizes to inline String callback', () => {
  const { f } = jz(`
    export let f = () => [1, 2].map(String).join(",")
  `, { jzify: true }).exports
  is(f(), '1,2')
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

// Object.create — schema-typed proto copy + array proto clone + null proto.
// Originally hit "Unknown stdlib 'array'" because the emitter pulled the array
// module without the proto inclusion list.
test('Object.create(null) compiles', () => {
  const { f } = run(`export let f = () => { let o = Object.create(null); return 42 }`)
  is(f(), 42)
})

test('Object.create with schema-typed proto copies properties', () => {
  const { f } = run(`export let f = () => {
    let proto = { x: 1, y: 2 }
    let o = Object.create(proto)
    return o.x + o.y
  }`)
  is(f(), 3)
})

test('Object.create with array proto clones data', () => {
  // watr pattern: ctx.local = Object.create(param)
  const { f } = run(`export let f = () => {
    let arr = [10, 20, 30]
    let copy = Object.create(arr)
    return copy[0] + copy[1] + copy[2]
  }`)
  is(f(), 60)
})

// IIFE property access — `(function(){}).hasOwnProperty('caller')` used to
// crash with "table index is out of bounds" because __dyn_get_expr_t returned
// NULL_NAN for missing properties and call_indirect blindly used it as a
// table index. Now guarded with a __ptr_type check. (test262 S13.2_A7_T1/T2)

test('IIFE property access — .hasOwnProperty("caller") does not crash', () => {
  const exports = run(`export let _run = () => { (function(){}).hasOwnProperty('caller'); return 1 }`, { jzify: true })
  is(exports._run(), 1)
})

test('IIFE property access — .hasOwnProperty("arguments") does not crash', () => {
  const exports = run(`export let _run = () => { (function(){}).hasOwnProperty('arguments'); return 1 }`, { jzify: true })
  is(exports._run(), 1)
})

test('semicolon before leading-paren IIFE after object initializer', () => {
  const exports = run(`let state = 0
    const table = {};
    (function populate(value) { state = value })(7)
    export let _run = () => state`, { jzify: true })
  is(exports._run(), 7)
})

test('jzify: object method shorthand captures receiver as this', () => {
  const exports = run(`export let _run = () => {
    const box = {
      value: 7,
      inc(n) { this.value = this.value + n; return this.value }
    }
    return box.inc(5) + box.value
  }`, { jzify: true })
  is(exports._run(), 24)
})

test('jzify: object method can call sibling method through this', () => {
  const exports = run(`export let _run = () => {
    const calc = {
      value: 3,
      add(n) { this.value = this.value + n; return this },
      double() { return this.add(this.value).value }
    }
    return calc.double()
  }`, { jzify: true })
  is(exports._run(), 6)
})

test('jzify: object arrow property keeps lexical this unsupported', () => {
  let msg = ''
  try {
    compile(`export let _run = () => {
      const box = { value: 1, read: () => this.value }
      return box.read()
    }`, { jzify: true })
  } catch (e) { msg = e.message }
  ok(msg.includes('`this` not supported'), 'lexical arrow this is not receiver-bound')
})

// Computed property names — static keys map to fixed-shape slots; dynamic
// computed keys lower to dict-side stores; effectful coercion runs and the
// coerced key is the resolved property name. (test262 ObjectLiteral cases)

test('computed property names: static keys map to fixed-shape object slots', () => {
  const exports = run(`export let _run = () => {
    let o = { ['x']: 1, [1 + 1]: 2, [true ? 3 : 4]: 5 }
    if (o.x !== 1) return 0
    if (o[2] !== 2) return 0
    if (o[String(3)] !== 5) return 0
    return 1
  }`, { jzify: true })
  is(exports._run(), 1)
})

test('computed property names: dynamic computed key lowers to dict-side store', () => {
  // `{ [x = "kk"]: 3 }` mutates x to "kk" and stores 3 under that key.
  const exports = run(`export let _run = () => { let x = "a"; let o = { [x = "kk"]: 3 }; return o["kk"] }`, { jzify: true })
  is(exports._run(), 3)
})

test('computed property names: effectful coercion runs and key stores under coerced value', () => {
  // `{ [(x = 1, "k")]: 2 }` — the comma side-effect runs; "k" is the resolved key.
  const exports = run(`export let _run = () => { let x = 0; let o = { [(x = 1, "k")]: 2 }; return x + o["k"] }`, { jzify: true })
  is(exports._run(), 3)
})

// === static object-literal soundness: shared instance vs mutation ===
// A pure-constant ≥2-prop literal takes the static-data fast path — ONE shared
// instance returned from every evaluation. That used to leak writes between
// "instances" (`mk().n++` visible through the next `mk()`), at every opt level;
// inside the self-host kernel the same bug pooled propagate's use-count records
// ({gets,sets,tees}) across ALL locals, deleting live stores at kernel-L2.
// writtenProps (program-facts) now disqualifies literals whose prop names are
// ever written; read-only literals keep the static path.

test('static literal: direct mutation does not alias instances', () => {
  const { f } = run(`
    let mk = () => ({ n: 0, m: 0 })
    export let f = () => { let a = mk(); let b = mk(); a.n++; return b.n }`)
  is(f(), 0)
})

test('static literal: mutation through call-expression receiver', () => {
  const { f } = run(`
    let mk = () => ({ n: 0, m: 0 })
    let pick = (x) => x
    export let f = () => { let a = mk(); let b = mk(); pick(a).n++; return b.n }`)
  is(f(), 0)
})

test('static literal: mutation through Map storage (use-count record shape)', () => {
  const { f } = run(`
    let counts = new Map()
    let ensure = (name) => { if (!counts.has(name)) counts.set(name, { gets: 0, sets: 0, tees: 0 }); return counts.get(name) }
    export let f = () => {
      ensure('a').gets++
      ensure('b').sets++
      ensure('a').gets++
      let a = counts.get('a'), b = counts.get('b')
      return a.gets * 100 + a.sets * 10 + b.sets
    }`)
  is(f(), 201)  // a: gets 2 sets 0 · b: sets 1
})

test('static literal: read-only literals keep the shared static instance', () => {
  const { f } = run(`
    let mk = () => ({ x: 7, y: 9 })
    export let f = () => { let a = mk(); let b = mk(); return a.x + b.y }`)
  is(f(), 16)
})

// ---- schema shape-consensus (poisoning) ------------------------------------
// A variable's literal schema binds ONLY while every assignment agrees on that
// one shape. A disagreeing assignment — non-literal source (table/Map lookup)
// or different-shape literal, even in dead code — unbinds and poisons the name:
// fixed-slot reads against one literal's layout would misread the other
// sources' objects (the `.x` = foreign slot-0 class of bug, found via the
// self-host kernel where a dead-branch literal poisoned tryReduceVectorize's
// table entries and killed all reduce vectorization in jz.wasm).

test('schema poison: dead-code literal must not fix slots for a table-sourced var', () => {
  const r = run(`
    const TBL = { k: { a: 7, b: 8, c: 9 } }
    export let go = (m) => {
      let e = TBL.k
      if (m === 999) { e = { z: 5, w: 6 } }
      return (e.a | 0) * 100 + ((e.z | 0) % 100)
    }
  `)
  is(r.go(0), 700)   // .a real read; .z undefined → 0 (not slot-0 of {z,w} layout)
})

test('schema poison: decl literal + branch reassign from table reads dynamically', () => {
  const r = run(`
    const TBL = { k: { a: 7, b: 8, c: 9 } }
    export let go = (m) => {
      let e = { x: 1, y: 2 }
      if (m) e = TBL.k
      return (e.a | 0) * 100 + ((e.x | 0) % 100)
    }
  `)
  is(r.go(0), 1)     // literal shape: a undefined, x = 1
  is(r.go(1), 700)   // table shape: a = 7, x undefined
})

test('schema poison: module global reassigned from table reads dynamically', () => {
  const r = run(`
    const TBL = { k: { a: 7, b: 8, c: 9 } }
    let g = { x: 1, y: 2 }
    export let go = (m) => {
      if (m) g = TBL.k
      return (g.a | 0) * 100 + ((g.x | 0) % 100)
    }
  `)
  is(r.go(1), 700)
})

test('schema poison: ternary literals + Map-sourced entries share one variable', () => {
  // The exact vectorizer shape: dead two-literal ternary + live Map.get, then
  // reads of props that exist only on some shapes.
  const r = run(`
    const OPS = {
      i32: { add: { simd: 'i32x4.add', extract: 'lane', laneType: 'i32', constNode: ['i32.const', 0] } },
      f64: { add: { simd: 'f64x2.add', extract: 'lane', laneType: 'f64', constNode: ['f64.const', 0] } },
    }
    const LOOKUP = (() => {
      const m = new Map()
      for (const lt of Object.keys(OPS)) for (const op of Object.keys(OPS[lt])) m.set(lt + '.' + op, OPS[lt][op])
      return m
    })()
    export let go = (mode) => {
      let entry
      if (mode === 1) {
        const w = null
        entry = w ? { simd: 'i8x16.max_u', laneType: 'i8' }
          : { simd: 'i32x4.max_s', laneType: 'i32', minmaxSelect: true }
      } else {
        entry = LOOKUP.get('i32.add')
        if (!entry) return 'no-entry'
      }
      if (0) { entry = { laneType: 'i8', identity: ['i32.const', 0], minmaxSelect: true, accF64: 'z' } }
      if ('i32' !== (entry.accI32 ? 'i32' : entry.accF64 ? 'f64' : entry.laneType)) return 'GATE-FAIL'
      return 'pass:' + entry.simd
    }
  `)
  is(r.go(0), 'pass:i32x4.add')
  is(r.go(1), 'pass:i32x4.max_s')
})

test('schema binding intact: single-shape literal still resolves props', () => {
  // No disagreeing assignment → the literal schema binds (fast path preserved).
  const r = run(`
    export let go = () => {
      let e = { x: 3, y: 4 }
      e = { x: 5, y: 6 }
      return e.x * 10 + e.y
    }
  `)
  is(r.go(), 56)
})
