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
  * [ ] Array Methods
    * [ ] `.push(x)` - add to end, return new length
    * [ ] `.pop()` - remove from end, return element
    * [ ] `.shift()` - remove from start
    * [ ] `.unshift(x)` - add to start
    * [ ] `.concat(arr)` - combine arrays
    * [ ] `.join(sep)` - array to string
    * [ ] `.flat(depth)` - flatten nested
    * [ ] `.flatMap(fn)` - map then flatten
  * [ ] String Methods
    * [ ] `.substring(start, end)`
    * [ ] `.substr(start, len)` - deprecated but common
    * [ ] `.split(sep)`
    * [ ] `.trim()`, `.trimStart()`, `.trimEnd()`
    * [ ] `.padStart(len, str)`, `.padEnd(len, str)`
    * [ ] `.repeat(n)`
    * [ ] `.replace(str, str)`
    * [ ] `.toUpperCase()`, `.toLowerCase()`
    * [ ] `.startsWith(str)`, `.endsWith(str)`
  * [ ]  Export Model
    * [ ] `export const name = ...` - explicit export
    * [ ] `export { name }` - export existing
    * [ ] auto-export mode (current behavior, opt-in)
    * [ ] internal functions not exported by default
* [ ] Find all modern cool JS proposals
* [ ] JS improvements
  * [ ] Identify obsolete parts we don't support
    * [ ] Compile them into modern parts, give warning
  * [ ] Identify and document all divergencies (improvements) from JS (quirks)
* [ ] Optimizations
  * [x] `funcref` - first-class functions, currying, closures
    * [x] Closure representation: struct { funcref fn, ref env }
    * [x] call_ref for indirect function calls
    * [x] Fallback to call_indirect + table for wasm-mvp
  * [ ] `multivalue` - multiple return values
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
