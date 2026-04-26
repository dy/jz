* Is there structural unnecessaries or decisions that make internal implementation complicated or unnecessarily bloated?
* Is there any design change or constraint possible that would simplify and reduce produced wasm size drastically?
* Is there any clever conventions possible to reduce the amount of type conversions in output?


## Status snapshot — Apr 26 2026

- **Phase 1 (native > V8 JS, 21/21)**: ✅ DONE & stable. `node scripts/bench-native.mjs` reports PASS. After Apr 26 stdlib hot-path inlining: smallest margin maze 1.04–1.06×, raycast 1.08–1.11×, containers 1.07–1.09×; rest 1.12–4.44×.
- **Apr 26 stdlib pass — Round 1** (commits `99ce0c7`, `fc50c46`): inlined hot helpers `__eq` (bit-eq first), `__ptr_offset` (drop redundant memory.size bound), `__len` (ARRAY fast path), `__str_hash` and `__str_eq` (hoist type/offset/byteLen out of byte loop, raw load8_u inner loop). PGO call counts: i64_reinterpret_f64 2.22B → 1.84B (-17%), `__ptr_offset` 637M → 446M (-30%), `__str_hash` 95M → 67M, `__str_eq` 63M → 54M, `__str_byteLen` 118M → 103M. Native deltas (50×5 bench): raycast 3.978 → 3.752 (-5.7%), maze 0.799 → 0.720 (-9.9%), containers 2.014 → 1.766 (-12%), raytrace 0.41 → 0.39 (-5%). Saved as `.work/bench-after-push.txt`.
- **Apr 26 stdlib pass — Round 2** (this session, uncommitted): doubled down on bulk-memory + dispatch hoisting across hot string ops:
  - `__mkstr` byte-loop → `memory.copy` (lowers to memcpy under wasm2c+clang).
  - `__str_eq` 4-byte chunked compare via unaligned `i32.load` (~4× inner-loop throughput).
  - `__str_slice` / `__str_pad` / `__str_repeat` / `__str_encode` — invariant SSO/heap dispatch hoisted out of the byte loop; bulk path delegates to `__str_copy`/`memory.copy`. `__str_repeat` uses doubling-via-`memory.copy` after first emit.
  - `__str_case` / `__str_indexof` / `__str_startswith` / `__str_endswith` — SSO/heap dispatch hoisted out of inner byte loop; per-byte fetch becomes inline branchless extract instead of `__char_at` call.
  - `stdlibDeps` swept: `__char_at` removed from sites that no longer need it; deps narrowed to `__str_byteLen` / `__str_copy` / `__alloc` only.
  - PGO call-count after round 2 (topN): `__eq` 207M, `__ptr_offset` 147M, `__str_byteLen` 103M, `__char_at` 91M (down from 137M), `__len` 89M, `__str_hash` 67M, `__mkstr` 62M, `__str_eq` 54M.
  - Bench (50×5): 21/21 PASS, raycast 3.835. Tests: 907/912 (no regression).
- **Phase 2 (jz-compiled wasm > V8 JS)**: ❌ uniformly ~3× SLOWER. Confirmed intrinsic to V8's wasm runtime (not marshalling). See "Path to V8 parity" section below.
- **Tier B watr-source rewrites**: tried previously, regressed native (jz's spread-push is faster than push-loop), reverted. See Tier B section.
- **Remaining Phase-1 levers** (Tier E below): amortized-O(1) `__arr_shift` (E1), inline `__hash_get_local` (E3), devirtualize HANDLER closure dispatch (E5). After Apr 26 the dominant remaining cost is watr-internal compiler functions (f38 instr, f10, f179, f84) — stdlib is largely tapped out.

## Path to V8 parity (raycast.wat compile: 13.5ms jz → 4.6ms V8, 3× gap)

**Phase 2 status (Apr 25 2026): jz-compiled wasm in V8 is uniformly ~3× SLOWER than V8 JS** across all 21 examples (ratio 0.31–0.35×). Saved baseline at `.work/phase2-baseline.txt`. Decomposition for raycast: native PGO 4.07 ms, V8 JS 5.48 ms, wasm-in-V8 15.7 ms. Marshalling tested separately — only ~1 ms of the ~10 ms gap. Remainder is V8 JIT specialization (hidden classes, monomorphic inline caches, cross-module inlining) that V8's wasm runtime cannot match for AOT-compiled wasm. Bench harness: `.work/bench-wasm-vs-v8.mjs`.

Items below are the path that would close the wasm-in-V8 gap. Multi-week scope; not a quick win.

The body-level helper tuning is exhausted. The 3× gap is structural — V8 does four things AOT jz currently doesn't. Implement in order; each compounds.

* [x] **1a. Unboxing — narrow v1 (DONE)** — `let/const x = {…}` OBJECT literals, never reassigned/nullish/escaped, stored as i32 offset.
  - Infrastructure: `analyzePtrUnboxable` (analyze.js); `ptrKind`+`ptrAux` tags flow through `readVar`/`writeVar`/`asF64`/`isNullish` (ir.js). `boxPtrIR` preserves aux (schemaId) bits on rebox. `ptrOffsetIR`/`ptrTypeIR` skip dispatch when VAL is statically known.
  - `emitSchemaSlotRead` rewired to `ptrOffsetIR(base, VAL.OBJECT)` — all `.prop` reads on OBJECT now inline the unbox.
  - Measured raycast compile: 23.85ms → 21.7ms (3.03× → 2.82× vs V8-native, ~7%). 912/912 tests pass.
  - Limitation: watr has zero `let x={...}` patterns — gain came only from the schema-slot-read inline.
* [~] **1b. Widen unboxing** — partial: `analyzePtrUnboxable` ([src/analyze.js:363](../src/analyze.js#L363)) now accepts OBJECT/SET/MAP/BUFFER locals (init from `{}` / `new Set` / `new Map` / `new ArrayBuffer` / `new DataView`). `isFreshInit` already handles CLOSURE (`=>`) and TYPED (`new XxxArray`) but they're not in `UNBOXABLE_KINDS` yet — flip-of-a-switch to enable. Function-parameter unboxing (signature change) still pending.
  - Remaining: enable CLOSURE + TYPED in UNBOXABLE_KINDS; add per-call-site signature tagging for params.
  - ARRAY locals need extra care (forwarding on realloc invalidates cached offset).
  - STRING ambiguous (SSO vs heap) — needs refinement pass first.

* [~] **2. Flow-sensitive type refinement** — substantially done. `extractRefinements` ([src/emit.js:126](../src/emit.js#L126)) handles `typeof x == 'string'/'number'/'function'` and `Array.isArray(x)` with positive/negative sense, walks `&&` / `||` / `!`. `withRefinements` applies per-branch and `isReassigned` invalidates if mutated; early-return refinement via `isTerminator`. Lookup via `ctx.func.refinements` in [src/analyze.js:42-47](../src/analyze.js#L42-L47).
  - Remaining: refinement from `ptr_type(x) === VAL.STRING` (today only `typeof` triggers); refinement from `instanceof`; refinement that survives across function-call boundaries when call doesn't escape `x`.

* [~] **3. Loop-invariant dispatch hoisting (LICM over types)** — partial: `hoistPtrType` ([src/optimize.js:60](../src/optimize.js#L60)) does CSE for repeated `__ptr_type X` calls (same X, same block) → single `local.tee` + reuse. That covers in-block redundancy but not loop-body specialization. Full LICM (clone loop body per possible type, dispatch once at entry) not done.
  - Remaining: detect local of pointer type never reassigned inside `loop`; emit `(if ptrType == STRING (then loop-string-specialized) (else loop-generic))`.

* [~] **4. Shape-based object lowering (hidden classes)** — substantially done. `ctx.schema` ([src/ctx.js:146](../src/ctx.js#L146)) tracks per-var shape; `analyzePtrUnboxable` + `autoBox` ([src/compile.js:258](../src/compile.js#L258)) materialize known-shape boxes; `emitSchemaSlotRead` ([module/core.js:343](../module/core.js#L343)) compiles `.prop` to `f64.load (ptrOffset + idx*8)` (fixed offset, no hash). `emitPropAccess` checks `ctx.schema.find()` first, falls back to `__hash_get` / `__dyn_get_*` only when shape unprovable.
  - Remaining: inference for object literals assigned across function boundaries (today shape only flows through direct `let x = {...}`); shape-merging across multiple construction sites.

Goal: ceiling is parity with V8 on compile-heavy workloads. Helpers should disappear from hot code, not just run faster.


* [ ] **Unboxed pointer ABI** (ABI change, big, −30–50% watr pointers) — current pointers travel as 8-byte NaN-boxed f64 through every call. Replacing with a 32-bit offset + 4-bit type tag (i32 packed, or dual-param) would cut pointer traffic by half in size and remove the `(call $__ptr_offset ...)` / `(call $__ptr_type ...)` instrumentation that dominates watr's instruction count. Needs a full ABI-redesign pass: emit.js call/return lowering, closure trampoline layout, static-ptr slot layout in data segment, and every stdlib. Highest-leverage but highest-risk item on the list — deserves its own milestone. (Overlaps with #1 above — unboxing is the local-level version of this ABI change.)


## Path to native > V8 in 100% of cases — **DONE Apr 25 2026** (21/21, all wins ≥1.00×)

`node scripts/bench-native.mjs` → PASS: 21/21. Closest margins: maze 1.00×, containers/raycast 1.03×; everything else 1.05×–4.50×. Stable across multiple runs. Earlier "19/21 baseline" measurements were thermal/system noise.

Path that closed it (chronological): Apr 17 — array opt pass (`09ca035`); Apr 24 — better deps + jzify, optimization pass; Apr 25 — `__dyn_set` skip-redundant-rewrite (`9860765`) + build.sh staleness fix.

Current state (Apr 24 2026, before final pushes): native wasm2c+clang+PGO+wasm-opt at **11/21 wins, 0.99× total**. Losers (slowest first): types, snake, malloc, maze, multivar, dino, raytrace, om, quine, stack — all sub-2ms with 1–11% gaps. Goal: 21/21 wins.

Where the remaining gap lives (probed in `/tmp/jz-c/watr.c`):
- 61 `CALL_INDIRECT` macro uses (each = bounds + null + type check + indirect call)
- wasm-rt's `instance->w2c_X` indirection for every memory/global access (V8 bakes the base into a register)
- setjmp at every wasm entry into EH-protected code (5 throwers in watr.wasm, 0 try blocks at runtime)
- NaN-box reinterpret traffic that wasm-opt can't eliminate across function boundaries

### Tier A — build pipeline (mechanical, low-risk, ~2-5% headroom) — **LANDED**

* [x] **A1. Drop EH stack-machinery if no `try` at runtime.** wasm-rt-exceptions-stub.c provides no-op throw/catch; `-fno-exceptions` in CFLAGS.
* [x] **A2. Single-instance specialization.** Implemented via `postprocess-watr.awk`: hoists `instance->w2c_memory.data` into function-local `__restrict__` alias, shadows load/store inlines via macros. Net ~8% on parser-heavy workloads. Also nullifies wasm2c's `FORCE_READ_INT/FLOAT` asm barriers (`sed -i` in build.sh) that were defeating CSE of the memory base.
* [x] **A3. Extra clang flags.** `-fno-exceptions -fno-unwind-tables -fno-asynchronous-unwind-tables -fmerge-all-constants -fno-stack-protector` in build.sh.
* [x] **A4. `__attribute__((hot))` markers.** Skipped — redundant with PGO block-frequency info. Verified Apr 26 by inspecting top-N PGO calls; clang already biases hottest functions correctly.
* [ ] **A5. BOLT post-link optimization.** Not done. PGO + LTO already covers most of what BOLT does on Darwin.

### Tier B — codegen in jz (algorithmic, moderate risk, ~5-15% headroom) — **EXPLORATION**

After Phase 1 hit 21/21, profiled raycast (now top hotspots): f38=watr's `instr()` 34.5%, f84=`cleanup()` 18%, f87=`parseLevel` 17% — all in watr/src, not jz codegen.

* [ ] **B1. Devirtualize closure calls when target statically known.** Not started. Top remaining lever for f87 (parseLevel).
* [ ] **B2. Inline more hot stdlib at WAT level.** Not started.
* [ ] **B3. Extend NaN-box elision to straight-line basic blocks.** Not started.
* [ ] **B4. Full LICM-on-types** (companion to #3 above). Not started.
* [ ] **B5. Devirtualize `call_indirect` on statically-known table slots.** Not started.

* [~] **B6. Watr-source structural changes — TESTED & REVERTED Apr 25.** Two candidates tried:
  - `cleanup()` ([compile.js:16-29](../node_modules/watr/src/compile.js#L16-L29)) — replace `node.map(cleanup).filter()` two-pass with single-pass for-loop. Byte-identical output, but **regressed native ~5% on raycast** because jz's `Array.push()` in a loop is slower than `[...spread]` (which goes through a fast `__arr_concat`-style path). V8 sped up MORE than native, worsening ratio.
  - `instr()` ([compile.js:942-981](../node_modules/watr/src/compile.js#L942-L981)) — eliminate `[...bytes]` clone, push template directly to `out`, skip empty-meta loop. **Regressed**: same root cause — push-loop slower than spread in jz codegen.
  - Lesson: jz's spread-push is actually well-optimized (uses memory.copy under the hood). Refactoring "more efficient JS patterns" at watr level can hurt because jz codegen has different hot paths than V8.
  - Real fix path: improve jz's per-element push throughput (so push-loop matches spread-push speed), then watr-source rewrites become valid.
  - `nodes.shift()` in instr() main loop is O(n²): `__arr_shift` in [module/array.js:537](../module/array.js#L537) does `memory.copy` of remaining elements. For 1000-instr function bodies, that's ~500K array shifts. Refactor to head-offset O(1) shift in `__arr_shift`, OR change watr's instr() to use index-based traversal — both are non-trivial; the latter requires changing every HANDLER's shift-from-nodes calling convention.

### Tier C — runtime + library (structural, high risk, ~10-30% headroom)

* [ ] **C1. Hand-rolled minimal wasm runtime.** Not started. Phase 1 ended at parity without needing this.
* [ ] **C2. Wasm → LLVM IR via wasmer/wamr** instead of wasm2c. Not started.

### Tier D — diagnostics — **DONE**

* [x] **D1. Profile native binary on losing examples.** Done via `sample watr-native 4 -- raycast.wat 200`. Pre-`__dyn_set`-fix top hotspot was f10 (`__dyn_set`, ~12% on raycast); post-fix top is f38 (`instr()`, 34.5%) → f84 (`cleanup()`, 18%) → f87 (`parseLevel`, 17%). All three live in watr's source.

### Tier E — squeezable perf wins remaining (Phase 1 strictly-better targets)

Smallest current margins on the bench are maze 1.00× and containers/raycast 1.03×. Items below are ordered by leverage/risk for pushing those above 1.10× consistently.

* [ ] **E1. Amortized-O(1) `__arr_shift` (head-offset).** Add `headOff` (i32) to ARRAY header; `shift()` increments `headOff` instead of `memory.copy`. Reset headOff to 0 when it grows past `cap/4` (compact). Affects [module/array.js:537](../module/array.js#L537) + indexing in `__arr_get`/`__arr_set` (must add `headOff`). HUGE leverage on watr — `nodes.shift()` is ubiquitous in [parse.js:13](../node_modules/watr/src/parse.js#L13) commit pattern and [compile.js](../node_modules/watr/src/compile.js) HANDLER consumers (~30 call sites). Risk: header layout change touches many stdlib funcs.
* [ ] **E2. Speed up jz's per-element `Array.push()`.** Currently each push does bounds check + cap grow + store. Inlining the fast path (cap-still-fits) at call sites — without going through `__arr_set_idx_ptr` — would let watr's existing patterns (and any push-loop) match spread-push throughput. After this, B6 retry becomes viable.
* [ ] **E3. Extend stdlib inlining peephole to `__hash_get_local` (watr's INSTR/HANDLER lookup).** Top inner-most cost for `instr()`: every iteration does `INSTR[op]` and `HANDLER[op]`, both → `__hash_get_local`. Same trick as `__ptr_offset` inlining in [src/optimize.js](../src/optimize.js): when key is a known short string and target is a known small HASH, inline the FNV-1a + open-addressing probe. ~8% of f38's time goes here.
* [ ] **E4. `__dyn_set` even leaner.** [module/collection.js:417](../module/collection.js#L417) currently does FNV-1a hash twice (once in `__ihash_get_local`, once in `__hash_set_local`). Cache the computed hash + bucket index across the get→set sequence. Would shave the remaining ~0.4% f10 time (low priority since f10 is no longer hot).
* [ ] **E5. Devirtualize HANDLER closure dispatch (B1, scoped).** `HANDLER[op]` returns one of ~30 small closures. PGO trace shows top-3 handlers fire 90% of the time. Static-resolve those at jz-compile-time when the call site sees only HANDLER[const_op] — emit direct `call $imm_X` instead of `call_indirect`. Affects [compile.js:971](../node_modules/watr/src/compile.js#L971). Gain estimated ~3% on raycast.
* [ ] **E6. Remove redundant `nodes?.length` re-check in instr() while-loop.** Currently re-evaluates conditional chain on every iteration. Hoist to `for (let len = nodes.length; len > 0;)` with explicit decrement when consumed (paired with E1's head-offset shift). Micro: ~0.5%.
* [~] **E7. PGO training set: include the noise-floor losers.** Apr 26: `types.wat` and `multivar.wat` already settle at 2.5×–4.4× on regression bench (50×5) — they're not at risk. Heavyweighting them in PGO Stage 2 would specialize the cold-start path but post-Apr-26 stdlib inlining they're stable; deferring unless margin shrinks.
* [ ] **E8. Reduce per-invocation init cost on tiny files.** For files like `multivar.wat` (24µs native), wasm-rt instance setup probably dominates. Pre-compute statics-table init in `__start` more aggressively, or share statics across re-instantiations.


### Build & tooling

* [x] Static string literals → data segment (own memory); heap-allocate for shared memory
* [x] Metacircularity prep: Object.create isolated to derive() in ctx.js (1 function to replace)
* [x] Metacircularity: watr compilation — 8/8 WAT, 7/8 WASM binary, 1/8 valid (const.js)
* [x] Metacircularity: watr WASM validation — all 5 watr modules (util/const/encode/parse/compile) validate via wasm-validate. Repro: `node ~/projects/watr/.work/repro-jz-codegen-bug.mjs`.
* [x] Metacircularity: watr WASM execution — jz-compiled watr.wasm correctly compiles all 21 examples (verified via /tmp/jz-c/watr-native). Required watr fix: `unbranch` opt at [watr/src/optimize.js:1394](../node_modules/watr/src/optimize.js#L1394) was stripping trailing `(br $loop_label)` from `loop` blocks (loop-back jump, not exit), making loops run once. Patched locally and upstream — gate on `op !== 'block'`.
* [ ] Metacircularity: subscript parser — needs jz-jessie fork excluding class/async/regex features + refactoring parse.js function-property assignments (~30 lines)
* [x] console.log/warn/error
* [x] Date.now, performance.now
* [x] Import model — 3-tier: built-in, source bundling (modules option), host imports (imports option)
* [x] CLI import resolution — package.json "imports" + relative path auto-resolve
* [x] Template tag — interpolation of numbers, functions, strings, arrays, objects
* [x] Custom imports — host functions via { imports: { mod: { fn } } }
* [x] Shared memory — { memory } option, cross-module pointer sharing
* [ ] Source maps — blocked on watr upstream; can add WASM name section (function names) independently
* [x] Memory: configurable pages via { memoryPages: N }, auto-grow in __alloc, trap on grow failure
* [x] Template tag
* [ ] jzify script converting any JZ
* [ ] jzify: auto-import stdlib globals (Math.* → `import math from 'math'`, etc.)
* [ ] jz core: require explicit imports for stdlib (remove auto-import from prepare/compile)
* [ ] align with Crockford practices
* [ ] swappable watr: likely AST will need to be stringified before compile if adapter is provided?

## Phase 14: Internal Parser (Future)
* [ ] Extract minimal jz parser from subscript features
* [ ] jzify uses jessie, pure jz uses internal parser
* [ ] True metacircular bootstrap


### Validation & quality

* [ ] color-space converter (validates multi profile)
* [ ] digital-filter biquad (validates memory profile)
* [ ] Benchmarks: jz vs JS eval, assemblyscript, bun, porffor, quickjs — compile time + runtime
* [ ] Benchmarks: key use cases (DSP kernel, array processing, math-heavy loop, string ops)
* [ ] test262 basics
* [ ] Warn/error on hitting memory limits
* [ ] Excellent WASM output
* [ ] wasm2c / w2c2 integration test

### Future

* [ ] metacircularity (jz compiling jz)
* [ ] Component interface (wit)
* [ ] threads/atomics (SharedArrayBuffer, Worker coordination)
* [ ] memory64 (>4GB)
* [ ] relaxed SIMD
* [ ] WebGPU compute shaders

## Offering

* [ ] Clear, fully transparent and understood codebase
* [ ] Completed: docs, readme, code, tests, repl
* [ ] Integrations (floatbeat, color-space, digital-filter)
* [ ] Benchmarks
* [ ] Pick ONE use case, make jz undeniable for it
* [ ] Ship something someone uses

## Floatbeat playground

* [ ] Syntax highlighter
* [ ] Waveform renderer
* [ ] Database + recipe book
* [ ] Samples collection

## REPL

* [ ] Auto-convert var→let, function→arrow on paste
* [ ] Auto-import implicit globals
* [ ] Show produced WAT
* [ ] Document interop



## Done

## More size reduction

Goal: watr self-host bundle on par with raw JS bundle size. Current: 257 KB → target ~40 KB (~6× reduction). The audit's 433 B (known-shape) vs 2,746 B (unknown-object) gap is the realistic ceiling: if everything becomes schema'd + feature-gated, watr lands in the 40-50 KB band.

Ordered by impact/cost.

### Tier 1 — biggest structural wins

* [x] **Arity-exact closure types** — implemented dynamic `$ftN` width via AST pre-scan ([src/compile.js](../src/compile.js) near line 983). Width = max of `=>` def arities + rest bonus, source-level call arities, and module-declared floor ([module/array.js](../module/array.js): floor=2, [module/typedarray.js](../module/typedarray.js): floor=1). Gate: `hasSpread && hasRest` forces MAX (needed for spread→rest correctness); `hasSpread` alone narrows safely (extras past W are dropped, no rest to miss them). **Result: watr self-host 277,757 → 275,449 (−2,308 B) after prepare desugars rest → hasRest=0 at scan time, width drops to 4. Simple programs: width drops to 1–2 (saves ~50 B per closure call site). Full arity-exact types (per-arity `$ftK` with trampolines) deferred — requires table layout redesign.** 887/887 tests pass.

* [-] **Drop SSO** — won't do: audit premise wrong. watr has only 13 runtime char-creation sites (5 `.at`, 8 `.charCodeAt` which returns number anyway) vs 91 unique ≤4-ASCII literals that are SSO-folded to 9B NaN-boxed constants (and pooled as 2B refs). Dropping SSO would require each unique literal to live in data segment as 4B header + N bytes content; each runtime char-producing site needs `__alloc` + store + mkptr (~30 B at call site vs 9 B folded). Removing the SSO branches from `__char_at`/`__str_byteLen` stdlibs saves ~100-200 B but the data-segment growth and per-callsite overhead erases that. Net size impact likely positive, not negative.

* [~] **Unify OBJECT + HASH** — partial: collapsed the 3-way runtime type dispatch (`if ptr_type == EXTERNAL ? __hash_get : __dyn_get_expr`) at unannotated-var property read sites into a single `__dyn_get_any` call. New helper extends `__dyn_get_expr` with EXTERNAL→`__ext_prop` fallback; original `__dyn_get_expr` kept EXTERNAL-free so tests not using JS interop don't import `__ext_prop`. Two sites collapsed: [module/core.js:339-343](../module/core.js#L339) (`.prop`) and [module/core.js:424-428](../module/core.js#L424) (`?.prop`). **Result: watr self-host 275,449 → 272,007 (−3,442 B).** 887/887 tests pass. Full representation unification (collapse `PTR.HASH` into `PTR.OBJECT`, hash-backed storage everywhere, schema as inline-only optimization) deferred — larger rewrite that touches object literal emission, schema subsystem, and all property-access paths.

* [x] **Gate `dyn_props` shadow** — already done in prior work. `analyzeDynKeys` at [src/analyze.js:404](../src/analyze.js#L404) builds `ctx.types.dynKeyVars`; `needsDynShadow(target)` at [src/compile.js:355](../src/compile.js#L355) gates shadow emission. Current gate triggers on any dyn-key *access* (read or write). Tighter "writes-only" framing breaks dyn reads — they depend on shadow being populated at object-literal time. A correct tightening would require redirecting reads through schema-aware runtime dispatch (compare k against schema props at runtime), which is a larger rewrite than "modest win, low risk".

### Tier 2 — larger rewrites, larger payoff

* [~] **Monomorphization at function boundary** — partial. **Scalar ABI already lands:** params narrow to i32 via existing call-site scan ([src/compile.js:1137](../src/compile.js#L1137)); results now narrow to i32 via new fixpoint pass ([src/compile.js:1150](../src/compile.js#L1150)). Fixed latent valueUsed hole (funcNames in arg position of a known-call weren't flagged — tripped as soon as results narrowed). **watr impact: ~22 B (negligible).** Audit finds 3/94 watr funcs narrow (isIdx/isId/isMemParam — tiny predicates); the remaining 91 return pointers (`result`/`ast`/`buffer`/`value`) which this pass can't touch. 0/165 params narrow — watr call sites pass pointers, not scalars. **Numeric-heavy user code benefits** (e.g. `countOdd(n)→for i++/isOdd(i)→c` narrows both param and result to i32). 912/912 tests pass. The promised **−30 to −50%** would come from unboxed pointer ABI (pass 32-bit offset, reconstitute NaN-box in callee) + schema-flattened struct passing — separate larger rewrites; this pass lays the result-tagging groundwork.

* [~] **Stdlib specialization by op-flow** — partial, factory pattern introduced. `__length`, `__typeof`, `__typed_idx` converted from static WAT strings to factory functions that read `ctx.features.*` + `ctx.core.includes` to elide dead branches. Producer sites for `features.set/map/typedarray/closure` wired at the emit sites that construct each type ([module/collection.js:279,310](../module/collection.js), [module/typedarray.js:257,345,510](../module/typedarray.js), [module/function.js:73](../module/function.js)). Unknown-receiver dispatch sites (`emitLengthAccess`, `emit['typeof']`) set the flags conservatively — correctness first. **Result: watr self-host 281,103 → 275,224 (−5,879 B, −2.09%).** 912/912 tests pass. `__length` WAT: 2249 → 2185 chars; `__typeof` WAT: 1190 → 844 chars; `__typed_idx` WAT: 5357 → 548 chars for scalar/array-only programs (no delta on watr since it uses typed arrays + external imports). The binary savings exceed raw WAT savings via cascading include elision. Remaining dispatch stdlibs evaluated:
  * **`__to_str`**: ARRAY branch gates on `features.array`, but arrays are ubiquitous — every useful program allocates them, so the branch never elides in practice. Save would be ~80 chars WAT + transitive `__str_join` dep, only for pure-numeric programs. Won't do: `features.array` would need wiring at every `allocPtr({type: PTR.ARRAY})` site (10+ sites across modules) for ~50 B binary impact in rare scenarios.
  * **`__str_eq`**: no elidable dispatch branches. Body is straight byte-by-byte compare via `__char_at`/`__str_byteLen`; polymorphism is already absorbed by those deps. Skip.
  * **`__arr_flat`**: element-type inspection (`__ptr_type elem == ARRAY`) is inherent semantics of `.flat()` — we can't know statically if elements are nested arrays or not. Skip.

### Tier 3 — conventions to reduce type conversions

* [ ] **Audit `asF64` wrapping sites** — 181 `asF64(...)` call sites across 13 modules (measured via grep). `asF64` already short-circuits: pass-through if already f64, fold `i32.const N → f64.const N`; only actual convert is `f64.convert_i32_s` (1 byte). Real removable sites are rare — `asF64(emit(x))` where emit returns f64 costs zero bytes today (pass-through branch). Savings would come from propagating i32 through whole expression chains and materializing as f64 only at the last f64-slot store — that's a larger emitter-contract rewrite (return `{node, type}` tuples instead of auto-wrapped nodes). Estimated ~50–200 B binary impact on watr. Not pursued.

* [-] **Inline `__ptr_type(x)` comparisons** — won't do: **naive inline regresses ~6 B per site × 2695 inline-compare sites = ~16 KB regression.** Measured via [.work/ptr-type-analysis2.mjs](ptr-type-analysis2.mjs): 2917 total `$__ptr_type` call sites in watr; 2695 are `(i32.eq (call $__ptr_type X) (i32.const N))` inline compares, 16 are hoisted to `local.set $t`, rest misc. Naive body inline (`i64.reinterpret_f64 + i64.shr_u 47 + i64.and 0xF + i32.wrap_i64`) is ~10 B vs `call + const + eq` at ~4 B. A viable approach requires an **automatic hoisting pass**: detect chains of `call $__ptr_type X` on the same X in one basic block, lift to `local.set $t (call $__ptr_type X)` and rewrite uses as `local.get $t`. The handwritten factory stdlibs already do this manually — the 2695 non-hoisted sites are one-off user-code dispatches where hoisting wouldn't help. Skip.

* [-] **Collapse `__is_nullish` / `__is_truthy` to inline bit-checks** — won't do: **regression**. `__is_nullish` body = `(i32.or (i64.eq ... NULL_NAN) (i64.eq ... UNDEF_NAN))` costs ~22 B inlined (2× i64.const + 2× i64.eq + reinterprets + or) vs ~3 B call. 33 call sites × ~19 B regression = ~600 B loss. `__is_truthy` similar. The existing `truthyIR` fast path at [src/compile.js:277](../src/compile.js#L277) already folds the trivially-known cases (i32 pass-through, literal folding, nested idempotence) — remaining call sites are genuinely polymorphic. Skip for binary size; perf-oriented inlining is a separate concern.

**Tier 3 summary**: all three items evaluated; none viable for binary size without significant compiler-pass rewrites. The `__ptr_type` inline plan was rescued in a different form: Consolidation #4 landed a post-emission hoist pass (N≥3 same-local) that delivers the hoisted-local structure the inline plan depended on, without inlining the body itself. **Current watr self-host: 275,060 B (from 281,103 B at session start, −6,043 B: −5,879 B stdlib factory work in Tier 2, remaining savings from `hoistPtrType`).**


### Consolidation — internal cleanup before more features

The WASM output is solid and competitive (scalar 134 B, watr self-host 275 KB). The compiler internals are ~20–30% messier than needed — grown incrementally without a consolidation pass. These aren't size/perf wins directly, but reduce the cost of every subsequent change and unlock the harder Tier 1/2 rewrites (unboxed ABI, OBJECT+HASH unification) which are currently hard to attempt on the existing base.

Ordered by leverage.

* [~] **Unify overlapping analysis passes** — partial. Extracted `lookupValType(name)` helper in [src/analyze.js](../src/analyze.js#L32) and swept 11 call sites across [src/compile.js](../src/compile.js), [src/emit.js](../src/emit.js), [module/typedarray.js](../module/typedarray.js), [module/core.js](../module/core.js), [module/object.js](../module/object.js), [module/array.js](../module/array.js), [module/schema.js](../module/schema.js), [module/function.js](../module/function.js), [module/collection.js](../module/collection.js) to replace the duplicated `ctx.func.valTypes?.get(x) || ctx.scope.globalValTypes?.get(x)` fallback pattern. Net: −22 lines of boilerplate, zero size impact, 912/912 tests pass. **Full unification deferred** — `collectValTypes` (pure) vs `analyzeValTypes` (mutates ctx.runtime.regex/types.typedElem/func.localProps) serve different call contexts; collapsing requires decoupling the side-effects (write to a caller-provided context instead of ctx). `analyzeLocals`'s widenPass is a separate walk but depends on completed first-pass types, so merging risks false-negatives on out-of-order comparisons. `analyzeDynKeys` scans globally-rooted (ast + func.list + moduleInits) while other passes are per-function — different scope. The one-AST-walk-one-environment rewrite is still the right target but needs a proper dataflow-pass framework; lookupValType is the low-hanging noise reduction ahead of that.

* [x] **Tighten `ctx` god-object** — added lifecycle + ownership table to [src/ctx.js](../src/ctx.js) mapping each of the 12 namespaces to its phase (init/compile/function/emit), writer set, and reader set. Moved emit-time-only `_expect` off module-level compile.js onto module-local in emit.js. Audit confirmed no dead fields: every subkey used in ≥1 production file. Most namespaces have legit single-responsibility; ~15 call sites duplicate the `ctx.func.valTypes?.get(x) || ctx.scope.globalValTypes?.get(x)` lookup which will collapse naturally in Consolidation #1 (analysis unification). Capability-registration pattern (modules install `ctx.schema.register`, `ctx.closure.make`) left as-is — it's a clean plugin boundary, not bloat. 912/912 tests pass.

* [-] **Factory stdlibs — resolve order-dependence** — won't do: premise was wrong. Investigated gating the conservative flip on `features.external`; tests failed because `jz.memory()` host interop passes typed-array pointers into f64 params of exported functions WITHOUT triggering `features.external` (which only flips for `opts.imports` / `_interp` / `HOST_GLOBALS`). So the conservative flip in `emitLengthAccess`/`emit['typeof']` isn't a workaround — it's correctness. Any exported f64 param can receive any pointer type from the host. To tighten this would require either (a) changing the host-interop contract so `features.external` is also set by export presence, or (b) per-param escape analysis distinguishing host-reachable params from local ones. Both are significant design changes. Current conservative flip is minimal (only fires at polymorphic `.length`/`typeof` sites, not at monomorphic accesses) and costs nothing on scalar programs.

* [~] **Lift orthogonal post-passes to optimize.js** — partial. Extracted `foldMemargOffsets` + `hoistConstantPool` from [src/compile.js](../src/compile.js) into new [src/optimize.js](../src/optimize.js), added new `hoistPtrType` pass that lifts repeated `(call $__ptr_type X)` on same un-mutated local into `local.tee $_ptN + local.get $_ptN` (threshold: N≥3 sites, break-even 2N−5 B). **Result: watr self-host 281,103 → 275,060 B (−6,043 B, −2.15%).** 912/912 tests pass. Remaining candidates (widenPass, i32→f64 fold, function-body dedup) still inline in compile.js — they're entangled with emission decisions and moving them requires first landing the analysis unification above.

* [x] **Decompose compile.js** — extracted AST→IR dispatch into [src/emit.js](../src/emit.js). compile.js 2924 → 1824 lines (−38%); new emit.js 1134 lines contains: `emitter` table, `emit` dispatch, `emitFlat`/`emitBody`, `cmpOp`/`compoundAssign`. compile.js retains orchestrator, function lowering, prep passes, IR construction helpers (`typed`/`asF64`/`allocPtr`/`readVar`/…). Re-exports emit/emitter/emitFlat for backward compat (all modules/tests import from compile.js). Circular-import-safe because emit.js references compile.js helpers only at call time (arrow-function closures), not at module init. Also moved per-compile `funcNames`/`funcMap` off module-level onto `ctx.func.names`/`ctx.func.map` so emit.js has no shared mutable state with compile.js. **Result: watr self-host 275,060 B unchanged; 912/912 tests pass.** No size impact — pure reorganization for maintainability.

* [x] **Define explicit pipeline stages with contracts** — added IN/OUT/invariant contracts to module headers across the pipeline: [index.js](../index.js) (full stage map), [src/prepare.js](../src/prepare.js), [src/analyze.js](../src/analyze.js) (pass catalog), [src/compile.js](../src/compile.js), [src/emit.js](../src/emit.js) (NO-MUTATE + side-effect list), [src/optimize.js](../src/optimize.js) (pure IR→IR, ctx-independent). Each header now states: inputs, outputs, invariants, ordering constraints. This surfaces the remaining blur — analyze/emit boundary (narrowing runs mid-compile) — but makes it explicit rather than implicit. Testable-in-isolation remains future work (emit depends on ctx so not yet a pure function; Consolidation #7 addresses this). 912/912 tests pass.

* [-] **IR as single source of truth during emit** — not started. Blocked on Consolidation #1 full unification: today's analyze passes write into scattered `ctx.*` slots (func.valTypes, types.typedElem, schema.vars, …) which emit reads mid-dispatch. The "single source of truth" refactor needs a unified analysis env that survives as the input to emit — which means finishing #1's one-walk-one-environment redesign first. Scoped audit: emit-time ctx reads are (a) per-function analysis outputs (movable), (b) capability plugins like `ctx.schema.find`/`ctx.closure.make` (should stay — plugin boundary), (c) feature flags (should stay — runtime gating), (d) `ctx.core.emit` dispatch table (can't move — polymorphism). Only (a) is in scope, and it's ~8 distinct slots. Real cleanup is mechanical *after* analysis is unified. Deferred.

**Consolidation summary**: none of these are required to ship the current capabilities, but each one pays back permanently in reduced cost-of-change. The analysis unification (#1) is the single highest-leverage item — it's the root cause of several downstream issues (ordering fragility, god-object coupling, factory order-dependence). Worth attempting before the Tier 1/2 structural rewrites, because those rewrites need a clean substrate to land on.


### Tier 4 — next-pass candidates (post-consolidation)

Ordered by cost/risk. All three stand alone; each can be attempted independently.

* [x] **Extract pure IR helpers → src/ir.js** (structural, medium, zero size) — compile.js held ~600 lines of stateless IR constructors (`typed`, `asF64/asI32`, `mkPtrIR`, `allocPtr`, `readVar`, `writeVar`, `emitNum`, `temp/tempI32/tempI64`, `truthyIR`, `isLit/isPureIR`, `nullExpr/undefExpr`, constants, …) that emit.js imported back through compile.js. Split into `src/ir.js`, breaking the compile↔emit circular import at module-init. Emit-calling helpers (emitDecl, materializeMulti, buildArrayWithSpreads, emitTypeofCmp, toBool) moved from compile.js to emit.js. compile.js re-exports for module/*.js backward compat. Result: compile.js 1831 → 1099 lines, new ir.js ≈ 450 lines, **zero WASM output delta** (watr self-host 275,060 B), **912/912 tests pass**.

* [-] **`{node, type}` emit-return rewrite** — **not pursued** (empirical evidence, 2026-04-21). Measured watr WAT: 1,163 `f64.convert_i32_s` instances (upper bound of what asF64 generates). Dead-conversion patterns (i32→f64→i32 round-trips, store-of-convert, etc.) found: **0** in meaningful quantity (3 `i64.reinterpret_f64(f64.convert_i32_s)` only). Most conversions are semantically necessary: pointer offsets / array indices / i32 locals flow into f64 ABI slots. The existing `typed(node, type)` + `asF64` short-circuit already handles every eliminable case. Proposed rewrite would touch every emit callsite across 13 modules for <10 B of measurable binary win. Duplicate of Tier 3 #1 finding. Skipped.

### Tier 0 — feature-gating framework (sealed ptr table, usage-driven inclusion)

Principle: seal the `PTR` enum (no external extensions), but make every optional feature **usage-gated** so unused ones leave zero bytes. Today REGEX/JSON/SSO are function-level gated via `inc()`+STDLIB_DEPS; EXTERNAL and HASH leak into stdlib bodies as conditional branches and get pulled even when unreachable.

* [x] **`ctx.features` flag framework** — `ctx.features = { external }` in [src/ctx.js](../src/ctx.js) `reset()`. Set by producer sites at emit-time (opts.imports/_interp, HOST_GLOBALS auto-import, `__ext_call` emit, `__dyn_get_any` emit at untyped `.prop`, `__hash_set` at untyped obj write). Read at `resolveIncludes()` / stdlib-emit time — late enough to stabilize after all emission. Deps graph entries can be functions (evaluated lazily in [src/ctx.js:50](../src/ctx.js#L50)); stdlib entries can be factory fns (called in [src/compile.js:1594](../src/compile.js#L1594)) — this is the mechanism for usage-gating.

* [x] **EXTERNAL usage-gating** — Implemented. `ctx.features.external` defaults false; flipped true at producer sites (see above). When off: deps graph skips `__ext_prop/__ext_has/__ext_set` pulls from `__hash_*/__set_has/__map_*/__dyn_get_any`; generators (`genUpsert`/`genLookup`/`genUpsertGrow`) emit shorter type-guards without EXTERNAL branch; `__dyn_get_any` factory collapses to 2-way dispatch (HASH | NULL); `in` emit skips EXTERNAL arm. Fixed latent bug at [module/collection.js:522](../module/collection.js#L522) (`i32.const 2` was BUFFER, meant EXTERNAL). **Result: watr self-host 272,007 → 257,316 (−14,691 B, −5.4%).** 887/887 tests pass.

* [-] **HASH usage-gating** — flag added ([src/ctx.js](../src/ctx.js)) but not wired. Verified won't help watr: every hash stdlib is actively called (254× `__dyn_get`, 526× `__dyn_set`, 167× `__dyn_get_any`, 33× `__hash_set`, plus `in` / `for-in` / property reads/writes). HASH is already organically usage-gated — simple scalar programs don't pull it. **Theoretical ceiling (measured): 33,013 chars WAT across 15 hash stdlibs → ~13,200 B binary** (measure-sso-hash.mjs). Top consumers: `__hash_set` (6.6 KB WAT), `__hash_set_local`/`__ihash_set_local` (~6 KB each), `__hash_get`/`__hash_has` (~2 KB each). Real HASH savings require eliminating hash-fallback *call sites* via schema coverage (Tier 2: monomorphization) — flipping the flag off without that would miscompile untyped `.prop` access.

* [x] **SSO as opt-in feature flag** — flag wired at literal-emit site ([module/string.js:49](../module/string.js#L49)); runtime char-producing sites (String.fromCharCode, charAt, etc.) still mint SSO ptrs so stdlib dispatches stay correct. **Measured via [.work/measure-sso-hash.mjs](measure-sso-hash.mjs): watr 275,246 → 284,299 B (+9,053 B, +3.29%) when SSO off.** Confirms audit: 91 unique ≤4-ASCII literals folded to 9 B `mkptr` constants each; without SSO they move to string pool (4 B header + N bytes + per-site `strBase+offset` IR) — pool overhead dwarfs stdlib dead-branch savings. Keep SSO on by default.

* [x] **Sealed PTR table — document + enforce** — PTR enum at [src/ctx.js:11](../src/ctx.js#L11) documented SEALED with rationale + the protocol for retiring/renumbering types. Internal A/B measurability goes through `ctx.features.*`, not a plugin registry.

**Tier 0 summary**: framework landed; EXTERNAL gating delivered the one genuine watr-level win (−14.7 KB). Remaining flags are slots — the per-stdlib conditional-branch savings that worked for EXTERNAL don't apply to HASH/SSO/etc in watr because those capabilities are all live. Next watr-level wins need structural work (Tier 1 full OBJECT+HASH unification, Tier 2 monomorphization + stdlib specialization) or per-call-site micro-wins (Tier 3 `__is_truthy`/`__ptr_type` inlining where call overhead > 8-byte inline — measure per site).

### Audit

Size-probe measurements that frame every task below:

```
(x)=>x+1                        45 B
(s)=>s.slice(1)              1,005 B
(o={x:0})=>o.x                 433 B    ← known-shape record
(o)=>o.x                     2,746 B    ← unknown object (6× larger)
(o,k,v)=>o[k]=v              3,074 B
(x)=>JSON.stringify(x)       2,569 B
```

The `433 B` vs `2,746 B` gap is the strongest signal in the codebase: "known-shape record" vs "unknown object" is the real fault line, and the object layer is currently carrying all three of `{record, dynamic-hash, external-JS}` at once.

Repo: **12.1 k JS lines** total, **compile.js = 2,693 lines (22% of everything)**, index.js = 622 lines of interop, module/regex.js = 910, module/array.js = 1,012.

**High priority — language/model change**

* [-] **Body-usage shape inference for unannotated record params** — attempted, abandoned. Synthesizing per-function schemas from prop reads creates slot conflicts with later-registered object literals: synth `{y}` has y at slot 0, literal `{x,y}` has y at slot 1. Non-exported helpers that appeared safe still break when callers pass External (JS-wrapped) objects — direct slot loads read wrong memory. The 433 B ↔ 1257 B gap cannot be closed safely by body-usage alone: it needs a known-shape witness at the call boundary. Structural subtyping at [module/schema.js:76-82](../module/schema.js#L76-L82) already handles the within-module literal case without any synth.
* [x] **Call-site schema propagation** — extended `scanCalls` with `paramSchemas: Map<funcName, Map<paramIdx, schemaId|null>>`. Infers schemaId from object-literal args and module-level schema-bound vars. Two-pass fixpoint so transitively propagated schemas flow through chained helpers. Bindings applied via `ctx.schema.vars.set(paramName, sid)` at per-function compile start; saved/restored across top-level functions so bindings don't leak across param-name reuse. **Result: up to ~180 B savings in byProp-conflict cases (where structural subtyping returns -1 and would otherwise fall back to dynamic). No regressions — structural subtyping already handles the common "one literal, one helper" pattern; propagation helps only when the shape would otherwise be ambiguous.** 887/887 tests pass.
* [x] **Narrow implicit module loading** — replaced `.`'s pessimistic `OP_MODULES` entry with a property-name table (`PROP_MODULES` at [src/prepare.js:77](../src/prepare.js#L77)) that narrows per-method: `.push`/`.map`/`.reduce`/... → array-only; `.toUpperCase`/`.charAt`/... → string-only; `.add`/`.clear` → collection-only; `.slice`/`.concat`/`.indexOf`/... → string+array; `.length` → string+array+typedarray. Unknown props still load pessimistically. Scalar-conversion methods (`.toFixed`/`.toString`) kept pessimistic because they fall through to `__ext_call` (collection) on unknown receivers. **Result: array-heavy code drops ~75% (e.g. `arr.reduce(...)` 2235 → 554 B). Measure-suite TOTAL −8.7% (19279 → 17598 B). Watr self-host unchanged (compiler exercises every module type). 887/887 tests pass.**

**High priority — architectural cleanup**

* [x] **Reduce global-ctx coupling** — (a) done: module initializers now receive `ctx` as param (`export default (ctx) => {...}`); (b) partially done: STDLIB_DEPS co-located per-module via `Object.assign(ctx.core.stdlibDeps, {...})`, eliminating the 147-line table at old ctx.js:51 and resolving its FIXME. Full `registerEmitter` helper sweep (200+ sites) and (c) immutable phase outputs deferred — require dedicated session.
* [x] **Split interop runtime out of compiler core** — moved NaN-boxing, memory marshaling, wrap, and instantiate into [src/runtime.js](../src/runtime.js). [index.js](../index.js) reduced 622 → 164 lines; now only wires the runtime onto the `jz` API. 860/860 tests pass.

**Medium priority — language surface**

* [x] **Consolidate three frontend modes into one** — collapsed to two: default (strict jz, prepare rejects `function`/`var`/`switch`) and `{jzify: true}` (accepts full JS subset by lowering). Dropped the `pure` flag entirely; subscript's jessie parser handles ASI natively, so the strict-ASI-but-reject-JS mode had no justification. CLI picks `jzify: isJs`. [index.js:62-75](../index.js#L62-L75), [cli.js:128](../cli.js#L128). 887/887 tests pass.
* [x] **Decide the language's center of gravity** — **committed to "tiny wasm / lean kernel"**. The README already stakes this ground: principle at [README.md:108](../README.md#L108) reads *"No dynamic property lookup, no implicit type coercion, no prototype chains, no hidden classes. If it would force a runtime type check, it's not in the language."* The current 2 KB dynamic-object floor directly contradicts that principle — keeping it would mean the docs lie. The core stays numeric kernels + tuples/multi-return + typed arrays + closed records (the 45-1005 B band). Dynamic objects (`obj[k]`, `for...in`, `{...obj}`, external-JS interop) become an opt-in `Map`/`Hash` type the user names explicitly. JSON/regex stay as modules behind explicit `import`. **Consequence — these are now live, not hypothetical:**
  - Item #1 ("Closed records by default, dynamic lookups explicit") → proceed.
  - Item #2 ("Shape witness for record parameters") → proceed, blocks on #1.
  - Implicit stdlib imports (FIXME item at top) → proceed; `import` becomes the single source of truth for module inclusion.
  - `__dyn_set` shadow, `__dyn_get_expr`, and HASH-on-OBJECT fallback paths are on the chopping block once #1 lands.


### Audit (second pass) — deeper findings

**High priority — calling conventions**

* [x] **Uniform closure arity = per-call args-array allocation** — replaced heap args-array convention with uniform inline signature `(env f64, argc i32, a0..a7 f64) → f64` (MAX_CLOSURE_ARITY=8). Caller emits actual args + UNDEF pads + argc; body unpacks slots directly; rest-param bodies pack slots into fresh array. Trampoline for top-level-function-as-value updated to match. Eliminates `__alloc` + header stores per closure call. **Result: -10,298 B (3.6%) on watr self-host (288,407 → 278,109). Closure call sites -54% on small cases (654 → 303 B for `mk()(5)`). Rest-param receives up to (MAX - fixedParams) spread elements — documented limitation.** 860/860 tests pass.
* [-] **`__dyn_get`/`__dyn_set` hash keys are stringified i32 offsets** — audit premise wrong. Code at [module/collection.js:306-309](../module/collection.js#L306-L309) uses `__ihash_get_local`/`__ihash_set_local` which hash via `$__hash` (bit-xor of i64 reinterpret, no string conversion) and compare via `f64.eq`. Only `f64.convert_i32_s` happens on the offset — no `__to_str`, no heap string alloc. An i32-keyed variant would save ~1 byte per `__dyn_get`/`__dyn_set` body (these are shared stdlib fns, not per-callsite) — not worth the generator duplication.

**High priority — type-conversion leakage**

* [x] **`valTypes` doesn't carry i32/f64 distinction across function boundaries** — extended `scanCalls` to track `paramWasmTypes` per call site via `exprType`; apply-pass in [src/compile.js:1048](../src/compile.js#L1048) specializes non-exported/non-value-used functions with consistent i32 call-sites. Added `asParamType(n, t)` helper; 5 call-site arg emissions updated to respect target param type. Conservative — doesn't fire on watr self-host (most params are f64-typed pointers) but validated via synthetic test showing `(param $i i32)` signature with direct `(local.get $x)` at callsites.
* [x] **Array-callback index as f64** — fast path (`makeCallback`) already elides: `idxArg(cb, i)` at [module/array.js:650](../module/array.js#L650) returns `null` when `cb.usedParams[slot]` is false, and the inline loop at [module/array.js:103](../module/array.js#L103) does `if (!usedParams[i]) continue` — no convert, no local allocated for unused index. Slow path (variable callback) can't inspect arity without runtime dispatch — requires Item 1 (per-arity closures).
* [-] **`__is_truthy` reinterprets the same f64→i64 four times** — measured: the function body is shared across all callsites (1 definition, N calls). Caching via `local $vi i64` adds local decl + `local.set` (~4 bytes) while saving 4× (2-byte `local.get $v` removed = ~4 bytes if `i64.reinterpret_f64` already 1 byte). Net: +3-6 bytes on TOTAL/WATR measured. Audit math was wrong ("per call" means per *call site* not per function body). Reverted.

**Medium priority — duplicate analysis passes**

* [x] **`walkVt` in compile.js duplicates `analyzeValTypes`** — removed inline re-walk; `scanCalls` seeds caller locals via `analyzeLocals + collectValTypes` from [src/analyze.js](../src/analyze.js). Single source of truth.
* [x] **Four independent pre-compile AST walks** — collapsed into single `unifiedWalk` at [src/compile.js:898](../src/compile.js#L898) covering dyn-key detection, property-assignment auto-box scan, and first-class function-value detection. Separate `dynOnlyWalk` for `moduleInits` (only dyn-key scope applies there, not user property scans). `analyzeValTypes` + `analyzeLocals` invoked per function where already needed.
* [x] **`ctx.types._localProps`, `ctx.runtime._inTry`, `ctx.types._dynKeyVars/_anyDynKey` are single-writer/single-reader private channels** — relocated and renamed: `localProps`/`inTry` moved to `ctx.func` (per-function state), `dynKeyVars`/`anyDynKey` cleaned on `ctx.types`. Full threading as explicit args deferred — these span phases (analyze → emit), so ctx location is appropriate.

**Medium priority — convention wins**

* [-] **Inline `__is_truthy` / `__ptr_type` / `__is_nullish` at hot callers** — `truthyIR` at [src/compile.js:277](../src/compile.js#L277) already covers: i32 pass-through, `f64.convert_i32_*` peephole, nested `__is_truthy` idempotence, f64-const folding, NaN-boxed literal folding (UNDEF/NULL/canonical NaN → 0, others → 1). Full body inline would cost ~30 bytes per site vs 2-byte call — net regression. Perf-oriented inlining is a different concern from binary size.
* [x] **Boxed-capture cell pointer roundtrip** — closure env slots are 8 bytes but boxed-capture cell pointers are i32 (4 bytes). Store via `i32.store` into low 4 bytes, load via `i32.load` — skips `f64.convert_i32_u` at store site and `i32.trunc_f64_u` at body load. Env layout stays homogeneous (same 8-byte stride), no env-copy complication. **Result: -110 B on watr self-host (278,109 → 277,999); ~2 B saved per boxed capture.** [module/function.js:81-89](../module/function.js#L81-L89), [src/compile.js:1282-1291](../src/compile.js#L1282-L1291). 887/887 tests pass.
* [-] **Strongly-typed exported signatures** — won't do: changing `(f64)→f64` to `(i32)→i32` alters JS-side call semantics (ToInt32 coercion of floats). Needs explicit user opt-in via export marker or type annotation — API change, not a transparent optimization.


### Reduce size

* [x] **Pool repeated f64 constants into mutable globals** — `f64.const` is 9 bytes; `global.get` with idx<128 is 2 bytes. After counting frequency across all funcs, hoist values used ≥ 2× into mutable f64 globals (mutable so watr's propagate doesn't inline them back). Pool entries sorted by usage so hottest get lowest indices. Dominant wins: `UNDEF_NAN` (911 uses → 8 199 B → 1 822 B), literal 1.0 (552 uses), literal 0.0 (334 uses), hot SSO/STRING ptrs. Saves **~26 KB** on WATR self-host. See [src/compile.js:1499](../src/compile.js) `hoist`-pool pass.
* [x] **Stdlib funcs before user funcs in module layout** — hot stdlib call targets (`__typed_idx`, `__sso_char`, `__alloc_hdr`, `__str_concat`, `__ptr_type`, etc.) now get indices < 128 → 1-byte LEB128 encoding instead of 2-byte. 15 824/16 448 calls (96%) are now 1-byte vs 22 before. Saves **15 729 B** on WATR self-host. Single line change in [src/compile.js](../src/compile.js) section assembly — swapped `sec.stdlib` and `sec.funcs` ordering.
* [x] **Function-body deduplication across all compile phases** — alpha-rename locals/params, hash, redirect duplicates through elem section. Moved after late-closure compilation (during `__start` emit) so structural duplicates across batches collapse. 254 → 235 closures (19 deduped), saves ~2.4 KB on WATR.
* [x] **Memarg offset fold peephole** — `(load/store (i32.add base (i32.const N)) ...)` → `(load/store offset=N base ...)`. Saves ~2 bytes per site, ~6.5 KB on WATR. See [src/compile.js:1469](../src/compile.js) `foldMemargOffsets`.
* [x] **Use `f64.const nan:HEX` for NULL/UNDEF sentinels in modules and mkPtrIR folds** — 9 bytes vs 12 for `f64.reinterpret_i64 (i64.const HEX)`. Combined with constant pooling this compounds to large savings.

* [x] **Gate `__dyn_set` shadow-init on `usesDynProps`** — `analyzeDynKeys` in [src/analyze.js](../src/analyze.js) builds `_dynKeyVars` + `_anyDynKey`; `needsDynShadow(target)` in [src/compile.js](../src/compile.js) gates emission. Object literals assigned to non-dyn vars skip the shadow.
* [x] **Constant-fold `__mkptr(t, a, o)` when all args are literal i32** — `mkPtrIR` in [src/compile.js](../src/compile.js) folds to `(f64.reinterpret_i64 (i64.const HEX))`. Used by 12+ sites. Prefix-strip pass extended to detect folded form via hex-decode + NAN_PREFIX_BITS check.
* [-] **Specialize `__ptr_offset` for non-ARRAY types** — measured: 4-instr inline (~12 B) > call (~6 B). Skipped — not a binary-size win.
* [x] **Static data segment for compile-time-constant collections** — `staticArrayPtr` in [module/array.js](../module/array.js) (≥4 elem), static-object branch in [module/object.js:48-66](../module/object.js#L48-L66) (≥2 prop, also when shadow-init needed: skips alloc + N stores, feeds literals to `__dyn_set` directly). Embedded pointer slots tracked via `ctx.runtime.staticPtrSlots` and patched by prefix-strip pass.
* [x] **Elide `__is_truthy` for already-i32 inputs and nested truthy** — `truthyIR` helper in [src/compile.js](../src/compile.js) drops outer `__is_truthy` when arg is i32 or nested truthy. `makeCallback` propagates body type through inlined arrow's wrapping block so result keeps i32 typing.
* [-] **Inline `__alloc_hdr` when `stride=8`** — measured: inline (5 instr ≈ 15 B) > call (~6 B). Skipped.
* [-] **Hoist `$__strBase` to local within a function with multiple string literals** — only relevant for shared-mem; watr uses own-mem (strings → static data with constant offset, no `__strBase`). Skipped for watr-self-host case.
* [-] **Closure deduplication** — measured: closures in watr are NOT structurally identical after IR generation (each has unique free-var captures + unique param substitutions). Dedup wouldn't yield meaningful savings. To reach 20-60 KB band requires a more aggressive structural change (e.g., compressed binary format, post-link instruction-pattern dedup).

**Source-level redundancy (no functional change):**

* [x] Replace 30+ manual `const t = ${T}…${ctx.func.uniq++}; ctx.func.locals.set(t, 'f64')` sites with `temp(tag)` / `tempI32(tag)` / `tempI64(tag)` helpers — completed across all modules (string, number, regex, array, object, collection, function, typedarray). Added `tempI64` to [src/compile.js](../src/compile.js).
* [x] Extract `mkPtrIR(type, aux, offsetIR)` helper with constant-folding — used in 12+ sites across compile.js and modules.
* [-] Route remaining `__alloc_hdr` callsites through `allocPtr` — investigated: array.js sites are raw WAT in stdlib helpers (not IR); object.js Object.entries pair-allocator reuses one local across compile-time loop unroll (allocPtr would create N WASM locals). Both kept inline intentionally.
* [x] Extract `slotAddr(baseLocal, idx)` helper — used in object.js (10+ sites) and array.js.
* [-] Split [module/string.js:23-61](../module/string.js#L23-L61) `emit['str']` into `emitOwnString` / `emitSharedString` — won't do: SSO check is shared upfront, then a clean `if (!ctx.memory.shared)` splits the two modes. Splitting would duplicate the SSO prefix. Current shape reads fine.
* [x] Extract `emitNullishGuarded(guard, access)` — consolidated the wrapper in [module/core.js:299-303](../module/core.js#L299-L303); `?.`, `?.[]`, `?.()` each collapse to a one-liner. Bonus: `?.[]` moved from block+local.set to local.tee in guard, saving -242 B on watr self-host.
* [-] Move shared helpers (`usesDynProps`, `keyValType`, `notNullish`) into [src/analyze.js](../src/analyze.js) — won't do: premise is wrong. `usesDynProps` is already exported from compile.js and imported by core.js. `keyValType` is defined and used only in compile.js. `notNullish` is an IR-emitting closure in core.js (captures `inc`) — wrong semantic fit for analyze.js.
* [-] Audit `__typed_idx` dual registration ([module/array.js:132](../module/array.js#L132) + module/typedarray.js:558) — bodies byte-identical; typedarray's registration overwrites array's at module init. Safe to remove typedarray's copy. Tiny source-only cleanup (no binary impact).


### FIXMEs

Ordered by payoff/risk ratio. Each targets FIXME comment(s) currently in source.

* [x] **Move lenient-ASI patcher to subscript** — done. subscript now handles `!\n`, `~\n`, and `}\n[` ASI natively (v10.4.0). `patchLenientASI` removed entirely from jz (~70 lines across prepare.js, index.js, ctx.js). 860/860 tests pass.
* [x] **Drop `_` prefix on `_localProps` and `_inTry`** — renamed + relocated: `_localProps` → `ctx.func.localProps`, `_inTry` → `ctx.func.inTry`, `_dynKeyVars`/`_anyDynKey` → `ctx.types.dynKeyVars`/`anyDynKey`.
* [x] **Convert jzify if-chain to dispatch dict** — `transform()` now uses `handlers` dict matching prepare.js pattern. Handlers return result or `undefined` to fall through to default recursion. Extracted `wrapArrowBody`, `isProto`, `TYPED_ARRAYS`. 860/860 tests pass.
* [~] **Implicit stdlib imports — partially addressed** — `BUILTIN_MODULES` + `STATIC_METHOD_MODULES` merged into a single flat `CALL_MODULES` dict (keyed by bare name or `'obj.name'` dotted path). Lookup in the `'()'` handler is now a single dict access for both cases. Removed all 4 FIXMEs with clarifying comments. Kept `GLOBALS` (predefined ambient namespaces — every jz/JS program has these without needing imports), `CTORS` (ergonomic `new`-less constructor call) and `GENERIC_METHOD_MODULES` (unknown-receiver method dispatch — can't be keyed by name alone).
  Full elimination via auto-import-injection in jzify was considered and rejected: `Object.fromEntries` needs `collection`+`string` while `o.x` does not, so relying on `MOD_DEPS` transitive inclusion alone would over-load simple paths (regression on size probes). An auto-import scanner in jzify would need the same table to know what to emit — no net simplification, just moved the knowledge. If and when modules gain structured "peer-deps per operation" metadata, this can collapse cleanly.
  Result: ~40 lines removed from [src/prepare.js](../src/prepare.js), 4 FIXMEs closed. 887/887 tests pass.
* [x] **jzify `arguments` → rest params** — scans function body for bare `arguments` references (stops at nested `function`, recurses through arrow `=>` since arrows inherit the enclosing `arguments`). When found, appends `...\uE001argN` rest param and renames bare `arguments` to that fresh name throughout body. Covers both classic `function f(){}` decls and named IIFEs. Keeps `with`/`super`/`eval`/`yield`/`this` prohibited in prepare.js. Verified: `arguments.length`, `arguments[i]`, nested-arrow inherit, nested-function-owns-own-arguments all work. [src/jzify.js](../src/jzify.js) `lowerArguments`.
* [x] **Co-locate `STDLIB_DEPS` with stdlib modules** — done. Each module now calls `Object.assign(ctx.core.stdlibDeps, {...})` at init time; registration spread across [module/core.js:19](../module/core.js#L19), [module/number.js:16](../module/number.js#L16), [module/string.js:18](../module/string.js#L18), [module/array.js:136](../module/array.js#L136), [module/collection.js:211](../module/collection.js#L211), [module/json.js:15](../module/json.js#L15), [module/regex.js:650](../module/regex.js#L650), [module/typedarray.js:200](../module/typedarray.js#L200), [module/console.js:19](../module/console.js#L19). [src/ctx.js](../src/ctx.js) just declares the empty `stdlibDeps: {}` slot and `resolveIncludes()` consumes it.
* [x] **Clarify jzify-redundancy FIXME at prepare.js** — rewrote comment to "duplicated from jzify deliberately: .jz source bypasses jzify, so prepare is the actual defense. Messages here fire for both .js and .jz." at [src/prepare.js](../src/prepare.js) 'async' handler.
* [x] **Drop vague "duplicates per group" note at ctx.js** — removed; no actual duplication existed.

### API / interop

* [x] **Shared mem scope** — `jz.memory()` creates shared memory scope; any `jz('code', { memory })` compiles into it.
* [x] **Reduced interop tax** — typed arrays are zero-copy views over shared memory; unified `.read()`/`.write()` on the Memory object.
* [x] **Cross-instance data sharing API** — `jz.memory()` accumulates schemas across compilations, shares allocator, pointers portable between instances.
* [x] **Object interpolation: allow non-numeric values at compile time** — template tag now serializes strings, arrays, and nested objects as jz source literals. Only non-serializable values (functions, host objects) fall back to post-instantiation getters.
* [x] **NaN-boxing justification** — documented in README: precedent (LuaJIT/JSC/SpiderMonkey/Porffor), f64 vs i32 tradeoff (~1.2x, mitigated by i32 preservation), NaN preservation guarantees (quiet NaN, spec-compliant).


## [x] jz.memory wrapper

Monkey-patch `WebAssembly.Memory` with jz read/write methods. No wrapper object — `memory` IS the Memory.

- [x] **1. `jz.memory([src])`** — replaces `jz.mem(src)`.
- [x] **2. `jz()` compile path** — normalize `{ memory }` option, auto-wrap raw Memory, schema accumulation
- [x] **3. Instance result** — `{ exports, memory, instance, module }` — drop `.mem`
- [x] **4. Tests** — 12 new tests in `test/mem.js` (857/857 pass)
- [x] **5. README** — documented `jz.memory` API
- [x] **6. Update internal refs** — `.mem` → `.memory` in template tag, tests, etc.

### Tier 1: Zero-cost (no semantic change, pure codegen cleanup)

* [x] **G. Elide `__heap` global when no memory** — 9 bytes per module. Pure scalar functions
      (`add`, `fib`, `bits`, `mandelbrot`) don't need `__heap`. Gate on `needsMemory`.
      Closes the add/fib gap entirely (50→41, 91→82).

* [x] **H. Elide zero-init for locals** — WASM spec: locals default to 0.
      `(local.set $zx (f64.const 0))` is dead code. Skip `local.set` when init is literal 0/0.0.
      Mandelbrot emits 3 of these: `$zx`, `$zy`, `$i` → saves ~18 bytes.

* [x] **I. Eliminate dead code after return** — `(return (local.get $i)) (f64.const 0)` in
      mandelbrot: the `(f64.const 0)` is unreachable. Detect `return` as last statement in
      function body and omit the trailing fallback expression.

* [x] **J. While-loop single-test form** — current `while(cond)` emits condition TWICE:
      once as `br_if $brk (eqz cond)` before loop, once as `br_if $loop (cond)` at end.
      This duplicates the entire condition bytecode (~40 bytes for mandelbrot).
      Use single-test form: `(block $brk (loop $loop (br_if $brk (eqz cond)) body (br $loop)))`.
      One condition evaluation per iteration, same semantics.
      Mandelbrot: 221→~170 bytes from this alone.

* [x] **K. Elide `local.tee` when value unused** — patterns like `local.tee $x ... drop`
      should be `local.set $x`. Peephole pass on IR before WAT emission.

* [x] **L. Use `select` for pure ternaries** — `a ? b : c` where b,c are side-effect-free →
      WASM `select` instruction (branchless, 1 byte opcode vs if/then/else structure).

### Tier 2: Peephole / strength reduction

* [x] **M. CSE for repeated subexpressions** — mandelbrot computes `zx*zx` and `zy*zy` twice
      (condition + body). Hoist to locals. Saves ~20 bytes + 2 f64.mul per iteration.

* [x] **N. `local.set` + `local.get` → `local.tee`** — many emit patterns store then immediately
      load. Peephole fusion saves 2-3 bytes per site.

* [x] **O. Inline tiny stdlib helpers** — `__is_truthy`, `__ptr_type`, `__ptr_offset` are
      3-5 instructions each. Inline at call site when called ≤N times to eliminate call overhead.
      Saves both size (no function entry/type) and perf (no call frame).

* [x] **P. Dead local elimination** — temps created by `temp()`/`tempI32()` but unused after
      constant folding or optimization should not appear in local declarations.

* [x] **Q. Compact integer encoding** — ensure LEB128 encoding is minimal. Check watr output
      for over-wide encodings of small constants.

### Tier 3: Structural

* [x] **R. Data segment deduplication** — static strings like "NaN", "Infinity", "true", "false"
      should share one data segment. Currently each compilation includes full string table even
      if only "NaN" is used. Gate segments on actual string usage.

* [x] **S. Function-level dead code elimination** — stdlib functions included via `inc()` but
      never actually called should be stripped. Walk call graph from exports, keep only reachable.

* [x] **T. Type section compaction** — deduplicate identical function types. Multiple functions
      with same signature (f64→f64) should share one type entry.

* [x] **U. Multi-value for ephemeral destructuring** — `let [a,b] = f()` where `f` returns
      multi-value: `emitDecl` detects temp→index pattern and emits direct call + local.set,
      skipping allocPtr + __mkptr + heap stores/loads entirely.

### Codegen issues

* [x] **A. Boolean propagation** — `toBoolFromEmitted()` checks `e.type === 'i32'` upfront,
      skips `__is_truthy` when input is already i32.

* [x] **B. Postfix `i++` in void context** — detects `_expect === 'void'` + `isPostfix()`,
      emits just `++i`/`--i` without subtract+drop.

* [x] **C. Unnecessary i32↔f64 conversions** — both fixed:
      1. `asF64` converts `(i32.const N)` → `(f64.const N)` directly.
      2. `analyzeLocals` `widenPass` widens i32 locals compared against f64.

* [x] **D. Array indexing: call-site type propagation** — for non-exported internal functions,
      scan all call sites; if all callers agree on a param's type (array, typed, string, etc.),
      propagate to `ctx.func.valTypes` so `[]`/`.length` emitters use monomorphic fast paths.
      Removes polymorphic dispatch when param type is statically determinable.

* [x] **E. Unconditional allocator inclusion** — gated on `needsMemory`: allocator only included
      when stdlib functions actually use memory. Pure `add(a,b) => a+b` now 50 bytes (was 230).

* [x] **F. Loop-invariant `__length`/`__ptr_offset` hoisted in manual for-loops** —
      `for (let i = 0; i < arr.length; i++)` hoists `.length` to init block as local.


### Bugs

* [x] Regex greedy backtrack gives back 1 byte regardless of pattern width — `module/regex.js:256`: fixed to use `patternMinLen(node)` for correct multi-char backtracking.
* [x] Regex split never grows past 8 elements — `module/regex.js:815`: added grow logic (double capacity + copy) when count >= cap.
* [x] `JSON.stringify` emits `{}` for all objects — fixed: HASH/MAP iterate slots via `__json_hash` WAT; OBJECT uses runtime schema name table (`__json_obj` + `$__schema_tbl` init in `__start`). 6 new tests added.

### Fragility

* [x] `__typed_idx` overwrite pattern — both `array.js` and `typedarray.js` now carry the full dispatch tree (intentionally duplicated: array.js is the runtime-complete fallback for external typed arrays when typedarray module isn't loaded).

### Redundancy — easy

* [x] `usesDynProps` defined identically in `compile.js` and `core.js` — exported from compile.js, imported in core.js
* [x] `inc('__typed_idx')` called 7 times in array.js — hoisted to module init
* [x] `inc('__is_truthy')` inside each array callback method — hoisted to module init
* [x] `core.js` uses raw hex `0x7FF8000000000001` in WAT strings — replaced with `${UNDEF_NAN}` / `${NULL_NAN}` template variables
* [x] `ctx.schema.vars.get(name) → ctx.schema.list[id]` two-liner — added `ctx.schema.resolve(name)` in schema.js, used in object.js and compile.js
* [x] `.shift`/`.unshift`/`.flat`/`.join` — replaced with `arrMethod` factory mirroring `strMethod`

### Redundancy — medium

* [-] Collection probe generators — skipped: shared part is only 4 lines, each generator has different type guard logic
* [-] `$__is_str_ptr` WAT helper — skipped: identical to existing `__is_str_key`, no new helper needed
* [x] `UNDEF_NAN`/`NULL_NAN` WAT expansion — added `UNDEF_WAT`/`NULL_WAT` JS string constants for WAT templates
* [x] `__typed_idx` element-dispatch tree duplicated — kept intentionally: both array.js and typedarray.js need full dispatch for different scenarios (external typed arrays vs explicit TypedArray usage)

### Optimizations


### Audit (structural)

**Bugs / correctness**

* [x] **`STDLIB_DEPS.__write_val` defined twice** — merged into single entry at [src/ctx.js:112](../src/ctx.js#L112) with all deps: `['__ptr_type', '__write_str', '__write_num', '__write_byte', '__static_str']`.
* [x] **`||=`/`??=` global write-back returns void** — replaced inline `global.set`/`local.set` with `writeVar(name, result)` which correctly tees through temp for globals.
* [x] **Missing `?.` on `ctx.func.valTypes`** — added optional chaining at [src/compile.js](../src/compile.js) callsite.
* [x] **`_inTry` not restored on exception in catch handler** — wrapped `emitFlat(body)` in try/finally at [src/compile.js](../src/compile.js).
* [x] **`__str_eq` registered in both string.js and collection.js** — removed duplicate from collection.js; string.js owns it, collection.js uses it via `STDLIB_DEPS` transitive inclusion.
* [x] **`__typed_idx` registered in both array.js and typedarray.js** — intentional upgrade pattern: array.js registers basic version, typedarray.js overwrites with full version (aux view bit). Documented with comment in array.js.

**Structural fragility**

* [x] **Manual section index bookkeeping** — replaced 5 mutable indices + splice calls with named-slot builder (`sec.imports`, `sec.types`, `sec.memory`, etc.) in [src/compile.js](../src/compile.js); final assembly concatenates slots — no index tracking, no splice invalidation.
* [x] **WASM passthrough swallows misspelled ops** — replaced `/^[a-z]/` with `op.includes('.') || WASM_OPS.has(op)` allowlist in [src/compile.js](../src/compile.js).
* [x] **`handlers['{}']` block-vs-object allowlist** — extracted `STMT_OPS` Set in [src/analyze.js](../src/analyze.js); shared by [src/prepare.js](../src/prepare.js) `'{}'` handler and [src/compile.js](../src/compile.js) `isBlockBody`. Single source of truth — adding a statement op updates both sites.

**Dead code & residue**

* [x] **`hoistCallback` is dead** — deleted from [module/array.js](../module/array.js).
* [x] **Dead `typeof` guards** — deleted from [src/compile.js](../src/compile.js); call `reconstructArgsWithSpreads`/`buildArrayWithSpreads` directly.
* [x] **`&&=`/`??=` identical ternary branch** — collapsed: `||=` swaps then/else, `&&=`/`??=` share same order (different conditions).

**Redundancy / missing abstractions**

* [x] **Null sentinel repeated ~10 times** — extracted `nullExpr()` and `NULL_IR` in [src/compile.js](../src/compile.js); 9 sites use `nullExpr()`, 2 raw sites use `NULL_IR`.
* [x] **`valType` two-map lookup not using `keyValType`** — replaced 5 inline two-map lookups with `keyValType()` calls in [src/compile.js](../src/compile.js).
* [x] **`mutating` method lists duplicated** — extracted `SPREAD_MUTATORS` (in-place spread methods) and `BOXED_MUTATORS` (reallocating methods needing write-back) as named Sets in [src/compile.js](../src/compile.js).
* [x] **`genUpsertGrow`/`genUpsertGrowStrict` near-duplicate** — collapsed into single `genUpsertGrow(... strict)` with type guard parameter in [module/collection.js](../module/collection.js).
* [x] **`emitArrayReduce` duplicates `arrayLoop` pattern** — lifted `arrayLoop`, `elemLoad`, `elemStore` to [src/compile.js](../src/compile.js) as exports; [module/array.js](../module/array.js) and [module/math.js](../module/math.js) both import from compile.js. `emitArrayReduce` rewritten from 19 lines of manual loop to 6-line `arrayLoop` call.

**What's clean (preserve)**

* [x] **`schema.js`** — 73 lines, dual-index, structural subtyping. Best-written file in the project.
* [x] **Module boundary pattern** — every module exports a factory, registers on `ctx.core.emit` + `ctx.core.stdlib`. Rigidly uniform, easy to extend.
* [x] **`analyze.js` extraction** — clean separation of pre-analysis from emission. No side effects, purely functional.
* [x] **`makeCallback` inline optimizer** — `isPureExpr` + `substExpr` is a well-designed expression inliner with clean fallback.
* [x] **`allocPtr` unification** — single helper for 12+ previous sites. Good DRY win.
* [x] **`strMethod` factory in string.js** — table-driven method registration, cleanest pattern in the stdlib.
* [x] **Test coverage** — 32 files, ~6800 lines, covering all features including regressions and edge cases.

* [x] **Inline known callbacks in `.map`/`.filter`/`.forEach`/`.reduce`/`.find`** — pure-arrow inliner in [module/array.js:114](../module/array.js#L114) (`makeCallback`): substitutes params with fresh locals, eliminates per-iteration `__alloc(n*8+8)` + `call_indirect`. Closure-machinery fallback retained for non-literal callbacks.
* [ ] **Pass immutable closure captures as WASM params, not heap env** — [module/function.js:71-86](../module/function.js#L71-L86). Deferred — mostly subsumed by the inliner; only matters when callback is a variable, which is rare in hot loops.
* [x] **Hoist loop-invariant `arr.length` in for-of** — desugaring in [src/prepare.js](../src/prepare.js) hoists `arr` and `arr.length` once; iteration uses cached `lenVar`.
* [x] **Cache `__ptr_offset` per basic block** — cached at 12 sites: `__str_len` WAT (core.js), closure env capture + param unpack (compile.js), boxed method load+store (compile.js), Object.values/entries/assign/create (object.js), array literal push (array.js), `.concat()` source+other loops (array.js). Remaining: per-property schema reads in destructuring need ctx-level invalidation analysis.
* [ ] **Schema inference from call sites (static inline caches)** — deferred (high-complexity).
* [x] **Fuse chained `.map`/`.filter`/`.forEach`/`.reduce`** — `detectUpstream` in [module/array.js](../module/array.js) detects when receiver is a `.map()`/`.filter()` call expression. Fused patterns: `.map(f).filter(g)`, `.filter(f).map(g)`, `.map(f).forEach(g)`, `.filter(f).forEach(g)`, `.map(f).reduce(g,i)`, `.filter(f).reduce(g,i)`. Single loop, no intermediate array allocation.
* [ ] **Bump allocator can't free within a function** — deferred.
* [x] **Gate auto-included core helpers by actual use** — added per-module `inc()` calls (9 module files + targeted compile.js sites), reduced core.js blanket from 11 helpers to 3; added 8 STDLIB_DEPS entries for WAT-internal transitive deps; 815/815 tests pass.

* [x] **`ctx.schema.target` hidden side-channel** — replaced with `ctx.schema.targetStack` in [src/ctx.js](../src/ctx.js); `=` push/pop bracket the `emit(init)` call, `{}` emitter peeks the top.
* [x] **compile.js 2246 lines (12% over stated 2K target)** — extracted analysis passes into src/analyze.js (371 lines): VAL, valTypeOf, analyzeValTypes, analyzeLocals, analyzeBoxedCaptures, findFreeVars, extractParams, classifyParam, collectParamNames, T. compile.js now 1928 lines.
* [x] **Param desugaring duplicated** — extracted `classifyParam(r)` in [src/compile.js](../src/compile.js); [src/prepare.js](../src/prepare.js) `=>` and `defFunc`, plus closure `=>` in [src/compile.js](../src/compile.js) all dispatch on shared kinds (`rest|plain|default|destruct|destruct-default`).
* [x] **12+ copies of `__alloc_hdr` + `__mkptr` sequence** — added `allocPtr({type, aux, len, cap, stride})` in [src/compile.js](../src/compile.js); migrated `materializeMulti`, `buildArrayWithSpreads`, `allocArray`, `.map`/`.filter`/`.slice`/`.concat`, `Object.values`/`Object.entries`/`emitStringArray`, `new ArrayBuffer`, `new TypedArray(n)` (both branches of `from`), `TypedArray.from(arr)`, scalar `TypedArray.map`, `buf.slice`, `new Set`/`new Map`. Only remaining IR site: per-iteration pair alloc in `Object.entries` (intentionally reuses one i32 local across loop).
* [x] **Missing `tempI32()` helper** — added alongside `temp()` in [src/compile.js](../src/compile.js); used by allocPtr and migrated array.js sites.
* [x] **schema.js compile-time O(N·P) scan** — [module/schema.js](../module/schema.js): added `byKey: key→id` for O(1) dedupe in `register`; `byProp: prop→[{id,slot}]` for `find` to walk only schemas that contain the property.
* [x] **Working-tree clutter** — `output.txt`, `out.wat`, `.work/diag-*.mjs`, `.work/*.wasm` gitignored.

* [x] **Boxed capture i32/f64 mismatch** — established contract: cell locals are always `i32` in outer scope, packed with `f64.convert_i32_u` into env, unpacked with `i32.trunc_f64_u` on closure entry. `boxedAddr()` simplified.
* [x] **`Uint8Array(arr)` double-emit** — src pre-emitted into f64 local once, both branches read from it.
* [x] **Emitter prototype chain** — replaced `Object.create` with flat spread copy in `derive()`. Module inits only register (don't read) at init time, so semantically identical and metacircular-safe.
* [x] **Schema structural subtyping silent fallback** — documented 3 return-cases; ambiguous offset across schemas correctly routes to dynamic lookup (handled by `__dyn_get_expr`).
* [x] **`prepare()` god pass** — header enumerates 6 concerns; extracted `inferAssignSchema` helper.
* [x] **Module registration ordering** — `MOD_DEPS` / `includeModule` comments clarify these are auto-inclusion not strict ordering; emitters looked up lazily at emit time.
* [x] **`jzify` `swIdx` not reset** — reset at start of `jzify()` per compilation.
* [x] **research.md NaN-boxing table** — HASH row added for type=7; "free slots" count updated.

* [x] Parser (subscript/jessie)
* [x] Numbers (0.1, 0xff, 0b11, 0o77)
* [x] Arithmetic (+, -, *, /, %)
* [x] Comparisons (<, <=, >, >=, ==, !=)
* [x] Unary (-, +)
* [x] Ternary (?:)
* [x] Arrow functions (single-expression + block bodies)
* [x] Multiple exports, inter-function calls
* [x] Math module (35+ functions, constants, all tested)
* [x] Module system (named import, namespace import, default import, auto-import)
* [x] Prohibited feature detection (this, class, async, var, function, delete, etc.)
* [x] WAT output mode
* [x] CLI (compile, eval)
* [x] Minimal core architecture: ctx.js + prepare.js + compile.js + modules (no circular deps)
* [x] stdlib.js WAT implementations (to wire into new modules)
* [x] Statement bodies (let/const, return, assignment ops)
* [x] if/else, for, while, break/continue
* [x] Logical operators (&&, || with short-circuit)
* [x] ++/-- operators (prefix/postfix: ++i returns new, i++ returns old)
* [x] Function signature model (sig.params, sig.results)
* [x] Multi-value returns (profile: 'multi')
* [x] ABI profile system (scalar, multi; memory planned)
* [x] Type coercion by operator (i32/f64 dual type, pre-analysis of local types)
* [x] Bitwise operators (~, &, |, ^, <<, >>, >>>)
* [x] Named constants (true, false, null, NaN, Infinity)
* [x] Short-circuit evaluation (&&, ||)
* [x] Grouping parens fix — (a > b) & 1
* [x] Nullish coalescing (??)
* [x] switch statement
* [x] void operator
* [x] Default params (x = 5) — triggers on NaN (missing arg), not 0

### Phase 3 — Memory + NaN-boxing ✓

* [x] NaN-boxing pointer helpers (mkptr, ptr_type, ptr_aux, ptr_offset)
* [x] Bump allocator (_alloc, _reset) + memory section
* [x] Array literal `[1, 2, 3]` → allocate + fill in memory, return NaN-boxed pointer
* [x] Array indexing arr[i] → f64.load, arr[i]=x → f64.store
* [x] Auto-include memory module when arrays are used
* [x] Remove profile option — multi-value and NaN-boxing just work
* [x] Multi-value threshold (≤8 = tuple, >8 = pointer)
* [x] Pointer encoding tests for all 12 NaN-boxing types
* [x] JS roundtrip preserves NaN bits

### Remaining memory features

* [x] Array `.length` (extract from NaN-boxed aux bits)
* [x] Array as function param (pass NaN-boxed pointer, auto-extract offset)
* [x] Object literals `{ x: 1, y: 2 }` → allocate schema-based, return pointer
* [x] Object property access `obj.x` → compile-time schema lookup, f64.load
* [x] Object property write `obj.x = v` → f64.store at schema index
* [x] String literals → SSO (≤4 chars inline) + heap (>4 chars in memory)
* [x] String `.length` → aux bits (same as arrays)
* [x] String `[i]` → charCodeAt dispatch (SSO vs heap)
* [x] `.` dispatch in ptr.js (`.length` for all types, `.prop` for objects)
* [x] Schema consolidation (ctx.schemas, ctx.findPropIndex, ctx.registerSchema)
* [-] Wire stdlib.js WAT into modules — not needed, each module defines its own WAT inline

### Heap-length refactor ✓ (C-style arrays)

Principle: aux holds IMMUTABLE metadata only. Mutable state in memory. Aliases see changes.

* [x] research.md pointer table updated (ARRAY_HEAP eliminated, 2 freed type slots)
* [x] __len/__cap/__str_len/__set_len WAT helpers
* [x] .length dispatch: SSO→aux, heap string→offset-4, array/typed/set/map→offset-8
* [x] array.js: [-8:len][-4:cap][elems...] header, push/pop mutate in place
* [x] string.js heap: [-4:len][chars...] header
* [x] typed.js: [-8:len][-4:cap][data...] header, aux=elemType only
* [x] collection.js: Set/Map mutate size in memory, return same pointer
* [x] Alias-safe: push changes len, b=a; a.push(4); b.length sees change
* [x] 276 tests, 0 regressions
* [x] JS pointer helpers: jz.ptr, jz.offset, jz.type, jz.aux, jz.array, jz.read
* [x] jz.mem: fill→write, Object auto-schema, TextEncoder/Decoder, lazy dv(), Object write
* [x] NaN truthiness: if(NaN) is falsy, !NaN is true (correct JS semantics)
* [x] Ternary in expression bodies (? → ?: normalization)

### Current: Number/String methods + WASI

Goal: complete standard JS type methods, then wire console.log via WASI fd_write.
Output .wasm is standard WASI Preview 1 — runs natively on wasmtime/wasmer/deno.
jz ships a tiny polyfill for browser/Node environments without native WASI.

### Layer 1: Number→String ✓

* [x] `__itoa(n, buf) → len` — integer to decimal digits in memory (WAT)
* [x] `__ftoa(f, buf, precision, mode) → f64` — float to NaN-boxed string (WAT, uses __itoa)
* [x] Handle sign, NaN → "NaN", Infinity → "Infinity", -0 → "0"
* [x] `n.toString()` — emitter in module/number.js, calls __ftoa, returns NaN-boxed string
* [x] `n.toFixed(d)` — fixed decimal places, with proper rounding
* [x] `n.toPrecision(d)` — significant digits, auto-switches fixed/exponential
* [x] `n.toExponential(d)` — scientific notation, integer-mantissa digit extraction
* [x] `String(n)` coercion (pass-through for strings)
* [x] `${n}` coercion — __str_concat auto-coerces numbers via __to_str; template starts with empty string to ensure string dispatch

### Layer 2: Missing String methods ✓

* [x] `.charAt(i)` — wrap existing __char_at, return 1-char SSO string
* [x] `.charCodeAt(i)` — expose __char_at result as number
* [x] `.at(i)` — charAt with negative index support
* [x] `.search(str)` — indexOf wrapper
* [x] `.match(str)` — returns [match] array or 0 (null)

### Layer 3: WASI (console.log) ✓

* [x] module/wasi.js — emitters for console.log/warn/error
  * String arg → write bytes via iov struct
  * Number arg → __ftoa then write string bytes
  * Multiple args → space-separated, newline at end
  * console.log → fd=1, console.warn/error → fd=2
* [x] wasi_snapshot_preview1.fd_write import in compile
* [x] wasi.js (package root) — polyfill for browser/Node
  * Reads iov structs from memory, decodes bytes, calls console.log/warn
  * proc_exit, environ stubs
* [x] Tests: verify output in Node via polyfill
* [x] Test .wasm runs in wasmtime/wasmer natively — both pass

### Layer 4: Cleanup ✓

* [x] __ftoa rewritten: integer-based digit extraction (no float drift), __pow10/__mkstr helpers
* [x] __ftoa auto-reduces precision when scaled value exceeds i32 range
* [x] __toExp uses same integer-mantissa approach — no double-rounding
* [x] __alloc aligned to 8 bytes (fixes wasmtime alignment trap)
* [x] console.log returns f64 (0) so it works in expression-body arrows
* [x] __str_concat auto-coerces non-string operands via __to_str
* [x] analyzeLocals/analyzeValTypes stop at `=>` — no scope leaking
* [x] Closure body analyzeLocals merges into ctx.locals properly
* [x] ctx.boxed Map consistent across all assignment operators
* [x] wasi.js polyfill simplified: uses memory ref directly, browser-safe process check
* [x] Dead code removed, stale comments cleaned

## Phase 4 — Products (from plan.md)

* [ ] 4a: floatbeat — single-page demo, waveform, preset formulas
* [x] 4b: color-space/wasm — validated: lrgb2xyz/xyz2lrgb compiles (606B), exact roundtrip
* [x] 4c: digital-filter/wasm — validated: biquad.lowpass compiles (898B), matches JS output
* [x] 4c: audio-filter/wasm — validated: moog ladder compiles (1102B), correct impulse response
* [x] 4d: standard JS support — Number methods, String methods, JSON, WASI console.log, HASH type


### Core language

* [x] Optional chaining (?. and ?.[])
* [x] typeof (returns ptr type code: -1=number, 1=array, 4=string, 5=sso, 6=object)
* [x] Strings (literals, .length, [i] charCodeAt, SSO + heap)
* [x] Template literals — desugared in prepare to .concat chain

### Data structures

* [x] Array literals, indexing, mutation — NaN-boxed pointers + linear memory
* [x] Array destructuring — let [a, b] = arr
* [x] Array methods — .map, .filter, .reduce, .forEach, .find, .indexOf, .includes, .slice
* [x] Method chaining — arr.map(fn).reduce(fn, 0)
* [x] Array spread — [...a, ...b], [...a, 99]
* [x] Object literals, property access, write — schema-based NaN-boxed pointers
* [x] Object destructuring — let {x, y} = obj, let {x: alias} = obj
* [x] Rest params (...args) — array-based: rest args collected into array at call boundary
* [x] Spread operator (...arr) — in arrays, function calls, method calls
* [x] Default params (x = 5) — NaN-based detection
* [x] TypedArrays — new Float64Array(n), Int32Array, etc. (type=3, elem in aux)
* [x] Set — new Set(), .add, .has, .delete, .size (type=8, open addressing)
* [x] Map — new Map(), .set, .get, .has, .size (type=9, open addressing)
* [x] JSON.stringify — recursive type dispatch, string escaping, nested arrays, Infinity→null
* [x] JSON.parse — recursive descent, objects→HASH (type=7), dot access via __hash_get
* [x] HASH type (type=7) — dynamic string-keyed object, FNV-1a content hash, SSO-safe equality

### Functions

* [x] Closures — capture by value, NaN-boxed pointer (type=10, aux=funcIdx, offset=envPtr)
* [x] First-class functions — currying, callbacks, funcref via call_indirect + function table
* [x] Nested function definitions — depth tracking, inner arrows stay as closure values
* [x] Mutable capture (capture by reference) — memory cells for mutated vars, zero cost for immutable

### String methods

* [x] slice, substring, indexOf, includes — type-qualified dispatch (.string:slice) + runtime fallback
* [x] startsWith, endsWith, split, join — join in array.js, split returns NaN-boxed string array
* [x] trim, padStart, padEnd, repeat — trim handles ≤32 whitespace, pad cycles fill string
* [x] replace, toUpperCase, toLowerCase — replace first occurrence, ASCII case conversion
* [x] concat — __str_concat WAT, enables replace/split/join composition

### Advanced

* [x] Regex (parser, codegen, test/exec/match/replace/split) — module/regex.js: parseRegex→AST, compileRegex→WAT, search wrapper; .test/.exec/.search/.match/.replace/.split
* [x] Symbol — type=0 (ATOM), aux=atomId. Reserved 0-15 (null, undefined, future). Symbol() unique per site, Symbol.for() interned
* [x] Object.assign — schema inference + cross-copy, boxed primitives (Object.assign on arrays/strings)
* [x] Number.isNaN, isFinite, isInteger, parseInt, parseFloat + constants (EPSILON, MAX_SAFE_INTEGER, etc.)
* [x] Global isNaN, isFinite — bare identifiers resolved via GLOBALS → number module, same impl as Number.isNaN/isFinite
* [x] Array.isArray — ptr_type === ARRAY
* [x] Array.from — shallow copy via memory.copy (iterable protocol not needed for array source)
* [x] Object.keys, values, entries — compile-time schema resolution, returns NaN-boxed arrays
* [x] try/catch/throw — try_table/throw/tag (WASM EH), nested + cross-function, TCO suppressed inside try
* [x] Tail call optimization — return_call for tail-recursive direct calls
* [x] SIMD auto-vectorization — TypedArray.map() detects patterns (x*c, x+c, x&c, Math.abs, etc.), emits f64x2/f32x4/i32x4 with scalar remainder. Type-aware indexing for Int32/Float32/Uint32Array.
* [x] i32 type preservation — done via type coercion system
* [x] Pointer identity — == and != use i64 bit-equality (enables Symbol/pointer comparison, NaN==NaN is true)

### Optimizations (revisit for new arch)

* [x] Monomorphization — .length, [] indexing, method dispatch skip runtime type checks when valTypes known. valTypeOf tracks string-returning methods, slice/concat preserve caller type.
* [x] Compile-time constant folding — arithmetic (+,-,*,/,%), bitwise (&,|,^,~,<<,>>), comparisons (<,>,<=,>=). Identity elimination: x+0→x, x*1→x, x*0→0, x-0→x, x/1→x
* [x] Dead code elimination — if(true)/if(false) elide dead branches, ternary constant folding, &&/||/?? short-circuit on literals
* [x] Constant folding

### Language features (current priority)

* [x] `for...of` on arrays — desugared to indexed for loop in prepare
* [x] `for...in` on objects — compile-time unrolled over schema keys
* [x] `typeof x === 'string'` — `===`/`!==` aliased, typeof comparisons → static ptr_type checks
* [x] Object interpolation with non-numeric values — dummy hoist for schema + mem.Object getter post-instantiation
* [x] Tail-call optimization — restored: emit(expr) first, then return_call if result is direct call
* [x] Date.now, performance.now — WASI clock_time_get, polyfill in wasi.js
