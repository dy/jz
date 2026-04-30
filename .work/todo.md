# jz Todo

## Product / Validation

* [ ] Pick one undeniable use case and optimize around it.
* [ ] Add benchmark coverage beyond internal examples: DSP kernel, typed-array processing,
  math loop, parser/string workload, and a JS-engine comparison set.
* [ ] Add warning/error behavior for memory growth failure or configured memory limits.
* [ ] Add wasm2c/w2c2 integration tests.
* [ ] Add source maps or at least function/name-section diagnostics.
* [ ] Continue metacircular path: minimal parser or jessie fork suitable for jz.

## Backlog

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

## Size — closing the AS gap (biquad: 8.1 kB → ≤1.9 kB target)

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

### Concrete size cuts

* [ ] **Drop unconditional `inc('__sso_char', '__str_char', '__char_at',
  '__str_byteLen')`** at `module/string.js:688`. These are loaded when string
  features are enabled; the unconditional include is leftover safety.
* [ ] **Break `MOD_DEPS` cycle `number ↔ string`** at `prepare.js:1054`. Today
  any number op pulls string module (for `__num_to_str`/format), and any
  string op pulls number (for length comparisons). Make `string` an actual
  dependency only when string ops appear; format-on-print should opt-in via
  the `console`/`fd_write` path.
* [ ] **Lazy `__length` dispatch** at `module/core.js:361`. `emitLengthAccess`
  flips `features.typedarray = features.set = features.map = true` for any
  `.length` whose receiver type is unresolved. For typed-array-only programs,
  this is everything — pulls Set/Map machinery for nothing. Restrict to actual
  unresolved Set/Map sites; default unresolved to typedarray-only when
  receivers are typed-array-typed.
* [ ] **Strip data segment for non-emitted strings.** Empty `data` in jz
  biquad is 185 B for unused string literals from helpers. Tree-shake by
  emitted-helper set, not declared-helper set.
* [ ] **Replace `wasi.fd_write`/`clock_time_get` with `env.printLine` /
  `env.now`** when the host is jz's own runtime. Keep WASI for standalone
  wasm CLI use; gate behind a config flag (default on for `jz.compile`,
  default off for `jz build --wasi`).

### Per-bench gap snapshot (jz vs native, jz vs AS)

Latest full-bench run, darwin/arm64 M-class:

| case      | jz ms | nat ms | AS ms | jz×nat | jz×AS  | status      |
| ---       | ---:  | ---:   | ---:  | ---:   | ---:   | ---         |
| biquad    | 11.06 | 5.31   | 8.95  | 2.08×  | 1.23×  | behind AS   |
| mat4      |  8.59 | 2.62   | 9.14  | 3.28×  | 0.94×  | beats AS    |
| poly      |  1.13 | 0.71   | 1.13  | 1.60×  | 1.00×  | ties AS     |
| bitwise   |  8.45 | 1.30   |12.11  | 6.49×  | 0.70×  | beats AS    |
| tokenizer |  0.07 | 0.09   | 0.04  | 0.78×  | 1.75×  | beats native|
| callback  |  3.46 | 0.07   | 1.41  | 49.4×  | 2.45×  | behind AS   |
| aos       |  3.48 | 1.20   | 1.90  | 2.90×  | 1.83×  | behind AS   |
| json      |  0.53 | n/a    | n/a   | n/a    | n/a    | JS-only ref |

jz now beats AS on 2/6 wasm-comparable cases (mat4, bitwise) and ties on poly.
Remaining AS gaps by descending size: callback (2.45×), aos (1.83×),
tokenizer (1.75×), biquad (1.2×). (AS tokenizer reports DIFF checksum — not
fully apples-to-apples; jz now beats native C on tokenizer.)

### Completed perf wins (this session)

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

### Concrete optimizations

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

* [ ] **Scalar-replacement of repeated typed-array reads.** When the same
  `arr[const]` is read 2+ times in a basic block with no intervening write,
  hoist to a local. Today CSE may handle this but only if the index expression
  is identical at the IR level — verify on biquad.

* [ ] **Aggressive inlining for monomorphic single-caller hot funcs.** Today
  `processCascade` isn't inlined because it's "large." Lift the size threshold
  when the callee is non-exported, called from ≤2 sites, and call-site values
  include constants the callee's loop bounds depend on. Lets V8 specialize on
  the actual `nStages` value rather than treating it as a runtime parameter.

* [ ] **Constant-arg propagation + small-trip-count unroll.** When a callee
  param is always called with the same compile-time integer constant, propagate
  the constant into the callee. If a loop's trip count becomes a small constant,
  unroll. On biquad: `nStages = 8` is literal at every call site; unrolling the
  inner loop by 8 produces straight-line code that V8/clang vectorize trivially.

* [ ] **i32 narrowing for module-const integer args (revisit nStages).** The
  attempt this round narrowed nStages from f64 to i32 via `globalTypes` lookup
  in `exprType`; the wat shape was correct (and clang loved it: jz-w2c stayed
  at 11.4ms) but V8's wasm tier regressed to 18ms. Investigate why — likely
  V8 register-allocates differently when the inner loop has mixed i32 indices
  + f64 arithmetic. Possible fixes: (a) keep f64 ABI but auto-promote i32 const
  to f64 at call site so V8 sees uniform ABI; (b) couple narrowing with
  inlining so the param disappears entirely; (c) test on V8 with `--liftoff-only`
  vs TurboFan to see which tier regresses.

* [ ] **Loop-invariant hoist of `arr.length`.** Verify the outer loop's
  `n = x.length` is hoisted (it appears to be, based on the wat). Generalize
  to any loop-invariant call/load with no intervening side effects.

* [ ] **Bounds-check elision for monotone counters.** When `i` is i32, monotonic,
  bounded above by `arr.length` checked at loop head, V8 *should* elide per-load
  bounds checks but sometimes doesn't. Investigate what hint shape (loop
  invariant code motion, range analysis annotation) gets V8 to elide.

* [ ] **Symmetric widen-pass for length comparisons.** Mirror the existing
  `i32 counter → f64 when compared to f64 length` pass in the other direction:
  `i32 length → keep i32 when compared with i32 counter`. Already partially
  done via `.length` returning i32 for known-typed receivers; verify general
  case (Array, String, Set, Map).

### Conceptual shifts

* [ ] **Unified Type record (S2 unification, expanded scope).** Today there are
  4 parallel maps for cross-call type facts: `paramValTypes`, `paramWasmTypes`,
  `paramSchemas`, `paramTypedCtors`, plus `valueUsed` and `valueResult`. Each
  new dimension (nullability, integer-range, monomorphic-method) requires
  another parallel map + another fixpoint. Unify into a single Type record
  `{ wasmType, valKind, ptrAux, schemaId, isInteger, knownConstant, nullable,
  monoMethods }` with bidirectional inference (cf. Hindley-Milner). Body
  emission becomes parametric on the resolved record. Adding the next 5
  optimizations becomes a one-line lattice rule each, instead of a new phase.

* [ ] **NaN-box-only-at-boundaries ABI (default unboxed).** Invert the current
  "default boxed, prove unboxed" model to "default unboxed, prove polymorphism
  needs boxing." Internally every IR node carries a precise type; boxing
  happens only at: exported function entry/return, heterogeneous container
  storage, indirect calls through function-valued locals, explicit `any` sites
  (`obj[dynKey]`). 90% of `module/*.js` runtime helpers (`__to_num`,
  `__ptr_offset`, `__typed_idx`) become boundary-only, not per-use. The four
  wins this round collapse to one rule: "propagate types through const-decl
  RHS." Engineering cost is large (3-6 months of refactoring); buys codebase
  clarity more than raw perf, *unless* paired with TS-style type hints or a
  closed-world flag. Worth doing for cleanliness.

* [ ] **Tail call optimization.** No TCO today — recursive code pays full
  call-frame cost. Add for `return f(...)` patterns where caller and callee
  agree on signature. Wasm has `return_call`; gating is straightforward.

### Benchmarks that would surface remaining inefficiencies

* [ ] **Tokenizer / lexer** (string-heavy) — exposes string ABI cost: SSO/heap
  dual encoding, char-by-char access, `__str_idx` per char.

* [ ] **JSON parse + tree walk** — schema dispatch on heterogeneous objects,
  recursive call overhead, dynamic property access fallback.

* [ ] **Polymorphic reduce** — `function sum(arr) { let s = 0; for (let x of arr) s+=x }`
  called with both Array and Float64Array. Today this falls back to
  `__typed_idx` because narrowing requires monomorphic call sites; would
  surface bimorphic dispatch cost.

* [ ] **mat4 multiply** — small fixed-size loops; exposes loop-unrolling +
  offset-fusion gaps directly.

* [ ] **Closure-heavy callback** — `.map(x => x*2)` non-SIMD path; surfaces
  `VAL.CLOSURE` ABI cost. SIMD-recognized `.typed:map` already handled.

* [ ] **fib / ackermann** — call-frame and TCO overhead; today there's no TCO.

* [ ] **Bitwise crypto** (sha256, xorshift mixed with shifts) — long integer
  narrowing chains; would test the V8-wasm-tier preferences that regressed
  the nStages narrowing this round.

* [ ] **AoS → SoA struct pipeline** — array of object literals iterated
  field-by-field; surfaces schema-slot read cost vs unboxed struct fields.
