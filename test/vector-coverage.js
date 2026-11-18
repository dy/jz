// Vector coverage gate: which of the alias battery's loops a lift takes, as a table that only grows.
//
// Each loop reads and writes arrays that may be one array: the 28 kernels `(d, s, n)` of
// test/_vector-alias.js over five element types, `d` and `s` two views of one buffer made three
// ways. At level 2 and at 'speed' a program's mark is V where its kernel adds a v128 instruction
// to the module (the same program with an empty kernel the measure), c where it adds a bulk copy
// or fill alone, . where neither. Whether each answers what Node answers is the population's to
// check (test/vector-alias-population.js, every level, the programs joined in one module, where
// each takes the lift it takes alone). test/vector-coverage.json lists each kernel's marks, one a
// program in TYPES × VIEWS order, by level. A kernel fails on any difference from its listing: a
// mark lost is a lift lost; a mark gained is a lift to list, `node test/vector-coverage.js
// --update`, after the review of its legality. The table is the JS host's: under wasi the tests
// return.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { onWasi } from './_matrix.js'
import { compile } from './util.js'
import { TYPES, KERN, VIEW, program } from './_vector-alias.js'

const KNOWN = join(import.meta.dirname, 'vector-coverage.json')
const LEVELS = [2, 'speed']

const SIMD = /v128\.|[if](8x16|16x8|32x4|64x2)\./g, BULK = /memory\.copy|memory\.fill/g
const count = (wat, re) => (wat.match(re) || []).length
const blanks = new Map()
// The module beside the kernel: the same program with an empty kernel, once a type, view and level.
const blank = (t, v, level) => {
  const key = `${t}/${v}/${level}`
  if (!blanks.has(key)) blanks.set(key, compile(program(TYPES[t][0], TYPES[t][1], 'return 0', VIEW[v]), { optimize: level, wat: true }))
  return blanks.get(key)
}

// One kernel at one level: its marks in TYPES × VIEWS order.
const measure = (k, level) => {
  let marks = ''
  for (const [t, [T, seed]] of Object.entries(TYPES)) for (const v of Object.keys(VIEW)) {
    const wat = compile(program(T, seed, KERN[k], VIEW[v]), { optimize: level, wat: true }), base = blank(t, v, level)
    marks += count(wat, SIMD) > count(base, SIMD) ? 'V' : count(wat, BULK) > count(base, BULK) ? 'c' : '.'
  }
  return marks
}

if (process.argv.includes('--update')) {
  if (onWasi()) throw new Error('vector-coverage: the table is the JS host\'s; run --update without JZ_TEST_HOST=wasi')
  const known = {}
  for (const k of Object.keys(KERN)) {
    known[k] = {}
    for (const level of LEVELS) known[k][level] = measure(k, level)
  }
  writeFileSync(KNOWN, '{\n' + Object.entries(known).map(([k, r]) => `  ${JSON.stringify(k)}: ${JSON.stringify(r)}`).join(',\n') + '\n}\n')
  const n = Object.values(known).reduce((s, r) => s + LEVELS.reduce((c, l) => c + count(r[l], /[Vc]/g), 0), 0)
  console.log(`vector-coverage: ${n} of ${Object.keys(KERN).length * LEVELS.length * 15} marks taken, written to ${KNOWN}`)
} else {
  const known = JSON.parse(readFileSync(KNOWN, 'utf8'))
  test('vector coverage: the table lists every kernel at every level', () => {
    const missing = Object.keys(KERN).flatMap(k => LEVELS.filter(l => typeof known[k]?.[l] !== 'string' || known[k][l].length !== 15).map(l => `${k} at ${l}`))
    ok(!missing.length, missing.length ? `not listed: ${missing.join(', ')}` : 'listed')
  })
  for (const k of Object.keys(KERN)) for (const level of LEVELS) {
    test(`vector coverage: ${k} at ${level === 2 ? 'level 2' : level} lifts as listed`, () => {
      if (onWasi()) return
      const marks = measure(k, level), want = known[k][level]
      const lost = [...want].filter((c, i) => c !== '.' && marks[i] !== c).length, gained = [...marks].filter((c, i) => c !== '.' && want[i] !== c).length
      ok(marks === want, marks === want ? 'marks as listed' : `marks ${marks}, listed ${want}: ${lost} lifts lost${gained ? `, ${gained} gained (node test/vector-coverage.js --update)` : ''}`)
    })
  }
}
