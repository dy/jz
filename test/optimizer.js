/**
 * Optimizer regression tests:
 *   - LICM call-soundness:   loop body containing a call must NOT hoist cell reads
 *     (the call could mutate the cell via another closure that captures it).
 *   - LICM shared-IR:        watr slice pattern — a captured `idx` read appears
 *     in slice-length setup AND inside the slice copy loop. Earlier passes
 *     can share the IR subtree; mutating it inside the loop must not affect
 *     the outside reference.
 *   - arrayElemValType:      .map closure on numeric array elides __to_num
 *     coercion in the body since the param type is known to be NUMBER.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { run } from './util.js'

test('LICM: call inside loop must not hoist cell reads (mutated via closure)', () => {
  const { main } = run(`
    export const main = () => {
      let i = 0
      const inc = () => { i = i + 1; return 0 }
      let s = 0
      for (let j = 0; j < 10; j++) {
        s = s + i + i
        inc()
      }
      return s | 0
    }
  `)
  // j=0: s=0+0+0=0, then i=1
  // j=1: s=0+1+1=2, then i=2
  // ... s = 2*(0+1+...+9) = 90
  is(main(), 90)
})

test('LICM: shared IR subtree (slice + slice-loop pattern) must not corrupt outside read', () => {
  // Mirrors watr/compile.js shape: idx is captured (mutated elsewhere),
  // used both in slice-length calc AND inside the slice copy loop body.
  // Earlier passes share the IR for `cell_idx` reads — LICM must not
  // mutate the shared subtree.
  const { main } = run(`
    export const main = (a) => {
      let idx = 1
      const set = (v) => { idx = v; return 0 }
      const sub = a.slice(idx)
      let sum = 0
      for (let j = 0; j < sub.length; j++) sum = sum + sub[j]
      set(2)
      return sum | 0
    }
  `)
  // a = [10, 20, 30, 40] → slice(1) = [20,30,40], sum=90
  is(main([10, 20, 30, 40]), 90)
})

test('LICM: actually fires for invariant cell read in non-call loop', () => {
  // Sanity: when conditions are right (no calls, no shared IR, no writes),
  // LICM should hoist the cell load and emit a $__sc snap local.
  const wat = jz.compile(`
    export const main = () => {
      let i = 0
      const inc = () => i = i + 1
      let s = 0
      for (let j = 0; j < 10; j++) s = s + i + i
      inc()
      return s | 0
    }
  `, { wat: true })
  ok(/\$__sc\d+/.test(wat), 'expected hoisted snap local')
})

test('LICM: does not fire when loop contains calls', () => {
  const wat = jz.compile(`
    export const main = () => {
      let i = 0
      const inc = () => { i = i + 1; return 0 }
      let s = 0
      for (let j = 0; j < 10; j++) { s = s + i + i; inc() }
      return s | 0
    }
  `, { wat: true })
  ok(!/\$__sc\d+/.test(wat), 'must not hoist when loop contains a call')
})

test('arrayElemValType: typed-array .map elides __to_num in callback', () => {
  // Float64Array elements have known type NUMBER → __to_num coercion can be
  // elided in the inlined .map callback param.
  const wat = jz.compile(`
    export const main = () => {
      const a = new Float64Array([1, 2, 3, 4])
      const b = a.map(x => x * 2)
      return b[0] | 0
    }
  `, { wat: true })
  const calls = (wat.match(/\(call \$__to_num/g) || []).length
  is(calls, 0)
})

test('arrayElemValType: typed-array .map runtime correctness', () => {
  const { main } = run(`
    export const main = () => {
      const a = new Float64Array([1, 2, 3, 4])
      const b = a.map(x => x * 2 + 1)
      return (b[0] + b[1] + b[2] + b[3]) | 0
    }
  `)
  // (3 + 5 + 7 + 9) = 24
  is(main(), 24)
})
