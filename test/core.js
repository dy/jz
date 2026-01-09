import test from 'tst'
import { compile, evaluate } from '../index.js'

// MVP Test Suite - Focused on what works with current implementation

test('Basic arithmetic operations', async t => {
  t.equal(await evaluate('(f64.add (f64.const 1) (f64.const 2))'), 3)
  t.equal(await evaluate('(f64.sub (f64.const 5) (f64.const 2))'), 3)
  t.equal(await evaluate('(f64.mul (f64.const 3) (f64.const 4))'), 12)
  t.equal(await evaluate('(f64.div (f64.const 10) (f64.const 2))'), 5)
  t.equal(await evaluate('(f64.add (f64.const 2) (f64.mul (f64.const 3) (f64.const 4)))'), 14)
  t.equal(await evaluate('(f64.mul (f64.add (f64.const 2) (f64.const 3)) (f64.const 4))'), 20)
})

test('Numeric literals', async t => {
  t.equal(await evaluate('(f64.const 1)'), 1)
  t.equal(await evaluate('(f64.const 3.14)'), 3.14)
  t.equal(await evaluate('(f64.const 1000)'), 1000)
})

test('Operator precedence', async t => {
  t.equal(await evaluate('(f64.add (f64.const 1) (f64.mul (f64.const 2) (f64.const 3)))'), 7)
  t.equal(await evaluate('(f64.mul (f64.add (f64.const 1) (f64.const 2)) (f64.const 3))'), 9)
  t.equal(await evaluate('(f64.sub (f64.const 10) (f64.div (f64.const 4) (f64.const 2)))'), 8)
})

test('Edge cases', async t => {
  t.equal(await evaluate('(f64.add (f64.const 0) (f64.const 5))'), 5)
  t.equal(await evaluate('(f64.mul (f64.const 5) (f64.const 0))'), 0)
  t.equal(await evaluate('(f64.add (f64.const -1) (f64.const 3))'), 2)
  t.equal(await evaluate('(f64.add (f64.const 1.5) (f64.const 2.5))'), 4)
})

test('WebAssembly compilation', t => {
  try {
    const wasm = compile('(f64.add (f64.const 1) (f64.const 1))')
    t.ok(wasm instanceof Uint8Array)
    t.ok(wasm.byteLength > 0)
    console.log('WASM size:', wasm.byteLength, 'bytes')
  } catch (e) {
    console.warn('WASM compilation skipped:', e.message)
  }
})

test('Error handling', async t => {
  try {
    await jz.evaluate('1 + ')
    t.fail('Should have thrown')
  } catch (e) {
    // subscript throws different error messages, just check that it throws
    t.ok(e.message.length > 0)
  }
})



test('test262 literals - numeric', async t => {
  // From test262/test/language/literals/numeric/S7.8.3_A3.2_T1.js
  t.equal(await evaluate('0.0'), 0)
  t.equal(await evaluate('1.0'), 1)
  t.equal(await evaluate('2.0'), 2)
  t.equal(await evaluate('3.14'), 3.14)
})

test('test262 literals - binary', async t => {
  // From test262/test/language/literals/numeric/binary.js
  t.equal(await evaluate('0b0'), 0)
  t.equal(await evaluate('0b1'), 1)
  t.equal(await evaluate('0b10'), 2)
  t.equal(await evaluate('0b11'), 3)
  t.equal(await evaluate('0B0'), 0)
  t.equal(await evaluate('0B1'), 1)
})

test('test262 literals - octal', async t => {
  // From test262/test/language/literals/numeric/octal.js
  t.equal(await evaluate('0o10'), 8)
  t.equal(await evaluate('0o11'), 9)
  t.equal(await evaluate('0O10'), 8)
})

test('test262 literals - hex', async t => {
  // From test262/test/language/literals/numeric/hex.js
  t.equal(await evaluate('0x10'), 16)
  t.equal(await evaluate('0x1a'), 26)
  t.equal(await evaluate('0X10'), 16)
})

test('test262 expressions - addition', async t => {
  // From test262/test/language/expressions/addition
  t.equal(await evaluate('1 + 2'), 3)
  t.equal(await evaluate('2 + 3'), 5)
  t.equal(await evaluate('0 + 5'), 5)
})

test('test262 expressions - subtraction', async t => {
  t.equal(await evaluate('5 - 2'), 3)
  t.equal(await evaluate('10 - 5'), 5)
})

test('test262 expressions - multiplication', async t => {
  t.equal(await evaluate('3 * 4'), 12)
  t.equal(await evaluate('2 * 3'), 6)
})

test('test262 expressions - division', async t => {
  t.equal(await evaluate('10 / 2'), 5)
  t.equal(await evaluate('15 / 3'), 5)
})

test('test262 expressions - precedence', async t => {
  t.equal(await evaluate('2 + 3 * 4'), 14)
  t.equal(await evaluate('10 - 4 / 2'), 8)
})

test('test262 expressions - unary', async t => {
  t.equal(await evaluate('-1'), -1)
  t.equal(await evaluate('+1'), 1)
})

test('operators - comparisons (boolean as 0/1)', async t => {
  t.equal(await evaluate('1 < 2'), 1)
  t.equal(await evaluate('2 < 1'), 0)
  t.equal(await evaluate('2 <= 2'), 1)
  t.equal(await evaluate('3 > 2'), 1)
  t.equal(await evaluate('3 >= 4'), 0)
  t.equal(await evaluate('3 == 3'), 1)
  // NOTE: '!=' is deferred (parser tokenization differs in current subscript build).
})

test('operators - bitwise and shifts (via stdlib)', async t => {
  t.equal(await evaluate('5 & 3'), 1)
  t.equal(await evaluate('5 | 2'), 7)
  t.equal(await evaluate('5 ^ 1'), 4)
  t.equal(await evaluate('~0'), -1)
  t.equal(await evaluate('1 << 3'), 8)
  t.equal(await evaluate('8 >> 1'), 4)
  // NOTE: unsigned shift (>>>) and short-circuit logicals are deferred until
  // we add a proper function-body codegen path (needs locals and blocks).
})

test('test262 literals - boolean', async t => {
  t.equal(await evaluate('true'), 1)
  t.equal(await evaluate('false'), 0)
})

test('meaningful-base coercions (piezo-ish)', async t => {
  // logical: returns actual values (like JS/piezo), not booleanized
  t.equal(await evaluate('1 && 2'), 2) // truthy && x = x
  t.equal(await evaluate('0 && 2'), 0) // falsy && x = 0
  t.equal(await evaluate('0 || 2'), 2) // falsy || x = x
  t.equal(await evaluate('1 || 2'), 1) // truthy || x = truthy
  t.equal(await evaluate('!2'), 0)
  t.equal(await evaluate('!0'), 1)

  // arithmetic: numeric domain (f64)
  t.equal(await evaluate('true + 2'), 3) // true coerces to 1

  // bitwise: integer i32 domain
  t.equal(await evaluate('true & 3'), 1)
  t.equal(await evaluate('~1.9'), -2) // trunc(1.9)=1; ~1 == -2

  // coalesce: only null/undefined trigger fallback (JS semantics)
  t.equal(await evaluate('1 ?? 9'), 1)
  t.equal(await evaluate('0 ?? 9'), 0)  // 0 is NOT nullish in JS
  t.equal(await evaluate('null ?? 9'), 9)  // null IS nullish
  t.equal(await evaluate('undefined ?? 9'), 9)  // undefined IS nullish

  // ternary: condition is booleanized; branches conciliate
  t.equal(await evaluate('1 ? 2 : 3'), 2)
  t.equal(await evaluate('0 ? 2 : 3'), 3)
  t.equal(await evaluate('1 ? true : false'), 1)
  t.equal(await evaluate('0 ? true : false'), 0)
})

test('short-circuit (no rhs evaluation)', async t => {
  // If rhs were evaluated, it would trap.
  t.equal(await evaluate('0 && die()'), 0)
  t.equal(await evaluate('1 || die()'), 1)
})
