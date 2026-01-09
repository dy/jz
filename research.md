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
