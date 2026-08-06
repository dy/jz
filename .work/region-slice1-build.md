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

## Files touched

- `module/core.js` — `__region_mark`/`__region_exit`/`__region_copy_rec`
  (stdlib defs + emit registrations + deps()).
- `module/collection.js` — exported `SET_ENTRY`/`MAP_ENTRY`/`INIT_CAP`/
  `LANE` (previously module-private) for `module/core.js` to reuse.
- `src/prepare/index.js` — `INTRINSIC_CALLEES` additions.
- `src/optimize/watr-tail.js` — `watrTail`'s optional `regionHooks` param.
- `scripts/self.js` — `optimizeTail` constructs and passes `regionHooks`.
- `node_modules/watr/src/optimize.js` + `/Users/div/projects/watr/src/optimize.js`
  (sibling repo, source of truth) — additive `regionMark`/`regionExit`
  opts hooks in `runRounds`, `snapshots` `const`→`let`.
