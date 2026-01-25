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

## [x] Goals
  * _Lightweight_ – embed anywhere, from websites to microcontrollers.
  * _Fast_ – compiles to WASM faster than `eval` parses.
  * _Tiny output_ – no runtime, no heap, no wrappers.
  * _Zero overhead_ – no runtime type checks, functions monomorphized per call-site.
  * _JS interop_ – export/import, preserve func signatures at WASM boundary.
  * _JS compat_ – any jz is valid js (with [limitations](./docs.md#limitations-divergences))
  * It must be fun, toy JS compiler, but practical
  * It must be simple, but extensible (like subscript)
  * It must be lightweight, but versatile
  * It must be transparent, but clever
  * Uncompromised performance.

## [x] Applications? -> Audio/DSP, real-time compute
  * Web-audio-api worklets (latency-critical, no GC pauses)
  * Floatbeats/bytebeat generators
  * Game physics/math kernels
  * Embedded scripting (IoT, microcontrollers)
  * Plugin systems (safe sandboxed compute)

## [x] Arrays: GC vs memory -> Memory (linear)
  0. Linear memory with NaN-boxed pointers
    + Zero-copy JS interop via SharedArrayBuffer
    + Predictable performance (no GC pauses)
    + Direct memory layout control
    + Works in audio worklets (no GC allowed)
    + Simpler mental model (C-like)
    - Manual capacity management
    - No automatic cleanup (acceptable for short-lived modules)

  1. WASM GC (externref/anyref)
    + Automatic memory management
    + Better integration with host GC
    - GC pauses break real-time guarantees
    - Less control over memory layout
    - Harder zero-copy interop
    - Still evolving spec

  * Decision: Linear memory. Audio/DSP primary use case demands deterministic timing.
    GC pauses in audio thread = audible glitches. Trade automatic cleanup for predictability.

## [x] Closures: how? -> Capture by value + explicit env param
  0. No closures
    - Too limiting for functional style
    + Simplest

  1. Capture by reference (JS semantics)
    + JS-compatible
    - Requires mutable cells/indirection
    - Violates zero-overhead (heap allocation per capture)
    - Complex escape analysis needed

  2. Capture by value (current)
    + Zero runtime cost for immutable captures
    + Simple: copy values at closure creation
    + No escape analysis needed
    + Sufficient for functional patterns (currying, callbacks)
    - Mutable captures disallowed (compile error)
    - Slight divergence from JS (documented)

  3. Global context switch (rejected)
    ```
    call: (global.set $__ctx newEnv) (call $f args) (global.set $__ctx prevEnv)
    func: reads (global.get $__ctx) internally
    ```
    + Cleaner function signatures (no $__env param)
    - 2 global writes per call vs 1 extra param
    - Need save/restore stack for nested calls
    - Problematic for parallelism (global mutation)
    - Complicates deeply nested closures (currying)

  * Decision: Capture by value + explicit env param.
    Mutable closures rare in hot paths. Functional patterns work fine.
    Explicit env param is WASM-idiomatic, handles nesting naturally.

  * Implementation: NaN-boxed pointer with [funcIdx:16][envOffset:31].
    Env stored in linear memory. call_indirect with env as first param.

## [x] Pointers -> NaN-boxing
  0. NaN-boxing (current)
    + Single f64 value = clean JS interop
    + 51-bit payload: [type:4][aux:16][offset:31]
    + Functions stay (f64, f64) → f64 signature
    + Transparent pass-through to JS (it's just a number)
    + Can encode type + length + offset in one value
    - 2GB addressable limit (sufficient for embedded)
    - Quiet NaN specific encoding

  1. Separate i32 pointer variable
    + Unlimited address space
    - Breaks function signatures
    - Awkward JS interop (need wrapper)
    - Two values where one should do

  2. Plain integer offset
    + Simple
    - No type info
    - No length encoding
    - Still breaks f64-only signatures

  * Decision: NaN-boxing. Preserves function signatures, enables zero-copy
    JS interop, encodes metadata without overhead. 2GB limit is non-issue
    for target use cases (audio buffers, game state).

## [x] Types -> Monomorphic + hybrid fallback
  0. Monomorphic (primary)
    + Zero runtime dispatch
    + Optimal code per call-site
    + Type errors at compile time
    + Enables direct WASM ops (i32.add vs f64.add)
    - No union types
    - Functions duplicated per type combo
    - Code size can grow (mitigated by tree-shaking)

  1. Hybrid: monomorphic + runtime fallback
    + Best of both: zero-overhead when types known
    + Graceful degradation for union types
    + More JS-compatible
    - Runtime switch overhead on fallback paths
    - Slight code growth (only reachable type branches emitted)
    ```wat
    ;; Union type (array|string) - only 2 branches, not all types:
    (if (i32.eq (call $__ptr_type ptr) (i32.const 1))  ;; ARRAY
      (then ...array path...)
      (else ...string path...))  ;; must be STRING
    ```
    * Compiler tracks type flow → emits only reachable alternatives
    * Single-type = direct code (no branch)
    * Two types = if/else
    * N types = nested ifs or br_table

  2. Pure runtime dispatch
    + Handles any type
    - Runtime overhead per operation
    - Violates zero-overhead principle
    - Complex runtime needed

  3. Type erasure (all f64)
    + Uniform representation
    - Loses type info for optimization
    - Can't use i32 ops for integers

  * Decision: Monomorphic primary, hybrid fallback for unknown types.
    Static analysis resolves types → direct instructions (zero-overhead).
    When type unknowable at compile-time, emit runtime dispatch on ptr type.
    Hot paths stay monomorphic; flexibility where needed.

## [x] Boxed primitives? -> Yes, via Object.assign with reserved keys
  * Use case: Attaching metadata to primitives (token with position, number with unit)
  * Implementation: Object with reserved first schema key for primitive value

  | Boxed Type | Schema[0] | Memory[0] | Access |
  |------------|-----------|-----------|--------|
  | String | `__string__` | string ptr | `.length`, `[i]` via ptr |
  | Number | `__number__` | f64 value | value from memory[0] |
  | Boolean | `__boolean__` | 0 or 1 | value from memory[0] |
  | Array | `__array__` | array ptr | `.length`, `[i]`, methods via ptr |

  * Boxed value = OBJECT pointer, schema has `__type__` at index 0
  * Primitive access: read memory[0], then dispatch based on `__type__`
  * Property access: normal object property lookup (schema-based)
  * Enables patterns like: `Object.assign([1,2,3], { sum: 6, name: "nums" })`

  * Tradeoff for boxed arrays:
    + Unified representation (all boxed = objects)
    + Consistent with String/Number/Boolean boxing
    - Extra indirection for array ops (read __array__ ptr first)
    - Only affects boxed arrays; plain arrays remain direct

## [x] TypedArrays? -> Yes, pointer-embedded metadata (option a)

  0. No typed arrays
    + It's JS workaround anyways
    + Simpler compiler
    - Missing critical interop (audio, WebGL, binary protocols)
    - Forces f64 arrays everywhere (8x memory for byte data)

  1. Yes (chosen)
    + Essential for interop (AudioWorklet buffers, WebGL, binary data)
    + Zero-copy view into WASM memory from JS
    + Type-specific WASM ops (i32.load8_s vs f64.load)
    + Compact storage: Uint8Array = 1/8 memory of f64 array
    + Direct mapping to WASM memory layout

  * Encoding options:

    a. Pointer-embedded: `[type:4][elemType:3][len:22][offset:22]` (chosen)
      + All metadata in single NaN-boxed f64
      + No memory header overhead
      + Fast access: extract bits, compute offset, load/store
      + Subarrays: new pointer, same buffer (offset adjustment)
      - 4M elements max (22 bits) - sufficient for audio/graphics
      - 4MB addressable (22 bits) - fits dedicated typed region
      - No resize (fixed at creation)
      ```
      ptr bits: [0x7FF8][type=3][elemType:3][len:22][offset:22]
      arr[i] = memory[offset + i * stride]
      ```

    b. Memory header: `[type:4][elemType:3][offset:31]` → `[-8:len][data...]`
      + Unlimited length
      + Can resize (realloc header)
      - Extra memory read for length
      - Header overhead per array
      - Subarrays need separate allocation or complex sharing

    c. ArrayBuffer + views (JS model)
      + Full JS compatibility
      + Multiple views on same buffer
      - Complex: need ArrayBuffer type + view types
      - Extra indirection
      - Overkill for jz use cases

  * Decision: Option (a) - pointer-embedded metadata.
    22-bit limits (4M elements, 4MB) cover audio/graphics use cases.
    Single pointer = no memory overhead, fast access.
    Subarrays via offset arithmetic (zero-copy slicing).

  * Implementation:
    - Dedicated heap region at end of memory for typed data
    - Bump allocator (no free, short-lived allocations)
    - elemType determines WASM load/store instruction
    - All reads return f64 (uniform interface)
    - All writes accept f64, convert to target type

  * Supported types (3 bits = 8 types):
    | elemType | Constructor | Stride | WASM load | WASM store |
    |----------|-------------|--------|-----------|------------|
    | 0 | Int8Array | 1 | i32.load8_s | i32.store8 |
    | 1 | Uint8Array | 1 | i32.load8_u | i32.store8 |
    | 2 | Int16Array | 2 | i32.load16_s | i32.store16 |
    | 3 | Uint16Array | 2 | i32.load16_u | i32.store16 |
    | 4 | Int32Array | 4 | i32.load | i32.store |
    | 5 | Uint32Array | 4 | i32.load | i32.store |
    | 6 | Float32Array | 4 | f32.load | f32.store |
    | 7 | Float64Array | 8 | f64.load | f64.store |


## [x] Ring arrays? -> Auto-promote on shift/unshift usage
  * Problem: shift/unshift on linear arrays is O(n) - moves all elements
  * Solution: Ring buffer with head pointer - O(1) shift/unshift

  0. Single array type (linear only)
    + Simpler implementation
    + Predictable memory layout
    - O(n) shift/unshift (bad for queues, sliding windows)

  1. Separate Ring type (explicit)
    + User controls when to pay ring overhead
    - API divergence from JS
    - User must know performance characteristics

  2. Auto-promote on shift/unshift (chosen)
    + Zero-overhead for arrays that never shift/unshift
    + Transparent: same API, better perf where needed
    + Compiler detects usage at call-sites
    - Slight overhead for ring ops (head + mask arithmetic)
    - Type changes based on usage (acceptable)

  * Detection: static analysis finds shift/unshift calls on array
    - If found → emit RING type (head + len + slots)
    - If not → emit ARRAY type (len + slots)
    - Forward analysis: scan function body before codegen

  * Memory layout comparison:
    ```
    ARRAY: [-8:len][elem0, elem1, elem2, ...]
           arr[i] = slots[i]

    RING:  [-16:head][-8:len][slot0, slot1, slot2, ...]
           arr[i] = slots[(head + i) & mask]
           shift: head = (head + 1) & mask; len--
           unshift: head = (head - 1) & mask; len++
    ```

  * Tradeoff: ring has 2 extra ops per access (add + and)
    Only pay this cost when shift/unshift detected.

## [x] Pointer kinds -> 3-bit type + subtype encoding (IMPLEMENTED)

  * NaN payload: 51 bits = `[type:3][aux:16][offset:32]`
  * 4GB addressable (32-bit offset)

  ### Main Types

  | Type | Name | Pointer Encoding | Memory Layout |
  |------|------|------------------|---------------|
  | 0 | ATOM | `[0:3][kind:16][id:32]` | none (value in pointer) |
  | 1 | ARRAY | `[1:3][ring:1][_:15][off:32]` | `[-8:len][elems...]` or `[-16:head][-8:len][slots...]` |
  | 2 | TYPED | `[2:3][elem:3][_:13][viewOff:32]` | `[len:i32][dataPtr:i32]` at viewOff |
  | 3 | STRING | `[3:3][sso:1][data:42][_:5]` or `[3:3][0][_:15][off:32]` | `[-8:len][chars:u16...]` |
  | 4 | OBJECT | `[4:3][kind:2][schema:14][off:32]` | varies by kind |
  | 5 | CLOSURE | `[5:3][funcIdx:16][off:32]` | `[-8:len][env0:f64, env1:f64, ...]` |
  | 6 | REGEX | `[6:3][flags:6][funcIdx:10][off:32]` | `[-8:lastIdx]` (only if `g` flag) |
  | 7 | (free) | reserved | - |

  ### Subtypes

  **ATOM (type=0)** - No memory allocation
  | kind | Description |
  |------|-------------|
  | 0 | `null` |
  | 1 | `undefined` |
  | 2+ | Symbol (id in offset bits) |

  **ARRAY (type=1)** - ring=1 adds `[-16:head]` for O(1) shift/unshift

  **TYPED (type=2)** - View header: `[len:i32][dataPtr:i32]`, zero-copy subarrays
  - Pointer: `[type:3][elem:3][_:13][viewOffset:32]`
  - Memory at viewOffset: `[len:i32][dataPtr:i32]`, data at dataPtr
  - subarray() allocates 8-byte header only, shares dataPtr with offset
  | elem | Type | Stride |
  |------|------|--------|
  | 0-1 | I8/U8 | 1 |
  | 2-3 | I16/U16 | 2 |
  | 4-5 | I32/U32 | 4 |
  | 6-7 | F32/F64 | 4/8 |

  **STRING (type=3)**
  - sso=1: ≤6 ASCII chars (len:3 + chars:7×6 = 45 bits inline), no allocation
  - sso=0: offset → `[-8:len][char0:u16, char1:u16, ...]`

  **OBJECT (type=4)**
  | kind | Memory Layout | Use |
  |------|---------------|-----|
  | 0 | `[-8:inner][props...]` | schema (static/boxed via inner==0) |
  | 1 | `[-8:size][-16:cap][entries...]` | hash (JSON.parse) |
  | 2 | `[-8:size][-16:cap][entries...]` | Set |
  | 3 | `[-8:size][-16:cap][entries...]` | Map |

  **CLOSURE (type=5)** - funcIdx in pointer, env in memory
  - Memory: `[-8:len][env0:f64, env1:f64, ...]`
  - len = number of captured values (0 if no captures)
  - Call: `(call_indirect funcIdx (closure_ptr, args...))`
  - Function extracts env values from memory via pointer

  **REGEX (type=6)** - Flags + funcIdx in pointer, minimal memory
  - flags: 6 bits (g=1, i=2, m=4, s=8, u=16, y=32)
  - funcIdx: 10 bits (1024 patterns)
  - Static `/pattern/` → funcIdx = compiled matcher
  - Dynamic `new RegExp(s)` → funcIdx = interpreter, off = pattern string
  - Memory only if `g` flag: `[-8:lastIndex]`

  ### Benefits
  - ATOM: null/undefined/Symbol without allocation
  - SSO: short strings in pointer (6 ASCII chars, 7-bit packed)
  - TYPED views: unlimited length, zero-copy subarrays
  - CLOSURE/REGEX: funcIdx in pointer, consistent pattern
  - Static typing: type bits from pointer, no memory read for dispatch
  - One free type slot

## [ ] Stdlib sources

* [Metallic](https://github.com/jdh8/metallic)
* [Piezo](https://github.com/dy/piezo/blob/main/src/stdlib.js)
* [AssemblyScript](https://github.com/AssemblyScript/musl/tree/master)
