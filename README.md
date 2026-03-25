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

## What works today

Scalar f64 math compiled to WASM. Arrow functions, exports, inter-function calls.

```js
import jz from 'jz'

const wasm = jz(`export let add = (a, b) => a + b`)
const { add } = (await WebAssembly.instantiate(wasm)).instance.exports
add(2, 3)  // 5
```

### Supported

* Numbers: `0.1`, `1.2e+3`, `0xabc`, `0b101`, `0o357`
* Arithmetic: `+a`, `-a`, `a + b`, `a - b`, `a * b`, `a / b`, `a % b`
* Comparison: `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b`
* Ternary: `a ? b : c`
* Functions: `(a, b) => expr`, `a => expr`, `() => expr`
* Multiple exports, inter-function calls
* Math module: `Math.sin`, `Math.cos`, `Math.sqrt`, `Math.PI`, etc. (35+ functions)
* Explicit imports: `import { sin, PI } from 'math'`
* Namespace imports: `import * as m from 'math'`

### Not yet (planned)

* Statement bodies (`{ }`, `if/else`, `for`, `let` in bodies)
* Multi-value return (`return [a, b, c]`)
* Memory/array operations
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
