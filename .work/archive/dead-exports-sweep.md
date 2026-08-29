# Dead-exports sweep — ledger

Branch `refactor/dead-exports-sweep`, base `33aafd82`. Method: a small
uncommitted script pair (not part of this repo — built and run from the
worktree, not checked in) cross-referenced every `export` in scope against
(a) static `import`/`import type *`/re-export graphs built with the
`typescript` package's parser, (b) a repo-wide `rg -n -w -F <name>` textual
grep as a fallback for dynamic references (`await import(...)` destructuring,
WAT template strings, string-matched build markers, comments/docs), and (c)
a same-file self-usage grep to distinguish "nobody imports this" from
"nobody uses this at all." Every deletion below was verified against all
three before acting, plus a final `git grep -w <name> 9da6a37c` against
main's current tip (see Scope note at the end — main advanced during this
sweep; merge not performed here, see report).

## Summary

37 commits, 31 files touched, +52/−256 lines.
- 1 whole dead file deleted: `src/ops.js` (118 lines — zero importers of
  any of its 5 exports anywhere in the repo).
- 8 dead functions/constants deleted outright (zero callers anywhere,
  including their own file): `computeAliasGuards` + 4 orphaned imports
  (cost-model.js), `BINDING_USE_CALLEE`/`BINDING_USE_ARG_INDEX`
  (analyze-scans.js), `withFlowBlocked` (flow-state.js), `compileProfile`
  (self.js — see kernel-export note below), `isSeq` (ast.js), `isKind` +
  its orphaned `KIND_UNIVERSE_SET` (reps.js), the vestigial
  `export { typeofPredicate }` re-export + stale comment (infer.js), the
  vestigial `export { getFactStore }` re-export (session.js).
- 46 exports demoted (kept the code, dropped the `export` keyword —
  used only within their own file): see per-commit list below.
- 34 unused named imports dropped across 11 files (module/array.js×9,
  function.js×1, json.js×3, object.js×2, symbol.js×2, timer.js×2,
  bench-self-compile.mjs×2, emit-assign.js×3, infer.js×1, plus the 3 that
  came along with dead-function deletions in cost-model.js).

Every commit is individually `node scripts/refactor-oracle.mjs check --ref
33aafd82` clean (140 specs × O0/O2/O3/size = 560 rows, run after each
commit or small batch — see report for the running log). No registration
order, manifest order, or Map/Set iteration order was touched — every change
is either a whole unreached file, a function/const with zero readers, or an
`export` keyword removed from a binding whose only readers are in the same
file (removing `export` cannot change iteration order — it only changes
what's importable).

## One caught mistake (left in for the record)

Mid-sweep, the unused-imports batch for `module/typedarray.js` briefly
removed `undefExpr` from its `ir.js` import — that name was NOT on the
verified unused-imports list (typedarray.js never appeared in that scan's
output at all); it was copied in by hand-transcription error while batching
ten files' edits in one turn. `node scripts/refactor-oracle.mjs check`
caught it immediately (`watr:watr.js` O3/size legs: "internal: undefExpr is
not defined"). Reverted before committing; the file has zero net diff in
this sweep. Cross-checked every other removed name in that batch
programmatically against the verified list afterward — all 25 others were
correct. Lesson: batch `git diff` review against the verified candidate
list before committing, not just before editing.

## Deletions and demotions, by commit

Whole file:
- `src/ops.js` — dead (integer-tagged-union op seed, parked dormant since
  610ba822; flagged unresolved in `.work/archive/pipeline-minimality.md`'s M1c side
  findings, resolved here). Proof: no `from '.../ops.js'` anywhere; `OP`,
  `OPS`, `OP_COUNT`, `opStr`, `internOps` all zero references outside the
  file.

Fully dead (deleted, not just demoted):
- `cost-model.js: computeAliasGuards` — the doc comment's aspirational
  "shared verbatim by tryVectorize and tryStencil" helper; both callers
  actually carry their own independent inline alias-guard computation
  instead (map.js:537-573, stencil.js:614-647). Deleting it orphaned
  `cloneNode`/`nodeEqual`/`normTee`/`LANE_INFO` imports — dropped too;
  `gmNodeCount` stays (map.js/stencil.js import it directly).
- `analyze-scans.js: BINDING_USE_CALLEE, BINDING_USE_ARG_INDEX` — two
  unused members of an otherwise-live tag enum; `SIMPLE_USE`'s
  `Array.from({length:13})` doesn't depend on the names.
- `flow-state.js: withFlowBlocked` — one of eleven `withFunctionField`
  wrappers; the other ten are live, this one has zero callers.
- `self.js: compileProfile` — see "Kernel-export note" below.
- `ast.js: isSeq` — zero callers anywhere, including this file.
  early-errors.js's `const isSeq = n => isNode(n) && n[0]===';'` is an
  unrelated LOCAL redeclaration (its only import from ast.js is
  `{ ASSIGN_OPS }`), not a consumer — a name collision, not a use.
- `reps.js: isKind` (+ orphaned `KIND_UNIVERSE_SET`) — `rg -n "\bisKind\("`
  across the whole repo matches nothing; emit.js's `const isKind =
  ptrTypeEq(...)` at line 518 is an unrelated local shadow (its reps.js
  import list is `VAL, lookupValType, repOf, updateRep, repOfGlobal` only).
  `KIND_UNIVERSE` (the frozen array) stays — still exported and used
  elsewhere.
- `infer.js: export { typeofPredicate }` — the re-export's own comment
  claimed it kept "existing importers of infer.js" working; none of the
  four real importers of infer.js (prepare/index.js, compile/index.js,
  narrow.js, plan/scope.js) import that name — they all now get it from
  ast.js directly. infer.js's own internal use (line ~253) keeps the
  import; only the re-export + stale comment are gone.
- `session.js: export { getFactStore }` — zero importers (every real
  importer of session.js pulls other names) and zero internal calls
  (`getFactStore(` matches nothing in the file — the three textual hits
  were comments). Trimmed `getFactStore` off the ctx.js import list too;
  every real consumer already imports it directly from ctx.js.

Demoted (export → internal, code unchanged):
- `abi/index.js`: CARRIERS, resolveCarrier
- `ast.js`: spreadArgs
- `autoload.js`: MOD_ALIAS, runtimeCtorKind, PROP_MODULES, OP_MODULES,
  CALL_MODULES, GENERIC_METHOD_MODULES, TYPED_CTORS (7 total —
  `RESOLVED_PROP_MODULES` stays: `test/self-compile-includes.js:134` reaches
  it via `await import('../src/autoload.js')`, a dynamic import static
  analysis alone would have missed)
- `flow-types.js`: TYPEOF_CODE_TO_VAL (was a standalone `export {}` line,
  deleted outright), instanceofRefinement, predicateRefinement
- `infer.js`: registerEvidence
- `plan/common.js`: SCALAR_TYPED_COERCE, isFreshTypedArrayAlloc
- `typed-storage-plan.js`: typedStoragePlanOf
- `front.js`: rejectReservedPrefix
- `helper-counters.js`: helperCounterName
- `kind-traits.js`: STRING_METHODS, NUMBER_METHODS, BOOL_METHODS,
  CALLEE_VAL (4 total)
- `typed-provenance.js`: TYPED_FAMILY_CTORS, stripTypedView, isTypedArrayCtor
- `param-reps.js`: REP_SET_FIELDS
- `static.js`: nameShift
- `string.js` (module/): MAX_SSO
- `perf-corpus.mjs`: mkRng (test/pow-ulp.js and test/fuzz.js each declare
  their OWN unrelated local `mkRng` — collision, not a use)
- `wat-probe.mjs`: call

Unused imports dropped (no behavior change possible — a name never read
after its import line):
- `array.js`: NULL_NAN, multiCount, elemLoad, throwTypeErrorIR, cloneIR
  (ir.js); refsName, REFS_IN_EXPR (ast.js); DBG_INVARIANTS (ctx.js); idxF64
  (array/callback.js)
- `function.js`: asI32 (ir.js)
- `json.js`: extractF64Bits (ir.js), T (ast.js), strHashLiteral
  (collection.js)
- `object.js`: isUndef (ir.js), updateRep (reps.js)
- `symbol.js`: typed, asF64 (ir.js)
- `timer.js`: temp, PTR (ir.js/ctx.js)
- `bench-self-compile.mjs`: writeFileSync, mkdirSync (node:fs)
- `emit-assign.js`: ptrTypeEq, boolBoxIR (ir.js), emitIdentitySafe
  (bridge.js)
- `infer.js`: typedElemCtor (type.js)

## Kernel-export note (self.js: compileProfile)

`scripts/self.js` is not imported as a JS module — `npm run build` feeds it
to jz's OWN compiler as source text to become `dist/jz.wasm` (its own
file-header comment: "the exact form compiled to wasm for self-compiling").
Its top-level `export function`s become the compiled kernel's WASM exports
(compileSelf, compileWat, compileWarnings, compileDiag — all with real
callers in test/kernel-*.js or src/ctx.js/front.js comments — plus the now-
deleted compileProfile, which had none). Deleting it is the one change in
this sweep that can shrink `dist/jz.wasm`'s own export table; it does not
touch what `compile()` produces for any OTHER program, so it's outside the
refactor oracle's corpus and is reported separately as a kernel-bytes delta
in the battery, not folded into "byte-identical."

## Barrel-only candidates (NOTED, NOT acted on — task item 4)

Exports whose underlying file has zero direct importers, reached only
through a barrel `export { x } from './y.js'` created by one of the ten
module splits, where the *barrel's* re-exported name ALSO has zero
importers (so the value is live only if something imports it through the
barrel, which nothing currently does):

- `analyze/body-facts.js: resetBodyFactsCache, invalidateLocalsCache` →
  barrel `src/compile/analyze.js`
- `program-facts/freeze.js: FACT_KEYS` → barrel `src/compile/program-facts.js`
- `representation-plan/materialize.js: representationBoundaryOf` → barrel
  `src/compile/representation-plan.js`
- `optimize/globals.js: STABLE_PTR_VALS` → barrel `src/optimize/index.js`
- `optimize/pure-funcs.js: foldStrDispatchF64` → barrel
  `src/optimize/index.js` (heavily discussed in test/driver.js comments —
  audit history, not a current call; read those before acting)
- `type/int-certain.js: intExprChecker` → barrel `src/type.js`
- `type/loop-versioning.js: affineIdxOfIV, bodyAffineEnv` → barrel
  `src/type.js`

None of these were deleted or demoted — a barrel re-export is a deliberate
public-surface decision from the split that created it, not obviously this
sweep's call, and "nobody imports the barrel's copy of the name" needs the
splitting session's context to judge safely.

**Methodology caveat, found and corrected during this sweep**: the barrel
detector only follows ONE re-export hop. Two names that LOOKED like this
same pattern turned out to be live through a SECOND hop and were dropped
from the list above after verification: `vectorize/inline-pure.js:
inlinePureFnsInFn` and `vectorize/lane-tables.js: SIMD_PINNED` both flow
`file → vectorize.js (hop 1) → optimize/index.js (hop 2) → real caller`
(optimize-module.js and watr-tail.js respectively, both importing from
`optimize/index.js`, not from the hop-1 barrel). Anyone extending this
sweep should re-verify multi-hop barrel chains before trusting a
single-hop "zero importers" verdict — `git grep -n "from '.*/optimize/index.js'"`-style
checks one hop up from each candidate's barrel is the fix.

## Held-file findings (NOT touched — files listed as another session's
in-flight work; left for their owner)

Dead-or-underused exports (zero importers by the same method above):
- `jzify/hoist-vars.js`: hoistPattern (self-used, zero external refs —
  export-drop candidate)
- `module/collection.js`: dynPropsFilterMissIR (zero external refs,
  export-drop candidate), numHashLiteral/LANE/collectionStride (all have
  real external refs — LANE and collectionStride are genuinely imported by
  `module/collection/upsert.js`; not dead, just re-verify before acting)
- `src/compile/emit.js`: emitTypeofCmp, toBool, materializeMulti,
  emitLoopFreshBoxed, emitDecl — all show self-use only (no external
  importer), export-drop candidates once the file is unheld

Unused named imports (43 across the held files, largest concentration in
`src/compile/index.js` — 23 unused names from `../ir.js` alone at its line
73 import):
- `jzify/arguments.js:7` prependDecls (./hoist-vars.js)
- `jzify/transform.js:6` paramList (../src/ast.js)
- `module/collection.js:15` asI32, extractF64Bits (../src/ir.js)
- `module/core.js:20,23,26` updateRep (../src/reps.js), STR_INTERN_BIT
  (../layout.js), SET_ENTRY (./collection.js)
- `src/compile/emit.js:45,52,54` scanBoundedLoops, inBoundsArrIdx
  (../type.js); shapeOf (../kind.js); NULL_IR, ptrTypeIR, needsDynShadow,
  boxedAddr, isFuncRef (../ir.js)
- `src/compile/index.js:71,73` emitVoid (./emit.js); toI32, asI64, fromI64,
  NULL_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, isLit, litVal,
  isNullishLit, emitNum, isConst, isNullish, slotAddr, elemLoad, elemStore,
  arrayLoop, allocPtr, multiCount, loopTop, reconstructArgsWithSpreads,
  findBodyStart (all ../ir.js)
- `src/compile/narrow.js:23` staticObjectProps (../static.js)
- `src/prepare/index.js:44,49` REJECT_OPS (../op-policy.js);
  includeForKnownKeyIteration, includeForRuntimeKeyIteration (../autoload.js)

## Explicitly reviewed and left alone (confirmed live or too risky)

- `scripts/refactor-oracle.mjs` — this task's own gate tool. Several exports
  (snapshotRoot, compareSnapshots, buildCorpus, loadRoot, parseLevel) show
  zero importers by the same method, but the file was excluded from action
  entirely on outsized-risk grounds (it is the oracle this whole sweep
  depends on) rather than investigated further.
- `scripts/self.js: REGION_HOOKS_ACTIVE` — LOOKS like a normal export-drop
  candidate (self-used only) but is NOT: `scripts/build-profile.mjs:172` and
  `test/self-compile-source.js:93-95` both literal-string-match the exact
  substring `export const REGION_HOOKS_ACTIVE = <bool>` in self.js's own
  source text (`graph.code.includes('export const REGION_HOOKS_ACTIVE =
  true')`). Dropping the keyword would silently break both. Exactly the
  "a name referenced only from template/source text is LIVE" case the task
  called out for WAT strings — same principle, a different string-matching
  consumer.
- `src/abi/{index,number,object,string,array}.js` carrier family
  (nanboxF64, sso, jsstring, tagged, taggedLinear, packedI32, structInline)
  — each carrier file has BOTH a named `export const X = {...}` AND a
  separate `export default X` for the same binding; abi/index.js consumes
  the DEFAULT import (`import nanboxF64 from './number.js'`) and re-exports
  it via a bare `export { nanboxF64, sso, jsstring, tagged, packedI32,
  taggedLinear, structInline }` (import-then-export split form, not the
  `export {x} from 'y'` shorthand my barrel detector recognizes). The named
  form in each carrier file plausibly has zero real named-importers, but
  untangling named-vs-default-export redundancy across a 5-file barrel this
  detector doesn't fully model was judged too risky for the value (a few
  dropped keywords) — left alone.
- The `scanFlatObjects`/`scanSliceViews`/`scanNeverGrown` trio in
  `analyze-scans.js` — zero current callers (superseded by the fused
  `scanObjectArrayFacts`, confirmed by `rg -n "scanFlatObjects\("` etc.
  matching only their own declarations), but the file says outright: "they
  stay exported for any other caller / direct test coverage" (line ~701).
  Deliberate kept-dormant API, not oversight — left alone on the author's
  explicit word.
- `index.js`, `interop.js` — package entry points (`package.json`
  `"exports"`, `index.d.ts`/`interop.d.ts`, STABILITY.md). Every "zero
  importer" hit here (`jz`, `compileModule`, `instantiate`,
  `_setCompileTarget`, `FALSE_NAN`, `TRUE_NAN`, `ptr`, `offset`, `type`,
  `aux`, `wrap`) is the public API surface, consumed by external npm
  package users this repo's own import graph can't see. None touched.

## Scope note

Main advanced to `9da6a37c` mid-sweep (a separate session's commit,
touching 13 in-scope files: the originally-held ones plus
`scripts/bench-readme.mjs`, `scripts/bench-svg.mjs`, and new
`scripts/porffor-core-adapter.mjs`). `git merge` into this branch was
blocked by the session's permission classifier — not something to route
around from here (see report). This branch stays based on `33aafd82`; none
of its 37 commits touch any of those 13 files, so a future merge/rebase
onto `9da6a37c` should be conflict-free. Every candidate whose liveness
could plausibly depend on those 13 files' new content was re-verified by
reading the actual current content directly (main's checkout, read-only)
rather than relying on the stale pre-merge snapshot — see report for the
specific re-checks (`RESOLVED_PROP_MODULES`'s dynamic import in
test/self-compile-includes.js, `REGION_HOOKS_ACTIVE`'s string-match
consumers, etc.).
