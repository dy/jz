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

## [ ] Arrays: GC vs memory

  0. GC

## [ ] Closures: how?

  0. Set of vars
    - overhead per-function call

  1. Struct create per fn call
    - relative overhead of setting current struct
    ? is there a way to set array only if it's changed?

  1.1 `if (curStruct != newStruct) { prevStruct = curStruct; curStruct = newStruct; } ... if (prevStruct) curStruct = prevStruct`
    + only 2 condition checks overhead
    + can be handled on polyfill level

## [ ] Stdlib sources

* [Metallic](https://github.com/jdh8/metallic)
* [Piezo](https://github.com/dy/piezo/blob/main/src/stdlib.js)
* [AssemblyScript](https://github.com/AssemblyScript/musl/tree/master)
*

## [ ] Tier-B runtime model (no wrapper)

Goal: emit a self-contained wasm module that interoperates with JS directly via wasm GC + JS stringref.

### Value representation (proposal)

* `f64` numbers stay unboxed where possible.
* `stringref` (JS string extension) for strings.
* `externref` for JS objects passed through (optional).
* wasm-gc structs/arrays for JZ-created objects/arrays.
* Closures as `(struct $Closure (field (ref $Fn)) (field (ref $Env)))` where env is a wasm-gc struct.

Notes:

* Logical ops (`&&`, `||`, `??`) must be lowered with short-circuit control flow.
* `+` becomes numeric add or string concat depending on operand types (initially: if either is stringref).
* Remaining helpers can be injected as WAT placeholders and filled later.

## NaN Pointer Encoding (gc:false)

- Layout: IEEE-754 f64 with exponent 0x7FF marks pointers; mantissa packs [type:4][length:28][offset:20].
- Types: F64_ARRAY(0), I32_ARRAY(1), STRING(2), I8_ARRAY(3), OBJECT(4), REF_ARRAY(5).
- Helpers: __mkptr, __alloc, __ptr_len, __ptr_offset, __ptr_type. Objects and ref arrays use 8-byte slots; strings use 2-byte chars, i32 arrays 4-byte, i8 arrays 1-byte.
- Performance: constant-time field extraction using bit shifts; minimal branches. Static f64 arrays are placed in a data segment to avoid per-run allocations.

## Dual-Mode Arrays & Objects

- gc:true: WASM GC arrays/strings; refs don’t fit into f64 array slots.
- gc:false: arrays/objects/strings represented as NaN-encoded pointers stored in f64; supports nested/mixed types.
- Mixed arrays: use REF_ARRAY (8-byte slots) to hold both numbers and pointer NaNs. Homogeneous numeric arrays use F64_ARRAY.
- Objects: allocated with OBJECT type; properties encoded as adjacent f64 slots; object schemas tracked to enable property access.

## Schema Propagation & Indexing

- Array literals annotate element schemas. Indexing with literal indices propagates object schema for property access.
- Property access uses schema → index mapping, lowered to f64.load at `offset + idx*8` in gc:false.

## Optional Chaining & typeof

- `.length` and `?.[]` guard null pointers in gc:false, returning numeric defaults.
- `typeof` in gc:false differentiates numbers vs pointers via NaN self-equality; comparisons like `typeof x === 'number'` lowered to i32 codes.

## Testing

- Features validated in both modes. Nested arrays exercise mixed values, strings, and objects.
