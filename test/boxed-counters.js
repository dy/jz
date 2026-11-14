// Integers a loop writes itself, held as words of a copy while a box holds them
// (src/compile/plan/integral-loops.js): each program answers what Node answers at
// every level, at the inputs for which a word answers otherwise, and a loop shaped
// as rfft's butterflies keeps its index locals in integer registers. The inputs are
// rfft's (examples/rfft): `id *= 4` leaves the word for n >= 2^31 - 1, `i0 += id`
// for n >= 3 * 2^29 - 1, the stage loops' `ix = (id << 1) - n2` for n >= 2^29, a
// counter at 2^31; and the box's own edges, where the copy is left mid-loop.
// Each loop carries a cap on its trips where Node itself would not end. The box is a
// tier above what the planner builds with no box, never in its place: where its guard
// fails, the copy with no box runs, or the loop as the planner left it.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { readFileSync } from 'node:fs'
import { run, oracle, jz, compileInProcess } from './util.js'
import { levels, belowOpt } from './_matrix.js'
import { parse, walk, has, head } from '../scripts/wat-probe.mjs'
import { ctx } from '../src/ctx.js'
import { walkAst } from '../src/ast.js'

const EDGES = [0, 1, 2, 7, 8, 8.5, -4, -0, NaN, 2 ** 26, 2 ** 28 - 1, 2 ** 28, 2 ** 29 - 1, 2 ** 29, 2 ** 29 + 1,
  805306368, 1073741823, 1073741824, 1610612734, 1610612735, 2 ** 31 - 2, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53, 1e12, Infinity]
// (a function's body as the planner leaves it, and a count of its nodes)
const planned = (src, name) => { compileInProcess(src, { optimize: 'speed' }); return ctx.funcs.list.find(f => f.name === name)?.body }
const count = (node, pred) => { let k = 0; walkAst(node, { enter: n => { if (pred(n)) k++ } }); return k }
// (each level against a fresh instance of Node's: the programs keep their arrays between calls)
const compare = (source, inputs, name = 'f') => {
  for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) {
    const actual = run(source, { optimize }), expected = oracle(source)
    for (const args of inputs) is(actual[name](...args), expected[name](...args), `${JSON.stringify(optimize)}: ${args.join(', ')}`)
  }
}

test('boxed counters: the first pass of rfft, a geometric stride and the counter it bounds', () => {
  // `geo`: id alone, its index a store past the end once it leaves the array
  compare(`const x = new Float64Array(8)
export let f = (n) => {
  let ix = 0, id = 4, outer = 0
  while (ix < n) { x[id] = x[ix] + 1; ix = 2 * (id - 1); id *= 4; if (++outer > 600) break }
  return [outer, ix, id]
}`, EDGES.map(n => [n]))
  // `first`: the nest, its inner loop capped once it has run 64 times in all
  compare(`const x = new Float64Array(8)
export let f = (n) => {
  let N = n
  let ix = 0, id = 4, outer = 0, inner = 0, last = 0
  while (ix < N) {
    let i0 = ix
    while (i0 < N) { inner++; last = i0; x[i0 + 1] = x[i0] + 1; i0 += id; if (inner > 64) break }
    ix = 2 * (id - 1)
    id *= 4
    if (++outer > 600) break
  }
  return [outer, inner, last, ix, id]
}`, EDGES.map(n => [n]))
})

test('boxed counters: the stage loops of rfft, a stride by shifts and an index a difference of two words', () => {
  // (Node runs on forever from n = 2^29, where `id << 1` wraps: the caps end it)
  compare(`const x = new Float64Array(8)
export let f = (n) => {
  let n2 = 2, nn = n >>> 1, stages = 0, last = 0, inner = 0, rounds = 0
  while ((nn = nn >>> 1)) {
    n2 = n2 << 1
    let ix = 0, id = n2 << 1
    while (ix < n) {
      let i0 = ix
      while (i0 < n) { inner++; last = i0; x[i0 + 1] = x[i0] + 1; i0 += id; if (inner > 64) break }
      ix = (id << 1) - n2
      id = id << 2
      if (++rounds > 2000) break
    }
    stages++
  }
  return [stages, n2, last, inner, rounds]
}`, EDGES.filter(n => !(Math.abs(n) >= 2 ** 63)).map(n => [n]))
})

test('boxed counters: a module bound, as rfft reads N', () => {
  const src = `let N = 0; const x = new Float64Array(64)
export let set = (n) => { N = n }
export let f = () => {
  let ix = 0, id = 4, inner = 0, rounds = 0
  while (ix < N) {
    let i0 = ix
    while (i0 < N) { x[i0 + 1] = x[i0] + 1; i0 += id; if (++inner > 64) break }
    ix = 2 * (id - 1); id *= 4
    if (++rounds > 600) break
  }
  return [ix, id, inner, rounds, x[1], x[5]]
}`
  for (const optimize of levels(0, 1, 2, 3, 'size', 'speed')) {
    const actual = run(src, { optimize }), expected = oracle(src)
    for (const n of EDGES) { actual.set(n); expected.set(n); is(actual.f(), expected.f(), `${JSON.stringify(optimize)}: N = ${n}`) }
  }
})

test('boxed counters: a held integer left at a head, the loop as written resuming', () => {
  // the box's edge inside the loop: `q` doubles past 2^k - 1 while the loop's test, on `i`,
  // still holds, so the copy leaves at that head and the loop as written runs on from the
  // state it wrote back (`i` steps by a name: no counter copy takes the loop first)
  compare(`const a = new Float64Array(16)
export let f = (s, st, n) => {
  let i = 0, q = s, t = 0
  while (i < n) { a[q] += 1; t = t + a[1]; q = q * 2 + 1; i = i + st }
  return [i, q, t, a[1], a[3], a[15]]
}`, [[0, 1, 10], [0, 1, 40], [0, 1, 64], [5, 1, 31], [5, 2, 61], [2 ** 29, 1, 3], [2 ** 30 - 1, 1, 2], [2 ** 30, 1, 2], [-3, 1, 5], [0.5, 1, 4],
    [NaN, 1, 3], [0, 1, NaN], [-0, 1, 6], [0, 1, 0.5], [0, 1, -1], [0, 0.5, 3], [0, 2 ** 29, 2 ** 30]])
  // a stride by a name the loop does not write, of any sign; a start of any size
  compare(`const a = new Float64Array(16)
export let f = (s, st, n) => {
  let i = s, c = 0, last = 0
  while (i < n) { a[i] = c; last = i; i += st; if (++c > 50) break }
  return [i, last, c, a[0], a[3]]
}`, [[0, 1, 10], [0, 3, 2 ** 31], [2 ** 31 - 3, 1, 2 ** 31 + 3], [2 ** 31 - 3, 2, 2 ** 31 - 1], [0, 2 ** 30, 2 ** 32], [0, 2 ** 29, 2 ** 31 - 1],
    [0, -1, 5], [0, 0, 5], [-(2 ** 31), 1, -(2 ** 31) + 4], [0, 0.5, 4], [0, NaN, 4], [3.5, 1, 9], [0, 2 ** 31, 2 ** 33], [-0, 1, 3]])
})

test('boxed counters: the bound or the stride written in the body, a continue, a break', () => {
  compare(`const a = new Int32Array(32)
export let f = (s, st, n) => {
  let i = s, m = n, c = 0, skipped = 0
  while (i < m) {
    if (++c > 60) break
    if ((c & 3) === 0) { i += st; skipped++; continue }
    a[i] = c
    if (i > 2147483000) { m = m - st }
    i = i + st
    if (st > 1000) st = st * 2
  }
  return [i, m, c, skipped, a[0], a[7]]
}`, [[0, 1, 40], [2147482990, 3, 2147483660], [0, 1001, 2 ** 31], [0, 2 ** 28, 2 ** 31 + 1], [5, 7, 4], [0, -1, 3], [0, 0, 9]])
})

test('boxed counters: a -0 among the names of the box is no word of it', () => {
  // A name the copy reads as written (a local every write of which is a literal, a bit operation or
  // a length) lies in the box by comparison where it is -0, and the proof reads a name of the box as
  // no -0: `(i + 1) * z` was a word of the copy, +0, at levels 2 and over, where the product is -0
  // (ECMA-262, Number::multiply: a product's sign is negative where the operands' signs differ, a
  // zero's among them). Such a name is tested for -0 as an alias is. `1 / i` tells the zeros apart.
  // Expected values are Node's.
  const DECL = {
    'a literal': 'const z = -0',
    'a product of literals': 'const z = 0 * -1',
    'a minimum of two zeros': 'const z = Math.min(0, -0)',
    'one arm of a choice': 'const z = t > 1 ? -0 : 5',
    'a local of a local': 'const z0 = -0, z = z0',
    'a second write': 'let z = 3\n  z = -0',
    'the parameter': 'const z = t',
    'a module constant': '',
  }
  for (const [name, decl] of Object.entries(DECL)) compare(`${decl ? '' : 'const z = -0\n'}const x = new Float64Array(8)
export let f = (n, s, t) => {
  let i = s, c = 0
  ${decl}
  while (i < n) { if (++c > 44) break; x[i] = c; i = (i + 1) * z }
  return [c, i, 1 / i, x[0], x[1]]
}`, [[1, 0, 1], [8, 0, 2], [40, 3, 1], [2 ** 30, 5, 2], [0, 0, 1], [8, -1, 1], [8, -0, 3], [NaN, 0, 1], [8, 0, -0], [8, 1, 0], [8, 2, -1]])
})

test('boxed counters: rfft answers what Node answers, its index locals words of the copy', () => {
  const src = readFileSync(new URL('../examples/rfft/rfft.js', import.meta.url), 'utf8')
  for (const optimize of levels(2, 'speed')) {
    const actual = run(src, { optimize }), expected = oracle(src)
    for (const n of [8, 64, 2048]) {
      const fill = (v) => { for (let i = 0; i < v.length; i++) v[i] = Math.sin(i * 0.37) + 0.25 * Math.cos(i * 1.9) }
      fill(actual.init(n)); fill(expected.init(n))
      actual.rfft(); expected.rfft()
      const a = actual.spectrum(), b = expected.spectrum()
      let worst = 0
      for (let i = 0; i < b.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
      ok(worst < 1e-9, `${JSON.stringify(optimize)}: the spectrum of ${n} points within 1e-9 (${worst})`)
    }
  }
  // the butterflies of every stage compare and index in integer registers: loops that store
  // elements with no floating comparison and no conversion of a counter
  const tree = parse(src, 'speed')
  let words = 0
  walk(tree, n => { if (n[0] === 'loop' && has(n, head(/^f64\.store$/)) && has(n, head(/^i32\.(lt|ge)_s$/)) && !has(n, head(/^f64\.(lt|le|gt|ge)$|^f64\.convert_i32|trunc_sat_f64/))) words++ })
  // (4 of 39 before the box, the bit reversal's and init's; 24 of 61 with it, its copies' butterflies)
  ok(words >= 16, `butterfly loops in words: ${words}`)
})

test('boxed counters: a product of a name the box holds stable is a word of the copy', () => {
  // `W` the loop reads and never writes: aliased and tested into the box once. The walk read it as
  // the box's whole range, the literal [0, top]: under `y < H`, `y * W` came to `(H - 1) * top`, a
  // test no height above 3 passes (top 2^30 - 1), and the copy never ran (penrose's `px[y * W + x]`); over the box
  // alone, to `top * top`, past the word, and the index stayed a Number. The name reads as its own
  // value now: `W * min(n - 1, H - 1)` the test, `imul(y, W)` the index. Expected values are Node's.
  const RANGE = `let W = 0, H = 0, px
export let resize = (w, h) => { W = w; H = h; px = new Float64Array(w * h); return px.length }
export let f = (n, x) => {
  let y = 0, id = 1, r = 0
  while (y < n) { if (y < H) px[y * W + x] += 1; y = 2 * id - 1; id *= 2; if (++r > 60) break }
  return [y, id, r, px[x], px[W + x], px[3 * W + x]]
}`
  const BOX = RANGE.replace('if (y < H) ', '')
  const inputs = [[64, 64, 64, 3], [64, 64, 2, 0], [64, 64, 40, 63], [64, 64, 4096, 5], [64, 64, 0, 1], [64, 64, -3, 1], [64, 64, 7.5, 2],
    [64, 64, NaN, 1], [64, 64, 2 ** 26, 3], [64, 64, 2 ** 30 + 1, 0], [64, 64, 9, 2 ** 30], [64, 64, 9, -1], [1, 1, 5, 0], [0, 4, 5, 0], [4, 1, 9, 2]]
  for (const src of [RANGE, BOX]) for (const optimize of levels(0, 2, 'size', 'speed')) {
    const actual = run(src, { optimize }), expected = oracle(src)
    for (const [w, h, n, x] of inputs) is([actual.resize(w, h), actual.f(n, x)], [expected.resize(w, h), expected.f(n, x)], `${JSON.stringify(optimize)}: ${w}x${h}, ${n}, ${x}`)
  }
  if (belowOpt(2)) return
  // (`coldTrap`: the loop as written throws; a 64 by 64 canvas runs the copy, a product past the word fails the guard)
  const m = jz(RANGE, { optimize: { level: 3, coldTrap: true } }).exports, js = oracle(RANGE)
  is([m.resize(64, 64), m.f(64, 3)], [js.resize(64, 64), js.f(64, 3)], 'under `y < H`, a 64-high canvas runs the copy')
  is(m.f(40, 63), js.f(40, 63), 'and so at the last column')
  const b = jz(BOX, { optimize: { level: 3, coldTrap: true } }).exports, bjs = oracle(BOX)
  is([b.resize(64, 64), b.f(64, 3)], [bjs.resize(64, 64), bjs.f(64, 3)], 'over the box alone, a count of 64 runs the copy')
  throws(() => b.f(2 ** 26, 3), '64 * (2^26 - 1) past the word fails the guard')
  // (the index a word of the copy: its product an imul)
  is(count(planned(BOX, 'f'), n => n[0] === '()' && n[1] === 'math.imul'), 1, 'the copy indexes by `imul(y, W) + x`')
})

test('boxed counters: an entry outside the box runs the copy the planner builds with no box', () => {
  // penrose's line walk (examples/penrose/penrose.js drawLine): `x += sx`, a stride of either sign. The
  // box holds `x` and `y` in [0, 2^k - 1], so a line stepping left or up, or starting left of the
  // canvas, fails its guard; the box stood in place of the copy the planner builds with no box (its
  // trips bounded by `guard < 8000`), and such a line ran as written. The box is a tier above that
  // copy now: where its guard fails, the copy runs. Expected values are Node's.
  const src = `let W = 0, H = 0, px
export let resize = (w, h) => { W = w; H = h; px = new Uint32Array(w * h); return px.length }
let drawLine = (x0f, y0f, x1f, y1f, col) => {
  let x = x0f | 0, y = y0f | 0, xe = x1f | 0, ye = y1f | 0
  let dx = xe - x, dy = ye - y
  let ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy
  let sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1
  let err = ax - ay, guard = 0
  while (guard < 8000) {
    if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = col
    if (x === xe && y === ye) break
    let e2 = err * 2
    if (e2 > -ay) { err -= ay; x += sx }
    if (e2 < ax) { err += ax; y += sy }
    guard++
  }
}
export let lines = (n, x0, y0, x1, y1) => {
  let k = 0
  while (k < n) { drawLine(x0 + (k & 7), y0 + (k & 3), x1 - (k & 7), y1 - (k & 3), k + 1); k++ }
  let s = 0
  for (let i = 0; i < px.length; i++) s = (s * 31 + px[i]) | 0
  return s
}`
  const LINES = { 'right and down': [5, 4, 4, 60, 44], 'left and up': [5, 60, 44, 4, 4], 'right and up': [5, 4, 44, 60, 4],
    'from left of the canvas': [5, -20, 10, 60, 30], 'past the bottom right': [5, 40, 30, 90, 70], 'a point': [2, 7, 7, 7, 7] }
  for (const optimize of levels(0, 2, 'speed')) {
    const actual = run(src, { optimize }), expected = oracle(src)
    is(actual.resize(64, 48), expected.resize(64, 48))
    for (const [name, a] of Object.entries(LINES)) is(actual.lines(...a), expected.lines(...a), `${JSON.stringify(optimize)}: ${name}`)
  }
  if (belowOpt(2)) return
  // (`coldTrap`: the loop as written throws; every direction runs a copy, the box's or the other)
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports, js = oracle(src)
  is(m.resize(64, 48), js.resize(64, 48))
  for (const [name, a] of Object.entries(LINES)) is(m.lines(...a), js.lines(...a), `${name} runs a copy`)
})

test('boxed counters: where only the box builds a copy, the loop beside it stands as with no box', () => {
  // The planner builds no copy of the outer loop (`ix` and `id` leave any width it proves), the
  // box does. The loop as written beside it ran where the box's guard failed, cold, its inner loop
  // as written too: slower there than with no box, where the loop runs as written with the inner
  // copy in it. It stands so now: not cold, the inner copy in place. Expected values are Node's.
  const src = `const x = new Float64Array(64), a = new Float64Array(16)
export let f = (n, m) => {
  let ix = 0, id = 1, r = 0
  while (ix < n) {
    let j = 0
    while (j < m) { a[j] += x[ix]; j++ }
    x[ix] += 1; ix = 2 * id - 1; id *= 2
    if (++r > 40) break
  }
  return [ix, id, r, a[0], a[15], x[1], x[63]]
}`
  const inputs = [[64, 16], [64, 3.5], [2 ** 30 + 1, 16], [2 ** 31, 4], [5, -1], [NaN, 4], [-0, 2], [40, NaN], [1e12, 16]]
  for (const optimize of levels(0, 2, 'size', 'speed')) {
    const actual = run(src, { optimize }), expected = oracle(src)
    for (const [n, m] of inputs) is(actual.f(n, m), expected.f(n, m), `${JSON.stringify(optimize)}: ${n}, ${m}`)
  }
  if (belowOpt(2)) return
  const body = planned(src, 'f')
  // (the inner copy's own loop as written, where `m` is no int32, the one cold loop)
  is(count(body, n => n[0] === 'while' && n.cold === true), 1, 'the outer loop as written is not cold')
  // (the inner copy, bounded by `m` rounded, in the box's copy and in the loop as written beside it)
  is(count(body, n => n[0] === 'while' && Array.isArray(n[1]) && typeof n[1][2] === 'string' && n[1][2].includes('bound')), 2, 'the inner copy stands in the loop as written')
})
