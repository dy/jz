<img src="logo.svg" alt="jz logo" width="120"/>



## ![stability](https://img.shields.io/badge/stability-experimental-black) [![npm](https://img.shields.io/npm/v/jz)](http://npmjs.org/jz) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml)


**JZ** (_javascript zero_) is **minimal modern functional JS subset**, compiling to WASM.<br/>

```js
import jz from 'jz'

// Distance between two points
const { exports: { dist } } = jz`export let dist = (x, y) => (x*x + y*y) ** 0.5`
dist(3, 4) // 5
```

## Why?

**Write plain JS, compile to WASM** – fast, portable and long-lasting. JZ distills the modern functional core – the "good parts" [Crockford](https://www.youtube.com/watch?v=_DKkVvOt6dk) – from legacy semantics, features overhead and perf quirks.

* **Static** – no runtime, no GC, no dynamic constructs.
* **Valid jz = valid js** — test in browser, compile to wasm.
* **Minimal** — output is close to hand-written WAT.
<!-- * **Realtime** — compiles faster than `eval`, useful for live-coding and REPL. -->

Inspired by [porffor](https://github.com/CanadaHonk/porffor) and [piezo](https://github.com/dy/piezo).
<!-- Used internally by: web-audio-api, color-space, audiojs -->

| Good for                    | Not for                    |
|-----------------------------|----------------------------|
| Numeric / math compute      | UI / frontend              |
| DSP / audio / bytebeats     | Backend / APIs             |
| Parsing / transforms        | Async / I/O-heavy logic    |
| WASM utilities              | JavaScript runtime         |


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
```

## CLI

`npm install -g jz`

```sh
# Compile
jz program.js # → program.wasm

# Evaluate
jz -e "1 + 2" # 3

# Show help
jz --help
```

## Language

JZ is a strict functional JS subset. Built-in `jzify` transform extends support to legacy patterns.

<!--
```mermaid
%%{init: {'flowchart': {'titleTopMargin': 0, 'padding': 0, 'margin': 0}}}%%
flowchart TB
    classDef plain fill:none,stroke:none,font-size:14px,font-weight:bold,padding:0px,margin:0px

    subgraph JS[JS — not supported]
        subgraph JZify[JZ + jzify]
            subgraph JZ[JZ strict]
                j1["let/const, arrows, default/rest params, flow, break/continue, try/catch, a[]/a()/a.b, operators, strings, booleans, numbers, std, memory, host"]:::plain
            end
            z1["var, function, arguments, switch, new Foo(), ==, !=, instanceof"]:::plain
        end
        n1["async/await, Promise, generators, this, class, eval, Function, with, Proxy, Reflect, WeakMap, WeakSet, dynamic import, DOM, fetch, Intl, Node APIs"]:::plain
    end

    style JZ fill:#ffe0b2,stroke-width:0
    style JZify fill:#fff9c4,stroke-width:0
    style JS fill:#ffffff,stroke:#ccc,stroke-width:1px
    style n1 min-width:720px
```
-->

```
┌────────────────────────────────────────────────────────────────────────┐
│ JZify                                                   test262: 0.5%  │
│   var  function  arguments  switch  new Foo()                          │
│   ==  !=  instanceof  undefined                                        │
│                                                                        │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ JZ                                                                 │ │
│ │   let/const  =>  ...xs  destructuring  import/export               │ │
│ │   if/else  for/while/do-while/of/in  break/continue                │ │
│ │   try/catch/finally  throw                                         │ │
│ │   operators  strings  booleans  numbers  arrays  objects  `${}`    │ │
│ │   Math  Number  String  Array  Object  JSON  RegExp  Symbol  null  │ │
│ │   ArrayBuffer  DataView  TypedArray  Map  Set                      │ │
│ │   console  setTimeout/setInterval  Date  performance               │ │
│ └────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘

`test262` is measured against all JS files under `test262/test`, not a selected subset.

Not supported
  async/await  Promise  function*  yield
  this  class  super  extends  delete  labels
  eval  Function  with  Proxy  Reflect  WeakMap  WeakSet
  dynamic import  DOM  fetch  Intl  Node APIs
```



## FAQ

<details>
<summary><strong>How to pass data between JS and WASM?</strong></summary>

<br>

Numbers pass directly as f64. Strings, arrays, objects, and typed arrays are heap values — `inst.memory` provides read/write across the boundary:

```js
const { exports, memory } = jz`
  export let greet = (s) => s.length
  export let sum = (a) => a.reduce((s, x) => s + x, 0)
  export let dist = (p) => (p.x * p.x + p.y * p.y) ** 0.5
  export let process = (buf) => buf.map(x => x * 2)
`

// JS → WASM (write)
memory.String('hello')               // → string pointer
memory.Array([1, 2, 3])              // → array pointer
memory.Float64Array([1.0, 2.0])      // → typed array pointer
memory.Int32Array([10, 20, 30])      // all typed array constructors available

// ⚠ Objects: keys and order must match the jz source declaration.
// jz objects are fixed-layout schemas (like C structs), not dynamic key bags.
// If the jz source declares `{ x, y }`, you must pass `{ x, y }` in that order.
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
jz\`export let f = () => ${'hello'}.length + ${[1,2,3]}[0] + ${{x: 5, y: 10}}.x\`
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

</details>

<details>
<summary><strong>How does template interpolation work?</strong></summary>

<br>

Numbers and booleans inline directly into source. Strings, arrays, and objects are serialized as jz source literals and compiled at compile time — no post-instantiation allocation, no getter overhead:

```js
jz`export let f = () => ${'hello'}.length`              // 5 — string compiled as literal
jz`export let f = () => ${[10, 20, 30]}[1]`             // 20 — array compiled as literal
jz`export let f = () => ${{name: 'jz', count: 3}}.count` // 3 — object compiled as literal

// Nested values work too
jz`export let f = () => ${{label: 'origin', x: 0, y: 0}}.label.length`  // 6
```

Functions are imported as host calls. Non-serializable values (host objects, class instances) fall back to post-instantiation getters automatically.

</details>

<details>
<summary><strong>Does it support ES module imports?</strong></summary>

<br>

Yes — standard ES `import` syntax is bundled at compile-time into a single WASM.

```js
const { exports } = jz(
  'import { add } from "./math.jz"; export let f = (a, b) => add(a, b)',
  { modules: { './math.jz': 'export let add = (a, b) => a + b' } }
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

</details>

<details>
<summary><strong>Can I call JS/host functions from jz?</strong></summary>

<br>

Yes — JS functions are wired at instantiation via the `imports` option:

```js
const { exports } = jz(
  'import { log } from "host"; export let f = (x) => { log(x); return x }',
  { imports: { host: { log: console.log } } }
)
```

You can also pass whole host environment objects — `Math`, `Date`, `window`, `console`, or any custom namespace object. jz extracts the functions it needs via `Object.getOwnPropertyNames`, so non-enumerable built-ins (like `Math.sin`) work automatically:

```js
// Pass the entire Math namespace — sin, cos, sqrt, PI, etc. auto-wired
const { exports } = jz(
  'import { sin, PI } from "math"; export let f = () => sin(PI / 2)',
  { imports: { math: Math } }
)

// Pass Date static methods
const { exports } = jz(
  'import { now } from "date"; export let f = () => now()',
  { imports: { date: Date } }
)

// Pass window / globalThis
const { exports } = jz(
  'import { parseInt } from "window"; export let f = () => parseInt("42")',
  { imports: { window: globalThis } }
)
```

</details>

<details>
<summary><strong>Can two modules share data?</strong></summary>

<br>

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


</details>

<details>
<summary><strong>How do I run compiled WASM outside the browser?</strong></summary>

<br>

```sh
jz program.js -o program.wasm

# Run with any WASM runtime
wasmtime program.wasm     # WASI support built in
wasmer run program.wasm
deno run program.wasm
```

`console.log` compiles to WASI `fd_write` — works natively on wasmtime/wasmer/deno without polyfills.


</details>

<details>
<summary><strong>What host features are supported?</strong></summary>

<br>

The compiled `.wasm` uses one import namespace:

- `wasi_snapshot_preview1` — standard WASI Preview 1 calls. Run natively on wasmtime, wasmer, deno; for browsers/Node, jz ships a tiny polyfill (`jz/wasi`) auto-applied by the `jz()` runtime.

| JS API | Maps to | Notes |
|--------|---------|-------|
| `console.log()` | WASI `fd_write` (fd=1) | Multiple args space-separated, newline appended |
| `console.warn()`, `console.error()` | WASI `fd_write` (fd=2) | Writes to stderr |
| `Date.now()` | WASI `clock_time_get` (realtime) | Returns ms since epoch |
| `performance.now()` | WASI `clock_time_get` (monotonic) | Returns ms, high-resolution |
| `setTimeout`, `clearTimeout` | WASM timer queue + `__timer_tick` | JS runtime drives tick via `setInterval`; wasmtime uses blocking `__timer_loop` |
| `setInterval`, `clearInterval` | WASM timer queue + `__timer_tick` | Same — native WASM implementation, no host imports |

</details>

<details>
<summary><strong>How do I add custom operators / extend the stdlib?</strong></summary>

<br>

jz's emitter table (`ctx.core.emit`) maps AST operators → WASM IR generators. Module files in `module/` register handlers on it. To add your own:

```js
import { emitter } from 'jz/src/compile.js'

// Register a custom operator: my.double(x) → x * 2
emitter['my.double'] = (x) => {
  return ['f64.mul', ['f64.const', 2], x]
}
```

The naming convention follows the AST path: `Math.sin` → `math.sin`, `arr.push` → `.push`, typed variants like `.f64:push`. See any file in `module/` for the full pattern — each exports a function that registers emitters and stdlib on `ctx`.

</details>

<details>
<summary><strong>Can I compile jz to C?</strong></summary>

<br>

Yes, via [wasm2c](https://github.com/WebAssembly/wabt/blob/main/wasm2c) or [w2c2](https://github.com/turbolent/w2c2):

```sh
jz program.js -o program.wasm
wasm2c program.wasm -o program.c
cc program.c -o program
```
</details>


## Benchmark

| | **jz** | [Node](https://nodejs.org/) | [AS](https://github.com/AssemblyScript/assemblyscript) | WAT | C | [Go](https://go.dev/) | [Zig](https://ziglang.org/) | [Rust](https://www.rust-lang.org/) | [NumPy](https://numpy.org/) | [Porffor](https://github.com/CanadaHonk/porffor) |
|---|---|---|---|---|---|---|---|---|---|---|
| [**biquad**](bench/biquad/biquad.js) | **6.44ms**<br>**3.4kB** | 12.30ms<br>3.2kB | 9.04ms<br>1.9kB | 6.48ms<br>767 B | 5.43ms | 9.03ms<br>fma | 5.09ms | 5.33ms | 3.15s | — |
| [**tokenizer**](bench/tokenizer/tokenizer.js) | **0.10ms**<br>**1.6kB** | 0.18ms<br>1.4kB | 0.08ms<br>1.5kB | — | 0.13ms | 0.07ms | 0.12ms | 0.12ms | 5.21ms | 0.46ms<br>2.6kB |
| [**mat4**](bench/mat4/mat4.js) | **4.00ms**<br>**1.7kB** | 11.64ms<br>1.1kB | 9.18ms<br>1.5kB | 7.99ms<br>353 B | 2.62ms | 11.93ms | 2.60ms | 0.80ms | 323.69ms | 87.65ms<br>2.3kB |
| [**aos**](bench/aos/aos.js) | **1.50ms**<br>**2.3kB** | 1.81ms<br>1.1kB | 1.91ms<br>2.2kB | — | 1.22ms | 0.90ms | 0.99ms | 1.20ms | 2.23ms | — |
| [**bitwise**](bench/bitwise/bitwise.js) | **4.93ms**<br>**1.2kB** | 5.31ms<br>1005 B | 12.36ms<br>1.5kB | 4.96ms<br>355 B | 1.31ms | 5.24ms | 4.26ms | 1.30ms | 14.89ms | — |
| [**poly**](bench/poly/poly.js) | **1.13ms**<br>**1.3kB** | 2.31ms<br>1014 B | 1.14ms<br>1.3kB | — | 0.52ms | 0.80ms | — | 0.52ms | 0.60ms | — |
| [**callback**](bench/callback/callback.js) | **0.01ms**<br>**1.5kB** | 1.03ms<br>828 B | 1.48ms<br>1.9kB | — | 0.09ms | 0.20ms | 0.01ms | 0.08ms | 1.84ms | — |
| [**json**](bench/json/json.js) | **0.20ms**<br>**2.8kB** | 0.38ms<br>923 B | — | — | 0.02ms | 1.06ms | — | 0.03ms | 1.19ms | — |
| [**watr**](bench/watr/watr.js) | **1.82ms**<br>**137.1kB** | 1.50ms<br>85.3kB | — | — | — | — | — | — | — | — |

_Numbers from `node bench/bench.mjs` on Apple Silicon._


## Alternatives

* [porffor](https://github.com/CanadaHonk/porffor) — ahead-of-time JS→WASM compiler targeting full TC39 semantics. Implements the spec progressively (test262). Where jz restricts the language for performance, porffor aims for completeness.
* [assemblyscript](https://github.com/AssemblyScript/assemblyscript) — TypeScript-subset compiling to WASM — small, performant output, but requires type annotations.
* [jawsm](https://github.com/drogus/jawsm) — JS→WASM compiler in Rust. Compiles standard JS with a runtime that provides GC and closures in WASM.

## Build with

* [subscript](https://github.com/dy/subscript) — JS parser. Minimal, extensible, builds the exact AST jz needs without a full ES parser. Jessie subset keeps the grammar small and deterministic.
* [watr](https://www.npmjs.com/package/watr) — WAT to WASM compiler. Handles binary encoding, validation, and peephole optimization. jz emits WAT text, watr turns it into a valid `.wasm` binary.


<p align=center>MIT • <a href="https://github.com/krishnized/license/">ॐ</a></p>
