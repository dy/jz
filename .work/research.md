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
