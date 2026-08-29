# src/compile/index.js split (pipeline-minimality slice)

Base: `c520a39a` (this worktree, `refactor/compile-index-split`). `src/compile/index.js`
is 3,503 lines: the compile-SESSION driver — `compile()` (the default export, 1,195
lines, lines 2309-3503) is one orchestrator function threading `plan()`, per-function
analyze/emit, closure emission, and module-section assembly through a chain of
region-arena mark/exit pairs — plus ~30 top-level helper functions/consts `compile()`
(and each other) call, occupying lines 1-2308 ahead of it.

## Methodology

No automated dependency-graph script in the planning pass (unlike `ir-split.md`/
`prepare-split.md`'s throwaway scanners) — the file was read in full, sequentially,
across 4 reads (lines 1-900, 901-1800, 1801-2700, 2701-3503), then every call
relationship among its ~30 top-level declarations was traced by hand from that text
and cross-checked with targeted `grep -n` passes (exact line numbers for every
top-level `const `/`function `/`// ===` divider, confirmed against the sequential
read). During extraction, each new file was also checked with TypeScript's JS parser
for unresolved identifiers (`TS2304`) before it was wired into the driver. Every
family/edge below is a real call-site relationship verified this way, not inferred
from textual proximity — several are explicitly flagged below as "textual position
misleads" cases, the same pattern `program-facts-split.md` §1 catalogs for its own
file. External-consumer and dead-import claims are grep-verified (commands and results
in §Verified cross-checks), not carried over from prior docs without re-checking.

## External contract

Exactly one export, two importers, grep-verified (`grep -rn "^import .*compile/index\.js"`
across `src/ module/ jzify/ scripts/ test/ index.js interop.js` — a broader raw-string
grep for `"compile/index.js"` hits 51 files, but every one past these two is a *comment*
citing this file for attribution, e.g. "`compile/index.js`'s `_resultNumeric` boundary-wrap
gate" in `test/dyn-keys.js` — none is a real `import`):

| importer | imports |
|---|---|
| `scripts/self.js:20` | `compileAst` (default) |
| `index.js:58` (repo root) | `compile` (default) |

Confirmed via `grep -n "^export " src/compile/index.js`: the file has exactly ONE
`export` statement today (`export default function compile`). Every other top-level
declaration — all ~30 helpers below — is module-private. This means the split has
total freedom to relocate any helper; the only externally-visible contract to preserve
is `compile`'s own signature and behavior, byte-identical.

## Region-arena root-completeness rule + phase-timer seams — where they actually live, and why this split can't disturb them

The task brief's "file's own header" states the root-completeness rule inside
**`compile()`'s own JSDoc**, not the top-of-file module header. Read both:

- Top-of-file header (lines 3-28): general architecture orientation ("Stage
  contract" / "Core abstraction" / "Type system") — no region-arena content.
  Stays in `index.js` verbatim; still accurate once helpers fan out (the module's
  job description doesn't change).
- `compile()`'s own doc comment (lines 2232-2308, 77 lines) is where "THE RULE for
  every one of this function's SIX-plus nested mark/exit pairs" is spelled out
  verbatim, plus two named historical bugs from getting it wrong (front's round
  missing `ctx.core`, `__stdlibMark`'s `lateSchema` missing `ctx.schema.namedUses` —
  both documented in `.work/region-release-notes.md`'s "ROOT CAUSE FOUND" section).

**Decision: `compile()` does not move.** The entire ~1,195-line function — every
`mark()`/`exit()` pair, every root array (`[ast, programFacts, ctx.funcs, ctx.module,
...]` at lines 2470, 2541, 2685, 2752, 2876, 3042, 3499), the `emissionRoundExit`
closure (2605-2618) that bundles the `DOLLAR`/`stdlibParseCacheMap` extern hazard —
stays exactly where it is, in `src/compile/index.js`, completely untouched. This is
not a limitation forced by caution; it is the correct read of the family boundary:
`compile()` IS the "index" identity of this module (mirrors `src/compile/plan/index.js`
keeping `plan()` itself as its own default export while `plan()`'s 30-odd passes live
in sibling files — the task's own instruction not to duplicate or bypass that existing
structure). Root-completeness is a property of the SET of fields named in each
mark/exit pair, cross-checked against every read between that pair and the next mark
— splitting the function across files would force re-deriving that cross-check by
reading multiple files at once, exactly the risk the campaign's own history (§ above)
shows has twice produced real regressions. Not moving it makes root-completeness
survive by construction, not by care.

The phase-timer seams — every `timePhase(profiler, 'name', () => {...})` call site
(12 of them: `foldAggregates`, `plan`, `analyzeFuncs`, `structInline`, `unionInline`,
`unionClones`, `emitFuncs`, `emitClosures` (called from inside `compilePendingClosures`,
itself invoked from 3 sites), `buildStart`, `resolveDynFnTables`, `pullStdlib`,
`optimizeModule`) are ALL inside `compile()`'s own body — same reasoning, same
guarantee: untouched. `timePhase` itself (line 149, the tiny wrapper
`(profiler, name, fn) => profiler?.time ? ... : fn()`) has no callers anywhere in
this file except `compile()` — confirmed by reading every other top-level function's
body during the family trace below — so it stays defined in `index.js` too, right next
to its only consumer, rather than manufacturing a one-line family file for it. (The task brief's "`t(...)`" is shorthand for these phase-timer
call sites, not a literal abbreviated token in the source — grepped for a bare `t(`
call form and found none; every call site spells `timePhase(...)` in full.)

## The `specializeUnionCursorParams` lifecycle leftover (`.work/program-facts-split.md` §7)

`specializeUnionCursorParams` is **defined in `narrow.js`**, imported at this file's
line 55 (`import { specializeUnionCursorParams } from './narrow.js'`) — it is not
itself part of this split. What §7's freeze audit calls "lives in THIS file" is the
**call site**: the `unionClones` phase, entirely inline inside `compile()`'s own body
(lines 2563-2570):

```js
timePhase(profiler, 'unionClones', () => {
  for (const clone of specializeUnionCursorParams(programFacts)) {
    const facts = analyzeFuncForEmit(clone, programFacts)
    publishPlan(clone, facts)
    captureFuncInspect(clone, facts, programFacts)
  }
})
```

Per §7.1's fact-lifecycle table, this is `paramReps`'s **7th and last** producer,
and the ONLY one that runs after `plan()` has already returned (during EMIT, not
PLAN) — the freeze view `plan()` installs over `paramReps` for its own rounds 4-5 is
explicitly restored to the real, mutable `Map` before `plan()` returns specifically
so this call keeps working. **Disposition: unchanged, by construction.** `compile()`
is not moved (above), so this call site's location, its two callees now living in
different files (`analyzeFuncForEmit` → `analyze-for-emit.js`, `captureFuncInspect` →
`func-inspect.js`), and `publishPlan` (a `compile()`-local const at line 2479,
untouched) all resolve via ordinary import lines with zero behavior change — the
oracle/kernel-parity gates after the `analyze-for-emit.js`/`func-inspect.js` commits
are the direct proof.

**What a later slice must do** (recorded per the task's instruction, not attempted
here): §7.1 itself already states the real gap — `paramReps`'s lifecycle spans TWO
pipeline stages (PLAN, closed/frozen at round 3; EMIT, silently reopened by this one
call) and "one documented producer phase" holds only for PLAN's own contribution. A
future slice that wants to close this fully has two real options, neither free: (a)
move `specializeUnionCursorParams`'s invocation *inside* `plan()` itself — changes
`plan()`'s contract (it currently promises "returns programFacts, not further
mutated by anything downstream except this one exception"), and would need
`unionInline`'s registry (`analyzeUnionInline`, which itself runs from `compile()`
line 2556, after `plan()`) to also move inside `plan()`, or (b) give EMIT its own
second, symmetric freeze/thaw wrapper around `paramReps` (install a read-only view
after this call point, matching PLAN's own `{ get: k => paramReps.get(k) }` idiom
from §7.3) so that AFTER `specializeUnionCursorParams` runs, nothing else can write
`paramReps` for the rest of the compile — today nothing else does, but (per §7.2's
own conclusion) that is pass-ordering discipline, not a structural guarantee. Neither
option is a pure move; both are out of scope here.

## Inventory — every top-level declaration, verified line range, real family

`grep -n "^const \|^function \|^export default function\|^let \|^// ==="` against
the file, cross-checked against the sequential read for exact closing braces.

| decl | lines | family | note |
|---|---|---|---|
| `freshCseName` | 70 | analyze-for-emit | **textual-position-misleads**: sits mid-import-block (between two import groups, 66-70 then imports resume 71-99) — its only caller is `analyzeFuncForEmit` (line 668, `cseLoads(body, ..., freshCseName)`), 600 lines below |
| doc "Single-source export semantics" | 101-129 | func-exports | documents `isExported`+`exportNamesOf` exactly |
| `isExported` | 130-136 | func-exports | |
| `exportNamesOf` | 141-147 | func-exports | only caller is `compile()` itself (4 call sites in the late-export-facts loop, 2946-2972) — travels with `isExported` anyway (shared "export semantics" doc, shared theme) rather than staying orphaned in index.js |
| `timePhase` | 149 | **stays in index.js** | sole caller is `compile()` (11 call sites) |
| comments 151-158 | 151-158 | **stays in index.js** | general file-history orientation notes, still accurate, not anchored to any moved function |
| doc + `isBoundaryWrapped` | 160-187 | boundary-wrap | |
| doc + `buildInternTable` | 189-258 | intern-table | |
| `ensureThrowRuntime` | 260-276 | throw-runtime | |
| doc + `pruneUnusedThrowRuntime` | 278-348 | throw-runtime | 38-line doc block (278-315) documents the trap-lowering rationale for both throw-runtime functions jointly |
| `// === Module compilation ===` | 350 | **relocated** | everything it introduced (352-2230) moves out; repositioned to sit directly before `compile()`'s own doc comment (2232) — still accurate there, `compile()` IS the module-compilation driver |
| doc + `cloneRepMap` | 352-363 | analyze-for-emit | sole caller `analyzeFuncForEmit` (line 920) |
| doc + `repView` | 365-373 | func-inspect | sole caller `captureFuncInspect` |
| doc + `captureFuncInspect` | 375-420 | func-inspect | called from `compile()` (2 sites: 2528, 2567) |
| comment + `enterFunc` | 422-427 | func-entry | **cross-family leaf**: called by `analyzeFuncForEmit` (475), `emitFunc` (1415), `enterClosureFrame` (1910) — 3 different downstream families |
| comment + `emitPreboxedLocalInits` | 429-443 | func-entry | **cross-family leaf**: called by `emitFunc` (1619), `emitClosureBody` (2084) |
| `analyzeFuncForEmit` | 445-926 | analyze-for-emit | 482 lines, largest helper. Calls `enterFunc` (func-entry), `paramAllUsesNumeric`+`paramNeverString` (param-numeric), `cloneRepMap`+`freshCseName` (own family), plus ~20 external imports (analyze.js, analyze-scans.js, closure-plan.js, loop-*.js, representation-plan.js, typed-storage-plan.js, param-reps.js, reps.js, kind.js, type.js, ast.js) — all pre-existing, unchanged |
| `seedLocalIntConsts` | 928-976 | analyze-for-emit | sole caller `analyzeFuncForEmit` (line 671) |
| section doc | 978-996 | param-numeric | "Loop-invariant exported-param coercion hoist" — documents the whole param-numeric + coercion-hoist pair; the proving half's doc travels with param-numeric, coercion-hoist gets its own doc below |
| `NUM_BIN_OPS`, `REL_OPS`, `isStrLiteral` | 997-1005 | param-numeric | shared by `paramAllUsesNumeric` AND `paramNeverString` — real shared constants, not a textual-proximity artifact |
| doc + `paramAllUsesNumeric` | 1007-1220 | param-numeric | 190-line predicate. Called by `analyzeFuncForEmit` (658), `hoistInvariantParamCoercions` (coercion-hoist), `seedClosureFrame` (closure-emit) |
| `STRING_RECV_METHODS` | 1222-1230 | param-numeric | **dead-code candidate, flagged not deleted** (see §Findings below) |
| doc + `paramNeverString` | 1232-1317 | param-numeric | called by `analyzeFuncForEmit` (658) only |
| doc + `hoistInvariantParamCoercions` | 1319-1359 | coercion-hoist | calls `paramAllUsesNumeric` (param-numeric); sole caller `emitFunc` (1675) |
| doc + `hoistUnionCursorUnbox` | 1361-1397 | coercion-hoist | zero deps on param-numeric (reads `ctx.schema.inlineUnionCursors` only); sole caller `emitFunc` (1676) — bundled with `hoistInvariantParamCoercions` per its own doc comment ("Sibling of hoistInvariantParamCoercions"), same two back-to-back call sites |
| doc + `emitFunc` | 1399-1735 | emit-func | 331 lines. Calls `enterFunc`/`emitPreboxedLocalInits` (func-entry), `isBoundaryWrapped` (boundary-wrap), `hoistInvariantParamCoercions`+`hoistUnionCursorUnbox` (coercion-hoist), plus ~15 external imports (emit.js, ir.js, dyn-closure-tables.js, representation-plan.js) |
| doc + `synthesizeBoundaryWrappers` | 1737-1893 | boundary-wrap | filters on `isBoundaryWrapped` as its first line — real, direct edge, bundled together |
| comment (MapOverlay) | 1895-1898 | **stays in index.js** | orphaned once `normalizeClosureBody` moves, but retained so the pure family stack deletes no unrelated prose; a later dead-comment sweep may remove it |
| `normalizeClosureBody`, `closureSig`, `enterClosureFrame` | 1899-1913 | closure-emit | `enterClosureFrame` calls `closureSig` (same family) + `enterFunc` (func-entry) |
| doc + `seedClosureFrame` | 1915-1972 | closure-emit | calls `paramAllUsesNumeric` (param-numeric) — **note**: call site (line 1966) passes 5 args to `paramAllUsesNumeric`'s 4-param signature (`body, name, _seen, requireProof`); the 5th (`false`) is silently ignored by JS call semantics. Pre-existing in the source, carried byte-identical, not fixed here (out of scope — no behavior edit) |
| doc + `analyzeClosureBodyForEmit` | 1974-2048 | closure-emit | calls `normalizeClosureBody`/`enterClosureFrame`/`seedClosureFrame` (own family) |
| doc + `emitClosureBody` | 2050-2230 | closure-emit | calls `normalizeClosureBody` (own family), `emitPreboxedLocalInits` (func-entry) |
| doc + `compile` (default export) | 2232-3503 | **stays in index.js** | see §Region-arena rule above |

## Family plan

| # | new file | contents (original lines) | ~lines | depends on (new families) |
|---|---|---|---|---|
| 1 | `func-exports.js` | doc+`isExported`+`exportNamesOf` (101-147) | 46 | — (leaf: `ctx` only) |
| 2 | `func-entry.js` | `enterFunc`+`emitPreboxedLocalInits` (422-443) | 21 | — (leaf: `active-function.js`, `ir.js`) |
| 3 | `param-numeric.js` | `NUM_BIN_OPS`/`REL_OPS`/`isStrLiteral`/`paramAllUsesNumeric`/`STRING_RECV_METHODS`/`paramNeverString` (978-1317) | 330 | — (leaf: `ast.js`, `ctx.js`) |
| 4 | `throw-runtime.js` | `ensureThrowRuntime`+`pruneUnusedThrowRuntime` (260-348) | 88 | — (leaf: `ctx.js`) |
| 5 | `intern-table.js` | `buildInternTable` (189-258) | 70 | — (leaf: `static-data.js`, `ctx.js`) |
| 6 | `func-inspect.js` | `repView`+`captureFuncInspect` (365-420) | 55 | `func-exports.js` (`isExported`) |
| 7 | `boundary-wrap.js` | `isBoundaryWrapped`+`synthesizeBoundaryWrappers` (160-187, 1737-1893) | 185 | `func-exports.js` (`isExported`) |
| 8 | `coercion-hoist.js` | `hoistInvariantParamCoercions`+`hoistUnionCursorUnbox` (1319-1397) | 78 | `param-numeric.js` (`paramAllUsesNumeric`) |
| 9 | `analyze-for-emit.js` | `freshCseName`+`cloneRepMap`+`analyzeFuncForEmit`+`seedLocalIntConsts` (70, 352-363, 445-976) | 548 | `func-entry.js` (`enterFunc`), `param-numeric.js` (`paramAllUsesNumeric`/`paramNeverString`) |
| 10 | `emit-func.js` | `emitFunc` (1399-1735) | 337 | `func-entry.js`, `boundary-wrap.js` (`isBoundaryWrapped`), `coercion-hoist.js` |
| 11 | `closure-emit.js` | `normalizeClosureBody`+`closureSig`+`enterClosureFrame`+`seedClosureFrame`+`analyzeClosureBodyForEmit`+`emitClosureBody` (1899-2230) | 327 | `func-entry.js` (`emitPreboxedLocalInits`), `param-numeric.js` (`paramAllUsesNumeric`) |
| — | `index.js` (driver, stays) | header doc (3-28), imports (trimmed), `timePhase`+comments (149-158), relocated `// === Module compilation ===` divider, `compile()` (2232-3503) | ~1,400 | all 11 above, plus its pre-existing imports (`plan/index.js`, `analyze.js`, `wat/assemble.js`, `narrow.js`, `emit.js`, …) |

Total moved: ~2,085 lines across 11 new files. `index.js` shrinks from 3,503 to
~1,400 — dominated by `compile()` itself (1,195 lines), which stays one function
by design (§Region-arena rule).

## Dependency order (DAG, verified acyclic by hand-tracing every call site above)

```
func-exports, func-entry, param-numeric, throw-runtime, intern-table   (leaves)
func-exports        ← func-inspect, boundary-wrap
param-numeric        ← coercion-hoist
func-entry, param-numeric  ← analyze-for-emit
func-entry, boundary-wrap, coercion-hoist  ← emit-func
func-entry, param-numeric  ← closure-emit
[everything above] ← index.js (compile())
```

Landed build/commit order (leaf-first): func-exports → func-entry → param-numeric →
throw-runtime → intern-table → func-inspect → boundary-wrap → coercion-hoist →
analyze-for-emit → emit-func → closure-emit. There is deliberately no standalone
cleanup commit in this slice: retaining the driver's pre-existing direct imports keeps
its module-evaluation sequence intact, and deleting old dead bindings/comments is not
a family extraction. The `// === Module compilation ===` divider stays immediately
above the now-imported helper seam and `compile()`.

No family imports anything from `index.js` itself (`compile()` is a pure sink, never
a source for any of the 11 files — confirmed: none of the ~30 helpers call `compile`
recursively or reference anything defined only inside its body, since `emissionRoundExit`
and the other `compile()`-local consts are never referenced outside it). So every one
of the 11 extractions is a strict leaf-to-root move with zero forward references to
patch later.

## Findings (flagged, not acted on — out of scope for a pure-move slice)

- **`STRING_RECV_METHODS`** (param-numeric.js, original 1224-1230): its own doc
  comment (1232-1248, attached to `paramNeverString`) says the string-receiver-method
  check is one of the function's disqualifying cases, but `paramNeverString`'s actual
  body never references `STRING_RECV_METHODS` — every method call on the param is
  already rejected by the broader `.`/`?.`/`[]`-receiver-is-the-param rule (any member
  access on the tracked name is disqualifying, not just the ones in this specific
  set). Grep-confirmed zero references to the name anywhere in the file outside its
  own declaration. Left in place, carried verbatim into `param-numeric.js` — deletion
  is a step-3/4 concern (dead-code sweep), not this slice's.
- **`seedClosureFrame`'s 5-arg call to `paramAllUsesNumeric`** (original line 1966):
  pre-existing, the 5th argument is silently dropped by ordinary JS call semantics
  (the function only declares 4 params). Not a product of this split; carried
  byte-identical.

## Verified cross-checks (grep, not assumption)

- External consumers: `grep -rn "^import .*compile/index\.js"` across the whole repo
  → exactly `scripts/self.js:20` and `index.js:58`, both importing only the default
  export. The other 49 files matching a raw `"compile/index.js"` string search are
  all comments.
- `grep -n "^export "` on the file → exactly one line, the default export. Every
  helper is free to move.
- The 23 dead `../ir.js` import names `.work/dead-exports-sweep.md` flagged
  (`toI32, asI64, fromI64, NULL_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, isLit,
  litVal, isNullishLit, emitNum, isConst, isNullish, slotAddr, elemLoad, elemStore,
  arrayLoop, allocPtr, multiCount, loopTop, reconstructArgsWithSpreads,
  findBodyStart`) — re-verified against the original file with the import block
  itself (lines 74-90) excluded from the scan: all 23 show **zero** real uses.
  They remain in `index.js` in this slice. Removing them (and any imports made dead
  by these moves) is a separate dead-import sweep, not a family extraction; keeping
  the original direct module imports also preserves module-evaluation order exactly.
- `grep -rn "compile/index\.js" test/` — 20 hits across 11 files (`closures.js`,
  `dyn-keys.js`, `types.js`, `self-compile.js`, `kernel-parity.js`, `kernel-oracle.js`,
  `objects.js`, `parser-bugs.js`, `data.js`, `interop.js`, `optimizer.js`) — every one
  is a comment citing this file for attribution (e.g. "compile/index.js's jz:schema
  writer"), none is a hardcoded source-scan path. No existing test needed a path
  update; the landed slice adds a new ownership pin in `test/invariants.js`.
  Separately checked for line-count/size assertions (`grep "3503\|3,503"`)
  and `readFileSync`/`readdirSync` calls naming `compile` — the only hits are
  `node_modules/watr/src/compile.js` (an unrelated third-party file) and generic
  "compiles"/"self-compile" wording. Nothing to add.
- `resolveModuleGraph` is import-graph-based (confirmed by `ir-split.md`'s own
  precedent and this repo's `src/resolve.js`), not a hardcoded file manifest — new
  files need no separate registration anywhere, only correct `import`/`export` lines.

## Gate per commit

Each takeover family-file commit was checked before commit against its immediate
predecessor: syntax + dynamic import, self-compile module-graph cycle resolution,
`node scripts/refactor-oracle.mjs check --ref HEAD` (560/560 byte-identical), and
`node test/kernel-parity.js` (33/33 byte-identical WAT). The inherited first three
commits predate the takeover; their surviving log proves the combined range
`c520a39a..42a8d974` clean at 560/560.

## Landed record

| commit | module | exported seam | index.js after |
|---|---|---|---:|
| `e85f7bb3` | `func-exports.js` | `isExported`, `exportNamesOf` | 3,456 |
| `471d20ce` | `func-entry.js` | `enterFunc`, `emitPreboxedLocalInits` | 3,434 |
| `42a8d974` | `param-numeric.js` | `paramAllUsesNumeric`, `paramNeverString` | 3,094 |
| `41ac464f` | `throw-runtime.js` | `ensureThrowRuntime`, `pruneUnusedThrowRuntime` | 3,006 |
| `5297f2a1` | `intern-table.js` | `buildInternTable` | 2,937 |
| `3f4b51db` | `func-inspect.js` | `captureFuncInspect` | 2,882 |
| `fafae4fc` | `boundary-wrap.js` | `isBoundaryWrapped`, `synthesizeBoundaryWrappers` | 2,698 |
| `8b78646e` | `coercion-hoist.js` | `hoistInvariantParamCoercions`, `hoistUnionCursorUnbox` | 2,618 |
| `50a5b6e2` | `analyze-for-emit.js` | `analyzeFuncForEmit` | 2,070 |
| `8e6fe908` | `emit-func.js` | `emitFunc` | 1,734 |
| `34673384` | `closure-emit.js` | `analyzeClosureBodyForEmit`, `emitClosureBody` | 1,403 |

`index.js`: 3,503 → 1,403 lines, down 2,100 (60.0%). Its only top-level
declarations now are `timePhase` and the default-exported `compile()`. A direct
substring comparison against `c520a39a` proves the complete `compile()` JSDoc/body
(77,087 bytes), including every root bundle and all 12 phase-timer seams,
byte-identical. `test/invariants.js` pins every moved top-level declaration to exactly
one family owner and verifies the driver imports every family.

No planned family remains. The residual 1,403-line driver is intentionally the
root-complete `compile()` orchestration plus imports/header. Future work is limited to
separate concerns: a grep-proven dead-import/comment sweep, or the non-pure
`specializeUnionCursorParams` lifecycle closure described above.
