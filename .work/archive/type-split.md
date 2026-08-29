# type.js split — family map

`src/type.js` (2,561 lines @ 991a6fdd) has no lattice/queries/coercion shape —
its own section dividers (`grep -n '^// ==='`) mark 5 real families, one of
which (loop-versioning) further splits into a base scan + a nest-level lift
built strictly on top of it. Every top-level declaration and its owning
family, verified via `grep -n '^export \|^const \|^function '` plus a
line-range membership script (no manual guessing):

| lines | family | headline exports |
|---|---|---|
| 54–750 | typed-array loop-versioning (single loop) | `typedStaticLen`, `typedIdxProven`, `idxKey`, `affineIdxOfIV`, `SLOT_OPS`, `bodyAffineEnv`, `versionableTypedFor`, `isCondExpr` |
| 552–744 (nested inside the range above) | loop-versioning, NEST level | `versionableTypedNest` (calls `versionableTypedFor`) |
| 751–988 | canonical single-loop bounds proof (charCodeAt + array-idx siblings) | `isUnitIncrement`, `isUnitDecrement`, `scanBoundedLoops`, `inBoundsCharCodeAt`, `scanBoundedArrIdx`, `inBoundsArrIdx`, `litBoundArrIdx` |
| 990–1944 | interval abstract interpreter (`typedIdxProven` class 5) | `intervalProvenIdx`, `intervalIdxRanges` (one ~900-line function, `scanIntervalIdx`) |
| 1946–2068 | loop-unroll AST transforms | predicates: `containsNestedClosure/Loop`, `nestedSmallLoopBudget`, `containsDeclOf`, `containsKnownTypedArrayIndex`, `smallConstForTripCount`, `isTerminator`, `MAX_*_FOR_UNROLL`; clone: `cloneWithSubst` (+private `stampClonedIdxProof`) |
| 2069–2376 | `exprType` — i32/f64 expression-type inference (mirrors emit.js) | `exprType` |
| 2378–2561 | integer-certainty fixpoint lattice | `intLevelMap`, `intCertainMap`, `intExprChecker`, `intLevelChecker` |

Full per-name consumer grep (`src/`, `module/`, excl. `test/`) — every import
site of every currently-exported name, so the module split changes zero
consumer import lines:

- `src/compile/emit.js` — the biggest consumer, spans every family: `containsNestedClosure, containsNestedLoop, nestedSmallLoopBudget, containsDeclOf, cloneWithSubst, containsKnownTypedArrayIndex, smallConstForTripCount, isTerminator, scanBoundedLoops, inBoundsCharCodeAt, exprType, MAX_SMALL_FOR_UNROLL, MAX_NESTED_FOR_UNROLL, inBoundsArrIdx, typedIdxProven, versionableTypedNest, idxKey, SLOT_OPS`
- `src/compile/narrow.js` — `scanBoundedLoops, exprType, typedElemCtor, typedStaticLen, intLevelMap`
- `src/compile/index.js` — `intCertainMap, typedStaticLen`
- `src/compile/program-facts.js` — `intLevelChecker`
- `src/compile/analyze-scans.js` — `exprType`
- `src/compile/infer.js` — `typedElemCtor, typedStaticLen`
- `src/compile/plan/literals.js` — `smallConstForTripCount, containsDeclOf, cloneWithSubst`
- `src/compile/plan/scope.js` — `intLevelMap`
- `src/compile/plan/common.js` — `typedElemCtor`
- `src/compile/plan/loops.js` — `containsDeclOf, cloneWithSubst, isUnitIncrement`
- `src/compile/plan/inline.js` — `cloneWithSubst`
- `src/compile/analyze/val-types.js` — `isCondExpr, intCertainMap`
- `src/compile/analyze/ptr-eligibility.js` — `exprType`
- `src/compile/analyze/union-inline.js` — `scanBoundedArrIdx, isTerminator`
- `src/compile/analyze/trackers.js` — `typedStaticLen`
- `src/compile/analyze/body-facts.js` — `exprType, intCertainMap, intLevelMap`
- `module/array.js` — `inBoundsArrIdx, typedIdxProven`
- `module/typedarray.js` — `typedIdxProven, idxKey`
- `module/console.js` — `exprType`

Exported but **zero external consumers today** (only used internally within
type.js, or by nothing at all — grep-verified, not deleted: still real
call sites inside the file, so this is live API surface, not dead code):
`affineIdxOfIV`, `bodyAffineEnv`, `isUnitDecrement`, `litBoundArrIdx`,
`intervalProvenIdx`, `intervalIdxRanges`, `versionableTypedFor` (only called
by `versionableTypedNest`).

`typedElemCtor` (line 52, `export { typedElemCtor } from './typed-provenance.js'`)
is a pure passthrough — never lived in type.js's own code; stays verbatim in
the barrel.

No dead code found: every import at the top of type.js has ≥1 real use
beyond its own import line (checked all 16); every top-level declaration has
≥1 call site (internal or external). Unlike analyze.js's split precedent,
this file carries no orphaned doc comments or unused imports — it was
already swept in the pipeline-minimality campaign's M1c pass.

## Internal dependency DAG (why the module boundaries are where they are)

Programmatic cross-section reference scan (word-boundary grep of every
top-level name against every other section's line range, filtered for real
code vs. doc-comment mentions) found one genuine cycle risk: `idxKey` was
defined inside the loop-versioning section (used by `typedIdxProven`) but
the interval abstract interpreter's `scanIntervalIdx` also calls `idxKey`
directly (3 sites) while loop-versioning's `typedIdxProven` calls the
interval module's `intervalProvenIdx`/`intervalIdxRanges` — a direct cycle
if `idxKey` stayed put. Fix: `idxKey` relocates to `canonical-bounds.js`,
already the one true leaf both sides already depend on for other reasons
(`redeclaresName`, `collectDecls`, `isUnitDecrement`/`isUnitIncrement`,
`lengthRecv` — the last three promoted from file-private to exported-for-
sibling-modules, not added to the public barrel). Verified with a DAG walk,
no other cycle exists:

```
canonical-bounds.js   loop-unroll.js   int-certain.js      (leaves)
        ^                   ^
        |                   |
  interval-proof.js    (no deps)
    ^         ^
    |         |
expr-type.js  clone.js -> canonical-bounds.js, interval-proof.js
    ^              ^
    |              |
    +----- loop-versioning.js -> canonical-bounds.js, interval-proof.js,
    |                             expr-type.js, loop-unroll.js
    |
loop-versioning-nest.js -> loop-versioning.js (calls versionableTypedFor),
                            canonical-bounds.js, interval-proof.js, loop-unroll.js
```

`src/type.js` (barrel) imports from all 8 and re-exports exactly the
pre-split public name set — no consumer import line changes anywhere.

## Module map (target)

| new file | lines (approx) | contents |
|---|---:|---|
| `src/type/canonical-bounds.js` | ~245 | `idxKey` (relocated), `isUnitIncrement`, `isUnitDecrement`, `scanBoundedLoops`, `inBoundsCharCodeAt`, `scanBoundedArrIdx`, `inBoundsArrIdx`, `litBoundArrIdx`; private `collectBoundedCC`/`collectBoundedArrIdx`; `redeclaresName`/`collectDecls`/`lengthRecv` promoted to exported (sibling-only, not barrel-public) |
| `src/type/loop-unroll.js` | ~75 | `MAX_SMALL_FOR_UNROLL`, `MAX_NESTED_FOR_UNROLL`, `containsNestedClosure`, `containsNestedLoop`, `nestedSmallLoopBudget`, `containsDeclOf`, `containsKnownTypedArrayIndex`, `smallConstForTripCount`, `isTerminator` — zero deps on any type/ sibling |
| `src/type/int-certain.js` | ~184 | `intLevelMap`, `intCertainMap`, `intExprChecker`, `intLevelChecker` — fully independent subsystem, zero deps on any type/ sibling |
| `src/type/interval-proof.js` | ~955 | `intervalProvenIdx`, `intervalIdxRanges`; the abstract interpreter `scanIntervalIdx` (DECLINED further decomposition — see below) |
| `src/type/expr-type.js` | ~308 | `exprType` (DECLINED further decomposition — see below) |
| `src/type/clone.js` | ~45 | `cloneWithSubst` (+private `stampClonedIdxProof`) |
| `src/type/loop-versioning.js` | ~500 | `typedStaticLen`, `typedIdxProven`, `affineIdxOfIV`, `SLOT_OPS`, `bodyAffineEnv`, `versionableTypedFor`, `isCondExpr` (DECLINED further decomposition beyond extracting the nest file — see below) |
| `src/type/loop-versioning-nest.js` | ~193 | `versionableTypedNest` (+private `condIvName`) |
| `src/type.js` | ~65 | barrel: module doc-comment + re-exports only + the `typedElemCtor` passthrough |

## Decompose-outliers decisions (>250 lines)

- **`interval-proof.js` (~955 lines) — DECLINED.** `scanIntervalIdx` is one
  function by necessity: ~15 nested closures (`env`, `symEnv`, `coupledEnv`,
  `closureWrites`, `activeFacts`, `ev`, `refine`, `refineAll`, `loopFixpoint`,
  `visit`, `visitWithFacts`, …) share mutable state that the whole proof's
  soundness depends on threading correctly across passes (2-round widening
  fixpoint, break/continue snapshot hulling, closure-write poisoning). This
  is exactly the pipeline-minimality campaign's own classification (see
  `.work/archive/pipeline-minimality.md` line 39): "env-threading evaluator /
  abstract interpreter — traversal IS the semantics — keep." Splitting it
  would mean threading 6+ shared mutable Maps as explicit parameters through
  dozens of call sites for zero behavioral benefit and real regression risk.
- **`expr-type.js` (~308 lines) — DECLINED.** `exprType` is a single
  dispatch chain over AST op-kind, and the file's own module doc comment
  (moved to the barrel) establishes it as one half of a two-file SHARED
  CONTRACT with `emit.js` ("decided in TWO places that must agree... edit
  one side only with the other open beside it"). Splitting the dispatcher
  would scatter that audited contract across files, reducing exactly the
  legibility the contract depends on for safety. 308 lines total (including
  2 tiny private helpers) is a modest overage, not a runaway outlier.
- **`loop-versioning.js` (~500 lines) — partially split, remainder DECLINED
  further decomposition.** `versionableTypedNest` (+`condIvName`) is a
  clean, low-risk, well-justified seam: substantial size (~190 lines), a
  one-directional dependency (calls `versionableTypedFor`, nothing calls
  back), and the code's own doc comment frames it as a layer built ON TOP OF
  the single-loop scan ("Nest-level versioning scan: the intercepted loop
  PLUS every nested loop..."). Extracted to `loop-versioning-nest.js`. The
  remaining ~500 lines (`typedStaticLen`, `typedIdxProven`, `affineIdxOfIV`,
  `invariantIdxExpr`, `bodyAffineEnv`, `monotoneCursorOf`, `maxCursorAdvance`,
  `versionableTypedFor`) stay one file: the affine/cursor helpers
  (`affineIdxOfIV`, `bodyAffineEnv`, `monotoneCursorOf`, `maxCursorAdvance`)
  have ZERO consumers besides `versionableTypedFor` itself (grep-verified),
  and their doc comments read as one continuous train of thought describing
  concrete cases inside `versionableTypedFor`'s own candidate-recognition
  logic (not an independent reusable utility) — splitting them out would add
  an import hop for zero reuse benefit and scatter one coherent proof
  narrative, the opposite of "subtract the redundant, never the meaningful."

## Retirements (walkAst/some)

Already landed by the sibling `refactor/pipeline-minimality` session before
this branch was cut (`.work/archive/pipeline-minimality.md` M1c: "type.js" appears
in the batch-3 sweep). Confirmed on read-through: every traversal in this
file is already either `walkAst`/`some`/`someDeep` or a documented "keep"
(env-threading evaluator — `scanIntervalIdx`; irregular/order-sensitive
scan — `versionableTypedFor`'s `scan`/`versionableTypedNest`'s `walkLoop`/
`scanStmts`). No further retirement found. Nothing undone.

## Deletions

None found. Every import and every top-level declaration has a real call
site (verified above). Grep for genuinely dead code came back empty.

## Execution plan

Move-by-move, dependency order (leaves first), one file extracted from
`src/type.js` + `src/type.js` rewired per move, refactor oracle gate after
each, one commit per move:

1. `canonical-bounds.js` (leaf)
2. `loop-unroll.js` (leaf)
3. `int-certain.js` (leaf, fully independent)
4. `interval-proof.js` (needs canonical-bounds.js)
5. `expr-type.js` (needs canonical-bounds.js)
6. `clone.js` (needs canonical-bounds.js, interval-proof.js)
7. `loop-versioning.js` (needs canonical-bounds.js, interval-proof.js, expr-type.js, loop-unroll.js)
8. `loop-versioning-nest.js` (needs loop-versioning.js, canonical-bounds.js, interval-proof.js, loop-unroll.js) — after this, `src/type.js` is the pure barrel.

Line ranges verified byte-exact against `src/type.js` @ 991a6fdd with a
coverage script (no overlaps; every gap accounted for by the header
docblock or an intentional blank-line separator) before any extraction.
