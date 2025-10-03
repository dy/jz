# jz ![stability](https://img.shields.io/badge/stability-experimental-black) [![test](https://github.com/dy/piezo/actions/workflows/test.yml/badge.svg)](https://github.com/dy/piezo/actions/workflows/test.yml)

_JZ_ is minimal modern functional JS subset that compiles to WebAssembly (WASM).<br>
Think of it as tiny _JavaScript to WASM compiler_.
<!-- By the time it takes new Function to parse, jz compiles WASM -->

## Reference

* Numbers: `0.1`, `1.2e+3`, `0xabc`, `0b101`, `0o357`
* Strings: `"abc"`, `'abc'`
* Values: `true`, `false`, `null`, `NaN`, `Infinity`, ~~`undefined`~~
* Access: `a.b`, `a[b]`, `a(b)`
* Arithmetic:`+a`, `-a`, `a + b`, `a - b`, `a * b`, `a / b`, `a % b`, `a ** b`
* Comparison: `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b`, `a === b`, `a !== b`
* Bitwise: `~a`, `a & b`, `a ^ b`, `a | b`, `a << b`, `a >> b`, `a >>> b`
* Logic: `!a`, `a && b`, `a || b`, `a ? b : c`
* Increments: `a++`, `a--`, `++a`, `--a`
* Assignment: `a = b`, `a += b`, `a -= b`, `a *= b`, `a /= b`, `a %= b`, `a **= b`, `a <<= b`, `a >>= b`, `a >>>= b`
* Logical Assignment: `a ||= b`, `a &&= b`, `a ??= b`
* Arrays: `[a, b]`, `...a` (no objects yet)
* Declarations: `let a, b`, `const c` (no `var`)
* Functions: `(a, b) => c` (no `function` keyword)
* Comments: `// foo`, `/* bar */`
* Control Flow: `if (a) {...} else if (b) {...} else {}`, `for (a;b;c) {...}`, `while (a) {...}`
* Exceptions: `try {...} catch (e) {...}`
* Modules: `import`, `export`

## Usage

```js
import jz from 'jz'

// compile JS (function multiplying 2 numbers) - it returns WASM buffer
const buf = jz(`export x = (a, b) => a * b`)

// compile WASM module and create an instance
const mod = new WebAssembly.Module(buf)
const { exports: { x } } = new WebAssembly.Instance(mod, { ...imports })

// use exported WASM function
x(2,3) === 6
```

_Coming soon:_ CLI with jz a.js → a.wasm and batch compilation.

<!--
### CLI

`npm i jz`

`jz a.js` - produces `a.wasm`.
`jz *.jz` - compiles all files in a folder into wasm.
 -->

## Examples

_Coming soon_.

<!--
* [ ] Microcontroller program
* [ ] Floatbeat
* [ ] Embed into website
 -->

## Why?

JS has grown complex with legacy features (var, OOP) and niche additions (generators, async loops, etc).<br>
JZ is inspired by floatbeats/bytebeats, it focuses on a minimal, modern, essential subset that ties to WebAssembly features.<br>

* No classes/prototypes – use functions & closures.
* No old syntax – use modern ES5+.
* No [regrets](https://github.com/DavidBruant/ECMAScript-regrets) – drop `undefined`.
* No computed props - objects are structs.
* No autosemicolons - keep syntax ordered.
* No async – keep code plain & simple.

### Goals

* _lightweight_ – embed anywhere, from websites to microcontrollers.
* _fast_ – compiles to WASM faster than `eval` parses.
* _tiny WASM output_ – no runtime, no heap, no wrappers.
* _seamless JS integration_ – export / import, same func signatures.

### Why not [porf](https://github.com/CanadaHonk/porffor)?

Porffor is brilliant, but aligns to TC39 and hesitant on full WASM. JZ stays small and flexible.

### Why not [assemblyscript](https://github.com/AssemblyScript/assemblyscript)?

AssemblyScript is built on TypeScript, while JZ stays pure JS.

### Why not [piezo](https://github.com/dy/piezo)?

Piezo is experimental and will take time to solidify. JZ is possible first step for it.

### Why _jz_?

JZ stands for JavasSript Zero – a return to core, stripped to essentials. Also jazzy vibe.

<!--
## Who's using jz?

* [color-space](https://github.com/colorjs/color-space)
* [web-audio-api](https://github.com/audiojs/web-audio-api) -->


<p align=center><a href="https://github.com/krsnzd/license/">🕉</a></p>
