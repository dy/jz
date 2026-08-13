# JZ — design & architecture

The decided architecture and design rationale behind JZ: representation, allocator,
type inference, the native pipeline, and the principles that fix them. Status markers
in headings: **[x]** = decided / reflected in the code, **[ ]** = designed or deferred.

Audience & persona material lives in [`.work/marketing.md`](../.work/marketing.md)
(canonical) and the expansion map in [`.work/ecosystem.md`](../.work/ecosystem.md);
this document is the technical record.

---

## [x] Vision

> **JZ = JS as it should have been → WASM**

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
Excludes JS misfeatures (coercions, hoisting, `this`, classes). Valid JZ = valid JS. No linter needed — bad patterns don't parse.
Errors fail early with actionable messages.
Gateway from JS to low-level: WASM, WASI, native via wasm2c.

## [x] Uniqueness

> type inference from plain JS (no annotations — AS can't say this), auto-SIMD, single-digit-kB output, a pure synchronous compiler that runs in the browser in milliseconds (Porffor fundamentally can't compile-on-the-fly like this), self-hosting, and the native pipeline that beats V8. Nobody else has that combination.

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

  1. **Predictable proven performance** — native speed from plain JS knowledge. No annotations, no toolchains. Any case is guaranteed worst case be faster than V8/JSC. *(Split this: "predictable" is provable structurally; "faster than V8/JSC on every case" is evidenced, not provable — the provable surrogate is "no waste". See §"Proof architecture".)*
  2. **Correctness by design** — bad patterns don't compile. The language is the linter.
  3. **Transparency** — no hidden allocations, no implicit copies. What you write is what runs.
  4. **Immediacy** — compilation is interactive, not a build step.
  5. **Tiny footprint** — kilobytes, not megabytes. No runtime, no wrappers.
  6. **Elegance** — the compiler stays clean and layered: a pure core that reads pre-computed facts, with type/stdlib breadth pushed to swappable modules. Dependency-light (two first-party libs: subscript, watr).

## [x] Goals / claims

* Produced WASM is faster conceptually and practically on all possible bench classes than the other WASM targets: if other compilers can optimize random source that way, it means they have a class of optimization, not specific case;
* Produced WASM is faster than V8, JSC on all bench cases: if JIT understands source well to be able to reduce it to efficient bytecode, so should JZ
* Produced WASM size is smaller than AssemblyScript
* Compiled wasm2c or w2c2 is faster than any of the alternatives

> **Status — the enforced bar, ratcheted, not yet universally met.** CI-gates the claim in
> [`test/bench.js`](../test/bench.js): `WASM_TODO` is the explicit shrinking list of cases where a
> wasm rival still leads (a non-listed regression fails the gate; closing a case deletes its entry).
> Current gaps against the live corpus: 3/31 cases trail V8 (mandelbrot, wav, jessie); 17/31 are
> larger than AssemblyScript (lz, qoi worst). Treat these as targets to ratchet, not facts to assert
> in public copy — the README already hedges to "on par with AssemblyScript".


## [x] Paradigm shift -> WASM as live medium, not build artifact

  Current WASM workflow: write Rust/C → compile offline → load binary → deploy.
  JZ workflow: write JS → compile in browser → instant native code.

  * WASM as interaction medium, not deployment format
  * Live-coding native audio/visuals in JS
  * User-generated native compute (sandboxed)
  * Hot-swappable compute kernels (no reload)
  * WASM as REPL target
  * Scripting = compiling (same act)

## [x] Anti-goals (what JZ refuses to be)

  * Not a general-purpose language — no DOM, no engine event loop (async/await lowers to state machines + a boundary-drained job queue; asynchrony stays host-driven)
  * Not a JS runtime — no eval, no dynamic import, no reflection
  * Not aiming for 100% JS compat — subset by design, divergences documented
  * Not a build tool — no bundling, no tree-shaking, no source maps
  * Not a speculative optimizer — sound static lowering only (narrowing, SIMD, CSE, escape analysis, const-fold); no profile-guided or runtime reopt, the engine handles the rest
  * Not a type system — types inferred from usage, never annotated

## [x] Success criteria (how we know it works)

  * Compilation < 1ms in browser for typical module
  * Output smaller than equivalent C via emscripten
  * Compiler stays small and dependency-light (two first-party deps: subscript, watr)
  * Any JZ program runs identically as JS (within documented divergences)
  * Audio worklet: zero GC pauses, stable real-time output
  * Cold start: parse + compile + instantiate < 5ms

## [x] Positioning (why JZ, not alternatives)

  Others compile JS (or JS-like) to WASM. JZ is different in kind, not degree:
  * **vs porffor/jawsm**: they target full JS semantics → runtime overhead, GC. JZ targets a subset → zero runtime.
  * **vs assemblyscript**: separate language with JS-like syntax. JZ code IS valid JS.
  * **vs javy**: embeds QuickJS interpreter in WASM. Interpreter overhead. JZ compiles to native WASM ops.
  * **vs emscripten**: C/C++ toolchain. Different language, massive output. JZ is JS-native.
  * The argument: JZ trades JS completeness for something no alternative offers — zero-overhead WASM from JS syntax, compilable in the browser, in real-time.

## [x] Name -> JZ

  * JZ
    + java zcript
    + js zero
    + jazz

## [x] Qualities

  * _Lightweight_ – embed anywhere, from websites to microcontrollers.
  * _Fast_ – compiles to WASM faster than `eval` parses.
  * _Tiny output_ – no runtime, no heap, no wrappers.
    * JZ output ≤ hand-written. Pure scalar = identical. Loops = ≤5% overhead.
  * _Zero overhead_ – no runtime type checks, monomorphized per call-site.
  * _JS interop_ – export/import, preserve func signatures at WASM boundary.
  * _JS compat_ – any JZ is valid js with limitations.
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

  JZ differentiator: minimal core (<2K lines), zero runtime, pure functional subset, module-extensible.

## [x] Closures -> Capture by value + explicit env param

  * Capture by value: zero runtime cost for immutable captures
  * Mutable captures **supported** — the captured cell lives in the closure env (verified: an
    in-body `() => n = n + 1` mutating a captured `n` compiles and runs). (Was once disallowed;
    no longer.)
  * Implementation: funcIdx + env pointer (call_indirect with env as first param)
  * Boundary caveat: a closure *returned to JS* comes back as a boxed value (callable via the
    interop layer), not as a bare JS function
  * Sufficient for functional patterns (currying, callbacks)

## [x] Floating point precision -> Compile-time rational simplification

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

  **Boundary wire type — i64, not f64.** Internally a box is an f64 NaN. *Crossing* JS↔wasm it
  rides as an **i64** (a `BigInt` on the JS side): JSC/Safari canonicalizes f64 NaN payloads at the
  boundary, erasing the box. Plain numbers stay f64 (free); only boxed values pay the i64 carrier.
  A per-export `jz:i64exp` custom section records which params/results ride i64. See
  [`layout.js`](../layout.js) and [`interop.js`](../interop.js). So "f64 everywhere" holds for
  *internal* representation; the *boundary* is the one mixed signature.

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

  **vs Go/Rust**: Go/Rust are statically typed — no runtime type bits needed. JZ needs them
  because a single f64 param could be number/array/string/object (JS polymorphism).
  NaN-boxing is the cheapest way to pay it.

## [x] Allocator -> for linear memory, pluggable

  | Strategy | Alloc | Free | Best for |
  |----------|-------|------|----------|
  | **Bump** (default — **the only one shipped**) | Increment pointer | `_clear()` resets the arena | DSP, batch processing |
  | **Free list** *(designed, deferred)* | malloc | free(ptr) | Mixed lifetimes |
  | **Refcount** *(designed, deferred)* | alloc | auto on rc=0 | Shared structures |
  | **External** *(designed, deferred)* | Host provides | Host frees | Embedded, plugins |

  Contract: `_alloc(bytes) → i32` and `_clear()` (arena reset); a `_free(ptr)` hook is reserved for the
  deferred free-list/refcount strategies. Implementation swappable — today only bump ships.

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
  - Exports: named + re-export; `export default …` also compiles (yields a `default` export),
    though named exports are the convention
  - Bare specifiers: importmap (CLI), relative paths required in source

## [x] Types -> i32/f64 by operator, monomorphic

  * `1` → i32, `1.0` → f64. Operators preserve i32 when both operands i32.
  * `/`, `**` always f64. Bitwise always i32. Comparisons always i32.
  * Variables typed by pre-analysis: if any assignment is f64, local is f64.
  * All types resolved at compile-time. No runtime dispatch.

## [x] Pointers -> i32 internal, boundary wraps (see Data representation above)

## [x] Host APIs -> WASI + shim

  | JS API | WASI Function |
  |--------|---------------|
  | console.log | fd_write(1, ...) |
  | Date.now() | clock_time_get(realtime) |
  | performance.now() | clock_time_get(monotonic) |

## [x] Native binary -> WASM is the IR

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

## [x] Metacircular (jz.wasm) -> WASI

  Shipped: JZ compiles its own entire source to `dist/jz.wasm` — the whole pipeline runs inside wasm.

  * `dist/jz.wasm` *is* JZ compiled by JZ (built via [`scripts/selfhost-build.mjs`](../scripts/selfhost-build.mjs))
  * Uses WASI for I/O (fd_read/write for source, fd_write for output)
  * CI-gated: `npm run test:self` round-trips real programs through the in-wasm compiler and runs the output

## [x] Pluggable architecture -> Modules extending ctx.emit

  Modules register on ctx: `ctx.core.emit[name]` (emitters), `ctx.core.stdlib[name]` (WAT),
  `ctx.core.includes` (lazy inclusion). Core stays minimal, capabilities grow through modules.

## [x] Representation -> per-site, inferred (not a user ABI knob)

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

## [x] Inference -> collect before compile

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

## [x] Stdlib sources

  * [Metallic](https://github.com/jdh8/metallic), [Piezo](https://github.com/dy/piezo/blob/main/src/stdlib.js), [AS musl](https://github.com/AssemblyScript/musl/tree/master)

## Backlog (old arch, archived)

  * Boxed primitives (Object.assign pattern)
  * TypedArray pointer-embedded metadata
  * Ring arrays (auto-promote on shift/unshift)
  * NaN-boxing pointer kinds (7 types)
  * Compile-time rational simplification

## [x] Optimization principle — minimal theoretical WASM, or no value

> *"Nothing takes place in the universe in which some rule of maximum or minimum does not appear."* — Euler
> *"Premature optimization is the root of all evil."* — Knuth

**The bet.** JZ's whole value is the *guarantee* that, for every JS syntax
construct / pattern / design case, it emits the **simplest, most minimal
theoretical WASM** for it — wasm a careful hand-writer would produce, or better
(branch hints, SIMD, whole-program devirt). If JZ only *ties* V8, there is no
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

## [x] Proof architecture — what's provable vs what's evidenced

"Predictable proven performance" (Values §1) fuses two claims that need different
machinery. Conflating them is the standing risk — and the reason a 39-case bench
can never close the goal.

**Predictable is provable, structurally, today.** AOT + no deopt + no tiering + no
GC ⇒ bounded variance: no warmup cliff, no deopt cliff, no GC pause. This follows
from the architecture, not a benchmark, and it is the guarantee V8/JSC *cannot*
make. Lead with variance, not mean.

**Fast — "faster than V8/JSC on every case" — is NOT provable**, only *evidenced*:
induction over a sample, against a moving, adaptive, machine-dependent JIT.
Asserting it as a guarantee is the overclaim (and already locally false: size-vs-AS
in aggregate; crc32/mandelbrot/AoS floors). The provable surrogate is **no waste** —
the output contains none of the overhead the optimizer claims to remove. A negative,
statically checkable property of the WAT, independent of any competitor or stopwatch.
You cannot prove "fast"; you can prove "no waste", and that is stronger than any
benchmark win because it does not erode when V8 ships a new tier next quarter.

**The guarantee ladder** (increasing strength, decreasing reach):
  0. **Predictable** — structural, proven by construction.
  1. **Waste-free** — a machine-checked verifier asserts each absence-of-overhead
     invariant over emitted WAT, swept over the fuzzer's generated *sublanguage* (a
     proof over the language, not a sample). This is the engineering target.
  2. **Locally optimal** — output is a fixpoint of the peephole+watr rewrite system
     (no missed local rewrite) = "minimal theoretical WASM per construct", checkably.
     Audited by `scripts/audit-fixpoint.mjs` (`npm run audit:fixpoint`): re-run jz's
     OWN optimizer (watr) on the finished output; a drop = a rewrite the pipeline left
     on the table. Today 7/10 corpus kernels are fixpoints; the non-convergent cluster
     is reductions / conditional maps (dot, sum, clamp-map: a 2nd watr pass removes
     15–18 ops). NB: a FOREIGN optimizer (wasm-opt -O3) is the wrong oracle — it
     unrolls/re-vectorizes, RAISING static op count on biquad/matmul/crc, so its delta
     conflates "jz left slack" with "different size↔speed trade". watr (jz's own system)
     is unconfounded.
  3. **Globally optimal** — undecidable in general; reachable per-construct only via a
     bounded superoptimizer, offline, as a one-shot proof artifact. Never a live gate.

**The speed claim becomes a partition, not a universal:**
  { cases the verifier proves minimal } ∪ { cases at a documented floor }.
The documented-floor half is already a STRUCTURED, machine-gated registry — `WASM_TODO`
in `test/bench.js`, behind the `fastest-wasm` gate (jz leads every wasm rival on every
case UNLESS listed, and each entry carries a MEASURED root cause; closing one = deleting
it). Two reference classes, kept distinct:
  - **floor vs wasm rivals** (`WASM_TODO`: fft FMA-parity, raytrace/mat4/nqueens/qoi/dict
    scalar-codegen-quality) — jz trails another wasm producer for an LLVM-grade
    scalar-isel/regalloc reason V8's wasm tier caps anyway, or an FMA parity class that
    would break valid-jz=valid-JS. No jz pass closes these; each was verified against the
    WAT and the disproven hypotheses recorded so they aren't re-chased.
  - **floor vs native** (crc32 `clmul`/SSE4.2, AoS AVX2-4-lane) — jz LEADS the wasm
    rivals but trails NATIVE because the hardware instruction is unreachable in wasm-v1.
    This bounds every wasm producer, not just jz.
A documented floor is a *stronger* statement than a benchmark win: "no wasm producer
beats this on this target" outlives the next JIT; "we won by 1.05× today" does not.

**The infra, mapped to the ladder** (the OUTPUT-side twin of `src/infer.js`'s
named-fact/named-pass discipline — every opt now also has a named output invariant
and a check with teeth):
  - **absence-of-overhead invariants** — `test/wat-invariants.js`: per-pass *ablation*
    (overhead present with the pass off, absent with it on — proves the check sees the
    pattern AND that the named pass removes it) + per-sublanguage *population sweep*
    over the fuzzer generators (hard-zero where clean; ratcheted where a gap is
    documented). The structural twin of the value-correctness fuzzer.
  - **machine-independent regression gate** — `test/perf-ratchet.js`: loop-body op
    count over the shared corpus (`scripts/perf-corpus.mjs`), now including adversarial
    whitelist-defeating shapes (`cond` nested-conditional, `buf` param-array, `nest`
    nested-loop). The portable "did codegen get wasteful" signal; no stopwatch.
  - **selection-bias audit** — `scripts/audit-assemblyscript.mjs` (`npm run audit:as`):
    the AssemblyScript canon, annotation-free, checked for the two *sound* waste
    signals (counter-compared-in-f64, per-iteration pointer decode). Third-party shapes
    the in-house corpus never tuned for. (It deliberately does NOT flag body f64 from
    bare `*`/`+`/`%` — that is the integer-overflow contract, not a deopt.)

**Surfaced by building this** (now ratcheted, can't worsen, shrink when fixed; see
`.work/todo.md`): nested-conditional int → f64 round-trip under the vectorizer;
param typed-array base re-decoded per iteration (the flagship DSP shape); narrowLoopBound
handling only `i < n` (not `<=`/`>`/`>=` or non-const counters). None were visible to
the net-output bench — exactly why the proof lives at the construct level, not the
program level.

**Restated headline (honest, and the real moat):** JZ emits provably waste-free,
predictable WASM from plain JS — no warmup, no deopt, no GC — and on every case is
either proven minimal or at a floor no wasm producer can beat. Benchmarks are
*evidence* the contract correlates with wall-clock wins; the verifier is the *proof*
the contract holds; the perf-fuzzer and bias audit find the invariants not yet
formalized. "We win benchmarks" is induction against a moving target; "we emit
waste-free locally-optimal code with bounded variance" is deduction.


### Vectorizer → lowering (pre-watr). North star.

**PRINCIPLE (load-bearing, non-negotiable).**
> **There must be NO post-watr optimizer and NO jz WAT twiddling after watr — optimization is watr's
> sole job.** jz does all *lowering* (the value model, pure-helper inlining, and auto-vectorization —
> "turn this array-map into SIMD" is a lowering decision, not an optimization). watr is the *only*
> optimizer, it runs *once*, *last*, and it must be a **fixpoint**: never run the optimizer multiple
> times or interleave jz passes around it. One canonical form → one optimizer → done. Any jz pass that
> reads or rewrites WAT *after* watr is an architecture violation and a bug magnet (see below).

**Target pipeline (one canonical form, one optimizer, no round-trip):**
```
jz:   parse → lower  (value model + inline pure helpers + vectorize array-maps → clean canonical IR incl. SIMD)
watr: optimize ONCE  (coalesce/DCE/fold/rebox — machine-level, SIMD-preserving, LAST)
```
Recognizers should read DATAFLOW (induction var + affine access + pure body), not syntax, so they're
invariant under canonicalization. Where they still read syntax, jz canonicalizes to watr's normal
form BEFORE vectorizing (as lowering, not as a second optimizer pass — see the canon helpers below).

**STATUS — Phase 1 DONE (correctness + architecture), Phase 2 OPEN (perf recovery).**

*Phase 1 — landed & verified (this branch):*
- Vectorizer + `pureFuncMap` build + `appendLateStdlib` moved to the emit/pre phase
  (`src/wat/assemble.js optimizeModule`). `optimizeFunc`'s `runVectorizer = phase !== 'post'`.
- **The jz post-watr `optimizeFunc('post')` block is DELETED** (`index.js`). This was BOTH an
  architecture violation AND a correctness bug: re-running jz's propagate/fold sweep on watr's output
  dropped a reassigned-param `local.tee` write (`p=0; …p…` returned the stale param) and corrupted the
  divergent-escape SIMD frame (mandelbrot 2 px wrong). **Deleting it fixed every one of those.**
- Pre-watr canonicalization helpers (jz lowering, NOT a post-optimizer), run once at the top of
  `vectorizeLaneLocal`: `normalizeTransparentBlocks` (flatten jz's per-statement `(block …)` grouping —
  watr's mergeBlocks does this post-hoc, the pre-watr recognizers need it up front), `foldVecIdentities`
  (`i<<0`→`i` byte-stride address, `x±0`, `x|0`, `x*1` — watr's identity fold), `canonicalizeIfBr`
  (`if C (then (br L))`→`br_if L C` — watr's brif). These make the syntactic recognizers see watr's
  flattened shape without any post-watr round-trip.
- `SIMD_PINNED` now pins BOTH the scalar transcendentals AND their f64x2 mirrors (`$math.cbrt_v`, …),
  so watr's inliner dissolves neither (the SIMD path keeps calling the mirror).
- **Found + fixed a real watr bug:** constant-condition `select` fold dropped a side-effecting DISCARDED
  arm (`select` evaluates BOTH arms; `p=0` compiled as the else arm of `cond?0:p` was lost). Fixed in
  `watr/src/optimize.js` (guard the fold on `isPure(discardedArm)`), pinned in `watr/test/optimize.js`.
- **Verification:** differential fuzz **76 204 comparisons, 0 divergence**; selfhost 15/15; watr suite
  194/194; jz SIMD suite 148/154 (the 6 failures are all *missing-optimization* asserts — the bit-exact
  checks pass, i.e. safe scalar fallback), full suite 2572 pass.

*Phase 2 — IN PROGRESS. Deleting the post-block regressed RUNTIME (size neutral). Recovery is
two-pronged, per the "jz owns lowering, watr owns mechanical optimization" borderline.*

**Borderline (decided):** a transform belongs where the KNOWLEDGE that makes it optimal lives.
  - **Inlining is jz's** — the *decision* (what to inline, to expose which lowering) needs purity
    (`pureFuncMap`), types, and the downstream vectorizer/narrower, all of which jz has and watr
    (untyped WAT, size-gated, semantically blind) does not. **Built (`inlinePureFnsInFn`, vectorize.js),
    but OPT-IN / off by default (`optimize.inlinePureFns`).** It inlines SMALL (≤48 nodes) SINGLE-CALLER
    pure functions before the vectorizer, leak-guarded (bails if a callee `local.tee` would escape — but
    ONLY on the general path; the vectorizer's own lane-inline re-processes tees). Correct + fuzz-clean;
    pinned in test/simd.js. **Finding — its marginal value doesn't justify default-on:** for a
    *vectorizable* loop the vectorizer ALREADY lane-inlines the pure call (same `inlinePureCallExpr`),
    and watr's `inlineOnce` already folds single-caller functions — so the general pass is redundant
    except in the narrow case where a `call` blocks the vectorizer's *loop recognition* (before the
    lane-lift). Default-on inlined broadly across the corpus, churning 121 pinned output-shape asserts
    for zero bench win. Left opt-in as the correct architectural home; revisit scoped to
    recognition-unblocking when a real case needs it.
  - **LICM, loop-rotation, CSE, coalesce are watr's** — mechanical, no high-level knowledge. Making
    watr wasm-opt-class (add these "binaryen-level" passes, pinned in watr's suite) is the other prong.

**Recovered:** `rotateLoops` re-enabled in the PRE phase (it's a pure loop-shape transform, needs no
inlining, survives watr) → **lz 15914 vs HEAD 15950** (full), fuzz-clean.

**Remaining regressions (measured current-vs-HEAD, speed tier), with the concrete lever:**
  - **nbody 1.28× (f64x2 36→9, no `f64x2.sqrt`)** — `tryOuterStrip` (2 pixels `i`/`i+1` in lanes over
    the inner `j`-reduction) under-fires on the RAW pre-watr loop shape. → jz vectorizer recognition
    (same class as the Phase-1 canon gaps, in the outer-strip recognizer).
  - **blur 2.02× (v128 24→16)** — the i16x8 widening-blur recognizer packs fewer lanes pre-watr. →
    jz vectorizer recognition.
  - **raytrace 1.75×** — NO calls in the sphere loop; lost the post-block's LICM + load-CSE cleanup of
    watr's output. `splitLoopPrivateScratch` is a NO-OP pre-watr (its unrolled-scratch input only
    exists post-inline; gated off as `cfg.splitScratch`). → **watr LICM + load-CSE** (wasm-opt-class).
  - **colorpq 1.82×** — vectorizes fine (470 f64x2); the slowdown is redundant scalar glue watr's
    post-vectorize CSE used to clean. → **watr CSE** (wasm-opt-class).
So the inliner (built, correct) does not by itself recover these four — they are outer-strip/widening
recognition (jz) + watr wasm-opt-class LICM/CSE. The inliner recovers the DIFFERENT class (small
single-caller pure helper feeding a map), and is the correct architectural home regardless.

*Remaining missing-optimization gaps (safe scalar today, bit-exact — pinned SIMD asserts):*
  1. AoS constant-exponent pow → exp∘log (jz doesn't emit pre-watr — recognizer/inline shape).
  2. per-pixel-color domain-color: the `$__ppc` wrapper is emitted pre-watr but **watr DCEs it**
     (SIMD-preservation gap — like the select bug, a watr fix).
  3. julia "invariant lanes" (fixed-c, z0=0): divergent-escape doesn't fire when nothing varies per
     pixel (MANDEL, per-pixel c, DOES vectorize).

**Invariants (must hold on landing):** no jz WAT pass after watr; watr sole optimizer, once, last,
fixpoint; every pinned vectorization fires bit-exact; watr never scrambles v128; no bench runtime
regression vs the pre-migration baseline.

Generic folds watr lacked, migrated in: rebox-fold `wrap∘reinterpret∘reinterpret∘extend → x`
(watr `afbdd97`); constant-select side-effect guard (this branch).

---

# Architecture programs — design summaries (2026-08-07 consolidation)

Full design docs were deleted per the one-record policy; every full text is
recoverable via `git log --diff-filter=D -- .work/<name>.md` → `git show
<sha>^:.work/<name>.md`. The living execution ledger is `.work/todo.md`
(+ its two archives, grep-first). The ONLY standalone design doc kept is
`.work/carrier-representation-design.md` — its program is in flight (an
agent appends findings sections live); fold it here when the program closes.

## [ ] Middle-end consolidation plan (was architecture-plan.md; audit-#13 critical path)

From the 2026-07-20 architecture audit. Stages: **0 pass-registry +
formatting-invariance — DONE** (registry with `enabled()` throwing on
unregistered names; O0 = all-off asserted; code.length tuning deleted).
**1 BindingId — DONE** (4a0102d2 totality + census collapse; bare-name
schema class unrepresentable; α-rename byte-identity pin). **2 one fact
solver, frozen plans** — slices 1-4 DONE (change-driven fixpoint 7e570e58;
solver-owned D2 storage 878d3685; D1 worklist b01dbfb2; SLICE 4 exit-grep 0,
FunctionPlan frozen with DBG enforcement — updateRep throws when frozen;
P1→inheritPtrAliases, P2→closureAux channel, P3→Object.assign plan
predictor, P4→assert-only). REMAINING: the ~31 analyzeBody call sites still
route through the staleable cache with hand-placed invalidation — "declared
invalidation" (one invalidateBodyFacts(body, reason) entry point; blanket
phase-boundary calls become coverage assertions, then delete) and the
per-domain worklists (D4→D2→D1→D3 order) are the open solver work.
**3 loop model** — scaffold phase TERMINAL ({bl,op,blLoose} descriptor,
15/16 recognizers); BodyModel continuation below. **4 CompileSession
phase views** (~43 ctx importers) + target legalization profiles — OPEN.
**5 claims/hygiene** — three-tier bench claims live; self-host workaround
sweep ongoing via differential tests.

## [ ] BodyModel / LoweredLoopPlan (was loop-bodymodel-design.md; Stage-3 remainder)

Shares FACTS not scans: one order-independent per-block record built before
any recognizer runs — `addrTable` (Map name→{kind: offset|fullAddr|idxTee|
mirror, strideLog2, pixelStride, base}), `siteAccess` (WeakMap node→resolved
affine access), `aliasClass` (base-identity partition; distinctness ONLY
under existing solver proof, else same-class). Recognizer ADMISSION POLICY
stays private per the terminal verdict (the 2026-07-31 shared-scan refusal:
the differing knobs ARE the differing soundness conditions). Slices 1-3
LANDED 2026-08-07 byte-identical (174 compiles ×3 tiers, zero WAT diffs):
construction + shadow-asserts; the 3 class-A hoists (epilogueIsSafe,
bumpPixelIV/rampPixelIV direct refs, matchChannelReducePixelLoop);
tryMapReduceVectorize/tryRampMap onto the tables (tryStrengthReduceIV
correctly excluded — matchAffineAddr never consulted the tables).

**Dedupe (audit-#14 item 6) LANDED 2026-08-08**: the migration was
performing MORE analysis, not one census — fixed at three points.
`deriveOffsetTees` retired: `bl.offsetTees` is now `addrTable`'s offset-kind
projection (`offsetTeesFromAddrTable`), built once inside `buildBodyModel`
instead of a second independent derivation; `tryRampMap` reads
`bl.offsetTees` directly instead of re-projecting `addrTable` itself per
call. `assertBodyModelSound`'s now-tautological offsetTees-vs-addrTable
check retired (the slice-1 shadow-assert already proved the two identical
on the full corpus BEFORE the unification — that proof is what licensed
retiring the standalone derivation). `buildAddrTable` restructured to a
genuine two-phase single walk: phase 1 collects every write bucketed by
name in one pass, phase 2 (`classifyAddrLocal`) classifies each name
against its own pre-collected write list — was quadratic in loop-body size
× candidate-local count, now linear. `aliasClass`'s per-key Map fill
replaced by the constant lookup it actually is (single-universal-class per
item 5) — API unchanged, no more loop over `baseKeys`. Gates: byte-identical
174-compile corpus, test/simd.js 158/158, full battery/kernel-parity/
selfhost/build×2 all clean (same 3 pre-existing failures, unrelated).
Measured ~38-40% compile-time reduction on 2 of the 3 largest bench cases
(qoi, bezfit — many candidate address-locals per loop body, where the
quadratic walk hurt most); fftplan (butterfly, dual-IV, few candidates)
roughly flat.

**Slice 4 (HIR provenance link) LANDED 2026-08-08, link + shadow-assert
only — no consumer wired**: emit.js's `'for'` handler (the sole plain-loop
lowering seam) mints a LoopPlan record per loop it emits — id,
induction-variable name (`guardCounterName`), the counter hull
(`forCounterRange`'s proven [lo,hi]), guard name, provable-constant bound —
linked to the emitted WAT block node via loop-model.js's `loopPlanLink`
(WeakMap keyed on block-node IDENTITY: a rewrite minting a fresh array
naturally drops the link, miss = fail-open). vectorize.js's dispatch looks
the link up per matched `bl` and, under JZ_DEBUG_INVARIANTS, shadow-asserts
the linked plan's IV name and constant bound agree with the WAT-derived
`bl` facts where both resolve (`assertLoopPlanAgrees`). Verified all four
BINDING pre-trio specs empirically, not just by inspection: (2) fail-open
is REAL, not theoretical — 12129 hit / 299 miss (97.6%) across the full
battery under JZ_DEBUG_INVARIANTS; (1) rewrites minting fresh identities
mostly holds, but the shadow-assert caught ONE violation — small-const
outer-loop unrolling with a nested loop (`splitScratch`,
`freshenUnrolledScalarBindings`) renames the nested loop's OWN induction
variable's WAT local IN PLACE post-emission without changing the linked
block's identity, so the recorded ivName went stale relative to an
unchanged-identity node (2 test failures: "small strided outer control loop
specializes nested typed kernels", "labeled break crosses the inner loop").
Root-caused and fixed at the source, not papered: `freshenUnrolledScalarBindings`
now carries its rename map through any `loopPlanLink` entry it touches
(metadata-only — mutates the linked plan object, never the emitted IR, so
it cannot affect WAT bytes) instead of leaving a stale fact behind. (3)/(4)
hold by construction (no consumer wired, dispatch order untouched). Gates:
same as above, all clean.

REMAINING: consulting HIR facts (typedLen, neverGrown) through the link is
explicitly NOT wired — `{bl,op,blLoose}` is still the sole authority every
recognizer reads; a future slice that wants to lean on `loopPlanLink` for a
real decision inherits the freshenUnrolledScalarBindings lesson (any pass
that renames a linked loop's own IV/guard local in place must keep the link
in sync, not just passes that clone the block array). Slices 5-7 = the
incremental trio (tryMemCopyFill → tryReduceVectorize → tryVectorize), each
its own byte-identity-gated unit. Class-C recognizers (stencil ivCoeff,
butterfly unification, divergent-escape, conv-column MAC) stay private by
design.

**Ownership correction (audit-#15 item 5) LANDED 2026-08-08**: the audit's
objection to slice 4 — `freshenUnrolledScalarBindings` mutating the linked
plan's `ivName` in place meant the "HIR plan" was really backend metadata,
and a rename must never touch an HIR fact — fixed at the schema. Each
`loopPlanLink` entry is now `{ plan, lowering }`: `plan` (id, hull,
boundConst) is `Object.freeze`d at mint time — the immutable HIR-side facts
proved at `'for'`-emission; `lowering` (ivName, guardName) is the mutable
WAT-side name map, owned by the backend. `freshenUnrolledScalarBindings`
updates ONLY `lowering`; `assertLoopPlanAgrees` reads through the pair (`plan`
for `id`/`boundConst`, `lowering` for `ivName`). The link's home also moved
OUT of loop-model.js (AST-level loop primitives, pre-emission — a layering
mismatch for a fact keyed on an EMITTED WAT block node) INTO ir.js, the
neutral WAT-IR-node module both emit.js and vectorize.js already imported
without a cycle (findBodyStart, verifyFn, loopTop already live there).
Metadata-only: fail-open miss semantics and all four BINDING pre-trio specs
unchanged, zero WAT output change expected or found. Gates: byte-identical
58-case/174-compile bench sweep at O0/O2/O3 (0 diffs) against a clean-HEAD
worktree baseline, test/simd.js 158/158, full battery 3407/3415 pass (the
same 2 pre-existing unrelated fails — interval walk / typed RMW codec
bounds), JZ_DEBUG_INVARIANTS=1 full battery: same + 1 pre-existing flake
(`analyzeValTypes` declRange restamp for `cf1_8`, audit-#12 item 2's own
idempotence probe — unrelated subsystem, confirmed before), kernel-parity
33/33, `npm run build` ×2 dist/{jz.js,interop.js,jz.wasm} SHA-256
byte-identical across both runs.

**Dead baseKeys removal (audit-#15 item 6) LANDED 2026-08-08**:
`buildSiteAccess` no longer collects `baseKeys` (a `JSON.stringify`
structural key per load/store site) — dead production cost since
`buildAliasClass` became the single-universal-class constant map (audit-#14
item 6, .work/research.md above). `baseKeyOf` (baseKeys' sole consumer)
removed with it. `buildAliasClass` now takes no input; the constant-lookup
API (`ALIAS_CLASS_UNIVERSAL`) and the doc pointing at the future points-to
consumer are kept as-is — collection is to be REINTRODUCED alongside that
consumer landing, not before. Gates: same sweep as item 5 above, all clean.

**LoopPlan pre-emission mint (audit-#16) LANDED 2026-08-09**: closes the gap
the audit named — "the plan is still minted inside emit.js" — by moving
`plan` (id/hull/boundConst) CONSTRUCTION from emit.js's `'for'` handler
(emission time) to a new `mintLoopPlans` pass in loop-model.js, run PRE-
EMISSION (from `analyzeFuncForEmit`, once per function, and from
`emitClosureBody`, once per closure — closures don't route through
`analyzeFuncForEmit` at all, a real gap caught before landing rather than
after), keyed by loop BODY node identity (`astLoopPlan`, a new WeakMap —
`body` chosen over the wrapping statement node because it's the one thing
common to every one of emit.js's three call shapes for "the same" AST loop:
plain dispatch, the typed-bounds guard's fast/checked-arm double-emission,
and `'while'`'s delegation to the `'for'` handler). emit.js now LOOKS UP the
plan (`astLoopPlan.get(bodyNode0)`) instead of building it; a miss skips the
link entirely (fail-open, pre-trio spec 2 — unchanged). No optimizer
consumer wired (unchanged scope) — {plan, lowering} split and the link's
ir.js home (audit-#15 item 5's ownership correction, directly above) are
untouched. This is the sequencing the audit asked for explicitly: pre-
emission AND BindingId-keyed (loop body identity) BEFORE any semantic
consumer exists, so a future consumer inherits a plan that was never
emission-order-dependent to begin with. Gates: byte-identity sweep, 57
bench/* cases (excludes jessie/jz/watr — graph/jzify-wired, out of scope) ×
O0/O2/O3 = 171 compiles vs a clean-HEAD worktree, 0 diffs (guaranteed by
construction: `plan` is read only by the JZ_DEBUG_INVARIANTS shadow-assert,
never by codegen). test/simd.js 158/158, kernel-parity 33/33, full battery
3409/3411 (same 2 pre-existing fails), JZ_DEBUG_INVARIANTS battery 3410/3413
(same 2 PLUS one flaky pin — `analyzeValTypes` declRange restamp for
`cf1_8`, audit-#12 item 2's own idempotence probe — reproduced byte-for-byte
on a clean HEAD worktree before concluding pre-existing), `npm run build`
×2 SHA-256 identical, test:self (selfhost.js 21/21; selfhost-perf.js's
warm-instance pin missed its cap but reproduced near-identically on a clean
HEAD worktree measured back-to-back — the same machine-contention class
Slice 3's own gates already banked, not a regression).

**First real consumption (architecture re-audit item 7) LANDED 2026-08-11**:
closes the gap the re-audit named — "until the vectorizer consumes it,
LoopPlan remains duplicate census work." Scope picked by evidence, not
guess: slice 4's `assertLoopPlanAgrees` shadow-assert is itself the proof of
WHICH facts are safe to flip — it has run the full battery +
JZ_DEBUG_INVARIANTS repeatedly since 2026-08-08 with zero divergences on the
IV-name comparison (`dollar(lowering.ivName) === bl.incVar`). vectorize.js's
single dispatch site (the `(block (loop))` scaffold match feeding
tryMemCopyFill/tryVectorize/tryReduceVectorize/tryMapReduceVectorize/
tryStencil/tryByteScan/tryToneMap/tryStrengthReduceIV — 8 recognizers
sharing one `bl`) now looks up `ctx.plans.loweringLinks` right after
matching `bl` and, when the link resolves an IV name, overwrites
`bl.incVar` with the plan-sourced name (`dollar(link.lowering.ivName)`) —
the WAT-derived name computed by `matchInc1`/`exitInfo` above (still run in
full, unavoidably: it's what locates the increment statement and validates
loop shape at all, not merely a name source) becomes the fail-open FALLBACK
on a link miss. Roles invert: `assertLoopPlanAgrees`, unchanged in code, now
checks the FALLBACK (the fresh WAT derivation, read before the override)
against the PRIMARY (the plan) — the same equality, opposite narrative —
instead of the other way around. Byte-identical by construction on every
hit (the assert already proves the two strings equal whenever it doesn't
throw; the override substitutes one proven-equal string for another).

Bound/hull NOT flipped — narrowed to the proven subset (banked finding).
`assertLoopPlanAgrees` only compares `plan.boundConst` against `bl.bound` in
the branch where `bl.bound` is ALREADY an `i32.const` WAT node — i.e.
exactly the one case where the WAT derivation is already the concrete
number in a single field read (`constNum(bl.bound)`), so consulting the
plan there buys nothing. The `boundLocal` (non-constant, `local.get`) case
is NEVER compared by the assert — no proof exists to license flipping it.
`plan.hull` (the [lo,hi] counter range) has no consumer or assert
comparison at all yet — same gap, unflippable until a future slice proves
it against something. **Finding banked**: the assert's own coverage is
narrower than "IV, bound, hull" — only IV name and the ALREADY-i32.const
bound case are proven; a future slice wanting to consume `plan.hull` or the
`boundLocal` case needs its OWN shadow-assert proof first (the same
discipline slice 4 followed), not an extension of this one's scope.

Consultation count (temporary `globalThis.__ITEM7_CENSUS` counters, gated,
reverted before commit — same method as architecture re-audit item 4's
census): across `node test/index.js`'s full default-tier suite, 12444 `bl`
matches, 12106 plan consultations (97.3% — consistent with slice 4's
originally measured 97.6% link-hit rate on the full battery corpus;
different corpus, same order). Each consultation is one WAT-derivation
(`matchInc1`'s name, downstream of the increment-statement scan) that no
longer needs to be the value 8 recognizers read — the STRUCTURAL scan
(`matchInc1`, `matchExitBrIf`) still runs (loop-shape validation,
unavoidable), but its returned NAME is now discarded in favor of the
plan's on a hit. This is the "duplicate census work" reduction the
re-audit asked for: one shared read (`ctx.plans.loweringLinks.get`)
replaces what was 8 recognizers each trusting a WAT re-derivation for the
same fact.

Gates (`b8279a23` baseline worktree vs. `07cefe7c`):

| check | result |
|---|---|
| 58-case × O0/O2/O3 byte-identity sweep (174 compiles, in-process sha256 vs isolated worktree at `b8279a23`) | 174/174 identical |
| `node test/simd.js` | 158/158 (582 assertions) |
| `node test/index.js` | 3419/3421 pass (same 2 pre-existing unrelated fails — interval-walk/typed-RMW codec bounds), 6 skip |
| `JZ_DEBUG_INVARIANTS=1 node test/index.js` | 3420/3423 pass (same 2 PLUS the known `cf1_8` idempotence flake, audit-#12 item 2's own probe) — 0 LoopPlan-agreement divergences (assertLoopPlanAgrees never fired) |
| `node test/kernel-parity.js` | 3/3 groups, 33/33 assertions, byte-identical WAT O2/O3 |
| `JZ_TEST_TARGET=jz.wasm node test/index.js` | 2716/2722 pass, 6 skip, 0 fail (matches the documented baseline exactly) |
| `node scripts/battery.mjs` (native/O0/O3/dbg/wasi/fuzz/fixpoint/build/kernel/self, internally parallel DAG) | BATTERY GREEN, exit 0 — the verdict line prints first specifically so it survives tail-truncation, and the harness's own process exit code (0) independently confirms `failed.length === 0` per the script's own logic; the captured log's tail (piped through `tail -80`, cut before the verdict re-printed) instead shows live per-leg O3/dbg/wasi diagnostic streams, all expected fail-closed/fail-open regression assertions, not failures |
| `node scripts/build-dist.mjs` ×2 | byte-identical SHA-256 (`32bb23f8…` jz.js, `ef42c9da…` interop.js, `207d9083…` jz.wasm) |

**Files**: src/optimize/vectorize.js (the dispatch site, ~20 lines: doc +
the `if (bl) { const link = ...; if (link && ...) bl.incVar = ... }`
block).

REMAINING: bound/hull consumption stays open (unproven — see finding
above). Slices 5-7 (memcpy/reduce/vectorize as their own units) collapse
into this one shared-dispatch flip since all 8 recognizers read the SAME
`bl.incVar`.

**Commit**: `07cefe7c`.

## [x] FunctionVariantPlan (architecture re-audit item 10) LANDED 2026-08-11

The audit's finding: five specialization analyses — fixed-rest arity
(`specializeFixedRestCalls`, plan/inline.js), bimorphic typed-elem split
(`specializeBimorphicTyped`, narrow.js ~2880), VAL-kind landslide dichotomy
(`specializeValKindDichotomy`), union-cursor carrier clones
(`specializeUnionCursorParams`), and guarded speculative typed clones
(`speculateTypedParams`) — each independently clone/name/register/copy-facts/
retarget a func variant, byte-for-byte duplicated mechanism five times. The
asks: keep the five ANALYSES separate PRODUCERS; make MATERIALIZATION
singular; make call-edge retargeting ATOMIC (the audit's own framing:
`site.node[1]` mutation alone leaves `site.callee` conceptually stale); move
`specializeValKindDichotomy`'s 0.9 dominance threshold to the pass registry.

**Commonality table** (byte-similar MECHANISM vs genuinely path-specific
POLICY, the BodyModel survey's facts-vs-policy discipline):

| step | fixed-rest | bimorphic typed | VAL-kind dichotomy | union-cursor | speculative typed |
|---|---|---|---|---|---|
| name mint | `${name}#restN`, idempotent reuse | ctor-combo suffix, disambiguated | dom-kind suffix, disambiguated | `$union`, disambiguated | `$spec`, disambiguated |
| clone build | shared shape | shared | shared | shared | shared |
| sig | CUSTOM (fixed+unrolled rest params) | CUSTOM (per-position ptrKind=TYPED) | DEFAULT (fresh copy, no ABI change) | CUSTOM (per-position ptrKind=OBJECT) | CUSTOM (per-position ptrKind=TYPED) |
| body | CUSTOM (`rewriteRestBody`) | DEFAULT (origin.body) | DEFAULT | DEFAULT | DEFAULT |
| register list/map/names | shared | shared | shared | shared | shared |
| paramReps copy+patch | none (pre-paramReps phase) | shared shape (typedCtor+val+joinKinds) | shared shape (val+joinKinds) | none normally (no kind change) | shared shape, EVEN with no origin reps |
| call-edge retarget | ALL sites + `setCallArgs` (path-specific extra) | PER-COMBO subset | PER-position-match subset | ALL sites | NONE (EMIT-time guarded dispatch) |
| side registry | none | none | none | `ctx.schema.inlineUnionCursors` | `ctx.types.specFns` |

**Extracted**: `materializeVariant({origin, key, name, sig, body, cloneFields,
paramReps, factOverrides, eligibleSites, fallback})` (new src/compile/variant.js,
sits beside neither narrow.js nor plan/inline.js since both consume it).
Handles the shared steps only: name-mint (two modes — `key`-keyed idempotent
reuse for fixed-rest's converging site-groups, vs disambiguate-on-collision
for the other four, which never expect reuse); clone-object construction;
`ctx.func.{list,map,names}` registration; paramReps copy+patch (one
reconciled rule replaces three different original semantics — write iff
there's a source reps map to copy OR an override with somewhere to land,
verified to reproduce bimorphic/valkind's always-present-reps case,
speculate's always-write-even-when-absent case, and union's skip-when-
neither case, all three exactly). Each path stays its own producer, deciding
whether/what/which; genuinely unique steps stay in the path as policy:
fixed-rest's body rewrite + arg-count trim, bimorphic's MAX_CLONES_PER_FN
polymorphic-blowup gate, union-cursor's `cursorsBySig` side table, and
speculateTypedParams' EMIT-time guarded-dispatch registration (`ctx.types.
specFns`) instead of a static retarget — noted, not contorted into the
shared function.

**Atomicity**: `retarget` inside `materializeVariant` always sets
`site.node[1]` AND `site.callee` together — no code path produces one
without the other. Grepped every `.callee` consumer to confirm the
staleness claim before fixing it: narrow.js's own ~15 `sitesByCallee`/
`cs.callee` scans (mostly pre-date the four late-phase specializations, so
unaffected by ordering), plan/literals.js's two `sitesByCallee` builders,
and — the one with real teeth — dyn-closure-tables.js's
`proveClosureFactory`, which filters `programFacts.callSites` by
`cs.callee === calleeName` POST-EMIT (`resolveDynFnTables`, called from
compile/index.js after every function has emitted) to verify a closure-
factory's default-closure param is never overridden at any of its call
sites — a stale `.callee` there is a real, if narrow, correctness-adjacent
gap for `devirtClosureTables` closure-table devirtualization.

**Migrated all five, one commit each** (`e5f503ab` union-cursor,
`31e76fe8` speculative typed, `0ddac820` VAL-kind dichotomy + DOMINANCE to
registry, `eeb28b8b` bimorphic typed, `9e941607` fixed-rest — last, because
it's the one whose clone-eligibility test (destructured single-array params
route through the SAME `.rest` machinery) turned out to exercise the
atomicity fix for real).

**The atomic fix isn't cosmetic — caught it live, not just in theory.** The
58-case × O0/O2/O3 byte-identity sweep (vs a disposable worktree pinned at
this session's start, `5746138f`) came back 171/174 identical; the 3 diffs
were all `watr` (jz compiling watr's own WAT-encoder source — the one
self-referential bootstrap case in the corpus), −174 bytes at every
optimize level. Root-caused by direct A/B toggle of the `.callee` write
alone (isolated with a debug harness, `JZ_DBG_FR`, fully stripped before
commit): `watr.js` contains `let g = ([a, b]) => b` called once with a
2-element array literal — a destructured single-array param IS represented
internally via `.rest`, so `g` is itself eligible for `specializeFixedRestCalls`
and gets retargeted to a `g#rest1` clone. Under the OLD split retarget,
narrowSignatures' own call-site census (filters by `.callee`) kept
attributing that site to the stale pre-specialization name `g` — so the
inferred `val: ARRAY` fact landed on the now-uncalled original, while the
clone actually being called got NO facts and stayed unnarrowed. The atomic
fix moves the fact to the function really being called, unlocking leaner
codegen for a param `narrowSignatures` had always been ABLE to prove, just
attributing to the wrong name. Verified BENIGN, not merely different:
instantiated both binaries (interop.js host) and ran the watr micro-
benchmark end to end — IDENTICAL checksum (`-875812435`) at O0/O2/O3,
confirming smaller codegen, not a behavior change. `test/types.js`'s
"destructured param element keeps whole-array kind" test asserted the fact
on `g` unconditionally — true only because of the very bug just fixed;
updated to check whichever of `g`/`g#rest1` actually carries it (same commit,
`9e941607`).

**DOMINANCE → registry**: `specializeValKindDichotomy`'s local `const
DOMINANCE = 0.9` is now `ctx.transform.optimize?.valKindDominance ?? 0.9` —
same value, `valKindDominance` added to src/passes.js `TUNING_KEYS`
(matching `scalarTypedArrayLen`'s own convention: a numeric knob no preset
currently overrides, default via `??`). `test/passes.js`'s registry-coverage
gate (every optimize-config read must be a registered pass or tuning key)
enforces the read site stays registered.

**Gate ladder** (`5746138f` baseline worktree vs `9e941607`):

| check | result |
|---|---|
| 58-case × O0/O2/O3 byte-identity sweep (174 compiles) | 171/174 identical — 3 explained + checksum-verified-benign (`watr`, above) |
| `node test/kernel-parity.js` | 3/3 groups, 33/33 assertions |
| `node --test test/passes.js` | clean (registry coverage incl. `valKindDominance`; formatting invariance) |
| `node test/index.js` | 3419/3427 pass (same 2 pre-existing: interval-walk codec-bounds, typed-RMW guard-coalescing), 6 skip — matches clean-baseline signature exactly |
| `JZ_DEBUG_INVARIANTS=1 node test/index.js` | 3420/3429 pass (same 2 PLUS the pre-existing `cf1_8` idempotence flake, audit-#12 item 2's own probe, unrelated subsystem) — matches clean-baseline signature exactly |
| `JZ_TEST_TARGET=jz.wasm node test/index.js` | 2716/2722 pass, 6 skip, 0 fail |
| `node scripts/build-dist.mjs` ×2 | SHA-256 byte-identical (dist/jz.wasm, dist/jz.js, dist/interop.js) |
| targeted correctness | struct-inline.js 17/17, dyn-closure-tables.js 8/8 (exercises the exact `.callee`-filtering consumer the atomicity fix targets), speculate.js 6/6, rest-params.js 33/33, types.js 178/178, inference.js 136/136, optimizer.js 217/219 (same 2 pre-existing codec-bounds flakes) |

**Verdict: LANDED.** All five paths migrated; zero output change except one
verified, checksum-confirmed inference improvement the atomicity fix itself
unlocked. `materializeVariant` is now the one place a sixth specialization
path (if one is ever needed) mints/registers/retargets a variant.

## [ ] Heap-epoch effect model (was heap-epoch-design.md; architecture re-audit item 5)

Design only, no `src/` changes. Model: one monotone counter per `SchemaId`
(`lattice-design.md` §2's own `SlotFacts` key space, no new identity type)
plus a shared "unknown-target" `⊤` counter that promotes today's `hz.all`
whole-program hazard boolean into a generation stamp — a fact stamped at
epoch E for key `sid` is valid to consume at read time iff E equals
`epochEff(sid) = max(epoch(sid), epochTop)`, closing the exact gap
`lattice-design.md` §6 risk item 1 named and left uncovered (a cached
`possibleKinds` reference read stale after a later join widened it).
Rejects a pure-global counter (schema census storage is already
per-`SchemaId`, `ctx.schema.slotFacts` et al., and per-sid locality is
load-bearing for `bench/provenance`/`bench/fftplan`) and a per-binding
counter (schema slot writes alias across many bindings; `ctx.js` already
documents `dictValueTypes`/`mapValueTypes` as deliberately not
scope-aware). Producer/consumer split: `SlotFacts`-shaped census +
`kindsCoverage:'closed'` claims get epoch-stamped; identity-keyed `WeakMap`
state (`bodyFacts`, `LoopPlan`, `ClosureEnvPlan`) and the `paramReps`
fixpoint's own `latticeMeet.changed` signal stay epoch-free by construction
(a stale `WeakMap` key can't be looked up; a fixpoint visits its own write
sites). 6 migration slices, Slices 0-4 byte-identical throughout (pure
caching-layer infra, mirrors `pf.gen`'s existing but coarser mechanism in
`program-facts.js`), Slice 5 the first to unlock a new consumer
(`kindsCoverage` exclusion, re-audit item 9(a)'s own stated blocker). Full
account: `.work/heap-epoch-design.md`.

## [ ] Heap-kind registry (was heap-kind-registry-design.md; audit-#13 item 3)

One per-tag authority (`layout-kinds.js`, repo root): 16 kinds × 7 columns
(tag, allocShape, childPointers, forwarding, identity, interopDecode,
typeofArm) — the composition point for carrier boxing × region relocation
(which previously had NO shared contract; the region tracer traps on unknown
kinds). Consumers DERIVE their arms from the table (err-codes.js
compile-time-table precedent), migration per-consumer byte-identity-gated;
divergence = a latent inconsistency FOUND. **Slice 1 LANDED**: table +
shadow-check suite (test/layout-kinds.js, ~42 tests); its 4 PTR.BIGINT
findings became carrier Slice 3's worklist. REMAINING: 2 __region_copy_rec
generated from the forwarding column (gated on regions re-enable), 4 interop
decode + i64exp lane fold-in, 5 carrier read-side derives arms from registry
(partially done via carrier Slice 3).

**Slice 3 LANDED** (2026-08-08, the "3 $__eq/$__map_hash arms generated"
item from the REMAINING list above): module/core.js's `$__eq` and
module/collection.js's `$__same_value_zero`/`$__map_hash` no longer inline
their content-identity dispatch text — they call generator functions
(`eqIdentityChain`/`sameValueZeroIdentityChain`/`mapHashStringArm`/
`mapHashBigintArm`) exported from layout-kinds.js, which is now imported by
module/core.js and module/collection.js (production-consumed, per audit-#14
item 4's demand — it stops being a leaf census). `$__eq_strict` needed no
generator: it fully delegates to `$__eq` (a thin nullish-exception wrapper),
no independent identity arm of its own.
STRUCTURED COLUMN (the audit's "executable fields" ask): KIND_REGISTRY.
{STRING,BIGINT} gained an `identityArm: { kind: 'content', order }` field
(every other kind has none — nothing reads one for them, matching the
file's existing optional-column convention for `findings`). `order` fixes
BIGINT before STRING in the generated tag-dispatch chain (the tags are
mutually exclusive, so this is a byte-match constraint on history, not a
soundness one) — `CONTENT_IDENTITY_ORDER` derives the kind list + order from
the registry, and every generator asserts it against the hard-coded shape
of its own hand-authored text, so a future registry change that adds/
reorders a content-identity kind fails CLOSED instead of silently drifting.
MIGRATION METHOD: the exact hand-written WAT spans were extracted
PROGRAMMATICALLY (paren-balance walk from each dispatch's opening `(if` to
its matching close, not manual transcription) into the four generator
functions verbatim, verified byte-identical against the original source via
a throwaway script BEFORE the production files were touched, THEN swapped
— the "prove equality, then move the source of truth" order the task
specified. Golden-text pin tests (test/layout-kinds.js) freeze this: `is(
eqIdentityChain(), <captured string>)` etc., 6 new tests — a future edit to
either the generator or (if it existed) a hand-written twin would show as a
string mismatch, not a distant behavior regression.
FINDING (identity-arm-divergence, layout-kinds.js FINDINGS, cross-referenced
from KIND_REGISTRY.STRING.findings) — surfaced by extracting the two
eq-style chains verbatim, NOT papered over: `$__eq` and `$__same_value_zero`
realize the SAME registry fact (STRING = content identity via `__str_eq`)
with two real textual differences. (1) `$__eq` re-guards EACH operand with
`f64.ne($fX,$fX) && tag===STRING` before dispatching (defends against a
finite, non-NaN number whose bit pattern happens to alias the STRING tag —
`$__eq`'s own comment names "ASCII content read as f64" as the concrete
case); `$__same_value_zero` checks only the tag, with no such re-guard — a
narrower defense than `$__eq`'s own stated reasoning says is needed. (2)
`$__eq` additionally short-circuits when BOTH operands are STR_INTERN_BIT-
marked (skips the `__str_eq` call — bit-different canonicals can never be
content-equal); `$__same_value_zero` has no such short-circuit, a missed
instance of the same optimization `$__eq` already applies. NOT unified by
this slice (explicit mandate: move the source of truth, not the behavior)
— each consumer keeps its own generator function, preserving its own
history byte-for-byte; a future slice can re-derive whether `$__eq`'s extra
guard is load-bearing before either narrowing it or widening
`$__same_value_zero`.
GATES (2026-08-08): per-arm byte-identity proof — all 4 generators verified
byte-identical to the captured hand-written text at migration time (script,
not committed as a test) + 6 golden-text pin tests in test/layout-kinds.js
(51 tests total in that file now, all green, incl. under
`JZ_DEBUG_INVARIANTS=1`). Full battery, kernel-parity 33/33, opt0/opt3/wasi,
selfhost leg (selfhost.js 21/21; selfhost-perf.js's warm-instance pin is
machine-noise, see the isolation evidence under §FeaturePlan freeze Slice 3),
and the 189-case size-sweep are the SAME combined verification pass reported
there (both slices landed together) — 0 byte diffs, 2-3 pre-existing
unrelated failures depending on leg. `npm run build` ×2 SHA-256 identical.

**Slice 4 LANDED** (2026-08-09, audit-#16 registry finding — the production
dist-cost fix for Slice 3's landing): Slice 3 put KIND_REGISTRY on the
production import path (module/core.js, module/collection.js's generators
iterate it) without splitting its PROSE columns (allocShape, childPointers,
forwarding, interopDecode, typeofArm descriptions, findings) off first —
esbuild's minifier strips JS comments but not string-literal PROPERTY
VALUES, so that prose rode into dist/jz.js verbatim and, via the generated
WAT text it fed, into dist/jz.wasm too: audit-#16 measured +19,613B /
+60,511B on Slice 3's landing. FIX: split into layout-kinds.js (compact
EXECUTABLE metadata only — per-kind `{tag, aux, identity, identityArm}`,
enums/numbers/short symbols, no prose; this is what module/core.js and
module/collection.js import) and layout-kinds-doc.js (NEW file, root —
imports and EXTENDS the compact table with the full prose under
`{auxNote, allocShape, childPointers, forwarding, identityNote,
interopDecode, typeofArm, findings}` plus the FINDINGS array; test-only,
never imported by module/*.js). No information lost — every prose string
relocated verbatim, not rewritten or summarized. test/layout-kinds.js
imports both (52 tests now, was 51 — one new cross-check that the doc
table's compact columns haven't diverged from the production table).
GENERATOR TABLE-DRIVEN VERDICT: evaluated a genuine loop-driven synthesis
(iterate CONTENT_IDENTITY_ORDER, emit each arm from a shared template)
instead of the four hand-written, individually-guarded generator functions
— rejected: with only 2 content-identity kinds and $__eq/$__same_value_zero
carrying a REAL textual divergence on the STRING arm (FINDINGS[identity-
arm-divergence], unchanged by this slice), any shared-template rewrite
changes the generated WAT text by construction. Byte-identity with the
pre-split generated output wins over collapsing "2 hand-written functions"
into "a loop of 2" — the guarded hand-written form (assertContentOrder fires
closed on drift) stays, documented in layout-kinds.js's own comment block.
GATES (2026-08-09): dist size recovery — dist/jz.js -17,454B (2,096,051 →
2,078,597), dist/jz.wasm -50,441B (16,908,182 → 16,857,741), both measured
against a clean-HEAD (229cd670, pre-split) `npm run build` baseline; the
residual gap vs Slice 3's full +19,613B/+60,511B addition is the compact
table's own footprint (tag/aux/identity enums — intentionally still present,
since production still needs SOME per-kind data, just not the prose) · 58-
case/174-compile bench corpus (all non-self-referential bench/ cases incl.
watr × O0/O2/O3, jessie/jz excluded) compiled against the same clean-HEAD
baseline via a scratch diff script — 0 WAT-text diffs, 0 compile errors ·
test/layout-kinds.js 52/52 (plain and `JZ_DEBUG_INVARIANTS=1`, 203
assertions under the flag) · full battery 3408/3416 pass (19,570 assertions;
2 pre-existing unrelated codec-bounds fails, 6 skip — same rows as Slice 3's
own gate) · kernel-parity 33/33 (33 assertions, O0+O2+O3) · selfhost leg
(selfhost.js 21/21, 206 assertions) · two fresh `npm run build` runs,
dist/jz.js + dist/interop.js + dist/jz.wasm SHA-256 byte-identical across
both.

## [ ] FeaturePlan freeze (was featureplan-freeze-design.md; audit-#13 item 2)


`ctx.features` is one mutable bag written across four phases; contract
enforced by nothing — the bigint module-ordering hazard + absent-dyn-key
kernel misfire (subnormal export bug) already paid for this. Design: declare
strata — SESSION {sso, blockingTimers} (reset, from opts) · PROGRAM {bigint,
error, errorClasses, timers} (prepare prescan, order-independent) · ANALYSIS
{typedView} · DEMAND {external, typedarray, set, map, closure, f16, clamped}
(emission-accumulated monotone false→true, readable only at
resolveIncludes()+). SURVEY FINDINGS: `f16`/`clamped`/`typedView` are
written/read but UNSEEDED in the ctx.js:628 init — violating its own MUST
("seeded, not an absent key", the bigint precedent class). Enforcement =
existing assertCtxInvariants pattern (subset-safe, no Proxy): stratum
snapshots at post-prepare/post-analyze, compared at pre-assemble.
REFINED per audit-#14 item 3 (strata alone formalize today's ordering
without producing a frozen plan): split the STRUCTURE, not just the
contract — `ctx.features` becomes the FROZEN FeaturePlan (SESSION+PROGRAM+
ANALYSIS facts only, genuinely immutable after analyze) and the DEMAND
stratum moves OUT into `ctx.linkDemand` (monotone false→true helper/runtime
reachability produced by emission, read only by resolveIncludes/assemble —
the inc()-sibling channel it always semantically was). Emission then never
writes ctx.features at all; the freeze is real, not a convention.
Slices: 1 seed+declare+assert on the current bag (gate: byte-identity on
size-sweep — a byte shift from dict-shape change is a FINDING), 2 the
linkDemand extraction (~13 write sites + the module-template readers), 3
reader-contract grep sweep, 4 post-carrier bigint gate retirement (bigint
stays a frozen PROGRAM fact gating stdlib arm size).

**Slices 1-2 LANDED** (2026-08-07). Slice 1: seeded `f16`/`clamped`/`typedView`
on ctx.js's `ctx.features` init; regrouped the dict into the four documented
strata; extended `assertCtxInvariants` with a snapshot/compare — SESSION+
PROGRAM snapshotted at 'post-prepare', +ANALYSIS at 'post-analyze' (both new
phase names, fired from inside compile/index.js's `compile()` itself — so
they run host- AND self-host-uniformly, unlike 'post-prepare'/'post-compile'
which only the host wires today), compared + presence-checked at
'pre-assemble' (new call site, right before pullStdlib's resolveIncludes()).
FINDING (predicted by the design's own "byte shift is a FINDING" gate, but
surfaced as a *drift* finding, not a *byte* one — bytes stayed identical):
`typedView` is NOT actually settled by post-analyze. Besides analyze.js's
static tracker (only catches the NAMED-BINDING 3-arg `new T(buf,off,len)`
view form), module/typedarray.js's constructor EMIT handlers also set it —
1-arg buffer-reinterpret, unknown-arg-type dynamic dispatch, and any
view-construction not bound to a name are only discovered when emission
walks those call sites, past post-analyze. Live evidence: test/buffer.js's
reinterpret/COPIES cases tripped a hard frozen-equal check. Banked, not
forced: `typedView` is checked MONOTONE (present, never true→false) instead
of frozen-equal; every other stratum key is still exact-equal. This means
typedView is mis-stratified in the design above (DEMAND-shaped in practice,
not ANALYSIS-shaped) — left as ANALYSIS per the brief, carve-out documented
in ctx.js at the point of use; a future slice could reclassify it formally.

Slice 2: `ctx.linkDemand` created beside `ctx.features` (same seeded-dict
discipline, all 7 keys default false) and the DEMAND stratum — external,
typedarray, set, map, closure, f16, clamped — moved out. 31 writer sites
migrated (src/compile/emit.js ×3, emit-assign.js ×3, index.js ×2,
module/typedarray.js ×12, module/function.js ×1, module/core.js ×5,
module/string.js ×2, module/crypto.js ×1, module/collection.js ×2) and every
reader (module/array.js, module/core.js, module/collection.js — all
resolveIncludes()+/deps-lambda/template-factory sites, confirming the design's
"read only at resolveIncludes()+" claim held with ZERO emit-time reads found
outside module/*.js). Added the emission-time write tripwire: `setFeature()`
(ctx.js) — every SESSION/PROGRAM/ANALYSIS writer now routes through it;
throws under JZ_DEBUG_INVARIANTS if any key other than typedView (monotone
exempt) is written after 'post-analyze', naming the call site instead of
waiting for the lazy pre-assemble check. Hazard found + fixed en route: the
tripwire's `_postAnalyze` module-scope flag was cleared only on the optional
'post-reset' phase call — raw `reset()`-only callers (test/types.js's
`runAnalyze` and siblings, which never call beginSession/assertCtxInvariants)
leaked a PRIOR compile's `_postAnalyze=true` into their own unrelated
prepare-time writes, false-tripping the guard. Fixed by clearing the state
inside `reset()` itself (the one entry point every caller uses), not only at
the phase call site.
GATES (2026-08-07): byte-identity on the bench/ size-sweep (57 cases incl.
watr 257699B, fftplan/provenance/wordcount/json) — IDENTICAL pre- vs post-
slices-1+2. kernel-parity 33/33 (11×O0/O2/O3). Full battery green except one
PRE-EXISTING failure confirmed identical on unmodified HEAD 3bc5fbb7 (typed
RMW guard-count pin, test/optimizer.js — unrelated, a bounds-check-count
assertion) — reproduced on a clean `git worktree` baseline before concluding
it wasn't a regression. test:self (selfhost.js 21/21 + selfhost-perf.js)
green except the SAME pre-existing warm-instance perf-pin miss, reproduced
byte-for-byte-close on baseline (1.095/1.123/1.121× vs 1.098/1.126/1.126×) —
machine noise, not a regression. Fresh `npm run build` ×2: dist/jz.js,
dist/interop.js, dist/jz.wasm all SHA-256 identical.

**Slice 3 LANDED** (2026-08-08): the mis-stratification Slice 1-2 banked (not
forced) — `typedView` checked monotone instead of frozen-equal — is resolved
by moving it, not by tightening the check. `typedView` reclassified from
ctx.features' ANALYSIS stratum to ctx.linkDemand's DEMAND stratum (where its
write pattern always belonged): FEATURE_STRATA.ANALYSIS is now `[]` (kept as
a named stratum for the next genuinely analyze-settled fact, not deleted);
ctx.linkDemand gained a seeded `typedView: false` key beside its six existing
DEMAND flags. Writers migrated: analyze.js:151's static `.view`-ctor tracker
and module/typedarray.js's four view-constructing EMIT handlers (`new.*`'s
subview/reinterpret/unknown-arg branches, `.typed:subarray`) now write
`ctx.linkDemand.typedView = true` directly (module/typedarray.js's own
factory closure already has `ctx` in scope, matching every sibling
`ctx.linkDemand.*` write there) instead of routing through `setFeature()`.
Reader migrated: optimize/vectorize.js's SLP store-pairing bail (~line 7114)
now reads `ctx.linkDemand.typedView`. `setFeature` dropped from both writer
files' imports (its only remaining callers — autoload.js's `timers` and
prepare/index.js's `bigint`/`error` — are genuine PROGRAM-stratum facts,
unaffected).
PHASE-ORDERING VERIFIED (the task's explicit ask): compile/index.js emits
every function AND closure body (emitFuncs at line ~2405, emitClosures,
buildStartFn — the only writers left after this migration) before
`assertCtxInvariants('pre-assemble')` (line ~2531), which itself precedes
both `pullStdlib`/resolveIncludes (line 2533) and `optimizeModule` (line
2539) — the phase vectorize.js's SLP pass actually runs in. So the read is
not merely within linkDemand's documented "resolveIncludes()+" contract, it
is LATER than resolveIncludes() itself: every writer has settled by the time
the reader fires, by construction, with no ordering hazard. Documented at
the point of use (ctx.js, the `ctx.linkDemand` block comment) rather than
left implicit.
Freeze itself is now genuinely uniform: the monotone carve-out in both
`setFeature()` (the post-analyze write tripwire) and `assertCtxInvariants`'s
pre-assemble snapshot-compare is gone — every remaining ctx.features key
(SESSION+PROGRAM; ANALYSIS is empty) is exact-equality frozen from
post-analyze on, no exceptions. Verified live: test/buffer.js's
reinterpret/COPIES cases and test/slp.js's view-bail cases — the ones that
forced the original carve-out — pass unchanged under
`JZ_DEBUG_INVARIANTS=1` (they no longer touch ctx.features at all).
GATES (2026-08-08): a from-scratch byte-identity sweep (v2, corrected — see
the process note below) across every bench/* case excluding the two
GRAPH_CASES (jessie/jz, which need resolveModuleGraph's bespoke wiring, out
of scope) — 63 cases × O0/O2/O3 = 189 real compiles, sha256-hashed, HEAD
0e6870f9 vs working tree — 0 diffs. Plus 5 extra typed-array/view/SLP/
BigInt-identity/String-identity probes × 3 opt levels, also 0 diffs. Full
battery: 3400/3402 pass (2 PRE-EXISTING failures, test/optimizer.js's
interval-walk and typed-RMW guard-count pins — reproduced identically on a
clean HEAD worktree, unrelated to this slice). kernel-parity 33/33
(11×O0/O2/O3). opt0/opt3/wasi legs green (opt0/opt3: same 2 pre-existing
misses; wasi: those 2 PLUS a 3rd, test/pointers.js's carrier ternaryBoxedNames
pin, wasi-host-specific — all 3 reproduced identically on clean HEAD under
`JZ_TEST_HOST=wasi`. `npm run test:matrix`'s `&&` chain does NOT actually run
past `npm test` since it exits 1 on the pre-existing failures — legs run
individually instead). test:self: selfhost.js 21/21; selfhost-perf.js's
fresh-instance pin passes, its warm-instance pin fails — but reproduces
IDENTICALLY on an unmodified baseline measured back-to-back in the same
session (baseline 1.103×/1.120×/1.130× vs working tree 1.109×/1.129×/1.128×,
both over the 1.03× cap; the SAME baseline measured earlier in the session
passed at 1.013×) — machine contention from concurrent work on this shared
dev box (another session committed 37e3f6a4 mid-task), not a regression;
isolated further by building+testing Slice 3's changes alone in a fresh
worktree (1.11-1.13×, same range) and confirming Task 2's changes alone
pass cleanly in a quiet moment (1.018×) — the signal tracks machine load,
not either slice's diff. `npm run build` ×2: dist/jz.js, dist/interop.js,
dist/jz.wasm SHA-256 identical.
PROCESS NOTE: the first byte-identity sweep attempt silently hashed IDENTICAL
ERROR STRINGS (missing benchlib module wiring) for all 189 cases instead of
real compiled output — a false-positive "0 diffs" that would have shipped
unverified. Caught before relying on it (the compile() return-shape check:
bare bytes vs `{wasm,...}` only when `opts.inspect` is set) and redone
properly against scripts/bench-size.mjs's actual jzCompileSize wiring.

**Slice 4 (post-carrier bigint gate retirement) — audit-#16 differential
fixture run, STILL BLOCKED** (2026-08-09). The slice list above named item 4
as "bigint stays a frozen PROGRAM fact gating stdlib arm size" — i.e. the
open question is whether `bigint`'s freeze can be made GRAPH-complete (not
just phase-complete within one `prep()` pass) without reopening the carrier
tension §6 of carrier-representation-design.md already named. audit-#16
asked for the differential fixture directly: a cross-module case with
BigInt use ONLY in a later-imported module, an earlier-imported module
materializing `$__to_num`. Built and run (`test/kernel-oracle.js`, KNOWN-
FAIL tier) — RED at both native and kernel legs, all optimize tiers,
confirming the gap is real and CURRENT, not historical. Root unchanged from
the original hunt (prep()'s per-node `includeForOp` vs bigint-construction
check ordering, now confirmed cross-module via `prepareModule`'s separate
per-module `prep(ast)` calls). NOT re-attempted: the whole-tree-prescan fix
was already verified+reverted in the original hunt (`.work/todo.md`, "JSON
SHAPED-PARSER … BANKED NOT FIXED") because layout.js's real BigInt syntax
(re-confirmed present today) makes the self-hosted compiler's own source
non-bigint-free, so a graph-complete scan flips the kernel build's flag
true and regresses the subnormal-literal AGREE test. Slice 4 stays BLOCKED
on the same fork §6 names: (a) scrub layout.js's BigInt syntax to plain
hi/lo-split Number arithmetic first (removes the false "compiler source has
BigInt" signal, letting a graph-complete scan freeze correctly for BOTH
target programs and the compiler's own self-hosted build), or (b) a non-
boolean carrier-disambiguation redesign. Full root-cause + fixture detail:
`.work/todo.md` §"FeaturePlan whole-graph oracle: differential fixture
BANKED, not fixed (audit-#16)".

**Post-carrier-flip retirement attempt — ATTEMPTED, WALL HIT, REVERTED
(2026-08-10, carrier-representation-design.md §36).** After §35's default
flip, a SECOND angle was tried: not the graph-completeness fix above, but
retiring the AMBIGUITY-HEURISTIC half of `ctx.features.bigint`'s job
(narrower than full freeze — keep the STDLIB-ARM-SIZE half as-is, gate only
the subnormal-magnitude fallback in `toNumF64`/`$__to_num`/`TYPEOF.bigint`
behind `!CARRIER_BOX`) on the theory that a boxed program's every reachable
BigInt is proven-boxed, so the heuristic is dead weight under the default.
DISPROVEN with a live regression (`test/watr.js`'s memory64-limits pin,
plus a minimal isolated repro): `carrierF64`'s boxing chokepoint only boxes
BigInt values at genuine STORAGE-SINK positions (object/dyn-prop/array-elem
store, Set/Map, closure capture, proven call-args) — BY DESIGN, per
`test/data.js`'s own sibling test ("internal calls keep the i64 carrier").
An internal/transient BigInt expression (arithmetic result, bare `return`
value) never crosses a sink and stays RAW even under default `CARRIER_BOX`,
so the ambiguity the heuristic guards against is exactly as live there as
under the opt-out. `$__to_num`/`TYPEOF.bigint` are shared, call-site-
agnostic bodies serving BOTH provenance classes at once, so a blanket
`CARRIER_BOX` gate is unsound — it silently breaks the internal-value class
(confirmed: a real BigInt began reading `typeof … === 'bigint'` as false,
and `Number()` returning `0` instead of the true value). Fully reverted
before landing (`src/ir.js`, `src/compile/emit.js`, `module/number.js`,
`test/data.js`, `README.md` restored to HEAD `34b23b07`, verified clean via
`git status`/`git diff --stat` and by re-passing `test/watr.js` 35/35).
Slice 4 stays BLOCKED — now on TWO independent, named blockers (the
pre-existing ordering-scan gap above, AND this session's provenance-
discrimination gap) — full detail + what a sound next attempt needs:
carrier-representation-design.md §36.

## [ ] Region arena (was region-arena-design.md + slice1-build + slice1-liveness + kernel-memory-curve; DORMANT)

Evidence (kernel-memory-curve, 2026-08-06): the bump arena's
retain-everything cost ACCELERATES with input size — jessie 60KB graph →
1.07GB peak, watr 104KB → 4.295GB (bare wasm32 ceiling), jzify-entry 406KB
and the full 5.6MB jz×jz graph → deliberate __memgrow unreachable (>4GiB
need). Confirmed genuine exhaustion (A), not address-signedness (B) — though
one real B-class bug was found+fixed en route (__alloc un-widened i32 bump
at the true ceiling → now sound trap). No signedness patch creates headroom:
the jz×jz bench row needs regions.
Design: `__region_mark()` (save bump top) / `__region_exit(mark, roots)`
(Cheney-copy live tree above mark to a compacted block built at heap top
with pointers pre-adjusted by final delta, one closing memory.copy;
forwarding headers at old sites heal stale refs through the SAME
__ptr_offset forwarding chase durable relocation already uses). Survivors
identified by ROOT (each phase has one dominant output), not ctx tracing.
Liveness measurement (GO): churn/live 574-2342× sustained per round; Slice 1
(fixpoint-round region) removes cross-round accumulation only (~979MB /
25.8% on watr-graph); the ~1GB target needs Slices 1+2 (front boundary)
paired; Slice 3 (emit/encode boundary) unlocks jz×jz under 4GiB.
Slice 1 BUILT (module/core.js primitives beside __clear) with 3 hazard
fixes found live: (a) dirty/snapshots watr bookkeeping must be region ROOTS
(backing-table grow mid-round would be reclaimed — real corruption), (b)
SET/MAP always rebuild via __coll_order+reinsert (slot position is
hash-of-key — an in-place patch would leave entries in wrong buckets), (c)
durable ARRAYs still walk elements in place (grow-in-place containers hold
non-durable refs). OBJECT/HASH/CLOSURE/TYPED/BUFFER/EXTERNAL trap rather
than silently mishandle (registry Slice 2 retires this).
DORMANT: hooks commented in scripts/self.js. O2 green after the 3 fixes; O3
= fusedRewrite×treeshake joint interaction + an address-layout-sensitive O2
heisenbug (banked, hardest open class). Re-enable gated on the watr
regionHooks API publication (USER-owned dependency; pristine watr 5.7.12
restored in node_modules) + the O3 hunt; warm checkpoint then gates SHIP.

RE-TEST (2026-08-10/11, watr 5.7.13 regionHooks published — shape verified:
opts.regionMark?.()/opts.regionExit(mark,[ast,dirty,snapshots]) in
node_modules/watr/src/optimize.js:8395/8460 matches self.js's dormant
`{mark:()=>__region_mark(), exit:(mark,root)=>__region_exit(mark,root)}`
exactly, and module/core.js's __region_mark/__region_exit intrinsics (2419-
2420) match both ends). Re-wired, rebuilt: **both original banked walls are
DEAD on the curated corpus** — kernel-oracle 13/13 (493 assertions) × 5
clean reps at O0/O2/O3 (dvnested-mechanism, the original tripwire, traps
zero times), kernel-parity 33/33 byte-identical at O0/O2/O3, zero flakes.
The 3 hazard fixes already landed in module/core.js's __region_copy_rec/
__region_relocate_props (dyn-props sidecar migration, dead code while
dormant) are confirmed live-correct — that's what killed the O2 wall. The
O3 fusedRewrite×treeshake wall is also gone on this corpus; not isolated
which of watr 5.7.13's devirt stale-selector fix (e336177) vs. the O2 fixes
killed it, and it no longer matters — moot once the curated corpus is clean.

**A NEW WALL, found by broader coverage the curated 13-program suite never
exercised**: an isolated re-run of test:wasm's own fuzz GATE (`fuzz({count:
200, seedStart:1, inputs:12, inputSeed:7, optLevels:[0,1,2,3]})`, the exact
object `npm run test:wasm`'s "no new miscompiles in seeds 1..200" test
uses) found **7/200 real findings**, all `jz-compile` kind, `memory access
out of bounds`, O2-only (seeds 32/101/157) or O3-only (36/69/103/161), zero
at O0/O1. **Confirmed region-caused by direct A/B**: the same 7 seeds, same
process, rebuilt with hooks dormant — 0 findings, clean. Reproduces
deterministically in an isolated single-process run (200-600ms/seed, ample
free memory) — not a swap/contention artifact (the session's machine did
independently hit a near-exhausted-swap condition, 15.99/17.4GB used,
matching a previously-diagnosed environment-artifact signature from an
earlier ledger entry, but the traps were verified to reproduce cleanly
*without* that condition present at verification time). Two minimal repros
banked: seed 69 opt3 (`export let f = (p0) => { let v0 = p0; let v1 =
Math.trunc(0); v1 = (-(Math.min(Math.ceil(5), (~(Math.sqrt(v0)))))); let v2
= Math.imul(Math.round(v1), v0); return Math.max((-(Math.min((p0 % v2),
(((v0 >= v1)) ? (v2) : (0))))), p0); }`) and seed 161 opt3 (longer,
adds a `while` loop — see session transcript). Both are plain scalar f64
arithmetic (Math.trunc/min/imul/ceil/sqrt/round over one param) — no
arrays, closures, dicts, or typed arrays — meaning the hazard is OUTSIDE
the design's own hazard inventory (SET/MAP rebuild, durable-array in-place
walk, dyn-props sidecar), a genuinely new, not-yet-understood mechanism.
NOT root-caused this session (no time to bisect which region-copy path
drops or corrupts state for pure-scalar function bodies).

**Per the stop-on-fail tripwire**: hooks reverted to DORMANT again
(scripts/self.js's regionHooks line re-commented — `git diff` against HEAD
is empty), dist/jz.wasm rebuilt dormant and reverified clean (kernel-oracle
13/13/493, kernel-parity 33/33 byte-identical). The rest of the mandated
ladder (test:wasm full run, selfhost, fuzz 2000×2, build×2 byte-identity,
memory watermark curve, jz×jz) was NOT run — gated on the wall being dead,
and it isn't. `npm test` (native battery) WAS run once against the
region-live build before the fuzz leg exposed the wall: 3419/3427 pass, the
2 known-banked pre-existing fails (interval-walk/typed-RMW codec-bounds
rows) unchanged, 6 skip — no NEW native-battery regression; the wall is
specific to the self-hosted kernel target.

**Recommendation**: next session, root-cause the scalar-only region-copy
hazard using the two banked repros (cheapest entry: instrument
__region_copy_rec/__region_exit the same way the original root-cause
session did — dbg globals for stage/rounds/kind — on seed 69's ~230-char
repro directly via kernel-target.js, no fuzz harness needed) before any
further re-enable attempt. Re-enable stays gated on that fix.

**ROOT-CAUSE ATTEMPT (2026-08-11), disposable worktree — verdict: RUNTIME
TRAP in the kernel's own execution, not a target miscompile; mechanism
narrowed one layer deeper, wall NOT closed, shared tree untouched, tripwire
held.** Worked in a git worktree under the session scratchpad (branch
`region-live-investigate` off `69c2994a`, node_modules copied from the
shared tree — watr 5.7.13 confirmed), regionHooks re-wired there only
(`git diff` against `69c2994a` in the real tree is empty throughout).

*Miscompile vs. runtime trap, resolved*: `compileWat(seed69Src, {level:3})`
(watr/kernel-target.js's own `--wat` leg, no target execution involved,
just WAT-IR text out) traps IDENTICALLY to the bytes leg — same message,
same seed, same opt level. Since `wat:true` never runs the TARGET program,
the trap is unambiguously inside the KERNEL's OWN execution while compiling
seed 69, not a bad address baked into the target's emitted WAT that only
manifests when THAT wasm runs. There is no target WAT to diff (region-live
never produces one for this repro — it dies mid-compile), so step 2's
"diff target WAT region-live vs dormant" doesn't apply here; confirmed via
direct trap-message inspection instead.

*Mechanism, narrowed*: instrumented `__region_copy_rec`/`__region_exit`
(module/core.js, worktree-only) with breadcrumb globals (`declGlobal`,
exported) recording stage/kind/off/mark/delta/newOff/round, updated in
program order — a synchronous wasm trap leaves the instance's globals
intact, so the LAST value written is the last checkpoint reached. Finding:
for seed 69 opt3 on that (differently-perturbed, see heisenbug note below)
build, `__region_exit`'s ROUND-2 call reaches its own FINAL instruction
cleanly (stage marker placed as the literal last `global.set` before the
return expression fires; `rounds=2`, `calls=1200`) — **the region
copy/relocate traversal itself does not trap**. The trap fires downstream,
after control returns from a clean `__region_exit`. Decompiled that same
kernel binary with `wasm2wat --enable-all` (wabt 1.0.36, vendored at
`/Users/div/projects/watr`'s repo-neighbor checkout) and read the Node
`RuntimeError`'s own stack (`wasm-function[N]:0xOFFSET` frames, present
even without a name section): the trap is `unreachable` inside
`wasm-function[12]`, whose body byte-for-byte matches module/core.js's
hand-written `$__alloc` template (bump pointer, `align8(heap+bytes+7)`,
`if (next < ptr) unreachable` — the documented unsigned-wraparound guard).
Its caller (`wasm-function[3053]`, ~70 locals, thousands of lines) is a
single MASSIVELY FUSED function — confirmed by cross-checking a NAMED WAT
of the SAME self.js/watr module graph (compiled directly via `compile(g.code,
{modules:g.modules, optimize:{level:3,...}, wat:true})`, replicating
build-dist.mjs's own call exactly): watr's own `runRounds` (node_modules/
watr/src/optimize.js:8381, the function that calls `opts.regionMark?.()`/
`opts.regionExit(...)`) has NO surviving named function in the O3 output —
fully inlined, consistent with scripts/self.js's own prior-session note
that `$__ptr_type`/`$__ptr_aux` "end up with ZERO remaining func defs" at
O3. Net: `$__alloc` is called with a garbage (wraparound-triggering) size
from deep inside watr's own fused round/rewrite machinery, AFTER a clean
region_exit — i.e. the CLASS is exactly the design's own named risk, "a
cache we didn't anticipate": something downstream holds a decoded
length/offset computed BEFORE the round-2 boundary and feeds it to a
POST-boundary allocation without re-deriving it through the forwarding-
aware `__ptr_offset` accessor. `inlinePtrOffsetFast` (src/passes.js:48,
"speed-tier only... inline __ptr_offset's loop-free body... at each
surviving call site — the cold relocation-chase call stays out-of-line")
is the standing suspect named in this session's own brief and fits the
shape (build-dist.mjs compiles self.js at `level:3`, so this pass IS baked
into the kernel's own compiled watr internals) — NOT confirmed as the
specific culprit this session; the fused caller is too large to bisect by
reading alone in the time available.

**Heisenbug reconfirmed, one layer worse than previously documented**: the
2026-08-06 entry above already found that 5 UNRELATED debug globals added
to module/core.js flipped an O2 pass/fail. This session found the SAME
class strikes even a single extra function's worth of instrumentation:
- Build A (region_copy_rec/region_exit breadcrumbs only): seed 69 opt3
  traps `unreachable` inside `$__alloc` (the finding above).
- Build B (Build A + 3 more `global.set`s inside `$__alloc` itself,
  recording its own `bytes`/caller-count/return-ptr): seed 69 opt3 compiles
  CLEANLY — zero trap, all 3 rounds complete (`rounds=3, calls=1898,
  alloc_calls=76995`) — confirmed regions genuinely ran (not silently
  disabled) via the same debug globals. Seed 161 opt3 ALSO went clean on
  this build.
- The UNINSTRUMENTED region-live binary (saved copy, zero source changes
  from the `69c2994a` re-test) traps `memory access out of bounds`
  (matching the original bank exactly) 3/3 repeat runs, fully deterministic
  for a FIXED binary — this is a real, stable bug, not scheduler/GC noise.
  It is the CHOICE OF BINARY (any change to module/core.js, even inert
  extra globals in a hot function) that is unstable, consistent with an
  address/allocation-COUNT-sensitive corruption (a race between a stale
  cached decode and a bump-pointer offset that only collides under specific
  allocation-ordinal conditions), not a logic bug that reproduces
  identically under any recompile.

**Consequence for method**: source-level breadcrumb instrumentation is a
poor tool for this specific bug — every attempted observation changes the
observed behavior (Heisenberg in the literal sense: the debug write itself
is a memory operation that shifts allocation offsets downstream). A
different technique is needed next: e.g. (a) a UNIVERSAL validity check
wrapped around every `$__alloc`/`$__alloc_hdr*` call site's `bytes`
argument (assert `bytes < some sane ceiling` before the existing wraparound
guard, on the UNINSTRUMENTED-shape binary, i.e. edit only the guard
condition, add no new globals/locals) — cheapest single-line perturbation,
most likely to preserve the "memory access out of bounds" manifestation
rather than dodge it; (b) bisect watr's OWN pass list (as the 2026-08-06
session did for the O3 `$__ptr_type`/`$__ptr_aux` joint-necessity finding)
with `inlinePtrOffsetFast` as the FIRST ablation candidate (build-dist.mjs
can pass `optimize:{level:3, inlinePtrOffsetFast:false, ...}` for the
KERNEL's OWN build — a one-line build-dist.mjs edit, no module/core.js
churn, so it doesn't perturb layout the same way); (c) if (b) clears the
wall, that CONFIRMS the class without needing to isolate the exact call
site inside the fused function.

**Per the stop-on-fail tripwire**: worktree-only, `69c2994a`'s tree
verified untouched (`git status`/`git diff` clean except the pre-existing
untracked `todo-original.md`) — regionHooks stayed dormant in the shared
tree throughout. Gate ladder (kernel-oracle/kernel-parity/fuzz-2000×2/
battery/test:wasm/build×2/memory curve/jz×jz) NOT run — gated on the wall
being dead, and it is not; narrower now, but still open. Worktree removed
at session end.

**ABLATION CONFIRMED + CLASS FIX LANDED (2026-08-11), disposable worktree
(`region-ablation-2026-08-11` off `3c286c88`, node_modules copied — watr
5.7.13 confirmed) — verdict: inlinePtrOffsetFast IS the mechanism.**
Named angle (a) from the prior entry: forced the KERNEL'S OWN meta-compile
(build-dist.mjs's `compile(g.code, {optimize:{level:3,...}})` call, the
ONE call site that compiles scripts/self.js into dist/jz.wasm) to
`inlinePtrOffsetFast:false` while regionHooks stayed wired
(scripts/self.js's `regionHooks:` line uncommented) — a pure meta-compile
config change, zero module/core.js or scripts/self.js body churn. **CLEAN**
on every leg: kernel-oracle 13/13 (493 assertions) × 3 reps, kernel-parity
33/33 × 3 reps, the full 200-seed fuzz sweep (`fuzz({count:200,seedStart:1,
inputs:12,inputSeed:7,optLevels:[0,1,2,3]})`, the EXACT GATE object
test:wasm's own "no new miscompiles" test uses) × 3 reps zero findings, all
7 originally-banked seeds (32/101/157 O2, 36/69/103/161 O3) individually
re-run × 3 reps each — clean, and fuzz-2000 (`--count=2000 --opt=0,1,2,3`)
× 2 reps — clean. Suspect CONFIRMED.

*Mechanism*: `inlinePtrOffsetFastPass` (src/optimize/index.js:3914) expands
`(call $__ptr_offset X)` into a loop-free, CSE-eligible i32.and/i64.shr_u/
load expression AT EVERY CALL SITE — exactly so watr's own optimizer (and
jz's own hoistPtrType/hoistInvariantPtrOffset regionTrackCSE family, this
same file's ~line 269 "CSE repeated call across stable regions" machinery)
can fold/hoist it like any other pure op — that IS the hazard once
regionHooks are wired: a `$__region_exit` call relocates live heap objects
and re-derives their offsets through the SAME forwarding chase
(`followForwardingWat`, layout.js:293, cap=-1 sentinel at off-4/new-offset
at off-8) this inlined form independently reproduces — but once inlined,
the expansion is INDISTINGUISHABLE FROM PURE to every downstream CSE, none
of which know a `$__region_exit` call in between invalidates a previously-
decoded offset. The out-of-line `call $__ptr_offset` form is naturally
conservative (a `call` is a CSE barrier by construction); the inlined form
is not. Confirmed this can't be fixed by a precise per-function dominator/
interval exclusion INSIDE inlinePtrOffsetFastPass itself (the design's
angle (i)): watr's OWN cross-function inlining runs AFTER jz's per-function
optimizeFunc pass (this file's own sequencing comment above optimizeFunc —
"optimizeFunc runs ONCE, in the 'pre' phase... watOptimize is the sole
generic fixpoint optimizer... after"), and the root-cause session's own
finding that watr's runRounds (the $__region_exit caller) has "NO surviving
named function in the O3 output — fully inlined" means the true CSE
opportunity (pure-decode ops and the region_exit call sharing one fused
caller) only exists POST-fusion — invisible at jz-pass time. A local
analysis would be unsound; the coarse, provably-correct gate has to sit
above both passes.

*Class fix* (scripts/build-dist.mjs, the one call site that ever wires
regionHooks live): `REGION_HOOKS_LIVE = /^\s*regionHooks:\s*\{/m.test(g.code)`
detects the ACTIVE (uncommented) `regionHooks:` line in scripts/self.js's
own source text and spreads `inlinePtrOffsetFast:false` into the optimize
config for EXACTLY that meta-compile when true. Regex correctly excludes
the commented/dormant form (`// regionHooks: {` fails `^\s*regionHooks:`
since `\s*` doesn't match `//`) — verified directly. This is NOT a global
pass disable (native compiles, the test suite, jzify, every user program,
and a DORMANT self-host build are untouched — inlinePtrOffsetFast keeps its
real speed-tier win everywhere else); it's a one-line, compile-time,
provably-scoped exclusion at the single build where the hazard's
precondition (regionHooks wired) holds. **Verified a true no-op on the
dormant path**: built dormant self.js (hooks commented, matching the
shared tree) twice — once with the pre-session build-dist.mjs, once with
the fix — `cmp` byte-identical (16527.3 kB both). Build×2 determinism also
verified on the region-live/fixed build: two consecutive builds with
regionHooks wired + the fix, `cmp` byte-identical (14788580 bytes both).
Landed in the shared tree (build-dist.mjs only; scripts/self.js's
regionHooks line stays commented — see wall below).

**A SECOND, LARGER, PRE-EXISTING WALL surfaced this session, blocking
shared-tree re-enable independent of the fix above**: ran the full
`test:wasm` suite (`JZ_TEST_TARGET=jz.wasm node test/index.js`, scaled via
`JZ_FUZZ_GATE=0.05` — the officially-supported CI-runner knob — purely to
make the OTHER ~2700 non-fuzz assertions complete in reasonable wall time;
the fuzz legs themselves were already covered more precisely above at full
count) against the region-live + inlinePtrOffsetFast-fixed kernel: **2656/
2716 pass, 60 fail, 6 skip** (native battery, same build lineage, no
JZ_TEST_TARGET: 3419/3427 pass, only the 2 pre-existing known-banked fails
— interval-walk/typed-RMW — unchanged, confirming the failures are
kernel-target-specific). All 60 failures are `RuntimeError: memory access
out of bounds` with unnamed wasm-function stack frames — same class of trap
as the original bug, but NOT the same mechanism: inspected several (Number/
parseFloat subnormals, Object.assign boxed-array-write, SSO builder-append,
Date.UTC, URLSearchParams, collections insertion-order iteration, deopt D1
byteLength/byteOffset/size) — every one traps DURING THE KERNEL'S OWN
COMPILATION of the test source (deep fused-function call stacks, same
signature as $__alloc's wraparound guard in the original root-cause), not
during target execution. This matches the region-arena DESIGN's own
documented, PRE-EXISTING limit exactly (see this section's "Slice 1 BUILT"
paragraph above): only ARRAY/SET/MAP relocate on region_exit; OBJECT/HASH/
CLOSURE/TYPED/BUFFER/EXTERNAL "trap rather than silently mishandle
(registry Slice 2 retires this)". The curated kernel-oracle/kernel-parity
corpus and the scalar-arithmetic fuzz generator never exercise those other
heap kinds in the COMPILER'S OWN internal AST/IR representation, so this
gap was previously theoretical/design-level — this is the first time it's
been measured: compiling ~2.2% of a realistic, broad-coverage test corpus
hits it. No prior session ran the FULL test:wasm suite against a
region-live kernel (every prior RE-TEST note explicitly says "NOT run —
gated on the wall being dead"); this is a new, load-bearing data point, not
a regression from the inlinePtrOffsetFast fix (which only concerns
pointer-decode caching in scalar compiler-internal code, orthogonal to
WHICH heap kinds region_exit is willing to relocate).

**Per the stop-on-fail tripwire**: the inlinePtrOffsetFast wall IS dead
(ablation confirmed, fix landed) — but regions stay DORMANT in the shared
tree (scripts/self.js's regionHooks line stays commented) because of the
Slice-2 heap-kind wall above, which the fix does not and cannot touch. Ship
gate updated: re-enable now requires BOTH the (closed) inlinePtrOffsetFast
class fix AND Slice 2 (the OBJECT/HASH/CLOSURE/TYPED/BUFFER/EXTERNAL
relocation registry — un-built; the design's own "registry Slice 2 retires
this" is not a session-sized task). Memory watermark curve and the jz×jz
verdict were NOT attempted — both require regions live for a program as
large/heap-diverse as jz×jz itself, and that precondition doesn't hold.
Worktree removed at session end; `git status`/`git diff` in the shared tree
show only the intended build-dist.mjs change plus this ledger entry.

**Heap-kind registry Slice 2 ATTEMPTED, WALL HIT, BANKED (2026-08-11), disposable
worktree (`region-slice2-2026-08-11`, node_modules copied — watr 5.7.13
confirmed) — verdict: real relocation logic built + one genuine bug found and
fixed, but the second wall above is NOT closed by it; a DEEPER, still-open
address-layout-sensitivity class dominates. Not landed.**

**Structured columns** (layout-kinds.js KIND_REGISTRY, new `children`/
`relocate` executable fields per kind, doc-string enum matching the task's
own vocabulary): ARRAY `slots(len@-8)`/`copy-forward`; OBJECT `schema-
slots(aux)+sidecar`/`copy-forward` (slot count from `$__schema_tbl[sid]` —
the same lookup `__obj_clone`/`__sclone_rec` already use, NOT a header word
— OBJECT's header len/cap slots are unused); HASH `hash-entries(kv)`/
`value-relocate` (a NEW verb: KEYS are content-hashed STRINGs, invariant
under relocation, matching what `__region_relocate_props` — the existing
dyn-props-sidecar helper — already does for exactly this shape; a bare
PTR.HASH region-root value turned out to be PHYSICALLY IDENTICAL to that
sidecar case, so the arm is one line: delegate to it directly); SET/MAP kept
`rebuild` (unchanged, verbatim); TYPED `buffer-edge(raw-i32)`/`copy-rebase`
(owned storage is a leaf `copy`; a VIEW's descriptor holds `bufferRootOff`
as a RAW i32 offset, not a boxed f64 child — rebased by recursing
`__region_copy_rec` on a synthesized BUFFER box for the root, mirroring
`__sclone_rec`'s TYPED view arm, then re-deriving `dataOff` from the
possibly-relocated root's new offset); BUFFER `none`/`copy` (memo'd —
region relocation, unlike structuredClone, must preserve "same `.buffer`"
identity across multiple views sharing one root); EXTERNAL `none`/
`immediate` (the offset is a host-table INDEX, not a wasm address — nothing
to relocate); CLOSURE `env(aux-arity)`/`trap` — the one kind deliberately
NOT built: `aux` carries the function-table index, not the capture count,
and the env block is a bare `__alloc` with no header (module/function.js) —
no aux-indexed capture-count table exists at runtime (unlike OBJECT's
`$__schema_tbl`), and building one (a `$__closure_env_len` table, mirroring
the schema table) is a real, bounded, but NOT session-sized option, scoped
out per the task's own "keep a PRECISE trap for that sub-case, document"
permission — a single named `(if (tag==CLOSURE) (then (unreachable)))` arm,
not lumped into a blanket six-kind trap.

**Generator + byte-identity verdict**: BIGINT/STRING/ARRAY/SET+MAP extracted
PROGRAMMATICALLY from the git blob (paren/marker-anchored slicing, never
hand-retyped) into `regionArm*` functions in layout-kinds.js, verified
byte-identical to the pre-Slice-2 hand-written text via a throwaway eval
script (both `hasDynProps` states for ARRAY) BEFORE module/core.js's
`__region_copy_rec` stdlib entry was switched to call the assembled
`regionCopyRecBody()` — **PASSED**, matching Slice 3's own established
"prove equality, then move the source of truth" discipline. OBJECT/HASH/
TYPED/BUFFER/EXTERNAL newly authored; CLOSURE a one-line named trap.
`__region_relocate_props` (module/core.js) hardened with a memo (hit-check
+ set) it never needed before — ARRAY/OBJECT's dyn-props sidecar is always
1:1 (never diamond-shared), but a bare HASH region-root value legitimately
CAN be (aliasing: `let b = a` copies the same HASH bits into a second
reachable slot) or self-referential — unguarded, a revisit would either
double-copy (breaking `===`) or infinite-loop on a cycle.

**A REAL BUG FOUND AND FIXED, live-verified (native `compile()`, no self-
host needed — this repro is orders of magnitude faster to iterate than a
kernel rebuild and should be the FIRST tool reached for next time)**:
OBJECT's first ephemeral-branch draft mirrored ARRAY's dyn-props migration
policy verbatim — relocate the props hash, ALWAYS re-file it into the
global `$__dyn_props` table keyed by the object's final address, and mark
the old inline slot with `i64.const -1` (ARRAY's "moved elsewhere" sentinel
— `module/collection.js`'s `__dyn_set` ARRAY arm explicitly recognizes a
non-zero, non-HASH-tagged off-16 word as "look in the global table",
falling through past its inline check). **OBJECT's `__dyn_set` arm has NO
such fallback** (the "OBJECT: heap-allocated AND ephemeral... writes
propsPtr directly at off-16" comment, module/collection.js): it treats ANY
non-zero off-16 word as an already-valid HASH pointer, unconditionally, no
tag check. Writing `-1` there — sound for ARRAY, silent corruption for
OBJECT — misdirects the next dynamic-property access into dereferencing the
`-1` bit pattern as a real pointer. Minimal repro (native, no kernel):
`let o = {}; o["extra"] = 77` inside a region round, read back after
`__region_exit` — `memory access out of bounds`, 100% deterministic, fails
at O0/O2/O3 identically. Root-caused by comparing which native repro
variants passed (durable object + dyn-prop: fine — DIFFERENT policy branch)
against which failed (ephemeral object + dyn-prop: broken), then reading
`__dyn_set`'s own OBJECT arm to find the missing tag-check. FIX: OBJECT's
ephemeral relocation keeps props INLINE at the object's NEW off-16
unconditionally — never migrates to `$__dyn_props`, matching what
`__dyn_set` actually expects to find there for an ephemeral receiver.
Verified (native, isolated per-case + 3× repeat, O0/O2/O3): ephemeral
dyn-prop write+read, diamond-shared OBJECT relocation, self-referential
OBJECT (both schema-field and dyn-prop cycles), nested OBJECT-in-OBJECT,
bare HASH as region root, HASH-of-HASH, JSON.parse'd dict crossing a region
boundary, `new Map`/`new Map(anotherMap)` seeded from a post-relocation
ARRAY/MAP, TYPED array relocation, ArrayBuffer + two sharing TYPED views
(post-relocation write-through-one-read-through-other) — ALL PASS. This is
real, load-bearing, and stays fixed in the banked branch.

**THE WALL: kernel-oracle's `String()`-with-ambiguous-bool-merge O2 row
(`export let f = (x) => String(x > 0 && 1)`) traps `memory access out of
bounds` — PROVEN NOT to be a logic bug in any Slice-2 arm.** Bisection
method: (1) ablated OBJECT/HASH/TYPED/BUFFER/CLOSURE one at a time (and all
four non-CLOSURE ones together) to a bare `(then (unreachable))` stub each
— trap PERSISTS unchanged (`memory access out of bounds`, never
`unreachable` — so none of the five is even being reached in this repro);
(2) reverted `__region_relocate_props`'s memo hardening to a byte-identical
copy of the pre-Slice-2 text — trap PERSISTS; (3) reverted the
`deps()`/assemble.js `needsSchemaTbl` changes to byte-identical originals —
trap PERSISTS; (4) with module/core.js's `__region_copy_rec` AND
`__region_relocate_props` bodies AND deps BOTH restored to git-blob-verified
byte-identical text (confirmed via the same programmatic-diff method used
for the extraction proof) — trap STILL PERSISTS. At this point the ONLY
remaining diff from a clean d1f2f2ba+regionHooks-wired control build is
layout-kinds.js's ~470 new (entirely UNCALLED, dead-from-module/core.js's-
perspective) lines. **Confirmed this alone flips it**: a control build with
`__region_copy_rec`/`__region_relocate_props` restored byte-identical AND
layout-kinds.js's dead additions still present — traps. A genuinely clean
d1f2f2ba+regionHooks-wired build (separate worktree, zero Slice-2 diff at
all) — does NOT trap, compiles cleanly at every opt level. The mechanism:
`scripts/self.js`'s bundle (what `build-dist.mjs` feeds to the NATIVE
compiler to produce `dist/jz.wasm`) includes module/core.js AND
layout-kinds.js as literal JS SOURCE TEXT the kernel itself must compile —
every top-level exported function in that bundle becomes a real wasm
function in the KERNEL regardless of whether module/core.js's own stdlib
wiring ever calls it at STDLIB-PULL time for a GIVEN target compile (a
runtime-inclusion-vs-compile-time-presence distinction this session
conflated at first). More kernel-own-source size ⇒ different function-table
indices / code offsets / heap layout for the KERNEL'S OWN compiled
internals ⇒ a PRE-EXISTING, still-unidentified layout-sensitive OOB class
(same SHAPE as the already-fixed `inlinePtrOffsetFast` mechanism — "a cache
we didn't anticipate... the trap fires downstream, after control returns
from a clean `__region_exit`" — but evidently NOT the same instance, since
the meta-compile's `inlinePtrOffsetFast:false` gate is already active here
and doesn't save this row) gets tripped by DIFFERENT specific allocations
than before. This matches the ledger's own long history of this class
exactly (the 2026-08-06 "5 unrelated debug globals flipped an O2 pass/fail"
finding, the 2026-08-11 root-cause session's "any change to module/core.js,
even inert extra globals in a hot function... shifts allocation offsets
downstream") — but this is the FIRST time it's been shown to trigger from
size growth in a DIFFERENT file (layout-kinds.js) that the region machinery
doesn't even call at runtime when dormant, and the first time proven not to
be closed by the `inlinePtrOffsetFast` fix alone.

**Measured impact on the 60-row wall Slice 2 was meant to close**: full
`test:wasm` (`JZ_FUZZ_GATE=0.05`, same scaling as the prior session) —
**2655/2716 pass, 61 fail, 6 skip** — ONE WORSE than the documented 60-fail
baseline, not better. `kernel-oracle`: 12/13 (474 assertions, the String()
row above). `kernel-parity`: 33/33 clean. Two named example rows from the
NEW 61-fail set ("Number/parseFloat: subnormals..." and "deopt D1: sibling
numeric props narrow too — .byteLength/.byteOffset/.size") are THE SAME
example rows the prior session named in the ORIGINAL 60-fail set — meaning
Slice 2's real, verified OBJECT/HASH/TYPED/BUFFER logic does NOT visibly
fix them; they are almost certainly still hitting the SAME address-layout-
sensitive OOB class above (the heap-kind trap that used to fire
deterministically for these rows is now GONE — replaced with real logic —
which lets the compile proceed FURTHER into the fused optimizer internals,
where it can now reach this OTHER, deeper, unresolved trap instead). Net:
Slice 2 removes one wall and immediately exposes a second, deeper one that
was always there but previously masked by the first (every compile that
used to die early at the OBJECT/HASH/etc. trap never got far enough to
reach it). **Dormant-build byte-identity gate FAILS too**: a dormant build
(regionHooks commented, matching the shared tree) with Slice 2's code
present is 16543.6KB vs a clean d1f2f2ba dormant build's 16527.3KB — +16.3KB,
NOT byte-identical — direct consequence of the same "kernel compiles its
own dead code" mechanism above, since module/core.js/layout-kinds.js's
extra source lines exist in the bundle whether or not any single target
compile ever pulls the corresponding stdlib entries.

**Per the stop-on-fail tripwire**: NOT landed. Shared tree untouched
(`git status`/`git diff` show only this ledger entry and the pre-existing
untracked `todo-original.md`) — all work lives on the un-deleted branch
`region-slice2-2026-08-11` (one commit, message includes this same summary;
worktree removed, branch kept for direct resume — `git worktree add <path>
region-slice2-2026-08-11` restores the exact state, no re-derivation
needed). Full mandated ladder (fuzz 200+2000×2, full un-scaled battery,
build×2, shared-tree re-enable, memory curve, jz×jz) NOT run — gated on
this wall, and it isn't dead.

**Recommendation for next session**: (1) the OBJECT ephemeral-dyn-props fix
is real and worth keeping regardless of the wall — consider landing it
STANDALONE (dormant, region-only dead code today) as its own small, reviewed
commit, decoupled from the rest of Slice 2, so it doesn't get lost; (2) the
NEW wall needs the SAME instrumented-bisection method the original
`inlinePtrOffsetFast` hunt used, but this session's OWN finding changes
where to point it: the suspect is no longer pointer-decode caching
specifically — it's ANY kernel-own-size-sensitive layout dependency, so the
next probe should target watr's OWN cross-function fusion/CSE machinery
more broadly (the root-cause session's "fully inlined... invisible at
jz-pass time" finding about `runRounds` applies generally, not just to
`__ptr_offset`) — try ablating fusedRewrite/treeshake individually for the
meta-compile the same way `inlinePtrOffsetFast` was isolated, using the
`String(x > 0 && 1)` O2 repro (deterministic, fails at EVERY opt level
0-3 unlike the original bug, and native-reproducible is NOT available since
this is kernel-internal-only — needs `compileViaKernel(src,{level,wat:true})`
same as this session used) as the cheap, fast, 100%-reproducible fixture
instead of the original fuzz-discovered seeds; (3) the dormant-build size
regression is a SEPARATE, real cost this session did not attempt to solve —
worth asking whether any evaluation of Slice 2's OWN size (region-arm
generator functions specifically) can be gated out of the kernel's own
bundle when `build-dist.mjs`'s existing `REGION_HOOKS_LIVE` detection is
false, mirroring how Slice 4 already solved an analogous dist-cost bleed
for KIND_REGISTRY's prose columns — NOT attempted this session, may need
its own design.

**SECOND-WALL PASS BISECTION (2026-08-11), disposable worktrees off
`region-slice2-2026-08-11`/`d1f2f2ba` (all removed at session end, node_modules
copied per-worktree — watr 5.7.13 confirmed) — verdict: NOT a single pass, NOT
a generic size lottery. The wall requires module/core.js's real dispatch
rewiring AND layout-kinds.js's new arms TOGETHER; neither alone reproduces it.
Not landed, not closed — banked per the stop-on-fail tripwire.**

*Repro confirmed x3*: `region-slice2-2026-08-11` worktree, rebuilt via
`scripts/build-dist.mjs` unmodified — kernel-oracle's `String(x > 0 && 1)` O2
row traps `memory access out of bounds` 3/3, deterministic, matching the prior
session's bank exactly.

*Method*: a throwaway `bisect-build.mjs` (kernel-wasm-only rebuild, skips
esbuild's dist/jz.js|interop.js|assets/sprae.js — irrelevant to
`compileViaKernel`, cuts each iteration to the ~4 min wasm-only compile) reads
`ABLATE_JZ`/`ABLATE_WATR` env vars and forces the named jz PASS_NAMES flags or
watr `optimize()` stage flags to `false` on top of the kernel meta-compile's
existing `{level:3, watrGuard:false, snapshotInit:true,
inlinePtrOffsetFast:false}` config (build-dist.mjs's own `REGION_HOOKS_LIVE`
block, byte-for-byte). Ablations ran as parallel detached-HEAD worktrees (14
cores available, ~1.1 core/build) to keep wall time down.

*Batch 1 — the bank's own named suspects* (each ablated alone, 3 reps):
jz `fusedRewrite`; watr `treeshake`; jz `treeshake` (jz's own
`removeDead` sweep, src/compile/index.js — a DIFFERENT mechanism from watr's
internal `treeshake` stage, both tested separately); watr `cse`; watr `licm`;
watr `inline` (the fusion driver itself — `runRounds`'s caller-fusion
machinery the root-cause session's own finding pointed at); watr `offset`
(fold add+const into load/store offset — directly pointer-decode-adjacent).
**All 7 still trap, unchanged.**

*Batch 2 — the remaining offset/CSE/hoist family, grouped to cut wall time*:
jz `loadCSE,cseScalarLoad,hoistGlobalConstLoads,hoistGlobalPtrOffset,
hoistLoopGlobalPtrOffset,hoistInvariantPtrOffset,hoistPtrType,hoistAddrBase,
hoistInvariantLoop,promoteGlobals,propagateSingleUse,specializeMkptr,
sortLocalsByUse,foldSetToTee` (14 flags, ALL off at once); watr
`propagate,coalesce,locals,mergeBlocks,vacuum,inlineOnce,inlineWrappers,fold,
deadset` (9 flags, ALL off at once); jz `arenaRewind` alone (per-call heap
rewind — semantically adjacent to region-exit's own reclaim shape); jz
`hoistInvariantLoop` alone (isolated from the batch, in case the group masked
a single culprit). **All 4 still trap, unchanged.** Combined with batch 1,
every jz PASS_NAMES entry with any plausible offset/CSE/hoist/fusion
relationship, and every watr-side stage with any plausible relationship, has
now been ablated (individually or in a group whose members were later also
covered individually/regrouped) — no single named pass, in isolation, is
necessary for the trap.

*Layout-lottery hypothesis (coordinator-directed test)*: does the wall reduce
to "kernel-own compiled SIZE crosses some address-sensitive threshold,
independent of WHAT grew it" — the class the 2026-08-06/2026-08-11 sessions'
own heisenbug findings ("any change to module/core.js, even inert extra
globals... shifts allocation offsets downstream") would predict? Built a
CLEAN `d1f2f2ba` + regionHooks-wired control (zero Slice-2 diff) — confirmed
clean 3/3 (matches the prior session's own control finding exactly), size
14442.0 kB. Appended semantically inert, mutually-distinct (to dodge watr's
`dedupe` pass collapsing identical bodies), never-called exported padding
functions directly to `scripts/self.js`'s own tail:
  - +40 functions (+7.0 kB, 14449.0 kB total) — clean 3/3, no trap.
  - +140 functions (+24.6 kB, 14466.6 kB total — 1.5x Slice 2's OWN measured
    +16.3 kB dormant-build growth) — clean 3/3, no trap.
**Pure inert size growth, even at 1.5x Slice 2's own footprint, does NOT
reproduce the wall.** The simple "any size growth trips it" form of the
layout-lottery hypothesis is REFUTED — this is not a generic address-lottery
independent of content.

*Content isolation*: applied ONLY `layout-kinds.js`'s Slice-2 diff (the ~637-
line region-arm generator additions) onto the clean `d1f2f2ba`+regionHooks
control, `module/core.js` and `src/wat/assemble.js` left byte-for-byte
untouched (so `__region_copy_rec`'s dispatch still calls the OLD hand-written
body — the new arms exist as real, exported, dead-from-the-kernel's-own-
dispatch-perspective functions, same "present in the bundle, never invoked"
shape the earlier session's own explanation of the mechanism describes).
Size 14452.7 kB (+10.7 kB). **Clean 3/3 — no trap.** layout-kinds.js's new
content, PRESENT but UNWIRED, does not reproduce the wall either.

**Decisive test**: applied `layout-kinds.js`'s diff AND `module/core.js`'s
diff together (the real `__region_copy_rec` dispatch rewiring to
`regionCopyRecBody()` — this is what actually ROUTES compiled calls through
the new OBJECT/HASH/TYPED/BUFFER/CLOSURE arms) — but withheld
`src/wat/assemble.js`'s `needsSchemaTbl` fix (the one other Slice-2 file,
15-line diff, the `ctx.core.includes.has('__region_copy_rec')` OR-clause that
guarantees `$__schema_tbl` gets built whenever region-copy is live, so
OBJECT's arm can safely read a schema's slot count). Size 14458.9 kB.
**TRAPS, 3/3 — reproduces the wall**, WITHOUT the assemble.js piece at all.
This pins the mechanism precisely: neither module/core.js's dispatch
rewiring nor layout-kinds.js's new content alone is sufficient — BOTH
together are, and assemble.js's needsSchemaTbl fix is NOT what's standing
between this repro and green (consistent with, and an independent
confirmation of, the original Slice-2 session's own step-3 finding: "reverted
the deps()/assemble.js needsSchemaTbl changes to byte-identical originals —
trap PERSISTS").

**Verdict**: the second class member is NOT a bisectable optimizer pass (jz or
watr) and NOT a generic kernel-own-size address lottery. It is a real
STRUCTURAL consequence of `__region_copy_rec` itself changing shape — Slice 2
rewires that one function's body from a small hand-written WAT template to a
`regionCopyRecBody()` assembly carrying ~20 new locals
(`regionCopyRecLocals`) and 8 new inline arms — and the original session's OWN
ablation already showed it is not any ONE arm's logic (OBJECT/HASH/TYPED/
BUFFER/CLOSURE stubbed to bare `unreachable` one at a time and all together —
"trap PERSISTS unchanged... so none of the five is even being reached in this
repro"). The remaining, NOT yet tested axis: `__region_copy_rec`'s own new
SIZE/local-count may cross an inlining or fusion threshold specific to THAT
function (it is called from many sites — recursion plus every region-exit —
so `inlineOnce`/`mayInline`'s single-caller gate does not apply, but watr's
general fusion of a hot, frequently-called function into a large caller,
matching `runRounds`'s own "no surviving named function... fully inlined"
shape the ORIGINAL inlinePtrOffsetFast root-cause found, remains untested at
the level of "does `__region_copy_rec` SPECIFICALLY get a different
inlining/fusion outcome pre- vs post-Slice-2, independent of any single pass
flag" — batch 1/2's pass-level ablations show no SINGLE flag is necessary,
but a STRUCTURAL side effect of the new body's size on watr's fusion
heuristics, which no single flag toggles off, was not isolated this session).

**Per the stop-on-fail tripwire**: NOT landed, NOT closed. Shared tree
verified untouched throughout (`git status`/`git diff` show only the
pre-existing untracked `todo-original.md` before and after); all six
disposable worktrees (`region-wt`, `ab1`-`ab11`, `ab-pad`, `ab-pad2`,
`ab-pad3`) removed at session end via `git worktree remove --force` (each
was either a clean detached-HEAD checkout with no commits, or had its
ablation diffs only on-disk/uncommitted — no branch created, nothing to lose).
`region-slice2-2026-08-11` branch preserved exactly as banked (one commit,
untouched). Gate ladder (repro is confirmed but NOT the fix — kernel-oracle
13/13, kernel-parity 33/33, fuzz 200+2000×2, full battery, dormant
byte-identity, build×2, memory curve, jz×jz) NOT run — every gate beyond the
repro itself is contingent on the wall being closed, and it is not. No merge.

**Recommendation for next session**: stop bisecting BY PASS NAME — that
axis is now exhausted (batch 1 + batch 2 cover every offset/CSE/hoist/fusion-
adjacent flag in both jz's PASS_NAMES and watr's PASSES registries) and the
padding experiments show it is not a bare-size effect either. The open
angle is `__region_copy_rec`'s OWN pre- vs post-Slice-2 compiled shape at the
KERNEL's fused-caller level: dump named WAT for the function (or its fused
successor) from the clean `d1f2f2ba` control vs the `ab-pad3` decisive-test
build (both already characterized above, reproducible via the same `git
apply` recipe — `git diff d1f2f2ba region-slice2-2026-08-11 -- layout-kinds.js`
and `-- module/core.js`, applied on a fresh `d1f2f2ba`+regionHooks-wired
worktree) via `compileWat` on a trivial source and `wasm2wat --enable-all` on
the KERNEL binary itself (the root-cause session's own technique for
`inlinePtrOffsetFast`), diffing which functions changed identity/inlining
status around `__region_copy_rec`'s call sites — that is the one lever this
session did not pull.

**WAT-DIFF OF __region_copy_rec's NEIGHBORHOOD (2026-08-11), disposable
worktrees `wall2-control` (`d1f2f2ba`+regionHooks wired) / `wall2-decisive`
(same + `git diff d1f2f2ba region-slice2-2026-08-11 -- layout-kinds.js
module/core.js` applied, assemble.js withheld — the exact decisive-test
shape from the pass-bisection session, verified below) — verdict: the one
lever named above pulled; narrows the wall to ONE arm's tail, does not close
it. Not landed, not closed — banked.**

*Setup*: both kernels built via unmodified `scripts/build-dist.mjs`
(node_modules copied per-worktree, watr 5.7.13). Sizes matched the bank
exactly (control 14442.0 kB, decisive 14458.9 kB — the prior session's own
numbers), and the repro reconfirmed on THESE two binaries directly (not
inherited): a `repro-check.mjs` driving `test/kernel-target.js`'s
`compileViaKernel('export let f = (x) => String(x > 0 && 1)', {optimize:2})`
3× each — control 3/3 clean (`f(1)="1"`, `f(-1)="false"`), decisive 3/3
`RuntimeError: memory access out of bounds`. Confirms the two worktrees are
the real control/decisive pair, not a stale carryover.

*Technique*: rather than `wasm2wat` on the byte-encoded kernel (no name
section unless `opts.names` is threaded through, and the original root-cause
session's own disassembly had to fall back to bare `wasm-function[N]`
frames), used the SAME lever that session already validated for this
purpose — a NATIVE `compile(g.code, {modules:g.modules, memory:8192,
optimize:{level:3, watrGuard:false, snapshotInit:true,
inlinePtrOffsetFast:false}, wat:true})` on each worktree's own
`resolveModuleGraph('scripts/self.js')` (mirroring build-dist.mjs's wasm
call exactly, CARRIER_BOX injection included) — this returns the KERNEL's
own optimized internals as READABLE, ALWAYS-NAMED WAT text directly, no
disassembler needed. Two ~280 MB dumps (`control.wat`/`decisive.wat`,
~6.03M/~6.4M lines). Indexed every top-level `(func $name ...)` (name, start
line, line count) via a streaming line-reader (`func-index.mjs`) rather than
loading either file whole.

*Driver identity, confirmed stable*: `__region_copy_rec` has exactly ONE
external (non-self-recursive) caller in both dumps — `__region_exit` itself
has ZERO surviving named occurrences in either build (fully inlined, same
finding as the original root-cause session's `runRounds`), folded directly
into the `regionHooks.exit` callback closure (`$closure2906` in control,
`$closure2903` in decisive — the number shift is pure closure-ID churn from
Slice-2's added source elsewhein the bundle, not a content change). Diffed
that closure's full 164-line body byte-for-byte (with only its own name
normalized): **zero diff**. The mark/heap-compaction/dyn-props-migration
driver logic that calls `__region_copy_rec` and does the closing
`memory.copy` is untouched, confirming the second wall is not a driver-side
effect.

*Whole-kernel stable-name diff*: filtered both indexes to `$__`-prefixed
names excluding `$closureN`/`$cseN`/`$__inlN` (auto-numbered, expected to
churn) — 409/410 stable names, 350 present under the IDENTICAL name in both
builds. Of those 350, **348 are byte-identical in line count**; the only two
that differ are `__region_copy_rec` (717→1312 lines, +595) and
`__region_relocate_props` (151→160, +9) — exactly the two functions Slice-2
authored, nothing else in the kernel's own named stdlib surface shifted
shape. (A separate ~57/58-entry churn in the `$__mkptr_6_N_d` family —
per-aux-value pointer-construction specializations, auto-numbered by
discovery order during the kernel's own compile — renumbers throughout the
dump when layout-kinds.js's dead-when-dormant ~637 new lines are present,
independent of module/core.js's dispatch wiring; this is the SAME
"kernel-own-size-sensitive layout dependency" mechanism the pass-bisection
session already named for the dormant +16.3 kB growth, not new evidence, and
the content-isolation test already showed this alone does not trip the
wall.)

*`__region_copy_rec`'s own body, read structurally*: confirmed (again, via
direct WAT read rather than ablation) that all 5 new arms sit behind
`(if (i32.eq $t ...))` dispatches on the object's TAG — for the `String(x >
0 && 1)` repro (plain f64/BOOL scalar merge, no heap allocation crosses a
region boundary at all) none of these branches can be live, matching the
prior session's `unreachable`-stub ablation exactly. Went one step further:
audited every NEW local (`$cap`/`$oldRoot`/`$newRoot`/`$cse961`/`$cse964`/
`$cse965`/`$cse966`) for a value TEE'd before a `call
$__region_copy_rec` (recursion) and read after — the one real hit is the
pre-existing SET/MAP arm (unchanged verbatim per design, byte-identical
logic, just two watr-CSE-introduced temps): `$cse964`/`$cse966` cache `off-4`
/`off-8` (computed once, before the child-copy loop) and are read again
AFTER the loop to write the forwarding sentinel (`old[off-8] = newOff-delta;
old[off-4] = -1`) — control computes the same two addresses fresh, inline,
at the same post-loop site instead of caching them. Proved this specific
reuse sound: `$off` (the value the cached addresses derive from) has exactly
one `local.set` in the whole arm, at arm entry, never touched again —
WASM's calling convention leaves callee-invisible to caller locals, so a
recursive `call $__region_copy_rec` inside the loop cannot alias or
invalidate `$off`-derived arithmetic held in a local. No unsound cache
found in the one arm reachable by non-scalar test corpora either; this is
consistent with (not contradicting) the original ablation's "none of the
five is even being reached in this repro."

**Verdict, narrower than the session start but still open**: the wall is
now pinned to being caused SPECIFICALLY by `__region_copy_rec`'s own +595-
line growth (not the arms' logic, not the driver, not any other named
stdlib function, not bare kernel-size, not a single pass) — but WHERE that
growth trips something remains unlocated. Every angle available to static
WAT reading (name-stable diff, structural safety read of the one
call-spanning cache pattern that exists) is now exhausted; the growth's
effect must be on the compiled shape of one of the ~6,000 auto-numbered
`$closureN` functions (the compiler's own JS-sourced internals — index.js/
src/*/module/* compiled AS the kernel's OWN program), where name-based
diffing is structurally unusable (numbering is assignment-order-dependent
and shifts under ANY source-size change, confirmed by the `$__mkptr_6_N_d`
churn above) — a name-stable technique can't see this class of shift by
construction, full stop; it isn't a matter of trying harder with the same
tool.

**Per the stop-on-fail tripwire**: NOT landed, NOT closed. Both worktrees
(`wall2-control`, `wall2-decisive`) and their `dist/jz.wasm`/`*.wat` dumps
removed at session end; shared tree verified untouched throughout
(`git status`/`git diff` show only the pre-existing untracked
`todo-original.md` and this ledger entry). `region-slice2-2026-08-11` branch
unchanged. Gate ladder not run beyond the repro-x3 reconfirmation above
(kernel-oracle/kernel-parity/fuzz/battery/build×2/memory curve/jz×jz all
contingent on the wall closing).

**Recommendation for next session**: abandon name-based WAT diffing for this
specific remaining gap — it has now been shown structurally incapable of
seeing a `$closureN` renumber-and-refuse-fusion event. The next lever is
runtime, not static: the design's own trace-inject instrument
(`scripts/trace-inject.mjs`), applied NOT to `__region_copy_rec` itself
(already instrumented once, already known to perturb the heisenbug) but to
`$__alloc`'s `bytes` argument specifically — the class fix in the prior
ROOT-CAUSE ATTEMPT entry recommended exactly this ("(a) a UNIVERSAL validity
check wrapped around every `$__alloc`/`$__alloc_hdr*` call site's `bytes`
argument... edit only the guard condition, add no new globals/locals") and
it was never attempted; it's the one item on that list that survives this
session's finding that the fault is a THIRD-PARTY closure's shape, not
region logic itself, since a guard at the allocator's own entry catches a
garbage `bytes` value regardless of which caller produced it, without
needing to locate that caller by name first. If that guard traps with a
DIFFERENT signature than plain `memory access out of bounds` (e.g. a custom
trap reason string byte-decodable from the trap message), the specific
`bytes` value at the moment of corruption becomes visible without touching
any other kernel-internal source line — the same "cheapest single-line
perturbation, most likely to preserve the manifestation" logic named before,
now aimed with this session's narrower target.

**RUNTIME $__alloc-ENTRY GUARD (2026-08-11), disposable worktree
(`region-alloc-guard`, scratchpad, off `region-slice2-2026-08-11` @
`88958115`, node_modules copied — watr 5.7.13 confirmed) — verdict: the
named lever ($__alloc-entry trace) FALSIFIED its own working hypothesis, then
a follow-up trace on the ACTUAL faulting function found and decoded the real
garbage, named its provenance class, and traced it to source. Not landed —
the fix touches shared collection-iteration plumbing (`__coll_order`
consumers) too broadly for a session-scoped, provably-correct patch. Banked
per the stop-on-fail tripwire.**

*Rebuild + repro*: unmodified `scripts/build-dist.mjs` recipe (kernel-wasm-
only leg, skips the esbuild dist/jz.js|interop.js|sprae legs — irrelevant to
this repro), `dist/jz.wasm` 14806320 bytes. kernel-oracle's `String(x > 0 &&
1)` O2 row (`compileViaKernel('export let f = (x) => String(x > 0 && 1)',
{optimize:2})`) — `RuntimeError: memory access out of bounds`, 3/3 clean
reps, matching the bank exactly.

*Instrument, built at the WAT level on the BUILT binary (per the prior
session's own caution — source-level module/core.js edits are a proven
heisenbug trigger for this exact wall)*: dumped the kernel's own optimized
internals as ALWAYS-NAMED WAT text via the same `compile(g.code, {modules,
memory:8192, optimize:{level:3, watrGuard:false, snapshotInit:true,
inlinePtrOffsetFast:false}, wat:true})` lever the wall2 WAT-diff session
validated (276.5 MB text, 6.46M lines). A NEW script (`trace-alloc.mjs`,
scratchpad-only — reuses `trace-inject.mjs`'s own findFunc/parseFunc/
printFunc splicing mechanics, not a rewrite) prepends `(call $dbgtrace ...)`
host-import traces to `$__alloc`'s own `$bytes` param + `$__heap` global
(both still pristine at function entry, before the existing bump-pointer
logic's `local.tee $bytes` reuse of the param — no tee-wrapping needed) and
to `$__alloc_hdr`/`$__alloc_hdr_n`'s own `$len`/`$cap`/`$stride` params.
Re-assembled via `watr/parse` + `watr/compile` (81s for the 276 MB text —
NOT the multi-hundred-MB-multi-hour concern the original script's own
comments anticipated), instantiated by hand (bypassing `interop.js`'s
`instantiate()` — its `opts.imports` wrapper auto-decodes host-import args as
NaN-boxed jz values via `state.mem.read`, which would corrupt a raw i64 debug
channel; used `interop.js`'s exported `memory()` marshaling helper directly
against a manually-built `WebAssembly.Instance` instead, matching the raw ABI
— every export param is i64 f64-reinterpret bits, BigInt required, `0n` is
the correct "absent" sentinel since jz's own unboxed-number representation
IS the f64 value and 0.0's bits are 0n).

**Hypothesis FALSIFIED**: ran the repro against the $__alloc-instrumented
binary — traps identically (`memory access out of bounds`, not
`unreachable`), but the full alloc-entry trace (648,844 real allocations
before the trap, every `bytes`/`heap_before` value inspected) shows **every
single `$__alloc` call before the trap requests a small, sane byte count (8,
16, 24, 32, 48, 464, 912…)** — nothing oversized, nothing wraparound-shaped.
$__alloc's own guard never fires; the trap is not a "garbage bytes" event at
all. This itself is the falsification the guard was built to either confirm
or refute (per the prior session's own framing) — refuted, cleanly.

**Follow-up: locate the REAL faulting frame.** Captured the raw Node
`RuntimeError` stack (`wasm-function[N]` frames, no name section on the
reassembled binary) and mapped every index to jz's own name via the SAME
counting convention `index.js`'s `functionNameSection` uses (import funcs
first in declared order, then defined funcs in declared order — verified by
parsing the actual AST rather than eyeballing text, since a first attempt via
naive line-regex undercounted). Stack, innermost first: **`$__map_from`**
(idx 98) ← `$m122_optimize$substGets` (idx 798, self-recursive ×3) ←
`$m122_optimize$forwardPropagate` (3054) ← `$closure2193` (5160) ←
`$m51_util$walkN` (144) ← `$tramp_m122_optimize$propagate` (3490) ← …
← `$compileSelf` (3258) ← `$compileSelf$exp` (6030, the export wrapper).
**The trap is not target-program-related at all — it fires inside jz's OWN
`forwardPropagate` optimizer pass, while the KERNEL compiles the repro
source, at a `new Map(existingMap)` call** (`module/collection.js`'s
`__map_from` stdlib, emitted for any `new Map(iterable)` in jz-compiled JS —
general-purpose, not region-specific machinery itself).

**Second instrumentation pass, same discipline (WAT-level, on the built
binary, zero source churn)**: extended `trace-alloc.mjs` to tee-wrap
`$__map_from`'s own `$t`/`$off`/`$cap`/`$n` (tag-check + MAP-branch reads) and
its copy loop's `$i`/`$off`(reused as slot addr)/key/value loads. Re-ran —
**decisive capture**, the last `__map_from` invocation before the trap:

```
mapfrom.t   9          (PTR.MAP)
mapfrom.off 14014800
mapfrom.cap 16
mapfrom.n   6                      <- source map's HEADER claims 6 live entries
loop i=0  slotoff=14015064  key=0x7ffa000000aa499c  val=0x7ffb021900d5c768   (looks like a real boxed entry)
loop i=1  slotoff=14015040  key=0x7ffa000000a9d394  val=0x7ffb021900d5ce00   (real)
loop i=2  slotoff=14014872  key=0x7ffa000000a9d3cc  val=0x7ffb021900d5d460   (real)
loop i=3  slotoff=14014824  key=0x7ffa000000a9d57c  val=0x7ffa000000a9d4fc   (real)
loop i=4  slotoff=0         key=0x69666e492d797469  val=0x657572747974696e   <- GARBAGE
```

**The garbage decode**: `slotoff=0` at loop iteration 4 — the "order" array
built by `__coll_order` (module/core.js) holds a real slot ADDRESS for
entries 0-3 but a bare **zero** at index 4, even though the source map's own
header field said 6 entries exist. `i64.load offset=8/16 (addr=0)` doesn't
trap (address 8/24 is in-bounds — it's just the WRONG memory) — it reads the
KERNEL'S OWN static string-table data segment, which literally starts at
linear-memory address 0: `"NaNInfinity-Infinitytruefalsenullundefined…"`.
Decoded LE byte-for-byte: `key` bytes = `i,t,y,-,I,n,f,i` = **`"ity-Infi"`**,
exactly the data segment's own bytes at offset 8 (`…Infin`**`ity-Infi`**`nity…`,
i.e. the tail of "Infinity" + "-Infi" of "-Infinity"); `val` bytes land a few
bytes further into the same literal (`"…nitytrue…"` region). This is the
SAME corruption signature class the carrier-representation-design.md §29
session found for a completely different bug (`i64Hex` reading
`i64.load(address 0)`) — reading the static string pool because a decoded
"pointer" was zero, not a real heap offset. **Provenance class, named per the
task's own vocabulary: neither a boxed-pointer-as-length nor a stale
pre-relocation address nor a sign-reinterpreted huge value — a bare NULL
slot pointer, arising from a stale/over-counted OCCUPANCY COUNT (a
collection's header length exceeding its real live-slot count).**

**Mechanism, traced one step upstream, source-mapped by shape**: `__map_from`
(module/collection.js:2021) and — independently, same anti-pattern —
`regionArmSetMap` (layout-kinds.js:331, the SET/MAP region-relocation arm)
BOTH read a collection's header length field (`i32.load(off-8)`, called `$n`)
and use it UNCHECKED as the iteration bound over `__coll_order`'s returned
buffer (`__coll_order(off, cap, stride)`, module/core.js:874), assuming the
two numbers always agree. They are NOT guaranteed to: `__coll_order`'s own
gather loop (module/core.js:886-889) explicitly SKIPS "healed zombie"
entries (`hash word ≠ 0` but `key == TOMB_NAN` — module/collection.js:154-164's
own documented durable-slot-heal contract: "table len decremented — that
probes pass over and __coll_order/len-sized iterations skip"), i.e. the
DESIGN's own intent is that header-length and coll_order's real count track
together, decremented in lockstep on every heal. Whatever concretely broke
that lockstep for THIS table was not isolated to a single instruction this
session (the desync must have already existed on SOME upstream table before
this `__map_from` call ran — this session's trace starts at the symptom, not
the origin) — but `regionArmSetMap`'s rebuild is the prime, structurally
implicated suspect: its own copy loop (layout-kinds.js:358-370) reads the OLD
table's `$n` ONCE, builds the NEW (rebuilt) table by inserting exactly `$n`
times via real `__map_set`/`__set_add` calls (each of which correctly
increments the NEW header's own length by 1 per insert — verified by reading
`genUpsert`, module/collection.js:314-419, which does NOT have this bug in
isolation: normal insert and grow-rehash both track length correctly against
real occupancy). Consequence: `regionArmSetMap` **faithfully PROPAGATES**
whatever `$n` it was handed — including a pre-existing mismatch — from the
OLD table onto the NEW one, one-for-one, with no re-derivation from
`__coll_order`'s own real count. If `__coll_order` ever returns fewer live
entries than `$n` (for whatever upstream reason first desynced them), this
rebuild doesn't just misread garbage locally the way `__map_from` does — it
INSERTS that garbage key/value pair into the rebuilt table as a real entry
(via a genuine `__map_set` call, line 364-366) and keeps the wrong length,
so the corruption survives the rebuild and can propagate to the NEXT
consumer — which is exactly the shape of a table whose `new Map(existingMap)`
copy (`__map_from`, general-purpose, unrelated to regions itself) later
inherits and trips over.

**Fix-or-bank: BANKED, not landed.** This is squarely a class fix, not a
one-line patch: at minimum two consumers (`__map_from`'s copy loop,
`regionArmSetMap`'s rebuild loop) trust a length field that `__coll_order`'s
own contract does not actually guarantee matches its real output count, and
`__coll_order` has OTHER general callers (`__hash_keys_ro`, for-in/
Object.keys/spread/JSON enumeration paths) not yet audited for the same
assumption. The provably-correct, scoped-right fix is conceptual, not
symptomatic: `__coll_order` should be the single source of truth for "how
many real entries exist" — either return its own live count alongside the
buffer (a signature change touching every call site) or have every
length-bound consumer stop trusting the header field and instead use
`__coll_order`'s actual output extent. Doing this soundly requires: (a)
locating where the header-length/real-occupancy lockstep FIRST breaks
(not isolated this session — the trace starts at the symptom's second or
third generation, not the origin table), (b) auditing every `i32.load(off-8)`
-as-iteration-bound call site across module/core.js + module/collection.js +
layout-kinds.js, (c) the full mandated gate ladder (kernel-oracle ×3,
kernel-parity, fuzz 200+2000×2, full battery, dormant byte-identity, build
×2) on top of that — a session-plus scope, not a session-remainder scope.
Zero shared-tree source changes made; the two throwaway instrumentation
scripts (`trace-alloc.mjs`, `run-traced.mjs`, `dump-wat.mjs`,
`build-wasm-only.mjs`) and their multi-hundred-MB WAT/trace artifacts live
only in the scratchpad worktree, not landed anywhere.

**Gates**: repro ×3 confirmed (both the original `dist/jz.wasm` harness and
the hand-instantiated instrumented-binary harness, same trap signature).
kernel-oracle/kernel-parity/fuzz/battery/dormant-byte-identity/build×2/
shared-tree re-enable/memory curve/jz×jz **NOT run** — all contingent on the
wall closing, and it does not; per the stop-on-fail tripwire, no attempt is
made to guess a partial fix under this uncertainty.

**Recommendation for next session**: (1) don't re-hunt the `$__alloc`-entry
angle again — it's now definitively closed (falsified with a full 648K-call
trace, not a hunch); (2) the productive next lever is auditing
`__coll_order`'s call sites for the same "trusts a header length instead of
the real returned count" shape — start from `regionArmSetMap` (layout-
kinds.js:358) and `__map_from` (module/collection.js:2037) since both are
now proven-implicated, then grep every other `call $__coll_order` site; (3)
try a NATIVE (non-kernel) repro before reaching for another kernel rebuild:
construct a Set/Map, force a durable-slot heal (a delete that crosses a
`__clear`/arena-rewind boundary — `module/collection.js:154`'s own documented
mechanism) to desync length from real occupancy in a controlled way, and
check whether `__coll_order`'s general (non-region) consumers already
mishandle it identically — if so, this is NOT actually region-arena-specific
at its root and the region-live requirement seen across every session on
this wall is just what makes the desync REACHABLE in practice (region round
boundaries are the dominant place a long-lived table crosses a heal), not
what CAUSES it — a materially different, and probably easier, fix target.

**DESYNC FIX LANDED (9d0e3384, shared tree)**: the class fix recommended
above shipped — `module/collection.js`'s `genDelete` now relogs/cancels
pending durable-slot logs through a backward-shift (`__durable_slot_relog`/
`__durable_slot_cancel`, module/core.js), and every `__coll_order` consumer
(~14 call sites across collection.js/core.js/json.js/object.js) binds its
iteration/allocation bound to the live `$__coll_order_n` global `__coll_order`
now stamps, never the table's header length. Verified: 1500+ native Map/Set/
Object trials (0 desyncs, 4 distinct failure signatures fixed en route),
fresh kernel build clean (kernel-oracle 13/13, kernel-parity 33/33 incl. the
dict row, fuzz 200+2000×2, npm test 3415/3421 — 6 pre-existing unrelated
fails). This is a general writer-correctness fix, not region-specific;
regions stayed dormant in the shared tree throughout (scripts/self.js
unchanged by that commit).

**SESSION (2026-08-11, FINAL-ASSEMBLY ATTEMPT — rebase Slice 2 onto the
desync fix): verdict — the second wall (String(x>0&&1) O2) is CONFIRMED DEAD;
the 60-row wall NARROWS (61→49, of which only 39 are the still-unresolved
deep OOB class) but is NOT closed. Not landed — banked on a named branch.**

Disposable scratchpad worktree (`region-final-2026-08-11`, branched off
`9d0e3384`, node_modules copied — watr 5.7.13 confirmed). Merged
`region-slice2-2026-08-11` (@ `88958115`) on top via a real two-parent merge
commit (`77ebcd70`). One real conflict, in `module/core.js`: HEAD (9d0e3384)
still carried the old hand-written `__region_copy_rec` body verbatim (the
desync fix never touched region-copy code); the branch had already deleted
that whole body in favor of `regionCopyRecBody()` (layout-kinds.js). Resolved
by taking the branch's (empty) deletion — verified byte-identical to the
branch's own intended shape by direct diff against `region-slice2-2026-08-11`'s
own file. `src/wat/assemble.js`'s `needsSchemaTbl` OR-clause merged clean, no
conflict.

**A second, un-merged instance of the SAME desync bug found and fixed during
the merge**: `regionArmSetMap` (layout-kinds.js, the SET/MAP region-relocation
arm — the branch's own code, predates the desync fix) still read a table's
HEADER length (`i32.load(off-8)`) as `__coll_order`'s iteration bound during
rebuild-on-relocate — exactly the propagation vector the desync fix's own
ledger entry (5e77f814) named as "the prime, structurally implicated suspect."
The desync fix's audit (~14 call sites) could not have caught this since
layout-kinds.js's Slice-2 additions lived only on the banked branch, invisible
to that session's tree. Fixed to bind on `$__coll_order_n` instead, matching
the pattern the fix applied everywhere else (call `__coll_order`, THEN read
the live-count global). `regionArmHash` (delegates to `__region_relocate_props`,
which walks all `$cap` slots checking per-slot occupancy directly, never
trusting a count field) and `regionArmArray` (walks its OWN header length,
not `__coll_order` — a materially different, always-correct shape for a plain
slot array) were checked and are NOT vulnerable to this class.

**Repro verdict — CLEAN, 5/5**: `compileViaKernel('export let f = (x) =>
String(x > 0 && 1)', {optimize:2})` — the kernel-oracle row this whole wall
was named after — compiles cleanly 5/5 (`f(1)="1"`, `f(-1)="false"`,
5310 bytes each). kernel-oracle 13/13 (493 assertions) × 3 reps clean.
kernel-parity 33/33 clean. This falsifies nothing — it CONFIRMS the desync
fix's mechanism closes this specific, previously 3/3-deterministic wall.

**60-row wall verdict — NARROWED, NOT CLOSED**: `JZ_TEST_TARGET=jz.wasm
JZ_FUZZ_GATE=0.05 node test/index.js` (same scaling every prior session used)
→ **2667/2716 pass, 49 fail, 6 skip** (was 2655/2716, 61 fail pre-rebase).
Categorized all 49 by trap message (parsed per-test from the raw log, not the
summary's truncated 3-line preview): **8 are the documented, INTENTIONAL
CLOSURE trap** (`unreachable`, not `memory access out of bounds` — Slice 2
deliberately left CLOSURE relocation unbuilt, a named, accepted scope
boundary, not a bug) — e.g. "class static field and method", "Set: no
duplicates", "§14 point 4: full presence×domain matrix". **39 are the SAME
unresolved deep OOB class** every prior Slice-2 session's exhaustive
bisection (pass-name ablation, size-lottery refutation, WAT-diff,
$__alloc-entry trace) failed to close — `memory access out of bounds`, during
the KERNEL'S OWN compilation, spanning Number/parseFloat, Set algebra,
closures-per-iteration-capture, Date.UTC, SSO invariants, Object.assign,
JSON.stringify, TypedArray codecs, and more (full list in session transcript)
— no narrower common shape than "compiler-internal object graph diverse/large
enough to perturb the kernel's own fused-caller layout" was found or sought
this session (per the prior sessions' own conclusion that this needs a
runtime lever — the `$__alloc`-entry-style trace, never yet tried on THIS
class specifically since the desync trace hijacked that lever's first use —
not more static bisection). 2 residual failures are unexplained and not yet
triaged against a dormant-kernel baseline: "host decode: trap-lowered radix
throw..." (expected RangeError, got RuntimeError) and "typed-array
divergence" — plausibly pre-existing kernel-target-only flakes unrelated to
regions, not confirmed either way this session.

**Per the stop-on-fail tripwire**: NOT landed, NOT closed. The mandated
ladder beyond kernel-oracle/kernel-parity/repro-x5/the 60-row scaled suite —
full un-scaled test:wasm, fuzz 200+2000×2, full battery, dormant
byte-identity, build×2, shared-tree re-enable, the memory watermark curve,
jz×jz — was **NOT run**, gated on the 60-row wall closing, and it does not.
Shared tree verified untouched throughout (worked entirely in the scratchpad
worktree; the concurrent PlanStore session's own commits — `975ada70`
onward through `0edcddea` — landed independently, unrelated, confirmed by
`git log`/`git status` before and after this session's work). All work
(the merge + the `regionArmSetMap` fix + the corrected header-comment
chronology in scripts/self.js) lives on branch `region-final-2026-08-11`
(one commit `77ebcd70`, message includes this same summary) — supersedes
`region-slice2-2026-08-11` for resume purposes (`git worktree add <path>
region-final-2026-08-11` restores the exact state). Worktree removed at
session end.

**Recommendation for next session**: (1) the `regionArmSetMap` fix is real
and worth landing standalone regardless of the wall (dormant, dead code
today, same "worth keeping" logic the OBJECT ephemeral-dyn-props fix earned
earlier); (2) don't re-attempt the pass-name/size-lottery/WAT-diff bisection
axes on the 60-row wall — all exhausted per the prior sessions' own
recommendation, and this session's rebase (removing 12 of the 60 original
failures, all apparently instances the desync fix's mechanism also touched)
doesn't change that verdict, it just shrinks the corpus; (3) the next lever
is the `$__alloc`-entry-style runtime trace, this time pointed at one of the
39 SURVIVING repros directly (e.g. "Number/parseFloat: subnormals..." or
"Set algebra: union/intersection..." — both short, self-contained test
sources, no fuzz harness needed) rather than the String() row that's now
closed; (4) triage the 2 unexplained residuals against a dormant-kernel
control run of the same scaled suite before assuming they're pre-existing.

**`__region_copy_rec` ORDERING AUDIT (2026-08-11), paper-execution + native
verification (no kernel instrumentation — the heisenbug rules that out) —
disposable worktree `region-final-2026-08-11` (branch resumed from `77ebcd70`)
— verdict: a real, independently-confirmed diamond/durable-revisit bug FOUND
and FIXED, but it does NOT discriminate or close the 39-row wall. Fix banked
on the branch (new commit), not landed to main; this ledger entry is the bank
record.**

*Method*: per the prior sessions' own conclusion that instrumentation
perturbs this class of bug, audited `__region_copy_rec`'s (layout-kinds.js
`regionCopyRecBody`/arms) and `__region_exit`'s (module/core.js) exact
instruction ordering by reading, not tracing — specifically: for every kind,
when does a node's OLD-site forwarding header (or, for durable nodes, its
own in-place fields) get written relative to (a) its own copy into staging,
(b) recursion into its children, (c) the closing `memory.copy`? Built an
ordering table (every arm's memo-check-point vs children-recursion-point vs
old-site-header-write-point) and enumerated diamond/cycle/durable-boundary
windows against it, THEN verified the one real finding with a native
(non-kernel) `compile()` probe — no dist/jz.wasm rebuild needed for
discovery, matching the desync-fix session's own precedent for reaching for
the cheaper tool first.

*Ordering table, summary*: ARRAY/OBJECT — `off=__ptr_offset(bits)` →
memo-check(bits) → durable-check; BOTH branches memo themselves (`memo[bits]
= out`) BEFORE recursing into children; ephemeral branch's OLD-site
forwarding header write happens AFTER the full child-recursion loop. SET/MAP
— same memo-before-recurse shape, no durable branch (always rebuilds).
`__ptr_offset` (module/core.js:327, `layout.js` `followForwardingWat`) chases
the `off-4==-1` sentinel ONLY for ARRAY/HASH/SET/MAP (`FORWARDING_MASK`);
OBJECT/TYPED/BUFFER/BIGINT/STRING never chase — pure bit-mask extraction.

*Window found and confirmed*: `__region_relocate_props` (module/core.js —
the function BOTH the ARRAY/OBJECT dyn-props sidecar path AND a bare
PTR.HASH region-root, via `regionArmHash`, delegate to) had NO memo
hit-check/set on its DURABLE branch — the one place in the entire dispatch,
alongside TYPED's durable VIEW branch (layout-kinds.js `regionArmTyped`),
that walks/mutates a node's children in place without the "memo BEFORE
recursing" guard every other durable branch (ARRAY, OBJECT) already has.
Consequence: a durable HASH reached via TWO paths in one `__region_exit`
round gets its slot-walk loop re-executed on the second visit; the loop
re-reads each slot's CURRENT value and re-feeds it through
`__region_copy_rec` — but the first visit already overwrote that slot with
the child's `$out`, the FINAL (delta-adjusted, not-yet-physically-valid —
the closing `memory.copy` hasn't run yet) address. The second pass hands
this final-bits value to `__region_copy_rec` as fresh input: for an
ARRAY/HASH/SET/MAP child, `__ptr_offset`'s forwarding-chase reads whatever
unrelated data currently occupies that not-yet-written final address (real
heap territory, `[mark,T)`, but not the child's data), and the child-level
memo (keyed on the ORIGINAL bits) misses, so the value gets silently
re-derived from garbage — the same "misread header/sentinel" shape the task
named (`cap=-1`-style), one level indirect: a stale-final-value re-input,
not a raced sentinel read. TYPED's durable VIEW branch has the identical gap
(its own `off+8` field gets overwritten with the buffer's FINAL address on
first visit; a second visit re-reads it as `$oldRoot` and recurses on a
bogus synthesized BUFFER box) — narrower to trigger in practice (needs a
durable view descriptor whose buffer becomes ephemeral in the SAME round;
jz never re-points an existing view's `rootOff` via ordinary construction,
so this requires cross-round persistence) but the same class, fixed for
symmetry.

*Cycle case*: `node_modules/watr/src/optimize.js` carries no `.parent`
back-references — no true structural cycles in Slice 1's own AST scope, only
diamonds (CSE/shared subtrees). Slice 2's broader (compiler-internal
OBJECT/HASH) scope CAN self-reference; native probe (self-referential
durable HASH, diamond-shared, ephemeral child) confirms the memo-before-
recurse pattern (now including the fix) terminates correctly — no hang, no
corruption, O0/O2/O3.

*Memcpy-overlap case*: no defect found — all region-copy work (incl.
`__region_relocate_props`) executes in the staging phase, before the closing
`memory.copy`; `$__dyn_props` relocation is bound to `$__coll_order_n`
(9d0e3384's own fix), not header length; cross-round, `__region_exit` resets
`$__heap = mark+size` at each close, so the next round's mark starts exactly
where the compacted survivors end.

*Native verification* (`compile()` directly, zero kernel rebuild, zero
flakes across O0/O1/O2/O3): a durable `Object.fromEntries([["a",0]])` dict
(confirmed `PTR.HASH`-tagged via a direct `__ptr_type()` probe — jz object
LITERALS and `JSON.parse` both produce `PTR.OBJECT`, schema-based, NOT HASH,
which is why an earlier attempt using `JSON.parse` read back correct and had
to be replaced) referenced twice from one ephemeral array (`let root=[d,d]`)
with an ephemeral array assigned into one of its keys after
`__region_mark()`. Pre-fix: single reference or no ephemeral child → correct;
two-or-more references to the SAME durable dict → the ephemeral child
silently reads back truncated to length 0, deterministically, every opt
level (this run's heap held zeroed bytes at the bogus "final" address — no
trap here, but kernel-scale heaps with real leftover data at that address
range are exactly where a `memory access out of bounds` would come from
instead). Post-fix (memo hit-check+set added to `__region_relocate_props`'s
durable branch, module/core.js; same fix shape added to `regionArmTyped`'s
durable VIEW branch, layout-kinds.js): the original repro, a triple-diamond
variant, a 256-element ephemeral-child variant, the self-referential-cycle
variant, and a nested HASH-of-HASH diamond variant ALL read back correct.
The all-scalar (no ephemeral child) diamond control was already correct
pre-fix and stayed correct post-fix (confirms the fix doesn't touch the safe
case).

*Kernel build + gate ladder, run against the fixed worktree*
(`scripts/build-dist.mjs` unmodified — `REGION_HOOKS_ACTIVE=true` is already
the marker state on this branch, so `resolveSelfhostBuild` derives
`regionArenaLive=true` and applies `inlinePtrOffsetFast:false` automatically;
`dist/jz.wasm` 14466.1 kB): **kernel-oracle 13/13 (493 assertions), clean.
kernel-parity 33/33, byte-identical, clean. The already-closed
`String(x>0&&1)` O2 repro stays closed, 3/3. Native battery (`npm test`,
region-irrelevant but run as a control): 3419/3427, same 2 pre-existing
known-banked fails (interval-walk/typed-RMW codec-bounds), 6 skip — no
regression.**

**The 49-row scaled `test:wasm` wall (`JZ_TEST_TARGET=jz.wasm
JZ_FUZZ_GATE=0.05`) is UNCHANGED: 2667/2716 pass, 49 fail, 6 skip — same
total, same pass count, same fail count as the pre-fix baseline, and
extracting every failing test's name (not just the truncated summary)
confirms it is the SAME 49 rows, not a coincidentally-equal-sized different
set** — Number/parseFloat subnormals, Set algebra, Date.UTC (×3), SSO
invariant (builder append, repeat/pad), Object.assign boxed-array-write,
JSON.stringify parsed-input, deopt D1 byteLength/byteOffset/size, the
host-decode radix-throw residual, the Float64Array fuzz typed-array-
divergence residual, and every other named row from the prior session's own
39+8+2 breakdown are all still present, verbatim, in this run's fail list.

**Discriminating-prediction result (the task's own falsifiability test):
NEGATIVE.** The window found (durable-container diamond-revisit) does NOT
discriminate the 39/49 failing rows from the passing ones — fixing it
changes ZERO rows in either direction. This is a clean, load-bearing
negative result, not an inconclusive one: the fix is real (independently
verified, deterministic, native, no ambiguity), the gate ladder ran to
completion (not aborted early), and the fail set was compared by NAME, not
just count. The mechanism dominating the 49-row wall is confirmed, again,
to be something else — consistent with every prior session's own finding
that it is a kernel-own-compiled-shape-sensitive class, not a logic bug
reachable through the region arms' own semantics for these specific 39
programs' actual compiler-internal object graphs (this session's window
requires a diamond-shared DURABLE HASH/TYPED-view specifically; the 39 rows
apparently don't happen to produce one during THEIR compile, even though the
mechanism is real and would corrupt one if they did).

**Fix-or-bank: BANKED (code), LANDED (ledger only) — not landed to main.**
Per the stop-on-fail tripwire: the wall is not dead, so the mandated ladder
beyond kernel-oracle/kernel-parity/the-49-row-scaled-suite (fuzz 200+2000×2,
full un-scaled `test:wasm`, full battery re-run, dormant byte-identity,
build×2, memory watermark curve, jz×jz) was NOT run — contingent on the wall
closing, and it doesn't. The fix (module/core.js `__region_relocate_props`,
layout-kinds.js `regionArmTyped`) is committed as a new commit ON TOP of
`region-final-2026-08-11` (still un-landed, still dormant in the shared
tree) — worth keeping regardless of this wall, same "real bug, land it
standalone" logic the OBJECT ephemeral-dyn-props and `regionArmSetMap` fixes
earned earlier in this same section, and it closes two genuine, independently
demonstrated correctness gaps (diamond-shared durable HASH; diamond-shared
durable TYPED view) that user-facing region-live code would eventually hit
regardless of whether they explain THIS wall. Shared tree (`main`) untouched
except this ledger entry; worktree removed at session end.

**Recommendation for next session**: (1) don't re-open the diamond/durable-
revisit axis — it's now closed, both by code fix and by the negative
discriminating-prediction result; (2) the productive next lever is still the
one named by the immediately-prior session and never yet tried on this
specific class: a `$__alloc`-entry-style (or, better per this session's own
finding that alloc-entry was already falsified for a DIFFERENT repro, an
entry-guard on whichever function the STACK TRACE actually blames — the
prior session's own `$__map_from`/`forwardPropagate` technique) runtime
trace pointed DIRECTLY at one of the 39 surviving repros (e.g.
"Number/parseFloat: subnormals..." or "Set algebra: union/intersection...")
rather than at generic allocator entry; (3) given this session's own
ordering audit found no further LOGIC gap in the region arms themselves
(every arm now correctly memos-before-recursing on every branch, durable and
ephemeral), the remaining mechanism is very likely NOT in `__region_copy_rec`
/`__region_relocate_props` at all — it is more likely to be, per the
prior sessions' own repeated finding, in how watr's OWN cross-function
fusion reshapes a caller that happens to hold a decoded offset across a
`__region_exit` call without re-deriving it — the search should move OFF
this file's own arms and onto the fused-caller / decoded-offset-cache axis
those sessions already pointed at, not back into `__region_copy_rec`.

## [ ] Carrier invariant / storedValue (was carrier-invariant-design.md; predecessor of the carrier program)

The boxed-value invariant program that preceded carrier-representation.
THREE named mechanisms: **A** enumerated-list drift — storedValue's guard
hand-reimplemented UNFIXED at 16 sites (array.js ×10, collection.js ×4,
object.js, function.js); fix = one chokepoint (bridge.js storedValue), most
landed via the formatter-dispatch commit. **B** detector blind spot —
VT['()'] treated parenthesized non-calls as opaque, so wrongness and
detector shared the blind spot by construction; FIXED (grouping unwrap).
**C** narrow-local coercion blind to carrier atoms — toI32(boxed BOOL atom)
collapsed TRUE_NAN and FALSE_NAN to 0 (ToInt32(NaN)=0), producing the
universal export-loss; FIXED (unboxBoolIR bit-extraction arm in the
decl-init ladder). Tag-preserving rebox landed as .srcPtrKind/.srcPtrAux
(stamping live .ptrKind onto boxed results is UNSOUND — it's a live
dispatch convention, confirmed by crash). THE RESIDUAL WALL (still closed):
decl-init `val = viewInit || emit(init)` stays — flipping to
argIR/storedValue makes the SELF-HOSTED kernel flip closure direct-dispatch
eligibility for a non-reassigned single-capture shape (invalid WASM,
local.set type mismatch; native provably unaffected — WAT byte-identical
either way). resolveCallee/temp()-counter theory FALSIFIED (uniq is
per-function). The kernel-oracle 'captured-then-read' row stays PENDING-FIX
until that self-host generational-drift instance is named (same class as
MECHANISM C's discovery context and the outline-hunt family).

## [x] Carrier box-site baseline (was carrier-box-baseline.md; Slice-0 artifact)

Repro: JZ_DBG_BIGINT_ERASURE=1 JZ_DBG_BIGINT_STATS=1 over the 149-module
self graph (recipe in git history / erasure-diag.js). Result (2026-08-06):
57 raw kind-erasing BIGINT flows (call-arg 37, closure-capture 6, return 5,
ternary-nullish 5, dataview 3, collection 1); fixpoint resolves 46/57 (81%)
fully raw → **11 real box sites**: 1 param (m61_layout$i64Hex bits) + 10
module-init const locals (assemble NAN_PREFIX/TAG_SHIFT_BIG/… , encode
F64_SIGN/F64_NAN/F64_QUIET) — zero hot-loop sites. assertErasureConsistency
guards whole-program presence (the '(top)' attribution split between the
two instruments is a naming mismatch, not a solver bug).

## §Region arena — TARGET-PASS ABLATION RECORD (2026-08-11, coordinator-preserved; the executing agent reported but failed to commit this)
The untried axis: TARGET optimize-pass ablation through a FIXED region-live
kernel (zero rebuilds). Facts from the run: repros trap ONLY at target L2
(clean 0/1/3, 5/5 deterministic). Sweep of all 62 PASS_NAMES both
directions: enable-at-L0 → zero single-flag triggers; disable-at-L2 → 10
individual passes clear the join repro; only watr/foldSetToTee/
hoistConstantPool clear all 4 probes. DECISIVE: forcing {level:2,
hoistConstantPool:false} across the FULL scaled test:wasm suite → 47 fail
vs baseline 49, but only 9 rows common — 40 fixed, 38 PREVIOUSLY-CLEAN rows
now fail. A RESHUFFLE, not a fix: pure allocation-ordinal sensitivity.
hoistConstantPool's implementation read: no module-scope holder. This
record motivated the boundary-arithmetic audit that followed (whose window
(B) — forwarding stubs destroyed by the closing compaction memcpy —
explains the reshuffle mechanism exactly).

## §Region arena — TWO “UNTRIAGED RESIDUALS” TRIAGED (2026-08-11)

Both names were misleading because each test's `try` spans compilation and
execution. Neither was a target-program value divergence.

1. **Float64Array fuzz residual: closed by Watr 5.7.14.** Reproduced against
   JZ `1455a278` plus pre-root Watr `fa3fe0e`: fuzz seed 3,
   `export let f=(buf,n)=>{...buf[i]=buf[i]*-1...}`, fails while the region-live
   kernel compiles the target at O2 with `memory access out of bounds`; O0/O1/O3
   are clean. The finding's real record is `{kind:'jz-compile', opt:2}`, not a
   mismatched Float64Array element. With the identical JZ commit and Watr 5.7.14,
   that source compiles at all four levels and the scaled fuzz row passes. This
   accounts for one of the 49→42 rows removed by complete safepoint rooting.

2. **Radix host-decode residual: part of the surviving region wall.** At O2 the
   region-live kernel fails before producing the target module, so target
   `__jz_last_err_bits` decoding never runs. Pre-root Watr surfaced an OOB; Watr
   5.7.14 moves the failure to an unmarked `unreachable` with kernel marker 0.
   The top frame is `wasm-function[12]`, already identified by the exact-kernel
   disassembly above as `$__alloc`'s unsigned-wrap guard. O0 compiles cleanly.
   This is a compact reproducer for the still-open post-safepoint stale-size/
   allocation-window class, not a bug in RangeError decoding.

A clean dormant control at `444990d0`, exact published Watr 5.7.14, compiles
both sources at O0/O1/O2/O3. Its targeted hosted run
`JZ_TEST_TARGET=jz.wasm JZ_FUZZ_GATE=0.05 node test/index.js errors fuzz`
passes 141/141 tests (305 assertions), including a real RangeError with thrown
code 205 and the Float64Array oracle. Classification is therefore decisive:
one residual is fixed upstream; one is region-only and remains banked.

## §Region arena — STRUCTURAL-FUSION DISCRIMINATOR: PAD/PIN PAIR (2026-08-11),
disposable scratchpad worktrees off `region-final-2026-08-11`@`0d089b49`
(decisive) and `d1f2f2ba` (pad-control), node_modules cloned per-worktree —
verdict: BOTH tests NEGATIVE. The "compiled SHAPE of `__region_copy_rec`
crosses a watr fusion/inlining threshold" hypothesis (this section's own
prior "wall2 WAT-diff" and "second-wall pass bisection" entries' final open
angle) is now REFUTED on both its named sub-mechanisms. Wall NOT closed;
banked, no further hunting attempted this session per the task's own
"wall ⇒ bank, stop" instruction. Independent of, and not informed by, the
concurrent "safepoint rooting" thread visible immediately above this entry
(49→42) — this session worked strictly the structural-fusion axis named in
its own brief, against the `0d089b49` baseline (49→45, windows A+B).

**Repro used** (found faster/cheaper than the historical `String(x>0&&1)`
row, which the ordering-audit fix already closed): kernel-oracle's own
`computed member key` row, `export let f = (x) => { let o = {}; o[x > 0 &&
1] = 'v'; return o['0'] }`, O3, deterministic 3-4/3-4 reps every build below
— same ambiguous-BOOL∪NUMBER-merge family as the closed row, different
concrete source. Found by running `test/kernel-oracle.js` once against a
freshly-built decisive kernel (14814428 bytes): **13-row harness now reports
3 failures, not the banked 13/13** — `fromnested` (O2,
`Int32Array.from([Float64Array.from([5])[0], 2])`) and `computed member key`
(O3) both trap, a REGRESSION in kernel-oracle itself versus every prior
session's 13/13 report, first surfaced here. `fromnested` was checked
against a plain, unpadded `d1f2f2ba`+regionHooks-wired control and **traps
there too, 3/3** — pre-existing, region-unrelated, disqualified as a
discriminator. `computed member key` is clean 3/3 on that same unpadded
control — a valid discriminator, used for both tests below.

**PAD TEST**: measured `__region_copy_rec`'s SOURCE-template shape directly
(module/core.js's hand-written stdlib entry vs. layout-kinds.js's
`regionCopyRecBody({hasDynProps:true})`, the shape the kernel's own compile
of itself actually pulls): control 87 lines / 6720 chars / 19 declared
locals; decisive 434 lines / 32781 chars / 22 locals. Appended an inert
padding block directly inside the control's `__region_copy_rec` body,
immediately after the ATOM immediate-check (same structural position real
arms occupy), gated behind `(if (i32.eq $t (i32.const -999999)) …)` —
`$t` is `__ptr_type`'s return, a small enumerated tag range, so
`-999999` is unreachable by construction; 343 inert `local.set` statements
over 3 new padding locals. Measured post-splice: 434 lines (exact match) /
31887 chars (2.7% under target) / 22 locals (exact match). Rebuilt
(14844274 bytes, +55 kB over unpadded control's 14789181): `computed member
key` O3 stays **clean 4/4**, `string-ambiguous` (the already-closed row)
stays clean 4/4, `fromnested` O2 still traps 4/4 (unchanged, confirming the
padded rebuild is otherwise behaviorally stable, not a broken build).
**Verdict: pure inert size/local-count growth INSIDE `__region_copy_rec`'s
own body, matched to the decisive build's measured shape, does NOT
reproduce the wall.** Consistent with (extends, not merely repeats) the
prior "layout-lottery hypothesis REFUTED" and "content isolation… does not
reproduce" findings — those tested size/content elsewhere in the bundle or
as unwired sibling functions; this is the first test of padding inside the
one function itself, and it too comes back clean.

**PIN TEST**: added `watr: { pin: ['$__region_copy_rec',
'$__region_relocate_props'] }` to the region-live meta-compile's optimize
config only (`compile()`'s `optimize.watr` object, verified to flow through
`resolveOptimize`'s `n === 'watr' && typeof v === 'object'` passthrough into
`resolveWatrOpts`, the same `pin` channel `SIMD_PINNED` uses for
`$math.*`/transcendentals against watr's `inline`/`inlineWrappers`/
`inlineOnce`/`dedupe` sole-caller passes — grep-verified as the ONLY four
passes `pin` gates in `node_modules/watr/src/optimize.js`). Rebuilt decisive
with the pin active: **byte-identical to the unpinned decisive build**,
14814428 bytes both — the pin is a proven, whole-kernel no-op. `computed
member key` O3 still traps 3/3, unchanged. **Verdict: explicitly protecting
`__region_copy_rec`/`__region_relocate_props` from watr's inliner has ZERO
effect** — because, consistent with the wall2 WAT-diff session's own
earlier finding ("`__region_copy_rec` has exactly ONE external
(non-self-recursive) caller… present as a named function in both dumps"),
neither function was ever an inlining target to begin with (both are
directly or mutually self-recursive, which excludes them from `inline`/
`inlineOnce`/`dedupe`'s sole-caller-fusion candidacy regardless of `pin`).
The task's own named mechanism — "watr's fusion/inlining of copy_rec's
shape" as a caller-fusion event — does not exist as stated; there was
nothing for the pin to prevent.

**By-name verification: not run.** Byte-identity between pinned and
unpinned decisive builds is strictly stronger proof than a by-name compare
would be (identical bytes cannot produce a different pass/fail set); running
the full scaled `test:wasm` suite against them would be certain to reproduce
the identical 45-row set already banked at `0d089b49` and was skipped as
non-informative. The padded control was not run through the full suite
either — a single clean, previously-representative repro plus the
already-established "unpadded control passes the full suite cleanly" fact
make a full run non-discriminating for a negative single-repro result;
skipped per the same reasoning, not for want of time.

**Where this leaves the wall**: every named axis in "the last uneliminated
axis" framing is now closed, all negative — not a single pass (prior
session's batch-1/2 ablation), not generic size (prior session's inert
padding elsewhere in the bundle), not new-arm content alone (prior
session's content-isolation), not bare size/local-count matched INSIDE the
one function (this session's PAD test), not fusion-into-a-caller of that one
function (this session's PIN test, and it was never fusing in the first
place). What is NOT yet ruled out, and is the honest remaining candidate:
the SPECIFIC bit-pattern/instruction-sequence content of the real arms
(dispatch rewiring + real arms together, already shown jointly necessary)
perturbing some OTHER auto-numbered function's compiled shape downstream —
a `$closureN`/`$__mkptr_6_N_d`-class renumbering event, per this section's
own wall2 entry, structurally invisible to every static, name-based
technique tried so far (including this session's). The wall2 session's own
un-pulled lever — a runtime `$__alloc`-entry-style trace pointed DIRECTLY at
`computed member key`'s actual faulting frame (not generic allocator entry;
the desync-fix session's own `$__map_from`/`forwardPropagate` stack-walk
technique) — remains the most concrete untried next step, now with a
cheaper, single-repro-deterministic fixture (`computed member key` O3) in
hand instead of the historical fuzz-seed-derived ones.

**Per the stop-on-fail tripwire**: NOT landed, NOT closed. No shared-tree
source file was ever modified — all edits (padding splice, regionHooks
uncomment, pin override) live only in two disposable scratchpad worktrees,
removed at session end. `git status`/`git diff` in the shared tree show no
changes from this session's work (an unrelated `src/compile/plan/inline.js`
edit, present at session start, was resolved by other concurrent work before
this entry was written — not touched by this session either way). Gate
ladder beyond the two discriminator repros (kernel-oracle full 13/13,
kernel-parity, fuzz 200+2000×2, full battery, dormant byte-identity,
build×2, memory watermark curve, jz×jz) NOT run — contingent on the wall
closing, and it does not. SHAs: decisive base `0d089b49`
(region-final-2026-08-11), pad-control base `d1f2f2ba`. No branches created;
both worktrees were scratch-only (uncommitted edits, discarded on removal).

## §Region arena — SAFEPOINT FIX PUBLISHED; NO-FORWARDING BANKED (2026-08-11)

Watr 5.7.14 (`a563a63`) is tagged, pushed, and published at npm integrity
`sha512-PNBeHpM7rzstcEDxiG26NW4qonyvo7EPFhSK/tgoTc7QysL/IVPOE9qMclVvjaEGtCb5ExFFLBwqZ4owSHj5bw==`.
Its publish gate passed build, declarations, native tests, and the hosted wasm
suite. JZ now pins that exact release (`444990d0`), not a caret or local symlink.

The independently banked JZ branch `region-forwarding-fix` at `0fd60ce2`
removes every region-created old-site forwarding stub and names ARRAY/OBJECT
relocation `trace-copy`; ordinary collection growth forwarding is untouched.
A root-only control and that no-stub branch, both using Watr 5.7.14, produce
exactly the same 42 failing names under
`JZ_TEST_TARGET=jz.wasm JZ_FUZZ_GATE=0.05 node test/index.js` (2722 total,
2674 pass, 42 fail, 6 skip). Thus complete Watr rooting closes 7 of the prior
49 rows, while deleting unusable forwarding stubs changes zero rows. The
no-stub layout registry passes 51 tests / 79 assertions.

Regions remain dormant. Kernel parity still OOBs on O2 `fromnested`, and the
root-only control reproduces it, so that allocation window is independent of
stub deletion. No region branch is merged or advertised; resume from
`0fd60ce2`, not from a local dependency patch.

## §Architecture re-audit item 10 — ONE VARIANT MATERIALIZER COMPLETE (2026-08-11)

All five specialization producers now delegate clone registration, fact-copy,
and atomic `{node[1], callSite.callee}` retargeting to
`src/compile/variant.js`: union-cursor (`e5f503ab`), speculative typed
(`31e76fe8`), VAL-kind dichotomy (`0ddac820`), bimorphic typed (`eeb28b8b`),
and fixed-rest (`9e941607`). A source census leaves variant registration and
call-edge retargeting only in that materializer; normal function discovery
remains in the scope/index registries.

Verification on the final tree: focused native suites 366/366 (688 assertions);
targeted hosted `errors fuzz rest-params types` 352/352 (639 assertions);
kernel parity 33/33 byte-identical WAT and kernel oracle 13/13 (493 assertions);
self-host correctness 21/21 (206 assertions). The full native battery remains
at its recorded baseline: 3419 pass, 2 standing optimizer-shape failures, 6
skip. The warm self-host perf pin also failed identically on pre-variant
`5746138f` (roughly 1.12–1.14×); fresh-instance passed. Therefore neither
standing failure class is attributed to item 10, and no cap/baseline was
changed.

## §Region arena — RUNTIME TRACE: the survivor axis root-caused to a specific
holder (2026-08-11), disposable scratchpad worktree off `0d089b49`
(region-final-2026-08-11) — verdict: the "arms' content perturbing some OTHER
auto-numbered function downstream" survivor from the pad/pin session is now a
NAMED holder with a decoded garbage value and a region-round correlation.
Not landed — a real fix is architectural (extends the watr-integration root
bundle or the mark/exit insertion scope), matching every prior session's own
"class fix, session-plus scope" conclusion. Banked per the stop-on-fail
tripwire.

**Setup, the §29 discipline exactly.** Worktree off `0d089b49`, node_modules
symlinked. Built the region-live kernel ONCE via a scratch script mirroring
`resolveSelfhostBuild`'s exact profile plus `names: true` (index.js's own
wasm name-section export, `opts.names`/`appendFunctionNames` — undocumented
for this purpose before now) — 14590.7 kB, `regionArenaLive: true`,
`optimize: {level:3, watrGuard:false, snapshotInit:true,
inlinePtrOffsetFast:false}`. Confirmed the repro 3/3: kernel-oracle's
`computed member key` row (`export let f = (x) => { let o = {}; o[x > 0 &&
1] = 'v'; return o['0'] }`, O3) — `RuntimeError: memory access out of
bounds`, deterministic every rep. `names:true` paid off immediately: Node's
own RuntimeError stack came back FULLY symbolicated, no manual
`functionNameSection`-convention index-counting needed (the wall2/alloc-guard
sessions' own workaround) —

```
$__map_delete (wasm-function[99])
  ← m120_optimize$forwardPropagate (3052)
  ← closure2190 (5154)
  ← m51_util$walkN (143) ×2
  ← m120_optimize$propagate (953)
  ← closure2287 (2457) ← closure2291 (1079) ← closure2779 (5483) ← closure1493 (4784)
```

**The frame.** `$__map_delete` is `module/collection.js`'s `genDelete`
stdlib — the SAME family the desync-fix session's `$__map_from` finding
implicated, but a DIFFERENT consumer, and this time called from
`node_modules/watr/src/optimize.js`'s own `forwardPropagate` (line
3152) — watr's own optimizer, self-hosted into the kernel — at `known.delete
(tgt)` (its `local.set`/`local.tee` invalidation path, line 3190/3226).
`known` is `forwardPropagate`'s own `const known = new Map()`, function-local,
declared line 3155.

**The faulting instruction, found before any instrumentation.**
`wasm-objdump -d` on the named `dist/jz.wasm` cross-referenced against the
RuntimeError's own module offset in the raw trap: byte `0x4451c` inside
`func[99] <__map_delete>` is `i32.load 2 0` reading local 11 (`$ls`) — the
FIRST hash-lane probe read (`$ls = $lb + ((h & (cap-1)) << 2)`, `$lb = $off +
cap*24`), matching genDelete's own WAT shape (confirmed identical between the
`compile(...,{wat:true})` text dump and the disassembled bytes).

**Instrument.** `scripts/trace-mapdelete.mjs` (scratch, reuses
`trace-inject.mjs`'s own `findFunc`/`parseFunc`/`firstBodyIdx`/`printFunc`
splicing mechanics, structural node-shape asserts throughout — throws on any
shape drift rather than tracing the wrong thing), applied to the kernel's own
`compile(...,{wat:true})` text dump (275.5 MB — reassembly via
`watr/parse`+`watr/compile` took 4.0 s this session, well under the
§29-era 81 s estimate). Hoisted the `$h`/`$ls` address computation OUT of
its nested expression into standalone statements BEFORE the block that
performs the load — semantics-preserving (locals are function-scoped, not
block-scoped) — so the WOULD-BE-faulting address is captured
UNCONDITIONALLY, even though the load itself then traps. Captured: `$coll`/
`$key` at entry, the INITIAL header-cap read (before any `-1` forwarding-hop
chase), the POST-forwarding-check final `$off`/`$cap`, `$lb`/`$end`, `$h`,
the exact `$ls` address, and `global.get $__heap` as a coarse region-round-
activity proxy. Reassembled, instantiated BY HAND (bypassing interop.js's
`instantiate()` — its `opts.imports` wrapper auto-decodes host-import args as
NaN-boxed jz values, which would corrupt a raw i64 debug channel; same §29/
alloc-guard-session caution) with minimal env stubs matching the kernel's own
6 import signatures exactly (`__ext_prop`/`__ext_has`/`__ext_set`/
`__ext_call`/`print`/`now` — none fire for this repro) plus a real
`dbg.trace` collector, using interop.js's own EXPORTED `memory()` helper for
ABI-correct `String()`/`read()` marshaling (not reimplemented by hand),
called `exports.default(source, strict=0, optJSON={level:3}, modules=0,
host=0)` — the exact ABI `test/kernel-target.js`'s `compileViaKernel` uses.

**The garbage decode.** 38,188 total `$__map_delete` invocations during this
ONE tiny compile; 38,147 sane (`capInit` ∈ {8, 16, 64} or the legitimate `-1`
forwarding sentinel, 41 times) — EXACTLY ONE anomalous, the very LAST call,
the one that traps:

```
coll        = 0x7ffc800001f4c448
key         = 0x7ffa000001a593dc
capInit     = 0x000000007ffa0000   <- garbage from the FIRST read, before any forwarding chase
off (final) = 0x0000000001f4c448   (32818248 — a plain, in-range heap offset)
cap (final) = 0x000000007ffa0000   (same garbage — the -1 chase never fires, since it isn't -1)
lb          = 0x000000000164c448
end         = 0x00000000014cc448
h           = 0x000000008c5fc9fa
ls (fault)  = 0x0000000032cbec30   (852,225,072 — 315,354,160 bytes past the 512 MB/8192-page bound)
```

`0x7ffa0000` decodes exactly per `layout.js`'s own NaN-box scheme
(`TAG_SHIFT=47`, `TAG_MASK=0xF`, `PTR.STRING=4`): tag nibble `(0x7ffa0000 >>
15) & 15 == 4` (`PTR.STRING`), aux `0x7ffa0000 & 0x7FFF == 0`. genDelete
reads `cap` at `off-4`, immediately after `len` at `off-8` — an 8-byte
`[len,cap]` header. A 4-byte read at `off-4` coming back as a STRING
pointer's HIGH half means a full 8-byte, non-SSO STRING box (tag=STRING,
aux=0) was written starting at `off-8`, physically straddling the exact
bytes this Map's own header lives at — a different, unrelated heap object
now occupies this Map's header. `$ls`, computed from the garbage `cap`,
lands 315 MB past the linear-memory bound — exactly the observed `memory
access out of bounds`.

**Region-round correlation.** Across all 38,188 calls, the traced
`$__heap` watermark DROPS (a region_exit compaction signature) only 5 times
total. The LAST drop — invocation 36,912 of 38,188, well before the
corrupted final call — goes `0x1fc0b40 → 0x1d7b960` (33,295,168 →
30,914,912 bytes, a ~2.4 MB reclaim). The corrupted Map's own header address
(`0x1f4c448` = 32,818,248) sits STRICTLY BETWEEN that drop's post- and
pre-compaction watermarks — squarely inside the range the last region_exit
reclaimed as free — yet ABOVE the post-compaction floor, i.e. within the
territory the heap re-grew through afterward (climbing monotonically
30,914,912 → 32,825,888+ over the following ~1,276 calls, zero further
compaction in between). This exact address never appears as an `off` in any
of the 38,187 prior traced calls this run — its only appearance is the
corrupted one.

**The holder, named directly, one hop (matches or beats the §29 chain's own
2-hop precedent).** `known` — `forwardPropagate`'s own per-call `Map()`
local (`node_modules/watr/src/optimize.js:3155`) — is invisible to
region-arena's root enumeration BY CONSTRUCTION: `runRounds`'s own
`regionExit` call (`optimize.js:8471`) passes exactly `[ast, dirty,
snapshots, opts.constF64]` as the live root bundle — a hand-curated,
pass-EXTERNAL list. `forwardPropagate`'s `known`, `propagate`'s own
use-count maps, and any other PASS-INTERNAL Map/Set/Array live entirely
outside that bundle. The SAME comment block (`optimize.js:8466`,
`CNT = null; CNT_FN = null; SW.length = 0; SW_MEM = false`) already
hand-drains a DIFFERENT, incomplete allowlist of pass-scratch MODULE
GLOBALS right before every `regionExit` call, specifically because
module-scope pass scratch is "normally already dead" there — an
acknowledged, partial patch for exactly this class of hazard, that never
covered `known` (a plain per-call LOCAL, not a module global — never a
candidate for that drain list in the first place). The exact
allocation-order race that lets the string collide with `known`'s header —
whether `known`'s own storage is the stale side of a lingering, un-relocated
reference, or whether the allocator legitimately handed out address
32,818,248 twice — needs one further level of trace (instrumenting
`$__mkptr`/`__alloc_hdr_n`/the region_exit call itself around this specific
address) to pin down beyond the mechanism class; not attempted this session.

**Fix-or-bank: BANKED.** This is the exact class every prior region-wall
session's own recommendation converged on ("some OTHER auto-numbered
function... structurally invisible to every static technique... the next
lever is runtime") — now with a decisive runtime trace naming the SPECIFIC
holder (`known`, inside watr's own self-hosted `forwardPropagate`) and the
SPECIFIC provenance class (a pass-internal collection outside region-arena's
4-item root bundle, colliding with a STRING allocated into territory the
prior round's compaction reclaimed). A provably-correct fix is architectural,
not a one-line patch: either (a) extend the watr-integration root bundle (or
its per-pass scratch-drain allowlist) to cover every pass's own live locals
across a round boundary — touches every entry in watr's `PASSES` table,
well beyond session scope — or (b) scope WHERE `regionMark`/`regionExit`
get inserted so no pass with untracked live locals ever straddles a round
boundary — harder to verify sound without auditing every pass for the same
shape. Neither is session-scoped or provably correct without that broader
audit, matching the desync-fix session's own precedent for this class
("session-plus scope, not a session-remainder scope").

**By-name verdict: N/A** — no fix applied, no shared-tree source change.

**Gates: NOT run** — contingent on the wall closing (kernel-oracle ×N,
kernel-parity, fuzz 200+2000×2, full battery, dormant byte-identity, build
×2, memory watermark curve, jz×jz all gated on a landed fix, per the task's
own acceptance framing).

**Per the stop-on-fail tripwire**: NOT landed, NOT closed. `git status` in
the shared tree shows zero changes from this session (HEAD advanced to
`6adde860` via unrelated concurrent work, confirmed by `git log`/`git status`
before and after). Every artifact this session produced — the named-build
script, the WAT dump, `trace-mapdelete.mjs`, the reassembly/instantiation
harness, the 275.5 MB instrumented WAT, the ~38 MB raw trace log — lives only
in the scratchpad worktree (`/private/tmp/.../scratchpad/region-runtime-
trace`), removed at session end, never committed. SHAs: base `0d089b49`
(region-final-2026-08-11, unchanged); no branch created for this session's
own work (pure investigation, no edits to bank as a diff).

**Recommendation for next session**: (1) don't re-run the static/pass-name/
size axes — exhausted, all negative, per every prior session including the
pad/pin discriminator pair; (2) the next concrete lever is tracing
`$__mkptr`/the STRING-allocation call sites plus `__region_exit`'s own
compaction loop around address range `[0x1d7b960, 0x1fc0b40]` for THIS
specific repro, to determine whether `known`'s Map or the colliding STRING
is the one holding a stale reference — this pins the exact allocation-order
race and turns "architectural fix, unscoped" into a scoped one; (3) if that
trace shows `known` itself is the stale side (a genuinely-reclaimed,
still-referenced pass-internal value), the scoped fix is almost certainly
"treat forwardPropagate's own `known` as an explicit implicit root at the
`runRounds` regionExit call site" — the SAME shape as the `$__dyn_props`
implicit-root fix already landed for a structurally identical gap
(`.work/research.md`, `__region_exit`'s own header comment); if instead the
STRING is the stale side, the fix target moves to whatever allocates
strings during watr's own pass execution.

## §Region arena — ALLOCATION-COLLISION ARITHMETIC AUDIT (2026-08-11): size
invariant CLEARED, one dormant forwarding-delta hazard found, `known`-Map
wall UNCHANGED

Read audit of `module/core.js`'s `__region_exit`/`__region_copy_rec`/
`__region_relocate_props` and `module/collection.js`'s `genUpsert`/
`genUpsertGrow`, against the task's own synthesis: two live objects
overlapping is an allocation collision, so either `$__heap` was set wrong at
exit (too low ⇒ new allocations overlap compacted survivors) or staging
allocated past the measured size. No worktree, no kernel rebuild — a paper
audit of the current tree (main HEAD `4adc7048` at start), verified by
mathematical proof against `genUpsert`'s own load-factor invariant and
cross-checked against `9d0e3384`'s own stress-verification scope. No source
changed.

**Size-invariant table.** `__region_exit` (core.js:772-833) computes
`$size = $__heap - $T` at line 830, the LAST statement before the closing
`(memory.copy (mark) (T) (size))` (831) and `$__heap = mark+size` (832) —
nothing allocates between the size read and the reset. Every staging
allocator enumerated by the task runs BEFORE that read, hence inside `size`
by construction:

| Arm | Where it allocates | Runs before line 830's `$size` read? | Can it grow mid-staging? | If it grows, is the growth's own address counted in `size`? | Is the OLD site's forwarding pointer written delta-correct? |
|---|---|---|---|---|---|
| ARRAY/STRING/BIGINT copy (`__region_copy_rec`, core.js:926-1096) | plain `$__alloc`/`$__alloc_hdr` bump, no rehash | yes (called from line 781, before 830) | n/a — flat copy, no table | n/a | n/a (STRING never forwards; ARRAY/BIGINT write `newOff - delta`, core.js:934, 1094 — correct) |
| SET/MAP rebuild (`__region_copy_rec`, core.js:1098-1139) | `__alloc_hdr_n(0, $cap, stride+LANE)` — fresh table pre-sized to the SOURCE's own `cap` (1113), then `$__coll_order` + `$__map_set`/`$__set_add` reinsert (1124-1136) | yes | in principle yes (`genUpsert`'s own 75%-load check, collection.js:399) — but see proof below: provably never fires given the pre-sizing | yes — any allocation genUpsert's grow branch makes is still an ordinary `$__alloc_hdr_n` bump, so it lands before line 830 regardless | **NO** — `genUpsert`'s forward=true grow path (collection.js:425-429) stores the raw, T-relative `$newptr` at `(off-8)` unadjusted; `__region_copy_rec`'s own convention always writes `newOff-delta` (core.js:1094,1137-1138) — a structural mismatch, see below |
| `__region_relocate_props` sidecar (core.js:858-894) | `__alloc_hdr_n($n, $cap, MAP_ENTRY+LANE)` — exact-size verbatim `memory.copy` of the WHOLE old block (bucket positions provably stable, keys are interned strings), no rehash, no grow branch at all | yes (called recursively from `__region_copy_rec`, itself before 830) | no — never calls genUpsert/genUpsertGrow | n/a | writes `newOff-delta` (892) — correct |
| `$__dyn_props` global migration (core.js:802-828) | `__alloc_hdr_n(0, $dpCap, MAP_ENTRY+LANE)` — fresh table pre-sized to the OLD `$__dyn_props` block's own `cap` (810), then `$__coll_order` + `$__ihash_set_local` reinsert (812-821) | yes (before 830) | same shape as the SET/MAP arm, via `genUpsertGrow`'s `forward=true` path (collection.js:671-683) | yes, same reasoning | **NO** — same raw-`$newptr` write (collection.js:680) |

**Proof the two "yes, can grow" cells never actually fire.** `genUpsert`/
`genUpsertGrow` both grow-before-insert: the check `size*4 >= cap*3`
(collection.js:399, :645) runs BEFORE every insert, so a table's own tracked
occupancy (`off-8`, incremented on every new-key insert, decremented on
every delete — collection.js's `genDelete`/`durableSlotLogIR` machinery)
can never reach `0.75*cap` without growing first; therefore at any moment a
table's real live count `n` satisfies `n*4 < cap*3` strictly. Both
region-staging rebuild sites pre-size their FRESH table to the SOURCE's own
`cap` (not to `n`, not to `n`-plus-slack) and reinsert exactly
`$__coll_order_n` (`n`) items starting from a fresh `size=0`
(`__alloc_hdr_n(0, cap, ...)` — confirmed: the `len` param zero-inits the
size field, core.js:1479-1486). The tightest in-loop check is at the LAST
insert (`i = n-1`, current size `= n-1`): `(n-1)*4 < 3*cap` follows directly
from `n*4 < 3*cap`. So a same-cap rebuild of a table's own live entries can
never cross the grow threshold — **the collision window from the task's own
"grow during rebuild" hypothesis does not exist under the current codebase**,
CONTINGENT on the occupancy-count field actually tracking real occupancy.
That contingency is exactly what `9d0e3384` ("collection occupancy-length
desync: fix 3 general writer bugs, harden `__coll_order` consumers")
targeted and its own verification note explicitly names "grow-interaction ×
multi-structure-per-round" as one of its 1500+ native stress dimensions (0
desyncs found) — `9d0e3384` is an ancestor of both the current `main` HEAD
and the runtime-trace session's base (`0d089b49`), so its fix is already
live under this audit. No residual desync mechanism was found this session
beyond what `9d0e3384` already closed.

**A real but DORMANT hazard found, not the cause of the observed trace.**
`genUpsert`'s (SET/MAP) and `genUpsertGrow`'s (HASH/`$__dyn_props`) own
75%-load grow path is a GENERAL, delta-agnostic routine — used everywhere
in the runtime, not just region-staging — and its forward-marking write
(`(i32.store (off-8) (local.get $newptr))`, collection.js:426,680) always
stores the address `$__alloc_hdr_n` JUST returned, i.e. wherever `$__heap`
currently points. Outside region-staging that IS the final address (correct).
Inside region-staging (`delta != 0`), every OTHER relocation write in this
same function family adjusts by `-delta` before storing (core.js:826-828,
892-893, 1094, 1137-1138) because the staged copy hasn't been moved down to
its final `[mark, mark+size)` home yet. If a genUpsert-family grow ever DID
fire while `delta != 0`, the old table's forwarding stub would carry a
T-relative address `delta` bytes too high — exactly the "points into
territory the next round's allocations legitimately reuse" corruption shape
this whole wall is chasing. Proven dormant today by the invariant above
(no grow fires in either audited rebuild site), so it is NOT what produced
the `known`-Map trace — `known` never enters `__region_copy_rec`,
`__region_relocate_props`, or the `$__dyn_props` migration at all (it's
outside the `[ast, dirty, snapshots]` root bundle, per `4adc7048`'s own
finding). Not fixed this session: a general fix requires threading a
region-delta concept through `genUpsert`/`genUpsertGrow`, both hot,
non-region-aware functions called from ordinary (non-staging) code
constantly — invasive, not a session-scoped patch, and moot until region-
arena is re-enabled (`scripts/self.js`'s `REGION_HOOKS_ACTIVE = false`
today). Flagged for whoever eventually lands the architectural root-bundle
fix: harden this (delta-plumbing, or a debug-only "never grows here" trap)
before trusting a SET/MAP/HASH rebuild under load factors any tighter than
what `9d0e3384` stress-tested.

**Collision window found: NONE.** `__region_exit`'s size arithmetic is
provably correct — `size` is measured after every staging allocator in
scope (including a hypothetical mid-rebuild grow, which would still land
inside `[T, $__heap)` before the read) and nothing allocates between that
read and the closing `memory.copy`/heap reset. The task's own synthesis
("too low `$__heap`" / "staging allocated past measured size") is a real
allocation-collision taxonomy, but this audit closes off BOTH arithmetic
branches for the two in-root-bundle SET/MAP-shaped arms: the arithmetic is
sound, and no staging write escapes the counted `size`. This independently
CONFIRMS (via an orthogonal proof path, not by re-reading the same trace)
`4adc7048`'s own conclusion: the `known`-Map corruption is caused by `known`
never being counted AT ALL — not measured wrong, not overflowing measured
size, simply invisible to the root-bundle enumeration that `size`/`root`
are computed from. "$__heap set wrong at exit" is true only in the sense
that it's correct for the root bundle it was given and that bundle is
incomplete — not an arithmetic defect in `__region_exit` itself.

**Fix-or-bank: BANKED.** No source change lands — there is nothing to fix
at the arithmetic layer; the size invariant already matches the task's own
recommended pattern ("measure size AFTER all staging allocations complete").
The actual defect remains exactly what `4adc7048` named: extend the
watr-integration root bundle (or its per-pass scratch-drain allowlist) to
cover every pass's own live locals across a round boundary, or rescope where
`regionMark`/`regionExit` get inserted — both session-plus scope, unchanged
by this audit. This audit's contribution is negative-but-decisive: it rules
the arithmetic axis OUT, so no future session needs to re-open it.

**By-name verdict: N/A** — no shared-tree source change; `module/core.js`
and `module/collection.js` read-only this session.

**Gates: NOT RUN** — no fix to gate. kernel-oracle/kernel-parity/fuzz/full
battery/dormant byte-identity/build×2/memory-watermark-curve/jz×jz all
remain contingent on the wall closing, per the task's own acceptance
framing, and it does not close this session.

**Memory curve / jz×jz: NOT REACHED.**

**SHAs:** main HEAD at session start and end: `4adc7048` (unchanged apart
from this ledger entry). Files audited, unmodified: `module/core.js`
(`__region_mark`/`__region_exit`/`__region_relocate_props`/
`__region_copy_rec`, lines ~766-1151), `module/collection.js` (`genUpsert`
lines 365-471, `genUpsertGrow` lines 611-733, `__alloc_hdr`/`__alloc_hdr_n`
core.js:1464-1486). `9d0e3384` confirmed ancestor of both `main` and
`0d089b49` (region-final-2026-08-11); its own commit message's stress-test
dimensions ("grow-interaction × multi-structure-per-round", 1500+ trials, 0
desyncs) is the empirical backing this audit's math leans on rather than
re-deriving from scratch. No worktree created — pure static/paper audit, no
build, no repro re-run.

**Recommendation for next session:** unchanged from `4adc7048` — the only
remaining lever is the architectural root-bundle extension (or
`regionMark`/`regionExit` re-scoping); this session additionally hands that
future work a documented pre-condition — before trusting any SET/MAP/HASH
rebuild under load factors tighter than `9d0e3384`'s stress corpus, hem in
or assert against the `genUpsert`/`genUpsertGrow` delta-unaware
grow-forwarding write named above, since region-arena re-enabling is
exactly the condition that makes it reachable.

## §Region arena — EVENT-SEQUENCE VERDICT: NO mid-pass exit, 5/5 clean
(2026-08-11), disposable worktree off `0d089b49` (region-final-2026-08-11)
— verdict: the "earlier control-flow reading" (regionExit fires only
between rounds, no pass call live) is CONFIRMED CORRECT by direct runtime
instrumentation, not just by source inspection — REFUTING the "mid-pass
exit" alternative. The prior runtime-trace session's own framing ("known's
storage reclaimed by an exit AND used after = the Map was LIVE across an
exit") is now understood more precisely: it does not mean live *during* the
exit call (proven impossible this session) — it means `known`'s own
address, allocated cleanly inside its own still-executing call, gets
overwritten LATER in that same call by an unrelated allocation, entirely
within one uninterrupted post-exit bump-growth window (zero further
compaction). That reframes the bug class away from region-exit *timing*
altogether and toward ordinary allocator/heap-arithmetic address reuse —
narrower, and different, than the "extend the root bundle" fix class every
prior session (including `4adc7048`'s own) converged on, since extending
the root bundle only helps if a live value is being *reclaimed* by an exit
it should have survived, and no exit ever fires while a value it would need
to reclaim is live. Not landed — no source change, wall stays open. Banked
per the stop-on-fail tripwire.

**Method.** Worktree off `0d089b49`, node_modules symlinked, watr 5.7.14
confirmed. Built the region-live kernel as WAT TEXT directly (a scratch
`scripts/build-region-wat.mjs` calling `compile(profile.graph.code,
{modules, memory, optimize, wat:true})` via `resolveSelfhostBuild()` —
WAT text carries symbolic names natively, no separate `names:true`
wasm-name-section step needed) — 275.5 MB, `regionArenaLive: true`,
`optimize: {level:3, watrGuard:false, snapshotInit:true,
inlinePtrOffsetFast:false}` (the standing region-arena gate, unchanged).

**Locating the two hook sites — the first finding, before any trace ran.**
`(func $__region_mark ...)` / `(func $__region_exit ...)` do NOT survive as
standalone named functions ANYWHERE in the compiled O3 kernel (grep across
6.4M lines, filtering out false positives from the kernel's own embedded
stdlib-template STRING DATA — `module/core.js`'s WAT template text for
these exact functions is itself compiled-in as runtime string data, since
the self-hosted kernel needs it to emit these functions into ANY target
program it compiles, and raw substring search collides with that data).
Both hooks are FULLY INLINED into their sole caller — consistent with
`4adc7048`'s own "no surviving named function... fully inlined" finding for
`runRounds`/`$__ptr_type`/`$__ptr_aux`, now shown to extend to the hooks
themselves. `__region_mark`'s trivial one-expression body
(`f64.convert_i32_u(global.get $__heap)`) leaves no distinguishing local to
search for and was not separately traced (see "what wasn't needed" below).
`__region_exit` WAS located: its own declared locals (`$mark`, `$delta`,
`$memo`, `$dpCap`, `$dpI`, `$dpN`, `$dpNewOff`, `$dpOff`, `$dpOrd`,
`$dpOutPhys` — `module/core.js:803-895`) survive post-inlining with an
`$__inl74_` rename prefix (watr's own inline-group naming), found by
grepping for `__inl[0-9]*_delta\b` (a name specific enough not to collide
with stdlib-template string data) and landing inside `$closure2907` — the
`regionHooks.exit: (mark, root) => __region_exit(mark, root)` closure,
confirmed by matching its full local list and by its closing instruction
being exactly `__region_exit`'s own contract:
`(global.set $__heap (i32.add (local.get $__inl74_mark) (local.get
$__argc)))` (`$__argc`, an unused param slot, reused by watr's register
allocator to hold `size`). A second copy (`$closure2759`, `$__inl73_`
prefix) exists for a different top-level entry point (`compileWat`, dead
code for this repro's `default`/`compileSelf` path — confirmed by the
5-events match below) and was left uninstrumented.
`$m120_optimize$forwardPropagate` (`node_modules/watr/src/optimize.js:3152`)
survives as an ordinary named function (multiple call sites — one per dirty
function per round from `propagate`, line 5147 — disqualifies it from
watr's sole-caller inline/inlineOnce/dedupe family), with its own `known`
local directly visible (i32), and exactly one syntactic exit
(`(return (local.get $changed))`, matching its JS source's single `return
changed`).

**Instrumentation** (`scripts/trace-eventseq.mjs`, scratch — reuses
`trace-inject.mjs`'s own splicing mechanics: line-range slice, `watr/parse`
+ mutate + `watr/print`, single-pass reassembly; note jz-generated closure
names carry an invisible U+E000 PUA marker after `$` — `bare()`-stripped
before comparison, same convention as `trace-inject.mjs`'s own doc). A
single monotonic global counter (`$__dbgSeq`) orders every event; `(tag,
seq)` pairs go out over a new `(import "dbg" "trace" (func $dbgtrace (param
i64 i64)))`. forwardPropagate: tag 1 at entry (right after its locals), tag
2 right before its sole return. `$closure2907`: tag 3 right before the
closing `global.set $__heap`, bracketed by tag 10 (old heap value) / tag 11
(new heap value, a pure re-evaluation of the same `mark+size` expression —
no added side effects). Reassembled via `watr/parse`+`watr/compile`
directly (2.2 s parse, 61.7 s compile — both consistent with the historical
§29-era estimates), instantiated BY HAND (bypassing `interop.js`'s
`instantiate()` — its export-call wrapper auto-marshals plain JS args into
the kernel's real i64-carrier ABI via a `jz:i64exp` custom-section map,
which would have been the easy path, but doing it by hand keeps the import
side, where `dbg.trace`'s raw i64 bits must NOT be NaN-decoded, unambiguous
— same §29/RUNTIME-TRACE-session caution). Confirmed the export ABI
directly from the named WAT (`$compileSelf$exp`, exported as both
`"compileSelf"` and `"default"`): all 5 params are i64, each
`f64.reinterpret_i64`'d immediately — every argument had to be the correct
f64-bit pattern as a BigInt (`interop.js`'s own `f64ToI64`), not a bare `0`/
`1`; `mem.String()` already returns the right BigInt shape. Minimal `env`
stubs for the kernel's other 6 imports (`__ext_prop/has/set/call`, `print`,
`now`) — none fired, matching the repro's own scalar/dict-only shape.

**Result — the repro reproduced identically** (`RuntimeError: memory
access out of bounds`, same message as every prior banked report). Total
events: 5010 — forwardPropagate 2498 entries / 2497 returns (the 2498th,
seq 5000, never returns — the call still on the stack at the trap, matching
`4adc7048`'s own symbolicated stack: `$__map_delete ← forwardPropagate ←
...`), region_exit fired exactly **5** times — an EXACT match to
`4adc7048`'s own, independently-derived `$__heap`-watermark-drop count
("only 5 times total"), strong cross-validation that this instrumentation
found the complete, correct site.

```
region_exit seq=1849: entries-so-far=924  returns-so-far=924  (live=0) heap 44912736 -> 27168424
region_exit seq=2944: entries-so-far=1471 returns-so-far=1471 (live=0) heap 39194552 -> 28123848
region_exit seq=3585: entries-so-far=1791 returns-so-far=1791 (live=0) heap 36168912 -> 29049024
region_exit seq=3948: entries-so-far=1972 returns-so-far=1972 (live=0) heap 35912944 -> 29969352
region_exit seq=4149: entries-so-far=2072 returns-so-far=2072 (live=0) heap 35881368 -> 30889456
```

Every single one of the 5 fires at `entries-so-far == returns-so-far` —
**zero forwardPropagate calls live at any region_exit, ever, in this run.**
The crashing call (entry seq 5000) starts 851 sequence-ticks (≈426
forwardPropagate call-pairs) after the LAST region_exit (seq 4149) — deep
inside a single, uninterrupted growth window with no further compaction
before the trap. Directly answering the task's own question: **no exit
fires between a forwardPropagate entry and its return — not once, across
the whole repro.**

**What this settles.** The two framings named in the task brief are NOT
both partially right in some blended way — one is flatly correct and one
was an imprecise gloss on the same underlying fact. "regionExit fires only
between rounds when no pass call is live" is TRUE, now verified at the
runtime/instruction level (not merely by reading `runRounds`'s synchronous,
non-reentrant JS source, which already implied it but couldn't rule out a
compiler-introduced reordering). "`known`'s storage reclaimed by an exit
AND used after" does NOT describe a value surviving PAST its round's own
exit while still needed (the classic missing-root shape `4adc7048`'s fix
recommendation targeted) — every forwardPropagate call whose `known` could
possibly be live-across-an-exit has ALREADY RETURNED by the time that
round's regionExit runs, by construction (synchronous call stack, proven
empirically above). The actual mechanism is a call whose OWN `known`,
allocated fresh WELL AFTER the last exit, gets its live memory silently
reused by something else *later in the same still-running call* — i.e. two
logically-live allocations landing on the identical address inside one
monotonic bump-growth window with no compaction between them. A correct
bump allocator cannot do this on its own; either a `known`-family
allocation's SIZE/advance of `$__heap` is short somewhere, or the collision
originates in a different, not-yet-traced `$__mkptr`/`__alloc_hdr_n` call
path.

**What wasn't needed, and why.** `__region_mark` was never separately
instrumented — it's a pure bookmark (`f64.convert_i32_u(global.get
$__heap)`, no side effects, nothing to reclaim), so a mark firing mid-pass
would be harmless by construction; only `__region_exit`'s reclaiming
compaction can produce the corruption class this whole wall chases, and it
is the one instrumented and traced to zero mid-pass fires. `$closure2759`
(the `compileWat`-path's own region_exit copy) was left uninstrumented —
this repro exercises only `default`/`compileSelf`, and the 5-events exact
match against `4adc7048`'s independent count confirms nothing on that path
fired either.

**Fix-or-bank: BANKED — no fix attempted, per the task's own "wall ⇒ bank,
stop" instruction once the sequence question was answered.** The task's own
branch-3 framing ("the Map REFERENCE outlives the call — trace where; fix
at that holder") does not quite fit what was found either: this is not a
reference outliving its call, it is a live call's own fresh allocation
losing its address to something else before that same call is done with
it. The next concrete, scoped step (not attempted this session): instrument
`$__mkptr`/`__alloc_hdr_n` directly (every call, not just the two hook
sites) across the growth window `[30,889,456 → the crash]` — the territory
entirely produced by ordinary bump allocation after the last (5th, clean)
region_exit — to find the SPECIFIC second allocation that lands on
`known`'s already-live address, which pins whether the bug is a
short-by-N-bytes size computation somewhere in that family or a genuinely
duplicated `$__heap` read/write race. This is the same lever `4adc7048`'s
own recommendation named, now provably narrowed OFF the region_exit/root-
bundle axis entirely (that axis is closed by this session, not just
"still the leading theory").

**By-name verdict: N/A** — no shared-tree source change; `module/core.js`
and `node_modules/watr/src/optimize.js` read-only this session (the
instrumentation only ever touched a scratch WAT dump inside the disposable
worktree).

**Gates: NOT RUN** — no fix to gate. kernel-oracle ×N / kernel-parity /
fuzz 200+2000×2 / full battery / dormant byte-identity / build×2 / memory
watermark curve / jz×jz all remain contingent on a landed fix, per the
task's own acceptance framing, and none lands this session.

**Memory curve / jz×jz: NOT REACHED.**

**Per the stop-on-fail tripwire**: worktree-only. `git status`/`git diff`
in the shared tree show zero changes from this session (main HEAD moved to
`e87618c2` via unrelated concurrent work, confirmed before and after —
this ledger entry is the only edit this session makes to the shared tree).
Every artifact this session produced — `scripts/build-region-wat.mjs`,
`scripts/trace-eventseq.mjs`, `scripts/run-eventseq.mjs`, the 275.5 MB
instrumented WAT, its compiled-bytes cache, the raw event log — lives only
in the scratchpad worktree, removed at session end, never committed. SHAs:
jz worktree base `0d089b49` (region-final-2026-08-11, unchanged); watr
`node_modules` symlinked from the shared tree, version 5.7.14 confirmed
(`a563a63`, unchanged). No jz branch created — pure instrumentation and
trace, no diff to bank. watr repo untouched (no edits, no build) this
session.

**Recommendation for next session**: don't re-open the mid-pass-exit
question — closed, negative, with an exact independent-count
cross-validation (5/5). Go straight to the `$__mkptr`/`__alloc_hdr_n`
instrumentation named above, scoped to the specific growth window this
session already bounded — the fastest remaining path to a scoped,
provably-correct fix, one level more concrete than `4adc7048`'s own
recommendation.

## §Region arena — ALLOCATOR BOOKKEEPING PROVEN CLEAN ACROSS THE WHOLE RUN
(2026-08-11): every `$__heap`-moving instruction in the compiler traced,
zero unexplained collisions; the "33 +8/+16 gaps" open item resolved as
benign (untraced inlined-`$__alloc` copies, not corruption); wall REDIRECTED
off the allocator axis entirely, onto genUpsert/genDelete's own writes

**Premise note, read first.** This session's own task brief cited a
"colliding-pair session" (allocator proven clean across 2.36M records; 33
positive +8/+16 gaps in an earlier phase) as already-banked prior work. No
such entry exists anywhere in this file — `grep -n "colliding-pair\|2.36M\|33
positive"` over `.work/research.md` before this session returned nothing.
Rather than build on an unverifiable citation, this session ran the
experiment itself from `ed70f36a`'s own actual last-recorded state (the
EVENT-SEQUENCE VERDICT above) and independently landed within 0.001% of the
cited record count (2,365,603 traced events, not 2.36M-even) and the EXACT
cited gap count (33, not "about" 33) — strong evidence a real session
produced those numbers and simply never committed its ledger entry (the
task's own COLLISION note: "prior agents keep forgetting to commit the
ledger entry" — this is presumably an instance of exactly that, now
reconstructed and banked properly). Findings below are this session's own,
independently reproduced, not copied from the citation.

**Setup.** Scratchpad worktree off `0d089b49` (region-final-2026-08-11),
node_modules symlinked, watr 5.7.14 confirmed. Built the region-live kernel
as WAT text via `resolveSelfhostBuild({optimize:3, snapshot:true,
watrGuard:false})` (the standard recipe — `regionArenaLive:true`,
`inlinePtrOffsetFast:false` auto-derived) — 275.5 MB, 188.8 s, byte-for-byte
consistent with every prior session's own build (same commit, same profile).

**Method — audit every `$__heap` write, not just genUpsert.** A source grep
(`grep -rn 'global.set \$__heap\b' module/ src/`) found exactly 8 sites in
the ENTIRE compiler, not just region_exit/alloc/clear: `__alloc` (the bump),
`__clear` (2 forms — owned-memory reset, assemble.js's post-hoc twin),
`__region_exit` (the compaction reset), and FOUR previously-unaudited manual
bypass sites that write the global directly, all "reclaim/extend at heap
top" optimizations: `module/string.js`'s `__str_concat`/`__str_concat_raw`
(concat-fast bump-extend-in-place, ~line 1212), `__str_append_byte` (byte
bump-extend, ~1262), `__str_pad` (SSO-result reclaim, a heap REWIND to
`off-4`, ~1595), and `module/number.js`'s `__num_radix` (SSO-result reclaim,
a heap REWIND to `$buf`, ~625). These bypass `__alloc`'s own bump logic
entirely — exactly the kind of mechanism that could move `$__heap`
inconsistently with the "every allocation gets a disjoint range" invariant
the prior arithmetic audit (the ALLOCATION-COLLISION ARITHMETIC AUDIT
session above) proved only for `__region_exit`'s own size read, not for
these four.

Wrote `scripts/trace-alloc.mjs` — a GENERIC AST-based instrument (not
source-text-shape matching: watr's O3 optimizer register-allocates these
bodies into shapes that don't match `module/*.js`'s own unoptimized WAT text
verbatim — confirmed live: `$__alloc`'s `$next` local vanishes entirely,
riding in the reused `$bytes` param slot instead). For each of the 6 target
functions it parses the function's own line-range slice (reusing
`trace-inject.mjs`'s `findFunc`/`parseFunc`/`firstBodyIdx`/`printFunc`
splicing mechanics, with a length-gated `findFunc` fix — the kernel's own
embedded stdlib-template STRING DATA contains these exact function-def
substrings as one gigantic single-line `(data ...)` blob per prior
sessions' own precedent; filtered by line length before matching), finds
the SINGLE `(global.set $__heap X)` node by generic AST search (not a
hand-derived index path), and replaces it with `(local.set $dbgNew X)
(call $dbgtrace (tag) (heap-before<<32 | dbgNew)) (global.set $__heap
(local.get $dbgNew))`. `__str_append_byte` confirmed genuinely absent from
this kernel build (zero short-line matches at all, not a naming miss) —
this program's own source never triggers the `buf += str[i]` fusion, so
`reachableStdlib` dropped the helper; left uninstrumented (nothing to
instrument). The other 5 sites instrumented cleanly. `__region_exit` is
fully inlined (per `4adc7048`'s own finding) — not re-instrumented; its 5
known `(before,after)` pairs from the EVENT-SEQUENCE-VERDICT session above
serve as this session's ground truth for legitimate compactions.

Reassembled via `watr/parse`+`watr/compile` directly (3.1 s parse, 61.4 s
compile), instantiated BY HAND (bypassing `interop.js`'s `instantiate()` —
its export-arg auto-marshaling via the `jz:i64exp` custom section would
corrupt this raw i64 debug channel, the same caution as every prior
session), minimal `env` stubs (a throwing Proxy — none of the kernel's 6
real imports fire for this scalar/dict-only repro, confirmed), a real
`dbg.trace` collector, `interop.js`'s own exported `memory()` for
ABI-correct `String()`, calling `exports.default(source, strict=0,
optJSON={level:3}, modules=0, host=0)` with every arg as the correct f64-bit
BigInt (`f64ToI64`) — the exact ABI `test/kernel-target.js`'s
`compileViaKernel` uses. Ran the kernel-oracle's own `computed member key`
repro (`export let f = (x) => { let o = {}; o[x > 0 && 1] = 'v'; return
o['0'] }`).

**Result.** Reproduced deterministically: `RuntimeError: memory access out
of bounds`. **2,365,603 total `$__heap`-move events** captured (`alloc`
2,113,750 / `concat-fast` 248,563 / `pad-reclaim` 701 /
`num_radix-reclaim` 2,589). Post-processing (`scripts/analyze-alloc.mjs`)
replays them in program order, tracking a simulated heap top, asserting
each event's `before` equals the running top — any mismatch is either a
KNOWN region_exit drop (checked against the EVENT-SEQUENCE-VERDICT
session's own 5 `(before,after)` pairs, addresses matched EXACTLY — same
build, same repro, fully deterministic) or an UNEXPLAINED gap:

- **5 gaps matched the known region_exit drops exactly** (same addresses as
  `ed70f36a`'s own trace, byte-for-byte).
- **33 unexplained gaps, ALL in one early cluster** (sequence ≈269,228–
  271,443, heap ≈21.84 MB — far from the crash, which happens at sequence
  2,365,602, heap ≈32.8 MB — a different, unrelated phase of the compile,
  matching the citation's own "one earlier phase" framing). **Every one is
  POSITIVE and a multiple of 8** (31× `+8`, one `+16`, one `+72` = 9×8) —
  never negative, never overlapping. This is the exact signature of an
  UNTRACED allocation (most likely `$__alloc` inlined at a hot call site
  watr's optimizer chose not to leave as a named-function call at every
  site — `$__alloc` is called from dozens of places; a handful being
  inlined while the rest still route through the named function is
  unsurprising) — NOT a corruption: each gap's own `after` reading
  continues perfectly consistently from the corrected point, and zero
  gaps are negative/overlapping anywhere in 2,365,636 total heap-moving
  events (traced + inferred-untraced). This closes the "33 positive
  +8/+16 gaps" open item as BENIGN (an instrumentation-coverage blind
  spot), not a wall-relevant mechanism.
- **Zero other gaps of any kind**, anywhere in the run, including the
  ~2.1M-event stretch immediately surrounding the actual crash.

**Verdict: the allocator/heap-bookkeeping axis is DEFINITIVELY CLEARED —
empirically, exhaustively, for the ACTUAL crashing run, not just the
region-staging rebuild arms the arithmetic audit covered.** Every single
`$__alloc` call (which every `genUpsert`/`genUpsertGrow` grow routes
through via `__alloc_hdr_n`) and every manual bypass write returns/sets a
value perfectly consistent with a monotonic bump allocator plus exactly 5
legitimate compactions. No two allocations anywhere in this run's own
address space overlap. This is strictly stronger than the ALLOCATION-
COLLISION ARITHMETIC AUDIT session's own math proof (which covered only
`__region_copy_rec`'s same-cap rebuild arm) and independently confirms it
from an orthogonal, empirical angle.

**Redirect, with a mathematical narrowing.** Given the allocator is clean,
the corruption (a STRING's own bit pattern landing in `known`'s header,
per the RUNTIME-TRACE session's own decode) cannot be a "$__alloc handed
out the same address twice" bug — it must be a genuine OOB WRITE: some
instruction computing a target address that escapes its OWN object's
allocated bounds into a correctly-separate, live NEIGHBOR's memory —
exactly this task's own original hypothesis category. Re-reading
`probeStart`/`probeNext` (collection.js:320-327) against this: for a table
whose `cap` is a genuine power of 2 (guaranteed at `INIT_CAP=8` and by
`genUpsert`'s own `newcap = cap << 1` doubling), `idx = h & (cap-1)` is
mathematically confined to `[0, cap)` for EVERY probe step — the lane store
address `lb + idx*4` and entry address `off + idx*entrySize` are PROVABLY
in-bounds for any ORDINARY (non-grow) insert, no wrap/off-by-one possible.
So IF `known` truly never grew past its initial `cap=8` (the task's own
"clean cap=8 known-Map build cycle" framing — plausible: the repro's own
dict has very few keys), its OWN ordinary inserts cannot self-corrupt.
That leaves two remaining candidate mechanisms, both narrower than before
this session: (a) `genUpsert`'s GROW-time old-header forward-mark write
(`(i32.store (i32.sub $off 8) $newptr)` / `(i32.store (i32.sub $off 4) -1)`,
collection.js:426-427) firing for a DIFFERENT table whose own `$off` is
somehow wrong — pointing at `known`'s header instead of that table's own
old block (a state/aliasing bug, not an arithmetic-invariant bug — the
ALLOCATION-COLLISION ARITHMETIC AUDIT session already proved the size/delta
arithmetic sound for the arms it covered); or (b) a mechanism not yet
enumerated in `genUpsert`/`genUpsertGrow`/`genDelete`'s own bodies (the
zombie-reuse/`__zomb_scan` fallback path was considered and ruled out for
`known` specifically — `known` lives well above `__heap_reset`, so
`durableEntryLogIR`'s guard never fires for it, meaning it can never
accumulate durable-heal zombies at all).

**Fix-or-bank: BANKED.** No source change — this session's contribution is
negative-but-decisive (closes the allocator axis for good, resolves the
33-gap open item) plus a positive narrowing (rules out ordinary cap-bounded
inserts as self-corrupting, points the remaining two candidates at
`genUpsert`'s own grow-time forward-mark write and its own call-site
identity).

**By-name verdict: N/A** — no shared-tree source change; `module/core.js`,
`module/collection.js`, `module/string.js`, `module/number.js` read-only
this session (all instrumentation lived in the disposable scratchpad
worktree's own copy of the compiled WAT).

**Gates: NOT RUN** — no fix to gate; kernel-oracle/kernel-parity/fuzz/full
battery/dormant byte-identity/build×2/memory-watermark-curve/jz×jz all
remain contingent on a landed fix, unchanged from every prior session in
this chain.

**Memory curve / jz×jz: NOT REACHED.**

**Per the stop-on-fail tripwire.** Worktree-only: `git status` in the
shared tree before and after this session shows only this ledger edit (main
HEAD unchanged at `ed70f36a` throughout). Every artifact this session
produced — `scripts/build-region-wat.mjs`, `scripts/trace-alloc.mjs`,
`scripts/run-alloc.mjs`, `scripts/analyze-alloc.mjs`, `scripts/gapstats.mjs`,
the 275.5 MB kernel WAT and its traced twin, `events.json` — lived only in
the scratchpad worktree (`/private/tmp/.../scratchpad/region-genupsert-
trace`), removed via `git worktree remove --force` at session end, never
committed. SHAs: worktree base `0d089b49` (region-final-2026-08-11,
unchanged); main HEAD `ed70f36a` before and after (this entry is the only
change). No jz branch created.

**Recommendation for next session.** Don't re-open the allocator-bookkeeping
axis — closed, exhaustively, for the actual crashing run. Go straight to
instrumenting `$__map_set` (genUpsert instantiated for Map — the exact
function `known.set(...)` calls) itself: trace EVERY grow event's
`(old $off, old cap, $newptr)` triple across the whole run (a MUCH lighter
per-call summary than per-instruction tracing — reuse this session's
`memory()`/by-hand-instantiation harness verbatim, only the instrumentation
target changes), plus re-run the RUNTIME-TRACE session's own genDelete-hoist
technique in the SAME run to capture the exact corrupted header address
(should reproduce byte-identical to that session's own `0x1f4c448` /
32,818,248, since nothing about this session's changes touches allocation
order — confirm, don't assume). Then the single decisive cross-reference:
does that exact address EVER appear as an "old $off" being forward-marked
by SOME OTHER table's grow? A hit NAMES the exact buggy call site outright;
a miss rules out grow-forwarding entirely and narrows to "(b)" above — a
genuinely new mechanism not yet enumerated anywhere in this chain.

## §Region arena — GROW-EVENT × CORRUPTED-HEADER CROSS-REFERENCE: MISS,
candidate (a) DEFINITIVELY RULED OUT (2026-08-11), disposable scratchpad
worktree off `0d089b49` (region-final-2026-08-11) — verdict: across every
grow event in the ENTIRE run, from ALL FOUR forward-marking genUpsert/
genUpsertGrow consumers (`$__map_set`, `$__set_add`, `$__hash_set`,
`$__hash_set_local`), not one write-address or freshly-allocated `$newptr`
ever touches `known`'s own corrupted header address (`32,818,248` /
`0x1f4c448`) or its header-write target (`32,818,240` / `0x1f4c440`) — ZERO
hits, not a near-miss. The dormant forwarding-delta hazard the arithmetic
audit flagged (collection.js:426-427/680-681, raw un-adjusted `$newptr`
write) is CONFIRMED dormant for this repro too, empirically, not just
proven-unreachable-in-one-arm as the audit's own math covered. Wall
UNCHANGED, redirected to candidate (b): an unenumerated OOB-write mechanism,
narrowed further by this session's own value-shape read (below). Banked per
the stop-on-fail tripwire.

**Setup.** Scratchpad worktree off `0d089b49`, node_modules symlinked, watr
5.7.14 confirmed. Built the region-live kernel as a NAMED WAT-text dump
(`build-region-wat.mjs`, `resolveSelfhostBuild()` + `names:true` — the
RUNTIME-TRACE session's own recipe, chosen over the EVENT-SEQUENCE/ALLOCATOR
sessions' unnamed dump specifically so every target function is locatable by
literal name, not by post-hoc stack symbolication) — 275.5 MB text, 188s
build, `regionArenaLive:true`, `optimize:{level:3, watrGuard:false,
snapshotInit:true, inlinePtrOffsetFast:false}` (the standing gate, unchanged,
byte-shape-consistent with every prior session's own build of the same
commit).

**Source read, before instrumenting.** Confirmed by direct read of
`module/collection.js` which of the task's named "$__map_set/$__set_add
family" consumers actually carry the dormant forward-mark write at all.
`genUpsert` (SET/MAP: `$__map_set`, `$__set_add`) always forwards — no
`forward` param, hardcoded. `genUpsertGrow` (HASH family) takes an explicit
`forward` flag: `$__hash_set` (collection.js:3214,
`genUpsertGrow(..., false, ctx.linkDemand.external, true)`) and
`$__hash_set_local` (collection.js:2298, `genUpsertGrow(..., true, false,
true)`) both pass `forward=true` — candidates. `$__ihash_set_local`
(collection.js:2317, `genUpsertGrow('__ihash_set_local', ..., true)` — only
6 args, `forward` defaults **false**) REMINTS on grow (fresh `$__mkptr`
pointer, collection.js:686-688) — no old-header write exists in that path at
all, so it was EXCLUDED from the instrument rather than force-fit into the
"exactly one match" structural assert (would have thrown a false shape-drift
error). This also corrects an imprecision in the prior ALLOCATION-COLLISION
ARITHMETIC AUDIT session's own table: it cited "`$__ihash_set_local`
reinsert" as reaching "the same raw-`$newptr` write (collection.js:680)" for
the `$__dyn_props` migration arm — re-reading `core.js:802-828` (unchanged
since that audit) shows the OLD header's forward-mark for that arm is
written MANUALLY by `__region_exit` itself, one statement AFTER the
`$__ihash_set_local` reinsert loop, and — unlike collection.js:680 — it IS
delta-adjusted (`i32.sub $dpNewOff $delta`, core.js:826). The `$__dyn_props`
arm was never actually exposed to the raw-write hazard the audit flagged;
the citation pointed at the wrong write. Not consequential to this session's
own verdict (that arm plays no role in the `known`-Map trace either way,
per every prior session), but corrected here for the ledger's own record.

**Instrumentation, one build, two instruments** (`trace-growcrossref.mjs`,
scratch, reuses `trace-inject.mjs`'s own `findFunc`/`parseFunc`/
`firstBodyIdx`/`printFunc` splicing mechanics plus a new generic
`findSoleChild` AST search — not a hand-derived index path, since O3's own
CSE renames `$off` into anonymous `$cseNN` locals inconsistently per call
site, confirmed live: `$__map_set`'s own `$off` local vanishes entirely,
riding a reused `$cse30`/`$cse31` pair instead, while `$__map_delete`
happened to keep its literal source names this build). For each of the 4
forward-marking functions, `findSoleChild` searches the WHOLE function body
for the one-and-only `i32.store` node whose VALUE operand is `(local.get
$newptr)` — asserted unique (throws otherwise), robust to whatever the
address expression's own post-O3 shape is, since only the value operand is
pattern-matched. Hoists that address into a fresh `$dbgWaddr` local, traces
`(seq<<32|tag, waddr<<32|newptr)`, re-issues the original store unchanged.
Tags: 101 `$__map_set`, 102 `$__set_add`, 103 `$__hash_set`, 104
`$__hash_set_local`. For `$__map_delete`, reapplied the RUNTIME-TRACE
session's own genDelete-hoist technique to THIS build's own compiled shape
(structurally identical to that session's description — plain `$off`/`$cap`/
`$h`/`$ls`/`$lb`/`$end` locals, not CSE'd here): hoisted the `$ls` address
computation (which contains the `$h` hash computation as its own nested
tee) out of the `(local.tee $hw (i32.load (local.tee $ls ...)))` expression
into a standalone `local.set` BEFORE the load, so the trace fires
unconditionally even on the call whose subsequent load then traps. Tags 200
(`off`/`cap` packed), 201 (`h`/`ls` packed), 202 (`$__heap` watermark) fire
on every call. A single new module-level `$__dbgSeq` (mut i32) global plus
the `(import "dbg" "trace" (func $dbgtrace (param i64 i64)))` complete the
instrument — same convention as every prior session in this chain.

Reassembled via `watr/parse`+`watr/compile` directly (2.3 s parse, 61.1 s
compile), instantiated BY HAND (bypassing `interop.js`'s `instantiate()` —
same raw-i64-channel caution as every prior session), minimal `env` (a
throwing Proxy — none of the kernel's real imports fire for this repro,
confirmed), a real `dbg.trace` collector, `interop.js`'s own exported
`memory()`/`f64ToI64` for ABI-correct `String()`/arg marshaling, calling
`exports.default(source, strict=0, optJSON={level:3}, modules=0, host=0)` —
the exact ABI `test/kernel-target.js`'s `compileViaKernel` uses. Ran the
kernel-oracle's own `computed member key` repro.

**Result — reproduced deterministically, byte-identical to the RUNTIME-TRACE
session's own decode.** `RuntimeError: memory access out of bounds`, same
message. 123,335 total events: grow events 3,719 (`$__map_set`) + 1,115
(`$__set_add`) + 3 (`$__hash_set`) + 3,934 (`$__hash_set_local`) = **8,771
total grow events**; `$__map_delete` traced **38,188 calls** (matching the
RUNTIME-TRACE session's own count exactly). Exactly ONE anomalous
`$__map_delete` call — the LAST one (seq 123,333, the call whose subsequent
load then traps) — decoding to `off=32,818,248` (`0x1f4c448`),
`cap=2,147,090,432` (`0x7ffa0000`), `h=2,355,087,866` (`0x8c5fc9fa`),
`ls=852,225,072` (`0x32cbec30`), `heap=32,825,888` — **every single field
byte-identical to the RUNTIME-TRACE session's own independently-captured
decode**, confirming (not assuming) that nothing about the intervening
sessions' own read-only audits/instrumentation perturbed allocation order,
exactly as that session's own recommendation asked to verify.

**The cross-reference.** Corrupted header lives at `[off-8, off)` =
`[32,818,240, 32,818,248)` per `genDelete`'s own `[len,cap]` read
convention (matching the RUNTIME-TRACE session's own byte-level framing —
"a full 8-byte... STRING box was written starting at `off-8`"). Searched
all 8,771 grow events' own `waddr` (`old_off - 8`, the forward-mark's write
target) AND `newptr` (the freshly `__alloc_hdr_n`'d replacement table) for
either `32,818,248` or `32,818,240`, in both directions (as a write address
and as an allocated address):

```
target: off=32818248 (0x1f4c448), corrupted write-addr (off-8)=32818240 (0x1f4c440)
  exact waddr matches: 0
  waddr == off (not off-8) matches: 0
any grow event touching 32818248 or 32818240 (as waddr OR newptr): 0
```

**MISS — unambiguous, zero hits across all 8,771 grow events, all 4
forward-marking consumers, both directions of comparison.** No genUpsert/
genUpsertGrow grow event, anywhere in this run, ever writes to or allocates
`known`'s own header address. Candidate (a) — "some OTHER table's grow-time
forward-mark write fires with a wrong/stale `$off` and clobbers `known`'s
header" — is RULED OUT for this repro, not merely "not yet found." This is
consistent with, not contradictory to, the ALLOCATION-COLLISION ARITHMETIC
AUDIT session's own proof (that session covered only the two region-staging
same-cap rebuild arms and explicitly left the general-purpose runtime-call
reachability open as "moot until region-arena re-enabled" — this session
answers that open question empirically, for the actual crashing repro, and
the answer is negative) — there is no reachability-proof gap to name,
because the audit never claimed the general runtime path was unreachable,
only that the two staging arms it covered couldn't trigger a grow in the
first place. No task-brief "HIT" branch applies.

**Narrowing candidate (b), from the byte shape.** A structural read of
`genUpsert`'s own forward-mark write (collection.js:425-429, confirmed
still verbatim at the base commit) shows it can NEVER have produced the
observed corruption even in principle, independent of address: it performs
TWO separate `i32.store`s — `(off-8) = $newptr` (a small, in-range heap
address, typically < `2^25` this run) and `(off-4) = -1` (`0xFFFFFFFF`). Read
back as one `i64`, the HIGH word (at `off-4`) would be `0xFFFFFFFF`, whose
NaN-box tag nibble `(0xFFFFFFFF >> 15) & 15 == 15` — not `4` (`PTR.STRING`).
The RUNTIME-TRACE session's own decode requires the high word at `off-4` to
be `0x7ffa0000` (tag nibble `4`, a genuine STRING pointer's high half) —
categorically not what a genUpsert-family forward-mark ever writes, by
construction, for ANY table's `$off`, not just `known`'s. This is a second,
independent line of evidence (value-shape, not just address) confirming the
same MISS the address cross-reference already established, and it rules out
the ENTIRE genUpsert/genUpsertGrow forward-mark write FAMILY as a candidate
mechanism outright, not just this run's own instances of it. The actual
write that clobbered `known`'s header must be a plain `i64.store` of a real
NaN-boxed STRING VALUE — most likely an ordinary key or value store (e.g.
`genUpsert`'s own `(i64.store (i32.add $slot 8) $key)` / `(... 16) $val)`
shape, or any other collection/property write in the same family) executing
with a `$slot`/target address that has escaped ITS OWN object's bounds into
`known`'s neighboring header — i.e. candidate (b) narrows specifically
toward an address-computation bug in an ordinary (non-grow) INSERT path, not
a grow/forwarding path at all.

**Fix-or-bank: BANKED — no fix, per MISS.** Nothing to patch: this session's
own contribution is negative-but-decisive (rules out the entire
forward-mark-write family, both by address and by value shape) plus a
positive narrowing (points future instrumentation at ordinary key/val STORE
address computation in the insert path, not the grow path) and a ledger
correction (the `$__dyn_props` arm's actual write site).

**By-name verdict: N/A** — no shared-tree source change; `module/
collection.js`, `module/core.js` read-only this session (all
instrumentation lived in the disposable scratchpad worktree's own copy of
the compiled WAT).

**Gates: NOT RUN** — no fix to gate; kernel-oracle/kernel-parity/fuzz/full
battery/dormant byte-identity/build×2/memory-watermark-curve/jz×jz all
remain contingent on a landed fix, unchanged from every prior session in
this chain.

**Memory curve / jz×jz: NOT REACHED.**

**Per the stop-on-fail tripwire.** Worktree-only: `git status` in the shared
tree before and after this session shows only this ledger edit (main HEAD
moved `732eff4b` → `6b90a694` via unrelated concurrent work, confirmed
before/after). Every artifact this session produced —
`build-region-wat.mjs`, `inspect-funcs.mjs`, `probe-mapdelete.mjs`,
`trace-growcrossref.mjs`, `run-growcrossref.mjs`, `analyze-growcrossref.mjs`,
the 275.5 MB named/traced WAT pair, `events.json` (123,335 rows),
`analysis.log` — lived only in the scratchpad worktree
(`/private/tmp/.../scratchpad/region-grow-crossref`), never committed. SHAs:
worktree base `0d089b49` (region-final-2026-08-11, unchanged); watr
`node_modules` symlinked, 5.7.14 confirmed. No jz branch created — pure
instrumentation and trace, no diff to bank.

**Recommendation for next session.** Don't re-open the grow-forwarding axis
— closed, by address AND by value shape, exhaustively for this repro's own
8,771 grow events. Instrument the ORDINARY insert-path stores instead: every
`i64.store` of a `$key`/`$val`-shaped operand in `genUpsert`'s non-grow probe
loop (collection.js's `$done`/`$probe` block, the `(i64.store (i32.add $slot
8) $key)` / `(...16) $val)` pair) across watr's own self-hosted pass
execution, scoped to the address window `[30,914,912, 32,825,888]` (the
post-4th-region_exit growth window the RUNTIME-TRACE session already
bounded) — looking for the SPECIFIC store whose own `$slot` computation
(from some OTHER table's `$off`/`$h`/probe-index arithmetic) lands on
`32,818,240`. That store's own table identity, at the moment it fires, names
the actual buggy call site — the same one-more-level-of-trace every prior
session's own recommendation has been converging toward, now with the
grow-path entirely eliminated as noise.

## §Region arena — INSERT-PATH STORE-ADDRESS TRACE: every i64.store in the
ENTIRE kernel eliminated, candidate (b) itself now MISS — wall redirected to
`__region_exit`'s own bulk `memory.copy` (2026-08-11), disposable scratchpad
worktree off `0d089b49` (region-final-2026-08-11) — verdict: the GROW-CROSSREF
session's own candidate (b) ("an ordinary insert-path INSERT store... address-
computation bug") is ITSELF now ruled out, exhaustively, not just narrowed.
Watched every `i64.store` instruction that exists ANYWHERE in the compiled
kernel — not a hand-picked family, a literal enumeration off the built
binary's own text — for a write into `known`'s header range
`[32,818,216, 32,818,272)`. One hit, and it is `known`'s own legitimate
allocation, not a foreign write. Banked per the stop-on-fail tripwire.

**Setup.** Fresh `git worktree add` off `0d089b49` (not reused from a prior
session's now-removed scratchpad), `node_modules` symlinked, watr 5.7.14
confirmed (`require('watr/package.json').version`). Built the region-live
kernel via `build-region-wat.mjs` (`resolveSelfhostBuild()` defaults +
`names:true, wat:true` — the same recipe every session in this chain uses):
152 modules, `regionArenaLive:true`, 288,912,776 chars (275.5 MB), 187.0 s
build — byte-length matches the GROW-CROSSREF/RUNTIME-TRACE sessions' own
builds of the same commit (275.5 MB) exactly.

**Instrument, one build, two mechanisms** (`trace-insert-watch.mjs`, scratch,
reuses `trace-inject.mjs`'s own `findFunc`/`parseFunc`/`firstBodyIdx`/
`printFunc` splicing mechanics):

**(A) Family bounds-assert.** Every `i64.store` inside `$__map_set`,
`$__set_add`, `$__hash_set`, `$__hash_set_local`, `$__ihash_set_local` (48
sites: 11+7+10+10+10) gets its address hoisted into a local and asserted
`>= $off` and `< $off + $cap*(entrySize+LANE)` — the task's own stated
hypothesis test (a store landing below its own table's payload start = the
header-relative/payload-relative base-mismatch bug). O3's own CSE erases
`$off`/`$cap` in `$__map_set`/`$__hash_set` this build (reconfirming the
GROW-CROSSREF session's own finding, live in a fresh build) — those two fall
back to the same fixed-range watch (B) uses rather than skip the two
functions outright.

**(B) Global i64.store address watch — the definitive, family-independent
mechanism the task's own step 3/4 asks for.** Rather than guessing which
OTHER function might store a value near `known`'s header, enumerated every
`i64.store` that exists anywhere in the 6,035-function compiled kernel by
text: scan every `(func $NAME` declaration line and every line containing
`i64.store`, binary-search each store line to its enclosing function. 179
distinct functions contain at least one raw `i64.store` (out of 6,035 total
functions) — confirming by direct measurement, not assumption, that raw
memory stores in a self-hosted build concentrate in a tractable, enumerable
set of stdlib-generator functions (collection/array/object/string/core.js
templates) plus a modest set of jz-compiled "closure" functions, not spread
across the whole call graph (jz user code never emits `i64.store` directly —
only stdlib calls). Every one of the 179 gets its own store's address
unconditionally traced when it lands in `[32,818,216, 32,818,272)` (known's
`[off-16,off)` propsPtr+len+cap header plus one entry-stride slop either
side). Two real bugs found and fixed while building this instrument (both
are reusable cautions for the next session, not repro-specific):

1. **Dropped `offset=N` immediates.** `i64.store` nodes in this kernel
   sometimes carry a leading `offset=N` immediate (45 occurrences measured:
   `(i64.store offset=8 ADDR VAL)`). A naive hoist-ADDR-into-a-local +
   reissue-the-store silently drops that immediate, corrupting the
   EFFECTIVE address by N bytes on every such site. First symptom: an
   UNCONDITIONAL (source-independent — reproduced even on `() => 1`), not
   repro-specific, "Unknown optimize level 'undefined'" thrown from
   `$m116_index$resolveOptimize`/`$__jp` — i.e. the corruption doesn't even
   need the region-arena bug to manifest, it breaks the FIRST JSON.parse of
   the compile's own `optJSON` argument. Fixed by folding the offset into
   the hoisted local's own value (`effectiveAddr = base + offsetImm`) and
   reissuing the store with no offset immediate at all — the local already
   holds the true address, which is also exactly what the bounds/watch
   comparisons want.
2. **Harness memory-helper mismatch.** `interop.js`'s `memory()` needs the
   FULL `{instance, exports, module}` shape to sync its JS-side allocator
   (used by `mem.String()` to build the ABI arguments) with the module's own
   real `$__heap` global; passing bare `instance.exports.memory` makes it
   fall back to a naive, unsynced JS bump allocator that can hand out
   addresses colliding with the module's own static data. This masked the
   real trap under an unrelated `WebAssembly.Exception` (a corrupted-string
   decode failure) until fixed — same class of caution every prior session's
   own "bypass `instantiate()`, use `memory()`/`f64ToI64` directly" note
   already flagged, but for the ARGUMENT-BUILDING side, not just the
   import-decoding side.

**ABI, confirmed directly off the compiled WAT** (not assumed from the JS
test helper): `$compileSelf$exp` — `(param $source i64)(param $strict
i64)(param $optJSON i64)(param $modulesJSON i64)(param $host i64)(result
i64)` — every parameter and the result ride raw i64 bits (jz's own
V8-NaN-canonicalization-avoiding boundary carrier, `interop.js`'s
`buildImports` own comment). `mem.String()` already returns bits as a
BigInt — passed straight through, no f64 round-trip; `0n` is the ABI's own
"absent" sentinel. Reassembled via `watr/parse` (2.0-2.9 s) + `watr/compile`
(60-63 s), instantiated BY HAND (bypassing `interop.js`'s `instantiate()` —
same raw-i64-channel caution as every prior session), minimal `env` (a
throwing Proxy), a real `dbg.trace` collector, ran the kernel-oracle's own
`computed member key` repro at O3 (`optJSON = mem.String(JSON.stringify({level:
3}))`, matching the GROW-CROSSREF/RUNTIME-TRACE sessions' own repro exactly).

**Result — reproduced deterministically, byte-identical across 2/2 runs.**
`RuntimeError: memory access out of bounds`, `__jz_last_err_bits` = `0n`
(decodes to `0` — a genuine UNMARKED foreign trap, matching every prior
session's own signature, not an internal `throw`). 95,844 total `dbg.trace`
events, byte-identical between both runs (same tag histogram, same final
event).

**(A) family — no addr-below-own-table violation anywhere; only known
grow-loop noise above.** Tags for "addr < off" (the task's own stated
hypothesis) never fired for ANY of the 5 functions — zero hits. The
CSE-fallback fixed-range watch tags for `$__map_set`/`$__hash_set` (which
lost `$off`/`$cap` to O3) never fired either. The only family hits are the
upper-bound check (`addr >= off + cap*stride`) on `$__set_add` (21,071
events) and `$__hash_set_local` (74,772 events) — confirmed, by direct
inspection of the decoded `(addr, bound)` pairs, to be a blind spot of the
instrument itself, not a real violation: these functions' own GROW loops
rehash into a fresh `$newptr` table BEFORE `$off`/`$cap` get reassigned to
`$newptr`/`$newcap`, so every rehash-loop store legitimately compares
against the STALE pre-grow bound (`addr - bound` deltas measured at 16-424
bytes, scattered arbitrarily across the run — the rehash loop's own natural
fill pattern, not a fixed offset). Directly filtered all 95,843 of these
events against the actual watched corrupted range
`[32,818,216, 32,818,272)`: **zero** land there.

**(B) global watch — exactly one hit, and it is `known`'s own birth, not a
foreign write.** `$__alloc_hdr_n_0_8_28`, address `32,818,232` — this is
`known`'s own `[off-16]` props-pointer slot (`off = 32,818,248`, matching
every prior session's own byte-identical decode), the LAST of the 95,844
events, immediately preceding the trap. The specialized function's own name
encodes its call-time constants — `len=0, cap=8, stride=28` — and `cap=8`
/ `stride=28` (`MAP_ENTRY(24)+LANE(4)`) are collection.js's own `INIT_CAP`
and Map-entry-plus-lane stride EXACTLY: this is `$__alloc_hdr_n` zeroing the
freshly-allocated header's own props-pointer field at the moment `known`
itself (`forwardPropagate`'s `new Map()`, per the RUNTIME-TRACE session's own
naming) is CREATED — not a write landing inside an already-live object's
header from outside. No OTHER of the 179 watched functions' `i64.store`
sites — spanning literally every raw memory-store instruction that exists in
the compiled binary — ever touches this address range, at any point in the
95,844-event run.

**The verdict.** The task's own hypothesis (a header-relative/payload-
relative base-convention mismatch at ANY compiled `i64.store` site — not
just the named genUpsert/genUpsertGrow family, the WHOLE kernel) is now
RULED OUT exhaustively, not narrowed: every `i64.store` instruction that
exists in the built binary was watched against the exact corrupted range,
and none writes there except the victim's own creation. This closes the
ENTIRE `i64.store` candidate class the GROW-CROSSREF session's own
recommendation opened ("candidate (b)... points future instrumentation at
ordinary key/val STORE address computation") — that candidate is itself now
a MISS. Combined with the RUNTIME-TRACE session's own byte-level finding (a
full 8-byte STRING box materializes at `known`'s header, and `known`'s
address sits squarely inside the territory the LAST `region_exit`
compaction reclaimed-then-regrew) and its own architectural diagnosis
(`known` is a `forwardPropagate`-local `Map`, structurally invisible to
region-arena's 4-item root bundle), the only mechanism left standing by
elimination is `__region_exit`'s own closing bulk `(memory.copy (local.get
$mark) (local.get $T) (local.get $size))` (`module/core.js:831`) — a raw
byte-range memmove with NO per-object dispatch at all, compacting the
entire post-mark heap down by `delta` bytes. A bulk copy explains the exact
byte signature (a STRING box's bytes landing intact at `known`'s header)
without requiring ANY typed value-store to ever target that address
directly — the address is collateral: `known`'s backing table lives in
territory the region arena, unaware of it, is free to overwrite via a plain
byte-range copy that never resolves individual object identities. This
turns the RUNTIME-TRACE session's own "candidate mechanism" into "the only
remaining mechanism, by elimination" — not yet directly traced, but no
longer one candidate among several.

**Fix-or-bank: BANKED — no fix.** Matches every prior session's own
"architectural, not session-scoped" precedent for this exact hazard
(`known` escaping the region root); this session's own contribution is
negative-but-decisive (eliminates the entire `i64.store` instruction class,
not just one family) plus a positive narrowing (the bulk `memory.copy` at
`module/core.js:831` is now the sole remaining candidate mechanism, named by
elimination) and two reusable instrumentation cautions (`offset=N` immediate
preservation; `memory()`'s full-instance-shape requirement for ABI argument
construction, not just import decoding).

**By-name verdict: N/A** — no shared-tree source change; `module/
collection.js`, `module/core.js` read-only this session (all
instrumentation lived in the disposable scratchpad worktree's own copy of
the compiled WAT).

**Gates: NOT RUN** — no fix to gate; kernel-oracle/kernel-parity/fuzz/full
battery/dormant byte-identity/build×2/memory-watermark-curve/jz×jz all
remain contingent on a landed fix, unchanged from every prior session in
this chain.

**Memory curve / jz×jz: NOT REACHED.**

**Per the stop-on-fail tripwire.** Worktree-only: `git status` in the shared
tree before and after this session shows only this ledger edit. Every
artifact this session produced — `build-region-wat.mjs`,
`trace-insert-watch.mjs`, `trace-insert-watch-Aonly.mjs` (bisection scratch),
`run-insert-watch.mjs`, the 275.5 MB named WAT, the 276.1 MB instrumented
WAT, `kernel-region-instr.wat.events.json` (95,844 rows),
`kernel-region-instr.wat.watchmap.json` — lived only in the scratchpad
worktree (`/private/tmp/.../scratchpad/region-insert-trace-wt`), never
committed. SHAs: worktree base `0d089b49` (region-final-2026-08-11,
unchanged); watr `node_modules` symlinked, 5.7.14 confirmed. No jz branch
created — pure instrumentation and trace, no diff to bank.

**Recommendation for next session.** Don't re-open the `i64.store` axis on
this repro — closed, exhaustively, kernel-wide (not just the collection
family), by direct address watch on every store instruction the compiled
binary contains. Instrument `__region_exit`'s own closing `memory.copy`
call (`module/core.js:831`) directly: trace `$mark`/`$T`/`$size`/`$delta` on
every `__region_exit` invocation, and check whether `[32,818,216,
32,818,272)` falls inside `[mark, T)` for any of them — particularly the
LAST region-round compaction, which the RUNTIME-TRACE session already
bounded to the watermark window `[30,914,912, 32,825,888]`. This is the
first DIRECT test of the bulk-copy mechanism (every prior session, including
this one, has only ever inferred it from surrounding evidence). If
confirmed, the fix is the one every session in this chain has already
named: extend region-arena's root bundle (or its per-pass scratch-drain
allowlist, `optimize.js:8466`'s existing partial drain) to cover watr's own
pass-internal locals like `forwardPropagate`'s `known` — a genuine
architectural change (touches every entry in watr's `PASSES` table or the
`regionMark`/`regionExit` insertion scope), not a one-line patch, matching
every prior session's own "session-plus scope" conclusion for this hazard.

## §Region arena — FRAME-FLIP COMPARISON: the pointer is PROVEN CORRECT
(bit-for-bit, creation to use), the closing bulk `memory.copy` is PROVEN
INNOCENT (all 5 rounds this run, by direct trace — the INSERT-PATH session's
own recommended next lever), `__region_copy_rec`'s own forwarding-header AND
element-relocation writes (i32/i64/f64.store, all 16 sites, every
invocation) are PROVEN INNOCENT too — wall SURVIVES with every named
candidate mechanism in this entire chain now eliminated by direct runtime
trace, not inference (2026-08-11), disposable scratchpad worktree off
`0d089b49` (region-final-2026-08-11) — verdict: this session's own opening
hypothesis ("the corrupted value is the POINTER, not the memory") is
FALSIFIED by its own prescribed test. Banked per the stop-on-fail tripwire.

**Setup.** Fresh `git worktree add` off `0d089b49`, `node_modules` symlinked,
watr 5.7.14 confirmed. Built the region-live kernel via the same
`resolveSelfhostBuild()` defaults + `{names:true, wat:true}` recipe every
session in this chain uses: 152 modules, `regionArenaLive:true`, 288,912,776
chars (275.5 MB) — byte-identical to every prior session's own build of this
commit.

**Instrument, one build, five points** (`instrument.mjs`, scratch, reuses
`trace-inject.mjs`'s own `findFunc`/`parseFunc`/`firstBodyIdx`/`printFunc`
splicing mechanics plus a new generic recursive store-node walker):
(a) `$__alloc_hdr_n_0_8_28`'s own return (raw i32 ptr) — `known`'s creation;
cap=8/stride=28 (`INIT_CAP`+`MAP_ENTRY(24)+LANE(4)`) is a Map-only
specialization, confirmed by cross-checking the sibling Set specialization
`$__alloc_hdr_n_0_8_20` (stride 20 = `SET_ENTRY(16)+LANE(4)`) exists
separately. (b) `$__map_set`/`$__map_delete` ENTRY — the `$coll` i64 param
bits AS PASSED at every use site, traced unconditionally before any internal
computation. (c) `$__region_copy_rec` — EVERY `i32.store`/`i64.store`/
`f64.store` instruction anywhere in its body (16 sites total, found by a
generic parent-array recursive walk, not a hand-picked family), address
unconditionally traced on every invocation — module/core.js's ARRAY and
SET/MAP relocation branches each leave a forwarding header at the relocated
object's OLD site via `i32.store` (off-8/off-4), and the ARRAY branch copies
element slots via `f64.store` — neither opcode was ever in scope for the
prior INSERT-PATH session's i64.store-only sweep. (d) `__region_exit`'s own
closing bulk `memory.copy(mark, T, size)` — confirmed fully INLINED under
this O3 build (no standalone `$__region_exit` function exists; 0 declared,
only 2 raw text hits and both are inside the embedded self-host SOURCE-DATA
blob, not real call sites — a fresh trap for naive text search this session
had to work around: `(func $__region_exit` legitimately absent is not the
same as "code doesn't exist"). Located its landing site by hand: of 23
`call $__region_copy_rec` occurrences outside `__region_copy_rec`'s own
body, all but 3 sit inside the embedded compiler-source data blob (char
offset < 4.4M, where the first real function declaration begins); the
remaining 3 resolve to `$__region_relocate_props` (2, a sibling helper) and
one auto-numbered closure — `$closure2907` — whose body is `__region_exit`
reproduced instruction-for-instruction (memo-Map creation via
`alloc_hdr_n(0,8,28)`+`mkptr(MAP)`, the `$__dyn_props` migration block, the
closing `memory.copy`+`global.set $__heap` pair — module/core.js:772-833's
own shape exactly, down to the `$__dyn_props` presence check). Traced
`mark`/`T`/`size` on its one `memory.copy` call, every invocation. (e)
`$__map_delete`'s own POST-forward-check `$off`/`$cap` — not just the entry
param, the ACTUAL value its own compiled cap-load produces, located by
matching the exact compiled tee-chain shape by hand off the built WAT
(`(local.tee $cap (i32.load (i32.sub (local.tee $off ...) 4)))`).

**A fresh instrumentation trap, found and fixed before running**: `$closure2907`
is jz's own auto-numbered name, but the func declaration in the built WAT
reads `$` + U+E000 (PUA marker, `src/ast.js`'s own generated-identifier
convention) + `closure2907` — a plain substring `findFunc('closure2907')`
silently finds nothing (0 results, no error) because the search never falls
back past the first candidate. `trace-inject.mjs`'s own doc comment already
flagged this exact hazard for LOCAL names; it applies to auto-numbered
CLOSURE names too. Fixed by trying the plain needle first, falling back to a
regex allowing an optional U+E000 right after `$`.

**Result — reproduced deterministically, 2/2 independent instrumented
rebuilds** (once at 4 points, once more after adding (e) and the f64.store
class to (c) — every earlier number reconfirmed unchanged): `RuntimeError:
memory access out of bounds`. Full harness: `watr/parse`+`watr/compile`
reassembly (2.1-2.5s parse, 60-61s compile), instantiated BY HAND (bypassing
`interop.js`'s `instantiate()`, same raw-i64-channel caution every prior
session in this chain uses), `interop.js`'s own `memory()` helper given the
full `{instance, exports, module}` shape (same full-instance-shape caution),
ran the kernel-oracle `computed member key` repro at O3.

**(a)+(b) — THE COMPARISON: creation box bits vs. the faulting call's box
bits are IDENTICAL, bit-for-bit.** `$__alloc_hdr_n_0_8_28` returns raw ptr
`32,818,248` (creation #32,794 of 32,794 total this run); the expected
`mkptr(PTR.MAP=9, aux=0, offset=32818248)` box is `0x7ffc800001f4c448`. The
FAULTING `$__map_delete` call (#38,188 of 38,188, the very last) enters with
`$coll = 0x7ffc800001f4c448` — the SAME bits, exactly, no divergence in any
field (tag, aux, or offset). Across the run's full 158,565 `__map_set` +
38,188 `__map_delete` calls, this exact box value (decoded offset
32,818,248) is used EXACTLY ONCE — by the fatal delete call itself, 94
trace-events after its own creation, with no `__map_set` call ever touching
it (the invalidation path deletes a key from a map that was seemingly never
populated, or was populated through a path this instrumentation's tags don't
cover — not pursued further, orthogonal to the frame-flip question).
**This falsifies the task's own opening hypothesis outright**: the box was
never bent between creation and use — it is the identical value, unmutated,
the whole way through. Per the task's own decision tree ("IDENTICAL ⇒ the
box was always wrong — the creation-side mkptr computed bad bits"): also
false — the raw ptr IS what the allocator returned, and `mkptr`'s encoding
is a pure, unconditional formula (`NAN_BITS | (type<<47) | (aux<<32) | off`)
that this session verified by direct arithmetic reconstruction, not
assumption, and it matches exactly. Neither branch of the task's own
two-way fork applies — the ACTUAL finding is a third case the task's framing
didn't anticipate: the pointer is exactly right, correctly created,
correctly delivered unchanged to its one and only use site, and the fault is
still a **memory** problem — the byte content of a correctly-addressed
region genuinely differs from what was legitimately written there.

**(c) — `__region_copy_rec` PROVEN INNOCENT, all 16 store sites, every
opcode, every invocation.** 89,149 traced store-address events across 2
runs (204 events under the i32/i64-only pass, 89,149 once f64.store — the
ARRAY branch's element-relocation writes — was added). Zero land in known's
header window `[32,818,216, 32,818,272)`. Every address this function ever
wrote to, this entire run, clusters in the 22M-45M range — a completely
different address band from known's own 32.8M, for both the forwarding-
header pairs (ARRAY/SET/MAP branches) and the bulk element copies.

**(d) — the closing bulk `memory.copy` PROVEN INNOCENT, all 5 rounds, by
direct trace — the INSERT-PATH session's own recommended next lever, now
actually run** (not inferred from surrounding evidence, the state every
prior session in this chain left it in):

| round | mark | T | size | dest range | overlaps window? |
|---|---|---|---|---|---|
| 1 | 26,109,000 | 43,853,312 | 1,059,424 | [26,109,000, 27,168,424) | no |
| 2 | 27,168,424 | 38,239,128 | 955,424 | [27,168,424, 28,123,848) | no |
| 3 | 28,123,848 | 35,243,736 | 925,176 | [28,123,848, 29,049,024) | no |
| 4 | 29,049,024 | 34,992,616 | 920,328 | [29,049,024, 29,969,352) | no |
| 5 | 29,969,352 | 34,961,264 | 920,104 | [29,969,352, 30,889,456) | no |

All 5 compactions happen BEFORE the fault; none of their destination ranges
reach anywhere near known's header. Independently, `known`'s own creation
(seq 394,990) postdates round 5 (seq 387,820) entirely, and its address
(32,818,248) sits ABOVE round 5's post-compaction ceiling (30,889,456) — the
RUNTIME-TRACE session's own "climbing monotonically... zero further
compaction in between" finding, now confirmed by DIRECT mark/T/size
extraction rather than the `$__heap`-watermark proxy that session used. This
mechanism is not just empirically clean here — it is temporally impossible
for this specific fault: `known` didn't exist yet during any of the 5
rounds' own bulk copies.

**(e) — the garbage is real and reproduces exactly, independently.** The
faulting call's own post-forward-check `$off` = `32,818,248` (matches (b)'s
decode exactly — the address arithmetic inside `$__map_delete` is not
miscompiled; hand-reading the built WAT confirms the compiled shape matches
`module/collection.js`'s `genDelete` source verbatim, no CSE aliasing). Its
`$cap` = `0x7ffa0000` (2,147,090,432) — byte-identical to the RUNTIME-TRACE
session's own independently-built, independently-instrumented decode of the
same repro, reconfirming determinism across the whole chain. `0x7ffa0000` in
the HIGH 32 bits of an 8-byte slot is exactly the shape a boxed STRING VALUE
(`PTR.STRING=4`, aux=0) written via a single `f64.store`/`i64.store` at
address `off-8` (not `off-4` — the two 4-byte header words read together as
one 8-byte unit) would produce — that byte-level diagnosis, from the
RUNTIME-TRACE session, still stands; only its two candidate mechanisms (the
bulk copy, and by extension anything inside `__region_copy_rec`) are now
closed.

**The verdict.** Every NAMED candidate mechanism this entire research chain
has produced, across 2026-08-11's whole session sequence, is now eliminated
by direct runtime trace: every `i64.store` in the compiled kernel
(INSERT-PATH), the `genUpsert`/`genUpsertGrow` `i32.store` forwarding family
(GROW-CROSSREF), `__region_copy_rec`'s own `i32.store`/`i64.store`/
`f64.store` forwarding-header and element-relocation writes (this session),
and `__region_exit`'s own closing bulk `memory.copy` (this session, located
and traced directly for the first time in the chain). The pointer is proven
correct. What remains, unchecked by any session including this one: the
`f64.store`/`i64.store` VALUE-write instruction class *outside*
`__region_copy_rec` — an ORDINARY jz-compiled write (an array element store,
an object property store, another collection's own entry-value store)
whose target address happens, by bump-allocator coincidence, to land inside
known's live header. This is the one class of write this whole chain has
never enumerated kernel-wide (INSERT-PATH's own sweep was explicitly
i64.store-only "not a hand-picked family... but for i64.store"; this
session's f64.store sweep was scoped to one function). A full kernel-wide
`f64.store` address-watch, the same enumerate-every-occurrence-and-compare
technique already proven out twice in this chain (i64.store kernel-wide,
i32/i64/f64.store within `__region_copy_rec`), is the concrete, well-scoped,
not-yet-attempted next lever.

**Fix-or-bank: BANKED — no fix.** No source change; every function touched
this session (`module/core.js`, `module/collection.js`) was read-only — all
instrumentation lived in the disposable scratchpad worktree's own copy of
the compiled WAT.

**By-name verdict: N/A** — no shared-tree source change.

**Gates: NOT RUN** — no fix to gate; kernel-oracle/kernel-parity/fuzz/full
battery/dormant byte-identity/build×2/memory-watermark-curve/jz×jz all
remain contingent on a landed fix, unchanged from every prior session in
this chain.

**Memory curve / jz×jz: NOT REACHED.**

**Per the stop-on-fail tripwire.** Worktree-only: `git status` in the shared
tree before and after this session shows only this ledger edit. Every
artifact this session produced — `build-region-wat.mjs`, `instrument.mjs`,
`run-instr.mjs`, the 275.5 MB named WAT, the ~276 MB instrumented WAT (×2
builds), `trace-events.json` (395,087 rows) — lived only in the scratchpad
worktree, never committed. SHAs: worktree base `0d089b49`
(region-final-2026-08-11, unchanged); watr `node_modules` symlinked, 5.7.14
confirmed. No jz branch created — pure instrumentation and trace, no diff to
bank.

**Recommendation for next session.** Don't re-open the pointer-bending axis
— closed, decisively, by the task's own prescribed comparison (IDENTICAL,
not different). Don't re-open `__region_copy_rec` or the closing bulk
`memory.copy` — both now traced directly (not inferred) and both clean.
Extend the enumerate-and-watch technique to `f64.store`/`i64.store`
KERNEL-WIDE (mirroring INSERT-PATH's own i64.store sweep, but for the VALUE
write, not the header write — likely a much larger instrumentation surface
than 179 functions, since ordinary array/object writes are common kernel-
wide; may need sampling or a narrower pre-filter, e.g. restricting to
functions reachable from `forwardPropagate`'s own call graph, or to stores
whose value operand carries a STRING tag pattern, to keep the sweep
tractable) for the address range `[32,818,240, 32,818,248)` specifically
(the 8-byte `[len,cap]` word `(e)` shows is the actual corrupted unit, not
the full header window `(c)`/`(d)` used defensively). If that sweep also
comes back clean, the remaining candidates are: a genuine allocator
under-reservation bug (two calls computing overlapping ranges without any
compaction between them — `732eff4b`'s own "allocator bookkeeping proven
clean" finding may need revisiting for this SPECIFIC address pair rather
than the whole run in aggregate), or a WASM-level non-store memory
mutation this chain hasn't considered (e.g. a `table.copy`/`data.drop`
misuse, or the JS-host `memory()` shim's own bump allocator — ruled
structurally unlikely since this repro never crosses the host boundary
after `default()` is called, but not yet directly excluded).

## §Region arena — KERNEL-WIDE SOFTWARE WATCHPOINT (every store family, one
pass) + FOUR MORE NAMED CANDIDATES RULED OUT BY DIRECT TRACE: no foreign
write found (2026-08-12), disposable scratchpad worktree off `0d089b49`
(region-final-2026-08-11) — verdict: the FRAME-FLIP session's own recommended
next lever (f64.store kernel-wide, extended here to every store family
per the task's own brief) is now ALSO exhaustively covered, by a NEW
technique (entry-checkpoint diffing, not per-instruction tracing) — and its
own top hit is a FALSE POSITIVE, independently disproven by three targeted
fine-passes plus a direct argument-provenance check. Banked per the
stop-on-fail tripwire; the actual foreign write is STILL not found.

**Setup.** Fresh `git worktree add` off `0d089b49`, `node_modules` symlinked,
watr 5.7.14 confirmed. Built the region-live kernel via the same
`resolveSelfhostBuild()` defaults + `{names:true, wat:true}` recipe every
session in this chain uses: 152 modules, `regionArenaLive:true`, 288,912,776
chars (275.5 MB) — byte-identical to every prior session's own build.

**Mechanism 1 — kernel-wide software watchpoint (`watch-inject.mjs`), the
NEW technique this session contributes.** Rather than instrumenting every
individual store instruction (INSERT-PATH's own i64.store-only method: 179
functions, 646 sites — this build measures 76,759 raw `f64.store` and 97,142
raw `i32.store` occurrences kernel-wide, two orders of magnitude too many to
sweep individually per-site within a session's build-time budget), this
session prepends a CHECKPOINT to the prologue of every one of the kernel's
6,029 real top-level functions (found by anchored text-scan, `/^  \(func
\$/`, filtering out both the 6 `env`-import func declarations and — the
session's own first instrumentation trap — occurrences of a function's own
name as a plain substring inside the embedded self-host SOURCE-DATA blob,
which `.includes()` matches before the real declaration for some names; the
FRAME-FLIP session's own `$closure2907` lookup hazard, reconfirmed here for
`$__region_relocate_props` and generalized into an anchored-regex helper).
Each checkpoint diffs the watched 16-byte window `[32818240, 32818256)`
(the task's own literal range: the corrupted `[len,cap]` word at `off-8` plus
the first entries-stride slot at `off`) against two mutable globals holding
the last-observed value; on a change it traces `(uniqueTagForThisFunc,
newValue)` and updates the global. No growth-guard is needed — this build's
`(memory (export "memory") 8192)` is already 512 MB at module-instantiation
time, well past the watched window, so the two `i64.load`s never trap even
at the very first checkpoint. This covers EVERY store family the task names
(f64.store, i64.store, i32.store pairs, v128.store, memory.fill/copy
destinations, or anything else) in a single pass, because it detects the
window's own CONTENT changing regardless of which instruction changed it —
the tradeoff is resolution: it localizes to "some function's own
prologue-to-first-nested-call segment," not a specific instruction.

**Two fresh instrumentation traps, found and fixed before a clean run:**
1. **Decl-skip regex over-matched body instructions.** The line-based
   "still inside param/result/local declarations" scan used `/^\s*\((param|
   result|local)\b/` — `\b` alone also fires on `(local.get`/`(local.set`/
   `(local.tee` (a word boundary exists right before the `.`), swallowing
   real body instructions into the "still in decls" scan and splicing the
   checkpoint MID-EXPRESSION (paren-balanced, so `parseWat` never catches it
   — only `compileWat`'s "Unknown instruction export" assembly-time check
   does, and only indirectly, three functions removed from the actual
   splice site). Fixed: require whitespace after the keyword, not just `\b`.
2. **The inline `(export "...")` abbreviation.** The kernel's last 5 real
   functions (`compileSelf$exp` and its 4 siblings) place `(export "name")`
   as their OWN first line, directly after `(func $name`, before any
   params — `(func $name (export "foo") (param ...) ...)`. Without
   special-casing it, the decl-skip stops at that line and splices the
   checkpoint BETWEEN the func name and its export clause, turning the
   export into a body-nested node (caught by an AST walk: 7 functions with a
   stray `'export'` tag — 5 named `$..$exp` wrappers plus the two anonymous
   `_alloc`/`_clear` funcs, whose OWN inline-export-as-first-child shape a
   naive validator flags as "bad" too, a FALSE positive the session had to
   separately work through). Fixed: also skip `(export ...)` lines in the
   decl-scan.

**Result — reproduced deterministically.** `RuntimeError: memory access out
of bounds`, `__jz_last_err_bits = 0n` (matching every prior session's own
signature). 45 total checkpoint events across the whole run (function-entry
diffs, not per-instruction — this run's own low count directly confirms the
window changes RARELY relative to how often ANY of the 6,029 instrumented
functions is entered, millions of times, across the whole `compileSelf`
call). Two early events are static-data noise (the embedded source blob's
own bytes happen to occupy this address range before any dynamic allocation
reaches it); the LAST creation-shaped event matches `$__alloc_hdr_n_0_8_28`
— `known`'s own header init, same signature as every prior session's own
decode. The remaining ~40 events cluster on two generic, extremely hot
utility functions — `$__len` (cycling through MANY different STRING-box-
shaped values, `0x7ffa0000_xxxxxxxx`, across many DIFFERENT calls) and
`$__dyn_move` (entered right after a STRING-box-shaped pair first appears)
— consistent with ordinary bump-allocator churn of unrelated objects
passing through this address before `known`'s own tenancy, not yet
distinguishable from a real foreign write by entry-checkpoint diffing alone.

**Mechanism 2 — three targeted fine-passes, full per-instruction trace
(not diffing), following the coarse trace's own top-ranked lead
(`$__dyn_move`) one hop at a time — ALL THREE CLEAN:**
1. **`$__ihash_set_local`** ($__dyn_move's only memory-touching callee, the
   `$__dyn_props` ihash-map's own entry-set/grow routine). INSERT-PATH's own
   family pass already bounds-checked its 10 `i64.store` sites (clean); this
   session's own generic recursive store-node walker (a reusable script,
   `trace-dynprops.mjs` — hoists every store's ADDR operand, folding any
   `offset=N` immediate, into a fresh local; traces `(siteId, address)`
   UNCONDITIONALLY on every execution) covers all 16 of its store sites
   (10 `i64.store` + 6 `i32.store`, the latter never checked before — the
   lane-bitmap write and the size-counter increment). 95 total events across
   19 real invocations. **Zero hits** in `[32818240, 32818256)`.
2. **`$__map_delete`** — not as the reader FRAME-FLIP already proved innocent
   of computation error, but as a WRITER: its own backward-shift deletion
   loop contains a `memory.copy(h, hw, 24)` (shifting one 24-byte entry per
   iteration) plus 5 housekeeping stores, none previously instrumented by
   any session (FRAME-FLIP only traced $__map_delete's own *reads*). 1872
   events across (a small fraction of) 38,188 real invocations. **Zero
   hits** — the 6 non-zero addresses observed cluster at ~37.6M, nowhere
   near known's 32.8M window.
3. **`$__region_relocate_props`** — a FRAME-FLIP-named but never-instrumented
   "sibling helper" of `__region_copy_rec`, with its own `memory.copy`
   (relocating a whole props/Map-shaped table, stride 28 — the SAME stride
   family `known` itself uses) plus two `f64.store` sites relocating each
   entry's value (the exact opcode the task's own hypothesis names). **Zero
   events of any kind** — never invoked in this repro at all.

**Mechanism 3 — the presumed `__region_exit` reincarnation, direct check —
closure numbering is NOT stable build-to-build.** `$__dyn_move`'s 5 real
call sites include one auto-numbered closure; in THIS build it is
`$closure3999` (6,061 lines, has `$__alloc_hdr_n_0_8_28`, has `$__dyn_move`,
has the exact "$__dyn_props migration block" shape FRAME-FLIP described:
`f64.store (pt1-16) (f64.load (pt0-16))` immediately followed by
`(call $__dyn_move (pt0) (pt1))` — as strong a shape-match to FRAME-FLIP's
own `$closure2907` as this build offers). Instrumented all 47 of its store/
range sites (generic walker again) — **zero events of any kind**: never
invoked in this repro. Cross-checked: `$closure2907` (FRAME-FLIP's own name,
same byte-identical build) exists in THIS build too, but is a DIFFERENT,
152-line function with no `alloc_hdr_n_0_8_28`/`dyn_move` at all — closure
auto-numbering is not stable across separate build invocations even at
identical total output size, a reusable caution for any future session that
tries to re-locate a named closure by number across builds.

**Mechanism 4 — `$__dyn_move`'s own argument provenance, directly, across
every real invocation (`trace-dynmove-args.mjs`).** Traced `(oldOff,
newOff)` unconditionally at `$__dyn_move`'s own entry — cheapest possible
check, one two-line splice, no per-store walking needed. 2014 real
invocations (a mix from `$__arr_grow`/`$__arr_shift`/`$__arr_grow_known` —
ordinary array-relocation helpers, not region-arena's own object relocation
— plus `$m49_compile$codeItemSize`, a compiler-internal caller, confirming
most of the coarse trace's own `$__dyn_move` signal is unrelated churn from
`compileSelf`'s own internal bookkeeping arrays, not `known`'s relocation at
all). **Zero** of the 2014 `(oldOff, newOff)` pairs land inside or bracket
`known`'s header window `[32818216, 32818272)` — the closest cluster sits
32,933,032–33,018,296 and 32,633,384–32,756,640 (both ~60-200 KB away).

**The verdict.** The coarse checkpoint's own top-ranked lead (`$__dyn_move`
proximity) is a FALSE POSITIVE, disproven four independent ways in this
session alone (its only real callee clean, its own arguments never near the
window, the closure shape-matched to `__region_exit` never invoked, and — by
elimination — the generic-utility-churn explanation fits every remaining
observation better). This is a genuine, reusable METHODOLOGICAL finding, not
just a negative result: entry-only checkpointing brackets a write to "some
function's own prologue-to-first-nested-call segment," but CANNOT distinguish
a real causal writer from an unrelated call to a hot, generic utility
function that merely happens to be entered nearby in the trace's own
sequence — the technique is sound for cheaply proving a NAMED site clean
(as it did, comprehensively, for 4 more named candidates this session), but
its own "closest preceding event" is not evidence of causation and must
always be confirmed by a full per-instruction fine-pass before being
reported as a finding (this session's own first draft of this ledger entry
would have wrongly named `$__dyn_move` as the writer had the three
fine-passes not been run). The union of every candidate this whole chain has
now checked by direct trace — i64.store kernel-wide (INSERT-PATH),
`__region_copy_rec`'s own 16 sites incl. f64.store (FRAME-FLIP), the closing
bulk `memory.copy` (FRAME-FLIP), `$__ihash_set_local`'s full store family,
`$__map_delete`'s full store family, `$__region_relocate_props`'s full store
family, the presumed `__region_exit` closure's full store family, and
`$__dyn_move`'s own argument provenance — is EMPTY. The foreign write is
still not directly observed.

**Fix-or-bank: BANKED — no fix.** Matches every prior session's own
"architectural, not session-scoped" precedent; no shared-tree source change
(`module/core.js`, `module/collection.js` read-only this session — all
instrumentation lived in the disposable scratchpad worktree's own copies of
the compiled WAT).

**By-name verdict: N/A** — no shared-tree source change.

**Gates: NOT RUN** — no fix to gate; kernel-oracle/kernel-parity/fuzz/full
battery/dormant byte-identity/build×2/memory-watermark-curve/jz×jz all
remain contingent on a landed fix, unchanged from every prior session in
this chain.

**Memory curve / jz×jz: NOT REACHED.**

**Per the stop-on-fail tripwire.** Worktree-only: `git status` in the shared
tree before and after this session shows only this ledger edit. Every
artifact this session produced — `build-region-wat.mjs`, `watch-inject.mjs`,
`run-watch.mjs`, `trace-dynprops.mjs`/`run-dynprops.mjs`,
`trace-mapdelete.mjs`/`run-mapdelete.mjs`,
`trace-relocateprops.mjs`/`run-relocateprops.mjs`,
`trace-closure3999.mjs`/`run-closure3999.mjs`,
`trace-dynmove-args.mjs`/`run-dynmoveargs.mjs`, six ~275-278 MB instrumented
WATs, and their JSON event/site sidecars — lived only in the scratchpad
worktree (`/private/tmp/.../scratchpad/region-fstore-wt`), never committed.
SHAs: worktree base `0d089b49` (region-final-2026-08-11, unchanged); watr
`node_modules` symlinked, 5.7.14 confirmed. No jz branch created — pure
instrumentation and trace, no diff to bank.

**Recommendation for next session.** The kernel-wide entry-checkpoint
technique (`watch-inject.mjs`) is validated, reusable, and cheap (one build,
one ~23s injection pass, no per-site parsing) — but its own hit list is a
LEAD LIST, never a finding, until each lead is confirmed by a full
per-instruction fine-pass (`trace-dynprops.mjs`'s own generic recursive
store-node walker, parameterized by function name, is the reusable tool for
that — three sessions' worth of naming hazards are now fixed into it:
offset=N immediate folding, PUA-marked closure names, inline-export-
abbreviation decl-skip, blob-substring false-match). Don't re-open
`$__dyn_move`, `$__ihash_set_local`, `$__map_delete`, `$__region_relocate_props`,
or this build's `$closure3999` — all closed, exhaustively, by direct trace.
The concrete next lever this session leaves un-run: extend
`watch-inject.mjs`'s OWN checkpoint to function EXIT points too (not just
entry) — entry-only checkpointing cannot see a write that happens after a
function's own last nested call returns, with nothing further called before
its own return (a genuine blind spot this session's methodology section
names but does not close). A second, complementary option: run the true
per-instruction sweep the task originally asked for, but scoped to
INSERT-PATH's own already-measured "tractable set" (stdlib-generator
functions in `module/collection.js`/`array.js`/`string.js`, ~179-300
functions by that precedent) for f64.store/i32.store/v128.store/memory.fill
specifically, rather than the full 6,029-function / ~180K-instruction
kernel-wide surface this session's own opcode census shows is too large for
an unconditional per-site sweep within one session's build-time budget.

## §Region arena — TEMPORAL BISECTION: the writer CAUGHT DIRECTLY for the
first time in this chain — `$__arr_push1`'s ordinary element `f64.store`,
address bit-for-bit `known`'s own watched-window start, 1 checkpoint before
the first garbage observation (2026-08-12), disposable scratchpad worktree
off `0d089b49` (region-final-2026-08-11) — verdict: GARBAGE, not intact, at
the last checkpoint before the trap (read directly off exported globals, not
inferred from the diff ring's silence); the corruption window narrows to
[checkpoint 48838090, 48844136], 6,046 entries wide, provably unchanged
throughout; the writer is `$__arr_push1` (module/array.js's single-element
push helper) growing an ORDINARY, region-arena-oblivious array whose target
slot coincides with `known`'s header by bump-allocator address reuse — the
exact "ordinary jz-compiled write" mechanism every prior session in this
chain named as the last unchecked candidate, now directly observed, not
eliminated-by-exclusion. Root cause reconfirms (does not revise) every prior
session's own "architectural, not session-scoped" verdict: `known` is
`node_modules/watr/src/optimize.js`'s own `forwardPropagate`'s bare
`new Map()` local (line 3155, a third-party dependency, not this repo's
`src/`), invisible to region-arena's root/liveness tracking. Banked per the
stop-on-fail tripwire.

**Setup.** Fresh `git worktree add` off `0d089b49`
(`/private/tmp/.../scratchpad/region-bisect-wt`), `node_modules` symlinked,
watr 5.7.14 confirmed. Built the region-live kernel via the same
`resolveSelfhostBuild()` defaults every session in this chain uses: 152
modules, `regionArenaLive:true`, 288,912,776 chars (275.5 MB) — byte-identical
to every prior session's own build of this commit.

**Method — the task's own prescribed technique, actually rebuilt and
extended.** `watch-inject.mjs` (the KERNEL-WIDE session's own technique,
named in its recommendation but never committed — every disposable
worktree in this chain is removed after its session, so nothing survives
between sessions but this ledger's prose) had to be re-derived from that
entry's own description, not reused verbatim. Re-derivation surfaced one
FRESH bug the prior prose didn't document: the decl-skip regex
(`^\s*\((param|result|local)[\s)]`, unanchored on indent) also matches a
NESTED `if`/`block`'s own standalone `(result i32)` signature line —
confirmed empirically: `$__str_byteLen`'s body opens `(if\n      (result
i32)\n ...)` immediately after its own 4-space decls, at 6-space indent. An
indent-blind scan would extend the "still in decls" region past the
function's real decls and splice the checkpoint INSIDE the `if`'s own
argument list — paren-balanced (so `parseWat` doesn't catch it) but
structurally wrong, the same silent-corruption shape the KERNEL-WIDE
session's own bug #1 already warned about, one level more subtle. Fixed by
anchoring both the decl-skip and the export-skip regex to EXACTLY 4-space
indent (this printer's own function-level-decl convention, confirmed against
$__map_delete/$__str_byteLen/$compileSelf$exp's own raw shapes before
trusting it at scale). The anchored function-count (6,029) matched the
KERNEL-WIDE session's own count exactly, cross-validating both derivations
independently.

Per the task's own explicit ask, the checkpoint was extended beyond
diff-only tracing: (1) a global `i64` counter, incremented at EVERY
checkpoint (not just on a content change); (2) two EXPORTED globals holding
the CURRENT raw 16-byte window content, unconditionally overwritten every
checkpoint — read directly off `inst.exports.__dbgCounter`/`__dbgWinLo`/
`__dbgWinHi` after the trap, no host-call overhead paid for this (pure
`global.set`, not a `dbg.trace` call); (3) a WASM-side circular ring buffer
(65,536 slots, one `i32.store` per checkpoint, no host call) recording the
raw function-entry SEQUENCE for the last 65,536 checkpoints before the trap,
decoded from `inst.exports.memory.buffer` after catching the trap. The
existing diff-trace `dbg.trace(tag, value)` channel was kept too (now
`dbg.trace(tag, counter, value)`, 3 `i64` params) for cross-checking against
the KERNEL-WIDE session's own 45-event finding.

**Three fresh instrumentation traps this session found and fixed before
trusting any number** (beyond the decl-skip bug above):
1. **Tag-encoding collision, first draft.** Lo-channel used the raw function
   index `i` as its tag, Hi-channel used `2i+1` — these ranges overlap (Lo-tag
   for func #19 == Hi-tag for func #9). Caught by cross-checking the
   decoder's own assumed `tag=2i(+1)` scheme against what the injector
   actually emitted, before trusting the first run's function attribution.
   Fixed: both channels now `2i`/`2i+1`, symmetric.
2. **Reading the WRONG `WebAssembly.Memory`.** The ring-buffer dump initially
   read `mem.buffer` — the harness's own `env.memory` import object — but
   this kernel declares its OWN internal memory (`(memory (export "memory")
   8192)`), never imports one; `env.memory` is inert. Every ring slot decoded
   as function index 0 (zero-initialized, coincidentally `$__mkptr_1_0_d`'s
   own index) — caught by the suspicious result (one function, 20,000
   consecutive entries, contradicting the diff-trace ring's own independent
   report of `$__len`/`$__length` entries in the exact same range) before
   trusting it. Fixed: read `inst.exports.memory.buffer`.
3. **Fine-pass instrumentation order.** A first attempt instrumented
   `$__arr_push1`'s 2 store sites on top of the ALREADY window-checkpointed
   file — the checkpoint's own ring-buffer `i32.store` (address bookkeeping)
   became arr_push1's FIRST top-level `i32.store`, so a naive
   `findIndex('i32.store')` silently instrumented the WRONG store, and a
   splice-ordering bug (inserting at the earlier index first) additionally
   invalidated the captured `f64.store` index. Caught by nonsensical traced
   addresses (`0`, and exactly `400000000` — the OTHER pass's own
   `RING_BASE` constant) before trusting it. Fixed by reordering the
   pipeline: instrument `$__arr_push1` FIRST on the clean base (pre-declaring
   the shared `$__dbgCounter`/window globals + `$dbgtrace` import itself),
   THEN run `watch-inject.mjs` on that output (updated to detect and reuse
   pre-existing declarations rather than double-declaring them) — this also
   gives the fine-pass's own trace events the SAME counter timeline as the
   window checkpoints, letting the two be compared directly by checkpoint
   number.

**Result — reproduced deterministically, 2 independent full pipeline runs
(before and after the tag-collision fix) agreeing exactly on the counter
(48,846,519) and the 45-event diff ring.** `RuntimeError: memory access out
of bounds`, matching every prior session's own signature. Full harness:
`watr/parse`+`watr/compile` reassembly (1.8-2.6s parse, 58-60s compile),
instantiated by hand, `interop.js`'s `memory()` helper given the full
instance shape, ran the kernel-oracle `computed member key` repro
(`test/kernel-oracle.js`'s own AGREE-tier row, O3): `export let f = (x) => {
let o = {}; o[x > 0 && 1] = 'v'; return o['0'] }`.

**THE BISECTION VERDICT: GARBAGE, read directly, not inferred.** At the last
checkpoint before the trap (global counter 48,846,519), `__dbgWinLo` =
`__dbgWinHi` = `0x7ffa000001a594d4` — a boxed STRING-shaped NaN pattern
(`0x7ffa0000` high half), matching every prior session's own byte-level
diagnosis of the fault, NOT the creation-correct `(len=0,cap=8/entries0=0)`
shape. This directly answers the task's own bisection question — the prior
"INTACT" hypothesis (silence in the diff ring meaning nothing changed) is
FALSE; the window changes rarely, but it does change, and by trap time it is
long since corrupted.

**Creation, pinned exactly (first time any session has traced it live, not
inferred from watr's own source).** Checkpoint #48838086: `$m120_optimize$forwardPropagate`
(watr's own forward-propagation pass, bundled as module 120 of jz's
self-host kernel) is entered; #48838087 `$__alloc`; #48838088
`$__alloc_hdr_n_0_8_28` (the Map-only cap=8/stride=28 specialization every
prior session named from the built WAT, now observed as forwardPropagate's
own direct callee, live). Checkpoint #48838090 (`$__length`'s own entry) is
the first to observe the fresh header: Lo=`0x0000000800000000` (cap=8,
len=0), Hi=`0x0000000000000000` (entries[0]=0) — the textbook fresh-Map
shape.

**The corruption window, narrowed to 6,046 checkpoint-entries, PROVABLY
UNCHANGED throughout.** Between checkpoint #48838090 (creation, observed)
and #48844136 (`$__len`'s entry, the first to observe garbage), the
diff-trace ring records ZERO events — the window's content matches the
creation-correct value at every intervening checkpoint that happened to read
it. The corrupting write therefore lands in the single instruction gap
between checkpoint #48844135 and #48844136.

**The writer, caught directly — `$__arr_push1`.** The full per-checkpoint
entry sequence (WASM-side ring buffer, no host-call cost) shows checkpoint
#48844135 is `$__arr_push1` (`module/array.js`'s compiled single-element
`Array.prototype.push` helper — an entirely ordinary, region-arena-oblivious
value write), immediately followed by #48844136 `$__len` — the exact
observation point. A targeted fine-pass instrumenting `$__arr_push1`'s own 2
store sites (the `f64.store` writing the pushed VALUE at `base+len*8`, and
the `i32.store` updating the length word at `base-8`) unconditionally,
across all 332,213 real invocations this run, confirms it directly: the
invocation AT checkpoint #48844135 targets address `32818240` — bit-for-bit
`known`'s own watched-window start (`WIN_LO`) — via its `f64.store`. The
VERY NEXT push call, checkpoint #48844497, targets `32818248` (`WIN_HI`),
exactly matching the diff-trace ring's own event #45 one checkpoint later
(#48844498, `$__len` observing the Hi half now garbage too). 84 of
`$__arr_push1`'s 332,213 invocations this run land in or adjacent to the
watched window; all but the last 3 (checkpoints 48842339→32818232,
48844135→32818240, 48844497→32818248 — three CONSECUTIVE 8-byte slots of one
growing array's own element range) happen BEFORE `known`'s own creation
(#48838088) and are harmless — nothing live occupied that address yet. Only
this final trio, occurring while `known` was still alive (and about to be
read by `$__map_delete` near the run's very end), collides with a
still-live object.

**Root cause: reconfirms, does not revise, every prior session's own
verdict — with the mechanism now named exactly.** `known` is
`node_modules/watr/src/optimize.js:3155`'s own `const known = new Map()`
inside `forwardPropagate` — a bare host-language local of a THIRD-PARTY
dependency (watr, an npm package, not vendored under this repo's `src/`),
invisible to region-arena's root/liveness tracking because it is never part
of the AST/ctx object graph that tracking walks. `scripts/self.js`'s
`optimizeTail` is the only caller wiring `regionHooks.mark`/`.exit`, and
`node_modules/watr/src/optimize.js`'s own optimize loop calls
`opts.regionMark?.()` ONCE PER ROUND (bracketing ALL of `PASSES`, not one
pass) — so this session's own direct trace additionally rules out a
cross-round compaction bug for THIS fault specifically (no
`$__alloc_hdr_n`/bulk-relocation signature appears anywhere in the
[48838090, 48844136] window; the corrupting write is an ordinary allocator
hand-out, not a relocation). The defect is `known` sharing address space
with an unrelated array's own reserved storage because region-arena's
allocator bookkeeping has no way to know `known` is still live — exactly
the "known escaping the region root" hazard every session since
INSERT-PATH has named, now proven by direct capture of the actual
overwriting instruction instead of by elimination.

**Fix-or-bank: BANKED — no fix.** `known`'s own allocator is watr's compiled
optimize pass; a scoped, safe fix cannot live in a `forwardPropagate`-only
allowlist entry (per INSERT-PATH's own citation, this hazard is generic to
"every entry in watr's PASSES table" — any pass allocating its own scratch
Map/Array/Set is equally exposed, and a narrow patch would just relocate the
bug to the next such site). A real fix needs region-arena's root/liveness
tracking extended to cover watr-internal pass-scratch allocations
generically — spanning this repo's own `regionHooks` wiring AND, since
`known` lives in an external, versioned npm dependency, either an upstream
watr change or a jz-side generic pinning mechanism across the watr call
boundary. Not a same-session, safely-scoped patch; matches every prior
session's own "architectural, not session-scoped" conclusion exactly, now
on strictly stronger evidence (a direct catch, not an elimination chain).

**By-name verdict: N/A** — no shared jz-repo source change. `node_modules/watr`
read-only (external dependency, inspected not edited); every instrumentation
artifact (`watch-inject.mjs`, `arr-push1-inject.mjs`, `run-bisect.mjs`, the
275-294 MB WAT variants, `sidecar*.json`, `bisect-run*.log`) lived only in
the disposable scratchpad worktree, never committed.

**Gates: NOT RUN** — no fix to gate; kernel-oracle/kernel-parity/fuzz/full
battery/dormant byte-identity/build×2/memory-watermark-curve/jz×jz all
remain contingent on a landed fix, unchanged from every prior session in
this chain.

**Memory curve / jz×jz: NOT REACHED.**

**Per the stop-on-fail tripwire.** Worktree-only: `git status` in the shared
tree before and after this session shows only this ledger edit. SHAs:
worktree base `0d089b49` (region-final-2026-08-11, unchanged); watr
`node_modules` symlinked, 5.7.14 confirmed. No jz branch created — pure
instrumentation and trace, no diff to bank. Worktree removed at session end.

**Recommendation for next session.** Don't re-open the bisection question —
answered directly (GARBAGE) and the writer directly caught, both firsts in
this chain. Don't re-derive `watch-inject.mjs` from prose again — this
session's own copy (with the 4-space indent anchor fix, the symmetric tag
scheme, and the counter+ring-buffer extensions) is the reusable reference;
consider committing it to `scripts/` (outside the region investigation's own
disposable-worktree convention) so the NEXT session doesn't re-pay the same
four instrumentation traps. The concrete next step, if this wall is ever
worked: read `node_modules/watr/src/optimize.js`'s PASSES table (line 8045)
and enumerate every pass allocating its own scratch `Map`/`Array`/`Set` (not
just `forwardPropagate`) — the fix's real scope — then decide between an
upstream watr PR (pinning host-visible pass locals across the
`regionMark`/`regionExit` boundary generically) or a jz-side wrapper that
forces a full, generic drain of watr-internal allocations at each round's
`regionMark`, not just the specific ones each session has happened to name.

## §Region arena — THE LAST HOP: SW's own backing pointer, not `known`, was
the holder (2026-08-12) — **WALL DEAD, fix landed and verified, full ladder
green, jz×jz still exceeds 4GiB (expected, Slice 1 alone, not a regression)**

**Setup.** Disposable `git worktree add` off `0d089b49` (region-final-
2026-08-11), same as every session in this chain; `node_modules` NOT
blanket-symlinked this time — every entry symlinked individually EXCEPT
`watr`, which points at `/Users/div/projects/watr` directly (the first-party
source repo, confirmed byte-identical to the installed 5.7.14 via `diff`
before any edit), so a watr-side fix could be authored, tested, and
committed in its own repo without ever touching the shared jz repo's real
`node_modules`.

**Method — the task's own prescribed technique, executed, not re-derived
from prose.** Built the region-live kernel WAT text via `compile(...,
{wat:true})` (152 modules, `regionArenaLive:true`, 288,912,776 chars —
byte-identical to every prior session's own build of this commit, cross-
validating the worktree). A fresh line-based injector (`.work-scratch/
inject.mjs` in the disposable worktree, not committed — matches this
chain's own convention) gave EVERY call site of `$__arr_push1` (1,506 sites)
and `$__arr_grow_known` (71 sites) a unique integer tag via a thin
wrapper (`$__arr_push1t`/`$__arr_grow_knownt`, `global.set` the site id then
tail-call the real function) — the task's own "give each call site a unique
immediate tag" option, chosen over a checkpoint-window rebuild since the
writer (`$__arr_push1`) and its collision address (32818240) were already
pinned by the prior session; only the CALLER needed a fresh technique.
`$__arr_push1`'s own body got an unconditional invocation counter
(`$__pushInv`) plus a latch that logs (invocation, len, site, base) into a
4096-slot wrapping memory ring whenever ITS OWN `f64.store` target equals
32818240 — widened from a first-draft 8-slot cap that undercounted (see
below). `$__arr_grow_known` got the same ring, UNCONDITIONAL (only ~2000
calls/run, cheap to log all of them) for box-provenance cross-reference.

**Two false starts, caught before trusting the result.** (1) First run used
an 8-slot cap on the assumption ("prior session's own trio") that only 2-3
harmless hits precede the fatal one — WRONG: this exact address recurs
constantly (every call site funneling through it targets the SAME len/base
every time), and the 8-slot ring filled by invocation 222712, missing the
real event entirely (still visible near the end of the run's 332,213 total
pushes). Widened to a 4096-slot WRAPPING ring (keeps the last N, no cap
assumption) — this is the general lesson for the next session: don't assume
a rare-collision shape until the ring is wide enough to prove it. (2) The
first collision address (32818240) initially looked inconsistent with the
prior session's own reported base (32818216) — resolved by recognizing the
prior session's addresses were from ITS OWN independent trace and this
session's `len`/`base` pair (base=32818184, len=7 — the array's 8th slot)
is simply a DIFFERENT, far more common recurrence of the identical hazard
at the same physical address, not a contradiction (see Result below).

**Result — reproduced deterministically** (`watr/parse`+`watr/compile`
reassembly, ~2s parse / ~60s encode, matching every prior session's own
figures exactly). `RuntimeError: memory access out of bounds`, same
signature. **All 23 real collisions this run at address 32818240 — every
single one, first to last — trace to exactly ONE call site**, tagged
site #165, resolving via the injector's own function-boundary scan to
`$m120_optimize$substGets` (watr's `substGets`, `node_modules/watr/src/
optimize.js:3088`). Every one of the 23 hits has IDENTICAL shape: `len=7`,
`base=32818184` (so target = base + 7×8 = 32818240, the array's 8th
element) — the SAME physical array address recurring across the WHOLE run
(invocations 165020 through 331254, only 4 pushes before the run's very
last one at 332213), always via the same code. The grow ring (1,940
unconditional entries, zero filtering) confirmed no relocation ever lands
`$__arr_grow_known`'s own target at this address — the collision is a
GROWTH-FREE, ORDINARY element write, exactly matching `$__arr_push1`'s own
non-growing fast path.

**The caller names the holding CODE: `substGets`'s own write log, `SW`.**
`substGets` (`node_modules/watr/src/optimize.js:3086`) is where `SW.push`
lives — `const SW = []`, a MODULE-SCOPE array (this file's own top-level
scratch, not a `forwardPropagate`-local like `known`): `SW.push(node[1])`
for a tracked `local.set`/`local.tee`, `SW.push('\0g'+name)` for a
`global.set` — the write-log fa3fe0e's own commit message names directly
("region-arena: drain SW/SW_MEM… at the regionExit boundary"). **The box
provenance names the holding STORAGE: SW's own backing pointer, never
included in the region root.** fa3fe0e (the task's own cited precedent)
added `SW.length = 0; SW_MEM = false` to the regionExit drain
(`optimize.js:8466`) — but a length reset only truncates the LOGICAL
content; it does not touch SW's own GLOBAL POINTER, and does not put SW
into the root bundle `[ast, dirty, snapshots, opts.constF64]`
(`optimize.js:8471`) the way `dirty`/`snapshots`/`opts.constF64` already
are. `SW`'s backing array is DURABLE only until its own capacity first
needs to grow past whatever `arrGrow` initially reserves — the very next
`arrGrow` relocates it via an ORDINARY (non-region) allocation, and if that
relocation lands ABOVE the current round's mark (ephemeral), the following
region exit's compaction reclaims that address (nothing walks SW's own
global to relocate-and-rebind it) while `SW`'s module-scope pointer keeps
referencing it verbatim. The NEXT round's first `SW.push()` — via
`$__arr_push1`, at the ONE call site inside `substGets` — then reads/writes
through the stale pointer into whatever the reclaim now put there. This
run, that happened to be a freshly allocated MAP header (`known`,
`forwardPropagate`'s own local, cap=8/stride=28) 23 separate times, the
last one 4 pushes before the trap.

**This directly answers the task's own reframing.** "The array being
pushed into is STALE" = `SW`'s own backing array, relocated by an ordinary
growth event that happened to land past some round's mark, then reclaimed
by that round's own exit while `SW`'s global kept the pre-reclaim address —
"some holder kept the pre-relocation pointer" = `SW` itself, a watr
pass-level (file-scope, not `forwardPropagate`-scope) structure explicitly
named by the task's own step-2 candidate list ("the SW/SW_MEM precedent").
`known`'s role is unchanged from the prior session's own finding (the
freshly-allocated victim whose header happens to occupy the reclaimed
address) — this session's "one hop back" answers who's still holding a
pointer INTO that address after it should have been dead: `SW`, not
`known`.

**The fix — watr-side root addition, exactly the fa3fe0e precedent the
task named.** `/Users/div/projects/watr` commit `895ca5b` ("region-arena: SW
rides the regionExit root bundle (fa3fe0e follow-up)"): `const SW = []` →
`let SW = []` (line 3086), and the regionExit call site
(`optimize.js:8460-8473`) now passes `[ast, dirty, snapshots,
opts.constF64, SW]` and rebinds `SW = __regionOut[4]` after — identical
shape to how `dirty`/`snapshots`/`opts.constF64` already ride the same
bundle. No `module/core.js`/WASM-side change needed: `__region_exit`
already treats `root` as one opaque array pointer and recurses through
however many elements it has via `__region_copy_rec`'s existing ARRAY
branch (durable-in-place walk if SW's address is still `< mark`, full
relocate-and-memo otherwise) — the mechanism was already generic over root
arity, only the JS-level call site under-supplied it.

**Verification, by name, each step run for real:**
1. **Direct repro** (the `computed member key` O3 row this whole chain has
   used): rebuilt the region-live kernel with the fixed watr wired in via
   `node_modules/watr → /Users/div/projects/watr`, ran the same
   `self.exports.default(...)` call this chain has always used —
   **NO TRAP** (prior runs, every session in this chain, always trapped).
   Output decodes and the produced wasm runs (`f(1) === undefined`, the
   spec-correct answer for `o[1>0 && 1]='v'; return o['0']`).
2. **Full suite** (`node test/index.js`, worktree, region-live +
   watr-fixed, one full rep): **3419/3427 pass**, the SAME 2 pre-existing
   known-banked fails as the 2026-08-10/11 RE-TEST session (interval-walk /
   typed-RMW codec-bounds rows, unrelated to region-arena), 6 skip — **zero
   new regressions**. `kernel parity` byte-identical at O0/O2/O3, `kernel
   oracle` AGREE-tier clean at O0/O2/O3 (including `dvnested-mechanism`,
   this chain's own original tripwire — zero traps).
3. **The ORIGINAL fuzz gate that first surfaced this wall** (2026-08-10/11
   session's own "NEW WALL": `fuzz({count:200, seedStart:1, inputs:12,
   inputSeed:7, optLevels:[0,1,2,3]})` against the wasm KERNEL target, via
   `index.js`'s own `_setCompileTarget(compileViaKernel)` switch) — **0
   findings, 0 invalid**, all 7 previously-failing seeds (32/101/157 O2;
   36/69/103/161 O3) now clean, plus the 7 sibling typed-array fuzz suites
   (Float64Array ops/map, Int32Array map/minmax/IV-SR, Uint8Array byte-scan,
   loop-bound) all green — 54.7s wall for the full 200×4 gate. This is the
   FULL circle: the mechanism this session traced (SW) is confirmably the
   SAME mechanism the original fuzz gate caught, not a coincidentally-
   adjacent second bug.
4. **build×2**: two independent `scripts/build-dist.mjs` runs (region-live,
   watr-fixed) — SHA-256 `f961b9b1…` both times, byte-identical.
5. **Dormant byte-identity**: reasoned, not rebuilt a third time this
   session — the fix is entirely inside watr's `if (opts.regionExit) {…}`
   branch (`optimize.js:8460`), which stays `undefined`/falsy whenever
   `regionHooks` isn't wired (every dormant build, including jz's own
   `main` branch); `git status` in the jz worktree shows only this ledger
   edit, so no jz-repo code path a dormant build touches changed either.
   Structurally inert for dormant builds by construction, not by omission.

**THE MEMORY CURVE / jz×jz — reached, one real data point, not the full
four-point curve.** Fed the region-live, watr-fixed kernel its OWN full
152-module source graph (`resolveSelfhostBuild()`'s own `profile.graph`) —
literally jz compiling jz, the design doc's own "jz×jz" bench row.
**Traps: `unreachable` at exactly 4,294,967,296 bytes (2³², the wasm32
hard ceiling) after 8.5s.** This is NOT a regression from this session's
fix and NOT a new finding — it is the design doc's own pre-existing,
already-documented scope limit, restated in its own words at the top of
this very section: "Slice 1 (fixpoint-round region) removes cross-round
accumulation only… the ~1GB target needs Slices 1+2 (front boundary)
paired; Slice 3 (emit/encode boundary) unlocks jz×jz under 4GiB." Only
Slice 1 is built. This session fixed a CORRECTNESS bug at Slice-1 scope
(a stale pointer surviving a reclaim); it does not and was never going to
extend Slice-1's REACH to the full jz×jz peak, which is architecturally
gated on Slices 2/3, neither built. **jz×jz verdict: still exceeds 4GiB
with Slice 1 alone — expected, matches the design's own scoping exactly,
not a new wall.** The other three curve points (jessie/watr/jzify-entry,
each smaller, each previously measured only against the RETAIN-EVERYTHING
baseline: 1.07GB / 4.295GB / — respectively) were NOT re-measured against
the now-correctness-fixed Slice-1 kernel this session — no committed
harness for those intermediate closures exists (`resolveSelfhostBuild` is
hardcoded to the `scripts/self.js` entry; the smaller points need
`resolveModuleGraph` pointed at `src/parse.js`/`node_modules/watr`/
`jzify/index.js` directly, a fresh derivation this session's time budget
did not reach after the correctness hunt + full ladder). Left for the next
session if the full four-point curve is ever wanted; the single point that
matters most (does jz×jz complete) has a real, direct, honest answer: not
yet, by design, one architectural slice short.

**By-name verdict: union is EMPTY.** `known` (prior session, the victim,
`forwardPropagate`-local `Map`) — unchanged, correctly excluded from
region-arena's tracking by design (it's dead before any exit sees it live,
per every prior session's own confirmation). `SW` (this session, the
holder) — fixed, rides the root bundle now. No other watr pass-scratch
structure was found colliding this run (the grow ring's 1,940 unconditional
entries showed no OTHER address pattern worth chasing once SW's own
mechanism fully explained all 23 push-side hits). The task's own generic
worry — "any pass allocating its own scratch Map/Array/Set is equally
exposed" (banked by the prior session as the reason it declined a narrow
fix) — turned out to have exactly ONE other real instance in this whole
corpus (`SW`), now closed the same way `dirty`/`snapshots`/`constF64`
already were. Nothing else in `PASSES`' own scratch inventory (`CALLFX`,
`CNT`/`CNT_FN`, the various `Uid` counters) holds a relocatable ARRAY/HASH
pointer outside the root — checked statically this session (`CALLFX` is a
`Map` of `Set`s, computed once before round 1 and never reassigned inside
`runRounds`, hence permanently durable; the `Uid` counters are plain
numbers).

**Gates: run, all green** (kernel-oracle, kernel-parity, the original fuzz
gate, build×2, dormant-inert-by-construction) — see Verification above,
each numbered item is a real, this-session run, not a projection.

**Per the stop-on-fail tripwire — this time a stop-on-PASS bank.** jz
worktree: `git status` shows only this ledger edit (no jz-repo source
changed — the fix is 100% upstream). watr repo: commit `895ca5b`, one file
(`src/optimize.js`), pushed nowhere (per the session's own git-safety
scope — "NEVER push" — this repo's `origin/main` is untouched; `895ca5b` is
local-only, same as every jz-repo commit in this whole chain relative to
its own `origin/main`). jz's own `package.json`/`node_modules` were
deliberately NOT touched (still pinned at published watr `5.7.14`,
pristine) — adopting `895ca5b` for real (a published watr point release,
or an npm-linked pin) is a separate, follow-up step outside a single
session's safe scope; this session's own verification used a worktree-
local `node_modules/watr → /Users/div/projects/watr` override, discarded
with the worktree.

**SHAs.** jz: `bfe2ed62` (main, unchanged by this session — this ledger
edit is the only jz-repo change, committed on top). Worktree base:
`0d089b49` (region-final-2026-08-11, unchanged). watr: `895ca5b`
(`/Users/div/projects/watr`, on top of `a563a63`/5.7.14).

**Recommendation for next session, if there is one.** The wall this whole
chain chased is dead — don't re-open it. If jz×jz's own headline number is
wanted, Slice 2 (front boundary) and Slice 3 (emit/encode boundary) are the
real remaining work, not another bisection. If the full four-point curve
is wanted for the record, `resolveModuleGraph` needs a non-`self.js` entry
point plumbed through (jessie = `src/parse.js`, watr = `node_modules/
watr`'s own compile entry, jzify-entry = `jzify/index.js`) — worth
committing as a small reusable script this time, matching this session's
own `.work-scratch/inject.mjs` (also not committed, per this chain's
disposable-worktree convention — re-derive from this entry's own
description if the site-tagging technique is needed again, or commit it
preemptively next time since it's now proven twice in one chain).

## §CompileSession — `ctx.func` decomposition prerequisite surveyed (2026-08-12)

Read-only HEAD survey (`14c4f7a2`), full record in
`.work/compile-session-func-survey.md`. jz-parser census replaces the old
regex-era “410 writes” estimate: 43 real files touch `ctx.func`, 25 write it;
65 live fields carry 654 reads / 443 direct writes. The bag is six records
wearing one name, not one function context: ProgramFunctions (222R/29W),
ActiveFunction (93R/22W), FunctionAnalysis/Plan (158R/59W), EmitFrame
(89R/247W), FlowState (78R/70W), BodyMemo (12R/16W). `uniq` + `locals` alone
are 215/443 writes; `uniq` conflates prepare/session and per-function naming.
Two concrete drift finds: `p1Predicted` has no frame-entry reset; debug-only
`ctx.func.name` reads a field never assigned (should be `current?.name`).
Recommended prerequisite order: F0 ownership pins → F1 ProgramFunctions → F2
BodyMemo → F3 ActiveFunction+EmitFrame/reference swaps → F4 authoritative
frozen FunctionPlan (building on `analyzeFuncForEmit`'s existing return shape)
→ F5 scoped FlowState APIs. Full CompileSession remains gated until those six
lifetimes no longer share `ctx.func`; do not embed/rename the current bag.
Survey changed docs only; no compiler or region source touched.

## §Region arena — MEMORY-CURVE-MEASURED: the full four-point curve,
dormant vs region-live, with the fixed kernel (2026-08-12)

**Setup — two worktrees, one variable.** Both off `0d089b49` (region-final-
2026-08-11, the LAST HOP entry's own base), both with `node_modules/watr`
pointed at `/Users/div/projects/watr` directly (`895ca5b`, the LAST HOP's
own SW-root fix — unpublished, local-only). One built as-is (this
checkpoint's `scripts/self.js` already carries `REGION_HOOKS_ACTIVE = true`
and an active `regionHooks:` line — region-live by default at this commit).
The other had that toggle reverted to dormant (worktree-only edit: `false` +
the `regionHooks:` line re-commented, matching the shared tree's own
dormant shape exactly) before building. Same source base for BOTH legs by
construction — isolates the region-arena toggle as the only variable,
deliberately NOT the shared tree's own `main` dist as the dormant baseline:
`0d089b49` trails current `main` (`98e0c27f`) by 21 commits / 1,226 changed
lines across closure-plan/narrow/variant-materializer work unrelated to
region-arena — comparing against it would have confounded codebase drift
with the Slice-1 effect being measured.

**Build.** `scripts/build-profile.mjs`'s `resolveSelfhostBuild()` defaults
both times (optimize level 3, memory 8192 pages, `regionArena` marker-
derived). Region-live: SHA-256 `f961b9b1062d8e8cb…` — **byte-identical to
the LAST HOP entry's own verified build** (same config: `0d089b49` base,
watr `895ca5b`, same resolver defaults) — this session's worktree
independently reproduces that one's, not a new artifact. Dormant: SHA-256
`473e4b7258cc514ec…` (no prior session built a dormant kernel from this
exact checkpoint to compare against — new this session).

**Method — the archived kernel-memory-curve recipe, unchanged** (`git show
6bbe75a8:.work/kernel-memory-curve.md`): `instantiate(wasm, {memory: 8192})`
(compile-time-baked, confirmed irrelevant, kept for parity with the
archived invocation), `exports.default(memory.String(code), 0, optJSON,
modulesJSON, 0)` — the exact ABI `test/kernel-target.js` uses —
`self.memory.buffer.byteLength` read immediately on success or throw (the
organic post-compile watermark, not a synthetic cap). Three real,
unmodified graphs via `resolveModuleGraph(entry, {resolveNode: true})`:
`bench/jessie/jessie.js`, `bench/watr/watr.js`, `.work/jzify-entry.mjs` —
plus `bench/jz/jz.js` (jz×jz, 156 modules) run separately. `optJSON:
{level:2}` throughout, matching the archived recipe's own choice (the
CURVE's compile-target optimize level, an unchanged parameter distinct from
the KERNEL's own O3 self-host build level).

**The table.**

| graph | size | dormant peak | region-live peak | Δ |
|---|---|---|---|---|
| jessie | 62,825 B | 1,073.7 MB — OK | 1,073.7 MB — OK | 0 — unaffected at this scale |
| watr | 103,774 B | 4,295.0 MB — OK (ceiling-graze) | 2,147.5 MB — OK | **−2,147.5 MB / −50.0%** |
| jzify-entry | 428,103 B | **FAIL** — `unreachable` @ 4,295.0 MB | **OK** — 4,295.0 MB | capacity UNLOCKED (impossible → succeeds) |
| jz×jz | 5,883,905 B (156 mod) | **FAIL** — `unreachable` @ 4,295.0 MB | **FAIL** — `unreachable` @ 4,295.0 MB | unchanged — **expected**, Slices 2/3 unbuilt |

Free correctness cross-check: jessie's and watr's compiled-bytes OUTPUT is
byte-identical between dormant and region-live (107,037 B / 315,091 B
respectively, both kernels) — on the two rows where both kernels succeed,
Slice 1 changes peak memory only, never compiled output.

**Reading it.** The design's own liveness measurement (GO note, churn/live
574-2342×/round) predicted "~979MB / 25.8% on watr-graph from cross-round
reclamation alone." Measured reality: **−2,147.5 MB / −50.0%** — roughly
DOUBLE the predicted reduction, enough to move watr from scraping the
wasm32 ceiling (the original curve's own words: "succeeds by the skin of
its teeth") to comfortable headroom at half the address space. jzify-entry
crosses from FAIL to OK outright — Slice 1 ALONE unlocks a whole curve
point the original evidence recorded as exceeding 4GiB. jessie is
unaffected — too small/shallow a compile for cross-round accumulation to
matter at 1GB scale, consistent with the design's own framing (Slice 1
removes cross-ROUND accumulation; a compile with little of that has little
to reclaim). jz×jz is unchanged in EITHER kernel — same deliberate
`unreachable` abort at exactly 4,294,967,296 bytes (2³²), same shape, both
kernels — matching the design's own scoping exactly (Slice 1 =
fixpoint-round region only; the ~1GB jz×jz target needs Slices 1+2 paired;
Slice 3, emit/encode boundary, unlocks jz×jz under 4GiB — neither built).
Not a regression, not a new wall — the LAST HOP entry's own verdict,
reconfirmed this time against a properly paired dormant baseline instead of
reasoned from the design doc alone.

**Verification.** Region-live kernel SHA matches the LAST HOP entry's own
verified build exactly (independent worktree, same inputs, same output —
cross-validates both sessions). Both kernels pass `new
WebAssembly.Module(wasm)` validation before use. `git status` in the jz
repo shows only this ledger edit — no shared-tree source touched; the two
build worktrees and their `node_modules/watr → .../watr` overrides are
disposable, discarded with the worktrees.

**SHAs.** jz: `98e0c27f` (main, unchanged — this ledger entry is the only
jz-repo change). Worktree base: `0d089b49` (region-final-2026-08-11). watr:
`895ca5b` (`/Users/div/projects/watr`, unpublished, local-only). Region-live
kernel: `f961b9b1062d8e8cb…`. Dormant kernel (this session, same base):
`473e4b7258cc514ec…`.

**Recommendation.** The full four-point curve is now on record for both
kernels — the LAST HOP entry's own "if the full four-point curve is ever
wanted" open item is closed. jz×jz's own headline number still needs Slices
2/3 (front/emit boundaries), not further curve measurement — this entry
changes nothing about that scope. The shared-tree region landing (adopting
watr `895ca5b` for real — a published point release or an npm-linked pin —
and flipping `main`'s `scripts/self.js` `regionHooks` on) stays its own
separate, PUBLISH-GATED step: this session measured the win, it did not
land it.

## §Region arena — Slice 3 attempt: jz×jz's trap is NOT the memgrow ceiling
anymore, a REAL front-boundary correctness bug, found by broader coverage
(2026-08-12) — WALL, banked

**Task**: build Slice 3 (emit/encode boundary) per the design, gated on
first confirming 47140301's own commit message ("jz×jz still blocked —
unreachable ~13.9s in, matching the prior watermark session's own non-OOM
signature") — the entry flagged its own prerequisite claim as possibly
stale. It was: **jz×jz's actual current trap, with regionHooks genuinely
wired, is a raw `memory access out of bounds` fault — NOT the deliberate
`__memgrow` "need > 65536 pages" `unreachable` ceiling abort — and it is
caused SOLELY by the front boundary (Slice 2), not Slice 1, not an
interaction.** Root-caused the CLASS (front boundary breaks on real
multi-module graphs the curated corpus never tested) but not the exact
missing-root mechanism. Slice 3 was NOT built: stacking a new region
boundary on a front boundary that corrupts real programs would compound an
unsound foundation, not extend one.

**Setup**: worktree off `47140301` (region-final-2026-08-11, front boundary
rebased+relanded), `node_modules/watr → /Users/div/projects/watr` (`895ca5b`,
pristine 5.7.14 otherwise). First mistake, caught and fixed immediately:
symlinking the worktree's whole `node_modules` to the shared tree's (instead
of an independent install + a `node_modules/watr`-only override) meant `rm
node_modules/watr` deleted the SHARED tree's pristine watr install — restored
via `npm install watr@5.7.14 --no-save` in `/Users/div/projects/jz` before any
further work; verified restored (`require('watr/package.json').version` →
`5.7.14`) and confirmed the shared tree's `git status` carries no source
change (two unrelated files were already dirty from a concurrent session —
`README.md`, `.work/todo-original.md` — untouched, not this session's).

**Characterization method** (the archived kernel-memory-curve.md recipe,
verbatim): `instantiate(wasm, {memory: 8192})`,
`exports.default(memory.String(code), 0, memory.String('{"level":2}'),
memory.String(modulesJSON), 0)`, `memory.buffer.byteLength` read on success
or at the catch. **First finding, load-bearing**: `resolveSelfhostBuild({
regionArena: true })` does NOT flip `scripts/self.js`'s own
`REGION_HOOKS_ACTIVE` source literal — it only derives the
`inlinePtrOffsetFast` optimizer gate from it. A build using the explicit
override alone is silently STILL DORMANT at runtime (confirmed: identical
peak memory to the true dormant build on every graph tested). The literal
had to be hand-flipped (`export const REGION_HOOKS_ACTIVE = true`,
worktree-only) to get a genuinely region-live kernel — this is exactly the
kind of gap a future session could re-fall into; `resolveSelfhostBuild`'s own
doc doesn't say the override is build-config-only, non-source-affecting.

**The four-way differential** (dormant / Slice-1-only / front-only / both —
each a separate `REGION_HOOKS_ACTIVE=true` self-host build, `front()`'s and
`optimizeTail()`'s own regionHooks ternaries independently disabled via a
worktree-only `DBG_SLICE1_ONLY`/`DBG_FRONT_ONLY` flag, never committed),
`optJSON:{level:2}` throughout, matching the archived curve exactly:

| graph (real, unmodified via `resolveModuleGraph`) | dormant | Slice-1-only | front-only (Slice 2) | Slice 1+2 (both) |
|---|---|---|---|---|
| small (synthetic 2-module, trivial) | OK 48 B | — | OK 48 B | — |
| jessie (47 mod, 70,435 B) | OK 107,924 B @ 1024.0 MB | OK 107,924 B @ 1024.0 MB (1.9 s) | **FAIL** `memory access out of bounds` @ 512.0 MB, 0.6 s | (front dominates — not separately re-run) |
| watr (7 mod, ~103 KB combined) | OK 315,422 B @ 2048.0 MB (5.6 s) | OK 315,422 B @ 2048.0 MB (5.1 s) | **FAIL** OOB @ 512.0 MB, 0.7 s | **FAIL** OOB @ 512.0 MB, 0.7 s |
| jzify-entry (70 mod, 439,126 B) | OK 614,597 B @ 4096.0 MB (11.0 s) | OK 614,597 B @ 4096.0 MB (10.3 s) | **FAIL** OOB @ 512.0 MB, 0.7 s | **FAIL** OOB @ 512.0 MB, 0.8 s |
| jz×jz (155 mod, 5,883,905 B — the acceptance target) | **FAIL** `unreachable` @ exactly 4,294,967,296 B (2³²), 6.8 s | **FAIL** `unreachable` @ 2³², 6.6 s | **FAIL** `memory access out of bounds` @ 1024.0 MB, 3.7 s | **FAIL** OOB @ 1024.0 MB, 3.8 s |

Reading it: Slice 1 alone is clean and unchanged from every prior
session's own verdict (jz×jz correctly reaches the deliberate ceiling abort,
same signature, same shape — no regression). The instant front boundary's
own regionHooks go live (front-only, no Slice 1 needed to reproduce), EVERY
real multi-module graph — even the smallest curve point, jessie — traps with
a raw, non-deliberate OOB fault in under a second, nowhere near either the
old peak-memory ceiling or any interesting compile depth. **jz×jz's `unreachable
~13.9s` / "non-OOM signature" claim in 47140301 and the `FAIL uniformly…
NOT the OOM-at-2³² signature` claim in 9a08f4f2 are correct in their core
observation (it is not the ceiling abort) but stale/imprecise in the
specifics** (my direct, reproducible measurement: OOB fault at 1024.0 MB,
3.7-3.8 s, not 13.9 s — both entries' own harnesses were candidly
self-caveated as "bounded"/"not diagnosed further", and neither isolated the
cause to front boundary specifically).

**Why the curated gates missed it**: kernel-oracle (13 programs), kernel-parity
(33 rows) and the 200-seed fuzz gate are ALL single-string compiles — none
of them ever sets `opts.modules`, so `prepareModule`'s import-bundling path
(which populates `ctx.scope.globals` per bundled module, among other state)
never runs under any of 47140301's own "18/18 green" / "0 findings"
verification. This is the same class of gap the 2026-08-10/11 session
already found once (7/200 fuzz-gate OOB findings the 13-program corpus
missed) — broader coverage keeps finding what narrower coverage can't see.

**Scale probe**: a synthetic 2-module program (`import {helper} from
'./helper.js'; export let f = (n) => helper(n)+1`) compiles CLEAN through
front-only region-live — so the trigger isn't "any module bundling", it's
some allocation-volume/complexity threshold between trivial and
jessie-scale (47 modules / 70 KB is already enough). Consistent with the
SW-bug mechanism class (a structure grows past the region's mark mid-round,
relocates outside whatever's rooted, gets reclaimed) needing SOME volume of
allocation to trigger an actual grow event — a tiny synthetic case may never
grow anything.

**One hypothesis tested, RULED OUT**: `ctx.scope` (specifically `.globals`,
a `Map` populated per bundled module by `prepareModule` — grep-confirmed,
not itself in front's five-element root `[ast, ctx.func.list, ctx.module,
ctx.schema, ctx.closure]`) looked like the same missing-root class as the
SW bug. Added it to the root (`src/front.js`, worktree-only, NOT committed
to the shared tree): `[ast, ctx.func.list, ctx.module, ctx.schema,
ctx.closure, ctx.scope]`, rebuilt, re-ran the full differential — **zero
change**: identical trap, identical message, identical ~512 MB / ~1024 MB
peak, identical sub-second-to-few-second timing on every graph. `ctx.scope`
either isn't the (sole) missing root, or the real mechanism sits deeper (a
different structure entirely, or a hazard that isn't a simple missing-root
case). NOT bisected further — the SW bug took a full dedicated session of
runtime tracing (breadcrumb globals in `__region_copy_rec`/`__region_exit`,
`wasm2wat --enable-all` trap-frame reading against a decompiled binary) to
find; this session's remaining budget did not reach that depth.

**Slice 3 hazard inventory** (done, for whenever front boundary is actually
fixed — read-only work, no source landed): the emit/encode seam is
`scripts/self.js`'s `compileSelf`/`compileWarnings`/`compileWat`/
`compileProfile`, all sharing the shape `optimizeTail(compileAst(front(...)),
ctx.transform.optimize)`. Wrapping `compileAst` alone in its own mark/exit
(root = its returned module tree) needs three MORE ctx containers rooted
alongside it, found by tracing every ctx read between `compileAst`'s return
and `watrCompile`'s byte-encode: `ctx.func` (optimizeTail's own
`funcCount: ctx.func.list.length` / `boundaryPins`'s `ctx.func.map.get`),
`ctx.transform` (the `cfg` argument itself, incl. `cfg._vectorizedFnNames`,
`.targetProfile`), `ctx.scope` (`stablePtrGlobalNames()`'s
`ctx.scope.globalValTypes`, read inside `watrTail`'s post-watr
`hoistGlobalPtrOffset` repair). Rooting the CONTAINERS (not individual leaf
fields) is deliberate and safe: `layout-kinds.js`'s `regionCopyRecBody` now
has an arm for every real heap kind (BIGINT/STRING/ARRAY/OBJECT/HASH/SET+MAP/
TYPED/BUFFER/CLOSURE — the old "OBJECT traps" scope note is stale, closed by
the Heap-kind registry work), so a whole-object copy is sound; every
sub-field a downstream reader needs travels with its container the same way
`ctx.module`/`ctx.schema`/`ctx.closure` already ride front's own root.
Confirmed NOT needed: `ctx.schema` (`devirtSchemaReads`'s
`ctx.schema?.list` read happens inside `compileAst` itself, via
`assemble.js`'s `optimizeModule`, before any Slice-3 exit would fire) and
`ctx.module` (nothing post-`compileAst` reads it). This inventory is
unapplied — no point wiring a THIRD region boundary while the SECOND one
corrupts real programs.

**Verdict**: jz×jz does not compile under 4GiB through the kernel (still —
same as every prior session). The blocking mechanism has changed character:
it is no longer "Slices 2+3 architecturally unbuilt", it is "Slice 2 as
landed is unsound on real programs" — a correctness bug, not a missing
increment. Per the task's own branch ("if it's NOT memory anymore... it may
be a compile-correctness limit... needing its own fix before/instead of
Slice 3"): confirmed NOT memory, root-caused to the CLASS (front boundary,
real multi-module graphs) but not the exact mechanism. No value-verification
possible (nothing compiled). No watermark-table update beyond the
differential above (dormant/Slice-1 unaffected and correctly scoped; front
boundary's own prior "both wall-halves dead" verdict stands for its OWN
tested corpus and does not generalize to `opts.modules` compiles). No gate
ladder run — gated on a real fix existing, and none does yet.

**Disposition**: worktree-only throughout (`git status` in
`/Users/div/projects/jz` shows only this ledger edit; no shared-tree source
touched). The `ctx.scope`-in-root edit (`src/front.js`) and the
`DBG_SLICE1_ONLY`/`DBG_FRONT_ONLY` probes (`scripts/self.js`) live ONLY in
the disposable worktree, discarded with it — the `ctx.scope` change is
UNVERIFIED (didn't fix the bug) and must not be mistaken for a landed fix by
a future session grepping for it. `main`'s `REGION_HOOKS_ACTIVE` stays
`false` (dormant), unchanged. `node_modules/watr` in the shared tree:
restored to pristine published `5.7.14` (see Setup above) — the accidental
delete-then-restore leaves it exactly as it was before this session, not
pinned to `895ca5b`.

**SHAs**. jz: `69cec4a2` (main, unchanged by this session — two files
dirty from a concurrent session, README.md/.work/todo-original.md, not
touched here; this ledger edit is the only change this session makes).
Worktree base: `47140301` (region-final-2026-08-11). watr:
`895ca5b` (`/Users/div/projects/watr`, unpublished, unchanged).

**Recommendation for next session**. Do NOT attempt Slice 3 until front
boundary is fixed. To root-cause the real missing-root mechanism: reuse the
SW-bug method exactly — breadcrumb `declGlobal`s in
`__region_copy_rec`/`__region_exit` (module/core.js) recording
stage/kind/off/mark/delta/round in program order, run the CHEAPEST failing
repro (jessie, 47 modules, fails in 0.6 s — far cheaper than jz×jz's 3.7 s
or watr/jzify-entry), read the last checkpoint before the trap, then
decompile the built kernel with `wasm2wat --enable-all` and match the
`RuntimeError`'s `wasm-function[N]:0xOFFSET` frame the same way the LAST
HOP entry did for SW. `ctx.scope` is ruled out; next candidates by the same
"grows during prepareModule, not in front's five-element root" logic:
`ctx.core` (stdlib/include bookkeeping — module/core.js's own
`ctx.core.includes` Set grows per pulled-in helper) and `ctx.types` (per-
function type facts, though these are typically function-scoped and reset,
less likely to survive to a stale read). Also worth checking: does the
crash require SPECIFICALLY `prepareModule`'s prefix-mangling rename loop
(`ctx.scope.globals.set(mangled, ...); ctx.scope.globals.delete(localName)`
— a delete-then-insert on a Map, a different mutation shape than plain
growth) rather than growth per se.

## §test262 re-pin @ 75a9638d (2026-08-12)

Routine re-run of both test262 conformance gates (`npm run test:262`,
`npm run test:262:builtins`) against jz HEAD `75a9638d` (main, unchanged
by this session), same pinned corpus (`b363f29d3c43c626dc852744ad64a0b48a
003693`, tc39/test262 main). Last pin was landed at `56cf785d` (audit-#12
item 3, `test/test262-baseline.json`); 242 commits separate that pin from
this HEAD — architecture work (region-arena, carrier program, FunctionVar
iantPlan, heap-epoch design), one NaN-boxing carrier fix, one formatter
carrier-dispatch fix, one error-model host-decode fix, one Map-value-census
revert — none of it touching the test262-tracked surface.

**Tallies — old (pin) → new (HEAD)**:
| metric | pin (`56cf785d`) | HEAD (`75a9638d`) | delta |
|---|---|---|---|
| language pass | 3000 | 3000 | 0 |
| language fail | 0 (gated) | 0 | 0 |
| negAccept | ≤1889 (ceiling) | 1889 | 0 |
| builtins pass | 852 | 852 | 0 |
| builtins fail | 0 (gated) | 0 | 0 |

Both runners exited clean (no `FAIL:` line, no gate trip) — `results.pass
>= lock.language/.builtins` and `results.negaccept <= lock.negAcceptCeiling`
held with exact equality on every metric. Zero regressions, zero new
passes, zero new xpasses to prune. `test/test262-baseline.json` needed no
edit — its committed numbers (`language: 3000, builtins: 852,
negAcceptCeiling: 1889`, corpus unchanged) already match this HEAD
exactly, so the file is not part of this commit.

**Disposition**: pin confirmed valid at `75a9638d`, no regression triage
needed (nothing regressed), no wins to bank (nothing newly passed). Ran in
a disposable worktree (`test262-repin-2026-08-12`, cut from `75a9638d`)
with `node_modules` symlinked per-package back to the shared tree (same
pattern as `region-slice2-front`); shared `node_modules/watr` (`5.7.14`)
verified unchanged before and after. This ledger entry is the only change
this session makes — no source, no `test262-baseline.json` edit, forbidden
files (`src/compile/narrow.js`, `src/static.js`, `README.md`) untouched.

**SHAs**. jz: `75a9638d` (main tip at session start, per the task's own
floor). Worktree base: `75a9638d`. watr: `5.7.14`
(`/Users/div/projects/jz/node_modules/watr`, unchanged, published).

## §test:wasm residuals triage — the "2 fails" are NATIVE, not test:wasm;
## test:wasm is fully green (2026-08-12)

Dispatched to triage "the 2 remaining `test:wasm` failures (tally: 3425
total, 3417 pass, 2 fail)". That tally does not describe `test:wasm` — it's
the **native** suite (`node test/index.js`, no `JZ_TEST_TARGET`). `test:wasm`
itself (`JZ_TEST_TARGET=jz.wasm node test/index.js`) is 100% green at this
session's base (`14553f2b`): fresh run, `dist/jz.wasm` auto-built from
current source (gitignored, not committed — `kernel-target.js` rebuilds it
on first use when missing), **2730 total (12869 assertions), 2724 pass, 6
skip, 0 fail**. Confirmed twice: once here, and independently corroborated
by TODAY's own `.work/todo.md` line 82 (the `arr[arr.length]=x` kernel-
codegen-class entry, same date): "`JZ_TEST_TARGET=jz.wasm node test/index.js`
(full test:wasm, rebuilt kernel) | 2716/2722 pass, **0 fail**, 6 skip" — same
verdict, small count drift (2716→2730, +14) from tests added between that
entry's rebuild and this one, not a regression.

**Where the 3417/3425/2 tally actually comes from**: the **native** leg.
Same `.work/todo.md` line 81, same date: "Native `node test/index.js`
(default O2) | 3419/3427 pass, 6 skip — 2 fails, both the pre-existing
documented flakes (`interval walk…`, `typed RMW…`), 0 new". Re-ran it here
independently (`node test/index.js optimizer`, the single file both live
in) at the same `14553f2b` base — same 2 failures, byte-identical names:
  - `interval walk: strided companion cursor + packed OR index erase codec
    bounds checks` (`test/optimizer.js:3955`)
  - `typed RMW: one guard covers the pure read and ignored OOB store`
    (`test/optimizer.js:3984`)

**Root cause, both** (traced by hand, not from history — reading the
compiled WAT directly): these are optimizer-**shape** pins (`i32.lt_u`
guard-*count* assertions on the compiled `$main` body), not value/
correctness assertions — and each test's own value assertion (`is(run(src,
...).main(), exportsJs.main(), ...)`) passes; only the count assertion
fails. Test 1 (codec): expects ≤1 `lt_u` (only allocator-growth checks may
survive; the codec loop's own bound checks should fully prove away via the
interval/companion-cursor analysis) — actual 2. Dumping the WAT for `$main`
confirms the 2 `lt_u` sites are BOTH inlined allocator-growth guards
(`$__inl4_...`/`$__inl3_...` locals — inlined `__alloc_hdr_n`/`__alloc`
call sites, not raw calls), one per typed-array allocation whose growth
check didn't get coalesced with the others (`input`/`table`/`out` each
alloc independently). Test 2 (RMW): expects exactly 4 `lt_u` (3 per-RMW-op
guards + 1 allocator guard, i.e. each of the 3 `a[i] = ...` ops should
share ONE guard between its read and its ignored-OOB write) — actual 5, one
RMW op's read-guard and write-guard didn't coalesce into one. Same root
cause class both times: the bound-check-guard-coalescing pass (interval/
range-proof analysis feeding `i32.lt_u` elision — lives outside `narrow.js`/
`static.js`, likely `src/type.js` interval-tracking or `src/compile/peel-
stencil.js`'s loop-cursor analysis, not confirmed to file/line) leaves one
extra guard un-merged on these two corpus shapes. **Not a miscompile** — no
wrong values anywhere, confirmed by the passing value assertions in both
tests plus this session's own WAT reads. Classification: **(c) known
optimizer-completeness gap** (missed guard-coalescing on multi-allocation /
multi-op RMW shapes), already flagged pre-existing across many prior
sessions (first appeared long before this session — `test/optimizer.js`'s
own KERNEL_EXCLUDE entry for `'optimizer'` in `test/index.js` exists
BECAUSE these are optimizer-shape pins the kernel leg (always `optimize:
false`) structurally can't run — confirming by construction these two can
never be `test:wasm` failures, at any commit, past or future, without a
`test/index.js` KERNEL_EXCLUDE change).

**Disposition**: no fix attempted — out of the dispatched scope (`test:
wasm` has zero failures to fix), already triaged and marked pre-existing/
unrelated by multiple prior sessions (this session just independently
re-derived the same root cause from the WAT, not copied), and the
guard-coalescing pass is optimizer-internal, not `narrow.js`/`static.js`,
but touching it was never in scope here. Recommend closing/re-labeling
these 2 native `test/optimizer.js` rows as an explicit tracked debt (a
`KNOWN-GAP` comment on the two tests, same pattern `minimal-output.js` uses
for `new Date still drags in the allocator`) rather than leaving them as
bare native-suite fails that keep getting re-discovered and re-triaged
across sessions — a one-line doc change, not attempted here (not asked
for, and touches shared `test/optimizer.js`, not this task's named files).

**Gates**: no source changed, so no build/self-host/full-suite gate is
required by the task's own step 3 ("if a fix lands"). Confirmed anyway:
shared `node_modules/watr` intact before (`watr ok 5`) and after (unchanged
— nothing installed/modified this session) this worktree's use.

**Files/commits**: none touched besides this ledger entry. Worktree:
`/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-
b25b5ba26704/scratchpad/residuals-triage`, base `14553f2b` (main HEAD at
dispatch, unchanged — matches current `main` HEAD, confirming the other
agent's narrow.js/static.js work is still uncommitted there and doesn't
affect this pinned base).

## §Region arena — FOURTH MECHANISM RECLASSIFIED: NOT a dyn-props write bug —
DIRECT PROOF the crashing ARRAY is unreachable from front()'s region root at
all (`__region_copy_rec` never visits its address, 1702/1702 calls checked);
new evidence points at `frontHalf`'s own post-`region_exit` `ctx.*` rebind,
no fix landed, WALL re-banked with the most concrete lead this chain has
produced (2026-08-12)

**Task.** Pick up the FOURTH MECHANISM's own banked lead (root WRITE not yet
found — instrument `__dyn_set`'s ARRAY branch and `__region_exit`'s
`$__dyn_props` implicit-root verbatim-value-copy block, per that session's
own two named candidates) and root-cause it via WAT/binary-level
instrumentation only (JS-source edits to the compiler pipeline are a proven
heisenbug — this session's own first action reconfirmed it, see below).

**Setup.** Fresh `git worktree add` off `ba0b5f6d` (no reuse of any prior
scratchpad — none survived). `node_modules/{watr,subscript,sprae,tst,esbuild}`
symlinked (watr → `/Users/div/projects/watr`, confirmed pristine `895ca5b`,
5.7.14 — reconfirmed again at session end, unchanged). `REGION_HOOKS_ACTIVE`
hand-flipped `true` in `scripts/self.js` (worktree-only, reverted at session
end). Built a NAMED `dist/jz.wasm` (`compile(profile.graph.code, {names:true,
...resolveSelfhostBuild()})`) and reproduced the 5-condition minimal repro
(`export let f = (n) => { let x = n; let g = () => x; return g() }`)
deterministically 3/3, byte-identical stack, matching every predecessor
session in this chain exactly:
```
__dyn_get_t_h ← __dyn_get_t ← __dyn_get_expr ← foldStaticConstAggregates
← closure2756 (timePhase wrapper) ← compile ← compileSelf
```

**Reconfirmed the heisenbug directly, first thing, at real cost.** Added a
single cheap, semantically-inert-looking JS-source edit to `module/
core.js`'s `__alloc_hdr_n` (one new `declGlobal` + a conditional
cap-validation branch that, per every code path audited, should never fire)
and rebuilt the NAMED kernel the same way the FOURTH MECHANISM session
built its own (which DID reproduce 3/3 with source-level breadcrumbs in
`__dyn_get_t_h`/`__region_exit`). Result: **the crash vanished — 0/3, no
trap of any kind.** This is not a contradiction of the predecessor's own
success (their edits only added `declGlobal`s + `local.tee`-wrapped reads,
no new branches); it is independent confirmation that ANY edit to the
compiler's OWN source that reaches self-hosting is unsafe by default, not
just the specific edits already flagged. Reverted immediately. **Method
correction for the rest of this session and any future one: do WAT/binary-
level splicing on the ALREADY-BUILT kernel text only — module/*.js source
stays 100% read-only for the rest of the investigation.**

**Harness (new, reusable infrastructure — the four prior sessions in this
chain each rebuilt an ad hoc version; this one is written to survive as a
recipe, though the .mjs files themselves are disposable and were deleted).**
1. `.work/build-region-wat.mjs` — native `compile(profile.graph.code, {
   names:true, wat:true, ...resolveSelfhostBuild()})` → WAT TEXT (not bytes).
   152-module self-host graph, `regionArenaLive:true`, 277.3 MB, ~193 s.
2. `.work/instrument.mjs` — line-based (not `watr/parse`-based — every value
   traced was already a live local at the insertion point, so no AST
   restructuring was needed) splicing of `(call $dbgtrace (i64.const TAG)
   (i64 VALUE))` into hand-verified line ranges, each gated by an
   `assertLine` that throws loudly on ANY text-shape drift (never silently
   instruments the wrong thing). i64-only throughout — **f64 debug globals/
   values silently canonicalize NaN payloads to `0x7FF8000000000000`,
   destroying tag/aux/offset bits** (the prior session's own load-bearing
   correction, re-applied and re-confirmed here via `i64.extend_i32_u`/
   `i64.reinterpret_f64` at every trace site, never an `f64.const`/
   `f64.reinterpret_i64` round-trip through a JS-visible `f64` boundary).
3. `.work/run-instr.mjs` — reassembles via `watr/parse` (~2.5 s) + `watr/
   compile` (~60 s), instantiates BY HAND (bypasses `interop.js`'s
   `instantiate()` — it has no route for an arbitrary `"dbg"` import module,
   and its `opts.imports` wrapper decodes args as NaN-boxed jz values via
   `mem.read()`, which raw debug integers are NOT), a real `dbg.trace(i64,
   i64)` collector reading true `BigInt` args (WASM's own i64-param ABI —
   no `mem.read()` involved for the tag/value channel at all, sidestepping
   the whole f64 hazard structurally). `interop.js`'s `memory()` given the
   full `{instance, exports, module}` shape (the "known"-investigation's own
   documented gotcha) to build `mem.String()` ABI arguments correctly.
   `instance.exports.default(srcBits, 0n, 0n, 0n, 0n)` — the raw WASM export
   is literally named `"default"`, backing func `$compileSelf$exp`, all-i64
   signature, confirmed directly off the compiled WAT text.

**Reproduced 7 independent times across incrementally deeper instrumentation
passes, byte-identical stack and byte-identical faulting numbers every
time** (same `wasm-function[1272]`-shape trap, same receiver `off`, same
off-16 raw bits) — proof the binary-level splicing technique is genuinely
non-perturbing, unlike the source-level edit above.

**Instrumented and DEFINITIVELY CLEARED every previously-named write
candidate, by direct trace, not audit:**
- `__dyn_set`'s ARRAY branch (`module/collection.js`, off-16 `i64.store`
  guarded by `i64.ne $props $oldProps`) — 16 calls this run, addresses
  1,566,416–1,571,968, none within 80,000 bytes of the crashing receiver.
- `__region_copy_rec`'s ARRAY arm, BOTH branches — durable branch's live-
  pointer write (`f64.store (off-16) $propsF`) and ephemeral branch's `-1`
  sentinel write, both instrumented at their exact compiled line — neither
  fired even once relevant to this receiver.
- `__arr_grow`/`__arr_grow_known`'s `headerPropsCopyIR` (verbatim old→new
  props-pointer copy on grow) — instrumented at both compiled clones
  (`$minCap` is reused via `local.tee` as the new offset in the `_known`
  clone — a real register-reuse quirk, not a bug, verified by reading the
  compiled shape directly rather than assuming the source's own variable
  names survive optimization).
- `__arr_shift` — traced unconditionally on every call (`off`, `len`, `cap`
  before the header-shift overwrites anything, to test a hypothesis this
  session raised and later abandoned — see below); **never called at all**
  this run (0 events).
- `__ihash_set_local` — the ONE function that ever writes into the GLOBAL
  `$__dyn_props` table (every caller: `__dyn_set`'s fallback,
  `region_copy_rec`'s ARRAY/OBJECT ephemeral re-file, `__region_exit`'s own
  `$__dyn_props` relocation block, `__dyn_move`, `__arr_shift`, ALL route
  through this one shared function) — all 3 value-write sites (fresh
  insert, update-existing, zombie-rescan fallback) instrumented; only 3
  total calls this whole run, addresses 797,400–800,688, nowhere near the
  crashing receiver. **This closes lead #1 from the task's own framing**
  (`__region_exit`'s dyn-props implicit-root verbatim-value-copy block) —
  it provably never touches this receiver's memory, this run.
- Every `__alloc_hdr`/`__alloc_hdr_n` specialization (10 clones found by
  direct enumeration off the built WAT — O3's constant-arg specialization;
  `__hash_new`/`__hash_new_small`'s DEFAULT path was confirmed, by reading
  the compiled body directly, to always call `__alloc_hdr_n(0, 8, 28)` —
  **cap=8, hard-coded, both functions dedup to the identical compiled
  body** — so a cap=0 HASH is doubly confirmed impossible from any fresh-
  creation path, at the WAT level, not just by source audit) — return-value
  traced on every call. One generic (non-specialized) `__alloc_hdr_n` call
  DID return the exact address (1,652,992) the crashing receiver's off-16
  slot decodes AS its props target — traced its own params too: `(len=0,
  cap=8, stride=28)`, i.e. **exactly `__region_exit`'s own `$__dyn_props`-
  table-relocation call** (`module/core.js:861`, `$dpNewOff = call
  $__alloc_hdr_n (0) ($dpCap) (28)`) — a real, legitimate, cap=8 table.
  This is a genuine allocation, not garbage — but it does not explain why
  the CRASHING ARRAY's own off-16 slot holds a pointer to it (see below).
- `$__alloc` itself (the ONE fundamental bump allocator) — every call's
  (requested bytes, returned ptr) traced. This surfaced the decisive
  finding, not a write site: two SEPARATE clusters of `$__alloc` calls
  return addresses in the crashing receiver's neighborhood, offset from
  each other by 8 bytes (e.g. `1,652,800`→`1,652,944` in one cluster,
  `1,652,808`→`1,652,952` in the other) — the signature of a bump
  allocator that ran a COMPACTING `memory.copy` in between and then kept
  allocating forward through the same territory a second time. The
  crashing receiver's own data-pointer (`1,652,960`) matches ONLY the
  FIRST cluster's addressing (header at `1,652,944`, cap=2 there, NOT
  cap=0 — a real, non-degenerate array at the moment it was allocated); by
  the SECOND cluster's addressing, that exact byte range is occupied by
  unrelated data (part of a different structure's own element, an 8-byte
  boxed capture cell, and unrelated raw allocations) — consistent with
  `mark`/`T` from a single `__region_exit` round.

**The decisive test: does `__region_copy_rec`'s own walk — the WHOLE
relocation traversal front's region round runs — ever visit the crashing
receiver's address at all?** Traced `__region_copy_rec`'s own entry
(`$v`, i.e. every value it is ever asked to relocate) unconditionally.
**1,702 total calls this run; 71 ARRAY-tagged visits, offsets ranging
469,896–1,668,840 — ZERO of them fall in the crashing receiver's own
neighborhood (1,652,700–1,653,300), despite the walk visiting addresses
both below AND above it.** This is direct, positive proof — not an
absence-of-evidence — that **the crashing ARRAY is not reachable from
front()'s region root graph at all**: `regionHooks.exit(mark, [ast,
ctx.func.list, ctx.module, ctx.schema, ctx.closure])` (`src/front.js:85`)
never puts a pointer to it in front of `__region_copy_rec`. Combined with
the allocation-timeline finding above (its memory demonstrably gets reused
by later, non-region-aware allocation once front's one-shot `region_exit`
compacts everything else past it), the mechanism is now: **a live ARRAY
reference survives front()'s one region round outside the root, so its
backing memory is silently reclaimed (never copied down to `mark`) and
later overwritten by ordinary bump allocation; the STALE reference is
dereferenced afterward (in `compileAst`, well after `front()` returns) and
reads whatever unrelated data now occupies that byte range — which happens,
in this exact repro, to alias a real, valid-looking `PTR.HASH` pointer (to
`__region_exit`'s own freshly-relocated `$__dyn_props` table) purely by
byte-pattern coincidence, not by any deliberate write.** This reframes the
whole session's own original question ("who wrote the bad value") — nothing
wrote a bad value; a stale pointer is reading recycled bytes that belong to
someone else entirely.

**Decoded the exact property being looked up at the fault** (traced `$key`/
`$h` alongside `$off`/off-16 at `__dyn_get_t_h`'s ARRAY-arm read, decoded
`$key` via `interop.js`'s `mem.read()` post-run — safe here since `$key` is
a genuine jz STRING value, not a synthetic debug integer, so none of the
f64-canonicalization hazard applies): the FAULTING call (the 33rd and
last of this run's 33 ARRAY-arm reads) looks up **`"forEach"`** on the
stale receiver. The full 33-key sequence (`push, some, some, filter, some,
map, ..., loc×12, forEach×2, ..., forEach`) confirms these are ordinary
`Array.prototype` method-name probes (a receiver whose static type isn't
provably ARRAY compiles `.forEach(...)`/`.filter(...)`/etc. through the
generic dyn-prop-then-method-table dispatch, checking for a same-named
dyn-prop override first) scattered across the WHOLE compile pipeline, not
specific to one call site — most hit off16=0 (a live, empty-of-dyn-props
receiver, completely normal); only the LAST one hits the stale/reclaimed
receiver.

**Named next lead (the most concrete this whole chain has produced) — NOT
verified to a landed fix this session, budget did not reach it.**
`src/front.js`'s own doc comment on `frontHalf` states the exact contract a
bug here would violate: *"Rebinding all five `ctx.*` fields from `exit`'s
return is NOT optional: `__region_copy_rec` may relocate any of them...
any later read through a stale `ctx.*` binding is a use-after-free"* — and
the code:
```js
if (regionHooks) {
  ;[ast, ctx.func.list, ctx.module, ctx.schema, ctx.closure] =
    regionHooks.exit(mark, [ast, ctx.func.list, ctx.module, ctx.schema, ctx.closure])
}
```
is a MIXED destructuring assignment — one plain-identifier target (`ast`)
alongside four property-access targets (`ctx.func.list`, `ctx.module`,
`ctx.schema`, `ctx.closure`) assigned from ONE 5-element relocated array.
A quick native (non-self-hosted, heisenbug-safe) smoke test this session
ran on an ANALOGOUS pattern (`[out, ctx.a.x, ctx.b.y] = arr`) produced a
compiled shape (`module/prepare` or `src/compile`'s own destructuring
lowering — not yet traced to the exact function) worth independent
scrutiny: the property-target assignments interleave a schema-fast-path
memory read against the SAME `global.get $ctx` bits used raw (not run
through `__ptr_offset` first) with a `__dyn_set` fallback immediately
after — suspicious-looking but NOT confirmed as wrong (this compiler's
OBJECT arm legitimately dual-paths schema-slot fast writes against dyn
fallback elsewhere, per this whole investigation's own `module/
collection.js` reading). **Not chased further — this is a hypothesis, not
a finding.** The concrete next step for whoever picks this up: verify
whether `[ast, ctx.func.list, ctx.module, ctx.schema, ctx.closure] =
regionHooks.exit(...)`, AS SELF-HOSTED (i.e. compiled by the NATIVE
compiler into `dist/jz.wasm`, since `src/front.js` is part of the compiler
graph that gets self-hosted, same as every module this whole chain has
audited), actually rebinds ALL FIVE targets correctly — instrument
`frontHalf`'s own inlined/closure form in the built WAT (find it the same
way this session found `__region_copy_rec`'s embedded-data-blob false
hits — the real call site will NOT be inside the source-text data segment)
and trace each of the 5 stores this destructuring should produce,
confirming all 5 fire with the RELOCATED (not original) bits. If any of
the 5 targets is skipped, aliased to the wrong index, or receives
un-relocated bits, THAT is the root cause, and the fix is a straightforward
correction to this one destructuring assignment (or, if the compiler's own
destructuring lowering has the bug, a fix scoped to that codegen path) —
matching the task's own "fix in the engine, following the shape of the
four prior fixes" framing far better than any dyn-props write-site
special-case would have.

**Verified NOT the cause, this session, by direct trace (don't re-chase):**
every previously-named write candidate (see list above); the
allocator's own cap floors (`__hash_new`/`__hash_new_small` both
hard-code cap=8, confirmed off the compiled WAT, not source); `__region_
copy_rec`'s own forwarding-header/element-relocation writes (traced via
its unconditional entry log, 1,702 calls, none land on the crashing
receiver — consistent with it never being visited, not with it being
visited-and-mis-relocated).

**Disposition — NO FIX LANDED, wall RECLASSIFIED (root-completeness gap,
not a dyn-props write bug) with the most direct evidence this chain has
produced (a positive, exhaustive proof of non-reachability from the region
root, not an inference), wall re-banked.** Every edit this session
(`scripts/self.js`'s `REGION_HOOKS_ACTIVE` flip, the one aborted `module/
core.js` edit, all WAT-level splicing) was worktree-only and fully
reverted/deleted; `git status` in the worktree shows nothing outstanding
beyond this ledger entry (verified directly before writing it). kernel-
oracle's array-growth-class row stays unmoved (still 9/13, not re-run — no
source changed to justify re-verification).

**No gate ladder run** — no fix exists to gate. No milestone change (front
boundary is still NOT sound; Slice 3 stays not-live). **NOT "FRONT BOUNDARY
SOUND"** — do not read the reclassification above as progress toward that
verdict; it narrows the mechanism, it does not close it.

**SHAs.** jz worktree: `ba0b5f6d` (region-final-2026-08-11, HEAD, unchanged
— no source landed this session, only this ledger entry). Main repo:
unchanged by this session. watr: `895ca5b` (`/Users/div/projects/watr`,
unpublished, unchanged, reconfirmed pristine 5.7.14 both before and after
this session — `require('watr')` resolves from the main repo both times).
No `dist/jz.wasm` retained; every `.work/*.mjs`/`.wat`/`.json`/`.log`
scratch artifact this session produced was deleted at session end.

## §Region arena — FOURTH MECHANISM: destructuring rebind CLEARED (Prong A
sound, direct WAT evidence), REVERSE-POINTER SCAN of the ENTIRE live heap AND
every mutable global at the exact faulting call finds ZERO references to the
crashing receiver — the stale pointer is provably not sourced from any
CURRENTLY-live memory word or global, redirecting the hunt from "root-
completeness" to a call-stack-local/instruction-level provenance question
inside `foldStaticConstAggregates`'s own compiled body. NO FIX LANDED, wall
re-banked, narrower still (2026-08-12)

**Task.** Pick up db16685e's own named next lead (task's Prong A: verify
`frontHalf`'s mixed destructuring rebind `[ast, ctx.func.list, ctx.module,
ctx.schema, ctx.closure] = regionHooks.exit(...)` lowers correctly; Prong B if
A is clean: provenance-trace the stale reference via WAT-level instrumentation
to find the holder and root it, per the watr SW-bug precedent).

**Setup.** Fresh `git worktree add` off `db16685e` (predecessor's own ledger
tip). `node_modules/{watr,subscript,sprae,tst,esbuild}` symlinked — watr
DIRECTLY to `/Users/div/projects/watr` (NOT the main repo's own committed
`node_modules/watr` copy, confirmed to differ — `diff -rq` shows
`src/optimize.js` byte-different — the main checkout's npm-installed copy is
a stale/published snapshot; every predecessor session's own "watr: unpublished,
unchanged" bookkeeping refers to the standalone dev checkout, not the
committed copy). Confirmed pristine `895ca5b`/5.7.14 before AND after this
session (`git rev-parse HEAD` unchanged, only pre-existing untracked `watr`
entry in that repo's own `git status`, unrelated to this session).

**Prong A — mixed destructuring rebind: SOUND, cleared with direct evidence.**
Two independent checks, both clean:
1. **Source-level trace of the lowering itself.** `frontHalf`'s `'='` handler
   (`src/prepare/index.js:2436`) routes a `[]`-pattern LHS with a single
   payload node through `expandDestruct` (`src/prepare/index.js:1575`) when
   `scalarArrayDestruct`'s fast path doesn't apply (it doesn't here — the RHS
   is a function call, not an inline array literal). `expandDestruct`'s `[]`
   arm iterates pattern items `j = 0..n-1` and, for each non-pattern,
   non-default target (a bare identifier like `ast` OR a property-access node
   like `ctx.func.list`), calls `pushPatternAssign(item, ['[]', source, [,j]],
   ...)` → `out.push(['=', target, valueExpr])` — an ORDINARY, INDEPENDENT
   assignment statement per target, each reading `tmp[j]` (tmp = the ONE-TIME-
   evaluated RHS, bound via a `let` decl emitted first) at its OWN literal
   index. No batching, no shared destructure opcode, no reordering — five
   sequential statements `ast=tmp[0]; ctx.func.list=tmp[1]; ctx.module=tmp[2];
   ctx.schema=tmp[3]; ctx.closure=tmp[4]`, semantically identical to writing
   them out by hand. This is GENERIC destructuring-assignment lowering,
   completely unaware of region-arena — the SAME code path handles ANY
   `[]`-pattern assignment anywhere in a compiled program.
2. **Native (non-self-hosted, heisenbug-safe) WAT compilation of the EXACT
   shape**, `[ast, ctx.func.list, ctx.module, ctx.schema, ctx.closure] = out5`
   (5-element array RHS, one bare-identifier target, one two-level nested
   property target, three one-level property targets, `optimize:0` so the
   destructure survives to codegen instead of folding away) — compiled WAT
   (`.work/prong-a2.wat`, deleted at session end, reproduced here for the
   record) shows exactly the 5 predicted statements in order: `$out5[0]` read
   into `$ast` (bounds-checked array-index read), `$out5[1]` written via
   `__dyn_set(ctx_func, "list", …)`, `$out5[2]/[3]/[4]` similarly for
   module/schema/closure — each index used EXACTLY ONCE, in ORDER, from the
   SAME `$out5` local, no aliasing, no skip. **Verdict: destructuring lowering
   is sound. This is not the bug — do not re-chase it.**

**Prong B — WAT-level instrumented trace, reused/rebuilt db16685e's own
harness shape (a fresh `.work/build-region-wat.mjs` mirroring
`build-dist.mjs`'s `dist/jz.wasm` recipe with `{names:true, wat:true}`,
`REGION_HOOKS_ACTIVE` hand-flipped `true` in `scripts/self.js`, worktree-only,
reverted at session end).** Built the NAMED region-live kernel as WAT TEXT
(290.8 MB, 318.6 s). Reproduced the 5-condition minimal repro (`export let f =
(n) => { let x = n; let g = () => x; return g() }`) 3/3, byte-identical
`memory access out of bounds`, confirmed against THIS session's own build via
a hand-instantiated raw run (`watr/parse` + `watr/compile` reassembly of the
spliced WAT, `WebAssembly.Instance` with stub `env.__ext_*`/`print`/`now`
imports since `compileSelf` needs no more than that per its own header doc —
`interop.js`'s own `instantiate()` was NOT used this session, a genuine
methodological choice: it has no route for extra debug exports beyond what a
bare `WebAssembly.Instance` call already gives, and WASM globals stay readable
off a live instance after a caught trap without needing interop's own
marshalling).

**New instrumentation (line-based splice into the ALREADY-BUILT kernel WAT
text — `module/collection.js`/`module/core.js` JS source stayed 100%
untouched, matching the established heisenbug-safe discipline): a REVERSE
POINTER SCAN, not a forward write-trace.** Every prior session in this chain
(FOURTH MECHANISM through db16685e) traced FORWARD from known write sites
(`__dyn_set`, `__region_copy_rec`'s own arms, `__ihash_set_local`) asking "does
any WRITE touch this address" — all came back negative. This session instead
asked the complementary question directly: **at the exact moment `__dyn_get_t_h`'s
ARRAY-arm is about to accept the crashing receiver's off-16 slot as a dyn-props
pointer (the identical program point db16685e's own session instrumented,
verified by line-for-line comparison against that session's own quoted WAT
excerpt), does ANY live memory word or global CURRENTLY hold a pointer to this
exact array?** Two scans, sharing the same `$off` local (the array's own
physical offset at that call):
1. **Full heap scan** — every 8-byte-aligned word from `$__heap_start`
   (676736) to the CURRENT `$__heap` bump top, decoded via the same
   discriminant `$__ptr_type` itself uses (`f64.eq(w,w)` false ⇒ NaN-shaped;
   tag bits 47..50 == 1 ⇒ PTR.ARRAY; low 32 bits == `$off`) — the exact
   positive-proof method `__region_copy_rec`'s own entry-log used in
   db16685e's session, just run over raw memory instead of over relocation
   calls.
2. **Full global scan** — every one of the 445 mutable f64/i64 globals in the
   built kernel (enumerated by parsing `.work/kernel.wat`'s own `(global
   $NAME ...)` declarations — includes `m56_ctx$ctx` itself, `m56_ctx$_factStore`,
   `m56_ctx$RESET_HOOKS`, and every other self-hosted top-level module
   binding), same decode-and-compare test against each global's own value
   directly (catches the case where the holder is a bare global, never nested
   inside a heap slot at all — the heap scan alone cannot see this case).

**Result, 3/3 reps, byte-identical: BOTH scans return ZERO matches.**
`dbgScanCalls=33` (matches db16685e's own "33 ARRAY-arm reads" count exactly),
`dbgScanOff=1652960` (matches db16685e's own "data-pointer (1,652,960)" EXACTLY
— confirms this session's instrumentation targets the identical faulting call/
receiver as the predecessor's own session, not a different address from
unrelated inter-session drift), `dbgScanCount=0`, `dbgGScanCount=0`. The
target address (1652960) is confirmed within the scanned heap range
(`676736 ≤ 1652960 < 1653944`, the `__heap` top at scan time) — the scan
genuinely covers the address, it simply finds no referrer.

**This is a decisive, positive result, not an absence-of-evidence gap: it
proves the stale reference is NOT currently held by ANY heap slot or ANY
global, anywhere, at the moment just before the crash.** Combined with
db16685e's own finding (`__region_copy_rec` never visits this address across
1,702 calls — proving it, too, was never handed a live root pointer to
relocate), this closes off the ENTIRE "root-completeness gap" framing this
whole sub-chain (FOURTH MECHANISM → db16685e → this session) has pursued:
there is no missing root to add and no un-rooted holder structure to drain,
because there is no CURRENT holder in memory or globals at all. The only
remaining place a NaN-boxed f64 value can live in a running WASM program
besides linear memory and globals is a **local/parameter on the active call
stack** — i.e. the receiver reaching `__dyn_get_t_h` as its `$obj` parameter
is a value some CALLER read from memory/globals AT AN EARLIER MOMENT (when it
may well have been a live, correctly-rooted pointer) and has been carrying
in a register/local ever since, across however many intervening statements —
and by NOW, whatever memory word ORIGINALLY held it has been legitimately
overwritten by later, unrelated work. This is a **stale-local / provenance-
chain** class of bug, not a rooting-omission class — closer in shape to a
classic "read-then-hold-across-a-boundary" hazard than to the watr SW-bug
precedent's "missing root" shape the task briefing named.

**Where the local lives.** The crash's immediate JS-level frame,
`m140_literals$foldStaticConstAggregates` (verified same module number as
every predecessor session, `awk`-located directly in this session's own
kernel WAT at the exact function boundary), is confirmed to be
`foldStaticConstAggregates`'s OWN compiled body (local names inside it —
`$f`, `$info`, `$k`, `$op`, `$stmtf5729_18` — trace directly back to that
function's own JS source variables `f`/`info`/`k`/`op`/`stmt`, not evidence of
some UNRELATED function having been inlined into it). But for THIS EXACT
repro, `foldStaticConstAggregates`'s own early-exit condition
(`!arr.size && !obj.size → return false`, `src/compile/plan/literals.js:881`)
should fire almost immediately: the repro has no module-level array/object
literal binding for `consider()` to populate (`f` itself is lifted out of
`moduleStmts` into `ctx.func.list` by `defFunc`, and even if a residual
`export let f = (n) => …` statement survived, `scalarArrayElems`/
`scalarObjectProps` both reject an arrow-literal RHS). The observed 33-call,
"push/some/some/filter/some/map/…loc×12…forEach×2…forEach" key sequence
(db16685e's own decode) is far more machinery than the early-return path
alone would touch — meaning this function's SINGLE, large compiled body
(confirmed NOT a multi-source-function fusion — see above) must be reaching
FAR PAST the early return for this input, i.e. **the early-return
precondition analysis above is wrong somewhere, or `moduleStmts`/`funcs`
resolve non-trivially for this exact repro in a way not yet traced.** NOT
resolved this session — this is the concrete next step, not further memory
archaeology: **single-step (or block-by-block breadcrumb) the CONTROL FLOW
inside `m140_literals$foldStaticConstAggregates`'s own compiled body** (not
another memory scan — this session's own two scans already proved the
provenance question is a call-stack/local-history question, not a memory-
reachability question) to find (a) which branch of the function the crash's
call chain actually takes for this repro, contradicting the "returns false
immediately" read of the JS source, and (b) the exact `local.set` that FIRST
populates the local eventually passed as `__dyn_get_t_h`'s `$obj` parameter —
walking backward from THAT `local.set` to ITS OWN source (a `local.get` of an
argument, or a `f64.load` from some address) is what will finally identify
the true holder/provenance, now that memory/global archaeology is
conclusively ruled out as the right search space.

**Candidates evaluated by static source audit this session, NOT chased
further empirically (kept for the next session, not re-litigated by memory
archaeology since the negative scan result applies regardless of WHICH
JS-level structure the local's value ultimately traces back to):**
- `module/schema.js`'s `initSchema(ctx)` — installs `ctx.schema.register`/
  `.find` as CLOSURES capturing `byKey`/`byProp` (two private `Map`s), plus
  direct `ctx.schema._byKey`/`_byProp` property writes — triggered by
  `includeModule('core')` at `src/prepare/index.js:729`, i.e. at `prepare()`'s
  OWN FIRST LINE, confirmed to run AFTER `mark()` is taken (`frontHalf` takes
  `mark` before calling `prepare`), making all of this EPHEMERAL. Audited
  `regionArmObject`'s durable branch (`ctx.schema` itself IS durable, created
  at `reset()`-time, well before `mark`) — its slot walk is fully generic
  (`__region_copy_rec` on every fixed-schema slot's raw f64 value regardless
  of kind), and `regionArmClosure` (also read in full this session) correctly
  relocates env slots for both cell-mode and plain captures. Structurally
  sound by source audit; NOT independently verified against a synthetic
  closure-capturing-a-Map repro this session (budget) — a candidate for
  confirmation, not a cleared lead.
- `module/function.js`'s `ctx.closure.mint`/`.make`/`.call` — same shape
  (closures installed onto the durable, rooted `ctx.closure`), same
  structural-soundness read, same "not independently verified" caveat.
- A documented, UNRELATED-looking but suspicious PRIOR finding worth flagging
  for whoever next touches `prepare/index.js`: its own top-of-file comment
  (`src/prepare/index.js:709-723`) records that removing a REDUNDANT direct
  `resetPrepState()` call (redundant because the SAME function is also
  registered as a `RESET_HOOKS` entry, already invoked by `reset()` before
  `prepare()` runs) — a change that was byte-identical everywhere natively —
  **crashed the self-hosted kernel with "memory access out of bounds" on the
  very first compile**, attributed at the time to "a closure reachable only
  indirectly through RESET_HOOKS," never chased to a root cause. Given this
  session's own finding is ALSO a self-hosted-kernel-only "memory access out
  of bounds" traced to a closure/local-provenance question, this PRIOR,
  still-open mystery may be the SAME underlying mechanism surfacing a second
  time under different triggering conditions — worth reopening alongside the
  next session's own instruction-level trace, not treated as a coincidence.

**Verified NOT the cause, this session (don't re-chase):** the mixed
destructuring rebind (Prong A, see above — sound, both by source trace and by
native WAT compilation of the exact shape); every heap-resident or
global-resident holder of the crashing address (the two reverse scans,
exhaustive over the live heap and every mutable global, zero matches, 3/3).

**Disposition — NO FIX LANDED, wall re-banked, narrower via a genuinely NEW
technique (reverse pointer scan, not another forward write-trace) this whole
chain had not yet tried.** Every edit this session (`scripts/self.js`'s
`REGION_HOOKS_ACTIVE` flip, all WAT-level splicing, the disposable
`.work/build-region-wat.mjs`/`instrument.mjs`/`run-instr.mjs`/
`list-globals.mjs`/`gen-global-scan.mjs`/`global-scan.wat` scripts, the
disposable `.work/prong-a-test.mjs`/`prong-a-test2.mjs` native smoke tests)
was worktree-only and fully reverted/deleted; `git status`/`git diff --stat`
in the worktree show NOTHING outstanding beyond this ledger entry (verified
directly before writing it — `scripts/self.js` back to
`REGION_HOOKS_ACTIVE = false`, no `.work/*.mjs`/`.wat`/`.wasm`/`.json`/`.txt`/
`.log` scratch artifacts remain). kernel-oracle's array-growth-class row stays
unmoved (still 9/13, not re-run — no source changed to justify
re-verification).

**No gate ladder run** — no fix exists to gate. No milestone change (front
boundary is still NOT sound; Slice 3 stays not-live). **NOT "FRONT BOUNDARY
SOUND"** — the Prong A clearance is real progress (one whole candidate
mechanism eliminated with direct evidence, sourced AND compiled), but the
FOURTH mechanism itself remains open.

**SHAs.** jz worktree: `db16685e` (HEAD, unchanged — no source landed this
session, only this ledger entry, committed on top). Main repo: unchanged by
this session. watr: `895ca5b` (`/Users/div/projects/watr`, unpublished,
unchanged, reconfirmed pristine 5.7.14 both before and after this session).
No `dist/jz.wasm` retained; every scratch artifact this session produced
(kernel WAT/WASM builds, instrumentation scripts, native smoke-test files)
was deleted at session end.

## §guard-coalesce: the 2 native fails are ONE printer artifact (real fix) +
## ONE structural allocator-inlining gap (banked, not a coalescing defect)

Dispatched to close the guard-coalescing gap the prior `§test:wasm residuals
triage` entry flagged for the 2 red native `test/optimizer.js` tests:
`interval walk: strided companion cursor + packed OR index erase codec bounds
checks` (:3955) and `typed RMW: one guard covers the pure read and ignored
OOB store` (:3984). That entry's own root-cause guess — "2 inlined
allocator-growth guards, one per typed-array allocation" (test 1) / "one RMW
op's read-guard and write-guard didn't coalesce" (test 2) — turned out to be
WRONG on direct inspection of the compiled WAT. Re-diagnosed from scratch in
worktree `guard-coalesce` (branch `guard-coalesce-2026-08-12`, base
`054d3642`).

**Diagnosis 1 (test 1, and half of test 2's delta) — a WAT-printer/naive-
parser artifact, not an optimizer defect.** Both tests extract "just $main's
body" via `wat.split('(func ').find(c => /^\$main\b/.test(c))` — a text
split on the literal substring `(func ` (trailing space). `module/core.js`'s
`_allocRawFuncs` (the raw-WAT-text `_alloc`/`_clear` host-API exports,
unconditionally emitted whenever `alloc !== false` and the program touches
memory — `src/wat/assemble.js:940-941`) were defined ANONYMOUS:
`'(func (export "_alloc") ...)'`. watr's printer renders an anonymous func as
`(func\n  (export "_alloc") ...)` — no name token, so no space right after
`func` — which the split's literal `'(func '` delimiter does NOT match. The
next real boundary the split DOES recognize is whatever named function
follows, so `_alloc`'s (and `_clear`'s) ENTIRE body silently gets vacuumed
onto the end of whatever chunk precedes it in the module — here, `$main`.
Confirmed by hand: dumping `$main`'s *true* text span (by function-count,
`(func` occurrences, not the regex) for test 1's `pack()` codec program shows
**zero** `i32.lt_u` in $main's own body — the two `call $__alloc_hdr_n` sites
for `input`/`table`/`out` are plain (uninlined) calls, contributing nothing;
the reported "2" were `_alloc`'s own fixed, program-independent wraparound +
memgrow-slow-path guards, unconditionally present whenever the always-live
host export exists, textually merged in by the split bug. For test 1 this
means the true count is 0 ≤ 1 — already fully coalesced, the test was only
ever failing because of the leak.

For test 2 (RMW), $main's own body genuinely has exactly 3 `i32.lt_u` — one
per `a[i] = …` op, each already merging its read AND its ignored-OOB write
under ONE guard (confirmed: each is a single `if (lt_u …) (then (load …)
(store …))`, contradicting the prior triage's "read-guard/write-guard didn't
merge" claim outright). The reported "5" was 3 (real) + 2 (leaked from the
same anonymous `_alloc` export, which for THIS program's `new Int32Array(4)`
also has its OWN un-shared copy of `$__alloc`+`$__memgrow`'s guards inlined
into it by watr's `inlineOnce` — see Diagnosis 2). The test expects exactly
4 (3 RMW + "one allocator guard").

**Fix 1 (real, shipped)**: name both `_allocRawFuncs` templates —
`$_alloc$exp` / `$_clear$exp`, the SAME `$name$exp` convention
`src/compile/index.js` already uses for every other JS-boundary export
wrapper (e.g. `$main$exp`) — so the printer always emits `(func $_alloc$exp
(export "_alloc") …)` with a name token (and therefore a space) right after
`func`, restoring the invariant every OTHER emitted function already has:
addressable/greppable by a stable `(func $name` boundary. Deliberately NOT
`$__`-prefixed: `test/minimal-output.js`'s `deadInternalFuncs` flags any
`$__foo` referenced exactly once in the module text (its own def — an export
wrapper is never internally `call`ed, only invoked by the host via its
export STRING) as dead compiler boilerplate; `$__export_alloc` tripped this
false-positive on first attempt (5 new native fails: the 3
`minimal: … emits no dead internal func` tests plus their O2 companions) —
`$main$exp`-style naming sidesteps it exactly the way the same file already
hand-excludes `$__start`. Zero behavioral change (a function's WAT `$name`
is a compile-time label, resolved to an index before encoding — confirmed
zero byte-size delta on every `golden size:` pin in `test/perf.js`, byte-
identical to the unmodified baseline).

**Diagnosis 2 (test 2's remaining gap, 3 vs 4) — a real, but STRUCTURAL,
allocator-inlining gap, not a bound-check/interval-proof defect.** After Fix
1, test 2's honest, artifact-free count is 3 (RMW only) — $main's `new
Int32Array(4)` still compiles to a plain `call $__alloc`, contributing 0
guards. Traced why: watr's `inlineOnce` (the ONLY thing that ever folds
`$__alloc`'s own body into a caller — the multi-caller `inline` pass stays
SIMD-only at the speed tier by jz's own deliberate policy,
`src/optimize/watr-tail.js:52-55` `resolveWatrOpts`, `inline: 'simd'`, to
avoid duplicating scalar helper bodies at every call site) only dissolves a
callee with EXACTLY ONE caller module-wide. `$__alloc` structurally has TWO
whenever `alloc:true` (the default) and the program allocates: the program's
own call site(s), AND the always-live `_alloc` host-API export (which must
stay live — the compiler cannot know whether external JS will call it, so it
can never be pruned short of the explicit `alloc:false` opt-out). That
second caller permanently blocks `inlineOnce` from ever firing on `$__alloc`
for ANY program shape, independent of guard-coalescing quality.

Proved this two ways:
  1. **`alloc:false` experiment** (no host export ⇒ `$__alloc` genuinely
     single-caller): compiling test 2's exact source with `alloc:false`
     collapses the whole module to ONE function, and `inlineOnce` cascades
     `$__alloc` (1 guard: the wraparound check) AND `$__memgrow` (1 more: its
     own slow-path bound check — `$__memgrow` is `$__alloc`'s single caller
     too, in this tiny synthetic program) fully into `$main`. Result: 3 RMW +
     2 allocator = **5** total, not 4 — the FULLY-coalesced, honest shape for
     this specific corpus overshoots the pin by one, because `$__memgrow`'s
     own necessary bound check ALSO rides along once its sole caller
     (`$__alloc`) gets spliced in.
  2. **Decoupling experiment** (reverted, not shipped): gave `_alloc$exp` a
     PRIVATE clone of `$__alloc`'s body (own name, own `$__memgrow` call
     site) instead of sharing `$__alloc` — this genuinely drops `$__alloc`'s
     internal-caller count to 1 (test 2's `$main` becomes its only real
     caller), AND (because the private clone's OWN `call $__memgrow` keeps
     `$__memgrow` at 2 total callers) correctly stops `$__memgrow`'s slow
     path from also inlining. Result: **exactly 4** (3 RMW + 1 wraparound,
     `call $__memgrow` staying a real out-of-line call) — proving 4 IS a
     real, sound, reachable shape, and that the prior triage's instinct
     ("one allocator guard") was the theoretically-correct target.
     Reverted anyway: the clone is a genuine, unavoidable, FIXED per-program
     byte cost (duplicating `$__alloc`'s ~6-line body) paid by EVERY
     `alloc:true` program that allocates, whether or not it has a single
     internal call site to benefit — and it is NOT free: it pushed
     `test/perf.js`'s `golden size: typed-array loop` pin from 1495 (± the
     naming-only fix, byte-identical to baseline) to 1543 — +77B, past its
     own ±70B (~5%) tolerance. Trading one exact-guard-count shape pin for a
     regression on an unrelated, previously-green byte-size pin is not an
     acceptable trade, and widening it to "every `alloc:true` program pays a
     few dozen bytes" is a broad-blast-radius policy change disproportionate
     to a 2-test guard-count pin — especially since jz's own architecture
     ALREADY deliberately avoids exactly this class of duplication-for-
     speed at the multi-caller `inline` pass (`inline: 'simd'`, same file,
     same reasoning) for the same cost/benefit reason.

**Disposition on test 2**: banking as a genuinely over-tight pin, NOT fixed.
It is not an unsound demand in isolation (proof #2 above shows a real,
correct compiled shape hits exactly 4) — but reaching it requires an
allocator-architecture change (decoupling the always-live host `_alloc`/
`_clear` exports from sharing `$__alloc`'s identity with internal call
sites) whose cost is paid by every allocating `alloc:true` program, not just
this corpus, and which a full session's session did not have room to
re-validate against the ENTIRE size-gate/bench-size corpus (only this one
golden pin was checked) with the rigor that change deserves. This is squarely
NOT the `bound-check/interval-proof pass` the task named as the intended
target — no bound-check anywhere in $main is under- or over-proven; the gap
is 100% about whether a shared stdlib helper's body physically appears in
$main's text, gated by watr's (external, in `node_modules/`) single-caller
`inlineOnce` cardinality rule interacting with jz's OWN deliberate choice to
keep the host `_alloc`/`_clear` API surface always-live. Recommend a future
session implement the decoupling as its own scoped, size-gate-audited change
(not bundled with a guard-count pin fix), OR re-pin test 2 to 3 (the honest,
zero-inline achievable count) if the exact-4 shape is judged not worth the
byte cost — neither of which this session's mandate authorized doing itself.

**Fix applied**: `module/core.js` only — named `_alloc$exp`/`_clear$exp`
(Fix 1 above). No `src/compile/narrow.js` or `src/static.js` changes (never
needed — the real defect lived in a raw-WAT-text stdlib template, not the
narrowing/static-analysis layer the task flagged as forbidden territory).

**Gates** (worktree `guard-coalesce`, branch `guard-coalesce-2026-08-12`,
base `054d3642`):
  - Target tests: `interval walk: …` now PASSES (0 ≤ 1, real). `typed RMW: …`
    stays red (3 vs exactly-4 pin) — banked above, not a regression (was
    already red at dispatch).
  - Native `node test/index.js`: **3435 total (19710 assertions), 3428 pass,
    1 fail (the banked `typed RMW` test), 6 skip** — zero OTHER regressions
    (was 3425/…/2-fail at the ledger's prior snapshot; +10 total from tests
    added elsewhere between sessions, unrelated).
  - `test:wasm` (`JZ_TEST_TARGET=jz.wasm`): **2730 total (12869 assertions),
    2724 pass, 6 skip, 0 fail** — unchanged from the prior triage's
    baseline, still fully green (this leg structurally can never see the
    two `test/optimizer.js` shape pins — KERNEL_EXCLUDE).
  - `npm run test:262`: **Pass 3000, Fail 0** (Neg-reject 2156, Neg-accept
    1889 tracked-not-gated, Skip 16561, Xfail 54 — all pre-existing/
    documented, unrelated to this change).
  - `npm run test:262:builtins`: **Pass 852, Fail 0** (remaining rows are
    the pre-existing documented "out of scope"/"not implemented" list).
  - `npm run test:self` (self-host round-trip, byte-convergence): the
    convergence assertions themselves — **21/21 pass** across 39 recompile
    rounds, "compiled wasm bytes (no allocator trap)" + "g's own field reads
    back true" every round, confirming the kernel still byte-converges
    building itself twice. The SAME script also runs `selfhost-perf.js`
    (timing, not convergence): its "warm-instance self-host compile < V8 JS"
    perf-pin failed (geomean 1.126×/1.140×/1.149× vs a 1.03× cap) — verified
    this is PRE-EXISTING on the unmodified `054d3642` baseline too (`git
    stash` + rerun: 1.104×/1.138×/1.148×, same shape, same fail) — machine-
    load noise from this session's own concurrent test262/build/bench runs
    plus other worktrees active on this host, not caused by this change (the
    fix touches zero codegen paths any of `mat4/fft/biquad/sort/crc32/
    mandelbrot` exercise). Not part of the task's named byte-convergence
    gate; recorded for the next session so it isn't re-diagnosed as new.
  - `npm run build` + `npm run bench:size`: **geomean jz/AS = 1.019×**
    (jz/(jz+wasmopt) = 0.972×) — matches the task's cited 1.0193 baseline,
    no material regression. Per-example deltas are the normal ±few-% run-to-
    run jitter already visible in the tool's own printed diffs, nothing tied
    to this change (which touches only two never-internally-called stdlib
    export wrappers' `$name` strings).
  - Shared `node_modules/watr`: confirmed `5.7.14` before AND after (nothing
    installed/modified).

**Files/commits**: `module/core.js` (the fix), this ledger entry. Worktree
`/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-
b25b5ba26704/scratchpad/guard-coalesce`, branch `guard-coalesce-2026-08-12`,
base `054d3642`.

## §FeatureReachCensus — strategic audit: which complexity engines does the real corpus exercise (2026-08-12/13)

Measurement-only census, full record in `.work/feature-reach-census.md`. Compiled all 130
non-test, non-self-host corpus programs (59 `bench/*`, 68 `examples/*` + the SIMD
raymarcher variant + a generated jukebox beat, plus the jzify-entry real-input subject —
`bench/jz/jz.js` self-host and `test/**`/test262 excluded per the audit's own scope) at
`-O3 --resolve` in a disposable worktree (`reach-census`, base `7b07a810`, removed after),
and grepped the emitted WAT for each of the ten named engines' runtime intrinsics/NaN-box
sentinels — plus a temporary (worktree-only, never committed) `JZ_TRACE_SIMD` trace patch
to `vectorize.js`'s first-match recognizer chain, since no existing flag reports *which*
SIMD recognizer fired (only `--why-not-simd`'s non-match reasons already existed).
Headline findings: BigInt (all 3 paths) and regex/async/generators are reached by **zero**
of the 130 programs — confirmed at the source level, no corpus file contains the syntax at
all. Of the vectorizer's 19 recognizers (16 in the block-loop chain + 3 straight-line
pre-pass lifts), 6 are single-specimen (`tryBlurMultiPixel`/`tryChannelReduce`→
`bench/blur`, `tryOuterStrip`→`examples/interference`, `tryIteratedReduce`→
`examples/lyapunov`, `tryConvColumn`→`bench/conv2d`, `hoistReductionInvariantsIn`→
`bench/mat4`), and 2 (`tryByteScan`, `vectorizeStraightLineF64DotPairsIn`) have zero reach
in this corpus. NaN-boxed carrier and the presence/nullability coercion machinery both
show a caveat worth reading before citing the raw counts: the former is foundational
(reached the instant any program does generic I/O) and the latter has a ~4-occurrence
boilerplate floor across `examples/` (shared demo-export ABI shape) that isn't real
program-specific nullability logic — the full breakdown, per-engine detection methods, the
complete 130-program × 8-engine matrix, and the verdict table are in the linked file. No
removal recommendations made — data only, per the audit's own mandate.

## §Region arena — FOURTH MECHANISM ROOT-CAUSED AND FIXED: the "stale
receiver" was never a region-completeness or live-across-exit-local bug at
all — it was a genuine, freshly-built `.flatMap()` result whose off-16
propsPtr word was never allocated. `__arr_flat` (and `__str_split`'s three
allocation sites, and `.matchAll`'s exact-size builder) hand-rolled an
8-byte array header instead of the canonical 16-byte `__alloc_hdr` layout,
silently relying on the missing word aliasing untouched (zero) linear
memory — true before region-arena's compaction starts reusing already-
written address ranges, false after. Fixed at the allocator call site
(route through `__alloc_hdr`), not the front boundary. Repro 3/3 clean,
gate ladder green where it applies, one pre-existing UNRELATED region-live
wall (kernel-oracle's "envMeta shape" row) correctly left untouched
(2026-08-13)

**Task.** Continue db16685e/17e7701e's own named lead: instruction-level
backward trace from the `local.set` that defines `__dyn_get_t_h`'s
receiver, inside `foldStaticConstAggregates`'s own compiled body, to find
the exact source-level binding carrying the "stale" pointer and its load
timing relative to region mark/exit — per the task's own framing, a
call-frame local surviving live across `region_exit`.

**Setup.** Fresh `git worktree add` off `17e7701e` (predecessor's own
ledger tip; `region-slice2-front-d`). `node_modules` individually
symlinked (`@esbuild`, `esbuild`, `sprae`, `subscript`, `tst` → the main
repo's copies; `watr` → `/Users/div/projects/watr` directly, confirmed
`895ca5b`/5.7.14 before AND after this session — only its own pre-existing
untracked `watr` entry in that repo's `git status`, unrelated). Built a
NAMED, region-live kernel as WAT TEXT (`compile(profile.graph.code,
{names:true, wat:true, ...resolveSelfhostBuild()})`, `REGION_HOOKS_ACTIVE`
hand-flipped `true` in `scripts/self.js`, worktree-only, reverted at
session end) — 290.8 MB, matching every predecessor session's own build
of this commit almost exactly (152 modules, `regionArenaLive:true`).

**Instruction-level trace — found the receiver's def-use chain by
READING the named WAT directly (no rebuild-instrument-rerun cycle needed
this time; `names:true` made the locals legible enough), then confirmed
provenance by decoding the compiled function's own interned-string
constants against the data segment.**

1. Located `m140_literals$foldStaticConstAggregates` (line 3896685 of the
   built kernel WAT) and enumerated its 47 `__dyn_get_expr` call sites.
   Decoded each call's compile-time string-constant key by resolving its
   NaN-boxed offset against the module's own data segment (the interned-
   string table: `[hash:4][len:4][chars…]` per entry, confirmed by
   decoding a known site — `ctx.module.moduleInits`, offset 3900 — before
   trusting any other decode). Two call sites decode to key **"forEach"**
   (offsets 0x388/904 in the data blob), matching db16685e's own "the
   FAULTING call... looks up 'forEach'" finding exactly, and matching this
   session's own repro run byte-for-byte.
2. Source audit: `foldStaticConstAggregates` (`src/compile/plan/
   literals.js:815`) has exactly ONE `.forEach` call reachable before its
   own early return (`if (!arr.size && !obj.size) return false`, line
   881) — `moduleStmts.forEach((s, i) => pos.set(s, i))` at line 854. This
   RESOLVES OPEN CONTRADICTION #1: the early return does not fire
   "immediately" in the sense the predecessor assumed — 36 lines of
   unconditional classification prologue (817–854: build `seqs`,
   `moduleStmts` via `.flatMap`, `funcs` via `.filter`, `pos` via
   `.forEach`) run first, and it is a call INSIDE that prologue, not
   inside the folding logic proper, that faults. No symbolication bug, no
   early-return misfire — the crash is upstream of the early return, in
   code that always runs regardless of its eventual outcome.
3. Backward local-def trace confirmed this precisely at the instruction
   level. The receiver local (compiler-generated temp, register-reused
   ~96 times across the function by O3's allocator — every jz-generated
   local carries the reserved U+E000 prefix, invisible in a terminal,
   which is why a naive `grep '\$7'` finds nothing; decode via the actual
   UTF-8 bytes) is set, immediately dominating the forEach call site, by
   `(local.set $T7 (call $__arr_flat (...)))` at WAT line 3897454 — i.e.
   **the receiver IS `moduleStmts`, the direct, freshly-computed result of
   `seqs.flatMap(moduleStmtsOf)` (source line 818), set microseconds
   before its own `.forEach` use, entirely WITHIN `foldStaticConstAggregates`'s
   own currently-executing call.** This load happens a whole COMPILE PHASE
   after front()'s one-shot `region_exit` (confirmed by db16685e's own
   `$__dbgExitCount=1`) — there is no region-boundary crossing anywhere
   near this local's lifetime at all.

**This overturns the whole "root-completeness" / "live-across-exit-local"
framing the FOURTH-mechanism → db16685e → 17e7701e sub-chain converged
on.** The receiver is not stale, not unrooted, and not carried across
`region_exit` in any local — it is a brand-new array, correctly built,
microseconds old. The actual defect is elsewhere: `__dyn_get_t_h`'s ARRAY
branch (`module/collection.js`) unconditionally reads the word at
`$off-16` as a candidate dyn-props sidecar pointer for EVERY array,
because the canonical array layout (`__alloc_hdr`, `module/core.js`)
always reserves and zeroes it (16-byte header: propsPtr@-16, len@-8,
cap@-4). **`__arr_flat` (`module/array.js:2519`, backing `.flat()`/
`.flatMap()`) allocated only an 8-byte header** (`call $__alloc (8 +
total*8)`, then `dst += 8`) — one word short of the convention, so its
`$off-16` slot was never this array's own memory at all: it aliased
whatever byte range preceded the allocation in the bump arena. Verified
`total=0` is not required for the bug (the defect is the header SIZE,
independent of element count) but is consistent with this exact repro:
the exported arrow `f` is fully hoisted into `ctx.func.list` by `defFunc`,
so `ast` (the module top level) reduces to an effectively-empty `;`-seq,
`moduleStmtsOf(ast)` returns a near-empty array, and `__arr_flat`'s
`$total` pass produces the degenerate `len=0,cap=0` header predecessor
sessions observed directly — not a corrupted/reclaimed structure, just a
genuinely tiny one with a missing word.

**Why region-live only, resolving the session's own open question.** Fresh
WASM linear memory is zero-initialized. In DORMANT mode `__arr_flat`'s
allocations land in address ranges the bump allocator has NEVER touched
before (monotonic forward allocation only) — the stolen `$off-16` word
reads as zero by sheer luck of virgin memory, which `__dyn_get_t_h`
correctly treats as "no props." Under region-arena, `__region_exit`
COMPACTS the arena (moves the bump top backward, `mark`+`delta`), so
POST-exit allocation — including every `__arr_flat` call anywhere in
`compileAst`, which runs entirely after front()'s one round — reuses
address ranges that already held real data from earlier in the SAME
compile. The stolen word can then alias real leftover bytes, which for
this exact repro happen to decode as a plausible `PTR.HASH` pointer to
`__region_exit`'s own freshly-relocated `$__dyn_props` table (matching
ba0b5f6d's own raw-memory finding exactly) — coincidence of bit pattern,
not a deliberate write, matching every predecessor session's own "zero
referrers" reverse-scan result (nothing ever wrote this word; it was never
initialized in the first place). This also explains the heisenbug: ANY
JS-source edit to the compiler's own pipeline shifts allocation offsets,
changing what bytes happen to sit in the stolen window, changing whether
it happens to decode as a HASH tag or not.

**Open contradiction #2 (alternate encodings the reverse scan couldn't
see) — resolved, not by finding a hidden write, but by finding there was
never a write to find.** The "different encoding" the task anticipated is
simply: uninitialized memory, never tagged as anything by design, read
through a slot that should have been reserved-and-zeroed but wasn't.

**Open contradiction #3 (`src/prepare/index.js:709-723`'s "closure
reachable only indirectly through RESET_HOOKS" crash) — NOT the same
mechanism, on the evidence available.** That crash was attributed to a
closure/RESET_HOOKS interaction, not to a hand-rolled array allocator; no
`.flat`/`.flatMap`/`.split`/`.matchAll` call is implicated in its own
description. Flagging it as unresolved rather than force-fitting this
session's finding onto it — a genuine "same underlying class" claim would
need its own instruction-level trace, not an inference from shape alone.

**Fix — allocator-level, general, not a region-boundary special case.**
Every hand-rolled `(i32.const 8)+N*8`-shaped raw `$__alloc` call feeding a
`PTR.ARRAY`-tagged result is the same defect class: it must reserve and
zero the propsPtr word `__dyn_get_t_h`/`__dyn_set` unconditionally expect.
Routed the three HIGH-CONFIDENCE, exact-size sites (no incremental growth,
so a straight `__alloc_hdr(len,cap)` swap is a mechanical, low-risk fix)
through the canonical allocator instead of hand-duplicating (and
under-sizing) its own invariant:
- `module/array.js`'s `__arr_flat` (backs `.flat()`/`.flatMap()`) — the
  session's own confirmed culprit.
- `module/string.js`'s `__str_split` (backs plain-string `.split()`,
  extremely high-traffic) — all three of its allocation sites (limit=0,
  empty-separator, general case) had the identical shape.
- `module/regex.js`'s `.matchAll`/`.string:matchAll` builder
  (`matchAllImpl`) — same exact-size shape.
Each now calls `$__alloc_hdr($len, $cap)` (or the `allocPtr`-equivalent IR
form) instead of hand-writing the header. `module/array.js`'s `deps()` map
and `module/string.js`'s `__str_split` dep entry updated (`__alloc_hdr`
replacing the now-unused direct `__alloc`) per this codebase's own
self-host-safe-declaration discipline (auto-scan isn't trusted for
self-hosted builds — see `test/selfhost-includes.js`).

**NOT fixed this session, same defect class, flagged for a follow-up:**
`module/regex.js`'s GROWABLE regex-`.split()` builder (`__regex_split_*`,
three sites: initial alloc + two grow-doubling reallocs) has the identical
8-byte-header shape but couldn't be mechanically swapped to
`__alloc_hdr(len,cap)` — it grows incrementally (`cap` known, final
`count` only known at the end) and needed its own dedicated verification
pass this session's budget didn't reach. Left unfixed and unregressed
(pre-existing behavior, byte-for-byte unchanged); named explicitly so the
next session doesn't have to re-derive it.

**Gates.**
- **Repro 3/3: GREEN.** Rebuilt the named region-live kernel with the fix
  landed (WAT text, 290.7 MB); reassembled via `watr/parse`+`watr/compile`
  (~90s) and ran the 5-condition minimal repro through the kernel's own
  `default` export (mirrors `test/kernel-target.js`'s `compileViaKernel`
  recipe) 3 times: `rep 0/1/2: OK, wasm bytes = 506` — zero traps, was
  100% reproducing 3/3 before the fix.
- **Native regression suite (array-methods.js, jsstring.js, strings.js,
  regex.js): GREEN**, 256 tests / 806 assertions, run BEFORE the
  self-hosted rebuild to isolate the fix from any self-host confound.
  Also hand-verified semantic correctness (not just "compiles") for
  `.flat()`, `.split()` (all three code shapes), `.matchAll()` against
  their JS values natively at O2.
- **Region oracle (kernel-oracle.js, region-live `dist/jz.wasm`, 3
  reps): 9/13, UNCHANGED from every predecessor session's own baseline —
  NOT the task's hoped-for 10/13+, reported honestly rather than
  papered over.** All 4 failures are pre-existing and independent of the
  FOURTH mechanism: 3 assertions (O0/O2/O3) are ALL the SAME single row,
  `"array-growth-class: sibling push()+indexed-append tables (envMeta
  shape)"` — its own in-file comment names a DIFFERENT, already-
  root-caused mechanism (`useRuntimeKeyDispatch`'s hand-rolled 2-fork
  skipping `__arr_grow`/the length-header bump for unproven ARRAY
  receivers on 2+-level property chains) that is unrelated to allocator
  header sizing — `.push()`/indexed-append both already route through
  `__alloc_hdr` via `allocPtr`, so this session's fix class does not
  apply to it. The 4th is the pre-existing, separately-tracked
  "PENDING-FIX — generic-scalar-decl BOOL∪NUMBER carrier collapse"
  (audit-#16-adjacent, documented in-file, unrelated to region-arena).
  **Confirmed this row is region-live-SPECIFIC, not a regression from
  this fix**: re-ran kernel-oracle against a freshly-built DORMANT
  `dist/jz.wasm` (`REGION_HOOKS_ACTIVE=false`) — **13/13 clean**, 541
  assertions, proving both that (a) this session's fix introduces no
  native/dormant regression and (b) the still-failing envMeta-shape row
  is a genuinely separate, still-open region-live wall, named here for
  whoever picks it up next (NOT this session's assigned mechanism).
- **kernel-parity (O0/O2/O3, region-live): 11/11 rows, byte-identical,
  GREEN** (both before touching kernel-oracle and again in dormant mode:
  3/3 pass).
- **jessie/watr/jzify-entry region-live ×3: GREEN.** Compiled all three
  real-world graphs (`resolveModuleGraph(entry, {resolveNode:true})`,
  `bench/jessie/jessie.js`, `bench/watr/watr.js`, `.work/jzify-entry.mjs`
  — recreated from the main repo's own copy, absent in a fresh worktree)
  through the region-live `dist/jz.wasm` 3 times each: jessie 106,974 B,
  watr 315,336 B, jzify-entry 611,990 B — byte-identical across all 3
  reps, every graph, zero traps.
- **Dormant byte-identity — REFRAMED, not literally applicable, explained
  rather than skipped.** The task's own framing (`REGION_HOOKS_ACTIVE=false`
  build byte-identical) assumes a front-boundary-shaped fix, which this
  is NOT: the fix is a stdlib allocator correctness fix
  (`__arr_flat`/`__str_split`/`matchAll`), unconditional on
  `REGION_HOOKS_ACTIVE`, so it changes `.flat()`/`.split()`/`.matchAll()`
  codegen in BOTH configurations — correctly, since the missing-header
  defect was equally present (silently masked) in dormant mode. A dormant
  build post-fix is therefore expected to differ from a pre-fix dormant
  build, not match it. What WAS verified: the dormant build succeeds
  cleanly (16,692.7 kB), is internally consistent, and scores 13/13 on
  kernel-oracle / 3/3 on kernel-parity — the actually-meaningful
  regression check.
- **Self-build ×2: GREEN.** Built region-live `dist/jz.wasm` twice,
  independently, from a clean `dist/`: SHA-256
  `9227af7d66dc2092f5def597e67c90e7cb402c3fd74d0a267d85bb90feef1cc9` both
  times — fully deterministic.

**Verdict — NOT "FRONT BOUNDARY SOUND."** The front boundary itself was
already proven sound by db16685e/17e7701e (root-completeness, destructuring
rebind) and remains untouched this session — there was never a front-
boundary bug in this mechanism to begin with. The FOURTH mechanism itself
is CLOSED: root-caused to an instruction-level provenance chain, fixed at
the allocator level, repro green, no regressions found anywhere this
session looked (native suite, kernel-parity, kernel-oracle dormant,
jessie/watr/jzify-entry, self-build determinism). kernel-oracle's
region-live tally stays at 9/13 because the 4 remaining failures are
independently-diagnosed, pre-existing, unrelated mechanisms — named
explicitly above for whoever picks each one up, not silently left
ambiguous.

**Disposition.** Landed fix: `module/array.js`, `module/regex.js`,
`module/string.js` (3 files, +33/-24 lines). Every instrumentation/harness
artifact this session produced (`.work/build-region-wat.mjs`,
`.work/run-repro.mjs`, `.work/run-graphs.mjs`, `.work/jzify-entry.mjs`,
kernel WAT/WASM builds, `dist/*`) was deleted at session end;
`scripts/self.js`'s `REGION_HOOKS_ACTIVE` restored to `false`; `git
status`/`git diff --stat` in the worktree show only the 3 named files
plus this ledger entry.

**SHAs.** jz worktree: `17e7701e` base, this session's fix committed on
top (see commit log). Main repo: unchanged by this session (region branch,
not main). watr: `895ca5b` (`/Users/div/projects/watr`, unpublished,
unchanged, reconfirmed pristine 5.7.14 before and after). `dist/jz.wasm`
not retained (region-live build SHA `9227af7d...eef1cc9` and dormant build

## §Region arena — HEADER-MATERIALIZATION CLASS ERADICATED: full runtime
audit, 5 more instances found+fixed beyond the one named remaining site,
complete site inventory recorded; oracle re-triaged, STAYS 9/13 (Part 1's
sweep does not touch the 2 remaining mechanisms — confirmed by direct
compiler-internal-trap evidence, not inference) (2026-08-13)

**Task.** Part 1 of a 3-part campaign session: (a) fix the ONE KNOWN
remaining header-materialization instance 41024dd6 named but didn't reach —
`module/regex.js`'s growable regex `.split()` builder — through the
canonical allocator; (b) AUDIT every `module/*.js` + WAT-template-emitting
`src/*.js` site that materializes an ARRAY/OBJECT/TYPED/SET/MAP/HASH header
by hand instead of calling `__alloc_hdr`/`__alloc_hdr_n`, fixing every real
instance and documenting every proven-clean site; (c) re-run the region
oracle and re-triage before Part 2, since the same class could plausibly
explain some of the 4 standing failures.

**Setup.** Fresh `git worktree add` off `41024dd6` (region-final-2026-08-11
HEAD). `node_modules` individually symlinked (`@esbuild`, `esbuild`,
`sprae`, `subscript`, `tst` → the main repo's copies; `watr` →
`/Users/div/projects/watr` directly — `895ca5b`/5.7.14, reconfirmed
identical before AND after this session, only its own pre-existing
untracked `watr` dir entry in that repo's own `git status`, unrelated).

**Classification key (established once, applied to every site below).**
`module/collection.js`'s own `hasPropsSidecarWat` comment (line ~2395) is
the authoritative source: `__dyn_get_t_h`/`__dyn_set` read/write the
propsPtr word at `off-16` ONLY for **ARRAY, OBJECT, TYPED, SET, MAP**
(HASH is its own storage, no sidecar, exempted by its own dedicated arm).
Every OTHER tag (STRING, CLOSURE, ATOM, BUFFER, REGEX, DATE, EXTERNAL,
BIGINT) has NO such slot and NEVER reads off-16 — confirmed by reading
`__dyn_get_t_h`'s own STRING early-return (line ~2544: STRING receivers
return `UNDEF_NAN` before the type ever reaches the off-16 read). A raw
`$__alloc` call is only an instance of this defect class if its result is
`$__mkptr`'d with one of the five propsPtr-bearing tags AND its header is
shorter than 16 bytes / omits the propsPtr word.

**Fixed (7 NEW sites beyond the one already-known one — 8 total, 5
files).**
1. `module/regex.js` — growable regex `.split()` builder
   (`__regex_split_${id}`, backs `str.split(/re/)`) — the session's primary
   assignment. Hand-rolled 8-byte header + two grow-doublings, identical
   shape to the pre-fix `__arr_flat`. Routed the initial alloc AND both
   grow-doubling reallocs through `__alloc_hdr`; the intermediate array is
   purely function-local until the final `mkptr` (nothing else can alias it
   mid-construction), so — unlike `__arr_grow` — no forwarding-header/
   dyn-props-sidecar preservation is needed across the copy, just a plain
   `memory.copy`. Verified: 103/103 native regex tests; hand-run 8/9/20-
   piece splits (0/1/2 grow-doublings) byte-for-byte against native JS
   `.split()`; dyn-prop set+read on both a no-grow and a two-grow result.
2. `module/regex.js` — `buildMatchArr` (the `.match()`/`.exec()` result
   array, also feeds `.groups` via `$__dyn_set` when named capture groups
   are present) — a SECOND, independently-found instance, exact-size (no
   growth needed, mechanical `__alloc_hdr(N,N)` swap). The MOST direct
   possible consumer of this defect class: a named-group match literally
   dyn-sets onto the array the same statement it's built in. Verified:
   103/103 regex tests; `"2026-08-13".match(/(?<year>...)/)` decoding
   correctly with a 10-element unrelated array allocated immediately
   before it (heap-neighbor pressure); a second dyn-prop set on top of
   `.groups` itself.
3. `module/json.js` — `__jp_arr` (the runtime `JSON.parse` array builder,
   grow-doubling, previously undocumented as an instance — NOT named in
   41024dd6). Same shape and same fix as regex's split builder. Verified:
   67/67 native JSON tests; a 20-element runtime-only JSON array (opaque
   `String.fromCharCode`-built source, defeats const-fold AND shape-parse)
   forcing two grow-doublings, plus a dyn-prop set on the result.
4. `module/json.js` — the compile-time SHAPE-parser's `parseArray` closure
   (`emitJsonShapeParser`'s per-shape generated parser, backs
   `JSON.parse(stableLetSource)` when the source resolves to one of a
   small set of literal shapes at compile time) — a FOURTH, independently-
   found instance, identical grow-doubling shape. Verified via the exact
   trigger test/json.js's own tests use (`let SRC = '...'; JSON.parse(SRC)`
   — a stable-`let`, non-const source), confirmed the shape fast path
   fired (`$__dyn_get` absent from `$g`'s own compiled body, matching
   test/json.js's own established methodology) with a 20-element nested
   array + a dyn-prop set on it.
5. `module/typedarray.js` — `genSimdMap` (the SIMD-fused `.map()` result
   builder for `Int32Array`/`Float64Array`/etc. — `.typed:map`'s fast
   path) — hand-rolled 8-byte header (byteLen stored at BOTH offset-0 and
   offset-4, i.e. len=cap=byteLen, matching `__alloc_hdr_n`'s own
   convention exactly) storing a `PTR.TYPED` result; TYPED IS in the
   propsPtr set. Routed through `__alloc_hdr_n(byteLen, byteLen, 1)` —
   the SAME stride=1/len=cap=byteLen shape `__typed_slice_rt` (already
   correct, unmodified) establishes as canonical for TYPED results.
   Verified: 58/58 native buffer tests; `Int32Array.map(x=>x*2)` /
   `Float64Array.map(x=>x+1)` value-correct against native JS, PLUS a
   dyn-prop set on the SIMD-mapped result (the actual defect).
6. `module/string.js` — `__b64_from` (`Uint8Array.fromBase64`) — hand-
   rolled 8-byte header producing `PTR.TYPED`. Genuinely different fix
   shape from the others: the real decoded length is only known AFTER
   `__b64_dec_raw` runs (unlike every `__alloc_hdr(len,cap)` call site
   elsewhere, where at least an upper bound resolves BEFORE the header is
   needed), so `__alloc_hdr` itself can't be called — reserved 16 header
   bytes + the decode upper-bound scratch up front (`__alloc(16+max)`,
   `i64.store` propsPtr=0 explicitly), decoded into `base+16`, then
   patched len/cap in after decoding. Verified against
   `Buffer.from(...,'base64').toString()` plus a dyn-prop set.
7. `module/string.js` — `__hex_from` (`Uint8Array.fromHex`) — same defect,
   same fix shape as `__b64_from` (real length known post-decode only).
   Verified against `Buffer.from(...,'hex').toString()` plus a dyn-prop
   set.
8. `src/compile/emit.js` — the multi-return-value closure trampoline
   (`.sig.results.length > 1` branch, packs N WASM-multi-value returns
   into a real JS-visible array when the function is referenced AS A
   VALUE and called through `call_indirect`'s uniform ABI) — hand-rolled
   `(n*8+8)`-byte header producing `PTR.ARRAY`. Exact-size, mechanical
   `__alloc_hdr(n,n)` swap; dropped the now-fully-unused `'__alloc'` dep,
   made `'__alloc_hdr'` unconditional (was gated on `restIdx>=0`, but the
   multi-return branch needs it regardless of rest-param presence).
   Verified: 9/9 multi-return + 110/110 closures native tests; confirmed
   via a temporary breadcrumb (reverted) that a genuinely call_indirect'd,
   2-arity-selected multi-return closure DOES reach this exact branch
   (`results 2`); value-correct across both selected functions plus a
   dyn-prop set on the packed result (default O2 inlines the tiny
   trampoline into its single call site, so the named function itself
   doesn't survive in the final WAT text — behavior + the direct
   `console.error` breadcrumb are the evidence, not a WAT `grep`).

**Proven CLEAN — not instances (with reason).**
- `module/typedarray.js` `__subarray`/the `new T(buf,off,len)`
  constructor/`new DataView(...)`/structuredClone's TYPED-view rebuild arm
  (4 `__alloc(16)` sites) — a TYPED **view** is a deliberately DIFFERENT
  16-byte shape, `[byteLen][dataOff][rootOff][pad]` (explicitly documented
  at the DataView constructor), not an `__alloc_hdr` header at all; calling
  `__alloc_hdr` here would be WRONG (wrong field semantics entirely).
- `module/collection.js`'s `__alloc_hash_eph` — hand-INLINED but CORRECT:
  writes `i64.store ptr 0` (propsPtr, zeroed) then len@8/cap@12 explicitly
  — the full 16-byte header, just skipping `__alloc_hdr_n`'s `memory.fill`
  of the (for a fresh ephemeral hash) provably-unreachable entry bytes. A
  deliberate, documented perf specialization, not a truncated header.
- `module/console.js`, `module/fs.js`, `module/crypto.js`,
  `module/number.js`, `module/math.js`, `module/date.js`,
  `module/timer.js` — grepped for every `mkptr`+propsPtr-tag pairing:
  ZERO matches in any of these 7 files. Every `$__alloc` call in them
  produces PTR.STRING/PTR.BUFFER results or pure internal scratch (WASI
  iovecs, hash digest buffers, number-formatting buffers) — never a
  propsPtr-bearing tag.
- `module/string.js`'s remaining ~20 `$__alloc` sites — all PTR.STRING
  (STRING is explicitly NOT in the propsPtr set per the classification
  key above).
- `module/function.js`'s closure-env-array alloc (`__alloc(envCaptures.
  length*8)`) — PTR.CLOSURE-tagged; CLOSURE is not in the propsPtr set,
  and env arrays have no len/cap header at all (indexed purely by
  compile-time-known offsets in generated code).
- `module/core.js`'s `__region_relocate_cell`'s own `__alloc(8)` (a raw
  region-arena boxed-cell mirror) and `__coll_order`'s scratch slot-offset
  buffer (`__alloc(shl(header_len,2))`) — neither is ever `mkptr`-wrapped;
  both are pure internal bookkeeping, never a JS-visible value.
- `src/compile/emit.js`'s string-concat/template-literal builder
  (`totalIR()`-sized `__alloc`) — produces PTR.STRING with the correct
  8-byte `[hash][len]` STRING header (not the 16-byte ARRAY/OBJECT
  shape) — proven by its own `mkPtrIR(PTR.STRING, ...)` call site.
- The "boxed cell" `__alloc(8)` pattern (closure-captured mutable `let`
  storage) — `src/compile/emit.js` (3 sites), `src/compile/index.js`
  (5 sites), `src/ir.js` (1 site), `module/core.js`'s cell-relocation
  site above, `module/function.js`'s per-capture cell store — NEVER
  `mkptr`-wrapped at all; the raw i32 address is used directly as an
  `f64.store`/`f64.load` target by compiler-generated code, entirely
  outside the NaN-boxed-pointer/dyn-dispatch machinery.
- `src/wat/assemble.js`'s `$__schema_tbl`/`$__strBase`/
  `$__closure_env_len`/`$__closure_env_mask`/`$__gsnap_base` allocations —
  all raw internal tables/pools referenced via dedicated globals, never
  `mkptr`-wrapped (the schema table's OWN per-schema key ARRAYS, stored
  INSIDE it, already correctly use `__alloc_hdr` — confirmed unchanged).
- `src/optimize/index.js`'s `$__alloc` references — string literals in
  optimizer analysis code (detecting whether a function body CONTAINS an
  allocation call), not an allocation site itself.
- `module/object.js` — audited, already exclusively `__alloc_hdr`/
  `__alloc_hdr_n`, zero raw `$__alloc` sites.
- `module/array.js` — audited (the `.push()`/indexed-append/`__arr_grow`
  family), already exclusively `__alloc_hdr`, zero raw `$__alloc` sites.

**Bonus finding — NOT fixed, out of scope, named for a future session.**
Setting a dynamic property on a **TypedArray VIEW** (`.subarray()`
result, `new T(buf,off,len)`, `new DataView(...)`) traps `memory access
out of bounds` — reproduced NATIVELY, dormant mode, ZERO region-arena
involvement (`let v=new Int32Array([1..6]).subarray(1,4); v.tag='hi'`).
Root cause (by inspection, not instrumented further): `__dyn_get_t_h`/
`__dyn_set` include PTR.TYPED in `hasPropsSidecarWat` unconditionally,
but a VIEW's pointer offset is the `[byteLen][dataOff][rootOff][pad]`
descriptor's OWN address, not an `__alloc_hdr`-shaped buffer — reading
`off-16` for a view walks into whatever memory precedes that (correctly
16-byte, by design) descriptor. Pre-existing, NOT region-arena-specific
(so it does not explain any of the 4 oracle failures below), genuinely
architectural (`__dyn_get_t_h ` would need to gate on the view bit, not
just the TYPED tag) — flagged, not attempted, per this session's charter
(header-materialization only).

**Gates (region-live unless noted).**
- Native full suite (`node test/index.js`): **3428/3436 pass, 6 skip** —
  the SAME 2 pre-existing documented flakes (`interval walk`, `typed
  RMW`), 0 new. Self-hosted (`JZ_TEST_TARGET=jz.wasm`): **2725/2731 pass,
  0 fail, 6 skip** — byte-for-byte the historical baseline.
- Touched-module native suites individually: regex 103/103, json 67/67,
  buffer 58/58, jsstring 10/10, strings 153/153, multi-return 9/9,
  closures 110/110, webglobals 26/26, array-methods 127/128 (1
  pre-existing skip) — all green.
- **Region oracle: 9/13 pass (203 assertions in the 9 passing groups),
  UNCHANGED, ×3 reps, byte-for-byte the same 4 failing test() blocks as
  41024dd6's own baseline** (3× "native+kernel agree with JS at
  O0/O2/O3" + the PENDING-FIX carrier-collapse row). Part 1's sweep does
  NOT touch either standing mechanism — see the next entry for why,
  established by direct trap evidence, not by assumption.
- **Region oracle dormant: 13/13 pass (541 assertions).**
- kernel-parity region-live: **3/3 (33/33) byte-identical.** Dormant:
  **3/3 (33/33) byte-identical.**
- jessie/watr/jzify-entry region-live ×3 reps: **all clean, deterministic,
  zero traps** — jessie 106,974 B (byte-identical to 41024dd6's own
  recorded size — Part 1 doesn't touch anything jessie's own corpus
  exercises), watr 315,200 B, jzify-entry 611,971 B (both a few hundred
  bytes off 41024dd6's own recorded sizes — legitimate: Part 1's fixes
  change codegen shape for `.split()`/`JSON.parse()`/`.map()` on
  TypedArrays/`fromBase64`/`fromHex`/multi-return-as-value, all of which
  watr's own self-hosted WAT parser and/or jzify's own AST-walking code
  plausibly touches).
- Self-build ×2 SHA-converges: region-live SHA-256
  `b807a0350c48ad2afeb55b58b889e5c4ab16aaa44e51f1e1a9e63f21e27749ce`
  identical across 2 independent builds. Dormant SHA-256
  reconfirmed internally consistent (16,677.7 kB both builds).
- Dormant byte-identity — same reframe 41024dd6 already established:
  these are stdlib allocator fixes, unconditional on
  `REGION_HOOKS_ACTIVE`, so dormant OUTPUT legitimately changes
  (`.split()`/`JSON.parse()`/etc. codegen shape differs pre/post-fix in
  BOTH configurations). What's verified instead: dormant kernel-oracle
  13/13, dormant kernel-parity 3/3, dormant native suite at the
  established baseline — all green, zero regressions.

**Disposition.** Landed: `module/regex.js`, `module/json.js`,
`module/string.js`, `module/typedarray.js`, `src/compile/emit.js` (5
files). `scripts/self.js`'s `REGION_HOOKS_ACTIVE` restored to `false`
(worktree-only flips, reverted). All instrumentation/harness scripts this
session produced (`.work/build-region-wat.mjs`, `.work/run-repro.mjs`,
`.work/run-graphs.mjs`, `.work/jzify-entry.mjs`, ad hoc `.work/*-check.mjs`
verification scripts, the 276.7 MB named kernel WAT, `dist/*`) deleted at
session end. `git status`/`git diff --stat` show only the 5 named files
plus this ledger entry.

## §Region arena — 4 REMAINING ORACLE ROWS RE-TRIAGED: BOTH failing
mechanisms crash the SELF-HOSTED KERNEL DURING COMPILATION (not the
compiled program's own execution) — new evidence the PENDING-FIX carrier-
collapse row REGRESSED from a stable wrong-VALUE to an actual TRAP under
region-arena; root cause NOT found for either, walls re-banked with
narrower, more precise evidence than either predecessor left (2026-08-13)

**Task.** Part 2: attack kernel-oracle's 4 standing region-live failures
(unchanged by Part 1, confirmed above) one at a time, WAT/binary-level
instrumentation only, per the campaign's established method. First locate
each row's own prior diagnosis in the ledger.

**The 4 failures are 2 distinct mechanisms, not 4** (consistent with
every predecessor session's own count): 3 assertions (O0/O2/O3) are the
SAME single AGREE-tier row, `array-growth-class: sibling push()+
indexed-append tables (envMeta shape)`
(test/kernel-oracle.js:327-341); the 4th is the separate
`PENDING-FIX — generic-scalar-decl BOOL∪NUMBER carrier collapse` row
(test/kernel-oracle.js:655-684, `captured-then-read`).

**Prior diagnosis, row 1 (envMeta shape) — TWO CONFLICTING claims found
in the ledger, resolved by direct re-instrumentation, not by picking
one.** 41024dd6's own entry attributes this row to test/kernel-oracle.js's
own in-file comment (line ~303: `useRuntimeKeyDispatch`'s hand-rolled
2-fork skipping `__arr_grow`/the length-header bump for unproven ARRAY
receivers on 2+-level property chains) — "unrelated to allocator header
sizing... this session's fix class does not apply to it." But that
in-file comment (test/kernel-oracle.js:295-317) is actually about the
IMMEDIATELY PRECEDING row (`array-growth-class: arr[arr.length]=x through
a 2-level property chain`, line 318-320) — a DIFFERENT AGREE-tier entry,
already fixed (its own comment: "native and kernel agree POST-fix"), one
array-literal position earlier in the same source array. The comment
directly above row 327 itself (line 321-326) says something narrower and
more tentative: row 327 is merely "the CLOSEST ANALOG to the real
bba45c0d shape," speculating it's "the useRuntimeKeyDispatch fork on BOTH
the receiver and the key" — a hypothesis, not a confirmed root cause. The
63a5551e session (before 41024dd6) actually TESTED this hypothesis via
black-box bisection and REFUTED it directly: removing ALL array growth
from the minimal failing repro (two bare `.push()` calls matching
`ctx.closure.mint`'s real shape, then a zero-array-involvement closure
capturing a bare OBJECT or STRING) still crashed identically — "No
`__arr_grow` call exists anywhere in the minimal failing case." 41024dd6's
"unrelated to allocator header sizing, does not apply" conclusion is
correct in outcome but cites the WRONG comment as its source — the actual
prior diagnosis (63a5551e, still unrefuted) is: **a called arrow-function
closure capturing a free variable not reducible to a compile-time
constant, crash site upstream of `ctx.closure.make`, unnamed "FOURTH,
still-unfound front-boundary mechanism"** (a different FOURTH than the
one this campaign's 41024dd6 session closed — the numbering collided
across sessions; 63a5551e's own FOURTH is NOT 41024dd6's FOURTH).

**Prior diagnosis, row 2 (PENDING-FIX carrier collapse) — established as
region-agnostic, NOW CONTRADICTED by this session's own reproduction.**
The 63a5551e session's own final characterization table (research.md,
"Oracle characterization table (final, this session)") records this row
as `pass (tripwire, asserts the still-wrong value) | pass (same) |
pre-existing-unrelated ... unaffected by region-liveness either way`.
That was true AT THAT TIME. Re-run this session against the region-live
build (Part 1's fixes applied, ×3 reps): **it now fails with `memory
access out of bounds`, not a wrong-value tripwire mismatch** — the exact
same trap signature as row 1. This is a genuine finding, not a
Part-1-fix artifact: dormant kernel-oracle stays 13/13 (the row still
passes its tripwire dormant), and Part 1's own fixes don't touch
`emit.js`'s `emitDecl`/carrier-boxing machinery at all (the 5 touched
files are regex/json/string/typedarray allocator sites + the multi-return
trampoline). The likely explanation, NOT instrumented further this
session: intervening carrier-collapse-adjacent commits on this branch
(`90e10c3d` "fix Number.isNaN carrier miscompile", `756ae10f` "formatter
carrier-dispatch: box ambiguous BOOL∪NUMBER merges…", both landed AFTER
63a5551e's own session, per this worktree's own `git log`) changed this
row's compiled SHAPE enough to newly trip a region-arena mechanism that
didn't reach it before — consistent with 41024dd6's own account of this
whole defect class as heisenbug-sensitive to exact allocation offsets.

**This session's own re-instrumentation (both rows, same method).** Built
a NAMED region-live kernel as WAT text (`compile(profile.graph.code,
{modules, memory, optimize} = resolveSelfhostBuild(), wat:true,
names:true)`, `REGION_HOOKS_ACTIVE` hand-flipped `true`, worktree-only,
reverted at session end — 276.7 MB, `regionArenaLive:true`, matching
every predecessor session's own build shape). Reassembled via
`watr/compile` + `interop.js`'s `instantiate`, then called the kernel's
own `default` export (`compileSelf(code, strict, optJSON, modulesJSON,
hostJSON)`, exactly `test/kernel-target.js`'s own `compileViaKernel`
recipe) directly on both rows' exact source strings.

**Result: BOTH rows crash INSIDE THE KERNEL'S OWN COMPILATION CALL — the
exception is thrown by `self.exports.default(...)` itself, before any
compiled bytes exist to instantiate or run.** This is a materially more
precise finding than either predecessor session recorded explicitly (both
inferred "upstream of ctx.closure.make" from breadcrumb non-firing, but
neither stated outright "the KERNEL's own compilation crashes, this isn't
a bug in the OUTPUT program at all" as the very first, cheapest
observation). Stack traces (Chrome/V8, `RuntimeError: memory access out
of bounds`):
- Row 1 (envMeta shape): innermost frame `wasm-function[3758]` — the
  SAME raw function index the 63a5551e session's own decompile named
  "`closure4232`, a self-hosted compiler-internal closure" for this exact
  row, strong evidence Part 1's fixes did not shift this function's index
  (plausible: none of Part 1's 5 touched files are anywhere near the
  self-hosted compiler's own closure-plan/emit machinery this trap sits
  in).
- Row 2 (captured-then-read): innermost frame `wasm-function[819]` — a
  DIFFERENT index than row 1's, but the same failure MODE (both throw
  from inside `self.exports.default`, both `memory access out of
  bounds`, neither reaches a compiled-bytes result).

**Text-position-based function-index symbolication attempted, ABANDONED
as unreliable.** Tried mapping `wasm-function[N]` back to a source name by
counting `(func $name` occurrences in file order in the named WAT text.
Cross-checked against known-shape names near each index
(`m5_parse$unary` at 819, `tramp_m139_loops$splitCharScanLoops` at 3758)
— NEITHER resembles the closure/envMeta/carrier-collapse machinery either
row's own source would plausibly reach, meaning declaration-order-in-text
does NOT track the compiled binary's actual function-index space (watr's
own compile pass reorders/prunes) — this bisection method needs the SAME
decompile-the-exact-trap-frame-via-`wasm-objdump`-file-offset approach
the 63a5551e/6743aea0/0e73fa6a sessions each already used successfully,
not a cheaper regex substitute. NOT completed this session — named
explicitly as the correct next step, not skipped silently.

**Differential already established (no new work needed): CONFIRMED
region-live-specific for both rows.** Dormant kernel-oracle (13/13, ×1
this session, matching the fixed-build gate above) proves both rows
compile and run cleanly dormant — the trap requires
`REGION_HOOKS_ACTIVE`.

**Disposition — NO FIX LANDED for either row, walls re-banked with
narrower evidence, per protocol.** Every edit this session touching these
2 rows (`REGION_HOOKS_ACTIVE` toggle, the named-kernel build, the repro
harness) was worktree-only and reverted/deleted; `git diff --stat` in the
worktree shows nothing outstanding beyond the landed Part 1 files plus
this ledger entry. kernel-oracle region-live stays at **9/13** (unchanged
— this session characterized both rows more precisely, corrected one
mis-cited prior diagnosis, and surfaced one genuine NEW regression
(PENDING-FIX row: wrong-value → trap), but did not move the count).

**Recommendation for next session (both rows, one method).** Both rows'
traps are INSIDE the self-hosted kernel's own compilation of a small
program containing a closure over a non-provably-constant free variable —
continue 63a5551e's own last-named lead (never completed): breadcrumb
`ctx.scope`/`ctx.types`/`ctx.func`'s Set/Map-shaped fields' CONTENTS
immediately after `front()`'s own `region_exit` returns vs. immediately
before the closure literal is emitted, for the cheapest failing repro
(`let x=n; g=()=>x` traps in <100ms per 63a5551e's own timing) — THEN,
once a candidate write/read site is named, decompile the ACTUAL trap
frame via `wasm2wat --enable-all` + `wasm-objdump -d` cross-referenced
against the exact faulting file offset (NOT text-position counting — see
the abandoned attempt above) to get a reliable source-level name for
`wasm-function[3758]`/`wasm-function[819]`. Both rows sharing the same
"crashes inside kernel compilation, closure-over-non-constant-capture"
shape is suggestive they're the SAME mechanism, but this is NOT
confirmed — treat as two data points for one hypothesis, not one closed
finding, until an actual shared write/read site is named.

**Gates.** No source changed this session beyond Part 1's own 5 files
(already gated above) — this entry is characterization only, re-confirmed
via a fresh region-live build + fresh dormant build, both already
recorded in the Part 1 entry's own gate list. kernel-oracle: 9/13
region-live (×3 reps, this entry), 13/13 dormant (×1, this entry) — no
regression from Part 1, no new fix.

**SHAs.** jz worktree: `41024dd6` base, this session's Part 1 fix
committed on top (see commit log; Part 2 landed no source, only this
ledger entry). watr: `895ca5b`, reconfirmed unchanged. Region-live
`dist/jz.wasm` (this session, Part 2's own rebuild): SHA-256
`b807a0350c48ad2afeb55b58b889e5c4ab16aaa44e51f1e1a9e63f21e27749ce`
(reproduced identically across 2 independent builds — recorded in the
Part 1 entry). Dormant `dist/jz.wasm` (final worktree state): 16,677.7
kB, `REGION_HOOKS_ACTIVE` confirmed `false` in the committed
`scripts/self.js`.

## §Region arena — MILESTONE CHECK: NOT REGION FRONT COMPLETE, 9/13
region-live, Slice 3 NOT started (per standing directive) (2026-08-13)

**Per the campaign brief's own gate:** kernel-oracle region-live did not
reach 13/13 this session (stays 9/13, Part 1's sweep fixed a real and
substantial defect class — 8 sites across 5 files — but neither of the
2 standing mechanisms is in that class, confirmed by direct trap evidence
in the entry above, not assumption). **"REGION FRONT COMPLETE candidate"
is NOT declared.**

**What remains before that declaration is possible:** close the 2
standing mechanisms above (both now characterized as self-hosted-
kernel-internal-compilation traps, closure-over-non-constant-capture-
shaped, sharing a stack-trace failure mode but not yet proven to share a
root cause) — see the recommendation immediately above for the concrete
next instrumentation step.

**What remains for the MEMORY goal (Slice 3) once the front IS sound:**
per the 63a5551e session's own citation (and the "Slice 3 attempt" entry
it references), the emit/encode boundary root sketch is
`[module, ctx.func, ctx.transform, ctx.scope]` (8bed8c3f ledger entry).
**Slice 3 was NOT started this session** — per the standing discipline
this campaign has held since 63a5551e ("stacking a new region boundary on
a front boundary that corrupts real programs would compound an unsound
foundation, not extend one"), unchanged by this session because the front
itself is still not 13/13.
`3a5cdf13...909e66e` recorded above for reference, files deleted).

## §CompileSession re-audit remediation — P1/P2/P3 landed, P4 (larger) banked with a design sketch (2026-08-13)

Implements the re-audit's four accepted findings on `FunctionPlan`
(function-plan.js) / the active-function swap (active-function.js) /
`isInactiveFunction`, in the audit's own order, on top of `7b07a810`. `.work/
compile-session-func-survey.md`'s six-record decomposition (§CompileSession
above) and the whole `narrow.js`/`program-facts.js` FlowState-overlay program
(finding 4 of the ORIGINAL audit, a different numbering than this session's
four items) stayed untouched, as scoped.

**P1 — FunctionPlan LOGICAL deep-freeze LANDED.** `Object.freeze(plan)`
(function-plan.js's `createFunctionPlan`) only ever locked the outer record —
every Map/Set/rep-object field (`locals`, `boxed`, `cellTypes`, `localReps`,
…) stayed mutable, and under the self-hosted kernel `Object.freeze` is
identity, so nothing was ever actually protected there. Proxies and
getters/accessors are both off the table by construction (`op-policy.js`:
"jz objects have no accessors"; `session-views.js`/`ctx.js`: "no Proxy global
at all" — neither compiles through jz's own subset, and this file IS part of
the self-hosted kernel's module graph), so a facade-based freeze was never
viable here. Landed the SNAPSHOT-AND-COMPARE design the finding named as the
alternative: `publishFunctionPlan` takes an independent re-clone of the
just-published plan (reusing `createFunctionPlan` itself as the cloner — it
already builds fresh Map/Set/rep copies from any `facts`-shaped input, and
the plan qualifies) into a `WeakMap<plan, snapshot>`, gated entirely behind
`JZ_DEBUG_INVARIANTS`; `installFunctionPlan` — the one real consumption
gateway (`functionPlanOf` has exactly one caller, which flows straight into
`emitFunc`→`installFunctionPlan`) — structurally compares the live plan
against its snapshot field-by-field via a small recursive `planFieldsEqual`
(Map/Set/Array/plain-object/primitive; no Proxy, no freeze reliance, no
generics jz's subset doesn't have) and throws naming the first diverged
field. Zero-cost off: no snapshot taken, no compare loop, `installFunctionPlan`
executes exactly its pre-existing lines.

**P2 — typedElem/typedLen ambient leak LANDED, root cause not just the
missing restore line.** `installFunctionPlan` (function-plan.js:58-60 pre-
session) writes into ambient `ctx.types.typedElem`/`typedLen`; `emitClosureBody`
(compile/index.js) restored `typedElem` on exit but never `typedLen` — a
closure compiled with a statically-sized typed array left its own `typedLen`
Map on `ctx.types` for good. Repro'd exactly as the finding describes before
fixing: `compile('export let mk = (n) => { let f = () => { let buf = new
Float64Array(3); return buf[0] + buf.length }; return f() }')` then, post-
compile, `ctx.func.current === null` (session frame restored) while
`ctx.types.typedLen` still held `Map(1) { 'buff2_0' => 3 }` — confirmed this
reproduces identically on unmodified `7b07a810` and is silent (no test
caught it) before this session. The literal fix the finding proposed — move
`typedElem`/`typedLen` storage onto `ctx.func` — was rejected: those two
fields are read via `ctx.types.typedElem`/`typedLen` in 73 places across 9
files, including `src/compile/narrow.js`, which this session's scope
explicitly forbids touching. Landed the LIFECYCLE move instead of the
STORAGE move: `enterActiveFunction`/`restoreActiveFunction`
(compile/active-function.js) now stash `ctx.types.typedElem`/`typedLen` onto
the DISPLACED record's own (newly added) `typedElem`/`typedLen` fields at
swap time and restore them on the matching restore, the identical
identity-keyed discipline every other field on the record already gets — so
every one of the 73 read sites (`analyze.js`, `emit.js`, `narrow.js`,
`type.js`, `kind.js`, `session.js`, …) needed zero changes, and the three
existing manual save/restore call sites (`analyzeFuncForEmit`,
`installFunctionPlan`, `emitClosureBody`) collapse to explicit SEED-only
writes (install, same as `ctx.func.locals` already works) with the RESTORE
half now structural. `emitClosureBody`'s one redundant manual restore line
(`ctx.types.typedElem = prevTypedElems`, immediately superseded by
`restoreActiveFunction`) was deleted; its `prevTypedElems` local survives —
it is ALSO the fallback-seed value for closures with neither `cb.typedElems`
nor a module `globalTypedElem` (a real, load-bearing second use the removed
finally-line's presence had obscured). `ctx.types` gained a `typedLen: null`
default at `reset()` (it had none before — only ever created ad hoc on first
write) to match `typedElem`'s contract exactly. Regression test added
(`test/session-reentrancy.js`, "typedElem/typedLen ambient state does not
leak past a nested-closure compile") pins the exact repro above; verified
against unmodified `7b07a810` that it fails there and passes after the fix.

**P3 — isInactiveFunction strengthened LANDED.** The old predicate checked
only identity/body/module-scope/locals-shape/empty-stack. Added: overlays
(`localValTypesOverlay` empty, `localTypedElemsOverlay` null), refinements
(empty), prediction state (`p1Predicted` empty), try/finally state
(`inTry`/`finallyStack`), emission flags (`repsFrozen`/`boxedResult`/
`mixedAtomReturn` plus the expression-dispatch scopes `_expect`/
`_selfAccumConcat`/`_schemaSpecSlow`), and — P2's own fix — the ambient
`ctx.types.typedElem`/`typedLen` pair, exactly the field a leak like P2's
used to leave dirty at this checkpoint. Signature changed `frame` →
`ctx` (both call sites — `ctx.js`'s `assertCtxInvariants('post-compile')`
and the session-reentrancy test — updated) since the `ctx.types` class lives
outside the record proper. One candidate check was tried and DROPPED after
empirical falsification: `uniq === 0`. Two of the file's own pre-existing
tests hardcode `ctx.func.uniq === 0` for their specific minimal programs, which
reads as a general law until you compile something else — `'export let a =
() => { let xs = [1, 2]; return xs[0] }'` alone leaves `uniq` at 2 post-compile
(boundary-wrapper/DCE-adjacent synthesis legitimately mints names off the
session frame's own counter after every real function has restored it). Kept
out; documented at the check site so a future session doesn't re-add it from
the same false pattern-match.

**P4 — closure-body FunctionPlan publish-before-emit — BANKED, not
attempted.** Scope guard honored: P1-3 left real time/context, but P4 is a
structural refactor with genuine byte-identity risk across every closure-
bearing bench case, not a localized fix — attempting it inside this session's
remaining budget would have risked the hard-won P1-3 gates for an incomplete
result. Design sketch, call-graph-exact:

  - Today `emitClosureBody` (compile/index.js) is BOTH the analysis pass and
    the emitter for a closure body in one function: `reanalyzeBody`,
    `inferLocals`, `boxedCaptures`, `inheritPtrAliases`, `unboxablePtrs` (+
    their `updateRep` calls), `mintLoopPlans`, `mintClosureEnvPlans`, AND the
    IR construction (`bodyIR`, env/rest-param locals, `defaultParamInits`,
    final `fn` assembly) all run inside one call, entangled with `cb`'s own
    pre-seeded facts (`cb.intConsts`/`typedElems`/`boxed`/`cellI32`/…, minted
    earlier by `ctx.closure.make` in module/function.js at the closure
    LITERAL's own compile time, itself mid-emission of the ENCLOSING
    function). No `FunctionPlan` is ever published for a closure body —
    `publishFunctionPlan`/`installFunctionPlan` are never called on the
    `emitClosureBody` path at all.
  - The top-level mirror already exists and is the template: `analyzeFuncForEmit`
    (called from the `analyzeFuncs` loop, compile/index.js ~2361-2368, BEFORE
    `emitFuncs` ~2397-2398) computes the same `facts` shape and calls
    `publishFunctionPlan`; `emitFunc` later calls
    `installFunctionPlan(ctx, functionPlanOf(ctx, func))` and does ONLY
    emission. `compilePendingClosures` (compile/index.js ~2403-2409) is the
    closure analogue of that `emitFuncs` loop but has no analyze-first
    counterpart — because `ctx.closure.bodies` grows incrementally (closures
    are discovered mid-emission, sometimes mid-OTHER-closure-emission), there
    is no single up-front point to run an `analyzeFuncs`-style pass over all
    of them before ANY emission — the plan-then-emit split has to happen PER
    BATCH, mirroring how `mintLoopPlans`/`mintClosureEnvPlans` already run
    "per newly discovered body," not once globally (closure-plan.js's own
    documented precedent, ONE fact instead of the whole FunctionPlan shape —
    P4 is exactly "do that, but for the full shape").
  - Restructuring: split `emitClosureBody(cb)` into `analyzeClosureBodyForEmit(cb)`
    (enters a frame, seeds `ctx.func`/`ctx.types` from `cb`'s pre-seeded
    facts + ambient globals exactly as today's prologue does, runs the six
    analysis calls above, collects the SAME facts shape
    `analyzeFuncForEmit` collects, restores the frame, returns facts →
    `publishFunctionPlan(ctx, cb, facts)` — `ctx.plans.functions` is already
    a bare `WeakMap`, so keying on `cb` (a stable per-closure-body record)
    instead of a `func` needs no structural change, only doc/naming) and
    `emitClosureBodyIR(cb, plan)` (enters a frame, `installFunctionPlan`,
    then ONLY the emission-shaped remainder — `bodyIR`, env/rest-param
    locals, `defaultParamInits`, `fn` assembly). `compilePendingClosures`
    becomes two passes over each newly-discovered range: analyze then emit,
    same order as today, so closure discovery during pass 1 of a LATER batch
    still works exactly as it does now.
  - The one piece that does not cleanly fall into "analysis" or "emission":
    `populateBoxedSets()` (called once per body shape, block/expression) is
    ANALYSIS in what it decides (which locals are boxed cells, their cell
    names) but its call-site ORDER is emission-critical by the function's own
    comment — it must run immediately before body emission because `emitDecl`
    reads `ctx.func.preboxed` mid-emission. Split it too: the CLASSIFICATION
    half (which names are `boxedCaptureNames`/`boxedValueCaptureNames`/
    `boxedParamNames`) is a pure function of already-analysis-phase state
    (`cb.captures`/`cb.params`, `ctx.func.boxed`, `parentBoxedCaptures`) and
    belongs in the analysis half, stored as new plan-adjacent fields (extend
    `createFunctionPlan`'s shape, or a small closure-only sibling record
    mirroring `ClosureEnvPlan`'s existing separateness from `FunctionPlan`
    rather than overloading one shape for two different consumers — undecided,
    needs the actual field census first); the WRITE half
    (`ctx.func.preboxed.add`, `emitPreboxedLocalInits`'s actual local
    declarations) stays in the emit half, reading the precomputed
    classification instead of recomputing it.
  - Named risk, the reason this stayed banked rather than attempted: any
    analysis-half computation that currently runs INTERLEAVED with
    `ctx.func.uniq`-consuming temp-name allocation (`freshEmitId`) would, once
    hoisted earlier, allocate its temp names in a different ORDER relative to
    every other `uniq` consumer in the same function — `mintClosureEnvPlans`'s
    own doc calls this out explicitly for a narrower case ("moving it earlier
    would reorder ctx.func.uniq's temp-name allocation... and change emitted
    WAT text for a program that has nothing to do with this plan"). A full P4
    landing needs the same byte-identity discipline the LoopPlan/ClosureEnvPlan
    pre-emission mints shipped under (58-case × O0/O2/O3 sweep against a
    clean-HEAD worktree, 0 diffs) — likely several iterations to find a split
    point that never touches `uniq` ordering, not a single-pass mechanical
    move.

**Gates (worktree `session-remediation-2026-08-12`, base `7b07a810`,
`/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/session-remediation`,
`node_modules/*` individually symlinked to the shared tree):**

| check | result |
|---|---|
| `node test/session-reentrancy.js` (incl. 2 new tests: FunctionPlan mutation tripwire, typedElem/typedLen leak regression) | 15/15 pass (37 assertions) normal; 15/15 pass (41 assertions) under `JZ_DEBUG_INVARIANTS=1` (tripwire test fires; all others unaffected) |
| `node test/index.js` (full suite) | 3429/3437 pass, 6 skip — ONLY the 2 standing guard-coalescing shape fails (interval walk / typed RMW), matching the documented baseline signature exactly, no new fails |
| `JZ_DEBUG_INVARIANTS=1 node test/index.js` | 3430/3439 pass (one more test/assertion than the plain run — the two new session-reentrancy tests' tripwire-branch), 6 skip, 3 fails: the same 2 guard-coalescing rows PLUS the documented pre-existing `analyzeValTypes` declRange/`cf1_8` idempotence flake (audit-#12 item 2's own probe) — confirmed byte-for-byte reproducible on unmodified `7b07a810` in isolation (`node test/index.js perf`), not a regression |
| `JZ_TEST_TARGET=jz.wasm node test/index.js` (test:wasm, self-hosted kernel built from this session's modified source) | 2726/2732 pass, 6 skip, **0 fail** |
| `npm run build` ×2 | byte-identical SHA-256 both runs — `dist/jz.js` `3a63c4a1…`, `dist/interop.js` `ef42c9da…`, `dist/jz.wasm` `d0101a1b…` |
| dormant kernel size spot-check (same build, unmodified `7b07a810` vs this session's source, both O3 self-host defaults) | `jz.wasm` 16568.1 kB → 16580.2 kB (+12.1 kB, +0.073%); `jz.js` 2040.9 kB → 2042.5 kB (+1.6 kB, +0.078%) — NOT byte-identical, and reported as such rather than claimed zero: new `JZ_DEBUG_INVARIANTS`-gated function bodies (`planFieldsEqual`, the snapshot `WeakMap` plumbing, the widened `isInactiveFunction`) are runtime-dead when the flag is off but still compile into the kernel as real (unreachable at runtime) code, since `DBG_INVARIANTS`'s `typeof process !== 'undefined'` guard is a kernel-RUNTIME check, not something jz's own self-host build can constant-fold away. Runtime/dormant BEHAVIOR is unaffected — confirmed functionally, not just assumed, by the test:wasm row above running the actual modified kernel to 0 fails |
| shared `node_modules/watr` | untouched — worktree used individual per-package symlinks (`node_modules/watr → /Users/div/projects/jz/node_modules/watr`), not a whole-`node_modules` link; `diff -rq` between the worktree's resolved path and the shared tree's own `node_modules/watr` at session end: clean, exit 0, zero differences (37 files both sides) |

**Files**: src/compile/function-plan.js (P1: snapshot/compare tripwire),
src/compile/active-function.js (P2: structural typedElem/typedLen swap; P3:
isInactiveFunction), src/ctx.js (P2: `ctx.types.typedLen` default;
`isInactiveFunction(ctx)` call site), src/compile/index.js (P2:
`emitClosureBody`'s redundant restore line removed, doc updated),
test/session-reentrancy.js (2 new tests, `isInactiveFunction(ctx)` call-site
update).

**Explicitly out of scope, untouched**: `src/compile/narrow.js`,
`src/static.js`, `README.md`; FlowState completion in narrow.js/program-facts.js
overlays (the original audit's finding 4, a different item than this
session's P4); the full `CompileSession` record (correctly still gated on
the six-lifetime decomposition per §CompileSession above).

## §Region arena — `closure4232` ROOT-CAUSED AND FIXED: ephemeral-HASH
reuse cleared only its lane, not its entry bytes — `__coll_order` (blind to
that convention) misread stale hash words as live, overflowing its own
scratch buffer; oracle 9/13 → 11/13 region-live, both standing rows CLOSED
(2026-08-13)

**Setup.** Fresh worktree `region-peel-g` off `475a202d` (detached),
`npm ci` (installs `watr` + runs `prepare`'s dormant build). `node_modules/
watr` reconfirmed byte-identical to `/Users/div/projects/watr` (`895ca5b`/
5.7.14, `watr.js`+`package.json` diff clean) both before and after this
session. Read `475a202d`'s own ledger entry in full (immediately above)
plus `ab2f2f40`'s, per the campaign brief.

**Method fix inherited, reused as-is.** Built the region-live kernel via
`compile(profile.graph.code, {modules, memory, optimize, names:true})` —
bytes, no `wat:true` (the prior session's own corrected method) — giving
real, compiler-assigned V8 stack-trace names with zero guessing.

### Step 1 — `closure4232` attribution (name section + `wasm-objdump`, not
text-position counting)

Reproduced the 9-char repro against the named region-live kernel, 3/3,
byte-identical crash address to `475a202d`'s own finding:
```
RuntimeError: memory access out of bounds
    at closure4232 (wasm-function[3757]:0x821a6f)
    at m106_emit$emit (wasm-function[82])
    at tramp_m106_emit$emit (wasm-function[3398])
    at m82_bridge$emit (wasm-function[65])
    at m82_bridge$storedValue (wasm-function[174])
    at tramp_m82_bridge$storedValue (wasm-function[3315])
    at closure3219 (wasm-function[747])
    at closure800 (wasm-function[4427])
    at m106_emit$emit (wasm-function[82])
    at m106_emit$emitDecl (wasm-function[2059])
```
This full trace (deeper than `475a202d`'s own truncated capture) resolves
completely, module by module: `emitDecl` → `emit` (the array-literal
initializer) → `ctx.core.emit['[']` (module/array.js's dynamic,
non-module-scope array-literal path — `closure800`, confirming
`475a202d`'s own "leading suspect", now CONFIRMED not just suspected) →
its nested `emitElem` closure (`closure3219`, module/array.js:730) →
`src/bridge.js`'s `storedValue`/`emit` (the module↔emit.js indirection
every `module/*.js` consumer goes through) → back into `compile/emit.js`'s
own `emit()` dispatcher → `ctx.core.emit['=>']`. **`closure4232` IS
`compile/emit.js`'s `'=>':` handler itself (line 7035)** — not
`ctx.closure.make` as `475a202d` hedged ("IS (or directly inlines)"): the
`if (!ctx.closure.make) err(...)` guard `475a202d` found at its own entry
is the handler's OWN first statement, not something `.make()` shares.
Cross-referenced against `wasm-objdump -d` on the same bytes (name section
confirmed present via `-h`) — `func[3757] <closure4232>`, `func[22]
<__coll_order>`, `func[3758] <closure4233>` bracket the exact 5098-byte
body — and independently against a full `wasm2wat --enable-all` dump
(func-index arithmetic cross-checked: 6 imports + 3751 zero-indexed defined
funcs before the `closure4232` def line = func[3757], matches exactly).

The faulting instruction (both tools agree): a `hashValuesFromTemp`-shaped
gather loop (`module/object.js:1206`, `fieldOff=16`, PTR.HASH stride 24,
no dedup — this is the SET/MAP/HASH-generic column-gather, not
`objectValuesFromTemp`'s schema-aware walker) compiled inline for
`Object.values(defaults)` at `compile/emit.js:7067` (`for (const def of
Object.values(defaults)) findFreeVars(def, paramSet, captures)`) — reached
UNCONDITIONALLY on every `=>` literal, monomorphically (no runtime
`__ptr_type` branch immediately guards it — the compiler statically proved
`defaults` is always PTR.HASH, since it's filled only via computed-key
writes `defaults[tmp] = c.defValue`). `defaults = {}` is per-call-site
ephemeral (module/collection.js's "non-escaping lexical dictionary…
reuse across loop iterations" optimization) — `closure4232`'s own body
opens with `call $__hash_reuse_eph` on `local 20` before anything else,
confirming this exact reuse path fires for `defaults` on every re-entry.

### Step 2 — WAT-level breadcrumb (i64 debug globals, atomic snapshot)

Spliced 5 new exported `(mut i64)` globals (`$__dbg_off/$__dbg_cap/
$__dbg_ord/$__dbg_n/$__dbg_recv`) plus a capture sequence immediately
before the faulting `f64.load offset=16`, into `wasm2wat`-decompiled text
(`local 6` = the receiver `t`, re-deriving `off`/`cap` via pure
`$__ptr_offset`/`$__cap` re-calls since watr's optimizer never spills them
to a named local; `local 71` = `$ord`, `local 50` = `$n` read from
`global 9` = `$__coll_order_n`) — then reassembled with `wat2wasm
--enable-all` (global-index-shift bug caught and fixed mid-session: the
two insertion points must be applied in DESCENDING original-line order or
the earlier splice invalidates the later one's pre-computed index; a first
attempt corrupted `global.set 576`'s apparent type and was caught by
`wat2wasm`'s own type-checker before ever running). Reran the 9-char
repro 3/3 against the instrumented binary — same crash, same address:
```
__dbg_off  = 2183528  (0x215168)   -- a real, non-degenerate heap address
__dbg_cap  = 8                     -- the table's real slot capacity
__dbg_ord  = 2184240  (0x215430)   -- __coll_order's own scratch buffer
__dbg_n    = 8                     -- == cap: EVERY slot misread as live
```

**Verdict: WRONG SLOT COUNT, not a wrong base pointer.** `off` is a
genuine, in-bounds dynamic-heap address (nowhere near `HEAP.START=1024` —
the "degenerate/static receiver" early-return hypothesis a prior session
would have reached for is directly refuted by this number). `cap=8` is a
real, sane table capacity. The corruption is entirely in the OCCUPANCY
SIGNAL: `__coll_order`'s live-count global reads back 8 for a table that
had never had a single key written into it this reuse — every one of its
8 slots misread as occupied.

### Step 3 — backward trace to the write site (binary-level discipline
throughout; no JS-source edits until the fix itself)

`module/collection.js`'s `__hash_reuse_eph` (the "ephemeral, non-escaping
dictionary" fast-reuse path `closure4232` calls on `defaults`): on the
reuse branch (`cap >= want`), it resets the header COUNT word to 0 and
`memory.fill`s the compact "occupancy LANE" (a separate `cap*4`-byte array
living right after the entry table) — but does **NOT** touch the 24-byte
entry region itself, on the documented theory "reused heap bytes in the
24-byte entry region are unreachable while that lane is zero." That theory
holds only for a LANE-AWARE reader. `module/core.js`'s `__coll_order` — the
ONE shared insertion-order walker behind `Object.keys/values/entries`,
`for-in`, spread, `JSON.stringify`, and every Map/Set-algebra op — has no
notion of the ephemeral-table lane convention at all: it raw-scans each
slot's own hash word (`i64 @ slot+0 != 0`), the SAME test a DURABLE hash
uses, because `PTR.HASH` tags both layouts identically and `__coll_order`
is generic over both. A reused-but-lane-cleared ephemeral table therefore
still carries its OLD (nonzero) hash words in the entry region — every
slot from the PRIOR use of this exact backing memory reads as "occupied."

That mismatch alone would just make `Object.values()` on a reused-but-
logically-empty dict return the wrong (nonempty) array — a silent
correctness bug, not a crash. The TRAP itself is a compounding second
defect, also in `__coll_order` (`module/core.js:1177`): its own scratch
buffer `$buf` is sized from `i32.load(off-8)` — the header COUNT word
(which `__hash_reuse_eph` correctly reset to 0) — not from `$cap` (its own
parameter, and the only value that safely bounds real occupancy: live
count can never exceed slot count, by construction). Sizing off the
header gives a **0-byte** buffer; the raw slot scan then (correctly, per
its own logic, given the stale hash words) finds 8 "occupied" slots and
writes 8 entries into that 0-byte allocation — a heap-corrupting overflow
that manifests a few instructions later, when `hashValuesFromTemp` reads
the now-corrupted `$ord` array back, as the observed OOB trap. `__coll_order`'s
own doc comment already documents "header and real count are NOT
guaranteed to agree" as a KNOWN hazard class (the reason every EXTERNAL
caller was long ago fixed to read `$__coll_order_n` post-call instead of
trusting the header) — but that fix was never applied to `__coll_order`'s
OWN internal `buf` sizing, the one place still trusting the header
directly.

**Why region-only** (not fully re-chased this session — the fix below
closes the class regardless of the trigger, so this is reported as an
honest gap, not glossed over): `defaults`'s "ephemeral, non-escaping"
classification is a purely local, syntactic property of `compile/emit.js`'s
own source, unconditional on region-arena — so the SAME classification
should hold dormant. The reuse BRANCH inside `__hash_reuse_eph` only fires
once `$old` is already a HASH from a PRIOR invocation at the SAME call
site, which requires some per-call-site value to survive BETWEEN
invocations of `closure4232` within one compile — plausibly a global whose
liveness across `region_exit` differs from dormant's equivalent reset
timing, kin of the campaign's other closure/table-state-not-surviving-
region_exit mechanisms, but not directly confirmed by a dedicated
breadcrumb this session (the fix does not depend on this answer).

### Step 4 — the fix (engine level, both call sites, no repro
special-casing)

`module/collection.js`: both `__hash_reuse_eph` (the same-capacity reuse
branch) and `__alloc_hash_eph` (the fresh/grow-allocation path, sharing the
identical "virgin $__alloc memory" assumption that region_exit's
rewind-and-reuse can equally break) now `memory.fill` the FULL entry
region (`cap * MAP_ENTRY` bytes) to 0, not just the lane — restoring
`__hash_reuse_eph`'s own documented contract ("no entry is live
afterwards") so it is actually true for every consumer, lane-aware or not.
Cheap at the small caps this path ever allocates. `__coll_order`'s own
internal `buf`-sizing-off-the-header gap was NOT independently patched —
once the entry region is genuinely zero after every allocation/reuse, the
header count and the real raw-scan count can never again disagree in the
"header under-reports" direction this mechanism exploited, so `buf`'s
sizing invariant is sound again by construction; flagged here for whoever
next touches `__coll_order` rather than fixed reflexively, since neither
this session's evidence nor the existing suite motivates changing it
independently.

**Verified semantically correct, not just non-trapping**: kernel-compiled
`f()` for the 9-char repro returns `1` (matches native `jz(src).exports.f()`
== `1`, both instantiated and actually CALLED, not just inspected as
bytes).

### Gates

- **Repro: 3/3 green**, region-live named kernel, both pre-fix (confirmed
  trapping, address `0x821a6f` matching `475a202d`'s own finding exactly)
  and post-fix (confirmed clean, 3/3, plus the semantic check above).
- **kernel-oracle region-live: 11/13 ×3 (up from 9/13), fully
  deterministic.** BOTH previously-standing rows — `array-growth-class:
  sibling push()+indexed-append tables (envMeta shape)` (line ~327) and
  `captured-then-read` (the PENDING-FIX row, line ~665) — are now fully
  GREEN (envMeta-shape: real AGREE-tier pass at O0/O3; captured-then-read:
  its own designed PENDING-FIX/tripwire structure passes cleanly — no
  trap, native+kernel still share the SAME pre-existing wrong-value bug
  the row exists to track, unrelated to this mechanism, unchanged).
  Remaining 2/13 fails, both rows: `fromnested`
  (`Int32Array.from([Float64Array.from([5])[0], 2])`) at O2 — this is
  **NOT** this session's mechanism: `ab2f2f40`'s own predecessor ledger
  entry ("wall2", `computed member key`/`fromnested` investigation, grep
  `.work/research.md` for "fromnested") already root-checked this EXACT
  row against a plain unpadded regionHooks-wired control and found it
  **traps there too, pre-existing, region-unrelated, disqualified as a
  discriminator** — a genuinely separate, harder, still-open wall (watr
  fusion/inlining axis, exhaustively bisected and REFUTED on every named
  sub-hypothesis in that entry, next lead: a runtime `$__alloc`-entry-style
  stack-walk trace) that this session did not re-attempt, per the brief's
  own scope.
- **jessie/watr/jzify-entry region-live ×3: GREEN**, byte-identical every
  rep: jessie 107,883 B (47 modules), watr 315,222 B (7 modules),
  jzify-entry 614,491 B (70 modules), zero traps.
- **kernel-parity: green** except the same known `fromnested`/O2 row
  (identical disposition to the oracle finding above — not a new failure).
- **Native `npm test`: 3436 total / 3426 pass / 4 fail / 6 skip — ZERO new
  regressions.** The 4 fails: 2 are the same known `fromnested`/O2 row
  (kernel-parity + kernel-oracle, both region-unrelated per above); the
  other 2 (`interval walk: strided companion cursor…` and `typed RMW: one
  guard covers the pure read…`, both in `test/optimizer.js`, both pure
  NATIVE `jz.compile(..., {wat:true})` bounds-check-count assertions on
  typed-array-only sources with no Hash/Map/Object anywhere in them) were
  independently confirmed PRE-EXISTING and unrelated to this fix: `git
  stash`-ed `module/collection.js` alone, reran `test/optimizer.js` on the
  bare `475a202d` baseline — same 2 failures, byte-identical error text,
  confirming this session's fix caused zero regression here.
- **Self-build ×2: SHA-256 converge.** `f0f48d56f85b9879695065b7b6edc16
  07b34c3b85b06d94d87f9b0fc9eedefd8`, both independent region-live builds
  from a clean `dist/`, byte-identical.
- **Dormant `test:wasm`: 0 fail** (2725 pass / 6 skip / 2731 total,
  `REGION_HOOKS_ACTIVE=false`, fresh dormant `dist/jz.wasm` rebuild) — no
  dormant regression from touching the shared `module/collection.js`
  stdlib (native AND self-hosted builds share this source).

**"REGION FRONT COMPLETE candidate" NOT declared** — oracle is 11/13, not
13/13 (the gate's own explicit bar). This session's ASSIGNED mechanism
(the ONE bug both standing rows shared, per `475a202d`'s own framing) is
CLOSED — root-caused via WAT-level breadcrumb evidence (not guessed),
fixed at the engine level in the shared stdlib (not repro-special-cased),
and gated clean across every battery this campaign runs. The remaining 2
oracle fails are a DIFFERENT, ALREADY-DEEPLY-INVESTIGATED, region-UNRELATED
wall (`ab2f2f40`'s own "wall2"/`fromnested` entry) — next lead is that
entry's own next-named step (a runtime `$__alloc`-entry-style stack-walk
trace pointed directly at `fromnested`'s O2 faulting frame), not a
continuation of this session's mechanism.

**Disposition.** Landed fix: `module/collection.js` (+43/-5 lines, both
`__hash_reuse_eph` and `__alloc_hash_eph`). `scripts/self.js`'s
`REGION_HOOKS_ACTIVE` toggle and every named-kernel/breadcrumb build
artifact (`kernel.wat`, `kernel-instrumented.wat/.wasm`,
`kernel-region-live-named*.wasm`, `dist-jz-regionlive-build*.wasm`,
`full-disasm.txt`, `closure4232.wat.dis`, the `run-*.mjs`/`instrument.py`
scratch scripts) lived only in the session scratchpad
(`/private/tmp/…/scratchpad/`), never copied into the worktree; worktree
`git status` at session end shows only `module/collection.js` and this
ledger entry.

**SHAs.** jz worktree: `475a202d` base; this session's fix + ledger commit
on top (see commit log). watr: `895ca5b`/5.7.14, reconfirmed identical
before and after. Region-live `dist/jz.wasm` (production build, `names`
not requested): SHA-256 `f0f48d56f85b9879695065b7b6edc1607b34c3b85b06d94
d87f9b0fc9eedefd8`, reproduced identically across 2 independent builds.
Dormant `dist/jz.wasm` (final gate rebuild): 16,678.9 kB,
`REGION_HOOKS_ACTIVE` confirmed `false` in the committed `scripts/self.js`
(unchanged from `475a202d` — this session's only edits to that file were
scratch, built/tested, then discarded via `git checkout --`).

## §Stdlib registration: two-dialect silent-overwrite eliminated — guard landed, unification banked with a sketch (2026-08-13)

**Goal.** CONTRIBUTING.md's "Stdlib registration — two dialects, by design"
paragraph documented ONE hard, mechanical hazard — a raw `ctx.core.emit[name]
= fn` (or `bind(name, fn)`) assignment textually after a `reg(name, deps,
fn)` call for the SAME name silently overwrites `emitter()`'s wrapper,
dropping the auto-inc(deps)/`.argc` guarantee with no error — and named a
single mitigation: `test/passes.js`'s stdlib-shadow test, a REGEX scan
scoped to same-file/same-top-level-function textual order. Two real gaps:
(1) it only catches raw-AFTER-reg within one file's one function — a
cross-module collision (module B's `reg()` shadowing module A's earlier raw
write, or vice versa) was entirely unguarded, statically or at runtime; (2)
the reverse order (`reg()` superseding an earlier raw assignment) was
explicitly tolerated as "just orphans dead code, delete on sight" — a
silent, must-remember-to-clean-up state, not a hard failure. Task: make
BOTH orders of a duplicate registration — through EITHER dialect — throw at
registration time, naming both sources, and remove the silent-overwrite
window entirely (not just narrow the static scan).

**The two dialects** (bridge.js): raw `ctx.core.stdlib[name] = body` /
`ctx.core.emit[name] = fn` (or `bind()`, its named sugar for the exact same
write) — ~580 sites, the DEFAULT for dep-free/arity-irrelevant handlers,
including a genuinely load-bearing generic→specific override CHAIN (e.g.
`string.js`'s `bind('.valueOf', …)` Object.prototype fallback, deliberately
shadowed by `date.js`'s raw `ctx.core.emit['.valueOf'] = emitDateGetTime`
loaded later via `MOD_DEPS`) — vs. `reg(name, deps, fn)`/`wat(name, body)`
(→ `emitter()`, ctx.js) — ~35+113 sites — REQUIRED whenever deps must
auto-include (`inc(...deps)` on every call) or logical arity must be
explicit (`.argc`, for `emitArity()`'s rest-param-wrapper case).

**Root-cause fix, not the dialect unification.** Collapsing ~580 raw sites
to `reg()` universally was explicitly out of scope unless "modest and
mechanical" — it is neither (every site would need a deps-list judgment
call the audit that wrote the original CONTRIBUTING paragraph already
declined to make mechanically; see below for the banked sketch). Landed
instead: a real registration-time collision guard, `registerName`/
`verifyEmitIntegrity` (src/ctx.js), wired into `reg()`/`wat()` (bridge.js)
and `registerGetter()` (ctx.js) — the three STRUCTURED entry points — plus
`includeModule()` (src/autoload.js), which sets `ctx.core.currentModule`
before each module's `init(ctx)` and calls `verifyEmitIntegrity` right
after it returns.

- **Pre-write check** (`registerName`): before writing `table[name]`,
  throws if the name is already occupied — by an earlier `reg()`/`wat()`/
  `registerGetter()` call (tracked) OR an earlier raw/`bind()` write
  (detected via a plain `table[name] !== undefined` read — no registered
  value is ever `undefined`). This alone covers raw-then-reg (the
  historically undetected-until-audit direction, elevated here from
  "orphans dead code" to a hard throw) and reg-then-reg/wat-then-wat
  (typo-shaped duplicate registrations).
- **Post-hoc check** (`verifyEmitIntegrity`, ctx.core.emit only): after
  each module's `init(ctx)` returns, re-checks every name that module (or
  an earlier one) `reg()`-registered — if `table[name]` is no longer the
  exact `emitter()`-wrapped handler (checked via the `.deps` tag every
  `emitter()` output already carries, not a stored reference — see below
  for why), throws. This closes reg-then-raw, the ONE mechanically
  dangerous direction CONTRIBUTING originally named, now caught
  immediately instead of requiring an audit to notice (the exact shape of
  the `module/math.js` `f16round` incident CONSISTENCY-AUDIT RESPONSE
  task 1/3, 2026-08-09, found and deleted by hand).
- **Deliberately NOT symmetric for `ctx.core.stdlib`/`wat()`**: a WAT body
  is a plain string with no wrapper metadata to silently lose — a raw
  clobber there is an outright wrong-text bug, not CONTRIBUTING's
  invisible-guarantee-drop hazard, and (per the bisection below) tagging a
  string isn't possible without reintroducing the exact structure that
  broke self-host warm reuse. `wat()` still gets the pre-write check
  (registerName is shared), just not the post-hoc one.
- **Deliberately NOT applied to `bind()`/raw-vs-raw**: the `.valueOf`
  override chain above is real, load-bearing, and NOT a bug — the guard
  only protects names that went through `reg()`/`wat()`/`registerGetter()`
  at least once; two raw/`bind()` writers for the same name silently
  "last one wins" by design, matching the ORIGINAL CONTRIBUTING framing
  (only reg()-involving shadowing was ever called dangerous).

**A genuinely raw bracket assignment can't be trapped in general** — no
Proxy (see below, this is why) — so the guard's coverage is exactly "any
duplicate where at least one side went through `reg()`/`wat()`/
`registerGetter()`", which is precisely the class CONTRIBUTING's own
"REQUIRED whenever…" rule identifies as consequential. A pure raw-vs-raw
duplicate (two DIFFERENT raw definitions for the same name, no `reg()`
involved) remains statically-checked only, via the pre-existing
`test/passes.js` regex gate — banked as a known, deliberate, honesty-first
scope boundary, not silently dropped.

**Why not a `Proxy`.** `ctx.core.emit`/`ctx.core.stdlib` are written by
~580 literal `table[name] = fn` sites across `module/*.js` — intercepting
an arbitrary property write needs a `Proxy` trap, and `src/ctx.js` (this
guard's home) is compiled BY jz into `dist/jz.wasm` as part of
self-hosting — `scripts/self.js` imports it directly, and every module's
`init(ctx)` (including every raw-assignment site) runs as compiled WASM
whenever `dist/jz.wasm` compiles a program (exercised by `test:wasm`, the
existing self-host test suite). Proxy traps aren't in jz's self-hostable
subset (no `Proxy` anywhere in `CTORS`/`TYPED_CTORS`/`COLLECTION_CTORS`,
`src/autoload.js`) — wrapping `table` in one would either fail `npm run
build` outright or (worse) silently misbehave inside the compiled kernel.
Confirmed empirically: `npm run build` (native pipeline compiling
`scripts/self.js` INTO `dist/jz.wasm`) is itself the mechanism that must
survive every change to this file.

**A second, harder self-host hazard found and fixed by bisection.** The
first two working designs (a name→`{module,dialect,value}` dict, then a
`Map`, both used to attribute a collision to its original registering
module) each PASSED native `npm test` (3428/3428, unchanged) but broke
`test/selfhost.js`'s "warm-instance reuse" test — `_clear()` the wasm
arena, recompile within the SAME instance, byte-pin against a fresh
instance — with a bare "memory access out of bounds" on round 1. Bisected
against that one test (each round: patch → `npm run build` → `node
test/selfhost.js`, ~4 min/round, ~14 rounds total) to two independent,
narrow root causes, NEITHER previously documented:
1. **A second large (~150-600 entry) dynamically-key-growing dict/Map,
   alive alongside `ctx.core.emit`'s own ~600-entry one, corrupts warm
   `_clear()` reuse** — even though `ctx.core.emit` ITSELF (proto-seeded,
   then grown to ~600 keys by every module, every compile, unchanged code)
   proves ONE such dict is fine. Confirmed by elimination: `Map` → fail;
   plain dict with an object-literal value → fail; plain dict with a
   scalar-string value → fail; array-only (`.push()`, zero second dict) →
   pass.
2. **String CONCATENATION (`a + b` producing a genuinely NEW string),
   repeated ~150 times during registration, corrupts warm `_clear()` reuse
   even with ZERO dicts involved** (arrays only). String concat runs
   constantly in ordinary compiled PROGRAMS without issue — the trigger is
   concatenation specifically inside the COMPILER'S OWN self-hosted
   bookkeeping, at this call volume, surviving to the next `_clear()`.
   Confirmed by elimination: `site.push(a + '|' + b)` → fail;
   `site.push(a); site.push(b)` (two separate pushes of ALREADY-EXISTING
   string references, zero concatenation) → pass.

Neither is root-caused inside the self-hosted dyn-props/string runtime
itself (a real, separate, deeper investigation — flagged here, not
chased, per this task's own scope). The shipped `registerName`/
`verifyEmitIntegrity` sidesteps both: THREE plain arrays per table
(`regEmitOrder`/`regEmitDialect`/`regEmitModule`, same trio for stdlib),
insertion-ordered, looked up via a linear `order.indexOf(name)` scan (fine
— registration is a one-time, not-hot phase, n ≈ a few hundred at most) —
and every `+`/template-literal string build lives ONLY inside a `throw`
branch (dead code on any passing compile, so it never executes during the
warm-reuse round-trip either). `ctx.core.stdlib` is also switched from
`{}` to `Object.create(null)` (matching `ctx.core.emit`'s `derive()`
seed) so the pre-write `table[name] !== undefined` check can't
false-positive on an inherited `Object.prototype` name.

**Field-order discipline.** `ctx.core`'s object literal (reset(), ctx.js)
carries an existing "MUST remain last" comment: the self-hosted kernel
apparently reads some of its fields via SRoA-flattened positional slots,
not by name, so inserting a field BEFORE an existing one shifts every
later field's slot and silently corrupts the kernel's reads of them. All
5 new fields (`currentModule`, `regEmitOrder`, `regEmitDialect`,
`regEmitModule`, `regStdlibOrder`, `regStdlibDialect`, `regStdlibModule` —
7 total) are appended strictly after `getters`, before that comment,
never inserted mid-literal.

**Banked: dialect unification sketch** (not pursued — diff isn't modest).
Collapsing the ~580 raw sites to `reg()` uniformly would need, per site: (a)
a deps-list judgment call (which stdlib helpers does this handler's body
actually `inc()`? — grep-able per-site but not mechanically derivable
without a real dataflow pass over each handler body, since `inc()` calls
are free-form JS inside the closure, not a declarative list today), (b) an
arity judgment call (does `Function.length` already match the intended
logical arity, or does this handler need explicit `.argc`?), and (c)
re-verifying every call site that reads `ctx.core.emit[name]` directly
(bypassing `emitArity`) still gets a `.deps`-tagged function, since some
consumers (`typeof Math.x` folding, the `.`-emit property/method split)
branch on `emitArity()`'s fallback behavior. A safe MECHANICAL slice of
this — NOT the whole thing — would be: (1) write a real dataflow pass
(reuse `refsName`/`refsAny` from `ast.js`, per CONTRIBUTING's own "don't
hand-roll name scanners" rule) that extracts each raw handler's actual
`inc()` call list into a real `deps` array; (2) mechanically rewrite `raw
ctx.core.emit[name] = fn` → `reg(name, extractedDeps, fn)` for every site
where `fn.length` already matches its call sites' argument counts (the
"common case, hence still the default" CONTRIBUTING already names); (3)
hand-triage the residual sites where arity genuinely diverges (rest-param
wrappers) — this is the SAME shape CONTRIBUTING's "logical arity diverges
from `fn.length`" bullet already describes, just applied everywhere
instead of only where deps/arity currently matter. Rough size: ~580 sites,
so even a highly mechanical version is not a "modest" diff — likely its
own multi-session project, not a drive-by. If undertaken, it also
retires the STATIC raw-vs-raw blind spot named above for free (nothing
raw left to blind-spot).

**CONTRIBUTING.md updated** — "Stdlib registration" paragraph now
describes the runtime guard (both throw directions, the `.valueOf`-style
override-chain carve-out, the two test/passes.js gates) instead of the
old "one hard rule, gated by a regex scan" framing. README.md untouched
(out of scope, per the task brief).

**Gate ladder** (isolated worktree at `e836e631`, branch
`stdlib-failfast-2026-08-13`, `node_modules` symlinked from the main tree
— re-verified byte-identical before and after, `watr@5.7.14`):

| check | result |
|---|---|
| new test: duplicate registration throws, both dialect orders (`test/passes.js`) | 7/7 assertions pass — raw-then-reg (immediate), reg-then-raw (post-hoc), reg-then-reg (immediate), real compile unaffected by the synthetic pokes |
| native `npm test` | 3429 pass (3428 baseline + 1 new test) / 1 fail (pre-existing, banked `typed RMW` guard-count pin) / 6 skip — **zero regressions** |
| `npm run build` | clean; `dist/jz.wasm` 16,968,775 B |
| `npm run build` ×2 | SHA-256 identical both times (`dist/jz.wasm` `3aa5be04…`, `dist/jz.js` `89840a83…`) |
| `test:wasm` (`JZ_TEST_TARGET=jz.wasm`) | 2725 pass (2724 baseline + 1) / 0 fail / 6 skip — **zero regressions** |
| `node test/selfhost.js` | 21/21 (206 assertions) — including the "warm-instance reuse" round-trip this session's bisection targeted |
| kernel/golden output identity | a synthetic program (typed array + Math + Map + array `.map`/`.filter`) compiled byte-IDENTICAL on the modified worktree vs. an unmodified `e836e631` checkout, `optimize:3` |
| `node_modules/watr` | byte-identical before/after (aggregate SHA-1 of all files: `11e440cb…`) |

**Files.** `src/ctx.js` (registerName/verifyEmitIntegrity + 7 new
`ctx.core` fields + `registerGetter` routed through the guard),
`src/bridge.js` (`reg()`/`wat()` routed through the guard; `bind()`
unchanged, deliberately), `src/autoload.js` (`includeModule` sets
`ctx.core.currentModule` and calls `verifyEmitIntegrity` after each
module's `init(ctx)`), `test/passes.js` (new test, existing static gate
untouched), `CONTRIBUTING.md` (one paragraph). `src/compile/narrow.js`,
`src/static.js`, `module/core.js`, `README.md` untouched, per the task
brief.

**SHAs.** jz worktree base: `e836e631` (main tip at worktree creation —
confirmed it already carries the `$_alloc$exp`/`$_clear$exp` export-
template fix per the task brief; main has since advanced 4 more commits,
none touching this session's files except `src/ctx.js` — a 4-line
`ctx.types.typedLen`/`assertCtxInvariants` diff with zero overlap,
confirmed via `git diff e836e631..HEAD -- src/ctx.js`). watr: `5.7.14`,
reconfirmed byte-identical before and after.

## §combined main-tip validation @ 6ffb28fc (2026-08-13)

**Scope.** Main now stacks five independently-gated changes, each
previously validated on its own older base: `4de7efa0` (named
`_alloc`/`_clear` export templates, `module/core.js`), `bc835a61` +
`4c5bb15d` (header-materialization class: `module/array.js`, `regex.js`,
`string.js`, `json.js`, `typedarray.js`, `src/compile/emit.js`),
`ea423728` (session remediation: `src/compile/function-plan.js`,
`active-function.js`, `ctx.js`, `compile/index.js`), `f55ed89b`
(ephemeral-HASH entry-region clearing, `module/collection.js`),
`6ffb28fc` (stdlib registration fail-fast: `src/ctx.js`, `bridge.js`,
`autoload.js`). Validated the COMBINED tip in an isolated worktree
(`/private/tmp/.../main-validate-2`, detached at `6ffb28fc`, own
`node_modules` via `npm install` — not shared with the main checkout;
`node_modules/watr` aggregate SHA-256 in the main checkout confirmed
identical before and after: `c7a80fc9…`). No fixes applied — validation
only.

| gate | result |
|---|---|
| native `npm test` | 3438 total (19720 assertions) / **3431 pass** / **1 fail** / 6 skip — the fail is exactly the expected banked `typed RMW: one guard covers the pure read and ignored OOB store` guard-count pin; totals drifted up from the older 3429-baseline (new tests landed with the stack) but the failure set is unchanged |
| `test:wasm` (`JZ_TEST_TARGET=jz.wasm`) | 2733 total (12876 assertions) / **2727 pass** / **0 fail** / 6 skip — matches expectation exactly |
| `node test/selfhost.js` | **21/21** (206 assertions) — matches expectation exactly |
| `JZ_DEBUG_INVARIANTS=1 node test/session-reentrancy.js` | **15/15** (41 assertions) — matches expectation exactly, including the FunctionPlan deep-freeze tripwire firing correctly |
| `JZ_DEBUG_INVARIANTS=1 node test/index.js` (invariants suite) | 3440 total (19855 assertions) / 3432 pass / **2 fail** / 6 skip — the banked `typed RMW` pin PLUS the documented pre-existing `analyzeValTypes` declRange/`cf1_8` idempotence flake (audit-#12 item 2's own probe) — matches the historical clean-baseline signature (same 2-fail pattern recorded repeatedly in this ledger since 2026-08-08) |
| self-build ×2 | `npm run build` (`scripts/build-dist.mjs`) run twice; SHA-256 of `dist/jz.js`, `dist/jz.wasm`, `dist/interop.js`, `assets/sprae.js` **byte-identical** across both runs |
| `npm run test:claims` size leg | size geomean jz/as = **1.020×** (27/49 cases smaller) — within the 1.019–1.020× baseline band, gate passes; the 8 other `test:claims` failures are all staleness (reference/memcheck evidence predates HEAD by 97 commits) and strict-leadership/no-red-cases perf-claim sub-assertions, reboot-gated and ignored per task scope |
| `npm run test:262` | Pass **3000** / Fail **0** / Xfail 54 — matches expectation exactly |
| `npm run test:262:builtins` | Pass **852** / Fail **0** / Xfail 87 — matches expectation exactly |

**Verdict: combined tip clean.** Every gate matches its documented
expectation; no failure outside the pre-existing banked set surfaced.
Since nothing regressed, no bisection across the five stacked commits was
needed.

## §Region arena — WALL2 IS NOT A SEPARATE WALL: it's the LAST HOP's own
SW-rides-regionExit fix, silently regressed out of every build since because
`npm ci` never carried it and the pin-verify check was blind to the one file
that matters. `fromnested`/O2 closes in BOTH configs; oracle 13/13 region-live
×3 AND 13/13 dormant ×3 — but the shipped, `npm ci`-resolvable state stays
11/13 both configs: landing the fix for real needs a watr npm publish, out of
this session's authority. NOT declaring REGION FRONT COMPLETE. A genuinely
separate, still-open residual is also surfaced and banked (2026-08-13)

**Setup.** `git worktree add` off `98f60fe0` (detached), per the brief.
`node_modules` copied from the shared checkout rather than freshly `npm
ci`'d (behaviorally identical — same `package-lock.json`, same resolved
tarball — confirmed below). Read this ledger's own "wall2"/`fromnested`
mentions in full (the WAT-diff session, the STRUCTURAL-FUSION DISCRIMINATOR
pad/pin session, the SAFEPOINT FIX PUBLISHED entry, the LAST HOP entry, and
`475a202d`/`98f60fe0`'s own closure4232 fix) before touching anything.

### Step 1 — the pin-verify convention has a blind spot, and it already bit

Every session since the LAST HOP entry (`.work/research.md`, "REAL WALL
FOUND+FIXED… THE LAST HOP", 2026-08-12) reports "`node_modules/watr`
reconfirmed byte-identical to `/Users/div/projects/watr` (`895ca5b`/5.7.14,
`watr.js`+`package.json` diff clean)" as its watr-pin verification. That
check is real but aimed at the wrong file: `watr.js` is a 46-line composed
entry point (`compile`/`watr`/`parse`/`print` re-exports) that never touches
`src/optimize.js`'s own content, and `package.json`'s `"version"` field is
`"5.7.14"` on BOTH sides of the drift this session found — the check passes
identically whether or not the actual optimizer source matches.

Direct diff, this session, worktree `node_modules/watr` (npm-resolved, per
this repo's own `package-lock.json`: `resolved:
https://registry.npmjs.org/watr/-/watr-5.7.14.tgz`, integrity
`sha512-PNBeHpM7rzstcEDxiG26NW4qonyvo7EPFhSK/tgoTc7QysL/IVPOE9qMclVvjaEGtCb5ExFFLBwqZ4owSHj5bw==`)
against `/Users/div/projects/watr`'s working tree (`git status`/`git diff
HEAD` both clean, HEAD `895ca5b`): **every file identical except
`src/optimize.js`.** `npm view watr@5.7.14 gitHead` confirms the registry
tarball's own recorded source commit is `a563a63f5a8c14c32c8152bf94fc229825
958c94` — the LAST HOP entry's own "on top of" baseline, ONE commit BEHIND
`895ca5b` ("region-arena: SW rides the regionExit root bundle (fa3fe0e
follow-up)"). **`895ca5b` was never published.** The LAST HOP entry said so
explicitly at the time ("adopting `895ca5b` for real… is a separate,
follow-up step outside a single session's safe scope… jz's own
`package.json`/`node_modules` were deliberately NOT touched… pristine") and
used a worktree-local `node_modules/watr → /Users/div/projects/watr`
SYMLINK for its own verification — a convention several later sessions'
entries also cite by name ("`node_modules/watr → /Users/div/projects/watr`,
verified intact"). But `475a202d` and `98f60fe0` (the two most recent
sessions, both cited by this task's own brief as establishing "11/13
region-live ×3, 13/13 dormant") both record `npm ci` as their setup step
instead of the symlink — and their own diff check (`watr.js`+`package.json`
only) could not have caught the difference either way. The fix was banked,
correct, tested — and has been silently absent from every `npm ci`-built
kernel for at least three sessions running.

### Step 2 — `fromnested`/O2 is the SAME mechanism, not a second wall

Swapped ONLY `node_modules/watr/src/optimize.js` (stale registry content ↔
`/Users/div/projects/watr`'s `895ca5b`, one file, one real hunk — the `const
SW = []` → `let SW = []` declaration plus the regionExit root-bundle call
site growing `[ast, dirty, snapshots, opts.constF64]` →
`[ast, dirty, snapshots, opts.constF64, SW]` with the matching `SW =
__regionOut[4]` rebind) and rebuilt a region-live named kernel each way
(hand-flipped `REGION_HOOKS_ACTIVE`, `names:true`, no `wat:true`, per
method). Everything else — jz source, memory config, optimize level —
byte-identical between the two builds.

- **Stale watr, region-live**: `fromnested` (`Int32Array.from([Float64Array.
  from([5])[0], 2])`) O2 traps `memory access out of bounds`, 3/3, via both
  a scratch harness AND the project's own unmodified `test/kernel-oracle.js`
  (`node test/index.js kernel-oracle`: 13 total / **11 pass / 2 fail** — the
  exact two rows this campaign has banked as `fromnested`'s signature,
  `kernel parity: byte-identical WAT at O2` and `kernel oracle: native +
  kernel agree with JS at O2`, 434 assertions, matching `98f60fe0`'s own
  reported state exactly).
- **Fixed watr (`895ca5b`), region-live, nothing else changed**: same two
  test rows, **13/13, 3/3 reps, deterministic** (541 assertions — the extra
  107 are the O2 row's own AGREE-tier body, previously never reached past
  the trap). `kernel-parity` standalone: 3/3 (33 assertions), byte-identical
  WAT at O0/O2/O3 including the `fromnested` row by name.

**Why this is causally, not coincidentally, region-related.** `src/optimize/
watr-tail.js` gates watr's `regionMark`/`regionExit` wiring behind a single
call site: `if (watrOpts && regionHooks) { watrOpts.regionMark =
regionHooks.mark; watrOpts.regionExit = regionHooks.exit }` — and its own
comment names `scripts/self.js`'s `optimizeTail` as "the ONLY caller that
ever passes `regionHooks`". In a region-live KERNEL, `optimizeTail` is
itself self-hosted with `REGION_HOOKS_ACTIVE` baked `true` — so `opts.
regionExit` is wired on EVERY optimizer round the kernel runs for ANY
target program it compiles, `fromnested` included, independent of anything
`fromnested`'s own source does. `895ca5b`'s bug (SW's own backing pointer,
relocated by an ordinary mid-round `arrGrow`, gets reclaimed — not
relocated-and-rebound — by the region exit that only drains its LENGTH,
because pre-fix SW was never in the root bundle) therefore fires on every
single self-hosted compile a region-live kernel performs. This is the exact
same mechanism the LAST HOP entry root-caused for the `computed member key`
O3 row via a live corruption trace (`$__map_from` ← `substGets` ←
`forwardPropagate`, landing on a freshly-allocated Map header) — this
session did not need to re-run that trace to confirm the SAME code path
explains `fromnested`: the controlled single-file before/after swap is
strictly stronger evidence (it isolates the ONE candidate line, not just
one plausible stack).

**The "region-unrelated, disqualified as a discriminator" verdict (this
ledger's own "TWO 'UNTRIAGED RESIDUALS' TRIAGED" entry, 2026-08-11) is
REFUTED.** That session tested `fromnested` against `d1f2f2ba`+regionHooks-
wired — a control that was ALSO region-live, built from the SAME
watr vintage this session found stale. Two region-live builds agreeing
that a region-only bug traps is not evidence the bug is region-unrelated;
it is exactly what a real region-triggered defect looks like when neither
side of the comparison ever turns regions off. That session's own next-door
"STRUCTURAL-FUSION DISCRIMINATOR" entry explicitly used the SAME kind of
region-live-vs-region-live pairing for a DIFFERENT repro and reached a
correctly negative verdict there — the method is sound in general; it
simply was never pointed at a genuinely dormant control for `fromnested`,
which is the one comparison that would have surfaced this.

### Step 3 — dormant ALSO flips, but NOT for the reason above (banked, not solved)

The same file swap flips `fromnested`/O2 from trap to pass in a genuinely
DORMANT kernel too (`REGION_HOOKS_ACTIVE=false`, confirmed via both a
scratch harness and the real `test/kernel-oracle.js`: 11/13 → **13/13 ×3**,
434 → 541 assertions, reproduced across three independent standalone runs).
This is real and reproducible — but it cannot be `opts.regionExit` actually
executing: `regionHooks` is wired ONLY by `scripts/self.js`'s `optimizeTail`,
itself gated by the same `REGION_HOOKS_ACTIVE` literal, `false` throughout
every dormant compile including the kernel's own self-hosted one — the
`if (opts.regionExit) {…}` branch `895ca5b` touches is provably dead code
for every call a dormant kernel ever makes.

Ablated to find out what DOES explain it (three dormant kernel builds,
otherwise byte-identical, `src/optimize.js` the only varying input):
- **Pad-only** (16 inert `//` comment lines spliced at the exact same source
  location, zero functional change): `fromnested`/O2 **still traps 3/3** —
  rules out a bare "any size perturbation flips it" size-lottery
  explanation for THIS specific case.
- **`let`-only** (`const SW = []` → `let SW = []`, nothing else — the
  regionExit call site left at its original 4-element form): **still traps
  3/3** — rules out the bare declaration-kind switch alone.
- **Full `895ca5b` diff** (both hunks together): **passes 3/3.**

The flip needs the SPECIFIC extra AST content of the (dead-in-dormant)
regionExit branch — real code, not comments, and not the keyword alone —
which the compiler still has to walk and codegen (it cannot statically
prove `opts.regionExit` is always falsy across `runRounds`' whole call
graph), consuming closure/temp-numbering state that shifts everything
downstream in the ~6,000-closure self-hosted kernel. This is the exact
"a `$closureN`/`$__mkptr_6_N_d`-class renumbering event… structurally
invisible to every static, name-based technique" class this ledger has
named and banked repeatedly (the WAT-diff session's own closing paragraph;
`closure4232`'s own root cause was a member of the same broader family,
though independently and fully root-caused there). **Dormant's own
`fromnested`/O2 failure is therefore a SEPARATE, still-unlocated
closure-numbering-sensitive miscompile** that this fix does not actually
repair — it is dodged by luck of code shape, the same way this whole class
has been dodged and re-triggered by unrelated changes throughout this
campaign. Flagged honestly, not glossed over: adopting `895ca5b` for real
will make the ORACLE pass (both configs, see gates below), but the dormant
axis's own true defect remains open and could resurface on the next
unrelated size change anywhere in the self-hosted graph.

### Gates (all run against the fixed watr — worktree-local `src/optimize.js`
overlay only, discarded before session end, never committed)

- **kernel-oracle region-live: 13/13 ×3**, deterministic (541 assertions).
- **kernel-oracle dormant: 13/13 ×3**, deterministic (541 assertions, three
  independent standalone runs).
- **kernel-parity: green, both configs** (3/3, 33 assertions each; WAT
  byte-identical at O0/O2/O3 including `fromnested` and `computed member
  key` by name).
- **jessie/watr/jzify-entry region-live ×3: GREEN**, byte-identical every
  rep, zero traps: jessie 106,996 B (47 modules), watr 315,222 B (7
  modules), jzify-entry 611,504 B (69 modules) — module counts/sizes differ
  slightly from older entries' numbers (codebase drift since those bases),
  determinism and zero-trap are what this gate checks.
- **watr's own test suite (`/Users/div/projects/watr`, `895ca5b`): 611
  total / 591 pass / 20 skip / 0 fail** — includes the two dedicated
  region-arena regression tests `895ca5b`'s own history already added
  (`test/optimize.js`: "regionExit boundary drains CNT/CNT_FN/SW/SW_MEM
  scratch caches", "every value live past regionExit is rooted and
  rebound") — no new watr test needed, the fix already has first-party
  coverage at watr's own abstraction level.
- **Full native `npm test` (dormant, fixed watr): 3436 total / 3428 pass /
  2 fail / 6 skip — TWO FEWER fails than the documented baseline
  (3436/3426/4/6), zero new regressions.** The 2 remaining fails are
  exactly the pre-existing `test/optimizer.js` pins (`interval walk:
  strided companion cursor…`, `typed RMW: one guard covers…`) — confirmed
  unrelated to watr/region by every prior session's own ablation, unchanged
  here. The 2 that closed are precisely `kernel-parity`'s and
  `kernel-oracle`'s `fromnested`/O2 rows.
- **Self-build ×2, SHA-256 converges, both configs.** Region-live:
  `a854a4c875d4d652b631fd2b0fc18098ab01799975c712d17776325f0f9b5c99` twice.
  Dormant: `ffb6e45a2d191aa4ed8b71ff8bcf71a0b2df565287a7ffd8747cba8b736c763
  2` twice.
- **Dormant `test:wasm`: 0 fail** (2731 total / 2725 pass / 6 skip —
  byte-identical to the documented historical baseline).

### Correcting this task's own premise

The brief cites "11/13 region-live ×3, 13/13 dormant" as the pre-session
state. **The dormant half of that is not what a real, unmodified `npm ci`
produces**: this session's very first measurement — fresh worktree, stock
`node_modules` (npm-resolved, matching `package-lock.json` exactly),
`REGION_HOOKS_ACTIVE` at its committed default (`false`), the project's own
unmodified `test/kernel-oracle.js` — read **11/13**, the identical two rows,
434 assertions. Whatever prior session's dormant run produced 13/13 either
used the `node_modules/watr → /Users/div/projects/watr` symlink (silently
carrying `895ca5b` in) without naming it as load-bearing for the DORMANT
number specifically, or the claim was carried forward from an entry that
never actually re-verified dormant post-`895ca5b`. Either way: as of a
plain `npm ci` against this repo's committed `package-lock.json`, BOTH
configs are 11/13, not just region-live.

### Disposition — WALLED on landing, not on understanding

**No jz source change.** `git status`/`git diff` show nothing beyond this
ledger entry — the defect is entirely a stale THIRD-PARTY dependency
resolution, not a bug in any jz-owned file; there is nothing in `src/`,
`module/`, or `scripts/` for "no special-casing the oracle rows" to apply
to. `scripts/self.js`'s `REGION_HOOKS_ACTIVE` toggle was hand-flipped for
each build and reverted to its committed `false` every time (`git diff
scripts/self.js` clean at session end).

**Watr: no new fix authored — `895ca5b` already is the fix, already has its
own passing regression tests.** Created branch `wall2-fix-2026-08-13` at
`/Users/div/projects/watr`'s existing HEAD (`895ca5b`) as a discoverable
marker for this campaign, per the task's own commit protocol — zero new
diff (there is nothing to add; the fix predates this session by one day).
Not pushed. `origin/main` untouched.

**Landing requires publishing.** The pristine-pin policy this campaign has
maintained since the LAST HOP entry is correct and this session does not
override it: jz's `package.json`/`package-lock.json` were NOT touched, and
remain pinned to the real npm registry tarball (`5.7.14`, `a563a63`). The
single, concrete, already-fully-proven next step is: publish
`/Users/div/projects/watr` at `895ca5b` as a new npm release (a version
bump — `5.7.14` cannot be silently overwritten on the registry; something
like `5.7.15`), bump jz's `package.json`/`package-lock.json` pin to it, and
re-run the gate battery above — every number in the Gates section was
produced against exactly that content, so this is a mechanical unblock, not
a research question. **This is a publish action, explicitly out of this
session's authority ("do NOT publish") — flagged, not performed.**

**Therefore: NOT declaring "REGION FRONT COMPLETE candidate".** The gate's
own bar is 13/13 ×3 both configs from what actually ships — and what
actually ships (`npm ci` against the committed `package-lock.json`) is
still 11/13 both configs, identically to before this session, because the
one file that would change that cannot be committed here. What changes:
the wall is no longer "harder, still open, next lead is a runtime
`$__alloc`-entry stack-walk" — it is a fully root-caused, already-fixed,
already-tested defect one `npm publish` away from closing outright, plus
one small honestly-flagged separate residual (dormant's own
closure-numbering sensitivity) that publishing will silence again without
actually resolving.

**Next named lead, in priority order:**
1. Publish watr `895ca5b` (a human/gated action) and bump jz's pin — closes
   both oracle rows in both configs immediately, per the Gates above.
2. Fix the pin-verify convention itself: diff `node_modules/watr/src/*`
   against `/Users/div/projects/watr/src/*` directly (or just symlink and
   say so), not `watr.js`+`package.json` — the blind spot this session
   found is exactly why the LAST HOP's fix silently regressed across three
   sessions undetected.
3. Dormant's own residual closure-numbering sensitivity (Step 3 above) is
   real and unsolved — a genuinely open item for whoever next has budget for
   another `$closureN`-class hunt; it will keep resurfacing under different
   trigger names until it's found by a numbering-level technique, not a
   padding/ablation one (this session's own ablation only localizes it to
   "real AST content in a dead branch", it does not locate the miscompile
   itself).

**SHAs.** jz worktree: `98f60fe0` base, this session's only change is this
ledger entry. watr: `895ca5b` (`/Users/div/projects/watr`), unchanged;
branch `wall2-fix-2026-08-13` created at that commit, not pushed. Fixed-watr
gate builds (worktree-local overlay, not committed, discarded): region-live
`dist/jz.wasm` SHA-256 `a854a4c8…` (×2 identical); dormant `dist/jz.wasm`
SHA-256 `ffb6e45a…` (×2 identical).

## BigInt retirement design (2026-08-13)

`.work/bigint-retirement-design.md` — design-only (no `src/` changes),
answering the user decision made on `.work/feature-reach-census.md`'s
evidence (BigInt, all 3 paths, 0/130 real-corpus reach): retire the boxed
`PTR.BIGINT` carrier and every runtime-discrimination mechanism built to
cover an unproven BigInt flow (both the legacy magnitude-heuristic/
sentinel-export-lane machinery and the newer boxed-tag carrier from
`.work/carrier-representation-design.md` — confirmed still coexisting,
live, in the current tree), keeping only statically-proven raw i64
lowering. Full inventory (~1,440-1,460 lines across `src/ir.js`, `emit.js`,
`kind.js`, `layout.js`, `interop.js`, `module/*.js`, `test/pointers.js`,
`test/data.js`, `test/dyn-keys.js`), the kept-i64 contract (literal/
arithmetic/BigInt64Array stay; any flow into a kind-erasing sink becomes a
named compile error, reusing the existing `bigintBoxed` fixpoint walk with
its consequence flipped), test262 impact (zero — both runners already
pre-exclude every BigInt-featured test by content detection, so no row
currently passes via any path and no baseline floor moves), and — the
load-bearing finding — the self-hosted kernel (`scripts/self.js`, excluded
from the census's own corpus) genuinely uses BigInt in 21 source files and
its standard build currently needs the boxed carrier at 11 specific sites
(10 module-init consts, 1 helper param); deletion must be preceded by a
dedicated kernel-source-rewrite slice (Slice 0) or self-hosting breaks.
Six migration slices total, each gated on 130-program corpus byte-identity
plus (Slices 0-2 specifically) self-host build/kernel-parity survival.

## §VectorizerGenerality — recognizer taxonomy + consolidation design (2026-08-13)

Assessment + design only (no source change), full write-up:
`.work/vectorizer-generality-design.md`. Answers: can `src/optimize/
vectorize.js`'s 19-recognizer chain (feature-reach-census.md §9: 2
zero-reach, 6 single-specimen) be generalized or should it be cut, and is
shape-recognizer vectorization a valid strategy against LLVM-backed rivals
(rustc/zig/tinygo, all wasm32 targets in `bench/bench.mjs`) at all.

**Verdict**: 19 → 12 recognizers via precondition-superset merges (8
transform classes identified: MAP, REDUCTION, STENCIL, OUTER-STRIP,
CHANNEL-REDUCE, SLP, BUTTERFLY, BYTE-SCAN) — zero corpus-coverage loss.
Delete `tryByteScan` only (0/130, confirmed real via a working synthetic
repro). Strategy: shape-recognizer vectorization is valid for whole-idiom
fusion LLVM structurally can't reach (masked-divergent escape loops,
channel-parallel box-filter, bit-exact FFT butterfly) but invalid as sole
strategy for the ordinary MAP/REDUCTION/STENCIL classes (104/130 reach) —
those need AST-level affine/dependence proofs (reusing `static.js`'s
`intExprRange`/`forCounterRange`/`linearIndexOf` and `narrow.js`'s
`arrayReadProvenInBounds`, built for a different consumer today) to stop
missing every novel-but-ordinary loop a real dependence-driven vectorizer
would catch for free. Full taxonomy table, per-class generalization
sketch, rejected alternatives, migration order, and per-step bench-row
risk are in the design doc.

## §warm `_clear()` reuse: root-cause attempt on the two stdlib-registration
## hazards (walled — evidence banked) (2026-08-13)

**Task.** `6ffb28fc`'s `registerName` engineered AROUND two reproducible
warm-`_clear()`-reuse hazards found by bisection (a second large dict/Map
alive alongside `ctx.core.emit`'s own; ~150× string concatenation) without
root-causing the underlying `_clear()`/arena-reset contract bug. Asked to
reconstruct a minimal repro OUTSIDE the registration context, root-cause
what survives `_clear()` that shouldn't, and fix at the engine level.

**Method.** Isolated worktree (`/private/tmp/.../warm-clear`, branch
`warm-clear-2026-08-13`, base `36c14330` = main tip, `node_modules`
symlinked from the main checkout — reconfirmed byte-identical before and
after, aggregate SHA-256 `383d173f…`, `watr@5.7.14`).

**Seven repro attempts, all negative.** Each variant was built to the
letter of the ledger's own bisection description (`registerName`'s doc
comment, `.work/research.md` lines ~7416-7457 as of the previous entry),
scaled up, and verified live (not dead-code-eliminated) before being
declared a non-repro:

1. **Native `jz()`, module-level durable `Map`s** (two `const` Maps at
   program top-level, grown via pre-built literal keys — no concatenation
   — to 300 entries each, `_clear()`-then-recompile ×2). No trap.
2. **Native `jz()`, string concatenation only** (`site.push(a+'|'+b)`,
   the ledger's own literal repro shape, ×150, zero dicts). No trap — but
   revealed a SEPARATE, unrelated data-integrity issue worth flagging:
   `site.length` after one `_clear()`+regrow round read `154`, not the
   expected `150` (fresh) or `300` (if durable growth truly persisted) —
   the durable-array-forward-heal count is off by a small amount for this
   shape. Not chased (out of scope, banked as a lead below).
3. **Native `jz()`, `ctx.core = {...}`-shaped repro**: a durable
   module-level object (`holder`) whose FIELD gets reassigned to a fresh
   ephemeral `Map` every call (mirrors `reset()`'s actual
   `ctx.core = {emit: derive(proto), …}` pattern exactly) — one field vs
   two fields growing simultaneously. No trap.
4. **Native `jz()`, `derive(proto)`-shaped repro**: a FRESH LOCAL dict
   every call, seeded via object-spread from a small base object (mirrors
   `derive = obj => Object.assign(Object.create(null), obj)` exactly),
   grown to 300 own-properties — one dict vs two, `optimize:false` and
   `optimize:3`. No trap.
5. **Self-hosted kernel, batch second-dict probe**: `src/autoload.js`'s
   `includeModule` grows a second `ctx.core`-scoped dict by 20 pre-built-
   literal keys per module (≈400 entries over one compile), rebuilt
   `dist/jz.wasm`, ran `test/selfhost.js`. **21/21 pass** (no trap).
6. **Self-hosted kernel, `registerName`-embedded probe (bystander)**: the
   documented failing design reinstated literally — `ctx.core.__probeMap`
   (a `name → {module, dialect, value}` `Map`, exactly the ledger's own
   description) populated on every `registerName` call, alongside the
   shipped array tracking; plus `ctx.core.__probeConcat` (`module+'|'+
   dialect` via `+`, ~150-750×). Forced live via a genuine post-hoc read
   in `verifyEmitIntegrity` (`.get(name)` + field compare, not just
   `.size`) so no optimizer pass could prove the writes dead. Rebuilt,
   ran `test/selfhost.js` against the trivial `charCodeAt` subject
   AND a feature-rich subject pulling in 13-16 stdlib modules (measured
   natively: `regEmitOrder.length=48`, `emit` total `511` keys,
   `__probeConcat.length=151` — squarely inside the ledger's documented
   "150-600" scale). **21/21 pass both times** (no trap).
7. **Self-hosted kernel, `registerName`-embedded probe (primary check)**:
   same probe, but restructured so the `Map` is the PRIMARY collision
   check (`.has(name)` read before every write, mirroring `table[name]
   !== undefined`'s role exactly, not a bystander log) — the literal
   shape of "the first two working designs… used to attribute a
   collision". Rebuilt, ran `test/selfhost.js` (trivial subject, 21/21)
   and the rich-subject warm-reuse driver (3 rounds, byte-pinned vs
   fresh). **No trap either time.**

**Negative-control sanity check (critical).** Before trusting seven
non-reproductions, verified the test methodology itself CAN catch a real,
previously-documented regression: `src/ir.js`'s `clearDollar` carries an
explicit comment — *"Verified empirically: `.clear()` alone still trapped
`__hash_set_local` on the 2nd compile of a warm instance"* — for exactly
this hazard class (a durable `Map`'s backing table surviving `_clear()`
as a stale pointer when `.clear()`d in place instead of swapped for a
fresh `Map`). Reverted `clearDollar` from `DOLLAR = new Map()` (swap) to
`DOLLAR.clear()` (in-place, the documented-broken form), rebuilt, ran
`test/selfhost.js` against both the trivial and the rich-subject driver.
**21/21 pass, no trap — the known-bad historical shape does not
reproduce either.**

**Interpretation.** `git log -S` on the two relevant fixes: `clearDollar`'s
swap-not-clear fix is `42dc91c5` (2026-07-01, "warm-instance reuse"
specific). `647d6159` (2026-07-07, *"assemble: `_clear` restores
runtime-written module globals to their post-`__start` snapshot"* — the
GENERIC module-global-snapshot sweep, `src/wat/assemble.js` lines
~755-845) landed six days LATER. The generic sweep, plus the
`__durable_fwd_log`/`__durable_fwd_heal`/`__durable_slot_log`/
`__durable_slot_heal` machinery it wires into `_clear` (confirmed present
and reachable in the compiled kernel via `wasm-objdump -x dist/jz.wasm` —
`$__clear`, 862 bytes, calls into all four), was built explicitly to close
"the whole warm-reuse landmine class" as a BLANKET contract rather than
per-site patches. The most defensible reading of seven-for-seven negative
reproductions (including a documented, previously-verified-broken shape)
is that this later, more general hardening — landed AFTER both the
`clearDollar` fix (2026-07-01) and, per `6ffb28fc`'s own worktree-base
note, already present when the stdlib-registration bisection ran
(`e836e631` "already carries" the region-arena/export-template fixes) —
narrowed or closed the specific corruption windows the two documented
patterns exploited, WITHOUT anyone re-testing the original triggers
against the hardened kernel until now. This is offered as the best-
supported hypothesis, not a proof: the alternative (the original bisection
findings depended on exact byte-level code layout my reconstructions
didn't reproduce bit-for-bit — the same "highly layout-sensitive… but the
trigger… was not" caveat `f55ed89b`'s own entry names) cannot be ruled
out without the original session's exact diff, which no longer exists
(its worktree/branch was not preserved; `git branch -a`/`git worktree
list`/`find` turned up nothing).

**What this does NOT mean.** It does not mean `_clear()`'s contract is
now proven sound for arbitrary allocation patterns — only that the two
SPECIFIC documented patterns, reconstructed as faithfully as the ledger's
description permits and scaled to the documented range, no longer trip a
trap on current main. `registerName`'s array-based tracking (plain
arrays, no hot-path concatenation) remains the shipped, load-bearing
design — this session found no evidence it is now safe to relax back to a
`Map`, and did not attempt to (no `src/ctx.js`/`src/bridge.js`/
`src/autoload.js` changes landed; all probe code was reverted before
commit, confirmed via `git status --short` / `git diff --stat` clean).

**Next named leads for whoever picks this up:**
1. **Re-run the ORIGINAL bisection's exact diff**, if it can be recovered
   from reflog/shell history/editor buffers outside this repo — byte-for-
   byte reproduction is the only way to distinguish "fixed by later
   hardening" from "layout-sensitive, dodged by re-derivation" with
   certainty.
2. **The array-length discrepancy found in attempt 2** (`site.length`
   reads `154` after one durable-array grow-then-`_clear()`-then-regrow
   round of 150 pushes each, expected `150`) is a genuine, reproducible,
   currently-unexplained off-by-a-small-amount in the durable-array-
   forward-heal path — native, no self-hosting required, ~instant repro
   (`site.push(a+'|'+b)` × 150 in a loop, module-level `let site = []`,
   one `_clear()`, regrow, check `.length`). Worth its own investigation;
   not the same shape as an OOB trap but the same general "durable growth
   across `_clear()`" family, and unlike the two OOB patterns, THIS one
   reproduces on demand.
3. **Instrument `__durable_fwd_log`'s call COUNT** (not just presence) for
   a rich-subject warm-reuse round, to directly confirm whether
   `ctx.core.emit`'s own registration-time growth ever actually crosses a
   capacity-doubling boundary during a real compile — if it never grows
   past its `derive(proto)`-seeded initial capacity for realistic subject
   programs, the whole growth-forwarding path (and by extension the two
   documented hazards, which specifically implicated growth) may be
   COLD for every case that matters in practice, which would reframe the
   original finding as a genuine-but-practically-unreachable edge case
   rather than a live correctness gap.

**Gates (unmodified worktree, confirming main-tip parity before
concluding — no code changed, so these reconfirm rather than validate a
fix):** `node test/selfhost.js` 21/21 (206 assertions); native `npm test`
3438 total / **3431 pass** / **1 fail** (banked `typed RMW` pin, expected)
/ 6 skip; `test:wasm` 2733 total / **2727 pass** / **0 fail** / 6 skip;
self-build ×2 SHA-256 identical (`dist/jz.wasm` `b1b82b6e…`, `dist/jz.js`
`7ae917fb…`); `node_modules/watr` byte-identical before/after
(`383d173f…`, `5.7.14`).

**Files.** None changed — every probe (`src/ctx.js`, `src/autoload.js`,
`src/ir.js`) was reverted (`git checkout --`) before this entry was
written; `git status --short` / `git diff --stat` clean except this
ledger entry.
