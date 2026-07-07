// Import statement tests
import test from 'tst'
import { is, ok, throws, almost } from 'tst/assert.js'
import { onWasi, adaptI64 } from './_matrix.js'
import jz, { compile } from '../index.js'

// Helper: compile and run
function run(code) {
  const wasm = compile(code)
  const mod = new WebAssembly.Module(wasm)
  return adaptI64(mod, new WebAssembly.Instance(mod).exports)
}

// Named imports
test('import { sin } from math', () => {
  const { f } = run(`
    import { sin } from 'math'
    export let f = x => sin(x)
  `)
  almost(f(0), 0, 1e-6)
})

test('import { sin, cos } from math', () => {
  const { f } = run(`
    import { sin, cos } from 'math'
    export let f = x => sin(x) + cos(x)
  `)
  almost(f(0), 1, 1e-6) // sin(0) + cos(0) = 0 + 1
})

test('import { PI, E } from math', () => {
  const { f, g } = run(`
    import { PI, E } from 'math'
    export let f = () => PI
    export let g = () => E
  `)
  almost(f(), Math.PI)
  almost(g(), Math.E)
})

test('import { sqrt, abs } from math', () => {
  const { f } = run(`
    import { sqrt, abs } from 'math'
    export let f = x => sqrt(abs(x))
  `)
  is(f(-16), 4)
})

// Aliased imports
test('import { sin as s } from math', () => {
  const { f } = run(`
    import { sin as s } from 'math'
    export let f = x => s(x)
  `)
  almost(f(0), 0, 1e-6)
})

test('import { PI as pi, sin as sine } from math', () => {
  const { f } = run(`
    import { PI as pi, sin as sine } from 'math'
    export let f = () => sine(pi / 2)
  `)
  almost(f(), 1, 0.01)
})

// Mixed with Math.X (backward compat)
test('import + Math.X coexist', () => {
  const { f } = run(`
    import { sin } from 'math'
    export let f = x => sin(x) + Math.cos(x)
  `)
  almost(f(0), 1, 1e-6)
})

// Error cases
test('import unknown module', () => {
  throws(() => run(`import { x } from 'unknown'`), /not found|unknown/i)
})

test('import unknown symbol', () => {
  throws(() => run(`import { unknown } from 'math'`), /not found|unknown/i)
})

// Multiple imports
test('multiple import statements', () => {
  const { f } = run(`
    import { sin } from 'math'
    import { cos } from 'math'
    export let f = x => sin(x) * cos(x)
  `)
  almost(f(Math.PI / 4), 0.5, 0.01)
})

// Namespace imports
test('import * as m from math', () => {
  const { f } = run(`
    import * as m from 'math'
    export let f = x => m.sin(x)
  `)
  almost(f(0), 0, 1e-6)
})

test('import * as m - constants', () => {
  const { f } = run(`
    import * as m from 'math'
    export let f = () => m.PI
  `)
  almost(f(), Math.PI)
})

test('import * as m - combined', () => {
  const { f } = run(`
    import * as m from 'math'
    export let f = () => m.sin(m.PI / 2)
  `)
  almost(f(), 1, 0.01)
})

// Default import (treated as namespace)
test('import math from math', () => {
  const { f } = run(`
    import math from 'math'
    export let f = x => math.sqrt(x)
  `)
  is(f(16), 4)
})

// ============================================
// Source module bundling (Tier 2)
// ============================================

test('import: source module basic', () => {
  const { exports } = jz(
    'import { add } from "./math.jz"; export let f = (a, b) => add(a, b)',
    { modules: { './math.jz': 'export let add = (a, b) => a + b' } }
  )
  is(exports.f(3, 4), 7)
})

test('import: source module multiple exports', () => {
  const math = 'export let add = (a, b) => a + b; export let mul = (a, b) => a * b'
  const { exports } = jz(
    'import { add, mul } from "./m.jz"; export let f = (a, b) => add(a, b) + mul(a, b)',
    { modules: { './m.jz': math } }
  )
  is(exports.f(3, 4), 19)  // 7 + 12
})

test('import: transitive imports', () => {
  const base = 'export let base = (x) => x * 2'
  const mid = 'import { base } from "./base.jz"; export let ext = (x) => base(x) + 1'
  const { exports } = jz(
    'import { ext } from "./mid.jz"; export let f = (x) => ext(x)',
    { modules: { './mid.jz': mid, './base.jz': base } }
  )
  is(exports.f(5), 11)  // 5*2 + 1
})

// === re-exports ===

test('re-export: named from module', () => {
  const inner = 'export let val = (x) => x + 1'
  const { exports } = jz(
    'import { val } from "./mid.jz"; export let f = (x) => val(x)',
    { modules: { './mid.jz': 'export { val } from "./inner.jz"', './inner.jz': inner } }
  )
  is(exports.f(41), 42)
})

test('re-export: aliased from module', () => {
  const inner = 'export let val = (x) => x + 1'
  const { exports } = jz(
    'import { fn } from "./mid.jz"; export let f = (x) => fn(x)',
    { modules: { './mid.jz': 'export { val as fn } from "./inner.jz"', './inner.jz': inner } }
  )
  is(exports.f(41), 42)
})

test('re-export: star from module', () => {
  const inner = 'export let add = (a, b) => a + b; export let mul = (a, b) => a * b'
  const { exports } = jz(
    'import { add, mul } from "./mid.jz"; export let f = (x) => add(x, mul(x, 2))',
    { modules: { './mid.jz': 'export * from "./inner.jz"', './inner.jz': inner } }
  )
  is(exports.f(10), 30)  // 10 + 10*2 = 30
})

test('re-export: multi-level chain', () => {
  const base = 'export let val = (x) => x * 3'
  const mid = 'export { val } from "./base.jz"'
  const { exports } = jz(
    'import { val } from "./mid.jz"; export let f = (x) => val(x)',
    { modules: { './mid.jz': mid, './base.jz': base } }
  )
  is(exports.f(14), 42)
})

// === Aliased re-export ABI ===
// `function/const foo; export { foo as bar }` reaches the WASM boundary
// only via sec.customs (`f.exported=false` for the source func — the
// snapshot at defFunc is taken before the `export { … }` statement runs).
// Regression: until the isExported/exportNamesOf split, the rest-param
// custom section + boundary wrapper both keyed on `f.exported`, so
// aliased re-exports skipped rest-pack (NaN args) and skipped boundary
// wrap (narrowed pointer/string params received raw f64 from JS).

test('aliased re-export: rest params packed under alias name', () => {
  const { exports } = jz(`let f = (a, ...rest) => a + rest.length; export { f as g }`)
  is(exports.g(10), 10)
  is(exports.g(10, 1, 2, 3), 13)
})

test('aliased re-export: array param survives boundary', () => {
  const { exports } = jz(`let f = (xs) => xs[0] + xs[1]; export { f as add }`)
  is(exports.add([3, 4]), 7)
})

test('aliased re-export: string param survives boundary', () => {
  const { exports } = jz(`let f = (s) => s.length; export { f as slen }`)
  is(exports.slen('hello'), 5)
})

test('aliased re-export: typeof-narrowed body survives boundary', () => {
  const { exports } = jz(`
    let visit = (n) => {
      if (typeof n === 'string') return n.length
      return n[0]
    }
    export { visit as v }
  `)
  is(exports.v('hi'), 2)
  is(exports.v([42]), 42)
})

test('import: bundled module newline ! after comment', () => {
  const mod = `
    export let f = () => {
      let a
      a ??= 41

      // keep separate statement
      !0 && (a += 1)
      return a
    }
  `
  const { exports } = jz(
    'import { f } from "./m.jz"; export let g = () => f()',
    { modules: { './m.jz': mod } }
  )
  is(exports.g(), 42)
})

test('import: property name colliding with module-scoped binding is not renamed', () => {
  // Module bundling renames module-scoped bindings with a prefix. A property key
  // (`obj.reftype`) is a literal, not a reference — it must survive even when a
  // module-scope `const reftype` exists. Regression: the rename walk descended
  // into `['.', obj, prop]`'s third slot, mangling the key, so `IMM.reftype`
  // resolved to a non-existent property.
  const mod = `
    const reftype = 99
    const IMM = { reftype: 42, other: 7 }
    export let pick = () => IMM.reftype
    export let viaConst = () => reftype
  `
  const { exports } = jz(
    'import { pick, viaConst } from "./m.jz"; export let a = () => pick(); export let b = () => viaConst()',
    { modules: { './m.jz': mod } }
  )
  is(exports.a(), 42)
  is(exports.b(), 99)
})

test('import: method name colliding with module-scoped binding is not renamed', () => {
  const mod = `
    const slice = () => 0
    export let firstOf = arr => arr.slice(0, 1)
  `
  const { exports } = jz(
    'import { firstOf } from "./m.jz"; export let a = () => firstOf([7, 8, 9])[0]',
    { modules: { './m.jz': mod } }
  )
  is(exports.a(), 7)
})

test('import.meta.url lowers from compile option', () => {
  const result = jz('export let f = () => import.meta.url', { importMetaUrl: 'file:///tmp/jz/main.js' })
  is(result.memory.read(result.exports.f()), 'file:///tmp/jz/main.js')
})

test('import.meta.resolve lowers static relative specifier', () => {
  const result = jz('export let f = () => import.meta.resolve("./dep.js")', { importMetaUrl: 'file:///tmp/jz/main.js' })
  is(result.memory.read(result.exports.f()), 'file:///tmp/jz/dep.js')
})

test('new URL(relative, import.meta.url) lowers to href string', () => {
  const result = jz('export let f = () => new URL("../asset.txt", import.meta.url)', { importMetaUrl: 'file:///tmp/jz/src/main.js' })
  is(result.memory.read(result.exports.f()), 'file:///tmp/jz/asset.txt')
})

test('import.meta.url requires importMetaUrl option', () => {
  throws(() => compile('export let f = () => import.meta.url'), /importMetaUrl/)
})

test('import: unknown export errors', () => {
  throws(() => jz(
    'import { nope } from "./m.jz"; export let f = () => nope()',
    { modules: { './m.jz': 'export let add = (a, b) => a + b' } }
  ), /not exported/)
})

// === export default + default import ===

test('export default: arrow function', () => {
  const wasm = compile('export default (x) => x + 1')
  const mod = new WebAssembly.Module(wasm)
  const exports = adaptI64(mod, new WebAssembly.Instance(mod).exports)
  is(exports.default(41), 42)
})

test('export default: alias existing function', () => {
  const wasm = compile('export let add = (a, b) => a + b; export default add')
  const mod = new WebAssembly.Module(wasm)
  const exports = adaptI64(mod, new WebAssembly.Instance(mod).exports)
  is(exports.default(20, 22), 42)
  is(exports.add(1, 2), 3)
})

test('import default: bundled module', () => {
  const { exports: { f } } = jz(
    'import add from "./m.jz"; export let f = () => add(20, 22)',
    { modules: { './m.jz': 'const add = (a, b) => a + b; export default add' } }
  )
  is(f(), 42)
})

test('import default: bundled arrow', () => {
  const { exports: { f } } = jz(
    'import dbl from "./d.jz"; export let f = (x) => dbl(x)',
    { modules: { './d.jz': 'export default (x) => x * 2' } }
  )
  is(f(21), 42)
})

// ============================================
// Host imports (Tier 3)
// ============================================

test('import: host function', () => {
  const { exports } = jz(
    'import { double } from "host"; export let f = (x) => double(x) + 1',
    { imports: { host: { double: (x) => x * 2 } } }
  )
  is(exports.f(5), 11)
})

test('import: multiple host functions', () => {
  const { exports } = jz(
    'import { a, b } from "mylib"; export let f = (x) => a(x) + b(x)',
    { imports: { mylib: { a: (x) => x + 1, b: (x) => x * 10 } } }
  )
  is(exports.f(3), 34)  // 4 + 30
})

test('import: host numeric constant folds to a literal', () => {
  // A numeric host value (e.g. Math.PI from `{ imports: { math: Math } }`) has no callable ABI —
  // it folds to an f64 literal at the reference site instead of emitting a broken func import.
  const { exports } = jz(
    'import { sin, PI } from "math"; export let f = () => sin(PI / 2)',
    { imports: { math: Math } }
  )
  almost(exports.f(), 1)  // sin(π/2) === 1
})

test('import: host constant is shadowed by a local of the same name', () => {
  const { exports } = jz(
    'import { PI } from "math"; export let f = () => { let PI = 10; return PI }',
    { imports: { math: Math } }
  )
  is(exports.f(), 10)
})

// ============================================
// Host import overrides of built-in globals
// ============================================

test('host override: Math.sin', () => {
  const { exports } = jz(
    'export let f = (x) => Math.sin(x)',
    { imports: { Math: { sin: (x) => x * 2 } } }
  )
  is(exports.f(3), 6)  // 3 * 2
})

test('host override: Date.now', () => {
  const { exports } = jz(
    'export let f = () => Date.now()',
    { imports: { Date: { now: () => 12345 } } }
  )
  is(exports.f(), 12345)
})

test('host override: console.log with string', () => {
  const captured = []
  const { exports } = jz(
    'export let f = () => { console.log("hello"); return 0 }',
    { imports: { console: { log: (msg) => { captured.push(msg); return 0 } } } }
  )
  exports.f()
  is(captured[0], 'hello')
})

test('host override: console.log with numbers', () => {
  const captured = []
  const { exports } = jz(
    'export let f = () => { console.log(1, 2.5); return 0 }',
    { imports: { console: { log: (a, b) => { captured.push(a, b); return 0 } } } }
  )
  exports.f()
  is(captured[0], 1)
  is(captured[1], 2.5)
})

test('host override: window.alert', () => {
  const captured = []
  const { exports } = jz(
    'export let f = () => { window.alert(42); return 0 }',
    { imports: { window: { alert: (x) => { captured.push(x); return 0 } } } }
  )
  exports.f()
  is(captured[0], 42)
})

test('host override: globalThis.fetch', () => {
  const captured = []
  const { exports } = jz(
    'export let f = () => globalThis.fetch("/api")',
    { imports: { globalThis: { fetch: (url) => { captured.push(url); return 200 } } } }
  )
  is(exports.f(), 200)
  is(captured[0], '/api')
})

test('host override: string return value', () => {
  const { exports } = jz(
    'export let f = () => globalThis.label() + "!"',
    { imports: { globalThis: { label: () => 'ok' } } }
  )
  is(exports.f(), 'ok!')
})

test('host import return type elides numeric coercion helper', () => {
  const wat = compile('export let f = () => performance.now() + 1', {
    wat: true,
    imports: { performance: { now: { params: 0, returns: 'number' } } },
  })
  ok(!wat.includes('$__to_num'))
})

test('host override: mixed with built-in fallback', () => {
  const captured = []
  const { exports } = jz(
    'import { log, warn } from "console"; export let f = () => { log(1); warn(2); return 0 }',
    { imports: { console: { log: (x) => { captured.push(x); return 0 } } } }
  )
  exports.f()
  is(captured[0], 1)
  // warn uses built-in WASI console (no crash = success)
})

// ============================================
// Whole-object host imports
// ============================================

test('import: whole Math object', () => {
  const { exports } = jz(
    'import { sin, cos, sqrt } from "math"; export let f = () => sin(0) + cos(0) + sqrt(4)',
    { imports: { math: Math } }
  )
  almost(exports.f(), 3, 1e-6)
})

test('import: whole Date object', () => {
  const { exports } = jz(
    'import { now } from "date"; export let f = () => now()',
    { imports: { date: Date } }
  )
  const result = exports.f()
  ok(typeof result === 'number' && result > 0)
})

test('import: whole globalThis object', () => {
  const captured = []
  const { exports } = jz(
    'import { parseInt } from "window"; export let f = () => parseInt("42")',
    { imports: { window: globalThis } }
  )
  is(exports.f(), 42)
})

test('import: whole object with method this-binding', () => {
  const captured = []
  const host = {
    obj: { value: 10 },
    getValue() { return this.obj.value }
  }
  const { exports } = jz(
    'import { getValue } from "host"; export let f = () => getValue()',
    { imports: { host: host } }
  )
  is(exports.f(), 10)
})

// The parser yields a trailing null in the comma list for `{a, b,}`. ES2017
// allows the trailing comma in import specifiers, so jz must accept it across
// every import tier (built-in, source-bundled, host).
test('import: trailing comma in built-in module specifier', () => {
  const { f } = run(`
    import { sin, cos, } from 'math'
    export let f = x => sin(x) + cos(x)
  `)
  almost(f(0), 1, 1e-6)
})

test('import: trailing comma in source-module specifier', () => {
  const { exports } = jz(
    `import { a, b, } from './x'\nexport let f = () => a + b`,
    { modules: { './x': 'export let a = 1\nexport let b = 2' } }
  )
  is(exports.f(), 3)
})

test('import: trailing comma in host-module specifier', () => {
  const { exports } = jz(
    `import { add, mul, } from 'host'\nexport let f = () => add(2, 3) + mul(2, 3)`,
    { imports: { host: { add: (a, b) => a + b, mul: (a, b) => a * b } } }
  )
  is(exports.f(), 11)
})

// Regression: calling a user-defined function whose name matches a non-existent
// built-in module (e.g. "polyfill") must not trigger autoload and crash.
test('autoload: user function named like missing built-in', () => {
  const { exports } = jz(
    'export let polyfill = (x) => x + 1; export let f = () => polyfill(41)'
  )
  is(exports.f(), 42)
})

test('autoload: user function wins over internal emitter name', () => {
  const { exports } = jz(`
    function str(value) {
      return typeof value === "string" ? value.length : 0
    }
    export let f = () => str("abcd")
  `, { jzify: true })
  is(exports.f(), 4)
})

// JS calling convention drops extras and pads missing with undefined; wasm
// validates exact arity at every call site. The emitter matches the call's
// arg count to the declared import signature so a mismatch on either side
// produces a valid module.
test('import: extra args truncated to declared arity', () => {
  if (onWasi()) return  // wasi: host import / _interp unavailable
  // Host stub declares 1 param; call site passes 5 → extras dropped, valid wasm
  const wasm = compile(
    `export let f = () => Foo(2024, 0, 1, 12, 30)`,
    { _interp: { Foo: (_a) => 0 } }
  )
  // Validation alone is the assertion — pre-fix this threw RangeError
  ok(new WebAssembly.Module(wasm) instanceof WebAssembly.Module)
})

test('import: missing args padded to declared arity', () => {
  if (onWasi()) return  // wasi: host import / _interp unavailable
  // Host stub declares 3 params; call site passes 1 → padded to 3 with NULL
  const wasm = compile(
    `export let f = () => Foo(7)`,
    { _interp: { Foo: (_a, _b, _c) => 0 } }
  )
  ok(new WebAssembly.Module(wasm) instanceof WebAssembly.Module)
})

test('import: zero-arg callee with arg supplied at call site', () => {
  if (onWasi()) return  // wasi: host import / _interp unavailable
  // Caller passes 1 arg; declared sig is 0 — arg is dropped (was bypassed by
  // `||` falling through to args.length, which always matches itself).
  const wasm = compile(
    `export let f = () => Foo(99)`,
    { _interp: { Foo: () => 0 } }
  )
  ok(new WebAssembly.Module(wasm) instanceof WebAssembly.Module)
})

// A re-exported binding that's also used in-module must keep its original
// cross-module mangled name. Renaming under the consuming module's prefix
// orphans the in-module call site.
test('import: cross-module binding both used and re-exported keeps original mangling', () => {
  const { exports } = jz(
    `import { f } from './b'; export let g = () => f()`,
    {
      modules: {
        './b': `import { x } from './c'; export let f = () => x() + 1; export { x }`,
        './c': `export let x = () => 10`,
      },
    }
  )
  is(exports.g(), 11)
})

test('import: transitive re-export-only chain still resolves', () => {
  // Pure re-export (no in-module use) — was already supported, pinned alongside
  // the use+re-export case so a future bundler change can't quietly break it.
  const { exports } = jz(
    `import { x } from './b'; export let f = () => x()`,
    {
      modules: {
        './b': `import { x } from './c'; export { x }`,
        './c': `export let x = () => 7`,
      },
    }
  )
  is(exports.f(), 7)
})

// Bare side-effect imports — `import './x.js'` (no `from` clause). Must
// compile (sub-module is link-loaded) and run its top-level side effects.

test('bare side-effect import compiles', () => {
  const { exports } = jz(
    `import './sub.js'; export let f = () => 1`,
    { modules: { './sub.js': 'export const x = 1' } }
  )
  is(exports.f(), 1)
})

test('bare side-effect import runs module init', () => {
  const { exports } = jz(
    `import './counter.js'; import { count } from './counter.js'; export let f = () => count`,
    { modules: { './counter.js': 'export let count = 0; count = 42' } }
  )
  is(exports.f(), 42)
})

// Nested imports must not stack prefixes. When module A imports module B and
// both have specifiers without `__`, the older "sub-import" name heuristic
// misclassified B's already-prefixed funcs as A-owned and re-mangled them to
// `A$B$name`. The resulting WAT referenced names that didn't exist. Funcs are
// now tagged with their owning module's prefix instead.

test('nested module imports do not stack prefixes', () => {
  const { exports } = jz(
    `import './a.js'; import { f } from './a.js'; export let g = () => f()`,
    { modules: {
      './a.js': `import { x } from './b.js'; export let f = () => x()`,
      './b.js': `export let x = () => 42`,
    } }
  )
  is(exports.g(), 42)
})

// === Cross-module array resize ===

test('cross-module: importer `.length = 0` between owner pushes keeps one array', () => {
  // `.length =` on a global used to be recorded as a schema PROPERTY write,
  // auto-boxing the binding (['__inner__','length']): element reads then
  // deref'd the box while the resize path persisted the raw array ptr into
  // the global — a read/write protocol split that read garbage (62) here.
  const mods = { './state.js': 'export const arr = [7]\nexport let ownerPush = (v) => { arr.push(v); return 0 }\nexport let readLen = () => arr.length' }
  const { exports } = jz(`
    import { arr, ownerPush, readLen } from './state.js'
    export let t = () => {
      ownerPush(42)
      arr.length = 0
      ownerPush(9)
      return readLen() * 10 + arr[0]
    }`, { modules: mods })
  is(exports.t(), 19)
})

// === Destructured export declarations ===

// A destructuring export declaration (`export let { a } = obj`) must register its
// bindings in the module's export table. The single-module form compiles; only the
// cross-module import fails ("'a' is not exported from …"). Surfaced by
// window-function/util.js (`export let { cos, sin, abs, … } = Math`), which blocks
// compiling every package that windows a signal. Fix in prepare's export
// registration, then flip `test.todo` → `test`.
test('cross-module: destructured export declaration registers bindings', () => {
  const { exports } = jz(
    `import { a } from './dep.js'; export let f = () => a`,
    { modules: { './dep.js': 'export let { a } = { a: 1 }' } }
  )
  is(exports.f(), 1)
})

// A factory-produced default export (`export default make(...)` returning a
// closure) compiles when its module is the entry, but loses the binding when
// default-imported from another module: "'thing' is not in scope". Closures,
// factories, and default exports are each documented subset. Live instance:
// every pitch-shift algorithm package ends with
// `export default makePitchShift(batch, stream)`; any cross-package default
// import (shift-hybrid, root aggregators) fails on this.
// Flip `test.todo` → `test` when fixed.
test('cross-module: default-imported factory-produced closure', () => {
  const { exports } = jz(
    `import thing from './dep.js'; export let test = (x) => thing(x)`,
    { modules: { './dep.js': `
      let make = (a, b) => (x) => a(x) + b(x)
      let double = (x) => x * 2
      let square = (x) => x * x
      export default make(double, square)` } }
  )
  is(exports.test(3), 15)  // double(3) + square(3)
})

// Binary-encode-only crash: a default-exported function that memoizes state on
// its own function object (the taylor-window idiom `c._w = …; c._N = N`)
// combined — in the same module graph — with an export-only higher-order
// function (`generate(fn, N)` calling an unknown `fn`) dies in encode with
// "'__a3' is not in scope" (AST [";"]), while `--wat` emission of the identical
// graph succeeds. Either piece alone compiles; simplified variants of the memo
// idiom also compile, so the trigger is sensitive to taylor's exact shape —
// the taylor.js below is verbatim window-function source, minimally re-based
// onto a stub util. Live instance: window-function's taylor.js /
// ultraspherical.js + util.js generate. Flip `test.todo` → `test` when fixed.
// PARTIAL (2026-07-08): the titled ENCODE CRASH is FIXED — program-facts now records
// bare func-ref RHS in let/const decls (`let c = taylor`) as a VALUE use, so
// resolveClosureWidth sizes the uniform ABI to the fn's full arity and the boundary
// trampoline no longer forwards undeclared $__a{k} slots. Residual: the memo VALUE
// computes wrong cross-module only (returns 1, want 0.4849…; the same fn-attached
// memo idiom works single-module) — a distinct dyn-props-on-closure-receiver or
// default-export-self-name bug. Re-diagnose from here.
test.todo('cross-module: function-attached memo state + export-only HOF encodes to binary', () => {
  const util = `
    export let PI = Math.PI
    export let PI2 = 2 * Math.PI
    export let cos = (x) => Math.cos(x)
    export let acosh = (x) => Math.acosh(x)
    export let pow = (x, y) => Math.pow(x, y)
    export let normalize = (w) => {
      let peak = 0
      for (let i = 0; i < w.length; i++) if (Math.abs(w[i]) > peak) peak = Math.abs(w[i])
      if (peak > 0) for (let i = 0; i < w.length; i++) w[i] /= peak
      return w
    }
    export let generate = (fn, N) => {
      let w = new Float64Array(N)
      for (let i = 0; i < N; i++) w[i] = fn(i, N)
      return w
    }`
  const taylor = `
    import { cos, acosh, pow, PI, PI2, normalize } from './util.js'
    export default function taylor (i, N, nbar, sll) {
      if (nbar == null) nbar = 4
      if (sll == null) sll = 30
      let c = taylor
      if (c._N !== N || c._nb !== nbar || c._s !== sll) {
        let A = acosh(pow(10, sll / 20)) / PI
        let s2 = nbar * nbar / (A * A + (nbar - 0.5) * (nbar - 0.5))
        let Fm = new Float64Array(nbar - 1)
        for (let m = 1; m < nbar; m++) {
          let num = 1, den = 1
          for (let n = 1; n < nbar; n++) {
            num *= 1 - m * m * s2 / (A * A + (n - 0.5) * (n - 0.5))
            if (n !== m) den *= 1 - m * m / (n * n)
          }
          Fm[m - 1] = (m % 2 ? 1 : -1) * num / (2 * den)
        }
        let w = new Float64Array(N)
        for (let n = 0; n < N; n++) {
          let v = 1
          for (let m = 1; m < nbar; m++) v += 2 * Fm[m - 1] * cos(PI2 * m * (n - (N - 1) / 2) / N)
          w[n] = v
        }
        c._w = normalize(w); c._N = N; c._nb = nbar; c._s = sll
      }
      return c._w[i]
    }`
  const { exports } = jz(
    `import taylor from './taylor.js'; export let test = () => taylor(1, 8)`,
    { modules: { './taylor.js': taylor, './util.js': util } }
  )
  ok(Math.abs(exports.test() - 0.48492204743452627) < 1e-6)  // reference: same source under node
})

// A top-level const in a NON-ENTRY bundled module initialized by a Math.* call reads
// back truncated to its integer part — Math.PI * 2 → 6, Math.sqrt(2) → 1,
// Math.cos(1) → 0 — both when imported by name and when read inside its own module's
// functions. A plain-arithmetic const in the same position (`1.1 * 2`) is exact, and
// the same Math.* const in the ENTRY module is exact. Compiles and runs clean —
// silently wrong. Live instance: noise-reduction/util.js `export const PI2 =
// Math.PI * 2` — every RBJ biquad coefficient (notch/HP/LP/peaking) is computed at a
// truncated cutoff angle, so dehum/dewind/deesser wasm output diverges from JS
// (~1e-2 abs after IIR feedback compounds). Flip `test.todo` → `test` when fixed.
test('cross-module: Math.*-initialized const in a dep module reads back exact', () => {
  const { exports } = jz(
    `import { TWO_PI, R2 } from './util.js'
     export let f = () => TWO_PI
     export let g = () => R2`,
    { modules: { './util.js': 'export const TWO_PI = Math.PI * 2\nexport const R2 = Math.sqrt(2)' } }
  )
  is(exports.f(), Math.PI * 2)
  is(exports.g(), Math.sqrt(2))
})

// A dependency module — non-entry, imported by another module — that both CALLS a
// private function internally AND re-exports it under an alias
// (`export { helper as poles }`) failed to compile: "'helper' is not in scope".
// Root cause (prepareModule, src/prepare/index.js): `exportLocal(exportName,
// localName)` mangles and renames the LOCAL function, then keys the walk-lookup
// map (`moduleExports`) by `exportName` only. In-module call sites reference the
// ORIGINAL local name, not the export alias, so when the two differ the walk
// that rewrites call sites to the mangled name never finds an entry for the
// local name — the call site is left pointing at a function that no longer
// exists post-rename. The un-aliased case (`export {helper}`, `exportLocal(name,
// name)`) never surfaced this: there exportName === localName, so the single map
// entry accidentally served both purposes. The deferred `export default alias`
// resolution had the identical bug via its own (now-removed) inline copy of the
// same logic. Fixed generally: `exportLocal` now also keys the map by
// `localName` whenever it differs from `exportName`, and the default-export
// path delegates to `exportLocal` instead of re-deriving it.
// Live instance: digital-filter/iir/butterworth.js — `butterworthPoles` is
// called internally (line 24, inside the default-exported `butterworth`) and
// re-exported `export { butterworthPoles as poles }` (line 38); every
// audio-filter module that imports butterworth as a dependency (biquad design,
// filter chains) failed to compile on this.
test('cross-module: dependency module calling AND aliased-re-exporting the same private helper', () => {
  const { exports } = jz(
    `import outer from './dep.js'; export let f = (n) => outer(n)`,
    { modules: { './dep.js': `
      export default function outer (n) { return helper(n) }
      function helper (n) {
        let arr = []
        for (let i = 0; i < n; i++) arr.push(i * 2)
        return arr
      }
      export { helper as poles }` } }
  )
  is(exports.f(3), [0, 2, 4])
})

// Boundary case: an aliased re-export with NO internal call to the aliased
// name anywhere else in the module. This already worked before the fix above
// (exportName === the only reference to `helper` is the export itself, so the
// missing walk-lookup key was never actually consulted) — pinned so the fix
// doesn't accidentally narrow the working case while widening the broken one.
test('cross-module: aliased re-export with no internal call to the aliased name', () => {
  const { exports } = jz(
    `import { poles } from './dep.js'; export let f = (n) => poles(n)`,
    { modules: { './dep.js': `
      function helper (n) { return n * 3 }
      export { helper as poles }` } }
  )
  is(exports.f(4), 12)
})

// Same bug, reached through `export default helper` instead of a named `as`
// alias — `export default X` is itself an aliased export (exportName
// 'default' vs localName `X`), the deferred resolution branch `exportLocal`
// now also covers. `helper` here is the CALLEE (not the caller) of an
// unexported sibling `caller`, re-exported so `caller` stays reachable.
test('cross-module: dependency module calling AND default-exporting the same private helper', () => {
  const { exports } = jz(
    `import { go } from './dep.js'; export let f = (n) => go(n)`,
    { modules: { './dep.js': `
      function caller (n) { return helper(n) }
      function helper (n) { return n * 2 }
      export default helper
      export let go = (n) => caller(n)` } }
  )
  is(exports.f(21), 42)
})

// The original repro's shape restated explicitly: the function that CALLS the
// aliased helper is itself the module's `export default` — pins that a
// default-exported caller (not just a default-exported callee, above) keeps
// resolving its internal call after the callee gets renamed under its alias.
test('cross-module: default-exported caller invoking an aliased-re-exported callee', () => {
  const { exports } = jz(
    `import outer from './dep.js'; export let f = (n) => outer(n)`,
    { modules: { './dep.js': `
      export default function outer (n) { return helper(n) * 10 }
      function helper (n) { return n + 1 }
      export { helper as poles }` } }
  )
  is(exports.f(4), 50)
})

// Deeper: the alias survives a SECOND module hop — a middle module imports the
// already-aliased name and re-exports it again under yet another alias, while
// ALSO calling the original module's caller (so both mangled names from the
// first hop's rename must still resolve correctly).
test('cross-module: aliased re-export survives a second module hop', () => {
  const { exports } = jz(
    `import { roots } from './mid.js'; export let f = (n) => roots(n)`,
    { modules: {
      './dep.js': `
        export default function outer (n) { return helper(n) }
        function helper (n) { return n * 2 }
        export { helper as poles }`,
      './mid.js': `
        import outer, { poles } from './dep.js'
        export let go = (n) => outer(n)
        export { poles as roots }`,
    } }
  )
  is(exports.f(5), 10)
})
