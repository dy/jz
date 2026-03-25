## [x] Vision

**jz = JS as it should have been → WASM**

Not "JS compatibility". Not "JS subset". JavaScript Zero — Crockford's Good Parts realized.

| JS | jz |
|----|-----|
| Implicit `Math.sin` | `import { sin } from 'math'` |
| `var`, hoisting | `let`, `const` only |
| `function`, `this` | Arrow functions only |
| `class`, `new Foo()` | Plain objects, composition |
| `==` coercion | `==` means `===` |
| Runtime errors | Compile-time errors |

**What jz is**: Explicit over implicit. Functional over OOP. Compile-time over runtime. Native speed (WASM).
**What jz is not**: Not trying to run arbitrary JS. Not competing on compatibility. Not a transpiler (output is WASM, not JS).

The offering is not jz itself. The offering is: floatbeat (audio playground), mridanga tools (practice instruments), piezo (music DSL), color-space/wasm, digital-filter/wasm.

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
  * _Zero overhead_ – no runtime type checks, functions monomorphized per call-site.
  * _JS interop_ – export/import, preserve func signatures at WASM boundary.
  * _JS compat_ – any jz is valid js (with [limitations](./docs.md#limitations-divergences))
  * Simple, but extensible (like subscript)
  * Lightweight, but versatile
  * Transparent, but clever
  * Uncompromised performance.

## [x] Applications -> Audio/DSP, real-time compute

  * Web-audio-api worklets (latency-critical, no GC pauses)
  * Floatbeats/bytebeat generators
  * Color-space conversions (scalar math + tuples)
  * Digital filter DSP (array processing, in-place mutation)
  * Game physics/math kernels
  * Embedded scripting (IoT, microcontrollers)
  * Plugin systems (safe sandboxed compute)

## [x] Alternatives

  ### JS/TS → WASM compilers (direct competitors)

  | Project | Approach | Pointers | Interop | WASI/Env |
  |---------|----------|----------|---------|----------|
  | porffor | AOT JS→WASM | Custom | Custom imports | No WASI, "mostly unusable standalone" |
  | jawsm | JS→WASM GC | WASM GC refs | WASIp2 polyfill | Requires Node v23+ |
  | assemblyscript | TS-like→WASM | Linear memory | wasm-bindgen style | wasi-shim |
  | javy | QuickJS embedded | QuickJS internal | Javy.IO | WASI fd_read/write |

  ### Other langs → WASM (similar challenges)

  | Project | Lang | Pointers | Interop | WASI/Env |
  |---------|------|----------|---------|----------|
  | emscripten | C/C++ | Native | JS glue | WASI + glue |
  | wasm-bindgen | Rust | Linear | JS bindings gen | wasm-pack |
  | grain | Grain | WASM GC | Grain runtime | Custom |
  | tinygo | Go | Linear | JS/WASI | WASI |
  | kotlin/wasm | Kotlin | WASM GC | Kotlin/JS | WASIp2 |
  | moonbit | MoonBit | WASM GC | JS FFI | WASI |

  ### Key patterns

  1. **Pointer strategies**: Linear memory (emscripten, AS, jz) vs WASM GC (jawsm, kotlin, moonbit)
  2. **JS interop**: Glue code (emscripten) vs bindgen (Rust) vs manual (jz)
  3. **GC compilers converging on WASM GC**: kotlin, dart, moonbit
  4. **Interpreter vs AOT**: QuickJS-based (javy) vs direct compile (porffor, jz)

  jz differentiator: minimal core (<2K lines), zero runtime, pure functional subset, module-extensible.

## [x] Arrays -> Three explicit ABI profiles

  Mainline profiles (explicitly chosen, not inferred across modes):

  0. **Scalar** (current) — all f64 params/returns. Single-value math.
  1. **Multi** — all f64 params, multi-value f64 returns. Tuples, color-space.
  2. **Memory** — f64 + i32 pointer params, shared linear memory. Array processing, DSP.

  Memory mode is a real ABI change (i32 params, f64.load/store), not a module drop-in.
  Multi-value extends scalar (return arity only, no input signature change).

  * Decision: multi-value default for tuples. Memory explicit for array processing.
    GC is research — not in mainline until multi+memory are proven.
    See plan.md for details.

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

## [ ] Pointers -> revisit for new arch

  Old arch used NaN-boxing: 51-bit payload `[type:4][aux:16][offset:31]` in f64.
  New arch is currently f64-only (no pointers yet).

  Options for new arch:
  0. **No pointers** (scalar-only mode) — sufficient for color-space
  1. **i32 pointers** (memory mode) — for array processing, explicit in function signature
  2. **NaN-boxing** (full mode) — for mixed scalar/pointer in same f64 slot
  3. **GC refs** (gc mode) — WASM GC manages lifetime

  Decision deferred until Phase 2 (shared memory) in plan.md.
  For Phase 0-1, everything is f64 scalars — no pointers needed.

## [ ] Internal calling convention -> revisit

  Old decision: internal functions use i32 offsets, box only at JS boundary.
  Still valid conceptually but implementation depends on pointer strategy.
  Deferred until pointer decision is made.

## [x] Types -> Monomorphic

  * All types resolved at compile-time
  * No runtime type checks, no polymorphic dispatch
  * Functions monomorphized per call-site
  * Static analysis enables direct WASM ops (i32.add vs f64.add)

## [x] Boxed primitives -> Object.assign pattern (backlog)

  Valid design for attaching metadata to primitives. Backlogged — not needed for DSP use cases.

## [x] TypedArrays -> pointer-embedded metadata (backlog)

  Valid design for typed array views. Backlogged — Phase 2 (shared memory) may use simpler approach:
  just pass i32 offset + i32 length, let JS manage typed array views.

## [x] Ring arrays -> auto-promote on shift/unshift (backlog)

  Valid optimization. Backlogged — not needed for initial DSP use cases.

## [x] Pointer kinds -> NaN-boxing with type encoding (old arch, archived)

  Detailed NaN-boxing design with 7 pointer types (ATOM, ARRAY, TYPED, STRING, OBJECT, CLOSURE, REGEX).
  This was the old architecture's approach. New arch starts fresh — may use simpler scheme or GC refs.
  Preserved in git history for reference.

## [ ] Stdlib sources

  * [Metallic](https://github.com/jdh8/metallic) (C math)
  * [Piezo](https://github.com/dy/piezo/blob/main/src/stdlib.js) (WAT math)
  * [AssemblyScript musl](https://github.com/AssemblyScript/musl/tree/master) (C stdlib)

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

## [ ] Objects / Arrays JS interop -> revisit

  Old decision: `view()` helper with `_schemas` export.

  Prior art patterns:
  1. **Copy at boundary** (wasm-bindgen) — safest, overhead per call
  2. **Memory view** (embind, AS loader) — zero-copy, invalidates on grow
  3. **Packed pointer** (Go wasip1) — ptr+len in single i64
  4. **WASM GC** (Grain, Kotlin) — native GC structs, direct JS interop

  New arch approach depends on array convention (see plan.md):
  - memory mode → JS provides Float64Array view on shared memory
  - gc mode → direct JS object access via WASM GC
  - multi mode → JS receives multiple return values

## [ ] Host APIs (console, Date, performance) -> WASI + shim

  * WASI as primary interface
  * wasmer/wasmtime: native support
  * Browser/Node: WASI shim

  | JS API | WASI Function |
  |--------|---------------|
  | console.log | fd_write(1, ...) |
  | console.error | fd_write(2, ...) |
  | Date.now() | clock_time_get(realtime) |
  | performance.now() | clock_time_get(monotonic) |

## [ ] Metacircular (jz.wasm) -> WASI

  * jz compiling itself to WASM
  * Uses WASI for I/O (fd_read/write for source, fd_write for output)
  * Future goal — requires jz to be expressive enough to self-host

## [ ] Compile API -> revisit

  Old decision: return `{binary, wat}` + watr options.
  Current implementation: return binary by default, `{ wat: true }` for text.
  Simple and sufficient. Revisit if users need both formats simultaneously.

## [x] Pluggable architecture -> Modules extending ctx.emit

  Current implementation: modules are JS functions that receive `ctx` and register:
  - `ctx.emit[name]` — custom emitters (AST → WASM IR)
  - `ctx.stdlib[name]` — WAT function definitions
  - `ctx.includes` — marks stdlib for inclusion

  This pattern is proven (math module works fully). Core stays minimal, capabilities grow through modules.

  Future vision (from old arch): modules as regular JS/JZ files importing from `'jz:core'`:
  ```js
  import { inline, wat } from 'jz:core'
  inline('sin', x => `(call $__sin ${x})`)
  wat(`(func $__sin (param $x f64) (result f64) ...)`)
  ```
  Backlogged — current `ctx.emit` pattern is simpler and sufficient.
