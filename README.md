# jasm ![stability](https://img.shields.io/badge/stability-experimental-black) [![test](https://github.com/dy/piezo/actions/workflows/test.yml/badge.svg)](https://github.com/dy/piezo/actions/workflows/test.yml)

_Jasm_ is minimal JS subset for numeric calc purposes, compiling AOT into minimal WASM.

## Reference

* `0.1`, `1.2e+3`, `0xabc`, `0b101`, `0b357`
* `"abc"`, `'abc'`
+ `true`, `false`, `undefined`, `NaN`, `Infinity`, ~~`null`~~
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
* `(a, b) => c`
* `// foo`, `/* bar */`
* `if (a) {...} else if (b) {...} else {}`
* `for (a;b;c) {...}`, `while (a) {...}`
* `try {...} catch (e) {...}`
* `export`

## Why jasm?

Originally made for purpose of floatbeats/bytebeats.

It aims to have minimal set of language features:
  * No classes – use functional style/closures
  * No old syntax – use modern ES5+
  * No null – that is one of [regrets](https://github.com/DavidBruant/ECMAScript-regrets)
  * No objects (for now) – use arrays
  * No ASI - keep syntax ordered
  * No async – keep code flat, fast & simple

It aims to:
  * be light – to embed on websites
  * be fast – compile wasm faster than `eval` parses string
  * produce compact wasm – no runtime
  * map exports 1:1 to JS – that allows frictionless integration


## Why not [porf](https://github.com/CanadaHonk/porffor)?

Porffor? Porrfor? Porforr? It is great. But it has TC39 compatibility as a goal, due to that it becomes heavier and slower.
Also it minimizes use of WASM features, which makes export to JS not direct.

## Why not [piezo](https://github.com/dy/piezo)?

Piezo offers extra features like groups, pipes, units, ranges and extra operators.
It might be solid niche language, but  takes time for R&D, whereas jasm design decisions are clear.

<p align=center><a href="https://github.com/krsnzd/license/">🕉</a></p>
