// A receiver a loop never rebinds asks whether its block moved once before the
// loop and again after each of the runtime's cold calls in it that may move a
// block, a push's growth among them (optimize/forward-hops.js), not at every
// read; a loop that calls the program's own code keeps its hops. Each case here
// moves the block under the loop, by a push the loop makes into the array it
// reads, a call that grows or shifts it, a loop around, or a handler, and
// agrees with the host at every tier.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { levels, onKernel } from './_matrix.js'
import parseWat from 'watr/parse'
import { funcWat, oracle, wat } from './util.js'

const agrees = (src, label, args = []) => {
  const want = oracle(src).f(...args)
  for (const optimize of levels(0, 2, 3, 'speed', 'size')) is(jz(src, { optimize }).exports.f(...args), want, `${label} at ${optimize}`)
}

test('forward hops: a block moved under the loop is followed', () => {
  agrees(`const app = (dst, src, from, to) => { for (let k = from; k < to; k++) dst.push(src[k * 2], src[k * 2 + 1]) }
    export let f = () => { const a = [1, 2, 3, 4]; app(a, a, 0, 12); return a.length + ':' + a.join(',') }`, 'a push into the array the loop reads')
  agrees(`export let f = () => { const xs = [1, 2, 3, 4]; const grow = () => { for (let j = 0; j < 7; j++) xs.push(j) }
    let s = 0; for (let i = 0; i < 30; i++) { s += xs[i] * (i + 1); if (i % 4 === 0) grow() } return s + ':' + xs.length }`, 'a call growing the array read')
  agrees(`export let f = () => { const xs = []; for (let i = 0; i < 40; i++) xs.push(i); const cut = () => { xs.shift(); return 1 }
    let s = 0; for (let i = 0; i < 20; i++) s += xs[i] * cut(); return s + ':' + xs.length }`, 'a call shifting the array read')
  agrees(`export let f = () => { const polys = [[1, 2], [3, 4, 5]]; let s = 0
    for (let r = 0; r < 4; r++) { const p = polys[r % 2]; for (let i = 0; i < p.length; i++) { s += p[i]; if (i === 1) p.push(r) } }
    return s + ':' + polys[0].length + ':' + polys[1].length }`, 'nested loops, the inner growing what it reads')
  agrees(`export let f = (n) => { const xs = [1, 2, 3]; let v = n > 0 ? xs : n; let s = 0
    for (let i = 0; i < 3; i++) { if (Array.isArray(v)) s += v[i]; xs.push(i) } return s + ':' + xs.length }`, 'a receiver that is no array', [0])
  agrees(`export let f = (n) => { const xs = [1, 2, 3]; let v = n > 0 ? xs : n; let s = 0
    for (let i = 0; i < 3; i++) { if (Array.isArray(v)) s += v[i]; xs.push(i) } return s + ':' + xs.length }`, 'the same receiver an array', [1])
  agrees(`export let f = () => { const xs = [1, 2, 3, 4]; let s = 0
    const g = (i) => { for (let j = 0; j < 9; j++) xs.push(j); if (i % 2) throw new Error('x'); return i }
    for (let i = 0; i < 8; i++) { try { s += g(i) } catch (e) { s += xs[i + 4] } s += xs[i] } return s + ':' + xs.length }`, 'a handler reading what the call moved')
})

// The kernel: a helper appending a range of one array to another. Its loop
// reads `src` twice a pass and pushes into `dst`; `src`'s hop is a local set
// before the loop and after the growth call, no read in the loop asks.
test('forward hops: a source read while pushing asks before the loop', () => {
  if (onKernel()) return  // kernel WAT shape differs; the in-process leg owns shape checks
  const src = `const app = (dst, src, from, to) => { for (let k = from; k < to; k++) dst.push(src[k * 2], src[k * 2 + 1]) }
    const s = []; for (let i = 0; i < 24; i++) s.push(i * 0.5, -i)
    export let f = (n) => { const a = []; app(a, s, 0, n); app(a, s, 2, n); return a.length + a[5] }`
  const body = funcWat(wat(src, { optimize: 'speed' }), 'app')
  ok(/\$__fh\d+/.test(body), 'the hop is a local of the loop')
  // a hop: `(if (result i32) (i32.eq (i32.load A) (i32.const -1)) (then (call $__ptr_offset_fwd …)) …)`
  const isHop = n => n[0] === 'if' && Array.isArray(n[2]) && n[2][0] === 'i32.eq' && Array.isArray(n[2][1]) && n[2][1][0] === 'i32.load' &&
    Array.isArray(n[2][2]) && n[2][2][0] === 'i32.const' && Number(n[2][2][1]) === -1
  const find = (n, pred, out = []) => { if (Array.isArray(n)) { if (pred(n)) out.push(n); for (let i = 1; i < n.length; i++) find(n[i], pred, out) } return out }
  const innermost = find(parseWat(body), n => n[0] === 'loop' && find(n.slice(1), m => m[0] === 'loop').length === 0)
  ok(innermost.length > 0, 'the function keeps its loop')
  for (const l of innermost) is(find(l, isHop).length, 0, `no hop inside ${l[1]}`)
  const want = oracle(src).f(20)
  for (const optimize of levels(2, 'speed', 'size')) is(jz(src, { optimize }).exports.f(20), want, `f(20) at ${optimize}`)
})
