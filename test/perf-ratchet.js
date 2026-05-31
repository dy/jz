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
// disabling hoistInvariantToInt32 takes the worst seed from 36 → 64 loop-body ops);
// an improvement lowers the count — lock the gain with `node test/perf-ratchet.js
// --update`. Pure codegen signal: no timing, machine-independent, byte-stable.
//
// "Ratchet, don't backslide" (CONTRIBUTING). Run standalone or via the suite.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import jz from '../index.js'
import parseWat from 'watr/parse'
import { CATEGORIES, genProgram } from '../scripts/perf-corpus.mjs'

const SEEDS = 40
const BASELINE = join(import.meta.dirname, 'perf-ratchet.json')

// Count instruction nodes (every S-expr array) lexically inside any `(loop …)`.
const loopBodyOps = (wat) => {
  let count = 0
  const walk = (n, inLoop) => {
    if (!Array.isArray(n)) return
    const here = inLoop || n[0] === 'loop'
    if (here && typeof n[0] === 'string') count++
    for (let i = 1; i < n.length; i++) walk(n[i], here)
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
