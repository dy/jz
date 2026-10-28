// Array.prototype.push and its kin. At the speed tier a push stores in place
// where its block has room, the growth a call (module/array.js, the `.push`
// emitter's in-place arm); every tier evaluates the arguments before it reads
// the length (23.1.3.23), so a value that grows, shifts or shortens the
// receiver lands where JS puts it.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels, onKernel } from './_matrix.js'
import { funcWat, oracle, wat } from './util.js'

const agrees = (src, label, args = []) => {
  const want = oracle(src).f(...args)
  for (const optimize of levels(0, 2, 3, 'speed', 'size')) {
    const got = jz(src, { optimize }).exports.f(...args)
    is(got, want, `${label} at ${optimize}`)
  }
}

test('push: an argument that changes the receiver runs before the push reads its length', () => {
  agrees(`export let f = () => { const a = [0]; a.push(a.push(5)); return a.join(',') }`, 'one value pushing first')
  agrees(`export let f = () => { const a = [0]; a.push(a.push(5), a.length); return a.join(',') }`, 'two values, the first pushing')
  agrees(`export let f = () => { const a = [1, 2, 3, 4]; const g = () => { for (let i = 0; i < 9; i++) a.push(i); return 7 }; a.push(g()); return a.join(',') }`,
    'a call growing the receiver past its block')
  agrees(`export let f = () => { const a = [1, 2, 3, 4]; const g = () => { for (let i = 0; i < 9; i++) a.push(i); return 7 }; a.push(g(), 8); return a.join(',') }`,
    'a growing call among two values')
  agrees(`export let f = () => { const a = [1, 2, 3]; const g = () => { a.length = 1; return 9 }; a.push(g()); return a.join(',') }`,
    'a call shortening the receiver')
  agrees(`export let f = () => { const a = [1, 2, 3, 4, 5]; const g = () => { a.shift(); a.shift(); return 6 }; a.push(g(), 7); return a.join(',') }`,
    'a call shifting the receiver')
})

test('push: a stale or shifted receiver reaches the live block', () => {
  agrees(`export let f = () => { const a = []; const b = a; for (let i = 0; i < 20; i++) b.push(i); a.push(99); return a.length + ':' + b.length + ':' + a[20] + ':' + (a === b) }`,
    'an alias grown elsewhere')
  agrees(`export let f = () => { const a = []; const b = a; for (let i = 0; i < 20; i++) b.push(i, -i); a.push(99, 98); return a.length + ':' + a[41] + ':' + (a === b) }`,
    'an alias grown elsewhere, two values')
  agrees(`export let f = () => { const a = [1, 2, 3, 4, 5, 6]; a.shift(); a.shift(); for (let i = 0; i < 10; i++) a.push(i); return a.join(',') }`,
    'a shifted receiver')
  agrees(`export let f = () => { const a = [1, 2, 3, 4, 5, 6]; const b = a; b.shift(); a.push(7); b.push(8, 9); a.shift(); return a.join(',') + '|' + b.join(',') }`,
    'a shifted receiver through an alias')
  agrees(`const app = (d, n) => { for (let i = 0; i < n; i++) d.push(i * 2, i * 2 + 1) }
    export let f = () => { const a = []; app(a, 3); a.push(-1); app(a, 9); return a.length + ':' + a.join(',') }`,
    'a parameter growing the caller\'s array')
  agrees(`export let f = () => { const o = { xs: [] }; for (let i = 0; i < 12; i++) o.xs.push(i); const ys = o.xs; o.xs.push(100); return o.xs.length + ':' + ys.length + ':' + ys[12] }`,
    'a field receiver')
  agrees(`export let f = () => { const pts = []; for (let k = 0; k < 9; k++) pts.push([k, k * 2]); let s = 0; for (const p of pts) s += p[0] * 10 + p[1]; return s + ':' + pts.length }`,
    'points pushed as fresh pairs')
  agrees(`export let f = () => { const a = []; let s = 0; for (let i = 0; i < 10; i++) s += a.push(i) + a.push(i, i); return s }`,
    'the lengths pushes answer')
})

test('push: an index store at the length appends; past it, holes', () => {
  agrees(`const fill = (out, src, n) => { for (let k = 0; k < n; k++) out[k] = src[k] * 2; return out }
    export let f = () => { const s = []; for (let i = 0; i < 30; i++) s.push(i); const o = fill([], s, 30); return o.length + ':' + o.join(',') }`, 'a parameter filled from zero')
  agrees(`export let f = () => { const a = []; a[0] = 1; a[3] = 4; a[1] = 2; a[4] = 5; return a.length + ':' + a.join(',') + ':' + (2 in a) }`, 'holes past the length')
  agrees(`export let f = () => { const a = []; let n = 0; for (let i = 0; i < 40; i++) if (i % 3) a[n++] = i; return n + ':' + a.length + ':' + a[n - 1] }`, 'a counter at the length')
  agrees(`export let f = () => { const a = [1]; const b = a; for (let i = 1; i < 25; i++) a[i] = i; b[b.length] = 99; return a.length + ':' + b[25] + ':' + (a === b) }`, 'an alias across growth')
  agrees(`export let f = () => { const a = [1, 2, 3, 4]; a.shift(); for (let i = 0; i < 9; i++) a[a.length] = i * 10; return a.join(',') }`, 'a shifted array')
})

// The calls an append makes, counted (`helperCounters`): growth alone, a few
// doublings for a hundred appends, where each append called the grow helper.
test('push: appends call only to grow', async () => {
  if (onKernel()) return  // kernel WAT shape differs; the in-process leg owns shape checks
  const counts = async (src, n) => {
    const { instance } = await WebAssembly.instantiate(jz.compile(src, { optimize: 'speed', helperCounters: true, alloc: false }))
    const e = instance.exports
    e.__helper_counts_reset()
    const r = e.f(n)
    return { r, grow: Number(e.__hc_arr_grow.value), known: Number(e.__hc_arr_grow_known.value), push1: Number(e.__hc_arr_push1.value) }
  }
  const index = `export let f = (n) => { const a = []; let k = 0; while (k < n) { a[k] = k * 3; k = k + 1 + (k > n) } return a.length + a[n - 1] }`
  const c1 = await counts(index, 100)
  is(c1.r, oracle(index).f(100), 'index appends agree')
  ok(c1.grow <= 6, `index appends: ${c1.grow} grow calls for 100`)
  const push = `export let f = (n) => { const a = []; let k = 0; while (k < n) { a.push(k * 3); k = k + 1 + (k > n) } return a.length + a[n - 1] }`
  const c2 = await counts(push, 100)
  is(c2.r, oracle(push).f(100), 'pushes agree')
  ok(c2.push1 === 0 && c2.known <= 6, `pushes: ${c2.push1} push calls, ${c2.known} grow calls for 100`)
})

// A module without the host allocator (`alloc: false`) bumps the same heap
// global, so an array at the heap top extends in place there too, at the
// speed tier; the size tier keeps the relocation alone (its bytes).
test('push: an array at the heap top grows in place without the host allocator', () => {
  if (onKernel()) return  // kernel: host {alloc:false} option doesn't reach the single-source self-compile
  const src = `export let f = (n) => { const a = [], b = a; while (n > 1) { a.push(n); n = n % 2 ? 3 * n + 1 : n / 2 } return a.length * 1000 + b.length + (a === b ? 0.5 : 0) + b[b.length - 1] }`
  // (the growth helpers the module keeps: watr may splice one into its one caller)
  const grows = (optimize) => { const w = wat(src, { optimize, alloc: false }); return ['__arr_room', '__arr_grow_known', '__arr_push1'].map(n => funcWat(w, n)).join('') }
  ok(/\$__heap_reset\b/.test(grows('speed')), 'speed: the grow extends a block at the heap top')
  ok(!/\$__heap_reset\b/.test(grows('size')), 'size: the grow relocates')
  const want = oracle(src).f(27)
  for (const optimize of levels(0, 2, 'speed', 'size')) is(jz(src, { optimize, alloc: false }).exports.f(27), want, `f(27) at ${optimize}, alloc: false`)
})

// The kernel: a fresh array a loop pushes into as many times as the data
// says (no count it could reserve is proven). Its hot path stores in place;
// only the arm the block is full in calls (`__arr_room`). The size tier keeps
// one call per push site (`__arr_push1`; two sites, so watr keeps it a call).
test('push: a push loop stores in place at the speed tier', () => {
  if (onKernel()) return  // kernel WAT shape differs; the in-process leg owns shape checks
  const src = `export let f = (n) => { const a = [], b = []; while (n > 1) { if (n % 2) { a.push(n); n = 3 * n + 1 } else { b.push(n); n = n / 2 } } return a.length * 1000 + b.length + a[a.length - 1] }`
  const speed = wat(src, { optimize: 'speed' })
  ok(/\$__arr_room\b/.test(funcWat(speed, 'f')) && !/\$__arr_push1\b/.test(speed), 'speed: in place, the growth out of line')
  const size = wat(src, { optimize: 'size' })
  ok(/\$__arr_push1\b/.test(size) && !/\$__arr_room\b/.test(size), 'size: one call per push')
  const want = oracle(src).f(100)
  for (const optimize of levels(2, 'speed', 'size')) is(jz(src, { optimize }).exports.f(100), want, `f(100) at ${optimize}`)
})
