# jayscript

_jayscript_ is minimal JS subset for numeric calc purposes, compiling AOT into minimal WASM.

## Reference

* `0.1`, `1.2e+3`, `0xabc`, `0b101` (no oct or separators)
* `"abc"` (no single-quote or backtick)
+ `true`, `false`, `NaN`, `Infinity` (no null, undefined)
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
* `[a, b]`, `...a` (no objects)
* `let a, b;` (no const, var)
* `(a, b) => c`
* `// foo`, `/* bar */`
* `if (a) {...} else if (b) {...} else {}`
* `for (a;b;c) {...}`, `while (a) {...}`
* `try {...} catch (e) {...}`
* `export`

## Why jayscript?

Originally made for purpose of floatbeats/bytebeats. It aims to have minimal set of language features for functional style (no classes, no old syntax, no null/undefined). It aims to have lightweight compiler - to be embeddable on website. Also it aims at compact produced wasm code and use available wasm features.
For the time it takes `eval` to parse string, jayscript compiles WASM module.

## Why not porf?

Porffor? Porrfor? Porforr? It is great. But it has TC39 compatibility as a goal, due to that it becomes heavier and slower.
Also it minimizes use of WASM features, which makes export to JS not direct.

## Why not piezo?

Piezo offers extra features like groups, pipes, units, ranges and extra operators.
It might be solid niche language, but would entail integrating friction.

<p align=center><a href="https://github.com/krsnzd/license/">🕉</a></p>
