// Type coercion: i32/f64 by operator, bitwise ops, named constants
import test from 'tst'
import { is, ok, throws, almost } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { UNDEF_NAN, NULL_NAN } from '../src/host.js'

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
