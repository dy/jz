<img src="jz.svg" alt="jz logo" width="120"/>

![stability](https://img.shields.io/badge/stability-experimental-black) [![npm](https://img.shields.io/npm/v/jz?color=black)](http://npmjs.org/package/jz) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml) [![bench](https://github.com/dy/jz/actions/workflows/bench.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/bench.yml)

**jz** (_javascript zero_) is **minimal functional JS** that compiles to WASM.


```js
import jz from 'jz'

const { exports: { dist } } = jz`export let dist = (x, y) => (x*x + y*y) ** 0.5`
dist(3, 4) // 5
```

<!-- FIXME: REPL, used by (color-space, web-audio-api) -->

## Why?

jz distills **"the good parts"** ([Crockford](https://www.youtube.com/watch?v=_DKkVvOt6dk)) and **compiles JS ahead-of-time to WASM**: no runtime, no GC, no legacy, no spec creep, near-native perf with unlocked SIMD. **Valid jz is valid JS** – run and test as JS, compile to portable WASM.


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
| `modules: { specifier: source }` | Static ES imports to bundle. CLI import resolution does this from files automatically. |
| `imports: { mod: host }` | Host imports `import { fn } from "mod"`. |
| `memory` | Pass `memory: N` for owned memory with `N` initial pages, or `memory: jz.memory()` / `WebAssembly.Memory` to share across modules. |
| `host: 'js' \| 'wasi'` | Runtime-service lowering. Default `js`; `wasi` for standalone runtimes. |
| `optimize` | `false`/`0` off, `1` size-only, `true`/`2` default (all stable passes), `3` trades size for speed. String aliases: `'size'`, `'balanced'` (= default), `'speed'`. Object form overrides individual passes. |
| `strict: true` | Enforce the pure canonical subset: skip jzify lowering (so `var`/`function`/`class`/`==`/… are rejected, not accepted) **and** reject dynamic fallbacks (`obj[k]`, `for-in`, unknown receiver methods). Off by default — broader JS is lowered automatically. |
| `alloc: false` | Omit allocator exports (`_alloc`/`_clear`) for standalone modules that never marshal heap values. |
| `randomSeed` | `Math.random` seeding — default draws from host entropy (non-reproducible); a number fixes it for a reproducible sequence, `true` forces entropy explicitly. |
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

jz is a **strict modern functional JS subset**. Built-in jzify transform extends support to legacy patterns.

```
┌────────────────────────────────────────────────────────────────────────┐
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ jz strict                                                          │ │
│ │   let/const  =>  ...xs  destructuring  import/export               │ │
│ │   if/else  for/while/do-while/of/in  break/continue                │ │
│ │   try/catch/finally  throw                                         │ │
│ │   operators  strings  booleans  numbers  arrays  objects  `${}`    │ │
│ │   Math  Number  String  Array  Object  JSON  RegExp  Symbol  null  │ │
│ │   ArrayBuffer  DataView  TypedArray  Map  Set                      │ │
│ │   parseInt  parseFloat  encodeURIComponent  Error  BigInt          │ │
│ │   console  setTimeout/setInterval  Date  performance               │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ jz default (jzify)                                                     │
│   var  function  arguments  switch  new Foo()                          │
│   class  new  this  extends  super  static  #private                   │
│   ==  !=  instanceof  undefined  WeakMap  WeakSet                      │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
Not supported
  async/await  Promise  function*  yield
  delete  getters/setters  eval  Function  with
  Proxy  Reflect
  import()  DOM  fetch  Intl  Node APIs
```

<details>
<summary><strong>Differences with JS</strong></summary>

- **Numbers are f64**; values proven integer (loop counters, anything `| 0`) use `i32` and **wrap at ±2³¹** like C's `int`. `BigInt` (`123n`) is i64 internally and returns to JS as a real, lossless `BigInt`.
- **`==` / `!=` don't coerce** — they behave exactly like `===` / `!==` (so `1 == "1"` is `false`); they're just the familiar spelling. The one genuinely useful loose form is kept: `x == null` matches both `null` and `undefined`. `strict` rejects `==`/`!=` — write `===`/`!==`.
- **Strings are UTF-8 bytes**, not UTF-16 — `.length`, indexing, `charCodeAt`, `slice`, `indexOf`, regex all count bytes (`"中".length` is `3`). ASCII matches JS; non-ASCII diverges. `toUpperCase`/`toLowerCase`/`trim` are **ASCII-only** — full Unicode case folding needs multi-KB tables jz omits by default, so non-ASCII letters and whitespace pass through unchanged.
- **Objects are fixed-shape** — the literal's keys are its layout. `Object.keys`/`for…in` enumerate the literal's keys plus any added by computed assignment (`o[k] = v`); a key added by literal name (`o.z = v`) may not enumerate, so prefer a `Map` for fully dynamic data. Classes are plain objects (no prototype chain), so `instanceof` is just an "is it an object" test.
- **Typed arrays are fixed-size views** — `arr.length = n` is a compile error, out-of-bounds reads give `0`, and writes past the end corrupt linear memory.
- **No GC** — memory isn't reclaimed; call `memory.reset()` between batches. `WeakMap`/`WeakSet` lower to `Map`/`Set` (`strict` rejects them).
- **Number → string isn't exact** — `String(n)`/`toString` keep ~9 significant digits and may not round-trip (`String(0.1 + 0.2)` → `"0.3"`); `toFixed` rounds ties-to-even, and f64 rounding can shift non-half inputs too (`(0.15).toFixed(1)` → `"0.2"`). Exact shortest-form output needs a Grisu/Ryū formatter jz doesn't ship.
- **Errors are untagged**, and some faults (`null.x`) don't throw, so `e instanceof TypeError` can't discriminate. A `boolean` stored in a container or behind `&&`/`||` crosses as `1`/`0` (it stays a real boolean through `typeof`/`String`/`JSON`/comparisons).
- **`Math.random` is seeded from host entropy** by default (non-reproducible) — pass `randomSeed: <number>` for a fixed, reproducible sequence. **`Date` getters return UTC** (`.getHours` ≡ `.getUTCHours`): there is no timezone database.
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

// Whole namespace — sin, cos, PI, … all auto-wired (functions as imports, numeric constants folded)
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
<summary><strong>Crossing the JS ↔ wasm boundary (numbers, strings, arrays, objects)</strong></summary>

**Numbers cross natively** as `f64`/`i32`. **Heap values** — strings, arrays, objects, typed arrays — cross as NaN-boxed `f64` pointers into linear memory, allocated through the module's `_alloc`/`_clear` exports. That pointer-plus-allocator convention *is* the whole ABI (a few hundred bytes, documented in [`layout.js`](layout.js) with a worked example in [`test/abi.js`](test/abi.js)). The one shortcut: arrays of ≤ 8 elements come back as plain JS arrays via WASM multi-value.

The `memory` codec — returned by `jz()` and by `jz/interop`'s `instantiate()` — handles both directions: it marshals arguments in, decodes pointer returns out, and turns a wasm `throw` into a real `Error`:

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

`memory.String` / `.Array` / `.Float64Array`/etc / `.Object` allocate on the heap and return a pointer; `memory.read(ptr)` decodes one back. `memory.Object()` is fixed-layout — its keys must match a compiled schema's key set (order is free, fields place by name).

**Where it runs** depends on the host:

- **Numbers only, raw `WebAssembly`** — no jz dependency at all: `(await WebAssembly.instantiate(wasmBytes)).instance.exports.dist(3, 4)`. Compile with `{ alloc: false }` to drop `_alloc`/`_clear` for pure-numeric modules.
- **Heap values, shipping just the `.wasm`** — `import { instantiate } from 'jz/interop'`. The bridge (~37 KB of source, ~6 KB gzipped once minified; no compiler or parser) builds the same `Module`+`Instance` you'd build by hand and wires the allocator and the `memory` codec above (plus WASI / `wasm:js-string` imports if the module uses them).
- **Standalone engine, `host: 'wasi'`** — `jz program.js --host wasi`, then `wasmtime program.wasm`. The module reaches the world through WASI (stdout, argv, clock), not a JS bridge; top-level code runs on load, exports take/return numbers. No host-side marshaler here — pass heap values by calling `_alloc` against the ABI, or run it from JavaScript instead.

Rust (`wasm-bindgen`), Go (TinyGo), C/Zig (Emscripten/WASI-libc) emit per-build generated glue and usually bundle a language runtime; jz keeps the ABI fixed and the optional bridge small (~6 KB gzipped, minified).

</details>

<details>
<summary><strong>Should I compile for `js` or `wasi`?</strong></summary>

- **`js`** (default) — it runs inside a JavaScript host (browser, Node, Deno, Bun). `jz()` and `jz/interop` wire the needed `env.*` services automatically (overridable via `opts.imports.env`), and you get full value marshaling across the boundary.
- **`wasi`** — it runs on a standalone WASM engine with no JavaScript (wasmtime, wasmer, deno run). jz emits WASI Preview 1, so the module needs no host shims — but there's no host-side marshaler, so heap values must be passed by hand (see *Crossing the JS ↔ wasm boundary* — or marshal against the ABI).

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
<summary><strong>How big is the output?</strong></summary>

No runtime, no GC — a module is your code plus a small bump allocator. The geomean across the bench corpus is on par with AssemblyScript and smaller than Porffor; most modules are single-digit kB — the [ZzFX synth](examples/zzfx) is ~10 kB, [mandelbrot](examples/mandelbrot) ~7 kB. Shrink it further:

- **`optimize: 'size'`** — keeps every size pass, drops loop unrolling and SIMD.
- **`alloc: false`** — omit the allocator for pure-numeric modules that never marshal heap values.
- **`host: 'wasi'`** — no JS-host import shims (the debug `name` section is already off unless you set `profile.names`).

Hand-written WAT is still ~3–8× smaller on tight kernels — jz carries generic allocator and stdlib helpers a specialist omits; closing that gap is ongoing. Size budgets are gated in CI alongside speed ([full table](bench/README.md)).

</details>


<details>
<summary><strong>Which optimizations are applied?</strong></summary>

Ordinary JS is already fast — jz infers the right machine type for your numbers, so you write plain JS. What it does, all on at the default `optimize: 2` (each line is also the habit that triggers it):

- **Type narrowing** — parameters/results pinned to `i32`/`f64`/bool/typed-array elements from their call sites, off the boxed path. A `Float64Array`/`Int32Array` is direct memory access; a plain `[]` works too, with a little more overhead.
- **Escape analysis & arena rewind** — fixed-shape arrays/objects/typed-arrays become WASM locals; scratch a function doesn't return is freed on exit (no manual cleanup).
- **Loops** — invariant hoisting, CSE, typed-array address reuse, induction-variable strength reduction, small fixed-count unrolling (mat4, biquad).
- **SIMD-128** — independent iterations (`a[i] = a[i]*2 + b[i]`) run several lanes at once: lane-pure maps, reductions (sum/product/min·max), conditional maps (`bitselect`), byte scans (`memchr` via `i8x16`). Loops that look back (`a[i-1]`) or carry a running total stay sequential.
- **Smaller encoding** — tree-shaking, copy-propagation + dead-store elimination, local/string-pool reordering for 1-byte indices, pointer-call specialization, constant pooling; JS strings you only read aren't copied.

Codegen also adapts to the target: `host: 'js'` lowers `console`/timers to tiny `env.*` imports, a constant `JSON.parse` folds to a literal, JS strings stay zero-copy. Levels `0`–`3` or `'size'`/`'balanced'`/`'speed'` (or a per-pass object): `'balanced'` (= `2`) is the default; `'speed'` trades size for inlined constants and larger buffers; `'size'` drops unrolling and SIMD.

</details>

<details>
<summary><strong>Is jz production-ready?</strong></summary>

It's **experimental** (pre-1.0) — the supported subset and the wasm ABI may still change, so pin a version and re-test on upgrade. What's solid: every push runs the full test suite, the test262 conformance subset, the benchmark gate, and the self-host build in CI, so regressions surface immediately.

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
<summary><strong>Can I compile in the browser or a Worker?</strong></summary>

Yes. The compiler is pure and synchronous (no I/O — you hand it the sources), so it runs anywhere JavaScript does — main thread, a Web Worker, or a build step — and compiling a kernel takes single-digit-to-tens of milliseconds, fast enough to do on the fly. The `.wasm` it produces is just a module: instantiate it in any WebAssembly host — browser main thread, Web/Service Worker, Node/Deno/Bun, or a standalone engine.

</details>


<details>
<summary><strong>Can jz compile itself?</strong></summary>

Yes — fully. jz compiles its own **entire** source to `dist/jz.wasm`: the whole pipeline (parse → jzify → prepare → compile → encode) runs inside WASM, taking a source string and returning wasm bytes with no host help. In other words, `dist/jz.wasm` is jz compiled by jz.

`npm run test:self` is the CI gate — it builds `dist/jz.wasm`, then round-trips real programs through the in-wasm compiler and runs their output, proving the wasm-hosted compiler produces working modules.

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

The full native pipeline (jz → `wasm-opt -O3` → `wasm2c` → `clang -O3 -flto` + PGO) lowers to standalone native code that beats V8 on the watr example corpus (19/21 wins, 2 ties, M4 Max). Details and the regression gate live in [`scripts/native/README.md`](scripts/native/README.md).

</details>




## Performance

Geomean speed across the [bench corpus](bench/README.md).

<img src="bench/bench.svg?v=2" alt="jz vs alternatives — geomean speed across the bench corpus" width="720">

<sub>Local snapshot (M4 Max, darwin/arm64). the Bun/Zig/Rust/Go/NumPy rows are hand-run reference points.</sub>


## Examples

One source, two backends — open any demo and flip the **js ⇄ jz** switch to compare. [**Browse the gallery →**](https://dy.github.io/jz/examples/)

<table>
<tr>
<td width="33%"><a href="https://dy.github.io/jz/examples/game-of-life/"><img src="examples/thumbs/game-of-life.webp" width="100%" alt="Game of Life"></a><br><b>game-of-life</b> — Conway's Life straight into shared pixel memory.</td>
<td width="33%"><a href="https://dy.github.io/jz/examples/lenia/"><img src="examples/thumbs/lenia.webp" width="100%" alt="Lenia"></a><br><b>lenia</b> — continuous cellular automaton; smooth-kernel "digital life".</td>
<td width="33%"><a href="https://dy.github.io/jz/examples/reaction-diffusion/"><img src="examples/thumbs/reaction-diffusion.webp" width="100%" alt="Reaction-diffusion"></a><br><b>reaction-diffusion</b> — Gray-Scott; organic coral / labyrinths.</td>
</tr>
<tr>
<td><a href="https://dy.github.io/jz/examples/interference/"><img src="examples/thumbs/interference.webp" width="100%" alt="Wave interference"></a><br><b>interference</b> — two-source wave field, recomputed every frame.</td>
<td><a href="https://dy.github.io/jz/examples/plasma/"><img src="examples/thumbs/plasma.webp" width="100%" alt="Plasma"></a><br><b>plasma</b> — FBM domain-warp; the classic flowing shader plasma.</td>
<td><a href="https://dy.github.io/jz/examples/chladni/"><img src="examples/thumbs/chladni.webp" width="100%" alt="Chladni plate"></a><br><b>chladni</b> — Camerata-style plate; frequency sweeps the nodal figure.</td>
</tr>
<tr>
<td><a href="https://dy.github.io/jz/examples/mandelbrot/"><img src="examples/thumbs/mandelbrot.webp" width="100%" alt="Mandelbrot set"></a><br><b>mandelbrot</b> — escape-time fractal with smooth coloring.</td>
<td><a href="https://dy.github.io/jz/examples/attractors/"><img src="examples/thumbs/attractors.webp" width="100%" alt="Strange attractor"></a><br><b>attractors</b> — de Jong map, millions of iters → luminous curves.</td>
<td><a href="https://dy.github.io/jz/examples/raymarcher/"><img src="examples/thumbs/raymarcher.webp" width="100%" alt="SDF raymarcher"></a><br><b>raymarcher</b> — an SDF sphere field; Shadertoy on the CPU.</td>
</tr>
<tr>
<td><a href="https://dy.github.io/jz/examples/rfft/"><img src="examples/thumbs/rfft.webp" width="100%" alt="Live spectrogram"></a><br><b>rfft</b> — live log/mel spectrogram from a jz real FFT.</td>
<td><a href="https://dy.github.io/jz/examples/zzfx/"><img src="examples/thumbs/zzfx.webp" width="100%" alt="ZzFX sound synth"></a><br><b>zzfx</b> — the unmodified <a href="https://github.com/KilledByAPixel/ZzFX">ZzFX</a> sfx synth, compiled as-is.</td>
<td><a href="https://dy.github.io/jz/examples/jukebox/"><img src="examples/thumbs/jukebox.webp" width="100%" alt="Floatbeat jukebox"></a><br><b>jukebox</b> — looping procedural-jazz arpeggio floatbeat; tap to play/pause.</td>
</tr>
</table>



## Alternatives

From small, fast JS subset to full JS spec, bundled engine:

* [AssemblyScript](https://github.com/AssemblyScript/assemblyscript) — TS-like dialect → WASM; small, fast output, but needs type annotations (not JS).
* [Porffor](https://github.com/CanadaHonk/porffor) — AOT JS→WASM (and C) targeting the full spec, grown against test262.
* [jawsm](https://github.com/drogus/jawsm) — JS→WASM in Rust on WasmGC; no interpreter, but leans on the engine's GC.
* [Javy](https://github.com/bytecodealliance/javy) — embeds QuickJS; runs almost any JS, but ships a full interpreter (large, interpreter-speed).
* [ComponentizeJS / jco](https://github.com/bytecodealliance/ComponentizeJS) — WASM Component via embedded SpiderMonkey; standards-complete, but bundles a JS engine.


## Built with

* [**subscript**](https://github.com/dy/subscript) — JS parser. Minimal, extensible, builds the exact AST jz needs. Jessie subset keeps the grammar small and deterministic.
* [**watr**](https://www.npmjs.com/package/watr) — WAT to WASM compiler. Binary encoding, validation, and peephole optimization. jz emits WAT text, watr turns it into valid `.wasm`.


<p align=center>MIT • <a href="https://github.com/krishnized/license/">ॐ</a></p>
