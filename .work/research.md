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
