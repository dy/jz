# jz ![stability](https://img.shields.io/badge/stability-experimental-black)

Distilled JS subset → pure WASM. No runtime, no GC, no overhead.

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

## Syntax Reference

### Primitives
Numbers (`0.1`, `0xff`, `0b101`, `0o77`, `1.2e+3`), `true`, `false`, `null`, `NaN`, `Infinity`

### Operators
`+ - * / % **` | `< <= > >= == !=` | `~ & | ^ << >> >>>` | `! && || ?? ?:` | `= += -= *= /= %=` | `void`

Type coercion by operator: `1 + 2` stays i32 internally, `1 / 3` always f64, bitwise always i32.

### Functions
```js
let add = (a, b) => a + b            // expression body
let abs = (x) => {                    // block body
  if (x < 0) return -x
  return x
}
let greet = (name = 'world') => name  // default params
```

### Control Flow
```js
if (x > 0) return x; else return -x
for (let i = 0; i < n; i++) s += i
while (i < n) i++
switch (x) { case 1: return 10; default: return 0 }
```

### Imports
```js
import { sin, PI } from 'math'       // named
import { sin as s } from 'math'      // aliased
import * as m from 'math'            // namespace
import math from 'math'              // default (namespace)
```

### Math (35+ functions)
```js
import { sin, cos, PI } from 'math'   // explicit imports
Math.sin(x)                            // or auto-import via Math.*

// Trig: sin cos tan asin acos atan atan2 sinh cosh tanh asinh acosh atanh
// Exp:  exp expm1 log log2 log10 log1p sqrt cbrt pow hypot
// Round: abs sign floor ceil round trunc min max fround clz32 imul
// Const: PI E LN2 LN10 LOG2E LOG10E SQRT2 SQRT1_2
// Other: random
```

### Multi-value Return
```js
// Array literal return = multi-value (JS gets real Array)
export let swap = (a, b) => [b, a]
export let divmod = (a, b) => { let q = a / b; return [q, a % b] }
```

### Arrays
```js
let a = [1, 2, 3]
a[0]; a[i] = x; a.length           // read, write, length
a.push(4); a.pop()                  // mutate in place (aliases see changes)
a.map(fn); a.filter(fn); a.reduce(fn, 0)  // callbacks via closures
a.forEach(fn); a.find(fn); a.indexOf(x); a.includes(x); a.slice(1, 3)
let [x, y] = a                     // destructuring
[...a, ...b, 99]                   // spread
```

### Objects
```js
let o = {x: 1, y: 2}
o.x; o.y = 5                       // read, write (schema-based)
let {x, y} = o; let {x: a} = o    // destructuring, alias
```

### Strings
```js
let s = "hi"                        // SSO (≤4 chars inline, no allocation)
let s = "hello world"               // heap (memory allocated)
s.length; s[0]                      // length, charCodeAt
```

### Closures
```js
let add = (a) => (b) => a + b      // currying (capture by value)
let apply = (fn, x) => fn(x)       // first-class functions (call_indirect)
arr.map((x) => x * 2)              // callbacks
```

### Collections
```js
let s = new Set(); s.add(1); s.has(1); s.delete(1); s.size
let m = new Map(); m.set(k, v); m.get(k); m.size
new Float64Array(n); new Int32Array(n)    // TypedArrays
```

### Prohibited (by design)
`this`, `class`, `super` — use functions & composition
`async`/`await` — WASM is synchronous
`var`, `function` — use `let`/`const`, arrow functions
`eval`, `arguments`, `with` — explicit is better

### Not yet
Template literals, string methods (.slice, .indexOf, etc.), rest params, regex, JSON

## Module API

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
```

## Limitations

### Static Typing
All types resolved at compile-time. No runtime dispatch.

### Divergences from JS
- `null`/`undefined` → `0` (indistinguishable)
- `==` behaves like `===` (no coercion)
- `i++` and `++i` both increment (no value distinction yet)
- Division always produces f64

### CLI

```bash
jz "1 + 2"                               # 3
jz "Math.sqrt(144)"                      # 12
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
