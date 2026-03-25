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
* [x] ++/-- operators
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

## Backlog

### Core language

* [ ] Optional chaining (?.)
* [ ] typeof — needs strings (returns type name)
* [ ] Strings (literals, charCodeAt, basic ops)
* [ ] Template literals

### Data structures

* [ ] Array literals, indexing, mutation (memory profile)
* [ ] Array methods (map, filter, reduce, find, indexOf, slice, etc.)
* [ ] Array destructuring, spread
* [ ] Object literals, property access
* [ ] Object destructuring, shorthand
* [ ] Rest params (...args)
* [x] Default params (x = 5) — done, NaN-based detection
* [ ] TypedArrays (Float64/32, Int8/16/32, Uint8/16/32)
* [ ] Set, Map
* [ ] JSON.stringify, JSON.parse

### Functions

* [ ] Closures (capture by value)
* [ ] First-class functions (currying, funcref/call_indirect)
* [ ] Nested function definitions

### String methods

* [ ] slice, substring, indexOf, includes
* [ ] startsWith, endsWith, split, join
* [ ] trim, padStart, padEnd, repeat
* [ ] replace, toUpperCase, toLowerCase

### Advanced

* [ ] Regex (parser, codegen, test/exec/match/replace/split)
* [ ] Symbol
* [ ] Boxed primitives (Object.assign)
* [ ] Number.isNaN, isFinite, isInteger, constants
* [ ] Array.isArray, Array.from
* [ ] Object.keys, values, entries
* [ ] try/catch/throw (WASM exceptions)
* [ ] Tail call optimization
* [ ] SIMD auto-vectorization
* [ ] i32 type preservation

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
