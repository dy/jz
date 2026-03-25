## [x] Vision

**jz = JS as it should have been → WASM**

Crockford's Good Parts realized. Explicit > implicit. Functional > OOP. Compile-time > runtime. Native speed.

The stack:
```
┌─────────────────────────────────────┐
│  mridanga / floatbeat / piezo       │  ← offerings
├─────────────────────────────────────┤
│            jz                       │  ← JS done right → WASM
├─────────────────────────────────────┤
│     subscript │ watr                │  ← parse │ assemble
└─────────────────────────────────────┘
```

## [x] Name -> jz

  * jz
    + java zcript
    + js zero
    + jazz

## [x] Goals

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

## [x] Floating point precision -> Compile-time rational simplification

  * Zero runtime cost
  * Exact arithmetic for constant expressions (`1/3 * 3 = 1`, `1/10 + 2/10 = 0.3`)
  * Falls back to f64 for dynamic values
  * Overflow falls back to f64

## [x] Data representation -> internal vs boundary

  ### Core insight

  Internally, always fastest. The only question is the JS↔WASM export boundary.

  | Data | Internal | Why |
  |------|----------|-----|
  | Scalars | i32/f64 by operator | Direct WASM ops |
  | Tuples | Multi-value | Zero allocation |
  | Arrays/objects | Linear memory, i32 offset | No GC, deterministic |

  ### Exported functions are boundary wrappers

  Internal function is always the same. Export is a thin adapter:
  ```
  Internal:  $process(ptr: i32, len: i32)        ← always memory, fast
  Export:    (export "process") → passthrough     ← memory pointer boundary
  GC export: (export "process") → unwrap GC→mem  ← GC boundary adapter
  ```
  Single option `{ gc: true }` generates GC adapter wrappers around exports.
  No option = memory pointer boundary (default, zero overhead).

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

## [x] Pointers -> i32 offsets (internal), boundary wraps

  Internal functions use i32 offsets for arrays/objects. No NaN-boxing in new arch.
  Export wrappers handle JS boundary (memory pointer or GC wrapper).
  Old NaN-boxing design preserved in git history for reference.

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
