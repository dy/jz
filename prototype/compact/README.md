# Compact staged compiler prototype

The prototype implements the proposed production stages for a narrow numeric subset:

```text
parse
prepare and validate
numeric ProgramIndex and reachability
per-function scalar and SIMD WAT lowering
optional watr optimize
watr compile
```

Unsupported source rejects before encoding. No source shape falls back to the production compiler.

The implementation is split by lifetime:

```text
compiler.js       orchestration only
prepare.js        strict syntax boundary and declaration extraction
program-index.js  persistent numeric identities and cross-function facts
reps.js           scalar representation IDs and physical Wasm types
ops.js            single numeric source-operator classifier
constants.js      pure scalar constant-evaluation authority
lower.js          function-local facts and AST to scalar or SIMD WAT
backend.js        unchanged watr optimize and compile boundary
dsp-bench.mjs     typed-map runtime direction
direct.js         frozen direct-binary control
```

The full migration plan and stop rules are in [`../todo.md`](../todo.md).

## Supported source

- exported arrow functions and internal function declarations
- named direct calls with exact arity
- numeric function parameters and results
- numeric literals and folded arithmetic, including constant `%` and `**`
- `let` and `const` numeric locals
- assignment, statement updates, and prefix or postfix update values
- comma expressions with ordered effects
- value-preserving numeric `&&` and `||` with short circuiting
- `if`, ternary, nested `for`, `while`, and `do...while`
- omitted `for` initialization, condition, and step
- lexical labeled and unlabeled `break` and `continue`
- constant-condition branch and loop removal after full source validation
- empty modules and modules with no reachable export
- f64 `+`, `-`, `*`, `/`, unary signs, and comparisons in conditions
- Number bitwise operators, shifts, and their compound assignments
- exact `ToInt32` and `ToUint32` for every f64 magnitude
- `Math.imul` and `Math.clz32`
- fixed module-level `Float64Array` owners, full aliases, and `subarray(0)` views
- proven-range `.length`, f64 load, and f64 store
- raw i32 pointer induction for canonical typed loops
- optional f64x2 map vectorization with scalar cleanup

The default `abi: 'js'` contract requires every exported parameter to begin with `p = +p`. The Wasm f64 call boundary then performs the same `ToNumber` operation as the source. Tests cover strings, `null`, booleans, `undefined`, signed zero, ordered object coercion, and TypeErrors from BigInt and Symbol. Without this proof, JavaScript could concatenate where Wasm adds.

`compileCompact(source, { abi: 'raw' })` admits unguarded numeric parameters. This is an explicit typed-host contract: every parameter and result is f64 and callers provide numbers. It matches the raw scalar lane in `test/abi.js`; it does not claim JavaScript coercion semantics for nonnumeric arguments. ProgramIndex owns this decision. Prepare only validates source structure.

Strings inside compiled code, objects, general arrays, closures, dynamic calls, exceptions, imports, and unknown coercions reject. Only the fixed module-level `Float64Array` forms listed above are accepted. Dynamic `%` and `**` also reject until their exact numeric lowering exists. Internal calls require exact arity rather than synthesizing missing values or evaluating and discarding extra arguments. Exported function declarations reject because JavaScript functions are constructable while Wasm exports are not. Exported arrows preserve that boundary property.

Production JZ must use its existing representation proofs or reject. It cannot require users to add coercion guards.

## Shared scalar gate

`test/_scalar-core-cases.js` owns 74 unmodified sources selected from `statements.js`, `preeval.js`, `abi.js`, `minimal-output.js`, `differential.js`, `determinism.js`, `unsigned.js`, and `math.js`. Production tests and the isolated prototype import the same records. The prototype executes 110 pinned calls, constant-fold and output-shape checks, selected JavaScript differentials, and raw-ABI reuse checks. Thirty control cases with 39 calls and 18 integer cases with 41 calls also run after watr optimization. No adapter edits source.

## Stage contracts

### Prepare

`prepareCompactAst(ast)` validates the supported syntax, extracts function and static-storage records, and records local declarations. It does not choose an ABI, resolve calls, infer representations, mark reachability, or emit WAT.

The prepared program is `[functions, storages]`. Function records are positional:

```js
[name, params, bodyAst, exported, locals, mutableFlags]
```

### ProgramIndex

`buildProgramIndex(prepared, options)` copies persistent facts into parallel arrays. It assigns:

- numeric source function IDs
- numeric binding IDs
- flat direct-call edges
- export roots and transitive reachability
- f64, signed-i32, and unsigned-i32 representation IDs
- signed and unsigned result summaries across direct call chains
- one explicit JavaScript or raw ABI mode
- deduplicated type IDs
- final Wasm function IDs for reachable functions and the optional exact-conversion helper
- static storage owners, byte bases, lengths, element widths, alias groups, and relocation states
- per-function direct storage reads and writes plus transitive purity
- one explicit scalar or SIMD profile bit

Names remain for diagnostics, exports, and the current lower-time lookup. Unreachable functions and constant-dead branches are validated but not emitted.

Storage fields allocate only when the prepared program declares typed storage. The current index still retains AST bodies and source names. It does not yet have numeric schemas, general globals, closure summaries, or dynamic data owners.

### Lower

`lowerFunction(index, funcId)` creates one WAT function. Numeric control IDs, lexical target records, local representation and range facts, alias checks, raw pointer plans, invariant splats, reusable expression temporaries, and their high-water marks live in function scratch. Values use short positional wrappers while lowering; finalized WAT owns none of those facts. Nested loops and repeated compiles share no state. `lowerProgram(index)` retains finalized WAT functions until module completion.

Canonical typed loops hoist storage bases and advance i32 pointers. `simd: true` packs pure f64 maps into two lanes when ranges are proven, storage does not relocate, and alias groups are independent or use the same element. Odd lengths end with one scalar element. Alias, relocation, range, local-effect, and transitive global-write vetoes stay scalar. [`dsp-evidence.md`](dsp-evidence.md) records byte equality and runtime direction.

Unknown f64 bitwise operands use one module-owned exact conversion helper. Constants, proven ranges, i32 locals, and direct i32 results bypass it. Signed and unsigned i32 share Wasm storage but widen through different f64 conversions. Exported JavaScript and raw ABI signatures remain f64.

Graph measurements found no material lookup cost. A persistent instruction tape would retain another body representation.

### Backend

`compileCompact(source)` calls current `watr/compile` on the lowered WAT. The prototype defaults to `optimize: false`, matching the production compiler's optimize-off comparison used by `bench.mjs`.

```js
compileCompact(source, { optimize: true }) // current watr/optimize, then compile
compileCompact(source, { wat: true })      // return the lowered WAT array
compileCompact(source, { simd: true })     // enable proven f64x2 maps
```

The optimized path covers nested loops, lexical control transfer, update values, comma effects, and short-circuit joins. Lowering derives WAT local names from numeric binding IDs because watr 5.10.1 CSE invalidates named local writes only. Wasm still uses numeric local indices, and graph output remains byte-identical to the direct control. The general numeric-index fix is committed upstream as watr `b53c92c`; this branch does not depend on it. The installed watr package is unchanged.

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

The prototype does not establish memory behavior for parsing, the production object model, stdlib realization, closures, snapshots, dynamic typed storage, or the production vectorizer's full recognizer set. It also does not prove that whole-module watr optimization fits the recursive memory target.

The typed DSP proof is the final standalone feature slice. Further prototype changes are limited to regressions and evidence. New implementation work migrates proven authorities into production.

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
node prototype/compact/dsp-bench.mjs
node prototype/compact/bench.mjs
```

Do not add these commands to `test/index.js` or `package.json` while the work remains isolated.

The graph benchmark runs the staged and frozen direct backends in fresh processes at 128, 512, and 2,048 functions. It records source, compiler, and output hashes, phase time, post-GC heap, retained WAT, and maximum function scratch. [`graph-evidence.md`](graph-evidence.md) records byte-identical output at every size, plateauing scratch, and finalized WAT as the largest staged-only linear owner.

The benchmark self-compiles the staged compiler. In both optimization modes, one reusable instance compiles A, A, B, integer and typed kernels, and the empty source. B must match a fresh-instance build, and empty input must produce the canonical 8-byte module. Timed rows compare optimize-off compilation with the current compiler's optimize-off path. Timed intervals include compilation and output copying; instantiation, source marshaling, and `_clear()` stay outside.

Latest loaded-machine result against the fresh 14,457,881-byte `dist/jz.wasm`:

- staged compiler: 2,257,267 bytes, 6.41x smaller
- staged source graph: 72 modules, 1,016,669 source bytes
- compile-speed geomean: 41.03x
- minimum compile speedup: 4.66x
- emitted-size geomean: 20.81x smaller
- constant modules tie production at 41 bytes
- the exact bitwise row is 212 bytes versus production's 120 bytes
- the typed SIMD row compiles 15.89x faster and emits 287 bytes versus production's 568 bytes

The bitwise size loss is visible and blocks production promotion. It is the current cost of exact conversion for unknown f64 operands; local i32 and range proofs remove that helper where possible. The typed row's win does not offset this per-case loss.

Generic optimization has a fixed cost on tiny modules. The benchmark exercises it during semantic and reuse checks, while timed rows compare matching optimize-off paths. Production uses the same profile-controlled policy.

The machine had about 11.4 GiB of allocated swap, so these timings do not certify release performance. The artifact ratio compares compilers with different language coverage and does not predict production savings.
