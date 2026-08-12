<a href="https://dy.github.io/jz/"><img src="jz.svg" alt="JZ logo" width="120"/></a>

![stability](https://img.shields.io/badge/stability-experimental-black) [![npm](https://img.shields.io/npm/v/jz?color=black)](http://npmjs.org/package/jz) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml) [![bench](https://github.com/dy/jz/actions/workflows/bench.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/bench.yml)

**JZ** (_javascript zero_) is a distilled JS-to-WASM compiler.

[slogan must signal: limited JS subset - distilled crockford good parts (strict) for the purpose of DSP and high performance and min size, with compat layer enabling JS compatibility surface (percentage)]

JZ accepts a strict modern JavaScript subset. The default jzify pass lowers the additional forms shown below.

JZ takes **"the good parts"** ([Crockford](https://www.youtube.com/watch?v=_DKkVvOt6dk)) with compatibility layer and **compiles JS ahead-of-time to WASM**: no runtime, no GC, no legacy, no spec creep, near-native perf with unlocked SIMD. **Valid JZ is valid JS**: run and test as JS, compile to WASM.


```js
import jz from 'jz'

const { exports: { dist } } = jz`export let dist = (x, y) => (x*x + y*y) ** 0.5`
dist(3, 4) // 5
```

<!-- [site](https://dy.github.io/jz/), [repl](https://dy.github.io/jz/repl/), [examples](https://dy.github.io/jz/examples/), [benchmarks](https://dy.github.io/jz/bench/) -->


## Why?

| Good for                     | Not for                   |
|------------------------------|---------------------------|
| DSP, audio, synthesis        | UI, DOM, the frontend     |
| Image, video, pixels         | Serving HTTP, hot I/O     |
| Simulation, physics, games   | I/O-bound orchestration   |
| Parsers, codecs, compression | Dynamic object models     |
| Scientific, numeric, ML      | Security crypto, big-ints |
| Hashing, checksums, RNG      | Glue and orchestration    |

### Used by

[**color-space**](https://github.com/colorjs/color-space)

## Usage

`npm install jz`

```js
import jz, { compile, compileModule, instantiate, transform } from 'jz'

// Compile and instantiate
const { exports: { add } } = jz('export let add = (a, b) => a + b')
add(2, 3)  // 5

// Compile to a WASM binary
const wasm = compile('export let f = (x) => x * 2')

// Compile once, instantiate many times
const mod = compileModule('export let f = (x) => x * 2')
instantiate(mod).exports.f(21)  // 42

// Compile asynchronously with the standard API
const asyncMod = await WebAssembly.compile(wasm)
const asyncInst = await WebAssembly.instantiate(asyncMod)
asyncInst.exports.f(21) // 42

// Apply the jzify lowering without compiling
transform('var x = 1; function f() { return x }')
// → 'const f = () => {\n  return x;\n};\nlet x;\nx = 1;'
transform(alreadyCanonicalSource, { onlyLowered: true })  // null if unchanged
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
| `strict: true` | Skip jzify lowering and reject dynamic fallbacks such as `obj[k]`, `for-in`, and unknown receiver methods. |
| `alloc: false` | Omit allocator exports (`_alloc`/`_clear`) from modules that never marshal heap values. |
| `noSimd: true` | Disable auto-vectorization. Explicit `f32x4` and `i32x4` intrinsics still compile. |
| `whyNotSimd: true` | Report the first operation that prevented each loop from being vectorized. Warnings go to the `warnings` sink. |
| `experimentalStencil: true` | Vectorize neighbour-load stencils such as `b[i] = f(a[i-1], a[i], a[i+1])` and 2-D 5-point sweeps to f64x2. Unstable and off by default. |
| `experimentalOuterStrip: true` | Strip-mine a pixel loop containing an inner reduction into f64x2. Each lane keeps scalar accumulation order. Unstable and off by default. |
| `randomSeed` | Set a number for a reproducible `Math.random` sequence. The default uses host entropy; `true` requests entropy explicitly. |
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
  jz --strict <file.js>     Strict mode: pure canonical subset, no lowering
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

<!-- FIXME: can these points be made shorter (grouping? shorter names?) AND/OR maybe made into links to MDN? -->
```
┌────────────────────────────────────────────────────────────────────────┐
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ jz strict                                                          │ │
│ │   let/const  =>  ...xs  destructuring  import/export               │ │
│ │   if/else  for/while/do-while/of/in  break/continue                │ │
│ │   try/catch/finally  throw                                         │ │
│ │   operators  strings  booleans  numbers  arrays  objects  `${}`    │ │
│ │   Math  Number  String  Array  Object  JSON  RegExp  Symbol  null  │ │
│ │   ArrayBuffer  DataView  TypedArray  Map  Set  Atomics             │ │
│ │   Float16Array  Uint8ClampedArray  Math.f16round  get/setFloat16   │ │
│ │   Math.sumPrecise                                                  │ │
│ │   parseInt  parseFloat  encodeURI(Component)  Error  BigInt        │ │
│ │   Uint8Array.fromBase64/toBase64/fromHex/toHex  atob  btoa         │ │
│ │   crypto.getRandomValues  crypto.randomUUID  TextEncoder(Into)     │ │
│ │   console  setTimeout/setInterval  requestAnimationFrame  Date     │ │
│ │   performance  navigator.hardwareConcurrency                       │ │
│ │   structuredClone  groupBy  Set algebra  iterator helpers          │ │
│ │   fs.read/write (WASI hosts)  fetch via async host imports         │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ jz default (jzify)                                                     │
│   var  function  arguments  switch  new Foo()                          │
│   class  new  this  extends  super  static  #private                   │
│   function*  yield  yield*  Foo.prototype.m = …                        │
│   async/await  async function*  for await  Promise  using              │
│   queueMicrotask  URLSearchParams                                      │
│   Symbol.iterator  Symbol.asyncIterator  Symbol.dispose                │
│   SharedArrayBuffer (→ ArrayBuffer)                                    │
│   ==  !=  instanceof  undefined  WeakMap  WeakSet                      │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
Not supported
  delete  getters/setters  eval  Function  with
  Proxy  Reflect
  import()  DOM  Intl  Node APIs
```


## FAQ

<details>
<summary><strong>What are the differences with JS?</strong></summary>

JZ follows WASM and native conventions when doing so preserves f64 precision ([rationale](CONTRIBUTING.md#principles)). Its differences from JavaScript are:

- **Numbers.** Numbers are `f64`. Proven integers, including loop counters, array indices, and values narrowed by `| 0`, use `i32` and wrap at ±2³¹. Applying `x | 0` to an f64 with |x| ≥ 2⁶³ saturates instead of ES-wrapping, matching the asm.js boundary.
- **Math.** `sqrt`, `abs`, `floor`, `ceil`, `trunc`, `round`, `sign`, `fround`, and `f16round` are IEEE-exact. Other transcendental functions use minimax or Newton kernels and may differ from the host library in their last bits. `optimize: { crPow: true }` selects the correctly rounded `pow` kernel. `Math.sumPrecise` uses exact fixed-point accumulation and rounds once, so `Math.sumPrecise(Array(1e7).fill(0.1))` returns exactly `1000000`. Constant arithmetic through `+ - * /` also uses exact rationals and rounds once: `0.1 + 0.2 - 0.3` folds to `2.7755575615628914e-17`, and `1e300*1e300/1e300` remains finite.
- **Strings.** Strings are UTF-8 bytes. `.length`, `charCodeAt`, indexing, `slice`, `indexOf`, and regular expression positions count bytes, so `"中".length` is `3`. Case conversion and trimming are ASCII-only.
- **Objects.** Object literals have fixed slots. Computed writes use per-object hash storage and enumerate normally. A dot property added after the literal remains readable but is not enumerated. Use `Map` for many dynamic keys.
- **Array indices.** Indices coerce to `i32`, so `a[1.5]` reads `a[1]` and `a[NaN]` reads `a[0]`. Plain arrays are bounds checked. Typed arrays are fixed-size and use raw linear-memory reads; a negative or out-of-bounds index may read unrelated memory or trap.
- **Memory.** JZ has no garbage collector. Call `memory.reset()` between independent allocation batches. `WeakMap` and `WeakSet` use `Map` and `Set` semantics.
- **Pseudo-classical constructors.** A constructor function plus `P.prototype.m = function () {}` folds into class lowering. Arrow-valued members keep lexical `this` and are not folded.
- **Generators and iterator helpers.** Generators compile to state machines without stack suspension. `for-of` over a generator call becomes a loop. ES2025 helper chains such as `g().map(f).filter(p).take(n)` fuse into one loop. Helper results remain values and support later chaining, `instanceof Iterator`, and `Array.from`. `yield*`, stored iterators, hand-written `{ next }` objects, and `[Symbol.iterator]()` providers are supported. `try` across `yield` is not.
- **Async functions and promises.** Async functions use the same state-machine lowering, with `await` represented as `yield`. The promise runtime is included only when used. Promise methods, async generators, and `for await` are supported. Jobs drain at host boundaries rather than after each continuation. Unhandled rejections are not reported, `try` across `await` is unsupported, and `memory.reset()` must not run while a promise is pending.
- **Fetch.** In a JavaScript host, bare `fetch(url)` binds to the host. A `Response` remains a host handle, and methods such as `text()` and `json()` return awaitable values. Custom host functions may also return promises. Under `host: 'wasi'`, provide `env.fetch` yourself.
- **Workers.** `sharedMemory: true` compiles against shared `WebAssembly.Memory` with an atomic heap bump. `Atomics.*` on `Int32Array` lowers to WASM thread operations. `jz.pool(src, {threads})` runs one kernel across Node worker threads. Shared typed arrays and scalars are supported; strings and objects remain thread-local.
- **Number formatting.** `String(number)` uses a shortest-round-trip Ryū formatter, including exponential notation and subnormals. Its ~9.7 KB power-of-5 table is included only when a module stringifies floats.
- **Errors.** Constructed errors have `.message`, `.name`, and class-correct `instanceof`. Unlike JavaScript, `.message` and `.name` are enumerable. Most runtime-raised errors remain numeric codes inside an in-WASM `catch`, so their properties are `undefined` and `instanceof` is false. At a synchronous host boundary, uncaught internal codes and top-level constructed errors decode to the corresponding ECMAScript class; errors nested in a returned container decode as plain objects, and async exports cannot yet resolve heap values, including errors. Unrelated WASM traps remain `WebAssembly.RuntimeError`. A member access or call on a value proven possibly nullish raises a `TypeError` object. Literal `null.x` still returns `undefined`.
- **Dates.** Date getters return UTC; `getHours` is equivalent to `getUTCHours`.
- **Random values.** By default, `Math.random`, `crypto.getRandomValues`, and `crypto.randomUUID` use host entropy. A numeric `randomSeed` makes all three deterministic and unsuitable for cryptography.
- **Float16 and clamped bytes.** `Float16Array`, `Math.f16round`, and `DataView` float16 methods round directly from f64 with ties to even. `Uint8ClampedArray` uses `ToUint8Clamp`. Neither kind auto-vectorizes.
- **Web codecs.** `atob` and `btoa` use byte strings. The ES2026 base64 and hex methods on `Uint8Array` support compile-time literal options and `lastChunkHandling: 'loose'`. `URLSearchParams` follows WHATWG decoding and escaping; its iterator methods return arrays, sorting compares UTF-8 bytes, and the object itself is not iterable. `queueMicrotask` uses the promise job queue. `requestAnimationFrame` uses the host implementation or a 16 ms timer fallback.
</details>

<details>
<summary><strong>What is unsupported?</strong></summary>

These features are outside JZ's fixed-layout, runtime-free model:

- **Proxy and Reflect.** Traps do not apply to structs with compile-time offsets.
- **Property descriptors and accessors.** Objects store values without `writable`, `enumerable`, getter, or setter metadata.
- **Live prototype chains.** `__proto__`, delegation, and monkey-patching are unsupported. `Object.create(proto)` makes a shallow copy; method dispatch is static.
- **Deleting literal properties.** Literal object shapes are fixed. Dictionary-mode `delete o[k]` works.
- **eval, the `Function` constructor, and `with`.** These would require a compiler or interpreter at runtime.
- **Intl and Temporal.** ICU, CLDR, and timezone tables exceed the intended module size. `Date` uses UTC.
- **UTF-16 and Unicode tables.** Strings are UTF-8 bytes. Unicode property classes, normalization, and locale case conversion are unsupported.
- **Arbitrary-precision BigInt.** BigInt is a signed 64-bit integer and wraps past its range. Security cryptography is outside the scope.
- **Boolean identity in dynamic keys.** Runtime boolean keys use their numeric carrier, so `o[b]` reads `'1'` for `true`. Static boolean keys fold correctly. This is pinned in `test/dyn-keys.js`.
- **WeakRef and FinalizationRegistry.** There is no garbage collector to observe. `WeakMap` and `WeakSet` use `Map` and `Set` semantics.
- **Legacy browser features, DOM, and Node APIs.** [ECMAScript Annex B](https://tc39.es/ecma262/multipage/additional-ecmascript-features-for-web-browsers.html) specifies legacy compatibility features required in web browsers; JZ omits its additional syntax. DOM and Node services stay in the host.
</details>


<details>
<summary><strong>Can I use existing npm packages or JS libraries?</strong></summary>

Packages compile when their source fits the JZ subset. Code using the DOM or Node APIs does not. Pure numeric or algorithmic source may include async functions and promises; network calls cross as host imports.

- **Relative imports** (`./dep.js`) bundle at compile time.
- **Bare specifiers** (`import { x } from "pkg"`) require the CLI's `--resolve` flag or source supplied through `{ modules }`.

</details>

<details>
<summary><strong>Can I use import/export?</strong></summary>

Standard `import` and `export` syntax bundles into one WASM module at compile time. There is no runtime module resolution.

```js
const { exports } = jz(
  'import { add } from "./math.js"; export let f = (a, b) => add(a, b)',
  { modules: { './math.js': 'export let add = (a, b) => a + b' } }
)
```

Transitive imports work; circular imports fail at compile time. The CLI resolves filesystem imports. In a browser, fetch the sources and pass them through `{ modules }`.

</details>

<details>
<summary><strong>Can I call into the host (functions, objects)?</strong></summary>

Use `import … from 'host'` with the `{ imports }` option to bind a JavaScript function, constant, or namespace. Numbers pass directly; strings, arrays, and objects use `memory.*`.

```js
// Custom function
jz('import { log } from "host"; export let f = (x) => { log(x); return x }',
   { imports: { host: { log: console.log } } })

// Bind a namespace; functions become imports and numeric constants fold
jz('import { sin, PI } from "math"; export let f = () => sin(PI / 2)',
   { imports: { math: Math } })

// globalThis works too
jz('import { parseInt } from "window"; export let f = () => parseInt("42")',
   { imports: { window: globalThis } })
```

</details>

<details>
<summary><strong>Can I interpolate values (template literals)?</strong></summary>

As a tagged template, `jz` inserts interpolated values at compile time. Numbers and booleans inline directly; strings, arrays, and objects become JZ literals:

```js
jz`export let f = () => ${'hello'}.length`               // 5
jz`export let f = () => ${[10, 20, 30]}[1]`              // 20
jz`export let f = () => ${{name: 'jz', count: 3}}.count` // 3

const scale = (x) => x * 10
jz`export let f = (n) => ${scale}(n) + 1`                // f(2) → 21, host-called
```

Interpolated functions become host calls. Non-serializable values such as host objects and class instances use post-instantiation getters.

</details>

<details>
<summary><strong>How do I pass numbers, strings, arrays, and objects between JS and WASM?</strong></summary>

Numbers cross as `f64` or `i32`. Heap values use tagged pointers; `null`, `undefined`, and booleans use atom tags. Both use the same i64 NaN-box carrier, represented as `BigInt` in JavaScript. Using i64 preserves the NaN payload in JSC and Safari, which canonicalize f64 NaNs at the boundary. The carrier and `_alloc`/`_clear` exports form the ABI, documented in [`layout.js`](layout.js) and [`test/abi.js`](test/abi.js). The [`jz:i64exp`](interop.js) custom section marks i64 parameters and results. Numeric arrays of at most eight elements return as WASM multi-values.

The `memory` codec returned by `jz()` or `jz/interop`'s `instantiate()` marshals arguments, decodes pointer results, and converts WASM throws to `Error` objects:

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
exports.rgb(100)                              // [100, 50, 20]
memory.read(exports.process(memory.Float64Array([1, 2, 3])))  // Float64Array [2, 4, 6]
```

`memory.String`, `.Array`, typed-array methods, and `.Object` allocate on the heap and return a pointer. `memory.read(ptr)` decodes it. Keys passed to `memory.Object()` must match a compiled schema; key order does not matter.

</details>

<details>
<summary><strong>Do I need JZ at runtime?</strong></summary>

The compiler runs at build time.

- **Numeric modules.** Ship only the `.wasm` and instantiate it with `WebAssembly`: `(await WebAssembly.instantiate(wasmBytes)).instance.exports.dist(3, 4)`. Use `{ alloc: false }` to omit `_alloc` and `_clear`.
- **Heap values.** Ship the `.wasm` with `jz/interop`. Its ~6 KB gzipped bridge instantiates the module and wires the allocator, memory codec, WASI, and `wasm:js-string` imports as needed.
- **Standalone engines.** Compile with `host: 'wasi'`.

</details>

<details>
<summary><strong>Can I run the `.wasm` without a JavaScript host (WASI)?</strong></summary>

There are two `host` targets:

- **`js`** (default) runs in a browser, Node, Deno, or Bun. `jz()` and `jz/interop` wire the required `env.*` services and marshal values. Override services through `opts.imports.env`.
- **`wasi`** runs in a standalone WASM engine such as wasmtime or wasmer. JZ emits WASI Preview 1 imports. Without a JavaScript bridge, heap values must be passed manually.

For `host: 'wasi'`, module initialization is exported as the WASI reactor function `_initialize`; Preview 1 forbids WASI calls from a start section. WASI hosts, `jz/wasi`, and `jz/interop` call it after wiring memory. When instantiating manually, call `instance.exports._initialize?.()` once. The `run` and `_start` command entries initialize themselves.

A module imports `env`, `wasi_snapshot_preview1`, or neither.

| What your code does | `js` (default) | `wasi` |
|---|---|---|
| `console.log()` | `env.print` (host stringifies) | WASI `fd_write` |
| `Date.now()` / `performance.now()` | `env.now` → f64 | WASI `clock_time_get` |
| `setTimeout` / `setInterval` | `env.setTimeout` (host schedules) | WASM timer queue + `__timer_tick` |
| dynamic `obj.method()` | `env.__ext_call` (JS resolves) | error at compile time |

</details>

<details>
<summary><strong>How does memory work?</strong></summary>

JZ uses a bump allocator with no free list or garbage collector. The first 1 KB contains static data and, for shared memory, the bump pointer at byte 1020. The heap starts at byte 1024 or after static data when the literals exceed 1 KB. WASM memory grows when full.

Allocations are not reclaimed automatically. Reset between independent batches:

```js
for (let i = 0; i < 1000; i++) {
  const sum = exports.process(100)   // allocates an array each call
  memory.reset()                     // drop everything; heap ptr → 1024
}
```

`memory.reset()` invalidates every previous pointer. Read needed values before resetting. `memory.alloc(bytes)` returns a raw offset from the same allocator. Scalar modules without heap values omit the allocator.

</details>

<details>
<summary><strong>Can modules share memory?</strong></summary>

`jz.memory()` creates a shared memory that modules compile into. Schemas accumulate, so objects created in one module are readable by another:

```js
const memory = jz.memory()
const a = jz('export let make = () => { let o = {x: 10, y: 20}; return o }', { memory })
const b = jz('export let read = (o) => o.x + o.y', { memory })

b.exports.read(a.exports.make())  // 30
memory.read(a.exports.make())     // {x: 10, y: 20}
```

Pass an existing `WebAssembly.Memory` to wrap it: `jz.memory(new WebAssembly.Memory({ initial: 4 }))`.

Each module has two call surfaces:

- **`.exports`** marshals JavaScript arguments, decodes pointer results, and converts WASM throws to `Error` objects. Values passed between modules are re-marshaled through shared memory.
- **`.instance.exports`** exposes the raw `WebAssembly.Instance`. Numbers pass unchanged; boxed results return as i64 carriers represented by `BigInt`. Decode one with `memory.read(ptr)` or pass the carrier directly to another raw export.

</details>

<details>
<summary><strong>How big is the output?</strong></summary>

Across the benchmark corpus, JZ modules are 1.02× the size of AssemblyScript modules by geometric mean. The AssemblyScript ports use `unchecked()` array access, while JZ includes JavaScript out-of-bounds guards. Most JZ modules are single-digit kB; the [ZzFX synth](examples/zzfx) is ~10 kB and [mandelbrot](examples/mandelbrot) is ~7 kB.

- **`optimize: 'size'`** keeps size passes and disables loop unrolling and SIMD.
- **`alloc: false`** omits the allocator from numeric modules.
- **`host: 'wasi'`** omits JavaScript host shims. The `name` section is already off unless `names: true` is set.

Hand-written WAT is about 3–8× smaller on tight kernels because it can omit generic allocator and standard-library helpers. CI checks size budgets ([full table](bench/README.md)).

</details>


<details>
<summary><strong>Which optimizations are applied?</strong></summary>

At the default `optimize: 2`, JZ applies:

- **Type narrowing.** Parameters and results become `i32`, `f64`, booleans, or typed-array elements when call sites prove their types. Typed arrays use direct memory access; plain arrays retain guards.
- **Escape analysis and arena rewind.** Fixed-shape values may become WASM locals. Scratch allocations that do not escape are reclaimed on function exit.
- **Loop optimization.** JZ hoists invariants, eliminates common subexpressions, reuses typed-array addresses, reduces induction expressions, and unrolls small fixed loops.
- **SIMD-128.** Independent map, reduction, conditional-map, and byte-scan iterations use vector lanes. Loop-carried dependencies remain scalar.
- **Encoding.** Tree shaking, copy propagation, dead-store elimination, index reordering, pointer-call specialization, and constant pooling reduce output. Read-only JavaScript strings remain zero-copy.

For `host: 'js'`, console and timer calls become `env.*` imports, and constant `JSON.parse` calls fold to literals. Optimization levels run from `0` through `3`; `'speed'` equals `3`, while `'size'` disables unrolling and SIMD.

</details>

<details>
<summary><strong>How do I inspect or debug the output?</strong></summary>

- **Semantics.** Run the source under Node and compare results, allowing for the [documented differences](#faq). `console.log` also works in compiled modules.
- **Code generation.** `jz program.js --wat` or `compile(src, { wat: true })` prints WAT. Search for `v128` to confirm vectorization and for `__dyn_get` or `__ext_call` to find dynamic fallbacks. `--why-not-simd` or `whyNotSimd: true` reports the first operation blocking each loop.
- **Dynamic fallbacks.** Set `strict: true` to make `obj[k]`, `for-in`, and unknown receiver methods compile errors.
- **Profiling.** `--names` or `names: true` emits function names. `--stats` or the `profile` sink records compile-stage timings.
- **Slow kernels.** A float literal can pin a counter to f64, plain arrays need more checks than typed arrays, and loop-carried dependencies block SIMD.

</details>

<details>
<summary><strong>How does JZ work?</strong></summary>

Each `compile()` call passes a source string through six stages:

```
 your .js
   │ parse      jessie parser (subscript) → AST
   │ jzify      lower legacy JS to the canonical subset (var/function/class/==/…)
   │ prepare    resolve & bundle imports, normalize the AST
   │ compile    type inference (i32 vs f64) + emit WAT IR; module/ handlers lower operators
   │ optimize   WAT-level passes: CSE, DCE, const-fold, inline, peephole
   │ encode     watr: WAT → WASM binary
   ▼
 .wasm
```

Parsing uses [`subscript`](https://github.com/dy/subscript)'s Jessie grammar. [`jzify/`](jzify/) lowers syntax, [`src/prepare/`](src/prepare/) bundles modules, and [`src/compile/`](src/compile/) performs inference and code generation. Built-ins live in [`module/`](module/), heap layout in [`src/abi/`](src/abi/), and WAT passes in [`src/optimize/`](src/optimize/) and [`src/wat/`](src/wat/). [`watr`](https://github.com/dy/watr) encodes the final module. [`src/ctx.js`](src/ctx.js) owns shared compile state.

</details>


<details>
<summary><strong>Why no type annotations?</strong></summary>

Annotations such as `let x: i32` would make the source invalid JavaScript. JZ infers types from existing syntax:

```js
export let bits = (a, b) => a | b   // i32; bitwise operands
export let half = (n) => n * 0.5    // f64; fractional literal
```

Literals, bitwise operators, and use sites can prove `i32`, `f64`, string, object, or typed-array types. Ambiguous values remain dynamic and are checked at runtime.

</details>


<details>
<summary><strong>How does JZ differ from Porffor, scriptc, and AssemblyScript?</strong></summary>

JZ targets numeric JavaScript and emits WASM without annotations.

- **Porffor** targets broad JavaScript coverage and compiles through its own C backend; its 2026 rewrite has no WASM target.
- **scriptc** compiles type-checked TypeScript to native executables through LLVM and has no WASM target. JZ can reach native code through the [`wasm2c` pipeline](scripts/native/README.md).
- **AssemblyScript** is a typed TypeScript-like language targeting WASM. Its source does not run directly in a JavaScript engine.

</details>


<details>
<summary><strong>Is JZ production-ready?</strong></summary>

JZ is experimental and pre-1.0. The subset and WASM ABI may change, so pin a version and re-test upgrades. CI runs the core suite, about 3,900 selected test262 files with no failures, benchmark checks, and a self-host build. Excluded test262 files are classified by name.

</details>


<details>
<summary><strong>Can I compile in the browser or a Worker?</strong></summary>

The compiler is synchronous and performs no I/O; callers provide the source strings. It runs on the main thread, in a Web Worker, or during a build. Kernel compilation usually takes milliseconds. The resulting module runs in browsers, workers, Node, Deno, Bun, and standalone WASM engines.

</details>


<details>
<summary><strong>Can JZ compile itself?</strong></summary>

JZ compiles its source to `dist/jz.wasm`. The parser, jzify pass, compiler, optimizer, and encoder then run inside WASM. `npm run test:self` builds this compiler, compiles programs with it, and runs their output.

BigInt uses tagged `PTR.BIGINT` boxes by default; `JZ_CARRIER_BOX=0` restores the legacy raw-i64 carrier. One ambiguity remains in programs that construct BigInt: `Number` coercion from a value of unproven kind may interpret a colliding subnormal Number as BigInt bits. This affects dictionary properties and mixed-type array elements, not proven locals or parameters. Programs that never construct BigInt are unaffected. The divergence is pinned in `test/data.js`.

</details>


<details>
<summary><strong>Can I compile JZ to C?</strong></summary>

Use [wasm2c](https://github.com/WebAssembly/wabt/blob/main/wasm2c) or [w2c2](https://github.com/turbolent/w2c2):

```sh
jz program.js -o program.wasm
wasm-opt -O3 program.wasm -o program.opt.wasm
wasm2c program.opt.wasm -o program.c
cc -O3 program.c -o program
```

The full pipeline adds `wasm-opt -O3`, `clang -O3 -flto`, and PGO. On an M4 Max it beats V8 on 19 of 21 watr examples and ties the other two. See [`scripts/native/README.md`](scripts/native/README.md).

</details>




## Performance

<img src="bench/bench.svg?v=8" alt="Geometric-mean benchmark speed. WASM targets run in V8; native C is the reference; JZ is the 1.00× baseline." width="720">


See the [benchmark results](https://dy.github.io/jz/bench/).

## Examples

<table>
<tr>
<td width="33%"><a href="https://dy.github.io/jz/examples/chladni/"><img src="examples/thumbs/chladni.webp" width="100%" alt="Chladni plate"></a><br><b>chladni</b>: swept-frequency nodal figures.</td>
<td width="33%"><a href="https://dy.github.io/jz/examples/julia/"><img src="examples/thumbs/julia.webp" width="100%" alt="Julia set"></a><br><b>julia</b>: interactive escape-time Julia set.</td>
<td width="33%"><a href="https://dy.github.io/jz/examples/attractors/"><img src="examples/thumbs/attractors.webp" width="100%" alt="Strange attractor"></a><br><b>attractors</b>: de Jong map.</td>
</tr>
<tr>
<td><a href="https://dy.github.io/jz/examples/raymarcher/"><img src="examples/thumbs/raymarcher.webp" width="100%" alt="SDF raymarcher"></a><br><b>raymarcher</b>: CPU SDF sphere field.</td>
<td><a href="https://dy.github.io/jz/examples/nbody/"><img src="examples/thumbs/nbody.webp" width="100%" alt="N-body gravity"></a><br><b>nbody</b>: three-body simulation.</td>
<td><a href="https://dy.github.io/jz/examples/game-of-life/"><img src="examples/thumbs/game-of-life.webp" width="100%" alt="Game of Life"></a><br><b>game-of-life</b>: Conway's Life in shared pixel memory.</td>
</tr>
<tr>
<td><a href="https://dy.github.io/jz/examples/plasma/"><img src="examples/thumbs/plasma.webp" width="100%" alt="Plasma"></a><br><b>plasma</b>: FBM domain warp.</td>
<td><a href="https://dy.github.io/jz/examples/cloth/"><img src="examples/thumbs/cloth.webp" width="100%" alt="Cloth simulation"></a><br><b>cloth</b>: Verlet mass-spring simulation.</td>
<td><a href="https://dy.github.io/jz/examples/erosion/"><img src="examples/thumbs/erosion.webp" width="100%" alt="Terrain erosion"></a><br><b>erosion</b>: hydraulic terrain erosion.</td>
</tr>
</table>

See [all examples](https://dy.github.io/jz/examples/).



## Alternatives

* [AssemblyScript](https://github.com/AssemblyScript/assemblyscript) is a typed TypeScript-like language targeting WASM.
* [awasm-compiler](https://github.com/paulmillr/awasm-compiler) assembles reproducible WASM through a typed builder API.
* [Porffor](https://github.com/CanadaHonk/porffor) is an AOT JavaScript engine with its own C backend. Its 2026 rewrite has no WASM target.
* [Static Hermes](https://github.com/facebook/hermes) compiles JavaScript to native code through C and LLVM; static optimization uses type annotations.
* [scriptc](https://github.com/vercel-labs/scriptc) compiles type-checked TypeScript to native code through LLVM and uses QuickJS for dynamic code.
* [jawsm](https://github.com/drogus/jawsm) compiles JavaScript to WasmGC.
* [Javy](https://github.com/bytecodealliance/javy) embeds QuickJS in WASM.
* [ComponentizeJS / jco](https://github.com/bytecodealliance/ComponentizeJS) creates WASM Components with embedded SpiderMonkey.


## Built with

* [**subscript**](https://github.com/dy/subscript) parses the Jessie JavaScript subset into JZ's AST.
* [**watr**](https://www.npmjs.com/package/watr) validates, optimizes, and encodes WAT as `.wasm`.


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code layout, and performance checks. Architecture notes are in [research.md](.work/research.md).


[MIT](LICENSE). [ॐ](https://github.com/krishnized/license/)
