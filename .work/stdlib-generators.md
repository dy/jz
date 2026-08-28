# stdlib generators: collection.js / typedarray.js — map + refactor record

Baseline: b05caa1a (== main HEAD at task start; `module/collection.js` and
`module/typedarray.js` are not among main's dirty files, so this worktree's
pristine checkout is byte-identical to what's live in the main worktree).

## Premise check (must read before the plan below)

The task described `genUpsertStrictPrehashed` as spanning ~2,533 lines and
`genSimdMap` as spanning ~2,886 lines — "single generator functions that
produce WAT templates." At b05caa1a **neither claim holds**:

- `genUpsertStrictPrehashed` (module/collection.js:1313-1372) is 60 lines: a
  small, already-parameterized template generator built from ~20 shared
  template-fragment helpers.
- `genSimdMap` (module/typedarray.js:171-238) is 68 lines: same shape, built
  from the `simdOp`/`scalarOp` closure factories.

The cited line counts (2533, 2886) are reproduced exactly by measuring from
each function's `function` line to the next **top-level** declaration —
`collKeysFromTemp` at collection.js:3846 (3846-1313=2533) and `export
default` at typedarray.js:241 (241 is wrong end; measuring genSimdMap:171 to
EOF:3055 gives 2884, off by 2 from "~2886" — same artifact). In both files
the named generator happens to be the **last helper defined before the
file's `export default (ctx) => {...}` module-registration closure**, so a
"span to next top-level name" heuristic silently swallows that entire
closure — which registers ~65 (collection.js) / dozens (typedarray.js)
**unrelated** stdlib entries (dyn_get/dyn_set/dyn_del, sclone, hash_new
variants, DataView get/set, typed-array fill/reverse/sort/copyWithin, bounds-
check analysis, etc.) having nothing to do with upsert or SIMD-map.

Both named functions, and their immediate sibling families, are **already
well-factored**: no duplicated template text across variants remains
un-deduplicated (verified by reading every generator in the family and every
shared fragment helper end to end — see below). There is no safe,
provable, byte-preserving de-duplication left to do at the sub-function
level; doing so would require either fabricating busywork on already-DRY
~60-line functions (the CLAUDE.md "optimizing a proxy" trap) or fusing
functions with genuinely different semantics (grow vs no-grow, prehashed vs
runtime-hash, EXTERNAL-fallthrough vs strict), which is a logic change, not
a move, and explicitly out of scope ("never speculative abstraction").

What **is** real and matches the task's own example paths
(`module/collection/upsert.js`, `module/typedarray/simd-map.js` — named
verbatim in the task) is the file-organization goal: both files are grab-bag
"module registration" files, and each contains one genuinely cohesive,
self-contained, already-DRY subsystem — the hash-table probe/upsert/lookup/
delete pipeline in collection.js, the SIMD-map pattern-detection+codegen
pipeline in typedarray.js — that can be PURE-MOVED into its own file with
zero logic change, verified byte-identical by construction. That is what
this refactor does.

## collection.js map (3974 lines before)

Top-level shape:
- 1-30: imports, module doc.
- 31-368: general collection primitives used file-wide (LENGTH_SSO_I64,
  dynPropsFilter*, heapResetWat, the 8 `durable*IR` heap-log helpers,
  strHashLiteral, numHashLiteral). Multiple external consumers
  (module/array.js, module/core.js, module/json.js) — **stays**.
- 369-406: `numConstLiteral`, `ASCII_KEY`, `litKeyHash`, `keyEq`/`strEqG`/
  `sameValueZeroEqG`/`bitEq`. Used by `litKeyHash` call sites at lines
  1734/1742/1888/1903 (compile-time literal-key hash fast path, inside
  `export default`, unrelated to the probe family) and passed as plain
  string arguments into the probe-family generators. **Stays** (moving
  would force collection.js to import back a pile of one-off string
  constants for no benefit).
- **407-546: probe/grow/zombie template-fragment helpers** — `LANE`,
  `collectionLaneBytes`, `collectionStride`, `hasProbeLane`, `GROW_QUAD_CAP`,
  `nextCapIR`, `probeStart`, `probeNext`, `indexedProbeStart`,
  `indexedProbeNext`, `slotFromIndexed`, `slotFromLane`, `laneLocals`,
  `probeHashLoad`, `probeHashStore`, `useRememberedZombie`,
  `rememberZombie`, `restoreZombieProbe`, `laneBaseInit`, `laneRehashStore`,
  `deleteShiftInit`, `deleteShiftNext`, `deleteShiftLaneMove`,
  `deleteShiftLaneClear`, `zombieRescan`, `seqStore`. Grep-verified: every
  call site of every one of these names falls inside 407-1372 (the block
  itself, or the generator family below); `collectionLaneBytes` is the one
  exception — also called once more at line 1378, the first line of
  `export default` — so collection.js imports it back. **MOVES.**
- **548-1372: the probe-family generators** — `genUpsert` (559),
  `genLookup` (672), `genDelete` (722), `genUpsertGrow` (802),
  `genSlotUpsert` (931), `genEphemeralSlotUpsert` (1054),
  `genEphemeralFixedSlot` (1181), `genLookupStrict` (1229),
  `genLookupStrictPrehashed` (1265), `genUpsertStrictPrehashed` (1313, the
  named target). 10 focused generators, one per (upsert|lookup|delete) ×
  (growable|fixed|ephemeral|prehashed) combination, all built from the
  fragment helpers above plus the 5 `durable*IR` helpers that stay behind
  (`durableFwdLogIR`, `durableSlotLogIR`, `durableEntryLogIR`,
  `durableSlotCancelIR`, `durableSlotRelogIR`) and `TOMB_NAN`/`UNDEF_NAN`
  (from `src/ir.js`) and `LAYOUT`/`PTR` (from `src/ctx.js`) and
  `STR_HCACHE_BIT` (from `layout.js`). **MOVES** to
  `module/collection/upsert.js`.
- 1374-3845 (2472 lines): `export default (ctx) => {...}` — module wiring:
  `deps()` graph, ~65 `ctx.core.stdlib[...] =` registrations. Calls the 10
  moved generators at their 15 call sites (SET/MAP/HASH × add/get/has/
  delete, plus `_h` prehashed siblings) exactly as before, now via import.
  **Stays** (this is `module/index.js`'s registration surface — untouched
  per the task's own constraint).
- 3846-3974: `collKeysFromTemp`/`collEntriesFromTemp`/`arrIdxFromTemp`/
  `arrEntriesFromTemp`/`arrEntriesFromTempTyped` — unrelated iteration
  helpers. **Stays, untouched.**

External export surface preserved exactly: `LANE`, `collectionLaneBytes`,
`collectionStride`, `GROW_QUAD_CAP` move to upsert.js; collection.js
re-exports/imports them back so module/core.js's `collectionLaneBytes`
import and module/object.js's `GROW_QUAD_CAP` import are untouched.

Cross-module edge: `module/collection/upsert.js` imports 5 `durable*IR`
helpers back from `../collection.js` (they're part of that file's cohesive,
cross-referenced 8-function "durable heap log" family — 4 of the 8 have
consumers outside the probe family, e.g. `durableFwdLogIR` is imported
directly by `module/array.js`, so splitting the family in half to dodge a
cycle would fragment a documented, comment-cross-referenced unit for no
reason). This is a two-node cycle (collection.js ↔ collection/upsert.js)
safe under ESM because every use is inside a function body evaluated lazily
at template-materialization time, never at module-evaluation time — verified
empirically by the full test battery below, not just argued.

## typedarray.js map (3055 lines before)

Top-level shape:
- 1-24: imports, module doc.
- 25-58: `_NAN_BITS`, `typedAux`, `STRIDE`, `SHIFT`, `LOAD`, `STORE`,
  `wrapIntIR` — general typed-array constants used file-wide (STRIDE/SHIFT
  alone: 5/25 use sites spread from line 173 to 2907, far outside the SIMD
  section). **Stays.**
- **59-238: the SIMD family** — `VEC_WIDTH` (60), the file's own
  `// === SIMD pattern detection ===` section: `isConst` (76), `analyzeSimd`
  (86); the file's own `// === SIMD + scalar WAT codegen ===` section:
  `simdOp`/`scalarOp` factories (130/148), their `simdF64/F32/I32` /
  `scalarF64/F32/I32` instances (163-164), and `genSimdMap` (171, the named
  target). Every one of these names is grep-confirmed used ONLY within this
  range plus its single call site. The section boundaries are the
  original authors' own comment markers — this is already recognized as one
  concern. **MOVES** to `module/typedarray/simd-map.js`.
- 241-3055 (2814 lines): `export default (ctx) => {...}` — DataView get/set
  tables, typed-array fill/reverse/copyWithin/sort/set, checked-index bounds-
  check analysis (`typedBundleGuard` and friends), and the `.typed:map`
  handler (2187-2220) that calls `analyzeSimd`/`genSimdMap` at its one call
  site (2204/2209). **Stays**, now importing `analyzeSimd`/`genSimdMap` from
  the sibling file.

No external consumers of anything in the SIMD section (grep across
module/src/test: nothing imports named symbols from typedarray.js at all —
only `module/index.js` imports its default export). `module/typedarray/simd-
map.js` imports `STRIDE`/`SHIFT`/`LOAD`/`STORE` back from `../typedarray.js`
(newly exported — zero external consumers today, so widening their
visibility is inert) and `PTR` directly from `../../src/ctx.js`. Same
two-node-cycle shape as collection.js/upsert.js, same safety argument.

## Dead-variant check (task step 4)

`genUpsertStrictPrehashed`'s 4 parameters (entrySize, eqExpr, expectedType,
hasVal) each have every value exercised across its 3 call sites
(`__set_add_h`/`__map_set_h`/`__hash_set_local_h`: SET_ENTRY+MAP_ENTRY,
sameValueZeroEqG+strEqG, PTR.SET+PTR.MAP+PTR.HASH, hasVal false+true) —
nothing dead.

`genSimdMap`'s `elemType<4` branch (i8/u8/i16/u16) deliberately returns
`null` (documented: "no SIMD path, would need i8x16/i16x8") and the caller
already handles a null return with a scalar fallback — not dead code, a
declared non-support tier. All of `analyzeSimd`'s op families (mul/add/sub/
div/neg/abs/sqrt/ceil/floor/and/or/xor/shl/shr/shru) are reachable (it's a
pure AST-shape matcher with no elemType gate) and all are present in both
`simdOp`'s and `scalarOp`'s tables. No dead parameters found in either
generator; nothing deleted under step 4.

Side finding (out of scope, not acted on): `scalarOp`'s bitwise arms
(and/or/xor/shl/shr/shru) always target an `i32.*` instruction regardless of
which type-prefix instantiated them, so `scalarF64('and', c)`/
`scalarF32('and', c)` would emit `(i32.and (local.get $e) …)` against an
`f64`/`f32`-typed local — invalid WAT — if `analyzeSimd` ever matched a
bitwise pattern on a Float32/Float64Array callback (`x => x & 3`). Comment
at typedarray.js:137-138 asserts this combination doesn't arise ("no-op for
float prefixes since analyzeSimd won't produce these for float") but nothing
in the code enforces it; whether it's actually unreachable depends on
upstream type inference this task doesn't touch. Flagging per "point defects
immediately" — not fixed here: fixing it would change emitted output for
that input shape, which this task must not do, and it's unrelated to
pipeline minimality.

## Commits (filled in as each move lands)

1. `.work/stdlib-generators.md` (this file).
2. PURE MOVE: `module/collection/upsert.js` extracted from collection.js
   407-1372; collection.js imports the 10 generators + LANE/
   collectionLaneBytes/collectionStride/GROW_QUAD_CAP back.
3. PURE MOVE: `module/typedarray/simd-map.js` extracted from typedarray.js
   59-238; typedarray.js imports analyzeSimd/genSimdMap back.

No de-duplication commit and no deletion commit follow, per the findings
above — both would be scope invention against an already-minimal codebase.

## Verification

- sed-diff: extracted body text vs. new sibling file body, byte-identical
  (mechanical, not a rewrite-by-hand).
- Compiled-output byte-identity oracle (temporary,
  `scratchpad/verify-hashes.mjs`, not committed): sha256 of wasm bytes at
  optimize ∈ {0,2,3} for test/kernel-parity.js's CORPUS, every bench/*/*.js,
  every examples/*/*.js, and /Users/div/projects/watr/watr.js's full module
  graph — baseline captured against pristine b05caa1a before any edit,
  re-run after each commit, diffed to empty.
- Full battery: `node test/index.js` (excl. bench-c.js), kernel build +
  `JZ_TEST_TARGET=jz.wasm node test/index.js`, kernel-parity, kernel-oracle,
  `node scripts/bench-size.mjs --json`, kernel byte count before/after.

(Numbers filled in below once the battery runs.)
