// Machine-independent codegen-throughput ratchet.
//
// Timing can't gate jz on bitwise/ToInt32/shift-heavy shapes: V8's JS-JIT beats
// its OWN wasm tier there by a CPU-dependent margin (this box wins; some CI boxes
// show jz ~1.2× — a hand-optimal WAT hits the same floor, so it's V8 architecture,
// not jz). See scripts/fuzz-bench.mjs. So instead of timing, we ratchet a
// DETERMINISTIC proxy for per-iteration cost: the number of instructions emitted
// INSIDE loops, summed over the shared seeded corpus (scripts/perf-corpus.mjs).
//
// A lost optimization re-introduces loop-body work and trips the ratchet (e.g.
// disabling hoistInvariantLoop, the unified LICM, takes mixed from 870 → 1054);
// an improvement lowers the count — lock the gain with `node test/perf-ratchet.js
// --update`. Pure codegen signal: no timing, machine-independent, byte-stable.
//
// "Ratchet, don't backslide" (docs/CONTRIBUTING.md). Run standalone or via the suite.
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import parseWat from 'watr/parse'
import { CATEGORIES, genProgram } from '../scripts/perf-corpus.mjs'
import { onWasi } from './_matrix.js'
import { compile } from './util.js'
import { loopBodyOps, enteredLoopOps, NUMERIC_CALLS, ARRAY_CALLS } from './_loop-ops.js'

const SEEDS = 40
const BASELINE = join(import.meta.dirname, 'perf-ratchet.json')

// Nullish receiver checks (2026-09-15) add buf +40, nest +88, slice +256,
// condref +152 loop nodes when generic reads/stores inline. Omitting only
// requireReceiverWat in a control build restores every prior count exactly.
// These are required JS exceptions, not a lost optimization; timing, Watr/JSON
// binary-size ceilings and memory caps stay unchanged.

// An index key's units (2026-09-29) are read in the key's own form, packed
// short string or heap array, decided once before the parse loop, where the
// loop called __char_at per unit: 30 more loop nodes in __str_arr_idx and
// __typed_str_idx, and where watr inlines the first into
// __arr_typed_obj_set_idx (buf +150, slice +2400, condref +1200). A
// per-function comparison shows no other body changed; each unit is a load
// or a shift, not a call.

// A short integer's string (2026-09-29) packs its digits into the pointer in
// __i32_to_str's own digit loop, with no scratch buffer, __itoa or __mkstr
// pass: 27 loop nodes per module that formats one, in the helper and where
// watr inlines it into __arr_typed_obj_set_idx's loop (buf +135, slice +216,
// condref +1080). A per-function comparison against the tree before it shows
// no other body changed. String(16000) went from 51 to 10 ns.

// Reset-log reuse adds 26 loop nodes to __durable_slot_log in each of the
// 40 condref modules (+1040). Comparing with only that helper reverted proved
// all other 1657 function bodies unchanged. The baseline includes this required
// bookkeeping; it counts runtime loops as well as the program's hot loops.

// UTF-16 ABI (2026-09-09): remeasured against dbba8566 with unchanged seeds.
// Delta by category: buf +165, nest +374, slice +1360, ring +1320,
// condref +1402. Changed bodies are __mkstr/__to_str/__str_copy/__str_concat,
// __itoa, __str_hash, and their inlined paths in f$exp/__hash_set_local.
// The inlined unit loads/stores add byte-address scaling; heap hashing shrinks.
// Pure int/float/mixed/cond/fgather totals are unchanged. This structural
// baseline includes string runtime work; timing and binary-size gates do not move.

// Wide accumulation at level 2 (2026-09-13): the guarded i64 clone adds its
// header check (about eight nodes per versioned loop) and removes the f64
// truncation and guard of each ToInt32 read. With the pass off, float and mixed
// still count exactly 565 and 971; on, the clones alone count 796 and 1149
// (21 and 28 of the 40 seeds versioned). Measured on this machine, back to back:
// float perf-fuzz geomean 1.11× → 0.76×, mixed 1.79× → 0.98×. The proxy rises
// where the measurement falls; re-baselined here. The same update lowered buf,
// nest, slice, ring and condref, which the pass never versions: those had
// improved under earlier commits and sat below a stale-high baseline.
// Numeric dictionary stores (2026-09-14): notString cannot prove ARRAY/TYPED.
// The object-capable store must remain for opaque receivers; the old helper
// silently ignored dictionary writes (test/to-primitive.js, numeric keys on
// opaque receivers). An isolated old/new store-proof comparison attributes
// the added loops to __hash_set_local / __ihash_set_local and their runtime
// dependencies. buf seed 8's fast SIMD/scalar loops still have 19 nodes each;
// its cold loop shrinks 989 -> 835 as outlining changes. The ratchet includes
// those newly required runtime loops, even outside a program's hot loops.
// With summary-proven output buffers, totals change buf 14344 -> 14994,
// slice 67576 -> 74808, fgather 9840 -> 5960. Timing/size/memory caps do not move.
//
// The Map hash's string arm mixes a packed short string and loads a filled
// hash cell in place (layout-kinds.js mapHashStringArm): a string-keyed Map or
// Set probe makes one call, not two. watr inlines the arm into the collection
// helpers' own loops (copy, rehash), which this count includes: nest 21900 ->
// 22538, slice 74808 -> 76664. Timing/size/memory caps do not move.
// Known-array reads and lengths (2026-09-18) take their forwarding hop inline
// (src/ir/pointers.js fwdOffsetIR: the offset, one header compare, the chase
// outlined) where a `__ptr_offset` call stood, and a number key on a receiver
// the summary cannot type reads the array arm inline ahead of the typed
// helper (module/array.js arrayFast): ring 50400 -> 53800, the hop's nodes per
// access in its loops. The warm self-compile gate, which pays those calls,
// went from 1.16x to 1.03x across the same changes. Strict equality and
// nullish tests inline their bit compares, a boxed boolean selects its atom,
// and the string hash reads a heap length in place, which shrinks the runtime
// loops this count includes: buf 15034 -> 14584, nest 22626 -> 16625, slice
// 76920 -> 69312, condref 89053 -> 86588. Timing/size/memory caps do not move.
// Per-iteration heap restores (2026-09-21): a loop whose iteration builds a
// temporary through a callee, or beside an accessor-named read the census now
// resolves, rewinds the heap pointer at its start, two nodes per loop in the
// export wrapper's inlined body (`global.set $__heap (local.get $lrw)`):
// nest 16625 -> 16691, slice 69312 -> 69760, ring 53800 -> 54040. The loops
// run in constant memory for that store; timing/size/memory caps do not move.
// Compaction (2026-10-14, module/core/compact.js): a module an export of
// which may keep memory now links the kernel, whose walk and slide are
// runtime loops: buf +4830, slice +39896, condref +38640 over the 40 seeds,
// all of it in __compact, __gc_mark, __gc_walk, __gc_roots, __gc_keep,
// __gc_canon and __gc_move by a per-function comparison against the same
// modules compiled with `compact: false`; the one program body that moved is
// slice's f$exp (+488), the threshold test of a loop's own compaction site,
// one comparison per iteration. The site's cold block is not counted (below).
// The site then moved out of the loop's body (2026-10-14): the loop's top
// leaves for the compaction past the threshold and a loop around re-enters it
// after, a block, a loop and three branches per site beside the test: slice
// +4816 over its 40 modules, the only category whose loops carry sites.
// The count (loopBodyOps, enteredLoopOps) and the inputs the calls take
// (NUMERIC_CALLS, ARRAY_CALLS) are in test/_loop-ops.js, shared with
// test/spellings.js.

// Specialized loops (2026-09-29): a loop whose reads may miss, or whose
// numbers are integers the emitter could not prove, runs in a copy that tests
// the reads and carries the integers in integer registers, the loop as
// written beside it (not counted, as above), which alone keeps the checked
// twin of a loop the emitter versioned. The copies' loops count: slice 71598
// -> 66657; the other categories hold no loop worth a copy and keep their
// counts. With `specializeLoops: false` slice counts what it did.

// Element-kind variants (2026-09-28): an export whose array parameter the body
// uses as numbers has Float32Array variants beside it (narrow/param-abi.js),
// the same loops over another element kind, of which a call runs one. Their
// loops count: buf 14409 -> 15798, nest 2187 -> 3571, fgather 5960 -> 12560,
// ring 5880 -> 18720 (an in-place slot beside a read-only one keeps the mixed
// variant too). slice 64828 -> 68806: its variants add 8074, and
// __dyn_get_any, called from both wrappers, stays outlined where one wrapper
// inlined it (-4096). A receiver the summary cannot type is tested before its
// loop, not per iteration (compile/analyze/frame-effects.js): condref and the
// numeric categories are unchanged. The bench corpus exports no array
// parameter; its sizes do not move.
// Signed zero of `x + 0` (2026-09-27): the fold `x + 0.0 → x` held only for an
// integer x (−0 + 0 is +0; stdlib's gamma-lanczos-sum divided by that zero), so
// the corpus's f64 `+ 0` sites keep their add: mixed 1137 → 1148, the other
// categories unchanged by that fold. The same update lowered buf, nest, slice,
// ring and condref (a typed array's index is no longer demanded boxed, so their
// element paths left the dynamic-key helpers), locking those gains in.

// Release by age (2026-09-28): a frame restores its heap unless an escape
// wrote below its mark (optimize/arena-rewind.js), so a store that may hand
// older storage a value a running call made is a site (compile/analyze/
// frame-effects.js). Two shapes pay per iteration, both in the export
// wrapper's variant for receivers of unknown kind. condref's `t[i] = u[i]`
// asks the value it copied out of another array whether a running call made
// it (`__esc_new`, a number leaving at its first compare): 11 programs, 50
// nodes each, 83015 -> 83565. slice's `a[o + i] = a[o + i]` stores what its
// receiver held already and asks nothing, but `o + i` over an `o` of unknown
// kind may concatenate, so the loop allocates besides the store and the
// growth check stays after the store instead of around the loop (45 nodes),
// its mark moved past the value read, which a host's receiver answers with
// a copy (16 nodes): 8 programs, 61 nodes each, 68598 -> 69086. Measured
// over scripts/perf-corpus.mjs against 6f069d30, every other program's count
// unchanged, buf's `buf[i] = buf[i]` included. The bench corpus sizes and
// timings are gated on their own.

// Typed numeric indices (2026-09-29): unproven fractional/NaN keys no
// longer truncate into an element. The slice corpus reads offsets from host
// arrays: validating those keys adds 712 nodes in $f$exp and 448 in its
// Float32Array variant, 69086 -> 70246. An isolated 40-seed comparison finds
// no changed loop counts in any other function. Proven integer indices keep
// their direct path. Timing, binary-size and memory caps remain unchanged.
// Performance-branch history; combined counts still require measurement.
// Release by reach (2026-09-29): a program whose exported frame may keep what
// it stored links the walk from what its escapes wrote into (module/core/
// reach.js). Its loops run once per call that ran an escape, none per
// iteration of the program's own: `__reach_in` 95 nodes and `__survive` 79 a
// program. A site's lowering now logs its receiver where it is another than
// the one logged last: a probe of the log's table, which stands in the arm
// the lowering stood in (40 nodes where watr inlines it). By function,
// against the counts above: buf 15658 -> 16728 (`__reach_in` +475,
// `__survive` +395, `f$exp` +200), slice 69086 -> 71158 (+760, +632, +680),
// condref 83565 -> 92125 (+3800, +3160, +1160, `__esc_elem` +440). Every
// other function's count is unchanged. Measured, a loop that stores a fresh
// array into one receiver made at start runs 2.6 -> 3.2 ns an iteration, one
// that stores into 64 receivers in turn 5.1 -> 5.3.
// Number keys that name no element (2026-09-28): `a[o + i] = v` with o read
// from a host array stored into a[trunc(o + i)] for a fractional o, where
// JavaScript drops the store. The key's own test (emit/dispatch.js keyIndex) is
// what the checked arm pays; the versioned arm takes the key whole (its guard
// tests o integral), and so do integer-valued keys: slice 68598 → 68974, the
// other categories unchanged.
// A sum with a side of unknown kind (2026-09-28) is a number only where the
// program cannot concatenate (kind/val-type-of.js addsAsNumber): the corpus's
// slice programs index `a[o + i]` with `o` an element of a host array, which
// may be a string ('1' + 0 is '10'), so the store keeps its general key path
// behind the integer-key fast path and links its helpers, whose loops this
// count includes: slice 68974 -> 109288, every other category unchanged. The
// optimistic NUMBER it replaces sent `o.name + 1 + 2` through f64 arithmetic
// on the string's box ('x1', not 'x12').
// Both of the above together (2026-09-29): release by age asks the slice
// store's value and moves its growth check on the general key path the sum
// keeps: slice 109288 -> 109880, every other category unchanged.
// An index key's int32 test truncates through i64 (2026-09-29, compile/emit/
// dispatch.js int32Bits): `i32.wrap_i64 (i64.trunc_sat_f64_s x)` is one node
// more than `i32.trunc_sat_f64_s x` and one arm64 instruction where the i32
// truncation is a rounding, a round trip and an out-of-line saturation arm.
// Eight slice programs test one such key in a loop: 109880 -> 109888, every
// other category unchanged.
// The changes above, on main's tree of 2026-09-29 (797ec1ec): main's own
// counts plus the deltas they made on the tree they were measured on, buf
// +285, condref +2280, and slice +44954: the general key path's helpers now
// carry main's reset log (`__durable_slot_log`) and the heal loops of
// `_clear`, 1536 more than on the tree before; every other category is main's.

// An object made at start is saved before the round's first store into it
// of a value that names memory of the round (2026-09-29, module/core/
// durable-log.js `__durable_obj_snap`): a field a call pointed at what it
// made named freed memory after `memory.reset()`. The reset asks each slot
// of a saved object whether it names memory of the round, a loop of its
// own in `_clear`, and the walk reads a record's size by its kind: buf
// 16728 -> 17003 (`_clear$exp` +240, `__survive` +35), slice 71158 -> 71598
// (+384, +56), condref 92125 -> 94325 (+1920, +280). No loop of a program
// changed; the numeric categories are unchanged.

// Consolidation (2026-09-30): restore perf-rb6 293db798's measured buf
// 17288 and slice 116552 thresholds; the merge had retained older values.
// Its condref threshold was 96605; the consolidated tree emits 85265, so
// retain that gain. Per-function comparison attributes the drop to string
// helpers; buf only exchanges __arr_set_idx_ptr for __arr_typed_set_idx.
// The consolidated slice (121648) and fgather (14400) still exceed these
// limits. Keep them red: slice inlines more generic store work, and fgather
// pays the full-range index check on idx+1. Do not hide those remaining costs.
// Counter widths (2026-10-01, `prove counter widths and preserve full Number
// loop bounds`): every category's total took the retained Number loop beside
// the guarded copy, and the entered caps above now hold the per-iteration
// cost those two notes kept visible: fgather's entered loops 6840 -> 5920
// (the idx+1 check is gone from the loops the calls run), slice's 25910 ->
// 26128. The totals count both arms from here on.

// Runtime correctness and memory work since the 2026-10-14 baseline (6249eea8),
// each step attributed by a per-function comparison of the 40 programs against
// the commit before it; the entered loops of buf and condref did not move:
//   be115089 __itoa renders two digits a pass (half the passes): buf +115, condref +920, slice +920
//   678f6255 __to_num reads a packed digit string by its units: +145, +1160, +1160
//   be92f3db __compact rekeys the named-property table it moves, the reset's slot
//            log relogs and cancels in step (__durable_slot_relog/_cancel): +1520, +12160, +11296
//   903fc2b9 __gc_mark rewrites a durable stub chain at its last stub: +115, +920, +920
//   603df6b2 __hash_set_local grows the reset's log where it trapped: +85, +680, +544
//   f5d1feae __compact grows the memory again past the host's views: +315, +2520, +2520
//   27a54476 __coll_order sorts past 64 entries by radix, not insertion: slice +1544
//   495fa1e6 __hash_set_local / __ihash_set_local find an array key after it grows:
//            slice +128, entered +64 (the probe the slice programs run)
//   ae7416e1 a number bounded through nested loops: slice f$exp -72, entered -48
//   5882f354 an escaping loop gives back each iteration's memory (jessie in 8.5 MB,
//            not 34): slice f$exp +1264 and __esc_elem now entered, entered +848
//   cd956f3f a value read only for its bits loads as an integer: slice -536
// The rest (buf +5, condref +40, slice +56, entered +8) is watr 5.13's output;
// nest fell 5595 -> 5545 meanwhile, locked in with these. Since:
//   7b5f0f35d a computed read of a receiver of no known kind reads inline after a test
//            for a Map or a Set, where it called the method-value reader: slice f$exp
//            +8160, entered +2656, all from the seeds whose loop is `a[o + i] = a[o + i]`
//            (f$exp 1858 -> 3161 WAT lines); that kernel, called on an array the module
//            builds, runs 0.52x (62 vs 120 ms, 15 alternating rounds, Apple M4 Max, load 8).
//   the array grow's capacity held to the dense limit (module/array.js arrGrow): an
//            index store into a receiver of no known kind keeps the grow in its loop's
//            cold arm, 9 ops more there: buf +45 (5 seeds), condref +360 (40 seeds),
//            no entered loop moved.
//   cf012bfa1 a length the runtime takes from other data tested where it comes in: slice
//            +192, entered +16, in the dictionary inserts' grow arms (`__hash_set_local`,
//            `__ihash_set_local`); buf -40, condref -320 (3a367c915 counts 30843 and
//            196581, 49d150e48 30803 and 196261).
//   05c1fda89 each release clears the flag it read: the take-over in every released loop's
//            cold arm, a local the loop carried and a restore at every end, the inner
//            loop's in the outer one's body: slice +672, entered +288, all from the eight
//            seeds whose loop is `a[o + i] = a[o + i]`.
//   the take-over in the runtime, at a function's outermost released loop alone
//            (module/core/reach.js `__iter_take`, `__iter_leave`): every loop body is what
//            it was before 05c1fda89, slice -672, entered -288.
//   27e67b6cc (8a507967a in its batch) Number::toString's exact short-decimal path
//            (module/number.js `__ftoa_short`: a double that is a decimal of at most 15
//            significant digits formats from a scaled integer before Ryu) and Ryu's
//            four-digit removal step, both inside `__ftoa`, where watr inlines
//            `__ftoa_into`: 152 ops a program that formats a fraction, buf +760 (5 seeds),
//            slice +6080 and condref +6080 (40 seeds each); a per-function comparison
//            against a651f7e94 finds no other function changed, no program loop among them,
//            and no entered loop moved. They run while a fraction is formatted, not per
//            iteration of a loop that formats none: String(x) at level 2, 200,000 values,
//            best of 7, Apple M4 Max: a price (k/100 + 0.01) 56 to 59 -> 29 to 31 ns,
//            a rate (k * 1.5e-4) 60 to 64 -> 54 to 56 ns, a random double 81 to 84 -> 72
//            to 75 ns (at speed 62 to 70 -> 27 to 29, 67 to 69 -> 53, 83 to 88 -> 72 to 76).
//            Its two-digit step, once, is a block, not a loop that never loops (-33 a program).
//   the loop's end walk (optimize/loop-compact.js, 2026-11-03): an outermost compacting
//            loop's end gate, `(if (i32.or (i32.eqz end) (call $__gc_end …)) …)`, its flag
//            and its exit, about 13 ops beside the cold block the count leaves out, which
//            run once per walk or loop end: slice f$exp +208, entered +104 (the gate sits
//            in the loop the site's re-entry makes, which the calls enter).
//   the insertion-ordered Set and Map tables (module/collection/ordered.js, 2026-11-03): by
//            function, over the 40 seeds, against the same tree without them. A compaction
//            walks a table's appended entries, so the walk reads the count and the block's
//            stride: 10 ops in `__compact` a program that links it, buf +50 (5 seeds), condref
//            +400, and in slice +320 there and +80 in `__gc_walk`; they run per Set or Map a
//            compaction meets. Slice's 8 programs that read `a[o + i]` may read a builtin
//            method as a value and link the Map's and the Set's method closures, whose loops
//            this count includes, none of which they call: `__coll_order` -2136 (no sort),
//            the methods' closures -792, the dictionary stores -32, `__coll_step` +408 (a
//            forEach's live step), `__ord_index` +376 and `__ord_live` +264 (the one growth,
//            in place or moved), the forEach closures +176; slice 231828 -> 230492, with the
//            count and stride above. No entered loop grew (slice
//            30800 -> 30784), no program loop among them. What they buy, jz against the tree
//            before them (a9fd0e1a0, speed tier, 7 interleaved rounds, M4 Max at load ~13):
//            mapstr 0.39x, setops 0.39x, mapobj 0.49x, mapint 0.52x.
//   f07a4a11d (2026-11-09) `__gc_move` drops the dead stubs from the log as it forwards them
//            (module/core/compact.js): 56 loop instructions in each of the 8 slice programs
//            that link it (seeds 8-10, 19-21, 31, 32), slice +448; the calls enter none of them.
//   the check made an equality, one baseline per host (2026-11-09): the JS entry takes this
//            tree's counts, which had fallen below the cap: float 1548/784 -> 1372/608, mixed
//            2341/1137 -> 2264/1060, slice entered 30784 -> 30656.
//   one loop form (src/normalize.js, 2026-11-09): the default style's step `i = i + 1`
//            reaches the readers as `++i`. Mixed seed 7 then meets plan/integral-loops.js's
//            trip rule (`COUNTS`: `++`, not `i = i + 1`), which holds `acc` to a word under a
//            guard no run of a trip passes (`1 + max(1, ceil(n) + 1) * 1103515500` within
//            i32) and leaves the loop as written cold, without the wide accumulator: that
//            program 77/38 -> 63/63, mixed 2264/1060 -> 2250/1085 on both hosts, every other
//            program as it was. Written `i++`, `++i` or `i += 1`, it compiled so before.
//   a copy's word for a cursor no second trip keeps in the word (plan/integral-loops.js
//            `oneTrip`, 2026-11-10): the guard `entry + trips * step` within i32 that `acc`
//            took (entry 0, a step of up to 1103515500) admits one trip at most, n <= 1, so the
//            copy runs no loop and the loop as written goes cold for every run of two. The
//            cursor is no longer the copy's word: the loop keeps its counter's copy, both copies
//            with the wide accumulator, as every spelling compiled it before src/normalize.js:
//            that program 63/63 -> 77/38, mixed 2250/1085 -> 2264/1060 on both hosts, the total
//            the second wide copy's 14 ops, every other program as it was.
// Total loop-body ops across the fixed corpus, per category. Deterministic.
const measure = (categories = Object.keys(CATEGORIES)) => {
  const totals = {}
  for (const cat of categories) {
    let sum = 0, entered = 0
    for (let s = 1; s <= SEEDS; s++) {
      try {
        const tree = parseWat(compile(genProgram(cat, s), { optimize: 2, wat: true }))
        sum += loopBodyOps(tree)
        const calls = NUMERIC_CALLS[cat] ?? ARRAY_CALLS[cat]?.()
        if (calls) entered += enteredLoopOps(tree, calls)
      } catch (cause) { throw new Error(`perf corpus ${cat}, seed ${s} failed to compile or execute`, { cause }) }
    }
    totals[cat] = NUMERIC_CALLS[cat] || ARRAY_CALLS[cat] ? { total: sum, entered } : sum
  }
  return totals
}

// The counts are the running host's, one baseline each: a wasi module links no
// compaction kernel and no reset slot log (`__compact`, `__gc_*`,
// `__durable_slot_*`) and its loops carry no compaction site (slice seed 8's
// `f$exp`: 5 sites and 2 end gates on the JS host, none on wasi), so buf, slice
// and condref count fewer loop ops there. `--update` rewrites the running host's
// entry alone.
const HOST = onWasi() ? 'wasi' : 'js'
const UPDATE = `node test/perf-ratchet.js --update${HOST === 'wasi' ? ' under JZ_TEST_HOST=wasi' : ''}`
const pair = v => typeof v === 'number' ? [v] : [v.total, v.entered]
if (process.argv.includes('--update')) {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
  base[HOST] = measure()
  writeFileSync(BASELINE, JSON.stringify(base, null, 2) + '\n')
  console.log(`updated perf-ratchet ${HOST} baseline:`, base[HOST])
} else {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'))[HOST]
  for (const cat of Object.keys(base)) {
    test(`perf-ratchet: ${cat} loop-body op count = the ${HOST} baseline (machine-independent codegen gate)`, () => {
      const count = measure([cat])[cat], limit = base[cat]
      const got = pair(count), want = pair(limit)
      const above = got.some((n, i) => n > want[i]), equal = got.every((n, i) => n === want[i])
      ok(equal, equal ? `${cat} = ${JSON.stringify(limit)}`
        : above ? `${cat}: ${JSON.stringify(count)} loop-body ops exceed the ${HOST} baseline ${JSON.stringify(limit)} — a codegen regression ` +
          `(a hot-loop optimization stopped firing?). If intentional, justify and re-baseline: ${UPDATE}`
        : `${cat}: ${JSON.stringify(count)} loop-body ops are below the ${HOST} baseline ${JSON.stringify(limit)}: the count improved; lock it in: ${UPDATE}`)
    })
  }
}


test('perf-ratchet: entered costs retain both branch accounting and the original tree', () => {
  const tree = parseWat(`(module (func (export "f") (param $mode i32)
    (if (local.get $mode)
      (then (loop $fast (drop (i32.const 1))))
      (else (loop $slow (drop (i32.add (i32.const 1) (i32.const 2))))))))`)
  const original = JSON.stringify(tree), total = loopBodyOps(tree)
  is(enteredLoopOps(tree, [[1], [1]]), 3, 'the selected loop, counted once across repeated calls')
  is(enteredLoopOps(tree, [[0]]), 5, 'the other entry selects its own loop')
  is(enteredLoopOps(tree, [[1], [0]]), total, 'different entries retain the union of selected loops')
  is(enteredLoopOps(tree, []), 0, 'no calls select no loop')
  is(JSON.stringify(tree), original, 'instrumentation leaves no imported function or calls in the measured tree')
  const early = parseWat('(module (func (export "f") (loop (return))))')
  is(enteredLoopOps(early, [[]]), 2, 'an unlabeled loop records entry before an early return')
  const result = parseWat('(module (func (export "f") (drop (loop (result i32) (i32.const 9)))))')
  is(enteredLoopOps(result, [[]]), loopBodyOps(result), 'a result loop keeps its type declaration before the entry call')
})
