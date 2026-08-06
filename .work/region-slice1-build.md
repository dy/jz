# Region arena Slice 1 — build report (2026-08-06)

Implements `.work/region-arena-design.md` Slice 1 (fixpoint-round region) per
the corrected arithmetic at `ad5e9e1c` and `.work/region-slice1-liveness.md`'s
GO verdict. This doc records what landed, the hazard handling per site, the
measured numbers, and the honestly-scoped open items — some mandated battery
items did not complete before this session's time ran out; they're listed as
NOT YET RUN, not claimed green.

## The primitives (`module/core.js`, beside `__clear`/durable-fwd machinery)

`$__region_mark()` reads `$__heap` (the current bump-pointer top). `$__region_exit(mark, root)` Cheney-copies everything reachable from `root` that
was allocated ABOVE `mark` (this round's own churn) down to a fresh compacted
block, reusing the EXACT forwarding-header convention the durable machinery
and array/hash/set/map growth already use (`[-8:newOffset][-4:-1 sentinel]`
at the old site) for ARRAY — so a stale post-relocation ARRAY reference
anyone still holds self-heals through the SAME `__ptr_offset` forwarding
chase every other array/hash/set/map access already pays. Anything at or
below `mark` (durable, pre-round) is left untouched.

Self-overlap avoidance: the compacted copy is built at the CURRENT heap top
`T` (always disjoint from the `[mark, T)` source range — ordinary
`$__alloc`/`$__alloc_hdr*` bump allocation, same as `__sclone_rec` already
does), with every emitted pointer's offset pre-adjusted by `delta = T -
mark` (its FINAL, post-relocation address) as it's written. One closing
`memory.copy(mark, T, size)` (memmove-safe per the bulk-memory-ops spec)
then lands everything at once — no second fixup pass needed, since every
pointer already encodes where its target WILL be once the move lands.

Scope: `ARRAY` (the WAT-IR tree spine, full relocate-with-forwarding),
`STRING` (heap tokens — SSO and durable/pre-round heap strings pass through
untouched; a THIS-round heap string is copied, never forwarded at the old
site — no external consumer holds an identity-sensitive stale reference to
one, see hazard site below), `ATOM`/number (immediate, untouched), `SET`/
`MAP` (watr's own `dirty`/`snapshots` — always fully rebuilt via
`__coll_order` + reinsert, see hazard site below; never durable-shortcut).
`OBJECT`/`HASH`/`CLOSURE`/`TYPED`/`BUFFER`/`EXTERNAL` are OUT OF SCOPE
(watr's AST + round-loop bookkeeping never produce them) — traps
(`unreachable`) rather than silently mishandling.

## Hazard-prerequisite handling (per the design's 4-site inventory)

1. **Compiler-side Maps/Sets keyed on pointer identity across the boundary**
   (the design's named hazard — `dirty`/`snapshots`, keyed on func-node ARRAY
   pointers). Two sub-cases found and fixed:
   - *Container's own backing store straddling the boundary*: `snapshots` is
     created once before round 1 and PERSISTS/GROWS across rounds — a grow
     mid-round allocates its new backing table ABOVE that round's mark,
     which region_exit would otherwise silently reclaim (real memory
     corruption, not just a stale-lookup miss). Fixed by making `dirty`/
     `snapshots` themselves region ROOTS: `runRounds` bundles
     `[ast, dirty, snapshots]` into one `region_exit` call per round (patch
     below), so the SAME Cheney copy that relocates the tree also relocates
     whatever of the bookkeeping needs it.
   - *Key relocation would need a rehash, not a patch*: unlike ARRAY (whose
     slots are positional), a SET/MAP's slot position is a function of its
     key's hash (`__map_hash`/`__same_value_zero` — pointer-bits-based for
     non-string keys, NO forwarding chase). An in-place value patch after
     relocating a key would leave the entry in the wrong bucket for its new
     hash. `region_copy_rec`'s SET/MAP branch therefore never takes a
     durable short-circuit — it always rebuilds via `__coll_order` +
     `__map_set`/`__set_add` reinsertion, which computes fresh hashes for
     whatever the (possibly just-relocated) keys currently are. `dirty`/
     `snapshots` are small next to the tree, so paying this every round is
     cheap.
   - A THIRD sub-case surfaced only under a real synthetic repro (a durable
     array grown this round via `.push`, referencing new data only through
     the old, still-durable container): a durable ARRAY's own block never
     relocates, but its SLOTS can still hold non-durable references (e.g. a
     compiler-internal array that only grows-in-place, never gets rebuilt).
     The first cut returned durable arrays unchanged WITHOUT walking their
     elements — silently letting anything reachable only through them get
     reclaimed (confirmed via a minimal repro: `ast=[1,2,3]` durable,
     `.push(fn1)` after mark, `fn1`'s length read back as garbage after
     `region_exit`). Fixed: a durable ARRAY still walks its elements in
     place (recursing + writing back any element that itself needed
     relocating) — it just skips reallocating/forwarding the container
     itself, since the container's own address never changes.
2. **REF_EQ raw-i64 pointer equality** (`src/compile/emit.js`
   `emitLooseEq`/`emitStrictEq`). Confirmed compile-time-only, as the
   liveness doc's own reasoning held: REF_EQ is a RUNTIME emitter concern —
   it lowers a USER program's `==`/`===` on object-typed values into a raw
   `i64.eq` inside the OUTPUT wasm the kernel emits. The region machinery
   operates entirely on the COMPILER's OWN internal WAT-IR (`watOptimize`'s
   input/output trees) at COMPILE TIME — no user-program value ever flows
   through `__region_mark`/`__region_exit`, so this hazard site does not
   apply to Slice 1's actual boundary. (It would become live if a later
   slice extended regions to a boundary reachable from compiled USER data.)
3/4. Per the inventory: watr's own round-loop bookkeeping is hazard site
   1 above (handled); `hashNode`'s structural (not pointer) hashing and
   `equal()`'s `===`-fast-path-with-structural-fallback were already
   correctly shaped and needed no change.

## Wiring (additive, opt-in, ON unconditionally for kernel/self-host)

- `node_modules/watr/src/optimize.js` (+ the sibling source repo,
  `/Users/div/projects/watr/src/optimize.js`, kept byte-identical — the same
  operator maintains both; this is a local, UNPUBLISHED patch, additive and
  fully backward-compatible: `runRounds` calls `opts.regionMark?.()` /
  `opts.regionExit?.(mark, [ast, dirty, snapshots])` once per round, a
  no-op for every existing caller that doesn't set those opts. `snapshots`
  changed `const` → `let` (rebound on relocation). Verified byte-identical
  to the pre-patch file when the probe fields are absent (native
  `test/optimizer.js`: same 2 pre-existing failures with and without the
  patch — confirmed via a temporary revert-and-diff, not assumed). A real
  watr release is the durable path for this hook; until then it's a local
  patch that `npm install` would wipe (documented risk, not yet mitigated).
- `src/optimize/watr-tail.js`'s `watrTail` gained an optional `regionHooks`
  param — sets `watrOpts.regionMark`/`regionExit` only when supplied.
- `scripts/self.js`'s `optimizeTail` is the ONLY caller that supplies it:
  `{ mark: () => __region_mark(), exit: (m, r) => __region_exit(m, r) }`.
  This file is NEVER imported/run as native JS (only ever fed to jz's OWN
  compiler as source text, to build `dist/jz.wasm`), so these literal
  intrinsic calls are safe by construction — `index.js`'s native pipeline
  never passes `regionHooks`, so native compiles are provably unaffected
  (verified: `test/optimizer.js` native baseline unchanged with the watr
  patch applied).
- `__region_mark`/`__region_exit` added to `src/prepare/index.js`'s
  `INTRINSIC_CALLEES` (mirroring `__iter_arr`/`__keys_ro`'s "never user,
  emit-handled intrinsic" pattern) and registered as `ctx.core.emit[...]`
  handlers in `module/core.js`.

## Correctness validation

- Isolated self-tests (`.work/region-selftest.mjs`, scratch, not committed):
  durable/fresh/shared-substructure preservation, MAP/SET relocation with
  cross-referenced keys, the durable-array-with-fresh-content repro (fixed
  above), and a 6-round loop exercising `dirty`/`snapshots` growth — all
  pass at both `optimize:false` and default optimize.
- A dedicated micro-kernel (`.work/region-diff-entry.mjs`, mirroring
  `.work/watr-diff-entry.mjs`'s method) compiling `watr`'s
  `parse`/`optimize`/`print` with jz, run with `useRegions` true/false on
  the SAME isolated round-loop opts `region-slice1-liveness.md` used:
  - crc32 (38KB WAT): byte-identical region vs no-region output at
    optimize levels 0 and 3.
  - **watr-graph (7.7MB pre-watr WAT, the design's own cited 4.3GB-peak
    case)**: byte-identical region vs no-region output at level 3 (the
    self-host kernel's actual default). Final `$__heap` after the full
    optimize+print call: 3492.0MB (no-region) vs 2156.6MB (region) — a
    1335MB reduction. NOTE this is NOT the liveness doc's isolated
    round-loop-segment metric (it includes the one-shot `finish()` passes
    and `print()`'s own ~7.4MB text-building allocation, identical in both
    runs) — directionally strong confirmation, not a like-for-like
    re-measurement of the doc's 979MB/25.8% figure.
  - A genuine jz-optimizer bug was found and is NOT fixed: at micro-kernel
    build optimize levels 1 and 2 (NOT 0 or 3), the region=true path traps
    (`memory access out of bounds`) on the crc32 corpus; level 0 and level
    3 are both correct (verified byte-identical against native). The
    self-host kernel build (`scripts/selfhost-build.mjs`) uses `-O3` by
    default (`JZ_SELFHOST_OPT ?? '3'`), so this does not block the actual
    deliverable, but it's a real, unresolved jz miscompile class this work
    surfaced — worth a `.work/todo.md` line of its own (below).
- **`dist/jz.wasm` rebuilt** (`JZ_SELFHOST_OPT=3`, ~311s, 16,662,015 bytes)
  with the region machinery live. `test/kernel-parity.js`: **33/33 PASS**
  (O0/O2/O3 × 11 cases, byte-identical WAT — relocation is invisible to
  output, confirmed on the real kernel, not just the micro-kernel).

## Open items (NOT claimed complete — honest boundary)

- **`dist/jz.wasm` size**: 16.66MB, well above a stale July reference point
  (6.6MB) — but that reference predates roughly a month of unrelated
  feature work (including same-day commits from a concurrent agent this
  session did not touch: `de7cf4e6`, `4f422f4c`). NOT yet isolated whether
  today's size is a pre-existing drift, this session's region additions, or
  both — needs a controlled before/after rebuild to attribute, not done
  (each rebuild costs ~5 minutes; time ran out). Flagged, not fixed.
- **Warm checkpoint** (`test/selfhost-perf.js`, the mandatory, historically-
  the-killer gate — warm cap 1.03): NOT YET RUN.
- **`test/selfhost.js`** (21/21 correctness gate): run was in progress when
  this doc was last updated — see the session's final report for the
  outcome landed after this doc was written.
- **kernel-oracle, perf-ratchet 10/10, fuzz 2000×4, size sweep (1.039),
  fresh build ×2 byte-identical**: NOT YET RUN.
- **L1/L2 micro-kernel-build miscompile** (region=true only, crc32 corpus):
  root cause not isolated. Candidate next step: bisect which single pass
  (a mid-tier-only optimization watr/jz applies to `__region_copy_rec`'s
  shape) is responsible, using the same L0/L1/L2/L3 micro-kernel harness
  this session built (`.work/region-diff-entry.mjs`).
- **watr's own hook is an unpublished local patch**: durable path is a real
  `watr` release; until then, `npm install`/`rm -rf node_modules` wipes
  `node_modules/watr/src/optimize.js`'s patch (the sibling source repo at
  `/Users/div/projects/watr` carries the same patch as the source of
  truth, uncommitted there too).

## Kernel-oracle regression: root-cause session (2026-08-06, same day)

Protocol: restore `regionHooks` in `scripts/self.js`, rebuild, reproduce, root-
cause, fix, re-gate. Reproduced exactly as filed: kernel-oracle's
`dvnested-mechanism` row traps `memory access out of bounds` at O2/O3, clean
at O0 (matches the design's own claim that O0 skips watOptimize's round loop
entirely — `__region_dbg_rounds` stayed 0 there in every probe). The build
report's SECOND finding (L1/L2 micro-kernel-build miscompile) was NOT
re-verified this session — time went entirely to the kernel-oracle regression;
still open, still banked separately below.

**Instrumentation method**: added temporary debug globals (`__region_dbg_*`,
exported) to `__region_mark`/`__region_exit`/`__region_copy_rec`, recording a
stage marker before every risky op plus kind/offset/round-count — cheap
because a wasm trap only unwinds the call stack, so globals written right
before the fault stay readable via `instance.exports.__region_dbg_*.value`
after catching the `RuntimeError`. Stripped before the final commit (grep
`__region_dbg` returns nothing in the shipped state).

**Hint (b) — Cheney copy trapping on an unscoped kind — REFUTED.** The
observed trap message is "memory access out of bounds", never "unreachable
executed" (the WAT `(unreachable)` instruction's own distinct trap message);
`__region_dbg_kind` never once read OBJECT/HASH/CLOSURE/TYPED/BUFFER/EXTERNAL
across every probe run. The `unreachable` defensive trap for out-of-scope
kinds is not what's firing.

**Three real, confirmed, FIXED hazards** — all instances of the design's own
named risk ("Lazy healing correctness... any consumer reading POINTER BITS
without __ptr_offset... sees stale addresses" / the dirty/snapshots
"container's own backing store straddling the boundary" precedent already in
this doc above), just not caught by the original hazard-site inventory:

1. **ARRAY dyn-props sidecar silently dropped on relocation.** The build's
   original scope note ("watr's own AST/bookkeeping never attaches dynamic
   properties to its internal arrays... out of reach today") was FALSE:
   `src/optimize/index.js`'s `cseScalarLoad` (called from `optimizeFunc`,
   which the file's own docstring confirms runs "exactly once, before watr")
   reads `fn.cseLoadBases` — a `Set` stamped onto the compiled func-node ARRAY
   by `src/compile/index.js`'s `emitFunc` during emission. That func node IS
   part of `ast`, the region root. `__region_copy_rec`'s ARRAY branch
   allocates the relocated copy via `__alloc_hdr` (a zeroed dyn-props
   sidecar) and never carried the source's off-16 propsPtr word forward.
   Fixed: both the fresh-relocation and durable-walk-in-place ARRAY branches
   now locate the current props-hash pointer (inline at off-16, OR already
   filed in `$__dyn_props`) and relocate it via the machinery below, mirroring
   `module/array.js`'s `headerPropsCopyIR`/`headerPropsToGlobalIR`/
   `maybeDynMoveIR` — the SAME migration `arrGrow`/`arrShift` already perform
   for their own (non-region) relocation.
2. **`$__dyn_props`'s own backing table is a global outside the region root.**
   The fix for (1) re-keys entries INTO `$__dyn_props` via
   `__ihash_set_local`, but that table's OWN block — global state, not part of
   `[ast, dirty, snapshots]` — can itself grow (first-ever dyn-props write
   this round, or a load-factor grow from accumulated re-keys) ABOVE mark,
   exactly the "container's own backing store straddling the boundary" class
   already fixed for `dirty`/`snapshots` earlier in this doc, just a different
   global the original inventory sweep missed. Fixed: `__region_exit` now
   treats `$__dyn_props` as an implicit 4th root, relocating it (when its
   current block sits above mark) via `__coll_order` + reinsert — a relocated
   i32-offset KEY needs a genuine rehash, same reasoning as the SET/MAP
   branch.
3. **Props-hash VALUES weren't relocated, only the outer pointer.** Layers 1+2
   alone still weren't sufficient: `fn.cseLoadBases`'s VALUE is itself a `Set`
   (a real heap object). Copying the outer props-HASH pointer verbatim
   (`arrGrow`'s own `headerPropsCopyIR` precedent — safe THERE because a plain
   grow never reclaims anything) left that Set unreachable from the region
   root; region_exit's closing rewind silently reclaimed it, and the trap
   surfaced later whenever that memory got reused and read back as garbage.
   Fixed: new `__region_relocate_props` (module/core.js) walks a props-hash's
   OWN slots and relocates each VALUE via `__region_copy_rec` — no rehash
   needed (prop-name keys are SSO/interned, hash-stable across relocation), so
   ephemeral containers get a verbatim bulk copy (correctly sized to include
   `genUpsertGrow`'s trailing per-slot lane array, NOT just the key/value
   slots) followed by an in-place per-slot value fixup; durable containers get
   the fixup with no container move at all.

**Result of fixes 1-3**: kernel-oracle O2 is now FULLY GREEN (11/11, repeated
4× with zero flakes). `test/kernel-parity.js` stays 33/33 byte-identical
(region relocation, now including dyn-props, remains invisible to output).

**O3 remainder — NOT resolved, root NOT named.** kernel-oracle at O3 still
traps on `dvnested-mechanism`, reproducibly. `__region_dbg_stage` conclusively
shows `__region_exit` completes ALL its own work successfully every time
(reaches its own final instruction, `__region_dbg_rounds` stable at 2) — the
region machinery itself is not where this trap originates; it's DOWNSTREAM,
matching hint (a)'s own alternate reading ("something in the fixpoint OR
DOWNSTREAM"). Bisected via `optimize` config overrides against the ALREADY-
built kernel (no rebuild needed per config change):
  - Disabling `inlineFns`, `watrLicm`, `devirtIndirect`, `cseScalarLoad`,
    `foldStaticArrReads` individually (and several combined) — TRAP PERSISTS.
    `cseScalarLoad:false` disabling BOTH sites of `fn.cseLoadBases` (set AND
    read) still traps — the layer-1/2/3 fixes above address a real,
    CONFIRMED, now-fixed hazard, but `fn.cseLoadBases` is NOT the O3
    remainder's mechanism.
  - Disabling `fusedRewrite` (`src/optimize/index.js`) — TRAP GOES AWAY.
    `fusedRewrite`'s `walkRewrite` stamps `node._eqFast = true` on a NESTED
    `call` node (a `['call', '$__eq', a, b]`-shaped IR array, buried inside a
    function body, not the func node itself) at two sites (~4270-4324) — a
    plausible candidate matching the SAME dyn-props-sidecar hazard class, one
    level deeper (a node nested arbitrarily far inside a function body, not
    just the top-level func node) — but NOT confirmed; `fusedRewrite` does
    several OTHER things (rebox/unbox collapse, tiny-helper inlining, memarg
    offset folding, local-ref counting) and time ran out before isolating
    which one specifically. Narrowed, not named.

**Per the stop-on-fail tripwire this session's protocol set**: hooks stay
DORMANT (`scripts/self.js`'s `regionHooks` line is commented out again).
Fixes 1-3 are landed and kept (dead code while hooks are dormant — `ctx.core.
includes` never requests `__region_mark`/`__region_exit` unless `regionHooks`
is supplied, so these changes are 100% inert for every current build; verified
by rebuilding with hooks dormant and re-running `kernel-parity` 3/3 and
`kernel-oracle` 11/11 clean). The mandated-but-skipped gates (warm checkpoint,
perf-ratchet, fuzz, size sweep, fresh build ×2) were NOT run — they're gated
on kernel-oracle being fully green first, per the protocol, and it isn't.

## Files touched

- `module/core.js` — `__region_mark`/`__region_exit`/`__region_copy_rec`
  (stdlib defs + emit registrations + deps()); this session added
  `__region_relocate_props` and the dyn-props migration blocks in
  `__region_exit` ($__dyn_props implicit root) and `__region_copy_rec`'s
  ARRAY branch (both fresh-relocation and durable-walk-in-place paths).
- `module/collection.js` — exported `SET_ENTRY`/`MAP_ENTRY`/`INIT_CAP`/
  `LANE` (previously module-private) for `module/core.js` to reuse.
- `src/prepare/index.js` — `INTRINSIC_CALLEES` additions.
- `src/optimize/watr-tail.js` — `watrTail`'s optional `regionHooks` param.
- `scripts/self.js` — `optimizeTail` constructs and passes `regionHooks`
  (commented out again this session — hooks dormant; see the root-cause
  section above for why).
- `node_modules/watr/src/optimize.js` + `/Users/div/projects/watr/src/optimize.js`
  (sibling repo, source of truth) — additive `regionMark`/`regionExit`
  opts hooks in `runRounds`, `snapshots` `const`→`let`.

## `_eqFast` candidate: confirm-or-refute session (2026-08-06, later same day)

Protocol: restore `regionHooks`, rebuild, reproduce the O3 trap, then test
whether `node._eqFast` (fusedRewrite's dyn-prop stamp on a nested `call`
node — the previous session's narrowed-not-named candidate) is the O3
mechanism; if refuted, bisect fusedRewrite's other dynamic state the same
way. Nine rebuilds this session (~5min each — `JZ_SELFHOST_OPT=3 node
scripts/selfhost-build.mjs`), each adding one layer of temporary,
non-landed bisection instrumentation (new `optimize` tuning keys gating one
fusedRewrite sub-rewrite each; `__region_dbg_*` exported globals in
`__region_copy_rec`/`__region_exit`) — all stripped before the final commit
(verified: `git diff` shows only `scripts/self.js` touched at session end;
`node_modules/watr`/sibling-repo `optimize.js` re-diffed against the
pre-session baseline patch, clean).

**First surprise, before any bisection**: restoring `regionHooks` and
rebuilding reproduced the O3 trap as filed — but kernel-oracle's
`dvnested-mechanism` row ALSO trapped at **O2**, which the prior session had
left FULLY GREEN (11/11, 4 reps, zero flakes). Four unrelated "carrier
program" commits (`00c9abc4`/`7eeeea36`/`705a35d9`/`286626fa` — PTR.BIGINT
box/unbox primitives, erasure-diag promotion, W-sink def-side wiring, design
doc — all flag-gated `JZ_CARRIER_BOX`/`JZ_DEBUG_INVARIANTS` default OFF,
each individually claimed byte-identical for the default build) landed
between the prior session's O2-green verdict (`6f98578b`, 15:36) and this
session's start (17:04-17:05) — a genuinely concurrent agent, exactly the
class of interference the build report already flagged as a risk. This is
recorded as a NEW, SEPARATE finding, not assumed away.

**`_eqFast` — REFUTED.** A temporary `optimize.dbgEqFastOff` tuning key
(registered in `src/passes.js`'s `TUNING_KEYS`, threaded through
`fusedRewrite`/`walkRewrite`'s `cfg` param) disabled JUST `node._eqFast`'s
stamp and both its inline arms (the literal-vs-X inline and the cheap/cheap
inline), leaving the rest of `fusedRewrite` on. The O3 trap on
`dvnested-mechanism` reproduced IDENTICALLY with this flag set — `_eqFast`
is not necessary for the trap, cleanly refuting the candidate exactly as the
protocol asked.

**Bisecting fusedRewrite's other dynamic state** (same method — one
temporary tuning key per sub-rewrite, `compileViaKernel(src, {optimize:
{level, <flag>: true}})` against the dvnested-mechanism source directly, no
rebuild needed once a flag exists in the built kernel):

- `dbgPtrHelperOff` (the WHOLE `$__ptr_type`/`$__ptr_aux`/`$__is_nullish`/
  `$__is_null`/`$__is_truthy` call→expression inline block) — clears the O3
  trap. Does NOT clear O2.
- Narrower flags for the two sub-cases that introduce actual shared/
  duplicated node references (`$__is_nullish`'s `node[2]` used twice,
  `$__is_truthy`'s `lget`/`bits` used 3×/5×) and the one duplicated-reference
  peephole fold outside the ptr-helper block (`f64.mul`-by-2 →
  `f64.add(b,b)`) — NONE of these, individually or combined, clear O3.
  Refutes the "shared-reference" hypothesis this session initially favored
  (by analogy to the design's own "lazy healing" pointer-identity risk).
- `dbgPtrTypeOff` alone clears O3. `dbgPtrAuxOff` alone ALSO clears O3.
  `dbgIsNullOff` alone does NOT. So `$__ptr_type` and `$__ptr_aux`'s inlines
  are JOINTLY necessary — disabling either one (leaving the other active)
  already breaks the reproduction. Both are SINGLE-USE substitutions (no
  node-sharing at all), which further refutes the sharing hypothesis.
- A native `--wat` dump of the SAME source at O3 (no kernel/regions
  involved) confirms both `$__ptr_type` and `$__ptr_aux` end up with ZERO
  remaining func defs and ZERO remaining call sites in the final module —
  every call site got inlined away, so both become fully dead code. This is
  the most concrete lead for what actually happens: the two helpers'
  complete disappearance interacts with watr's own per-round `treeshake`
  pass (a `MODULE_SCOPE` pass, runs every round with regions live) in a way
  the region machinery doesn't fully account for.
- Re-added `__region_dbg_rounds`/`__region_dbg_stage`/`__region_dbg_kind`/
  `__region_dbg_off` (same method as the prior session) and re-confirmed the
  SAME finding: `__region_exit` reaches its OWN final instruction cleanly
  every time (`rounds=2, stage=4`) — the trap is downstream of a successful
  region_exit, not inside it. Consistent with, not a revision of, the prior
  session's finding.
- **One fix attempt, tried and REVERTED**: `snapshots` (watr's per-round
  content-hash Map, keyed on func-node identity, bundled into the region
  root alongside `dirty`) never drops a key once its func is removed by
  treeshake — `per()`'s rekey-on-rebuild only touches funcs still in `work`
  (this round's live set); a func treeshaken away in round N leaves a stale
  key in `snapshots` for the rest of the WHOLE `watOptimize` call, which
  region_exit's SET/MAP branch then keeps walking/relocating as if it were
  still live bookkeeping. This is a REAL, confirmed leak (worth fixing
  independently of this trap) and fit the design's own named hazard class
  exactly ("container's own backing store straddling the boundary"). Pruning
  `snapshots` of any key absent from the round's fresh `nextHash` right
  before calling `regionExit` (patched into both `node_modules/watr/src/
  optimize.js` and the sibling source repo) made things WORSE, not
  better — `kernel-parity`'s O2 `dict` row, previously passing, started
  trapping too. Reverted immediately (confirmed clean via `git diff` on both
  files). The mental model is demonstrably incomplete — this is a real
  structural finding, not a landed fix.

**O2's failure is non-deterministic across otherwise-identical rebuilds** —
the clearest single new data point this session produced. Adding 5 debug
globals to `module/core.js` (pure static-layout noise: 5 new `i32` globals,
zero behavioral change at their default values) between two rebuilds turned
an O2 baseline that had JUST trapped (3 identical prior rebuilds, same
source, same flag values, all trapping) into one that PASSED, 3/3 repeat.
This points at an address/layout-boundary-sensitive heisenbug — some
structure's capacity or a mark/offset comparison landing on the wrong side
of a boundary depending on exact allocation layout — rather than a single
clean causal chain. Consistent in SHAPE with fixes 1-3's own hazard class
(a coverage gap that only manifests when something lands at a particular
offset), just not yet caught because THIS instance depends on layout this
session never pinned down.

**Verdict**: `_eqFast` REFUTED. O3's real mechanism narrowed to "$__ptr_type
and $__ptr_aux inlining jointly necessary, downstream of a clean
region_exit, correlated with both helpers becoming fully dead code" — a
lead, not a fix. O2 is a SEPARATE, newly-discovered, non-deterministic
regression the original task framing didn't know about, introduced or
exposed sometime in the ~90 minutes before this session started. Per the
protocol's own stated fallback, hooks go back to DORMANT (`scripts/self.js`
recommented, comment rewritten with this session's full account) — the
mandated ship-gate battery (kernel-oracle ×4, kernel-parity, full battery,
perf-ratchet, fuzz 2000×4, size sweep, fresh build ×2, warm checkpoint) was
NOT run: it's gated on kernel-oracle fully green first, same as before, and
now it's LESS green than the checkpoint this session started from. Rebuilt
`dist/jz.wasm` one final time with hooks dormant and re-verified clean:
`kernel-parity` 33/33, `kernel-oracle` 11/11 (451 assertions), full
`test/index.js` battery 3354/3362 (the 2 pre-existing, unrelated failures
`705a35d9` already banked — no new failures from this session's source
churn, which fully reverts to the pre-session tree except for
`scripts/self.js`'s comment).

**Recommendation for the next session**: (1) pin down O2's layout
sensitivity FIRST — it's the more actionable lead (reproduces via a known
"add unrelated static data, trap flips" trigger, unlike O3's cleaner but
still not-yet-explained joint-necessity finding); a bisection over WHERE in
`__region_copy_rec`/`__region_exit`'s allocation sequence a boundary is
being crossed (binary-search on synthetic padding, mirroring the "add 5
globals" accident that surfaced it) is more likely to converge than further
config-flag ablation. (2) For O3, chase the treeshake interaction
concretely: instrument watr's OWN `treeshake` pass (the local patch already
touches `runRounds` next to it) to log exactly which funcs it removes each
round when compiling `dvnested-mechanism` at O3, and check whether
`$__ptr_type`/`$__ptr_aux`'s removal round correlates with `dirty`'s
membership or `snapshots`' stale-key growth (the confirmed-but-reverted
leak above) — the two threads (O3's joint-necessity finding, the snapshots
leak) may turn out to be the same root once traced through an actual
treeshake-removal event rather than inferred from config ablation alone.
