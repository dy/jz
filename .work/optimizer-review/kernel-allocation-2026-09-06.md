# The kernel's allocation — 2026-09-06

The recursive self-compile (`jz × jz`, 346 modules, 7.1 MB of source) trapped
at the wasm32 ceiling inside the second summary run: the arena keeps every
byte a phase allocates, so a phase is measured by its heap delta, not by its
live set. Method: the kernel's phase marks (`scripts/kernel-marks.mjs`,
`$S/scratchpad/rec-marks.mjs`) name the phase; an overlay kernel with marks
inside the phase (`test/_self-overlay-build.mjs`) names the pass; a driver
program compiled with the native compiler that imports the pass and reports
`__heap_mark()` deltas per call names the shape, in seconds per iteration
(`$S/scratchpad/drv/`, `sdrv/`); V8's sampling heap profiler with collected
objects included names the native hot spots but not the kernel's, whose
lowering allocates where V8 does not.

## Phase deltas on `jz × jz` (MB)

| phase | before | after |
|---|---:|---:|
| front | 631 | 456 |
| summary (each of three runs) | 1,346 / 1,409 / — | 86 / 88 / 88 |
| plan:collectFacts (five runs) | 146+133+37+26+25 | 120+116+33+25+24 |
| plan:narrowSignatures | 507 | 336 |
| analyzeFuncs | 365 | 269 |
| emitFuncs | (not reached) | 339 |
| emitClosures | (not reached) | 513 + 162 |
| pullStdlib … optMod:optimizeFuncs | (not reached) | 109 … 75 |
| assembled, checkpoint 1 | (not reached) | 3,176 → 235 (parked 85 MB, 146K strings) |
| link | (not reached) | 1,023 (tape 10.7M nodes) |
| optimize (watr tail), checkpoint 2 | (not reached) | 1,213 → 239 |
| encode, final | trap after `plan:summary`, 3,950 | 3,900; **completes**, 395 MB of headroom |

`node scripts/kernel-gate.mjs --gate recursive`: **GREEN**, `jz × jz`
14,195,809 bytes in 61 s, the probe compiles and runs (`$S/scratchpad/gate-rec.json`).

The summary's 1.35 GB was 40 MB of fixpoint (22 rounds, 7M expression visits)
and 428 MB of demand pass; the demand pass reads through the query view,
`queries.at(scope).kindOfExpr(n)`, at 360 bytes per call in the kernel and
none natively.

## Root causes, each with its pin

1. **The summary allocated per visit** (`src/summary/index.js`, `query.js`,
   `kind.js`): a closure per member read (`done`), per branch and per arm
   (`onPath`, `narrowed`), an array per call (`args(…).map(expr)`), per
   arithmetic node, per `proves`; `poisonAll` a closure per schema per site
   (3.7 GB natively); `literalShape` and `schemaKey` per literal per round;
   `isLiteral` a slice per block; `loopAssigns` a walk of the loop per round.
   Now: one argument stack (`ks`, `sp`), one refinement stack (`rNames`,
   `rPriors`, `unwind`), structural facts read once per node (literal sids,
   assigned names, typeof predicates, definite inits, accessor names,
   parameter names), monotone poison marks, singleton member lists, memoized
   closure unions; `arith(op, a, b)`. The corpus (143 rows) and the self graph
   compile byte-identically. Pin: `summary`, `summary-queries`; the self graph
   oracle.
2. **A closure body boxed every parameter and capture that a nested closure
   captured again** (`src/compile/analyze-scans.js` `boxedCaptures`): the
   walk's `seen` held the closure ABI's `__env`/`__aN`, not the closure's own
   parameters or captures, so each was "not yet declared" and got a heap
   cell at every entry. `view` in the query module made 36 cells (288 bytes)
   before its cache check. Now the walk starts with what is in hand.
3. **Boxed cells were allocated at entry**, before an early return
   (`src/compile/func-entry.js` `placePreboxedLocalInits`): now before the
   first statement that mentions one (`emitBlockBody`, `ctx.func.preboxAt`).
4. **A dynamic method call built an argument array** per call
   (`src/compile/emit/method-dispatch.js` strategy 11: 48 bytes, the whole
   kernel's `ctx.core.emit[…](…)`, `summary.at(…).x(…)` traffic): the closure
   leg now passes the arguments inline (`ctx.closure.argIR`); the host leg
   alone builds its array, from the same temps.
5. **`Object.fromEntries` stored a number key raw** (`module/object.js`):
   `o[-1]` never found `[-1, v]`; the summary's `TYPEOF_NAME[code]` missed in
   the kernel, so `typeof x === 't'` refined nothing there (and, once the
   rewrite cached the predicate, refined to the `undefined` mask: the
   `boolconst` parity red). Keys are ToPropertyKey'd as `o[k] = v` does. A
   negative literal index now folds to undefined on an array, a typed array
   or a string alone (`module/array.js`); on an object it reads the property.
   Pin: `objects: numeric keys are property keys …`.
6. `TYPED_CTOR.test(callee)` on every call: a regex on an SSO string spills 8
   bytes (`__str_to_buf`); guarded by `startsWith('new.')`. The spill itself is
   open (a static scratch is unsafe under reentrancy).
7. **jzify wrapped every node's rewrite in a closure** (`withBuiltinScope(node,
   fn)`) and copied every node whether or not an operand changed: an
   enter/leave pair and copy-on-change (front 591 → 456 MB).
8. **The kernel checkpointed after the optimizer only**: the assembled module
   (6.1M nodes, 85 MB parked with strings interned and integers packed) is now
   parked before link with link's and the optimizer's inputs (`assemble`,
   `linkAssembled`, `tailFacts`; nothing after `assemble` reads `ctx`), so
   the front's and the analyses' 3 GB are released before the tape is built.
   `test/self-checkpoint` forces both checkpoints on every compile.
9. **A function's write to a typed global stood as the global's length for
   that function** (`src/compile/analyze/trackers.js`): a read before the
   write folded to the written length. `src/optimize/fn.js`'s effect cache
   resets to `new Int8Array(0)` and grows when the op is past its length: the
   test held every call and the cache grew per call, 150 KB per function in
   link's body passes (3.4 GB on the kernel's own graph: the trap after the
   first checkpoint). A global's length is the program-wide fact alone. Pin:
   `static storage: a typed global rewritten inside a function keeps no
   per-function length`, red on `cd41cc54`.

Pins for 2–4: `test/allocation.js` (zero bytes per call at O0/O1/O2: a
dynamic method call, a cache hit, an early return; the mutated capture's cell
alone otherwise), red on `cd41cc54` at 96 / 192 / 16 bytes.

## Gates

- Kernel parity, kernel oracle, self-families on the fresh kernel: 37/38
  (fromCharCode, known).
- Native `npm test` at `c9e56b8f`: **4277 pass / 42 fail / 1 skip**, the 42
  the integration record lists (the kernel-oracle rows are green). At
  `36d58177`: **4304 / 18 / 1**: the result-carrier and BigInt families,
  fromCharCode, the receiver-HASH and catch-local pins, `watr bug: memory64`.
- `kernel-gate --gate functional,sequences,recursive` on the kernel built at
  `c9e56b8f` (`$S/scratchpad/k-new7.wasm`, `gate-k7.json`, `gate-rec.json`):
  sequences GREEN 9/9, recursive GREEN, functional 12/20 (the same eight
  byte divergences as before, every row's results right). At `36d58177`
  (`k-final.wasm`, `gate-final.json`): recursive GREEN, 13,806,419 bytes in
  54 s, 466 MB of headroom; sequences GREEN.

## Correctness slices after the gate (`00f0c8c7`–`36d58177`)

- A compound member write evaluates its receiver and key once
  (`src/compile/emit/assignment.js` `stagedReference`): an effectful receiver
  or key is staged into a temp carrying the expression's facts; a key with an
  effect takes the receiver first. The 23 member-reference pins and the
  complex BigInt member pin are green.
- A runtime write of `undefined` to a module object wins over the literal's
  init-time sidecar value (`module/collection.js`, `__hash_get_local_hm`: a
  miss reported as TOMB_NAN). Pin in `objects`.
- Dynamic loose equality converts a boolean beside a number (`__eq`);
  `Number`/`Boolean` as values convert (`.map(Number)` returned its strings).
  Pins in `bool-identity`.
- Open, found on the way: a boolean returned by a closure into an array
  reads as a number (`[1, 0].map(x => !!x)[0]` is `typeof` number: the
  carrier family); a string beside a number in `==` stays unequal (the
  documented non-coercion, `emitLooseEq`'s STRING specializations depend on
  it); the jz subset rejects an IIFE's default parameter reading the
  enclosing function's locals (`analyze-scans.js` passes the seed instead).

## The encoder (watr `5a78a13`)

watr writes the code section into packed byte buffers: one `Uint8Array`
buffer for the section, one scratch per function body (`makeByteBuf`), the
per-function item lengths kept for the metadata offsets. A plain object of
methods (`push(...bytes)`, `append`, `length`), since the file is compiled
by the kernel. jz's outputs are byte-identical (the corpus and the self
graph). Compiled by jz, the builder miscompiled three ways, each on a
receiver of unknown kind (the builder is a closure in a table, its `out`
parameter untyped), each now pinned:

10. **A tagged BigInt carrier beside an operand with no evidence took the
    i64 path unconditionally** (`src/compile/emit/bigint.js`): `at` copies
    `out.length` and the program holds a BigInt elsewhere, so the plan tags
    `at`; `out.length - at` had the 'tagged' domain beside 'skip', which the
    joint dispatch declined, and the fallback emitted `i64.sub` over the
    Number's bits (the item length came out subnormal). Now a flagged
    operand ('tagged' or 'census') beside an unresolved one takes the joint
    dispatch: the flagged side's flag decides both arms, the partner unboxes
    in the BigInt arm and coerces in the Number arm; `+` builds the Number
    arm through its own handler over the temps, so a string partner still
    concatenates. Pin: `bigint tag: a tagged carrier beside an unresolved
    operand dispatches on the tag`.
11. **`out.length = n` on an unknown receiver resized an array alone**
    (`src/compile/emit-assign.js`): the runtime helper returned on a
    non-array and the write was lost (`scratch.length = 0` kept the previous
    body's bytes). Now the receiver's tag decides: an array resizes, anything
    else takes `__dyn_set` with the value as written.
12. **`out.push(...bytes)` on an unknown receiver ran the array builtin**
    (`src/compile/emit/method-dispatch.js`): both own-property probes
    (strategy 10 and the pointer-type fork) skipped a spread call, so the
    bulk push wrote over the object's memory. `ownMethodCall` passes a
    spread call's arguments as one array through every probe.
    Pin for 11–12: `objects: an unknown receiver's length write and spread
    push reach the object`.

Recursive gate on the kernel built with the packed encoder
(`$S/scratchpad/k-final3.wasm`, `gate-final3.json`): **GREEN, 13,858,907
bytes in 55 s, heap 2,928 MB, 1,367 MB of headroom** (3,806 MB and 489 MB
before); sequences GREEN; kernel families 37/38; functional 12/20 (the
same eight). Native at this slice: **4306 pass / 18 fail / 1 skip**.

The encoder still allocates 2.7 GB after the second checkpoint, 200 bytes
per output byte. A driver compiled natively (`$S/scratchpad/edrv`,
watr's `compile` with `__heap_mark` deltas per site, on a 417 KB module):
`cleanup` 25 MB of 83 (it copies the tree), the first pass 42 MB
(`normalize` flattens each body through `shift`, `unshift(...)`, `splice`
and `slice(1)` per instruction: 32–40 bytes each in the kernel), `instr`
9 MB, the rest under 3 MB each.

## The encoder's flattener (watr `03e7b70`) and the array at the heap top

watr's `normalize` reads its input as a work stack: a folded instruction
pushes its operands, then its op and immediates, back in reverse, and the
readers consume the stack's end, so no node is copied, shifted, spliced or
re-queued; an `if`'s condition, head and bodies flatten straight into the
output in source order (the temp arrays copied every then-body once per
enclosing `if`); a body flattens into one scratch and is copied out exact
size; `cleanup` copies a node only above a change. The self-compile build
profile's one-shot in-place specialization of `cleanup` and `normalize`
(`scripts/build-profile.mjs`, a source-spelling exception) is deleted: the
published source has the properties it patched in.

13. **An array at the heap top grew by copying** (`module/array.js`
    `__arr_grow`): a push loop paid every doubling (2,112 bytes for 100
    pushes). The array's storage that ends at the heap top, above the reset
    mark, extends in place (1,040), as a string at the heap top does.

Inside the kernel on jz × jz (an overlay kernel with `__heap_mark` deltas
per encoder site, `$S/scratchpad/edrv/overlay-enc.json`, `rec-enc.mjs`):
normalize 880 → 595 MB with the if bodies in place, instr 322 (the ByteBuf's
`push(...xs)` takes a rest array per byte, 24 bytes: an engine gap, a rest
parameter that never escapes could read the argument slots), append 84,
meta+data 51. Recursive gate (`k-nw3.wasm`, `gate-nw3.json`): **GREEN,
13,860,120 bytes in 57 s, heap 1,260 MB, 3,035 MB of headroom**; the
encoder 2.7 → 1.0 GB after the second checkpoint; sequences GREEN; kernel
families 37/38; functional 13/20 (seven byte divergences, closures-classes
O2 now identical); native **4305 pass / 18 fail / 1 skip** with the
allocation pin added. A 30-minute gate timeout
at load 36 was contention, not the kernel (61 s alone).

## The closures' analysis and emission, by step (overlay kernel, jz × jz)

5,404 closure bodies: `analyzeClosureBodyForEmit` 267 MB (50.6 KB each),
`emitClosureBody` 314 MB (59.5 KB each); 2,523 functions:
`analyzeFuncForEmit` 247 MB (100 KB each). Inside the closure analysis
(`$S/scratchpad/edrv/overlay-cl.json`, `rec-cl.mjs`): mintRepresentationPlan
76 MB, reanalyzeBody 48, inferLocals 36, seedClosureFrame 34,
enterClosureFrame 33.5 (the frame's collections, 6.5 KB per closure),
boxedCaptures 17, mintTypedStoragePlan 11, the rest under 4. The
representation plan's body data (`representation-plan/body-data.js`
`buildBodyData`) is the largest single step and the subsystem the verified
result contract replaces (PLAN.md, next milestone): not polished here.

## The carrier family, first slices (`9f07b9c9`–)

- A multi-value return's lanes and an inline callback's stored result take
  the container store's form; a typed array's `map` coerces the closure's
  result (`9f07b9c9`).
- A call's BigInt result through a name is read as tagged unless the callee
  is a known function the plan proved raw or a builtin (`readI64MayUnbox`,
  `isTaggedCallResult`); the plan treats a same-body local closure's
  possibly-BigInt result as boxed and registers the demand on the closure's
  body before its own plan is minted (`localClosureCallBoxed`); a
  self-referencing definite-BigInt def (`value = value | rhs()`) is a fresh
  raw producer, so `value` materializes tagged (`freshBigintProducer`);
  `collectLocalClosures` now sees zero- and multi-parameter closures (it
  read `['()', null]` as one parameter named null). A user `try` stays live
  around every BigInt arithmetic, bitwise and shift operator, whose joint
  dispatch throws the mixed-domain TypeError at runtime (`canThrow`).
- watr `deb62e4`: `coalesceLocals` treats the statements after a block that
  never falls through as conditional; the try/catch shape's handler write
  joined a dead pointer's slot and the normal path read the pointer
  (`caught` after a try at O2).
- Native **4313 pass / 13 fail / 1 skip**: the captured-shift, caught-mixed,
  heterogeneous-array, typed-some and catch-local pins are green. Recursive
  GREEN (`k-final6.wasm`, heap 1,261 MB); kernel families 37/38; functional
  13/20.
- Then (`7b139ec3`–): an `any` parameter the demand pass denied keeps JS
  semantics (the summary's `numericDenied`), `BigInt(null)` throws,
  `new Array(n)` holds holes (`arrayHoles` on a numeric-fill array keeps the
  identity compares live and canonicalizes a hole in arithmetic), an absent
  element read as an index becomes -1, a mixed-domain compound takes the
  binary form, every method call's kind is the summary's, the summary keys
  a closure by its body too, `rewriteBlocks` copies only above a change
  (the four emit-time loop passes copied every function body: the
  emitFuncs churn, and the summary lost every closure's identity), the
  runtime's `__to_str` formats a boxed BigInt. Native **4321 / 6 / 1**
  before the last, recursive GREEN (heap 1,263 MB).

- Then (`e08ade69`–): an array element is one tagged slot (the literal's
  and the index write's raw narrow are gone; a read, a write's value and an
  inline callback's element parameter unbox at their i64 consumer; the
  compound's rebuilt binary and the callback body reach the plan through
  `compoundOf`), the summary keeps a two-tag union beside a nullish tag,
  drops a callback's surplus arguments instead of escaping the receiver, and
  answers `elemKindOf(name)` again (a duplicate key had hidden it since
  `c9cee767`); the callback hint's presence-blind census fallback is gone.
  Native **4324 / 5 / 1**; kernel oracle GREEN; recursive GREEN (13,892,087
  bytes, +32 KB: the unbox at element reads; heap 1,264 MB).

- Then (`92af8763`–): every closure result crosses its ABI tagged and the
  plan reads every unnamed call as a box; `at()` resolves a one-parameter
  arrow by its parameter name (closure-emit had seen NONE for every `v => …`
  parameter and typed string parameters NUMBER by usage alone); `>>>` on a
  sometimes-BigInt throws at runtime; the boundary's result semantic is the
  summary's. Recursive GREEN (13,890,892 bytes, heap 1,264 MB).

## Open

- The BOOL veto (`hasClosedBool`, representation-plan/body-data.js) keeps a
  parameter of every kind from materializing: a caller boxes a BigInt into
  it, the callee reads the box's bits (the recorded family "a boxed BigInt
  into a parameter of every kind", watr's `slebSize`, the memory64 limits).
  Without the veto the kernel fails to compile itself and functional falls
  to 6/20: the kernel's own code holds a materialization the emitter cannot
  bear. Find that one before lifting the veto.
- A named function used as a value as a closure-set member (built,
  withdrawn): sound only once every call path the summary does not model
  escapes its arguments; 1,224 kernel functions changed kinds and the
  kernel failed to compile itself.
- `300n == 300` is false: loose equality across BigInt and Number.
- The encoder's remaining 1.0 GB: the rest-parameter array per `push` (an
  engine gap), the per-`if` head and per-`call_indirect` reader arrays, the
  exact copy of each body. Then emitClosures (675 MB: 50 KB of analysis and
  52 KB of emit per closure), emitFuncs (339), narrowSignatures (336),
  analyzeFuncs (269), the frame's forty collections per function (13 KB).
- `a.unshift(...t)` on an array fails to compile ("stdlib '__to_str' was
  requested but never registered"); `a.shift()` followed by `push` on a
  1000-element array reallocates (680 bytes per pair).
- The self-compile build profile still rewrites watr's printer flatness
  checks (`printRewrites`): the callback form's boolean result widens under
  the O1 kernel, the result-carrier family.
- The SSO spill in `__str_to_buf`; the view object per scope (20 closures);
  `for…in` over a defaults record (`Object.keys` cached once now).
- The memory model (regions) remains the architectural answer for the
  phases' churn; the allocation audit shrinks what regions would have to
  reclaim and fixes what every compiled program paid.
