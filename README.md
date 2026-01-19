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
* Objects: `{a: b}`, `{a, b}`, `obj.prop`
* Functions: `(a, b) => c`, `a => b`, `() => c`
* Comments: `// foo`, `/* bar */`
* Declarations: `let`, `const`, block scope
* Strict equality: `===`, `!==`
* Closures: capture outer variables
* Rest/spread: `...args`, `[...arr]`
* Destructuring params: `({ x }) => x`
* More array/string methods


## API

```js
import { compile, evaluate, instantiate } from 'jz'


// Compile to WASM binary (default)
const wasm = compile('1 + 2')
console.log('WASM size:', wasm.byteLength, 'bytes')

// Compile to WAT source text
const wat = compile('1 + 2', { format: 'wat' })
console.log('WAT source:', wat)

// Compile and instantiate separately
const instance = await instantiate(wasm)
const runResult = instance.run()
console.log(runResult) // 3

// Or use WebAssembly API directly
const module = await WebAssembly.compile(wasm)
const wasmInstance = await WebAssembly.instantiate(module)
console.log(wasmInstance.exports.main()) // 3
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `format` | `'wasm'` | Output format: `'wasm'` (binary) or `'wat'` (text) |
| `gc` | `true` | Use WASM GC — direct JS interop, managed memory |

**gc: true** (default) — WASM GC mode:
- Uses `struct`, `array`, `anyref`, `funcref` for JS-native types
- Direct export to JavaScript — no decoding needed
- Best for general use, prototyping, JS interop

**gc: false** — Linear memory mode:
- Uses `memory`, `i32.load/store`, `call_indirect` for manual management
- Numeric pipelines: primitives in/out, arrays stay internal
- Faster, deterministic, works on all WASM runtimes
- Best for DSP, audio, embedded, maximum portability

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
jz compile program.jz --format wat -o program.wat
# Creates: program.wat (copy with stdlib)

# Run WAT files directly
jz run program.wat
# Output: [result]

# Show help
jz --help
```

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


## Why?

JS grew complex with legacy (`var`, OOP) and niche features (generators, async).
JZ is minimal modern subset that maps directly to WebAssembly.

* No classes/prototypes – use functions & closures.
* No old syntax – modern ES6+ only.
* No async – keep code plain & simple.

### Goals

* _Lightweight_ – embed anywhere, from websites to microcontrollers.
* _Fast_ – compiles to WASM faster than `eval` parses.
* _Tiny output_ – no runtime, no heap, no wrappers.
* _Seamless JS integration_ – export/import, same func signatures.

### Why not [porffor](https://github.com/CanadaHonk/porffor)?

Porffor is brilliant, but aligns to TC39 and hesitant on full WASM. JZ stays small and flexible.

### Why not [assemblyscript](https://github.com/AssemblyScript/assemblyscript)?

AssemblyScript is TypeScript-based. JZ stays pure JS.

### Why not [piezo](https://github.com/dy/piezo)?

Piezo offers extra features like groups, pipes, units, ranges and extra operators. JZ is a possible first step for it.

### Why _jz_?

JavaScript Zero – a return to core, stripped to essentials. Also jazzy.

## Built With

* [subscript](https://github.com/dy/subscript) – parser
* [watr](https://www.npmjs.com/package/watr) – WAT to WASM

<p align=center><a href="https://github.com/krishnized/license/">ॐ</a></p>
