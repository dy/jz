/**
 * Region-arena: fixpoint-round scoped reclaim (Slice 1). `__region_mark()` /
 * `__region_exit(mark, root)` let a bounded, single-caller fixpoint (watOptimize's
 * per-round loop, wired from scripts/self.js's `regionHooks`) reclaim EACH
 * round's transient churn instead of retaining it for the whole compile: mark
 * the bump pointer at round start, Cheney-copy the round's surviving tree
 * (`root`) down to the mark at round end. See the design doc cited throughout
 * this file's own comments (`.work/evidence.md` §Region arena) for the full
 * rationale; every comment below is preserved verbatim from module/core.js.
 *
 * Pure move out of module/core.js (pipeline-minimality core split) — nested
 * inside core.js's own `if (ctx.memory.shared) {…} else {…}` (own-memory arm
 * only, immediately after durable-log.js's family in the original source).
 * Zero coupling to durable-log.js: grep-verified zero `__durable_*` references
 * in this file's own body. `lane` is self-computed the same way core.js's own
 * top-of-closure `const lane = collectionLaneBytes()` is — a pure, cheap
 * `() => ctx.transform.compactCollections ? 0 : LANE` re-derivation, not a
 * threaded parameter (matches module/math.js's precedent of importing the
 * `ctx` singleton directly rather than receiving state from the caller).
 *
 * @module core/region-arena
 */
import { ctx, declGlobal, PTR } from '../../src/ctx.js'
import { MAP_ENTRY, INIT_CAP, collectionLaneBytes } from '../collection.js'
import { regionCopyRecBody } from '../../layout-kinds.js'

export const registerRegionArena = () => {
  const lane = collectionLaneBytes()

  // === Region-arena: fixpoint-round scoped reclaim (Slice 1) ===
  //
  // `__region_mark()` / `__region_exit(mark, root)` let a bounded, single-caller
  // fixpoint (watOptimize's per-round loop — wired from scripts/self.js's
  // `regionHooks`, see that file and src/optimize/watr-tail.js) reclaim EACH
  // ROUND's transient churn instead of retaining it for the whole compile: mark
  // the bump pointer at round start, then at round end Cheney-copy the round's
  // SURVIVING tree (`root`) down to the mark, compacting away everything else the
  // round allocated (churn/live measured 574x-2495x on the design's own corpora —
  // .work/evidence.md §Region arena; .work/evidence.md §Region arena is the design).
  //
  // NO in-place forwarding-header convention (boundary-arithmetic audit,
  // .work/evidence.md §Region arena — window B; this section originally read
  // like the durable machinery's __durable_fwd_log/heal above and array/hash/
  // set/map growth's grow-in-place stub, module/array.js arrGrow/module/
  // collection.js genUpsertGrow: leave `[-8:newOffset][-4:-1 sentinel]` at the
  // OLD site for __ptr_offset to chase on a later deref. That convention is
  // sound for GROWTH — the old site stays part of the same live arena forever,
  // so the stub is reliably there whenever chased. It is NOT sound here: this
  // function's own closing `memory.copy(mark, T, size)` below overwrites every
  // byte of [mark, mark+size) with the compacted survivors before ANY consumer
  // outside this traversal could read a stub written there, and the very next
  // round starts allocating fresh churn from the new heap top, overwriting
  // whatever stub bytes landed in [mark+size, T) the instant that space is
  // reused — a write with no reachable reader, always, not merely a rare race
  // (this was the target-pass-ablation "reshuffle" mechanism: different pass
  // orderings changed how much of that dead zone got clobbered before a stray
  // reference — if one ever existed — could chase it, reshuffling WHICH corpus
  // rows happened to trap without ever closing the wall). Healing is instead
  // direct and eager: every arm below rewrites its OWN parent's slot with the
  // relocated child's value as the walk descends, and the memo (`root`'s outer
  // call returns `$out`) makes the relocated ROOT itself the healed reference —
  // no chase, no dead-on-arrival write. This covers everything reachable from
  // `root`; a holder OUTSIDE root is a root-completeness question for the
  // CALLER's registration (watr's runRounds passes exactly [ast, dirty,
  // snapshots] as root and drains every other known module-scope scratch
  // global before calling in — src/optimize.js), not something an in-place
  // stub could ever have fixed anyway (it never survived long enough to help).
  //
  // Scope (the watr WAT-IR tree + the round loop's own dirty/snapshots
  // bookkeeping — never user data, this is an internal-only pair of intrinsics,
  // never exposed to jz source): ARRAY (the tree spine), STRING (heap tokens —
  // SSO strings and durable/pre-round heap strings pass through untouched, never
  // relocated), ATOM/number (immediate, untouched), SET/MAP (watr's own
  // `dirty`/`snapshots`, keyed on func-node ARRAY pointers: Map/Set hash+compare
  // on RAW bits with no forwarding chase — __same_value_zero/__map_hash — so a
  // relocated key silently un-finds itself unless the Set/Map's OWN entries
  // relocate too; handled below exactly like __sclone_rec's SET/MAP branch,
  // rebuilt via __coll_order insertion order so dirty-filtering's performance
  // survives the boundary intact, not just "safely degrades" to always-dirty).
  // OBJECT/HASH/TYPED/BUFFER/EXTERNAL gained real arms in Slice 2
  // (layout-kinds.js's regionCopyRecBody/KIND_REGISTRY); CLOSURE gained one
  // too (the front-boundary forcing case, .work/evidence.md §Region arena)
  // via the `$__closure_env_len`/`$__closure_env_mask` side table — see
  // layout-kinds.js regionArmClosure.
  //
  // Self-overlap: the compacted copy is NOT written in place at `mark` — source
  // (the round's live data, scattered through [mark, T)) and a naive in-place
  // target would occupy the SAME linear range, and nothing proves a traversal
  // order that never lets the write cursor overtake a not-yet-read survivor.
  // Instead the copy runs at the CURRENT heap top `T` (always disjoint from
  // [mark, T) — plain, already-proven $__alloc/$__alloc_hdr* bump allocation,
  // same as __sclone_rec), with every emitted pointer's offset pre-adjusted by
  // `delta = T - mark` (its FINAL, post-relocation address) as it's written — so
  // the one closing `memory.copy(mark, T, size)` (memmove-safe per WAT's
  // bulk-memory-ops spec, so safe even on the rare corpus where live size
  // approaches churn and the ranges truly overlap) needs no second fixup pass:
  // every pointer already points where its target WILL be once the move lands.

  // __region_memo_get/__region_memo_set — the ONLY two places $memo's
  // backing bytes are ever touched, throughout every arm in layout-kinds.js
  // and __region_relocate_props/__region_relocate_cell below (mechanical
  // rename from raw __map_get/__map_set — .work/evidence.md §Region arena,
  // memo-lane fix). Pure passthrough wrappers: $memo's own content,
  // hashing, probing and growth semantics (genUpsert, module/collection.js)
  // are completely untouched — the ONLY thing these change is WHERE a grow
  // lands, by temporarily redirecting the shared $__heap bump cursor to
  // $__scratch_heap (a disjoint lane __region_exit reserves once per call,
  // below) for the duration of one get/set call, then restoring it.
  //
  // Invariant preserved: identical VALUE semantics to a plain __map_get/
  // __map_set call — same lookups, same inserts, same grows, on the same
  // logical Map — only the PHYSICAL address of the backing array differs.
  // Every consumer of $memo (every arm's own memo-hit check, every
  // durable-diamond self-map) reads that address back through the SAME
  // $memo bits via __ptr_offset's own forwarding-chase, which resolves
  // correctly regardless of which lane the current generation lives in.
  //
  // $__scratch_base == 0 means "no reservation is active this call" (either
  // __region_exit hasn't reached the memo-creating branch yet, or its own
  // reservation attempt found no safe room and left scratch disabled) —
  // passthrough to the real heap exactly like before this fix, so this
  // mechanism can only ever be as-correct-as-today in the worst case, never
  // worse.
  //
  // Why the discarded bytes are provably dead at copy time: $memo is a
  // local SSA value threaded through __region_copy_rec's own recursion —
  // never part of $out (the relocated root, this function's only return
  // value) and never written into any parent slot the walk heals (every
  // arm writes the RELOCATED CHILD's value into its parent, never $memo
  // itself). Nothing reachable after __region_exit returns can hold a
  // reference into the memo's storage — true before this fix too (that is
  // WHY $T was captured right after the memo's own tiny initial alloc: the
  // code already assumed the memo was safe to leave behind. The bug was
  // only that GROWTH escaped that boundary — see __region_exit below).
  // Giving the memo a lane that is NEVER inside [T, heap) turns "provably
  // unreachable" into "structurally excluded from the compacted span",
  // by construction rather than by the two ranges just happening to differ.
  //
  // Nested/reentrant exits: __region_mark/__region_exit pairs NEST (an
  // outer boundary's own mark can stay open on the call stack while many
  // inner mark/exit pairs run inside it — confirmed directly, the frontier
  // trace this fix is keyed to), but __region_exit itself is never
  // RE-ENTERED while a prior __region_exit call is still on the stack: each
  // call is invoked once, synchronously, by the compiler's own round-loop
  // driver (never from inside __region_copy_rec's own recursion), and runs
  // to completion before the next round's pair begins. $__scratch_base/
  // $__scratch_heap are reset to a FRESH reservation at the top of every
  // __region_exit call (below), so one call's lane is never read by a
  // later one — safe under the same strict sequential-rounds property the
  // mark/exit design has always relied on.
  ctx.core.stdlib['__region_memo_get'] = `(func $__region_memo_get (param $memo i64) (param $key i64) (result i64)
    (local $savedHeap i32) (local $result i64)
    (if (result i64) (i32.eqz (global.get $__scratch_base))
      (then (call $__map_get (local.get $memo) (local.get $key)))
      (else
        (local.set $savedHeap (global.get $__heap))
        (global.set $__heap (global.get $__scratch_heap))
        (local.set $result (call $__map_get (local.get $memo) (local.get $key)))
        (global.set $__scratch_heap (global.get $__heap))
        (global.set $__heap (local.get $savedHeap))
        (local.get $result))))`

  ctx.core.stdlib['__region_memo_set'] = `(func $__region_memo_set (param $memo i64) (param $key i64) (param $val i64) (result i64)
    (local $savedHeap i32) (local $result i64) (local $off i32) (local $growBytes i32)
    (if (result i64) (i32.eqz (global.get $__scratch_base))
      (then (call $__map_set (local.get $memo) (local.get $key) (local.get $val)))
      (else
        ;; Lane-fit guard (lane-below-survivors layout): the lane is BOUNDED
        ;; above by the survivor span, so a doubling that would not fit must
        ;; land on the normal heap instead (bypass the redirect for this ONE
        ;; call). The grown table is then retained for one round — bounded,
        ;; rare (the hint sizes the lane for the common case), and strictly
        ;; better than overrunning into survivor bytes. Growth predicate and
        ;; sizing mirror genUpsert's own (size*4 >= cap*3 -> newcap = cap*2).
        (local.set $off (call $__ptr_offset_fwd (i32.wrap_i64 (i64.and (local.get $memo) (i64.const 4294967295)))))
        (if (i32.ge_s (i32.mul (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 4))
                      (i32.mul (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const 3)))
          (then
            (local.set $growBytes (i32.add (i32.mul (i32.mul (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const 2)) (i32.const ${MAP_ENTRY + lane})) (i32.const 32)))
            (if (i32.gt_u (i32.add (global.get $__scratch_heap) (local.get $growBytes)) (global.get $__scratch_end))
              (then (return (call $__map_set (local.get $memo) (local.get $key) (local.get $val)))))))
        (local.set $savedHeap (global.get $__heap))
        (global.set $__heap (global.get $__scratch_heap))
        (local.set $result (call $__map_set (local.get $memo) (local.get $key) (local.get $val)))
        (global.set $__scratch_heap (global.get $__heap))
        (global.set $__heap (local.get $savedHeap))
        (local.get $result))))`

  ctx.core.stdlib['__region_mark'] = `(func $__region_mark (result f64)
    (f64.convert_i32_u (global.get $__heap)))`


  // Bypass the 16 MiB churn skip for explicitly bounded optimizer scans and
  // narrowly-rooted rewrites. Those batches otherwise retain thousands of
  // individually-small allocations; generic mutation rounds still use the
  // adaptive ordinary __region_exit path.
  ctx.core.stdlib['__region_exit_force'] = `(func $__region_exit_force (param $mark f64) (param $root f64) (result f64)
    (global.set $__region_force (i32.const 1))
    (call $__region_exit (local.get $mark) (local.get $root)))`

  // Function form (see __region_copy_rec's comment below for why): the
  // $__dyn_props implicit-root block needs ctx.scope.globals.has('__dyn_props')
  // read at PULL time.
  ctx.core.stdlib['__region_exit'] = () => `(func $__region_exit (param $markF f64) (param $rootF f64) (result f64)
    (local $mark i32) (local $T i32) (local $delta i32) (local $memo i64) (local $out f64) (local $size i32)
    (local $churn i32) (local $survivorMargin i32) (local $memoCap i32)
    (local $scratchBase64 i64) (local $memoReserve64 i64) (local $neededCeil64 i64)
    ${ctx.scope.globals.has('__dyn_props') ? '(local $dpBits i64) (local $dpOff i32) (local $dpCap i32) (local $dpNewOff i32) (local $dpOutPhys f64) (local $dpOrd i32) (local $dpN i32) (local $dpI i32) (local $dpSlot i32)' : ''}
    (local.set $mark (i32.trunc_f64_u (local.get $markF)))
    ;; Adaptive exit-skip (.work/evidence.md §Region arena — THE MEMORY
    ;; ENDGAME): the walk below is a Cheney-copy over EVERYTHING reachable
    ;; from \`root\`, not just this round's own new allocations —
    ;; regionArmSetMap (layout-kinds.js) has no cheap durable/off<mark
    ;; short-circuit the way ARRAY/OBJECT/HASH/String/BigInt/Typed/Buffer
    ;; all do (a relocated key's hash bucket must be recomputed, so an
    ;; in-place patch isn't sound there — see that function's own
    ;; comment): EVERY exit that reaches a pointer-keyed Map/Set rebuilds
    ;; it FRESH, and the stale prior copy (already durable, below THIS
    ;; round's mark) is never reclaimed — so each round's own exit adds
    ;; roughly one more full copy's worth of dead weight, permanently,
    ;; which is the mechanism behind the ≈292 MB/round floor climb
    ;; measured on jz×jz (frontier trace fa9fcc1a) regardless of how
    ;; little a given round actually churned.
    ;;
    ;; First cut of this fix compared churn (\`$__heap - mark\`) against
    ;; \`mark\` itself (free, zero-extra-walk proxy for root-set size) —
    ;; self-tuning in theory, but MEASURED to regress jessie/watr real-
    ;; graph peaks 2x (536.9→1073.7 MB, 1073.7→2147.5 MB) and to NOT
    ;; close the jz×jz goal gate either: a mark-relative ratio conflates
    ;; "large churn, mostly garbage" (front/early-plan/narrowSignatures —
    ;; SHOULD compact) with "large churn, mostly SURVIVORS" whenever the
    ;; contemporary mark happens to be even larger — which, on a SMALL
    ;; compile (jessie/watr), front's own high-value round easily
    ;; satisfies (mark already nontrivial at a small absolute scale),
    ;; wrongly skipping the one round most worth compacting and retaining
    ;; nearly all of its raw churn instead of its tiny survivor set
    ;; (churn/live measured 574-2495x elsewhere in this file) — the exact
    ;; 2x the real-graph measurement caught.
    ;;
    ;; Fixed threshold instead, sized directly from the frontier trace's
    ;; own measured per-round churn table (fa9fcc1a): every round worth
    ;; skipping on jz×jz (every batched analyzeFuncForEmit round, 1.68-
    ;; 7.00 MB; plan-tail rounds 1 and 5, 3.89 MB and 0.001 MB) sits under
    ;; 16 MiB; every round worth compacting for real (front/early-plan/
    ;; narrowSignatures, hundreds-to-thousands of MB; plan-tail rounds 2-4,
    ;; 93-210 MB; the scan-round, 62.29 MB) sits at 22 MB and up — a clean
    ;; gap, and unlike the mark-relative ratio, an ABSOLUTE cap bounds the
    ;; worst case a skip can ever retain to the cap itself, independent of
    ;; how large \`mark\` happens to be for a given compile — so it can't
    ;; misfire on a small graph's own high-value round the way the ratio
    ;; did.
    ;;
    ;; Result (.work/evidence.md §Region arena — THE MEMORY ENDGAME):
    ;; jessie/watr real-graph peaks hold at their pre-fix baseline exactly
    ;; (536.9 MB / 1073.7 MB, zero regression), jzify-entry HALVES
    ;; (4295.0→2147.5 MB), and jz×jz's own AFE loop survives from 6 exits
    ;; to ~51 of its ~53 needed (diagnostic skip/compact counters, since
    ;; deleted) before still tripping the same i32/2³² ceiling — a huge,
    ;; genuine reduction in the tax, not a full close. The residual gap
    ;; lives in the exits this threshold correctly judges NOT skippable
    ;; (their own churn is large, so compacting them for real is the
    ;; right call) — widening the threshold further to convert more of
    ;; THOSE into skips was tried and measured WORSE, not better (more
    ;; retained garbage costs more heap than the recopy tax it dodges,
    ;; once a round's true survivor set is a small fraction of its
    ;; churn) — so closing the remaining gap needs shrinking what a real
    ;; compaction costs (the regionArmSetMap durable short-circuit this
    ;; comment opens with, still unbuilt) or fewer total exits
    ;; (AFE_ROUND_BATCH), not a further threshold tune on this lever.
    ;; Root-identity return (\`rootF\` verbatim, \`$__heap\` left
    ;; exactly where it was) is safe unconditionally: nothing has moved,
    ;; so every address the caller already holds stays valid — this is a
    ;; pure early-return before the memo table (below) is even allocated,
    ;; so it never touches the relocation machinery those six closed
    ;; boundary-hazard mechanisms (durable/ephemeral split, off-16,
    ;; __coll_order counting, no-stub compaction, $__dyn_props root-
    ;; completeness, chain-round rebuild) all live inside.
    (if (i32.and (i32.eqz (global.get $__region_force))
          (i32.lt_u (i32.sub (global.get $__heap) (local.get $mark)) (i32.const 16777216)))
      (then (return (local.get $rootF))))
    (global.set $__region_force (i32.const 0))
    ;; Explicit reset, not reliance on the global's own 0 init value: a
    ;; PRIOR call's successful reservation must never leak into this one
    ;; if THIS call's own ceiling guard below declines to reserve — that
    ;; stale address could by now sit inside the real heap's own grown
    ;; span (call N's reservation, call N+1 skip-returns before reaching
    ;; here at all so leaves it untouched, call N+2 reaches here but its
    ;; own ceiling guard fails — without this line $__scratch_base would
    ;; still read call N's address, no longer safely disjoint from
    ;; anything).
    (global.set $__scratch_base (i32.const 0))
    ;; Memo scratch-lane reservation (.work/evidence.md §Region arena —
    ;; negative-reclaim root cause 476c88cd / memo-lane fix): reserve a
    ;; disjoint address range for the memo BEFORE creating it, so every
    ;; __region_memo_get/__region_memo_set call below (transitively, via
    ;; __region_copy_rec's own recursion) redirects there instead of
    ;; growing inside [T, heap). Only runs past the 16 MiB skip-check
    ;; above — small/skipped rounds pay nothing extra, matching this
    ;; lever's own established discipline (fa9fcc1a's absolute-cap fix).
    ;;
    ;; scratchBase must sit far enough above the CURRENT heap position
    ;; that this round's own genuine survivor growth (everything
    ;; __region_copy_rec legitimately relocates) can never reach it before
    ;; this call returns — survivorMargin bounds that by churn itself
    ;; (half of \`heap - mark\`, capped at 256 MiB): every round measured in
    ;; this campaign's own real-graph corpus put TRUE survivor growth (net
    ;; growth minus memo waste) at 0-123 MB even on jz×jz's largest
    ;; (early-plan) round — half of churn is already a wide multiple of
    ;; that, and capping it keeps a huge-churn round (narrowSignatures,
    ;; ~1.7 GB) from demanding an equally huge, pointless reservation.
    ;; scratchBase is also never placed BELOW the current memory.size()
    ;; ceiling — starting fresh, unused address space needs no margin at
    ;; all, it simply doesn't exist yet until __memgrow commits it below.
    (local.set $churn (i32.sub (global.get $__heap) (local.get $mark)))
    ;; i64 throughout: the final ceiling reaches into the low billions near
    ;; the wasm32 4 GiB ceiling, well past what i32 arithmetic can hold
    ;; without wrapping (the exact overflow class the frontier trace's own
    ;; trap analysis, fa9fcc1a, found one instruction away from this same
    ;; ceiling elsewhere in this file).
    ;;
    ;; scratchBase = heap + survivorMargin DIRECTLY — NOT max'd against
    ;; memory.size(). A first cut of this fix used max(memSize, wantBase),
    ;; reasoning "never place scratch below the current commit ceiling" —
    ;; wrong, and measured wrong (region-live real-graph peaks REGRESSED
    ;; 2-4x on jessie/watr/jzify-entry, the exact class of mistake THE
    ;; MEMORY ENDGAME's own mark-relative-ratio attempt made): whenever
    ;; \$__memgrow's own prior geometric over-provisioning already left
    ;; slack between \$__heap and memory.size() (the common case — that
    ;; slack is the WHOLE POINT of its "request >=2x" growth policy),
    ;; forcing scratchBase up to memSize anyway made \`neededCeil\` exceed
    ;; the CURRENT ceiling by construction (memSize + any positive
    ;; memoReserve is always > memSize), so __memgrow's own "need >
    ;; memory.size() -> grow by >=2x" policy fired on EVERY real-compaction
    ;; round regardless of how tiny memoReserve actually was — doubling the
    ;; entire wasm memory just to make room for a few hundred scratch
    ;; bytes. Placing scratch directly at heap+survivorMargin instead lets
    ;; __memgrow's own existing "need > memory.size()" check do its actual
    ;; job: a no-op whenever existing slack already covers it (the common
    ;; case for small compiles, matching this lever's own established
    ;; "small compiles rarely even reach here" discipline), a genuine
    ;; (correctly-sized) grow only when it doesn't.
    ;; LANE-BELOW-SURVIVORS (2026-08-19, .work/evidence.md §survivorMargin
    ;; unsoundness): the lane sits AT the current heap cursor and survivor
    ;; copies start ABOVE its reserved end — collision is impossible by
    ;; construction. The previous layout (lane at heap+survivorMargin with
    ;; margin = min(churn/2, 256 MiB), survivors below) was an unsound
    ;; heuristic: any round whose survivor ratio exceeds 1/2 of churn
    ;; overruns the lane (jessie round 3 already overlapped it by ~6 MB and
    ;; survived only on unused reservation padding; emission-phase rounds,
    ;; whose survivor ratio approaches 1, corrupt the memo outright — the
    ;; phantom-multi-GB-allocation regression, ledger §Emission rounds v1).
    ;; Bonus: neededCeil no longer carries a churn-proportional margin, so
    ;; committed memory tracks true peak + memo reserve.
    ;; Disarm the lane BEFORE attempting this round's reservation: if the
    ;; ceiling guard below declines, a stale $__scratch_base from a PRIOR
    ;; round would redirect this round's memo into what is now live
    ;; survivor territory (the prior lane's address range was recycled by
    ;; the closing memory.copy/rewind) — silent corruption near the 4 GiB
    ;; ceiling. Zero means "passthrough to the real heap this call".
    (global.set $__scratch_base (i32.const 0))
    (global.set $__scratch_heap (i32.const 0))
    (global.set $__scratch_end (i32.const 0))
    (local.set $scratchBase64 (i64.and (i64.add (i64.extend_i32_u (global.get $__heap)) (i64.const 7)) (i64.const -8)))
    ;; memoReserve sized from the PRIOR call's own final cap (\`$__memo_cap_hint\`,
    ;; updated at the end of this function below), 2x headroom for this
    ;; round's own growth beyond that hint — under-sizing is never a
    ;; correctness risk (see __region_memo_get/__region_memo_set: a memo
    ;; that outgrows this reservation simply keeps growing via __memgrow's
    ;; own normal extension, still safely inside the scratch lane, just
    ;; with one extra real grow call), only a missed-optimization one.
    (local.set $memoReserve64 (i64.mul (i64.extend_i32_u (i32.mul (global.get $__memo_cap_hint) (i32.const 2))) (i64.const ${MAP_ENTRY + lane})))
    ;; Reservation floor (256 KiB): the hint is 0 on the first round of a
    ;; fresh instance — a zero-size lane would bypass the redirect entirely
    ;; and put round 0's whole memo back in the survivor span.
    (if (i64.lt_u (local.get $memoReserve64) (i64.const 262144))
      (then (local.set $memoReserve64 (i64.const 262144))))
    (local.set $neededCeil64 (i64.add (local.get $scratchBase64) (local.get $memoReserve64)))
    ;; Ceiling guard: if reserving would need memory at or past the true
    ;; wasm32 4 GiB limit, don't even try — __memgrow_exact itself traps
    ;; (unreachable) rather than failing gracefully past that point, and a
    ;; compile already this close to the ceiling gets zero benefit from a
    ;; scratch lane anyway. $__scratch_base stays 0 (its own init value) —
    ;; __region_memo_get/__region_memo_set fall straight through to the
    ;; unmodified, pre-fix behavior for this ONE call, never worse than
    ;; before this fix landed.
    ;; __memgrow_exact, not __memgrow (.work/evidence.md §Footprint levers —
    ;; geometric-floor tier boundary): neededCeil64 IS the caller's own
    ;; final, precisely-computed ceiling — growing to it exactly (page-
    ;; rounded) instead of $__memgrow's amortization-for-unplanned-callers
    ;; floor is what closes the committed-vs-need gap (see __memgrow_exact's
    ;; own header comment above for why this call site is the right one).
    (if (i64.lt_u (local.get $neededCeil64) (i64.const 4294967296))
      (then
        (call $__memgrow_exact (i32.wrap_i64 (local.get $neededCeil64)))
        (global.set $__scratch_base (i32.wrap_i64 (local.get $scratchBase64)))
        (global.set $__scratch_heap (i32.wrap_i64 (local.get $scratchBase64)))
        (global.set $__scratch_end (i32.wrap_i64 (local.get $neededCeil64)))
        ;; survivors (and the memo's own tiny cap-8 header, allocated just
        ;; below at the then-current cursor) start ABOVE the lane
        (global.set $__heap (i32.wrap_i64 (local.get $neededCeil64)))))
    ;; fresh memo Map (identity: old bits -> new/final bits), same bootstrap __sclone uses
    (local.set $memo (i64.reinterpret_f64 (call $__mkptr (i32.const ${PTR.MAP}) (i32.const 0)
      (call $__alloc_hdr_n (i32.const 0) (i32.const ${INIT_CAP}) (i32.const ${MAP_ENTRY + lane})))))
    (local.set $T (global.get $__heap))
    (local.set $delta (i32.sub (local.get $T) (local.get $mark)))
    (local.set $out (call $__region_copy_rec (local.get $rootF) (local.get $memo) (local.get $mark) (local.get $delta)))
    ;; $__dyn_props implicit region root (audit finding, kernel-oracle
    ;; dvnested-mechanism O2/O3 regression, layer 2): the ARRAY dyn-props
    ;; migration above (__region_copy_rec's ARRAY branch) re-keys entries INTO
    ;; $__dyn_props's own backing HASH table via __ihash_set_local — but that
    ;; table itself is a GLOBAL, not part of [ast, dirty, snapshots] (the
    ;; caller-supplied root), so a mid-round GROW of $__dyn_props's OWN block
    ;; (first-ever dyn-props write this round, or a load-factor grow from
    ;; accumulated re-keys) allocates ABOVE mark and would otherwise be
    ;; silently reclaimed by this function's OWN closing rewind below — the
    ;; exact "container's own backing store straddling the boundary" hazard
    ;; already fixed for dirty/snapshots (research.md §Region arena), just a
    ;; DIFFERENT global that inventory sweep missed. Relocate it here,
    ;; unconditionally: __coll_order + reinsert when the CONTAINER itself is
    ;; ephemeral (a relocated i32-offset KEY needs a rehash — __map_hash-
    ;; family hashing is bits-based, same reasoning as the SET/MAP branch
    ;; above; the offset keys here are always immediate/plain numbers though,
    ;; so a verbatim key copy is fine either way).
    ;;
    ;; VALUE relocation (root-completeness fix, .work/evidence.md §Region
    ;; arena — "durable-ARRAY off-16 heisenbug", the [1n]/O1 minimal trigger):
    ;; every entry's VALUE is a per-receiver props HASH — __dyn_set's global-
    ;; table fallback (module/collection.js) mints one FRESH each time a
    ;; DURABLE receiver (off < __heap_reset) gets a first runtime dyn-prop
    ;; write, keyed by the receiver's own stable offset. That receiver is
    ;; very often NOT itself part of the region root (a compiler-internal
    ;; registry — module-scope {}/Map state the self-compiled kernel populates
    ;; while compiling, never threaded through [ast, ctx.funcs.list,
    ;; ctx.module, ctx.schema, ctx.closure]) — so __region_copy_rec's own
    ;; per-kind arms (regionArmArray/regionArmObject's durableDynProps/
    ;; ephemeralDynProps blocks, layout-kinds.js) never visit it and never
    ;; relocate ITS value. The value used to be copied bit-for-bit here
    ;; regardless (old comment: "never relocated by this mechanism... same
    ;; as arrGrow's headerPropsCopyIR" — true for a plain GROW, which never
    ;; reclaims anything, but NOT sound here: this function's own closing
    ;; memory.copy(mark, T, size) below reclaims exactly the range an
    ;; unvisited ephemeral value lives in). Fixed by routing EVERY entry's
    ;; value through __region_relocate_props unconditionally — safe
    ;; (idempotent) regardless of whether the root walk above already
    ;; touched this exact receiver: __region_relocate_props now self-maps
    ;; its own output in $memo (see that function's own comment), so a
    ;; value durableDynProps/ephemeralDynProps already relocated this round
    ;; is a cheap memo hit here, not a double-relocation, and a value
    ;; whose receiver is durable-but-unreached — the actual gap — gets its
    ;; first and only relocation right here.
    ${ctx.scope.globals.has('__dyn_props') ? `
    (local.set $dpBits (i64.reinterpret_f64 (global.get $__dyn_props)))
    (if (f64.ne (global.get $__dyn_props) (f64.const 0))
      (then
        (local.set $dpOff (call $__ptr_offset (local.get $dpBits)))
        (local.set $dpCap (i32.load (i32.sub (local.get $dpOff) (i32.const 4))))
        (if (i32.ge_u (local.get $dpOff) (local.get $mark))
          (then
            ;; container ephemeral (created/grown this round) — rebuild fresh,
            ;; relocating each value as it's reinserted.
            (local.set $dpNewOff (call $__alloc_hdr_n (i32.const 0) (local.get $dpCap) (i32.add (i32.const ${MAP_ENTRY}) (i32.const ${lane}))))
            (local.set $dpOutPhys (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0) (local.get $dpNewOff)))
            (local.set $dpOrd (call $__coll_order (local.get $dpOff) (local.get $dpCap) (i32.const ${MAP_ENTRY})))
            (local.set $dpN (global.get $__coll_order_n))
            (block $ded (loop $del
              (br_if $ded (i32.ge_s (local.get $dpI) (local.get $dpN)))
              (local.set $dpSlot (i32.load (i32.add (local.get $dpOrd) (i32.shl (local.get $dpI) (i32.const 2)))))
              (drop (call $__ihash_set_local (i64.reinterpret_f64 (local.get $dpOutPhys))
                (i64.reinterpret_f64 (f64.load (i32.add (local.get $dpSlot) (i32.const 8))))
                (i64.reinterpret_f64 (call $__region_relocate_props (f64.load (i32.add (local.get $dpSlot) (i32.const 16))) (local.get $memo) (local.get $mark) (local.get $delta)))))
              (local.set $dpI (i32.add (local.get $dpI) (i32.const 1)))
              (br $del)))
            ;; NO old-site forwarding stub (boundary-arithmetic audit, window B —
            ;; see regionArmArray's comment, layout-kinds.js, for the full
            ;; mechanism). $__dyn_props is a GLOBAL, not a value threaded through
            ;; a caller — the ONLY live reference to this table is the global
            ;; itself, healed directly on the next line; nothing else could ever
            ;; hold the old address to chase, stub or no stub. $dpOutPhys is only
            ;; valid to DEREFERENCE right now (T-relative staging), never to keep.
            (global.set $__dyn_props (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0) (i32.sub (local.get $dpNewOff) (local.get $delta)))))
          (else
            ;; container durable (stable address, never moves) — walk every
            ;; occupied slot in place, relocating (only) its value.
            (local.set $dpI (i32.const 0))
            (block $dedD (loop $delD
              (br_if $dedD (i32.ge_s (local.get $dpI) (local.get $dpCap)))
              (local.set $dpSlot (i32.add (local.get $dpOff) (i32.mul (local.get $dpI) (i32.const ${MAP_ENTRY}))))
              (if (i64.ne (i64.load (local.get $dpSlot)) (i64.const 0))
                (then
                  (f64.store (i32.add (local.get $dpSlot) (i32.const 16))
                    (call $__region_relocate_props (f64.load (i32.add (local.get $dpSlot) (i32.const 16))) (local.get $memo) (local.get $mark) (local.get $delta)))))
              (local.set $dpI (i32.add (local.get $dpI) (i32.const 1)))
              (br $delD)))))))
    ` : ''}
    ;; Carry this call's own final memo cap forward as the sizing hint for
    ;; the NEXT __region_exit call's own reservation (memo-lane fix, see
    ;; above) — the same header-cap read __ptr_offset's own forwarding-
    ;; chase already proves correct (this reads the CURRENT, live
    ;; generation regardless of how many times $memo grew, exactly the
    ;; way every other consumer of a NaN-boxed pointer already resolves
    ;; through the SAME chase). Deactivate the scratch lane for the next
    ;; call to start clean (belt-and-suspenders alongside the explicit
    ;; reset at this function's own top, above).
    (local.set $memoCap (i32.load (i32.sub (call $__ptr_offset (local.get $memo)) (i32.const 4))))
    (global.set $__memo_cap_hint (local.get $memoCap))
    (global.set $__scratch_base (i32.const 0))
    (local.set $size (i32.sub (global.get $__heap) (local.get $T)))
    (memory.copy (local.get $mark) (local.get $T) (local.get $size))
    (global.set $__heap (i32.add (local.get $mark) (local.get $size)))
    (local.get $out))`

  // Relocate a per-array/per-object dyn-props HASH's OWN CONTENTS across a
  // region boundary (audit finding, kernel-oracle dvnested-mechanism O2/O3
  // regression, layer 3 — the deepest one): the ARRAY dyn-props migration
  // in __region_copy_rec below re-keys the OUTER props-hash pointer (into
  // off-16 or $__dyn_props) but a bare pointer copy leaves the hash's OWN
  // VALUES unrelocated — e.g. `fn.cseLoadBases = new Set(...)` (src/compile/
  // index.js emitFunc) makes the props hash's ONE entry's VALUE an ephemeral
  // SET; copying the outer HASH pointer verbatim (arrGrow's headerPropsCopyIR
  // precedent — safe THERE because a plain grow never reclaims anything) still
  // leaves that Set unreachable from the region root, so region_exit's
  // closing rewind silently reclaims it — the trap manifests later, whenever
  // that specific memory gets reused and read back as garbage.
  // KEYS in this table are always prop-name STRINGS (JS object keys are
  // always strings — a genuine language invariant, not an SSO-only
  // assumption): every key is content-hashed, so its hash bucket position
  // is immutable across relocation regardless of whether the string is
  // SSO-inline or a real heap allocation — no rehash/reinsert needed, just
  // a verbatim bulk copy of the bucket structure (unlike $__dyn_props's OWN
  // table below, whose keys are OFFSETS that genuinely change value and do
  // need __coll_order + reinsert). BUT bucket-position stability is a
  // separate question from the KEY FIELD'S OWN STORED BITS staying valid:
  // a non-SSO key is a STRING pointer, and relocation must still fix up
  // THAT pointer to the string's new address — exactly the same "value
  // needs __region_copy_rec, container structure doesn't need rehash"
  // split regionArmSetMap (layout-kinds.js) already applies to VALUES,
  // just for the KEY side this time. Front-boundary front-boundary audit
  // (.work/evidence.md §Region arena, "second still-unfound mechanism"):
  // this function's original write relocated the VALUE at slot+16 (both
  // branches below) but left the KEY at slot+8 as a verbatim bit-copy —
  // correct ONLY for the compiler-internal dyn-props sidecar's own keys
  // (always short single-word identifiers that happen to fit inline SSO in
  // every real instance seen), silently WRONG for any general PTR.HASH
  // value regionArmHash exposes this function to (a plain user/self-compiled-
  // compiler `{}` used as a dynamic dict, e.g. module/prepare's per-function
  // `defaults` map keyed by parameter names) whose keys can exceed SSO
  // width: the stale, unrelocated key pointer keeps pointing at the OLD,
  // now-reclaimed address — reads fine immediately after exit (bytes not
  // yet overwritten) and silently corrupts once a later allocation reuses
  // that space (jessie/watr/jzify-entry's post-funcIdx-skew front-boundary
  // failures, `src/compile/plan/scope.js` flattenFuncNamespaces's
  // `Object.keys(fn.defaults)` reading garbage). Fixed below: relocate the
  // key field too, no rehash needed. Slot stride is bare MAP_ENTRY (matching
  // __coll_order/genUpsertGrow's OWN per-slot indexing — module/collection.js
  // genUpsertGrow's $entrySize, not the allocation stride: normal outputs
  // append an i32-per-slot lane AFTER all cap slots, while the compact
  // self-compile profile omits it. The bulk copy below uses the resolved stride.
  // Heap-kind registry Slice 2 (.work/evidence.md §Heap-kind registry): memo
  // hardening added. Originally safe without one (each ARRAY/OBJECT dyn-props
  // sidecar is a freshly-minted, never-shared HASH — one container per
  // owner, so no call site could ever revisit the SAME $propsF bits within
  // one traversal). regionArmHash (layout-kinds.js) now also reaches this
  // function directly for a BARE PTR.HASH region-root value, which — unlike
  // a sidecar — CAN be diamond-referenced (aliasing: `let b = a` copies the
  // same HASH bits into a second reachable slot) or even self-referential
  // (a dict holding itself). Without a memo, a revisit would either
  // re-copy (breaking `===` identity across the two references) or, worse,
  // infinitely recurse on a cycle. Checked/set exactly like every other
  // __region_copy_rec arm: memo hit short-circuits; the durable branch
  // memos itself (address never changes); the ephemeral branch memos
  // BEFORE the value-relocation loop (cycles terminate on revisit).
  ctx.core.stdlib['__region_relocate_props'] = `(func $__region_relocate_props (param $propsF f64) (param $memo i64) (param $mark i32) (param $delta i32) (result f64)
    (local $off i32) (local $cap i32) (local $n i32) (local $newOff i32) (local $i i32) (local $slot i32)
    (local $bits i64) (local $hit i64) (local $out f64)
    (if (f64.eq (local.get $propsF) (f64.const 0)) (then (return (local.get $propsF))))
    (local.set $bits (i64.reinterpret_f64 (local.get $propsF)))
    ;; Ordering audit (.work/evidence.md §Region arena, __region_copy_rec ORDERING
    ;; AUDIT): memo hit-check BEFORE any work, matching every other kind's arm —
    ;; this was previously missing on THIS function's durable path (see below).
    ;; A bare PTR.HASH region-root CAN be diamond-shared (unlike an ARRAY/OBJECT
    ;; dyn-props sidecar, always 1:1 per-owner); an ARRAY/OBJECT/HASH dyn-props
    ;; sidecar reached from a durable container this function ITSELF also walks
    ;; recursively (nested dicts) needs the same short-circuit.
    (local.set $hit (call $__region_memo_get (local.get $memo) (local.get $bits)))
    (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))
    (local.set $off (call $__ptr_offset (local.get $bits)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $n (i32.load (i32.sub (local.get $off) (i32.const 8))))
    (if (i32.lt_u (local.get $off) (local.get $mark))
      (then
        ;; durable container (created a prior compile / never grown this round):
        ;; values updated in place, container address unchanged — mirrors
        ;; __region_copy_rec's ARRAY/OBJECT branches' own durable-walk-in-place
        ;; case, INCLUDING their "memo itself BEFORE walking children" step —
        ;; the bug this audit found: without it, a SECOND visit to the SAME
        ;; durable container (diamond-shared) re-walks every slot and re-runs
        ;; __region_copy_rec on each VALUE — but the first visit already
        ;; OVERWROTE ephemeral values in place with their FINAL (delta-adjusted,
        ;; not-yet-physically-valid — the closing memory.copy hasn't landed)
        ;; address. Re-presenting that final bit pattern as if it were fresh
        ;; input bits: __ptr_offset's forwarding-chase (ARRAY/HASH/SET/MAP are
        ;; all FORWARDING_MASK members) reads whatever unrelated data currently
        ;; occupies that not-yet-written final address, the child-level $memo
        ;; (keyed on ORIGINAL bits) doesn't recognize the final bits as the same
        ;; object, and the value gets silently re-derived from garbage — a
        ;; corrupted (observed: silently truncated to length 0; kernel-scale
        ;; heaps with real leftover garbage there can misread a huge/negative
        ;; length instead, matching the wall's "memory access out of bounds"
        ;; signature) copy, with NO trap in the common case, confirmed via a
        ;; native (non-kernel) probe: a durable Object.fromEntries(...) HASH
        ;; reached twice from one ephemeral array ([d, d]), with one ephemeral
        ;; array-valued property assigned after __region_mark() — control
        ;; (single reference, or no ephemeral child) reads back correct;
        ;; two-or-more references to the SAME durable dict corrupts the
        ;; ephemeral child deterministically at every opt level (0-3).
        (drop (call $__region_memo_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $propsF))))
        (block $pd (loop $pl
          (br_if $pd (i32.ge_s (local.get $i) (local.get $cap)))
          (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const ${MAP_ENTRY}))))
          (if (i64.ne (i64.load (local.get $slot)) (i64.const 0))
            (then
              ;; KEY at +8, fixed up in place — no rehash (see this function's
              ;; own doc: content-hashed bucket position is stable regardless).
              (f64.store (i32.add (local.get $slot) (i32.const 8))
                (call $__region_copy_rec (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $memo) (local.get $mark) (local.get $delta)))
              (f64.store (i32.add (local.get $slot) (i32.const 16))
                (call $__region_copy_rec (f64.load (i32.add (local.get $slot) (i32.const 16))) (local.get $memo) (local.get $mark) (local.get $delta)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $pl)))
        (return (local.get $propsF))))
    ;; ephemeral — relocate the container: fresh same-cap block (verbatim bulk
    ;; copy preserves bucket positions since keys' hashes are stable), then
    ;; relocate each occupied slot's VALUE in the NEW location.
    (local.set $newOff (call $__alloc_hdr_n (local.get $n) (local.get $cap) (i32.add (i32.const ${MAP_ENTRY}) (i32.const ${lane}))))
    (memory.copy (local.get $newOff) (local.get $off) (i32.mul (local.get $cap) (i32.add (i32.const ${MAP_ENTRY}) (i32.const ${lane}))))
    (local.set $out (call $__mkptr (i32.const ${PTR.HASH}) (i32.const 0) (i32.sub (local.get $newOff) (local.get $delta))))
    (drop (call $__region_memo_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
    ;; Idempotency self-map (fixes a real double-relocation hazard,
    ;; .work/evidence.md §Region arena — the [1n]/O1 durable-ARRAY off-16 heisenbug's
    ;; root cause): memo only ever mapped ORIGINAL bits -> final bits, so a
    ;; SECOND caller that re-derives $out (not $propsF) and calls this function
    ;; AGAIN on it — e.g. a durable receiver's off-16/$__dyn_props slot that a
    ;; DIFFERENT relocation pass already wrote the final (T-relative, not yet
    ;; physically landed) address into — got a memo MISS, decoded $out as if
    ;; it were a live pointer, and read whatever un-landed bytes happen to sit
    ;; at that not-yet-valid address as its cap/n (garbage, eventually tripping
    ;; __alloc's wraparound guard downstream). Self-mapping here makes calling
    ;; this function on EITHER the original bits OR its own prior output a safe
    ;; memo hit, regardless of caller or ordering — the general fix, not a
    ;; caller-side workaround.
    (drop (call $__region_memo_set (local.get $memo) (i64.reinterpret_f64 (local.get $out)) (i64.reinterpret_f64 (local.get $out))))
    (local.set $i (i32.const 0))
    (block $qd (loop $ql
      (br_if $qd (i32.ge_s (local.get $i) (local.get $cap)))
      (local.set $slot (i32.add (local.get $newOff) (i32.mul (local.get $i) (i32.const ${MAP_ENTRY}))))
      (if (i64.ne (i64.load (local.get $slot)) (i64.const 0))
        (then
          ;; KEY at +8 — same fixup as the durable branch above, no rehash.
          (f64.store (i32.add (local.get $slot) (i32.const 8))
            (call $__region_copy_rec (f64.load (i32.add (local.get $slot) (i32.const 8))) (local.get $memo) (local.get $mark) (local.get $delta)))
          (f64.store (i32.add (local.get $slot) (i32.const 16))
            (call $__region_copy_rec (f64.load (i32.add (local.get $slot) (i32.const 16))) (local.get $memo) (local.get $mark) (local.get $delta)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $ql)))
    ;; NO old-site forwarding stub — boundary-arithmetic audit, window B (see
    ;; regionArmArray's comment, layout-kinds.js, for the full mechanism).
    (local.get $out))`

  // Relocate a boxed-capture's shared payload cell (module/function.js's
  // `ctx.func.boxed` mechanism — an 8-byte `__alloc(8)` block holding ONE
  // f64 value, mutated in place so every closure that captured the SAME
  // source variable observes the SAME writes). Region arena's CLOSURE arm
  // (layout-kinds.js regionArmClosure) calls this per cell-mode env slot
  // INSTEAD OF __region_copy_rec directly: the slot holds the cell's RAW
  // i32 ADDRESS, not a NaN-boxed f64, so it can't go through that
  // function's own f64 tag dispatch.
  //
  // Memoized like every other arm — but a cell has no NaN-boxed identity
  // to key $memo on (it's a bare i32, never wrapped in a PTR.* tag), so
  // this synthesizes one: `f64.convert_i32_s(cellOff)` is always a plain
  // FINITE float (never a NaN-boxed bit pattern — every real heap pointer
  // this traversal ever memoizes carries the NaN prefix, layout.js), so it
  // can never collide with a real pointer's own memo entry, and reusing
  // $memo (already threaded through, already scoped to exactly one
  // __region_exit call) needs no new global state — the same trick
  // regionArmArray's own dyn-props migration already uses to key
  // $__dyn_props by a raw i32 offset (`f64.convert_i32_s`, that function's
  // own comment). This dedup is load-bearing, not an optimization: a cell
  // shared by two closures (aliasing two mutable captures of the same
  // source variable — the entire point of the boxed-cell mechanism) MUST
  // relocate to the SAME new address from both env slots, or the two
  // closures silently stop seeing each other's writes post-relocation.
  //
  // Durable branch carries the SAME memo-BEFORE-mutate ordering the TYPED
  // view-rebase audit fix required (.work/evidence.md §Region arena,
  // ordering audit): without it, a diamond-shared durable cell revisited a
  // second time in the same traversal would re-read its OWN already-
  // relocated (delta-adjusted, not-yet-physically-valid) payload as if it
  // were fresh input — the identical corruption class that fix closed for
  // __region_relocate_props/TYPED, closed here the same way (memo set
  // before the in-place mutation, not after).
  ctx.core.stdlib['__region_relocate_cell'] = `(func $__region_relocate_cell (param $cellOff i32) (param $memo i64) (param $mark i32) (param $delta i32) (result i32)
    (local $key f64) (local $hit i64) (local $newOff i32) (local $logOff i32)
    (local.set $key (f64.convert_i32_s (local.get $cellOff)))
    (local.set $hit (call $__region_memo_get (local.get $memo) (i64.reinterpret_f64 (local.get $key))))
    (if (i32.eqz (call $__is_nullish (local.get $hit)))
      (then (return (i32.trunc_f64_s (f64.reinterpret_i64 (local.get $hit))))))
    (if (i32.lt_u (local.get $cellOff) (local.get $mark))
      (then
        (drop (call $__region_memo_set (local.get $memo) (i64.reinterpret_f64 (local.get $key)) (i64.reinterpret_f64 (local.get $key))))
        (f64.store (local.get $cellOff) (call $__region_copy_rec (f64.load (local.get $cellOff)) (local.get $memo) (local.get $mark) (local.get $delta)))
        (return (local.get $cellOff))))
    ;; Ephemeral — $newOff is a PHYSICAL staging address (current heap top,
    ;; ABOVE mark); the ONLY closing fixup pass is __region_exit's single
    ;; bulk memory.copy(mark, T, size), which moves bytes verbatim and
    ;; never revisits pointer VALUES already written into the staged block.
    ;; Every other arm (see __region_relocate_props's own $out just above,
    ;; and __mkptr call sites throughout __region_copy_rec) therefore
    ;; pre-adjusts by -delta BEFORE writing a relocated address anywhere a
    ;; slot might read it back — this cell arm was the one place that
    ;; memoized/returned the raw physical $newOff instead, so any caller
    ;; that stores the result into an env slot (regionArmClosure,
    ;; layout-kinds.js — both its durable and ephemeral branches) persisted
    ;; a not-yet-final address, valid to dereference only AFTER this
    ;; round's closing copy — a real, confirmed-by-comparison-to-every-
    ;; sibling-arm's-own-convention bug, fixed here (.work/evidence.md
    ;; §Region arena, __region_relocate_cell delta-adjustment entry).
    ;; NOT the sole cause of the front-boundary's own garbage-cellOff wall:
    ;; a debug-global trace (same entry) caught the SAME symptom (a
    ;; ~1.2GB cellOff against 512MB memory) on a closure whose env block
    ;; was being relocated for the FIRST time this round (never touched
    ;; this fix's own write path yet) — a second, still-open mechanism,
    ;; diagnosed but not fixed. $logOff (= $newOff - $delta) is the FINAL
    ;; address, matching every other kind's own convention exactly;
    ;; $newOff itself stays the write target since the payload store below
    ;; runs THIS round, before the bulk copy lands.
    (local.set $newOff (call $__alloc (i32.const 8)))
    (local.set $logOff (i32.sub (local.get $newOff) (local.get $delta)))
    (drop (call $__region_memo_set (local.get $memo) (i64.reinterpret_f64 (local.get $key)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $logOff)))))
    (f64.store (local.get $newOff) (call $__region_copy_rec (f64.load (local.get $cellOff)) (local.get $memo) (local.get $mark) (local.get $delta)))
    (local.get $logOff))`

  // Function form (not a plain template string): the ARRAY/OBJECT dyn-props
  // migration inside regionCopyRecBody (layout-kinds.js) is gated on
  // `ctx.scope.globals.has('__dyn_props')`, which must be read at PULL time
  // (src/wat/assemble.js calls a function-valued stdlib entry lazily, exactly
  // once, when the name is actually pulled in — see __obj_clone/__dyn_set
  // above for the same idiom), not at this file's own module-setup time,
  // when collection.js's global declarations may not have run yet. Likewise
  // OBJECT's schema-length lookup (regionArmObject) needs `$__schema_tbl`
  // declared — mirrors __sclone_rec's own guard (module/collection.js): a
  // build with no OBJECT anywhere still gets the global seeded to 0, so its
  // `(if (i32.ne $__schema_tbl 0) ...)` check degrades to "0 slots" safely
  // rather than referencing an undeclared global.
  //
  // Heap-kind registry Slice 2 (.work/evidence.md §Heap-kind registry): the
  // function BODY (locals + preamble + every kind's arm) is generated from
  // layout-kinds.js's regionCopyRecBody — BIGINT/STRING/ARRAY/SET+MAP
  // extracted verbatim from the pre-Slice-2 hand-written text (byte-identity
  // pinned in test/layout-kinds.js), OBJECT/HASH/TYPED/BUFFER/EXTERNAL/
  // CLOSURE all now real arms — see that file's own header for the full
  // rationale and FINDINGS['region-forwarding'] (layout-kinds-doc.js) for
  // the closed history.
  //
  // `$__closure_env_len`/`$__closure_env_mask`: CLOSURE's side table
  // (funcIdx → env slot count / cell-mode bitmask, src/wat/assemble.js
  // builds it from ctx.closure.envMeta once ctx.closure.table is final).
  // Declared unconditionally here, mirroring `$__schema_tbl` just below —
  // a build with no closures anywhere (or with __region_copy_rec pulled in
  // but assemble.js never populating the table because ctx.closure.table
  // is empty) still gets both globals seeded to 0, so regionArmClosure's
  // own `$__closure_env_len == 0` guard degrades safely rather than
  // referencing an undeclared global.
  ctx.core.stdlib['__region_copy_rec'] = () => {
    if (!ctx.scope.globals.has('__schema_tbl')) declGlobal('__schema_tbl', 'i32')
    if (!ctx.scope.globals.has('__closure_env_len')) declGlobal('__closure_env_len', 'i32')
    if (!ctx.scope.globals.has('__closure_env_mask')) declGlobal('__closure_env_mask', 'i32')
    return `(func $__region_copy_rec (param $v f64) (param $memo i64) (param $mark i32) (param $delta i32) (result f64)
${regionCopyRecBody({ hasDynProps: ctx.scope.globals.has('__dyn_props'), lane })}`
  }

}
