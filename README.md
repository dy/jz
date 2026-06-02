<img src="jz.svg" alt="jz logo" width="120"/>

## ![stability](https://img.shields.io/badge/stability-experimental-black) [![npm](https://img.shields.io/npm/v/jz?color=black)](http://npmjs.org/package/jz) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml) [![test262](https://github.com/dy/jz/actions/workflows/test262.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test262.yml) [![bench](https://github.com/dy/jz/actions/workflows/bench.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/bench.yml)

**JZ** (_javascript zero_) is **minimal functional JS** that compiles to WASM.


```js
import jz from 'jz'

const { exports: { dist } } = jz`export let dist = (x, y) => (x*x + y*y) ** 0.5`
dist(3, 4) // 5
```


## Why?

_"JavaScript isn't a real language"_ – unfit for hot computation (DSP, audio, parsers etc). JIT deopts, GC glitches, floats-only math, hashmap objects, locked SIMD, legacy, [quirks](https://github.com/denysdovhan/wtfjs) and spec feature-creep. So compute-heavy code gets rewritten in Rust, Go or C and shipped as WASM.

JZ distills **"the good parts"** ([Crockford](https://www.youtube.com/watch?v=_DKkVvOt6dk)) and **compiles JS ahead-of-time to WASM**. No legacy, no spec creep; no runtime, no GC, near-native speed. **Valid JZ is valid JS** – run and test as JS, compile to portable WASM.<br><br>


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

JZ is a **strict functional JS subset**. Built-in jzify transform extends support to legacy patterns.

```
┌────────────────────────────────────────────────────────────────────────┐
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ JZ strict                                                          │ │
│ │   let/const  =>  ...xs  destructuring  import/export               │ │
│ │   if/else  for/while/do-while/of/in  break/continue                │ │
│ │   try/catch/finally  throw                                         │ │
│ │   operators  strings  booleans  numbers  arrays  objects  `${}`    │ │
│ │   Math  Number  String  Array  Object  JSON  RegExp  Symbol  null  │ │
│ │   ArrayBuffer  DataView  TypedArray  Map  Set                      │ │
│ │   console  setTimeout/setInterval  Date  performance               │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ JZ default (jzify)                                                     │
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

jz compiles to static WASM — some behaviors diverge from V8.

- **Static numeric types.** `(a, b) => a + b` infers `f64.add` — numeric, not concatenation (give one side a string literal or `= ''` seed to concatenate). Values proven to fit `i32` wrap at ±2³¹ (asm.js `ToInt32`); keep a value f64 for exact integers beyond that.
- **Fixed-layout objects.** Key set and order are fixed at the literal; `delete` is rejected; `memory.Object({…})` must match source order.
<!-- FIXME: should memory.Object match source order indeed? Why? isn't schema supposed to cover that? -->
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
  'import { add } from "./math.js"; export let f = (a, b) => add(a, b)',
  { modules: { './math.js': 'export let add = (a, b) => a + b' } }
)
```

Transitive imports work (main → math → utils → …); circular imports error at compile time. The **CLI** resolves filesystem imports automatically. In the **browser**, fetch sources yourself and pass them via `{ modules }` — the compiler stays synchronous and pure, no I/O.

</details>

<details>
<summary><strong>Can I call into the host (functions, objects)?</strong></summary>

<br>

Yes. `import … from 'host'` with the `{ imports }` option **wires a runtime binding** — a JS function, constant, or whole namespace. Numbers pass directly; strings, arrays, and objects cross via `memory.*`.

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
<summary><strong>Can I interpolate values (template literals)?</strong></summary>

<br>

`jz` is a tagged template — interpolated values are baked into the source at compile time. Numbers and booleans inline directly; strings, arrays, and objects compile as jz literals:

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
<summary><strong>How do I run produced .wasm?</strong></summary>

<!-- FIXME: this answer need more clear elaborating and made more comprehensive. Each method needs details -->
<br>
It's a standalone `.wasm` with no runtime dependency — compile once at build time and reuse the module (don't recompile jz source per request). Three ways to run it:

**In JS (browser / Node)** — instantiate with `jz/interop`, a ~15 KB-minified bridge (~6 KB gzipped; no compiler, parser, or watr) that marshals values across the boundary:

```js
import { instantiate } from 'jz/interop'
const { exports, memory } = instantiate(wasmBytes)   // bundler import or fetch()
exports.greet(memory.String('hello'))
```
<!-- FIXME: how instantiate is different from normal instantiate - answer; how memory is different? do we need them at all, why cant we just do direct WebAssembly - we can, can't we? Mention that wrapping is needed for heap values only -->

**Standalone runtime** — compile with `host: 'wasi'` and run on any WASM engine:

```sh
jz program.js --host wasi -o program.wasm
wasmtime program.wasm     # or: wasmer run, deno run
```
<!-- FIXME: how does user pass pointer values? -->

**Raw host (no `jz/interop`)** — pure numeric modules need only `WebAssembly.Module`/`Instance`; numbers cross as plain f64. To marshal heap values yourself, the wasm signature *is* the ABI — `_alloc`/`_clear` exports plus NaN-boxed f64 pointers, documented in [`layout.js`](layout.js) with a worked example in [`test/abi.js`](test/abi.js). Pass `{ alloc: false }` to drop the allocator when you only call with numbers.
<!-- FIXME: likely this is second method, not the last one -->

</details>

<details>
<summary><strong>What does it import from the host (`js` vs `wasi`)?</strong></summary>

<!-- FIXME: strange question, person doesn't ask this - it points at implementation detail. What would be normal question? Host target? -->
<br>

`host: 'js'` (default) imports a few `env.*` services that `jz()` and `jz/interop` wire to the JS host automatically — overridable via `opts.imports.env`.<br>
`host: 'wasi'` emits WASI Preview 1 for wasmtime/wasmer/deno — no JS host needed.<br>
The compiled `.wasm` carries at most one import namespace (none, `env`, or `wasi_snapshot_preview1`).

| JS API | `host: 'js'` (default) | `host: 'wasi'` |
|---|---|---|
| `console.log()` | `env.print` — host stringifies | WASI `fd_write` |
| `Date.now()` / `performance.now()` | `env.now` → f64 | WASI `clock_time_get` |
| `setTimeout` / `setInterval` | `env.setTimeout` — host schedules | WASM timer queue + `__timer_tick` |
| dynamic `obj.method()` | `env.__ext_call` (JS resolves) | error at compile time |

</details>

<details>
<summary><strong>How do I pass strings, arrays, and objects?</strong></summary>
<!-- FIXME: I feel like this goes after produced .wasm, not after js vs wasi, is it? -->
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
<summary><strong>How does memory work?</strong></summary>

<br>

jz uses a **bump allocator**: every heap value (string, array, object, typed array) bumps a single pointer forward — no free list, no GC. The heap starts at byte 1024 and grows the WASM memory automatically when full.
<!-- FIXME: what are 1024 bytes used for? -->
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

Pass an existing `WebAssembly.Memory` to wrap it: `jz.memory(new WebAssembly.Memory({ initial: 4 }))`.<br>
Use `.instance.exports` for raw pointers, `.exports` for the JS-wrapped surface. <!-- FIXME: elaborate -->

</details>

<details>
<summary><strong>Why no type annotations?</strong></summary>

<br>

Because `let x: i32` isn't valid JS — annotations would break the promise that valid jz runs and tests as plain JS. So jz reads the types from signals you already write:

```js
export let bits = (a, b) => a | b   // i32 — a bitwise op pins both operands
export let half = (n) => n * 0.5    // f64 — 0.5 isn't an integer
```

Literals (`0` vs `0.5`), operators (`|` `<<` `&` ⇒ i32), and how a value is used pin it to `i32`, `f64`, string, object, or typed array. Anything still ambiguous stays a **NaN-boxed f64** — always correct, but each use carries a runtime type check. That dispatch is the only cost; f64 math itself is as fast as i32. See [Writing fast jz](#performance) to keep values off the dynamic path.

</details>

<details>
<summary><strong>Can jz compile itself?</strong></summary>

<br>
<!-- FIXME: call it just test:self -->
Yes — the full test suite runs against the self-hosted compiler (`npm run test:selfhost`). jz compiles its own kernel (the inner compiler without the parser/optimizer) to WASM and runs the same tests through it. The kernel compiles correctly; the full toolchain is not yet self-hosted.
<!-- FIXME: we removed kernel long ago -->
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

The full native pipeline (jz → `wasm-opt -O3` → `wasm2c` → `clang -O3 -flto` + PGO) lands within a few percent of hand-tuned C. Details and the regression gate live in [`scripts/native/README.md`](scripts/native/README.md).

</details>

<details>
<summary><strong>Is jz production-ready?</strong></summary>

<br>

It's **experimental** (pre-1.0) — the supported subset and the wasm ABI may still change, so pin a version and re-test on upgrade. What's solid: every push runs the full test suite, the test262 conformance subset, the benchmark gate, and the self-host build in CI, so regressions surface immediately.

</details>

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
<tr>
<td colspan="2"><a href="https://dy.github.io/jz/examples/zzfx/"><img src="examples/thumbs/zzfx.webp" width="100%" alt="ZzFX sound synth"></a><br><b>zzfx</b> — the unmodified <a href="https://github.com/KilledByAPixel/ZzFX">ZzFX</a> sound-effect synth, compiled as-is and synthesized ~2× faster than V8.</td>
</tr>
</table>


## Performance

<img src="bench/bench.svg?v=1" alt="jz vs alternatives — geomean speed across the bench corpus" width="720">

<sup>Speed vs jz — geomean across the bench corpus. [Full benchmark →](bench/README.md).</sup>

<details>
<summary><strong>Writing fast jz</strong></summary>

<br>

jz infers types from your code; a few habits keep it on the fast path instead of the safe dynamic one:

- **Typed arrays in hot loops.** Indexing a `Float64Array`/`Int32Array` is a direct load at an i32 offset (`a[y * W + x]` needs no `| 0`); a plain array falls back to runtime dispatch.
- **Keep integers integer.** Bitwise ops, `Math.imul`, loop counters and `charCodeAt` ride on raw i32. Plain `+ - * %` run in f64 — exact to 2⁵³ and as fast as i32 — so most math needs no thought.
- **Lane-pure loops vectorize.** `for (i…) a[i] = f(a[i], b[i])`, where output `i` reads only inputs at `i`, lifts to SIMD-128. Cross-lane work (`a[i-1]`, `s ^= s << 13`) stays scalar.
- **Let the arena rewind.** A function that returns no heap value (string/array/object) frees its allocations on return — no `memory.reset()` needed.
- **Zero-copy strings.** Params that only read `.length`/`.charCodeAt(i)` cross the JS boundary by reference (default for `host: 'js'`).

`--wat` shows the result — i32 locals and a `$__simd_loop` block mean it worked.

</details>

<details>
<summary><strong>What optimizations applied</strong></summary>

<br>

jz emits WAT and optimizes it across an AST pass and a WAT-IR pass — all on at the default `optimize: 2`. The headline transforms:

- **Type narrowing** — a whole-program pass pins parameters and results to `i32`/`f64`/bool/typed-array elements from their call sites, off the boxed path.
- **Escape analysis** — fixed-size arrays, objects and typed arrays with static access become WASM locals instead of heap allocations.
- **Arena rewind** — a function proven not to leak a heap value restores the bump pointer on return.
- **Loops & expressions** — invariant hoisting, common-subexpression elimination, typed-array address reuse, and small fixed-count unrolling (mat4, biquad).
- **SIMD** — lane-pure array loops lift to SIMD-128.
- **Smaller encoding** — tree-shaking, dead-store elimination, local and string-pool reordering for 1-byte indices, pointer-call specialization, constant pooling.

Codegen also adapts to the target: `host: 'js'` lowers `console`/timers to tiny `env.*` imports, a constant `JSON.parse` folds to a literal, and JS strings stay zero-copy. Levels: `0`–`3`, or `'size'`/`'balanced'`/`'speed'`, or a per-pass object — `'balanced'` (= `2`) is the default; `'speed'` trades a little size for speed (inlines constants, larger buffers); `'size'` drops unrolling and SIMD.

</details>

<details>
<summary><strong>Output size</strong></summary>

<br>

No runtime, no GC — a module is your code plus a small bump allocator. The geomean across the bench corpus is on par with AssemblyScript and **~25× smaller than Porffor** (which bundles a JS engine); most modules are single-digit kB — the [ZzFX synth](examples/zzfx) is ~10 kB, [mandelbrot](examples/mandelbrot) ~6 kB. Shrink it further:

- **`optimize: 'size'`** — keeps every size pass, drops loop unrolling and SIMD.
- **`alloc: false`** — omit the allocator for pure-numeric modules that never marshal heap values.
- **`host: 'wasi'`** — no JS-host import shims (the debug `name` section is already off unless you set `profile.names`).

Hand-written WAT is still ~3–8× smaller on tight kernels — jz carries generic allocator and stdlib helpers a specialist omits; closing that gap is ongoing. Size budgets are gated in CI alongside speed ([full table](bench/README.md)).

</details>



## Alternatives

<img src="alternatives.svg?v=2" alt="JS → WASM landscape — from tiny, fast AOT subsets (jz, AssemblyScript) to full-spec bundled engines (Javy, ComponentizeJS)" width="720">

* [**AssemblyScript**](https://github.com/AssemblyScript/assemblyscript) — TypeScript-like dialect → WASM. Small, fast output, but requires type annotations — not JavaScript.
* [**Porffor**](https://github.com/CanadaHonk/porffor) — ahead-of-time JS→WASM (and C) targeting the full spec, implemented progressively against test262.
* [**jawsm**](https://github.com/drogus/jawsm) — JS→WASM in Rust; a standalone binary on WasmGC and exception handling — no interpreter, but leans on the engine's GC.
* [**Javy**](https://github.com/bytecodealliance/javy) — interprets your source via an embedded QuickJS. Runs almost any JS, but ships a full interpreter — large binary, interpreter speed.
* [**ComponentizeJS / jco**](https://github.com/bytecodealliance/ComponentizeJS) — emits a WASM Component via an embedded SpiderMonkey (StarlingMonkey). Standards-compliant and near-complete, but bundles a whole JS engine.


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
