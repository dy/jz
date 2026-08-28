# prepare/index.js structure map (pre-split)

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
