# jz Todo

Last cleaned: Apr 27 2026.

This file is the active roadmap only. Historical benchmark notes, completed phase logs,
old line-number anchors, and stale implementation claims were removed because they made
the next task harder to choose. Verify benchmark claims before using them for decisions.

Current verified baseline:

- `npm test`: 912/912 pass on Apr 27 2026.
- Compiler shape: compact and effective, but `compile.js` still owns too many phases.
- Main risk: representation facts are scattered across ctx maps, IR `.type` sidecars,
  schema state, pointer annotations, and ad hoc inference.

## Guiding Questions

- What decision makes the implementation simpler, not just faster?
- Which feature pulls generic runtime machinery into otherwise simple programs?
- Where are we recovering facts locally that should have been known once globally?
- Can the source constraint be tightened instead of adding another optimizer pass?

## Active Priorities

Architecture first. More peepholes will not fix the main complexity. The compiler needs
a cleaner substrate before pointer ABI or closure dispatch work.

### Tier S — Substrate

* [x] **ProgramFacts pass** — Apr 27. `walkFacts` (compile.js) now does one whole-program
  walk over ast + user funcs + moduleInits, collecting `dynVars/anyDyn`, `propMap`,
  `valueUsed`, closure arity (`maxDef/maxCall/hasRest/hasSpread`), and raw `callSites`
  for the type/schema fixpoint. The fixpoint no longer re-walks the AST — it iterates
  the captured call-site list. Three walks → one walk; bundled into a single
  `programFacts` object. 912/912 PASS. Compile time on watr self-host ~72 ms → ~47 ms
  median (≈35% reduction). Remaining: representation state still leaks via
  `ctx.types.dynKeyVars/anyDynKey` (read by `ir.js` at emit). Will be lifted when emit
  takes facts explicitly (paired with phase split S3).

* [ ] **ValueRep unification** — replace the current spread of `.type`, `ctx.func.valTypes`,
  `ptrKind`, `ptrAux`, `schema.vars`, `globalTypes`, and local inference with one record:
  `{ wasm, val, ptrKind, ptrAux, schemaId, nullable, stableOffset }`.

* [ ] **Explicit compile pipeline** — split `compile.js` by phase:
  `facts -> specialize signatures -> emit funcs -> emit start -> assemble module -> optimize module`.
  Each phase should have an input/output contract. Ordering should be encoded structurally,
  not remembered through comments.

* [ ] **Strict core mode** — dynamic property access, unknown receiver method calls, and
  external fallback should require explicit opt-in. This is the largest wasm-size lever:
  simple fixed-shape programs should not pay for dynamic JS compatibility.

* [ ] **Golden size tests** — add representative binary-size snapshots with tolerances:
  scalar add, known-shape object, unknown/dynamic object, closure-heavy parser, typed-array loop.
  These should catch accidental stdlib or feature-gate regressions.

### Tier A — Runtime / Output Wins

* [ ] **Internal narrow ABI** — make internal non-exported calls use the narrowest proven
  representation. Exported boundaries keep the JS-compatible f64 NaN-box ABI; internal
  code should use i32 offsets/tags where proven safe.

* [ ] **Devirtualize non-escaping closures** — `let f = (...) => ...` that is never
  reassigned or escaped should lower to a direct call with explicit env, not a closure
  pointer plus `call_indirect`.

* [ ] **CLOSURE and TYPED local unboxing** — `analyzePtrUnboxable` already has most of
  the shape. Enable only with focused tests for aux preservation, nullish comparisons,
  capture behavior, and typed-array method results.

* [ ] **Known table-slot direct calls** — replace `call_indirect` with direct `call` when
  the closure table slot is statically known and initialized exactly once.

* [ ] **Head-offset `Array.shift`** — replace O(n) `memory.copy` shift with amortized O(1)
  head offset. High leverage, high touch surface: every array index/iteration path must
  account for the shifted base.

* [x] **Fast-path `Array.push`** — Apr 27. For known-ARRAY pushes, hoist `__ptr_offset`
  once and check `cap < len + N` inline; only call `__arr_grow` (and re-extract offset)
  on the slow path. Saves call dispatch + ~14 prologue ops per push when cap fits.
  Compile-time impact within noise (still ~47–50 ms median on watr self-host). 912/912 PASS.

### Tier B — Compiler-Itself

* [x] **Fuse per-function optimize passes** — Apr 27. `fusedRewrite` now piggybacks
  local-ref counting via an optional `counts` Map; `sortLocalsByUse` reuses the
  pre-computed counts and only does its own walk when called outside `optimizeFunc`
  (whole-module path). 3 walks per function → 2 walks. 912/912, 21/21 PASS.
  `hoistPtrType` stays separate — it must run first to introduce hoisted locals
  before `fusedRewrite` inlines `__ptr_type` body bits.

* [ ] **Structural hash for closure dedup** — replace clone + `JSON.stringify` with a
  single-walk structural hash only if measurement shows it beats V8's optimized stringify
  path. Previous ad hoc rewrites regressed.

* [ ] **Cross-block pointer-type CSE** — current pointer-type CSE is local. A dominator-aware
  version may help common `if/else` dispatch shapes, but should wait until ProgramFacts.

* [ ] **Elide `argc` for fixed closures** — fixed-arity, non-default, non-rest closures do
  not need argc in their call ABI.

* [ ] **Hot stdlib partial evaluation** — specialize shapes like `__dyn_get(obj, "literal")`
  by precomputing key hash/probe skeletons. Do this after strict capability gating.

## Product / Validation

* [ ] Pick one undeniable use case and optimize around it.
* [ ] Add benchmark coverage beyond internal examples: DSP kernel, typed-array processing,
  math loop, parser/string workload, and a JS-engine comparison set.
* [ ] Add warning/error behavior for memory growth failure or configured memory limits.
* [ ] Add wasm2c/w2c2 integration tests.
* [ ] Add source maps or at least function/name-section diagnostics.
* [ ] Continue metacircular path: minimal parser or jessie fork suitable for jz.

## Deferred / No-Go

These are kept to prevent repeating bad work.

* [-] **Hoist `__ptr_offset` globally** — unsafe for ARRAY forwarding. The heap behind an
  unchanged local can move after mutation/reallocation.

* [-] **Naively inline `__ptr_type`, `__is_nullish`, or `__is_truthy` for size** — call sites
  are usually smaller than inline bit checks. Only hoist or specialize when repeated use
  amortizes the cost.

* [-] **Drop SSO for size** — short string literals are often cheaper as SSO constants than
  heap/data-segment strings plus construction.

* [-] **Rewrite upstream watr JS to push loops before fixing jz push** — previous source-level
  rewrites regressed because current spread paths are better optimized than push loops.

* [-] **Full unboxed pointer ABI now** — still promising, but too broad before ProgramFacts
  and ValueRep. Doing it now would scatter representation state further.

## Working Rule

When a task needs a stale fact from old notes, re-measure or re-read source first. Do not
optimize from memory. This compiler is small enough that wrong remembered details are more
dangerous than the cost of verification.


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
