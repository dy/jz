// Pre-eval tier 3 — module-init snapshotting (src/snapshot.js).
// The init runs ONCE at compile time; the artifact carries the post-init world:
// heap image as the data segment, post-init global values as initializers, no
// __start at all. Hermeticity is proven dynamically (throwing env stubs).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'

const SNAP = { level: 2, snapshotInit: true }

test('snapshot: init-built tables become pure data, __start is deleted', () => {
  const src = `
    const TABLE = new Float64Array(64)
    for (let i = 0; i < 64; i++) TABLE[i] = Math.sin(i * 0.1)
    const NAMES = { alpha: 1, beta: 2, gamma: 3 }
    let seq = 100
    export let probe = (i) => TABLE[i]
    export let name = () => NAMES.beta
    export let next = () => { seq = seq + 1; return seq }`
  const w = compile(src, { wat: true, optimize: SNAP })
  ok(!/\(start /.test(w), 'no start section')
  ok(!/func \$__start/.test(w), 'no __start function')
  ok(/global \$seq[\s\S]{0,40}i32\.const 100/.test(w), 'post-init global value baked as the initializer')
  const { exports: e } = jz(src, { optimize: SNAP })
  // reference = the UNSNAPSHOTTED module: the table holds jz's OWN sin values
  // (bespoke minimax, last-ulp different from host Math.sin) — behavioral identity
  // is the contract, not host-libm equality.
  const ref = jz(src, { optimize: 2 }).exports
  is(Number(e.probe(10)), Number(ref.probe(10)), 'init-built table content served from the data segment')
  is(Number(e.name()), 2, 'init-built dict probes')
  is(Number(e.next()), 101, 'runtime mutation from the baked base')
  is(Number(e.next()), 102)
})

test('snapshot: identical observable behavior vs the unsnapshotted module', () => {
  const src = `
    const LUT = []
    for (let i = 0; i < 10; i++) LUT.push(i * i)
    let acc = LUT[9]
    export let get = (i) => LUT[i]
    export let bump = (d) => { acc = acc + d; return acc }`
  const a = jz(src, { optimize: 2 }).exports
  const b = jz(src, { optimize: SNAP }).exports
  for (let i = 0; i < 10; i++) is(Number(b.get(i)), Number(a.get(i)))
  is(Number(b.bump(5)), Number(a.bump(5)))
  is(Number(b.bump(-3)), Number(a.bump(-3)))
})

test('snapshot: declines when init calls the host (hermeticity stubs throw)', () => {
  // console.log at top level = an env-import call during __start → probe throws →
  // snapshot declined; the module still compiles and runs exactly as without it.
  const src = `
    let x = 2
    console.log('init side effect')
    export let f = () => x * 21`
  const w = compile(src, { wat: true, optimize: SNAP })
  ok(/func \$__start|\(start /.test(w), 'start retained — snapshot declined, module intact')
  is(Number(jz(src, { optimize: SNAP }).exports.f()), 42, 'still compiles and runs')
})

test('snapshot: _clear warm semantics survive baking', () => {
  // The gsnap slab + heal state live INSIDE the baked image; a warm
  // compile-clear-compile loop must behave exactly as fresh.
  const src = `
    const CACHE = new Map()
    const memo = (k) => { let v = CACHE.get(k); if (v === undefined) { v = [k.length, 7]; CACHE.set(k, v) } return v[1] }
    export let churn = (n) => { let a = [n + 0.5, n * 2]; return a[0] }
    export let main = () => memo('warm-key-x')`
  const { exports: e } = jz(src, { optimize: SNAP })
  is(Number(e.main()), 7)
  e._clear()
  e.churn(9); e.churn(8)
  is(Number(e.main()), 7, 'healed entry rebuilds after _clear on a snapshotted module')
})
