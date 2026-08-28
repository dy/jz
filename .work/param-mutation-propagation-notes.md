# fix/param-mutation-propagation — findings log

Branch: fix/param-mutation-propagation, worktree scratchpad/pm, base 8da34240.
Task: root-cause + fix the residual "object mutated inside a function via a
PARAMETER does not propagate back" defect both watr-stream and
fix/literal-method-typed-index set aside (see their notes: watr-stream
worktree `.work/streamcode-bug-notes.md` "Fix attempt 1: partial", and this
base commit's `.work/literal-method-typed-index-notes.md` bottom section).
8da34240 already has the `.subarray`/tryRuntimePtrTypeFork fix — confirmed
this is a DIFFERENT, still-open defect.

## Repro confirmed at 8da34240

Full `snippet-bytebuf.js` (copied from scratchpad/diff/, harness at
`repro/bytebuf-full.mjs` + `repro/bytebuf-full.src.js`, NOT committed —
scratch only): count=0 MATCHES native (0), count=1..3 silently returns 0
(should be 1287/5688/13824), count=5 traps `unreachable`. Reproduces at every
optimize level 0-3 identically.

## Bisection (repro/bisect-plain.mjs, repro/bisect-closure.mjs,
## repro/bisect-fields.mjs — all scratch, not committed)

1. PLAIN object-param mutation through a standalone function (field
   reassign, typed-array-field growth/reassignment, nested call depth 2,
   loop 0/1/2 iterations, read-only control) — ALL MATCH native. Ruled out:
   "object crosses a function-parameter boundary as a copy instead of a
   pointer" as the general mechanism (task's suspect list, item 1) — plain
   field/array mutation via a parameter is sound.

2. Object with an ATTACHED CLOSURE METHOD (`b.push = (v) => {...}`,
   post-hoc property assignment, the makeByteBuf idiom), mutated by calling
   that method FROM a separate function that received the object as ITS OWN
   parameter (`function writeOne(out,v){ out.push(v) }`) — MISMATCH
   (`buf.n`/`buf.buf[i]` read back wrong: 0/undefined instead of the real
   value; a hardcoded-index variant traps "memory access out of bounds"
   instead — same defect, different garbage-read manifestation).

   Control shapes that all MATCH (isolate the exact trigger):
   - Same closure-method called DIRECTLY in the function that owns the
     local (`buf.push(...)` in `main`, no parameter indirection) — MATCH.
   - Same closure-method called via a variable CAPTURED by a nested
     function (no parameter passing at all) — MATCH.
   - A closure method with a NON-collision name (`c.bump = () => {c.n++}`,
     called via a param-received receiver) — MATCH.
   - Direct field/typed-array writes via a param-received receiver, NO
     method-call syntax at all (`out.buf[out.n]=v`) — MATCH.

   => The trigger is specifically: METHOD-CALL syntax (`out.push(...)`)
   where (a) the method name collides with a jz Array-builtin name
   (push/pop/shift/unshift/splice/flat/flatMap) AND (b) the receiver `out`
   is a bare parameter of the function doing the call (not a local the
   function itself constructed/owns).

## Root cause (high confidence, traced via `--wat --names` dump of the
## minimal repro — repro/min1.src.js / repro/min1.O0.wat, scratch)

The WAT for `writeOne`'s body compiling `out.push()` is UNCONDITIONAL
jz-Array-header codegen (`__ptr_offset`, length/capacity loads at
obj-8/obj-4, `__arr_grow_known`) — ZERO runtime ptr-type branching, i.e. no
shadow probe ran at all. Traced to:

1. `src/compile/infer.js` `ARRAY_INDUCERS` set (push/pop/shift/unshift/
   splice/flat/flatMap, ~line 131-133), consumed by `methodEvidence`
   (~line 135-199): seeing `<param>.push(...)` syntax is treated as HARD
   PROOF the parameter is `VAL.ARRAY` — no check for whether the receiver
   might instead be a plain object with an OWN `push`-named closure
   property (exactly the makeByteBuf shape). This violates the module's
   own documented contract (infer.js header: "Ambiguous bindings stay
   nanbox-tagged f64. Default is never wrong, only sometimes wider than
   necessary" — this rung IS sometimes wrong).

2. This source only ever runs against `sig.params` filtered to names NOT
   already typed by an upstream source (`src/compile/index.js` line
   733-735: `candidates = sig.params.filter(p =>
   !ctx.func.localReps?.get(p.name)?.val)`, then `inferLocals(body,
   candidates)`) — i.e. it is explicitly a LAST-RESORT fallback for
   parameters the (trustworthy) cross-function call-site fixpoint
   (`paramReps`, gated by `paramValTrustworthy` in `src/param-reps.js`)
   could NOT resolve. By construction, whenever this heuristic is the
   source of a param's `val`, it is a GUESS, never a corroborated proof —
   but nothing downstream retains that distinction; it's written into
   `ctx.func.localReps` via `inferLocals` → `updateRep` (infer.js
   ~306-313) exactly like a hard proof would be.

3. `src/compile/emit.js` `emitMethodCall` reads `vt = valTypeOf(obj)`
   (~line 4647) and threads it into the strategy chain (`TYPED_STRATEGIES`,
   ~line 4615-4619) with no provenance tag. None of the ARRAY_INDUCERS
   method names have a receiver-specific `.array:<method>` emitter
   (verified: only `.array:at` and `.array:concat` exist in module/
   array.js; push/pop/shift/unshift/splice/flat/flatMap are ONLY
   registered as the bare generic `.push` etc) — so strategy 7
   (`tryStaticDispatch`) never fires for these; dispatch actually lands on
   strategy 10 (`tryGenericEmitter`, ~line 4387-4449).

4. `tryGenericEmitter` ALREADY HAS the correct defense — an own-property
   shadow probe (`sidecarOverride`: check the receiver's own dyn-prop
   sidecar for a same-named closure FIRST, call the builtin only if none
   found) — proven correct by an existing regression test
   (test/parser-bugs.js "own prop shadows array builtin on unknown
   receiver (d.map)"). But that probe is gated on `vt == null` (~line
   4415: `if (vt == null && ctx.closure.call && ...)`). Because step 1-2
   above wrongly hands this function a NON-null `vt` (`VAL.ARRAY`), the
   probe is skipped entirely and it falls straight to `callFlat(obj)` (the
   unconditional builtin call, ~line 4449) — silently invoking the
   built-in Array push machinery on an object that was never a jz Array,
   instead of the user's own `push` closure. Depending on what garbage
   bits sit at the assumed length/capacity header offsets this either
   silently no-ops (small-buffer case — the observed "stays at 0") or
   reads/writes out of bounds (the observed trap case) — same defect,
   environment-dependent surface.

The `objectShadow` guard already in `tryGenericEmitter` (`vt === VAL.OBJECT
|| vt === VAL.HASH`, ~line 4400) doesn't help either — it protects a
receiver ALREADY (correctly) known to be OBJECT/HASH; ours is wrongly
tagged ARRAY, a different branch of the same function entirely.

## Planned fix (not yet applied as of this checkpoint)

Widen `tryGenericEmitter`'s shadow-probe trigger condition from `vt ==
null` to also cover: `obj` is a bare identifier that is a PARAMETER of the
function currently being compiled (`ctx.func.current?.params?.some(p =>
p.name === obj)` — the exact structural check `src/ir.js` already uses for
`isGlobal`/`isConst`/`isBoundName`, ~line 1821-1832) AND `vt === VAL.ARRAY`
AND `method` is in the same `ARRAY_INDUCERS` set infer.js uses.

Why "is a parameter" is the right (and necessary) scope, not a special
case: `inferLocals`'s candidates are EXCLUSIVELY `sig.params` (see point 2
above) — a plain local variable's `val` can never reach VAL.ARRAY through
this guessy path (locals get real construction evidence via
`analyzeValTypes` instead: literal `[]`, `new Array()`, assignment flow —
all genuine proofs). So "receiver is a parameter" is exactly the
(complete, not over-broad) set of receivers this specific unsoundness can
reach — extending the probe to non-parameter locals would tax the
hot/common proven-array case (`let a = []; a.push(x)`, ubiquitous in jz's
own self-hosted compiler) for no soundness gain.

Plan:
1. Move `ARRAY_INDUCERS` from `src/compile/infer.js` to `src/kind-traits.js`
   (a dependency-free leaf both infer.js and emit.js can import without a
   cycle) so both share one definition (DRY) instead of duplicating the
   method-name set.
2. `src/compile/emit.js` `tryGenericEmitter`: broaden the `vt == null`
   gate on the shadow-probe branch to also fire for `vt === VAL.ARRAY &&
   ARRAY_INDUCERS.has(method) && typeof obj === 'string' &&
   ctx.func.current?.params?.some(p => p.name === obj)`.
3. Re-run the full bisection battery (repro/bisect-*.mjs, scratch) +
   snippet-bytebuf.js full repro to confirm MATCH at all optimize levels.
4. Add permanent pins to test/data.js (positive: field reassign,
   typed-array field growth, nested call depth 2, loop 0/1 iterations, the
   push-collision-through-param shape itself; negative/WAT-shape control:
   a read-only param keeps its current codegen unchanged).
5. Full battery: test/index.js, kernel build + JZ_TEST_TARGET=jz.wasm
   test/index.js, kernel-parity.js, kernel-oracle.js, bench.js size gates.

## Status at this checkpoint

Root cause fully traced and written up above; fix not yet coded. Resuming
next to implement steps 1-5.
