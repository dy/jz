# jz ![stability](https://img.shields.io/badge/stability-experimental-black)

JS syntax → WASM. No runtime, no GC, no toolchain.

```js
import jz from 'jz'

const { exports } = await WebAssembly.instantiate(jz(`
  let { sin, PI } = Math
  export let sine = (out, freq, t) => {
    for (let i = 0; i < out.length; i++) out[i] = sin((t + i) * freq * PI * 2 / 44100)
  }
`))

exports.sine(audioBuffer, 440, sampleOffset) // native speed, zero GC pauses
```

## Usage

```js
import jz from 'jz'

const wasm = jz(`export let add = (a, b) => a + b`)
const { add } = (await WebAssembly.instantiate(wasm)).instance.exports
add(2, 3) // 5
```

### CLI

```bash
jz program.js -o program.wasm  # compile to WASM (default)
jz program.js -o program.wat   # compile to WAT
jz -e "1 + 2"                  # evaluate expression
```

## Reference

• Numbers: `0.1`, `1.2e+3`, `0xff`, `0b101`, `0o77`
• Strings: `"abc"`, `'abc'`
• Values: `true`, `false`, `null`, `NaN`, `Infinity`
• Arithmetic: `+a`, `-a`, `a + b`, `a - b`, `a * b`, `a / b`, `a % b`, `a ** b`
• Comparison: `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b`
• Bitwise: `~a`, `a & b`, `a ^ b`, `a | b`, `a << b`, `a >> b`, `a >>> b`
• Logic: `!a`, `a && b`, `a || b`, `a ?? b`, `a ? b : c`
• Assignment: `a = b`, `a += b`, `a -= b`, `a *= b`, `a /= b`, `a %= b`
• Functions: `(a, b) => c`, `a => b`, `() => c`, default params
• Currying: `add = x => y => x + y; add(5)(3)`
• Closures: capture outer variables by value
• Multi-return: `(a, b) => [b, a]` — WASM multi-value
• Arrays: `[a, b]`, `arr[i]`, `arr.length`, `.push`, `.pop`, `.map`, `.filter`, `.reduce`, `.find`, `.indexOf`, `.includes`, `.slice`
• Spread/destructuring: `[...a, ...b]`, `let [x, y] = a`, `let {x, y} = o`
• Objects: `{a: b}`, `{a, b}`, `o.prop`, `o.prop = x`
• Collections: `new Set()`, `new Map()`, `new Float64Array(n)`, `new Int32Array(n)`
• Strings: `s.length`, `s[i]` — SSO for ≤4 chars, heap for longer
• Control: `if`/`else`, `for`, `while`, `switch`/`case`, `return`
• Declarations: `let`, `const`, block scope
• Modules: `import { a } from 'b'`, `import * as m from 'b'`, `export`
• Math: 35+ functions — `sin cos tan atan2 sqrt pow abs min max floor ceil round log exp` etc.
• Comments: `// foo`, `/* bar */`

### Excluded

• `var`, `function` → use `let`/`const`, arrows
• `this`, `class`, `super` → use functions & plain data
• `async`/`await` → WASM is synchronous
• `eval`, `arguments`, `with` → explicit is better

### Divergences from JS

• `null`/`undefined` → `0` (indistinguishable)
• `==` behaves like `===` (no coercion)

## Module API

Modules extend the compiler by registering emitters on `ctx`:

```js
import { emit, typed, asF64 } from 'jz/src/compile.js'

export default (ctx) => {
  ctx.emit['mymod.double'] = (a) => typed(['f64.mul', asF64(emit(a)), ['f64.const', 2]], 'f64')
}
```

## Why?

JS has grown complex with legacy features and niche additions. jz focuses on a minimal, modern subset that maps directly to WebAssembly.

### Why not [porffor](https://github.com/CanadaHonk/porffor)?

Porffor targets full JS semantics — needs GC, runtime. jz compiles a subset with zero runtime overhead.

### Why not [assemblyscript](https://github.com/AssemblyScript/assemblyscript)?

AssemblyScript is a separate language with JS-like syntax. jz code is valid JS.

### Why not [javy](https://github.com/nicovideo/javy)?

Javy embeds a JS interpreter inside WASM. jz compiles to native WASM ops directly.

### Why jz?

JavaScript Zero — a return to core, stripped to essentials. Also jazz.

## Built With

* [subscript](https://github.com/dy/subscript) – parser
* [watr](https://www.npmjs.com/package/watr) – WAT to WASM

<p align=center><a href="https://github.com/krishnized/license/">ॐ</a></p>
