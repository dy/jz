# jz ![stability](https://img.shields.io/badge/stability-experimental-black)

Tiny _JavaScript to WASM compiler_, supporting modern minimal functional JS subset.

## Usage

```js
import jz from 'jz'

const { add, mul } = await jz`
  export const add = (a, b) => a + b;
  export const mul = (x, y) => x * y;
`

add(2, 3)  // 5
mul(4, 5)  // 20
```


## Reference

* Numbers: `0.1`, `1.2e+3`, `0xabc`, `0b101`, `0o357`
* Strings: `"abc"`, `'abc'`
* Values: `true`, `false`, `null`, `NaN`, `Infinity`, `PI`, `E`
* Access: `a.b`, `a[b]`, `a(b)`, `a?.b`
* Arithmetic:`+a`, `-a`, `a + b`, `a - b`, `a * b`, `a / b`, `a % b`, `a ** b`
* Comparison: `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b`
* Bitwise: `~a`, `a & b`, `a ^ b`, `a | b`, `a << b`, `a >> b`, `a >>> b`
* Logic: `!a`, `a && b`, `a || b`, `a ?? b`, `a ? b : c`
* Assignment: `a = b`, `a += b`, `a -= b`, `a *= b`, `a /= b`, `a %= b`
* Arrays: `[a, b]`, `arr[i]`, `arr[i] = x`, `arr.length`
* TypedArrays: `new Float32Array(n)`, `buf[i]`, `buf.length`, `buf.byteLength`
* Objects: `{a: b}`, `{a, b}`, `obj.prop`
* Boxed primitives: `Object.assign(42, {prop})`, `Object.assign("str", {prop})`, `Object.assign([arr], {prop})`
* Functions: `(a, b) => c`, `a => b`, `() => c`
* Currying: `add = x => y => x + y; add(5)(3)`
* Comments: `// foo`, `/* bar */`
* Declarations: `let`, `const`, block scope
* Strict equality: `===`, `!==`
* Closures: capture outer variables
* Rest/spread: `...args`, `[...arr]`
* Destructuring params: `({ x }) => x`
* More array/string methods


## API

```js
import { compile, instantiate } from 'jz'

// Compile to WASM binary
const wasm = compile('1 + 2')

// Get WAT text instead
const wat = compile('1 + 2', { text: true })

// Instantiate and run
const instance = await instantiate(wasm)
console.log(instance.run()) // 3

// Or use WebAssembly API directly
const module = await WebAssembly.compile(wasm)
const wasmInstance = await WebAssembly.instantiate(module)
console.log(wasmInstance.exports.main()) // 3
```

### Options

#### `text`

**false** (default) — Output WASM binary.
**true** — Output WAT text.


### CLI

```bash
# Install globally
npm install -g jz

# Evaluate expressions
jz "console.log(3)"
# Output: 3

# Compile to WASM binary (default)
jz compile program.jz -o program.wasm
# Creates: program.wasm

# Compile to WAT source text
jz compile program.jz --text --gc -o program.wat
# Creates: program.wat (copy with stdlib)

# Run WAT files directly
jz run program.wat
# Output: [result]

# Show help
jz --help
```

<!--

## Examples

### Color Space Conversion

```js
const { rgb2gray } = await jz.instantiate(jz.compile(`
  rgb2gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b
`))

rgb2gray(255, 128, 0)  // 161.279...
```

### Floatbeat

```js
const { floatbeat } = await jz.instantiate(jz.compile(`
  floatbeat = t => sin(t * 440 * PI * 2 / 8000) * 0.5
`))

// Generate audio samples
for (let t = 0; t < 8000; t++) {
  audioBuffer[t] = floatbeat(t)
}
```

## Used by

* [color-space]()
* [web-audio-api]()

-->

## Why?

JS grew complex with legacy (`var`, OOP) and niche features (generators, async).
JZ is minimal modern subset that maps to WebAssembly.

* No classes/prototypes – use functions & closures.
* No old syntax – modern ES6+ only.
* No async – keep code plain & simple.

### Goals

* _Lightweight_ – embed anywhere, from websites to microcontrollers.
* _Fast_ – compiles to WASM faster than `eval` parses.
* _Tiny output_ – no runtime, no heap, no wrappers.
* _JS Interop_ – export/import, preserve func signatures at WASM boundary.
* _JS Compat_ – any jz is valid js (with [limitations](./docs.md#limitations-divergences))

### Why not [porffor](https://github.com/CanadaHonk/porffor)?

Porffor is brilliant, but aligns to TC39 and hesitant on full WASM. JZ stays small, fast and flexible.

### Why not [assemblyscript](https://github.com/AssemblyScript/assemblyscript)?

AssemblyScript is TypeScript-based. JZ stays pure JS.

<!--
### Why not [piezo](https://github.com/dy/piezo)?

Piezo offers extra features like groups, pipes, units, ranges and extra operators. JZ is a possible first step for it.
-->

### Why _jz_?

JavaScript Zero – a return to core, stripped to essentials. Also jazzy.

## Built With

* [subscript](https://github.com/dy/subscript) – parser
* [watr](https://www.npmjs.com/package/watr) – WAT to WASM

<p align=center><a href="https://github.com/krishnized/license/">ॐ</a></p>
