# JZ User Documentation

JZ compiles a minimal JavaScript subset to WebAssembly. Fast, tiny, no runtime.

## Quick Start

```js
import jz from 'jz'

const { add, mul } = await jz`
  export const add = (a, b) => a + b;
  export const mul = (x, y) => x * y;
`

add(2, 3)  // 5
mul(4, 5)  // 20
```

## Supported Syntax

### Primitives
- Numbers: `0.1`, `1.2e+3`, `0xabc`, `0b101`, `0o357`
- Strings: `"abc"`, `'abc'`
- Booleans: `true`, `false`
- Special: `null`, `NaN`, `Infinity`
- Math: `PI`, `E`

### Operators
- Arithmetic: `+a`, `-a`, `a + b`, `a - b`, `a * b`, `a / b`, `a % b`, `a ** b`
- Comparison: `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b`, `a === b`, `a !== b`
- Bitwise: `~a`, `a & b`, `a ^ b`, `a | b`, `a << b`, `a >> b`, `a >>> b`
- Logic: `!a`, `a && b`, `a || b`, `a ?? b`, `a ? b : c`
- Assignment: `a = b`, `a += b`, `a -= b`, `a *= b`, `a /= b`, `a %= b`

### Arrays
```js
let arr = [1, 2, 3]
arr[0]           // access
arr[1] = 5       // mutate
arr.length       // length
arr.push(4)      // append
arr.pop()        // remove last
arr.map(x => x * 2)
arr.filter(x => x > 1)
arr.reduce((a, b) => a + b, 0)
[...arr]         // clone
```

### Functions
```js
// Arrow functions only
let add = (a, b) => a + b
let double = x => x * 2
let greet = () => "hi"

// Currying
let add3 = x => y => z => x + y + z
add3(1)(2)(3)  // 6

// Closures
let counter = () => {
  let n = 0;
  return () => n += 1
}
```

### Objects (Static Namespaces)

Objects with only function properties compile to direct calls:

```js
let math = {
  square: x => x * x,
  cube: x => x * x * x
}
math.square(5)  // → (call $math_square ...)
```

**Limitations:**
- All properties must be arrow functions
- No dynamic property assignment after creation

### Objects (Data)

Objects with data properties support all JSON types:

```js
let point = { x: 10, y: 20 }
point.x + point.y  // 30
point.x = 15       // mutation works

// All JSON types supported
let data = {
  num: 42,
  str: "hello",
  flag: true,
  arr: [1, 2, 3],
  nested: { a: 1, b: 2 }
}

// Nested access works
data.nested.a  // 1
```

### Boxed Primitives

Add properties to primitives via `Object.assign`:

```js
// Boxed string with properties
let token = Object.assign("hello", { type: 1, pos: 5 })
token.type    // 1 (property access)
token.length  // 5 (string length)
token[0]      // 104 (charCode at index 0)

// Boxed number with properties
let value = Object.assign(255, { r: 1, g: 0.5, b: 0 })
value.r       // 1 (property access)

// Boxed boolean with properties
let result = Object.assign(true, { code: 200 })
result.code   // 200 (property access)

// Array with properties
let items = Object.assign([1, 2, 3], { sum: 6, name: "nums" })
items.sum     // 6 (property access)
items.length  // 3 (array length)
items[0]      // 1 (array element)
```

**Limitations:**
- Properties fixed at creation (no dynamic addition)
- Source must be object literal
- Target must be primitive or array

### Destructuring

```js
// Array destructuring
let [a, b] = [1, 2]

// Object destructuring (params)
let getX = ({ x }) => x
```

### Control Flow
```js
// Conditionals via ternary
let abs = x => x < 0 ? -x : x

// Early return
let clamp = (x, lo, hi) => {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x
}
```

## Math Functions

All standard math available:
```js
sin(x), cos(x), tan(x)
asin(x), acos(x), atan(x), atan2(y, x)
sinh(x), cosh(x), tanh(x)
exp(x), log(x), log2(x), log10(x)
sqrt(x), cbrt(x), pow(x, y)
abs(x), sign(x), floor(x), ceil(x), round(x), trunc(x)
min(a, b), max(a, b), clamp(x, lo, hi)
```

## API

### Tagged Template (Recommended)
```js
import jz from 'jz'
const { fn1, fn2 } = await jz`
  export const fn1 = x => x + 1;
  export const fn2 = x => x * 2;
`
```

### Compile Only
```js
import { compile } from 'jz'

// To WASM binary
const wasm = compile('export const f = x => x + 1')

// To WAT text
const wat = compile('export const f = x => x + 1', { text: true })
```

### Instantiate
```js
import { compile, instantiate } from 'jz'
const wasm = compile('export const f = x => x + 1')
const mod = await instantiate(wasm)
mod.f(5)  // 6
```

### Raw WebAssembly Access
```js
const wasm = compile('export const f = x => x + 1')
const module = await WebAssembly.compile(wasm)
const instance = await WebAssembly.instantiate(module)
instance.exports.f(5)  // 6
```

## CLI

```bash
# Evaluate expression
jz "1 + 2"

# Compile to WASM
jz compile program.jz -o program.wasm

# Compile to WAT
jz compile program.jz --text -o program.wat

# Run WAT file
jz run program.wat
```

## Limitations & Divergences

### Types
- All numbers are `f64` (double precision)
- `null`, `undefined` → `0` (indistinguishable at runtime)
- No BigInt

### Equality
- `==` behaves like `===` (no type coercion)

### Arrays
```js
let a = [1, 2, 3]
let b = a        // b copies pointer (same memory)
b[0] = 99        // Both see change!
b.push(4)        // Only b's length changes
```

Use `[...a]` to clone arrays explicitly.

### Objects
- Properties can store any JSON type: numbers, strings, bools, arrays, nested objects
- Schema (property names/order) fixed at compile time
- Max 64K distinct object schemas per module
- Nested object access works: `x.inner.val`
- No dynamic property addition
- No computed property names

### Numbers & i32 Type Preservation
- All numbers are `f64` (double precision) at JS level
- Full numeric range available (no reserved values)
- Integer literals (42, 0, -1) use `i32.const` internally
- i32 + i32 arithmetic preserves i32 type
- i32 + f64 promotes to f64
- Division always promotes to f64
- Bitwise operations always use i32
- Array indices are i32
- Loop counters stay i32 when initialized with integers

```js
// i32 preserved:
let i = 0; i + 1        // i32.add
let x = 5; x & 3        // i32.and
let y = 1; y << 2       // i32.shl

// Promotes to f64:
let a = 1; a + 0.5      // f64.add
let b = 4; b / 2        // f64.div
```

### Not Supported
- `var` (use `let`/`const`)
- `class`, `new`, `this`
- `async`/`await`, generators
- `try`/`catch`
- Regular expressions
- Template literals with expressions

## Performance Tips

1. **Integer arithmetic** is faster - use integer literals for counters
2. **Prefer array methods** over manual iteration
3. **Static namespaces** for zero-overhead function grouping
4. **Clone explicitly** with `[...arr]` when shallow copy needed
5. **Avoid unnecessary f64 conversions** in hot loops
