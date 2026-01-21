## [x] Name -> jz

  * jzu
  * jezu
  * jizy
  * jizy
  * jacy
  * jaiva
  * jaiv
  * jiva
    * jivascript
    * j-iva (nov)
    * jiva from sanscrit
  * jaga
  * jim
    + dim
    - taken
  * subji
    + sub-ji
    + sub js
  * subj
  * sruti
  * jasm?
    + wasm + js
    - taken, hard discussion
  * jazm
    + like jasm, but with reference to zz
    + jazz
  * tasm, sasm, zazm
  * wasc
    + wasm compiler
    + wasm script
  * floatscript
  * numscript
  * bytescript
  * mela
    + assembly
    ~ has to do with language, not compiler
  * @dy/spee
  * jazzz
  * wazz
  * jz
    + java zcript
    + js zero
    + jazz

## [ ] Applications?

  * Web-audio-api?
  * Floatbeats?
  * Metronome?
  * Player?
  * Srutibox

## [ ] Stdlib sources

* [Metallic](https://github.com/jdh8/metallic)
* [Piezo](https://github.com/dy/piezo/blob/main/src/stdlib.js)
* [AssemblyScript](https://github.com/AssemblyScript/musl/tree/master)

## Array Strategy v2 - Headerless with Implicit Capacity

  ### Problem
  WASM GC arrays have fixed length. JS arrays support mutation (push/pop/shift/unshift).
  Previous approach used memory headers, but this complicates memory layout.

  ### Design Goals
  1. **Homogeneous memory** - pure data, no headers
  2. **Self-contained pointer** - all metadata in NaN-boxed f64
  3. **Simple function signatures** - no shadow variables for capacity
  4. **COW-like semantics** - length diverges on mutation, data shared until realloc

  ### Solution: Length in Pointer, Implicit Capacity Tiers

  **Integer-packed pointer encoding:**
  ```
  ptr = type * 2^48 + len * 2^32 + offset

  Layout: [type:4][reserved:12][len:16][offset:32] = 64 bits
  ```
  - `type` - pointer type (1-7, see PTR_TYPE enum)
  - `len` - current length (16 bits = 65535 max elements)
  - `offset` - memory offset to data (32 bits = 4GB range)

  Values above `2^48` (281 trillion) are treated as pointers.
  Regular numbers below this threshold pass through unchanged.

  **Why not NaN-boxing?**
  JS canonicalizes NaN values, destroying pointer metadata when f64 crosses
  JS↔WASM boundary. Integer-packed values survive round-trips cleanly.

  **Decode in WASM (i64 ops):**
  ```wat
  (func $__ptr_offset (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.and (i64.reinterpret_f64 (local.get $ptr)) (i64.const 0xFFFFFFFF))))
  (func $__ptr_len (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 32)) (i64.const 0xFFFF))))
  (func $__ptr_type (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 48))))
  ```

  **Decode in JS:**
  ```js
  const PTR_THRESHOLD = 2 ** 48
  const isPtr = (v) => v >= PTR_THRESHOLD
  const decodePtr = (ptr) => ({
    type: Math.floor(ptr / 2**48),
    len: Math.floor(ptr / 2**32) & 0xFFFF,
    offset: ptr % 2**32
  })
  const encodePtr = (type, len, offset) =>
    type * 2**48 + len * 2**32 + offset
  ```

  **Memory layout at offset:**
  ```
  [elem0:f64][elem1:f64][elem2:f64]...
  ```
  Pure data. No headers. Direct indexing.

  **Implicit capacity tiers (power of 2):**
  ```
  len 1-4    → allocated cap 4    (32 bytes)
  len 5-8    → allocated cap 8    (64 bytes)
  len 9-16   → allocated cap 16   (128 bytes)
  len 17-32  → allocated cap 32   (256 bytes)
  ...up to 65536
  ```

  Capacity derived from length: `cap = nextPow2(max(len, 4))`

  ### Mutation Semantics

  **Push/pop update the pointer (not memory):**
  ```js
  let a = [1, 2, 3]    // ptr: len=3, offset=X, allocated cap=4
  a.push(4)            // ptr: len=4 (fits in cap=4)
  a.push(5)            // len=5 > cap=4 → realloc to cap=8, new offset
  ```

  **COW-like divergence on assignment:**
  ```js
  let a = [1, 2, 3]
  let b = a            // b copies pointer (same len, same offset)
  b[0] = 99            // SHARED: both see change (same memory)
  b.push(4)            // DIVERGES: b.len=4, a.len=3 (different pointers)
  ```

  This is intentional divergence from JS semantics. Warning emitted at compile time.

  **Element mutation is shared:**
  - `b[i] = x` writes to shared memory
  - Both `a` and `b` see the change

  **Length mutation diverges:**
  - `b.push(x)` updates `b`'s pointer only
  - `a` retains original length
  - If realloc needed, `b` points to new memory

  ### Operations

  | Method | Complexity | Notes |
  |--------|------------|-------|
  | `push(x)` | O(1) amortized | Realloc on tier overflow |
  | `pop()` | O(1) | Returns element, decrements len |
  | `shift()` | O(n) | Memmove + decrement len |
  | `unshift(x)` | O(n) | Memmove + increment len |

  ### Helper Functions

  | Function | Purpose |
  |----------|---------|
  | `$__alloc(type, len)` | Allocate with implicit capacity tier |
  | `$__mkptr(type, len, offset)` | Create integer-packed pointer |
  | `$__ptr_offset(ptr)` | Extract offset from pointer |
  | `$__ptr_len(ptr)` | Extract length from pointer |
  | `$__ptr_with_len(ptr, len)` | Return new pointer with updated length |
  | `$__ptr_type(ptr)` | Extract type from pointer |
  | `$__cap_for_len(len)` | Compute capacity tier for length |
  | `$__realloc(ptr, newLen)` | Allocate larger tier, copy data, return new ptr |

  ### Compile-time Warnings

  **Array reassignment warning:**
  ```js
  let a = [1, 2, 3]
  let b = a            // WARNING: array alias - mutations may diverge
  ```

  Emitted in normalize stage when:
  - RHS is identifier referring to array variable
  - Helps users understand COW-like behavior

  ### Special Cases

  **Strings:** Immutable, length in `len` field, no capacity needed.

  **Static arrays:** Stored in data segment, allocated at tier capacity.

### Unified Memory Model

  **Architecture:** Internal operations ALWAYS use linear memory with integer-packed pointers.
  JS interop handled by `instantiate()` which auto-wraps exports based on signature metadata.

  ```
  ┌─────────────────────────────────────────────────────────┐
  │                    WASM Module                          │
  │                                                         │
  │  Internal: linear memory + integer-packed pointers      │
  │  ┌─────────────────────────────────────────────────┐    │
  │  │  let a = [1,2,3]     // packed f64 pointer      │    │
  │  │  a.push(4)           // O(1) in-place           │    │
  │  │  a.filter(fn)        // correct length          │    │
  │  │  helper(a)           // internal call, fast     │    │
  │  └─────────────────────────────────────────────────┘    │
  │                                                         │
  │  (@custom "jz:sig" "{ signatures JSON }")               │
  │  (export "process" (func $process))   ;; raw f64        │
  │  (export "_memory" (memory 0))                          │
  │  (export "_alloc" (func $__alloc))                      │
  └─────────────────────────────────────────────────────────┘
                          ↓
  ┌─────────────────────────────────────────────────────────┐
  │              JS: instantiate(wasm)                      │
  │                                                         │
  │  1. Read @custom "jz:sig" section                       │
  │  2. Wrap exports based on signatures                    │
  │  3. Return { process, _process, _memory, _alloc }       │
  │     - process([1,2,3]) → JS arrays, auto-marshaled      │
  │     - _process(ptr)    → raw f64 pointer                │
  └─────────────────────────────────────────────────────────┘
  ```

  **Naming convention:**
  - `fn(arr)` - wrapped, accepts/returns JS arrays
  - `wasm.fn(ptr)` - raw, accepts/returns packed f64 pointers
  - `wasm.memory` - WebAssembly.Memory for direct access
  - `wasm.alloc(len)` - allocate array, returns packed pointer

  **Custom section for signatures:**
  ```wat
  (@custom "jz:sig" "{\"process\":{\"params\":[\"array\"],\"returns\":\"array\"}}")
  ```

  Read in JS via `WebAssembly.Module.customSections(module, 'jz:sig')`.

  **Example:**
  ```js
  // User code
  export const process = (arr) => arr.map(x => x * 2)
  const helper = (arr) => arr[0]  // internal only
  ```

  ```wat
  ;; Generated WASM - all functions use raw f64 signatures
  (func $helper (param $arr f64) (result f64) ...)
  (func $process (param $arr f64) (result f64) ...)
  (export "process" (func $process))
  (export "_memory" (memory 0))
  (export "_alloc" (func $__alloc))
  (@custom "jz:sig" "{\"process\":{\"params\":[\"array\"],\"returns\":\"array\"}}")
  ```

  ```js
  // Usage
  const mod = await jz.instantiate(wasm)
  mod.process([1, 2, 3])     // → [2, 4, 6] (auto-wrapped)
  mod.wasm.process(ptr)          // → packed f64 (raw)
  ```

  **Benefits:**
  - Pure WASM: no GC types needed, works everywhere
  - Self-describing: signatures embedded in binary
  - Portable: other hosts can read custom section
  - Convenient: JS users get auto-wrapped arrays
  - Escape hatch: `_` prefix for raw access

  **Trade-offs:**
  - JS wrapper has copy overhead (but only at boundary)
  - Numbers > 2^48 reserved for pointers (extremely rare in practice)

## Static Namespaces

  Object literals containing only arrow functions are compiled as **static namespaces** -
  direct function calls with zero runtime overhead.

  ```js
  let rgb = {
    gray: (r, g, b) => 0.2126*r + 0.7152*g + 0.0722*b,
    invert: (r, g, b) => [255-r, 255-g, 255-b]
  }
  rgb.gray(100, 150, 200)  // → (call $rgb_gray ...)
  ```

  **Compiles to:**
  - `$rgb_gray` function (direct call, no indirection)
  - `$rgb_invert` function (direct call)
  - No memory allocation for the object
  - No closure overhead

  **Requirements for namespace optimization:**
  - All properties must be arrow functions
  - Functions must not capture outer variables (except other namespaces)
  - Object must be assigned at declaration (`let ns = {...}`)

  **When namespace optimization doesn't apply:**
  - Dynamic property assignment: `ns.fn = newFn` (uses memory-based objects)
  - Non-function properties: `{x: 5, fn: () => x}` (uses memory-based objects)
  - Captured outer variables: `let y = 1; let ns = {fn: () => y}` (uses closures)

## JS Divergences

  JZ compiles JS to WASM. Some JS behaviors cannot be preserved due to WASM limitations.
  JZ warns on problematic patterns but does not silently change JS semantics.

  ### Unavoidable Divergences

  | JS Behavior | JZ Behavior | Cause |
  |-------------|-------------|-------|
  | `==` does type coercion | `==` same as `===` | No coercion in WASM |
  | `null !== undefined` | Both are `0` | WASM f64 has no null type |
  | Array assign shares reference | Pointer copy (COW-like) | WASM memory model |

  ### JS-Compatible (Quirks Preserved)

  | Pattern | Behavior | Note |
  |---------|----------|------|
  | `typeof null === "object"` | ✓ preserved | Historical JS bug, kept for compat |
  | `NaN !== NaN` | ✓ preserved | IEEE 754 standard |
  | `-0 === 0` | ✓ preserved | IEEE 754 standard |

  ### Warnings Emitted

  | Pattern | Warning | Fix |
  |---------|---------|-----|
  | `var x` | "Use let/const" | Hoisting surprises |
  | `x = 1` (undeclared) | Error: implicit global | Declare with let/const |
  | `parseInt(x)` | "Missing radix" | Use `parseInt(x, 10)` |
  | `+[]`, `[] + {}` | Error: nonsense coercion | Don't do this |
  | `x == null` | "Coercion idiom" | Use `x === null \|\| x === undefined` |
  | `NaN === NaN` | "Always false" | Use `Number.isNaN(x)` |
  | `let b = a` (array) | "Pointer copy" | Use `[...a]` for clone |
