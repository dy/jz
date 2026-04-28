/**
 * Edge tests for slot-type tracking — collectProgramFacts observes the value
 * kind of each slot in `{a: e1, b: e2, …}` literals and ctx.schema.slotVT
 * answers `varName.prop` lookups on the precise (bound-schemaId) path. The
 * payoff is `+`, `===`, method dispatch eliding the `__is_str_key` runtime
 * check on numeric props of known shapes.
 *
 * Coverage axes:
 *   - correctness across precise + polymorphic slot kinds
 *   - codegen: __is_str_key absent on monomorphic-NUMBER slot reads
 *   - codegen: precondition-aware (no schemaId binding → fallback path)
 *   - polymorphic slot does NOT trigger eliding
 *   - schemaId propagation through narrowed call result
 *   - structural-subtyping intentionally off (mistyping defense)
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { run } from './util.js'

const wat = (src) => jz.compile(src, { wat: true })
const fnBody = (w, name) => {
  // jz formats `(func $name\n    (export …` — match name on its own token.
  const re = new RegExp(`\\(func \\$${name}(?:\\s|$)`)
  const m = w.match(re)
  return m ? w.slice(m.index, m.index + 4000) : null
}
const countCalls = (text, fn) => (text.match(new RegExp(`call \\$${fn}\\b`, 'g')) || []).length

test('slot-types: monomorphic NUMBER slots — correctness', () => {
  const src = `
    let make = (n) => ({ a: n + 1, b: n * 2 })
    export let f = (n) => { let o = make(n); return o.a + o.b }
  `
  const { f } = run(src)
  is(f(3), 10)  // (3+1) + (3*2)
})

test('slot-types: NUMBER on .prop AST — direct add', () => {
  const src = `
    let make = () => ({ x: 5, y: 7 })
    export let f = () => { let a = make(); return a.x + a.y }
  `
  const { f } = run(src)
  is(f(), 12)
})

test('slot-types: STRING slot value preserved end-to-end', () => {
  const src = `
    let make = () => ({ name: "abc", n: 3 })
    export let f = () => { let o = make(); return o.name }
  `
  const { f } = run(src)
  is(f(), 'abc')
})

test('slot-types: polymorphic slot — both kinds round-trip via separate exports', () => {
  // Same schema (single prop "x") observed twice with different VAL kinds:
  //   {x: 1}  → slot x = NUMBER
  //   {x: "z"} → slot x = STRING
  // After the second observation, slot x is null (polymorphic). slotVT must
  // return null so the conservative path stays correct for both kinds.
  const src = `
    let mkN = () => ({ x: 1 })
    let mkS = () => ({ x: "z" })
    export let getN = () => { let o = mkN(); return o.x }
    export let getS = () => { let o = mkS(); return o.x }
  `
  const { getN, getS } = run(src)
  is(getN(), 1)
  is(getS(), 'z')
})

test('slot-types: polymorphic slot — addition still works on each branch', () => {
  // The `+` operator is the most str-key-sensitive site. Verify both numeric
  // and string branches still produce correct results when slot kind is null.
  const src = `
    let mkN = () => ({ x: 10 })
    let mkS = () => ({ x: "ab" })
    export let addN = () => { let o = mkN(); return o.x + 5 }
    export let addS = () => { let o = mkS(); return o.x + "c" }
  `
  const { addN, addS } = run(src)
  is(addN(), 15)
  is(addS(), 'abc')
})

test('slot-types: nested object — outer .prop returns OBJECT, inner reads work', () => {
  const src = `
    let make = () => ({ inner: { a: 11, b: 22 } })
    export let f = () => { let o = make(); return o.inner.a + o.inner.b }
  `
  const { f } = run(src)
  is(f(), 33)
})

test('slot-types: schemaId propagates through narrowed call result', () => {
  // narrowSignatures sets sig.ptrAux=schemaId on `make`'s return; analyzeValTypes
  // copies that into the local's ValueRep so subsequent o.x / o.y / o.z reads
  // resolve through ctx.schema.slotVT.
  const src = `
    let make = (n) => ({ x: n, y: n*2, z: n+1 })
    export let f = (n) => { let o = make(n); return o.x + o.y + o.z }
  `
  const { f } = run(src)
  is(f(4), 4 + 8 + 5)
})

test('slot-types: heterogeneous slot kinds in same schema all monomorphic', () => {
  const src = `
    let make = () => ({ n: 7, s: "hi", b: true })
    export let getN = () => { let o = make(); return o.n }
    export let getS = () => { let o = make(); return o.s }
    export let getB = () => { let o = make(); return o.b }
  `
  const { getN, getS, getB } = run(src)
  is(getN(), 7)
  is(getS(), 'hi')
  is(getB(), 1)  // booleans surface as 1/0
})

test('slot-types: unobserved slot (param-typed value) does not crash', () => {
  // Slot value `n` has unknown VAL kind at observation time. observeSlot skips
  // on falsy vt so the slot stays undefined; later access falls back to the
  // runtime check. Slot-type tracking never *forces* a kind.
  const src = `
    let make = (n) => ({ x: n })
    export let f = (n) => { let o = make(n); return o.x + 1 }
  `
  const { f } = run(src)
  is(f(10), 11)
})

test('slot-types: distinct schemas sharing a prop name — each precise', () => {
  // {x:1, y:2} (schema A: [x, y]) and {x:3, z:4} (schema B: [x, z]) — both
  // contain prop x at slot 0, both with NUMBER values. find() can resolve x
  // structurally, but slotVT requires a precise schemaId binding. Each helper
  // here has a precise binding via its own narrowed-call return.
  const src = `
    let mkA = () => ({ x: 1, y: 2 })
    let mkB = () => ({ x: 3, z: 4 })
    export let getA = () => { let o = mkA(); return o.x + o.y }
    export let getB = () => { let o = mkB(); return o.x + o.z }
  `
  const { getA, getB } = run(src)
  is(getA(), 3)
  is(getB(), 7)
})

test('slot-types: codegen — __is_str_key elided on monomorphic NUMBER slot +', () => {
  // The motivating case. Without slot-type tracking, both `o.a` and `o.b`
  // would feed `+` with vt=null and emit a runtime str-key check. With
  // tracking, both resolve to NUMBER and the check disappears from $f.
  const src = `
    let make = (n) => ({ a: n + 1, b: n * 2 })
    export let f = (n) => { let o = make(n); return o.a + o.b }
  `
  const body = fnBody(wat(src), 'f')
  ok(body, 'export $f present in WAT')
  is(countCalls(body, '__is_str_key'), 0, 'no __is_str_key in $f body')
})

test('slot-types: codegen — polymorphic slot keeps runtime str-key check on +', () => {
  // mkS observes slot x = STRING; mkN observes slot x = NUMBER. Merged → null.
  // In addS the `+` operator must keep its str-key check because slotVT
  // returns null and valTypeOf falls through to the conservative path.
  const src = `
    let mkN = () => ({ x: 10 })
    let mkS = () => ({ x: "ab" })
    export let addS = () => { let o = mkS(); return o.x + "c" }
    export let addN = () => { let o = mkN(); return o.x + 5 }
  `
  const w = wat(src)
  const sBody = fnBody(w, 'addS')
  ok(sBody, 'export $addS present in WAT')
  // At least one __is_str_key must remain in $addS (or its inlined dispatch)
  // because slot x's kind was demoted to null by the second observation.
  ok(countCalls(sBody, '__is_str_key') >= 1, '__is_str_key retained in $addS body')
})
