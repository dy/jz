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

## [ ] Alternatives

### JS/TS → WASM compilers (direct competitors)

| Project | Approach | Pointers | Interop | WASI/Env |
|---------|----------|----------|---------|----------|
| porffor | AOT JS→WASM | Custom | Custom imports | No WASI, "mostly unusable standalone" |
| jawsm | JS→WASM GC | WASM GC refs | WASIp2 polyfill | Requires Node v23+ |
| assemblyscript | TS-like→WASM | Linear memory | wasm-bindgen style | wasi-shim |
| javy | QuickJS embedded | QuickJS internal | Javy.IO | WASI fd_read/write |

### Other langs → WASM (similar challenges)

| Project | Lang | Pointers | Interop | WASI/Env |
|---------|------|----------|---------|----------|
| emscripten | C/C++ | Native | JS glue | WASI + glue |
| wasm-bindgen | Rust | Linear | JS bindings gen | wasm-pack |
| grain | Grain | WASM GC | Grain runtime | Custom |
| tinygo | Go | Linear | JS/WASI | WASI |
| kotlin/wasm | Kotlin | WASM GC | Kotlin/JS | WASIp2 |
| moonbit | MoonBit | WASM GC | JS FFI | WASI |
| zig | Zig | Native | C-style | WASI |
| nelua | Nelua | Native | C-style | WASI |
| lys | Lys | Linear | Custom | Custom |
| walt | WAT-like | Linear | Manual | None (unmaintained) |

### WASM runtimes

| Project | Notes |
|---------|-------|
| wasmer | Fast, WASI, plugins |
| wasmtime | Bytecode Alliance reference |
| wasm3 | Fast interpreter, embedded |
| wasmi | Rust interpreter, embedded |
| WasmEdge | Cloud/edge, WASI |
| lunatic | Erlang-inspired, actors |
| txiki.js | Tiny JS runtime with WASM |


### Key patterns observed

  1. **Pointer strategies**: Linear memory (emscripten, AS, jz) vs WASM GC (jawsm, kotlin, moonbit)
  2. **JS interop**: Glue code (emscripten) vs bindgen (Rust) vs manual (jz)
  3. **WASI adoption**: Universal for CLI/server, shims for browser
  4. **Interpreter vs AOT**: QuickJS-based (javy) vs direct compile (porffor, jz)
  5. **GC compilers converging on WASMp2**: kotlin, dart, moonbit target WASM GC

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

## [x] Floating point precision -> Compile-time rational simplification
  0. Accept IEEE 754 behavior (0.1 + 0.2 = 0.30000000000000004)
    + Standard JS behavior
    - Confusing for users
    - Impossible to test exact equality on computed fractions

  1. Runtime rational type (i64 = num:32|den:32)
    + Perfect precision for all rationals
    + Runtime arithmetic
    - Overhead for every operation (not zero-overhead)
    - Type propagation complexity
    - Different from JS behavior

  2. Compile-time rational simplification (chosen)
    + Zero runtime cost
    + Exact arithmetic for constant expressions
    + Falls back to f64 for dynamic values
    + `1/3 * 3 = 1` (exact), `1/10 + 2/10 = 0.3` (exact)
    - Only helps compile-time constants
    - Overflow falls back to f64

  * Decision: Compile-time rationals. Constant folding propagates Rational
    objects through AST during normalization. Integer division creates
    Rational(num, den) with GCD reduction. Arithmetic (+, -, *, /) on
    rationals produces new rationals. Final emit converts to f64.const.

  * Implementation:
    ```js
    // types.js - Rational with GCD reduction
    class Rational {
      constructor(num, den = 1) { /* reduce via gcd */ }
      add(r) { return new Rational(this.num*r.den + r.num*this.den, this.den*r.den) }
      // ... sub, mul, div similarly
      fitsI32() { return abs(num) < 2**31 && abs(den) < 2**31 }
      toF64() { return this.num / this.den }
    }

    // normalize.js optimize() - propagate rationals
    if (ra && rb && (op === '+' || op === '-' || op === '*' || op === '/')) {
      let result = ra[op](rb)
      if (result.fitsI32()) return [, result.den === 1 ? result.num : result]
    }

    // compile.js genLiteral() - emit final f64
    if (v instanceof Rational) return wat(`(f64.const ${v.toF64()})`, 'f64')
    ```

  * Overflow handling: When num or den exceeds i32 range, falls back to f64
    arithmetic. Example: `(2**30) / 3 * 3` → f64 (can't fit intermediate).

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

## [ ] Internal calling convention -> i32 offsets, box only at JS boundary

  0. All functions use f64 NaN-boxed params (current)
    + Uniform signatures
    + Simple codegen
    - ~6 WASM ops per `__ptr_offset` extraction
    - Tax paid on every pointer access, even internal calls

  1. Internal i32, export wrappers (chosen)
    + Zero NaN tax inside module
    + Internal calls pass raw i32 offset
    + Type info known statically (monomorphization)
    + Export wrappers handle JS boundary
    - Two signatures per exported func
    - Monomorphization can grow code size

  2. Global slots for implicit type passing
    ```wat
    (global $__ptr_type (mut i32))
    (global $__ptr_aux (mut i32))
    ;; caller sets globals before call
    ```
    + Preserves f64-only signatures
    - Not thread-safe
    - Save/restore overhead for nested calls
    - Still extra instructions

  * Decision: Option 1. Internal functions use `(param $off i32)` for pointers.
    Export wrappers unbox args, call internal, box results.
    Monomorphize when same func used with multiple pointer types.

  * Implementation:
    - analyze.js: track exported vs internal funcs, infer param types
    - compile.js: emit i32 params for internal, call `__ptr_offset` only at boundary
    - assemble.js: generate thin export wrappers
    - closures: env stores f64 (must), unbox once at closure entry

  * Example:
    ```wat
    ;; Internal (no boxing)
    (func $sum_arr (param $off i32) (result f64) ...)

    ;; Export wrapper
    (func (export "sum") (param $ptr f64) (result f64)
      (call $sum_arr (call $__ptr_offset (local.get $ptr))))
    ```

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

## [ ] Imports -> Pre-bundled source + primitives-only linking

  ### Problem
  JZ needs to support `import`/`export` across modules. Challenges:
  1. **Resolution**: Who finds the source? (CLI vs browser, fs vs fetch)
  2. **WASM API**: Can't pass JS objects to WASM (metacircular case)
  3. **Memory**: Modules compiled separately can't share strings/arrays/objects

  ### Separation of Concerns
  - **Resolution** = host responsibility (JS/Node/WASI)
  - **Compilation** = JZ responsibility (pure transform, no I/O)

  ### Resolution Strategy

    0. **CLI resolves via fs**
      + Node has filesystem access
      + Can read importmaps.json for bare specifiers
      + Standard behavior for compilers
      - Only works in Node/CLI

    1. **API: `modules` option (pre-resolved)**
      ```js
      compile(src, { modules: { './math.js': mathSrc } })
      ```
      + Works everywhere (browser, Node, WASM)
      + Caller controls resolution (fetch, fs, bundled)
      + Sync API, no async complications
      - Caller must gather all sources upfront

    2. **API: `resolve` callback (lazy)**
      ```js
      compile(src, { resolve: async (spec) => fetch(spec).then(r => r.text()) })
      ```
      + Lazy loading, on-demand
      + Flexible (CORS proxy, transforms, etc.)
      - Async complicates API
      - CORS issues in browser
      - Can't work in pure WASM (no callbacks)

    * Decision: CLI uses fs + importmap. API uses `modules` option.
      Keeps compiler pure (no I/O), resolution is caller's job.

  ### WASM-Compatible Module Passing

    0. **JSON string**
      ```js
      compile(src, JSON.stringify({ modules: {...} }))
      ```
      + Works in WASM (single string param)
      - Escaping nightmare (strings in strings in JSON)
      - Parsing overhead
      - Ugly API

    1. **Pre-bundled source format**
      ```
      //!jz:module ./math.js
      export let add = (a, b) => a + b
      //!jz:module ./utils.js
      export let double = x => x * 2
      //!jz:main
      import { add } from './math.js'
      export let x = add(1, 2)
      ```
      + Simplest WASM API (single string in, WASM out)
      + No escaping issues
      + Host bundles, JZ compiles (clear responsibility)
      - Requires bundler logic in host

    2. **Host callback import**
      ```wat
      (import "jz" "resolve" (func $resolve (param i32 i32) (result i32 i32)))
      ```
      + Lazy resolution
      + Matches WASI capability model
      - Complex memory coordination
      - Non-pure compilation (side effects)

    3. **WASM Component Model**
      ```wit
      record compile-options { modules: list<tuple<string, string>> }
      compile: func(source: string, opts: compile-options) -> result<bytes, string>
      ```
      + Clean, typed, standard
      + Structured data without JSON
      - Not widely supported yet (2026+)
      - Adds toolchain dependency

    * Decision: Pre-bundled source format. Host bundles all sources into
      single string with markers, JZ parses and compiles. Zero WASM complexity.

  ### Multi-Module Compilation (Memory Sharing)

    0. **Bundle into single WASM** (current)
      + Single memory, all modules share
      + Strings/arrays/objects work across module boundaries
      + Tree-shaking, dead code elimination
      - Must compile together
      - No separate caching

    1. **Separate WASM + shared memory**
      ```js
      const shared = new WebAssembly.Memory({ initial: 256, shared: true })
      const mathInst = instantiate(mathWasm, { env: { memory: shared } })
      const mainInst = instantiate(mainWasm, { env: { memory: shared } })
      ```
      + Separate compilation, shared data
      + Can cache individual modules
      - Heap coordination (who allocates where?)
      - Requires SharedArrayBuffer (security restrictions)
      - Complex: need memory allocator protocol

    2. **Separate WASM + primitives-only linking**
      ```js
      compile(src, {
        imports: {
          './math.js': { add: { params: ['f64', 'f64'], result: 'f64' } }
        }
      })
      // Links at instantiation:
      instantiate(mainWasm, { './math.js': mathInst.exports })
      ```
      + Standard WASM import/export
      + Modules compile independently
      + Clean type signatures
      - No string/array/object passing between modules
      - Limited to numeric types (f64, i32)

    3. **Separate WASM + copy on boundary**
      ```js
      // At each cross-module call:
      // 1. Serialize string/array from caller's memory
      // 2. Copy bytes to callee's memory
      // 3. Deserialize, call function
      // 4. Serialize result, copy back
      ```
      + Full type support across modules
      - Significant overhead per call
      - Breaks object identity (a !== a after round-trip)
      - Complex codegen (wrapper functions)

    4. **WASM Multiple Memories proposal**
      ```wat
      (memory $shared (import "env" "shared") 1)
      (memory $local 1)
      (func $get (param $ptr i32) (result f64)
        (f64.load $shared (local.get $ptr)))
      ```
      + Explicit memory params
      + Can share specific memory regions
      - Phase 3, limited runtime support
      - Requires careful memory management
      - Not ergonomic

    * Decision: Bundle into single WASM (primary), primitives-only linking (optional).
      Bundling handles most cases (modules sharing data). Separate compilation
      only for leaf modules with numeric interfaces (math libs, DSP kernels).

  ### Circular Imports

    0. **Prohibit** (Jessie-style)
      + Simple implementation
      + Forces clean dependency graphs
      + No initialization order issues
      - Less JS-compatible

    1. **Allow with TDZ**
      + JS-compatible
      - Complex: must detect cycles, defer initialization
      - Runtime errors if accessed before init

    * Decision: Prohibit circular imports. Matches Jessie philosophy,
      avoids initialization complexity. Error at compile time.

  ### Export Styles

    0. **Named exports only**
      ```js
      export let add = (a, b) => a + b
      export { add, sub }
      ```
      + Explicit, tree-shakeable
      + Consistent with WASM exports

    1. **Default exports**
      ```js
      export default (a, b) => a + b
      import math from './math.js'  // math is the function
      ```
      + JS-compatible
      - Ambiguous naming
      - Complicates import resolution

    2. **Re-exports**
      ```js
      export { add } from './math.js'
      export * from './utils.js'
      ```
      + Convenient barrel files
      - Requires resolving during compilation
      - `export *` complicates tree-shaking

    * Decision: Named exports + re-exports. No default exports.
      Explicit naming, clean tree-shaking, Jessie-compatible.

  ### Bare Specifiers

    0. **Require relative/absolute paths**
      ```js
      import { x } from './node_modules/lodash/index.js'
      ```
      + Explicit, no magic
      - Verbose, fragile paths

    1. **Import maps (CLI)**
      ```json
      // importmap.json
      { "imports": { "lodash": "./node_modules/lodash/index.js" } }
      ```
      ```js
      import { x } from 'lodash'  // resolved via importmap
      ```
      + Standard (browsers support import maps)
      + Centralizes dependency mapping
      - CLI-only (must read file)

    2. **Node resolution algorithm**
      ```js
      import { x } from 'lodash'  // → node_modules/lodash/package.json → main
      ```
      + Node-compatible
      - Complex algorithm
      - package.json parsing

    * Decision: Relative paths required in source. CLI uses importmap.json
      if present. No implicit node_modules resolution.

  ### Summary

  | Aspect | Decision | Rationale |
  |--------|----------|-----------|
  | Resolution | Host responsibility | Compiler stays pure, no I/O |
  | CLI | fs + importmap.json | Standard compiler behavior |
  | API | `modules` option | Sync, works everywhere |
  | WASM API | Pre-bundled format | Single string, no complexity |
  | Multi-module | Bundle (default) | Shared memory, full types |
  | Linking | Primitives-only | For numeric leaf modules |
  | Circular | Prohibited | Jessie-style, simple |
  | Exports | Named + re-export | Explicit, tree-shakeable |
  | Bare specs | Importmap (CLI) | Standard, explicit |

  ### Implementation

  ```js
  // Phase 1: Single-file (current)
  compile(source) → wasm

  // Phase 2: Bundled modules
  compile(bundledSource) → wasm
  // Host provides: //!jz:module markers

  // Phase 3: Separate compilation (optional)
  compile(source, { imports: { './math.js': signatures } }) → wasm
  // Links at instantiation via standard WASM imports
  ```

## [ ] Objects / Arrays JS interop -> view() helper

  ### Prior Art: How compilers return objects/arrays to JS

  | Compiler | Strategy | Mechanism |
  |----------|----------|-----------|
  | **wasm-bindgen** (Rust) | Copy at boundary | Structs become JS classes w/ ptr; `Vec<T>` → JS Array (copied) |
  | **Emscripten/embind** | Value types / memory views | `value_object` auto-copies; `typed_memory_view` for zero-copy |
  | **AssemblyScript** | Linear memory + loader | `__getArray()`, `__getString()` in loader; or WASM GC refs |
  | **Porffor** | AOT, no runtime | Returns primitives; complex types not yet interoperable |
  | **Javy** | QuickJS + JSON | `Javy.IO` reads/writes JSON strings via fd |
  | **Grain** | WASM GC | Native GC structs, records, enums - direct JS interop |
  | **Kotlin/Wasm** | WASM GC | GC-managed objects, interop via externref |
  | **Go (wasip1)** | Pack ptr+len | `ptr | (len << 32)` in i64/u64, JS unpacks & reads memory |
  | **Zig/Nelua** | C-style | Return ptr, caller reads via memory view |

  ### Patterns observed

  1. **Copy at boundary** (wasm-bindgen, embind value_object)
     - Safest: no lifetime issues
     - Overhead: allocation + copy each call
     - Best for: infrequent calls, small data

  2. **Memory view** (embind typed_memory_view, AS loader, Zig)
     - Zero-copy: JS gets view into WASM memory
     - Dangerous: view invalidates if memory grows/reallocates
     - Best for: large buffers (audio, textures), hot paths

  3. **Packed pointer** (Go wasip1 pattern)
     ```go
     return uint64(ptr) | (uint64(len) << 32)
     ```
     - Returns ptr+len in single i64
     - JS unpacks: `ptr = result & 0xFFFFFFFF`, `len = result >> 32`
     - Best for: returning dynamic-length data without multi-value

  4. **Wrapper classes** (wasm-bindgen, embind)
     - JS class wraps WASM pointer
     - Methods call into WASM
     - Manual `.delete()` or ref-counting
     - Best for: long-lived objects with methods

  5. **WASM GC** (Grain, Kotlin/Wasm, jawsm)
     - Native GC-managed structs/arrays
     - Direct JS interop via externref
     - Best for: GC-tolerant apps (not real-time audio)

  ### JZ Options

  0. **GC structs at export boundary**
    + Standard WASM GC
    + Direct JS interop
    - GC pauses (violates real-time guarantees)
    - Not universally supported

  1. **`instantiate()` wrapper with auto-marshalling** (current)
    + Convenient: arrays/objects Just Work™
    + Reads schemas from jz:sig custom section
    - Custom wrapper, not standard WASM
    - Doesn't work in wasmer/wasmtime
    - Hidden magic

  2. **`view()` helper** (recommended)
    ```js
    const $ = view(wasm.exports)  // reads _schemas export
    const value = $(ptr)          // read any: array, string, object
    $(ptr, [1, 2, 3])             // write, returns ptr
    ```
    + Explicit: user controls marshalling
    + Works with standard WebAssembly.instantiate
    + No wrapper needed
    + Schemas from exported function, not custom section
    - User must call explicitly

  2.1 **Schemas via export**
    ```js
    // JZ emits:
    (func (export "_schemas") (result i32)
      (i32.const <ptr_to_schema_json>))

    // JS:
    const schemaPtr = wasm.exports._schemas()
    const schemas = JSON.parse(readString(memory, schemaPtr))
    ```
    + Works in wasmer/wasmtime (just a function call)
    + No custom section parsing needed
    + Standard WASM

  * Decision: Option 2.1 - `view()` helper with `_schemas` export.
    Keep `instantiate()` for convenience but document as optional.
    Raw WASM works everywhere via standard APIs.

## [ ] Host APIs (console, Date, performance) -> WASI + shim

  0. **Custom JZ imports**
    ```wat
    (import "jz" "log_f64" (func $log_f64 (param f64)))
    (import "jz" "time_now" (func $time_now (result f64)))
    ```
    + Simple, minimal
    + Works everywhere with thin adapter
    - Non-standard
    - Each host needs adapter

  1. **WASI** (recommended)
    ```wat
    (import "wasi_snapshot_preview1" "fd_write" (func ...))
    (import "wasi_snapshot_preview1" "clock_time_get" (func ...))
    ```
    + Standard interface
    + Native support in wasmer/wasmtime
    + Portable WASM (same binary everywhere)
    - Browser/Node need WASI shim
    - More complex API (fd handles, etc.)

  * Decision: WASI as primary interface.
    - wasmer/wasmtime: native support
    - Browser/Node: use WASI shim (browser_wasi_shim, wasmer-js)
    - JZ emits standard WASI imports for console/Date/performance

  ### WASI Mapping

  | JS API | WASI Function | Notes |
  |--------|---------------|-------|
  | console.log | fd_write(1, ...) | stdout |
  | console.error | fd_write(2, ...) | stderr |
  | Date.now() | clock_time_get(realtime) | ms since epoch |
  | performance.now() | clock_time_get(monotonic) | high-res timer |
  | File read | path_open + fd_read | for import resolution |

## [ ] metacircular (jz.wasm) -> WASI or minimal imports

  ### Prior Art (JS/TS → WASM compilers)

  | Project | Host APIs | Standalone? | Modules |
  |---------|-----------|-------------|---------|
  | **Porffor** | Only I/O imports | ❌ "not WASI, mostly unusable standalone" | Single file |
  | **Javy** | WASI (fd_read/write) + Javy.IO | ✅ wasmtime/wasmer | Embeds QuickJS interpreter |
  | **jawsm** | WASIp2 polyfill (JS) | ❌ Requires Node v23+ | Single file, uses WASM GC |
  | **AssemblyScript** | `declare` → custom imports | ⚠️ Host must provide | `@external` decorator |
  | **Emscripten** | WASI + JS glue | ⚠️ Needs JS glue for most | static/dynamic linking |

  ### Key Insights

  1. **No fully standalone exists** - All require either WASI or custom imports
  2. **WASI is the closest to "standard"** - wasmtime/wasmer support it natively
  3. **Porffor explicitly says** "does not use import standard like WASI, mostly unusable standalone"
  4. **Javy pattern**: `Javy.IO.readSync(fd, buffer)` → internal WASI fd_read
  5. **jawsm**: Targets WASIp2 but runtimes don't support all features yet, uses JS polyfill

  ### Options for JZ

    0. **No I/O** (pure compute only)
      + Truly standalone
      + Runs anywhere
      - No console.log, no Date.now, no file access
      - jz.wasm can't resolve imports (pre-bundled only)

    1. **WASI** (like Javy)
      + wasmtime/wasmer native support
      + Browser/Node: use WASI shim
      + Standard, widely adopted
      - Browser WASI shims exist but add weight

    2. **Minimal custom imports** (like Porffor)
      ```wat
      (import "jz" "log" (func $log (param i32 i32)))
      (import "jz" "read" (func $read (param i32 i32) (result i32)))
      (import "jz" "time" (func $time (result f64)))
      ```
      + Simpler than WASI (3 functions vs 45+)
      + Host provides (browser: fetch, Node: fs)
      - Non-standard
      - wasmer can provide via --invoke, but awkward

    3. **Both: WASI primary, fallback to custom**
      + WASI for wasmtime/wasmer
      + Same binary, detect which imports available
      - Complex

  ### Decision: Option 1 (WASI)

    * console.log → fd_write(stdout)
    * Date.now → clock_time_get(realtime)
    * File read → fd_read (for import resolution)
    * Browser/Node: lightweight WASI shim (e.g. browser_wasi_shim, wasmer-js)
    * jz.wasm uses WASI internally

  ### AssemblyScript Web APIs → WASI mapping

  AS by default uses "Web APIs" (host-provided imports), wasi-shim replaces them with WASI:

  | Web API | WASI function | Notes |
  |---------|---------------|-------|
  | `env.abort(msg,file,line,col)` | fd_write(stderr) + proc_exit(255) | AS special import |
  | `env.trace(msg,n,a0..a4)` | fd_write(stderr) | AS special import |
  | `env.seed()` | random_get | For Math.random() |
  | `console.log/debug/info` | fd_write(stdout) | |
  | `console.warn/error` | fd_write(stderr) | |
  | `console.time/timeEnd` | clock_time_get(MONOTONIC) | |
  | `Date.now()` | clock_time_get(REALTIME) / 1000000 | ns → ms |
  | `performance.now()` | clock_time_get(MONOTONIC) / 1000000 | |
  | `crypto.getRandomValues` | random_get | |
  | `process.stdin/stdout/stderr` | fd_read/fd_write(0/1/2) | |
  | `process.argv/env` | args_get/environ_get | |
  | `process.exit` | proc_exit | |

  **Key insight**: AS "Web APIs" are just 3 special imports (`env.abort`, `env.trace`, `env.seed`) + standard JS globals reimplemented. The shim maps everything to ~5 WASI functions: `fd_write`, `fd_read`, `clock_time_get`, `random_get`, `proc_exit`.

  **For JZ**: Could use same pattern - define minimal "jz.abort", "jz.log", "jz.time", "jz.random" imports, then provide either WASI shim or browser shim. But WASI is simpler (standard).

  ### WASI Shims for Browser/Node

    * [wasmer-js](https://www.npmjs.com/package/@wasmer/wasi) - wasmer runtime for browser/Node
    * [@tybys/wasm-util](https://github.com/toyobayashi/wasm-util) - lightweight WASI polyfill
    * [@assemblyscript/wasi-shim](https://github.com/AssemblyScript/wasi-shim) - compile-time, AS→WASI
    * [@bytecodealliance/preview2-shim](https://www.npmjs.com/package/@bytecodealliance/preview2-shim) - WASIp2 for JS

## [ ] Compile API → `{binary, wat}`

  **Research: How other compilers expose output**

  * AssemblyScript: `asc.compileString()` → `{binary, text, stderr, stats}` (both formats)
  * AssemblyScript CLI: `--outFile out.wasm` + `--textFile out.wat` (separate flags)
  * Porffor: `porf wasm script.js out.wasm` (CLI command per format)
  * Binaryen: `module.emitBinary()` / `module.emitText()` (separate methods)

  **Current JZ flow** (3 steps, user manages watr):
  ```js
  const wat = compile(code)       // JZ: JS → WAT
  const binary = watrCompile(wat) // watr: WAT → binary
  const inst = instantiate(binary)
  ```

  **watr options** (what we'd hide):
  * features: gc, simd, exceptions, relaxed-simd, etc.
  * polyfill: fallback codegen for unsupported features
  * optimize: tree-shake, inline, etc.

  **Options**

  0. Return `{binary, wat}` from compile()
    + Matches AssemblyScript pattern
    + Single call gets both formats
    + wat available for debugging when needed
    + User doesn't need to know/import watr
    + Zero breaking change for instantiate()
    - Hides watr options (features, polyfill)
    - Slightly more work if user only wants wat (rare)

  1. Return binary only, expose wat via option
    + Simpler return type
    - wat inaccessible without option flag
    - Debugging harder

  2. Return wat only (current)
    + User controls watr options (features, polyfill, optimize)
    + Can swap watr for another assembler
    - Extra step for common case
    - User must know about watr

  3. Return instantiated module
    + One-liner: `const {fn} = compile(code)`
    - Async required (WebAssembly.instantiate)
    - Can't inspect wat/binary
    - Can't pass custom imports easily

  4. Return `{binary, wat}` + accept watr options
    ```js
    compile(code, { watr: { features: ['simd'], polyfill: true } })
    ```
    + Best of both: simple default, configurable when needed
    + wat always available for custom assembler path
    - API slightly more complex

  **Decision**: Option 4 - return `{binary, wat}`, pass-through watr options
  * Most users want binary, wat is for debugging
  * watr is already a dependency
  * Matches established pattern (AssemblyScript)
