// A receiver a loop never rebinds asks whether its block moved once before the
// loop and again after each of the runtime's cold calls in it that may move a
// block, a push's growth among them (optimize/forward-hops.js), not at every
// read; a loop that calls the program's own code keeps its hops. Each case here
// moves the block under the loop, by a push the loop makes into the array it
// reads, a call that grows or shifts it, a loop around, or a handler, and
// agrees with the host at every tier.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels, onKernel } from './_matrix.js'
import parseWat from 'watr/parse'
import { funcWat, oracle, wat, jz } from './util.js'

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

// The immutable-update step (emit-assign.js tryStructInlineReplaceStore writes
// each record into the cells it had) with a push on a rare path into a module
// array: the push allocates and escapes, so the loop keeps the compaction of
// what it keeps (optimize/loop-compact.js), whose site forwards every root it
// reads and re-enters the loop past the set before it. A root the loop never
// writes holds what it held before the loop, below the floor no compaction
// moves: the forward hands it back as it was, and its hop is the loop's to
// hoist. The push's lowering of the flag writes the log, never a block.
test('forward hops: a loop that compacts asks for its receiver\'s hop as the compaction re-enters it', () => {
  const src = `const init = () => { const ps = []; let s = 0x1234abcd | 0
      for (let i = 0; i < 64; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const vx = ((s >>> 4) & 15) - 8, vy = ((s >>> 8) & 15) - 8
        ps.push({ x: (s >>> 12) & 1023, y: (s >>> 20) & 1023, vx: (vx === 0 ? 1 : vx) | 0, vy: (vy === 0 ? 1 : vy) | 0 }) }
      return ps }
    const log = []
    const step = (ps) => { let sum = 0
      for (let it = 0; it < 8; it++) for (let i = 0; i < 64; i++) {
        const p = ps[i]
        const nx = (p.x + p.vx) | 0, ny = (p.y + p.vy) | 0
        const hitX = nx < 0 || nx > 1023, hitY = ny < 0 || ny > 1023
        const x = hitX ? p.x : nx, y = hitY ? p.y : ny
        const vx = hitX ? -p.vx | 0 : p.vx, vy = hitY ? -p.vy | 0 : p.vy
        ps[i] = { x: x, y: y, vx: vx, vy: vy }
        sum = (sum + x + Math.imul(y, 31)) | 0
        if ((sum & 4095) === 7) log.push([it, i]) }
      return sum + log.length }
    export let main = () => step(init())`
  const want = oracle(src).main()
  for (const optimize of levels(0, 2, 3, 'speed', 'size')) is(jz(src, { optimize }).exports.main(), want, `main() at ${optimize}`)
  if (onKernel()) return  // kernel WAT shape differs; the in-process leg owns shape checks
  // before watr, which inlines the step into the export; the compaction is the JS host's
  // (module/core/stub-log.js compactOn), so the shape is read there
  const body = funcWat(wat(src, { optimize: { level: 'speed', watr: false }, host: 'js' }), 'step')
  ok(/call \$__gc_begin/.test(body), 'the loop compacts what its rare arm keeps')
  ok(/\$__fh\d+/.test(body), 'the hop is a local of the loop')
  const isHop = n => n[0] === 'if' && Array.isArray(n[2]) && n[2][0] === 'i32.eq' && Array.isArray(n[2][1]) && n[2][1][0] === 'i32.load' &&
    Array.isArray(n[2][2]) && n[2][2][0] === 'i32.const' && Number(n[2][2][1]) === -1
  const find = (n, pred, out = []) => { if (Array.isArray(n)) { if (pred(n)) out.push(n); for (let i = 1; i < n.length; i++) find(n[i], pred, out) } return out }
  const loops = find(parseWat(body), n => n[0] === 'loop' && find(n.slice(1), m => m[0] === 'loop').length === 0)
  ok(loops.length > 0, 'the step keeps its loop')
  for (const l of loops) is(find(l, isHop).length, 0, `no hop inside ${l[1]}`)
})

// A hop is asked once between calls that may move a block: the first tees its
// answer, a later one of the receiver on every path after it reads the local.
// A loop with an indirect call, which keeps its hops from hoisting, asks once a
// pass however many slots it reads, of a module global as of a local; a call
// between two reads, an arm that asks alone and a store of the global ask again.
test('forward hops: a receiver asks once between calls that may move its block', () => {
  agrees(`let q = [1, 2, 3, 4]
    const fs = [(n) => { for (let j = 0; j < n; j++) q.push(j) }, (n) => { q = [9, 8, 7, 6, 5] }, (n) => n]
    export let f = () => { let s = 0
      for (let i = 0; i < 9; i++) { const a = q[i % 4], b = q[(i + 1) % 4]; fs[i % 3](5); s += a * 10 + b + q[i % 3] }
      return s + ':' + q.length }`, 'an indirect call moving and rebinding the global between reads')
  agrees(`let q = [1, 2, 3, 4]
    const grow = () => { for (let j = 0; j < 9; j++) q.push(j) }
    export let f = (n) => { let s = q[0]; if (n > 0) { s += q[1]; grow() } else s += q[2]; s += q[3] * 2; grow(); return s + q[4] + ':' + q.length }`, 'an arm that moves it', [1])
  agrees(`let q = [1, 2, 3, 4]
    const swap = () => { q = [5, 6, 7, 8] }
    export let f = (n) => { const a = q[0]; if (n) swap(); return a + q[1] }`, 'a call that rebinds the global and moves nothing', [1])
  agrees(`export let f = () => { const xs = [1, 2, 3, 4]; let s = 0
    const g = () => { for (let j = 0; j < 9; j++) xs.push(j); throw new Error('x') }
    s += xs[0]; try { s += xs[1]; g() } catch (e) { s += xs[2] } return s + xs[3] + ':' + xs.length }`, 'a handler reached from past a move')
  if (onKernel()) return  // kernel WAT shape differs; the in-process leg owns shape checks
  const src = `let q = []
    const run = () => { let i = 0, s = 0; while (i < q.length) { const h = q[i], a = q[i + 1], b = q[i + 2]; i += 3; s += h(a, b) } return s }
    export let f = (n) => { for (let k = 0; k < n; k++) q.push((a, b) => a + b, k, 1); return run() }`
  const body = funcWat(wat(src, { optimize: { level: 'speed', watr: false }, host: 'js' }), 'run')
  const isHop = n => n[0] === 'if' && Array.isArray(n[2]) && n[2][0] === 'i32.eq' && Array.isArray(n[2][1]) && n[2][1][0] === 'i32.load' &&
    Array.isArray(n[2][2]) && n[2][2][0] === 'i32.const' && Number(n[2][2][1]) === -1
  const find = (n, pred, out = []) => { if (Array.isArray(n)) { if (pred(n)) out.push(n); for (let i = 1; i < n.length; i++) find(n[i], pred, out) } return out }
  const loops = find(parseWat(body), n => n[0] === 'loop')
  is(loops.length, 1, 'the function keeps its loop')
  is(find(loops[0], isHop).length, 1, 'one hop a pass, four reads')
  ok(/call_indirect/.test(body), 'the job is called through the table')
  const want = oracle(src).f(40)
  for (const optimize of levels(2, 'speed', 'size')) is(jz(src, { optimize }).exports.f(40), want, `f(40) at ${optimize}`)
})
