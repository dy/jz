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

// Closures capture by VALUE (not reference)
let makeMultiplier = factor => x => x * factor
let double = makeMultiplier(2)
double(5)  // 10

// NOTE: Mutable captures are NOT supported
// This will throw a compile error:
// let counter = () => { let n = 0; return () => n += 1 }
// Use explicit state passing or globals instead
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

**Forward schema inference**: Objects can be built incrementally:

```js
let a = {}       // Empty object
a.x = 1          // Add property
a.fn = (n) => n * 2  // Add method
a.fn(a.x)        // 2
```

The compiler scans ahead to find all property assignments and builds the complete schema before compilation.

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

**Extension via Object.assign:**

Properties can be added later via `Object.assign` (forward inference detects all props at compile time):

```js
let s = Object.assign("hi", { type: 1 })
Object.assign(s, { extra: 100 })  // extend with more props
s.type + s.extra                  // 101
```

**Limitations:**
- All property names must be known at compile time
- Source must be object literal
- Target must be primitive or array

### Destructuring

```js
// Array destructuring
let [a, b] = [1, 2]

// Object destructuring (params)
let getX = ({ x }) => x
```

### Regex

Regex literals compile to native WASM matching code at compile time:

```js
let isNum = /^\d+$/
isNum.test("123")        // 1 (true)
isNum.test("abc")        // 0 (false)

// Inline usage
/abc/.test("xabcy")      // 1
/xyz/.test("abc")        // 0

// String methods with regex
"hello world".search(/world/)       // 6
"hello world".match(/world/)[0]     // "world"
"a1b2c".split(/\d/)                 // ["a", "b", "c", ""]
"foo bar".replace(/bar/, "baz")     // "foo baz"

// Capture groups with exec()
/(\d+)-(\d+)/.exec("2024-12-25")    // ["2024-12-25", "2024", "12"]
```

**Supported:**
- Literals, character classes `[abc]`, ranges `[a-z]`, negated `[^abc]`
- Quantifiers `*`, `+`, `?`, `{n,m}`, non-greedy `*?`, `+?`
- Anchors `^`, `$`, word boundary `\b`
- Escapes `\d`, `\w`, `\s`, `\D`, `\W`, `\S`, `\n`, `\t`
- Groups `()`, non-capturing `(?:)`, backrefs `\1`
- Lookahead `(?=)`, `(?!)`, lookbehind `(?<=)`, `(?<!)`
- Alternation `a|b`
- Global flag `g` for `replace()` and `match()` methods
- Methods: `regex.test()`, `regex.exec()`, `str.search()`, `str.match()`, `str.replace()`, `str.split()`

**Limitations:**
- Pattern must be literal (no runtime regex construction)
- No named capture groups

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

All standard math available via `Math` object:
```js
Math.sin(x), Math.cos(x), Math.tan(x)
Math.asin(x), Math.acos(x), Math.atan(x), Math.atan2(y, x)
Math.sinh(x), Math.cosh(x), Math.tanh(x)
Math.exp(x), Math.log(x), Math.log2(x), Math.log10(x)
Math.sqrt(x), Math.cbrt(x), Math.pow(x, y)
Math.abs(x), Math.sign(x), Math.floor(x), Math.ceil(x), Math.round(x), Math.trunc(x)
Math.min(a, b), Math.max(a, b), Math.clamp(x, lo, hi)
Math.PI, Math.E
```

## JSON

```js
// Serialize to JSON string
JSON.stringify(42)           // "42"
JSON.stringify([1, 2, 3])    // "[1,2,3]"
JSON.stringify({x: 1, y: 2}) // '{"x":1,"y":2}'

// Parse JSON string
let json = '{"x":1,"y":2}'
let obj = JSON.parse(json)
obj.x + obj.y                // 3

// Nested structures
let data = JSON.parse('[{"a":1},{"b":2}]')
data[0].a                    // 1

// All JSON types supported
JSON.parse('"hello"')        // "hello"
JSON.parse('true')           // 1 (boolean true)
JSON.parse('null')           // 0
```

**Limitations:**
- Objects returned by `JSON.parse` have dynamic keys (Map-based)
- No reviver/replacer functions
- No indentation (compact output only)

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
import { compile as assemble } from 'watr'

// JS → WAT text
const wat = compile('export const f = x => x + 1')

// WAT → WASM binary (requires watr)
const wasm = assemble(wat)
```

### Instantiate with interop
```js
import { compile, instantiate } from 'jz'
import { compile as assemble } from 'watr'

const wat = compile('export const f = x => x + 1')
const wasm = assemble(wat)
const mod = await instantiate(wasm)
mod.f(5)  // 6
```

### Raw WebAssembly Access
```js
import { compile } from 'jz'
import { compile as assemble } from 'watr'

const wat = compile('export const f = x => x + 1')
const wasm = assemble(wat)
const module = await WebAssembly.compile(wasm)
const instance = await WebAssembly.instantiate(module)
instance.exports.f(5)  // 6
```

### Zero-copy Memory Access
```js
import { compile, instantiate, f64view, isPtr, decodePtr, encodePtr } from 'jz'
import { compile as assemble } from 'watr'

const wat = compile('export const getArr = () => [1,2,3].map(x => x*2)')
const wasm = assemble(wat)
const mod = await instantiate(wasm)

// Get raw pointer from wasm namespace
const ptr = mod.wasm.getArr()
if (isPtr(ptr)) {
  // Create zero-copy Float64Array view
  const view = f64view(mod.wasm._memory, ptr)
  console.log(Array.from(view))  // [2, 4, 6]

  // Modify directly in WASM memory
  view[0] = 100

  // Inspect pointer structure
  const { type, aux, offset } = decodePtr(ptr)
  // type=1 (ARRAY), aux=subtype bits, offset=memory address
}
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

### Static Typing (Principal Limitation)

JZ enforces **compile-time type resolution** for zero-overhead performance. No runtime type dispatch.

**What works:**
```js
// Type known at call-site → direct code
[1,2,3].length        // ARRAY → memory read
"abc".length          // STRING → pointer extract
fn([1,2,3])          // Monomorphize fn$array

// Currying (types flow through)
let mul = x => y => x * y
mul(2)(3)            // Both calls fully typed
```

**What doesn't work:**
```js
// ✗ Union types at call-site
let x = cond ? [1] : "hi"
fn(x)                // Error: ambiguous type

// ✗ Generic functions on unknown params
let len = x => x.length  // Error unless monomorphized

// ✗ Spread unknown arrays
function f(...args) {}
let arr = getArray()
f(...arr)            // Error: arr type unknown
```

**Implications:**
- Functions are **monomorphized** per call-site types
- No `typeof` runtime checks (use compile-time type)
- Collections must be **homogeneous** (same element type)
- Spread only works on compile-time known arrays

### Types
- All numbers are `f64` (double precision)
- `null`, `undefined` → `0` (indistinguishable at runtime)
- No BigInt

### Equality
- `==` behaves like `===` (no type coercion)

### Closures
- Closures capture by **value**, not by reference
- Mutating a captured variable throws a compile error
- Use explicit state passing or globals for mutable state

```js
// ✓ Works: capture by value
let factor = 2
let double = x => x * factor  // captures 2

// ✗ Error: mutable capture
let outer = () => {
  let n = 0
  return () => n += 1  // Error: Cannot mutate captured variable 'n'
}
```

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

### Not Supported (Compile Error)

These JS features throw compile errors:

| Feature | Reason | Alternative |
|---------|--------|-------------|
| `async`/`await`/`Promise` | WASM is synchronous | Use callbacks or sync code |
| `class`, `prototype` | No OOP | Use object literals with arrow functions |
| `this` | Context confusion | Use explicit parameter |
| `arguments` | Magic variable | Use `...args` rest parameter |
| `eval`, `Function()` | No dynamic code | - |
| `try`/`catch`/`throw` | No exceptions (yet) | Return error values |
| `Proxy`, `Reflect`, `Symbol` | Metaprogramming not feasible | - |
| `WeakMap`, `WeakSet` | Need GC hooks | Use `Map`/`Set` |
| `delete` | Fixed object shape | - |
| `in` operator | Prototype chain | Use `?.` optional chaining |
| `instanceof` | Prototype-based | Use `typeof` or `Array.isArray()` |
| `with` | Deprecated | - |
| `function*`, `yield` | Generators | Use array methods or loops |
| Dynamic `import()` | Static only | Use static `export` |

### Warnings (Compile but Discouraged)

| Pattern | Issue | Better |
|---------|-------|--------|
| `var x` | Hoisting surprises | `let x` or `const x` |
| `function f() {}` | `this` binding | `f = () => {}` |
| `==`, `!=` | No coercion in JZ | `===`, `!==` |
| `null` vs `undefined` | Both become `0` | Pick one consistently |

### Allowed Constructors

Only built-in constructors work with `new`:

```js
new Array(5)           // ✓ Pre-sized array
new Float64Array(100)  // ✓ TypedArrays
new Set()              // ✓ Collections
new Map()              // ✓
new RegExp('\\d+')     // ✓ Dynamic regex
new MyClass()          // ✗ Error
```

## Performance Tips

1. **Integer arithmetic** is faster - use integer literals for counters
2. **Prefer array methods** over manual iteration
3. **Clone explicitly** with `[...arr]` when shallow copy needed
4. **Avoid unnecessary f64 conversions** in hot loops
