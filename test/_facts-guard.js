// Hold each optimizer step to its entry in the pass table (src/optimize/pass-table.js): a step
// reads of the compile's facts only what its entry takes or makes, and writes only what it
// makes. On under JZ_DEBUG_INVARIANTS for every compile of the process (test/util.js loads
// this, the fuzzer through it); test/pass-table.js turns it on for its own compiles.
// A Proxy, so it lives here: the compiler's source stays in the subset it compiles.
import { holdFacts } from '../src/optimize/pass-table.js'

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
export const hold = () => {
  if (holds++ === 0) holdFacts(heldFor)
  return () => { if (--holds === 0) holdFacts(null) }
}

if (typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1') hold()
