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

## [x] Uniqueness

> The uniqueness is already real and measured: type inference from plain JS (no annotations — AS can't say this), auto-SIMD, single-digit-kB output, a pure synchronous compiler that runs in the browser in milliseconds (Porffor fundamentally can't compile-on-the-fly like this), self-hosting, and the native pipeline that beats V8. Nobody else has that combination.

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
  8. JS compat - reduced boundary friction.

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
    * jz output ≤ hand-written. Pure scalar = identical. Loops = ≤5% overhead.
  * _Zero overhead_ – no runtime type checks, monomorphized per call-site.
  * _JS interop_ – export/import, preserve func signatures at WASM boundary.
  * _JS compat_ – any jz is valid js with limitations.
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
  | 2 | BUFFER | 0 | bytes start | `[-8:byteLen(i32)][-4:byteCap(i32)][bytes...]` (ArrayBuffer / DataView passthrough) |
  | 3 | TYPED | elemType:3 ∣ view:1 | data start / descriptor | **Owned** (`aux & 8 == 0`): `[-8:byteLen(i32)][-4:byteCap(i32)][bytes...]` — shares BUFFER header; `__len = byteLen >> log2(stride)`. Reinterpret `new T(buf)` is a zero-copy view (same offset, shared header). **Subview** (`aux & 8 == 8`, i.e. `new T(buf, off, len)`): offset points to 16-byte descriptor `[0:byteLen(i32)][4:dataOff(i32)][8:parentOff(i32)][12:pad]`. Reads/writes alias the parent; `.buffer = BUFFER@parentOff`, `.byteOffset = dataOff - parentOff`. |
  | 4 | STRING | 0 | data start | `[-4:len(i32)][chars:u8...]` |
  | 5 | STRING_SSO | len | packed chars | none (≤4 ASCII inline) |
  | 6 | OBJECT | schemaId | data start | `[prop0:f64, prop1:f64, ...]` |
  | 7 | HASH | 0 | table start | `[-8:size(i32)][-4:cap(i32)][entries...]` (string-keyed, FNV-1a) |
  | 8 | SET | 0 | table start | `[-8:size(i32)][-4:cap(i32)][entries...]` |
  | 9 | MAP | 0 | table start | `[-8:size(i32)][-4:cap(i32)][entries...]` |
  | 10 | CLOSURE | funcIdx | env start | `[env0:f64, env1:f64, ...]` |
  | 11 | EXTERNAL | 0 | extMap idx | none (host JS ref table) |
  | 12-15 | (free) | | | |

  Key properties:
  - 4GB addressable (32-bit offset), type extractable with 3 bit ops
  - **One layout per type** — no flags, no subtypes. "Parse, don't validate" for pointers.
  - **Heap length** — mutable len/cap in memory header. Aliases see mutations. C-style.
  - ATOM/STRING_SSO need zero memory allocation
  - 4 free slots remaining for future (Promise, Iterator, BigInt, etc)

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

## [ ] Representation -> per-site, inferred (not a user ABI knob)

  The compiler picks the carrier for each value the way a human reader infers
  type from JS: from name, operators, member access, `typeof`, assignments,
  JSDoc, optional declarations. Default cast is nanbox; analysis specializes
  to flat/i32/SSO/externref/packed/etc. per site. No `opts.abi`.

  Only the **boundary protocol** (how exports cross JS↔wasm) is a user
  concern, and that's `opts.host` (`'js'` | `'wasi'` | `'gc'`, autodetect).

  | | Pro | Con |
  |---|---|---|
  | Per-site inference | Hot path goes fast without ceremony; same binary mixes flat + nanbox where each fits; user writes plain JS | Wins only as strong as the analysis; bail-to-nanbox sites silently lose perf |
  | Nanbox as default cast | Polymorphism free, JS numbers passthrough, uniform slot, simplest codegen | 3–5 instr overhead on pointer ops, 8B per slot regardless of value |
  | Vs shipping `flat` preset | No transient API; analysis grows under one binary | Tempting shortcut — papers over weak analysis with user opt-in that can't be removed later |

  ### Type evidence (in increasing strength)

  - **Name**: `i`, `n`, `len`, `count`, `idx` → integer; `s`, `str`, `name` →
    string; `is*`, `has*` → bool. Lowest-confidence; suggestive only.
  - **Literals**: `[1,2,3]` → int array; `"abc"` → SSO string.
  - **Operators**: `x | 0`, `x >>> 0` → i32; `+x` → f64; `"" + x` → string;
    `x & mask` → i32.
  - **Member access**: `.length` → string/array/typed; `.charCodeAt` →
    string; `.byteLength` → buffer; `.then` → promise.
  - **`typeof` / `instanceof` guards**: narrow refinement in then-branch.
  - **Assignment flow**: if every reaching def is i32, local is i32.
  - **JSDoc** when present (`@type {number}`).
  - **Optional declarations** (future): explicit annotations sharpen
    inference but are never required.

  Anything a human reading the code would conclude, the compiler should
  conclude. Anything ambiguous falls back to nanbox.

  ### Already adaptive

  Typed-element arrays, `intCertain`/`intConst`/`intRange`, object schemas,
  val-type propagation, jzify `typeof`-narrowing, SSO at literal time.

  ### Next wins (same direction, deeper)

  SSO flow through concat results when inputs prove short. Schema field
  packing (`{x:i32,y:i32}` → 8B not 16B). Closure capture narrowing.
  Cross-call propagation through monomorphic-ish sites. Specialization
  on observed arg types when the export's callers are in-module.

  ### Implications

  Per-type rep modules survive as **internal** codegen modules: one file per
  type under `src/abi/` (`number.js`, `string.js`, `array.js`, `object.js`),
  each holding every carrier the narrower may pick for that type, dispatched
  per call site via analysis (`ctx.abi.<type>.ops.<op>`). `opts.abi` drops;
  `opts.host` (`js` / `wasi` / `gc`) takes its place. jsstring becomes per-site
  externref specialization for `host: 'js'`, not a preset. The earlier
  `src/abi/<type>/<rep>.js` split would have been preset-thinking smuggled in by
  file layout — separate files imply separate testing units imply user-pickable
  presets, the surface being removed. The `jz:abi` custom section, if kept, is a
  feature-detection version stamp (e.g. "ref-types required"), never a preset name.

  ### Open policy questions (deferred until first non-default rep emits at scale)

  1. **JSDoc strength.** `@type` as a hint (overridable by stronger evidence) or
     a contract (refuse to widen)? Hint matches implicit-inference; contract
     gives a cross-module escape hatch. Default: hint.
  2. **Null/undefined under flat slots.** A flat `i32`/`f64` can't carry them;
     the narrower must prove non-null at the binding or widen back to tagged.
  3. **Compound lifetime.** `__alloc` for a flat string passed to a host call —
     when freed? Today's `_clear`-reset arena suits short-lived; long-running
     needs a hook. Defer until a real long-running program forces it.
  4. **Cross-module ABI freezing.** Exported flat-slot signatures are public
     contract even though `opts.host` is what users picked. Export signatures
     derive from proven types of exports' params/returns; write exports so their
     types are obvious (or annotate). No promise of stable *internal* rep across
     versions for the same source.

## [ ] Inference -> collect before compile

All shape/flow facts are produced by **analysis passes that run before
emit**, never by ad-hoc inference inside the emit path. The emit phase
**reads** facts (`repOf`, `lookupValType`, `lookupNotString`,
`paramReps[k]`, `f.valResult`, etc.) but never derives them.

Why this matters:

- **Proofs.** Every dispatch-elision (`__length` → `__len`,
  `__to_num` → `asF64`, `__ptr_type` → branch fold, polymorphic
  `[]` → direct typed read) has a *named upstream fact* and a *named
  upstream pass*. When a regression appears, the chain is:
  `wat shows __length` ← `notString missing on param k` ←
  `notStringEvidence didn't fire` ← `body shape didn't match`. Every
  link is a deterministic AST walk over fully-prepared source.

- **Editor-hint consumability.** The same facts are emitted as custom
  WASM sections (`runtime.rests`, `runtime.i64`, etc.) for the JS
  boundary wrapper to read. Nothing prevents an editor host from
  consuming `ctx.func.repByLocal`, `ctx.func.paramReps`, and the per-
  function `f.valResult` / `f.arrayElemValType` to:
  - render param shapes as inlay hints (`(x: STRING, k: i32)`),
  - flag "this branch is suboptimal" when a call site forces a
    `paramReps[k]` field to sticky-null (the lattice already records
    *which* site disagreed — see narrow.js' D-phase),
  - surface `notString` / `intConst` / `arrayElemSchema` as
    optimization badges next to the source location.

- **Auditability.** "Why did this function specialize?" is answered by
  one record (`f.sig`, `f.valResult`, the rep map). "Why did this
  branch *not* specialize?" is answered by the absence of a fact at a
  known location, never by tracing the emit walk.

The phase chronology in `src/infer.js` (above the paramReps lattice
primitives, ~line 84) is the canonical reference for *what's valid
when*. Read it before adding a new consumer.

## [ ] Stdlib sources

  * [Metallic](https://github.com/jdh8/metallic), [Piezo](https://github.com/dy/piezo/blob/main/src/stdlib.js), [AS musl](https://github.com/AssemblyScript/musl/tree/master)

## Backlog (old arch, archived)

  * Boxed primitives (Object.assign pattern)
  * TypedArray pointer-embedded metadata
  * Ring arrays (auto-promote on shift/unshift)
  * NaN-boxing pointer kinds (7 types)
  * Compile-time rational simplification

## Audiences

* Web Audio / DSP community — jz -e "bytebeat expression" is a natural demo. The bytebeat test exists already.
* Edge compute (EdgeJS, CF Workers, Deno) — these communities are actively looking for ways to write WASM without learning Rust or C.
* Game jams / JS13K — the 1-2 kB WASM output is competitive with hand-optimized JS for size categories.
* Porffor community — they've already done the education work. jz is a different point in the design space (faster output, stricter subset).

## [ ] Optimization principle — minimal theoretical WASM, or no value

> *"Nothing takes place in the universe in which some rule of maximum or minimum does not appear."* — Euler
> *"Premature optimization is the root of all evil."* — Knuth

**The bet.** jz's whole value is the *guarantee* that, for every JS syntax
construct / pattern / design case, it emits the **simplest, most minimal
theoretical WASM** for it — wasm a careful hand-writer would produce, or better
(branch hints, SIMD, whole-program devirt). If jz only *ties* V8, there is no
reason to choose it: a tie is a loss. So the metric is concrete and binary:
**jessie.wasm (parser only) must beat jessie.js under warmed-up V8.**

**Per-construct, not per-program.** The unit of optimization is the *construct*
(a loop, an indexed read, a tail call, an allocation), never a benchmark. Fixing
the minimal lowering of a construct helps every program. Tuning one benchmark's
shape helps nothing. Never overburden emitted wasm out of complacency — every
extra instruction on a hot path must justify itself.

**Method discipline (this is where we kept failing).** Do NOT grind by statically
reading the WAT and fixing what is *easy to see*. That is premature optimization
— it aims at the visible, not the hot. **Profile first** (`node --prof` attributes
ticks to wasm functions by name; map via `.work/funcmap.json`), find the hot 20%,
then audit *those* functions' WAT against "minimal theoretical wasm" with numbers.
A fix that can't be tied to a profiled cost is speculation.

**Allowed levers** (all must stay sound — guarantees, never speculation; the
developer adjusts nothing):
  - safe jzify transforms that simplify code shape before lowering
  - WASM/watr branch hints, native tail calls, SIMD where provable
  - whole-program devirtualization, SRoA, const-fold, i32/f64 narrowing
  - README *performance hints* — documentation only, advisory, never required

---

## README audience model — the four visitor classes

*(Archived from the README's trailing HTML comment — design scaffolding for who the doc serves and what each reader scans for.)*

### Skeptics — "Oh great, another JS-to-WASM compiler"

Seen AssemblyScript, Porffor, Javy. Looking for reasons to dismiss or take seriously.

| They ask | They look for |
|---|---|
| Why not just AssemblyScript/Porffor? | Honest comparison with trade-offs, not sales copy |
| What JS does it actually support? | Concrete subset, not "JS you already know" |
| Are the benchmarks real? | Reproducible numbers, CI gating, no cherry-picking |
| Where does it break? | Divergence list — if it's hidden, they assume the worst |
| Is this a toy or production? | Test262 badge, self-host, bench CI |

Scroll straight to Alternatives and the divergence FAQ. If either smells like marketing, they leave.

### Curious explorers — "Interesting — show me something"

Came from a link, not evaluating anything. Want a 30-second "aha" then a path to go deeper.

| They ask | They look for |
|---|---|
| What is this in one sentence? | Tagline that names the thing, not the aspirations |
| Show me it working | Opening code example — compile, call, done |
| What's it good for? | Good-for / not-for table — tells them whether to care |
| Something visual | Examples grid — mandelbrot, spectrogram |

Read the first 20 lines and either leave or open a fold. The Language diagram is their entry point.

### Pragmatists — "Can I use this for my problem?"

Have a real use case — DSP, parser, numeric kernel. Need concrete answers.

| They ask | They look for |
|---|---|
| Does it handle my case? | Good-for table + supported language list |
| How do I pass data in/out? | Passing-data fold — numbers, arrays, strings, objects |
| How do I deploy the output? | Deploy FAQ — .wasm in production, interop bundle |
| What's the DX? Error messages? | Error example in Language section |
| What doesn't work? | Divergence FAQ — upfront, not buried |
| Can I test normally? | "Valid jz is valid JS" — use existing test runner |
| How do I debug? | --wat flag, mentioned in FAQ entries |
| Can I split into files? | Import/export FAQ |
| What's the memory story? | Bump allocator FAQ — when to reset, how to share |

Skip straight to Usage folds and FAQ. They need answers, not framing.

### Embedders — "Can I ship this in my product?"

Building a product that compiles or runs jz output. Care about weight, deps, stability.

| They ask | They look for |
|---|---|
| How big is the runtime? | Interop bundle size — jz/interop without compiler |
| What's the compile speed? | ~2–60 ms range — compile on the fly or AOT? |
| Can I ship just the .wasm? | Deploy FAQ — jz/interop is the thin bridge |
| What are the runtime dependencies? | Dependency list — currently none beyond WASM |
| Can I run it in a worker / service worker? | "Compile in the browser or a Worker?" FAQ |
| How stable is the output format? | "Is jz production-ready?" FAQ — pre-1.0, pin a version |
| What's the license? | MIT — bottom of page |
| Memory ABI for non-JS hosts? | Deploy FAQ — the _alloc/_clear exports, header layout |

Read Deploy and Options carefully. They're the ones who'd read layout.js.

### Language / compiler people — "How does it work internally?"

Want to understand the approach, not use it. Read the source, not just the README.

| They ask | They look for |
|---|---|
| What's the compilation model? | "How does jz work?" pipeline fold |
| What optimizations are applied? | Optimization FAQ |
| What's the type inference story? | "Why no type annotations?" FAQ |
| Can it self-host? | Self-host FAQ |

These people read src/ regardless. The README just needs to not lie about what's inside.
