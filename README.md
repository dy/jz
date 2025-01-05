# jz ![stability](https://img.shields.io/badge/stability-experimental-black) [![test](https://github.com/dy/piezo/actions/workflows/test.yml/badge.svg)](https://github.com/dy/piezo/actions/workflows/test.yml)

_JZ_ is JS subset compiling to WASM.

## Reference

* `0.1`, `1.2e+3`, `0xabc`, `0b101`, `0b357`
* `"abc"`, `'abc'`
* `true`, `false`, `undefined`, `NaN`, `Infinity`, ~~`null`~~
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

## Why?

Initially conceived for floatbeats/bytebeats purposes.
Inspired by [porf](https://github.com/CanadaHonk/porffor) and [piezo](https://github.com/dy/piezo).
The aim is minimal modern JS subset expressable through WASM without hacks.

* No classes/prototypes – use functional style/closures.
* No old syntax – use modern ES5+.
* No `null` – that is one of [regrets](https://github.com/DavidBruant/ECMAScript-regrets).
* No computed props - objects are structs.
* No autosemicolons - keep syntax ordered.
* No async – keep code plain & simple.

### Qualifications:

* _lightweight_ – embeddable on websites.
* _fast_ – compile wasm faster than `eval` parses string.
* _minimal WASM output_ – no runtime, heap or wrappers.
* _direct exports to JS_ – frictionless integration.


## Why not [porf](https://github.com/CanadaHonk/porffor)?

Porrfor? Porffor? Porforr is great. But it has some TC39 compatibility as a goal, which makes it heavy.
Also it minimizes use of WASM features, which encumbers JS exports.

## Why not [assemblyscript](https://github.com/AssemblyScript/assemblyscript)?

Just no.

## Why not [piezo](https://github.com/dy/piezo)?

Piezo offers extra features like groups, pipes, units, ranges and extra operators.
It might become solid niche language, but takes time for R&D, whereas jz design and purpose is clear.


<p align=center><a href="https://github.com/krsnzd/license/">🕉</a></p>
