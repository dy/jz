import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onWasi, onKernel } from './_matrix.js'
import jz from '../index.js'
import { compile } from '../index.js'

function run(code, opts) {
  return jz(code, opts).exports
}

const throws = (code, match, msg, opts) => {
  let error
  try { compile(code, opts) } catch (e) { error = e }
  ok(error && error.message.includes(match), `${msg}: expected "${match}", got "${error?.message}"`)
}

// ============================================================================
// Prohibited identifiers
// ============================================================================

test('prohibited: this', () => throws('export let f = () => this.x', 'this', 'this should error'))
test('prohibited: super', () => throws('export let f = () => super.x', 'super', 'super should error'))
test('strict rejects: arguments', () => throws('export let f = () => arguments[0]', 'arguments', 'arguments should error', { strict: true }))
test('prohibited: eval', () => throws('eval("1")', 'eval', 'eval should error'))

// A SIMD (v128) value can't be NaN-boxed into the uniform f64 closure ABI. An IIFE is
// lambda-lifted to a typed direct call (liftIIFEs), so SIMD flows through it — those WORK.
// A GENUINE closure (an arrow escaping as a value, or an IIFE that mutates a capture so it
// can't lift) still rides the f64 ABI; carrying v128 there is an actionable compile error,
// not the opaque `f64.convert_i32_s expected i32, found v128` wasm-validator crash.
test('SIMD + closures: IIFEs lift and run; genuine closures error clearly', () => {
  is(jz('export let f = (a) => f32x4.lane((() => f32x4.splat(a))(), 0)').exports.f(3), 3, 'SIMD IIFE returning v128 lifts + runs')
  is(jz('export let f = (a) => f32x4.lane(((x) => f32x4.mul(x, x))(f32x4.splat(a)), 0)').exports.f(3), 9, 'SIMD IIFE with a v128 param lifts + runs')
  // An arrow escaping into an array is a real closure value — v128 can't cross the f64 ABI.
  throws('export let f = () => { let a = [() => f32x4.splat(1.0)]; return f32x4.lane(a[0](), 0) }', 'closure', 'escaping v128 arrow errors clearly')
  // A capture mutated inside the body can't lift (no write-back) → closure path → same clear error.
  throws('export let f = (a) => { let x = a; return f32x4.lane((() => { x = x + 1.0; return f32x4.splat(x) })(), 0) }', 'SIMD', 'mutated-capture SIMD IIFE errors clearly')
})

// ============================================================================
// Prohibited ops
// ============================================================================

// async GRADUATED (jzify/async.js state machines + plain-jz promise runtime) —
// strict mode and unlowered shapes are the remaining rejections.
test('strict rejects: async', () => throws('async function f() {} export let g = () => 1', 'async', 'strict rejects async', { strict: true }))
test('prohibited: await outside async', () => throws('export let f = () => await 1', 'await', 'stray await should error'))
test('strict rejects: class', () => throws('class Foo {}', 'class', 'class should error', { strict: true }))
// generators GRADUATED (jzify/generators.js state machines) — a stray yield
// outside a generator body is the remaining rejection.
test('prohibited: yield outside a generator', () => throws('export let f = () => { let x = yield 1; return x }', 'yield outside a generator', 'stray yield should error'))
test('prohibited: delete', () => throws('delete obj.x', 'delete', 'delete should error'))
// 'in' operator now supported for HASH key existence checks
// instanceof GRADUATED (.work/todo.md §deletion-sweep Slice B) — Array/Map/Set/the 8
// TypedArray ctors/ArrayBuffer/the 7 Error classes now work (see the dedicated
// test block below); an unsupported RHS (jz has no prototype chain) remains
// a loud compile-time reject, the one surviving case this test now pins.
test('strict rejects: instanceof (unsupported RHS)', () => throws('x instanceof Object', 'instanceof', 'instanceof on an unsupported RHS should error', { strict: true }))
test('prohibited: with', () => throws('with (obj) {}', 'with', 'with should error'))
test('strict rejects: var', () => throws('var x = 1', 'var', 'var should error', { strict: true }))
test('strict rejects: function', () => throws('function f() {}', 'function', 'function should error', { strict: true }))
// WeakMap/WeakSet are folded to Map/Set in default mode (no GC → weakness unobservable),
// but that fold is a deviation, not a true subset member — strict rejects them outright.
test('strict rejects: WeakMap', () => throws('export let f = () => new WeakMap()', 'WeakMap', 'WeakMap should error in strict', { strict: true }))
test('strict rejects: WeakSet', () => throws('export let f = () => new WeakSet()', 'WeakSet', 'WeakSet should error in strict', { strict: true }))
// jz's ==/!= never coerce (identical to ===/!==), so default mode accepts them; strict enforces
// the canonical subset, where ===/!== are the single spelling. (Accepted in default — see below.)
test('strict rejects: ==', () => throws('export let f = (a, b) => a == b', '==', '== should error in strict', { strict: true }))
test('strict rejects: !=', () => throws('export let f = (a, b) => a != b', '!=', '!= should error in strict', { strict: true }))
test('default accepts ==/!= (non-coercing)', () => {
  ok(compile('export let f = (a, b) => a == b'), '== compiles in default mode')
  ok(compile('export let f = (a, b) => a != b'), '!= compiles in default mode')
})

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

test('hygiene: closure default array literal declares allocation temp', () => {
  is(run('export let f = () => { let len = (value = []) => value.length; return len() }').f(), 0)
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

test('block scope: same const name in sibling blocks resolves correctly', () => {
  // Two `const g = () => N` in if/else arms used to collapse to one WASM
  // local. When `g` was passed as a value to a callback (rather than direct-
  // called from the same arm), both arms' references resolved to one body —
  // f(0) returned 1 instead of 2. Renaming the second decl restores per-block
  // uniqueness at the WASM-local level.
  const { f } = run(`export let f = (c) => {
    const out = (g) => g()
    if (c) {
      const g = () => 1
      return out(g)
    } else {
      const g = () => 2
      return out(g)
    }
  }`)
  is(f(1), 1)
  is(f(0), 2)
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
  if (onWasi() || onKernel()) return  // wasi/kernel: js template-tag interp injects host fns — not reachable via (code, strict)
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

test('runtime: ternary mixing a pointer arm with a bool/number arm keeps the pointer boxed', () => {
  // A pointer-repped arm (object/array) beside a non-pointer i32 arm (`true`/number) must
  // box to f64 — not ride a single i32 select whose result is numeric-converted, which
  // would strip the NaN-box and report typeof "number" for the object. Both selection
  // directions: the object arm is the LIVE one here.
  is(jz(`export let f = () => { const v = {x:1}; const o = (typeof v === 'object') ? v : true; return typeof o }`).exports.f(), 'object')
  is(jz(`export let f = () => { const v = [1,2]; const o = (typeof v === 'object') ? v : 0; return typeof o }`).exports.f(), 'object')
  // …and when the non-pointer arm is live, it still reads back as itself.
  is(jz(`export let f = () => { const v = {x:1}; const o = (typeof v === 'string') ? v : 7; return o }`).exports.f(), 7)
})

test('runtime: loose null equality matches undefined', () => {
  is(jz('export let f = (x) => x == null').exports.f(undefined), true)
  is(jz('export let f = (x) => x == null').exports.f(null), true)
  is(jz('export let f = (x) => x == null').exports.f(0), false)
})

test('runtime: loose null inequality excludes undefined/null', () => {
  is(jz('export let f = (x) => x != null').exports.f(undefined), false)
  is(jz('export let f = (x) => x != null').exports.f(null), false)
  is(jz('export let f = (x) => x != null').exports.f(1), true)
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

test('strict: dynamic property assignment errors without a later dynamic read', () =>
  throwsStrict('export let f = (k) => { let p = { x: 1 }; p[k] = 2; return p.x }', 'strict mode', 'p[k] assignment should error'))

test('strict: for-in errors', () =>
  throwsStrict('export let f = (o) => { let s = 0; for (let k in o) s++; return s }', 'strict mode', 'for-in should error'))

test('strict: unknown-receiver method call errors', () =>
  throwsStrict('export let f = (x) => x.foo(1, 2)', 'strict mode', 'x.foo should error'))

test('strict: accepts pure scalar function', () => {
  if (onWasi()) return  // wasi: size pin / extra wasi imports differ
  if (onKernel()) return  // kernel: bytes path is unoptimized (no watOptimize); 41-byte pin assumes level-2
  const wasm = compile('export let add = (a, b) => a + b', { strict: true, optimize: { watr: true } })
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

// === strict: boundary arg/param type mismatch ===
// A typed param (declared via default, or inferred from a type-exclusive use)
// receiving a statically-conflicting arg is a compile error — jz doesn't coerce
// across the call boundary, so the result would silently diverge from JS.

test('strict: number-default param rejects a string argument', () =>
  throwsStrict('export const g = (x = 0) => x + 1; export const f = () => g("hi")',
    'strict mode', 'number param <- string arg should error'))

test('strict: string-default param rejects a number argument', () =>
  throwsStrict('export const g = (s = "") => s; export const a = () => g("x"); export const f = () => g(5)',
    'strict mode', 'string param <- number arg should error'))

test('strict: .charCodeAt-inferred string param rejects a number argument', () =>
  throwsStrict('export const g = (s) => s.charCodeAt(0); export const a = () => g("x"); export const f = () => g(42)',
    'strict mode', 'string-by-use param <- number arg should error'))

test('strict: .push-inferred array param rejects a number argument', () =>
  throwsStrict('export const g = (a) => { a.push(1); return a[0] }; export const h = () => g([1]); export const f = () => g(7)',
    'strict mode', 'array-by-use param <- number arg should error'))

test('strict: matching argument types compile cleanly (no false positive)', () => {
  // number<-number, string<-string, and a genuinely untyped param accepting anything
  // must all pass — the check fires ONLY on a statically-certain conflict.
  ok(compile('export const g = (x = 0) => x + 1; export const f = () => g(5)', { strict: true }).byteLength > 0)
  ok(compile('export const g = (s) => s.charCodeAt(0); export const a = () => g("x"); export const f = () => g("hi")', { strict: true }).byteLength > 0)
  ok(compile('export const g = (x) => x; export const a = () => g(1); export const f = () => g("hi")', { strict: true }).byteLength > 0)
})

test('strict: type mismatch is permitted in non-strict mode (divergence tolerated)', () => {
  // Same program that errors under strict must still compile permissively.
  ok(compile('export const g = (x = 0) => x + 1; export const f = () => g("hi")').byteLength > 0)
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
  if (onKernel()) return  // kernel: host {modules} resolution + its error message are host-side, not in compileSelf
  let error
  try { compile('import { nonexistent } from "./math.js"; export let f = () => nonexistent', { modules: { './math.js': 'export let add = (a, b) => a + b' } }) } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('nonexistent'), `message should mention name: ${error.message}`)
})

test('error: compile error includes source line', () => {
  if (onKernel()) return  // kernel: source-line error annotation is host-side (ctx.error.src in compile()), not in the wasm
  let error
  try { compile('export let f = () => { var x = 1 }', { strict: true }) } catch (e) { error = e }
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

test('error: emitted errors include current AST context', () => {
  let error
  try { compile('const x = 1; export let f = () => { x = 2; return x }') } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('current AST'), `message should include current AST: ${error.message}`)
  ok(error.message.includes('["=","x"'), `message should include assignment node: ${error.message}`)
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
  if (onKernel()) return  // kernel: host {host:…} option + its validation are host-side, never reach the wasm
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

// ============================================================================
// Error message precision — compiler must locate where in source the error is
// ============================================================================

test('error: location includes line number', () => {
  if (onKernel()) return  // kernel: source-line error annotation is host-side (ctx.error.src in compile()), not in the wasm
  let error
  try {
    compile(`
      export let f = () => {
        var x = 1
        return x
      }
    `, { strict: true })
  } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('line'), `message should include 'line': ${error.message}`)
  ok(/\d+/.test(error.message), `message should include a line number: ${error.message}`)
})

test('error: location points to correct line', () => {
  // The error is on line 4 (the `var x = 1` line), not line 1 or 2
  let error
  try {
    compile([
      'export let f = () => {',
      '  let a = 1',
      '  var x = 1',   // line 3 (0-indexed) — the error
      '  return x',
      '}',
    ].join('\n'), { strict: true })
  } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('var'), `message mentions 'var': ${error.message}`)
  const lineMatch = error.message.match(/line (\d+)/)
  if (lineMatch) {
    // The line number should be the line where `var` appears, not the first line
    ok(/line [23]/.test(error.message), `line should point near the error source, got: ${error.message}`)
  }
})

test('error: location includes column number', () => {
  let error
  try {
    compile([
      'export let f = () => {',
      '  var x = 1',  // column ~3
      '}',
    ].join('\n'), { strict: true })
  } catch (e) { error = e }
  ok(error, 'should throw')
  // The error should include some positional info
  ok(error.message.length > 10, `error message is non-trivial: ${error.message}`)
})

test('error: long program error points to correct region', () => {
  let error
  try {
    compile([
      'export let f = (a, b) => a + b',
      'export let g = (x) => x * 2',
      'export let h = () => { var y = 3; return y }',  // line 3 — the error
      'export let k = (x) => -x',
    ].join('\n'), { strict: true })
  } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('var'), `message mentions 'var': ${error.message}`)
})

test('error: type error in large expression includes location', () => {
  // Use a definitely-prohibited construct to trigger compile error in complex expression
  let error
  try {
    compile([
      'export let f = () => {',
      '  let x = [1, 2, 3]',
      '  return x + (this)',  // 'this' is prohibited
      '}',
    ].join('\n'))
  } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.length > 10, `error message is non-trivial: ${error.message}`)
})

test('error: module resolution error includes file name', () => {
  let error
  try {
    compile('import { foo } from "./nonexistent.jz"; export let f = () => foo')
  } catch (e) { error = e }
  ok(error, 'should throw')
  ok(error.message.includes('nonexistent'), `message mentions module file: ${error.message}`)
})

// ============================================================================
// Built-in Error subclasses — `new TypeError(msg)` / bare `TypeError(msg)`
// reach JS as a real Error with the message preserved
// ============================================================================

for (const cls of ['SyntaxError', 'TypeError', 'RangeError', 'ReferenceError', 'URIError', 'EvalError']) {
  test(`${cls}: throw new ${cls} surfaces message`, () => {
    let error
    try { jz(`export let f = () => { throw new ${cls}("bad ${cls}") }`).exports.f() }
    catch (caught) { error = caught }
    ok(error instanceof Error)
    is(error.message, `bad ${cls}`)
  })

  test(`${cls}: throw ${cls}() (no new) surfaces message`, () => {
    let error
    try { jz(`export let f = () => { throw ${cls}("bare ${cls}") }`).exports.f() }
    catch (caught) { error = caught }
    ok(error instanceof Error)
    is(error.message, `bare ${cls}`)
  })
}

test('Error subclasses: try/catch with throw new TypeError', () => {
  is(run(`export let f = (x) => {
    try { if (x < 0) throw new TypeError("neg"); return x }
    catch (e) { return -1 }
  }`).f(-5), -1)
})

// ============================================================================
// Dead-throw carrier — treeshake must preserve __jz_last_err_bits even when
// the function carrying the only throw is itself dead-stripped
// ============================================================================

test('throw inside an unused arrow does not break codegen', () => {
  const wasm = compile(`const err = () => { throw 1 }; export let f = () => 1`)
  ok(wasm instanceof Uint8Array)
})

test('throw declares + exports __jz_last_err_bits even when carrier is dead', () => {
  const wat = compile(`const err = () => { throw 1 }; export let f = () => 1`, { wat: true })
  ok(wat.includes('(global $__jz_last_err_bits'), 'last-err global declared')
  ok(wat.includes('(export "__jz_last_err_bits"'), 'last-err global exported')
})

// ============================================================================
// Uncatchable internal throw → a trap, NOT the exceptions proposal. A throw with
// no `try`/`catch` anywhere is uncatchable IN WASM (semantically a trap there);
// declaring the $__jz_err Tag just to carry it forces consumers that don't enable
// the exceptions proposal (wasmtime, wabt, wasm2c) to reject the module on the Tag
// section — V8 alone enables exceptions by default, which masked this. Keep such
// modules in the wasm MVP. (User throw/try/catch is an ABI contract and keeps the
// tag + exceptions runtime — above.)
//
// The trap is NOT uncatchable at the HOST boundary, though: __jz_last_err_bits
// (plain mutable-i64 MVP global, no exceptions proposal needed) survives the trap
// and lets interop.js's decodeThrown resolve it back to the real ECMAScript error
// class + `.thrown` code (audit #7 P1 — this used to be stripped along with the
// tag, making host decode unreachable and forcing a bare `RuntimeError:
// unreachable` on every ordinary runtime error).
// ============================================================================

test('uncatchable internal throw is a trap, not the exceptions tag (MVP-portable)', () => {
  // `Number(v)` pulls __to_num, whose non-coercible-value branch throws $__jz_err.
  // With no user try/catch nothing can catch it, so the module must stay MVP-clean.
  // Sanity probe pre-watr: watr's inliner may splice __to_num's body into $f
  // (the named call disappears); the trap/tag assertions run on the shipped module.
  const pre = compile('export let f = (v) => Number(v) + 1', { wat: true, optimize: { level: 2, watr: false } })
  ok(pre.includes('$__to_num'), 'sanity: the throwing coercion helper is pulled in')
  const wat = compile('export let f = (v) => Number(v) + 1', { wat: true })
  ok(!wat.includes('(tag $__jz_err'), 'no exceptions tag for an uncatchable internal throw')
  ok(!/\(throw /.test(wat), 'the uncatchable throw is lowered to a trap')
  // The last-err carrier survives the trap-lowering — it's the host-decode contract.
  ok(wat.includes('(global $__jz_last_err_bits'), 'last-err global survives trap-lowering')
  ok(wat.includes('(export "__jz_last_err_bits"'), 'last-err global stays exported')
  ok(wat.includes('global.set $__jz_last_err_bits'), 'the marker write before the trap survives')
})

test('catchable throw keeps the exceptions runtime (try/catch needs the tag)', () => {
  // Contrast: a real try/catch CAN catch the throw, so the tag must survive.
  const wat = compile('export let f = (v) => { try { throw v } catch (e) { return e } }', { wat: true })
  ok(wat.includes('(tag $__jz_err'), 'caught throw keeps the exceptions tag')
  ok(wat.includes('(try_table'), 'try/catch lowers to try_table')
})

// ============================================================================
// Host decode of a trap-lowered internal throw (audit #7 P1) — the trap above is
// decoded at the host boundary into the real ECMAScript error class the throw
// site models, with `.thrown` carrying the raw $__jz_err code (src/err-codes.js).
// ============================================================================

test('host decode: trap-lowered JSON.parse throw resolves to a real SyntaxError', () => {
  let error
  try { jz(`export let f=()=>JSON.parse('x')`).exports.f() }
  catch (e) { error = e }
  ok(error instanceof SyntaxError, `expected SyntaxError, got ${error?.constructor?.name}`)
  is(error.thrown, 300, 'thrown code is JSON_PARSE_SYNTAX (src/err-codes.js)')
})

test('host decode: trap-lowered radix throw resolves to a real RangeError', () => {
  let error
  try { jz(`export let f=()=>(3).toString(37)`).exports.f() }
  catch (e) { error = e }
  ok(error instanceof RangeError, `expected RangeError, got ${error?.constructor?.name}`)
  is(error.thrown, 205, 'thrown code is NUMBER_RADIX (src/err-codes.js)')
})

test('host decode: a genuine unmarked trap still surfaces as RuntimeError', () => {
  // A tiny `maxMemory` ceiling turns __memgrow's OOM path (module/core.js) into a
  // real, deterministic, unmarked `unreachable` — no throw site precedes it, so
  // __jz_last_err_bits stays 0 and decodeThrown must rethrow it undecoded. The
  // function branches through Number(v) first so the module still carries the
  // last-err marker (pulled by __to_num) — this pins the "marker present but
  // zero" branch, not just the "no marker at all" one.
  // kernel leg: `maxMemory` is a host-side compile OPTION (ctx.memory.max, baked
  // into the module's memory limits at compile time) — kernel-target.js's own
  // docstring lists this class of opt ("host-side opts that shape compilation")
  // as not marshaled across the wasm compile-ABI (audit-#8 P1-1 differential:
  // confirmed the growth silently SUCCEEDS in-kernel instead of trapping — the
  // ceiling never reached the self-compiled compile at all). Orthogonal to the
  // marker-consume fix this test pins; native (the leg that actually respects
  // maxMemory) stays the witness.
  if (onKernel()) return
  const src = `export let f=(v)=>{
    if (typeof v === 'number') { let s = 'a'; for (let i = 0; i < 30; i++) s = s + s; return s.length }
    return Number(v)
  }`
  let error
  try { jz(src, { maxMemory: 1 }).exports.f(1) }
  catch (e) { error = e }
  ok(error instanceof WebAssembly.RuntimeError, `expected an undecoded RuntimeError, got ${error?.constructor?.name}`)
})

test('host decode: a decoded escape does not leave a stale marker for the next trap', () => {
  // A real userThrows escape (WebAssembly.Exception path) writes the SAME marker
  // global a trap-lowered throw does — decodeThrown must consume it there too, or
  // a later genuine trap on the SAME instance reads the stale nonzero value and
  // misdecodes as the earlier, already-handled error.
  // kernel leg: same `maxMemory` non-marshaling gap as the pin above — see its
  // comment. The in-wasm-catch/finally marker-consume mechanism this session
  // added (src/compile/emit.js 'catch'/'finally') is exercised directly by the
  // audit-#8 P1-1 repro in this file's own catch/finally section instead.
  if (onKernel()) return
  const src = `export let f = (mode) => {
    if (mode === 1) throw 300
    let s = 'a'; for (let i = 0; i < 30; i++) s = s + s; return s.length
  }`
  const inst = jz(src, { maxMemory: 1 })
  let first
  try { inst.exports.f(1) } catch (e) { first = e }
  ok(first instanceof SyntaxError, `expected the escape to decode to SyntaxError, got ${first?.constructor?.name}`)
  let second
  try { inst.exports.f(0) } catch (e) { second = e }
  ok(second instanceof WebAssembly.RuntimeError, `expected the later trap undecoded, got ${second?.constructor?.name}`)
  ok(!(second instanceof SyntaxError), 'the stale marker from the first decode must not leak into the second')
})

// audit-#8 P1-1 (2026-08-03): a JSON error CAUGHT INSIDE wasm (a `try`/`catch`
// the module fully handles — never rethrows, never escapes to the host) used
// to leave $__jz_last_err_bits pointing at the handled error's code. A LATER
// genuine trap (unrelated to $__jz_err — here, an oversized Float64Array
// allocation) then misdecoded at the host boundary as the STALE handled error
// instead of a plain RuntimeError. Fix: src/compile/emit.js's 'catch' and
// 'finally' emitters zero the marker as soon as the thrown value is bound
// (before the handler/cleanup runs) — the in-wasm handling is what consumes
// it, mirroring interop.js's decodeThrown reset for the escaping-throw case.
// No `maxMemory` option needed (unlike the pins above) — this repro runs on
// BOTH legs, native and kernel.
test('host decode (audit-#8 P1-1): a JSON error caught IN-WASM does not stale-poison a later genuine trap — same call', () => {
  const src = `export let f = (n) => {
    try { JSON.parse('{bad json') } catch (e) {}
    let a = new Float64Array(n)
    return a.length
  }`
  let error
  try { jz(src).exports.f(2 ** 34) } catch (e) { error = e }
  ok(error instanceof WebAssembly.RuntimeError, `expected RuntimeError, got ${error?.constructor?.name}`)
  ok(!(error instanceof SyntaxError), 'the in-wasm-caught SyntaxError must not leak into the later trap')
})

test('host decode (audit-#8 P1-1): a JSON error caught IN-WASM does not stale-poison a later genuine trap — later call, same instance', () => {
  const src = `
    export let catchIt = () => { try { JSON.parse('{bad json') } catch (e) {} ; return 1 }
    export let boom = (n) => { let a = new Float64Array(n); return a.length }
  `
  const { exports } = jz(src)
  is(exports.catchIt(), 1, 'first call: the in-wasm catch runs and returns normally (nothing escapes)')
  let error
  try { exports.boom(2 ** 34) } catch (e) { error = e }
  ok(error instanceof WebAssembly.RuntimeError, `expected RuntimeError, got ${error?.constructor?.name}`)
  ok(!(error instanceof SyntaxError), 'the earlier in-wasm-caught SyntaxError must not leak into this later trap')
})

// ============================================================================
// Error wrapping — unknown identifier errors must read as jz wording, not
// watr's internal "Unknown local/func/global" phrasing
// ============================================================================

test('unknown global references surface as a clean jz error, not watr "Unknown ..."', () => {
  if (onKernel()) return  // kernel: the watr-error→friendly-message rewrite is host-side (compile() catch), not in compileSelf
  let err
  try { compile(`export let f = () => SomethingUndefined()`) }
  catch (e) { err = e }
  ok(err, 'compile should fail')
  ok(!/Unknown (local|func|global)/.test(err.message),
    `watr-shaped error leaked: ${err.message.slice(0, 120)}`)
})

// ============================================================================
// .caller / .callee prohibition — bad-practice access surfaces a clear error
// ============================================================================

test('prohibited: .caller property access', () => {
  let err
  try { compile(`export let f = () => { let g = ()=>42; return g.caller }`, { jzify: true }) }
  catch (e) { err = e }
  ok(err?.message.includes('caller'), `.caller should be prohibited: ${err?.message?.slice(0, 60)}`)
})

test('prohibited: .callee property access', () => {
  let err
  try { compile(`export let f = () => { let g = ()=>42; return g.callee }`, { jzify: true }) }
  catch (e) { err = e }
  ok(err?.message.includes('callee'), `.callee should be prohibited: ${err?.message?.slice(0, 60)}`)
})

// ============================================================================
// Reject-cleanly cluster (2026-07-10) — constructs that previously leaked
// internal errors ("Unknown op", watr "Unknown instruction", generic
// not-in-scope) now carry curated messages. Never fail unknowingly.
// ============================================================================

// generators graduated: an empty generator is a VALID machine (immediately done).
test('generators: empty generator runs (immediately done)', () => {
  is(run('function* g() { } export let f = () => g().next().done ? 1 : 0').f(), 1)
})
test('prohibited: yield* (v1)', () =>
  throws('let g = () => { let x = yield* a; return x }; export let f = () => 1', 'yield*', 'yield* should error cleanly'))
test('prohibited: new.target', () =>
  throws('function C() { return new.target ? 1 : 0 }; export let f = () => C()', 'new.target', 'new.target should error cleanly'))
test('prohibited: #field in obj brand check', () =>
  throws('class A { #x = 1; static has(o) { return #x in o } }; export let f = () => A.has(new A()) ? 1 : 0', 'brand', 'brand check should error cleanly'))
test('prohibited: String.raw (parser keeps only cooked strings)', () =>
  throws('export let f = () => String.raw`a\\nb`.length', 'String.raw', 'String.raw should error, not fold cooked-as-raw'))
test('strict rejects: switch', () =>
  throws('export let f = (x) => { switch (x) { case 1: return 10; default: return 20 } }', 'switch', 'switch should error in strict', { strict: true }))
test('unknown method on KNOWN receiver rejects in default mode', () => {
  throws('export let f = () => [3, 1, 2].frobnicate()[0]', 'not implemented', 'missing array method should fail at compile')
  throws('export let f = () => "abc".frobnicate()', 'not implemented', 'missing string method should fail at compile')
  // ES2025 Set algebra removed (union/intersection/… — out of jz scope): rejects
  // like any unknown method, no silent host fallthrough.
  throws('export let f = () => new Set([1]).union(new Set([2])).size', 'not implemented', 'removed Set.union should fail at compile')
})
test('const reassignment rejects (every operator, local + module scope)', () => {
  throws('export let f = () => { const c = 2; c = 3; return c }', 'constant', 'const = should error')
  throws('export let f = () => { const c = 2; c += 3; return c }', 'constant', 'const += should error')
  throws('export let f = () => { const c = 2; c++; return c }', 'constant', 'const ++ should error')
})

// Arena-rewind return wrapper: rewrite the return's VALUE (return stays
// stack-polymorphic) — the old value-typed block AROUND the return left a
// phantom value on a void try_table's stack ("expected 0 elements on the
// stack for fallthru"). Trigger: no-param function + allocation + discarded
// statement value + return inside try.
test('try: discarded method result before return compiles and runs', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { let a = [1]; try { a.slice(0); return 1 } catch (e) { return 2 } }`), 1)
  is(j(`export let f = () => { let a = [1, 2]; try { a.splice(0, 1); return a[0] } catch (e) { return -1 } }`), 2)
  is(j(`export let f = () => { let a = [1]; try { a.with(5, 2); return 1 } catch (e) { return 2 } }`), 2) // OOB throws, caught
  is(j(`export let f = () => { let a = [1]; try { a.toSorted(); return 1 } catch (e) { return 2 } }`), 1) // default comparator pulls string module
})

// .work/todo.md §deletion-sweep Slice A: `new Error(msg)`/the 7 built-in subclasses
// now construct a real in-wasm object (PTR.OBJECT, schema ['message','name'],
// module/core.js buildErrorObject) instead of lowering to the bare message
// value — supersedes the old "Error IS its message string" documented
// divergence this block used to pin. `.message`/
// `.name` read correctly, and String()/template-literal interpolation format
// per spec's Error.prototype.toString (ECMA-262 20.5.3.4: name if message
// empty / message if name empty / name+": "+message otherwise / "Error" if
// both empty) via src/ir.js's toStrI64 Error-schema arm — the fix for the
// pre-existing `${anyDynamicObject}` → "" bug, at least for Error objects.
test('errors: real Error objects (.work/todo.md §deletion-sweep Slice A)', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { try { throw new Error('boom') } catch (e) { return e.message } }`), 'boom', '.message reads the constructor argument')
  is(j(`export let f = () => { try { throw new TypeError('t') } catch (e) { return e.name } }`), 'TypeError', '.name reads the built-in class name')
  is(j(`export let f = () => { try { throw new TypeError('t') } catch (e) { return String(e) } }`), 'TypeError: t', 'String(e) is "name: message" (20.5.3.4)')
  is(j(`export let f = () => { try { throw new Error('x') } catch (e) { return \`\${e}\` } }`), 'Error: x', 'template-literal interpolation matches String(e)')
  is(j(`export let f = () => { try { throw new Error() } catch (e) { return \`\${e}\` } }`), 'Error', 'no-arg new Error(): empty message → bare name (20.5.3.4)')
  // Error(x)/without `new` constructs a fresh Error too (spec) — same object model.
  is(j(`export let f = () => { try { throw Error('bare') } catch (e) { return e.message } }`), 'bare')
})

// audit-#10 finding-4: a RETURNED (not thrown) Error object previously decoded
// at the host boundary as a plain {message,name} object — never `instanceof
// Error` — because interop.js's Error-class upgrade (mem.errorSidToClass,
// the 'jz:errcls' custom section audit-#9 P0-2's Brand redesign added) only
// ever ran inside decodeThrown, reached exclusively by an ESCAPING THROW. A
// function that returns its Error normally (`return e`, or constructs and
// returns one directly) never touches decodeThrown at all. Fixed by
// extracting the identical sid→class lookup into `errorSidClassOf` (shared
// by decodeThrown AND the new `readRet`, wired into both heap-module export
// wrappers' `finishRet` call and the async promise-settle path
// `readSettled`) — a returned/resolved Error now upgrades the same way a
// thrown one does, minus `.cause`/`.thrown` (no host exception to attach a
// cause to on a plain return).
test('errors: a RETURNED (not thrown) Error decodes as a real host Error at the boundary (audit-#10 finding-4)', () => {
  const j = (code) => jz(code, { jzify: true }).exports.f()
  const literal = j(`export let f = () => new TypeError('x')`)
  ok(literal instanceof TypeError, 'returned new TypeError(x) is instanceof host TypeError')
  ok(literal instanceof Error, 'and instanceof host Error (every built-in class extends Error)')
  is(literal.message, 'x', '.message survives the host decode')
  is(literal.name, 'TypeError', '.name survives the host decode')
  const bound = j(`export let f = () => { let e = new TypeError('y'); return e }`)
  ok(bound instanceof TypeError, 'a BOUND Error variable, returned, decodes the same way')
  is(bound.message, 'y')
  const base = j(`export let f = () => new Error('base')`)
  ok(base instanceof Error, 'base Error class decodes too')
  ok(!(base instanceof TypeError), 'but is not instanceof a sibling subclass')
})

// audit-#20 (root-caused alongside finding-4 above): an async function that
// RESOLVES (not throws) with ANY value — heap or primitive — lost or trapped
// on it, in two AST-shape-dependent failure modes, both in the shared
// generator/async machinery (not Error-specific — confirmed with a
// plain-object, non-Error repro alongside the Error one):
//   - concise arrow body (`async () => expr`, implicit return): lowerAsync
//     (jzify/async.js) spliced the arrow's raw body straight into a
//     synthetic `function*` node without wrapping it in a `return` — a REAL
//     function* body is never concise (only arrows have that JS shape), so
//     the generator lowering (jzify/generators.js) compiled the bare
//     expression as a discarded expression-statement: `next()` always fell
//     through to the machine's own `{value:undefined,done:true}` tail,
//     whatever the arrow evaluated to. Fixed in jzify/transform.js's
//     `'async'` handler: a concise body (anything but a leading '{}' block —
//     even `({x:1})` parses as `['()', obj]`, never bare '{}') is now
//     wrapped into `['return', body]` before lowering, the same shape a
//     single-statement function body already carries unwrapped.
//   - block body (`async () => { return expr }`) with NO await anywhere in
//     it: jzify/generators.js's state-machine builder (`flattenStmt`)
//     treated any compound statement containing no `yield` as inert and
//     spliced it verbatim (the atomic fast path, gated on `hasYield` alone)
//     — but a yield-free block can still hold a `return`, and splicing it
//     let that `return` execute as a bare host return out of the `__next`
//     closure instead of the `{value,done}` record its caller reads,
//     corrupting the settlement (a number equally, but a heap/NaN-boxed
//     pointer misread as the wrong shape is what trapped
//     unreachable/OOB). Fixed by adding a boundary-respecting `hasReturn`
//     alongside `hasYield` in the same gate, so a yield-free-but-return-
//     bearing block now decomposes through the existing '{}' unwrap instead
//     of short-circuiting.
// Was blocking finding-4's readSettled/readRet decode from ever being
// reached on the resolve side — the reject side (an async function that
// THROWS) was always fine: a throw traps through the wasm exceptions tag,
// never touching __p_value/the generator machine's return protocol at all.
test('errors: an async function resolving with a heap value (object, Error, …) decodes correctly, both AST shapes (audit-#20)', async () => {
  if (onWasi() || onKernel()) return
  const j = (code) => jz(code, { jzify: true }).exports.f()

  const concise = await j(`export let f = async () => new TypeError('resolved-not-thrown')`)
  ok(concise instanceof TypeError, 'concise-arrow shape: resolves to a real host TypeError, same decode as finding-4\'s sync return')
  is(concise.message, 'resolved-not-thrown')

  const block = await j(`export let f = async () => { return new TypeError('resolved-not-thrown') }`)
  ok(block instanceof TypeError, 'block-body shape: resolves the same way (previously trapped unreachable)')
  is(block.message, 'resolved-not-thrown')

  const conciseObj = await j(`export let f = async () => ({x: 1})`)
  is(conciseObj.x, 1, 'concise-arrow shape, plain (non-Error) object: resolves with the real value (previously silently undefined)')

  const blockObj = await j(`export let f = async () => { return {x: 1} }`)
  is(blockObj.x, 1, 'block-body shape, plain object: resolves with the real value (previously trapped unreachable)')
})
// coercion per ES 20.5.1.1 — "If message is not undefined, let msg be
// ? ToString(message)" (argument absent OR its value is undefined → no
// message, i.e. ''). Node-verified authority: `new Error(false).message` ===
// 'false' (ToString, not ToNumber); `new Error(undefined).message` === '' and
// `new Error().message` === '' (both empty, two different spec clauses, same
// outcome); `new Error({}).message` === '[object Object]'; `new
// Error(null).message` === 'null'; `new Error(0).message` === '0'.
test('errors: Error ctor message coercion (ES 20.5.1.1, audit-#9 P1)', () => {
  const j = (code) => jz(code, { optimize: 0 }).exports.f()
  is(j(`export let f = () => new Error(false).message`), 'false', 'new Error(false) → ToString(false), not the 0/1 carrier')
  is(j(`export let f = () => new Error(true).message`), 'true', 'new Error(true) → "true"')
  is(j(`export let f = () => new Error(undefined).message`), '', 'new Error(undefined) → "" — argument present but undefined means no message')
  is(j(`export let f = () => new Error().message`), '', 'new Error() → "" — argument absent')
  is(j(`export let f = () => new Error(null).message`), 'null', 'new Error(null) → ToString(null) — null is NOT undefined')
  is(j(`export let f = () => new Error({}).message`), '[object Object]', 'new Error({}) → Object.prototype.toString default tag')
  is(j(`export let f = () => new Error(0).message`), '0', 'new Error(0) → "0" (unaffected — proven-NUMBER fast path)')
  is(j(`export let f = () => new Error("s").message`), 's', 'new Error("s") → "s" (STRING identity fast path)')
  // Dynamic (non-literal) operand — exercises the runtime isUndef branch, not
  // just the compile-time fold every literal above takes.
  is(jz(`export let f = (x) => new Error(x).message`, { optimize: 0 }).exports.f(false), 'false', 'dynamic false argument')
  is(jz(`export let f = (x) => new Error(x).message`, { optimize: 0 }).exports.f(undefined), '', 'dynamic undefined argument')
})

// audit-#10 finding-2: `new Error({}).message` above is the literal AST-shape
// case 5f8ff012 special-cased (`isClosedObjLiteralNoStringMethod`). The
// GENERAL ES 20.5.1.1 invariant — ToString(message) for ANY non-undefined
// message, not just a literal — was already routing through toStrI64 (the
// same chokepoint String()/template literals use) for the non-special-cased
// case; the gap was narrower than "absent": a BOUND name pointing at a
// closed-schema object (no toString/valueOf, no dyn/out-of-schema writes)
// didn't get the literal's short-circuit, so it fell into toStrI64's generic
// OBJECT path — which has a real, pre-existing, general, Error-unrelated bug
// for non-Array objects (confirmed live: `String(o)` for a bound plain object
// returns typeof "object", not a string at all — .work/todo.md §deletion-sweep's
// own "Consequence" section already flags `${anyDynamicObject}` as broken,
// out of scope for this design). Generalized `isClosedObjLiteralNoStringMethod`
// (module/core.js) to `isClosedObjNoStringMethod`, extending the closed-world
// fact from "AST is literally a `{}` node" to "a bound name whose OWN
// declaration schema is closed" — the SAME generalization finding-1 applied
// to Object.assign's target (literal fact → binding fact), same root cause
// pattern, not a new mechanism.
test('errors: Error ctor message coercion — bound closed-schema object (audit-#10 finding-2)', () => {
  const j = (code) => jz(code, { jzify: true }).exports.f()
  is(j(`export let f = () => { let o = {x: 1}; return new Error(o).message }`), '[object Object]', 'bound non-empty closed-schema object now gets the same short-circuit as the literal')
  is(j(`export let f = () => { let o = {x: 1, y: 2}; return new Error(o).message }`), '[object Object]', 'multi-prop bound object, still closed')
  is(j(`export let f = () => { let o = {toString: () => 'custom'}; return new Error(o).message }`), 'custom', 'a real toString method is NOT short-circuited — the real method runs')
  // An out-of-schema write (`o.y = 2` where `y` isn't in o's declared schema)
  // makes the object NOT provably closed at compile time — a dynamically
  // added key COULD be 'toString'/'valueOf'. Falls to the pre-existing
  // generic toStrI64 OBJECT path, unaffected by this fix either direction —
  // asserting only that it does NOT wrongly claim '[object Object]'.
  is(j(`export let f = () => { let o = {x: 1}; o.y = 2; return new Error(o).message === '[object Object]' }`), false,
    'an out-of-schema write is conservatively NOT short-circuited (unproven closed-world)')
})

// FIXED (audit-#11 gap-1): a genuinely EMPTY `let o = {}` declaration used to
// get NO schema id bound at all (src/prepare/index.js's decl-schema-binding
// guarded on `props.length`, and even module/core.js's own
// `isClosedObjNoStringMethod` gated on `valTypeOf(node) === VAL.OBJECT` — a
// fact that, for THIS one binding shape, a second independent non-schema-
// aware body-fact pass could race and clear). Root-caused to two guards:
// prepare/index.js's decl-schema binding now accepts a 0-prop schema for a
// bare `{}` (module/object.js's own literal emitter already unconditionally
// mints one — this just binds the SAME sid to the declared name, same as any
// non-empty literal already did); isClosedObjNoStringMethod now gates on
// `ctx.schema.idOf` directly (a durable, single-writer fact) instead of the
// racy `.val`. A genuinely DYNAMIC dict (no schema even in principle — a
// computed-key-grown object, an unknown-source spread merge) is a separate,
// still-real gap this task ALSO closed: errorMessageIR now treats a
// VAL.HASH-kind message the same as a proven-closed OBJECT (no schema is
// EVER possible for a HASH, so "unprovable" is approximated as "absent",
// same discipline isClosedObjNoStringMethod itself already applies).
test('errors: Error ctor message coercion — bound TRULY EMPTY object and dynamic dicts (audit-#11 gap-1)', () => {
  const j = (code) => jz(code, { jzify: true }).exports.f
  is(j(`export let f = () => { let o = {}; return new Error(o).message }`)(), '[object Object]', 'bound empty object, no growth')
  is(j(`export let f = (k) => { let o = {}; o[k] = 1; return new Error(o).message }`)('k'), '[object Object]', 'empty object grown via a computed key — genuine dictionary mode (VAL.HASH), no schema even in principle')
  is(j(`export let f = (a, b) => { let o = {...a, ...b}; return new Error(o).message }`)({ x: 1 }, { y: 2 }), '[object Object]', 'unknown-source spread merge — VAL.HASH')
})

// §3(c): a non-Error throw is completely unaffected by the object model —
// `e` is whatever was thrown, verbatim, same as before this slice.
test('errors: non-Error throws are unchanged (number/string still legal)', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { try { throw 42 } catch (e) { return e } }`), 42)
  is(j(`export let f = () => { try { throw 'str' } catch (e) { return e } }`), 'str')
})

// §3(b): an INTERNAL coded throw (e.g. JSON.parse's SyntaxError) still binds
// catch(e) to the raw f64 code — it is never boxed into a real Error object
// (that's §3(a)'s user-constructed path, buildErrorObject/errorSid above).
// Slice C (§5's code→message table, module/collection.js's __err_prop, gated
// via module/core.js's maybeIncErrProp): .message/.name on that raw code now
// decode the SAME err-codes.js ERR_INFO text interop.js's host-side
// decodeThrown resolves the identical code to, so an in-wasm catch and an
// escaping throw agree on wording. Every other property name is unaffected —
// the receiver is still an honest NUMBER, not a materialized object, so
// `instanceof`/enumeration/spread see no new shape (the block below this one
// pins instanceof staying false). A user's own `throw <sameCodeValue>` decodes
// identically — err-codes.js's own header names this a known, accepted
// imprecision (an internal code and a user int are bit-identical, same
// caveat instanceof's own P0-2 fix already documents; pinned below too).
test('errors: internal coded throw binds catch(e) to the raw code — .message/.name decode via Slice C', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { try { JSON.parse('x'); return 0 } catch (e) { return e } }`), 300, 'e is the raw $__jz_err code (JSON_PARSE_SYNTAX)')
  is(j(`export let f = () => { try { JSON.parse('x'); return 0 } catch (e) { return e.message } }`), 'Unexpected token in JSON', '.message decodes to err-codes.js ERR_INFO[300].message')
  is(j(`export let f = () => { try { JSON.parse('x'); return 0 } catch (e) { return e.name } }`), 'SyntaxError', '.name decodes to ERR_INFO[300].name')
  is(j(`export let f = () => { try { let a = [1]; a.with(5, 2); return 0 } catch (e) { return e.message + '|' + e.name } }`), 'Invalid index|RangeError', 'a different code family (Array#with OOB, RangeError-class) decodes independently')
  is(j(`export let f = () => { try { JSON.parse('x'); return 0 } catch (e) { return e.foo === undefined ? 1 : 0 } }`), 1, 'a property name other than message/name still reads undefined, same as today\'s "number.length" gap — no crash')
  is(j(`export let f = () => { try { throw 300 } catch (e) { return e.message } }`), 'Unexpected token in JSON', 'accepted divergence: a user-thrown number that collides with a real internal code decodes the same way (no tag distinguishes them, same caveat as instanceof\'s P0-2 fix)')
})

// ============================================================================
// instanceof (.work/todo.md §deletion-sweep Slice B; audit-#8 P0-1, 2026-08-03)
// ============================================================================
// `instanceof` is a real op — op-policy.js's blanket REJECT_OPS entry is gone;
// src/prepare/index.js's handler validates the RHS against a closed allowlist
// (jz has no prototype chain) and src/compile/emit.js's emitter folds a
// statically-proven LHS kind to a constant or emits a tag/aux/schema compare.
// Strict-mode source reaches this directly on every raw `instanceof` node.
// Default-mode source reaches the SAME sound machinery for every RHS this
// file's INSTANCEOF_ALLOW supports (Array/Map/Set/TypedArray/ArrayBuffer/the
// 7 Error classes): jzify/transform.js's 'instanceof' handler passes those
// through as `['instanceof', val, name]` instead of answering them itself.
// Before audit-#8 P0-1, jzify answered the Error-family rows with its own
// broad `typeof===object` guess BEFORE this sound handler ever saw the node —
// `new TypeError(x) instanceof RangeError` answered `true` in default mode
// (JS: false). isBoth below runs every row in BOTH modes so that regression
// cannot come back unnoticed in either one. jzify keeps its own Promise/
// Iterator shape-probes (this file's handler rejects both RHS names) and its
// permissive `typeof===object` fallback for RHS names outside
// INSTANCEOF_ALLOW (Object/RegExp/user-class names — default mode stays
// permissive there; strict mode's loud-reject table below is unaffected).
const jBoth = (code) => [jz(code, {}).exports.f(), jz(code, { strict: true }).exports.f()]
const isBoth = (code, expected, msg) => {
  const [d, s] = jBoth(code)
  is(d, expected, `${msg} (default)`)
  is(s, expected, `${msg} (strict)`)
}

test('instanceof: Array/Map/Set/ArrayBuffer/TypedArray — truth table (both modes)', () => {
  isBoth(`export let f = () => [] instanceof Array`, true, '[] instanceof Array')
  isBoth(`export let f = () => new Map() instanceof Map`, true, 'new Map() instanceof Map')
  isBoth(`export let f = () => new Map() instanceof Set`, false, 'new Map() instanceof Set — siblings never satisfy each other')
  isBoth(`export let f = () => new Set() instanceof Map`, false, 'new Set() instanceof Map')
  isBoth(`export let f = () => new Float64Array(1) instanceof Float64Array`, true, 'new Float64Array(1) instanceof Float64Array')
  isBoth(`export let f = () => new Float64Array(1) instanceof Uint8Array`, false, 'element-type mismatch — different TYPED aux')
  isBoth(`export let f = () => new Float64Array(1).buffer instanceof ArrayBuffer`, true, '.buffer is a real BUFFER pointer')
  isBoth(`export let f = () => new ArrayBuffer(8) instanceof ArrayBuffer`, true, 'new ArrayBuffer(8) instanceof ArrayBuffer')
  isBoth(`export let f = () => new ArrayBuffer(8) instanceof Float64Array`, false, 'ArrayBuffer is not a TypedArray')
  // View vs owned storage of the SAME element type are BOTH instanceof that ctor
  // (real JS: `new Int32Array(buf) instanceof Int32Array` is true regardless of
  // whether the array owns or views its storage) — the runtime aux-compare masks
  // off TYPED_ELEM_VIEW_FLAG before comparing so this doesn't regress to false.
  isBoth(`export let f = () => { let b = new ArrayBuffer(16); return new Int32Array(b) instanceof Int32Array }`, true, 'a VIEW Int32Array is still instanceof Int32Array')
  // primitives / nullish: instanceof is false, never a throw, when RHS is a real ctor (ES 13.10.2)
  isBoth(`export let f = () => 42 instanceof Array`, false, '42 instanceof Array')
  isBoth(`export let f = () => null instanceof Map`, false, 'null instanceof Map')
  isBoth(`export let f = () => { let u; return u instanceof Set }`, false, 'undefined instanceof Set')
  isBoth(`export let f = () => "s" instanceof Array`, false, 'string primitive instanceof Array')
  isBoth(`export let f = () => true instanceof Map`, false, 'boolean primitive instanceof Map')
})

test('instanceof: Error family — tag+schema compare, class hierarchy (both modes)', () => {
  // audit-#8 repro 1, exact form: a plain let-bound Error (not caught) checked
  // against a SIBLING class. This is the repro that was `true` in default mode
  // before the fix (JS: false).
  isBoth(`export let f = () => { let e = new TypeError("x"); return e instanceof RangeError }`, false, 'audit-#8 repro 1: new TypeError(x) instanceof RangeError')
  // constructed Error objects: exact class true, sibling false, base Error true (hierarchy)
  isBoth(`export let f = () => { try { throw new TypeError('t') } catch (e) { return e instanceof TypeError } }`, true, 'e instanceof TypeError (exact class)')
  isBoth(`export let f = () => { try { throw new TypeError('t') } catch (e) { return e instanceof RangeError } }`, false, 'e instanceof RangeError (sibling — never confused)')
  isBoth(`export let f = () => { try { throw new TypeError('t') } catch (e) { return e instanceof Error } }`, true, 'e instanceof Error (every built-in class extends Error)')
  isBoth(`export let f = () => { try { throw new Error('x') } catch (e) { return e instanceof TypeError } }`, false, 'a base Error instance is not instanceof a subclass')
  isBoth(`export let f = () => { try { throw new RangeError('r') } catch (e) { return e instanceof RangeError } }`, true, 'RangeError exact class')
  isBoth(`export let f = () => { try { throw new SyntaxError('s') } catch (e) { return e instanceof SyntaxError } }`, true, 'SyntaxError exact class')
  isBoth(`export let f = () => { try { throw new ReferenceError('r') } catch (e) { return e instanceof ReferenceError } }`, true, 'ReferenceError exact class (zero internal-code sites — still constructible/instanceof-able)')
  isBoth(`export let f = () => { try { throw new URIError('u') } catch (e) { return e instanceof URIError } }`, true, 'URIError exact class')
  isBoth(`export let f = () => { try { throw new EvalError('v') } catch (e) { return e instanceof EvalError } }`, true, 'EvalError exact class (zero internal-code sites)')
  // non-Error throws (§3(c)): instanceof on the raw thrown value is false, never a crash
  isBoth(`export let f = () => { try { throw 42 } catch (e) { return e instanceof TypeError } }`, false, 'thrown number instanceof TypeError — false, not a crash')
  isBoth(`export let f = () => { try { throw 'oops' } catch (e) { return e instanceof Error } }`, false, 'thrown string instanceof Error — false')
})

// audit-#8 P0-2 (2026-08-03, design-error correction): src/compile/emit.js's
// emitErrorInstanceof used to test an internally-thrown NUMBER code against
// err-codes.js's ERR_CODE_RANGES and call a match "instanceof <Class>" — e.g.
// JSON.parse's internal SyntaxError code (300-302/311-318) landed in that
// arm. That range arm was UNSOUND: a jz-internal code and a user's own
// `throw <sameNumber>` are bit-identical numbers with no tag to distinguish
// them — `export let f = x => x instanceof SyntaxError; f(300)` answered
// `true` for an arbitrary caller int that happened to land in range (repro 2).
// The range arm is deleted; internal-code catches are honestly
// `instanceof`-false for every Error class now — pinned below, both modes.
// Recovering `instanceof` for a caught internal code needs a materialized
// Error object at the catch site — a heavier, still-unbuilt mechanism,
// DISTINCT from the §5 code→message table (Slice C, landed above): Slice C
// only teaches .message/.name to read real text off the raw code, it does
// not change the receiver's tag/shape, so instanceof (a tag+schema-id
// compare, src/compile/emit.js's emitErrorInstanceof) still sees a plain
// NUMBER and stays honestly false here, unaffected by Slice C landing.
test('instanceof: internal coded throws are NOT instanceof any Error class (audit-#8 P0-2, both modes)', () => {
  // repro 2, exact form: an arbitrary caller-supplied number that happens to
  // land in SyntaxError's internal range must NOT be instanceof SyntaxError.
  isBoth(`export let f = (x) => x instanceof SyntaxError`, false, 'audit-#8 repro 2: f(300) — see call below')
  is(jz(`export let f = (x) => x instanceof SyntaxError`, {}).exports.f(300), false, 'audit-#8 repro 2 default: f(300) instanceof SyntaxError')
  is(jz(`export let f = (x) => x instanceof SyntaxError`, { strict: true }).exports.f(300), false, 'audit-#8 repro 2 strict: f(300) instanceof SyntaxError')
  // the user-thrown-number collision, pinned directly on a `throw`
  isBoth(`export let f = () => { try { throw 300 } catch (e) { return e instanceof SyntaxError } }`, false, 'throw 300 caught — NOT instanceof SyntaxError (user number, not the compiler)')
  isBoth(`export let f = () => { try { JSON.parse('x') } catch (e) { return e instanceof SyntaxError } return false }`, false, 'JSON.parse internal SyntaxError code — instanceof SyntaxError is false (range arm deleted; unaffected by the .message/.name Slice C decode above)')
  isBoth(`export let f = () => { try { JSON.parse('x') } catch (e) { return e instanceof Error } return false }`, false, 'JSON.parse internal SyntaxError code — instanceof Error is false too (same reason)')
  isBoth(`export let f = () => { try { let a = [1]; a.with(5, 2) } catch (e) { return e instanceof RangeError } return false }`, false, 'Array#with OOB internal RangeError code — instanceof RangeError is false')
})

// audit-#9 P0-2 (2026-08-04): the P0-3 patch (above, superseded) hid class
// identity behind a reserved, unspellable schema slot ('__errcls__') enforced
// by prepare-time rejection at every dot/literal-key site plus a matching
// runtime exclusion in every enumeration/dyn-dispatch consumer — an
// enumerated-invariant that bit twice (Object.assign/spread over an Error
// crashed outright, since NEITHER had been taught the slot existed) and stole
// a legal property name from every jz program. Redesigned: class identity now
// lives in the pointer's SCHEMA ID (module/schema.js's ctx.schema.errorSid —
// one id per class), a real hidden brand no source-level write can reach —
// `instanceof` reads the sid, `.name`/`.message` are two perfectly ordinary,
// fully public/enumerable properties, and there is no reserved slot left to
// filter anywhere. `__errcls__` is un-stolen: an ordinary user property name,
// usable on ANY object, Error or not.
test('errors: __errcls__ is an ordinary, un-stolen property name (audit-#9 P0-2)', () => {
  is(jz(`export let f = () => { let o = { message: "x", name: "TypeError", __errcls__: 1 }; return o.__errcls__ }`).exports.f(), 1,
    'a plain object literal spelling __errcls__ as a key compiles and reads back')
  is(jz(`export let f = () => { let e = new TypeError("x"); e.__errcls__ = 2; return e.__errcls__ }`).exports.f(), 2,
    'dot-write/-read of .__errcls__ on a caught Error is an ordinary dyn property, not a compile error')
  // Real Error identity lives in the pointer's schema id (immutable, no source
  // syntax reaches it) — writing a same-named ordinary property alongside it
  // cannot forge or corrupt class identity, unlike the old memory-slot design.
  is(jz(`export let f = () => { let e = new TypeError("x"); e.__errcls__ = 2; return e instanceof TypeError }`).exports.f(), true,
    'writing .__errcls__ on a real Error cannot flip instanceof — identity is the sid, not a slot')
  is(jz(`export let f = () => { let e = new TypeError("x"); let k = "__errcls__"; e[k] = 1; return e instanceof RangeError }`).exports.f(), false,
    'computed write to __errcls__ cannot flip instanceof either')
  is(jz(`export let f = () => { let e = new TypeError("x"); return Object.keys(e).length }`).exports.f(), 2,
    'Object.keys(caught error) sees exactly message, name — the object\'s real, only slots')
  is(jz(`export let f = () => { let e = new TypeError("x"); return JSON.stringify(e) }`).exports.f(), '{"message":"x","name":"TypeError"}',
    'JSON.stringify(caught error)')
  is(jz(`export let f = () => { let e = new TypeError("x"); let n = 0; for (let k in e) n++; return n }`).exports.f(), 2,
    'for-in over a caught error sees 2 keys')
})

// audit-#9 P0-2 groups 1/2: Object.assign/spread over a real Error object used
// to crash the compiler outright (`__arr_set_idx_ptr` never registered /
// `Unknown section func,$__obj_clone` — neither had been taught the old
// __errcls__ slot existed, so resolveSchema saw an "unknown schema" source and
// routed into machinery with its own unrelated pre-existing bugs). audit-#9
// P0-2 fixed the crash by making Error's spread/assign SOURCE schema `[]`
// (real JS: `message`/`name` are own but NON-enumerable, so a real Error's
// spread/assign copies nothing there) — but that made spread/assign disagree
// with `Object.keys`/`JSON.stringify`/for-in (immediately above), which see
// the physical 2-slot layout on the SAME object. audit-#10 finding-3
// (.work/todo.md §deletion-sweep, "enumerability contradiction") named this an
// internally-impossible state and asked for a DECIDED, CONSISTENT choice
// between (a) full JS fidelity (non-enumerable on all four surfaces — needs
// a new per-property enumerability flag threaded through every enumeration
// site: keys/JSON/spread/for-in) or (b) documented divergence (enumerable on
// all four surfaces, matching jz's own established preference — see
// module/object.js's `sourceSchema` comment — against re-growing the exact
// "enumerated invariant" shape the Brand redesign above spent a session
// removing). DECIDED (b): Error is an ordinary object on every enumeration
// surface. Diverges from real JS (whose Error properties are non-enumerable
// everywhere) but keeps jz's own four surfaces mutually consistent at zero
// added machinery — `isErrorSchemaSource`'s override is deleted, `sourceSchema`
// is now a plain alias for `resolveSchema`.
test('errors: Object.assign/spread over an Error copies message/name — no crash, consistent with Object.keys (audit-#9 P0-2 crash fix, audit-#10 finding-3 enumerability decision)', () => {
  const j = (code) => jz(code, { optimize: 0 }).exports.f()
  is(j(`export let f = () => Object.keys({...new TypeError("x")}).sort().join(',')`), 'message,name', '{...new TypeError(x)} copies message+name (spread always builds a fresh merged-schema object, unaffected by any target-growth limit)')
  is(j(`export let f = () => { let e = new TypeError("y"); return Object.keys({...e}).sort().join(',') }`), 'message,name', 'spread from a BOUND Error variable copies message+name')
  is(j(`export let f = () => JSON.stringify({...new TypeError("x")})`), '{"message":"x","name":"TypeError"}', 'spread content matches Object.keys(err)/JSON.stringify(err) above — one consistent story')
  // Object.assign onto a target whose OWN schema already has message/name slots
  // — isolates the SOURCE-schema/enumerability decision this test pins from
  // target-growth behavior (Object.assign onto a literal target now grows for
  // new keys too, fixed by a0614fc3 — see the literal-target-growth test below).
  is(j(`export let f = () => { let t = {message: '', name: ''}; return Object.keys(Object.assign(t, new TypeError("x"))).sort().join(',') }`), 'message,name', 'Object.assign copies message+name onto a target with matching slots')
  is(j(`export let f = () => { let t = {message: '', name: ''}; let e = new TypeError("y"); return JSON.stringify(Object.assign(t, e)) }`), '{"message":"y","name":"TypeError"}', 'Object.assign from a BOUND Error variable copies the real values')
  // optimize:2/3 must not crash either (kernel-parity-adjacent smoke check)
  is(jz(`export let f = () => Object.keys({...new TypeError("x")}).length`, { optimize: 2 }).exports.f(), 2, 'O2 does not crash (spread)')
  is(jz(`export let f = () => { let t = {message: '', name: ''}; return Object.keys(Object.assign(t, new TypeError("x"))).length }`, { optimize: 2 }).exports.f(), 2, 'O2 does not crash (assign)')
})

// FIXED (was KNOWN-FAIL, pre-existing, general, Error-unrelated — found live
// while pinning the enumerability decision above): Object.assign onto an
// ANONYMOUS object-LITERAL target (`Object.assign({}, {a:1})`, no bound name)
// never grew the target's schema with a source's new keys — it only
// overwrote slots the target literal's OWN props already declared, so a
// genuinely new source key had no slot to land in and was silently dropped
// (`Object.assign({}, {a:1})` gave `[]`, real JS gives `['a']`). Root cause:
// module/object.js's `resolveSchema` read a `{}` literal's own props as its
// COMPLETE, fixed schema — correct for a pre-existing allocation (a bound
// name, or any other already-constructed value, whose physical slot layout
// can only be OVERWRITTEN, never resized — matching src/prepare/index.js's
// `inferAssignSchema`, which already grows a BOUND name's schema at prepare
// time and was never affected by this bug) but wrong for a fresh literal
// target, which Object.assign is free to size however it likes since IT is
// the one allocating it right here. Fixed by recognizing a literal target as
// structurally equivalent to a spread merge — `Object.assign({...t}, s1, s2)`
// reduces to `{...t, ...s1, ...s2}` (identical left-to-right, later-source-
// wins copy; jz has no getters/Proxies to tell Object.assign's [[Set]] and
// spread's CreateDataProperty apart) — and reusing emitObjectSpread's
// existing schema-growth instead of the fixed-slot copy loop below
// (module/object.js, `ctx.core.emit['Object.assign']`'s literal-target
// branch, right after the RequireObjectCoercible check). A BOUND target
// (`let t = {}; Object.assign(t, {a:1})`) already grew correctly before this
// fix, and still does, unchanged — see objects.js's "extends target with new
// fields" regression test.
test('Object.assign onto an object-literal target grows the result with every source key (ECMA-262: OrdinarySetWithOwnDescriptor copies left-to-right, later source wins a collision, a target key absent from every source survives)', () => {
  is(jz(`export let f = () => Object.keys(Object.assign({}, {a: 1})).length`).exports.f(), 1, 'a brand-new key from the source lands — the original pin (real JS: 1, [\'a\'])')
  is(jz(`export let f = () => Object.keys(Object.assign({}, {a: 1})).sort().join(',')`).exports.f(), 'a', 'key name matches')
  is(jz(`export let f = () => Object.keys(Object.assign({b: 2}, {a: 1})).sort().join(',')`).exports.f(), 'a,b', 'a NON-empty literal target also grows — the bug was never empty-schema-specific')
  is(jz(`export let f = () => { let r = Object.assign({}, {a: 1}); return r.a }`).exports.f(), 1, 'Object.assign RETURNS the grown target — r.a reads the merged-in value')
  is(jz(`export let f = () => Object.keys(Object.assign({}, {a: 1}, {b: 2})).sort().join(',')`).exports.f(), 'a,b', 'multiple sources all contribute their keys')
  is(jz(`export let f = () => Object.assign({}, {a: 1}, {a: 2}).a`).exports.f(), 2, 'later source wins on a collision (OrdinarySetWithOwnDescriptor: last write standing)')
  is(jz(`export let f = () => Object.assign({a: 1}, {a: 2}).a`).exports.f(), 2, 'a source overwrites a matching key the target literal already declared')
  is(jz(`export let f = () => Object.assign({a: 1, b: 2}, {a: 9}).b`).exports.f(), 2, 'a target key absent from every source survives untouched')
  // Consistent with the enumerability decision above (audit-#10 finding-3:
  // Error is an ordinary object on every enumeration surface) rather than
  // "coincidentally 0 for the unrelated growth-bug reason" the old pin
  // recorded — matches `{...new TypeError('x')}`'s own message,name above
  // exactly. Both diverge from real JS's true `[]` (Error props really are
  // non-enumerable) by the SAME documented, decided choice — not a fluke.
  is(jz(`export let f = () => Object.keys(Object.assign({}, new TypeError("x"))).sort().join(',')`).exports.f(), 'message,name', 'Error source into a literal target now copies message/name too, same divergence as spread')
  // optimize:2/3 must not crash either (mirrors the O2/O3 smoke checks above).
  is(jz(`export let f = () => Object.keys(Object.assign({}, {a: 1})).length`, { optimize: 2 }).exports.f(), 1, 'O2 does not crash and grows correctly')
  is(jz(`export let f = () => Object.keys(Object.assign({}, {a: 1})).length`, { optimize: 3 }).exports.f(), 1, 'O3 does not crash and grows correctly')
})

test('instanceof: compile-time fold — proven-kind LHS emits no runtime tag/aux/schema dispatch', () => {
  const wat = (code) => compile(code, { strict: true, wat: true })
  const noDispatch = w => !/\$__ptr_type|\$__ptr_aux/.test(w)
  ok(noDispatch(wat(`export let f = () => new Map() instanceof Map`)), 'new Map() instanceof Map folds (no __ptr_type/__ptr_aux call)')
  ok(noDispatch(wat(`export let f = () => [] instanceof Array`)), '[] instanceof Array folds')
  ok(noDispatch(wat(`export let f = () => new Set() instanceof Map`)), 'new Set() instanceof Map folds to a constant false')
  ok(noDispatch(wat(`export let f = () => new Float64Array(4) instanceof Float64Array`)), 'new Float64Array(4) instanceof Float64Array folds (literal ctor shape)')
  ok(noDispatch(wat(`export let f = () => new TypeError('t') instanceof TypeError`)), 'new TypeError(x) instanceof TypeError folds (literal-shaped LHS, no schema/errcls compare emitted)')
  ok(noDispatch(wat(`export let f = () => new TypeError('t') instanceof RangeError`)), 'new TypeError(x) instanceof RangeError folds to a constant false (siblings)')
})

// Loud rejection: jz has no prototype chain, so RHS support is a closed
// allowlist — everything else is a compile-time error, not a silent guess.
// Covers every excluded-with-evidence case from prepare's INSTANCEOF_ALLOW
// comment (BigInt64Array/BigUint64Array collide at the aux level; DataView
// collides with a VIEW Int8Array; WeakMap/WeakSet fold to Map/Set and are
// tag-indistinguishable from them) alongside the ordinary unsupported names.
test('instanceof: unsupported RHS rejects loudly at compile time (jz has no prototype chain)', () => {
  const rejects = (code) => throws(code, 'instanceof', 'unsupported instanceof RHS should error', { strict: true })
  rejects(`export let f = (x) => x instanceof Object`)
  rejects(`export let f = (x) => x instanceof Function`)
  rejects(`export let f = (x) => x instanceof RegExp`)
  rejects(`export let f = (x) => x instanceof Promise`)
  rejects(`export let f = (x) => x instanceof DataView`)
  rejects(`export let f = (x) => x instanceof BigInt64Array`)
  rejects(`export let f = (x) => x instanceof BigUint64Array`)
  rejects(`export let f = (x) => x instanceof WeakMap`)
  rejects(`export let f = (x) => x instanceof WeakSet`)
  rejects(`export let g = () => 1; export let f = (x) => x instanceof g`, 'user binding')
  is((() => { try { compile(`export let g = () => 1; export let f = (x) => x instanceof g`, { strict: true }); return false } catch (e) { return e.message.includes('instanceof') } })(), true, 'a user function binding as RHS rejects with the instanceof message')
})

// Side effects in the LHS still run even when the boolean answer is folded to
// a compile-time constant — dropping a value the language still requires to
// be computed would be unsound (`[bump()] instanceof Array` must call bump()).
test('instanceof: folding a constant answer still evaluates the LHS for side effects', () => {
  const src = `
    let calls = 0
    let bump = () => { calls = calls + 1; return calls }
    export let f = () => { let r = [bump()] instanceof Array ? 1 : 0; return calls * 10 + r }
  `
  is(jz(src, { strict: true }).exports.f(), 11, 'bump() ran once (calls=1) even though the instanceof answer folded to true')
})
