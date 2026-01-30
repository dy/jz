# JZ

JS subset → WebAssembly. Fast, tiny, no runtime.

```js
import jz from 'jz'
const { add } = await jz`export const add = (a, b) => a + b`
add(2, 3)  // 5
```

## Syntax

### Primitives\nNumbers (`0.1`, `0xff`, `0b11`), strings (`\"a\"`, `'b'`), `true`/`false`, `null`, `NaN`, `Infinity`", "oldString": "### Primitives\nNumbers (`0.1`, `0xff`, `0b11`), strings (`\"a\"`, `'b'`), `true`/`false`, `null`, `NaN`, `Infinity`, `PI`, `E`

### Operators
`+ - * / % **` | `< <= > >= == !=` | `~ & | ^ << >> >>>` | `! && || ?? ?:` | `= += -= *= /=`

### Arrays
```js
let a = [1, 2, 3]
a[0]; a[1] = 5; a.length
a.map(x => x * 2); a.filter(x => x > 1); a.reduce((s, x) => s + x, 0)
[...a]  // clone (pointer aliasing otherwise)

// push/pop: O(1) mutable, returns array (not length like JS)
a = a.push(4)   // append → [1,2,3,4], mutates in-place
a.pop()         // removes & returns last element

// shift/unshift: O(1) via ring buffer, returns array
a = a.unshift(0)  // prepend → [0,1,2,3,4]
a.shift()         // removes & returns first element
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
import jz from 'jz'
import math from 'jz/module/math.js'

// Basic compilation
const wasm = jz('export let add = (a, b) => a + b')
const { add } = (await WebAssembly.instantiate(wasm)).instance.exports

// With modules (e.g., Math.sin, Math.PI)
const wasm = jz('export let f = x => Math.sin(x)', { modules: [math] })

// WAT output for debugging
const wat = jz('export let f = x => x * 2', { wat: true })
```

### Module API

Modules extend the compiler by registering:
- `ctx.emit['name']` - emitter function: (args) → WasmNode
- `ctx.stdlib['name']` - WAT function definition string

```js
// Example: custom module
export default (ctx) => {
  // Simple emitter (WASM op)
  ctx.emit['mymod.double'] = (a) => ['f64.mul', emit(a), ['f64.const', 2]]

  // Emitter with stdlib function
  ctx.emit['mymod.cube'] = (a) => {
    ctx.includes.add('mymod.cube')  // mark stdlib for inclusion
    return ['call', '$mymod.cube', emit(a)]
  }

  // WAT stdlib definition
  ctx.stdlib['mymod.cube'] = `(func $mymod.cube (param $x f64) (result f64)
    (f64.mul (local.get $x) (f64.mul (local.get $x) (local.get $x)))
  )`
}
```

## Limitations

### Memory Model
Bump allocator with no automatic free. Designed for:
- Short-lived compute (audio worklets, single-call functions)
- Real-time: no GC pauses
- Call `_resetHeap()` between independent computations to reclaim memory

```js
// Audio worklet pattern: reset each frame
for (let frame = 0; frame < 1000; frame++) {
  const result = mod.wasm.process(samples)
  mod.wasm._resetHeap()  // reclaim all allocations
}
```

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
- **Array type tracking**: static dispatch for push/pop based on known array kind:
  - `flat_array`: literals, `new Array`, `Array.from`, `map`, `filter`, `slice`, etc → inline O(1) code
  - `ring_array`: after `unshift`/`shift` → ring buffer calls
  - Unknown (`array`): function params → runtime dispatch via `$__is_ring` check
- TypedArray.map auto-vectorized (SIMD):
  - `f64x2` (Float64Array), `f32x4` (Float32Array), `i32x4` (Int32Array/Uint32Array)
  - Patterns: `x * c`, `x + c`, `x - c`, `x / c`, `-x`, `Math.abs/sqrt/ceil/floor(x)`, `x & c`, `x | c`, `x << c`
- String `toLowerCase`/`toUpperCase`: i16x8 SIMD for heap strings (>6 chars)
