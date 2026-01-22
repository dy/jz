# JZ Research

## Pointer Encoding

Integer-packed f64 pointer (survives JS↔WASM boundary):

```
ptr = type * 2^48 + schemaId * 2^40 + len * 2^32 + offset

Layout: [type:4][schemaId:8][len:16][offset:32] = 64 bits
```

- `type` - pointer type (1-7)
- `schemaId` - object schema ID (0 = plain array, 1-255 = named schemas)
- `len` - current length (65535 max)
- `offset` - memory offset (4GB range)

Values ≥ 2^48 are pointers. Regular numbers pass through unchanged.

**PTR_TYPE enum:**
```js
F64_ARRAY: 1,  // [f64, f64, ...] - arrays AND objects
STRING: 3,     // UTF-16 immutable
CLOSURE: 7     // Environment for closures
```

## Object Strategy (Strategy B - Tagged Schema)

Objects are f64 arrays with schema ID encoded in pointer:

```js
let p = { x: 10, y: 20 }
// Schema registry: schemas[1] = ['x', 'y']
// Pointer: type=1, schemaId=1, len=2, offset=X
// Memory: [10.0, 20.0]

p.x  // → compile-time: schemas[1].indexOf('x') = 0 → arr[0]
p.y  // → compile-time: schemas[1].indexOf('y') = 1 → arr[1]
```

**Benefits:**
- Zero overhead: objects ARE arrays at runtime
- Schema survives function boundaries (in pointer)
- JS interop via custom section with schema definitions
- 256 schemas sufficient for any codebase

**Limitations:**
- All values f64 (no mixed types in objects)
- Max 256 distinct schemas
- Property order fixed at definition
- No dynamic property addition

**Static namespaces** (function-only objects) compile to direct calls:
```js
let math = { square: x => x * x }
math.square(5)  // → (call $math_square ...)
```

## Type Preservation

Preserve i32 for integer operations:

```js
let i = 0        // i32.const 0
i + 1            // i32.add (stays i32)
arr[i]           // index is i32
i * 0.5          // promotes to f64
```

**Rules:**
- Integer literals → i32
- i32 op i32 → i32
- i32 op f64 → f64 (promotion)
- Array indices always i32
- Bitwise ops always i32

## JS Interop

Custom section embeds type signatures:
```json
{
  "schemas": { "1": ["x", "y"] },
  "functions": {
    "process": { "params": ["array"], "returns": { "schema": 1 } }
  }
}
```

`instantiate()` auto-wraps exports:
```js
mod.process({ x: 1, y: 2 })  // → [1, 2] → result → { x, y }
```

## JS Divergences

| JS | JZ | Reason |
|----|-----|--------|
| `==` coerces | `==` same as `===` | No coercion in WASM |
| `null !== undefined` | Both are `0` | f64 has no null |
| Array assign shares ref | Pointer copy (COW-like) | WASM memory |

Preserved: `typeof null === "object"`, `NaN !== NaN`, `-0 === 0`
