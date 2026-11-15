// Vector coverage gate: which of the alias battery's loops a lift takes, as a table that only grows.
//
// Each loop reads and writes arrays that may be one array: 28 kernels `(d, s, n)` over five
// element types, `d` and `s` two views of one buffer made three ways (subarrays, constructors
// over the buffer, the same view twice), `off` and `n` given at run time. At level 2 and at
// 'speed' a program's mark is V where its kernel adds a v128 instruction to the module (the
// same program with an empty kernel the measure), c where it adds a bulk copy or fill alone,
// . where neither. Every program also answers what Node answers on every (off, n) of the grid.
// test/vector-coverage.json lists each kernel's marks, one a program in TYPES × VIEWS order, by
// level. A kernel fails on any difference from its listing: a mark lost is a lift lost; a mark
// gained is a lift to list, `node test/vector-coverage.js --update`, after the review of its
// legality. The table is the JS host's: under wasi the tests return.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { onWasi } from './_matrix.js'
import { compile, oracle, run } from './util.js'

const KNOWN = join(import.meta.dirname, 'vector-coverage.json')
const LEVELS = [2, 'speed']
const TYPES = {
  f64: ['Float64Array', 'i * 37 % 23 - 11 + i % 4 * 0.25'],
  f32: ['Float32Array', 'i * 37 % 23 - 11 + i % 4 * 0.25'],
  i32: ['Int32Array', '(i * 40503 * 65537) | 0'],
  i16: ['Int16Array', 'i * 2053 % 65536 - 32768'],
  u8: ['Uint8Array', 'i * 37 % 251'],
}
// (d, s, n) each; every kernel returns a number
const KERN = {
  copy: 'for (let i = 0; i < n; i++) d[i] = s[i]; return 0',
  map: 'for (let i = 0; i < n; i++) d[i] = s[i] * 2 + 1; return 0',
  acc2: 'for (let i = 0; i < n; i++) d[i] = d[i] + s[i]; return 0',
  next: 'for (let i = 0; i + 1 < n; i++) d[i] = s[i + 1] + s[i]; return 0',
  prev: 'for (let i = 1; i < n; i++) d[i] = s[i - 1] - s[i]; return 0',
  sten: 'for (let i = 1; i + 1 < n; i++) d[i] = s[i - 1] + s[i] * 2 + s[i + 1]; return 0',
  first: 'for (let i = 0; i < n; i++) d[i] = s[0] + i; return 0',
  lastEl: 'if (n > 0) for (let i = 0; i < n; i++) d[i] = s[n - 1] - i; return 0',
  scale0: 'for (let i = 0; i < n; i++) d[i] = s[i] * d[0]; return 0',
  prefix: 'let acc = 0; for (let i = 0; i < n; i++) { acc += s[i]; d[i] = acc } return acc',
  dot: 'let acc = 0; for (let i = 0; i < n; i++) acc += s[i] * d[i]; return acc',
  sum: 'let acc = 0; for (let i = 0; i < n; i++) acc += s[i]; return acc',
  two: 'for (let i = 0; i < n; i++) { d[i] = s[i] + 1; s[i] = d[i] * 2 } return 0',
  swap: 'for (let i = 0; i < n; i++) { const t = d[i]; d[i] = s[i]; s[i] = t } return 0',
  cond: 'for (let i = 0; i < n; i++) if (s[i] > 0) d[i] = s[i] * 2; return 0',
  tern: 'for (let i = 0; i < n; i++) d[i] = s[i] > 0 ? s[i] : -s[i]; return 0',
  last: 'let last = -1; for (let i = 0; i < n; i++) { last = s[i]; d[i] = last + 1 } return last',
  count: 'let i = 0; for (; i < n; i++) d[i] = s[i] + 3; return i',
  min: 'let m = Infinity; for (let i = 0; i < n; i++) m = Math.min(m, s[i]); return m',
  minIf: 'let m = 1e9; for (let i = 0; i < n; i++) if (s[i] < m) m = s[i]; return m',
  rev: 'for (let i = n - 1; i >= 0; i--) d[i] = s[i] + 1; return 0',
  step2: 'for (let i = 0; i < n; i += 2) d[i] = s[i] * 3; return 0',
  cursor: 'let o = 0; for (let i = 0; i < n; i++) { d[o] = s[i]; o += 1 } return o',
  sq: 'for (let i = 0; i < n; i++) d[i] = s[i] * s[i]; return 0',
  fill: 'for (let i = 0; i < n; i++) d[i] = 7; return 0',
  wrap: 'for (let i = 0; i < n; i++) d[i] = s[(i + 1) % n] + 1; return 0',
  tenth: 'for (let i = 0; i < n; i++) d[i] = s[i] * 0.1 + s[i]; return 0',
  third: 'for (let i = 0; i < n; i++) d[i] = s[i] / 3; return 0',
}
// how the two views of one buffer are made (BASE the first element of `d`)
const VIEW = {
  sub: () => 'const d = buf.subarray(16, 16 + n), s = buf.subarray(16 + off, 16 + off + n)',
  ctor: (T) => `const d = new ${T}(buf.buffer, 16 * ${T}.BYTES_PER_ELEMENT, n), s = new ${T}(buf.buffer, (16 + off) * ${T}.BYTES_PER_ELEMENT, n)`,
  same: () => 'const d = buf.subarray(16, 16 + n), s = off === 0 ? d : buf.subarray(16 + off, 16 + off + n)',
}
const program = (T, seed, kern, view) => `
const N = 64
const mk = () => { const b = new ${T}(N); for (let i = 0; i < N; i++) b[i] = ${seed}; return b }
const kern = (d, s, n) => { ${kern} }
const sum = (b) => { let h = 0; for (let i = 0; i < N; i++) h = (h * 31) % 1000003 + b[i] * (i + 1); return h }
export const f = (off, n) => {
  const w = mk(), x = mk()
  const r0 = kern(w.subarray(0, 4), x.subarray(8, 12), 4)
  const buf = mk()
  ${view(T)}
  const r = kern(d, s, n)
  return sum(buf) + r * 7 + sum(w) + r0
}`
const ARGS = []
for (const off of [-9, -8, -7, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 7, 8, 9]) for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 24]) ARGS.push([off, n])

const SIMD = /v128\.|[if](8x16|16x8|32x4|64x2)\./g, BULK = /memory\.copy|memory\.fill/g
const count = (wat, re) => (wat.match(re) || []).length
const blanks = new Map()
// The module beside the kernel: the same program with an empty kernel, once a type, view and level.
const blank = (t, v, level) => {
  const key = `${t}/${v}/${level}`
  if (!blanks.has(key)) blanks.set(key, compile(program(TYPES[t][0], TYPES[t][1], 'return 0', VIEW[v]), { optimize: level, wat: true }))
  return blanks.get(key)
}
const show = v => Object.is(v, -0) ? '-0' : String(v)

// One kernel at one level: its marks in TYPES × VIEWS order, and the answers that differ from Node's.
const measure = (k, level) => {
  let marks = ''
  const bad = []
  for (const [t, [T, seed]] of Object.entries(TYPES)) for (const v of Object.keys(VIEW)) {
    const src = program(T, seed, KERN[k], VIEW[v])
    const wat = compile(src, { optimize: level, wat: true }), base = blank(t, v, level)
    marks += count(wat, SIMD) > count(base, SIMD) ? 'V' : count(wat, BULK) > count(base, BULK) ? 'c' : '.'
    const want = oracle(src).f, got = run(src, { optimize: level }).f
    for (const [off, n] of ARGS) {
      const a = got(off, n), b = want(off, n)
      if (!Object.is(a, b)) { bad.push(`${k} ${t} ${v} at ${level} (off ${off}, n ${n}): jz ${show(a)}, node ${show(b)}`); break }
    }
  }
  return { marks, bad }
}

if (process.argv.includes('--update')) {
  if (onWasi()) throw new Error('vector-coverage: the table is the JS host\'s; run --update without JZ_TEST_HOST=wasi')
  const known = {}, bad = []
  for (const k of Object.keys(KERN)) {
    known[k] = {}
    for (const level of LEVELS) { const m = measure(k, level); known[k][level] = m.marks; bad.push(...m.bad) }
  }
  writeFileSync(KNOWN, '{\n' + Object.entries(known).map(([k, r]) => `  ${JSON.stringify(k)}: ${JSON.stringify(r)}`).join(',\n') + '\n}\n')
  const n = Object.values(known).reduce((s, r) => s + LEVELS.reduce((c, l) => c + count(r[l], /[Vc]/g), 0), 0)
  console.log(`vector-coverage: ${n} of ${Object.keys(KERN).length * LEVELS.length * 15} marks taken, written to ${KNOWN}`)
  if (bad.length) { console.error(`answers differ:\n${bad.join('\n')}`); process.exitCode = 1 }
} else {
  const known = JSON.parse(readFileSync(KNOWN, 'utf8'))
  test('vector coverage: the table lists every kernel at every level', () => {
    const missing = Object.keys(KERN).flatMap(k => LEVELS.filter(l => typeof known[k]?.[l] !== 'string' || known[k][l].length !== 15).map(l => `${k} at ${l}`))
    ok(!missing.length, missing.length ? `not listed: ${missing.join(', ')}` : 'listed')
  })
  for (const k of Object.keys(KERN)) for (const level of LEVELS) {
    test(`vector coverage: ${k} at ${level === 2 ? 'level 2' : level} lifts as listed and answers what Node answers`, () => {
      if (onWasi()) return
      const { marks, bad } = measure(k, level), want = known[k][level]
      ok(!bad.length, bad.length ? bad.join('\n') : 'answers as Node')
      const lost = [...want].filter((c, i) => c !== '.' && marks[i] !== c).length, gained = [...marks].filter((c, i) => c !== '.' && want[i] !== c).length
      ok(marks === want, marks === want ? 'marks as listed' : `marks ${marks}, listed ${want}: ${lost} lifts lost${gained ? `, ${gained} gained (node test/vector-coverage.js --update)` : ''}`)
    })
  }
}
