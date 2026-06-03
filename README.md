<img src="jz.svg" alt="jz logo" width="120"/>

## ![stability](https://img.shields.io/badge/stability-experimental-black) [![npm](https://img.shields.io/npm/v/jz?color=black)](http://npmjs.org/package/jz) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml) [![bench](https://github.com/dy/jz/actions/workflows/bench.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/bench.yml)

**JZ** (_javascript zero_) is **minimal functional JS** that compiles to WASM.


```js
import jz from 'jz'

const { exports: { dist } } = jz`export let dist = (x, y) => (x*x + y*y) ** 0.5`
dist(3, 4) // 5
```


## Why?

_"JavaScript isn't a real language"_ – unfit for hot computation (DSP, audio, parsers etc). JIT deopts, GC glitches,  locked SIMD, legacy ([wtfjs](https://github.com/denysdovhan/wtfjs)) and spec feature-creep. So compute-heavy code gets rewritten in Rust, Zig, Go or C and shipped as WASM.

JZ distills **"the good parts"** ([Crockford](https://www.youtube.com/watch?v=_DKkVvOt6dk)) and **compiles JS ahead-of-time to WASM** with inferred types. No legacy, no spec creep; no runtime, no GC, near-native speed. **Valid JZ is valid JS** – run and test as JS, compile to portable WASM.


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

JZ is a **strict modern functional JS subset**. Built-in jzify transform extends support to legacy patterns.

```
┌────────────────────────────────────────────────────────────────────────┐
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ JZ strict                                                          │ │
│ │   let/const  =>  ...xs  destructuring  import/export               │ │
│ │   if/else  for/while/do-while/of/in  break/continue                │ │
│ │   try/catch/finally  throw                                         │ │
│ │   operators  strings  booleans  numbers  arrays  objects  `${}`    │ │
│ │   Math  Number  String  Array  Object  JSON  RegExp  Symbol  null  │ │
│ │   ArrayBuffer  DataView  TypedArray  Map  Set  WeakMap  WeakSet    │ │
│ │   parseInt  parseFloat  encodeURIComponent  Error  BigInt          │ │
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

<details>
<summary><strong>Differences with JS</strong></summary>

- **Numbers are f64, but proven-integer values use 32-bit math.** `a + b` is numeric (`f64.add`) — concatenate by giving one side a string (`"" + x`). Where the compiler can *prove* a value only ever holds an integer (a loop counter, anything `| 0`), it keeps it in an `i32` for speed, which **wraps at ±2³¹** like C's `int`; a `0.0` initializer doesn't change the proof, so keep the math genuinely fractional when you need exact integers past 2³¹. Also: `==` does *not* coerce (`1 == "1"` is `false`); `0377` is decimal `377` (use `0o377`); `1n`/`BigInt` are i64 internally and reach JS as tiny floats, not BigInts.
- **Strings are UTF-8 bytes, not UTF-16 code units.** `.length`, `s[i]`, `charCodeAt`, `slice`, `indexOf`, and regex all index *bytes*: `"中".length` is `3`, `"😀".length` is `4`. ASCII matches JS exactly; non-ASCII diverges. `toUpperCase`/`toLowerCase`/`trim`/`localeCompare` handle ASCII only.
- **Objects have a fixed shape.** The set of keys and their order are fixed by the object literal as written in source — that's the *shape* the compiler lays out. You can read and write a *new* key (`o.k = v`), but `Object.keys`/`for…in`/spread/`Object.assign` only enumerate the literal's keys; `delete o.x`, getters/setters, and `arr.length = n` are rejected at compile. Classes are plain objects with per-instance methods (no prototype chain), so `x instanceof SomeClass` is really just an "is it an object" test. Typed-array reads past the end return `0` (not `undefined`); writes past the end corrupt linear memory.
- **Number → string keeps ~9 significant digits.** A compact integer-based formatter (no Grisu/Ryū) auto-selects up to 9 digits: `String(1/3)` → `"0.333333333"`, and `String(0.1 + 0.2)` → `"0.3"` (the float artifact is hidden). `toFixed`/`toPrecision` round with the hardware `f64.nearest` instruction (ties-to-even) rather than emulating ECMAScript's round-half-away-from-zero, so `(2.5).toFixed(0)` → `"2"` where V8 gives `"3"`.
- **No GC, thin values.** Memory isn't reclaimed — call `memory.reset()` between batches. `WeakMap`/`WeakSet` are plain `Map`/`Set`, and both keep insertion order like JS. Errors are untagged: `throw` carries a bare value and many built-in faults (e.g. `null.x`) don't throw at all, so `e instanceof TypeError` can't discriminate. A `boolean` reaches the host as a real boolean through `typeof`/`String`/`JSON.stringify`/comparisons, but as an operand of `&&`/`||` or stored in a container it crosses as `1`/`0`.
- **A few built-ins differ.** Regex matches UTF-8 bytes (per the string model above); `Math.random()` is deterministic unless compiled with `randomSeed`; `Date` getters report UTC (no local timezone).

jz trades completeness for low-level numeric performance by design; for full TC39 conformance, see [alternatives](#alternatives).

</details>


## FAQ

<details>
<summary><strong>Can I use existing npm packages or JS libraries?</strong></summary>

Only the ones that fit the jz subset. There's no runtime, so packages touching the DOM, `async`/`Promise`, the network, or Node APIs won't compile — but pure numeric/algorithmic source does.

- **Relative imports** (`./dep.js`) bundle at compile time.
- **Bare specifiers** (`import { x } from "pkg"`) resolve through Node module resolution only with the `--resolve` CLI flag, or by passing the source yourself via `{ modules }`. The package's source still has to be valid jz.

jz is for compiling *your* numeric/DSP/parser code, not for running the npm ecosystem.

</details>

<details>
<summary><strong>Can I use import/export?</strong></summary>

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

Compiled `.wasm` is standalone with no runtime dependency. How you run it depends on **where** (JavaScript host vs standalone engine) and **what you pass** (plain numbers vs heap values like strings/arrays/objects).

**1. From JavaScript, numbers only — raw `WebAssembly`.** No jz dependency at all; numbers cross natively as `f64`/`i32`:

```js
const { instance } = await WebAssembly.instantiate(wasmBytes)
instance.exports.dist(3, 4)   // 5
```

Compile with `{ alloc: false }` to drop the `_alloc`/`_clear` exports when a module only ever takes and returns numbers or multi-value arrays.

**2. From JavaScript, with strings/arrays/objects — `jz/interop`.** Heap values cross as NaN-boxed pointers into linear memory, so they need a codec. `jz/interop` is a ~15 KB bridge (~6 KB gzipped; no compiler or parser) that provides one:

```js
import { instantiate } from 'jz/interop'
const { exports, memory } = instantiate(wasmBytes)   // bundler import or fetch()
exports.greet(memory.String('hello'))
```

- `instantiate(wasmBytes)` builds the same `WebAssembly.Module` + `Instance` you'd build by hand, then wraps them: it wires the bump allocator (and the WASI / `wasm:js-string` imports if the module uses them), marshals string/array/object **arguments** into heap pointers, decodes pointer **return values** back to JS, and turns a wasm `throw` into a real JS `Error`.
- `memory` enhances the instance's `WebAssembly.Memory` with `.String` / `.Array` / `.Object` / `.read` / `.write` so you can build and read heap values explicitly.
- You need either of these **only** for heap values — pure-numeric calls work straight off raw `WebAssembly` (method 1).

**3. Standalone engine — `host: 'wasi'`.** For runtimes with no JavaScript host (wasmtime, wasmer etc):

```sh
jz program.js --host wasi -o program.wasm
wasmtime program.wasm        # runs the module's top-level code (its start section)
```

The module reaches the outside world through WASI (stdout, stdin, argv, clock), not a JS bridge. Top-level code runs on load; exported functions take and return numbers (invoke them with your engine's `--invoke`). There's no host-side marshaler in this mode — to pass a string/array/object you'd call the exported `_alloc` and write the bytes yourself (see ABI below). If you need rich values across the boundary, run it from JavaScript (method 2) instead.

**Marshaling by hand (any host).** Skip `jz/interop` entirely: the wasm signature *is* the ABI — `_alloc`/`_clear` exports plus NaN-boxed `f64` pointers, documented in [`layout.js`](layout.js) with a worked example in [`test/abi.js`](test/abi.js).

</details>

<details>
<summary><strong>How do I pass strings, arrays, and objects?</strong></summary>

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

`memory.String`, `.Array`, `.Float64Array`/etc, and `.Object` all allocate on the WASM heap and return a pointer. `memory.read(ptr)` decodes a pointer back to a JS value. `memory.Object()` creates a fixed-layout object — its keys must match a compiled schema's key set; order is free (fields are placed by name).

The whole contract is a NaN-boxed `f64` pointer plus `_alloc`/`_clear` — a few hundred bytes of convention you can implement against by hand. Rust (`wasm-bindgen`), Go (TinyGo), C/Zig (Emscripten/WASI-libc) instead emit per-build generated glue and usually bundle a language runtime; jz keeps the ABI fixed and the optional bridge (`jz/interop`) under ~15 KB.

</details>

<details>
<summary><strong>Should I compile for `js` or `wasi`?</strong></summary>

- **`js`** (default) — it runs inside a JavaScript host (browser, Node, Deno, Bun). `jz()` and `jz/interop` wire the needed `env.*` services automatically (overridable via `opts.imports.env`), and you get full value marshaling across the boundary.
- **`wasi`** — it runs on a standalone WASM engine with no JavaScript (wasmtime, wasmer, deno run). jz emits WASI Preview 1, so the module needs no host shims — but there's no host-side marshaler, so heap values must be passed by hand (see *How do I pass strings, arrays, and objects?* — or marshal against the ABI).

Either way the `.wasm` carries at most one import namespace (none, `env`, or `wasi_snapshot_preview1`). The difference is only in how a few runtime services are serviced:

| What your code does | `js` (default) | `wasi` |
|---|---|---|
| `console.log()` | `env.print` — host stringifies | WASI `fd_write` |
| `Date.now()` / `performance.now()` | `env.now` → f64 | WASI `clock_time_get` |
| `setTimeout` / `setInterval` | `env.setTimeout` — host schedules | WASM timer queue + `__timer_tick` |
| dynamic `obj.method()` | `env.__ext_call` (JS resolves) | error at compile time |

</details>

<details>
<summary><strong>How does memory work?</strong></summary>

jz uses a **bump allocator**: every heap value (string, array, object, typed array) bumps a single pointer forward — no free list, no GC. The heap starts at byte 1024 — the first 1 KB holds static data (string/array literals laid out from offset 0, plus the bump pointer itself at byte 1020 when memory is shared across threads). It grows the WASM memory automatically when full, and if the literals overflow that 1 KB the heap simply starts past them.
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

`jz.memory()` creates a shared memory that modules compile into. Schemas accumulate, so objects created in one module are readable by another:

```js
const memory = jz.memory()
const a = jz('export let make = () => { let o = {x: 10, y: 20}; return o }', { memory })
const b = jz('export let read = (o) => o.x + o.y', { memory })

b.exports.read(a.exports.make())  // 30 — same memory, merged schemas
memory.read(a.exports.make())     // {x: 10, y: 20}
```

Pass an existing `WebAssembly.Memory` to wrap it: `jz.memory(new WebAssembly.Memory({ initial: 4 }))`.

Each compiled module exposes two call surfaces:

- **`.exports`** — the JS-wrapped surface: it marshals JS arguments into the heap and decodes pointer return values back to JS values (and turns a wasm `throw` into an `Error`). Use it by default — it's also how you hand a value from one module to another, as in the example above (the value is re-marshaled through the shared memory).
- **`.instance.exports`** — the raw `WebAssembly.Instance` exports: numbers pass through untouched, and a pointer return comes back as a raw NaN-boxed handle. Decode it on the host with `memory.read(ptr)`. Don't pass a raw pointer back *in* as an argument, though — the JS↔wasm `f64` boundary canonicalizes its NaN payload and the pointer is lost; let `.exports` marshal across instead.

</details>

<details>
<summary><strong>Why no type annotations?</strong></summary>

Because `let x: i32` isn't valid JS — annotations would break the promise that valid jz runs and tests as plain JS. So jz reads the types from signals you already write:

```js
export let bits = (a, b) => a | b   // i32 — a bitwise op pins both operands
export let half = (n) => n * 0.5    // f64 — 0.5 isn't an integer
```

Literals (`0` vs `0.5`), operators (`|` `<<` `&` ⇒ i32), and how a value is used pin it to `i32`, `f64`, string, object, or typed array. Anything still ambiguous stays **dynamic** — always correct, just type-checked at runtime (a little slower).

</details>

<details>
<summary><strong>Can jz compile itself?</strong></summary>

Yes — fully. jz compiles its own **entire** source to `dist/jz.wasm`: the whole pipeline (parse → jzify → prepare → compile → encode) runs inside WASM, taking a source string and returning wasm bytes with no host help. In other words, `dist/jz.wasm` is jz compiled by jz.

`npm run test:self` is the CI gate — it builds `dist/jz.wasm`, then round-trips real programs through the in-wasm compiler and runs their output, proving the wasm-hosted compiler produces working modules.

</details>

<details>
<summary><strong>How does jz work?</strong></summary>

A source string flows through six stages into wasm bytes — no IR leaves the process, the whole thing is one pass per `compile()`:

```
 your .js
   │ parse      jessie parser (subscript) → AST
   │ jzify      lower legacy JS to the canonical subset (var/function/class/==/…)
   │ prepare    resolve & bundle imports, normalize the AST
   │ compile    type inference (i32 vs f64) + emit WAT IR; module/ handlers lower operators
   │ optimize   WAT-level passes — CSE, DCE, const-fold, inline, peephole
   │ encode     watr: WAT → WASM binary
   ▼
 .wasm
```

Each stage lives in its own place: parsing in [`subscript`](https://github.com/dy/subscript)'s jessie grammar, [`jzify/`](jzify/) for the legacy-JS lowering, [`src/prepare/`](src/prepare/) for module bundling, [`src/compile/`](src/compile/) for inference + codegen (with built-ins in [`module/`](module/) and heap layout in [`src/abi/`](src/abi/)), [`src/optimize/`](src/optimize/) + [`src/wat/`](src/wat/) for the WAT passes, and [`watr`](https://github.com/dy/watr) for the final encode. Shared compile state is one `ctx` object ([`src/ctx.js`](src/ctx.js)).

</details>


<details>
<summary><strong>Can I compile jz to C?</strong></summary>

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
<summary><strong>How big is the output?</strong></summary>

No runtime, no GC — a module is your code plus a small bump allocator. The geomean across the bench corpus is on par with AssemblyScript and smaller than Porffor; most modules are single-digit kB — the [ZzFX synth](examples/zzfx) is ~10 kB, [mandelbrot](examples/mandelbrot) ~6 kB. Shrink it further:

- **`optimize: 'size'`** — keeps every size pass, drops loop unrolling and SIMD.
- **`alloc: false`** — omit the allocator for pure-numeric modules that never marshal heap values.
- **`host: 'wasi'`** — no JS-host import shims (the debug `name` section is already off unless you set `profile.names`).

Hand-written WAT is still ~3–8× smaller on tight kernels — jz carries generic allocator and stdlib helpers a specialist omits; closing that gap is ongoing. Size budgets are gated in CI alongside speed ([full table](bench/README.md)).

</details>

<details>
<summary><strong>Is jz production-ready?</strong></summary>

It's **experimental** (pre-1.0) — the supported subset and the wasm ABI may still change, so pin a version and re-test on upgrade. What's solid: every push runs the full test suite, the test262 conformance subset, the benchmark gate, and the self-host build in CI, so regressions surface immediately.

</details>

<details>
<summary><strong>Can I compile in the browser or a Worker?</strong></summary>

Yes. The compiler is pure and synchronous (no I/O — you hand it the sources), so it runs anywhere JavaScript does — main thread, a Web Worker, or a build step — and compiling a kernel takes single-digit-to-tens of milliseconds, fast enough to do on the fly. The `.wasm` it produces is just a module: instantiate it in any WebAssembly host — browser main thread, Web/Service Worker, Node/Deno/Bun, or a standalone engine.

</details>


## Performance

Speed vs jz — geomean across the bench corpus. [Full benchmark →](bench/README.md).

<img src="bench/bench.svg?v=1" alt="jz vs alternatives — geomean speed across the bench corpus" width="720">

<details>
<summary><strong>Optimizations</strong></summary>

Ordinary JS is already fast — jz infers the right machine type for your numbers, so you write plain JS. What it does, all on at the default `optimize: 2` (each line is also the habit that triggers it):

- **Type narrowing** — parameters/results pinned to `i32`/`f64`/bool/typed-array elements from their call sites, off the boxed path. A `Float64Array`/`Int32Array` is direct memory access; a plain `[]` works too, with a little more overhead.
- **Escape analysis & arena rewind** — fixed-shape arrays/objects/typed-arrays become WASM locals; scratch a function doesn't return is freed on exit (no manual cleanup).
- **Loops** — invariant hoisting, CSE, typed-array address reuse, induction-variable strength reduction, small fixed-count unrolling (mat4, biquad).
- **SIMD-128** — independent iterations (`a[i] = a[i]*2 + b[i]`) run several lanes at once: lane-pure maps, reductions (sum/product/min·max), conditional maps (`bitselect`), byte scans (`memchr` via `i8x16`). Loops that look back (`a[i-1]`) or carry a running total stay sequential.
- **Smaller encoding** — tree-shaking, copy-propagation + dead-store elimination, local/string-pool reordering for 1-byte indices, pointer-call specialization, constant pooling; JS strings you only read aren't copied.

Codegen also adapts to the target: `host: 'js'` lowers `console`/timers to tiny `env.*` imports, a constant `JSON.parse` folds to a literal, JS strings stay zero-copy. Levels `0`–`3` or `'size'`/`'balanced'`/`'speed'` (or a per-pass object): `'balanced'` (= `2`) is the default; `'speed'` trades size for inlined constants and larger buffers; `'size'` drops unrolling and SIMD.

</details>


## Examples

<table>
<tr>
<td width="33%"><a href="https://dy.github.io/jz/examples/game-of-life/"><img src="examples/thumbs/game-of-life.webp" width="100%" alt="Game of Life"></a><br><b>game-of-life</b> — Conway's Life straight into shared pixel memory.</td>
<td width="33%"><a href="https://dy.github.io/jz/examples/lenia/"><img src="examples/thumbs/lenia.webp" width="100%" alt="Lenia"></a><br><b>lenia</b> — continuous cellular automaton; smooth-kernel "digital life".</td>
<td width="33%"><a href="https://dy.github.io/jz/examples/reaction-diffusion/"><img src="examples/thumbs/reaction-diffusion.webp" width="100%" alt="Reaction-diffusion"></a><br><b>reaction-diffusion</b> — Gray-Scott; organic coral / labyrinths.</td>
</tr>
<tr>
<td><a href="https://dy.github.io/jz/examples/interference/"><img src="examples/thumbs/interference.webp" width="100%" alt="Wave interference"></a><br><b>interference</b> — two-source wave field, recomputed every frame.</td>
<td><a href="https://dy.github.io/jz/examples/plasma/"><img src="examples/thumbs/plasma.webp" width="100%" alt="Plasma"></a><br><b>plasma</b> — FBM domain-warp; the classic flowing shader plasma.</td>
<td><a href="https://dy.github.io/jz/examples/cymatics/"><img src="examples/thumbs/cymatics.webp" width="100%" alt="Cymatics"></a><br><b>cymatics</b> — a Chladni plate whose nodal lines dance to a live floatbeat.</td>
</tr>
<tr>
<td><a href="https://dy.github.io/jz/examples/mandelbrot/"><img src="examples/thumbs/mandelbrot.webp" width="100%" alt="Mandelbrot set"></a><br><b>mandelbrot</b> — escape-time fractal with smooth coloring.</td>
<td><a href="https://dy.github.io/jz/examples/attractors/"><img src="examples/thumbs/attractors.webp" width="100%" alt="Strange attractor"></a><br><b>attractors</b> — de Jong map, millions of iters → luminous curves.</td>
<td><a href="https://dy.github.io/jz/examples/raymarcher/"><img src="examples/thumbs/raymarcher.webp" width="100%" alt="SDF raymarcher"></a><br><b>raymarcher</b> — an SDF sphere field; Shadertoy on the CPU.</td>
</tr>
<tr>
<td><a href="https://dy.github.io/jz/examples/rfft/"><img src="examples/thumbs/rfft.webp" width="100%" alt="Live spectrogram"></a><br><b>rfft</b> — live log/mel spectrogram from a jz real FFT.</td>
<td><a href="https://dy.github.io/jz/examples/zzfx/"><img src="examples/thumbs/zzfx.webp" width="100%" alt="ZzFX sound synth"></a><br><b>zzfx</b> — the unmodified <a href="https://github.com/KilledByAPixel/ZzFX">ZzFX</a> sfx synth, compiled as-is.</td>
<td><a href="https://dy.github.io/jz/examples/jukebox/"><img src="examples/thumbs/jukebox.webp" width="100%" alt="Floatbeat jukebox"></a><br><b>jukebox</b> — endless procedural-jazz floatbeat; tap to shuffle.</td>
</tr>
</table>



## Alternatives

<img src="alternatives.svg?v=3" alt="JS → WASM landscape — from tiny, fast AOT subsets (jz, AssemblyScript) to full-spec bundled engines (Javy, ComponentizeJS)" width="720">

* [AssemblyScript](https://github.com/AssemblyScript/assemblyscript) — TS-like dialect → WASM; small, fast output, but needs type annotations (not JS).
* [Porffor](https://github.com/CanadaHonk/porffor) — AOT JS→WASM (and C) targeting the full spec, grown against test262.
* [jawsm](https://github.com/drogus/jawsm) — JS→WASM in Rust on WasmGC; no interpreter, but leans on the engine's GC.
* [Javy](https://github.com/bytecodealliance/javy) — embeds QuickJS; runs almost any JS, but ships a full interpreter (large, interpreter-speed).
* [ComponentizeJS / jco](https://github.com/bytecodealliance/ComponentizeJS) — WASM Component via embedded SpiderMonkey; standards-complete, but bundles a JS engine.


## Built with

* [**subscript**](https://github.com/dy/subscript) — JS parser. Minimal, extensible, builds the exact AST jz needs. Jessie subset keeps the grammar small and deterministic.
* [**watr**](https://www.npmjs.com/package/watr) — WAT to WASM compiler. Binary encoding, validation, and peephole optimization. jz emits WAT text, watr turns it into valid `.wasm`.


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
 │ Can I run it in a worker / service        │ "Compile in the browser or a Worker?" FAQ             │
 │ worker?                                   │                                                       │
 ├───────────────────────────────────────────┼───────────────────────────────────────────────────────┤
 │ How stable is the output format?          │ "Is jz production-ready?" FAQ — pre-1.0, pin a version │
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
