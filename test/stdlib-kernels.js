// Kernels from compiling stdlib (@stdlib/stdlib 0.4.1) unmodified. Each is the
// smallest program of a shape the library repeats in every package: ES5 `var`,
// the CommonJS `index.js` re-export hop, libm guards, strided loops. None needs
// stdlib to run. An open class is `test.todo`; flip it to `test` when the whole
// class compiles right. Reference values are what the host computes for the
// same source (`agree`, or `host` for a module graph), never a literal.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { agree, wat, oracle, run } from './util.js'
import { ownedLevels } from './_matrix.js'

const SPEED = { optimize: { level: 'speed' } }
const graph = (src, modules, ...args) => jz(src, { modules }).exports.f(...args)
const count = (text, re) => (text.match(re) || []).length
const shape = (src, modules) => wat(src, { ...SPEED, modules })
// an export whose parameters and result are plain f64 takes a number unwrapped
const takesF64 = (src) => {
  const raw = new WebAssembly.Instance(new WebAssembly.Module(jz.compile(src, SPEED)), {}).exports
  try { return typeof raw.f(0.5) === 'number' } catch { return false }
}

// ── Values ──────────────────────────────────────────────────────────────────

// A boolean returned through a function VALUE (an alias, or a default export
// re-exported by another module) arrives as the number 0/1: `=== false` and
// `typeof` both miss. Live: every stdlib predicate sits behind an index.js hop,
// and `isInteger( y ) === false` guards pow's negative-base branch, so
// pow(-1, 2.5) returns 1 where JS returns NaN.
test('stdlib: boolean through an aliased function value keeps its identity', () => {
  const src = `function isInt(x) { return (Math.floor(x) === x) }
    var isInteger = isInt
    export let f = (y) => (isInteger(y) === false) ? 1 : 0`
  agree(src, 'f', [2.5]); agree(src, 'f', [2])
})
test('stdlib: boolean through a function value chosen at run time keeps its identity', () => {
  const src = `function isInt(x) { return (Math.floor(x) === x) }
    function isPos(x) { return x > 0 }
    export let f = (y, k) => { let g = k ? isInt : isPos; return (g(y) === false) ? 1 : 0 }`
  for (const args of [[2.5, 1], [-1, 0], [3, 1]]) agree(src, 'f', args)
})
test('stdlib: boolean through a default re-export hop keeps its identity', () => {
  const host = (y) => ((Math.floor(y) === y) === false) ? 1 : 0
  const modules = {
    './i.js': `import main from './m.js'\nexport default main`,
    './m.js': `function isInteger(x) { return (Math.floor(x) === x) }\nexport default isInteger`,
  }
  const src = `import isInteger from './i.js'\nexport let f = (y) => (isInteger(y) === false) ? 1 : 0`
  is(graph(src, modules, 2.5), host(2.5)); is(graph(src, modules, 2), host(2))
})

// A module global is stored as i32 unless a fraction is proven. The proof
// follows the value to its source (a local's definitions, a callee's returns
// and arguments), a constant outside the i32 range is exact only in f64, and a
// copy is a read: `const d = G` at module level, `x * d` in a function. Live:
// constants/float32/pi (acosf(-1) returned 3), constants/float64/max, dnrm2's
// tbig/tsml (dnrm2 returned 0).
test('stdlib: global initialized through an imported function alias keeps its fraction', () => {
  const modules = {
    './c.js': `import fr from './fr.js'\nvar C = fr(1.5707963267948966)\nexport default C`,
    './fr.js': `var fr = Math.fround\nexport default fr`,
  }
  is(graph(`import C from './c.js'\nexport let f = (x) => x + C`, modules, 0), 0 + Math.fround(1.5707963267948966))
})
test('stdlib: imported global beyond the i32 range keeps its value', () => {
  const modules = { './b.js': `var FLOAT64_MAX = 1.7976931348623157e308\nexport default FLOAT64_MAX` }
  is(graph(`import BIG from './b.js'\nexport let f = (x) => x * BIG`, modules, 0.5), 0.5 * 1.7976931348623157e308)
})
test('stdlib: var global beyond the i32 range, read only by comparisons, keeps its value', () => {
  const src = `var tsml = 1.4916681462400413E-154
    var tbig = 1.997919072202235E+146
    export let f = (x) => { var ax = Math.abs(x); if (ax > tbig) { return 1 } if (ax < tsml) { return 2 } return 3 }`
  for (const x of [1, 1e200, 1e-200]) agree(src, 'f', [x])
})
test('stdlib: a global keeps its value through every path to a read', () => {
  const rows = [
    ['copied to a local', `var K = 3000000000\nexport let f = (x) => { let k = K; return x + k }`, 0.5],
    ['copied to a global', `var K = 3000000000\nvar D = K\nexport let f = (x) => x + D`, 0.5],
    ['compared and copied', `var K = 1e300\nexport let f = (x) => { if (x > K) return 1; let k = K; return k }`, 0.5],
    ['beyond i32, compared', `var K = 3000000000\nexport let f = (x) => (x > K) ? 1 : 0`, 1],
    ['product beyond i32, compared', `var K = 65536 * 65536\nexport let f = (x) => (x > K) ? 1 : 0`, 1],
    ['fraction returned by a function', `function half(x) { return x * 0.5 }\nvar C = half(3)\nexport let f = (x) => (x > C) ? 1 : 0`, 1.2],
    ['fraction returned, then copied', `function half(x) { return x * 0.5 }\nvar C = half(3)\nvar D = C\nexport let f = (x) => x + D`, 1],
    ['fraction passed through a function', `function id(x) { return x }\nvar C = id(1.5)\nexport let f = (x) => (x > C) ? 1 : 0`, 1.2],
    ['fraction from an aliased builtin', `var fr = Math.fround\nvar C = fr(1.5707963267948966)\nexport let f = (x) => (x > C) ? 1 : 0`, 1.2],
    ['fraction carried by a local', `var G = 0\nexport let f = (x) => { let t = 0.5; G = t; return (x > G) ? 1 : 0 }`, 0.2],
    ['fraction through abs', `var C = Math.abs(-1.5)\nexport let f = (x) => (x > C) ? 1 : 0`, 1.2],
  ]
  for (const [label, src, x] of rows) agree(src, 'f', [x], undefined, label)
})
// Integer storage holds where the proof holds.
test('stdlib: control, integer globals stay i32', () => {
  agree(`var h = 2166136261\nexport let f = (c) => { h = Math.imul(h ^ c, 16777619); return h >>> 0 }`, 'f', [97])
  agree(`var n = 0\nexport let f = (x) => { n = 0; for (let i = 0; i < x; i++) n++; return n }`, 'f', [7])
  const text = shape(`var W = 0\nconst M = new Float64Array(4096)
    export let init = (w) => { W = w | 0; return 0 }
    export let f = (x, y) => M[y * W + x]`)
  ok(/\(global \$W\s+\(mut i32\)/.test(text), 'a size stays i32')
})

// An alias of an alias, through `var`s written once (esbuild's bundle of a
// stdlib package: `var main_default = isnan; var lib_default = main_default`),
// of a function the same list declares, of a builtin member and of a builtin
// constant, read by a hoisted function too: each binds to what the chain names.
test('stdlib: an alias chain binds to the function, member or constant it names', () => {
  agree(`function isnan(x) { return x !== x }\nvar main_default = isnan\nvar lib_default = main_default\nvar floor = Math.floor\nvar main_default2 = floor\nvar lib_default2 = main_default2\nfunction trunc(x) { if (lib_default(x)) { return NaN } return lib_default2(x) }\nvar main_default3 = trunc\nvar lib_default3 = main_default3\nexport let f = (x) => lib_default3(x)`, 'f', [2.5])
  agree(`var PINF = Number.POSITIVE_INFINITY\nvar main_default = PINF\nvar lib_default = main_default\nexport let f = (x) => x === lib_default ? 1 : 0`, 'f', [Infinity])
  agree(`var fr = Math.fround\nvar a = fr\nvar b = a\nfunction g(x) { return b(x) }\nexport let f = (x) => g(x)`, 'f', [0.1])
  agree(`function isnan(x) { return x !== x }\nvar a = isnan\nvar b = a\nfunction g(x) { if (b(x)) { return 1 } return x * 2 }\nvar c = g\nvar d = c\nexport let f = (x) => d(x)`, 'f', [2.5])
})

// A builtin constructor bound to a name is the namespace, in a hoisted function
// too. Live: number/ctor (`module.exports = Number`, read as
// `Number.NEGATIVE_INFINITY` by constants/float64/ninf) and array/float64
// (`var Float64Array = require(…)`).
test('stdlib: static property through an aliased constructor', () => {
  agree(`const N = Number\nconst NINF = N.NEGATIVE_INFINITY\nexport let f = (x) => x + NINF`, 'f', [2.5])
  agree(`const N = Number\nfunction g(x) { return x + N.NEGATIVE_INFINITY }\nexport let f = (x) => g(x)`, 'f', [2.5])
})
test('stdlib: typed array constructor bound to a name', () => {
  agree(`const F = Float64Array\nconst v = new F(1)\nexport let f = (x) => { v[0] = x; return v[0] }`, 'f', [2.5])
})

// An alias of an import read inside a hoisted function declaration: jzify lists
// function bodies first, so the alias binds ahead of them (a `var` written once
// is a `const` by then). Live: `var lanczosSumExpGScaled = require(…)` in beta.
test('stdlib: const alias of an import read by a hoisted function', () => {
  const host = (x) => 0.5 + ((x * x) * 2.0)
  const modules = { './a.js': `function ea(x) { return 0.5 + (x * 2.0) }\nexport default ea`, './i.js': `import ea from './a.js'\nexport default ea` }
  for (const kw of ['const', 'let', 'var']) {
    is(graph(`import r from './a.js'\n${kw} p = r\nfunction k(x) { return p(x * x) }\nexport let f = (x) => k(x)`, modules, 2), host(2), kw)
    is(graph(`import r from './i.js'\nfunction k(x) { return p(x * x) }\n${kw} p = r\nexport let f = (x) => k(x)`, modules, 2), host(2), `${kw} through a hop, declared after the function`)
  }
})

// `fn.apply(null, args)` on an imported function, args built at run time.
// Live: maxabsn's `max.apply( null, args )` over a re-exported variadic maxn.
test('stdlib: apply on an imported function with a run-time argument array', () => {
  const modules = { './m.js': `function maxn(x, y) { var len, m, i\n len = arguments.length\n if (len === 2) { return x > y ? x : y }\n m = -Infinity\n for (i = 0; i < len; i++) { if (arguments[i] > m) { m = arguments[i] } }\n return m }\nexport default maxn` }
  const src = `import max from './m.js'\nfunction wrap(x, y) { var n, args, i\n n = arguments.length\n if (n === 2) { return max(x, y) }\n args = []\n for (i = 0; i < n; i++) { args.push(arguments[i]) }\n return max.apply(null, args) }\nexport let f = (x, y) => wrap(x, y)\nexport let g = (x, y, z) => wrap(x, y, z)`
  const e = jz(src, { modules }).exports
  is(e.f(1, 2), 2); is(e.g(1, 5, 3), 5)
})

// `??=` tests its target as it is: a bare `let` read back through it is no NaN.
test('stdlib: a returned local assigned through ??= keeps undefined apart from NaN', () => {
  agree(`export let f = () => { let a; a ??= 41; a += 1; return a }`, 'f', [])
})
test('stdlib: feature detection sees a builtin before its first use', () => {
  is(jz(`export let f = (x) => (typeof Symbol === 'function') ? 1 : x`).exports.f(2.5), 1)
  const names = ['Symbol', 'Object', 'Number', 'String', 'Boolean', 'Date', 'Map', 'Set', 'RegExp', 'Promise', 'Error', 'Function',
    'Math', 'JSON', 'Math.PI', 'Math.random', 'Date.now', 'console', 'console.log', 'performance', 'performance.now', 'parseInt', 'isNaN']
  const source = `export let f = () => [${names.map(name => `typeof ${name}`).join(',')}]`
  is(run(source).f(), oracle(source).f(), 'builtins have their declared types without a call')
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(jz.compile(source)))
  ok(!imports.some(i => /rng|clock|time/i.test(i.name)), 'typeof does not request random numbers or read the clock')
})

test('stdlib: builtin typeof follows aliases and respects shadowed bindings', () => {
  for (const source of [
    `const S = Symbol; export let f = () => typeof S`,
    `export let f = () => { const S = Symbol; return typeof S }`,
    `const random = Math.random; export let f = () => typeof random`,
    `const { now } = Date; export let f = () => typeof now`,
    `const P = performance; const { now } = P; export let f = () => typeof now`,
    `const C = console; const { log } = C; export let f = () => typeof log`,
    `export let f = () => Date.hasOwnProperty('now') ? 1 : 0`,
    `export let f = () => typeof Math['random']`,
    `export let f = () => { const performance = { now: 3 }; return typeof performance.now }`,
    `const Symbol = 3; export let f = () => typeof Symbol`,
    `export let f = () => { const Symbol = 3; return typeof Symbol }`,
    `export let f = () => { const pick = Symbol => typeof Symbol; return pick('value') }`,
    `const parseInt = 3; export let f = () => typeof parseInt`,
    `const Math = { sin: 3 }; export let f = () => typeof Math.sin`,
  ]) is(run(source).f(), oracle(source).f(), source)
  is(graph(`import { Symbol } from './value.js'; export let f = () => typeof Symbol`,
    { './value.js': 'export const Symbol = 3' }), 'number', 'imported binding shadows the constructor')
})

test('stdlib: namespace introspection preserves booleans, aliases and user bindings', () => {
  for (const source of [
    `export let f = () => [Date.hasOwnProperty('now'), Date.hasOwnProperty('missing')]`,
    `export let f = () => { const D = Date; return [D.hasOwnProperty('prototype'), D.hasOwnProperty('now')] }`,
    `export let f = () => { const M = Math; return Array.isArray(M) === false }`,
    `const A = Array; const M = Math; export let f = () => A.isArray(M) === false`,
    `const Math = []; export let f = () => Array.isArray(Math)`,
    `const Array = { isArray: x => x + 1 }; export let f = () => Array.isArray(3)`,
    `const Date = {}; export let f = () => Date.hasOwnProperty('now')`,
  ]) agree(source, 'f', [])
  is(graph(`import { Math } from './value.js'; export let f = () => Array.isArray(Math)`,
    { './value.js': 'export const Math = []' }), true, 'an imported binding keeps its own identity')
})

// ── Numeric proof ───────────────────────────────────────────────────────────

// A parameter returned as itself keeps its identity for the host (`fib('1')`
// is '1', test/audit-regressions.js), so the export boxes it. A return under a
// guard only a number passes (`x !== x`, `x === 0.0`, `isnan( x )`,
// `isInfinite( x )`) gives back a number, never the value itself: those keep
// the f64 export, directly and through a wrapper (`export let f = (x) => fn(x)`,
// the stdlib driver shape). Live: `if ( isnan( x ) ) { return x; }` opens
// nearly every math/base/special function.
test('stdlib: a parameter returned under a numeric guard keeps the f64 export', () => {
  const isnan = `function isnan(v) { return v !== v }\n`
  const isinf = `const PINF = Infinity, NINF = -Infinity\nfunction isinf(v) { return v === PINF || v === NINF }\n`
  ok(takesF64(`export let f = (x) => { if (x !== x) { return x } return x * 2 }`), 'x !== x')
  ok(takesF64(isnan + `export let f = (x) => { if (isnan(x)) { return x } return x * 2 }`), 'a predicate')
  ok(takesF64(isnan + isinf + `export let f = (x) => { if (isnan(x) || isinf(x)) { return x } return x * 2 }`), 'either of two predicates, one through module constants')
  ok(takesF64(isnan + `export let f = (x) => isnan(x) ? x : x * 2`), 'a conditional arm')
  ok(takesF64(isnan + `function g(x) { if (isnan(x)) { return x } return x * 2 }\nexport let f = (x) => g(x)`), 'through a wrapper')
  ok(!takesF64(`export let f = (x) => { if (x < 2) { return x } return x * 2 }`), 'a relational guard passes a string: the identity stays')
  ok(!takesF64(`export let f = (x) => { if (x === true) { return 1 } return x * 2 }`), 'an equality against a boolean tells the type apart: boxed')
  const src = isnan + isinf + `export let f = (x) => { if (isnan(x) || isinf(x)) { return x } return x * 2 }`
  const got = run(src).f, expected = oracle(src).f
  for (const x of [NaN, Infinity, -0, 0.5]) ok(Object.is(got(x), expected(x)), `f(${x})`)
})

// Three uses that are numeric-compatible and prove nothing on their own drop a
// parameter to the boxed representation: the export becomes (i64) → i64 (a
// BigInt round trip per call, measured 40× slower than the f64 export) and
// every operation on it carries a conversion. The tiny-argument early-out
// returns the parameter under a test of another value (`ix`, its high word): a
// string would come back as itself, so the export stays boxed by design.
test('stdlib: x !== x on a parameter stays numeric', () => {
  ok(jz.compile(`export let f = (x) => (x !== x) ? 0 : x * 2`, SPEED).byteLength < 400)
})
test('stdlib: x === K against an imported numeric constant stays numeric', () => {
  const modules = { './p.js': `var P = Number.POSITIVE_INFINITY\nexport default P` }
  ok(jz.compile(`import P from './p.js'\nexport let f = (x) => (x === P) ? 0 : x * 2`, { ...SPEED, modules }).byteLength < 400)
})
test('stdlib: an isnan guard before arithmetic keeps the f64 export', () => {
  ok(takesF64(`function isnan(x) { return (x !== x) }
    function s(x) { if (isnan(x)) { return NaN } return x * 2 }
    export let f = (x) => s(x)`))
})
// A value returned to the host as itself keeps its identity (`fib('1')` is
// '1', test/audit-regressions.js): a parameter returned by an exported function,
// through any callee, stays boxed. The tiny-argument early-out is that shape.
test('stdlib: an early return of the original parameter preserves its identity', () => {
  const source = `const F = new Float64Array(1)
    const U = new Uint32Array(F.buffer)
    function hi(x) { F[0] = x; return U[1] }
    function kern(x, y) { var z = x * x; return x + z * (y + z * 0.5) }
    function s(x) { var ix = hi(x) & 0x7fffffff; if (ix < 0x3e500000) { return x } if (ix <= 0x3fe921fb) { return kern(x, 0.0) } return NaN }
    export let f = (x) => s(x)`
  ok(!takesF64(source), 'a word test after conversion cannot narrow the original value')
  const f = run(source).f, host = oracle(source).f
  for (const x of [0, -0, 1e-20, '1e-20', '', false, null, 0.5, NaN])
    ok(Object.is(f(x), host(x)), `identity and value of ${String(x)}`)
})

// A module constant read from a float view, or computed by a call this pass
// cannot name with a fractional argument, is no integer. Live: every float32
// constant (`UINT32[0] = 0x7f800000; PINF = FLOAT32[0]`, asinhf's
// `NEAR_ZERO = f32( ONE / HUGE )` through the selected fround).
// `same`: the host's value bit for bit, a signed zero included
const same = (src, ...xs) => { const want = oracle(src).f(...xs), got = run(src).f(...xs); ok(Object.is(got, want), `f(${xs.map(String).join(', ')}) = ${got}, host ${want}`) }
test('stdlib: a module constant from a float view keeps its fraction', () => {
  for (const x of [-1, 1.5]) agree(`const F = new Float64Array(1)\nF[0] = 1.5\nconst C = F[0]\nexport let f = (x) => x === C ? x : C`, 'f', [x])
  for (const x of [Infinity, 2]) agree(`const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer)\nU32[0] = 0x7f800000\nconst PINF = F32[0]\nexport let f = (x) => x === PINF ? 1 : 0`, 'f', [x])
  for (const x of [-1, Infinity]) agree(`const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer)\nU32[0] = 0x7f800000\nconst PINF = F32[0]\nfunction g(x) { return x === PINF ? x : PINF }\nexport let f = (x) => g(x)`, 'f', [x])
})
test('stdlib: a module constant computed through a selected function keeps its fraction', () => {
  const src = `const b = Math.fround\nfunction poly(x) { return x }\nvar fr\nif (typeof b === 'function') { fr = b } else { fr = poly }\nvar ONE = fr(1.0), HUGE = fr(1 << 28), NEAR = fr(ONE / HUGE)\nexport let f = (x) => x < NEAR ? x : 1.0`
  for (const x of [-0, 1e-12, 0.5]) same(src, x)
})

// A zero remainder is signed like the dividend (`-4 % 2` is -0). Live: sinpi's
// `x % 2.0`, sind's `fmod( x, 360.0 )`.
test('stdlib: a zero remainder by a literal keeps the dividend\'s sign', () => {
  for (const x of [-0, -4, -3, 3.5]) same(`export let f = (x) => x % 2.0`, x)
  for (const x of [-0, -720, 7]) same(`export let f = (x) => { var r = x % 360.0; if (r === 0.0) { return r } return 1.0 }`, x)
})
// The additive identity must keep a zero's sign: `0.0 + x` of -0 is +0, which
// `1 / that` tells from -0 (an integer x cannot be -0, so its fold stands).
// Live: the constant term of gamma-lanczos-sum's Horner sum, `0.0 + (x * (…))`,
// whose product is -0 at -1.
test('stdlib: the additive identity keeps the sign of zero', () => {
  for (const x of [-0, 0, -1]) same(`export let f = (x) => 1 / (0.0 + x)`, x)
  for (const x of [-0, 0, -1]) same(`export let f = (x) => 1 / (x + 0.0)`, x)
  for (const x of [-45, -1, 2]) same(`export let f = (x) => 1 / (0.0 + (x * (45.0 + (x * 1.0))))`, x)
})

// A module `var` written once, by its initializer, is a constant. Live: every
// module-level binding in stdlib is `var`.
test('stdlib: module var typed array written once needs no nullish guard', () => {
  const text = shape(`var F = new Float64Array(1)\nvar U = new Uint32Array(F.buffer)\nexport let f = (x) => { F[0] = x; return U[1] }`)
  is(count(text, /call \$__throw_property_nullish/g), 0)
})

// Load-time selection between a builtin and a polyfill has one answer at
// compile time. Live: number/float64/base/to-float32 picks Math.fround this
// way, and the whole float32 family (asinf, atanf, …) calls it per operation.
test('stdlib: builtin-or-polyfill selection folds to the builtin', () => {
  ok(jz.compile(`var b = (typeof Math.fround === 'function') ? Math.fround : null
    function poly(x) { return x }
    var fr
    if (typeof b === 'function') { fr = b } else { fr = poly }
    export let f = (x) => fr(x)`, SPEED).byteLength < 200)
  // through a hoisted helper the arguments reach the builtin typed; a call of
  // the value wrapper would box them and pull the string runtime along
  const text = shape(`const b = Math.fround
    function poly(x) { return x }
    var fr
    if (typeof b === 'function') { fr = b } else { fr = poly }
    function p(x) { if (x === 0.0) { return -0.3 } return fr(-0.3 + fr(x * 0.08)) }
    export let f = (x) => fr(p(x))`)
  is(count(text, /\$__to_str\b/g), 0)
  is(count(text, /\$__to_num\b/g), 0)
})

// A function carrying a static property, reached through a re-export. Live:
// `toWords.assign( x, WORDS, 1, 0 )` in pow, ldexp, copysign.
test('stdlib: function static property through a re-export hop calls directly', () => {
  const text = shape(`import m from './i.js'\nexport let f = (x) => m.assign(x) + m(x)`, {
    './i.js': `import main from './m.js'\nimport assign from './a.js'\nmain.assign = assign\nexport default main`,
    './m.js': `function main(x) { return x + 1 }\nexport default main`,
    './a.js': `function assign(x) { return x * 2 }\nexport default assign`,
  })
  is(count(text, /call_indirect|call \$__dyn_get/g), 0)
})

// ── Loops ───────────────────────────────────────────────────────────────────

const N = 1000
const dot = (body) => `const X = new Float64Array(${N})\nconst Y = new Float64Array(${N})
  ${body}
  export let f = (n) => dot(n, X, Y)`
const vectorizes = (src) => ok(/v128/.test(shape(src)), 'vectorizes')

test('stdlib: control, let accumulator with initializer vectorizes', () => {
  vectorizes(dot(`function dot(n, x, y) { let t = 0.0; for (let i = 0; i < n; i++) { t += x[i] * y[i] } return t }`))
})

// A loop-carried accumulator is held present only as `let t = <number>`. Every
// other spelling keeps a null/undefined test on it inside the loop and blocks
// the vectorizer (measured 3× to 12× behind V8 where the control is 5× ahead).
// Live: stdlib declares every local at the top of the function, then assigns.
test('stdlib: var accumulator with initializer vectorizes', () => {
  vectorizes(dot(`function dot(n, x, y) { var t = 0.0; for (let i = 0; i < n; i++) { t += x[i] * y[i] } return t }`))
})
test('stdlib: var declared at the top, assigned before the loop, vectorizes', () => {
  vectorizes(dot(`function dot(n, x, y) { var t; var i; t = 0.0; for (i = 0; i < n; i++) { t += x[i] * y[i] } return t }`))
})
test('stdlib: let declared bare, assigned before the loop, vectorizes', () => {
  vectorizes(dot(`function dot(n, x, y) { let t; t = 0.0; for (let i = 0; i < n; i++) { t += x[i] * y[i] } return t }`))
})

// The strided API walks a cursor beside the counter, starts its main loop at a
// remainder, and unrolls by hand (reference BLAS). Live: blas/base/ddot,
// daxpy, dscal, dasum; stats/strided; blas/ext/base.
test('stdlib: cursor induction variable beside the counter vectorizes', () => {
  vectorizes(dot(`function dot(n, x, y) { let t = 0.0, ix = 0; for (let i = 0; i < n; i++) { t += x[ix] * y[ix]; ix += 1 } return t }`))
})
test('stdlib: loop starting at a computed bound vectorizes', () => {
  vectorizes(dot(`function dot(n, x, y) { let t = 0.0; const m = n % 4; for (let i = m; i < n; i++) { t += x[i] * y[i] } return t }`))
})
test('stdlib: hand-unrolled body vectorizes', () => {
  vectorizes(dot(`function dot(n, x, y) { let t = 0.0, ix = 0; const m = n % 4
    for (let i = 0; i < m; i++) { t += x[ix] * y[ix]; ix += 1 }
    for (let i = m; i < n; i += 4) { t += (x[ix] * y[ix]) + (x[ix+1] * y[ix+1]) + (x[ix+2] * y[ix+2]) + (x[ix+3] * y[ix+3]); ix += 4 }
    return t }`))
})

// A helper over an element is the element's own operation: `abs( x[ ix ] )` is
// what every strided kernel of math/strided/special and stats/strided calls.
test('stdlib: a pure helper called on an element read inlines and vectorizes', () => {
  const text = shape(dot(`function abs(v) { return Math.abs(v) }
    function dot(n, x, y) { let t = 0.0; for (let i = 0; i < n; i++) { t += abs(x[i]) } return t }`))
  is(count(text, /call \$\S*abs/g), 0)
  ok(/v128/.test(text), 'vectorizes')
})
// The element of an in-place kernel is added to: `y[i] += a * x[i]` (daxpy).
test('stdlib: an element added to a proven number is a numeric element', () => {
  for (const stmt of ['y[i] += a * x[i]', 'y[i] = y[i] + a * x[i]']) {
    const text = shape(`export let f = (n, a, x, y) => { for (let i = 0; i < n; i++) { ${stmt} } return 0 }`)
    is(count(text, /call \$__typed_idx|call \$__dyn_/g), 0, stmt)
    ok(/v128/.test(text), stmt + ' vectorizes')
  }
})
// An inlined call in statement position leaves nothing behind that reads its arguments.
test('stdlib: a forwarded in-place kernel whose result is dropped stays typed', () => {
  const text = shape(`function axpy(n, a, x, y) { for (let i = 0; i < n; i++) { y[i] += a * x[i] } return y }
    export let f = (n, a, x, y) => { axpy(n, a, x, y); return 0 }`)
  is(count(text, /call \$__typed_idx|call \$__dyn_/g), 0)
})

// Arrays that arrive as parameters of an export.
test('stdlib: control, array parameters at unit stride vectorize', () => {
  vectorizes(`function dot(n, x, y) { let t = 0.0; for (let i = 0; i < n; i++) { t += x[i] * y[i] } return t }
    export let f = (n, x, y) => dot(n, x, y)`)
})
test('stdlib: array parameters with stride and offset index statically', () => {
  const text = shape(`function dot(n, x, sx, ox, y, sy, oy) { let t = 0.0, ix = ox, iy = oy; for (let i = 0; i < n; i++) { t += x[ix] * y[iy]; ix += sx; iy += sy } return t }
    export let f = (n, x, sx, ox, y, sy, oy) => dot(n, x, sx, ox, y, sy, oy)`)
  is(count(text, /call \$__typed_idx|call \$__dyn_|call \$__to_num/g), 0)
})
test('stdlib: a kernel returning its array parameter indexes statically', () => {
  const text = shape(`function axpy(n, a, x, y) { for (let i = 0; i < n; i++) { y[i] += a * x[i] } return y }
    export let f = (n, a, x, y) => axpy(n, a, x, y)`)
  is(count(text, /call \$__typed_idx|call \$__dyn_|call \$__to_num/g), 0)
})

// ── Counted loops against the host ──────────────────────────────────────────

// A loop rewritten over its trip number (plan/counted-loops.js) runs what the
// source runs: every shape below agrees with the host on each input, at each
// level, the cursors' landings and the trip count of a fractional, negative
// or NaN bound included. The data are multiples of 1/16, so a sum is exact in
// any order and a lane reduction has nothing to round differently.
const LEN = 64
const FIELD = `const X = new Float64Array(${LEN})\nconst Y = new Float64Array(${LEN})
export let init = () => { for (let i = 0; i < ${LEN}; i++) { X[i] = i * 1.25 - 7; Y[i] = 3 - i * 0.5 } return 0 }\n`
const sumOf = (a, w) => `let s = 0; for (let j = 0; j < ${LEN}; j++) s += ${a}[j] * (j + ${w}); `
const COUNTED = [
  ['cursor in a reduction', `export let f = (n, o) => { let t = 0.0, ix = o; for (let i = 0; i < n; i++) { t += X[ix] * Y[ix]; ix += 1 } return t + ix }`,
    [[10, 0], [10, 3], [0, 5], [-2, 1], [7.5, 2], [NaN, 0], [60, 4]]],
  ['cursor in a map, landing read', `export let f = (n, o) => { let ix = o; for (let i = 0; i < n; i++) { Y[ix] += 2.5 * X[ix]; ix += 1 } ${sumOf('Y', 1)}return s + ix }`,
    [[10, 0], [20, 7], [0, 1], [3.2, 0]]],
  ['two cursors, steps 2 and 3', `export let f = (n) => { let t = 0.0, a = 1, b = 2; for (let i = 0; i < n; i++) { t += X[a] - Y[b]; a += 2; b += 3 } return t + a * 1000 + b }`,
    [[5], [0], [12], [20]]],
  ['a read after the step', `export let f = (n) => { let t = 0.0, ix = 0; for (let i = 0; i < n; i++) { t += X[ix]; ix += 1; t -= Y[ix] } return t }`,
    [[5], [30], [0]]],
  ['cursor stepping down', `export let f = (n) => { let t = 0.0, ix = ${LEN - 1}; for (let i = 0; i < n; i++) { t += X[ix] * 2; ix -= 1 } return t + ix }`,
    [[5], [LEN], [0]]],
  ['computed start', `export let f = (n, m) => { let t = 0.0; for (let i = m; i < n; i++) { t += X[i] * Y[i] } return t }`,
    [[10, 2], [10, 0], [10, 10], [10, 12], [10.5, 3], [NaN, 1], [5, NaN], [40, -0]]],
  ['computed start, step 4', `export let f = (n) => { let t = 0.0; const m = n % 4; for (let i = m; i < n; i += 4) { t += X[i] + X[i + 1] + X[i + 2] + X[i + 3] } return t }`,
    [[16], [17], [18], [19], [3], [0]]],
  ['inclusive bound', `export let f = (n, m) => { let t = 0.0, ix = 1; for (let i = m; i <= n; i++) { t += X[ix]; ix += 2 } return t + ix }`,
    [[10, 2], [2, 2], [1, 2], [9.5, 0]]],
  ['ddot: remainder, then unrolled by 5', `export let f = (n) => { let t = 0.0, ix = 0, iy = 0; const m = n % 5
      if (m > 0) { for (let i = 0; i < m; i++) { t += X[ix] * Y[iy]; ix += 1; iy += 1 } }
      if (n < 5) { return t }
      for (let i = m; i < n; i += 5) { t += (X[ix] * Y[iy]) + (X[ix+1] * Y[iy+1]) + (X[ix+2] * Y[iy+2]) + (X[ix+3] * Y[iy+3]) + (X[ix+4] * Y[iy+4]); ix += 5; iy += 5 }
      return t }`, [[0], [1], [4], [5], [6], [23], [60]]],
  ['daxpy: remainder, then unrolled by 4', `export let f = (n, al) => { let ix = 0, iy = 0; const m = n % 4
      if (m > 0) { for (let i = 0; i < m; i++) { Y[iy] += al * X[ix]; ix += 1; iy += 1 } }
      if (n >= 4) { for (let i = m; i < n; i += 4) { Y[iy] += al * X[ix]; Y[iy+1] += al * X[ix+1]; Y[iy+2] += al * X[ix+2]; Y[iy+3] += al * X[ix+3]; ix += 4; iy += 4 } }
      ${sumOf('Y', 1)}return s }`, [[0, 2], [3, 2], [4, 2], [7, 1.5], [33, -0.5], [60, 3]]],
  ['dswap: groups of three, unrolled by 3', `export let f = (n) => { let tmp = 0.0, ix = 0, iy = 0; const m = n % 3
      if (m > 0) { for (let i = 0; i < m; i++) { tmp = X[ix]; X[ix] = Y[iy]; Y[iy] = tmp; ix += 1; iy += 1 } }
      if (n >= 3) { for (let i = m; i < n; i += 3) { tmp = X[ix]; X[ix] = Y[iy]; Y[iy] = tmp; tmp = X[ix+1]; X[ix+1] = Y[iy+1]; Y[iy+1] = tmp; tmp = X[ix+2]; X[ix+2] = Y[iy+2]; Y[iy+2] = tmp; ix += 3; iy += 3 } }
      let s = 0; for (let j = 0; j < ${LEN}; j++) s += X[j] * (j + 1) - Y[j] * (j + 2); return s }`, [[0], [1], [2], [3], [10], [31], [64]]],
  ['dscal: unrolled by 5', `export let f = (n, al) => { let ix = 0; const m = n % 5
      if (m > 0) { for (let i = 0; i < m; i++) { X[ix] *= al; ix += 1 } }
      if (n >= 5) { for (let i = m; i < n; i += 5) { X[ix] *= al; X[ix+1] *= al; X[ix+2] *= al; X[ix+3] *= al; X[ix+4] *= al; ix += 5 } }
      ${sumOf('X', 1)}return s }`, [[0, 2], [4, 2], [5, 2], [6, 1.5], [33, -0.5], [64, 3]]],
  ['unrolled over the counter by 3', `export let f = (n) => { let t = 0.0; for (let i = 0; i < n; i += 3) { t += X[i] * 2 + X[i + 1] * 2 + X[i + 2] * 2 } return t }`,
    [[0], [3], [9], [10], [60]]],
  ['a map over itself, shifted by one', `export let f = (n) => { let ix = 0, iy = 1; for (let i = 0; i < n; i += 2) { X[iy] += X[ix]; X[iy+1] += X[ix+1]; ix += 2; iy += 2 } ${sumOf('X', 1)}return s }`,
    [[0], [2], [10], [40]]],
  ['stride tested against 1', `export let f = (n, sx, o) => { let t = 0.0, ix = o
      if (sx === 1) { for (let i = 0; i < n; i++) { t += X[ix]; ix += sx } return t }
      for (let i = 0; i < n; i++) { t += X[ix] * 2; ix += sx } return t }`, [[10, 1, 0], [10, 2, 1], [5, 1, 3], [6, 3, 0]]],
  ['stride a parameter (dasum)', `export let f = (n, sx, o) => { let t = 0.0, ix = o; for (let i = 0; i < n; i++) { t += Math.abs(X[ix]); ix += sx } return t + ix }`,
    [[10, 1, 0], [10, 2, 1], [5, 1, 3], [6, 3, 0], [0, 1, 2], [8, -1, 20]]],
  ['cursor read as a value', `export let f = (n) => { let t = 0.0, ix = 0; for (let i = 0; i < n; i++) { t += X[ix] + ix; ix += 1 } return t }`,
    [[10], [0]]],
  ['cursor of an inner loop', `export let f = (n) => { let t = 0.0; for (let r = 0; r < 4; r++) { let ix = r; for (let i = 0; i < n; i++) { t += X[ix] * (r + 1); ix += 2 } } return t }`,
    [[5], [10], [0]]],
  ['cursor carried across an outer loop', `export let f = (n) => { let t = 0.0, ix = 0; for (let r = 0; r < 3; r++) { for (let i = 0; i < n; i++) { t += X[ix]; ix += 1 } } return t + ix }`,
    [[5], [10], [0], [20]]],
]
for (const [label, body, inputs] of COUNTED) test(`stdlib: counted loop, ${label}`, () => {
  const src = FIELD + body, host = oracle(src)
  for (const optimize of ownedLevels(0, 2, 'speed', 'size')) {
    const mod = run(src, { optimize })
    for (const args of inputs) {
      host.init(); mod.init()
      is(mod.f(...args), host.f(...args), `f(${args}) at ${optimize}`)
    }
  }
})
