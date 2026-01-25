# JZ

JS subset → WebAssembly. Fast, tiny, no runtime.

```js
import jz from 'jz'
const { add } = await jz`export const add = (a, b) => a + b`
add(2, 3)  // 5
```

## Syntax

### Primitives
Numbers (`0.1`, `0xff`, `0b11`), strings (`"a"`, `'b'`), `true`/`false`, `null`, `NaN`, `Infinity`, `PI`, `E`

### Operators
`+ - * / % **` | `< <= > >= == !=` | `~ & | ^ << >> >>>` | `! && || ?? ?:` | `= += -= *= /=`

### Arrays
```js
let a = [1, 2, 3]
a[0]; a[1] = 5; a.length; a.push(4); a.pop()
a.map(x => x * 2); a.filter(x => x > 1); a.reduce((s, x) => s + x, 0)
[...a]  // clone (pointer aliasing otherwise)
```

### Functions
```js
let add = (a, b) => a + b          // arrow only
let mul = x => y => x * y          // currying works
mul(2)(3)                          // 6

// Closures capture by VALUE (mutable captures error)
let make = n => x => x * n         // ✓
let bad = () => { let n=0; return () => n++ }  // ✗ Error
```

### Objects
```js
// Static namespace (methods only) → direct calls
let math = { square: x => x * x }
math.square(5)

// Data objects → all JSON types
let p = { x: 10, y: 20, nested: { z: 30 } }
p.x + p.nested.z  // 40
```

### Boxed Primitives
```js
let t = Object.assign("hi", { type: 1 })
t.type    // 1
t.length  // 2
t[0]      // 104
```

### Destructuring
```js
let [a, b] = [1, 2]
let getX = ({ x }) => x
```

### Regex
```js
/^\d+$/.test("123")          // 1
"hello".search(/ell/)        // 1
"a1b2".split(/\d/)           // ["a","b",""]
"foo".replace(/o/g, "x")     // "fxx"
/(\d+)-(\d+)/.exec("12-34")  // ["12-34","12","34"]
```

Supported: `[abc]` `[^a-z]` `* + ? {n,m}` `*? +?` `^ $ \b` `\d \w \s` `()` `(?:)` `\1` `(?=)` `(?!)` `(?<=)` `(?<!)` `|` `g` flag

### Control Flow
```js
let abs = x => x < 0 ? -x : x
let clamp = (x, lo, hi) => { if (x < lo) return lo; if (x > hi) return hi; return x }
```

### Math
```js
Math.sin/cos/tan/asin/acos/atan/atan2/sinh/cosh/tanh
Math.exp/log/log2/log10/sqrt/cbrt/pow
Math.abs/sign/floor/ceil/round/trunc/min/max/clamp
Math.PI, Math.E
```

### JSON
```js
JSON.stringify({x: 1})       // '{"x":1}'
JSON.parse('{"x":1}').x      // 1
```

### TypedArrays
```js
let f = new Float64Array(100)
f[0] = 1.5; f.length; f.map(x => x * 2)
// Also: Float32Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array
```

### Set/Map
```js
let s = new Set(); s.add(1); s.has(1); s.delete(1); s.size
let m = new Map(); m.set("k", 1); m.get("k"); m.has("k"); m.delete("k"); m.size
```

## API

```js
// Tagged template (recommended)
import jz from 'jz'
const { fn } = await jz`export const fn = x => x + 1`

// Compile only
import { compile } from 'jz'
const wat = compile('export const f = x => x + 1')  // JS → WAT

// With watr
import { compile as watr } from 'watr'
const wasm = watr(wat)  // WAT → WASM binary

// Zero-copy memory
import { f64view, isPtr, decodePtr } from 'jz'
const ptr = mod.wasm.getArr()
if (isPtr(ptr)) {
  const view = f64view(mod.wasm._memory, ptr)  // direct Float64Array view
}
```

## Limitations

### Static Typing (Principal)
All types resolved at compile-time. No runtime dispatch.

```js
fn([1,2,3])              // ✓ type known
let x = cond ? [1] : "s"
fn(x)                    // ✗ ambiguous type
```

### Divergences
- Numbers: all `f64` (no BigInt)
- `null`/`undefined` → `0` (indistinguishable)
- `==` behaves like `===`
- Closures capture by value (mutable captures error)
- Array assignment copies pointer: `b = a` aliases
- Object schema fixed at compile-time

### Not Supported
`async/await`, `class`, `this`, `eval`, `try/catch`, `Proxy`, `WeakMap/Set`, `delete`, `in`, `instanceof`, `function*`

### Constructors
Only: `Array`, `Float64Array`, `Float32Array`, `Int32Array`, `Uint32Array`, `Int16Array`, `Uint16Array`, `Int8Array`, `Uint8Array`, `Set`, `Map`, `RegExp`

## Performance

- Integer literals use `i32.const`, preserved through arithmetic
- TypedArray.map auto-vectorized (SIMD):
  - `f64x2` (Float64Array), `f32x4` (Float32Array), `i32x4` (Int32Array/Uint32Array)
  - Patterns: `x * c`, `x + c`, `x - c`, `x / c`, `-x`, `Math.abs/sqrt/ceil/floor(x)`, `x & c`, `x | c`, `x << c`
- String `toLowerCase`/`toUpperCase`: i16x8 SIMD for heap strings (>6 chars)
