# Compact positional compiler prototype

`compiler.js` parses source with JZ's existing parser, retains the positional AST, stores function facts in positional arrays, and writes Wasm bytes directly. It does not build an object-shaped HIR or call JZ's planner, runtime assembler, optimizer, or watr. Unsupported syntax rejects before encoding.

## Supported source

- exported arrow functions and internal function declarations
- named direct calls with exact arity
- numeric function parameters and results
- numeric literals and folded arithmetic
- `let` and `const` numeric locals
- assignment and arithmetic updates
- `if`, ternary, `for`, and `while`
- f64 `+`, `-`, `*`, `/`, unary signs, and comparisons in conditions

Every exported parameter must begin with `p = +p`. The Wasm f64 call boundary then performs the same `ToNumber` operation as the source. Tests cover strings, `null`, booleans, `undefined`, signed zero, ordered object coercion, and TypeErrors from BigInt and Symbol. Without the check, `x + 1` could concatenate in JavaScript and add in Wasm.

String syntax and operations, objects inside compiled code, arrays, closures, dynamic calls, exceptions, imports, and unknown coercions reject.

## Records

A function has this shape:

```js
[name, params, bodyAst, exported, locals, mutableFlags]
```

All compiler-owned records are arrays: functions, type IDs, exports, section payloads, and bytes. Numeric constants name each field.

## Run

```sh
node test/compact-prototype.js
node prototype/compact/bench.mjs
```

The benchmark self-compiles the prototype, validates one reusable compiler instance with A to A to B, and compares it with `dist/jz.wasm`. Timed intervals include compilation and output copying. Instantiation, source marshaling, and `_clear()` stay outside.

Measured against the current 14,446,281-byte `dist/jz.wasm`:

- prototype compiler: 652,927 bytes, 22.13x smaller
- two runs: 95.08x to 97.26x compile-speed geomean; 7.72x to 8.23x on the slowest case
- emitted size: 48.75x smaller by geomean; both constant cases tie at 41 bytes

The machine had about 15 GB of allocated swap. These timings support the prototype decision but cannot certify a release claim. The full compiler also supports much more source, so the artifact ratio does not predict the savings from a production migration.

The slice clears the requested 2x artifact and compile-speed thresholds. A production experiment should port one numeric-function path into the existing representation authority. Installing this prototype as a source-pattern fast path would create a second compiler authority.
