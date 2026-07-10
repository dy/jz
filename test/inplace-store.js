/**
 * In-place replace-store (src/compile/inplace-store.js + emit-assign arm):
 * `arr[i] = {lit}` at a sweep-proven site overwrites the old element's slots
 * instead of allocating a fresh object per step — the immutable-update idiom's
 * allocation churn goes to zero.
 *
 * Pins here guard the two directions:
 *   - FIRES on the clean kernel shape (structural: the masked schema-guard
 *     compare appears; behavioral: results bit-match plain JS).
 *   - Does NOT fire when an alias could observe the overwrite — a saved
 *     element alias read after the store, an element leaked out of the array,
 *     or a `for…of` element binding. These run differentially so semantics
 *     are pinned even if gating logic changes.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { run } from './util.js'

// the immutable-bench kernel shape, parameterized so each test gets a fresh module
const KERNEL = `
const init = () => {
  const ps = []
  let s = 0x1234abcd | 0
  for (let i = 0; i < 64; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    const vx = ((s >>> 4) & 15) - 8, vy = ((s >>> 8) & 15) - 8
    ps.push({ x: (s >>> 12) & 1023, y: (s >>> 20) & 1023, vx: (vx === 0 ? 1 : vx) | 0, vy: (vy === 0 ? 1 : vy) | 0 })
  }
  return ps
}
const step = (ps) => {
  let sum = 0
  for (let it = 0; it < 8; it++) {
    for (let i = 0; i < 64; i++) {
      const p = ps[i]
      const nx = (p.x + p.vx) | 0, ny = (p.y + p.vy) | 0
      const hitX = nx < 0 || nx > 1023, hitY = ny < 0 || ny > 1023
      const x = hitX ? p.x : nx, y = hitY ? p.y : ny
      const vx = hitX ? -p.vx | 0 : p.vx, vy = hitY ? -p.vy | 0 : p.vy
      ps[i] = { x: x, y: y, vx: vx, vy: vy }
      sum = (sum + x + Math.imul(y, 31)) | 0
    }
  }
  return sum
}
export let main = () => step(init())`

const jsEval = (src) => {
  const exports = {}
  new Function('exports', src.replace(/export let (\w+) =/g, 'exports.$1 =').replace(/export const (\w+) =/g, 'const $1 = exports.$1 ='))(exports)
  return exports
}

test('inplace-store: fires on the immutable-update kernel and bit-matches JS', () => {
  const wat = jz.compile(KERNEL, { wat: true, optimize: 'speed' })
  // The transform's signature, either strength: the masked OBJECT|sid runtime
  // guard, or — when the tracked alias is ptr-narrowed to this schema — the
  // statically-discharged raw form, whose tell is the step loop allocating
  // NOTHING (`__alloc_hdr` appears only in init's push, never in `step`).
  const stepBody = wat.split(/\(func /).find(c => /^\$step\b/.test(c)) || ''
  ok(/0xFFFFFFFF00000000|i64.const -4294967296/.test(wat) || (stepBody && !/__alloc_hdr/.test(stepBody)),
    'in-place fast path emitted (guarded or statically discharged)')
  ok(stepBody === '' || !/__alloc_hdr/.test(stepBody), 'step loop allocates nothing')
  const { main } = run(KERNEL, { optimize: 'speed' })
  is(main(), jsEval(KERNEL).main(), 'stepped sums bit-match plain JS')
})

test('inplace-store: loop-invariant array base hoists out of the step loop', () => {
  // The in-place store's re-boxed result is a $__mkptr call — pure bit-packing.
  // With it whitelisted (NON_MUTATING_CALLS), hoistInvariantLoop lifts the
  // `__ptr_offset(ps)` base resolution to the loop preheader: the inner loop
  // body must not re-resolve the array base per iteration.
  const wat = jz.compile(KERNEL, { wat: true, optimize: 'speed' })
  const stepBody = wat.split(/\(func /).find(c => /^\$step\b/.test(c)) || ''
  ok(stepBody, 'step function present')
  const innerLoop = stepBody.slice(stepBody.lastIndexOf('(loop '))
  ok(!/call \$__ptr_offset\b/.test(innerLoop),
    'inner loop body re-resolves no array base (hoisted to preheader)')
})

test('inplace-store: alias read AFTER the store keeps fresh-object semantics', () => {
  // `p` is read after ps[i] is replaced: with a fresh object p.x is the OLD x;
  // in-place would show the NEW x. The sweep must reject this site.
  const src = `
  const mk = () => { const ps = []; for (let i = 0; i < 4; i++) ps.push({ x: i + 1, y: i + 2 }); return ps }
  export let main = () => {
    const ps = mk()
    let acc = 0
    for (let i = 0; i < 4; i++) {
      const p = ps[i]
      ps[i] = { x: (p.x * 10) | 0, y: p.y }
      acc = (acc + p.x) | 0   // old element read AFTER the replace
    }
    return acc
  }`
  const { main } = run(src, { optimize: 'speed' })
  is(main(), jsEval(src).main(), 'post-store alias reads the pre-store values')
})

test('inplace-store: element leaked out of the array disables the transform', () => {
  // ps[0] escapes into `kept` before the loop: with fresh objects kept.x stays
  // 1 forever; in-place would mutate it. Differential pin.
  const src = `
  const mk = () => { const ps = []; for (let i = 0; i < 4; i++) ps.push({ x: i + 1, y: i + 2 }); return ps }
  export let main = () => {
    const ps = mk()
    const kept = ps[0]
    for (let i = 0; i < 4; i++) {
      const p = ps[i]
      ps[i] = { x: (p.x * 10) | 0, y: p.y }
    }
    return (kept.x * 1000 + ps[0].x) | 0
  }`
  const { main } = run(src, { optimize: 'speed' })
  is(main(), jsEval(src).main(), 'leaked element keeps its pre-store values')
})

test('inplace-store: alien-schema element at runtime takes the generic arm', () => {
  // ps[2] is replaced with a DIFFERENT shape before the kernel loop — the
  // in-place guard must fail for it at runtime and fall back bit-exactly.
  const src = `
  const mk = () => { const ps = []; for (let i = 0; i < 4; i++) ps.push({ x: i + 1, y: i + 2 }); return ps }
  export let main = () => {
    const ps = mk()
    ps[2] = { x: 100, y: 200, z: 300 }
    let acc = 0
    for (let i = 0; i < 4; i++) {
      const p = ps[i]
      ps[i] = { x: (p.x + 1) | 0, y: p.y }
      acc = (acc + ps[i].x) | 0
    }
    return acc
  }`
  const { main } = run(src, { optimize: 'speed' })
  is(main(), jsEval(src).main(), 'mixed-schema array stays bit-exact')
})
