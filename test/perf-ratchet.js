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
import { ok } from 'tst/assert.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import jz from '../index.js'
import parseWat from 'watr/parse'
import { CATEGORIES, genProgram } from '../scripts/perf-corpus.mjs'
import { onWasi } from './_matrix.js'

const SEEDS = 40
const BASELINE = join(import.meta.dirname, 'perf-ratchet.json')

// Nullish receiver checks (2026-09-15) add buf +40, nest +88, slice +256,
// condref +152 loop nodes when generic reads/stores inline. Omitting only
// requireReceiverWat in a control build restores every prior count exactly.
// These are required JS exceptions, not a lost optimization; timing, Watr/JSON
// binary-size ceilings and memory caps stay unchanged.

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
const loopBodyOps = (wat) => {
  let count = 0
  const walk = (n, inLoop) => {
    if (!Array.isArray(n)) return
    const here = inLoop || n[0] === 'loop'
    if (here && typeof n[0] === 'string') count++
    const end = n[0] === 'block' && /^\$__wa\d+d$/.test(n[1]) ? n.length - 1 : n.length
    for (let i = 1; i < end; i++) walk(n[i], here)
  }
  walk(parseWat(wat), false)
  return count
}

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

// Total loop-body ops across the fixed corpus, per category. Deterministic.
const measure = () => {
  const totals = {}
  for (const cat of Object.keys(CATEGORIES)) {
    let sum = 0
    for (let s = 1; s <= SEEDS; s++) {
      try { sum += loopBodyOps(jz.compile(genProgram(cat, s), { optimize: 2, wat: true })) }
      catch (cause) { throw new Error(`perf corpus ${cat}, seed ${s} failed to compile`, { cause }) }
    }
    totals[cat] = sum
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
  const cur = onWasi() ? null : measure()
  for (const cat of Object.keys(base)) {
    test(`perf-ratchet: ${cat} loop-body op count ≤ baseline (machine-independent codegen gate)`, () => {
      if (onWasi()) return
      ok(cur[cat] <= base[cat],
        `${cat}: ${cur[cat]} loop-body ops > baseline ${base[cat]} (+${cur[cat] - base[cat]}) — a codegen regression ` +
        `(a hot-loop optimization stopped firing?). If intentional, justify and re-baseline: node test/perf-ratchet.js --update`)
    })
  }
}
