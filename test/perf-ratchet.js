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
// "Ratchet, don't backslide" (CONTRIBUTING.md). Run standalone or via the suite.
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

// Reset-log reuse adds 26 loop nodes to __durable_slot_log in each of the 40
// condref modules (+1040).

// This structural baseline includes string runtime work; timing and binary-size
// gates do not move.

// The proxy rises where the measurement falls; re-baselined here. The
// object-capable store must remain for opaque receivers; the old helper silently
// ignored dictionary writes (test/to-primitive.js, numeric keys on opaque
// receivers). Timing/size/memory caps do not move.
//
// Timing/size/memory caps do not move. Timing/size/memory caps do not move. The
// loops run in constant memory for that store; timing/size/memory caps do not
// move. The count (loopBodyOps, enteredLoopOps) and the inputs the calls take
// (NUMERIC_CALLS, ARRAY_CALLS) are in test/_loop-ops.js, shared with
// test/spellings.js.

// The bench corpus exports no array parameter; its sizes do not move.

// Two shapes pay per iteration, both in the export wrapper's variant for
// receivers of unknown kind. condref's `t[i] = u[i]` asks the value it
// copied out of another array whether a running call made it (`__esc_new`, a
// number leaving at its first compare): 11 programs, 50 nodes each, 83015 ->
// 83565. slice's `a[o + i] = a[o + i]` stores what its receiver held already
// and asks nothing, but `o + i` over an `o` of unknown kind may concatenate,
// so the loop allocates besides the store and the growth check stays after
// the store instead of around the loop (45 nodes), its mark moved past the
// value read, which a host's receiver answers with a copy (16 nodes): 8
// programs, 61 nodes each, 68598 -> 69086.

// Do not hide those remaining costs.
// The totals count both arms from here on.

// On wasi, which links no `__gc_mark`: buf 24683 -> 24693, condref 147364 -> 147378, slice 166684
// -> 165884 (f$exp -480), the entered counts as on the JS host. Total loop-body ops across the
// fixed corpus, per category. Deterministic.
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
