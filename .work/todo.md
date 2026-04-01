## Done (scratch branch)

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

## Phase 3 — Memory + NaN-boxing ✓

* [x] NaN-boxing pointer helpers (mkptr, ptr_type, ptr_aux, ptr_offset)
* [x] Bump allocator (_alloc, _reset) + memory section
* [x] Array literal `[1, 2, 3]` → allocate + fill in memory, return NaN-boxed pointer
* [x] Array indexing arr[i] → f64.load, arr[i]=x → f64.store
* [x] Auto-include memory module when arrays are used
* [x] Remove profile option — multi-value and NaN-boxing just work
* [x] Multi-value threshold (≤8 = tuple, >8 = pointer)
* [x] Pointer encoding tests for all 12 NaN-boxing types
* [x] JS roundtrip preserves NaN bits

## Remaining memory features

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

## Heap-length refactor ✓ (C-style arrays)

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

## Next: Phase 4 — Products (from plan.md)

* [ ] 4a: floatbeat — single-page demo, waveform, preset formulas
* [x] 4b: color-space/wasm — validated: lrgb2xyz/xyz2lrgb compiles (606B), exact roundtrip
* [x] 4c: digital-filter/wasm — validated: biquad.lowpass compiles (898B), matches JS output
* [x] 4c: audio-filter/wasm — validated: moog ladder compiles (1102B), correct impulse response
* [ ] 4d: standard JS support — string ops, array methods, WASI host imports (as needed by products)



## Backlog

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
* [ ] Rest params (...args) — WASM has fixed arity, deferred
* [x] Default params (x = 5) — NaN-based detection
* [x] TypedArrays — new Float64Array(n), Int32Array, etc. (type=3, elem in aux)
* [x] Set — new Set(), .add, .has, .delete, .size (type=8, open addressing)
* [x] Map — new Map(), .set, .get, .has, .size (type=9, open addressing)
* [ ] JSON.stringify, JSON.parse

### Functions

* [x] Closures — capture by value, NaN-boxed pointer (type=10, aux=funcIdx, offset=envPtr)
* [x] First-class functions — currying, callbacks, funcref via call_indirect + function table
* [x] Nested function definitions — depth tracking, inner arrows stay as closure values
* [ ] Mutable capture (capture by reference) — currently errors silently, returns stale value

### String methods

* [x] slice, substring, indexOf, includes — type-qualified dispatch (.string:slice) + runtime fallback
* [x] startsWith, endsWith, split, join — join in array.js, split returns NaN-boxed string array
* [x] trim, padStart, padEnd, repeat — trim handles ≤32 whitespace, pad cycles fill string
* [x] replace, toUpperCase, toLowerCase — replace first occurrence, ASCII case conversion
* [x] concat — __str_concat WAT, enables replace/split/join composition

### Advanced

* [ ] Regex (parser, codegen, test/exec/match/replace/split)
* [x] Symbol — type=0 (ATOM), aux=atomId. Reserved 0-15 (null, undefined, future). Symbol() unique per site, Symbol.for() interned
* [x] Object.assign — compile-time schema cross-copy (matching property names between schemas)
* [x] Number.isNaN, isFinite, isInteger, parseInt, parseFloat + constants (EPSILON, MAX_SAFE_INTEGER, etc.)
* [x] Array.isArray — ptr_type === ARRAY
* [ ] Array.from — needs iterable protocol
* [x] Object.keys, values, entries — compile-time schema resolution, returns NaN-boxed arrays
* [x] try/catch/throw — try_table/throw/tag (WASM EH), nested + cross-function, TCO suppressed inside try
* [x] Tail call optimization — return_call for tail-recursive direct calls
* [ ] SIMD auto-vectorization
* [x] i32 type preservation — done via type coercion system
* [x] Pointer identity — == and != use i64 bit-equality (enables Symbol/pointer comparison, NaN==NaN is true)

### Optimizations (revisit for new arch)

* [ ] Monomorphization (static typing, zero dispatch)
* [ ] Internal i32 calling convention (box only at JS boundary)
* [ ] Compile-time rational simplification
* [ ] Dead code elimination
* [ ] Constant folding

### Build & tooling

* [ ] Clean source from `this`, `Object.create`
* [ ] Compile binary right away, expose wat string
* [ ] console.log/warn/error (host import stubs)
* [ ] Date.now, performance.now (host imports)
* [ ] Import model (bundle/resolve static-time)
* [ ] Source maps
* [ ] Memory size configuration
* [ ] Custom imports
* [ ] CLI: jz run
* [ ] Component interface (wit)
* [ ] Template tag

### Validation & quality

* [ ] color-space converter (validates multi profile)
* [ ] digital-filter biquad (validates memory profile)
* [ ] Benchmarks vs porffor, assemblyscript, quickjs
* [ ] test262 basics
* [ ] Warn/error on hitting memory limits
* [ ] Excellent WASM output

### Future

* [ ] threads/atomics (SharedArrayBuffer, Worker coordination)
* [ ] memory64 (>4GB)
* [ ] relaxed SIMD
* [ ] WebGPU compute shaders
* [ ] metacircularity (jz compiling jz)

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
