## [x] Vision & goal

> **jz = JS as it should have been → WASM**

> Crockford's Good Parts realized. Explicit > implicit. Functional > OOP. Compile-time > runtime. Native speed.

Compact, clean, tight functional JS subset, compiling to minimal, meaningful, optimal WASM. Design incorporates clever, elegant and innovative, but reliable solutions. It fits in a browser and enables highly performant live compilation.
It blocks garbage and bs from JS - historical artifacts and regrets, bad practices. It enforces good JS style by its own design, so that linters are not needed. Any JZ code is automatically good JS code. It encourages best practices by design.
Error messages are very user friendly and guiding, failing at proper times.
The internal implementation is clever, clean, elegant, innovative.
The language brings feeling of performance in timeless manner.
It enables easy gateway from JS to low-level world, not simply isolate WASM.
Anyone who uses JZ gets access to world of low-level machinery (gateway through C or WASI I suppose?)

**What would be paradigm shift that would unlock a new value?**
Functional JS subset → minimal WASM. Fits in a browser, compiles in real-time.
Excludes JS misfeatures (coercions, hoisting, `this`, classes). Valid jz = valid JS. No linter needed — bad patterns don't parse.
Errors fail early with actionable messages.
Gateway from JS to low-level: WASM, WASI, native via wasm2c.

## [x] Mission

  **Purpose**: Give JS developers direct access to native-speed computation without leaving their language.
  **Activity**: Compile a functional JS subset to minimal WASM — statically, in real-time, with zero runtime.
  **Values**: Correctness by design, transparency of execution, zero overhead.

  > JS developer writes functions → gets native-speed WASM. No new language, no toolchain, no runtime.

## [x] Principles (basis of reasoning)

  1. **Compile-time over runtime** — resolve everything statically. No runtime dispatch, no type checks, no GC. What can be known at compile time must be.
  2. **Explicit over implicit** — no coercions, no hoisting, no magic. Code means what it says.
  3. **Functional over OOP** — functions are the unit of composition. No classes, no `this`, no inheritance. Data is plain, behavior is functions.
  4. **Constraint enables performance** — every limitation unlocks a zero-cost guarantee. Document the tradeoff.
  5. **Uniform representation** — one convention (f64 everywhere, NaN-boxing) beats type-specific optimizations. Simplicity at boundary > micro-optimization inside.
  6. **Minimal core, extensible surface** — core compiles pure compute. Everything else (arrays, strings, objects) is a module. Capabilities grow without core growth.
  7. **Host resolves, compiler transforms** — no I/O in compilation. Resolution is the host's job. Compilation is a pure function.

## [x] Values (what matters most)

  1. **Performance without ceremony** — native speed from plain JS knowledge. No annotations, no toolchains.
  2. **Correctness by design** — bad patterns don't compile. The language is the linter.
  3. **Transparency** — no hidden allocations, no implicit copies. What you write is what runs.
  4. **Immediacy** — compilation is interactive, not a build step.
  5. **Tiny footprint** — kilobytes, not megabytes. No runtime, no wrappers.
  6. **Elegance** — compiler itself is minimal and clean. <2K lines.

## [x] Key audiences (NICE)

  1. **Audio/DSP developers** (primary)
     - _Needs_: real-time processing, no GC pauses
     - _Interests_: JS syntax for compute kernels, worklet-ready output
     - _Concerns_: latency, deterministic execution
     - _Expectations_: replaces hand-written DSP with JS

  2. **JS developers wanting performance**
     - _Needs_: native speed for hot paths
     - _Interests_: no learning curve, instant compilation
     - _Concerns_: constraints, JS divergences
     - _Expectations_: write JS → get WASM

  3. **Embedded / plugin developers**
     - _Needs_: small sandboxed compute modules
     - _Interests_: kilobyte output, no runtime
     - _Concerns_: output size, security boundary
     - _Expectations_: WASM for microcontrollers and browsers

  4. **Creative / live coders**
     - _Needs_: real-time compilation during performance
     - _Interests_: in-browser compile, instant feedback
     - _Concerns_: compilation speed, expressiveness
     - _Expectations_: compile-on-keystroke

## [x] Paradigm shift -> WASM as live medium, not build artifact

  Current WASM workflow: write Rust/C → compile offline → load binary → deploy.
  jz workflow: write JS → compile in browser → instant native code.

  * WASM as interaction medium, not deployment format
  * Live-coding native audio/visuals in JS
  * User-generated native compute (sandboxed)
  * Hot-swappable compute kernels (no reload)
  * WASM as REPL target
  * Scripting = compiling (same act)

## [x] Anti-goals (what jz refuses to be)

  * Not a general-purpose language — no DOM, no async, no event loop
  * Not a JS runtime — no eval, no dynamic import, no reflection
  * Not aiming for 100% JS compat — subset by design, divergences documented
  * Not a build tool — no bundling, no tree-shaking, no source maps
  * Not an optimizing compiler — direct translation, WASM engine optimizes
  * Not a type system — types inferred from usage, never annotated

## [x] Success criteria (how we know it works)

  * Compilation < 1ms in browser for typical module
  * Output smaller than equivalent C via emscripten
  * Compiler < 2K lines, zero dependencies
  * Any jz program runs identically as JS (within documented divergences)
  * Audio worklet: zero GC pauses, stable real-time output
  * Cold start: parse + compile + instantiate < 5ms

## [x] Positioning (why jz, not alternatives)

  Others compile JS (or JS-like) to WASM. jz is different in kind, not degree:
  * **vs porffor/jawsm**: they target full JS semantics → runtime overhead, GC. jz targets a subset → zero runtime.
  * **vs assemblyscript**: separate language with JS-like syntax. jz code IS valid JS.
  * **vs javy**: embeds QuickJS interpreter in WASM. Interpreter overhead. jz compiles to native WASM ops.
  * **vs emscripten**: C/C++ toolchain. Different language, massive output. jz is JS-native.
  * The argument: jz trades JS completeness for something no alternative offers — zero-overhead WASM from JS syntax, compilable in the browser, in real-time.

## [x] Name -> jz

  * jz
    + java zcript
    + js zero
    + jazz

## [x] Qualities

  * _Lightweight_ – embed anywhere, from websites to microcontrollers.
  * _Fast_ – compiles to WASM faster than `eval` parses.
  * _Tiny output_ – no runtime, no heap, no wrappers.
  * _Zero overhead_ – no runtime type checks, monomorphized per call-site.
  * _JS interop_ – export/import, preserve func signatures at WASM boundary.
  * _JS compat_ – any jz is valid js (with [limitations](./docs.md#limitations-divergences))
  * Simple, but extensible (like subscript)
  * Lightweight, but versatile
  * Transparent, but clever
  * Uncompromised performance.


## [x] Applications -> Audio/DSP, real-time compute

  * Digital filter DSP (array processing, in-place mutation)
  * Web-audio-api worklets (latency-critical, no GC pauses)
  * Floatbeats/bytebeat generators
  * Color-space conversions (scalar math + tuples)
  * Game physics/math kernels
  * Embedded scripting (IoT, microcontrollers)
  * Plugin systems (safe sandboxed compute)


## [x] Alternatives

  | Project | Approach | Interop |
  |---------|----------|---------|
  | porffor | AOT JS→WASM | Custom, also has C target |
  | jawsm | JS→WASM GC | WASIp2, requires Node v23+ |
  | assemblyscript | TS-like→WASM | wasm-bindgen style |
  | javy | QuickJS embedded | WASI fd_read/write |
  | emscripten | C/C++→WASM | JS glue |
  | grain/kotlin/moonbit | Lang→WASM GC | Native GC interop |

  jz differentiator: minimal core (<2K lines), zero runtime, pure functional subset, module-extensible.

## [x] Closures -> Capture by value + explicit env param

  * Capture by value: zero runtime cost for immutable captures
  * Mutable captures disallowed (compile error)
  * Implementation: funcIdx + env pointer (call_indirect with env as first param)
  * Slight divergence from JS (documented)
  * Sufficient for functional patterns (currying, callbacks)

## [ ] Floating point precision -> Compile-time rational simplification

  * Zero runtime cost
  * Exact arithmetic for constant expressions (`1/3 * 3 = 1`, `1/10 + 2/10 = 0.3`)
  * Falls back to f64 for dynamic values
  * Overflow falls back to f64

## [x] Data representation -> NaN-boxed f64 everywhere

  ### Decision: NaN-boxing for all pointers, internal and external

  Everything is f64. Scalars are regular f64/i32. Pointers are NaN-encoded f64.
  No wrapping layers, no export adapters, no mixed signatures. Simplest design.

  | Data | Representation |
  |------|---------------|
  | Scalars | f64 or i32 (type-coerced by operator) |
  | Pointers (arrays, objects, strings) | NaN-boxed f64 (type+aux+offset in quiet NaN) |
  | Tuple returns | Multi-value `(result f64 f64 f64)` |

  **Cost**: extracting i32 offset from NaN = 3 register ops (~1 cycle), once per function entry.
  Cached in i32 local — loop body is pure i32 arithmetic. Negligible.

  **Benefit**: uniform f64 signatures everywhere. No wrapper generation. No param type analysis.
  JS passes/receives plain numbers. Polymorphism for free (param can be number or pointer).

  Both sides of the boundary (JS and WASM) follow the same convention: read/write memory
  at the offset encoded in the NaN payload. JS uses typed array views on exported memory.

  ### WASM GC: not viable for JS boundary

  Tested: GC structs and arrays are **opaque from JS** — no field access, no indexing.
  `p[0]` → undefined. Only accessor functions work. The `gc-js-customization` proposal
  exists but no engine implements it. GC types only useful for WASM↔WASM.

  ### Return convention: multi-value vs pointer

  **Array literal return** → multi-value (tuple). Compile-time known length.
  ```js
  return [a, b, c]  // → (result f64 f64 f64), JS gets real Array
  ```

  **Variable/dynamic array return** → NaN-boxed pointer to memory.
  ```js
  return arr         // → (result f64), NaN-boxed pointer
  ```

  Heuristic: `return [expr, expr, ...]` with literal brackets = multi-value.
  Everything else = single f64 return (scalar or pointer).

  ### NaN-boxing pointer layout

  Quiet NaN format: `0x7FF8_xxxx_xxxx_xxxx` — 51-bit payload.
  Layout: `[type:4][aux:15][offset:32]`. 16 types, each with ONE layout (no flags).
  Type dispatch handles everything — no extra branches, no conditional interpretation.

  Principle: aux holds IMMUTABLE metadata only. Mutable state (length, size) in memory.
  Aliases see mutations. C-style: header + data contiguous.

  | Type | Name | aux (15 bits) | offset → | Memory layout |
  |------|------|---------------|----------|---------------|
  | 0 | ATOM | kind | id | none |
  | 1 | ARRAY | 0 | data start | `[-8:len(i32)][-4:cap(i32)][elem0:f64, ...]` |
  | 2 | (free) | | | |
  | 3 | TYPED | elemType:3 | data start | `[-8:len(i32)][-4:cap(i32)][bytes...]` |
  | 4 | STRING | 0 | data start | `[-4:len(i32)][chars:u8...]` |
  | 5 | STRING_SSO | len | packed chars | none (≤4 ASCII inline) |
  | 6 | OBJECT | schemaId | data start | `[prop0:f64, prop1:f64, ...]` |
  | 7 | (free) | | | |
  | 8 | SET | 0 | table start | `[-8:size(i32)][-4:cap(i32)][entries...]` |
  | 9 | MAP | 0 | table start | `[-8:size(i32)][-4:cap(i32)][entries...]` |
  | 10 | CLOSURE | funcIdx | env start | `[env0:f64, env1:f64, ...]` |
  | 11 | REGEX | flags | — | `[-8:lastIdx]` if g |
  | 12-15 | (free) | | | |

  Key properties:
  - 4GB addressable (32-bit offset), type extractable with 3 bit ops
  - **One layout per type** — no flags, no subtypes. "Parse, don't validate" for pointers.
  - **Heap length** — mutable len/cap in memory header. Aliases see mutations. C-style.
  - ATOM/STRING_SSO need zero memory allocation
  - 4 free slots for future (Promise, Iterator, ArrayBuffer, etc)

  **vs Go/Rust**: Go/Rust are statically typed — no runtime type bits needed. jz needs them
  because a single f64 param could be number/array/string/object (JS polymorphism).
  NaN-boxing is the cheapest way to pay it.

## [x] Allocator -> for linear memory, pluggable

  | Strategy | Alloc | Free | Best for |
  |----------|-------|------|----------|
  | **Bump** (default) | Increment pointer | `_reset()` all | DSP, batch processing |
  | **Free list** | malloc | free(ptr) | Mixed lifetimes |
  | **Refcount** | alloc | auto on rc=0 | Shared structures |
  | **External** | Host provides | Host frees | Embedded, plugins |

  Contract: `_alloc(bytes) → i32`, `_reset()` or `_free(ptr)`. Implementation swappable.

## [x] Imports -> Pre-bundled source + primitives-only linking

  ### Resolution
  - **Resolution** = host responsibility (JS/Node/WASI)
  - **Compilation** = JZ responsibility (pure transform, no I/O)
  - CLI: fs + importmap.json
  - API: `modules` option (pre-resolved sources)
  - WASM API: pre-bundled source format (single string with `//!jz:module` markers)

  ### Multi-module
  - Primary: bundle into single WASM (shared memory, full types)
  - Optional: primitives-only linking (for numeric leaf modules like DSP kernels)
  - Circular imports: prohibited (Jessie-style)
  - Exports: named + re-export, no default exports
  - Bare specifiers: importmap (CLI), relative paths required in source

## [x] Types -> i32/f64 by operator, monomorphic

  * `1` → i32, `1.0` → f64. Operators preserve i32 when both operands i32.
  * `/`, `**` always f64. Bitwise always i32. Comparisons always i32.
  * Variables typed by pre-analysis: if any assignment is f64, local is f64.
  * All types resolved at compile-time. No runtime dispatch.

## [x] Pointers -> i32 internal, boundary wraps (see Data representation above)

## [x] Imports -> Pre-bundled source, primitives-only linking

  * Resolution = host responsibility. Compilation = jz responsibility (no I/O).
  * CLI: fs + importmap. API: `modules` option. WASM: pre-bundled format.
  * Bundle into single WASM (default). Primitives-only linking for numeric leaf modules.
  * Circular imports prohibited. Named exports + re-export.

## [ ] Host APIs -> WASI + shim

  | JS API | WASI Function |
  |--------|---------------|
  | console.log | fd_write(1, ...) |
  | Date.now() | clock_time_get(realtime) |
  | performance.now() | clock_time_get(monotonic) |

## [ ] Native binary -> WASM is the IR

  ```
  JS → jz → .wasm → wasm2c/w2c2 → .c → gcc/clang → native
  ```

  No custom C backend needed. WASM IS the portable IR. Our i32/f64 type system
  directly improves native perf (wasm2c translates instruction-by-instruction).

  | Tool | Pipeline | Notes |
  |------|----------|-------|
  | **w2c2** | WASM → C89 | Smallest (150KB), C89 compat |
  | **wasm2c** (WABT) | WASM → C99 | Official, well-tested |
  | **wasmer create-exe** | WASM → native | One command, cross-compile |

## [ ] Metacircular (jz.wasm) -> WASI

  Future: jz compiling itself to WASM. Requires jz to be expressive enough to self-host.

  * jz compiling itself to WASM
  * Uses WASI for I/O (fd_read/write for source, fd_write for output)
  * Future goal — requires jz to be expressive enough to self-host

## [x] Pluggable architecture -> Modules extending ctx.emit

  Modules register on ctx: `ctx.emit[name]` (emitters), `ctx.stdlib[name]` (WAT),
  `ctx.includes` (lazy inclusion). Core stays minimal, capabilities grow through modules.

## [ ] Stdlib sources

  * [Metallic](https://github.com/jdh8/metallic), [Piezo](https://github.com/dy/piezo/blob/main/src/stdlib.js), [AS musl](https://github.com/AssemblyScript/musl/tree/master)

## Backlog (old arch, archived)

  * Boxed primitives (Object.assign pattern)
  * TypedArray pointer-embedded metadata
  * Ring arrays (auto-promote on shift/unshift)
  * NaN-boxing pointer kinds (7 types)
  * Compile-time rational simplification
