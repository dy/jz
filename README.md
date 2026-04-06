# jz ![stability](https://img.shields.io/badge/stability-experimental-black)

Functional JS subset → minimal WASM. No runtime, no GC, no toolchain.

* **Native speed from JS** — write functions, get WASM. No new language to learn.
* **Real-time compilation** — compiles in-browser faster than `eval` parses. Hot-swap compute kernels live.
* **Deterministic execution** — no GC pauses, no hidden allocations. Worklet-safe.
* **Tiny output** — kilobyte modules, zero runtime overhead. Runs on browsers to microcontrollers.
* **Just JS** — any jz code is valid JS. Differences are [documented](#divergences-from-js).

```js
import jz from 'jz'

const wasm = jz(`
  export let sine = (freq, t, i) => Math.sin((t + i) * freq * PI * 2 / 44100)
`)

const { sine } = (await WebAssembly.instantiate(wasm)).instance.exports
tone(440, 0, 0)  // Real-time audio at native speed
```

## Usage

```js
import jz from 'jz'

// Scalar return
const wasm = jz(`export let add = (a, b) => a + b`)
const { add } = (await WebAssembly.instantiate(wasm)).instance.exports
add(2, 3)  // 5

// Multi-value return (just works — return array literal)
const wasm2 = jz(`export let rgb2xyz = (r, g, b) => [
  r * 0.4124 + g * 0.3576 + b * 0.1805,
  r * 0.2126 + g * 0.7152 + b * 0.0722,
  r * 0.0193 + g * 0.1192 + b * 0.9505
]`)
const { rgb2xyz } = (await WebAssembly.instantiate(wasm2)).instance.exports
const [x, y, z] = rgb2xyz(1, 1, 1)

// WAT output for debugging
jz(`export let f = x => x * 2`, { wat: true })
```

## Reference

* Numbers: `0.1`, `1.2e+3`, `0xff`, `0b101`, `0o77`
* Strings: `"abc"`, `'abc'`
* Values: `true`, `false`, `null`, `NaN`, `Infinity`
* Arithmetic: `+a`, `-a`, `a + b`, `a - b`, `a * b`, `a / b`, `a % b`, `a ** b`
* Comparison: `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b`
* Bitwise: `~a`, `a & b`, `a ^ b`, `a | b`, `a << b`, `a >> b`, `a >>> b`
* Logic: `!a`, `a && b`, `a || b`, `a ?? b`, `a ? b : c`
* Assignment: `a = b`, `a += b`, `a -= b`, `a *= b`, `a /= b`, `a %= b`
* Functions: `(a, b) => c`, `a => b`, `() => c`, default params
* Currying: `add = x => y => x + y; add(5)(3)`
* Closures: capture outer variables by value
* Multi-return: `(a, b) => [b, a]` — WASM multi-value
* Arrays: `[a, b]`, `arr[i]`, `arr.length`, `.push`, `.pop`, `.map`, `.filter`, `.reduce`, `.find`, `.indexOf`, `.includes`, `.slice`
* Spread/destructuring: `[...a, ...b]`, `let [x, y] = a`, `let {x, y} = o`
* Objects: `{a: b}`, `{a, b}`, `o.prop`, `o.prop = x`
* Collections: `new Set()`, `new Map()`, `new Float64Array(n)`, `new Int32Array(n)`
* Strings: `s.length`, `s[i]` — SSO for ≤4 chars, heap for longer
* Control: `if`/`else`, `for`, `while`, `switch`/`case`, `return`
* Declarations: `let`, `const`, block scope
* Modules: `import { a } from 'b'`, `import * as m from 'b'`, `export`
* Math: 35+ functions — `sin cos tan atan2 sqrt pow abs min max floor ceil round log exp` etc.
* Comments: `// foo`, `/* bar */`

### Differences

* `var`, `function` → use `let`/`const`, arrows
* `this`, `class`, `super` → use functions & plain data
* `async`/`await` → WASM is synchronous
* `eval`, `arguments`, `with` → explicit is better
* `null`/`undefined` → `0` (indistinguishable)
* `==` behaves like `===` (no coercion)


### CLI

```bash
jz program.js -o program.wasm  # compile to WASM (default)
jz program.js -o program.wat   # compile to WAT
jz -e "1 + 2"                  # evaluate expression
```
<!--

### Modules

Modules extend the compiler by registering emitters on `ctx`:

```js
import { emit, typed, asF64 } from 'jz/src/compile.js'

export default (ctx) => {
  // Inline WASM op
  ctx.emit['mymod.double'] = (a) => typed(['f64.mul', asF64(emit(a)), ['f64.const', 2]], 'f64')

  // Stdlib function (WAT included on demand)
  ctx.emit['mymod.cube'] = (a) => (
    ctx.includes.add('mymod.cube'),
    typed(['call', '$mymod.cube', asF64(emit(a))], 'f64')
  )
  ctx.stdlib['mymod.cube'] = `(func $mymod.cube (param $x f64) (result f64)
    (f64.mul (local.get $x) (f64.mul (local.get $x) (local.get $x))))`
}
``` -->


## Why?

JS became complex with legacy and regrets. Ongoing proposals shape language into something inconsistent, aethetically inconsistent and slow down performance.

_jz_ is (jazzy) javascript zero – no js regrets (coercions, hoisting, `this`, classes), minimal functional JS subset mapping to WASM. Syntax enforces best practices: no linters needed, bad practices don't compile. Valid jz = valid JS. Gateway from JS to low-level: WASM, WASI, native via wasm2c.
Initially conceived for bytebeats, inspired by [porf](https://github.com/CanadaHonk/porffor) and [piezo](https://github.com/dy/piezo). The aim is minimal modern JS subset mapping to WASM.

No classes – use functional style/closures.
No old syntax – use modern ES5+.
No null – that is one of regrets.
No computed props - objects are structs.
No autosemicolons - keep syntax ordered.
No async – keep code plain & simple.


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
