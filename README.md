# jz ![stability](https://img.shields.io/badge/stability-experimental-black)

JS subset → pure WASM. No runtime, no GC, no overhead.

```js
import jz from 'jz'

const wasm = jz(`
  import { sin, PI } from 'math'
  export let tone = (freq, t, i) =>
    sin((t + i) * freq * PI * 2 / 44100)
`)

const { tone } = (await WebAssembly.instantiate(wasm)).instance.exports
tone(440, 0, 0)  // Real-time audio at native speed
```

## Profiles

jz compiles to one of three ABI profiles:

```js
// Scalar (default): all f64 params, single f64 return
jz(`export let add = (a, b) => a + b`)

// Multi: all f64 params, multi-value f64 returns (tuples)
jz(`export let rgb2xyz = (r, g, b) => [
  r * 0.4124 + g * 0.3576 + b * 0.1805,
  r * 0.2126 + g * 0.7152 + b * 0.0722,
  r * 0.0193 + g * 0.1192 + b * 0.9505
]`, { profile: 'multi' })

// Memory (planned): f64 + i32 pointer params, shared linear memory
```

## Supported

* Numbers: `0.1`, `1.2e+3`, `0xabc`, `0b101`, `0o357`
* Arithmetic: `+`, `-`, `*`, `/`, `%`
* Comparison: `<`, `<=`, `>`, `>=`, `==`, `!=`
* Logic: `&&`, `||`, `!`, `? :` (short-circuit)
* Assignment: `=`, `+=`, `-=`, `*=`, `/=`, `%=`
* Functions: `(a, b) => expr`, `(x) => { let y = x * 2; return y }`
* Control flow: `if`/`else`, `for`, `while`, `break`, `continue`
* Multi-value return: `(a, b) => [a, b]` (with `{ profile: 'multi' }`)
* Math module: `Math.sin`, `Math.cos`, `Math.sqrt`, `Math.PI`, etc. (35+ functions)
* Imports: `import { sin, PI } from 'math'`, `import * as m from 'math'`
* Multiple exports, inter-function calls

### Not yet

* Memory/array operations (Phase 3)
* Strings, objects, closures

### Prohibited (by design)

* `this`, `class`, `super` — use functions & composition
* `async`/`await` — WASM is synchronous
* `var`, `function` — use `let`/`const`, arrow functions
* `eval`, `arguments`, `with` — explicit is better

### CLI

```bash
jz "1 + 2"                              # 3
jz compile program.js -o program.wat     # Compile to WAT
jz compile program.js -o program.wasm    # Compile to WASM binary
```

## Built With

* [subscript](https://github.com/dy/subscript) – parser
* [watr](https://www.npmjs.com/package/watr) – WAT to WASM

## Similar

* [porffor](https://github.com/CanadaHonk/porffor)
* [jawsm](https://github.com/drogus/jawsm)

<p align=center><a href="https://github.com/krishnized/license/">ॐ</a></p>
