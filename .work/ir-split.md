# ir.js split (pipeline-minimality slice)

`src/ir.js` (2,487 lines, 140 top-level declarations, 76 external importers
across src/ + module/ + test/) — the IR construction layer: numeric/f64
coercion and range-narrowing, NaN-box pointer construction, BigInt box/unbox
(the phase-C representation campaign's box/unbox pairing rules —
`.work/phase-c-unification.md` — and the i64Hex hazard family), nullish
sentinels + boolean-atom boxing + truthiness, ToNumber/ToString/ToPrimitive
coercion, variable-storage abstraction (boxed/global/local dispatch), array
layout helpers, and misc control-flow/structural IR utilities.

Dependency graph built mechanically (`depgraph2.mjs`/`boundaries.mjs` in the
scratchpad, comments+strings stripped before regex-scanning identifier
co-occurrence per top-level declaration, verified against a second bug-fixed
pass — a first cut used a cached **global** regex reused across `.test()`
calls, whose `lastIndex` persisted between different declarations' texts and
silently dropped real edges; re-ran non-global before trusting any of it).
Every edge below is confirmed against the actual source, not just the
mechanical graph (doc-comment prose mentioning a sibling function's name —
common throughout this file's hazard notes — reads as a false edge on a
naive text scan; the comment-stripped graph plus a manual read of every
BigInt/pointer-tag function closes that gap).

## Exported surface and consumers

140 top-level declarations, ~113 exported. 76 files import from `./ir.js`
(or `../ir.js` / `../../ir.js`) across `src/`, `module/` (26 files — every
module leans on this layer), `test/`, and `scripts/self.js`. Full list
captured during mapping; none of these files' import lines need to change —
the barrel keeps re-exporting every currently-public name from its new
location, so this is invisible to all 76.

`stableNodeKey` — named in the task brief's description of ir.js's
contents — actually lives in `src/ast.js` (not ir.js); not part of this
file, not moved.

## Family map (real seams, by verified dependency edges)

| family | new file | members |
|---|---|---|
| tag | `src/ir/tag.js` | `typed` — the one universal primitive (zero deps, referenced by ~all 139 others transitively). Kept as its own leaf so no "bigger" family has to be the thing everyone imports (that would force an artificial ownership choice and risk a cycle — see below). |
| locals | `src/ir/locals.js` | `freshId`, `freshLocal`(priv), `temp`, `tempI32`, `tempI64`, `block64`, `blockTyped`, `withTemp` — temp-local factories + the block scaffolds built directly around them (`withTemp` wraps `temp()`). Original file placed these two `=== section ===` blocks back to back for the same reason. |
| pointers | `src/ir/pointers.js` | `ptrBoxPrefix`(priv), `boxPtrIR`(priv→**exported** for numeric.js), `mkPtrIR`, `ptrOffsetIR`, `VAL_TO_PTR`(priv), `valKindToPtr`, `ptrTypeIR`, `ptrTypeEq`, `dispatchByPtrType`, `litI32`(priv), `packPtrBits`(priv), `_F64_BITS_*`(priv), `extractF64Bits` — NaN-box pointer construction/extraction + pointer-tag runtime dispatch. `ptrTypeEq`/`dispatchByPtrType` moved here from the original "IR scaffolds" grab-bag section — they're pointer-tag dispatch, not generic scaffolding, and depend on nothing else. |
| classify | `src/ir/classify.js` | `MAX_CLOSURE_ARITY`, `MEM_OPS`, `WASM_OPS`, `SPREAD_MUTATORS`, `BOXED_MUTATORS`, `isLit`, `litVal`, `isNullLit`, `isUndefLit`, `isNullishLit`, `PURE_OPS`(priv), `isPureIR`, `EXPENSIVE_PURE_OPS`(priv), `hasExpensiveOp`, `hasLoadOp`(priv), `dataDependentFlag`, `PURE_F64_OPS`(priv→**exported** for coerce.js), `isNumericIR`, `resolveValType`, `isPostfix`, `emitNum` — merges the original "Constants" + "Literal / purity checks" sections (MEM_OPS is a real shared dependency of hasLoadOp, so splitting those two apart would have been artificial). |
| control | `src/ir/control.js` | `multiCount`, `loopTop`, `flat`, `findBodyStart`, `verifyFn`, `buildRefcount`, `nextLocalId`, `freshLoopPlanId`, `tcoTailRewrite`, `reconstructArgsWithSpreads` — whole-IR-tree structural utilities + control-flow/tail-call helpers. Matches the task brief's suggested name directly. Depends on nothing but tag.js — the original "IR scaffolds"/tail sections were a grab-bag; these are the pieces with no numeric/pointer/bigint coupling. |
| numeric | `src/ir/numeric.js` | `asF64`, `asI32`, `asI32Sat`, `asPtrOffset`, `asParamType`, `maskBound`, `narrowI32`(priv), `fin`(priv), `convRange`(priv), `f64Range`, `toI32`, `asI64`, `fromI64`, `f64rem` |
| bigint | `src/ir/bigint.js` | `bigintStrict`, `bigintEraseErr`, `boxBigInt`, `unboxBigInt`, `applyBigintRepresentationAction`, `maybeUnboxBigInt`, `isSchemaSlotBigintPossible`, `isTernaryBoxedBigint`, `isPlanTaggedBigint`, `readI64` — the phase-C box/unbox pairing family. Moved **verbatim, same relative order, same conditional structure** — this is the file `.work/phase-c-unification.md` names as load-bearing (`readI64`'s `maybeUnboxBigInt` vs `unboxBigInt` dispatch, the i64Hex hazard notes). No logic touched. |
| vars | `src/ir/vars.js` | `usesDynProps`, `needsDynShadow`, `isBoundName`, `isGlobal`, `isConst`, `boxedAddr`, `DOLLAR`(priv), `dollar`, `dollarMap`, `setDollarMap`, `clearDollar`, `readVar`, `writeVar` |
| arrays | `src/ir/arrays.js` | `slotAddr`, `elemLoad`, `elemStore`, `arrayLoop`, `allocPtr` |
| sentinels | `src/ir/sentinels.js` | `NULL_NAN`…`TRUE_IR`, `nullExpr`, `undefExpr`, `boolBoxIR`, `carrierF64`, `carrierF64Narrow`, `unboxBoolIR`, `TOMB_NAN`, `constI32`(priv), `matchF64Bits`(priv), `isNullish`, `isUndef`, `isNull`, `throwTypeErrorIR`, `BOOL_ATOM_MASK`(priv), `isBoolAtom`, `NUM_F64_TRUTHY_OPS`(priv), `numericTruthy`(priv), `I32_BOOL_OPS`(priv), `truthyIR`, `toBoolFromEmitted` — **merged** with what would otherwise be a separate "truthy.js": `boolBoxIR` calls `truthyIR`, and `truthyIR` calls `isNullish` — a genuine two-way cycle between "sentinel construction" and "truthiness testing" in the ORIGINAL code, not a splitting artifact. Splitting them into two files is not a pure move (no seam exists); kept as one family. |
| coerce | `src/ir/coerce.js` | `sidecarOverride`, `primMethodIdx`(priv), `toPrimitiveChain`(priv), `cloneIR`, `coerceNullishToNum`, `coerceNullishToStr`, `toNumF64`, `toStrI64`, `coerceRest`(priv), `errToStringIR`(priv), `ssoStrI64`(priv) — ToNumber/ToString/ToPrimitive coercion. `sidecarOverride` relocated here from the original "IR scaffolds" section (it's a ToPrimitive override probe, not generic scaffolding — confirmed zero internal callers, so no cycle risk either placement). |

Only two previously-private names need `export` added (cross-family use
within `src/ir/`, never added to the barrel's public re-export list since
neither was part of the original public API): `boxPtrIR` (pointers.js →
needed by numeric.js's `asF64`) and `PURE_F64_OPS` (classify.js → needed by
coerce.js's `toNumF64`).

## Dependency order (DAG, verified acyclic)

```
tag ← locals, pointers, classify, control
locals, pointers ← classify (MEM_OPS+temp), numeric
numeric ← bigint, vars, arrays
bigint ← sentinels (carrierF64's bigintStrict/bigintEraseErr)
numeric, pointers, bigint, sentinels, classify ← coerce
```
Build/commit order (leaf-first): tag → locals → pointers → classify →
control → numeric → bigint → vars → arrays → sentinels → coerce.

No cycle exists between any two new `src/ir/*` files, and none of ir.js's
own upstream imports (`ctx.js`, `layout.js`, `ast.js`, `reps.js`, `kind.js`,
`static.js`, `compile/active-function.js`, `compile/representation-plan.js`)
import anything from `ir.js` today (grep-verified, zero hits both
directions) — so fanning `ir.js` out into `src/ir/*` cannot introduce a
cycle with those either; each new file just imports the same upstream
modules ir.js already did, at one extra `../` of relative depth.
`resolveModuleGraph` (`src/resolve.js`) run against `bench/jz/jz.js` with
`resolveNode: true` after all moves land, to confirm empirically.

## Retirements considered (step 3, done as separate commits AFTER all pure
moves land — not bundled into the moves themselves)

- **`buildRefcount`'s hand-rolled `walk`** (control.js): unconditional
  descent with an early-return once a node's refcount exceeds 1 (memoized
  single-pass). Provably retireable onto `walkAst({enter})`: an `enter`
  callback that increments the count and returns `false` exactly when
  count>1 reproduces the early-return-prunes-children behavior exactly
  (`walkAst` treats `enter() === false` as "don't descend," matching `if (n
  > 1) return`); `walkAst`'s loop starts children at index 1 (skips the
  opcode slot) where the original started at 0, but the opcode slot is
  always a string or `null`, never an array, so `walk()`'s own `if
  (!Array.isArray(node)) return` makes that index-0 visit a no-op either
  way — byte-identical either form. Candidate for a follow-up commit.
- **`nextLocalId`'s hand-rolled `walk`** (control.js): unconditional full
  descent, no pruning, matching `walkAst({enter})` directly (enter never
  returns `false`). Same index-0-is-always-non-array argument. Candidate
  for a follow-up commit.
- **`verifyFn`** already calls `walkAst` — no work needed, already on the
  shared combinator.
- **`hasExpensiveOp`/`dataDependentFlag`** already call `some()` directly —
  no work needed.

Declined (not walker-shaped, hand-recursion is load-bearing, not a
stand-in for a missing shared combinator):
- `cloneIR` — a structural **transform** (returns a new tree), not a visit;
  `walkAst`/`some` have no "return a rebuilt tree" contract.
- `isPureIR` — recursive **AND-fold** short-circuiting at the ROOT first
  (`Array.isArray(n) && PURE_OPS.has(n[0]) && …`); `some`'s contract is an
  OR-fold over descendants. Forcing this through `some` needs De Morgan
  double-negation for no proven benefit — same class of reasoning
  `.work/analyze-traversals.md` already used to decline several
  structurally-similar cases.
- `f64Range`'s inner `r`/`narrowI32` — value-computing recursive transforms
  with per-op-kind arithmetic (returns `{lo,hi}`/`{node,maxAbs,faithful}`),
  not visit-and-continue walks.
- `toPrimitiveChain`, `toNumF64`, `toStrI64` — single-level dispatch over
  one `(node, v)` pair, no tree recursion at all.

## Dead-code sweep (step 4) — deferred to post-move grep pass

Not yet run (moves land first so grep is against the final file locations,
not shifting line numbers mid-sweep). Candidates flagged for verification
once files settle: `resolveValType`, `toBoolFromEmitted`, `litVal`,
`isNullLit`/`isUndefLit`/`isNullishLit`, `dispatchByPtrType`,
`buildRefcount` — each showed zero *internal* ir.js callers in the
dependency graph; whether they have real external callers (module/*,
optimize/*, compile/*) needs a grep pass against the settled tree, not the
mid-refactor one.

## Gate per commit

Each family-file commit: `node scripts/refactor-oracle.mjs check --ref
a5146de8` (140 specs × O0/O2/O3/size) + `node test/kernel-parity.js`
(33/33), both clean before moving to the next family. `bigint.js` and
`sentinels.js` additionally get `node test/pointers.js` standalone (the
box-tag-shaped BigInt pins) before their commit, given phase-c-unification's
explicit warning that this exact family decides self-host box-tag
constants.

## Status — what actually landed (updated post-execution)

All 11 families landed as 11 separate pure-move commits, leaf-first
(`068b3743`…`328df592`), each individually gated clean (oracle 560/560,
kernel-parity 33/33; `bigint.js`/`sentinels.js`/`coerce.js` additionally
`test/data.js` 171/171). Every member's text was diffed directly against a
fresh extraction from `a5146de8` before assembling its new file — zero
drift beyond a handful of orphaned `// === section ===` divider comments
(artifacts of earlier moves stripping away what used to sit between a
divider and the next surviving declaration), all tracked and swept.

Two real bugs were caught by the process, not the corpus: numeric.js
shipped once without `isLeaf` (§2 export list above expected it to be a
non-issue; the used-vs-imported symbol audit is now mandatory *before*
building each new file, not just after a test failure surfaces it) and a
regex-`lastIndex`-reuse bug in the scratch dependency-graph script produced
false negatives on the first pass (fixed before it drove any real
decision — see the session's own tool history, not committed since it's
throwaway tooling).

Barrel cleanup landed as `8998c700`: every `import {...}; export {...}`
pair collapsed to a single `export {...} from` once `src/ir.js`'s own body
reached zero declarations (nothing left to consume a local binding), the
~15 now-fully-unused top-of-file imports dropped, and 9 orphaned section
dividers swept (4 kept — still accurate in their new home). Exported-name
SET verified byte-identical before/after (116 names).

`buildRefcount`/`nextLocalId` retired onto `walkAst` in `93cfcf50`,
independently verified beyond the oracle's 140-spec corpus by a 1012-case
differential harness (deliberate shared-subtree aliasing, non-contiguous
ids, fuzz) — 0 mismatches. `isNullLit`/`isUndefLit` dropped from the
barrel's public re-export list in `8697e400` (grep-verified zero external
importers repo-wide; `package.json`'s own `exports` map already excludes
`src/` from the published subpath surface) — the underlying functions are
untouched, still used internally by `isNullishLit`.

Final battery (full detail in the session's closing report): native suite
excl. bench-c 3782/3781/0/1 (28044 assertions); kernel build succeeds
(17,787,829 bytes vs baseline 17,788,852 — a ~0.006% delta from the
self-compiled program's own module-graph gaining 11 files, i.e. jz's own
bundler now concatenates in a different file order, shifting some
LEB128-encoded function-index widths; not a behavior change — kernel-parity
and kernel-oracle both fully green against this exact binary); kernel-target
plain suite; kernel-parity 33/33; kernel-oracle 14/14 (605 assertions);
`bench-size.mjs --json` byte-identical to baseline; `test/pointers.js`
73/73 and `test/data.js` 171/171 standalone.
