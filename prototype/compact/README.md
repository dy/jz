# Compact staged compiler prototype

This prototype tests the proposed production stages on a deliberately narrow numeric subset:

```text
parse
prepare and validate
numeric ProgramIndex and reachability
per-function scalar WAT lowering
optional watr optimize
watr compile
```

It has no fallback to the production compiler. Unsupported source rejects before encoding.

The implementation is split by lifetime:

```text
compiler.js       orchestration only
prepare.js        strict syntax boundary and declaration extraction
program-index.js  persistent numeric identities and cross-function facts
ops.js            single numeric source-operator classifier
lower.js          function-local AST to WAT lowering
backend.js        unchanged watr optimize and compile boundary
direct.js         frozen direct-binary control
```

The full migration plan and stop rules are in [`../todo.md`](../todo.md).

## Supported source

- exported arrow functions and internal function declarations
- named direct calls with exact arity
- numeric function parameters and results
- numeric literals and folded arithmetic
- `let` and `const` numeric locals
- assignment and arithmetic updates
- `if`, ternary, nested `for`, and nested `while`
- f64 `+`, `-`, `*`, `/`, unary signs, and comparisons in conditions

Every exported parameter must begin with `p = +p`. The Wasm f64 call boundary then performs the same `ToNumber` operation as the source. Tests cover strings, `null`, booleans, `undefined`, signed zero, ordered object coercion, and TypeErrors from BigInt and Symbol. Without this check, JavaScript could concatenate where Wasm adds.

Strings inside compiled code, objects, arrays, closures, dynamic calls, exceptions, imports, and unknown coercions reject. Internal calls require exact arity rather than synthesizing missing values or evaluating and discarding extra arguments. Exported function declarations reject because JavaScript functions are constructable while Wasm exports are not. Exported arrows preserve that boundary property.

This source rule is confined to the prototype. Production JZ must infer the boundary representation or reject without asking users to edit source.

## Stage contracts

### Prepare

`prepareCompactAst(ast)` validates the supported syntax, extracts function records, checks export coercion guards, and records local declarations. It does not resolve calls, infer representations, mark reachability, or emit WAT.

Prepared function records are positional:

```js
[name, params, bodyAst, exported, locals, mutableFlags]
```

### ProgramIndex

`buildProgramIndex(prepared)` copies persistent facts into parallel arrays. It assigns:

- numeric source function IDs
- numeric binding IDs
- flat direct-call edges
- export roots and transitive reachability
- one f64 representation ID for every current binding and result
- deduplicated type IDs
- final Wasm function IDs for reachable functions

Names remain for diagnostics, exports, and the current lower-time lookup. Unreachable function bodies are validated but not emitted.

The current index still retains AST bodies and source names. It does not yet have numeric schemas, globals, typed storage, closure summaries, or data owners.

### Lower

`lowerFunction(index, funcId)` creates one scalar WAT function. Loop-label counters are explicit function scratch, so nested loops and repeated compiles do not share state. `lowerProgram(index)` retains finalized WAT functions until module completion.

The next representation step is a per-function numeric instruction tape. That will remove repeated name lookup without adding a persistent body IR.

### Backend

`compileCompact(source)` calls current `watr/compile` on the lowered WAT. The prototype defaults to `optimize: false`, matching the production compiler's optimize-off comparison used by `bench.mjs`.

```js
compileCompact(source, { optimize: true }) // current watr/optimize, then compile
compileCompact(source, { wat: true })      // return the lowered WAT array
```

The optimized path is covered by nested-loop tests. Watr remains unmodified.

### Direct control

`direct.js` remains a feature-frozen semantic and size lower bound outside the staged compiler artifact. Production continues through watr.

## Premises and limits

| Decision | Reason | Current price |
| --- | --- | --- |
| Reuse JZ's parser and positional AST | Isolate pipeline ownership from parser work | The complete AST remains live |
| Use parallel ProgramIndex arrays | Give cross-function facts stable numeric identities | Bodies and diagnostic names are still retained |
| Mark reachability before lowering | Avoid work and output for dead functions | All functions still receive lightweight syntax and flow validation |
| Lower one function at a time | Bound local traversal and label state | Finalized WAT bodies remain live for watr |
| Keep watr unchanged | Keep Wasm encoding outside JZ | Generic optimization has a visible fixed cost on tiny modules |
| Reject unsupported source | Preserve semantics without a dynamic fallback | Coverage is intentionally small |
| Keep the direct encoder frozen | Retain an independent lower bound | It is a second prototype artifact, never a production path |

The prototype does not establish memory behavior for parsing, the production object model, stdlib realization, closures, snapshots, or current vectorization. It also does not prove that whole-module watr optimization fits the recursive memory target.

## Promotion rule

Do not install this compiler as a source-pattern fast path. A production slice must replace one old authority and delete its old writer in the same change.

Promotion requires:

1. source-hashed scaling on generated 128, 512, and 2,048-function graphs;
2. one frozen numeric ProgramIndex for the promoted fact family;
3. conservative reachability before expensive body work;
4. one reusable function scratch lifetime;
5. semantic differential tests and current output parity;
6. native, kernel, self-compile, recursive, size, and speed gates appropriate to the touched slice.

Run the graph-scaling experiment before adding syntax.

## Run

```sh
node test/compact-prototype.js
node prototype/compact/graph-bench.mjs
node prototype/compact/bench.mjs
```

Do not add these commands to `test/index.js` or `package.json` while the work remains isolated.

The graph benchmark runs the staged and frozen direct backends in fresh processes at 128, 512, and 2,048 functions. It records source, compiler, and output hashes, phase time, post-GC heap, retained WAT, and maximum function scratch. The first evidence is recorded in [`graph-evidence.md`](graph-evidence.md). Output is byte-identical at every size, scratch plateaus, and finalized WAT is the largest staged-only linear owner. The measurement does not justify a retained numeric instruction tape.

The benchmark self-compiles the staged compiler and runs A to A to B through one reusable instance in both optimization modes. It then compares optimize-off compilation with the current compiler's optimize-off path. Timed intervals include compilation and output copying. Instantiation, source marshaling, and `_clear()` stay outside.

Latest loaded-machine result against the current 14,446,281-byte `dist/jz.wasm`:

- staged compiler: 2,089,128 bytes, 6.91x smaller
- staged source graph: 70 modules, 944,099 source bytes
- compile-speed geomean: 66.35x
- minimum compile speedup: 8.61x
- emitted-size geomean: 48.75x smaller
- constant modules tie production at 41 bytes

Generic optimization has a fixed cost on tiny modules. The benchmark exercises it during semantic and reuse checks, while timed rows compare matching optimize-off paths. Production uses the same profile-controlled policy.

The machine still had about 13.9 GB of allocated swap. These timings are directional evidence and do not certify release performance. The full compiler supports far more source, so the artifact ratio does not predict the final production saving.
