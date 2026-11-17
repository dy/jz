// A population of float sums and products written the ways people write them, each bit for bit
// with Node at the levels that keep JavaScript's float results: 0, 2, 'size' and 'speed' with
// relaxedFloat off (README, "Float results at 'speed'"). A pass may reorder or regroup float
// operations only where relaxedFloat licenses it; one that took another flag for it (the counted
// loops' roll of an unrolled sum, licensed by the lane lift alone until 2de66ece6) answers in
// another rounding here. The forms: a plain loop; unrolled by 2, 4, 5 and 8, in one statement and
// in several, with the remainder loop before and after; two and four accumulators; cursors; a
// nested loop; min and max; a dot, a norm, a polynomial by Horner and by running powers, a
// product; over Float64Arrays and plain arrays. The data, made by IEEE-exact operations alone (no
// Math function but sqrt, min and max, whose results are exact): fractional, mixed in magnitude so
// that order matters, with -0 and +0, with infinities, with a NaN. The unrolled single statements
// are all taken; the rest a fixed seed samples.
import test from 'tst'
import { population } from './_population.js'

const CONFIGS = [0, 2, 'size', { level: 'speed', relaxedFloat: false }]
const OWN = ['N', 'a', 'b', 'k', 'mk']
const NS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 40]
const DATA = [0, 1, 2, 3, 4]
const args = NS.flatMap(n => DATA.map(d => [n, d]))

// The arrays: 40 elements of each data set, `d` choosing the set at run time.
const FILL = `const fill = (x, y, d) => {
  for (let i = 0; i < N; i++) {
    let u = (i * 0.37) % 7.3 - 3.1, v = 1 / (i + 1.5) - (i % 11) * 0.013
    if (d === 1) { u = i % 3 === 0 ? 1e16 + i * 3 : i % 3 === 1 ? -1e16 : 0.1 * i + 0.7; v = i % 2 ? 1e-8 * i : 3.3 - i * 0.01 }
    if (d === 2) { u = i % 4 === 0 ? -0 : i % 4 === 1 ? 0 : u * 1e-300; v = i % 3 === 0 ? -0 : -v }
    if (d === 3 && i === 13) u = Infinity
    if (d === 3 && i === 21) v = -Infinity
    if (d === 4 && i === 17) u = NaN
    x[i] = u; y[i] = v
  }
}`
const ARR = {
  typed: `const a = new Float64Array(N), b = new Float64Array(N)`,
  plain: `const a = [], b = []
for (let i = 0; i < N; i++) { a.push(0); b.push(0) }`,
}
// The element term of a sum: `a[i]`, or a product of two arrays (a dot).
const TERM = { sum: (i) => `a[${i}]`, dot: (i) => `a[${i}] * b[${i}]` }
const at = (i, j) => j ? `${i} + ${j}` : i
// one statement: `s += t(i) + t(i + 1) + …`
const one = (K, t, before) => {
  const main = `for (let i = ${before ? 'm' : '0'}; i ${before ? '<' : '+ ' + K + ' <='} n; i += ${K}) s += ${Array.from({ length: K }, (_, j) => t(at('i', j))).join(' + ')}`
  return before
    ? `let s = 0; const m = n % ${K}; for (let i = 0; i < m; i++) s += ${t('i')}; ${main}; return s`
    : `let s = 0, i = 0; for (; i + ${K} <= n; i += ${K}) s += ${Array.from({ length: K }, (_, j) => t(at('i', j))).join(' + ')}; for (; i < n; i++) s += ${t('i')}; return s`
}
// several statements: `s += t(i); s += t(i + 1); …`
const several = (K, t) => `let s = 0, i = 0; for (; i + ${K} <= n; i += ${K}) { ${Array.from({ length: K }, (_, j) => `s += ${t(at('i', j))}`).join('; ')} } for (; i < n; i++) s += ${t('i')}; return s`
const accs = (A, t) => `${Array.from({ length: A }, (_, j) => `let s${j} = 0`).join('; ')}; let i = 0; for (; i + ${A} <= n; i += ${A}) { ${Array.from({ length: A }, (_, j) => `s${j} += ${t(at('i', j))}`).join('; ')} } for (; i < n; i++) s0 += ${t('i')}; return ${Array.from({ length: A }, (_, j) => `s${j}`).join(' + ')}`
const OTHER = {
  plain: (t) => `let s = 0; for (let i = 0; i < n; i++) s += ${t('i')}; return s`,
  down: (t) => `let s = 0; for (let i = n - 1; i >= 0; i--) s += ${t('i')}; return s`,
  cursor: () => `let s = 0, ix = 0, iy = 0; for (let i = 0; i < n; i++) { s += a[ix] * b[iy]; ix += 1; iy += 1 } return s`,
  nested: (t) => `let s = 0; for (let r = 0; r < 3; r++) for (let i = 0; i < n; i++) s += ${t('i')} * (r + 0.5); return s`,
  max: () => `let m = -Infinity; for (let i = 0; i < n; i++) m = Math.max(m, a[i]); return m`,
  min: () => `let m = Infinity; for (let i = 0; i < n; i++) m = Math.min(m, a[i] * b[i]); return m`,
  norm: () => `let s = 0; for (let i = 0; i < n; i++) s += a[i] * a[i]; return Math.sqrt(s)`,
  horner: () => `let p = 0; for (let i = 0; i < n; i++) p = p * 0.71 + a[i]; return p`,
  powers: () => `let s = 0, xp = 1; for (let i = 0; i < n; i++) { s += a[i] * xp; xp *= 0.93 } return s`,
  product: () => `let p = 1; for (let i = 0; i < n; i++) p *= 1 + a[i] * 1e-3; return p`,
  acc2: (t) => accs(2, t),
  acc4: (t) => accs(4, t),
}
const prog = (arr, body) => `const N = 40
${ARR[arr]}
${FILL}
let k = -1
export const f = (n, d) => { if (k !== d) { fill(a, b, d); k = d } ${body} }`

// (xorshift32: the same programs on every run)
let seed = 0x2468ace1
const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }
const progs = []
for (const arr of Object.keys(ARR)) for (const [tn, t] of Object.entries(TERM)) {
  // every unrolled single statement, the roll's own shape
  for (const K of [2, 4, 5, 8]) for (const before of [true, false])
    progs.push({ name: `${arr} ${tn} unrolled ${K} in one statement, remainder ${before ? 'before' : 'after'}`, src: prog(arr, one(K, t, before)), args })
  // the rest sampled
  for (const K of [2, 4, 5, 8]) if (rand() < 0.5) progs.push({ name: `${arr} ${tn} unrolled ${K} in statements`, src: prog(arr, several(K, t)), args })
  // (a kernel of its own operation is taken once, with the sums)
  for (const [on, o] of Object.entries(OTHER)) if ((o.length || tn === 'sum') && rand() < 0.5) progs.push({ name: `${arr} ${tn} ${on}`, src: prog(arr, o(t)), args })
}

test(`float order population: ${progs.length} programs bit for bit with Node at ${CONFIGS.length} levels`, () =>
  population('float order', progs, { configs: CONFIGS, own: [...OWN, 'fill'], chunk: 40 }))
