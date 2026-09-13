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

const SEEDS = 40
const BASELINE = join(import.meta.dirname, 'perf-ratchet.json')

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

// Total loop-body ops across the fixed corpus, per category. Deterministic.
const measure = () => {
  const totals = {}
  for (const cat of Object.keys(CATEGORIES)) {
    let sum = 0
    for (let s = 1; s <= SEEDS; s++) {
      try { sum += loopBodyOps(jz.compile(genProgram(cat, s), { optimize: 2, wat: true })) } catch { /* skip non-compiling */ }
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
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const cur = measure()
  for (const cat of Object.keys(base)) {
    test(`perf-ratchet: ${cat} loop-body op count ≤ baseline (machine-independent codegen gate)`, () => {
      ok(cur[cat] <= base[cat],
        `${cat}: ${cur[cat]} loop-body ops > baseline ${base[cat]} (+${cur[cat] - base[cat]}) — a codegen regression ` +
        `(a hot-loop optimization stopped firing?). If intentional, justify and re-baseline: node test/perf-ratchet.js --update`)
    })
  }
}
