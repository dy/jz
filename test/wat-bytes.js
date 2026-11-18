// The bytes compile() returns are watr's encoding of the WAT it prints for the same
// source and options: both are the one optimized module (src/compiler.js), encoded or
// printed. test/util.js jzWat stands on it, so a pin that reads the text and runs the
// module compiles once. Measured whole at 4b907722a: the 105 bench cases (the
// self-compile left out) and 200 programs of the test files, each at levels 0, 1, 2,
// 3, 'size' and 'speed': all byte for byte, but for a program compiled with
// `sourceMap`, whose bytes carry a custom section the text does not (jzWat refuses
// the option), and one every level refuses alike. Here a sample of the corpus at the
// leg's levels, and the literals and sections the text has to spell exactly.
import test from 'tst'
import { is, throws } from 'tst/assert.js'
import { join } from 'node:path'
import watrCompile from 'watr/compile'
import { compileJzAt } from '../bench/_lib/compile.js'
import { levels, ownedLevels } from './_matrix.js'
import { agree, compile, jzWat } from './util.js'

const LEVELS = [0, 1, 2, 3, 'size', 'speed']

// The id of the first section where two modules differ, or null when they are one.
const sectionApart = (a, b) => {
  if (a.length === b.length && a.every((x, i) => x === b[i])) return null
  let p = 8
  while (p < a.length && p < b.length) {
    const start = p, id = a[p++]
    let n = 0, s = 0, x
    do { x = a[p++]; n |= (x & 0x7f) << s; s += 7 } while (x & 0x80)
    p += n
    if (a[start] !== b[start] || a.subarray(start, p).some((x, i) => x !== b[start + i])) return id
  }
  return 'length'
}
const encodes = (bytes, text, label) => is(sectionApart(bytes, watrCompile(text)), null, label)

test('wat bytes: a bench case is the encoding of its text', () => {
  // vectors (dotprod), strings (strbuild), JSON and records (json), closures (callback),
  // maps (hashjoin): cases whose two compiles take under 3 CPU-s a level (threegeom's
  // take 98 over the six)
  for (const id of ['dotprod', 'strbuild', 'json', 'callback', 'hashjoin']) {
    const c = { id, js: join(import.meta.dirname, '../bench', id, `${id}.js`) }
    for (const level of levels(...LEVELS))
      encodes(compileJzAt(c, level, compile), compileJzAt(c, level, (src, opts) => compile(src, { ...opts, wat: true })), `${id} at ${level}`)
  }
})

test('wat bytes: the literals the text spells are the bytes', () => {
  const srcs = {
    floats: `export let f = (x) => [x * -0, 5e-324, 1e-310, 1.7976931348623157e308, 0.1 + x, NaN, -Infinity, Math.fround(1.1) + x]`,
    bigints: `export let g = (a) => a * -9223372036854775808n + 18446744073709551615n`,
    strings: `const s = '\\u0000\\n\\t"\\\\é😀\\u2028\\uFFFF'
      export let h = (i) => s.charCodeAt(i) + s.codePointAt(i) + s.length`,
    lanes: `const a = new Float64Array(64), b = new Int32Array(64)
      export let k = () => { for (let i = 0; i < 64; i++) { a[i] = a[i] * 1.5 + 0.25; b[i] = (b[i] ^ 0x7fffffff) - 3 } return a[3] + b[5] }`,
    init: `const T = []; for (let i = 0; i < 9; i++) T.push(i * i)
      export let t = (i) => T[i]`,
  }
  for (const [name, src] of Object.entries(srcs)) for (const optimize of ownedLevels(...LEVELS))
    encodes(compile(src, { optimize }), compile(src, { optimize, wat: true }), `${name} at ${optimize}`)
})

test('wat bytes: jzWat gives the text and instances of its bytes', () => {
  const src = `let n = 0; export let tick = () => ++n`
  const m = jzWat(src, { optimize: 2 })
  is(m.wat, compile(src, { optimize: 2, wat: true }), 'the text is wat()\'s')
  is([m.exports.tick(), m.exports.tick()], [1, 2], 'the first instance is kept')
  is(m.fresh().exports.tick(), 1, 'fresh() makes another, as a jz() would')
  is(m.exports.tick(), 3, 'and the kept one counts on')
  is(agree(m, 'tick'), 1, 'agree() asks a fresh instance of a build')
  for (const [name, opts] of [['imports', { imports: {} }], ['names', { names: true }], ['inspect', { inspect: true }],
    ['warnings', { warnings: () => {} }], ['snapshotInit', { optimize: { level: 2, snapshotInit: true } }]])
    throws(() => jzWat(src, opts), new RegExp(`'${name}' takes wat\\(\\) and jz\\(\\)`), `refuses ${name}`)
})
