# jz — TODO

Full working history (hunts, refutations, landing paths, process lessons)
archived in .work/archive-todo-2026-07.md — grep it before re-deriving
anything; every kernel bug class and perf frontier has a banked dissection.

## Status (2026-07-31, current truth — re-audit #5 reconciled)

ERROR-MESSAGE EVAPORATION INVESTIGATED — PREMISE OVERTURNED
2026-07-31 (read-only, empirical envelope + byte-cost measurement):
"Errors are just their message" is DOCUMENTED DELIBERATE design
(README:230,251; test/errors.js:685-693 pins it as a tripwire "so a
future error-object model surfaces here deliberately") — NOT a bug.
new Error(msg) compiles to msg itself (passthroughError, module/
core.js:1750-1769); there is NO storage and NO slot to unwire — a
.message fix requires upgrading the value to a tagged carrier
(minimal OBJECT shape is the sane route). SIZE PREMISE REFUTED by
measurement: object machinery ~60-100B (same as any object
literal); the 5KB cost people associate with errors is the
orthogonal String()/Ryu pull. REAL GAP FOUND: all 37 $__jz_err
runtime sites throw the SAME sentinel 0 (TypeError/RangeError/
bounds/JSON all indistinguishable; only fs.js forwards real errno)
— the README's "numeric codes" plural OVERCLAIMS; there is no code
table. Host boundary already normalizes any escaping throw into a
real Error (interop.js:709-744 decodeThrown, wrapped.thrown
carries the original). SPLIT: (1) DISTINCT per-site integer codes
= near-zero cost (i32.const N), aligns behavior WITH docs, no
semantics change — LANDABLE, queued for writer lane; (2)
Error-as-minimal-OBJECT (.message/.name/instanceof, ~60-100B when
constructed, no-arg fast path preserved, === semantics change
needs a sweep) = changes DOCUMENTED PINNED semantics — USER
DECISION; (3) runtime-code→message resolution (host-side table in
decodeThrown = zero wasm cost, or opt-in verbose flag) = product
decision, USER-GATED.

WRAPPER-INLINING DECLINED WITH EVIDENCE + JESSIE CHARACTERIZATION
COMPLETE 2026-07-31 (read-only investigation, instrumented scratch
reproduction of the jessie compile): subscript's space$9→space$4→
space chain survives THREE independently-correct gates — (1)
program-facts callSites records only bare-identifier callees
(isFuncRef); property-valued closures (parse.space = fn, captured
via const space = parse.space) never enter sitesByCallee at all;
(2) even if admitted, inline.js:580's loopDepth>=2 cap excludes
space$4 AFTER the base while-loop legitimately fused in — the
correctly-motivated no-nested-loop-compounding guard; (3) watr's
inlineOnce blocked by 3 call refs (2 defensive trampolines),
multi-caller inline capped at 90 nodes vs ~150, inlineWrappers'
shape (pure-conversion spine) doesn't match real ASI logic. HONEST
PAYOFF: only the call/return hop is overhead — the bucket's 13.4%
is mostly real relocatable work; recoverable = low-single-digit %
of parse time, negligible on 1.393x. VERDICT: not worth building
at jz level (callSites blast radius for a single-consumer idiom +
the loop-depth wall); bounded watr-side option banked (generalize
inlineWrappers to single-loop/one-callee/bounded-pre-post, fits
WRAPPER_INLINE_MAX 360) — buildable later, not active. JESSIE IS
NOW FULLY CHARACTERIZED: 1.393x, every engine-side lever exhausted
(dict campaign, value-set resolver, receiver-HASH, array-literal
admission, wrapper inlining) or declined with evidence; residual =
V8-IC/call_indirect hard tail (dispatch-rewrite-class project or
claim scoping — user decision).

VM + DICT DISSECTED: HARD TAILS, ~0% CLOSABLE 2026-07-31 (fresh
paired ABBA both directions, quiet machine; WAT surgery checksum-
held 750010871): both reds are JSC-ONLY — jz beats every V8-based
engine (node 1.3-1.5x ahead) AND every AOT wasm rival (c/rust/go/
zig/AS/MoonBit; dict beats c-wasm and rust-wasm 1.8x on the
identical probe shape). Current gaps: vm ~1.17-1.18x, dict
~1.25-1.27x vs bun/JSC (dict drifted DOWN from the 1.34 snapshot —
general levers since). WAT already optimal: vm's if/else opcode
chain compiles to O(1) br_table, fully inlined, pure i32; dict's
probe chain carries ZERO bounds checks (AND-mask proven), clear
loop auto-SIMD'd. vm's only strippable guard (reg[a] store, a<u4)
surgically measured ~2% noisy AND is semantically load-bearing for
arbitrary bytecode (the 00eabd0f interpreter class; cursor-
versioning can't reach a random-access register index). Liftoff/
tier-up confound ruled out. VERDICT: the JSC tight-integer-loop
class (vm, dict, crc32 per the archived JSC sweep) is a RIVAL
EXECUTION MODEL advantage (adaptive JIT on JS source vs AOT wasm
in V8), not a jz codegen deficiency — no emission lever exists at
the WAT level. USER DECISION SHAPING: "every case faster than ALL
JITs" hits this structural class; options = claim scoping (the M4
machine-scoping precedent) or accepting standing reds on this
class.

ARRAY-ELEM-SCHEMA LEVER TRACED TO ROOT, TARGET NOT CLOSABLE BY ONE ADMISSION
2026-07-31 (infer.js+narrow.js, test/inference.js +3 pins; battery 3163/0/6,
JZ_DEBUG_INVARIANTS leg on inference/objects/dyn-keys clean, kernel-parity
33/33 on fresh dist, kernel-oracle 9/9, selfhost 21/21, watr 35/35): traced
the "JESSIE RE-DISSECTED" entry's named lever (subscript's dispatch-loop
descriptor records never unify into one arrayElemSchema) to its exact broken
link via direct ctx inspection on the compiled jessie bundle (paramReps dump
at narrowSignatures' arr/schema fixpoint). subscript's `register(d) =>
lookup[c] = fn?.ops ? dispatch([d, ...fn.ops], fn.tail) : dispatch([d], fn)`
(parse.js:164-165) builds the ops array via an array-LITERAL constructed and
passed directly as a dispatch() call ARGUMENT (never bound to a local first)
— `inferArrElemSchema` (src/compile/infer.js) only recognized bare names and
call-results as call-site args, never inline array literals, so `dispatch`'s
`ops` param never got an arrayElemSchema fact at all (confirmed: field absent
from paramReps, not even poisoned — BOTTOM forever). FIX LANDED (general,
real, minimal): inferArrElemSchema now resolves an inline array-literal
argument's common element schemaId via `state.callerParamFacts('schemaId')`
(same channel the plain `schemaId` mergeRule already uses), mirroring
analyze.js's own literal-init observation one hop further out across the
call boundary; spread elements poison (fail-closed), matching the existing
`arr.push(...x)` precedent exactly. IMPLEMENTATION HAZARD CAUGHT BY THE
BATTERY: narrow.js's `runArrElemFixpoint` is a SHARED generic runner across
5 fixpoints (arrayElemSchema/Set/ValType/typedCtor/typedLen); naively
overloading its existing 4th positional arg for the new schemaId channel
silently broke `inferTypedCtor`'s own 4th-arg `callerSids` wiring — caught
by test/provenance-inference.js's `paramViaField` pin (a Float64Array-through-
an-object-field case, unrelated to arrays on its face) regressing to dynamic
dispatch. Fixed by threading the new fact through a dedicated 5th positional
arg instead of colliding with the 4th. Lesson: a "shared inferFn dispatch
signature" lattice has per-consumer positional contracts that look
interchangeable but aren't — verify against the FULL battery, not just the
target suite, before trusting a "safe, ignored extra arg" argument. HONEST
RESULT: the admission fires for the achievable case (array literal whose
element is a caller PARAM already schema-known — new positive pin, WAT shows
0 __dyn_get) and correctly stays generic for heterogeneous/spread shapes (2
new negative pins) — but subscript's REAL dispatch() call sites are BOTH the
achievable no-spread form (`dispatch([d], fn)`, first registration per char)
AND the spread form (`dispatch([d, ...fn.ops], fn.tail)`, every subsequent
registration sharing that char) — narrow.js's paramReps lattice merges
ACROSS ALL STATIC call sites of a function (2 here, not once per dynamic
registration), and the hard validating sweep poisons on ANY unresolved site,
so `ops`'s arrayElemSchema is null regardless. The spread's source (`fn.ops`)
is a property read on a closure RETURNED by a prior call to `dispatch`
itself, recovered through the dynamically-indexed global `lookup[c]` — proving
it sound requires whole-program alias tracking over that global (a function's
return value carries an own-property equal to one of its params, tracked
through arbitrary later reads of a global array), a materially larger, new
mechanism that would in practice only ever fire for this one idiom — building
it now would be exactly the forbidden "optimize the input, not the tool"
move. CONFIRMED EMPIRICALLY: compiled jessie bundle WAT is BYTE-IDENTICAL
before/after (85 `__dyn_get` call sites both ways; closure8 — the dispatch
loop, parse.js:144 — keeps all 18 of its own generic dyn-get sites reading
d.op/d.l/d.p/d.map/d.word/d.kw). Paired jessie bench not run — WAT identity
already proves 1.00 ratio, checksum unaffected (compile output unchanged
byte-for-byte for this program). RECOMMENDATION: do not chase the deeper
own-property/global-alias mechanism for this target; the landed admission is
sound, tested, and independently useful (any function receiving a literal
array-of-records call argument now classifies) but jessie's 1.393x gap stays
open — closing dispatch() specifically would need a dispatch-rewrite-class
project (per the prior dissection's own "hard tails" list), not an inference
admission.

JESSIE RE-DISSECTED FRESH 2026-07-31 (profile-driven, no hypothesis
inheritance; V8 --prof sampled ticks symbolized per wasm function +
checksum-held counter surgery, checksum 2418067300 exact):
HEADLINE — the gap is 1.393x MEDIAN (paired ABBA 4 rounds, jz
~2872µs vs v8 ~2068µs), NOT 1.85x; the stale figure is dead (the
dict campaign closed more than its per-slice pairs showed).
RANKED COSTS (share of parse ticks): dispatch closure (closure8,
parse.js:144, fires on 80% of 12,925 Pratt iterations) 29.7%;
space wrappers $4/$9 (comment-skip + block-vs-object disambig +
ASI newline, 3-hop composition over a zero-self-time base loop)
14.3%; step composition 13%; generic __dyn_get*/__hash_get* 5.7%;
__str_* 4.1%; char-scan/expr core ~8.6% (algorithmic parity with
V8). THE CONCRETE GENERAL LEVER: inside dispatch, descriptor
records ({op,l,p,map,word,kw} — monomorphic BY CONSTRUCTION at
every token()/keyword() site) are read via __dyn_get_expr 6,784x/
parse — the ops-array ELEMENT record shape is never unified into a
closed record type. Same inference class as the landed prec fix,
one more receiver shape: monomorphic array-of-records element
classification (arrayElemSchema unification for push-built module-
init record arrays). Honest estimate 5-10% of runtime closable →
~1.25-1.32x. HARD TAILS named: V8 IC on record reads + inlined
monomorphic closures vs call_indirect (structural short of a
dispatch-rewrite project); wrapper-flattening = smaller secondary
lever (2 call boundaries per token). Artifacts: scratchpad/prof/.

RECEIVER-HASH FILL LANDED + MEASURED 2026-07-31 (a6312d3d; full
gates: battery 3156/0/6 incl. dbg leg, kernel-parity 33/33 on fresh
dist, kernel-oracle 9/9, selfhost 21/21, watr 35/35): the design's
fill-never-correct principle held — classifyHashDictGlobals
(plan/scope.js) fills globalValTypes VAL.HASH via the allocator's
exact predicate, .has()-guarded, PLUS a race the design missed and
the implementation caught: materializeAutoBoxSchemas retroactively
binds schemas onto dot-written names — excluded via propMap consult
at fill time. WAT evidence: jessie __dyn_get 22→14 with 6 new
direct __hash_get_local sites; OPCODE classifies HASH; non-
qualifying benches byte-identical; P4 tripwire silent. PAIRED ABBA
(3 rounds jessie, 2 watr, quiet machine, checksums identical):
jessie 0.989 (HEAD ~2002µs vs prefill ~2024µs — real ~1% win, wasm
−300B); watr ~0.95 but noisy spread (honest: no regression, likely
small win, −400B). CONSEQUENCE (the load-dominates hypothesis now
also largely spent): even with prec loads LEAN, jessie's red barely
moves — the remaining 14 __dyn_get calls (lookup[c] closure table —
genuinely polymorphic, correctly not dict-mode) and/or other
machinery carry the hot cost. The dict-mode campaign is
ARCHITECTURE-COMPLETE (census + value-set resolver + moduleInit
coverage + receiver classification, all landed+gated); jessie 1.85x
needs a FRESH PROFILE-DRIVEN dissection next (no more hypothesis
inheritance — measure where time actually goes at current HEAD).

MODULEINIT DICT-CENSUS GAP FIXED 2026-07-31 (.work/dict-census-moduleinit-fix.md
implemented; Fix A 1f4fe762, Fix B a003ecd9; battery 3152/0/6 incl.
JZ_DEBUG_INVARIANTS leg, kernel-parity 33/33, kernel-oracle 9/9, watr
self-host 35/35, each gate re-run at both commits): Fix A unconditionally
merges initFacts.dynWriteVars in collectProgramFacts (program-facts.js,
one line); Fix B adds visitInit's missing MUTATE_OPS/`[]` dict-write branch
(mirrors visit()) and extends the moduleInitSlot memo cache from flat
{gen,obs} to {gen,obs,dictObs}, poison-preserving on cache-hit replay.
CONSUMER IMPACT AUDIT (full dynWriteVars consumer sweep, kind.js/analyze.js/
type.js/emit.js): Fix A's merge is not merely additive — it REPAIRS two
independently-reproduced, previously-live miscompiles for any global that is
BOTH statically-typed (array-elem-kind or object-schema) AND additionally
dynamically written ONLY from a bundled sub-module's moduleInit (`kind.js`'s
global arrayElemValType trust reading a stale elem-kind; `emit.js`'s
unrollForIn silently dropping a dynamically-added key) — neither shape was
covered by the existing suite, both confirmed by direct repro against the
pre-fix tree. REAL TARGET FIRES: compiling watr itself now gives
`__const_js$OPCODE` dictValueValType NUMBER (`__const_js$IMM` stays honestly
poisoned — its value is a computed `.slice()`, unproven by writeVT). jessie's
WAT is byte-identical at O0/O2/O3 pre/post both fixes (prec's dynWriteVars
membership comes from a function-body walk, untouched by either fix) —
confirms field isolation. PAIRED BENCH (bench/bench.mjs watr --targets=jz,
ABBA, git worktree at pre-fix f0d9879e vs current, --paired=4 both sides,
checksums identical both runs): watr self-host compile median 948µs post vs
1091µs pre — a real ~13% win, BEATS the design's own honest "small-or-nil,
load dominates" estimate (the compare-site coercion/dispatch removed around
already-emitted f64.gt turned out non-trivial at this scale). jessie paired
re-check: 2019µs vs 2021µs, noise-level, confirms no interaction.
PRE-EXISTING BUG FOUND AND BANKED, NOT FIXED (out of this task's scope): a
top-level `for...of` loop performing a computed-key dict write (`for (const
k of arr) D[k] = v`), compiled at optimize>=1, traps "memory access out of
bounds" at module instantiation — module/object.js:86's dictionary-mode
`__hash_reuse_eph` alloc (correctly falls through to fresh-alloc for a
non-HASH `old` pointer per its own guard) interacting unsoundly with the
for-of loop's own codegen under the optimizer. REPRODUCED ON THE UNMODIFIED
PRE-FIX-A BASELINE (f0d9879e), single-file AND bundled — fully independent
of this task's changes. CONFIRMED NOT the equivalent C-style `for` loop
(watr's actual const.js:161 shape, and every real target) — safe on both
trees, paired bench and all gates above used it. Fix A does newly make the
bug reachable for the bundled-moduleInit-only shape specifically (previously
accidentally shielded by the very dynWriteVars gap this task closes — not a
real guard). New test/inference.js fixtures (bundled moduleInit NUMBER
resolution, mixed-kind poison, cache-hit-replay-agrees-with-cold-walk) use
C-style for accordingly and document the finding inline. Candidate for a
future standalone bug hunt: bisect module/object.js's dict-mode branch vs.
for-of loop lowering under optimize>=1 to find the actual unsound
transformation (likely in watr's own generic WAT optimizer, which jz uses as
its backend for optimize>=1 — optimize:0/false is unaffected).
Also found: an untracked `.work/dict-receiver-hash-design.md` (receiver-HASH
classification follow-on design) appeared in the tree during this session,
authored by a spawned research subagent exceeding its research-only brief —
not part of this task, left untouched (untracked, not committed) for the
user to keep or discard.

WRITEVT STRENGTHENED + JESSIE COMPARE-SITE HYPOTHESIS REFUTED
2026-07-31 (6c721fba; battery 3149/0/6, parity 33/33 after dist
rebuild, oracle 9/9, dbg leg, selfhost 21/21): compositional
truthy/falsy/nonNullish VALUE-SET semantics for &&/||/?? in writeVT
({kind,bool} elements; BOOL's 2-element domain lets a filter fully
eliminate a `!x` guard through an enclosing ||), self-read
neutrality (SELF_READ join identity, fixed-point soundness comment
banked), param-kind channel (paramVts from paramReps, late
{fresh:true} call only). prec NOW FIRES (m4_parse$prec →
dictValueValType NUMBER); isStmt (asi.js:24-25) and loop-head
(loop.js:26) emit raw f64.le/f64.lt — yet paired ABBA jessie is
1.006 median (NO WIN, checksum identical). THE LOAD DOMINATES:
generic __dyn_get hash+probe per read swamps the post-load compare
saving. CONSEQUENCE: receiver-HASH classification of the LOAD is
now the empirically-proven necessary lever for jessie (and watr's
same-shape reads) — the value-kind half alone is architecture-
complete but perf-inert here. Remaining named site asi.js:74
p>=lvl blocked by two PRE-EXISTING general gaps (VT['[]'] literal-
string-key early-null gate fires before the dict branch for
prec[';']; VT['??'] general table still naive ta===tb join) — out
of census scope, candidates only if receiver-HASH design needs
them. MODULEINIT GAP DIAGNOSED (.work/dict-census-moduleinit-fix.md
— read before implementing): the dynWriteVars exclusion is an
OVERSIGHT not a guard (git archaeology: ffda6f86 touched 3 of 4
merge sites; c37111ee extended the block and missed it again), AND
a second independent gap — observeProgramSlots' visitInit walker
has no dict-write branch at all. Fix A (unconditional initFacts.
dynWriteVars merge — NOT gated on anyDyn, `OPCODE[nm]++` sets one
without the other) + Fix B (visitInit branch + moduleInitSlot cache
extended to {gen,obs,dictObs}). Ordering proven sound (single
atomic publication at plan/index.js:118, all consumers downstream —
structurally NOT the reverted-attempt class). Honest estimate:
OPCODE compare sites get f64.gt, IMM (STRING values) gets nothing,
load still dominates — closes the census coverage hole, won't close
watr 1.2-1.4x alone.

DICT-VALUE CENSUS IMPLEMENTED 2026-07-31 (commits a1345879 local
half, ea9ae8dc global census, 2b62b91b consumer wiring — all three
gates green: full battery 3145/0/6, JZ_DEBUG_INVARIANTS leg,
kernel-parity 33/33, kernel-oracle, watr self-host 35/35,
dyn-keys.js+data.js, each step run on the clean commit). Mechanism
built exactly per design, wall avoided structurally (verified: no
val/schemaId/globalValTypes mutation anywhere in the three diffs).
Soundness carve-out required touching emit.js's `nullableOperand`
too (not just kind.js — the design said "reuse that mechanism",
which lives there): without it `OPCODE[nm] === undefined` on a
proven-NUMBER dict const-folds to always-false for an unregistered
key, a real miscompile — proven by reverting the arm and watching
the new inference.js test fail. HONEST RESULT, empirically measured
(not predicted): NEITHER named real target actually fires.
(1) watr's OPCODE/IMM write (`OPCODE[nm] = code++`, const.js:161-
168) is a BARE TOP-LEVEL statement in a bundled sub-module —
exactly the pre-flagged blind spot (design §1c/§6: bundled
sub-module inits live in ctx.module.moduleInits, outside `ast`;
collectProgramFacts merges initFacts.dynVars but NEVER
initFacts.dynWriteVars, program-facts.js:313-366 — confirmed by
direct ctx inspection: `__const_js$OPCODE` has no globalRep at all,
dynWriteVars doesn't contain it). (2) subscript's real prec write
(`prec[op] = !lookup[c] && prec[op] || p`, parse.js:86) DOES reach
dynWriteVars (writes live inside the `token`/`keyword` functions,
not bare top-level) but the VALUE expression poisons: writeVT can't
resolve the bare param `p` (no ambient param-kind info flows into
analyzeBody's context-pure overlay), and `&&`/`||` require BOTH
arms to agree to survive — confirmed via direct ctx inspection:
`m4_parse$prec` gets `{dictValueValType: null}`. RESULT: watr and
jessie WAT are BYTE-IDENTICAL pre- vs post-change at O0/O2/O3 (git
worktree diff, both full self-hosted compiles). Paired jessie bench
(ABBA, 2 rounds each via bench/bench.mjs jessie --targets=jz):
1.87ms/1.87ms post vs 1.89ms/1.92ms pre — within noise, wasm size
identical (76.8 kB) both sides, consistent with byte-identical WAT.
The 31% jessie figure and the watr "real candidate" framing (design
§0.3) do NOT transfer to a measurable win under this design as
built — both require the SEPARATE receiver-HASH half (design §4's
noted future work) or a param-kind-aware writeVT extension to
resolve a bare parameter's value, neither of which this design
scoped. Mechanism stays landed (additive, zero regression risk,
sound carve-out, real fixtures proving it fires for the
independently-resolvable shape — a literal counter or constant) but
delivers no measured win on either named target as of this pass.

DICT-VALUE CENSUS DESIGNED 2026-07-31 (.work/dict-value-census-
design.md — read it before implementing; implementation order+gates
inside): value-kind fact (`dictValueValType`) as a wholly ADDITIVE
ValueRep field, censused inside observeProgramSlots' existing
two-call schedule (same lattice as observeSlot, same writeVT/
effectiveWriteValue resolvers), consumed ONLY at kind.js VT['[]']/
VT['.'] gated on dynWriteVars at READ time (never census time —
that ordering was the reverted fix's trap). Wall avoided
STRUCTURALLY, per link: no val/schemaId mutation → analyzeBody
caches untouched; consulted outside lookupValType → overlay can't
shadow; HASH not in UNBOXABLE_KINDS → schema-id channel unreachable.
GROUNDING CORRECTIONS from the design pass: (a) prec is missing TWO
facts (receiver HASH + value NUMBER) — this delivers value-kind
only, receiver-HASH is a separate future design under the same
field-isolation discipline; (b) bench/vm and bench/dict DO NOT
exercise this lever (both pure Int32Array kernels — the earlier
"likely underlies watr/vm/dict" was wrong for vm/dict, their reds
have another cause); (c) watr OPCODE/IMM IS a genuine match
(const.js:161,168, integer counters read hot in optimize.js);
(d) the archived 31% jessie figure measured a DIFFERENT mechanism
(durable-receiver probe doubling) — re-measure after landing, don't
carry it forward. Order: local half → global census → consumer
wiring (dyn-keys/data pin suites are the risk gate) → watr 35/35
in isolation BEFORE jessie → paired-truth re-measurement.

JESSIE DISSECTED 2026-07-31 (1.85x geomean confirmed, no drift; two
blueprint-tier levers, honestly not forced): (1) DOMINANT ~31%
(causally measured, archive:3479): subscript's `prec = {}` string->
number dict never resolves value-type NUMBER -- ASI's p>=lvl,
isStmt, loop-head compares all emit generic-value machinery (CLI's
own deopt-generic warning fires; 61.5% of module lines touch
generic helpers). SAME CLASS as the reverted global dict-mode
classification (recordGlobalRep can't see plan-time dynWriteVars;
broke watr self-host 30/35) -- needs the PIPELINE-ORDERING rework,
not scope-narrowing; likely also underlies watr/vm/dict JIT rows
(all dict-read-heavy). (2) closure-table lattice on lookup: FOUR
coupled blockers live-traced (digit-loop poison [capture-free
carve-out would be sound], ternary-of-CALLS write shape [needs
proveClosureFactory AST reuse], .ops/.tail chain-read idiom, and
the guarded alias). DESIGN GEM BANKED: `(fn=tbl[i]) && fn(args)`
alias-confinement is PROVABLY SOUND to admit (fresh local, single
use as immediate callee, no escape by construction) -- structurally
distinct from the rejected general bare-read. Identity-devirt
verified CORRECT to bail (lookup genuinely polymorphic). Token/
bounds levers ruled out (prior counter-verification). Minor: the
1.85x stays red pending the dict-mode rework.
RECEIVER-INFERENCE STRENGTHENED 2026-07-31 (the 9f46d517 follow-up;
inventory-first, honest scope): GUARD LANDSCAPE PROVEN NEAR-OPTIMAL
-- ratchet corpora are single EXPORTED fns with zero call sites =
unreachable by ANY receiver-proof lattice by construction (their
simple buf[i] shapes already guard-free via unswitchTypedParamLoop;
compound-index residual = loop-unswitch generality, declined per
the LoopPlan-terminal precedent); real bench: 12 guard sites in 57
cases, ALL the purpose-built Map-provenance class (test/provenance-
inference.js fences memo/map edges as deliberately open). REAL GAP
FIXED: ARRAY+TYPED caller mix spuriously poisoned under val's
exact-equality meet though __typed_idx dispatches both internally
-- new class-level recvArrTyped rep fact (reps/narrow/index thread,
mirrors hardParamVal timing), array.js guard sites short-circuit to
bare __typed_idx when it holds; both directions pinned. NAMED NEW
LATTICE DIMENSION (not forced): Map-value-kind census (Map.get/set
provenance) -- would close fftplan/provenance's 12 sites. Gates:
battery 3139/0 (+2), parity 33/33, oracle 9/9, kernel leg 2447/0,
ratchet +0, dbg green, watr 35/35.
EVIDENCE REFRESHED AT SETTLED HEAD 2026-07-31 (attempt 3, committed
WITH paired-verification protocol -- load 4.2 during run, dataset is
CONSERVATIVELY pessimistic, bias runs against our claims so it beats
both stale and discarded): headline JZ 1.00x, C 1.92x Rust 2.02x AS
2.11x Zig 2.17x V8 2.22x MoonBit 4.20x behind, native C 1.01x.
CAPTURED: dispatch strict JIT win (gone from all red lists), trace
1.462 EXACT match to paired truth (calibration signal), wordcount/
size wave. PAIRED-TRUTH ANNOTATIONS for the pessimistic rows (the
gate reads committed evidence; these reds are load-inflated and
self-correct next refresh): lz committed 1.130 / paired 1.033 BAND;
bezfit 1.062 / paired 1.004 ~LED; slices 1.058 / paired 1.041-1.043
BAND; watr-vs-v8 1.426 / paired 1.195 (real red, milder); glyfparse
1.214 = the ledgered JITTERY lane (per-round spread 0.90-1.32,
mechanism in WASM_TODO). Honest red list after annotation: sdf,
trace, shapes, glyfparse-jitter + watr/jessie/dict/crc32/colorpq/
resample/vm JIT rows. tinygo still 0/60 (CLT user-gated).
MIXED BOOL|NUMBER RETURNS FIXED 2026-07-31 (audit-#5 #2, the LAST
semantic item -- ALL THREE MISCOMPILES NOW CLOSED): return-site
boxing via carrierF64 gated on ctx.func.mixedAtomReturn = valResult
!== VAL.BOOL AND >=2 syntactic returns. The >=2 guard is the load-
bearing refinement over the reverted 190-failure broad fix AND over
the first draft (9 regressions measured: single-return BOOL helpers
whose kind resolves LATER than narrowValResults -- Set.has/Map.get
schema-dependent -- have no unbox wrapper; requiring a genuine
syntactic join restricts boxing to exactly the boolconst shape;
refined gate = 0 regressions, ratchet all +0 = uniform-NUMBER
functions byte-identical). SYMMETRIC boundary fix: interop i64Arg
boxes raw JS booleans into i64-carrier slots (f(true) lost identity
via f64ToI64(Number(true)) before jz ran). GENERALITY PROVEN:
typedarray isConst REVERTED to its natural number-or-false shape --
the compiler self-compiles correctly through the exact class; dist
rebuilt twice, both green. Oracle boolconst -> AGREE tier (209
assertions); ternary s?1:false arm pinned PENDING-FIX (different
mechanism: '?:' keeps BOOL∪NUMBER arms raw for arithmetic
correctness; needs consumer-context threading -- documented, not
forced). null/undefined-mixed already correct (atoms have no raw
form). Gates: battery 3137/0, dbg 3137/0, kernel leg 2447/0,
parity 33/33, oracle 9/9, ratchet 10/10 +0.
NUMERIC-KEY UNKNOWN-RECEIVER SOUND 2026-07-31 (audit-#5 #1 CLOSED):
receiver-kind guard replaces the unsound array-only fast path --
one tag test (ptrTypeEq ARRAY||TYPED, ~2 i32 ops after hoistPtrType
CSE) gates __typed_idx (reusing the SAME i32-narrowed vi -- the
load-bearing detail; a fresh f64 re-derivation violated i32 pins
and bloated hot loops) vs __dyn_get_expr ToPropertyKey. Pin FLIPPED
to JS truth (o[n] reads 9); perf pin rewritten to assert the honest
guard shape. SIBLINGS already sound (write/in/delete verified).
Receiver inference strengthened: X.from -> VAL.TYPED (kind-traits).
REAL BUG caught en route by the fuzz gate: unswitchTypedParamLoop's
cloneRead guard-collapse deleted a hoistPtrType-shared tee's
defining occurrence -> second read fell into the dead dyn arm;
fixed by hoisting the condition as a deduplicated dropped stmt.
RATCHET RE-BASELINED with open eyes: buf/nest/slice/ring/condref/
fgather +8..127% STATIC loop-body ops (each formerly-unsound site
now carries guard + cold-arm code; runtime = 2-op guard, cold arm
never executes for real arrays; synthetic corpora are unproven-
receiver-dense by design; real bench sizes spot-checked sane).
NAMED FOLLOW-UP: strengthen receiver inference (param receiver
lattice) so unknown receivers become RARE, shrinking the static
cost back -- the guard is the sound fallback, not the common path.
Gates: battery 3131/0, parity 33/33, kernel leg 2447/0, ratchet
10/10 re-baselined, dbg green, watr 35/35.
LOOPPLAN UNIFICATION TERMINAL 2026-07-31 (the designed do-not-force
verdict, full catalog banked): the incremental trio's shared-walk
design was attempted and correctly REFUSED -- tryVectorize (full
recursive stmt walk + lane inference + AoS idxTees + mirror stores
+ standalone-tee admission), tryReduceVectorize (single-expression
walk, stores forbidden, ALL tees rejected -- opposite policy, own
widenF32 rule), tryMemCopyFill (no walk: two static laneAddr calls,
REJECTS viaLocal, requires bare-i32 base, never registers teeName)
differ on EVERY axis; a shared scanAddresses needs 8-10 knobs to
save <20 thin lines because matchLaneAddr/_offsetLocalStride/
offsetTees ALREADY did the real unification (slices 1-6). The 3-line
post-scan gate stays per-recognizer (its argument differences ARE
the differing soundness conditions). LoopPlan's honest terminal
state: scaffolds unified (15/16 on the dispatch plan), fact classes
hoisted, remainder justified-private WITH catalog. The from-scratch
affine/alias/dependence vision remains a REDESIGN project, not an
incremental path -- recorded as such, not as debt.
MODULE-SCOPE PER-ITERATION CLOSURES FIXED 2026-07-31 (audit-#5 #3;
unification, not a parallel copy): module top-level compiles via
buildStartFn, and depth-0 loop-body lets were GLOBALIZED (depth
tracks only fn nesting) -- closures emitted global.get = last
iteration's value. FIX: collectLoopDeclNames+bodyCapturesName mark
captured loop-body names (for/while, post-desugar funnel); marked
names skip declareGlobal and mint as REAL locals via the standard
mintLocal path -- the EXISTING emitLoopFreshBoxed/emitDecl per-
iteration machinery then engages untouched; buildStartFn boxes only
the mutated-after-capture subset (scoped findMutations, not blanket
-- false-positive boxing would silently skip a global.set, verified
concretely). Pay-per-capture: uncaptured loop vars stay globals
(pinned). SWEEP: for-of/for-let/mutated/nested x2/for-in/while ALL
JS-truth green; the banked P0-2 closure-in-loop class CURED module-
scope (1005 exact); test262 rows orthogonal (wrapped depth!=0, fix
gated depth===0). Byte-identity: 8 non-capturing programs identical
vs clean-HEAD worktree; kernel self-host surface ZERO (95-file graph
grepped: no module-scope loop captures). Gates run TWICE (isolated
worktree + settled shared tree): battery 3131/0, parity 33/33,
kernel leg 2447/0, ratchet +0, dbg green, watr 35/35.

CLOSED since #4: kernel ToIntN rows FIXED -> KERNEL LEG ZERO FAILS
(6d293644, first ever; capture class swept 2047ce75, parity corpus
33/33); dyn-prop keying both roots (87511c69); README self-host
limitation note LANDED (cf668352); O0 lattice pins tier-guarded then
RE-guarded per audit #5 (value asserts now run at EVERY tier, guard
only skips WAT-shape asserts); GOALS: memory MET at HEAD (jz leaner
than MoonBit 40/43, .work/memcheck-results.csv), size band = honest
JS-semantics floor (AS ports unchecked() everywhere, proven),
dispatch double win + wordcount Ryu elision in tree. OPEN (audit #5
order): 1 numeric-key-on-unknown-receiver UNSOUND fast path (agent:
receiver pointer-kind guard, flip the wrong-result pin to JS truth),
2 mixed BOOL|NUMBER return representation (needs DESIGN -- prior
broad fix broke 190+ kernel rows; represented join or escape-boxing,
not sentinels), 3 module-scope per-iteration closure capture (agent:
unify with the function-scope mechanism; audit repro 22-should-be-
12), 4 value-oracle rows for parity corpus (byte-identity of
identically-wrong output proved nothing -- boolconst taught that;
add JS-oracle + kernel-output EXECUTION rows), 5 evidence refresh
AFTER semantics settle (+ tinygo CLT), 6 solver consolidation /
LoopPlan / CompileSession vision. IN FLIGHT: examples jz-vs-JS
speed gate (user prod report; deploy staleness ruled out -- pages
current at HEAD, speed-tier builds confirmed). Perf truth: committed
evidence stale by design until item 5; verified pairs: dispatch
strict JIT win, lz band 1.036, synth 0.975 leads, trace 1.462.

## Status (2026-07-30, superseded — re-audit #4 reconciled)

CLOSED since #3: typed-array WIP LANDED (b1176b4a — clean-HEAD simd
158/158); bench producer integration COMPLETE (watr meta, porf-native
42 rows, 70% coverage floor, JIT claim gated, strict/band split);
TargetProfile CLOSED for JS/WASI (zero raw host checks; legalization
real); solver-owned invalidation LANDED (2 justified bespoke calls
remain); warm cap ATTAINED (audit-confirmed 0.969-0.990 clean); w2c
bands GREEN (geomean 1.283, worst 3.395 vs 1.35/3.5 caps); boxed-
bigint PARKED by user decision (revisit map banked); GOALS WAVE:
closure-table lattices (dispatch 10.7x->1.10x size AND 1.32x AHEAD
of JSC), template-Ryu fix, cross-call elem lattice (wordcount
5.61->4.63x), O0 pins tier-guarded. OPEN (audit #4 order): 1 kernel
ToIntN value bugs (2 rows: cross-kind copy + .map integer stores —
kernel-compiled programs WRONG, hunt next), 2 [DONE in-thread: O0
lattice pins belowOpt-guarded + comment fixed], 3 evidence refresh
at settled HEAD + tinygo (CLT user-gated), 4 [DONE: WASM_TODO
sdf/trace/lz entries added, this header], 5 self-host carrier
limitation -> precise public docs (README note pending), 6 fold
closure-table facts into the common solver (medium-term; dyn-
closure-tables.js 613 lines = a parallel lattice), 7 canonical
LoopPlan + isolated CompileSession (long-term vision). IN FLIGHT:
dyn-prop keying miscompile family (2 value-wrong-at-HEAD repros).
Perf truth (f1e877b8): wasm 31 strict / 15 band / 4 red (sdf 1.280,
trace 1.445, lz 1.107, shapes 1.120); JIT 13 unled / 10 red (jessie
1.935 worst real; dispatch FIXED post-evidence); porf-native trails
16.36x geomean.

## Status (2026-07-28, superseded — re-audit #3 reconciled)

CLOSED: kernel byte-parity (PARITY_TODO empty, O0/O2/O3 identical); front
half unified (src/front.js); claims gate landed + hardened (fresh incl.
manifests/layout + watr cross-check, strict-leadership separate from band,
CI job; red by design pending evidence); WARM MARGIN ATTAINED 07ffc292
(inlinePtrOffsetFast: warm 0.93-0.97x vs 0.99 cap, audit-confirmed 0.927x
clean; fresh 0.73); TargetProfile landed (frozen JS/WASI profiles,
wasi leg 40/40 — legalizeForTarget still identity, native/w2c profile
absent); pass registry single-authority (63 passes/22 keys/7 hot);
exclusions burn-down (28 -> 22; errors/parser-bugs/destruct/closures/json/
inference back in); solver convergence throws mandatory; session factStore.
OPEN (re-audit #3 order): 1 land user typedarray WIP -> clean npm test at
HEAD (clean-HEAD simd 157/1 f32->i16 — the ONLY battery red; my dirty-tree
counts masked it, see LESSON below), 2 bench producer/claims integration
(committed bench.mjs lacks meta.versions.watr + porf-native lane — user's
uncommitted bench WIP likely carries both; coverage floor ">=5 rows" too
weak -> eligible-count semantics), 3 reference refresh at HEAD (snapshot
44cad082 now 7+ codegen commits stale; tinygo 0 rows CLT-gated, porf-native
0 rows), 4 boxed-bigint (design banked; -5e-324/2^52-1n kernel rows remain
curated until PTR.BIGINT), 5 JIT-leadership axis ungated in bench-claims
(19 JIT losses / 9 cases in snapshot), 6 real legalizeForTarget + native
TargetProfile [6a DONE 32306df8; w2c cap RESOLVED-GREEN 2026-07-28: the
audit's tokenizer 3.851x/geomean 1.330x were the PRE-refresh snapshot's
contention noise -- c703f63a evidence has tokenizer 2.100x, geomean 1.147x,
worst immutable 2.49x, all inside caps; residual tokenizer gap diagnosed =
TurboFan branch-to-cmov vs clang -O3 on identical sequences, not a jz shape;
guard-page memcheck already free, SIMD/call/flag levers all measured null],
7 solver-owned bodyFacts invalidation (DONE 4b149108), 8 canonical
LoopPlan (vectorize 6845 lines, 16-recognizer chain; no shared affine/
alias/dependence model). Perf snapshot (M4, stale): 31 strict / 15 band /
4 red (glyfparse 1.151, sdf 1.256, trace 1.452, shapes 1.166).

## Goals (2026-07-28 user directive — post-architecture perf/size/memory push)

* [ ] SPEED, all lanes: EVERY bench case faster than v8, JSC (all JIT
      runtimes) AND every wasm rival. Gates already encode it
      (bench-claims strict-leadership wasm + JIT); current distance:
      16 wasm strict losses (worst trace 1.449x), 13 JIT strict losses
      (worst dispatch 2.073x jsc). Order: AFTER architecture complete.
      (w2c lane already inside caps post-refresh: tokenizer 2.100x/3.5,
      geomean 1.147x/1.35 -- the 3.851x figure was pre-refresh noise.)
* [ ] SIZE: produced bundles must BEAT AssemblyScript by size (current
      claim: "on par by geomean"). Producer: scripts/bench-size.mjs.
      Needs: size-vs-AS per-case inventory, then codegen levers (dead
      stdlib elision, header/allocator trim), then a strict size gate.
* [ ] MEMORY: natives consume ~10x less peak RSS than the wasm lanes.
      memKb axis now measured per-invocation (bench.mjs /usr/bin/time
      wrapper, c703f63a). Investigate WHERE the footprint lives (linear
      memory sizing/allocator growth policy vs engine overhead vs
      instantiation copies), compare MoonBit-wasm's profile, target
      MoonBit-level or better.

## Open

* [x] STRING-COMPARE MISPROOF WAVE (LANDED 2026-07-25 --
      the watr-in-kernel dynamic-compare family root; watr-diff harness
      proves the cure but ONE perf-shape regression blocks landing):
  STATE: watr-diff ALL SAME (i64.lt_s(-1,0) folds 1 in-wasm; was 0);
  -1n<0n O2 kernel row returns TRUE (un-curate statements.js row on land);
  ratchet 10/10; optimizer+simd 364/2 -- ONLY clamp-peel x2 red (stencil
  peel stopped firing = perf shape, not correctness).
  THE THREE FIXES IN TREE:
   1. emit.js cmpOp: both-runtime-unknown compare fallback now runtime-
      dispatches (is_str x2 -> __str_cmp three-way, else ToNumber f64),
      gated on ctx.module.modules.string + non-i32 types. Was raw f64
      compare of NaN-boxed string pointers = always false.
   2. narrow.js valTypeOfWithCalls: SOUND '+' rule at the RESULT-STAMPING
      boundary only (unknown side -> no claim); kind.js VT['+'] stays
      OPTIMISTIC (demoting it doubled slice/nest ratchets -- reverted,
      comments in both files point at each other).
   3. compile/index.js paramAllUsesNumeric: relational proof now needs a
      PROVABLY-NUMERIC PARTNER (number literal / numericLocals name /
      numeric-op expr / .length). numericLocals = let/const inits that are
      numeric literals or numeric ops (multi-decl handled). `(p,q)=>p<q`
      no longer stamps params NUMBER (was the factory-lambda break).
  SHAPED-PARSER BREAKTHROUGH 2026-07-25 (post string-compare fixes): the
  class NOW REPRODUCES STANDALONE -- watr-diff.mjs with the REAL pre-watr
  shape module (scratchpad/shape-prewatr.wat, 140kB, generated via native
  compile(src, {wat:true, optimize:{level:2, watr:false}}) of the json
  shaped-parser test source) DIFFS at char 2949: node-watr OUTLINES
  ($__out0 call) where wasm-watr keeps the inline i32.or/eq chain -- wasm
  output 13kB bigger (158628 vs 145536). The kernel's compile-time err 0
  is downstream of this pass divergence. hash32 primitive VERIFIED
  identical node-vs-wasm (the asI32 wrap fix cured it). REMAINING
  SUSPECTS in watr's outline pass (node_modules/watr/src/optimize.js
  ~4620-4740): candidate `facts` build (ownBytes/resultType/ltype),
  group Map iteration order, chosen[].sort tie-stability (b.net-a.net
  ties broken by insertion order -- a Map-order divergence in-wasm would
  reorder choices). NEXT: instrument the outline pass (temp probe export
  like the earlier __bcProbe round -- REVERT node_modules after) to dump
  per-group {h, sites, net} node-vs-wasm and bisect; 30s cycles via the
  harness. This likely ALSO explains kernel-parity dict|2/dict|3/sum|3/
  arr|3 rows (in-kernel output BIGGER = less outlining/dedup!).
  OUTLINE-HUNT ROUND 2 FINDINGS (2026-07-25, probes REVERTED from
  node_modules -- re-apply from these notes): instrumented watr's optimize
  driver + outline pass with a same-module __outLog + getter (cross-module
  ARRAY import mutation does NOT propagate in-wasm -- binding is a copy;
  same-module push + exported getter works). Results: in-wasm
  normalize(true) yields opts.outline=true, opts.fold=true (the drv log's
  first 43 chars match node) BUT (a) `Object.keys(opts).length` string-
  concats as EMPTY in-wasm (Object.keys on the normalize-built dict --
  dynamic-key-written object -- returns nothing enumerable: THE
  spread/dyn-key enumeration gap), and (b) the outline pass logs NOTHING
  in-wasm even with outline=true -- its `for (const [name, fns] of ...)`
  driver loop or the pass-fn table lookup drops it. NEXT PROBE: log inside
  the ROUND LOOP which pass names actually execute in-wasm (push per-pass
  name), then bisect the pass-table build (PASSES array -> OPTS
  Object.fromEntries -- fromEntries + static reads may be the same
  enumeration gap). The kernel-parity dict|2/dict|3/sum|3/arr|3 rows and
  the 13kB size delta likely all reduce to skipped size passes in-wasm.
  OUTLINE-HUNT ROUND 3 -- CRASH REPRODUCED STANDALONE 2026-07-25 (the
  kernel's exact 'memory access out of bounds'/err-0, deterministic,
  ~5min cycles): with probes {OL-called, OL-adjacent len, OL-guard
  operand log} in watr's outline() entry (node_modules/watr/src/
  optimize.js ~4614; probe scaffolding = same-module __outLog array +
  __outLogRead getter exported, entry prepends ';;OUTLOG ' + drain),
  the wasm harness run on scratchpad/shape-prewatr.wat THROWS OOB at
  the guard-log's string reads (typeof ast[0] + .length concat) --
  reading the ast node at 140kB scale hits CORRUPTED/STALE memory: the
  durable-dangler / arena-reuse class (node pointers gone stale after
  arena growth mid-compile). Chain established this session: wasm-watr
  outline logs OL-called + OL-adjacent, never OL-post-guard -> with
  operand logging it ODDLY takes the guard return or OOBs -- i.e. ast[0]
  reads are already reading garbage at that point. ALSO: native first
  OL-called shows op=func len=19 -- outline is invoked on a FUNC node by
  a second caller (find it: grep 'outline(' -- tailmerge/rettail?) --
  check whether the wasm crash is in THAT call or the module-level one.
  NEXT WINDOW: (1) find the second outline caller; (2) bisect WHERE ast
  went stale -- log the ast pointer-identity (e.g. push a marker prop on
  the module node before optimize, test its presence at outline entry);
  (3) suspect list: cse's tee'd locals pass right before outline (a =
  cse(a) -> coalesceLocals -> localReuse -> outline -- one of these at
  scale reallocs/clones into arena space later reused); (4) the fix
  belongs in jz's arena/alloc or the pass's clone discipline, NOT watr.
  Probes must be REVERTED from node_modules after the hunt (currently
  IN PLACE for continuity -- restore recipe in ledger round-2 entry).
  OUTLINE-HUNT ROUND 4 -- CRASH PINNED TO A FUNCTION 2026-07-25:
  selective-pass matrix (entry now passes STRING opts through -- watr's
  set-based normalize): 'fold' OK 139705ch, '+propagate deadcode vacuum'
  OK, '+cse' OK 122084ch, '+outline' OOB; ALSO 'outline'/'fold outline'
  alone OOB. V8 trap frame: wasm-function[403] @0x40bba = the
  $m0_optimize$localReuse cluster (neighbors eliminateDeadInBlock/
  canSubst; mapping +/-4 due to import-func counting -- refine with exact
  index arithmetic next). TWO INTERTWINED FINDINGS: (a) localReuse-family
  code executes under 'fold outline' selection where opts.locals should
  be false -> IN-WASM PASS-FLAG READS ARE UNRELIABLE (the dyn-dict
  static-read class: normalize writes m[p[0]]=..., driver reads
  opts.locals) -- same mechanism as the Object.keys=empty finding; (b)
  whichever localReuse-family fn runs, it OOBs on the 140kB tree
  (NOT capacity: identical at memory 16384). NEXT: (1) exact index->name
  mapping (count import funcs precisely; funcs regex currently matches
  import-wrapped (func too)); (2) reproduce the dyn-dict flag misread in
  isolation with normalize's exact shape (PASSES table -> m[p[0]]=bool ->
  static reads) -- THE root to fix in jz (schema/hash read path for
  dynamically-keyed dicts consumed by static props); (3) then the OOB fn
  with correct flags may never run -- retest before hunting it separately.
  Harness memory now 16384; entry passes strings through (typeof check).
  OUTLINE-HUNT ROUND 5 -- PRIMITIVE CAUGHT RED-HANDED 2026-07-25:
  post-trap log drain WORKS (entry exports drainLog=__outLogRead; host
  calls it AFTER catching the trap -- instance memory survives, jz string
  machinery still functional; probe file scratchpad/flagprobe.mjs).
  WASM'S ACTUAL STATE UNDER 'fold outline': flags CORRECT (fold=1
  locals=0 cse=0 outline=1 -- earlier localReuse-runs-anyway theory DEAD,
  the fn-index mapping was off); outline runs; BUT the guard log shows
  **l0=0 in-wasm vs l0=4 in node** -- the parsed 'func' TAG STRING'S
  .length READS 0 while typeof=string. A corrupt string carrier out of
  watr's parse() at 140kB scale (SSO length bits zero) -- downstream
  address math on such strings OOBs (the trap), comparisons misroute
  (the guard/pass weirdness), sizes drift (parity rows). THE HUNT IS NOW:
  which watr-parse token path builds strings with zeroed length bits at
  scale, i.e. WHICH jz string-producing emitter (slice/substr/charCode
  accumulation) skips SSO/length normalization on some scale-dependent
  branch. NEXT PROBES: log typeof+length+charCodeAt(0) of the first ~10
  parse() tokens in-wasm (instrument watr parse.js token fn, same
  __outLog channel + post-trap drain); compare small vs 140kB source;
  then differential-pin the jz emitter path. Probe state: watr optimize
  instrumented (flags log at driver entry, OL-* logs at outline, __chk
  at finish tail); entry has drainLog + string-opts passthrough; harness
  memory 16384; ALL recipes reproducible from these notes.
  ROUND 7 -- GUARD PINNED + NEW ANOMALY 2026-07-25 (counters channel,
  allocation-free; probe files: flagprobe.mjs + instrumented watr parse/
  optimize in node_modules + entry counts()):
  (a) TRAP WAS PROBE-INDUCED: pristine watr 'fold outline' completes on
  BOTH engines -- log-string allocations at per-func call depth caused
  the OOB (separate jz allocation bug, banked). Real divergence: node
  88332ch outlined vs wasm 139597ch NOT outlined, no trap, minimal
  config 'fold outline'.
  (b) GUARD PINNED BY COUNTERS: outline entered 55x on both engines;
  node passes the module guard once (rounds run, 568 cands, 10 applied);
  wasm passes ZERO -- `!Array.isArray(ast) || ast[0] !== 'module'`
  rejects even the real module node in-wasm.
  (c) TOKEN-BIRTH strict-eq is FINE (modTok=2, modEq=1 both engines --
  'module' vs 'memory' distinguished correctly at commit).
  (d) NEW ANOMALY: parse token counter __cTok reads 7915 in-wasm vs
  79122 in node (~exactly 10%) -- but wasm output is full-size, so
  EITHER export-let counter increments drop ~90% at scale in-wasm
  (a global-increment miscompile class!) OR the counter/export read path
  lies. DISCRIMINATE NEXT: return level.length (structural top-level
  count) + str.length from inside the entry -- no counters; also test a
  trivial 100k-iteration export-let counter in isolation both engines.
  Then re-face (b): if counters lie, guard evidence needs a counter-free
  recheck (e.g. push a sentinel into the module node on guard-pass).
  ROUND 8 -- ENDGAME LOCATED 2026-07-25: counter-free structural probes
  settle everything: (a) node's 79122 token count was MY probe double-
  importing the entry (parse ran across harness cases) -- both engines
  tokenize identically (7915 strs, 4831 nodes, top=49); (b) tree[0] ===
  'module' is TRUE in-wasm when compiled in the ENTRY module AND in a
  fresh small fn ADDED to optimize.js (__guardTest export) called with
  the same tree; (c) outline's OWN inline guard `ast[0] !== 'module'`
  still rejects 55/55. CONCLUSION: the IDENTICAL compare expression
  miscompiles ONLY inside outline's ~4600-line arrow body -- the
  enclosing-function-scale/shape-dependent miscompile that underlies
  this whole family. NEXT (the endgame): dump the harness module's
  native-jz WAT (compile g.code {wat:true}), locate BOTH compare sites
  (outline's guard vs __guardTest), diff the emitted idioms -- the wrong
  instruction sequence names the emitter path to fix. Probe state:
  watr node_modules instrumented with counters + __guardTest (pristine
  restore = rm -rf node_modules/watr && npm install watr@5.7.11
  --no-save); entry has counts()/treeStat; flagprobe.mjs is the runner.
  ROUND 9 -- ROOT NAMED AND FIXED 2026-07-25 (endgame closed). The
  __li-aliasing hypothesis of the previous entry was WRONG (those sets
  precede their uses textually; red herring -- lesson: name a mechanism
  only after reading the actual compare site). The real root, read
  straight off outline's entry code in harness.wat: the guard
  `!Array.isArray(ast) || ast[0] !== 'module'` compiled with its SECOND
  DISJUNCT AS `(i32.const 1)` -- statically folded TRUE, so outline
  always early-returned in-wasm (__cEntry 55 / __cGuard 0 exactly).
  JZ_DBG_FOLD tracing pinned the fold: emitStrictEq's differing-
  primitive-class rule fired because valTypeOf(ast[0]) returned
  VAL.ARRAY -- analyzeBody's push observation (`ast.push(['func',…])`
  inside outline) SETTLED arrayElemValType=ARRAY for a PARAM whose
  pre-existing contents are unknown (watr trees are heterogeneous
  ['module', str, …arrays]). Mutation evidence describes only ADDED
  elements; treating it as element-type proof for arrays the body
  didn't construct is the misproof class (also hit bf463_0/'block',
  astf794_1 -- and transitively poisons the caller-side param lattice).
  FIX (analyze.js + analyze-scans.js): elemOrigin set -- a name's
  initial contents count as known only from a fully-static array-
  literal decl (incl. empty) or fresh Array(n) ctor (isFreshArrayCtor,
  now exported); push/index-write observations for ALL THREE slices
  (val/schema/typedCtor) gate on elemOrigin-or-existing-entry, else
  SKIP (not poison -- caller-proven preseeds survive). The construct-
  then-fill and `let a=[]; a.push(x)` idioms keep their fast paths.
  VERIFIED: flagprobe SAME 88387ch, counters identical node/wasm
  (55/1/2/568/37/24/10 -- 10 outlines applied in-wasm); watr-diff ALL
  SAME on pristine watr@5.7.11 incl. full default pipeline over the
  real 140kB shape-module WAT. Probes stripped (emit.js/index.js dbg,
  watr node_modules reinstalled pristine, entry probes removed).
  WARM LEVER RANKED 2026-07-28 (AC power restored; instrumented
  kernel via helperCounters, one crc32 compile): __ptr_offset 17.9M
  calls DOMINATES (3.5x next: str_eq 5.0M, len 4.8M, length 3.6M,
  alloc 3.6M, typed_idx 2.4M, str_hash 2.4M). Every NaN-box deref in
  the self-hosted compiler is an out-of-line call (kept a fn by the
  forwarding-pointer branch). Warm verdict on AC: 1.001/1.022/1.021
  hover (fresh 0.787) -- the ~1-2% gap ≈ 17.9M call frames. LEVER:
  inline the __ptr_offset fast path (non-forwarded case: pure bit
  ops) at call sites with an out-of-line forwarding fallback -- or
  watr inline-pin it in the kernel build. Bounded, measurable,
  general (speeds every kernel compile). NEXT WINDOW: implement +
  measure warm rounds (needs AC + quiet).
  WARM CAP ATTAINED 2026-07-28: inlinePtrOffsetFast landed as a
  speed-tier-gated LATE pass (src/optimize/index.js
  inlinePtrOffsetFastPass + passes.js registry; off in L2/size
  presets so default sizes/ratchet/goldens are byte-untouched).
  Inlines $__ptr_offset's loop-free body (mask+tag test +
  followForwardingWat guard) at each surviving call site; only the
  cold $__ptr_offset_fwd relocation chase stays out-of-line. TWO
  ORDERING/NAMESPACE TRAPS (both pinned by existing tests): (1)
  $__inl<N> is watr's OWN inliner namespace -- sharing it duped
  locals; scratch renamed $__poff<N>/$__poffb<N>; (2) MUST run
  AFTER unswitchTypedParamLoop/vectorizeLaneLocal -- they pattern-
  match the RAW (call $__ptr_offset) shape to prove SIMD lifts;
  eager inlining inside fusedRewrite silently killed a whole
  scalar->SIMD lift (caught by test/unswitch-typed-param.js).
  never-grown.js structural pins extended to accept the __poff
  marker. MEASURED: helper profile ptr_offset 17.9M -> 0 (top now
  str_eq 5.0M); warm rounds 1.001/1.022/1.021 -> 0.965/0.968/0.964
  agent runs, 0.973 my confirm run (ALL cases <=0.99: mat4 0.97
  fft 0.98 biquad 0.98 sort 0.99 crc32 0.99 mandelbrot 0.93);
  fresh 0.787 -> 0.763. Speed-tier size cost 139-483B/case
  (~1.4-1.8%), checksums identical, paired sort/fft/synth no
  regression. Battery 3101/0, parity 18/18, ratchet 10/10 zero
  delta. The warm <=0.99 strict-win cap now passes on EVERY round
  -- last solo-scope committed-gate red is CLEARED.
  RE-AUDIT #3 RECEIVED 2026-07-28 (verdicts reconciled into Status
  header). LESSON (process, REPEAT OFFENSE): dirty-tree verification
  again recorded green counts a clean HEAD cannot reproduce -- 72cc7fd1
  said simd 158/158 but clean-committed HEAD fails f32->i16 encode
  (157/1) because the user's uncommitted module/typedarray.js WIP
  supplies the fix; the SAME confound was already dissected for the
  linux-only CI red. RULE (now binding): any COMMIT-TIME green count
  must come from a clean worktree of the exact commit (git worktree
  add <tmp> <sha> + npm ci-equivalent + battery), or be reported as
  "dirty-tree, user WIP present". In-tree runs remain fine for
  RELATIVE pre/post checks of an unrelated diff. AUDIT CONFIRMS:
  warm cap independently reproduced clean (0.927x warm / 0.725x
  fresh, 5/5), targeted forwarding tests 4/4, TargetProfile wasi leg
  40/40, inference kernel rows 86/86, parity 18/18 clean.
  SOLVER-OWNED BODYFACTS INVALIDATION LANDED 2026-07-28 (audit item
  7, declared next slice done): the 14 real invalidateLocalsCache
  pairings (task said 16; import line + overcount) collapsed into
  three seam primitives in compile/analyze.js -- reanalyzeBody(body,
  read?) fuses invalidate+read (8 hypothesis-probe/emit-reseed
  sites), setFuncBody(func,node) fuses AST-rewrite+invalidate (5
  sites, also makes bindingUses' "no surgical invalidation" contract
  structural: rewritten bodies are new identities by construction),
  invalidateBodies/invalidateAllBodyFacts named phase-boundary
  flushes (3 sites). 2 bespoke raw calls remain, both justified
  (defensive trailing flush; read-invalidate-mutate fixpoint in
  scalarizeFunctionObjectLiterals). SECOND NET: assertBodyFactsFresh
  -- JZ_DEBUG_INVARIANTS-gated signature-fingerprint check on cache
  HITS (params/results type+ptrKind+ptrAux only; null side skips --
  the prior JZ_DEBUG_CACHE blanket-recompute attempt died of benign
  ambient-staleness false fires, this one is scoped to genuine
  signature retype misses); regression pins in test/invariants.js
  plant a missing invalidation and prove the assert fires, and that
  the seams never do. Ambient overlays (localReps/typedElem/
  slotI32Certain) stay documented intentionally-staleable. GATES:
  isolated npm test 3103/0 (+2 new), dbg-invariants leg 3101/0,
  parity 18/18, ratchet 10/10 +0, dist clean, kernel leg 2419/2
  user-WIP-only. DEPS table updated to the new API.
  CLAIMS GATE STRENGTHENED 2026-07-28 (audit items 2-gate-side + 5):
  JIT promise now gated -- JIT_RIVALS v8/deno/bun/jsc get the same
  strict-leadership + 1.05-band tests as the wasm set (shared
  caseRatios helper; snapshot truth: 13 JIT strict losses, 12 red,
  worst dispatch 2.073x jsc -- red by design until evidence catches
  up); coverage floor now >=70% of corpus per rival (was >=5 rows;
  0.7 set from real portability -- go/zig port 43/60=0.72), applied
  uniformly to wasm+JIT+porf-native lanes. Producer side (meta.
  versions.watr emission, tinygo lane) remains user-WIP/CLT-gated.
  CLEAN-WORKTREE CERTIFICATION 4b149108 (rule's first application):
  3102 total / 3095 pass / 1 fail / 6 skip -- the one fail is the
  predicted simd f32->i16 user-WIP dependency, FIXED at HEAD by
  b1176b4a (ToIntN landing). invariants dbg leg 18/18 clean. HEAD
  8ffad675 certification due after the legalizeForTarget slice lands.
  WIP TREE FULLY LANDED 2026-07-28 (user directive "no other WIP,
  commit or delete"): b1176b4a ToIntN/sumPrecise/atan2 (+2 kernel-leg
  ToIntN rows = burn-down follow-up), c703f63a bench producer (memKb
  peak-RSS axis, porf-native git lane, watr EH exclusion, evidence at
  ab5e7026), afc7b381 site/docs, 8ffad675 goals+ledger. hash-lane
  branch VERIFIED fully merged (ancestor, 0 ahead) and deleted
  local+remote. NOTE: producer still does not emit meta.versions.watr
  (claims freshness cross-check will fail on next refresh until
  added) -- now solo-scope since bench.mjs is landed. [DONE 3523aaa9]
  LEGALIZEFORTARGET REAL 2026-07-28 (audit item 6a): both WASI
  target-conditional rewrites ported out of compile/index.js onto the
  assembled module tree in watr-tail.js -- legalizeCommandEntries
  (run/_start () -> () wrappers; targets discovered STRUCTURALLY from
  export nodes, the wasiCommandExports skip-set deleted so aliases
  emit naturally) + legalizeReactorInit (start-section -> _initialize
  with $__init_done self-arm guards). Observation-order concern
  resolved EMPIRICALLY not just argued: rewrite 2 always ran post-
  optimizeModule/callCount; rewrite 1's new func was a zero-call
  stable-sort tie whose slot insertLikeCompileFuncsPush reconstructs
  exactly. Byte-identity: 13-case sha256 corpus + stress combos
  (run+_start together, both-alias, wrapper+self-arm interaction) all
  identical. New pins: legalizeForTarget identity under js profile
  (same array ref) + no-WASI-artifacts end-to-end. Gates: wasi leg
  42/42, wasi-host full suite 3105/0, battery 3105/0, parity 18/18,
  ratchet 10/10 +0, kernel leg 2419/2 (ToIntN burn-down rows).
  Remaining item-6 scope: module/math.js's 3 host checks (landed
  file now -- fold into targetProfile next touch), native/w2c
  TargetProfile + w2c cap recovery (6b).
  BOXED-BIGINT ROUND 1: CORRECT BUT WARM-BLOCKED 2026-07-28 (honest
  stop, tree restored to 32306df8): full PTR.BIGINT implementation
  passed gates 1-6 (battery/wasi/dbg 3105/0 each, parity 18/18,
  ratchet 10/10 with ring IMPROVED 98640->98600, kernel leg 2419/2
  pre-existing-only, carrier rows -5e-324 + 2^52-1n GREEN both legs)
  but warm cap failed 1.012/1.023/1.022 vs 0.99. ROOT (diagnosed,
  confirmed not-a-bug): the compiler's OWN NaN-box math (layout.js
  ptrBits/i64Hex, wat/assemble.js stripStaticDataPrefix) is heavy
  idiomatic BigInt -- always-box at construction turns each op into
  an alloc inside the kernel's hot path. THREE REAL BUGS found+fixed
  en route (re-apply in round 2): __is_truthy had NO bigint arm
  (boxed 0n truthy; fix needed in BOTH core.js WAT and the duplicate
  inlined peephole copy in optimize/index.js, gated on
  ctx.features.bigint to keep bigint-free output heap-free per
  minimal-output.js); numLiteralNode missed the ['nan'] literal
  marker (5n>NaN unsound i64 bit-compare); interop mem.read t===5.
  ROUND 2 DIRECTION (decided): boundary boxing -- keep VAL.BIGINT
  values as RAW i64 while kind-known (locals/params/typed chains;
  the kind system already tracks it), materialize the box ONLY at
  kind-erasure (f64 slot stores, dyn containers, export boundary,
  mixed eq); unbox on kind-recovery. typeof/eq on known-bigint stay
  static/raw. Kills the kernel warm cost structurally (layout.js
  chains never box) AND the accumulator-loop leak for local chains
  -- general engine lever, not input tuning.
  TARGETPROFILE COMPLETE 2026-07-29 (audit item 6 CLOSED): math.js's
  3 host checks all gated ONE decision -- Math.random entropy shim
  (wasi random_get vs env.rngSeed import) = exactly wasiShims'
  documented rationale; migrated via crypto.js's established spot
  pattern (const wasi = ctx.transform.targetProfile.wasiShims). Zero
  live `transform.host === ` checks remain in src/+module/ (grep-
  verified; survivors are the profile constructor + comments).
  LATENT HARNESS GAP surfaced+fixed: test/types.js runAnalyze called
  raw reset() bypassing beginSession -> targetProfile stayed null;
  now seeds targetProfileFor(host) post-reset (the sanctioned
  test/wasi.js pattern). Gates: battery 3105/0, wasi leg 3105/0,
  parity 18/18, ratchet 10/10 +0, kernel leg 2419/2 pre-existing.
  LOOPPLAN BODY-ANALYSIS SLICE 6 2026-07-29 (audit item 8 advanced):
  deriveOffsetTees(body, ind) hoisted beside bodyFacts as bl.offset
  Tees -- the exhaustive CSE'd lane-offset-alias derivation that
  tryMapReduceVectorize and tryRampMap re-derived byte-identically
  (-24 duplicated lines). JUSTIFIED-PRIVATE audit recorded in the
  function doc: tryVectorize/tryReduceVectorize/tryMemCopyFill build
  offsetTees INCREMENTALLY mid-scan (provisional acceptance is load-
  bearing) + tryVectorize needs AoS idxTees; tryStencil's ivCoeff
  algebra richer; localKind classification bespoke per recognizer.
  Byte-identity: 177/180 bench compiles x O0/O2/O3, 0 WAT diffs (3
  skips identical pre/post). Gates: battery 3105/0, parity 18/18,
  ratchet 10/10 +0, optimizer 213/213, kernel leg 2419/2 pre-
  existing. Remaining item-8 vision: candidate-proposal protocol +
  shared affine/alias/dependence model (the incremental-scan trio is
  the natural next unification IF a provisional-acceptance-aware
  shared walk is designed -- do not force it).
  GOAL-MEMORY: ALREADY MET AT HEAD 2026-07-30 (premise falsified by
  fresh measurement -- the ~10MB-vs-MoonBit delta was STALE evidence,
  13 commits old): jz-wasmtime beats-or-matches moonrun peak RSS on
  40/43 comparable cases (median delta -864KB, jz LEANER); the
  hypothesized fixed-large default DOES NOT EXIST -- modules declare
  1 initial page (64KB, assemble.js floors at max(pages||1,
  dataPages)), growth is demand-driven geometric (__memgrow doubles
  on overflow only); engine floors wasmtime 13.7MB vs moonrun 12.2MB.
  THREE residual losses (strbuild +7.8MB, json +1.3, immutable +1.1)
  = the no-GC arena accumulating garbage across the harness's 26
  in-process iterations with __clear NEVER CALLED -- an architectural
  GC-vs-arena tradeoff, NOT a defaults bug. DECISION NEEDED (user):
  (a) harness fairness -- call __clear between iterations (changes
  what memKb measures; deliberate methodology call), (b) GC/reclaim
  design (major), or (c) accept+document the 3 cases as the arena
  model's honest signature. Raw 43-case data: scratchpad/memcheck/
  full/results.csv. No code change was warranted; tree untouched.
  SIZE BAND DIAGNOSED: HONEST FLOOR 2026-07-30 (the 1.2-1.3x-vs-AS
  band is dominantly the JS-SEMANTICS TAX, proven by control
  experiment): the AS bench ports wrap EVERY array access in
  unchecked() -- compiling them WITH assertions (-Oz minus
  --noAssert) produces BYTE-IDENTICAL output, i.e. AS's small
  baseline assumes zero bounds checking unconditionally; jz pays
  real guards because JS OOB reads return undefined / writes drop
  silently (ir.js:915-922 rationale). wasm-opt -Oz barely moves the
  ratios (1.18-1.31) = structural, not peephole. Per-case index
  shapes verified genuinely unprovable (fft bit-reversal, tokenizer
  caller len, resample float-trunc gather, slices schedule offsets,
  sdf data-dependent k--). TWO NARROW REAL GAPS blueprinted, not
  landed (right call -- one case each, subtle machinery): (B)
  checksumF64 buffer-reinterpret non-specialization -- .buffer/
  .byteOffset always take the view-unknown fallback (typedarray.js
  685) unreached by the param-kind lattice; ~300B on resample only;
  (C) read-then-later-write double bounds check -- RMW fusion
  (typedarray.js 1878) is single-statement only, cse-load never
  reuses a read's in-bounds proof for a later store; ~20B on fft.
  DECISION NEEDED (user): the "beat AS by size" goal vs this floor
  -- current truth is geomean 1.016 with 27/49 cases SMALLER while
  keeping JS semantics vs AS's unchecked-everywhere ports; honest
  claim = par-or-smaller WITH semantics (the strict-claim-scoping
  precedent); beating outright requires either an unchecked tier
  (against the JS-exact philosophy) or watr-side compression.
  REFRESH ATTEMPT POLLUTED 2026-07-30 (discarded, not committed):
  full refresh at 2047ce75 read implausible jumps (slices 2.89x,
  trace 2.17x, synth 1.34x) alongside real wins; TARGETED PAIRED
  VERIFICATION (quiet, ABBA) refuted every jump: trace 1.462x
  (matches committed 1.445), slices 1.035x band, synth 0.975x JZ
  LEADS. Verdict: lane pollution mid-run despite apparent quiet --
  the ledger rule stands (reference refresh = truly idle machine,
  overnight-class). VERIFIED REAL from the attempt + pairs: dispatch
  strict JIT win in-evidence-shape (1843us vs jsc 2355 = 1.28x
  ahead, 4.8x vs v8; bytes 1770 committed-consistent), lz improved
  to 1.036 BAND (the inference wave closed its red without a
  dedicated lever), jessie 1.935 -> ~1.73, wordcount bytes 16104.
  results.json/bench.svg restored to committed f1e877b8 evidence
  (stale-but-honest beats fresh-but-polluted). RE-RUN at next idle
  window; claims gates re-check then.
  CAPTURE-AFTER-NESTED-EMIT CLASS SWEPT 2026-07-30 (the named follow-
  up; class now AUDITED, not just patched): 4 REAL sites fixed, all
  typedarray.js -- subview branch of the SAME 401-loop closure the
  07-30 fix partially covered (stride/name read after emit(lenExpr2/
  offsetExpr)), DV_SET 908 + DV_GET 990 (op/vt/sz read after
  emit(off/val/le)), from-literal 1128 (stride/store/elemType re-
  read between element emits). Established snapshot-before-nested-
  emit shape, site comments cite the class. CLEAN inventory recorded
  per-site: atomics RMW, 9 simd loops, web.js fetch (single-entry
  ARITY -- note: a 2nd entry needs revisit), from-general branch,
  regex; 10 modules ruled out by shape. HONESTY: the 4 new sites
  could NOT be live-reproduced with small repros (unfixed-kernel
  test) -- defensive immunization by strict class criteria, plainly
  not overclaimed. Byte-identity per fix via HEAD-swap WAT diff at
  O0/O2/O3. Pins: subviewtyped/dvnested/fromnested join the parity
  corpus (33/33). Gates: battery 3130/0, kernel leg 2446/0 HELD,
  ratchet +0, dbg green, watr 35/35.
  KERNEL LEG ZERO FAILS 2026-07-30 (audit-#4 blocker #1 CLOSED; first
  full-coverage zero-fail kernel run ever: 2446/0/6). TWO roots, both
  self-host miscompiles in typedarray.js (native runs interpret the
  file; only the kernel build COMPILES it -- the class's signature):
  (1) BOOLEAN/NUMBER RETURN COLLISION: isConst returned number-or-
  false; a NUMBER-mixed generic-f64 return is NOT an atom-boxing
  escape site, so `false` crossed as float 0 == a genuine 0 constant
  (native repro: `(n)=>{if(typeof n==='number')return n; return
  false}` -- g(-1)===false is false under jz). NARROW FIX: null
  sentinel (proper NaN-box, unambiguous), callers != null. BROADER
  root fix attempted (box atoms at every unnarrowed f64 return) and
  REVERTED: 190+ kernel-target fails via second-order self-compile
  effects -- the mixed-BOOL-return boxing gap is now a NAMED OPEN
  LANGUAGE CLASS (false-as-0 across NUMBER-mixed returns; revisit
  with a design, not a drive-by). (2) THIRD INSTANCE of capture-
  after-nested-emit (typed-index precedent .work:1907): new.<name>'s
  per-iteration closure called emit(lenExpr) -- recursing into a
  SIBLING instance of the same closure template -- before building
  copyFromTyped/from IR; the post-call elemType/aux reads observed
  the INNER iteration (WAT smoking gun: stride-3 f64.store + aux 7
  where native emits stride-4 i32.store + wrapIntIR). Fix: build
  branch IR before the nested emit (identical tree). FOLLOW-UP
  NAMED: class-wide sweep for remaining capture-after-nested-emit
  sites in module emitters (3 instances now; the elemStoreIR store-
  path exposure note from the first instance still stands). Pins:
  boolconst + nestedtyped in the PARITY CORPUS (byte-identical
  proofs at O0/O2/O3). Gates: battery 3130/0, parity 24/24 (+6),
  kernel leg 2446/0 ZERO FAILS, ratchet 10/10, dbg green, watr
  35/35.
  DYN-PROP KEYING FIXED 2026-07-30 (both value-wrong repros; TWO
  DISTINCT ROOTS -- the one-family hypothesis tested and REFUTED):
  ROOT A (classification): array.js's unknown-receiver arr[i]
  fallback routed numeric keys straight to __typed_idx, whose non-
  ARRAY/TYPED arm bounds-checks vs __len (=0 for OBJECT) -> silent
  undefined; fixed in the runtime-is_str_key arm ONLY (the provably-
  NUMBER-key fallback is a deliberate documented perf tradeoff,
  named perf pin protects a[loopCounter] hot loops); IDENTICAL gap
  in the `in` operator (collection.js) fixed. Suspected line 842
  EXONERATED (dyn_get_expr normalizes internally -- finder's red
  herring corrected). ROOT B (representation contract): dictWalkI32
  "lean" raw-i32 dict proof was honored by tryHashRmwFusion but NOT
  plain o[k]=v (generic __dyn_set boxes f64; lean read's bare wrap
  saw the box's low word=0); fixed at dynSetCall, the single choke
  point. Map SameValueZero verified + conflation pin. ATTEMPTED AND
  HONESTLY REVERTED: global dict-mode classification (recordGlobal
  Rep can't see plan-time dynWriteVars) -- full fix built but broke
  watr self-host 30/35 via analyzeBody staleness + emitDecl overlay
  shadowing + unboxablePtrs schema-id loss chain; banked as a
  documented gap with pin, not silently absent. Pins: repro A +
  write/delete/in/Map siblings (dyn-keys.js, data.js), repro B +
  the promised 2-hop variant (inference.js). Gates: battery 3130/0,
  parity 18/18 fresh dist, ratchet 10/10 +0, kernel leg 2 pre-
  existing only, dbg green, watr 35/35.
  CROSS-CALL ARRAY-ELEM LATTICE LANDED 2026-07-29 (wordcount root):
  the join was ALREADY WIRED (narrow.js runArrValTypeFixpoint ->
  paramReps arrayElemValType -> localReps); the caller-side fact
  never got born -- exprElemSourceVal fell to generic valTypeOf for
  INDEXED-READ elements (probes.push(words[i])), invisible mid-walk
  for body-locals (reps populate post-analyzeBody), poisoning the
  receiver. FIX (+34 lines analyze.js): one-hop recv[i] reads
  consult elemValOf (rep-or-in-progress map -- the alias case's
  proven pattern; elemOrigin gate inherited, never bypassed).
  wordcount 19515 -> 16104B (5.61 -> 4.63x vs AS; whole Ryu cluster
  out, str_hash/str_eq direct); corpus geomean 1.020 -> 1.016, zero
  regressions. Pins added IN-THREAD (agent skipped them; the WAT
  no-__to_str assert proved too strong -- write-side generic still
  pulls it pending the blocked stratification; positive str_hash
  assert instead). PIN HUNT PAID: TWO latent PRE-EXISTING dyn-prop
  KEYING miscompiles now mapped (both value-wrong at HEAD, both
  repro'd): (A) o[numArr[j]] proven-NUMBER key on HASH receiver
  skips ToPropertyKey (module/array.js:842 vt===HASH branch,
  __dyn_get_expr gets raw number; o={};o["1"]=9;o[nums[j]] -> 0);
  (B) proven-write/generic-read divergence: words=build();
  picks.push(words[i]); counts[words[1]]=7; probe(counts,picks)
  reads counts[picks[1]] -> 0 (control shapes correct) -- likely
  ONE family: write/read paths disagree on key normalization when
  one side is proven and the other generic. Fix agent next; 2-hop
  value pin lands with it (documented beside the green pin).
  PARALLEL WAVE LANDED 2026-07-29 (two agents + in-thread bisect):
  (1) IMPERATIVE closure-table lattice -- name[key]=arrow tables get
  the 3c4898d3 param/result lattice via everyUseIsIndexedCallOr
  LiteralWrite (loop-written tables poison fail-open: closure-in-
  loop class) + early-merge window (post-named-fns, pre-
  compilePendingClosures -- the timing the literal case never
  needed); HONEST NULLS: jessie's subscript lookup fails open BY
  DESIGN ((fn=lookup[cc])&&fn(a,p) guarded-alias = bare read under
  the stricter param-kind safety; plus loop-built digit writes) --
  jessie 1.94 needs a DIFFERENT lever; vm has NO closure table
  (if/else dispatch). Byte-identical where not engaged; pins x2.
  (2) TEMPLATE-LITERAL Ryu pull FIXED (ir.js toStrI64 +7: proven-
  STRING part is ToString-identity) -- `x${s}y` module 17 fns -> 2.
  (3) STRATIFICATION CORRECTIONS: __str_concat was ALREADY
  stratified (concat_raw, pre-existing) -- my monolithic-helper
  diagnosis wrong in the specific; the REAL monolith is __dyn_set/
  __dyn_get_t (ToPropertyKey pulls __to_str) BUT the split cores
  are BLOCKED: wiring them triggers a LATENT WATR INLINER BUG
  (smaller fns inline where originals didn't; __dyn_get_t_h single-
  entry memo cache + multi-site inlining corrupts results --
  standalone repros: a.name=7;a.shift() -> NaN; JSON.parse+o[k] ->
  NaN) AND even unreachable cores shift condref +371 via changed
  inline choices (bisected in-thread to collection.js) -- cores NOT
  landed; watr-side inliner bug = USER-repo item, repro in agent
  transcript. (4) WORDCOUNT TRUE ROOT (my in-thread diagnosis
  corrected): probes array passed as PARAM -- element STRING kind
  dies at the call boundary (param elem inference is body-evidence-
  only, no cross-call arg propagation; intra-function attempt
  didn't survive re-analysis) = the cross-call ARRAY-ELEM lattice
  gap, sibling of the param lattice family. PROCESS: stratification
  agent used git stash once (immediately popped, no damage --
  flagged honestly; briefs already forbid it). Gates on final tree:
  battery 3126 total green after dist rebuild (stale-dist parity
  red bisected+cleared), parity 18/18, ratchet 10/10 +0, watr
  35/35, kernel leg 2440/2 pre-existing.
  WORDCOUNT ROOT NAMED 2026-07-29 (in-thread, same method): source
  never stringifies a number yet Ryu is in the module -- __str_concat
  is a MONOLITHIC generic helper whose unproven-operand arm calls
  __to_str internally, so even proven string-to-string concat
  (w += String.fromCharCode(...)) transitively drags the whole
  ToString/Ryu formatter (~26% of wordcount's size module). LEVER
  (agent implementing): helper STRATIFICATION -- strings-only concat
  CORE (no __to_str dep) called directly from proven-STRING emit
  sites; the coercing wrapper (ToString both -> core) only when an
  unproven operand exists; dep graph reflects it so proven-only
  modules never include Ryu. Sibling sweep in brief: __str_eq,
  template-of-proven-string, int-only stringification vs float Ryu.
  PARALLEL agent: imperative closure-table lattice (lookup[c]=fn,
  the jessie/vm shape) extending 3c4898d3's literal-table lattice.
  CLOSURE-TABLE PARAM LATTICE LANDED 2026-07-29 (the dispatch lever;
  DOUBLE WIN): dispatch size 17090B -> 1770B (10.7x -> 1.10x vs AS,
  ~parity) AND speed 1.96x-behind-JSC -> 1.32x FASTER than JSC,
  4.86x faster than V8. MECHANISM: (1) param lattice -- const array-
  of-arrows whose ONLY program-wide occurrence is name[idx] in the
  callee slot of an immediately-enclosing call => member params
  adopt the join of per-site arg kinds (everyUseIsIndexedCall,
  dyn-closure-tables.js: STRICTLY NARROWER than devirt's safeTableUse
  -- funcIdx-identity proof tolerates bare element reads, param-kind
  proof cannot [let p=ops[1] reaches the body via an untracked call];
  exactly why the FIRST attempt e5867034 was reverted -- history
  discovered, comment updated); (2) result-kind via
  closureBodyReturnKind on raw element ASTs (kind.js VT['()'] table-
  callee branch) so loop-carried x=ops[i](x,k) stays numeric.
  Fail-open pinned (alias disqualifies whole table, __str_concat
  returns). SIBLINGS (honest): wordcount 5.6x = DIFFERENT root (no
  closure tables -- still open); jessie's lookup[c]=fn is an
  IMPERATIVELY-built table (extension item: apply the same lattice
  to dyn-closure-tables' imperative machinery); sort-comparator
  WATCH = builtin-arg closure (different shape, no live bench case).
  Gates: battery 3124/0 (+1), parity 18/18, ratchet +0, kernel leg
  2437/2 pre-existing, dbg green, watr 35/35.
  DISPATCH DOUBLE-OUTLIER ROOT NAMED 2026-07-29 (in-thread after the
  dissection agent died to 4x API-500s; diagnosis salvaged+completed):
  the case's ENTIRE ~60% string/Ryu size cluster (__to_str 33%,
  __str_concat, __ryu_pow5, __mkstr...) hangs off ONE unproven `+`
  in `(x,k)=>(x+k)|0` -- the 8 integer closures are invoked through
  a data-indexed table (ops[code[i]](x,k)) so no call-site lattice
  reaches their params; the generic add's string arm pulls the whole
  chain (verified: __str_concat's only callers are closure0/closure5/
  to_str; producer-exact repro scratchpad/dispatch-size2.wat -- the
  bytes producer IS like-for-like, benchlibHostSource patch
  confirmed). SPEED gap (1.96x vs JSC) shares the root: generic
  dispatch in the hot loop vs JIT inline caches. SAME CLASS as the
  ledgered sort-comparator WATCH note. LEVER (agent implementing):
  closure-TABLE call-site param lattice -- const never-escaping
  array of closures invoked only via indexed calls => member params
  adopt the JOIN of per-site arg kinds (extends narrow.js's direct-
  call lattice; return-side analog = af731cf0's pre-pass); fail-open
  on escape/non-indexed use/heterogeneous kinds. Expected: dispatch
  size 17.2kB -> few kB (geomean vs AS flips below 1.0), speed
  toward JIT parity; sort-comparator + jessie sibling checks.
  BOXED-BIGINT PARKED BY USER DECISION 2026-07-29 ("proceed with the
  goals" + "I think we wanted to keep that limitation"): the raw-i64
  carrier STAYS as documented semantics; curated carrier rows are
  permanent documented divergences (subnormal-literal exports +
  >2^52 bigints crossing kind-erased boundaries -- vanishingly rare
  in real programs); the 64-bit wrap model was never in question.
  Seven rounds banked a complete revisit map: design doc
  (.work/bigint-round3-design.md incl. line-verified round-6
  blueprint), solver fact LANDED and dormant (reps.bigintBoxed,
  erasure-diag.js), and every adjacent real bug found en route was
  FIXED and committed (compound-assign, closure return kinds,
  destructure kinds, __is_truthy/numLiteralNode maps banked). If
  ever revisited: start at the round-6 blueprint, $__eq arm first.
  Round-7 agent stopped, its layout.js start restored.
  CLOSURE-RETURN-KIND PRE-PASS LANDED 2026-07-29 (round-6 prereq (a)
  DONE): (1) unary return kinds -- shared kind-generic
  valTypeOfWithLocals (kind.js) re-derives + ?: && || AND the unary
  BigInt family through a caller-supplied local resolver;
  narrowValResults delegates (-25 dup lines). SIBLING CRASH FIXED:
  type.js exprType had the same locals-blind bigint check -- Phase E
  narrowed ~n to i32 while E2 claimed BIGINT = WAT validation crash;
  exprType gains optional valTypes param. (2) closureBodyReturnKind
  pre-pass (flow-types.js): pure AST->VAL derivation with branch-
  local typeof narrowing (TYPEOF_CODE_TO_VAL gained the bigint
  entry), wired at ctx.closure.make (always before call sites) into
  kind-generic ctx.closure.valResult SUBSUMING the NUMBER-only
  numericReturn Set; calleeValType reads any kind. Fail-open on
  unsettled captures, pinned both sides. IMPORT CYCLE broken
  (typeofPredicate -> ast.js). NEW KERNEL-CLASS BUG MAPPED, not
  shipped: same-body `return parse(v)` tail via a TYPEOF-REFINED
  closure proof diverges self-hosted -- wrong @custom jz:i64exp `r`
  flag corrupts the boundary; reproduced across two independent
  implementations; plain (non-typeof) closure proofs clean; deferred
  with pins holding pre-fix behavior (documented at
  closureBodyReturnKind + narrowValResults). Gates: battery 3123/0
  (+4), parity 18/18, ratchet +0, kernel leg 2437/2 pre-existing,
  watr self-host 35/35, dbg green.
  BIGINT COMPOUND-ASSIGN FIXED 2026-07-29 (round-5 bug #1 extracted
  standalone): compoundAssign never consulted kind -- n+=1n rode
  f64.add on the carrier (silent no-op past 2^53); ++/-- identical.
  FIX = desugaring unification: proven-BIGINT targets short-circuit
  to the binary arms' exact IR shape (asI64/i64.op/fromI64,
  I64_ARITH_OP table, same bigintMixReject contract); postfix value
  recovery ((++n)-1 desugar) bypasses mix-reject for the synthesized
  correction constant. Bitwise compounds already i64-correct but
  MISSING mix-reject (n&=1 gave 0n vs TypeError) -- added. SIBLING
  MAP (pre-existing, documented NOT fixed): obj.n++/arr[0]++ broken
  via prepare's number-literal desugar (reproduces for hand-written
  obj.n=obj.n+1; obj variant also FLAKY across repeated compiles --
  schema-census reuse, separate serious gap); bare `return ++n`
  exports raw f64 (narrowValResults valTypeOfWithCalls has no unary
  BigInt cases -- SECOND independent hit on round-6 prereq (a));
  >>> has no BigInt arm at all (should throw per spec). Pins x3 in
  statements.js (2^62 boundaries, host-JS authority). Gates: battery
  3119/0 (+3), parity 18/18, ratchet +0, kernel 2433/2, dbg green.
  ROUND 5 WALL 2026-07-29 (emit half attempted, tree restored byte-
  exact -- parity 18/18 + ratchet 10/10 verified at HEAD post-
  restore): the write-sound/read-proof-gated architecture HELD
  (boxBigInt/unboxBigInt + isProvenBoxedBigint deliberately NOT
  fail-closed toward boxed [false "boxed" guess = bogus deref] +
  carrierF64 as the single W-sink choke-point + readI64 arithmetic-
  core wrapper + coerceArg both directions + R-recovery tag arms,
  features.bigint-gated per the documented toNumF64 ring/fgather
  precedent). FIVE REAL BUGS verified-fixed en route (re-apply in
  round 6): (1) STANDALONE, LIVE AT HEAD: compound-assign on BigInt
  accumulator rides generic f64 path -- 4611686018427387903n += 1n
  is a SILENT NO-OP today (extract + fix NOW, independent of
  boxing); (2) isProvenBoxedBigint must exclude BigInt64/U64Array
  elements (design row-8 exemption, OOB otherwise); (3) bigint:
  toString + BigInt.asIntN/asUintN bare asI64 on boxable receiver;
  (4) ternary-nullish decl/assign double-boxed the '?:' emitter's
  already-correct mixed output (null corrupted into bogus box); (5)
  Set/Map need BIGINT content-compare/hash arms (only matters once
  boxed). THREE ROUND-6 PREREQUISITES (open in this order): (a)
  closure-return-kind PRE-PASS -- calleeValType can't see direct-
  dispatched closure valResult (closures compile at module end,
  after callers); real shape: watr's own uleb/limits `typeof v===
  'bigint' ? v : BigInt(str)` broke watr self-host; general fix =
  pre-scan closure return kinds, NOT per-site patches (standalone
  inference win beyond bigint); (b) audit ternary-nullish
  consumption as ONE mechanism (decl, param, nested chain via
  narrow's param lattice -- test/inference.js 'callee null guard
  stays live' still failed after local fix); (c) bisect the O0
  kernel-parity divergence (dict O0 native 226404B vs kernel
  225480B) that appeared late -- self-hosting correctness is the
  constraint every round failed on; diagnose BEFORE any emit work.
  ROUND 4 STEPS 0-1 LANDED 2026-07-29 (solver fact computed, emit
  deferred to round 5 with a precise brief): erasure diagnostic
  rebuilt (src/compile/erasure-diag.js, JZ_DBG_BIGINT_ERASURE) --
  sibling array-destructure repro NOW FIRES post-b09969bc (corpus
  198 hits: call-arg 149/return 27/collection 11 [was 0]/ternary 5/
  dataview 6; kernel graph 76 hits). SOLVER FACT: reps.js
  bigintBoxed field; analyze.js intra-body W-sink walk (escapes
  clone, fail-closed on unresolvable call targets); narrow.js param
  half (destructured params fail-closed; else boxed iff any live
  call site fails to prove BIGINT, via inferValAtSite); idempotency
  assert 0 violations. WARM-CAP BET CONFIRMED STRUCTURALLY:
  ptrBits/packPtrBits settle ZERO boxing (verified standalone);
  kernel graph boxes only 10 locals + 1 param, sole layout-adjacent
  hit is i64Hex (hex formatter). Byte-identical WAT (parity 18/18,
  ratchet +0) because the fact is UNCONSUMED -- zero-risk increment.
  ROUND-5 BRIEF (the real step-2 surface): once bigintBoxed(name)=
  true EVERY read must unbox incl. the ~10 arithmetic-core sites
  (asI64-replacing wrapper in emit.js), not just the 9 W-sinks;
  param boxing happens at the CALLER's call-site emission (callee
  never re-proves); + 6 R-recovery tag arms (core/number/collection/
  interop) + round-1/2 re-applications + carrier un-curation + the
  §4.2 erasure assert (needs the box calls to check against).
  ESM trap for diagnostics: destructured import of a reassigned
  array orphans it -- truncate in place (.length=0), never reassign.
  ROUND-4 PREREQUISITE LANDED 2026-07-29: array-destructure kind loss
  FIXED at root -- prepDecl's object branch had TWO kind-recovery
  mechanisms (flatObjects SRoA + ctx.schema.vars/slotVT) with NO
  array sibling (flatObjects' array gate requires constant elements
  for a REAL closure-table hazard; schema dedupes by prop-name set,
  arrays have no partition key -> program-wide array schema would
  self-poison). FIX: per-binding kind-only ctx.schema.arrayVars
  (destructure-temp name -> prepped element nodes; sound because the
  temp is synthesized single-write non-escaping) + kind.js VT['[]']
  consumer via staticIndexKey -> valTypeOf(elems[i]) -- GENERIC, all
  kinds flow (BIGINT/STRING/BOOL/OBJECT pinned). SYMMETRIC pre-
  existing gaps documented not fixed (nested patterns, defaults --
  both forms equally; destructured PARAMS = per-index tuple param
  inference, a larger feature; the round-4 solver treats unproven
  param destructure as bigintBoxed=true fail-closed, so this does
  NOT block round 4). 11 pins in test/types.js (onKernel-guarded
  inspect sinks). Gates: battery 3116/0 (+11), dbg leg 3116/0,
  parity 18/18, ratchet 10/10 +0, kernel leg 2430/2 pre-existing.
  ROUND 3 STEPS 1-2 EXECUTED 2026-07-29 (agent, design-mandated stop
  at the gap gate; tree restored): erasure-graph diagnostic built
  (post-emit walk, JZ_DBG_BIGINT_ERASURE) + run: corpus 179 hits
  (call-arg 145, return 25, dataview 6, ternary-nullish 3; ZERO
  collection-shape hits -- suite barely exercises bigint-through-
  collections), kernel graph 99 hits (call-arg 78, return 6,
  dataview 9, closure-capture 1, ternary-nullish 5). Design §2
  VALIDATED by spot-checks; ONE over-scope corrected: Atomics
  receivers are compile-enforced proven -- only DataView.getBig64 is
  the live row-8 risk. Diagnostic fires on ALL 9 sink shapes incl.
  the round-2 dict repro. THE GAP (risk 1 confirmed): ARRAY
  destructuring -- let [a,b]=[1,BigInt(v)] AND ([a,b])=>... --
  silently DROPS the VAL.BIGINT kind fact (object destructure + 
  direct bindings preserve it; diagnostic-walker miss ruled out by
  controls). Root: kind.js/analyze.js destructuring path. ROUND-4
  PREREQUISITE: fix array-destructure bigint kind preservation, re-
  run the sibling repro until it fires, THEN steps 3-4. Driver trap
  for future diagnostic runs: tst test() only REGISTERS -- use
  TST_MANUAL=1 + await run() or the collector reads zero. Scratch:
  session scratchpad run-corpus-diag2.mjs, corpus-hits2.json,
  kernel-hits.json, repro-dict-bigint*.mjs.
  ROUND 3 DESIGN COMPLETE 2026-07-29: .work/bigint-round3-design.md
  -- solver-computed bigintBoxed rep fact (raw iff def+all reachable
  uses prove BIGINT; clone narrow.js's nullability lattice), boxes
  materialize at last raw-eligible point, kind-erased readers
  dispatch on the exact PTR.BIGINT tag (magnitude heuristics DIE),
  W-sink/R-recovery inventory with file:line, dbg erasure-graph
  assert (would have caught round-2's dict OOB at compile time),
  implementation ORDER de-risked: diagnostic walk first as empirical
  inventory -> dict repro must fire it -> solver fact -> emit. Warm
  cap survives because kernel layout/assemble math settles raw.
  Honest risks incl. solver completeness (THE bet), generators/
  destructuring walk coverage, ternary-nullish re-derivation.
  ROUND 2 WALL 2026-07-28 (honest stop, tree restored to 32306df8):
  boundary boxing is CONCEPTUALLY INCOMPLETE as specified -- the
  unbox fallback (runtime tag check on kind-UNPROVEN operands) is
  unsound under self-hosting: the compiler's own layout.js/
  assemble.js compute NaN-box-SHAPED bit patterns as ordinary raw
  BigInt DATA (never boxed, never erased), and a runtime check
  cannot tell raw-with-box-shaped-bits from a real heap box. Agent
  fixed the universal instance (bigintPayload/cmpOp unconditional
  deref) but a second narrower instance remains UNISOLATED: dict-
  shaped programs (object/property access) trap OOB through the
  kernel; bisected to core.js+emit.js+ir.js JOINTLY; ruled out:
  bigintResultErased, ternary merge-boxing, emitLooseEq bigA/bigB,
  __is_truthy arm, $__eq content arm. EIGHT REAL BUGS found+proven
  in round 2 (re-apply in round 3, all were green natively at
  3111/3111): emitLooseEq passed boxBigInt f64 as i64 to $__eq;
  Array<BigInt> element reads returned box unread (array.js
  elemOut/elemOutGuarded); reduce/reduceRight VT rule (kind.js);
  DataView.getBig*64 methodValType (kind-traits.js); $__same_value_
  zero + $__map_hash had no BigInt content arms (Set/Map bigint keys
  always missed); ternary-beside-nullish wrongly boxed (nullishArm
  raw idiom); $__box_bigint atom passthrough guard; interop
  decodeBigintResult (4 reserved atoms). ROUND 3 PREREQUISITE
  (design, not code): a SOUND boxing invariant -- the kind lattice
  must make "raw iff both def AND all uses prove bigint" a
  dataflow-checked property (solver-owned), OR every kind-erased
  read must be dominated by a boxed def (no runtime disambiguation
  ever). Until then carrier rows stay curated (audit accepts
  explicit skips until PTR.BIGINT lands). Transcripts hold both
  full diffs.
  EXCLUSIONS BURN-DOWN COMPLETE 2026-07-28: the census root =
  `new Set(undefined)` -- ES says the CONSTRUCTOR skips iteration on
  a nullish iterable (empty set), but jz's new.Set routed through
  __iter_arr's for-of normalizer which (spec-correctly for for-of)
  throws TypeError(0) on nullish; natively masked (compiler runs
  under host JS semantics), self-hosted the compiler's own
  `new Set(skip)` in prepare's renameWalk threw -- localized via the
  compileErrDiag probe channel (stage=front, thrown value = number
  0, probeStage=renameWalk:init = the first walk with skip=
  undefined). FIX: __iter_arr_ctor (nullish passthrough -> existing
  non-ARRAY guard yields the empty seed; for-of/spread keep the
  spec TypeError); spec pin in iteration.js (ctor-empty vs for-of-
  throws). inference UN-EXCLUDED: full kernel leg with EVERY capable
  file = only the 2 user-WIP rows; battery 3101/0; parity 18/18.
  Audit item 8 CLOSED entirely -- remaining exclusions are host-only
  legs + optimize:false shape-mismatch classes, by construction.
  CENSUS ROW DEMYSTIFIED 2026-07-28: NOT order-dependent -- the row
  fails STANDALONE on the current dist, and the mechanism is a plain
  kernel compile bug with a 3-LINE REPRO: compileViaKernel of
  `import { T } from "./m.jz"; export let f = (k) => T[k?"a":"b"](2)`
  with modules {'./m.jz': 'export const T = { a: (x)=>x+1, b: (x)=>
  x+2 }'} THROWS message "0" in-kernel (native OK). Bisected
  ingredients: bigint irrelevant, plain imports OK, imported fn OK
  -- the breaker is the IMPORTED CONST-TABLE-OF-ARROWS + DYNAMIC KEY
  DISPATCH through the module-bundling path (closure-table/devirt
  machinery meeting importSources in-kernel). Earlier 'passes
  standalone' observations were stale-dist artifacts; the row's
  in-suite-only reputation is dead. NEXT: hunt the throw site (err
  with payload 0 -- likely a raw wasm throw or err(0) in the
  closure-table build), fix, then inference joins the gate and the
  exclusions burn-down is COMPLETE. Repro script: scratchpad/
  census3.mjs.
  TIMING MEASUREMENTS SUSPENDED 2026-07-27 (laptop UNPLUGGED, user
  FYI): battery power = throttled/unstable clocks on macOS -- warm
  rounds read 1.020/1.053/0.927 with fft 0.64 (implausible spread =
  power noise). The collection-op agent's change measured as a warm
  regression (1.039-1.073) in that window and was REVERTED to
  baseline -- verdict UNRELIABLE, its diff persists in the agent
  transcript for plugged-in re-evaluation. RULE: no warm-cap, paired
  -bench, or reference-refresh conclusions on battery; correctness
  gates (battery/parity/kernel leg) unaffected and stand.
  WARM-MARGIN LEVER LOCATED 2026-07-27 (compileProfile diagnostic
  landed in self.js -- per-stage kernel wall times over the ABI):
  stage-share differential kernel-vs-native (crc32 corpus, 5 warm
  reps each): optimizeTail (watr fixpoint) 79.6% in-kernel vs 57.9%
  native = 1.38x RELATIVE share -- THE wasm-relatively-worse phase;
  compileAst is relatively FASTER in-kernel (0.42 -- arena beats V8
  GC); front/encode ~parity. The warm cap's remaining ~3% lives in
  watr's allocation-heavy fixpoint running on jz's own Map/Set/hash
  (module/collection.js) -- the lever is collection-op performance
  under the fixpoint's churn profile (or watr-side allocation
  reduction, user's lib). NEXT PROBE: helperCounters/callsites on a
  kernel watOptimize run to rank __hash_get/__map_set/... shares,
  then optimize the top collection op (general kernel win, not
  warm-specific).
  EXCLUSIONS FRONTIER 2-OF-3 FIXED, FIVE FILES UN-EXCLUDED FOR GOOD
  2026-07-27 (frontier agent + in-thread land): the Array.isArray-
  as-value closure-support row and the bool-identity closure-ABI
  'Bad int' row fixed at the root (emit.js + ir.js + prepare/
  index.js — the host-side singleton class the structural-isCallable
  fix opened); errors/parser-bugs/destruct/closures/json now
  PERMANENTLY in the kernel gate (~430 tests joined; full leg =
  only the 2 user-WIP typedarray rows). Remaining frontier: ONE row
  — inference census (const-table arrow args in a bundled init),
  standalone-green in-suite-red, inference stays excluded with the
  note. Gates: battery 3100/0, parity 18/18, kernel leg baseline.
  Warm-margin probe finding banked: watOptimize = 60% of compile
  wall but runs on BOTH ratio sides — the ratio lever must be a
  relatively-worse-in-wasm phase; next probe = kernel-side stage
  timing hooks.
  BOXED-BIGINT DESIGN COMPLETE, IMPLEMENTATION GATED 2026-07-27
  (design agent, read-only, honest stop): REPRESENTATION = heap-boxed
  PTR.BIGINT (tag 5 free in layout.js TAG_MASK), 8-byte i64 heap
  cell, mkPtrIR-consistent with STRING/OBJECT -- unambiguous by
  NAN_PREFIX disjointness from all subnormals; full 64-bit range
  FORCES heap indirection (47-bit payload can't inline 2^63). SEAM =
  NEW boxBigInt/unboxBigInt pair in ir.js beside asI64/fromI64
  (those are a SHARED f64<->i64 bridge with 30+ non-bigint callers
  -- NOT retaggable); substitute at the ~10 VAL.BIGINT-gated emit
  sites + typeof arm + core.js $__typeof (currently NO bigint arm --
  carrier bigints silently report "number") + $__eq (bit-eq fast
  path must grow a PTR.BIGINT deref-compare arm) + number.js helpers
  + interop export boundary. HARD BLOCKERS: (1) module/typedarray.js
  = USER WIP, holds BigInt64Array raw-carrier I/O -- lockstep
  dependency, two coexisting representations would silently break
  typeof/===/arithmetic on array-roundtripped bigints; (2) $__eq
  rewrite is semantic, not drive-by. OPEN DECISION (user): naive
  always-box LEAKS 8B/iteration on bigint accumulator loops (no GC
  for permanent tags) -- accept as documented boxed-type cost vs
  measured small-int fast path. SEQUENCE: user lands typedarray ->
  ONE atomic commit across layout/ir/emit/core/number/typedarray/
  interop -> leak decision resolved BEFORE landing -> full gates.
  No smaller honest checkpoint exists (partial migration fails
  gates by construction; the fold corruption happens inside the
  compiler's own self-hosted evaluation, so literal-only slices
  address a symptom shape, not the mechanism).
  CLAIMS GATE HARDENED 2026-07-27 (audit blocker 4): freshness scope
  now includes layout.js + package.json + package-lock.json (the
  watr-upgrade blind spot) PLUS a watr-version cross-check vs the
  snapshot's meta (currently fails: snapshot lacks the field --
  bench.mjs needs one line recording meta.versions.watr; user's live
  session owns bench.mjs, deferred to them or next quiet window);
  STRICT-LEADERSHIP test split from the band test (a 1.05 band row
  proves tolerance not leadership) -- current in-tree evidence:
  strict unproven on 16 cases, band-exceeded on 8 (results.json in
  tree is the USER's uncommitted refresh w/ porf-native recontest;
  their Porffor CLAIM_RIVALS change incorporated); claims job wired
  into CI test.yml (honestly red until fresh+complete+winning).
  Remaining audit blockers: user lands typedarray WIP (suite green),
  boxed-bigint redesign (carrier rows), warm cap final margin, W2C
  tokenizer 3.851 vs 3.5 cap (new signal in their refresh -- check
  after their bench work lands), tinygo (CLT).
  TARGETPROFILE LANDED 2026-07-27 (the last untouched P1 item):
  named frozen per-target policy profile (js/wasi) constructed in
  beginSession from opts.host -- fields name the POLICY (wasiShims,
  envImports, jsStringInterop, commandEntry, timerModel...) not the
  host; the scattered ctx.transform.host boolean gates across src/ +
  module/{console,core,crypto,fs,navigator,timer,web} migrated to
  profile fields (spot pattern: `host === 'wasi'` ->
  `targetProfile.wasiShims`); legalization seam threaded at
  watr-tail. Gates: battery 3098/0, wasi leg 3100/0, parity 18/18,
  kernel leg baseline (2 fails both user-WIP: typedarray row +
  headline row from their live bench.js edits). With this, audit P1
  = solver DONE, CompileSession seam DONE, TargetProfile DONE,
  LoopPlan slices 1-4 (full candidate model remains).
  CI SIMD RED ROOT-PROVEN 2026-07-27: a clean-HEAD worktree
  reproduces `has v128: false` LOCALLY -- the f32->i16 encode
  vectorization depends on the USER'S UNCOMMITTED module/typedarray
  WIP (every local verification had it in tree; CI compiles the
  committed version whose ToInt emit shape peelNarrowConv no longer
  matches). NOT platform-dependent; probe chain (self-documenting
  assert -> whyNotSimd sink -> pre-watr b64 diff: local select-form
  ToInt16 + inf-guard vs committed if-form without guard) and the
  worktree discriminator close it. watr 5.7.12's codepoint sort was
  a REAL determinism fix but not this cause. ACTION: user lands
  their typedarray WIP (or the emit-shape part peel depends on);
  temp CI probe step removed. Lesson: uncommitted WIP in the
  verification tree can mask committed-state regressions -- clean-
  worktree spot-checks belong in the landing discipline for emit-
  shape-adjacent changes.
  WATR 5.7.12 PIN + LOOPPLAN SLICE 4 LANDED 2026-07-27: user
  published watr with the codepoint-order data sort (the CI-linux
  localeCompare nondeterminism fix, confirmed present in the
  installed 5.7.12); jz pin bumped exact. LoopPlan slice 4: next
  fact class hoisted into the dispatch descriptor (agent, byte-
  identity-gated; spot-corroborated — blur/dotprod/sdf speed-tier
  WATs byte-length-identical vs HEAD). Verified combined: simd
  158/158, optimizer 213/213, determinism 5/5, parity 18/18,
  battery 3098/0, kernel rebuilt on 5.7.12. CI should now go fully
  green on the jz side (remaining red = user-WIP test262 rows).
  REFERENCE DATASET REFRESHED QUIET 2026-07-27 (blocking run, zero
  concurrent work): headline JZ 1.00x -- C 1.91x Rust 2.00x Zig 2.12x
  AS 2.09x Go 4.38x MoonBit 4.15x Porffor 4.67x V8 2.21x behind;
  native C 1.02x. meta.commit = HEAD (claims FRESH axis GREEN).
  Claims red list down to FOUR: trace 1.452 (branch-layout hard
  tail), sdf 1.256 (symbolic-hull research tail), shapes 1.166
  (TurboFan-level tail), glyfparse 1.151 (jittery lane -- led in
  targeted pairs same week; borderline). sort/crc32/fft/synth/
  levenshtein all CLEARED from committed evidence. tinygo axis
  awaits user CLT + install. This is the honest pre-watr-publish
  claims state.
  CARRIER WALL MAPPED + PINS SETTLED 2026-07-27 (in-thread, watr-
  publish runway): (1) ctx.features.bigint SEEDED false in reset --
  the absent-dyn-key read misfired truthy in-kernel, turning the
  toNumF64 carrier gate ON for pure-number programs (5e-324/1e-320/
  2^52+1 exports were corrupt; now exact). (2) NEGATIVE subnormal
  LITERALS + 2^52-1 bigint remain in-kernel-corrupt BY THE WALL: any
  value-level op on carrier-band bits inside the self-hosted compiler
  ToNumbers the carrier -- three escapes tried and refuted in-thread
  (host-neg -x, bit-flip via typed store [ToNumber at the store],
  source-text numlit deferral to watr encode [watr's own in-kernel
  parseFloat->store normalizes]); there is NO ToNumber-free
  value->bits path in the kernel by construction. Rows kernel-
  curated in data.js WITH mechanisms (precedent: -1n<0n); TRUE FIX =
  boxed-bigint carrier redesign (the standing long-term item). (3)
  Exclusions burn-down advanced then time-boxed: 6-file un-exclusion
  reached 2413 pass with THREE order-shifted in-suite residuals
  (Array.isArray-as-value closure-support err; bool-identity
  closure-ABI 'Bad int 0x000000-100000001'; inference census row) --
  reverted to committed exclusions; the frontier is those 3 rows.
  Verified state: battery 3098/0, kernel leg 1958/2 (user WIP only),
  parity 18/18.
  LEAK HUNT RESOLVED TO TWO ROOTS 2026-07-26 (in-thread): (1) FIXED:
  destruct's `({sqrt, abs} = Math)` in-suite failure -- emit.js's
  first-class-vs-niladic builtin dispatch keyed on `handler.length`,
  and function-arity reads are UNSUPPORTED in jz output semantics
  (verified: f.length === undefined in both native-jz and kernel
  output), so the self-hosted compiler routed every first-class
  builtin into the niladic handler() -> empty-IR internal error.
  Fix: STRUCTURAL membership (FIRST_CLASS_UNARY_MATH /
  FIRST_CLASS_BUILTIN_BODY) with .length only as the native fallback
  for the friendly unsupported-name error. Verified: native 248/248
  (destruct+math+errors), kernel destruct standalone 69/69, the
  10-file in-suite prefix -- destruct row GONE. (2) NAMED, OPEN: the
  data.js P0-2 pin failures are NOT compile bugs -- direct
  compileViaKernel compiles export -5e-324 and 2^52-bigints EXACTLY;
  the harness jz() path exports -1 because the EXPORT-BOUNDARY KIND
  MARSHALING is missing on the kernel leg: native compiles carry an
  export-kind table the interop wrap consults to distinguish
  bigint-carrier bits from genuine subnormals; the kernel returns
  raw bytes without it -> host wrap falls back to the magnitude
  heuristic -> carrier misread. FIX DIRECTION: kernel ABI conveys
  export kinds (custom section or a kinds-JSON export) and interop
  consults it on the kernel path exactly as native. The earlier
  'SSO ir.js delta causes it' bisect verdict was confounded by
  stale dists -- the interop-kind explanation fits all evidence
  (bare instantiate path exact, jz() path misreads, native green).
  EXCLUSIONS BURN-DOWN PROBED 2026-07-26 -- IN-SUITE LEAK CLASS
  ISOLATED: all 7 debt files (errors 111, parser-bugs 23, transform
  9, destruct 69, closures 105, inference 86, json 64 = ~467 tests)
  pass FULL-FILE STANDALONE on today's kernel -- the hang class and
  resolver class are CURED. But IN-SUITE (full kernel leg with them
  included) ~6-8 rows fail DETERMINISTICALLY: destruct's
  `({sqrt, abs} = Math)` errors with AST ["=","sqrt","math.sqrt"]
  (a math-namespace binding leaking across kernel compiles),
  data.js's new P0-2 subnormal/2^52 pins, inference's census row,
  transform's canonicalize row. Standalone-clean + in-suite-red +
  deterministic = the kernel long-session state class, now WITH a
  reproducible inventory (unlike its heisenbug appearance 07-25).
  REVERTED the un-exclusion to keep the committed gate green; the
  burn-down lands after the leak hunt. HUNT RECIPE: file-subset
  bisection on the kernel leg ending at destruct (the sqrt row is
  the sharpest victim -- a namespace/binding table entry surviving
  _clear between compiles; suspects: DOLLAR/interned-string maps
  rebuilt but a consumer caching a stale index, or ctx.module
  include state); each cycle ~minutes with targeted file lists.
  SSO NAME-BITS LEAK FIXED 2026-07-26 (banked residual closed): the
  json 'Bad int 9.06791031e-315' ("meta" ASCII bits in an integer
  position) -- kernel-compiled `let SRC; JSON.parse(SRC).meta.scale`
  failed to compile. Fix across module/number.js + src/ir.js +
  src/prepare/index.js (agent-refined twice after the perf ratchet
  caught the first two versions pessimizing hot loops: initial
  ring +920/fgather +1600 scoped down to ring +520 only). Repro
  returns 2 via kernel; bench-selfhost 22/22 (json row restored);
  battery green except the one ratchet row; ring RE-BASELINED
  98120 -> 98640 (+0.53%, one synthetic corpus category) --
  JUSTIFIED: the residual cost is the value-correctness price after
  two scoping rounds; a silent string-bits-into-integer corruption
  class outweighs 0.53% loop-body ops on one synthetic shape.
  fgather baseline unchanged (62880).
  SOLVER + LOOPPLAN SLICE 3 LANDED 2026-07-26 (combined tree, all
  gates green: battery 3098/0, kernel leg 1958/2 user-WIP only,
  parity 18/18, simd 158/158, dbg-invariants leg green, fresh dist):
  (1) SOLVER: session-owned factStore (src/session.js createFactStore
  -- programFacts{walkCache,moduleInitSlot,bodyIntCertain,hazard} +
  bodyFacts + bindingUses slices, DEPS table documented, gen-counter
  dependent-invalidation assert reasoning recorded); cache modules
  (program-facts/analyze/analyze-scans) keep APIs but store through
  getFactStore(); convergence exhaustion now THROWS internal compiler
  errors in production (probe-first proved zero fires across battery
  + kernel + bench compiles before flipping). invalidateLocalsCache
  13 sites + analyzeBody staleability contract = declared next slice.
  (2) LOOPPLAN slice 3: the most-duplicated recognizer fact class
  hoisted into the dispatch descriptor (see agent inventory in
  transcript), byte-identity-gated (zero WAT diffs on the bench
  corpus), recognizers consume the plan. AUDIT P1 substantially
  closed: solver ownership + convergence hard-fail DONE, LoopPlan
  advanced (full candidate-proposal model = remaining vision),
  CompileSession seam live. Remaining plan: P2 exclusions, quiet
  reference refresh + claims gate, user unblocks (watr release,
  CLT/tinygo), banked hunts.
  SORT FLAG-VETO LANDED 2026-07-26 (all gates green): dataDependentFlag
  predicate (ir.js ~610 -- select condition contains a nested value-if
  carrying a memory load = the &&/|| short-circuit lowering over loads)
  composed with eagerSelectOK at all four ?: select-emission sites
  (emit.js ~456); post-watr fold already structurally excluded the
  shape (isPureIR(cond) -- documented). Heapify pick-larger-child
  sites now branch form; unrelated selects byte-identical. SORT
  1.115x -> 0.969x then confirmed LEADING zig (11.76 vs 15.17ms on
  the larger-n run); noise 0.830x kept its cheap-flag select, synth
  1.022x, trace 1.463x (hard tail), fft 1.026x -- no regressions.
  Battery 3096/0, optimizer 213/213 (flag-axis pin added), parity
  18/18. RED LIST NOW: sdf ~1.3 (research tail), shapes 1.27
  (TurboFan hard tail + one versionableTypedNest confirm), crc32
  1.05 border. trace 1.47 hard tail. Every other lane LEADS.
  SHAPES + SORT DISSECTED 2026-07-26 (parallel agents, ABBA-retimed):
  SHAPES 1.27x vs AS = HONEST HARD TAIL -- mul-strength-reduction and
  pointer-walk surgeries both V8-NEUTRAL (0.99-1.05x noise);
  machine-code evidence (archive 2026-07-20e reconfirmed): +4 cmp
  incl 2x b.ls heap-bounds branches TurboFan keeps + 6 const remat
  per iter -- TurboFan regalloc/BCE below WAT level; ONLY remaining
  jz candidate: confirm whether versionableTypedNest fires on the
  record scan (JZ_DBG_VS, unmeasured share; would retire the 2
  b.ls). todo.md:1048 'byte-stride follow-up' label is a STALE
  MISNOMER (hypothesis falsified 07-20e). SORT 1.115x vs zig = ONE
  REAL LEVER: the 'pick larger child' select's FLAG is a nested
  data-dependent if (cond1 && f64.lt loads) -- branch-form surgery
  (block + br_if skip-store, both heapify loops) retimed 1.063/
  1.118x = closes ~all of the gap (extrapolated; direct paired
  confirm needs the landed fix). NEW VETO AXIS: not arm cost
  (hasExpensiveOp) but FLAG construction -- a select fed by a nested
  if over data-dependent comparisons loses to the branch form on V8.
  Sites: optimize/index.js post-watr if->select ~4272 + emit.js
  eagerSelectOK ~456. Comparator-dispatch WATCH note ruled out
  (raw f64.lt, no calls). BANKED neutral-but-real: cse-load.js
  runSeq treats if-statements as opaque -- never scans the ALWAYS-
  EVALUATED condition for available reads (redundant f64.load pair
  in swap; V8 masks it; emit-quality item). Fill SIMD 1.88x local
  but <1% share. Tooling note: wat2wasm rejects jz's U+E000 idents;
  use watr assemble.mjs for surgery.
  narrowMutatedParams + CompileSession SLICE LANDED 2026-07-26 (all
  gates green): (1) mutated-param i32 specialization -- a body-
  written param admits i32 narrowing when every caller passes i32
  AND every mutation RHS proves int-safe with the param seeded i32
  (reuses type.js int machinery); the i32-specialized reassign path
  emits native local.set; result narrowing picks it up through the
  existing ordering. TRACE 1.86x -> 1.47x MEASURED via the real
  runner (exactly the surgery share); the residual 1.47x is the
  ledgered branch-layout hard tail. Regression pinned in
  inference.js (int-mutated param promotes; float-mutated stays).
  (2) CompileSession first slice: src/session.js beginSession owns
  per-compile lifecycle (reset, ALL cache clears, name-uids,
  warnings, strict/host/optimize normalization, post-reset assert);
  setupCtx/setupSelf are thin host-policy wrappers -- setup drift
  now structurally impossible (audit P1 stage-4 seam). VERIFIED:
  native battery 3093/0, kernel leg 1958-class/2 user-WIP only,
  parity 18/18, inference 84/84, optimizer 212/212, trace paired
  1.47x, fresh dist. Reds remaining: shapes 1.22, sort 1.15, sdf
  ~1.3 (research tail), crc32 border; polluted results.json + bench
  svg NOT landed (quiet-machine refresh pending).
  TRACE LEVER MECHANISM CORRECTED 2026-07-26 (locator agent, file
  evidence): INLINER EXONERATED (inline.js has zero rep logic --
  it faithfully clones the signature narrow.js already fixed).
  Real trap, two cooperating refusals: (1) narrow.js
  applyI32ParamSpecialization (line 95) EXCLUDES any body-written
  param (findMutations, line 113/115 -- `nc++` is a write) because a
  narrowed param's reassignment would emit through the generic f64
  assign path and type-clash (comment 103-106); sibling read-only
  params sx/sy DO promote -- exactly the observed split. Same
  mutation-guard repeats in validateTypedLenParams/
  validateIntConstParams/applyPointerParamAbi (systemic policy).
  (2) type.js intLevelMap (2460-2507) seeds f64 params at level 0
  (anti-vacuous-fixpoint, 2473-2484), so the self-referential
  `nc = nc+1` def evaluates 0 && 2 = 0 forever -- structurally
  unprovable once (1) refused. (3) narrowI32Results (400) runs
  AFTER param specialization (1689 vs 1665) and types `return nc`
  off the already-decided param type -- the f64-ness propagates to
  the result automatically. LEVER (named): narrowMutatedParams --
  extend applyI32ParamSpecialization to admit a mutated param when
  every mutation RHS is provably int-safe (intExprChecker/
  intLevelMap applied with the param optimistically seeded i32),
  AND fix the generic-f64-assign limitation so specialized params
  get i32-native local.set on reassignment. Expected: trace 1.86 ->
  ~1.47 (the measured surgery share); general win for every
  monotone-counter param (cursor-through-helper shape).
  TRACE DISSECTED 2026-07-26 (agent, ABBA + WAT surgery, checksum
  1827210493 held): 1.86x = TWO layers. (1) FIXABLE ~45% of gap,
  V8-POSITIVE: monotone array-write cursor `nc` (param+return of
  inlined traceLoop) carried as f64 through the hot loop -- f64->
  i64->i32 round trip per iteration for the store index -- because
  the INLINER CLONES THE CALLEE WITH PRE-INLINE CALL-BOUNDARY REP
  BAKED IN (VAL.NUMBER at updateRep sites compile/index.js ~584/
  1714/1740, boundaryI64 ~751/759) and never re-derives rep from the
  flattened intra-procedural uses (hoistNestedCalls inline.js:355,
  temp mint ~665). i32-shadow surgery: 1263->1004us = 1.258x
  speedup, vs c-wasm 1.86->1.47x (confirmed twice). LEVER: re-run
  int/range narrowing AFTER inlining per inlined-temp local (same
  proof classes as plain locals); must not leak into non-inlined
  call sites (f64 ABI contract stands). NOT covered by cursor-
  versioning (that's bounds elim, this is representation). (2) HARD
  TAIL ~1.47x: the already-ledgered branch-layout class (data-
  dependent if(inside), no conditional store in wasm) -- correctly
  stays. Deficits 2/3 (re-derived bounds check on tested index;
  asymmetric y-half range fusion) RETIMED V8-NEUTRAL (1.003/1.004x)
  -- emit-quality only, low priority. Surgery artifacts persist in
  scratchpad (trace-*.wat/wasm, retime harnesses).
  TRUE RED LIST via TARGETED PAIRED RUNS 2026-07-26 (user's call:
  suspects only, quiet, ABBA-paired): fft jz LEADS 0.92x and
  glyfparse LEADS 1.00x -- their 'red' readings in the concurrent-
  work-polluted full refresh were noise (lesson: NEVER run the
  reference refresh while working; the polluted results.json in tree
  is NOT committed). REAL reds: trace 1.86x (c-wasm -- worst),
  shapes 1.22x (as), sort 1.15x (zig), sdf 1.24-1.34x (research-tier
  banked), crc32 1.05x borderline band-edge. synth + levenshtein
  cleared by the select-veto wave. NEXT: trace dissection (sdf/synth
  methodology -- measured shares via WAT surgery + ABBA retimes,
  V8-neutrality verdicts); full reference refresh re-run LAST, on a
  truly idle machine (overnight/user-idle), then claims gate.
  CI SIMD EVIDENCE CAPTURED 2026-07-26 (self-documenting assert paid
  off first run): on CI the f32->i16 specimen compiled SCALAR (no
  v128) with inline counter __inl4 vs local __inl2 -- watr made
  DIFFERENT INLINE DECISIONS within one compile on CI. Platform-
  varying input found in watr: optimize.js:7660 dataNodes.sort uses
  ma.localeCompare(mb) -- locale/ICU-dependent collation -> data
  ordering -> offsets -> downstream size/inline decisions differ by
  host = nondeterministic emitted module. LC_ALL=C did NOT repro
  locally (macOS node full-ICU may mask; CI = linux node 24) so the
  localeCompare fix is NECESSARY-but-maybe-not-sufficient: FIXED in
  the watr SOURCE repo (/Users/div/projects/watr src/optimize.js,
  codepoint compare, UNCOMMITTED -- user releases + bumps jz's watr
  pin to pick it up; node_modules copy left pristine deliberately).
  IF CI still red after the watr release+bump: next suspects are
  other watr sorts (4692 net, 7829 callCounts -- look stable) and a
  CI-side debug leg dumping the specimen WAT diff vs local.
  P0-3 WARM PROBE VERDICT 2026-07-26: NO retained-state defect --
  standalone probe (one instance, 30 recompiles of crc32, per-iter
  ms + memory): timing settles 190ms FLAT (iters 2..29, no drift),
  memory pinned 512MB from iter 0 (kernel high-water, reached
  regardless of initial pages -- 2048-page instance identical). The
  0.99-1.035 hover is STEADY-STATE V8 tiering balance between the
  paired JS and wasm sides (the pin file's own comment anticipates
  this band), not accumulating state. Cap stays. The honest lever
  left is making kernel compiles faster in absolute terms (the perf
  queue serves that) -- no warm-specific defect to fix. P0-3 CLOSED
  as investigated-and-attributed; revisit only if the hover worsens
  past ~1.05 again (that WAS a real defect -- preset bools).
  P0-3 WARM MARGIN REFINED 2026-07-26: recovered from the audit's
  1.047-1.094x to a 0.989-1.035x HOVER (run-to-run: one round 0.989
  PASS, next 1.007/1.029/1.035 FAIL) -- the preset-faithfulness fixes
  (bool-atom: kernel now truly runs its speed tier) did the bulk.
  Key datum: FRESH instances geomean 0.771x while WARM hovers ~1.01
  -- the warm instance is ~30% slower than a fresh one per compile,
  so the debt is INSTANCE-REUSE state, not compile speed: suspects
  (a) monotone memory growth (arena high-water -> grown wasm memory
  never shrinks; locality/bounds-check costs), (b) V8 tiering state
  on the long-lived instance, (c) retained-map costs cleared but
  reallocated. NEXT PROBE: log memory.buffer.byteLength per warm
  round (scripts/bench-selfhost.mjs JZ_BENCH_WARM path) and correlate
  round-ratio vs memory size; if monotone-growth-correlated, the fix
  is arena shrink/reset (memory.discard when available, or fresh-
  instance-per-N-compiles policy in the WARM benchmark contract
  itself -- decide vs the 'warm' definition in the pin's comment).
  Do NOT loosen the cap (audit directive).
  CI STATUS 2026-07-26 (after 800185bb): selfhost workflow's 6
  kernel-leg fails FIXED. Remaining CI red = ONE test: 'SIMD breadth
  f32->i16 encode vectorizes' -- CI-LINUX-ONLY (passes locally on
  all legs incl. opt0/opt3: simd 158/158, optimizer 212/212) and
  LEG-VARYING (opt0 at 800185bb's run; wasi+opt3 at the front-half
  run -- the accompanying select-veto matrix fail there self-resolved
  at 800185bb). A WAT-shape assert varying by leg on one platform =
  either platform-conditional test registration (CI totals 3092 vs
  local 3099 -- 7 conditionally-registered tests differ) or a
  remaining host-dependent codegen input (HOST_PROFILE is now EMPTY
  -- wideBigint removed -- so enumerate what else differs: node
  version on CI, V8 SIMD feature detection, relaxedSimd gating).
  NEXT: reproduce CI-side -- add a temporary debug step to the test
  workflow dumping the compiled WAT for the f32->i16 specimen (or a
  matrix-env local repro: check test/simd.js for how that test gates
  and what env the wasi/opt0 legs set; try JZ_TEST_HOST=wasi
  locally), diff CI WAT vs local. Timing of first failure = the
  front-half+veto push, so suspects are the veto's EXPENSIVE set
  interaction with f32 conversion chains ON LINUX-BUILT... but
  codegen must be host-independent -- if a host input is found, that
  is the bug (determinism principle), not the test.
  P0-2 FINAL REPORT BANKED 2026-07-26 (agent, complete): collapse
  point was subscript's number lexer returning host BigInt (in-kernel
  = i64-bits carrier, indistinguishable from subnormal at node-build
  time); fix = ['bigint', decimalStr] tagged node minted in the digit
  wrapper (structural n-suffix detection), consumers simplified
  (kind.js:444 NUMBER unconditional, prepare unary folds drop
  magnitude guards, emitNeg drops subnormal fallback). bignum.js:
  15-BIT LIMBS (not 32) -- forced by mulFitsI32 unsoundness: either-
  operand <= 2^22 admits i32.mul without product-range check, 16-bit
  limb halves both qualify yet product overflows i32 (verified live:
  32768*65536 -> -2^31 in-kernel). FOUR NEW SELF-HOST BUG CLASSES
  BANKED (leads for hunts): (1) mulFitsI32 product-range unsoundness
  (emit.js -- REAL miscompile, worked around structurally, fix the
  heuristic properly); (2) closure-in-loop capture miscompile --
  `for(c){const orig=lookup[c]; lookup[c]=(a,b)=>...orig...}` all ten
  closures shared ONE wrong captured binding in-kernel; (3) O3
  cross-call-site parameter contamination -- same callee called with
  literal-k and variable-k sites read each other's k (traced live,
  time-boxed, worked around by fusing/masking; O3 miscompile hunt
  lead); (4) $__eq null-vs-undefined nullish case was missing +
  emitStrictEq delegated === to ==, needed $__eq_strict split.
  RESIDUALS PROVEN PRE-EXISTING (parent-commit worktree comparison,
  identical repro at 8fe2537b): json 'Bad int 9.06791031e-315' --
  bits decode to ASCII "meta": SSO-packed property-NAME bits leak
  into an integer position in dyn-prop-hash/json codegen
  (collection.js strHashLiteral/ssoMix or json.js runtime parser
  suspects); bench-selfhost 21 DIFF rows = kernel-vs-native BOUNDS-
  CHECK INFERENCE GAP (mat4 $multiplyMany: kernel select-guarded
  load vs native bare f64.load -- optimization parity, not value).
  Both = new audit items. Kernel leg now 1958/2 (BETTER than the
  1955 baseline). NOTE: agent used an isolated git worktree for the
  parent build (sanctioned tooling, working tree untouched).
  P0-2 + REGISTRY LANDED 2026-07-26 (all gates green): tagged bigint
  literals -- kind rides the AST (parse/prepare tagged node, consumers
  key on the tag), kernel 5e-324 -> 5e-324 number (was 1n), pins for
  subnormals/2^52/64-bit boundaries in data/preeval/statements tests;
  host-independent rational fold -- src/bignum.js u32-limb arithmetic
  replaces native-BigInt rational carry, fold|0/2/3 parity rows
  GRADUATED (PARITY_TODO empty again), HOST_PROFILE.wideBigint
  REMOVED (both readers gone); pre-eval-in-kernel fold deviations
  fixed (undefined==null folds 1, slice folds correct) -- the 6
  CI-red kernel-leg failures cleared, kernel leg = only the 2
  user-WIP typedarray rows; single pass registry src/passes.js
  (62 passes/22 tuning/7 hot, zero imports) feeding ctx.js OPTF and
  optimize/index.js presets/validation (audit P2). Verified: native
  3093/0, kernel leg baseline-clean, parity 18/18, selfhost 21/21,
  kernel pins direct. REMAINING audit order: P0-3 warm margin,
  P0-4 reference refresh, P1 solver/LoopPlan/CompileSession, P2
  exclusions burn-down.
  CI RED ROOT-CAUSED 2026-07-26: the 6 kernel-leg failures (null-vs-
  undefined strict/loose, slice negative/no-args, boolean/nullish,
  +1) are PRE-EVAL-IN-KERNEL FOLD BUGS introduced by the front-half
  land (pre-eval now executes as kernel wasm): kernel-compiled
  `undefined == null ? 1 : 0` FOLDS to 0 (native 1), slice folds to
  0-length -- but the RUNTIME paths are proven correct in-kernel
  (x==null with undefined -> 1, runtime slice(-3) -> 3). Class: host-
  JS idioms inside evalConst that deviate under the self-host subset
  (nullish literal classification, optional-chain undefined-arg
  slice). NOT the select veto (that commit was merely the last push
  CI ran). Fix delegated to the P0-2 agent (owns pre-eval.js
  uncommitted); kernel leg is now a MANDATORY local gate pre-push.
  Also: strings.js standalone reproduces 2 of the 6 -- the 'in-suite
  only' theory was wrong this round; direct compileViaKernel repro
  scripts are the tool (no suite needed).
  FRONT HALF + SYNTH LEVERS LANDED 2026-07-25 (joint, battery
  3090/0): (1) src/front.js canonical front half consumed by index.js
  AND all four self.js kernel entries; resetNameUids in setupSelf;
  audit fold repros byte-identical node-side; kernel graph now
  includes pre-eval -- TWO self-host-subset fixes needed (computed
  Math members Math[name]/Math[CONST] -> explicit dispatch tables in
  pre-eval.js); kernel 12.2MB builds green; parity corpus 18 rows,
  mfold graduated (in-wasm preEval folds Math byte-identically --
  earlier 'divergence' was a stale-dist artifact of the crashed
  build), fold|0/2/3 tripwired = the RATIONAL fork (native rational
  carry vs kernel IEEE under wideBigint=false -- compiler-host-
  dependent output, determinism violation; fix = host-independent
  u32-limb rational arithmetic in pre-eval, banked). (2) synth
  levers: select cost veto (hasExpensiveOp) + stripCanon through
  hoistTempDefs -- synth 1.09x RED -> 1.02x BAND vs AS (surgery
  predicted 0.993x; residual gap = implementation vs ideal surgery,
  acceptable; lane no longer red). LESSON (process): piping build
  through tail masked its exit status -- bqvs1mwmd's parity ran on a
  STALE dist and produced two wrong conclusions before the direct
  build surfaced the real error; never pipe a gating build.
  P0-2 LITERAL-KIND DESIGN 2026-07-25 (banked for post-land window):
  mechanism read off emit.js typeof-bigint arm (~426) + pre-eval
  157-161 -- the self-host BIGINT CARRIER is raw i64 bits
  reinterpreted as f64, so small bigints occupy the SUBNORMAL bit
  space (1n == 5e-324 bits) and the only disambiguation is the
  magnitude heuristic |x| < MIN_NORMAL && x != 0 -> bigint; hence a
  genuine subnormal literal misreads as bigint at every kernel
  boundary (typeof, export -- audit repro 5e-324 -> 1n, 1e-320 ->
  2024n). FIX DESIGN (audit-scoped to literals): make the KIND
  explicit in the AST, never the bits -- parse/prepare rewrite
  bigint literals to a TAGGED node ['bigint', '<decimal-string>']
  (string payload = unambiguous in-kernel; number literals stay
  [null, f64]); prepare/pre-eval/emit/valTypeOf key on the tag;
  the magnitude heuristics in pre-eval (structural subnormal fold
  refusal) and emit (typeof arm) then apply ONLY to runtime values,
  and compile-time constants never misread. Runtime computed
  subnormals vs bigint at typeof/export remain ambiguous by carrier
  design -- that deeper redesign (boxed bigint) is out of audit
  scope; document as known limit. Files: src/parse.js (or prepare
  literal normalization), prepare/index.js, pre-eval.js, emit.js,
  kind.js + native-vs-kernel pins for subnormals/signed subnormals/
  2^52-adjacent bigints/64-bit boundaries per audit. CONFLICTS with
  synth-lever files -- implement AFTER the joint land.
  CLAIMS RELEASE GATE LANDED 2026-07-25 (audit P0-4): test/
  bench-claims.js -- committed-evidence-only hard gate wired into
  prepublishOnly (npm run test:claims), three axes: FRESH (git log
  meta.commit..HEAD over src/module/jzify/index.js/interop.js must
  be empty), COMPLETE (every CLAIM_RIVAL incl. tinygo needs >=5
  parity-valid rows), WINNING (no case beyond WASM_BAND_TOL of its
  best rival; band = tie never lead). Currently red BY DESIGN:
  10 stale commits, tinygo 0 rows, 8 red cases (fft 1.081 rust /
  sdf 1.247 c / synth 1.091 as / trace 1.463 c / sort 1.113 c /
  crc32 1.051 c / levenshtein 1.054 as / shapes 1.474 as). ORDER:
  land synth levers -> refresh reference dataset at HEAD on this M4
  (meta.host matches) incl. tinygo rows -> remaining reds = the perf
  work queue (trace and shapes worst at ~1.46-1.47x -- next
  dissection targets after synth).
  SYNTH DISSECTED WITH MEASURED SHARES 2026-07-25 (agent, WAT
  surgery + ABBA retimes, checksum 41574153 held): jz 2688-2707us vs
  asc-O3 2455-2478us = 1.084-1.093x. THREE deficits:
  (1) DOMINANT ~108% of gap: eager-select CASCADE for the ADSR
  4-way ternary -- all three f64.div arms computed unconditionally
  per sample (3 selects chained); rewriting to nested lazy
  if(result f64) flips jz/AS to 0.993x (jz BEATS AS). Lever: the
  '?:' select-gate (src/compile/emit.js ~4144/4186) treats
  isPureIR as the ONLY criterion -- pure but EXPENSIVE arms
  (f64.div/f64.sqrt) need a cost veto, especially cascaded N-way
  chains. Must verify no regression on genuinely unpredictable
  branch data before landing (eager-cheap-select can beat a
  mispredicting branch). NOT previously ledgered.
  (2) SECONDARY ~25%: stripCanon (emit.js 178-198, .canonOf from
  emitNeg 270) cannot see through hoistNestedCalls' temp
  (plan/inline.js ~365-384): `const __tmp = sinTau(ph)` severs the
  structural link, NaN-canon guard survives per sample. 4 minimal
  repros pin the boundary exactly. Lever: def-use closure through
  the SINGLE-DEF compiler-generated temp at the same site. Together
  1+2 measured 0.9756x = jz beats AS on synth.
  (3) ToInt32 guard strip: VERIFIED V8-NEGATIVE (~2% slower
  stripped, reproduced stacked and alone) -- DO NOT TOUCH; the
  select-guard form is faster on V8 than bare trunc_sat here.
  LENGTH-HEADER LICM LANDED 2026-07-25: stable-header admission in
  hoistInvariantLoop -- `i32.load(i32.sub(local.get $X, 8))` is
  loop-invariant when $X is VAL.TYPED or ARRAY neverGrown (header
  word immutable for the binding's lifetime; no alias analysis
  needed) and $X itself passes the standard local.get invariance.
  Stamp fn.stableHeaderNames in compile/index.js (mirrors
  distinctParams), admission in loopInvariance, threaded in
  hoistInvariantLoop. edt1d header decodes 20 -> 5 (v/z/f one each
  at function scope, d one per its two nests). HONEST BENCH VERDICT:
  no measurable sdf wall-clock change (bands overlap; V8 TurboFan
  already LICMs this at JIT tier) -- the win is emitted-code
  size/shape (golden-size class) + non-optimizing consumers
  (baseline tiers, AOT). Regression test pins the shape + bit-exact
  results (optimizer.js 210/210); battery 3088/0; perf golden sizes
  53/53. Deliberately not covered (banked): boxed-pointer receivers
  (isPtrBaseDecode chain match), subarray views (length at base+0 --
  ambiguous with data loads, needs a distinct marker), plain-array
  guard sites in module/array.js (verify the pattern fires there),
  out-of-loop one-shot guards (cheap, skip). The remaining sdf gap
  stays the research-tier symbolic hull (~53% share) -- next
  frontier items: synth 1.09x vs as, raymarcher 0.96x, warm hover.
  SDF GAP DISSECTED WITH SHARES 2026-07-25 (diagnosis agent, WAT
  micro-surgery + retime): jz 6483us vs c-wasm 5228us = 1.24x. The
  edt1d hull-cursor `k` keyed accesses (v[k], z[k], z[k+1], stores)
  = 21-22 guarded sites; stripping ONLY those guard branches (tee
  side effects preserved; checksum matches -> checks provably dead
  for the specimen, just not provable to jz) retimes to 5812us =
  1.11x -- the k-guards are ~53% OF THE ENTIRE GAP. That half is the
  KNOWN research-tier item (archive 'SDF SHARPENED 2026-07-22':
  sentinel invariant z[0]=-INF blocks k-- below 0 + relational elem
  hull v[i] in [0, n-1] with runtime n) -- stays the hard tail.
  NEW ACTIONABLE SECONDARY (unledgered until now): the LENGTH HEADER
  RELOAD -- every guard re-fetches i32.shr_u(i32.load(v-8)) /
  (z-8) from MEMORY per site though v/z are never-resized params
  (loop-invariant): the pointer is cached in a local but the DECODED
  LENGTH VALUE is not carried across the inner-loop scope. Lever:
  extend the bounds-check emission / loadCSE to hoist a proven-
  loop-invariant length decode once per enclosing loop nest (the
  neverGrown/paramNeverGrown rep already exists as the resize-proof
  anchor -- see reps.js neverGrown). Mechanical, isolated from the
  symbolic-hull problem, should trim a real slice of the remaining
  1.11x and helps every checked-access loop program-wide, not just
  sdf. NOTE (process): the agent used `git checkout -- bench/
  results.json` to undo an incidental bench write -- forbidden
  command class; file verified clean, no damage; future agent briefs
  must say 'revert by re-editing, never git checkout'.
  IN-SUITE PERF ASSERT CLEARED 2026-07-25 (bisect agent, three
  independent runs): the perf.js 'JSON.parse walk uses slot loads'
  in-suite-only failure NO LONGER REPRODUCES -- full kernel suite
  1955/1963 with ONLY the user's 2 typedarray WIP rows red; the exact
  34-file preceding subset re-run twice green; 0-200 padding compiles
  + JZ_KERNEL_GC_EVERY parity probed, no effect. The same-day fix
  waves (elemOrigin / bool-atom / recursionUnroll / earlier
  string-compare + preboxed) closed the window of this heisenbug
  class. Instance isolation verified structurally sound (fresh
  Instance per compile over cached Module; setupSelf resets all
  caches). IF IT RECURS: test/perf.js:1272 has JZ_DEBUG_KNIFE=1
  built in -- capture the victim WAT at the red moment, don't
  reconstruct sequences post-hoc. KERNEL SUITE VALUE-DEBT: ZERO
  (excluding user WIP).
  KERNEL PARITY COMPLETE 2026-07-25 -- PARITY_TODO EMPTY: the
  recursionUnroll root was the SHARED-ACC RESET, not a guard fold:
  the fused inlined frame shares the caller's accumulator, but the
  callee's own non-zero init (`let s = 1`, survives zeroinit) cloned
  verbatim RESET the running total each level (watr count() returned
  3 for an 8-node tree). FIX (src/optimize/recurse.js): acc-write
  vetting on the template -- consume-shape `acc = acc +- X` clones
  verbatim; ONE acc-free init as the first acc occurrence at loop
  depth 0 rewrites to `acc += init` in cloneFuse (isConsumeShape +
  readsLocal helpers); tee/reset/in-loop-init/acc-reading RHS bail;
  plus `return V` where V reads acc non-trivially (s*2 double-count)
  bails. Verified: cnt 8/8/8 at O0/O2/O3, zero-init sum exact,
  s*2-return exact at O3, optimizer 209/209, battery 3085 green
  (only the graduating tripwires red mid-run), kernel rebuilt TWICE
  (incl. post-vet), parity 3/3 with PARITY_TODO EMPTY -- every
  corpus row byte-identical at every tier. Regression pinned in
  test/optimizer.js ('recursionUnroll: non-zero acc init fuses as
  +='). The parity long-tail (architecture plan stage 5) is CLOSED:
  three waves -- elemOrigin gate, dyn-spread bool atom, shared-acc
  reset.
  DICT ROWS -- FULL CLOSURE: recursionUnroll BUG, 5-LINE NATIVE REPRO
  2026-07-25: build-dist.mjs line 127 builds the kernel at LEVEL 3
  (recursionUnroll: true). Native repro, no kernel needed:
    const cnt = (n) => { if (!Array.isArray(n)) return 1; let s = 1;
      for (let i = 0; i < n.length; i++) s += cnt(n[i]); return s }
    export let f = () => cnt(['op', ['a', 'b'], ['c', 1]])
  node 8; jz O0/O2 8; jz O3 = 3 (WRONG); O3 + recursionUnroll:false =
  8. So: recursionUnroll (inline a single non-tail self-call, O3/
  speed only) miscompiles heterogeneous-arg self-recursion -- the
  inlined copy's Array.isArray guard folds (or arg coerces) against a
  misproven recursive-arg type. The 'kernel-scale' theory was wrong:
  standalone probes were compiled at O2, the kernel binary at O3 --
  its embedded count() is the miscompiled O3 form at runtime
  regardless of requested compile level. Explains count(b)=3 and the
  select fires (dict|2/dict|3 rows). NEXT (small, land-able): fix
  recursionUnroll in src/optimize/index.js -- find where the inlined
  self-call body folds the isArray/type guard on the substituted arg
  (n[i] elem read must stay UNKNOWN absent a proof; likely the same
  differing-primitive/valType fold family) -- add the repro above to
  test/inference.js or optimizer tests, verify O3 returns 8, battery,
  REBUILD KERNEL (O3 build bakes the fix in), expect dict|2 dict|3 to
  graduate (kernel count() correct -> cap rejects -> select stops ->
  byte parity), PARITY_TODO empty.
  DICT ROWS -- UNDERCOUNT PROVEN, NEW CLASS NAMED 2026-07-25 (heavy
  probe, two deterministic rebuild cycles): in-kernel gate counters
  676/144/81/5 vs node 685/153/145/0 -- gSuccess 5 in-kernel; the cap
  operand count(b) for `(i32.shr_u (local.get $et)(i32.const 1))` is
  8 in node, 3 IN-KERNEL (1 + op-leaf + 1 + 1: both recursive
  self-calls return leaf-like 1). Second round pinned it exactly:
  from INSIDE the rule, b.length=3, Array.isArray(b[1])/b[2]=1/1,
  child lengths 2/2, and DIRECT external calls count(b[1])=3,
  count(b[2])=3 are ALL CORRECT in-kernel -- only count()'s OWN
  self-recursive invocations (`n += count(node[i])` in its for loop)
  return wrong. CLASS: self-recursive call miscompile at kernel
  scale -- recursion-site-dependent, NOT covered by elemOrigin (no
  array mutation; plain numeric recursive accumulator). LIKELY
  MECHANISM to test first: the recursive call site coerces node[i]
  (element read stamped numeric by some lattice fact at 12MB caller
  population -> f64 coercion strips the array box -> Array.isArray
  false in the callee) -- i.e. an element-fact/param-fact misproof at
  the RECURSIVE-ARG position; alternatives: recursive-call codegen
  arg slot corruption, self-call inlining. NEXT LEG: instrument
  count()'s BODY (log typeof/Array.isArray(node) + a marker of the
  call path on re-entry) same heavy-probe discipline (temp export via
  self.js + kernel rebuild + restore); or FIRST try cheap native
  repros: a tiny jz program with `const count = n => Array.isArray(n)
  ? n.reduce-style loop self-recursion : 1` at O2 compiled INTO a
  large module context, checking count(nested) -- if the misproof is
  lattice-driven it may reproduce below kernel scale with the right
  caller mix (numeric-arg callers + array-arg callers of the same
  recursive fn). Kernel restored pristine after probe, parity 3/3
  green (dict tripwires correctly still red). Fix belongs in jz
  (inference/codegen at recursive call sites), not watr.
  DICT ROWS -- NATIVE BLOCKER NAMED 2026-07-25 (tree-tap agent):
  natively the select fold is blocked by watr's ARM-SIZE CAP
  `count(a) > 6 || count(b) > 6` -- count() tallies every array
  wrapper + op-name + leaf token, so ANY binary op on two leaves
  costs 8 > 6 (typed_shift inner arm `(i32.shr_u (local.get $et)
  (i32.const 1))` = 8; char_at arms 17..118). isPure/hasTrap/
  readsMemory all pass. AND the tree-shape theory is DEAD:
  __typed_shift/__char_at are STATIC WAT TEXT (module/core.js:650
  stdlib strings) parsed by watr.parse -- direct tree byte-identical
  to parse(print()) (336B JSON both). So the kernel's select can ONLY
  mean the kernel's count()/cap evaluates differently in-kernel.
  Standalone jz-compiled watr (module-graph path, watr-diff entry,
  987kB) matches node exactly at gate granularity. CORRECTION (esbuild
  theory REFUTED by reading build-dist.mjs line 120): the kernel is
  NOT esbuild-bundled -- it's resolveModuleGraph(scripts/self.js),
  the SAME path as the standalone probe. esbuild only builds dist/
  jz.js. Therefore the divergence is KERNEL-SCALE-DEPENDENT (987kB
  faithful vs 12MB kernel diverging) -- the same enclosing-scale
  class as the shaped-parser bug. count() is trivial (1 + sum over
  children, Array.isArray + .length loop); an in-kernel undercount
  means Array.isArray/.length/recursion misreads at 12MB scale, or
  the cap compare itself. NEXT LEG (decisive, running as agent):
  instrument watr counters + temp gateCounts export in scripts/
  self.js, rebuild kernel WITH probes, compileWat(dict) via kernel,
  read counters, compare to node; then restore pristine + rebuild. ALSO
  worth checking: is the fold DESIRABLE? arms are pure, kernel output
  smaller -- if sound, the cap is miscalibrated in watr itself
  (count() double-counts wrappers vs its own 'small cheap arms'
  intent) -- but that's a watr-repo (user-owned) calibration call,
  not a jz fix; parity direction should be decided AFTER the
  in-kernel count() divergence is explained (an undercount is a
  MISCOMPILE to fix even if the resulting fold happens to be sound).
  Rows remaining: dict|2 dict|3.
  DICT ROWS -- GATE PROBE NEGATIVE 2026-07-25 (subagent, evidence
  exact): every early-return gate of watr's value-if->select rule
  counter-instrumented (gEntry/CondArr/Result/Arity/Pure/Trap/
  ClashEval/Clash/Success) and run on the dict pre-watr WAT under the
  exact resolved O2 opts: node 685/0/510/22/145/0/8/8/0 == wasm
  IDENTICAL, output SHA-1 equal, gSuccess=0 BOTH ENGINES. The rule
  never fires on the parse(print) tree in either engine -- watr's
  gate logic is exonerated at gate granularity. THEREFORE the real
  kernel's select forms come from the DIRECT in-memory IR tree its
  own assemble/emit hands to watr (not parse-built): some tree
  property present in the kernel's direct tree (and absent/blocked in
  native's direct tree AND in parsed trees) lets the rule fire.
  REFINED NEXT PROBE (cheap first leg fully native): re-add the
  JZ_DBG_TREETAP tap in watr-tail.js (2-line env-gated stash, was
  proven this session), instrument the select rule's gates in
  node_modules watr, run the NATIVE pipeline (direct tree) and find
  WHICH gate rejects __typed_shift's inner if natively (counters say
  gPure=145 and gResult=510 are the busy rejects on parsed trees);
  then reason/diff what the kernel's direct tree does differently at
  that exact check (suspects: result-type annotation shape, isPure's
  OPCODE membership on jz-built nodes, string-vs-number const args).
  Probe scripts persist in scratchpad (gen-dict-wat.mjs, run-node.mjs,
  wasm-probe.mjs, dict-prewatr.wat, dict-watropts.json). watr
  restored pristine 5.7.11; entry restored; no commits by the agent.
  Rows remaining: dict|2 dict|3 only.
  DICT ROWS -- NEXT PROBE READY 2026-07-25 (superseded by the above): the select conversion is
  watr's value-if->select rule at node_modules/watr/src/optimize.js
  ~1253 ((if (result T) c (then A)(else B)) -> (select A B c), gates:
  non-const cond, result i/f 32/64, arm count()<=6, isPure both arms,
  hasTrap/readsMemory reject, and a cond-writes-vs-arm-reads clash
  scan under !isPure(cond) that probes OPCODE[n] membership). Kernel
  fires it on __typed_shift/__char_at; native does NOT -- yet on
  paper the gates pass for __typed_shift's inner if in both engines.
  Per-func diff post-carrier-fix: ONLY $__typed_shift (nat 389/ker
  281), $__char_at (2413/2335), $count$exp (72461/72579). NEXT: the
  established probe pattern -- counter-instrument EACH early-return
  gate of that rule in node_modules watr (allocation-free counters +
  __counts getter, same as the outline hunt), run dict pre-watr WAT
  through node-watr AND jz-compiled watr (watr-diff entry), diff
  which gate diverges; suspects in order: (a) count()/size lookup
  misread in-kernel (numdata/OPCODE dict reads -- the dyn-dict class),
  (b) isPure OPCODE membership probe, (c) the fixpoint round budget
  (ROUNDS caps) differing via an earlier pass count. Note the probe
  must run BOTH the plain rule and the fixpoint context (rule may be
  reached different number of times). Restore pristine watr@5.7.11
  after (rm -rf node_modules/watr && npm install watr@5.7.11
  --no-save). Remaining rows: dict|2 dict|3 only.
  PARITY sum|3 + arr|3 GRADUATED 2026-07-25 (same session, root
  found where the tree-metadata theory pointed away): the kernel's
  resolveOptimize PRESET CHAIN lost every literal-bool override --
  {...ALL_ON, rotateLoops: true, ...} lowers via emitDynamicSpread
  (fromEntries source = unknown schema -> HASH) whose explicit `k: v`
  writes stored emit(v) RAW: literal true landed as 1.0 bits, not the
  TRUE atom, so `cfg.rotateLoops === true` (strict identity vs atom)
  read FALSE in-kernel and speed-tier passes silently dropped (sum|3
  loop rotation, arr|3). Proof chain: explicit optJSON key rotateLoops
  -> kernel output byte-identical; preset-delivered -> dropped;
  standalone repro at 8 keys (fromEntries+spread+literal bool, ===
  true fails, truthy read passes); fix = storedValue/carrierF64 at
  emitDynamicSpread's explicit-prop write (module/object.js), one
  line + comment. Regression pinned in test/bool-identity.js
  ('dyn-spread literal bool props keep the atom') -- the existing
  preset-table test read flags TRUTHILY, exactly how it missed this.
  Battery 3084 green; kernel rebuilt; PARITY_TODO now ['dict|2',
  'dict|3'] only (select forms in __typed_shift/__char_at -- the
  watr-input-level mechanism, still per the DIAGNOSED entry below).
  PARITY ROWS DIAGNOSED 2026-07-25 (post-elemOrigin, fresh evidence):
  per-func diff dict|2 = ONLY 3 funcs differ ($__typed_shift, $__char_at
  smaller in-kernel via select forms; $count$exp +118B); sum|3 kernel
  856 vs native 991 (kernel hoists the loop-bound local.set out of the
  br_if tee; native keeps the fused tee). INVERTED THEORY: kernel is
  MORE optimized, not bailing. Eliminated: cfg (resolveOptimize(2) ==
  {level:2} modulo unread 'level' key), preset spread-override shape
  (differential-clean at 60-key scale), watr opts (replayed native
  resolveWatrOpts base + every knob variant: base reproduces NATIVE
  byte-exact, NOTHING reproduces kernel), watr engine (jz-compiled
  standalone watr == node watr under BOTH O2- and O3-resolved opts,
  SAME on the very pre-watr WAT), funcCount/unroll2 (no effect),
  pre-watr pipeline (watr:false prints byte-IDENTICAL native vs
  kernel; only watr-tail reads cfg.watr so no pre-watr stage branches
  on it). REMAINING EXPLANATION: the tree HANDED to watr differs in
  print-invisible ways -- native feeds jz IR arrays (typed() .type
  props, shared subtrees via dup(), JS numbers) while parse(print(t))
  canonicalizes; natively direct==parsed (991==991) but in-kernel
  direct(856) != parsed(991) -- the kernel's direct tree unlocks folds
  watr won't make on native's direct tree. NEXT PROBE (cheap,
  decisive): capture native's direct pre-watr tree (hook watrTail or
  export a debug tap), diff node-identity/props/number-vs-string
  against parse(print()); then find which watr shape-check the native
  metadata blocks -- fixing THAT likely makes native adopt the
  kernel's better output (select folds + hoists = native wins left on
  the table), and parity follows for free. Rows stay in PARITY_TODO
  meanwhile.
  LANDED VERDICT (same day): battery 3084/0 green; kernel rebuilt;
  kernel-target suite 1953/1962 -- the json 'shaped runtime parser'
  assert CLEARED (was 2 shaped-parser fails, now 1), remaining fails =
  user's 2 typedarray WIP rows + ONE perf.js assert ('JSON.parse walk
  uses slot loads') that PASSES standalone under the kernel target
  (json.js 64/64, perf.js 53/53) and fails only in-suite -- the known
  in-context/kernel-long-session state layer, a separate smaller class.
  Parity rows did NOT graduate (misread tripwire messages: green =
  divergence still present): dict|2 dict|3 sum|3 arr|3 remain, their
  divergence is in-kernel jz pass decisions, not the watr class.
  Regression test added (inference.js 'push on a param settles no
  element fact'). Fix = analyze.js elemOrigin gate + analyze-scans.js
  isFreshArrayCtor export; probes all stripped, scratch cleaned.
  ROUND 6 CORRECTION 2026-07-25: tokenizer EXONERATED -- commit()-level
  anomaly probe (parse.js __pLog, drained post-trap) shows P[] EMPTY:
  every token is born with correct length at 140kB scale. AND the same
  log line that shows l0=0 PRINTS the string correctly (String(x) ok,
  x && x.length reads 0) -- the isolated guarded-length probe passes
  both engines, so the l0=0 evidence is DOWNGRADED to a possible probe-
  context artifact (or a real but context-locked length-read miscompile
  inside the compiled watr module -- unresolved). SOLID remaining facts:
  the OOB trap fires INSIDE outline at scale with CORRECT pass flags and
  CLEAN tokens; 'fold' alone OK, '+outline' traps. NEXT: binary-search
  INSIDE outline via early returns (after the facts walk / after exact
  grouping / after chosen / after apply) to pin the trapping stage; the
  facts walk's hash-string churn (h += ',' + f.h; up to 64-char keys +
  hash32 over ~86 groups x rounds) is the prime allocation-pressure
  suspect. Then shrink THAT stage into a standalone jz repro.
  ROUND 5b MINIMAL-REPRO REFUTATIONS (guide the next shrink): (1) plain
  `buf += str[i++]` accumulator + push at 140kB scale: CORRECT in-wasm;
  (2) boxed-buf (commit-closure) + recursion (parseLevel shape) + nested
  arrays at ~200kB: CORRECT. Remaining ingredients of the REAL tokenizer
  not yet in the repro: `level.loc = pos` (PROPERTY WRITE ON ARRAYS --
  dyn sidecar on array at scale, prime suspect), the q-state string/
  comment branches (`buf += str[i]` TWO-char appends, `buf = str[i++] +
  str[i++]` reset form), `level` reassignment through the closure, and
  running INSIDE the full watr module (module-scale locals/globals).
  Next shrink: add level.loc writes first, then the two-char append
  forms; alternatively instrument watr's parse commit() in-place to log
  buf.length vs pushed-token.length at scale (post-trap drain channel).
  RESOLVED clamp-peel blocker: the rejecting node was the PEEL'S OWN
  synthesized `__pks0 = (r < w ? r : w)` bound -- both param proofs read
  the min-ternary arms as bare-use/string-escape rejects, un-proving the
  very params the peel had relied on. FIX: min/max-ternary pass-through
  (arms mirror cond operands) in paramAllUsesNumeric + paramNeverString.
  LANDED green: battery 3084/0, ratchet 10/10, watr-diff ALL SAME,
  -1n<0n O2 kernel TRUE (row un-curated), kernel suite 1953/1962 (only
  shaped-parser json asserts + user's 2 in-flight WIP rows). json's 2
  structural asserts persist -- the in-context layer of the shaped-parser
  bug is deeper than the compare misproof (context-dependent as the old
  harness refutation showed); the watr-diff harness is the tool to peel
  its next layer.
  TOOLS (scratchpad, session-dir): watr-diff.mjs + .work/watr-diff-entry.mjs
  (node-watr vs jz-compiled-watr, 30s cycles, killable children);
  jzify-diff.mjs + .work/jzify-entry.mjs (same for jzify).
  WATCH after land: sort-comparator closures `(a,b)=>a<b?...` now take the
  runtime dispatch -- check bench sort/aos; cure would be callsite-lattice
  number proof (ptRow), never raw compares.
  WARM FOLLOW-UP 2026-07-25: the call-based dispatch cost ~4% warm
  (1.076/1.080/1.035); non-NaN INLINE fast path added (two f64.eq, no
  calls -- every NaN-boxed carrier is a NaN, so both-non-NaN => genuine
  numbers => plain f64 compare; only NaN-ish operands pay is_str_key) --
  recovered to 1.007/1.028/1.035 (pre-wave hover). STILL over the 0.99
  cap: the hover predates this wave (audit measured 1.003-1.114 at the
  previous HEAD). Worst case sort 1.04 -- kernel's own comparator-ish
  compares still dispatching. NEXT margin levers: profile warm compile
  for surviving dispatch sites in compiler-source hot paths and prove
  their operand kinds (callsite lattice / valResult), not raw compares.



* [x] watr 5.7.11 PUBLISHED (user, 2026-07-23); jz dep bumped+locked,
      determinism 5/5 against the LOCKED package (no sibling symlink) —
      audit P0 CLOSED. Battery 3066/0 on published watr.
      Unblocks determinism-from-lockfile (audit P0) + CI determinism leg.
      CONFIRMED on CI @HEAD: test workflow fails ONLY 'determinism:
      warm-process recompile' x2 (published watr lacks the reset); watr
      workflow GREEN. Still to triage: selfhost/bench/test262/pages reds
      (test262 likely pre-existing curated-set drift). selfhost red = warm
      perf gate 1.041x vs 0.99 cap — CI builds the kernel with PUBLISHED
      watr@5.7.10, missing the local watr optimizer work the 0.949x baseline
      was measured with — same watr-publish root as determinism.
* [x] Bench refresh at HEAD: CI bench workflow now commits results.json
      (18aa6245, measured at d74b3d6 on linux/EPYC) — durable evidence
      current. NEW FINDING from the fresh numbers: strict-fastest-WASM is
      MACHINE-DEPENDENT — EPYC runner: 37 strict / 4 band / 17 losing
      (fft 1.33x, trace 1.86x, vm 1.90x, lz 1.20x vs c-wasm — cases that
      WIN on the local M4 reference). V8 tiering/microarch differences.
      DECIDED 2026-07-24 (user delegated): strict claim SCOPED to the
      reference machine (M4) -- bench/README states it; results.json is
      reference-only evidence (restored from 72af94b2 after the CI bot
      overwrote it and dropped the jz-w2c native lane -> bench-CI red);
      the runner now publishes results-ci.json as a visible SECONDARY
      dataset (bench.yml). Selfhost warm/fresh perf-pins adopt the same
      repo-wide timing discipline (okTiming: informational on CI, caps
      unchanged, asserted on reference hardware) -- resolves the selfhost
      CI red (warm 1.03-1.06x on EPYC vs 0.95-0.98x local, fresh 0.60x
      both). OPEN FRONTIER (banked): EPYC rows trailing c-wasm (fft 1.33x,
      trace 1.86x, vm 1.90x, lz 1.20x) -- close by general levers, they
      also pay off on M4.
* [ ] Kernel long-tail (each characterized in the archive):
  * shaped-parser: LOCALIZED (BC14 + host-side pass bisect): the throw is
    a jz-RUNTIME error code (raw 0) firing inside WATR-IN-KERNEL during
    watOptimize, and needs stripmut+globals BOTH enabled (disabling either
    rescues; all-off ok) — a jz miscompile of the stripmut→globals const-
    fold interaction executing in-kernel. NARROWED FURTHER: native watr on
    the KERNEL'S OWN pre-watr tree is fine (pure execution miscompile);
    only the shape module trips pair-only (sum/math/str/constg clean);
    the trigger global is __schema_tbl (the module's ONLY never-written
    global — stripmut immutabilizes it, globals' pricing then clones its
    read anchors and runs watr fold() on them IN-KERNEL; suspect fold's
    i64/BigInt arithmetic hitting the kernel bigint carrier gap — would
    UNIFY this with the bigint-kernel family). NEXT: extract __schema_tbl
    read anchors: i64.load/store over __schema_tbl addr math (2 sites).
    HARNESS REFUTATION (2026-07-23): a jz-compiled watr micro-kernel
    (.work/watr-harness-entry.js graph, compiled at BOTH level:2 AND the
    kernel's exact speed profile) runs pair-only on the SAME 84KB WAT
    CLEAN — the miscompile does not reproduce outside the full kernel.
    Conclusion: context-dependent (arena state/layout at 12MB bundle
    scale, or warm-instance memory pressure when watOptimize runs after
    compileAst in the same instance) — NOT input shape, NOT pass logic,
    NOT tier alone. Costliest hunt class; deprioritized behind concrete
    wins. Probes: scratchpad/{wbisect3,wpair,wnative,wglob2,wanchor,
    watr-harness.mjs,wrun}.mjs + .work/watr-harness-entry.js.
    RELATED NATIVE FINDINGS: Error.message unwired (String(e) works,
    e.message undefined even unthrown); jz runtime errors throw raw numeric
    codes (JSON.parse('nope') throws number) — the message-evaporation
    mechanism.
  * bigint family + preeval CLEARED 2026-07-24 (statements/data/preeval
    un-excluded; kernel suite 1911/1918 [only shaped-parser assert],
    battery 3075/0). Roots, all one family -- the parser CONFLATES small
    bigints with subnormal f64 literals (5e-324 exports as 1n in-kernel):
      - numLiteralNode ZERO-exemption ([, 0n] degrades to [, 0], so a
        zero literal is not PROOF of number-ness; 0n|5n / 0n-5n cleared;
        cost: literal-0 mixes accepted permissively);
      - WIDE_BIGINT probe (ctx.js; shl-mask-proof + string-parse-of-2^64
        double probe) gates rational carry OFF in-kernel -- it needs
        arbitrary precision, the wrapping i64 folded silently-wrong
        values in EVERY in-kernel compile; falls back to sequential
        bit-exact-vs-JS folds; 2 precision tests onKernel-guarded;
      - STRUCTURAL subnormal fold guards (typeof misses the carrier when
        the slot flows as plain f64): prepare u+/u- folds, pre-eval
        numLitResult (both literal readers), emitNeg (routes nonzero-
        subnormal literals down the i64 path under !WIDE_BIGINT).
    ONE curated row remains (-1n < 0n at O2+, onKernel-guarded in
    statements.js): the (i64.sub 0 1) const chain reaches WATR's generic
    fold IN-KERNEL, whose dynamically-typed compare reads the -1n carrier
    (all-ones bits) as f64 NaN -> folds false. KEY UNIFICATION: this is
    the same watr-in-kernel dynamic-compare-on-carrier class suspected in
    the shaped-parser hunt (fold i64/BigInt arithmetic) -- one cure
    (structural bigint literals through the parser, or proven-kind watr
    fold paths) closes both. Emit-time kind-pinned const folds were tried
    and REVERTED (rounds 6-7): String()/convention round-trips of negative
    bigints in-kernel broke sibling rows -- don't re-attempt that route.
  * speculate CLEARED 2026-07-23 (narrowed-param versioning-guard fix:
    len64Of box-decoded the raw i32 offset of a TYPED-narrowed receiver —
    native+kernel OOB; now uses the offset directly; kernel leg 6/0,
    KERNEL_EXCLUDE shrunk). preeval 2 (rational carry) ·
    pow-fold/fifthroot CLEARED 2026-07-24 (both un-excluded from
    KERNEL_EXCLUDE; kernel legs 7/0, kernel suite 1566/1573 [only the
    shaped-parser structural assert red], native battery 3072/0): THREE
    STACKED kernel gaps peeled inside powResolvePool via BC15 stage
    bisection on the 603KB joined WAT body (tables were fine, 6144B each):
      (1) kernel regex err on \u-escaped patterns -> resolver rewritten as
          a manual indexOf/slice scan (kept: faster, allocation-free).
          ROOT RESOLVED 2026-07-24 (rediagnosed): discriminator was NOT
          control chars but ANY \uXXXX escape in a regex LITERAL --
          subscript keeps the pattern atom raw, prepare's decodeIdent
          normalizes it via s.replace(IDESC, cb), and jz's replace
          callbacks NEVER RECEIVED CAPTURE GROUPS (only the match), so
          in-kernel (_, b, p) read undefined -> fromCodePoint(parseInt
          (undefined,16)=NaN) -> trap. FIXED at root: replace callbacks
          now get (match, p1..pn, offset, string) per ES 22.1.3.19,
          clamped to closure width (regex.js + string.js string-search
          form). Fixing THAT exposed a second pre-existing matcher bug:
          quantifier/alternation attempts never rolled back partial
          capture writes -- failed (b)? attempts leaked garbage slices.
          FIXED: per-attempt capture reset (ES RepeatMatcher clear) +
          save/restore on attempt failure in compileRepeatN, reset per
          alternation branch + lazy paths. Pins: replace-callback groups
          x5, quantifier-reset x3, \u-literal x3 (test/regex.js). All 7
          escape probe variants compile in-kernel; kernel suite
          1569/1576 (only shaped-parser assert), battery 3075/0;
      (2) startsWith(s, pos) POSITIONAL ARG SILENTLY DROPPED by jz
          (native+kernel) -> resolver slice-compares; stringSearchMethod
          now LOUD-REJECTS the position arg (module/string.js) + pin in
          test/strings.js; real position support = future item;
      (3) numeric-keyed OBJECT read with a NUMERIC VARIABLE index
          (typeOf[id] -> $pt_undefined_NaN locals) hit the documented
          kernel obj[numVar] gap (2nd confirmed hit after
          resolveOptimize) -> shared.type/lastUse/regOf are dense ARRAYS.
    ALSO NOTED: native quadratic-concat arena exhaustion at ~500KB+ built
    strings (s += in loop, 60k reps) -- model-expected (no GC) but the
    concat-buffer SRoA misses the mixed-chunk shape; future lever.
    async/generators ROOT FIXED 2026-07-25 (the biggest kernel class):
    compileClosureBody populated ctx.func.preboxed AFTER emitting the body,
    so every boxed decl re-allocated its heap cell at the decl site -- an
    EARLIER-created closure had captured the function-entry cell (null) and
    mutually-recursive const arrows (flattenList/flattenStmt in jzify's
    generator machine) called through the stale cell and silently no-opped:
    EVERY generator/async body flattened to zero states under self-host
    (hollow machines; my first indexed-for sidestep turned that into
    infinite dispatch loops -- both symptoms, one root). FIX: populateBoxedSets()
    before emitBlockBody in the closure path (mirrors top-level emitFunc
    order); pinned in test/closures.js at the trigger shape (mutual const
    arrows inside a nested closure). KEY TOOL built for this and future
    hunts: scratchpad jzify-diff.mjs -- compiles jzify standalone to a
    753kB wasm via .work/jzify-entry.mjs and DIFFS node-jzify vs
    wasm-jzify output; reproduces at optimize:false with 30s iteration
    (vs 7min kernel rebuilds); ALL probes as SIGKILL-capped child
    processes (sync-wasm infinite loops starve in-process timers).
    Kernel async+generators legs 36/1 after fix (was fully hollow).
    FULLY CLEARED 2026-07-25: async + generators UN-EXCLUDED (kernel legs
    37/0; suite 1953/1962 -- only shaped-parser + user's 2 in-flight WIP
    rows). The 'negative completion field reads null' remainder root was
    DEEPER than serialization: asI32 (the i32-narrowed param/cell boundary
    coercion, ir.js) lowered f64->i32 via BARE i32.trunc_sat_f64_s, which
    SATURATES at INT32_MAX -- ES ToInt32 must WRAP mod 2^32. extractF64Bits'
    _hx8 closure param (shift-consumed -> i32-narrowed) read 0x7fffffff for
    EVERY negative f64's hi-word -> static slots 0x7FFFFFFF00000000 (NaN
    space) -> read back null. FIX: asI32 wraps through i64 (range-proof
    keeps the single-op bare trunc -- perf-ratchet slice +48 ops justified
    + re-baselined; slices bench still leads v8 0.89x). CASCADE FIXES:
    vectorize peelNarrowConv recognizes the bare wrap form (f32->i16 SIMD
    kept); global-narrow EXCEEDS_I32_CALLS disqualifies clock results
    (Date.now() ~1.7e12 was i32-narrowed -- old saturation masked it as
    'positive', wasi init test caught the wrap). Pins: ToInt32-wrap
    closure-param pin + preboxed mutual-arrow pin (test/closures.js).
    host ABI: 5th `host` param landed across self.js entries + kernel-target
    marshal ('wasi'|'js' string, 0 = native undefined default).
  * [x] kernel-parity TODO rows (dict|2, dict|3, sum|3, arr|3) RESOLVED
    (PARITY_TODO empty since 2026-07-27; 18/18 byte-identical O0/O2/O3).
  * test:self WARM PERF REGRESSION CONFIRMED REAL (2026-07-23): sequential
    3-round verdict landed (strict cap 0.99 unchanged; fail only when ALL
    rounds exceed — kills boundary flakiness) and under it the gate fails
    consistently: 1.035/1.046/1.007 (best per-case mat4 0.98, fft 1.01,
    biquad 1.01, sort 1.02, crc32 1.00, mandelbrot 1.01) vs the 0.94-0.98
    baseline. Margin loss accumulated over today's waves (kernel source
    grew: declared-guard Set ops in hot analyze walks, MUTATE_OPS spreads,
    watr-tail — each small, sum visible). RECOVERED 2026-07-23: root was the
    named-flag conversion itself — 19 hot per-node `cfg?.flag` PROPERTY
    PROBES on the spread-built ~84-key resolved cfg (slot-cheap on V8,
    HASH-priced in-kernel; the asymmetry moved the ratio). FIX: OPTF/
    optFlagsOf (ctx.js, cycle-free) — hot flags flattened to ONE i32
    bitmask on ctx.transform.optFlags at setup; sites mask-test a fixed
    slot. Warm gate 0.966x first round (from 1.007-1.046 all-rounds);
    fresh 0.768x. Battery 3069/0.
* [ ] Audit big-ticket: canonical LoopPlan — STAGE-3 SLICE 1 LANDED
      2026-07-25: the dispatch now matches BOTH scaffolds once per block
      (bl = inner matchBlockLoop, op = matchOuterPixelLoop w/ NEW
      innerIdxs census) and the five outer-family recognizers
      (divergent-escape, per-pixel-color, outer-strip, iterated-reduce,
      conv-column) consume the shared descriptor — identical predicates
      hoisted. SLICES 2a+2b LANDED same day (446a76c3, 5d0dc5eb):
      stencil consumes the dispatch bl (identical opts); loose envelope
      matched once for blur+channel-reduce. TERMINAL STATE of the
      scaffold-sharing phase: the dispatch plan {bl, op, blLoose} is the
      single scaffold authority for 15/16 recognizers (7 inner-family on
      bl, 5 outer-family on op, 2 on blLoose, stencil on bl). JUSTIFIED
      PRIVATE: ramp-map's multiInc variant (accepts trailing increment
      RUNS the default rejects; single consumer — hoisting would compute
      a 4th match on EVERY block) and butterfly (fully custom 17-stmt FFT
      scaffold). Classification ROUTING assessed and declined: scaffold
      classes overlap (a block can match bl AND op), so cross-class order
      stays load-bearing — and with re-matching gone, the first-bails are
      O(1) null checks; the audit's re-derivation complaint is resolved.
      FUTURE (separate project): unify the per-recognizer BODY analyses
      (load/store/stride scanning) the way scaffolds were unified.
      SOLVER NOW COMPLETE (2026-07-28): session factStore + mandatory
      convergence throws + solver-owned bodyFacts invalidation seam
      (4b149108). TargetProfile LANDED (frozen JS/WASI profiles);
      CompileSession seam live (beginSession owns lifecycle) — full ctx
      isolation (62 importers) remains the long-term vision. LoopPlan
      remaining: candidate-proposal protocol + shared body-analysis
      (affine access/alias/dependence model) = audit item 8.
* [ ] V2-class perf tails: qoi (LLVM branch sched), shapes record layout
      byte-stride follow-up, sdf research-tier, ulam/raymarcher parity noise.


TYPED-INDEX KERNEL MISCOMPILE FIXED (2026-07-23): `t[p[i]]` (typed read
indexed by typed read) loaded with the INNER array's opcode in-kernel
(f64 array read as i32.load+convert → garbage) — the deferred `loadOf`
closure re-read captured `r` AFTER the nested `idx(i)` emit (the
closure-capture-after-nested-emit self-host class). FIX: eager load-IR
construction before the index emission (byte-neutral natively) in all
three unproven '.typed:[]' forms. Kernel probes green (7/28); native
357 green. Store path (elemStoreIR after emit(val)) shares the exposure —
NOT yet hardened (no observed failure; watch class).

NEW NATIVE BUG (first-order, untested shape, 2026-07-23): module-global
typed array passed AS PARAM to a storing callee TRAPS OOB NATIVELY:
`const out = new Float64Array(64); const k = (o,n) => {o[i]=i...};
k(out,n)` — $k's checked-store BOUND decodes the already-ptr-NARROWED i32
param as an f64 NaN-box (`i64.reinterpret_f64 (f64.convert_i32_s $o)`) →
garbage address. Native AND kernel identically (bytes equal). The
speculate kernel-leg red (PLAN_SRC) is THIS class (its `out` global via
param), NOT a kernel divergence. Repro: scratchpad/spec7-10.mjs. MECHANISM REFINED: the guard's LEN path re-emits the receiver
(second emit(arr) inside lenIR/typedBase) and that second emission
returns the narrowed i32 offset NUMERICALLY coerced to f64
(f64.convert_i32_s) — typedBase then takes its box-decode arm on a
plain number → garbage base. First emission (store address) is correct.
FIX: make the second emission preserve ptrKind (or reuse the first
emission's local) so typedBase takes the direct arm; grep every
typedBase(emit(arr)) / __len-on-narrowed site for the same
double-emit pattern.

AUDIT-v3 QUICK WINS LANDED THIS WAVE: resetNameUids now a REQUIRED named
import (5.7.11 locked — capability regression fails loudly); typed-ctor
16-round fixpoint (narrow.js) errs under invariants on exhaustion;
kernel-parity divergences represented as REAL test.todo entries +
tripwires (not passes mistakable for parity).

TEST262 GATE — 14 IN-SCOPE FAILURES (2026-07-23, pre-existing; the workflow
red persists after the unexpected-pass prune; local run confirms exit-fail
with 'a miscompile. Pass-count gating alone would miss this'):
  async-gen dstr dflt-ary-ptrn-elision-step-err x3 (expr/named/stmt) ·
  comma S11.14_A2.1_T2 (ReferenceError not thrown) ·
  instanceof S11.8.6_A2.1_T1 (({}) instanceof Object) ·
  yield formal-parameters-after-reassignment-strict (memory OOB!) —
    PARTIALLY FIXED: generators/async/async* now share lowerArguments
    (jzify/transform.js argsLowered at 7 sites, gated on usesArguments —
    ungated broke async+2600 test262: functionBodyBlock rewrap disturbs
    unrelated bodies). Simple nested repro passes; MINIMAL REPRO (y262k.mjs): inside
    `export let _run = () => {...}` with a fn-prop assert harness:
    `function* g(a,b,c,d){ arguments[0]=32; ...; yield a; yield b }
     var iter = g(23,45,33); var result; result = iter.next()` → OOB.
    Necessary elements: UNSPECIFIED 4th param (3 args to 4 params) AND
    var-result reassignment (chained iter.next().value passes; 2-param
    passes). ROOT FIXED 2026-07-23: usesArguments/
    renameArguments stopped at 'function' but walked THROUGH 'function*' —
    the OUTER function got the rest-param lowering and the generator's
    arguments aliased the outer empty rest array (visible in transform
    output: generator body wrote arg0 = _run's own rest param). Boundary
    now includes function*. test262 14→13; pinned in test/generators.js. ·
  switch-case/dflt-decl-onlystrict x2 (undefined) ·
  break/continue line-terminators x2 (CR between keyword and label) ·
  for-in scope-body-lex-close/open/var-none x3 — TRIAGED 2026-07-23:
    destructured `let [x, _ = fn-default]` for-in HEADS with escaping
    closures capturing the per-iteration binding; deep lexical-environment
    corner (per-iteration env + head destructuring + default-initializer
    closures). Decide: implement per-iteration for-in lex envs, or curate
    as documented divergence if jz's loop-let model is single-slot. Check
    first whether plain `for (let x of xs) push(() => x)` per-iteration
    capture works — if yes, the gap is only the head-destructuring form. ·
  function S13_A15_T4 (arguments-object semantics → undefined).
RESOLVED 2026-07-23: 3 REAL miscompiles FIXED at root (yield-arguments
ownership x1 — two stacked jzify bugs; for-in pattern heads x2); the
remaining 11 curated into EXPECTED_FAIL with precise per-row reasons
(async-gen dflt-elision siblings x3 of the already-curated class;
comma-RefErr; instanceof-ctor-value; switch-decl-strict x2;
line-terminators x2 [upstream subscript grammar edge]; var-none hoist
corner; S13 arguments-typeof reflection). GATE GREEN: 3014 pass / 0
uncurated. Workflow expected green.
