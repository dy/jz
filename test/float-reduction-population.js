// A population of float reductions, each answering what Node answers bit for bit at optimize
// false, true and size and at `{ level: 'speed', relaxedFloat: false }`, and within the README's
// bound at speed ("Float results at 'speed'": a sum of n terms within n·2^-52 of the terms' total
// magnitude, a product of n factors within n·2^-52 of its own, a zero's sign included, by more
// where one order overflows or underflows; Float32Array arithmetic rounded to single precision at
// each step; the minimum or maximum of +0 and -0 either sign). 29 reductions (sums forward,
// backward and from -0, dots, scaled sums, squares and norms, means, two sums, differences,
// products, running sums and products, maxima and minima four ways, reduce, for-of, maps, a
// stencil, a matrix-vector product, an unrolled dot) over Float64Array, Float32Array and plain
// arrays, and six maps over Float32Array; 13 patterns (1e16 beside 1, rounding, NaN, the
// infinities, signed zeros, overflow, subnormals, mixed magnitudes) at lengths around a strip.
// Each program builds its arrays from a pattern k and a length n, both scalars, so no boundary
// copy decides anything; `g` is the magnitude a bound is taken of (Node only). Phase 9a put every
// rewrite that can round otherwise than JavaScript behind relaxedFloat, on at speed alone: 28 of
// the 93 differed at the default level before (.work/architecture.md, "9a: the float relaxations
// one option").
import test from 'tst'
import { is } from 'tst/assert.js'
import { jz, oracle } from './util.js'
import { onKernel } from './_matrix.js'

// Patterns: reassociation visible (1e16 beside 1), rounding, NaN, infinities, signed zeros,
// overflow, subnormals, mixed magnitudes.
const mix = []
for (let i = 0; i < 37; i++) mix.push(((i * 2654435761) % 1000 - 500) * 10 ** ((i * 7) % 30 - 15))
const PATTERNS = [
  [1e16, 1, -1e16, 1, 1, 1, 1, 1],
  [0.1, 0.2, 0.3, 0.7, 1e-17, 3.3, -2.2, 1.1],
  [1, NaN, 2, 3],
  [Infinity, 1, -Infinity, 2],
  [-0, -0, -0, -0, -0],
  [-1, 0, -0, -1, -0, 0],
  [1e308, 1e308, -1e308, -1e308],
  [3, -0.5, 1e-300, 7e300, 2.5, -1e-310, 5e-324],
  mix,
  [1.0000001, 0.9999999, 1.5, 0.75, 1.25, 0.8, 1.1],
  [0, -0],
  [-0, 0, -2],
  [-3, -0, 0, -3, NaN, -0, 0],
]
const OVERFLOW = new Set([3, 6, 7])   // patterns where an order overflows or meets ±Infinity: no bound at 'speed'
const LENGTHS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65]
const ARGS = []
for (let k = 0; k < PATTERNS.length; k++) for (const n of LENGTHS) ARGS.push([k, n])

const lit = (x) => Object.is(x, -0) ? '-0' : Number.isNaN(x) ? 'NaN' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : String(x)
const PRE = `const P = [${PATTERNS.map(p => '[' + p.map(lit).join(', ') + ']').join(', ')}]`
const FILL = {
  f64: (v, sh) => `const ${v} = new Float64Array(n); { const p = P[k]; for (let i = 0; i < n; i++) ${v}[i] = p[(i + ${sh}) % p.length] }`,
  f32: (v, sh) => `const ${v} = new Float32Array(n); { const p = P[k]; for (let i = 0; i < n; i++) ${v}[i] = p[(i + ${sh}) % p.length] }`,
  arr: (v, sh) => `const ${v} = []; { const p = P[k]; for (let i = 0; i < n; i++) ${v}.push(p[(i + ${sh}) % p.length]) }`,
}
// kind: 'sum' (bound n·2^-52·Σ|term|), 'prod' (relative (n-1)·2^-52), 'ext' (equal, or zeros of either sign),
// 'f32' (per element, 4·2^-24 of the magnitudes), 'exact' (bit for bit at 'speed' too)
// body: the reduction; mag: the Σ|term| it is bounded by (Node only)
const RED = [
  ['sum', 'sum', 'let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i]); return s'],
  ['sum from -0', 'sum', 'let s = -0; for (let i = 0; i < n; i++) s += a[i]; return s', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i]); return s'],
  ['sum backward', 'sum', 'let s = 0; for (let i = n - 1; i >= 0; i--) s += a[i]; return s', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i]); return s'],
  ['dot', 'sum', 'let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] * b[i]); return s'],
  ['dot of three', 'sum', 'let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i] * 0.5; return s', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] * b[i] * 0.5); return s'],
  ['scaled sum', 'sum', 'let s = 0; for (let i = 0; i < n; i++) s += a[i] * 0.1; return s', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] * 0.1); return s'],
  ['sum of squares', 'sum', 'let s = 0; for (let i = 0; i < n; i++) s += a[i] * a[i]; return s', 'let s = 0; for (let i = 0; i < n; i++) s += a[i] * a[i]; return s'],
  ['norm sqrt', 'sum', 'let s = 0; for (let i = 0; i < n; i++) s += a[i] * a[i]; return Math.sqrt(s)', 'let s = 0; for (let i = 0; i < n; i++) s += a[i] * a[i]; return Math.sqrt(s)'],
  ['norm pow', 'sum', 'let s = 0; for (let i = 0; i < n; i++) s += a[i] * a[i]; return s ** 0.5', 'let s = 0; for (let i = 0; i < n; i++) s += a[i] * a[i]; return Math.sqrt(s)'],
  ['sum of abs', 'sum', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i]); return s', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i]); return s'],
  ['mean', 'sum', 'let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s / n', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i]); return s / n'],
  ['two sums', 'sum', 'let s = 0, q = 0; for (let i = 0; i < n; i++) { s += a[i]; q += a[i] * a[i] } return s + q * 1e-3', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i]) + a[i] * a[i] * 1e-3; return s'],
  ['difference sum', 'sum', 'let s = 0; for (let i = 0; i < n; i++) s += a[i] - b[i]; return s', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]); return s'],
  ['product', 'prod', 'let p = 1; for (let i = 0; i < n; i++) p *= a[i]; return p', null],
  ['running product', 'exact', 'const o = new Float64Array(n); let p = 1; for (let i = 0; i < n; i++) { p *= a[i]; o[i] = p } return [...o]', null],
  ['running sum', 'exact', 'const o = new Float64Array(n); let s = 0; for (let i = 0; i < n; i++) { s += a[i]; o[i] = s } return [...o]', null],
  ['max', 'ext', 'let m = -Infinity; for (let i = 0; i < n; i++) m = Math.max(m, a[i]); return m', null],
  ['min', 'ext', 'let m = Infinity; for (let i = 0; i < n; i++) m = Math.min(m, a[i]); return m', null],
  ['max ternary', 'ext', 'let m = -Infinity; for (let i = 0; i < n; i++) m = a[i] > m ? a[i] : m; return m', null],
  ['min ternary', 'ext', 'let m = Infinity; for (let i = 0; i < n; i++) m = a[i] < m ? a[i] : m; return m', null],
  ['max if', 'ext', 'let m = -Infinity; for (let i = 0; i < n; i++) if (a[i] > m) m = a[i]; return m', null],
  ['max from first', 'ext', 'if (!n) return 0; let m = a[0]; for (let i = 1; i < n; i++) m = Math.max(m, a[i]); return m', null],
  ['max ge', 'ext', 'let m = -Infinity; for (let i = 0; i < n; i++) m = a[i] >= m ? a[i] : m; return m', null],
  ['reduce', 'sum', 'return a.reduce((s, x) => s + x, 0)', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i]); return s'],
  ['for of', 'sum', 'let s = 0; for (const x of a) s += x; return s', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i]); return s'],
  ['map', 'exact', 'const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * 0.1 + b[i]; return [...o]', null],
  ['stencil', 'exact', 'const o = new Float64Array(n); for (let i = 1; i < n - 1; i++) o[i] = a[i - 1] + a[i] + a[i + 1]; return [...o]', null],
  ['matvec', 'sum', 'let t = 0; for (let r = 0; r < 3; r++) { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[(i + r) % (n || 1)]; t = t * 0.5 + s } return t', 'let t = 0; for (let r = 0; r < 3; r++) { let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] * b[(i + r) % (n || 1)]); t = t * 0.5 + s } return t'],
  ['unrolled dot', 'sum', 'let s = 0, i = 0; for (; i + 3 < n; i += 4) s += a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3]; for (; i < n; i++) s += a[i] * b[i]; return s', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] * b[i]); return s'],
]
// f32 output maps: Float32Array in and out, the per-op single-precision class
const F32MAP = [
  ['f32 map mul add', 'f32', 'const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * 0.1 + b[i]; return [...o]', 'const o = []; for (let i = 0; i < n; i++) o.push(Math.abs(a[i] * 0.1) + Math.abs(b[i])); return o'],
  ['f32 map fma', 'f32', 'const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * b[i] + a[i]; return [...o]', 'const o = []; for (let i = 0; i < n; i++) o.push(Math.abs(a[i] * b[i]) + Math.abs(a[i])); return o'],
  ['f32 map horner', 'f32', 'const o = new Float32Array(n); for (let i = 0; i < n; i++) { const x = a[i]; o[i] = ((x * 0.3 + 0.2) * x + 0.1) * x } return [...o]', 'const o = []; for (let i = 0; i < n; i++) { const x = Math.abs(a[i]); o.push(((x * 0.3 + 0.2) * x + 0.1) * x) } return o'],
  ['f32 fround chain', 'exact', 'const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = Math.fround(Math.fround(a[i] * b[i]) + Math.fround(a[i] / (b[i] || 1))); return [...o]', 'return []'],
  ['f32 fround sqrt', 'exact', 'let s = 0; for (let i = 0; i < n; i++) s = Math.fround(s + Math.fround(Math.sqrt(Math.fround(a[i] * a[i])))); return s', 'return 0'],
  ['f32 accumulate', 'sum', 'let s = 0; for (let i = 0; i < n; i++) s = Math.fround(s + a[i]); return s', 'let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i]); return s * 2 ** 29'],
]

const P = []
for (const kind of ['f64', 'f32', 'arr']) for (const [name, cls, body, mag] of RED) {
  const fill = FILL[kind]
  const src = `${PRE}
export let f = (k, n) => {
  ${fill('a', 0)}
  ${fill('b', 3)}
  ${body}
}
${mag ? `export let g = (k, n) => {
  ${fill('a', 0)}
  ${fill('b', 3)}
  ${mag}
}` : ''}`
  P.push({ name: `${name}, ${kind}`, cls, src })
}
for (const [name, cls, body, mag] of F32MAP) {
  const src = `${PRE}
export let f = (k, n) => {
  ${FILL.f32('a', 0)}
  ${FILL.f32('b', 3)}
  ${body}
}
export let g = (k, n) => {
  ${FILL.f32('a', 0)}
  ${FILL.f32('b', 3)}
  ${mag}
}`
  P.push({ name, cls, src })
}

const CONFIGS = [['false', false], ['true', true], ['size', 'size'], ['exact', { level: 'speed', relaxedFloat: false }], ['speed', 'speed']]
const same = (x, y) => Object.is(x, y) || (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => Object.is(v, y[i])))
const show = x => Array.isArray(x) ? '[' + x.slice(0, 6).map(lit).join(',') + (x.length > 6 ? ',…' : '') + ']' : lit(x)
const U52 = 2 ** -52, U24 = 2 ** -24
// Whether `got` at 'speed' is within README's bound of Node's `want`.
const within = (cls, k, n, want, got, mag) => {
  if (same(want, got)) return true
  if (cls === 'exact') return false
  if (OVERFLOW.has(k)) return true   // README: by more where one order overflows (unbounded by its text)
  if (cls === 'ext') return want === 0 && got === 0
  if (cls === 'prod') return Number.isFinite(want) && Math.abs(got - want) <= Math.max(n - 1, 1) * U52 * Math.abs(want) * 1.0000001
  if (cls === 'sum') return Number.isFinite(want) && Math.abs(got - want) <= Math.max(n, 1) * U52 * mag * 1.0000001
  if (cls === 'f32') return Array.isArray(want) && want.length === got.length && want.every((w, i) => Object.is(w, got[i]) || Math.abs(got[i] - w) <= 4 * U24 * mag[i])
  return false
}

// Every program at each configuration, one module for them all: one assertion a differing call
// (past the bound at speed), one a configuration saying what it ran.
const names = /\b(P|f|g)\b/g
const SRC = P.map((p, k) => p.src.replace(names, `$1_${k}`)).join('\n')
for (const [tag, optimize] of CONFIGS) test(`float reduction population: ${P.length} reductions, ${ARGS.length} patterns and lengths, at ${tag}`, () => {
  if (onKernel()) return
  const node = oracle(SRC), mod = jz(SRC, { optimize }).exports
  let relaxed = 0
  P.forEach((p, k) => {
    for (const [pk, n] of ARGS) {
      const want = node[`f_${k}`](pk, n)
      let got
      try { got = mod[`f_${k}`](pk, n) } catch (e) { got = 'throw ' + e.message.slice(0, 40) }
      if (same(want, got)) continue
      if (tag === 'speed' && (relaxed++, within(p.cls, pk, n, want, got, node[`g_${k}`]?.(pk, n)))) continue
      is(show(got), show(want), `${p.name} (${pk}, ${n}) at ${tag}${tag === 'speed' ? ', past the bound' : ''}`)
    }
  })
  is(true, true, `${P.length} programs at ${tag}${tag === 'speed' ? `: ${relaxed} calls differ from Node within the bound` : ''}`)
})
