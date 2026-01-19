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

## First-class functions / Closures

### gc:true mode (funcref + call_ref)
- Closures represented as `(struct (field $fn funcref) (field $env anyref))`
- Function types: `$fntype{N}` returns f64, `$clfntype{N}` returns anyref (for closures returning closures)
- Uses `call_ref` to invoke closure functions
- `ref.func` requires `elem declare` section for forward references
- Captures tracked via closure environment structs (`$env{N}`)
- Supports arbitrary nesting depth via closure depth tracking

### gc:false mode (table + call_indirect)
- Closures NaN-boxed: table_idx in bits 32-47, env_ptr in bits 0-19
- Function table holds closure function pointers
- Environment stored in linear memory
- Uses `call_indirect` via function table
- **Limitation**: First-class function currying (returning closures) not yet fully implemented

## [ ] Stdlib sources

* [Metallic](https://github.com/jdh8/metallic)
* [Piezo](https://github.com/dy/piezo/blob/main/src/stdlib.js)
* [AssemblyScript](https://github.com/AssemblyScript/musl/tree/master)
