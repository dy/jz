<img src="logo.svg" alt="jz logo" width="120"/>



## ![stability](https://img.shields.io/badge/stability-experimental-black) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml)


**JZ** (_javascript zero_) is **minimal modern functional JS subset**, compiling to WASM.<br/>

```js
import jz from 'jz'

const { exports: { fib } } = jz`export let fib = (n) => n < 2 ? n : fib(n-1) + fib(n-2)`
fib(40)  // 102334155
```


## Usage

```js
import jz, { compile } from 'jz'

// Compile, instantiate
const { exports: { add } } = jz('export let add = (a, b) => a + b')
add(2, 3)  // 5

// Compile only — returns raw WASM binary (no JS adaptation)
const wasm = compile('export let f = (x) => x * 2')
const mod = new WebAssembly.Module(wasm)
const inst = new WebAssembly.Instance(mod)

// Inspect generated WAT
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

## Language

JZ supports complete JS syntax with Crockford "best parts" constraints.<br>
Built-in `jzify` transform auto-fixes most legacy patterns.

|  | Note | jzify |
|---|------|-------|
| `var`, `function` decl | hoisting; use `let`/`const` and arrows | `var`→`let`, `function f(){}`→`const f=()=>{}` |
| `class`, `this`, `super` | use plain objects + closures | — |
| `async`/`await`, `Promise`, generators (`function*`, `yield`) | no async runtime — use callbacks (`setTimeout`) | — |
| `eval`, `with`, `arguments` | dynamic scope; use `...rest` for arguments | — |
| `do`...`while` | use `while` or `for` | — |
| `==`/`!=` | no loose equality | `==`→`===`, `!=`→`!==` |
| `switch` | use `if`/`else` chains | `switch`→`if`/`else` |
| `new X()` | call as `X()` | `new X()`→`X()` |
| `delete`, `instanceof` | not supported | — |
| `Proxy`, `Reflect`, `WeakMap`, `WeakSet` | needs GC introspection | — |
| `Intl`, `new Date()`, DOM, `fetch` | use `Date.now()` for time, host imports for I/O | — |
| `require`, dynamic `import()` | static ES `import` only | — |
| `null` / `undefined` | both nullish; `== null` / `??` / `===` treat equal; distinct sentinels preserved at host boundary | jzify: `undefined`→`null` |
| `typeof` (string result) | compile-time check only (`typeof x === 'string'`) | — |


## FAQ

## Why?

JS became complex and with regrets (coercions, hoisting, `this`, classes, precision loss). Ongoing proposals keep shaping language which is already good.

_JZ_ (javascript zero) is an attempt to secure best JS parts from platform, spec, and engine drift. It keeps minimal functional JS best practices ([Crockford good parts](https://www.youtube.com/watch?v=_DKkVvOt6dk)), drops the rest. Write normal JS and get WASM – portable, fast, long-lasting.

* **Static** – no runtime, no GC, no dynamic constructs.
* **Valid jz = valid js** — test in browser, compile to wasm.
* **Realtime** — compiles faster than `eval`, useful for live-coding and REPL.
* **Minimal output** — produced WAT/WASM is on par with hand-written.

Initially intended for bytebeats, inspired by [porffor](https://github.com/CanadaHonk/porffor) and [piezo](https://github.com/dy/piezo).


### How to pass data between JS and WASM?

Numbers pass directly as f64. Strings, arrays, objects, and typed arrays are heap values — `inst.memory` provides read/write across the boundary:

```js
const { exports, memory } = jz(\`
  export let greet = (s) => s.length
  export let sum = (a) => a.reduce((s, x) => s + x, 0)
  export let dist = (p) => (p.x * p.x + p.y * p.y) ** 0.5
  export let process = (buf) => buf.map(x => x * 2)
\`)

// JS → WASM (write)
memory.String('hello')               // → string pointer
memory.Array([1, 2, 3])              // → array pointer
memory.Float64Array([1.0, 2.0])      // → typed array pointer
memory.Int32Array([10, 20, 30])      // all typed array constructors available

// Objects: keys and order must match the jz source declaration.
// jz objects are fixed-layout schemas (like C structs), not dynamic key bags.
memory.Object({ x: 3, y: 4 })       // → object pointer

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
jz\`export let f = () => \${'hello'}.length + \${[1,2,3]}[0] + \${{x: 5, y: 10}}.x\`
```

<!--
### How does everything fit in f64?

All values are IEEE 754 f64 (at WASM boundary). Integers up to 2^53 are exact. Heap types use [NaN-boxing](https://nachtimwald.com/2019/11/06/nan-boxing/): quiet NaN (`0x7FF8`) + 51-bit payload `[type:4][aux:15][offset:32]`.

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

**Why NaN-boxing?** used by LuaJIT, JavaScriptCore, SpiderMonkey. The alternatives — tagged unions (OCaml, Haskell), pointer tagging (V8 Smis), or separate type+value pairs — all require branching at call boundaries or multi-word passing. NaN-boxing fits any value in one 64-bit word: one calling convention, one memory layout, one comparison instruction.

**The f64 tradeoff**: f64 arithmetic is ~1.2x slower than i32 for pure integer work on most architectures. jz mitigates this — `analyzeLocals` preserves i32 for loop counters, bitwise ops, and comparisons, so the penalty only applies to mixed-type parameters. The gain: zero interop cost at the JS↔WASM boundary (f64 is WASM's native JS-compatible type), no marshaling, no boxing/unboxing. For jz's target workloads (DSP, typed arrays, math), f64 is the natural type anyway.

**NaN preservation**: IEEE 754 defines 2^52 − 1 distinct NaN bit patterns. WASM preserves NaN payload bits through arithmetic (spec requires `nondeterministic_nan`), and JS engines canonicalize only on certain operations (`Math.fround`, structured clone). jz uses quiet NaNs (`0x7FF8` prefix) which survive all standard paths. The 51 payload bits encode type (4), aux metadata (15), and heap offset (32) — enough for 4GB addressable memory and 12 type codes.
-->

### How does template interpolation work?

Numbers and booleans inline directly into source. Strings, arrays, and objects are serialized as jz source literals and compiled at compile time — no post-instantiation allocation, no getter overhead:

```js
jz`export let f = () => \${'hello'}.length`              // 5 — string compiled as literal
jz`export let f = () => \${[10, 20, 30]}[1]`             // 20 — array compiled as literal
jz`export let f = () => \${{name: 'jz', count: 3}}.count` // 3 — object compiled as literal

// Nested values work too
jz`export let f = () => \${{label: 'origin', x: 0, y: 0}}.label.length`  // 6
```

Functions are imported as host calls. Non-serializable values (host objects, class instances) fall back to post-instantiation getters automatically.

### Does it support imports?

Yes — standard ES `import` syntax, bundled at compile-time into one WASM.

```js
// modules: jz source bundled at compile time
const { exports } = jz(
  'import { add } from "./math.jz"; export let f = (a, b) => add(a, b)',
  { modules: { './math.jz': 'export let add = (a, b) => a + b' } }
)

// imports: JS functions wired at instantiation
const { exports } = jz(
  'import { log } from "host"; export let f = (x) => { log(x); return x }',
  { imports: { host: { log: console.log } } }
)
```

Transitive imports work (main → math → utils → …). Circular imports error at compile time. Output is always one WASM binary — no runtime resolution.

**CLI** resolves filesystem imports automatically.

```sh
jz main.jz -o main.wasm    # reads ./math.jz, ./utils.jz automatically
```

**Browser**: fetch sources yourself, pass via `{ modules }`. The compiler stays synchronous and pure — no I/O.

```js
// Transitive bundling — all merged into one WASM
const { exports } = jz(mainSrc, { modules: {
  './math.jz': 'import { sq } from "./utils.jz"; export let dist = (x, y) => (sq(x) + sq(y)) ** 0.5',
  // Fetch sources yourself, pass them in
  './utils.jz': await fetch('./util.jz').then(r => r.text())
} })
```

### Can two modules share data?

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


### How do I run compiled WASM outside the browser?

```sh
jz program.js -o program.wasm

# Run with any WASM runtime
wasmtime program.wasm     # WASI support built in
wasmer run program.wasm
deno run program.wasm
```

`console.log` compiles to WASI `fd_write` — works natively on wasmtime/wasmer/deno without polyfills.


### What host features are supported?

The compiled `.wasm` uses two import namespaces:

- `wasi_snapshot_preview1` — standard WASI Preview 1 calls. Run natively on wasmtime, wasmer, deno; for browsers/Node, jz ships a tiny polyfill (`jz/wasi`) auto-applied by the `jz()` runtime.
- `jz` — host imports for features WASI doesn't cover. Supplied only by the `jz()` runtime (browser/Node event loop). Pure wasmtime/wasmer can stub them or use modules that don't call them.

| JS API | Maps to | Notes |
|--------|---------|-------|
| `console.log()` | WASI `fd_write` (fd=1) | Multiple args space-separated, newline appended |
| `console.warn()`, `console.error()` | WASI `fd_write` (fd=2) | Writes to stderr |
| `Date.now()` | WASI `clock_time_get` (realtime) | Returns ms since epoch |
| `performance.now()` | WASI `clock_time_get` (monotonic) | Returns ms, high-resolution |
| `setTimeout`, `clearTimeout` | `jz` host import | Callback dispatched via exported `__jz_table`; requires JS event loop |
| `setInterval`, `clearInterval` | `jz` host import | Same — only under `jz()` runtime |

### Is it fast?

Competitive. See benchmark:

| | **jz** | [Node](https://nodejs.org/) | [AS](https://github.com/AssemblyScript/assemblyscript) | WAT | C | [Go](https://go.dev/) | [Rust](https://www.rust-lang.org/) |
|---|---|---|---|---|---|---|---|
| **biquad** | **11.19 ms**<br>**8.0 kB** | 12.43 ms<br>5.3 kB | 8.94 ms<br>1.9 kB | 6.45 ms<br>767 B | 5.35 ms<br>32.8 kB | 8.92 ms<br>2.39 MB | 5.36 ms<br>471.9 kB |
| **tokenizer** | **0.10 ms**<br>**7.5 kB** | 0.17 ms<br>1.4 kB | 0.06 ms<br>1.5 kB | — | 0.16 ms<br>32.9 kB | 0.07 ms<br>2.39 MB | 0.12 ms<br>471.8 kB |
| **mat4** | **8.58 ms**<br>**7.5 kB** | 11.54 ms<br>1.1 kB | 9.12 ms<br>1.5 kB | — | 2.62 ms<br>32.9 kB | 11.54 ms<br>2.39 MB | 0.80 ms<br>471.9 kB |
| **aos** | **3.53 ms**<br>**9.4 kB** | 1.79 ms<br>1.1 kB | 1.91 ms<br>2.2 kB | — | 1.20 ms<br>32.9 kB | 0.90 ms<br>2.39 MB | 1.21 ms<br>471.8 kB |
| **bitwise** | **8.37 ms**<br>**7.4 kB** | 5.48 ms<br>1005 B | 11.99 ms<br>1.5 kB | — | 1.31 ms<br>32.9 kB | 5.24 ms<br>2.39 MB | 1.31 ms<br>471.8 kB |
| **poly** | **1.13 ms**<br>**7.4 kB** | 2.29 ms<br>1014 B | 1.13 ms<br>1.3 kB | — | 0.53 ms<br>32.9 kB | 0.80 ms<br>2.39 MB | 0.52 ms<br>471.8 kB |
| **callback** | **3.81 ms**<br>**8.6 kB** | 0.98 ms<br>828 B | 1.48 ms<br>1.9 kB | — | 0.10 ms<br>32.9 kB | 0.20 ms<br>2.39 MB | 0.08 ms<br>471.8 kB |
| **json** | **0.54 ms**<br>**11.2 kB** | 0.39 ms<br>923 B | — | — | 0.03 ms<br>32.9 kB | 1.07 ms<br>2.93 MB | 0.03 ms<br>471.9 kB |

_Numbers from `node bench/bench.mjs` on Apple Silicon._


### Can I compile jz to C?

Yes, via [wasm2c](https://github.com/nicbarker/wasm2c) or [w2c2](https://github.com/nicbarker/w2c2):

```sh
jz program.js -o program.wasm
wasm2c program.wasm -o program.c
cc program.c -o program
```

jz → WASM → C → native binary.


## Used by

* [web-audio-api](https://github.com/audiojs/web-audio-api)
* [color-space](https://github.com/colorjs/color-space)
* [audiojs](https://github.com/colorjs/audiojs)
<!-- * [audio-filter](https://github.com/audiojs/audio-filter)
* [digital-filter](https://github.com/audiojs/digital-filter)
* [time-stretch](https://github.com/audiojs/time-stretch) -->

## Alternatives

* [porffor](https://github.com/CanadaHonk/porffor) — ahead-of-time JS→WASM compiler targeting full TC39 semantics. Implements the spec progressively (test262). Where jz restricts the language for performance, porffor aims for completeness.
* [assemblyscript](https://github.com/AssemblyScript/assemblyscript) — TypeScript-subset compiling to WASM — small, performant output, but requires type annotations.
* [jawsm](https://github.com/drogus/jawsm) — JS→WASM compiler in Rust. Compiles standard JS with a runtime that provides GC and closures in WASM.

## Build with

* [subscript](https://github.com/dy/subscript) — JS parser. Minimal, extensible, builds the exact AST jz needs without a full ES parser. Jessie subset keeps the grammar small and deterministic.
* [watr](https://www.npmjs.com/package/watr) — WAT to WASM compiler. Handles binary encoding, validation, and peephole optimization. jz emits WAT text, watr turns it into a valid `.wasm` binary.


<p align=center>MIT • <a href="https://github.com/krishnized/license/">ॐ</a></p>
n | jz | Repeated `__ptr_type x` in same block → single `local.tee`, reused |
| Memarg fold | jz | `(i32.load (i32.add ptr (i32.const k)))` → `(i32.load offset=k ptr)` — fewer instructions |
| Bulk memory ops | jz | String copy/slice/repeat/pad/encode → `memory.copy` (lowers to memcpy) |
| Chunked compare | jz | `__str_eq` does 4-byte unaligned `i32.load` per step (~4× inner-loop throughput) |
| Inline FNV-1a | jz | `__str_hash` 4-byte unrolled (one `i32.load` + 4 sequential xor/mul per iter) |
| Dispatch hoisting | jz | SSO/heap branch lifted out of inner byte loop in slice/case/pad/indexOf/etc. |
| Inline dyn property probe | jz | `__dyn_get` (95M calls in self-host) inlines `__hash_get_local`'s probe loop — skips redundant type check + bit unboxing on already-validated props hash |
| Inline/peephole | watr | Instruction-level optimization on WAT output |
-->

<!--
### How do TypedArrays and SIMD work?

TypedArrays (`Float64Array`, `Int32Array`, etc.) compile to typed WASM memory with correct byte strides. `.map()` auto-vectorizes recognized patterns to SIMD:

```js
const { exports, memory } = jz(`export let f = () => {
  let buf = new Float64Array(1024)
  // ... fill buf ...
  return buf.map(x => x * 2)  // compiles to f64x2.mul SIMD
}`)
memory.read(exports.f())  // Float64Array with doubled values
```
-->

### How do I run compiled WASM outside the browser?

```sh
jz program.js -o program.wasm

# Run with any WASM runtime
wasmtime program.wasm     # WASI support built in
wasmer run program.wasm
deno run program.wasm
```

`console.log` compiles to WASI `fd_write` — works natively on wasmtime/wasmer/deno without polyfills.

### What host features are supported?

The compiled `.wasm` uses two import namespaces:

- `wasi_snapshot_preview1` — standard WASI Preview 1 calls. Run natively on wasmtime, wasmer, deno; for browsers/Node, jz ships a tiny polyfill (`jz/wasi`) auto-applied by the `jz()` runtime.
- `jz` — host imports for features WASI doesn't cover. Supplied only by the `jz()` runtime (browser/Node event loop). Pure wasmtime/wasmer can stub them or use modules that don't call them.

| JS API | Maps to | Notes |
|--------|---------|-------|
| `console.log()` | WASI `fd_write` (fd=1) | Multiple args space-separated, newline appended |
| `console.warn()`, `console.error()` | WASI `fd_write` (fd=2) | Writes to stderr |
| `Date.now()` | WASI `clock_time_get` (realtime) | Returns ms since epoch |
| `performance.now()` | WASI `clock_time_get` (monotonic) | Returns ms, high-resolution |
| `setTimeout`, `clearTimeout` | `jz` host import | Callback dispatched via exported `__jz_table`; requires JS event loop |
| `setInterval`, `clearInterval` | `jz` host import | Same — only under `jz()` runtime |

### Is it fast?

Competitive. See benchmark:

| | **jz** | [Node](https://nodejs.org/) | [AS](https://github.com/AssemblyScript/assemblyscript) | WAT | C | [Go](https://go.dev/) | [Rust](https://www.rust-lang.org/) |
|---|---|---|---|---|---|---|---|
| **biquad** | **11.19 ms**<br>**8.0 kB** | 12.43 ms<br>5.3 kB | 8.94 ms<br>1.9 kB | 6.45 ms<br>767 B | 5.35 ms<br>32.8 kB | 8.92 ms<br>2.39 MB | 5.36 ms<br>471.9 kB |
| **tokenizer** | **0.10 ms**<br>**7.5 kB** | 0.17 ms<br>1.4 kB | 0.06 ms<br>1.5 kB | — | 0.16 ms<br>32.9 kB | 0.07 ms<br>2.39 MB | 0.12 ms<br>471.8 kB |
| **mat4** | **8.58 ms**<br>**7.5 kB** | 11.54 ms<br>1.1 kB | 9.12 ms<br>1.5 kB | — | 2.62 ms<br>32.9 kB | 11.54 ms<br>2.39 MB | 0.80 ms<br>471.9 kB |
| **aos** | **3.53 ms**<br>**9.4 kB** | 1.79 ms<br>1.1 kB | 1.91 ms<br>2.2 kB | — | 1.20 ms<br>32.9 kB | 0.90 ms<br>2.39 MB | 1.21 ms<br>471.8 kB |
| **bitwise** | **8.37 ms**<br>**7.4 kB** | 5.48 ms<br>1005 B | 11.99 ms<br>1.5 kB | — | 1.31 ms<br>32.9 kB | 5.24 ms<br>2.39 MB | 1.31 ms<br>471.8 kB |
| **poly** | **1.13 ms**<br>**7.4 kB** | 2.29 ms<br>1014 B | 1.13 ms<br>1.3 kB | — | 0.53 ms<br>32.9 kB | 0.80 ms<br>2.39 MB | 0.52 ms<br>471.8 kB |
| **callback** | **3.81 ms**<br>**8.6 kB** | 0.98 ms<br>828 B | 1.48 ms<br>1.9 kB | — | 0.10 ms<br>32.9 kB | 0.20 ms<br>2.39 MB | 0.08 ms<br>471.8 kB |
| **json** | **0.54 ms**<br>**11.2 kB** | 0.39 ms<br>923 B | — | — | 0.03 ms<br>32.9 kB | 1.07 ms<br>2.93 MB | 0.03 ms<br>471.9 kB |

_Numbers from `node bench/bench.mjs` on Apple Silicon._


### Can I compile jz to C?

Yes, via [wasm2c](https://github.com/nicbarker/wasm2c) or [w2c2](https://github.com/nicbarker/w2c2):

```sh
jz program.js -o program.wasm
wasm2c program.wasm -o program.c
cc program.c -o program
```

jz → WASM → C → native binary.

## Used by

* [web-audio-api](https://github.com/audiojs/web-audio-api)
* [color-space](https://github.com/colorjs/color-space)
* [audiojs](https://github.com/colorjs/audiojs)
<!-- * [audio-filter](https://github.com/audiojs/audio-filter)
* [digital-filter](https://github.com/audiojs/digital-filter)
* [time-stretch](https://github.com/audiojs/time-stretch) -->

## Alternatives

* [porffor](https://github.com/CanadaHonk/porffor) — ahead-of-time JS→WASM compiler targeting full TC39 semantics. Implements the spec progressively (test262). Where jz restricts the language for performance, porffor aims for completeness.
* [assemblyscript](https://github.com/AssemblyScript/assemblyscript) — TypeScript-subset compiling to WASM — small, performant output, but requires type annotations.
* [jawsm](https://github.com/drogus/jawsm) — JS→WASM compiler in Rust. Compiles standard JS with a runtime that provides GC and closures in WASM.

## Build with

* [subscript](https://github.com/dy/subscript) — JS parser. Minimal, extensible, builds the exact AST jz needs without a full ES parser. Jessie subset keeps the grammar small and deterministic.
* [watr](https://www.npmjs.com/package/watr) — WAT to WASM compiler. Handles binary encoding, validation, and peephole optimization. jz emits WAT text, watr turns it into a valid `.wasm` binary.


<p align=center>MIT • <a href="https://github.com/krishnized/license/">ॐ</a></p>
