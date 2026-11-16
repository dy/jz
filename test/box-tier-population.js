// A population of loops where the box stands as a tier above the copy the planner builds with no
// box, each answering what Node answers at levels 0 to 3, size and speed (the integrator's,
// against src/compile/plan/integral-loops.js as read; d6a6f23c9 and 44d6282b7, .work/architecture.md
// "Counter widths landed"): a name the loop reads and does not write, in a product with a held
// name and read as its own value (the guard's `W * min(n - 1, H - 1)`), over widths where the
// product leaves the word; line walks stepped by a stride of either sign, entering outside the
// box (a stride of -1, a start below zero), which runs the other copy; a round that leaves the
// box in its middle; a tier inside a counted loop, inside another box, inside an inlined call; a
// head read in another form. Each store past the array's end is no store in Node and each read
// there undefined: an index that wrapped in a word lands inside the array and shows.
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [0, 1, 2, 3, 'size', 'speed']

const P = []
const E31 = 2 ** 31, E30 = 2 ** 30
const cross = (...lists) => lists.reduce((acc, l) => acc.flatMap(a => l.map(v => [...a, v])), [[]])
const HASH = (a, n) => `let h = 0; for (let q = 0; q < ${n}; q++) h = (h * 31 + ${a}[q]) | 0`

const LINES = [[1, 1, 6, 5], [6, 5, 1, 1], [1, 5, 6, 1], [6, 1, 1, 5], [-3, 2, 6, 4], [2, -2, 5, 7], [7, 7, 7, 7], [0, 0, 11, 7], [11, 7, 0, 0], [5, 3, -4, 3],
  [3, 0, 3, 9], [E30, E30, E30 + 3, E30 + 2], [-E31, 0, -E31 + 4, 3], [E31 - 4, 1, E31 - 1, 3], [1.5, 2.5, 6.5, 4.5], [0, 7, 40, 0]]
const WS = [12, 8, 0, 1, 3, 46341, 65536, E30 - 1, E30, E31 - 1, E31, 2 ** 32, -1, -12, 0.5, NaN]
const HS = [8, 0, 1, 12, E30, E31, -1, NaN, 2.5]
const LARGS = cross(LINES, WS, HS).map(([l, w, h]) => [...l, w, h])
const STEP = `let e2 = err * 2
    if (e2 > -ay) { err -= ay; x += sx }
    if (e2 < ax) { err += ax; y += sy }`
const SETUP = `let x = x0 | 0, y = y0 | 0, xe = x1 | 0, ye = y1 | 0
  let dx = xe - x, dy = ye - y
  let ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy
  let sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1
  let err = ax - ay, guard = 0`
const PLOTS = [
  ['bounded both sides', 'if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = guard + 1'],
  ['bounded above only', 'if (x < W && y < H) px[y * W + x] = guard + 1'],
  ['the row bounded', 'if (y >= 0 && y < H) px[y * W + x] = guard + 1'],
  ['no bound', 'px[y * W + x] = guard + 1'],
  ['the width first', 'if (x >= 0 && x < W && y >= 0 && y < H) px[W * y + x] = guard + 1'],
  ['the column first', 'if (x >= 0 && x < W && y >= 0 && y < H) px[x + y * W] = guard + 1'],
  ['a row below', 'if (x >= 0 && x < W && y >= 0 && y < H) px[(y + 1) * W + x] = guard + 1'],
  ['two widths', 'if (x >= 0 && x < W && y >= 0 && y < H) px[y * W * 2 + x] = guard + 1'],
  ['width by height', 'if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x * H] = guard + 1'],
  ['a difference', 'if (x >= 0 && x < W && y >= 0 && y < H) px[y * W - x] = guard + 1'],
  ['read and written', 'if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] += px[x * W + y] === undefined ? 7 : 3'],
  ['a read past the end counted', 'if (px[y * W + x] === undefined) u++; else px[y * W + x] = guard + 1'],
]
const HEADS = [['while', 'while (guard < 200) {', 'guard++\n  }'], ['for', 'for (; guard < 200; guard++) {', '}'], ['negated', 'while (!(guard >= 200)) {', 'guard++\n  }']]
for (const [pname, plot] of PLOTS) for (const [hname, head, tail] of pname === 'bounded both sides' || pname === 'no bound' ? HEADS : HEADS.slice(0, 1)) {
  const walk = `${head}
    ${plot}
    if (x === xe && y === ye) break
    ${STEP}
    ${tail}`
  // (the width and height parameters of the function)
  P.push({ name: `line: ${pname}, ${hname}, parameters`, args: LARGS, src: `export let f = (x0, y0, x1, y1, W, H) => {
  const px = new Uint32Array(96); let u = 0
  ${SETUP}
  ${walk}
  ${HASH('px', 96)}
  return [x, y, guard, u, h]
}` })
  if (hname !== 'while') continue
  // (module bindings another export writes, the walk in a function a loop calls: penrose's shape)
  P.push({ name: `line: ${pname}, module bindings, called in a loop`, args: LARGS, src: `let W = 0, H = 0, u = 0
const px = new Uint32Array(96)
export let pre = (x0, y0, x1, y1, w, h) => { W = w; H = h; u = 0; for (let q = 0; q < 96; q++) px[q] = 0 }
let draw = (x0, y0, x1, y1, col) => {
  ${SETUP}
  ${walk.replaceAll('guard + 1', 'col')}
  return x * 3 + y + guard
}
export let f = (x0, y0, x1, y1) => {
  let k = 0, r = 0
  while (k < 3) { r += draw(x0 + (k & 1), y0 + k, x1 - (k & 1), y1 - k, k + 1); k++ }
  ${HASH('px', 96)}
  return [r, u, h]
}` })
}
// (a stride the caller gives, and a walk that turns round)
P.push({ name: 'line: a stride by a parameter', args: cross([0, 3, 7, -2, 40, E30, E31 - 2], [1, -1, 2, -3, 0, 5, E30, 0.5, NaN], [12, 8, 1, 46341, E30, E31, -1], [8, 1, E30]).map(a => a), src: `export let f = (s, d, W, H) => {
  const px = new Uint32Array(96)
  let x = s | 0, y = 0, c = 0
  while (c < 60) {
    if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = c + 1
    x += d; if (x > 9 || x < -9) { y += 1; x = s | 0 }
    c++
  }
  ${HASH('px', 96)}
  return [x, y, c, h]
}` })
P.push({ name: 'line: a stride that flips', args: cross([0, 3, 7, -2, 40], [1, -1, 2, -3, 0], [12, 8, 1, 46341, E30, E31, -1], [8, 1, E30]), src: `export let f = (s, d, W, H) => {
  const px = new Uint32Array(96)
  let x = s | 0, y = 0, c = 0, sx = d | 0
  while (c < 80) {
    if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = c + 1
    x += sx; if (x > 9 || x < 0) { sx = -sx; y += 1 }
    c++
  }
  ${HASH('px', 96)}
  return [x, y, c, sx, h]
}` })

const NS = [0, 1, 7, 8, 8.5, 40, 1000, 65536, 2 ** 28, E30 - 1, E30, E30 + 1, E31 - 1, E31, 2 ** 32, 1e12, -1, -0, NaN]
const SS = [0, 1, 2, 5, -1, -0, 3.5, E30 - 1, E30, E31 - 1, NaN]
const TS = [1, 2, 0, -1, 0.5, E30]
const WS2 = [1, 2, 3, 0, 8, 46341, 65536, E30, E31 - 1, E31, -1, -3, 0.5, NaN]
const NARGS = cross(NS, SS, TS, WS2)
const SUMX = 'x[0] + 2 * x[1] + 3 * x[2] + 4 * x[3] + 5 * x[4] + 6 * x[5] + 7 * x[6] + 8 * x[7]'
const nprog = (name, decl, loop, names = 'i', pre = '') => P.push({ name, args: NARGS, src: `${pre}
export let f = (n, s, t, W) => {
  const x = new Float64Array(8); for (let k = 0; k < 8; k++) x[k] = k + 1
  const a = new Float64Array(8)
  let c = 0, u = 0, sum = 0
  ${decl}
  ${loop}
  return [c, u, sum, ${names}, ${SUMX}, a[0] + a[3] * 2 + a[7] * 3]
}` })
const cap = (k = 44) => `if (++c > ${k}) break`
const R = 'i = i * 2 + t'
const RD = ix => `if (x[${ix}] === undefined) u++; else sum += x[${ix}]`
for (const [name, ix] of [['i * W', 'i * W'], ['W * i', 'W * i'], ['i * W + 1', 'i * W + 1'], ['(i + 1) * W', '(i + 1) * W'], ['i * W * W', 'i * W * W'], ['i * (W + 1)', 'i * (W + 1)'],
  ['i * W - t', 'i * W - t'], ['W - i', 'W - i'], ['i + W', 'i + W'], ['i * W + s', 'i * W + s']]) {
  nprog(`product read: ${name}`, 'let i = s', `while (i < n) { ${cap()}; ${RD(ix)}; ${R} }`)
  nprog(`product stored: ${name}`, 'let i = s', `while (i < n) { ${cap()}; x[${ix}] = c; ${R} }`)
  nprog(`product under the loop's width: ${name}`, 'let i = s', `while (i < n) { ${cap()}; if (i < W) x[${ix}] = c; ${R} }`)
}
nprog('leaves by a square', 'let i = s', `while (i < n) { ${cap()}; x[i] = c; i = i * i + t }`)
nprog('leaves and is read before the head', 'let i = s, last = 0', `while (i < n) { ${cap()}; x[i] = c; ${R}; last = i * W; ${RD('last')} }`, 'i, last')
nprog('leaves downward', 'let i = s', `while (i < n) { ${cap()}; x[i] = c; i = i * 2 - t * 3 }`)
nprog('enters below zero and climbs', 'let i = s - 6', `while (i < n) { ${cap()}; if (i >= 0) x[i] = c; i = i + (c & 3) + t }`)
nprog('enters above and descends', 'let i = s + 9', `while (i > n) { ${cap()}; x[i] = c; i = i - t - (c & 1) }`)
for (const [name, head] of [['a literal count', 'for (let k = 0; k < 5; k++)'], ['a count by a Number', 'for (let k = 0; k < t; k++)'], ['a count down', 'for (let k = 4; k >= 0; k--)'],
  ['a box around', 'let k = 1; while (k < n) { k = k * 2 + 1; if (++c > 60) break;'], ['a signed walk around', 'let k = s | 0, sk = t < 0 ? -1 : 1; while (k < 9 && k > -9) { k += sk; if (++c > 60) break;']]) {
  const open = head.endsWith(';') ? head : head + ' {'
  nprog(`in ${name}: the inner signed`, 'let last = 0', `${open} ${cap(60)}; let i = k, d = (k & 1) ? -1 : 1, g = 0; while (g < 9) { g++; if (i >= 0 && i < W) x[i * W + k] = c; i += d }; last += i }`, 'last')
  nprog(`in ${name}: the inner doubling`, 'let last = 0', `${open} ${cap(60)}; let i = k; while (i < n) { ${cap(60)}; x[i * W] = c; ${R} }; last += i }`, 'last')
  nprog(`in ${name}: the inner counted beside a held name`, 'let i = s, last = 0', `${open} ${cap(60)}; for (let j = 0; j < 8; j++) a[j] += x[j] + i; x[i * W] = c; ${R}; last += k }`, 'i, last')
}
nprog('a box with a counted inner loop bounded by a Number', 'let ix = s, id = 1', `while (ix < n) { let j = 0; while (j < t) { a[j] += x[ix]; j++; if (++c > 200) break }; x[ix] += 1; ix = 2 * id - 1; id *= 2; if (++c > 200) break }`, 'ix, id')
nprog('a box with two inner copies', 'let ix = s, id = 1', `while (ix < n) { for (let j = 0; j < 8; j++) a[j] += x[j]; for (let j = 7; j >= 0; j--) x[j] += a[j] * 0.5; x[ix * W] = c; ix = 2 * id - 1; id *= 2; if (++c > 40) break }`, 'ix, id')
nprog('an inlined walk in a doubling loop', 'let i = s, r = 0', `while (i < n) { ${cap(30)}; r += walk(x, i, t, W); ${R} }`, 'i, r',
  `let walk = (x, from, d, W) => { let p = from | 0, sp = d < 0 ? -1 : 1, g = 0; while (g < 6) { if (p >= 0 && p < W) x[p * W] = g; p += sp; g++ } return p }`)
nprog('an inlined doubling in a signed walk', 'let p = s | 0, sp = t < 0 ? -1 : 1, r = 0', `while (c < 12) { c++; r += dbl(x, p, n, W); p += sp }`, 'p, r',
  `let dbl = (x, from, n, W) => { let i = from, g = 0; while (i < n) { if (++g > 20) break; x[i * W] = g; i = i * 2 + 1 } return i }`)
// ---- a head read in another form
nprog('a for with an init', 'let i = 0', `for (i = s; i < n; ) { ${cap()}; x[i * W] = c; ${R} }`)
nprog('a for with an update', 'let i = s', `for (; i < n; i = i * 2 + t) { ${cap()}; x[i * W] = c }`)
nprog('a negated test', 'let i = s', `while (!(i >= n)) { ${cap()}; x[i * W] = c; ${R} }`)
nprog('a do-while', 'let i = s', `do { ${cap()}; x[i * W] = c; ${R} } while (i < n)`)

test(`box tier population: ${P.length} loops of the box above the copy with no box, ${CONFIGS.length} configurations`, () =>
  population('box tier', P, { configs: CONFIGS, own: ['W', 'H', 'u', 'px', 'draw', 'walk', 'dbl'] }))
