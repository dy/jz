# JZ Research

## NaN Boxing Pointer Encoding (v5)

**Status: Implemented.** V8 preserves NaN payload bits through JS operations and WASM↔JS boundary.

### Encoding

```
Regular f64:  any IEEE 754 value (full number range preserved)
Pointer:      0x7FF8_xxxx_xxxx_xxxx (quiet NaN + non-zero 51-bit payload)
Canonical NaN: 0x7FF8_0000_0000_0000 (payload=0, NOT a pointer)
```

Quiet NaN signature: exponent=0x7FF, bit 51=1 (quiet), bits 0-50 = payload.

### Pointer Detection

```wat
;; Check if value is a pointer (quiet NaN with non-zero payload)
;; Canonical NaN (0x7FF8000000000000) has payload=0, NOT a pointer
(func $__is_pointer (param $val f64) (result i32)
  (local $bits i64)
  (local.set $bits (i64.reinterpret_f64 (local.get $val)))
  (i32.and
    ;; Has quiet NaN prefix?
    (i64.eq
      (i64.and (local.get $bits) (i64.const 0x7FF8000000000000))
      (i64.const 0x7FF8000000000000))
    ;; Has non-zero payload? (bits 0-50)
    (i64.ne
      (i64.and (local.get $bits) (i64.const 0x0007FFFFFFFFFFFF))
      (i64.const 0))))
```

### Unified Payload Layout

All pointer types use consistent layout:

```
Payload (51 bits): [type:4][id:16][offset:31]

type   = pointer type (1-15)
id     = type-specific identifier (length, instanceId, schemaId, funcIdx)
offset = memory offset (2GB addressable)
```

### Pointer Types (Implemented)

| Type | Name | id field | Status |
|------|------|----------|--------|
| 1 | ARRAY | len | ✓ Immutable array |
| 2 | ARRAY_MUT | instanceId | ✓ Mutable array or array+props (via schemaId in instance table) |
| 3 | STRING | len | ✓ Immutable string |
| 4 | OBJECT | schemaId | ✓ Object (or boxed string if schema[0]==='__string__') |
| 7 | CLOSURE | funcIdx | ✓ Closure |

Note: Types 5-6 reserved (merged into OBJECT and ARRAY_MUT).

### Instance Table (for mutable types)

First 64KB of memory reserved for instance table (16K instances × 4 bytes):

```
InstanceTable[instanceId] = {
  len: u16,        // current length (array elements only, not props)
  schemaId: u16    // 0 = plain mutable array, >0 = array with named properties
}
```

When schemaId > 0, properties are stored after array elements:
```
Memory: [elem0, elem1, ..., prop0, prop1, ...]
        ├─── len elements ───┤├── schema props ──┤
```

### Schema Registry (compile-time)

```js
ctx.schemas[schemaId] = ['x', 'y', 'z']  // property names in order
```

- Object property access: compile-time index lookup
- 64K schemas (16 bits in id field)

### Array Type Selection

Compile-time detection:

```js
const arr = [1, 2, 3]     // ARRAY (immutable)
arr[0] = 5                // still ARRAY (element mutation ok)
arr.map(x => x * 2)       // returns new ARRAY

const buf = []            // ARRAY_MUT (starts empty, will grow)
buf.push(1)               // ARRAY_MUT (length changes)
```

**Upgrade to ARRAY_MUT:**
- `.push()`, `.pop()` (length-changing operations)
- Empty array literal `[]` (will likely grow)

**Stay ARRAY (immutable):**
- Element access/mutation `arr[i] = x`
- `.map()`, `.filter()`, `.slice()`, `.concat()` (return new)
- `.reduce()`, `.find()`, `.indexOf()` (return values)

---

## Boxed Primitives

All use OBJECT type (4) with reserved first schema key:

| Boxed Type | Schema[0] | Memory[0] |
|------------|-----------|-----------|
| String | `__string__` | string pointer |
| Number | `__number__` | f64 value |
| Boolean | `__boolean__` | 0 or 1 as f64 |

Created via `Object.assign(primitive, {props...})`:

```js
let token = Object.assign("hello", { type: 1 })
let value = Object.assign(42, { scale: 2 })
let flag = Object.assign(true, { code: 200 })

// Property access works
token.type   // 1
value.scale  // 2
flag.code    // 200

// String-specific access still works
token.length // 5
token[0]     // 104 ('h')
```

## Array with Properties

Created via `Object.assign([arr], {props...})`:

```
Type: ARRAY_MUT (2) with schemaId > 0
Instance: { len: 3, schemaId: 5 }
Schema[5]: ['loc']
Memory: [1, 2, 3, loc_value]

Access:
  arr[i]      → memory[i] (i < len)
  arr.length  → instance.len
  arr.loc     → memory[len + schema.indexOf('loc')]
```

Note: Uses same pointer type as mutable arrays - distinguished by schemaId.

### WAT Implementation

```wat
;; NaN box base
(global $NAN_BOX i64 (i64.const 0x7FF8000000000000))

;; Create NaN-boxed pointer
(func $__mkptr (param $type i32) (param $id i32) (param $offset i32) (result f64)
  (f64.reinterpret_i64
    (i64.or (global.get $NAN_BOX)
      (i64.or
        (i64.shl (i64.extend_i32_u (local.get $type)) (i64.const 47))
        (i64.or
          (i64.shl (i64.extend_i32_u (local.get $id)) (i64.const 31))
          (i64.extend_i32_u (local.get $offset)))))))

;; Compare two pointers by bit pattern (NaN === NaN fails with f64.eq)
(func $__ptr_eq (param $a f64) (param $b f64) (result i32)
  (i64.eq (i64.reinterpret_f64 (local.get $a)) (i64.reinterpret_f64 (local.get $b))))

;; Smart f64 comparison: handles both numbers and NaN-boxed pointers
(func $__f64_eq (param $a f64) (param $b f64) (result i32)
  (if (result i32) (f64.eq (local.get $a) (local.get $b))
    (then (i32.const 1))
    (else
      (if (result i32) (i32.and (call $__is_pointer (local.get $a)) (call $__is_pointer (local.get $b)))
        (then (i64.eq (i64.reinterpret_f64 (local.get $a)) (i64.reinterpret_f64 (local.get $b))))
        (else (i32.const 0))))))

;; Extract type (bits 47-50)
(func $__ptr_type (param $ptr f64) (result i32)
  (i32.and
    (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 47)))
    (i32.const 0xF)))

;; Extract id (bits 31-46)
(func $__ptr_id (param $ptr f64) (result i32)
  (i32.and
    (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 31)))
    (i32.const 0xFFFF)))

;; Extract offset (bits 0-30)
(func $__ptr_offset (param $ptr f64) (result i32)
  (i32.and
    (i32.wrap_i64 (i64.reinterpret_f64 (local.get $ptr)))
    (i32.const 0x7FFFFFFF)))
```

### Limits

| Resource | Limit | Notes |
|----------|-------|-------|
| Memory | 2GB | 31-bit offset |
| Numbers | Full f64 range | NaN boxing preserves all values |
| Immutable arrays | Unlimited | Length in pointer (max 64K elements) |
| Mutable arrays | 16K concurrent | Instance table entries |
| Strings | Unlimited | Length in pointer (max 64K chars) |
| Object schemas | 64K | Compile-time registry |
| Closures | 64K functions | Function table |

---

## Object Strategy

Objects are f64 arrays with schemaId in pointer:

```js
let p = { x: 10, y: 20 }
// Schema: schemas[1] = ['x', 'y']
// Pointer: type=4, id=1 (schemaId), offset=X
// Memory: [10.0, 20.0]

p.x  // → compile-time: schemas[1].indexOf('x') = 0 → memory[offset + 0*8]
```

**Supported:**
- All JSON types: numbers, strings, bools, arrays, nested objects
- Nested access: `x.inner.val` (schema propagated)
- Methods as closures

---

## JS Interop

Custom section `jz:sig` contains export signatures and schemas:
```json
{
  "schemas": { "1": ["x", "y"], "2": ["name", "value"] },
  "sum": { "arrayParams": [0], "returnsArray": false }
}
```

JS wrapper (`instantiate()`) detects NaN-boxed pointers and converts:
- Arrays → JS arrays (recursive)
- Objects → JS objects with schema keys
- Strings → JS strings

---

## TypedArrays

**Status: Design complete.**

### Pointer Format

Different layout from regular pointers to maximize capacity:

```
Regular:    [type:4][id:16][offset:31]     = 51 bits
TypedArray: [type:4][elemType:3][len:22][offset:22] = 51 bits
```

| Field | Bits | Range | Notes |
|-------|------|-------|-------|
| type | 4 | 5 | PTR_TYPE.TYPED_ARRAY |
| elemType | 3 | 0-7 | i8, u8, i16, u16, i32, u32, f32, f64 |
| len | 22 | 0-4M | Element count |
| offset | 22 | 0-4MB | Byte offset in typed array region |

### Element Types

```js
const ELEM_TYPE = {
  I8: 0,   // Int8Array,    stride 1
  U8: 1,   // Uint8Array,   stride 1
  I16: 2,  // Int16Array,   stride 2
  U16: 3,  // Uint16Array,  stride 2
  I32: 4,  // Int32Array,   stride 4
  U32: 5,  // Uint32Array,  stride 4
  F32: 6,  // Float32Array, stride 4
  F64: 7   // Float64Array, stride 8
}
```

Stride: `[1, 1, 2, 2, 4, 4, 4, 8][elemType]`

### Memory Management

**Arena/bump allocator** - optimized for "few large buffers" pattern:

```
Memory layout:
[instance table 64KB][regular heap...][typed array region →]

TypedArray region: bump pointer, grows upward
```

**Allocation:**
```js
let buf = new Float32Array(1024)
// bump += 1024 * 4 (stride)
// pointer = mkTypedPtr(F32, 1024, oldBump)
```

**Deallocation strategies:**

1. **Scope-local (automatic):** Compiler tracks high-water mark per scope. If buffer doesn't escape, rewind bump on scope exit. LIFO discipline avoids fragmentation.

2. **Arena reset (manual):** Export `_resetTypedArrays()` rewinds bump to start. User calls between frames/batches.

3. **No individual free:** Avoids fragmentation complexity.

### Escape Analysis

Compiler determines if TypedArray escapes function scope:

```js
// Doesn't escape - auto-freed on return
(n) => {
  let temp = new Float32Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) sum += temp[i]
  return sum
}

// Escapes - persists until arena reset
(n) => {
  let buf = new Float32Array(n)
  return buf  // returned = escaped
}
```

Escape conditions: returned, stored in outer scope, captured by closure, passed to external function.

### JS Interop

TypedArray pointers in `jz:sig`:
```json
{
  "process": {
    "typedArrayParams": [{ "index": 0, "elemType": 6 }],
    "returnsTypedArray": { "elemType": 6 }
  }
}
```

JS wrapper converts:
- JS TypedArray → copy to WASM memory, return pointer
- WASM pointer → wrap as TypedArray view (zero-copy if possible)

### Limits

| Resource | Limit | Notes |
|----------|-------|-------|
| Elements per array | 4M | 22-bit len |
| Total typed memory | 4MB | 22-bit offset (single region) |
| Element types | 8 | 3-bit elemType |

Typical usage: few buffers × ~100K elements = well within limits.

### Syntax

```js
// Construction
let buf = new Float32Array(1024)
let data = new Uint8Array(256)

// Access (returns appropriate type)
buf[0] = 1.5       // f32 store
let x = buf[0]     // f32 load → f64

// Properties
buf.length         // from pointer (22 bits)
buf.byteLength     // len * stride

// No methods initially (add as needed)
```

---

## Previous: Integer-Packed Encoding (v4)

*Superseded by NaN boxing. Had 2^48 number limit and only 16 schemas.*
