// jz's Math against the host's (V8's) Math, in ulps, over three argument sets:
//
//   corpus  every argument the floatbeat corpus (examples/jukebox/floatbeats.js)
//           passes a Math function, sample by sample, over each beat's first 0.5 s
//   kpi2    the double nearest k·π/2 for k = 1..1e6 (π/2 at 256 bits) and its
//           ±1..4-ulp neighbours, and the negatives for k ≤ 1e5 (sin, cos, tan):
//           the arguments whose reduction cancels the most
//   wide    200k seeded random arguments per function: log-uniform magnitudes,
//           both signs, the domain's edges (near 0, near ±1, subnormals, up to
//           1e300 for the trigonometric functions)
//   edge    signed zeros, infinities, NaN, the extreme magnitudes and the domain
//           boundaries (every pair of them for the two-argument functions)
//
// Each function runs compiled twice, scalar ({ level: 2, noSimd: true }) and at
// the speed level, whose loop may take the two-lane kernel; the table reports the
// scalar kernel against the host, `lanes≠` counts where the two builds disagree,
// and `fold≠` where the constant folder (src/prepare/math-kernel.js) disagrees
// with the scalar kernel (a call it leaves for run time does not count). The
// distance is the bit-ordinal one (test/util.js ulpDiff): 1 between -0 and +0,
// Infinity where one side is NaN.
//
//   node scripts/math-ulp.mjs [root] [--json out.json] [--only sin,cos] [--sets corpus,kpi2,wide,edge]
//
// `root` is a jz checkout (default: this one), so two builds can be measured by
// the same script.
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1] }
const jsonOut = opt('--json'), only = opt('--only')?.split(','), sets = (opt('--sets') || 'corpus,kpi2,wide,edge').split(',')
const root = argv[0] ? pathToFileURL(resolve(argv[0])).href : new URL('..', import.meta.url).href
const at = (p) => new URL(p, root.endsWith('/') ? root : root + '/').href
const { compile } = await import(at('index.js'))
const { instantiate } = await import(at('interop.js'))
const { FLOATBEATS } = await import(at('examples/jukebox/floatbeats.js'))
const { MATH_KERNEL, powFold, powRuntime } = await import(at('src/prepare/math-kernel.js'))

// ── the functions: name, arity, jz expression, host function ──────────────────
const UNARY = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'cbrt']
const FNS = [
  ...UNARY.map(n => ({ name: n, arity: 1, expr: `Math.${n}(a[i])`, host: Math[n], fold: (x) => MATH_KERNEL['math.' + n](x) })),
  { name: 'atan2', arity: 2, expr: 'Math.atan2(a[i], b[i])', host: Math.atan2, fold: (y, x) => MATH_KERNEL['math.atan2'](y, x) },
  { name: 'hypot', arity: 2, expr: 'Math.hypot(a[i], b[i])', host: Math.hypot, fold: (x, y) => MATH_KERNEL['math.hypot'](x, y) },
  // a runtime exponent: $math.pow, whose twin is the folder's powRuntime
  { name: 'pow', arity: 2, expr: 'Math.pow(a[i], b[i])', host: Math.pow, fold: powRuntime ?? powFold },
  // `**`: a runtime exponent is Math.pow's kernel; the constant exponents take their own
  // lowerings (module/math.js emitPow), which the folder's powFold mirrors: the
  // square-and-multiply fold, the k/5 fold, exp2 for base 2, the pow kernel otherwise
  { name: 'x**y', arity: 2, expr: 'a[i] ** b[i]', host: (x, y) => x ** y, fold: powRuntime ?? powFold },
  ...[2, 3, 7, 16, -1, -3, 0.5, 2.4, 0.2, 1 / 2.4, 1 / 3, 0.45, 2.2].map(c => ({
    name: `x**${+c.toPrecision(6)}`, arity: 1, expr: `a[i] ** ${c}`, host: (x) => x ** c, fold: (x) => powFold(x, c), pw: c })),
  { name: '2**x', arity: 1, expr: '2 ** a[i]', host: (x) => 2 ** x, fold: (x) => powFold(2, x) },
].filter(f => !only || only.includes(f.name))
const id = (f) => 'k' + FNS.indexOf(f)

// ── the compiled kernels: one loop per function, scalar and at the speed level ──
const src = FNS.map(f => `export let ${id(f)} = (${f.arity === 2 ? 'a, b' : 'a'}, o, n) => { for (let i = 0; i < n; i++) o[i] = ${f.expr} }`).join('\n')
const build = (optimize) => {
  const { exports, memory } = instantiate(compile(src, { optimize }))
  const C = 1 << 18, [A, B, O] = [0, 1, 2].map(() => { const { view, box } = memory.allocTyped(Float64Array, C); return { off: view.byteOffset, box } })
  // a view over the region as the buffer is now: a growth detaches the old one
  const view = (h) => new Float64Array(memory.buffer, h.off, C)
  // run f over (xs, ys) chunk by chunk into a fresh array
  return (f, xs, ys) => {
    const out = new Float64Array(xs.length)
    for (let s = 0; s < xs.length; s += C) {
      const n = Math.min(C, xs.length - s)
      view(A).set(xs.subarray(s, s + n))
      if (ys) view(B).set(ys.subarray(s, s + n))
      if (ys) exports[id(f)](A.box, B.box, O.box, n)
      else exports[id(f)](A.box, O.box, n)
      out.set(view(O).subarray(0, n), s)
    }
    return out
  }
}
const scalar = build({ level: 2, noSimd: true }), lanes = build(3)
// the two-lane kernels (module/math/simd.js) a loop's lifted body calls
const laneWat = compile(src, { optimize: 3, wat: true })
const funcText = (name) => {
  const m = new RegExp(`\\(func \\$${name}(?=[\\s)])`).exec(laneWat)
  if (!m) return ''
  const i = m.index
  for (let d = 0, j = i; j < laneWat.length; j++) { d += laneWat[j] === '(' ? 1 : laneWat[j] === ')' ? -1 : 0; if (!d) return laneWat.slice(i, j + 1) }
  return ''
}
const lifted = (f) => [...new Set(funcText(id(f)).match(/\$math\.(sin2|cos2|pow2|\w+_v|\w+_2)\b/g) || [])].join(',')

// ── ulp distance (test/util.js ulpDiff, over typed arrays) ─────────────────────
const F = new Float64Array(1), U = new BigUint64Array(F.buffer)
const ord = (x) => { F[0] = x; const u = U[0]; return u < 0x8000000000000000n ? u + 0x8000000000000000n : 0xFFFFFFFFFFFFFFFFn - u }
const ulp = (a, b) => {
  if (Object.is(a, b)) return 0
  if (a !== a || b !== b) return (a !== a && b !== b) ? 0 : Infinity
  const oa = ord(a), ob = ord(b)
  return Number(oa > ob ? oa - ob : ob - oa)
}
const bitsOf = (x) => { F[0] = x; return U[0] }
const ofBits = (b) => { U[0] = BigInt.asUintN(64, b); return F[0] }
const show = (x) => Object.is(x, -0) ? '-0' : String(x)

// ── argument sets ──────────────────────────────────────────────────────────────
// xorshift128+, seeded: the same arguments on every run
let s0 = 0x9e3779b97f4a7c15n, s1 = 0xbf58476d1ce4e5b9n
const rnd = () => {
  let x = s0; const y = s1; s0 = y
  x ^= (x << 23n) & 0xFFFFFFFFFFFFFFFFn; x ^= x >> 17n; x ^= y ^ (y >> 26n); s1 = x
  return Number((x + y) & 0x1FFFFFFFFFFFFFn) / 2 ** 53
}
// log-uniform magnitude in [2^lo, 2^hi), a uniformly random mantissa
const logU = (lo, hi) => (1 + rnd()) * 2 ** Math.floor(lo + rnd() * (hi - lo))
const sgn = (x) => rnd() < 0.5 ? -x : x
const N_WIDE = 200000
const gen = (n, f) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = f(i); return a }
// the domain of each function, as a mix of generators
const near = (c, lo, hi) => () => c + sgn(logU(lo, hi))          // c ± a log-uniform offset
const pick = (...gs) => () => gs[Math.floor(rnd() * gs.length)]()
const wideArgs = {
  trig: pick(() => sgn(logU(-30, 5)), () => sgn(logU(-30, 5)), () => sgn(logU(5, 22)), () => sgn(logU(22, 1000)),
    () => sgn(logU(-1074, -30)), () => sgn(rnd() * 2 ** 20)),
  unit: pick(() => sgn(rnd()), () => sgn(1 - logU(-53, -1)), () => sgn(logU(-60, -1)), () => sgn(logU(-1074, -60))),
  real: pick(() => sgn(logU(-60, 60)), () => sgn(logU(-1074, 1024)), () => sgn(rnd() * 4)),
  hyp: pick(() => sgn(logU(-60, 3)), () => sgn(rnd() * 711), () => sgn(logU(-1074, -60)), () => sgn(logU(9, 10))),
  acosh: pick(() => 1 + logU(-52, 0), () => 1 + logU(0, 60), () => logU(60, 1024)),
  atanh: pick(() => sgn(rnd()), () => sgn(1 - logU(-53, -1)), () => sgn(logU(-60, -1)), () => sgn(logU(-1074, -60))),
  exp: pick(() => sgn(rnd() * 745), () => sgn(logU(-60, 3)), () => sgn(logU(-1074, -60))),
  expm1: pick(() => sgn(rnd() * 40), () => rnd() * 710, () => sgn(logU(-60, 1)), () => sgn(logU(-1074, -60))),
  pos: pick(() => logU(-1074, 1024), () => logU(-60, 60), () => 1 + sgn(logU(-53, -1))),
  log1p: pick(() => logU(-1074, 1024), () => sgn(logU(-60, -1)), () => -1 + logU(-53, -1), () => rnd() * 10 - 0.999),
}
const DOMAIN = {
  sin: 'trig', cos: 'trig', tan: 'trig', asin: 'unit', acos: 'unit', atan: 'real', sinh: 'hyp', cosh: 'hyp', tanh: 'hyp',
  asinh: 'real', acosh: 'acosh', atanh: 'atanh', exp: 'exp', expm1: 'expm1', log: 'pos', log2: 'pos', log10: 'pos',
  log1p: 'log1p', cbrt: 'real',
}
const wideSet = (f) => {
  if (f.arity === 2) {
    const n = N_WIDE
    if (f.name === 'atan2') return [gen(n, wideArgs.real), gen(n, wideArgs.real)]
    if (f.name === 'hypot') return [gen(n, pick(() => sgn(logU(-60, 60)), () => sgn(logU(-1074, 1024)))), gen(n, pick(() => sgn(logU(-60, 60)), () => sgn(logU(-1074, 1024))))]
    // pow: a positive base with any finite exponent (a result in range mostly), a
    // negative base with an integer exponent, bases near 1 with large exponents
    const xs = new Float64Array(n), ys = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const k = i % 4
      if (k === 0) { xs[i] = logU(-20, 20); ys[i] = sgn(rnd() * 40) }
      else if (k === 1) { xs[i] = logU(-1074, 1024); ys[i] = sgn(logU(-10, 3)) }
      else if (k === 2) { xs[i] = -logU(-10, 10); ys[i] = Math.round(sgn(rnd() * 60)) }
      else { xs[i] = 1 + sgn(logU(-40, -3)); ys[i] = sgn(logU(0, 40)) }
    }
    return [xs, ys]
  }
  if (f.pw !== undefined) return [gen(N_WIDE, pick(() => rnd() * 2, () => logU(-60, 60), () => logU(-1074, 1024), () => sgn(logU(-20, 20))))]
  if (f.name === '2**x') return [gen(N_WIDE, pick(() => sgn(rnd() * 1100), () => sgn(logU(-60, 4))))]
  return [gen(N_WIDE, wideArgs[DOMAIN[f.name]])]
}

// π/2 at 256 fractional bits (Machin: π = 16·atan(1/5) − 4·atan(1/239))
const P = 256n, ONE = 1n << P
const atanInv = (m) => { let s = 0n, t = ONE / m, k = 1n, sign = 1n; const m2 = m * m; while (t) { s += sign * t / k; t /= m2; k += 2n; sign = -sign } return s }
const PIO2 = (16n * atanInv(5n) - 4n * atanInv(239n)) / 2n
// the double nearest a positive fixed-point value, ties to even
const toDouble = (v) => {
  const L = BigInt(v.toString(2).length), sh = L - 53n
  let m = v >> sh; const r = v - (m << sh), half = 1n << (sh - 1n)
  if (r > half || (r === half && (m & 1n))) m += 1n
  return Number(m) * 2 ** Number(sh - P)
}
// the edges every function must get right: signed zeros, infinities, NaN, the
// extreme finite magnitudes, and the domains' boundaries
const EDGE = [0, -0, Infinity, -Infinity, NaN, 1, -1, 0.5, -0.5, 2, -2, 5e-324, -5e-324, 2.2250738585072014e-308,
  -2.2250738585072014e-308, 1.7976931348623157e308, -1.7976931348623157e308, Math.PI, -Math.PI, Math.PI / 2, -Math.PI / 2,
  Math.PI / 4, 1 - 2 ** -53, -(1 - 2 ** -53), 1 + 2 ** -52, 2 ** -28, 2 ** 28, 709.782712893384, 710.4758600739439,
  -745.1332191019412, 1e300, -1e300, 2 ** 1023, 2 ** -1022]
const edgeSet = (f) => {
  if (f.arity === 1) return [Float64Array.from(EDGE)]
  const xs = [], ys = []
  for (const x of EDGE) for (const y of EDGE) { xs.push(x); ys.push(y) }
  return [Float64Array.from(xs), Float64Array.from(ys)]
}
const kpi2Set = () => {
  const K = 1000000, KN = 100000, out = new Float64Array(9 * (K + KN)); let j = 0
  for (let k = 1; k <= K + KN; k++) {
    const x = toDouble(BigInt(k <= K ? k : k - K) * PIO2) * (k <= K ? 1 : -1), b = bitsOf(x)
    for (let d = -4; d <= 4; d++) out[j++] = ofBits(b + BigInt(d))
  }
  return [out]
}

// the corpus: run every beat under a Math whose functions record their arguments
const corpusArgs = () => {
  const rec = new Map()
  const M = Object.create(null)
  for (const k of Object.getOwnPropertyNames(Math)) {
    const v = Math[k]
    M[k] = typeof v !== 'function' ? v : (...a) => {
      let m = rec.get(k); if (!m) rec.set(k, m = new Map())
      const key = a.map(show).join(',')
      if (!m.has(key)) m.set(key, a.slice())
      return v(...a)
    }
  }
  for (const tn of FLOATBEATS) {
    const beat = new Function('Math', 't', 'return (' + tn.body + ')(t)')
    const N = Math.round(tn.sr * 0.5)
    for (let t = 0; t < N; t++) beat(M, t)
  }
  return rec
}

// ── measure ────────────────────────────────────────────────────────────────────
const measure = (f, args) => {
  const [xs, ys] = args
  const got = scalar(f, xs, ys), two = lanes(f, xs, ys)
  let same = 0, max = 0, worst = 0, over1 = 0, over100 = 0, laneDiff = 0, foldDiff = 0, foldWorst = -1
  for (let i = 0; i < xs.length; i++) {
    const want = ys ? f.host(xs[i], ys[i]) : f.host(xs[i]), u = ulp(got[i], want)
    if (u === 0) same++
    if (u > 1) over1++
    if (u > 100) over100++
    if (u > max) { max = u; worst = i }
    if (!Object.is(got[i], two[i]) && !(got[i] !== got[i] && two[i] !== two[i])) laneDiff++
    // the constant folder: sampled (it runs BigInt bit twiddling in places)
    if (i % 7 === 0) {
      const fv = ys ? f.fold(xs[i], ys[i]) : f.fold(xs[i])
      // undefined: the folder leaves the call for run time
      if (fv !== undefined && !Object.is(fv, got[i]) && !(fv !== fv && got[i] !== got[i])) { foldDiff++; if (foldWorst < 0) foldWorst = i }
    }
  }
  const w = worst
  return {
    n: xs.length, same: same / xs.length, over1, over100, max,
    arg: ys ? [xs[w], ys[w]] : [xs[w]], jz: got[w], host: ys ? f.host(xs[w], ys[w]) : f.host(xs[w]),
    laneDiff, foldDiff, foldArg: foldWorst < 0 ? null : (ys ? [xs[foldWorst], ys[foldWorst]] : [xs[foldWorst]]),
  }
}

const results = {}
let corpus = null
if (sets.includes('corpus')) corpus = corpusArgs()
const HOSTNAME = { 'x**y': 'pow', '2**x': 'pow' }
for (const f of FNS) {
  const r = results[f.name] = { lanes: lifted(f) }
  if (corpus) {
    const m = corpus.get(HOSTNAME[f.name] ?? f.name)
    if (m && f.pw === undefined && f.name !== '2**x') {
      const vs = [...m.values()]
      r.corpus = measure(f, [Float64Array.from(vs, v => v[0]), f.arity === 2 ? Float64Array.from(vs, v => v[1]) : null])
    }
  }
  if (sets.includes('kpi2') && ['sin', 'cos', 'tan'].includes(f.name)) r.kpi2 = measure(f, kpi2Set())
  if (sets.includes('wide')) r.wide = measure(f, wideSet(f))
  if (sets.includes('edge')) r.edge = measure(f, edgeSet(f))
}

// ── report ─────────────────────────────────────────────────────────────────────
const fmtU = (u) => u === Infinity ? 'Inf' : u >= 1e6 ? u.toExponential(1) : String(u)
const row = (name, set, m) => `${name.padEnd(10)} ${set.padEnd(6)} ${String(m.n).padStart(8)} ${(100 * m.same).toFixed(1).padStart(6)}% ` +
  `${String(m.over1).padStart(7)} ${String(m.over100).padStart(7)} ${fmtU(m.max).padStart(9)}  ${m.arg.map(show).join(', ')} → jz ${show(m.jz)} host ${show(m.host)}` +
  (m.laneDiff ? `  lanes≠ ${m.laneDiff}` : '') + (m.foldDiff ? `  fold≠ ${m.foldDiff} (${m.foldArg.map(show).join(', ')})` : '')
console.log(`jz ${fileURLToPath(root)} against node ${process.version} Math (${process.arch})`)
console.log(`${'fn'.padEnd(10)} ${'set'.padEnd(6)} ${'n'.padStart(8)} ${'same'.padStart(7)} ${'>1ulp'.padStart(7)} ${'>100'.padStart(7)} ${'max ulp'.padStart(9)}  worst argument`)
for (const [name, r] of Object.entries(results)) {
  for (const set of ['corpus', 'kpi2', 'wide', 'edge']) if (r[set]) console.log(row(name, set, r[set]))
}
console.log('two-lane kernels:', Object.entries(results).filter(([, r]) => r.lanes).map(([n, r]) => `${n} (${r.lanes})`).join(', ') || 'none')
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, (k, v) => typeof v === 'number' && !Number.isFinite(v) ? String(v) : v, 1))
