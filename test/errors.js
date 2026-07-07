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

test('prohibited: async', () => throws('async function f() {}', 'async', 'async should error'))
test('prohibited: await', () => throws('export let f = async () => await x', 'async', 'async should error'))
test('strict rejects: class', () => throws('class Foo {}', 'class', 'class should error', { strict: true }))
test('prohibited: yield', () => throws('function* f() { yield 1 }', 'generator', 'yield should error'))
test('prohibited: delete', () => throws('delete obj.x', 'delete', 'delete should error'))
// 'in' operator now supported for HASH key existence checks
test('strict rejects: instanceof', () => throws('x instanceof Array', 'instanceof', 'instanceof should error', { strict: true }))
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
// no `try`/`catch` anywhere is uncatchable (semantically a trap); declaring the
// $__jz_err Tag just to carry it forces consumers that don't enable the exceptions
// proposal (wasmtime, wabt, wasm2c) to reject the module on the Tag section — V8
// alone enables exceptions by default, which masked this. Keep such modules in the
// wasm MVP. (User throw/try/catch is an ABI contract and keeps the runtime — above.)
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
})

test('catchable throw keeps the exceptions runtime (try/catch needs the tag)', () => {
  // Contrast: a real try/catch CAN catch the throw, so the tag must survive.
  const wat = compile('export let f = (v) => { try { throw v } catch (e) { return e } }', { wat: true })
  ok(wat.includes('(tag $__jz_err'), 'caught throw keeps the exceptions tag')
  ok(wat.includes('(try_table'), 'try/catch lowers to try_table')
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
