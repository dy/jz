// Math against V8, bit for bit. jz's Math is V8's own: module/math/ieee754.js transliterates
// V8's src/base/ieee754.cc (fdlibm) and its Torque MathHypot, and $math.pow follows V8's
// math::pow. So every result must be V8's, Object.is, on every argument: ±0, subnormals,
// arguments past 2^19·π/2 (the Payne–Hanek reduction), near multiples of π/2, NaN, ±∞;
// through the scalar kernels, their f64x2 twins in vectorized loops, and constant folding.
//
// The reference: V8 computes these in C. x64 builds evaluate the C as written, as jz does;
// arm64 builds of Node and Chrome fuse a·b + c in it and land an ulp away on a fraction of a
// percent of arguments (Math.sin(-9.870609943754971) is 0.43120868794996103 on x64 and
// 0.4312086879499611 on arm64). So the reference is the host where it computes the C as
// written, else the JS transliteration the constant folder uses (src/prepare/math-kernel.js),
// which matches x64 V8 bit for bit.
//
// pow is V8's only function without an algorithm of its own: past its special cases
// (y = 2 is x·x, y = ½ is √(x + 0), NaN and ±∞ rules) it calls the platform's C library,
// whose last bit differs between platforms. The special cases are checked against the host;
// the rest against the constant folder's twin, and folds against the runtime.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run } from './util.js'
import { levels } from './_matrix.js'
import { MATH_KERNEL, powFold } from '../src/prepare/math-kernel.js'

const PLAIN_HOST = Math.sin(-9.870609943754971) === 0.43120868794996103 && Math.exp(10.153969107195735) === 25692.87788027137
const TWIN = Object.fromEntries(Object.entries(MATH_KERNEL).map(([k, f]) => [k.slice(5), f]))
const REF = PLAIN_HOST ? Math : { ...TWIN, sqrt: Math.sqrt }

// ── deterministic arguments ────────────────────────────────────────────────
let seed = 0x6a09e667
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }
const F = new Float64Array(1), U = new Uint32Array(F.buffer)
const bits = () => { U[0] = (rnd() * 4294967296) >>> 0; U[1] = (rnd() * 4294967296) >>> 0; return F[0] === F[0] ? F[0] : NaN }   // any double (one NaN)
const uni = (lo, hi) => () => lo + (hi - lo) * rnd()
const mag = (e0, e1) => () => (rnd() < 0.5 ? -1 : 1) * 2 ** (e0 + (e1 - e0) * rnd())   // log-uniform magnitude, either sign
const pos = (e0, e1) => () => 2 ** (e0 + (e1 - e0) * rnd())
const nearPio2 = () => { F[0] = Math.floor(rnd() * 2 ** (rnd() * 40)) * (Math.PI / 2); U[0] += Math.floor(rnd() * 64) - 32; return (rnd() < 0.5 ? -1 : 1) * F[0] }
const EDGES = [0, -0, Infinity, -Infinity, NaN, 1, -1, 0.5, -0.5, 2, -2, 22, -22, 0.1, 1e-8, 2 ** -28, 2 ** -54,
  5e-324, -5e-324, 2.2250738585072014e-308, 2.225073858507201e-308, 1.7976931348623157e308, -1.7976931348623157e308,
  Math.PI, -Math.PI, Math.PI / 2, Math.PI / 4, 3 * Math.PI / 4, 3 * Math.PI, 1e22, 1e300, 2 ** 1023, 823549.6, 823550.1,
  6381956970095103 * 2 ** 797, 709.782712893384, 709.7822265625, 710.4758600739439, -745.1332191019412, 0.34657359027997264]
const T = 300   // arguments per generator
const sample = (gens) => [...EDGES, ...gens.flatMap(g => Array.from({ length: T }, g))]
const trig = [uni(-50, 50), mag(-1074, 1024), nearPio2, bits]
const UNARY = {
  sin: trig, cos: trig, tan: [uni(-1.6, 1.6), ...trig],
  asin: [uni(-1, 1), mag(-60, 0), bits], acos: [uni(-1, 1), mag(-60, 0), bits], atan: [uni(-50, 50), mag(-1074, 1024), bits],
  exp: [uni(-20, 20), uni(-746, 710), mag(-60, 10), bits], expm1: [uni(-2, 2), uni(-60, 710), mag(-60, 10), bits],
  log: [pos(-1074, 1024), uni(0.5, 2), bits], log2: [pos(-1074, 1024), uni(0.5, 2), bits], log10: [pos(-1074, 1024), uni(0.5, 2), bits],
  log1p: [uni(-1, 10), mag(-60, 60), bits],
  sinh: [uni(-25, 25), uni(-720, 720), mag(-60, 10), bits], cosh: [uni(-25, 25), uni(-720, 720), mag(-60, 10), bits],
  tanh: [uni(-25, 25), mag(-60, 10), bits],
  asinh: [uni(-5, 5), mag(-60, 1024), bits], acosh: [uni(1, 5), pos(0, 1024), bits], atanh: [uni(-1, 1), mag(-60, 0), bits],
  cbrt: [uni(-100, 100), mag(-1074, 1024), bits], sqrt: [pos(-1074, 1024), bits],
}
const ARGS = Object.fromEntries(Object.entries(UNARY).map(([f, gens]) => [f, sample(gens)]))
const pairs = (gens) => [...EDGES.flatMap(x => EDGES.map(y => [x, y])), ...gens.flatMap(([g, h]) => Array.from({ length: T }, () => [g(), h()]))]
const PAIRS = {
  atan2: pairs([[uni(-50, 50), uni(-50, 50)], [mag(-1074, 1024), mag(-1074, 1024)], [bits, bits]]),
  hypot: pairs([[uni(-50, 50), uni(-50, 50)], [mag(-1074, 1024), mag(-1074, 1024)], [bits, bits]]),
  pow: pairs([[uni(0, 100), uni(-3, 3)], [pos(-40, 40), uni(-30, 30)], [uni(-10, 10), () => Math.round(uni(-40, 40)())], [bits, bits]]),
}
const TRIPLES = Array.from({ length: T }, () => [mag(-1074, 1024)(), uni(-50, 50)(), rnd() < 0.1 ? NaN : bits()])

// ── one module per level: scalar exports, vectorized loops, constant exponents ──
const loop = (f, call) => `export let ${f}A = (xs) => { const o = new Float64Array(xs.length); for (let i = 0; i < xs.length; i++) o[i] = ${call}; return o }`
const loop2 = (f, call) => `export let ${f}A = (ys, xs) => { const o = new Float64Array(xs.length); for (let i = 0; i < xs.length; i++) o[i] = ${call}; return o }`
const CONST_EXP = { p2: 2, p3: 3, pm1: -1, ph: 0.5, pmh: -0.5, p24: 2.4, p17: 1.7 }
const CONST_BASE = [2, 10, 0.5, 1.0000001, 1e-300, 5e-324, 1e300, Math.E]
const SRC = [
  ...Object.keys(UNARY).flatMap(f => [`export let ${f} = (x) => Math.${f}(x)`, loop(f, `Math.${f}(xs[i])`)]),
  'export let atan2 = (y, x) => Math.atan2(y, x)', loop2('atan2', 'Math.atan2(ys[i], xs[i])'),
  'export let hypot = (x, y) => Math.hypot(x, y)', loop2('hypot', 'Math.hypot(ys[i], xs[i])'),
  'export let hypot3 = (x, y, z) => Math.hypot(x, y, z)', 'export let hypotN = (v) => Math.hypot(...v)',
  'export let pow = (x, y) => Math.pow(x, y)', 'export let powE = (x, y) => x ** y', loop2('pow', 'ys[i] ** xs[i]'),
  ...Object.entries(CONST_EXP).map(([n, c]) => `export let ${n} = (x) => x ** ${c}`),
  'export let two = (y) => 2 ** y', loop('two', '2 ** xs[i]'),
  ...CONST_BASE.map((c, i) => `export let b${i} = (y) => (${c}) ** y`),
].join('\n')

const show = (x) => Object.is(x, -0) ? '-0' : String(x)
const differ = (got, want, arg) => { const bad = []; for (let i = 0; i < want.length; i++) if (!Object.is(got[i], want[i])) bad.push(`${arg(i)}: ${show(got[i])}, want ${show(want[i])}`); return bad }
const report = (bad) => bad.length ? `${bad.length} differ, e.g. ${bad.slice(0, 3).join('; ')}` : 'all agree'

test('Math vs V8: the kernels on the plain examples that tell them apart', () => {
  const m = run(`export let s = (x) => Math.sin(x)
    export let sg = (x) => Math.sign(Math.sin(x))
    export let at = (x) => Math.atan(x)`)
  is(m.s(Math.PI), 1.2246467991473532e-16, 'sin(π) is the residual of the double nearest π, not 0')
  is(m.sg(3 * Math.PI), 1, 'the sign of sin(3π): a square wave from Math.sign(Math.sin(…))')
  is(m.s(1e22), -0.8522008497671888, 'sin(1e22) through the Payne–Hanek reduction')
  is(m.at(0.5), 0.4636476090008061, 'atan to the last bit, not a 30-bit minimax')
})

for (const optimize of levels(0, 1, 2, 3)) {
  test(`Math vs V8 (optimize ${optimize}): every function, scalar and vectorized, Object.is`, () => {
    const m = run(SRC, { optimize })
    for (const [f, xs] of Object.entries(ARGS)) {
      const want = xs.map(x => REF[f](x)), arg = i => `${f}(${show(xs[i])})`
      is(report(differ(xs.map(x => m[f](x)), want, arg)), 'all agree', `${f}, ${xs.length} arguments`)
      is(report(differ(m[f + 'A'](Float64Array.from(xs)), want, arg)), 'all agree', `${f} in a loop`)
    }
    for (const f of ['atan2', 'hypot']) {
      const ps = PAIRS[f], want = ps.map(([y, x]) => REF[f](y, x)), arg = i => `${f}(${ps[i].map(show)})`
      is(report(differ(ps.map(([y, x]) => m[f](y, x)), want, arg)), 'all agree', `${f}, ${ps.length} pairs`)
      is(report(differ(m[f + 'A'](Float64Array.from(ps, p => p[0]), Float64Array.from(ps, p => p[1])), want, arg)), 'all agree', `${f} in a loop`)
    }
    const want3 = TRIPLES.map(([x, y, z]) => REF.hypot(x, y, z))
    is(report(differ(TRIPLES.map(([x, y, z]) => m.hypot3(x, y, z)), want3, i => `hypot(${TRIPLES[i]})`)), 'all agree', 'hypot of three')
    is(report(differ(TRIPLES.map(t => m.hypotN(t)), want3, i => `hypot(...[${TRIPLES[i]}])`)), 'all agree', 'hypot of a spread')
    for (const v of [[], [-3], [3, 4], [NaN, Infinity], [1e300, 1e300, 1e-300, 7, NaN, 2]]) ok(Object.is(m.hypotN(v), REF.hypot(...v)), `hypot(...[${v}])`)
  })

  test(`Math vs V8 (optimize ${optimize}): pow and **`, () => {
    const m = run(SRC, { optimize })
    const ps = PAIRS.pow, arg = i => `pow(${ps[i].map(show)})`
    // the special cases V8 answers itself or by C99's rules: exact on every platform
    const special = ([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x === 0 || x === 1 || x === -1 || y === 0 || y === 1 || y === 2 || y === 0.5 || (x < 0 && !Number.isInteger(y))
    const sp = ps.filter(special)
    is(report(differ(sp.map(([x, y]) => m.pow(x, y)), sp.map(([x, y]) => Math.pow(x, y)), i => `pow(${sp[i].map(show)})`)), 'all agree', `${sp.length} special pairs against the host`)
    const twin = ps.map(([x, y]) => powFold(x, y))
    is(report(differ(ps.map(([x, y]) => m.pow(x, y)), twin, arg)), 'all agree', `Math.pow, ${ps.length} pairs, against the constant folder`)
    is(report(differ(ps.map(([x, y]) => m.powE(x, y)), twin, arg)), 'all agree', '** against the constant folder')
    is(report(differ(m.powA(Float64Array.from(ps, p => p[0]), Float64Array.from(ps, p => p[1])), twin, arg)), 'all agree', '** in a loop')
    // a constant exponent folds only where V8's answer is an expression (2, ½); every one
    // agrees with the runtime pow at that exponent, and 2 and ½ with the host too
    const xs = ARGS.exp
    for (const [n, c] of Object.entries(CONST_EXP))
      is(report(differ(xs.map(x => m[n](x)), xs.map(x => m.pow(x, c)), i => `${show(xs[i])} ** ${c}`)), 'all agree', `x ** ${c}`)
    for (const [n, c] of [['p2', 2], ['ph', 0.5]])
      is(report(differ(xs.map(x => m[n](x)), xs.map(x => Math.pow(x, c)), i => `${show(xs[i])} ** ${c}`)), 'all agree', `x ** ${c} against the host`)
    is(report(differ(xs.map(y => m.two(y)), xs.map(y => m.pow(2, y)), i => `2 ** ${show(xs[i])}`)), 'all agree', '2 ** y is pow(2, y)')
    is(report(differ(m.twoA(Float64Array.from(xs)), xs.map(y => m.pow(2, y)), i => `2 ** ${show(xs[i])}`)), 'all agree', '2 ** y in a loop')
    // a constant base folds its log (the kernel's first half) and agrees with the runtime pow
    for (const [i, c] of CONST_BASE.entries()) {
      const ys = [...xs, ...ps.map(p => p[1])]
      is(report(differ(ys.map(y => m[`b${i}`](y)), ys.map(y => m.pow(c, y)), j => `${c} ** ${show(ys[j])}`)), 'all agree', `${c} ** y`)
    }
  })
}

test('Math vs V8: constant folding computes what the runtime computes', () => {
  const lit = (v) => Object.is(v, -0) ? '-0' : String(v)
  const LITS = [0.1, -0.5, 2, 3 * Math.PI, 1e22, 6381956970095103 * 2 ** 797, 709.78, 5e-324, 0.7, 1.25]
  const fns = Object.keys(MATH_KERNEL).map(k => k.slice(5)).filter(f => f !== 'atan2' && f !== 'hypot')
  const src = [
    ...fns.map(f => `export let k_${f} = () => [${LITS.map(v => `Math.${f}(${lit(v)})`).join(', ')}]\nexport let r_${f} = (x) => Math.${f}(x)`),
    `export let k_pow = () => [${LITS.flatMap(a => [2.4, 3, -1, 0.5, -0.5].map(b => `Math.pow(${lit(a)}, ${lit(b)})`)).join(', ')}]`,
    'export let r_pow = (x, y) => Math.pow(x, y)',
  ].join('\n')
  const m = run(src)
  for (const f of fns) is(report(differ(m[`k_${f}`](), LITS.map(v => m[`r_${f}`](v)), i => `${f}(${LITS[i]})`)), 'all agree', `${f} folded`)
  const pw = LITS.flatMap(a => [2.4, 3, -1, 0.5, -0.5].map(b => [a, b]))
  is(report(differ(m.k_pow(), pw.map(([a, b]) => m.r_pow(a, b)), i => `pow(${pw[i]})`)), 'all agree', 'pow folded')
})
