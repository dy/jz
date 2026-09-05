# Optimizer and transport evidence

Measurements behind PLAN step 4's decisions. Corpus: `bench/*` at levels 0/2/3/size, `examples/*` at speed, 300 rows; the flagship: web-audio-api at level 2. Dates are the measurement dates.

## watr pass ablation on the flagship (2026-09-04, watr 5.10.1)

Bytes added to the flagship (758,955 B) with one watr pass off, everything else as jz configures it:

| pass off | bytes |
|---|---:|
| propagate | +40,350 |
| mergeBlocks | +28,257 |
| coalesce | +25,529 |
| vacuum | +5,308 |
| cse | +4,543 |
| treeshake | +1,131 |
| zeroinit | +1,010 |
| dedupe | +986 |
| branch | +984 |
| fold | +744 |
| deadcode | +736 |
| peephole | +678 |
| offset | +346 |
| merge | +233 |
| globals | +231 |
| identity | +176 |
| unbranch | +158 |
| inlineOnce | −691 |
| watr off entirely | +9.5% |

The rounds interleave: with the tape's mergeBlocks and vacuum on and watr's off, 239 corpus rows grew. A watr pass is replaced whole or not at all.

## Scheduling findings (2026-09-04)

- The local def/use folds (`optimize/locals.js`: propagateSingleUse, foldSetToTee) run after the devirtualizers fold the inlined arms' temps into shapes watr's `narrowLocals` and `intguard` no longer match: `bench/dispatch` at level 2, 1.8 → 7.2 ms. They stay before the devirtualizers until those move. Propagate does not cross the devirtualization boundary without closing this.
- vacuum and mergeBlocks on the tape before watr changed the shapes watr's heuristics key on: 56 of 300 corpus rows grew. After watr, both were pure copies of watr's own passes (0 B on the corpus once `memory.size` was a read).

## The late link, pass by pass (2026-09-05)

The tape's fold, vacuum, block merge and locals order run once more after watr's fixpoint (`link/late.js`, since deleted). Bytes the corpus lost with each pass off:

| pass off | corpus | flagship |
|---|---:|---:|
| fold | 0 | 0 |
| vacuum | +405 (135 rows × 3 B: one `drop (memory.size)` each) | 0 |
| mergeBlocks | 0 | 0 |
| locals order | +7,725 | +2,416 |
| all | +8,130 | +2,416 |

Both effects went into watr (a137283 `sortLocals`, 5ff0037 `memory.size` a read). With watr ordering the locals last, the late link's own order undid watr's boundary merge (its tail reopened with the lowest type): late link off under the new watr, 18 rows smaller by 1–2 B, none larger. The tape's pre-watr order under watr's final order: 61 rows smaller, 5 larger, −106 B net; it runs only when watr does not (levels 1 and `fast`).

Final against the late link: 72 rows smaller, 5 larger (bezfit@size +1, vm@size +9, ex:raytrace +1, ex:wireworld +14, ex:zzfx +2), −140 B net; the flagship 758,955 → 758,908 B; the late link's 130 ms (decode 37, encode 32, passes) gone.

## The transport (2026-09-05, flagship module, 665K nodes, `--expose-gc`)

Live heap after the encode, one variant per process (the parsed input tree: 122 MB):

| decode | encode | after encode | output tree alone | encode time |
|---|---|---:|---:|---:|
| reading (47–62 ms) | push (`[head]` then `push`) | 188.6 MB | 81.0 MB | 43–48 ms |
| reading | exact (`new Array(n)`) | 137.6 MB | 30.0 MB | 10–11 ms |
| consuming (87–90 ms) | the emptied arrays refilled by push | 92.1 MB | 86.1 MB | 34 ms |
| consuming | exact | 51.5 MB | 30.0 MB | 10 ms |

The columns: 1,048,576 slots × 32 B = 32 MB (the compiler's own module: 11,774,031 nodes, 16,777,216 slots by doubling, 512 MB; reserved from a count, 377 MB). Consuming lowered the live set only during the passes (121 → 4 MB); the peak is in watr's optimizer; in the kernel's arena an emptied array reclaims nothing and the mark that told a shared array (the emitter shares 2.7% of the flagship's arrays: `local.get` leaves, `i64.reinterpret_f64` reads) was the cost. Kept: exact encode, no consuming, columns reserved from a count.

## Allocation, sampled (2026-09-05, flagship, `HeapProfiler.startSampling`, collected objects included)

9,601 MB allocated over a 12.8 s compile:

| where | MB | share |
|---|---:|---:|
| watr `src/optimize.js` (own frames) | 4,251 | 44% |
| builtins under it (Set/Map/set/next/slice/push/map/join) | ~3,000 | ~31% |
| watr `src/compile.js` (`cleanup` 400, `normalize` 316) | 997 | 10% |
| jz compile (summary/index.js 275, licm 64, ir-scan 49) | ~1,900 | 20% |
| ir/tape.js | 71 | 0.7% |

Largest watr frames: `(anon)` 2,261 MB, `substGets` 336, `rec` (tallyLocals) 304, `visit` 113, `restore` 105, `tagSrc` 104, `sinkSets` 93, `eliminateDeadStores` 75, `forwardPropagate` 72, `cseFactsOf` 66. In the kernel (a bump allocator, no reclaim before the checkpoint) allocation volume is what fills the 4 GB; the stage marks `scripts/self.js` publishes (`recursive-self-check.mjs` reports them, on a trap too) attribute it by stage there.
