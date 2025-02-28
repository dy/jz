# jz ![stability](https://img.shields.io/badge/stability-experimental-black) [![test](https://github.com/dy/piezo/actions/workflows/test.yml/badge.svg)](https://github.com/dy/piezo/actions/workflows/test.yml)

_JZ_ is minimal modern functional JS subset that compiles to WebAssembly (WASM).
Think of it as _JavaScript to WASM compiler_, stripped to its essentials.
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
* Declarations: `let a, b; const c;` (no `var`)
* Functions: `(a, b) => c` (no `function`)
* Comments: `// foo`, `/* bar */`
* Control Flow: `if (a) {...} else if (b) {...} else {}`, `for (a;b;c) {...}`, `while (a) {...}`
* Exceptions: `try {...} catch (e) {...}`
* Modules: `import`, `export`

## Usage

```js
import jz from 'jz'

const buf = jz(`export x = (a, b) => a * b`)
const mod = new WebAssembly.Module(buf)
const { exports: { x } } = new WebAssembly.Instance(mod, { ...imports })

x(2,3) === 6
```

_Coming soon:_ CLI with jz a.js → a.wasm and batch compilation.

<!--
### CLI

`npm i jz`

`jz a.js` - produces `a.wasm`.
`jz *.jz` - compiles all files in a folder into wasm.
 -->


## Why?

JS is bloated with niche features (generators, async loops), redundant syntax and legacy (var, OOP). Also it's volatile.<br>
JZ is nspired by floatbeats/bytebeats, [porf](https://github.com/CanadaHonk/porffor) and [piezo](https://github.com/dy/piezo).
The aim is minimal modern JS subset expressable through WASM without hacks.

* No classes/prototypes – use functions & closures.
* No old syntax – use modern ES5+.
* No [regrets](https://github.com/DavidBruant/ECMAScript-regrets) – drop `undefined`.
* No computed string props - objects are structs.
* No autosemicolons - keep syntax ordered.
* No async – keep code plain & simple.

### Goals

* _lightweight_ – embed anywhere, from websites to microcontrollers.
* _fast_ – compile wasm quicker than `eval` parses.
* _tiny WASM output_ – no runtime, no heap, no wrappers.
* _seamless JS integration_ – export / import directly.

### Why not [porf](https://github.com/CanadaHonk/porffor)?

~~Porrfor~~ ~~Porforr~~ Porffor is brilliant, but tied to TC39 and hesitant on full WASM.

### Why not [assemblyscript](https://github.com/AssemblyScript/assemblyscript)?

It's tied to TypeScript, JZ stays pure JS.

### Why not [piezo](https://github.com/dy/piezo)?

Piezo offers extra features like groups, pipes, units, ranges and extra operators.
It might become solid niche language, but takes time for R&D, and jz is possible first step for it.

### Why _jz_?

Javascript zero. I also like jazz.

<!--
## Who's using jz?

* [color-space](https://github.com/colorjs/color-space)
* [web-audio-api](https://github.com/audiojs/web-audio-api) -->


<p align=center><a href="https://github.com/krsnzd/license/">🕉</a></p>
