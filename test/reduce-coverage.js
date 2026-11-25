// Reduction coverage gate: which ways of writing a reduction over an array the lanes take, as a
// table that only grows.
//
// A reduction is one loop-carried value fed by each element: a sum, a count, an extreme. Each of
// FORMS writes one (the sum by its spellings, taken from its accumulator, of a neighbour, under a
// condition, two in a loop, through a callback), over each of KINDS, the arrays a program holds:
// a plain array of fractions, a plain array of integers, a Float64Array, an Int32Array, a
// Uint8Array. At level 2 and at 'speed' a program's mark is V where its kernel adds a v128
// instruction to the module (the same program with an empty kernel the measure), `.` where it
// adds none, `!` where the compiler refuses the program. Every program that compiles answers what
// Node answers, at both levels: the fractions are quarters, whose sums are exact in any order.
// test/reduce-coverage.json lists each form's marks, one a kind in KINDS' order, by level. A form
// fails on any difference from its listing: a mark lost is a lift lost; a mark gained is a lift
// to list, `node test/reduce-coverage.js --update`. A `.` at 'speed' is a way of writing the loop
// that runs an element a round where another runs two to eight; at level 2 a float sum keeps the
// loop's order, and its `.` is the tier's (README, "Float sums in lanes").
// A V says the kernel is in lanes, not that the lanes win: an Int32Array's sum into a Number is
// in lanes, two elements a round in the loop's order, and ran at 94 ns over 256 elements where
// its scalar loop ran at 72 (2026-11-25, raw calls, an M4; found, not fixed).
// The table is the JS host's: under wasi the tests return.
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { onWasi } from './_matrix.js'
import { compile, jz, oracle } from './util.js'

const KNOWN = join(import.meta.dirname, 'reduce-coverage.json')
const LEVELS = [2, 'speed']
// 67 elements: a strip of eight leaves a remainder, and no loop over them is written out.
const N = 67
const fraction = '((i * 37 + 11) % 64) * 0.25 - 3', integer = '(i * 37 + 11) % 64 - 20'
const KINDS = {
  plain: `const a = []; for (let i = 0; i < N; i++) a.push(${fraction})`,
  words: `const a = []; for (let i = 0; i < N; i++) a.push(${integer})`,
  f64: `const a = new Float64Array(N); for (let i = 0; i < N; i++) a[i] = ${fraction}`,
  i32: `const a = new Int32Array(N); for (let i = 0; i < N; i++) a[i] = ${integer}`,
  u8: `const a = new Uint8Array(N); for (let i = 0; i < N; i++) a[i] = (i * 53 + 7) % 251`,
}
const UP = 'for (let i = 0; i < N; i++)'
const FORMS = {
  'sum': `let s = 0; ${UP} s += a[i]; return s`,
  'sum, accumulator on the right': `let s = 0; ${UP} s = a[i] + s; return s`,
  'sum taken from': `let s = 1000; ${UP} s -= a[i]; return s`,
  'sum under its own length': `let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s`,
  'sum counting down': `let s = 0; for (let i = N - 1; i >= 0; i--) s += a[i]; return s`,
  'sum of the cell before': `let s = 0; for (let i = 1; i < N; i++) s += a[i - 1]; return s`,
  'sum of the cell after': `let s = 0; for (let i = 0; i < N - 1; i++) s += a[i + 1]; return s`,
  'sum of every other cell': `let s = 0; for (let i = 0; i < N; i += 2) s += a[i]; return s`,
  'sum by while': `let s = 0, i = 0; while (i < N) { s += a[i]; i++ } return s`,
  'sum by do-while': `let s = 0, i = 0; do { s += a[i]; i++ } while (i < N); return s`,
  'sum by for-of': `let s = 0; for (const x of a) s += x; return s`,
  'sum by forEach': `let s = 0; a.forEach(x => { s += x }); return s`,
  'sum by reduce': `return a.reduce((s, x) => s + x, 0)`,
  'sum of squares': `let s = 0; ${UP} s += a[i] * a[i]; return s`,
  'sum of magnitudes': `let s = 0; ${UP} s += Math.abs(a[i]); return s`,
  'sum and sum of squares': `let s = 0, t = 0; ${UP} { s += a[i]; t += a[i] * a[i] } return s * 3 + t`,
  'sum where': `let s = 0; ${UP} if (a[i] > 1) s += a[i]; return s`,
  'count where': `let n = 0; ${UP} if (a[i] > 1) n++; return n`,
  'max': `let m = -Infinity; ${UP} m = Math.max(m, a[i]); return m`,
  'min': `let m = Infinity; ${UP} m = Math.min(m, a[i]); return m`,
  'max by a test': `let m = a[0]; for (let i = 1; i < N; i++) if (a[i] > m) m = a[i]; return m`,
  'max and min': `let lo = Infinity, hi = -Infinity; ${UP} { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i] } return hi * 1000 + lo`,
  'xor': `let x = 0; ${UP} x ^= a[i]; return x`,
}
const program = (kind, body) => `const N = ${N}\n${KINDS[kind]}\nexport let f = () => { ${body} }`

const SIMD = /v128\.|[if](8x16|16x8|32x4|64x2)\./g
const count = (wat) => (wat.match(SIMD) || []).length
const blanks = new Map()
// The module beside the kernel: the same program with an empty kernel, once a kind and level.
const blank = (kind, level) => {
  const key = `${kind}/${level}`
  if (!blanks.has(key)) blanks.set(key, count(compile(program(kind, 'return 0'), { optimize: level, wat: true })))
  return blanks.get(key)
}
// One form at one level: its marks in KINDS' order.
const measure = (form, level) => {
  let marks = ''
  for (const kind of Object.keys(KINDS)) {
    let wat = null
    try { wat = compile(program(kind, FORMS[form]), { optimize: level, wat: true }) } catch { }
    marks += wat == null ? '!' : count(wat) > blank(kind, level) ? 'V' : '.'
  }
  return marks
}
const cells = Object.keys(FORMS).length * Object.keys(KINDS).length

if (process.argv.includes('--update')) {
  if (onWasi()) throw new Error('reduce-coverage: the table is the JS host\'s; run --update without JZ_TEST_HOST=wasi')
  const known = {}
  for (const form of Object.keys(FORMS)) {
    known[form] = {}
    for (const level of LEVELS) known[form][level] = measure(form, level)
  }
  writeFileSync(KNOWN, '{\n' + Object.entries(known).map(([k, r]) => `  ${JSON.stringify(k)}: ${JSON.stringify(r)}`).join(',\n') + '\n}\n')
  for (const level of LEVELS) {
    const n = Object.values(known).reduce((s, r) => s + (r[level].match(/V/g) || []).length, 0)
    console.log(`reduce-coverage: ${n} of ${cells} in lanes at ${level === 2 ? 'level 2' : level}`)
  }
  console.log(`written to ${KNOWN}`)
} else {
  const known = JSON.parse(readFileSync(KNOWN, 'utf8')), kinds = Object.keys(KINDS)
  test('reduce coverage: the table lists every form at every level', () => {
    const missing = Object.keys(FORMS).flatMap(f => LEVELS.filter(l => typeof known[f]?.[l] !== 'string' || known[f][l].length !== kinds.length).map(l => `${f} at ${l}`))
    ok(!missing.length, missing.length ? `not listed: ${missing.join(', ')}` : 'listed')
  })
  for (const form of Object.keys(FORMS)) {
    test(`reduce coverage: ${form} answers as Node and lifts as listed`, () => {
      if (onWasi()) return
      for (const level of LEVELS) {
        const marks = measure(form, level), want = known[form][level]
        const lost = [...want].filter((c, i) => c === 'V' && marks[i] !== 'V').length, gained = [...marks].filter((c, i) => c === 'V' && want[i] !== 'V').length
        ok(marks === want, marks === want ? `marks as listed at ${level}` : `at ${level} marks ${marks}, listed ${want}: ${lost} lifts lost${gained ? `, ${gained} gained (node test/reduce-coverage.js --update)` : ''}`)
        kinds.forEach((kind, i) => {
          if (marks[i] === '!') return
          const src = program(kind, FORMS[form])
          is(jz(src, { optimize: level }).exports.f(), oracle(src).f(), `${kind} at ${level}`)
        })
      }
    })
  }
}
