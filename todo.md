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
* [ ] JS Compatibility (priority order)
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
    * [x] `.join(sep)` - returns 0 (placeholder - needs number→string)
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
* [ ] Find all modern cool JS proposals
  * [ ] Iterator helpers?
  * [ ] using?
  * [ ] Float16
  * [ ] Promise.try
  * [ ] Iterator.range
* [ ] Detect unsupported JS features, throw error (detected, unsupported)
  * [ ] Make sure there's no undetected JS features
* [x] Which parts of jessie are defective? Port & improve them
  * [x] Tested: 52 features supported, 4 missing
  * [x] Missing: `class extends` - use composition instead
  * [x] Missing: `function*` generators - use iteration
  * [x] Missing: `1_000_000` numeric separators - write without
  * [x] Missing: `{ foo() {} }` method shorthand - use `{ foo: () => {} }`
  * [x] All JZ-critical features work (arrows, spread, destruct, optional chain, etc.)
* [ ] TypedArrays
* [ ] Math full
* [ ] Boxed String, Number, Boolean funcs
* [ ] Regex
* [ ] Important globals
* [ ] color-space converter
* [ ] Import model
  * [ ] Bundle before compile
  * [ ] Resolve imports by the compiler, not runtime (static-time)
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
* [ ] Optimizations
  * [x] `funcref` - first-class functions, currying, closures
    * [x] Closure representation: struct { funcref fn, ref env }
    * [x] call_ref for indirect function calls
    * [x] Fallback to call_indirect + table for wasm-mvp
  * [x] `multivalue` - multiple return values for fixed-size arrays
    * [x] Export functions returning `[a, b, c]` use `(result f64 f64 f64)`
    * [x] Implicit return: `(h, s, l) => [h*255, s*255, l*255]`
    * [x] Explicit return: `{ ...; return [r, g, b] }`
    * [x] Track `multiReturn: N` in jz:sig custom section
    * [ ] Destructuring assignment via multi-value returns
    * [ ] Error+value pattern (result i32 f64)
    * [ ] Swap/rotate operations
  * [ ] `tailcall` - tail call optimization
    * [ ] Enable stack-safe recursion
    * [ ] State machine patterns
  * [ ] `simd` - v128 vector ops
    * [ ] Array numeric operations (f64x2, f32x4)
    * [ ] String operations (i16x8)
    * [ ] Math/vector ops (RGBA, XYZW, quaternions)
    * [ ] Batch comparisons
* [ ] Excellent WASM output
* [ ] Future features (not in API yet)
  * [ ] i31ref (small integer refs)
  * [ ] Exception handling (try/catch/throw)
  * [ ] Threads & Atomics
  * [ ] Branch hinting (br_on_*)
  * [ ] Memory64 (64-bit addressing)
  * [ ] Relaxed SIMD
* [ ] Options
  * [ ] Memory size (features:'') - default 1 page (64KB), configurable
  * [ ] Custom imports - user-provided functions
  * [ ] Source maps
  * [ ] WASM modules definitions?
* [ ] WebGPU compute shaders
* [ ] Tooling: sourcemaps, debuggins, playground
* [ ] Jessie validation & optimizations
* [ ] metacircularity
* [ ] test262 full
* [ ] CLI
  * [ ] jz run
  * [ ] jz compile
* [ ] Produce component interface for exports (wit)
* [ ] i32 Type Preservation
  * [ ] Integer literals (42, 0, -1) → i32.const
  * [ ] Track variable types in ctx (i32 vs f64)
  * [ ] i32 + i32 → i32.add (preserve)
  * [ ] i32 + f64 → f64.add (promote)
  * [ ] Array indices always i32
  * [ ] Bitwise ops always i32
  * [ ] Loop counters stay i32
  * [ ] Function params/returns can be i32
* [ ] Object Strategy B (Tagged Schema)
  * [x] Remove OBJECT pointer type, use F64_ARRAY
  * [x] Encode schema ID in pointer: [type:4][schemaId:4][len:16][offset:32]
  * [x] Schema registry: ctx.schemas[id] = ['prop1', 'prop2']
  * [x] Property access: compile-time index lookup
  * [x] Schema survives function boundaries
  * [x] Emit schemas in jz:sig custom section
  * [x] JS wrapper: object ↔ array conversion
  * [ ] Max 256 schemas (8 bits) → currently 16 (4 bits)
  * [x] Objects store strings, numbers, bools, arrays, nested objects (all JSON types)
  * [x] Nested object access with schema propagation
  * [ ] Arrays with properties (special schema?)
  * [ ] Boxed strings, numbers (special schema?)

## Comparisons

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
