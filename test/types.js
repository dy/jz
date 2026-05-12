// Type coercion (i32/f64), slot-type tracking, typed-array narrowing,
// intCertain lattice
import test from 'tst'
import { is, ok, throws, almost } from 'tst/assert.js'
import { parse } from 'subscript/feature/jessie'
import jz, { compile } from '../index.js'
import { UNDEF_NAN, NULL_NAN } from '../src/host.js'
import prepare, { GLOBALS } from '../src/prepare.js'
import { ctx, reset } from '../src/ctx.js'
import { emitter } from '../src/emit.js'
import { analyzeValTypes, analyzeIntCertain, analyzeLocals, repOf, updateRep, VAL } from '../src/analyze.js'

const coerce = v => v === undefined ? UNDEF_NAN : v === null ? NULL_NAN : v

function run(code, opts) {
  const wasm = compile(code, opts)
  const mod = new WebAssembly.Module(wasm)
  const raw = new WebAssembly.Instance(mod).exports
  const wrapped = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'function') {
      wrapped[k] = (...a) => {
        while (a.length < v.length) a.push(undefined)
        return v.apply(null, a.map(coerce))
      }
    } else wrapped[k] = v
  }
  return wrapped
}

// jz()-based — needed by slot/typed-narrow tests that use full host wiring.
const runHost = (code) => jz(code).exports
const wat = (src) => jz.compile(src, { wat: true })
const fnBody = (w, name) => {
  const re = new RegExp(`\\(func \\$${name}(?:\\s|$)`)
  const m = w.match(re)
  return m ? w.slice(m.index, m.index + 4000) : null
}
const countCalls = (text, fn) =>
  (text.match(new RegExp(`call \\$${fn}\\b`, 'g')) || []).length

// === Integer preservation ===

test('type: 1 + 2 stays i32 internally', () => {
  is(run('export let f = () => 1 + 2').f(), 3)
})

test('type: 1.0 + 2.0 is f64', () => {
  is(run('export let f = () => 1.0 + 2.0').f(), 3)
})

test('type: mixed i32 + f64 promotes', () => {
  is(run('export let f = () => 1 + 2.5').f(), 3.5)
})

test('type: division always f64', () => {
  is(run('export let f = () => 10 / 3').f(), 10 / 3)
})

test('type: i32 chain', () => {
  is(run('export let f = (a, b) => a * 2 + b * 3').f(4, 5), 23)
})

test('type: local preserves i32', () => {
  is(run('export let f = () => { let x = 5; let y = 3; return x + y }').f(), 8)
})

test('type: local widens to f64', () => {
  is(run('export let f = () => { let x = 5; x = 2.5; return x }').f(), 2.5)
})

// === Bitwise operators ===

test('bitwise: &', () => {
  is(run('export let f = (a, b) => a & b').f(0xFF, 0x0F), 0x0F)
})

test('bitwise: |', () => {
  is(run('export let f = (a, b) => a | b').f(0xF0, 0x0F), 0xFF)
})

test('bitwise: ^', () => {
  is(run('export let f = (a, b) => a ^ b').f(0xFF, 0x0F), 0xF0)
})

test('bitwise: ~', () => {
  is(run('export let f = (a) => ~a').f(0), -1)
})

test('bitwise: <<', () => {
  is(run('export let f = (a, b) => a << b').f(1, 8), 256)
})

test('bitwise: >>', () => {
  is(run('export let f = (a, b) => a >> b').f(256, 4), 16)
})

test('bitwise: >>>', () => {
  is(run('export let f = (a, b) => a >>> b').f(256, 4), 16)
})

test('bitwise: floatbeat t >> 8 & 255', () => {
  is(run('export let f = (t) => t >> 8 & 255').f(0x1234), 0x12)
})

// === ToInt32 string coercion (ECMA-262 7.1.6) ===
// Bitwise ops first ToNumber-coerce non-numeric operands; for strings, that
// parses StringNumericLiteral (decimal, hex, sign, leading whitespace), with
// invalid strings → NaN → ToInt32(NaN) = 0.

test('bitwise: "2026" | 0 → 2026', () => {
  is(jz('export let f = () => { let s = "2026"; return s | 0 }').exports.f(), 2026)
})

test('bitwise: "-42" | 0 → -42', () => {
  is(jz('export let f = () => { let s = "-42"; return s | 0 }').exports.f(), -42)
})

test('bitwise: "3.7" | 0 truncates toward zero → 3', () => {
  is(jz('export let f = () => { let s = "3.7"; return s | 0 }').exports.f(), 3)
})

test('bitwise: "abc" | 0 → 0 (NaN coerces to 0)', () => {
  is(jz('export let f = () => { let s = "abc"; return s | 0 }').exports.f(), 0)
})

test('bitwise: "" | 0 → 0', () => {
  is(jz('export let f = () => { let s = ""; return s | 0 }').exports.f(), 0)
})

test('bitwise: numeric literal | 0 fast path still works', () => {
  is(jz('export let f = () => 3.7 | 0').exports.f(), 3)
  is(jz('export let f = () => -42 | 0').exports.f(), -42)
})

test('bitwise: "0xff" | 0 hex string → 255', () => {
  is(jz('export let f = () => { let s = "0xff"; return s | 0 }').exports.f(), 255)
})

test('bitwise: ~"2026" → -2027', () => {
  is(jz('export let f = () => { let s = "2026"; return ~s }').exports.f(), -2027)
})

test('bitwise: "42" & 0xFF → 42', () => {
  is(jz('export let f = () => { let s = "42"; return s & 0xFF }').exports.f(), 42)
})

test('bitwise: "42" >> 1 → 21', () => {
  is(jz('export let f = () => { let s = "42"; return s >> 1 }').exports.f(), 21)
})

test('bitwise: "42" << 1 → 84', () => {
  is(jz('export let f = () => { let s = "42"; return s << 1 }').exports.f(), 84)
})

test('bitwise: "-1" >>> 0 → 0xFFFFFFFF', () => {
  is(jz('export let f = () => { let s = "-1"; return s >>> 0 }').exports.f(), 4294967295)
})

test('bitwise: "42" ^ 0xFF → 213', () => {
  is(jz('export let f = () => { let s = "42"; return s ^ 0xFF }').exports.f(), 42 ^ 0xFF)
})

test('bitwise: numeric fast path emits no __to_num call', () => {
  const wat = jz.compile(`
    export const main = (n) => (n | 0) + (n & 0xFF) + (n >> 1) + (n << 1) + (n >>> 0)
  `, { wat: true })
  is((wat.match(/\$__to_num/g) || []).length, 0, 'numeric-only operands skip __to_num wrapper')
})

// === Named constants ===

test('constant: true', () => {
  is(run('export let f = () => true').f(), 1)
})

test('constant: false', () => {
  is(run('export let f = () => false').f(), 0)
})

test('constant: null', () => {
  ok(isNaN(run('export let f = () => null').f()), 'null is NaN-boxed')
})

test('constant: NaN', () => {
  ok(isNaN(run('export let f = () => NaN').f()))
})

test('constant: Infinity', () => {
  is(run('export let f = () => Infinity').f(), Infinity)
})

test('constant: true/false in condition', () => {
  is(run('export let f = () => { if (true) return 1; return 0 }').f(), 1)
  is(run('export let f = () => { if (false) return 1; return 0 }').f(), 0)
})

test('comparison result in bitwise', () => {
  is(run('export let f = (a, b) => (a > b) & 1').f(5, 3), 1)
  is(run('export let f = (a, b) => (a > b) & 1').f(1, 3), 0)
})

// === Nullish coalescing ===

test('??: returns left if truthy', () => {
  is(run('export let f = (a, b) => a ?? b').f(5, 10), 5)
})

test('??: 0 is NOT nullish (returns 0)', () => {
  is(run('export let f = (a, b) => a ?? b').f(0, 10), 0)
})

test('??: null IS nullish (returns right)', () => {
  is(run('export let f = () => null ?? 42').f(), 42)
})

// === void ===

test('void: returns undefined', () => {
  is(jz('export let f = (x) => void x').exports.f(42), undefined)
})

// === typeof ===

test('typeof: number literal', () => {
  is(jz('export let f = () => typeof 5').exports.f(), 'number')
})

test('typeof: string literal', () => {
  is(jz('export let f = () => typeof "hi"').exports.f(), 'string')
})

test('typeof: undefined', () => {
  is(jz('export let f = () => typeof undefined').exports.f(), 'undefined')
})

test('typeof: boolean true (compile-time fold)', () => {
  // Booleans NaN-box as f64 → runtime typeof returns 'number'. Prepare folds literal to 'boolean'.
  is(jz('export let f = () => typeof true').exports.f(), 'boolean')
})

test('typeof: boolean false (compile-time fold)', () => {
  is(jz('export let f = () => typeof false').exports.f(), 'boolean')
})

test('typeof: comparison still works', () => {
  is(jz('export let f = (x) => typeof x === "number"').exports.f(5), 1)
})

// === Unary + ===

test('unary +: number literal stays number', () => {
  is(jz('export let f = () => +5').exports.f(), 5)
})

test('unary +: coerce string to number', () => {
  is(jz('export let f = (s) => +s').exports.f('42'), 42)
})

test('unary +: coerce boolean to number', () => {
  is(jz('export let f = (b) => +b').exports.f(true), 1)
  is(jz('export let f = (b) => +b').exports.f(false), 0)
})

test('unary +: numeric variable returns same value', () => {
  is(jz('export let f = (x) => +x').exports.f(7), 7)
})

// === Optional call ?.() ===

test('?.(): non-null callable returns value', () => {
  const { f } = jz(`export let f = () => {
    let g = () => 42
    return g?.()
  }`).exports
  is(f(), 42)
})

test('?.(): null short-circuits to undefined', () => {
  const { f } = jz(`export let f = (n) => {
    let g = n > 0 ? () => 42 : null
    return g?.()
  }`).exports
  is(f(1), 42)
  is(f(0), undefined)
})

test('?.(): with arguments', () => {
  const { f } = jz(`export let f = () => {
    let add = (a, b) => a + b
    return add?.(3, 4)
  }`).exports
  is(f(), 7)
})

// === switch ===

test('switch: with default', () => {
  const { f } = run(`export let f = (x) => {
    switch(x) { case 1: return 10; default: return 0 }
  }`)
  is(f(1), 10)
  is(f(99), 0)
})

test('switch: two cases', () => {
  // Note: parser has recursion limit with many cases in block body
  const { f } = run(`export let f = (x) => {
    switch(x) { case 1: return 10; case 2: return 20 }
    return -1
  }`)
  is(f(1), 10)
  is(f(2), 20)
  is(f(99), -1)
})

// === Default params ===

test('default param: used when arg missing', () => {
  const { f } = run('export let f = (x = 5) => x')
  is(f(), 5)    // missing → NaN → default kicks in
  is(f(0), 0)   // explicit 0 is NOT missing
  is(f(3), 3)
})

test('default param: second param', () => {
  const { f } = run('export let f = (a, b = 10) => a + b')
  is(f(1, 2), 3)
  is(f(1), 11)   // b missing → NaN → default 10
})

// ============================================================================
// Slot-type tracking — collectProgramFacts observes value kind in `{a:e1,…}`
// literals; ctx.schema.slotVT answers `varName.prop` lookups on the precise
// (bound-schemaId) path. Payoff: `+`, `===`, method dispatch elide the
// __is_str_key runtime check on numeric props of known shapes.
// ============================================================================

test('slot-types: monomorphic NUMBER slots — correctness', () => {
  const src = `
    let make = (n) => ({ a: n + 1, b: n * 2 })
    export let f = (n) => { let o = make(n); return o.a + o.b }
  `
  is(runHost(src).f(3), 10)  // (3+1) + (3*2)
})

test('slot-types: NUMBER on .prop AST — direct add', () => {
  const src = `
    let make = () => ({ x: 5, y: 7 })
    export let f = () => { let a = make(); return a.x + a.y }
  `
  is(runHost(src).f(), 12)
})

test('slot-types: STRING slot value preserved end-to-end', () => {
  const src = `
    let make = () => ({ name: "abc", n: 3 })
    export let f = () => { let o = make(); return o.name }
  `
  is(runHost(src).f(), 'abc')
})

test('slot-types: polymorphic slot — both kinds round-trip via separate exports', () => {
  // Same schema (single prop "x") observed twice with different VAL kinds.
  // After the second observation, slot x is null (polymorphic).
  const src = `
    let mkN = () => ({ x: 1 })
    let mkS = () => ({ x: "z" })
    export let getN = () => { let o = mkN(); return o.x }
    export let getS = () => { let o = mkS(); return o.x }
  `
  const { getN, getS } = runHost(src)
  is(getN(), 1)
  is(getS(), 'z')
})

test('slot-types: polymorphic slot — addition still works on each branch', () => {
  // `+` is the most str-key-sensitive site. Both branches must produce correct
  // results when slot kind is null.
  const src = `
    let mkN = () => ({ x: 10 })
    let mkS = () => ({ x: "ab" })
    export let addN = () => { let o = mkN(); return o.x + 5 }
    export let addS = () => { let o = mkS(); return o.x + "c" }
  `
  const { addN, addS } = runHost(src)
  is(addN(), 15)
  is(addS(), 'abc')
})

test('slot-types: nested object — outer .prop returns OBJECT, inner reads work', () => {
  const src = `
    let make = () => ({ inner: { a: 11, b: 22 } })
    export let f = () => { let o = make(); return o.inner.a + o.inner.b }
  `
  is(runHost(src).f(), 33)
})

test('slot-types: schemaId propagates through narrowed call result', () => {
  const src = `
    let make = (n) => ({ x: n, y: n*2, z: n+1 })
    export let f = (n) => { let o = make(n); return o.x + o.y + o.z }
  `
  is(runHost(src).f(4), 4 + 8 + 5)
})

test('slot-types: heterogeneous slot kinds in same schema all monomorphic', () => {
  const src = `
    let make = () => ({ n: 7, s: "hi", b: true })
    export let getN = () => { let o = make(); return o.n }
    export let getS = () => { let o = make(); return o.s }
    export let getB = () => { let o = make(); return o.b }
  `
  const { getN, getS, getB } = runHost(src)
  is(getN(), 7)
  is(getS(), 'hi')
  is(getB(), 1)  // booleans surface as 1/0
})

test('slot-types: unobserved slot (param-typed value) does not crash', () => {
  // Slot value `n` has unknown VAL kind at observation time. observeSlot skips
  // on falsy vt so the slot stays undefined; runtime check covers the access.
  const src = `
    let make = (n) => ({ x: n })
    export let f = (n) => { let o = make(n); return o.x + 1 }
  `
  is(runHost(src).f(10), 11)
})

test('slot-types: distinct schemas sharing a prop name — each precise', () => {
  const src = `
    let mkA = () => ({ x: 1, y: 2 })
    let mkB = () => ({ x: 3, z: 4 })
    export let getA = () => { let o = mkA(); return o.x + o.y }
    export let getB = () => { let o = mkB(); return o.x + o.z }
  `
  const { getA, getB } = runHost(src)
  is(getA(), 3)
  is(getB(), 7)
})

test('slot-types: codegen — __is_str_key elided on monomorphic NUMBER slot +', () => {
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
  // In addS the `+` operator must keep its str-key check.
  const src = `
    let mkN = () => ({ x: 10 })
    let mkS = () => ({ x: "ab" })
    export let addS = () => { let o = mkS(); return o.x + "c" }
    export let addN = () => { let o = mkN(); return o.x + 5 }
  `
  const sBody = fnBody(wat(src), 'addS')
  ok(sBody, 'export $addS present in WAT')
  ok(countCalls(sBody, '__is_str_key') >= 1, '__is_str_key retained in $addS body')
})

// ============================================================================
// TYPED narrowing — internal sig narrowing of helpers that always return a
// typed-array of constant elemType. compile.js narrowSignatures sets
//   sig.results = ['i32'], sig.ptrKind = VAL.TYPED, sig.ptrAux = elemAux
// so callers see an i32 offset and skip the f64 NaN-rebox.
// ============================================================================

test('typed-narrow: Float64Array helper — direct index after narrowed call', () => {
  const { f } = runHost(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => { let a = mk(); return a[i] }
  `)
  is(f(0), 1.5)
  is(f(1), 2.5)
  is(f(2), 3.5)
})

test('typed-narrow: Int32Array helper — distinct elemType preserved', () => {
  // Int32Array (elemAux=4) must not collide with Float64Array (elemAux=7).
  const { f } = runHost(`
    let mk = () => new Int32Array([10, 20, 30])
    export let f = (i) => { let a = mk(); return a[i] }
  `)
  is(f(0), 10)
  is(f(1), 20)
  is(f(2), 30)
})

test('typed-narrow: chain — outer helper forwards inner narrowed result', () => {
  // Fixpoint: outer narrows only after inner; outer's typedAuxOfReturn reads
  // inner's f.sig.ptrAux to confirm same elem aux across all returns.
  const { f } = runHost(`
    let inner = () => new Float64Array([7.5, 8.5])
    let outer = () => inner()
    export let f = (i) => { let a = outer(); return a[i] }
  `)
  is(f(0), 7.5)
  is(f(1), 8.5)
})

test('typed-narrow: ?: with two same-elemType arms narrows', () => {
  const { f } = runHost(`
    let mk = (w) => w == 0 ? new Float64Array([1.5, 2.5]) : new Float64Array([3.5, 4.5])
    export let f = (w, i) => { let a = mk(w); return a[i] }
  `)
  is(f(0, 0), 1.5)
  is(f(0, 1), 2.5)
  is(f(1, 0), 3.5)
  is(f(1, 1), 4.5)
})

test('typed-narrow: ?: with mixed elemType does NOT narrow (still correct)', () => {
  // Polymorphic typed-array result — typedAuxOfReturn sees aux mismatch and
  // bails. Result stays f64 NaN-boxed; runtime kind dispatch resolves both.
  const { f } = runHost(`
    let mk = (w) => w == 0 ? new Float64Array([1.5, 2.5]) : new Int32Array([10, 20])
    export let f = (w, i) => { let a = mk(w); return a[i] }
  `)
  is(f(0, 0), 1.5)
  is(f(0, 1), 2.5)
  is(f(1, 0), 10)
  is(f(1, 1), 20)
})

test('typed-narrow: codegen — narrowed helper return type is i32', () => {
  const w = wat(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => { let a = mk(); return a[i] }
  `)
  const body = fnBody(w, 'mk')
  ok(body, '$mk present in WAT')
  ok(/\(result i32\)/.test(body), '$mk returns i32 (narrowed)')
})

test('typed-narrow: codegen — receiver uses static elem load (no __is_str_key dispatch)', () => {
  const w = wat(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => { let a = mk(); return a[i] }
  `)
  const body = fnBody(w, 'f')
  ok(body, '$f present in WAT')
  ok(!/__is_str_key/.test(body), '$f has no __is_str_key dispatch')
})

test('typed-narrow: owned typed-array byteOffset is constant zero', () => {
  const w = wat(`
    export let f = () => {
      let a = new Float64Array(8)
      return a.byteOffset
    }
  `)
  ok(!/__byte_offset/.test(w), 'owned typed-array byteOffset should not pull runtime helper')
  is(runHost(`export let f = () => { let a = new Float64Array(8); return a.byteOffset }`).f(), 0)
})

test('typed-narrow: bytes — narrowed helper + static load is compact', () => {
  // Threshold tracks recorded baseline with headroom.
  const src = `
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => { let a = mk(); return a[i] }
  `
  const bytes = jz.compile(src).length
  ok(bytes <= 900, `typed helper probe ${bytes}b — narrowing or fusedRewrite likely regressed (>900b)`)
})

test('typed-narrow: escape via store does not break narrowed helper', () => {
  // Receiver consumed in a way that requires reboxing to f64 (passed to an
  // array index store). asF64 path on narrowed-call result must re-pack with
  // correct elemType aux.
  const { f } = runHost(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = () => {
      let a = mk()
      let arr = [a]
      return arr[0][1]
    }
  `)
  is(f(), 2.5)
})

test('typed-narrow: receiver unbox after .map on TYPED', () => {
  // analyzePtrUnboxable.isFreshInit accepts `arr.map(fn)` shape when arr is in
  // ctx.types.typedElem (locally TYPED with known elem ctor).
  const { f } = runHost(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => {
      let a = mk()
      let b = a.map(x => x + 10)
      return b[i]
    }
  `)
  is(f(0), 11.5)
  is(f(1), 12.5)
  is(f(2), 13.5)
})

test('typed-narrow: codegen — .map receiver is i32 + static load', () => {
  const w = wat(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => {
      let a = mk()
      let b = a.map(x => x + 10)
      return b[i]
    }
  `)
  const body = fnBody(w, 'f')
  ok(body, '$f present')
  ok(/\(local \$b i32\)/.test(body), '$b unboxed to i32 (.map receiver)')
  ok(!/__is_str_key/.test(body), '$f has no __is_str_key after .map receiver unbox')
})

test('typed-narrow: chained .map preserves elem type', () => {
  // a.map(...).map(...) — first .map's result is locally TYPED with same elem
  // ctor (propagateTyped strips .view).
  const { f } = runHost(`
    let mk = () => new Float64Array([1.0, 2.0, 3.0])
    export let f = (i) => {
      let a = mk()
      let b = a.map(x => x * 2)
      let c = b.map(x => x + 1)
      return c[i]
    }
  `)
  is(f(0), 3)
  is(f(1), 5)
  is(f(2), 7)
})

test('typed-narrow: .map on Int32Array preserves distinct elem aux', () => {
  // Int32Array elemAux=4, Float64Array elemAux=7. Wrong aux → wrong stride.
  const { f } = runHost(`
    let mk = () => new Int32Array([10, 20, 30])
    export let f = (i) => {
      let a = mk()
      let b = a.map(x => x + 100)
      return b[i]
    }
  `)
  is(f(0), 110)
  is(f(1), 120)
  is(f(2), 130)
})

// ============================================================================
// intCertain lattice — pure analysis, no codegen impact. Pins the forward-
// propagation rule against AST inputs.
// ============================================================================

// Run analyzer against a single user-defined arrow body. Returns a Proxy that
// yields true for every intCertain-marked local and false otherwise (so tests
// can assert `is(r.n, false)` without distinguishing "not intCertain" from "no
// rep entry"). `paramVals` mirrors what narrowSignatures pre-seeds in the real
// pipeline — needed only for tests that exercise `.length` / receiver-typed.
function runAnalyze(code, paramVals) {
  reset(emitter, GLOBALS)
  prepare(parse(code))
  const fn = ctx.func.list.find(f => !f.raw && !f.exported && f.body && Array.isArray(f.body))
    || ctx.func.list[0]
  const body = fn.body
  ctx.func.locals = analyzeLocals(body)
  if (paramVals) for (const [n, v] of Object.entries(paramVals)) updateRep(n, { val: v })
  analyzeValTypes(body)
  analyzeIntCertain(body)
  return new Proxy({}, { get: (_, name) => repOf(name)?.intCertain === true })
}

test('intCertain: integer literal init', () => {
  const r = runAnalyze('let f = () => { let i = 0; let j = 1.5 }')
  is(r.i, true); is(r.j, false)
})

test('intCertain: bitwise / comparison results are int', () => {
  const r = runAnalyze('let f = () => { let x = 5 | 0; let y = 3 & 1; let z = 1 < 2 }')
  is(r.x, true); is(r.y, true); is(r.z, true)
})

test('intCertain: closure under +,-,*,% with int operands', () => {
  const r = runAnalyze('let f = () => { let i = 5; let j = i * 2 + 1; let k = i % 3 }')
  is(r.i, true); is(r.j, true); is(r.k, true)
})

test('intCertain: division poisons', () => {
  const r = runAnalyze('let f = () => { let i = 5; let j = i / 2 }')
  is(r.i, true); is(r.j, false)
})

test('intCertain: self-recursive `i = i + 1` stays int (fixpoint)', () => {
  const r = runAnalyze('let f = () => { let i = 0; i = i + 1 }')
  is(r.i, true)
})

test('intCertain: reassignment with non-int RHS poisons', () => {
  const r = runAnalyze('let f = () => { let i = 0; i = 1.5 }')
  is(r.i, false)
})

test('intCertain: poison is sticky across all defs (order-insensitive)', () => {
  const r = runAnalyze('let f = () => { let i = 0; let j = i + 1; i = 1.5 }')
  is(r.i, false); is(r.j, false)
})

test('intCertain: `++` / `--` preserve', () => {
  const r = runAnalyze('let f = () => { let i = 0; i++; let k = 0; k-- }')
  is(r.i, true); is(r.k, true)
})

test('intCertain: compound `+=` / `-=` / `*=` / `%=` preserve', () => {
  const r = runAnalyze('let f = () => { let a = 0; let b = 0; let c = 0; let d = 0; a += 5; b -= 1; c *= 2; d %= 3 }')
  is(r.a, true); is(r.b, true); is(r.c, true); is(r.d, true)
})

test('intCertain: bitwise compounds with non-int init still poison', () => {
  // Even though bitwise compound result is always int, semantics require ALL
  // defs are int. Init 1.5 is non-int → poison.
  const r = runAnalyze('let f = () => { let a = 1.5; let b = 1.5; a &= 7; b <<= 2 }')
  is(r.a, false); is(r.b, false)
})

test('intCertain: bitwise compounds with int init stay int', () => {
  const r = runAnalyze('let f = () => { let a = 1; let b = 1; a &= 7; b <<= 2 }')
  is(r.a, true); is(r.b, true)
})

test('intCertain: `/=` / `**=` poison', () => {
  const r = runAnalyze('let f = () => { let a = 4; let b = 2; a /= 2; b **= 2 }')
  is(r.a, false); is(r.b, false)
})

test('intCertain: ?: / && / || conciliate both branches', () => {
  // z's `c && 1` left-operand `c` is param of unknown val — conservative: not int.
  const r = runAnalyze('let f = (c) => { let x = c ? 1 : 2; let y = c ? 1 : 1.5; let z = c && 1 }')
  is(r.x, true); is(r.y, false); is(r.z, false)
})

test('intCertain: && / || when both operands provably int', () => {
  const r = runAnalyze('let f = () => { let a = 5; let b = 0 || a; let c = 1 && 2 }')
  is(r.a, true); is(r.b, true); is(r.c, true)
})

test('intCertain: Math.{imul, clz32, floor, ceil, round, trunc} are int', () => {
  const r = runAnalyze('let f = () => { let a = Math.imul(3, 4); let b = Math.floor(1.5); let c = Math.clz32(1); let d = Math.round(2.7) }')
  is(r.a, true); is(r.b, true); is(r.c, true); is(r.d, true)
})

test('intCertain: Math.sqrt / Math.sin / Math.cos poison', () => {
  const r = runAnalyze('let f = () => { let a = Math.sqrt(4); let b = Math.sin(1); let c = Math.cos(2) }')
  is(r.a, false); is(r.b, false); is(r.c, false)
})

test('intCertain: .length on TYPED / ARRAY / STRING / BUFFER receiver is int', () => {
  const r1 = runAnalyze('let f = (arr) => { let n = arr.length }', { arr: VAL.TYPED })
  is(r1.n, true)
  const r2 = runAnalyze('let f = (s) => { let n = s.length }', { s: VAL.STRING })
  is(r2.n, true)
})

test('intCertain: .length on unknown receiver does not claim int', () => {
  const r = runAnalyze('let f = (x) => { let n = x.length }')
  is(r.n, false)
})

test('intCertain: transitive — j = i + 1 follows i', () => {
  const r1 = runAnalyze('let f = () => { let i = 5; let j = i + 1; let k = j * 2 }')
  is(r1.i, true); is(r1.j, true); is(r1.k, true)
  const r2 = runAnalyze('let f = () => { let i = 5.5; let j = i + 1 }')
  is(r2.i, false); is(r2.j, false)
})
