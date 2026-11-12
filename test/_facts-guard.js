// Hold each optimizer step to its entry in the pass table (src/optimize/pass-table.js): a step
// reads of the compile's facts only what its entry takes or makes, and writes only what it
// makes. On under JZ_DEBUG_INVARIANTS for every compile of the process (test/util.js loads
// this, the fuzzer through it); test/pass-table.js turns it on for its own compiles.
// A Proxy, so it lives here: the compiler's source stays in the subset it compiles, and its
// walks hand a step the facts themselves. The hold wraps each stage's runners instead, in
// the lists the stages read them off.
import { PASSES } from '../src/optimize/pass-table.js'
import { RUN } from '../src/optimize/driver.js'
import { MODULE, GLOBAL_PTR, GLOBAL_LOADS } from '../src/wat/assemble/optimize-module.js'
import { LINK, BODIES } from '../src/link/index.js'
import { TAIL } from '../src/optimize/watr-tail.js'

const STAGES = [RUN, MODULE, GLOBAL_PTR, GLOBAL_LOADS, LINK, BODIES, TAIL]
const entry = new Map(PASSES.map(e => [e.id, e]))

const RAW = Symbol('the facts a hold wraps')

/** The facts handed to step `e`: a read or a write its entry does not state throws. */
const heldFor = (facts, e) => {
  if (facts === null || typeof facts !== 'object') return facts
  // (a step that walks a stage hands its facts on: each step is held to its own entry)
  const raw = facts[RAW] ?? facts
  return new Proxy(raw, {
    get(t, k) {
      if (k === RAW) return t
      if (typeof k === 'string' && k in t && !e.takes.includes(k) && !e.makes.includes(k))
        throw new Error(`pass table: '${e.id}' reads the fact '${k}', which its entry does not take`)
      return t[k]
    },
    set(t, k, v) {
      if (!e.makes.includes(k)) throw new Error(`pass table: '${e.id}' writes the fact '${String(k)}', which its entry does not make`)
      t[k] = v
      return true
    },
  })
}

/** Hold every step from here on; the answer lets go (the last hold, where several stand). */
let holds = 0
const plain = []   // [pair, runner]: the runners as the stages list them
export const hold = () => {
  if (holds++ === 0) for (const run of STAGES) for (const pair of run) {
    const e = entry.get(pair[0]), runner = pair[1]
    plain.push([pair, runner])
    pair[1] = (x, cfg, facts, st) => runner(x, cfg, heldFor(facts, e), st)
  }
  return () => { if (--holds === 0) { for (const [pair, runner] of plain) pair[1] = runner; plain.length = 0 } }
}

if (typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1') hold()
