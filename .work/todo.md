# jz Todo

## Product / Validation

* [ ] Add source maps or at least function/name-section diagnostics.
* [ ] Continue metacircular path: minimal parser or jessie fork suitable for jz.
* [ ] Running wasm files without pulling jz dependency for wrapping nan-boxes: some alternative way to pass data?
* [ ] Options breakdown in readme
* [ ] Date
* [ ] Intl
* [ ] test262


## Phase 14: Internal Parser (Future)
* [ ] Extract minimal jz parser from subscript features
* [ ] jzify uses jessie, pure jz uses internal parser
* [ ] True metacircular bootstrap


### Build & tooling

* [ ] Metacircularity: subscript parser — needs jz-jessie fork excluding class/async/regex features + refactoring parse.js function-property assignments (~30 lines)
* [ ] Source maps — blocked on watr upstream; can add WASM name section (function names) independently
* [ ] jzify script converting any JZ
* [ ] jzify: auto-import stdlib globals (Math.* → `import math from 'math'`, etc.)
* [ ] jz core: require explicit imports for stdlib (remove auto-import from prepare/compile)
* [ ] align with Crockford practices
* [ ] swappable watr: likely AST will need to be stringified before compile if adapter is provided?



### Validation & quality

* [ ] color-space converter (validates multi profile)
* [ ] digital-filter biquad (validates memory profile)
* [x] JS-equivalence audit for dynamic property writes:
  - Dynamic writes to fixed-shape OBJECT fields are slot+sidecar coherent.
  - Runtime string keys on ARRAY/TYPED receivers now detect canonical indexes
    (`"0"` hits element 0, `"01"` remains a named property).
  - Numeric hot paths are guarded by WAT tests so the string-index parser is
    only emitted on runtime string-capable key paths.
* [ ] Warn/error on hitting memory limits
* [x] Excellent WASM output
* [x] wasm2c / w2c2 integration test

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


### EdgeJS PR shape

* [ ] Add an EdgeJS test/harness entry only if it can run in their CI without
  pulling large optional dependencies or network setup.


## Performance — closing the V8 gap on spread/destruct + watr

Ranked impact/effort. Reference numbers (Apple Silicon, node 22, May 2026):

| Pattern | jz | V8 | porf | jz/V8 |
|---|---|---|---|---|
| `[a,b]=[b,a]` swap (10k×5) | 0.2 ms | <0.1 ms | 96.4 ms | **~0.5×** ◐ |
| `[...a,x,...b]` concat (1k×5) | <0.1 ms | 0.2 ms | 45.6 ms | **~5.8×** ✓ |
| `(...nums) => sum` (10k×5) | 0.6 ms | 0.4 ms | 98.7 ms | **0.72×** ◐ |
| `{...base,k:v}` (1k×5) | 0.3 ms | 0.3 ms | OOM | 1.10× ✓ |
| watr.compile (24×10) | 1.46 ms | 1.67 ms | fails | 1.14× ✓ |

Items 1, 2, 6 are all variants of escape analysis — implementing it once unlocks all three.

### Escape analysis for short-lived literals (top priority)

Closes 3 of 4 V8 gaps above. V8's JIT detects the literal doesn't escape and stack-allocates / scalar-replaces; jz heap-allocates every time.

* [x] Pattern peephole: `[a,b]=[b,a]` → scalar array-literal destruct lowering in prepare; measured 0.7ms → ~0.2ms (10k×5, node 22, May 2026)
* [ ] Mark each allocation site `escapes: bool` during prepare:
  * returned, stored to outer scope, passed to non-inlined call → escapes
  * read locally and discarded → doesn't escape
* [x] Non-escaping arrays: scalar replacement for short local array literals used only by `.length`, constant indexes, and array-literal spread; spread concat measured 0.9ms → <0.1ms
* [ ] Non-escaping that can't be scalar-replaced: stack alloc, OR rewind heap on function exit
* [x] Test pin: `destruct swap` perf moves from 0.7ms toward V8's <0.1ms; current full-suite run logs ~0.2ms, and codegen test asserts no array allocation

### Per-function arena rewind (proper version of reverted `__heap_init`)

Closes the watr residual gap and any compile/transform/parse use case.

* [ ] Static analysis: function `f` whose return slot doesn't reference heap → safe to rewind
* [ ] Codegen: `__heap_save = __heap` at entry, `__heap = __heap_save` before return
* [ ] Critical: detect via return-type slot analysis when return *does* reference heap (string, array, etc.) — must NOT rewind in that case
* [ ] Test pin: revive watr `_clear()` loop in `test/perf.js` at 1.0× threshold (ratio 1.0×)
* [ ] Earlier attempt (global `_clear()`) broke watr because module-level interning tables get populated lazily during compile() — this version is per-call scoped, doesn't have that failure mode

### Inline cache for polymorphic shape sites

Generalizes the `JSON.parse(SRC)` slot-load trick (already in [src/compile.js](../src/compile.js)) to user code with bimorphic objects.

* [ ] Per-call-site cache: `lastSchemaId | slot0 | slot1` in a global word
* [ ] Fast path: schema match → direct slot load (3 instructions)
* [ ] Slow path: hash lookup, update cache
* [ ] Test pin: `poly` perf test 0.81ms → sub-0.5ms

### Stack-allocated rest-param arrays for fixed-arity sites

Subset of escape analysis. `sum(1,2,3,4,5)` calling `sum=(...nums)=>` should not heap-alloc `nums`. Porffor [does this for internal funcs](https://github.com/CanadaHonk/porffor/commit/06b984b); generalize to user code.

* [x] If `(...rest)` has no escape (no return, no store), specialize fixed-arity internal calls so rest reads scalarize to params
* [x] At each call site with N args: rewrite to `fn$restN(arg0..argN)` clone; `rest.length` becomes const, `rest[i]` becomes param select
* [x] Test pin: `rest sum` perf 2.7ms → ~0.6ms (4.5×), near 0.5ms target

### SIMD auto-vectorization for typed-array reductions

Already have explicit SIMD; auto-vectorize the obvious cases.

* [x] Pattern-detect: simple typed-array reductions with no loop-carried scalar deps other than accumulator
* [x] Emit `f64x2` / `f32x4` / `i32x4` ops via default optimizer (level 2; can still disable with `optimize: { vectorizeLaneLocal: false }`)
* [x] Skip when feedback dep present (e.g. biquad cascade y[i] depends on y[i-1])
* [x] Test pin: `typed sum` perf 4.2ms → ~2.2ms in `test/perf.js` (1.9×; 5.4× faster than JS on latest run)

### Profile-guided specialization

Inspired by porffor's [profile-guided DCE](https://goose.icu/profile-guided-dce/) (DCE itself doesn't help jz — already statically minimal).

* [ ] `jz(src, { profile: true })` instruments every function entry to log argument types
* [ ] Run program with representative input
* [ ] Recompile with type-set per function → emit specialized variants + dispatch
* [ ] Cap N specializations (~4) to avoid code bloat

### Smaller wins (lower priority)

* [ ] Tail-call optimization — emit WASM `return_call` for tail-position calls. Already partially done (block-body); extend to expression bodies via existing `tcoTailRewrite` path
* [ ] Loop unrolling for small constant trip counts (≤8) — porffor [tried then disabled](https://github.com/CanadaHonk/porffor/commit/986c9f5) due to code-size regression; gate by body size
* [ ] Constant-fold across closure boundaries — for write-once captures (`let MASK=0xff; arr.map(x=>x&MASK)`)
* [ ] Peephole: i32↔f64 boundary minimization — fold `f64.convert_i32_s` / `i32.trunc_sat_f64_s` round-trips post-emit

### Out of scope / explicitly skipped

* Wasm GC — porffor's design notes ([porffor-gc](https://goose.icu/porffor-gc/)) correctly identify this as impractical for stateless-shot use case
* Mark-and-sweep allocator — bump allocator is the right answer; arena rewind above is the targeted version
* Generational GC — overkill for KB-scale heaps
* JIT / tier-up — jz is AOT by design
* Profile-guided DCE — jz already statically minimal (1–8 kB binaries); pullStdlib treeshakes the stdlib, jzify only pulls reachable modules


## Done


## Performance — closing the native-language gap

Goal: match C/Zig on `mat4`, `aos`; match Rust on `bitwise`, `poly`, `json`.

Most cases are now within ~20% of native. Only **bitwise** (2.6× behind)
and **json** (4.3× behind) still have meaningful gaps — and the gaps
are well-characterized: bitwise wants wasm SIMD-128, json wants a
structural fast-path that drops NaN-boxing inside the parser.

* [x] **wasm SIMD-128 emission** — generalized lane-local vectorizer
      (`src/vectorize.js`). Recognizes ANY inner loop where each iteration
      touches `arr[i]` (load+store) and the body is built of lane-pure ops.
      Parameterized by lane type (i8x16, i16x8, i32x4, i64x2, f32x4, f64x2).
      NOT a bench-specific match — structural property check on the post-watr IR.
  - Lane-local recognizer: matches `(block $brk (loop $L (br_if $brk !cond) BODY (i++) (br $L)))`,
    requires loads/stores at `(add base (shl i K))`, requires every non-induction
    local to be either purely loop-invariant or purely lane-local (first
    access is a write — read-before-write means loop-carried scalar, bail).
  - Reduction recognizer (`tryReduceVectorize`): single-stmt body
    `S = OP(S, EXPR(arr[i], …))` with associative+commutative OP
    (i32/i64 add|xor|and|or, f32/f64 add). Lift = splat-init, SIMD prefix,
    horizontal lane-extract fold back into scalar S, scalar tail preserved.
    Float adds are reordered (ulp-level diff vs scalar — acceptable).
  - Lifter rewrites op-by-op via per-lane-type tables (`LANE_PURE`).
    Narrow lanes (i8/i16) drop right shifts (signedness mismatch hazard
    between i32.shr_u/s on a load8/16 and i{8,16}xN.shr_*).
  - Pass-gated `__phase: 'post'` — runs only after watr's CSE/inline produces
    canonical IR, never on pre-watr lowered shape.
  - Bitwise 3.45 → 1.38ms (≈1.06× of C/Rust 1.30ms, parity OK).
  - Currently OPT-IN at level 3 (`optimize: { vectorizeLaneLocal: true }`);
    OFF at level 2. Decision pending on whether to enable by default.

* [x] **monomorphic-call specialization** (poly) — already covered by
      existing `specializeBimorphicTyped` phase in narrow.js; clones
      `sum(arr)` per concrete elem ctor and rewrites call sites. Poly's
      remaining ~16% gap to Rust isn't dispatch-related.

* [~] **mat4 unroll-4 recognizer** — DEFERRED. Mat4 is already at 2.86ms,
      ~10% behind C/Zig 2.60ms. The remaining gap is V8 turbofan vs LLVM
      codegen quality, not pattern-recognition; explicit f64x2 SIMD would
      help but the absolute win is small (~0.3ms)

* [ ] **json arena/raw-u8 fast path** — biggest remaining structural gap.
      Realistic only if we restructure the parser's value-shape. Out of
      scope for this performance push; requires a separate design pass.

### Done in this push (commits 88e1944, 986c9f1, 6ad20df)

* [x] exprType: propagate module-level numeric const wasm types (1-line
      fix in src/analyze.js — 27-40% wins across every benchmark)
* [x] Source-level inliner expansion: trailing-return shape, expression-
      position substitution, factory-function guard, skip-into-exports
      (src/plan.js + src/optimize.js + tests)
* [x] Refreshed README bench numbers


##  [x] **Drop NaN-boxing as the value carrier — switch to i64-tagged.**
  Context: print regression on node 22 (b5333df) was a flaky V8 NaN-payload
  canonicalization at the wasm→JS boundary. Spec-permitted (§ToJSValue);
  V8/SpiderMonkey both occasionally do it. Today's hotfix changes
  `env.print` to take i64 + reinterpret_f64 ([module/console.js:184](../module/console.js#L184),
  [src/host.js:484](../src/host.js#L484)), but the carrier is still f64 NaN-box
  everywhere else, so the same hazard exists at every other wasm↔JS f64
  boundary (`env.setTimeout` cbPtr, generic export wrappers in
  [src/host.js wrap()](../src/host.js#L536), user `opts.imports` taking f64).

  Design intent already aligns: numeric hot path uses flat repr (raw f64
  number, i32 offset, type in analysis facts via `ptrKind`/`val` —
  [src/analyze.js:88](../src/analyze.js#L88)). NaN-boxing is the
  polymorphic/transport fallback, not the arithmetic carrier. So the
  "NaN-box keeps numeric ops free" argument is moot: numeric ops live on
  the flat path. Boxed values are rare and cold; their carrier can be i64
  without measurable cost.

  Wins over f64 NaN-box:
  - Canonicalization risk eliminated by construction at every layer (no
    boundary marshal needed; the carrier is the transport).
  - Full 64-bit budget. Today: type:4 / aux:15 / offset:32 = 51 bits in
    NaN payload. Proposed: type:8 / aux:24 / offset:32. 256 type tags,
    16M aux — kills near-term pressure on schemaId range and frees bits
    for elem-type / discriminator extensions.
  - Type-tag extraction is integer ops (`i64.shr_u`, `i32.eq`), not
    exponent-bit arithmetic on f64.
  - `i64.eq` is total — no NaN-vs-NaN inequality footgun on pointer
    equality checks.

  Costs:
  - Boxed-numeric values (rare: heterogeneous slot, untyped return) cost
    one `f64.reinterpret_i64` to operate on. On x86-64/arm64 this is a
    cross-register-file move, not free but cheap. Hot loops are flat-path
    so unaffected.
  - Migration touches: `mkPtrIR` and call sites ([src/ir.js:167](../src/ir.js#L167)),
    NULL_NAN/UNDEF_NAN constants ([src/ir.js:124](../src/ir.js#L124),
    [src/host.js:24-26](../src/host.js#L24)), `type/aux/offset` extractors
    ([src/host.js:44-46](../src/host.js#L44)), boundary `decode` routine
    ([src/host.js:32](../src/host.js#L32)), every `asF64` site that exists
    to bridge to NaN-box (some collapse to identity, others become
    `f64.reinterpret_i64`), every `f64.const nan:0x7FF...` literal
    (static SSO strings, schema sentinels, NULL/UNDEF in IR), and `wat:
    true` test snapshots.

  Suggested layout:
  ```
  i64 bits:
    [63:56] type   (8 bits)
    [55:32] aux    (24 bits)
    [31: 0] offset (32 bits)
  ```
  Sentinels (i64-eq comparable, no NaN class):
  - `null`      → `0xFF00_0000_0000_0000`
  - `undefined` → `0xFF00_0000_0000_0001`
  Reserve a high-tag pattern for "boxed number" (boxed-numeric fallback)
  if/when needed; today the flat path is the right answer for numerics.

  Migration order (each step independently shippable):
  1. Extend boundary fix to remaining f64 NaN-box edges still passing as
     f64: `env.setTimeout` cbPtr, generic export wrap in
     [src/host.js wrap()](../src/host.js#L536), user `opts.imports`
     declared with f64 carrying NaN-box. Lock the i64-at-boundary
     invariant before the internal switch.
     - 1a. [x] `env.setTimeout` cbPtr — i64 import (commit 2d3d3e6).
     - 1b. [skip] `env.clearTimeout` id — numeric f64, no NaN-box hazard.
     - 1c. [x] `__ext_prop` / `__ext_has` / `__ext_set` / `__ext_call` —
       i64 imports + reinterpret pairs at 8 call sites (commit bbc89ce).
     - 1d. [defer→2] env-globals (`(global $name (mut f64))`) and generic
       export wrap and user opts.imports all need IR-level globalTypes /
       export-signature changes that overlap Step 2's internal carrier
       switch. Tried env-globals as a standalone fix — failed because
       `readVar()` ([src/ir.js:448](../src/ir.js#L448)) tags
       `global.get` as f64 by default, mismatching the i64 declaration.
       Cleaner to absorb into Step 2 below.
  2. Switch carrier of boxed values inside compiled functions: locals,
     globals, slot reads/writes, return values. Update `mkPtrIR`, IR
     helpers, and constant emitters. Run full suite — `wat: true` test
     snapshots will need regen.
     Sub-steps:
     - 2a. [x] Add `globalTypes` tracking for host-imported globals (i64).
       Update `readVar` / `setVar` to honor it with reinterpret on read.
     - 2b. Switch wasm-export ABI from f64 → i64 for boxed-result paths
       (synthesizeBoundaryWrappers + direct exports), update host.js
       wrap() to call with BigInt args + read BigInt return.
     - 2c. [x] Switch user opts.imports declared sig from f64 → i64;
       update host wrapper at [src/host.js:565](../src/host.js#L565) to
       convert. Path: addHostImport emits i64 params/result, compile.js
       registers them in func.map with the i64 sig, emit's known-callee
       path coerces args via emitArgForParam → asParamType, which now
       handles 'i64' (asI64 reinterpret) alongside 'i32'/'f64'. Host
       wrapper reinterprets BigInt↔f64 bits on each side; pure-scalar
       modules (no memory) bypass mem.read/wrapVal via decode/coerce.
     - 2d. Switch internal stdlib boxed-value sigs (`__dyn_get`, etc.)
       from f64 to i64 module-by-module. Reinterpret at edges that still
       carry numerics.
  3. Lay out the new bit scheme (type:8 / aux:24 / offset:32). Update
     `type/aux/offset` extractors and analysis facts that hard-code the
     old widths.
  4. Audit and remove now-obsolete f64-NaN-payload literals from
     `module/*` (SSO string consts, schema sentinels) — these become
     plain `i64.const`.
  5. Reclaim bits: lift schemaId from 15→24 bits, more elem-type tags
     for typed arrays, cleaner null/undefined sentinels.
  6. Rewrite `__same_value_zero` (and `__str_eq`) to pure `i64.eq` —
     today they use `f64.eq` + NaN-detection via `i64.reinterpret_f64`
     + bit masks ([module/collection.js:391](../module/collection.js#L391)).
     With i64-tagged values, two NaN-class-free i64 values are equal iff
     `i64.eq` says so. Eliminates the entire NaN-comparison helper and
     all call sites (Set/Map/Array `.includes`, `.indexOf`, etc.).

  Independent of this: externref for **host-object handles**
  ([src/host.js:249](../src/host.js#L249) — `t === 11`). Today indexed
  via `state.extMap`; with externref params/results, the JS object
  flows through the boundary directly. Separate refactor, complementary.

### JZ-side prep

* [x] Host-import mode — `compile({ host: 'js' | 'wasi' })`.
  - `'js'` (default): `console.log` → `env.print(val,fd,sep)`,
    `Date.now`/`performance.now` → `env.now(clock)`. Host stringifies, so jz
    drops `__ftoa`/`__write_*`/`__to_str`. `jz()` auto-wires both.
  - `'wasi'`: `fd_write` + `clock_time_get`. Errors on `env.__ext_*`.
* [x] `setTimeout` / `setInterval` host-driven — `host: 'js'` lowers to
  `env.setTimeout(cb, delay, repeat) -> f64` + `env.clearTimeout(id) -> f64`
  and exports `__invoke_closure(clos) -> f64` so the JS host fires scheduled
  callbacks. Saves the entire `__timer_*` queue (~650B at small sizes).
  `host: 'wasi'` keeps the pure-WASM queue (no JS host to schedule).


* [x] `import.meta`: static `import.meta.url`, `import.meta.resolve("...")`,
  `new URL("...", import.meta.url)`, CLI entry URL plumbing, and CLI `--resolve`
  via Node ESM resolution.

# Performance

Truth: WASM only looks like the point when the compiled export owns enough hot
work. Per-iteration JS -> WASM calls mostly measure boundary overhead, not JZ
codegen quality.

* [x] Add aggressive monomorphic single-caller inlining for hot internal
  functions. Implemented as experimental `sourceInline` under `optimize: 3`,
  but measured worse on mat4/biquad due code growth and V8 tiering shape, so it
  is intentionally disabled in default level 2.
* [x] Couple constant-argument propagation with inlining/unrolling. Landed the
  safe part: ABI-preserving `intConst` substitution plus bounded small-loop
  unroll. The inlining/nested-unroll form remains experimental under level 3
  because the measured default path got slower/larger.
* [x] Audit typed-array address/base fusion on the chosen EdgeJS benchmark.
  Pinned by optimizer coverage: repeated `arr[idx + k]` becomes one shared
  address base plus `offset=` immediates where the WAT shape allows it.
* [x] Investigate bounds-check elision hints for monotone typed-array loops.
  Closed as no-actionable-code for now: without V8/Wasmtime disassembly proof,
  adding extra guard/hint shapes risks bigger WAT with no engine win. Reopen
  only with a concrete bounds-check assembly diff.
* [x] Revisit i32 narrowing for integer-heavy kernels only with tier-up data.
  Rejected for default codegen: the cleaner i32 `nStages` form repeatedly
  regressed V8 by blocking `processCascade` inlining. Keep only local/proven
  integer narrowing rules that do not perturb hot function ABI.

### Concrete size cuts

* [x] **Drop unconditional `inc('__sso_char', '__str_char', '__char_at',
  '__str_byteLen')`**. Current `module/string.js` no longer has the
  unconditional include; helpers are pulled transitively from real WAT deps.
* [x] **Break `MOD_DEPS` cycle `number ↔ string`** at `prepare.js:1054`. Today
  any number op pulls string module (for `__num_to_str`/format), and any
  string op pulls number (for length comparisons). Make `string` an actual
  dependency only when string ops appear; format-on-print should opt-in via
  the `console`/`fd_write` path. Rechecked 2026-05-04: still architecturally
  real, but smaller after emitter short-circuits. Known numeric `Number()` /
  unary `+` / `isNaN` / `isFinite` now avoid `__to_num`; unknown inputs still
  correctly keep the generic string parser. Do not break the module cycle as a
  standalone perf patch; handle it with explicit stdlib imports or host-print
  lowering so dependency semantics stay honest.

* [x] **Strip data segment for non-emitted strings.** Empty `data` in jz
  biquad was 185 B for unused string literals from helpers. Current
  `stripStaticDataPrefix` removes the built-in static string table when
  `__static_str` is not live; pure numeric and known-typed coercion probes now
  emit no data segment. Closed unless a fresh bench artifact shows leftover
  dead string data.
* [x] **Replace `wasi.fd_write`/`clock_time_get` with `env.printLine` /
  `env.now`** when the host is jz's own runtime. Keep WASI for standalone
  wasm CLI use; gate behind a config flag. Deferred out of perf cleanup: this
  is a host-contract/API mode, not a compiler optimization. Keep it under the
  JZ-side host-import-mode task, not as an unchecked perf item.

### Concrete optimizations

* [x] **Scalar-replacement of repeated typed-array reads.** When the same
  `arr[const]` is read 2+ times in a basic block with no intervening write,
  hoist to a local. Investigated: current optimizer/base fusion already handles
  the important address work, while load CSE needs alias/write-barrier proof.
  Do not add a speculative load-hoist pass without benchmark evidence.

* [x] **Aggressive inlining for monomorphic single-caller hot funcs.** Today
  `processCascade` isn't inlined because it's "large." Lift the size threshold
  when the callee is non-exported, called from ≤2 sites, and call-site values
  include constants the callee's loop bounds depend on. Implemented as
  experimental `sourceInline`; disabled by default because focused benchmarks
  showed it grew code and slowed V8. Keep for `optimize: 3` experiments only.

* [x] **i32 narrowing for module-const integer args (revisit nStages).** The
  attempt this round narrowed nStages from f64 to i32 via `globalTypes` lookup
  in `exprType`; wat was objectively cleaner (-104 B wat / -328 B wasm), and
  Liftoff confirmed the i32 form is faster (445 ms vs 555 ms baseline). But
  TurboFan compiles processCascade as a separate function in the i32 form
  while the f64 form gets inlined into main — losing interprocedural unrolling
  of the 8-stage inner loop and regressing 60% (315 ms vs 205 ms raw runtime).
  Root cause confirmed via disassembly: in `before` (f64), `func[19]` (main)
  body grows to 6048 B with processCascade inlined and unrolled 4×; in `after`
  (i32), `func[9]` (processCascade, 480 B) stays separate and runs as a call.
  The fix is correct in principle and would help any case where module-const
  integer args feed loop bounds — but V8's wasm inliner heuristic treats the
  i32 form as not-worth-inlining. Possible mitigations: (a) couple narrowing
  with explicit jz-side inlining (inline single-caller hot funcs whose body
  contains a loop bounded by an i32 const arg), so V8 never gets to choose;
  (b) keep f64 param ABI but produce two function specializations, one with
  the constant baked in, switch at call site if N is statically known; (c)
  drop the module-level globalTypes lookup but propagate const-int through
  the call-site arg list directly to the callee's analyzeIntCertain pass.
  Reverted and closed for now to preserve the V8-perf win.


* [x] **Loop-invariant hoist of other pure loads/calls.** Verify the outer loop's
  `n = x.length` is hoisted (it appears to be, based on the wat). Generalize
  to any loop-invariant call/load with no intervening side effects. Closed as
  unsafe as a generic pass without alias/effect analysis; existing sound LICM
  remains scoped to captured-cell loads and proven pointer/tag snapshots.

* [x] **Bounds-check elision for monotone counters.** When `i` is i32, monotonic,
  bounded above by `arr.length` checked at loop head, V8 *should* elide per-load
  bounds checks but sometimes doesn't. Investigate what hint shape (loop
  invariant code motion, range analysis annotation) gets V8 to elide. Closed as
  research-only until an engine-specific disassembly diff identifies a useful
  WAT shape.

* [x] **Symmetric widen-pass for length comparisons.** Mirror the existing
  `i32 counter → f64 when compared to f64 length` pass in the other direction:
  `i32 length → keep i32 when compared with i32 counter`. Already partially
  done via `.length` returning i32 for known receivers and codegen coverage for
  length/counter loops. Closed; do not add another widening pass unless a fresh
  case shows conversions inside a hot loop.

### Benchmarks that would surface remaining inefficiencies

* [x] **Polymorphic reduce** — `function sum(arr) { let s = 0; for (let x of arr) s+=x }`
  called with both Array and Float64Array. Today this falls back to
  `__typed_idx` because narrowing requires monomorphic call sites; would
  surface bimorphic dispatch cost. Covered by existing bimorphic typed-array
  specialization and callback/typed-narrow benches; no separate unchecked perf
  benchmark task remains.

* [x] **fib / ackermann** — call-frame and TCO overhead; today there's no TCO.
  TCO is now implemented for block-body and expression-bodied direct tail calls;
  keep deeper call-frame work out of the active perf TODO until a new failing
  benchmark appears.


### EdgeJS-side remaining work

* [x] Keep safe-mode out of the PR claim unless Wasmer N-API feature support is
  available in CI; current local safe-mode validation is blocked before user
  code by missing `napi_v10` / `napi_extension_wasmer_v0` features. Closed: the
  EdgeJS PR claim excludes safe mode.

### Rest

* [x] Pick one undeniable use case and optimize around it.
* [x] Add benchmark coverage beyond internal examples: DSP kernel, typed-array processing,
  math loop, parser/string workload, and a JS-engine comparison set.
* [x] Add wasm2c/w2c2 integration tests.

* [x] Rework/close PR #2 instead of merging as-is: avoid a branded `jz/edge`
  facade unless EdgeJS needs a real runtime-specific API; current patch mostly
  duplicates existing host/WASI hooks and overclaims async behavior.
* [x] Harden `jz/wasi` default output routing: if `process.stdout.write` or
  `process.stderr.write` is absent or throws, fall back to `console.log` /
  `console.warn`; keep `{ write(fd, text) }` as the canonical host override.
* [x] Add tests for stdout/stderr fallback without introducing an EdgeJS-only
  public entrypoint: no `process`, missing `process.stdout`, throwing `.write`,
  and custom `{ write }` capture.
* [x] Do not publish `instantiateAsync`: it only wrapped synchronous JZ source
  compilation with async WebAssembly startup, adding public API surface without
  new capability. Hosts that need async WASM startup can call `compile()` and
  then standard `WebAssembly.compile` / `WebAssembly.instantiate` directly.
* [x] Document the host contract in README: pure numeric JZ modules need no
  imports; console/timers currently need WASI or host imports; compile at
  startup/build time, not per request.
* [x] Add one tiny EdgeJS-compatible smoke fixture in this repo that does not
  depend on EdgeJS: compile a scalar kernel, assert no WASI imports, instantiate
  with standard WebAssembly APIs.
* [x] Build or install EdgeJS locally and verify basic JZ usage under `edge`:
  compile once at module init, instantiate per request or reuse a module, call a
  scalar export. Verified with nightly EdgeJS `0.0.0-0ff2433` / Node
  `v24.13.2`: `{ imports: 0, mac: 50, mix: 63 }`.
* [x] Verify EdgeJS safe mode behavior separately: nested `WebAssembly.Module`,
  `WebAssembly.Instance`, `WebAssembly.compile`, and memory imports inside
  Wasmer/WASIX sandbox. Current local result is blocked before the nested-WASM
  test: installed Wasmer is `4.4.0` and `wasmer --version -v` reports no
  `features:` line with `napi_v10` / `napi_extension_wasmer_v0`, so EdgeJS safe
  mode exits before user code.
* [x] Verify JZ modules with no WASI imports run in EdgeJS without any polyfill.
* [x] Verify explicit console host imports under EdgeJS without adding implicit
  host-import mode: `jz(source, { imports: { console: hostConsole } })` works
  natively in EdgeJS and is smaller than introducing a new public mode for the
  first PR. Timer imports remain future work if an EdgeJS example needs them.
* [x] Check WASM exception support for JZ `try`/`throw`/`catch` in EdgeJS. If
  exception handling is not enabled, document it as an integration limitation
  rather than adding a misleading adapter workaround. Native EdgeJS rejects the
  current JZ exception output with `Invalid opcode 0x1f (enable with
  --experimental-wasm-exnref)`; passing `--experimental-wasm-exnref` to `edge`
  did not enable it in this build.
* [x] Open a small PR to `wasmerio/edgejs` as an example/benchmark, not a core
  runtime engine change: https://github.com/wasmerio/edgejs/pull/76.
* [x] Add an example such as `examples/jz-kernel` or `examples/jz-dsp`:
  import `jz`, compile a numeric kernel once, call it from an EdgeJS script,
  and keep source short enough to read without explanation. Created local
  EdgeJS draft at `/tmp/jz-edgejs.NZ5Yow/examples/jz-kernel` with a no-import
  scalar kernel plus explicit `console` host-import smoke.
* [x] Include a short README note in the example: JZ is useful for hot numeric,
  DSP, parser, and typed-array kernels; it is not a general JS runtime or Node
  compatibility layer.
* [x] Include before/after numbers only from commands reproducible in the PR:
  EdgeJS raw JS vs EdgeJS + JZ-compiled WASM for the same kernel. The draft
  benchmark batches the hot loop inside one compiled export to avoid measuring
  JS/WASM call overhead; current typed-array mat4-style kernel result under
  local EdgeJS native: same checksum, zero imports, 919-byte WASM, raw JS
  median ~12.6 ms, JZ WASM median ~8.3 ms for 200k iterations over 9 runs.
* [x] Fix the EdgeJS draft benchmark shape: compile once, call one export, keep
  the hot loop inside the generated WASM module.
* [x] Replace or supplement the toy scalar benchmark with a stronger kernel from
  the existing suite (`mat4`, `biquad`, `tokenizer`, or a tiny typed-array DSP
  loop) so the PR demonstrates a real WASM win without overfitting a microcase.
  Replaced the draft benchmark with a small `Float64Array` 4x4 matrix kernel
  adapted from `bench/mat4`, using warmup plus median sampling.
* [x] Move `/tmp/jz-edgejs.NZ5Yow/examples/jz-kernel` into a clean EdgeJS
  branch and decide whether the PR should include only source files or also a
  lockfile for the nested example package. Branch: `dy/edgejs:jz-kernel-example`;
  final PR commit `70fbfb72`; included nested `package-lock.json` for
  reproducible `jz@0.1.1` install.
* [x] Reinstall the example dependency from a clean checkout and rerun:
  `edge index.mjs`, `edge bench.mjs`, plus Node baseline commands if the PR
  README reports Node/EdgeJS comparison output. Validated with `npm ci`,
  `node index.mjs`, `node bench.mjs`, `../../.edgejs/bin/edge index.mjs`, and
  `../../.edgejs/bin/edge bench.mjs`.
* [x] Decide CI shape: keep this PR as a documented example only unless EdgeJS
  maintainers ask for CI. A CI smoke would need installing `jz@^0.1.1` inside a
  nested example package, adding network/package-manager assumptions to a repo
  whose core examples are plain scripts.
* [x] Draft the PR description around the narrow contract: JZ compiles hot
  JS-subset kernels to WASM inside EdgeJS; it is not an EdgeJS engine provider
  and not a Node compatibility layer. Drafted in `.work/edgejs-pr-description.md`.
* [x] `npm test` passes in JZ after host/WASI changes.
* [x] `npm run test262:builtins` still passes if touched code affects built-ins
  or host output paths.
* [x] EdgeJS local smoke run passes in native mode.
* [x] EdgeJS safe-mode result is known and written down: pass, blocked by nested
  WASM, blocked by WASM exceptions, blocked by WASI/host imports, or blocked by
  missing Wasmer N-API features.
* [x] The final integration story is truthful in one sentence: "Use JZ inside
  EdgeJS to compile hot JS-subset kernels to WASM; EdgeJS remains the JS
  runtime."

* [x] Update benchmark
* [x] Ensure the proper way for template tags
* [x] Compile floatbeats
* [x] test262 coverage expansion: grow full-denominator coverage with meaningful jz features, not selected-subset pass rate
  * [x] Report overall test262 percentage against all `test262/test/**/*.js` files
  * [x] Fix object destructuring assignment regressions blocking full test suite
  * [x] Add/enable `rest-parameters` tests that map to existing jz semantics
  * [x] Add/enable `computed-property-names` object tests that map to fixed-shape objects
  * [x] Add/enable `arguments-object` tests only where jzify/function lowering truly supports them
  * [x] Add lexical/grammar coverage: `asi`, `comments`, `white-space`, `line-terminators`, `punctuators`, `directive-prologue`
  * [x] Lower braced `do-while` through jzify without body duplication; `do ; while` remains a subscript parser gap
  * [x] Keep `delete` prohibited for jz fixed-shape objects; only parser conformance belongs upstream in subscript
  * [x] Treat `debugger` as parse/no-op or explicit ignore, not a runtime feature
  * [x] Broaden the local test262 harness (`assert.*`, `Test262Error`, `compareArray`) before counting more failures
  * [x] Add/enable ordinary `template-literal` coverage; keep `tagged-template` separate unless template-object caching semantics are implemented — already works, template literal tests pass in expressions/
  * [x] Fix optional catch binding parser support (`catch { ... }`) now that `try`/`catch`/`finally` runtime support exists — source rewrite in normalizeSource + jzify codegen
  * [x] Add/enable simple `for-in` coverage for enumerable fixed-shape/HASH object keys — jzify var→let restructure for for-in, codegen handles both AST formats
  * [x] Revisit broader `arguments-object` coverage only if JS compatibility becomes a goal; current curated jzify subset is enough for core jz
  * [x] Keep broad unsupported buckets out of scope for this metric (`async`, `class`, `this`, generators, iterators, `with`, `super`, dynamic import)
## [x] speed up compiler itself (faster than eval)

### Compiler refactor notes



### Done

  * [x] Add compile-time benchmark that reports parse / prepare / plan / emit / watr separately
  * [x] Benchmark cold vs repeated template compilation; decide whether any cache is worth its complexity
  * [x] Fast-path tiny scalar programs: skip expensive whole-program narrowing phases when there are no callsites, closures, dynamic keys, schemas, or first-class function values; simple module init blocks no longer block the fast path
  * [x] Skip schema slot observation passes when no static object-literal schemas were collected
  * [x] Keep function-name membership current during prepare so call/export checks avoid repeated linear scans of `ctx.func.list`
  * [x] Replace repeated `analyzeBody` invalidation/re-walks in `narrow` with versioned fact slices or an explicit phase-state object
  * [x] Collapse duplicated callsite fixpoint passes in `narrow` into one lattice runner for wasm type, VAL kind, schema, array elem, and typed ctor facts
  * [x] Reuse caller fact maps across narrowing phases; rebuild only the slices affected by valResult / ptrKind changes
  * [x] Delay expensive typed-array bimorphic clone analysis unless a param is proven `VAL.TYPED` and has conflicting ctor observations
  * [x] Avoid remaining module init body scans after autoload when the loaded modules do not introduce facts used by the current program; value-fact scanning is already recorded during prepare
* [x] make sure it fails with error on unsupported syntaxes (class, caller, arguments etc)
* [x] Remove `compile.js` as a re-export hub; modules import directly from `ir`, `emit`, and `analyze`
* [x] Split pre-emit planning into `plan.js`, signature specialization into `narrow.js`, autoload policy into `autoload.js`, and static key folding into `key.js`
* [x] Keep `plan.js` separate from `analyze.js`; merging them would make orchestration depend on narrowing while narrowing depends on analysis helpers
* [x] Make `narrow.js` read as named phases inside one file before creating more files: reachability, param facts, result facts, pointer ABI, typed clones, dyn-key refinement
* [x] Move per-function pre-analysis out of `emitFunc` only after a measured design exists: target `emitFunc(func, funcFacts, programFacts)` with no surprise cache invalidation inside emission
* [x] Replace hidden global cache invalidation with explicit phase inputs/outputs where it reduces walks; keep global `ctx` for compile state as intended
* [x] Audit `prepare.js` for remaining hardcoded runtime-module policy; move reusable stdlib/module selection into `autoload.js` helpers, or delete the autoload policy if explicit stdlib imports become the chosen direction
* [x] Do not recreate a convenience facade in `compile.js`; noisy direct imports are preferable to hidden cross-layer coupling
* [x] Static string literals → data segment (own memory); heap-allocate for shared memory
* [x] Metacircularity prep: Object.create isolated to derive() in ctx.js (1 function to replace)
* [x] Metacircularity: watr compilation — 8/8 WAT, 7/8 WASM binary, 1/8 valid (const.js)
* [x] Metacircularity: watr WASM validation — all 5 watr modules (util/const/encode/parse/compile) validate via wasm-validate. Repro: `node ~/projects/watr/.work/repro-jz-codegen-bug.mjs`.
* [x] Metacircularity: watr WASM execution — jz-compiled watr.wasm correctly compiles all 21 examples (verified via /tmp/jz-c/watr-native). Required watr fix: `unbranch` opt at [watr/src/optimize.js:1394](../node_modules/watr/src/optimize.js#L1394) was stripping trailing `(br $loop_label)` from `loop` blocks (loop-back jump, not exit), making loops run once. Patched locally and upstream — gate on `op !== 'block'`.
* [x] console.log/warn/error
* [x] Date.now, performance.now
* [x] Import model — 3-tier: built-in, source bundling (modules option), host imports (imports option)
* [x] CLI import resolution — package.json "imports" + relative path auto-resolve
* [x] Template tag — interpolation of numbers, functions, strings, arrays, objects
* [x] Custom imports — host functions via { imports: { mod: { fn } } }
* [x] Shared memory — { memory } option, cross-module pointer sharing
* [x] Memory: configurable pages via { memoryPages: N }, auto-grow in __alloc, trap on grow failure
* [x] Template tag
### Done

* [x] Benchmarks: jz vs JS eval, assemblyscript, bun, porffor, quickjs — compile time + runtime
* [x] Benchmarks: key use cases (DSP kernel, array processing, math-heavy loop, string ops)






## Size — closing the AS gap (biquad: 8.1 kB → ≤1.9 kB target)

2026-05-02 current host-import harness after size pass:

| case | jz host | AS | delta |
| --- | ---: | ---: | ---: |
| biquad | 3482 B | 1962 B | +1520 B |
| aos | 2364 B | 2202 B | +162 B |
| mat4 | 1744 B | 1536 B | +208 B |
| tokenizer | 1618 B | 1585 B | +33 B |
| callback | 1495 B | 1906 B | -411 B |

This pass removed the biggest accidental size losses without changing benchmark
semantics: plain array growth no longer pulls `__dyn_move` / integer-hash
side-table machinery, host benchmark builds can omit raw `_alloc`/`_reset`
runtime exports, nested constant-loop unroll no longer multiplies whole loop
nests, and owned typed-array `.byteOffset` folds to `0` instead of pulling
`__byte_offset`. Remaining gap is mostly real code-shape/runtime-helper overhead;
`wasm-opt --all-features -Oz` proves more generic DCE/inlining would beat AS size
for aos/mat4/tokenizer/callback, but not biquad while preserving the current
speed-oriented code shape.

The `watr` compiler benchmark is the real bundle-size canary: the relevant JS
source bundle is ~79.5 kB, while jz's best current standalone wasm is 140,230 B
with `watr:false` and `smallConstForUnroll:false` for this case. Runtime remains
behind V8 (~1.8 ms vs ~1.5 ms in the latest focused run). External
`wasm-opt --all-features -Os` shrinks that artifact to 124,103 B and keeps
checksum, so post-link DCE/inlining is worth
integrating or matching internally. Main remaining source-level hotspot is
watr's `normalize()` / parser code built around repeated `Array.shift()` and
large callback-heavy array combinators; jz lowers these faithfully but not as
compactly as V8 optimizes them at runtime.

2026-05-04 watr perf discovery: current focused baseline is V8/node **1.42 ms**
vs jz wasm **1.87 ms** (1.31× slower, checksum parity, 139.9 kB). Existing pass
toggles do not close the gap: `watr:false + smallConstForUnroll:false` remains
best/smallest; `optimize:false` is 2.14 ms, level 1 is 1.90 ms, default level 2
is 1.84 ms at 167 kB, and aggressive level 3 is 1.94 ms. Generated WAT ranks
`normalize` as the largest function (~242 kB WAT), followed by `compile` and
many callback closures. The call profile is dominated by generic runtime
dispatch: `__ptr_offset` 311, `__len` 288, `__eq` 279, `__typed_idx`/`__str_idx`
245 each, `__arr_set_idx_ptr` 219, `__dyn_set` 206, `__is_str_key` 147, and
`__arr_shift` 121. Meaningful next work is therefore:

* [x] Identify watr-specific perf blockers with benchmark evidence; do not chase
  existing optimize toggles for this gap.
* [x] Candidate: source/runtime array-view optimization for local queue-style
  arrays (`nodes = [...nodes]`, `parts = node.slice(1)`, then `shift`/`pop`/
  `at(-1)`/`unshift`). This targets `normalize()` directly and must preserve JS
  mutation/alias semantics.
* [x] Candidate: monomorphic fast paths for proven array/string length and index
  operations to reduce `__len`, `__ptr_offset`, `__typed_idx`, and `__str_idx`
  dispatch in compiler-like code.
* [x] Candidate: callback/combinator lowering for `.map/.filter/.reduce/.flatMap`
  when the callback is local and non-escaping; watr uses these heavily during
  cleanup, import expansion, section building, and byte-vector emission.
* [x] Candidate: internal post-link DCE/inlining or wasm-opt integration for
  large generated modules; external `wasm-opt -Os` already proves about 11% size
  reduction without checksum changes.
* [x] Candidate: dynamic object/property-shape specialization for watr context
  tables and arrays with named aliases, aimed at `__dyn_get`, `__dyn_set`, and
  `__is_str_key` volume.

2026-05-04 implementation pass on queue-adjacent array fast paths:

* [x] Tried inlining known-ARRAY `.shift()` forwarding logic at call sites. It
  reduced generated watr `__arr_shift` call sites from 121 to 101, but grew the
  watr wasm from ~143.3 kB to ~147.4 kB and did not improve the official watr
  run (`jz` stayed around 1.9 ms). Rejected/reverted; do not re-open this form
  unless it is gated by a size budget or replaced by a smaller representation
  change.
* [x] Landed the safe monomorphic piece: known-ARRAY `.at(i)` now reads the
  array header length directly for negative indexes instead of dispatching
  through `__len`. Watr impact is intentionally small: `__len` call sites
  288 → 286, wasm size effectively unchanged (~143.3 kB), checksum parity held.
* [x] Checked the proposed extra-head-offset array representation. Current
  arrays already make `.shift()` O(1): `__arr_shift` slides the data pointer by
  one slot, writes a forwarding header, and contains no `memory.copy`. A
  synthetic 4096-item consume loop measured ~34 us with `.shift()` vs ~27 us
  with an explicit local `head++` index and ~33 us with `.pop()`. Adding a
  default head field would add header bytes and/or an extra add/header load to
  ordinary array indexing for a small shift-only win; not worth making the
  default representation heavier. Reopen only for a measured ring/deque case
  with interleaved `shift()` + `push()` where reusing front capacity matters.
* [x] Next meaningful queue work is not call-site inlining of `.shift()`; it is
  a representation/source transform for local queue views, or broader receiver
  fact propagation that removes many `__len`/`__ptr_offset`/index dispatches at
  once. Single-helper inlining is too small and too large.
* [x] Implemented the safe receiver-fact pieces from that follow-up:
  known-ARRAY `.map`/`.filter` now resolve `__ptr_offset` once and size from
  the array header for both allocation and iteration; known-ARRAY numeric
  indexing uses a monomorphic `__arr_idx_known` helper; and known-ARRAY spread
  (`[...arr]`) skips the string/typed runtime item dispatch. Focused watr
  helper counts after the spread specialization: `__typed_idx` 514 → 492,
  `__str_idx` 521 → 499, generated wasm ~140.2 kB → ~139.6 kB for the
  `watr:false + smallConstForUnroll:false` probe, checksum parity preserved.
  Official bench still sits around **jz 1.85-1.88 ms** vs **V8 1.48-1.50 ms**
  on local runs, so this is a real cleanup/size win but not the gap closer.
* [x] Landed a watr token-test fast path: comparisons like `x[0] === '$'`
  and `x[1] !== ';'` now compare string bytes directly (`__str_byteLen` +
  `__char_at`) instead of materializing a one-character SSO via `__str_idx`
  and then calling generic `__eq`. The fallback path for non-string receivers
  preserves array semantics. Focused helper counts: `__str_idx` 499 → 485 and
  `__eq` 279 → 272, with the expected `__char_at`/`__str_byteLen` increase.
  Current noisy official watr runs improved from the refreshed local baseline
  **jz 1.95 ms / V8 1.38 ms** to roughly **jz 1.78-1.81 ms / V8 1.41-1.43 ms**,
  checksum parity preserved. Still behind V8, but the gap is smaller.
* [x] Rejected two adjacent follow-ups after benchmarking: (1) changing the
  non-string fallback in the token-test fast path from generic `__typed_idx`
  to an ARRAY-only `__arr_idx_known` branch grew code and regressed watr
  (~1.82 ms vs ~1.78 ms in the preceding run); (2) adding a general
  string-literal equality helper (`x === 'type'`) also grew code and did not
  improve watr (~1.80 ms). Do not re-open these exact forms without a
  per-callsite size/benefit gate or inlining evidence.
* [x] Rechecked the local queue-view/source-transform proposal for `normalize()`.
  A naive `head++` rewrite is not semantics-preserving because `normalize()`
  passes the queue to `typeuse()`, `paramres()`, `blocktype()`, and `fieldseq()`,
  which all consume the same visible front with `.shift()`. Preserving semantics
  means rewriting that small consumer family together around an explicit cursor
  or adding a first-class queue-view abstraction; do not add a generic compiler
  transform for this pattern until that alias/mutation boundary is represented
  explicitly. The worthwhile future shape is a watr-source refactor or compiler
  escape analysis that proves the queue and all consuming callees are in the
  same closed local region.

Hard data on biquad (the simplest typed-array-only case, no strings/objects):

| target | wasm | functions | types | imports |
| --- | ---: | ---: | ---: | --- |
| jz   | 8293 B | 36 | 21 | wasi_snapshot_preview1.{fd_write, clock_time_get} |
| AS   | 1962 B |  6 |  7 | env.{abort, perfNow, logLine} |
| hand | 767 B  |  1 |  3 | (none beyond memory) |

The 4.2× size delta vs AS is dead weight, not arithmetic. Sources:

* **30 extra functions.** jz pulls in 43 stdlib helpers transitively through
  `inc()` from `module/*.js` even when biquad uses neither strings nor objects.
* **WASI surface.** jz emits `fd_write` + `clock_time_get` for `console.log`
  + `Date.now`/`performance.now`. AS uses two trivial env imports. Removing
  `console.log` from a bench makes both worse (no readable output); the right
  fix is not to inline a UTF-8 fd_write emitter when the only caller is one
  number-printing path. A `printNumber` host import would cut ~600 B.
* **fd_write helpers.** `__num_to_str`, `__str_byteLen`, `__sso_char`, etc.
  are loaded because `console.log(num)` formats via the string ABI. Even
  without strings in user code, the formatter pulls them in.

### json gap analysis

Latest full run after static JSON.parse lowering reports json at
**0.14 ms / 4.4 kB** for `jz` and **0.15 ms / 2.8 kB** for `jz-host` (AS
skipped), ahead of V8/node at **0.27 ms**.

The former hot path in `walk()` was dynamic property dispatch on JSON-parsed
objects: `o.items`, `o.meta.bias`, `it.id`, `it.kind`, `it.value`,
`o.meta.scale` went through the generic property-access dispatcher and then
`__map_get`/`__str_hash`/`__str_eq`. That is now gone for static JSON sources:
the emitted WAT for nested chains uses `__hash_get_local`, and the dynamic
dispatcher chain tree-shakes out of the host artifact. Remaining cost is JSON
parse/allocation/hash-table work plus repeated map probes for constant keys.
For compile-time JSON strings, that scanner is now bypassed entirely: the
emitter parses once at compile time and emits fresh HASH/ARRAY construction.

Specific opportunities, ordered by impact:

1. [x] **VAL.HASH valType + JSON.parse annotation.** Added `VAL.HASH` to the
  value-type lattice and conservatively infer `JSON.parse` result kind only
  when the input is a compile-time string literal/module const (`{` → HASH,
  `[` → ARRAY, `"` → STRING, numbers/bools → NUMBER). Known-HASH `.prop`,
  `?.prop`, and literal `obj['key']` now call `__hash_get_local` directly,
  skipping `__dyn_get_any`/`__dyn_get_expr`. JSON object construction now uses
  `__hash_set_local` because `__jp_obj` always inserts into a fresh HASH.
  Pinned by `test/json.js` codegen assertion.

1a. [x] **Nested HASH/array shape propagation.** `JSON.parse(stringConst)` now
  parses the source at compile time into a `{vt, props?, elem?}` shape tree,
  attached to the binding via `repByLocal[name].jsonShape`. `analyzeValTypes`
  walks the shape through `const items = o.items` and `const it = items[j]`,
  so deep chains keep their VAL kinds. `valTypeOf('.', expr, prop)` resolves
  via shape lookup; `emitPropAccess` (and `?.prop`, `arr[litKey]`) now route
  non-string receivers to `__hash_get_local` whenever `valTypeOf` recovers
  HASH. Pinned by `test/json.js` "nested chains stay on HASH fast path".
  Result: json `0.30 ms / 6.1 kB` jz, `0.30 ms / 4.6 kB` jz-host in the latest
  full run. Host size halved from 8.4→4.6 kB by tree-shaking the now-dead
  dyn-dispatcher chain; runtime is around V8 parity but not a stable win yet.

1b. [x] **Static `JSON.parse(stringConst)` lowering.** When the parse input is
  a string literal/module const and parses successfully at compile time, emit a
  fresh HASH/ARRAY tree directly instead of calling the runtime `__jp` scanner.
  Object nodes allocate `__hash_new` + `__hash_set_local`, array nodes allocate
  ARRAY storage directly, and primitive nodes reuse normal literal emission.
  Invalid or non-constant inputs still fall back to `__jp`. Pinned by tests for
  no `__jp` in static codegen and fresh HASH identity across repeated parses.
  Static HASH construction uses right-sized allocation plus `__hash_set_local_h`,
  so both reads and writes use compile-time key hashes and avoid `__str_hash`.
  Result: json `0.14 ms / 4.4 kB` jz, `0.15 ms / 2.8 kB` jz-host in the latest
  full run; jz now beats V8/node on json in the full suite.

2. [x] **Constant-fold `__str_hash` for SSO NaN-box literals.** Pure function
   on a known constant. Either (a) inline `__map_get` and let the existing
   peephole fold the hash call, or (b) add a `__map_get_const` variant
   that takes pre-hashed key as i32. ~15% savings on json + helps any
   map-heavy code.

3. [x] **Hoist type-tag check across same-receiver prop reads.** `it.id`,
   `it.kind`, `it.value` all dispatch on `it`'s type tag. The tag is
   loop-invariant within the inner block; hoist once per inner-loop iter
   (or once per outer if `it = items[j]` and items elem-type is known
   HASH). Generalizes beyond json to any code with repeated prop reads
    on same receiver. Implemented by splitting `__dyn_get*` into wrappers plus
    `_t` variants that take the already-computed pointer tag; call sites pass a
    stable receiver expression so the existing `hoistPtrType` pass CSEs repeated
    unknown-receiver `.prop` reads.

4. [x] **Specialize constant-key Map lookups.**
   Today `__map_get` is a generic helper called from many sites. With
   per-site specialization (constant key, known receiver type) it
    becomes inlinable. Implemented the lower-risk prehashed numeric-literal path
    first: `Map#get` on a constant number key calls `__map_get_h` and skips
    recomputing the generic f64 hash. The helper preserves EXTERNAL fallback for
    unknown receivers.

Item 2 is landed for static JSON reads/writes via `__hash_get_local_h` and
`__hash_set_local_h`. Items 3 and 4 are landed in conservative, generic forms;
full body inlining can still be revisited with a cost model if call-site counts
show it is worth the code size.

### Completed perf / cleanup wins (this session)

* [x] **Lazy `__length` dispatch** at `module/core.js:347` — already correct.
  `emitLengthAccess` only sets `features.typedarray=true` for unresolved
  receivers (not set/map; those are flipped at construction sites). The
  `__length` factory then conditionally includes set/map dispatch arms only
  when `features.set`/`features.map` are true.
* [x] **Specialize `console.log(template literal)`** ([module/console.js:103](../module/console.js#L103)).
  Template literals lower to `__str_concat` chains in prepare. console.log's
  emit handler now flattens the concat chain (`X.concat(Y).concat(Z)…` rooted
  at `['str', ...]`) into per-part `__write_str` / `__write_num` calls,
  bypassing the in-memory string assembly. Drops `__str_concat`, `__to_str`,
  `__str_byteLen`, `__str_copy`, `__str_join` from biquad. -647 B.
* [x] **Re-observe schema slots after E2 valResult** ([src/analyze.js observeProgramSlots](../src/analyze.js),
  [src/compile.js narrowSignatures](../src/compile.js)). First slot observation
  pass runs in `collectProgramFacts` before `valResult` inference, so a slot
  bound to a user-fn call (`{ ..., cs }` where `cs = checksum(out)`) gets
  observed as null. Re-running after E2 lifts `undefined` → NUMBER; observeSlot's
  first-wins-then-clash rule guarantees no regression for already-monomorphic
  slots. Drops `__write_val` from biquad (cs slot now resolves to NUMBER → direct
  `__write_num`). -88 B in biquad. Net biquad: 4983 → 4198 B (-785 B / -15.8%).
* [x] **Plain array growth does not move dynamic prop side-tables.** Known-ARRAY
  `.push` now uses `__arr_grow_known`, and both grow helpers include
  `__dyn_move` only when `__dyn_set` is live. Current host sizes: aos 3.2 kB →
  2.4 kB, callback 2.3 kB → 1.5 kB.
* [x] **Suppress runtime allocator exports for host-run standalone benches.**
  `runtimeExports:false` omits raw `_alloc` / `_reset` exports while preserving
  default JS memory wrapping behavior for normal `jz()` users.
* [x] **Do not unroll outer nested constant loops.** The small-loop unroller now
  rejects bodies containing nested loops, avoiding mat4-style multiplicative code
  growth while still preserving the inner-loop speed win where it applies.
* [x] **Owned typed-array `.byteOffset` constant-folds to zero.** This removes
  `__byte_offset` from checksum-heavy numeric benches; biquad/aos/mat4 each drop
  another 68 B in the current host harness.
* [x] **Skip `__ftoa` for integer-valued `console.log` args** ([module/console.js:135](../module/console.js#L135)).
  New `__write_int` (uses `__itoa` directly) sits beside `__write_num`; the
  template-literal-flatten emit handler dispatches to it when `exprType(part,
  ctx.func.locals) === 'i32'` (literals, bitwise ops, `.length`, `Math.imul`,
  intCertain locals). `console.log(42)`: 1737 → 849 B (-888 B / -51%).
  biquad (f64 timing args) +22 B from `__write_int` joining `__write_val`'s
  dep chain — neutral on benches with no integer console.log; massive win
  on integer-print code (bytebeat-style, counter loops). All 1105 tests pass.
* [x] **Host-import return metadata for `jz-host`** ([src/prepare.js](../src/prepare.js),
  [src/analyze.js](../src/analyze.js), [bench/bench.mjs](../bench/bench.mjs)).
  Host import specs can now declare `returns: 'number' | 'string' | 'bigint'`.
  The benchmark marks `performance.now()` as numeric, so timestamp arithmetic
  no longer pulls generic `__to_num` into every host benchmark. Biquad host:
  3.8 kB → 2.8 kB after the temporary result object was removed.
* [x] **Sort benchmark samples in place** ([bench/_lib/benchlib.js](../bench/_lib/benchlib.js)).
  Matches the native helpers: samples are not used after median calculation, so
  the extra typed-array allocation/copy was dead work. Removes `__len` from the
  small numeric `jz-host` cases. Biquad host: 2.8 kB → 2.3 kB; bitwise host:
  1.9 kB → 1.2 kB.
* [x] **Known-string concat skips generic `ToString`** ([module/string.js](../module/string.js),
  [src/emit.js](../src/emit.js)). Pure string operands now call
  `__str_concat_raw`, avoiding `__to_str`, `__static_str`, and the numeric
  string table. This lets the existing static-data-prefix strip pass actually
  fire for tokenizer. Tokenizer host: 3.3 kB → 1.6 kB.
* [x] **TCO via `return_call` for expression-bodied arrows**
  ([src/compile.js tcoTailRewrite](../src/compile.js#L110)). `emit.js`'s
  `'return'` handler already rewrote `return f(...)` to `return_call $f` —
  but expression-bodied arrows (`(n, acc) => n <= 0 ? acc : sum(n-1, acc+n)`)
  emit the body as a value-producing expression with no surrounding `return`
  op, so the existing rewriter never fired. Recursive code crashed with
  `RangeError: Maximum call stack size exceeded` even on modest depths.
  Added a tail-position IR rewriter at the bare-body emit path (compile.js
  line 1131): walks the IR root, recurses into both arms of
  `(if (result T) ...)` and last instr of `(block ...)`, rewriting any
  direct `(call $name ...)` to `(return_call $name ...)` when callee's
  result type matches caller's. Covered cases (validated): ternary tail,
  mutual recursion, `||`/`&&` tail (emit `||` desugars to if/else when
  right is a call), nested ternary, block-body return (already worked via
  the emit-handler path). `sum(100000)` now runs without overflow.
* [x] **i32 chain narrowing through user-function returns — callback breakthrough**
  ([src/analyze.js exprType](../src/analyze.js#L1149),
  [src/compile.js I phase](../src/compile.js#L626),
  [src/compile.js reachability filter](../src/compile.js#L136)).
  callback bench **0.060 ms → 0.015 ms (4× speedup)** — single-digit-µs
  region. Wins:
  - `exprType` `()` branch now consults `ctx.func.map.get(callee).sig.results`
    when the callee is a body-i32-only narrowed user function; analyzeLocals
    sees `let h = mix(...)` as i32 instead of widening to f64;
  - new I phase (post-E re-fixpoint) refreshes `callerLocals` with the
    narrowed result types, unconditionally clears `r.wasm` (clearStickyNull
    only resets null — needed full reset because first pass populated `f64`
    from stale view), re-runs `runFixpoint`, and re-applies numeric narrowing.
    `VAL.TYPED` guard preserves `specializeBimorphicTyped`'s territory;
  - reachability filter at top of `narrowSignatures` removes dead callerFunc
    entries from `callSites` (via export∪valueUsed transitive closure) so
    bundled stdlib helpers (`checksumF64 → mix(...)`) can't poison live
    callees with bimorphic facts;
  - simplified `exprTypeWithCalls` to direct `exprType` — earlier shim hard-
    coded `f64` for any non-user-narrowed call op, shadowing the stdlib
    rules (math.imul, charCodeAt) added for tokenizer.
  Result: callback's `mix(h, b[j]|0)` hot loop runs as pure-i32 FNV — h, x,
  return all i32, no per-iter f64↔i32 round-trips.
* [x] **Boundary boxing — narrow internal sigs, rebox at JS↔WASM edge**
  ([src/compile.js synthesizeBoundaryWrappers](../src/compile.js),
  [src/analyze.js shared helpers](../src/analyze.js)). Body-driven result
  narrowing extended to *exported* funcs: when body provably yields i32 /
  ptr-kind value, `sig.results[0]` becomes `i32` and a synthesized
  `$<name>$exp` wrapper restores the f64 ABI for JS callers via
  `boxNumIR` / `boxPtrIR`. Internals now operate on raw types; NaN-boxing
  becomes a *boundary* concern (swappable runtime). Bare-return guard,
  `>>>` skip (preserves uint32 semantics), and `alwaysReturns` for ptr
  narrowing keep the pass sound.
* [x] **Watr inliner soundness fix (upstream)**
  ([watr/src/optimize.js](/Users/div/projects/watr/src/optimize.js#L1394),
  [watr/test/optimize.js](/Users/div/projects/watr/test/optimize.js)).
  Inliner now refuses callees whose body contains `return` /
  `return_call` / `return_call_indirect` — control-transfer ops would
  return from the *caller's* frame with the wrong result type when the
  caller's signature differs from the callee's. Two regression tests
  pinned. Eliminates the post-watr fixWrapperReturns workaround in jz.
* [x] **AST helper consolidation** ([src/analyze.js](../src/analyze.js)).
  Extracted `isBlockBody`, `collectReturnExprs`, `alwaysReturns`,
  `hasBareReturn`, `returnExprs` as shared exports. compile.js' three
  result-narrowing loops (numeric / valType / ptr) plus
  `narrowReturnArrayElems` all reuse them. -145 lines.
* [x] **Fixpoint runner consolidation** ([src/compile.js
  runArrElemFixpoint](../src/compile.js)). `runArrFixpoint` +
  `runArrValTypeFixpoint` + `runTypedFixpoint` collapsed into a single
  parameterized `runArrElemFixpoint(field, inferFn, elemsCtxMap)`. Same
  shape, three call sites, one impl.
* [x] **`.charCodeAt(i)` returns i32 directly** ([module/string.js:785](../module/string.js#L785),
  [src/analyze.js exprType](../src/analyze.js#L770)).
  Tokenizer bench 0.14 → 0.07 ms (2× faster), jz now beats native C / Rust /
  V8 (node). jz×AS 2.50× → 1.75× (AS still reports DIFF checksum on this
  bench so not fully equivalent). Root cause: `__char_at` returns i32 but
  the emit handler wrapped it in `f64.convert_i32_u`, forcing `let c =
  s.charCodeAt(i)` to widen to f64 every char. With i32 result, the tokenizer
  hot loop (`c >= 48 && c <= 57`, `c - 48`, `number * 10 + (c - 48)`)
  stays pure-i32: 0 `__to_num` calls and 0 f64↔i32 round-trips per char.
  Bonus: closure-heavy parser golden size 3933 → 3034 bytes (-23%) since
  `c.charCodeAt(0) - 48` no longer needs f64 conversion + back-truncation.
  All 982 tests pass after expected-size update.
* [x] **Inline `arr[i]` fast path with known elem schema**
  ([module/array.js:478-499](../module/array.js#L478)). When `arr` has a
  known `arrayElemSchema` and key is known-NUMBER, skip `__arr_idx`
  (type-tag + bounds check) and emit `(f64.load (i32.add (local.tee $abN
  (call $__ptr_offset arr)) (i32.shl i 3)))` directly. Combined with the
  ptrUnbox extension (`isFreshInit` accepts `arr[i]` when elem schema known
  → `let p = rows[i]` stores p as i32 ptr, not f64 NaN-box) and a peephole
  `(i32.wrap_i64 (i64.reinterpret_f64 (f64.load X)))` → `(i32.load X)`
  ([src/optimize.js peephole](../src/optimize.js)), aos `runKernel` becomes
  pure-i32-pointer + direct f64.load. aos bench 3.94 → 3.48 ms; jz×AS
  2.10× → 1.83×. Bug fixed during impl: __ptr_offset returns i32 so the
  base local must be `tempI32`, not the default f64 `temp()`.
* [x] **LICM soundness — bail on calls + skip shared subtrees**
  ([src/optimize.js hoistInvariantCellLoads](../src/optimize.js#L348)).
  Two soundness fixes to `hoistInvariantCellLoads`:
  1. Bail if loop body contains any `call` / `call_ref` / `call_indirect` —
     the call may mutate the captured cell via a closure we can't see
     (without escape analysis we can't prove non-aliasing).
  2. Refcount IR nodes; skip read sites whose node OR parent has refcount > 1.
     Earlier passes (fusedRewrite, hoistAddrBase) introduce shared subtrees;
     mutating `parent[idx]` for a shared parent would propagate the rewrite
     to references outside the loop.
  Discovered via watr self-host bug (slice + slice-loop pattern shared
  `cell_idx` reads, mutated form leaked to outside). Threshold also
  relaxed from `<2` to `<1` (single-read hoist is OK once soundness holds).
  Tests `test/optimizer.js` pin the LICM call-soundness, shared-IR, fires-
  when-valid, and doesn't-fire-with-call cases.
* [x] **`arrayElemValType` propagation through `.map`** ([src/analyze.js
  arrayElemValType](../src/analyze.js)). Typed-array `.map(x => x*2)`
  inlined-callback `x` param now carries `valType=VAL.NUMBER`, so `__to_num`
  coercion in the callback body is elided. Callback bench 5.09 → 3.46 ms.
* [x] **Math.imul / Math.clz32 return i32 directly** ([module/math.js:105-106](../module/math.js#L105),
  [src/analyze.js exprType](../src/analyze.js#L470), [valTypeOf](../src/analyze.js#L162)).
  Bitwise bench 30.96 → 6.09 ms (5× faster, jz now beats AS 8.83 ms).
  Root cause: i32 results were rebox/unbox round-tripping through f64
  on every chained bit op; emitting i32 directly lets local widening
  narrow the entire chain to `local $x i32`. Side effects: `+ Math.imul(a,b)`
  must not trigger str-key dispatch — fix bound `valTypeOf` for `math.*`
  calls to VAL.NUMBER.
  All 976 tests pass.
* [x] **Cross-function arrayElemSchema propagation (aos)** ([src/compile.js narrowReturnArrayElemSchemas](../src/compile.js#L115),
  [src/analyze.js collectArrElemSchemas](../src/analyze.js#L251)).
  aos bench 9.79 → 4.02 ms (2.4× faster); jz vs AS gap closed from
  7× → 2.1×. Wins:
  - new `paramArrSchemas: Map<callee, Map<paramIdx, schemaId>>` in
    programFacts populated by dedicated post-E2 fixpoint;
  - new `func.arrayElemSchema` set by `narrowReturnArrayElemSchemas`
    when a non-exported `valResult === VAL.ARRAY` func always returns
    the same `Array<sid>` (resolves through call-chains, ?: and || / &&);
  - `collectArrElemSchemas` now chains through `const rows = initRows()`
    via `f.arrayElemSchema` and through `const b = a` aliases;
  - emitFunc pre-seeds rep.arrayElemSchema for narrowed params before
    `analyzeValTypes(body)` so slot reads (`p.x .y .z`) emit as direct
    `f64.load offset=0/8/16` instead of `__dyn_get` runtime helpers.
  Counts inside aos `runKernel` after fix: __is_str_key 5→1, __to_num 4→0,
  __str_concat 2→0, __typed_idx 1→0. All 976 tests pass.
* [x] **Per-iter base CSE — hoistAddrBase pass**
  ([src/optimize.js hoistAddrBase](../src/optimize.js#L194)).
  Generic `(i32.add (local.get $A) (i32.shl (local.get $B) (i32.const K)))`
  pattern is recognized region-wise (closed by re-assignment to A or B,
  by loop boundaries), and lifted to a single `(local.tee $__abN ...)` +
  subsequent `(local.get $__abN)` when ≥2 occurrences exist in the same
  region. biquad's `coeffs[c+0..4]` + `state[sb+0..3]` reads now share
  one `(local.tee $__ab0 ...)` per iteration instead of recomputing the
  base 9 times. biquad 11.36 → 11.10 ms (~2%); applies to any kernel
  with repeated indexed access on the same `(arr, idx)` pair —
  poly/aos/bitwise also benefit modestly.
* [x] **Skip `__is_str_key` on VAL.ARRAY when key is known-NUMBER**
  ([module/array.js:442](../module/array.js#L442)). Mirrors the existing
  VAL.TYPED branch at L467: when `keyType === VAL.NUMBER` (literal or
  `lookupValType(name) === VAL.NUMBER`), emit `__arr_idx(arr, asI32(idx))`
  directly. Previously the ARRAY branch unconditionally took the runtime
  str-key dispatch path for any name-key, even when the name was provably
  numeric. callback bench `b[j]` reads (after `b = a.map(closure)`) drop
  the per-iteration `__is_str_key + __dyn_get` arm. Modest gain since
  the inner loop only runs 64 iterations per outer; bigger benefit for
  callers with hot ARRAY[number-name] access.
* [x] **Bimorphic typed-array param VAL.TYPED propagation (poly)**
  ([src/compile.js H phase](../src/compile.js#L867),
  [module/array.js TYPED branch](../module/array.js#L459)).
  poly bench 6.65 → 5.52 ms (-17%); jz vs AS 5.88× → 4.88×. Wins:
  - new H-phase post-F/G re-fixpoint enriches `callerValTypes` with each
    caller's narrowed param ptrKind (`runKernel.params[0].ptrKind=TYPED`
    → `callerValTypes['f64']=VAL.TYPED`), unblocking `paramValTypes[sum][0]
    = VAL.TYPED` even when ctors disagree across call sites;
  - new `vt === 'typed'` branch in array.js `[]` emitter: when key is
    provably NUMBER, emits `__typed_idx(arr, i32_idx)` directly — skips
    `__is_str_key + __str_idx` runtime dispatch (arr provably never string);
  - cascade effect: `arr.length` → TYPED branch → i32-convertible → `i`
    + `len0` narrow to i32, inner loop becomes `i32.lt_s + __typed_idx
    + i32.add`. All 976 tests pass.
* [x] **arrayElemValType propagation through .map → callback param (callback)**
  ([src/analyze.js](../src/analyze.js), [src/compile.js](../src/compile.js),
  [module/array.js](../module/array.js)).
  callback bench 5.09 → 3.46 ms (32% faster, jz×AS 3.44× → 2.45×). Wins:
  - infer `arrayElemValType` for each VAL.ARRAY/VAL.TYPED slot
    (e.g., `Float64Array` → NUMBER, literal `[1,2,3]` analyzed per-elem);
  - `.map`/`.forEach`/`.filter`/etc. inline the callback with the param's
    `valType` pre-set to the array's elem valType, so the body skips
    `__to_num`/`__is_str_key` coercions at the inlined param;
  - `runKernel`'s inlined `x => x*scale+i` no longer wraps `x` in
    `__to_num` — straight f64 arithmetic on `local.get $inl9`.
  All 982 tests pass.
* [x] **LICM pass for boxed-cell loads — sound version**
  ([src/optimize.js hoistInvariantCellLoads](../src/optimize.js#L364)).
  When a loop body reads a captured (boxed) variable's cell N times with
  no writes and no calls, hoist a single `(local.set $__scN (f64.load
  $cell_X))` before the loop and rewrite reads to `(local.get $__scN)`.
  Soundness conditions (one-time bugs, all reproduced + regression-tested
  in [test/optimizer.js](../test/optimizer.js)):
    1. **No writes to that cell** in the loop (descending into nested
       loops to catch transitive writes).
    2. **No `call`/`call_ref`/`call_indirect`** anywhere in the loop body
       — a call could mutate the cell via another closure capturing it.
    3. **f64.load node and its immediate parent both have refcount ≤ 1** —
       earlier passes (`fusedRewrite`, `hoistAddrBase`) introduce shared
       IR subtrees; mutating a shared parent would propagate the rewrite
       to references outside the loop. Watr's `nodes.slice(idx)` shape was
       the failing case (idx read in slice-length setup AND inside the
       slice-copy loop, sharing the `i32.trunc_sat_f64_s + f64.load`
       subtree). Refcount built once per fn and consulted per site.
  Modest direct gain on callback (closures' `cell_i` reads are inside
  `call_ref` paths so bailout dominates), but unlocks the pattern for
  any future captured-loop case without sharing/calls.
* [x] **Bimorphic typed-array param specialization — function cloning (poly)**
  ([src/compile.js specializeBimorphicTyped](../src/compile.js#L898)).
  poly bench **5.06 → 1.13 ms (4.4× speedup); now ties AS** (1.13 ms),
  beats wasmtime (1.19) and jz-w2c (1.15). Wins:
  - new post-`narrowSignatures` phase walks each non-exported user fn whose
    F-phase left a typed-array param sticky-bimorphic
    (`paramTypedCtors[k] === null` from disagreeing call-site ctors);
  - re-walks call sites with caller-typed-elem + caller-typed-param maps,
    finds the per-site mono ctor, and if every site has a known ctor with
    ≥2 distinct ctors total, clones the fn once per ctor combination
    (`sum$Float64Array`, `sum$Int32Array`), narrows each clone's sig.params
    to `type='i32', ptrKind=TYPED, ptrAux=ctor.aux`, mirrors paramTypedCtors
    /paramValTypes/paramSchemas/paramArrSchemas under the clone's name with
    mono ctor at the bimorphic positions, and rewrites each call site's
    AST `node[1]` to point at the matching clone;
  - emit then takes the same monomorphic fast path as if F+G had been mono
    all along: `arr[i]` → direct `f64.load` (Float64Array) or
    `f64.convert_i32_s + i32.load` (Int32Array). Per-element `__typed_idx`
    runtime dispatch eliminated. Original `sum` becomes unreachable and
    treeshake drops it. All 976 tests pass.
  - lifted `inferArgTypedCtor` + `ctorFromAux` to file scope (were nested
    in narrowSignatures F-phase) so both phases share one canonical impl;
  - `walkFacts` now also stores the call AST node on each callSites entry
    (was only `{ callee, argList, callerFunc }`) so specialization can
    mutate `node[1]` to swap in the clone's name without re-walking trees.
  - bounded by `MAX_CLONES_PER_FN = 4` to guard against polymorphic
    blow-up; aborts if any site's bimorphic-position ctor is unknown
    (can't route safely). Original always survives — supports calls from
    inside arrow bodies (excluded from callSites) without behavior change.
## Codegen — closing the hand-WAT floor (biquad: 1.75× → 1.21× target)

Current baseline (darwin/arm64, full bench): jz biquad runs at 11.30 ms
(2.12× native), hand-WAT 6.46 ms (1.21× native), AssemblyScript 8.87 ms
(1.66× native). Gap from jz to hand-WAT is 1.75×; gap from jz to AS is
1.27×. AS gives an empirical "high-quality wasm-from-source" target.

Diagnostic: jz-w2c (jz wasm → clang -O3) runs at 11.44 ms — same as jz on
V8. So the bottleneck is the *shape of the wasm jz emits*, not V8's wasm
tier. Fixing the IR shape pays off on every wasm consumer (V8, wasmtime,
clang via wasm2c).

Items below ordered by expected impact, calibrated against the AS data
point (8.9 ms is what offset-fusion + bounds-elision + monomorphic typed
arrays gets you without unrolling).


### Conceptual shifts

### Implementation order (ratified 2026-05-01)

1. **opts.optimize layer (P4)** — level/object API gating every per-fn and
   whole-module pass. Contained, low-risk, unblocks safe per-pass
   experimentation for everything below. Half day.
2. **Unified Type record + int-default + unboxed-default (S2 above)** —
   foundational. Without it, the remaining items below are bandaids on the
   parallel-maps architecture.
3. **Schema slot inference for shorthand props (P1, ~1093 B biquad win)** —
   falls out almost free once the type lattice is unified, because slot
   types use the same inference.
4. **String-runtime tree-shake when console.log args are statically resolved
   (P3, ~2372 B biquad win)** — orthogonal to S2; can run in parallel.
5. **Induction-variable strength reduction (P2)** — mostly subsumed by
   int-default; what remains is hoisting `nStages | 0` once, which the
   optimizer handles generically when intCertain holds.


* [x] **Per-stage base hoisting + `offset=` fusion.** Done via the combination
  of (a) shl-distribute peephole `(i32.shl (i32.add x K) S) → (i32.add (i32.shl
  x S) (K<<S))` + assoc-lift-const-add at [src/optimize.js:669](../src/optimize.js#L669),
  feeding (b) `foldMemargOffsets` to absorb the constant into `offset=`, then
  (c) `hoistAddrBase` pass at [src/optimize.js:194](../src/optimize.js#L194)
  lifts the shared `(i32.add arr (i32.shl idx 3))` base to a per-iteration
  local. biquad 5 coeffs reads + 4 state reads + 4 state stores all share two
  base locals now. Did NOT close most of the 1.75× — V8 was already CSE-ing.
* [x] **General `offset=` immediate fusion.** Already in
  [src/optimize.js foldMemargOffsets](../src/optimize.js#L669): rewrites
  `(load (i32.add base (i32.const k)))` → `(load offset=k base)`. Doesn't
  yet handle the biquad shape `(i32.add base (i32.shl (i32.add idx K) 3))`
  — see follow-up below.
* [x] **Constant-arg propagation (without unroll).** When a callee param is always
  called with the same compile-time integer constant, propagate the constant into
  the callee body. ([src/analyze.js](../src/analyze.js#L95) — added `intConst` to
  ValueRep; [src/compile.js](../src/compile.js#L283) — observed in the
  cross-call fixpoint, with `ctx.scope.constInts` capturing module-scope
  `const N = <int>` decls; [src/ir.js readVar](../src/ir.js#L429) — substitutes
  every `local.get $param` with the literal). Param ABI is left untouched
  (still f64 if it was f64) — narrowing to i32 caused the V8 inliner to stop
  inlining `processCascade` (see the "i32 narrowing for nStages" entry below);
  with the conservative substitution V8 still inlines and constant-folds at the
  call site. Net effect on biquad: bench-pin neutral (8.0 ms ≈ 8.0 ms baseline)
  but `mkCoeffs` size shrinks (`n * 5` folds to `40` at compile time) and
  bytes drop -100B on biquad. Loop-unrolling the now-known-bound inner loop is
  a separate, larger task (next bullet) since it requires AST cloning and a
  size budget guard.
* [x] **Rejected: intConst-driven i32 loop narrowing for biquad.** Tried letting
  `rep.intConst` participate in `exprType` so `for (let s = 0; s < nStages; s++)`
  kept `s`, `c`, and `sb` as i32 when `nStages` is proven `8`. WAT got cleaner
  (`trunc_sat` and float offset multiplies disappeared), but V8 regressed badly:
  focused biquad went from ~8.0 ms to ~11.8-12.0 ms. Reverted the type inference
  change. Keep the ABI-preserving constant substitution in `readVar`; do not
  reintroduce i32 loop narrowing without an inliner/tier-up budget study.
  Rechecked 2026-05-02 with the narrower local-only form: `processCascade` lost
  `f64.lt`/`i32.trunc_sat_f64_s` and `$s` became i32, but focused biquad regressed
  in the current harness from ~11.4 ms to ~18.0 ms. Reverted again.
* [x] **Small-trip-count loop unroll on top of intConst.** Implemented as a
  guarded emitter transform for canonical `for (let i = 0; i < CONST; i++)`
  loops with `CONST <= 8`, no own `break`/`continue`, no nested closure, and no
  mutation/shadowing of the loop variable in the body. This keeps the f64 param
  ABI intact while baking the known trip count into straight-line code. Focused
  current-harness biquad: jz `11.32 ms / 2.3 kB` before → `6.45 ms / 3.8 kB`
  after; hand-WAT `6.47 ms / 767 B`. Pinned by `test/optimizer.js` codegen +
  control-flow guard tests.
* [x] **Loop-invariant hoist of `arr.length`.** Verified by
  [test/perf.js](../test/perf.js) codegen coverage (`.length hoisted out of
  for-loop`) and current biquad WAT: `const n = x.length` is outside the hot
  loop; there are no `__len` calls inside `processCascade`.
* [x] **Unified Type record + int-default + unboxed-default (S2).** Landed
  across S2a-d + f589994. Three conceptually-related shifts sharing the same
  dataflow infrastructure:

  **(a) Unified Type record.** Replace the 4 parallel maps for cross-call
  facts (`paramValTypes`, `paramWasmTypes`, `paramSchemas`,
  `paramTypedCtors`) plus `valueUsed`/`valueResult` with a single record
  per binding/expr:

  ```
  Type = {
    wasm:        'i32' | 'f64' | 'i64' | ptr,
    val:         NUMBER | STRING | BOOL | ARRAY | TYPED | OBJECT | CLOSURE | ANY,
    ptrAux:      number | null,        // type+aux for NaN-box ptrs
    schemaId:    number | null,        // OBJECT shape id
    elemSchema:  number | null,        // ARRAY elem shape
    elemValType: VAL    | null,        // ARRAY/TYPED elem val-kind
    intCertain:  bool,                 // *new* — proven integer-valued
    intLikely:   bool,                 // *new* — integer-shaped, unproven
    boxed:       bool,                 // *new* — NaN-boxed (vs. raw scalar/i32 ptr)
    nullable:    bool,
    knownConst:  any | undefined,
    monoMethods: Map<name, funcId> | null,
  }
  ```

  Bidirectional Hindley-Milner-style inference: forward propagate from
  literals/sources, backward propagate from sinks (`| 0`, indexing, length
  comparison, store-into-typed-array). Adding the next 10 optimizations
  becomes one lattice rule each, not one phase each.

  **(b) Int-by-default (`intCertain`/`intLikely`).** Today every numeric
  binding defaults to f64; integer-only uses pay f64↔i32 conversion at every
  op. Inverted rule: a binding is `intCertain` if every definition is one of
  {integer literal, `| 0`, `>>> 0`, `arr.length`, `.byteLength`, indexing,
  arithmetic of `intCertain` operands with no `/` and no
  `Math.{sqrt,sin,cos,…}`}. First non-int RHS poisons forward; binding falls
  back to f64. Single forward pass over each function body once
  Type-record is unified. Wins on:
  - biquad inner counter `s` (`s*5`, `s*4` integer arithmetic)
  - bytebeat formulas (`t & 0xff`, `(t >> 5) | (t * 7)`)
  - any `for (let i = 0; i < n; i++)` where n is a const or `|0`'d
  - bitwise crypto chains (no f64 round-trips)

  *Risk*: V8 TF observed 60% regression on full-i32 nStages narrowing this
  session. Mitigation: keep f64 for params at the WASM module boundary
  (export ABI stays uniform), promote to i32 only inside loop bodies where
  `intCertain` holds and the use site is i32-shaped. Couple with the
  inlining pass so the i32 form lives only in the inlined copy — engine sees
  uniform-f64 ABI at boundaries, uniform-i32 inside hot kernel.

  **(c) Unboxed-by-default ABI.** Invert "default boxed, prove unboxed" to
  "default unboxed, prove polymorphism needs boxing." Internally every IR
  node carries `boxed: false` unless it must hold a value of unknown type.
  Boxing only at: exported entry/return, heterogeneous container storage
  (mixed-type arrays, hash values), indirect calls through function-valued
  locals, explicit `any` sites (`obj[dynKey]`, `JSON.parse` results). 90% of
  `module/*.js` runtime helpers (`__to_num`, `__ptr_offset`, `__typed_idx`,
  `__is_str_key`) become boundary-only, not per-use. The 8+ specialized
  optimization passes added this session collapse to one rule:
  "propagate Type through const-decl RHS, function args, return value."

  **Status (2026-05-02)**:
  - [x] Step 1: Type record (`ValueRep`) — S2a-d (ptrKind/ptrAux, globals,
    val, schemaId all collapsed into `repByLocal`/`repByGlobal`).
  - [x] Step 2: `analyze.js` collect functions populate it.
  - [x] Step 3: `compile.js` narrowing fixpoints read/write it.
  - [x] Step 4a/4b: `intCertain` forward-prop lattice + 2 codegen rules
    (`toNumF64` skip, `Math.{floor,ceil,trunc,round}` elide). 19 unit tests
    in `test/intcertain.js`. `intLikely` not implemented (only `intCertain`).

  - [x] Step 5: per-emitter short-circuit migration — partial and closed for
    this pass. `__to_num`,
    unary `+`, global `isNaN`/`isFinite`, `Number(...)`, and `Math.*` consume
    existing numeric proofs; remaining emitters (`__ptr_offset`, `__typed_idx`,
    `__is_str_key`, `__map_get` etc.) still need case-by-case proof before
    changing their generic paths. No more speculative generic-path migrations
    should stay open without a concrete reproducer and benchmark.
  - [x] Step 6: parallel-map dedup, dead helpers removed (-697 lines
    compile.js, +568 analyze.js in f589994).
  - [x] Sub-shift (c) Unboxed-by-default ABI inversion — not landed; closed as
    architecture backlog rather than active perf cleanup.
    Current model is still "default boxed, prove unboxed"; inverting to
    "default unboxed, prove polymorphism needs boxing" is the remaining
    architectural shift. Reopen only as a planned compiler-architecture phase,
    not as a loose perf TODO.

  biquad WAT byte-identical post-landing (72,417 B); 1105 tests pass.
* [x] **Tail call optimization.** Done. Block-body `return f(...)` was
  already rewritten by emit.js's `'return'` handler; expression-bodied
  arrows now also TCO via `tcoTailRewrite` in compile.js (walks if/else
  arms + block tails, emits `return_call` when callee result type matches).
* [x] **Tokenizer / lexer** (string-heavy) — exposes string ABI cost: SSO/heap
  dual encoding, char-by-char access, `__str_idx` per char.
* [x] **JSON parse + tree walk** — schema dispatch on heterogeneous objects,
  recursive call overhead, dynamic property access fallback.
* [x] **mat4 multiply** — small fixed-size loops; exposes loop-unrolling +
  offset-fusion gaps directly.
* [x] **Closure-heavy callback** — `.map(x => x*2)` non-SIMD path; surfaces
  `VAL.CLOSURE` ABI cost. SIMD-recognized `.typed:map` already handled.
* [x] **Bitwise crypto** (sha256, xorshift mixed with shifts) — long integer
  narrowing chains; would test the V8-wasm-tier preferences that regressed
  the nStages narrowing this round.
* [x] **AoS → SoA struct pipeline** — array of object literals iterated
  field-by-field; surfaces schema-slot read cost vs unboxed struct fields.

---

## Archive

##  [x] add a separate test262 built-ins runner focused on jz functionality, not full runtime/prototype semantics
* [x] Verify `Math.random` against `test/test262/test/built-ins/Math/random/S15.8.2.14_A1.js` first; it is the only `Math.random` functionality test, while `prop-desc`, `name`, `length`, and `not-a-constructor` are metadata/runtime-shape tests to skip for now
* [x] Create `test/test262-builtins.js` with the same clone-if-missing, walk, strip-frontmatter, wrap-as-`_run`, compile, instantiate, and pass/fail/skip reporting shape as `test/test262.js`
* [x] Add a minimal built-ins assert harness: `Test262Error`, `assert`, `assert.sameValue`, `assert.notSameValue`, `assert.compareArray`, and `assert.throws`
* [x] Curate the first tracked built-ins bucket as `Math/random/S15.8.2.14_A1.js`; explicitly skip descriptor/property metadata, constructor checks, `Reflect`, `Function`, `propertyHelper`, `verifyProperty`, async, class, iterator, Symbol species/toPrimitive/iterator, Proxy, Weak*, and fixture-dependent tests
* [x] Add `npm run test262:builtins` script pointing to `node test/test262-builtins.js`
* [x] Report built-ins coverage separately from language coverage: pass/fail/skip for tracked built-ins and pass count over all `test/built-ins/**/*.js`
* [x] Run `node test/test262-builtins.js`, `node test/test262-builtins.js --filter=Math/random`, and `npm test`; fix any real functionality failures before reporting done
* [x] After `Math.random` passes, add follow-up TODOs for curated functionality subsets of `Math`, then `JSON`, `Number`, `String`, `Array`, `Object`, typed arrays, `Map`, `Set`, `RegExp`, and `Symbol`, keeping metadata/prototype semantics out unless deliberately chosen
* [x] Next built-ins pass: add curated functionality tests for implemented `Math` functions/constants only; keep descriptor/name/length/constructor/prototype tests skipped
* [x] Next built-ins pass: add curated `JSON.parse`/`JSON.stringify` functionality tests that match current object/array/string semantics; skip reviver/replacer/property-order edge cases unless verified
* [x] Next built-ins pass: add curated `Number` functionality tests for constants/conversion/predicates already implemented in `module/`; skip descriptor/prototype/spec-internal tests
* [x] Next built-ins pass: add curated `String`, `Array`, and `Object` functionality tests for methods already implemented in `module/`; skip descriptor/prototype/spec-internal tests
* [x] Next built-ins pass: add curated `Map`/`Set` functionality tests for verified `get`/`set`/`has`/`add` behavior; skip internal-slot/prototype metadata tests
* [x] Next built-ins pass: probe typed-array, `RegExp`, and `Symbol` in smaller method-specific batches before adding any test262 files; promoted verified ArrayBuffer/DataView typed-memory functionality, `RegExp.prototype.exec` unicode smoke files, and `Symbol` identity coverage. Direct `TypedArray.prototype` test262 directories remain blocked by fixture-heavy harness requirements, not simple functionality files.
