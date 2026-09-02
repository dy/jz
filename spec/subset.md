# Good-parts subset

JZ compiles this subset of JavaScript. Every value has one kind from the lattice in `spec/tiers.md`; `any` is the tagged union of the others and exists only where a program is heterogeneous by design. Operations on the kinds have JS semantics unless a typed contract below says otherwise, and a typed contract is reported per function. Anything outside the subset is rejected at compile time with the site named. Nothing differs from JS silently.

## Syntax

`let`, `const`, `var`, arrows, `function`, rest, defaults, destructuring, `import`/`export` bundled at compile time; `if`, `for`, `for-of`, `while`, `do`, `switch`, labeled `break`/`continue`, `try`/`catch`/`finally`, `throw`; template literals; optional chaining; nullish coalescing; classes with fields, methods, `extends`, `super`, private and static fields, resolved statically; `this`, `new`, `instanceof` against static shapes; `async`/`await`, generators, `for await`, lowered to state machines with jobs draining at host boundaries.

## Kinds and their contracts

- `f64`: IEEE double with JS arithmetic. Transcendentals use JZ kernels and may differ from the host in the last bits; reported once per module.
- `i32`: the value of an exact ToInt32 or ToUint32 (`|0`, `>>>0`, `Math.imul`, the bitwise operators), or a value proven in range by interval analysis. A typed `i32` never wraps outside a source wrapping operator; a value that cannot be proven stays `f64`.
- `i64`: BigInt through `BigInt64Array` and `BigUint64Array` storage and `BigInt.asIntN(64, x)` / `BigInt.asUintN(64, x)` arithmetic. General BigInt is rejected.
- `v128`: produced by vectorization, never by source.
- `str`: JS strings, UTF-16 code units for `length`, indexing, slicing, search, and regular-expression positions; concatenation, comparison, the `String` methods in the runtime; ASCII and simple Unicode case mapping, no locale tables.
- `typedarray T`: every `ArrayBuffer` view, `DataView`, `Float16Array`, `Atomics`. Access is bounds-checked and traps out of range; the trap is the contract and is reported.
- `struct S`: an object literal or class instance with a fixed shape and typed fields, unboxed. Method dispatch is static.
- `array T`: a growable array of one kind, JS growth and bounds semantics, the `Array` methods in the runtime.
- `dict V`: a string-keyed dictionary of one value kind (`dict any` for heterogeneous), `delete` and computed keys allowed; `Map` and `Set` are dictionaries with their JS API; `WeakMap` and `WeakSet` are `Map` and `Set`.
- `closure C`: a function value with a typed signature and a fixed capture record.
- `any`: the tagged union of the kinds above plus `null`, `undefined`, and `boolean`. The operators on `any` (`+`, comparison, `typeof`, loose and strict equality, truthiness, property access on `struct` and `dict`, indexing on `array` and `typedarray`, calling a `closure`) follow JS semantics over these kinds. `any` is where JSON lands, where a guarded export's arguments enter, and where a container is heterogeneous.

## Runtime

Written in jz, compiled by the core, loaded per feature only when a program uses it: `Math`, `Number`, `String`, `Array`, `Object` (literal helpers, `keys`, `values`, `entries`, `assign`, `freeze` as identity), `JSON`, `RegExp` (the current supported grammar), `Symbol.iterator` protocol, `Date` (UTC getters), `TextEncoder`, base64 and hex codecs, `structuredClone` over the kinds above, timers, crypto randomness, `URLSearchParams`.

## Rejected

`eval`, the `Function` constructor, `with`, `Proxy`, `Reflect`, property descriptors, getters and setters, live prototype chains, `__proto__`, `Object.create(proto)`, monkey-patching builtins, `arguments` beyond rest forwarding, dynamic `import`, Annex B syntax, `try` across `yield` or `await`, general BigInt arithmetic, objects whose shape changes after creation (adding a key to a struct; use `dict`), Intl, Temporal, DOM and Node services (they cross as host imports), and any string operation that needs locale or normalization tables.

## Divergence policy

- A program in the subset returns the same values as JS. Where a contract could differ (transcendental last bits, typed-array traps, Date's UTC getters), the difference is documented here and the tier report names the function.
- The compiler rejects, never approximates: a construct outside the subset is a compile error at the site, with the nearest in-subset form suggested where one exists.
- The differential suite covers the whole subset, `any` operations included, not only the numeric core.

## Mapping from the current compiler

The current strict and jzify modes map onto the subset with three corrected divergences: strings become UTF-16 code units, inferred integers never wrap without a source operator, and typed-array access is bounds-checked. BigInt narrows to typed storage and explicit 64-bit arithmetic. Dynamic-shape objects narrow to `dict`. Everything in the README's "not supported" list stays rejected.

### README "what differs from JS", item by item

| README item | Disposition |
|---|---|
| numbers: proven integers wrap at ±2^31; `x|0` saturates past 2^63 | corrected: `i32` only from ToInt32/ToUint32 or a proven range; `x|0` is exact ToInt32 |
| BigInt is 64-bit and wraps | typed contract: `i64` through typed storage and `asIntN`/`asUintN`; general BigInt rejected |
| transcendentals differ in last bits | contract, reported once per module |
| strings are UTF-8 bytes | corrected: UTF-16 code units |
| objects: no live prototypes, descriptors, accessors, Proxy, Reflect | rejected list |
| dynamic boolean keys read as `'1'` | corrected: JS semantics on `dict` |
| indices coerce to i32; typed arrays unchecked | contract: bounds-checked, trap out of range, reported |
| no garbage collector, `memory.reset()` | replaced by regions (`spec/memory.md`) |
| `try` across `yield`/`await` unsupported | rejected list |
| Date getters use UTC; no Intl or Temporal | reported divergence for local-time getters; Intl and Temporal rejected |
| no `eval`, `Function`, `with` | rejected list |
| DOM, Node, Annex B | rejected list; services cross as host imports |

### Test corpus, file by file

Typed kinds only: `bytebeat`, `cond-vectorize`, `fifthroot-ulp`, `inplace-store`, `interval-proof`, `layout-kinds`, `loop-square`, `math`, `mem`, `native-lowering`, `never-grown`, `number`, `pointers`, `pow-cr`, `pow-fold-ulp`, `pow-ulp`, `simd`, `simd-intrinsics`, `slp`, `struct-inline`, `types`, `unsigned`, `unswitch-typed-param`, `buffer`, `abrupt-oob`.

Runtime kinds and `any`: `array-methods`, `async`, `booleans`, `classes`, `closures`, `conditional-spread`, `data`, `date`, `destruct`, `dyn-closure-tables`, `dyn-keys`, `errors`, `generators`, `imports`, `iteration`, `json`, `jsstring`, `objects`, `regex`, `rest-params`, `spread`, `statements`, `strings`, `symbols`, `timers`, `webglobals`, `workers`, `wasi`, `interop`, `external`, `cli`, `transform`, `examples`, `hoist-loop-global`, `forin-deopt`, `multi-return`, `bool-identity`.

Both (ported in two halves): `data`, `objects`, `closures`, `statements`, where numeric kernels and containers share a file.

Compiler evidence, not subset features (kept as gates or replaced by the core's own): `abi`, `bench*`, `compact-prototype`, `deopt`, `determinism`, `differential`, `eager-stdlib-parity`, `ecosystem-perf`, `feature-gating`, `features`, `fuzz`, `grid-current`, `headline`, `inference`, `invariants`, `kernel-oracle`, `kernel-parity`, `kernel-target`, `minimal-output`, `optimizer`, `parser-bugs`, `passes`, `perf`, `perf-ratchet`, `preeval`, `provenance-inference`, `refactor-oracle`, `self-compile*`, `session-reentrancy`, `slot-hazards`, `snapshot`, `speculate`, `test262*`, `warnings`, `wat-invariants`, `watr`, `web-smoke`.

Rejected: nothing in the corpus tests a rejected construct as supported; the negative-accept cases in `parser-bugs` and `feature-gating` become the rejection tests of phase 4.
