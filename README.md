<a href="https://dy.github.io/jz/"><img src="jz.svg" alt="JZ logo" width="120"/></a>

![stability](https://img.shields.io/badge/stability-experimental-black) [![npm](https://img.shields.io/npm/v/jz?color=black)](http://npmjs.org/package/jz) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml) [![bench](https://github.com/dy/jz/actions/workflows/bench.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/bench.yml)

**JZ** (_javascript zero_) is **minimal functional JS** that compiles to performant WASM.

```js
import jz from 'jz'

const { exports: { dist } } = jz`export let dist = (x, y) => (x*x + y*y) ** 0.5`
dist(3, 4) // 5
```

**[site](https://dy.github.io/jz/)** · **[repl](https://dy.github.io/jz/repl/)**<!-- · **[floatbeat](https://dy.github.io/jz/floatbeat/)**--> · **[examples](https://dy.github.io/jz/examples/)** · **[bench](https://dy.github.io/jz/bench/)**


## Why?

JZ distills **"the good parts"** ([Crockford](https://www.youtube.com/watch?v=_DKkVvOt6dk)) and **compiles JS ahead-of-time to WASM**: no runtime, no GC, no legacy, no spec creep, near-native perf with unlocked SIMD. **Valid JZ is valid JS** – run and test as JS, compile to WASM.

| Good for                     | Not for                   |
|------------------------------|---------------------------|
| DSP, audio, synthesis        | UI, DOM, the frontend     |
| Image, video, pixels         | Servers, APIs, I/O        |
| Simulation, physics, games   | Async, promises, events   |
| Parsers, codecs, compression | Dynamic, polymorphic, OOP |
| Scientific, numeric, ML      | Security crypto, big-ints |
| Hashing, checksums, RNG      | Glue, plumbing, orchestration |

Output `.wasm` is portable — run it in any host (browser, Node, Deno, edge, plugins), or take it native via [wasm2c](https://github.com/WebAssembly/wabt) (wasm → C → binary).


## Usage

`npm install jz`

```js
import jz, { compile, compileModule, instantiate } from 'jz'

// Compile + instantiate
const { exports: { add } } = jz('export let add = (a, b) => a + b')
add(2, 3)  // 5

// Compile only — raw WASM binary
const wasm = compile('export let f = (x) => x * 2')

// Compile once → instantiate many (pays the AOT + validate cost once)
const mod = compileModule('export let f = (x) => x * 2')
instantiate(mod).exports.f(21)  // 42 — repeat cheaply, no recompile

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
| `memory` | Pass `memory: N` for owned memory with `N` initial pages, or `memory: jz.memory()` / `WebAssembly.Memory` to share across modules. `maxMemory: N` caps growth; `importMemory: true` imports `env.memory` instead of exporting own. |
| `host: 'js' \| 'wasi'` | Runtime-service lowering. Default `js`; `wasi` for standalone runtimes. |
| `optimize` | `false`/`0` off, `1` minimal, `true`/`2` default (all stable passes), `3`/`'speed'` trades size for speed, `'size'` for smallest wasm. (Object form for per-pass overrides is internal/unstable.) |
| `define` | Compile-time constants injected as top-level bindings, e.g. `{ DEBUG: false, PORT: 8080 }` (numbers, booleans, strings, null, or literal arrays/objects). |
| `strict: true` | Enforce the pure canonical subset: skip jzify lowering (so `var`/`function`/`class`/`==`/… are rejected, not accepted) **and** reject dynamic fallbacks (`obj[k]`, `for-in`, unknown receiver methods). Off by default — broader JS is lowered automatically. |
| `alloc: false` | Omit allocator exports (`_alloc`/`_clear`) for standalone modules that never marshal heap values. |
| `noSimd: true` | Disable auto-vectorization (no jz-emitted `v128`) for engines without the SIMD proposal. Explicit `f32x4`/`i32x4` intrinsics still compile. |
| `whyNotSimd: true` | Diagnostic (CLI `--why-not-simd`): emit a `simd-why-not` warning per loop the auto-vectorizer declined, naming the first blocking op — finds loops one op away from SIMD. Noisy; off by default. Surfaced via the `warnings` sink. |
| `experimentalStencil: true` | Opt-in (CLI `--experimental-stencil`): vectorize neighbour-load stencils — `b[i] = f(a[i-1], a[i], a[i+1])` and 2-D 5-point sweeps — to f64x2. Bit-exact vs scalar (a lane-parallel map reorders nothing within a lane). Unstable / off by default until proven across the corpus. |
| `experimentalOuterStrip: true` | Opt-in (CLI `--experimental-outer-strip`): strip-mine a pixel loop whose per-pixel value is an inner reduction (e.g. metaballs' field sum over blobs) into f64x2 — two adjacent pixels per step. Bit-exact vs scalar (each lane accumulates in scalar order). Unstable / off by default. |
| `randomSeed` | `Math.random` seeding — default draws from host entropy (non-reproducible); a number fixes it for a reproducible sequence, `true` forces entropy explicitly. |
| `wat: true` | `compile()` returns WAT text instead of WASM binary. |
| `names: true` | Emit a WASM `name` section (function symbols) for profilers/debuggers. |
| `profile` | Mutable sink for compile-stage timings (`entries`/`totals` per phase). |
</details>

## CLI

`npm install -g jz`

```sh
jz program.js              # → program.wasm
jz program.js --wat        # → program.wat
jz program.js -o out.wasm  # custom output (- for stdout)
jz program.js -O3          # optimization: -O0 off, -O1 minimal, -O2 default, -O3 speed (-Os for size)
jz program.js --host wasi  # standalone WASI output
jz --strict program.js     # pure canonical subset (also implied by .jz extension)
jz -e "1 + 2"              # eval → 3
```

<details>
<summary><code>jz --help</code></summary>

```
jz - min JS → WASM compiler

Usage:
  jz <file.js>              Compile JS to WASM (full JS subset; .jz = strict)
  jz --strict <file.js>     Strict mode — pure canonical subset, no lowering
  jz --jzify <file.js>      Transform JS → jz source (auto-derives output file)
  jz -e <expression>        Evaluate expression
  jz --help                 Show this help

Examples:
  jz program.js                    # → program.wasm
  jz program.js --wat              # → program.wat
  jz program.js -o out.wasm        # custom output name
  jz program.js -o -               # write to stdout
  jz program.js -O3                # optimize for speed
  jz program.js -Os                # optimize for size
  jz program.js -D DEBUG=false     # inject a compile-time constant
  jz program.js --memory 64        # 64 initial pages (4 MB)
  jz program.js --host wasi        # emit WASI Preview 1 imports
  jz --strict program.js           # strict mode
  jz --jzify lib.js                # → lib.jz
  jz -e "1 + 2"

Options:
  --output, -o <file>       Output file (.wat, .wasm, or - for stdout)
  -O<n>, --optimize <n>     Optimization level: 0 off, 1 minimal, 2 default (all
                            stable passes), 3 speed. -Os optimizes for size.
  --define, -D <K=V>        Inject a compile-time constant (VALUE parsed as JSON,
                            else string). Repeatable.
  --host <js|wasi>          Runtime-service lowering (default js)
  --memory <pages>          Initial memory size in 64 KiB pages
  --max-memory <pages>      Cap memory growth at this many pages (default unbounded)
  --import-memory           Import env.memory instead of exporting own memory
  --no-alloc                Omit _alloc/_clear allocator exports (standalone wasm)
  --no-simd                 Disable auto-vectorization (no v128) for non-SIMD engines
  --why-not-simd            Report, per loop, why the auto-vectorizer declined it
  --experimental-stencil    Vectorize neighbour-load stencils (a[i±1]); opt-in
  --experimental-outer-strip  Strip-mine pixel loops over an inner reduction to f64x2; opt-in
  --no-tail-call            Use ordinary call frames instead of return_call
  --names                   Emit wasm name section for profilers/debuggers
  --stats                   Print compile-phase timings to stderr
  --strict                  Pure canonical subset: reject full-JS syntax + dynamic fallbacks
  --jzify                   Transform JS to jz source (no compilation)
  --eval, -e                Evaluate expression or file
  --wat                     Output WAT text instead of binary
  --resolve                 Resolve bare specifiers via Node.js module resolution
  --imports <file>          JSON file with host import specs (e.g. {"env":{"fn":{"params":2}}})
  --version, -v             Show version number
```
</details>


## Language

JZ is a **strict modern JS subset**. Built-in jzify transform extends support to legacy patterns.

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


## FAQ

<details>
<summary><strong>What are the differences with JS?</strong></summary>

Each follows one rule: **JZ takes WASM/native conventions over JS edge-cases when it's free and the f64 value-precision of real computation is preserved** ([rationale](CONTRIBUTING.md#principles)).

- **Numbers are f64**; integer-proven values (loop counters, array idx, `| 0`) are `i32` and **wrap at ±2³¹**.
- **Strings are UTF-8 bytes** — `.length`, `charCodeAt`, indexing, `slice`, `indexOf`, regex count bytes (`"中".length` is `3`); `toUpperCase`/`toLowerCase`/`trim` are ASCII-only. UTF-8 skips UTF-16's 2× and a multi-KB Unicode case table.
- **Objects are fixed-shape structs** — literal keys sit in fixed slots; computed writes (`o[k] = v`) fall back to a per-object hash and enumerate normally, but a dot-key added after the literal (`o.b = 2`) stays readable without enumerating (`Object.keys`/`for…in`). Prefer `Map` for heavy dynamic keys.
- **Array indices are integers, typed-array access is unchecked** — an index coerces to `i32` (asm.js-style), so a fractional or `NaN` index *truncates* (`a[1.5]`→`a[1]`, `a[NaN]`→`a[0]`) rather than yielding JS's `undefined`. A `Float64Array`/etc. is fixed-size (`arr.length = n` won't compile) and read **raw**: an out-of-bounds or negative index reads arbitrary linear memory (a large one traps), not `undefined` — pass valid in-bounds integers. Plain `[]` arrays *are* bounds-checked (`undefined` past the end / for a negative index).
- **No GC** — call `memory.reset()` between batches; `WeakMap`/`WeakSet` wired to `Map`/`Set`.
- **Pseudo-classical constructors** — `function P(x) { this.x = x }` + `P.prototype.m = function () {…}` fold into the class lowering automatically (the pre-`class` npm idiom); arrow-valued members keep lexical `this` and stay out.
- **Generators (sync) + iterator helpers** — `function*`/`yield` compile to regenerator-style state machines (no stack suspension): `next(v)`/`return(v)` are ordinary closure calls, `for-of` over a generator call desugars to a plain loop, and ES2025 helper chains (`g().map(f).filter(p).take(n)`, terminals `toArray`/`reduce`/`some`/`every`/`find`/`forEach`) fuse into ONE loop — no intermediate iterator objects. `yield*` delegates (sent values thread, completion value returned) and `[...g()]` spreads via the fused path. v1 scope: no `try` across yield — rejects with a precise message.
- **Workers v1 (shared-memory SPMD)** — `sharedMemory: true` compiles against a shared `WebAssembly.Memory` (atomic heap bump, wasm `shared` memtype); `Atomics.*` on Int32Array lowers to wasm thread ops (`wait`/`notify` included); `jz.pool(src, {threads})` runs the same kernel across node worker_threads over one memory — annotate shared-array params as `(arr = new Int32Array(0))`. v1 contract: shared typed arrays + scalars; strings/objects stay thread-local.
- **`String(number)` is ES-spec exact** — shortest round-trip digits via a built-in Ryū formatter (`String(0.1 + 0.2)` → `"0.30000000000000004"`, `String(Math.PI)` → `"3.141592653589793"`), including exponential notation and subnormals; its ~9.7 KB power-of-5 table is lazily included only in modules that stringify floats.
- **Errors are just their message** — a caught error is the value you threw (no `.message`, not `instanceof Error`), and `null.x` yields `undefined` instead of throwing. It keeps `throw` and member reads free of object machinery and per-access checks.
- **`Date` getters return UTC** (`getHours` ≡ `getUTCHours`) – the IANA timezone database is hundreds of KB.
- **`Math.random` is seedable** — default draws host entropy; pass `randomSeed: n` for a reproducible stream.
</details>

<details>
<summary><strong>What will JZ never support — and why?</strong></summary>

Everything else is compiled, lowered by the built-in jzify pass, or rejected with a clean error — silent divergence is treated as a bug. These stay out **by design**; each is traded for a zero-cost guarantee:

- **Proxy, Reflect** — traps have no meaning over fixed-shape structs with compile-time-resolved offsets.
- **Property descriptors & accessors** — `defineProperty` descriptors, getters/setters, `writable`/`enumerable`: objects carry values only, no per-property metadata — that's what makes a property read one load.
- **Live prototype chains** — `__proto__`, delegation, monkey-patching: `Object.create(proto)` is a documented shallow copy; method dispatch is static.
- **`delete` on literal-key properties** — an object's shape is fixed at construction (computed-key/dictionary-mode `delete o[k]` works).
- **eval, `Function` constructor, `with`** — would require the compiler (or an interpreter) at runtime; JZ ships neither.
- **async/await, Promise** — compiled modules have no event loop; asynchrony belongs to the host (callbacks and `setTimeout` cross the boundary today).
- **Intl, Temporal** — ICU/CLDR and timezone tables are hundreds of KB to MB, against single-digit-kB output. `Date` keeps deterministic UTC slices.
- **UTF-16 string semantics & Unicode tables** — strings are UTF-8 bytes; `\p{…}` classes, `normalize` forms and locale case tables are the same multi-KB cost Intl was refused for.
- **Arbitrary-precision BigInt** — BigInt is a raw 64-bit integer (wraps past ±2⁶³); bignum chains allocate unboundedly, and security crypto is explicitly out of scope.
- **WeakRef, FinalizationRegistry** — no GC to observe; `WeakMap`/`WeakSet` fold to `Map`/`Set`.
- **Annex B legacies, DOM, fetch, Node APIs** — the parts of JS the subset exists to shed; I/O stays host-side.

The litmus for this list: the feature either needs a runtime JZ refuses to ship, or per-access metadata that would tax every program — including the ones not using it.
</details>


<details>
<summary><strong>Can I use existing npm packages or JS libraries?</strong></summary>

Only the ones that fit the JZ subset. There's no runtime, so packages touching the DOM, `async`/`Promise`, the network, or Node APIs won't compile — but pure numeric/algorithmic source does.

- **Relative imports** (`./dep.js`) bundle at compile time.
- **Bare specifiers** (`import { x } from "pkg"`) resolve through Node module resolution only with the `--resolve` CLI flag, or by passing the source yourself via `{ modules }`. The package's source still has to be valid JZ.

JZ is for compiling *your* numeric/DSP/parser code, not for running the npm ecosystem.

</details>

<details>
<summary><strong>Can I use import/export?</strong></summary>

Standard `import`/`export` syntax is bundled at compile time into a single WASM — no runtime module resolution.

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

`import … from 'host'` with the `{ imports }` option **wires a runtime binding** — a JS function, constant, or whole namespace. Numbers pass directly; strings, arrays, and objects cross via `memory.*`.

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

`jz` is a tagged template — interpolated values are baked into the source at compile time. Numbers and booleans inline directly; strings, arrays, and objects compile as JZ literals:

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
<summary><strong>How to pass numbers, strings, arrays, objects JS ↔ WASM?</strong></summary>

**Numbers cross natively** as `f64`/`i32`. **Heap values** — strings, arrays, objects, typed arrays — plus the `null`/`undefined`/boolean atoms cross as the **i64 NaN-box carrier** (a `BigInt` on the JS side) holding a tagged pointer into linear memory, allocated through the module's `_alloc`/`_clear` exports. i64 rather than f64 so the NaN payload survives JSC/Safari, which canonicalizes f64 NaN bits at the boundary; numbers stay f64 (free). That carrier-plus-allocator convention *is* the whole ABI (a few hundred bytes, documented in [`layout.js`](layout.js) with a worked example in [`test/abi.js`](test/abi.js)); a per-export [`jz:i64exp`](interop.js) custom section maps which params/results ride i64, and the signature itself is self-describing for non-JS hosts. The one shortcut: arrays of ≤ 8 numeric elements come back as plain JS arrays via WASM multi-value.

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

</details>

<details>
<summary><strong>Do I need JZ at runtime?</strong></summary>

The compiler runs at build time. At runtime you ship the `.wasm` and, at most, a small bridge — never the compiler, the parser, or a language runtime.

- **Pure-number modules — nothing but the `.wasm`.** Instantiate with raw `WebAssembly`, zero JZ dependency: `(await WebAssembly.instantiate(wasmBytes)).instance.exports.dist(3, 4)`. Compile with `{ alloc: false }` to drop the `_alloc`/`_clear` exports too.
- **Heap values (strings, arrays, objects) — the `.wasm` plus `jz/interop`.** `import { instantiate } from 'jz/interop'` adds a ~6 KB-gzipped bridge (no compiler, no parser) that builds the same `Module`+`Instance` you'd build by hand and wires the allocator and the `memory` codec from the previous question (plus WASI / `wasm:js-string` imports if the module uses them).
- **No JavaScript host at all** — compile with `host: 'wasi'`; see the next question.

For contrast, Rust (`wasm-bindgen`), Go (TinyGo), and C/Zig (Emscripten/WASI-libc) emit per-build generated glue and usually bundle a language runtime. JZ keeps the ABI fixed and the optional bridge ~6 KB gzipped.

</details>

<details>
<summary><strong>Can I run the `.wasm` without a JavaScript host (WASI)?</strong></summary>

There's two possible `host` targets:

- **`js`** (default) — runs inside a JavaScript host (browser, Node, Deno, Bun). `jz()` and `jz/interop` wire the needed `env.*` services automatically (overridable via `opts.imports.env`), and you get full value marshaling across the boundary.
- **`wasi`** — runs on a standalone WASM engine with no JavaScript (wasmtime, wasmer, deno run). JZ emits WASI Preview 1, so the module needs no host shims — but there's no host-side marshaler, so heap values must be passed by hand.

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

JZ uses a **bump allocator**: every heap value (string, array, object, typed array) bumps a single pointer forward — no free list, no GC. The heap starts at byte 1024 — the first 1 KB holds static data (string/array literals laid out from offset 0, plus the bump pointer itself at byte 1020 when memory is shared across threads). It grows the WASM memory automatically when full, and if the literals overflow that 1 KB the heap simply starts past them.
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
- **`.instance.exports`** — the raw `WebAssembly.Instance` exports: numbers pass through untouched, and a boxed return (string/array/object/atom) comes back as its raw i64 carrier (a `BigInt`). Decode it on the host with `memory.read(ptr)`, and pass it straight back *in* as an argument — the i64 carrier preserves the NaN payload across the boundary on every engine (including JSC/Safari), so no value is lost.

</details>

<details>
<summary><strong>How big is the output?</strong></summary>

No runtime, no GC — a module is your code plus a small bump allocator. The geomean across the bench corpus is on par with AssemblyScript and smaller than Porffor; most modules are single-digit kB — the [ZzFX synth](examples/zzfx) is ~10 kB, [mandelbrot](examples/mandelbrot) ~7 kB. Shrink it further:

- **`optimize: 'size'`** — keeps every size pass, drops loop unrolling and SIMD.
- **`alloc: false`** — omit the allocator for pure-numeric modules that never marshal heap values.
- **`host: 'wasi'`** — no JS-host import shims (the debug `name` section is already off unless you set `names: true`).

Hand-written WAT is still ~3–8× smaller on tight kernels — JZ carries generic allocator and stdlib helpers a specialist omits; closing that gap is ongoing. Size budgets are gated in CI alongside speed ([full table](bench/README.md)).

</details>


<details>
<summary><strong>Which optimizations are applied?</strong></summary>

Ordinary JS is already fast — JZ infers the right machine type for your numbers, so you write plain JS. What it does, all on at the default `optimize: 2` (each line is also the habit that triggers it):

- **Type narrowing** — parameters/results pinned to `i32`/`f64`/bool/typed-array elements from their call sites, off the boxed path. A `Float64Array`/`Int32Array` is direct memory access; a plain `[]` works too, with a little more overhead.
- **Escape analysis & arena rewind** — fixed-shape arrays/objects/typed-arrays become WASM locals; scratch a function doesn't return is freed on exit (no manual cleanup).
- **Loops** — invariant hoisting, CSE, typed-array address reuse, induction-variable strength reduction, small fixed-count unrolling (mat4, biquad).
- **SIMD-128** — independent iterations (`a[i] = a[i]*2 + b[i]`) run several lanes at once: lane-pure maps, reductions (sum/product/min·max), conditional maps (`bitselect`), byte scans (`memchr` via `i8x16`). Loops that look back (`a[i-1]`) or carry a running total stay sequential.
- **Smaller encoding** — tree-shaking, copy-propagation + dead-store elimination, local/string-pool reordering for 1-byte indices, pointer-call specialization, constant pooling; JS strings you only read aren't copied.

Codegen also adapts to the target: `host: 'js'` lowers `console`/timers to tiny `env.*` imports, a constant `JSON.parse` folds to a literal, JS strings stay zero-copy. Levels `0`–`3` (default `2`), or the named presets `'speed'` (= `3`, trades size for inlined constants and larger buffers) and `'size'` (drops unrolling and SIMD for the smallest wasm).

</details>

<details>
<summary><strong>How do I inspect or debug the output?</strong></summary>

- **Semantics** — valid JZ is valid JS: run the same source under Node and diff results (mind the [documented divergences](#faq)); `console.log` works inside compiled modules too.
- **Codegen** — `jz program.js --wat` (API: `compile(src, { wat: true })`) shows the emitted WAT: grep `v128` to confirm a loop vectorized, `__dyn_get`/`__ext_call` to spot dynamic fallbacks inference couldn't narrow. `--why-not-simd` (API: `whyNotSimd: true`) goes further — for each loop the auto-vectorizer declined it reports the first blocking op (e.g. `i32.rem_s: no lane-pure SIMD mapping`), so you don't have to grep the WAT to find what's one op away.
- **Dynamic fallbacks** — compile with `strict: true` to turn every fallback (`obj[k]`, `for-in`, unknown receiver method) into a compile error pointing at the site.
- **Profiling** — `--names` (API: `names: true`) emits a wasm `name` section so DevTools profilers and disassemblers show real function names; `--stats` (API: the `profile` sink) collects per-stage compile timings.
- **Slow kernel checklist** — a stray float literal pins a counter to f64; a plain `[]` where a typed array would do; a loop-carried dependency (`a[i-1]`, running sum) blocks SIMD. The signals in *Why no type annotations?* below are the levers.

</details>

<details>
<summary><strong>How does JZ work?</strong></summary>

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
<summary><strong>Why no type annotations?</strong></summary>

Because `let x: i32` isn't valid JS — annotations would break the promise that valid JZ runs and tests as plain JS. So JZ reads the types from signals you already write:

```js
export let bits = (a, b) => a | b   // i32 — a bitwise op pins both operands
export let half = (n) => n * 0.5    // f64 — 0.5 isn't an integer
```

Literals (`0` vs `0.5`), operators (`|` `<<` `&` ⇒ i32), and how a value is used pin it to `i32`, `f64`, string, object, or typed array. Anything still ambiguous stays **dynamic** — always correct, just type-checked at runtime (a little slower).

</details>


<details>
<summary><strong>Is JZ production-ready?</strong></summary>

It's **experimental** (pre-1.0) — the supported subset and the wasm ABI may still change, so pin a version and re-test on upgrade. What's solid: every push runs the full test suite, the test262 conformance subset, the benchmark gate, and the self-host build in CI, so regressions surface immediately.

</details>


<details>
<summary><strong>Can I compile in the browser or a Worker?</strong></summary>

Yes. The compiler is pure and synchronous (no I/O — you hand it the sources), so it runs anywhere JavaScript does — main thread, a Web Worker, or a build step — and compiling a kernel takes single-digit-to-tens of milliseconds, fast enough to do on the fly. The `.wasm` it produces is just a module: instantiate it in any WebAssembly host — browser main thread, Web/Service Worker, Node/Deno/Bun, or a standalone engine.

Because compiling is that cheap, WASM becomes a *live medium*, not just a build artifact: hot-swap a compute kernel without a reload, recompile user-supplied source on the fly, or treat compiling as part of scripting — not a deploy step.

</details>


<details>
<summary><strong>Can JZ compile itself?</strong></summary>

Yes — fully. JZ compiles its own **entire** source to `dist/jz.wasm`: the whole pipeline (parse → jzify → prepare → compile → encode) runs inside WASM, taking a source string and returning wasm bytes with no host help. In other words, `dist/jz.wasm` is JZ compiled by JZ.

`npm run test:self` is the CI gate — it builds `dist/jz.wasm`, then round-trips real programs through the in-wasm compiler and runs their output, proving the wasm-hosted compiler produces working modules.

</details>


<details>
<summary><strong>Can I compile JZ to C?</strong></summary>

Yes, via [wasm2c](https://github.com/WebAssembly/wabt/blob/main/wasm2c) or [w2c2](https://github.com/turbolent/w2c2):

```sh
jz program.js -o program.wasm
wasm-opt -O3 program.wasm -o program.opt.wasm
wasm2c program.opt.wasm -o program.c
cc -O3 program.c -o program
```

The full native pipeline (JZ → `wasm-opt -O3` → `wasm2c` → `clang -O3 -flto` + PGO) lowers to standalone native code that beats V8 on the watr example corpus (19/21 wins, 2 ties, M4 Max). Details and the regression gate live in [`scripts/native/README.md`](scripts/native/README.md).

[Static Hermes](https://github.com/facebook/hermes) reaches native the same way from the other end — full JS through C/LLVM, with sound type annotations for speed; JZ keeps the source plain JS and gets its types by inference.

</details>




## Performance

<img src="bench/bench.svg?v=8" alt="JZ vs alternatives — geometric-mean speed across the bench corpus, every rival compiled to WebAssembly and run in V8 (apples-to-apples); native C is the lone reference, JZ = 1.00× baseline" width="720">


See [bench →](https://dy.github.io/jz/bench/)

## Examples

<table>
<tr>
<td width="33%"><a href="https://dy.github.io/jz/examples/chladni/"><img src="examples/thumbs/chladni.webp" width="100%" alt="Chladni plate"></a><br><b>chladni</b> — frequency sweeps the nodal figure.</td>
<td width="33%"><a href="https://dy.github.io/jz/examples/julia/"><img src="examples/thumbs/julia.webp" width="100%" alt="Julia set"></a><br><b>julia</b> — escape-time Julia set; drag the constant to morph it.</td>
<td width="33%"><a href="https://dy.github.io/jz/examples/attractors/"><img src="examples/thumbs/attractors.webp" width="100%" alt="Strange attractor"></a><br><b>attractors</b> — de Jong map, luminous curves.</td>
</tr>
<tr>
<td><a href="https://dy.github.io/jz/examples/raymarcher/"><img src="examples/thumbs/raymarcher.webp" width="100%" alt="SDF raymarcher"></a><br><b>raymarcher</b> — an SDF sphere field; Shadertoy on the CPU.</td>
<td><a href="https://dy.github.io/jz/examples/nbody/"><img src="examples/thumbs/nbody.webp" width="100%" alt="N-body gravity"></a><br><b>nbody</b> — three-body gravity; fading trails trace the orbits.</td>
<td><a href="https://dy.github.io/jz/examples/game-of-life/"><img src="examples/thumbs/game-of-life.webp" width="100%" alt="Game of Life"></a><br><b>game-of-life</b> — Conway's Life straight into shared pixel memory.</td>
</tr>
<tr>
<td><a href="https://dy.github.io/jz/examples/plasma/"><img src="examples/thumbs/plasma.webp" width="100%" alt="Plasma"></a><br><b>plasma</b> — FBM domain-warp; the classic flowing shader plasma.</td>
<td><a href="https://dy.github.io/jz/examples/cloth/"><img src="examples/thumbs/cloth.webp" width="100%" alt="Cloth simulation"></a><br><b>cloth</b> — Verlet mass-spring sheet; drag it, watch it settle.</td>
<td><a href="https://dy.github.io/jz/examples/erosion/"><img src="examples/thumbs/erosion.webp" width="100%" alt="Terrain erosion"></a><br><b>erosion</b> — hydraulic droplets carve a fractal terrain.</td>
</tr>
</table>

See [all examples →](https://dy.github.io/jz/examples/)



## Alternatives

Small & fast JS subset → full JS spec & bundled engine:

* [AssemblyScript](https://github.com/AssemblyScript/assemblyscript) — TS-like dialect → WASM; small, fast output, but needs type annotations (not JS).
* [awasm-compiler](https://github.com/paulmillr/awasm-compiler) — reproducible WASM assembled through a typed *builder API*.
* [Porffor](https://github.com/CanadaHonk/porffor) — AOT JS→WASM (and C) targeting the full spec, grown against test262.
* [Static Hermes](https://github.com/facebook/hermes) — Meta's AOT JS → native via C/LLVM (no WASM target); full speed needs sound type annotations, untyped JS stays dynamic.
* [jawsm](https://github.com/drogus/jawsm) — JS→WASM in Rust on WasmGC; no interpreter, but leans on the engine's GC.
* [Javy](https://github.com/bytecodealliance/javy) — embeds QuickJS; runs almost any JS, but ships a full interpreter (large, interpreter-speed).
* [ComponentizeJS / jco](https://github.com/bytecodealliance/ComponentizeJS) — WASM Component via embedded SpiderMonkey; standards-complete, but bundles a JS engine.


## Built with

* [**subscript**](https://github.com/dy/subscript) — JS parser. Minimal, extensible, builds the exact AST JZ needs. Jessie subset keeps the grammar small and deterministic.
* [**watr**](https://www.npmjs.com/package/watr) — WAT to WASM compiler. Binary encoding, validation, and peephole optimization. JZ emits WAT text, watr turns it into valid `.wasm`.


## Contributing

Setup, code layout, and the bench/perf invariants are in [CONTRIBUTING.md](CONTRIBUTING.md);
the architecture & design rationale (NaN-boxing, type inference, native pipeline) in [research.md](.work/research.md).


<p align=center><a href="https://github.com/dy">dy</a> • <a href="https://github.com/krishnized/license/">ॐ</a></p>
