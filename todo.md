# jz inference consolidation — full backlog

Source: full inventory dated 2026-05-14. Items grouped by track, ordered by
"cheap-first → architectural-last" within each track. Each item carries:
- **Goal** (one line, what done looks like)
- **Touches** (files + key line refs)
- **Risk** (what to watch for)
- **Verify** (acceptance criterion)

Status keys: `[ ]` open · `[~]` in progress · `[x]` done · `[/]` cancelled (with reason)

## Cheap wins — direct value, low risk

- [x] **C1. Decide `intCertain` — wire a consumer or delete the pass**
  Outcome: pass is load-bearing. Two real consumers found —
  [src/ir.js:358](src/ir.js#L358) `toNumF64` (skips `__to_num` wrapper) and
  [module/math.js:28,84](module/math.js#L28) (Math.floor/ceil/trunc/round
  short-circuit to `asF64(emit(a))` on integer-valued args). Updated the stale
  doc at [src/analyze.js:1513-1518](src/analyze.js#L1513-L1518) to name both
  consumers. Extracted `isIntCertain(a)` predicate in math.js so `fInt` and
  `math.round` share it (was inline-duplicated).
  Verify: 1598/1598 jz + 580/580 watr green.

- [x] **A1. Move call-site fact extractors into infer.js**
  Outcome: five `inferArg*` extractors moved from analyze.js to a new
  "Call-site argument inference" section at the bottom of src/infer.js,
  paired conceptually with the body-walk evidence registry. analyze.js shed
  ~85 LOC (left a 3-line crossref comment). narrow.js imports them from
  infer.js; analyze.js still owns the helpers they call (`valTypeOf`,
  `staticObjectProps`, `typedElemCtor`, `ctorFromElemAux`) — infer.js
  imports those plus `ctx`. Updated the narrow.js:691 comment that claimed
  these helpers "live in analyze.js".
  Verify: 1598/1598 jz + 580/580 watr green.

- [x] **A2. Move `mergeParamFact` / `ensureParamRep` lattice primitives**
  Outcome: three of four paramReps primitives (`mergeParamFact`,
  `ensureParamRep`, `clearStickyNull`) moved to a new "paramReps lattice
  primitives" section near the top of src/infer.js with a docstring naming
  the sticky-null semantics. `callerParamFactMap` stayed in analyze.js —
  `narrowReturnArrayElems` (also in analyze.js) consumes it, so moving it
  would invert the import direction. analyze.js carries a one-line
  crossref. narrow.js' import block now lists three names from infer.js
  and one (`callerParamFactMap`) from analyze.js.
  Verify: 1598/1598 jz + 580/580 watr green.

- [x] **C3. De-duplicate global value-fact passes**
  Outcome: empirically confirmed prepare's depth-0 catch is a strict
  superset of plan.js' `scanGlobalValueFacts` (disabling the latter left
  1598 + 580 tests green). Moved the atomic helper to
  [src/infer.js `recordGlobalValueFact`](src/infer.js) under a new
  "Module-global value-fact recording" section. Deleted the prepare-local
  copy (imports from infer.js instead). Deleted plan.js' walker entirely;
  the call site in `plan(ast)` and the corresponding pipeline doc comment
  updated to reflect the single source of truth.
  Verify: 1598/1598 jz + 580/580 watr green.

- [x] **A4. Unify typeof predicate detection**
  Outcome: single `typeofPredicate(node)` helper in src/infer.js returns
  `{name, code, eq} | null`. `code` is either the raw type string
  ('string'|'number'|…) or prepare-normalized typeof code (-1|-2|…), so
  callers stop caring about the normalization boundary; `eq` is true for
  `==`/`===` and false for `!=`/`!==`. notStringEvidence collapsed from a
  10-line manual match to 1 helper call (ignores `eq` — any
  typeof-string predicate disqualifies). extractRefinements collapsed
  similarly and preserves the sense-flipping `wantPositive` logic via the
  `eq` flag.
  Verify: 1598/1598 jz + 580/580 watr green.

- [x] **D5. Delete the leftover `// === Param-shape inference ===` block stub**
  Outcome: the 3-line doc-only block at analyze.js (formerly line 1176)
  pointing at infer.js and referencing a stale name (`inferParamShapes`)
  was deleted. analyze.js still carries crossref comments next to the
  primitives that moved (`paramReps lattice` block at line 156, `inferArg*`
  block at line 703), which retain the trace for code-readers without
  pretending to define anything.
  Verify: 1598/1598 jz + 580/580 watr green.

- [x] **D2. Inline `analyzeLocals` one-line facade**
  Outcome: facade deleted. The four real call sites (two in narrow.js, two
  in compile.js) now use `analyzeBody(body).locals` directly; the import
  blocks were updated, and the test/types.js test-helper that consumed it
  was updated too. analyze.js top-level pass-list doc dropped the
  analyzeLocals line. Inline comments deeper in analyze.js that mention
  "analyzeLocals" as a concept were left — they refer to the
  locals-extraction slice abstractly, not to the facade.
  Verify: 1598/1598 jz + 580/580 watr green.

## Medium — measurable perf/size impact

- [x] **B4. `notString` consumer at `.length` reads**
  Outcome: `emitLengthAccess(va, vt, notString)` in module/core.js takes a
  new `notString` flag from the call site's rep lookup. When vt is null
  (untyped) AND `rep.notString === true`, emit a direct `__len` call
  instead of polymorphic `__length`. Both `.` and `?.` length sites pass
  the flag. Probe: `(xs, v) => { for…xs[i]=v; return xs.length }` emits
  zero `$__length` references (was 2); `(xs) => xs.length` (read-only)
  still routes through `$__length`. .byteLength was left as-is — its
  fallback already monomorphizes by known ctor; the residual polymorphic
  path is rare.
  Verify: 1598/1598 jz + 580/580 watr green.

- [x] **B3. Flow-typed `notString` after typeof-string early return**
  Outcome: `ctx.func.refinements` value shape widened from `Map<name, VAL>`
  to `Map<name, {val?: VAL, notString?: true}>`, unifying flow-scoped
  narrowing under one channel. extractRefinements emits `{notString: true}`
  for the negative branch of typeof-string predicates via the same
  `typeofPredicate` helper introduced in A4. emitBody's post-terminator
  loop merges new facts onto prior state so sibling early-returns compose.
  New `lookupNotString(name)` helper in analyze.js overlays the flow fact
  on top of rep.notString (mirrors lookupValType's precedence chain). B4's
  three call sites (module/core.js `.length`/`?.length`, module/array.js
  subscript dispatch) now consult it. Pure-narrowing probe (no write
  evidence): `(node) => { if (typeof node === 'string') return 0; return
  node.length }` emits **zero** `$__length` polymorphic calls (was 2),
  going direct to `$__len`.
  Verify: 1598/1598 jz + 580/580 watr green.

- [x] **B6. Assignment-flow evidence source (rung 5)** — *already working*
  Outcome: empirically confirmed. `analyzeValTypes` (analyze.js:1363) already
  handles `op === '='` with `setVal(name, valTypeOf(rhs))`, and `valTypeOf`
  on a string name reads `lookupValType` → the rhs binding's rep. So
  `x = arr` where arr is a known ARRAY propagates VAL.ARRAY to x; `let x = []; x = ''`
  is correctly poisoned via `valPoison`. Method evidence already descends
  into inner arrows (infer.js:228-241 scope handling), and capture
  propagation runs via captureValTypes — so `let r = []; visit(n) => r.push(n)`
  already infers r as ARRAY.
  Direct measurement on canonical workload — watr/src/parse.js:
    `__length=0 __ptr_type=0 __to_num=0 __add=0` (4 residual `__len` are
    direct typed reads, not polymorphic).
  util.js has 3 `__length` + 4 `__to_num` residuals, but those are
  *cross-call param-ABI* issues (s.length where `s` is a param the caller
  passes as a string literal — needs paramReps lattice convergence on val,
  not body-walk evidence). Different concern; B6 wouldn't touch them.
  Adding a parallel registry source would double-implement analyzeValTypes'
  poisoning logic. Deferred until a concrete missed-inference case surfaces
  that isn't covered by analyzeValTypes' `=` walk.
  Verify: 1598/1598 jz + 580/580 watr green (no change).

- [x] **B5. Literal-use evidence source (rung 1)** — *already working*
  Outcome: same conclusion as B6 — `let x = 0` / `let s = ''` /
  `let xs = []` is handled by analyzeValTypes' `op === 'let'/'const'`
  branch (analyze.js:1307). The fact reaches `ctx.func.repByLocal[x].val`
  before any consumer reads it, since analyzeValTypes runs as part of
  `inferLocals` and consumers run after. The original framing —
  "Today this happens implicitly in `analyzeValTypes`; lifting it to the
  registry unblocks B6" — assumed B6 needed a registry-only design. Since
  B6 is already working via analyzeValTypes, B5's lift offers no marginal
  value. analyzeValTypes also carries richer handling (regex tracking,
  typed-elem tracking, JSON-shape, arr-elem schema, ternary unification)
  that a `literalUse` source would either duplicate or have to import
  from analyze.js. Co-locating literal handling with the body-wide
  ctx-mutating pass is defensible.
  Verify: 1598/1598 jz + 580/580 watr green (no change).

## Architectural — deeper refactors

- [/] **B1. `instanceof` refinement in extractRefinements** — *deferred (needs IR support)*
  Status: extractRefinements has no `instanceof` op to branch on. jzify
  ([src/jzify.js:569-575](src/jzify.js#L569)) lowers `x instanceof Map/Set/Date/RegExp`
  to the weak `typeof t === 'object'` check, discarding the constructor
  identity before IR. Refinement to VAL.MAP/SET would require either:
  (a) preserving instanceof as a new IR op + emit handler that produces
  `__ptr_type(x) === PTR.MAP/SET`, then extending extractRefinements; or
  (b) adding `__is_map`/`__is_set` builtins that jzify recognizes.
  PTR.DATE / PTR.REGEX don't exist in the enum so Date/RegExp can't pin
  down even with the IR-op approach. Deferred until a real user need
  shows up — currently the only refinable case (`instanceof Array`)
  already routes through `Array.isArray` at jzify, picked up by the
  existing extractRefinements branch.

- [x] **B2. `Array.isArray` post-terminator narrowing** — *already working*
  Outcome: probe confirms `if (!Array.isArray(node)) return; node.length`
  emits zero polymorphic dispatch (`$__length` = 0, `$__ptr_type` = 0,
  even `$__len` = 0 — the VAL.ARRAY refinement reaches deeper than B4's
  notString path and folds to a direct header-offset memory read).
  The todo's framing ("only typeof-style guards get this treatment") was
  inaccurate: post-terminator calls `extractRefinements(s[1], …, false)`,
  the `!` branch flips sense to true, and the `Array.isArray` branch
  fires under positive sense, refining via the same map. No code change
  needed — the wiring was implicit in the recursive sense-flip + the
  shared post-terminator path.
  Verify: 1598/1598 jz + 580/580 watr green (no change).

- [/] **A3. Move JSON-shape inference into infer.js** — *deferred (would invert import direction)*
  Status: `valTypeOf` (analyze.js:293) calls `shapeOf` for `JSON.parse` chain
  propagation; infer.js already imports `valTypeOf` from analyze.js. Moving
  `shapeOf` to infer.js would create a circular import. The viable options
  are: (a) extract `shapeOf` + `staticPropertyKey` + `staticObjectProps`
  to a third `static.js` module both analyze.js and infer.js import from,
  or (b) half-move (staticObjectProps only — used by infer.js'
  inferSchemaId — keeping shapeOf in analyze.js). Neither delivers enough
  user value to justify the churn given the principle "minimal canonical
  software." Co-locating JSON-shape with analyze.js' valTypeOf is
  defensible — it's shape-aware static evaluation, not param-fact
  narrowing. Deferred until a concrete need surfaces.

- [x] **C4. Factor `schemaIdOfReturn` / `inferArgSchema` shared core**
  Outcome: single `inferSchemaId(expr, lookupMap)` in src/infer.js. Strict
  superset of both: handles name-lookup, ctx.schema.vars, `{}` literal,
  OBJECT-narrowed call result (`f.valResult === OBJECT && f.sig.ptrAux`),
  and recursive `?:`/`&&`/`||` agreement. Call-site D-phase rule now uses
  it; the early branches that depend on phase-F-seeded valResult are
  inert at D-iter-1 and strictly accretive after that. narrow.js'
  schemaIdOfReturn closure deleted entirely (33 LOC); two call sites
  swapped to inferSchemaId. inferArgSchema alias also dropped — single
  canonical name everywhere.
  Verify: 1598/1598 jz + 580/580 watr green.

- [x] **C2. Reconcile `boxed` / `intLikely` / `nullable` rep fields**
  Outcome: speculative "Future (S2 stage 4 follow-ups): boxed, intLikely,
  nullable" line deleted. Replaced with: (a) `notString` field doc (the
  one new field added during this consolidation pass, cross-referenced to
  the body-walk source + flow-overlay reader); (b) an explicit
  "Out-of-band tracking (not rep fields)" section naming the two parallel
  data structures — `ctx.func.boxed: Map<name, cellName>` (set by
  analyzeBoxedCaptures) and `ctx.func.refinements: Map<name, {val?,
  notString?}>` (set by emitBody's post-terminator narrowing). intLikely
  and nullable dropped — no concrete consumer.
  Verify: 1598/1598 jz + 580/580 watr green (doc-only change).

- [x] **D1. Unify export emission paths**
  Outcome: new `src/exports.js` factors two predicates:
  - `isExported(f)` — semantic "reachable from outside via any export"
    (covers inline, non-aliased `export { f }`, aliased `export { f as g }`,
    `export default f`). Scans `ctx.func.exports` values, not just keys.
  - `exportNamesOf(funcName)` — iterator of JS-visible export names that
    resolve to an internal func. Used for per-export ABI custom sections
    keyed on JS-visible names.

  Three compile.js gates rerouted to `isExported`:
  - `isBoundaryWrapped` (line 81) — boundary wrap now fires for aliased
    re-exports of narrowed funcs.
  - rest-params custom section (line 866-) — one entry per JS-visible
    name, not per internal func name.
  - i64Exports custom section (line 887-) — same.

  Two emit-time gates kept on the syntactic `f.exported` (with clarified
  comments): the inline `(func (export …))` attribute at line 297 and the
  boundary wrapper's inline export at line 402. Both would collide with
  sec.customs entries if widened to re-exports — the previous "Duplicate
  export name" failure mode is now prevented by design: syntactic gate for
  inline emission, semantic gate for everything else.

  Bug fixed: aliased re-exports of funcs with rest / array / string /
  mixed-shape params returned NaN at the JS boundary because the
  rest-pack custom section keyed on internal func names AND boundary wrap
  skipped them. Four regression tests added to test/imports.js covering
  rest, array param, string param, and typeof-narrowed body.

  narrow.js / plan.js / analyze.js sites that read `f.exported` are
  *policy* gates ("apply intra-module ABI specialization?") — left
  unchanged. With boundary wrap now correctly firing for aliased
  re-exports, the existing narrow+wrap policy stays coherent: aliased
  re-exports get internal optimization AND correct JS-visible ABI through
  the wrapper.
  Verify: 1602/1602 jz (4 new) + 580/580 watr green.

- [x] **D3. Document `paramReps` lifecycle phases**
  Outcome: added a 10-phase chronology block above the paramReps lattice
  primitives in src/infer.js. Each phase names: the pass that runs it,
  the fields it writes/clears, and the dependency on prior phases. Future
  contributors can answer "is paramReps[k].arrayElemSchema valid here?"
  by counting phases (G writes it; before G it's undefined).
  Verify: 1598/1598 jz + 580/580 watr green (doc-only change).

- [x] **D4. Document emit-time `updateRep` call sites**
  Outcome: each of the 9 emit-time updateRep sites now carries a lifecycle
  marker calling out that it mutates analysis-time state during emit.
  Sites covered: emitDecl ptr-rebox propagation (src/emit.js, 4 sub-sites),
  spread-staging local seeding (src/emit.js, 3 sites), array-inline param
  rep seeding (module/array.js:124), `[]` hoist-temp seed
  (module/array.js:601), `?.[]` and `?.()` recv-temp seeds (module/core.js
  712, 741), Object.assign target schema seed (module/object.js:187). Each
  comment explains why the freshly-created local is safe to mutate
  (no prior emit-time reader could have observed the unset rep).
  Verify: 1598/1598 jz + 580/580 watr green (doc-only change).

## Followups — inference module actionability + principles

- [x] **Document inference principles in research/**
  Outcome: `research/inference.md` written. Three principles:
  (1) Collect before compile — every dispatch-elision must trace back to a
  named upstream fact + pass, both for auditability and so editor hosts can
  consume `ctx.func.repByLocal` / `paramReps` for inlay hints + "suboptimal
  branch" badges. (2) Every inference aspect needs an actionable WAT test
  — fact-set/fact-read unit tests don't count, the user only observes the
  emit. (3) Conceptual cohesion over scatter — infer.js owns "what shape is
  this binding"; analyze.js owns "what's the canonical AST shape of X";
  exports.js owns boundary-ABI gates. Two intentional non-moves named
  (analyzeValTypes/IntCertain, callerParamFactMap).

- [x] **Add actionable inference tests — `test/inference.js`**
  Outcome: 18 new WAT-observable tests covering the previously-untested
  aspects flagged in the audit. Each test pairs positive + negative cases
  so a regression in either direction trips a failure.
  P0 covered (zero prior coverage):
  - notStringEvidence — index-write + length-read drops `__length`;
    pure-read keeps it; stringy disqualification (typeof) holds.
  - intConst — unanimous int-literal folds `local.get` → `f64.const`;
    disagree keeps `local.get`; body-write clears via validateIntConstParams.
  - paramReps val sticky-null — consistent ARRAY callers fold to direct
    header `i32.load`; ARRAY+STRING disagreement keeps `__length`.
  - inferArgArrElemSchema — consistent caller schemas via initRows→runKernel
    flow gives direct `f64.load offset=K`; disagreeing schemas keep
    `__dyn_get_*` polymorphic.
  P1 covered (partial/WAT-gap before):
  - methodEvidence STRING — block-bodied charCodeAt+length routes via
    `__str_byteLen` (notes the inferLocals block-only limitation).
  - methodEvidence ARRAY — `.push` induces VAL.ARRAY, no `__str_idx`.
  - extractRefinements — post-typeof-string early-return drops `__length`.
  - inferArgTypedCtor — Float64Array arg unlocks v128.load SIMD; disagree
    blocks vectorization.
  - analyzeBoxedCaptures — escape via `keep(...)` produces `$cell_n`.
  - recordGlobalValueFact — module-level Float64Array enables SIMD.
  + 1 runtime sanity cross-check that all the elisions don't change
  observed semantics (sumScaled return = 333).
  test/index.js updated to include `inference`.
  Verify: 1620/1620 jz (18 new) + 580/580 watr green.

## Tracking

- Run `npm test` (jz: 1620/1620 current) + `cd ../watr && npm test`
  (should be 580/580) after every item.
- Update this file as items complete: flip `[ ]` to `[x]` with a one-line
  outcome note.
- Don't commit unless asked.
