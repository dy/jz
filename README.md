<img src="jz.svg" alt="jz logo" width="120"/>



## ![stability](https://img.shields.io/badge/stability-experimental-black) [![npm](https://img.shields.io/npm/v/jz?color=black)](http://npmjs.org/jz) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml) [![test262](https://github.com/dy/jz/actions/workflows/test262.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test262.yml) [![bench](https://github.com/dy/jz/actions/workflows/bench.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/bench.yml)


**JZ** (_javascript zero_) is a **minimal modern functional JS subset** that compiles to WASM.<br>

```js
import jz from 'jz'

// Distance between two points
const { exports: { dist } } = jz`export let dist = (x, y) => (x*x + y*y) ** 0.5`
dist(3, 4) // 5
```

## Why?

**Write plain JS, compile to WASM** — fast, portable, sealed.

JZ distills modern JS to its functional core (the [Crockford](https://www.youtube.com/watch?v=_DKkVvOt6dk) "good parts" ) — without the legacy, feature creep, and unpredictable performance.

* **Static AOT** – no runtime, no GC, no dynamic constructs.
* **Valid jz = valid js** – test in browser, compile to wasm.
* **Minimal** – output like hand-written WAT, theoretical minimum.
<!-- * **Realtime** – compiles faster than `eval`, useful for live-coding and REPL. -->

| Good for                    | Not for                    |
|-----------------------------|----------------------------|
| Numeric / math compute      | UI / frontend              |
| DSP / audio / bytebeats     | Backend / APIs             |
| Parsing / transforms        | Async / I/O-heavy logic    |
| WASM utilities              | JavaScript runtime         |

<!-- Inspired by [porffor](https://github.com/CanadaHonk/porffor) and [piezo](https://github.com/dy/piezo). -->
<!-- Used internally by: web-audio-api, color-space, audiojs -->


## Usage

`npm install jz`

```js
import jz, { compile } from 'jz'

// Compile, instantiate
const { exports: { add } } = jz('export let add = (a, b) => a + b')
add(2, 3)  // 5

// Compile only — returns raw WASM binary (no JS adaptation)
const wasm = compile('export let f = (x) => x * 2')
const mod = new WebAssembly.Module(wasm)
const inst = new WebAssembly.Instance(mod)

// Async WASM startup — jz source compilation is still synchronous
const asyncMod = await WebAssembly.compile(wasm)
const asyncInst = await WebAssembly.instantiate(asyncMod)
asyncInst.exports.f(21) // 42
```

<details>
<summary><strong>Options</strong></summary><br>

Options are passed as `jz(source, opts)` or `compile(source, opts)`. Common ones:

| Option | Use |
|---|---|
| `jzify: true` | Accept broader JS patterns such as `var`, `function`, `switch`, `arguments`, `==`, `undefined`, and `class` (see *Not supported* below for the class subset) by lowering them to the JZ subset. The CLI auto-enables this for `.js` files. |
| `modules: { specifier: source }` | Bundle static ES imports into one WASM module. CLI import resolution does this from files automatically. |
| `imports: { mod: host }` | Wire host namespaces/functions used by `import { fn } from "mod"`; functions may be plain JS functions or `{ fn, returns }` specs. |
| `memory` | Pass `memory: N` to create owned memory with `N` initial pages, or pass `memory: jz.memory()` / `WebAssembly.Memory` to share memory across modules. |
| `host: 'js' \| 'wasi'` | Select runtime-service lowering. Default `js` uses small `env.*` imports auto-wired by `jz()`; `wasi` emits WASI Preview 1 imports for wasmtime/wasmer/deno. |
| `optimize` | `false`/`0` disables optimization, `1` keeps cheap size passes, `true`/`2` is the default (every stable jz pass + full watr), `3` adds larger array/hash initial caps and inlines `f64.const` over mutable globals (trades size for speed). String aliases `'size'` (unroll/vectorize off, tight scalar caps — smallest wasm), `'balanced'` (= default), `'speed'` (full unroll + SIMD). Object form overrides individual passes/knobs (and accepts `level:` as a number or alias base). |
| `strict: true` | Reject dynamic fallbacks such as unknown receiver method calls, `obj[k]`, and `for-in` instead of emitting JS-host dynamic dispatch. |
| `alloc: false` | Omit raw allocator exports like `_alloc`/`_clear` when compiling standalone WASM that never marshals heap values across the host boundary. |
| `randomSeed` | Seed for `Math.random`. Default is a fixed constant — deterministic and reproducible. A number sets a different fixed seed; `randomSeed: true` seeds once from host entropy on first use (`crypto` under `host:'js'`, `random_get` under WASI) for non-reproducible randomness. |
| `wat: true` | `compile()` returns WAT text instead of a WASM binary. |
| `profile` | Pass a mutable sink to collect compile-stage timings; set `profile.names = true` to also emit a WASM `name` section for profiler/debugger symbolication. |

</details>

## CLI

`npm install -g jz`

```sh
# Compile
jz program.js              # → program.wasm
jz program.js --wat        # → program.wat
jz program.js -o out.wasm  # custom output (- for stdout)

# Optimization level: -O0 off, -O1 size, -O2 balanced, -O3 speed
jz program.js -O3

# Runtime-service lowering: js (default) or wasi
jz program.js --host wasi

# Evaluate
jz -e "1 + 2" # 3

# Show help
jz --help
```


## Language

JZ is a strict functional JS subset. Built-in `jzify` transform extends support to legacy patterns.

```
┌────────────────────────────────────────────────────────────────────────┐
│ JZify                                                                  │
│   var  function  arguments  switch  new Foo()                          │
|   class  new  this  extends  super  static  #private                   │
│   ==  !=  instanceof  undefined                                        |
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

`Valid jz = valid JS` means jz source always parses and runs as JS — but jz compiles to *static* WASM, so a handful of behaviors diverge from V8. These are deliberate trades, not unfinished corners: each one is what keeps the output close to hand-written WAT. `--wat` shows exactly what was emitted. (For what's out of scope entirely — `eval`, `async`, `Proxy`, … — see the *Not supported* box above; for moving values across the boundary, see [Interop](#interop).)

- **A boolean can surface as `1`/`0` at the host boundary.** `typeof`, `String`, `JSON.stringify`, a directly-returned comparison, and a boolean-returning method (`.includes` / `.some` / `.every` / `.startsWith` / `.endsWith` / `.test`) all hand back a real boolean — but a boolean produced by value-preserving `&&`/`||`, or read bare from an untyped container, crosses as the numeric carrier `1`/`0`.
- **`+` on two untyped parameters is numeric.** With no operand proven to be a string, `(a, b) => a + b` infers numeric addition, so passing strings yields a numeric result (`NaN`), not concatenation — keeping `+` a single `f64.add` in numeric kernels rather than a per-use runtime type check. Give either side static string evidence (a string literal, or a param used as a string elsewhere) and `+` concatenates; or annotate by seeding `a = ''`.
- **Legacy octal literals are decimal.** `0377` evaluates to `377`, not `255` (and not the `SyntaxError` a JS module / strict mode raises) — the parser reads the leading-zero form as decimal. Use the `0o377` form for octal.
- **Integers wrap at ±2³¹ once inferred into `i32`.** For speed, jz stores a value in a 32-bit int wherever it can prove the value is only ever used as one — loop counters, bitwise results, integer-only accumulators. Such a value then follows asm.js `ToInt32` semantics: it wraps mod 2³² past ±2³¹ instead of staying an exact f64. `let s = 0; for (…) s += 1e6` that overflows 2³¹ yields a wrapped negative (`-1294967296`), where the same total kept in f64 stays exact (`3000000000`). A value that is ever fractional, or that crosses the host boundary as a number, stays f64 — as do large literals. If you need exact integers beyond 2³¹, keep the value f64-typed; otherwise keep magnitudes under 2³¹. (`--wat` shows which locals are `i32`.)
- **Number→string keeps ~9 significant digits.** `String(1/3)` → `"0.333333333"`, `String(Math.PI)` → `"3.14159265"` (V8 emits the full 17-digit shortest round-trip). Integers print exactly at any magnitude; the cap is on a non-integer's significand, and keeps `__ftoa` a compact WAT routine. It shows up in `String(x)`, template interpolation, and `JSON.stringify` of non-integers.
- **Objects are fixed-layout schemas** — key set and order fixed at the literal; `delete` is rejected; `memory.Object({…})` must match the source key order.
- **Errors are untagged** — `throw` carries a value, not a typed `Error`; `e instanceof TypeError` does not discriminate.
- **`Set`/`Map` iterate slot order**, not insertion order.
- **`WeakMap`/`WeakSet` fold to `Map`/`Set`** — jz has no GC, so weakness is unobservable. The fold accepts primitive keys (real `WeakMap` would throw `TypeError`) and exposes `.size` / iteration. Use them as identity-keyed caches; do not rely on weak-reference semantics.
- **Memory is not reclaimed automatically** — see *How does memory work?* below.

For full TC39 conformance use [porffor](https://github.com/CanadaHonk/porffor); jz trades completeness for low-level numeric performance by design.

</details>

<details>
<summary><strong>Can I use npm packages or existing JS libraries?</strong></summary>

<br>

Only code that fits the jz subset. There's no runtime, so packages touching the DOM, `async`/`Promise`, the network, or Node APIs won't compile — but pure numeric/algorithmic source does.

- **Relative imports** (`./dep.js`) bundle at compile time.
- **Bare specifiers** (`import { x } from "pkg"`) resolve through Node module resolution only with the `--resolve` CLI flag, or by passing the source yourself via `{ modules }`. The package's source still has to be valid jz.

jz is for compiling *your* numeric/DSP/parser code, not for running the npm ecosystem.

</details>

<details>
<summary><strong>Can I use import/export to split code?</strong></summary>

<br>

Yes. Standard `import`/`export` syntax is bundled at compile time into a single WASM — no runtime module resolution.

```js
const { exports } = jz(
  'import { add } from "./math.jz"; export let f = (a, b) => add(a, b)',
  { modules: { './math.jz': 'export let add = (a, b) => a + b' } }
)
```

Transitive imports work (main → math → utils → …); circular imports error at compile time. The **CLI** resolves filesystem imports automatically (`jz main.jz -o main.wasm` reads `./math.jz` etc.). In the **browser**, fetch sources yourself and pass them via `{ modules }` — the compiler stays synchronous and pure, no I/O.

</details>

<details>
<summary><strong>How does memory work? How do I reset it?</strong></summary>

<br>

jz uses a **bump allocator**: every heap value (string, array, object, typed array) bumps a single pointer forward — no free list, no GC. The heap starts at byte 1024 and grows the WASM memory automatically when full.

So **memory is never reclaimed implicitly** — a long-running program that allocates per call grows without bound. Reset the heap pointer between independent batches:

```js
for (let i = 0; i < 1000; i++) {
  const sum = exports.process(100)   // allocates an array each call
  memory.reset()                     // drop everything; heap ptr → 1024
}
```

After `memory.reset()` all previously returned pointers are invalid — read what you need first, then reset. For finer control, `memory.alloc(bytes)` returns a raw offset on the same pointer. Pure scalar modules (no heap values) compile without the allocator at all. The low-level export/encoding contract is in [Interop](#interop).

</details>

<details>
<summary><strong>How do I see and control inferred types?</strong></summary>

<br>

Inference is automatic and visible — there's nothing to annotate. jz reads the same signals you do: literals, operators (`x | 0` → i32), member access (`s.length` → string), `typeof` guards, assignment flow. Every local's chosen type shows up in `--wat`; anything ambiguous falls back to a NaN-boxed **f64** — always safe, never a wrong type.

**To pin a type, write code that implies it** — `x | 0` keeps `x` an i32; an `s = ''` default makes a string param. Annotations never make code faster (and `let x: number` isn't valid JS anyway); they'd only restate what inference already sees. JSDoc `@type` is planned as an advisory hint.

**Module globals** default to `i32` unless an assignment proves them fractional (a non-integer literal, `/`, `**`, a float-valued `Math.*`), so `mem[y*width + x]` compiles as a pure-i32 address with no per-access widening. A fraction landing in an integer global truncates — exactly as a fractional array index already does in JS.

</details>

<details>
<summary><strong>What optimizations are applied?</strong></summary>

<br>

jz emits tight WAT directly, then layers these (all on by default at `optimize: 2`):

- **Escape analysis** — short-lived objects/arrays never reach the heap.
- **Arena rewind** — a function proven not to leak heap values rewinds the bump pointer on return.
- **Type narrowing** — bitwise / counter / `Math.imul` / `charCodeAt` values stay on raw i32/f64 instead of the boxed-value path.
- **Typed-array fusion** — monomorphic typed-array access skips index dispatch and reuses computed addresses across a hot loop.
- **SIMD vectorization** — lane-pure array loops (`a[i] = f(a[i])`) lift to SIMD-128 (see next question).
- **Constant loop unroll** — small fixed-count loops unroll (biquad, mat4).
- **JSON specialization** — a constant `JSON.parse` source folds to a literal tree; a stable shape gets a generated shape-specific parser.
- **Host-import lowering** — `host: 'js'` lowers `console` / timers / clocks to small `env.*` imports instead of bundling WASI.

`--wat` shows the result; `npm run test:bench` pins every claimed win and wasm-size budget so a regression fails CI.

</details>

<details>
<summary><strong>How do I make a loop vectorize (SIMD)?</strong></summary>

<br>

The lane-local vectorizer (on at default `optimize: 2`) lifts inner loops of shape `for (let i = 0; i < N; i++) a[i] = f(a[i], …)` to SIMD-128 when the body is **lane-pure** — output `k` depends only on inputs at `k`.

- **Lifts:** in-place maps (`a[i] = a[i] * 2`), cross-array maps (`b[i] = a[i] * k + c`), structure-of-arrays (`zs[i] = xs[i]*a + ys[i]*b`, up to 4 bases), reductions (`s += a[i]`, `h ^= a[i]`, `|`, `&`).
- **Doesn't lift:** array-of-structures (interleaved `a[i*3]`, `a[i*3+1]` — split into one typed array per field), loop-carried scalars (`s ^= s << 13`), stencils (`a[i] = a[i] + a[i-1]`), unbounded loops, mixed lane types.

Check with `--wat`: a lift adds a `$__simd_loop<N>` block ahead of the scalar tail. No block ⇒ the recognizer bailed, usually on a loop-carried local or a non-`(base + i<<K)` address.

</details>

<details>
<summary><strong>Can I compile jz to C?</strong></summary>

<br>

Yes, via [wasm2c](https://github.com/WebAssembly/wabt/blob/main/wasm2c) or [w2c2](https://github.com/turbolent/w2c2):

```sh
jz program.js -o program.wasm
wasm-opt -O3 program.wasm -o program.opt.wasm   # trims redundant locals/loads first
wasm2c program.opt.wasm -o program.c
cc -O3 program.c -o program
```

The full native pipeline (jz → `wasm-opt -O3` → `wasm2c` → `clang -O3 -flto` + PGO) lands within a few percent of hand-tuned C — beating V8 on 19 of 21 bench cases on an M4 Max. Details and the regression gate live in [`scripts/native/README.md`](scripts/native/README.md).

</details>


## Performance

<img src="bench/bench.svg?v=0" alt="jz vs alternatives — geomean speed across the bench corpus" width="720">

<!-- FIXME: just make a link to dedicated bench page and show detailed perf there - make sure the table data here is covered there -->
<details>
<summary><strong>Benchmark</strong></summary>
<br>

| | jz | [Node](https://nodejs.org/) | [Porffor](https://github.com/CanadaHonk/porffor) | [AS](https://github.com/AssemblyScript/assemblyscript) | WAT | C | [Go](https://go.dev/) | [Zig](https://ziglang.org/) | [Rust](https://www.rust-lang.org/) | [NumPy](https://numpy.org/) |
|---|---|---|---|---|---|---|---|---|---|---|
| [biquad](bench/biquad/biquad.js) | 6.50ms<br>3.4kB | 12.35ms<br>3.2kB | fails | 9.03ms<br>1.9kB | 6.49ms<br>767 B | 5.30ms | 8.96ms<br>fma | 5.04ms | 5.27ms | 3.09s |
| [mat4](bench/mat4/mat4.js) | 2.74ms<br>3.3kB | 11.96ms<br>1.2kB | 88.68ms<br>2.4kB<br>diff | 9.32ms<br>1.6kB | 8.12ms<br>414 B | 2.76ms | 12.51ms | 2.74ms | 1.78ms | 389.44ms |
| [poly](bench/poly/poly.js) | 0.37ms<br>1.2kB | 2.32ms<br>1014 B | fails | 1.15ms<br>1.3kB | 0.81ms<br>359 B | 0.52ms | 0.80ms | 0.80ms | 0.57ms | 0.61ms |
| [bitwise](bench/bitwise/bitwise.js) | 1.40ms<br>1.2kB | 5.32ms<br>1005 B | fails | 12.13ms<br>1.5kB | 4.88ms<br>355 B | 1.30ms | 5.23ms | 4.16ms | 1.30ms | 14.77ms |
| [tokenizer](bench/tokenizer/tokenizer.js) | 0.10ms<br>1.7kB | 0.21ms<br>2.0kB | 0.41ms<br>3.2kB | 0.08ms<br>1.6kB | 0.10ms<br>344 B | 0.13ms | 0.08ms | 0.14ms | 0.12ms | 5.13ms |
| [callback](bench/callback/callback.js) | 0.03ms<br>1.4kB | 0.88ms<br>828 B | fails | 1.49ms<br>1.9kB | 0.25ms<br>267 B | 0.10ms | 0.20ms | 0.01ms | 0.09ms | 1.81ms |
| [aos](bench/aos/aos.js) | 1.62ms<br>1.8kB | 1.82ms<br>1.1kB | fails | 1.91ms<br>2.2kB | 1.07ms<br>481 B | 1.20ms | 0.90ms | 0.90ms | 1.20ms | 2.55ms |
| [mandelbrot](bench/mandelbrot/mandelbrot.js) | 12.55ms<br>1.0kB | 13.80ms<br>1.8kB | 13.47ms<br>3.0kB | 12.42ms<br>1.3kB | — | 12.26ms | 12.46ms | 12.31ms | 12.23ms | — |
| [json](bench/json/json.js) | 0.23ms<br>7.7kB | 0.38ms<br>1.2kB | fails | — | — | 0.21ms | 1.17ms | 0.69ms | 0.68ms | 1.20ms |
| [sort](bench/sort/sort.js) | 5.96ms<br>1.6kB | 11.13ms<br>1.6kB | fails | 10.22ms<br>1.9kB | — | 8.85ms | 10.36ms | 8.84ms | 9.37ms | 5.05ms |
| [crc32](bench/crc32/crc32.js) | 12.12ms<br>1.2kB | 13.43ms<br>1.8kB | 80.76ms<br>3.1kB | 12.19ms<br>1.4kB | — | 10.69ms | 9.30ms | 9.45ms | 9.38ms | 0.24ms |
| [watr](bench/watr/watr.js) | 1.56ms<br>144.4kB | 1.45ms<br>2.6kB | fails | — | — | — | — | — | — | — |


</details>


## Interop

Numbers cross the JS↔WASM boundary directly. Arrays of ≤ 8 elements come back as plain JS arrays (WASM multi-value); everything else is heap pointer.

```js
const { exports, memory } = jz`
  export let greet = (s) => s.length
  export let dist = (p) => (p.x * p.x + p.y * p.y) ** 0.5
  export let rgb = (c) => [c, c * 0.5, c * 0.2]
  export let process = (buf) => buf.map(x => x * 2)
`

// JS → WASM (write)
memory.String('hello')          // → string pointer
memory.Array([1, 2, 3])         // → array pointer
memory.Float64Array([1, 2])     // → typed array pointer (all TypedArray ctors available)
memory.Object({ x: 3, y: 4 })   // → object pointer (see warning)

// Call with pointers
exports.greet(memory.String('hello'))        // 5
exports.dist(memory.Object({ x: 3, y: 4 }))  // 5
exports.rgb(100)                              // [100, 50, 20] — direct JS array return
memory.read(exports.process(memory.Float64Array([1, 2, 3])))  // Float64Array [2, 4, 6]
```

<details>
<summary><strong>Interpolation</strong></summary>

<br>

Interpolated values are baked into the source at compile time — no post-instantiation allocation, no getter overhead. Numbers and booleans inline directly; strings, arrays, and objects compile as jz literals:

```js
jz`export let f = () => ${'hello'}.length`               // 5
jz`export let f = () => ${[10, 20, 30]}[1]`              // 20
jz`export let f = () => ${{name: 'jz', count: 3}}.count` // 3
```

Functions are imported as host calls. Non-serializable values (host objects, class instances) fall back to post-instantiation getters automatically.

</details>

<details>
<summary><strong>Host functions, constants, objects</strong></summary>

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
<summary>Environment</summary>

<br>

Two host modes select how runtime services lower. `host: 'js'` (default) imports small `env.*` services that `jz()` auto-wires; `host: 'wasi'` emits WASI Preview 1 for wasmtime/wasmer/deno.

| JS API | `host: 'js'` (default) | `host: 'wasi'` |
|---|---|---|
| `console.log()` | `env.print(val, fd, sep)` — host stringifies | WASI `fd_write` (fd=1), space-separated, newline |
| `console.warn`/`error` | same, fd=2 | WASI `fd_write` (fd=2) |
| `Date.now()` | `env.now(0) → f64` (epoch ms) | `clock_time_get` (realtime) |
| `performance.now()` | `env.now(1) → f64` (monotonic ms) | `clock_time_get` (monotonic) |
| `setTimeout`/`setInterval` | `env.setTimeout(cb, delay, repeat)` — host schedules; fires via `__invoke_closure` | WASM timer queue + `__timer_tick` |
| dynamic `obj.method()` | `env.__ext_call` (JS resolves) | error at compile time |

The compiled `.wasm` carries at most one import namespace — none, `env`, or `wasi_snapshot_preview1` — matching the mode above. `host: 'gc'` is reserved for a planned wasm-gc backend and errors today; pair `host: 'wasi'` with `strict: true` to also fail dynamic `obj[k]`/unknown-receiver calls at compile time.

A `host: 'wasi'` build emits only the WASI imports its lowerings use — `fd_write`, `fd_read`, `clock_time_get` (and `random_get` only with `{ randomSeed: true }`) — so it runs natively on wasmtime/wasmer/deno. For hosts without WASI (browsers, plain Node), `jz/wasi` provides a matching shim. That shim is scoped to what jz emits, **not** a general Preview 1 polyfill (`args_get`, `poll_oneoff`, `path_*`, … are absent) — run arbitrary WASI programs on a real runtime instead.

</details>

<details>
<summary><strong>Sharing memory across modules</strong></summary>

<br>

`jz.memory()` creates a shared memory that modules compile into. Schemas accumulate, so objects created in one module are readable by another:

```js
const memory = jz.memory()
const a = jz('export let make = () => { let o = {x: 10, y: 20}; return o }', { memory })
const b = jz('export let read = (o) => o.x + o.y', { memory })

b.exports.read(a.exports.make())  // 30 — same memory, merged schemas
memory.read(a.exports.make())     // {x: 10, y: 20} — JS reads it too
```

`jz.memory()` returns a real `WebAssembly.Memory` patched with `.read()`/`.String()`/`.Array()`/`.Object()`/`.write()`. Pass an existing one to wrap it: `jz.memory(new WebAssembly.Memory({ initial: 4 }))`. Modules sharing a memory share one bump allocator. Use `.instance.exports` for raw pointers, `.exports` for the JS-wrapped surface.

</details>

<details>
<summary><strong>Shipping <code>.wasm</code></strong></summary>

<br>

Compile once, then run the binary anywhere.

**JS host, no compiler.** `jz/interop` is a dependency-free bridge (only `wasi.js`) that knows the value encoding, so bundlers tree-shake the compiler, parser, and watr out entirely:

```js
import { instantiate } from 'jz/interop'
import wasmBytes from './program.wasm'   // bundler-specific; or fetch(...)

const { exports, memory } = instantiate(wasmBytes)
exports.greet(memory.String('hello'))    // marshal works exactly as at compile time
```

`instantiate(wasm, opts?)` accepts `Uint8Array`, `ArrayBuffer`, or a prebuilt `WebAssembly.Module` and returns the same `{ exports, memory, instance, module }` shape as the `jz(src)` tag — same `memory.String/Array/Object/...` constructors, same `memory.read(ptr)` decoder.

**Native runtimes.** Compile with `host: 'wasi'` and run on any WASM runtime:

```sh
jz program.js --host wasi -o program.wasm
wasmtime program.wasm     # also `wasmer run` / `deno run`
```

Pure numeric modules have no imports and instantiate with standard `WebAssembly.Module`/`Instance` — the right shape for JS hosts such as EdgeJS. Compile at startup or build time and reuse the module; don't compile jz source per request.

**Memory ABI (non-JS hosts).** The allocator is exposed as two exports:

```
(func $_alloc (param $bytes i32) (result i32))   ;; returns heap offset
(func $_clear)                                    ;; rewinds heap pointer to 1024
```

`memory.alloc()`/`memory.reset()` are JS aliases for these. Headers vary by type: strings store `[len:i32]` + utf8 bytes (offset = `_alloc(4+n) + 4`); arrays / typed arrays / objects store `[len:i32, cap:i32]` + payload (offset = `_alloc(8+bytes) + 8`). The boundary pointer is the f64 NaN-box `0x7FF8 << 48 | type << 47 | aux << 32 | offset` — see [`src/host.js`](src/host.js) for type codes and the canonical encoders. Strip both exports with `compile(code, { alloc: false })` if you only call functions and never marshal heap values across the boundary.

</details>

<details>
<summary><strong>Zero-copy strings</strong></summary>

<br>

Strings have two boundary carriers; the compiler picks per export-param:

| carrier | when | what crosses | per-call cost |
|---|---|---|---|
| **f64 / SSO** (default) | every param unless the narrower can prove it is used purely as a string | a NaN-boxed `f64` → UTF-8 bytes in linear memory; ≤4 ASCII chars inline in the NaN payload (SSO) | one `_alloc` + memcpy |
| **externref / `wasm:js-string`** | param uses only `.length`/bounded `.charCodeAt(i)`, isn't reassigned/captured/escaped, *and* has either a `.charCodeAt` use, call-site STRING evidence, or a `s = ''` default | the JS string itself, by reference | **zero** — lowers to [`wasm:js-string`](https://github.com/WebAssembly/js-string-builtins/blob/main/proposals/js-string-builtins/Overview.md) builtins the engine inlines |

```js
const { exports } = jz`
  // Opt-in fires: .charCodeAt in a bounded loop discriminates string.
  export let sum = (s) => { let n = 0; for (let i = 0; i < s.length; i++) n += s.charCodeAt(i); return n }
  // Opt-in fires: 's = ""' default declares string intent.
  export let len = (s = '') => s.length
  // Opt-in declines: '+' isn't a builtin; param escapes into the f64 op.
  export let label = (s) => s + ' (ok)'
`
exports.sum('hello')   // 532 — JS string passed by reference
exports.len()          // 0   — default substituted JS-side
exports.label('test')  // 'test (ok)' — memory-backed string, as before
```

**Why `.length`-only doesn't flip.** `.length` also reads arrays and typed arrays, so keeping it on f64 preserves that tolerant polymorphism — flipping would trap on non-strings. **Why bounded loops matter.** `wasm:js-string.charCodeAt` **traps** out of range where JS returns `NaN`, so the narrower proves `i < s.length` before flipping.

Native `wasm:js-string` lands in V8 17+ (Chrome 134+, Node 25+ via the `{ builtins: ['js-string'] }` Module option), Safari 18.4+, Firefox behind a flag. `jz/interop` probes the engine and either passes the option for native inlining or attaches a JS polyfill — either way the boundary string-copy is saved. Opt out with `optimize: { jsstring: false }`. Bench: `node bench/jsstring/bench-jsstring.mjs`.

</details>

<details>
<summary><strong>Custom sections</strong></summary>

<br>
<!-- FIXME: is this true? Do we really need all these sections? Aren't they just low-level machinery, who needs to know it? And actually - can we not export these sections, simplify exports? -->
jz embeds four small WebAssembly custom sections so the JS interop layer can wire boundary ABIs without re-parsing the source. They're inert for non-JS hosts (wasmtime/wasmer ignore unknown customs); `interop.js` reads them once at instantiate-time. You don't need to touch them — they're documented so external tools (linkers, custom loaders, devtools) can read them safely.

| Section | Purpose |
|---|---|
| `jz:schema` | Object schemas for exported records — JS rehydrates plain objects from boundary writes without per-call shape inference. |
| `jz:rest` | Per-export rest-parameter info (`{ name, fixed }`) — tells JS how many fixed args precede the rest array so the wrapper packs the tail correctly (covers aliased re-exports). |
| `jz:i64exp` | Per-export i64-ABI map — marks slots where pointers cross as i64 (dodging V8's NaN canonicalization) instead of f64. |
| `jz:extparam` | Per-export externref-param positions — args that skip NaN-boxing (the jsstring carrier writes here), with `d` carrying `= ''` defaults. |

Names are stable; binary layouts are not — re-derive from the latest `interop.js` if you parse them yourself.

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
</table>


## Alternatives

```
  runs any JS │  javy ●       ● jawsm
  (full spec) │
              │                    ● porffor
              │
   how much   │
   JS runs    │                              ● jz
   unchanged  │
              │                              ● AssemblyScript ¹
   a subset / │
   rewrite    └──────────────────────────────────────────────▶
               interpreter      bundled rt      AOT → native,
               + large wasm      + JIT          tiny wasm
                         faster · smaller output →
```
<!-- FIXME: axes here must be speed, size vs compatibility -->

* [porffor](https://github.com/CanadaHonk/porffor) — ahead-of-time JS→WASM compiler targeting full TC39 semantics. Implements the spec progressively (test262). Where jz restricts the language for performance, porffor aims for completeness.
* [assemblyscript](https://github.com/AssemblyScript/assemblyscript) — TypeScript-subset compiling to WASM — small, performant output, but requires type annotations.
* [jawsm](https://github.com/drogus/jawsm) — JS→WASM compiler in Rust. Compiles standard JS with a runtime that provides GC and closures in WASM.
* [javy](https://github.com/bytecodealliance/javy) — embeds the QuickJS engine in the module and *interprets* your source. Runs almost any JS, but ships a whole interpreter (large binary, interpreter speed) — the opposite trade from jz's AOT-compiled native WASM for a JS subset.


## Build with

* [subscript](https://github.com/dy/subscript) — JS parser. Minimal, extensible, builds the exact AST jz needs without a full ES parser. Jessie subset keeps the grammar small and deterministic.
* [watr](https://www.npmjs.com/package/watr) — WAT to WASM compiler. Handles binary encoding, validation, and peephole optimization. jz emits WAT text, watr turns it into a valid `.wasm` binary.


<p align=center>MIT • <a href="https://github.com/krishnized/license/">ॐ</a></p>
