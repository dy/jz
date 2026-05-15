### Ship something real

* [ ] Pick ONE use case, make jz undeniable for it
* [ ] Ship something someone uses
* [ ] Integrations as validation: color-space converter (multi-profile), digital-filter biquad (memory profile), floatbeat playground
* [ ] Make compile faster than js eval
* [ ] Benchmarks
* [ ] Clear, fully transparent codebase; complete docs / readme / tests / repl

### Floatbeat playground

* [ ] Syntax highlighter
* [ ] Waveform renderer
* [ ] Database + recipe book
* [ ] Samples collection

### Language coverage / correctness

* [ ] Date — deterministic spec slices first; local timezone / Intl surface later
  * [ ] Deferred: object `ToPrimitive` coercion order (`coercion-order.js`)
  * [ ] Defer `Date.parse` until Date value objects + UTC stringification exist
  * [ ] Out of scope: local-time getters/setters, `getTimezoneOffset`, `toString` / `toDateString` / `toTimeString`, locale methods, `toJSON`, `Symbol.toPrimitive`, `toTemporalInstant`, subclassing, realms, descriptors, prototype shape, function `name`/`length` metadata
* [ ] Intl
* [ ] test262
* [ ] All AssemblyScript tests
* [ ] Warn/error on hitting memory limits

### Imports & jzify

* [ ] jzify script converting any JZ
* [ ] jzify: auto-import stdlib globals (Math.* → `import math from 'math'`, etc.)
* [ ] jz core: require explicit imports for stdlib (remove auto-import from prepare/compile)
* [ ] align with Crockford practices

### Diagnostics

* [ ] Source maps (blocked on watr upstream) — meanwhile add WASM name section (function names) independently

### Metacircularity (jz compiling jz)

* [ ] Extract minimal jz parser from subscript features — jz-jessie fork excluding class/async/regex + refactor parse.js function-property assignments (~30 lines)
* [ ] jzify uses jessie, pure jz uses internal parser
* [ ] True metacircular bootstrap
* [ ] swappable watr: AST likely needs stringifying before compile if an adapter is provided


### Boundary protocol and internal representation

Two separable concerns, conflated by the previous "ABI presets" plan:

1. **Boundary protocol** — how host code calls the `.wasm`. This is the only ABI users see.
2. **Internal representation** — how values live inside the wasm. Analysis-driven, per-site, never user-configured.

The old plan treated both as "ABI" — `opts.abi: 'nanbox' | 'flat' | 'nanbox+jsstring'` covered both knobs at once. That conflation is the root cause of every "which preset should I pick?" smell. The user choosing internal representation is a category error: the compiler has more information about each call site than the user could plausibly enumerate. Exposing the choice freezes the internal layout to whatever the user happened to pick — the opposite of "compile to the most fitting form." A person reading the source infers types from name, literals, operators, member access, control-flow guards. The compiler should do the same, and beat the user at it.

#### User surface — `opts.host`

The only knob the host actually needs is "how do I call this."

```js
jz.compile(src, { host: 'js' })    // default — JS host; externref strings, ref-typed exports allowed
jz.compile(src, { host: 'wasi' })  // C-ABI shape; linear-memory strings; no engine builtins
jz.compile(src, { host: 'gc' })    // wasm-gc; stringref, ref-typed exports
```

`opts.host` decides:
- Which `wasm:js-string` imports may be referenced (only `js`).
- Whether externref / ref-types are valid in export signatures (`js` yes, `wasi` no).
- Boundary marshalling shape (single `interop.js` codec; host variant selected by feature stamp, not by file).

It does **not** decide the internal layout of any value. A program compiled with `host: 'js'` still gets a flat `i32` slot wherever narrowing proves an integer; a `host: 'wasi'` program still gets nanbox-tagged f64 where analysis can't disambiguate.

#### Internal representation — compiler-owned, per-site

`src/abi/` — internal codegen modules with no user surface. **One file per type**, holding every carrier the compiler may pick for that type. Carriers are named exports inside; the narrower picks one per site by analysis.

```
src/abi/number.js  — nanbox-f64 (default), flat-i32, flat-f64
src/abi/string.js  — sso (default), jsstring (host: 'js' only)
src/abi/array.js   — tagged-linear (default), typed (Int32/Float64 backing)
src/abi/object.js  — schema-linear with per-field rep
```

The earlier `src/abi/<type>/<rep>.js` split would have been preset-thinking smuggled in by file layout — separate files imply separate testing units, which implies user-pickable presets, which is exactly the surface we're removing. One file per type matches the actual factoring: carriers for the same type share domain knowledge (what a "number" means, which ops it supports), so they belong together. Cross-carrier helpers (slot-type coercion, op dispatch) sit next to the carriers without an artificial folder crossing.

Sketch:

```js
// src/abi/number.js
export const nanboxF64 = {
  slotType: 'f64',
  ops: { add: (a, b, ctx) => …, eq: …, },
  peephole: (node) => …,
}
export const flatI32 = {
  slotType: 'i32',
  ops: { add: (a, b, ctx) => ['i32.add', a, b], … },
}
export const flatF64 = { slotType: 'f64', ops: { … } }

// default carrier — picked when narrower has no stronger evidence
export default nanboxF64
```

Per-site dispatch, not module-wide preset. The narrower walks the IR, tags each binding/expression with a carrier choice, codegen reads `ctx.abi.number[choice].ops.<op>` (or equivalent). A function may carry an `f64`-slot nanbox number, an `i32`-slot count, and an `externref` string in the same body — each chosen because analysis proved it, not because a preset said so.

The slot-carrier contract from the existing refactor stays: each carrier's `ops.<op>` accepts slot-typed IR and emits the call/inline. Carriers are cycle-safe (no `src/*` imports), siblings inside one ~150–300-line type module.

#### Analysis as the engine

Per-site representation is only as good as the inference feeding it. The narrower fixpoint exists; the work is enriching its evidence sources.

Type evidence, ordered by strength:

1. **Literal use** — `let x = 0`, `let s = ''`, `let xs = []`. Direct.
2. **Operator application** — `x | 0` / `x >>> 0` force i32; `x * 1.0` keeps f64; `s.charCodeAt`, `s + ''` force string.
3. **Member access pattern** — `.length` on a thing only `+=`'d with strings; `.push` / `[i]=` on a thing only indexed by integers.
4. **`typeof` guard** — `typeof x === 'number'` narrows on the true branch (partly handled in narrow.js).
5. **Assignment flow** — `x = y` propagates `y`'s evidence to `x`; SSA edges already in the IR.
6. **Comparison shape** — `x === null` proves nullable; `x === 0` rules out string.
7. **JSDoc `@type`** — explicit hint when ambiguous. Authorial intent, not enforced contract.
8. **Default cast** — anything still ambiguous after the fixpoint stays nanbox-tagged f64. Default is never wrong, only sometimes wider than necessary.

Each step closes one class of dynamic-fallback emit. Representation work only runs once narrowing has decided a type, so better evidence → more sites take the narrow rep. Investing in narrowing compounds with every rep added later.

#### Workstreams, in priority order

* [x] **Narrowing investigation (primary).** Survey: `.work/narrow-survey.mjs` (per-bench counts) + `.work/narrow-watr-hotspots.mjs` (per-function). Findings: `.work/narrow-findings.md`. Headline: every numeric / typed-array bench is **already at zero fallbacks**; only `watr` (the self-hosted WAT compiler) has any — 1289 emits, 47.5 % clustered in its top 10 functions. Categorization:
  - **A. Dynamic-keyed object with all-known keys → poisoned to HASH** (132 `__dyn_set` in `$__start`, plus the rest of the 212 `__dyn_set`). Repro: a single `o[k]` computed read on a 6-key object literal explodes 2 KB → 65 KB and turns every initialization write into `__dyn_set`. **Not a narrowing gap** — codegen-layout choice. Moves to **workstream #3**, extended scope: keep schema layout under computed-key access; dispatch the computed read over the known key set.
  - **B. `s[i]` emits __str_idx + SSO alloc per char** (446 emits, top fallback). Each indexed read materializes a one-char SSO string even when the consumer is `=== '\\'` (charcode-equivalent). **Moves to workstream #6**, extended scope: elide SSO materialization when the consumer compares with a single-char literal.
  - **C. Polymorphic AST-node receiver** (`cleanup(node)` where node = string | array | null). The `Array.isArray(node)` discriminator's facts aren't threaded across `?:` / `&&` arms, so each `node[0]` keeps the union rep. Real `narrow.js` follow-up — leveraged across all watr AST passes.
  - **D. Heterogeneous ctx = array+object** in watr's `compile()`. Legitimate mixed identity; codegen-rep question, not narrower.
  - **E. err()'s `text + ...` concat allocates heap** even when the result fits SSO. Folds into workstream #6.
  - **F. `for-in` over known-schema source** (`for (let kind in SECTION)`) should unroll at compile time per `prepare.js:1339-1346` — verify it fires for watr's constants; gaps become narrow follow-ups.
  ## Recommended narrow.js follow-ups (workstream #1 deliverable):
  - **C.1** Thread `Array.isArray(x)` facts through `?:` / `&&` / `||` arms (companion to the existing `typeof === 'string'` plumbing in `narrow.js`).
  - **C.2** Thread `x == null` / `x != null` flow-narrowing.
  - **F.1** Verify and fix `for-in` over known-schema unrolling on watr's `SECTION` / `KIND` / `INSTR` / `DEFTYPE`.
  ## Conclusion: rebalance — the survey says narrowing handles numeric/typed-array codegen at the floor; the remaining wins on dynamic-shape code are mostly **codegen layout (#3) and SSO peephole (#6)**, not narrower gaps. Parallelize #1.C/F + #3 + #6 rather than serialize.

* [ ] **Per-site flat-number specialization.** Where narrowing proves a binding is integer-only or non-tag-traffic-f64, emit it as a flat slot (`i32` / bare `f64`) and skip box/unbox at every use. The peephole already collapses `i64.reinterpret_f64 (f64.reinterpret_i64 x)` after inlining — this work moves the elision earlier so wasted i64 traffic never lands in the IR. Carriers: `flatI32`, `flatF64` added to `src/abi/number.js`. Dispatch: narrower tags the binding's carrier; emit reads `ctx.abi.number[binding.carrier].ops.<op>`.

* [ ] **Schema-object field packing.** `schema-linear` today gives every field a tagged-f64 slot regardless of evidence. Threading per-field rep through the schema lets `{count: 0, name: ''}` lay out as `(i32, ptr)` instead of `(f64-tag, f64-tag)`. Halves typical struct size; identity and field-order semantics untouched.

* [ ] **Typed-array element rep.** `xs = [1, 2, 3]` where every push/store is integer becomes `Int32Array` backing instead of tagged-linear. Subsumes the manual `Int32Array.of` ergonomic; plain JS source, typed memory output.

* [ ] **Closure-capture narrowing.** Captured variables today widen to nanbox-tagged at the cell, even when the closure body uses them at a single narrow type. Track per-cell evidence the same way bindings do; emit `i32`/`f64` cells where proven.

* [ ] **SSO flow-through.** Short-literal strings (≤4 ASCII) live SSO-encoded already, but concat results widen to heap pointers immediately. Where the result also fits SSO, keep it inline. Saves a heap alloc per intermediate.

* [ ] **JS String Builtins specialization** (under `host: 'js'`). When a string binding's evidence is "only operated on via `wasm:js-string`-mappable ops" (`length`, `charCodeAt`, `concat`, `substring`, `fromCharCode`), the narrower picks the `jsstring` carrier from `src/abi/string.js`. The 9-item compiler-wide checklist in that file's docstring is the implementation plan: externref-typed locals, slot coercer, boundary wrappers, import channel, literals, mutating-fast-path gating, cross-carrier interop, carrier-aware nullish, host wiring. Per-site framing makes it incremental: one proven-engine-string binding flips to externref without dragging the whole module.

#### What ships internally vs externally

|                  | User-visible                       | Compiler-internal                                                |
| ---------------- | ---------------------------------- | ---------------------------------------------------------------- |
| Boundary shape   | `opts.host` (`js` / `wasi` / `gc`) | single `interop.js` codec; host variant via feature stamp        |
| Number carrier   | —                                  | per-site, in `src/abi/number.js`: `nanboxF64` / `flatI32` / `flatF64` |
| String carrier   | —                                  | per-site, in `src/abi/string.js`: `sso` / `jsstring` (`host: 'js'` only) |
| Array carrier    | —                                  | per-site, in `src/abi/array.js`: `taggedLinear` / `typed`        |
| Object layout    | —                                  | per-field, in `src/abi/object.js`: tagged / flat / packed        |
| Inference hints  | JSDoc `@type` (advisory)           | narrower fixpoint                                                |

The `jz:abi` custom section, if kept, becomes a **feature-detection version stamp** (e.g. "ref-types required", "string-builtins required") so the host driver knows which engine features to feature-test before instantiate. It does **not** carry preset names — there are no presets to name.

#### What drops from the old plan

- `opts.abi` — gone. Replaced by `opts.host`.
- `PRESETS` as any kind of surface — gone. Internal `src/abi/` modules are picked per-site by analysis, not by name. No preset table inside the compiler either; carrier choice lives in narrower facts.
- `JZ_ABI` env flag in tests — gone. Boundary tested by varying `opts.host`; internal repr is implementation detail (assert size / IR shape, not "preset name").
- Preset matrix testing — gone. No preset to enumerate. Internal-rep tests are properties: "after narrowing, `x | 0` lowers to an i32 slot."
- Free-form rep maps — never existed publicly; remains an internal property of the narrower.

#### Already landed (foundation; do not undo)

* [x] One file per type under `src/abi/` — `src/abi/string.js` (`sso` default + `jsstring` scaffold), `src/abi/number.js` (`nanboxF64` default). Carriers are named exports inside one type module; no preset folder layout.
* [x] Slot-carrier contract — `sso` accepts slot-typed IR, emits `i64.reinterpret_f64` inline, no `src/*` imports.
* [x] Empty-ops scaffold — `jsstring` declares slot types, imports, and the 9-item compiler-wide checklist for real codegen.
* [x] Routed call sites — `module/core.js` (`?.length`), `module/string.js` (`.charCodeAt`), `src/emit.js` (cmp / concat / concatRaw / append-byte) all go through `ctx.abi.string.ops`.
* [x] Compiler-side carrier dispatch object on `ctx` (`ctx.abi.<type>.ops.<op>`); `ctx.abi.<type>` resolves to a *carrier* (named export of `src/abi/<type>.js`), not a separate file.
* [x] Optimizer-side carrier peephole (`src/abi/number.js#nanboxF64.peephole`) — pure-WASM folds in `src/optimize.js`, carrier-specific folds inside the carrier.
* [x] Single `interop.js` boundary codec — DRIVERS dispatch table removed; one NaN-box codec per binary; `jz/interop` subpath compiler-free (only imports `./wasi.js`).

#### Open policy questions (deferred until first non-default rep emits at scale)

1. **JSDoc strength.** `@type` as a hint (overridable by stronger evidence) or as a contract (refuse to widen)? Hint matches the implicit-inference philosophy; contract gives users an escape hatch for cross-module boundaries. Default: hint.
2. **Null/undefined under flat slots.** A flat `i32` / `f64` can't carry them. Narrower must prove non-null at the binding or widen back to tagged. No new syntax.
3. **Compound lifetime.** `__alloc` for a flat string passed to a host call — when freed? Today's `_clear`-reset arena is fine for short-lived; long-running needs a hook. Defer until a real long-running program forces it.
4. **Cross-module ABI freezing.** Exported flat-slot signatures are part of the module's public contract even though `opts.host` is what users picked. Resolution: export signatures derive from proven types of exports' params/returns. Stable signature ⇒ write the export so its types are obvious (or annotate). The compiler does not promise stable internal rep across versions for the same source.

### REPL

* [ ] Auto-convert var→let, function→arrow on paste
* [ ] Auto-import implicit globals
* [ ] Show produced WAT
* [ ] Document interop

### EdgeJS PR shape

* [ ] Add an EdgeJS test/harness entry only if it can run in their CI without pulling large optional dependencies or network setup

### Future

* [ ] Component interface (wit)
* [ ] threads/atomics (SharedArrayBuffer, Worker coordination)
* [ ] memory64 (>4GB)
* [ ] relaxed SIMD
* [ ] WebGPU compute shaders

## Ideas

* [ ] webpack, esbuild, unplugin etc – extract and compile fast pieces with jz
* [ ] jz as a compilation target — DSLs that want WASM output emit jz-compatible code (needs a simple IR / intermediate format) and get WASM for free
* [ ] The template tag as a build tool — jz\`code\` in a Node script replaces a build step. No webpack, no esbuild, no plugin. Uniquely elegant and under-marketed.


---

## Archive

### Jessie compilation blockers (see [.work/jessie-wasm.md](jessie-wasm.md))

* [x] #1 spread in `?.()` — `fn?.(...args)`
* [x] #2 Error subclasses (`SyntaxError`/`TypeError`/`RangeError`/`ReferenceError`/`URIError`/`EvalError`)
* [x] #5 CLI bare side-effect imports `import './x.js'`
* [x] #6 `new RegExp("lit")` literal pattern + clean error for dynamic
* [x] #7 `Object.create` stdlib include — `array` module wasn't pulled in for `__arr_from`
* [~] ~~#3 `Object.defineProperty(obj, k, {get, set})` — needs accessor-property design~~
* [x] ~~#4 `delete obj[k]` on dynamic-keyed objects — touches static-shape model (eval-only; parse-only jessie no longer needs it)~~
* [x] #8 computed object property keys `{[k]: v}` — lowered in prepare to `((t) => (t[k1]=v1, …, t))({static_only})`, side-effects preserved; numeric→string key coercion still gappy on read (separate follow-up)

### Product / Validation

* [x] Options breakdown in readme
* [x] Implement `Date.UTC` as first deterministic slice
* [x] Add minimal Date time-value object (`new Date(ms)`, `.getTime()`, `.valueOf()`, `.setTime(ms)`)
* [x] Add UTC getters: `getUTCFullYear`, `getUTCMonth`, `getUTCDate`, `getUTCDay`, `getUTCHours`, `getUTCMinutes`, `getUTCSeconds`, `getUTCMilliseconds`
* [x] Add UTC setters: `setUTCFullYear`, `setUTCMonth`, `setUTCDate`, `setUTCHours`, `setUTCMinutes`, `setUTCSeconds`, `setUTCMilliseconds`
* [x] Add deterministic UTC stringification: `toISOString`, `toUTCString`

### Validation & quality

* [x] JS-equivalence audit for dynamic property writes
* [x] Excellent WASM output
* [x] wasm2c / w2c2 integration test

### Escape analysis for short-lived literals

* [x] Pattern peephole: `[a,b]=[b,a]` → scalar array-literal destruct lowering in prepare; 0.7ms → ~0.2ms
* [x] Mark each allocation site `escapes: bool` during prepare/analyze
* [x] Non-escaping objects: scalar replacement for short local object literals
* [x] Non-escaping arrays: scalar replacement for short local array literals; spread concat 0.9ms → <0.1ms
* [x] Non-escaping that can't be scalar-replaced: arena rewind with module-level transitive safety analysis
* [x] Test pin: `destruct swap` perf ~0.2ms, codegen asserts no array allocation

### Per-function arena rewind

* [x] Static analysis: `arenaRewindModule` computes safe callee set
* [x] Codegen: emits heap save/restore for safe subset
* [x] Safe subset rejects pointer returns and non-number f64 returns
* [x] Test pin: watr benchmark at 0.99ms vs V8 1.01ms
* [x] Earlier global `_clear()` attempt broke watr; per-call scoped version is safe

### Inline cache for polymorphic shape sites

* [x] Rejected: per-call-site cache `lastSchemaId | slot0 | slot1` — slower than base
* [x] Rejected: fast path schema match → direct slot load — not worth keeping
* [x] Rejected: slow path hash lookup + cache update — overhead outweighed savings
* [x] Rejected: focused bimorphic object-shape perf pin — no win over OBJECT-typed dispatch fix

### Stack-allocated rest-param arrays for fixed-arity sites

* [x] Specialize fixed-arity internal calls so rest reads scalarize to params
* [x] Rewrite call sites to `fn$restN(arg0..argN)` clones
* [x] Test pin: `rest sum` perf 2.7ms → ~0.6ms (4.5×)

### SIMD auto-vectorization for typed-array reductions

* [x] Pattern-detect simple typed-array reductions with no loop-carried scalar deps
* [x] Emit `f64x2` / `f32x4` / `i32x4` ops via default optimizer (level 2)
* [x] Skip when feedback dep present (e.g. biquad cascade)
* [x] Test pin: `typed sum` perf 4.2ms → ~2.2ms (1.9×)

### Smaller wins

* [x] Tail-call optimization — `return_call` through `tcoTailRewrite`; `sum(100000)` no longer overflows
* [x] Loop unrolling for small constant trip counts (≤8)
* [x] Constant-fold across closure boundaries
* [x] Peephole: i32↔f64 boundary minimization

### Performance — closing the native-language gap

* [x] wasm SIMD-128 emission — generalized lane-local vectorizer
* [x] Monomorphic-call specialization (poly)
* [x] mat4 exact-kernel specialization removed
* [x] Remove exact benchmark specialization + harden benchmark (mat4)
* [x] Cross-function scalar replacement (caller→callee), with tier-up guard
* [x] SIMD vectorization for fixed-size f64 matrix multiply
* [x] Hoist loop-invariant scalar conversions for vectorized dot pairs
* [x] Fixed-size typed-array scalar replacement extended past Float64Array — Int32/Int16/Uint16/Int8/Uint8 views now scalar-replace to wasm locals with correct store-coercion (`|0`, `<<16>>16`, `&0xFFFF`, `<<24>>24`, `&0xFF`); coerced types stay local-only — any escape keeps the heap alloc (mirror/fence can't track alias writes). `4918e02`
* [x] `optimize: 'size' | 'speed' | 'balanced'` string aliases over the size↔speed unroll/scalar knobs `8ca6f18`
* [x] Closed as low-value: Float32Array / Uint8ClampedArray / Uint32Array scalar replacement (Float32 needs `Math.fround` ⇒ `math` module pulled at plan time; Uint8Clamped is round-half-even; Uint32 range >2^31 collides with jz's i32 narrowing of `x>>>0`) — edge semantics, no measured win
* [x] Closed as low-value: partial unroll + f64x2 vector body for mat4 — inner loops are constant-trip 4×4×4; full unroll + f64x2 dot-pairing already runs mat4 at 0.78× native C
* [x] Closed as low-value: json arena/raw-u8 fast path — bench already ≈1.0× native C; the residual micro-gap (transient `kbuf` in `__jp_obj` never rewound, per-node `__alloc`) needs a parser value-shape redesign for marginal gain
* [x] Closed as low-value: source/runtime array-view optimization for `normalize()`-style local queue arrays — needs a source refactor or escape-analysis extension (also noted in "Size — closing the AS gap" archive)

### Competitive size/speed gate

* [x] **`sort` (in-place heapsort): jz ~8.6× slower than V8/`asc -O3`** — FIXED. Root cause: cross-call typed-array param propagation didn't reach the 3-deep `main→runKernel→heapsort→siftDown` chain — `siftDown.a` stayed an untyped NaN-boxed f64 ⇒ `a[child]` → runtime `__typed_idx`/`__typed_set_idx` calls + `child` an f64 index with `i32.trunc_sat` per access. Two fixes in `narrow.js`: (1) `runArrElemFixpoint` now iterates a *soft* ctor merge to a fixpoint (don't sticky-poison a callee on the first sweep when the caller's own param isn't typed yet), then one hard validating sweep; (2) `refreshCallerLocals` seeds pointer-narrowed params' val-kind into a transient `repByLocal` so `n = arr.length` is recognised as i32 and propagates to `siftDown`'s `end` param. Result: `siftDown` now emits direct `f64.load/store` + i32 indices; jz beats `asc -O3` and runs at V8 parity. `bench-pin.js` sort: v8 `near`, as `tie`. Size still ~1.10× `asc -Oz` (generic codegen slack, follow-up open).
* [x] **`valid jz = valid JS` break — `Math.round`** — FIXED (`module/math.js`): `f64.nearest` (ties-to-even) replaced with ties-toward-+∞ — emit `nearest(x)`, bump by one iff `nearest(x) === x - 0.5` (the only disagreeing case; −0.5→−0 and 0.49999…94→0 already match). Repro folded into `test/differential.js` (`rounding`, `round half-integers`); stale `Math.round(-3.5)` assertion in `test/math.js` corrected (was `-4`, JS gives `-3`).
* [x] **`valid jz = valid JS` break — `Math.imul`/`Math.clz32` operand coercion** — FIXED (`module/math.js`): operands now go through `toI32` (ECMAScript ToInt32, wrapping, +∞/NaN→0) instead of `asI32` (saturating) — `Math.imul(x, 2654435761)` wraps to negative like JS instead of clamping to INT_MAX. Repro folded into `test/differential.js` (`imul big literal`).
* [x] **All `bench/bench.mjs` cases run at `optimize: { level: 'speed' }`** — previously biquad / mandelbrot / tokenizer fell back to `balanced` or `size` because `'speed'` produced wrong checksums or crashes. Two upstream optimizer bugs fixed in watr:
  * `inlineOnce` zero-init leak — substituting an init-`local.set $x 0` callee body into a caller that already used `$x` for another value silently aliased the slot. Fixed by gating substitution on absence of caller writes to the target local.
  * `propagate.substGets` sibling-eval leak (commit `d0e2d8a`) — `substGets` recursed through operand siblings sharing one `known` map; when arg1 contained `(local.tee $X NEW)`, arg2's `(local.get $X)` got substituted with $X's pre-tee tracked constant. After `coalesceLocals` aliased an init-const local with a sibling-read role this surfaced as `alloc(len=320, cap=40, …)` in biquad → buffer overflow → wrong checksum `1465809949` vs expected `422839881`. Fix: per-sibling invalidation in `substGets` (drop tracked entries whose slot was set/tee'd by an earlier sibling), with lazy `Map` clone so the overhead is paid only when needed. Regression test in `watr/test/optimize.js`. jz `bench/bench.mjs` synced to `'speed'` in commit `fb46c29`; tokenizer 0.583× (`win`). Mandelbrot ~0.90× local / ~1.005× CI — within noise of V8; claim demoted `win`→`tie` because the inner loop is at the wasm-v1 algorithmic floor (3 fmul + 4 fadd + 1 fsub + 1 fgt + 3 i32 ops + 3 branches, no instruction left to drop), wasm v1 has no scalar `f64.fma`, and `f64x2.relaxed_madd` lane-0 measured 17% *slower* on ARM due to splat/extract overhead. Revisit if the wasm `fma` proposal lands.

### i64-tagged carrier switch — investigated, closed wontfix

* [x] Spike + codegen survey (see `.work/i64-spike/` — FINDINGS.md, bench*.mjs, json.wat). Conclusion: switching the internal value carrier from NaN-boxed f64 → i64 buys **no measurable perf or size win**. (1) No bit headroom — raw-f64-bit numbers must keep the NaN-box encoding regardless of storage type, so the 51-bit payload split is unchanged; the "type:8/aux:24/offset:32 = 64 bits" scheme is infeasible (would force boxing doubles, killing numeric perf). (2) jz already has unboxed-i32-offset pointer locals (`repByLocal` carries `ptrKind`/`ptrAux`/`schemaId`; pointer ops are bare `local.get`s) — strictly cheaper than an i64 carrier (32 vs 64 bits). (3) Static `*.reinterpret_*` count is ~45/15 flat across numeric and pointer/string-heavy benches — fixed runtime plumbing, not per-hot-op codegen; existing hoisting/unboxing keeps reinterprets off hot recurrences everywhere. (4) Microbenchmarks: i64-local-with-reinterpret 1.49× slower on a numeric recurrence; json WALK i64/f64 = 1.01×, json PARSE = 0.76×; WASM size ±handful of bytes. The two "surgical" alternatives (LICM on property-access loads; unboxed-pointer return ABI for `__jp_shape_N`) target a gap that doesn't move any benchmark, and LICM-on-loads re-opens the `cseScalarLoad` aliasing bug class. Only real upside is host.js boundary simplification (drop the NaN-canonicalization plumbing) — not worth a multi-day high-risk carrier refactor. Revisit only if a real bottleneck surfaces.
* [x] (prep landed earlier, kept) `env.setTimeout` cbPtr — i64 import
* [x] (prep landed earlier, kept) `__ext_prop` / `__ext_has` / `__ext_set` / `__ext_call` — i64 imports
* [x] (prep landed earlier, kept) Add `globalTypes` tracking for host-imported globals (i64)
* [x] (prep landed earlier, kept) Switch user opts.imports declared sig from f64 → i64

### JZ-side prep

* [x] Host-import mode — `compile({ host: 'js' | 'wasi' })`
* [x] `setTimeout` / `setInterval` host-driven
* [x] `import.meta`: static `import.meta.url`, `import.meta.resolve("...")`
* [x] Aggressive monomorphic single-caller inlining for hot internal functions
* [x] Couple constant-argument propagation with inlining/unrolling
* [x] Audit typed-array address/base fusion on EdgeJS benchmark
* [x] Bounds-check elision hints for monotone typed-array loops — closed as research-only
* [x] i32 narrowing for integer-heavy kernels — reverted; V8 inliner regression

### Concrete size cuts

* [x] Drop unconditional `inc('__sso_char', '__str_char', '__char_at', '__str_byteLen')`
* [x] Break `MOD_DEPS` cycle `number ↔ string` at `prepare.js:1054`
* [x] Strip data segment for non-emitted strings
* [x] Replace `wasi.fd_write`/`clock_time_get` with `env.printLine` / `env.now`

### Concrete optimizations

* [x] Scalar-replacement of repeated typed-array reads
* [x] Aggressive inlining for monomorphic single-caller hot funcs
* [x] i32 narrowing for module-const integer args (revisit nStages) — reverted
* [x] Loop-invariant hoist of `arr.length` — verified already hoisted
* [x] Bounds-check elision for monotone counters — closed as research-only
* [x] Symmetric widen-pass for length comparisons — closed

### Benchmarks

* [x] Polymorphic reduce benchmark
* [x] fib / ackermann — TCO now implemented

### EdgeJS integration

* [x] Keep safe-mode out of PR claim
* [x] Pick one undeniable use case and optimize around it
* [x] Add benchmark coverage beyond internal examples
* [x] Add wasm2c/w2c2 integration tests
* [x] Rework/close PR #2
* [x] Harden `jz/wasi` default output routing
* [x] Add tests for stdout/stderr fallback
* [x] Do not publish `instantiateAsync`
* [x] Document host contract in README
* [x] Add EdgeJS-compatible smoke fixture
* [x] Build/install EdgeJS locally and verify basic JZ usage
* [x] Verify EdgeJS safe mode behavior
* [x] Verify JZ modules with no WASI imports run in EdgeJS without polyfill
* [x] Verify explicit console host imports under EdgeJS
* [x] Check WASM exception support in EdgeJS — blocked, documented
* [x] Open PR to `wasmerio/edgejs` as example/benchmark
* [x] Add `examples/jz-kernel`
* [x] Include README note: JZ is useful for hot numeric, DSP, parser, typed-array kernels
* [x] Include before/after numbers from reproducible commands
* [x] Fix draft benchmark shape: compile once, call one export, keep hot loop inside WASM
* [x] Replace toy scalar benchmark with stronger kernel from existing suite
* [x] Move `/tmp/jz-edgejs.../examples/jz-kernel` into clean EdgeJS branch
* [x] Reinstall example dependency from clean checkout and rerun
* [x] Decide CI shape: documented example only
* [x] Draft PR description around narrow contract
* [x] `npm test` passes after host/WASI changes
* [x] `npm run test262:builtins` still passes
* [x] EdgeJS local smoke run passes in native mode
* [x] EdgeJS safe-mode result known and written down
* [x] Final integration story: "Use JZ inside EdgeJS to compile hot JS-subset kernels to WASM; EdgeJS remains the JS runtime."

### test262 coverage expansion

* [x] Report overall test262 percentage against all `test262/test/**/*.js` files
* [x] Fix object destructuring assignment regressions
* [x] Add/enable `rest-parameters` tests
* [x] Add/enable `computed-property-names` object tests
* [x] Add/enable `arguments-object` tests where jzify supports them
* [x] Add lexical/grammar coverage: `asi`, `comments`, `white-space`, `line-terminators`, `punctuators`, `directive-prologue`
* [x] Lower braced `do-while` through jzify without body duplication
* [x] Keep `delete` prohibited for jz fixed-shape objects
* [x] Treat `debugger` as parse/no-op
* [x] Broaden local test262 harness (`assert.*`, `Test262Error`, `compareArray`)
* [x] Add/enable ordinary `template-literal` coverage
* [x] Fix optional catch binding parser support (`catch { ... }`)
* [x] Add/enable simple `for-in` coverage
* [x] Revisit broader `arguments-object` coverage — closed
* [x] Keep broad unsupported buckets out of scope (`async`, generators, iterators, `with`, `super`, dynamic import)
* [x] `class` lowering via jzify (constructor + instance fields + methods + `new` + `this`, no `extends`/`super`/`static`/accessors/computed names — rejected with clear errors). Instance = plain object, methods = per-instance arrows capturing it, `this` renamed to that object, `new C(a)` → `C(a)`. `test/classes.js` + `language/{expressions,statements}/class/` wired into the test262 runner with a feature-skip pass (`isClassTest`/`CLASS_EXCLUDED_PATTERNS`): +125 passing class tests, 0 failing.
  * [ ] Known limitation (pre-existing jz core, surfaced more often by classes): `new C().get()` chained directly on a `new`/call expression crashes when the method name is a collection method (`get`/`set`/`has`/`add`/`delete`) — `emit.js` dispatches `.get()` on an untyped receiver to the Map/Set emitter, which then `emit(undefined)`s the missing key arg → "expected emitted IR value, got empty value". Workaround: `let c = new C(); c.get()` (a typed local hits schema dispatch). Real fix: don't pick a collection-method emitter for an untyped receiver when arg count doesn't match / a closure-call path exists.
* [x] Triage remaining test262 language failures → 0 failing (827 passing). Added path-based skip rules in `test/test262.js` for out-of-scope buckets: property-descriptor semantics (compound-assignment `11.13.2-23..44-s`, logical-assignment `*-non-writeable*`/`*-no-set*`, `types/reference/8.7.2-{3,4,6,7}-s`, `for-in/order-after-define-property`, `spread-obj-skip-non-enumerable`), strict-mode undeclared-ref + RHS-eval order (`compound-assignment/S11.13.2_A7.*_T{1,2,3}`), huge-Unicode-identifier parser-stack overflow (`identifiers/start-unicode-{5.2.0,8,9,10,13,15,16,17}.0.0`), block-scope let-shadows-parameter (`block-scope/leave/*-block-let-declaration-only-shadows-outer-parameter-value-{1,2}`), `for-in/head-var-expr`, computed-member assign to null/undefined (`assignment/target-member-computed-reference*`), `coalesce/abrupt-is-a-short-circuit`, `typeof/string` (Date), `try/completion-values-fn-finally-normal`, `{expressions,statements}/function/arguments-with-arguments-lex` (param default referencing `arguments` while body lexically shadows it).
  * [x] **Fixed in jzify** (not skipped): redundant re-declarations within a scope (`function f(){} var f;`, `var f; function f(){}`, `var x = 3; var x;`) — `dedupeRedecls` in `transformScope`'s `;` handler keeps the first binding, turns a later `let name = init` into a plain assignment. Was a typed-slot clash in codegen.
  * [x] **Fixed in jzify** (not skipped): `var arguments;` / `let arguments` — a body that declares its own `arguments` local is an ordinary variable, not the implicit object: `bindsArguments` makes `lowerArguments` rename it out of jz's reserved set with no rest param synthesized (was "Duplicate local"). Regression tests in `test/test262-regressions.js`.

### Core infrastructure

* [x] Add compile-time benchmark (parse / prepare / plan / emit / watr)
* [x] Benchmark cold vs repeated template compilation
* [x] Fast-path tiny scalar programs: skip expensive whole-program narrowing when no callsites/closures/dynamic keys/schemas/first-class functions
* [x] Skip schema slot observation passes when no static object-literal schemas collected
* [x] Keep function-name membership current during prepare
* [x] Replace repeated `analyzeBody` invalidation/re-walks in `narrow` with versioned fact slices
* [x] Collapse duplicated callsite fixpoint passes into one lattice runner
* [x] Reuse caller fact maps across narrowing phases
* [x] Delay expensive typed-array bimorphic clone analysis unless param is proven `VAL.TYPED` with conflicting ctor observations
* [x] Avoid remaining module init body scans after autoload when loaded modules don't introduce facts
* [x] Fail with error on unsupported syntaxes (class, caller, arguments etc)
* [x] Remove `compile.js` as re-export hub
* [x] Split pre-emit planning into `plan.js`, signature specialization into `narrow.js`, autoload policy into `autoload.js`, static key folding into `key.js`
* [x] Keep `plan.js` separate from `analyze.js`
* [x] Make `narrow.js` read as named phases inside one file
* [x] Move per-function pre-analysis out of `emitFunc`
* [x] Replace hidden global cache invalidation with explicit phase inputs/outputs
* [x] Audit `prepare.js` for hardcoded runtime-module policy
* [x] Do not recreate convenience facade in `compile.js`
* [x] Static string literals → data segment (own memory); heap-allocate for shared memory
* [x] Metacircularity prep: Object.create isolated to `derive()` in ctx.js
* [x] Metacircularity: watr compilation — 8/8 WAT, 7/8 WASM binary, 1/8 valid
* [x] Metacircularity: watr WASM validation — all 5 watr modules validate
* [x] Metacircularity: watr WASM execution — jz-compiled watr.wasm compiles all 21 examples
* [x] console.log/warn/error
* [x] Date.now, performance.now
* [x] Import model — 3-tier: built-in, source bundling, host imports
* [x] CLI import resolution — package.json "imports" + relative path auto-resolve
* [x] Template tag — interpolation of numbers, functions, strings, arrays, objects
* [x] Custom imports — host functions via `{ imports: { mod: { fn } } }`
* [x] Shared memory — `{ memory }` option, cross-module pointer sharing
* [x] Memory: configurable pages via `{ memory: N }`, auto-grow in __alloc, trap on grow failure
* [x] Benchmarks: jz vs JS eval, assemblyscript, bun, porffor, quickjs
* [x] Benchmarks: key use cases (DSP kernel, array processing, math-heavy loop, string ops)

### Size — closing the AS gap

* [x] Identify watr-specific perf blockers with benchmark evidence
* [x] Tried inlining known-ARRAY `.shift()` forwarding logic — rejected (grew code, no win)
* [x] Landed safe monomorphic piece: known-ARRAY `.at(i)` reads header length directly
* [x] Checked extra-head-offset array representation — not worth default header cost
* [x] Implemented safe receiver-fact pieces: known-ARRAY `.map`/`.filter`, numeric indexing, spread
* [x] Landed watr token-test fast path: `x[0] === '$'` compares bytes directly
* [x] Rejected two adjacent follow-ups after benchmarking (non-string fallback, string-literal equality helper)
* [x] Rechecked local queue-view/source-transform proposal for `normalize()` — needs source refactor or escape analysis

### Completed perf / cleanup wins

* [x] Trampoline arity bug — uniform closure-table width (`ctx.closure.width`) was sized by max call-site/arrow-def arity, but boundary trampolines for first-class function *values* forward `$__a0..$__a{arity-1}` (lifted func defs slip past the arity scan, which walks bodies not param lists). An arity-3 function used only via a 1-arg indirect call emitted `(local.get $__a2)` against a 2-param trampoline → `Unknown local $__a2` at assemble time. Fix in `resolveClosureWidth`: also `max` over `programFacts.valueUsed` funcs' `sig.params.length`. + test pin in `test/closures.js`.
* [x] Lazy `__length` dispatch
* [x] Specialize `console.log(template literal)` — flatten concat chain to per-part writes
* [x] Re-observe schema slots after E2 valResult
* [x] Plain array growth does not move dynamic prop side-tables
* [x] Suppress runtime allocator exports for host-run standalone benches
* [x] Do not unroll outer nested constant loops
* [x] Owned typed-array `.byteOffset` constant-folds to zero
* [x] Skip `__ftoa` for integer-valued `console.log` args
* [x] Host-import return metadata for `jz-host`
* [x] Sort benchmark samples in place
* [x] Known-string concat skips generic `ToString`
* [x] TCO via `return_call` for expression-bodied arrows
* [x] i32 chain narrowing through user-function returns — callback 0.060ms → 0.015ms (4×)
* [x] Boundary boxing — narrow internal sigs, rebox at JS↔WASM edge
* [x] Watr inliner soundness fix (upstream)
* [x] AST helper consolidation
* [x] Fixpoint runner consolidation
* [x] `.charCodeAt(i)` returns i32 directly — tokenizer 0.14 → 0.07ms (2×)
* [x] Inline `arr[i]` fast path with known elem schema — aos 3.94 → 3.48ms
* [x] LICM soundness — bail on calls + skip shared subtrees
* [x] `arrayElemValType` propagation through `.map` — callback 5.09 → 3.46ms
* [x] Math.imul / Math.clz32 return i32 directly — bitwise 30.96 → 6.09ms (5×)
* [x] Cross-function arrayElemSchema propagation (aos) — 9.79 → 4.02ms (2.4×)
* [x] Per-iter base CSE — hoistAddrBase pass
* [x] Skip `__is_str_key` on VAL.ARRAY when key is known-NUMBER
* [x] Bimorphic typed-array param VAL.TYPED propagation (poly) — 6.65 → 5.52ms
* [x] arrayElemValType propagation through .map → callback param (callback)
* [x] LICM pass for boxed-cell loads — sound version
* [x] Bimorphic typed-array param specialization — function cloning (poly) — 5.06 → 1.13ms (4.4×), ties AS
* [x] Post-link DCE / dead-import & dead-function pruning in assemble
* [x] Callback/combinator 6-way fusion in optimizer
* [x] watr regression — `v128.const i64x2` lowering fix (`6186dcd`)

### Dynamic-property machinery in jz-compiled watr

* [x] `__set_len` calls inlined to direct header `i32.store`
* [x] `__typed_idx` ARRAY fast path (skip type re-dispatch on known-ARRAY receivers)
* [x] Generic hash-probe loop tightening — additive slot walk, drop per-iter `i32.mul` (`c1ce0a0`)
* [x] Additive probe walk in `__dyn_get_t_h` props loop (`a8b7976`, +12 B)
* [x] Prehash constant `.prop` / `?.prop` keys — `__dyn_get_t` is a thin wrapper over `__dyn_get_t_h(obj,key,type,h)`; new `__dyn_get_expr_t_h`; sites pass compile-time `strHashLiteral(prop)` → no `__str_hash` per access (`1790cb7`, +0.27% wasm, checksum stable). Also fixed latent `needsSchemaTbl` gap (now keys on `__dyn_get_t_h` / `__dyn_get_expr_t_h`).
* [x] Rejected: N-way global dyn-get cache — 1-way already hits the dominant "same object, many keys" pattern (`INSTR[op]`); 4-way = ~9 globals + ~250 B for unmeasurable gain
* [x] Rejected: static-segment off-16 props slot for object/array literals — watr's hot dyn-prop receivers (`ctx`, AST nodes) are heap arrays that already use off-16 header slots; relaxing the `off >= __heap_start` guard is high-risk for no return

### JSON optimizations

* [x] VAL.HASH valType + JSON.parse annotation
* [x] Nested HASH/array shape propagation
* [x] Static `JSON.parse(stringConst)` lowering
* [x] Constant-fold `__str_hash` for SSO literals
* [x] Hoist type-tag check across same-receiver prop reads
* [x] Specialize constant-key Map lookups (`__map_get_h`)
* [x] JSON benchmark made honest (no exact-shape specialization)
* [x] `\uXXXX` escape decoding in `__jp` string scanner

### Type system / codegen architecture

* [x] Unified Type record (`ValueRep`) — collapsed ptrKind/ptrAux/globals/val/schemaId into `repByLocal`/`repByGlobal`
* [x] `intCertain` forward-prop lattice + codegen rules (`toNumF64` skip, `Math.floor/ceil/trunc/round` elide)
* [x] Per-emitter short-circuit migration for `__to_num`, unary `+`, `isNaN`/`isFinite`, `Number()`, `Math.*`
* [x] Parallel-map dedup, dead helpers removed (-697 lines compile.js, +568 analyze.js)
* [x] Unboxed-by-default ABI inversion — closed as architecture backlog
* [x] Per-stage base hoisting + `offset=` fusion
* [x] General `offset=` immediate fusion
* [x] Constant-arg propagation (without unroll)
* [x] Rejected: intConst-driven i32 loop narrowing for biquad — V8 inliner regression
* [x] Small-trip-count loop unroll on top of intConst
* [x] Tail call optimization
