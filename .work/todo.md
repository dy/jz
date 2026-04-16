### Audit (structural)

**Bugs / correctness**

* [ ] **`STDLIB_DEPS.__write_val` defined twice** — [src/ctx.js:112](../src/ctx.js#L112) and [src/ctx.js:140](../src/ctx.js#L140). Second silently wins, dropping `__write_byte` from deps. Merge into one entry: `['__ptr_type', '__write_str', '__write_num', '__write_byte', '__static_str']`.
* [ ] **`||=`/`??=` global write-back returns void** — [src/compile.js:1290](../src/compile.js#L1290): `['global.set', ...]` has no result. If `a ||= b` is used in expression position, WASM stack is wrong. Needs tee-through-temp like `writeVar` does for globals.
* [ ] **Missing `?.` on `ctx.func.valTypes`** — [src/compile.js:1634](../src/compile.js#L1634): all other callsites use `ctx.func.valTypes?.get()`. This one throws during `__start` emission when `valTypes` is null.
* [ ] **`_inTry` not restored on exception in catch handler** — [src/compile.js:1088-1101](../src/compile.js#L1088): `ctx.runtime._inTry` saved/restored without `finally`. If `emit` throws during handler compilation, `_inTry` stays dirty.
* [ ] **`__str_eq` registered in both string.js and collection.js** — [module/string.js:80](../module/string.js#L80) and [module/collection.js:347](../module/collection.js#L347). Last-loaded wins silently. Move to one owner, other uses `inc()`.
* [ ] **`__typed_idx` registered in both array.js and typedarray.js** — [module/array.js:162](../module/array.js#L162) and [module/typedarray.js:571](../module/typedarray.js#L571). typedarray version is more capable (handles aux view bit). Move to typedarray.js only, array.js uses `inc()`.

**Structural fragility**

* [ ] **Manual section index bookkeeping** — [src/compile.js:819-907](../src/compile.js#L819): 5 integer indices (`dataIdx`, `tableIdx`, `globalsIdx`, `funcsIdx`, `elemIdx`) track positions into mutable `sections` array. Each `splice()` invalidates others. Replace with named-slot builder.
* [ ] **WASM passthrough swallows misspelled ops** — [src/compile.js:1917](../src/compile.js#L1917): `/^[a-z]/.test(op)` treats any unrecognized lowercase op as raw WASM. Typos like `'lett'` silently pass through instead of erroring.
* [ ] **`handlers['{}']` block-vs-object allowlist** — [src/prepare.js](../src/prepare.js): hardcoded list of 18 statement operators. Adding a new statement form without updating this list causes it to be misinterpreted as an object literal.

**Dead code & residue**

* [ ] **`hoistCallback` is dead** — [module/array.js:52-59](../module/array.js#L52): defined but never called. Superseded by `makeCallback`. Delete.
* [ ] **Dead `typeof` guards** — [src/compile.js:1767-1769](../src/compile.js#L1767): `typeof reconstructArgsWithSpreads !== 'undefined'` guards functions defined in the same file. Can never be false. Delete.
* [ ] **`&&=`/`??=` identical ternary branch** — [src/compile.js:1276-1280](../src/compile.js#L1276): both produce the same `[thenExpr, elseExpr]` tuple. Collapse with comment explaining the conditions differ.

**Redundancy / missing abstractions**

* [ ] **Null sentinel repeated ~10 times** — `typed(['f64.reinterpret_i64', ['i64.const', NULL_NAN]], 'f64')` at 10 sites in [src/compile.js](../src/compile.js). Extract `nullExpr()` one-liner.
* [ ] **`valType` two-map lookup not using `keyValType`** — [src/compile.js:1634](../src/compile.js#L1634), [1309-1310](../src/compile.js#L1309) and 5 other sites manually write `ctx.func.valTypes?.get(x) || ctx.scope.globalValTypes?.get(x)` instead of calling existing `keyValType` helper.
* [ ] **`mutating` method lists duplicated** — [src/compile.js:1650](../src/compile.js#L1650) and [src/compile.js:1696](../src/compile.js#L1696): overlapping but different arrays with no shared constant. A new mutating method must be added to both manually.
* [ ] **`genUpsertGrow`/`genUpsertGrowStrict` near-duplicate** — [module/collection.js](../module/collection.js): ~80 lines of nearly identical WAT rehash code. Collapse to single generator with `strict` flag.
* [ ] **`emitArrayReduce` duplicates `arrayLoop` pattern** — [module/math.js:37-55](../module/math.js#L37) rolls its own loop identical in structure to `arrayLoop` in array.js. Lift `arrayLoop`+`elemLoad`/`elemStore` out of array.js closure so math.js and typedarray.js can reuse.

**What's clean (preserve)**

* [x] **`schema.js`** — 73 lines, dual-index, structural subtyping. Best-written file in the project.
* [x] **Module boundary pattern** — every module exports a factory, registers on `ctx.core.emit` + `ctx.core.stdlib`. Rigidly uniform, easy to extend.
* [x] **`analyze.js` extraction** — clean separation of pre-analysis from emission. No side effects, purely functional.
* [x] **`makeCallback` inline optimizer** — `isPureExpr` + `substExpr` is a well-designed expression inliner with clean fallback.
* [x] **`allocPtr` unification** — single helper for 12+ previous sites. Good DRY win.
* [x] **`strMethod` factory in string.js** — table-driven method registration, cleanest pattern in the stdlib.
* [x] **Test coverage** — 32 files, ~6800 lines, covering all features including regressions and edge cases.


### Optimizations



### Build & tooling

* [x] Static string literals → data segment (own memory); heap-allocate for shared memory
* [x] Metacircularity prep: Object.create isolated to derive() in ctx.js (1 function to replace)
* [x] Metacircularity: watr compilation — 8/8 WAT, 7/8 WASM binary, 1/8 valid (const.js)
* [ ] Metacircularity: watr WASM validation — 6 files fail: boxed capture i32/f64 mismatch, Uint8Array(arr) constructor
* [ ] Metacircularity: watr WASM execution — run compiled watr against watr test suite
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
* [ ] align with Crockford practices

## Phase 14: Internal Parser (Future)
- Extract minimal jz parser from subscript features
- jzify uses jessie, pure jz uses internal parser
- True metacircular bootstrap


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



## Done (scratch branch)

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
