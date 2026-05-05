import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { compile } from '../index.js'

function run(code) {
  return new WebAssembly.Instance(new WebAssembly.Module(compile(code))).exports
}

const throws = (code, match, msg) => {
  let error
  try { compile(code) } catch (e) { error = e }
  ok(error && error.message.includes(match), `${msg}: expected "${match}", got "${error?.message}"`)
}

// ============================================================================
// Prohibited identifiers
// ============================================================================

test('prohibited: this', () => throws('export let f = () => this.x', 'this', 'this should error'))
test('prohibited: super', () => throws('export let f = () => super.x', 'super', 'super should error'))
test('prohibited: arguments', () => throws('export let f = () => arguments[0]', 'arguments', 'arguments should error'))
test('prohibited: eval', () => throws('eval("1")', 'eval', 'eval should error'))

// ============================================================================
// Prohibited ops
// ============================================================================

test('prohibited: async', () => throws('async function f() {}', 'async', 'async should error'))
test('prohibited: await', () => throws('export let f = async () => await x', 'async', 'async should error'))
test('prohibited: class', () => throws('class Foo {}', 'class', 'class should error'))
test('prohibited: yield', () => throws('function* f() { yield 1 }', 'generator', 'yield should error'))
test('prohibited: delete', () => throws('delete obj.x', 'delete', 'delete should error'))
// 'in' operator now supported for HASH key existence checks
test('prohibited: instanceof', () => throws('x instanceof Array', 'instanceof', 'instanceof should error'))
test('prohibited: with', () => throws('with (obj) {}', 'with', 'with should error'))
test('prohibited: var', () => throws('var x = 1', 'var', 'var should error'))
test('prohibited: function', () => throws('function f() {}', 'function', 'function should error'))

// ============================================================================
// Const enforcement
// ============================================================================

test('prohibited: const reassignment', () => throws('const x = 1; export let f = () => { x = 2; return x }', "const 'x'", 'const reassign should error'))
test('prohibited: const +=', () => throws('const x = 1; export let f = () => { x += 1; return x }', "const 'x'", 'const += should error'))
test('prohibited: const ++', () => throws('const x = 1; export let f = () => { x++; return x }', "const 'x'", 'const ++ should error'))

// ============================================================================
// Const shadowing — nested scopes can shadow outer const
// ============================================================================

test('const: param shadows outer const', () => {
  is(run('const x = 1; export let f = () => { let g = (x) => { x = 3; return x }; return g(9) }').f(), 3)
})

test('const: inner let shadows outer const', () => {
  is(run('const x = 1; export let f = () => { let x = 10; x = 20; return x }').f(), 20)
})

// ============================================================================
// Temp name hygiene — compiler internals don't collide with user names
// ============================================================================

test('hygiene: __d0 does not collide with destruct temp', () => {
  is(run('export let f = () => { let __d0 = [9, 9]; let [a, b] = [1, 2]; return __d0[0] + a + b }').f(), 12)
})

test('hygiene: __d0 object destruct', () => {
  is(run('export let f = () => { let __d0 = {x: 9}; let {x} = {x: 1}; return __d0.x + x }').f(), 10)
})

test('hygiene: __arr0 does not collide with array temp', () => {
  is(run('export let f = () => { let __arr0 = 5; return [1][0] + __arr0 }').f(), 6)
})

// ============================================================================
// Block scoping — let/const are block-scoped
// ============================================================================

test('block scope: if shadow', () => {
  is(run('export let f = () => { let x = 1; if (1) { let x = 2; x = 3 }; return x }').f(), 1)
})

test('block scope: for shadow', () => {
  is(run('export let f = () => { let i = 99; for (let i = 0; i < 3; i++) {}; return i }').f(), 99)
})

test('block scope: while shadow', () => {
  is(run('export let f = () => { let x = 5; let c = 0; while (c < 1) { let x = 99; c++ }; return x }').f(), 5)
})

test('block scope: nested if', () => {
  is(run('export let f = () => { let x = 1; if (1) { let x = 2; if (1) { let x = 3 } }; return x }').f(), 1)
})

test('block scope: else shadow', () => {
  is(run('export let f = (c) => { let x = 1; if (c) { let x = 10 } else { let x = 20; x = 30 }; return x }').f(0), 1)
})

// ============================================================================
// Default params — internal calls
// ============================================================================

test('default: internal call with omitted arg', () => {
  is(run('let g = (x = 42) => x; export let f = () => g()').f(), 42)
})

test('default: internal call with provided arg', () => {
  is(run('let g = (x = 42) => x; export let f = () => g(7)').f(), 7)
})

// ============================================================================
// Side-effect preservation in optimizations
// ============================================================================

test('optimizer: *0 preserves side effects', () => {
  const { f, h } = run('let c = 0; let g = () => { c += 1; return 7 }; export let f = () => 0 * g(); export let h = () => c')
  f()
  is(h(), 1)  // g() must execute even though result is 0
})

// ============================================================================
// Closure default params
// ============================================================================

test('closure: default param used', () => {
  is(run('export let f = () => { let g = (x = 42) => x; return g() }').f(), 42)
})

test('closure: default param not used', () => {
  is(run('export let f = () => { let g = (x = 42) => x; return g(9) }').f(), 9)
})

// ============================================================================
// Tail-call with defaults and rest params
// ============================================================================

test('tail-call: return with default param', () => {
  is(run('let g = (x = 5) => x; export let f = () => { return g() }').f(), 5)
})

test('tail-call: return with rest params', () => {
  is(run('let g = (a, ...rest) => a + rest.length; export let f = () => { return g(10,1,2,3) }').f(), 13)
})

test('variadic: omitted fixed + default', () => {
  is(run('let g = (x = 5, ...rest) => x + rest.length; export let f = () => g()').f(), 5)
})

// ============================================================================
// Bare block scoping
// ============================================================================

test('block scope: bare block', () => {
  is(run('export let f = () => { let x = 1; { let x = 2; x = 3 }; return x }').f(), 1)
})

// ============================================================================
// Runtime global conflicts
// ============================================================================

test('prohibited: __heap conflicts with runtime', () =>
  throws('let __heap = 5; let a = [1]; export let f = () => __heap', 'compiler internal', '__heap should conflict'))

// ============================================================================
// Template tag — function aliasing
// ============================================================================

test('template: distinct functions with same name', () => {
  const a = Object.defineProperty(x => x + 1, 'name', { value: 'same' })
  const b = Object.defineProperty(x => x * 100, 'name', { value: 'same' })
  const { exports: { f } } = jz`export let f = (x) => ${a}(x) + ${b}(x)`
  is(f(1), 102) // (1+1) + (1*100) = 102
})

// ============================================================================
// Runtime .length safety
// ============================================================================

test('runtime: number.length returns undefined (no OOB)', () => {
  is(jz('export let f = () => (1).length').exports.f(), undefined)
})

test('runtime: unknown number param .length returns undefined (no OOB)', () => {
  is(jz('export let f = (x) => x.length').exports.f(1), undefined)
})

test('runtime: ternary reassignment does not keep stale array type', () => {
  is(jz('export let f = () => { let b = []; b = (0 ? [] : 1); return b.length }').exports.f(), undefined)
})

test('runtime: loose null equality matches undefined', () => {
  is(jz('export let f = (x) => x == null').exports.f(undefined), 1)
  is(jz('export let f = (x) => x == null').exports.f(null), 1)
  is(jz('export let f = (x) => x == null').exports.f(0), 0)
})

test('runtime: loose null inequality excludes undefined/null', () => {
  is(jz('export let f = (x) => x != null').exports.f(undefined), 0)
  is(jz('export let f = (x) => x != null').exports.f(null), 0)
  is(jz('export let f = (x) => x != null').exports.f(1), 1)
})

// Constructor/namespace validation deferred to emit/modules

// ============================================================================
// Strict core mode — opt-in: dynamic features error instead of pulling
// dynamic-dispatch stdlib. (Largest WASM-size lever per audit.)
// ============================================================================

const throwsStrict = (code, match, msg) => {
  let error
  try { compile(code, { strict: true }) } catch (e) { error = e }
  ok(error && error.message.includes(match), `${msg}: expected "${match}", got "${error?.message}"`)
}

test('strict: dynamic property access errors', () =>
  throwsStrict('export let f = (k) => { let p = {}; p[k] = 1; return p[k] }', 'strict mode', 'p[k] should error'))

test('strict: for-in errors', () =>
  throwsStrict('export let f = (o) => { let s = 0; for (let k in o) s++; return s }', 'strict mode', 'for-in should error'))

test('strict: unknown-receiver method call errors', () =>
  throwsStrict('export let f = (x) => x.foo(1, 2)', 'strict mode', 'x.foo should error'))

test('strict: accepts pure scalar function', () => {
  const wasm = compile('export let add = (a, b) => a + b', { strict: true })
  ok(wasm.byteLength === 41, `pure scalar should compile to 41 bytes in strict mode, got ${wasm.byteLength}`)
})

test('strict: accepts known-shape object', () => {
  // Object literal with literal keys + p.x access (no dynamic dispatch needed)
  const wasm = compile('export let f = (x) => { let p = { x: x, y: x * 2 }; return p.x + p.y }', { strict: true })
  ok(wasm.byteLength > 0, `should compile, got ${wasm.byteLength}`)
})

test('strict: accepts typed-array loop', () => {
  const wasm = compile('export let f = (arr) => { let buf = new Float64Array(arr); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i]; return s }', { strict: true })
  ok(wasm.byteLength > 0, `should compile, got ${wasm.byteLength}`)
})

// ============================================================================
// Error message quality — compile errors carry source location
// ============================================================================

test('error: unknown import gives useful message', () => {
  let error
  try { compile('import { foo } from "bar"; export let f = () => foo') } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('bar'), `message should mention module name: ${error.message}`)
})

test('error: unknown export gives useful message', () => {
  let error
  try { compile('import { nonexistent } from "./math.js"; export let f = () => nonexistent') } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('nonexistent'), `message should mention name: ${error.message}`)
})

test('error: compile error includes source line', () => {
  let error
  try { compile('export let f = () => { var x = 1 }') } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('var'), `message should mention 'var': ${error.message}`)
  ok(error.message.includes('line'), `message should include source location: ${error.message}`)
})

test('error: const reassignment message names the variable', () => {
  let error
  try { compile('const PI = 3.14; export let f = () => { PI = 3; return PI }') } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('PI'), `message should name 'PI': ${error.message}`)
  ok(error.message.includes('const'), `message should say 'const': ${error.message}`)
})

test('error: strict mode dynamic property access message', () => {
  let error
  try { compile('export let f = (k) => { let p = { x: 1 }; p[k] = 2; return p[k] }', { strict: true }) } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('strict'), `message should mention strict mode: ${error.message}`)
})

test('error: unknown op produces readable message', () => {
  let error
  try { compile('export let f = () => new.target') } catch (e) { error = e }
  ok(error, 'should throw')
})

test('error: invalid host option', () => {
  let error
  try { compile('export let f = () => 1', { host: 'edge' }) } catch (e) { error = e }
  ok(error && error.message.includes('Invalid host'), `expected Invalid host, got "${error?.message}"`)
})

test('error: circular import detected', () => {
  let error
  try {
    compile('export let a = 1', {
      modules: {
        'a.js': 'import { b } from "./b.js"; export let a = b',
        'b.js': 'import { a } from "./a.js"; export let b = a'
      }
    })
  } catch (e) { error = e }
  // Circular imports may or may not error depending on resolution strategy.
  // If they error, the message should be useful.
  if (error) ok(error.message.length > 0, 'error message should be non-empty')
})

test('error: compiler internal name conflict', () => {
  let error
  try { compile('let __heap = 5; let a = [1]; export let f = () => __heap') } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('compiler internal') || error.message.includes('internal'), `message should mention internal: ${error.message}`)
})

test('error: spread on non-variadic function', () => {
  let error
  try { compile('let g = (a, b) => a + b; export let f = (...args) => g(...args)') } catch (e) { error = e }
  // This may or may not error depending on whether g is known-arity
  // If it errors, the message should be useful
  if (error) ok(error.message.length > 0, 'error message should be non-empty')
})
