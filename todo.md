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

## JS Compatibility (priority order)

### 1. Declarations & Scoping
* [x] `let` declaration - block-scoped variable
* [x] `const` declaration - block-scoped constant
* [x] `var` declaration - function-scoped (deprecated, but support)
* [x] block scope `{ let x = 1 }` - scope tracking per block

### 2. Type System
* [x] `typeof` returns strings - "number", "string", "boolean", "object", "undefined", "function"
* [x] `===` strict equality - same as `==` for primitives, ref equality for objects
* [x] `!==` strict inequality

### 3. Closures
* [ ] closure capture - inner functions capture outer variables
* [ ] closure lifting - hoist captured vars to shared scope/struct
* [ ] nested function definitions

### 4. Rest/Spread & Destructuring
* [ ] rest params `(...args) => args.length`
* [ ] spread in arrays `[...arr, x]`
* [ ] spread in calls `fn(...args)`
* [ ] destructuring params `({ x, y }) => x + y`
* [ ] destructuring params `([a, b]) => a + b`
* [ ] default params `(x = 0) => x`

### 5. Array Methods
* [ ] `.push(x)` - add to end, return new length
* [ ] `.pop()` - remove from end, return element
* [ ] `.shift()` - remove from start
* [ ] `.unshift(x)` - add to start
* [ ] `.concat(arr)` - combine arrays
* [ ] `.join(sep)` - array to string
* [ ] `.flat(depth)` - flatten nested
* [ ] `.flatMap(fn)` - map then flatten

### 6. String Methods
* [ ] `.substring(start, end)`
* [ ] `.substr(start, len)` - deprecated but common
* [ ] `.split(sep)`
* [ ] `.trim()`, `.trimStart()`, `.trimEnd()`
* [ ] `.padStart(len, str)`, `.padEnd(len, str)`
* [ ] `.repeat(n)`
* [ ] `.replace(str, str)`
* [ ] `.toUpperCase()`, `.toLowerCase()`
* [ ] `.startsWith(str)`, `.endsWith(str)`

### 7. Export Model
* [ ] `export const name = ...` - explicit export
* [ ] `export { name }` - export existing
* [ ] auto-export mode (current behavior, opt-in)
* [ ] internal functions not exported by default

## JS improvements

* [ ] Identify obsolete parts we don't support
  * [ ] Compile them into modern parts, give warning
* [ ] Identify and document all divergencies (improvements) from JS

## Optimizations

* [ ] v128
* [ ] multiple returns (for arrays return)
* [ ]

## Future

* [ ] Jessie validation & optimizations
* [ ] full closures (nested function variable capture)
* [ ] early return (requires function-level return handling)
* [ ] metacircularity
* [ ] test262 full
* [ ] WASM to C / ASM

## Floatbeat playground

* [ ] syntax highlighter
* [ ] waveform renderer (wavefont + linefont?)
  * [ ] waveform copy-paste
* [ ] database + recipe book
* [ ] samples collection

## CLI

* [ ] jz run
* [ ] jz compile

## Applications

* [ ] floatbeat expressions
  * [ ] floatbeat playground
* [ ] web-audio-api module
* [ ] color-space conversions
* [ ] zzfx synth

## Playground

* [ ] ! on pasting code it converts var to let/const, function to ()=>{}
