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

String syntax and operations, objects inside compiled code, arrays, closures, dynamic calls, exceptions, imports, and unknown coercions reject. Internal calls require exact arity rather than synthesizing missing values or evaluating and discarding extra arguments. Exported function declarations reject because JavaScript functions are constructable while Wasm exports are not; exported arrows preserve that boundary property.

## Records

A function has this shape:

```js
[name, params, bodyAst, exported, locals, mutableFlags]
```

All compiler-owned records are arrays: functions, type IDs, exports, section payloads, and bytes. Numeric constants name each field.

## Premises and limits

| Decision | Reason | Price |
| --- | --- | --- |
| Reuse JZ's parser and positional AST | Isolate backend representation and encoding from parser work | The complete AST remains live; this prototype says nothing about parser peak memory or streaming ingestion |
| Store facts in positional arrays | Avoid one object or hash allocation per compiler fact | Function records still contain strings, nested arrays, and linear `indexOf` lookups; a production index needs dense numeric IDs and flat pools |
| Emit Wasm without WAT or watr | Measure the lower bound for an owned backend | Number arrays currently box bytes and copy body to section to module; they are not the production output store |
| Reject every unsupported shape | Preserve answers, effects, exceptions, and source order without a dynamic fallback | Corpus coverage is deliberately small, so artifact and timing ratios cannot be extrapolated to the full language |
| Require explicit unary-plus normalization at exported parameters | Make the raw f64 boundary exact without adding coercion machinery to this experiment | This is a prototype constraint, not a production source hint; production must infer the boundary representation or reject, without editing user or benchmark source |
| Keep compilation state local to one call | Make A to A to B reuse deterministic without reset hooks inside the compiler | It does not provide per-function scratch release inside one large compile |
| Omit stdlib, snapshots, vectorization, and whole-module optimization | Keep the representation experiment legible | Production needs a compact per-function instruction tape for optimization before direct encoding |

The current function tuple is a prototype, not the proposed `ProgramIndex`. It retains every function, scans bodies several times, allocates slices, resolves names as strings, and emits every function whether reachable or not. Copying those mechanics into production would preserve several causes of the main compiler's memory growth.

Fixed operator sets use a numeric classifier rather than an object dictionary. A controlled self-build of the four compound assignments measured 652,927 bytes for duplicated comparisons, 652,811 bytes for one shared classifier, and 653,091 bytes for an object lookup. The shared classifier removes the duplicate authority and is 280 bytes smaller than the dictionary. The timing samples were too small and the machine too loaded to use as speed evidence.

## Promotion rule

Do not install this compiler as a source-pattern fast path. A production slice must replace one old authority, not coexist with it. Promotion requires:

1. source-hashed peak-memory scaling on generated 128, 512, and 2,048-function graphs;
2. one frozen numeric program index with flat function, binding, type, export, and call-edge pools;
3. reachability before body lowering;
4. one reusable per-function instruction and byte scratch area, plus a packed owned output buffer;
5. semantic differential tests and per-case output speed and size parity with the existing path.

The next experiment is memory scaling, not more syntax. Compile generated direct-call graphs with 128, 512, and 2,048 equal-shape functions in one reusable Wasm-hosted compiler. Record source, compiler, and artifact hashes; heap at parse, index, per-function lowering, section finalization, and output; final bytes; and the largest function scratch high-water mark. Every rise above 10% of peak must have an owner. Scratch must plateau once the largest body has passed, and total growth must remain linear. The result decides whether the packed byte writer or the numeric index comes first.

## Run

```sh
node test/compact-prototype.js
node prototype/compact/bench.mjs
```

The benchmark self-compiles the prototype, validates one reusable compiler instance with A to A to B, and compares it with `dist/jz.wasm`. Timed intervals include compilation and output copying. Instantiation, source marshaling, and `_clear()` stay outside.

Measured against the current 14,446,281-byte `dist/jz.wasm`:

- prototype compiler: 652,811 bytes, 22.13x smaller
- latest loaded-machine run: 104.19x compile-speed geomean; 10.45x on the slowest case
- emitted size: 48.75x smaller by geomean; both constant cases tie at 41 bytes

The machine had about 15 GB of allocated swap. These timings support the prototype decision but cannot certify a release claim. The full compiler also supports much more source, so the artifact ratio does not predict the savings from a production migration.

The slice clears the requested 2x artifact and compile-speed thresholds. A production experiment should port one numeric-function path into the existing representation authority. Installing this prototype as a source-pattern fast path would create a second compiler authority.
