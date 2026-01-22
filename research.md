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
| 1 | ARRAY | len | ✓ Implemented |
| 2 | ARRAY_MUT | instanceId | ✓ Implemented |
| 3 | STRING | len | ✓ Implemented |
| 4 | OBJECT | schemaId | ✓ Implemented |
| 7 | CLOSURE | funcIdx | ✓ Implemented |

### Pointer Types (Reserved for future)

| Type | Name | id field | Notes |
|------|------|----------|-------|
| 5 | BOXED_STRING | schemaId | String with properties |
| 6 | ARRAY_PROPS | instanceId | Array with named properties |

### Instance Table (for mutable types)

First 64KB of memory reserved for instance table (16K instances × 4 bytes):

```
InstanceTable[instanceId] = {
  len: u16,        // current length
  schemaId: u16    // 0 = plain array, >0 = has schema (reserved)
}
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

## Future: Boxed String

Design for `Object.assign(new String('abc'), {type: 'f64'})`:

```
Type: BOXED_STRING (5)
Schema: ['__string__', 'type']
Memory: [stringPtr, typeValue]

Access:
  boxed[i], boxed.charAt(i)  → delegate to stringPtr
  boxed.type                 → schema lookup → memory[1]
  boxed.length               → string length
```

## Future: Array with Properties

Design for arrays with named properties:

```
Type: ARRAY_PROPS (6)
Instance: { len: 3, schemaId: 5 }
Schema[5]: ['loc']
Memory: [1, 2, 3, 4]

Access:
  arr[i]      → memory[i] (i < len)
  arr.length  → instance.len
  arr.loc     → memory[len + schema.indexOf('loc')]
```

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

## Previous: Integer-Packed Encoding (v4)

*Superseded by NaN boxing. Had 2^48 number limit and only 16 schemas.*
