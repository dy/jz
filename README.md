<img src="jz.svg" alt="jz logo" width="120"/>

## ![stability](https://img.shields.io/badge/stability-experimental-black) [![npm](https://img.shields.io/npm/v/jz?color=black)](http://npmjs.org/package/jz) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml) [![test262](https://github.com/dy/jz/actions/workflows/test262.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test262.yml) [![bench](https://github.com/dy/jz/actions/workflows/bench.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/bench.yml)

**JZ** (_javascript zero_) is **minimal functional JS subset** that compiles to WASM.


```js
import jz from 'jz'

const { exports: { dist } } = jz`export let dist = (x, y) => (x*x + y*y) ** 0.5`
dist(3, 4) // 5
```


## Why?

_"JavaScript isn't a real language"_ – unfit for hot computation (DSP, audio, parsers etc): JIT deopts, GC glitches, floats-only math, hashmap objects, locked SIMD, legacy ([wtfjs](https://github.com/denysdovhan/wtfjs)) and spec feature-creep – so compute-heavy code gets rewritten in Rust, Go or C and shipped as WASM.

JZ **compiles JS ahead-of-time to WASM** – no runtime, no GC, [near-native speed](#performance) with **real `i32`/`f64`**, **flat-struct objects**, and **auto-vectorized SIMD**.

JZ distills **"the good parts"** ([Crockford](https://www.youtube.com/watch?v=_DKkVvOt6dk)) – no legacy, no spec creep. **Types inferred** – no annotations, no new syntax. **Valid JZ is valid JS** – run and test as JS, compile to portable WASM.


| Good for                    | Not for                    |
|-----------------------------|----------------------------|
| Numeric / math compute      | UI / frontend              |
| DSP / audio / bytebeats     | Backend / APIs             |
| Parsing / transforms        | Async / I/O-heavy logic    |
| WASM utilities              | JavaScript runtime         |


## Usage

`npm install jz`

```js
import jz, { compile } from 'jz'

// Compile + instantiate
const { exports: { add } } = jz('export let add = (a, b) => a + b')
add(2, 3)  // 5

// Compile only — raw WASM binary
const wasm = compile('export let f = (x) => x * 2')

// Compile speed: ~2–60 ms depending on source size (no optimizer overhead)
// Async startup
const asyncMod = await WebAssembly.compile(wasm)
const asyncInst = await WebAssembly.instantiate(asyncMod)
asyncInst.exports.f(21) // 42
```

<details>
<summary><strong>Passing data</strong></summary>

<br>

Numbers pass as f64. Arrays of ≤ 8 elements come back as plain JS arrays (WASM multi-value). Everything else is a heap pointer — use `memory.*` to create and read values:

```js
const { exports, memory } = jz`
  export let greet = (s) => s.length
  export let dist = (p) => (p.x * p.x + p.y * p.y) ** 0.5
  export let rgb = (c) => [c, c * 0.5, c * 0.2]
  export let process = (buf) => buf.map(x => x * 2)
`

// Pass in
exports.greet(memory.String('hello'))        // 5
exports.dist(memory.Object({ x: 3, y: 4 }))  // 5

// Get back
exports.rgb(100)                              // [100, 50, 20] — auto-decoded JS array
memory.read(exports.process(memory.Float64Array([1, 2, 3])))  // Float64Array [2, 4, 6]
```

`memory.String`, `.Array`, `.Float64Array`/etc, and `.Object` all allocate on the WASM heap and return a pointer. `memory.read(ptr)` decodes a pointer back to a JS value. `memory.Object()` creates a fixed-layout object — the key set and order must match the compiled schema.

</details>

<details>
<summary><strong>Template literals</strong></summary>

<br>

Interpolated values are baked into the source at compile time. Numbers and booleans inline directly; strings, arrays, and objects compile as jz literals:

```js
jz`export let f = () => ${'hello'}.length`               // 5
jz`export let f = () => ${[10, 20, 30]}[1]`              // 20
jz`export let f = () => ${{name: 'jz', count: 3}}.count` // 3

const scale = (x) => x * 10
jz`export let f = (n) => ${scale}(n) + 1`                // f(2) → 21, host-called
```
Interpolated functions become host calls. Non-serializable values (host objects, class instances) fall back to post-instantiation getters automatically.
</details>

<details>
<summary><strong>Host imports</strong></summary>

<br>

Any host namespace — functions, constants, custom objects — wires in via the `imports` option:

```js
// Custom function
jz('import { log } from "host"; export let f = (x) => { log(x); return x }',
   { imports: { host: { log: console.log } } })

// Whole namespace — sin, cos, PI, … all auto-wired
jz('import { sin, PI } from "math"; export let f = () => sin(PI / 2)',
   { imports: { math: Math } })

// globalThis works too
jz('import { parseInt } from "window"; export let f = () => parseInt("42")',
   { imports: { window: globalThis } })
```

</details>

<details>
<summary><strong>Host modes: `js`, `wasi`</strong></summary>

<br>

`host: 'js'` (default) imports a few `env.*` services (table below) that `jz()` and `jz/interop` wire to the JS host automatically — overridable via `opts.imports.env`.
`host: 'wasi'` emits WASI Preview 1 for wasmtime/wasmer/deno — no JS host needed.
The compiled `.wasm` carries at most one import namespace (none, `env`, or `wasi_snapshot_preview1`).

| JS API | `host: 'js'` (default) | `host: 'wasi'` |
|---|---|---|
| `console.log()` | `env.print` — host stringifies | WASI `fd_write` |
| `Date.now()` / `performance.now()` | `env.now` → f64 | WASI `clock_time_get` |
| `setTimeout` / `setInterval` | `env.setTimeout` — host schedules | WASM timer queue + `__timer_tick` |
| dynamic `obj.method()` | `env.__ext_call` (JS resolves) | error at compile time |

<sup>`env.now` returns f64, not i64: `performance.now()` is fractional and `Date.now()` overflows i32, while f64 carries both exactly and skips i64↔BigInt boundary marshalling — the same `double` choice Emscripten makes.</sup>

</details>

<details>
<summary><strong>Options</strong></summary><br>

Options are passed as `jz(source, opts)` or `compile(source, opts)`. Common ones:

| Option | Use |
|---|---|
| `modules: { specifier: source }` | Bundle static ES imports into one WASM module. CLI import resolution does this from files automatically. |
| `imports: { mod: host }` | Wire host namespaces/functions used by `import { fn } from "mod"`. |
| `memory` | Pass `memory: N` for owned memory with `N` initial pages, or `memory: jz.memory()` / `WebAssembly.Memory` to share across modules. |
| `host: 'js' \| 'wasi'` | Runtime-service lowering. Default `js`; `wasi` for standalone runtimes. |
| `optimize` | `false`/`0` off, `1` size-only, `true`/`2` default (all stable passes), `3` trades size for speed. String aliases: `'size'`, `'balanced'` (= default), `'speed'`. Object form overrides individual passes. |
| `strict: true` | Enforce the pure canonical subset: skip jzify lowering (so `var`/`function`/`class`/`==`/… are rejected, not accepted) **and** reject dynamic fallbacks (`obj[k]`, `for-in`, unknown receiver methods). Off by default — broader JS is lowered automatically. |
| `alloc: false` | Omit allocator exports (`_alloc`/`_clear`) for standalone modules that never marshal heap values. |
| `randomSeed` | `Math.random` seed for reproducible output — default deterministic; a number fixes it, `true` draws from host entropy. |
| `wat: true` | `compile()` returns WAT text instead of WASM binary. |
| `profile` | Mutable sink for compile-stage timings; set `profile.names = true` for a WASM `name` section. |
</details>

## CLI

`npm install -g jz`

```sh
jz program.js              # → program.wasm
jz program.js --wat        # → program.wat
jz program.js -o out.wasm  # custom output (- for stdout)
jz program.js -O3          # optimization: -O0 off, -O1 size, -O2 balanced, -O3 speed
jz program.js --host wasi  # standalone WASI output
jz --strict program.js     # pure canonical subset (also implied by .jz extension)
jz -e "1 + 2"              # eval → 3
jz --help                  # help
```


## Language

Ordinary JS compiles by default: the built-in **jzify** pass lowers the outer ring (`var`/`function`/`class`/…) into the canonical **JZ** subset. `strict` mode skips jzify and enforces the inner subset directly, rejecting everything outside it.

```
┌────────────────────────────────────────────────────────────────────────┐
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
│ JZify                                                                  │
│   var  function  arguments  switch  new Foo()                          │
|   class  new  this  extends  super  static  #private                   │
│   ==  !=  instanceof  undefined                                        |
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
Not supported
  async/await  Promise  function*  yield
  delete  labels  eval  Function  with
  Proxy  Reflect
  import()  DOM  fetch  Intl  Node APIs
```



## FAQ

<details>
<summary><strong>Where does jz differ from JavaScript?</strong></summary>

<br>

jz compiles to static WASM — some behaviors diverge from V8. `--wat` shows exactly what was emitted.

- **Static numeric types.** `(a, b) => a + b` infers `f64.add` — numeric, not concatenation (give one side a string literal or `= ''` seed to concatenate). Values proven to fit `i32` wrap at ±2³¹ (asm.js `ToInt32`); keep a value f64 for exact integers beyond that. `--wat` shows which locals are `i32`.
- **Fixed-layout objects.** Key set and order are fixed at the literal; `delete` is rejected; `memory.Object({…})` must match source order.
- **No GC.** Memory isn't reclaimed automatically (`memory.reset()` — see below). `WeakMap`/`WeakSet` fold to `Map`/`Set` (weakness is unobservable); `Set`/`Map` iterate slot order, not insertion order.
- **Thin value model.** Errors are untagged — `throw` carries a value, so `e instanceof TypeError` can't discriminate. A boolean from `&&`/`||` or an untyped container crosses the host boundary as `1`/`0` (`typeof`, `String`, `JSON.stringify`, comparisons, and boolean methods return a real boolean).
- **Rough edges.** `String()` of a non-integer keeps ~9 significant digits (`String(1/3)` → `"0.333333333"`). Legacy octal `0377` reads as decimal — use `0o377`.

jz trades completeness for low-level numeric performance by design; for full TC39 conformance, see [alternatives](#alternatives).

</details>

<details>
<summary><strong>Can I use existing npm packages or JS libraries?</strong></summary>

<br>

Only the ones that fit the jz subset. There's no runtime, so packages touching the DOM, `async`/`Promise`, the network, or Node APIs won't compile — but pure numeric/algorithmic source does.

- **Relative imports** (`./dep.js`) bundle at compile time.
- **Bare specifiers** (`import { x } from "pkg"`) resolve through Node module resolution only with the `--resolve` CLI flag, or by passing the source yourself via `{ modules }`. The package's source still has to be valid jz.

jz is for compiling *your* numeric/DSP/parser code, not for running the npm ecosystem.

</details>

<details>
<summary><strong>Can I use import/export?</strong></summary>

<br>

Yes. Standard `import`/`export` syntax is bundled at compile time into a single WASM — no runtime module resolution.

```js
const { exports } = jz(
  'import { add } from "./math.jz"; export let f = (a, b) => add(a, b)',
  { modules: { './math.jz': 'export let add = (a, b) => a + b' } }
)
```

Transitive imports work (main → math → utils → …); circular imports error at compile time. The **CLI** resolves filesystem imports automatically. In the **browser**, fetch sources yourself and pass them via `{ modules }` — the compiler stays synchronous and pure, no I/O.

</details>

<details>
<summary><strong>Can I call into the host (functions, objects)?</strong></summary>

<br>

Two kinds of import. `import … from './math.jz'` **bundles** another jz module at compile time (above). `import … from 'host'` with the `{ imports }` option **wires a runtime binding** — a JS function, constant, or whole namespace, e.g. `{ imports: { math: Math } }`. Numbers pass directly; strings, arrays, and objects cross via `memory.*`. See the **Host imports** fold under [Usage](#usage).

</details>

<details>
<summary><strong>How do I run produced .wasm?</strong></summary>

<br>
It's a standalone `.wasm` with no runtime dependency — compile once at build time and reuse the module (don't recompile jz source per request). Three ways to run it:

**In JS (browser / Node)** — instantiate with `jz/interop`, a ~15 KB-minified bridge (~6 KB gzipped; no compiler, parser, or watr) that marshals values across the boundary:

```js
import { instantiate } from 'jz/interop'
const { exports, memory } = instantiate(wasmBytes)   // bundler import or fetch()
exports.greet(memory.String('hello'))
```

**Standalone runtime** — compile with `host: 'wasi'` and run on any WASM engine:

```sh
jz program.js --host wasi -o program.wasm
wasmtime program.wasm     # or: wasmer run, deno run
```

**Raw host (no `jz/interop`)** — pure numeric modules need only `WebAssembly.Module`/`Instance`; numbers cross as plain f64. To marshal heap values yourself, the wasm signature *is* the ABI — `_alloc`/`_clear` exports plus NaN-boxed f64 pointers, documented in [`layout.js`](layout.js) with a worked example in [`test/abi.js`](test/abi.js). Pass `{ alloc: false }` to drop the allocator when you only call with numbers.

</details>

<details>
<summary><strong>How does memory work? How do I reset it?</strong></summary>

<br>

jz uses a **bump allocator**: every heap value (string, array, object, typed array) bumps a single pointer forward — no free list, no GC. The heap starts at byte 1024 and grows the WASM memory automatically when full.

Memory is never reclaimed implicitly — a long-running program that allocates per call grows without bound. Reset between independent batches:

```js
for (let i = 0; i < 1000; i++) {
  const sum = exports.process(100)   // allocates an array each call
  memory.reset()                     // drop everything; heap ptr → 1024
}
```

After `memory.reset()` all previously returned pointers are invalid — read what you need first, then reset. For finer control, `memory.alloc(bytes)` returns a raw offset on the same pointer. Pure scalar modules (no heap values) compile without the allocator at all.

</details>

<details>
<summary><strong>Can modules share memory?</strong></summary>

<br>

`jz.memory()` creates a shared memory that modules compile into. Schemas accumulate, so objects created in one module are readable by another:

```js
const memory = jz.memory()
const a = jz('export let make = () => { let o = {x: 10, y: 20}; return o }', { memory })
const b = jz('export let read = (o) => o.x + o.y', { memory })

b.exports.read(a.exports.make())  // 30 — same memory, merged schemas
memory.read(a.exports.make())     // {x: 10, y: 20}
```

Pass an existing `WebAssembly.Memory` to wrap it: `jz.memory(new WebAssembly.Memory({ initial: 4 }))`. Use `.instance.exports` for raw pointers, `.exports` for the JS-wrapped surface.

</details>

<details>
<summary><strong>Why no type annotations?</strong></summary>

<br>

Annotations would break the core promise: `let x: i32` isn't valid JS, so the file couldn't run, test, or debug as JS. jz infers types from signals you already write — literals (`0` vs `0.5`), operators (`|`/`<<` ⇒ i32), method calls, and how a value flows — pinning each to `i32`, `f64`, string, struct, or typed array where provable. Anything ambiguous stays a NaN-boxed f64: always correct, just not the fastest. So you write ordinary JS and get native types for free, and the same source still runs in any JS engine. `--wat` shows what was inferred; *Optimization hints* below covers how to nudge it.

</details>

<details>
<summary><strong>Optimization hints?</strong></summary>
<br>

jz infers types from source — literals, operators, method calls, assignment flow. Anything ambiguous falls back to NaN-boxed f64 (correct, but slower). The hints below help the compiler pick a faster representation.

**Integers ride on i32 where it's safe.** Bitwise ops (`|`, `&`, `<<`, `>>>`), `Math.imul`, loop counters, `charCodeAt`, and integer `const`/`let` compile to raw i32 — no NaN-box. Indexing a **typed array** (or known array) computes the offset in pure i32: `a[y * W + x]` needs no `x | 0` and does no widening. General `+ - * %` compute in **f64** — exact to 2⁵³, the same speed as i32, and JS-faithful (a product never silently wraps at 2³¹). Indexing an **untyped** value falls back to f64 offsets — pass a typed array in hot loops.

**Let the arena rewind.** A function proven not to leak heap values (no returned strings/arrays/objects) rewinds the bump pointer on return — no manual `memory.reset()` needed per call.
<!-- FIXME: give example -->

**Help SIMD fire.** The vectorizer lifts `for (let i = 0; i < N; i++) a[i] = f(a[i], …)` to SIMD-128 when the body is **lane-pure** — output `k` depends only on inputs at `k`.
<!-- FIXME: what is lane-pure? -->

- **Lifts:** in-place maps (`a[i] = a[i] * 2`), cross-array maps (`b[i] = a[i] * k + c`), structure-of-arrays (up to 4 bases), reductions (`s += a[i]`, `h ^= a[i]`).
<!-- FIXME: we need to elaborate sructure-of-arrays -->
- **Doesn't lift:** array-of-structures (interleaved `a[i*3]` — split into one typed array per field), loop-carried scalars (`s ^= s << 13`), stencils (`a[i-1]`), unbounded loops.
<!-- FIXME: we need to try array-of-structures optimization -->
<!-- FIXME: Where and what else vectorizing possible? -->

**Avoid string copies (JS host).** String params that only use `.length` and bounded `.charCodeAt(i)` in a loop qualify for the zero-copy `wasm:js-string` carrier — the JS string passes by reference, no allocation. Trigger it with a `.charCodeAt` use, a `s = ''` default, or call-site string evidence. On by default for `host: 'js'` (already JS-bound via `env.*`, so the carrier is free); opt out with `optimize: { jsstring: false }`. WASI builds always copy — the carrier needs a JS host, so wasi output stays portable to wasmtime/Go/Rust.
<!-- FIXME: what is copying? need example. And need to investigate if possible optimization -->

**Check the output.** `--wat` shows exactly what was emitted — which locals are i32, whether a `$__simd_loop` block appeared, and how tight the inner loop is.
<!-- FIXME: need to give size optimization hints as well -->
<!-- FIXME: need to improve size metrics to be on par with handwritten wasm -->

</details>

<details>
<summary><strong>What optimizations are applied?</strong></summary>

<br>

jz emits WAT directly, then layers these (all on by default at `optimize: 2`):

- **Escape analysis** — short-lived objects/arrays never reach the heap.
- **Arena rewind** — a function proven not to leak heap values rewinds the bump pointer on return.
- **Type narrowing** — bitwise / counter / `Math.imul` / `charCodeAt` values stay on raw i32/f64 instead of the boxed-value path.
- **Typed-array fusion** — monomorphic typed-array access skips index dispatch and reuses computed addresses across a hot loop.
- **SIMD vectorization** — lane-pure array loops lift to SIMD-128.
- **Constant loop unroll** — small fixed-count loops unroll (biquad, mat4).
- **JSON specialization** — a constant `JSON.parse` source folds to a literal tree; a stable shape gets a generated shape-specific parser.
- **Host-import lowering** — `host: 'js'` lowers `console` / timers / clocks to small `env.*` imports instead of bundling WASI.
<!-- FIXME: are these all optimizations? Can they be generalized/extended more? Any extra optimizations possible? -->
`--wat` shows the result. Size and speed budgets are gated in CI (`npm run test:bench`).

</details>
<!-- FIXME: we should cover size and its optimizations as well, and make a pass for shrinking produced WASM -->

<details>
<summary><strong>Can jz compile itself?</strong></summary>

<br>

Yes — the full test suite runs against the self-hosted compiler (`npm run test:selfhost`). jz compiles its own kernel (the inner compiler without the parser/optimizer) to WASM and runs the same tests through it. The kernel compiles correctly; the full toolchain is not yet self-hosted.
<!-- FIXME: what is kernel? We need to completely compile itself -->
</details>

<!-- FIXME: add question how does it work - short graph overview of the pipeline, hint/link into contributing, elaborate contributing -->


<details>
<summary><strong>Can I compile jz to C?</strong></summary>

<br>

Yes, via [wasm2c](https://github.com/WebAssembly/wabt/blob/main/wasm2c) or [w2c2](https://github.com/turbolent/w2c2):

```sh
jz program.js -o program.wasm
wasm-opt -O3 program.wasm -o program.opt.wasm
wasm2c program.opt.wasm -o program.c
cc -O3 program.c -o program
```

The full native pipeline (jz → `wasm-opt -O3` → `wasm2c` → `clang -O3 -flto` + PGO) lands within a few percent of hand-tuned C — beating V8 on 19 of 21 bench cases on an M4 Max. Details and the regression gate live in [`scripts/native/README.md`](scripts/native/README.md).

</details>

<details>
<summary><strong>Is jz production-ready?</strong></summary>

<br>

It's **experimental** (pre-1.0) — the supported subset and the wasm ABI may still change, so pin a version and re-test on upgrade. What's solid: every push runs the full test suite, the test262 conformance subset, the benchmark gate, and the self-host build in CI, so regressions surface immediately.

</details>


## Performance

<!-- FIXME: image should have less text, just a point what's compared - geomean -->
<img src="bench/bench.svg?v=0" alt="jz vs alternatives — geomean speed across the bench corpus" width="720">

<sup>[Full benchmark →](bench/README.md) — jz vs Node, AssemblyScript, Porffor, C, Rust, Go, Zig, hand-written WAT, and NumPy across 12 workloads.</sup>


## Examples

<table>
<tr>
<td width="50%"><a href="https://dy.github.io/jz/examples/game-of-life/"><img src="examples/thumbs/game-of-life.webp" width="100%" alt="Game of Life"></a><br><b>game-of-life</b> — Conway's Life written straight into shared pixel memory.</td>
<td width="50%"><a href="https://dy.github.io/jz/examples/interference/"><img src="examples/thumbs/interference.webp" width="100%" alt="Wave interference"></a><br><b>interference</b> — two-source wave field, recomputed every frame.</td>
</tr>
<tr>
<td><a href="https://dy.github.io/jz/examples/mandelbrot/"><img src="examples/thumbs/mandelbrot.webp" width="100%" alt="Mandelbrot set"></a><br><b>mandelbrot</b> — escape-time fractal with a precomputed color table.</td>
<td><a href="https://dy.github.io/jz/examples/rfft/"><img src="examples/thumbs/rfft.webp" width="100%" alt="Live spectrogram"></a><br><b>rfft</b> — live log/mel spectrogram from a jz real FFT, with floatbeat audio.</td>
</tr>
</table>


## Alternatives

<!-- FIXME: expected axis: size, speed, completeness, what ekse? -->
```mermaid
quadrantChart
    title JS → WASM landscape
    x-axis "subset" --> "full spec"
    y-axis "Bundled runtime / interpreter" --> "AOT → native, tiny output"
    quadrant-1 "The goal"
    quadrant-2 "AOT compiled"
    quadrant-3 ""
    quadrant-4 "Bundled runtime"
    AssemblyScript: [0.10, 0.75]
    jz: [0.30, 0.85]
    Porffor: [0.55, 0.50]
    jawsm: [0.80, 0.30]
    Javy: [0.90, 0.10]
```

* [**Porffor**](https://github.com/CanadaHonk/porffor) — ahead-of-time JS→WASM targeting full TC39. Implements the spec progressively (test262). Where jz restricts the language for performance, porffor aims for completeness.
* [**AssemblyScript**](https://github.com/AssemblyScript/assemblyscript) — TypeScript-like syntax → WASM. Small, performant output, requires type annotations.
* [**jawsm**](https://github.com/drogus/jawsm) — standard JS→WASM in Rust. Ships a runtime with GC and closures in WASM.
* [**Javy**](https://github.com/bytecodealliance/javy) — embeds QuickJS in the module and interprets your source. Runs almost any JS, but ships a full interpreter (large binary, interpreter speed) — the opposite trade from jz's AOT-compiled WASM for a JS subset.


## Build with

* [subscript](https://github.com/dy/subscript) — JS parser. Minimal, extensible, builds the exact AST jz needs. Jessie subset keeps the grammar small and deterministic.
* [watr](https://www.npmjs.com/package/watr) — WAT to WASM compiler. Binary encoding, validation, and peephole optimization. jz emits WAT text, watr turns it into valid `.wasm`.


<p align=center>MIT • <a href="https://github.com/krishnized/license/">ॐ</a></p>


<!--

The four visitor classes

 ### Skeptics

 "Oh great, another JS-to-WASM compiler"

 They've seen AssemblyScript, Porffor, Javy. They're looking for reasons to dismiss or take seriously.

 ┌──────────────────────────────────────┬─────────────────────────────────────────────────────────┐
 │ They ask                             │ They look for                                           │
 ├──────────────────────────────────────┼─────────────────────────────────────────────────────────┤
 │ Why not just AssemblyScript/Porffor? │ Honest comparison with trade-offs, not sales copy       │
 ├──────────────────────────────────────┼─────────────────────────────────────────────────────────┤
 │ What JS does it actually support?    │ Concrete subset, not "JS you already know"              │
 ├──────────────────────────────────────┼─────────────────────────────────────────────────────────┤
 │ Are the benchmarks real?             │ Reproducible numbers, CI gating, no cherry-picking      │
 ├──────────────────────────────────────┼─────────────────────────────────────────────────────────┤
 │ Where does it break?                 │ Divergence list — if it's hidden, they assume the worst │
 ├──────────────────────────────────────┼─────────────────────────────────────────────────────────┤
 │ Is this a toy or production?         │ Test262 badge, self-host, bench CI                      │
 └──────────────────────────────────────┴─────────────────────────────────────────────────────────┘

 They scroll straight to Alternatives and the divergence FAQ. If either smells like marketing, they
 leave.

 ### Curious explorers

 "Interesting — show me something"

 Came from a link, not evaluating anything. Want a 30-second "aha" then a path to go deeper.

 ┌───────────────────────────────┬───────────────────────────────────────────────────────┐
 │ They ask                      │ They look for                                         │
 ├───────────────────────────────┼───────────────────────────────────────────────────────┤
 │ What is this in one sentence? │ Tagline that names the thing, not the aspirations     │
 ├───────────────────────────────┼───────────────────────────────────────────────────────┤
 │ Show me it working            │ Opening code example — compile, call, done            │
 ├───────────────────────────────┼───────────────────────────────────────────────────────┤
 │ What's it good for?           │ Good-for / not-for table — tells them whether to care │
 ├───────────────────────────────┼───────────────────────────────────────────────────────┤
 │ Something visual              │ Examples grid — mandelbrot, spectrogram               │
 └───────────────────────────────┴───────────────────────────────────────────────────────┘

 They'll read the first 20 lines and either leave or open a fold. The Language diagram is their entry
 point.

 ### Pragmatists

 "Can I use this for my problem?"

 Have a real use case — DSP, parser, numeric kernel. Need concrete answers.

 ┌────────────────────────────────┬───────────────────────────────────────────────────────┐
 │ They ask                       │ They look for                                         │
 ├────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ Does it handle my case?        │ Good-for table + supported language list              │
 ├────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ How do I pass data in/out?     │ Passing data fold — numbers, arrays, strings, objects │
 ├────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ How do I deploy the output?    │ Deploy FAQ — .wasm in production, interop bundle      │
 ├────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ What's the DX? Error messages? │ Error example in Language section                     │
 ├────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ What doesn't work?             │ Divergence FAQ — upfront, not buried                  │
 ├────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ Can I test normally?           │ "Valid jz is valid JS" — use existing test runner     │
 ├────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ How do I debug?                │ --wat flag, mentioned in FAQ entries                  │
 ├────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ Can I split into files?        │ Import/export FAQ                                     │
 ├────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ What's the memory story?       │ Bump allocator FAQ — when to reset, how to share      │
 └────────────────────────────────┴───────────────────────────────────────────────────────┘

 They skip straight to Usage folds and FAQ. They need answers, not framing.

 ### Embedders

 "Can I ship this in my product?"

 Building a product that compiles or runs jz output. Care about weight, deps, stability.

 ┌───────────────────────────────────────────┬───────────────────────────────────────────────────────┐
 │ They ask                                  │ They look for                                         │
 ├───────────────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ How big is the runtime?                   │ Interop bundle size — jz/interop without compiler     │
 ├───────────────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ What's the compile speed?                 │ ~2–60 ms range — can I compile on the fly or must I   │
 │                                           │ AOT?                                                  │
 ├───────────────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ Can I ship just the .wasm?                │ Deploy FAQ — jz/interop is the thin bridge            │
 ├───────────────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ What are the runtime dependencies?        │ Dependency list — currently none beyond WASM          │
 ├───────────────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ Can I run it in a worker / service        │ No answer currently — gap                             │
 │ worker?                                   │                                                       │
 ├───────────────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ How stable is the output format?          │ No answer currently — gap                             │
 ├───────────────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ What's the license?                       │ MIT — bottom of page                                  │
 ├───────────────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ Memory ABI for non-JS hosts?              │ Deploy FAQ — the _alloc/_clear exports, header layout │
 └───────────────────────────────────────────┴───────────────────────────────────────────────────────┘

 They read Deploy and Options carefully. They're the ones who'd read layout.js.

 Is that all?

 I think there's one more worth naming, though they're a minority:

 ### Language / compiler people

 "How does it work internally?"

 They want to understand the approach, not use it. They read the source, not just the README.

 ┌──────────────────────────────────┬───────────────────────────────┐
 │ They ask                         │ They look for                 │
 ├──────────────────────────────────┼───────────────────────────────┤
 │ What's the compilation model?    │ No answer in README currently │
 ├──────────────────────────────────┼───────────────────────────────┤
 │ What optimizations are applied?  │ Optimization FAQ — adequate   │
 ├──────────────────────────────────┼───────────────────────────────┤
 │ What's the type inference story? │ Optimization hints FAQ        │
 ├──────────────────────────────────┼───────────────────────────────┤
 │ Can it self-host?                │ Self-host FAQ                 │
 └──────────────────────────────────┴───────────────────────────────┘

 These people will read src/ regardless. The README just needs to not lie about what's inside. A
 "Build with" section acknowledging the deps (subscript, watr) is enough for them.

 -->
