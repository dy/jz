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
import jz from '../index.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { CATEGORIES, genProgram } from '../scripts/perf-corpus.mjs'
import { onWasi } from './_matrix.js'

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
// Count instruction nodes (every S-expr array) lexically inside any `(loop …)`.
// A wide-accumulator versioning (src/optimize/wide-accumulator.js) keeps the
// original loop as the cold fallback, the last child of its `$__wa…d` block:
// the per-iteration cost this proxies is the guarded clone's, so the fallback
// is not counted. The clone's header check is real per-iteration work and is.
// A specialized loop (src/optimize/specialize.js) keeps the loop as written
// the same way: the last child of its `$__sp.f<n>d` block, or of the block
// that block holds (the loop's own exit). The copy's guards and the tests
// ahead of it are counted.
const isLoop = (n) => Array.isArray(n) && n[0] === 'loop'
const loopBodyOps = (tree, entered) => {
  let count = 0
  const walk = (n, inLoop) => {
    if (!Array.isArray(n) || n[0] === 'loop' && entered && !entered.has(n)) return
    const here = inLoop || n[0] === 'loop'
    if (here && typeof n[0] === 'string') count++
    let end = n[0] === 'block' && /^\$__wa\d+d$/.test(n[1]) ? n.length - 1 : n.length
    const copy = n[0] === 'block' && typeof n[1] === 'string' && /__sp\.f\d+d$/.test(n[1])
    if (copy && isLoop(n[end - 1])) end--
    for (let i = 1; i < end; i++) {
      const c = n[i]
      if (!copy || !Array.isArray(c) || c[0] !== 'block' || !isLoop(c[c.length - 1])) { walk(c, here); continue }
      if (here) count++
      for (let k = 1; k < c.length - 1; k++) walk(c[k], here)
    }
  }
  walk(tree, false)
  return count
}

// Identify the loops selected by real entry guards, after all codegen passes.
// Instrument only a temporary assembly: counters never enter the measured tree.
// This handles both if/else and block/br_if forms without guessing from names or
// ignoring arbitrary fallback arms. Total loop cost remains independently capped.
const enteredLoopOps = (tree, calls) => {
  const loops = [], entered = new Set()
  const walk = n => {
    if (!Array.isArray(n)) return
    if (n[0] === 'loop') {
      const id = loops.length
      let body = typeof n[1] === 'string' ? 2 : 1
      while (Array.isArray(n[body]) && ['type', 'param', 'result'].includes(n[body][0])) body++
      loops.push([n, body])
      n.splice(body, 0, ['call', '$__ratchet_enter', ['i32.const', id]])
    }
    for (const c of n) walk(c)
  }
  walk(tree)
  tree.splice(1, 0, ['import', '"ratchet"', '"enter"', ['func', '$__ratchet_enter', ['param', 'i32']]])
  let binary
  try { binary = encodeWat(tree) }
  finally { tree.splice(1, 1); for (const [loop, body] of loops) loop.splice(body, 1) }
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(binary), {
    ratchet: { enter: id => entered.add(loops[id][0]) }
  })
  for (const args of calls) exports.f(...args)
  return loopBodyOps(tree, entered)
}

// Correct Number counters need a guarded integer loop plus a full-Number
// fallback. Across the same 40 int seeds the entered integer loops remain 647
// nodes; the additional fallback costs 702. Preserve 647 as the fast-path cap,
// and also cap the existing overall proxy at 1349. Inputs cover no work, positive integer
// and fractional bounds; fallback presence cannot dilute the fast-path bar.
const INT_CALLS = [[0, 3, 5, 7], [4, 3, 5, 7], [3.5, -1, 0, 7]]

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

// Total loop-body ops across the fixed corpus, per category. Deterministic.
const measure = (categories = Object.keys(CATEGORIES)) => {
  const totals = {}
  for (const cat of categories) {
    let sum = 0, entered = 0
    for (let s = 1; s <= SEEDS; s++) {
      try {
        const tree = parseWat(jz.compile(genProgram(cat, s), { optimize: 2, wat: true }))
        sum += loopBodyOps(tree)
        if (cat === 'int') entered += enteredLoopOps(tree, INT_CALLS)
      } catch (cause) { throw new Error(`perf corpus ${cat}, seed ${s} failed to compile or execute`, { cause }) }
    }
    totals[cat] = cat === 'int' ? { total: sum, entered } : sum
  }
  return totals
}

if (process.argv.includes('--update')) {
  const totals = measure()
  writeFileSync(BASELINE, JSON.stringify(totals, null, 2) + '\n')
  console.log('updated perf-ratchet baseline:', totals)
} else {
  // The baseline is the JS host's. Under wasi the export wrapper carries the
  // argument conversion loops the JS bridge performs outside the module
  // (condref's `$f$exp`: 838 loop-body ops against 358), so the counts are
  // host-specific there and the gate holds on the JS host alone.
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
  for (const cat of Object.keys(base)) {
    test(`perf-ratchet: ${cat} loop-body op count ≤ baseline (machine-independent codegen gate)`, () => {
      if (onWasi()) return
      const count = measure([cat])[cat]
      const limit = base[cat]
      ok(typeof limit === 'number' ? count <= limit : count.total <= limit.total && count.entered <= limit.entered,
        `${cat}: ${JSON.stringify(count)} loop-body ops exceed baseline ${JSON.stringify(limit)} — a codegen regression ` +
        `(a hot-loop optimization stopped firing?). If intentional, justify and re-baseline: node test/perf-ratchet.js --update`)
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
