# prepare/index.js split (pipeline-minimality slice)

Base: `b900cd09` (this worktree, `refactor/pipeline-minimality`). `src/prepare/index.js`
is 4,417 lines: 172 top-level statements — 16 `import`s, 1 bare side-effecting call
(`registerResetHook(resetPrepState)`), and **155 top-level declarations** (the task
brief's "154" is close; treat 155 as the verified count — see Methodology). No
top-level `if`/`for`/`class`/`else`/`catch` exists outside those 172 spans: every
one of them is bracket-balanced net-zero on a comment/string-stripped scan, and the
spans tile the file contiguously from line 34 (first import) to EOF with no gaps.

## Methodology (so the numbers below are checkable, not asserted)

A throwaway Node script in the scratchpad (not committed, not in the repo) did the
same class of analysis `vectorize-split.md` describes, adapted for two things that
script didn't need: **template-literal `${…}` expressions had to stay live** (this
file uses them — e.g. `mintLocal`'s `` `${name}${T}f${ownerStack[…]}_${…}` `` — a
naive "blank every backtick span" pass corrupts the scan the moment it hits one,
because the matching close-backtick of THAT SAME template gets misread as opening a
new one; fixed by a proper per-template brace-depth stack that only exits text mode
on that template's own close-backtick, never on an inner `}`), and **regex-vs-divide
disambiguation** (division exists in this file; a previous-significant-token
heuristic handles it, same class of heuristic any such scanner needs).

1. Strip comments, plain-string contents, and template-literal *text* (keeping
   `${…}` code) to spaces, preserving line/col layout.
2. Top-level statement spans = column-0 lines not starting with a closer
   (`)`/`}`/`]`) through the line before the next such line. Verified by checking
   every span's bracket count nets to zero on the stripped text — **all 172 spans
   balance**, including the one genuine outlier (`'()'(callee, ...args) {` at line
   3329 sits at column **0**, not the object's usual 2-space indent — a real
   formatting quirk in the source, not a scan bug; confirmed harmless because string
   content — the key's own quotes — is blanked before column-0 detection runs, so it
   never registers as a false top-level split).
3. Dependency edges: for each declaration's name(s), regex-search every *other*
   declaration's body for a whole-word reference. 342 raw edges; **1 confirmed false
   positive** in the whole set (`freshPrepareId`'s body reads `ctx.names.prepare`,
   a property access that textually matches the top-level function name `prepare`;
   caught by checking whether every occurrence of a via-name is preceded by a
   member-access `.` — spread's `...` is excluded from that check, which itself
   produced one transient false-false-positive on `truncateUnreachable` before the
   fix). 341 verified edges below.
4. Tarjan SCC over the 155-node graph for cycle detection (§Cycles).

## External contract

Exactly two exports, six importers, verified by grepping `src/ module/ jzify/
index.js scripts/ test/` for every import of `prepare/index.js` (direct path or
default/named import) — no other file reaches into this module:

| importer | imports |
|---|---|
| `src/front.js:26` | `prepare` (default) |
| `scripts/self.js:17` | `prepare` (default) + `GLOBALS` |
| `scripts/gen-prop-modules.mjs:51` | `GLOBALS` |
| `test/types.js:9` | `prepare` (default) + `GLOBALS` |
| `test/invariants.js:18` | `GLOBALS` |
| `index.js:55` (repo root) | `prepare` (default) + `GLOBALS` |

Everything else in the file — all 153 other declarations (155 total minus these
2 exports), every handler in the dispatch table, all module-level state — is
module-private. Dozens of *other* files (`src/kind.js`, `src/ctx.js`,
`src/compile/emit.js`, `module/object.js`, `jzify/transform.js`, most of
`test/`…) reference `prepare/index.js` only in **comments**, documenting a
behavior this file owns for a reader elsewhere — not imports. Grepped and
confirmed none resolve to an actual `import`.

## Sibling modules in `src/prepare/`

`index.js` sits alongside three siblings that are **independent pipeline stages,
not internal helpers of `index.js`** — `index.js` imports nothing from any of them,
confirmed by grep. `src/front.js`'s own header comment states the front-end
pipeline order: `parse → reject-reserved-prefix → liftIIFEs → jzify → prepare →
preEval`. Concretely (`src/front.js:109-120`):

- `lift-iife.js` (`liftIIFEs`, 153 ln) — runs **before** `prepare()`, on the raw
  parsed AST.
- `pre-eval.js` (`preEval`, 927 ln) — runs **after** `prepare()`, on prepare's
  output AST; imports `math-kernel.js` (`MATH_KERNEL`, `powFold`) as its own
  private helper — nothing else touches `math-kernel.js`.
- `math-kernel.js` (331 ln) — private to `pre-eval.js` only.

The new modules proposed below join this directory as *more* such siblings
(flat, no subdirectory) — the natural continuation of the existing layout, and
the only option that doesn't collide with `index.js` already being the directory's
package-entry filename (unlike `vectorize.js`, which was a bare file next to no
same-named directory, `prepare/` already exists and already holds this pattern).

## Module-level mutable state

The file's own header comment (lines 88-94) names this explicitly: "Module-level
prepare state. Six independent stacks/scalars… Kept at module scope… the
consolidated reset documents the set" — in practice **16 `let`s** (plus 3 related
`const`s: `STATIC_STRINGS`/`STATIC_ARRAYS`/`STATIC_CONSTS`, index constants into
one of the sixteen), all declared 95-170, all reset by `resetPrepState` (172-189)
and wired in via `registerResetHook(resetPrepState)` (190-197) — the file's other
top-level side effect besides `handlers`' own `...rejectHandlers(err)` spread
(below).

**13 of the 16** are containers (`Set`/`Map`/`Array`) only ever *mutated in place*
(`.push`/`.pop`/`.add`/indexed writes) outside `resetPrepState` — safe as plain
`export let` bindings; any module can import and mutate their *contents*.

**3 are reassigned (`=`, `++`, `--`) from OUTSIDE `resetPrepState`** — verified by
grepping every reassignment site, not assumed:

| name | reassigned at (besides `resetPrepState`) |
|---|---|
| `depth` | `handlers`' `'=>'` key (3145, 3201: `depth++`/`depth--`) and `prepareModule` (4115, 4120) |
| `ownerUniq` | `handlers`' `'=>'` key (3139: `++ownerUniq`) |
| `reassignedTopLevel` | `prepare()` (805) and `prepareModule` (4117, 4119) |

ES modules forbid assigning through an imported binding (a `let` import is a
read-only live view in the importing module) — exactly the constraint
`vectorize-split.md`'s `vecState` note hit. Same fix, same minimal scope: these
three, and *only* these three, bundle into one exported mutable object —
`export const prepState = { depth: 0, ownerUniq: 0, reassignedTopLevel: null }` —
with every read/write site at the 3 external call sites above (plus
`resetPrepState`'s own init) becoming `prepState.x`. The other 13 stay bare
`export let`. Behavior-identical; this is the one place (besides the handlers/
prep circularity below) where the split is more than textual cut-and-paste.

**Initialization/TDZ order**: no new risk. `state.js` (the proposed home for all
16+3, see below) has **zero** dependencies on any other new module (it sits first
in topological order), so importing it always fully evaluates its top level —
declaring every `let` and running `registerResetHook(resetPrepState)` — before
any importer's own code runs, exactly reproducing today's timing (this call
already fires at `prepare/index.js`'s current module-load time; splitting only
changes *which* file that load-time now belongs to, not when it happens relative
to the rest of the compiler's module graph).

## Shared structure: `prep` + `handlers`, and why they don't decompose like vectorize's chain

Unlike `vectorize.js` (a flat `??`-chain of independent recognizers sharing infra
but never calling each other or the dispatcher back), this file's shape is a
classic recursive-descent interpreter: **one universal entry (`prep`, 222 ln)
that every handler's rewrite half calls on its children, dispatching through one
table (`handlers`, 1,308 ln) whose bodies call back out to ~18 helper
functions, each of which itself calls `prep` to recurse.** That is a real,
load-bearing cycle, not an artifact — see §Cycles.

`handlers` is one `const` object literal: `{ ...rejectHandlers(err), <45 explicit
keys> }`. The spread (from `../op-policy.js`) supplies the reject-by-default
behavior for every AST op this file doesn't special-case (`class`, `this`, `var`,
`function`, plain `async`, …) — matching the header's own "no var/function/class/
this remain" postcondition. The 45 explicit keys **override/add** on top of that
base; **spread-then-explicit-keys order is load-bearing** and must be preserved
verbatim in any move. Verified via depth-tracked scan (not indentation guessing —
one key, `'()'`, sits at column 0 instead of the usual 2-space indent):

| key | lines | ln | key | lines | ln |
|---|---|---|---|---|---|
|`...`|2613-2617|5|`?`|3281-3300|20|
|`debugger`|2618-2621|4|`++`|3301-3305|5|
|`delete`|2622-2630|9|`--`|3306-3312|7|
|`in`|2631|1|`//` (regex lit)|3313-3316|4|
|`label`|2632-2634|3|`**`|3317-3328|12|
|`=`|2635-2763|**129**|`()` (call/group)|3329-3385|57|
|`try`|2764-2815|52|`[]`|3386-3411|26|
|`throw`|2816-2818|3|`{` (block)|3412-3420|9|
|`` ` `` (template)|2819-2830|12|`{}` (object)|3421-3532|112|
|`` `` `` (tagged tmpl)|2831-2851|21|`for`|3533-3753|**221**|
|`import` (dynamic)|2852-2866|15|`.` (member)|3754-3828|75|
|`,` (comma seq)|2867-2878|12|`new`|3829-3903|75|
|`from` (import stmt)|2879-2994|**116**|`instanceof`|3904-3915|12|
|`===`/`!==`|2995-3001|7| | | |
|`\|\|`/`&&`|3002-3005|4| | | |
|`;`|3006-3009|4| | | |
|`let`/`const`|3010-3018|9| | | |
|`if`|3019-3024|6| | | |
|`while`|3025-3038|14| | | |
|`do`|3039-3046|8| | | |
|`export`|3047-3132|**86**| | | |
|`=>`|3133-3208|**76**| | | |
|`switch`|3209-3217|9| | | |
|`?.`/`?.[]`/`?.()`|3218-3229|12| | | |
|`typeof`|3230-3237|8| | | |
|`+`/`-`|3238-3280|43| | | |

`prep`'s dispatch (1457-1458): `const handler = handlers[op]; return handler ?
handler(...args) : [op, ...args.map(prep)]` — **unhandled ops fall through to
generic recursion**, exactly per the header's own description. One inline
special-case precedes it: `op == null` (literal nodes: string/number) is handled
directly in `prep`, never reaching the table at all (1450-1455) — load-bearing
order, preserve as-is.

## Cycles

**Two**, both real (Tarjan SCC on the verified 341-edge graph), neither an
artifact:

**Small — `substPattern` ↔ `substObjItem` (29 ln, 1668-1711).** Mutual recursion
between "expand a destructuring pattern" and "handle one object-pattern item"
(which recurses into nested sub-patterns). Trivially contained: both land in the
same file (`destructure.js`), so it's ordinary intra-file recursion, invisible
across the module boundary.

**Large — 18 declarations, 2,645 lines, spanning lines 1150-4287:**
`staticTypeofString`, `resolveTypeof`, `prepStrictEq`, `prep`,
`scalarArrayDestruct`, `prepPatternKeys`, `pushPatternAssign`, `expandDestruct`,
`registerBuiltinAlias`, `preRegisterBuiltinAliases`, `prepDecl`,
`dispatchConstructorCall`, `foldFnCallApplyBind`, `foldJsonReviver`,
`resolveCallee`, `handlers`, `defFunc`, `prepareModule`. Every member's only path
back into the cycle is a call to `prep` (the universal recursion primitive — any
function that processes an AST subtree must call it); `handlers`' body is what
calls out to (nearly) all of them. This is inherent to a dispatch-table
interpreter, not a design smell — and neither prior split in this campaign hit
it (`vectorize-split.md`: "0 cycles"; `narrow-split.md`: "66 edges, 0 cycles" —
this is the first genuine one in the campaign).

A strict DAG (matching both priors' invariant, "later modules import earlier,
never the reverse") is achievable only by merging all 18 into one module — 2,645
lines, 2.2× the ~1,200-line target. The alternative, adopted below: split the
cycle at its one natural seam — `handlers` + `prep` (the irreducible hub, 1,538 ln
once `renestSoleCommaArg` — a small private helper of the `'()'` key — joins it;
see next section) vs. the 16 functions `handlers`' body calls out to plus
`jsonReviveTemplate` (`foldJsonReviver`'s own `??=`-reassigned cache — it moves
with its sole reader/writer, same reasoning as the `prepState` bundling above:
an imported `let` can't be reassigned from outside its declaring module) —
`handler-helpers.js`, 1,150 ln — and accept **one** circular import between
exactly these two files.

This is safe under ES module semantics, not just convenient: every crossing
reference is inside a function body invoked only after `prepare()` first runs
(i.e., after the whole module graph has finished loading) — never read at a
module's own top-level evaluation time. `handlers`' object-literal properties are
all method-shorthand or arrow **values** (closures over the imported bindings,
never called eagerly during the literal's own construction), and `handler-
helpers.js`'s functions only ever call `prep`/`handlers` from inside their own
function bodies, never at their module's top level. No TDZ read is possible. It
is also not *new* coupling: `handlers` already calls `prepDecl`/`resolveCallee`/…
today, in the one file — splitting only makes that existing mutual dependency
visible as a cross-file import instead of hiding it inside one file.

Two placement choices were needed to keep this the *only* module-level cycle
(confirmed by rebuilding the module-level condensation from the verified edges
and checking for `A→B ∧ B→A` — the check below is exhaustive, not spot-checked):

- **`freshPrepareId`** (1 ln, temp-name-id minter) is called from `handlers`
  itself, from 5 `handler-helpers.js` functions, *and* from `scope.js`'s
  `prescanBlockDecls` — leaving it inside `handlers.js` would create a second,
  spurious `scope.js ↔ handlers.js` module cycle (real edges in both directions,
  neither of which is part of the actual 18-node SCC — `prescanBlockDecls` itself
  is proven NOT a cycle member). Fixed by relocating it to `state.js` (zero
  outgoing dependencies of its own, sits first in topological order — every
  module can import it one-directionally).
- **`GLOBALS`, `NS_CTORS`, `builtinMemberKey`** (zero outgoing dependencies each)
  are referenced from both `closure-lift.js` and `module-resolve.js`/`handler-
  helpers.js`/`handlers.js`. Left at their physical positions, they'd create a
  `closure-lift.js ↔ module-resolve.js` cycle too (`isNamespaceAliasScoped` →
  `builtinMemberKey`, `foldNamespaceIntrospection` → `GLOBALS`, neither of which
  is part of the real SCC either). Same fix: relocate to `state.js`.

With those three relocations, the module-level condensation has **exactly one**
cycle: `handlers.js ↔ handler-helpers.js`. Every other pairing among the 13
proposed modules is one-directional.

## Module plan (`src/prepare/`, flat, alongside `lift-iife.js`/`math-kernel.js`/`pre-eval.js`)

Topological order (dependency-first); `*` marks the one deliberate circular pair.
`src/prepare/index.js` becomes a re-export shim: `export { default } from
'./entry.js'` + `export { GLOBALS } from './state.js'`.

| # | file | original lines | lines | contents |
|---|------|----------------|-------|----------|
| 1 | `state.js` | 61-197, 774, 918-922, **+1161-1166, +1469-1511, +1858-1867** | 201 | The 16-`let`/3-`const` module state + `resetPrepState`/`registerResetHook` + the bundled `prepState` (`depth`/`ownerUniq`/`reassignedTopLevel`, see above); `SIMD_NS`/`ERR_CLASS_SET`/`INSTANCEOF_ALLOW`/`CONSTANTS`/`F64_CONSTANTS` (small static tables); `freshPrepareId`, `GLOBALS` (2nd export), `NS_CTORS`, `builtinMemberKey` — the last 4 pulled forward from their physical spots for the cycle-avoidance reasons above |
| 2 | `ident-purity.js` | 198-318 | 120 | `mintLocal` (BindingId rename minter), `scanReassignedTopLevel`, `IDESC`/`decodeIdent` (`\u` escape decode), `callFree`/`_BOUND_PURE_NS`/`_BOUND_RO_METHODS`/`boundSafeCalls`/`writesReceiver` (call/receiver purity predicates for safe folding), `normalizeIdents` |
| 3 | `const-fold.js` | 361-431, 1200-1215 | 87 | `stripBoolNot`/`isOne`/`dropDeadPostfix`/`foldConstIf`/`declNamesOf`/`referencesAny`/`truncateUnreachable`/`stringValue`/`MUTATING_ARRAY_METHODS`/`litTruth`/`alwaysTruthy`/`alwaysFalsy` — dead-code/constant-folding predicates shared by the statement-sequence and conditional handlers |
| 4 | `scope.js` | 923-978, 1225-1245, 1518-1520, 1550-1667 | 195 | `resolveScope`/`isDeclared`/`prescanBlockDecls`/`pushScope`/`popScope` (scope-chain machinery), `bindingNames`/`mintForScope`/`bodyCapturesName`/`collectLoopDeclNames`/`markLoopLocal`/`withLoopLocalNames`/`substIdents`/`inlineArrayLen`/`declareGlobal`; **`hasLoopJump`/`retargetLoopJumps` (1225-1245) parked here** — see §Risks, apparently dead |
| 5 | `literals.js` | 433-683, 980-1013 | 272 | The literal-hoisting family: static-string(-array) value extraction, `hoistIndexedConstLiterals`, `bindStaticConst`/`bindStaticGlobal`/`deleteStaticGlobal`/`invalidateMutatedArray`/`seedStaticGlobalAssignments`, `collectTopLevelStaticAssignments`, `constNum`, `staticStringExpr` |
| 6 | `schema.js` | 1014-1085, 3918-3940 | 95 | `objLiteralSid`/`bindAssignSchema`/`censusUnknownInitDecl`/`bindDeclSchema`/`conditionalSpreadGroupPrepare`/`inferAssignSchema` — the "track schemas" concern |
| 7 | `destructure.js` | 1512-1517, 1522-1533, 1668-1683, 1699-1711 | 46 | `isDestructPattern`/`patternItems`/`simpleArrayPatternItems`/`arrayLiteralItems` + the `substPattern`↔`substObjItem` cycle (contained, see above) |
| 8 | `closure-lift.js` | 1087-1149 | 62 | `hasFunc`/`isNamespaceAliasScoped`/`shadowsBuiltin`/`isFuncValueLocal`/`renameFunc`/`isUnresolvableBareIdent` — **main's pending edit lands in `shadowsBuiltin`, 1104-1107** |
| 9 | `module-resolve.js` | 320-360, 685-772, 1167-1170, 1868-1922, 1960-1979, 2382-2395, 2498-2539, 4047-4063 | 277 | Host-import ABI, `import.meta`, module-init-fact recording, builtin-alias resolution, namespace-import destructuring, namespace introspection, module-source lookup. `foldImportMetaResolve` (2382-2395) is the last function before **main's pending edit** (a new `prepareArrayConstructor` const inserted right after it — see §Pending edits) |
| 10 | `handler-helpers.js` | 1150-1160, 1171-1199, 1216-1224, 1535-1548, 1684-1697, 1713-1857, 1923-1959, 1980-2381, 2396-2497, 2541-2600, 3942-4045, 4064-4287 | 1,150 | The 16 functions `handlers`' body calls out to: `staticTypeofString`/`resolveTypeof`/`prepStrictEq` (typeof/strict-eq), `scalarArrayDestruct`/`prepPatternKeys`/`pushPatternAssign`/`expandDestruct` (destructuring), `registerBuiltinAlias`/`preRegisterBuiltinAliases` (builtin aliasing), **`prepDecl`** (2027-2381, 355 ln — `let`/`const` prep, 3rd-largest function in the file), `dispatchConstructorCall`/`foldFnCallApplyBind`/`foldJsonReviver`+`jsonReviveTemplate`/`resolveCallee` (call/constructor folds), `defFunc`+`MAX_MULTI`/`collectReturns`/`detectResults` (function-lifting + multi-return detection), **`prepareModule`** (4064-4287, 224 ln — recursive-import module prep). `jsonReviveTemplate` (2461) moves here from its physical spot right before `foldJsonReviver` — it's `??=`-reassigned only inside that function, same imported-`let` constraint as `prepState`. Cyclic partner of `handlers.js`* |
| 11 | `handlers.js` | 1247-1468, 2601-3917 | 1,538 | **`prep`** (1247-1468, 222 ln, the universal recursion entry) + `renestSoleCommaArg` (the `'()'` key's arg-renesting helper) + **`handlers`** (2610-3917, 1,308 ln, the dispatch table — see breakdown above). **`'new'`/`'instanceof'` keys (3829-3915) are main's third pending-edit region.** Cyclic partner of `handler-helpers.js`* |
| 12 | `sparse-map.js` | 4288-4417 | 130 | `fuseSparseMapReads`/`tryFuseInBlock`/`tryFusePair` (entry + matchers), `isPureSparseArrowBody`/`hasOnlySparseUses`/`hasAnyIndexedRead`/`assignsName`/`bindsName` (purity/shape predicates), `substSparse`/`cloneAndBind` (rewrite) — the sparse-map-read fusion pass, fully self-contained |
| 13 | `entry.js` | 776-917 | 142 | **`prepare`** (default export) — the pass entry point only |

Total: 4,315 lines across 13 files (the remaining ~102 lines of the 4,417 are the
header comment and the 16 import statements, which don't move as a block — each
new file gets its own minimal imports from `ast.js`/`ctx.js`/etc.). Largest:
`handlers.js` at 1,538 (28% over the ~1,200 target — the accepted cost of the
cycle, see above). Second largest `handler-helpers.js` at 1,150. All other 11
are 46-277 lines.

## Verified cross-checks (grep, not assumption)

- `handlers`' 45 keys enumerated by a brace-depth walk of the stripped object
  literal, not by indentation — needed because `'()'` sits at column 0 while
  every other key sits at column 2 (a real quirk in the source).
- `freshPrepareId`, `GLOBALS`, `NS_CTORS`, `builtinMemberKey`: each has **zero**
  outgoing edges (confirmed against the edge list directly, not inferred) —
  the reason they're safe to hoist into `state.js` regardless of their physical
  position in the original file.
- The one false-positive edge (`freshPrepareId`→`prepare` via `ctx.names.prepare`)
  would, left uncorrected, have pulled `prepare()` itself into the 18-node cycle —
  checked explicitly: with the false edge removed, `prepare` has zero incoming
  edges from within the file (nothing calls the file's own default export
  recursively), confirming it's a clean, one-directional leaf that only needs
  `prep` from `handlers.js`.
- `hasLoopJump` (1225-1236) and `retargetLoopJumps` (1237-1245) have **zero**
  edges in either direction — grepped directly (not just the edge scan): their
  only references are to themselves (self-recursion). Nothing in `handlers`' `for`
  key or anywhere else calls them. Flagged in §Risks, not deleted (out of scope
  for a pure-move plan).
- Only `src/front.js`, `scripts/self.js`, `scripts/gen-prop-modules.mjs`,
  `test/types.js`, `test/invariants.js`, and root `index.js` import from
  `prepare/index.js`; every other repo-wide hit on the string `prepare/index.js`
  (dozens, across `src/kind.js`, `src/ctx.js`, `src/compile/*.js`, `module/*.js`,
  `jzify/*.js`, most of `test/*.js`) is a comment cross-referencing this file's
  behavior, not an import.

## Pending-edit regions (another session's uncommitted work in `/Users/div/projects/jz`, main worktree)

Confirmed via `git diff -- src/prepare/index.js` in the main worktree (not
assumed from the task brief's line numbers, which are main's — this worktree's
`index.js` differs from main's by an unrelated walker-retirement commit, so line
numbers don't transfer 1:1; mapped here by the diff's own function-name context
instead):

1. **`shadowsBuiltin`** (this worktree: 1104-1107, in proposed `closure-lift.js`) —
   gains an `ctx.module.imports.some(...)` clause.
2. **A new top-level `const prepareArrayConstructor`** is being inserted between
   `foldImportMetaResolve` (this worktree: 2382-2395, proposed `module-resolve.js`)
   and `dispatchConstructorCall` (2396-2416, proposed `handler-helpers.js`) —
   **this pending edit straddles the proposed module boundary**: the new function
   is called from `dispatchConstructorCall` (which is moving to
   `handler-helpers.js`) and, per the diff, also from `handlers['new']` (which
   stays in `handlers.js`, already a one-directional consumer of
   `handler-helpers.js`) — so once it lands, `prepareArrayConstructor` belongs in
   `handler-helpers.js` alongside `dispatchConstructorCall`, not in
   `module-resolve.js` next to `foldImportMetaResolve` where it will textually
   appear pre-move. `dispatchConstructorCall`'s own body also gains an
   Array-literal special case.
3. **`handlers['new']` and `handlers['instanceof']`** (this worktree: 3829-3903
   and 3904-3915, both inside proposed `handlers.js`) — `'new'` gains a
   `shadowsBuiltin`-gated builtin-vs-user-constructor split (`WeakSet`/`WeakMap`/
   `SharedArrayBuffer`/`Array`/`URL`/`RegExp` all route through a new
   `builtinCtor` check) and a call through the new `prepareArrayConstructor`;
   `'instanceof'` gains the same `shadowsBuiltin`-gated `SharedArrayBuffer`
   canonicalization.

**All three regions must stay in place — moved verbatim only after that work
lands** (or be applied to the already-moved location, which for region 2 means
applying it to `handler-helpers.js`, not textually where the diff shows it). Do
not execute the `closure-lift.js`/`module-resolve.js`/`handler-helpers.js`/
`handlers.js` moves until confirming with that session, or until the edit is
committed and mechanically re-diffed against the moved files.

## Verification recipe

1. `node scripts/refactor-oracle.mjs check --ref main` — must report **clean**
   (byte-identical WASM across the whole corpus at O0/O2/O3/size; see
   `.work/refactor-oracle.md`). This is the primary gate for a pure-move split:
   it proves the split changed no compiled output, not just "tests still pass."
   Run it after *each* module extraction, not only at the end — cheaper to
   isolate a mistake to one move.
2. `npm test` (`node test/index.js`) — the full functional suite; already
   includes `test/destruct.js` and `test/session-reentrancy.js` by name (grepped
   the runner's own suite list). Highest-signal individual files for this
   specific split:
   - `test/session-reentrancy.js` — exercises exactly the module-level state this
     plan restructures ("prepare/index.js's 14-let working set" per its own
     comment); the sharpest test for the `prepState` bundling and the
     `resetPrepState`/`registerResetHook` timing.
   - `test/destruct.js` — the `expandDestruct`/`pushPatternAssign`/`prepDecl`
     cluster now split across `handler-helpers.js`.
   - `test/imports.js` — `prepareModule`/module resolution, now in
     `handler-helpers.js`/`module-resolve.js`.
   - `test/closures.js`, `test/errors.js` — closure-lift (`hasFunc`/`renameFunc`)
     and the 7 Error-class/`instanceof` allowlist, both touched by the pending
     edit region.
3. `npm run test:262` — declarations, destructuring, and for-in/for-of are
   spec-precision-sensitive; test262 is the deepest check available for exactly
   what this file does.
4. `npm run test:matrix` (opt0/opt3/wasi legs) if time allows — cheap insurance
   beyond what the oracle already covers at those optimize levels.

## Risks/unknowns, stated plainly

- **The `handlers.js` ↔ `handler-helpers.js` circular import is a real
  deviation from this campaign's established invariant** (both
  `vectorize-split.md` and `narrow-split.md` report zero cycles). It is argued
  safe above (no TDZ read, existing coupling made visible not created), but it
  is a judgment call, not a mechanical fact like the rest of this plan — if the
  executing session or a reviewer prefers a strict DAG, the fallback is merging
  all 18 cycle members into one ~2,645-line module instead of two
  (~1,538/~1,150), which trades module-count cleanliness for a much larger file.
  Flagging the choice rather than silently picking one.
- **`hasLoopJump`/`retargetLoopJumps` appear to be dead code** — zero callers
  anywhere in the file, confirmed by direct grep, not just the edge scan. Not
  deleted here (out of scope for a pure-move plan) but worth a human decision
  before or after the split; parked in `scope.js` as the closest thematic fit.
- **The false-positive rate of the textual dependency scan is low but nonzero**
  (1 confirmed in 342 raw edges, ~0.3%) — property-access text that happens to
  match a top-level name. Every edge feeding a structural decision in this plan
  (the cycle membership, the `state.js` relocations) was individually
  re-verified against the false-positive pattern; edges that only affect a
  module's "contents" listing (not its place in the DAG) were not all
  individually re-verified — low risk, since a stray extra name in a "contents"
  list costs nothing at move time (the mechanical move is per-declaration, not
  per-edge).
- **The three pending-edit regions are the real blocker**, not a nice-to-have —
  region 2 specifically requires the executing session to place new code in a
  DIFFERENT file than where it will textually land in main's diff (see above).
  Landing this split before that work merges risks silently discarding it or
  producing a conflict that's harder to resolve post-split than pre-split.
- **`STATIC_ARRAYS`/`STATIC_CONSTS`** are two of three names bound by one `const`
  statement (`const STATIC_STRINGS = 0, STATIC_ARRAYS = 1, STATIC_CONSTS = 2`) —
  the whole statement moves as one unit to `state.js`; no split risk, just
  noting it since a naive per-name accounting undercounts by 2.
- Line-count target (~1,200) is treated as a heuristic here, not a hard cap —
  `handlers.js` at 1,538 exceeds it because the alternative (forcing it under by
  fragmenting further) would multiply the number of circular-pair files rather
  than shrinking the real problem. Stated, not hidden.

## Outlier decomposition candidates (a later phase, after the pure-move split)

Mirroring `vectorize-split.md`'s own deferral: these are candidates once each
file is isolated, not attempted now.

- `handlers.js`'s `handlers` object (1,308 ln, 45 keys) — the keys don't call
  each other (each fires on a disjoint AST op tag), so a spread-merge split
  (`{ ...rejectHandlers(err), ...operatorKeys, ...literalKeys, ...stmtKeys, … }`
  across several files) is behaviorally safe and would shrink `handlers.js`
  substantially — deliberately not done here because it's a bigger transform
  than "move the declaration," and because each new fragment would *still* need
  a circular import back to `prep` (more, smaller cycles instead of one — see
  §Cycles), a tradeoff worth its own discussion, not a default.
- `prepDecl` (355 ln) and `prepareModule` (224 ln), both in `handler-helpers.js`
  — evaluate a match/rewrite split per-function once isolated.
- `'for'` (221 ln, inside `handlers`) — the largest single handler; for/for-in/
  for-of desugaring in one function, candidate for its own internal seam once
  visible in a smaller file.

Plan authored before any code was moved; decomposition specifics get filled in
as each module is actually split (later-phase commits) — same discipline as
`vectorize-split.md`'s phase 3 note.

## Status — what actually landed (updated post-execution)

Base `a45ce6ca` (main tip at execution time — the "pending-edit regions" below
had already landed by then, so nothing was actually pending against this base;
see §Deviations). Re-derived the full family map independently against this
current file, using the repo's own `typescript` devDependency (real parser +
checker symbol resolution, not a regex scan) for exact declaration boundaries
and ground-truth cross-reference edges — not by trusting this doc's stale line
numbers. Agreement with this doc's plan was total except the two deviations
below.

12 families landed as 12 separate pure-move commits, leaf-first (`375b1f85`
… `e93e794a`), each individually gated clean (oracle 560/560, kernel-parity
33/33) before the next. Three more commits followed: the dead-imports cleanup
(`a6c074b7`), and two walker retirements (`4429a606`, `3025e898`) — 15 commits
total, HEAD `3025e898`.

### Final module table

| # | file | lines | contents |
|---|------|-------|----------|
| 1 | `state.js` | 250 | module state (13 plain `export let`s + the bundled `prepState`) + freshPrepareId/GLOBALS/NS_CTORS/builtinMemberKey/CONSTANTS/F64_CONSTANTS/SIMD_NS/ERR_CLASS_SET/INSTANCEOF_ALLOW |
| 2 | `ident-purity.js` | 139 | mintLocal, scanReassignedTopLevel, IDESC/decodeIdent, callFree/boundSafeCalls/writesReceiver, normalizeIdents |
| 3 | `const-fold.js` | 102 | stripBoolNot…truncateUnreachable, MUTATING_ARRAY_METHODS, litTruth/alwaysTruthy/alwaysFalsy |
| 4 | `scope.js` | 213 | resolveScope/isDeclared/prescanBlockDecls/push·popScope, bindingNames, loop-local family, substIdents, declareGlobal, hasLoopJump/retargetLoopJumps (dead, parked) |
| 5 | `literals.js` | 297 | static-string(-array) extraction cluster, hoistIndexedConstLiterals, bindStaticConst family |
| 6 | `schema.js` | 111 | objLiteralSid, bindAssignSchema, censusUnknownInitDecl, bindDeclSchema, conditionalSpreadGroupPrepare, inferAssignSchema |
| 7 | `destructure.js` | 64 | isDestructPattern/patternItems/simpleArrayPatternItems/arrayLiteralItems + substPattern↔substObjItem |
| 8 | `closure-lift.js` | 78 | hasFunc/isNamespaceAliasScoped/shadowsBuiltin/isFuncValueLocal/renameFunc/isUnresolvableBareIdent |
| 9 | `module-resolve.js` | 299 | host-import ABI, import.meta, module-init facts, builtin-alias resolution, namespace destructuring/introspection, module-source lookup |
| 10 | `handlers.js` | 2727 | **merged**: prep + renestSoleCommaArg + handlers + all 21 handler-helper functions (see §Deviations) |
| 11 | `sparse-map.js` | 156 | fuseSparseMapReads + tryFuseInBlock/tryFusePair + purity/shape predicates + substSparse/cloneAndBind |
| 12 | `entry.js` | 181 | `prepare` (default export) + the original file-header stage-contract doc comment |
| — | `index.js` | 3 | barrel: `import prepare from './entry.js'; export default prepare; export { GLOBALS } from './state.js'` |

Total 4,617 lines across 13 files (was 4,452 in one file; +165 lines / +3.7% —
12 fresh per-family header comments + import-line restructuring, expected for
a mechanical fan-out; verified content-preserving, not padding, by the
byte-identity proof below). Largest: `handlers.js` at 2,727 (the merged
cluster). Second largest `module-resolve.js` at 299.

### Deviations from the plan (documented, not silent)

1. **`handlers.js` and `handler-helpers.js` merged into one file — 12 modules
   landed, not 13.** The doc's primary plan accepted a circular import between
   these two. jz's own self-hosted kernel build feeds jz's OWN compiler over
   its own source (`scripts/self.js` → `npm run build`); prepare/index.js's
   own `prepareModule()` throws `"Circular import"` (src/prepare/handlers.js,
   the same guard that lived at the original file's ~line 4103) the moment a
   circular import lands in that bundle — stricter than Node's ESM loader,
   which tolerates the cycle. This isn't a hypothetical: it was independently
   re-derived via a Tarjan SCC over the ground-truth (checker-resolved, not
   regex) dependency graph before any file was written — all ~25 declarations
   (`prep`, `renestSoleCommaArg`, `handlers`, plus the ~21 "handler-helpers"
   functions this doc's §Cycles already named, plus `prepareArrayConstructor`
   and `isLit`, both landed/found after this doc's own edge scan — see #2
   below) form one strongly-connected component; no 2-way split of it is
   acyclic, by definition of "strongly connected." This is this doc's own
   stated fallback ("merging all 18 cycle members into one module"), just
   with 7 more members (25 vs 18) than counted when this doc's §Cycles was
   written, and named `handlers.js` (this doc's own name for the hub) rather
   than a fresh name.
2. **`isLit`** (`n => Array.isArray(n) && n[0] == null`, a same-named but
   different-purpose shadow of ir.js's own `isLit`) wasn't in this doc's
   handler-helpers.js prose list — a one-line, easy-to-miss grab-bag member.
   Its sole caller is `handlers`, so it joins the merged `handlers.js` as the
   SCC's 25th member. Caught by an automated coverage check (every one of the
   file's 156 top-level declarations assigned to exactly one family, checked
   programmatically, not by inspection) rather than being missed silently.
3. **The three "pending-edit regions"** this doc flagged as blocking
   (`shadowsBuiltin`'s `ctx.module.imports.some(...)` clause, the new
   `prepareArrayConstructor` + `dispatchConstructorCall`'s array-literal case,
   `handlers['new']`/`['instanceof']`'s builtinCtor/SharedArrayBuffer gating)
   had already landed on `main` by the time this session started (main
   advanced from this doc's `b900cd09` base to `a45ce6ca`, +35 lines) — none
   were actually pending against the base this split cuts from.
   `prepareArrayConstructor`'s resolution matches exactly what this doc
   predicted: `handlers.js` (handler-helpers.js's would-be home), not
   `module-resolve.js`, confirmed by its real callers
   (`dispatchConstructorCall`, `handlers['new']`).
4. **`export { default } from './entry.js'`** — this doc's own prescribed
   barrel form — is valid Node ESM but is NOT valid jz-self-host source: jz's
   own early-errors.js flags the bare word `default` inside a `{}` specifier
   list as a reserved-word binding (no other file in the repo used this exact
   shorthand, so the gap was never exercised before). Found by `npm run
   build`'s self-compile step, not by any of the native-side checks (syntax
   check, module load, oracle, kernel-parity all passed against it, since none
   of them run jz's OWN parser over jz's OWN source the way self-compilation
   does). Fixed to the pattern already proven working elsewhere in the repo
   (`src/abi/{number,object,array,string}.js`): `import prepare from
   './entry.js'; export default prepare`. `export { GLOBALS } from
   './state.js'` (a non-`default` named re-export) needed no change — that
   shorthand is exercised throughout ir.js's/vectorize.js's own barrels
   already and self-compiles fine.
5. **Methodology**: re-derived the full family map independently using the TS
   compiler's own parser + checker (real scope-resolved symbol references,
   not a comment/string-stripped regex scan), available via the repo's own
   `typescript` devDependency — gives exact declaration boundaries (byte
   offsets, not line-number heuristics) and eliminates the false-positive
   class this doc's own methodology section names (property-access text
   matching a top-level name). A from-scratch Tarjan SCC over this
   ground-truth graph independently reproduced this doc's central claim (the
   one large cycle, its exact membership modulo #1/#2 above) before trusting
   it enough to cut against.

### Documentation-preservation notes (not covered by this doc, found during extraction)

- `depth`/`ownerUniq`/`reassignedTopLevel` bundle into `export const prepState
  = { depth: undefined, ownerUniq: undefined, reassignedTopLevel: undefined }`
  in state.js — mirrors `vectorize-split.md`'s `vecState` precedent exactly,
  including matching each field's ORIGINAL bare-`let` initializer (`undefined`
  for all three, since none had one) rather than inventing a value. All 35
  non-declaration read/write sites across handlers.js, scope.js,
  module-resolve.js, and entry.js were rewritten to `prepState.x` at exact
  byte offsets located via the checker (every occurrence individually
  confirmed to resolve to the true top-level symbol, not a shadowing local of
  the same name) — not a blind regex replace.
- Doing the bundling naively (dropping the 3 `let` spans wholesale) would have
  silently discarded real documentation: `reassignedTopLevel`'s own 11-line
  design rationale (why `defFunc` needs reassignment-tracking at all) and
  `ownerStack`'s own multi-line trailing comment (textually located in what
  would become `ownerUniq`'s leading gap, under this file's own "a comment
  attaches to the declaration that follows it" convention — the same
  convention this doc's own §Methodology relies on for span boundaries).
  Both relocated verbatim (byte-sliced from the original, not retyped) — the
  rationale into the new `prepState` block, the trailing comment reattached
  to `ownerStack`'s own emission. Found by an automated "does any same-line
  trailing comment cross a family boundary" sweep across all 156
  declarations, not by inspection — it found exactly these 2 cases (plus one
  more of the same shape: the bare top-level `registerResetHook(resetPrepState)`
  expression statement, which isn't a named declaration so is invisible to a
  per-declaration accounting, had its text swept into `mintLocal`'s leading
  gap by the same convention; stripped from there and emitted explicitly
  right after `resetPrepState` in state.js instead).
- The file's own module header (the "AST preparation… Stage contract…
  Concerns… Forward seeding…" doc comment) moved verbatim to `entry.js` (the
  file holding `prepare`, the stage's actual entry point) — following the
  `vectorize-split.md` precedent exactly (`vectorize.js`'s own header moved
  wholesale to `vectorize/index.js`, not the barrel; `ir.js`'s barrel kept a
  header only because `ir.js` has no single entry point, unlike
  prepare/vectorize). The barrel (`index.js`) carries no header at all,
  matching `vectorize.js`'s barrel.

### Dead-code / outlier / walker dispositions

**Dead exports/imports (phase 1, commit `a6c074b7`)**: the 3 names
`.work/dead-exports-sweep.md` flagged as unused imports specific to
prepare/index.js — `REJECT_OPS` (`../op-policy.js`), `includeForKnownKeyIteration`
and `includeForRuntimeKeyIteration` (`../autoload.js`) — confirmed still
genuinely unused post-split (grepped `src/prepare/` for each; the only hit
each time was the now-dead import line itself, carried into `handlers.js` by
the move), removed with grep proof. Cross-checked independently: a full
per-family external-import-usage recomputation (via the checker, not by
trusting the prior sweep) landed on the exact same 3-name gap between "what
the original 16 import statements bound" and "what any of the 156
declarations actually reference" — same finding, reached two different ways.

**Outlier functions (phase 2, declined — no code change)**: the doc's own
candidates, `handlers` (1,308 ln / 45 keys) and `prep` (222 ln), stay whole.
Declining is no longer just "a bigger transform than a move" (this doc's
original framing) but structurally forced: `handlers`' 45 keys don't call each
other, so a spread-merge split across files is mechanically possible — but
every fragment would need `prep` (the only way to recurse into a child node),
and `handlers` itself would need every fragment back (14 of the 45 keys call
a handler-helper directly) — i.e. splitting `handlers` further only
multiplies the one cycle this split already had to merge away into several
smaller ones, each *also* forced into `handlers.js` by the same
resolveModuleGraph rejection that drove deviation #1. `prep` (222 ln) is a
linear sequence of whole-program feature-detection checks (bigint/Error-class
flags, …) feeding one dispatch — not decomposable into smaller `prep`s
without breaking "the one entry every recursive call goes through."

**Hand-rolled walkers (phase 3)**: surveyed every hand-rolled recursive
tree-walk across all 12 new files against `walkAst`'s actual contract
(`src/ast.js:121` — pre-order `enter`, `enter() === false` prunes a subtree
INCLUDING its own exit, primitive/string leaves are never visited, children
start at index 1). Two were genuine, provable retirements — verified with a
standalone differential harness (not the oracle corpus, which doesn't isolate
this one function) before touching the file, matching `ir-split.md`'s own
`buildRefcount`/`nextLocalId` precedent:
- `collectLoopDeclNames` (scope.js, commit `4429a606`) — unconditional
  descent that prunes at `=>` boundaries, collecting `let`/`const` binding
  names along the way; retired onto `walkAst({enter})` directly. 22-case
  harness (arrow pruning, destructuring patterns, a shared-subtree reference,
  a 50-declaration stress case) — 22/22 match. Also re-verified against the
  real pipeline: `test/closures.js` (114/114, 258 assertions) and a
  hand-written per-iteration-capture program, both exercising exactly this
  function's only caller (`withLoopLocalNames`).
- `hoistIndexedConstLiterals`'s `banIn`/`collectBans` closures (literals.js,
  commit `3025e898`) — unconditional descent with NO pruning at all (marks
  every `[]` node it sees; `collectBans` additionally launches a `banIn`
  sub-walk from every assignment-target subtree it finds) — an even more
  direct fit than the first. 16-case harness (assign/compound/++/--/delete
  targets, comparison ops correctly excluded, a shared literal reference
  compared by object identity, a 30-declaration stress case) — 16/16 match.

Declined (not walker-shaped — each hits one of `walkAst`'s own documented
gaps, not a stand-in for a missing feature):
- `recordModuleInitFacts`'s internal `walk` (module-resolve.js) — inspects
  BARE STRING LEAVES (`TIMER_NAMES.has(node)` when `node` is a plain string),
  which `walkAst`'s `enter` never sees by design (primitive operands aren't
  visited; only their containing node is). Its sibling `visitFuncValue` stops
  the ENTIRE search the instant one match is found (`if (facts.hasFuncValue)
  return` at every call), an early-exit-the-whole-walk shape `walkAst` has no
  hook for.
- `bodyCapturesName` (scope.js) — at an `=>` boundary it doesn't prune, it
  DISPATCHES to a different function (`refsName(node[2], name,
  REFS_THROUGH_ARROWS)`) and returns that result directly, short-circuiting
  the whole OR-fold search on first match — `walkAst` has no "stop everything,
  return this value" contract, only prune-this-subtree.
- `expandDestruct`, `substPattern`/`substObjItem`, `substSparse`/`cloneAndBind`,
  `substIdents`, `retargetLoopJumps` — all structural TRANSFORMS (build and
  return a new/rewritten tree) or match-and-emit-into-an-output-array
  functions, not visits; same declined class as `ir-split.md`'s `cloneIR`.
- `hasLoopJump` — zero callers anywhere (confirmed independently, matching
  this doc's own §Risks flag), left untouched: deleting dead code was never
  one of this pass's three authorized post-move phases, and the doc itself
  declined to delete it for the same reason.

### Battery (exact counts)

- `resolveModuleGraph('bench/jz/jz.js', { resolveNode: true })` — ran after
  every one of the 12 moves (module count climbed 270→282, 1:1 with the 12
  new files) plus after each of the 3 follow-up commits; never threw.
- `node scripts/refactor-oracle.mjs check --ref a45ce6ca` — CLEAN 560/560
  (140 specs × O0/O2/O3/size) after every one of the 15 commits individually,
  and once more at HEAD (`3025e898`) as the closing gate.
- `node test/kernel-parity.js` — 33/33 (3 programs × O0/O2/O3, 33 assertions)
  after every one of the 15 commits.
- `node test/index.js` (native, excl. `test/bench-c.js`) — 3,858/3,859 pass,
  1 pre-existing skip, 0 fail (28,505 assertions) at HEAD.
- `JZ_TEST_TARGET=jz.wasm node test/index.js` (kernel target, drives the
  self-compiled `dist/jz.wasm` built by `npm run build` above) —
  3,034/3,035 pass, 1 pre-existing skip, 0 fail (14,639 assertions).
- `node test/closures.js` — 114/114 (258 assertions), run standalone against
  the `collectLoopDeclNames` retirement specifically.
- `node scripts/bench-size.mjs --json` — byte-identical to a fresh run at
  `a45ce6ca` across all 60 bench-corpus programs (diffed directly, zero
  lines differ) — the compiled-output half of "byte-identical," for programs
  the compiler itself compiles (not the self-hosted kernel).
- `npm run build` (self-compile) — succeeds at HEAD; see deviation #4 for the
  one real bug this step caught that nothing else did.

### Kernel size before/after

`dist/jz.wasm`: baseline (`a45ce6ca`, built fresh in an isolated worktree)
17,898,864 bytes → HEAD 17,905,943 bytes, **+7,079 bytes (+0.040%)**. Same
class of delta `ir-split.md` reports for the identical reason (there: +11
files, "a ~0.006% delta from the self-compiled program's own module-graph
gaining 11 files, i.e. jz's own bundler now concatenates in a different file
order, shifting some LEB128-encoded function-index widths; not a behavior
change") — here it's +12 files instead of +11, plus this split's fresh
per-family header comments and internal cross-file import lines are
themselves new SOURCE TEXT the self-hosted compiler parses (even though they
compile to no runtime code), which the ir-split delta didn't have to account
for in the same proportion. Not a behavior change: `bench-size.mjs --json`
(the compiled-output size for 60 real programs, using the NATIVE compiler)
is byte-identical to baseline, proving zero drift in what the compiler
produces for any given input — the kernel-size delta is pure self-compiled
bundling structure, exactly as this doc's own §Cycles precedent predicted
for any file-count change.

### Unverified / left as-is

- `hasLoopJump`/`retargetLoopJumps` remain confirmed dead code (zero callers,
  not exported, so zero possible external callers either) — moved verbatim
  into scope.js per this doc's own placement, not deleted (out of scope for
  the three authorized post-move phases; the doc itself made the same call).
- The outlier and further-walker surveys above are a manual read of all 12
  files, not an exhaustive mechanical sweep the way the family map itself
  was — a real but small residual risk that a further candidate exists
  somewhere unexamined. The 15-commit battery (oracle + kernel-parity on
  every commit, full native suite + bench-size + kernel build at HEAD)
  bounds the cost of that risk to "a missed opportunity," not "a correctness
  gap," since nothing was changed without its own gate passing first.
