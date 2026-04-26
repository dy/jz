# jz ![stability](https://img.shields.io/badge/stability-experimental-black) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml)

Functional JS subset compiling to WASM. Static dispatch, zero GC, tiny binaries.


## Usage

`npm install jz`

```js
import jz, { compile } from 'jz'

// Compile, instantiate, run — defaults, rest params, WASI all work
const { exports: { add } } = jz('export let add = (a, b) => a + b')
add(2, 3)  // 5

// Template tag — interpolate numbers, functions, strings, arrays, objects
const { exports: { sine } } = jz`
  export let sine = (freq, t, i) => ${Math.sin}((t + i) * freq * ${Math.PI} * 2 / 44100)
`
sine(440, 0, 0)  // native speed, zero GC

const { exports: { f } } = jz`export let f = () => ${'hello'}.length`
f()  // 5

// Low-level: compile only — returns raw WASM binary (no JS adaptation)
const wasm = compile('export let f = (x) => x * 2')
const wat = compile('export let f = (x) => x * 2', { wat: true })
```

## CLI

`npm install -g jz`

```sh
# Compile jz to WASM
jz program.jz -o program.wasm

# Compile any jz (auto-jzify: function→arrow, var→let, switch→if/else)
jz program.js -o program.wasm

# Compile strict jz to WAT
jz program.jz -o program.wat

# Transform js to jz (no compilation)
jz --jzify lib.js > lib.jz

# Evaluate expression
jz -e "1 + 2"
# 3

# Show help
jz --help
```

## Features

* Numbers: `0.1`, `1.2e+3`, `0xff`, `0b101`, `0o77`, `10n` (BigInt)
* Strings: `"abc"`, `'abc'`, `` `hello ${x}` ``, `s.length`, `s[i]`
* String methods: `.slice`, `.indexOf`, `.includes`, `.startsWith`, `.endsWith`, `.trim`, `.padStart`, `.padEnd`, `.repeat`, `.split`, `.replace`, `.replaceAll`, `.toUpperCase`, `.toLowerCase`, `.charAt`, `.charCodeAt`, `.at`, `.search`, `.match`, `.concat`
* Regex: `/pattern/flags`, `.test`, `.exec`, `.match`, `.replace`, `.split`, `.search`
* Values: `true`, `false`, `null`, `NaN`, `Infinity`
* Arithmetic: `+a`, `-a`, `a + b`, `a - b`, `a * b`, `a / b`, `a % b`, `a ** b`
* Comparison: `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b`
* Bitwise: `~a`, `a & b`, `a ^ b`, `a | b`, `a << b`, `a >> b`, `a >>> b`
* Logic: `!a`, `a && b`, `a || b`, `a ?? b`, `a ? b : c`
* Assignment: `a = b`, `a += b`, `a -= b`, `a *= b`, `a /= b`, `a %= b`
* Declarations: `let`, `const`, block scope
* Control: `if`/`else`, `for`, `while`, `switch`/`case`, `return`, `try`/`catch`/`throw`
* Functions: `(a, b) => c`, `a => b`, `() => c`, defaults, rest params, currying, closures
* Multi-return: `(a, b) => [b, a]`
* Arrays: `[a, b]`, `arr[i]`, `.length`, `.push`, `.pop`, `.shift`, `.unshift`, `.map`, `.filter`, `.reduce`, `.forEach`, `.find`, `.indexOf`, `.includes`, `.slice`, `.concat`, `.flat`, `.join`
* Spread: `[...a, ...b]`, `let [x, y] = a`, `let {x, y} = o`
* Objects: `{a: b}`, `{a, b}`, `o.prop`, `o.prop = x`, `Object.keys`, `.values`, `.entries`, `.assign`
* TypedArrays: `new Float64Array(n)`, `Int32Array`, `Uint8Array`, etc. + SIMD auto-vectorization
* Buffer: `new ArrayBuffer(n)`, typed array views
* Collections: `new Set()`, `new Map()`
* Number methods: `.toString`, `.toFixed`, `.toExponential`, `.toPrecision`, `parseInt`, `parseFloat`, `Number.isNaN`, `.isFinite`, `.isInteger`
* Loops: `for...of` arrays, `for...in` objects (compile-time unrolled)
* Modules: `import { a } from 'b'`, `export`, source bundling, host imports
* Math: `sin cos tan atan2 sqrt pow abs min max floor ceil round log exp` ...
* JSON: `JSON.stringify`, `JSON.parse`
* Encoding: `TextEncoder`, `TextDecoder`
* Time: `Date.now()`, `performance.now()` (WASI)
* IO: `console.log/warn/error` (WASI)
* Symbols: `Symbol()`, `Symbol.for()`
* typeof: `typeof x === 'string'` (compile-time type checks)
* Optional chaining: `a?.b`, `a?.[i]`
* Comments: `// foo`, `/* bar */`
* No `var`, `function`, `this`, `class`, `async`, `eval`, `with`, `arguments`
* `==` is `===`, `null` is a distinct value (not `0`), `??` works correctly


## Why?

Native speed from plain JS. Deterministic execution (no GC pauses, no deopt cliffs, no JIT warmup). Tiny binaries (453 bytes for mandelbrot). Instant compilation (<1ms). Portable (browser, wasmtime, wasmer, deno, wasm2c).

_jz_ (javascript zero) keeps minimal functional JS best practices, drops the rest.
Initially conceived for bytebeats, inspired by [porf](https://github.com/CanadaHonk/porffor) and [piezo](https://github.com/dy/piezo).

### Principles

* **Crockford-aligned** — no `var`, `this`, `class`, `switch`, `==`. The Good Parts, enforced by the compiler. `jzify` auto-transforms non-conforming JS.
* **Compile-time over runtime** — types inferred from usage, no annotations. All dispatch resolved statically. No GC, no runtime checks. Method calls resolve to direct WASM function calls at compile time.
* **Explicit over implicit** — no coercions, no hoisting, no magic. `==` is strict. `null` is distinct from `0`. `??` works correctly. Code means what it says.
* **Functional over OOP** — functions are the unit of composition. No `class`, no `this`, no inheritance. Data is plain, behavior is functions. Closures capture by reference, currying works naturally.
* **Hand-written output** — produced WAT/WASM reads as if you wrote it manually. Constant folding, dead code elimination, i32 preservation, SIMD vectorization, loop-invariant hoisting, tail call optimization. Goal: jz output = hand-written for scalar functions.
* **No perf-hostile patterns** — language-level prevention of practices that resist optimization. No dynamic property lookup, no implicit type coercion, no prototype chains, no hidden classes. If it would force a runtime type check, it's not in the language.
* **Valid jz = valid js** — every jz program runs as normal JS. The subset enforces good style by design — no linter needed.
* **jzify** — any JS file compiles to WASM via automatic transform: `function` → arrow, `var` → `let`, `switch` → if/else, `==` → `===`, `new` → call. `jz file.js` just works.
* **Uniform f64** — all values are f64. Heap types use [NaN-boxing](https://sean.cm/a/nan-boxing): arrays, strings, objects are pointers encoded in quiet NaN bits. One representation, no type tags, no boxing overhead.
* **Minimal core, extensible surface** — core compiles pure compute (~2K lines). Arrays, strings, objects, regex, Math — each is a module. Capabilities grow without core growth.
* **Live compilation** — compiles in-browser in <1ms. WASM as interactive medium, not build artifact. Fast enough for live coding and REPL use.


## FAQ

#### How do I pass data between JS and WASM?

Numbers pass directly as f64. Strings, arrays, objects, and typed arrays are heap values — `inst.memory` provides read/write across the boundary:

```js
const { exports, memory } = jz(`
  export let greet = (s) => s.length
  export let sum = (a) => a.reduce((s, x) => s + x, 0)
  export let dist = (p) => (p.x * p.x + p.y * p.y) ** 0.5
  export let process = (buf) => buf.map(x => x * 2)
`)

// JS → WASM (write)
memory.String('hello')               // → NaN-boxed string pointer
memory.Array([1, 2, 3])              // → NaN-boxed array pointer
memory.Float64Array([1.0, 2.0])      // → NaN-boxed typed array pointer
memory.Int32Array([10, 20, 30])      // all typed array constructors available

// Objects: keys and order must match the jz source declaration.
// jz objects are fixed-layout schemas (like C structs), not dynamic key bags.
memory.Object({ x: 3, y: 4 })       // → NaN-boxed object pointer

// Strings/arrays inside objects are auto-wrapped to pointers:
memory.Object({ name: 'jz', count: 3 })  // name auto-wrapped via memory.String

// Call with pointers
exports.greet(memory.String('hello'))          // 5
exports.sum(memory.Array([1, 2, 3]))           // 6
exports.dist(memory.Object({ x: 3, y: 4 }))   // 5

// WASM → JS (read)
memory.read(exports.process(memory.Float64Array([1, 2, 3])))  // Float64Array [2, 4, 6]
```

Template interpolation handles most of this automatically — strings, arrays, numbers, and numeric objects are marshaled for you:

```js
jz`export let f = () => ${'hello'}.length + ${[1,2,3]}[0] + ${{x: 5, y: 10}}.x`
```

#### Can two modules share data?

Yes — `jz.memory()` creates a shared memory that modules compile into. Schemas accumulate automatically, so objects created in one module are readable by another:

```js
const memory = jz.memory()

const a = jz('export let make = () => { let o = {x: 10, y: 20}; return o }', { memory })
const b = jz('export let read = (o) => o.x + o.y', { memory })

// Object from module a, processed by module b — same memory, merged schemas
b.exports.read(a.exports.make())  // 30

// Read from JS too — memory knows all schemas
memory.read(a.exports.make())  // {x: 10, y: 20}

// Write from JS before any compilation
memory.String('hello')      // → NaN-boxed pointer
memory.Array([1, 2, 3])     // → NaN-boxed pointer
```

`jz.memory()` returns an actual `WebAssembly.Memory` (monkey-patched with `.read()`, `.String()`, `.Array()`, `.Object()`, `.write()`, etc). You can also pass an existing memory: `jz.memory(new WebAssembly.Memory({ initial: 4 }))` patches and returns the same object. Passing raw `WebAssembly.Memory` to `{ memory }` auto-wraps it.

All modules sharing a memory use a single bump allocator (heap pointer at byte 1020). Use `.instance.exports` for raw pointers, `.exports` for the JS-wrapped surface.

#### How does template interpolation work?

Numbers and booleans inline directly into source. Strings, arrays, and objects are serialized as jz source literals and compiled at compile time — no post-instantiation allocation, no getter overhead:

```js
jz`export let f = () => ${'hello'}.length`              // 5 — string compiled as literal
jz`export let f = () => ${[10, 20, 30]}[1]`             // 20 — array compiled as literal
jz`export let f = () => ${{name: 'jz', count: 3}}.count` // 3 — object compiled as literal

// Nested values work too
jz`export let f = () => ${{label: 'origin', x: 0, y: 0}}.label.length`  // 6
```

Functions are imported as host calls. Non-serializable values (host objects, class instances) fall back to post-instantiation getters automatically.

#### Does it support imports?

Yes — standard ES `import` syntax, bundled at compile time into a single WASM module.

```js
// Source modules: provide source strings, jz bundles them
const { exports } = jz(
  'import { add } from "./math.jz"; export let f = (a, b) => add(a, b)',
  { modules: { './math.jz': 'export let add = (a, b) => a + b' } }
)

// Host functions: import JS functions into WASM
const { exports } = jz(
  'import { log } from "host"; export let f = (x) => { log(x); return x }',
  { imports: { host: { log: console.log } } }
)
```

**CLI** resolves imports automatically — relative paths from the filesystem, bare specifiers from `package.json` `"imports"` field:

```sh
jz main.jz -o main.wasm    # reads ./math.jz, ./utils.jz automatically
```

**Browser**: pass resolved sources via `{ modules }`. No filesystem access needed — the host fetches sources and provides them. The compiler stays synchronous and pure.

**How it works**: imported modules are parsed, prepared, and merged into the main module's function table during compilation. The output is always one WASM binary — no multi-module linking, no runtime resolution. Transitive imports work. Circular imports error at compile time.

```js
// Transitive: main → math → utils (all bundled into one WASM)
const { exports } = jz(
  'import { dist } from "./math.jz"; export let f = (x, y) => dist(x, y)',
  { modules: {
    './math.jz': 'import { sq } from "./utils.jz"; export let dist = (x, y) => (sq(x) + sq(y)) ** 0.5',
    './utils.jz': 'export let sq = (x) => x * x'
  }}
)

// Browser: fetch sources yourself, pass them in
let mathSrc = await fetch('./math.jz').then(r => r.text())
let utilsSrc = await fetch('./utils.jz').then(r => r.text())
const { exports } = jz(mainSrc, { modules: { './math.jz': mathSrc, './utils.jz': utilsSrc } })
```

#### How does everything fit in f64?

All values are IEEE 754 f64. Integers up to 2^53 are exact. Heap types use [NaN-boxing](https://sean.cm/a/nan-boxing): quiet NaN (`0x7FF8`) + 51-bit payload `[type:4][aux:15][offset:32]`.

| Type | Code | Payload | Example |
|------|------|---------|---------|
| Number | — | regular f64 | `3.14`, `42`, `NaN` |
| Null | 0 | reserved pattern | `null` (distinct from `0` and `NaN`) |
| Array | 1 | aux=length, offset=heap | `[1, 2, 3]` |
| ArrayBuffer | 2 | offset=heap | `new ArrayBuffer(16)` |
| TypedArray | 3 | aux=elemType, offset=heap | `new Float64Array(n)` |
| String | 4 | offset=heap | `"hello world"` (>4 chars) |
| SSO String | 5 | aux=packed chars | `"hi"` (<=4 ASCII chars, zero alloc) |
| Object | 6 | aux=schemaId, offset=heap | `{x: 1, y: 2}` |
| Hash | 7 | offset=heap | dynamic string-keyed objects |
| Set | 8 | offset=heap | `new Set()` |
| Map | 9 | offset=heap | `new Map()` |
| Closure | 10 | aux=funcIdx, offset=env | `x => x + captured` |
| External | 11 | offset=hostMap index | JS host object references |

**Why NaN-boxing?** Proven technique: used by LuaJIT, JavaScriptCore, SpiderMonkey, Porffor, early V8. The alternatives — tagged unions (OCaml, Haskell), pointer tagging (V8 Smis), or separate type+value pairs — all require branching at call boundaries or multi-word passing. NaN-boxing fits any value in one 64-bit word: one calling convention, one memory layout, one comparison instruction.

**The f64 tradeoff**: f64 arithmetic is ~1.2x slower than i32 for pure integer work on most architectures. jz mitigates this — `analyzeLocals` preserves i32 for loop counters, bitwise ops, and comparisons, so the penalty only applies to mixed-type parameters. The gain: zero interop cost at the JS↔WASM boundary (f64 is WASM's native JS-compatible type), no marshaling, no boxing/unboxing. For jz's target workloads (DSP, typed arrays, math), f64 is the natural type anyway.

**NaN preservation**: IEEE 754 defines 2^52 − 1 distinct NaN bit patterns. WASM preserves NaN payload bits through arithmetic (spec requires `nondeterministic_nan`), and JS engines canonicalize only on certain operations (`Math.fround`, structured clone). jz uses quiet NaNs (`0x7FF8` prefix) which survive all standard paths. The 51 payload bits encode type (4), aux metadata (15), and heap offset (32) — enough for 4GB addressable memory and 12 type codes.

#### How do I run compiled WASM outside the browser?

```sh
jz program.js -o program.wasm

# Run with any WASM runtime
wasmtime program.wasm     # WASI support built in
wasmer run program.wasm
deno run program.wasm
```

`console.log` compiles to WASI `fd_write` — works natively on wasmtime/wasmer/deno without polyfills.

#### What WASI features are supported?

jz targets WASI Preview 1. The compiled `.wasm` uses standard WASI imports — runs natively on wasmtime, wasmer, deno without polyfills.

| JS API | WASI call | Notes |
|--------|-----------|-------|
| `console.log()` | `fd_write` (fd=1) | Multiple args space-separated, newline appended |
| `console.warn()`, `console.error()` | `fd_write` (fd=2) | Writes to stderr |
| `Date.now()` | `clock_time_get` (realtime) | Returns ms since epoch |
| `performance.now()` | `clock_time_get` (monotonic) | Returns ms, high-resolution |

For browser/Node environments without native WASI, jz ships a tiny polyfill (`jz/wasi`) that maps these calls to `console.log` and `performance.now()`. The `jz()` function applies it automatically.

#### Can I compile jz to C?

Yes, via [wasm2c](https://github.com/nicbarker/wasm2c) or [w2c2](https://github.com/nicbarker/w2c2):

```sh
jz program.js -o program.wasm
wasm2c program.wasm -o program.c
cc program.c -o program
```

jz → WASM → C → native binary.

#### What's the performance like?

Compiled jz runs as native WASM — same speed as hand-written WAT or C-compiled WASM. No interpreter, no GC pauses. Compilation itself takes <1ms for typical modules, fast enough for live coding.

| Benchmark | vs JS | Notes |
|-----------|-------|-------|
| `fib(30)` | **2x faster** | Recursive — WASM call overhead amortized |
| `Float64Array.sum(10k)` | **2.5x faster** | Typed memory + loop hoisting |
| `mandelbrot(100)` | ~0.7x | V8 JIT applies CSE that WASM doesn't |
| `(a, b) => a + b` | 41 bytes | Pure scalar — no memory, no runtime |
| `watr` self-host (compile WAT→WASM) | **1.0–4.4x** native vs V8 JS | 21/21 examples; native = jz→WASM→wasm2c+clang+PGO+LTO |

WASM wins on typed memory and deep recursion. V8 can match or beat WASM on pure scalar loops where its JIT applies optimizations like common subexpression elimination. The gap narrows as code uses more typed arrays and less pure arithmetic.

Best for: typed array processing, DSP, audio, math, pixel manipulation, physics, recursion.
Not ideal for: DOM manipulation, async I/O, heavy string processing, pure scalar loops where V8 JIT excels.

#### What optimizations does jz apply?

| Optimization | Layer | What it does |
|--------------|-------|-------------|
| Constant folding | jz | Evaluates `2 * 3` → `6`, `x + 0` → `x`, `x * 1` → `x` at compile time |
| Dead code elimination | jz | Removes `if (false)` branches, unreachable code after `return` |
| i32 preservation | jz | Keeps integer locals as `i32` instead of promoting to `f64` — faster bitwise, comparison, indexing |
| SIMD vectorization | jz | `Float64Array.map(x => x * 2)` → `f64x2.mul` SIMD instructions |
| Tail call optimization | jz | `return f(x)` → `return_call` — no stack growth for recursive calls |
| Loop-invariant hoisting | jz | `arr.length` in `for` conditions evaluated once, cached in local |
| Callback inlining | jz | `.map(x => x * 2)` inlined — no closure alloc, no `call_indirect` per iteration |
| Inline closure ABI | jz | Uniform `(env, argc, a0..a7)` signature — no per-call heap args-array allocation |
| Chain fusion | jz | `.map(f).filter(g)` → single loop, no intermediate array |
| Monomorphic dispatch | jz | Known types skip runtime type checks for `.length`, `[]`, method calls |
| Branchless select | jz | Pure ternaries `a ? b : c` → WASM `select` (no branching) |
| Schema slot reads | jz | `obj.prop` on inferred shape → `f64.load (base + idx*8)` — no hash, no dispatch |
| Pointer-type subexpression elimination | jz | Repeated `__ptr_type x` in same block → single `local.tee`, reused |
| Memarg fold | jz | `(i32.load (i32.add ptr (i32.const k)))` → `(i32.load offset=k ptr)` — fewer instructions |
| Bulk memory ops | jz | String copy/slice/repeat/pad/encode → `memory.copy` (lowers to memcpy) |
| Chunked compare | jz | `__str_eq` does 4-byte unaligned `i32.load` per step (~4× inner-loop throughput) |
| Inline FNV-1a | jz | `__str_hash` 4-byte unrolled (one `i32.load` + 4 sequential xor/mul per iter) |
| Dispatch hoisting | jz | SSO/heap branch lifted out of inner byte loop in slice/case/pad/indexOf/etc. |
| Inline dyn property probe | jz | `__dyn_get` (95M calls in self-host) inlines `__hash_get_local`'s probe loop — skips redundant type check + bit unboxing on already-validated props hash |
| Inline/peephole | watr | Instruction-level optimization on WAT output |

#### What JS features are excluded and why?

| Excluded | Reason | jzify? |
|----------|--------|--------|
| `var` | Hoisting. Use `let`/`const`. | `var` → `let` |
| `function` | Hoisting. Use arrows. | `function f(){}` → `const f = () => {}` |
| `class`, `this`, `super` | OOP. Use plain objects and functions. | — |
| `async`/`await` | WASM is synchronous. Use host callbacks. | — |
| `do`...`while` | Use `while` or `for`. | — |
| `eval`, `with` | Dynamic scope. Not compilable. | — |
| `arguments` | Implicit. Use rest params `...args`. | — |
| `typeof` (string result) | `typeof x === 'string'` works as compile-time check. | — |
| `null` vs `undefined` | One nullish value. `??` just works. | — |
| `==`/`!=` | No loose equality. | `==` → `===`, `!=` → `!==` |
| `switch` | Use `if`/`else` chains. | `switch` → `if`/`else` |
| `new X()` | Constructor syntax. | `new X()` → `X()` (except TypedArrays) |

#### What's the difference between `jz()` and `compile()`?

```js
import jz, { compile } from 'jz'

// jz() — compile + instantiate + wrap. Handles defaults, rest params, WASI.
const { exports: { f } } = jz('export let f = (x = 5) => x')
f()  // 5

// compile() — returns raw WASM binary. You handle instantiation.
const wasm = compile('export let f = (x) => x * 2')
// Use jz.wrap() if you need the JS calling convention:
const mod = new WebAssembly.Module(wasm)
const inst = new WebAssembly.Instance(mod)
const wrapped = jz.wrap(mod, inst)
```

#### How do TypedArrays and SIMD work?

TypedArrays (`Float64Array`, `Int32Array`, etc.) compile to typed WASM memory with correct byte strides. `.map()` auto-vectorizes recognized patterns to SIMD:

```js
const { exports, memory } = jz(`export let f = () => {
  let buf = new Float64Array(1024)
  // ... fill buf ...
  return buf.map(x => x * 2)  // compiles to f64x2.mul SIMD
}`)
memory.read(exports.f())  // Float64Array with doubled values
```

## Used by

* [web-audio-api](https://github.com/audiojs/web-audio-api)
* [color-space](https://github.com/colorjs/color-space)
<!-- TODO: audio-filter, digital-filter, time-stretch etc -->

## Under the Hood

* [subscript](https://github.com/dy/subscript) — JS parser. Minimal, extensible, builds the exact AST jz needs without a full ES parser. Jessie subset keeps the grammar small and deterministic.
* [watr](https://www.npmjs.com/package/watr) — WAT to WASM compiler. Handles binary encoding, validation, and peephole optimization. jz emits WAT text, watr turns it into a valid `.wasm` binary.

## Alternatives

* [porffor](https://github.com/CanadaHonk/porffor) — ahead-of-time JS→WASM compiler targeting full TC39 semantics. Implements the spec progressively (test262). Where jz restricts the language for performance, porffor aims for completeness.
* [jawsm](https://github.com/drogus/jawsm) — JS→WASM compiler in Rust. Compiles standard JS with a runtime that provides GC and closures in WASM.


<p align=center><a href="https://github.com/krishnized/license/">ॐ</a></p>
