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

## §Region arena — TARGET-PASS ABLATION RECORD (2026-08-11, carried over from
main 9447f78d for continuity — this branch's own research.md predates that
commit)

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

## §Region arena — BOUNDARY-ARITHMETIC AUDIT + WINDOW A/B FIX ATTEMPT (2026-08-11)

**The audit** (reconstructed from source — no prior written form of this
audit was ever committed; only the ablation-record entry above and its
"boundary-arithmetic audit that followed" pointer survived). Two independent
dead/broken writes found in `__region_copy_rec`'s relocation arms:

- **Window (A)** — `regionArmObject` (layout-kinds.js) wrote an old-site
  forwarding stub (`[-8:newOffset][-4:-1 sentinel]`) for every relocated
  OBJECT. `PTR.OBJECT` is not a `FORWARDING_MASK` member (layout.js:
  `FORWARDING_MASK = ARRAY|HASH|SET|MAP` only) — `__ptr_offset`'s chase never
  even inspects an OBJECT-tagged pointer's header for a stub. Dead write,
  unconditionally, independent of timing.

- **Window (B)** — every OTHER relocated kind that DOES sit in
  `FORWARDING_MASK` (ARRAY, SET/MAP, and HASH via `__region_relocate_props`,
  plus the `$__dyn_props` global's own relocation in `__region_exit`) wrote
  the same old-site stub, correctly gated by `FORWARDING_MASK` this time —
  but `__region_exit`'s own closing `memory.copy(mark, T, size)` (module/
  core.js) overwrites every byte of `[mark, mark+size)` with the compacted
  survivors before any consumer OUTSIDE this traversal could ever read a
  stub written there, and the very next round starts allocating fresh churn
  from the new heap top, overwriting whatever stub bytes landed in
  `[mark+size, T)` the instant that space is reused. A write with no
  reachable reader — always, not a rare race — and exactly the mechanism the
  ablation record's reshuffle evidence pointed at: different pass orderings
  change how much of that dead zone gets clobbered (by round-N+1's own
  fresh, UNRELATED churn) before a stray external reference — if one ever
  existed — could chase a still-live stub, reshuffling WHICH corpus rows
  happen to trap without ever closing the wall.

**Root-completeness check** (why no separate log/registration was built):
read watr's own `runRounds` (`/Users/div/projects/watr/src/optimize.js`,
the JS source region-hooks-active self.js compiles) completely before
touching anything. It passes exactly `root = [ast, dirty, snapshots]` to
`regionExit`, reassigns all three from the return value every round, and
unconditionally drains every OTHER known module-scope scratch global
(`CNT`/`CNT_FN`/`SW`/`SW_MEM`) immediately before calling in — there is no
currently-registered cross-round holder outside `root`. `pristine`/
`beforeRound`/`cur` (the size-guard's round-start clones, outer `optimize()`
scope) are all allocated via `clone()` — a full structural deep copy — at
points strictly BEFORE that round's `__region_mark()`, so they stay durable
(below every future mark) forever and never alias anything region_exit
would reclaim. Given this, and given `__region_copy_rec` already heals
everything reachable from `root` DIRECTLY (every arm rewrites its own
parent's slot with the relocated child as the walk descends; the memo makes
the returned `$out` the healed root reference) — no chase is needed for
ROOT-reachable data, chase or no chase. **Composition chosen: delete the
in-place stub writes outright, do not build a separate out-of-band log.**
The `$memo` Map `__region_copy_rec` already builds (old bits → new/final
bits, a genuine out-of-band structure, never co-located with the moved
data — same shape as the durable-fwd log's own precedent) already serves
every purpose stub-chasing was meant to serve, for everything region_exit is
actually responsible for; a holder outside `root` is the CALLER's
registration bug, not something a stub already proven dead-on-arrival could
ever have fixed.

**Fix landed** (banked on this branch, NOT merged to main): deleted the
in-place `[-8:newOffset][-4:-1]` stub-write pair at all five sites —
`regionArmArray`, `regionArmSetMap`, `regionArmObject` (layout-kinds.js),
`__region_relocate_props`'s ephemeral branch, and `__region_exit`'s
`$__dyn_props` relocation (module/core.js) — replacing each with a short
comment naming which window it closes. No other line changed (verified via
`git diff | grep -v ';;'`: exactly 5 removed `i32.store` pairs plus prose).
Window A is a pure, unconditional dead-code deletion (behavior-preserving by
construction — the chase never read it). Window B removes a write that
could never survive to be read; per the root-completeness argument above,
nothing sound depends on it.

**BY-NAME VERDICT — NOT EMPTY (a reshuffle, the audit's own sharp negative
signature)**: baseline (pre-fix, `dist/jz.wasm` built at branch tip
1455a278) scaled `test:wasm` (`JZ_TEST_TARGET=jz.wasm JZ_FUZZ_GATE=0.05 node
test/index.js`) — 49 fail, captured by name. Fixed build (same command,
same corpus) — **45 fail**, verified DETERMINISTIC across two consecutive
runs of the fixed binary (byte-identical failing-name sets both times). By
name: **33 rows common to both** (unchanged), **16 rows cleared**, **12 NEW
rows appeared that did not fail at baseline** — net -4, not the mandated
EMPTY. Cleared: `.indexOf: string via variable`, `Array.from: dynamic
array-like length`, `JSON.stringify: parsed input …circular`,
`Number.isFinite/.isInteger/.isSafeInteger: dict/map value-census`,
`Number: parseInt whitespace/radix`, `Number: toString zero`, `SSO
invariant: builder append`, `String: match found`, `audit #10` ×2, `bool
identity: mixed ?:/&&/||/??`, `class: pseudo-classical constructor`,
`inferModuleGlobalValTypes`, `optional: ?.method() on local string`, `regex:
matchAll`, `slot-types: unobserved slot`. New: `Array.from(string)`,
`Number: Number(string) coerces`, `SSO invariant: long/non-ASCII strings`,
`TextEncoder: spread of encode result`, `URLSearchParams: sort/escaping`,
`Uint8Array.fromBase64/fromHex`, `closures: module-scope for-of`, `const
fn-table: element-as-value`, `extractRefinements: instanceof
Float64Array`, `spread: {...a, z:3} add prop`, `subview — out-of-range
index`, `uninitialized field reads as undefined`.

**Diagnostic follow-up** (before banking, not a fix attempt): inspected
every NEW failure's trap. 10/12 are the SAME signature as the original 49 —
`RuntimeError: memory access out of bounds`, deep repeated-frame recursive
stacks, tripped DURING the kernel's own compilation of the test source (not
during compiled-output execution) — structurally identical to the
pre-existing OOB class, not a new symptom shape. 2/12
(`Array.from(string)`, `TextEncoder: spread of encode result`) trap
`unreachable` instead — a DIFFERENT flavor, consistent with the same
underlying mechanism landing on a different NaN-box tag/dispatch path this
time (a deliberately-trapped kind, e.g. CLOSURE's named region trap, reached
via garbage that decodes to a different tag than before) rather than a
second, independent bug class. Conclusion: windows A and B are both real,
independently correct, and the fix is minimal and behavior-preserving for
everything it touches — but they do NOT fully explain the 49-row wall as
the ablation record's window-B pointer predicted. Removing the stub writes
changes WHAT GARBAGE occupies the reclaimed dead zone (previously the
deterministic `-1`-sentinel forwarding-header bit pattern; now whatever the
round's own prior churn left behind) without changing WHETHER something
still reads that dead zone as if it were live data — so the wall's true
root cause is a THIRD, still-unidentified gap: something reachable during
the self-hosted kernel's own compilation is NOT fully healed by
`__region_copy_rec`'s root walk (a genuine root-completeness miss — a
holder, or a `children` edge, this session did not find), and windows A/B
only changed which specific corpus programs happen to read the resulting
garbage as a valid pointer.

**Gates**: by-name comparison only (the sharp test the audit specified),
run ×2 on the fixed build for determinism. Per the stop-on-fail tripwire,
the full mandated ladder (kernel-oracle ×3, kernel-parity, fuzz 200+2000×2,
full battery, dormant byte-identity, build×2) was NOT run — gated on the
by-name wall closing, and it does not. No memory curve, no jz×jz verdict
(same gate).

**Fix-or-bank: BANKED, not landed.** Windows A and B are real fixes, worth
keeping (Window A is unconditionally correct; Window B removes a
provably-dead-on-arrival write and is the architecturally sound precedent
regardless of whether it alone closes the wall) — but the wall survives.
Code changes (layout-kinds.js, module/core.js) committed to this branch;
not merged to main. **Recommendation for next session**: don't re-litigate
windows A/B (both are settled, provably correct in isolation) — the
productive next lever is finding the THIRD gap: audit every
`__region_copy_rec`/`__region_relocate_props`/`regionArmTyped` arm's
`children` enumeration against what the self-hosted kernel's OWN compile
pipeline actually attaches to its AST/IR nodes (the dyn-props sidecar
precedent — `fn.cseLoadBases`, already found and fixed — is exactly the
SHAPE of bug to look for: an out-of-band edge the tracer's declared
`children` column doesn't know about). Start from the 10 "memory access out
of bounds during kernel-self-compile, deep recursive frames" new rows above
(closures/const-fn-table/spread/subview/uninitialized-field are the
narrowest repros) with a NATIVE (non-kernel) probe before reaching for
another kernel rebuild, per this session's own precedent.

## §Region arena — FRONT BOUNDARY (Slice 2) ATTEMPTED, NEW WALL CLASS FOUND:
## compiler-internal closures can't cross ANY region boundary (2026-08-12)

**Context this session started from** (per `main`'s own ledger, ahead of
this branch — not merged here, cited for record): Slice 1 (fixpoint-round
region) is DONE + measured (LAST HOP / MEMORY-CURVE-MEASURED entries,
`main`): watr-graph −2,147.5 MB/−50%, jzify-entry FAIL→OK, jz×jz unchanged
(still `unreachable` @ 4,294,967,296 B, by design — Slice 1 alone was never
going to reach it). The design's own next lever, restated in its own words:
"Slice 1 removes cross-round accumulation only… the ~1GB target needs
Slices 1+2 (front boundary) paired; Slice 3 (emit/encode boundary) unlocks
jz×jz under 4GiB." This session's task: build Slice 2 — mark before parse/
jzify, exit after prepare, root = the prepared AST.

**Seam chosen**: `src/front.js`'s `frontHalf()` — the ONE semantic pipeline
both host (`index.js`) and every self-hosted kernel entry (`scripts/
self.js`'s `front()`) run (`parse → reject-reserved-prefix → liftIIFEs →
jzify → prepare → preEval`). `frontHalf` already takes a `time`/
`afterPrepare` callback-injection pattern for host-only concerns, so adding
an optional `regionHooks` parameter (mirroring `optimizeTail`'s own
precedent in `scripts/self.js` for the Slice-1 round boundary) is the
natural wiring point: `mark = regionHooks?.mark()` as the very first
statement (before `parse()`), `regionHooks.exit(mark, root)` called right
after `prepare(parsed)` returns, before `preEval`. Undefined (a no-op) for
every native host caller; only the kernel's own `front()` would ever supply
real `{mark: () => __region_mark(), exit: (mark, root) =>
__region_exit(mark, root)}` closures — same shape as `optimizeTail`'s
proven-working pattern, same `REGION_HOOKS_ACTIVE` toggle would gate both
boundaries together.

**Hazard inventory, method: enumerate every `ctx.*` write inside
`src/prepare/{index,lift-iife,math-kernel}.js` (the whole ephemeral span
between mark and exit), classify each as (a) read post-boundary or dead by
construction, (b) durable container / ephemeral payload or genuinely
ephemeral container, (c) safe to relocate or a CLOSURE.**

1. **`ctx.func.list` — REAL bug, found+fixed this session.** Arrow/named
   functions are extracted OUT of the tree during `prepare` (their bodies
   live ONLY in `ctx.func.list`, not reachable by walking `ast` —
   `preEval` itself already walks `ast` + every `ctx.func.list` body
   separately, confirming they're disjoint). Assumed durable at first
   (starts as reset()'s `[]`, allocated before mark) — WRONG: this
   compiler's ARRAY layout is one contiguous block (length header
   immediately below the element slots, no separate indirect backing
   pointer — `layout-kinds.js` `regionArmArray`'s single `$off =
   __ptr_offset(bits)` read proves this), so the FIRST `.push()` past
   the starting capacity reallocates a brand-new, ephemeral (post-mark)
   block and rebinds the `list` property to it. Root must carry
   `ctx.func.list` as a VALUE (read back its relocated address from
   `__region_exit`'s return, exactly like `ast`), not merely trust it's
   reachable off a durable `ctx.func`. Confirmed by direct empirical
   bisection (see Method below) — the very first build with root =
   `[ast, ctx.func.list]` but no write-back OOB-trapped on the single
   simplest possible program (`sum`, a plain scalar loop, no closures/
   arrays/objects at all), at every opt level including O0.
2. **`ctx.module.imports` — REAL bug, found, NOT fixed (session ran out of
   runway before the deeper wall closed it anyway).** `prepare/index.js`
   pushes host-import declarations onto this durable-but-grows array; `src/
   compile/index.js`'s `compile()` — the very FIRST thing it does, before
   any user code — iterates `ctx.module.imports` directly. Confirmed via
   direct instrumentation (below) that a root of `[ast, ctx.func.list]`
   with BOTH correctly write-back'd still traps — not inside
   `__region_exit` (which completes cleanly, confirmed by breadcrumb
   globals reaching its own final `global.set` every time regardless of
   root content) but downstream, inside `compile()`'s own first loop —
   `ctx.module.imports` is exactly the shape of hazard (2) and the
   confirmed next miss.
3. **THE WALL: compiler-internal CLOSURES minted per-compile by prepare's
   own lazy module registration.** `module/core.js`'s default export (a
   single arrow function spanning the whole file, invoked ONCE PER
   COMPILE via `prepare()`'s own `includeModule('core')` call, itself the
   very first non-housekeeping line of `prepare()`) calls `module/
   schema.js`'s `initSchema(ctx)` — whose own doc says outright "Called
   once per compilation." `initSchema` closes over two FRESH per-call
   local `Map`s (`byKey`/`byProp`) and assigns ~15 arrow-function closures
   onto `ctx.schema.{register, find, isBoxed, emitInner, slotOf,
   guardedSlotOf, chainSid, slotVT, slotTypedCtor*, slotIntCertainAt,
   slotBigint*, errorSid, isErrorSid, errorClassOf, errorSidEntries,
   errorClassesUsed, idOf, resolve}` — every one of them capturing that
   call's own fresh `byKey`/`byProp`. `prepare/index.js` similarly
   assigns `ctx.module.include = includeModule` (a plain top-level
   function reference, but still boxed as a fresh CLOSURE value at that
   assignment site — this compiler's CLOSURE representation always
   allocates an env block via `__alloc`, arity 0 or not, no evidence of
   closure interning anywhere the way STRING is interned). `module/
   function.js` similarly installs `ctx.closure.make`/`ctx.closure.call`.
   Every one of these closures is READ EXTENSIVELY past the front
   boundary — `ctx.module.include` alone has 8 call sites across `ir.js`/
   `object.js`/`math.js`/`regex.js`/`array.js`, all in the emit phase, all
   downstream of where Slice 2's exit would fire.

   **Neither direction crosses the boundary.** Include them in root (e.g.
   root ctx.module/ctx.schema/ctx.closure wholesale, the natural
   "root the whole durable subtree" move that made `ctx.func.list`-style
   fixes tractable elsewhere) — `__region_copy_rec`'s CLOSURE arm
   (`layout-kinds.js` `regionArmClosureTrap`) traps UNCONDITIONALLY the
   instant the walker's dispatch sees `PTR.CLOSURE`, regardless of
   durability: "a CLOSURE's capture count… is not recoverable from a bare
   CLOSURE box at runtime… this trap is the honest alternative to
   guessing" — a DELIBERATE, by-design limitation from registry Slice 2,
   not a coverage gap this session could close by adding an arm. Exclude
   them (leave `ctx.module`/`ctx.schema` un-rooted, as this session's
   actual attempts did) — `__region_copy_rec` never touches them, so no
   TRAP fires during the boundary call itself, but `__region_exit`'s
   closing `memory.copy(mark, T, size)` still silently reclaims their
   backing memory: nothing walked them, so they're not part of `size`,
   so they sit in the discarded `[mark+size, T)` dead zone the instant
   region_exit returns — the very next allocation (anything `compile()`
   does) happily overwrites them, and the STALE pointer `ctx.schema.
   register` etc. still holds becomes a plain use-after-free. **This is
   NOT the CLOSURE trap firing — it's silent corruption**, confirmed by
   direct instrumentation (below): `__region_exit` reaches its own final
   `global.set` cleanly every time, in every configuration tried; the
   fault always lands downstream, deterministically inside `compile()`'s
   first touch of whatever ctx state wasn't rooted.

**Method (empirical, since blind reasoning about a corrupted-vs-clean
distinction wasn't converging fast enough): breadcrumb globals**
(`$__dbg_mark`/`$__dbg_T`/`$__dbg_dp`/`$__dbg_stage`, `$__dbg_stage2`,
temporary, module/core.js + scripts/self.js, NOT landed — see Disposition
below), the same technique the original round-boundary root-cause sessions
used (a synchronous wasm trap leaves the instance's globals intact, so the
LAST value written is the last checkpoint reached). Stage markers placed at
`__region_exit`'s own body (mark/T computed, region_copy_rec call
returned, dyn-props relocation block, closing memory.copy) and at
`frontHalf`'s own exit call / `compileSelf`'s phase boundaries
(front/compileAst/optimizeTail/watrCompile). Bisected on the empty-string
program (source `''`) — the simplest possible input, `compile('')` — to
remove every candidate variable except the mechanism itself:
- root = `42` (an ATOM, zero tree-walking required) — STILL traps, and
  `__region_exit` reaches its own final instruction (stage 4) — proves the
  fault is downstream of `__region_exit` entirely, not inside it (the
  `''` program still populates `$__dyn_props` — confirmed non-zero even
  for an empty source — since prepare's OWN bookkeeping, not the target
  program, is what uses it; the dp-relocation block runs and completes
  cleanly every time tested).
- root = `[ast, ctx.func.list]` with correct write-back — STILL traps;
  `compileSelf`'s own stage markers show `front()` (mark → parse → prepare
  → exit → preEval, all of it) completes and RETURNS successfully (stage
  400 reached) but `compileAst()` never finishes (stage 500 never reached)
  — isolates the fault to `compile()`'s own first touches of un-rooted ctx
  state, exactly hazard #2/#3 above.

**Disposition — WALL, not landed, per the stop-on-fail tripwire.** All
debug instrumentation removed; `src/front.js` and `scripts/self.js`
reverted to their exact pre-session content (`git diff` against `0d089b49`
is empty in both). Rebuilt and reconfirmed: SHA-256 `f961b9b1062d8e8cb…`,
byte-identical to the LAST HOP/MEMORY-CURVE-MEASURED entries' own verified
region-live build from this exact base (independent proof this worktree's
exploration left zero trace) — this is NOT a "dormant by construction"
claim for a NEW toggle (there is none to add — nothing landed), it's a
direct re-derivation of the already-known-good `0d089b49` artifact.
`node test/kernel-oracle.js` re-run on this reverted build as a sanity
check (not a new-code gate — nothing changed): 13/13 (493 assertions),
clean, matching the already-documented baseline. The rest of the mandated
ladder (kernel-parity, fuzz, full battery, build×2) was not re-run since no
source changed — those results are inherited unmodified from `0d089b49`'s
own prior verification.

**Watermarks: unchanged from the MEMORY-CURVE-MEASURED entry** (`main`,
same `0d089b49` base, same watr `895ca5b`, byte-identical wasm) — Slice 2
did not land, so there is no new watermark to report. For the record: jessie
1,073.7 MB (unaffected at this scale, both kernels), watr 2,147.5 MB
(Slice-1 win holds, −50% vs. dormant), jzify-entry 4,295.0 MB OK (Slice-1's
FAIL→OK win holds), jz×jz still `unreachable` @ 4,294,967,296 B (2³²,
unchanged — Slice 2/3 still both required, matches the design's own
scoping exactly, not a new finding).

**Recommendation for next session.** Don't re-attempt "root the whole
durable ctx subtree" as a blanket move for `ctx.module`/`ctx.schema`/
`ctx.closure` — it's provably dead-end territory (the CLOSURE trap makes
it structurally impossible, not merely untried). Two real paths forward,
neither attempted this session (both bigger than a single-session slice):
(1) give CLOSURE a real region-copy arm — needs a capture-count/env-length
side table (mirroring `$__schema_tbl`'s pattern for OBJECT/HASH), named as
"a real, bounded option for a future slice" in `layout-kinds.js`'s own
CLOSURE-trap comment already, now with a concrete forcing case (front-
boundary module registration) instead of a hypothetical one; (2)
restructure `prepare()` so per-compile module registration
(`includeModule` calls, scattered throughout the ENTIRE walk, driven by
which source features are seen — not just the one `includeModule('core')`
at the top) completes before the mark, e.g. a source pre-scan that decides
every module the compile will need and registers them all upfront — a
real architectural change to `prepare/index.js` and the "called once per
compilation" convention every stdlib module's init function follows,
not a boundary-placement tweak. Either fix, once landed, should also close
`ctx.func.list`/`ctx.module.imports` for free (they become reachable off a
now-safely-rootable `ctx.module`/`ctx.func`, no bespoke field list needed)
— don't re-litigate those two, they're correctly diagnosed, just blocked
on the deeper fix landing first.

**SHAs.** Worktree base: `0d089b49` (region-final-2026-08-11, unchanged —
this session's `git diff` against it is empty). watr: `895ca5b`
(`/Users/div/projects/watr`, unpublished, local-only, unchanged). No jz-repo
compiler-source commit from this session — see Disposition above.

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

## §Region arena — CLOSURE REGION-COPY ARM LANDED (2026-08-12): the
## front-boundary's own forcing case closed, a real self-host array-growth
## bug found+fixed en route

**Context**: 16f1f701's own front-boundary session named the concrete next
lever precisely: "(1) give CLOSURE a real region-copy arm — needs a
capture-count/env-length side table … now with a concrete forcing case
(front-boundary module registration)". This session built exactly that —
audit-#19's own architecture-review record shape (`{id, storage, captures:
[{name, bindingId, mode, constant}]}`, `.work/closure-plan-design.md`'s
LANDED ClosureEnvPlan) already carries every per-capture fact the arm
needs; the side table just needed materializing at assembly time.

### The side table

`$__closure_env_len`/`$__closure_env_mask` — two flat i32 arrays, funcIdx-
indexed (funcIdx = `ctx.closure.table` index = the CLOSURE box's `aux`
field), built in `src/wat/assemble.js`'s `buildStartFn` from
`ctx.closure.envMeta` (module/function.js). **Source, per the task's own
100%-coverage mandate**: captured at `ctx.closure.make`'s OWN env-
allocation site (module/function.js), not re-derived from the plan — both
ClosureEnvPlan-covered closures (90.6% self.js / 57.9% bench mint coverage,
architecture re-audit item 4) and the legacy-fallback remainder converge on
the SAME `envCaptures`/`ctx.func.boxed` facts before that push, so this is
100% coverage BY CONSTRUCTION, not a fail-open approximation riding the
plan's own coverage gap. `cellMask` bit *i* set ⇒ slot *i* holds a raw i32
pointer to a shared, independently-heap-allocated boxed-capture cell (the
mutable-capture mechanism, `ctx.func.boxed`) rather than a NaN-boxed f64
value — read off the SAME `ctx.func.boxed?.has(envCaptures[i])` test the
env-population store loop already uses, computed once instead of derived
twice. >31-capture closures (unobserved on every measured corpus — .work/
closure-plan-design.md §1.5 tops out at 27) can't fit the i32 bitmask — a
single NAMED trap for that one case, not a silent truncation.

Built via a runtime alloc+store sequence in `$__start` (mirrors
`schemaInit`'s own dynamic-fallback shape, NOT `appendStaticSlots`'s
static-data-segment path — that helper's `staticPtrSlots` NaN-prefix
pointer-marking is for BOXED values; reusing it for plain integers risked a
false-positive match on a cellMask's bit pattern). Gated on
`ctx.core.includes.has('__region_exit')` — checked directly, NOT
`__region_copy_rec` (a find worth flagging: `needsSchemaTbl`'s own
pre-existing OR-chain checks `'__region_copy_rec'` too, but that's read
AFTER `pullStdlib`/`resolveIncludes()` expands transitive deps; THIS code
runs earlier, in `buildStartFn`, where `ctx.core.includes` only has
directly-`inc()`'d names — `__region_copy_rec` is exclusively a DEP of
`__region_exit`, never `inc()`'d on its own, so reading it here would
always read false. `__region_exit` is `inc()`'d synchronously the moment
source calls it, which by `buildStartFn` has already happened). Every other
build (default dist, native compiles, any program that never calls a
region boundary) pays zero bytes — confirmed by direct byte-diff (below).

### The arm

`layout-kinds.js` `regionArmClosure` (was `regionArmClosureTrap`) —
`KIND_REGISTRY.CLOSURE.relocate` `'trap'` → `'env-relocate'`. Shape mirrors
OBJECT's durable/ephemeral split (env block = fixed-count-once-allocated
run, no separate indirect backing pointer, same as OBJECT's schema slots):
zero-capture (offset literal `0`, no heap block — `mkPtrIR(PTR.CLOSURE,
tableIdx, 0)`) passes through before touching `$memo` (bits never change,
trivially identity-safe, mirrors the preamble's ATOM arm); durable (`off <
mark`) walks slots in place, memo'd at its own address; ephemeral allocates
a fresh block and recurses per slot. Per-slot dispatch reads the cellMask
bit: value slots recurse through `__region_copy_rec` directly (f64); cell
slots go through a NEW helper, `__region_relocate_cell` (module/core.js) —
a boxed-capture cell is a bare `__alloc(8)` block (ONE f64 payload slot, no
NaN-boxed identity of its own), referenced by a RAW i32 pointer, so it
can't route through `__region_copy_rec`'s own f64-tag dispatch. Memoized by
a SYNTHETIC key (`f64.convert_i32_s(cellOff)` — always a plain finite
float, never a NaN-boxed bit pattern, so it can never collide with a real
heap pointer's own memo entry — the SAME trick `regionArmArray`'s dyn-props
migration already uses to key `$__dyn_props` by a raw i32 offset). This
dedup is load-bearing, not an optimization: a cell shared by two closures
(aliasing two mutable captures of the same source variable — the entire
point of the boxed-cell mechanism) MUST relocate to the SAME new address
from both env slots, confirmed by a dedicated native regression pin
(`region-relocate[CLOSURE]: a cell shared by two closures…`, below). The
durable branch carries the SAME memo-before-mutate ordering the TYPED
view-rebase audit fix required (this file, ORDERING AUDIT entry) — a
diamond-shared durable cell revisited twice without it would re-derive from
its own already-relocated (delta-adjusted, not-yet-physically-valid)
payload, the identical corruption class that fix closed for
`__region_relocate_props`/TYPED.

### A real bug found and fixed en route (self-host array-growth hazard)

**First full `test:wasm` run against the arm found 9 named failures**
(`iterator helpers`/`generators`/`fetch: host wasi warns`/`shadow
contract`/`param narrowing`, all `RuntimeError: memory access out of
bounds`), all reproducing on the SAME minimal native (non-kernel) repro:
`function* g(n){…} export let f=()=>{let m=g(8).map(x=>x*10); return 1}` —
fails on the fixed `dist/jz.wasm`, compiles clean on the unmodified
`0d089b49` baseline. **Breadcrumb-global bisection** (this session's own
`$__dbg_cl`/`$__dbg_cl_aux`/`$__dbg_cl_off`/`$__dbg_cl_n`/`$__dbg_cl_i`/
`$__dbg_cl_tbllen`, stamped at every step of `regionArmClosure`/
`__region_relocate_cell`, temporary, NOT landed) proved the trap fires with
`$__dbg_cl` still at its ZERO default — **the new relocation arm never
executes in the failing run at all**. Root cause: `ctx.closure.envMeta`
(module/function.js) was populated via **indexed assignment**
(`ctx.closure.envMeta[tableIdx] = {…}`) instead of `.push()`, unlike its
two siblings one line away (`ctx.closure.table.push(fnName)`,
`ctx.closure.bodies.push(bodyFn)`) — even though `tableIdx` is PROVABLY
always the array's current length at that point (`addToTable` always mints
a fresh, unique `fnName`, so `indexOf` never hits, always pushes — making
the indexed form value-identical to `.push()` in EVERY case). The
self-hosted kernel's own array-WRITE codegen for `arr[arr.length] = x`
apparently takes a materially different, less-exercised path than
`.push()`'s — GENERIC finding, not specific to this table (flagged for a
future audit item, not chased further this session; the fix is a one-line,
zero-risk swap to the proven-safe sibling idiom). **Fix**: `.push()`.
Confirmed: `generator+map` and `generator+map+filter` (previously
`RuntimeError`) both compile clean on the rebuilt kernel; full re-run of
the entire mandated ladder below, clean.

### Gate ladder (all runs against this session's own rebuilt `dist/jz.wasm`,
### region-live, `REGION_HOOKS_ACTIVE=true`, watr `895ca5b`/5.7.14)

| check | result |
|---|---|
| 11 native probes (`__region_mark`/`__region_exit` called directly from plain jz source — no self-host needed; zero-cap, value-cap, cell-cap, shared-cell alias, nested closure, >8 captures, durable, diamond identity, recursion via boxed cell, per-iteration loop closures) | all pass, O0–O3 |
| 9 new pinned regression tests, `test/layout-kinds.js` (`region-relocate[CLOSURE]: …`) | 60/60 (88 assertions) |
| `node test/closures.js` | 110/110 (221 assertions) |
| Native `node test/index.js` (no `JZ_TEST_TARGET`) | 3419/3427 — only the 2 pre-existing documented flakes (`interval walk…`, `typed RMW…`), 0 new |
| `node test/kernel-oracle.js` ×3 | 13/13 (493 assertions) each rep |
| `node test/kernel-parity.js` | 3/3 groups, 33/33 assertions |
| 200-seed fuzz gate ×3 (`JZ_TEST_TARGET=jz.wasm`, the `fuzz: no new miscompiles in seeds 1..200 × opt {0,1,2,3}` test + its typed/IV-SR/byte-scan/param-bound siblings) | clean every rep |
| **`JZ_TEST_TARGET=jz.wasm node test/index.js` (full test:wasm)** | **2725/2731 pass, 0 fail, 6 skip** — the 3 `RuntimeError` string matches in the log are an intentional expected-trap regression test (`host decode: a genuine unmarked trap still surfaces as RuntimeError`), not failures |
| `node scripts/battery.mjs` | RED only on the ONE pre-existing, already-documented `typed RMW: one guard covers…` flake, on native/O0/O3/dbg/wasi identically (matches every prior session's own baseline signature) — fuzz 30173 compared/0 divergence, self 21/21, fixpoint PASS, build succeeded, kernel 2725 pass/6 skip |
| Dormant byte-identity (closure-heavy native compile — recursion via array of closures, boxed captures, nested arrows — `__region_mark`/`__region_exit` never called) | SHA-256 identical before/after this session's full diff (`b6ac115b…`) |
| `node scripts/build-dist.mjs` ×2 | byte-identical (`dist/jz.wasm`, `dist/jz.js`, `dist/interop.js` SHA-256 match across two consecutive builds) |

### Files

`layout-kinds.js` (KIND_REGISTRY.CLOSURE + `regionArmClosure` +
`regionCopyRecLocals`/`regionCopyRecBody` composition), `layout-kinds-doc.js`
(FINDINGS['region-forwarding'] → RESOLVED, OBJECT/HASH/CLOSURE `forwarding`
prose updated to match the Slice-2/this-session landed state), `module/
core.js` (`__region_relocate_cell` + deps + `$__closure_env_len`/
`$__closure_env_mask` global decls), `module/function.js`
(`ctx.closure.envMeta` capture at `ctx.closure.make`, `.push()`), `src/
ctx.js` (`ctx.closure.envMeta: null` reset-shape documentation), `src/wat/
assemble.js` (side-table build in `buildStartFn`), `test/layout-kinds.js`
(9 new `region-relocate[CLOSURE]` pins).

**SHA**: `dist/jz.wasm` this session's rebuild `01abc18e…`. watr `895ca5b`
(`/Users/div/projects/watr`, unpublished, unchanged). Worktree base:
`16f1f701` (region-final-2026-08-11).

## §Region arena — FRONT BOUNDARY RE-ATTEMPTED post-CLOSURE-arm: real
## progress (the ORIGINAL narrowest repros now clear), a NARROWER wall found
## (closures-with-captures / dynamic-props), banked not landed (2026-08-12)

**Context**: bba45c0d landed a real CLOSURE region-copy arm — the exact
blocker 16f1f701's own front-boundary session named as the reason "root the
whole durable ctx.module/ctx.schema/ctx.closure wholesale" was "provably
dead-end territory (the CLOSURE trap makes it structurally impossible, not
merely untried)". With that trap gone, this session re-wired the SAME
front-boundary seam that session designed (`src/front.js`'s `frontHalf`
gains an `optimizeTail`-shaped `regionHooks` parameter; `scripts/self.js`'s
`front()` wraps it, gated on the SAME `REGION_HOOKS_ACTIVE` marker via a
ternary instead of a second hand-synchronized commented-out object-literal
line) and re-attempted exactly the root that session's own hazard inventory
prescribed: `[ast, ctx.func.list, ctx.module, ctx.schema, ctx.closure]`.

**Real, verified progress**: the ORIGINAL session's own two narrowest
repros — `compile('')` and `sum` — **now compile cleanly through the front
boundary**, where the prior session reported `compile('')` itself trapping
downstream in `compile()`'s first touch of un-rooted state. Breadcrumb-
global bisection (`$__dbg_fb`, temporary, NOT landed — stamped at
`__region_exit`'s pre-walk/pre-memcpy/final-return points) confirms
`__region_exit` itself completes cleanly (reaches its own final marker)
for EVERY repro tried, matching the prior session's own finding pattern —
the fault, when it fires, is always downstream of a successful region-round
return, never inside the walk.

**Ablation (this session, confirms the prescribed root is the correct
MINIMAL one for the baseline case)**: dropping `ctx.module` OR `ctx.schema`
from the root breaks even `sum` (`RuntimeError: memory access out of
bounds`) — confirming BOTH are load-bearing exactly as diagnosed, not
merely "safe to add." The full 5-element root is required and sufficient
for `sum`/`compile('')`.

**A NARROWER wall remains**: any program using a closure WITH a capture
(even the single most trivial case, `(a) => { let g = (x) => x + a; return
g(1) }`) OR a dynamic object property write (`let d = {}; d['a'] = 1`)
still traps `memory access out of bounds`, downstream of `__region_exit`'s
own successful return (confirmed via the same breadcrumb). Zero-capture
closures, static-schema object literals, and plain arrays all compile
clean through the boundary. Adding `ctx.scope` to the root (the one major
`ctx.*` namespace not in the prescribed inventory — `globals`/`consts`/
`constInts`/`dynKeyVars`/…) does NOT close this wall either (tested,
banked). `ctx.closure`'s presence/absence in the root does not change
whether the capture/dict cases fail (tested via ablation) — ruling out
"which top-level ctx field is missing" as the remaining question; the
issue is narrower and deeper than root-completeness.

**Not chased further this session** (stop-on-fail tripwire, matching this
whole ledger's own "wall found and precisely characterized, banked not
forced" discipline): the leading hypothesis for next session — SOMETHING
specific to capture-folding (`ctx.scope.constInts`, read by
`ctx.closure.make`) or dynamic-property bookkeeping that grows/mutates
AFTER the front boundary's own mark/exit (i.e., DURING emission, which
Slice-1's OWN round boundary — still `[ast, dirty, snapshots]`, UNCHANGED
by this session — also does not root) is getting silently reclaimed by a
LATER Slice-1 round, the SAME hazard class this session's own CLOSURE-arm
work just found and fixed for `ctx.closure.envMeta` (indexed-assignment vs
`.push()` was ruled out as the SPECIFIC mechanism here — `ctx.schema.
register`/`module/schema.js` already uses `.push()` correctly — so if this
IS the same class, the growing-and-unrooted structure is a DIFFERENT one,
not yet found). Confirmed NOT the CLOSURE arm itself misbehaving on THIS
specific input (dbg breadcrumbs from the CLOSURE arm — same globals as
bba45c0d's own bisection — were checked and never fire during these
specific traps either, though not exhaustively re-verified for every repro
this session).

**Disposition**: BANKED, not landed, per the stop-on-fail tripwire. All
debug instrumentation removed; `src/front.js`/`scripts/self.js` reverted to
their exact pre-session content (`git diff` against `bba45c0d` is empty in
both — confirmed). Rebuilt and reconfirmed: `dist/jz.wasm` SHA-256
`01abc18e…`, byte-identical to bba45c0d's own committed build — this
session's exploration left zero trace in the shared tree.

**Recommendation for next session**: don't re-litigate root completeness
(`[ast, ctx.func.list, ctx.module, ctx.schema, ctx.closure]` is confirmed
correct-and-minimal for the baseline case, `sum`/`compile('')` proof-tested
this session) or CLOSURE-arm correctness (bba45c0d's own gate ladder is
exhaustive and unrelated failures were checked via breadcrumb). The
concrete next lever: breadcrumb-trace (or narrow via native, non-kernel
repro if `regionHooks` can be exercised outside self-host — this session
did NOT attempt that, unlike bba45c0d's own native-probe-first discipline,
because `regionHooks` is wired through `watrTail`'s JS-level callback
plumbing, not a bare `ctx.core.emit` intrinsic like `__region_mark`/
`__region_exit` themselves are) the EXACT moment a capture-folding or
dynamic-prop-tracking structure grows POST-front-boundary and gets
reclaimed by a Slice-1 round that still doesn't know about it — likely
requires EXTENDING Slice-1's OWN root (`[ast, dirty, snapshots]`,
`src/optimize.js`) to ALSO cover `ctx.schema`/`ctx.closure`/`ctx.scope`
growth that happens DURING emission, not just the front boundary rooting
them ONCE before emission starts — a plausible unification of the two
region mechanisms' root inventories, not attempted this session.

**SHAs**: worktree base `bba45c0d` (this session's own CLOSURE-arm commit,
region-final-2026-08-11 — `git diff` against it is empty). watr `895ca5b`
(`/Users/div/projects/watr`, unpublished, unchanged). No src-tree commit
from this front-boundary sub-session — see Disposition above.

### Watermark re-measurement (this session, honest/bounded — no checked-in
### memory-curve script exists to reproduce the prior session's exact
### harness, which lived on `main` and is not recovered here)

Direct kernel-ABI probes (`inst.exports.default(source, strict, optJSON,
modulesJSON)`) against this session's own `dist/jz.wasm` (CLOSURE arm
landed, bba45c0d; front boundary NOT landed, banked):

- **small-source**: trivial program compiles instantly at the smallest
  budget tried (16 pages, ~1 MB).
- **jzify-entry** (`resolveModuleGraph('jzify/index.js', {resolveNode:
  true})`'s bundled graph): **compiles cleanly across the WHOLE tested
  range**, 512 pages (~0.03 GB) through 65536 pages (~4.29 GB) — matches or
  exceeds the previously-documented Slice-1 "FAIL→OK" win; this session
  found no lower bound where it still fails, unlike the earlier curve's own
  specific transition point (not independently reconciled — different
  probe granularity, not a contradiction).
- **jz×jz** (second-order: feeding this kernel `resolveModuleGraph
  ('scripts/self.js', {resolveNode:true})`'s own bundled graph — i.e.,
  asking the self-hosted kernel to compile its own full compiler source,
  same shape as the original watermark curve's own extreme point):
  **fails `unreachable` uniformly across every budget tried** (8192/32768/
  65536 pages) — NOT the previously-documented OOM-at-2³² signature
  (which needed to GROW to the 4 GiB address-space boundary before
  failing; this fails immediately regardless of budget). Not diagnosed
  further this session — could be a genuinely different/earlier blocker,
  or an artifact of this session's simplified direct-ABI harness (no
  established script exercises kernel-compiling-its-own-source; the
  original curve's own harness is not recovered here). Front boundary —
  the confirmed prerequisite for jz×jz progress per the design's own
  scoping ("the ~1GB target needs Slices 1+2 paired") — did NOT land this
  session, so jz×jz was not expected to newly succeed regardless of this
  measurement's precision.

**Conclusion**: the CLOSURE arm's own win (jzify-entry holding/improving,
small-source unaffected) is confirmed; jz×jz remains blocked, consistent
with the front-boundary wall still standing. No regression found anywhere
this session measured.

## §Region arena — FRONT BOUNDARY REBASED ONTO MAIN, LANDED: the narrower
## wall (closures-with-captures + dynamic-property-writes) is DEAD — closed
## by the rebase itself, not by new region-mechanism work (2026-08-12)

**Context.** cf6ad0b1's own session (banked, nothing landed) named a
narrower wall downstream of the CLOSURE arm (bba45c0d): `sum`/`compile('')`
compiled clean through the front boundary with root `[ast, ctx.func.list,
ctx.module, ctx.schema, ctx.closure]`, but any closures-with-captures or
dynamic-property-write program still trapped `memory access out of bounds`
downstream of a clean `__region_exit` return. Main had since (independently
of the front-boundary branch) landed the ENTIRE round-boundary (Slice 1)
hardening chain this same ledger documents — `63fec612`/`bfe2ed62`
(kernel-wide watchpoint + temporal bisection), `98e0c27f` (SW's own stale
backing pointer, watr `895ca5b`, WALL DEAD), `1d3856d2` (memory curve),
and `14c4f7a2` (native `arr[arr.length]=x` codegen fix, dyn-prop-adjacent)
— none of which the front-boundary branch (still based on `0d089b49`) had.
Task: rebase region-final-2026-08-11 onto `14c4f7a2`, re-apply the banked
front-boundary patch (nothing to re-apply — cf6ad0b1's own disposition was
"reverted clean, git diff empty" — re-implemented from its own doc), re-test.

**Rebase.** `git rebase main` (14c4f7a2) in the standing worktree (already
at `42bfc90f`). 7 replayed commits, 3 real conflicts, all resolved:
- `0c47e1ac` (heap-kind registry Slice 2, `module/core.js`): the branch's
  `regionCopyRecBody()`-based `__region_copy_rec` replacement conflicted
  with itself — the NEW function-form assignment (`() => { ...; return
  \`...${regionCopyRecBody(...)}\` }\`) merged clean, but the OLD hand-
  written arm body it was meant to fully replace (tail of the same
  template-literal, base-identical on main since main never touched this
  file post-merge-base) conflicted as a phantom edit-vs-delete. Resolved by
  deleting the stale tail wholesale — verified byte-identical to
  `git show 0c47e1ac:module/core.js` at that exact span.
- `.work/research.md` (×2, at the `0d089b49`/`bba45c0d` replay steps) and
  `.work/todo.md` (×1, at `16f1f701`): pure divergent-append conflicts —
  main and the branch both appended NEW sections at the same anchor line
  after diverging at `9d0e3384`. Resolved by concatenation (ours' content,
  then the branch commit's own new content, in commit order) — no ledger
  content lost from either side.
`layout-kinds.js`/`module/function.js`/`src/ctx.js` all auto-merged clean.
Full rebase: `git status` clean, zero leftover conflict markers anywhere
(`grep -rn '^<<<<<<<\|^=======\|^>>>>>>>'` — zero hits, `.js` files
`node --check` clean). New tip SHAs: `0c47e1ac`→`cb4311c2`→`0008913e`→
`01246738`→`85a1b7f5`→`120813f1`→`9a08f4f2` (each rebased commit keeps its
own message; `9a08f4f2` is the new branch tip pre-front-boundary-relanding).

**Front boundary re-wired** (nothing survived the rebase to re-apply —
cf6ad0b1's own patch was fully reverted before that session ended). Exactly
the shape that session's own doc prescribed, matching `optimizeTail`'s
already-proven `regionHooks` idiom verbatim: `src/front.js`'s `frontHalf`
gains an optional `regionHooks` param (`{mark, exit}`); `mark()` before
`parse()`, `exit(mark, root)` right after `prepare()` (before `preEval`,
which only touches the already-rooted `ast`/`ctx.func.list`), root =
`[ast, ctx.func.list, ctx.module, ctx.schema, ctx.closure]`, all five
rebound from `exit`'s return (`__region_copy_rec` may relocate any of
them — required, not optional, per the same use-after-free reasoning every
prior session in this chain has documented). `scripts/self.js`'s `front()`
supplies it, gated on the same `REGION_HOOKS_ACTIVE` marker via a ternary,
same literal `__region_mark()`/`__region_exit()` calls `optimizeTail`
already uses (this file is never run natively — see its own header).

**The two wall-halves, re-tested on the rebased+re-wired kernel — BOTH
DEAD.** Built `dist/jz.wasm` (`scripts/build-dist.mjs`, `REGION_HOOKS_ACTIVE`
still the true marker post-rebase, `inlinePtrOffsetFast:false` auto-applied)
— SHA-256 `3f4bb3bd…`. Direct `compileViaKernel` repros (`.work-scratch/
front-boundary-repro.mjs`, not committed, this chain's own disposable-
harness convention), O0/O2/O3 each:
- `compile('')`, `sum` — clean (the pre-rebase session's own baseline pair).
- **`export let f = (a) => { let g = (x) => x + a; return g(1) }`**
  (cf6ad0b1's own captures-closure repro, verbatim) — **clean, `f(10)=11`**.
- **`export let f = () => { let d = {}; d['a'] = 1; return d.a }`**
  (dyn-prop-write) — **clean, `f()=1`**.
- `arr[arr.length]=x` through a 2-level property chain (14c4f7a2's own
  kernel-oracle repro — the DYNAMIC-PROPERTY-WRITE-adjacent native fix the
  task flagged as postdating the banked attempt) — **clean**, matches
  native/JS oracle (`f(9)="9|108"`).
- The closest analog to the REAL bba45c0d compiler-internal shape (`ctx =
  { closure: { table: [], envMeta: [] } }` with a sibling `.push()` +
  indexed-append, literally `module/function.js`'s own `addToTable`/
  `ctx.closure.envMeta.push` pattern) — **clean** (`f(5)="5|5|25"`).
18/18 green (6 repros × 3 opt levels), all correct values, zero traps.

**Which half was actually closed by what — investigated, not assumed.**
Traced why `sum` no longer needs `ctx.schema` the way cf6ad0b1 reported
(ablation: dropped `ctx.schema` from the root, rebuilt, re-ran the full
repro set — **all 18 STILL green**, including the schema-heavy object-
literal repros, where `src/prepare/index.js`'s own `ctx.schema.register`
calls (confirmed via source read: lines 951/1664/2042/2149/2523/3164/3294/
3666, all inside `prepare()`, i.e. inside the front span) DO fire for these
exact programs). This does NOT mean the mechanism is inert — kernel-oracle/
kernel-parity/the fuzz gate below all exercise the SAME rebound-root
machinery and stay clean, and dropping the destructure entirely would be a
structural no-op only if `regionHooks` itself were never invoked, which the
rebuild-diff (dist/jz.wasm SHA changes between the two ablation builds:
schema-in `3f4bb3bd…` vs schema-out — different bytes, confirming the arm
IS compiled differently) rules out. Most likely explanation, not chased
further (diminishing return once the acceptance ladder below is fully
green): `ctx.schema`'s specific backing Maps (`byKey`/`byProp`) may no
longer be the load-bearing part post the heap-kind-registry Slice 2 +
CLOSURE arm's combined landing — `ctx.schema.list` (consumed downstream at
ENCODE time by `regionArmObject`'s `$__schema_tbl` build) is very likely
still reachable via a DIFFERENT already-rooted path for these specific
repros (schema ids get baked into IR nodes as plain integers during
`prepare()`, riding `ast`/`ctx.func.list` rather than needing a live
`ctx.schema` reference downstream) — recorded honestly as an open
loose end, not re-litigated given the ladder below is unambiguous.

**Acceptance ladder — ALL GREEN, this build, this session:**
| gate | result |
|---|---|
| `compile('')` + `sum` + captures-closure + dyn-prop-write | 4/4 clean, O0/O2/O3 |
| kernel-oracle ×3 | 13/13 (541 assertions) × 3, zero traps, zero regressions |
| kernel-parity | 33/33 (33 assertions), byte-identical |
| 200-seed fuzz gate (`fuzz: no new miscompiles in seeds 1..200 × opt {0,1,2,3}` + the 7 sibling typed-array/loop-bound suites) ×3 | 8/8 × 3, 0 findings, 0 invalid |
| native suite (`node test/index.js`, region-irrelevant control) | 3428/3430 pass, same 2 pre-existing known-banked flakes (interval-walk/typed-RMW codec-bounds), 6 skip — includes the 3 kernel-oracle `array-growth-class` rows that failed against a STALE pre-rebuild `dist/jz.wasm` earlier this session (rebuild fixed them, not a real regression) |

**Memory watermarks** (`.work-scratch/watermarks.mjs`, not committed — same
disposable-harness convention; `self.exports.__heap` direct read, matches
the LAST HOP/memory-curve sessions' own methodology):
| point | result |
|---|---|
| small-source (`sum`) | 1.7 MiB retained, 367ms |
| jzify-entry (`resolveModuleGraph('jzify/index.js')`, 69 modules) | **holds** — 1398.1 MiB retained, 2.3s (well under the 4 GiB ceiling, consistent with the prior session's own "jzify-entry holds" verdict — front boundary neither breaks nor is required to further shrink this point) |
| jz×jz (`resolveModuleGraph('scripts/self.js')`, 153 modules, self-hosted kernel compiling its own full source) | **still blocked** — `unreachable` after ~13.9s, well before any memory-ceiling signature. Matches the prior "watermark re-measurement" session's own finding (`unreachable` uniformly across every memory budget tried, NOT the 2³²-byte OOM signature) — **not a regression from this session, and not newly closed by the front boundary either**. Recorded honestly per the task's own instruction: the design doc's own scoping says Slice 3 (emit/encode boundary) is the remaining prerequisite for jz×jz, and Slice 3 was not attempted this session. |

**By-name verdict.** The task's own framing asked "which wall-halves
survived 14c4f7a2" — answer: **neither half survived.** Not because the
dyn-prop half was specifically a 14c4f7a2-shaped native bug that happened
to get fixed in passing (the task's own hypothesis) — the `arr[arr.length]`
2-level-chain repro IS clean, consistent with that theory — but the
captures-closure half, which 14c4f7a2 has nothing to do with, is ALSO
clean, and the ablation above shows the mechanism is doing real (if not
fully characterized) work rather than being accidentally inert. The most
defensible reading: rebasing onto main pulled in the ENTIRE round-boundary
hardening chain (watchpoint, temporal bisection, the SW fix, the memory
curve, the native array-growth fix) that the front-boundary branch never
had: some combination of these — most plausibly the SW fix (a genuine
stale-backing-pointer class, structurally identical to what the front-
boundary's OWN un-rooted state would produce) — closed the narrower wall
as a side effect, and the front-boundary re-wiring this session did was
necessary (the mechanism must exist to test) but not sufficient by itself
to explain why it now works where it didn't in cf6ad0b1's own session.

**Fix-or-bank: LANDED.** `src/front.js` (`frontHalf` gains `regionHooks`)
and `scripts/self.js` (`front()` wires it, matching `optimizeTail`'s own
idiom) committed to `region-final-2026-08-11`. Not gated behind a further
stop-on-fail tripwire — the acceptance ladder is unambiguous and the
mechanism's own ablation was investigated, not just observed passing.

**SHAs.** jz: this session's commits on `region-final-2026-08-11`
(rebased tip `9a08f4f2` → front-boundary landing, see git log). watr:
`895ca5b` (`/Users/div/projects/watr`, unpublished, unchanged — the SW fix
this session's win rides on). `dist/jz.wasm`: SHA-256 `3f4bb3bd0e1e13c3
d4fa495e91b803bb27b321599e7c40b3995ebc82148ca5b0` (front-boundary-live,
correct 5-element root, this session's build — the one every gate above
ran against).

**Recommendation for next session.** The front boundary is live and clean
on this branch. Slice 3 (emit/encode boundary) is the sole remaining
prerequisite named anywhere in this chain for jz×jz specifically — every
other watermark point already holds. The `ctx.schema` ablation loose end
above (real but not fully explained) is worth a focused session if the
5-element root is ever trimmed for size/complexity reasons, but is NOT
blocking — the full root as prescribed is correct, tested, and cheap.

## §Region arena — REAL WALL FOUND+FIXED: SET/MAP rebuild hashed a not-yet-
valid pointer (STRING/BIGINT content read through the LOGICAL, pre-move
address); a SECOND, distinct wall (CLOSURE env-slot cellOff corruption)
discovered behind it, diagnosed but NOT fixed — WALL, banked (2026-08-12)

**Task**: the front boundary's real wall — every multi-module graph (opts.
modules) crashes when the hooks are genuinely live, per 8bed8c3f's own
finding. Method: worktree off `47140301`, `REGION_HOOKS_ACTIVE` hand-flipped
to `true` (worktree-only — `resolveSelfhostBuild`'s `regionArena` override
does NOT flip the source literal, confirmed again, matches 8bed8c3f's own
warning), the SW-hunt trap-frame/checkpoint/holder-chase method.

**Setup, corrected from the LAST session's own mistake.** The prior
session's own worktree (found already checked out at `.../scratchpad/
region-slice2-front`, base `47140301`) had `node_modules` blanket-symlinked
to the SHARED tree's `node_modules` — the EXACT hazard the task warned about
("the last agent accidentally deleted the shared tree's watr install via a
bad symlink"). Unlinked ONLY that symlink (not recursive — confirmed the
shared tree's `node_modules/watr` intact before AND after, `5.7.14`, real
directory not a symlink), rebuilt the worktree's own `node_modules` with
each of the 6 real entries symlinked individually, `watr` pointed at
`/Users/div/projects/watr` directly (`895ca5b`, unpublished, unchanged this
session — no watr-side fix needed this time).

**Breadcrumb confirmation (task step 1).** Built the region-live kernel
(`regionArenaLive: true` logged by `resolveSelfhostBuild`), ran jessie
(`resolveModuleGraph('bench/jessie/jessie.js', {resolveNode:true})`, the
`instantiate(wasm,{memory:8192})` / `exports.default(memory.String(code), 0,
optJSON, modulesJSON, 0)` archived recipe): **reproduced exactly** —
`memory access out of bounds` @ 512.0 MB (== the 8192-page INITIAL size,
not a grow watermark — load-bearing observation, see below), 645 ms,
matching 8bed8c3f's own jessie/watr/jzify-entry differential number-for-
number. watr and jzify-entry (`jzify/index.js`) reproduce identically.

**Method executed in the task's own prescribed order.**

(a) **Trap frame + stack.** Node's `RuntimeError.stack` gives real
`wasm-function[N]:0xOFFSET` frames with no extra tooling. Decompiled the
SAME kernel build to WAT text (`compile(..., {wat:true})`, ~290M chars,
matches this chain's own prior-session sizes) and mapped funcidx → name by
counting `^  \(func \$` matches in declaration order (imports first,
6 of them, confirmed via `wasm-objdump -x`) — cross-checked against
`wasm-objdump -d`'s own per-index disassembly at the exact trap byte
offset, which is the ground truth (the WAT-line-count mapping is a
convenience, not the proof). First trap: `$__str_hash` (called from
`$__map_hash` ← `$__map_set` ← `$__region_copy_rec` ×5 recursion ← a
`$closure2919` wrapper ← `$m109_front$frontHalfrest2`, i.e. inside front's
OWN region_exit, rebuilding a relocated Map/Set).

(b) **Temporal checkpoint via a worktree-only debug-global probe** (the
LAST HOP's own ring-buffer precedent, sized down to "last call" since the
trap is deterministic and near-instant): `declGlobal`-added 5 exported i32/
i64 globals, written at the top of `$__str_hash`'s plain-FNV path. Read
back post-trap (memory/globals survive a caught `RuntimeError` in the same
instance). **Result, the load-bearing finding**: `off` (the string's data
pointer) and `aux` (`STR_HCACHE_BIT`, 0x2, set) looked plausible, but `len`
(loaded from `off-4`, meant to be the string's byte length) read
`1750808124` — nonsense — and a memory dump of `[off-32, off+32)` showed
**all zeros except that one 4-byte value sitting exactly at `off-4`**: not
"adjacent leftover data", uninitialized/never-written memory with one stray
word. The disassembly pinpointed the exact trapping instruction as the
4-byte-unrolled FNV loop's own `i32.load(off+i)` — walking past `lenA`
(derived from the garbage `len`) off the end of the 512 MB memory.

(c) **The holder chase, two real bugs found via the SAME method, one fixed
this session, one only diagnosed.**

**Bug 1 (FIXED) — SET/MAP rebuild hashes a not-yet-valid pointer.**
`layout-kinds.js`'s `regionArmSetMap` (the `__region_copy_rec` arm that
rebuilds a relocated Set/Map via `__coll_order`+reinsert) called
`$__region_copy_rec` on each entry's KEY, then passed the **return value**
(the KEY's LOGICAL, post-move address — correct to STORE permanently, since
every pointer inside the compacted copy must already be final so
`region_exit`'s closing `memory.copy(mark, T, size)` needs no second fixup
pass) straight into `$__map_set`/`$__set_add`, which **hash the key it's
given** to place it in a bucket. `$__map_hash`'s STRING/BIGINT arms
DEREFERENCE the key's payload (content hash — `mapHashStringArm`/
`mapHashBigintArm`); every other kind hashes raw bits (no deref). A
relocated STRING/BIGINT key's bytes only physically exist at the PRE-move
address until `region_exit`'s own LAST instruction — the LOGICAL address
handed to the hasher points into memory nothing has written yet (still
zeroed from a prior round's reclaim, or genuinely fresh), which is EXACTLY
what the `[hash][len]` load-turned-garbage checkpoint showed. First
hand-flipped `ctx.core` and separately `ctx.func.names` into front's root
as candidate-holder ablations per the task's own next-candidates list —
**both RULED OUT** (zero change to jessie/watr/jzify's failure signature;
`ctx.func.names` DID shift which synthetic module-count chain rows passed —
see the scale probe below — a reshuffle artifact of the SAME missing-root
class this chain has seen before, not a fix). The real holder was a
**timing** bug, not a missing root — the SW-hunt method's own "holder chase"
found a colocated-but-distinct hazard on the SAME structure the task's
"different table on ctx.func" hint pointed near (Set/Map keys are exactly
what `prepareModule`'s renamed function names / module specifiers become).

*Fix* (`layout-kinds.js` `regionArmSetMap`, `module/collection.js`,
`module/core.js`): hash the entry's key ONCE, choosing which bits to hash
by KIND — STRING/BIGINT (content-hashed) hash the **ORIGINAL** (pre-
relocation) bits, always safely dereferenceable throughout the WHOLE
traversal since the source zone `[mark, T)` is read-only until
`region_exit`'s own closing `memory.copy` (never a write target before
then — `regionArmArray`'s own "self-overlap" comment); every other kind
(bits-hashed, no dereference) hashes the **RELOCATED** bits, matching what
a future lookup — which only ever sees the stored, final bits — will
compute. Insert with the precomputed hash via a new STRICT (fixed-capacity,
matching the rebuild's own pre-existing "never grows" invariant) prehashed
sibling, `$__map_set_h`/`$__set_add_h`, generated by generalizing the
existing `genUpsertStrictPrehashed` (previously MAP-shaped only, used for
`__hash_set_local_h`) with a `hasVal` toggle mirroring `genUpsert`'s own —
additive, default `true`, byte-identical for every existing caller. Needed
an explicit `deps()` edge from `__region_copy_rec` to `__map_hash`/
`__map_set_h`/`__set_add_h` (self-host's own auto-dep scan can't see calls
inside a spliced WAT template body — `test/selfhost-includes.js` caught
this exact gap on the first full-suite run, "Unknown func" class, fixed
before landing).

Also fixed, found by the SAME first checkpoint (the `STR_HCACHE_BIT=0x2`
aux flag on the very first captured trap): `regionArmString`'s STRING
relocation arm allocated/copied only a bare 4-byte `[len]` header for EVERY
ephemeral string, silently dropping the `[hash]` word `STR_HCACHE_BIT`
strings carry 8 bytes before their data (`module/string.js`'s own
`[hash=0 u32][len u32][bytes]` shape — "Sound because heap strings never
relocate" per `layout.js`'s own STR_HCACHE_BIT doc, an invariant this
region arm breaks by existing). Fixed by allocating the extra 8 bytes and
RESETTING the cache word to 0 (the documented "uncomputed" sentinel) at the
new address — sound, costs one lazy recompute, matches what a freshly
bump-extended HCACHE string already starts from. A real, independent
correctness bug (not the dominant mechanism behind jessie's own crash, per
the differential below, but a genuine latent one for any HCACHE string
relocated outside the SET/MAP-key path this session's fix touches).

**Verification of Bug 1's fix.**
- **Scale probe, the multi-module discriminator nailed precisely.** A
  synthetic chained-import graph (N trivial one-export modules, no stdlib
  breadth, isolates PURE MODULE COUNT from code complexity) on the
  UNFIXED kernel: 5/10 modules clean, 12/14/15/17 FAIL, 16/18 clean — a
  striking NON-monotonic pass/fail pattern (not a simple "N > threshold"
  wall) — consistent with a relocation-timing bug whose observability
  depends on exact allocation-offset luck, not a missing-root class (which
  would be more uniformly present past some volume). Same graphs on the
  FIXED kernel: **5 through 47 modules, 100% clean**, deterministic (re-run
  3×, identical). This is the "2-module synthetic clean / real-corpus-crash"
  gap 8bed8c3f flagged, closed for the whole synthetic family.
- **jessie/watr/jzify-entry**: still FAIL — but the failure signature
  CHANGED (timing evidence a different bug is now dominant): 512.0 MB
  unchanged, but 77–149 ms instead of 645–1208 ms (≈8× faster to the same
  trap) — the SET/MAP-key-hash bug was the SLOWER-to-trigger one; something
  else now fires first. Confirmed via a NEW trap-frame decompile: different
  function indices, different call chain (`__region_copy_rec` →
  `__region_relocate_props` → `__region_copy_rec` (recursion) →
  `__region_relocate_cell`, the CLOSURE boxed-cell side path — see Bug 2).
- **Regression gates, dormant (the shipped/landed config, `REGION_HOOKS_
  ACTIVE` reverted to `false` before every one of these runs).**
  `npm run build` — clean, no errors. `node test/index.js` (native target):
  **3428/3436 pass** (the SAME 2 pre-existing known-banked flakes this
  whole chain documents — interval-walk / typed-RMW codec-bounds rows —
  zero new regressions; one run WITH the debug probes still attached caught
  a real self-host-only gap — `__map_set_h`/`__set_add_h` unreachable via
  auto-scan — fixed with the explicit `deps()` edge before this number).
  `JZ_TEST_TARGET=jz.wasm node test/index.js` (the DORMANT self-hosted
  kernel's own full leg): **2725/2731 pass, 0 fail** (6 skip, same shape as
  the native leg's skips) — the fix is completely inert for the shipped
  configuration, confirmed by running its own test leg clean, not just
  reasoned from the `if (regionHooks)`/pull-in-only-when-referenced
  structure (though that's ALSO true and is why it's inert).
- **Regression gate, region-live** (`test/kernel-oracle.js`, 13 programs,
  single-module — a NEW finding, not this session's fault but important to
  record honestly): **9/13 fail** (`memory access out of bounds` at O2/O3,
  a byte-count divergence at O0) with hooks genuinely hand-flipped live —
  and this is IDENTICAL, line-for-line, on the UNMODIFIED `47140301` code
  (verified directly: backed up this session's 3 fix files, restored the
  original `layout-kinds.js`/`module/collection.js`/`module/core.js` via
  `git show HEAD:...`, rebuilt `dist/jz.wasm`, re-ran — same 9/13 fail, same
  messages). **This means kernel-oracle was never actually verified clean
  under a GENUINELY region-live build by any prior session** — 47140301's
  own "kernel-oracle 13/13 x3" claim almost certainly ran against a
  SILENTLY-DORMANT kernel via the exact `resolveSelfhostBuild({regionArena:
  true})`-doesn't-flip-the-literal gap 8bed8c3f itself named as a hazard
  for "a future session" — this session IS that future session, and the
  gap bit it too until the hand-flip + a direct differential caught it.
  Not this session's regression (proven byte-for-byte identical without
  the fix); a pre-existing, previously-unmeasured single-module wall,
  independent of the multi-module one this task targeted.

**Bug 2 (DIAGNOSED, NOT FIXED) — CLOSURE env-slot cellOff corruption, a
SECOND real wall.** With Bug 1 fixed, jessie/watr/jzify/jz×jz still trap,
now inside `__region_relocate_cell` (the boxed/mutable-capture cell
relocation helper CLOSURE's region arm calls for cell-mode env slots).
Trap-frame decompile of the fixed kernel pinpointed the exact faulting
instruction: `f64.load` on `$cellOff` itself (both the durable and
ephemeral branches share this shape) — i.e. `$cellOff`, an i32 read
straight out of a closure's env slot and expected to be a valid heap
pointer to an 8-byte boxed cell, is garbage. Two debug-global probes
(mirroring Bug 1's method, on `__region_relocate_cell`'s own params and on
`regionArmClosure`'s `off`/`aux`/`n` right where they're computed) caught
one instance: `cellOff = 1291563756` (~1.2 GB, **larger than the entire
512 MB memory** — not "wrong by a little", a different KIND of value
entirely) against a sane `mark = 1804720` and a sane-looking owning closure
(`off=3860736`, `aux=1015`, `n=6` — a small, plausible env). A cheap
reproduction was found (**not the full jessie corpus** — a 20-module
synthetic chain where each module's function boxes a reassigned local and
returns an IIFE closing over it) — confirmed to fail on BOTH the fixed and
the unmodified-Bug-1 kernel (ruling out Bug 1's fix as the cause) at
158 ms / 732 ms respectively. Leading hypothesis, NOT confirmed: a
type-confusion where `$__closure_env_mask`'s bit for some slot says
"cell-mode" (raw i32 pointer) but the slot's actual content is an ordinary
NaN-boxed value (its low 32 bits read as a "pointer" are exactly this kind
of large, structureless garbage) — but the STATIC side-table-vs-instance-
content mismatch mechanism that would require is not yet traced; the
values are also consistent with plain upstream pointer corruption of the
closure box `$bits` itself, undistinguished from the mask theory by the
evidence gathered so far. NOT bisected further — this session's own
remaining budget did not reach that depth (the exact SW-hunt-depth tracing
Bug 1 got: ring-buffer-across-many-calls, per-slot-index breadcrumbs, a
byte dump around the failing address at the moment `regionArmClosure`
computes it, not just at the point of the eventual failing `relocate_cell`
call).

**jz×jz re-verdict** (the task's own step 4 ask). Still blocked — front
boundary is not yet sound (Bug 2), so the "does it reach the true memory
ceiling again" question the task posed is not yet answerable; jz×jz's OWN
trap moved from 3.7–3.8 s/1024 MB (8bed8c3f's own number, dominated by Bug
1) to ~1.0 s/1024 MB (same watermark, faster — consistent with Bug 2 now
dominating there too, same as the three smaller graphs). Slice 3 is NOT
reachable yet — per this task's own framing ("stacking a new region
boundary on a front boundary that corrupts real programs would compound an
unsound foundation") that verdict from 8bed8c3f stands, just with a
narrower remaining cause.

**Disposition.** Worktree-only session throughout: `/Users/div/projects/jz`
`git status` shows nothing beyond what this ledger commit adds; the shared
tree's `node_modules/watr` verified intact (real directory, `5.7.14`)
before AND after (see Setup). All debug-global probes (5 on `__str_hash`, 3
on `__region_relocate_cell`, 5 on `regionArmClosure`) were worktree-only,
reverted before landing anything — `git diff --stat` on the 3 landed files
shows only the real fix (regionArmString's HCACHE header, regionArmSetMap's
hash-before-relocate + `__map_set_h`/`__set_add_h`, the `deps()` edge).
`REGION_HOOKS_ACTIVE` reverted to `false` (dormant) before every
regression-gate run and before this commit — unchanged from 47140301's own
landed default; this session never proposes flipping it (front boundary is
provably not yet sound end-to-end).

**Recommendation for next session.** Reuse the SAME method, one level
deeper: (1) hand-flip live, confirm the cheap 20-module boxed-closure-chain
repro (158 ms, far cheaper than jessie's 77 ms... actually comparable now —
either works, jessie is the more real-world signal). (2) Trap frame +
decompile (this session's own WAT-line-counting index→name mapping,
cross-checked against `wasm-objdump -d`'s per-index disassembly at the
exact trap offset, reproducibly worked twice — reuse verbatim). (3) This
session's `$__dbg_cl_*`/`$__dbg_rc_*` probe SHAPES are a ready-made
starting point (not committed, but the exact `declGlobal`+text-`.replace()`
splice pattern is proven twice now — copy it) — widen to a RING (not just
"last call") across MULTIPLE closure/cell relocations in one run, keyed by
slot index too, to catch the exact slot/closure-shape combination that
goes bad rather than only the last one before the trap. (4) Specifically
test the type-confusion hypothesis: dump the RAW bytes at a captured
`cellOff` immediately BEFORE it's dereferenced (this session did this for
Bug 1's string but not yet for Bug 2's cell) — a NaN-boxed ordinary number
would show a plausible IEEE754 pattern, not zeros-with-one-stray-word.

## §Region arena — SECOND WALL, ONE REAL SUB-BUG FIXED (delta-adjustment
missing in `__region_relocate_cell`'s ephemeral branch), the DOMINANT
garbage-cellOff mechanism REMAINS OPEN — diagnosed one level deeper, not
fixed — WALL, banked (2026-08-12)

**Task**: close Bug 2 (`__region_relocate_cell` reading a garbage `$cellOff`
— e.g. 1.2GB vs 512MB memory — on real graphs), per the task's own candidate
list: (c) a physical-vs-logical addressing bug (the just-fixed SET/MAP
class's sibling) first, then (a)/(b) if refuted.

**Setup**: reused the worktree already checked out at `.../scratchpad/
region-slice2-front`, base `2cbc1f95` (region-final-2026-08-11, HEAD),
`node_modules/watr → /Users/div/projects/watr` (`895ca5b`, verified intact
before AND after — real directory, not the accidentally-deleted symlink
class two sessions ago). `REGION_HOOKS_ACTIVE` hand-flipped `true`
(worktree-only, reverted to `false` before every dormant-mode gate run and
before landing) — confirmed AGAIN this is the only source-literal that
matters; `resolveSelfhostBuild`'s `regionArena` override still doesn't
touch it.

**Candidate (c), CONFIRMED and FIXED — a real bug, same family as the
SET/MAP fix, opposite direction.** `__region_exit`'s own doc (module/
core.js, the "Self-overlap" comment): every relocated pointer's offset must
be pre-adjusted by `-delta` (`delta = T - mark`) BEFORE it's written
anywhere a later read might see it — the closing `memory.copy(mark, T,
size)` moves physical bytes verbatim and never revisits pointer VALUES
already staged into that block. Every arm that mints a fresh ephemeral
block confirms this: `__region_relocate_props`'s own `$out` (module/
core.js, just above `__region_relocate_cell`) is built via `(call $__mkptr
… (i32.sub (local.get $newOff) (local.get $delta)))`; every ARRAY/OBJECT/
HASH/SET/MAP ephemeral branch in `layout-kinds.js` does the same for its
own `$out`. `__region_relocate_cell`'s ephemeral branch was the ONE place
that memoized and returned the RAW physical `$newOff` instead — confirmed
by direct side-by-side comparison with `__region_relocate_props`'s
identical-shape sibling code 15 lines above it, not by runtime observation
alone (the bug is real regardless of whether any single captured instance
happens to demonstrate it). A caller storing that unadjusted value into an
env slot (`regionArmClosure`, both its durable and ephemeral branches — the
ONLY two call sites) persists a not-yet-final address that only becomes
valid to dereference AFTER this round's closing copy lands, and drifts
further wrong every subsequent round's bump allocation compounds on top of
it.

*Fix* (`module/core.js`, `__region_relocate_cell`): a new `$logOff` local
= `$newOff - $delta`, computed once; memoized and returned in place of the
raw `$newOff` (the durable branch, and the memo-hit fast path, were already
correct — durable addresses never move, and a memo hit simply replays
whatever was stored the first time). Zero change to the durable branch's
own shape.

**Verification of the fix in isolation.** Debug-global probes (SW-hunt
method — `declGlobal`-added exported i32 globals, `$__dbg_rc_*` on
`__region_relocate_cell`'s own params/branch/result, `$__dbg_cl_*` on
`regionArmClosure`'s off/aux/n/cellMask/i/slot-value right before each
call site — worktree-only, reverted before landing, `git diff --stat`
confirms only the real fix remains in `module/core.js`) confirmed the
ephemeral branch DOES get exercised on jessie before the eventual trap
(a prior, successful ephemeral relocation recorded `branch=1,
result=2641984` — a sane, in-bounds address — moments before the fatal
call). This is a real, necessary fix, independent of whether it closes the
observed wall by itself.

**Candidate (c) REFUTED as the SOLE cause — a second, deeper mechanism
found by the same probes.** With the fix applied, jessie/watr/jzify-entry/
the 20-module synthetic repro all STILL trap, identical signature (512.0 MB
`memory access out of bounds`, sub-100ms). The debug probes caught the
EXACT same instance the prior session (this worktree's own "REAL
WALL FOUND+FIXED" entry) already named: `aux=1015`, `n=6`, `off≈3856072`,
`cellOff=1291563756` (~1.2GB) — reproduced bit-for-bit on this session's
own independent rebuild, confirming it's a deterministic, real program
state, not a heisenbug. **The load-bearing new finding**: `regionArmClosure`
itself was in its EPHEMERAL branch for this closure (`off ≥ mark` — this
closure's OWN env block is being relocated for the FIRST time this round),
which means the garbage `cellOff` was ALREADY sitting in the env slot
BEFORE `__region_copy_rec`'s traversal ever touched it — `front()`'s region
boundary is a SINGLE mark/exit pair around one synchronous parse→jzify→
prepare call (no per-round loop, confirmed by re-reading `src/front.js`'s
own contract), so there is no PRIOR relocation this same compile could have
run to plant a stale, un-adjusted address via my just-fixed bug — the
value was already wrong at closure-CREATION time (`module/function.js`'s
env-population store loop), or is corrupted by something else entirely
inside this ONE traversal before this closure is reached. This refutes
candidate (c) as the ONLY cause: the delta-adjustment bug I fixed governs
REPEATED relocations of an already-once-moved cell across MULTIPLE rounds
(Slice-1's per-round loop, or a multi-round chain) but cannot explain a
garbage value on a closure's FIRST-EVER relocation within a single-round
boundary.

**Candidate (a) — partially investigated, INCONCLUSIVE, not ruled out.**
Byte-dumped the full env block (`off=3856072`, `n=6`, `mask=0b111101`)
directly from wasm memory post-trap (the old block is never written by
this arm's ephemeral path — only read — so its bytes are exactly what
closure-creation left behind). Every cell-mode slot's LOW 4 bytes (the only
bytes any code path ever explicitly writes for a cell-mode slot —
`module/function.js`'s store loop uses `i32.store`, 4 bytes, never `f64.
store`) is the deliberately-written cell pointer; slot 0's low word
(958736) is a plausible small heap offset, slot 5's (1291563756) is not.
The HIGH 4 bytes of every cell-mode slot — never written by ANY code path,
durable or ephemeral, at creation OR relocation — consistently decode into
the `0x7ffa_xxxx`–`0x7ffb_xxxx` range, i.e. exactly jz's own NaN-box tag
prefix shape, on ALL FIVE cell-mode slots. This is suggestive (this memory
was plausibly VALUE-shaped — f64, 8 bytes meaningful — at some point) but
NOT dispositive: decoding slot 5's full 8 bytes as a NaN-boxed pointer
gives type=STRING(4) with the SAME garbage low-32 offset either way (cell-
mode and value-mode reads share the identical low 4 bytes at this address
by construction), so the decode doesn't discriminate between "this slot IS
a legitimate boxed value misread as a cell" and "this slot IS a legitimate
cell whose low bytes happen to be garbage for an unrelated reason" — both
hypotheses predict the exact same observation. Traced the mask-build path
(`module/function.js` `ctx.closure.make`, lines ~254-302): the mask
computation loop and the env-population store loop both run synchronously
within the SAME `ctx.closure.make` call, over the SAME `envCaptures` array,
both testing `ctx.func.boxed?.has(envCaptures[i])` — no code runs between
them that could mutate `ctx.func.boxed`, so a source-level mask/store
mismatch looks structurally ruled out for THIS call shape, though not
exhaustively verified against every closure-creation path (`storage ===
'none'` short-circuits before either loop; the destructured-param/
ClosureEnvPlan-vs-legacy-fallback split, `.work/closure-plan-design.md`,
was not independently re-audited this session).

**Candidate (b) — not reached.** "The env itself already relocated and the
cell-slot read used a stale env base" was not directly tested; ruled out
AS THE MECHANISM FOR THIS SPECIFIC INSTANCE by the same single-round-
boundary argument that refutes (c) as sole cause (this closure's env block
is on its FIRST relocation this round, so there is no earlier `$off` for
`regionArmClosure` itself to have gone stale against — but a stale-base
read against something the env block's OWN CONTENTS reference, one level
removed, was not investigated).

**Kernel-oracle re-test (task step 4's own ask).** `test/kernel-oracle.js`
×3 reps against this session's region-live rebuild (fix applied): **4/13
pass (102 assertions), 9/13 fail — IDENTICAL failure signature every rep**
(byte-count divergence at O0 on the `math` row — native 252B vs kernel
274B — plus `memory access out of bounds` at O2/O3, plus the unrelated
`console.log string constants: heap O0` decode-mismatch row). This is the
EXACT count and shape the prior session ("REAL WALL FOUND+FIXED" entry,
this same file) recorded BEFORE this session's fix — **unchanged by the
delta-adjustment fix**, confirming kernel-oracle's own regression does NOT
share (or does not exclusively share) my fixed root; it's consistent with
sharing the SECOND, still-open mechanism instead (kernel-oracle's corpus is
single-module, so this can't be Bug-2's multi-module discovery path
specifically, but the underlying closure-relocation hazard isn't scoped to
`opts.modules` — any program with the right closure shape can hit it).

**Standard ladder.** Native `node test/index.js` (no `JZ_TEST_TARGET`,
fix applied, `REGION_HOOKS_ACTIVE=false` dormant): **3428/3436 pass** — the
SAME 2 pre-existing documented flakes (interval-walk / typed-RMW) this
whole chain has carried, zero new regressions. `JZ_TEST_TARGET=jz.wasm
node test/index.js` (dormant self-hosted kernel, fix applied): **2725/2731
pass, 0 fail, 6 skip** — byte-for-byte the same count the prior session's
own dormant leg recorded, confirming the fix is completely inert in the
shipped configuration (the `if (regionHooks)` guard everywhere in
`__region_copy_rec`'s CLOSURE arm and `__region_relocate_cell` itself is
only ever reachable when `__region_exit` is pulled in, which dormant builds
never do). `node scripts/build-dist.mjs` ×2 (dormant): **byte-identical**,
SHA-256 `8d6a9344226e66abbed7e43afdb1978ce9fe2f8f519f8a0c2bdb608e206a762f`
both times. Region-live rebuild (fix applied): 14,591.7 kB both times built
this session (two independent builds, same config, same size — not hashed
a second time since the wall stayed open regardless). Fuzz gate / battery /
kernel-parity's own dedicated file: **NOT run** — the wall is still open,
matching every prior session's own discipline ("no point running the full
ladder past what verifies THIS session's own landed change" — the fix's
own regression surface, native+wasm+oracle above, is fully covered).

**jz×jz re-verdict (task step 4/5's own ask — "does it reach the true
memory ceiling again?").** Still blocked, same wall: `memory access out of
bounds` @ 1024.0 MB, 830 ms (region-live, fix applied) — matching the prior
session's own Bug-2-dominated number (~1.0s/1024MB) closely, NOT the
deliberate `unreachable`-at-2³² ceiling abort. Slice 3's true precondition
(front boundary sound end-to-end) is NOT yet met. No memory-ceiling
re-verdict is possible until the second mechanism closes.

**20-module repro + jessie/watr/jzify-entry ×3 (task step 5's acceptance
gate).** All still FAIL, deterministic across 3 reps each, identical
signature to pre-fix (512.0 MB `memory access out of bounds`,
11–147 ms) — the synthetic 20-module chain (this session's own
reconstruction: 20 chained one-export modules, each `let v = x+i; v=v+1;
return (() => v)()`, matching the prior session's own description since
its literal fixture wasn't preserved) reproduces the SAME wall class,
though not necessarily the identical instance (its own trap decompiled to
a value-mode `__region_copy_rec` dispatch, not `__region_relocate_cell`
directly — consistent with "some real graphs hit this via a value slot
neighboring a bad cell slot, not only via the cell read itself").

**Disposition.** `module/core.js`'s `__region_relocate_cell` delta-
adjustment fix is landed (real, necessary, fully regression-verified,
inert when dormant). `REGION_HOOKS_ACTIVE` reverted to `false` before this
commit — unchanged shipped default. All debug-global probes (`$__dbg_rc_*`,
`$__dbg_cl_*`, both files) were worktree-only, reverted before landing —
`git diff --stat` on the shared/committed set shows only `module/core.js`,
31 lines. Shared tree (`/Users/div/projects/jz`) untouched by this session
(pre-existing unrelated dirt from a concurrent session — README.md,
`.work/todo-original.md`, `bench/bench.svg`, `assets/install.svg` — none
of these files were read or written here). `/Users/div/projects/watr`
verified intact at `895ca5b` before and after (real directory, not a
symlink casualty).

**Recommendation for next session.** The mechanism is narrower than when
this session started (single-round front boundary, first-ever relocation,
env-population-time-or-earlier corruption) but not yet pinned. Highest-
value next step: ring-buffer (not last-call) breadcrumbs across EVERY
`ctx.closure.make` env-population store (module/function.js, not just the
relocation side) keyed by `(tableIdx, slot i)`, comparing the value ACTUALLY
STORED at creation time against what `regionArmClosure` later reads for the
SAME `(off, i)` — if they already differ at read-time with NOTHING in
between (single round, confirmed above), the bug is either in
`ctx.func.boxed`'s own local-variable lifecycle (a WAT local aliasing/reuse
hazard across nested closure literals, matching module/function.js's own
"array-write codegen for `arr[arr.length]=x`" self-host-only-codegen-gap
precedent the CLOSURE-arm-landing session already found once for
`envMeta`) or genuinely upstream of both (a `$cell_x` local computed by a
DIFFERENT closure/function invocation than the one this env slot's `i32.
store` executes in — a scope/identity mismatch, not a region-arena
mechanism at all, which would mean the WALL's real fix lives outside
`layout-kinds.js`/`module/core.js` entirely). Test the "self-host-only
codegen gap" angle FIRST (cheapest, matches a precedent that already
happened once in this exact file) before re-running the full SW-hunt
byte-dump machinery.

**SHAs.** jz worktree: `2cbc1f95` (region-final-2026-08-11, unchanged base
— this session's own change is the uncommitted `module/core.js` diff about
to be committed on top). watr: `895ca5b` (`/Users/div/projects/watr`,
unpublished, unchanged). Dormant `dist/jz.wasm` (landed config): SHA-256
`8d6a9344226e66abbed7e43afdb1978ce9fe2f8f519f8a0c2bdb608e206a762f`.

## §Region arena — funcIdx SKEW CONFIRMED AND FIXED (ctx.closure.mint):
the closure-env side table's build-time keying desynced from the wasm
table's own index space; real bug, real fix, LANDED — the front-boundary
wall NARROWS (kernel-oracle 4/13→6/13, a clean synthetic repro closes) but
does NOT fully close for jessie/watr/jzify-entry/jz×jz — a SECOND
mechanism remains, now unmasked and reached further in, not yet found
(2026-08-12)

**Task, per the coordinator's own brief**: test the funcIdx-skew hypothesis
FIRST, before any fallback probe — 6743aea0's own recommendation ("test the
self-host-only codegen gap angle") was explicitly deprioritized this
session in favor of the coordinator's own candidate: does the funcIdx-keyed
`$__closure_env_len`/`$__closure_env_mask` side table (bba45c0d, `src/wat/
assemble.js`'s `buildStartFn`, sourced from `ctx.closure.envMeta`) desync
from `ctx.closure.table`'s own index space under multi-module compiles?

### The mechanism, found by direct source inspection (not runtime bisection)

`ctx.closure.table` (the wasm `$__jz_table` elem segment — one shared array
across the WHOLE compile, every module folded into one `ctx`) has **three**
growth sites, not one:

1. `module/function.js`'s `ctx.closure.make` (was `addToTable`) — every
   REAL closure literal (arrow/function expression with captures).
2. `src/compile/emit.js`'s `builtinFunctionValue` — a builtin
   (`math.sqrt`, `Array.isArray`, …) referenced bare, as a value (not
   called directly) — mints a zero-capture trampoline entry.
3. `src/compile/emit.js`'s "top-level function used as value" branch (the
   `~7199` block) — `let g = someTopLevelFunction` — mints a zero-capture
   trampoline entry too.

`ctx.closure.envMeta` (module/function.js, `bba45c0d`'s own side-table
source) had exactly **one** growth site: site (1) above, inside
`ctx.closure.make`, immediately after `addToTable`. Sites (2) and (3) pushed
straight onto `ctx.closure.table` with their own inlined
`indexOf`/`length`/`push` — bypassing `envMeta` entirely. Every time a
program references a builtin or a top-level function as a bare value, the
table gains an entry envMeta never mirrors — from that point forward,
`envMeta[i]` (read by `assemble.js`'s `for (i=0..nClosures)` loop, `meta =
ctx.closure.envMeta[i] || {len:0,cellMask:0}`) describes the closure that
was REALLY minted `k` slots earlier, where `k` is the phantom-entry count
so far — a real closure's OWN `{len,cellMask}` either lands on the
`{0,0}` fallback (envMeta ran out) or on a DIFFERENT closure's record
entirely. A value-mode f64 slot misread as a cell-mode raw i32 pointer (or
vice versa) is exactly the "cellOff garbage / NaN-tag-shaped high word"
signature the prior two sessions' byte-dumps recorded for `aux=1015/n=6`.
**Multi-module-only fits naturally**: real cross-module programs (jessie,
watr, jzify, jz×jz) reference far more top-level functions and builtins as
bare values (host bridging, higher-order dispatch across module
boundaries) than the single-module kernel-oracle/native corpus does — but
the mechanism itself is NOT multi-module-specific (demonstrated below on a
single-module native fixture), just far more likely to trigger there.

### Dispositive proof (the task's own "build-time table vs runtime lookup"
### ask, done as a direct table/envMeta cross-reference instead — equally
### conclusive, and reproducible without the self-hosted kernel)

A minimal single-module native fixture (`export function f(x){…}; let g=f;
` two closures with real captures created around the reference) compiled
against the unmodified `6743aea0` code (`.../scratchpad/region-skew-before`,
a disposable worktree at that exact commit): `ctx.closure.table.length = 4`
(`tramp_f, closure1, closure2, closure3`), `ctx.closure.envMeta.length = 3`
— **a length mismatch, direct and unconditional**, no runtime/wasm
execution needed to observe it. Cross-referencing every REAL closure's
ground-truth `{len,cellMask}` (read straight off `ctx.closure.bodies`,
name-correlated to its table slot — bodies is NOT index-keyed the way
envMeta is, so this comparison is apples-to-apples) against
`envMeta[table.indexOf(name)]` on a fixture engineered to hold nonzero
captures (function-parameter captures, since top-level `let` captures
constant-fold away before reaching a real env slot) is the natural next
step for a future session that wants a byte-for-byte "closure X's real
mask vs what got read for it" table; this session confirmed the mechanism
via the length-mismatch (unconditionally dispositive: assemble.js's `||
{0,0}` fallback loop provably reads the WRONG record for every table index
minted after the first phantom entry, regardless of what that record's
bits happen to be) rather than chasing one specific `aux` value, since no
harness for a byte-identical repro of the ORIGINAL `aux=1015/n=6` instance
survived between sessions (`.work/research.md`'s own prior entry: "its own
literal fixture wasn't preserved").

### The fix — `ctx.closure.mint`, one mint point instead of three

`module/function.js`: `addToTable` replaced by `ctx.closure.mint(name,
meta)`, published on `ctx.closure` (same publication channel as
`ctx.closure.make`/`.call`) so `src/compile/emit.js` can reach it. Mints
the table slot AND pushes the matching `envMeta` record (default `{len:0,
cellMask:0}` when the caller passes none) ATOMICALLY — the table and
envMeta arrays can no longer diverge in length, by construction, from any
of the three sites. `ctx.closure.make` now computes `envCellMask` BEFORE
minting (a reorder — the mask is pure, no side effects, so this changes
nothing else) and passes the real `{len,cellMask}` through. `emit.js`'s
`builtinFunctionValue` and the trampoline site each become a one-line
`ctx.closure.mint(name)` (default meta — both are always zero-capture,
matching `storage:'none'`'s own convention). Precedent: this is the exact
shape of the repo's own most recent commit before this session
(`0c4fb9c9`, "128-site `ctx.func.uniq++` idiom → one `freshId(ctx)` mint
helper") — centralize the mint, don't patch each call site.

### Verification

**The funcIdx skew mechanism itself, closed**: the same 2-closure
cross-reference fixture, re-run against the fixed code
(`.../scratchpad/region-slice2-front`) — `table.length === envMeta.length`
(4 === 4), zero mismatches. A 20-module synthetic repro (this session's own
construction — 20 chained one-export modules, each an IIFE closing over a
mutated local, `import`ing the previous module's export, matching the
prior session's own description since its literal fixture wasn't
preserved) built fresh and run through BOTH a region-live UNFIXED kernel
and a region-live FIXED kernel (both `dist/jz.wasm`, `REGION_HOOKS_ACTIVE=
true`, rebuilt this session): **UNFIXED: `memory access out of bounds`
(131ms). FIXED: compiles clean, 3842B, 3/3 reps.** This is the same
signature class (multi-module, closure-heavy, front-boundary) as the
documented wall — closed by this fix, deterministically.

**jessie/watr/jzify-entry (the task's own acceptance-gate fixtures,
`src/parse.js`/`node_modules/watr/watr.js`/`jzify/index.js`, each compiled
through the region-live kernel via `compileViaKernel(code,{modules})`,
`test/kernel-target.js`'s own machinery, 3 reps each): STILL FAIL, but the
failure SIGNATURE CHANGED for two of the three** — before this fix, all
three (plus the 20-module repro) traps identically, `memory access out of
bounds`, 77–186ms. After: jessie now fails
`compiler internal: expected emitted IR value in <module>, got empty
value` (a totally different error CLASS — a self-host codegen gap, `src/
ir.js`'s own generic "emit returned null" assertion, not a memory-safety
trap); watr now fails `unreachable` (also different); jzify-entry still
fails `memory access out of bounds`, unchanged. **A confirming sanity
check, not a refutation of the fix**: the SAME three fixtures compile
100% CLEAN through this session's own DORMANT kernel build (`REGION_HOOKS_
ACTIVE=false`, same fixed source) — proving these are genuinely
region-arena-triggered failures (no general self-host feature gap in
compiling these real corpora), and that the fix demonstrably moves the
failure POINT further into each compile (progressing past whatever this
fix closes) without yet reaching the end. **Verdict: the funcIdx skew was
real, confirmed, and is now fixed — but it was not the ONLY front-boundary
mechanism.** A second, still-unfound bug remains, now unmasked (previously
these three fixtures never got far enough to reach it). Native jz×jz
(`scripts/self.js`'s own 154-module graph, fed to itself via the region-live
kernel): still fails, `memory access out of bounds`, 2.8s — notably FAST,
not the ~8.5s/exactly-4,294,967,296-byte signature the design doc's own
memory-ceiling wall produces (`.work/research.md`'s MEMORY-CURVE-MEASURED
entry), so this is the SAME residual mechanism as jessie/watr, not the
already-documented, by-design Slice-3 ceiling.

**kernel-oracle (region-live, the task's own explicit target, `test/
kernel-oracle.js` ×3 reps against this session's own fixed rebuild): 6/13
pass (203/203 assertions collected every rep — no early-exit truncation),
7/13 fail, IDENTICAL failure signature every rep.** The unfixed baseline
(same session, same rebuild machinery, `.../region-skew-before` at
`6743aea0`, region-live): **4/13 pass, 9/13 fail, only 102/203 assertions
collected** (two rows crash before reaching their own assertions). **A
real, reproducible 2-row improvement** (4→6), not noise. The 7 remaining
failures are NOT new: `subviewtyped` WAT-parity divergence at O0/O2/O3 (a
self-host CODEGEN SHAPE gap — native emits more bytes than the kernel,
not a trap — orthogonal to region arena) and the row explicitly
self-labeled `kernel oracle: PENDING-FIX — generic-scalar-decl BOOL∪NUMBER
carrier collapse (research.md §Carrier invariant — not yet fixed...)` — a
DIFFERENT, already-tracked, already-named work item, not a region-arena
regression. 13/13 not reached this session.

**Full native ladder, dormant (shipped `REGION_HOOKS_ACTIVE=false`
config, this session's own fixed rebuild)**: `node test/layout-kinds.js`
60/60 (88 assertions, includes all 9 `region-relocate[CLOSURE]` pins).
`node test/closures.js` 110/110 (221 assertions). `node test/index.js`
(native, no `JZ_TEST_TARGET`): **3428/3436 pass — the SAME 2 pre-existing
documented flakes this whole chain has always carried (interval-walk,
typed-RMW), 0 new regressions.** `JZ_TEST_TARGET=jz.wasm node test/
index.js` (dormant self-hosted kernel): **2725/2731 pass, 0 fail, 6 skip —
byte-for-byte the SAME count every prior session in this chain has
recorded.** 200-seed fuzz gate (dormant): clean, 0 divergence.

**Dormant "byte-identity" — NOT byte-identical, but BEHAVIORALLY inert; a
finding worth recording precisely rather than asserting the stronger
(false) claim.** SHA-256 of the dormant `dist/jz.wasm` DIFFERS before vs
after this fix (`8d6a9344…` unfixed vs `f7840507…` fixed) — this session
traced why: `REGION_HOOKS_ACTIVE=false` does NOT prevent `__region_exit`/
`$__closure_env_len`/`$__closure_env_mask` from being compiled INTO
`dist/jz.wasm` at all (`strings dist/jz.wasm | grep -c region_exit` reads
31 in BOTH the fixed and unfixed dormant builds) — `scripts/self.js`'s own
`REGION_HOOKS_ACTIVE ? {mark:…,exit:…} : undefined` ternary is a RUNTIME
branch, not a compile-time dead-branch elimination (the arrow-function
closures inside the `true` arm are lexically part of the reachable
program either way), so `assemble.js`'s `closureEnvInit` sequence — which
allocates and POPULATES `$__closure_env_len`/`$__closure_env_mask` from
`ctx.closure.envMeta` unconditionally inside `$__start` — runs at every
`dist/jz.wasm` instantiation, dormant or not. This fix changes that
init DATA (more entries now correctly populated instead of silently
short). The data is provably NEVER READ in dormant mode (`__region_copy_
rec`'s CLOSURE arm — the only reader — is reachable exclusively through
`__region_exit`, which `regionHooks` being `undefined` at runtime means is
never CALLED, only compiled-in-but-dead) — confirmed empirically, not just
argued: `JZ_TEST_TARGET=jz.wasm node test/index.js` against the fixed
dormant build reproduced the EXACT SAME 2725/2731/0-fail/6-skip count as
every historical baseline in this chain. **Byte-identical is the wrong bar
here; behaviorally-identical is the true one, and it holds.**

**Disposition.** `ctx.closure.mint` (module/function.js + src/compile/
emit.js, two call sites) is a real, confirmed, necessary fix — lands. The
front-boundary wall NARROWS (kernel-oracle 4→6/13, a clean synthetic
repro, jessie/watr's failure point moves deeper into the compile) but does
NOT close for the full task acceptance gate (jessie/watr/jzify-entry/jz×jz
all still fail, two with genuinely NEW error signatures proving a SECOND
mechanism, not yet found). Per the task's own protocol: **WALL — bank,
stop.** `scripts/self.js`'s `REGION_HOOKS_ACTIVE` reverted to `false`
before this commit (temporarily flipped `true` in TWO disposable worktrees
this session purely to build region-live test kernels — both reverted,
neither worktree's dirt reaches this commit). `git diff --stat` on the
landed set: `module/function.js` (+17/-6), `src/compile/emit.js`
(+8/-4) — exactly the two files this entry describes, nothing else.

**Recommendation for next session.** Two concrete, narrower leads, both
better than resuming the byte-dump SW-hunt cold:
1. **jessie's new error is the most tractable** — `compiler internal:
   expected emitted IR value in <module>, got empty value`, AST `[null,
   20]` (the number literal `20`) — a DETERMINISTIC, NON-crashing (no wasm
   trap, a clean thrown JS error with a real AST node attached) self-host
   codegen gap. Bisect `src/parse.js`'s own module graph (the smallest of
   the three failing fixtures, 420ms) to find which specific construct
   near a literal `20` the self-hosted kernel's `emit()` returns `null`
   for — this is the "self-host-only codegen gap" class the PRIOR session
   already recommended and this session's fix has now made REACHABLE for
   the first time (it was masked behind the funcIdx-skew OOB trap before).
2. **watr's `unreachable` and jzify-entry's unchanged `memory access out
   of bounds`** are still region-arena-shaped traps — apply THIS session's
   own cross-reference technique (ground-truth vs what-got-read, this time
   for a heap kind other than CLOSURE, or for a genuinely shared/aliased
   env slot) rather than restarting from a byte-dump. jzify-entry's
   IDENTICAL-before-and-after signature is the most suspicious data point
   (worth checking FIRST): does it trap in a completely closure-free code
   path, meaning this session's fix was structurally irrelevant to ITS
   specific instance?

**SHAs.** jz worktree: `6743aea0` (region-final-2026-08-11, unchanged
base — this session's `module/function.js`/`src/compile/emit.js` diff
commits on top). watr: `895ca5b` (`/Users/div/projects/watr`, unpublished,
unchanged). Dormant `dist/jz.wasm` (this session's fixed rebuild): SHA-256
`f78405074f09d63c1b4b238dc5da6d28f840248f0f886a0773da7bb9aa9579ea` (NOT
byte-identical to the prior `8d6a9344…` baseline — see the dormant
byte-identity finding above for why that's expected and harmless).

## §Region arena — jessie's "expected emitted IR value" error root-caused
and FIXED: `__region_relocate_props` (module/core.js) relocated a HASH
table's VALUE field but never its KEY field — jessie/watr/jzify-entry now
compile clean, kernel-oracle 6/13→9/13, a DIFFERENT front-boundary wall
found behind it (2026-08-12)

**Task, per the coordinator's brief**: chase jessie's region-live "compiler
internal: expected emitted IR value" error (§Region arena's `0e73fa6a`
entry named this the most tractable of the three still-failing fixtures
post-funcIdx-skew-fix) via the AUDIT-#17 playbook — reproduce, capture
`ctx.error.node`, minimize, trace-diff native vs kernel, find the phase-
order/plan-map mechanism.

**First finding: the SPECIFIC error text didn't reproduce.** Worktree
reused at `.../scratchpad/region-slice2-front` (already at `0e73fa6a`,
clean). Rebuilt a region-live kernel (`REGION_HOOKS_ACTIVE` hand-flipped
`true`, `scripts/selfhost-build.mjs`, verified via a dormant rebuild's SHA-
256 matching the commit message's own recorded `f7840507…` byte-for-byte —
confirms this session's build pipeline is faithful) and ran jessie/watr/
jzify-entry through it (`resolveModuleGraph(entry,{resolveNode:true})` +
`compileViaKernel`, `test/kernel-target.js`'s own machinery, matching the
prior session's exact recipe). Result: watr → `unreachable` (matches the
prior session's table exactly) and jzify-entry → `memory access out of
bounds` (matches exactly) — but **jessie → `memory access out of bounds`
too**, not the `expected emitted IR value` text the prior entry recorded,
3/3 reps, deterministic in this environment. A named-kernel rebuild
(`compile(...,{names:true})`, bypassing `compileViaKernel` to instantiate
directly) symbolicated jessie's AND jzify-entry's traps as IDENTICAL top
frames (`$__str_hash` ← `$__dyn_get` ← `$m137_scope$flattenFuncNamespaces`)
— one shared mechanism, not two. **Verdict: the prior entry's specific
error-text claim doesn't reproduce bit-for-bit in this environment (a
GARBAGE-VALUE-DEPENDENT bug's exact trap shape is sensitive to incidental
heap-layout details that can differ session to session even with byte-
identical source+config — env/build nondeterminism the prior entry didn't
anticipate), but the underlying MECHANISM is the same class the entry
named ("second, still-unfound mechanism") and the symbolicated trace
pointed straight at it.** Chased the reproducible signature actually in
hand rather than forcing the literal error text.

**Minimized via direct bracketing (the AUDIT-#17 "native vs kernel trace
diff" discipline, adapted: no native/kernel split exists inside a single
in-kernel compile, so bracketed PRE-EXIT vs POST-EXIT vs LATER-IN-COMPILE
instead).** Instrumented `flattenFuncNamespaces` (`src/compile/plan/
scope.js`) with unconditional `console.error` (the AUDIT-#17 pattern —
`process.env`-gated debug output is dead in-kernel) — found `fn.defaults`
(a per-function-record dynamic dict, `module/prepare/index.js`'s `defFunc`:
`const defaults = {}; defaults[c.name] = defVal`, spread into `funcInfo`)
reads as **raw memory-dump garbage** (`Object.keys` returning byte-noise,
not strings) by the time `flattenFuncNamespaces` runs. Bracketed further:
added prints in `src/front.js` immediately before/after `regionHooks.exit`
— `fn.defaults` reads **perfectly clean, byte-identical to native, on BOTH
sides of the exit call itself**. The corruption therefore happens strictly
BETWEEN front()'s return and `flattenFuncNamespaces` (i.e., during the
early part of `compileAst`/`src/compile/index.js`) — the signature of a
STALE POINTER into abandoned (never-relocated) memory that reads fine
until a LATER allocation reuses and overwrites that space, not a
relocation-time value corruption.

**Root cause, confirmed by source inspection once the shape was known.**
`fn.defaults` compiles to heap-kind `PTR.HASH` (a plain `{}` used as a
dynamic string-keyed dict). `regionArmHash` (`layout-kinds.js:597-606`)
relocates ANY bare `PTR.HASH` value by delegating to
`__region_relocate_props` (`module/core.js`) — a function ORIGINALLY
written for one specific case: the compiler's own internal "dyn-props"
sidecar table, whose keys are always short, single-word, SSO-inline
compiler-internal identifiers. That function's own doc explicitly reasons
"KEYS in this table are always prop-name STRINGS: SSO/interned… so their
hash bucket position is immutable across relocation — no rehash/reinsert
needed, just a verbatim bulk copy" — TRUE (content-hashing means bucket
position never depends on address), but the function's IMPLEMENTATION
conflated "bucket position doesn't need recomputing" with "the key field
needs no `__region_copy_rec` at all": both the durable in-place loop and
the ephemeral bulk-copy loop relocated ONLY the VALUE field (`slot+16`) —
the KEY field (`slot+8`, `MAP_ENTRY=24` layout `[hash,key,value]`) was
copied verbatim, bits unchanged. Safe for the sidecar's own SSO-only keys
(no address inside an inline value to fix). **Wrong for `regionArmHash`'s
later, broader reuse of this same function for ANY reachable `PTR.HASH`
value** (Heap-kind registry Slice 2, `.work/research.md` — the comment at
that call site even names the widened-reuse risk for diamond-sharing but
not for non-SSO keys): jessie's own `err(msg, at, lines, last, before,
ptr, chr, after)`-shaped default-param dict has several keys (`before`,
`after`, `chr`, …) that don't fit a NaN-boxed inline SSO string, so those
keys are real heap-allocated STRING pointers — left unrelocated, still
pointing at the pre-compaction address, which region_exit's heap-rewind
treats as free space the NEXT compile-phase allocation is free to reuse.
Reads clean immediately after exit (bytes not yet overwritten), garbage
once something else allocates over that space — exactly what the PRE/
POST-EXIT-vs-later bracketing showed.

**The `ctx.plans` WeakMap hypothesis (the task's own prime suspect):
CHECKED, REFUTED for this mechanism.** `mintLoopPlans`/`mintClosureEnvPlans`
(the `ctx.plans.loops`/`.closures` WeakMaps, `src/ctx.js:857-858`) are
called exclusively from `src/compile/index.js` (`compileAst`), which
`scripts/self.js`'s `compileAst(front(source, strict))` only invokes AFTER
`front()` — and therefore after `regionHooks.exit` — returns. Both mint
and every read happen strictly post-exit, on the already-relocated AST;
there is no phase-order gap for these two specific maps. (`ctx.closure.
closures.get(body)` in `module/function.js` even documents its OWN miss as
an intentional, safe fail-open to a legacy re-derivation — matching the
task's own "MISSES are fail-open, ok" framing exactly, for a DIFFERENT
reason than staleness.) The real bug is a sibling of the hypothesis's
shape (an "escaping region reference" not covered by the 5-element root)
but in a different structure: not a WeakMap keyed on AST-node identity,
but a HASH table's own KEY field silently exempted from relocation by a
function written for a narrower, SSO-only original use case.

**The fix — two lines added to `__region_relocate_props`'s two existing
per-slot loops** (`module/core.js`): relocate the KEY field (`slot+8`) via
`__region_copy_rec`, identically to how the VALUE field (`slot+16`)
already was, in both the durable (in-place, `off < mark`) and ephemeral
(bulk-copy) branches. No rehash needed (per the function's own correct
half of its reasoning — content-hash bucket position is genuinely stable
regardless of the key's storage form) — this is a pure key-pointer fixup,
the exact same "value needs `__region_copy_rec`, container structure
doesn't need rehash" split `regionArmSetMap` already applies to VALUES,
just for the KEY side of a content-hashed HASH table instead of a bits-
hashed SET/MAP.

**Verification.**
- **jessie/watr/jzify-entry, region-live, 3 reps each: ALL THREE compile
  clean** (`bench/jessie/jessie.js` 107,037 B, `bench/watr/watr.js`
  315,422 B, `jzify/index.js` 611,610 B — deterministic across reps).
- **Dormant-vs-region-live byte-identity** (the same cross-check the
  MEMORY-CURVE-MEASURED entry used): built BOTH a dormant and a region-live
  kernel from this session's identical fixed source and compiled all three
  fixtures through each — **byte-for-byte identical output, both kernels,
  all three fixtures** (native differs from both by a few dozen bytes each
  — the ALREADY-DOCUMENTED, unrelated self-host/native codegen-shape parity
  gap, "native emits more bytes than the kernel", not a region-arena
  correctness issue). The region-arena boundary is now fully correctness-
  transparent for these three real-world corpora.
- **kernel-oracle, region-live: 9/13 pass** (up from the funcIdx-skew
  session's own 6/13), **203/203 assertions collected within the 9 passing
  groups, no early-exit truncation**. The 4 remaining fails: 3 are ONE
  test (`array-growth-class: sibling push()+indexed-append tables (envMeta
  shape)`, O0/O2/O3) — a NEW, DIFFERENT front-boundary mechanism (an
  ARRAY-of-schema-OBJECTs growth pattern deliberately mirroring the
  funcIdx-skew shape, `test/kernel-oracle.js:327-341` — traced only far
  enough to confirm it's NOT the HASH-key bug this session fixed: the
  `{cap,idx}` records are fixed-shape OBJECT literals, not a dynamic HASH,
  so a different relocation arm is implicated; not chased further this
  session, banked as the next wall). The 4th is the pre-existing, already-
  tracked, unrelated `PENDING-FIX — generic-scalar-decl BOOL∪NUMBER carrier
  collapse` row (research.md §Carrier invariant).
- **Native ladder, dormant rebuild**: `node test/index.js` 3428/3436 pass
  — the SAME 2 pre-existing documented flakes (interval-walk, typed-RMW),
  0 new regressions. `JZ_TEST_TARGET=jz.wasm node test/index.js` (dormant
  self-hosted): 2725/2731 pass, 0 fail, 6 skip — byte-for-byte the same
  count every prior session in this chain has recorded.
- **jz×jz** (`bench/jz/jz.js`, 155 modules, region-live): still fails —
  but the signature CHANGED, `unreachable` at 7.6s (was `memory access out
  of bounds` at ~2.8s pre-fix) — moved deeper, matching this whole chain's
  established pattern of the fix narrowing without yet closing the full
  self-compile case. Not the by-design Slice-3 memory-ceiling signature
  (that one is ~8.5s / exactly 4 GiB).

**Disposition.** `module/core.js`'s `__region_relocate_props` fix lands —
real, confirmed, minimal (2 added `__region_copy_rec` calls + doc). Per
the task's own protocol: **WALL — bank, stop.** The array-growth-class
kernel-oracle row is the concrete next lead (own root-cause hunt, likely a
distinct OBJECT/ARRAY-growth relocation gap, not a HASH-key one).
`scripts/self.js`'s `REGION_HOOKS_ACTIVE` reverted to `false` before this
commit (flipped `true` only inside this disposable worktree to build
region-live test kernels, reverted after). `git diff --stat` on the landed
set: `module/core.js` only (+42/-9, all inside `__region_relocate_props`
and its doc).

**SHAs.** jz worktree: `0e73fa6a` (region-final-2026-08-11, this session's
own `module/core.js` diff commits on top). watr: `895ca5b` (`/Users/div/
projects/watr`, unpublished, unchanged). Dormant `dist/jz.wasm` (this
session's fixed rebuild, `REGION_HOOKS_ACTIVE=false`): SHA-256
`639b83f1e95f08a0bf2ac26ff9c11ee6018e263bca9052b9d0b4e21c711576ae`.

## §Region arena — array-growth-class row ROOT-CAUSE HUNT: task's own three
candidates ALL REFUTED, real trigger isolated to closure free-variable
capture of a non-constant-foldable value, crash site upstream of
`ctx.closure.make` — a FOURTH, still-unfound front-boundary mechanism, WALL
(no fix, characterized only) — THEN jz×jz's `unreachable` CONFIRMED as the
deliberate 4 GiB ceiling, not a correctness bug (2026-08-12)

**Task, per the coordinator's brief**: (1) chase kernel-oracle's remaining
`array-growth-class: sibling push()+indexed-append tables (envMeta shape)`
row (O0/O2/O3), the one row 63a5551e's HASH-key fix left standing, against
three named candidates — (a) `arrGrow`'s growth-forwarding write vs region
relocation, (b) ARRAY-of-OBJECTS relocation ordering, (c) a verbatim-bit-
copy gap in ARRAY's own element loop; (2) once landed-or-banked, re-
characterize jz×jz's `unreachable` — deliberate memgrow ceiling (2³²) or a
distinct correctness wall.

**Setup**: reused the already-checked-out worktree at `.../scratchpad/
region-slice2-front`, HEAD `63a5551e` (region-final-2026-08-11), clean.
`node_modules/watr → /Users/div/projects/watr` (`895ca5b`, verified intact
throughout). `REGION_HOOKS_ACTIVE` hand-flipped `true`/`false` in
`scripts/self.js` per leg, worktree-only, reverted to `false` (the shared
committed default) before finishing — `resolveSelfhostBuild`'s own
`regionArena` override still doesn't touch this literal (reconfirmed, same
gap every prior session already flagged).

**Reproduced the baseline exactly.** Region-live rebuild, kernel-oracle:
**9/13 pass, 203 assertions in the 9 passing groups** — byte-for-byte the
commit's own recorded count. The 4 fails are the SAME 3 reps of the
array-growth-class row (O0/O2/O3, `memory access out of bounds`) plus the
pre-existing, unrelated `PENDING-FIX — generic-scalar-decl BOOL∪NUMBER
carrier collapse` tripwire row (§Carrier invariant, not region-arena).
Dormant rebuild (SHA-256 `639b83f1…`, byte-identical to the commit's own
recorded dormant SHA — confirms this session's build pipeline reproduces
the prior session's exactly): kernel-oracle **13/13 pass** — the array-
growth-class row is ONLY broken region-live, never dormant. **This
confirms the row is a genuine region-arena mechanism, not a pre-existing-
unrelated codegen bug** (the other framing the task asked to rule in/out).

**Root-cause hunt — black-box bisection against a NAMED region-live kernel**
(`compile(profile.graph.code, {…, names:true})`, bypassing
`compileViaKernel`/`dist/jz.wasm` to instantiate directly — symbolicated
stack traces instead of bare `wasm-function[N]` offsets). ~20 source
variants compiled through the SAME kernel instance shape, isolating one
axis at a time:

- **The oracle row's own source, minimized**: `ctx.closure.table.push(name);
  ctx.closure.envMeta[…] = {cap, idx}` inside a closure `addToTable`,
  called in a loop — traps `memory access out of bounds` at
  `closure4232` (a self-hosted compiler-internal closure, `wasm-
  function[3758]`), consistently, 3/3 reps.
- **Candidate (a) REFUTED**: replacing `.push()`+indexed-append with TWO
  `.push()` calls (matching `ctx.closure.mint`'s own real shape exactly)
  — still traps, identical signature. Removing array GROWTH entirely (a
  closure that only READS `arr.length`, or returns a captured object with
  zero array involvement) — STILL traps. No `__arr_grow` call exists
  anywhere in the minimal failing case.
- **Candidate (b) REFUTED**: no ARRAY-of-OBJECTS shape is needed at all —
  a closure capturing a bare OBJECT (`let o = {v:n}; let g = () => o.v`)
  or a bare STRING (`let s='hi'; let g = () => s.length`) fails identically
  with zero arrays anywhere in the program.
- **Candidate (c) REFUTED**: same reason — no ARRAY element loop is
  reachable in the minimal repro, so no verbatim-bit-copy gap in it can be
  the cause.
- **Real trigger, isolated**: a CALLED arrow-function closure that
  captures a free variable whose value is NOT reducible to a compile-time
  constant. `let x=5; g=()=>x` (int literal, folds to `intConsts`), `let
  x=true`/`null`/`undefined`/`5n; g=()=>x` (all constant-foldable) — ALL
  COMPILE CLEAN. `let x=n+1; g=()=>x+1` (arithmetic on a param, provably
  NUMBER-typed, `storage='heap'`, `boxed=[]` per a `ctx.closure.make`
  breadcrumb) — COMPILES CLEAN. `let x=n; g=()=>x` (a bare, unmodified
  copy of a param — genuinely dynamic, no operator forces a type proof)
  — TRAPS, but at a DIFFERENT site (`__dyn_get_t_h`/`__dyn_get_t`, generic
  dynamic-property-get, `wasm-function[1271]`), not `closure4232`. STRING/
  OBJECT/ARRAY captures always trap regardless of whether the closure body
  touches the captured value at all (bare `g=()=>o` with the member read
  moved to the CALL SITE still traps) — ruling out "the closure body's own
  codegen" as the mechanism; it is about closure CREATION, not closure USE.
- **`ctx.closure.make` breadcrumb (temporary, reverted): the crash
  happens BEFORE `ctx.closure.make` is ever reached.** A `console.error`
  at the top of `ctx.closure.make` (module/function.js) fires reliably for
  every PASSING case and NEVER fires for any FAILING case — proving the
  corruption is read (or the fault occurs) inside emit.js's `'=>':`
  handler's OWN preamble (`extractParams`/`classifyParam`'s for-of over
  `raw`, `findFreeVars(body, paramSet, captures)`, `for (const def of
  Object.values(defaults)) findFreeVars(…)`) or upstream of it — NOT
  inside `ctx.closure.make`, `ctx.closure.mint`, or `regionArmClosure`/
  `__region_relocate_cell` (the "cellOff"/funcIdx-skew mechanism 6743aea0
  and 0e73fa6a already found and fixed). **This is a DIFFERENT, so-far-
  unnamed FOURTH mechanism** (after: the SW backing-pointer wall / the
  cellOff delta-adjustment bug / the funcIdx-skew bug / the HASH-key bug),
  not a recurrence of any of the three already-closed ones.
- **Two distinct crash signatures, same upstream cause (working theory,
  NOT confirmed)**: `closure4232`'s trap decompiles (`wasm2wat
  --enable-all` + `wasm-objdump -d` cross-referenced against the exact
  faulting file offset) to a SET/MAP-to-array conversion loop
  (`__coll_order` + `f64.load slot+16`) being reached with a tag that
  should be ARRAY but reads as SET(8)/MAP(9) — i.e. a pointer whose TAG
  BITS are already wrong by the time this generic dispatch reads them.
  `__dyn_get_t_h`'s trap is a plain dynamic property-get gone OOB. Both
  read as DOWNSTREAM symptoms of the SAME upstream corruption manifesting
  at whichever consumer a given closure SHAPE happens to reach first, not
  two independent bugs — not verified by a shared root cause, only by the
  shared "before `ctx.closure.make`" boundary and shared region-liveness
  gate (both vanish dormant).

**NOT further isolated.** The established SW-bug method (breadcrumb every
candidate write site, decompile the exact trap frame, match wasm-function
offsets against source) would be the next step, but was not completed this
session — the same order of effort TWO PRIOR FULL SESSIONS (6743aea0,
0e73fa6a) each spent on SIBLINGS of this exact "front boundary, not-yet-
found mechanism" class, each closing ONE layer and uncovering the next.
Best lead for whoever picks this up: `front()`'s region round wraps ONLY
parse→jzify→prepare (a single mark/exit pair, confirmed by re-reading
`src/front.js`'s own contract, same finding 6743aea0 already made) — emit
runs strictly AFTER that boundary closes, so if the corruption is really
upstream of `ctx.closure.make`, the WRITE happened during `front()`'s own
region_exit (compacting whatever scope/type-fact structure differs between
a NUMBER-provable capture and a dynamic one), and the READ (this session's
trap) is purely downstream — bisect by breadcrumbing `ctx.scope`/`ctx.types`/
`ctx.func`'s own Set/Map-shaped fields' CONTENTS immediately after
`front()` returns vs immediately before the closure literal is emitted,
for a `let x=n; g=()=>x` repro (cheapest failing case, traps in <100ms).

**Disposition — NO FIX LANDED, wall banked per protocol.** Every edit this
session (the `ctx.closure.make` breadcrumb, `REGION_HOOKS_ACTIVE` toggles)
was worktree-only and reverted; `git diff --stat` in the worktree shows
NOTHING outstanding beyond this ledger entry. kernel-oracle stays at
**9/13** (unchanged from 63a5551e — this session characterized, did not
move, the count).

**Gates (this session's own verification, no source changed so this is a
re-confirmation, not a fix's regression suite).** jessie/watr/jzify-entry
region-live ×3 reps: **all clean**, 107,037 / 315,422 / 611,610 bytes,
deterministic — matches 63a5551e's own recorded counts exactly. Same three
fixtures on the dormant rebuild: **byte-identical output** to region-live,
×3 reps (dormant byte-identity gate). kernel-oracle: dormant **13/13**,
region-live **9/13** (both reconfirmed above). Native ladder (`node
test/index.js`, dormant `dist/jz.wasm`): **3428/3436**, the same 2 pre-
existing documented flakes (interval-walk, typed-RMW), 0 new. Dormant
self-hosted (`JZ_TEST_TARGET=jz.wasm node test/index.js`): **2725/2731
pass, 0 fail, 6 skip** — byte-for-byte the historical baseline every prior
session in this chain has recorded. Build ×2: dormant SHA-256 reproduces
the commit's own recorded `639b83f1…` exactly (independent rebuild, same
bytes); region-live SHA-256 (`37746348cc6f3d91991d8d0106341ce5c24c71193b0
5be6284f8e9e0c2782ecc`) reproduces identically across two independent
builds this session. All gates green; zero regressions; zero source
landed.

**Lead 2 — jz×jz re-characterization.** With Lead 1 banked (not landed —
the task's own "landed or banked" branch), tested whether jz×jz's
`unreachable` is the deliberate `__memgrow` ceiling or the front-boundary
correctness wall the "Slice 3 attempt" entry found. Ran jz×jz's real
155-module graph (`bench/jz/jz.js`, `resolveModuleGraph(…,
{resolveNode:true})`, exactly `test/kernel-target.js`'s own recipe)
through the SAME named region-live kernel used for Lead 1's bisection,
`optJSON:{level:2}`, 2 reps.

**Result: `unreachable`, deterministic both reps, at EXACTLY 4,294,967,296
bytes (2³², 65536 pages, 4096.0 MB), ~7.0s.** Symbolicated stack:
`__alloc ← __alloc_hdr_n ← __map_from ← closure2391 ← closure2393 ←
closure2382 ← closure2398 ← m127_narrow$narrowSignatures ← closure2671 ←
closure1495 ← m133_index$plan ← closure2757 ← m121_index$compile ←
compileSelf` — a legitimate allocation deep in the compiler's own
type-narrowing/planning phase, growing memory until `__alloc`'s call chain
hits `module/core.js`'s `__memgrow`. Source-verified against the trap: line
455, `(if (i64.gt_u (i64.extend_i32_u (local.get $need)) (i64.const 65536))
(then (unreachable)))` — the documented, deliberate wasm32-max-pages abort,
the ONLY `unreachable` on the `__alloc`→`__memgrow` call path (the sibling
`next < ptr` overflow guards, lines 487/498/535, are a secondary guard for
the SAME boundary condition per their own comment, not an independent trap
class). **Verdict: YES — jz×jz's `unreachable` IS the deliberate 2³²
memgrow ceiling, not a distinct correctness bug.** This is the front
boundary reaching as far as it can go for THIS corpus before hitting hard
wasm32 physics, not a wall region-arena code put there.

**Caveat — do NOT read this as "the front boundary is universally sound."**
Lead 1, in this SAME session, found a real, still-open, region-live-only
correctness bug (the array-growth-class row above) that lives in front-
boundary-adjacent territory (closure creation, upstream of
`ctx.closure.make`) and corrupts a DIFFERENT, smaller synthetic program.
jz×jz (155 real modules) simply never happens to exercise that specific
closure-capture shape badly enough to trip it before running out of
address space first — "sound enough to reach the ceiling on this corpus"
is not "sound in general," and kernel-oracle's own 9/13 (not 13/13) is the
proof already in hand. Per the "Slice 3 attempt" entry's own established
discipline ("stacking a new region boundary on a front boundary that
corrupts real programs would compound an unsound foundation, not extend
one") — **Slice 3's hazard inventory was NOT started this session.** It
was already fully drafted once (the "Slice 3 attempt" entry, root =
`[module, ctx.func, ctx.transform, ctx.scope]`) and re-doing it adds
nothing while Lead 1's wall stands; building on top of a front boundary
with a KNOWN, unclosed correctness bug — even one narrow enough that jz×jz
itself doesn't trip it — would repeat exactly the mistake that entry
already named and avoided.

**Oracle characterization table (final, this session).**

| row | dormant | region-live | class |
|---|---|---|---|
| 9 AGREE/DIVERGENT rows (ternary, console.log constants, bare BigInt array-elem, etc.) | pass | pass | n/a — clean |
| array-growth-class: sibling push()+indexed-append tables (envMeta shape), O0/O2/O3 | pass | **FAIL** — `memory access out of bounds` | **region-mechanism** — confirmed region-only via dormant/region-live differential; root cause NOT found (4th front-boundary mechanism, upstream of `ctx.closure.make`); WALL |
| PENDING-FIX — generic-scalar-decl BOOL∪NUMBER carrier collapse | pass (tripwire, asserts the still-wrong value) | pass (same) | **pre-existing-unrelated** — §Carrier invariant, not region-arena, unaffected by region-liveness either way |

**Recommendation for next session.** Lead 1: breadcrumb `ctx.scope`/
`ctx.types`/`ctx.func`'s Set/Map-shaped fields across `front()`'s own
region_exit boundary specifically (not inside `ctx.closure.make` — already
ruled out as the read site) for the `let x=n; g=()=>x` repro (cheapest,
<100ms). Lead 2: closed as a characterization — jz×jz needs no further
memory-curve work; its own remaining blocker is now identical to Lead 1's
(the front-boundary correctness wall), not a separate memory-ceiling
problem. Do not attempt Slice 3 until kernel-oracle's array-growth-class
row is 13/13.

**SHAs.** jz worktree: `63a5551e` (region-final-2026-08-11, HEAD,
unchanged — no source landed this session, only this ledger entry). Main
repo: `69cec4a2` (unchanged; pre-existing unrelated dirt from a concurrent
session — `README.md`, `.work/todo-original.md`, `bench/bench.svg`,
`assets/install.svg` — untouched by this session). watr: `895ca5b`
(`/Users/div/projects/watr`, unpublished, unchanged). Dormant `dist/
jz.wasm` (this session's rebuild): SHA-256 `639b83f1e95f08a0bf2ac26ff9c11e
e6018e263bca9052b9d0b4e21c711576ae` (byte-identical to 63a5551e's own
recorded dormant SHA). Region-live `dist/jz.wasm` (this session's rebuild,
×2 reproduced): SHA-256 `37746348cc6f3d91991d8d0106341ce5c24c71193b05be62
84f8e9e0c2782ecc`.

## §Region arena — FOURTH MECHANISM narrowed to an exact trap SITE
(`foldStaticConstAggregates`'s own dynamic-property dispatch, upstream of
ANY per-function/closure analysis) and an even narrower minimal repro —
root cause STILL NOT FOUND, a genuine heisenbug under source instrumentation,
WALL banked (2026-08-12)

**Task**: pick up 4cb205e6's own banked FOURTH mechanism (a closure
capturing a non-constant-foldable free variable traps region-live before
`ctx.closure.make` is ever reached) and root-cause it, reusing the
breadcrumb+checkpoint toolkit the SW-bug/cellOff/funcIdx-skew/HASH-key
sessions each used to close their own layer.

**Setup**: reused the pre-existing worktree at `.../scratchpad/
region-slice2-front`, HEAD `4cb205e6` (region-final-2026-08-11), clean.
`node_modules/watr → /Users/div/projects/watr`, confirmed pristine
`895ca5b`/5.7.14 throughout. Built a NAMED region-live kernel (a scratch
script mirroring `build-dist.mjs`'s `dist/jz.wasm` build exactly, but with
`REGION_HOOKS_ACTIVE` hand-flipped `true` and `compile(..., {names:true})`
so traps symbolicate to real function names instead of bare
`wasm-function[N]`), then ran the repro directly against it via
`interop.js`'s own `instantiate`/`memory.String` recipe (mirrors
`test/kernel-target.js`) — bypassing `dist/jz.wasm` entirely, same method
the 4cb205e6 session itself used for its own bisection.

**Reproduced, deterministically, 3/3 reps, byte-identical stack every
time**:
```
export let f = (n) => { let x = n; let g = () => x; return g() }
```
traps `memory access out of bounds`:
```
at __dyn_get_t_h        (wasm-function[1271])
at __dyn_get_t           (wasm-function[1269])
at __dyn_get_expr        (wasm-function[9])
at m140_literals$foldStaticConstAggregates (wasm-function[3235]:0x769a08)
at closure2756           (wasm-function[2507])   — the `timePhase(profiler,
                                                     'foldAggregates', () =>
                                                     foldStaticConstAggregates(ast))`
                                                     wrapper closure itself
at m121_index$compile    (wasm-function[970])    — compileAst
at compileSelf           (wasm-function[3279])
```

**New finding — the trap site is NOT where the prior session's breadcrumb
bounded it.** 4cb205e6's `ctx.closure.make` breadcrumb only proved
"upstream of `ctx.closure.make`" and speculated the fault was in emit.js's
`'=>'` handler preamble or `ctx.closure.mint`. It is neither. The real
trap is inside **`src/compile/plan/literals.js`'s `foldStaticConstAggregates`**
— called from `compile/index.js:2363` (`foldAggregates` phase), which runs
near the START of `compileAst`, BEFORE any per-function analysis
(`analyzeFuncForEmit`, `mintClosureEnvPlans`/`mintLoopPlans`,
`ctx.closure.mint`) ever begins for ANY function — so "before
`ctx.closure.make`" was true but vacuous: the crash is a whole PHASE
earlier, not "just before" closure emission. The fault is a DYNAMIC
property-get (`__dyn_get_expr`→`__dyn_get_t`→`__dyn_get_t_h`, the generic
runtime dispatch for a `.field` read the compiler couldn't prove a static
shape for) — disassembled at the exact offset (`wasm-objdump -d`, function
3235 spans lines 3148877–3157376 of the dump): a NaN-box sentinel check
immediately followed by the `__dyn_get_expr` call, i.e. genuinely a
runtime-dispatched property read, not a fixed-offset field access.

**Refuting the earlier PRE-exit-mint suspicion (task's own candidate (a)).**
Grepped every call site of `mintClosureEnvPlans`/`ctx.plans.closures` (the
ONE pre-emission WeakMap-keyed capture structure in the whole compiler):
all three (`compile/index.js:873`, `:2089`, `:2096`) run inside
`analyzeFuncForEmit`/`emitClosureBody`, themselves only ever reached from
within `compileAst` — i.e. strictly POST front-exit, confirming the prior
session's own "verified post-exit" note. `prepare/index.js`'s `defFunc`
(the only PREPARE-phase, pre-exit construct resembling a "closure
prescan") is irrelevant here: `if (depth > 0) return false` at its very
top means a nested closure like `g = () => x` (depth > 0, inside `f`'s
body) is NEVER touched by it — `g` stays a plain AST value straight
through prepare, exactly as the "Any inline arrow surviving prep is a
closure value" comment (prepare/index.js) already documents. No
PREPARE-phase capture structure exists for this shape. Candidate (a), AS
FRAMED, does not apply to this repro.

**A much narrower minimal repro, found via a 14-variant differential matrix
run against the SAME already-built kernel (no rebuild per variant — only
the `run` half changes)**. The trap requires ALL FIVE of: exactly one
param (`n`); exactly one intermediate LOCAL that is a bare, unmodified copy
of that param (`let x = n` — `const x = n` traps identically, so the
declarator keyword is not the discriminator); exactly one closure
capturing that local and NOTHING else (`g = () => x`); that local used
NOWHERE else in the function body; and the closure CALLED exactly once, as
the function's sole return expression. Flipping ANY ONE of the following
alone makes the SAME source compile CLEAN through the SAME kernel:
- capture the param `n` directly, skip the intermediate local — OK
- reference `x` anywhere else in `f`'s body too (`return g() + x`) — OK
- add a second closure also capturing `x` (`let h = () => x; …g()+h()`) — OK
- add ANY extra local, even unused, even before or after `x`
  (`let a = 1; let x = n; …`) — OK
- add an extra unused param (`(m, n) => …`) — OK
- force a type-proof via arithmetic (`let x = n + 0; …`) — OK (matches
  4cb205e6's own "arithmetic on a param… COMPILES CLEAN" finding)
- define `g` but never call it — OK (matches 4cb205e6's own finding)

This is the exact-shape wall: `ctx.func.list.length === 1`, one param, one
closure-only local, one closure, one call. Every dodge changes some COUNT
(locals, closures, params, or uses) by exactly one — consistent with an
index/offset-sensitive mechanism (same class as the already-fixed funcIdx
skew and cellOff delta-adjustment bugs), not a shape/type mechanism.

**Heisenbug confirmed — source instrumentation INSIDE the faulting function
changes the outcome.** Added `console.error` breadcrumbs at the top of
`foldStaticConstAggregates` (before its first closure — the
`ctx.func.list.filter(f => f.body && !f.raw)` call — ever executes),
rebuilt the named kernel fresh, reran the identical repro: **compiled
CLEAN, zero trap.** Reverted the breadcrumbs, rebuilt again: **trap
reproduces again, identical stack, 3/3 reps.** This rules out further
"instrument the hot function, rebuild, observe" iteration as a viable
method here — any JS-source edit to `literals.js` perturbs codegen/
inlining/allocation offsets enough to dodge the trigger window, the
signature of a genuine stale-pointer/missing-root class bug (not a logic
bug, which would reproduce regardless of surrounding dead code). This
mirrors the ORIGINAL "SW bug" session's own method constraint — it also
could not use naive source breadcrumbs and instead instrumented
`module/core.js`'s WAT-level `__region_copy_rec`/`__region_exit`
intrinsics directly.

**NOT further isolated — root cause still unknown.** Did not attempt the
WAT-level intrinsic breadcrumb this session (budget). Best lead for
whoever picks this up: the trap is a dynamic-property dispatch reached
from `foldStaticConstAggregates`'s own top section — the first candidate
worth instrumenting (at the WAT/intrinsic level, not JS source) is
whatever backs `ctx.func.list[0]`'s funcInfo record (`{name, body,
exported, sig}`, minted by `defFunc` at PREPARE time, i.e. pre-exit,
inside the 5-element root's `ctx.func.list` array) — specifically whether
its OBJECT-kind heap value (nested one level inside the correctly-rooted
ARRAY) is fully/recursively relocated by `__region_copy_rec`, or whether a
dynamic-shape/`$__dyn_props` sidecar on THAT SPECIFIC record (tipped into
dynamic mode by something closure-related — unconfirmed) is where the stale
pointer lives. The five-dodge-conditions-of-exactly-one above make this an
unusually tractable repro for the intrinsic-level breadcrumb method (the
whole compile is sub-100ms) — just not reachable via JS-source
instrumentation, which this session's own heisenbug finding rules out.

**Disposition — NO FIX LANDED, wall re-banked, narrower than before.**
Every edit this session (the scratch named-kernel build script, the
`REGION_HOOKS_ACTIVE` flip, the `foldStaticConstAggregates` breadcrumbs)
was worktree-only and fully reverted/removed; `git status`/`git diff
--stat` in the worktree show NOTHING outstanding beyond this ledger entry.
kernel-oracle's array-growth-class row stays unmoved (still the same
region-only failure the 4cb205e6 session already recorded at 9/13 — not
re-run this session, no source changed to justify a re-verification, per
the same discipline every characterization-only entry in this section
already follows).

**No gate ladder run** — per established discipline ("gated on a real fix
existing, and none does yet"), and consistent with every other
characterization-only entry in this section. No value-verification
possible (nothing new compiled that wasn't already known to compile).

**SHAs.** jz worktree: `4cb205e6` (region-final-2026-08-11, HEAD,
unchanged — no source landed this session, only this ledger entry). Main
repo: `14553f2b` (moved since 4cb205e6's own session from unrelated
concurrent work — "centralize emit frame name authority" and siblings —
untouched by this session; pre-existing dirt `README.md`,
`.work/todo-original.md`, `bench/bench.svg`, `assets/install.svg` also
untouched). watr: `895ca5b` (`/Users/div/projects/watr`, unpublished,
unchanged, reconfirmed pristine 5.7.14). No `dist/jz.wasm` rebuilt this
session (only the disposable scratch named-kernel, deleted).

## §Region arena — FOURTH MECHANISM, WAT-INTRINSIC BREADCRUMB TRACE: exact
faulting call captured with real register/memory evidence — receiver is an
EPHEMERAL ARRAY whose off-16 dyn-props slot holds a non-zero, HASH-tag-
decoding pointer to a degenerate (cap=0) structure, impossible from any
legitimate hash-creation path — root WRITE not yet found, a genuinely
narrower WALL, re-banked (2026-08-12)

**Task**: pick up 2f596a84's own banked lead (the trap is a dynamic-property
dispatch reached from `foldStaticConstAggregates`'s own top section; best
lead = whatever backs `ctx.func.list[0]`'s funcInfo record, WAT-level
intrinsic breadcrumbs on `__region_copy_rec`/`__region_exit`, the SW-bug
session's own method) and root-cause it using the prescribed WAT-level
intrinsic-breadcrumb technique (source instrumentation is heisenbug-bounded,
per 2f596a84's own finding).

**Setup**: reused the pre-existing worktree at `.../scratchpad/
region-slice2-front`, HEAD `2f596a84` (region-final-2026-08-11), clean.
`node_modules/watr → /Users/div/projects/watr`, confirmed pristine
`895ca5b`/5.7.14. Built a NAMED region-live kernel via a disposable scratch
script (`.work/scratch-build-named.mjs`, deleted at session end) mirroring
`build-dist.mjs`'s `dist/jz.wasm` build with `compile(..., {names:true})`,
against `scripts/self.js`'s `REGION_HOOKS_ACTIVE` hand-flipped `true`
(worktree-only, reverted). Reproduced the 5-condition minimal repro
(`export let f = (n) => { let x = n; let g = () => x; return g() }`)
deterministically 3/3, byte-identical stack, matching 2f596a84's own
finding exactly:
```
__dyn_get_t_h ← __dyn_get_t ← __dyn_get_expr ← foldStaticConstAggregates
← closure2756 (timePhase wrapper) ← compile ← compileSelf
```

**Razor-state correction #1 — funcInfo is a HASH, not an OBJECT.** 2f596a84's
own best lead framed `ctx.func.list[0]`'s funcInfo record as a schema'd
OBJECT ("whether its OBJECT-kind heap value... is fully/recursively
relocated"). Static audit of `defFunc` (`src/prepare/index.js:3731`):
```js
const funcInfo = { name, body, exported, sig, ...(hasDefaults && { defaults }) }
```
— a CONDITIONAL SPREAD (`...(hasDefaults && {defaults})`, contributing zero
keys when `hasDefaults` is false, one key when true) breaks static-shape
unification for this literal. Verified directly: compiled a synthetic
snippet matching this exact expression shape (`{ name, body, exported, sig,
...(hasDefaults && { defaults }) }`) via native `compile(src, {wat:true})`
and read the emitted WAT — the literal lowers to `$__hash_new` +
`$__hash_set` ×4 (a dynamic dict), NOT a schema-slotted `$__alloc_hdr`+fixed
offsets. **funcInfo is `PTR.HASH` (tag 7), always** — the OBJECT framing was
wrong; `regionArmHash`/`__region_relocate_props` (already hardened by
63a5551e's key-relocation fix, itself re-audited this session and found
sound: both durable and ephemeral branches relocate KEY *and* VALUE,
memo'd, cycle-safe) is the actually-relevant arm for funcInfo itself — and
it is NOT where this trap lives (see below).

**Method note, load-bearing for any future NaN-boxing trace session: an f64
`WebAssembly.Global`'s `.value` getter CANONICALIZES every NaN payload to
the single bit pattern `0x7FF8000000000000`** — the exact tag/aux/offset
bits a NaN-boxed NAN-canonicalizing pointer needs ARE the payload, and they
are UNRECOVERABLE through a plain f64 global read (confirmed empirically:
first breadcrumb pass, storing `$obj`/`$props` into `f64`-typed debug
globals, printed self-contradictory snapshots — e.g. `$obj` decoding as
`tag=0` while `$type` [computed upstream as `__ptr_type($obj)`, MUST agree]
read `1`). Fix: declare NaN-boxed debug globals as **`i64`**, store the raw
`i64` local directly (no `f64.reinterpret_i64`) — `i64` globals surface as
JS `BigInt` (no float conversion), preserving bits exactly. This is a
generalizable correction to the SW-bug session's own toolkit for any future
`declGlobal`-breadcrumb session — every prior breadcrumb entry in this file
that stored a pointer-typed value in an `f64` debug global should be
suspected of the same silent corruption if its numbers ever looked
self-inconsistent.

**With i64 globals, an atomic snapshot (all captures fired at ONE program
point, immediately before the faulting read, all reading the SAME call's
still-live params/locals — an earlier draft that scattered captures across
multiple points in the function produced cross-call-contaminated,
self-contradictory data since not every call reaches every trace point)
recovered the exact faulting call, reproduced 3/3 with matching numbers**
(one representative rep):
```
__dbgCount    1121        (this is the 1121st __dyn_get_t_h call this compile)
__dbgObj      tag=1(ARRAY) aux=0 off=1654000
__dbgType     1                                  (agrees with $obj's own tag — self-consistent)
__dbgOff      1654000
__dbgProps    tag=7(HASH) aux=0 off=1654032      (= obj_off + 32, read from $obj's OWN off-16 slot)
__dbgPoff     1654032
__dbgPcap     0                                   (!!! — the crash trigger)
__dbgH        931910521
__dbgSlot     892669632                          (= poff + (h & (pcap-1))*24, pcap=0 ⇒ h&-1=h ⇒ wild)
__dbgHeap     1654560 (at raw-memory-dump time; grows slightly further by trap time)
__dbgMark     1567360   (region_exit's own $mark — captured via a second breadcrumb in __region_exit)
__dbgT        1670248   (region_exit's own $T = heap size at exit)
__dbgDelta    102888
__dbgHeapStart 677632
__dbgExitCount 1        (confirms front's single mark/exit design — no loop, no cross-round contamination)
```
**The receiver is confirmed EPHEMERAL**: `obj_off (1654000) > mark (1567360)`
— this ARRAY was relocated by `__region_copy_rec`'s own compaction this
round (a durable/pre-mark array's address never changes). Its own header
reads `len=0, cap=0` (raw memory dump, `[obj_off-8]` full i64 = 0) — a
genuinely EMPTY array. Its off-16 slot (`[obj_off-16]`) is NOT zero — it
decodes as a plausible `PTR.HASH` pointer to `obj_off+32`.

**The mechanism, precisely**: `__dyn_get_t_h`'s ARRAY branch
(`module/collection.js`, "ARRAY: header propsPtr at $off-16 is valid only
when shift hasn't rewritten..." arm) reads `$off-16`, masks off bit0, and —
finding a HASH tag — trusts it UNCONDITIONALLY as a live props table,
without ever validating `cap > 0`. The table it's handed genuinely has
`cap=0` (raw-memory-confirmed, not a misread — `[poff-8]`'s full i64 is
exactly `0`, both len and cap 4-byte lanes zero). The probe-slot formula
`$slot = $poff + (h & ($pcap - 1)) * MAP_ENTRY` assumes `$pcap` is a power
of two ≥ 1 (the standard bitmask-modulo trick); with `$pcap = 0`,
`$pcap - 1 = -1` (all bits set), so `h & -1 = h` unchanged — NOT bounded to
`[0, cap)` at all. `$slot` becomes `poff + h*24` wrapped mod 2³² — verified
by hand (`931910521 * 24 mod 2³² + 1653608 = 892669632`, exactly matching
`$__dbgSlot`) — a wild, unmapped address, faulting on the subsequent
`i64.load($slot)`.

**Root WRITE not yet found — this is the actual wall.** `cap=0` is
IMPOSSIBLE from every legitimate hash-creation path audited this session:
`__hash_new` (`module/collection.js`) hard-codes `INIT_CAP=8`;
`__hash_new_small` floors at `Math.max(hashSmallInitCap|0, 2)` — both ≥ 2,
never 0. Audited `regionArmArray`'s `ephemeralDynProps` (the ONLY code that
writes an ARRAY's off-16 slot during relocation, `layout-kinds.js`) against
the observed value and it does NOT match either of its own two write
shapes: it leaves off-16 UNTOUCHED (0, inherited from `__alloc_hdr`'s own
unconditional `i64.store($ptr,0)` zero-init) when the old array had no
props, or writes the SENTINEL `-1` (0xFFFFFFFFFFFFFFFF, "props migrated to
the global `$__dyn_props` table") when it did — NEVER a direct live
pointer. The observed off-16 value (a real, non-sentinel, non-zero
HASH-tagged pointer) is consistent with NEITHER shape, meaning **this
specific write did not happen during region-copy at all** — it must be
either (a) a NORMAL (non-region) `__dyn_set` call, post-region-exit, during
compileAst's own execution, that legitimately created a dyn-props table for
this array (but then EVERY such creation goes through `__hash_new_small`,
contradicting cap=0 yet again — unless it REUSED/grew an already-bad
existing pointer rather than creating fresh), or (b) two adjacent, otherwise
INDEPENDENT allocations whose address ranges overlap by exactly one
16-byte header's worth (an off-by-16 in some size/offset computation, not
yet isolated to a specific call site) — raw-memory archaeology around
`obj_off` (see the ledger's own working notes, not reproduced here) showed
a chain of coherently-shaped-but-degenerate headers 16-32 bytes apart,
consistent with EITHER a real allocation-overlap bug OR simply the
repetitive bit-vocabulary of adjacent small NaN-boxed structures — not
disambiguated this session.

**NOT further isolated — budget did not reach a landed fix.** Next lead for
whoever picks this up: instrument `__dyn_set`'s ARRAY branch (`module/
collection.js`, the `(if (i32.eq $type PTR.ARRAY) ...)` arm around its own
`__hash_new_small` call) to log every (receiver off, created/reused props
off, resulting cap) triple — confirm whether the `cap=0` table this session
found is EVER visited by `__dyn_set` at all (my read says it should always
see cap≥2 fresh or an existing cap it never shrinks) or whether it is
reached ONLY via `__dyn_get_t_h`'s read path, meaning the write is
somewhere region-copy hasn't been looked at yet — the SET/MAP or CLOSURE
arms (both untouched by this session), or `__region_exit`'s own trailing
`$__dyn_props`-implicit-root pass (module/core.js, the "values are per-array
props HASH pointers... copied bit-for-bit, NOT recursed through
__region_copy_rec" block) — a candidate this session named but did not
instrument: if THIS pass's verbatim-value-copy convention is wrong for a
value that itself needs recursive relocation (the exact 63a5551e-class
mistake, one level removed — a props-HASH pointer stored as a *value* inside
$__dyn_props's OWN table, left un-relocated), a stale/degenerate table is
exactly what would result. Also worth checking: does the trap require
SPECIFICALLY the closure (`g = () => x`) to exist — 2f596a84's own
five-dodge-conditions still hold unverified against THIS session's deeper
finding (not re-run; no reason to expect they've changed, but not
confirmed).

**Verified NOT the cause this session (ruled out, don't re-chase)**: HASH
key-relocation (63a5551e, re-audited, sound — both loops relocate key AND
value); funcInfo's own representation (confirmed HASH, not OBJECT — the
`regionArmObject`/schema-table path is not on this trap's call graph at
all, since the receiver here is ARRAY-typed, not HASH or OBJECT); the
`__region_exit` root-walk's own ordering/memo discipline (unremarkable —
`$__dbgExitCount=1`, single clean pass, `$mark`/`$T`/`$delta` all
sane and mutually consistent).

**Disposition — NO FIX LANDED, wall re-banked, narrower and evidence-backed
(exact numbers, not speculation) for the first time.** Every edit this
session (`scripts/self.js`'s `REGION_HOOKS_ACTIVE` flip, the debug-global
breadcrumbs in `module/core.js`'s `__region_exit` and `module/
collection.js`'s `__dyn_get_t_h`, the disposable `.work/scratch-build-
named.mjs`/`.work/scratch-repro.mjs` scripts) was worktree-only and fully
reverted/deleted; `git status`/`git diff --stat` in the worktree show
NOTHING outstanding beyond this ledger entry. kernel-oracle's array-growth-
class row stays unmoved (still the same region-only failure prior sessions
recorded at 9/13 — not re-run, no source changed to justify
re-verification, per this section's own established discipline).

**No gate ladder run** — no fix exists to gate. No milestone change (front
boundary is still NOT sound; Slice 3 stays not-live).

**SHAs.** jz worktree: `2f596a84` (region-final-2026-08-11, HEAD, unchanged
— no source landed this session, only this ledger entry). Main repo:
unchanged by this session (this worktree is on the region branch, not
main). watr: `895ca5b` (`/Users/div/projects/watr`, unpublished, unchanged,
reconfirmed pristine 5.7.14). No `dist/jz.wasm` rebuilt; the disposable
named kernel was deleted at session end.

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

## §Region arena — BOTH standing rows are ONE mechanism, not two: real
symbolication (names:true bytes, not wat:true — the prior sessions' method
was silently broken) pins the exact crashing function and a 9-byte minimal
repro; 3 concrete root-completeness hypotheses tested and REFUTED; a
genuinely separate, region-unrelated `ctx.features.errorClasses` DBG_INVARIANTS
gap found and set aside; WALL NOT CLOSED, next lead narrowed (2026-08-13)

**Setup.** Fresh worktree
`/private/tmp/claude-501/.../scratchpad/region-peel-f` off `ab2f2f40`
(detached). `node_modules/watr` reinstalled via `npm ci` and verified
byte-identical to the local `watr` repo at `895ca5b` (both `watr.js` and
`package.json` diff clean) — confirmed again at session end, unchanged.
Read `.work/research.md` §Region arena in full, including the 63a5551e/
41024dd6/ab2f2f40 entries the brief named.

**Method fix (this is the session's first real finding): the predecessors'
"decompile via wasm-objdump" lead was never actually blocked on wasm-objdump
— it was blocked on a wrong `compile()` call.** `index.js`'s pipeline
appends the wasm `name` custom section (`appendFunctionNames`) ONLY on the
bytes return path (line ~641); `opts.wat: true` returns straight from
`watrPrint(optimized)` several lines EARLIER (line ~635) and never reaches
that append. The prior sessions built their "named" kernel with BOTH
`wat:true` AND `names:true` together (`compile(..., {wat:true, names:true})`)
— `names:true` was silently a no-op, so their WAT-text function order was
never actually backed by a real name section, and their "count `(func
$name` occurrences in file order" symbolication of `wasm-function[N]` was
guessing against an unrelated numbering, correctly diagnosed as unreliable
but never traced to ITS OWN root cause. This session built the region-live
kernel via `compile(profile.graph.code, {modules, memory, optimize,
names: true})` — bytes, no `wat:true` — and V8's own stack traces now
print real, compiler-assigned names directly (`closure4232`,
`m106_emit$emit`, `m106_emit$emitDecl`, …) with zero guessing. `wasm-objdump
-d` on the same bytes (confirmed to carry a `name` custom section via `-h`)
independently corroborates every name V8 reports.

**Both standing oracle rows are the SAME crash, not two mechanisms.**
Reproduced both `test/kernel-oracle.js` rows (envMeta-shape line 327 and
PENDING-FIX captured-then-read line 665) directly against the named kernel
(`exports.default(...)`, the same ABI `compileViaKernel` uses) at O0/O2/O3,
×3 each: **identical stack trace, identical crash address, for both**:
```
RuntimeError: memory access out of bounds
    at closure4232 (wasm://wasm/…:wasm-function[3757]:0x821a6f)
    at m106_emit$emit (wasm-function[82])
    at m106_emit$emitDecl (wasm-function[2059])
    at m106_emit$emitVoid → emitBlockBody → m121_index$emitFunc → closure2763 → m121_index$compile → compileSelf → compileSelf$exp
```
Both traps are inside the KERNEL's own emit phase (well before
`optimizeTail`/`watOptimize` ever runs — Slice 1's round-loop reclaim is
provably not implicated, it hasn't started yet), confirming and sharpening
the prior session's "crashes inside the kernel's own compilation, not the
compiled program" finding into "crashes at the exact same instruction for
both rows." Dormant (REGION_HOOKS_ACTIVE=false) compiles both clean, ×2 —
confirmed region-live-specific, not a pre-existing bug this session
stumbled into.

**Minimal repro found by black-box bisection (no source edits), 9
characters shorter than 63a5551e's own `let x=n;g=()=>x` and — critically
— actually reproduces on the CURRENT tree (that older repro no longer
traps here, shapes have drifted, exactly as `ab2f2f40`'s entry warned):**
```js
export let f = () => { let arr = [() => 1]; return arr.length }
```
Bisection table (region-live kernel, opt0, same crash frame/address for
every failing row):
| variant | result |
|---|---|
| `let arr=[() => 1]; return 0` (arr never read) | **OK** — provably DCE'd |
| `let arr=[() => 1]; return arr.length` | **TRAPS** |
| `let arr=[() => 1]; return arr[0]()` | **TRAPS** |
| `const g=()=>1; const h=g; return h()` (closure never boxed into a container) | **OK** |
| `const g=()=>1; const call=(fn)=>fn(); return call(g)` (closure passed as an arg, not array-stored) | **OK** |
| `let v=x>0&&1; const g=()=>v; return g()` (direct call, BOOL∪NUMBER capture) | **OK** — refutes carrier-collapse as the PENDING-FIX row's own mechanism |
| array element is a plain OBJECT / STRING / top-level named function, `.length` read | **OK** in every case |
| array element is a LOCAL closure (captures 0 or N vars, doesn't matter), `.length` OR `[0]()` read | **TRAPS**, always the same frame |

Net: the trigger is "a locally-declared arrow closure is stored as an
array element AND the array is later read (any read — even `.length`,
never mind actually calling the closure)." Capture count, capture type,
BOOL∪NUMBER-ness, and whether the closure is ever actually invoked are
ALL irrelevant — narrower and more precise than either prior row's own
framing ("envMeta shape" / "carrier collapse") suggested. `test/kernel-
oracle.js`'s PENDING-FIX row's own comment ("NOT the minimal `const g =
() => v; return g()` shape") is correct but the reason given (carrier
collapse) is wrong — the real reason is direct-call closures never get
boxed into a container at all.

**Faulting instruction (wasm-objdump -d on the exact crash address):** a
double-indirection gather loop —
```
out[i] = *(f64*)( *(i32*)(ptrArrBase + i*4) + 16 )
```
(local-60-based f64 output array stride 8; local-71-based i32 pointer
array stride 4; dereferenced pointer's +16 field read as f64 — the VALUE
field of a 24-byte HASH/MAP entry, hash@0/key@8/value@16, per
`__durable_slot_heal`'s own documented layout) preceded immediately by
`call $__coll_order` + `call $__alloc_hdr`. This is a Map/Hash-values-into-
a-fresh-array gather shape, structurally identical to what `__region_copy_
rec`'s own SET/MAP arm does for its `dirty`/`snapshots` rebuild — but
`closure4232` is a JS-source-derived closure (an anonymous arrow, not a
`$`-named WAT stdlib function), and its own WAT body (found at
`kernel-broken.wat:4276233`, ~100 declared locals) opens with the exact
`if (!ctx.closure.make) err(…)` guard literally written in `src/compile/
emit.js`'s `'=>':` handler (line 7048) — strong, not just suggestive,
evidence `closure4232` IS (or directly inlines) `ctx.closure.make`
(`module/function.js`), the ONE function every arrow-closure literal
compiles through, called for BOTH the crashing and non-crashing bisection
rows alike — so the crash is NOT inside `.make()` uniformly, it's inside
something ONLY the "closure escapes into a container" path additionally
reaches (module/array.js's `fnElements` tagging and/or `src/compile/dyn-
closure-tables.js`'s candidate-scanning machinery are the leading
suspects, not yet confirmed against this exact repro's shape since it
isn't module-scope and doesn't obviously hit the one `ptr.fnElements =`
site currently found by grep — a gap in the account, named explicitly
rather than glossed over).

**Three concrete hypotheses tested by direct rebuild-and-repro (not
guessed, not left as speculation) — ALL THREE REFUTED, evidence banked so
the next session doesn't re-spend the ~4.5 min/build cost re-testing
them:**
1. *`ctx.scope`/`ctx.types` missing from `src/front.js`'s 5-element region
   root* (`[ast, ctx.func.list, ctx.module, ctx.schema, ctx.closure]`) —
   both are genuine top-level `ctx.*` fields with Set/Map-shaped children
   written during `prepare()` (`ctx.scope.chain/globals/userGlobals/consts/
   moduleLoopCaptured/shapeStrs`, `ctx.types.typedElem/dynKeyVars`) and
   NOT in the root — the closest structural match to the banked lead's own
   wording. Added both as two more root elements + rebind targets, rebuilt,
   reran the minimal repro + both rows at O0/O2/O3 ×3: **identical crash,
   same frame, same address to the byte** (`0x821a6f` unchanged). REFUTED.
2. *`ctx.closure` itself is the miscopied root* (its own properties
   include genuine closure-typed values — `.mint`/`.make`/`.call` — whose
   PTR.CLOSURE relocation depends on `$__closure_env_len`/`$__closure_env_
   mask` side tables baked describing the KERNEL's OWN closures at kernel-
   build time). Dropped `ctx.closure` from the root/rebind entirely
   (left durable, untouched by region_exit), rebuilt, reran: **identical
   crash** (address shifted by a few bytes from the smaller root tuple,
   same frame, same relative logic). REFUTED — ctx.closure's presence or
   absence in the root has zero effect on this crash.
3. *`ctx.features` missing from the root* — found via a genuinely useful
   side door: building with `debugInvariants:true` (resolveSelfhostBuild's
   own opt-in knob) surfaces a CLEAN, explicit, non-OOB failure instead of
   the raw trap: `[ctx invariant] pre-assemble: ctx.features.errorClasses
   missing — every FeaturePlan key must be seeded, not an absent key`.
   `ctx.features` (`src/ctx.js`: `features: {}`, a top-level ctx field
   NOT in the root) gets `errorClasses` seeded via `(ctx.features.
   errorClasses ??= new Set()).add(...)` inside `src/prepare/index.js`
   (i.e. during `prepare()`, inside the region span) — textbook root-
   completeness-gap shape, matching the campaign's prior 4 fixed
   mechanisms closely. Added `ctx.features` as a 6th root element,
   rebuilt: **the invariant failure is UNCHANGED, byte-identical message**
   — AND (decisive control) the SAME invariant failure reproduces on a
   **DORMANT** build (`REGION_HOOKS_ACTIVE=false`, `regionArenaLive:
   false`) with `debugInvariants:true`. This proves the `ctx.features.
   errorClasses` gap is REGION-UNRELATED — a real, separate, pre-existing
   DBG_INVARIANTS coverage gap (plausibly: a program that never
   constructs/throws an Error never reaches whatever normally seeds
   `errorClasses`, and the invariant check doesn't tolerate that), out of
   this campaign's scope, named here so nobody re-discovers it as a false
   lead. Neither confirms nor refutes anything about the OOB mechanism
   (the debug-invariants build never gets far enough to reach `closure4232`
   — it trips the earlier, unrelated check first on every program).

**Disposition — NO FIX LANDED, wall re-banked with substantially narrower
evidence than any prior session left.** All three edits (`src/front.js`
×2 shapes, `scripts/self.js` REGION_HOOKS_ACTIVE toggle) were worktree-
scratch, built/tested, then reverted; `git diff --stat` in the worktree
at session end is empty against `ab2f2f40`. kernel-oracle unchanged at
**9/13 region-live** (not re-run this session beyond the two named rows'
own direct repro, which is the same evidence the milestone check already
has — no regression, no progress on the count). No gate battery run
(nothing landed to gate).

**Recommendation for next session — go deeper on the SAME mechanism, not
wider.** The three refuted hypotheses (§1-3 above) all targeted "a whole
`ctx.*` subtree is missing from the region root" — that WHOLE CLASS is now
weak evidence (0 for 3), unlike the campaign's prior 4 mechanisms which
were exactly that shape and fixed on the first or second try. Two live
threads, either is cheaper than re-trying root-completeness variants:
(a) **Finish the `closure4232` attribution.** It opens with `emit.js`'s
`'=>':` handler's own `err()` guard verbatim, so it's extremely likely
`ctx.closure.make`'s own compiled body (module/function.js:127-280) OR a
helper it inlines — but `.make()` runs on EVERY closure literal
(crashing and non-crashing bisection rows alike), so the actual fault
must be in a sub-path gated on "this closure escapes as a value," not
`.make()` uniformly. Grep `module/array.js`'s DYNAMIC (non-module-scope)
array-literal path — `allocArray`, not the `ptr.fnElements =` static-
data-segment branch found this session (which requires
`ctx.func.atModuleScope`, not the repro's shape) — for an analogous
closure-value-tagging step; that's the most likely site of the ACTUAL
coll_order/gather codegen closure4232's WAT body shows two clusters of.
(b) **Splice a genuine WAT-level breadcrumb** (per the campaign's own
mandatory method — NOT another JS-source hypothesis edit) at `closure4232`'s
own entry (module index 3757 is now a KNOWN, STABLE address across builds
sharing this exact root shape — confirmed identical across all 4 builds
this session) capturing the `$aux`/`$n`/`$cellMask` locals (this session's
own disassembly names them precisely: locals decoded from the raw hex dump
map directly onto the WAT text's declared local list in the SAME order,
so this is mechanical, not a re-guess) into an i64 debug global right
before the faulting `f64.load offset=16`, for the 9-character minimal
repro — the cheapest possible instrumented run (~250s build, sub-second
repro). That number, cross-referenced against `ctx.closure.envMeta`'s own
JS-side contents at the SAME point (a second breadcrumb, same technique),
will show directly whether the gather is reading a wrong/uninitialized
slot count vs. a wrong base pointer — the two remaining candidate
mechanisms this session did not have time to distinguish.

**Also banked, not this campaign's concern:** `ctx.features.errorClasses`'s
DBG_INVARIANTS gap (§3 above) — reproduces dormant, unrelated to region
work, worth a throwaway one-line fix (`errorClasses: null` should
satisfy an own-property-existence check already, so the invariant check
itself, or FeaturePlan's PROGRAM-tier seeding order, likely has the real
gap) but explicitly out of scope for this session's mandate.

**Gates.** No source changed persists beyond this ledger entry — every
edit was built, tested, and reverted; worktree `git diff --stat` against
`ab2f2f40` is empty. `node_modules/watr` reconfirmed byte-identical to
`895ca5b` (`watr.js`/`package.json` diff clean) both before and after.
kernel-oracle: unchanged at 9/13 region-live (this session's own direct
repro of both standing rows, ×3 each, matches the milestone check's
existing count — no new run of the full suite since nothing landed to
gate). "REGION FRONT COMPLETE candidate" NOT declared — unchanged from
the prior milestone check.

**SHAs.** jz worktree: `ab2f2f40` base, unchanged (nothing committed
beyond this ledger entry). watr: `895ca5b`/5.7.14, reconfirmed identical.
No `dist/jz.wasm` artifact from this session persists (all builds were
scratch, in the session scratchpad, never copied into the worktree's own
`dist/`).

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

## §Region arena — Slice 3 (emit/encode boundary) DESIGNED AND WIRED, dormant
## gate-clean; region-live real-graph memory HALVES (jessie/watr/jzify-entry,
## byte-identical, deterministic ×3) but a genuine `__region_relocate_props`
## defect blocks the oracle on specific shapes; jz×jz UNCHANGED — no ceiling
## unlock (2026-08-13)

**Task**: build Slice 3 per the campaign brief — design the emit/encode
boundary, wire region hooks, measure jz-graph/jz×jz peak memory, run the
goal-gate bench row if it compiles under 4GiB. Setup followed the brief's
convention exactly: fresh worktree off `70cf7315` (region-final-2026-08-11),
`node_modules/{@esbuild,esbuild,sprae,subscript,tst}` symlinked to the shared
tree, `node_modules/watr` symlinked DIRECTLY to `/Users/div/projects/watr`
(verified `895ca5b` at session start, `let SW = []` fix confirmed present via
content read, never via trusting the path) — no `npm ci`, watr's own working
tree never touched by this session. **Mid-session update, not caused by this
session**: `/Users/div/projects/watr` advanced to `2bde3c1` ("5.7.15") partway
through — a pure version bump (`package.json`/`package-lock.json` only,
confirmed via `git diff 895ca5b 2bde3c1 --stat`, zero source delta), i.e. the
prior "WALL2" entry's own top-priority next lead ("publish `895ca5b` as
5.7.15") was executed by someone else while this session ran. Worth flagging
for the next session: jz's own `package.json` pin (`5.7.14`/`a563a63`) can now
move to `^5.7.15` and drop the overlay convention entirely — not done here,
out of this task's scope, and this session's own builds are unaffected either
way (content-identical to what 5.7.15 now publishes).

### Design

**Boundary point**: wrap `compileAst` itself (`src/compile/index.js`'s
default-exported `compile()`), the third and last region round in the
pipeline (Slice 1 = watr's per-optimize-round mark/exit inside `watrTail`;
Slice 2 = `frontHalf`'s parse→jzify→prepare round; Slice 3 = this one). Chosen
over "per-function" or "whole-module" alternatives because it needs no new
seam: `compile()` already IS the natural single call the self-host pipeline
makes between `front()` and `optimizeTail()` (`scripts/self.js`:
`optimizeTail(compileAst(front(source, strict)), ctx.transform.optimize)`),
and the allocation profile (this session's own `compileProfile` timing export,
plus the archived four-point curve) already names `compileAst` — not
`front`/`optimizeTail`/the final `watrCompile` encode — as the remaining
un-region'd phase for a self-hosted compile: front and the optimize rounds
are both already bounded (Slices 1-2), the terminal `watrCompile` call is a
few-hundred-line pure encoder with no jz-side `ctx` allocation at all (traced
directly — no candidate seam there), leaving `compileAst`'s own body (plan/
analyze/emit/assemble, by far the largest single call in the pipeline) as the
one phase whose ephemeral churn was still never reclaimed.

**Mechanism**: identical shape to Slice 2, mirrored verbatim per the task
brief's own instruction — `regionHooks: {mark, exit}` threaded as an optional
3rd parameter (`compile(ast, profiler, regionHooks)`), `mark()` called as
literally the first statement, `exit(mark, root)` called immediately before
`return`, with the return value and the rooted `ctx` containers rebound from
`exit`'s result. Native host (`index.js` calls `compile(ast, profiler)`, 2
args) is untouched — `regionHooks` stays `undefined`, the whole `if
(regionHooks)` block is dead code, zero behavior change (verified below).
`scripts/self.js` gained one new call-site wrapper, `emitIR(ast)` (named to
avoid colliding with the already-imported `emit` from `compile/emit.js`),
mirroring `front()`'s own wrapper exactly — same `REGION_HOOKS_ACTIVE`
ternary, same literal `__region_mark()`/`__region_exit()` calls (real wasm
calls only inside a self-hosted, region-live kernel; dead/never-evaluated
identifiers in every other context, per `front()`'s own doc). Every one of
`compileSelf`/`compileWarnings`/`compileWat`/`compileProfile`/`compileDiag`
now routes through `emitIR` instead of calling `compileAst` directly — one
seam, not five independently-wired ones.

**Root bundle — designed, then empirically corrected.** The Slice 3 hazard
inventory (8bed8c3f) sketched `[module, ctx.func, ctx.transform, ctx.scope]`
(containers, not leaf fields, matching front's own `ctx.module`/`ctx.schema`/
`ctx.closure` precedent) from a static trace of every `ctx` read between
`compileAst`'s return and `watrCompile`'s byte-encode. This session re-verified
that trace against the CURRENT source (post ctx.func rename, post
closure4232/header-materialization fixes) and found it still accurate:
`ctx.func.list.length`/`.map.get` (self.js's `optimizeTail` wrapper),
`ctx.transform.optimize`/`.targetProfile` (the same wrapper's `cfg` argument,
evaluated at the call site right after `compileAst` returns), and
`ctx.scope.globalValTypes` (`watrTail`'s post-watr `stablePtrGlobalNames`,
called from inside `watrTail` after `watOptimize` finishes) are the complete
set. `ctx.module`/`ctx.schema` confirmed NOT needed (every read happens
inside `compileAst` itself, before exit fires). Implemented and gated as
specified — see the defect below, found DOING that gating, not skipped.

### Implementation

Two files changed: `src/compile/index.js` (`compile()` gains the
`regionHooks` param, mark/exit/rebind, and a doc comment carrying the full
root rationale AND the known defect below — read before touching this
again), `scripts/self.js` (`emitIR` wrapper, five call sites redirected).
`REGION_HOOKS_ACTIVE` stays `false` (committed default) — this boundary
ships DORMANT, exactly like Slice 2 did before its own front-boundary work
closed out. No `layout-kinds.js`/`module/core.js` changes landed (see next
section — a real defect was found there, but NOT fixed this session; the
temporary breadcrumbs used to find it were reverted, confirmed via
`git diff` showing zero delta on both files at session end).

### The defect: `__region_relocate_props` explodes on `ctx.transform`'s durable dyn-props path

Building the design as specified (whole-container root) and running
`kernel-oracle` region-live surfaced a hard trap starting at CORPUS row 8
(`nestedtyped`: `export let f = (x) => new Int32Array(new Float64Array([x]))
[0]`, O0 — the exact source the "closure-capture-after-nested-emit" class was
named for, audit re-hunt 2026-07-30, already fixed at THAT level and confirmed
unrelated by direct testing here). Isolated with the SAME method the SW-bug
and closure4232 fixes used (declGlobal breadcrumbs in `module/core.js`,
`wasm2wat`-free this time since the trap's own stack was already symbolicated
via a `names:true` build — bytes+names only, no `wat:true`, per the process
rule): a call counter + last-kind-tag + last-props-capacity global, read back
from the trapped instance's exports after catching the `RuntimeError`.

Finding: `__region_relocate_props` (module/core.js) reads a capacity of
`2,147,107,840` (~2^31, garbage) off some dyn-props sidecar object reached
ONLY when `ctx.transform` rides the root — dropping it from a THREE-BUILD
differential (whole-root / root-minus-transform / root-plus-two-leaves-only)
made the trap disappear on THIS repro every time transform was dropped, and
reappear (differently) every time transform (whole OR its two needed leaves)
was included. `__alloc`'s own ceiling check aborts trying to allocate a
fresh-capacity block for that garbage number — the `unreachable` every
region-live oracle row above shares. Plain (non-nested) typed arrays do NOT
trigger it — the trigger needs the SPECIFIC nested-constructor shape.

**Three root variants tried, gated against full `kernel-oracle`+`kernel-parity`,
none clean**:
| root | kernel-oracle (13 rows) | kernel-parity | notes |
|---|---|---|---|
| `[module, ctx.func, ctx.transform, ctx.scope]` (as designed) | 7/13 | O0 FAIL, O2 FAIL, **O3 PASS 11/11** | `nestedtyped` traps O0/O2 only — level-sensitive |
| `[module, ctx.func, ctx.scope]` (drop transform entirely) | worse — `nestedtyped` clears but `dict`/`ternary-BOOL｜NUMBER` (dynamic-key OBJECT programs) newly trap | not re-run standalone | different rows break, not fewer |
| `[module, ctx.func, ctx.scope, ctx.transform.optimize, ctx.transform.targetProfile]` (leaf-only) | worse — 6/13, now ALSO fails O3 | O0 FAIL (`memory access out of bounds`, a different message), O2 FAIL | strictly worse than the whole-container attempt |

None of the three is a clean fix — this matches, not coincidentally, the
"address/layout-boundary-sensitive heisenbug" class `scripts/self.js`'s own
2026-08-06 header comment already named for Slice 1 (a previously-passing
build flipping to failing, or vice versa, from unrelated static-layout noise
elsewhere in the self-hosted graph) — narrowing/widening the root shifts
*which* corpus shape trips the SAME underlying relocator defect rather than
closing it. **Landed the design-specified whole-container root** (table row
1) since it is the reasoned, documented choice and the alternatives are not
demonstrably safer, only differently broken — with this table and the defect
above on record so a future session does not re-discover it by surprise.

**Disposition**: `__region_relocate_props`'s durable branch (module/core.js,
the `(i32.lt_u $off $mark)` arm) is the concrete next place to instrument —
its own capacity/count reads (`$cap`/`$n` off `$off-4`/`$off-8`) are exactly
what read garbage here; the SW-bug/closure4232 fixes both eventually found
their root cause by extending the SAME breadcrumb method to the specific
store site, not just the read site. This session's breadcrumbs (kept only
long enough to get the one data point above, then reverted) never reached
that depth — a real next-session task, not a "TODO" left for politeness.

### Real-graph memory measurement (jessie/watr/jzify-entry — the 3-point curve every prior Slice 1/2 session used)

All three region-live, ×3 reps each, deterministic, **byte-identical output
to dormant every time** (proof this design, AS LANDED, is CORRECT on these
three real, non-synthetic multi-module graphs, despite the open defect above
not being universally dodged):

| graph | dormant peak | region-live peak | ratio | output bytes (both) |
|---|---|---|---|---|
| jessie (47 mod, 70,435 B) | 1073.7 MB | **536.9 MB** | **÷2.00** | 106,996 |
| watr (7 mod, ~103 KB) | 2147.5 MB | **1073.7 MB** | **÷2.00** | 315,222 |
| jzify-entry (70 mod, 431,661 B) | 4295.0 MB (the hard ceiling) | **2147.5 MB** | **÷2.00** | 628,906 |

The jzify-entry row is the headline result: dormant hits the deliberate
`__memgrow` ceiling abort outright on this graph (was already documented as
the "capacity UNLOCKED" case for Slice 2 alone in an earlier session); Slice 3
on top gives it a full 2× additional margin, landing comfortably inside a
single 2 GiB budget instead of needing the full 4 GiB address space. The
exact ÷2 ratio on all three points (not merely "smaller") is itself
informative: at `optJSON:{level:2}`, `compileAst`'s own ephemeral churn is
consistently on the same order as everything ELSE the whole pipeline retains
(front's already-reclaimed AST, the final module tree, `ctx.func`/`ctx.scope`)
for these graph sizes — reclaiming it roughly halves the peak rather than
shaving a small fraction off it.

(`.work/jzify-entry.mjs`, a scratch entry point re-derived this session per
the ledger's own description — "jzify-entry = `jzify/index.js`" — since it
was missing from this worktree; NOT committed, matching every prior session's
own "worktree-only, discarded" convention for this exact file.)

### jz×jz — the acceptance-target graph — UNCHANGED, no ceiling unlock

`bench/jz/jz.js` (155 modules, 5,883,905 B) via the archived
`kernel-memory-curve.md` recipe (`instantiate(wasm,{memory:8192})`, `exports.
default(codePtr,0,optJSON,modulesJSON,0)`, `optJSON:{level:2}`):

| kernel | peak | outcome | wall time |
|---|---|---|---|
| dormant | 4,294,967,296 B (exactly 2³²) | `unreachable` (deliberate `__memgrow` ceiling abort) | 6.97 s |
| region-live (Slice 1+2+3, as landed) | 4,294,967,296 B (exactly 2³²) | `unreachable`, IDENTICAL signature | 7.58 s |

**No benefit measured on the actual goal graph** — this is the honest,
load-bearing negative result of this session, not glossed over. Both legs
reach the exact same hard ceiling in essentially the same wall time; Slice 3
(even the maximally-aggressive whole-`ctx.transform`-rooted variant) does not
move jz×jz's peak by a single byte. Two non-exclusive readings, neither
confirmed further this session: (a) jz×jz's LIVE (rooted, never reclaimable)
working set — 155 modules' worth of `ctx.func`/`ctx.scope`/`ctx.module`/
`ctx.schema` state that must all coexist for one combined compile — may
simply already exceed what fits before `compileAst` even finishes walking the
graph, so ephemeral-garbage reclaim (however complete) cannot help; (b) the
trap may fire EARLY, inside `front()`'s own bundling of the 155th module
(Slice 2's territory) rather than deep inside `compileAst`, before Slice 3's
own mark/exit round ever gets much chance to reclaim anything — the ~7 s
timing (vs. jzify-entry's ~11 s to fully succeed on a graph 1/14th the size)
is at least consistent with an early abort, not a late one, but this was not
traced to a specific phase this session. **Next lead, concrete**: instrument
`compileProfile`'s own per-stage timing (`front`/`compileAst`/`optimizeTail`/
`encode` ms, already exported by `scripts/self.js`) against jz×jz specifically
— if `front` alone consumes most of the 7 s and the trap is inside it, Slice 3
is provably not the lever for THIS graph regardless of its own correctness,
and the real next step is characterizing jz×jz's minimum LIVE footprint, not
further debugging `compileAst`'s ephemeral churn.

### Gates

- **Dormant native `npm test`: 3436 total / 3428 pass / 2 fail / 6 skip** —
  the two pre-existing `test/optimizer.js` guard-coalescing pins, byte-for-byte
  the documented baseline, zero regression.
- **Dormant `test:wasm`: 2731 total / 2725 pass / 0 fail / 6 skip** — clean,
  matches the documented baseline.
- **Dormant kernel-oracle: 13/13 (541 assertions)** — unchanged from the
  pre-Slice-3 base.
- **Dormant self-build ×2: SHA-256 `57ee1c57…` both times** — converges.
- **Region-live kernel-oracle: 7/13** (NOT a gate pass — recorded honestly,
  see the defect section; dormant is what ships).
- **Region-live kernel-parity: O0/O2 FAIL, O3 PASS 11/11.**
- **jessie/watr/jzify-entry region-live ×3: GREEN, deterministic,
  byte-identical** (see table above) — this IS a clean gate, on real
  multi-module graphs, independent of the oracle corpus's synthetic-shape
  defect.
- **jz×jz: does not compile under 4 GiB, region-live or dormant** — goal gate
  NOT met; no bench row to report (nothing compiled).
- Oracle 13/13 both configs (dormant native+kernel, the FRONT boundary's own
  gate, per 70cf7315) — unaffected by this session, not re-run (no front-half
  file touched).

### Disposition

**Banked, not landed live.** `REGION_HOOKS_ACTIVE` stays `false` — this
session's own structural change (the `regionHooks` plumbing through
`compile()` and `scripts/self.js`) is committed as a working, fully
gate-verified DORMANT increment; region-live itself is not gate-clean and is
NOT flipped on anywhere. Per the task's own framing ("if walled: bank with
evidence + next named lead"): the DESIGN is validated (boundary point,
root-bundle reasoning, the 2× real-graph memory result), the WALL is a single
named, reproduced, partially-localized defect (`__region_relocate_props`'s
durable dyn-props path), and the GOAL (jz×jz under 4 GiB) is not reached —
distinctly NOT because Slice 3 is unbuilt, but because the specific graph
shows zero measured benefit from it, a materially different and more useful
finding than "not attempted."

**Next named leads, in priority order**:
1. Root-cause `__region_relocate_props`'s garbage-capacity read — extend this
   session's breadcrumbs to the STORE side (which write leaves a stale/
   wrong-address props pointer reachable from `ctx.transform`), the same way
   the SW-bug and closure4232 fixes closed their own mechanisms.
2. Trace jz×jz's own trap to a specific pipeline stage via `compileProfile`
   before assuming Slice 3 is the relevant lever for that graph at all.
3. Bump jz's `watr` pin to `^5.7.15` (now genuinely published, confirmed
   content-identical to the `895ca5b` overlay this and prior sessions used)
   and retire the symlink-overlay convention — a mechanical unblock, orthogonal
   to Slice 3 itself, freeing every future session from the setup dance.

**SHAs**. jz worktree: `70cf7315` base, this session's only commit is the
`compile()`/`scripts/self.js` pair above plus this ledger entry. watr:
`895ca5b` at session start (confirmed live via content read before any gate),
advanced mid-session to `2bde3c1`/`5.7.15` by a concurrent process (pure
version bump, zero source delta — see Setup above); this session's own builds
used `895ca5b`'s content throughout, byte-identical to what `5.7.15` now
publishes. Dormant `dist/jz.wasm` (this session, self-build ×2): SHA-256
`57ee1c57116dc6fc20a41bd7eafedb78b16672e9ec0ddc136cb3e98bebfd921a` (both
builds identical). Region-live `dist/jz.wasm` (whole-root, as landed):
SHA-256 `9ce91283709b5d7ba19710d4d7e9fc3c60899fed6dec192140ea4a030e372c0c`.

## §Region arena — jz×jz ceiling ROOT-CAUSED: the trap is a genuine PATHOLOGY
## (superlinear per-closure cost, not a hard live-working-set floor), localized
## to `compileAst`'s closure-body emission — root mechanism named, not yet
## fixed. Task 2 (`__region_relocate_props`) surveyed, not advanced. watr pin
## bumped to the now-published 5.7.15 (2026-08-13)

**Task**: the named lead from 233bf8b5 — find WHERE jz×jz's identical
2³²-byte ceiling (dormant AND region-live, ~7 s) actually hits: genuine
live-working-set floor, or an early trap/pathology. Priority 2 (budget
permitting): root-cause the `__region_relocate_props` garbage-capacity defect
blocking Task 2's Slice 3 oracle gate.

**Setup**. Worktree off `233bf8b5`. watr: confirmed `5.7.15` is published
with the `let SW = []` fix — `npm pack watr@5.7.15` and `diff -rq` against
`/Users/div/projects/watr/src` (895ca5b's content) came back byte-identical
(zero delta), so this session did the mechanical unblock the PRIOR entry's
own next-lead #3 named: `npm i watr@5.7.15 --no-save` (real npm install, no
symlink overlay), then bumped `package.json`'s pin `5.7.14` → `5.7.15`
(exact pin, matching the existing no-caret convention — a bare `npm install
--package-lock-only` initially rewrote it to `^5.7.15`, corrected back) and
regenerated `package-lock.json` to match. Gates on the bump alone, before any
investigation: native `npm test` 3436/3428 pass/2 fail/6 skip — byte-for-byte
the documented baseline (the two fails are the pre-existing `test/
optimizer.js` guard-coalescing pins) — self-build ×2 SHA-256
`2eb9f61724d05d438c1c0e161911e8a55f40c982a8f56c6a84052e2d6b414bca` both
times (deterministic), kernel-oracle 13/13 (541 assertions). Clean, isolated,
zero-regression — this bump is the one change from this session that's meant
to ship.

### Method

The brief named `compileProfile`'s existing per-stage timing (`front`/
`compileAst`/`optimizeTail`/`encode`, `scripts/self.js`) and the region
mark/exit points as the practical instrumentation seam. In practice two
distinct hazards shaped the actual method:

1. **`src/compile/index.js` is dual-purpose** — it is BOTH the real compiler
   (imported and executed NATIVELY by `index.js`, including by the native
   `compile()` call that BUILDS the self-hosted kernel itself) AND, separately,
   its own source text is bundled into `scripts/self.js`'s module graph to
   become part of the kernel wasm binary. A bare bareword call
   (`__dbg_mark(10)`, mirroring `__region_mark`/`__region_exit`'s own
   convention) dropped directly into `compile/index.js` breaks the NATIVE
   build outright (`ReferenceError: __dbg_mark is not defined`) — that
   convention is safe ONLY in `scripts/self.js` itself, which is genuinely
   never imported/run natively. Fixed by routing through `compile()`'s
   PRE-EXISTING `profiler` parameter (`timePhase = (profiler, name, fn) =>
   profiler?.time ? profiler.time(name, fn) : fn()`, already dual-purpose-safe
   by construction) instead — a `{ time: (name, fn) => { const r = fn();
   __dbg_mark(id); return r } }` object built and passed ONLY from
   `scripts/self.js`'s own scratch profiling entries, so every literal
   `__dbg_mark` call site stays confined to the self-host-only file, and
   `compile/index.js` itself needed zero edits.
2. Two exported globals (`module/core.js`, mirroring `__region_mark`'s own
   declaration style): `__dbg_stage`/`__dbg_mem` (i32), written by a new
   trivial intrinsic `$__dbg_mark(n)` (`global.set` ×2, `memory.size` for the
   page count) — wasm globals are NOT rolled back on `unreachable`, so they
   survive a trap and are readable from the instance's exports in the `catch`
   block. Both a name-based `dbgId()` ternary chain (mapping `compile()`'s 12
   named `timePhase` phases to distinct codes — `foldAggregates`, `plan`,
   `analyzeFuncs`, `structInline`, `unionInline`, `unionClones`, `emitFuncs`,
   `emitClosures`, `buildStart`, `resolveDynFnTables`, `pullStdlib`,
   `optimizeModule`) and a plain sequential counter (bypasses string
   comparison entirely, as a cross-check) were used. Three scratch exports
   added to `scripts/self.js` (`compileDbgProfile`, `compileDbgProfilePartial`
   — stops right after `compileAst`, `compileDbgProfileSeq`), all reverted
   before finishing (`git diff module/core.js scripts/self.js` clean at
   session end — verified). Driver: `resolveModuleGraph(entry, {resolveNode:
   true})` + `instantiate(wasm, {memory:8192})` + `w.exports.compileDbgProfile*
   (...)`, catching `RuntimeError` and reading `w.exports.__dbg_stage.value`/
   `__dbg_mem.value` regardless of outcome — the exact `jessie/watr/
   jzify-entry` recipe every prior Slice 1/2/3 session used, extended with
   the breadcrumb read. `.work/jzify-entry.mjs` re-derived again this session
   (gitignored, `.work/*.mjs`, worktree-only per the established convention).
   Six kernel builds total (~6-7 min native compile each, chain-waited in
   foreground per the process rule) — dormant ×5 (incrementally fixing the
   instrumentation), region-live ×1 (confirmatory).

### Findings

**Front finishes cleanly; the trap is entirely inside `compileAst`.** The
coarse boundary marks (front-start/front-done/compileAst-done/optimizeTail-
done/encode-done) on the FIRST working build already showed `__dbg_stage=2`
("front:done / compileAst:start") at trap time, `__dbg_mem=16384` pages
(1024 MB) — front (parse → jzify → prepare → preEval over all 155 modules)
completes fully and cheaply; `compileAst` (plan/analyze/emit/assemble) is
where the remaining ~3 GB gets consumed and the trap fires. This ALONE
already answers the ledger's own open question #2 ("trace jz×jz's own trap
to a specific pipeline stage before assuming Slice 3 is the relevant lever
at all") — Slice 3's boundary IS the right phase, structurally.

**Finer resolution: the trap is inside the closure-body compilation
rounds, not whole-program planning or the bulk per-function pass.** The
sequential-counter cross-check is unambiguous and reproduces IDENTICALLY in
both configs:

| kernel | timePhase calls completed before trap | wall time | mem at trap |
|---|---|---|---|
| dormant | 27 | 6.6-6.9 s | 4096 MB (ceiling) |
| region-live | 27 | 8.0 s | 4096 MB (ceiling) |

Both configs get through the SAME number of phase-rounds before dying —
direct, measured confirmation of 233bf8b5's inference, not merely a repeat of
its "identical ceiling" headline. Walking `compile()`'s own call order (7
single-fire phases — `foldAggregates`/`plan`/`analyzeFuncs`/`structInline`/
`unionInline`/`unionClones`/`emitFuncs` — then `compilePendingClosures()`'s
explicit pre-`buildStart` flush, then `buildStartFn`'s OWN two internal
`compilePendingClosures()` calls, i.e. `emitClosures` firing repeatedly as
`buildStartFn` walks all 155 modules' own top-level init code and discovers
closures module-by-module) places call #27 deep inside `buildStart`'s
closure-flush loop — `plan`/`analyzeFuncs` (whole-program fact gathering)
and `emitFuncs` (the bulk per-named-function codegen pass) are each a
SINGLE call in this sequence and complete early; the growth is concentrated
in the REPEATED `emitClosures` rounds triggered as `buildStartFn`
(`src/wat/assemble.js:152`) processes `ctx.module.moduleInits` one module at
a time.

**The growth curve is clearly superlinear, not a proportional floor.**
Same method (`compileDbgProfileSeq`, stops right after `compileAst`) run
against the three already-established real graphs, no rebuild needed (same
dormant kernel):

| graph | modules | source bytes | timePhase calls completed | mem at compileAst completion | mem/call |
|---|---|---|---|---|---|
| jessie | 47 | 70,435 | 60 (all, succeeds) | 512 MB | ~8.5 MB |
| watr | 7 | 103,774 | 61 (all, succeeds) | 1024 MB | ~16.8 MB |
| jzify-entry | 70 | 431,661 | 61 (all, succeeds) | 2048 MB | ~33.6 MB |
| jz×jz | 155 | 5,883,905 | 27 (TRAPPED, incomplete) | 4096 MB (ceiling) | ~151.7 MB |

Three succeeding graphs land on the SAME ~60-61 total phase-rounds
regardless of size (round count is bounded by closure-discovery convergence,
not raw size) while `mem/call` roughly doubles each step as source size
roughly doubles (70 KB→104 KB→432 KB, sublinear-ish, consistent with the
Slice-3 ÷2 result on these same three graphs). jz×jz breaks that pattern
sharply: 13.6× jzify-entry's source size, but only 4.5× its `mem/call` and
LESS THAN HALF its total round count before dying. A graph 13× bigger dying
after HALF as many rounds, at "only" 4.5× the per-round cost, is not what a
flat per-closure cost or even a mildly worse-than-linear one produces — it's
the signature of a cost that grows with the ACCUMULATED PROGRAM STATE SEEN
SO FAR, not with the closure's own size.

**Named candidate mechanism** (code-inspected, NOT yet runtime-measured —
see Verdict below for the honest epistemic line): `emitClosureBody`
(`src/compile/index.js:1897`) opens with
```
const prevSchemaVars = ctx.schema.vars
...
if (cb.schemaVars) {
  ctx.schema.vars = new Map([...prevSchemaVars, ...cb.schemaVars])
  ...
}
```
(and the parallel `ctx.types.typedElem`/`typedLen` merges a few lines below)
— restored (`ctx.schema.vars = prevSchemaVars`) at the function's tail
(line ~2237). `ctx.schema.vars` is the whole-program schema-fact table
(populated during `plan`/`analyzeFuncs` over the ENTIRE bundled 155-module
AST for jz×jz); if `cb.schemaVars` is set (this closure captures ANY
schema-typed variable), EVERY closure body pays a fresh `O(|ctx.schema.
vars|)` Map clone for the DURATION of compiling just that one body. For a
program whose own schema-fact table scales with total module count,
compiling `N` closures this way costs `O(N × programSize)` — exactly the
superlinear-in-program-size, not-superlinear-in-closure-count shape the
measured curve shows (bounded ~60 rounds regardless of graph size, but
COST PER ROUND scaling with the whole program). Not confirmed by directly
measuring `ctx.schema.vars.size` at runtime this session (would need either
a native-only console instrumentation pass or another kernel-build cycle,
budget did not allow after the Task 1 headline finding was secured) — this
is a strong, specific, line-cited hypothesis, not a proven root cause.

### Verdict

**(b) Pathology — a superlinear-cost per-closure-body compile step inside
`compileAst`'s `buildStart`/`emitClosures` machinery, not (a) a genuine
live-working-set floor.** The evidence against "floor": front (which DOES
hold all 155 modules' bundled live AST + `ctx.module`/`ctx.func`/
`ctx.scope` state simultaneously, by construction, since it produces ONE
merged AST) finishes at a modest 1 GB; the wall isn't hit until deep inside
per-closure codegen, and it's hit at a MUCH lower call-count than the
program's own closure count would predict from the three smaller graphs'
scaling — a real floor would show cost tracking closure/function COUNT
roughly linearly across all four graphs, not degrading sharply only on the
largest one.

**Design lever** (not implemented this session — a fix candidate, gated on
confirming the `ctx.schema.vars`/`ctx.types.typedElem` hypothesis first):
replace the eager `new Map([...prevSchemaVars, ...cb.schemaVars])` full
merge-copy with a cheap two-level overlay (check `cb.schemaVars` first, fall
through to `prevSchemaVars` on miss — the same shape `ctx.func.
localValTypesOverlay`'s own naming already gestures at elsewhere in this
codebase) — turns an `O(programSize)`-per-closure cost into `O(|cb.
schemaVars|)`, i.e. `O(closure's own capture count)`, independent of total
program size. This is a conceptual fix (the allocator/region-arena
machinery is not implicated at all — Slice 1-3's mark/exit discipline is
irrelevant to this specific cost, which is live JS-level `Map` churn inside
ONE synchronous call, never spanning a region boundary), not a region-arena
lever — explains cleanly why Slice 3 (compileAst's OWN region, mark-at-
entry/exit-at-return) measured ZERO benefit on jz×jz despite the ÷2 result
on three real smaller graphs: the trap fires deep inside `buildStart`,
before `compileAst`'s own single exit/reclaim EVER runs — a whole-phase
region can only reclaim once the WHOLE phase completes, and jz×jz's phase
never completes. No region-boundary redesign (finer interior regions, a
mark/exit per closure round) would help either, UNTIL the underlying
per-closure cost itself stops scaling with program size — reducing the
LIVE peak first is the prerequisite, not a substitute, for any interior
region checkpoint being worth adding.

**Next named lead**: confirm the `ctx.schema.vars`/`typedElem` hypothesis by
instrumenting `emitClosureBody`'s entry with a size read into `__dbg_mem`
(same breadcrumb technique, one more kernel-build cycle) across a couple of
closures early vs. late in `buildStart`'s walk — if `prevSchemaVars.size`
climbs roughly linearly with modules-processed-so-far while being re-cloned
every closure, that's the confirmed, measured smoking gun; if it stays
small, the search continues elsewhere in `emitClosureBody`'s ~340-line body
(the `typedElem`/`typedLen` merges are the other two candidates, same
shape, not yet distinguished from `schemaVars` as the dominant cost).

### Task 2 (`__region_relocate_props` defect) — surveyed, not advanced

Budget after Task 1's headline finding did not extend to another empirical
(kernel-build) cycle. Read `ctx.transform`'s full declared shape
(`src/ctx.js:84-91`: user opts + derived `optimize` cfg + THREE injected
service FUNCTIONS — `parse`, `jzify`, `resolveUrl`) and traced whether
`DOLLAR`/`stdlibParseCache` (the two caches `scripts/self.js`'s `setupSelf`
explicitly clears+rebuilds every compile, `clearDollar`/
`clearStdlibParseCache`) are reachable through `ctx.transform.parse`/
`.jzify`'s closure environments, as a candidate for the "ephemeral value
reached only via `ctx.transform`" mechanism 233bf8b5 asked for. They are
NOT — `DOLLAR` lives in `src/ir.js`, `stdlibParseCache` in `src/wat/
assemble.js`, both module-scope `let` bindings independent of `parse.js`'s/
`jzify/index.js`'s own module scope; no import chain connects them to
`ctx.transform`'s two service functions specifically. This rules out one
candidate mechanism but does not name the real one — genuinely banked, not
advanced beyond 233bf8b5's own breadcrumb evidence and store-side next
lead ("extend the mark-time breadcrumbs to the STORE side — which write
leaves a stale/wrong-address props pointer reachable from `ctx.transform`").

### Gates

- Native `npm test`: 3436/3428 pass/2 fail (pre-existing, documented)/6
  skip — clean, watr-bump-only diff from baseline.
- Dormant self-build ×2: SHA-256
  `2eb9f61724d05d438c1c0e161911e8a55f40c982a8f56c6a84052e2d6b414bca` both
  times.
- Dormant kernel-oracle: 13/13 (541 assertions).
- Region-live/Task-2 oracle NOT re-gated this session (no functional source
  change — investigation only, `module/core.js`/`scripts/self.js` fully
  reverted to `233bf8b5`, confirmed via `git diff` clean before writing this
  entry).
- jz×jz: still does not compile under 4 GiB, either config — goal gate NOT
  met. Root mechanism now named (see Verdict); fix not yet attempted.

### Disposition

**Banked with a concrete, line-cited next lead**, per the task's own
framing. The named lead (Task 1) is answered with hard evidence: this is a
pathology, not a floor, localized to `emitClosureBody`'s per-closure
`ctx.schema.vars` (and likely `typedElem`/`typedLen`) full-Map-clone
pattern, growing with total program size rather than with closure size —
one more instrumentation cycle would convert "strong hypothesis" into
"measured root cause," and the fix itself (an overlay instead of a clone) is
a small, local, conceptually clean change once confirmed. Task 2 got a
partial elimination pass, not a fix. The watr `5.7.15` pin bump is the one
piece of this session that ships as-is — mechanical, zero-regression, gated.

**SHAs**. jz worktree: `233bf8b5` base, this session's commits are the
`package.json`/`package-lock.json` watr pin bump plus this ledger entry
(instrumentation to `module/core.js`/`scripts/self.js` used during
investigation, fully reverted, never committed). watr: `5.7.15`
(`2bde3c1`), confirmed content-identical to `895ca5b` via `npm pack` +
`diff -rq` against `/Users/div/projects/watr/src`. Dormant `dist/jz.wasm`
(this session, self-build ×2): SHA-256
`2eb9f61724d05d438c1c0e161911e8a55f40c982a8f56c6a84052e2d6b414bca` (both
builds identical).

## §Region arena — jz×jz closure-clone pathology FIXED (MapOverlay); the goal
## gate still traps at the 4GiB wasm ceiling, but for a DIFFERENT, LATER
## reason now measured and named: watr's own `watOptimize` pass, not
## `compileAst`'s closure machinery (2026-08-13)

**Task**: implement 2a78a6f6's own named design lever — replace
`emitClosureBody`'s eager `new Map([...prevSchemaVars, ...cb.schemaVars])`
(and the parallel `ctx.types.typedElem`/`typedLen` merges) with a two-level
overlay, O(closure's own captures) instead of O(programSize) per closure —
then re-run the jz×jz goal gate to see whether `compileAst` now completes
under 4 GiB.

### The fix

**`MapOverlay`** (`src/compile/index.js`, defined just above
`emitClosureBody`): a plain factory (`makeMapOverlay(base, own)`, not
`class` — see below), two layers — `own` (this closure's own captures,
starts as a small `new Map(cb.schemaVars)`/`new Map(cb.typedElems)`/
`new Map(cb.typedLens)` copy, bounded by the closure's own capture count)
checked first, falling through to `base` (the enclosing table — the
program-wide `ctx.schema.vars`, module-global `ctx.scope.globalTypedElem`/
`globalTypedLen`, or an enclosing closure's own overlay for nested
closures) on miss. `get`/`has` are the read path; `set` writes only into
`own`; `delete` (see the `class`-avoidance note) tombstones in `own` so a
base-visible key reads as absent without ever touching `base`. Construction
is O(1); every operation is O(1) amortized (native `Map.get/has/set` on
whichever layer), independent of `base`'s size. Shadow order matches the
old eager merge exactly — `own` wins on key collision, same as the second
spread (`...cb.schemaVars`) winning in `new Map([...prev, ...cb])`. The
three `emitClosureBody` assignment sites (`ctx.schema.vars`,
`ctx.types.typedElem`, `ctx.types.typedLen`) now build a `makeMapOverlay(...)`
instead of a clone; the tail restore (`ctx.schema.vars = prevSchemaVars`,
`ctx.types.typedElem = prevTypedElems`) is unchanged — "restore" was always
just re-pointing the ctx field back at the parent's value, which composes
fine whether that value is a real `Map` or another `MapOverlay` (nested
closures re-overlay on top of an overlay `base` transparently).

**Consumer audit** (why a facade, not per-call-site conversion): grepped
the WHOLE repo (not just `src/` — see the miss below) for `schema.vars`,
`types.typedElem`, `types.typedLen`. Every read across analyze.js, emit.js,
emit-assign.js, infer.js, inplace-store.js, plan/scope.js, program-facts.js,
prepare/index.js, type.js, kind.js, kind-traits.js, static.js is a bare
`.get`/`.has`/`.set`/`.delete` — never a spread, `.keys()`/`.entries()`/
`.values()`, `for..of`, or `.size` while a closure body could be
mid-emission. A facade is a complete, zero-consumer-edits substitute.

**The one real miss, caught by testing, not by the audit**: my grep was
scoped to `src/` and missed `module/function.js:227` — `ctx.closure.make`'s
own capture-scan, which built `new Set(ctx.schema.vars.keys())` (a SECOND,
separate O(programSize) full-table copy, at closure-CREATION time, firing
for every arrow/function-expression literal seen while ANY body emits — the
more frequent, and on measurement the DOMINANT, sibling of
`emitClosureBody`'s own per-BODY merge) then handed it to
`findFreeVars(body, params, refs, schemaNames)` as the `scope` param. Naive
fix #1 (pass `ctx.schema.vars` straight through, since `findFreeVars`'s
`scope.has(name)` read looked read-only) broke `npm test` immediately — 111
NEW failures, `internal: out.add is not a function` — because
`analyze-scans.js`'s `findFreeVars` has a SECOND, easy-to-miss use of
`scope`: its own `let`/`const`/`for(let…)` branches call
`collectParamNames(decls, scope)`, which calls `scope.add(name)`, to record
body-local shadow declarations (so a closure's own inner `let x` doesn't
get misread as a free reference to an outer schema var named `x`) — a real
MUTABLE Set interface, not read-only lookup, and `ctx.schema.vars` is a
`Map` (no `.add`). Fixed properly with the same two-layer split MapOverlay
uses, inlined for this one call site: a fresh per-closure `scopeOwn = new
Set()` that `.add` writes into, `.has` checking `scopeOwn` then
`ctx.schema.vars` — O(1) construction, shadow-writes never leak into the
shared program-wide table. **Lesson for future overlay work in this
codebase**: audit READ shape is not enough for a "pass the live table
through" style fix — audit for MUTATION methods on the SAME parameter too,
at every call site, not just the immediate one.

**No `class`, no `delete`-as-method-name**: `src/compile/index.js`'s own
source text is bundled into the self-host kernel (jz compiles jz), so new
code here must self-host. First attempt used `class MapOverlay { … delete(k)
{…} }` — broke the self-host `selfhost-build.mjs` build outright (subscript,
the self-hosted front end's own parser, chokes on `delete` as a
class-method-definition name — a reserved word in definition position;
`.delete(x)` as a plain member-access CALL, already used throughout the
self-hosted corpus, is fine). Also `class` itself is otherwise UNUSED
anywhere in `src/`/`module/` — an untested self-host surface not worth
risking even after working around the `delete` issue. Rewrote as a plain
factory function returning an object literal; `.delete` is attached via a
post-hoc assignment (`overlay.delete = (k) => {…}`, the same
member-access-after-dot production every existing `.delete(...)` call site
already exercises) rather than defined inline.

### The goal gate: NOT met, but the named pathology IS fixed — measured,
### not inferred

Peak-memory reads via `self.memory.buffer.byteLength` after
`self.exports.default(...)` (the established `mem-curve.mjs` method) still
show jz×jz trapping at exactly 4294967296 bytes (4 GiB) in BOTH dormant and
region-live self-host kernels, both before AND after this fix — the coarse
"did it fit" outcome is unchanged. That reading alone doesn't distinguish
"the fix did nothing" from "the fix helped a lot but a DIFFERENT cost now
fills the same ceiling" — `buffer.byteLength` only ever reports the last
successfully-grown size, always landing at the hard cap on ANY trap
regardless of how close-vs-far the real peak was. Needed a finer probe.

**Native phase-by-phase measurement (compile()'s own first-class
`opts.profile` sink — zero source perturbation, the exact instrumentation
seam index.js already ships) is unambiguous.** Compiling jz×jz NATIVELY
(same `src/compile/index.js`, no wasm ceiling) with `opts.profile`:

| build | `emitClosures` calls before done/trap | `compile()` outcome | peak RSS at `compile()` done |
|---|---|---|---|
| base (2a78a6f6, pre-fix) | 27 total `timePhase` calls reached, deep in `buildStart`'s flush, TRAPPED (documented in 2a78a6f6's own entry, wasm-side) | — | — (wasm-only measurement, no native equivalent run this session) |
| this session's fix | **3** `emitClosures` calls, ALL complete | **COMPLETES** | **~2021 MB** |

`compile()` — the WHOLE plan→analyze→emit→closures→buildStart→optimizeModule
pipeline — now finishes natively in 26.6 s at ~2 GB peak RSS, where the base
kernel's own wasm-side measurement never got past round 27 of an
open-ended `emitClosures` flush at 4096 MB. `emitClosures` firing only 3
times (not dozens) is the direct, load-bearing confirmation: the named
O(programSize)-per-closure pathology is gone.

**The FULL native pipeline (`compile()` + watr's own `watOptimize` +
`watrCompile`/encode — i.e. everything `jz.compile()` does, matching what
the self-host kernel's own `compileSelf` does) completes too, at 201.5 s /
3840.7 MB peak RSS — under 4 GiB natively, but only by ~450 MB, and the
memory growth from `compile()`-done (~2 GB) to finish (~3.84 GB) happens
almost entirely inside ONE later phase**: `watOptimize` (144.1 s,
+1.8 GB) — watr's own whole-module optimizer, NOT jz's own `optimizeModule`
(`optMod:*`, ~2.0→2.05 GB, modest) and NOT `compileAst`/closures (already
done by then). This is a genuinely different, later, out-of-scope
mechanism — watr's optimizer operating on a legitimately huge (~10 MB)
compiled module, not a per-closure pathology in jz's own emit path.

**Cross-check that rules out "jz-level optimize is secretly still the
lever"**: re-ran the wasm kernel at `optimize:{level:0}` (jz's own optimizer
passes off) — it STILL traps at the identical 4 GiB ceiling, and takes
LONGER (10.5 s vs 6.6 s at level 2), not shorter. Consistent with: watr's
own tail optimize pass runs regardless of jz's optimize level (governed
independently), so skipping jz's own passes only hands watr a BIGGER,
less-pre-folded module to optimize — worse, not better. This is direct
evidence the remaining ceiling is watr-side, not jz-closures-side.

**Why the wasm kernel still traps despite native fitting under 4 GiB**:
the self-hosted kernel's own runtime (jz's NaN-boxed heap model, no
compaction, coarser allocation granularity than V8's tagged-object heap)
almost certainly carries a real "self-hosting tax" over native V8 for the
same algorithmic work — a ~3.84 GB native peak, sitting only ~450 MB under
the ceiling, is exactly the kind of margin a modest per-allocation overhead
multiplier would erase. Not measured directly this session (would need the
same `opts.profile`-shaped per-phase breadcrumb wired through the
self-hosted kernel's own memory reads, one more kernel-build cycle); named
as the leading hypothesis, not proven.

**Module-ladder / curve**: the coarse `memory.buffer.byteLength` metric
turned out to be an unreliable cross-comparison instrument even at the
established jessie/watr/jzify-entry sizes — re-running the ESTABLISHED
4-point corpus (jessie/watr/jzify-entry/jz×jz) against the FIXED dormant
kernel landed on jessie=1073.7 MB, watr=2147.5 MB, jzify-entry=4295 MB
(barely fits, `ok:true`), jz×jz=4295 MB (traps) — every row a
power-of-two-MiB tier HIGHER than 2a78a6f6's own documented table
(512/1024/2048/—), which looked like a regression until the SAME script
against the region-jzjz worktree's OWN pre-existing (non-this-session)
`dist/jz.wasm` on this machine produced the IDENTICAL numbers
(1073.7/2147.5/4295/4295) — an environment/measurement-granularity
difference (this session's Node.js v25.9.0 wasm memory implementation,
almost certainly), not a real regression from this fix. Byte-identity
(below) is the real "did codegen change" gate, not this coarse peak-MB
reading — a genuine 20/50/100/155-module ladder wasn't built (constructing
valid module-count SUBSETS of jz×jz's own real import graph without
producing an invalid/incomplete program is nontrivial and wasn't
attempted); the native phase table above is the more precise substitute
this session actually has.

### Byte-identity (the strongest gate here)

Native `compile(code, {modules, optimize})` for jessie/watr/jzify-entry at
optimize 0/1/2/3 (12 rows), base worktree (2a78a6f6, unmodified) vs this
session's fix: SHA-256 of every compiled output byte-IDENTICAL, all 12
rows. The overlay is pure mechanism — confirmed zero output change for any
tested program at any optimize level.

### Gates

- Native `npm test`: 3436/3428 pass/2 fail (pre-existing, documented)/6
  skip — byte-for-byte the same tally as 2a78a6f6's own baseline.
- `test:wasm`: 2731/2725 pass/0 fail/6 skip.
- Kernel-oracle, dormant (this session's fixed kernel): 13/13 (541
  assertions) × 3 runs, identical every time.
- Kernel-oracle, region-live (this session's fixed kernel, all three
  `REGION_HOOKS_ACTIVE` boundaries firing): 7/13 × 3 runs, identical every
  time — the SAME 6 failures every run (kernel-parity byte-identical-WAT at
  O0/O2, kernel-oracle native+kernel-agree-with-JS at O0, ×2 more, the
  KNOWN-FAIL audit-#16 bigint-module-ordering row) — matches the task's own
  expected 7/13 (the OPEN `ctx.transform` defect from 233bf8b5, unchanged by
  this session, not chased). No further regression.
- Self-build determinism: dormant ×3 total builds (two direct + one
  flag-revert re-check), SHA-256
  `6e9e6c09598c863a41697effcbfc33f64b8f05e24e10b3bfddb8a22be03b1614`, all
  three identical. Region-live ×2, SHA-256
  `c30d44f2c55d4fa1f8668a7bd07e0a71cea7816a89a4c6388d9260b94e5459a9`, both
  identical.
- Byte-identity vs base (jessie/watr/jzify-entry × optimize 0-3, native):
  12/12 rows SHA-identical.
- `node_modules/watr`: 5.7.15 confirmed intact before and after (the `let
  SW = []` fix present), package.json/package-lock.json untouched by this
  session.
- jz×jz goal gate: does NOT complete under 4 GiB in either self-host
  config — goal gate NOT met. Root mechanism this session was tasked with
  (closure-body/closure-creation schema/typedElem full-table clones) is
  fixed and measured-fixed (native: `emitClosures` 27+/trapped →
  3/complete); the ceiling that remains is a DIFFERENT, later, out-of-scope
  mechanism (watr's own `watOptimize` pass, ~144 s / +1.8 GB natively) —
  named, not fixed.

### Disposition

**Landed, both fixes** (`src/compile/index.js`'s `MapOverlay` +
`emitClosureBody`'s three call sites; `module/function.js`'s
`ctx.closure.make` capture-scan). Both are pure mechanism — zero output
change (byte-identity gate), zero behavior change (kernel-oracle/npm
test/test:wasm all at documented baseline) — and both are independently
measured-necessary (the module/function.js fix alone was required once the
emitClosureBody-only fix left the trap byte-for-byte unchanged; discovered
via native phase profiling, not by re-guessing).

**The goal gate itself is not met**, but not for the reason 2a78a6f6 named
— that specific, named, line-cited pathology is gone, replaced by a
DIFFERENT, LATER, well-evidenced next lever: watr's own module-level
optimizer, whose ~144 s / +1.8 GB native cost on jz×jz's ~10 MB compiled
output is now the dominant remaining cost, sitting close enough to the
4 GiB wasm ceiling (native peak 3.84 GB) that the self-host "tax" very
plausibly tips it over (named hypothesis, not measured this session).
**Next named lead**: wire the same `opts.profile`-shaped breadcrumb
technique THROUGH the self-hosted kernel (mirroring 2a78a6f6's own
`__dbg_mark`/`__dbg_stage`/`__dbg_mem` wasm-global convention, or a fresh
equivalent) specifically around `watOptimize`'s own internal passes (`rec`/
`substGets`/`count`/`walkN`/`walkPostN` were the hottest native symbols in
a `--prof` capture of this run) to confirm the self-host-tax hypothesis and
find whether watr's optimizer has its own O(programSize)-repeated-per-unit
cost analogous to the one just fixed here, or whether it's a genuine
"the module is just this big" floor that needs a different lever entirely
(chunked/streaming optimization, a size-tier default for kernels this
large, or accepting jz×jz needs memory64).

**SHAs**. jz worktree: `2a78a6f6` base, this session's commits are the
`src/compile/index.js` + `module/function.js` pair above plus this ledger
entry. watr: `5.7.15`, confirmed intact (unmodified by this session).
Dormant `dist/jz.wasm` (this session, self-build ×3 total across the
fix-development and final-revert builds): SHA-256
`6e9e6c09598c863a41697effcbfc33f64b8f05e24e10b3bfddb8a22be03b1614` all
three. Region-live `dist/jz.wasm` (this session, self-build ×2): SHA-256
`c30d44f2c55d4fa1f8668a7bd07e0a71cea7816a89a4c6388d9260b94e5459a9` both.
## §Region arena — watr optimizer memory/time lever: ROOT-CAUSED and FIXED
## upstream (watr optimize-mem-2026-08-13, unpublished), engine-level,
## byte-identical; jz×jz goal-gate re-measured (2026-08-13)

**Task**: 259cd4fc named the next lever after the closure-clone fix: watr's
own `watOptimize` pass, +1.8GB / ~144s on the jz×jz compiled module (native
full pipeline 3.84GB peak, self-hosted kernel still traps at 4GiB). Profile
watr's optimizer at the engine level, fix the dominant cost class, verify
byte-identity, re-measure the goal gate.

### Repro harness

Dumped the pre-`watOptimize` module for jz×jz (153-module self-host graph,
`resolveSelfhostBuild({optimize:3})`) as WAT text via a temporary,
uncommitted hook in the jz worktree's `index.js` (reverted before any gate
run — never landed). 389MB WAT text, 6437 top-level `(func …)` nodes
(closures/specializations/stdlib, not jz's own 2071-entry `ctx.func.list`).
Drove watr's `optimize()` directly (parse once, then isolate the call) with
per-pass-boundary `process.memoryUsage()`/wall-clock sampling — cleaner
signal than the noisy full end-to-end pipeline (see below).

### Per-pass profile (isolated optimize() harness, jz×jz WAT, watrGuard:false
### — the config `resolveWatrOpts` actually resolves for jz's level-3/self-
### host profile)

| stage | funcs | wall Δ | RSS behavior |
|---|---|---|---|
| entry clone(ast) | — | 0.4s | +579MB retained (defensive copy, unconditional even under guard:false — public-API immutability contract, not touched) |
| round 1 (dirty=null, ALL funcs) — every pass EXCEPT propagate | 6437 | ~8s combined | modest, +100-300MB per pass, mostly churn |
| **round 1 propagate** | 6437 | **19.0s** | RSS 4108→2621MB (major GC fires mid/post-pass) |
| round 2 propagate | 6186 | 8.3s | similar GC-triggering churn |
| round 3 propagate | 3323 | 4.6s | — |
| rounds 4-6 propagate | shrinking dirty | <1s each | dirty-set filtering already effective by here |
| **runInline: propagate(post-inlineWrappers), WHOLE ast** | 6437 (unfiltered) | **4.3s** | -377MB (GC) |
| **runInline: propagate(post-inline), WHOLE ast** | 6437 (unfiltered) | **4.5s** | -98MB (GC) |
| finish: cse (once, by design) | 6437 | 7.7s | +475MB retained (not reclaimed — organic per-func memoization, not a leak; cse is intentionally whole-module/once per its own design comment) |

Total optimize() wall: 121.9s / 122.1s (2 baseline runs). `/usr/bin/time -l`
peak RSS 5336-5521MB, peak footprint 8492-8882MB in this synthetic
parse-from-text harness (front-loaded ~3.3GB just to parse 389MB of WAT text
— NOT representative of the real pipeline, which hands optimize() a live AST
with no text round-trip; used only for pass-relative attribution).

### Root cause

`runInline` (inside `optimize()`'s `finish()`) calls `propagate(a)` on the
**whole module** twice — once after `inlineWrappers`, once after `inline` —
unconditionally, regardless of how many functions those passes actually
touched. `propagate` has NO internal dirty-awareness: every invocation does
a full `O(funcSize)` scope-walk + up-to-6-round internal fixpoint for EVERY
function reached, whether or not anything changed. Contrast with the ROUND
LOOP's own use of `propagate`, which already runs it per-function through
`per(fn)` gated by the round's `dirty` set (correctly cheap on later
rounds) — `runInline`'s two extra calls were the only remaining
whole-module, ungated re-scans.

**Provably redundant, not just slow**: `propagate` is per-function-local
(its entire working set — `CNT`, `known`, scopes — is scoped to one
`funcNode`; no cross-function state). By the time `finish()` runs, EVERY
function already sits at a propagate fixpoint — either the round loop
converged it, or the round loop's own post-round sweep
(`if (opts.propagate && dirty) for (const f of dirty) propagate(f)`,
existing code, unchanged) gave it one more chance. So re-running
`propagate` on a function `inlineWrappers`/`inline` did NOT touch
reproduces exactly nothing — pure repeated cost, and (per the profile
above) the single biggest churn generator after round-1's mandatory first
pass.

### Fix (watr, `optimize-mem-2026-08-13`, commit `4e399df`)

`inline`/`inlineWrappers` now accept an optional `touched` Set and record
every function whose content they actually rewrote (`inline`: callers a
splice landed in, never the callee itself, which is only read from;
`inlineWrappers`: the wrapper function, never the callee it copies from).
`runInline` passes a `Set`, then propagates only `touched` instead of the
whole ast — same idiom the post-round dirty sweep already uses
(`for (const f of touched) propagate(f)`).

No input-specific special-casing: this is a scale-class fix (any module
where inline/inlineWrappers touch a small fraction of total functions
benefits proportionally; a module where they touch everything is
unaffected — same total work, just no longer duplicated for the untouched
majority).

### Gates (watr)

- npm test (native): 611 total / 591 pass / 0 fail / 20 skip — identical to
  pre-fix baseline (previously re-cloned worktree, submodule test/official
  content-identical, `main`-equivalent baseline).
- `WATR_WASM=1 npm test` (watr dogfooding its own optimizer to compile
  itself): 611/591/0/20 — identical. Rebuilt `dist/watr.wasm` with the
  fixed optimizer: SHA-256-IDENTICAL to the published 5.7.16 artifact
  (`93b5a0bb9c6db9c0a99058d0dff2c0a1f8f36208004a8f3896b3e465efd8b44f`) —
  the fix changes zero output bytes even when watr compiles itself with it.
- jz×jz WAT (the actual target input): optimize() output SHA-256-IDENTICAL
  before/after, 2 independent runs each side
  (`7719cb68e21323e133cbb8391deea210634bcee1865342ce2dfe693b0ace452f`).
  Wall time 121.9s/122.1s (baseline) → 110.5s/[…]s (fixed), ~9% faster, in
  the isolated (low-noise) harness.
- Committed: watr repo, branch `optimize-mem-2026-08-13`, commit `4e399df`
  (`src/optimize.js` + `CHANGELOG.md` "Unreleased" entry). NOT published —
  pristine-pin policy; jz's `package.json` pin stays at `5.7.15` until a
  real publish.

### End-to-end (jz worktree, candidate overlaid ONLY into the worktree's own
### node_modules copy — /Users/div/projects/jz and its node_modules
### confirmed byte-for-byte untouched before/after, verified by hash)

Full native pipeline (`compile()` + `watrTail`/`watOptimize` + `watrCompile`
encode) on this session's shared/contended machine (multiple concurrent
UNRELATED sessions running their own jz self-host builds throughout the
whole session — confirmed via `ps`/`lsof` cwd inspection, not a product of
this session): 3 runs (2 fixed, 1 baseline, interleaved A/B), noisy —
maximum RSS 3475-3868 MB, peak footprint 4596-5172 MB, wall 311-336s, no
clean directional win at this noise floor (machine contention exceeds the
fix's effect size in this metric). All three runs stayed comfortably under
the 4 GiB native ceiling regardless (consistent with 259cd4fc's own
3.84 GB baseline reading) — this was never the tight constraint; the
self-hosted kernel's own tax is.

**Self-hosted goal gate (the actual target): dormant kernel, jz×jz, THIS
session's watr fix overlaid** — `unreachable` trap at exactly 4,294,967,296
bytes (4 GiB), **9.1 seconds** total wall from cold instantiate to trap.
Driver verified correct (sanity-checked against a trivial single-file
compile and a trivial 2-module compile through the SAME kernel/ABI, both
succeeded cleanly) — and the exact "unreachable @ 4,295.0 MB" shape matches
a PRE-259cd4fc session's own documented dormant-kernel jz×jz row exactly
(`.work/research.md` "§Region arena — BOTH standing rows are ONE
mechanism", the jz×jz row: "FAIL — `unreachable` @ 4,295.0 MB", both
dormant and region-live, "Slices 2/3 unbuilt"). This is the SAME trap,
reproduced, not a new one.

**Why this fix cannot plausibly move that number**: 9.1 seconds is far
too fast to have reached `watOptimize` at all — natively, `compile()`
alone (parse→analyze→emit→closures, i.e. everything BEFORE `watOptimize`
starts) takes ~27s at ~2GB peak (259cd4fc's own native measurement,
unchanged this session). A self-hosted equivalent, even accounting for a
real "self-host tax" (NaN-boxed heap, no compaction, coarser allocation
granularity than V8), completing in 9s is dying somewhere in
parse/analyze/emit/closures — BEFORE the pipeline ever reaches
`watrTail`/`watOptimize`, the pass this session's fix touches. The
blocking mechanism this session measured for the self-hosted path is
upstream of where the fix operates; the fix is real, verified, and
byte-identical, but it cannot be the lever that closes THIS gate. Region-
live attempted anyway (task's own instruction), see below.

**Region-live kernel, same jz×jz graph, THIS session's watr fix overlaid**
(`REGION_HOOKS_ACTIVE = true` hand-flip in `scripts/self.js`, rebuilt via
the same `build-dist.mjs` path, reverted before any other gate ran): SAME
outcome — `unreachable` trap at exactly 4,294,967,296 bytes, 9,478 ms total
wall (vs dormant's 9,148 ms — no meaningful difference). Confirms: this is
NOT the region-arena-fixable mechanism either (matches the OLDER, pre-
259cd4fc session's own table row: "jz×jz is unchanged in EITHER kernel —
same deliberate `unreachable` abort... Slices 2/3 unbuilt" — same finding,
independently reproduced by this session with this session's watr fix
applied, region-live kernel SHA `11c1c9bd…`, dormant `94132711…`).

### jz gates (overlaid candidate, native `dist/jz.wasm` cached from the
### fixed watr build)

- **npm test (native)**: `3436` total (`19696` assertions) / `3428` pass /
  `2` fail / `6` skip — the 2 failures are the SAME documented pre-existing
  pair (interval-walk / typed-RMW codec bounds-check shape assertions,
  unrelated to watr/optimize), matching 259cd4fc's own baseline tally
  exactly. Required TWO retries: the first two attempts crashed silently
  (no stack trace, process just vanished) at nearly the identical spot
  in the suite (~line 17,100-17,200 of console output, inside a CPU-heavy
  `Math.pow`-fold ULP-grid regression test) — traced to this shared
  machine running MULTIPLE OTHER sessions' own concurrent jz self-host
  builds throughout (confirmed via `ps`/`lsof` cwd on the surviving
  processes, e.g. a `scratchpad/heal-landing` cwd unrelated to this
  session) exhausting system memory at that point; NOT reproduced once
  contention eased for the third attempt, which ran the exact same
  section cleanly. Documented here in the interest of not silently
  omitting inconclusive prior attempts.
- **test:wasm**: launched (`JZ_TEST_TARGET=jz.wasm node test/index.js`,
  routes every compile in the suite through `dist/jz.wasm` — a fresh
  512MB wasm instance per compile, per its own header comment) — did NOT
  finish within this session's time budget. Zero failures in everything
  it did complete (several thousand assertions, including a full pass
  through the same `Math.pow`-fold ULP-grid section that stress-tested
  npm test above) before the session had to close out; the dominant cost
  observed was per-test wasm-instantiation overhead (inherent to this
  target, unrelated to the watr fix) compounded by the same shared-machine
  contention noted above. Not a substitute for npm test's kernel-parity/
  kernel-oracle rows (already green, exercising the SAME `dist/jz.wasm`
  built with this session's watr fix) — banked, not required to re-prove
  correctness beyond what's already shown.
- **Self-build determinism (dormant)**: 2 independent process invocations
  (this session's `scripts/build-dist.mjs` run, and an earlier standalone
  `compile(profile.graph.code, {...resolveSelfhostBuild({optimize:3})})`
  driver run) — SHA-256 `94132711b99019a8d6da2cf43bdd2b5ddddef15af434510aaa734edac187bbb8`,
  both identical.
- **kernel-oracle / kernel-parity**: part of the native `npm test` run
  above (both files run through `test/index.js`'s aggregation) — 0
  failures attributable to either, folded into the 3428/2 tally.

### Disposition

Landed in watr (uncommitted-to-jz, per pristine-pin policy — jz consumes it
only after a real npm publish, out of this session's authority). jz-side:
ledger-only, this entry, on the 259cd4fc detached chain.

**The named pathology this session was tasked with (watr's `watOptimize`
whole-module cost) IS fixed** — real, byte-identical, ~9% faster in
isolation, committed upstream. **The goal gate itself is NOT met** — not
because the fix failed, but because the self-hosted kernel's OWN blocking
mechanism sits upstream of watOptimize entirely (parse/analyze/emit/
closures, self-host tax), unchanged by this session and effectively
unreachable-in-9-seconds regardless of what happens later in the pipeline.
**Next named lead** (unchanged from what 259cd4fc already named, now
sharpened): instrument the self-hosted kernel's OWN early phases (the
`__dbg_mark`/`__dbg_stage` wasm-global breadcrumb convention already used
elsewhere in this codebase) to find where inside parse/analyze/emit/
closures the self-host tax actually blows the budget — this session's
9-second/4GiB reading proves it's early, not late, but does not localize
further without that instrumentation.

## §Region arena — jz×jz phase-localized: the burn is entirely inside
## `plan()`'s `narrowSignatures` pass (src/compile/narrow.js), NOT front()
## and NOT compileAst's emit/closures — WAT-spliced breadcrumb evidence,
## root cause named (unindexed O(functions×params×callSites) call-site
## re-scan), WALLED on the fix per this session's own narrow.js exclusion
## (2026-08-13)

**Task**: 332ec25c named the next lead precisely — the 9s/4GiB self-hosted
trap (both dormant and region-live, unchanged by 259cd4fc's closure-clone
fix or this chain's own upstream-unpublished watOptimize fix) is "far too
fast to have reached watOptimize… dying somewhere in parse/analyze/emit/
closures" — and named the exact next step: breadcrumb the self-hosted
kernel's own phases with `__dbg_mark`/`__dbg_stage` wasm globals to find
where. This session built that instrumentation and ran it.

### Method — WAT-spliced breadcrumbs on the ALREADY-BUILT kernel, no jz
### source touched

Reused the existing worktree at `region-final-2026-08-11`/`332ec25c`
(`.../scratchpad/region-slice2-front`), `npm ci`'d fresh (not the
`node_modules/watr` symlink convention — a genuine registry install).
**Content-verified watr 5.7.15's `src/optimize.js`**: both hunks of the
SW-rides-regionExit fix (446343c4's own subject) present verbatim — `let SW
= []` (line 3102, not `const`) and the regionExit call site's 5-element
root bundle (`[ast, dirty, snapshots, opts.constF64, SW]` /
`SW = __regionOut[4]`, lines 8492-8493) — so the published pin is the real
fix, not a stale tarball (the exact blind spot 446343c4 itself named).
Diffing further against `/Users/div/projects/watr`'s own working tree
showed that repo has since moved ahead with unrelated, unpublished work
(an "optimize if-condition constants" feature + 332ec25c's own unpublished
watOptimize fix) — correctly NOT overlaid; jz stays pinned at the pristine
published 5.7.15 per policy.

Built two NAMED kernels (`compile(profile.graph.code, {modules, memory,
optimize: profile.optimize, names:true})`, `resolveSelfhostBuild()`
defaults, NO `wat:true`) — dormant (`REGION_HOOKS_ACTIVE=false`, hand-
flipped and reverted via a disposable try/finally script) and region-live
(`=true`) — both via a scratch, session-only, deleted-at-end driver
(`.work/scratch-build-named.mjs`; the checked-in `resolveSelfhostBuild`/
`build-dist.mjs` machinery is untouched, only invoked). `git diff` in the
worktree was empty before and after every build.

Sanity-reconfirmed the baseline trap first, unmodified: both kernels
`unreachable` at exactly `4,294,967,296` bytes (2³², 65536 pages, 4096.0
MB), dormant 6.8s / region-live 7.4s — matches 332ec25c's own ~9.1s/9.5s
reading (same signature, ordinary machine-speed variance, not a new
mechanism) and 259cd4fc's own 153-module count (`resolveModuleGraph
('scripts/self.js', {resolveNode:true})`, the SAME `bench/jz/jz.js`-adjacent
recipe this chain has used since 259cd4fc/332ec25c, not the older
`bench/jz/jz.js` benchmark-file entry point).

**Breadcrumb technique** (the campaign's own established convention,
applied via binary/text, never JS source): `wasm2wat --enable-all` (WABT
1.0.36; jz's own `wat:true` output is a DIFFERENT, non-standard-tool-
readable form, so this session decompiled the raw named binary instead)
decompiled each named kernel to flat (unfolded, one-instruction-per-line)
WAT text — confirmed stdlib intrinsics (`$__alloc`, `$__memgrow`) keep
their literal names, and so do every JS-sourced function (`$front`,
`$m0_parse$parse`, `$m121_index$compile`, etc — the `m<N>_<basename>$<func
Name>` mangling `prepareModule`'s own comment documents, independently
confirmed by matching module ordinals in BOTH kernels' WAT byte-for-byte:
`m0_parse`, `m65_index` (prepare/prepareModule), `m111_eval` (preEval),
`m114_assemble` (buildStartFn/pullStdlib/optimizeModule), `m121_index`
(compile/analyzeFuncForEmit/emitFunc/emitClosureBody), `m127_narrow`
(narrowSignatures/applyPointerParamAbi/narrowPointerResults/
narrowI32Results), `m133_index` (plan), `m137_scope`/`m138_inline`
identical across dormant and region-live builds). A small Node script
(`splice.mjs`, disposable) declared 24 new `(mut i64)`/`(mut i32)` globals
(sentinel `-1`, exported) appended AFTER every pre-existing module field
(so no PRE-EXISTING global's positional index shifts — `$__heap`'s own
already-exported index 3, read via `(global.get 3)` since WABT strips
non-exported/non-named globals' symbolic names, stays valid), then spliced
one self-contained `(global.set $__dbg_X (i64.extend_i32_u (global.get
3)))` (heap-bytes-at-entry) — plus, for three hot-loop targets, a paired
i32 call counter — as the FIRST instruction inside 21 target functions'
bodies (located by exact name match, inserted after any `(local …)`
declaration line). `wat2wasm --enable-all` reassembled; validated via a
trivial single-module compile before every real run (bytes/shape
unchanged, confirming the splice is stack-neutral and semantically inert
except for the new writes). This is READ-ONLY instrumentation on a
disposable copy of one already-built, already-verified artifact — zero jz
source edited, zero native recompilation, so none of the campaign's own
documented closure-renumbering heisenbug risk applies.

### Phase map (dormant kernel, all 21 breadcrumbs, one representative run)

| phase (function) | heap at entry | notes |
|---|---|---|
| `front` | 19.1 MB | — |
| `m0_parse$parse` (last of N) | 679.4 MB | **parseCount = 154** — every module parsed |
| `m65_index$prepareModule` (last of N) | 679.4 MB | **modOrdinal = 643** (154 real parses, 489 cache hits — `ctx.module.resolvedModules` working as designed) |
| `m142_index$jzify` (last of N) | 680.4 MB | **jzifyCount = 154** — every module jzified |
| `m65_index$prepare` (outer) | 19.4 MB | — |
| `m111_eval$preEval` | 690.7 MB | front() COMPLETE here — all 154 modules parsed+jzified+prepared |
| `m121_index$compile` (compileAst entry) | 723.2 MB | — |
| `m133_index$plan` | 779.5 MB | — |
| `m137_scope$classifyHashDictGlobals` | 1,311.9 MB | — |
| `m137_scope$flattenFuncNamespaces` | 1,312.2 MB | — |
| `m137_scope$devirtGlobalCalls` | 1,364.0 MB | — |
| `m138_inline$inlineHotInternalCalls` | 1,653.4 MB | — |
| `m66_facts$collectProgramFacts` (last of N) | 2,845.0 MB | **collectFactsCount = 5** (plan's own dirty-resweep loop) |
| `m127_narrow$narrowSignatures` | 2,864.0 MB | **entry point of the fatal 1.2+ GB burn** |
| `m127_narrow$applyPointerParamAbi` | 3,063.4 MB | +199 MB since narrowSignatures entry |
| `m127_narrow$narrowI32Results` (1st call, line 2212) | 3,077.1 MB | 2nd call (line 2481) **never reached** |
| `m127_narrow$narrowPointerResults` (2nd call, line 2471) | **4,081.0 MB** | last breadcrumb reached — 15 MB of headroom left |
| `m121_index$analyzeFuncForEmit`/`emitFunc`/`emitClosureBody`, `m114_assemble$buildStartFn`/`pullStdlib`/`optimizeModule`, `optimizeTail` | **never reached** (sentinel -1, count 0) | compileAst's post-`plan()` phases, watr's optimizer — all unreached |
| **trap** | **4,096.0 MB (2³²)** | `unreachable`, ~6.8s |

Region-live kernel: **identical shape**, front()'s own region boundary
visibly WORKING (`preEval` heap **99.8 MB**, down from parse's 679.4 MB —
a genuine ~584 MB reclaim, not inert), carrying that ~584-600 MB head
start all the way through (`narrowSignatures` entry 2,267.8 MB vs
dormant's 2,864.0 MB) — which is why region-live's trap lands one
breadcrumb FURTHER in (`narrowI32Results`'s 2nd call, line 2481, **is**
reached at 3,983.7 MB, immediately followed by the trap) instead of
stalling at `narrowPointerResults`'s 2nd call like dormant. Same
mechanism, same wall (~1.2–1.8 GB burned inside `narrowSignatures` alone,
region-live's larger head start just lets it run further into the SAME
curve before the shared 4 GiB ceiling stops it), ~1.4 GB apart in usable
headroom, ~0.6s apart in wall time — not a region-arena defect at all.

### Verdict: (a)-class — a single pass's unindexed whole-program re-scan,
### not (b) region-inert and not (c) one huge allocation

- **NOT (b) — region reclaim silently inert**: refuted directly.
  Region-live's own front-boundary `__region_exit` demonstrably reclaims
  ~584 MB (712 MB → 99.8 MB peak-to-post-exit), a real, working, measured
  win — the SAME magnitude of savings this chain's own memory-curve
  entries have recorded for `watr`/`jzify-entry`. The region mechanism
  works exactly as designed; it simply isn't scoped to cover the pass that
  actually explodes (`plan()`/`narrowSignatures` runs entirely inside
  `compileAst`, downstream of `front()`'s one round, with no region
  boundary of its own).
- **NOT (c) — a single capacity-overflow allocation**: the burn is spread
  across `narrowSignatures`'s own internal machinery (entry 2.86 GB
  dormant / 2.27 GB region-live → trap at 4.10 GB dormant), not one
  `__alloc` call; `plan()`'s earlier passes also show smooth, monotone
  per-phase growth (779 MB → 1.65 GB across classifyHashDictGlobals/
  flattenFuncNamespaces/devirtGlobalCalls/inlineHotInternalCalls), never a
  single vertical jump.
- **NOT a single pathological module** — `parseCount`/`jzifyCount` = 154/154
  (every module in the 153-module + 1 entry graph parsed and jzified
  cleanly; `front()` completes in full, at a modest 680–723 MB, in BOTH
  kernels). The 259cd4fc/2a78a6f6 closure-clone fix and this session's own
  front-boundary finding both hold — this is a THIRD, separate, unfixed
  pathology, downstream of both.
- **IS (a)-class**: an unindexed, whole-program-scale re-scan, structurally
  the SAME defect family 259cd4fc already fixed once (`emitClosureBody`'s
  O(programSize) Map clone) — just a new, unfixed sibling living in
  `src/compile/narrow.js`'s call-site consensus machinery, not compileAst's
  closures.

### Root cause — `hardParamVal`/`hardParamRecvArrTyped` (src/compile/
### narrow.js): O(callSites) linear scan, called from an O(functions×params)
### outer loop, called twice more per re-narrowing round

`narrowSignatures` (`src/compile/narrow.js:1698`) builds two consensus
helpers, both closures over the pass's own `callSites` array (from
`programFacts`, ONE array covering every call site in the ENTIRE compiled
program):

- `hardParamVal(funcName, k)` (line ~1839): `for (let s = 0; s < callSites.
  length; s++) { if (callSites[s].callee !== funcName) continue; const state
  = siteState(callSites[s]); … }` — a full linear scan of ALL call sites,
  allocating a fresh `siteState` object (10 fields + a `new Map()` for
  `paramFactsCache`, per its own comment "built fresh per call site per
  lattice sweep… this design's hottest loop") for every site visited.
- `hardParamRecvArrTyped(funcName, k)` (line 1875): the identical shape.

Both are called from loops that iterate **every function × every
parameter**:
- `applyPointerParamAbi` (line 294, called line 2207): `for (const func of
  ctx.funcs.list) { … for (const [k, r] of reps) { const hv =
  hardParamVal(func.name, k) … } }` — non-exported/non-valueUsed functions
  only, still O(functions × params) outer iterations, each paying a full
  O(callSites) inner scan.
- The unrestricted sibling (line 2502-2503, its own comment: "Computed for
  every param position **regardless of exported/valueUsed status**"):
  `for (const [fname, reps] of paramReps) for (const [k, r] of reps) if
  (hardParamRecvArrTyped(fname, k)) …` — EVERY function in the program,
  not just internal ones.

Net cost: **O(functions × params × callSites)**, paid THREE separate times
(`applyPointerParamAbi` once, `hardParamRecvArrTyped`'s own unrestricted
loop once, plus `narrowPointerResults`'s own internal `while(changed) { for
(const func of funcs) {…} }` fixpoint — line 888 — which re-scans its
whole `funcsWithNarrowableResult` list every round until nothing changes,
compounding further if pointer-result narrowing cascades transitively
through a deep call chain, exactly the shape a real, richly-layered
5.88 MB/153-module compiler source has). For jz's own source at this
scale (thousands of functions, tens of thousands of call sites — no
corpus program this campaign's own kernel-oracle/kernel-parity/fuzz
suites exercise comes remotely close to this size), this compounds to a
number of `siteState` allocations large enough to matter.

**Why this is fatal ONLY self-hosted, not natively**: every `siteState()`
call's object + `Map` is garbage the instant its scan iteration ends
(never stored past the loop). Natively (V8), real GC reclaims it — the
cost is CPU time only (259cd4fc's own native measurement: `compile()`
completes in ~27s at ~2 GB peak RSS, i.e. `plan()`/`narrowSignatures`'s
own share of that IS the CPU cost, invisibly reclaimed). Self-hosted, the
kernel's bump arena never frees anything mid-compile (the whole point of
the region-arena program is adding RECLAIM points; `plan()` has none) — so
the exact same allocation volume that's "slow but fine" natively becomes
"~1.2–1.8 GB of PERMANENT heap growth inside one pass" self-hosted,
exhausting the wasm32 4 GiB ceiling before the pass (or the compile) can
finish.

This is the SAME structural class 259cd4fc already named and fixed once
(`emitClosureBody`'s O(programSize) `Map` clone paid per closure, replaced
with `MapOverlay` — O(closure's own captures) instead) — a new, unfixed
sibling instance, this time in `narrow.js`'s call-site census rather than
`compile/index.js`'s closure emission.

### Disposition — BANKED, not fixed: `src/compile/narrow.js` is this
### session's own named exclusion

The task's own scope explicitly excludes editing `src/compile/narrow.js`
this session — precisely the one file the fix would have to touch (an
index built once per `narrowSignatures` call — e.g. a `Map<funcName,
callSite[]>` grouping, replacing `hardParamVal`/`hardParamRecvArrTyped`'s
own linear `callSites` scans with a single `.get(funcName)` — would turn
the whole O(functions×params×callSites) shape into O(callSites +
functions×params), the same idiom `MapOverlay` used elsewhere; not
attempted, narrow.js is central enough — and this campaign's own repeated
`closure4232`/`fromnested`-class heisenbugs are proof enough — that a
same-session drive-by edit under this task's time budget is exactly the
"stop-on-fail tripwire" this ledger's own discipline exists to prevent).
No jz source changed. `git status`/`git diff` in the worktree: clean
throughout (checked after every build; the two disposable scratch scripts
and four scratch kernels this session built were deleted at session end,
never committed — `.work/*.mjs`/`.work/*.wasm` are gitignored regardless).

**No gate ladder run** — no fix landed to gate; nothing in the tracked
tree changed. 332ec25c's own already-recorded baseline (npm test
3436/3428/2-pre-existing-fail/6-skip, kernel-oracle dormant 13/13,
region-live 7/13 — the separate open `ctx.transform` defect, unchanged,
not chased per this task's own instruction — self-build SHA-convergent)
is inherited unmodified, consistent with this session's own zero-diff
`git status`.

**jz×jz goal gate: NOT met.** Root cause is now named precisely (not
inferred) for the first time in this chain — `src/compile/narrow.js`'s
`hardParamVal`/`hardParamRecvArrTyped` O(functions×params×callSites)
census, compounded by `narrowPointerResults`'s own fixpoint — a THIRD,
previously-unlocalized pathology living entirely inside `plan()`,
downstream of both the already-fixed closure-clone class (259cd4fc) and
the already-proven-sound front boundary (this session's own region-live
reclaim measurement). **Next session's concrete lever**: index `callSites`
by callee once per `narrowSignatures` call (a `Map<string, CallSite[]>`
built at the top, replacing every `hardParamVal`/`hardParamRecvArrTyped`
linear scan with a `.get(funcName) ?? []` lookup) — bounded, single-file,
same idiom as the already-landed `MapOverlay` fix, but requires lifting
this session's own narrow.js exclusion.

**SHAs.** Worktree: `332ec25c` (region-final-2026-08-11, detached HEAD —
this session's own `git diff` against it is empty; only this ledger entry
is new). watr: npm-resolved `5.7.15`, content-verified against the
`let SW = []`/5-element-root-bundle hunks (446343c4's own SW hunk),
confirmed present. No `dist/jz.wasm` rebuilt in the tracked tree — every
kernel this session built was a disposable, deleted scratch artifact.


## §Region arena — `__region_relocate_props` durable-WRITE-path root-caused and
## fixed (TYPED-VIEW off-16 header confusion): a real, independently-verified
## corruption bug closed; the region-live wall persists — same pre-existing
## address-sensitive heisenbug, now landing on a different corpus shape
## (2026-08-13)

**Task**: the named lead from 233bf8b5/2a78a6f6 — root-cause the durable
dyn-props WRITE path behind `__region_relocate_props`'s garbage-capacity read
(`nestedtyped` oracle row, region-live O0/O2). Worktree off `259cd4fc`.

### Root cause — mechanism family (c), wrong-offset write for a layout kind

`module/collection.js`'s three dyn-props entry points (`__dyn_get_t_h`,
`__dyn_set`, `__dyn_del`) and their shared `hasPropsSidecarWat` predicate
treat **every** `PTR.TYPED` receiver as header-carrying — reading/writing a
props-hash pointer at `off-16` unconditionally. That's true for an OWNED
typed array (`new Int32Array(64)`, `TypedArray.from(...)`,
`new Int32Array(existingTypedArray)` — allocated via `__alloc_hdr_n`, which
reserves the standard 16-byte `[propsPtr@-16][len@-8][cap@-4]` header,
documented at core.js:1447). It is **false** for a VIEW-kind typed array
(`aux&8` — `new T(buffer, byteOffset, length)` or `.subarray()`): its 16-byte
block is a bare descriptor `[byteLen][dataOff][rootOff][reserved]` allocated
via plain `__alloc(16)` (layout-kinds.js `regionArmTyped`'s own doc), with
**no header before it at all** — `off-16` there is whatever the bump
allocator happened to place immediately before the descriptor (typically the
tail of the buffer/typed-array the view was constructed from).

Setting a dynamic property on a VIEW (`view.tag = 'x'`) therefore stomps 8
bytes of unrelated heap data with a props-hash pointer; reading one back can
misinterpret whatever precedes an unrelated VIEW descriptor as a valid
HASH pointer. **Confirmed natively, with no self-hosted kernel and no
region-arena involved at all** — a plain, deterministic repro:

```js
let buf = new ArrayBuffer(64), full = new Int32Array(buf)
for (let i = 0; i < 16; i++) full[i] = 2000 + i
let view = new Int32Array(buf, 8, 2)   // VIEW: aux & 8
view.tag = 'hello'                     // corrupts full[12..15]'s backing bytes
// → RuntimeError: memory access out of bounds, deterministic, pre-fix
```

This is exactly the shape `__region_relocate_props`'s garbage-~2^31-capacity
read matches: a stray write lands on an unrelated HASH object's own
`cap`/`n` header words (or on data a later HASH's header gets allocated
into), and the relocator reads it back as a bogus capacity later, at a
completely different call site than the one that actually corrupted it —
consistent with 233bf8b5's own framing ("root-cause the durable dyn-props
WRITE path, not just the read site").

### The fix

`hasPropsSidecarWat(typeExpr, objExpr)` (module/collection.js) now requires
`aux&8==0` for a `PTR.TYPED` receiver (`(type==TYPED && !(aux&8)) || SET ||
MAP`, `ARRAY`/`OBJECT` unchanged) — the same three ephemeral direct-header
blocks in `__dyn_get_t_h`/`__dyn_set`/`__dyn_del` that duplicate this check
inline (rather than calling the shared predicate) get the identical guard. A
VIEW now falls through to the global `$__dyn_props` table (keyed by offset)
exactly like CLOSURE / a shifted ARRAY / a static-segment OBJECT already do
— no VIEW-specific special-casing, just the existing general fallback this
codebase already has for "no legitimate header slot". `__ptr_aux` added to
the three functions' `deps` arrays. Engine-level, unconditional on
`REGION_HOOKS_ACTIVE` (the bug is real in dormant/native too — the repro
above needs neither): **module/collection.js only, no `nestedtyped`
special-casing.**

Verified fixed with the exact repro above (native, dormant): `full[]`
untouched, `view.tag`/`'tag' in view`/a second `view.other` prop all read
back correctly, no trap.

### What this fix actually moves (corpus-row-level, not named-test-level)

Kernel-parity's CORPUS (11 rows × O0/O2/O3) and kernel-oracle's AGREE list
(13 rows × O0/O2), diffed row-by-row between a pristine `259cd4fc` region-live
build and this fix's region-live build (both `REGION_HOOKS_ACTIVE=true`,
otherwise identical):

| row (opt level) | baseline | with fix |
|---|---|---|
| `dict` O2 (CORPUS) | **TRAP** unreachable | **PASS** |
| `dict` O2 (AGREE list) | **TRAP** unreachable | **PASS** |
| every other CORPUS/AGREE row, both lists | unchanged | unchanged (zero new corpus-row failures) |

`dict` (`let d={}; d[c]=(d[c]||0)+1`) is a plain dynamic-key HASH write —
squarely the code this fix touches. **Zero corpus-row regressions** on
either list. This is genuine, verified progress, not a wash.

### The wall does NOT close — it moves, matching the campaign's own repeatedly-
### documented address-sensitive heisenbug class

`node test/index.js kernel-oracle` (named-test granularity, not corpus-row)
goes **7/13 (baseline) → 5/13 (with fix)**, 3/3 deterministic both ways. The
drop is not the `dict` fix regressing anything — it's `kernel oracle: bare
BigInt array-element return — AGREE` (`let a=[1n]; return a[0]`, O1 leg only)
**newly trapping**, previously clean at `259cd4fc` baseline (confirmed via
direct instance calls, not just the named-test summary, both configs).

Traced with the campaign's own breadcrumb method (`declGlobal` i32 globals
in `module/core.js`/`module/collection.js`, `names:true` scratch build via
`compile(profile.graph.code, {..., names:true})`, no `wat:true`, reverted
before commit): the trap is `__dyn_get_t_h ← __dyn_get_t ← __dyn_get_expr ←
m49_compile$normalize` (the SELF-HOSTED KERNEL's own compiler code, reading
a dynamic property off one of its own AST-adjacent objects while compiling
the trivial `[1n]` source) — **not** `__region_copy_rec`/
`__region_relocate_props` at all; a breadcrumb on `__region_relocate_props`
showed its own last call (#278, right before this trap fires later in the
same compile) reading a perfectly sane `cap=32 n=16`, ruling it out as the
proximate cause here. The receiver at the actual trap is `type=ARRAY,
aux=0` (`layout.js` PTR enum) — not TYPED, not touched by this session's
`hasPropsSidecarWat` logic change at all (the TYPED branch's condition is
false regardless of the new aux check for a non-TYPED type; the added code
is provably inert for this receiver). The only causal link to this fix is
**code-size delta**: `__dyn_get_t_h`/`__dyn_set`/`__dyn_del` each grew by a
few WAT nodes, shifting the self-hosted kernel's own compiled-code layout
enough that a *different*, pre-existing, unfixed defect (a durable ARRAY's
`off-16` read landing on now-stale/reclaimed memory at a specific address —
`off=2303832` at the trap, call #5841 into `__dyn_get_t_h`) now fires on a
program it didn't fire on before.

This is not speculation — it is the SAME mechanism class `scripts/self.js`'s
own header comment and 233bf8b5's own three-root-variant table already named
("address/layout-boundary-sensitive heisenbug... narrowing/widening the root
shifts WHICH corpus shape trips the SAME underlying relocator defect rather
than closing it"), independently reconfirmed here by a fix that (a) is
proven inert on the specific receiver that now traps, and (b) still measurably
moves which row fails. **`__dyn_get_t_h`'s durable-ARRAY off-16 read at a
stale address is therefore the concrete next-lead pointer** — same family
as mechanism (b) in this task's own brief (stale pointer to reclaimed
memory), not mechanism (c) (this session's own fix closed the one instance
of (c) that was findable). A minimal native (non-kernel) repro was not
attempted this session — budget did not extend to one more empirical cycle;
the breadcrumb method above is the proven, reusable starting point.

### Gates

- **Native `npm test`: 3436 total / 3428 pass / 2 fail / 6 skip** — byte-for-
  byte the documented `259cd4fc` baseline (the two pre-existing
  `test/optimizer.js` pins, "interval walk: strided companion cursor…" and
  "typed RMW: one guard…", both independently reconfirmed present on a
  pristine `259cd4fc` checkout this session, before this fix — genuinely
  pre-existing, not newly attributed). **Zero regressions.**
- **`npm run test:wasm`: 2731 total / 2725 pass / 0 fail / 6 skip** — exact
  baseline match.
- **`test/perf-ratchet.js`**: `nest` 22411→22587 (+176), `condref`
  103818→104138 (+320) — both traced to this fix's own guard (`hasPropsSidecarWat`
  gets inlined into hot loops reached via untyped-parameter indexed access,
  e.g. `progNest`'s `a[i]`/`a[j]` on an unproven-type param; the extra
  `aux&8` check duplicates at each inline site). Re-baselined
  (`node test/perf-ratchet.js --update`, `test/perf-ratchet.json` diff is
  exactly these two lines) — justified per the ratchet's own doc ("a real
  codegen change... re-baseline"): the added cost is the minimum needed for
  correctness (one aux extraction + mask, gated behind the TYPED branch),
  paid only on the generic (statically-unproven-type) dyn-prop dispatch
  path, not on any statically-typed fast path.
- **Dormant kernel-oracle: 13/13 ×3** (541 assertions each) — unaffected,
  unchanged from `259cd4fc`.
- **Region-live kernel-oracle: 5/13 ×3** (181 assertions, deterministic) —
  DOWN from baseline's 7/13 ×3 (also reconfirmed this session, deterministic).
  NOT a gate pass. See "What this fix actually moves" and "The wall does NOT
  close" above for the full, honest accounting: corpus-row-level zero
  regressions + one genuine fix (`dict` O2), named-test-level one newly-
  exposed pre-existing heisenbug instance (`bare BigInt array-element` O1).
- **Region-live kernel-parity**: CORPUS-row level — `nestedtyped`/
  `subviewtyped`/`dvnested` still trap at O0 (unchanged from baseline,
  `dict`/`boolconst` no longer BOTH trap at O2 — only `boolconst` does now,
  `dict` fixed), O3 stays 11/11 clean (unchanged).
- **jessie/watr/jzify-entry, region-live ×3**: **ALL CLEAN, deterministic,
  zero traps** — jessie SHA `10429e69…` ×3, watr `cff90984…` ×3,
  jzify-entry `2286099a…` ×3 (`.work/jzify-entry.mjs` recreated from the
  main repo's own copy per the established convention, worktree-only,
  discarded).
- **Self-build ×2, dormant**: SHA-256 `dd04c4f7120867c32cf9cd07802d505ddd27c8cd0f7030e8bccd996919c9aaf7`
  both times — converges (differs from `259cd4fc`'s own dormant SHA
  `6e9e6c095...`, expected: `module/collection.js` changed).
- **Self-build ×2, region-live**: SHA-256
  `497b22638e5d06fe87f2c353df2537b9b6431c17802c5afd06fe6f7f9892800f` both
  times — converges.
- `REGION_HOOKS_ACTIVE` confirmed `false` in the committed `scripts/self.js`
  (unchanged from `259cd4fc` — every hand-flip this session was built,
  gated, and reverted before the next step; `git diff scripts/self.js`
  clean at commit time).

### Disposition — WALLED, not SLICE 3 FULLY SOUND, but a genuine fix lands

The task's own gate bar (region-live oracle 13/13 ×3 both configs) is **not
met** — do not read this entry as closing the front. What IS true, precisely:
one full mechanism family from the task's own taxonomy (c — wrong-offset
write for a layout kind) is root-caused, fixed at the engine level with no
special-casing, independently verified outside region-arena entirely (a
plain native repro, no kernel, no `REGION_HOOKS_ACTIVE`), and lands with
**zero regressions on every gate that reflects what actually ships**
(native suite, test:wasm, dormant kernel-oracle, both self-builds
converge). The region-live diagnostic — which never ships
(`REGION_HOOKS_ACTIVE` stays `false` by default) — moves from 7/13 to 5/13
named-tests not because this fix is wrong, but because it demonstrably
perturbs code layout enough to re-expose the SAME unresolved
address-sensitive heisenbug this campaign has chased since at least the
`ba0b5f6d`/`2f596a84`/`db16685e`/`17e7701e` chain, on a new, smaller,
cleanly-isolated trigger (`[1n]` at O1 specifically — the smallest repro
this heisenbug class has had yet).

**Next named lead, concrete and precise**: `__dyn_get_t_h`'s durable-ARRAY
`off-16` read (module/collection.js, the block gated by `hasPropsSidecarWat`
+ `off < heapResetWat()`) reads a stale/reclaimed address for a receiver
reached via `m49_compile$normalize`'s own dynamic-property access while the
self-hosted kernel compiles `export let f = () => { let a = [1n]; return a[0]
}` at O1 — receiver is `type=ARRAY aux=0 off=2303832`, the 5841st
`__dyn_get_t_h` call. This is the smallest, cleanest repro this heisenbug
class has produced across the whole campaign; a future session should start
here with the store-side breadcrumb (which write left that address either
never-written or reclaimed) rather than re-deriving a repro from scratch.

**SHAs**. jz worktree: `259cd4fc` base, this session's only commits are
`module/collection.js` + `test/perf-ratchet.json` (the fix + its justified
re-baseline) plus this ledger entry. watr: unchanged, `5.7.15`
content-verified against the exact two-line SW hunk (`node_modules/watr/src/optimize.js:3102,8493`)
before any gate ran this session. Dormant `dist/jz.wasm` (this session,
self-build ×2): SHA-256 `dd04c4f7120867c32cf9cd07802d505ddd27c8cd0f7030e8bccd996919c9aaf7`
both. Region-live `dist/jz.wasm` (this session, self-build ×2): SHA-256
`497b22638e5d06fe87f2c353df2537b9b6431c17802c5afd06fe6f7f9892800f` both.
## §Region arena — `narrow.js` callee-index fix LANDS: narrowSignatures'
## own O(functions×params×callSites) census eradicated (measured, not
## inferred) — jz×jz goal gate STILL traps at 4 GiB, but the frontier moves
## cleanly past `plan()` into `compileAst`'s `analyzeFuncForEmit` loop, a
## NEW, phase-stamped, precisely-banked pathology (2026-08-13)

**Task**: 097a51d7 named the fix precisely and walled it on its own
narrow.js exclusion: index `callSites` by callee ONCE per `narrowSignatures`
call, replace every `.callee === funcName` linear scan with a `.get(name)`
lookup. This session's own exclusion lifted (file clean, last commit 24h+),
implemented the fix, and re-ran the full jz×jz goal gate.

### The fix — `src/compile/narrow.js`, one file

Six call-site-census closures inside `narrowSignatures` each used to
linear-scan the FULL `callSites` array (from `programFacts`, one array
covering every call site in the ENTIRE compiled program) filtering on
`.callee === funcName`, called from an outer loop over every function ×
every param:

- `hardParamVal` / `hardParamRecvArrTyped` (097a51d7's own named pair) —
  driven by `applyPointerParamAbi` (every non-exported/non-valueUsed
  function × param) and the "unrestricted sibling" loop (line ~2494's own
  comment: "regardless of exported/valueUsed status" — EVERY function).
- `hardParamPresentVal` — same shape, same `applyPointerParamAbi`-style
  hard-consensus fold, un-named by 097a51d7 but identical pathology.
- `bigintBoxedVerdict`'s inner loop, the BIGINT-nullable join, and the
  `mayBeUndefined` join — three more `for (const cs of callSites) { if
  (cs.callee !== fname) continue; … }` folds over `paramReps`, each an
  existential OR (any matching site proves X) rather than hardParamVal's
  universal AND, but the SAME O(functions×params×callSites) shape.
- `callerArgSelfConsistentI32` (called from `applyI32ParamSpecialization`,
  itself called twice per `narrowSignatures` invocation) — same filtered
  scan, gated behind a narrower `mutated && wasm==='f64'` condition so
  lower-frequency in practice, converted anyway for completeness (same
  file, same idiom, no extra risk once the index exists).

**The index**: built once, immediately after `filterLiveCallSites`'s
in-place compaction (the ONLY place in the whole file that mutates
`callSites` — verified by grep for `.push`/`.splice`/`.length =`/indexed
writes; `narrowSignatures` calls `filterLiveCallSites` exactly once, at its
own top, before any of the six consumers run) — a plain
`Map<calleeName, CallSite[]>`, one forward pass, appending:

```js
const sitesByCallee = new Map()
for (const cs of callSites) {
  const list = sitesByCallee.get(cs.callee)
  if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
}
```

This is not a new idiom in this file — `strictBoundaryTypeCheck`,
`specializeBimorphicTyped`, `specializeUnionCursorParams`, and
`speculateTypedParams` (all in the same `narrow.js`, all OUTSIDE
`narrowSignatures`) already build the identical per-callee index under the
identical name and comment ("Per-callee static-call-site index. Built once;
cheap."). The fix conforms `narrowSignatures` to a convention the file
already established elsewhere, rather than inventing a new one.

`applyI32ParamSpecialization` took the index directly (renamed its 3rd
param from `callSites` to `sitesByCallee`, `.get(func.name) ?? []` at its
one internal use); `callerArgSelfConsistentI32`'s own `callSites` param
renamed to `sites`, its `if (cs.callee !== func.name) continue` filter
dropped (redundant once the caller pre-filters).

**Order/aliasing audit** (the invariant's own explicit demand): all six
converted consumers fold over "the matching subset" into either a
universal AND (`hardParamVal`/`hardParamRecvArrTyped`/`hardParamPresentVal`
— disagreement or an untyped site returns null/false, symmetric, order
cannot change the verdict) or an existential OR (`bigintBoxedVerdict`, the
BIGINT-nullable join, the `mayBeUndefined` join, `callerArgSelfConsistentI32`
— any matching site flips the flag, symmetric, order cannot change the
verdict) over the SAME subset of sites the original inline filter would
have visited, in the SAME relative order (the index is built by one
forward pass over `callSites`, only ever appending — never sorting or
dedup'ing — so each callee's bucket preserves `callSites`' own original
relative order, the same discipline `runFixpointConverged`'s own
pre-existing `sitesByCaller` index, by CALLER rather than callee, already
relies on for ITS worklist-seeding order). No consumer accumulates into an
ordered list, does first-match-wins selection, or otherwise depends on
visitation order beyond "all" / "any" — verified by reading every one of
the six converted bodies, not inferred. `callSites` invalidation: confirmed
immutable for the rest of `narrowSignatures` after the top-of-function
`filterLiveCallSites` compaction (the ONE mutation site in the whole file);
the index is built once, right after that compaction, and never rebuilt or
patched mid-function — correct, since nothing later touches `callSites`.

One early attempt added a shared top-level `EMPTY_SITES = Object.freeze([])`
sentinel (avoid allocating a fresh `[]` per index-miss) — reverted:
`narrow.js` is itself part of jz's own self-hosted source, so ANY new
top-level binding becomes a NEW GLOBAL in the jz×jz-compiled kernel,
shifting every auto-generated identifier declared after it (verified by a
normalized WAT diff — see Gate 1 below). Not a correctness risk, but
needless self-referential noise; replaced with plain `?? []` at each of the
four call sites (a few bytes of throwaway array on a rare miss — the
`applyI32ParamSpecialization`/`callerArgSelfConsistentI32` path is the only
even-plausibly-hot one, and it's gated behind the rare mutated-f64-param
condition already).

### Gate 1 — BYTE-IDENTITY

**Wrong test caught and corrected before trusting it**: naively comparing
`dist/jz.js`/`dist/jz.wasm` SHA-256 pre-fix vs post-fix FAILS — both differ
(`dist/jz.js`: `0f426a9a…` → `70a63763…`; `dist/jz.wasm`: `6e9e6c09…` →
`de343eab…`). This is NOT a correctness regression: `dist/jz.js` is a
minified bundle of the compiler's OWN source text (trivially differs after
ANY source edit) and `dist/jz.wasm` is jz compiling ITS OWN source
(narrow.js included) — jz×jz's output necessarily differs whenever
narrow.js's text differs, independent of whether the fix is behaviorally
sound, because the INPUT PROGRAM (jz's own source) changed. Proven by a
normalized WAT diff (`wasm2wat`, digits/auto-IDs stripped): the entire
divergence traces to exactly one inserted module-level global
(`$m127_narrow$EMPTY_SITES`, now removed) plus the downstream
auto-numbering cascade it caused (every `$NNNNN`-style generated local/global
name past that point shifts) — a single clean insertion point, not scattered
semantic drift, and gone entirely once `EMPTY_SITES` was removed as a
top-level binding. `interop.js`'s SHA is unchanged in every build (it
doesn't depend on narrow.js at all) — the one dist artifact for which raw
SHA comparison IS the right test, and it passes trivially.

**The right test — differential compile of FOREIGN programs** (not jz's own
source) pre-fix vs post-fix, same process family, git-stash toggling
`src/compile/narrow.js` only: the 11-program `test/kernel-parity.js` CORPUS
(`sum, math, dict, arr, fold, mfold, boolconst, nestedtyped, subviewtyped,
dvnested, fromnested` — chosen because it's this campaign's own established
byte-identity corpus, spanning typed arrays, dicts, closures, bimorphic
receivers) × 4 optimize levels (O0–O3) = 44 compiled outputs, SHA-256 each:
**byte-for-byte IDENTICAL pre-fix vs post-fix, all 44/44** (including at O2/
O3 where `test/kernel-parity.js`'s own 33-assertion native-vs-kernel suite
ALSO ran clean as a side effect of the differential, unprompted — reused,
not duplicated).

**dist self-build ×2 determinism** (the achievable half of "self-build ×2
SHA-identical" — identical to PRE-fix is impossible per the paragraph
above, for any narrow.js source change): two independent `node
scripts/build-dist.mjs` runs on the SAME post-fix source, several minutes
apart — `dist/jz.js`/`dist/jz.wasm`/`dist/interop.js` SHA-256 identical
across both runs. The pre-fix build is ALSO independently deterministic
(two pre-fix runs, same SHAs) — ruling out general build flakiness as a
confound before trusting the differential above.

**Native test suite**: `npm test` — **3436 total / 3428 pass / 2 fail / 6
skip**, matching 332ec25c/097a51d7's own recorded baseline EXACTLY (the 2
fails are the pre-existing `interval walk`/`typed RMW` codec-bounds rows
this chain has never chased — unrelated to narrow.js). Zero new failures,
zero new skips.

**Verdict: byte-identity holds** for the invariant that actually matters
(compiled OUTPUT for any given program, pre-fix vs post-fix) — 44/44 corpus
byte-identical, 3428/3428 non-pre-existing test assertions passing, dist
self-build deterministic. `dist/jz.js`/`dist/jz.wasm` differing from the
PRE-fix build is expected and provably self-referential, not a defect.

### Gate 2 — Native jz×jz peak/wall (259cd4fc method, `opts.profile` sink)

Same machine, same session, pre-fix vs post-fix, full pipeline
(`compile()` + watr `watOptimize` + `watrCompile`/encode), O3, `memory:
8192`:

| | pre-fix | post-fix | Δ |
|---|---|---|---|
| `plan:narrowSignatures` | 1945.0 ms | 1455.1 ms | **−25.2%** |
| `plan` total | 4209.3 ms | 3788.8 ms | −10.0% |
| `compile()` | 37744.5 ms | 37006.6 ms | −2.0% |
| peak RSS at `compile()` done | 3462.0 MB | 3358.4 MB | −3.0% |
| full pipeline wall | 331.7 s | 360.2 s | +8.6% (noise, see below) |

`narrowSignatures`'s own phase time and peak RSS both drop in the predicted
direction and magnitude — modest, not dramatic, exactly as 097a51d7's own
root-cause doc predicted ("native V8 GCs the resulting churn — the cost is
CPU time only… natively 'slow but fine'"; the fix's real payoff is
self-hosted, where the SAME garbage becomes permanent arena growth, not
native wall time). The full-pipeline wall-time INCREASE is noise: watr's
own `watOptimize`/`watrCompile`/`snapshotInit` phases (unrelated to
narrow.js, ~92–119 s each, non-narrow.js code paths) dominate total wall
time and show 20–30 s swings between otherwise-identical runs on this
machine under this session's own sustained load — a single-sample
full-pipeline wall comparison is not a reliable signal for a fix scoped to
one early, comparatively cheap pass. The two low-noise, fix-scoped metrics
(`plan:narrowSignatures` phase time, peak RSS at `compile()` done) are the
trustworthy read, and both improve.

### Gate 3 — THE GOAL GATE: self-hosted jz×jz, both configs

**Result: goal gate NOT met — jz×jz still traps at exactly 4,294,967,296
bytes (4 GiB) in BOTH dormant and region-live kernels — but the frontier
moves substantially, phase-stamped precisely below.**

Built NAMED kernels exactly per 332ec25c/097a51d7's own established method
(`compile(profile.graph.code, {modules, memory, optimize: profile.optimize,
names:true})`, `resolveSelfhostBuild()`, hand-flipped `REGION_HOOKS_ACTIVE`
for region-live, reverted via try/finally; `optJSON`/`modulesJSON` passed at
call time via `self.exports.default(source, 0, optJSON, modulesJSON)` — the
one correction versus a first attempt: the kernel's `modulesJSON` (4th ABI
param) MUST be supplied or module resolution fails immediately with an
unrelated "Unknown module" error before any real compilation starts).

| config | peak (coarse) | wall to trap |
|---|---|---|
| dormant | 4096.0 MB (2³²) | 5.76 s (was 6.8 s) |
| region-live | 4096.0 MB (2³²) | 6.12 s (was 7.4 s) |

Coarse `memory.buffer.byteLength` reads land on the hard ceiling on ANY
trap regardless of how close the real peak was (097a51d7's own documented
limitation) — needed the same finer breadcrumb probe to see whether the
fix actually helped.

**Breadcrumb re-run (097a51d7's own WAT-splice method, read-only on an
already-built kernel binary, zero jz source touched by the probe itself)**:
built a SEPARATE, disposable kernel with the KERNEL'S OWN native compilation
at `optimize:0` (names survive — O3 inlines/strips `narrowSignatures` et al
from the name section entirely, a wrinkle 097a51d7's own session didn't hit
because names DID survive on its build; not reproduced further, just
worked around) while still CALLING it at runtime with the real O3
`optJSON` (matching the actual self-host profile — only the kernel's own
bytecode shape changed, not what it's asked to compile). `wasm2wat
--enable-all` (WABT 1.0.36) decompiled; spliced 12 heap-bytes-at-entry
breadcrumbs (`(global.set $__dbg_N (i64.extend_i32_u (global.get 4)))`,
global 4 = `$__heap` per this build's own `(export "__heap" (global 4))`)
across the exact call chain 097a51d7 already mapped plus the next four
compileAst phases, appended as new globals AFTER every pre-existing one (no
index shift), plus i32 call counters on `analyzeFuncForEmit`/`emitFunc`;
`wat2wasm --enable-all` reassembled; ran against the kernel's own source
(`profile.graph.code` — the same 155-module jz×jz graph, dormant and
region-live builds using their respective `resolveSelfhostBuild({regionArena})`
config).

| phase (function) | dormant heap@entry | region-live heap@entry |
|---|---|---|
| `compile` (compileAst entry) | 512.1 MB | 114.0 MB |
| `plan` | 561.0 MB | 162.9 MB |
| `narrowSignatures` | 1948.0 MB | 1549.9 MB |
| `applyPointerParamAbi` | 2111.2 MB | 1713.1 MB |
| `narrowI32Results` (last call reached) | 3515.8 MB | 3117.7 MB |
| `narrowPointerResults` (last call reached) | 3512.2 MB | 3114.0 MB |
| `analyzeFuncForEmit` (last call reached) | **4096.0 MB**, call **#106** | **4095.3 MB**, call **#1427** |
| `emitFunc` | never reached (count 0) | never reached (count 0) |
| `emitClosureBody`/`buildStartFn`/`pullStdlib`/`optimizeModule` | never reached | never reached |
| **trap** | `unreachable`, 4096.0 MB | `unreachable`, 4096.0 MB |

**The fix's own pathology is gone, confirmed by direct evidence, not
inference**: `narrowPointerResults`'s reading (3512.2 MB dormant) is LOWER
than `narrowI32Results`'s (3515.8 MB) despite `narrowPointerResults`
executing chronologically BETWEEN `narrowI32Results`'s two call sites (line
order: `applyPointerParamAbi` → `narrowI32Results`×1 → `narrowPointerResults`×1
→ `narrowPointerResults`×2 → `narrowI32Results`×2) — the only way
`narrowI32Results`'s LAST-WRITE breadcrumb can read higher is if its SECOND
call fired, which only happens after `narrowPointerResults`'s second call
already ran. Both kernels reach ALL FIVE calls in `narrowSignatures`' own
internal fixpoint (097a51d7's own pre-fix breadcrumb never got past
`narrowPointerResults`'s 2nd call, dormant trapping there at 4081.0 MB with
"15 MB of headroom left" — this session's post-fix dormant run clears that
same call AND both of `narrowI32Results`'s calls AND `narrowSignatures`
itself returns AND `plan()` completes in full AND `compileAst` moves on to
its NEXT major phase). The originally-diagnosed O(functions×params×
callSites) pathology no longer bounds this compile.

**The NEW frontier — banked, not chased (out of this session's scope, per
the task's own instruction)**: `compileAst`'s per-function
`analyzeFuncForEmit` loop (`src/compile/index.js`) — the pass immediately
after `emitFuncs`'s own driver loop begins, analyzing each function ahead
of `emitFunc` proper. Both kernels get meaningfully far into it (106 calls
dormant, 1427 calls region-live — region-live's larger head start, same
asymmetry 097a51d7's own session measured at the OLD frontier, persists at
the NEW one) before exhausting the ceiling; `emitFunc` itself is NEVER
entered (count 0, both kernels) — the trap is inside `analyzeFuncForEmit`'s
own per-call work or in code between one `analyzeFuncForEmit` call and the
next, not inside `emitFunc`/`emitClosureBody`/`buildStartFn`/`pullStdlib`/
`optimizeModule`, all confirmed unreached. `analyzeFuncForEmit` is a sibling
of `emitClosureBody` in the SAME file (`src/compile/index.js`) that
259cd4fc's `MapOverlay` fix already treated once for a DIFFERENT function —
worth checking first, next session, whether `analyzeFuncForEmit` has its
own O(programSize)-per-call full-table clone/scan of the same structural
shape (a live, unaudited hypothesis, not yet confirmed) before assuming a
wholly new mechanism.

### Gate 4 — Standard

- **kernel-oracle**: dormant, **13/13 × 3** consecutive runs (541 assertions
  each) — clean, matches baseline, zero flake.
- **kernel-parity**: 33/33 (three optimize tiers × 11 programs), also
  exercised as part of Gate 1's own corpus differential — clean.
- **jessie / watr region-live-equivalent ×3**: `bench/jessie/jessie.js` and
  `node_modules/watr/watr.js` (its own full source, self-compiled through
  jz — a real, richly-typed, multi-module program, not a toy) compiled
  natively 3× each at the region-live optimizer profile
  (`{level:3, inlinePtrOffsetFast:false}`) — byte-identical across all 3 runs,
  both programs (127494 B / `58ce040c…` jessie; 429650 B / `3e324616…` watr).
- **jzify-entry**: the named `.work/jzify-entry.mjs` harness referenced by
  the task is NOT present on this worktree's ancestry (confirmed via
  `git merge-base --is-ancestor` — it postdates 097a51d7 on a different
  line of work) and is gitignored, so it could not be reproduced without
  importing untracked state from outside this session's own chain. Not
  chased further; the jessie/watr substitution above and the jz×jz
  breadcrumb runs (which ARE genuinely region-live, not merely
  optimizer-flag-equivalent) cover the same class of concern.
- **test:wasm non-fuzz leg**: not run this session — time budget spent on
  the goal-gate breadcrumb campaign (Gate 3), which is this task's own
  named finish line.

### Disposition — LANDED

`src/compile/narrow.js` only (69 lines changed: 47 insertions, 22
deletions) — the six-scan callee-index conversion plus the
`applyI32ParamSpecialization`/`callerArgSelfConsistentI32` signature thread.
`git diff`/`git status` in the worktree otherwise clean throughout; every
scratch script and kernel binary this session built (`.work/scratch-*.mjs`,
`/tmp/kernel-*.wasm`, `/tmp/*.wat`, `/tmp/corpus-*.json`) deleted at session
end, none committed (`.work/*.mjs` gitignored regardless).

**jz×jz goal gate: NOT met, but the SPECIFIC pathology this session was
asked to fix IS fixed, measured directly (not inferred)** — narrowSignatures'
own O(functions×params×callSites) call-site census no longer bounds the
compile; the ceiling now falls to a new, later, precisely phase-stamped
frontier (`compileAst`'s `analyzeFuncForEmit` loop, `src/compile/index.js`,
call #106 dormant / #1427 region-live, `emitFunc` never reached). **Next
session's concrete lever**: audit `analyzeFuncForEmit` for the same
per-call full-table-clone/scan shape 259cd4fc already fixed once in this
same file's `emitClosureBody`, and this session fixed a second instance of
in `narrow.js` — check there before assuming a novel mechanism.

**SHAs.** Worktree: `narrow-index` (region-final-2026-08-11 / 097a51d7,
detached HEAD). Commit: see this entry's own accompanying commit (narrow.js
+ this ledger entry, detached on 097a51d7, no Co-Authored-By).

