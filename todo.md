## MVP

* [x] parser (subscript/justin)
* [x] numbers (0.1, 0xff, 0b11, 0o77)
* [x] strings ("abc", 'xyz')
* [x] primitives (true, false, null, NaN, Infinity, PI, E)
* [x] arithmetic (+, -, *, /, %, **)
* [x] comparisons (<, <=, >, >=, ==, !=)
* [x] bitwise (~, &, |, ^, <<, >>, >>>)
* [x] logic (!, &&, ||, ??, ?:)
* [x] assignments (=, +=, -=, *=, /=, %=)
* [x] arrays ([a, b], arr[i], arr[i]=x, arr.length)
* [x] objects ({a: b}, obj.prop)
* [x] access (a.b, a[b], a?.b)
* [x] functions (arrow functions, exports)
* [x] inter-function calls
* [x] module-level constants (globals)
* [x] Math (native + imported, all functions)
* [x] WASM GC arrays
* [x] WASM GC structs (objects)
* [x] Optional chaining
* [x] Nullish coalescing
* [x] Short-circuit evaluation
* [x] test262 basics
* [x] gc:false mode (memory-based arrays/objects, no GC)
  * [x] array literals, indexing, mutation
  * [x] object literals, property access
  * [x] Array constructor
  * [x] array destructuring, object destructuring
  * [x] array.map, array.reduce
  * [x] optional chaining
  * [x] string literals and charCodeAt
* [x] if/else, break/continue
* [x] typeof, void
* [x] switch statement
* [x] array methods (filter, find, findIndex, indexOf, includes, every, some, slice, reverse)
* [x] string ops (slice, indexOf)
* [x] template literals (basic)
* [x] simplify files structure
* [x] Audit compiler/project architecture/structure: flexible enough? allows extension? performant enough? What seems redundant, questionable, suboptimal, unreliable? What one thing would you change that would unblock everything?
  * [x] deduplicate files (removed stale src/compile/methods/)
  * [x] gc/text options (replaces format API)
  * [x] extract closure analysis into analyze.js
  * [x] extract GC-mode abstractions into gc.js (nullRef, mkString, envGet/Set, arrGet, etc)
  * [x] extract types into types.js (PTR_TYPE, tv, fmtNum, asF64, asI32, truthy, conciliate)
  * [x] extract ops into ops.js (f64, i32, MATH_OPS, GLOBAL_CONSTANTS)
  * [x] clean imports in compile.js (removed unused CONSTANTS, DEPS, gc.js re-exports)
  * [x] update methods/array.js, methods/string.js to import from source modules directly
  * [x] remove dead files (debug.js, floatbeat.html/)
  * [x] refactor methods/array.js to use gc.js helpers (arrLen, arrGet, arrSet, arrNew) - reduced 795→488 lines
  * [x] refactor methods/string.js to use gc.js helpers (strLen, strCharAt, strNew, strSetChar) - reduced 450→296 lines
  * [x] add JSDoc to types
  * [x] add comments for difficult parts (section headers in compile.js)
* [x] JS Compatibility (priority order)
  * [x] Declarations & Scoping
    * [x] `let` declaration - block-scoped variable
    * [x] `const` declaration - block-scoped constant
    * [x] `var` declaration - function-scoped (deprecated, but support)
    * [x] block scope `{ let x = 1 }` - scope tracking per block
  * [x]  Type System
    * [x] `typeof` returns strings - "number", "string", "boolean", "object", "undefined", "function"
    * [x] `===` strict equality - same as `==` for primitives, ref equality for objects
    * [x] `!==` strict inequality
  * [x] Closures
    * [x] closure capture - inner functions capture outer variables
    * [x] closure lifting - hoist captured vars to shared scope/struct
    * [x] nested function definitions
    * [x] closure mutation - inner function can modify outer vars, outer sees changes
    * [x] shared environment - multiple closures share same captured vars
    * [x] first-class functions (currying) - return closure, call it later (funcref/call_indirect)
    * [x] capture array/objects in gc:true mode (needs anyref env fields)
  * [x]  Rest/Spread & Destructuring
    * [x] rest params `(...args) => args.length`
    * [x] spread in arrays `[...arr, x]`
    * [x] spread in calls `fn(...args)`
    * [x] destructuring params `({ x, y }) => x + y`
    * [x] destructuring params `([a, b]) => a + b`
    * [x] default params `(x = 0) => x`
  * [x] Array Methods
    * [x] `.push(x)` - add to end, return new length (gc:false only)
    * [x] `.pop()` - remove from end, return element (gc:false only)
    * [x] `.shift()` - returns first element (non-mutating)
    * [x] `.unshift(x)` - prepend element, returns new array
    * [x] `.concat(arr)` - combine arrays
    * [x] `.join(sep)` - join array of strings with separator
    * [x] `.flat(depth)` - flatten nested arrays (depth=1)
    * [x] `.flatMap(fn)` - map then flatten
  * [x] Unified Memory Model (remove gc option)
    * [x] Document unified model in research.md
    * [x] Track export signatures (arrayParams, returnsArray) in ctx.exportSignatures
    * [x] Document integer-packed pointer encoding (replaces NaN-boxing for JS interop)
    * [x] Add @custom "jz:sig" section for export signatures
    * [x] Add `_` prefix convention for raw exports (_memory, _alloc, _fn)
    * [x] Auto-wrap exports in instantiate() based on signatures
    * [x] Migrate pointer helpers from NaN-boxing to integer-packed (2^48 threshold)
    * [x] Infer array params from usage (arr.map, etc.)
    * [x] Track returnsArrayPointer for array-returning methods
    * [x] Test integer-packed pointer encoding
    * [x] Test custom section reading in instantiate()
    * [x] Test auto-wrapped array exports
    * [x] Remove ~145 opts.gc branches (compile.js: 54, array.js: 55, string.js: 36)
  * [x] String Methods
    * [x] `.substring(start, end)`
    * [x] `.substr(start, len)` - deprecated but common
    * [x] `.split(sep)` - creates array of strings
    * [x] `.trim()`, `.trimStart()`, `.trimEnd()`
    * [x] `.padStart(len, str)`, `.padEnd(len, str)`
    * [x] `.repeat(n)`
    * [x] `.replace(search, replacement)` - first occurrence
    * [x] `.toUpperCase()`, `.toLowerCase()`
    * [x] `.startsWith(str)`, `.endsWith(str)`
    * [x] `.includes(str)`, `.indexOf(str)`
  * [x]  Export Model
    * [x] `export const name = ...` - explicit export
    * [x] `export { name }` - export existing
    * [x] internal functions not exported by default
* [x] Which parts of jessie are defective? Port & improve them
  * [x] Tested: 52 features supported, 4 missing
  * [x] Missing: `class extends` - use composition instead
  * [x] Missing: `function*` generators - use iteration
  * [x] Missing: `1_000_000` numeric separators - write without
  * [x] Missing: `{ foo() {} }` method shorthand - use `{ foo: () => {} }`
  * [x] All JZ-critical features work (arrows, spread, destruct, optional chain, etc.)
* [x] TypedArrays (Int8/16/32, Uint8/16/32, Float32/64)
  * [x] Basic: new, [], .length, .byteLength, .byteOffset, BYTES_PER_ELEMENT
  * [x] Methods: fill, at, indexOf, lastIndexOf, includes
  * [x] Methods: slice, subarray, reverse, copyWithin, set
  * [x] Methods: every, some, find, findIndex
  * [x] Methods: forEach, map, filter, reduce, reduceRight
  * [x] Methods: sort, toReversed, toSorted, with (ES2023)
* [x] Math full (35/36 methods native/stdlib, f16round approximated via f32)
* [x] Boxed primitives via Object.assign (String, Number, Boolean, Array)
* [x] Regex
  * [x] Parser (parseRegex)
  * [x] Codegen (compileRegex → WASM matcher)
  * [x] `regex.test(str)` → i32
  * [x] `regex.exec(str)` → array|null
  * [x] `str.search(regex)` → i32 index
  * [x] `str.match(regex)` → array|null
  * [x] `str.replace(regex, repl)` → string
  * [x] `str.split(regex)` → array
* [x] Important globals (partial)
  * [x] Number.isNaN, Number.isFinite, Number.isInteger (IEEE 754 checks)
  * [x] Number.MAX_VALUE, MIN_VALUE, EPSILON, MAX_SAFE_INTEGER (constants)
  * [x] Array.isArray (pointer type check)
  * [x] Array.from (copy array)
  * [x] Object.keys, Object.values, Object.entries (schema lookup)
  * [x] JSON.stringify (numbers, strings, arrays, objects)
  * [x] JSON.parse (recursive descent parser - numbers, strings, arrays, objects)
  * [x] Set, Map (open addressing hash table, number/string/object keys)
  * [-] WeakSet, WeakMap (need GC hooks - not feasible)
  * [-] Promise, async/await (not feasible in sync WASM)
  * [-] Proxy, Reflect (metaprogramming - not feasible)
  * [x] Symbol (unique atoms, typeof 'symbol', identity comparison)
  * [-] Intl.* (too complex)
* [x] Optimizations
  * [x] **Codebase Audit - Critical Refactors**
    * [x] **compile.js monolith** - split into focused modules:
      * [x] Extract `genClosureValue`, `genClosureCall`, `callClosure` → closures.js (~150 lines)
      * [x] Extract `genArrayDestructDecl`, `genObjectDestructDecl` → destruct.js (~200 lines)
      * [x] Keep operators object and core generate() in compile.js
      * [-] genAssign, generateFunction - deferred (tightly coupled to ctx/gen, not worth extracting)
    * [-] **Module-level mutable state** - `export let ctx, gen` saves passing context everywhere
    * [x] **Object.assign boxed type duplication** (lines 440-570):
      * [x] 4 near-identical blocks for boxed_string/boxed_number/boxed_boolean/array_props
      * [x] Extract common `allocateBoxed(target, props, boxedType)` helper
    * [x] **let/const forward schema inference duplication** (lines 1800-2150):
      * [x] ~100 lines duplicated between `'let'` and `'const'` operators
      * [x] Extract `genBoxedInferredDecl()` and `genObjectInferredDecl()` helpers
    * [x] **Inconsistent error messages** - some throw Error, some console.warn:
      * [x] Create `ctx.warn(code, msg)` and `ctx.error(code, msg)` helpers in context.js
      * [x] Refactored 8 console.warn calls to use ctx.warn
  * [x] **Architecture Improvements**
    * [x] **Dead code in operators**:
      * [x] `'?.'` operator - small and necessary for optional chaining .length
      * [x] `join()` returns 0 (placeholder) - documented, needs number→string
    * [-] **Type system gaps**: schema field overloaded but works fine, not worth changing
    * [x] **Redundant type checks**:
      * [x] `bothI32()` pattern `const va = gen(a), vb = gen(b)` repeated
      * [x] Extract `binOp(a, b, i32Op, f64Op)` helper - used by +, -, *, <, <=, >, >=
    * [-] **Memory helpers**: arrGet/objGet/envGet similar but serve different semantic purposes
  * [x] **Performance Bottlenecks**
    * [x] **Pre-analysis passes** merged into single `preanalyze()`:
      * [x] `findF64Vars`, `findFuncReturnTypes`, `inferObjectSchemas` now single AST walk
    * [x] **String interning** - already deduplicates via `if (str in this.strings)`
    * [x] **Local variable lookups** - removed object spread, `scopedName` stored directly
  * [-] **Canonical Compiler Patterns Missing**
    * [-] **No IR** - AST goes directly to WAT strings; watr handles optimization
    * [x] **generateFunction** recreates context manually
      * [x] Add `ctx.fork()` method for cleaner child context creation
  * [x] **Code Quality**
    * [x] **Magic numbers**:
      * [x] `65536` (instance table end) appears in assemble.js, memory.js
      * [x] `256` (string stride), `8` (f64 size) scattered
      * [x] Extract to constants in types.js (INSTANCE_TABLE_END, STRING_STRIDE, F64_SIZE)
    * [x] **Inconsistent naming**:
      * [x] `loopCounter` used for loop IDs but also array/temp IDs
      * [x] Rename to `uniqueId` (done)
    * [x] **Large inline WAT strings** - template literals with 50+ lines:
      * [x] Hard to read, no syntax highlighting
      * [x] Added `wt` tagged template helper in types.js (trims indent, joins arrays)
      * [x] Refactored allocateBoxed, genBoxedInferredDecl, genObjectInferredDecl, object literal
* [x] Detect unsupported JS features, throw error (detected, unsupported)
  * [x] Prohibit (error) - impossible or antipattern
    * [x] `async`/`await`/`Promise` - WASM is synchronous (parser rejects)
    * [x] `Proxy`/`Reflect` - metaprogramming needs runtime (identifier check)
    * [x] `Symbol` - no runtime symbol registry (identifier check)
    * [x] `eval`/`Function()` - no dynamic code (identifier check)
    * [x] `with` - deprecated, scope pollution (parser rejects)
    * [x] `WeakMap`/`WeakSet` - need GC hooks (identifier check)
    * [x] `getter`/`setter` - runtime dispatch overhead (parser rejects)
    * [x] `arguments` - magic variable, use `...args` (identifier check)
    * [x] `this` - context binding confusion (parser rejects)
    * [x] `class` definition - no OOP (parser rejects)
    * [x] `new` with non-builtin - no custom constructors (compile check)
    * [x] `prototype` access - no prototype chain (not detected, fails naturally)
    * [x] `delete` - dynamic shape bad for perf (parser rejects)
    * [x] `in` operator - prototype chain issues (parser rejects)
    * [x] `instanceof` - prototype-based (not detected, fails as unknown)
    * [x] labeled statements - rarely needed (parser rejects)
    * [x] comma operator - actually allowed, used for args
    * [x] `function*`/`yield` - generators not feasible (parser rejects)
    * [x] dynamic `import()` - static resolution only (parser rejects)
  * [x] Transform (auto-fix in playground)
    * [x] `function` keyword → arrow function (warn in compiler)
    * [x] `var` → `let`/`const` (warn in compiler)
  * [x] Warn - divergent behavior
    * [x] `==`/`!=` - behaves like `===`/`!==`, no coercion (documented)
    * [x] `null` vs `undefined` - indistinguishable at runtime (documented)
    * [x] mutation in forEach callback - mutable capture error
  * [x] Allowed builtins with `new`
    * [x] `new Array(n)` - pre-sized array
    * [x] `new Set()`, `new Map()` - collections
    * [x] `new Float64Array(n)` etc - typed arrays
  * [x] ESLint-inspired rules
    * [x] no-redeclare - same name declared twice in scope
    * [x] no-loss-of-precision - integer literals > MAX_SAFE_INTEGER
* [x] Monomorphize (static typing)
  * [x] Track return types through call graph (`funcReturnTypes` in preanalyze)
  * [x] Remove $__ptr_len runtime dispatch (type-specific length access)
    * [x] Pre-analyze params used as arrays in `preanalyze()` → `arrayParams` Map
    * [x] Track `currentFuncName` during function generation
    * [x] Use `directArrLen()` for known array params (inlined, no function call)
    * [x] Fallback to runtime dispatch only for f64 params not detected as arrays
  * [x] Optimized loop conditions
    * [x] `bool()` returns i32 unchanged (was wrapping in redundant `i32.ne ... 0`)
    * [x] Added `falsy()` helper for loop exit conditions
    * [x] For/while loops use `falsy()` directly instead of `i32.eqz(bool())`
  * [-] Loop-invariant hoisting (deferred - marginal benefit, complex mutation tracking)
  * [x] Type-specialized codegen paths
    * [x] Known array params → direct `directArrLen()`, skip type dispatch
    * [-] Known string params → deferred (rare in hot paths)
    * [-] Known symbol typeof → deferred (rare)
* [x] Douglas Crockford JS mistakes (JZ stance)
  * [x] `null` - typeof bug, JSON uses it; JZ: both null/undefined → 0
  * [x] `this` - 4 binding rules; JZ: prohibited
  * [x] `new` - fake classes; JZ: only builtins (Array, Set, Map, TypedArray)
  * [x] `==` coercion - unpredictable; JZ: behaves like `===`
  * [x] `with` - scope pollution; JZ: prohibited
  * [x] `eval`/`Function()` - security hole; JZ: prohibited
  * [x] `arguments` - magic object; JZ: use `...rest`
  * [x] Global pollution - implicit globals; JZ: error on undeclared
  * [x] ASI - semicolon insertion; JZ: explicit parsing
  * [x] Falsy values - JS has 6 (0/""/null/undefined/NaN/false); JZ: numeric only (0, NaN, -0)
    * Strings always truthy (even "") - no runtime length check in conditions
    * Pointers always truthy - arrays, objects, etc.
    * Simplifies mental model: "is this a valid number?"
  * [x] `for...in` - prototype chain; JZ: not supported
  * [x] Floating point - 0.1+0.2≠0.3; JZ: compile-time rational simplification
* [x] Compile-time Rational Simplification (zero runtime tax)
  * [x] Rational class in types.js: num/den with GCD reduction
  * [x] Detect integer division: `1/3` where both are int literals → rational
  * [x] Rational arithmetic: +, -, *, / preserve exactness
  * [x] Overflow detection: num/den > 2^31 → convert to f64
  * [x] Triggers to stay rational: int literals, known rationals, +/-/*// ops
  * [x] Triggers to f64: mixed with f64, Math.*, **, %, dynamic operand
  * [x] Final emit: rational → f64.const (exact where possible)
  * [x] Tests: 1/3*3=1, 1/10+2/10=0.3, overflow handling
  * [x] Docs: document in research.md
* [x] Pointer Kinds Refactor (from research.md) - COMPLETED
  * [x] **Phase 1: Update types.js constants**
    * [x] Replace PTR_TYPE enum with new 3-bit types (0-7)/
    * [x] Add type constants: ATOM=0, ARRAY=1, TYPED=2, STRING=3, OBJECT=4, CLOSURE=5, REGEX=6
    * [x] Add ATOM subtypes: NULL=0, UNDEF=1, SYMBOL=2+
    * [x] Add OBJECT subtypes: SCHEMA=0, HASH=1, SET=2, MAP=3
    * [x] Update pointer encoding helpers for `[type:3][aux:16][off:32]` layout
    * [x] Update `__mkptr`, `__ptr_type`, `__ptr_aux`, `__ptr_offset` in assemble.js
    * [x] Update index.js `decodePtr`/`encodePtr` for new bit layout
  * [x] **Phase 2: ATOM type (Symbol)** - DONE
    * Symbol() creates unique ATOM pointers (type=0, aux=2, offset=incrementing id)
    * typeof returns 'symbol', symbols compare by identity
    * null/undefined remain as f64(0) for arithmetic compatibility
  * [x] **Phase 3: STRING SSO** - DONE
    * ≤6 ASCII chars (len:3 + chars:7×6 = 45 bits) packed in pointer
    * SSO helpers: `$__is_sso`, `$__str_len`, `$__str_char_at`, `$__str_copy`, `$__sso_to_heap`
    * All string ops SSO-aware (strcat, template literals, regex, etc.)
  * [x] **Phase 4: TYPED view model** - DONE
    * View header: `[len:i32][dataPtr:i32]` (8 bytes), pointer `[type:3][elem:3][_:13][viewOffset:32]`
    * Zero-copy subarrays: `$__mk_typed_view` allocates 8-byte header sharing dataPtr
    * Full 32-bit addressing (was 22-bit), unlimited length (was 4M elements)
  * [x] **Phase 5: OBJECT unification**
    * [x] Unified OBJECT/HASH/SET/MAP under type=4
    * [x] kind in aux bits: SCHEMA=0, HASH=1, SET=2, MAP=3
    * [x] Updated stdlib.js `__set_new`, `__map_new`
    * [x] Updated index.js `ptrToValue` for new encoding
  * [x] **Phase 6: CLOSURE refactor** - Already working
    * [x] funcIdx in pointer aux, env in memory
    * [x] Already correctly encoded
  * [x] **Phase 7: REGEX refactor** - Already working
    * [x] flags+funcIdx in pointer aux
    * [x] Updated compile.js regex codegen
  * [x] **Phase 8: ARRAY ring bit**
    * [x] ring=1 in aux bit for O(1) shift/unshift
    * [x] Updated `__alloc_ring` to use type=1 with aux=0x8000
  * [x] **Phase 9: Cleanup**
    * [x] Updated assemble.js for new pointer constants
    * [x] Updated memory.js helpers for new layouts
    * [x] Updated all type checks to use 3-bit extraction
    * [x] Updated index.js interop for new encoding
    * [x] All 481 tests passing
* [x] Repointers: unified pointer design
  * [x] Unified format: `[type:4][aux:16][offset:31]` (51 bits in NaN mantissa)
    * [x] 31-bit offset = 2GB (WASM memory32 practical limit, clean i32)
    * [x] 4-bit type = 16 types max
    * [x] 16-bit aux = type-specific (funcIdx, elemType, regexId+flags, or 0)
  * [x] Type enum: ARRAY=1, RING=2, TYPED=3, STRING=4, OBJECT=5, HASH=6, SET=7, MAP=8, CLOSURE=9, REGEX=10
  * [x] ARRAY (type=1): `[type:4][0:16][offset:31]` → `[-8:len][elem0...]`
    * [x] capacity = nextPow2(len), no cap storage needed
    * [x] O(1) push/pop, O(n) shift/unshift
    * [x] `arr.at(-1)` → `elem[(len - 1)]`
  * [x] RING (type=2): `[type:4][0:16][offset:31]` → `[-16:head][-8:len][slots...]`
    * [x] WASM helpers: alloc, get/set, push/pop/shift/unshift, resize
    * [x] capacity = nextPow2(len), mask = cap-1
    * [x] O(1) all operations: push/pop/shift/unshift
    * [x] `arr[i]` → `slots[(head + i) & mask]`
    * [x] `arr.at(-1)` → `slots[(head + len - 1) & mask]`
  * [-] Compile-time detection: would require runtime type checks for function params - not worth the tax
  * [x] TYPED (type=3): `[type:4][elemType:3][len:22][offset:22]`
    * [x] Compact encoding: 4M elements, 4MB addressable
    * [x] elemType in pointer (needed for stride before any access)
    * [x] len in pointer (subarray views need length without memory read)
  * [x] STRING (type=4): `[type:4][len:16][data:31]`
    * [x] SSO: len=1-5, data = packed base64 chars (6 bits each, fits `a-zA-Z0-9_-`)
    * [x] Heap: len>0, data = offset (max 65535 chars)
  * [x] OBJECT (type=5): `[type:4][0:16][offset:31]` → `[prop0, prop1, ...]`
    * [x] No header (static schema at compile-time)
  * [x] SET/MAP (type=7,8): `[type:4][0:16][offset:31]` → `[-16:cap][-8:size][entries...]`
    * [x] Both cap and size needed (tombstones, load factor ~0.7)
    * [x] cap = power of 2, slot = hash & (cap-1)
  * [x] CLOSURE (type=9): `[type:4][funcIdx:16][offset:31]` → `[env0, env1, ...]`
    * [x] funcIdx in pointer (needed for call_indirect)
    * [x] No header (env is just data)
  * [x] REGEX (type=10): `[type:4][regexId:16][offset:31]` → (compiled in function table with flags)
    * [x] No memory (pattern compiled to matcher function)
  * [x] f64view(memory, ptr) for JS interop (user creates typed array view)
  * [x] infer object schema by forward analysis (let a = {}; a.x = 1)
* [x] JS improvements (warn on quirks, document divergences)
  * [x] Warning system (console.warn during compilation)
  * [x] Warnings/errors implemented:
    * [x] `var` → warn, suggest `let/const` (hoisting surprises)
    * [x] `parseInt(x)` without radix → warn (default 10 in JZ)
    * [x] `NaN === NaN` → warn, suggest `Number.isNaN(x)`
    * [x] `let b = a` where a is array → warn (pointer copy, not deep clone)
    * [x] Implicit globals → error (already throws on unknown identifier)
    * [x] `+[]`, `[] + {}` nonsense coercion → error
    * [x] `x == null` idiom → warn (coercion doesn't catch undefined in JZ)
  * [x] Divergences from JS (unavoidable, documented in research.md)
    * [x] `==` same as `===` (no type coercion in WASM)
    * [x] Array assignment copies pointer (COW-like semantics)
    * [x] `null`/`undefined` both → `0` at runtime (indistinguishable)
  * [x] JS-compatible (quirks preserved)
    * [x] `typeof null === "object"` (historical JS bug, kept for compat)
    * [x] `NaN !== NaN` (IEEE 754)
    * [x] `-0 === 0` (IEEE 754)
* [x] All destructuring patterns
  * [x] `let [a, b] = [1, 2]` - declaration array destructuring
  * [x] `const [a, b] = [1, 2]` - const array destructuring
  * [x] `let {a, b} = {a: 1, b: 2}` - declaration object destructuring
  * [x] `let {a: x} = {a: 1}` - rename pattern
  * [x] `[a, b] = [1, 2]` - assignment destructuring
  * [x] `[a, b] = [b, a]` - swap pattern (optimized, no alloc)
  * [x] `[a, b, c] = [c, a, b]` - rotate pattern (optimized)
  * [x] `([a, b]) => a + b` - param destructuring
  * [x] `let [a, [b, c]] = [1, [2, 3]]` - nested array
  * [x] `let [a = 10] = []` - default value
  * [x] `let [a, ...rest] = [1, 2, 3]` - rest in array
  * [x] `let {a, b = 5} = {a: 1}` - object default
  * [x] `let {a, ...rest} = {a: 1, b: 2}` - object rest
* [x] Optimizations
  * [x] `funcref` - first-class functions, currying, closures
    * [x] Closure representation: struct { funcref fn, ref env }
    * [x] call_ref for indirect function calls
    * [x] Fallback to call_indirect + table for wasm-mvp
  * [x] `multivalue` - multiple return values for fixed-size arrays
    * [x] Export functions returning `[a, b, c]` use `(result f64 f64 f64)`
    * [x] Implicit return: `(h, s, l) => [h*255, s*255, l*255]`
    * [x] Explicit return: `{ ...; return [r, g, b] }`
    * [x] Track `multiReturn: N` in jz:sig custom section
    * [x] Destructuring assignment via multi-value returns
    * [x] Swap/rotate operations
  * [x] **Unify loop code generation** (array.js + string.js + typedarray.js):
    * [x] 30+ nearly identical loop patterns across 3 files
    * [x] Extract `genIterLoop(ctx, config)` helper with standardized structure
    * [x] array.js reduced from 602→529 lines (12% reduction so far)
  * [x] **Static array optimization underutilized**:
    * [x] `isConstant()` only used for array literals
    * [x] Extend to object literals `{a: 1, b: 2}` → static data segment
    * [x] String concatenation of constants → single static string
  * [x] **flatMap executes callback twice** (array.js:580)
    * First pass counts, second pass maps - callback side effects run twice
    * **Fixed**: Cache mapped values in temp array, callback runs once
  * [x] **Template literal non-string interpolation** silently drops values
    * Code says `// TODO: implement number-to-string conversion`
    * Non-string interpolations become empty strings
    * **Fixed**: Throws error for non-string interpolation
  * [x] `tailcall` - tail call optimization (watr ✓, V8 ✓)
    * [x] Detect tail position: `return f(x)` at end of function
    * [x] Generate `return_call` instead of `call` + `return`
    * [x] Enables stack-safe recursion (factorial, fibonacci, tree traversal)
    * [x] State machine patterns (parser loops, interpreters)
    * [x] Disable inside try blocks (exceptions wouldn't be caught)
  * [x] `simd` - v128 vector ops (watr ✓, V8 ✓)
    * [x] Auto-vectorize Float64Array.map: `arr.map(x => x * 2)`
      * Pattern detection for `x * c`, `x + c`, `x - c`, `x / c`, `-x`, `Math.abs/sqrt/ceil/floor(x)`
      * f64x2 main loop processes 2 elements per instruction
      * Scalar remainder loop for odd-length arrays
    * [x] Auto-vectorize Float32Array.map with f32x4 (4 elements per vector)
      * Same patterns as f64x2, 2x throughput
      * Scalar remainder loop for 0-3 remaining elements
    * [x] Auto-vectorize Int32Array/Uint32Array.map with i32x4 (4 elements per vector)
      * Patterns: `x * c`, `x + c`, `x - c`, `-x`, `Math.abs(x)`, bitwise `& | ^ << >> >>>`
      * Note: No SIMD division (i32x4.div doesn't exist)
    * [x] String toLowerCase/toUpperCase SIMD for heap strings (i16x8)
      * 8 UTF-16 chars per vector for strings >6 chars
      * SSO strings (≤6 chars) use scalar path
    * Note: Complex - needs pattern detection in callbacks, not trivial
  * [x] `exceptions` - try/catch/throw (watr ✓, V8 ✓)
    * [x] Parse `try { } catch (e) { }` blocks (subscript/jessie already supports)
    * [x] Parse `throw expr` statements (subscript/jessie already supports)
    * [x] Generate WASM tags, throw, try_table
    * [x] Exception values are f64 (NaN-boxed for any value type)
    * [x] Cross-function exception propagation
    * [x] Nested try/catch blocks
* [x] i32 Type Preservation
  * [x] Integer literals (42, 0, -1) → i32.const
  * [x] Track variable types in ctx (i32 vs f64)
  * [x] i32 + i32 → i32.add (preserve)
  * [x] i32 + f64 → f64.add (promote)
  * [x] Array indices always i32
  * [x] Bitwise ops always i32
  * [x] Loop counters stay i32
  * [x] Variable type promotion via pre-pass analysis (findF64Vars)
  * [x] Function return types via pre-pass analysis (findFuncReturnTypes)
    * [x] Comparisons → i32
    * [x] Division/power → f64
    * [x] Preserve i32 through ternary, arithmetic
    * [x] JS interop works naturally (JS number handles both)
* [x] Object Strategy B (Tagged Schema)
  * [x] Remove OBJECT pointer type, use F64_ARRAY
  * [x] Encode schema ID in pointer: [type:4][schemaId:16][offset:31]
  * [x] Schema registry: ctx.schemas[id] = ['prop1', 'prop2']
  * [x] Property access: compile-time index lookup
  * [x] Schema survives function boundaries
  * [x] Emit schemas in jz:sig custom section
  * [x] JS wrapper: object ↔ array conversion
  * [x] Max 64K schemas (16 bits) via NaN boxing
  * [x] Objects store strings, numbers, bools, arrays, nested objects (all JSON types)
  * [x] Nested object access with schema propagation
  * [x] NaN boxing pointer format (full f64 range preserved)
  * [x] Boxed strings via Object.assign (unified with OBJECT, schema[0]==='__string__')
  * [x] Arrays with properties via Object.assign (unified with ARRAY_MUT via schemaId)
* [x] Eliminate NaN-boxing tax (internal i32, box only at boundary)
  * **Principle**: NaN-boxing exists for JS interop. Internal code uses raw i32 offsets.
  * NaN-boxing required ONLY at: JS export boundary, f64 memory slots, closures
  * Internal functions: `(param $arr_off i32)` - no boxing overhead
  * [x] **Phase 1: Export boundary analysis** (analyze.js)
    * [x] `ctx.exportedFuncs = Set<name>` - functions in `export` statements
    * [x] Track call graph: which internal funcs called by exports vs other internals
  * [x] **Phase 2: Parameter type inference** (analyze.js)
    * [x] `ctx.funcParamPtrTypes = Map<funcName, Map<paramName, Set<type>>>`
    * [x] Infer from usage: `arr[i]` → array, `obj.prop` → object, `str.length` → string
  * [x] **Phase 3: Offset caching** (compile.js)
    * [x] At function entry: `(local.set $arr_off (call $__ptr_offset (local.get $arr)))`
    * [x] `ctx.cachedOffsets = Map<paramName, offsetLocalName>`
    * [x] Direct i32 helpers: `arrGetI32(off, idx)`, `arrLenI32(off)`, `arrSetI32(off, idx, val)`
  * [x] **Phase 4: Optimized array methods** (array.js, loop.js)
    * [x] `getCachedOffset(watExpr)` - detect param refs with cached offset
    * [x] Optimized methods: reduce, map, filter, find, findIndex, indexOf, includes, every, some, forEach
    * [x] Loop body uses inline f64.load/f64.store with cached offset (no unbox in hot path)
  * [x] **Phase 5: Internal function i32 params** (compile.js, context.js, analyze.js)
    * [x] `computeInternalFuncs(exportedFuncs, funcCallGraph, allFuncs)` - BFS to find reachable from exports
    * [x] Internal functions: `(func $inner (param $arr i32) ...)` - pointer params as i32
    * [x] Call sites extract offset: `(call $inner (call $__ptr_offset (local.get $arr)))`
    * [x] `ctx.i32PtrParams` tracks which params are i32 offsets
    * [x] `loc.semanticType` preserves array/object/string for method dispatch
    * [x] `objGetI32`, `objSetI32` for object property access with i32 pointers
    * [x] Default param handling for i32 params (check `i32.eqz` instead of canonical NaN)
    * [x] Propagate `internalFuncs`, `funcParamPtrTypes` via `ctx.fork()`
  * [x] **Phase 6: Monomorphization** (compile.js) — single-type params use i32 internally
    * [x] Single-type params → use i32 directly (already in Phase 5)
    * [-] Multi-type params → emit variants: `$fn$arr`, `$fn$str`, `$fn$obj` (deferred: rare case, complex)
    * [x] Call sites extract offset via `__ptr_offset` for known ptr args
    * [x] Unknown type at call site → fallback f64 variant (default behavior)
  * [x] **Phase 7: Closure boundary** (closures.js)
    * [x] Closure env stores f64 (uniform slots)
    * [x] On capture: rebox i32 → f64 via `__mkptr(type, aux, offset)`
    * [x] `semanticType` preserved on locals for correct rebox type
    * [x] Object schema preserved via `loc.schema` for aux bits
  * **Signature examples**:
    ```wat
    ;; Internal (no boxing)
    (func $sum_arr (param $off i32) (result f64)
      (local $i i32) (local $acc f64)
      (loop ... (f64.load (i32.add (local.get $off) ...)) ...))

    ;; Export wrapper (boxes at boundary)
    (func (export "sum") (param $ptr f64) (result f64)
      (call $sum_arr (call $__ptr_offset (local.get $ptr))))

    ;; With schema (aux passed explicitly)
    (func $get_prop (param $schema i32) (param $off i32) (param $idx i32) (result f64)
      (f64.load (i32.add (local.get $off) (i32.mul (local.get $idx) (i32.const 8)))))
    ```
  * **Expected wins**:
    * Internal loops: 0 unbox ops (was 6 per access)
    * Function calls: 0 box/unbox between internal funcs
    * Export boundary: 1 unbox per ptr param, 1 box per ptr return
    * ~90% of pointer ops become pure i32 arithmetic
* [ ] clean off source from `this`, `Object.create`.
* [ ] Missing: ArrayBuffer backing (no shared buffer views)
* [ ] console.log/warn/error (import stubs)
* [ ] Date.now, performance.now (host imports)
* [ ] structuredClone (deep copy)
* [ ] color-space converter
* [ ] Warn/error on hitting memory limits: objects, arrays
* [ ] Import model
  * [ ] Bundle/resolve static-time
  * [ ] Resolve imports by the compiler, not runtime (static-time)
* [ ] Excellent WASM output
* [ ] Future features (watr supports, runtime varies)
  * [x] funcref/call_indirect - already used for closures
  * [x] multi-value returns - already used for destructuring
  * [ ] threads/atomics (watr ✓, V8 ✓) - SharedArrayBuffer, Worker coordination
  * [ ] memory64 (watr ✓, V8 ✓) - >4GB memory, needs ecosystem support
  * [ ] relaxed SIMD (watr ✓, V8 ✓) - faster but non-deterministic
  * [-] i31ref - GC feature, not needed with NaN-boxing
  * [-] branch hinting - micro-optimization, compiler can't predict well
* [ ] Options
  * [ ] Memory size (features:'') - default 1 page (64KB), configurable
  * [ ] Custom imports - user-provided functions
  * [ ] Source maps
  * [ ] WASM modules definitions?
* [ ] WebGPU compute shaders
* [ ] Tooling: sourcemaps, debuggins, playground
* [ ] metacircularity
* [ ] test262 full
* [ ] CLI
  * [ ] jz run
  * [ ] jz compile
* [ ] Produce component interface for exports (wit)
* [ ] sourcemaps
* [ ] make all explicit? (math, json, any globals)
  * [ ] can provide implicit globals via options

## Value

* [ ] Pick floatbeat/audio DSP as THE use case. One page, one demo, one undeniable win.
* [ ] Kill the "JS subset" framing. It's a "numeric computation DSL."
* [ ] Benchmark against alternatives. Show where jz wins (size? compilation speed? simplicity?).
* [ ] Ship something someone uses. Even one real user > zero.
* [ ] Pick ONE use case and make jz undeniably the best tool for it. Stop being "general."
* [ ] Better readme example making someone say "I need this": something you cannot easily do any other way.
* [ ] Less defensive positioning in porffor and assemblyscript

## [ ] Offering

* [ ] Clear, fully transparent and understood codebase
* [ ] Completed all aspects: docs, readme, code, tests, repl
* [ ] Integrations
* [ ] Benchmarks

## Comparisons / bench

* [ ] Comparison table with porf, js, assemblyscript, quickjs, anything else?
  * [ ] Features
  * [ ] Perf
  * [ ] Memory
  * [ ] GC

## Floatbeat playground

* [ ] syntax highlighter
* [ ] waveform renderer (wavefont + linefont?)
  * [ ] waveform copy-paste
* [ ] database + recipe book
* [ ] samples collection


## Applications

* [ ] floatbeat expressions
  * [ ] floatbeat playground
* [ ] web-audio-api module
* [ ] color-space conversions
* [ ] zzfx synth

## Playground

* [ ] ! on pasting code it converts var to let/const, function to ()=>{}
