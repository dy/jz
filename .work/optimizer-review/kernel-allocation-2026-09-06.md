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

## Open

- The encoder (watr's `compile`) allocates 3.6 GB in the kernel after the
  second checkpoint: the headroom is 395 MB. Next by the same method: the
  encoder's churn, then emitClosures (675 MB: 50 KB of analysis and 52 KB of
  emit per closure), emitFuncs (339), narrowSignatures (336), analyzeFuncs
  (269), the frame's forty collections per function (13 KB).
- The SSO spill in `__str_to_buf`; the view object per scope (20 closures);
  `for…in` over a defaults record (`Object.keys` cached once now).
- The memory model (regions) remains the architectural answer for the
  phases' churn; the allocation audit shrinks what regions would have to
  reclaim and fixes what every compiled program paid.
