# jasm ![stability](https://img.shields.io/badge/stability-experimental-black) [![test](https://github.com/dy/piezo/actions/workflows/test.yml/badge.svg)](https://github.com/dy/piezo/actions/workflows/test.yml)

_Jasm_ is minimal JS -> WASM compiler. 

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

## Why?

It is minimal natural JS wrapper over WASM.
Originally made for numberic purposes, like floatbeats/bytebeats.

It aims to have minimal set of features:
  * No classes – use functional style/closures
  * No old syntax – use modern ES5+
  * No null – that is one of [regrets](https://github.com/DavidBruant/ECMAScript-regrets)
  * No computed props - use structs
  * No ASI - keep syntax ordered
  * No async – keep code flat, fast & simple

It aims to:
  * be light – embeddable on websites
  * be fast – compile wasm faster than `eval` parses string
  * produce compact wasm – no runtime
  * directly map exports to JS – frictionless integration


## Why not [porf](https://github.com/CanadaHonk/porffor)?

Porrfor? Porffor? Porforr is great. But it has TC39 compatibility as a goal, due to that it becomes heavier and slower.
Also it minimizes use of WASM features, which makes JS exports indirect.

<!--
## Why not [piezo](https://github.com/dy/piezo)?

Piezo offers extra features like groups, pipes, units, ranges and extra operators.
It might become solid niche language, but  takes time for R&D, whereas jasm design decisions are clear.
-->

<p align=center><a href="https://github.com/krsnzd/license/">🕉</a></p>
