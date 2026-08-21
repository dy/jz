// Type coercion (i32/f64), slot-type tracking, typed-array narrowing,
// intCertain lattice
import test from 'tst'
import { is, ok, throws, almost } from 'tst/assert.js'
import { belowOpt, onWasi, onKernel, withBigintStrict } from './_matrix.js'
import { parse } from 'subscript/feature/jessie'
import jz, { compile } from '../index.js'
import { UNDEF_NAN, NULL_NAN } from '../interop.js'
import prepare, { GLOBALS } from '../src/prepare/index.js'
import { ctx, reset } from '../src/ctx.js'
import { targetProfileFor } from '../src/session.js'
import { emit, emitter, emitVoid as flat, emitBlockBody, emitBoolStr as bool, emitIndex as idx, buildArrayWithSpreads as spread, emitIdentitySafe } from '../src/compile/emit.js'
import { analyzeValTypes, analyzeIntCertain, analyzeBody } from '../src/compile/analyze.js'
import { repOf, updateRep, VAL } from '../src/reps.js'
import { T } from '../src/ast.js'
import { hasAmbiguousBoolMerge, censusMaybeUndefinedKind, censusMaybeUndefined, censusShapedNode, nameMayBeUndefinedInBody, exprMayBeUndefinedIn } from '../src/kind.js'
import { closureBodyReturnKind, closureBodyReturnMayBeUndefined } from '../src/compile/flow-types.js'

const coerce = v => v === undefined ? UNDEF_NAN : v === null ? NULL_NAN : v

function run(code, opts) {
  return jz(code, opts).exports
}

// jz()-based — needed by slot/typed-narrow tests that use full host wiring.
const runHost = (code) => jz(code).exports
// Codegen-shape tests inspect jz's pre-watr structure (helper-function names,
// per-local types, runtime dispatch calls). watr's `inlineOnce` + `treeshake`
// dissolve non-exported helpers into their lone caller and erase them, so the
// `(func $mk …)` regex no longer matches. Compile without watr's post-pass to
// inspect what jz actually emits.
const wat = (src) => jz.compile(src, { wat: true, optimize: { watr: false } })
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

test('bitwise: ~~x truncates to int32 (double-xor folded away)', () => {
  const { f } = run('export let f = (x) => ~~x')
  is(f(3.7), 3)
  is(f(-3.7), -3)
  is(f(2147483648), -2147483648)   // wraps mod 2^32, same as `x | 0`
  // The fold is value-identical to the old double-`~`; the WAT just drops 2 xors.
  const wat = compile('export let f = (x) => ~~x', { wat: true })
  is((wat.match(/i32\.xor/g) || []).length, 0)
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
  // Real-boolean carrier: the inner function keeps the cheap 0/1 i32 carrier;
  // the export thunk reboxes to the TRUE_NAN atom so the host decodes `true`.
  is(runHost('export let f = () => true').f(), true)
})

test('constant: false', () => {
  is(runHost('export let f = () => false').f(), false)
})

test('constant: null', () => {
  is(run('export let f = () => null').f(), null)
})

test('constant: NaN', () => {
  ok(isNaN(run('export let f = () => NaN').f()))
})

test('constant: Number.NaN', () => {
  ok(isNaN(run('export let f = () => Number.NaN').f()))
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
  // Literal `typeof true` folds to 'boolean' in prepare; a runtime boolean is
  // observed via the carrier (`typeof (x>0)` → 'boolean', see test/booleans.js).
  is(jz('export let f = () => typeof true').exports.f(), 'boolean')
})

test('typeof: boolean false (compile-time fold)', () => {
  is(jz('export let f = () => typeof false').exports.f(), 'boolean')
})

test('typeof: comparison still works', () => {
  is(jz('export let f = (x) => typeof x === "number"').exports.f(5), true)
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

// === !! drop in boolean position ===

test('logical: !!x in a condition drops to plain truthiness', () => {
  // `if/while/for/?:` read only truthiness, so `!!e` ≡ `e` — the double-eqz folds out.
  is(run('export let f = (x) => !!x ? 10 : 20').f(0), 20)
  is(run('export let f = (x) => !!x ? 10 : 20').f(5), 10)
  is(run('export let f = (x) => !!!x ? 1 : 0').f(0), 1)   // odd count → single `!`
  const wat = compile('export let f = (x) => !!x ? 10 : 20', { wat: true })
  is((wat.match(/i32\.eqz/g) || []).length, 0)
})

test('logical: !! in value position is preserved (still a 0/1 boolean)', () => {
  // Not a boolean position — `!!x` must still normalize to a stored 0/1.
  const { f } = jz('export let f = (x) => { let b = !!x; return b ? 100 : 200 }', { jzify: true }).exports
  is(f(0), 200)
  is(f(9), 100)
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

test('switch: break stops fall-through', () => {
  const { f } = run(`export let f = (x) => {
    let y = 0
    switch (x) {
      case 1:
        y = 10
        break
      case 2:
        y = 20
        break
      default:
        y = 30
        break
    }
    return y
  }`, { jzify: true })
  is(f(1), 10)
  is(f(2), 20)
  is(f(99), 30)
})

test('switch: jzify strips terminal breaks inside braced cases', () => {
  const { f } = run(`export let f = (x) => {
    let y = 0
    switch (x) {
      case 1: {
        y = 10
        break
      }
      default:
        y = 30
    }
    return y
  }`, { jzify: true })
  is(f(1), 10)
  is(f(2), 30)
})

test('switch: jzify keeps destructured-param function body as statements', () => {
  if (onWasi()) return  // wasi: js-object arg / live JS object passed to wasm
  const { f } = jz(`
    function f(x, { kind }) {
      switch (kind) {
        case "a": return x + 1
        default: return x + 2
      }
    }
    export { f }
  `, { jzify: true }).exports
  is(f(10, { kind: 'a' }), 11)
  is(f(10, { kind: 'b' }), 12)
})

test('switch: jzify lowers nested case breaks', () => {
  const { f } = run(`export let f = (x) => {
    let y = 0
    switch (x) {
      case 1:
        if (y === 0) {
          break
        }
        y = 10
      default:
        y = 20
    }
    return y
  }`, { jzify: true })
  is(f(1), 0)
  is(f(2), 20)
})

// The if/else-if chain the old lowering used could only run one matching body;
// these four pin the capabilities it structurally couldn't express.

test('switch: a breakless case falls through into the next', () => {
  const { f } = run(`export let f = (x) => {
    let y = 0
    switch (x) {
      case 1: y = 1        // no break — falls through
      case 2: y = 2; break
      default: y = 9
    }
    return y
  }`, { jzify: true })
  is(f(1), 2)   // 1 enters at case 1, falls into case 2, then breaks
  is(f(2), 2)
  is(f(3), 9)
})

test('switch: stacked labels share one body', () => {
  const { f } = run(`export let f = (g) => {
    switch (g) {
      case 1:
      case 2: return 10
      default: return 99
    }
  }`, { jzify: true })
  is(f(1), 10)
  is(f(2), 10)
  is(f(3), 99)
})

test('switch: default need not be last', () => {
  const { f } = run(`export let f = (x) => {
    switch (x) {
      case 1: return 10
      default: return 99
      case 2: return 20
    }
  }`, { jzify: true })
  is(f(1), 10)
  is(f(2), 20)
  is(f(3), 99)   // no label matches → default, wherever it sits
})

test('switch: string discriminant matches by value (no temp mis-fold)', () => {
  // String built internally — the local `run` can't marshal a string *argument*
  // (it lands as NaN), but the switch's string `===` matching is what's under test.
  const { f } = run(`export let f = (n) => {
    let s = n === 0 ? "a" : n === 1 ? "b" : "z"
    switch (s) {
      case "a": return 1
      case "b": return 2
      default: return 0
    }
  }`, { jzify: true })
  is(f(0), 1)
  is(f(1), 2)
  is(f(2), 0)
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
  is(getB(), true)
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
// Array-destructure kind preservation — `let [a, b] = [1, BigInt(v)]` used to
// silently drop `b`'s VAL.BIGINT kind while the structurally identical object
// form `let { b } = { b: BigInt(v) }` kept it (ctx.schema.arrayVars, the array
// sibling of ctx.schema.vars, registered in prepare/index.js's decl-destructure
// lowering; read by kind.js valTypeOf's VT['[]']). Direct kind pins read the
// inferred local `val` off the public `compile(src, { inspect: true })` sink —
// same mechanism test/types.js's runAnalyze harness exercises internally.
// ============================================================================

function inspectLocals(src, fnName = 'f') {
  return compile(src, { wat: true, inspect: true }).inspect.functions[fnName]?.locals || {}
}
// BindingId totality renames locals to `name<T>f<id>_<n>` — resolve a test's
// source spelling to the actual key (mirrors runAnalyze's resolveLocal).
function localVal(locals, name) {
  const keys = Object.keys(locals)
  const key = keys.find(k => k === name) ?? keys.find(k => k.startsWith(name + T))
  return locals[key]?.val
}

test('array-destructure kind: BIGINT element survives `let [a, b] = [1, BigInt(v)]`', () => {
  if (onKernel()) return   // kernel: jz.compile routes through the kernel, which never returns `inspect` (see _matrix.js onKernel)
  const locals = inspectLocals('export let f = (v) => { let [a, b] = [1, BigInt(v)]; return b }')
  is(localVal(locals, 'a'), VAL.NUMBER)
  is(localVal(locals, 'b'), VAL.BIGINT)
})

test('array-destructure kind: matches the object form it was asymmetric with', () => {
  if (onKernel()) return
  const arrLocals = inspectLocals('export let f = (v) => { let [a, b] = [1, BigInt(v)]; return b }')
  const objLocals = inspectLocals('export let f = (v) => { let { a, b } = { a: 1, b: BigInt(v) }; return b }')
  is(localVal(arrLocals, 'b'), localVal(objLocals, 'b'))
  is(localVal(arrLocals, 'b'), VAL.BIGINT)
})

test('array-destructure kind: STRING element survives', () => {
  if (onKernel()) return
  const locals = inspectLocals(`export let f = () => { let [a, b] = [1, "hi"]; return b }`)
  is(localVal(locals, 'b'), VAL.STRING)
})

test('array-destructure kind: BOOL element survives', () => {
  if (onKernel()) return
  const locals = inspectLocals('export let f = (v) => { let [a, b] = [1, v > 0]; return b }')
  is(localVal(locals, 'b'), VAL.BOOL)
})

test('array-destructure kind: OBJECT element survives (array-of-object literal)', () => {
  if (onKernel()) return
  const locals = inspectLocals('export let f = (v) => { let [x] = [{ b: BigInt(v) }]; return x.b }')
  is(localVal(locals, 'x'), VAL.OBJECT)
})

test('array-destructure kind: closure element still dispatches correctly (no elimination hazard)', () => {
  // ctx.schema.arrayVars is kind-only (never drives SRoA elimination), so a
  // closure-valued literal element must keep working exactly as before.
  const { f } = run(`
    let inc = (x) => x + 1
    let dbl = (x) => x * 2
    export let f = (n) => { let [g, h] = [inc, dbl]; return g(n) + h(n) }
  `)
  is(f(5), 16)
})

test('array-destructure kind: assignment-form (no `let`) already preserved it — regression pin', () => {
  if (onKernel()) return
  // `[a, b] = [1, BigInt(v)]` goes through prepare's scalarArrayDestruct, a
  // different (already-correct) path — pinned so a future refactor can't
  // regress it while "fixing" the decl form.
  const locals = inspectLocals('export let f = (v) => { let a, b; [a, b] = [1, BigInt(v)]; return b }')
  is(localVal(locals, 'b'), VAL.BIGINT)
})

// BigInt retirement Slice 1 (.work/bigint-retirement-design.md §4): this
// test used to document a KNOWN, ACCEPTED gap — a heterogeneous array
// literal (`[1, BigInt(v)]`, element 0 NUMBER, element 1 an unprovable
// BigInt) passed as a call argument, whose per-index kind param
// destructuring never resolved. That gap is exactly the "collection" flow
// class §4 defines (an array literal carrying a BigInt element into
// storage this program never proves uniform) — under JZ_BIGINT_STRICT (opt-in) a compile-time refusal
// instead of a silently-unresolved kind. STRUCTURALLY IMPOSSIBLE to
// construct the old repro anymore, same class as test/data.js's audit-#11
// P0-1 deletion the design calls out — converted, not deleted, since the
// shape itself (heterogeneous-array-literal call-arg) remains valuable
// negative-space coverage.
test('array-destructure kind: a heterogeneous BigInt-element array literal as a call-arg is a "collection" diagnostic under JZ_BIGINT_STRICT (opt-in) (was: silently-unresolved per-index kind)', () => {
  if (onKernel()) return
  if (onKernel()) return
  const src = `
    let g = ([a, b]) => b
    export let f = (v) => g([1, BigInt(v)])
  `
  throws(() => withBigintStrict(() => compile(src, { wat: true, inspect: true })), /BigInt value at this collection/)
})

test('array-destructure behavior: typeof destructured bigint element is "bigint"', () => {
  const { f } = run('export let f = (v) => { let [a, b] = [1, BigInt(v)]; return typeof b }')
  is(f(3), 'bigint')
})

test('array-destructure behavior: destructured bigint element supports bigint arithmetic', () => {
  const { f } = run('export let f = (v) => { let [a, b] = [1, BigInt(v)]; return b * 2n }')
  is(f(3n), 6n)
})

test('array-destructure behavior: destructured nullable-bigint element keeps kind + nullability', () => {
  const src = `export let f = (v, c) => { let [a, b] = [1, c ? BigInt(v) : null]; return c ? b * 2n : -1n }`
  if (!onKernel()) is(localVal(inspectLocals(src), 'b'), VAL.BIGINT)
  const { f } = run(src)
  is(f(3n, true), 6n)
  is(f(3n, false), -1n)
})

// ============================================================================
// Bare BigInt array-element return (re-audit #6 finding 2): `let a = [1n];
// return a[0]` used to decode as a raw-bit-reinterpreted NUMBER, not the
// BigInt value — the array's own element-kind census (rep.arrayElemValType,
// stamped correctly at emit time by the updateRep loop over
// analyzeBody(body).arrElemValTypes, compile/index.js) was always right; the
// function's RETURN-KIND pre-pass (narrow.js's narrowValResults /
// narrowBoolResults) ran before that whole-program store existed for the
// function under examination, unlike ctx.func.flatObjects (the object-field
// sibling fix). Fixed by installArrElemReps (src/compile/narrow.js), which
// installs the SAME per-function arrElemValTypes slice onto
// ctx.func.localReps for the duration of each pass's own kind resolution —
// direct pin below confirms the underlying census itself (unaffected by the
// narrow-time gap) at the 2^62 boundary, host-JS-authority.
// ============================================================================

test('array-elem kind census: BigInt array literal element carries arrayElemValType BIGINT at the 2^62 boundary', () => {
  if (onKernel()) return   // kernel: inspect never reaches through jz.compile (see array-destructure note above)
  const HI = 4611686018427387903n // 2^62 - 1, host-JS-authority
  const locals = inspectLocals(`export let f = () => { let a = [${HI}n]; return a[0] }`)
  const rep = Object.entries(locals).find(([k]) => k === 'a' || k.startsWith('a' + T))?.[1]
  is(rep?.arrayElemValType, VAL.BIGINT)
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

test('typed-narrow: bimorphic typed-array param specializes, compiles + runs (self-compile regression)', () => {
  // `sum` is called with BOTH Float64Array and Int32Array, so specializeBimorphicTyped clones
  // it once per concrete element ctor. The clone sig was built with a redundant `...func.sig`
  // spread (`{ ...func.sig, params, results }`) — and spreading an object then overriding its
  // keys in the same literal corrupts the result's object schema in the self-compile kernel, so a
  // later `sig.params` read faults out of bounds (memory access out of bounds) at -O0. This pins
  // that bimorphic-typed specialization compiles AND runs through the jz.wasm kernel (test:wasm),
  // not just the JS host (the poly bench was the original repro).
  const { main } = runHost(`
    let sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }
    export let main = () => {
      let f = new Float64Array([1.5, 2.5, 3.0])
      let g = new Int32Array([10, 20, 30])
      return sum(f) + sum(g)
    }
  `)
  is(main(), 67)   // (1.5 + 2.5 + 3.0) + (10 + 20 + 30)
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

test('typed-narrow: Uint32Array integer reads are i32, not round-tripped through f64', () => {
  // Deopt fix: a packed-pixel fade `p = px[i]; … p & 0xff …` over a Uint32Array must read
  // i32.load directly — NOT i32.load → f64.convert_i32_u → trunc_sat back (with a dead ToInt32
  // Infinity guard). That round-trip made lorenz's O(W·H) fade loop lose to V8 (0.66×→1.35×
  // once removed). Uint32 elements are 32-bit ints (elemAux 5); a binding used integrally stays
  // i32. (Float32/Float64, aux 6/7, still yield f64 — guarded by the `(aux & 7) <= 5` bound.)
  const body = fnBody(wat(`
    let px = new Uint32Array(64)
    export let fade = () => { let i = 0; while (i < 64) { let p = px[i]; px[i] = ((p & 0xff) * 249) >> 8; i++ } }
  `), 'fade')
  ok(body, '$fade present in WAT')
  ok(!/f64\.convert_i32_u/.test(body), 'Uint32 read used bitwise must stay i32 (no widen to f64)')
  ok(!/f64\.const Infinity/.test(body), 'no dead ToInt32 Infinity guard on a provably-i32 value')
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
  if (belowOpt(2)) return  // size pin: needs post-watr fusedRewrite (optimize >= 2)
  if (onKernel()) return   // kernel: jz.compile uses the optimize:false byte leg, so the byte count can't meet an opt-2 size pin (same as the other byte-leg size pins)
  // Threshold tracks recorded baseline with headroom.
  const src = `
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => { let a = mk(); return a[i] }
  `
  // 900→930: the index param `i` rides the i64 boundary carrier (its numericity isn't proven
  // before `a`'s typed-ness is known), so `f` gets a boundary thunk + a jz:i64exp section —
  // metadata, zero runtime cost. Headroom kept for the narrowing/fusedRewrite regression guard.
  const bytes = jz.compile(src).length
  ok(bytes <= 930, `typed helper probe ${bytes}b — narrowing or fusedRewrite likely regressed (>930b)`)
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
  // unboxablePtrs.isFreshInit accepts `arr.map(fn)` shape when arr is in
  // ctx.func.typedElem (locally TYPED with known elem ctor).
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
      return b[i] + b[0]
    }
  `)
  const body = fnBody(w, 'f')
  ok(body, '$f present')
  // multi-use receiver so the local survives foldSetToTee — exercises the unbox decision on the surviving slot
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
  reset(emitter, GLOBALS, { emit, flat, body: emitBlockBody, bool, idx, spread, emitIdentitySafe })
  // reset() alone (unlike beginSession) leaves targetProfile at its null default —
  // modules the analyzer pulls in (e.g. module/math.js) read it unconditionally.
  ctx.transform.targetProfile = targetProfileFor(ctx.transform.host)
  prepare(parse(code))
  const fn = ctx.funcs.list.find(f => !f.raw && !f.exported && f.body && Array.isArray(f.body))
    || ctx.funcs.list[0]
  const body = fn.body
  ctx.func.locals = analyzeBody(body).locals
  // BindingId totality renames locals/params to `name<T>f<id>_<n>` — resolve a
  // test's source spelling to the actual binding key (unique bare prefix).
  const keys = () => [...(ctx.func.locals?.keys() ?? []), ...(fn.sig?.params?.map(p => p.name) ?? []), ...(ctx.func.localReps?.keys() ?? [])]
  const resolveLocal = (name) => keys().find(k => k === name) ?? keys().find(k => k.startsWith(name + T)) ?? name
  if (paramVals) for (const [n, v] of Object.entries(paramVals)) updateRep(resolveLocal(n), { val: v })
  analyzeValTypes(body)
  analyzeIntCertain(body)
  return new Proxy({}, { get: (_, name) => repOf(resolveLocal(name))?.intCertain === true })
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

// ============================================================================
// mayBeUndefined REP field — pure analysis, no codegen impact YET
// (.work/todo.md §deletion-sweep Slice 1). Honest boundary,
// stated up front so a future reader doesn't mistake this for a black-box
// regression suite: VT['[]']/VT['.']/VT['()'] (dictValueKindOf/mapValueKindOf's
// OWN exact-kind fold) stay DORMANT until design §8 Slice 4 — every existing
// censusMaybeUndefined chokepoint (ir.js toNumF64/toStrI64, emit.js
// nullableOperand/bigIntOperand/bigIntUnary, module/string.js/number.js/
// console.js) gates ITS OWN call to censusMaybeUndefined behind
// `valTypeOf(node) === VAL.SOMETHING` first, and `valTypeOf` for a dict/Map
// read stays null while that VT fold is dormant — so this slice cannot yet
// change a single compiled byte or a single JS-observable return value
// (verified: test/dyn-keys.js's audit-#9 repro table asserts identical
// values before and after this slice). What DOES change, and what this
// section pins: `analyzeValTypes` (analyze.js) now derives `mayBeUndefined`
// on a decl'd/reassigned local exactly the way it already derives `nullable`
// (same call site, `mayBeNullish` sibling), and `censusMaybeUndefinedKind`
// (kind.js) now answers a bare NAME carrying that flag, not just the
// original read node — the exact machinery Slice 4 needs already in place,
// so re-enabling the VT fold then doesn't have to reinvent decl propagation
// under time pressure the way audit #9 found it missing. Mirrors this file's
// own intCertain-lattice precedent above ("pure analysis, no codegen impact.
// Pins the forward-propagation rule against AST inputs").
// ============================================================================
// `dynWriteVarNames` mirrors `runAnalyze`'s `paramVals` pre-seed: the real
// pipeline populates `ctx.types.dynWriteVars` whole-program (plan/index.js,
// program-facts.js), which this per-function-only harness never runs — a
// bare `const d = {}; d[k] = v` decl needs it to even classify `d` as
// HASH dict-mode (analyze.js's own `dict` check) before dictValueKindOf has
// anything to read. Seeded AFTER `ctx.func.locals` resolves binding names
// (BindingId totality) so plain source spellings translate correctly.
function runAnalyzeMayBeUndefined(code, dynWriteVarNames) {
  reset(emitter, GLOBALS, { emit, flat, body: emitBlockBody, bool, idx, spread, emitIdentitySafe })
  ctx.transform.targetProfile = targetProfileFor(ctx.transform.host)
  prepare(parse(code))
  const fn = ctx.funcs.list.find(f => !f.raw && !f.exported && f.body && Array.isArray(f.body))
    || ctx.funcs.list[0]
  const body = fn.body
  ctx.func.locals = analyzeBody(body).locals
  const keys = () => [...(ctx.func.locals?.keys() ?? []), ...(fn.sig?.params?.map(p => p.name) ?? []), ...(ctx.func.localReps?.keys() ?? [])]
  const resolveLocal = (name) => keys().find(k => k === name) ?? keys().find(k => k.startsWith(name + T)) ?? name
  if (dynWriteVarNames) ctx.types.dynWriteVars = new Set(dynWriteVarNames.map(resolveLocal))
  analyzeValTypes(body)
  return new Proxy({}, { get: (_, name) => repOf(resolveLocal(name))?.mayBeUndefined === true })
}

test('mayBeUndefined: decl RHS is a direct Map .get() census read (inline-read arm)', () => {
  const r = runAnalyzeMayBeUndefined(`let f = () => {
    const m = new Map(); m.set('a', 1)
    let x = m.get('missing')
  }`)
  is(r.x, true)
})

test('mayBeUndefined: decl RHS is a direct dict [] census read (inline-read arm)', () => {
  const r = runAnalyzeMayBeUndefined(`let f = () => {
    const d = {}; const wk = 'a'; d[wk] = 1
    let x = d['zz']
  }`, ['d'])
  is(r.x, true)
})

test('mayBeUndefined: reassignment (not just decl) carries the same inline-read arm', () => {
  const r = runAnalyzeMayBeUndefined(`let f = () => {
    const m = new Map(); m.set('a', 1)
    let x
    x = m.get('missing')
  }`)
  is(r.x, true)
})

test('mayBeUndefined: copies through a bare-name alias (REP fallback arm, one hop away)', () => {
  const r = runAnalyzeMayBeUndefined(`let f = () => {
    const m = new Map(); m.set('a', 1)
    let x = m.get('missing')
    let y = x
  }`)
  is(r.x, true); is(r.y, true)
})

test('mayBeUndefined: ordinary decl (no census-shaped RHS) never sets the flag', () => {
  const r = runAnalyzeMayBeUndefined(`let f = () => {
    let x = 5
    let y = x + 1
  }`)
  is(r.x, false); is(r.y, false)
})

test('mayBeUndefined: a Map with no observed .set() write claims nothing to propagate', () => {
  // No census fact recorded for `m` at all (never written) — mapValueKindOf's
  // own `local` lookup returns undefined, so the inline-read arm can't fire.
  const r = runAnalyzeMayBeUndefined(`let f = () => {
    const m = new Map()
    let x = m.get('missing')
  }`)
  is(r.x, false)
})

test('censusMaybeUndefinedKind: bare-name REP fallback answers only when BOTH mayBeUndefined and presentVal are set', () => {
  reset(emitter, GLOBALS, { emit, flat, body: emitBlockBody, bool, idx, spread, emitIdentitySafe })
  ctx.transform.targetProfile = targetProfileFor(ctx.transform.host)
  prepare(parse('let f = () => 0'))
  updateRep('probeBoth', { presentVal: VAL.NUMBER, mayBeUndefined: true })
  is(censusMaybeUndefinedKind('probeBoth'), VAL.NUMBER)
  is(censusMaybeUndefined('probeBoth'), true)
  updateRep('probePresentValOnly', { presentVal: VAL.NUMBER })
  is(censusMaybeUndefinedKind('probePresentValOnly'), null, 'presentVal without the flag must not be treated as maybeUndefined')
  updateRep('probeFlagOnly', { mayBeUndefined: true })
  is(censusMaybeUndefinedKind('probeFlagOnly'), null, 'the flag alone (no presentVal/val) has nothing to claim')
  // `val` is a DELIBERATE, KEPT fallback (§15) for exactly the param shape —
  // a param's `val` comes from narrow.js's own call-site-argument fixpoint,
  // entirely independent of census provenance, so it can be legitimately
  // non-null alongside `mayBeUndefined` with no `presentVal` ever set
  // (params get no presentVal producer in this slice). See kind.js's own
  // doc comment ("found LIVE... a param-hop regression pin flipped").
  updateRep('probeValFallback', { val: VAL.STRING, mayBeUndefined: true })
  is(censusMaybeUndefinedKind('probeValFallback'), VAL.STRING, '`val` is consulted as a fallback when presentVal is absent')
  // presentVal takes PRIORITY over val when both happen to be set.
  updateRep('probeBothPresentAndVal', { val: VAL.STRING, presentVal: VAL.BIGINT, mayBeUndefined: true })
  is(censusMaybeUndefinedKind('probeBothPresentAndVal'), VAL.BIGINT, 'presentVal wins over val when both are set')
})

// ============================================================================
// presentVal REP field — §14 Slice 6 ("begin the presentVal opt-in model"),
// audit-#10's re-enablement gate superseding §5's global-VT-promotion path.
// Pure analysis, mirroring mayBeUndefined's own Slice-1 precedent above:
// pins that the FACT computes/propagates/poisons correctly as its own
// isolated unit. `presentVal` differs from `mayBeUndefined` in one load-
// bearing way this section exists to pin — it is an exact KIND claim, not a
// monotonic boolean, so it must POISON (not merely stay true) the moment any
// write to the same binding disagrees, exactly like `val` itself already
// does (reps.js `presentVal` doc comment, analyze.js `setPresentVal`).
// ============================================================================
function runAnalyzePresentVal(code, dynWriteVarNames) {
  reset(emitter, GLOBALS, { emit, flat, body: emitBlockBody, bool, idx, spread, emitIdentitySafe })
  ctx.transform.targetProfile = targetProfileFor(ctx.transform.host)
  prepare(parse(code))
  const fn = ctx.funcs.list.find(f => !f.raw && !f.exported && f.body && Array.isArray(f.body))
    || ctx.funcs.list[0]
  const body = fn.body
  ctx.func.locals = analyzeBody(body).locals
  const keys = () => [...(ctx.func.locals?.keys() ?? []), ...(fn.sig?.params?.map(p => p.name) ?? []), ...(ctx.func.localReps?.keys() ?? [])]
  const resolveLocal = (name) => keys().find(k => k === name) ?? keys().find(k => k.startsWith(name + T)) ?? name
  if (dynWriteVarNames) ctx.types.dynWriteVars = new Set(dynWriteVarNames.map(resolveLocal))
  analyzeValTypes(body)
  return new Proxy({}, { get: (_, name) => repOf(resolveLocal(name))?.presentVal ?? null })
}

test('presentVal: decl RHS is a direct Map .get() census read claims the census kind', () => {
  const r = runAnalyzePresentVal(`let f = () => {
    const m = new Map(); m.set('a', 5n)
    let x = m.get('missing')
  }`)
  is(r.x, VAL.BIGINT)
})

test('presentVal: decl RHS is a direct dict [] census read claims the census kind', () => {
  const r = runAnalyzePresentVal(`let f = () => {
    const d = {}; const wk = 'a'; d[wk] = 'str'
    let x = d['zz']
  }`, ['d'])
  is(r.x, VAL.STRING)
})

test('presentVal: copies through a bare-name alias (one hop), matching mayBeUndefined\'s own copy-through arm', () => {
  const r = runAnalyzePresentVal(`let f = () => {
    const m = new Map(); m.set('a', 5n)
    let x = m.get('missing')
    let y = x
  }`)
  is(r.x, VAL.BIGINT); is(r.y, VAL.BIGINT)
})

test('presentVal: ordinary decl (no census-shaped RHS) never sets it', () => {
  const r = runAnalyzePresentVal(`let f = () => {
    let x = 5
    let y = x + 1
  }`)
  is(r.x, null); is(r.y, null)
})

test('presentVal: a later reassignment to a DIFFERENT census kind poisons (disagreement, like val itself)', () => {
  const r = runAnalyzePresentVal(`let f = () => {
    const m = new Map(); m.set('a', 5n); m.set('b', 'str')
    let x = m.get('a')
    x = m.get('b')
  }`)
  is(r.x, null, 'mapValueValType itself already poisons on mixed writes (dictValueKindOf/mapValueKindOf soundness carve-out) — presentVal must not resurrect a stale single kind')
})

test('presentVal: a later reassignment to an ORDINARY (non-census) value poisons — flow-insensitive, matching val\'s own documented cost', () => {
  const r = runAnalyzePresentVal(`let f = () => {
    const m = new Map(); m.set('a', 5n)
    let x = m.get('missing')
    x = 5
  }`)
  is(r.x, null, 'x is unconditionally overwritten by a plain literal here, but presentVal has no CFG/dominance info either, same accepted cost as val')
})

test('presentVal: an ordinary decl later reassigned to a census read stays unset — the SAME flow-insensitive cost in the other direction', () => {
  const r = runAnalyzePresentVal(`let f = () => {
    const m = new Map(); m.set('a', 5n)
    let x = 5
    x = m.get('missing')
  }`)
  is(r.x, null, 'the ordinary decl write already poisoned x — a later census-shaped write cannot un-poison it, mirroring val\'s own "no un-poisoning" rule')
})

test('presentVal and val are mutually exclusive by construction — never both non-null for the same binding', () => {
  const r1 = runAnalyzePresentVal(`let f = () => { let x = 5 }`)
  is(r1.x, null)
  const r2 = runAnalyzePresentVal(`let f = () => {
    const m = new Map(); m.set('a', 5n)
    let x = m.get('missing')
  }`)
  is(r2.x, VAL.BIGINT)
})

// ============================================================================
// mayBeUndefined Slice 2 — whole-program propagation (param/return/closure)
// (.work/todo.md §deletion-sweep §3 remaining, §8 Slice 2).
// Same honest-boundary framing as Slice 1 above: every consumer still gates
// behind `valTypeOf(node) === VAL.SOMETHING` first, and `valTypeOf` for a
// name/argument/return that traces to a census-shaped read stays null at
// EVERY hop (decl, param, return) as long as VT['[]']/VT['.']/VT['()'] stay
// dormant — a program-wide invariant, not slice-specific, so this section
// pins the MECHANISM the same pure-analysis way Slice 1 did.
// ============================================================================

// --- shared structural predicates (kind.js) ---

test('censusShapedNode: recognizes dict [] / . reads and Map .get() calls; rejects everything else', () => {
  is(censusShapedNode(['[]', 'd', 'k']), true)
  is(censusShapedNode(['.', 'd', 'prop']), true)
  is(censusShapedNode(['()', ['.', 'm', 'get'], 'k']), true)
  is(censusShapedNode(['()', ['.', 'm', 'set'], 'k']), false, '.set() is not a read')
  is(censusShapedNode(['+', 1, 2]), false)
  is(censusShapedNode('bareName'), false)
  is(censusShapedNode(5), false)
  is(censusShapedNode(null), false)
})

test('nameMayBeUndefinedInBody: traces a decl RHS through censusShapedNode', () => {
  const body = ['{}', [';',
    ['let', ['=', 'x', ['()', ['.', 'm', 'get'], ['str', 'missing']]]],
    ['let', ['=', 'y', ['+', 'x', 1]]],
  ]]
  is(nameMayBeUndefinedInBody(body, 'x'), true)
  is(nameMayBeUndefinedInBody(body, 'y'), false, 'y is never itself census-shaped nor a bare-name copy')
})

test('nameMayBeUndefinedInBody: copy-through a bare-name alias', () => {
  const body = ['{}', [';',
    ['let', ['=', 'x', ['[]', 'd', ['str', 'k']]]],
    ['let', ['=', 'y', 'x']],
  ]]
  is(nameMayBeUndefinedInBody(body, 'y'), true)
})

test('nameMayBeUndefinedInBody: unwritten name resolves false (narrower than nullable\'s blanket fail-closed)', () => {
  const body = ['{}', [';', ['let', ['=', 'y', ['+', 'z', 1]]]]]
  is(nameMayBeUndefinedInBody(body, 'z'), false, 'z is never written in this body — no evidence, not "assume worst"')
})

test('nameMayBeUndefinedInBody: cyclic self-reference does not stack-overflow', () => {
  // `x = x` structurally (a degenerate alias cycle) — the `seen` guard must
  // stop recursion, not just avoid infinite loops in production shapes.
  const body = ['{}', [';', ['let', ['=', 'x', 'x']]]]
  is(nameMayBeUndefinedInBody(body, 'x'), false)
})

test('nameMayBeUndefinedInBody: a non-array bodyRoot (expression-bodied arrow) resolves false, not a crash', () => {
  // WeakMap requires an object key — `() => x` lowers to a bare-name body in
  // some arrow shapes (regression: this threw "Invalid value used as weak
  // map key" before the Array.isArray guard).
  is(nameMayBeUndefinedInBody('x', 'x'), false)
  is(exprMayBeUndefinedIn('x', 'x'), false)
})

test('exprMayBeUndefinedIn: direct census shape OR bare-name trace, nothing else', () => {
  const body = ['{}', [';', ['let', ['=', 'x', ['[]', 'd', ['str', 'k']]]]]]
  is(exprMayBeUndefinedIn(['[]', 'd', ['str', 'k']], body), true, 'direct shape needs no body trace')
  is(exprMayBeUndefinedIn('x', body), true, 'bare name traces through the body')
  is(exprMayBeUndefinedIn(['+', 1, 2], body), false)
})

// --- param propagation (narrow.js narrowSignatures, whole-program fixpoint) ---

test('mayBeUndefined param: a call-site arg tracing to a census read flags the callee param', () => {
  if (onKernel()) return   // kernel: jz.compile routes through the kernel, which never returns `inspect`
  // sourceInline:false — useIt's trivial pass-through body is an inlining
  // candidate; inlined away, there is no separate function left to narrow.
  const insp = compile(`
    const useIt = (x) => x
    export let f = () => {
      const m = new Map(); m.set('a', 1)
      let y = m.get('missing')
      return useIt(y)
    }
  `, { wat: true, inspect: true, optimize: { sourceInline: false } }).inspect
  is(insp.functions.useIt.params[0].mayBeUndefined, true)
  // programFacts.paramReps' own verdict — visible even ahead of the compile/
  // index.js seed into ctx.func.localReps (reps.js callerReps channel).
  is(insp.functions.useIt.callerReps[0].mayBeUndefined, true)
})

test('mayBeUndefined param: an ordinary (non-census) forwarded arg never sets the flag', () => {
  if (onKernel()) return
  const insp = compile(`
    const useIt = (x) => x
    export let f = (n) => useIt(n + 1)
  `, { wat: true, inspect: true, optimize: { sourceInline: false } }).inspect
  is(insp.functions.useIt.params[0].mayBeUndefined, undefined)
})

test('mayBeUndefined param: a directly census-shaped call-site arg (no intermediate local) also flags it', () => {
  if (onKernel()) return
  const insp = compile(`
    const useIt = (x) => x
    export let f = () => {
      const m = new Map(); m.set('a', 1)
      return useIt(m.get('missing'))
    }
  `, { wat: true, inspect: true, optimize: { sourceInline: false } }).inspect
  is(insp.functions.useIt.params[0].mayBeUndefined, true)
})

// --- return-kind propagation (flow-types.js closureBodyReturnKind sibling) ---

// Direct unit harness: closureBodyReturnKind/closureBodyReturnMayBeUndefined
// are pure `(body, capturedKinds)` functions (module/function.js's ctx.closure.
// make calls them at closure-CREATION time) — testable without a full compile,
// mirroring runAnalyzeMayBeUndefined's prepare(parse(code)) precedent above.
function getFirstBody(code) {
  reset(emitter, GLOBALS, { emit, flat, body: emitBlockBody, bool, idx, spread, emitIdentitySafe })
  ctx.transform.targetProfile = targetProfileFor(ctx.transform.host)
  prepare(parse(code))
  const fn = ctx.funcs.list.find(f => !f.raw && !f.exported && f.body && Array.isArray(f.body)) || ctx.funcs.list[0]
  return fn.body
}

test('closureBodyReturnMayBeUndefined: a return whose local decl traces to a census read', () => {
  const body = getFirstBody(`let f = () => {
    const m = new Map(); m.set('a', 1)
    let x = m.get('missing')
    return x
  }`)
  is(closureBodyReturnMayBeUndefined(body, new Map()), true)
})

test('closureBodyReturnMayBeUndefined: ordinary body never flags it (negative control)', () => {
  const body = getFirstBody(`let f = () => {
    let x = 5
    return x
  }`)
  is(closureBodyReturnMayBeUndefined(body, new Map()), false)
})

test('closureBodyReturnMayBeUndefined: independent of closureBodyReturnKind\'s own kind resolution', () => {
  // The two facts are DELIBERATELY separate functions (closureBodyReturnKind's
  // return shape has a live consumer, kind-traits.js calleeValType, this
  // design must not disturb) — prove they can disagree: capturedKinds lets
  // valTypeOfWithLocals resolve `x` to a definite kind from OUTSIDE the body
  // (as a real capture would), while the body's OWN local decl still traces
  // to a census read, independently of that external kind proof.
  const body = getFirstBody(`let f = () => {
    const m = new Map(); m.set('a', 1)
    let x = m.get('missing')
    return x
  }`)
  // BindingId totality renames locals (mirrors resolveLocal above) — walk the
  // body's own strings for the resolved spelling instead of assuming `x`.
  const names = new Set()
  const collect = (n) => { if (typeof n === 'string') names.add(n); else if (Array.isArray(n)) n.forEach(collect) }
  collect(body)
  const xName = [...names].find(n => n === 'x') ?? [...names].find(n => n.startsWith('x' + T))
  is(closureBodyReturnKind(body, new Map([[xName, VAL.NUMBER]])), VAL.NUMBER)
  is(closureBodyReturnMayBeUndefined(body, new Map([[xName, VAL.NUMBER]])), true)
})

// --- closure captures (module/function.js ctx.closure.make) ---

test('mayBeUndefined closure capture: a flagged outer binding seeds the closure body record', () => {
  if (onKernel()) return   // kernel: this process's ctx never sees the kernel's own compile
  compile(`
    export let f = (v) => {
      const m = new Map(); m.set('a', 1)
      let x = m.get('missing')
      let g = () => x
      return g()
    }
  `, { wat: true, optimize: { sourceInline: false } })
  const cb = ctx.closure.bodies.find(b => b.captures?.some(c => c.startsWith('x')))
  ok(cb, 'expected a closure body capturing x')
  const xName = cb.captures.find(c => c.startsWith('x'))
  ok(cb.mayBeUndefineds?.has(xName), 'captured x should carry mayBeUndefined into the closure body')
})

test('mayBeUndefined closure capture: an ordinary captured binding is not flagged (negative control)', () => {
  if (onKernel()) return
  // `x = v + 5` (not a bare literal) so it survives as a real capture instead
  // of const-folding away before ctx.closure.make ever sees it.
  compile(`
    export let f = (v) => {
      let x = v + 5
      let g = () => x
      return g()
    }
  `, { wat: true, optimize: { sourceInline: false } })
  const cb = ctx.closure.bodies.find(b => b.captures?.some(c => c.startsWith('x')))
  ok(cb, 'expected a closure body capturing x')
  is(cb.mayBeUndefineds, undefined)
})

// --- narrowValResults' own OR-join: honest boundary ---
// Unlike closureBodyReturnMayBeUndefined (independently resolvable via an
// externally-injected capturedKinds map, proven live just above),
// narrowValResults' `vt0`/`allSame` fold and the mayBeUndefined trace both
// read the SAME body evidence for a bare-name return (bodyFacts.valTypes vs.
// exprMayBeUndefinedIn's own raw-AST walk) — empirically, whenever a return
// site traces to a census-shaped write, bodyFacts.valTypes ALSO fails to
// settle a kind for that same name (the identical "unresolved write poisons"
// behavior Slice 1's own decl producer already documented), so `vt0`/
// `allSame` never holds at the same time a live mayBeUndefined trace would
// apply — no black-box positive repro exists for this ONE join site the way
// it does for the param and closure-capture joins above. The mechanism
// itself (the `exprs.some(e => exprMayBeUndefinedIn(e, body))` OR-fold) is
// still landed and correct — pinned here as a negative control so a future
// change to bodyFacts.valTypes' settling rule that DOES make this live
// doesn't silently ship unpinned.
test('mayBeUndefined valResult: an ordinary settled return never sets valResultMayBeUndefined', () => {
  if (onKernel()) return
  const insp = compile(`
    const useIt = (x) => x.length
    export let f = () => useIt([1, 2, 3])
  `, { wat: true, inspect: true, optimize: { sourceInline: false } }).inspect
  ok(insp.functions.useIt, 'expected useIt to survive as a separate function')
  is(insp.functions.useIt.valResultMayBeUndefined, undefined)
})

// === untyped-receiver number methods (the kernel-L2 data-corruption root) ===
// `x.toString(16)` / `x.toFixed(d)` where x's static kind is erased (polymorphic
// slot, mixed-element array) used to fall through every dispatch strategy to a
// dynamic property lookup → `undefined`. Inside the self-compile kernel that turned
// encodeDataString's `'\\' + b.toString(16).padStart(2,'0')` into `\00` for every
// escaped byte, zeroing the emitted data segment of cell+capture+static-array
// programs. The runtime-string-fork number arm + tryRuntimeNumberMethod now
// dispatch `.number:*` emitters off a runtime number check.

test('untyped receiver: toString(radix) dispatches the number emitter', () => {
  const { f } = runHost(`
    let mk = (x) => ({ v: x })
    export let f = () => {
      let a = mk(240)
      let b = mk('s')
      return a.v.toString(16)
    }`)
  is(f(), 'f0')
})

test('untyped receiver: toFixed dispatches the number emitter', () => {
  const { f } = runHost(`
    let mk = (x) => ({ v: x })
    export let f = () => {
      let a = mk(2.5)
      let b = mk('s')
      return a.v.toFixed(1)
    }`)
  is(f(), '2.5')
})

test('untyped receiver: string toString(radix) ignores the radix (JS semantics)', () => {
  const { f } = runHost(`
    let mk = (x) => ({ v: x })
    export let f = () => {
      let a = mk('abc')
      let b = mk(1)
      return a.v.toString()
    }`)
  is(f(), 'abc')
})

test('untyped receiver: own-property toFixed closure shadows the builtin', () => {
  const { f } = runHost(`
    let mk = (x) => ({ v: x })
    export let f = () => {
      let o = mk(7)
      let p = mk('s')
      o.toFixed = (d) => 'custom'
      return o.toFixed(1)
    }`)
  is(f(), 'custom')
})

// ============================================================================
// hasAmbiguousBoolMerge — pure structural predicate (.work/todo.md
// §deletion-sweep), mirroring kind.js VT['?:']/VT['&&']/['||']/['??']'s own truth
// table branch-for-branch. No ctx/reset() needed: every case below is a
// literal AST shape or a bare-name cond whose literalTruthiness is unresolved
// (`valTypeOf`/`lookupValType` degrade to null without a live ctx.func, which
// is exactly the "no claim" case both VT and the predicate already handle).
// ============================================================================

// AST node shorthands mirroring parser output: bigint/string literals are
// self-describing op-tagged nodes (kind.js VT.bigint / VT.strcat); a bare
// numeric/boolean primitive is its own AST leaf (kind.js valTypeOf's op==null
// fast path); 's'/'t' are unresolved bare names (no literalTruthiness, no
// lookupValType fact — the "condition/operand unknown" case).
const bigint5 = ['bigint', '5']
const str_ = ['str', 'x']
const undef = []

test('hasAmbiguousBoolMerge ?: — BOOL-then/NUMBER-else fires (the s?1:false shape, arms swapped)', () => {
  ok(hasAmbiguousBoolMerge(['?:', 's', false, 1]))
})

test('hasAmbiguousBoolMerge ?: — NUMBER-then/BOOL-else fires (s?1:false itself)', () => {
  ok(hasAmbiguousBoolMerge(['?:', 's', 1, false]))
})

test('hasAmbiguousBoolMerge ?: — both-BOOL arms: sound, does not fire', () => {
  ok(!hasAmbiguousBoolMerge(['?:', 's', true, false]))
})

test('hasAmbiguousBoolMerge ?: — both-NUMBER arms: sound, does not fire', () => {
  ok(!hasAmbiguousBoolMerge(['?:', 's', 1, 2]))
})

test('hasAmbiguousBoolMerge ?: — BOOL vs STRING (opaque, not NUMBER): already boxed elsewhere, not this predicate\'s trigger', () => {
  ok(!hasAmbiguousBoolMerge(['?:', 's', str_, false]))
})

test('hasAmbiguousBoolMerge ?: — BIGINT + nullish-literal carve-out stays excluded', () => {
  ok(!hasAmbiguousBoolMerge(['?:', 's', bigint5, undef]))
})

test('hasAmbiguousBoolMerge ?: — literally-resolved (truthy) condition recurses into the live arm only', () => {
  // cond=true → VT['?:'] resolves valTypeOf(thenArm) alone (line 143-144); the
  // else arm (never live) must not spuriously trigger the predicate.
  ok(!hasAmbiguousBoolMerge(['?:', true, false, 1]))
  ok(hasAmbiguousBoolMerge(['?:', true, ['?:', 't', false, 1], 2]))
})

test('hasAmbiguousBoolMerge ?: — literally-resolved (falsy) condition recurses into the live (else) arm', () => {
  ok(hasAmbiguousBoolMerge(['?:', false, 2, ['?:', 't', false, 1]]))
})

test('hasAmbiguousBoolMerge ?: — recursive through nested merges: a same-kind (NUMBER) collapse inherits a nested arm\'s ambiguity', () => {
  ok(hasAmbiguousBoolMerge(['?:', 's', ['?:', 't', false, 1], 2]))
})

test('hasAmbiguousBoolMerge ?: — same-kind collapse of two NON-ambiguous merges stays sound', () => {
  ok(!hasAmbiguousBoolMerge(['?:', 's', ['?:', 't', 1, 2], 3]))
})

test('hasAmbiguousBoolMerge && — BOOL guard beside a NUMBER value fires (the (x>0)&&1 live-bug shape)', () => {
  ok(hasAmbiguousBoolMerge(['&&', ['>', 'x', 0], 1]))
})

test('hasAmbiguousBoolMerge && — BOOL guard beside a STRING value: opaque, not this predicate\'s trigger', () => {
  ok(!hasAmbiguousBoolMerge(['&&', ['>', 'x', 0], str_]))
})

test('hasAmbiguousBoolMerge || — NUMBER-then-BOOL fires symmetrically', () => {
  ok(hasAmbiguousBoolMerge(['||', 1, false]))
})

test('hasAmbiguousBoolMerge ?? — both-NUMBER: sound, does not fire', () => {
  ok(!hasAmbiguousBoolMerge(['??', 1, 2]))
})

test('hasAmbiguousBoolMerge — non-merge nodes and non-array leaves never fire', () => {
  ok(!hasAmbiguousBoolMerge(['+', 1, 2]))
  ok(!hasAmbiguousBoolMerge('s'))
  ok(!hasAmbiguousBoolMerge(1))
  ok(!hasAmbiguousBoolMerge(false))
  ok(!hasAmbiguousBoolMerge(null))
})
