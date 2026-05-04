# jz Todo

## Product / Validation

* [x] Pick one undeniable use case and optimize around it.
* [x] Add benchmark coverage beyond internal examples: DSP kernel, typed-array processing,
  math loop, parser/string workload, and a JS-engine comparison set.
* [x] Add wasm2c/w2c2 integration tests.
* [ ] Add source maps or at least function/name-section diagnostics.
* [ ] Continue metacircular path: minimal parser or jessie fork suitable for jz.
* [ ] Integrate into edge.js

## Backlog

* [x] Update benchmark
* [ ] Ensure the proper way for template tags
* [x] Compile floatbeats
* [ ] test262 coverage expansion: grow full-denominator coverage with meaningful jz features, not selected-subset pass rate
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

##  [x] add a separate test262 built-ins runner focused on jz functionality, not full runtime/prototype semantics
* [x] Verify `Math.random` against `test/test262/test/built-ins/Math/random/S15.8.2.14_A1.js` first; it is the only `Math.random` functionality test, while `prop-desc`, `name`, `length`, and `not-a-constructor` are metadata/runtime-shape tests to skip for now
* [x] Create `test/test262-builtins.js` with the same clone-if-missing, walk, strip-frontmatter, wrap-as-`_run`, compile, instantiate, and pass/fail/skip reporting shape as `test/test262.js`
* [x] Add a minimal built-ins assert harness: `Test262Error`, `assert`, `assert.sameValue`, `assert.notSameValue`, `assert.compareArray`, and `assert.throws`
* [x] Curate the first tracked built-ins bucket as `Math/random/S15.8.2.14_A1.js`; explicitly skip descriptor/property metadata, constructor checks, `Reflect`, `Function`, `propertyHelper`, `verifyProperty`, async, class, iterator, Symbol species/toPrimitive/iterator, Proxy, Weak*, and fixture-dependent tests
* [x] Add `npm run test262:builtins` script pointing to `node test/test262-builtins.js`
* [x] Report built-ins coverage separately from language coverage: pass/fail/skip for tracked built-ins and pass count over all `test/built-ins/**/*.js`
* [x] Run `node test/test262-builtins.js`, `node test/test262-builtins.js --filter=Math/random`, and `npm test`; fix any real functionality failures before reporting done
* [x] After `Math.random` passes, add follow-up TODOs for curated functionality subsets of `Math`, then `JSON`, `Number`, `String`, `Array`, `Object`, typed arrays, `Map`, `Set`, `RegExp`, and `Symbol`, keeping metadata/prototype semantics out unless deliberately chosen
* [ ] Next built-ins pass: add curated functionality tests for implemented `Math` functions/constants only; keep descriptor/name/length/constructor/prototype tests skipped
* [ ] Next built-ins pass: add curated `JSON.parse`/`JSON.stringify` functionality tests that match current object/array/string semantics; skip reviver/replacer/property-order edge cases unless verified
* [ ] Next built-ins pass: add curated `Number`, `String`, `Array`, and `Object` functionality tests for methods already implemented in `module/`; skip descriptor/prototype/spec-internal tests
* [ ] Next built-ins pass: add curated typed-array, `Map`, `Set`, `RegExp`, and `Symbol` functionality tests only after probing implemented behavior against local tests

* [ ] `import.meta`

## [ ] speed up compiler itself (faster than eval)
  * [x] Add compile-time benchmark that reports parse / prepare / plan / emit / watr separately
  * [x] Benchmark cold vs repeated template compilation; decide whether any cache is worth its complexity
  * [x] Fast-path tiny scalar programs: skip expensive whole-program narrowing phases when there are no callsites, closures, dynamic keys, schemas, first-class function values, or module init blocks
  * [x] Skip schema slot observation passes when no static object-literal schemas were collected
  * [x] Keep function-name membership current during prepare so call/export checks avoid repeated linear scans of `ctx.func.list`
  * [ ] Replace repeated `analyzeBody` invalidation/re-walks in `narrow` with versioned fact slices or an explicit phase-state object
  * [ ] Collapse duplicated callsite fixpoint passes in `narrow` into one lattice runner for wasm type, VAL kind, schema, array elem, and typed ctor facts
  * [ ] Reuse caller fact maps across narrowing phases; rebuild only the slices affected by valResult / ptrKind changes
  * [x] Delay expensive typed-array bimorphic clone analysis unless a param is proven `VAL.TYPED` and has conflicting ctor observations
  * [ ] Avoid scanning all module init bodies after autoload when the loaded modules do not introduce value facts used by the current program
* [ ] make sure it fails with error on unsupported syntaxes (class, caller, arguments etc)

### Compiler refactor notes

* [x] Remove `compile.js` as a re-export hub; modules import directly from `ir`, `emit`, and `analyze`
* [x] Split pre-emit planning into `plan.js`, signature specialization into `narrow.js`, autoload policy into `autoload.js`, and static key folding into `key.js`
* [x] Keep `plan.js` separate from `analyze.js`; merging them would make orchestration depend on narrowing while narrowing depends on analysis helpers
* [x] Make `narrow.js` read as named phases inside one file before creating more files: reachability, param facts, result facts, pointer ABI, typed clones, dyn-key refinement
* [ ] Move per-function pre-analysis out of `emitFunc` only after a measured design exists: target `emitFunc(func, funcFacts, programFacts)` with no surprise cache invalidation inside emission
* [ ] Replace hidden global cache invalidation with explicit phase inputs/outputs where it reduces walks; keep global `ctx` for compile state as intended
* [ ] Keep `autoload.js` honest: it owns implicit runtime-module policy; if explicit stdlib imports become the direction, delete policy instead of spreading it back into `prepare.js`
* [ ] Do not recreate a convenience facade in `compile.js`; noisy direct imports are preferable to hidden cross-layer coupling

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
* [x] Benchmarks: jz vs JS eval, assemblyscript, bun, porffor, quickjs — compile time + runtime
* [x] Benchmarks: key use cases (DSP kernel, array processing, math-heavy loop, string ops)
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

* [ ] **Strip data segment for non-emitted strings.** Empty `data` in jz
  biquad is 185 B for unused string literals from helpers. Tree-shake by
  emitted-helper set, not declared-helper set.
* [ ] **Replace `wasi.fd_write`/`clock_time_get` with `env.printLine` /
  `env.now`** when the host is jz's own runtime. Keep WASI for standalone
  wasm CLI use; gate behind a config flag (default on for `jz.compile`,
  default off for `jz build --wasi`).

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

### Completed perf wins (prior sessions)

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

* [ ] **i32 narrowing for module-const integer args (revisit nStages).** The
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
  Reverted for now to preserve the V8-perf win.

* [x] **Loop-invariant hoist of `arr.length`.** Verified by
  [test/perf.js](../test/perf.js) codegen coverage (`.length hoisted out of
  for-loop`) and current biquad WAT: `const n = x.length` is outside the hot
  loop; there are no `__len` calls inside `processCascade`.

* [ ] **Loop-invariant hoist of other pure loads/calls.** Verify the outer loop's
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
  - [ ] Step 5: per-emitter short-circuit migration — partial. `__to_num`
    and `Math.*` consume `intCertain`; remaining emitters
    (`__ptr_offset`, `__typed_idx`, `__is_str_key`, `__map_get` etc.)
    still take the generic path even when ValueRep proves monomorphic.
  - [x] Step 6: parallel-map dedup, dead helpers removed (-697 lines
    compile.js, +568 analyze.js in f589994).
  - [ ] Sub-shift (c) Unboxed-by-default ABI inversion — not landed.
    Current model is still "default boxed, prove unboxed"; inverting to
    "default unboxed, prove polymorphism needs boxing" is the remaining
    architectural shift.

  biquad WAT byte-identical post-landing (72,417 B); 1105 tests pass.

* [x] **Tail call optimization.** Done. Block-body `return f(...)` was
  already rewritten by emit.js's `'return'` handler; expression-bodied
  arrows now also TCO via `tcoTailRewrite` in compile.js (walks if/else
  arms + block tails, emits `return_call` when callee result type matches).

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

### Benchmarks that would surface remaining inefficiencies

* [x] **Tokenizer / lexer** (string-heavy) — exposes string ABI cost: SSO/heap
  dual encoding, char-by-char access, `__str_idx` per char.

* [x] **JSON parse + tree walk** — schema dispatch on heterogeneous objects,
  recursive call overhead, dynamic property access fallback.

* [ ] **Polymorphic reduce** — `function sum(arr) { let s = 0; for (let x of arr) s+=x }`
  called with both Array and Float64Array. Today this falls back to
  `__typed_idx` because narrowing requires monomorphic call sites; would
  surface bimorphic dispatch cost.

* [x] **mat4 multiply** — small fixed-size loops; exposes loop-unrolling +
  offset-fusion gaps directly.

* [x] **Closure-heavy callback** — `.map(x => x*2)` non-SIMD path; surfaces
  `VAL.CLOSURE` ABI cost. SIMD-recognized `.typed:map` already handled.

* [ ] **fib / ackermann** — call-frame and TCO overhead; today there's no TCO.

* [x] **Bitwise crypto** (sha256, xorshift mixed with shifts) — long integer
  narrowing chains; would test the V8-wasm-tier preferences that regressed
  the nStages narrowing this round.

* [x] **AoS → SoA struct pipeline** — array of object literals iterated
  field-by-field; surfaces schema-slot read cost vs unboxed struct fields.
