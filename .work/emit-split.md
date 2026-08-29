# emit.js structure map (pre-split)

Base: HEAD `b900cd09` on `refactor/pipeline-minimality`, **plus working-tree
edits already present when this analysis was frozen** (see "Snapshot basis"
below — this worktree is shared with other concurrent agents, and the file
moved once mid-analysis). `src/compile/emit.js` is 8,143 lines at the frozen
snapshot (8,150 at task-assignment time — see below), a flat sequence of 188
top-level `function`/`const`/`class` declarations (verified: `grep -c` of
top-level `let` = 0, `class` = 0; the only other top-level statements are the
32-line header/import block — no `registerResetHook`, no bare top-level
expression statement). Dependency edges below were extracted with a
comment/string-stripped scan (`node --check`-clean on the stripped output
too) so they reflect real code references, not doc-comment mentions of
sibling function names, and were cross-verified with a proper Tarjan SCC
pass, not just a DFS cycle listing.

## Snapshot basis (read this before trusting any line number below)

Another agent is actively landing the same pipeline-minimality campaign in
this shared worktree. Mid-analysis, `git diff --stat src/compile/emit.js`
went from clean to `1 file changed, 9 insertions(+), 15 deletions(-)`
(8,149 → 8,143 lines) — a `walkAst`/`some`-adoption refactor of
`boolEagerBody` and (inside `unrollSmallConstFor`) its inner unroll-cost
scan, replacing two hand-rolled recursive walkers. This landed **before**
this document's line numbers were finalized: I froze a snapshot
(`scratchpad/snapshot/emit.js`, this session's own scratchpad — not the
repo) at that point and did all subsequent extraction against it, so every
range below is internally consistent with itself, but is a snapshot, not a
promise about what `git blame` shows when you read this. Confirmed
byte-identical to the working tree as of the final check in this session.
**Before executing this plan, re-run the extraction (script below) against
the then-current file and diff the ranges** — a few more lines of drift
anywhere before line ~5700 shifts everything after it uniformly, which is
mechanical to re-derive but must not be assumed unchanged.

Separately — **not yet observed in this worktree, per the task brief**:
another session has uncommitted edits to the `'return'` op handler
(originally reported as "~5935-5980, the `emitter` object"; in this
snapshot's numbering that region falls entirely inside `'return'`,
lines 5868-5981, inside `statements.js`'s share of the `emitter` object —
see the Module plan). That region is flagged in the Risks section: **the
`statements.js` extraction of the `emitter` object's `'return'` property
must be sequenced after that edit lands, or hand-reconciled against it** —
it is the one region this plan cannot assume is stable.

## External contract

Fifteen `export`s, all consumed only via plain named imports (no namespace
import, no re-export chain beyond the two call sites below) — grepped across
`src/`, `module/`, `jzify/`, `index.js`, `scripts/`, `test/`:

| export | importers |
|---|---|
| `emit` | `src/compile/index.js`, `src/wat/assemble.js`, `index.js`, `scripts/self.js`, `scripts/gen-prop-modules.mjs`, `test/invariants.js`, `test/types.js` |
| `emitter` | `src/compile/index.js`, `index.js`, `scripts/self.js`, `scripts/gen-prop-modules.mjs`, `test/invariants.js`, `test/types.js` |
| `emitVoid` | `src/compile/index.js`, `src/wat/assemble.js`, `index.js` (as `flat`), `scripts/self.js`, `scripts/gen-prop-modules.mjs`, `test/invariants.js` (as `flat`), `test/types.js` (as `flat`) |
| `emitBlockBody` | `src/compile/index.js`, `index.js` (as `body`), `scripts/self.js`, `scripts/gen-prop-modules.mjs`, `test/invariants.js` (as `body`), `test/types.js` |
| `emitIdentitySafe` | `src/compile/index.js`, `index.js`, `scripts/self.js`, `scripts/gen-prop-modules.mjs`, `test/invariants.js`, `test/types.js` |
| `resolveClosureTableParamLattice` | `src/compile/index.js` only |
| `FIRST_CLASS_BUILTIN_NAMES` | `src/prepare/index.js` only |
| `emitBoolStr` | `index.js` (as `bool`), `scripts/self.js`, `scripts/gen-prop-modules.mjs`, `test/invariants.js` (as `bool`), `test/types.js` (as `bool`) |
| `emitIndex` | `index.js` (as `idx`), `scripts/self.js`, `scripts/gen-prop-modules.mjs`, `test/invariants.js` (as `idx`), `test/types.js` (as `idx`) |
| `buildArrayWithSpreads` | `index.js` (as `spread`), `scripts/self.js`, `scripts/gen-prop-modules.mjs`, `test/invariants.js` (as `spread`), `test/types.js` (as `spread`) |
| `emitTypeofCmp` | none found — exported, zero external consumers today |
| `materializeMulti` | none found |
| `emitLoopFreshBoxed` | none found |
| `emitDecl` | none found |
| `toBool` | none found |

The last five are still kept in the shim (removing an export is not a pure
move and STABILITY.md's own public-surface discipline argues for keeping
it) but are worth naming: nothing outside `emit.js` currently imports them.

**Why this stays acyclic** (load-bearing for the whole plan): the file's own
header says it — *"The emitter table (`emitter` export) is copied into
`ctx.core.emit` by `reset()`; language modules add/override entries to
extend dispatch."* Concretely: root `index.js` is the one place that pulls
the "hook set" out of `emit.js` (`emit, emitVoid as flat, emitBlockBody as
body, emitBoolStr as bool, emitIndex as idx, buildArrayWithSpreads as
spread, emitIdentitySafe`) and threads it into
`beginSession({ emitter, hooks: {...} })` → `reset(emitter, globals,
hooks)`, which installs `ctx.core.emit = {...emitter}` and `ctx.bridge =
hooks`. Every OTHER consumer that needs `emit`/`emitIdentitySafe`/etc. —
`src/bridge.js` (which `emit-assign.js` and every `module/*.js` file import
from, **not** from `emit.js` directly: `src/bridge.js`'s own header says
*"`module/*` imports from here, not `src/compile/emit.js`"*) — reads them
back off `ctx.bridge.*` at *call* time, never a static import of
`emit.js`. Grepped: **zero** `module/*.js` file imports anything from
`compile/emit.js` (nine files mention it only in comments). This means the
188-declaration split below never has to thread state through `module/*.js`
or `emit-assign.js` at all — they're already insulated by the existing
runtime indirection.

## Module-level mutable state — there is none to migrate

Unlike `vectorize.js` (whose split had to bundle four bare module-level
`let`s into one exported `vecState` object and move a `registerResetHook`
call), **`emit.js` has zero top-level `let`, zero `class`, and zero
`registerResetHook` call**. Every piece of state any of its 188 declarations
touches across calls lives on the externally-owned `ctx` singleton
(`ctx.func._expect`, `ctx.func._selfAccumConcat`,
`ctx.func._arrayLiteralNeverEscapes`, `ctx.types.loopGuardHi`,
`ctx.core.emit`, `ctx.core.stdlib`, …) — confirmed by grep, and stated
outright in the file's own header: *"Side effects go to `ctx.runtime.*`,
`ctx.core.includes` (via `inc()`), `ctx.func.uniq`, and `ctx.features.*`."*
This makes the split strictly simpler than vectorize's: **no shared mutable
object needs inventing, no reset-hook needs relocating** — every new module
just imports `ctx` from `'../../ctx.js'` independently.

The one thing that *is* module-scoped, evaluated once at load time, and
must not be reordered relative to its members: `LEADING_STRATEGIES` and
`TYPED_STRATEGIES` (arrays of function references, built from `const X =
[funcA, funcB, …]`). Both arrays and every function they reference live in
the same proposed module (`method-dispatch.js`, see below), so this is a
non-issue — confirmed by the dependency scan, not assumed.

## Dependency-graph method

A throwaway Node script (`scratchpad/strip.mjs`, `scratchpad/dep-graph.mjs`
— NOT in the repo) walks the file char-by-char tracking comment/string/
template-literal state (including nested `${ }` interpolation, which is
common here — `` `$${t}` ``-style temp names appear on hundreds of lines),
blanks non-code text to spaces (preserving line/column structure — the
stripped file is itself `node --check`-clean, which is a strong signal the
template-nesting tracker is correct end-to-end, not just on spot checks),
then does identifier-boundary matching against the 188 declared names per
declaration body. A second pass does the same at emitter-object-*property*
granularity (56 property/spread starts, found by brace-depth tracking) so
family placement for the 188 helpers can be checked against what each of
the ~65 individual AST-op handlers actually calls, not just what the
2,170-line `emitter` object calls in aggregate.

**One false positive, found and corrected by manual read, not assumed
away**: the raw scan reported `unresolvedDateMethod → emitter →
emitMethodCall → TYPED_STRATEGIES → tryGenericEmitter →
unresolvedDateMethod` as a 5-node cycle. Reading `unresolvedDateMethod`
(line 4133 in this snapshot) shows why: `dateAuxFallback(recv, method, (r,
emitter) => emitArity(emitter) <= 1 ? emitter(r) : emitter(r,
...argNames), …)` — `emitter` there is a **local callback parameter**
shadowing the top-level `emitter` binding, not a reference to it. Grepped
every other raw occurrence of the bare word `emitter` in the file (46 lines
total, the overwhelming majority doc-comment prose like "the collection
emitter" / "the generic emitter"): the only two real references to the top-level
`emitter` object from inside the file are `'for'`'s own recursive
re-emission arm (`emitArm = () => emitter['for'](null, cond, step, body)`,
used when the typed-bounds-versioning guard re-emits the loop) and
`'while'`'s one-line delegation (`emitter['for'](null, cond, null, body)`) —
both already inside the same proposed `control-flow.js` module (see "Central
deviation" below). With that edge removed, the 5-node chain is not a cycle
at all.

**Two real cycles, found by Tarjan's algorithm on the corrected graph**
(`assign.mjs` in scratchpad; zero cross-module edge violations after
placement, verified programmatically against every one of the 559 edges,
not spot-checked):

- **13-member SCC**: `emit, emitDecl, liftOptionalChain, toBool,
  emitIdentitySafe, emitIdentitySafeArms, storedValueNarrow, argIR,
  emitCallArgs, emitBoolStr, tryConcatChain, tryConcatBufferDecl,
  tryI32Index`. Root cause: `emit()` must call `emitDecl()` **directly**
  (not through `ctx.core.emit['let']`) — the file's own comment explains
  why: *"under self-compile the table reference is a closure value, and a
  runtime spread of >8 args into a closure call silently drops arguments…
  a direct call to the module-local binding compiles as a real direct
  call."* `emitDecl` (573 lines — the single biggest function in the file)
  in turn calls `tryI32Index`/`tryConcatBufferDecl`/`emitCallArgs`/etc.,
  which call back into `emit()` to emit sub-expressions. Every member is a
  `function` declaration (never a `const () =>`), so a circular *ES module*
  import between two files would actually be safe here (hoisted bindings,
  and nothing in this cluster runs at module-evaluation time — only inside
  a later `compile()` call) — but the plan below keeps the whole SCC in one
  file anyway, the conservative and reviewable choice, not a reliance on
  that hoisting argument.
- **2-member SCC**: `emitVoid ⇄ emitBlockBody` (mutual recursion — a block
  body emits each statement via `emitVoid`, which routes a nested `{}`
  through `emitBlockBody`). Small (115 lines); folded into the same module
  as the 13-member SCC since `emitVoid` is also one of the 13's direct
  callers-in (nothing in the 13 needs `emitBlockBody` back, so this could
  have been separate, but co-locating costs nothing and reads better).

No other cycle exists. Everything else is a genuine DAG, verified.

## Central deviation from a pure textual move: the `emitter` object itself

`export const emitter = {` spans lines 5708-7864 — **2,170 lines**, larger
than the entire proposed module budget on its own, and by a wide margin the
single biggest top-level declaration in the file (the next-largest,
`emitDecl`, is 573). Unlike every other top-level name, this one cannot be
relocated as an atomic unit and still hit the size target — it must be
decomposed.

The file's own section banners (`// === Spread operator ===`, `// ===
Statements ===`, …, ten in total) already partition its ~65 AST-op
properties into exactly the families used below. The mechanical move is:
each family module exports a plain object (`export const statementOps =
{ ';': …, '{': …, … }`), and a new `src/compile/emit/index.js` assembles
the original `emitter` via spread: `export const emitter = { ...spreadOp,
...statementOps, ...assignmentOps, ...incdecOps, ...arithmeticOps,
...comparisonOps, ...logicalOps, ...bitwiseOps, ...controlFlowOps,
...callOps }`, in the sections' original textual order.

This is **not a novel technique introduced by the split** — the object
already spreads `Object.fromEntries(...)`-built groups into itself four
times internally (`-=`/`*=`/`/=`; the six bitwise-compound ops; `++`/`--`;
`+1`/`-1`; `&`/`|`/`^`/`<<`/`>>`) for exactly this reason (many similar ops,
one shared shape). Extending the same idiom to module-sized groups is the
smallest possible deviation from a pure move, and it is behavior-identical
by construction: spread/`Object.assign` concatenate each source object's
own key order, and every AST-op string is used as a key in exactly one
family (they're mutually exclusive dispatch names — no two sections define
the same key, so there is no override-order to get wrong). **Verified, not
assumed, that nothing downstream is order-sensitive**: `ctx.core.emit` is
read exclusively via bracket lookup (`ctx.core.emit[op]`) everywhere except
one place, `src/autoload.js`'s `Object.keys(ctx.core.emit)` diff — which
captures the *before* snapshot into a `Set` and filters by `.has()`, i.e.
order-independent, and is scoped to per-*module* registration diffs anyway
(runs long after `emit.js`'s own base copy already landed). No `for…in` over
either `emitter` or `ctx.core.emit` exists anywhere in the repo.

**One real textual edit is required, contained to one new file**: `'for'`
and `'while'` both call `emitter['for'](...)` — a genuine reference to the
*fully assembled* top-level `emitter` binding (safe today only because
arrow-function bodies are lazy: `emitter` is unbound while the object
literal is still being built, but fully bound by the time either handler
actually *runs*). Once `'for'`/`'while'` move into their own
`controlFlowOps` object in `control-flow.js`, both call sites must rename
`emitter['for']` → `controlFlowOps['for']` (the local object under
construction, same lazy-closure argument, just a different binding name).
Two call sites, one file, one identifier rename — everything else in this
plan is a byte-for-byte relocation.

## Module plan (`src/compile/emit/`, topological order — later modules may
import earlier ones, never the reverse; verified with zero violations
against the real edge set, not just this table's intent)

Shared/infra (no family-specific logic):

| # | file | original lines | lines | contents |
|---|------|----------------|-------|----------|
| 1 | `shared.js` | 92-114, 174-182, 617-669, 683-698, 3118-3123, 3145-3146 | 109 | `stringOps`, `isI32Num`, `isNumArm` — genuinely cross-family (Arithmetic + Bitwise + Logical); `CMP_SET`/`isCmp`/`BOOL_EXPR_OPS`/`isCanonicalBoolExpr` — used by `toBool` (dispatch.js) *and* Logical's `&&`/`||`; `eagerSelectOK`/`selectCondOK`/`boolEagerBody` — same dual use; `REF_EQ_KINDS` — Comparisons' `emitLooseEq` *and* Logical's `?:`; `isLit1`/`foldOperandPure` — Arithmetic's `%` *and* Comparisons' `emitTypeofCmp`/`effectFoldSeq`. Every member here has ≥2 family consumers, confirmed by the property-level scan, not proximity |
| 2 | `i32-bounds.js` | 380-490 | 111 | the i32-overflow-safety proofs (`opBound`, `mulFitsI32`, `i32Mag`, `mulBoundedFaithful`, `mulRangeFitsI32`, `addFitsI32`, `addBoundedFaithful`, `addRangeFitsI32`, `subRangeFitsI32`, `addLiteralFitsI32`, `subLiteralFitsI32`) plus the loop-guard-hull channel (`loopGuardHi`, `boundedHi`, `boundedLo`) — used by `compoundAssign` (assignment.js), the `+`/`-`/`*` handlers (arithmetic.js), **and** directly by `'for'` (control-flow.js, via `loopGuardHi`) — three-family shared, not one family's private helper |
| 3 | `first-class.js` | 254-307 | 54 | `FIRST_CLASS_UNARY_MATH`, `FIRST_CLASS_BUILTIN_BODY`, `FIRST_CLASS_BUILTIN_NAMES` (export), `builtinFunctionValue` — builtins-as-first-class-closure-values; needed by `emit()` itself and by `src/prepare/index.js` externally |
| 4 | `dispatch.js` | 90-91, 187-194, 203-212, 614-616, 735-792, 1363-1405, 1449-1460, 1476-1781, 1920-2504, 2706-2902, 3005-3064, 3897-3921, 4900-4919, 7878-8144 | 1,596 | the SCC-forced core — see table below |
| 5 | `bigint.js` | 5014-5019, 5108-5540 | 439 | BigInt joint-domain dispatch — see table below |

Family modules (each = the emitter object's own section(s) + the pre-emitter
helpers proven private to it by the property-level scan):

| # | file | original lines | lines | contents |
|---|------|----------------|-------|----------|
| 6 | `call-args.js` | 1824-1861, 2505-2705, 3652-3896 | 484 | spread/argument marshalling: `attachSigMeta`, `materializeMulti` (export), `emitSpreadCopy`, `buildArrayWithSpreads` (export), `parseCallArgs`, `emitBulkPushSpread`, `emitSpreadElementLoop`, `emitAsValue`, `emitSingleSpreadMethodCall`, `emitMultiSpreadMethodCall`, `emitMethodCallSpread` |
| 7 | `method-dispatch.js` | 670-682, 1461-1475, 3922-4690 | 797 | the 12-strategy `obj.method(args)` chain: `COLLECTION_METHODS`, `STR_INDEX_METHODS`, `storedValue`, `LEADING_STRATEGIES` (context-free strategies 1-4: `tryFlatObjectMethod`, `tryConcatBufCharCodeAt`, `tryCharCodeAtFast`, `trySpliceInsert`, `tryFnPropCall`), `TYPED_STRATEGIES` (receiver-typed strategies 5-12: `tryBoxedDelegate`, `dateAuxFallback`, `unresolvedDateMethod`, `trySidecarToPrimitive`, `tryStaticDispatch`, `tryRuntimePtrTypeFork`, `tryRuntimeNumberMethod`, `trySchemaClosureCall`, `tryGenericEmitter`, `bigintMethodTargets`, `tagDynamicMethodResult`, `tryDynamicPropCall`, `externalMethodFallback`), `emitMethodCall` (the dispatcher itself) |
| 8 | `call.js` | 1339-1349, 1782-1823, 4691-4899, 4920-5013, 7788-7863 | 432 | direct/closure/generic call emission + the `=>`/`()` properties: `isUserFunc`, `emitSpeculativeCall`, `emitBuiltinCall`, `emitDirectFunctionCall`, `tryDirectClosureCall`, `tagFnArrayDispatch`, `recordClosureTableCallSite`, `emitGenericClosureCall`, `emitUnknownCalleeCall` |
| 9 | `instanceof.js` | 5541-5578, 5597-5707 | 149 | the whole `instanceof` family: `foldInstanceof`, `INSTANCEOF_TAG`, `emitTagInstanceof`, `typedCtorNameOf`, `emitTypedInstanceof`, `emitErrorInstanceof`, `emitInstanceof` — single consumer (the `'instanceof'` property in comparisons.js), self-contained, kept as its own file to match the original's own separate `// === instanceof ===` banner |
| 10 | `incdec.js` | 5579-5596, 6123-6187 | 83 | `WRAP_TRUNCATING_TYPED_CTORS`, `wrapTruncatingTypedElemName` + the `++`/`--`/`+1`/`-1` properties — **physical-proximity note**: these two helpers sit textually right next to the instanceof cluster (immediately before `emitTypedInstanceof`), but the scan shows their only consumer is the `+1`/`-1` property; `emitTypedInstanceof` never calls them |
| 11 | `arithmetic.js` | 115-140, 195-202, 213-253, 308-379, 6188-6560 | 520 | `peelI32`, `tryI32Arith`, `widensUnsigned`, `stripCanon`, `emitNeg`, `foldConst` + `+`/`-`/`u+`/`u-`/`*`/`/`/`%` |
| 12 | `comparisons.js` | 148-149, 491-613, 699-734, 793-933, 2903-3651, 6561-6572 | 995 | `NEG_NAN_MASK`, `emitTypeofCmp` (export), the char/substring index-compare fusion (`stringLiteral`, `intIndexIR`, `emitSingleCharIndexCmp`, `emitSubstringEqCmp`), the loose/strict-eq machinery (`numericVal`, `STRICT_PRIM`, `nullableOperand`, `peelIntCmp`, `i32TopBitClear`, `i32EqSound`, `CHEAP_PURE_OPS`, `isCheapPureVal`, `SIDE_EFFECT_OPS`, `isSideEffectFree`, `matchVoidLocalStore`, `effectFoldSeq`, `emitLooseEq`, `mayCarryRawBool`, `emitStrictEq`, `cmpOp`, `needsToNumberCoercion`, `looseNumberEq`, `mayReadBoxedValue`, `intConstValue`, `bigintUnsignedBound`, `bigintConstValue`) + `==`/`!=`/`instanceof`/`===`/`!==`/`<`/`>`/`<=`/`>=` — biggest family module by helper count |
| 13 | `logical.js` | 141-147, 150-173, 183-186, 934-1074, 6573-7024 | 628 | `NAN_MINTING`, `canonNum`, `canonArm` (the NaN-canon trio — used ONLY here, despite `isNumArm`/`isI32Num` next door being shared — see shared.js), the range-check fusion (`rangeBound`, `fuseRangeCheck`, `fuseRangeCheckOr`, `combineFusedAnd`, `combineFusedOr`) + `!`/`?:`/`&&`/`||`/`??`/`void`/`(` |
| 14 | `bitwise.js` | 1406-1448, 7025-7110 | 129 | `INT_MIN_I32`, `tryIntDivTrunc` + `~`/`&`/`|`/`^`/`<<`/`>>`/`>>>` — **physical-proximity note**: `tryIntDivTrunc` is declared at line 1406, in the middle of the call/decl-emission neighborhood (right before `argIR`), not anywhere near the Bitwise section; its only consumer is `'|'`'s `(x/y)\|0` idiom fold |
| 15 | `statements.js` | 1265-1299, 1350-1362, 5711-5981 | 319 | `canThrow`, `emitFinalizers` + `...`/`;`/`{`/`,`/`let`/`const`/`export`/`block`/`throw`/`catch`/`finally`/`return` — **contains the flagged concurrently-edited region, see Risks** |
| 16 | `control-flow.js` | 1075-1338, 1862-1919, 7111-7787 | 964 | the loop-unroll machinery (`freshenUnrolledScalarBindings`, `unrollSmallConstFor`, `FORIN_UNROLL_MAX`, `FORIN_UNROLL_BUDGET`, `forInBodyCost`, `keysRoSrc`, `unrollForIn`, `HOIST_CMP`, `immutableLenBound`, `extractHoistableLiterals`), `emitLoopFreshBoxed` (export) + `if`/`for`/`switch`/`while`/`label`/`break`/`continue` — `'for'` alone is 529 lines, the single biggest AST-op handler in the file; contains the `emitter['for']` → `controlFlowOps['for']` rename (2 sites, both here) |
| 17 | `assignment.js` | 5020-5107, 5982-6122 | 229 | `compoundAssign` + `=`/`+=`/`-=`/`*=`/`/=`/`%=`/`**=`/`&=`/`|=`/`^=`/`>>=`/`<<=`/`>>>=`/`||=`/`&&=`/`??=` |

**`dispatch.js` contents** (module 4 — the SCC-forced core, listed
separately since it doesn't map to one emitter section):

| lines | name | role |
|---|---|---|
| 90-91 | `SELF_AWARE_OPS` | op names whose handler needs its own AST node passed through (read by `emit()`'s generic dispatch) |
| 187-194 | `HOST_GLOBALS` | host global names (`WebAssembly`, `globalThis`, …) auto-imported when referenced as a value |
| 203-212 | `isHoistTemp` | true iff a name is a `hoistNestedCalls`-synthesized temp (used by `emitDecl`) |
| 614-616 | `emitBoolStr` (export) | stringify a BOOL operand to `"true"`/`"false"` |
| 735-735 | `I32_INDEX_OP` | AST op → wasm i32 op, for index arithmetic |
| 736-754 | `tryI32Index` | lower a pure i32 `+`/`-`/`*` index tree natively |
| 755-781 | `emitIndex` (export) | emit an array-index expression in i32 arithmetic |
| 782-792 | `isI32ArithTree` | true iff expr is a pure i32-leaf `+`/`-`/`*` tree (emitDecl-only) |
| 1363-1405 | `toBool` (export) | coerce a node to an i32 boolean, folding `&&`/`||` |
| 1449-1460 | `argIR` | emit a call arg once, choosing `emit` vs `emitIdentitySafe` |
| 1476-1480 | `storedValueNarrow` | narrow-admission carrier-boxing twin of `storedValue` |
| 1481-1493 | `nodeIsNullishBigintMerge` | true iff node is a genuine BigInt/nullish `?:` merge |
| 1494-1555 | `coerceArg` | coerce an emitted arg IR to match a callee param |
| 1556-1563 | `padArgs` | pad an emitted-args array to a signature's arity |
| 1564-1588 | `emitCallArgs` | emit a node list as coerced+padded call arguments |
| 1589-1726 | `tryConcatChain` | fuse a ≥3-leaf string-concat chain into one alloc+copy pass |
| 1727-1764 | `concatBufEligible` | every use of `name` is `.length`/`.charCodeAt` (buffer-SRoA gate) |
| 1765-1780 | `tryConcatBufferDecl` | dissolve a concat-chain decl into raw `(buf, len)` locals |
| 1781-1781 | `TYPED_HI_MASK` | NaN-box high-word mask for a speculated TYPED receiver |
| 1920-1931 | `rejectAmbiguousBoolIdentity` | reject a BOOL∪NUMBER binding whose identity later escapes |
| 1932-2504 | `emitDecl` (export) | emit `let`/`const` initializations as typed `local.set` — 573 ln, the biggest function in the file |
| 2706-2718 | `emitVoid` (export) | emit a node in void (statement) context |
| 2719-2737 | `setFlowVal` | record a name's flow-sensitive valType fact |
| 2738-2763 | `FLOW_LOOP_OPS` | the loop AST ops (for flow-fact invalidation) |
| 2764-2800 | `nestedWritesOf` | names written at a nested position, split by loop-crossing |
| 2801-2902 | `emitBlockBody` (export) | emit a `{}` block as a flat statement list, with early-return refinement |
| 3005-3008 | `emitIdentitySafe` (export) | identity-safe re-emission of an ambiguous BOOL-merge node |
| 3009-3064 | `emitIdentitySafeArms` | the per-arm box decision `emitIdentitySafe` delegates to |
| 3897-3921 | `withNullGuard` | hoist+guard an optional-chain head into a temp |
| 4900-4919 | `resolveClosureTableParamLattice` (export) | merge closure-table-array call evidence into each element |
| 7878-7912 | `liftOptionalChain` | rewrite `a?.b.c` to an explicit nullish-guarded non-optional chain |
| 7913-8144 | `emit` (export) | the recursive AST → IR entry point; dispatches via `ctx.core.emit[op]`, **not** a direct call to any family module — this is why the family modules can all import `dispatch.js` without `dispatch.js` importing any of them back |

**`bigint.js` contents** (module 5):

| lines | name | role |
|---|---|---|
| 5014-5019 | `I64_ARITH_OP` | compound-assign arithmetic symbol → i64 op suffix |
| 5108-5110 | `numLiteralNode` | true iff node is a plain numeric literal (BigInt-mix proof) |
| 5111-5185 | `bigintMixReject` | throw when a proven-BigInt/proven-Number literal mix is provable |
| 5186-5227 | `bigIntDomain` | static BigInt/Number/unresolved domain classification for one operand |
| 5228-5233 | `isBigIntCarrierBits` | runtime "is this f64 bit pattern a BigInt carrier" test |
| 5264-5284 | `bigIntDomainsCanMix` | does this binary node need the joint runtime BigInt/Number dispatch |
| 5285-5297 | `computedBoxOf` | plan query — should this computed result be boxed |
| 5298-5391 | `bigIntJointDispatch` | the runtime-forked BigInt-vs-Number binary op dispatch |
| 5392-5461 | `bigIntOperand` | read an operand as i64, guarding a maybeUndefined BigInt census read |
| 5462-5497 | `bigIntUnary` | unary twin of `bigIntOperand` (resolves to a value, not a throw) |
| 5498-5520 | `bigIntShiftIR` | BigInt `<<`/`>>`, sign-aware direction flip |
| 5521-5540 | `bigintMemberAssignTarget` | member `++`/`--` postfix old-value recovery, BigInt-typed |

Used by four families (Assignment's `compoundAssign`, Arithmetic's
`+`/`-`/`*`/`/`/`%`, Bitwise's `~`/`&`/`|`/`^`/`<<`/`>>`, and Comparisons'
`cmpOp` via `numLiteralNode`) — the most cross-cutting cluster in the file
after `dispatch.js` itself, confirmed by the property-level scan (not just
by the "BigInt" name suggesting it).

`src/compile/emit.js` becomes a re-export shim:

```js
export { emit, emitDecl, toBool, emitIdentitySafe, emitVoid, emitBlockBody,
  emitBoolStr, emitIndex, resolveClosureTableParamLattice } from './emit/dispatch.js'
export { FIRST_CLASS_BUILTIN_NAMES } from './emit/first-class.js'
export { emitTypeofCmp } from './emit/comparisons.js'
export { materializeMulti, buildArrayWithSpreads } from './emit/call-args.js'
export { emitLoopFreshBoxed } from './emit/control-flow.js'
export { emitter } from './emit/index.js'
```

…keeping every external import path (`'./emit.js'`, `'../compile/emit.js'`,
`'./src/compile/emit.js'`) stable — verified against all seven distinct
import statements found above, including the destructured/aliased ones
(`emitVoid as flat`, etc., which import by original name regardless of the
shim's own internal file layout).

`src/compile/emit/index.js` is the new assembly point (mirrors vectorize's
`index.js` role, but its job here is pure object-spread, not a dispatch
chain):

```js
import { spreadOp, statementOps } from './statements.js'   // spreadOp: the lone '...' catch-all
import { assignmentOps } from './assignment.js'
import { incdecOps } from './incdec.js'
import { arithmeticOps } from './arithmetic.js'
import { comparisonOps } from './comparisons.js'
import { logicalOps } from './logical.js'
import { bitwiseOps } from './bitwise.js'
import { controlFlowOps } from './control-flow.js'
import { callOps } from './call.js'

export const emitter = {
  ...spreadOp, ...statementOps, ...assignmentOps, ...incdecOps, ...arithmeticOps,
  ...comparisonOps, ...logicalOps, ...bitwiseOps, ...controlFlowOps, ...callOps,
}
```

## Verified cross-checks (grep + Tarjan, not assumption)

- `isI32Num`/`isNumArm`: called from Arithmetic (`+`), Bitwise (`~`, the
  five-op spread, `>>>`), and Logical (`?:`/`&&`/`||`/`??`, plus their
  `combineFusedAnd`/`combineFusedOr` support) — genuinely three-family,
  confirms `shared.js`.
- `loopGuardHi`: written/read by `boundedHi` (feeding Assignment +
  Arithmetic's overflow proofs) **and** read directly by `'for'`
  (control-flow.js) — confirms `i32-bounds.js` as shared infra, not
  Arithmetic-private, exactly the kind of finding physical proximity alone
  would miss (it sits textually right next to the purely-Arithmetic
  `addFitsI32` family).
- `wrapTruncatingTypedElemName`/`WRAP_TRUNCATING_TYPED_CTORS`: despite
  sitting in the same contiguous original block as `emitTypedInstanceof`
  (lines 5579-5632, no gap), the scan shows zero references from any
  instanceof-family function — the sole caller is the `+1`/`-1` IncDec
  property. Two different concerns, split into two modules.
- `tryIntDivTrunc`/`INT_MIN_I32`: declared at line 1406, textually inside
  the call/decl-emission neighborhood (between `unrollForIn` and `argIR`),
  but its only caller is the Bitwise `'|'` handler's `(x/y)|0` fold —
  moved to `bitwise.js` on the data, not the file position.
- `storedValue`: name-adjacent to `storedValueNarrow` (which genuinely is
  dispatch-core-private, called from `emitDecl`), but `storedValue` itself
  is called only by `unresolvedDateMethod` (method-dispatch.js) and the
  `'throw'` property (statements.js) — `emitDecl`/`emit` never call it.
  Placed in `method-dispatch.js`, imported one-way by `statements.js`.
- `isLit1`/`foldOperandPure`: used by both Arithmetic's `%` handler and
  Comparisons' `emitTypeofCmp`/`effectFoldSeq` — confirmed two-family,
  moved to `shared.js` (originally assigned to comparisons.js alone on a
  first pass; the topological-order validator caught the resulting
  backward edge and forced the correction — see method below).
- Only `src/compile/index.js`, `src/wat/assemble.js`, root `index.js`,
  `scripts/self.js`, `scripts/gen-prop-modules.mjs`, `test/invariants.js`,
  `test/types.js` import directly from `emit.js`; every other
  `compile/emit.js`/`emit.js` hit across the repo (~45 more) is a comment.

## Verification recipe

1. `node scripts/refactor-oracle.mjs check --ref main` must report clean —
   same corpus, byte-identical wasm at O0/O2/O3/size, for every specimen.
   This is the primary proof: it covers every one of the ~65 AST-op
   handlers actually firing, not just the ones a hand-picked test exercises.
2. `node test/index.js` (full suite, `npm test`) must stay green.
3. **Two architecture/lint tests hardcode `'src/compile/emit.js'` as a file
   path to statically grep and MUST be updated as part of the same change,
   or they will silently stop checking the code they exist to check** (both
   verified: neither currently matches its forbidden pattern in emit.js
   today, so they'd pass trivially post-split without ever re-scanning the
   moved logic):
   - `test/passes.js`'s `'passes: emission tier never writes durable
     analysis state (slice-4 exit grep)'` test walks `module/` and pushes
     one literal path, `join(ROOT, 'src/compile/emit.js')`, checking for
     `updateRep(`/`schema.vars.set(` calls. Needs to walk
     `src/compile/emit/` the same way it already walks `module/`.
   - `test/invariants.js`'s `'architecture: typed emitters consume
     TypedStoragePlan, not live ctor maps'` test hardcodes `files = [
     'module/array.js', 'module/typedarray.js', 'src/compile/emit.js',
     'src/compile/emit-assign.js' ]`. Needs the new module paths added
     (at minimum `method-dispatch.js`, where the typed-array method
     strategies land).
4. Tests that most directly exercise emission (run first, fastest signal):
   `test/invariants.js`, `test/types.js` — both import `emit`/`emitter`/
   `emitVoid`/`emitBlockBody`/`emitBoolStr`/`emitIndex`/
   `buildArrayWithSpreads`/`emitIdentitySafe` by name, so a broken
   re-export in the shim fails immediately, not just a behavior change.
5. `test/kernel-parity.js` / `test/kernel-oracle.js` (self-compile and
   byte-oracle correctness), `test/test262.js` (conformance, gated on
   Fail:0 per `test/test262-baseline.json`), `test/statements.js`,
   `test/errors.js`, `test/booleans.js`, `test/dyn-keys.js`,
   `test/unsigned.js`, `test/pointers.js`, `test/data.js`,
   `test/array-methods.js`, `test/parser-bugs.js` — the files whose own
   comments most densely cite specific `emit.js` handlers (grepped: 28+
   literal `"src/compile/emit.js"` comment citations across these twelve
   files alone), i.e. the ones most likely to have a regression test for
   exactly the code being moved.
6. `node --check` on every new file, then `node scripts/self.js` (the
   self-compile path) — it imports the same eight-name hook set as root
   `index.js` and is the second-most-sensitive consumer of the shim's
   exact export shape.

## Risks/unknowns

- **The flagged concurrently-edited region** (task-reported "~5935-5980,
  the `emitter` object") lands, in this snapshot's numbering, entirely
  inside the `'return'` property (5868-5981), which belongs to
  `statements.js`. This plan was not able to observe that edit directly
  (it is reportedly on `main`, not yet in this worktree) — the executing
  agent must re-check `git diff main -- src/compile/emit.js` immediately
  before cutting `statements.js`, and either sequence the extraction after
  that work merges, or manually reconcile the two diffs. Cutting
  `statements.js` from a stale mid-edit copy would silently drop or
  duplicate whatever that other session lands.
- **`dispatch.js` is ~1,596 lines, ~6% over the ~1,500-line target.** This
  is not a sizing oversight — it is the Tarjan-verified 15-member SCC
  (13 + 2) plus the handful of small helpers whose *only* caller is
  inside that SCC (e.g. `coerceArg`, `nestedWritesOf`, `TYPED_HI_MASK`) and
  therefore cannot move later in the topological order without creating a
  backward edge. The only ways to shrink it further: (a) accept a genuine
  circular *file* import between two of the SCC's members — safe here
  specifically because every member is a hoisted `function` declaration
  never invoked at module-evaluation time (verified: zero bare top-level
  call expressions in the whole file), but a break from this plan's
  otherwise-strict DAG discipline; or (b) internally restructure
  `emitDecl` (573 of the 1,596 lines) to shrink its own dependency
  footprint — a real code change, out of scope for a pure move. Flagged
  as a phase-3 candidate below, not fixed here.
- **Line numbers throughout this document are pinned to one snapshot** in
  a worktree under active multi-agent edit (see "Snapshot basis"). Treat
  every range as re-derivable from the scan method, not as a promise —
  the scripts that produced them (`strip.mjs`, `dep-graph.mjs`,
  `assign.mjs`) are throwaway and live only in this session's scratchpad,
  not the repo, per the task's own instruction; re-write equivalents (or
  ask for them) before executing rather than trusting stale absolute line
  numbers.
- **Not every one of the 559 one-way edges was individually read** — the
  SCC members, the one false positive, and the "physical proximity
  misleading" cases above were hand-verified against source; the
  remaining edges rest on the comment/string-stripped scan's own
  correctness (itself checked by: the stripped file being `node
  --check`-clean end-to-end, and the zero-violation result surviving two
  rounds of `shared`/`bigint` reordering that WOULD have surfaced a
  scan bug as a contradiction). Same epistemic status .work/archive/vectorize-split.md's
  own scan carried — a static scan, not a type system.
- **`comparisons.js` (995 ln) is the largest family module** and contains
  three genuinely distinct sub-concerns (typeof-compare, char/substring-eq
  fusion, loose/strict-eq) that happen to all funnel into `emitLooseEq`/
  `emitStrictEq`. It fits comfortably under the 1,500 target as one file,
  but is a candidate for a finer split if a future pass wants one — not
  proposed here since nothing forces it.

## Outlier decomposition candidates (phase 3, after the pure-move split)

- `emitDecl` (573 ln, `dispatch.js`) — by far the largest single function;
  handles every `let`/`const` initializer shape (plain, destructured,
  array/object literal, spread, string-buffer SRoA, closure). Look for a
  per-shape dispatch table once it's isolated in its own file — the same
  match/rewrite seam .work/archive/vectorize-split.md flagged for its own largest
  function (`tryDivergentEscapeVectorize`, 567 ln).
- `'for'` (529 ln, `control-flow.js`) — the single biggest AST-op handler;
  unroll-dispatch, typed-bounds versioning, and the plain walk are three
  fairly separable phases already visually blocked apart by the source's
  own comments.
- `tryRuntimePtrTypeFork` (112 ln, `method-dispatch.js`), `emitLooseEq`
  (184 ln)/`emitStrictEq` (135 ln) (`comparisons.js`), `tryConcatChain`
  (138 ln, `dispatch.js`) — each is a single function doing several
  case-by-case things; evaluate a match/build split per-function once
  moved, same as vectorize's own phase-3 list.

Plan authored before any code was moved; decomposition specifics get filled
in as each module is actually split (phase 3 commits), matching
.work/archive/vectorize-split.md's own closing convention.
