# jz ![stability](https://img.shields.io/badge/stability-experimental-black)

Tiny _JavaScript to WASM compiler_, supporting modern minimal functional JS subset.

## Usage

```js
import jz from 'jz'

// Define and export functions
const { add, mul } = await jz.instantiate(jz.compile(`
  add = (a, b) => a + b,
  mul = (x, y) => x * y
`))

add(2, 3)  // 5
mul(4, 5)  // 20
```

### Audio Synthesis

```js
const { synth } = await jz.instantiate(jz.compile(`
  osc = (t, freq) => sin(t * freq * PI * 2),
  env = (t, attack, decay) => t < attack ? t / attack : exp(-(t - attack) / decay),
  synth = (t, freq, attack, decay) => osc(t, freq) * env(t, attack, decay)
`))

synth(0.1, 440, 0.01, 0.5)  // -0.000... (decaying sine)
```

### Math Utilities

```js
const { dist, lerp, clamp } = await jz.instantiate(jz.compile(`
  dist = (x, y) => Math.sqrt(x*x + y*y),
  lerp = (a, b, t) => a + (b - a) * t,
  clamp = (x, lo, hi) => min(max(x, lo), hi)
`))

dist(3, 4)        // 5
lerp(0, 100, 0.5) // 50
clamp(150, 0, 100) // 100
```

## Reference

### Supported Features

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

### Math Functions

Native (WASM): `sqrt`, `abs`, `floor`, `ceil`, `trunc`, `min`, `max`, `copysign`

Imported: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `exp`, `expm1`, `log`, `log2`, `log10`, `log1p`, `pow`, `cbrt`, `hypot`, `sign`, `fround`, `random`

### Planned

* Control Flow: `if (a) {...} else {...}`, `for`, `while`
* Closures: capture outer variables
* Template literals: `` `template ${literals}` ``


## API

```js
import { compile, evaluate, instantiate } from 'jz'


// Compile to WASM binary (default)
const wasm = compile('1 + 2')
console.log('WASM size:', wasm.byteLength, 'bytes')

// Compile to WAT source text
const wat = compile('1 + 2', { format: 'wat' })
console.log('WAT source:', wat)

// Compile with gc:false (memory-based arrays/objects)
const wasmNoGc = compile('[1,2,3]', { gc: false })

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
| `gc` | `true` | Use WASM GC arrays/objects. Set `false` for linear memory-based encoding |

#### gc: false

Encodes arrays/objects in linear memory with pointer format:
- **Pointer encoding**: `[type:4][length:28][offset:32]` packed as f64
- **Types**: F64_ARRAY=0, I32_ARRAY=1, STRING=2, I8_ARRAY=3, OBJECT=4
- **Memory**: Bump allocator starting at offset 1024

Useful for environments without WASM GC support or when exporting memory to JS.

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
* _Fast_ – compiles faster than `eval` parses.
* _Tiny output_ – no runtime, no heap.

### Why not [porffor](https://github.com/CanadaHonk/porffor)?

Porffor is brilliant, but aligns to TC39. JZ stays small and flexible.

### Why not [assemblyscript](https://github.com/AssemblyScript/assemblyscript)?

AssemblyScript is TypeScript-based. JZ stays pure JS.

### Why _jz_?

JavaScript Zero – stripped to essentials. Also jazzy.

## Built With

* [subscript](https://github.com/dy/subscript) – parser
* [watr](https://www.npmjs.com/package/watr) – WAT to WASM

<p align=center><a href="https://github.com/krishnized/license/">ॐ</a></p>
