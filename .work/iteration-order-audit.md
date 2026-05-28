# Compiler iteration-order audit

User asked: "Do we force map and set iteration order now? Should it matter for compiler?"

## Verdict: compiler iteration is deterministic & spec-guaranteed; no change needed.

### Where iteration order affects output

| Site | Collection | Effect | Risk |
|------|-----------|--------|------|
| `src/wat/assemble.js:459` | `ctx.core.includes` Set | Stdlib func order in WAT binary | LOW: source-order traversal, named refs |
| `src/compile/index.js:506+` | `ctx.func.locals` Map | Local decl order in WAT | LOW: named refs |
| `src/compile/index.js:253` | `ctx.func.boxed` Map | Heap-cell alloc order in prologue | LOW: addresses not user-observable |
| `src/compile/index.js:1108` | `ctx.scope.globals` Map | Global decl order in WAT | LOW: named refs |
| `src/compile/plan.js:2489-2502` | `programFacts.propMap` (Map of Sets) | Schema field offsets | LOW: deterministic for fixed source |

### Why this is OK

ES2015+ mandates insertion-order iteration for Map and Set. Every spec-compliant
engine (V8, JSC, SpiderMonkey, Boa, …) honors it. So for a fixed input source,
the JS-side compiler emits byte-identical WAT across engines.

### Why __coll_order IS needed (different concern)

__coll_order (src/wat/runtime via module/core.js) sorts the **user program's**
HASH/SET/MAP backing table at iteration time. This is needed because the
backing table is an open-addressing hash that rehashes on grow — without a
packed insertion sequence (riding the hash word's high 32 bits), iteration
order would be slot-order (post-rehash), which violates JS spec for
Object.keys / for-in / JSON.stringify / Map/Set iteration / spread.

This is for user-visible semantics in compiled programs, not for the compiler
itself. The "new heavy structure" cost is: a 4-byte insertion sequence per
slot + an O(n + n log n) sort on each iteration. The sort runs only when
Object.keys/values/entries/JSON enumerate a HASH or Map/Set — never on every
collection write.

### Recommendation

Keep both as-is. The compiler's Map/Set use is deterministic. __coll_order is
the minimal mechanism for spec-compliant user-program iteration.
