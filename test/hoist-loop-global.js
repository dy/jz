/**
 * hoistLoopGlobalPtrOffset (src/optimize/index.js) — per-loop complement to
 * hoistGlobalPtrOffset. That pass requires the WHOLE FUNCTION to be clean
 * w.r.t. a stable-pointee module global (no write, no call_indirect/call_ref
 * anywhere); one unrelated indirect call elsewhere in a large function
 * poisons every such global for the whole function even when a specific
 * loop inside it never reaches that call. This pass re-tries per loop, using
 * collectReachableGlobalWrites (the same fail-closed, direct-call-graph
 * fixpoint hoistGlobalPtrOffset already uses) narrowed to just the loop's
 * own subtree.
 *
 * The structural (wat-probe) positive pin lives in test/wat-invariants.js
 * alongside the sibling hoistGlobalPtrOffset ablation test. This file pins
 * the SOUNDNESS boundary: a global genuinely reassigned mid-loop, or by a
 * callee reachable from the loop, must keep producing correct values —
 * i.e. the hoist must NOT fire (or must be sound if it does).
 */
import test from 'tst'
import { is } from 'tst/assert.js'
import { run } from './util.js'

// `export let X =`/`export const X =` -> `let X = exports.X =`/`const X = exports.X =`
// (a real LOCAL binding, not just a property) so exported functions here —
// which call EACH OTHER by bare name (warmup -> helper, main -> scanThenDispatch)
// — resolve correctly under plain `new Function`. `let` (not `const`) for the
// `export let` form: `cur`/`idx` are reassigned after their initial declaration.
const jsEval = (src) => {
  const exports = {}
  new Function('exports', src
    .replace(/export let (\w+) =/g, 'let $1 = exports.$1 =')
    .replace(/export const (\w+) =/g, 'const $1 = exports.$1 ='))(exports)
  return exports
}

test('hoist-loop-global: DIRECT reassignment of the global inside the loop stays correct', () => {
  // `cur` is reassigned to a DIFFERENT string mid-loop (i===2) — a hoisted
  // base snapshotted before the loop would read stale bytes for the later
  // iterations. `stablePtrGlobalNames` sees `cur` (VAL.STRING from its
  // `'abcdefgh'` initializer) as a hoist CANDIDATE; ownWrites (the direct
  // `global.set $cur` inside the loop) must veto it.
  const src = `
    export let cur = 'abcdefgh', idx = 0
    export const scan = () => {
      let out = 0
      for (let i = 0; i < 4; i++) {
        out = out + cur.charCodeAt(idx)
        idx = idx + 1
        if (i === 2) cur = 'wxyzabcd'
      }
      return out
    }`
  const { scan } = run(src, { optimize: 'speed' })
  is(scan(), jsEval(src).scan(), 'per-read derivation across the mid-loop reassignment stays bit-exact')
})

test('hoist-loop-global: TRANSITIVE reassignment through a callee reachable from the loop stays correct', () => {
  // `reassign` writes `cur` and is called FROM WITHIN the loop — no direct
  // `global.set $cur` inside the loop body itself, so this is the
  // collectReachableGlobalWrites leg: calleeWrites('$cur') must trace
  // scan -> reassign -> global.set $cur and veto the hoist.
  const src = `
    export let cur = 'abcdefgh', idx = 0
    const reassign = () => { cur = 'wxyzabcd' }
    export const scan = () => {
      let out = 0
      for (let i = 0; i < 4; i++) {
        out = out + cur.charCodeAt(idx)
        idx = idx + 1
        if (i === 2) reassign()
      }
      return out
    }`
  const { scan } = run(src, { optimize: 'speed' })
  is(scan(), jsEval(src).scan(), 'per-read derivation across the transitive reassignment stays bit-exact')
})

test('hoist-loop-global: the hoisted (sound) case still produces correct values', () => {
  // The positive shape the wat-probe pin (test/wat-invariants.js) checks
  // structurally — same source, checked here for VALUE correctness under
  // both the un-hoisted control and the hoisted default.
  const src = `
    export let idx = 0, cur = ''
    const ops = []
    const reg = (fn) => { ops.push(fn) }
    reg((x) => x + 1); reg((x) => x * 2)
    export let helper = (x) => { let y = x; for (let k = 0; k < 3; k++) y = y * 2 + 1; return y }
    export let warmup = () => helper(7)
    export let setup = (s) => { idx = 0; cur = s }
    export let scanThenDispatch = (mode, x) => {
      let cc = 0, acc = 0
      while ((cc = cur.charCodeAt(idx)) <= 32) { acc = helper(acc); idx = idx + 1 }
      if (mode) { let fn = ops[mode]; return fn ? fn(x) : cc }
      return acc + cc
    }
    export const main = () => { warmup(); setup('   hi there   '); return scanThenDispatch(1, 5) }`
  const jsExpected = jsEval(src).main()
  const { main: mainOff } = run(src, { optimize: { hoistLoopGlobalPtrOffset: false } })
  const { main: mainOn } = run(src, { optimize: 'speed' })
  is(mainOff(), jsExpected, 'un-hoisted control matches plain JS')
  is(mainOn(), jsExpected, 'hoisted (default) matches plain JS')
})
