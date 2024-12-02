## [ ] Name -> jasm

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
  * sruti
  * jasm?
    + wasm + js
    - taken, hard discussion
  * jazm
    + like jasm, but with reference to zz
    + jazz
  * wasc
    + wasm compiler
    + wasm script
  * floatscript
  * numscript
  * bytescript
  * mela
    + assembly
    ~ has to do with language, not compiler

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

## [ ]
