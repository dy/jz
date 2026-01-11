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
* [ ] Control Flow (if, for, while)
* [ ] full closures (captured non-literal variables)
* [ ] template literals
* [ ] destructuring in function params

## Done

* [x] WASM GC arrays
* [x] WASM GC structs (objects)
* [x] Optional chaining
* [x] Nullish coalescing
* [x] Short-circuit evaluation
* [x] test262 basics

## WASM Output

* Simple expr: 86 bytes
* Single fn: 66 bytes
* Multi fn: 99 bytes
* With trig: 108 bytes

## CLI

* [ ] jz run
* [ ] jz compile

## Applications

* [x] floatbeat expressions
* [ ] web-audio-api module
* [ ] color-space conversions
* [ ] zzfx synth

## Playground

* [ ] ! on pasting code it converts var to let/const, function to ()=>{}
