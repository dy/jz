# jz ![stability](https://img.shields.io/badge/stability-experimental-black) [![test](https://github.com/dy/piezo/actions/workflows/test.yml/badge.svg)](https://github.com/dy/piezo/actions/workflows/test.yml)

_JZ_ is JS subset compiling to WASM.

## Reference

* `0.1`, `1.2e+3`, `0xabc`, `0b101`, `0o357`
* `"abc"`, `'abc'`
* `true`, `false`, `null`, `NaN`, `Infinity`, ~~`undefined`~~
* `a.b`, `a[b]`, `a(b)`
* `+a`, `-a`, `a + b`, `a - b`
* `a * b`, `a / b`, `a % b`, `a ** b`
* `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b`
* `a === b`, `a !== b`
* `~a`, `a & b`, `a ^ b`, `a | b`
* `a << b`, `a >> b`, `a >>> b`
* `!a`, `a && b`, `a || b`
* `a ? b : c`
* `a++`, `a--`, `++a`, `--a`
* `a = b`, `a += b`, `a -= b`, `a *= b`, `a /= b`, `a %= b`
* `a **= b`, `a <<= b`, `a >>= b`, `a >>>= b`
* `a ||= b`, `a &&= b`, `a ??= b`
* `[a, b]`, `...a` (no objects for now)
* `let a, b; const c;` (no var)
* `(a, b) => c` (no function)
* `// foo`, `/* bar */`
* `if (a) {...} else if (b) {...} else {}`
* `for (a;b;c) {...}`, `while (a) {...}`
* `try {...} catch (e) {...}`
* `import`, `export`
<!--
## Usage

```js
import jz from 'jz'

const buf = jz(`export x = (a, b) => a * b`)

const mod = new WebAssembly.Module(buf)
const {exports:{x}} = new WebAssembly.Instance(mod, { ...imports })

x(2,3) === 6
``` -->

<!--
### CLI

`npm i jz`

`jz a.js` - produces `a.wasm`.
`jz *.jz` - compiles all files in a folder into wasm.
 -->


## Why?

Initially conceived for floatbeats/bytebeats.
Inspired by [porf](https://github.com/CanadaHonk/porffor) and [piezo](https://github.com/dy/piezo).
The aim is minimal modern JS subset expressable through WASM without hacks.

* No classes/prototypes – use functional style/closures.
* No old syntax – use modern ES5+.
* No `null` – that is one of [regrets](https://github.com/DavidBruant/ECMAScript-regrets).
* No computed string props - objects are structs.
* No autosemicolons - keep syntax ordered.
* No async – keep code plain & simple.

As a side effect it can speed up numeric functions.

### Qualifications

* _lightweight_ – embeddable on websites.
* _fast_ – compile wasm faster than `eval` parses string.
* _minimal WASM output_ – no runtime, heap or wrappers.
* _direct exports to JS_ – frictionless integration.

### Why not [porf](https://github.com/CanadaHonk/porffor)?

~~Porrfor~~ ~~Porforr~~ Porffor is great. But it has TC39 compat as a goal, which makes it heavy.
Also it minimizes use of WASM features, which encumbers JS exports.

### Why not [assemblyscript](https://github.com/AssemblyScript/assemblyscript)?

I prefer not to deal with typescript directly.

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
