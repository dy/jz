# jz ![stability](https://img.shields.io/badge/stability-experimental-black) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml)

Functional modern JS subset compiling to WASM. No runtime, no GC, no overhead.

## Usage

`npm install jz`

```js
import jz, { compile } from 'jz'

// Compile, instantiate, run — defaults, rest params, WASI all work
const { exports: { add } } = jz('export let add = (a, b) => a + b')
add(2, 3)  // 5

// Template tag — interpolate numbers, functions, strings, arrays, objects
const { exports: { sine } } = jz`
  export let sine = (freq, t, i) => ${Math.sin}((t + i) * freq * ${Math.PI} * 2 / 44100)
`
sine(440, 0, 0)  // native speed, zero GC

const { exports: { f } } = jz`export let f = () => ${'hello'}.length`
f()  // 5

// Low-level: compile only — returns raw WASM binary (no JS adaptation)
const wasm = compile('export let f = (x) => x * 2')
const wat = compile('export let f = (x) => x * 2', { wat: true })
```

## CLI

`npm install -g jz`

```sh
# Compile to WASM binary
jz program.js -o program.wasm

# Compile to WAT
jz program.js -o program.wat

# Evaluate expression
jz -e "1 + 2"
# 3

# Evaluate file
jz -e program.js

# Show help
jz --help
```

## Reference

* Numbers: `0.1`, `1.2e+3`, `0xff`, `0b101`, `0o77`
* Strings: `"abc"`, `'abc'`, `s.length`, `s[i]`
* Values: `true`, `false`, `null`, `NaN`, `Infinity`
* Arithmetic: `+a`, `-a`, `a + b`, `a - b`, `a * b`, `a / b`, `a % b`, `a ** b`
* Comparison: `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b`
* Bitwise: `~a`, `a & b`, `a ^ b`, `a | b`, `a << b`, `a >> b`, `a >>> b`
* Logic: `!a`, `a && b`, `a || b`, `a ?? b`, `a ? b : c`
* Assignment: `a = b`, `a += b`, `a -= b`, `a *= b`, `a /= b`, `a %= b`
* Declarations: `let`, `const`, block scope
* Control: `if`/`else`, `for`, `while`, `switch`/`case`, `return`
* Functions: `(a, b) => c`, `a => b`, `() => c`, defaults, currying, closures
* Multi-return: `(a, b) => [b, a]`
* Arrays: `[a, b]`, `arr[i]`, `.length`, `.push`, `.pop`, `.map`, `.filter`, `.reduce`, `.find`, `.indexOf`, `.includes`, `.slice`
* Spread: `[...a, ...b]`, `let [x, y] = a`, `let {x, y} = o`
* Objects: `{a: b}`, `{a, b}`, `o.prop`, `o.prop = x`
* Collections: `new Set()`, `new Map()`, `new Float64Array(n)`, `new Int32Array(n)`
* Loops: `for...of` arrays, `for...in` objects (compile-time unrolled)
* Modules: `import { a } from 'b'`, `export`, source bundling, host imports
* Math: `sin cos tan atan2 sqrt pow abs min max floor ceil round log exp` ...
* Time: `Date.now()`, `performance.now()` (WASI)
* IO: `console.log/warn/error` (WASI)
* typeof: `typeof x === 'string'` (compile-time type checks)
* Comments: `// foo`, `/* bar */`
* No `var`, `function`, `this`, `class`, `async`, `eval`, `with`, `arguments`
* `==` is `===`, `null` is `0`

## Why?

JS has become complex and with regrets (coercions, hoisting, `this`, classes, precision loss).
Ongoing proposals shape language into something unappealing.

_jz_ (javascript zero) – keeps minimal functional JS best practices, drops the rest.
Initially conceived for bytebeats, inspired by [porf](https://github.com/CanadaHonk/porffor) and [piezo](https://github.com/dy/piezo).

### Principles

* **Compile-time over runtime** — types inferred from usage, no annotations. All dispatch resolved statically. No GC, no runtime checks.
* **Explicit over implicit** — no coercions, no hoisting, no magic. `==` is strict. `null` is `0`. Code means what it says.
* **Functional over OOP** — functions are the unit of composition. No `class`, no `this`, no inheritance. Data is plain, behavior is functions.
* **Valid jz = valid js** — every jz program runs as normal javascript. The subset enforces good style by design — no linter needed.
* **Uniform f64 representation** — all values are f64. Heap types use [NaN-boxing](https://articlems.com/nan-boxing-in-javascript): arrays, strings, objects are pointers encoded in quiet NaN bits. One convention beats type-specific complexity.
* **Minimal core, extensible surface** — core compiles pure compute (~2K lines). Arrays, strings, objects, Math — each is a module. Capabilities grow without core growth.
* **Live compilation** — compiles in-browser in <1ms. WASM as interactive medium, not build artifact.


## FAQ

#### How do I pass data between JS and WASM?

Numbers pass directly as f64. Strings, arrays, objects, and typed arrays are heap values — they need `mem` to cross the boundary:

```js
const { exports, mem } = jz(`
  export let greet = (s) => s.length
  export let sum = (a) => a.reduce((s, x) => s + x, 0)
  export let dist = (p) => (p.x * p.x + p.y * p.y) ** 0.5
  export let process = (buf) => buf.map(x => x * 2)
`)

// JS → WASM (write)
mem.String('hello')               // → NaN-boxed string pointer
mem.Array([1, 2, 3])              // → NaN-boxed array pointer
mem.Float64Array([1.0, 2.0])      // → NaN-boxed typed array pointer
mem.Int32Array([10, 20, 30])      // all typed array constructors available

// Objects: keys and order must match the jz source declaration.
// jz objects are fixed-layout schemas (like C structs), not dynamic key bags.
mem.Object({ x: 3, y: 4 })       // → NaN-boxed object pointer

// Strings/arrays inside objects are auto-wrapped to pointers:
mem.Object({ name: 'jz', count: 3 })  // name auto-wrapped via mem.String

// Call with pointers
exports.greet(mem.String('hello'))          // 5
exports.sum(mem.Array([1, 2, 3]))           // 6
exports.dist(mem.Object({ x: 3, y: 4 }))   // 5

// WASM → JS (read)
mem.read(exports.process(mem.Float64Array([1, 2, 3])))  // Float64Array [2, 4, 6]
```

Template interpolation handles most of this automatically — strings, arrays, numbers, and numeric objects are marshaled for you:

```js
jz`export let f = () => ${'hello'}.length + ${[1,2,3]}[0] + ${{x: 5, y: 10}}.x`
```

#### Can two modules share data?

Yes — pass a shared `WebAssembly.Memory` and pointers work across modules:

```js
const memory = new WebAssembly.Memory({ initial: 1 })

const a = jz('export let make = () => { let a = [10, 20, 30]; return a }', { memory })
const b = jz('export let sum = (arr) => arr.reduce((s, x) => s + x, 0)', { memory })

// Pointer from module a, processed by module b — same memory, zero copy
b.instance.exports.sum(a.instance.exports.make())  // 60

// Strings work too
const c = jz('export let len = (s) => s.length', { memory })
c.instance.exports.len(a.mem.String('hello'))  // 5
```

All modules sharing a memory use a single bump allocator (heap pointer stored in the memory itself). Use `.instance.exports` for raw pointers, `.exports` for the JS-wrapped surface.

#### How does object interpolation work?

Objects with all-numeric values are emitted as jz object literals at compile time. Objects with strings, arrays, or mixed values are allocated via `mem.Object` after instantiation — the template tag handles this automatically:

```js
// Numeric: compile-time literal
jz`export let f = () => ${{x: 1, y: 2}}.x`             // 1

// Mixed: auto-allocated post-instantiation
const { exports, mem } = jz`export let f = () => ${{name: 'jz', count: 3}}.name`
mem.read(exports.f())                                    // 'jz'
```

#### How does everything fit in f64?

All values are IEEE 754 f64. Integers up to 2^53 are exact. Heap types (arrays, strings, objects) use [NaN-boxing](https://sean.cm/a/nan-boxing): a quiet NaN with type + pointer packed in the payload bits. One representation, no type tags, no boxing overhead.

#### How do I run compiled WASM outside the browser?

```sh
jz program.js -o program.wasm

# Run with any WASM runtime
wasmtime program.wasm     # WASI support built in
wasmer run program.wasm
deno run program.wasm
```

`console.log` compiles to WASI `fd_write` — works natively on wasmtime/wasmer/deno without polyfills.

#### Can I compile jz to C?

Yes, via [wasm2c](https://github.com/nicbarker/wasm2c) or [w2c2](https://github.com/nicbarker/w2c2):

```sh
jz program.js -o program.wasm
wasm2c program.wasm -o program.c
cc program.c -o program
```

jz → WASM → C → native binary.

#### What's the performance like?

Compiled jz runs as native WASM — same speed as hand-written WAT or C-compiled WASM. No interpreter, no GC pauses. Compilation itself takes <1ms for typical modules, fast enough for live coding.

Best for: tight compute loops, DSP, audio processing, math, pixel manipulation, physics.
Not ideal for: DOM manipulation, async I/O, heavy string processing.

#### What JS features are excluded and why?

| Excluded | Reason |
|----------|--------|
| `var`, `function` | Hoisting. Use `let`/`const` and arrows. |
| `class`, `this`, `super` | OOP. Use plain objects and functions. |
| `async`/`await` | WASM is synchronous. Use host callbacks. |
| `eval`, `with` | Dynamic scope. Not compilable. |
| `arguments` | Implicit. Use rest params `...args`. |
| `for...in`, `for...of` | Use `for` loops with index. |
| `typeof` (string result) | Returns type code (number), not string. |
| Implicit coercions | `==` is strict. `null` is `0`. No surprises. |

#### What's the difference between `jz()` and `compile()`?

```js
import jz, { compile } from 'jz'

// jz() — compile + instantiate + wrap. Handles defaults, rest params, WASI.
const { exports: { f } } = jz('export let f = (x = 5) => x')
f()  // 5

// compile() — returns raw WASM binary. You handle instantiation.
const wasm = compile('export let f = (x) => x * 2')
// Use jz.wrap() if you need the JS calling convention:
const mod = new WebAssembly.Module(wasm)
const inst = new WebAssembly.Instance(mod)
const wrapped = jz.wrap(mod, inst)
```

#### How do TypedArrays and SIMD work?

TypedArrays (`Float64Array`, `Int32Array`, etc.) compile to typed WASM memory with correct byte strides. `.map()` auto-vectorizes recognized patterns to SIMD:

```js
const { exports, mem } = jz(`export let f = () => {
  let buf = new Float64Array(1024)
  // ... fill buf ...
  return buf.map(x => x * 2)  // compiles to f64x2.mul SIMD
}`)
mem.read(exports.f())  // Float64Array with doubled values
```


## Used by

* [web-audio-api](https://github.com/audiojs/web-audio-api)
* [color-space](https://github.com/colorjs/color-space)

## Built With

* [subscript](https://github.com/dy/subscript) – parser
* [watr](https://www.npmjs.com/package/watr) – WAT to WASM

<!--
## Similar

* [porffor](https://github.com/CanadaHonk/porffor) – targets full JS semantics from TC39
* [jawsm](https://github.com/drogus/jawsm)
-->

<p align=center><a href="https://github.com/krishnized/license/">ॐ</a></p>
