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
* [ ] Jessie-based
  * [ ] Add validation
  * [ ] Add optimizations
  * [ ] Remove var, function
* [x] if/else, break/continue
* [x] typeof, void
* [x] array methods (filter, find, findIndex, indexOf, includes, every, some, slice, reverse)
* [x] string ops (slice, indexOf)
* [x] template literals (basic)
* [ ] full closures (nested function variable capture)
* [ ] destructuring func params, rest/spread
* [ ] switch statement (not supported by jessie parser)
* [ ] early return (requires function-level return handling)
* [ ] metacircularity
* [ ] test262
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
