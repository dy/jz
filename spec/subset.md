# Good-parts subset

JZ compiles this subset of JavaScript. Inside the dynamic tier the semantics are JS semantics. Inside the typed tier the behavior is defined by the types below and reported per function. Anything outside the subset is rejected at compile time with the site named. Nothing differs from JS silently.

## Dynamic tier: JS semantics

- Bindings: `let`, `const`, `var`, arrows, `function`, rest, defaults, destructuring, closures, `import`/`export` bundled at compile time.
- Control: `if`, `for`, `for-of`, `while`, `do`, `switch`, labeled `break`/`continue`, `try`/`catch`/`finally`, `throw`.
- Numbers: f64 with JS arithmetic; `|0`, `>>>0`, `Math.imul`, and the bitwise operators are exact ToInt32/ToUint32. No value wraps unless the source applies a wrapping operator.
- Strings: JS strings, UTF-16 code units; `length`, indexing, slicing, search, and regular-expression positions count code units; template literals; ASCII and Unicode-simple case mapping; no locale tables.
- Objects: literals with static shapes plus a dictionary fallback for computed keys; `delete` on dictionary keys; classes with fields, methods, `extends`, `super`, private and static fields, resolved statically; `this`, `new`, `instanceof`.
- Collections: arrays with JS growth and bounds semantics, `Map`, `Set`, `WeakMap` and `WeakSet` as `Map` and `Set`.
- Builtins: `Math`, `Number`, `String`, `Array`, `Object`, `JSON`, `RegExp` (the current supported grammar), `Symbol`, `Date` (UTC getters), `TextEncoder`, base64 and hex codecs, `structuredClone`, timers, crypto randomness, `URLSearchParams`.
- Async: `Promise`, `async`/`await`, generators, iterator helpers, `for await`, lowered to state machines; jobs drain at host boundaries.
- Loose equality, `typeof`, optional chaining, nullish coalescing.

## Typed tier: typed contracts

A typed function's values carry one type each. The types and their contracts:

- `f64`: IEEE double, JS arithmetic. Transcendentals use JZ kernels and may differ from the host in the last bits; this is reported once per module.
- `i32`: the value of an exact ToInt32 or ToUint32, or a value proven in range by interval analysis. A typed `i32` never wraps outside a source wrapping operator; a value that cannot be proven stays `f64`.
- `i64`: BigInt only through `BigInt64Array` and `BigUint64Array` storage and `BigInt.asIntN(64, x)` / `BigInt.asUintN(64, x)` arithmetic. General BigInt is rejected.
- `v128`: produced by vectorization, never by source.
- `typedarray T`: every `ArrayBuffer` view, `DataView`, `Float16Array`, `Atomics`. Access is bounds-checked and traps out of range; the trap is the typed contract and is reported.
- `struct S`: an object literal or class instance whose shape is fixed and whose fields are typed. Fields are unboxed.
- `closure C`: a function value with a typed signature and a fixed capture record.

A typed function calls typed functions directly. It reaches the dynamic tier only through the boundary in `spec/boundary.md`.

## Rejected

`eval`, the `Function` constructor, `with`, `Proxy`, `Reflect`, property descriptors, getters and setters, live prototype chains, `__proto__`, `Object.create(proto)`, monkey-patching builtins, `arguments` beyond rest forwarding, dynamic `import`, Annex B syntax, `try` across `yield` or `await`, general BigInt arithmetic, Intl, Temporal, DOM and Node services (they cross as host imports), and any string operation that needs locale or normalization tables.

## Divergence policy

- A program in the subset returns the same values as JS. Where the typed tier's contract could differ (transcendental last bits, typed-array traps, `nogc` target limits), the difference is a documented contract and the tier report names the function.
- The compiler rejects, never approximates: a construct outside the subset is a compile error at the site, with the nearest in-subset form suggested where one exists.
- The differential suite covers the whole subset, dynamic tier included, not only the numeric core.

## Mapping from the current compiler

The current strict and jzify modes map onto the subset with three changes, each a corrected divergence: strings become UTF-16 code units, inferred integers never wrap without a source operator, and typed-array access is bounds-checked. BigInt narrows to typed storage and explicit 64-bit arithmetic. Everything in the README's "not supported" list stays rejected.

### README "what differs from JS", item by item

| README item | Disposition |
|---|---|
| numbers: proven integers wrap at ±2^31; `x|0` saturates past 2^63 | corrected: `i32` only from ToInt32/ToUint32 or a proven range; `x|0` is exact ToInt32 |
| BigInt is 64-bit and wraps | typed contract: `i64` through typed storage and `asIntN`/`asUintN`; general BigInt rejected |
| transcendentals differ in last bits | typed contract, reported once per module |
| strings are UTF-8 bytes | corrected: UTF-16 code units in the dynamic tier |
| objects: no live prototypes, descriptors, accessors, Proxy, Reflect | rejected list |
| dynamic boolean keys read as `'1'` | corrected: JS semantics in the dynamic tier |
| indices coerce to i32; typed arrays unchecked | typed contract: bounds-checked, trap out of range, reported |
| no garbage collector, `memory.reset()` | retired: wasm GC for the dynamic tier (`spec/memory.md`) |
| `try` across `yield`/`await` unsupported | rejected list |
| Date getters use UTC; no Intl or Temporal | reported divergence for local-time getters; Intl and Temporal rejected |
| no `eval`, `Function`, `with` | rejected list |
| DOM, Node, Annex B | rejected list; services cross as host imports |

### Test corpus, file by file

Typed tier: `bytebeat`, `cond-vectorize`, `fifthroot-ulp`, `inplace-store`, `interval-proof`, `layout-kinds`, `loop-square`, `math`, `mem`, `native-lowering`, `never-grown`, `number`, `pointers`, `pow-cr`, `pow-fold-ulp`, `pow-ulp`, `simd`, `simd-intrinsics`, `slp`, `struct-inline`, `types`, `unsigned`, `unswitch-typed-param`, `buffer`, `abrupt-oob`.

Dynamic tier: `array-methods`, `async`, `booleans`, `classes`, `closures`, `conditional-spread`, `data`, `date`, `destruct`, `dyn-closure-tables`, `dyn-keys`, `errors`, `generators`, `imports`, `iteration`, `json`, `jsstring`, `objects`, `regex`, `rest-params`, `spread`, `statements`, `strings`, `symbols`, `timers`, `webglobals`, `workers`, `wasi`, `interop`, `external`, `cli`, `transform`, `examples`, `hoist-loop-global`, `forin-deopt`, `multi-return`, `bool-identity`.

Both tiers (ported in two halves): `data`, `objects`, `closures`, `statements`, where numeric kernels and dynamic containers share a file.

Compiler evidence, not subset features (kept as gates or replaced by the core's own): `abi`, `bench*`, `compact-prototype`, `deopt`, `determinism`, `differential`, `eager-stdlib-parity`, `ecosystem-perf`, `feature-gating`, `features`, `fuzz`, `grid-current`, `headline`, `inference`, `invariants`, `kernel-oracle`, `kernel-parity`, `kernel-target`, `minimal-output`, `optimizer`, `parser-bugs`, `passes`, `perf`, `perf-ratchet`, `preeval`, `provenance-inference`, `refactor-oracle`, `self-compile*`, `session-reentrancy`, `slot-hazards`, `snapshot`, `speculate`, `test262*`, `warnings`, `wat-invariants`, `watr`, `web-smoke`.

Rejected: nothing in the corpus tests a rejected construct as supported; the negative-accept cases in `parser-bugs` and `feature-gating` become the rejection tests of phase 4.
