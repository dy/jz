# jz ![stability](https://img.shields.io/badge/stability-experimental-black)

Functional modern JS subset compiling to WASM. No runtime, no GC, no overhead.

> `npm install jz`

```js
import jz from 'jz'

let wasm = jz(`export let add = (a, b) => a + b`)
let { add } = (await WebAssembly.instantiate(wasm)).instance.exports
add(2, 3)  // 5

let { sine } = (await WebAssembly.instantiate(jz(`
  export let sine = (freq, t, i) => Math.sin((t + i) * freq * Math.PI * 2 / 44100)
`))).instance.exports
sine(440, 0, 0)  // native speed, zero GC
```

### CLI

> `npm install -g jz`

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
* Modules: `import { a } from 'b'`, `export`
* Math: `sin cos tan atan2 sqrt pow abs min max floor ceil round log exp` ...
* Comments: `// foo`, `/* bar */`
* No `var`, `function`, `this`, `class`, `async`, `eval`, `with`, `arguments`
* `==` is `===`, `null` is `0`

## Why?

JS became complex with legacy and regrets (coercions, hoisting, `this`, classes, precision loss).
Ongoing proposals shape language into something unappealing.

_jz_ is (jazzy) javascript zero – keeps only minimal functional JS best practices mapping to WASM.
Initially conceived for bytebeats, inspired by [porf](https://github.com/CanadaHonk/porffor) and [piezo](https://github.com/dy/piezo).


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
