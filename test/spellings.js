// Loop-spelling gate: a loop costs what it costs however it is spelled.
//
// Every corpus program (scripts/perf-corpus.mjs) in every loop style, and the
// hand kernels below in every spelling, against the default style (a kernel's
// first spelling), at level 2 and at 'speed':
//  (a) each call answers what the default's answers, and what Node answers;
//  (b) each call enters loops of no more ops (test/_loop-ops.js) than the
//      default's same call;
//  (c) the entry's functions hold a SIMD op iff the default's do.
// (a) is correctness: a difference is a miscompile, never listed. A (b) or (c)
// gap of today is listed in test/spellings.json: `ops`, the ops the calls enter
// past the default's, summed over the calls that exceed it, and `simd`, 'lost'
// or 'gained'. A cell fails on a gap not listed, on more ops than listed, and on
// a listed gap it no longer has, so the list only shrinks. Rewrite it with
// `node test/spellings.js --update`.
// (b) holds a spelling to the default's cost, not the default to a spelling's: a
// cheaper spelling passes (the ring kernel's first, `% M`, costs more than five of
// its six others). A loop counts once a call enters it, whatever its trips, and a
// scalar loop counts fewer ops than its vector form, which (c) catches.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import parseWat from 'watr/parse'
import { CATEGORIES, STYLES, genProgram } from '../scripts/perf-corpus.mjs'
import { onWasi } from './_matrix.js'
import { compile, oracle } from './util.js'
import { loopBodyOps, runEntered, NUMERIC_CALLS, ARRAY_CALLS } from './_loop-ops.js'

// Two seeds a category: a compile of slice or condref, which link most of the
// runtime, takes about 0.6 s, the rest 10 to 70 ms; ten spellings at two
// levels cost about 27 s a seed.
const SEEDS = 2
const LEVELS = [2, 'speed']
const KNOWN = join(import.meta.dirname, 'spellings.json')
const SIMD = /"(v128|[if](8x16|16x8|32x4|64x2))\./

// The review's probe kernels, each spelling of the same work; the first is the
// reference. `sum` reads the whole output, so (a) sees every store.
const N1 = `const N = 1024
const a = new Float64Array(N), b = new Float64Array(N)
export let init = () => { for (let i = 0; i < N; i++) { a[i] = i * 0.5; b[i] = i + 1 } }
`
const ringBody = (step, idx = 'p', pre = '') => `let p = 0, s = 0; for (let i = 0; i < N; i++) { ${pre}s += x[i] - ring[${idx}]; ring[${idx}] = x[i]; y[i] = s; ${step} } return y[N - 1]`
const KERNELS = {
  dot: {
    pre: N1,
    calls: ['init', 'run'],
    spellings: {
      'for i<N i++ (canonical)': `let s = 0; for (let i = 0; i < N; i++) s += a[i] * b[i]; return s`,
      'for N>i ++i': `let s = 0; for (let i = 0; N > i; ++i) s += a[i] * b[i]; return s`,
      'for i<=N-1': `let s = 0; for (let i = 0; i <= N - 1; i++) s += a[i] * b[i]; return s`,
      'for i!==N i=1+i': `let s = 0; for (let i = 0; i !== N; i = 1 + i) s += a[i] * b[i]; return s`,
      'while i-=-1': `let s = 0, i = 0; while (i < N) { s += a[i] * b[i]; i -= -1 } return s`,
      'step via const one': `const one = 1; let s = 0; for (let i = 0; i < N; i += one) s += a[i] * b[i]; return s`,
      'index via temp j': `let s = 0; for (let i = 0; i < N; i++) { const j = i; s += a[j] * b[j] } return s`,
      'two counters i,k': `let s = 0; for (let i = 0, k = 0; i < N; i++, k++) s += a[i] * b[k]; return s`,
      'do-while': `let s = 0, i = 0; do { s += a[i] * b[i]; i++ } while (i < N); return s`,
      'while(true) break': `let s = 0, i = 0; while (true) { if (i >= N) break; s += a[i] * b[i]; i++ } return s`,
      'bound a.length': `let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s`,
      // the sum reversed: every product and partial sum here is a multiple of 0.5 below 2^53, exact in any order
      'reverse i--': `let s = 0; for (let i = N - 1; i >= 0; i--) s += a[i] * b[i]; return s`,
      's = s + x': `let s = 0; for (let i = 0; i < N; i++) { const x = a[i] * b[i]; s = s + x } return s`,
      'for-of + idx': `let s = 0, i = 0; for (const x of a) { s += x * b[i]; i++ } return s`,
      'forEach': `let s = 0; a.forEach((x, i) => { s += x * b[i] }); return s`,
      'reduce': `return a.reduce((s, x, i) => s + x * b[i], 0)`,
    },
  },
  map: {
    pre: N1 + `const c = new Float64Array(N)
export let sum = () => { let t = 0; for (let i = 0; i < N; i++) t += c[i]; return t }
`,
    calls: ['init', 'run', 'sum'],
    spellings: {
      'for i<N i++ (canonical)': `for (let i = 0; i < N; i++) c[i] = a[i] * 2.5 + b[i]; return c[7]`,
      'while i-=-1': `let i = 0; while (i < N) { c[i] = a[i] * 2.5 + b[i]; i -= -1 } return c[7]`,
      'for i!==N i=1+i': `for (let i = 0; i !== N; i = 1 + i) c[i] = a[i] * 2.5 + b[i]; return c[7]`,
      'index via temp j': `for (let i = 0; i < N; i++) { const j = i; c[j] = a[j] * 2.5 + b[j] } return c[7]`,
      'temp value t': `for (let i = 0; i < N; i++) { let t = a[i]; t *= 2.5; t += b[i]; c[i] = t } return c[7]`,
      'do-while': `let i = 0; do { c[i] = a[i] * 2.5 + b[i]; i++ } while (i < N); return c[7]`,
      'while(true) break': `let i = 0; while (true) { if (i >= N) break; c[i] = a[i] * 2.5 + b[i]; i++ } return c[7]`,
      'reverse i--': `for (let i = N - 1; i >= 0; i--) c[i] = a[i] * 2.5 + b[i]; return c[7]`,
      'step 2 manual pair': `for (let i = 0; i < N; i += 2) { c[i] = a[i] * 2.5 + b[i]; c[i + 1] = a[i + 1] * 2.5 + b[i + 1] } return c[7]`,
      'offset idx i-1': `for (let i = 1; i <= N; i++) c[i - 1] = a[i - 1] * 2.5 + b[i - 1]; return c[7]`,
      'helper fn': `const f = (x, y) => x * 2.5 + y; for (let i = 0; i < N; i++) c[i] = f(a[i], b[i]); return c[7]`,
      'ternary bound': `const n = N > 0 ? N : 0; for (let i = 0; i < n; i++) c[i] = a[i] * 2.5 + b[i]; return c[7]`,
    },
  },
  ring: {
    pre: `const M = 16, N = 4096
const ring = new Float64Array(M), x = new Float64Array(N), y = new Float64Array(N)
export let init = () => { for (let i = 0; i < N; i++) x[i] = (i * 7 % 13) - 6 }
export let sum = () => { let t = 0; for (let i = 0; i < N; i++) t += y[i]; return t }
`,
    calls: ['init', 'run', 'sum'],
    spellings: {
      'p=(p+1)%M (canonical)': ringBody('p = (p + 1) % M'),
      'p++; if(p===M)p=0': ringBody('p++; if (p === M) p = 0'),
      'if(++p>=M)p-=M': ringBody('if (++p >= M) p -= M'),
      'p=p+1===M?0:p+1': ringBody('p = p + 1 === M ? 0 : p + 1'),
      'p=(p+1)&(M-1)': ringBody('p = (p + 1) & (M - 1)'),
      'idx i%M no cursor': ringBody('', 'q', 'const q = i % M; '),
      'step first, use old q': ringBody('', 'q', 'const q = p; p = (p + 1) % M; '),
    },
  },
}

// What each call answers: its return and its array arguments after it.
const answer = (ret, args) => [ret, ...args.filter(a => typeof a === 'object').map(a => Array.from(a))]
const same = (a, b) => Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i])) : Object.is(a, b)
const show = v => JSON.stringify(v, (k, x) => Object.is(x, -0) ? '-0' : typeof x === 'number' && !isFinite(x) ? String(x) : x).slice(0, 200)

// The entry's functions: `$f`, its export wrapper and its element-kind variants.
const hasSimd = (tree, entry) => tree.some(n => Array.isArray(n) && n[0] === 'func' &&
  (n[1] === '$' + entry || String(n[1]).startsWith(`$${entry}$`)) && SIMD.test(JSON.stringify(n)))

// A program at a level: what each call answers, the ops of the loops entered
// at instantiation and by each call, and whether the entry holds a SIMD op.
const measure = (src, level, calls, entry) => {
  const tree = parseWat(compile(src, { optimize: level, wat: true }))
  const { start, runs } = runEntered(tree, calls)
  return {
    out: runs.map((r, i) => answer(r.ret, calls[i][1])),
    ops: [start, ...runs.map(r => r.loops)].map(s => loopBodyOps(tree, s)),
    simd: hasSimd(tree, entry),
  }
}
const node = (src, calls) => { const m = oracle(src); return calls.map(([name, args]) => answer(m[name](...args), args)) }

const gapOf = (m, ref) => {
  const ops = m.ops.reduce((s, n, i) => s + Math.max(0, n - ref.ops[i]), 0), g = {}
  if (ops) g.ops = ops
  if (m.simd !== ref.simd) g.simd = m.simd ? 'gained' : 'lost'
  return g
}

// One group of cells at one level: a reference program and its respellings.
// `calls()` builds fresh arguments: the array programs write into theirs.
// Returns the differing answers and the gaps by cell.
const sweep = (prefix, ref, variants, calls, entry, level) => {
  const bad = [], gaps = {}
  const check = (name, src, m) => {
    const want = node(src, calls())
    if (!same(m.out, want)) bad.push(`${prefix}/${name}/${level}: jz ${show(m.out)}, node ${show(want)}\n  ${src}`)
  }
  const r = measure(ref, level, calls(), entry)
  check('reference', ref, r)
  for (const [name, src] of variants) {
    const m = measure(src, level, calls(), entry)
    check(name, src, m)
    if (!same(m.out, r.out)) bad.push(`${prefix}/${name}/${level}: jz ${show(m.out)}, its reference ${show(r.out)}\n  ${src}`)
    const g = gapOf(m, r)
    if (g.ops || g.simd) gaps[`${prefix}/${name}/${level}`] = g
  }
  return { bad, gaps }
}

const callsOf = cat => () => (NUMERIC_CALLS[cat] ?? ARRAY_CALLS[cat]()).map(args => ['f', args])
const styled = (cat, s) => Object.keys(STYLES).filter(st => st !== 'default').map(st => [st, genProgram(cat, s, st)])
const corpus = (cat, level) => {
  const out = { bad: [], gaps: {} }
  for (let s = 1; s <= SEEDS; s++) {
    const { bad, gaps } = sweep(`${cat}/${s}`, genProgram(cat, s), styled(cat, s), callsOf(cat), 'f', level)
    out.bad.push(...bad); Object.assign(out.gaps, gaps)
  }
  return out
}
const kernel = (name, level) => {
  const k = KERNELS[name], [[, ref], ...rest] = Object.entries(k.spellings)
  const src = body => k.pre + 'export let run = () => { ' + body + ' }\n'
  return sweep(`kernel/${name}`, src(ref), rest.map(([n, b]) => [n, src(b)]), () => k.calls.map(c => [c, []]), 'run', level)
}

// Every cell the gate measures, by key; no compile.
const cells = () => [
  ...Object.keys(CATEGORIES).flatMap(cat => Array.from({ length: SEEDS }, (_, i) => styled(cat, i + 1).map(([st]) => `${cat}/${i + 1}/${st}`)).flat()),
  ...Object.entries(KERNELS).flatMap(([name, k]) => Object.keys(k.spellings).slice(1).map(s => `kernel/${name}/${s}`)),
].flatMap(c => LEVELS.map(l => `${c}/${l}`))

// A cell's gaps against what the table lists for it.
const verdict = (key, g = {}, k = {}) => {
  const bad = []
  if (g.ops && !k.ops) bad.push(`${key}: ${g.ops} ops past the default, not listed`)
  else if (g.ops > k.ops) bad.push(`${key}: ${g.ops} ops past the default, listed ${k.ops}`)
  else if (!g.ops && k.ops) bad.push(`${key}: no ops past the default now, remove its ops`)
  if (g.simd !== k.simd) bad.push(`${key}: ${g.simd ? `${g.simd} SIMD` : 'SIMD as the default'}, listed ${k.simd ?? 'none'}`)
  return bad
}

const GROUPS = [
  ...Object.keys(CATEGORIES).map(cat => [cat, `${cat}/`, level => corpus(cat, level)]),
  ...Object.keys(KERNELS).map(name => [`kernel ${name}`, `kernel/${name}/`, level => kernel(name, level)]),
]

if (process.argv.includes('--update')) {
  const known = {}, bad = []
  for (const [, , run] of GROUPS) for (const level of LEVELS) {
    const r = run(level)
    bad.push(...r.bad); Object.assign(known, r.gaps)
  }
  const keys = cells().filter(k => known[k])
  writeFileSync(KNOWN, '{\n' + keys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(known[k])}`).join(',\n') + '\n}\n')
  console.log(`spellings: ${keys.length} gaps of ${cells().length} cells written to ${KNOWN}`)
  if (bad.length) { console.error(`answers differ, not listed:\n${bad.join('\n')}`); process.exitCode = 1 }
} else {
  const known = JSON.parse(readFileSync(KNOWN, 'utf8'))
  test('spellings: every listed gap names a cell the gate measures', () => {
    const all = new Set(cells()), stale = Object.keys(known).filter(k => !all.has(k))
    ok(!stale.length, stale.length ? `not measured: ${stale.join(', ')}` : 'listed cells')
  })
  for (const [name, prefix, run] of GROUPS) for (const level of LEVELS) {
    test(`spellings: ${name} at ${level === 2 ? 'level 2' : level} answers and costs what the default spelling does`, () => {
      if (onWasi()) return   // the counts are the JS host's, as perf-ratchet's are
      const { bad, gaps } = run(level)
      ok(!bad.length, bad.length ? `answers differ, a miscompile or a spelling of other work:\n${bad.join('\n')}` : 'every spelling answers what the default and Node answer')
      const keys = cells().filter(k => k.startsWith(prefix) && k.endsWith(`/${level}`))
      const off = keys.flatMap(k => verdict(k, gaps[k], known[k]))
      ok(!off.length, off.length ? `${off.join('\n')}\nIf a gap closed or moved, rewrite the table: node test/spellings.js --update` : 'gaps as listed')
    })
  }
}
